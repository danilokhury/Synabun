---
category: mcp-tools
tags: [reflect, mcp-tool, update, uuid, re-embedding, metadata]
importance: 9
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/tools/reflect.ts
---

# SynaBun reflect Tool — Update Existing Memories

The reflect tool (`mcp-server/src/tools/reflect.ts`, 157 lines) updates an existing memory's content or metadata.

## CRITICAL: Full UUID Required

Requires the FULL UUID (36 characters with dashes). The `remember` tool now returns the full UUID in its output, so use it directly. For existing memories, use `recall` to get the full UUID.

UUID regex validation: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`

If a shortened ID is provided, returns a detailed error message explaining that the full UUID is required.

## Parameters

- **memory_id** (REQUIRED): Full UUID of the memory to update
- **content** (optional): New content text — triggers re-embedding (full vector upsert)
- **importance** (optional): Updated importance score (1-10)
- **tags** (optional): Replace ALL tags with this array
- **add_tags** (optional): Append tags without replacing existing ones
- **subcategory** (optional): Updated subcategory
- **category** (optional): Move memory to a different category (validated)
- **related_files** (optional): Updated file paths
- **related_memory_ids** (optional): Link to related memories by UUID

## Update Modes

1. **Content changed** → regenerates embedding vector via embeddings service, then calls `updateVector()` (full upsert with new vector + updated payload)
2. **Metadata only** → calls `updatePayload()` (no re-embedding needed, much faster)

Both modes update the `updated_at` timestamp automatically.

## File Checksum Recomputation

On every update (regardless of mode), if the memory has `related_files` (either existing or newly provided), the `file_checksums` field is recomputed via `computeChecksums()`. This ensures the `sync` tool always compares against the latest known file state. The checksums are SHA-256 hashes of file contents, computed by `mcp-server/src/services/file-checksums.ts`.
