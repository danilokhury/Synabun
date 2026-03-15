---
category: hooks
tags: [hooks, prompt-submit, recall-triggers, tiered, loop, greeting, learning]
importance: 8
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/prompt-submit.mjs
  - hooks/claude-code/shared.mjs
---

# SynaBun PromptSubmit Hook — Tiered Recall & Session Management

**File:** `hooks/claude-code/prompt-submit.mjs` (512 lines)
**Event:** UserPromptSubmit | **Timeout:** 3 seconds

Fires on every user message. Multi-responsibility hook: recall nudging, loop marker handling, greeting reinforcement, pending-remember alerts, and user learning nudges.

## Input (stdin JSON)

`{ prompt, session_id }`

## Processing Pipeline (priority order)

### Priority 0: Pending-Remember Alert

If `data/pending-remember/{sessionId}.json` has `editCount >= 1`, blocks with MANDATORY remember-first instruction before any recall.

### Priority 1: Loop Marker Detection

If prompt starts with `[SynaBun Loop]`:
- Renames `pending-{timestamp}.json` to `{sessionId}.json` in `data/loop/`
- Injects loop task context + browser enforcement rules
- Returns immediately (no further processing)

### Priority 2: Greeting Reinforcement (message 1 only)

On `messageCount === 1` (first user message), if `greeting` feature is enabled in `data/hook-features.json`:
- Outputs "Output the greeting from GREETING DIRECTIVE NOW"
- Returns immediately

### Priority 3: Tiered Recall Nudging

Messages 2+ go through tiered regex matching:

| Tier | Trigger Type | Threshold | Nudge Strength |
|------|-------------|-----------|----------------|
| Conversation | Memory/conversation recall keywords | 1 match | Conversation workflow |
| Tier 1 | Explicit past refs, decisions, memory refs | 1 match | "MUST recall" |
| Tier 2 | Debug, architecture, domains (supabase, redis, auth, cron) | 1 match | "SHOULD recall" |
| Tier 3 | New feature, similarity, broad tech | 2 matches | "CONSIDER recall" |
| Non-English | Non-Latin characters >40% | — | Translate + consider recall |
| Latin non-English | No English function words, >30 chars | — | Translate + consider recall |

### Priority 4: Boot Cancellation (messages 2+)

Appends stale-greeting cancellation notice to suppress re-greeting on subsequent messages.

### Priority 5: User Learning Nudge (independent)

Appended to any output, not gated by primary context:
- Fires at multiples of `userLearningThreshold` (default: 8 messages)
- Maximum 3 nudges per session
- First nudge: full instructions on the learning/communication-style system
- Subsequent nudges: short reminder
- Tracks `userLearningNudgeCount` in pending-remember flag file

## Skip Patterns

- Trivial confirmations: `yes/no/ok/sure/thanks`
- Continuation commands: `do it/go ahead/proceed/continue`
- Slash commands: `/command`
- Short messages: < 8 characters
- Direct file operations, run commands

## State File

`data/pending-remember/{sessionId}.json` tracks:
- `editCount`, `messageCount`, `totalSessionMessages`
- `greetingDelivered`, `userLearningNudgeCount`, `rememberCount`

## Output

`{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "..." } }` or `{}`
