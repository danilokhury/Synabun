---
category: mcp-tools
tags: [category-tools, mcp-tool, crud, hierarchy, schema-refresh, validation]
importance: 8
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/tools/category-create.ts
  - mcp-server/src/tools/category-update.ts
  - mcp-server/src/tools/category-delete.ts
  - mcp-server/src/tools/category-list.ts
---

# SynaBun Category Management Tools (4 tools)

Four MCP tools manage the category system. ALL changes trigger `refreshCategorySchemas()` + `notifications/tools/list_changed`, so the AI sees updated categories without restart.

## category_create (89 lines)

- **Required**: `name` (lowercase, letter-start, 2-30 chars, `/^[a-z][a-z0-9-]*$/`), `description` (non-empty routing guideline)
- **Optional**: `parent` (parent category name), `color` (hex `#rrggbb`, auto-assigned from 36-color palette if omitted), `is_parent` (boolean for cluster categories)
- Validates: name pattern, length, uniqueness, color format, parent existence

## category_update (187 lines)

- **Required**: `name` (category to update)
- **Optional**: `new_name` (rename — propagates to all children), `description`, `parent` (change hierarchy — empty string `""` removes parent), `color` (empty string `""` reverts to auto)
- Validates: no self-reference as parent, no circular dependencies (walks parent chain)
- Most complex category tool due to rename propagation and hierarchy validation

## category_delete (145 lines)

- **Required**: `name` (category to delete)
- **Optional**: `reassign_to` (REQUIRED if memories exist in this category), `reassign_children_to` (REQUIRED if category has children — empty string `""` makes them top-level)
- Process: reassign children → batch-update Qdrant memories → remove from `custom-categories.json`
- Cannot reassign to self

## category_list (109 lines)

- **Optional**: `format` — `flat` (all categories with metadata), `tree` (hierarchical with parents/children, DEFAULT), `parents-only` (top-level with child counts)
- Tree format shows parents as headers with indented children and descriptions
