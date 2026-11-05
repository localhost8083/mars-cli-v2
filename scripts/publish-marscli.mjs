/**
 * Publish MARS CLI to npm as @mars_ai/marscli.
 *
 * The source package keeps its internal name (@earendil-works/pi-coding-agent)
 * because workspace tooling (evals, install-lock, scripts) depends on it. The
 * release is built here: a staging directory with a rewritten package.json
 * (release name, piConfig.version, bin) plus the built dist/, docs and schemas.
 *
 * Usage: node scripts/publish-marscli.mjs [--dry]
 * Requires `npm run build` in packages/coding-agent first, and npm auth for the
 * @mars_ai scope (token in ~/.npmrc or NPM_TOKEN).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const dry = process.argv.includes("--dry");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(repoRoot, "packages", "coding-agent");
const RELEASE_NAME = "@mars_ai/marscli";
const REGISTRY = "https://registry.npmjs.org/";

const source = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
const version = source.piConfig?.version;
if (!version) throw new Error("piConfig.version missing in packages/coding-agent/package.json");

// The bundle keeps esbuild externals (photon-node wasm, jiti, optional native
// accelerators) and feature packages that load assets from their own package
// dir, so every non-workspace runtime dependency ships with the release.
const dependencies = Object.fromEntries(
	Object.entries(source.dependencies ?? {}).filter(([name]) => !name.startsWith("@earendil-works/")),
);

const release = {
	name: RELEASE_NAME,
	version,
	description: source.description,
	// piConfig drives APP_NAME ("mars"), CONFIG_DIR_NAME (".mars") and VERSION at
	// runtime; without it the published binary reverts to "pi"/".pi" defaults.
	piConfig: source.piConfig,
	type: "module",
	bin: { mars: "dist/bundle/cli.js" },
	files: ["dist", "docs", "schemas", "README.md", "CHANGELOG.md"],
	dependencies,
	engines: source.engines,
};

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "marscli-publish-"));
fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(release, null, "\t")}\n`);
for (const entry of ["dist", "docs", "schemas", "README.md", "CHANGELOG.md"]) {
	const from = path.join(packageDir, entry);
	if (!fs.existsSync(from)) throw new Error(`Missing release input: ${entry}`);
	fs.cpSync(from, path.join(staging, entry), { recursive: true });
}

const distCli = path.join(staging, "dist", "bundle", "cli.js");
const versionCheck = spawnSync(process.execPath, [distCli, "--version"], { encoding: "utf8" });
if (versionCheck.stdout.trim() !== version) {
	throw new Error(`Staged bundle reports "${versionCheck.stdout.trim()}", expected ${version}`);
}
if (source.piConfig?.name && !release.piConfig) {
	throw new Error("piConfig lost during rewrite: the release binary would fall back to pi/.pi defaults");
}

if (dry) {
	console.log(`dry: staged ${RELEASE_NAME}@${version} at ${staging}`);
	process.exit(0);
}

// npm resolves to a .cmd shim on Windows; naming it explicitly avoids spawning
// through a shell (DEP0190).
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const publish = spawnSync(npmCommand, ["publish", "--registry", REGISTRY, "--access", "public"], {
	cwd: staging,
	encoding: "utf8",
	stdio: "inherit",
});
if (publish.status !== 0) {
	console.error(`Publish failed; staging kept at ${staging}`);
	process.exit(publish.status ?? 1);
}
fs.rmSync(staging, { recursive: true, force: true });
console.log(`Published ${RELEASE_NAME}@${version}`);
