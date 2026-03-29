# SynaBun Changelog

## 2026-03-29

### Fixed — Edit Plan Auto-Implementing Instead of Re-Prompting
- **`plan-saved` handler bypassed user review** — After saving an edited plan in the code editor, the `plan-saved` event handler in `ui-claude-panel.js` immediately sent "Proceed with the implementation based on this updated plan" to Claude, giving the user no opportunity to review the edits or re-edit. Rewrote the handler to render a synthetic assistant message showing the updated plan as markdown, then call `renderPostPlanActions(tab, 'PLAN UPDATED')` to re-display the 3-button action card (Implement / Compact / Edit) — creating an iterative editing loop
- **`renderPostPlanActions()` header was hardcoded** — Added optional `headerText` parameter (defaults to `'PLAN COMPLETE'`) so re-renders after edits can display `'PLAN UPDATED'`
- **Edited plan content lost on implementation** — "Continue with implementation" sent a generic prompt (`'Continue with the implementation based on the approved plan.'`) without the edited content. Now checks `tab._editedPlanContent` and sends the full updated plan text to Claude when present

### Added — Minimized Pill Checkmark Icon on Task Complete
- **Profile icon swaps to green checkmark when CLI status is DONE** — When a minimized terminal pill's CLI status changes to `done`, the `.term-minimized-pill-icon` innerHTML is replaced with a checkmark SVG (`SVG_CHECK_DONE` constant, 16x16 polyline). Original icon is preserved in `dataset.originalIcon` and restored when status changes away from `done`. Icon swap logic added to the pill section of `_updateSessionBadges()` in `ui-terminal.js`. Green color (`rgba(100, 200, 120, 0.8)`) applied via `.term-minimized-pill-icon.done` CSS class in `styles.css`, matching the existing DONE badge palette

## 2026-03-28

### Added — Browser Stream Toggle (Settings > Browser)
- **Stream enable/disable toggle** — New `#bc-screencastEnabled` toggle in the Browser settings Quick Setup card (`ui-settings.js`). Persisted as `screencast.disabled` in `data/browser-config.json` via `collectBrowserConfig()`, restored via `applyBrowserConfig()`. Default: OFF (stream disabled by default, toggle ON to enable with GPU warning)
- **Server-side screencast guard** — `startScreencast()` in `server.js` now checks `loadBrowserConfig().screencast.disabled` before starting CDP `Page.startScreencast`. When disabled, returns early — no frame capture, encoding, or WebSocket broadcasting. Eliminates ~50% CPU from the Playwright Chrome GPU process
- **Client-side floating window suppression** — Both `reconnectBrowserSession()` and `openBrowserSession()` in `ui-terminal.js` now check `/api/browser/config` at entry and return early when `screencast.disabled` is true, blocking ALL code paths that create floating browser windows — MCP automation sync events, reconnect events, page-load auto-restore, Apps dropdown launches, and keyboard shortcuts. Additional guards in `sync:browser:created` handler and auto-reconnect logic for defense in depth
- **Automation unaffected** — All MCP browser tools (`browser_click`, `browser_navigate`, etc.) continue working via REST API. Playwright browser still launches headful (visible Chrome window). Only the CDP screencast stream and Neural Interface preview are disabled

### Added — Multi-Select Checkbox Visual Distinction for AskUserQuestion
- **Square checkbox indicators for multi-select questions** — When `AskUserQuestion` is called with `multiSelect: true`, the UI now renders square checkbox `::before` pseudo-elements (`border-radius: 3px`) instead of the default circle radio indicators (`border-radius: 50%`). Applied via `.ask-options.multi` CSS class in both the sidepanel (`ui-claude-panel.js` inline styles) and standalone chat (`claude-chat.css`).
- **"Select all that apply" hint text** — A `.ask-multi-hint` element is injected above the options when multi-select is active, styled as a subtle italic label (`9-10px`, `rgba(100,160,255,0.4)`). Implemented in three JS render paths: `renderAskUserQuestion()` and `buildAskFromToolUse()` in `ui-claude-panel.js`, and `renderAskUserQuestion()` in `claude-chat.js`.

### Changed — Standalone Chat Radio Indicators (Parity Fix)
- **Added missing `::before` radio indicator to standalone `.ask-option`** — The standalone chat (`claude-chat.css`) previously had no visual radio/checkbox indicator on question options, unlike the sidepanel. Added full `::before` pseudo-element with `14px` circle, hover border color transition, and selected state with filled background + inset box-shadow. Also restructured `.ask-option` layout from `flex-direction: column` to `row` with `.ask-option-wrap` for label/description column alignment.

### Changed — multiSelect Ruleset Guidance
- **Added `### Multi-Select Questions` section to rulesets** — New section in `CLAUDE-template.md` and `CLAUDE.md` instructing Claude to set `multiSelect: true` when options are not mutually exclusive (e.g., multiple features, tags, effects, follow-up actions). Added corresponding one-liner to all 4 condensed rulesets (Cursor, Generic, Gemini, Codex). Auto-propagates to Settings "Copy Ruleset" and Onboarding Step 6 via `GET /api/claude-code/ruleset`.

### Added — Whiteboard Multi-Select Keyboard Shortcut
- **`M` key toggles multi-select mode** — Added keyboard shortcut in the whiteboard's `onKeyDown` handler (`ui-whiteboard.js`) to toggle `toggleMultiSelectMode()` via `M` key press. Only fires when not editing text/list elements (inside the `!isEditing` block). Updated toolbar tooltip from `"Multi-select (drag to select)"` to `"Multi-select (M)"` in `html-shell.js`

### Changed — Focus Mode Zero-Resource Consumption for 3D & 2D Memory Views
- **Event handler pausing via `_focusPaused` flag (3D)** — Added `_focusPaused` module-level flag to `variant/3d/graph.js` with early-return guards on `_onPointerMove()`, `_onPointerDown()`, `_onPointerUp()`, the `mousemove` tracker in `_initMouseTracking()`, and the wheel-during-drag handler. New `pauseInteraction()` / `resumeInteraction()` exports also disable/enable `OrbitControls` to prevent orbit/zoom input processing
- **Camera input pausing via `_cameraPaused` flag (3D)** — Added `_cameraPaused` flag to `variant/3d/camera.js` with early-return guards on `onKeyDown()`, `onKeyUp()`, `onMouseDown()`, and `updateCameraMovement()`. New `pauseCamera()` / `resumeCamera()` exports clear all held WASD keys and reset `_lastFrameTime` to prevent deltaTime spikes on resume
- **Event handler pausing via `_focusPaused` flag (2D)** — Added `_focusPaused` flag to `variant/2d/graph.js` with early-return guards on all 7 canvas event handlers: `_onPointerDown()`, `_onPointerMove()`, `_onPointerUp()`, `_onPointerLeave()`, `_onWheel()`, `_onDblClick()`, `_onContextMenu()`. New `pauseInteraction()` / `resumeInteraction()` exports also kill active pan inertia
- **Focus event wiring (both variants)** — `variant/3d/main.js` wires `focus:enter` → `pauseInteraction()` + `pauseCamera()` and `focus:exit` → `resumeInteraction()` + `resumeCamera()`. `variant/2d/main.js` wires `focus:enter` → `pauseInteraction()` and `focus:exit` → `resumeInteraction()`. Resize handlers intentionally left active (cheap, ensures correct dimensions on focus exit)

### Fixed — Window Controls Overlay CSS Specificity Bug
- **WCO padding overridden by base styles** — The `@media (display-mode: window-controls-overlay)` block at line ~142 in `styles.css` set `padding-left` on `#title-bar`, but the base `#title-bar` rule at line ~1302 used `padding` shorthand with equal specificity (1-0-0). Since the base rule appeared later in the file, it silently overwrote the WCO padding — traffic lights overlapped navbar elements when the macOS overlay toggle was clicked. Replaced the media query with `body.wco-active #title-bar` (specificity 1-1-1), using the `wco-active` class already toggled by `navigator.windowControlsOverlay.geometrychange` in `ui-navbar.js` but never wired to CSS. Also added right-side padding via `max(18px, calc(100vw - env(titlebar-area-x) - env(titlebar-area-width) + 10px))` to account for the WCO toggle arrow

### Changed — Window Controls Overlay Visual Polish
- **Theme color matched to navbar** — Changed `theme_color` from `#1c1c1e` to `#0e0e10` in `manifest.json`, `index.html`, and `index2d.html`. The old value was visibly lighter than the navbar's composited appearance (`rgba(18,18,20,0.65)` over `#030305` body ≈ `#0d0d0f`), causing a mismatch behind the macOS traffic lights
- **Vertical alignment with traffic lights** — Replaced `padding-top: calc(env(titlebar-area-y) + 10px)` with `padding-top: 0; padding-bottom: 0; height: env(titlebar-area-height, 48px)`. The navbar now matches the WCO area height exactly, and the base `align-items: center` vertically centers content at the same midpoint as the traffic lights
- **Bar-right pill invisible in WCO mode** — Added `body.wco-active #title-bar .bar-right` rule that strips `background`, `backdrop-filter`, `border`, and `box-shadow`. The frosted glass pill container becomes seamless with the navbar when compact, and reappears automatically in expanded standalone mode

### Fixed — Pencil Tool Rendering Smoothness (Whiteboard)
- **Screenshot capture used `lineTo` instead of smooth bezier curves** — The canvas-based `_captureScreenshot()` in `ui-whiteboard.js` rendered pen strokes with straight `ctx.lineTo()` segments between points, producing visibly polygonal lines (circles looked like hexagons). Replaced with `new Path2D(el.pathD)` which reuses the pre-computed Catmull-Rom cubic bezier SVG path data already stored on each pen element. The live SVG rendering was already smooth — only the screenshot capture path was broken
- **Increased Laplacian smoothing passes from 3 to 5** — `penEnd()` now calls `smoothPoints(_penPoints, 5)` instead of 3 passes, producing rounder curves with fewer angular artifacts on finalized strokes
- **Reduced jitter threshold from 3px to 2px** — `penMove()` minimum distance filter lowered to capture denser point sampling during drawing, giving the bezier interpolation more data points for smoother curves

### Fixed — Plan System "PLAN COMPLETE" Card Never Rendering in Sidepanel
- **Root cause: `--print` mode doesn't emit `tool_result` events for built-in tools** — The sidepanel runs Claude CLI in `--print --output-format stream-json` mode, which emits `assistant` events (with tool_use blocks) but NOT `tool_result` events for built-in CLI tools like ExitPlanMode. All plan completion logic was in `updateToolResult()`, which never fired. Moved ExitPlanMode detection to `renderAssistant()` (where tool_use blocks ARE visible), setting `_exitPlanPending` / `_exitPlanWasPlanMode` flags. The `result` event handler (and `done` handler as backup) now checks these flags and calls `renderPostPlanActions()` before `finishTab()` clears them
- **`buildTool()` missing `dataset.toolName`** — Regular tool cards were created with `dataset.toolId` but never `dataset.toolName`. Added `card.dataset.toolName = block.name` in `buildTool()` for all non-MCP tool cards
- **`wasPlanMode` guard in `updateToolResult()`** — Sidepanel plan mode is simulated (prompt prefix, not native EnterPlanMode), so ExitPlanMode always returns `is_error: true` with "You are not in plan mode". Added `wasPlanMode` capture before clearing `tab.planMode`, allowing post-plan actions to render even on expected errors. Kept as secondary handler if CLI ever emits tool_result for built-in tools

### Fixed — Post-Plan Hook Matcher Drift (server.js)
- **Stale matcher dropped EnterPlanMode handling** — Server-side hook config at `server.js:7340` had matcher `'^ExitPlanMode$'` but the actual `~/.claude/settings.json` registration uses `'^(Enter|Exit)PlanMode$'`. If hooks were re-registered from server config, the EnterPlanMode handler in `post-plan.mjs` (AskUserQuestion reminder, plan file path guidance to `data/plans/` instead of `~/.claude/plans/`) would silently stop firing. Updated matcher to `'^(Enter|Exit)PlanMode$'`

### Fixed — Agent Loop Browser Sessions Dying Between Iterations
- **Per-iteration browser session lifecycle** — Browser sessions died between agent loop iterations because `context.on('close')` in `createBrowserSession()` deleted sessions from the `browserSessions` Map with zero agent ownership checks, and the mirror directory (`data/browser-profiles/c141af32ddb4`) had recurring `ENOTEMPTY` cleanup errors causing re-created sessions to launch from corrupted profiles that crashed immediately. Loops would complete 1 productive iteration then stall.
  - Iterations 2+ now destroy the old browser session (saving cookies via `destroyBrowserSession()`) and create a fresh one with a unique ID and 3 retry attempts
  - Added `_agentOwned` flag on browser sessions — grace timer at the WS `close` handler now checks `session._agentOwned` before destroying, preventing premature session kills when no UI viewer is connected
  - Mirror directory `rmSync` in `createBrowserSession()` now retries 3x with escalating delay (500ms, 1000ms, 1500ms) to handle `ENOTEMPTY` from locked Chrome files
  - Added `_usesBrowser` flag on agent object to track browser-dependent loops
  - Final browser session is destroyed on loop end via cleanup block after the iteration `for` loop

### Added — Notification Click-to-Navigate with Session/Tab Specificity
- **`notify()` extended with routing opts** — Added optional 4th `opts` parameter to `notify(source, type, label, opts)` in `ui-notifications.js`, accepting `{ sessionId, tabId }` to identify the specific terminal session or panel tab that triggered the notification
- **Toast click routes to specific session/tab** — `_showToast()` click handler now emits `terminal:show` with `{ sessionId }` or `claude-panel:show` with `{ tabId }` data payload, enabling the event listeners to focus the exact source rather than just showing the panel generically
- **OS banner click-through via service worker** — `_sendBanner()` passes a `routing` object (containing `source`, `sessionId`, `tabId`) to the service worker. `sw.js` stores it in `notification.data` and relays it back to the client via `postMessage({ type: 'NOTIFICATION_CLICK', ...routing })` on `notificationclick`. A new `navigator.serviceWorker` message listener in `ui-notifications.js` catches this and emits the correct routing event
- **Terminal session focus on notification click** — `terminal:show` event handler in `ui-terminal.js` now accepts a `data` parameter; when `data.sessionId` is present, finds the session index via `_sessions.findIndex()` and calls `switchToSession(idx)` to focus that specific tab
- **Panel tab focus on notification click** — `claude-panel:show` event handler in `ui-claude-panel.js` now accepts a `data` parameter; when `data.tabId` is present, finds the tab index via `_tabs.findIndex()` and calls `switchTab(idx)` to activate that specific tab
- **All 10 notify call sites updated** — 8 panel calls pass `{ tabId: tab.id }` (error, done, action, ask, timeout) and 2 CLI calls in `_notifyStatusChange()` pass `{ sessionId }`

