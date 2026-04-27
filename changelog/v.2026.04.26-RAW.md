# SynaBun Changelog

Raw internal changelogs are archived in [changelog/](changelog/).

## 2026-04-25

### Added — Dedicated Schedules Studio
- **Standalone schedule window** — Added `neural-interface/public/shared/ui-schedules-studio.js` and initialized it from both `neural-interface/public/variant/2d/main.js` and `neural-interface/public/variant/3d/main.js`. The new window opens from `automations:open-schedules` and keeps schedule management out of the Automation Studio detail pane.
- **Tabbed schedule workspace** — Built Cron, Timers, Groups, and Activity tabs so recurring schedules, quick timers, group management, and run history have separate focused surfaces instead of sharing the automation editor area.
- **Schedule editor flow** — Added a dedicated editor with cron presets, timezone, day selection themes, enabled state, group assignment, and launch overrides for profile/model/effort/MCP/browser settings.
- **Timer controls** — Added quick timer creation, run-now actions, active timer countdowns, saved schedule timers, pause/resume, trigger, edit, and delete controls inside the schedules window.

### Added — Schedule Groups API and Persistence
- **Group-aware schedule store** — Added `loadScheduleStore()`, `saveScheduleStore()`, `loadScheduleGroups()`, `saveScheduleGroups()`, `validateScheduleGroupId()`, and `applyScheduleLaunchOverrides()` in `neural-interface/server.js`. Existing `loop-schedules.json` data remains compatible while the store can now persist `{ schedules, groups }`.
- **Schedule group endpoints** — Added `GET /api/schedule-groups`, `POST /api/schedule-groups`, `PUT /api/schedule-groups/:id`, `DELETE /api/schedule-groups/:id`, and `POST /api/schedule-groups/reorder` for group CRUD and ordering.
- **Schedule assignment metadata** — Extended schedule create/update and launch payloads to carry `groupId`, `profile`, `model`, `effort`, `mcpProfile`, and `usesBrowser`, allowing schedules in a group to keep their launch configuration with the schedule itself.
- **Client sync helpers** — Added schedule group API helpers in `neural-interface/public/shared/api.js` and broadcast handling for `schedule-group:created`, `schedule-group:updated`, `schedule-group:deleted`, and `schedule-group:reordered` in `neural-interface/public/shared/ui-sync.js`.

### Changed — Automation Studio Schedule Routing
- **Schedules removed from the Automation Studio content flow** — `initAutomationStudio()` no longer handles `automations:open-schedules` by switching `_view` to `schedules`, and Automation Studio no longer initializes schedule WebSocket rendering. The header Schedules button now emits the shared schedules event for the standalone window.
- **Automations submenu expanded** — Added Schedules, New Cron Schedule, Quick Timer, and Schedule Groups menu items in `neural-interface/public/shared/html-shell.js`, with handlers in `neural-interface/public/shared/ui-menubar.js` that open the dedicated schedules window directly to the requested flow.
- **Schedules window styling** — Added the `.schedules-studio-panel` glass shell and `.sched-*` responsive layout styles in `neural-interface/public/shared/styles.css` so the standalone window has its own grouped sidebar, tab rail, schedule lists, dialogs, and mobile layout.

### Changed — Live Countdown on Schedule Cards
- **Live ticking countdown** — Replaced static "Next: 4h" text on Cron-tab schedule cards with a 1-second-tick live countdown. `formatNextRun()` in `neural-interface/public/shared/ui-schedules-studio.js` rewritten as adaptive 2-unit format (`2d 3h`, `4h 23m`, `15m 42s`, `45s`, `Overdue`) that drops zero second-unit. Card markup wraps the value in `<span class="sched-countdown" data-countdown="<iso>">` so `updateTimerCountdowns()` can refresh text without re-rendering each tick. `POLL_INTERVAL` lowered from `5000` to `1000`; tick lifecycle stays bound to `startPolling()` / `stopPolling()` so it only runs while the panel is open.
- **Tabular-nums styling** — Added `.sched-countdown` rule in `neural-interface/public/shared/styles.css` with `font-variant-numeric: tabular-nums` to prevent layout jitter as digits change each second.

### Added — Edit Prompt Shortcut on Schedule Cards
- **Edit prompt icon button** — Each cron schedule card in `neural-interface/public/shared/ui-schedules-studio.js` now has an "Edit prompt" icon button (document-with-lines `script` icon) between Run Now and Edit Schedule. Click closes the Schedules panel and opens Automation Studio with the schedule's linked template selected directly in detail/editor view.
  - New `script` icon added to the `ICONS` map
  - New button uses `data-action="schedule-edit-prompt"` with `data-template-id="${s.templateId}"`
  - Existing pencil tooltip clarified from "Edit" to "Edit schedule" to differentiate
  - New `case 'schedule-edit-prompt'` handler reads `el.dataset.templateId`, calls `closePanel()`, then emits `automations:open` with `{templateId}` payload
- **`automations:open` event accepts `{templateId}` payload** — `initAutomationStudio()` listener in `neural-interface/public/shared/ui-automation-studio.js` now passes `opts` to `openPanel(opts = {})`. When payload contains `templateId`: if panel already open, finds template in `_templates` and calls `switchToDetail(tpl)`; on fresh open, after `loadData()` runs, looks up template and routes to detail view instead of `renderView()`. Falls back to default welcome view when no payload or template not found.

