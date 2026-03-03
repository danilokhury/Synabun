# Changelog

All notable changes to SynaBun will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.5.0] - 2026-02-25

### Added

**Focus Mode Whiteboard**
- Full-featured whiteboard in Focus Mode — 6 tools: Select, Text, Arrow, Shape, Pencil, Image Paste
- **Text tool** — click canvas to create hand-drawn style text cards (Caveat font), contenteditable with auto-height
- **Arrow tool** — click-click placement with bezier curve preview, anchor snapping to element edges (30px threshold), curved arrowheads
- **Shape tool** — hand-drawn SVG shapes (rectangle, pill, circle) with seeded PRNG wobble for a consistent sketched look per element; double-click cycles subtypes
- **Pencil tool** — smooth freehand drawing with Ramer-Douglas-Peucker point simplification and Catmull-Rom → cubic bezier conversion
- **Image paste** — Ctrl+V reads clipboard images, compresses (max 1920px, JPEG 0.8), places centered on canvas
- **Undo/Redo** — 50-entry stack, Ctrl+Z / Ctrl+Shift+Z, supports all operations including multi-element actions
- **Copy/Paste** — Ctrl+C copies selected elements, Ctrl+V pastes with offset
- **Floating context menu** — glassmorphic popover above selected elements with Duplicate, Copy, Delete actions
- **Multi-select** — marquee (rubber band) selection by dragging on empty canvas, Shift-click additive selection, Ctrl+A to select all
- **Multi-drag** — dragging any selected element moves all selected elements together (including arrows and pen strokes)
- **Multi-delete** — Delete/Backspace removes all selected elements at once
- **Multi-copy/paste** — Ctrl+C/V works on entire selection with offset positioning
- **Multi-context menu** — count badge with "Duplicate All" / "Delete All" buttons
- **Color picker** — applies color to all selected elements simultaneously
- **Workspace persistence** — whiteboard elements saved/restored per workspace with debounced storage (600ms)
- **Zoom-compensated creation** — text, images, and paste offsets scale inversely with zoom so elements appear at consistent screen size

**Session Sharing & Invitation System**
- New Share button in `#topright-controls` toolbar with session count badge
- Invite key generation — auto-generate (`synabun_inv_` + 48 hex chars, 288-bit entropy) or custom password (min 6 chars)
- Standalone auth page at `/invite` — dark glassmorphic design, key input with pre-fill from URL fragment (`#key`)
- Cookie-based session auth — `HttpOnly` cookie with `SameSite=None; Secure`, 24-hour TTL, validated per-request
- Cloudflare tunnel start/stop directly from the Share dropdown — play/stop button with spinning animation during startup, auto-polling for tunnel URL
- Custom proxy support — toggle between Cloudflare tunnel and user-supplied base URL (ngrok, custom domain, VPS reverse proxy)
- Invite URL generation — copies tunnel/proxy URL with optional `#key` fragment for one-click authentication
- Key rotation — generating a new key automatically revokes all existing sessions
- Session management — active session count display, "Revoke All" button
- Permission-controlled Neural Interface access for authenticated invitees — graph and explorer always available, terminal/browser/whiteboard/memories/cards/skills gated by owner-configured permissions
- WebSocket upgrade handler expanded to allow cookie-authenticated connections through tunnel middleware
- 6 new REST endpoints: `GET /api/invite/status`, `POST /api/invite/key`, `DELETE /api/invite/key`, `DELETE /api/invite/sessions`, `PUT /api/invite/proxy`, `POST /invite/auth`

**Real-time Multi-Client Sync**
- `/ws/sync` WebSocket channel — all connected Neural Interface clients receive live data-mutation broadcasts
- Automatic graph and category refresh within 300ms of any change by another client
- Broadcasts on all 10 data-mutating endpoints: memory update/trash/delete/restore, category create/update/delete, trash purge, category logo upload/remove
- Debounced `data:reload` — rapid mutations (e.g. bulk operations) coalesced into a single refresh cycle
- Auto-reconnect with 5-second interval on disconnect