### Added — Message Queue System for Claude Code Sidepanel
- **Per-tab message queue with FIFO auto-advance** — New queue system in `ui-claude-panel.js` (448 lines) allows users to stack multiple messages while Claude is processing. Messages fire sequentially with 300ms delay between turns. Tab state extended with `queue[]`, `queuePaused`, `queueExpanded`, and `_queueWasActive` fields in `createTab()`, persisted via `saveTabs()`/`restoreTabs()` in localStorage
- **Collapsible queue tray UI** — Glass-aesthetic drawer injected inside `.cp-bottom` above the project bar. Features expand/collapse toggle, live count badge with pulse animation, pause/resume button (amber state when paused), and clear-all button. Items show truncated text preview, attachment badges, edit and remove buttons
- **Drag-to-reorder queue items** — HTML5 DnD on `.cp-queue-item` elements with `dragging`/`drag-over` CSS states. Source index stored in `dataTransfer`, drop handler splices `tab.queue` array and re-renders
- **Inline edit of queued messages** — Click edit icon replaces `.cp-queue-text` span with an `<input>`, commit on Enter/blur, cancel on Escape. Edited text saved back to `tab.queue[idx].text`
- **Input behavior change while running** — Enter (while running + has text) now **queues** the message instead of triggering /btw. Shift+Enter (while running + has text) triggers the existing /btw abort+send interrupt. Send button icon dynamically shows queue icon (☰) by default, switches to /btw arrow when Shift held, stop square when empty. Shift keydown/keyup listeners on `#cp-input` toggle the icon in real-time
- **Auto-advance on turn completion** — `advanceQueue(tab)` hooked into `done` and `aborted` handlers in `_processTabMsg()`. Guards on `tab.running`, `tab._activePerm`, and `tab.pendingAsk` ensure queue pauses naturally during permission prompts and AskUserQuestion interactions, resuming after resolution + turn completion
- **Internal `_sendQueued(tab, item)`** — Mirrors the `send()` flow but reads text/images/files from the queue item object instead of `#cp-input`. Respects `tab.planMode` (wraps prompt with plan prefix), updates pill label on first message, handles image/file attachments. "Queue complete" status message appended when all items are processed

## 2026-03-27

### Added — Hook-Side Auto-Recall Memory Injection
- **`POST /api/hook-recall` endpoint** — New lightweight recall endpoint in `neural-interface/server.js` that accepts `{ query, project, limit, min_score }`, calls `getEmbedding()` + `dbSearchMemories()`, and returns top N memories with content truncated to 300 chars. Returns `{ results: [] }` on any error for graceful degradation
- **`autoRecall()` in prompt-submit hook** — New function in `hooks/claude-code/prompt-submit.mjs` that calls `/api/hook-recall` on every substantive user prompt (past skip patterns), auto-detects project from `cwd` via `detectProject()`, and injects top 3 matching memories (score >= 0.4) directly into `additionalContext` as a formatted `=== SynaBun: Related Memories ===` block
  - Added `import { detectProject } from './shared.mjs'` for project-scoped queries
  - Added `cwd` parsing from hook stdin input
  - 3-second timeout with silent fallback — NI server down or slow never blocks the hook
  - Skipped for first message (boot sequence handles recall) and active loops (own context management)
  - Coexists with existing Tier 1-3 recall nudges — memories are injected directly while nudges still tell Claude to do deeper targeted searches when specific patterns match

### Fixed — Duplicate AskUserQuestion Cards in Claude Skin
- **Dual control_request rendering** — The server sent two `control_request` messages for every `AskUserQuestion` tool call: a proactive one when detecting the tool in the assistant stream event, and a second from the CLI's `permission_denials` in the result event. Client-side dedup guards failed to catch the second render due to an edge case where `renderAssistant()` short-circuits when a message contains only `AskUserQuestion` tools (no text), leaving `pendingAskToolUseId` unset.
  - **Server fix** (`neural-interface/server.js`) — Added `permCardToolNames.has(requestId)` check in the denial loop to skip sending a duplicate `control_request` when the proactive one was already sent
  - **Sidepanel fix** (`neural-interface/public/shared/ui-claude-panel.js`) — Added `&& !tab.askRenderedViaControl` guard to `handleControlRequest` to prevent rendering a second card even if a duplicate `control_request` reaches the client
  - **Standalone chat fix** (`neural-interface/public/claude-chat.js`) — Added full `askRenderedViaControl` flag lifecycle (declaration, set on render, guard in `handleControlRequest`, clear on response) — this page previously had no dedup logic at all

### Fixed — File Attachments Not Reaching Agent from Claude Panel "Send to AI"
- **Send button disabled logic ignored `attachedFiles`** — Three separate locations in `ui-claude-panel.js` (tab switch at line 1983, window focus at line 2289, input handler at line 5117) computed `$send.disabled` by checking only `tab.attachedImages.length`, never `tab.attachedFiles.length`. When a file was attached from the file explorer with no text typed, the send button stayed disabled. Added `&& !tab.attachedFiles.length` to all three checks.
- **Early return guard in `send()` blocked file-only sends** — The guard `if (!text && !tab.attachedImages.length) return` at line 4477 prevented sending when only files were attached (no text, no images). Added `&& !tab.attachedFiles.length` to the guard and the running-state abort check.
- **Path chips persisted after send** — `buildPromptWithAttachments()` removed `.cp-file-chip` elements but "Send to AI" from the file explorer creates `.cp-path-chip` elements. Changed selector to `.cp-file-chip, .cp-path-chip` so both chip types are cleaned up after the file content is consumed into the prompt.
- **No explicit framing for attached files** — File content was wrapped in bare `<file>` XML tags with no natural language context, while images got explicit "The user attached an image. Use the Read tool to view it:" framing. Added a header: `"The user attached a file (path). Its content is provided below."` matching the image attachment pattern.
- **BTW interrupt flow discarded attached files** — `_btwPending` captured `images` but not `files`. After the abort-and-resend cycle, files were lost. Added `files` to the btw snapshot and `buildPromptWithAttachments()` processing on resend.
- **No visual feedback for sent files in chat** — `appendUser()` displayed images in the message bubble but had no `files` parameter. Added file chip rendering (inline SVG + filename) so the user sees which files were included in their message.

### Changed — Recall Profile Presets Modernized (Settings > Memory)
- **New SVG icons** — Replaced generic icons with more distinctive ones: Quick (arrow-right), Balanced (sun/radiate), Deep (concentric circles/target), Custom (3-slider equalizer)
- **Mouse-tracking radial glow** — Ported the website's `integ-btile` hover pattern: `radial-gradient(180px circle at var(--mx) var(--my), ...)` following cursor position via JS `mousemove` handler setting CSS custom properties
- **Icon-to-background hover effect** — Ported the website's `.giants-card` pattern: on hover, the small icon fades out (`opacity: 0; transform: scale(0.5)`) and a cloned oversized SVG (`.recall-bg-icon`, 110x110px) scales in as a ghostly background watermark (7% opacity, 0.5px blur) at the top-right corner
- **Active state shows background icon** — Active/selected card permanently displays the background watermark instead of the small icon, matching the hover visual
- **Card hover depth** — Added inset box-shadow (`inset 0 0 40px 6px rgba(0,0,0,0.4)`) and subtle top-edge highlight line via `::after` pseudo-element
- **Active state gradients** — Replaced flat backgrounds with directional `linear-gradient(160deg, ...)` and per-profile accent-tinted mouse-tracking glow (blue/green/purple/amber)

### Fixed — Neural Interface Memory Leaks (11GB+ RAM in Edge)
- **Unbounded DOM growth in Claude panel** — Messages, status lines, tool cards, and stream chunks were appended to `tab.messagesEl` forever with no cleanup. Added `pruneMessages()` function with `MAX_MSG_CHILDREN=600` and `PRUNE_BATCH=150` — removes oldest 150 nodes when threshold exceeded. Wired into all 5 append paths: `appendStatus()`, `appendError()`, `renderAssistant()`, stream `content_block_start`, and `loadSessionHistory()` in `ui-claude-panel.js`
- **Unbounded message buffer during permission prompts** — `tab._msgBuffer` grew without limit while `_activePerm` was true, accumulating all incoming WebSocket messages. Capped at 500 entries in `ui-claude-panel.js`
- **Event listener accumulation in Automation Studio** — Six `document.addEventListener` calls (mousemove, mouseup, 2x click, 2x keydown) in `initDrag()`, `wireIconPicker()`, `wireCategoryPicker()`, and `wirePanel()` were never removed when the panel closed. Each open/close cycle leaked more listeners onto `document`. Added `_docListeners[]` registry to store references and cleanup loop in `closePanel()` that calls `removeEventListener` for each in `ui-automation-studio.js`

### Changed — Window Header Modernization (Neural Interface)
- **Consistent design language across 13+ window headers** — Updated `.settings-panel-header`, `.as-header`, `.as-detail-header`, `.as-picker-header`, `.as-wizard-header`, `.as-launch-inline-header`, `.as-unsaved-dialog-header`, `.ss-header`, `.ss-editor-header`, `.tw-header`, `.term-float-tab-header`, `.link-panel-header`, `.fe-editor-header`, `.awiz-header`, `.cat-change-modal-header`, `.ecm-header`, `.detail-header`, and `.sidebar-header` in `styles.css` with unified styling: gradient backgrounds (`linear-gradient(to bottom, rgba(255,255,255,0.025), transparent)`), softer borders (`rgba(255,255,255,0.04)` replacing `var(--b-subtle)`), lighter title weight (500 with `letter-spacing: 0.01em`), ghost-style action buttons (transparent default, subtle border on hover), red-tint close hover (`rgba(255,82,82,0.1)` background), and muted badge colors
- **Terminal floating tabs refined** — Added gradient header background, tighter margins (6px vs 8px), and softer shadow to `.term-float-tab-header` and pinned variant

### Changed — Focus Mode Buttons & Active Badge Removed
- **Focus mode buttons removed from all windows** — Deleted `.as-focus-btn`, `.ss-focus-btn`, and `.stg-focus-btn` CSS classes (including SVG, hover, and active states) from `styles.css`, along with responsive container query overrides at 680px, 560px, and 440px breakpoints. Removed HTML templates, click event listeners (`$('as-focus')`, `$('ss-focus')`), and `_focusMode` state variables from `ui-automation-studio.js`, `ui-skills.js`, and `ui-settings.js`. The feature was dead code — `_focusMode` only toggled a CSS class with no UI effect
- **Active automation badge removed from Automation Studio** — Deleted `.as-active-badge` CSS (including hover, `.running-pulse` child, and responsive overrides at 560px/440px) from `styles.css`. Removed badge HTML template, `updateHeaderBadge()` function, and its 3 call sites (initial render, polling interval, stop-loop handler) from `ui-automation-studio.js`

### Changed — Unified Page Margins (Workspace Toolbar & Claude Panel)
- **Dynamic top margin and increased right/bottom margins** — The workspace toolbar (`#topright-controls` in `styles.css`) and Claude panel (`.claude-panel` in `ui-claude-panel.js`) used a hardcoded `top: 68px` that drifted from the dynamically-measured navbar height. Changed `top` to `calc(var(--navbar-height, 48px) + 20px)` so the gap tracks the actual navbar. Increased `right` from `16px` to `20px` and `bottom` from `16px` to `20px` on the panel, and `right` from `calc(16px + ...)` to `calc(20px + ...)` on the toolbar — all three margins now consistently 20px

### Fixed — Context Gauge Showing Inflated Values Above Max
- **Gauge corrupted by cumulative `result.usage`** — The Claude Code CLI's `result` event contains cumulative token usage (sum of all API calls in a single CLI process), but `handleTabEvent()` in `ui-claude-panel.js` overwrote `tab.usage` with these values. Since `cache_read_input_tokens` accumulates across every internal API call (hooks, tools, response), the gauge total could reach multiples of the context window. Removed the `tab.usage` overwrite from the `result` handler — gauge now only uses correct per-turn values from `assistant`/`message_start` events
- **`contextWindow` update now triggers gauge re-render** — Previously `tab.contextWindow` was set from `result.modelUsage` but `renderGauge()` was not called afterward, so the gauge could display against a stale denominator until the next turn

### Fixed — Auto-Compact Detection Never Triggering
- **Detection used cumulative values that only increase** — Server-side auto-compact detection in `server.js` tracked `prevTurnTokens` from `result.usage` (cumulative across all API calls). Since cumulative values never decrease, the >50% drop check could never fire. Moved detection to `assistant` events where `message.usage` contains per-turn context size, enabling correct detection of compaction drops

### Fixed — Session History Endpoint Using Wrong Context Window
- **`CLI_CONTEXT_WINDOWS` hardcoded 1M instead of 200K** — The `/api/claude-code/sessions/:id/messages` endpoint inferred context windows as 1M for Opus/Sonnet 4.6, but the CLI actually reports 200K via `modelUsage.contextWindow`. Fixed to 200K to match reality
- **Removed `result.usage` override in JSONL parser** — The session history endpoint preferred `result.usage` (cumulative) over `assistant.message.usage` (per-turn) when both were present, which would produce inflated token counts for restored sessions

### Changed — Batched AskUserQuestion Submission UX
- **Options toggle freely without immediate send** — Rewrote `renderAskUserQuestion()` and `buildAskFromToolUse()` in `ui-claude-panel.js` to use a shared `pendingAnswers` dict instead of firing `sendAskAnswer()` on each individual option click. Single-select questions deselect siblings on click; `multiSelect` questions toggle selections. All options remain enabled until the batch is submitted. Same pattern applied to `renderAskUserQuestion()` in `claude-chat.js` (standalone chat page)
- **Submit button with progress counter** — Added `div.ask-submit-bar` containing `button.ask-submit` after all question cards. Button shows `Submit (0/N)` initially, updates counter as each question is answered (`Submit (2/3)`), and enables only when all questions have selections. On click: disables all options/inputs and sends the full answers dict via `sendAskAnswer()` / `sendControlResponse()`
- **Inline text input for free-text questions** — Questions without options now render an `input.ask-text-input` inside the card instead of relying on the main chat input box. Text is stored in `pendingAnswers` on each `input` event, contributing to the submit counter
- **CSS for submit bar and text inputs** — Added `.ask-submit-bar`, `.ask-submit`, `.ask-text-input` styles in both `ui-claude-panel.js` embedded styles and `claude-chat.css`, matching the existing design system (JetBrains Mono, blue accent colors, disabled opacity)

