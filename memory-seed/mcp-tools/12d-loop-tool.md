---
category: mcp-tools
tags: [loop, mcp-tool, automation, iterations, autonomous, task-runner]
importance: 9
project: synabun
source: self-discovered
related_files:
  - mcp-server/src/tools/loop.ts
  - hooks/claude-code/stop.mjs
  - hooks/claude-code/prompt-submit.mjs
---

# SynaBun Loop Tool — Autonomous Task Iteration

The loop tool enables Claude to run autonomous multi-iteration task loops. The MCP tool creates the state file; the Stop hook drives the actual iterations.

## Schema

- **action** (required): `"start"` | `"stop"` | `"status"`
- **task** (optional, required for start): Task description for each iteration
- **iterations** (optional, 1-50, default 10): Total iterations to run
- **max_minutes** (optional, 1-60, default 30): Maximum runtime
- **context** (optional): Additional context injected each iteration
- **session_id** (optional): Auto-detected from `CLAUDE_SESSION_ID` env or loop dir scan
- **template** (optional): Name or ID from `data/loop-templates.json`

## Actions

### start
Creates `data/loop/{sessionId}.json` with state:
```json
{
  "active": true,
  "task": "...",
  "totalIterations": 10,
  "currentIteration": 0,
  "maxMinutes": 30,
  "startedAt": "ISO timestamp",
  "context": "...",
  "retries": 0,
  "usesBrowser": false
}
```
Errors if a loop is already active for this session.

### stop
Deletes loop file. Reports iterations completed and elapsed time.

### status
Reports current iteration number, task, elapsed time, remaining time.

## How Iteration Works

The loop MCP tool only creates the state file. The **Stop hook** (`stop.mjs`) drives iterations:

1. Claude finishes responding → Stop hook fires
2. Stop hook reads `data/loop/{sessionId}.json`
3. If `active` and iterations remaining and time remaining:
   - Increments `currentIteration`
   - Returns `{ decision: "block", reason: "Next iteration prompt..." }`
   - Claude is forced to continue with next iteration
4. If done: deactivates loop, allows Claude to stop

## Browser Integration

If the loop task involves browser automation (`usesBrowser: true`):
- `pre-websearch.mjs` blocks WebSearch/WebFetch during the loop
- Stop hook checks for human-action blockers (login walls, CAPTCHA, 2FA)
- On blocker detection: PAUSES loop instead of advancing (lets user intervene)

## Templates

`data/loop-templates.json` stores reusable task templates. When `template` param is provided, template values are loaded and explicit params override them.

## Session ID Resolution (priority order)

1. Explicit `session_id` parameter
2. `CLAUDE_SESSION_ID` environment variable
3. Scan `data/loop/` directory for first active file
