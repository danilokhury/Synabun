---
category: hooks
tags: [hooks, post-plan, plan-storage, sqlite, embedding, auto-save]
importance: 8
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/post-plan.mjs
---

# SynaBun PostPlan Hook — Auto-Store Approved Plans

**File:** `hooks/claude-code/post-plan.mjs` (298 lines)
**Event:** PostToolUse | **Matcher:** `^ExitPlanMode$`

Fires after Claude exits plan mode. Automatically stores the approved plan into the SQLite memory database with a local embedding.

## Input (stdin JSON)

`{ tool_name, cwd, ... }`

## What It Does

1. Skips if `tool_name !== 'ExitPlanMode'`
2. Finds the most recently modified `.md` file in `~/.claude/plans/` that hasn't been stored yet
3. Reads plan content, extracts title (first H1 heading or first non-empty line)
4. Generates embedding via Transformers.js (imports `mcp-server/dist/services/local-embeddings.js` directly)
5. Writes directly to SQLite via `node:sqlite` `DatabaseSync` (NOT through the MCP server's service layer)
6. Creates/ensures `plans-{project}` child category under `plans` parent in `custom-categories.json`
7. Marks plan as stored in `data/stored-plans.json` (dedup tracker)
8. Invalidates Neural Interface cache via fire-and-forget GET to `http://localhost:3344/api/memories?invalidate=true`

## Storage Details

- Category: `plans-{project}` (e.g., `plans-criticalpixel`)
- Importance: 7
- Tags: `['plan', 'implementation', project]`
- Source: `'auto-saved'`
- DB path: `SQLITE_DB_PATH` env or `mcp-server/data/memory.db`

## Quirks

- Uses `node:sqlite` DatabaseSync directly — bypasses MCP server to avoid circular dependency
- Dedup: Once a plan filename appears in `stored-plans.json`, it's never re-stored even if ExitPlanMode fires again for the same plan
- `ensureProjectCategory()` is idempotent — safe to call repeatedly
- Embedding vector encoded as `Float32Array` → `Uint8Array` for SQLite BLOB storage

## Output

`{ additionalContext: "SynaBun: Plan stored in memory [UUID]..." }` or `{}`
