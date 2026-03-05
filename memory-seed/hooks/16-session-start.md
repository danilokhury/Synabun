---
category: hooks
tags: [hooks, session-start, context-injection, greeting, compaction, loop, categories]
importance: 9
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - hooks/claude-code/session-start.mjs
  - hooks/claude-code/shared.mjs
  - data/greeting-config.json
---

# SynaBun SessionStart Hook — Context Injection at Session Start

**File:** `hooks/claude-code/session-start.mjs` (385 lines)
**Event:** SessionStart | **Timeout:** 5 seconds

Fires once at the beginning of every Claude Code session. Has three distinct modes: fresh session, compaction resume, and loop session.

## Input (stdin JSON)

`{ cwd, source, session_id, transcript_path }`

- `source`: `"vscode"` | `"cli"` | `"compact"` (compact = post-compaction restart)

## Mode 1: Fresh Session (source !== 'compact', no active loop)

Injects comprehensive context:

1. **Greeting Directive**: Loads `data/greeting-config.json`, resolves template with variables (`{time_greeting}`, `{project_name}`, `{project_label}`, `{branch}`, `{date}`). Greeting is per-project configurable.
2. **Category Tree**: Calls `ensureProjectCategories()` from `shared.mjs` (idempotent), builds hierarchical display.
3. **Category Decision Tree**: 4-step algorithm for memory categorization.
4. **Project Detection**: Auto-detects project from cwd using registered projects in `data/claude-code-projects.json`.
5. **Session Boot Sequence**: Tells Claude to call `recall` ONCE about the current project, then greet, then proceed.
6. **Mandatory Actions**: Auto-remember thresholds (bugs 7+, decisions 8+, quirks 6+, user requests 8+).
7. **Tool Usage Notes**: Sequential MCP calls only, reflect requires full UUID, importance scale.

## Mode 2: Compaction Resume (source === 'compact')

- Skips greeting entirely
- Reads `data/precompact/{sessionId}.json` (cached by pre-compact hook) and DELETES it
- Injects compaction indexing instructions with transcript data summary (user messages, tools used, files modified)
- Explicitly cancels stale greeting/boot-sequence context from pre-compaction messages

## Mode 3: Loop Session (active loop files in data/loop/)

- Checks `data/loop/` for pending files less than 10 minutes old
- If found: injects minimal context, suppresses greeting and recall
- Tells Claude "This is an autonomous loop session — wait for loop task from UserPromptSubmit hook"

## Helper Functions

- `loadGreetingConfig()` — reads `data/greeting-config.json`
- `getProjectGreetingConfig(config, project)` — merges defaults with project overrides
- `getTimeGreeting()` — "Good morning/afternoon/evening" based on hour
- `getGitBranch(cwd)` — runs `git rev-parse` with 2s timeout
- `resolveTemplate(template, vars)` — `{key}` placeholder replacement
- `readPrecompactCache(sessionId)` — reads and deletes precompact cache file

## Error Handling

`.catch()` fallback outputs minimal context: *"SynaBun memory is available but the session hook encountered an error."*

## Output

`{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }`
