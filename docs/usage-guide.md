# SynaBun - Usage Guide

Detailed usage patterns, workflows, and troubleshooting for SynaBun's MCP tools.

For installation and setup, see the [README](../README.md).

## Table of Contents
- [Basic Workflows](#basic-workflows) (store, search, update, delete, restore, sync, audit)
- [Advanced Patterns](#advanced-patterns)
- [Tool-Specific Quirks](#tool-specific-quirks)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [AI Integration Patterns](#ai-integration-patterns)

---

## Basic Workflows

### Storing a simple memory

```javascript
// Basic usage - content only
remember({
  content: "Redis TTL for price cache is 1 hour, set in orchestratorSingleton.ts",
  category: "project"
})

// Returns: Remembered [8f7cab3b] (project, importance: 5)
```

### Storing with metadata (proper workflow)

Due to parameter serialization limitations in some AI tools, use this two-step approach:

```javascript
// Step 1: Create the memory
remember({
  content: "Redis TTL for price cache is 1 hour, set in orchestratorSingleton.ts",
  category: "project",
  project: "my-project"
})

// Step 2: Get the full UUID
recall({
  query: "Redis TTL price cache",
  limit: 1
})
// Returns: [8f7cab3b-644e-4cea-8662-de0ca695bdf2] (full UUID)

// Step 3: Add metadata
reflect({
  memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2",
  importance: 7,
  tags: ["redis", "cache", "pricing"],
  subcategory: "architecture"
})
```

### Searching memories

```javascript
// Simple semantic search
recall({
  query: "how does the price caching work",
  limit: 5
})

// With filters
recall({
  query: "database performance",
  category: "learning",
  min_importance: 7,
  limit: 10
})

// Project-specific
recall({
  query: "authentication flow",
  project: "my-project",
  tags: ["auth", "security"]
})
```

### Updating memories

```javascript
// First, get the full UUID
recall({ query: "Redis TTL", limit: 1 })
// Returns: [8f7cab3b-644e-4cea-8662-de0ca695bdf2]

// Then update
reflect({
  memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2",
  importance: 9,  // Upgraded to critical
  content: "Redis TTL for price cache is 1 hour, set in orchestratorSingleton.ts. Never change this without testing - production depends on it!",
  add_tags: ["critical", "production"]
})
```

### Deleting memories

```javascript
// Get the UUID first
recall({ query: "obsolete feature", limit: 1 })

// Soft-delete (moves to trash — can be restored)
forget({ memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2" })
```

### Restoring deleted memories

```javascript
// Undo a forget — restore from trash
restore({ memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2" })
```

`forget` is a soft delete that sets a `trashed_at` timestamp. The memory remains in Qdrant but is excluded from search results. Use `restore` to undo, or permanently purge from the Neural Interface (Settings > Trash > Purge All).

### Detecting stale memories

```javascript
// Check which memories reference files that have changed
sync({ project: "my-project" })
```

The `sync` tool compares SHA-256 hashes of files listed in `related_files` against stored checksums. Returns a list of memories that may be outdated. Useful after code refactors or large changes.

**Workflow:**
1. Run `sync` to find stale memories
2. Review each stale memory
3. Either `reflect` to update the content, or `forget` if no longer relevant
4. Re-run `sync` to confirm all memories are current

### Memory audit via `/synabun`

The `/synabun` command hub includes an **Audit Memories** option that automates the stale memory detection workflow:

```
/synabun    # Select "Audit Memories" from the interactive menu
```

The audit runs 6 phases: landscape survey → checksum pre-scan → bulk retrieval → parallel semantic verification → interactive classification → audit report. See [README: Claude Code `/synabun` Command](../README.md#claude-code-synabun-command) for details.

---

## Advanced Patterns

### Session context preservation

At the end of a work session, store ongoing context:

```javascript
remember({
  content: "Currently refactoring the price orchestrator. Moving cache logic to a separate service. Next: update tests and add error handling for API timeouts.",
  category: "conversation",
  importance: 6,
  subcategory: "ongoing-work"
})
```

At the start of the next session, recall it:

```javascript
recall({
  query: "refactoring orchestrator ongoing work",
  category: "conversation",
  limit: 3
})
```

### Bug fix documentation

When fixing a hard bug, document it with high importance:

```javascript
remember({
  content: "Bug: Qdrant batch upsert fails silently when batch size exceeds 500 points. Error is swallowed by Qdrant client. Solution: Split batches into chunks of 100 points max. Fixed in services/qdrant.ts upsertBatch().",
  category: "learning",
  subcategory: "bug-fix",
  importance: 8,
  related_files: ["src/services/qdrant.ts"]
})
```

### Architecture decision records

Document important decisions with their rationale:

```javascript
remember({
  content: "Decision: Use single Qdrant collection for all projects instead of per-project collections. Reasoning: Enables cross-project knowledge sharing, simpler maintenance, project-based filtering via payload. Trade-off: Slightly slower queries (mitigated by indexes).",
  category: "project",
  subcategory: "architecture",
  importance: 9,
  tags: ["qdrant", "architecture", "collections"]
})
```

### Cross-project knowledge

Store general patterns that apply across projects:

```javascript
remember({
  content: "Pattern: For Redis caching with TTL, always include cache key prefix in the key name (e.g., 'prices:steam:12345') to enable batch invalidation via pattern matching. Use SCAN instead of KEYS in production.",
  category: "knowledge",
  importance: 7,
  tags: ["redis", "caching", "best-practice"]
  // No project field - applies to all projects
})
```

### Brainstorming via `/synabun`

The `/synabun` command hub includes a **Brainstorm Ideas** option that uses multi-round recall. Instead of a single `recall`, it executes 5 rounds with different query strategies (direct, adjacent, problem-space, solution-space, cross-domain) and synthesizes connections between disparate memories.

```
/synabun    # Select "Brainstorm Ideas" from the interactive menu
```

The brainstorming generates 3-5 concrete ideas, each traced back to specific memories that inspired it. See the [README](../README.md#claude-code-synabun-command) for full details.

You can also build your own multi-round recall workflows:

```javascript
// Round 1: Direct search
recall({ query: "WebSocket implementation", limit: 5 })

// Round 2: Adjacent concepts (based on Round 1 results)
recall({ query: "real-time pub/sub event-driven", limit: 5 })

// Round 3: Cross-domain surprise
recall({ query: "synchronization patterns", category: "deals", limit: 5 })

// Synthesize connections across rounds
```

---

## Tool-Specific Quirks

### `remember` tool

**Works:**
```javascript
remember({
  content: "Content here",
  category: "project",
  project: "myproject",
  source: "user-told"
})
```

**Full example with all fields:**
```javascript
remember({
  content: "Content here",
  category: "project",
  importance: 7,
  tags: ["tag1", "tag2"]
})
// Returns: Remembered [full-uuid-here] (project/myproject, importance: 7): "Content here"
```

`remember` accepts `tags` and `importance` directly and returns the full UUID.

---

### `reflect` tool

**Critical requirement:** Must use the **full UUID**, not a shortened ID.

**Wrong:**
```javascript
reflect({
  memory_id: "8f7cab3b",  // Shortened ID — will fail
  importance: 7
})
// Returns: Bad Request
```

**Correct:**
```javascript
// Step 1: Get full UUID via recall
recall({ query: "relevant search", limit: 1 })
// Returns: [8f7cab3b-644e-4cea-8662-de0ca695bdf2]

// Step 2: Use full UUID
reflect({
  memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2",
  importance: 7
})
// Returns: Updated [8f7cab3b]: importance -> 7
```

**Why:** The `remember` tool now returns the full UUID in its output (`[8f7cab3b-644e-4cea-8662-de0ca695bdf2]`). Use this directly. The `reflect` tool validates the UUID format and rejects shortened IDs.

**Parameter name:** Use `memory_id`, not `id` or `uuid`.

---

### `recall` tool

**Best practices:**

- **Set appropriate limits:** Default is 5, max is 20. Higher limits may slow down the query.
- **Use min_score sparingly:** Scores range 0-1. Default threshold is 0.3. Only increase if you want very strict matching.
- **Project filtering:** Omit `project` to search all projects with current-project boost. Specify `project` to search only that project.
- **Category filtering:** Use to narrow search scope. Example: `category: "learning"` for bug fixes only.

**Example - narrow search:**
```javascript
recall({
  query: "authentication bug with JWT tokens",
  category: "learning",
  subcategory: "bug-fix",
  project: "my-project",
  min_importance: 7,
  limit: 5
})
```

---

### `forget` and `restore` tools

`forget` performs a **soft delete** — it sets a `trashed_at` timestamp on the memory. The memory remains in Qdrant but is excluded from `recall` search results.

**Best practice:** Always verify the memory content before deletion:

```javascript
// Step 1: Search and review
recall({ query: "obsolete feature", limit: 3 })

// Step 2: Confirm which one to delete (read the content)

// Step 3: Soft-delete by full UUID
forget({ memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2" })

// Step 4 (if needed): Undo the deletion
restore({ memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2" })
```

**Permanent deletion:** To permanently remove trashed memories, use the Neural Interface (Trash panel > Purge All) or call `DELETE /api/trash/purge`.

---

### `sync` tool

Detects memories whose `related_files` have changed since the memory was last updated. Uses SHA-256 content hashing.

```javascript
// Check all memories
sync()

// Check memories for a specific project
sync({ project: "my-project" })
```

Returns a list of stale memories with details about which files changed. Use this after code refactors to identify memories that need updating.

---

### `memories` tool

**Four actions available:**

1. **stats** - Get counts by category and project
   ```javascript
   memories({ action: "stats" })
   ```

2. **recent** - List most recent memories
   ```javascript
   memories({ action: "recent", limit: 10 })
   ```

3. **by-category** - Filter by category
   ```javascript
   memories({ action: "by-category", category: "learning", limit: 20 })
   ```

4. **by-project** - Filter by project
   ```javascript
   memories({ action: "by-project", project: "my-project", limit: 20 })
   ```

---

## Best Practices

### 1. Always call memory tools sequentially

**Wrong (parallel calls):**
```javascript
// If one fails, all fail with "Sibling tool call errored"
[remember(...), remember(...), remember(...)]
```

**Correct (sequential calls):**
```javascript
remember(...)  // Wait for completion
remember(...)  // Then next
remember(...)  // Then next
```

### 2. Use appropriate importance scores

- **5 (default):** Standard decisions, routine configs
- **6-7:** Significant patterns, important fixes
- **8-9:** Critical bugs, key architecture decisions
- **10:** Core architecture, security rules, owner preferences

Memories with importance 8+ are immune to time-based decay.

### 3. Add related_files for code-related memories

```javascript
remember({
  content: "Bug fix: Race condition in cache invalidation...",
  category: "learning",
  related_files: [
    "src/lib/cache/redis-client.ts",
    "src/lib/services/orchestrator.ts"
  ]
})
```

This enables file-based search and better context.

### 4. Use descriptive subcategories

Categories are broad (`project`, `learning`, `knowledge`). Subcategories add specificity:

- `project` -> `architecture`, `deployment`, `config`
- `learning` -> `bug-fix`, `api-quirk`, `performance`
- `knowledge` -> `best-practice`, `tooling`, `pattern`

### 5. Recall before making decisions

Before implementing a feature or fixing a bug, check if there's existing knowledge:

```javascript
recall({ query: "authentication implementation patterns", limit: 5 })
recall({ query: "similar bug with caching", category: "learning", limit: 3 })
```

---

## Troubleshooting

### Problem: `reflect` returns "Bad Request"

**Cause:** Using shortened memory ID instead of full UUID.

**Solution:** `remember` now returns the full UUID. Use it directly:
```javascript
// remember returns: Remembered [8f7cab3b-644e-4cea-8662-de0ca695bdf2] (...)
// Use the full UUID with reflect:
reflect({ memory_id: "8f7cab3b-644e-4cea-8662-de0ca695bdf2", ... })

// For existing memories, use recall to get the full UUID:
recall({ query: "relevant search", limit: 1 })
```

---

### Problem: `remember` fails with "Expected array, received string"

**Cause:** AI tool serializing array/number parameters as strings (rare — mostly resolved in modern MCP SDK).

**Solution:** `remember` now uses `z.coerce.number()` for importance and standard array validation for tags. Pass them directly:
```javascript
remember({
  content: "...",
  category: "project",
  importance: 7,
  tags: ["tag1", "tag2"]
})
// Returns full UUID — no need for recall+reflect
```

If your MCP client still fails, use `reflect` as a fallback to set these fields after `remember`.

---

### Problem: "Sibling tool call errored"

**Cause:** Making parallel memory tool calls - if one fails, all fail.

**Solution:** Call memory tools sequentially, one at a time.

---

### Problem: Can't find recently stored memory

**Possible causes:**
1. **Importance too low + time decay:** If importance < 8, older memories decay. Increase importance via `reflect`.
2. **Wrong project filter:** Omit `project` parameter to search all projects.
3. **Query too specific:** Try broader search terms.

**Debug approach:**
```javascript
// Check if it exists
memories({ action: "recent", limit: 20 })

// Search without filters
recall({ query: "broad search term", limit: 10 })

// Check specific project
memories({ action: "by-project", project: "myproject", limit: 20 })
```

---

### Problem: Qdrant connection refused

**Symptoms:** `fetch failed`, `connection refused`, `ECONNREFUSED`

**Checklist:**
1. Is Qdrant container running? `docker ps | grep synabun-qdrant`
2. Start if not: `docker compose up -d`
3. Check logs: `docker compose logs -f`
4. Test connection: `curl -H "api-key: YOUR_KEY" http://localhost:6333/collections`

---

## AI Integration Patterns

### For Claude Code

Add to your project's `CLAUDE.md` (see the [README](../README.md#claudemd-integration) for a ready-to-use template).

### For Cursor AI

Add to `.cursorrules`:

```
Memory MCP Tools Available:
- remember: Store knowledge (content, category, project, tags, importance)
- recall: Semantic search (query, limit, filters)
- reflect: Update existing memory (requires full UUID)
- forget: Delete memory (requires full UUID)
- memories: List/stats (recent, by-category, by-project)

Usage:
- Use recall at session start to load context
- Use remember with tags + importance for: bug fixes (7+), architecture decisions (8+), ongoing work (6)
- remember returns full UUID. Use reflect only to update existing memories.
- Call tools sequentially, not in parallel
```

### For other MCP clients

1. **Test parameter serialization:** Try passing arrays and numbers to `remember`. Modern MCP SDKs handle this correctly. If your client still fails, use `reflect` as a fallback.

2. **UUID handling:** `remember` now returns the full UUID. Use it directly with `reflect` if needed. For existing memories, use `recall` to get the full UUID.

3. **Error handling:** If you see "Sibling tool call errored", make calls sequentially.

4. **Documentation:** Add tool usage patterns to your project's AI instruction files.

---

## Examples by Use Case

### Use case: Bug triage

```javascript
// Check if similar bugs exist
recall({
  query: "authentication timeout error 401",
  category: "learning",
  subcategory: "bug-fix",
  limit: 5
})

// If found, read the solution
// If not, document after fixing
remember({
  content: "Bug: Auth tokens expire after 1 hour but frontend doesn't refresh. Solution: Add token refresh interceptor in axios config. Fixed in: src/lib/api/client.ts",
  category: "learning",
  subcategory: "bug-fix",
  importance: 7,
  related_files: ["src/lib/api/client.ts"]
})
```

---

### Use case: Feature planning

```javascript
// Recall past decisions
recall({
  query: "real-time features WebSocket implementation",
  category: "project",
  limit: 5
})

// Store the plan
remember({
  content: "Feature plan: Real-time notifications. Tech: WebSocket via Socket.io. Fallback: Server-sent events. Redis pub/sub for multi-instance support.",
  category: "idea",
  subcategory: "feature-plan",
  importance: 7
})
```

---

### Use case: Onboarding new team member

```javascript
// Get project overview
memories({ action: "by-project", project: "my-project", limit: 50 })

// Get architecture decisions
recall({
  query: "architecture database cache",
  category: "project",
  subcategory: "architecture",
  project: "my-project",
  limit: 10
})

// Get common gotchas
recall({
  query: "gotcha bug issue problem",
  category: "learning",
  project: "my-project",
  limit: 10
})
```

---

### Use case: Brainstorming with memory

```javascript
// Step 1: Survey the landscape
category_list({ format: "tree" })
memories({ action: "stats" })

// Step 2: Multi-round recall with different angles
// Round 1 - Direct: the topic
recall({ query: "notification system real-time", limit: 5 })

// Round 2 - Adjacent: themes from Round 1
recall({ query: "WebSocket Redis pub/sub event streaming", limit: 5 })

// Round 3 - Problem-space: known issues
recall({ query: "notification bugs latency race condition", limit: 5 })

// Round 4 - Solution-space: past approaches
recall({ query: "caching architecture optimization pattern", limit: 5 })

// Round 5 - Cross-domain: unrelated category
recall({ query: "real-time updates", category: "deals", limit: 5 })

// Step 3: Synthesize ideas from connections across rounds
// Step 4: Save the best ideas
remember({
  content: "Idea: Reuse the price update WebSocket infrastructure for forum notifications. The deals system already handles real-time price pushes via Redis pub/sub — extend it to forum events.",
  category: "ideas",
  project: "criticalpixel"
})
```

The **Brainstorm Ideas** option in `/synabun` automates this entire workflow. See the [README](../README.md#claude-code-synabun-command).

---

## AI-Agnostic Best Practices

These rules apply to **all AI assistants** using SynaBun:

### 1. Always format memory content in Markdown

When storing memories, format the `content` field using Markdown for readability and structure:

**Good - Markdown formatted:**
```javascript
remember({
  content: `## Bug Fix: Qdrant Batch Upsert Limit

**Problem:** Batch upsert fails silently when exceeding 500 points.

**Root Cause:** Qdrant client swallows error, no validation on batch size.

**Solution:** Split batches into chunks of 100 points max.

**Files Modified:**
- \`src/services/qdrant.ts\` (upsertBatch function)

**Testing:** Verified with 1000-point batch, success rate 100%.`,
  category: "learning",
  subcategory: "bug-fix",
  importance: 8
})
```

**Bad - Plain text:**
```javascript
remember({
  content: "Bug fix: Qdrant batch upsert fails when batch size exceeds 500 points. Solution: split into chunks of 100. Fixed in services/qdrant.ts",
  category: "learning"
})
```

**Why:** Markdown formatting makes memories:
- Easier to read when recalled
- Structured for quick scanning
- Consistent across projects
- Parseable by any AI

**Markdown elements to use:**
- `##` Headers for sections
- `**Bold**` for key terms
- `` `code` `` for file paths, function names, code snippets
- `-` Bullet lists for items
- `>` Blockquotes for important notes

---

### 2. Use full UUIDs with `reflect`

`remember` returns the full UUID directly. Use it with `reflect` when needed. For existing memories, use `recall` to get the full UUID. Never use shortened IDs.

---

### 3. Call tools sequentially

Never make parallel memory tool calls. Always wait for one to complete before calling the next.

---

### 4. Pass all fields to `remember` directly

`remember` accepts `tags`, `importance`, and all other fields directly. No need for a separate `reflect` call. If your MCP client has serialization issues with arrays/numbers, use `reflect` as a fallback.

---

### 5. Document as you work

Store memories proactively:
- Bug fixes (importance 7+)
- Architecture decisions (8+)
- API quirks discovered (6+)
- Session context before ending work (5-6)

---

## Summary

**Golden rules:**
1. **Format memory content in Markdown** for readability and structure
2. Pass `tags` and `importance` directly to `remember` — it returns the full UUID
3. Call memory tools sequentially, never in parallel
4. Use importance 8+ for critical knowledge
5. Add `related_files` for code-related memories
6. Check existing memories before implementing (recall first)

For installation and setup, see the [README](../README.md).
