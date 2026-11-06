// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

import { ownedSlice } from "./text.ts";

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);
	const message = status === undefined && body === undefined ? withCauseDetail(error) : error.message;

	return {
		status,
		body,
		message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

const MAX_CAUSE_DEPTH = 5;

/**
 * Connection-level failures carry no status or body, and SDKs replace the
 * reason with a generic message (`openai`: `"Connection error."`). The real
 * reason sits in the `cause` chain, often two levels deep (undici's
 * `"fetch failed"` wraps `connect ECONNREFUSED ...`). Append the deepest
 * cause so callers that surface only the message keep the reason.
 */
export function withCauseDetail(error: Error): string {
	let deepest: Error | undefined;
	let current: unknown = error.cause;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
		deepest = current;
		current = current.cause;
	}
	if (!deepest) return error.message;
	let detail = (deepest.message || deepest.name).trim();
	const code = (deepest as Error & { code?: unknown }).code;
	if ((typeof code === "string" || typeof code === "number") && !detail.includes(String(code))) {
		detail = detail ? `${detail} (${code})` : String(code);
	}
	if (!detail || error.message.includes(detail)) return error.message;
	return error.message ? `${error.message}: ${detail}` : detail;
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	const label = prefix !== undefined ? `${prefix} (${norm.status}): ` : `${norm.status}: `;
	const base = `${label}${readableErrorBody(norm.body)}`;
	return isTransientGatewayError(norm.status, norm.body) ? `${base} — ${GATEWAY_OVERLOADED_HINT}` : base;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${ownedSlice(text, 0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

// --- Shared gateway transient-failure classification ---
//
// The MarsAI gateway sits behind Cloudflare in front of an overloaded origin.
// Two failure shapes are transient (the gateway itself asks the client to
// retry): a Cloudflare error page, and the JSON `server_error` emitted when
// the gateway's own upstream retries are exhausted. Model-upstream 5xx JSON
// errors ("Upstream error: ...") are real model failures and must surface.

/** Hint appended to transient gateway errors that reach the user. */
export const GATEWAY_OVERLOADED_HINT = "the API gateway is overloaded right now; try again shortly";

/** HTTP statuses that may carry a transient gateway failure. */
const TRANSIENT_GATEWAY_STATUSES: readonly number[] = [502, 503, 504, 529];

/** Body-requested retry delays are capped; waiting out a 60s gateway window makes agent sessions feel dead. */
const MAX_GATEWAY_RETRY_AFTER_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether an error body matches a transient gateway failure shape: a
 * Cloudflare error page (`cloudflare_error` / `origin_bad_gateway` markers or
 * a Cloudflare HTML page), or the gateway's `server_error` JSON emitted when
 * its own upstream retries are exhausted ("Upstream connection failed...").
 */
export function isTransientGatewayErrorBody(body: string | undefined): boolean {
	if (!body) return false;
	const lower = body.toLowerCase();
	if (lower.includes("cloudflare_error") || lower.includes("origin_bad_gateway")) return true;
	if (lower.includes("<html") && lower.includes("cloudflare")) return true;
	const parsed = parseJsonObject(body);
	const err = parsed?.error;
	return (
		isRecord(err) &&
		err.type === "server_error" &&
		typeof err.message === "string" &&
		err.message.includes("Upstream connection failed")
	);
}

export function isTransientGatewayStatus(status: number): boolean {
	return TRANSIENT_GATEWAY_STATUSES.includes(status);
}

export function isTransientGatewayError(status: number | undefined, body: string | undefined): boolean {
	return status !== undefined && isTransientGatewayStatus(status) && isTransientGatewayErrorBody(body);
}

/**
 * `retry_after` seconds requested inside a gateway error body (top level or
 * under `error`), capped at 15 seconds. Header `retry-after` handling takes
 * precedence in the retry loop; bodies carry the field on gateway JSON shapes.
 */
export function gatewayRetryAfterMs(body: string | undefined): number | undefined {
	const parsed = parseJsonObject(body);
	if (!parsed) return undefined;
	const raw = parsed.retry_after ?? (isRecord(parsed.error) ? parsed.error.retry_after : undefined);
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
	return Math.min(raw * 1000, MAX_GATEWAY_RETRY_AFTER_MS);
}

/**
 * Render a raw error body for display: unwrap the provider JSON shape
 * (`{"error":{"message":"..."}}`) to its message and label Cloudflare HTML
 * pages, instead of dumping raw JSON or markup at the user.
 */
function readableErrorBody(body: string): string {
	const parsed = parseJsonObject(body);
	const err = parsed?.error;
	if (isRecord(err) && typeof err.message === "string" && err.message.trim()) {
		return truncateErrorText(err.message.trim(), MAX_PROVIDER_ERROR_BODY_CHARS);
	}
	const lower = body.toLowerCase();
	if (lower.includes("<html") && lower.includes("cloudflare")) {
		return "Cloudflare error page (origin unavailable)";
	}
	return body;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
