# MARS CLI Audit Report

- **Date:** 2026-11-05
- **Target:** `E:\xampp\htdocs\router\APPS\PiXmars` (fork of `earendil-works/pi`), focus on `packages/coding-agent`
- **Scope:** MarsAI-only rebrand changes — provider strip, free-tier delegation (`marsFreeModel`, subagents, explore agent), slim header, `?`/`/budget`/`/ghost`/`/handoff`/`/update`, `runFreeChild`, auto-recon, version check re-point, `web_fetch`/`web_search`, auto-login, rotating tips — plus regressions they touched.
- **Method:** read the changed code paths, traced child-spawn/session flows, grepped user-facing `pi` leftovers, ran `npm run check` (tsc + biome clean; only `check:browser-smoke` failed on a sandbox `EPERM` writing its temp log — environment, not code). No tests run, no files modified, nothing committed.

## Critical

### C1 — Auto-recon recurses into every child process, spawning a process chain
- **File:** `packages/coding-agent/src/extensions/subagent/index.ts:631`, `packages/coding-agent/src/extensions/subagent/recon.ts:22`
- **Why:** every child (`--mode json -p --no-session` from subagent, recon-child, `runFreeChild`) runs `bindExtensions()` (`packages/coding-agent/src/modes/print-mode.ts:83` → `packages/coding-agent/src/core/agent-session.ts:3401`), which emits `session_start`/`startup`. The handler calls `startRecon()` with no mode or env guard, so each child spawns a grandchild that spawns another. Each level also *waits* up to 45s for its own recon in `before_agent_start`, so children never finish before the parent's 45s race expires: every `mars -p`, subagent call, `?`, `/ghost`, and first interactive turn pays ~45s, burns a cascade of wasted free-tier LLM calls, holds dozens of concurrent node processes, and orphans the chain when the parent exits. The summary practically never arrives in time, making the feature self-defeating.
- **Fix:** gate `startRecon` on `ctx.mode === "tui"` (`ExtensionMode` exists in `packages/coding-agent/src/core/extensions/types.ts:343`) and/or a marker env var (e.g. `MARS_NO_RECON=1`) set by all three child spawners.

## High

### H1 — `web_fetch` has no SSRF protection; only the scheme is checked
- **File:** `packages/coding-agent/src/extensions/marsai/web-tools.ts:119`
- **Why:** the model can fetch `http://localhost:*`, `127.0.0.1`, `[::1]`, `169.254.169.254` (cloud metadata), and intranet hosts; `fetch` follows redirects, so even a public URL can redirect to loopback. No confirmation prompt either, unlike `bash`.
- **Fix:** block loopback/private/link-local hostnames and the metadata IP (including after redirects — validate each hop or disable following), and consider the standard tool-confirmation path.

### H2 — `/update` uses blocking `spawnSync` with a 120s timeout on the TUI thread
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6897`
- **Why:** the TUI freezes for the whole `mars update` run; if npm takes >120s on a slow network the timeout SIGKILLs it mid-install, corrupting the global install. Unbounded stdout+stderr is also dumped into chat.
- **Fix:** async spawn with a spinner, truncate output, and no timeout kill (or a much longer one with a warning).

### H3 — `getQuietStartup()` maps explicit `false` back to the `"header"` default
- **File:** `packages/coding-agent/src/core/settings-manager.ts:1011`
- **Why:** `value === true || value === "header" ? value : default` discards `false`, so verbose startup (`shouldShowStartupDetails`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1583`) is unreachable via settings; only `--verbose` works.
- **Fix:** return `value` when it is a boolean.

## Medium

### M1 — Four call sites prepend `marsai/` to `marsFreeModel()` output that already contains `marsai/`
- **File:** `packages/coding-agent/src/extensions/subagent/index.ts:669`, `packages/coding-agent/src/extensions/subagent/recon.ts:26`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5422,5474`
- **Why:** `marsFreeModel()` returns full gateway ids (`marsai/auto-free`). The double prefix (`marsai/marsai/...`) only resolves via an accident of `selectReference`'s provider-split fallback, shows doubled in subagent usage lines, and breaks `MARSAI_SUBAGENT_MODEL` overrides naming another provider. Load-bearing subtlety: the custom-id fallback in `packages/coding-agent/src/core/model-resolver.ts:526` accidentally yields the right wire id *because* of the doubling.
- **Fix:** normalize in one place — return verbatim and pass verbatim — and adjust the custom-id fallback so bare-vs-prefixed ids stay correct.

### M2 — `runFreeChild` appends the raw prompt to argv without a `--` separator
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5476`
- **Why:** `?--help` / `?-x` are parsed as CLI flags or errors by the child (`packages/coding-agent/src/cli/args.ts:249-267`), so the question is lost; `?@file` becomes a file attach. (`--` is supported, `args.ts:83`; subagent is safe only because of its `"Task: "` prefix.)
- **Fix:** insert `"--"` before `promptParts`.

