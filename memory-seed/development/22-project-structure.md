---
category: development
tags: [structure, files, layout, directories, organization]
importance: 8
project: synabun
source: self-discovered
related_files:
  - README.md
---

# SynaBun Project File Structure

## Root Files

- `setup.js`: One-command setup wizard (`npm start` entry point)
- `data/memory.db`: SQLite database file (created at runtime, gitignored)
- `.env`: Environment variables (gitignored)
- `.env.example`: Template with placeholder values
- `LICENSE`: Apache License 2.0
- `LICENSE-COMMERCIAL.md`: Commercial licensing (Open Core model)
- `README.md`: Main documentation
- `CLAUDE.md`: AI assistant instructions template (gitignored — customized per install)
- `CONTRIBUTING.md`: Bug reports, feature requests, and forking guide
- `CHANGELOG.md`: Version history
- `SECURITY.md`: Security policy

## data/ (Runtime Data, gitignored)

- `memory.db`: SQLite database
- `custom-categories.json`: User-defined categories (runtime)
- `greeting-config.json`: Per-project greeting templates
- `hook-features.json`: Feature toggles for hooks
- `claude-code-projects.json`: Registered projects for detection
- `loop-templates.json`: Saved loop task templates
- `stored-plans.json`: Dedup tracker for auto-stored plans
- `loop/`: Active loop state files (`{sessionId}.json`)
- `pending-remember/`: Edit count and session tracking flags
- `pending-compact/`: Pending compaction flags
- `precompact/`: Cached transcript data for compaction resume

## mcp-server/ (TypeScript MCP Server)

- `src/index.ts`: Entry point — tool registration (~50 tools), schema refresh, file watcher
- `src/config.ts`: Environment config, database path resolution
- `src/types.ts`: TypeScript interfaces (MemoryPayload, MemorySearchResult, MemoryStats)
- `src/tools/`: ~21 tool files:
  - Memory: `remember.ts`, `recall.ts`, `forget.ts`, `reflect.ts`, `memories.ts`, `restore.ts`
  - Utility: `category.ts`, `sync.ts`, `loop.ts`
  - Browser: `browser.ts` (registration), `browser-navigate.ts`, `browser-interact.ts`, `browser-observe.ts`, `browser-advanced.ts`
  - Whiteboard: `whiteboard.ts` (registration), `whiteboard-tools.ts`
  - Cards: `card.ts` (registration), `card-tools.ts`
  - TicTacToe: `tictactoe.ts` (registration), `tictactoe-tools.ts`
  - `utils.ts`: Shared utilities
- `src/services/`: `sqlite.ts` (database operations), `local-embeddings.ts` (Transformers.js), `categories.ts`, `file-checksums.ts`
- `data/custom-categories.json`: Category storage (runtime, watched by file watcher)
- `dist/`: Compiled JavaScript output (gitignored)
- `scripts/migrate-qdrant-to-sqlite.ts`: One-time migration script

## neural-interface/ (Express + Static Frontend)

- `server.js`: Express REST API server (~9000 lines, 160+ endpoints)
- `public/index.html`: 3D force-directed graph visualization (Three.js + ForceGraph3D)
- `public/onboarding.html`: Guided setup wizard UI
- `public/variant/3d/`: Modular 3D components (camera.js, settings-gfx.js, etc.)
- `lib/`: Server-side library modules

## hooks/claude-code/ (Claude Code Lifecycle Hooks)

- `session-start.mjs`: SessionStart (385 lines) — greeting, context injection, compaction resume
- `prompt-submit.mjs`: UserPromptSubmit (512 lines) — tiered recall, loop injection, learning
- `stop.mjs`: Stop (372 lines) — enforcement loops, task-remember, loop iteration
- `pre-compact.mjs`: PreCompact (217 lines) — transcript parsing, cache
- `post-remember.mjs`: PostToolUse (196 lines) — edit counting, remember flag clearing
- `post-plan.mjs`: PostToolUse (298 lines) — auto-stores plans into SQLite
- `pre-websearch.mjs`: PreToolUse (90 lines) — blocks web search during browser sessions
- `shared.mjs`: Shared utilities (305 lines) — stdin, project detection, categories

## skills/ (Slash Command Skills)

- `synabun/SKILL.md`: Main `/synabun` skill — interactive menu routing to modules
- `synabun/modules/idea.md`: Brainstorming module
- `synabun/modules/audit.md`: Memory audit module
- `synabun/modules/memorize.md`: Context-to-memory module
- `synabun/icon.png`, `synabun/synabunicon.png`: Skill icons

## .tests/ (Vitest Test Suite)

- `unit/`: Unit tests for tools and services
- `integration/`: Integration tests for hook behaviors
- `vitest.config.ts`: Test configuration

## docs/ (Extended Documentation)

- `api-reference.md`: Complete REST API reference
- `hooks.md`: Hook system documentation
- `usage-guide.md`: Memory usage best practices

## memory-seed/ (Bootstrap Knowledge)

- 6 subdirectories with ~45 Markdown seed files for bootstrapping AI knowledge
- `README.md`: Seeding instructions and category prerequisites
