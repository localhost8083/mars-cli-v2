/**
 * How to spawn this CLI as a child process: prefer the script this process runs
 * (source checkouts and npm installs), then the runtime executable, and only
 * fall back to the bare app name on PATH for packaged binaries whose argv[1]
 * is a virtual path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { APP_NAME } from "../config.ts";

export function cliInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: APP_NAME, args };
}
