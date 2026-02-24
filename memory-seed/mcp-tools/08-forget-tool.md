---
category: mcp-tools
tags: [forget, mcp-tool, delete, uuid]
importance: 7
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/tools/forget.ts
---

# SynaBun forget Tool — Delete Memories

The forget tool (`mcp-server/src/tools/forget.ts`, 42 lines) permanently deletes a memory from Qdrant.

## Parameters

- **memory_id** (REQUIRED): The full UUID of the memory to delete.

## Process

1. Retrieve the memory from Qdrant via `getMemory(id)` to verify it exists
2. If not found, return error "Memory not found"
3. Delete the point from Qdrant via `deleteMemory(id)`
4. Return confirmation with shortened ID and content preview (first ~100 chars)

## Notes

- Deletion is permanent — there is no undo or trash/archive system
- The `memory_id` must be the full UUID format, not the shortened 8-char display ID
- Use `recall` first to find memories and get their full UUIDs before deleting
- The simplest of the 9 MCP tools — single parameter, straightforward delete
