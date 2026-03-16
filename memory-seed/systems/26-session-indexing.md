---
category: architecture
tags: [session-indexing, conversation, transcript, chunks, compaction, sqlite]
importance: 8
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/services/sqlite.ts
  - hooks/claude-code/pre-compact.mjs
  - hooks/claude-code/session-start.mjs
  - hooks/claude-code/post-remember.mjs
  - neural-interface/server.js
---

# SynaBun Session Indexing System

Session indexing captures and stores conversation context from Claude Code sessions, making past conversations searchable via semantic search.

## session_chunks Table

Each chunk represents a segment of a conversation:

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| vector | BLOB | Float32Array embedding |
| content | TEXT | Chunk content |
| summary | TEXT | Optional summary |
| session_id | TEXT | Claude Code session ID |
| project | TEXT | Project identifier |
| git_branch | TEXT | Branch at time of session |
| cwd | TEXT | Working directory |
| chunk_index | INTEGER | Position in session |
| start_timestamp | TEXT | Chunk start time |
| end_timestamp | TEXT | Chunk end time |
| tools_used | TEXT | JSON array of tools used |
| files_modified | TEXT | JSON array of modified files |
| files_read | TEXT | JSON array of read files |
| user_messages | TEXT | JSON array of user messages |
| turn_count | INTEGER | Number of turns |
| related_memory_ids | TEXT | JSON array of related memories |
| dedup_memory_id | TEXT | Reference for deduplication |
| indexed_at | TEXT | When indexed |

## Indexing Flow

### Triggered by Context Compaction

```
1. Context fills up → PreCompact hook fires
2. PreCompact: parses transcript JSONL, caches summary in data/precompact/{sessionId}.json
3. PreCompact: writes data/pending-compact/{sessionId}.json flag
4. Claude restarts with compacted context (source='compact')
5. SessionStart: reads precompact cache, injects indexing instructions
6. Claude stores a 'conversations' category memory summarizing the session
7. PostRemember: detects category='conversations', clears pending-compact flag
8. Stop hook: no more pending-compact → allows Claude to proceed
```

### Transcript Parsing

The PreCompact hook's `parseTranscript()` reads JSONL format:
- Extracts up to 15 user messages (300 char limit each)
- Extracts up to 5 assistant text snippets (200 char limit)
- Tracks all tools used (Set for dedup)
- Identifies files modified (Edit/Write/NotebookEdit targets)
- Identifies files read
- Detects git/npm commands from Bash calls

### Neural Interface API

- `POST /api/session-indexing/start` — trigger indexing
- `POST /api/session-indexing/cancel` — cancel in-progress indexing
- `GET /api/session-indexing/status` — check indexing status
- `POST /api/session-indexing/mirror` — mirror chunks to memory collection

## Recall Integration

The `recall` tool supports `include_sessions` parameter:
- `true`: forces search across session chunks in addition to memories
- `false`: disables session search
- Auto: triggers on temporal queries or when memory results are sparse
