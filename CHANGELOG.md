# SynaBun Changelog

Raw internal changelogs are archived in [changelog/](changelog/).

## 2026-04-06

### Added — Codex Settings Panel Wired to SDK
- **Config read/write RPC fixed** — `config_read` handler in `server.js` now passes `{ keys: [...] }` to Codex app-server's `config/read` RPC, returning layered response with `value`, `layer`, and `source` per key. `config_write` handler converted from broken flat-object `config/write` call to proper `config/batchWrite` format with `{ edits: [{ key, value }] }` array
- **Effective config cached and wired into thread/turn creation** — Added `_cachedConfig` object inside `handleCodexSkinWebSocket()` scope, populated on `config/read` response and updated after `config/batchWrite`. `getDefaultThreadParams()`, `getDefaultResumeParams()`, and `startTurn()` now read `approval_policy`, `sandbox_mode`, `model`, `model_reasoning_effort`, and `web_search` from cache instead of hardcoded `'never'`/`'workspace-write'`
- **`buildCodexSandboxPolicy()` accepts mode parameter** — Supports `read-only` (returns `readOnly` type), `danger-full-access` (returns `dangerFullAccess` type), and `workspace-write` (default, with `writableRoots`)
- **Settings UI field cleanup** — Removed 4 unused fields (`forced_chatgpt_workspace_id`, `forced_login_method`, `approvals_reviewer`, `workspace_write`). Added `model_reasoning_effort` select (Low/Medium/High/(default))
- **SDK-aligned dropdown values** — Approval Policy uses `never`/`unlessTrusted`/`onRequest` with friendly labels. Sandbox Mode uses `workspace-write`/`read-only`/`danger-full-access`
- **Dynamic model list** — Model and Review Model selects populated from `requestModelList()` API response, falling back to `CODEX_DEFAULT_MODELS`
- **Config layer badges** — Each field shows a subtle `(user)`/`(project)`/`(default)` badge parsed from the SDK's layered response

### Changed — Codex Settings Panel Visual Redesign
- **Glass-morphism styling** — Panel background changed from flat `#1e1e24` to `rgba(18,20,24,0.95)` with `backdrop-filter: blur(40px) saturate(1.3)`, layered box-shadows, 14px border-radius matching `.codex-panel` aesthetic
- **Entry animations** — Overlay fades in (`cxp-settings-fadein`), panel slides in with spring easing (`cxp-settings-slidein`, `cubic-bezier(0.16,1,0.3,1)`)
- **Sticky header** — `position: sticky` with uppercase 11px JetBrains Mono, 0.8px letter-spacing
- **Refined inputs** — `rgba(255,255,255,0.03)` background, 0.5px borders, hover/focus transitions with green accent (`rgba(115,213,167,0.35)`)
- **Account section** — Shows email when signed in; when not signed in, displays hint text ("Not signed in — run codex login in terminal") with a Login button
- **MCP section** — Empty state shows hint ("Configure in ~/.codex/config.toml under [mcp_servers]") instead of bare "No MCP servers configured"
- **Field placeholders** — Context Window shows "tokens", Auto-Compact shows "token limit", Provider shows "openai, ollama…"
- **Settings button hidden** — `.cxp-settings-btn` set to `display: none` while SDK integration matures; all code remains intact for re-enabling

### Fixed — Codex Sandbox Mode Enum Mismatch
- **camelCase vs kebab-case** — `thread/start` and `thread/resume` `sandbox` param requires kebab-case (`workspace-write`, `read-only`, `danger-full-access`) but was being sent as camelCase (`workspaceWrite`, `readOnly`, `dangerFullAccess`), causing "unknown variant" errors on thread restore. Fixed in `buildCodexSandboxPolicy()`, `getDefaultThreadParams()`, `getDefaultResumeParams()` in `server.js` and dropdown values in `ui-codex-panel.js`

## 2026-04-05

### Added — Session Menu Overhaul (Claude + Codex Sidepanels)
- **Search bar** — Sticky search input at the top of the session dropdown with 300ms debounce. Claude panel searches server-side via `fetchClaudeSessions({ search })` (matches `firstPrompt`, `gitBranch`, `sessionId`) plus client-side label matching. Codex panel filters client-side on thread label, source, and thread ID.
- **Filter controls** — Filter row with "Hide empty" pill (skips sessions with `messageCount === 0` and no custom label) and "Archived" pill (toggles visibility of archived sessions). Claude panel also includes a branch dropdown (`<select>`) populated from unique `gitBranch` values across loaded sessions.
- **Per-item archive** — Archive button (✖) appears on hover next to the rename pencil on each session item. Claude panel stores archive state client-side via `storage.js` with prefix `synabun-session-archived:`. Codex panel also calls `thread_archive` via WebSocket. When "Archived" filter is active, archived items appear dimmed with italic prompt text and an unarchive button (↩). Archive storage prefix is shared across both panels.
- **Infinite scroll** — `IntersectionObserver` on a sentinel `<div>` at the bottom of the session list. Claude panel uses true server-side pagination (`limit: 20`, `offset`-based via REST API). Codex panel fetches 100 threads upfront via WebSocket `thread_list` and virtual-paginates client-side in batches of 20. Spinner shown during load, "all sessions loaded" text when exhausted.
- **Refactored `renderSessionMenu()`** — Split into helper functions: `cpSessApplyFilters()` / `cxpSessApplyFilters()` for client-side filtering, `cpSessRenderItem()` / `cxpSessRenderItem()` for per-item DOM construction with archive/rename/click handlers, `cpSessLoadBatch()` for paginated fetching, `cxpSessRebuildList()` for re-rendering after filter changes. Renamed `.cxp-sess-archive` CSS class to `.cxp-sess-archive-current` to avoid conflict with per-item `.cxp-sess-archive-btn`.

