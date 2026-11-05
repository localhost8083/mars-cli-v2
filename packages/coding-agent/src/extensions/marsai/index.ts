/**
 * The MarsAI provider as an extension: the only provider MARS CLI registers.
 *
 * Device-flow OAuth (machine-bound), env/stored API key, a live model catalog
 * from `GET /v1/models`, and the `/mars` account command.
 */

import { readFileSync } from "node:fs";
import type { OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getAuthPath } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ProviderChatModelConfig,
	ProviderModelConfig,
} from "../../core/extensions/types.ts";
import { resolveConfigValue } from "../../core/resolve-config-value.ts";
import {
	type MarsAccountInfo,
	marsAccountInfo,
	marsApiKey,
	marsDeviceLogin,
	marsFetchModels,
	marsRefreshToken,
	marsServer,
} from "./oauth.ts";
import { createWebFetchToolDefinition, createWebSearchToolDefinition } from "./web-tools.ts";

const PROVIDER_ID = "marsai";
/** Static list shown before the first successful catalog fetch. The id must be a real
 * gateway id — the wire sends it verbatim and `marsai-auto` does not exist upstream. */
const FALLBACK_MODEL_ID = "marsai/auto-free";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_OUTPUT_TOKENS = 8192;

/** Map one gateway catalog row; the server bills, so all cost rates are zero. */
function marsModel(row: {
	id: string;
	label?: string;
	access?: string;
	context_tokens?: number;
}): ProviderChatModelConfig {
	// Prefer the gateway label; fall back to the id without the `marsai/` prefix.
	// "(free)" marks access unless the name already carries it.
	const name = row.label ?? row.id.replace(/^marsai\//, "");
	const markedFree = row.access === "free" && !/free$/i.test(name);
	return {
		id: row.id,
		name: markedFree ? `${name} (free)` : name,
		input: ["text", "image"],
		cost: ZERO_COST,
		// ponytail: reasoning stays false until the gateway reports capabilities;
		// upgrade path: map a capability field from `GET /v1/models` when it exists.
		reasoning: false,
		contextWindow: row.context_tokens ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: MAX_OUTPUT_TOKENS,
	};
}

const FALLBACK_MODEL: ProviderChatModelConfig = marsModel({ id: FALLBACK_MODEL_ID, label: "MarsAI Auto" });

/**
 * Fetch the live gateway catalog. Every empty result keeps the fallback: whatever is
 * returned is published as the provider's whole model list, so an empty list would
 * leave MARS with no model at all.
 */
async function refreshMarsModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	if (!context.allowNetwork || !context.credential) return [FALLBACK_MODEL];
	const token = context.credential.type === "oauth" ? marsApiKey(context.credential) : context.credential.key;
	if (!token) return [FALLBACK_MODEL];
	const rows = await marsFetchModels(`${marsServer()}/v1`, token, context.signal);
	return rows.length === 0 ? [FALLBACK_MODEL] : rows.map(marsModel);
}

