---
category: hooks
tags: [hooks, prompt-submit, recall-triggers, nudge, patterns, regex]
importance: 8
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/prompt-submit.mjs
---

# SynaBun PromptSubmit Hook — Recall Nudge on User Messages

**File:** `hooks/claude-code/prompt-submit.mjs` (96 lines)
**Event:** UserPromptSubmit | **Timeout:** 3 seconds

Fires on every user message. Analyzes the prompt text against regex patterns and, if recall-worthy signals are detected, injects a brief nudge telling the AI to check memory before responding.

## Input (stdin JSON)

`{ prompt: "user's message text" }`

## Recall Trigger Patterns (10+ regex groups)

- **Architecture & decisions**: `/architect|design|refactor|restructur|migrat|upgrad/i`
- **Decision-making**: `/should (we|i)|how (do|did|does)|what('s| is) the (best|right|correct)/i`
- **Patterns & conventions**: `/decision|approach|strategy|pattern|convention/i`
- **Debugging**: `/bug|error|broken|crash|fail|issue|problem|not working|doesn't work/i`
- **Fix actions**: `/debug|fix|troubleshoot|investigate/i`
- **Past work context**: `/last time|before|previously|earlier|remember when|we (did|had|tried|used)/i`
- **History queries**: `/why (did|do) we|what happened|history|context/i`
- **Consistency**: `/similar to|like (the|we)|same (as|way)|consistent with/i`
- **Existing patterns**: `/existing|current|already|convention|standard/i`
- **New features**: `/add|implement|create|build|new feature|integrate/i`
- **Technical domains**: `/auth|database|cache|redis|supabase|deploy|api|endpoint/i`
- **Config/secrets**: `/config|env|secret|key|token|credential/i`

## Skip Patterns (no nudge for trivial messages)

- `/^(yes|no|ok|sure|thanks|ty|perfect|great|good|nice|cool|got it)/i`
- `/^(do it|go ahead|proceed|continue|keep going|next)/i`
- `/^\s*$/` (empty messages)

## Threshold

`matches.length >= 1` (any single trigger fires the nudge). Adjustable by changing the `>= 1` check.

## Nudge Text

*"Before responding, consider calling recall to check your persistent memory for relevant context about this topic. Look for: past decisions, known bugs, architecture patterns, or prior work related to the user's request. Skip recall only if you're 100% certain this is a continuation of work you already have full context for."*