### M3 — `spawn(APP_NAME)` with `shell: false` cannot execute Windows `.cmd` shims
- **File:** `packages/coding-agent/src/extensions/subagent/recon-child.ts:8`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5478`
- **Why:** whenever `process.argv[1]` is missing (binary builds), children fail to spawn on Windows; both helpers also lack subagent's non-generic-runtime branch. PATH-only resolution is hijackable from a malicious cwd.
- **Fix:** share one invocation helper (subagent's `getPiInvocation` is the most complete) across all three spawners; resolve the executable explicitly on Windows.

### M4 — Prompts travel as argv, hitting Windows's ~32k command-line limit
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5476`
- **Why:** `/ghost` on a long last prompt fails to spawn and silently prints `(no answer)`.
- **Fix:** pass the prompt via stdin or a temp file (subagent already uses temp files for system prompts).

### M5 — `/handoff` step 3 tells the teammate to `/import "<source-machine absolute path>"`
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6945`
- **Why:** that path does not exist on the other machine; the instruction is unusable as printed.
- **Fix:** print the basename and a `cd` + `/import <basename>` sequence.

### M6 — Provider strip lives in `packages/ai` (outside stated scope) and is internally inconsistent
- **File:** `packages/ai/src/providers/all.ts:97`
- **Why:** `builtinProviders()` returns `[]` but `getBuiltinProviders()`/`getBuiltinModels()` still return the full catalog, so behavior depends on which getter a caller uses; `packages/coding-agent/src/core/model-runtime.ts:229-241` radius/openrouter branches are now dead; every other `pi-ai` consumer and its tests are affected.
- **Fix:** reconcile the getters (or scope the strip to the coding agent) and remove/update the dead branches.

### M7 — Auto-login ignores `PI_OFFLINE`
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1274`
- **Why:** a fresh offline install immediately attempts device-flow network calls and shows a login failure instead of starting.
- **Fix:** skip `autoLoginMars` when `PI_OFFLINE` is set.

### M8 — Dynamic `await import("./recon-child.ts")` violates the top-level-imports rule
- **File:** `packages/coding-agent/src/extensions/subagent/recon.ts:27`
- **Why:** may not resolve from `dist/bundle/cli.js`; if the bundler externalizes it, recon silently never runs in production (the `try/catch` swallows it). No cycle justifies laziness.
- **Fix:** static top-level import.

### M9 — Source identity diverges from release identity, with no rewrite script
- **File:** `packages/coding-agent/package.json:2-10`, `packages/coding-agent/src/package-manager-cli.ts:707`
- **Why:** source is `@earendil-works/pi-coding-agent@1.5.0` vs release `@mars_ai/marscli` + `piConfig.version`. If published as-is, `packageName !== PACKAGE_NAME` makes `shouldRun` always true, so `mars update` reinstalls even when current; `build:binary` also still emits `dist/pi`.
- **Fix:** rename in source (or document the release rewrite) and align the binary name.

### M10 — First-time setup never runs for the fork (official-distribution gate)
- **File:** `packages/coding-agent/src/cli/startup-ui.ts:131`
- **Why:** dead user path plus a stale user-facing "bugs within Pi" string (`packages/coding-agent/src/modes/interactive/components/first-time-setup.ts:84`); theme/analytics stay default silently and the MARS setup banner is unreachable.
- **Fix:** decide the fork's first-run behavior explicitly; fix the string regardless.

### M11 — Install telemetry pings `pi.dev` and `/share` renders on `pi.dev/session/`
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1508`, `packages/coding-agent/src/config.ts:619`
- **Why:** Mars usage/version data and shared session content go to upstream endpoints.
- **Fix:** point at Mars endpoints or disable for the fork.

## Low

### L1 — `/ghost` is `void`-fired with no `try/catch`, guard, or output cap
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3376,5442`
- **Why:** latent unhandled rejection (unlike `handleInlineAsk`); concurrent ghosts spawn concurrent children; unbounded answers flood chat (same for `?`).
- **Fix:** `try/catch`, concurrency guard, truncate.

### L2 — `startRecon` on a new cwd orphans the previous child
- **File:** `packages/coding-agent/src/extensions/subagent/recon.ts:22`
- **Why:** no kill of the previous run; `awaitRecon`'s race timer is never cleared on success.
- **Fix:** track/kill the previous run; clear the timer.

