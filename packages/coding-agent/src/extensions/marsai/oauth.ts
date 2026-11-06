/** MarsAI OAuth: machine-bound device-code login, rotating refresh, and account/model queries. */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { openBrowser } from "../../utils/open-browser.ts";

const CLIENT_ID = "marscli";
const SCOPE = "mars:inference mars:models mars:account";
const MACHINE_ID_FILE = "machine-id";
const MACHINE_ID_PATTERN = /^m1_[a-f0-9]{32}$/;
const MIN_POLL_INTERVAL_MS = 1000;
const SLOW_DOWN_INCREMENT_MS = 5000;
/** Refresh just before the 15-minute access token expires, not when it is already dead. */
const ACCESS_MARGIN_MS = 60_000;
const CANCELLED = "Login cancelled";

/** MarsAI API origin: `MARSAI_URL` or the public site; a trailing `/v1` belongs to the API path. */
export function marsServer(): string {
	return (process.env.MARSAI_URL ?? "https://marsai.click").replace(/\/+$/, "").replace(/\/v1$/i, "");
}

interface MarsTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

interface MarsDeviceResponse {
	device_code: string;
	user_code: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

interface MarsFormError {
	error?: string;
	error_description?: string;
}

/** Credentials plus the freshly fetched bonus pool, so login can greet first-time bonus holders. */
interface MarsLoginResult {
	credentials: OAuthCredentials;
	cliBonusCredits: number;
}

/**
 * Stable per-install fingerprint sent with every OAuth request. The server stores only its
 * hash and uses it to keep one machine on one account, so a stolen refresh token dies on
 * another machine instead of taking the account with it.
 */
export function marsMachineId(): string {
	const file = join(getAgentDir(), MACHINE_ID_FILE);
	try {
		const stored = readFileSync(file, "utf8").trim();
		if (MACHINE_ID_PATTERN.test(stored)) return stored;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const id = `m1_${randomBytes(16).toString("hex")}`;
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(file, `${id}\n`, { encoding: "utf8", mode: 0o600 });
	return id;
}

const BONUS_NOTICE_FILE = "cli-bonus-notice-shown";

/**
 * Whether the first-login bonus notice should be shown: at most once per install, tracked by a
 * local marker file (the userinfo field is the same on every refresh, so it cannot say "first").
 */
function shouldShowBonusNotice(): boolean {
	if (existsSync(join(getAgentDir(), BONUS_NOTICE_FILE))) return false;
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(join(getAgentDir(), BONUS_NOTICE_FILE), "shown\n", { encoding: "utf8", mode: 0o600 });
	return true;
}

/** Compact credit count for display: `5.0M`, `12.5K`, or the raw number. */
export function formatCredits(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(CANCELLED));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error(CANCELLED));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** POST form-encoded to a MarsAI OAuth endpoint; the caller interprets non-2xx bodies (device polling). */
async function postForm(
	url: string,
	body: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
		signal,
	});
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text === "" ? {} : JSON.parse(text);
	} catch {
		throw new Error(`MarsAI returned a non-JSON response (HTTP ${response.status})`);
	}
	return { status: response.status, body: parsed };
}

/** Wire response shape check: the OAuth server is an untrusted input source. */
function readToken(body: unknown): MarsTokenResponse | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const value = body as Record<string, unknown>;
	if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string") return undefined;
	if (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in)) return undefined;
	return {
		access_token: value.access_token,
		refresh_token: value.refresh_token,
		expires_in: value.expires_in,
	};
}

function readError(body: unknown): string {
	if (typeof body !== "object" || body === null) return "unexpected response";
	const value = body as MarsFormError;
	return value.error_description ?? value.error ?? "unexpected response";
}

async function postFormOrThrow(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
	const result = await postForm(url, body, signal);
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`MarsAI request failed: ${readError(result.body)}`);
	}
	return result.body;
}

async function getJson(url: string, token: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
	const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text === "" ? {} : JSON.parse(text);
	} catch {
		throw new Error(`MarsAI returned a non-JSON response (HTTP ${response.status})`);
	}
	return { status: response.status, body: parsed };
}