### Fixed — Codex Sidepanel "Invalid Transport" Config Error
- **Orphaned TOML tool sections crash Codex CLI** — `syncCodexToolPermissions()` in `server.js` wrote `[mcp_servers.SynaBun.tools.*]` sub-sections to `~/.codex/config.toml` without checking whether the base `[mcp_servers.SynaBun]` section (with transport definition) existed. TOML sub-table headers implicitly create a parent table — Codex saw an MCP server with no transport and rejected it with "invalid transport" at startup.
- **Guard added to `syncCodexToolPermissions()`** — Now checks `tomlHasSection(content, 'mcp_servers.SynaBun')` before writing tool sections. If the base section is missing, strips orphaned tool sections via new `tomlRemoveAllToolSections()` helper and returns early.
- **DELETE handler cleanup** — `DELETE /api/setup/codex/mcp` now calls `tomlRemoveAllToolSections(content, 'mcp_servers.SynaBun.tools.')` after removing the base section, preventing orphaned tool sections from surviving a disconnect.

### Fixed — Codex Sidepanel Tasks Halt on Minimize or Focus Loss
- **No WebSocket keepalive** — Codex panel had no heartbeat mechanism (unlike Claude panel's 15s interval), making the WS connection vulnerable to browser idle/throttle teardown. Added `_startHeartbeat()` / `_stopHeartbeat()` in `ui-codex-panel.js` sending `{ type: 'heartbeat', windowId }` every 15s for all connected tabs, with a matching no-op handler in `handleCodexSkinWebSocket()` in `server.js`
- **Orphan grace period too aggressive** — `CODEX_ORPHAN_GRACE_MS` was `30_000` (30 seconds), killing the Codex child process before the client could reconnect after a WS drop. Increased to `30 * 60 * 1000` (30 minutes) in `server.js`, matching terminal session grace periods
- **Stall timer false positives on background tabs** — `STALL_WARN_MS` (30s) and `STALL_KILL_MS` (120s) used `setTimeout` which browsers aggressively throttle in hidden tabs, causing false stall detection and unwarranted task interrupts on return. Enhanced `visibilitychange` handler in `ui-codex-panel.js` to be bidirectional: pauses stall timer via `stopStallTimer()` on hidden, resumes fresh via `resetStallTimer()` on visible if `_running`

### Fixed — Codex Sidepanel Stop Button Non-Functional
- **Architectural mismatch with Claude panel** — Claude panel kills the OS process directly on stop (`activeProc.kill()` → process is dead → `aborted` sent → done). Codex panel sent a polite `turn/interrupt` JSON-RPC to the persistent `codex app-server` and awaited its response with a 10s timeout — the app-server accepted the RPC but didn't reliably stop the turn. The Codex Rust binary also catches SIGINT, making signal-based fallbacks ineffective.
- **Client rewired for immediate UI reset** — `interruptTurn()` in `ui-codex-panel.js` gutted from a complex 3s-retry → 2s-force-kill escalation chain (with 1.5s button disable, nested timers, and `interrupt_ack` round-trip dependency) down to 5 lines: calls `setRunning(false)` immediately on click to reset the UI, then sends `{ type: 'force_kill' }` to the server as best-effort process cleanup. No timers, no retries, no waiting for server confirmation.
- **Server interrupt handler reduced to no-op** — The `interrupt` message handler in `handleCodexSkinWebSocket()` in `server.js` (previously: guard on `activeTurnId`, `await request('turn/interrupt', ...)` with 10s timeout, SIGINT fallback) now logs and returns immediately. All stop logic routes through the existing `force_kill` handler which sends SIGTERM with SIGKILL escalation after 2s.
- **`interrupt_ack` handler as safety net** — `handleSocketMessage` case for `interrupt_ack` now calls `clearInterruptTimer()` + `setRunning(false)` + `setStatus('Stopped', 'info')` to guarantee UI reset even if the synthetic `turn/completed` from `force_kill` is missed.

### Fixed — Claude Sidepanel Drops Connection Mid-Task and Hangs
- **Orphan grace period too aggressive** — `ORPHAN_GRACE_MS` was `30_000` (30 seconds) in `handleClaudeSkinWebSocket()`, killing the Claude CLI process before the client could reconnect after a WS drop from macOS sleep, network hiccup, or tab throttling. Increased to `30 * 60 * 1000` (30 minutes) in `server.js`, matching `CODEX_ORPHAN_GRACE_MS`
- **No WebSocket-level keepalive** — The existing 15s heartbeat in `ui-claude-panel.js` was application-level only (JSON over an open WS), unable to prevent the OS or network intermediaries from silently killing the TCP connection. Added server-side `ws.ping()` frames every 30s inside `handleClaudeSkinWebSocket()` with pong-timeout detection — if no pong is received within the next interval, `ws.terminate()` fires to trigger a clean close/reconnect cycle instead of silent death
- **Leak scanner dedup broken** — `scanForLeaks()` runs every 10s and hashes `JSON.stringify(leaks)` to avoid redundant `session:leaks` broadcasts. But leak objects included `ageMs` (recomputed each tick from `Date.now() - fstat.mtimeMs`), making the hash different every cycle and broadcasting on every scan indefinitely. Stripped `ageMs` from the hash computation via destructuring (`const { ageMs, ...stable } = l`)

### Fixed — Claude Sidepanel Session Cross-Talk on Reconnect
- **Orphan registry keyed by `windowId` only** — `_orphanedProcs` Map in `handleClaudeSkinWebSocket()` used a flat `windowId` key, but all sidepanel tabs share the same `_windowId` (from `sessionStorage`). When multiple tabs disconnected simultaneously (page refresh, WS drop), the second tab's orphan overwrote the first — on reattach, a tab could reclaim the wrong session's process and display another tab's buffered events (e.g., `AskUserQuestion` cards from a plan session appearing in a task session). Added `_orphanKey(wid, sid)` composite key helper returning `"windowId:sessionId"`, updated all 5 Map operations (`set`, `get`, 3× `delete`) in the reattach handler and `ws.on('close')` handler. No client changes needed — `ui-claude-panel.js` already sent `sessionId` in the reattach message but the server ignored it.

### Fixed — Settings Provider Tooltip Clipped by Section Overflow
- **Tooltips cropped on hover** — `.cc-compat-popup` (provider compatibility popups) inside the Greetings section were clipped by `.iface-section`'s `overflow: hidden` (line ~10172 in `styles.css`). Added `overflow: visible` to `.iface-section[data-collapsible]` — safe because collapse uses `display: none`, not height/overflow animation.

### Fixed — Provider Compatibility Badges Incorrect
- **OpenAI Codex CLI marked incompatible** — `openaiItems` in `providerBadge()` had `{ label: 'Codex CLI', on: false }` — changed to `on: true` since SynaBun supports Codex CLI via MCP.
- **Claude Web and Cowork marked incompatible** — `providerBadge()` call for the Greeting section passed `{ web: false, cowork: false }` — changed both to `true` so all 4 Claude platforms (CLI, VSCode, Web, Cowork) show as compatible.

### Changed — Greeting Section Title
- **"Claude Greeting" → "Greeting"** — Removed redundant "Claude" from the collapsible section title in the Automations tab since the provider badges already indicate platform compatibility.

## 2026-04-04

### Added — Codex Sidepanel Activity Indicator
- **Thinking dots + elapsed timer** — New `.cxp-thinking` element appended to messages area when Codex is processing. Animated three-dot pulse with OpenAI avatar icon and live elapsed-seconds counter, matching Claude Code panel's indicator style.
- **Step detail text** — `updateThinkingDetail()` displays current work status (file being edited, command running, etc.) sourced from `syncWorkStatus()` branches, shown as right-aligned muted label inside the thinking element.
- **Lifecycle wiring** — `showThinking()` fires on `setRunning(true)` and after `sendPrompt()`. `hideThinking()` fires on first `item/started`, `item/agentMessage/delta`, `item/plan/delta`, `turn/completed`, and `setRunning(false)`. `repositionThinking()` keeps the element at the bottom of messages when new system content is appended.

### Fixed — Codex Sidepanel Stops Working on Page Reload or Tab Background
- **Orphan process registry** — Added `_codexOrphanedProcs` Map and `CODEX_ORPHAN_GRACE_MS` (30 s) to `server.js`. On WebSocket close, if a `windowId` is known and child is alive, the process is orphaned instead of killed — events buffer into an array via `sendToClient()` redirect.
- **Reattach message type** — New `reattach` handler in `handleCodexSkinWebSocket` looks up orphan by `windowId`, swaps the WebSocket reference via `orphan.swapWs(newWs)`, replays all buffered events, clears the kill timer, and sends `reattach_result` with thread state.
- **Client reattach-first flow** — `connectTab()` in `ui-codex-panel.js` now sends `reattach` with `_windowId` on reconnect before falling back to `bootstrap`. A 3 s timeout guards against stale orphans; on `reattach_result ok=false` or timeout, normal bootstrap proceeds.
- **Bootstrap windowId** — `bootstrap` message now includes `windowId` so the server can track the connection for future orphaning.

### Fixed — Codex Sidepanel No Reconnect on Visibility Change
- **`visibilitychange` handler** — Added in `wireEvents()`: when `document.visibilityState` becomes `'visible'`, checks the active tab's WebSocket state and immediately calls `connectTab()` if the socket is dead, bypassing the default reconnect delay.
- **Reattach timer cleanup** — `ws.onclose` handler in `connectTab()` now clears any pending `_reattachTimer` to prevent stale fallback bootstrap after intentional disconnect.
- **`reattach_result` handler** — New case in `handleSocketMessage` restores `_connected`, `_bootstrapped`, and `_running` state from the server response, requests model list, and appends a "Reconnected to Codex session" system message.
- **Seamless session continuity** — Combined with the orphan registry, tab backgrounding or page reload no longer loses the active Codex process — the user returns to an intact session with all missed events replayed.

### Fixed — Loop and Interactive Sidepanel Fighting Over Browser Session
- **No ownership tracking for loop-acquired sessions** — When a loop automation owned the only browser session (e.g., running on Facebook), the sidepanel Claude's `resolveSession()` auto-selected it as the single available session. Both Claude instances then competed for the same tab, causing navigation conflicts and broken automations.
- **`_loopOwned` Set added to browser sessions** — `createBrowserSession()` now initializes `_loopOwned: new Set()` on every session object. `/api/loop/launch` adds the loop's `terminalSessionId` to the set after acquiring the session; `/api/loop/stop` removes it during cleanup.
- **Ownership exposed in sessions API** — `GET /api/browser/sessions` now includes `loopOwned: boolean` and `agentOwned: boolean` fields per session, allowing the MCP layer to make informed routing decisions.
- **`findReusableBrowserSession()` respects loop ownership** — New `excludeLoopOwned = true` option (default on) skips sessions where `_loopOwned.size > 0`, alongside the existing `excludeAgentOwned` filter.
- **`resolveSession()` filters owned sessions for interactive use** — When no `SYNABUN_BROWSER_SESSION` env var is set (interactive sidepanel sessions), the MCP now filters out `loopOwned` and `agentOwned` sessions before auto-selection. If all sessions are owned, `browser_navigate` auto-creates a new session; other tools return a clear error message. Pinned loop/agent sessions bypass the filter entirely via their env var.

### Fixed — Concurrent Automation Browser Sessions Getting Destroyed
- **Grace timer used racy file-based ownership check** — `isSessionUsedByActiveLoop(sessionId)` read `LOOP_DIR/*.json` files to determine if a loop was using a session. Between reading and the timer firing, `/api/loop/stop` could delete the file, causing the timer to conclude no loop was active and destroy the session while other loops were still running. Replaced with in-memory `session._loopOwned?.size > 0` check — zero file I/O, no race window.
- **`context.on('close')` unconditionally deleted session from Map** — When Chrome crashed or was externally closed, the handler called `browserSessions.delete(sessionId)` with no ownership awareness. Loops pinned via `SYNABUN_BROWSER_SESSION` env var became stale with no recovery path. Added orphaned loop logging (`[...session._loopOwned]`) and broadcasts `orphanedLoops` array in the `browser:session-deleted` sync event.
- **`isSessionUsedByActiveLoop()` rewritten for in-memory checks** — Replaced the file-based implementation (read `LOOP_DIR`, parse JSON per file) with lookups against `session._loopOwned` Set, `session._agentOwned` flag, and `agentRegistry`. Eliminates the check-then-act race condition where files could be deleted between directory listing and file read.
- **PTY spawned before loop state file was written** — `createTerminalSession()` at line 5515 executed before `writeFileSync()` at line 5538, creating a race where `prompt-submit.mjs` hook fired before the pending file existed. `buildBrowserNote()` couldn't inject the browser session ID into Claude's context. Swapped order: loop state file is now written first, then PTY is spawned.
- **`/api/loop/stop` killed ALL loops indiscriminately** — No per-loop stop capability. Stopping one automation deleted all loop files, triggering cascade failures in the grace timer for remaining loops' browser sessions. Now accepts optional `terminalSessionId` in request body — if provided, only that specific loop is stopped and its `_loopOwned` entry removed. Omitting the param preserves backward-compatible stop-all behavior.

### Fixed — MCP Browser Session Recovery for Loops
- **`resolveSession()` returned hard error on dead pinned session** — When a loop's `SYNABUN_BROWSER_SESSION` pointed to a destroyed session (grace timer, crash), every subsequent MCP browser tool call failed with "Pinned browser session is no longer available" and no recovery. Added `_recoveredSessionId` module-level cache in `mcp-server/src/services/neural-interface.ts`. When the pinned session is gone, `resolveSession()` auto-creates a new session via `POST /api/browser/sessions`, caches its ID, and returns it. Subsequent calls reuse the cached session. Loops now survive browser crashes without manual relaunch.

### Fixed — Automation Studio Per-Loop Stop UI
- **Stop button killed all concurrent automations** — The "Stop" button in the running loop card and sidebar mini-stop button both called `stopLoop()` with no parameters, hitting `/api/loop/stop` which stopped everything. Updated `stopLoop()` in `api.js` to accept optional `terminalSessionId`. Running card stop button now includes `data-id="${loop.terminalSessionId}"`. Sidebar mini-stop button gets its `data-id` synced in `updateSidebarFooter()`. The `force-stop` handler passes the specific loop's ID through to the API.

### Added — Whiteboard "Send to Panel" Routes to Active Side Panel
- **`lastActivePanel` shared state** — Added `lastActivePanel: 'claude'` field to `state.js` shared state object. Both `ui-claude-panel.js` (`toggleClaudePanel()`) and `ui-codex-panel.js` (`setVisible()`) update this value when their panel becomes visible, defaulting to `'claude'` for backward compatibility.
- **Active panel routing** — The `wb:send-to-panel` event handler in `ui-claude-panel.js` now checks `state.lastActivePanel` before acting — skips if Codex is the active/last-active panel. New matching handler added to `ui-codex-panel.js` using Codex's native image format (`{ name, dataUrl }` vs Claude's `{ base64, mediaType }`). If neither panel is open, the last-active one auto-opens as fallback.