**Bidirectional Card Sync**
- Memory detail cards sync in real-time across all session participants — open, close, move, resize, compact, and expand
- Client-originated messages relayed through the server to all other connected clients
- `_isRemoteCardOp` echo prevention flag — same pattern as whiteboard's `_isRemoteUpdate`
- Remote compact/expand applied instantly without animation for responsiveness
- Terminal session list sync — new sessions auto-connect on remote clients, deleted sessions auto-close

**Granular Guest Permissions**
- Owner-controlled feature toggles: Memories, Memory Cards, Whiteboard, Terminal, Skills Studio, Browser
- Permission toggle UI in Share dropdown — pill-style switches with teal (#64FFDA) active state, optimistic toggling with revert on failure
- Persisted to `data/invite-permissions.json`, included in system backups
- Server-enforced — admin-only middleware blocks guest access to 14 sensitive endpoint prefixes (settings, connections, setup, invite management, MCP config, keybinds, CLI)
- Feature permission middleware blocks guest mutations (POST/PUT/PATCH/DELETE) for disabled features; read (GET) always allowed
- WebSocket upgrade blocking — guests denied `/ws/terminal/` and `/ws/browser/` when permission is off
- Relay permission checks — server validates guest permissions before broadcasting card and terminal sync messages
- Client-side awareness — whiteboard skips sync sends, detail cards skip sync sends, terminal guards new-session creation
- Share dropdown hidden entirely for guest sessions
- `permissions:changed` broadcast — real-time permission updates pushed to all clients when owner toggles

**Multi-Card Detail Panel**
- Converted from single `#detail-panel` to dynamic `.detail-card` spawn system — each memory click opens an independent card
- Cards are draggable, resizable, compactable (compact mode: 240px, expanded: 480px), and closeable
- Z-index management — clicking a card brings it to front
- Cascade positioning — each new card offset by 30px from previous
- 20-card soft limit with console warning
- Full persistence via localStorage — saves positions, sizes, compact/expanded state per memory
- Restored on boot after data loads
- Fade-in + scale entrance animation

**Centralized Keyboard Shortcuts**
- Single global dispatcher replacing 8 hardcoded listeners across 4 modules
- Modules register actions via `registerAction(actionId, handler)` — O(1) combo-to-action dispatch
- Configurable keybind modal — click-to-record UX with pulse animation, conflict detection with swap, unbind, reset-to-defaults
- Server persistence — `data/keybinds.json` with `GET/PUT /api/keybinds` endpoints
- Default keybinds: `C` categories, `K` skills, `T` terminal, `F` explorer, `/` search, `?` help, `M` minimap (2D)
- CLI launch keybinds — launch Claude, Codex, or Gemini terminals from keyboard with project picker and auto-detach to floating window
- Brand icons (Claude blue, Codex green, Gemini gold) displayed in keybind editor
- Keycap-style button rendering in modal

**2D Visualization Performance**
- Viewport culling — cards, links, glows, and labels skip rendering when off-screen
- Link batching — 43k links batched into single `beginPath/stroke` call (was 43k individual draw calls)
- Neighbor adjacency map — `_neighborMap` built once in `applyGraphData()`, focus-mode dimming O(1) per card
- Text cache — wrapped text only recalculated on content change
- DPR-aware canvas — buffer dimensions scaled by device pixel ratio, all coordinate transforms account for DPR
- Background gradient cached and only recreated on resize

**2D Layout Overhaul**
- Two-pass layout algorithm — compute radii first, then re-position with proper spacing
- Increased inner radius (140px parent, 100px child) to prevent card-label overlap
- 6-pass collision resolution with 80px padding, including cross-parent collision handling
- Orbital clustering with proper radius-based child positioning

**Enhanced Search**
- Non-matching memories vanish completely (opacity 0) instead of dimming
- Matching memories visually boosted — 1.3-1.8x scale, colored glow, border highlights
- Links filtered — hide links where neither endpoint matches the search
- All three 2D LOD levels (full card, simple card, dot) now properly filter by search

**Minimap (2D)**
- Drag-to-reposition — drag minimap container anywhere on screen with 4px dead zone and viewport clamping
- Toggle fix — CSS class mismatch between `.hidden` and `.visible` resolved, `drawMinimap()` no longer overrides toggle state
- Keybind support — `M` key toggles minimap (configurable in keybind editor)
- Focus mode integration — minimap auto-hides when entering Focus Mode, restores on exit

**Terminal Peek Dock**
- Thin 28px fixed bar at bottom of screen when terminal panel is hidden but sessions exist
- Shows miniature session tab pills matching active terminal sessions
- Click to reopen terminal panel

### Changed

- Visualization toggle uses smooth crossfade animation (0.45s opacity transition) instead of instant `display:none`
- Visualization toggle icon changed from sparkles to Lucide eye icon
- Workspace dropdown restyled — removed `.glass` class, explicit glassmorphic styling matching toolbar buttons (`rgba(20,20,24,0.82)`, blur, 12px radius)
- Category sidebar header reworked to match detail-panel pattern — unified drag-handle, SVG icon action buttons (select-all, deselect-all, label-toggle, label-size, pin)
- Deselecting categories now immediately hides associated links (was only hiding nodes)
- Label visibility toggle properly checked in both 3D and 2D render loops (was only applied in sidebar UI)
- Dropdown menus restyled — 8px radius, keyboard-key shortcut badges, 5px padding, refined separators
- Explorer keybind changed from `E` to `F`

### Fixed

- Whiteboard workspace persistence — `restoreWhiteboardSnapshot()` now handles null snapshots from pre-whiteboard workspaces, cancels pending persist timers, and flushes in-progress text edits before snapshot
- Whiteboard text at non-1x zoom — dimensions and font size now scale inversely with zoom level
- Minimap viewport rectangle accounts for DPR-scaled offsets
- Category sidebar toggle syncs active state with close button

---

## [1.4.0] - 2026-02-24

### Added

**Embedded Browser (Playwright CDP)**
- Browser tab in the terminal panel — powered by `playwright-core`, renders live via CDP screencast frames on canvas
- Stealth fingerprint cloning — auto-captures User-Agent, Accept-Language, Client Hints, screen dimensions, device pixel ratio, and timezone from the real browser and applies them to the headless Chromium instance
- CDP stealth injections — `navigator.webdriver=false`, fake plugins array, patched Permissions API, `chrome.runtime` stub, Playwright marker cleanup
- Claude Code bridge — `GET /api/browser/sessions/:id/claude-connect` returns ready-to-use MCP config with `--cdp-url` for Playwright MCP to control the same browser instance
- Navigation controls — address bar with back/forward/reload buttons, URL input, mouse and keyboard event forwarding from canvas to browser
- Browser session reconnection — sessions survive page refresh with 5-minute grace period
- Browser REST API — `POST/GET/DELETE /api/browser/sessions`, navigation endpoints, screenshot, CDP WebSocket endpoint
- WebSocket screencast — `/ws/browser/:id` for real-time JPEG frame streaming and input forwarding

**Granular Browser Configuration (Settings > Setup > Browser)**
- 11 collapsible sub-sections exposing every Playwright context option:
  - Executable — Chrome/Chromium path (auto-detect), headless mode, channel selector, slowMo, timeout, navigation timeout, extra Chromium launch flags
  - Viewport & Display — viewport/screen width+height, deviceScaleFactor, isMobile, hasTouch
  - Identity & Headers — userAgent, Accept-Language, locale, timezoneId, extra HTTP headers (JSON), stealth fingerprint toggle
  - Geolocation — enable toggle with latitude, longitude, accuracy
  - Permissions — 15 permission checkboxes (geolocation, camera, microphone, clipboard, MIDI, sensors, notifications, etc.)
  - Network & Proxy — offline mode, proxy server/bypass/auth, HTTP credentials
  - Appearance — colorScheme, reducedMotion, forcedColors
  - Scripting & Security — JavaScript enabled, ignore HTTPS errors, bypass CSP, accept downloads, strict selectors, service workers
  - Storage & Cookies — persist toggle, storage file path, clear on startup
  - Recording — video (directory, resolution), HAR (path, content policy, mode, URL filter)
  - Screencast — format (JPEG/PNG), quality slider, max resolution, frame skip
- Save/Reset buttons with config persistence to `data/browser-config.json`
- All saved options applied to `chromium.launch()` and `browser.newContext()` on session creation

**Cookie & Storage State Persistence**
- Optional save/restore of cookies, localStorage, and sessionStorage between browser sessions
- `context.storageState()` called on session close when persistence is enabled
- Storage state restored from file on new session creation
- Configurable via Settings > Setup > Browser > Storage & Cookies

**CLI Terminal**
- Detachable floating terminal — individual tabs can be detached into free-floating, draggable, resizable windows
- Per-tab floating window controls — pin (always-on-top), dock-back, close
- Pin button on main panel header — prevents accidental close
- Peek dock — thin 28px bar at bottom shows miniature session pills when terminal panel is hidden
- 4 xterm addons — SearchAddon, WebglAddon, CanvasAddon, Unicode11Addon (from esm.sh CDN with graceful fallback)
- GPU rendering — WebGL renderer with Canvas fallback, automatic context loss recovery
- Keyboard shortcuts — Ctrl+Shift+C copy, Ctrl+V paste, Ctrl+F search, Ctrl+Shift+F close search
- Copy-on-select — auto-copy selection to clipboard
- Image paste — paste images from clipboard into terminal (saved as temp file, path written to stdin)
- Right-click context menu — Copy, Paste, Select All, Clear, Find
- Inline search bar — Ctrl+F with prev/next navigation and match highlighting
- CLI launch keybinds — `1`/`2`/`3` to launch Claude/Codex/Gemini (configurable in keybind editor)
- Workspace terminal state — terminal panel position, sessions, and floating tab positions saved/restored per workspace

**Settings**
- Multi-provider Setup tab — dedicated collapsible sections for Claude, Gemini, and Codex with MCP toggles, config previews, CLI copy, and ruleset previews
- Gemini MCP registration — `POST/DELETE /api/setup/gemini/mcp` writes `~/.gemini/settings.json`
- Codex MCP registration — `POST/DELETE /api/setup/codex/mcp` writes `~/.codex/config.toml` via TOML helpers
- GEMINI.md and AGENTS.md ruleset preview and copy alongside existing CLAUDE.md
- Terminal tab — CLI executable path configuration with auto-detect for Claude, Codex, Gemini

**UI / UX**
- Settings modal extracted into `ui-settings.js` ES module (~2400 lines from monolithic index.html)
- Connections tab redesign — 7 collapsible sections (Hooks, Features, Greeting, Setup, External Access, Bridges, Skills)
- Memory Explorer docked sidebar — converted from floating overlay to viewport-splitting sidebar with resize handle
- Skills Studio — full skill editor with tab system, custom dropdown, focus mode, welcome screen with SynaBun logo, type icons (SVG), filter pills, stats cards
- 3D/2D view toggle pill in title bar with session handoff via sessionStorage
- Brand color corrections — Claude=#D4A27F, Gemini=#669DF6, Codex=#74c7a5
- Keybind editor restyled — dark background, keycap-style buttons, CLI brand icons

### Fixed

- Browser tab zoom/blur on minimize+restore — ResizeObserver now guards against sub-100px dimensions, `visibilitychange` listener re-sends correct size on restore, canvas buffer only resets when frame dimensions actually change
- Flyout clipped by overflow:hidden — changed from `position: absolute` to `position: fixed` with dynamic positioning
- Floating tab header invisible — increased background opacity and button contrast
- Scrollbar hidden by canvas z-index — added `z-index: 10 !important` to `.xterm-viewport`
- Pin button SVG invisible — added stroke alongside fill for open path segments
- Terminal scroll lag — disabled xterm smooth scrolling (60ms → 0)
- Floating tab resize corners too small — increased edge hit zone from 6px to 10px
- Off-screen panel recovery — auto-recenter detached panels that were dragged beyond viewport bounds

---

## [1.3.0] - 2026-02-24

### Changed

**Contributions**
- Pull requests are no longer accepted — the repository is maintained solely by the SynaBun authors
- `CONTRIBUTING.md` rewritten to reflect issues-only contribution model while retaining development setup documentation for forkers
- Added `.github/PULL_REQUEST_TEMPLATE.md` explaining the no-PR policy
- Added `.github/ISSUE_TEMPLATE/bug_report.md` and `.github/ISSUE_TEMPLATE/feature_request.md` for structured issue reporting

**Licensing**
- Added `LICENSE-COMMERCIAL.md` documenting the Open Core model — Apache 2.0 core with premium features available under commercial license
- Added `license`, `repository`, and `author` fields to root `package.json`
- Updated README License and Trademark Notice sections
- Bumped version to 1.3.0

---

## [1.2.0] - 2026-02-23

### Added

**Claude Code Hooks**
- **User Learning (Directive 5)** — autonomous observation of user communication patterns, preferences, and behavioral singularity across sessions. Stored in `user-profile/communication-style` category with `project: "global"`.
- **Priority 7: User Learning Nudge** in `prompt-submit.mjs` — quiet-only, one-time nudge after N interactions (configurable). Only fires when no higher-priority trigger matched.
- **Step D in Directive 1** — optional `recall` of `user-profile` memories at session start for immediate adaptation.
- `userLearning` and `userLearningThreshold` feature flags in `hook-features.json`.
- `PUT /api/claude-code/hook-features/config` endpoint — set non-boolean config values (thresholds, etc.)

**Neural Interface**
- User Learning toggle and threshold input in Settings > Connections > Features panel

**Categories**
- `user-profile` parent category — knowledge about the user as a person
- `communication-style` child category — tone, formality, verbosity, language patterns, text quirks

---

## [1.1.0] - 2026-02-20

### Added

**MCP Server**
- `restore` tool — undo soft-deleted memories (clears `trashed_at` flag)
- `sync` tool — detect stale memories by comparing SHA-256 file hashes against stored checksums
- `file-checksums.ts` service — SHA-256 hashing for the sync tool
- HTTP MCP transport (`http.ts`, `preload-http.ts`) — serve MCP tools over HTTP in addition to stdio
- Per-connection category files (`custom-categories-{connId}.json`) — categories are now scoped per Qdrant connection
- Display settings (`display-settings.json`) — configurable `recallMaxChars` for MCP response truncation
- Dynamic tool schemas — 4 tools (`remember`, `recall`, `reflect`, `memories`) auto-update their parameter schemas when categories change or the active connection switches

**Neural Interface**
- Trash management — `GET /api/trash`, `POST /api/trash/:id/restore`, `DELETE /api/trash/purge` endpoints; full trash panel UI
- Memory Sync UI — model selector (Haiku/Sonnet/Opus) for AI-assisted stale memory rewriting; `GET /api/sync/check` endpoint
- Category logos — upload/delete logos for parent categories (`POST/DELETE /api/categories/:name/logo`); rendered on 3D sun nodes with aspect-ratio-aware sizing
- Category export — `GET /api/categories/:name/export` downloads all memories in a category as Markdown
- OpenClaw Bridge — full integration reading OpenClaw workspace files as ephemeral in-memory nodes; 4 API endpoints (`/api/bridges/openclaw/*`); 3 parsers (MEMORY.md, daily logs, workspace configs)
- Backup & Restore — `POST /api/connections/:id/backup` creates Qdrant snapshots; `POST /api/connections/:id/restore` restores them; standalone restore endpoint for new instances
- Multi-instance Docker management — `POST /api/connections/docker-new` spins up new Qdrant containers; `POST /api/connections/start-container` restarts stopped containers; `GET /api/connections/suggest-port` suggests available ports
- Display settings endpoints — `GET/PUT /api/display-settings`
- Claude Code MCP management — `GET/POST/DELETE /api/claude-code/mcp` for `.claude.json` registration
- Hook feature flags — `GET/PUT /api/claude-code/hook-features` for toggling hook behaviors (e.g., `conversationMemory`)
- Ruleset endpoint — `GET /api/claude-code/ruleset` returns CLAUDE.md sections in Claude/Cursor/generic format
- Skill installation — list and install Claude skills from `skills/` directory via the UI
- Docker Desktop launcher — `POST /api/setup/start-docker-desktop` for Windows
- 2D visualization variant (`index2d.html`)
- Tunnel security — blocks Cloudflare tunnel traffic except to `/mcp` endpoint
- `GET /api/stats` now returns `trash_count` alongside existing fields

**Claude Code Hooks**
- `pre-compact.mjs` (PreCompact) — captures session transcript before context compaction; writes cache to `data/precompact/`
- `stop.mjs` (Stop) — enforces memory storage by blocking response if session isn't indexed or edits aren't remembered; max 3 retries
- `post-remember.mjs` (PostToolUse) — tracks Edit/Write/NotebookEdit call counts; clears enforcement flags when memories are stored; nudges at every 3rd unremembered edit
- Conversation memory system — auto-indexes sessions on compaction via SessionStart + Stop hook coordination
- Multi-tier recall triggers in `prompt-submit.mjs` — 6 priority tiers with non-English detection and Latin catch-all

**Claude Code `/synabun` Command**
- `/synabun` command hub — single slash command with interactive menu for Brainstorm Ideas, Audit Memories, Memory Health, and Search Memories
- Audit Memories — 6-phase interactive validation: landscape survey, checksum pre-scan, bulk retrieval, parallel semantic verification (batches of 5), interactive classification (STALE/INVALID/VALID/UNVERIFIABLE), audit report capture
- Brainstorm Ideas — multi-round recall with 5 query strategies, idea synthesis with memory provenance

**Infrastructure**
- Namespaced multi-instance `.env` format (`QDRANT__<id>__*`, `EMBEDDING__<id>__*`, `BRIDGE__<id>__*`)
- Auto-migration from `connections.json` to `.env` (old file renamed to `.bak`)
- Memory seed data (`memory-seed/`) — 28 pre-written documentation memories in 6 categories for bootstrapping
- Vitest test suite (`.tests/`) — 6 unit tests covering all 11 tools + 5 scenario/cost benchmark tests
- Runtime data directory (`data/`) — hook enforcement flags, feature toggles, session caches

### Changed
- `forget` is now a soft delete (sets `trashed_at` timestamp) instead of permanent deletion
- `connections.json` replaced by namespaced `.env` variables as the source of truth for connections
- Category definitions are now per-connection (`custom-categories-{connId}.json`) instead of global
- Docker volume renamed from `qdrant-storage` to `synabun-qdrant-data`

---

## [1.0.0] - 2026-02-16

### Added

**MCP Server**
- 9 MCP tools: `remember`, `recall`, `forget`, `reflect`, `memories`, `category_create`, `category_update`, `category_delete`, `category_list`
- Semantic search with cosine similarity, time decay (90-day half-life), project boost (1.2x), and access frequency scoring
- User-defined hierarchical categories with prescriptive routing descriptions
- Dynamic schema refresh — category changes propagate to AI tool schemas without server restart
- Multi-project support with automatic project detection from working directory
- Access tracking (fire-and-forget) for recall frequency boosting
- Importance shield — memories with importance 8+ are immune to time decay

**Neural Interface**
- Interactive 3D force-directed graph visualization (Three.js + ForceGraph3D)
- Memory detail panel with inline editing (content, tags, category)
- Semantic search bar
- Category sidebar with filtering, color management, and hierarchy editing
- Multi-connection support — switch between Qdrant instances at runtime
- Settings panel with masked API key display
- Graphics quality presets (Low, Medium, High, Ultra)
- Resizable, draggable, pinnable panels with localStorage persistence

**Onboarding**
- Guided setup wizard with dependency checks
- One-command setup (`npm start`) — installs deps, builds, launches, opens browser
- 11 embedding provider support (OpenAI, Google Gemini, Ollama, Mistral, Cohere, and more)
- Automatic `.mcp.json` generation for Claude Code registration
- CLAUDE.md memory instructions injection

**Claude Code Hooks**
- SessionStart hook — injects category tree, project detection, and behavioral rules
- UserPromptSubmit hook — nudges AI to check memory before responding to recall-worthy prompts

**Claude Code `/synabun` Command**
- `/synabun` skill — initial command hub with brainstorming capability via multi-round recall with 5 query strategies (direct, adjacent, problem-space, solution-space, cross-domain), idea synthesis with memory provenance, and auto-save to `ideas` category

**Infrastructure**
- Docker Compose setup for local Qdrant with API key authentication
- Multi-connection registry (`connections.json`) for Qdrant instance management
- Cross-platform support: Windows, macOS, Linux, WSL
- Terminal UI (`tui.ts`) for interactive memory management
