---
category: hooks
tags: [hooks, shared, utilities, project-detection, categories, helper-functions]
importance: 8
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/shared.mjs
---

# SynaBun Shared Hook Utilities

**File:** `hooks/claude-code/shared.mjs` (305 lines)
**Not a hook** — utility module imported by other hooks.

## Exported Constants

| Export | Value | Description |
|--------|-------|-------------|
| `DATA_DIR` | `../../data` | SynaBun data directory |
| `MCP_DATA_DIR` | `../../mcp-server/data` | MCP server data directory |
| `ENV_PATH` | `../../.env` | Environment file path |
| `HOOK_FEATURES_PATH` | `DATA_DIR/hook-features.json` | Feature toggles |
| `PENDING_REMEMBER_DIR` | `DATA_DIR/pending-remember` | Session flag directory |

## Exported Functions

### readStdin()
Async stdin reader with 2s timeout. Returns parsed JSON or `{}` on TTY/timeout.

### getHookFeatures()
Reads `data/hook-features.json`. Returns `{}` on error.

### getActiveConnectionId()
Reads `.env`, returns `SYNABUN_ACTIVE_CONNECTION` or `'default'`. Legacy artifact from multi-connection era.

### getCategoriesPath() / getMcpCategoriesPath()
- `getCategoriesPath()`: Returns connection-specific path `data/custom-categories-{connId}.json` — for hooks reading categories
- `getMcpCategoriesPath()`: Returns `data/custom-categories.json` (no suffix) — for writing. MCP server's file watcher only watches the suffix-less file.
- **Quirk**: Hooks that need MCP server to pick up changes (e.g., post-plan, ensureProjectCategories) MUST write to the no-suffix path.

### loadRegisteredProjects()
Reads `data/claude-code-projects.json`. Returns array of registered projects with paths, labels, and IDs.

### detectProject(cwd)
3-step project detection:
1. **Exact path prefix**: `cwd.startsWith(projPath + '/')` — most-specific match wins
2. **Substring**: `cwd` folder contains registered project's folder basename
3. **Fallback**: `basename(cwd)` lowercased

### loadCategories()
Reads connection-specific categories JSON file.

### buildCategoryTree(categories)
Renders parent/child category hierarchy as formatted text.

### ensureProjectCategories()
Idempotent function that creates categories for all registered projects:
- **Per-project** (4 children): `{label}-project`, `{label}-architecture`, `{label}-bugs`, `{label}-config`
- **Standalone defaults** (always created): `conversations`, `communication-style`, `plans` (parent)
- Labels truncated to 16 chars so children stay within the 30-char category name limit

### buildCategoryReference(categories, project)
Generates full category reference block for lazy injection into Claude's context (used by post-remember on first threshold hit).

### normalizeLabel(label)
Lowercase, replace non-alphanumeric with `-`, trim dashes.