### Fixed — Neural Interface Crash on Playwright Dialog Race Condition
- **`ProtocolError: No dialog is showing` killed server** — Playwright's internal `DialogManager` auto-dismisses JS dialogs (`alert`/`confirm`/`prompt`) on pages without a `dialog` event listener. When the dialog disappears before the CDP `Page.handleJavaScriptDialog` command reaches Chromium, a `ProtocolError` is thrown as an uncaught exception. The existing `uncaughtException` handler in `server.js` only ignored `Frame has been detached` — the dialog error fell through to `process.exit(1)`, crashing the Neural Interface. Added `No dialog is showing` to the ignore list alongside the existing frame guard.

### Changed — Codex Sidepanel Activity Indicator Enriched with Structured Status
- **Title + detail layout** — Thinking row markup restructured from `avatar → dots → timer → detail` to `avatar → dots → title → detail → timer`. New `.cxp-think-title` element (11px, 50% white) shows the semantic action label ("Running command", "Updating files", "Working through plan", "Waiting for approval"), while `.cxp-think-detail` shows contextual specifics (command text, file path, plan step name). Timer moved to rightmost position with `margin-left: auto`.
- **`updateThinkingDetail()` replaced with `updateThinkingState({ title, detail })`** — Structured updater sets both `.cxp-think-title` and `.cxp-think-detail` independently and toggles `.cxp-thinking--waiting` class when the title starts with "Waiting", switching dots and title to amber (`rgba(255, 191, 71)`).
- **`syncWorkStatus()` feeds structured state** — All 7 branches now call `updateThinkingState()` with explicit `{ title, detail }` pairs derived from `itemHeadline()`, `_activePlan`, and `_threadActiveFlags`. Fallback branch shows project basename instead of blank.
- **DOM reuse in `showThinking()`** — No longer destroys and recreates the element on every call. If the thinking element already exists in the DOM, `repositionThinking()` is called instead, eliminating flicker during rapid `item/completed` → `showThinking()` cycles.
- **Thinking row persists through deltas** — Delta handlers (`item/agentMessage/delta`, `item/plan/delta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`) no longer call `hideThinking()`. Instead, content is appended first, then `repositionThinking()` keeps the indicator pinned at the bottom. Only `setRunning(false)` on `turn/completed` hides it.
- **Approval/input cards no longer hide indicator** — Removed `hideThinking()` from `handleServerRequest()`. Approval and input request cards render via `appendElement()` which already repositions thinking. `syncWorkStatus()` then updates the row to show "Waiting for approval" or "Waiting for input" with amber styling.
- **Detail width expanded** — `.cxp-think-detail` `max-width` increased from 180px to 260px; `margin-left: auto` removed (timer handles right-alignment now).

