---
category: neural-interface
tags: [api, endpoints, memory, search, crud, rest]
importance: 7
project: synabun
source: self-discovered
related_files:
  - neural-interface/server.js
---

# SynaBun Neural Interface — Memory & Search API Endpoints

Seven REST endpoints handle memory CRUD, semantic search, and stale memory detection.

## Endpoints

**GET /api/memories** — Returns ALL memories with computed graph edges for 3D visualization. Fetches all points from Qdrant via scrolling, then computes edges between memories based on cosine similarity (>0.65 threshold), shared related files, same parent category, and explicit `related_memory_ids`. Response: `{ memories: [...], edges: [...] }`.

**POST /api/search** — Semantic search. Request body: `{ query, category?, project?, tags?, limit?, min_importance? }`. Embeds the query text, searches Qdrant with filters, returns ranked results with scores.

**GET /api/stats** — Collection statistics. Returns point count and Qdrant connection status. Quick health check endpoint.

**GET /api/memory/:id** — Single memory detail by UUID. Returns full payload including content, category, tags, importance, timestamps, related files.

**PATCH /api/memory/:id** — Update a memory. Request body can include: `{ category?, tags?, content? }`. If content is changed, the memory is re-embedded (new vector generated). If only metadata changes, just the payload is updated.

**DELETE /api/memory/:id** — Delete a memory from Qdrant by UUID. Returns success/failure status.

**GET /api/sync/check** — Stale memory detection. Scrolls all memories with `related_files`, computes SHA-256 hash of each file's current content, compares against stored `file_checksums`. Returns `{ stale: [...], total_checked, total_with_files, total_stale }`. Memories without stored checksums (legacy) are treated as stale. Powers the Memory Sync UI in Settings.

All endpoints reload config via `reloadConfig()` to support runtime connection switching.