/**
 * Mint the long-lived per-grant gateway key. The access token expires every 15 minutes, so
 * inference uses this key; it dies with the grant, which is what disconnecting a device means.
 * Best effort: a failed mint leaves `access` as the request credential.
 */
async function mintApiKey(server: string, accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetch(`${server}/oauth/apikey`, {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}` },
			signal,
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as { api_key?: unknown };
		return typeof body.api_key === "string" && body.api_key !== "" ? body.api_key : undefined;
	} catch {
		return undefined;
	}
}

/** Account summary behind the `mars:account` scope, used by `/mars`. */
export interface MarsAccountInfo {
	email: string;
	name: string;
	balance: number;
	token_balance: number;
	free_credits: number;
	/** First-login MarsCLI-only bonus pool: not API-spendable, the gateway spends it on CLI requests. */
	cli_bonus_credits: number;
	tokens_used: number;
	rpm: number;
	grant_id: string;
	expires_at: number;
}

async function fetchAccount(
	server: string,
	accessToken: string,
	signal?: AbortSignal,
): Promise<MarsAccountInfo | undefined> {
	try {
		const result = await getJson(`${server}/oauth/userinfo`, accessToken, signal);
		if (result.status < 200 || result.status >= 300) return undefined;
		const body = result.body as Partial<MarsAccountInfo>;
		if (typeof body.email !== "string") return undefined;
		return {
			email: body.email,
			name: typeof body.name === "string" ? body.name : "",
			balance: typeof body.balance === "number" ? body.balance : 0,
			token_balance: typeof body.token_balance === "number" ? body.token_balance : 0,
			free_credits: typeof body.free_credits === "number" ? body.free_credits : 0,
			cli_bonus_credits: typeof body.cli_bonus_credits === "number" ? body.cli_bonus_credits : 0,
			tokens_used: typeof body.tokens_used === "number" ? body.tokens_used : 0,
			rpm: typeof body.rpm === "number" ? body.rpm : 0,
			grant_id: typeof body.grant_id === "string" ? body.grant_id : "",
			expires_at: typeof body.expires_at === "number" ? body.expires_at : 0,
		};
	} catch {
		return undefined;
	}
}

/**
 * Account summary behind the `mars:account` scope, used by `/mars`. Takes the stored access
 * token as-is: refresh must be persisted by the auth runtime, because refresh tokens rotate
 * and an unpersisted rotation would look like a replay and revoke the grant.
 */
export async function marsAccountInfo(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<MarsAccountInfo | undefined> {
	const server = typeof credentials.server === "string" ? credentials.server : marsServer();
	return fetchAccount(server, credentials.access, signal);
}

async function marsCredentials(server: string, token: MarsTokenResponse): Promise<MarsLoginResult> {
	const [apiKey, account] = await Promise.all([
		mintApiKey(server, token.access_token),
		fetchAccount(server, token.access_token),
	]);
	return {
		credentials: {
			access: token.access_token,
			refresh: token.refresh_token,
			expires: Date.now() + token.expires_in * 1000 - ACCESS_MARGIN_MS,
			apiKey,
			server,
			email: account?.email,
		},
		cliBonusCredits: account?.cli_bonus_credits ?? 0,
	};
}

async function pollForToken(
	server: string,
	device: MarsDeviceResponse,
	signal?: AbortSignal,
): Promise<MarsTokenResponse> {
	const deadline = Date.now() + device.expires_in * 1000;
	let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.floor(device.interval * 1000));
	while (Date.now() < deadline) {
		await sleep(intervalMs, signal);
		const result = await postForm(
			`${server}/oauth/token`,
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: device.device_code,
				client_id: CLIENT_ID,
				machine: marsMachineId(),
			},
			signal,
		);
		const token = readToken(result.body);
		if (token) return token;
		const code = (result.body as MarsFormError | undefined)?.error;
		if (code === "authorization_pending") continue;
		// RFC 8628: slow_down raises the wait by five seconds; the server enforces its own count too.
		if (code === "slow_down") {
			intervalMs += SLOW_DOWN_INCREMENT_MS;
			continue;
		}
		throw new Error(`MarsAI device sign-in failed: ${readError(result.body)}`);
	}
	throw new Error("MarsAI device sign-in timed out");
}

/**
 * Device-code login: show the code, poll until approved, then store tokens plus the minted key.
 * The verification URI carries the user code, so the browser opens on its own as soon as the
 * code arrives; the dialog's confirm action is a no-op fallback for when the launch fails.
 */
export async function marsDeviceLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const server = marsServer();
	const created = (await postFormOrThrow(
		`${server}/oauth/device/code`,
		{ client_id: CLIENT_ID, scope: SCOPE, machine: marsMachineId() },
		callbacks.signal,
	)) as MarsDeviceResponse;
	try {
		openBrowser(created.verification_uri_complete);
	} catch {
		// Launcher failures must not interrupt login; the dialog still shows the URL.
	}
	callbacks.onDeviceCode({
		userCode: created.user_code,
		verificationUri: created.verification_uri_complete,
		intervalSeconds: created.interval,
		expiresInSeconds: created.expires_in,
		// The browser already opened; a confirm-to-open hint would be noise.
		openBrowserOnConfirm: false,
		copyCodeOnConfirm: false,
	});
	const token = await pollForToken(server, created, callbacks.signal);
	const { credentials, cliBonusCredits } = await marsCredentials(server, token);
	if (cliBonusCredits > 0 && shouldShowBonusNotice()) {
		// ponytail: "expires in 30 days" assumes the server's default expiry; render from a
		// userinfo field when the server exposes the actual bonus expiry.
		callbacks.onProgress?.(
			`Bonus: ${formatCredits(cliBonusCredits)} MarsCLI credits added — usable only inside MarsCLI, expires in 30 days.`,
		);
	}
	return credentials;
}

/** Exchange the rotating refresh token; a replay or a foreign machine fails here and forces a new login. */
export async function marsRefreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const server = typeof credentials.server === "string" ? credentials.server : marsServer();
	const body = await postFormOrThrow(
		`${server}/oauth/token`,
		{
			grant_type: "refresh_token",
			refresh_token: String(credentials.refresh),
			client_id: CLIENT_ID,
			machine: marsMachineId(),
		},
		signal,
	);
	const token = readToken(body);
	if (!token) throw new Error("MarsAI token refresh returned an unexpected response");
	const minted =
		typeof credentials.apiKey === "string" && credentials.apiKey !== ""
			? credentials.apiKey
			: await mintApiKey(server, token.access_token, signal);
	return {
		...credentials,
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000 - ACCESS_MARGIN_MS,
		apiKey: minted,
		server,
	};
}

/** Request credential: the minted gateway key when present, else the short-lived access token. */
export function marsApiKey(credentials: OAuthCredentials): string {
	return typeof credentials.apiKey === "string" && credentials.apiKey !== "" ? credentials.apiKey : credentials.access;
}

/** One row of `GET /v1/models`: the gateway's published combos, not a vendor catalog. */
export interface MarsModelRow {
	id: string;
	label?: string;
	access?: string;
	usage_ratio?: number;
	context_tokens?: number;
}

/** Fetch the published model list with the gateway credential; empty means "keep what you have". */
export async function marsFetchModels(baseUrl: string, token: string, signal?: AbortSignal): Promise<MarsModelRow[]> {
	const result = await getJson(`${baseUrl.replace(/\/+$/, "")}/models`, token, signal);
	if (result.status < 200 || result.status >= 300) return [];
	if (typeof result.body !== "object" || result.body === null) return [];
	const data = (result.body as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	return data.flatMap((row) => {
		if (typeof row !== "object" || row === null) return [];
		const value = row as Record<string, unknown>;
		if (typeof value.id !== "string" || value.id === "") return [];
		return [
			{
				id: value.id,
				label: typeof value.label === "string" ? value.label : undefined,
				access: typeof value.access === "string" ? value.access : undefined,
				usage_ratio: typeof value.usage_ratio === "number" ? value.usage_ratio : undefined,
				context_tokens: typeof value.context_tokens === "number" ? value.context_tokens : undefined,
			},
		];
	});
}