## 2026-04-03

### Added — Codex Side Panel Feature Parity (8 Phases)
- **Header toolbar** — Model selector dropdown (populated via `model/list` RPC), effort toggle (low/medium/high/auto), plan mode toggle, and auto-accept toggle that automatically approves `commandExecution`, `fileChange`, and `permissions` approval requests during turns. All state is per-tab and persisted in `sessionStorage`.
- **Input area enhancements** — Image attachments via paste, drag-drop, or file picker (up to 5, base64 data URLs). File path chips for referencing workspace files. Hold-to-talk voice input via Web Speech API (`initVoiceInput()`). Slash command hints (`/compact`, `/clear`, `/plan`, `/model`, `/effort`, `/queue`) with arrow-key navigation and Enter/Escape. Shift+Enter sends current text as additional prompt during active turns.
- **Queue system** — FIFO prompt queue with tray UI, drag-to-reorder, inline edit/remove per item, pause/clear controls, and badge count. `advanceQueue()` auto-sends the next queued prompt on `turn/completed`.
- **UX polish** — Copy-to-clipboard buttons on code blocks, file path linkification, syntax-highlighted code rendering, and collapsible reasoning/thinking blocks in message output.
- **Session management** — Thread fork (`thread/fork` RPC) creates a new tab with the forked thread. Thread archive (`thread/archive` RPC) archives the current thread and starts fresh. Both wired through `requestSocketPayload()` with generic `_renameRequests` tracking map.
- **SDK extras** — Settings panel overlay with three sections: Account info (`account/read`), MCP server status list with per-server Refresh and OAuth Login buttons (`mcp/serverStatus/list`, `mcp/server/refresh`, `mcp/oauth/login`), and Configuration viewer (`config/read`). Accessible via gear icon in the context bar.
- **Stall detection & auto-compact** — Client-side stall timer warns at 30 seconds of silence, auto-interrupts at 120 seconds during active turns (`resetStallTimer()`/`stopStallTimer()`). Auto-compact detection (`checkAutoCompact()`) flags >50% input token drops between `thread/tokenUsage/updated` notifications.
- **Enhanced interactive features** — Dynamic tool call requests now render a textarea with "Send Result"/"Decline" buttons instead of a dead-end "Return Unavailable". Image views render actual `<img>` elements with click-to-lightbox overlay. Terminal interactions provide inline text input with Enter-to-send for live process I/O via `processInput/send` RPC. Approval cards dynamically render buttons from the SDK's `availableDecisions` array (supporting `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`, `cancel`).
- **Server-side RPC bridge** — 11 new handlers in `neural-interface/server.js` Codex bridge section (~lines 2231–2716): `terminal_input` → `processInput/send`, `thread_fork` → `thread/fork`, `thread_archive` → `thread/archive`, `thread_unarchive` → `thread/unarchive`, `account_read` → `account/read`, `config_read` → `config/read`, `config_write` → `config/write`, `mcp_status` → `mcp/serverStatus/list`, `mcp_refresh` → `mcp/server/refresh`, `mcp_oauth_login` → `mcp/oauth/login`. All follow ensureInitialized → RPC request → sendToClient pattern.
  - All CSS uses `.cxp-` prefix, all storage keys use `synabun-codex-panel-*` prefix — complete isolation from the Claude Code side panel (`ui-claude-panel.js` confirmed untouched).