### Added — Sidepanel Tray Placeholder Pills
- **Persisted pills before panel bootstrap** — Added `neural-interface/public/shared/ui-sidepanel-tray.js` to render minimized placeholder pills for saved Claude, Codex, and OpenCode tabs before those provider panels have been lazy-loaded. The tray reads window-scoped tab storage, falls back to legacy single-session keys, filters out blank default sessions, and opens the matching provider via `claude-panel:show`, `codex-panel:show`, or `opencode-panel:show` with the selected `tabId`.
  - **Provider handoff events** — Wired `initSidepanelTrayPlaceholders()` from `ui-navbar.js`, then dispatch `sidepanel-tray:provider-loaded` from `toggleClaudePanel()`, Codex `ensurePanel()`, and OpenCode `ensurePanel()` so placeholders disappear once real provider-owned pills are restored.

### Fixed — Right-Side Toolbar Reservation During Sidepanel Switches
- **Toolbar could overlap an open sidepanel** — `ui-sidepanel-layout.js` previously tracked one `_activeOwner`, so closing or switching one sidepanel could clear `--right-panel-width` and `--right-panel-gap` while another right panel was still active. Replaced that with a per-owner reservation map, applying the widest active reservation and returning `true` from `clearRightPanelLayout()` only when no reservations remain, preserving toolbar and adjacent editor spacing during multi-provider toggles.

### Changed — Claude Restored Tab Selection
- **Restored Claude tabs keep stable IDs** — Updated `createTab()` in `ui-claude-panel.js` to accept a restored `id`, and changed `restoreTabs()` to pass saved tab IDs through. Placeholder click-through can now target the restored Claude tab instead of losing selection because the panel generated a fresh `crypto.randomUUID()` during bootstrap.

### Changed — Backup System Coverage Expanded
- **Backup file lists extended** — Added `stored-plans.json`, `synabun-plugins.json`, `mcp-registry.json`, and `active-profile.json` to both manual `GET /api/system/backup` (`neural-interface/server.js:10457`) and auto-backup `buildBackupZipToFile()` (`neural-interface/server.js:10844`) file arrays. These cover the post-plan hook plan→memory tracker, plugin install registry, third-party MCP server registry + profile defs, and active MCP profile selection — all previously lost on restore.
- **Plan markdown history backed up recursively** — Added `addDirRecursive('data/plans', ...)` to both manual and auto backup paths (`neural-interface/server.js:10483`, `:10868`) so the date-sliced plan tree (`data/plans/YYYY-MM-DD/*.md`) rides along.
- **Restore creates `plans` subdir** — Added `'plans'` to the `mkdirSync` subdir list in `POST /api/system/restore` (`neural-interface/server.js:10617`). Existing recursive `data/` write loop already extracts plan files via `dirname(target)` mkdir.
- **Backward compatible with old backups** — Manifest version check still accepts `version 1 || 2`. Old backups restore exactly as before — missing new files skipped silently, no schema migration required.

### Added — CLI-Not-Installed Indicator in Sidepanels
- **Empty-state banner across Claude, Codex, OpenCode panels** — Detects when the corresponding CLI binary is missing and renders a warning banner inside the panel's empty state (`.cp-empty` / `.cxp-empty` / `.ocp-empty`) with the install command, an "Install guide" link to the official docs, and a "Re-check" button. Banner is removed automatically once the CLI is detected.
- **Shared status module `cli-status.js`** — New `neural-interface/public/shared/cli-status.js` wraps the existing `/api/system/tool-versions` endpoint with a subscriber + auto-poll layer. Exposes `subscribeCliStatus(toolKey, cb)`, `recheckCliStatus(toolKey)`, `getCliDocUrl(toolKey)`, `getCliInstallCommand(toolKey)`, `getCliLabel(toolKey)`. Polls every 30s while at least one subscribed tool reports `installed === null`; stops once detected or unsubscribed. 10s in-memory cache + single in-flight fetch dedup.
- **Send-button gating** — Each panel's send/input flow is now blocked while the CLI is missing. `ui-claude-panel.js` `send()` returns early with a notification. `cdx/cdx-tabs.js` `syncInputEnabled` reads the `.cxp-cli-blocked` panel class to force `send.disabled = true`, and `sendPrompt()` returns early with a system message. `ocp/ocp-panel.js` `syncSendButton` short-circuits to disabled with the "OpenCode CLI not installed" tooltip; `handleSend` returns early via `setStatus('offline', …)`.
- **Banner re-render hooks** — `cdx/cdx-tabs.js` `clearTranscript` now dispatches a `cdx-empty-rebuilt` CustomEvent and `ocp/ocp-render.js` `renderEmptyState` dispatches `ocp-empty-rebuilt`, so the banner re-injects itself after the empty state is rebuilt during session resets.
- **Official install URLs** — `claude-code` → `https://docs.claude.com/en/docs/claude-code/setup`, `codex` → `https://developers.openai.com/codex/cli/`, `opencode` → `https://opencode.ai/docs/`. (`gemini` constants defined for future use; no Gemini sidepanel currently exists.)
- **Banner styles** — Added `.cp-cli-missing*`, `.cxp-cli-missing*`, `.ocp-cli-missing*` rule sets to `ui-claude-panel.js` style block, `cdx/cdx-styles.js`, and `ocp/ocp-styles.js`. Includes `.cp-cli-blocked` / `.cxp-cli-blocked` / `.ocp-cli-blocked` panel classes for the dimmed input state.

