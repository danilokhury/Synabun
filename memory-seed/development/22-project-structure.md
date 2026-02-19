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
- `docker-compose.yml`: Qdrant container definition
- `.env`: Environment variables (gitignored — contains API keys)
- `.env.example`: Template with placeholder values
- `connections.json`: Multi-Qdrant connection registry (gitignored — contains API keys)
- `LICENSE`: Apache License 2.0 (trademark protection via Section 6)
- `README.md`: Main documentation (~680 lines)
- `CLAUDE.md`: AI assistant instructions template (gitignored — customized per install)
- `CONTRIBUTING.md`: Developer guide
- `CHANGELOG.md`: Version history
- `SECURITY.md`: Security policy

## mcp-server/ (TypeScript MCP Server)

- `src/index.ts`: Entry point — tool registration, schema refresh, file watcher setup
- `src/config.ts`: Environment config, project detection, connection management
- `src/types.ts`: TypeScript interfaces (MemoryPayload, MemorySearchResult, MemoryStats)
- `src/tools/`: 10 tool files — `remember.ts`, `recall.ts`, `forget.ts`, `reflect.ts`, `memories.ts`, `sync.ts`, `category-create.ts`, `category-update.ts`, `category-delete.ts`, `category-list.ts`
- `src/services/`: `qdrant.ts` (203 lines), `embeddings.ts` (29 lines), `categories.ts` (364 lines), `file-checksums.ts` (SHA-256 content hashing for stale memory detection)
- `data/custom-categories.json`: User-defined categories (NOT in git — created at runtime)
- `dist/`: Compiled JavaScript output (gitignored)

## neural-interface/ (Express + Static Frontend)

- `server.js`: Express REST API server (1557 lines, 30+ endpoints)
- `public/index.html`: 3D force-directed graph visualization (Three.js + ForceGraph3D)
- `public/onboarding.html`: Guided setup wizard UI

## hooks/claude-code/ (Claude Code Lifecycle Hooks)

- `session-start.mjs`: SessionStart hook (209 lines) — category tree injection
- `prompt-submit.mjs`: UserPromptSubmit hook (96 lines) — recall nudge

## docs/ (Extended Documentation)

- `api-reference.md`: Complete REST API reference (1628 lines, 32 endpoints)
- `hooks.md`: Hook system documentation (374 lines)
- `usage-guide.md`: Memory usage best practices (646 lines)
