---
category: architecture
tags: [config, environment, connections, project-detection, env-vars]
importance: 8
project: synabun
source: self-discovered
subcategory: config
related_files:
  - mcp-server/src/config.ts
  - .env.example
  - connections.json
---

# SynaBun Config System & Environment Variables

Configuration is managed in `mcp-server/src/config.ts` with two layers:

## Static Config (from .env)

- `SQLITE_DB_PATH`: Path to SQLite database file (default: `data/memory.db`)
- `EMBEDDING_MODEL`: Local Transformers.js model name
- `EMBEDDING_DIMENSIONS`: Vector dimensions
- `NEURAL_PORT`: Neural Interface port (default: 3344)
- `SETUP_COMPLETE`: Onboarding state flag

## Dynamic Config (from connections.json)

- `getActiveConnection()` reads `connections.json` on EVERY call — no restart needed for connection switching
- Falls back to static config if `connections.json` doesn't exist
- Format: `{ active: "id", connections: { id: { label, dbPath } } }`

## Project Detection

- `PROJECT_MAP` object maps directory keywords to project names (e.g., `my-app` → `my-app`)
- `detectProject(cwd)`: lowercases path, checks against `PROJECT_MAP` keys, falls back to directory basename (sanitized to lowercase kebab-case)
- Default project: `"global"` if no match
- Same `PROJECT_MAP` must be kept in sync between `config.ts` and `hooks/claude-code/session-start.mjs`
