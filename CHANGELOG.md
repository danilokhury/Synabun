# SynaBun Changelog

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
