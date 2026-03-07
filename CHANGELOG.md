<<<<<<< HEAD
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
=======
### Added

- **Browser Click Auto-Hints on Failure** — When `browser_click` fails with "No elements match selector", the error response now includes a list of up to 15 visible interactive elements on the page (buttons, textboxes, links, inputs) with their role, text content, aria-label, and placeholder. The MCP handler formats these into a readable list appended to the error message, followed by a "Use browser_snapshot for full page structure" nudge. This eliminates the trial-and-error pattern where the AI would guess selectors blindly after a failed click — it now gets immediate feedback on what's actually clickable. Helper function `getInteractiveHints(page)` is reusable for extending to fill/type/hover endpoints later.

- **Offline Fallback Page (Service Worker)** — When the Neural Interface server isn't running, users now see a friendly "Server is sleeping" page instead of `ERR_CONNECTION_REFUSED`. Uses a service worker (`sw.js`) that caches `offline.html` on first visit and serves it on navigation fetch failure. The offline page is fully self-contained (all CSS/SVG/JS inline, zero external dependencies) with a sleeping SynaBun mascot (closed pill-eyes, floating Z's, breathing animation), the start command with a copy button, and auto-retry that checks every 3 seconds and auto-reloads when the server comes back. SW registration added to `index.html`, `index2d.html`, `onboarding.html`, and `invite.html`.

- **PWA App Mode** — Added `manifest.json` with `display: standalone` to enable installing the Neural Interface as a standalone app (no address bar, no tabs). Server now auto-opens Edge in `--app` mode on startup, falling back to Chrome then generic browser. Skip auto-open with `--no-open` flag.

- **User Learning Deduplication (Reflect-First)** — Rewrote the user learning nudge and stop block instructions to prefer `reflect` (update existing memory) over `remember` (create new). Nudge now says: "AVOID DUPLICATES: If an existing memory already covers the same patterns, use `reflect` to UPDATE it." Steps changed from "1. recall → 2. remember" to "1. recall → 2. reflect existing or remember new." Added `userLearningObserved` flag in the session tracking file — once a style observation is stored or updated, all subsequent nudges in the same session are skipped. `post-remember.mjs` now clears `userLearningPending` on both `remember` (with `communication-style`/`personality` category) and `reflect` (when `userLearningPending` is true). `softCleanupFlag()` preserves `userLearningObserved` across soft resets. Prevents the duplicate memories problem where each nudge created a new overlapping entry.

- **User Learning Test Suite** — `test-user-learning.mjs` with 21 tests and 75 assertions covering the full user learning hook lifecycle. Tests threshold timing, nudge guardrail content (GOOD/BAD examples, category prohibitions, reflect instructions, duplicate warnings), stop block guardrail content, retry enforcement with max-retries give-up, post-remember flag clearing for `communication-style`/`personality` categories, reflect clearing when pending is true, reflect NOT setting observed when pending is false, `userLearningObserved` skipping subsequent nudges, flag preservation for unrelated categories, feature toggle disable, `softCleanupFlag()` field preservation (including `userLearningObserved`), full nudge→block→clear lifecycle, and edit-heavy sessions. Uses isolated test config (`userLearningThreshold: 3`) with save/restore of production `hook-features.json`.

- **User Learning Anti-Misuse Guardrails** — Rewrote nudge text in `prompt-submit.mjs` and stop block messages in `stop.mjs` with explicit GOOD/BAD examples and category prohibitions. Nudge and block text now include: "Category MUST be `communication-style` — never `conversations`", "Content MUST describe HOW the user communicates — NOT what was worked on", "This is NOT a session summary", with concrete good example ("User gives terse instructions...") and bad example ("User asked about hooks and we fixed bugs..."). First retry gets full instructions; subsequent retries get a shorter reminder. Addresses observed failure mode where Claude stored session summaries in `conversations` instead of style observations in `communication-style`.

- **Configurable User Learning Max Nudges** — `userLearningMaxNudges` is now configurable via `hook-features.json` (default: 3). Previously hardcoded as `USER_LEARNING_MAX_NUDGES`. Renamed constant to `USER_LEARNING_MAX_NUDGES_DEFAULT` and reads `features.userLearningMaxNudges` at runtime, falling back to the default.

- **Stop Hook User Learning Debug Logging** — Added `debugUL()` function in `stop.mjs` that appends timestamped `STOP:` prefixed entries to `data/user-learning-debug.log`. Logs CHECK 2.5 entry/skip decisions, BLOCK actions with retry count, and GIVE UP events. Complements existing `CHECK:/FIRE:/SKIP:` logging from `prompt-submit.mjs` for full observability into the user learning enforcement pipeline.

