/** Spawn a `mars -p` recon child on a free-tier model and return its final text. */

import { spawn } from "node:child_process";
import type { JsonAgentSessionEvent } from "../../modes/json-event.ts";
import { cliInvocation } from "../../utils/cli-invocation.ts";

/** A running recon child: its result and a way to stop it when superseded. */
export interface ReconChild {
	promise: Promise<string | undefined>;
	kill: () => void;
}

/** Run the recon prompt; undefined when the child fails, is killed, or misses the deadline. */
export function runReconChild(cwd: string, model: string, task: string, timeoutMs: number): ReconChild {
	let resolveResult!: (text: string | undefined) => void;
	const promise = new Promise<string | undefined>((resolve) => {
		resolveResult = resolve;
	});
	// MARS_NO_RECON keeps grandchildren (bindings inside the child) from
	// starting their own recon: one recon per session tree, the top one.
	const args = ["--mode", "json", "-p", "--no-session", "--model", model, "--tools", "read,ls,find,grep", task];
	const invocation = cliInvocation(args);
	let proc: ReturnType<typeof spawn>;
	try {
		proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, MARS_NO_RECON: "1" },
		});
	} catch {
		resolveResult(undefined);
		return { promise, kill: () => {} };
	}
	const kill = () => {
		if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
	};
	let buffer = "";
	let lastText = "";
	let settled = false;
	let timedOut = false;
	const finish = (text: string | undefined) => {
		if (settled) return;
		settled = true;
		resolveResult(text?.trim() || undefined);
	};
	const killTimer = setTimeout(() => {
		timedOut = true;
		kill();
	}, timeoutMs);
	// SIGTERM can be ignored by a wedged child; escalate once after a grace period.
	const killEscalation = setTimeout(() => proc.kill("SIGKILL"), timeoutMs + 5_000);
	proc.stdout?.on("data", (data) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as JsonAgentSessionEvent;
				if (event.type === "message_end" && event.message.role === "assistant") {
					for (const part of event.message.content) {
						if (part.type === "text") lastText = part.text;
					}
				}
			} catch {
				// Skip non-JSON lines; stderr is ignored entirely.
			}
		}
	});
	proc.on("close", (code) => {
		clearTimeout(killTimer);
		clearTimeout(killEscalation);
		finish(timedOut || code !== 0 ? undefined : lastText);
	});
	proc.on("error", () => {
		clearTimeout(killTimer);
		clearTimeout(killEscalation);
		finish(undefined);
	});
	return { promise, kill };
}
