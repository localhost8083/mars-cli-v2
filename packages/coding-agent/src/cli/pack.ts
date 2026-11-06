// `mars pack`: export repo files as XML for handoff to another model.
// Reuses the find tool (fd + .gitignore) for file discovery.

import chalk from "chalk";
import { readFile } from "fs/promises";
import path from "path";
import { APP_NAME } from "../config.ts";
import type { ExtensionToolContext } from "../core/extensions/types.ts";
import { createFindToolDefinition } from "../core/tools/find.ts";

export const PACK_DEFAULT_MAX_BYTES = 200 * 1024;
export const PACK_FILE_LIMIT = 500;

const REDACTED = "[REDACTED]";
const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
	/((?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|passwd|password)\s*[:=]\s*['"]?)[^'"`\s;,}]+/gi,
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, `$1${REDACTED}`);
	return out;
}

export function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface PackOptions {
	maxBytes: number;
}

export interface PackResult {
	xml: string;
	included: number;
	skippedBinary: number;
	truncated: boolean;
	bytes: number;
}

/** Read files, redact secrets, emit XML. Stops adding files once maxBytes is hit. */
export async function buildPack(cwd: string, files: string[], options: PackOptions): Promise<PackResult> {
	const parts: string[] = [];
	let bytes = 0;
	let included = 0;
	let skippedBinary = 0;
	let truncated = false;
	for (const relativePath of files) {
		let raw: Buffer;
		try {
			raw = await readFile(path.join(cwd, relativePath));
		} catch {
			continue;
		}
		if (raw.subarray(0, 8192).includes(0)) {
			skippedBinary++;
			continue;
		}
		const body = redactSecrets(raw.toString("utf-8"));
		const entry = `<file path="${escapeXml(relativePath)}">${escapeXml(body)}</file>`;
		if (bytes + Buffer.byteLength(entry, "utf-8") > options.maxBytes && included > 0) {
			truncated = true;
			break;
		}
		parts.push(entry);
		bytes += Buffer.byteLength(entry, "utf-8");
		included++;
	}
	return {
		xml: `<pack root="${escapeXml(path.basename(cwd))}">\n${parts.join("\n")}\n</pack>`,
		included,
		skippedBinary,
		truncated,
		bytes,
	};
}

/** List files via the find tool, so .gitignore handling matches the agent. */
export async function collectPackFiles(cwd: string, query: string): Promise<string[]> {
	const definition = createFindToolDefinition(cwd);
	// ponytail: pack runs outside a session, so only cwd is real; full ctx when pack becomes a tool.
	const ctx = { cwd } as ExtensionToolContext;
	const result = await definition.execute(
		"pack",
		{ pattern: query, limit: PACK_FILE_LIMIT },
		undefined,
		undefined,
		ctx,
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	if (text.startsWith("No files found")) return [];
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("["));
}

export function printPackHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} pack`)} - Export repo files as XML for handoff to another model

${chalk.bold("Usage:")}
  ${APP_NAME} pack [--query <glob>] [--max-bytes <n>] [--full]

${chalk.bold("Options:")}
  --query <glob>      Glob pattern for files to include (default: **/*)
  --max-bytes <n>     Cap on output bytes (default: ${PACK_DEFAULT_MAX_BYTES})
  --full              Ignore the size cap
  --help, -h          Show this help

Respects .gitignore, skips binaries, redacts secrets. XML goes to stdout;
pipe it: ${APP_NAME} pack --query "src/**" > ctx.xml`);
}

export async function handlePackCommand(args: string[]): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "pack") return false;
	let query = "**/*";
	let maxBytes = PACK_DEFAULT_MAX_BYTES;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--help" || arg === "-h") {
			printPackHelp();
			return true;
		} else if (arg === "--query" && i + 1 < rest.length) {
			query = rest[++i];
		} else if (arg === "--max-bytes" && i + 1 < rest.length) {
			maxBytes = Number(rest[++i]);
			if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
				console.error(chalk.red("Error: --max-bytes requires a positive number"));
				process.exitCode = 1;
				return true;
			}
		} else if (arg === "--full") {
			maxBytes = Number.MAX_SAFE_INTEGER;
		} else {
			console.error(chalk.red(`Unknown option ${arg} for "pack".`));
			console.error(chalk.dim(`Use "${APP_NAME} pack --help".`));
			process.exitCode = 1;
			return true;
		}
	}
	try {
		const cwd = process.cwd();
		const files = await collectPackFiles(cwd, query);
		const pack = await buildPack(cwd, files, { maxBytes });
		process.stdout.write(`${pack.xml}\n`);
		console.error(
			chalk.dim(
				`pack: ${pack.included} files, ${pack.bytes} bytes${pack.skippedBinary > 0 ? `, ${pack.skippedBinary} binaries skipped` : ""}${pack.truncated ? " (truncated, use --full or --max-bytes)" : ""}`,
			),
		);
	} catch (error: unknown) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : "pack failed"}`));
		process.exitCode = 1;
	}
	return true;
}