### Fixed — CLI-Not-Installed Banner Hidden After Errors / Broken-Binary Cases (Sidepanels)
- **Banner relocated to top of messages container** — Was rendered inside `.cxp-empty` / `.cp-empty` / `.ocp-empty`. Once any system message appeared (e.g. `Codex session closed` + `Codex app-server exited before responding to request 1`), the empty-state collapsed and took the banner with it. Banner is now an independent `:first-child` of `#cxp-messages-container`, `#cp-messages-container`, and `.ocp-messages-container` via `container.insertBefore(banner, container.firstChild)`. Stays visible across transcript states. New `ensureCliBannerEl()` / `removeCliBannerEl()` / `refreshCliBanner()` helpers replace the old empty-state-scoped `renderCliMissingBanner` / `refreshCliBanners` in `neural-interface/public/shared/cdx/cdx-panel.js`, `neural-interface/public/shared/ui-claude-panel.js`, and `neural-interface/public/shared/ocp/ocp-panel.js`.
- **Spawn-failure pattern detection** — Banner only triggered when `/api/system/tool-versions` reported `installed: null`. A broken-but-present binary (e.g. `codex 0.125.0` spawning then exiting immediately) reports a real version, so the banner never showed. Added a per-panel `_cliInstallFailureForced` flag flipped on by WS error patterns:
  - **Codex** — `applySocketError` in `cdx/cdx-tabs.js` matches `/Codex CLI not found|ENOENT|app-server exited before responding|app-server spawn/i` → dynamic-imports `cdx-panel.js` and calls exported `flagCdxCliInstallFailure()`.
  - **Claude** — `case 'error'` in WS handler matches `/Claude CLI not found|ENOENT/i` → `flagClaudeCliInstallFailure()`.
  - **OpenCode** — `onError` callback matches `/opencode.*(not.*found|ENOENT|spawn)|opencode CLI/i` → `flagOcpCliInstallFailure()`.
  - All three flags clear automatically when the `cli-status` subscriber callback later receives an installed value.
- **Send-button gate now reads forced flag** — Claude `send()`, Codex `sendPrompt()` (via `.cxp-cli-blocked` panel class read in `syncInputEnabled`), and OpenCode `syncSendButton` / `handleSend` all check `_cliInstalled === null || _cliInstallFailureForced` so a broken-binary install also blocks send.
- **Banner restyled as sticky alert** — New `.cxp-cli-banner*`, `.cp-cli-banner*`, `.ocp-cli-banner*` rule sets in `cdx/cdx-styles.js`, `ui-claude-panel.js` style block, and `ocp/ocp-styles.js`. Three-column grid (icon, text, actions), orange/amber theme, `flex-shrink: 0`, sits at top of the scroll region with `z-index: 5` so it stays above transcript content.

### Fixed — High Severity npm audit Alerts in Install CLI (Neural Interface)
- **Playwright SSL cert verification CVE** — `neural-interface/package.json` pinned `playwright` at `1.54.2`, vulnerable to GHSA-7mvr-c777-76hp (browser downloader skipped SSL cert authenticity check). Bumped to `^1.59.1` (non-major) — fixed in `<1.55.1`. `setup.js` install flow no longer prints the high severity warning after `Installing MCP Server dependencies`.
- **lodash code injection + protobufjs RCE via transitives** — `lodash@4.17.23` (pulled by `archiver` → `archiver-utils@5.0.2`) had high severity GHSA-r5fr-rjxr-66jc (`_.template` import key code injection) plus moderate prototype pollution. `protobufjs@7.5.4` (pulled by `@huggingface/transformers` → `onnxruntime-web@1.22.0-dev.20250409-89f8206ba4`) had critical GHSA-xq3m-2v4x-88gg (arbitrary code execution). Added `overrides` block in `neural-interface/package.json` pinning `lodash: ^4.18.1` and `protobufjs: ^7.5.5` — both within the parents' implicit ranges, no breaking change.

### Fixed — Moderate/High npm audit Alerts in Install CLI (MCP Server)
- **uuid buffer bounds check CVE** — `mcp-server/package.json` had `uuid@^11.1.0`, vulnerable to GHSA-w5hq-g745-h8pq (missing buffer bounds check in `v3`/`v5`/`v6` when `buf` provided), fixed in `<14.0.0`. Bumped to `^14.0.0` (semver major) — `v4` named export unchanged, `src/tools/remember.ts` and `src/tui.ts` compile cleanly with no source modifications.
- **hono / @hono/node-server / postcss / vite / protobufjs transitives** — multiple moderate-to-high CVEs in vitest's transitive `vite@8.0.0-8.0.4` (path traversal, `server.fs.deny` bypass, websocket arbitrary file read), `hono@<4.12.14` (cookie validation, path traversal in `toSSG()`, ipRestriction IPv4-mapped IPv6), `@hono/node-server@<1.19.13` (serveStatic repeated-slash bypass), `postcss@<8.5.10` (XSS via unescaped `</style>`), and `protobufjs@<7.5.5`. Added `overrides` block in `mcp-server/package.json` pinning `protobufjs: ^7.5.5`, `hono: ^4.12.14`, `@hono/node-server: ^1.19.13`, `postcss: ^8.5.10`, `vite: ^8.0.10` — patches only, no breaking semver bumps to direct deps.

