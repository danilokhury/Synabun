---
category: architecture
tags: [fts5, full-text-search, sqlite, porter, tokenizer]
importance: 7
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/services/sqlite.ts
---

# SynaBun FTS5 Full-Text Search

SQLite FTS5 virtual table provides fast keyword search alongside vector similarity search.

## Schema

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, project, tags,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);
```

## Features

- **Porter stemmer**: Matches word variants (e.g., "running" matches "run")
- **Unicode61 tokenizer**: Handles international characters
- **Content sync**: FTS table mirrors the `memories` table via `content=memories`
- **Indexed columns**: content, category, project, tags

## Usage

FTS5 is used as a complement to vector similarity search:
- Vector search: finds semantically similar content (meaning-based)
- FTS5 search: finds exact keyword matches (term-based)

Both can be used together for hybrid search — vector similarity for ranking with FTS5 for filtering.

## Maintenance

FTS5 table is automatically maintained when memories are inserted, updated, or deleted through the SQLite service layer. No manual reindexing needed under normal operation.
