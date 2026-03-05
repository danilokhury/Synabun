---
category: architecture
tags: [database, sqlite, fts5, session-chunks, trash, soft-delete]
importance: 8
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/services/sqlite.ts
  - mcp-server/src/config.ts
---

# SynaBun Database Architecture

SynaBun uses a single SQLite database file (`data/memory.db`) with Node.js built-in `node:sqlite` (requires Node >= 22.5.0). No multi-connection switching — one database per installation.

## Tables

### memories (core storage)

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID v4 |
| vector | BLOB | Float32Array, 384 dimensions |
| content | TEXT | Memory content |
| category | TEXT | Validated against categories |
| subcategory | TEXT | Optional refinement |
| project | TEXT | Project identifier |
| tags | TEXT | JSON array |
| importance | INTEGER | 1-10 scale |
| source | TEXT | user-told, self-discovered, auto-saved |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |
| accessed_at | TEXT | Updated on recall |
| access_count | INTEGER | Recall hit counter |
| related_files | TEXT | JSON array of file paths |
| related_memory_ids | TEXT | JSON array of UUIDs |
| file_checksums | TEXT | JSON object {path: SHA-256} |
| trashed_at | TEXT | Soft delete timestamp (null = active) |
| source_session_chunks | TEXT | Links to session chunks |

**Indexes:** category, project, importance, trashed_at, created_at, source

### session_chunks (conversation indexing)

Stores parsed conversation transcript segments for semantic search across past sessions.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| vector | BLOB | Float32Array embedding |
| content | TEXT | Chunk content |
| summary | TEXT | Optional summary |
| session_id | TEXT | Claude Code session ID |
| project | TEXT | Project identifier |
| git_branch | TEXT | Branch at time of session |
| cwd | TEXT | Working directory |
| chunk_index | INTEGER | Position in session |
| start_timestamp | TEXT | Chunk start time |
| end_timestamp | TEXT | Chunk end time |
| tools_used | TEXT | JSON array |
| files_modified | TEXT | JSON array |
| files_read | TEXT | JSON array |
| user_messages | TEXT | JSON array |
| turn_count | INTEGER | Number of turns |
| related_memory_ids | TEXT | JSON array |
| dedup_memory_id | TEXT | Dedup reference |
| indexed_at | TEXT | When indexed |

**Indexes:** session_id, project, git_branch

### categories

Mirrors `data/custom-categories.json`. Kept in sync by MCP server.

| Column | Type |
|--------|------|
| name | TEXT PK |
| description | TEXT |
| created_at | TEXT |
| parent | TEXT |
| color | TEXT |
| is_parent | INTEGER |

### memories_fts (Full-Text Search)

FTS5 virtual table for fast keyword search: `content`, `category`, `project`, `tags`. Uses porter tokenizer with unicode61.

### kv_config

Simple key-value store for runtime configuration.

## Soft Delete (Trash)

Memories are soft-deleted by setting `trashed_at` to current timestamp. The `restore` MCP tool clears `trashed_at` to recover. Neural Interface exposes `/api/trash` endpoints for browsing and managing trashed items.

## Vector Search

Cosine similarity is computed in-process (JavaScript), not via an external index. All memory vectors are loaded and scored — no approximate nearest neighbor. Score threshold default: 0.3.

## Config

`config.ts` is minimal:
- `dataDir` — resolves to `../data` relative to MCP server dist
- `sqlite.dbPath` — lazily resolved from dataDir
- `embedding.model` = `'Xenova/all-MiniLM-L6-v2'`
- `embedding.dimensions` = 384
