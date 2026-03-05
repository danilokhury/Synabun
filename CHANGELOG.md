# SynaBun Changelog: DistBun → Dev

**158 files changed** | ~32,900 insertions | ~31,700 deletions
**Branches:** `DistBun` (v2026.02.24) → `Dev` (v1.3.0)

---

## 1. Database Migration: Qdrant → SQLite

The single largest architectural change — SynaBun no longer requires Qdrant (or Docker) for vector storage. Everything runs on a local SQLite database with embedded vector search.

### Removed
- **Qdrant service** (`mcp-server/src/services/qdrant.ts`) — 283 lines deleted. All Qdrant client code, collection management, CRUD operations, system metadata storage, and category sync removed.
- **OpenAI embeddings service** (`mcp-server/src/services/embeddings.ts`) — 33 lines deleted. External API-based embedding generation via OpenAI removed entirely.
- **Docker Compose** (`docker-compose.yml`) — 20-line Qdrant container definition deleted.
- **Docker setup in `setup.js`** — `checkDocker()` function removed, Docker path scanning for Windows removed.
- **Docker API endpoints** — `dockerNewConnection`, `startDockerDesktop`, `setupDocker` API functions removed from `api.js`.
- **Qdrant-specific config** — All `QDRANT_*`, `EMBEDDING_*`, `OPENAI_*` environment variables removed from `.env.example` and config system.
- **Multi-connection architecture** — `getActiveConnection()`, `getActiveConnectionId()`, `getActiveEmbeddingConfig()`, connection switching, `.env` watcher for connection changes — all removed.
- **Memory seed docs** — `architecture/03-qdrant-integration.md` and `setup/20-docker-setup.md` deleted.

### Added / Changed
- **SQLite storage layer** (`mcp-server/src/services/sqlite.ts`) — Now the sole storage backend. Vectors stored as Float32Array BLOBs, cosine similarity computed in JS. New `kv_config` table for key-value settings.
- **Local embeddings** (`mcp-server/src/services/local-embeddings.ts`) — Uses `@huggingface/transformers` (Xenova/all-MiniLM-L6-v2, 384 dimensions) for fully offline embedding generation. Background warmup on startup.
- **Simplified config** (`mcp-server/src/config.ts`) — Reduced from 144 to 70 lines. Single `dataDir` + `sqlite.dbPath` + `embedding` config. Project detection rewritten to use `claude-code-projects.json` file with path-prefix matching instead of hardcoded `PROJECT_MAP`.
- **Categories service** — Single categories file (`custom-categories.json`) instead of per-connection files (`custom-categories-{connId}.json`). Source of truth changed from Qdrant to SQLite.
- **File checksums** — `hashFile()` now resolves paths from `process.cwd()` instead of computing project root from `import.meta.dirname`.
- **Node.js requirement** — Bumped from 18+ to **22+** (required for `node:sqlite` built-in module).
- **Dependencies** — Removed `@qdrant/js-client-rest` and `openai`. Added `@huggingface/transformers`.
- **Migration script** — New `mcp-server/src/scripts/migrate-qdrant-to-sqlite.ts` (npm script: `migrate`).

### Impact on `.env.example`
Before (39 lines of Qdrant/OpenAI config) → After (16 lines):
```env
# SQLITE_DB_PATH=mcp-server/data/memory.db
# COLLECTION_NAME=claude_memory
```

---

## 2. MCP Tool Changes

### Consolidated
- **Category tools** — Four separate tools (`category_create`, `category_delete`, `category_update`, `category_list`) merged into a single `category` tool with `action` parameter (create/update/delete/list).

### New Tools
- **`loop`** — Autonomous loop execution tool with `action: start/stop/status`. Enables multi-iteration automated tasks with iteration caps and time limits.
- **`tictactoe`** — Easter egg game with `action: start/move/state/end`. Server-side endpoints added to neural-interface service.

### Modified
- **`recall`** — Filter translation renamed from `QdrantFilter` to `MemoryFilter`. Internal references updated from Qdrant to SQLite.
- **`remember`** — Import paths switched from Qdrant to SQLite services.
- **`reflect`** — Import paths switched from Qdrant to SQLite services.
- **`forget` / `restore` / `memories`** — Minor import path updates.
- **`sync`** — Updated to work with SQLite storage. Memory search/retrieval calls redirected.
- **`browser_evaluate`** — `script` parameter now optional; new `expression` alias added for Playwright compatibility.
- **`browser_click`** — Description expanded with TikTok selectors (like, comment, share, follow, Studio, upload) and WhatsApp Web selectors (send, attach, emoji, voice, navigation, status).
- **`browser_fill`** — Description expanded with TikTok search and WhatsApp search selectors.
- **`browser_type`** — Description expanded with TikTok comment flow (DraftJS editor, step-by-step), WhatsApp message compose, and WhatsApp status text composer.
- **`browser_snapshot`** — Description expanded with TikTok scoping (article, search results, Studio) and WhatsApp scoping (chat list, message view).
- **`browser_scroll`** — Description expanded with TikTok feed, comment panel, Studio table, WhatsApp chat list, and message history selectors.
- **`browser_upload`** — Description expanded with TikTok Studio upload flow.