### Added — Brand Icons in Panel Footers
- **Claude icon in Claude side panel** — Replaced the SynaBun `favicon-32x32.png` brand mark in `.cp-toolbar-left` with an inline Claude "A" logo SVG. Updated `.cp-brand` CSS to include `color` for SVG fill support.
- **OpenAI icon in Codex side panel** — Added the OpenAI logo SVG (`<svg class="cxp-brand">`) before the attach button in `.cxp-footer-left`. Added `.cxp-brand { height: 16px; opacity: 0.6 }` CSS rule (was missing entirely — no icon appeared previously).

### Fixed — Reasoning Blocks Not Collapsible (Codex Panel)
- **Panels opened empty** — The `<details>` element in `ensureReasoningState()` was created without the `open` attribute, so reasoning content was hidden during streaming. Added `details.open = true` on creation so content is visible live.
- **Body content blank on expand** — When OpenAI redacts raw reasoning content (common), `state.bodyEl` had no text. `updateItemFromData()` now falls back to `state.summaryLines.join('\n')` or `'(reasoning complete)'` when `contentLines` is empty.
- **Auto-collapse on completion** — Sets `details.open = false` via `item/completed` so finished reasoning blocks are collapsed by default. Click to expand shows the summary or full reasoning.
- **Chevron indicator** — Added `summary::before` with a `▸` triangle that rotates 90° via `[open] summary::before` CSS to signal the block is clickable. Added `max-height: 300px; overflow-y: auto` to `.cxp-reasoning-body` for long content.

