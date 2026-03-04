---
category: architecture
tags: [architecture, components, overview, data-flow, mcp-server, neural-interface, sqlite]
importance: 10
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/index.ts
  - neural-interface/server.js
  - mcp-server/src/services/sqlite.ts
---

# SynaBun System Architecture Overview

SynaBun is a persistent vector memory system for AI assistants built with two core components and an embedded database:

1. **MCP Server (TypeScript/Node.js)** — Implements the Model Context Protocol with 10 tools (remember, recall, forget, reflect, memories, sync, category_create, category_update, category_delete, category_list). Communicates via stdio transport. Entry point: `mcp-server/src/index.ts`. Registers all tools, sets up file watchers for category changes, and handles dynamic schema refresh via `refreshCategorySchemas()` which sends `notifications/tools/list_changed` to the MCP client.

2. **Neural Interface (Express.js + Three.js)** — Web-based 3D visualization and management UI at localhost:3344. Express backend (`neural-interface/server.js`) exposes 30+ REST API endpoints including `/api/sync/check` for stale memory detection. Frontend uses ForceGraph3D for interactive 3D force-directed graph of memories. Features inline editing, semantic search, category sidebar, multi-connection switching, graphics quality presets, and a Memory Sync UI with model selector (Haiku/Sonnet/Opus) for detecting and updating stale memories.

3. **SQLite Database (Embedded)** — Stores memories and their embeddings in a local SQLite database file (`data/memory.db`) using Node.js built-in `node:sqlite`. Embeddings are generated locally via Transformers.js (all-MiniLM-L6-v2, 384 dims) with cosine similarity search. All projects share one database, distinguished by the `project` column. No external services or containers required.

**Data flow:** AI Assistant → MCP Protocol (stdio) → MCP Server → Local Transformers.js Embeddings → SQLite DB. The Neural Interface provides a parallel REST API path for the web UI.
