// `/init` command: build the AGENTS.md setup prompt with project stats injected.

import { readdir, readFile } from "fs/promises";
import path from "path";
import { collectPackFiles } from "../../cli/pack.ts";

const INIT_TEMPLATE = `Create or update \`AGENTS.md\` for this repository.

The goal is a compact instruction file that helps future ${"mars"} sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.

User-provided focus or constraints (honor these):
$ARGUMENTS

## Project stats (collected automatically, verify before writing)

$STATS

## How to investigate

Read the highest-value sources first:
- \`README*\`, root manifests, workspace config, lockfiles
- build, test, lint, formatter, typecheck, and codegen config
- CI workflows and pre-commit / task runner config
- existing instruction files (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`)

If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer reading the files that explain how the system is wired together over random leaf files.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable source and only keep what you can verify.

## What to extract

Look for the highest-signal facts for an agent working in this repo:
- exact developer commands, especially non-obvious ones
- how to run a single test, a single package, or a focused verification step
- required command order when it matters, such as \`lint -> typecheck -> test\`
- monorepo or multi-package boundaries, ownership of major directories, and the real app/library entrypoints
- framework or toolchain quirks: generated code, migrations, codegen, build artifacts, special env loading, dev servers, infra deploy flow
- testing quirks: fixtures, integration test prerequisites, snapshot workflows, required services, flaky or expensive suites
- important constraints from existing instruction files worth preserving

Good \`AGENTS.md\` content is usually hard-earned context that took reading multiple files to infer.

## Writing rules

Include only high-signal, repo-specific guidance such as:
- exact commands and shortcuts the agent would otherwise guess wrong
- architecture notes that are not obvious from filenames
- conventions that differ from language or framework defaults
- setup requirements, environment quirks, and operational gotchas

Exclude:
- generic software advice
- long tutorials or exhaustive file trees
- obvious language conventions
- speculative claims or anything you could not verify

When in doubt, omit. Prefer short sections and bullets. If the repo is simple, keep the file simple.

If \`AGENTS.md\` already exists at %PROJECT_DIR%/AGENTS.md, improve it in place rather than rewriting blindly. Preserve verified useful guidance, delete fluff or stale claims, and reconcile it with the current codebase. When done, write the file and give a one-paragraph summary of what you changed.`;

export interface ProjectStats {
	readonly lines: string[];
}

/** File extensions worth counting; the rest collapse into "other". */
const INTERESTING = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".rb",
	".php",
	".c",
	".h",
	".cpp",
	".cs",
	".md",
	".json",
	".yaml",
	".yml",
	".toml",
	".sql",
	".sh",
	".css",
	".html",
]);

const ROOT_MANIFESTS = [
	"package.json",
	"tsconfig.json",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"requirements.txt",
	"Gemfile",
	"composer.json",
	"pom.xml",
	"build.gradle",
];

async function firstLine(file: string, json: boolean): Promise<string | undefined> {
	try {
		const raw = await readFile(file, "utf-8");
		if (!json) return raw.split("\n", 1)[0]?.trim();
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).name === "string") {
			return (parsed as Record<string, string>).name;
		}
	} catch {
		// missing or unreadable: not a stat
	}
	return undefined;
}

async function packageScripts(cwd: string): Promise<string[]> {
	try {
		const raw = await readFile(path.join(cwd, "package.json"), "utf-8");
		const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
		const scripts = Object.keys(parsed.scripts ?? {});
		if (scripts.length === 0) return [];
		return [`- npm scripts: ${scripts.join(", ")}`];
	} catch {
		return [];
	}
}

async function workspaces(cwd: string): Promise<string[]> {
	try {
		const raw = await readFile(path.join(cwd, "package.json"), "utf-8");
		const parsed = JSON.parse(raw) as { workspaces?: unknown };
		const list = Array.isArray(parsed.workspaces) ? parsed.workspaces.join(", ") : undefined;
		if (list) return [`- npm workspaces: ${list}`];
	} catch {
		// no package.json
	}
	try {
		const entries = await readdir(path.join(cwd, "packages"), { withFileTypes: true });
		const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
		if (names.length > 0) return [`- packages/: ${names.join(", ")}`];
	} catch {
		// not a layout with packages/
	}
	return [];
}

/** Top-level directory listing, capped. */
async function topLevel(cwd: string): Promise<string> {
	try {
		const entries = await readdir(cwd, { withFileTypes: true });
		const names = entries
			.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
			.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
			.slice(0, 40);
		return names.join("  ");
	} catch {
		return "(unreadable)";
	}
}

/** Collect repo stats for the /init prompt. Falls back to a top-level scan when fd is unavailable. */
export async function collectProjectStats(cwd: string): Promise<ProjectStats> {
	const lines: string[] = [];
	const root = (await firstLine(path.join(cwd, "package.json"), true)) ?? path.basename(cwd);
	lines.push(`- project: ${root}`);
	const files = await collectPackFiles(cwd, "**/*").catch(() => []);
	if (files.length > 0) {
		const counts = new Map<string, number>();
		for (const file of files) {
			const ext = path.extname(file).toLowerCase();
			if (!INTERESTING.has(ext)) continue;
			counts.set(ext, (counts.get(ext) ?? 0) + 1);
		}
		const top = [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([ext, n]) => `${ext}=${n}`)
			.join(" ");
		lines.push(`- tracked files: ${files.length}; by ext: ${top}`);
	} else {
		lines.push(`- top level: ${await topLevel(cwd)}`);
	}
	const manifests: string[] = [];
	for (const name of ROOT_MANIFESTS) {
		if (
			!(await readFile(path.join(cwd, name), "utf-8").then(
				() => true,
				() => false,
			))
		)
			continue;
		manifests.push(name);
	}
	if (manifests.length > 0) lines.push(`- manifests: ${manifests.join(", ")}`);
	lines.push(...(await packageScripts(cwd)));
	lines.push(...(await workspaces(cwd)));
	for (const marker of ["AGENTS.md", "CLAUDE.md", ".cursorrules"]) {
		const exists = await readFile(path.join(cwd, marker), "utf-8").then(
			(content) => content.length > 0,
			() => false,
		);
		if (exists) lines.push(`- existing instructions: ${marker}`);
	}
	return { lines };
}

/** Build the /init user prompt: template with stats and focus args filled in. */
export function buildInitPrompt(stats: ProjectStats, args: string, projectDir: string): string {
	return INIT_TEMPLATE.replaceAll("%PROJECT_DIR%", projectDir.split(path.sep).join("/"))
		.replace("$STATS", stats.lines.join("\n"))
		.replace("$ARGUMENTS", args.trim() || "(none)");
}