### Fixed — Message Cards Squashed from Below (Codex Panel)
- **`flex-shrink` missing on direct children** — `.cxp-messages` is a flex column with `position: absolute; inset: 0`. Child elements defaulted to `flex-shrink: 1`, causing flex to compress cards instead of scrolling. Added `flex-shrink: 0` to `.cxp-msg`, `.cxp-card`, and `.cxp-system` so they maintain their natural height and the container overflow-scrolls correctly.

### Fixed — Old Codex Sessions Reopening to Black Empty Panel
- **Resume path had no durable history fallback** — The sidepanel only restored old threads from the SDK `thread/resume` payload or a locally cached HTML snapshot. If an older Codex thread resumed without usable turn items and no fresh snapshot existed, the panel dropped to the empty `Open the Codex panel to start...` state instead of reconstructing the previous session.
- **Server-side transcript recovery** — The Codex bridge in `neural-interface/server.js` now looks up the saved thread in `~/.codex/state_5.sqlite`, reads its `rollout_path`, parses the corresponding Codex JSONL session transcript under `~/.codex/sessions/...`, and synthesizes structured fallback history items for user messages, assistant messages, MCP tool calls, dynamic tool calls, and command executions.
- **Client restore now consumes fallback history** — `renderHistory()` in `ui-codex-panel.js` now accepts `fallbackItems` from the server and renders them when the normal resume payload lacks usable turn data, while still preferring a newer local HTML snapshot when one exists. Old sessions selected from the Codex sidepanel session picker now reopen with their prior conversation/cards instead of a blank black panel.