- **Native Session Auto-Store on End** — New CHECK 4 in `stop.mjs` that fires after all other enforcement checks pass. When a session had meaningful activity (3+ user messages or any file edits), blocks once to prompt Claude to store a brief session summary in `conversations` with `source: "auto-saved"`. Tracks `autoStoreTriggered` flag in pending-remember to fire only once per session. Controlled by `autoStoreOnEnd` feature flag in `hook-features.json` (defaults to enabled). Addresses the gap identified in onboarding reports: sessions ending without any conversation memory unless compaction was triggered.

- **FTS5 Keyword Fallback in Recall** — Added `searchMemoriesFTS()` to `sqlite.ts` that queries the `memories_fts` table using FTS5 MATCH with BM25 ranking. In `recall.ts`, when vector similarity results are weak (top score < 0.45 or fewer results than requested), automatically falls back to full-text keyword search and merges results. Helps with exact identifiers, error codes, function names, and proper nouns that embedding models handle poorly. Excludes duplicates already found by vector search. Non-fatal: if FTS5 is unavailable, recall works normally via vector search only.

- **Multi-Tool Coexistence Rules** — New "Coexistence with Other Tools" section in `CLAUDE.md` that explicitly declares SynaBun's ownership of all memory operations and provides enforcement rule templates for users running SynaBun alongside other AI tools (CogniLayer, mem0, etc.). Includes copyable enforcement template with `[OtherTool]` placeholders.
  - **Settings UI**: New "Multi-Tool Coexistence" collapsible section in Settings > Setup tab with preview + copy button, served via `/api/claude-code/ruleset?format=coexistence`
  - **Onboarding**: Step 5 (AI Tool Integration) now shows coexistence rules panel below MCP config with copy button. Appears when a tool is selected.
  - **API**: Ruleset endpoint extended with `coexistence` format option

- **MCP Tool Permissions Sync** — Added 7 missing tools to `SYNABUN_TOOL_PERMISSIONS` and 6 missing browser extractors to `SYNABUN_TOOL_CATEGORIES` in the companion app server, bringing both arrays to the full 46 SynaBun tools that the MCP server registers. Settings UI now displays all 47 entries (46 SynaBun + 1 WebSearch). Missing tools: `browser_extract_tiktok_videos`, `browser_extract_tiktok_search`, `browser_extract_tiktok_studio`, `browser_extract_tiktok_profile`, `browser_extract_wa_chats`, `browser_extract_wa_messages`, and `tictactoe`.

- **Documentation Sync (46 tools)** — Updated all documentation to reflect the full 46-tool inventory across 8 files:
  - `README.md` — Architecture diagram (11→46), MCP Tools section restructured into 6 groups (Memory 9, Browser 26, Whiteboard 5, Cards 5, Loop 1, TicTacToe 1), CLAUDE.md template updated
  - `llms-full.txt` — Tool count header (9→46), added all browser/whiteboard/card/loop tool docs, Node.js version (18+→22.5+)
  - `index.html` — FAQ structured data ("9 tools"→"46 tools")
  - `docs.html` — Key capabilities ("11 MCP tools"→"46"), tool table updated (`category_*`→single `category` + `tictactoe`), Browser Tools count (16→18) with `reload`, `upload`, separate `go_back`/`go_forward`
  - `CONTRIBUTING.md` — 3 stale "11 tools" references updated
  - `LICENSE-COMMERCIAL.md` — "11 MCP tools"→"46 MCP tools"
  - Memory seeds — Removed hardcoded tool counts

- **CLI Status Indicator** — Real-time status pill in the title bar header showing Claude Code / Codex / Gemini session state
  - Three states: **Working** (pulsing blue dot), **Idle** (dim gray dot), **Action** (pulsing amber dot)
  - Detects idle by scanning cursor line and up to 3 lines above for prompt characters (`❯` / `>` / `$` / `%`), verifying gap lines between prompt and cursor are empty
  - Detects action needed by scanning visible rows for permission prompts (Allow/Yes/No)
  - Aggregates across all active CLI sessions (action > working > idle priority)
  - Auto-hides when no CLI sessions are active
  - 600ms debounce on output to avoid flickering during rapid streaming, 2s poll interval for catching missed transitions

- **Task Notifications (Sound + Push)** — Audio alerts and browser push notifications when a CLI task finishes or needs attention
  - Fires only on Working → Idle/Action/Done transitions to avoid noise
  - **Action needed**: urgent double-beep (880Hz) for permission prompts
  - **Task complete**: gentle single tone (660Hz) for idle/done states
  - Browser push notification when the tab is not focused (title: "Action Required" or "Task Complete", body: session label)
  - Web Audio API oscillator — no audio files needed
  - Toggle in Settings > Terminal > Notifications, prompts for browser notification permission on enable
  - Notifications enabled by default, persisted via `TERMINAL_NOTIFICATIONS` storage key

