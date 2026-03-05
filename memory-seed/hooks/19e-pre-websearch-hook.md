---
category: hooks
tags: [hooks, pre-websearch, browser-conflict, blocking, enforcement]
importance: 7
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/pre-websearch.mjs
---

# SynaBun PreWebSearch Hook — Browser Conflict Prevention

**File:** `hooks/claude-code/pre-websearch.mjs` (90 lines)
**Event:** PreToolUse | **Matcher:** `^WebSearch$|^WebFetch$`

Blocks WebSearch and WebFetch tools when a SynaBun browser session is active, preventing conflicts between the AI's built-in web tools and the managed Playwright browser.

## Input (stdin JSON)

`{ session_id, tool_name, ... }`

## Check Sequence

1. Fetches `http://localhost:3344/api/browser/sessions` (2s timeout)
2. **If Neural Interface unreachable**: allows all web tools (loop files on disk may be stale — NI reachability is the gate for all enforcement)
3. **If NI reachable**: checks `data/loop/` for active loop files with `usesBrowser: true` → block
4. Checks `activeBrowserSessions.length > 0` from NI response → block
5. Otherwise: allows

## Output

- Block: `{ decision: "block", reason: "BLOCKED: {toolName} is not allowed while a SynaBun browser session is open. Use the SynaBun browser tools instead..." }`
- Allow: `{}`

## Key Design Decision

If Neural Interface is offline, the hook NEVER blocks. This prevents stale loop state files from permanently blocking web search. The Neural Interface being reachable is the gating condition for all browser-conflict enforcement.