/** Read the local `auth.json` entry for MarsAI; the file is a trusted-but-mutable local store. */
function readStoredCredential(): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(getAuthPath(), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const credential = (parsed as Record<string, unknown>)[PROVIDER_ID];
		return typeof credential === "object" && credential !== null
			? (credential as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

const FREE_MODEL_CACHE_MS = 5 * 60 * 1000;
let freeModelCache: { id: string; token: string; expires: number } | undefined;

/** The stored credential entry must carry a usable key or OAuth grant; anything else is treated as absent. */
function storedToken(stored: Record<string, unknown> | undefined): string | undefined {
	if (!stored || (stored.type !== "oauth" && stored.type !== "api_key" && stored.type !== "api-key")) return undefined;
	if (stored.type === "oauth") {
		const token = marsApiKey(stored as OAuthCredentials);
		return token || undefined;
	}
	if (typeof stored.apiKey !== "string" || stored.apiKey === "") return undefined;
	return resolveConfigValue(stored.apiKey);
}

/**
 * Best free-tier catalog id for cheap delegated work (subagents). `auto-free` is the
 * gateway's own router and wins when present; otherwise the least-loaded free row, then
 * the plain fallback. `MARSAI_SUBAGENT_MODEL` pins an explicit id. Cached briefly per
 * credential: this runs on every subagent dispatch and the catalog barely moves.
 */
export async function marsFreeModel(signal?: AbortSignal): Promise<string> {
	const override = process.env.MARSAI_SUBAGENT_MODEL;
	if (override) return override.includes("/") ? override : `marsai/${override}`;
	let token = "";
	try {
		const stored = readStoredCredential();
		token = storedToken(stored) ?? process.env.MARSAI_API_KEY ?? "";
	} catch {
		token = process.env.MARSAI_API_KEY ?? "";
	}
	if (freeModelCache && freeModelCache.token === token && Date.now() < freeModelCache.expires) {
		return freeModelCache.id;
	}
	let id = FALLBACK_MODEL_ID;
	try {
		if (token) {
			const rows = await marsFetchModels(`${marsServer()}/v1`, token, signal);
			const free = rows.filter((row) => row.access === "free");
			if (free.length > 0) {
				const auto = free.find((row) => row.id === FALLBACK_MODEL_ID);
				const leastLoaded = [...free].sort(
					(a, b) => (a.usage_ratio ?? Number.MAX_SAFE_INTEGER) - (b.usage_ratio ?? Number.MAX_SAFE_INTEGER),
				)[0];
				id = auto?.id ?? leastLoaded?.id ?? FALLBACK_MODEL_ID;
			}
		}
	} catch {
		// Any failure keeps the fallback; a subagent model must never block the dispatch.
	}
	freeModelCache = { id, token, expires: Date.now() + FREE_MODEL_CACHE_MS };
	return id;
}

function accountLines(stored: Record<string, unknown>, account: MarsAccountInfo | undefined): string[] {
	const lines: string[] = [];
	if (account) lines.push(`email: ${account.email}`);
	else if (typeof stored.email === "string") lines.push(`email: ${stored.email} (cached)`);
	else lines.push("email: unknown");
	lines.push(`method: ${stored.type === "oauth" ? "OAuth device" : "API key"}`);
	lines.push(`server: ${marsServer()}`);
	if (account) {
		lines.push(`balance: ${account.balance}`);
		lines.push(`free credits: ${account.free_credits}`);
		lines.push(`tokens used: ${account.tokens_used}`);
		lines.push(`rpm: ${account.rpm}`);
		if (account.expires_at > 0) lines.push(`grant expires: ${new Date(account.expires_at * 1000).toISOString()}`);
	} else if (stored.type === "oauth") {
		lines.push("account unreachable: expired token refreshes on the next request");
	}
	return lines;
}

export function createMarsaiExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerProvider(PROVIDER_ID, {
			name: "MarsAI",
			baseUrl: `${marsServer()}/v1`,
			apiKey: "$MARSAI_API_KEY",
			api: "openai-completions",
			models: [FALLBACK_MODEL],
			refreshModels: refreshMarsModels,
			oauth: {
				name: "MarsAI",
				login: marsDeviceLogin,
				refreshToken: marsRefreshToken,
				getApiKey: marsApiKey,
			},
		});

		pi.registerTool(createWebFetchToolDefinition());
		pi.registerTool(createWebSearchToolDefinition());

		pi.registerCommand("mars", {
			description: "Show MarsAI account and auth status",
			handler: async (_args, ctx) => {
				const stored = readStoredCredential();
				if (!stored) {
					const env = process.env.MARSAI_API_KEY;
					ctx.ui.notify(
						env
							? `Using MARSAI_API_KEY from environment (${env.slice(0, 10)}...)`
							: "Not signed in to MarsAI. Run /login marsai.",
						"info",
					);
					return;
				}
				const account = stored.type === "oauth" ? await marsAccountInfo(stored as OAuthCredentials) : undefined;
				await ctx.ui.select("MarsAI account", accountLines(stored, account));
			},
		});
	};
}

export default createMarsaiExtension();
