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

- `QDRANT_MEMORY_API_KEY`: Qdrant authentication key (default: `claude-memory-local-key`)
- `OPENAI_EMBEDDING_API_KEY` / `OPENAI_API_KEY`: Embedding provider API key
- `EMBEDDING_BASE_URL`: Provider endpoint (default: `https://api.openai.com/v1`)
- `EMBEDDING_MODEL`: Model name (default: `text-embedding-3-small`)
- `EMBEDDING_DIMENSIONS`: Vector dimensions (default: 1536)
- `QDRANT_PORT`: Docker HTTP port (default: 6333)
- `QDRANT_GRPC_PORT`: Docker gRPC port (default: 6334)
- `NEURAL_PORT`: Neural Interface port (default: 3344)
- `SETUP_COMPLETE`: Onboarding state flag

## Dynamic Config (from connections.json)

- `getActiveConnection()` reads `connections.json` on EVERY call — no restart needed for connection switching
- Falls back to static config if `connections.json` doesn't exist
- Format: `{ active: "id", connections: { id: { label, url, apiKey, collection } } }`

## Project Detection

- `PROJECT_MAP` object maps directory keywords to project names (e.g., `criticalpixel` → `criticalpixel`)
- `detectProject(cwd)`: lowercases path, checks against `PROJECT_MAP` keys, falls back to directory basename (sanitized to lowercase kebab-case)
- Default project: `"global"` if no match
- Same `PROJECT_MAP` must be kept in sync between `config.ts` and `hooks/claude-code/session-start.mjs`
