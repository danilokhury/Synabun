---
category: architecture
tags: [categories, hierarchy, routing, schema-refresh, file-watcher, descriptions]
importance: 9
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/services/categories.ts
  - mcp-server/data/custom-categories.json
---

# SynaBun Category System Deep Dive

Categories are the organizational backbone of SynaBun, managed by `mcp-server/src/services/categories.ts` (364 lines).

## Storage

- File: `mcp-server/data/custom-categories.json`
- Format: `{ version: 1, categories: [{ name, description, created_at, parent, color, is_parent }] }`
- **NO hardcoded defaults** — fully user-defined. Empty on fresh install.

## Category Descriptions as Routing Instructions

- Descriptions are **NOT labels** — they are prescriptive routing guidelines that the AI reads every time it calls `remember`
- `buildCategoryDescription()` generates a hierarchical routing guide injected into all tool schemas
- Format: `[parent] (parent) — description\n  child=description`
- Prepends: "Read each category description as a guideline for what belongs there"

## Hierarchy

- Parent categories (`is_parent: true`) group child categories (`parent: "parentName"`)
- Standalone categories have neither `is_parent` nor `parent`
- Helper functions: `getParentCategories()`, `getChildCategories(parentName)`, `getCategoryTree()`

## Dynamic Schema Refresh

- Any category change triggers `refreshCategorySchemas()` in `index.ts`
- Rebuilds tool schemas for: remember, recall, reflect, memories (all tools that reference categories)
- Sends `notifications/tools/list_changed` to MCP client — AI sees updated categories without restart

## File Watcher

- `startWatchingCategories()` monitors `custom-categories.json` for external changes (e.g., Neural Interface edits)
- On external change: invalidates cache → calls `onExternalChangeCallback` → triggers schema refresh

## Color System

- 36-color palette with auto-assignment via hash function
- Custom colors via hex code (`#rrggbb`)
- Empty string `""` reverts to auto-assigned color