### Fixed — Stop Button Not Stopping Codex
- **No feedback, no retry** — Single `sendSocket({ type: 'interrupt' })` on click with no visual confirmation. If the Codex RPC failed silently, nothing happened.
- **New `interruptTurn()` function** — Sets "Stopping…" status and appends a system message immediately. Temporarily disables the stop button for 1.5s to prevent spam. Retries interrupt after 3 seconds if `_running` is still true. Sends `{ type: 'force_kill' }` after 6 seconds total, which calls `child.kill('SIGTERM')` on the Codex process server-side. `clearInterruptTimer()` is called from `setRunning(false)` to clean up on normal turn completion.
- **Server `force_kill` handler** — New message type in the Codex bridge WebSocket (`server.js`). Kills the child process, clears `activeTurnId`, and sends a synthetic `turn/completed` notification to reset client state.

### Changed — Footer Toggles Match Claude Panel Style (Codex Panel)
- **Flat pill toggles** — Replaced `.cxp-toolbar-toggle` from inheriting `.cxp-btn` rounded button style (chunky green buttons) to transparent flat pills matching Claude's `.cp-think-toggle` / `.cp-plan-toggle` / `.cp-auto-toggle` pattern: 9px JetBrains Mono uppercase, `padding: 4px 7px 6px`, `::after` underline indicator with `scaleX(0)` default, hover `translateY(-1px)` + underline reveal, `:active` micro-press `scale(0.96)`.
- **Effort dots as `<i>` elements** — Changed from `::before`/`::after` pseudo-elements to three `<i></i>` children with `.lit` class toggled by `syncToolbarState()`. Progressive brightness: low = 1 dot, medium = 2, high = 3.
- **Per-toggle active states** — `#cxp-plan-toggle.active` uses blue (`rgba(130,175,255,0.85)`) + full `::after` underline; `#cxp-autoaccept-toggle.active` uses green (`rgba(100,210,140,0.85)`), matching Claude panel's plan/auto active colors exactly.
- Removed `cxp-btn` and `cxp-labeled` classes from toggle button HTML in the footer template.

### Fixed — Edit Plan Button Never Opening Plans

- **Stale `_rawMd` in dedup rendering path** — In `renderAssistant()`, the dedup branch updated `existingBody.innerHTML` but never set `existingBody._rawMd`. Since `extractPlanText()` walks `.msg-body` elements and reads `_rawMd` for content, it read stale partial text from a previous streaming tick. Fixed by computing `rawMd` before calling `md()` and assigning it to `existingBody._rawMd` before updating `innerHTML` (~line 3696 in `ui-claude-panel.js`).
- **No eager plan file creation at detection time** — `tab.planFilePath` was only set lazily inside the Edit button's click handler, meaning the plan file didn't exist yet when the button was first clicked. Fixed by issuing `POST /api/create-plan` immediately when plan content is captured at ExitPlanMode detection time, storing the returned path in `tab.planFilePath` so the Edit button always has a valid file to open. Applies in both the dedup rendering path (~line 3731) and the new-message rendering path (~line 3785).

