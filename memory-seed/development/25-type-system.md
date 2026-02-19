---
category: development
tags: [types, typescript, interfaces, payload, schema, data-model]
importance: 7
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/types.ts
---

# SynaBun MemoryPayload Type System

Defined in `mcp-server/src/types.ts` (36 lines). These TypeScript interfaces define the data model for all memory operations.

## MemoryPayload (stored in Qdrant as point payload)

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | The actual memory text. Specific and contextual for good embeddings. |
| `category` | string | Validated against `custom-categories.json`. Cannot be empty. |
| `subcategory?` | string | Optional refinement: architecture, bug-fix, api-quirk, performance, config, deployment |
| `project` | string | Auto-detected or manual. Special: `"global"` (universal), `"shared"` (cross-project) |
| `tags` | string[] | Filterable keywords for categorization and search filtering. |
| `importance` | number (1-10) | Determines time decay immunity (>= 8 immune) and search ranking. |
| `source` | MemorySource | How learned: `"user-told"`, `"self-discovered"`, `"migration"`, `"auto-saved"` |
| `created_at` | string (ISO) | Set once at creation, never changes. |
| `updated_at` | string (ISO) | Updated on every reflect/edit operation. |
| `accessed_at` | string (ISO) | Updated on every recall that returns this memory. |
| `access_count` | number | Incremented on every recall hit. Used in scoring: `min(0.1, count * 0.01)`. |
| `related_files?` | string[] | File paths this memory relates to. Displayed in recall results. Used for graph edges (shared files create connections) and stale memory detection via checksums. |
| `related_memory_ids?` | string[] | UUIDs of related memories. Creates strong graph edges (0.9 strength). |
| `file_checksums?` | Record<string, string> | SHA-256 content hashes of related files at time of last update. Used by the `sync` tool to detect when files have changed since the memory was last updated. Computed automatically by `remember` and `reflect` tools via `computeChecksums()`. |

## Importance Scale

| Range | Label | Notes |
|-------|-------|-------|
| 1-2 | Trivial | Quick notes, temporary context |
| 3-4 | Low | Minor observations |
| 5 | Normal | Default. Standard information |
| 6-7 | Significant | Important patterns, notable bugs |
| 8-9 | Critical | **Immune to time decay.** Architecture decisions, hard-won fixes |
| 10 | Foundational | Core knowledge that should never fade |

## MemorySearchResult (returned by recall)

- `id`: string (UUID)
- `score`: number (0-1, final relevance score after re-ranking)
- `payload`: MemoryPayload

## MemoryStats (returned by memories tool with action=stats)

- `total`: number
- `by_category`: Record<string, number>
- `by_project`: Record<string, number>
- `oldest?`: string (ISO timestamp)
- `newest?`: string (ISO timestamp)