### New Browser Extract Tools
- **`browser_extract_tiktok_videos`** — Extracts visible TikTok For You/Following feed videos as structured JSON (handle, videoUrl, caption, likes, comments, saves, shares, music). Uses global state + DOM merge.
- **`browser_extract_tiktok_search`** — Extracts TikTok search result videos (videoUrl, handle, profileUrl, caption, views).
- **`browser_extract_tiktok_studio`** — Extracts TikTok Studio content list (title, url, date, privacy, stats).
- **`browser_extract_tiktok_profile`** — Extracts TikTok profile info + video grid (name, handle, bio, followers, following, likes, videos).
- **`browser_extract_wa_chats`** — Extracts WhatsApp Web sidebar chats (name, lastMsg, time, unreadCount, muted, pinned).
- **`browser_extract_wa_messages`** — Extracts WhatsApp message history from open chat (sender, time, date, direction, text, dataId).

### Server Instructions
- MCP server now includes `instructions` in the server config, providing tool group reference for Claude's context.

---

## 3. Neural Interface (TUI/Web Dashboard)

### Embedded Browser (New Feature)
- **Playwright CDP integration** — Browser tabs powered by `playwright-core` with stealth fingerprinting, screencast rendering via CDP, and session reconnection.
- **Browser session API** — Full REST API: create/delete sessions, navigate, back/forward/reload, CDP endpoint access.
- **Browser tab UI** — Navigation bar with URL input, back/forward/reload buttons, live screencast display.
- **Browser menu entries** — New "Apps" menu with Browser, YouTube, Discord, X (Twitter), WhatsApp launchers with keyboard shortcuts.

### Floating Terminals (Major Enhancement)
- **Detachable terminal windows** — Terminals can be detached from the main panel into floating, resizable, pinnable windows.
- **Drag/resize/pin** — Full window management with drag handles, resize grips, and pin-to-top.
- **Peek dock** — Minimized terminals shown in a dock tray at the bottom.
- **GPU rendering** — WebGL/Canvas rendering options for terminal output.
- **Inline search** — Search within terminal output.
- **Context menu** — Right-click context menu with copy, paste, select-all.
- **Copy-on-select** — Automatic clipboard copy when selecting text.
- **Image paste** — Paste images directly into terminal.
- **CLI launch keybinds** — Keyboard shortcuts for launching Claude Code, Codex, Gemini, and Shell terminals.
- **File tree sidebar** — New file browser panel alongside terminal.
- **Git branch management** — Branch listing and checkout from terminal UI.

### Terminal Links (New Feature)
- **Link terminals** — Connect multiple terminal sessions together for coordinated operations.
- **Link API** — Full REST API: create/delete/update links, send messages, pause/resume/nudge.
- **Link menu** — "Link Terminals" option in Apps menu.

### Loop System (New Feature)
- **Autonomous loop execution** — Multi-iteration automated tasks launched from the UI.
- **Loop templates** — Create, save, import/export reusable loop configurations.
- **Loop history** — Track past loop executions with completion data.
- **Browser enforcement** — Loops can require the SynaBun browser, blocking fallback to external tools.
- **Human blocker detection** — Automatic pause when the browser encounters login/CAPTCHA/2FA walls.
- **Time and iteration caps** — Hard limits (50 iterations / 60 minutes) to prevent runaway loops.

### Invite / Session Sharing (New Feature)
- **Guest access** — Generate invite keys for read-only or limited access to the Neural Interface.
- **Permission system** — Granular permissions (memories, cards, browser access) for guest sessions.
- **Proxy configuration** — Configurable reverse proxy settings for external access.
- **403 handling** — Global forbidden event dispatch with toast notifications for guests.

