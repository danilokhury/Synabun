---
category: hooks
tags: [hooks, post-remember, edit-tracking, remember-enforcement, category-injection]
importance: 8
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/post-remember.mjs
  - hooks/claude-code/shared.mjs
---

# SynaBun PostRemember Hook — Edit Tracking & Remember Clearing

**File:** `hooks/claude-code/post-remember.mjs` (196 lines)
**Event:** PostToolUse | **Matcher:** `^Edit$|^Write$|^NotebookEdit$|mcp__SynaBun__remember`

Fires after every file edit and every `remember` call. Two responsibilities: count edits toward remember threshold, and clear flags when `remember` is called.

## Input (stdin JSON)

`{ session_id, tool_name, tool_input: { file_path?, notebook_path?, category? }, cwd }`

## Edit Tracking (Edit/Write/NotebookEdit)

- Increments `editCount` and `totalEdits` in `data/pending-remember/{sessionId}.json`
- Tracks edited file paths in `flag.files[]`
- At every multiple of EDIT_THRESHOLD (3):
  - Emits nudge text with escalating urgency:
    - 3 edits: reminder
    - 6 edits: urgent
    - 9+ edits: "MUST call remember"
  - First threshold hit: appends full category reference via `buildCategoryReference()` from `shared.mjs` (lazy injection). Sets `flag.categoryTreeInjected = true` to avoid re-injecting.

## Remember Flag Clearing (remember tool)

### category === 'conversations'
Special handling for compaction indexing:
- Clears ALL files in `data/pending-compact/`
- Resets `messageCount` and `retries` in pending-remember flag
- Increments `rememberCount`

### Any other category
Standard reset:
- Resets: `editCount`, `messageCount`, `retries`, `files[]`, timestamps
- Preserves: `totalEdits`, `rememberCount`, `totalSessionMessages`, `greetingDelivered`

## Output

- At threshold multiples: `{ additionalContext: "SynaBun: You've made N edits..." }`
- Otherwise: `{}`

## State File

`data/pending-remember/{sessionId}.json` — shared with Stop hook and prompt-submit hook.
