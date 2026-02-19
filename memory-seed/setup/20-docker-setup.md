---
category: setup
tags: [docker, qdrant, compose, container, ports, volume, api-key]
importance: 7
project: synabun
source: self-discovered
related_files:
  - docker-compose.yml
  - .env.example
---

# SynaBun Docker & Qdrant Container Setup

## docker-compose.yml

**Service:** `qdrant-memory`
- **Image:** `qdrant/qdrant:latest`
- **Container name:** `synabun-qdrant`
- **Restart policy:** `unless-stopped`
- **Ports:** `${QDRANT_PORT:-6333}:6333` (HTTP API), `${QDRANT_GRPC_PORT:-6334}:6334` (gRPC)
- **Volume:** `synabun-qdrant-data` (named Docker volume) → `/qdrant/storage` (persistent data)
- **Environment:**
  - `QDRANT__SERVICE__API_KEY=${QDRANT_MEMORY_API_KEY:-claude-memory-local-key}` (API authentication)
  - `QDRANT__LOG_LEVEL=WARN` (reduce noise)

## Docker Commands

- **Start:** `docker compose up -d`
- **Stop:** `docker compose down`
- **Logs:** `docker compose logs -f`
- Data persists across container restarts via named volume

## Port Conflict Resolution

- If port 6333 is in use, change `QDRANT_PORT` in `.env` (e.g., `QDRANT_PORT=6334`)
- The onboarding wizard detects Docker bind errors and suggests alternative ports

## API Key

- Default: `claude-memory-local-key` (insecure, for local dev only)
- The onboarding wizard generates a random 32-char hex key during setup
- Set via `QDRANT_MEMORY_API_KEY` in `.env`
- Same key must be configured in both `docker-compose.yml` (via env) and the MCP server config

## Collection Creation

- `POST /api/setup/create-collection` creates the `claude_memory` collection
- Vector config: `{ size: EMBEDDING_DIMENSIONS, distance: "Cosine" }`
- `ensureCollection()` in `qdrant.ts` also creates it on MCP server startup if missing
