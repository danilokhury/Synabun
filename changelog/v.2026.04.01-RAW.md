# Changelog

## 2026-04-01

### Fixed — MCP Registration Path Wrong on Windows Global Install (Onboarding Wizard)
- **`getMcpSetup()` in `onboarding.html` used `DATA_HOME` for the MCP entry file path** — On Windows global npm installs, `DATA_HOME` resolves to `%APPDATA%/synabun` (user data dir) while the actual `run.mjs` lives in `PACKAGE_ROOT` (`%APPDATA%/npm/node_modules/synabun`). The generated `~/.claude.json` pointed to a non-existent file, silently breaking MCP startup
  - `GET /api/setup/onboarding` now returns `packageRoot: PACKAGE_ROOT` alongside `projectDir: DATA_HOME`
  - `getMcpSetup()` rewritten: uses `packageRoot` for MCP entry path (`run.mjs`), `projectRoot` (data home) for env/data paths
  - All tool configs (Claude CLI, Cursor, Windsurf, `.mcp.json`) now include full env block: `DOTENV_PATH`, `SYNABUN_DATA_HOME`, `MEMORY_DATA_DIR` — previously only had `DOTENV_PATH`
  - Added startup warning in `server.js` when `SYNABUN_DATA_HOME` is unset and `PACKAGE_ROOT` contains `node_modules` — catches misconfigured global installs early

### Added — Effort Level (Think) Selector in Automation Studio
- **`EFFORT_LEVELS` constant and `_launchEffort` persistent state** — New effort chip row (Off / Low / Med / High / Max) in the launch panel and quick timer, visible only when Claude Code CLI is selected. Chips follow the same frosty glass design as model chips with tier-based accent colors (warm gold for Max, cool blue for Med). Selection persists via `storage.setItem('as-launch-effort')`
- **Profile-aware visibility** — Effort section (`#as-launch-effort-section`) auto-hides when switching to Codex or Gemini profiles, re-appears on Claude Code. Applied in both main launch panel (`wireLaunchInline()`) and quick timer (`qt-profile` handler)
- **`--effort` flag plumbed through all launch paths** — `getTerminalProfile()` appends `--effort <level>` for `claude-code` profile (validated against `[low, medium, high, max]`). Flows through `/api/loop/launch`, `/api/agents/launch` → `launchAgentController` → `spawnAgentProcess`, `/api/quick-timer`, `/api/quick-timer/now`, and `launchScheduledLoop()`. Stored in loop state JSON for traceability
- **CSS** — `.as-launch-effort` chip styles in `styles.css` (flex row, backdrop blur, hover/active states, `--top` and `--default` tier color variants)

### Fixed — Edit Plan Shows Wrong Content (Stale Fallback Chain)
- **`extractPlanText(tab)` was called lazily when user clicked "Edit plan"** — By that time, post-plan messages (remember results, stop hook outputs) had been rendered in the DOM. The function walks backward through `.msg-body` elements and picked up these newer messages instead of the actual plan text. Confirmed: `data/plans/synabun-plan-*.md` on disk contained a memory observation, not plan content
  - Added eager plan content capture in `renderAssistant()` — the moment ExitPlanMode is detected (`tab._exitPlanPending`), `extractPlanText(tab)` is called immediately and stored as `tab._planContent`. At this point, plan text IS the last substantial `.msg-body` in the DOM — no post-plan messages exist yet
  - Removed unreliable `/api/latest-plan` disk scan fallback from Edit handler — it found stale files from previous sessions with wrong content. New chain: `tab.planFilePath` → `tab._planContent` → `extractPlanText()` last resort → error
  - All 3 plan mode toggle points (`/plan` command, Shift+Tab, button click) now clear `_planContent`, `_planContentCaptured`, `planFilePath`, `_editedPlanContent` when toggled ON — prevents inheriting stale data from previous plan sessions
  - `plan-saved` handler syncs `tab._planContent = content` so captured content stays current after edits

