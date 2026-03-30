# SynaBun Changelog

All notable changes to SynaBun are documented here. For detailed technical notes, see [changelog/CHANGELOG-raw.md](changelog/CHANGELOG-raw.md).

## [1.3.1] - 2026-03-30

### Fixed
- npm package now ships pre-built MCP server (`dist/`) so postinstall no longer requires TypeScript
- Fixed `bin` entry path that was stripped during publish

## [1.3.0] - 2026-03-29

### Added
- **Message queue system** for Claude Code sidepanel -- stack multiple messages while Claude is processing, with drag-to-reorder, inline editing, and auto-advance between turns
- **Notification click-to-navigate** -- clicking a notification now focuses the exact session or tab that triggered it, including OS banner click-through via service worker
- **Minimized pill checkmark icon** -- profile icon swaps to a green checkmark when a terminal pill's task completes

### Fixed
- **Permission spam in Claude Code sidepanel** -- events no longer leak through the buffer gate during active permission prompts; denying a permission now properly kills the running process and clears queued cards
- **AskUserQuestion card duplication** -- fixed buffer flush ordering and added DOM-level guard against rendering duplicate ask cards
- **Plan editing auto-implementing** -- edited plans now show a review card with Implement/Compact/Edit buttons instead of auto-sending to Claude
- **Session dropdown chevron** -- increased hit target size so the dropdown arrow is actually clickable
- **White dropdown backgrounds on Windows** -- added `color-scheme: dark` declaration so native form controls render in dark mode

### Changed
- **Permission card "Always" button** -- replaced checkbox with a dedicated one-click button: `[Always] [Allow] [Deny]`
- **Settings "Add Project"** -- now opens the native OS folder picker instead of a custom inline folder browser
- **Custom dropdowns** -- replaced all native `<select>` elements in Settings with themed custom dropdowns for cross-platform consistency

## [1.2.0] - 2026-03-28

### Added
- **Browser stream toggle** in Settings -- disable the screencast stream to eliminate ~50% CPU from the Chrome GPU process while keeping all MCP browser automation working
- **Multi-select checkbox distinction** -- `AskUserQuestion` multi-select options now show square checkboxes with a "Select all that apply" hint
- **Shift+Tab plan mode shortcut** in the Claude sidepanel input
- **Whiteboard multi-select** keyboard shortcut (`M` key)

### Fixed
- **Neural Interface memory leaks (11GB+)** -- added DOM pruning (600 node cap), message buffer cap (500), and event listener cleanup on panel close
- **Context gauge showing inflated values** -- gauge now uses correct per-turn token counts instead of cumulative values
- **Auto-compact detection** -- moved to per-turn token tracking so compaction drops are actually detected
- **Plan system "PLAN COMPLETE" card** -- fixed detection in `--print` mode where built-in tool results aren't emitted
- **Pencil tool rendering** -- screenshot capture now uses smooth bezier curves instead of polygonal line segments
- **Window Controls Overlay** -- fixed CSS specificity bug causing traffic light overlap; matched theme color to navbar

### Changed
- **Focus mode zero-resource consumption** -- 3D and 2D memory views now fully pause all event handlers and camera input when focus mode is active
- **Window header modernization** -- unified design language across 13+ window types with gradient backgrounds, softer borders, and ghost-style buttons
- **Batched AskUserQuestion submission** -- options toggle freely; a submit button with progress counter sends all answers at once

## [1.1.0] - 2026-03-27

### Added
- **Hook-side auto-recall** -- top 3 related memories are automatically injected into every substantive prompt via `additionalContext`
- **Edit plan in code editor** -- clicking "Edit plan" opens the file directly in the Neural Interface editor instead of re-entering plan mode

### Fixed
- **Duplicate AskUserQuestion cards** -- fixed dual control_request rendering from both proactive detection and CLI permission denial paths
- **File attachments not reaching Claude** -- fixed 5 separate issues preventing file-only sends, path chip cleanup, BTW interrupt flow, and visual feedback
- **Floating browser close button unresponsive after reconnection** -- fixed stale closure reference using ID-based lookup
- **Loop detection hijacking non-loop sessions** -- scoped loop detection to the owning terminal session only

### Changed
- **Recall settings redesign** -- replaced basic token budget with 4 recall profiles (Quick/Balanced/Deep/Custom) with fine-tune controls and impact indicator
- **Recall profile presets** -- new SVG icons, mouse-tracking radial glow, and icon-to-background hover effects

## [1.0.0] - 2026-03-26

### Added
- **Toolbar modernization** -- Apple-style unified frosted glass pill bars for both top-right navbar and bottom-right workspace toolbar
- **Notifications settings tab** -- dedicated settings panel with master toggle, sound controls, volume slider, OS banner toggle, action-only filter, and test button
- **Terminal context menu viewport clamping** -- menus no longer open outside screen bounds

### Fixed
- **Dropdown menus hidden behind terminal tray** -- fixed stacking context from `backdrop-filter`
- **Terminal context menu z-index** -- bumped above all terminal-layer elements
- **Notifications in Safari PWA** -- routed through service worker instead of direct `Notification` API

### Changed
- **Floating window borders** -- added visible thin border on all 8 floating window types
- **Offline page** -- transparent card layout with subtle command block styling

## [0.9.0] - 2026-03-25