### Settings Overhaul
- **Restructured tabs** — Settings panel reorganized from 6 tabs (Server, Connections, Collections, Projects, Memory, Interface) to 8 tabs (General, Setup, Terminal, Database, Recall, Projects, Connections, Interface).
- **11 collapsible sections** — Granular browser config UI with collapsible sections.
- **Multi-provider setup** — Configuration for Claude, Gemini, and Codex providers.
- **Cookie/storage persistence** — Browser session persistence settings.
- **Extracted module** — Settings logic extracted into dedicated `ui-settings.js` module (2,900+ lines of new/refactored code).

### Menu Restructure
- **Apps menu** (new) — Replaces Terminal menu. Contains Claude Code, Codex CLI, Gemini CLI, Shell, Browser, YouTube, Discord, X, WhatsApp, Command Runner, Link Terminals, Show Terminal toggle.
- **Resume menu** (new) — Claude Code session resume functionality.
- **Automations menu** (new) — Automation Studio, New Automation, Import.
- **Games menu** (new) — Tic Tac Toe.
- **View > Graph menu** — Added node limit control (500, 1000, 2000, 4000, All).
- **Tutorial button** — New help/tutorial toggle in title bar.

### Whiteboard (New Feature in Focus Mode)
- **6 drawing tools** — Select, Text (Caveat font), Arrow (bezier curves), Shape (hand-drawn wobble), Pencil (RDP simplification + Catmull-Rom curves), Image Paste.
- **Full editing** — Undo/Redo (50 entries), Copy/Paste, Multi-select (marquee + shift-click), Multi-drag, Multi-delete, Floating context menu.
- **Color picker** — Glassmorphic color selection panel.
- **Arrow layer** — SVG arrow overlay with anchor snapping and bezier preview.

### 3D Visualization Changes
- **Floor depth** — `FLOOR_Y` changed from -200 to -500 (deeper scene).
- **Bloom settings** — Bloom strength increased (0.2→0.35), threshold increased (0.5→1.0) for subtler glow.
- **Graph proxy** — Camera system refactored to use graph proxy object instead of direct ForceGraph3D instance.
- **Node limit** — Configurable node render limit (View > Graph menu).
- **GFX presets** — All presets updated for new visualization style.

### Games UI
- **Session resume** — Claude Code session listing and resume functionality integrated into the UI.
- **Session indexing** — Background session indexing with start/cancel/status API.
- **Search by category** — Memory search filtered by category endpoint.

### Detail Panel (Memory Cards)
- **Guest read-only mode** — Hide edit/delete/move buttons for guest users without memory permission.
- **Remote card sync** — Prevent echo loops for sync events with `_isRemoteCardOp` flag.
- **Read-only tags** — No remove button or add input for guest/read-only cards.

### API Client (`api.js`)
- **New endpoints** — 108 new lines of API functions for: Claude sessions, session indexing, terminal files/branches/checkout, terminal links (CRUD + send/pause/resume/nudge), browser sessions (CRUD + navigate/back/forward/reload/CDP), invite management (status/key/revoke/proxy/permissions), loop templates (CRUD + import), loop execution (active/launch/stop/history), memory search by category.
- **403 handling** — Forbidden responses dispatch `synabun:forbidden` custom event.
- **Removed** — `dockerNewConnection`, `startDockerDesktop`, `setupDocker` functions.
- **Renamed** — `testQdrant` → `testDatabase`, `testQdrantCloud` → `testDatabaseRemote`.

### Server (`server.js`)
- **Massive expansion** — ~9,400 lines with significant new functionality.
- **Playwright integration** — CDP browser management, screencast streaming, stealth fingerprinting.
- **Direct SQLite access** — Server now directly reads/writes the SQLite database for memory operations (search, CRUD, categories).
- **VTerm buffer** — Virtual terminal buffer module imported for terminal processing.
- **Session indexer** — Background session indexing for Claude Code conversations.
- **Loop execution engine** — Server-side loop management with state persistence.
- **Invite system** — Server-side invite key generation, session management, and permission enforcement.
- **TicTacToe** — Server-side game state management.

---

## 4. Hooks (Claude Code Integration)

### `session-start.mjs` (Major Refactor)
- **Lean boot context** — Reduced from ~200 lines of directives to a compact greeting + single recall directive. Heavy reference data (category tree, user-learning rules) deferred to `prompt-submit` and `post-remember` hooks.
- **Removed** — 5 verbose directive blocks (Directive 1-5), compliance verification checklist, category tree injection, inline tool notes.
- **Added** — Loop session detection (skips greeting for autonomous loops), debug logging to `compact-debug.log`, `ensureProjectCategories()` auto-creation on boot.
- **Shared imports** — `getHookFeatures`, `detectProject`, `ensureProjectCategories` now imported from `shared.mjs` instead of duplicated inline.
- **Anti-stale greeting** — Post-compaction context explicitly warns not to re-execute greeting directives from compacted context.