### Fixed — Whiteboard List Items Lost on Reload/Reboot
- **List item content not persisting** — List elements saved with empty `items: ['']` because contenteditable `<li>` DOM content was never flushed back to `el.items` in the `_elements` array. Unlike text elements (which have a `blur` handler syncing `el.content`), list items only synced in `exitListEditMode()`, which was missing from most exit paths (click canvas, click element, switch tools). Added `flushListEdits()` and `flushTextEdits()` helpers that sync DOM → model without exiting edit mode. `persistDebounced()` now calls both flush helpers before serializing, ensuring content is always captured. `getWhiteboardSnapshot()` refactored to use the same helpers. Added `exitListEditMode()` alongside every `exitEditMode()` call in `onMouseDown()` across 8 code paths in `ui-whiteboard.js`

### Changed — Browser Viewer Resize Decoupled from Actual Browser Viewport
- **Removed `ResizeObserver` viewport sync in `openBrowserSession` and `reconnectBrowserSession`** — Previously, resizing the floating browser window sent `{ type: 'resize', width, height }` to the server after 500ms settle, which called `page.setViewportSize()` on the Playwright browser — physically changing the external browser's viewport. Removed `sendBrowserResize()`, `sendReconnResize()`, their `ResizeObserver` instances, `visibilitychange` handlers, and tracking variables from `ui-terminal.js`. The browser now stays at its configured 1280x800 viewport. Click coordinate mapping via `canvasCoords()` already uses `scaleX = canvas.width / rect.width`, so interaction accuracy is preserved
- **CSS canvas fill** — Changed `.browser-canvas` from `max-width: 100%; max-height: 100%` to `width: 100%; height: 100%; object-fit: contain` in `styles.css` so the canvas always fills the container and scales proportionally

### Changed — Browser Screencast 30fps Frame Rate Cap
- **Frame throttle in `createFrameRenderer()`** — Added `performance.now()` tracking with `FRAME_INTERVAL = 1000/30` (33.3ms) threshold in `utils.js`. Frames arriving sooner than the interval are dropped before decoding. Applied globally to all browser screencast viewers (floating windows, side panel embed, reconnected sessions)

### Changed — Browser Screencast Pauses on Minimize
- **`minimizeTab()` sends `pause-screencast`** — When a browser floating window is minimized to a pill, sends `{ type: 'pause-screencast' }` via WebSocket in `ui-terminal.js`. Server handler in `handleBrowserWebSocket()` (`server.js`) calls `stopScreencast(session)` which sends `Page.stopScreencast` to CDP, stopping frame encoding and delivery
- **`restoreTab()` sends `resume-screencast`** — On restore, sends `{ type: 'resume-screencast' }` which calls `startScreencast(session)`. Both handlers are idempotent (guarded by `screencastActive` flag)

### Added — Focus-Based Browser Screencast Throttle
- **Non-focused browser windows throttle to ~2fps** — `_applyBrowserFocusThrottle()` in `ui-terminal.js` sends `{ type: 'throttle-screencast' }` to non-focused browser sessions when tab focus changes via `bringTabToFront()`. Server-side handler in `handleBrowserWebSocket()` (`server.js`) re-sends `Page.startScreencast` with `everyNthFrame: 15` and reduced quality (capped at 50), replacing the active screencast config atomically without stop/start gap. Focused window receives `resume-screencast` to restore full framerate
- **`resume-screencast` handles both throttled and paused states** — If `session.screencastActive` is true (throttled), sends `Page.startScreencast` directly with full-rate config to un-throttle. If false (fully paused), calls `startScreencast(session)` to restart from scratch

### Added — Browser Screencast Idle Timeout (5 Minutes)
- **Auto-pause after inactivity** — `_resetBrowserIdleTimer()` and `_resumeFromIdleIfNeeded()` in `ui-terminal.js` manage a per-session idle timer (`BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000`). On timeout, sends `{ type: 'pause-screencast' }` to fully stop streaming and sets `session._screencastIdlePaused = true`
- **Canvas interaction resets timer** — `_onCanvasInteraction()` wrapper calls `_resumeFromIdleIfNeeded()` and `_resetBrowserIdleTimer()` at the start of every canvas event handler (click, dblclick, wheel, keydown, keyup) in both `openBrowserSession` and `reconnectBrowserSession`
- **Timer cleanup on session close** — `clearTimeout(session._idleTimer)` added to `closeSession()` teardown path

### Added — Shift+Tab Plan Mode Shortcut in Claude Sidepanel
- **Keyboard shortcut** — Pressing `Shift+Tab` while the `#cp-input` textarea is focused now toggles plan mode on/off. Updates the `#cp-plan-toggle` button active state and displays a status message. Added in the `keydown` listener inside `wireEvents()` in `ui-claude-panel.js`

### Fixed — User Learning Enforcement Not Triggering After Decluttering
- **Stop-hook CHECK 2.5 removed during decluttering broke enforcement** — The prompt-submit nudge fired correctly (debug log confirmed `FIRE` entries at message thresholds 3/6/9 across multiple sessions) but Claude ignored every nudge — `userLearningObserved` stayed `false` in all sessions. Root cause: the decluttering replaced CHECK 2.5 with a comment at `stop.mjs:482` stating "User learning handled by prompt-submit nudges — not stop-hook blocks." Original architecture decision had documented that nudges alone were insufficient.
- **Restored CHECK 2.5 as bundled obligation** — User learning now piggybacks on the existing obligation system in `stop.mjs`. When both task memory (CHECK 2) and user learning are pending, they're combined into a single block (zero extra chat noise). When only user learning is pending, fires as a lightweight standalone block with 1-retry max (not 3). Guarded by `!waitingForUser` and `!userLearningObserved` to prevent re-triggering.
- **Added `isWaitingForUser(msg)` guard function** — Broader than `isHumanBlocker()`, detects when Claude is pausing for ANY user action: interactive flow phrases (`attach`, `upload`, `provide`, `select continue`, `when ready`, `let me know`) plus all existing login/CAPTCHA/2FA blocker phrases. Prevents soft obligations from interrupting Leonardo questionnaires and similar interactive flows.
- **Stop block verbose text includes full guardrails** — Category MUST be `communication-style` NOT `conversations`, NOT a session summary, GOOD/BAD examples, AVOID DUPLICATES warning, reflect-or-remember instructions.

### Changed — User Learning Test Suite Updated for Bundled Enforcement
- **Tests 3c/4 updated for 1-retry max** — User learning enforcement now gives up after 1 retry instead of 3 (`MAX_RETRIES`), minimizing chat panel clutter. Test 3c verifies stop allows after single retry; Test 4 verifies soft cleanup after 1 block.
- **Test 7 simplified — removed `userLearningBlockActive` concept** — The `blockActive` flag was expected by tests but never implemented in `post-remember.mjs`. Removed the assertion gap: any `reflect` call when `userLearningPending` is true now clears the pending flag (matching actual `post-remember.mjs` behavior).
- **Test 12 fixed for `EDIT_THRESHOLD=1`** — Pre-existing issue: test wrote `editCount: 1` expecting soft cleanup, but `EDIT_THRESHOLD` had been lowered to 1, triggering a task-memory block instead. Changed to `editCount: 0` so soft cleanup path is actually tested.
- **Test 14 rewritten for bundled obligations** — Previously expected separate sequential blocks (task memory then user learning). Now verifies both obligations appear in a single combined block reason with `Task memory` and `User learning` keywords.
- **All 72 tests pass** — `node hooks/claude-code/test-user-learning.mjs` exits clean.

### Changed — Claude Panel Session Button + Rename Icon Connected as Button Group
- **Joined session selector and rename icon** — `cp-session-btn` border-radius changed from `8px` to `8px 0 0 8px`, `cp-header-rename-btn` border-radius changed to `0 8px 8px 0` with `align-self: stretch` and a `1px` left border divider. The two elements now render as a single connected button group instead of separate floating controls in `ui-claude-panel.js`

### Fixed — Plan File Write Permission Loop in Onboarding
- **`ensureSynaBunPermissions()` now injects `Write(~/.claude/plans/*)` permission** — Writing custom-named plan files to `~/.claude/plans/` via the Write tool triggered repeated "sensitive file" permission prompts. Grants didn't survive context compaction, creating an infinite permission loop. Root cause: `~/.claude/plans/` is outside the session's working directories and `Write` had no pre-authorized permissions in `settings.json`. Auto-generated plan files (via `ExitPlanMode`) were unaffected because they bypass the Write tool entirely. `ensureSynaBunPermissions()` in `neural-interface/server.js` now dynamically resolves `$HOME` and adds `Write(${home}/.claude/plans/*)` to `permissions.allow` — idempotent with `includes()` check before adding

### Fixed — Plan Mode Stuck After ExitPlanMode Auto-Approve Race
- **`tab.planMode` not cleared on ExitPlanMode error** — In `updateToolResult()` in `ui-claude-panel.js`, `tab.planMode` was only set to `false` when ExitPlanMode succeeded (`!ev.is_error`). However, Claude Code in `--print` mode often auto-approves plans before the ExitPlanMode tool call completes, returning a `tool_use_error`. This left `tab.planMode = true`, causing all subsequent messages to get the `[PLAN MODE ...]` prefix (line ~4727) and every `done` event to render spurious "PLAN COMPLETE" post-plan action cards (line ~2984). Removed the `!ev.is_error` guard — `tab.planMode` is now always cleared when ExitPlanMode fires. Added `saveTabs()` call to persist immediately, preventing stale `planMode: true` from surviving page refresh. `renderPostPlanActions()` remains gated on `!ev.is_error` so the "PLAN COMPLETE" card only shows on genuine success

### Fixed — Attachment Overflow Breaking Sidepanel Layout
- **Send/mic buttons pushed off-screen with many attachments** — When multiple files or images were attached in the Claude sidepanel, `.cp-image-preview` grew unbounded, pushing `.cp-input-inner` (containing send/mic buttons) below the visible panel area. Root cause: `.cp-input-wrap` lacked `min-width: 0`, so the default flexbox `min-width: auto` prevented the flex item from shrinking below content size, bypassing `overflow-x: auto` on the child. Added `min-width: 0; overflow: hidden` to `.cp-input-wrap` and explicit `flex-wrap: nowrap` with thin scrollbar styling (`scrollbar-width: thin`, webkit overrides at 4px height) to `.cp-image-preview` in `ui-claude-panel.js`

### Changed — Leonardo Skill Free-Text Input & Prompt Display
- **Phase 1 (Vision) switched from `AskUserQuestion` to natural chat message** — Both `video-prompter.md` and `image-prompter.md` used `AskUserQuestion` for the initial concept description, which forced Claude to invent radio button presets instead of letting the user type freely. Replaced with plain text output so users describe their vision in their own words
- **Creative Brief (Phase 5.5/6.5) switched from `AskUserQuestion` to natural chat message** — Same issue as Phase 1. The detailed scene description phase now outputs a config summary as text and waits for the user's typed response instead of forcing preset options
- **Prompt Review now displays the engineered prompt before asking for approval** — The "Build the prompt" section said "show it to the user" but had no explicit display instruction, causing Claude to ask "How does this prompt look?" without showing the actual prompt. Added mandatory formatted code block display before the `AskUserQuestion` review step. Also fixed stale reference from "Phase 1" to `$CREATIVE_BRIEF` in both files

## 2026-03-26

### Fixed — Floating Browser Close Button Unresponsive After Session Reconnection
- **Close handler used object identity instead of ID lookup** — The close button handler in `detachTab()` (`ui-terminal.js`) used `_sessions.indexOf(session)` which checks object identity. When `_pushSession()` replaces a session object after reconnection (same ID, new object), the closure-captured `session` reference goes stale and `indexOf` returns `-1`, silently preventing close. Changed to `_sessions.findIndex(s => s.id === session.id)` for ID-based lookup.
  - Added fallback cleanup for orphaned floating windows — if the session is already gone from `_sessions`, the handler now removes the DOM element, cleans up `_detachedTabs`, and updates the tab bar directly
- **Pin button had same stale closure bug** — The pin handler directly mutated the closure-captured `session` object (`session.pinned = !session.pinned`). After reconnection, mutations went to the stale object while `_sessions` held the new one. Now re-finds the live session via `_sessions.find(s => s.id === session.id)` before mutating — matching the pattern already used by the rename handler.

### Fixed — Loop Detection Hijacking Non-Loop Sessions
- **SessionStart hook terminal isolation** — The loop detection logic in `session-start.mjs:209` had a guard `if (terminalSessionEnv && ...)` that short-circuited when `SYNABUN_TERMINAL_SESSION` was empty (all regular sessions), causing every active loop file to match every non-loop session. This suppressed greetings and recall boot sequences in normal sessions whenever an autonomous loop was running in another terminal. Removed the `terminalSessionEnv &&` guard so loops with a `terminalSessionId` only match sessions that share that exact terminal ID.

### Changed — Recall Token Estimation Accuracy in Settings UI
- **`/api/recall-impact` endpoint** — Enhanced to return `avg_tags_len` and `avg_files_len` per importance group from the `memories` table, plus `sessionStats` (count, `avg_summary_len`, `avg_details_len`) from the `session_chunks` table, giving the UI real data for accurate token estimation.
- **`updateImpactIndicator()` formula** — Rewrote the token estimation in `ui-settings.js` with per-component calculation: char-to-token ratio changed from `1:4` to `1:3.7`, metadata overhead now uses actual DB averages (tags, files) instead of a flat `+30`, session chunks are estimated from real `session_chunks` stats with a `0.6x` multiplier for `auto` mode, and a `15` token header is included.

### Fixed — Changelog "Edit first" Button Hanging in Claude Skin Panel
- **Dual render path mismatch** — `renderAskUserQuestion` (the `control_request` rendering path) had a generic click handler that immediately sent `"Edit first"` as a bare text answer via `sendAskAnswer()`, instead of opening the file editor. The changelog edit detection logic (`isChangelogAsk` pattern matching, `extractPlanText()`, `/api/create-plan` temp file creation, `open-changelog-editor` event emission) only existed in `buildAskFromToolUse` (the `tool_use` rendering path). Since the server's proactive `control_request` always arrives before the `assistant` event, `renderAskUserQuestion` rendered the visible ask card while `buildAskFromToolUse` returned a hidden placeholder — so the user always got the version without edit support. Replicated the full changelog edit handler into `renderAskUserQuestion`'s click handler in `ui-claude-panel.js`.

### Fixed — Edit Cancel Leaves Options Disabled in Plan and Changelog Flows
- **Closing editor without saving left buttons permanently disabled** — When the user clicked "Edit plan" or "Edit first" (changelog), the post-plan card or AskUserQuestion options were disabled while the editor opened. If the user closed the editor without saving, no event was emitted back to the Claude panel, leaving buttons stuck in their disabled state until page refresh. Added `plan-edit-cancelled` and `changelog-edit-cancelled` event emissions from `closeFileEditor()` in `ui-file-explorer.js` (before clearing edit mode flags), and corresponding listeners in `ui-claude-panel.js` that restore post-plan card interactivity or re-enable `.ask-option` buttons respectively. Safe because `saveFileEditor()` clears the flags before calling `closeFileEditor()`, so cancel events only fire on close-without-save.