### Added
- **Image gallery** -- floating draggable panel for browsing `data/images/` with search, type filters, sort, favorites, full lightbox with keyboard navigation, and "Add to Whiteboard" integration
- **Whiteboard shape picker** -- submenu with Rectangle, Circle, and Triangle presets; triangle shape support added
- **Cron-driven schedule system** -- create recurring automations with cron expressions, timezone support, day-of-week themes, 18 cron presets, and full CRUD API
- **Backdrop toggle button** -- eye icon on all windows to show/hide the backdrop overlay
- **Automation Studio icon picker** -- 13 new icons including social media platforms and AI logos

### Fixed
- **Whiteboard list items lost on reload** -- list content now properly syncs from DOM to model before persisting
- **Circle shape rendering** -- replaced polygonal approximation with proper SVG arc commands
- **Quick timer buttons** -- fixed undefined variable reference that silently prevented all clicks
- **Quick timer duplicates** -- added dedup check on WebSocket sync
- **Code editor line highlight misalignment** -- standardized all line heights to integer pixels
- **Sidepanel attach button** -- now accepts image files in addition to text/code files

### Changed
- **Browser viewer resize decoupled** -- resizing the preview window no longer changes the actual browser viewport
- **Browser screencast** -- 30fps frame cap, pause on minimize, focus-based throttling, 5-minute idle timeout
- **Window close behavior** -- outside-click closing disabled on all windows; ESC key handlers added where missing
- **Automation Studio launch** -- replaced overlay modal with inline panel; panel now closes after launching

## [0.8.0] - 2026-03-24

### Added
- **Multi-browser session isolation** -- each automation gets its own dedicated browser session with environment-based pinning
- **Multi-tab browser architecture** -- tabs per session with create/switch/close via REST and WebSocket
- **Floating move handle** for whiteboard text and list elements
- **LinkedIn jobs browser extractor** -- structured extraction from search results and homepage recommendations

### Fixed
- **Loop time cap silently clamped** -- raised from 60 to 480 minutes; iteration cap raised from 50 to 200
- **Automation Studio sidebar scroll reset** -- scroll position preserved on item click
- **Multi-loop cross-session leaks** -- added terminal session ownership tracking across all loop lifecycle hooks

### Changed
- **Leonardo.ai converted to 100% browser-based** -- removed all API tools; 4 browser tools replace 14 API tools with no API key required
- **Automation Studio launch destination** -- new "Run in" toggle for Floating vs Side Panel
- **Multi-loop coexistence** -- only stale loops are cleaned up; concurrent active loops preserved

## [0.7.0] - 2026-03-23

### Added
- **AskUserQuestion interactive cards** -- now render as clickable option buttons in the sidepanel instead of plain text
- **Multi-tab browser** -- dedicated tabs per session with REST and WebSocket APIs
- **Automation Studio launch destination** -- choose between floating window and side panel

### Fixed
- **`--allowedTools` join character** -- changed from space to comma for Windows compatibility
- **Browser not appearing after loop relaunch** -- added zombie session detection and WebSocket reconnect-once pattern

## [0.6.0] - 2026-03-22

### Added
- **Isolated agent system** -- spawn Claude Code as independent child processes with full session isolation, no hook interference, and cross-platform process management
- **Agent cards in Automation Studio** -- live-streaming output, tool call count, cost display, and stop/remove controls

### Fixed
- **Plan storage cross-session leak** -- plans are now matched by content instead of blindly picking the newest file
- **Image sharing pipeline** -- pasted/dropped images now properly reach Claude Code via temp files
- **Screenshot auto-paste** -- cross-platform support for macOS, Windows, and Linux
- **Clipboard operations** -- fallback for non-HTTPS contexts (LAN access)
- **Cost tracking** -- fixed navbar stuck at $0.00 and widget overwriting with monthly total
- **Agent launch dialog** -- fixed DOM-timing bug that silently broke all launch options

### Changed
- **Session Monitor** -- rewritten as a proper draggable/resizable window with Sessions, Agents, and Health tabs
- **Content negotiation** -- new markdown extraction endpoint for browser pages and direct HTTP fetch
- **Database tab** -- visual polish with section cards, stats grid, and progress bar styling

## [0.5.0] - 2026-03-21

### Fixed
- **Context gauge tooltip** -- switched to fixed positioning to escape overflow clipping
- **Browser not re-launching** -- fixed stale tab reuse, zombie session acceptance, and session Map cleanup race

## [0.4.0] - 2026-03-20

### Added
- **Auto backup system** -- scheduled ZIP backups to a user-chosen folder with configurable frequency and atomic writes

### Fixed
- **Session isolation leak** -- project/model/effort state no longer leaks between sidepanel tabs or browser tabs
- **Loop cross-session leaking** -- loop driver and hook scans now respect terminal ownership
- **macOS permission error on temp files** -- images now stored in project-local `data/images/` directory

## [0.3.0] - 2026-03-19

### Added
- **Shared frame renderer** -- latest-frame-wins rendering for browser screencast streams

### Fixed
- **Browser screencast freezing** -- replaced unbounded `Image()` creation with backpressure-aware renderer across all surfaces
- **Loop pending-claim failure** -- server now drives pending loops directly via PTY write

### Changed
- **Server-side screencast backpressure** -- WebSocket buffer check and default frame skip
- **Resize debounce** -- 200ms debounce on browser viewer resize events

## [0.2.0] - 2026-03-18

### Fixed
- **Loop history accumulation** -- loop state files now deleted immediately on end/stop instead of lingering
