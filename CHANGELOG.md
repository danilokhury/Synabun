# SynaBun Changelog

Raw internal changelogs are archived in [changelog/](changelog/).

## v.2026.04.01

### Added — Effort Level (Think) Selector in Automation Studio

- **Effort chip row in launch panel** — New Off / Low / Med / High / Max selector visible when Claude Code CLI is selected. Frosty glass chip design with tier-based accent colors (warm gold for Max, cool blue for Med). Selection persists via storage
- **Profile-aware visibility** — Effort section auto-hides when switching to Codex or Gemini profiles, re-appears on Claude Code. Applied in both main launch panel and quick timer
- **`--effort` flag plumbed through all launch paths** — Flows through loop launch, agent launch, quick timer, and scheduled loops. Stored in loop state JSON for traceability

### Fixed — MCP Registration Path Wrong on Windows Global Install

- **Onboarding wizard generated broken paths** — `getMcpSetup()` used `DATA_HOME` for the MCP entry file path. On Windows global npm installs, `DATA_HOME` resolves to `%APPDATA%/synabun` while `run.mjs` lives in `PACKAGE_ROOT` (`%APPDATA%/npm/node_modules/synabun`). The generated `~/.claude.json` pointed to a non-existent file, silently breaking MCP startup
- **All tool configs now include full env block** — Claude CLI, Cursor, Windsurf, and `.mcp.json` configs now include `DOTENV_PATH`, `SYNABUN_DATA_HOME`, and `MEMORY_DATA_DIR`
- **Startup warning for misconfigured global installs** — Server logs a warning when `SYNABUN_DATA_HOME` is unset and `PACKAGE_ROOT` contains `node_modules`

### Fixed — Edit Plan Shows Wrong Content

- **Stale fallback chain picked up post-plan messages** — `extractPlanText()` was called lazily when the user clicked "Edit plan", by which time remember results and stop hook outputs had been rendered in the DOM. The backward DOM walk picked these up instead of the actual plan
- **Eager plan capture** — Plan content is now captured immediately when ExitPlanMode is detected, before any post-plan messages exist. Removed unreliable disk scan fallback that found stale files from previous sessions
- **State cleanup on plan toggle** — All 3 plan mode entry points now clear cached plan data when toggled ON, preventing stale data inheritance

### Fixed — Browser Rendering Parity with Real Chrome

- **Viewport and DPR overrides removed** — Set Playwright `viewport: null` in headed mode so pages render at actual window size. Removed forced `deviceScaleFactor: 1` — Chrome now uses native DPR (2x on Retina). Fixes white-page rendering on complex SPAs like Twitter/X

### Fixed — Terminal Text Cropped at Bottom

- **FitAddon box-sizing mismatch** — The global `* { box-sizing: border-box }` reset caused xterm's FitAddon to overcalculate available rows by ~2 (40px padding mismatch). Fix: `box-sizing: content-box` on terminal viewport elements — no visual size change

### Fixed — Codex CLI Config Parse Error

- **TOML serialization wrote JSON syntax** — `tomlUpsertSection()` serialized the `env` field as `{"key":"value"}` (JSON) instead of `{key = "value"}` (TOML inline table). Codex CLI rejected with "missing assignment between key-value pairs". Added proper `tomlSerializeValue()` helper

### Fixed — Greeting Re-fires on Every Message

- **Greeting directive persisted in session context** — The SessionStart hook injected the greeting into `additionalContext` which persists for the entire session. Claude saw "begin with this greeting" on every turn. Moved greeting injection to the prompt-submit hook (message 1 only) so it never persists

### Fixed — Windows Cross-Platform Hook Compatibility

- **Hooks embedded machine-specific absolute paths** — When installed into SynaBun's own settings, hook commands contained macOS-style paths that failed on Windows PowerShell. Fix: generate relative paths when target matches `PACKAGE_ROOT`. Cleanup now matches both relative and absolute-path variants

### Fixed — Pre-WebSearch Hook Hangs on PowerShell

- **Missing stdin timeout** — On PowerShell, stdin `end` event may never fire, causing the hook to hang indefinitely. Added 2000ms timeout fallback

### Fixed — Hooks Crash with Unhandled Errors

- **All 7 hooks now handle uncaught exceptions** — Added `process.on('uncaughtException')` and `process.on('unhandledRejection')` to every hook. Each outputs valid JSON appropriate to its hook type and exits cleanly to prevent "hook error" messages

### Changed — Browser Stream Defaults to OFF

- **Screencast streaming disabled by default** — Stream only runs when explicitly toggled ON in Settings. All 7 check sites updated across server and UI modules

### Changed — Loop Browser: Shared System Chrome with Tabs

- **One-time Chrome restart per NI boot** — `ensureChromeDebuggable()` ensures Chrome runs with `--remote-debugging-port=9222`. Graceful AppleScript quit with polling, then `killall` fallback. Result cached — subsequent calls just probe the port
- **Shared session architecture** — Replaced per-loop Chrome restarts and 15-second UI polls with shared CDP sessions. Opens new tab per loop instead of creating isolated sessions. Loop stop closes only the loop's tab, preserving the shared session
- **MCP session fallback** — When `SYNABUN_BROWSER_SESSION` is pinned but stale, auto-selects or creates instead of failing

### Changed — Dependency Updates

- **mcp-server** — 44 packages updated: `@modelcontextprotocol/sdk` 1.27.1→1.29.0, `@inquirer/prompts` 8.3.0→8.3.2, `vitest` 4.1.0→4.1.2, `@types/node` 22.19.13→22.19.15
- **neural-interface** — 17 packages updated: `@anthropic-ai/claude-code` 2.1.71→2.1.89, `playwright` 1.58.2→1.59.0, `ws` 8.19.0→8.20.0. Fixed `lodash` prototype pollution vulnerability