### Changed — Removed Deprecated `@types/uuid` devDependency
- **uuid v14 ships own type defs** — removed `@types/uuid: ^10.0.0` from `mcp-server/package.json` devDependencies. npm warned the stub package as deprecated (`This is a stub types definition. uuid provides its own type definitions, so you do not need this installed`). `tsc` build verified — no missing-types errors.

## 2026-04-24

### Added — "Continue planning" in OpenCode, Codex, and Claude plan UIs
- **OpenCode** — Added `data-action="continue-planning"` button to the post-plan card in `ocp-render.js` and wired `onContinuePlanning` in `showPostPlanUI()` (`ocp-tabs.js`). Handler clears `showPostPlanActions` while keeping `mode='plan'`, so the user can keep prompting to refine the plan without exiting plan mode.
- **Codex** — Added `Continue planning` button to the post-plan card in `cdx-render.js`. Handler removes the card, then dispatches a new prompt with `forcePlanModePrefix: true` and the current plan text as context, allowing iterative plan refinement.
- **Claude** — Added `Continue planning` action entry in `ui-claude-panel.js`. Handler clears `showPostPlanActions` and saves tabs, keeping `tab.planMode = true` so the next user message continues in plan mode.
- **OpenCode guard message** — Updated the "choose before sending" error to include "Continue planning" alongside the existing three options.

### Fixed — OpenCode Sidepanel Post-Plan Card Resurrection
- **`setTabMode()` leaves `showPostPlanActions` flag true when leaving plan mode** — Mode button clicks, Tab-key mode cycling, and other `setTabMode()` callers bypassed `onContinue`'s flag clear, so `tab.showPostPlanActions` could persist into build/chat. Combined with the unguarded restore in `renderTabMessages()` at `ocp-tabs.js:2258`, any subsequent tab switch / session switch / revert / WS reconnect re-rendered the "PLAN COMPLETE" card in the message area even though the user had already moved on to implementation. Fixed in `neural-interface/public/shared/ocp/ocp-tabs.js` with two defenses:
  - `setTabMode()` now clears `tab.showPostPlanActions` and calls `removePostPlanCards(container)` on any `plan → non-plan` transition, symmetric with the existing `_exitPlanDetected` reset on entry.
  - `renderTabMessages()` restore guard tightened to `tab.mode === 'plan' && tab.showPostPlanActions && tab.planContent`, so a leaked flag cannot resurrect the card outside plan mode.

### Fixed — Loop Launch Silent Hang (Automation Studio Browser Loops)
- **Orphan Chrome holding `SingletonLock` froze `launchPersistentContext`** — When a previous loop-owned Chrome in `data/browser-profiles/<hash>/` stayed alive past its session, the OS-level singleton lock remained held by the live process. Existing stale-file cleanup at `neural-interface/server.js:20080` only removed unlocked lock files — useless when a running Chrome owned the lock. Subsequent `chromium.launchPersistentContext()` calls blocked indefinitely, so `POST /api/loop/launch` never returned. UI waited with no CLI window, no toast, no error surfaced. Fix in `neural-interface/server.js:20062` (`launchPersistentProfile`) adds a pre-launch orphan-kill pass: Unix uses `pgrep -f "user-data-dir=<root>"` + `SIGKILL`, Windows uses PowerShell `Get-CimInstance Win32_Process` filtered by `CommandLine -like "*user-data-dir=$root*"` (path passed via `SYNABUN_KILL_ROOT` env var to avoid backslash quoting) + `taskkill /F /PID`.
- **`launchPersistentContext` had no timeout** — Added `timeout: 45000` to `launchOpts` at `neural-interface/server.js:19938` as a platform-agnostic safety net. If any edge case still leaves the singleton locked, Playwright errors after 45s instead of hanging silently, letting the UI surface `Failed to launch loop`.

### Added — Diagnostic Alert Fallbacks for Silent Launch Failures
- **`attachDetached` catch in `neural-interface/public/shared/ui-terminal.js:5132`** — `showTermToast` appends its toast to `#term-container`; when the terminal panel is hidden (`offsetParent === null`), the toast renders invisibly and the failure gets swallowed. Added a post-toast container-visibility check that triggers a browser `alert()` with the error message plus a DevTools pointer when the container is hidden, surfacing attach failures that otherwise disappear.
- **`confirmLaunch` catch in `neural-interface/public/shared/ui-automation-studio.js:1491`** — Added an `alert()` alongside the existing `showToast` so errors thrown before the `terminal:attach-floating` emit (network failures, missing state, module-load errors) reach the user even when the toast host is offscreen.

