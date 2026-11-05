import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import marsaiExtension from "./marsai/index.ts";
import mcpExtension from "./mcp/index.ts";
import subagentExtension from "./subagent/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

// ponytail: llama.cpp extension source stays for direct imports/tests but no
// longer registers — MarsAI is the only provider. Delete when needed.
export const builtInExtensions: InlineExtension[] = [
	// MARS CLI's only provider: MarsAI OAuth/API-key auth plus the `/mars` account command.
	{ name: "marsai", factory: marsaiExtension, builtin: true },
	// Delegate tasks to isolated child `pi`/`mars` processes with their own context windows.
	{ name: "subagent", factory: subagentExtension, builtin: true, replaceable: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
