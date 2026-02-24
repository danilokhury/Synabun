---
category: architecture
tags: [qdrant, vectors, database, collection, indexes, client]
importance: 9
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/services/qdrant.ts
  - docker-compose.yml
---

# SynaBun Qdrant Vector Database Integration

The Qdrant service (`mcp-server/src/services/qdrant.ts`, 203 lines) manages all vector database operations.

## Collection Setup (ensureCollection)

- Collection: `claude_memory` (configurable via `QDRANT_MEMORY_COLLECTION`)
- Vector size: `config.openai.dimensions` (default 1536)
- Distance metric: Cosine
- Optimizers: `indexing_threshold = 100`
- Payload indexes created automatically:
  - **Keyword indexes**: category, project, tags, subcategory, source, created_at
  - **Integer indexes**: importance, access_count
  - **Text index**: content (for full-text search fallback)

## Client Management

- Singleton pattern with connection-switch detection
- Recreates `QdrantClient` if URL or API key changes (detected via `getActiveConnection()`)
- Supports runtime connection switching without server restart

## Key Functions

- `upsertMemory(id, vector, payload)`: Insert or update a memory point
- `searchMemories(vector, limit, filter, scoreThreshold=0.3)`: Vector similarity search
- `deleteMemory(id)`: Delete by UUID
- `getMemory(id)`: Retrieve single point (no vector returned)
- `updatePayload(id, payload)`: Metadata-only update (no re-embedding)
- `updateVector(id, vector, payload)`: Full upsert when content changes
- `updatePayloadByFilter(filter, payload)`: Batch update (used for category reassignment)
- `scrollMemories(filter, limit=20, offset)`: Paginated retrieval
- `countMemories(filter)`: Count with filter
- `getMemoryStats()`: Aggregate stats (total, by_category, by_project, oldest/newest)