### Fixed — CLI Auto-Detect Not Finding Claude After Reinstall
- **`which`/`where` blind to user bin dirs** — The settings auto-detect button (`POST /api/cli/detect/:profileId`) and runtime detection functions (`getClaudeBin()`, `getCodexBin()`) used bare `execSync('which claude')` inheriting the Node server's process PATH, which doesn't include `~/.local/bin` (Claude Code's default install location). Shell profiles (.zshrc) add this directory, but Node processes don't source them. Added `getAugmentedPath()` helper (~line 2112 in `server.js`) that prepends `~/.local/bin`, `/usr/local/bin`, and `~/.npm-global/bin` (filtered by `existsSync`). Applied to all 4 detection call sites via `env: { ...process.env, PATH: getAugmentedPath() }`. Cross-platform safe — `delimiter` from `path` module handles `:` vs `;`, non-existent directories are silently excluded.

### Added — Branch Dropdown in Codex Side Panel
- **Branch selector in projectbar** — Added `#cxp-branch` dropdown to the Codex side panel's projectbar, matching the Claude panel's existing branch dropdown. Populated via `/api/terminal/branches?path=...` endpoint using the shared `ddPopulate()`/`ddSetup()` utilities. Auto-refreshes when the active project changes in `updateActiveTabView()`. Added `.cxp-dropdown-sm { max-width: 72px; }` CSS for compact display.

### Fixed — PLAN COMPLETE Card Appearing After Non-Plan Tasks
- **Exit plan flags leaking across turns** — `_exitPlanPending`, `_exitPlanHandled`, and `_exitPlanWasPlanMode` flags set in `renderAssistant()` persisted on the tab object if `finishTab()` hadn't fired before the next `send()`. A new turn's `updateToolResult()` or `done` handler would read stale flags and render the PLAN COMPLETE card for a non-plan task. Fixed by explicitly clearing all three flags at the top of both `send()` and `_sendQueued()` in `ui-claude-panel.js`, ensuring no prior-turn state leaks into the new turn.

### Changed — Codex Footer Alignment with Claude Panel
- **13 CSS selectors updated** — Matched all padding, margin, font-size, height, gap, and border-radius values between `.cxp-*` footer elements and their `.cp-*` counterparts: `.cxp-bottom` (padding `14px 16px 12px`), `.cxp-input-shell` (min-height `44px`, padding `10px 14px`, border-radius `12px`), `.cxp-input` (font-size `13.5px`), `.cxp-send` (dimensions `30×30`, border-radius `8px`), `.cxp-footer-toolbar` (padding `6px 2px 0`, gap `6px`), `.cxp-footer-left`/`.cxp-footer-right` (gap `6px`), `.cxp-attach-btn`/`.cxp-mic-btn` (dimensions `26×26`, font-size `13px`, border-radius `6px`), `.cxp-cost` (font-size `9px`). Preserved Codex's green accent color while matching Claude's geometry exactly.

### Changed — Draft Preservation Across Panel Switches
- **Textarea text no longer lost on toggle** — When switching between Claude and Codex side panels, the current textarea value is now saved to `activeTab().draft` before hiding. In `ui-claude-panel.js`, `toggleClaudePanel()` saves `$input.value` to `tab.draft` in the close branch. In `ui-codex-panel.js`, `setVisible(false)` saves `panelEl('#cxp-input').value` to `tab.draft`. Both panels already restore `tab.draft` on re-render via `updateActiveTabView()`.

### Changed — Collapsible Cards with Lazy Body Rendering (Codex Panel)
- **Cards start collapsed by default** — All `.cxp-card` elements now render with `cxp-collapsed` class, hiding `.cxp-card-body` via `display: none`. A chevron indicator (`▾`/`▸` via CSS `::after` pseudo-element with rotation transform) signals clickability. `.cxp-card-head` gets `cursor: pointer` and `user-select: none`. Border-bottom on the head is removed when collapsed. Request cards (permission prompts with Accept/Decline buttons) remain expanded since they require user interaction.
- **Event delegation for expand/toggle** — Single click listener on `#cxp-messages-container` handles all `.cxp-card-head` clicks, toggling `cxp-collapsed` on the parent card. Skips clicks on interactive elements (`button`, `input`, `select`, `textarea`, `a`). Delegation pattern works for both newly created cards and snapshot-restored HTML.
- **Snapshot restore collapse enforcement** — `renderStoredTranscript()` now adds `cxp-collapsed` to all restored `.cxp-card` elements and injects missing `.cxp-card-chevron` elements for old snapshots saved before this change.
- **Lazy body rendering** — DOM writes are deferred while cards are collapsed to avoid unnecessary rendering overhead. `appendOutputDelta()` (commands, file changes), `appendPlanDelta()`, and `appendToolProgress()` always update their JS state buffers (`outputBuf`, `buffer`, `_lastProgress`) but skip DOM writes when `isCardBodyHidden(state)` returns true, setting `state._bodyDirty = true` instead. `updateItemFromData()` stores `state._lastItem` for all `.cxp-card` elements, always updates visible head elements (title via `itemHeadline()`, pill via `formatStatus()`), but skips the entire body switch block when collapsed. Non-card elements (`agentMessage`, `userMessage`, `reasoning`) always render normally. On expand click, `flushCardBody(state)` re-renders buffered content: plan cards get `setMarkdownBuffer()`, command/file-change cards get `setOptionalSection()` from `outputBuf` plus meta text from `_lastItem`, and all other types re-run `updateItemFromData(state._lastItem)`.

## 2026-04-01

### Added — Copy Button on Code Blocks in Claude Sidepanel
- **`addCopyButtons(el)` function** — Every `<pre>` block in assistant messages now has a "Copy" button in the top-right corner. Clicking copies the block's text content to clipboard via `navigator.clipboard.writeText()`, shows "Copied!" feedback for 1.5s with green accent
- **CSS: `.cp-copy-btn`** — Absolute-positioned button, JetBrains Mono 9px uppercase, always visible at 0.6 opacity, brighter on hover with subtle background. Added `position: relative` to `.cp-messages .msg-body pre`
- **Wired at 7 final render points** — `loadSessionHistory()`, `message_stop`, `content_block_stop`, `renderAssistant` (3 paths), and plan card body. Excluded from throttled 32ms streaming render to avoid flicker

### Fixed — Edit Plan Shows Wrong Content (Streaming Dedup Path)
- **Eager capture in wrong code path** — `extractPlanText(tab)` eager capture was placed in the new-message branch of `renderAssistant()`, but streaming always routes through the dedup branch via `handleStreamDelta()` — the capture was dead code. Added eager capture to the dedup path (line ~3723) where `tab._exitPlanPending` is set and the plan `.msg-body` already exists in the DOM. Third fix attempt over 6 days — all prior attempts targeted the correct function but the wrong branch
