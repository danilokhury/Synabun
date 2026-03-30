# SynaBun Changelog

Raw internal changelogs are archived in [changelog/](changelog/).

## v.2026.03.30

### Added — Message Queue System
- **Queue messages while Claude is processing** — Stack multiple messages in a FIFO queue that auto-advances between turns. Includes drag-to-reorder, inline editing, pause/resume, and a collapsible queue tray UI
- **Keyboard behavior change** — Enter while running now queues the message; Shift+Enter triggers the existing /btw interrupt. Send button icon updates dynamically based on state

### Added — Notification Click-to-Navigate
- **Clicking a notification focuses the exact source** — Toast clicks route to the specific terminal session or Claude panel tab that triggered the notification. OS banner notifications use service worker `postMessage` relay for click-through routing
- **All 10 notification call sites updated** — 8 panel calls pass tab ID, 2 terminal calls pass session ID

### Added — Hook-Side Auto-Recall
- **Top 3 related memories injected into every prompt** — The prompt-submit hook calls `/api/hook-recall` on every substantive user prompt, auto-detects project from `cwd`, and injects matching memories (score >= 0.4) directly into `additionalContext` with a 3-second timeout and silent fallback

### Added — Browser Stream Toggle
- **Disable screencast to save ~50% CPU** — New toggle in Settings > Browser. When disabled, all CDP frame capture, encoding, and WebSocket broadcasting stops. All MCP browser tools continue working — only the Neural Interface preview stream is affected

### Added — Edit Plan in Code Editor
- **Open plan files directly in the Neural Interface editor** — Clicking "Edit plan" on the post-plan action card opens the MD file in the code editor with a green accent banner. On save, the updated plan is auto-sent to Claude. Falls back gracefully for plans from prior sessions

### Added — Recall Settings Redesign
- **4 recall profiles replace basic token budget** — Quick (3 results, tight matching), Balanced (5 results), Deep (10 results, loose matching), Custom (opens all individual controls). Profile selection auto-configures all parameters
- **Fine-tune controls** — Results per recall, minimum importance, similarity threshold, content length, session context toggle, and recency boost
- **Impact indicator** — Shows estimated tokens per recall, reachable memories, and session context status

### Added — Isolated Agent System
- **Spawn Claude Code as independent child processes** — Full session isolation with no hook interference, no MCP cross-talk, and cross-platform process management (no node-pty dependency). Each agent gets its own session ID, strict MCP config, and bypass permissions
- **Agent cards in Automation Studio** — Live-streaming output with tool call count, cost display, elapsed time, and stop/remove controls

### Added — Image Gallery
- **Floating draggable panel for browsing captured images** — Search, type filters (Screenshots/Attachments/Whiteboard/Pastes), sort options, favorites toggle. Full lightbox with keyboard navigation (arrow keys, Escape) and action buttons (favorite, add to whiteboard, download, delete)

### Added — Cron-Driven Schedule System
- **Create recurring automations with cron expressions** — Timezone support, day-of-week themes for content calendars, 18 cron presets across 3 groups (Frequency, Daily, Weekly). Full CRUD API with WebSocket events for live UI updates. Schedules tab in Automation Studio with status badges and test-fire button

### Added — Multi-Browser Session Isolation
- **Dedicated browser per automation** — Each automation gets its own browser session with environment-based pinning via `SYNABUN_BROWSER_SESSION`. Concurrent automations no longer fight over the same browser. Browser cleanup on loop stop

### Added — Multi-Tab Browser Architecture
- **Tabs per browser session** — Create, switch, and close tabs via REST and WebSocket. Each tab stores its own page, CDP session, URL, and title. Active tab aliases preserve backward compatibility with all existing MCP tools

### Added — Notifications Settings Tab
- **Dedicated notifications panel** — Master toggle, system permission status with color-coded indicator, sound controls with volume slider and test button, OS banner toggle, action-only filter, and end-to-end test notification button

### Added — Auto Backup System
- **Scheduled ZIP backups to a user-chosen folder** — Configurable frequency (30min to 24h), native OS folder picker, atomic write pattern, single-file replacement. Settings UI with last backup time, file size, and error status