### Fixed — Codex MCP Approval Gating
- **MCP approval prompts bypassed sidepanel Auto mode** — `handleCodexSkinWebSocket()` in `neural-interface/server.js` previously auto-accepted `mcpServer/elicitation/request` events for any SynaBun tool listed in `~/.claude/settings.json`, so tools like `mcp__SynaBun__remember` could run without a Codex approval card even when the tab Auto toggle was off. Added per-turn `activeTurnAutoAccept` tracking and gated the silent MCP accept path on both the current tab's Auto state and the permitted-tool list.
- **Auto state now travels with each Codex query** — `dispatchPrompt()` in `neural-interface/public/shared/cdx/cdx-tabs.js` includes `autoAccept: !!tab?.autoAccept` in the WebSocket `query` payload, and `server.js` passes it into `startTurn()` so approval behavior follows the visible tab state.
- **Per-turn auto-accept state is cleared after the turn** — `server.js` resets `activeTurnAutoAccept` on `turn/completed`, `thread/closed`, Codex child close, and `turn/start` failure to prevent a prior Auto-enabled turn from leaking into later tool approvals.

### Fixed — Codex Sidepanel Edit Plan Cancel Handoff
- **Post-plan card stayed disabled after closing the editor** — `renderPostPlanActions()` in `neural-interface/public/shared/cdx/cdx-render.js` intentionally marks the post-plan card busy when `Edit plan` opens the file editor, but the Codex `plan-edit-cancelled` path in `neural-interface/public/shared/cdx/cdx-panel.js` tried to recover through unregistered `_host.renderPostPlanActions` callbacks. The Codex `plan-saved` and `plan-edit-cancelled` listeners now import and call `appendAssistantMarkdownMessage()` / `renderPostPlanActions()` directly from `cdx-render.js`, so closing without saving re-renders a fresh clickable card and saving reopens the `PLAN UPDATED` handoff correctly.

### Fixed — Codex Loop Silent Failure (Sentinel Ignored Exit Code)
- **`attachExecLoopDriver` in `neural-interface/server.js:17230` advanced 162 ghost iterations after codex broke** — Iteration sentinel was built as `<codex exec ...>; echo SYNABUN_ITER_DONE_<N>`, so the echo fired regardless of `codex` exit status. After codex started failing fast at iter 4 (~4s vs ~7m for real runs), driver kept seeing the sentinel and looped 162 fake iters in 33 minutes until the PTY died with exit code 1. Fixed by:
  - Sentinel now `<cmd>; rc=$?; echo SYNABUN_ITER_DONE_<N> rc=$rc` — captures exit code in the echo.
  - Detection regex `new RegExp(\`${EXEC_SENTINEL_PREFIX}${session._execCurrentIter} rc=(-?\\d+)\`)` extracts `rc`.
  - Per-driver `consecutiveNonZero` and `consecutiveFastFails` counters with `FAST_FAIL_THRESHOLD_MS=30000` and `FAIL_LIMIT=3`. On 3-streak (non-zero exit OR sub-30s duration), driver marks loop `active:false`, sets `stoppedReason: 'fast-fail-rc'` or `'fast-fail-duration'`, records `lastExitCode`, kills PTY, and clears the interval.
  - Iteration start timestamp tracked via `session._execIterStartedAt = Date.now()` at iter-begin.

### Fixed — PTY Exit Left Loop File Active (Zombie Loops)
- **`createTerminalSession` PTY exit handler in `neural-interface/server.js:16718` did not update loop state** — When a loop-owned PTY died, `terminalSessions.delete()` ran and the driver interval cleared, but the on-disk loop file still showed `active:true`. UI/scheduler saw a phantom running loop forever. Fixed by adding a post-`pty:exit` block that calls `findLoopFileForTerminal(sessionId)`, marks the file `active:false`, sets `completedAt`, `stoppedReason: 'pty-exit-<code>'`, and records `lastExitCode`. Logs `pty:exit | marked loop inactive` for forensics.

### Changed — Loop Tab Isolation Hardening
- **Dropped `_switchSessionTab` calls during loop launch** — `neural-interface/server.js:8351` (manual launch) and `:8751` (scheduled launch) previously called `_switchSessionTab(claimedSession, ..., browserTabId)` after `createSessionTab`, flipping the shared browser session's `activeTabId`. With concurrent loops sharing one Chromium, this caused active-tab churn and risked any code path falling back to `session.activeTabId`. Each loop already pins its own tab via the `SYNABUN_BROWSER_TAB` env var, so the switch was unnecessary. Removed both calls; replaced with a comment explaining the constraint.
- **`SYNABUN_BROWSER_TAB` env now wins over caller-supplied `tabId`** — `mcp-server/src/services/neural-interface.ts:88` (`resolveSession`) reordered the resolution: pinned env value takes precedence over the explicit `tabId` argument. If the caller passes a different tabId, it's logged as `[MCP] tabId override ignored` and the pin is honored. Prevents an agent or model from accidentally leaking into another loop's tab by passing the wrong tabId. Rebuilt via `npm run build` in `mcp-server/`.

## 2026-04-23

