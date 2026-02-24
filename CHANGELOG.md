# Changelog

All notable changes to SynaBun will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2026.02.24] - 2026-02-24

### Changed

**Distribution Sanitization**
- Standardized all GitHub URLs to `github.com/danilokhury/Synabun` (from `ZaphreBR/synabun`)
- Emptied `PROJECT_MAP` in `config.ts` and `session-start.mjs` with commented usage examples
- Genericized all hardcoded personal paths (`J:\Sites\...`, `C:\Users\danil\...`) across docs, tests, and source files
- Replaced all `criticalpixel`/`ellacred` project references with generic examples (`my-project`, `test-project`)
- Reset `custom-categories-default.json` to empty defaults

### Removed
- 7 dev utility files (`neural-interface/_*.cjs`, `_*.py`, `_*.json`, `_*.txt`)
- 8 user-specific data files from `mcp-server/data/` (personal category configs, display settings)
- `.claude/settings.local.json` (user-specific IDE config)
- `criticalpixel.png` from category logos

### Fixed
- `.gitignore` negation pattern: changed `mcp-server/data/` to `mcp-server/data/*` so the `!custom-categories-default.json` exception works correctly

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
