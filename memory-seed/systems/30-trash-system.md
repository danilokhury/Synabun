---
category: architecture
tags: [trash, soft-delete, restore, cleanup, trashed-at]
importance: 7
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/services/sqlite.ts
  - mcp-server/src/tools/restore.ts
  - mcp-server/src/tools/forget.ts
  - neural-interface/server.js
---

# SynaBun Trash / Soft-Delete System

Memories are never immediately destroyed. The `forget` tool soft-deletes by setting `trashed_at`, and `restore` recovers them.

## How It Works

### Deleting (forget tool)
Sets `trashed_at` to current ISO timestamp. Memory remains in database but is excluded from:
- `recall` search results (filtered by `trashed_at IS NULL`)
- `memories` browsing
- Neural Interface 3D graph
- `sync` stale detection

### Restoring (restore tool)
Clears `trashed_at` field. Memory becomes active again with all original metadata preserved.

### Browsing Trash (Neural Interface)
- `GET /api/trash` — list all trashed memories with metadata
- `POST /api/trash/restore` — restore a trashed memory
- `DELETE /api/trash/purge` — permanently delete a trashed memory (irreversible)

## Database Column

```sql
trashed_at TEXT  -- NULL = active, ISO timestamp = trashed
```

Index `idx_mem_trashed` on `trashed_at` for efficient filtering.

## Design Rationale

Soft delete prevents accidental data loss from the `forget` tool. Users can browse and restore trashed items through the Neural Interface. Permanent deletion requires explicit purge action through the UI.
