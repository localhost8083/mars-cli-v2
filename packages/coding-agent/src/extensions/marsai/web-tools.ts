/**
 * Absolute web access for the agent: `web_fetch` reads a page as text,
 * `web_search` runs a query through DuckDuckGo's lite HTML endpoint (no API key).
 *
 * ponytail: DDG lite markup is screen-scraped — brittle by design.
 * Upgrade path: point `web_search` at a MarsAI gateway search endpoint (or a
 * keyed API like Brave) when one exists, and swap the regex HTML stripper in
 * `web_fetch` for a real readability parse if pages get messier.
 */

import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { fetchWithRetry } from "../../utils/management-http.ts";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_RESULTS = 8;
const MAX_REDIRECTS = 5;
const USER_AGENT = "marscli (+https://marsai.click)";

/**
 * Loopback, private-range and link-local targets are refused: the agent must not
 * reach intranet services or the cloud metadata endpoint through web_fetch.
 * ponytail: checked per redirect hop, but DNS rebinding (public name resolving
 * to a private address) is not — that needs a custom resolver.
 */
export function isBlockedFetchUrl(url: URL): string | undefined {
	if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol} (http/https only)`;
	const host = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return host;
	if (host === "metadata.google.internal") return host;
	const v4 = /^(0*(\d{1,3}))\.(0*(\d{1,3}))\.(0*(\d{1,3}))\.(0*(\d{1,3}))$/.exec(host);
	if (v4) {
		const octets = [v4[1], v4[3], v4[5], v4[7]].map(Number);
		if (octets.some((n) => n > 255)) return host;
		const [a, b] = octets;
		if (a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)) return host;
		if (a === 169 && b === 254) return host;
		if (a === 172 && b >= 16 && b <= 31) return host;
		if (a === 192 && b === 168) return host;
		return undefined;
	}
	// IPv6: loopback, unspecified, link-local (fe80::/10), unique local (fc00::/7),
	// and IPv4-mapped addresses keep their v4 verdict.
	if (host.includes(":")) {
		const lower = host.toLowerCase();
		const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
		if (mapped) return isBlockedFetchUrl(new URL(`http://${mapped[1]}/`)) ? lower : undefined;
		if (lower === "::" || lower === "::1") return lower;
		if (/^fe[89ab]/.test(lower) || /^f[cd]/.test(lower)) return lower;
	}
	return undefined;
}

const webFetchParams = Type.Object({
	url: Type.String({ description: "Full URL of the page to fetch, including https://" }),
});

const webSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	limit: Type.Optional(Type.Number({ description: `Max results (default ${DEFAULT_SEARCH_RESULTS})` })),
});

type WebFetchInput = Static<typeof webFetchParams>;
type WebSearchInput = Static<typeof webSearchParams>;

/** Drop scripts/styles and decode the entities a text-only model ever sees. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg|canvas|template|head)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|header|footer|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => decodeEntity(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => decodeEntity(Number.parseInt(dec, 10)))
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n\n")
		.trim();
}

/** One numeric entity; out-of-range or surrogate values keep the raw text instead of throwing. */
function decodeEntity(codePoint: number): string {
	if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
	if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "";
	return String.fromCodePoint(codePoint);
}

