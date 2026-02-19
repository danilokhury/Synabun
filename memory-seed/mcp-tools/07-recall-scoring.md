---
category: mcp-tools
tags: [recall, mcp-tool, search, scoring, time-decay, relevance, importance-shield]
importance: 10
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/tools/recall.ts
---

# SynaBun recall Tool & Relevance Scoring Algorithm

The recall tool (`mcp-server/src/tools/recall.ts`, 179 lines) performs semantic search with a custom multi-factor relevance scoring system.

## Parameters

- **query** (REQUIRED): Natural language search text, embedded for vector similarity.
- **category** (optional): Filter to specific category.
- **project** (optional): Filter to specific project. If OMITTED, searches all projects but boosts current project.
- **tags** (optional): Filter by any matching tag.
- **limit** (optional, default 5, max 20): Number of results.
- **min_importance** (optional): Minimum importance threshold.
- **min_score** (optional, default 0.3): Minimum similarity score (0-1).

## Relevance Scoring Algorithm

1. **Base Score**: Cosine similarity from Qdrant vector search
2. **Time Decay**: `Math.pow(0.5, ageInDays / 90)` — 90-day half-life means a 90-day-old memory scores 50% of its raw similarity
3. **IMPORTANCE SHIELD**: If importance >= 8, time decay is SKIPPED entirely (memory stays fully relevant forever)
4. **Final Score**: `0.7 * rawScore + 0.2 * recencyMultiplier + 0.1 * accessBoost`
5. **Project Boost**: 1.2x multiplier when `memory.project` matches the current project
6. **Access Boost**: `min(0.1, access_count * 0.01)` — frequently recalled memories get a small relevance increase

## Process

1. Embed the query text
2. Build Qdrant filter (must clauses for category/project/tags/importance)
3. Search Qdrant with `limit * 2` (over-fetch for re-ranking headroom)
4. Apply time decay + project boost + access boost re-ranking
5. Sort by final score, slice to requested limit
6. Fire-and-forget: Update `accessed_at` timestamp and increment `access_count` for each returned result
7. Format output with score%, importance, age description, tags, related files

**Age Formatting:** "today", "1 day ago", "N days ago", "1 month ago", "N months ago"