## 2026-03-31

### Fixed — Browser Rendering Parity with Real Chrome
- Set Playwright `viewport: null` in headed mode so pages render at the actual window size instead of a forced 1280x800 emulated box
- Removed forced `deviceScaleFactor: 1` override — Chrome now uses its native DPR (2x on Retina) for correct rendering
- Fixes white-page rendering on complex SPAs like Twitter/X where the emulated viewport broke CSS flexbox layouts

### Changed — Browser Stream Defaults to OFF
- Screencast streaming now disabled by default for fresh installs (was enabled)
- All 7 check sites updated: `disabled !== false` instead of `!!disabled` — stream only runs when explicitly toggled ON in Settings
- Affects server.js, ui-terminal.js (4 sites), ui-settings.js, ui-automation-studio.js

### Fixed — Terminal Text Cropped at Bottom (FitAddon box-sizing Mismatch)
- **xterm FitAddon overcounted rows by ~2** — The global `* { box-sizing: border-box }` reset caused `getComputedStyle(parent).height` to return the border-box height (including 40px of vertical padding) for `.term-viewport`. xterm's FitAddon v0.10.0 uses this value as available space, calculating ~2 extra rows that rendered beyond the visible content area and got clipped
  - Verified empirically via Playwright: border-box returns 386px vs child `height: 100%` resolving to 346px — a 40px mismatch equal to the viewport padding
  - Fix: added `box-sizing: content-box` to `.term-viewport` (docked) and `.term-float-viewport-wrap .term-viewport` (floating tabs) — `getComputedStyle().height` now returns content height matching what `.xterm { height: 100% }` resolves to, with no visual size change

### Fixed — Codex CLI Config Parse Error (TOML Serialization)
- **`tomlUpsertSection()` wrote JSON syntax for objects instead of TOML inline tables** — The `env` field in `~/.codex/config.toml` was serialized as `{"key":"value"}` (JSON, with colons) instead of `{key = "value"}` (TOML inline table, with `=`). Codex CLI rejected this with "missing assignment between key-value pairs, expected `=`"
  - Added `tomlSerializeValue()` helper that recursively serializes strings, arrays, and objects with correct TOML syntax
  - `tomlUpsertSection()` now calls `tomlSerializeValue(v)` instead of `JSON.stringify(v)`
  - Affects `POST /api/setup/codex/mcp` endpoint — the onboarding/settings toggle that registers SynaBun MCP in Codex

### Changed — Loop Browser: Shared System Chrome with Tabs
- **`ensureChromeDebuggable()` — one-time Chrome restart per NI boot** — New standalone function ensures Chrome is running with `--remote-debugging-port=9222`. Graceful AppleScript quit on macOS with `pgrep` polling (up to 8s), then `killall` fallback. Cleans `SingletonLock`, `DevToolsActivePort`, and crash markers before relaunch. Result is cached via `_chromeDebuggableReady` flag — subsequent calls just probe port 9222 and return instantly. Self-heals if Chrome was quit externally
- **`createBrowserSession` CDP block simplified** — Replaced ~120 lines of inline Chrome kill/relaunch logic with `await ensureChromeDebuggable()` + `chromium.connectOverCDP()`. No per-session Chrome restart
- **Loop launch rewritten (`POST /api/loop/launch`)** — Removed 15-second Strategy 2 UI poll entirely (wasted time when screencast disabled). New flow: scan `browserSessions` for existing CDP session → reuse it; if none, `createBrowserSession` once. Opens new tab per loop in the shared session instead of creating dedicated isolated sessions
- **Loop stop preserves shared session** — Made handler async. Closes only the loop's browser tab (not the entire session). Switches to next tab if the closed one was active. Session persists for next loop or manual use
- **Scheduled loops updated** — Same shared-session + tab approach applied to `launchScheduledLoop()`
- **MCP `resolveSession` fallback** — When `SYNABUN_BROWSER_SESSION` env is pinned but session no longer exists, verifies via `GET /api/browser/sessions` before using. Falls through to auto-select/create instead of failing with stale session ID
- **Browser enforcement prompt includes `browserTabId`** — `buildBrowserNote()` in `prompt-submit.mjs` now tells Claude which tab is theirs in the shared browser

