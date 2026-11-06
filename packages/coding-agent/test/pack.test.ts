// Self-check for `mars pack` helpers: secrets redact, size cap, XML escape.
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { buildPack, escapeXml, redactSecrets } from "../src/cli/pack.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writeTemp(files: Record<string, string>): string {
	tempDir = mkdtempSync(join(tmpdir(), "mars-pack-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(tempDir, name), content);
	return tempDir;
}

describe("pack", () => {
	test("redacts secrets", () => {
		expect(redactSecrets('api_key="sk-live-123"')).toBe('api_key="[REDACTED]"');
		expect(redactSecrets("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toContain("[REDACTED]");
	});

	test("escapes xml", () => {
		expect(escapeXml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
	});

	test("caps output at maxBytes", async () => {
		const dir = writeTemp({ "a.txt": "hello", "b.txt": "world" });
		// ponytail: 50 bytes forces truncation of second file; real default 200KB.
		const pack = await buildPack(dir, ["a.txt", "b.txt"], { maxBytes: 50 });
		expect(pack.included).toBe(1);
		expect(pack.truncated).toBe(true);
	});
});