async function readBodyCapped(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		total += value.byteLength;
		chunks.push(total > MAX_BODY_BYTES ? value.subarray(0, value.byteLength - (total - MAX_BODY_BYTES)) : value);
		if (total >= MAX_BODY_BYTES) {
			await reader.cancel().catch(() => {});
			break;
		}
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

// DDG lite rows: <a class="result-link" href="…">title</a> then a sibling
// <td class="result-snippet"> for the snippet. Links may be protocol-relative.
function parseDuckDuckGo(html: string, limit: number): SearchHit[] {
	const hits: SearchHit[] = [];
	const linkRe = /<a\b[^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/g;
	const snippetRe = /<td\b[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/g;
	const links: Array<{ url: string; title: string; index: number }> = [];
	for (let m = linkRe.exec(html); m; m = linkRe.exec(html)) {
		const href = /href=["']([^"']+)["']/.exec(m[0]);
		if (!href) continue;
		let url = href[1].replace(/^\/\//, "https://").replace(/&amp;/g, "&");
		// DDG wraps real urls in a /l/?uddg= redirect.
		const uddg = /uddg=([^&]+)/.exec(url);
		if (uddg) url = decodeURIComponent(uddg[1]);
		links.push({ url, title: htmlToText(m[1]).replace(/\s+/g, " "), index: m.index });
	}
	const snippets: Array<{ text: string; index: number }> = [];
	for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
		snippets.push({ text: htmlToText(m[1]).replace(/\s+/g, " "), index: m.index });
	}
	for (const link of links) {
		if (hits.length >= limit) break;
		// Snippet follows its link in the markup; nearest one after wins.
		const snippet = snippets.find((s) => s.index > link.index)?.text ?? "";
		hits.push({ title: link.title, url: link.url, snippet });
	}
	return hits;
}

export function createWebFetchToolDefinition(): ToolDefinition<typeof webFetchParams, unknown, unknown> {
	return {
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its readable text content (HTML stripped). Use it to read pages the user links, documentation, or design references. Pair with web_search when no URL is given.",
		promptSnippet: "Fetch a URL and read its text content",
		promptGuidelines: [
			"Use web_fetch to read pages the user references instead of guessing their content",
			"Use web_search when you need current information or a URL is unknown",
		],
		parameters: webFetchParams,
		execute: async (_toolCallId, params: WebFetchInput, signal) => {
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				return { content: [{ type: "text", text: `Invalid URL: ${params.url}` }], details: { isError: true } };
			}
			try {
				let response: Response;
				// Redirects are followed manually so every hop gets the same private-network
				// check; fetch's automatic following would bypass it after the first hop.
				for (let hop = 0; ; hop++) {
					const blocked = isBlockedFetchUrl(url);
					if (blocked) {
						return {
							content: [{ type: "text", text: `Blocked ${url}: ${blocked} is not fetchable (private network)` }],
							details: { isError: true },
						};
					}
					const next = await fetchWithRetry(
						url,
						{
							headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,*/*" },
							redirect: "manual",
						},
						{ timeoutMs: FETCH_TIMEOUT_MS, maxRetries: 1, retryOnStatus: false },
					);
					const location = next.status >= 300 && next.status < 400 ? next.headers.get("location") : null;
					if (!location) {
						response = next;
						break;
					}
					try {
						await next.body?.cancel();
					} catch {
						// Discarding a redirect body is best-effort.
					}
					url = new URL(location, url);
					if (hop + 1 >= MAX_REDIRECTS) {
						return {
							content: [{ type: "text", text: `Too many redirects fetching ${params.url}` }],
							details: { isError: true },
						};
					}
				}
				const body = await readBodyCapped(response);
				const contentType = response.headers.get("content-type") ?? "";
				if (!response.ok) {
					return {
						content: [
							{
								type: "text",
								text: `HTTP ${response.status} fetching ${url}\n${htmlToText(body).slice(0, 2000)}`,
							},
						],
						details: { isError: true },
					};
				}
				const isHtml = contentType.includes("html");
				let text = isHtml ? htmlToText(body) : body.trim();
				const truncated = text.length > MAX_TEXT_CHARS;
				if (truncated) text = text.slice(0, MAX_TEXT_CHARS);
				return {
					content: [
						{
							type: "text",
							text: `${text}${truncated ? `\n\n[truncated at ${MAX_TEXT_CHARS} chars]` : ""}`,
						},
					],
					details: { url: url.toString(), status: response.status, truncated },
				};
			} catch (error: unknown) {
				if (signal?.aborted) throw error;
				return {
					content: [
						{
							type: "text",
							text: `Fetch failed for ${url}: ${error instanceof Error ? error.message : "Unknown error"}`,
						},
					],
					details: { isError: true },
				};
			}
		},
	};
}

export function createWebSearchToolDefinition(): ToolDefinition<typeof webSearchParams, unknown, unknown> {
	return {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via DuckDuckGo and return titles, URLs and snippets. No API key needed. Follow up with web_fetch on the best result to read the page.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: [],
		parameters: webSearchParams,
		execute: async (_toolCallId, params: WebSearchInput, signal) => {
			const limit = Math.max(1, Math.min(20, params.limit ?? DEFAULT_SEARCH_RESULTS));
			const endpoint = new URL("https://lite.duckduckgo.com/lite/");
			endpoint.searchParams.set("q", params.query);
			try {
				const response = await fetchWithRetry(
					endpoint,
					{ headers: { "user-agent": USER_AGENT, accept: "text/html" } },
					{ timeoutMs: SEARCH_TIMEOUT_MS, maxRetries: 1, retryOnStatus: false },
				);
				const html = await readBodyCapped(response);
				if (!response.ok) {
					return {
						content: [{ type: "text", text: `Search failed: HTTP ${response.status}` }],
						details: { isError: true },
					};
				}
				const hits = parseDuckDuckGo(html, limit);
				if (hits.length === 0) {
					return {
						content: [{ type: "text", text: `No results for "${params.query}".` }],
						details: { query: params.query, hits: 0 },
					};
				}
				const text = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n\n");
				return {
					content: [{ type: "text", text }],
					details: { query: params.query, hits: hits.length },
				};
			} catch (error: unknown) {
				if (signal?.aborted) throw error;
				return {
					content: [
						{
							type: "text",
							text: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
						},
					],
					details: { isError: true },
				};
			}
		},
	};
}