- **Project File Explorer** — New sidebar panel for browsing actual project files directly in the Neural Interface
  - Shows ALL files including dotfiles (`.env`, `.gitignore`, `.claude/`, etc.)
  - Lazy-loading directory tree with expand/collapse, search bar, and sort modes (name/size/date)
  - **Project selector dropdown** — custom dropdown with folder icons, active project highlight, and chevron
    - Browse files from any registered project (loaded from `data/claude-code-projects.json`)
    - "Add project..." option opens native OS folder picker to register new projects
    - Selection persisted across sessions
    - Path security validates against all registered project roots
  - Search bar with persistent magnifying glass icon
  - Git status badges on modified/added/deleted/untracked files
  - Stacking layout — sits adjacent to Memory Explorer, both can be open simultaneously
  - Toggleable from View menu ("File Explorer") and keybind (`E`)
  - Keybind appears in keybind selector modal and is fully rebindable
  - Resizable right edge (240–500px), state persisted across sessions
  - **Inline file editor** — right-click any file for context menu (Copy Path / Edit File)
    - Opens as a standalone panel sliding into the workspace from the file explorer's right edge
    - Line numbers gutter with scroll-synced highlighting
    - Status bar showing detected language, cursor position (Ln/Col), file size, and encoding
    - Word wrap enabled by default, toggleable from header button
    - Custom undo/redo stack (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) with debounced typing snapshots — up to 200 levels
    - Tab indent (2 spaces), Shift+Tab unindent for selected lines
    - Auto-indent on Enter — carries over current line's leading whitespace
    - Ctrl+D duplicate current line, Ctrl+/ toggle line comment (language-aware: `//` for JS/TS, `#` for Python/Shell, `--` for SQL, etc.)
    - Bracket and quote auto-close — `()[]{}""''`` with selection wrapping and Backspace pair deletion
    - Find & Replace bar (Ctrl+F find, Ctrl+H replace) — case-insensitive search with match count, Replace / Replace All buttons, Enter/Shift+Enter cycling, Escape to close
    - Go to Line (Ctrl+G) — number input bar, jumps to line and scrolls into view
    - Current line highlight — subtle band tracking cursor position
    - Scroll indicator — thin scrollmap on right edge showing viewport position
    - Keyboard shortcuts help (?) button — popover listing all 10 editor keybinds
    - Dirty tracking with yellow dot indicator and enabled/disabled Save/Discard buttons
    - Unsaved changes prompt on back navigation and panel close
    - Markdown preview: Raw/Preview toggle appears for `.md` files, renders full markdown (headers, lists, tables, code blocks, links, blockquotes)
    - Ctrl+S / Cmd+S save
    - Workspace toolbar auto-hides when editor is open
    - 1MB size guard, binary file detection, and project path security validation
    - Guest-protected via `ADMIN_ONLY_PREFIXES`
  - New `/api/file-content` (GET/POST), `/api/project-files`, and `/api/projects` server endpoints
  - Reusable `validateProjectPath()` helper extracted from project-files security logic
  - Visual style matches the Memory Explorer (dark sidebar, filter, toolbar, tree, footer)

- **Memory Explorer Tooltip Date** — Hovering a memory in the explorer sidebar now shows the creation date beneath the preview text. Date appears as a dimmer, smaller subtitle line (e.g. "Mar 6, 2026"). The tooltip system was enhanced to support subtitle lines generically — any `data-tooltip` containing `\n` renders the second part as a dimmed `<span>`.

- **Recall Recency Boost** — New `recency_boost` parameter on the `recall` tool that shifts scoring to prioritize recent memories over semantic similarity. When enabled: scoring weights change from 70/20/10 (semantic/recency/access) to 35/55/10, half-life drops from 90 days to 14 days, and `importance >= 8` no longer skips time decay. Used by the session boot sequence to surface what was actually worked on recently instead of whatever semantically matches a generic query best.

- **Dedicated Communication-Style Boot Recall** — Session boot sequence now makes two `recall` calls instead of one: (1) recent work context with `recency_boost: true`, (2) a dedicated `category: "communication-style"` query with `limit: 2` to surface user communication preferences. Previously, communication-style memories were never surfaced because the generic boot query ("recent sessions, ongoing work, known issues, decisions") had no semantic overlap with style observations.

### Fixed

- **Terminal rename → Resume dropdown sync** — Renaming a terminal header (docked tab or floating window) now updates the session name in the Resume dropdown. Terminal sessions track their Claude Code session ID (`_claudeSessionId`) and write to the same `synabun-session-label:{id}` key via the server-synced `storage` module (persisted to `data/ui-state.json`). The ID persists through session registry, layout snapshots, and all reconnect paths.
- **Duplicate terminal sessions corrupting labels** — `_sessions` array could accumulate duplicate entries with the same session ID, causing custom names, `_userRenamed` flags, and `_claudeSessionId` to be split across two objects. The first (stale) entry would win on reconnect, reverting the custom name to the profile default. Added `_pushSession()` helper that replaces existing entries instead of blindly pushing, and deduplication in `saveSessionRegistry()` as a safety net. Both merge `_claudeSessionId` from either entry to prevent data loss.
- **Resume label not applied to terminal** — `openHtmlTermSession` was called without `await` in the `terminal:open-resume` handler. The session object didn't exist in `_sessions` yet when the code tried to set the label, so custom Resume labels were silently lost. Now properly awaited. Additionally, `openHtmlTermSession` now accepts an `options` parameter (`label`, `claudeSessionId`) so the session is created with the correct name from the start — the resume handler passes label and Claude session ID directly, eliminating the flash of the default "Claude Code" profile name.
- **Minimized pills now display custom tab names** — Renaming a floating terminal tab and minimizing it now shows the custom name in the pill tray. PTY title escape sequences (`onTitle`), browser title updates, and CWD-change labels no longer overwrite user-set names. Custom names persist across page refresh and session reconnection via a new `_userRenamed` flag stored in the session registry and layout snapshot.
- Minimized terminal tab pills now show the full tab name instead of truncating at 160px
- Minimized pill labels now sync with session label changes (rename, auto-title, CWD change) via `renderTabBar()` sync loop
- File Explorer title bar no longer pushed sideways — slides under the title bar like the Memory Explorer
- **Reflect over-clearing user learning flag** — Any `reflect` call (even on unrelated memories) cleared `userLearningPending` in `post-remember.mjs`, allowing Claude to bypass the user learning requirement by reflecting on any memory. Fixed by removing `reflect` from the clearing condition entirely — now only `remember` with category `communication-style` or `personality` clears the flag.
- **Wrong-category user learning storage** — Claude stored session summaries in `conversations` category instead of style observations in `communication-style`, defeating the purpose of user learning. Root cause: nudge and block text were too vague about what to store and which category to use. Fixed by adding explicit GOOD/BAD examples and "never conversations" prohibition to both nudge (`prompt-submit.mjs`) and block (`stop.mjs`) messages. Also expanded accepted categories to include `personality` alongside `communication-style`.
- **User Learning nudge never fired** — `checkUserLearning()` in `prompt-submit.mjs` had a single `try-catch` wrapping both the `writeFileSync` (persist nudge count) and the nudge return. If the write threw, the catch swallowed the nudge text, silently returning empty every time. Restructured into separate try-catch blocks so write failures no longer block the nudge. Added debug logging to `data/user-learning-debug.log` for full observability into nudge decisions.
- **Stop hook session-end block looped infinitely** — `softCleanupFlag()` in `stop.mjs` stripped `autoStoreTriggered` and `totalEdits` from the flag file when resetting enforcement fields. After CHECK 2's soft cleanup ran, CHECK 4 (auto-store on session end) would re-trigger every time because it saw `autoStoreTriggered` as false. Fixed by preserving both fields in the cleaned flag object.
- **Session labels lost on page reload / server restart** — `getSessionLabel()` and `setSessionLabel()` in `ui-resume.js` used raw `localStorage`, which doesn't sync to the server. Labels disappeared when the browser cleared storage or when accessing from a different tab after server restart. Migrated all label read/write/remove calls to the server-synced `storage` module in both `ui-resume.js` and `ui-terminal.js` (`syncResumeLabel`). Existing labels migrate automatically via `storage.js`'s built-in `_migrateFromLocalStorage()` which transfers all `synabun-*` keys on first boot.
- **CLI status badge stuck on "Working" after task completion** — `_detectSessionStatus()` only checked the exact cursor line for prompt characters. When Claude finishes, the cursor can land on a blank line or cost summary below the prompt, causing a permanent false "Working" state. Fixed by scanning the cursor line and up to 3 lines above for prompt characters (`❯` / `>` / `$` / `%`), verifying any gap lines between the detected prompt and cursor position are empty. Also increased debounce from 400ms to 600ms (gives terminal more time to render final prompt) and decreased poll interval from 3s to 2s (reduces worst-case latency for catching transitions).
>>>>>>> Dev
