---
category: mcp-tools
tags: [memories, mcp-tool, browse, stats, recent]
importance: 7
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/tools/memories.ts
---

# SynaBun memories Tool — Browse and Statistics

The memories tool (`mcp-server/src/tools/memories.ts`, 142 lines) provides browsing and statistics for the memory collection.

## Parameters

- **action** (REQUIRED): One of 4 modes — `recent`, `stats`, `by-category`, `by-project`
- **category** (optional): Filter for `by-category` action
- **project** (optional): Filter for `by-project` action
- **limit** (optional, default 10, max 50): Number of results

## Action Modes

1. **stats**: Returns aggregate statistics — total memory count, counts per category, counts per project, oldest and newest memory timestamps. Uses `getMemoryStats()` which scrolls all points to build project counts.

2. **recent**: Returns the latest N memories sorted by `created_at` descending. Uses `scrollMemories` with no filter, then sorts in-memory.

3. **by-category**: Filters memories by a specific category name. Uses `scrollMemories` with category filter, sorted by `created_at`.

4. **by-project**: Filters memories by a specific project name. Uses `scrollMemories` with project filter, sorted by `created_at`.

## Output Format

Each memory displays: ID (full UUID), category/subcategory, project, importance, age (formatted), tags, content preview (first 150 characters).

## Use Cases

- Auditing memory health and distribution
- Checking what's stored for a project
- Finding old/outdated memories to clean up
- Verifying category distribution