### Added — Whiteboard Enhancements
- **Shape picker submenu** — Rectangle, Circle, and Triangle presets with inline SVG icons
- **Floating move handle** — 4-directional arrow on selected text/list elements, mirroring the rotate handle
- **Backdrop toggle button** — Eye icon on all windows to show/hide the backdrop overlay
- **Multi-select shortcut** — `M` key toggles multi-select mode

### Added — Automation Studio Icon Picker Expansion
- **13 new icons** — Social media (X, Instagram, Facebook, LinkedIn, TikTok, YouTube, WhatsApp, Discord), AI platforms (Claude, OpenAI, Gemini), Leonardo, and pin

### Added — Content Negotiation & Markdown Extraction
- **Browser markdown extraction** — Strips noise elements, prefers main/article content areas, converts via `node-html-markdown`. New `format: "markdown"` parameter on `browser_content` tool
- **Lightweight HTTP fetch** — `Accept: text/markdown` header negotiation with Cloudflare header detection and HTML fallback

### Added — LinkedIn Jobs Browser Extractor
- **Structured job listing extraction** — Handles search results and homepage recommendations. Extracts 11 fields per job including salary parsing across multiple currencies. De-duplicates by job ID

### Fixed — Permission Spam in Claude Code Sidepanel
- **Events leaked through buffer gate** — All message types now blocked during active permission prompts or ask questions (except `control_request`). Denying a permission now properly kills the running process. Queue and buffer cleared immediately on deny

### Fixed — AskUserQuestion Card Duplication
- **Buffer flush ordering** — Reordered to flush while dedup flag is still active. Added DOM-level guard against rendering duplicate ask cards when an active card already exists

### Fixed — Edit Plan Auto-Implementing
- **Edited plans now show review card** — After saving in the code editor, a PLAN UPDATED card renders with Implement/Compact/Edit buttons instead of auto-sending to Claude. Edited content is preserved and sent when implementing

### Fixed — Neural Interface Memory Leaks (11GB+)
- **DOM pruning** — Messages capped at 600 nodes with batch removal of oldest 150. Message buffer capped at 500 during permission prompts. Event listener cleanup on Automation Studio panel close — previously leaked 6 document-level listeners per open/close cycle

### Fixed — Context Gauge Showing Inflated Values
- **Cumulative token counts replaced with per-turn values** — Gauge now uses correct per-turn usage from assistant events instead of cumulative result event values that could reach multiples of the context window

### Fixed — Plan System "PLAN COMPLETE" Card Not Rendering
- **Detection moved to assistant events** — In `--print` mode, built-in tool results aren't emitted. ExitPlanMode detection now fires from tool_use blocks in assistant events with flag-based handoff to the result/done handlers

### Fixed — Plan Storage Cross-Session Leak
- **Plans now matched by content instead of modification time** — Four matching strategies (filename, exact content, substring, heading) replace the old blind "newest file wins" approach that grabbed wrong plans when multiple sessions were in plan mode

### Fixed — Floating Browser Close Button After Reconnection
- **ID-based lookup replaces object identity** — Close and pin handlers now re-find the live session by ID instead of using stale closure-captured references that go invalid after session reconnection

### Fixed — Loop Cross-Session Leaks
- **Terminal session ownership tracking** — Loop driver, hook pending claims, fallback scans, and session-start detection all now filter by `terminalSessionId` instead of blindly grabbing the first available loop

### Fixed — Loop Time Cap Silently Clamped
- **Raised from 60 to 480 minutes** — The terminal loop endpoint had a stale `Math.min(..., 60)` cap that silently truncated all values. Iteration cap raised from 50 to 200. UI sliders updated to match

### Fixed — Browser Screencast Freezing
- **Backpressure-aware frame renderer** — Replaced unbounded `Image()` creation with a latest-frame-wins pattern. Only one decode runs at a time; stale frames are dropped. Applied to all three rendering surfaces (terminal, floating, panel)

### Fixed — White Dropdown Backgrounds on Windows
- **`color-scheme: dark` declaration** — Added to `:root` so native form controls render in dark mode on Windows Chrome/Edge

### Fixed — Session Isolation Leak Across Tabs
- **Project/model/effort are now per-tab state** — Previously stored in shared global storage, causing one tab's project selection to leak into another. Standalone chat page also fixed with `sessionStorage`-based tab isolation