## 2026-03-25

### Changed — Toolbar Modernization (Apple-style Unified Glass Bars)
- **Top-right navbar converted to unified frosted glass pill** — Replaced 4 separate `.bar-group` containers (each with own `background`, `border`, `border-radius: 10px`) with a single continuous pill bar on `.bar-right`: `background: rgba(18,18,22,0.65)`, `backdrop-filter: blur(24px) saturate(1.3)`, `border-radius: 14px`, inner highlight via `inset 0 0.5px 0 rgba(255,255,255,0.06)`. Groups inside are now transparent flex containers separated by `<span class="bar-divider">` elements (1px wide, 14px tall, `rgba(255,255,255,0.08)`).
- **Bottom-right toolbar converted to unified frosted dock bar** — `#topright-inner` now serves as the unified glass container (matching top bar treatment). Individual `.topright-icon-btn` buttons stripped of their per-button `background`, `border`, `backdrop-filter: blur(20px)` — now transparent icons inside the shared pill. Added `<span class="tr-divider">` elements between logical groups (workspace tools | panels | social | workspace selector). Claude panel and collapse buttons kept as standalone glass elements with matching frosted treatment.
- **Hover effects refined across both toolbars** — Replaced aggressive `scale(1.22)` on `.bar-icon:hover` with subtle `scale(1.08)` + `radial-gradient(circle, rgba(255,255,255,0.1))` glow. Added matching hover to `.topright-icon-btn` (previously only shifted background color). Both now use spring `cubic-bezier(0.34, 1.56, 0.64, 1)` for scale transforms. `:active` press state: `scale(0.94)` with 0.06s snap. SVG hover glow: `drop-shadow(0 0 4px rgba(255,255,255,0.2))`.
- **Active state indicator unified** — Both toolbars now show a 6px glowing blue dot under active icons: `width: 6px`, `height: 2.5px`, `border-radius: 2px`, `box-shadow: 0 0 6px var(--accent-blue)`. Top bar's previous 8px flat underline replaced.
- **SVG icons refined** — All icons reduced from `stroke-width: 1.8`/`2` to `1.7`. Removed decorative opacity fill layers from session monitor, gallery, tutorial, viz toggle, and fullscreen icons. Grid icon redesigned from crosshatch lines to 9-dot grid (3x3 `<circle>` elements). Tile icon corners rounded (`rx="2"`). Keybinds simplified from 8 dot-lines to 3 filled dots + spacebar line. Trash icon given inner vertical delete lines.
- **Workspace indicator adapted for unified bar** — Removed individual `backdrop-filter: blur(20px)` and `background: rgba(20,20,24,0.7)` from `#ws-indicator` — now uses subtle `rgba(255,255,255,0.04)` background inside the shared pill.

### Fixed — Dropdown Menus Hidden Behind Minimized Terminal Tray Pills
- **Stacking context trap from `backdrop-filter`** — The workspace, bookmarks, and invite dropdowns rendered behind minimized terminal session pills (e.g. browser tabs). Root cause: `#topright-inner`'s `backdrop-filter: blur(24px)` creates a CSS stacking context, trapping child dropdown `z-index` values. The `#term-minimized-tray` sits outside `#topright-inner` at the `#topright-controls` level, so it painted above regardless of dropdown z-index. Fixed by: (1) adding `#topright-controls:has(#ws-indicator.open) #term-minimized-tray { display: none }` to hide the tray when workspace dropdown is open, (2) bumping all three dropdowns (`#ws-dropdown`, `#bookmarks-dropdown`, `#invite-dropdown`) to `z-index: 100001` and `top: calc(100% + 12px)` for better spacing.

### Changed — Recall Settings Redesign (Settings > Recall Tab)
- **Recall Profiles replace Token Budget** — Replaced the basic "Recall Token Budget" system (3 presets controlling only character truncation + a slider) with a comprehensive 4-profile system: Quick (3 results, importance 5+, tight matching), Balanced (5 results, standard), Deep (10 results, sessions always included, loose matching), and Custom (opens all individual controls). Profile selection auto-configures all parameters; manually adjusting any control auto-switches to Custom.
- **Fine-Tune Controls section** — Added collapsible `Fine-Tune Controls` with 6 individual parameters: Results per recall (slider 1-20), Minimum importance (slider 0-10 with semantic labels), Similarity threshold (slider 0.10-0.80), Content length (slider 100-2100+), Session context (segmented toggle: Never/Auto/Always), and Recency boost (toggle switch). Auto-opens when Custom profile is selected.
- **Impact Indicator** — Added 3-stat bar showing estimated tokens per recall, memories reachable at current importance threshold, and session context status. Fetches data from new `GET /api/recall-impact` endpoint that returns per-importance memory counts and average content lengths.
- **Backend: Configurable recall defaults** — Replaced `getRecallMaxChars()` in `recall.ts` with `getRecallDefaults()` that reads a full `recallDefaults` object from `display-settings.json` (limit, minImportance, minScore, maxChars, includeSessions, recencyBoost). `handleRecall()` now uses these as defaults when the AI calls `recall` without explicit parameters. Backward-compatible with legacy `recallMaxChars` field.
- **Display settings schema expanded** — `display-settings.json` upgraded from `{ recallMaxChars: 0 }` to `{ recallDefaults: { limit, minImportance, minScore, maxChars, includeSessions, recencyBoost }, profile: "quick|balanced|deep|custom" }`.
- **CSS overhaul** — Replaced all old recall preset/preview/tips styles (`.recall-preview-box`, `.recall-tips`, `.recall-tip-tag`) with purpose-built styles: `.recall-profile-card` with per-profile color theming, `.recall-impact` stat bar, `.recall-segmented` toggle buttons, `.recall-toggle` switch, and `.recall-control-*` form elements.

### Added — Edit Plan in Code Editor
- **Direct plan editing via SynaBun code editor** — Clicking "Edit plan" on the post-plan action card now opens the plan MD file directly in the Neural Interface file editor instead of re-entering plan mode for chat-based edits. Uses cross-module event bus (`emit`/`on` from `state.js`) with two new events: `'open-plan-editor'` and `'plan-saved'`.
  - `buildTool()` in `ui-claude-panel.js` now accepts a `tab` parameter and stores `tab.planFilePath` when Claude writes a plan file
  - `ui-file-explorer.js` listens for `'open-plan-editor'`, opens the editor with a green accent banner ("Editing plan — save to send to Claude"), and tracks plan edit state via `_planEditMode`/`_planEditFilePath`
  - On save, the editor emits `'plan-saved'` with the full updated content, auto-closes, and the Claude panel receives the event, clears the post-plan card, exits plan mode, and auto-sends the updated plan to Claude for immediate pickup
  - Falls back to a status message if no `tab.planFilePath` exists (e.g., plan created in a prior session)

### Fixed — Terminal Context Menu Z-Index Layering
- **Context menu rendered behind terminal panel** — The right-click context menu (`#term-context-menu`) had a static `z-index: 10100`, but `_floatZCounter` in `ui-terminal.js` starts at `10000` and increments on every terminal mousedown/focus event. After ~101 interactions the terminal panel's inline z-index surpassed the menu's. Bumped `#term-context-menu` from `z-index: 10100` to `100003` in `styles.css` — safely above all terminal-layer elements including the float color picker (`100002`) and profile flyout (`100001`).

### Changed — Terminal Context Menu Viewport Clamping
- **Context menu no longer opens outside screen bounds** — Added viewport boundary clamping to `initContextMenu()` in `ui-terminal.js`. The menu is first made visible at `(0, 0)` to measure its `getBoundingClientRect()`, then repositioned at the cursor with edge guards: flips above the cursor when too close to the bottom, shifts left when too close to the right edge, and clamps negative coordinates to a `4px` margin.

## 2026-03-24

### Fixed — Terminal Loop Time Cap & Iteration Cap Silently Clamped Too Low
- **`maxMinutes` hard-capped at 60 despite UI allowing 120+** — The `/api/loop/launch` endpoint in `server.js` clamped `maxMinutes` with `Math.min(..., 60)`, silently truncating any value above 60 minutes. The stop hook reads `maxMinutes` from the loop state file to enforce the time cap, so loops died after ~50-55 minutes regardless of template or UI settings. The March 12 fix ("MAX_MINUTES 60→480") only updated the agent endpoint (`/api/agents/launch`), not the terminal loop endpoint. Raised cap from 60 to 480 in both `/api/loop/launch` and `launchScheduledLoop()`.
- **`totalIterations` capped at 50** — Same endpoint clamped iterations with `Math.min(..., 50)`. Raised to 200 to match the agent endpoint.
- **UI sliders didn't match server caps** — Template editor time cap slider had `max="120"`, wizard had `max="60"`, iterations slider had `max="50"`. Updated all three to 480/480/200 respectively in `ui-automation-studio.js`.

### Fixed — Code Editor Line Highlight Misaligned with Text and Gutter
- **Highlight band drifted from text lines on scroll** — The editor's `line-height: 1.65` at `font-size: 12px` produced `19.8px` — a non-integer that caused cumulative sub-pixel rounding drift between the highlight band, gutter line numbers, and textarea text content. After ~15 lines the highlight visibly straddled two lines instead of covering one. Changed all editor line-height values from `1.65` to explicit `20px` across 5 CSS rules (`.fe-editor-gutter`, `.fe-editor-gutter div`, `.fe-editor-highlight`, `.fe-editor-textarea`, `.fe-editor-line-highlight`) and 4 JS constants (`SH_LINE_H`, `lineH`, two `lineHeight` locals) in `ui-file-explorer.js`.

### Fixed — Sidepanel Attach Button Rejected Image Files
- **Attach button only accepted text/code files** — The paperclip attach button's `fileInput` change handler in `ui-claude-panel.js` ran every selected file through `_isTextFile()`, which checks against `_TEXT_EXTENSIONS`. Image files (`.png`, `.jpg`, `.gif`, etc.) failed this check and were skipped with "only text/code files supported". Images could only be attached via paste (Cmd+V) or drag-and-drop, but not the attach button itself. Added an image detection branch (`file.type.startsWith('image/')`) before the text file check that routes images through the same `FileReader → base64 → attachedImages` pipeline used by paste and drop handlers. Also added an `accept` attribute to the file input (`image/*,text/*,.js,.ts,...`) so the OS file picker shows images alongside code files.

### Changed — Offline Page Restyled to Transparent Layout
- **Removed card container background and border** — The "Server is sleeping" offline page (`offline.html`) previously rendered all content inside a dark card with `background: rgba(28,28,30,0.85)` and a subtle border. Removed both — `.card` is now fully transparent with no border, so the sleeping mascot, floating Z's, heading text, and command block float directly against the `#030305` body background.
- **Command block made transparent** — `.cmd-block` background and border removed, padding adjusted from `14px 16px` to `14px 0`, added `justify-content: center` so the command text and copy button sit centered without a visible container.
- **Copy button made subtler** — `.copy-btn` background changed from `rgba(255,255,255,0.06)` to transparent, border and text color dimmed to `0.08`/`0.35` opacity respectively, hover states softened to match the containerless aesthetic.

### Added — Notifications Settings Tab
- **Dedicated Notifications tab in Settings** — Moved the single notification toggle out of the Terminal tab into a proper "Notifications" tab under the System group in the settings sidebar. Bell icon, placed between Terminal and Browser.
- **Master toggle** — Enable/disable all notifications with a single switch. Sub-sections dim and become non-interactive when disabled.
- **System Permission status** — Shows current `Notification.permission` state with color-coded dot (green/red/grey), "Request Permission" button when `default`, and guidance when `denied`.
- **Sound controls** — Toggle for sound on/off, volume slider (0–100%) with live percentage label, and "Test Sound" button that plays the action-required double beep at the configured volume.
- **Banner controls** — Toggle for OS notification banners (shown only when app is not focused).
- **Trigger filter** — "Action only" toggle to suppress "Task Complete" notifications and only fire on "Action Required" (permission prompts).
- **Test Notification button** — Fires a real service worker notification to verify the full pipeline works end-to-end.
- **New storage keys** — `NOTIF_SOUND`, `NOTIF_SOUND_VOLUME`, `NOTIF_BANNER`, `NOTIF_ACTION_ONLY` in `constants.js`
- **Notification engine updated** — `_notifyStatusChange()` in `ui-terminal.js` now reads all granular settings: sound toggle, volume, banner toggle, and action-only filter.

### Fixed — Notifications Not Working in Safari PWA
- **Service worker notification routing** — Safari PWAs ignore the basic `new Notification()` API. Replaced direct `Notification` constructor in `ui-terminal.js` with `serviceWorker.postMessage()` → `registration.showNotification()` flow. Added `SHOW_NOTIFICATION` message listener and `notificationclick` handler to `sw.js`. Bumped service worker cache version from `v6` to `v7` to force update.

### Changed — Floating Window Border Visibility
- **Thin visible border on all floating windows** — The `.glass` base class used `--glass-border-opacity: 0.06` (6% white), making window edges nearly invisible against the background. Added `border: 1px solid rgba(255,255,255,0.12)` to all 8 floating window types (`.settings-panel`, `.skills-studio-panel`, `.automation-studio-panel`, `.session-monitor-panel`, `.command-runner-panel`, `.image-gallery-panel`, `.detail-card`, `.tw`). Also added an override rule so borders persist when `body.explorer-open` is active (which normally sets `border-color: transparent` on all `.glass` elements).

## 2026-03-23