### Added — Claude Code Plugin Install from MCP UI
- **CLI-delegated plugin installer** — Rewrote `neural-interface/lib/plugin-installer.js` to call `claude plugin marketplace add <url>` + `claude plugin install <plugin>@<marketplace>` instead of hand-writing `~/.claude/plugins/*.json`. Claude Code now owns its own marketplace + cache state; installs survive CC restarts. Legacy `synabun-symlink` source type removed.
- **Auto-repair on server startup** — `server.js` `app.listen` callback invokes `repairSynabunPlugins()`. Scans `~/.claude/plugins/known_marketplaces.json` for legacy `source: synabun-symlink` entries, purges dangling symlinks and stale `installed_plugins.json` rows, reinstalls via CLI from the remembered repo path.
- **`POST /api/plugins/repair`** — Manual trigger for the same repair flow.
- **`data/synabun-plugins.json` tracker** — New JSON file SynaBun owns, recording which plugins we installed (CC remains source of truth for install state). `setTrackerPath()` export pins the path to `DATA_HOME/data/synabun-plugins.json` on boot.
- **GitHub URL preferred over local clone** — `/api/mcp/install/github` claude-plugin branch passes `githubUrl` into the installer; CC re-clones fresh into its own cache so the temp clone at `data/mcp/<name>/repo` is only used to read the manifest.

### Added — Plugin Slash Commands in Sidepanel Autocomplete
- **`GET /api/claude-code/plugin-commands`** — New endpoint in `server.js`. Walks `~/.claude/plugins/cache/*/*/*/commands/*.{toml,md}`, parses `description` from TOML (`description = "..."`) or markdown frontmatter, returns `[{ name, description, source: 'plugin', plugin, marketplace }]`. No caching — fresh scan per request, so newly installed plugins appear without restart.
- **Autocomplete merge in `ui-claude-panel.js`** — `loadSkills()` adds a fourth merge step after SynaBun skills + CLI built-ins + extras. Plugin commands show in the `/` hint dropdown with `(plugin: <name>)` suffix.

### Fixed — Broken Legacy Caveman Install
- **CC marketplace loader errored with `Marketplace configuration file is corrupted`** — Caused by the old installer writing `"source": "synabun-symlink"` to `known_marketplaces.json`; CC prunes unknown source types and wiped the `cache/caveman/` symlink so `installPath` in `installed_plugins.json` pointed at a missing directory. Hooks never fired. Cleanup + CLI reinstall restored caveman — `claude plugin list` now shows `caveman@caveman ✔ enabled` with a valid `cache/caveman/caveman/<sha>` dir.

### Fixed — Sidepanel Slash-Hints Silent Bail
- **`showSlashHints()` returned early when `_skillsCache` null** — First `/` keystroke could fire before the async `loadSkills()` fetch resolved, leaving no dropdown. Made `showSlashHints` async; awaits `loadSkills()` when cache empty so the dropdown is guaranteed on first keystroke.

### Fixed — Sidepanel Slash-Hints Clipped by Input Wrapper
- **`.cp-input-wrap` had `overflow: hidden`** — Parent wrapper clipped the upward-expanding `.cp-slash-hints` dropdown (positioned `bottom: calc(100% + 4px)`). Removed the overflow rule — the wrapper's conic-gradient border already clips itself via `-webkit-mask-composite: xor`, so the overflow was redundant. Dropdown now expands unclipped and scrolls internally.

### Changed — Sidepanel Slash-Hints Dropdown Sizing
- **`.cp-slash-hints` — `max-height: 200px → 320px`** — Fits more rows before scroll kicks in.
- **Added `overscroll-behavior: contain`** — Mouse-wheel scroll inside the dropdown no longer bubbles to the message list beneath.

### Fixed — GitHub MCP Installer Discarded Servers on Install Failure
- **`/api/mcp/install/github` soft-fails local dep errors** — In `neural-interface/server.js`, the install endpoint returned HTTP 500 and aborted the whole flow when `pip install -r requirements.txt` or `npm install` errored, even though the clone + detection already succeeded. Reproducible with `AminForou/mcp-gsc`: launch command was `uvx mcp-search-console` (self-fetching) but `pip` missing on PATH made the endpoint bail before registry write. Now install failures attach an `installWarning` field to the 200 response — the server still registers, the user sees a `⚠` line in the GitHub install form, and deps can be fixed manually.
- **Self-fetcher runtimes skip local install** — Added `commandSelfFetches(detected)` in `neural-interface/lib/mcp-installer.js` that matches `uvx` / `uv run` / `npx` / `pipx` / `bunx` / `pnpm dlx` / `yarn dlx`. When true, `installDependencies` is never called — the server is registered with `install.skipped = true, reason: "command '<cmd>' self-fetches at runtime"` and the UI shows a `⚙ Skipped local deps` hint.