### Fixed — Image Pipeline
- **File attachments now reach Claude** — Fixed 5 separate issues: disabled send button ignoring files, early return blocking file-only sends, path chips persisting after send, no framing text for attached files, BTW interrupt discarding files
- **Pasted/dropped images** — Saved as temp files with Read tool instruction instead of multimodal (unsupported in `--print` mode)
- **Clipboard operations** — Fallback for non-HTTPS contexts when accessing Neural Interface over LAN

### Fixed — Agent Launch Dialog
- **DOM values read before dialog destruction** — All input reads moved before `closeLaunchDialog()` which calls `.remove()`. Previously all 5 reads returned `null`, making agents launch with empty MCP config and no browser session

### Fixed — Cost Tracking
- **Navbar label stuck at $0.00** — Event payload now includes session cost field. Widget no longer overwrites navbar with monthly total. Docked widget fetches data on init

### Fixed — Pencil Tool Screenshot Rendering
- **Smooth bezier curves replace polygonal line segments** — Screenshot capture now uses pre-computed SVG path data instead of straight `lineTo()` segments. Increased smoothing passes and reduced jitter threshold

### Fixed — Window Controls Overlay on macOS
- **CSS specificity fix** — WCO padding no longer silently overwritten by base styles. Theme color matched to navbar composited appearance. Vertical alignment matched to traffic light midpoint

### Fixed — Notifications in Safari PWA
- **Service worker routing** — Replaced direct `Notification` constructor with `serviceWorker.postMessage()` → `registration.showNotification()` flow

### Fixed — Whiteboard List Items Lost on Reload
- **Content synced before persisting** — List contenteditable DOM content now flushed to the model array before serialization. Added flush calls to all exit paths

### Changed — Toolbar Modernization
- **Apple-style unified frosted glass pills** — Top-right navbar and bottom-right workspace toolbar converted from separate button groups to continuous pill bars with shared backdrop blur. Refined hover effects with spring animations, unified active state dots, and cleaner SVG icons

### Changed — Window Header Modernization
- **Unified design language across 13+ window types** — Gradient backgrounds, softer borders, lighter title weight, ghost-style action buttons, and red-tint close hover

### Changed — Batched AskUserQuestion Submission
- **Options toggle freely until submitted** — Submit button with progress counter (`Submit 2/3`) enables when all questions answered. Free-text questions render inline input instead of using the main chat box

### Changed — Leonardo.ai Converted to 100% Browser-Based
- **Removed all API tools** — 4 browser tools replace 14 API tools. No API key required. Comprehensive UI map with 18 image models, 23 video models, 39 motion controls, and 3-layer style stacking. Skill modules expanded with full questionnaire flows

### Changed — Automation Studio Launch Flow
- **Inline panel replaces overlay modal** — Launch configuration renders directly inside the detail view. New "Run in" destination toggle for Floating vs Side Panel

### Changed — Focus Mode Zero-Resource Consumption
- **All event handlers paused in 3D and 2D views** — Pointer, keyboard, wheel, and camera input fully disabled during focus mode. Resize handlers intentionally left active

### Changed — Session Monitor Rewritten
- **Proper draggable/resizable window** — Replaces narrow fixed panel. Three tabs: Sessions (cards with uptime/PID), Agents (status badges/cost), Health (leak severity grouping with cleanup actions)

### Changed — Browser Screencast Optimizations
- **30fps frame cap** — Frames arriving faster than 33ms are dropped before decoding
- **Pause on minimize** — Minimized browser pills stop CDP screencast entirely
- **Focus-based throttling** — Non-focused browser windows throttle to ~2fps
- **5-minute idle timeout** — Auto-pause after inactivity; canvas interaction resumes
- **Server-side backpressure** — Clients with congested WebSocket buffers are skipped

### Changed — Window Close Behavior
- **Outside-click closing disabled** — All windows now close exclusively via ESC or close button. ESC key handlers added to Settings, Sessions, Help, Image Gallery, and Terminal dir picker

### Changed — Custom Dropdowns for Settings
- **Native `<select>` elements replaced** — All 4 Settings dropdowns converted to themed custom dropdown components for consistent cross-platform appearance

### Changed — Settings Add Project
- **Native OS folder picker** — Replaces custom inline folder browser that had no drive/volume switching on Windows
