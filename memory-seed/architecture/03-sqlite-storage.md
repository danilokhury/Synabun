---
category: architecture
tags: [sqlite, vectors, database, tables, indexes, storage]
importance: 9
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/services/sqlite.ts
---

# SynaBun SQLite Storage Integration

The SQLite service (`mcp-server/src/services/sqlite.ts`) manages all database and vector storage operations using Node.js built-in `node:sqlite`.

## Database Setup (ensureDatabase)

- Database file: `data/memory.db` (created automatically if missing)
- Embeddings: Generated locally via Transformers.js (all-MiniLM-L6-v2, 384 dimensions)
- Similarity metric: Cosine distance (computed in application code)
- Tables created automatically:
  - **memories**: id (UUID primary key), content, category, project, tags, subcategory, source, importance, access_count, created_at, updated_at, embedding (BLOB)
- Indexes created automatically:
  - **Indexed columns**: category, project, tags, subcategory, source, created_at, importance, access_count
  - **Full-text search**: content column

## Storage

- File-based storage at `data/memory.db` — no external services or containers needed
- Data persists across restarts automatically
- Single file, easy to back up or move between machines

## Key Functions

- `upsertMemory(id, vector, payload)`: Insert or update a memory row
- `searchMemories(vector, limit, filter, scoreThreshold=0.3)`: Vector similarity search (cosine distance computed in-process)
- `deleteMemory(id)`: Delete by UUID
- `getMemory(id)`: Retrieve single memory (no embedding returned)
- `updatePayload(id, payload)`: Metadata-only update (no re-embedding)
- `updateVector(id, vector, payload)`: Full upsert when content changes
- `updatePayloadByFilter(filter, payload)`: Batch update (used for category reassignment)
- `scrollMemories(filter, limit=20, offset)`: Paginated retrieval
- `countMemories(filter)`: Count with filter
- `getMemoryStats()`: Aggregate stats (total, by_category, by_project, oldest/newest)
