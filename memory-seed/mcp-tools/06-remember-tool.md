---
category: mcp-tools
tags: [remember, mcp-tool, store, embedding, upsert, parameters]
importance: 9
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/tools/remember.ts
---

# SynaBun remember Tool — Store New Memories

The remember tool (`mcp-server/src/tools/remember.ts`, 117 lines) stores new information in persistent vector memory.

## Parameters

- **content** (REQUIRED): The information to remember. Must be specific and include context — vague content produces poor embeddings.
- **category** (REQUIRED): Must match an existing category in `custom-categories.json`. Validated at call time.
- **project** (optional): Auto-detected from working directory via `detectProject()`. Use `"global"` for universal knowledge, `"shared"` for cross-project knowledge.
- **tags** (optional): Array of strings for filtering and categorization.
- **importance** (optional, default 5): Scale 1-10. Memories with importance >= 8 are immune to time decay in recall scoring.
- **subcategory** (optional): Refinement — architecture, bug-fix, api-quirk, performance, config, deployment.
- **source** (optional): How learned — user-told, self-discovered, auto-saved.
- **related_files** (optional): Array of file paths this memory relates to.

## Process

1. Validate category exists via `categoryExists()`
2. Generate UUID (`crypto.randomUUID()`)
3. Build MemoryPayload with timestamps (`created_at`, `updated_at`, `accessed_at` all set to now, `access_count = 0`)
4. Compute SHA-256 file checksums for any `related_files` via `computeChecksums()` — stored as `file_checksums` in the payload for stale memory detection
5. Generate embedding vector via embeddings service (OpenAI-compatible API)
6. Upsert point to Qdrant via `upsertMemory(id, vector, payload)`
7. Return shortened ID (first 8 chars of UUID) and content summary

**IMPORTANT:** The returned shortened ID is for display only. The `reflect` tool requires the FULL UUID — use `recall` to retrieve it.

**Category Schema:** The category parameter description is built dynamically by `buildCategoryDescription()`, which reads all categories and constructs a hierarchical routing guide. This is why category changes propagate to tool schemas without restart.