### `prompt-submit.mjs` (Major Enhancement)
- **Context stacking** — Priority-based context no longer returns early. Multiple contexts (pending-remember, recall nudge, user learning, boot cancellation) are combined and emitted together.
- **Loop marker detection** — `[SynaBun Loop]` prefix in prompt triggers loop state hydration, browser enforcement injection, and autonomy mode rules.
- **User learning overhaul** — Now fires at threshold multiples (8, 16, 24 messages) up to 3 nudges per session. First nudge includes full instructions; subsequent nudges are short reminders. Category changed from `user-profile` to `communication-style`.
- **Boot sequence cancellation** — Messages 2+ get explicit cancellation of SessionStart greeting directive to prevent re-greeting after compaction.
- **Qdrant → SQLite** — Tier 2 trigger pattern updated from `qdrant` to `sqlite`.

### `stop.mjs` (Major Enhancement)
- **Soft cleanup** — New `softCleanupFlag()` function resets enforcement fields (editCount, retries, files) while preserving session-wide tracking (messageCount, greetingDelivered) to prevent greeting re-fire.
- **Loop continuation** — Check 1.5 added: if a loop state file exists, increments iteration counter and blocks with next-iteration instructions. Handles iteration cap, time cap, and stale loop cleanup.
- **Human blocker detection** — `isHumanBlocker()` scans last assistant message for login/CAPTCHA/2FA signals. Pauses loop instead of advancing when detected.
- **Compact flag scanning** — Now scans ALL pending-compact files (not just session-matched) since session IDs can differ between PreCompact and post-compaction Stop.
- **Debug logging** — Compact operations logged to `compact-debug.log`.

### `post-remember.mjs` (Enhanced)
- **Category tree injection** — On first threshold hit, lazily injects full category reference (tree + selection rules) via `loadCategories()` + `buildCategoryReference()` from `shared.mjs`.
- **Compact flag cleanup** — Now clears ALL pending-compact flags (not just session-matched) since session IDs may differ after compaction.
- **CWD tracking** — `input.cwd` now extracted and available.

### `pre-compact.mjs` (Minor)
- **Debug logging** — Writes to `compact-debug.log` with session ID, trigger, and CWD.

### `post-plan.mjs` (Minor)
- **Renamed import** — `getCategoriesPath` → `getMcpCategoriesPath` for clarity.
- **Configurable NI URL** — Neural Interface invalidation now uses `SYNABUN_NI_URL` env var instead of hardcoded localhost.

### `shared.mjs` (Enhanced)
- **New exports** — `getMcpCategoriesPath()`, `loadRegisteredProjects()`, `normalizeLabel()`, `ensureProjectCategories()`, `buildCategoryReference()`, `loadCategories()`, `getHookFeatures()`.
- **Auto-category creation** — `ensureProjectCategories()` creates standalone defaults (conversations, communication-style, plans) and project-specific children (project, architecture, bugs, config) for all registered projects. Idempotent — only adds missing categories.
- **Category reference builder** — `buildCategoryReference()` generates full reference block with tree, available names, selection rules, project scoping, and tool notes for lazy injection.

---

## 5. Onboarding / Setup

### Onboarding Wizard (`onboarding.html`)
- **Step 2 rewritten** — "Qdrant API Key" → "Memory Name & Location". No more password/key management for local database.
- **Step 4 rewritten** — "Spin Up Qdrant" → "Set Up Database". "Local (Docker)" → "Local (File)". No more port configuration, Docker container spinning, or Qdrant Cloud connection.
- **Removed** — Docker Desktop start button, container configuration fields, Qdrant Cloud testing, API key backup warnings.
- **Completion screen** — "Qdrant running on port X" → "SQLite database initialized". "Embedding provider: X" → "Local embeddings (Transformers.js)".

### `setup.js`
- **Node.js 22+** — Version check updated from 18 to 22.
- **No Docker** — `checkDocker()` removed entirely from setup flow.
- **`npm run stop`** — `docker compose down` script removed.

---

## 6. i18n (Localization)

