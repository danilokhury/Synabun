# Changelog

All notable changes to SynaBun will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
