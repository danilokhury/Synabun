---
category: architecture
tags: [architecture, components, overview, data-flow, mcp-server, neural-interface, qdrant]
importance: 10
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/index.ts
  - neural-interface/server.js
  - docker-compose.yml
---

# SynaBun System Architecture Overview

SynaBun is a persistent vector memory system for AI assistants built with three core components:

1. **MCP Server (TypeScript/Node.js)** — Implements the Model Context Protocol with 10 tools (remember, recall, forget, reflect, memories, sync, category_create, category_update, category_delete, category_list). Communicates via stdio transport. Entry point: `mcp-server/src/index.ts`. Registers all tools, sets up file watchers for category changes, and handles dynamic schema refresh via `refreshCategorySchemas()` which sends `notifications/tools/list_changed` to the MCP client.

2. **Neural Interface (Express.js + Three.js)** — Web-based 3D visualization and management UI at localhost:3344. Express backend (`neural-interface/server.js`) exposes 30+ REST API endpoints including `/api/sync/check` for stale memory detection. Frontend uses ForceGraph3D for interactive 3D force-directed graph of memories. Features inline editing, semantic search, category sidebar, multi-connection switching, graphics quality presets, and a Memory Sync UI with model selector (Haiku/Sonnet/Opus) for detecting and updating stale memories.

3. **Qdrant Vector Database (Docker)** — Stores memory embeddings in a single collection (`claude_memory`) with cosine distance similarity. Runs in Docker container `synabun-qdrant` on port 6333 (HTTP) and 6334 (gRPC). All projects share one collection, distinguished by the `project` payload field.

**Data flow:** AI Assistant → MCP Protocol (stdio) → MCP Server → OpenAI-compatible Embeddings API → Qdrant Vector DB. The Neural Interface provides a parallel REST API path for the web UI.