### L3 — Timeout paths lack SIGKILL escalation and double-settle
- **File:** `packages/coding-agent/src/extensions/subagent/recon-child.ts:38`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5490`
- **Why:** hung children linger (subagent has 5s SIGKILL escalation; these do not); resolve-on-timeout then resolve-on-close. Also `marsInvocation(args)` is computed twice (`recon-child.ts:27`).
- **Fix:** mirror subagent's finish-once + escalation; compute the invocation once.

### L4 — `/handoff` silently overwrites; bad quote silently falls back to default path
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6957`, `packages/coding-agent/src/core/session-export.ts:43`
- **Why:** existing files clobbered without confirm; an unterminated quote writes somewhere the user did not ask.
- **Fix:** confirm overwrite; error on unterminated quotes.

### L5 — `?` prefix has no escape hatch
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3495`
- **Why:** the user cannot send a `?`-led message to the main model.
- **Fix:** e.g. `??` escape.

### L6 — `/mars` prints key material; handoff is unredacted
- **File:** `packages/coding-agent/src/extensions/marsai/index.ts:135,177`
- **Why:** 10–12 chars of the gateway key land in shareable chat; handoff exports the full transcript (a warning is shown — residual risk only).
- **Fix:** mask fully or show fewer chars; consider an optional redact pass for handoff.

### L7 — Contract drift in user-facing strings
- **Files:** `packages/coding-agent/src/cli/args.ts:293`, `packages/coding-agent/src/package-manager-cli.ts:367-384`, `packages/coding-agent/src/core/settings-schema.ts:290`, `packages/coding-agent/src/core/slash-commands.ts:30`, `packages/coding-agent/src/config.ts:371`, `packages/coding-agent/src/rpc-entry.ts:8`, `packages/coding-agent/src/cli/setup.ts:7`, `packages/coding-agent/src/modes/print-mode.ts:5`
- **Why:** `update [source|self|pi]` / `Update pi`, `` `pi update` `` ("update Pi itself"), `/bug` → "Pi developers", bun-binary URL to upstream releases, `AI_AGENT="pi"`, `pi -p` doc comment.
- **Fix:** rebrand the strings.

### L8 — `llama` extension still registers a provider
- **File:** `packages/coding-agent/src/extensions/llama/index.ts:44`
- **Why:** "marsai is the only provider" is inaccurate; also visible in `/login`.
- **Fix:** decide whether llama stays; update the claim either way.

### L9 — `APP_TITLE` fallback is mojibake
- **File:** `packages/coding-agent/src/config.ts:605`
- **Why:** `"Ï€"` (bytes `C3 8F E2 82 AC`, was `π`); latent while `piConfig.name` is set.
- **Fix:** restore `π` or use `APP_NAME`.

### L10 — Dead code after the strip
- **File:** `packages/coding-agent/src/core/model-resolver.ts:20`, `packages/coding-agent/src/core/model-runtime.ts:229`
- **Why:** non-marsai `defaultModelPerProvider` entries, unreachable Anthropic-subscription warning, `remote-catalog-provider` pi.dev paths.
- **Fix:** prune or annotate as intentionally retained.

### L11 — `String.fromCodePoint` throws on entities above `0x10FFFF`
- **File:** `packages/coding-agent/src/extensions/marsai/web-tools.ts:47`
- **Why:** one malformed numeric entity fails the whole `web_fetch`.
- **Fix:** clamp or wrap.

### L12 — Unkeyed free-model cache; unvalidated credential casts
- **File:** `packages/coding-agent/src/extensions/marsai/index.ts:91,109`
- **Why:** `freeModelCache` is unkeyed by account/server and survives login/logout for 5 min; `stored as OAuthCredentials` skips shape validation, so a malformed `auth.json` entry degrades to silent 401 fallbacks.
- **Fix:** key/invalidate the cache on auth change; validate the stored shape.

### L13 — Windows cosmetics
- **File:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:510`
- **Why:** `█` logo may miss in legacy console fonts; a working tip hardcodes `.mars` while the config dir is configurable.
- **Fix:** fallback glyph check; use the configured dir name.

## Checked and OK

Tips interval is always disposed with its indicator (`packages/coding-agent/src/modes/interactive/components/status-indicator.ts:70`); `appendSystemPrompt +=` is safe (normalized to `""`); `--tools ""` correctly means no tools; all child spawns use `shell: false` (no shell injection); `openBrowser` avoids `cmd /c start`; recon OAuth polling/abort and machine-id handling look sound.

## Overall assessment

The rebrand is structurally coherent and type-clean, but auto-recon (C1) is a ship-blocker: it recursively nests into every `-p` child, guaranteeing ~45s delays, process/LLM-call spirals, and orphaned chains on exactly the paths it was meant to speed up (subagents, `?`, `/ghost`). Fix that first with a TUI-only guard, then close the SSRF hole in `web_fetch` (H1), make `/update` async (H2), and repair `getQuietStartup` (H3); the remaining items are mostly `marsai/`-prefix fragility, Windows spawn/arg limits, and incomplete pi→mars string/endpoint drift.
