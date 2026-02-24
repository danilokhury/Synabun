---
category: neural-interface
tags: [graph, edges, visualization, cosine-similarity, clustering, force-directed]
importance: 8
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - neural-interface/server.js
  - neural-interface/public/index.html
---

# SynaBun Graph Edge Calculation for 3D Visualization

Graph edges are computed server-side in `GET /api/memories` and drive the force-directed layout in the Neural Interface's 3D graph.

## Four Edge Sources

Each produces edges with different strength values:

### 1. Cosine Similarity (vector-based)
Computes pairwise cosine similarity between all memory vectors. Threshold: > 0.65. Edge strength = the raw similarity score. This is the primary relationship signal — semantically similar memories cluster together.

### 2. Shared Related Files
If two memories share one or more `related_files` paths, an edge is created. Strength formula: `0.3 base + 0.15 per additional shared file`. Example: 1 shared file = 0.3, 2 shared files = 0.45, 3 shared files = 0.6. This replaced the previous "shared tags" edge source.

### 3. Same Parent Category
If two memories belong to categories that share the same parent (loaded from `custom-categories.json`), a weaker edge is created with strength 0.2. The server builds a `categoryParentMap` from the categories file — categories without a parent use their own name as the parent. This replaced the previous "same category" edge source, providing broader clustering by category family.

### 4. Explicit Related Memory IDs
If a memory's `related_memory_ids` array references another memory, an edge is created with strength 0.9 — the strongest possible. These are manually-declared relationships via the `reflect` tool.

## Edge Deduplication

When multiple sources create an edge between the same two nodes, only the highest-strength edge is kept.

## Visualization Impact

Stronger edges pull nodes closer together in the force-directed layout. This means semantically similar memories with shared files and explicit links form tight clusters, while loosely related memories orbit at the periphery.