### `en.json` Changes
- **New nav items** — `automations`, `games`, `apps` added. `terminal` namespace removed as a top-level nav item.
- **Menu restructure** — `menu.terminal.*` → `menu.apps.*` (claudeCode, codexCli, geminiCli, shell, showTerminal). New: `menu.apps.browser`, `menu.apps.youtube`. New: `menu.automations.*` (studio, newAutomation, import). New: `menu.games.*` (ticTacToe).
- **Graph menu** — Added `nodeLimitGroup` label.
- **Loading** — `startDocker` → `startServer`.
- **Health** — Removed `dockerNotRunning` and `containerStopped` health messages. `qdrantUnreachable` → `databaseUnreachable` with SQLite-specific subtitle.
- **Settings** — `qdrantUrl` → `databasePath` throughout. `offline` message updated from "Start the container" to "Start the server".
- **Add Collection** — `newDocker`/`newDockerDesc` → `newDatabase`/`newDatabaseDesc`. `existingInstance` → `existingDatabase`. Container config labels → database config labels.
- **Onboarding** — `apiKey.title` → "Database Setup". `qdrant.*` → `database.*` throughout.
- **Completion** — `qdrantKeyConfigured`/`qdrantCloudConnected`/`qdrantRunning` → `databaseReady`. `embeddingProvider` → "Local embeddings (Transformers.js)".

---

## 7. Documentation

### `README.md`
- Rewritten to reflect SQLite architecture, removal of Docker/Qdrant requirements, and local-first approach.

### `CHANGELOG.md`
- Expanded with v1.5.0 entries documenting Focus Mode Whiteboard, and prior changes.

### `docs/api-reference.md`
- Updated to reflect SQLite-based API, removed Qdrant-specific endpoints and parameters.

### `docs/hooks.md`
- Updated hook documentation for new loop system, user learning enhancements, and compact debug logging.

### `docs/usage-guide.md`
- Simplified setup instructions, removed Docker prerequisites.

### `memory-seed/`
- `architecture/01-system-overview.md` — Updated for SQLite architecture.
- `architecture/02-config-system.md` — Simplified config documentation.
- `architecture/05-multi-connection.md` — Updated (multi-connection concept simplified).
- `setup/19-quick-start.md` — Rewritten without Docker steps.
- `setup/21-embedding-providers.md` — Rewritten for local Transformers.js embeddings.

### Meta Files
- `CONTRIBUTING.md` — Updated contribution guidelines.
- `SECURITY.md` — Updated security documentation.
- `NOTICE` — Updated attributions.
- `THIRD-PARTY-LICENSES.md` — Updated for new dependencies (Hugging Face Transformers).
- `LICENSE-COMMERCIAL.md` — Minor updates.

---

## 8. Tests

### Updated
- **Setup** (`setup.ts`) — Major refactor to work with SQLite instead of Qdrant mocks.
- **Removed mocks** — `mocks/openai.mock.ts` and `mocks/qdrant.mock.ts` deleted.
- **All test files** — Updated imports and assertions for SQLite-based storage:
  - `forget-restore.test.ts`, `memories.test.ts`, `recall.test.ts`, `reflect.test.ts`, `remember.test.ts`, `sync.test.ts` — All updated.
  - `compaction-flow.test.ts`, `plan-storage.test.ts`, `remember-enforcement.test.ts` — Integration tests updated.
  - Cost/overhead scenarios updated for local embedding model.
- **Utils** — `call-tracker.ts`, `report-generator.ts`, `token-counter.ts` updated.
- **Config** — `vitest.config.ts` and `.tests/package.json` updated.

---

## 9. Other Changes

### `.gitignore`
- Added: `/.claude/`, `neural-interface/data/`, `neural-interface/_test.*`, `neural-interface/_wizard*`, SQLite database files (`memory.db`, `.db-shm`, `.db-wal`), `mcp-server/data/custom-categories*.json`, `mcp-server/data/display-settings.json`.

### Version
- Package version changed from `2026.02.24` (date-based) to `1.3.0` (semver).

### Neural Interface Port
- Neural interface service URL now respects `NEURAL_PORT` env var: `http://localhost:${process.env.NEURAL_PORT || '3344'}`.

### Neural Interface Misc
- **Session indexer** — Updated for SQLite-based session chunk storage.
- **Category logos** — Added `criticalpixel.png`.
- **New helper scripts** — `_decode_b64.cjs`, `_do_replace.cjs`, `_encode_b64.py`, `_gen_wizard.cjs`, `_gen_wizard.py`, `lib/folder-picker.ps1`.
- **package.json** — Added `package-lock.json` and new dependencies.
- **Removed** — `neural-interface/data/browser-config.json`, `neural-interface/data/session-index-state.json` (14,165 lines).

### CSS (`styles.css`)
- **21,000+ lines changed** — Massive stylesheet expansion for new features (floating terminals, browser tabs, whiteboard, invite system, loop UI, apps menu, settings overhaul).
