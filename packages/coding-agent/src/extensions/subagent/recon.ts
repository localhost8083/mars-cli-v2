/**
 * Explore-first auto-recon: on a fresh TUI session, a free-tier child maps the repo
 * in the background and the result is appended to the system prompt on the first
 * user turn. Children spawned with MARS_NO_RECON=1 (subagents, `?`, `/ghost`) and
 * non-TUI modes never start one, so a session tree recon once, at the top.
 */

import type { ExtensionContext } from "../../core/extensions/types.ts";
import { marsFreeModel } from "../marsai/index.ts";
import { type ReconChild, runReconChild } from "./recon-child.ts";

const RECON_TIMEOUT_MS = 45_000;
const RECON_TASK =
	"Map this repository in at most 15 lines: project type, build/test commands, entry points, " +
	"main directories, and anything unusual. Use read/ls/find/grep only. No prose, bullets only.";

interface ReconState {
	promise: Promise<string | undefined>;
	cwd: string;
	kill: () => void;
}

let state: ReconState | undefined;

/** Whether this session may start recon at all. */
export function reconAllowed(ctx: Pick<ExtensionContext, "mode">): boolean {
	return ctx.mode === "tui" && process.env.MARS_NO_RECON !== "1";
}

/** Launch recon once per cwd in the background; a new cwd stops the previous run. */
export function startRecon(cwd: string): void {
	if (state?.cwd === cwd) return;
	state?.kill();
	let child: ReconChild | undefined;
	const promise = (async (): Promise<string | undefined> => {
		try {
			const model = `marsai/${await marsFreeModel()}`;
			child = runReconChild(cwd, model, RECON_TASK, RECON_TIMEOUT_MS);
			return await child.promise;
		} catch {
			return undefined;
		}
	})();
	state = { promise, cwd, kill: () => child?.kill() };
}

/**
 * Await the recon (bounded). Returns the summary to append to the system prompt,
 * or undefined when unavailable or still running past the deadline.
 */
export async function awaitRecon(ctx: ExtensionContext, timeoutMs = RECON_TIMEOUT_MS): Promise<string | undefined> {
	if (!state || state.cwd !== ctx.cwd) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			state.promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs);
			}),
		]);
		return result;
	} finally {
		clearTimeout(timer);
	}
}