### Added — Cross-OS Preflight for Self-Fetching MCP Runtimes
- **`checkCommandOnPath(cmd)` in `neural-interface/lib/mcp-installer.js`** — OS-agnostic PATH probe. Uses `where <cmd>` on Windows (which resolves `.exe` via PATHEXT), `sh -c 'command -v <cmd>'` on Unix. 5s timeout guard. Returns a boolean.
- **`checkSelfFetcherAvailable(detected)` preflight** — Called by the install endpoint when `commandSelfFetches` is true. Returns `{ available, command, installHint }`. Missing binary attaches an OS-specific install command to `installWarning` (e.g. *"'uvx' not found on PATH. Install: brew install uv. Server registered anyway — will fail at launch until installed."*).
- **`SELF_FETCHER_INSTALL_HINTS` map** — Per-OS install commands for `uvx`/`uv`/`pipx`/`npx`/`bunx`/`bun`/`pnpm`/`yarn`. Mac uses `brew`, Linux uses official curl installers, Windows uses `winget` or PowerShell `irm`. `installHintFor(cmd)` picks the row based on `process.platform`. Ensures fresh SynaBun installs on Windows/Mac/Linux get actionable guidance instead of a silent launch failure.

### Changed — Codex Sidepanel Reasoning and Response Controls
- **Expanded Codex reasoning effort support** — Updated `neural-interface/public/shared/cdx/cdx-icons.js`, `cdx-panel.js`, `cdx-styles.js`, and `cdx-tabs.js` so the Codex footer effort toggle now supports the full current set of sidepanel overrides: `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. The toolbar indicator now renders five effort dots, includes visual states for `minimal` and `xhigh`, and `/effort` validates input while treating `default` and `none` as no per-turn override.
- **Exposed response-control config keys** — Added `model_reasoning_summary` and `model_verbosity` to `CODEX_CONFIG_KEYS` in `neural-interface/server.js`, then surfaced both in the Codex settings form and `/status` output in `neural-interface/public/shared/cdx/cdx-tabs.js`. Settings now support reasoning summary choices `auto`, `concise`, `detailed`, and `none`, plus response verbosity choices `low`, `medium`, and `high`.

### Fixed — Codex Sidepanel Session Cross-Talk
- **Per-tab WebSocket identity** — `sendSocket()` in `neural-interface/public/shared/cdx/cdx-tabs.js` now stamps every Codex sidepanel WebSocket message with the bound tab's `sessionId`, so bootstrap, query, reattach, model, interrupt, and compact traffic is routed to the owning tab instead of only the shared `windowId`.
- **Strict orphan reattach keys** — `_codexOrphanKey()` in `neural-interface/server.js` now requires both `windowId` and `sessionId`, and the reattach handler returns `reattach_result: false` when the tab id is missing. The close handler refuses to create window-wide orphans and kills sessionless processes, preventing a newly opened tab from replaying another tab's buffered tool-call events.
- **Reconnect state cleanup** — `onClose()` sets `pendingReattach` only for abnormal Codex socket closes and `onReattachResult()` clears it, preserving correct orphan recovery for the original tab without leaking state to other sessions.

### Fixed — Codex Sidepanel Active-Tab Stop Scope
- **Stop button aborted every running Codex tab** — The shared composer stop state in `syncInputEnabled()` was keyed off `_tabs.some((t) => t?.running)`, and `cdx-panel.js` wired click/Escape to `interruptAllTabs()`, so stopping one visible tab sent `interrupt` and delayed `force_kill` to every running tab WebSocket. The handlers now call `interruptTurn()` only when `activeTab()?.running`, the stop icon is scoped to the active tab, and `interruptTab()` sends session-scoped stop messages for the bound tab.
- **Stale force-kill retries could outlive successful interrupts** — `onInterruptAck()` now clears each tab's `_abortRetry`, preventing the fallback timer from killing a Codex app-server after the server already acknowledged an interrupt.
- **Server accepted unscoped stop messages** — `validateCodexControlMessage()` in `server.js` rejects `interrupt`/`force_kill` without a matching `sessionId` or with a mismatched `threadId`, while `forceKillCodexChild()` logs pid/session/thread/reason before terminating the app-server.

### Fixed — Codex Plan Mode Handoff
- **Post-plan actions no longer get skipped** — `dispatchPrompt()` in `neural-interface/public/shared/cdx/cdx-tabs.js` now marks sent plan turns with `planMode`, `planTurnActive`, and `lastPlanTurnId`, so `handleNotify('turn/completed')` captures the completed plan even if the toolbar `planMode` flag has already changed by the time the turn finishes.
  - **Approval gate persists across tab state** — Added `planApprovalPending` / `planTurnActive` persistence through `snapshotBoundState()`, `restoreBoundState()`, `commitBoundState()`, `bindTabState()`, `createTab()`, and `saveTabs()`, and blocks `sendPrompt()` / `advanceQueue()` until the user chooses Continue, Compact, or Edit.
  - **Continue/Edit paths clear or restore the handoff correctly** — `renderPostPlanActions()` in `cdx-render.js` clears pending plan state before dispatching the non-plan implementation prompt and restores it if send fails, while `cdx-panel.js` marks edited plan saves as pending approval again.
  - **Plan turns run read-only server-side** — `server.js` passes the client `planMode` flag into `startTurn()`, detects explicit `[PLAN MODE]` prompts with `isCodexPlanModePrompt()`, and forces `buildCodexSandboxPolicy(..., 'read-only')` for plan turns.
  - **Prompt text now enforces the sidepanel handoff** — `CODEX_PLAN_MODE_PREFIXES` in `cdx-icons.js` and `server.js` now tells Codex to stop after producing the plan and wait for the sidepanel’s Edit, Compact, or Continue choice.

### Fixed — CLI/TUI Rendering Corruption (Terminal)
- **Stable xterm renderer path** — `loadXterm()` in `neural-interface/public/shared/ui-terminal.js` now intentionally skips `@xterm/addon-webgl` and `@xterm/addon-canvas`, leaving CLI/TUI windows on xterm's DOM renderer. This avoids WebGL glyph atlas/context corruption seen after multiple long-lived floating CLI sessions.
- **Serialized terminal writes** — Added `_createTerminalWriter()` with 64KB chunking and `term.write()` callback backpressure, then routed fresh session, reconnect, and WebSocket reconnect output through it. This prevents large PTY bursts from piling up unbounded parser/render work during long Codex/Claude/Gemini sessions.
- **Snapshot-based reconnects** — `createTerminalSession()` in `neural-interface/server.js` now maintains a capped `VTermBuffer` per PTY, updates it on output and resize, and `/ws/terminal/:id` sends a synthesized `snapshot` payload instead of replaying an arbitrary raw ANSI tail. The snapshot includes a plain-text companion so `_sendOnceReady()` can still detect ready prompts without waiting for its fallback timer.
- **Virtual terminal snapshot support** — `neural-interface/public/shared/vterm-buffer.js` now exposes `useAltBuffer` and accepts a per-instance scrollback cap, letting live PTY sessions keep only the rows needed for reconnect recovery while preserving the larger default for existing capture use cases.

## 2026-04-22

### Added — Smart "Install from GitHub" (MCP + Claude Code Plugins Auto-Route)
- **Repo classifier** — New `classifyRepo(repoPath)` in `neural-interface/lib/mcp-installer.js` runs BEFORE `detectServer()` and returns `{ kind: 'mcp' | 'claude-plugin' | 'unknown' }`. Prefers MCP when both markers exist, emits `alsoClaudePlugin` hint for mixed repos, scans for codex/gemini/cursor/windsurf adjacency signals.
- **Claude Code plugin installer** — New `neural-interface/lib/plugin-installer.js` with `installClaudePlugin()`, `uninstallClaudePlugin()`, `listSynabunPlugins()`. Symlinks the cloned repo into `~/.claude/plugins/marketplaces/<name>` and `~/.claude/plugins/cache/<marketplace>/<plugin>/unknown`, appends SynaBun-tagged entries to `known_marketplaces.json` + `installed_plugins.json` (dedupe by `scope:'user' + installPath`), captures `gitCommitSha` via `git rev-parse HEAD`.
- **`POST /api/mcp/install/github` branches on classification** — After clone, `kind: 'claude-plugin'` skips MCP detection/deps install and calls `installClaudePlugin`; `kind: 'unknown'` returns 422 with hints list; MCP path unchanged. New endpoints `GET /api/plugins/list` and `DELETE /api/plugins/:marketplace?pluginName=&purgeFiles=1`.
- **Settings UI rename + plugin list** — "+ Add Server" button renamed to "+ Install from GitHub" in `neural-interface/public/shared/ui-settings.js`. New "Claude Code Plugins" subsection with per-row Uninstall. Install handler swaps the form into "plugin mode" (hides Type/Command/Args/env/platforms/Save) when response is `kind: 'claude-plugin'` since the plugin is already activated server-side.

### Added — Installed MCPs Sub-Tab (Cross-CLI Unified View)
- **`GET /api/mcp/installed-all` endpoint** — Aggregates every externally-installed MCP across SynaBun registry (non-builtin), `~/.claude.json`, `~/.gemini/settings.json`, `~/.codex/config.toml` (regex `^\[mcp_servers\.([^\].]+)\]$` excludes nested `.tools.` sections), and OpenCode's `mcp.*` config. Merges by server name; `registeredWith` is a sorted array of CLI keys.
- **Sub-tab navigation inside Settings → MCP** — New `.stg-mcp-page-tabs` at top of the page swaps between **Profiles** (existing matrix + always-on + per-profile External Servers toggles) and **Installed** (new cross-CLI list + Claude Code Plugins + Install form). SynaBun's built-in tool groups are excluded from the Installed view.
- **Per-CLI badges** — Each row in the Installed list shows compact `SB/CC/OC/CX/GE` badges indicating which CLIs have the server registered. Styles added for `.stg-mcp-page-tabs`, `.stg-mcp-page-tab.active`, `.stg-mx-ext-cli-badge`.

### Added — Cross-CLI Uninstall Button on Installed-Tab Rows
- **One-click uninstall across all registered CLIs** — Each row in the Installed sub-tab carries a `×` button with `data-registered` containing its precise CLI list. Click handler confirms using the badge labels (e.g., "Remove foo from CC, OC, CX?"), then: if `registeredWith` includes `synabun` → `DELETE /api/mcp/registry/servers/:name`; for every remaining CLI key → `DELETE /api/mcp/sync` with `{ name, platforms: cliList }`. Refreshes both Installed list and the Profiles-tab External Servers list afterward. Avoids pointless 404 churn by only hitting CLIs that actually have the server.
