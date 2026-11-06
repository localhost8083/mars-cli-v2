import {
	gatewayRetryAfterMs,
	isTransientGatewayErrorBody,
	isTransientGatewayStatus,
	normalizeProviderError,
} from "./error-body.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
	/** HTTP statuses that fail at once although the default policy would retry them. */
	noRetryStatuses?: readonly number[];
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** Body text a provider SDK attached to an error, when it kept one. */
function providerErrorBodyText(error: ProviderError): string | undefined {
	const norm = normalizeProviderError(error);
	return norm.body ?? (norm.messageCarriesBody ? norm.message : undefined);
}

/**
 * Retry policy. Transport failures (no response received) and 408/409 are
 * transient and always retried. 5xx responses retry only when the body
 * matches a transient gateway failure shape (Cloudflare error page or the
 * gateway's exhausted-upstream `server_error`); model-upstream 5xx errors and
 * bare 4xx (401/402/403/429) are real failures that surface unchanged — the
 * agent-level retry classifier owns those. An explicit `x-should-retry`
 * header always wins.
 */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	if (error.status === 408 || error.status === 409) return true;
	if (!isTransientGatewayStatus(error.status)) return false;
	return isTransientGatewayErrorBody(providerErrorBodyText(error));
}

function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	// Gateway error bodies carry retry_after seconds; capped so a full server
	// window (60s) never stalls an interactive session.
	const bodyDelayMs = gatewayRetryAfterMs(providerErrorBodyText(error));
	if (bodyDelayMs !== undefined) return bodyDelayMs;

	// 1s → 3s → 8s with ±20% jitter.
	const backoffMs = Math.min(3 ** retryIndex, 8) * 1000;
	return backoffMs * (0.8 + Math.random() * 0.4);
}

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Retry a provider request with interruptible backoff. Callers must invoke the
 * SDK with `maxRetries: 0` and wrap the request with this helper. Only
 * transport failures, 408/409, and transient gateway 5xx shapes retry (see
 * `isRetryableProviderError`); provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero
 * to disable the limit.
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;
			if (error.status !== undefined && options.noRetryStatuses?.includes(error.status)) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
		}
	}
}
