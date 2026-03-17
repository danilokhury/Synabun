---
category: hooks
tags: [hooks, stop, enforcement, loop-driver, remember-enforcement, compaction]
importance: 9
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/stop.mjs
  - hooks/claude-code/shared.mjs
---

# SynaBun Stop Hook — Enforcement & Loop Driver

**File:** `hooks/claude-code/stop.mjs` (372 lines)
**Event:** Stop | **Timeout:** 10 seconds

Fires when Claude finishes responding. Enforces memory hygiene and drives autonomous loops. Can block Claude from stopping (forcing it to continue).

## Input (stdin JSON)

`{ session_id, last_assistant_message, ... }`

## Output

- `{ "decision": "block", "reason": "..." }` — forces Claude to continue responding
- `{}` — allows Claude to stop normally

## Check Sequence (priority order)

### Check 1: Compaction Indexing

Scans ALL files in `data/pending-compact/`. If a pending compaction flag exists:
- Blocks with "Session compacted but not indexed yet"
- Max 3 retries before giving up (clears flag)

### Check 1.5: Active Loop

Reads `data/loop/{sessionId}.json`. If `loop.active`:

1. **Done check**: If `iterationsDone >= totalIterations` OR `elapsed >= maxMs` → deactivates loop, falls through to next checks
2. **Human blocker check**: If `usesBrowser && isHumanBlocker(lastMessage)` → PAUSES loop (returns `{}`, loop stays active for user to resolve manually). Detects: login walls, CAPTCHA, 2FA prompts, "wait" signals.
3. **Next iteration**: Increments `currentIteration`, blocks with next-iteration prompt including task, context, time remaining

### Check 2: Task Remember Enforcement

Reads `data/pending-remember/{sessionId}.json`:
- If `editCount >= EDIT_THRESHOLD` (3) and retries < 3: blocks with "You've made significant edits — call remember before stopping"
- If `editCount === 0` or below threshold: soft cleanup and allow

### Check 3: Conversation Remember Enforcement

Same flag file:
- If `messageCount >= MESSAGE_THRESHOLD` (5) AND `rememberCount === 0` AND `editCount < 3`: blocks with "Quick memory requested — remember something from this conversation"
- Max 3 retries

## Constants

- `MAX_RETRIES`: 3 (per check)
- `EDIT_THRESHOLD`: 3 (minimum edits before task-remember fires)
- `MESSAGE_THRESHOLD`: 5 (minimum messages before conversation-remember fires)

## Helper Functions

- `softCleanupFlag(flagPath)` — resets edit/retry fields, preserves session tracking (messageCount, greetingDelivered, etc.)
- `isHumanBlocker(msg)` — detects login/CAPTCHA/2FA phrases + wait signals
- `checkFlag(flagPath, buildReason)` — increments retries, returns block decision or null
