---
category: mcp-tools
tags: [sync, mcp-tool, stale, checksums, file-tracking, detection]
importance: 8
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/tools/sync.ts
  - mcp-server/src/services/file-checksums.ts
  - mcp-server/src/index.ts
---

# SynaBun sync Tool — Detect Stale Memories

The sync tool (`mcp-server/src/tools/sync.ts`) detects memories whose `related_files` have changed since the memory was last updated. It compares SHA-256 content hashes of files on disk against stored `file_checksums` in the memory payload.

## Parameters

- **project** (optional): Filter to only check memories for a specific project.

## Process

1. Scroll all memories from Qdrant (up to 1000)
2. Filter to memories that have non-empty `related_files` arrays
3. Optionally filter by project if specified
4. For each memory, compute current SHA-256 hash of each related file via `hashFile()`
5. Compare against stored `file_checksums` — if any hash differs or a file is missing from stored checksums, the memory is stale
6. Legacy memories without `file_checksums` are always treated as stale (need initial checksum computation)
7. Return formatted text listing stale memories sorted by importance (descending)

## Output Format

Returns a text report with:
- Summary line: "Found X stale memories (checked Y memories with related files, Z total)"
- Per-memory details: ID (full UUID), category badge, importance, list of changed files, content preview (first 120 chars)
- If no stale memories: "All N memories with related files are up to date"

## File Checksums Service

`mcp-server/src/services/file-checksums.ts` provides shared utilities:
- `hashFile(filePath)`: SHA-256 hash of a single file, returns null if file not found
- `computeChecksums(filePaths)`: Batch hash computation, returns `Record<string, string>`
- File paths are resolved relative to the SynaBun project root (`import.meta.dirname` up two levels)

## Integration

Registered in `mcp-server/src/index.ts` alongside the other 9 tools. Can be called by Claude Code at session start or before decisions to check if any remembered knowledge is outdated.
