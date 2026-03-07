# Changelog

Some MCP fine tuning based on feedback, minor bug fixes and addition to a minimal version of 
code editing, got tired of alt tabbing to visual code all the time.
---

## [v.2026.03.07 - Say hi to File Explorer]

### Added

- **Browser Click Auto-Hints on Failure** — When `browser_click` fails with "No elements match selector", the error response now includes up to 15 visible interactive elements on the page (buttons, textboxes, links, inputs) with their role, text content, aria-label, and placeholder. Eliminates trial-and-error selector guessing after a failed click. Helper function `getInteractiveHints(page)` is reusable for other browser endpoints.

- **Offline Fallback Page (Service Worker)** — When the Neural Interface server isn't running, users see a friendly "Server is sleeping" page instead of `ERR_CONNECTION_REFUSED`. Uses a service worker that caches `offline.html` on first visit and serves it on navigation fetch failure. The offline page is fully self-contained with a sleeping SynaBun mascot, the start command with a copy button, and auto-retry that checks every 3 seconds and auto-reloads when the server comes back.

- **PWA App Mode** — Added `manifest.json` with `display: standalone` to enable installing the Neural Interface as a standalone app. Server auto-opens Edge in `--app` mode on startup, falling back to Chrome then generic browser. Skip auto-open with `--no-open` flag.

- **User Learning Deduplication (Reflect-First)** — Rewrote user learning nudge and stop block instructions to prefer `reflect` (update existing memory) over `remember` (create new). Added `userLearningObserved` flag so once a style observation is stored or updated, all subsequent nudges in the same session are skipped. Prevents duplicate memories where each nudge created a new overlapping entry.

- **User Learning Test Suite** — `test-user-learning.mjs` with 21 tests and 75 assertions covering the full user learning hook lifecycle: threshold timing, guardrail content, retry enforcement, flag clearing, reflect handling, observed skipping, feature toggle, soft cleanup preservation, and full lifecycle scenarios.

- **User Learning Anti-Misuse Guardrails** — Nudge and block text now include explicit GOOD/BAD examples and category prohibitions to prevent Claude from storing session summaries instead of communication style observations.

- **Configurable User Learning Max Nudges** — `userLearningMaxNudges` is now configurable via `hook-features.json` (default: 3). Previously hardcoded.

- **Stop Hook User Learning Debug Logging** — `debugUL()` function in `stop.mjs` appends timestamped entries to `data/user-learning-debug.log` for full observability into the user learning enforcement pipeline.

- **Native Session Auto-Store on End** — New check in `stop.mjs` that fires when a session had meaningful activity (3+ user messages or any file edits), prompting Claude to store a brief session summary. Controlled by `autoStoreOnEnd` feature flag (enabled by default).

- **FTS5 Keyword Fallback in Recall** — When vector similarity results are weak (top score < 0.45 or fewer results than requested), recall automatically falls back to full-text keyword search via SQLite FTS5 and merges results. Helps with exact identifiers, error codes, function names, and proper nouns that embedding models handle poorly.

- **Multi-Tool Coexistence Rules** — New section in `CLAUDE.md` declaring SynaBun's memory ownership with enforcement rule templates for users running SynaBun alongside other AI tools. Includes Settings UI panel, onboarding integration, and API endpoint.

- **MCP Tool Permissions Sync** — Added 7 missing tools to permission arrays and 6 missing browser extractors to category arrays in the companion app, bringing both to the full 46 SynaBun tools.

- **Documentation Sync (46 tools)** — Updated all documentation to reflect the full 46-tool inventory across 8 files including README, `llms-full.txt`, `docs.html`, and contributing guides.

- **CLI Status Indicator** — Real-time status pill in the title bar showing Claude Code / Codex / Gemini session state. Three states: Working (pulsing blue), Idle (dim gray), Action (pulsing amber). Aggregates across all active CLI sessions and auto-hides when none are active.

- **Task Notifications (Sound + Push)** — Audio alerts and browser push notifications when a CLI task finishes or needs attention. Fires only on Working to Idle/Action/Done transitions. Uses Web Audio API oscillator with no audio files needed. Toggle in Settings > Terminal > Notifications.

- **Project File Explorer** — New sidebar panel for browsing project files directly in the Neural Interface.
  - Shows all files including dotfiles, with lazy-loading directory tree, search, and sort modes
  - Project selector dropdown to browse files from any registered project
  - Git status badges on modified/added/deleted/untracked files
  - Inline file editor with line numbers, syntax-aware commenting, find & replace, go to line, bracket auto-close, undo/redo (200 levels), markdown preview, and dirty tracking
  - 1MB size guard, binary file detection, and project path security validation

- **Memory Explorer Tooltip Date** — Hovering a memory in the explorer sidebar now shows the creation date as a dimmer subtitle line. Tooltip system enhanced to support subtitle lines generically via `\n` separator.

- **Recall Recency Boost** — New `recency_boost` parameter on the `recall` tool that shifts scoring to prioritize recent memories over semantic similarity. Scoring weights change from 70/20/10 to 35/55/10, half-life drops from 90 to 14 days, and high-importance memories no longer skip time decay.

- **Dedicated Communication-Style Boot Recall** — Session boot sequence now makes two `recall` calls: one for recent work context with `recency_boost`, and a dedicated `category: "communication-style"` query to surface user communication preferences.

### Fixed

- **Terminal rename not syncing to Resume dropdown** — Renaming a terminal header now updates the session name in the Resume dropdown via server-synced storage. Session ID persists through registry, layout snapshots, and reconnect paths.

- **Duplicate terminal sessions corrupting labels** — `_sessions` array could accumulate duplicate entries with the same session ID, causing custom names to revert on reconnect. Added deduplication helper and safety net in session registry save.

- **Resume label not applied to terminal** — `openHtmlTermSession` was called without `await`, so custom Resume labels were silently lost. Now properly awaited with an `options` parameter for label and session ID.

- **Minimized pills ignoring custom tab names** — PTY title escape sequences and CWD-change labels no longer overwrite user-set names. Custom names persist across refresh and reconnection via `_userRenamed` flag.

- **Minimized terminal pills truncated at 160px** — Now show the full tab name.

- **Minimized pill labels not syncing** — Now sync with session label changes via `renderTabBar()` sync loop.

- **File Explorer title bar pushed sideways** — Now slides under the title bar like the Memory Explorer.

- **Reflect over-clearing user learning flag** — Any `reflect` call cleared `userLearningPending`, allowing bypass by reflecting on any memory. Now only `remember` with `communication-style` or `personality` category clears the flag.

- **Wrong-category user learning storage** — Claude stored session summaries in `conversations` instead of style observations in `communication-style`. Fixed with explicit GOOD/BAD examples and category prohibitions in nudge and block messages.

- **User Learning nudge never fired** — A single `try-catch` wrapping both file write and nudge return meant write failures silently swallowed the nudge. Restructured into separate blocks.

- **Stop hook session-end block looped infinitely** — `softCleanupFlag()` stripped `autoStoreTriggered` from the flag file, causing CHECK 4 to re-trigger every time. Fixed by preserving the field.

- **Session labels lost on page reload** — Label storage migrated from raw `localStorage` to server-synced storage module. Existing labels migrate automatically.

- **CLI status badge stuck on "Working"** — Status detection now scans the cursor line and up to 3 lines above for prompt characters, verifying gap lines are empty. Debounce increased to 600ms and poll interval decreased to 2s.
