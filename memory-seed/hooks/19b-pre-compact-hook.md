---
category: hooks
tags: [hooks, pre-compact, transcript, session-indexing, cache]
importance: 8
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/pre-compact.mjs
---

# SynaBun PreCompact Hook — Transcript Caching

**File:** `hooks/claude-code/pre-compact.mjs` (217 lines)
**Event:** PreCompact | **Timeout:** 10 seconds

Fires BEFORE context compaction. Reads the session transcript, caches parsed data for session-start to use on restart, and writes a pending-compact flag for Stop hook enforcement.

## Input (stdin JSON)

`{ session_id, transcript_path, trigger: "manual"|"auto", cwd }`

## Output

Exit code 0. PreCompact hooks cannot inject context or block — they can only do side effects.

## What It Does

1. **Parses transcript** (`parseTranscript()`): Reads JSONL transcript file line-by-line:
   - Extracts up to 15 user messages (truncated at 300 chars)
   - Extracts up to 5 assistant text snippets (truncated at 200 chars)
   - Tracks tools used (Set)
   - Identifies files modified (from Edit/Write/NotebookEdit tool calls)
   - Identifies files read
   - Detects git/npm commands from Bash calls
   - Returns: `{ userMessages, assistantSnippets, toolsUsed[], filesModified[], filesRead[], totalTurns }`

2. **Writes precompact cache** (`data/precompact/{sessionId}.json`):
   ```json
   {
     "session_id", "transcript_path", "trigger", "cwd", "cached_at",
     "user_message_count", "total_turns",
     "user_messages": [...],
     "assistant_snippets": [...],
     "tools_used": [...],
     "files_modified": [...],
     "files_read": [...]
   }
   ```
   This cache is read (and deleted) by `session-start.mjs` when it detects `source === 'compact'`.

3. **Writes pending-compact flag** (`data/pending-compact/{sessionId}.json`):
   Used by Stop hook to enforce that the compacted session gets indexed before Claude can finish.

4. **Cleans old cache** (`cleanupOldCache()`): Removes precompact cache files older than 2 hours.

## Compaction Flow

```
Claude runs out of context → PreCompact fires → parses transcript → caches data
→ Claude restarts with compacted context → SessionStart fires (source='compact')
→ SessionStart reads precompact cache → injects indexing instructions
→ Claude indexes the session → post-remember clears pending-compact flag
→ Stop hook allows Claude to stop
```