### Fixed — Greeting Re-fires on Every Message in Ongoing Sessions
- **`session-start.mjs` injected `## GREETING DIRECTIVE` into persistent `additionalContext`** — SessionStart hook's `additionalContext` persists in the conversation context for the entire session. Claude saw the "begin with this greeting" instruction on every turn and re-greeted, overpowering the `bootCancel` countermeasure on messages 2+
  - Removed GREETING DIRECTIVE block and Session Boot Sequence block from `session-start.mjs` — these no longer persist in session context
  - Removed dead greeting helper functions (`loadGreetingConfig`, `getProjectGreetingConfig`, `getTimeGreeting`, `resolveTemplate`, `formatReminders`) from `session-start.mjs`
  - Added greeting helpers + `buildGreetingContext()` to `prompt-submit.mjs` — builds full greeting directive + boot sequence on message 1 only, so it never persists
  - Removed `bootCancel` injection on messages 2+ (no longer needed since there's no persistent directive to cancel)

### Fixed — Windows Cross-Platform Hook Compatibility
- **`hookCommandString()` embedded machine-specific absolute paths** — When hooks were installed into SynaBun's own `.claude/settings.json`, the function generated paths like `/Users/.../hooks/claude-code/script.mjs` that only worked on the originating OS. On Windows PowerShell, these macOS paths caused `SessionStart:startup hook error`. Fix: when `targetProjectPath` matches `PACKAGE_ROOT`, generate relative paths (`hooks/claude-code/script.mjs`) that work cross-platform. Absolute paths still used for global/external project installations
  - Updated `addHookToSettings()`, `removeHookFromSettings()`, `isHookInstalled()`, `isSpecificHookInstalled()` with `targetProjectPath` parameter
  - `removeHookFromSettings()` now matches both relative and absolute-path variants for cleanup of old installs

### Fixed — Pre-WebSearch Hook Hangs on PowerShell (Missing stdin Timeout)
- **`pre-websearch.mjs` had no stdin timeout** — On PowerShell, stdin `end` event may never fire, causing the hook to hang indefinitely. Added 2000ms timeout that fires `handleInput()` directly if stdin doesn't close. Refactored inline handler to named `handleInput()` function

### Fixed — Hooks Crash with Unhandled Errors Instead of Graceful Fallback
- **All 7 hooks now handle `uncaughtException` and `unhandledRejection`** — Added `process.on()` handlers to every hook file. Each outputs valid JSON appropriate to its hook type and exits with code 0 to prevent Claude Code from showing "hook error"
  - `session-start.mjs` — outputs `hookSpecificOutput` with fallback instructions telling Claude to follow CLAUDE.md rules manually
  - `prompt-submit.mjs`, `stop.mjs`, `post-remember.mjs`, `post-plan.mjs` — output `{}`
  - `pre-compact.mjs` — calls `process.exit(0)` silently

### Changed — Dependency Updates
- **mcp-server** — Updated 44 packages within semver ranges: `@modelcontextprotocol/sdk` 1.27.1→1.29.0, `@inquirer/prompts` 8.3.0→8.3.2, `vitest` 4.1.0→4.1.2, `@types/node` 22.19.13→22.19.15
- **neural-interface** — Updated 17 packages within semver ranges: `@anthropic-ai/claude-code` 2.1.71→2.1.89, `playwright` 1.58.2→1.59.0, `ws` 8.19.0→8.20.0. Fixed `lodash` prototype pollution vulnerability (GHSA-xxjr-mmjv-4gpg)