### Added — Multi-Browser Session Isolation for Concurrent Automations
- **Dedicated browser session per automation** — Rewrote the loop launch browser acquisition in `server.js` `/api/loop/launch` with a 3-strategy approach: (1) accept a pre-created `browserSessionId` from the UI request body, (2) wait for only NEW sessions created after launch (tracks `preExistingIds` Set to avoid stealing other automations' sessions), (3) fall back to creating a dedicated session server-side via `createBrowserSession()`. Previously, loop launch grabbed `existingIds[0]` — the first available session regardless of ownership — causing concurrent automations to fight over the same browser.
- **Environment-based session pinning for loops** — Extended `createTerminalSession()` in `server.js` to accept `opts.extraEnv`, merged into the PTY spawn env. Loop launch passes `{ SYNABUN_BROWSER_SESSION: browserSessionId }` so the MCP's `resolveSession()` in `neural-interface.ts` auto-resolves to the correct session. Chain: PTY → shell → Claude Code → MCP server (inherits parent env). Agents already had this via `buildAgentMcpConfig()` + `--mcp-config`; loops did not.
- **UI always creates new sessions** — Rewrote `confirmLaunch()` in `ui-automation-studio.js` to always create a new browser session per launch, removing the `hasBrowser` check that skipped creation when any session existed. The new `dedicatedBrowserSessionId` is captured from `createBrowserSession()` (side panel) or `sync:browser:created` event (floating), then passed to `/api/loop/launch` as `browserSessionId` in the request body.
- **Prompt-level session ID injection** — Updated `buildBrowserNote()` in `prompt-submit.mjs` to include `state.browserSessionId` in the browser enforcement block, instructing Claude to pass `sessionId` to all browser tool calls. Acts as a fallback if environment propagation doesn't reach the MCP process.
- **Scheduled loop support** — Updated `launchScheduledLoop()` in `server.js` to create dedicated browser sessions for `usesBrowser` schedules, with env pinning via `createTerminalSession()`'s new `extraEnv` option.
- **Browser cleanup on loop stop** — `POST /api/loop/stop` now calls `destroyBrowserSession()` for each stopped loop's `browserSessionId`, preventing orphaned browser processes.

### Added — Floating Move Handle for Whiteboard Text & List Elements
- **Move handle on selected text/list elements** — New floating move icon (4-directional arrow SVG) appears on the left side of text and list elements when selected, mirroring the rotate handle on the right. Implemented as `_moveEl` in `ui-whiteboard.js` alongside existing `_rotateEl`, created in `showContextMenu()` only for `el.type === 'text' || 'list'`. The handle initiates a standard `type: 'move'` drag on mousedown, calls `exitEditMode()` and `exitListEditMode()` before starting to save content, and is cleaned up in `hideContextMenu()`. Added to `onMouseDown()` skip list (`.wb-move-float`) to prevent canvas interference.
- **Accurate positioning for auto-sized elements** — Enhanced `positionContextMenu()` to read actual DOM dimensions (`offsetWidth`/`offsetHeight`) for text/list elements that auto-size (stored `width=0`), ensuring the move handle, rotate handle, and context menu are positioned correctly. Added `leftX` variable to the bounds calculation.
- **CSS styling** — `.wb-move-float` in `styles.css` matches `.wb-rotate-float` styling: 32px glass circle, backdrop blur, hover scale animation, grab/grabbing cursors.

### Changed — Automation Studio Launch Flow (Inline Panel)
- **Replaced overlay launch modal with inline launch panel** — The launch configuration (Mode/CLI/Model selection) previously spawned a full-screen backdrop modal (`showLaunchDialog()`) that covered the entire workspace. Now renders directly inside the detail view's `.as-detail-content` area via `showLaunchInline()`, keeping the user in context. Back button or Escape restores the editor. For non-detail contexts (wizard launch), a standalone contained panel renders in the main area via `.as-launch-standalone`.
  - Removed `showLaunchDialog()`, `closeLaunchDialog()`, `wireLaunchDialog()` — replaced by `showLaunchInline()`, `closeLaunchInline()`, `wireLaunchInline()`
  - Action names changed from `launch-dialog-close/confirm` to `launch-inline-close/confirm`
  - New CSS: `.as-launch-inline`, `.as-launch-inline-header/body/footer`, `.as-launch-standalone` with slide-up entrance animation
  - Removed overlay CSS: `.as-launch-dialog`, `.as-launch-dialog-inner`, `.as-launch-dialog-header/body/footer`
  - Updated responsive breakpoints from dialog classes to inline panel classes
  - Fixed wizard launch path to not override `_view` after showing inline panel

### Fixed — Automation Studio Panel Stays Open After Launching Automation
- **Panel not dismissed on launch** — The Automation Studio window remained open after successfully launching an automation (both agent and loop modes), leaving a stale overlay on screen. Added `closePanel()` calls in `confirmLaunch()` in `ui-automation-studio.js` after both successful launch paths: agent mode (after "Agent launched" toast) and loop mode (after "Loop started" toast). The agent path also had unnecessary post-launch view switching (`_view = 'running'`, `renderView()`, `refreshAgents()`) that was removed since the panel now closes entirely.

### Changed — Container Spacing Alignment for Side Panel & Workspace Toolbar
- **Top gap now matches right margin** — The Claude panel (`.claude-panel` in `ui-claude-panel.js`) and workspace toolbar (`#topright-controls` in `styles.css`) both used `top: 64px`, leaving only ~12px between the title bar bottom and the panel/toolbar top. Changed both to `top: 68px` so the top gap (~16px) matches the panel's `right: 16px` margin from the screen edge, creating uniform spacing around the floating UI elements.

### Fixed — Multi-Loop Isolation (Cross-Session Iteration Leaks)
- **Iterations leaking between concurrent automations** — When two or more automations were launched simultaneously from the Automation Studio, loop iterations would cross-contaminate: the stop hook couldn't find its loop file after `/clear` (which changes the Claude session ID), and fallback scans would grab the first active loop regardless of ownership. Root cause: no stable identifier survived the `/clear` boundary to tie a Claude session to its loop file.
  - Added `SYNABUN_TERMINAL_SESSION` env var to PTY environment at loop launch (`server.js` `/api/loop/launch`), pre-generating the terminal session ID via `randomBytes()` and passing it via `extraEnv` + `opts.sessionId` in `createTerminalSession()`
  - `stop.mjs` — `hasActiveLoop` pre-check now scoped to own terminal; fallback scan uses Strategy A (env-based `terminalSessionId` match, safe for any iteration) or Strategy B (legacy: unclaimed iteration-0 loops only)
  - `prompt-submit.mjs` — Pending loop claim now filters by `terminalSessionId` instead of blindly taking `pending[0]`; subsequent iteration fallback scan filters by `terminalSessionId`
  - `session-start.mjs` — `isLoopSession` detection scoped to own terminal's loop only
  - `mcp-server/src/tools/loop.ts` — `resolveSessionId()` checks `SYNABUN_TERMINAL_SESSION` env before falling back to blind directory scan

## 2026-03-22

### Fixed — AskUserQuestion Interactive Cards Never Rendering in Sidepanel
- **Proactive detection in `assistant` event handler** — AskUserQuestion tool calls were never rendered as interactive ask cards in the Claude Code sidepanel skin. The `permission_denial` → `control_request` path existed but wasn't being triggered reliably. Added server-side detection in the `assistant` event handler's `tool_use` iteration loop (`server.js` ~line 2422) that intercepts `AskUserQuestion` before the `GATED_TOOLS` check, immediately sending a `control_request` to the client. The client's existing `renderAskUserQuestion()` handles the rest — rendering clickable option buttons instead of plain markdown text.
- **`--allowedTools` caused CLI hang, not permission denial** — An earlier attempt added `AskUserQuestion` to the `--allowedTools` flag, which told the CLI to EXECUTE the tool (blocking on stdin in `--print` mode) instead of DENYING it. This caused a 5-minute hang requiring abort. Reverted entirely — the CLI naturally denies `AskUserQuestion` in `--print` mode, which is the desired behavior triggering the `permission_denial` → `control_request` → ask card flow.

### Fixed — `--allowedTools` Join Character Unsafe on Windows
- **Space-joined tool list broke on `shell: true`** — The `--allowedTools` argument joined approved tool names with spaces, which could cause argument splitting when spawned with `shell: true` on Windows (`cmd.exe /c`). Changed join character from space to comma (`[...approvedTools].join(',')`) in `server.js` ~line 2220. Comma is safe across all platforms.

### Added — Multi-Tab Browser Architecture
- **Tab-per-session data model** — Extended `createBrowserSession()` in `server.js` with a `tabs` Map keyed by `tabId` (random 4-byte hex). Each tab stores its own `page`, `cdpSession`, `url`, and `title`. `session.page` and `session.cdpSession` remain as aliases to the active tab, preserving backward compatibility with all existing MCP tools and REST endpoints.
- **`createSessionTab(session, sessionId, url)`** — Opens a new page in the existing browser context, creates a CDP session, wires `framenavigated`/`load`/`close` events via `wireTabPageEvents()`, and broadcasts `browser:tab-created` over WebSocket.
- **`_switchSessionTab(session, sessionId, tabId)`** — Stops screencast on the old tab's CDP session, updates `session.page`/`session.cdpSession`/`session.activeTabId` aliases, starts screencast on the new tab, and broadcasts `browser:tab-switched`.
- **`closeSessionTab(session, sessionId, tabId)`** — Closes the page, switches to another tab if the closed tab was active, destroys the entire session if it was the last tab. Broadcasts `browser:tab-closed`.
- **4 REST endpoints** — `GET /api/browser/sessions/:id/tabs` (list tabs), `POST /api/browser/sessions/:id/tabs` (create tab with URL), `POST /api/browser/sessions/:id/tabs/:tabId/activate` (switch active tab), `DELETE /api/browser/sessions/:id/tabs/:tabId` (close tab).
- **3 WebSocket message types** — `switch-tab`, `new-tab`, `close-tab` inbound messages handled in `handleBrowserWebSocket()`. `browser:tab-created`, `browser:tab-switched`, `browser:tab-closed` outbound events routed through `ui-sync.js` to frontend.

### Added — Automation Studio Launch Destination Prompt
- **"Run in" toggle** — New destination toggle in the Automation Studio launch dialog between Mode and CLI sections, with "Floating" and "Side Panel" buttons (`.as-launch-destination` class). Selection persisted via `storage.getItem/setItem('as-launch-destination')`.
- **Side Panel routing** — When destination is `sidepanel`, `confirmLaunch()` emits `claude-panel:ensure-open` → 300ms delay → `terminal:attach-floating` with `snapToPanel: true` → `claude-panel:show-browser`. Terminal snaps adjacent to the Claude panel using `--claude-panel-width` CSS variable. Browser embeds in the panel's existing browser embed area.
- **Floating (CLI) routing** — Existing flow unchanged — floating terminal + floating browser as before.
- **Responsive styles** — `.as-launch-destination` button styles matching `.as-launch-mode` pattern, with compact variant in mobile breakpoint (`styles.css`).

### Fixed — Browser Not Appearing After Loop Close and Relaunch
- **Zombie session detection in loop launch** — Loop launch's browser reuse poll in `server.js` now runs `page.evaluate('1')` liveness probe on candidate sessions before reusing. Dead/zombie sessions are destroyed and skipped, allowing a fresh session to be created instead of silently binding to a dead browser.
- **WebSocket reconnect-once pattern** — `openBrowserSession()` and `reconnectBrowserSession()` in `ui-terminal.js` now attempt one automatic reconnection on WebSocket close (1.5s delay) before giving up. Prevents transient connection drops from killing the browser view. Uses `_wsReconnectAttempted` flag to prevent infinite retry loops.
- **`_opening` guard unstick** — Reduced the `_opening` flag timeout from 15s to 10s in `ui-terminal.js`, preventing the guard from permanently blocking new browser sessions when a previous open attempt failed silently.
- **`sync:browser:created` race resolution** — Terminal's `sync:browser:created` handler now gives the Claude panel 2 seconds to claim the browser embed before taking over. Checks `#cp-browser-embed.active` after the delay — if the panel already embedded it, terminal skips. Prevents both panel and terminal from fighting over the same browser session.
- **Claude panel loop detection** — Panel's `sync:browser:created` handler replaced unreachable `msg.source === 'loop'` check with a fetch to `/api/loop/active` to detect active loops when Claude isn't actively processing (`ui-claude-panel.js`).

### Changed — Multi-Loop Coexistence
- **Stale-only loop cleanup** — Loop launch in `server.js` no longer kills all active loops before starting a new one. Instead, only cleans up loop state files whose associated terminal sessions are dead (`terminalSessions.has()` check). Active concurrent loops with live terminals are preserved.
- **`/api/loop/active` returns all loops** — Endpoint now returns a `loops` array containing all active loop sessions. First loop populates top-level fields for backward compatibility. Consumers can iterate `loops` to see all concurrent loop states.
- **Per-loop browser tabs** — Each new loop creates a new tab in the shared browser session via `createSessionTab()` instead of hijacking the current page. Loop state stores `browserTabId` for per-loop tab tracking.

### Added — LinkedIn Jobs Browser Extractor
- **`browser_extract_li_jobs` MCP tool** — New browser extraction tool (tool #39) that extracts structured job listing data from LinkedIn. Handles two page types: search results (`/jobs/search/?keywords=QUERY&location=LOC`) using `[data-occludable-job-id]` card containers, and homepage recommendations (`/jobs/`) using `main a[href*="/jobs/collections/"]` link cards. Extracts 11 fields per job: `jobId`, `title`, `company`, `companyUrl`, `location`, `salary`, `jobUrl`, `logo`, `promoted`, `easyApply`, `postedDate`.
  - Search path: reads `span[aria-hidden="true"]` inside title link for clean title (avoids duplication with visually-hidden screen-reader span), `.artdeco-entity-lockup__subtitle` for company, `.artdeco-entity-lockup__caption` for location
  - Homepage path: parses `<p>` elements sequentially, strips `(Vaga verificada)` / `(Verified listing)` suffix from titles, extracts posted dates from `Anunciada há` / `Posted` patterns
  - Salary regex handles `R$`, `US$`, `$` with `por hr`/`mês`/`per month`/`yr` suffixes and ranges
  - De-duplicates via `seen` Set on `jobId`; homepage fallback only runs when search cards count is 0
  - Files: `mcp-server/src/tools/browser-observe.ts` (extractor script + schema + handler), `mcp-server/src/tools/browser.ts` (import + registration), `mcp-server/src/index.ts` (server instructions)

### Changed — Window Close Behavior (ESC / Close Button Only)
- **Disabled outside-click closing on all windows** — All modal windows (Automation Studio, Skills Studio, Settings, Keybinds, Session Monitor, Image Gallery, Help, Terminal dir picker) no longer close when clicking the backdrop overlay. Removed 12 `backdrop.addEventListener('click', ...)` handlers across 8 files. Windows now close exclusively via ESC key or the close button, preventing accidental dismissal during work.
- **Added ESC key handlers where missing** — `ui-settings.js` (`onSettingsEsc` with cleanup in `close()`), `ui-sessions.js` (`onEsc` in `openPanel()`), `ui-help.js` (global listener checking `overlay.open`), `ui-image-gallery.js` (extended `handleKey()` to close panel on ESC, not just lightbox), and `ui-terminal.js` (`onPickerEsc` for dir picker modal with cleanup) now all respond to ESC for closing.

### Added — Backdrop Toggle Button on All Windows
- **Eye icon toggle in every window header** — New `.backdrop-toggle-btn` button (eye SVG icon, 28x28) placed before the close button in all window headers. Clicking smoothly fades the backdrop overlay in/out. Button highlights with `.active` state when backdrop is hidden. IDs: `#as-backdrop-toggle`, `#ss-backdrop-toggle`, `#stg-backdrop-toggle`, `#sm-backdrop-toggle`, `#ig-backdrop-toggle`, `#kb-backdrop-toggle`, `#help-backdrop-toggle`.
- **Shared CSS classes** — `.backdrop-toggle-btn` styling (matches existing focus-btn pattern) and `.backdrop-hidden` modifier for all backdrop types (`studio-backdrop`, `kb-backdrop`, `sm-backdrop`, `ig-backdrop`) using `opacity: 0 + pointer-events: none`. Help overlay uses `background: transparent` + `backdrop-filter: none` with 0.25s transition since it's display-toggled rather than opacity-toggled.

### Added — Automation Studio Icon Picker Expansion (13 Icons)
- **Social media icons** — Added 8 platform-specific fill-based SVGs to `AS_ICONS` in `ui-automation-studio.js`: `x` (X/Twitter rebrand logo), `instagram` (rounded square + camera), `facebook` (F logo), `linkedin` (in logo), `tiktok` (musical note), `youtube` (play button), `whatsapp` (phone in speech bubble), `discord` (controller face). All use 16x16 viewBox with `fill="currentColor"`. Original stroke-based `twitter` bird icon preserved alongside `x`.
- **AI platform logos** — Added `claude`, `openai`, `gemini` as inlined fill-based SVGs with 24x24 viewBox, sourced from `public/category-logos/` directory files.
- **Leonardo and pin icons** — `leonardo` uses `<img src="/leonardoai.svg">` reference (SVG too large to inline — contains embedded base64 bitmap data). `pin` uses existing `_s()` stroke helper with simplified pushpin path.
- **Section organization** — Reorganized `AS_ICONS` object with comment headers: Social media icons, General purpose icons, External SVG logos, UI chrome. All 13 new icons automatically included in `ICON_KEYS` and appear in the icon picker dropdown.

### Fixed — Automation Studio Sidebar Scroll Position Reset
- **Scroll jumping to top on item click** — Clicking a template in the left sidebar triggered `switchToDetail()` → `renderView()` → `renderSidebar()`, which replaced the entire `list.innerHTML`, destroying all DOM nodes and resetting scroll position to the top. Fixed by saving `list.scrollTop` before the innerHTML replacement and restoring it immediately after in `renderSidebar()` (~line 1518 of `ui-automation-studio.js`).

### Changed — Leonardo.ai Converted to 100% Browser-Based
- **Removed all API-based tools and code** — Deleted 5 API source files (`leonardo-api.ts`, `leonardo-image-tools.ts`, `leonardo-video-tools.ts`, `leonardo-utility-tools.ts`, `leonardo-constants.ts`) and all corresponding `dist/` output. The integration no longer requires `LEONARDO_API_KEY` or any API credentials. Tool count reduced from 14 API tools to 4 browser tools.
- **Rewrote `leonardo-browser-tools.ts` as primary** — Removed "fallback" framing. 4 tools: `leonardo_browser_navigate` (8 page destinations incl. new `flow-state`), `leonardo_browser_generate` (fill prompt + click Generate — expects settings pre-configured via generic browser tools), `leonardo_browser_library` (view/search personal library), `leonardo_browser_download` (screenshot results). Updated descriptions to instruct Claude to configure all UI settings BEFORE calling generate.
- **Updated `leonardo.ts` barrel and `index.ts` registration** — Barrel file imports only browser tools. `index.ts` tool listing reduced to 4 browser tools. Server instructions changed from API key requirement to browser-based workflow guidance referencing `/leonardo` skill.
- **Rewrote `/leonardo` skill (`SKILL.md`)** — Removed API key prerequisite. Added browser tool listing with "Critical workflow" note. Step 3 Execute now follows: navigate → snapshot → configure UI settings → summary → generate → monitor. Added `browser-guide.md` module read in configuration step. Expanded follow-up actions with Download option.
- **New `browser-guide.md` — complete Leonardo.ai UI map** — Comprehensive reference created through live browser research. IMAGE PAGE: 18 models (capabilities table), 8 style presets, dimension presets + custom social/device presets, Add Elements, prompt field. VIDEO PAGE: 23 models (capabilities table), 39 Motion Controls (Camera/Zoom/FX categories), 27 Motion Elements (creative overlays), 3-layer Style Stacking (9 Vibe + 16 Lighting + 14 Color Theme options), Prompt Enhance, Generation Mode, dimensions, advanced settings. Includes React element click workarounds (`evaluate()` patterns) and error recovery instructions.
- **Expanded `video-prompter.md` to 7-phase questionnaire** — Added Phase 3 (Motion Control — 39 options with curated recommendations), Phase 4 (Motion Elements — 27 overlays grouped by aesthetic), Phase 5 (Style Stacking — Vibe/Lighting/Color with 10 recommended combo table). All three new phases gated to Motion 2.0/Fast models only.
- **Expanded `image-prompter.md` to 6-phase questionnaire** — Added Phase 3 (Style Preset — 8 options with auto-recommendation by category), expanded Phase 4 (Dimensions — added custom social/device presets), refined Phase 6 prompt engineering with 3 example transformations and negative prompt templates.
- **Updated `model-advisor.md` with all 2026 models** — Image models decision matrix (13 use cases), video models decision matrix (13 use cases), video model capabilities table (23 models × 8 columns), cost optimization tips.
- **Updated `style-guide.md` with full option set** — 8 image style presets with usage guidance, 9 Vibe options, 16 Lighting options (11 new), 14 Color Theme options (9 new), 15 recommended style combos table, 39 motion controls with cinematic language descriptions, 27 motion elements with aesthetic descriptions.
- **Updated `prompt-library.md` with curated templates** — 5 video categories (Cinematic, Product, Nature, Abstract, Social Media) with 2 templates each, 5 image categories (Portrait, Landscape, Product, Logo, Illustration) with 2 templates each, 4 negative prompt templates by content type.

## 2026-03-21

### Fixed — Context Gauge Tooltip Positioning and Overflow Clipping
- **Tooltip clipped by panel overflow** — The `.cp-gauge-tip` tooltip used `position: absolute` inside `.cp-gauge-section`, but the parent `.claude-panel` has `overflow: hidden`, causing tooltips to get cut off — especially on the left edge. Switched to `position: fixed` with JS-calculated coordinates on `mouseenter` (centered above the hovered section via `getBoundingClientRect()`), so the tooltip escapes the clipping container entirely. Set `z-index: 999999` to render above all UI layers in `neural-interface/public/shared/ui-claude-panel.js`.

### Fixed — Browser Not Re-launching After First Use
- **Stale tab reuse blocked new browser sessions** — `openBrowserSession()` in `ui-terminal.js` checked for an existing browser tab DOM element and switched to it without verifying the underlying WebSocket was still open. Now validates `ws.readyState === WebSocket.OPEN` before reusing; if the session is dead, cleans up via `closeSession()` and falls through to create a fresh browser.
- **Zombie sessions accepted WebSocket reconnections** — `handleBrowserWebSocket()` in `server.js` allowed new WebSocket clients to connect to sessions where the browser page had already exited. Added a `session.page.evaluate('1')` liveness probe on connect — if the page is dead, the zombie session is destroyed and the client receives an error, prompting fresh session creation.
- **Race condition in session Map cleanup** — `destroyBrowserSession()` in `server.js` removed the session from `browserSessions` Map at the end of the function, after async cleanup. Moved `browserSessions.delete(sessionId)` to the top (immediately after fetching the session object) to prevent concurrent requests from seeing zombie entries during the teardown window.

## 2026-03-20

### Added — Image Gallery App
- **Floating image browser for `data/images/`** — New `ui-image-gallery.js` module (~330 lines) implementing a draggable/resizable panel following the Session Monitor window pattern. Toolbar includes debounced search input, type filter dropdown (All/Screenshots/Attachments/Whiteboard/Pastes), sort dropdown (Newest/Oldest/Name/Size), and favorites-only toggle. Thumbnails render in a CSS grid (`auto-fill, minmax(150px, 1fr)`) with 4:3 aspect ratio and `object-fit: cover`.
  - **Card overlay actions** — Hover reveals action buttons (favorite, add to whiteboard, download, delete) with styled `data-tooltip` tooltips on each button.
  - **Full lightbox** — Click any thumbnail to open a full-screen lightbox with keyboard navigation (arrow keys, Escape), prev/next buttons, and a bottom bar with favorite/whiteboard/download/delete actions.
  - **Add to Whiteboard integration** — New exported `addImageToWhiteboard(url)` in `ui-whiteboard.js` fetches image, converts to dataUrl via canvas, and places as a whiteboard element centered in the viewport (max 400px wide, preserves aspect ratio). Available from both card overlay and lightbox.
  - **Server API** — 4 REST endpoints in `server.js`: `GET /api/images` (list with metadata + type detection from filename prefix), `GET /api/images/file/:filename` (serve file), `POST /api/images/favorite` (toggle), `DELETE /api/images/:filename` (remove + cleanup favorites).
  - **Favorites persistence** — `data/image-favorites.json` stores favorited filenames. 24h startup cleanup sweep now skips favorited images.
  - **API client** — `fetchImages()`, `toggleImageFavorite()`, `deleteImage()` in `api.js`.
  - **Navbar button** — Gallery icon in `bar-right` between Session Monitor and Cost Tracker in `html-shell.js`, wired in `ui-navbar.js` with `image-gallery:closed` event sync and `registerAction('toggle-image-gallery')` keybind. Imported and initialized in both `2d/main.js` and `3d/main.js`.

### Fixed — Tooltip Z-Index Below Floating Panels
- **Tooltips invisible on gallery/lightbox/session-monitor overlays** — The `.ui-tooltip` had `z-index: 99999` but floating panels use `z-index: 300000` and the lightbox uses `400000`, causing `data-tooltip` styled tooltips to render behind these overlays. Bumped `.ui-tooltip` z-index to `500000` in `styles.css` so tooltips always render above all overlay layers.

### Fixed — Whiteboard Context Menu Hidden Behind Neighboring Images
- **Context menu and rotate handle rendered behind overlapping images** — The `.wb-ctx-menu` had a static CSS `z-index: 15` and `.wb-rotate-float` had `z-index: 20`, but whiteboard element z-indices increment indefinitely via `_nextZIndex++`. Once the board had more than ~15 elements, the toolbar (send-to-terminal, duplicate, copy, delete buttons) and rotate handle would render behind neighboring images, appearing cropped or fully hidden. Fixed by dynamically setting `style.zIndex = _nextZIndex + 100` on both `_ctxMenu` and `_rotateEl` in `showContextMenu()` and `showMultiContextMenu()` in `ui-whiteboard.js`, ensuring they always float above all elements regardless of how many items exist on the board.

### Added — Cron-Driven Social Engagement Scheduler
- **Server-side schedule evaluator** — 60-second `setInterval` loop in `server.js` that evaluates cron expressions against the current time in each schedule's timezone via `getNowInTimezone()`. Fires matching schedules with minute-level dedup lock and 30-second stagger queue for concurrent fires. Includes deferred missed-fire detection on startup (5-minute grace window).
- **Cron parser** — Custom 5-field cron expression parser (`parseCronField()`, `cronMatchesDate()`) supporting `*`, ranges (`1-5`), lists (`1,3,5`), and step values (`*/3`). `getNextCronRun()` computes next fire time up to 7 days ahead. `describeCron()` generates human-readable descriptions.
- **`launchScheduledLoop()` with day theme merging** — Resolves the schedule's `templateId` to a loop template, merges day-of-week `contextOverride` from `dayThemes` into the template's base context, then launches via `createTerminalSession()` + `attachLoopDriver()`. Adds `scheduledBy` field to loop state file for provenance tracking.
- **Schedule data model** — New `data/loop-schedules.json` file with schema: `{ schedules: [{ id, name, templateId, cron, timezone, enabled, dayThemes, overrides, lastRun, lastRunResult, nextRun, runCount, createdAt, updatedAt }] }`. `dayThemes` maps JS day-of-week (0=Sun through 6=Sat) to context override strings for content calendar weekly themes.
- **6 REST API endpoints** — `GET/POST /api/schedules`, `GET/PUT/DELETE /api/schedules/:id`, `POST /api/schedules/:id/test` (immediate fire). Full CRUD with template existence validation, cron format validation, and `nextRun` recomputation on every update.
- **6 WebSocket events** — `schedule:created`, `schedule:updated`, `schedule:deleted`, `schedule:fired`, `schedule:completed`, `schedule:failed` broadcast via `broadcastSync()`. Event dispatcher entries added in `ui-sync.js`.
- **API client functions** — `fetchSchedules()`, `createSchedule()`, `fetchSchedule()`, `updateSchedule()`, `deleteSchedule()`, `testSchedule()` in `api.js`.
- **Automation Studio — Schedules tab** — New "Schedules" button with clock icon in the header. `renderSchedulesMain()` renders a card-based list view showing template icon, cron description, next-run countdown, run count, timezone, status badges (Active/Paused/Error), and action buttons (toggle, test fire, edit, delete).
- **Automation Studio — Schedule editor** — `renderScheduleEditorMain()` provides a form with name, template dropdown, 5 cron presets (3x daily, 2x daily, morning only, every day 9am, every 3h), live cron description preview, timezone input, 7-row day themes grid (Sun–Sat context overrides), and enabled toggle. `saveScheduleFromEditor()` validates and creates/updates via API.
- **Schedule WebSocket listeners** — `setupScheduleWebSocket()` in `ui-automation-studio.js` listens for all 6 schedule events for live UI updates and toast notifications.
- **Backup inclusion** — `loop-schedules.json` added to both auto-backup (`buildBackupZipToFile()`) and manual backup file lists.

### Added — Whiteboard Shape Picker Submenu
- **Shape picker flyout** — Added `#wb-shape-picker` panel that appears when the shape tool is selected, matching the existing section picker pattern. Offers three shape presets: Rectangle, Circle, and Triangle, each with inline SVG icon and label.
- **Triangle shape support** — Added `generateHandDrawnShape('triangle')` with wobbly 3-point path rendering in `ui-whiteboard.js`. New `_activeShapeType` state variable (default `'rect'`) tracks which shape to create on click/drag. Triangle added to double-click shape cycle: rect → pill → circle → triangle → drawn-circle → rect.
- **Shape picker CSS** — Added `#wb-shape-picker`, `.wb-shape-btn` styles in `styles.css` replicating the section picker's glass panel appearance.

### Fixed — Circle Shape Rendering as Polygon
- **Circle had visible straight-line segments** — The circle shape rendered with 12-point Catmull-Rom approximation via `closedSmoothPath()` with `t=0.3` tension, producing a visible polygon. Replaced the point-based approach entirely with proper SVG arc commands (`A rx ry 0 1 1`) for a mathematically perfect ellipse in `generateHandDrawnShape('circle')`.

### Changed — Whiteboard Toolbar Icons
- **Arrow icon** — Replaced flat horizontal line + chevron with a diagonal arrow (bottom-left to top-right) with L-shaped arrowhead lines in `html-shell.js`. Clearer directional intent.
- **Shape icon** — Replaced rect + circle combo with a clean rounded rectangle (`rx="3"`). Simpler, matches design tool conventions.
- **Wireframe/Section icon** — Replaced 3-rect layout (top bar + two columns) with a 4-section wireframe layout (navbar strip, sidebar, content area, footer bar) in `html-shell.js`. Better represents actual page layouts.

### Fixed — Quick Timer Buttons Did Nothing on Click
- **`el` undefined in `handlePanelClick` switch cases** — The `qt-select` and `qt-go` handlers referenced `el` (undefined variable) instead of `btn` (the actual resolved element from `e.target.closest('[data-action]')`). Every click silently threw a ReferenceError, so preset selection and Go button had no effect. Fixed all references to use `btn` in `ui-automation-studio.js`.

### Fixed — Quick Timer Duplicate Entries
- **Timer appeared twice in Active Timers list** — The `qt-go` click handler pushed the new timer to `_quickTimers` immediately after the API response, then the server's `quick-timer:set` WebSocket broadcast triggered the `sync:quick-timer:set` listener which pushed the same timer again. Added dedup check (`!_quickTimers.some(t => t.id === data.timerId)`) to the sync handler so it skips timers already present.

### Changed — Quick Timer UX and New Schedule Form Rework
- **Quick Timer — unified select-then-go flow** — Preset buttons (5m, 15m, 30m, 1h, 2h, 4h) no longer fire immediately on click. Changed from `data-action="qt-start"` to `data-action="qt-select"` which highlights the selected preset (`.as-qt-preset--selected` with blue border/background). A single unified "Go" button (`data-action="qt-go"`) triggers the timer, reading either the selected preset or custom minute input. New `_selectedQtMinutes` state variable tracks selection.
- **New Schedule form — grouped cron presets** — Expanded from 5 flat presets to 18 presets organized in 3 groups via `CRON_PRESET_GROUPS`: Frequency (Every 15m/30m/1h/2h/3h/6h), Daily (Morning/Midday/Evening/2x/3x/4x), Weekly (Weekdays 9am/2x/3x, Weekends 10am, Mon/Wed/Fri, Tue/Thu). Rendered in a 3-column CSS grid (`.as-sched-preset-grid`) with group labels.
- **New Schedule form — side-by-side fields** — Name+Template and Timezone+Status fields now render in horizontal rows (`.as-sched-field-row` with `.as-sched-field--flex`). Cron input uses monospace font with inline live description (`.as-sched-cron-row`).
- **New Schedule form — day themes 2-column grid** — Day themes reordered from Sun-first to Mon-first (`dayOrder = [1,2,3,4,5,6,0]`) and rendered in a 2-column CSS grid (`.as-sched-daythemes-grid`). Mon/Tue, Wed/Thu, Fri/Sat pair naturally; Sun spans full width.
- **`describeCronClient()` improvements** — Now handles `*/N` minute patterns (e.g., `*/15` → "every 15 minutes") and `*/N` hour patterns (e.g., `*/2` → "every 2 hours at :00") instead of falling through to generic display.

### Changed — Response Ordering System
- **New "Response Ordering (IMPORTANT)" section in `CLAUDE.md` and `CLAUDE-template.md`** — Instructs Claude to call `remember` (and other memory tools) BEFORE writing the task completion summary. Tool call results appear above text in a single response, so the summary naturally ends up at the bottom where the user sees it. Prevents the stop hook from blocking and burying the summary under memory tool noise.
- **Stop hook summary instruction in `stop.mjs`** — All block reasons (single obligation, combined obligations, standalone plan check) now append: "After completing all memory operations, end your response with a brief task completion summary so the user sees it as the final message." Added `SUMMARY_SUFFIX` constant for single/combined obligation blocks (line 630) and inline suffix for the standalone plan block (line 659).
- **Session-start boot directive in `session-start.mjs`** — Added response ordering one-liner to the SynaBun Persistent Memory boot block (line 315): reminds Claude that memory tools go first, summary goes last.
- **Condensed rulesets updated** — Added `Response ordering: call remember FIRST, then write your summary LAST. Never summary-then-tools.` to all 4 condensed rulesets (Cursor, Generic, Gemini, Codex) in both `CLAUDE.md` and `CLAUDE-template.md`. These propagate to onboarding and settings copy buttons via the `/api/claude-code/ruleset` endpoint.

### Changed — CLAUDE.md Documentation Accuracy
- **Hook System table descriptions updated** — SessionStart: was "Injects directives + category tree" → now "Greeting, boot sequence, compaction recovery, loop detection, session registration." UserPromptSubmit: added "loop iteration injection, category tree on first threshold." Stop: was "Blocks if pending-compact or 3+ edits without remember" → now "Combined obligations: compaction, loops, task memory, user learning, conversation turns, auto-store, unstored plans." PostToolUse (post-remember): added "User learning flag management."
- **Development section updated** — Directory tree now shows `neural-interface/` sub-structure with `public/` and `templates/` subdirectories. Architecture line changed from "single-file Neural Interface" to "modular Neural Interface (vanilla JS + Three.js, shared/ modules)".

## 2026-03-19

### Added — Isolated Agent System
- **Fully isolated Claude Code agents from Automation Studio** — New system to spawn Claude Code as independent child processes using `child_process.spawn` with `claude --print --output-format stream-json`, completely separate from the existing terminal relay / loop pipeline. No node-pty dependency — cross-platform by default (macOS, Linux, Windows).
  - **Session isolation** — Each agent gets `--session-id <uuid>`, `--strict-mcp-config` with empty MCP config (no global servers), and `--permission-mode bypassPermissions`. No SynaBun hooks fire, no state files shared, no MCP cross-talk.
  - **`spawnIsolatedAgent()` in `server.js`** — Spawns child process, parses newline-delimited JSON stream from stdout, extracts assistant text and tool use events, tracks cost from result events. Clean environment with `NO_COLOR=1`, `TERM=dumb`, stripped `VSCODE_*` vars.
  - **`agentRegistry` Map** — In-memory registry tracking all active/completed agents with status (`running`/`completed`/`failed`/`stopped`), accumulated text output, tool use summaries, and cost.
  - **5 REST API endpoints** — `POST /api/agents/launch`, `GET /api/agents`, `GET /api/agents/:id`, `POST /api/agents/:id/stop`, `DELETE /api/agents/:id`
  - **WebSocket broadcasting** — `agent:launched`, `agent:output`, `agent:status`, `agent:removed` events via `broadcastSync()` for real-time UI updates
  - **Cross-platform process kill** — Unix: `process.kill(-pid, 'SIGTERM')` for process group kill. Windows: `taskkill /pid X /T /F` for tree kill. `AGENT_IS_WIN` constant avoids forward-reference to `IS_WIN`.
- **Automation Studio launch dialog mode toggle** — New Loop/Agent toggle (`.as-launch-mode-toggle`) in the launch confirmation dialog. Agent mode hides iteration/time fields and shows isolation badge. Persists mode across launches.
- **Agent cards in Running view** — Live-streaming agent cards (`.as-agent-card`) with status-colored borders, monospace output area (`.as-agent-output`), tool call count, cost display, elapsed time, and stop/remove controls. Auto-scrolls output. WebSocket listener (`setupAgentWebSocket()`) updates cards in real-time as events arrive.
- **API client functions in `api.js`** — `launchAgent()`, `fetchAgents()`, `fetchAgent()`, `stopAgent()`, `removeAgent()`
- **Sync event dispatch in `ui-sync.js`** — 4 new agent event handlers: `agent:output`, `agent:launched`, `agent:status`, `agent:removed`

### Changed — Database Tab Visual Polish
- **Section cards** — Wrapped Memory Database and Embedding Management areas in `.stg-section` card containers, replacing flat `.stg-section-divider` with card-gap separation for consistent visual hierarchy across settings tabs
- **Stats grid** — Replaced inline-styled text stats with `.db-stats-row` — a 2-column grid of inset stat tiles (`.db-stat`) with uppercase labels and monospace values for Storage and DB Size
- **Buttons** — Replaced `conn-add-btn` and `settings-btn-cancel` with `.stg-action-btn`. Reindex and Cancel buttons wrapped in `.db-reindex-row` flex container at 50/50 width
- **Progress bar** — Extracted all inline styles from the reindex progress area into CSS classes: `.db-reindex-status`, `.db-reindex-header`, `.db-reindex-text`, `.db-reindex-bar-track`, `.db-reindex-bar`, `.db-reindex-summary`
- **Embedding model footer** — Moved embedding model/dimensions info from the stats grid into a `.db-model-footer` hairline-separated note at the bottom of the Embedding Management card

### Fixed — Plan Storage Cross-Session Leak
- **`post-plan.mjs` stored wrong plan when multiple sessions were in plan mode** — The `findLatestPlan()` function blindly picked the most recently modified `.md` file from `~/.claude/plans/` (a shared global directory) with no session awareness. When two concurrent Claude Code sessions were in plan mode, `ExitPlanMode` in one session could grab the other session's plan file — the one with the newer `mtime` — and store it under the wrong project/context. Evidence: 10 of 17 plan files in the plans directory were never stored, likely victims of the same cross-session mismatch or dedup cascade.
  - **`findPlanByContent(toolResponse)`** — New primary matching function that uses `tool_response` content from `ExitPlanMode` to identify the correct plan file. Four strategies in priority order: filename extraction from response text, exact content match, substring match (response contains file content or vice versa), and H1 heading match.
  - **`listPlanFiles()`** — Extracted shared utility that lists and sorts all `.md` files by `mtime` descending, used by both `findPlanByContent()` and the mtime fallback.
  - **`findLatestPlan()` demoted to fallback** — The original mtime-based selection is now only used when content matching fails (e.g., empty `tool_response`), ensuring no regression for edge cases.
  - **Debug logging** — New `data/plan-debug.log` (append-only) records session ID, `tool_response` preview (first 200 chars), and match method (`exact-content`, `heading-match`, `filename`, `mtime-fallback`) for every `ExitPlanMode` invocation. Match method also included in the `additionalContext` response.

### Fixed — Image Sharing Pipeline (Claude Panel → Claude Code)
- **Claude Code CLI never received pasted/dropped images** — The `query` WebSocket handler in `server.js` destructured `images` from the message but never passed them to `spawnProc()`. Since Claude Code's `--print` mode accepts only text stdin, images can't be sent as multimodal content. Fixed by saving each attached image as a temp file (`synabun-img-{timestamp}-{idx}.{ext}`) and prepending a "Use the Read tool to view" instruction block to the text prompt before spawning the process.

### Fixed — Terminal Image Paste Not Inserting Into PTY
- **`image_saved` response only copied path to clipboard** — All 6 `image_saved` handlers across terminal session types (xterm main, html-term-renderer, floating xterm, floating html-term, detached, generic) called `navigator.clipboard.writeText()` but never wrote the path into the PTY stream. Fixed by adding `ws.send(JSON.stringify({ type: 'input', data: msg.path }))` after the clipboard copy in every handler, so the saved image path is both copied and inserted at the cursor.

### Fixed — Whiteboard "Send to Terminal" Session Lookup
- **`wb:send-to-terminal` event handler had no session fallback** — The handler tried to use `_activePaneIdx` directly without checking validity or falling back to any open session. When no pane was explicitly active (common after tab switches), the send silently failed. Fixed by checking `_activePaneIdx[0]` then `[1]`, then falling back to the first session with an open WebSocket, with a toast message if no session is available.

### Fixed — Standalone Chat Missing Image Preview
- **Pasted images in `claude-chat.html` showed only a status line, no thumbnail** — The standalone chat page called `appendStatus()` for pasted images with no visual preview or way to remove them before sending. Added an `#chat-image-preview` container with `addImageThumb()` rendering 56×56 rounded thumbnails with hover-reveal `×` remove buttons. Thumbnails re-index on removal, preview clears on send.

### Fixed — Screenshot Auto-Paste macOS-Only
- **Screenshot watcher hardcoded to macOS paths and patterns** — The `fs.watch()` screenshot watcher in `server.js` only checked `com.apple.screencapture` and `~/Desktop` with a macOS-specific filename regex. Refactored to a cross-platform block: macOS reads `defaults read com.apple.screencapture location` with `~/Desktop` fallback; Windows checks `~/Pictures/Screenshots`, `~/OneDrive/Pictures/Screenshots`, `~/Pictures`; Linux checks `~/Pictures/Screenshots`, `~/Pictures`, and Portuguese locale variants. Each platform gets its own filename pattern.

### Fixed — Clipboard Operations Failing in Non-Secure Contexts
- **`navigator.clipboard.writeText()` silently fails over LAN (non-HTTPS)** — The Clipboard API requires a secure context (HTTPS or localhost). When Neural Interface is accessed via LAN IP, all clipboard operations failed silently. Added `_clipCopy()` / `_clipboardWrite()` helpers in both `ui-terminal.js` and `ui-whiteboard.js` that try the modern API first, then fall back to a hidden `<textarea>` + `document.execCommand('copy')` pattern. Also added a WebSocket connection check with tooltip feedback on the whiteboard "Copy Image Path" button.

### Added — Content Negotiation & Markdown Extraction
- **Browser markdown extraction endpoint** — New `GET /api/browser/sessions/:id/markdown` in `server.js` extracts clean markdown from any rendered page. Uses `page.evaluate()` to clone the DOM, strips noise elements (nav, header, footer, aside, ads, cookie banners, modals, scripts, styles, iframes), prefers `<main>`/`<article>`/`[role="main"]` content areas, then converts via `node-html-markdown`. Returns `{ url, title, markdown, tokens }` with 80K char truncation and token estimation (`Math.ceil(length / 4)`).
- **Lightweight HTTP fetch with Accept header negotiation** — New `POST /api/fetch-markdown` endpoint performs direct HTTP fetch (no browser) with `Accept: text/markdown, text/html, */*` header (RFC 7763). Detects native markdown responses via `Content-Type`, reads Cloudflare `x-markdown-tokens` and `content-signal` headers. Falls back to `node-html-markdown` conversion for HTML responses. 15s timeout via AbortController.
- **MCP client methods `getMarkdown()` and `fetchMarkdown()`** — Added to `mcp-server/src/services/neural-interface.ts` for the two new endpoints.
- **`node-html-markdown` dependency** — Added to `neural-interface/package.json`. Shared `NodeHtmlMarkdown` instance configured with fenced code blocks, `-` bullet markers, `*`/`**` emphasis, and max 2 consecutive newlines.

### Changed — `browser_content` Tool Format Parameter
- **New `format` parameter on `browser_content`** — Accepts `"text"` (default, backward-compatible) or `"markdown"`. Markdown mode calls the new extraction endpoint, returning structured content with headings, links, and lists preserved — ideal for LLM consumption. Updated schema, description, and handler in `mcp-server/src/tools/browser-observe.ts`.

### Fixed — Agent Launch Dialog DOM-Timing Bug
- **`confirmLaunch()` read DOM values after dialog destruction** — `closeLaunchDialog()` was called before reading the SynaBun checkbox, submode buttons, iterations, and max-minutes inputs. Since `closeLaunchDialog()` calls `.remove()` on the dialog element, all 5 `document.getElementById()` / `querySelector()` calls returned `null`, making `withSynabun` always `false`, `agentSubmode` always `"single"`, `agentIterations` always `1`, and `agentMaxMinutes` always `30`. Moved all DOM reads before `closeLaunchDialog()` in `ui-automation-studio.js`. This caused agents to launch with empty MCP config (`{"mcpServers":{}}`) and no browser session — making browser automation impossible.

### Fixed — Agent CLAUDE.md Boot Sequence Hijack
- **Agents burned all turns on session boot instead of executing tasks** — Agents spawned with `cwd: PROJECT_ROOT` loaded the project's `CLAUDE.md`, which mandates a greeting, session recall, and communication-style recall before any work. The agent spent its first 4 turns on `ToolSearch` + `recall` calls for the boot sequence, then output "Let me navigate..." as text-only — which terminates `--print` mode (text-only responses end the session). Added `defaultAgentPrompt` in `launchAgentController()` (`server.js`) when `withSynabun=true`: instructs the agent to skip CLAUDE.md boot, go straight to the task, and chain `ToolSearch` with actual tool calls in the same response to avoid text-only termination.

### Changed — Agent Process Tuning & Diagnostics
- **Max turns bumped from 25 to 200** — Browser automations require many turns per page interaction (navigate, snapshot, click, type, wait). 25 turns was exhausted before meaningful work could begin. Default now 200 in `launchAgentController()`.
- **Real-time stderr logging** — Agent stderr was silently buffered with no console output. Added line-by-line filtering for `error`, `MCP`, `ENOENT`, `refused` keywords with `console.warn()`. Full stderr dump logged on process close.
- **Spawn command logging** — `[agent] <id> spawn:` line logs the full claude binary path and arguments (truncated at 80 chars per arg) for debugging.
- **Tool use logging** — `[agent] <id> tool_use: <name>` logged for every MCP/built-in tool call.
- **Close summary** — `[agent] <id> close: code=<N>, tools=<N>, textLen=<N>` logged on process exit.

### Changed — Focus Mode Gradient Glow
- **Upgraded `.focus-breathe` ambient glow** — Replaced the 300×300px single-stop radial gradient with a 600×600px multi-layered glow in `styles.css`. Outer layer uses a 4-stop gradient (`rgba(100,150,220,0.07)` → `rgba(80,125,200,0.035)` → `rgba(60,100,180,0.015)` → transparent) for smoother falloff. Added `::before` pseudo-element as a brighter inner core with offset animation timing (`-1.5s` delay) for visual depth.
- **Fixed glow centering for panel tracking** — Replaced `margin-left: -150px; margin-top: -150px` centering hack with `translate(-50%, -50%)` combined with `scale()` in the `@keyframes focus-breathe` animation. The glow now auto-centers regardless of size and correctly follows the logo when sidebars or Claude panel slide open/closed via `--sidebar-total-width` and `--claude-panel-width` CSS variables.
- **Slower, calmer animation** — Reduced animation cycle from 4s to 6s and scale amplitude from 1.15× to 1.1× for a more ambient feel.

### Fixed — macOS Permission Error on Screenshot/Image Temp Files
- **Images written to `os.tmpdir()` were inaccessible on macOS** — All 5 image/file write paths in `neural-interface/server.js` used `os.tmpdir()` (e.g., `/var/folders/.../T/`), which macOS can restrict access to. Claude Code's `Read` tool would fail when trying to view pasted or dropped images from the whiteboard focus mode. Replaced all paths with a project-local `IMAGES_DIR` (`data/images/`): Claude skin image attachments (`synabun-img-*`), terminal image paste (`synabun-paste-*`), whiteboard image drag-drop (`synabun-wbimg-*`), memory drag-drop (`synabun-*.md`), and whiteboard image save (`synabun-wbimg-*`).
  - Added `IMAGES_DIR` constant with auto-`mkdirSync` at server startup
  - Added 24h stale file cleanup sweep on server boot to prevent unbounded growth
  - Added `data/images/` to `.gitignore`

### Fixed — Cost Tracking Not Updating Live (Navbar + Session Cost)
- **Navbar label stuck at $0.00 until clicked** — The `cost:updated` event emitted `{ amount, total }` but the navbar listener in `ui-navbar.js` read `data.sessionCost`, a field that didn't exist in the payload. Added `sessionCost: tab.sessionCost` to the event emission in `ui-claude-panel.js`. Additionally, `_updateCostLabel()` now directly updates the navbar `.bar-cost-label` element, covering all 6 call sites (init, tab switch, session restore, sync, monthly load, result events).
- **Cost widget overwriting navbar with monthly total** — `_render()` in `ui-cost-widget.js` was setting the navbar label to `totalUsd` (monthly total), conflicting with the session cost. Removed this — navbar label is now solely managed by `_updateCostLabel()`.
- **Docked cost widget had no initial data fetch** — When docked, `initCostWidget()` skipped the initial `_fetchAndRender()` call, only fetching on first click. Now calls `_positionDocked()` + `_fetchAndRender()` on init when docked.

### Changed — Session Monitor Rewritten as Proper Window
- **Replaced flyout panel with draggable/resizable window** — The Session Monitor was a narrow 340px fixed panel anchored to the top-right corner (`z-index: 900`). Now it opens as a proper centered window (640x480 default) using the same `glass resizable` + `drag-handle` pattern as the Automation Studio. Includes backdrop overlay, scale-in animation, and all 8 resize handles. (`ui-sessions.js`, `styles.css`)
- **Added tabbed interface with 3 sections** — Content is now organized into **Sessions**, **Agents**, and **Health** tabs. Each tab has a count badge that updates in real-time (blue for running agents, red for critical leaks, orange for warnings). Tab content renders into a scrollable body area. (`ui-sessions.js`)
  - **Sessions tab** — Active Claude Code sessions displayed as cards with type icon, project name, pulse indicator, and a key/value detail grid (ID, uptime, last active, PID, CWD). Dead sessions show reduced opacity; sessions with associated leaks get a red border.
  - **Agents tab** — Running and recent agents grouped by status with pill-style status badges (`Running`/`Completed`/`Failed`/`Stopped`), iteration counters for loops, stop/remove buttons, and cost display.
  - **Health tab** — Leaks grouped by severity (critical/warning/info) with color-coded card borders and full detail rows (type, age, file, CWD, session IDs, loop data). Orphaned files section includes a "Clean All" action bar.
- **Added empty states** — Each tab shows a centered icon + message when there's no data (e.g., "No active sessions", "All clear" for health). Health tab uses a green icon for the all-clear state.
- **Synced navbar button state** — Navbar icon now listens for `session-monitor:closed` event to deactivate when the window is closed via its own close button or backdrop click, preventing the button from getting stuck in the `active` state. (`ui-navbar.js`)
- **Preserved widget mode** — `mountSessionWidget()` still works for the claude-chat inline skin. `createSessionMonitorPanel()` returns `null` as a backwards-compat no-op.

## 2026-03-18

### Added — Shared Frame Renderer Factory
- **`createFrameRenderer(canvas, ctx)`** — New utility in `utils.js` that creates a serialized latest-frame-wins renderer for browser screencast streams. Only one `Image` decode runs at a time; incoming frames during decode replace the pending frame (stale frames discarded). Includes `onerror` recovery so corrupted base64 data doesn't permanently stall the pipeline. Returns `{ render(base64), destroy() }` interface.

### Fixed — Browser Screencast Stream Freezing
- **Canvas freeze across all rendering surfaces** — Browser screencast streams in the terminal, floating terminal, and Claude panel side panel would freeze while the actual Playwright browser continued working. Root cause: every incoming CDP frame created a new `Image()` for async base64 decode with no backpressure — when frames arrived faster than the browser could decode, Image objects piled up and `onload` callbacks stopped firing permanently. Fixed by replacing the naive per-frame `new Image()` pattern with `createFrameRenderer()` in all three locations: `ui-claude-panel.js:showBrowserEmbed()`, `ui-terminal.js:openBrowserSession()`, and `ui-terminal.js:reconnectBrowserSession()`. Frame renderers are properly destroyed on session close/hide.

### Changed — Server-Side Screencast Backpressure
- **WebSocket write buffer check** — Frame broadcast in `server.js:startScreencast()` now checks `ws.bufferedAmount < 512KB` before sending to each client. Clients with congested write buffers are skipped, preventing server-side frame backlog that contributed to client freezes.
- **Default `everyNthFrame` bumped from 1 to 2** — Both `startScreencast()` and the resize-triggered screencast restart now default to sending every 2nd CDP frame instead of every frame. Halves throughput with minimal visual impact. Config file value (`browser-config.json`) still overrides.

### Changed — Resize Debounce for Browser Sessions
- **200ms debounce on `ResizeObserver`** — Both `openBrowserSession()` and `reconnectBrowserSession()` in `ui-terminal.js` now debounce resize events before sending viewport resize messages to the server, preventing rapid screencast stop/start cycles during window drag-resizing.

### Added — Auto Backup System
- **Scheduled backup to local folder** — New auto-backup system that writes a full SynaBun backup ZIP (`synabun-auto-backup.zip`) directly to a user-chosen folder on a configurable schedule. Uses atomic write pattern (`.tmp` → `renameSync`) to prevent corrupt backups mid-write. Single file replacement — each scheduled run overwrites the previous backup, avoiding disk bloat.
  - **Server scheduler** — `setInterval`-based scheduler in `server.js` starts on server boot if enabled, restarts automatically when config changes (no server restart needed). Config persisted in `data/auto-backup-config.json` with fields: `enabled`, `intervalMinutes`, `folderPath`, `lastBackup`, `lastBackupSize`, `lastBackupError`.
  - **`buildBackupZipToFile(destPath)`** — Reusable function that creates the same ZIP content as the manual `GET /api/system/backup` endpoint (`.env`, `data/` configs, categories, skills, agents, SQLite database) but writes to disk via `createWriteStream` instead of HTTP response.
  - **3 API endpoints** — `GET /api/system/auto-backup` (read config), `PUT /api/system/auto-backup` (update config + restart scheduler), `POST /api/system/auto-backup/trigger` (run backup immediately).
  - **Settings UI** — New "Auto Backup" section in Settings > Server tab below the existing backup controls. Toggle on/off, frequency dropdown (30min / 1h / 3h / 6h / 12h / 24h), native OS folder picker via `/api/browse-folder`, "Backup Now" button for immediate trigger, and status display showing last backup time, file size, and errors.

### Fixed — Session Isolation Leak Across Claude Code Skin Tabs
- **Project/model/effort state leaked between sidepanel tabs** — The Claude Code skin sidepanel (`ui-claude-panel.js`) stored project, model, and effort toggle in global `storage` keys shared across all tabs/windows. When a user selected a different project in a new tab, the first tab's session would inherit the second tab's project path via the shared `cwd` key, causing Claude to execute tasks in the wrong project directory. Fixed by adding `project`, `model`, and `effort` as per-tab fields in the tab state object.
  - **`createTab()`** — Captures current dropdown values (`ddGetValue()`) into the new tab's `project`, `model`, `effort` fields at creation time
  - **`switchTab()`** — Restores project/model/effort dropdowns via `ddPopulate()` and `_setEffort()` when switching between tabs, ensuring each tab shows its own project context
  - **Change handlers** — Project, model, and effort `change`/`click` listeners now write to `activeTab()` and call `saveTabs()` in addition to global storage
  - **`saveTabs()` / `restoreTabs()`** — Serializes and restores `project`, `model`, `effort` per tab across page reloads
  - **Session history selection** — Clicking a past session now sets `tab.project` from the session's `cwd`, keeping tab state consistent
- **Standalone chat page (`claude-chat.js`) leaked state between browser tabs** — The standalone `/claude-chat.html` page wrote project, model, and session ID to server-synced `storage`, meaning opening two browser tabs with different projects would clobber each other. Fixed by introducing a `tabStore` wrapper over browser `sessionStorage` (naturally tab-scoped). Falls back to server-synced `storage` for initial defaults on first load, then uses `sessionStorage` exclusively for all subsequent reads/writes.

### Fixed — Loop Cross-Session Leaking
- **Loop driver and hook fallback scans ignored terminal ownership** — Three code paths in the loop system scanned all `data/loop/*.json` files without checking which terminal session owned each loop, causing a running loop to leak into unrelated Claude Code sessions when multiple sessions were active simultaneously.
  - **`attachLoopDriver()` in `server.js`** — The 2-second polling scan picked up any loop with `awaitingNext=true` regardless of `terminalSessionId`, then sent `/clear` and iteration messages to the wrong terminal's PTY. Fixed by adding `loopState.terminalSessionId !== terminalSessionId` guard before driving.
  - **`prompt-submit.mjs` pending claim (line 509)** — After renaming a pending loop file to the Claude session ID, the hook deleted `state.terminalSessionId` — destroying the ownership marker that the loop driver needs for scoping. Fixed by preserving the field.
  - **`prompt-submit.mjs` fallback scan (lines 543-567)** — After `/clear` changed the Claude session ID, this scan found any active loop and renamed (stole) it to the new session ID, transferring ownership. Fixed by removing the `renameSync` — the fallback now reads the loop state without claiming it.

## 2026-03-17

### Fixed — Loop Pending-Claim Failure
- **Server-side pending claim** — `attachLoopDriver` now scans for `pending-*.json` files matching its terminal session and writes the `[SynaBun Loop] Begin task.` message directly via `session.pty.write()` when the `>` prompt is detected, bypassing the unreliable client-side `_sendOnceReady` which silently fails when the WebSocket is closed
- **Stale pending cleanup** — `cleanupStaleLoops` in `shared.mjs` now deletes `pending-*.json` files older than `maxMinutes + 5` minutes instead of ignoring them

### Fixed — Loop History Accumulation Breaking State
- **Delete on end/stop** — Loop JSON files are now deleted immediately when a loop finishes (iteration cap, time cap), is force-stopped (API or duplicate launch), or fails (consecutive prompt detection failures) — previously they were marked inactive and lingered in `data/loop/`
- **Stale loops deleted immediately** — `cleanupStaleLoops` now deletes stale and inactive loop files on sight instead of deactivating them or waiting 24 hours
- **History endpoints gutted** — `GET /api/loop/history` returns `[]`, `DELETE /api/loop/history/:id` is a no-op — no loop logging, only actively running loops exist as files
