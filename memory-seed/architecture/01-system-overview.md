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

SynaBun is a persistent vector memory system for AI assistants built with three core components:

1. **MCP Server (TypeScript/Node.js)** — Implements the Model Context Protocol with ~50 tools across 7 groups. Communicates via stdio transport. Entry point: `mcp-server/src/index.ts`. Registers all tools, sets up file watchers for category changes, and handles dynamic schema refresh via `refreshCategorySchemas()` which sends `notifications/tools/list_changed` to the MCP client.

   **Tool groups:**
   - **Memory** (6): remember, recall, forget, restore, reflect, memories
   - **Utility** (3): category (create/update/delete/list), sync, loop (start/stop/status)
   - **Browser** (~26): Full Playwright-based browser automation — navigate, click, type, fill, snapshot, screenshot, content, evaluate, hover, select, press, wait, scroll, upload, reload, go_back, go_forward, session, plus social extraction tools (extract_tweets, extract_fb_posts, extract_tiktok_*, extract_wa_*)
   - **Whiteboard** (5): whiteboard_read, whiteboard_add, whiteboard_update, whiteboard_remove, whiteboard_screenshot
   - **Cards** (5): card_list, card_open, card_close, card_update, card_screenshot
   - **TicTacToe** (1): tictactoe (start/move/state/end)

2. **Neural Interface (Express.js + Three.js)** — Web-based 3D visualization and management UI at localhost:3344. Express backend (`neural-interface/server.js`, ~9000 lines) exposes 160+ REST API endpoints covering memory CRUD, categories, browser control, terminal sessions, whiteboard, cards, loop management, skills studio, backup/restore, tunnel management, invite sessions, greeting config, and session indexing. Frontend uses ForceGraph3D for interactive 3D force-directed graph of memories. Features inline editing, semantic search, category sidebar, graphics quality presets, and a Memory Sync UI with model selector (Haiku/Sonnet/Opus) for detecting and updating stale memories.

3. **SQLite Database (Embedded)** — Stores memories and their embeddings in a local SQLite database file (`data/memory.db`) using Node.js built-in `node:sqlite` (requires Node.js >= 22.5.0). Embeddings are generated locally via Transformers.js (all-MiniLM-L6-v2, 384 dims) with cosine similarity search. All projects share one database, distinguished by the `project` column. No external services or containers required.

   **Tables:** `memories` (core storage + vectors), `session_chunks` (conversation indexing), `categories` (category metadata), `kv_config` (key-value store), `memories_fts` (FTS5 full-text search)

4. **Hook System** — 8 Claude Code lifecycle hooks (`hooks/claude-code/`) that inject context, enforce memory hygiene, manage loops, and index sessions. Hooks: session-start, prompt-submit, stop, pre-compact, post-remember, post-plan, pre-websearch, plus shared utilities.

**Data flow:** AI Assistant → MCP Protocol (stdio) → MCP Server → Local Transformers.js Embeddings → SQLite DB. The Neural Interface provides a parallel REST API path for the web UI. Hooks provide bidirectional session integration with Claude Code.
