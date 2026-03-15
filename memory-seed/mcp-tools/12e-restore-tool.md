---
category: mcp-tools
tags: [restore, mcp-tool, trash, soft-delete, recovery]
importance: 7
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/tools/restore.ts
  - mcp-server/src/services/sqlite.ts
---

# SynaBun restore Tool — Recover Trashed Memories

The restore tool recovers soft-deleted memories from the trash.

## Parameters

- **memory_id** (required): Full UUID of the trashed memory

## Behavior

1. Checks if memory exists in database
2. Checks if memory has `trashed_at` set (is actually in trash)
3. If not trashed: returns error "is not in trash"
4. If trashed: calls `restoreMemory(memoryId)` — clears `trashed_at` field
5. Returns confirmation with first 80 characters of content preview

## Soft Delete System

- **Deleting**: `forget` tool sets `trashed_at` to current ISO timestamp (soft delete)
- **Restoring**: `restore` tool clears `trashed_at` (memory becomes active again)
- **Browsing trash**: Neural Interface `/api/trash` endpoints list trashed memories
- **Purging**: Neural Interface `/api/trash/purge` permanently deletes trashed items
- Trashed memories are excluded from `recall` search results via `trashed_at IS NULL` filter

## Quirks

- Requires the FULL 36-character UUID (same as `reflect` and `forget`)
- Only works on memories that are currently trashed
- Restored memories retain their original metadata (category, tags, importance, etc.)
