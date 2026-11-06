// Self-check for /init helpers: stats collection and prompt assembly.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { buildInitPrompt, collectProjectStats } from "../src/modes/interactive/init-agents.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeRepo(): string {
	tempDir = mkdtempSync(join(tmpdir(), "mars-init-"));
	mkdirSync(join(tempDir, "src"), { recursive: true });
	writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest" } }));
	writeFileSync(join(tempDir, "src", "a.ts"), "export {};\n");
	writeFileSync(join(tempDir, "AGENTS.md"), "old\n");
	return tempDir;
}

describe("init", () => {
	test("collects project stats", async () => {
		const stats = await collectProjectStats(makeRepo());
		const text = stats.lines.join("\n");
		expect(text).toContain("project: demo");
		expect(text).toContain("npm scripts: test");
		expect(text).toContain("existing instructions: AGENTS.md");
	});

	test("builds prompt with stats, focus, and path", async () => {
		const stats = { lines: ["- project: demo"] };
		// Separator-free dir keeps this assertion identical on POSIX and Windows.
		const prompt = buildInitPrompt(stats, "focus on tests", "repo-dir");
		expect(prompt).toContain("- project: demo");
		expect(prompt).toContain("focus on tests");
		expect(prompt).toContain("repo-dir/AGENTS.md");
		expect(prompt).not.toContain("$STATS");
		expect(prompt).not.toContain("$ARGUMENTS");
	});
});
