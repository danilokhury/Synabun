# SynaBun Changelog

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
