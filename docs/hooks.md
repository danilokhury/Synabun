# SynaBun - Claude Code Hooks

SynaBun ships with 5 [Claude Code hooks](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/hooks) that automate memory usage across the entire coding session lifecycle. Hooks are shell commands that Claude Code runs at specific lifecycle events, injecting context into the AI conversation or enforcing memory discipline.

## Table of Contents

- [Overview](#overview)
- [Built-in Hooks](#built-in-hooks)
  - [SessionStart Hook](#sessionstart-hook)
  - [PromptSubmit Hook](#promptsubmit-hook)
  - [PreCompact Hook](#precompact-hook)
  - [Stop Hook](#stop-hook)
  - [PostToolUse Hook](#posttooluse-hook)
- [Hook Feature Flags](#hook-feature-flags)
- [Installation](#installation)
- [How Hooks Work](#how-hooks-work)
- [Writing Custom Hooks](#writing-custom-hooks)
- [Customizing Project Detection](#customizing-project-detection)
- [Customizing Recall Triggers](#customizing-recall-triggers)

---

## Overview

SynaBun provides 5 hooks that work together to create a complete memory automation pipeline:

| Hook | Event | Timeout | Purpose |
|------|-------|---------|---------|
| `session-start.mjs` | `SessionStart` | 5s | Injects category tree, project detection, 5 binding directives, and compaction recovery |
| `prompt-submit.mjs` | `UserPromptSubmit` | 3s | Multi-tier recall trigger system with non-English detection and user learning nudges |
| `pre-compact.mjs` | `PreCompact` | 10s | Captures session transcript before context compaction |
| `stop.mjs` | `Stop` | 3s | Enforces memory storage — blocks if session isn't indexed or edits aren't remembered |
| `post-remember.mjs` | `PostToolUse` | 3s | Tracks edit count and clears enforcement flags when memories are stored |

Together, these hooks ensure the AI:
1. Knows what categories exist and how to route memories to them
2. Automatically checks past knowledge before making decisions
3. Follows consistent memory storage rules (importance scale, sequential calls, etc.)
4. Indexes every session that undergoes context compaction
5. Stores memories after significant code edits (enforced, not optional)

---

## Built-in Hooks

### SessionStart Hook

**File:** `hooks/claude-code/session-start.mjs`

Fires once at the start of every Claude Code session. Reads the category tree from `mcp-server/data/custom-categories-{connId}.json` and injects comprehensive context.

**What it injects:**

1. **Category tree** — Full hierarchy of parent and child categories with descriptions and available names
2. **Category decision tree** — 4-step algorithm for choosing where to store memories:
   - Step 1: Match to existing child category by description
   - Step 2: If no child fits, `category_create` a new child under the matching parent
   - Step 3: If no parent fits, `category_create` a new parent + child
   - Step 4: If uncertain, `AskUserQuestion` with 2-3 options
3. **5 binding directives:**
   - **Directive 1: Session Start Recall** — two `recall` calls (conversations + ongoing work) before greeting, plus optional user-profile recall (Step D)
   - **Directive 2: Auto-Remember** — mandatory memory storage after every discrete task
   - **Directive 3: Recall Before Decisions** — check memory before architecture/design choices
   - **Directive 4: Compaction Auto-Store** — index the session when compaction is detected
   - **Directive 5: User Learning** — autonomously observes user communication patterns (tone, verbosity, preferences, text quirks) and stores observations in `user-profile/communication-style` category
4. **Project detection** — Auto-detects the current project from the working directory
5. **Project scoping rules** — When to use project-specific vs. global vs. shared
6. **Tool usage notes** — Sequential calls, full UUID requirement, importance scale, `forget`/`restore` behavior

**Compaction recovery:** If `source === "compact"`, the hook loads a pre-cached session from `data/precompact/` and injects an immediate compaction indexing directive instead of the standard greeting flow.

**Input (stdin):**
```json
{
  "cwd": "/path/to/current/project",
  "source": "vscode"
}
```

**Output (stdout):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "## SynaBun Persistent Memory — Active\n\n..."
  }
}
```

---

### PromptSubmit Hook

**File:** `hooks/claude-code/prompt-submit.mjs`

Fires on every user message. Implements a multi-tier priority system that analyzes the prompt text and injects recall nudges when appropriate.

**Priority tiers (evaluated in order):**

| Priority | Tier | Behavior |
|----------|------|----------|
| 0 | Pending-remember boundary | Checks if unremembered edits exist; nudges to store first |
| 1 | Conversation recall triggers | Detects phrases like "remember that conversation", "what did we work on" |
| 2 | Tier 1: Must-recall | Architecture, debugging, past work — always triggers |
| 3 | Tier 2: Should-recall | New features, technical domains — triggers on single match |
| 4 | Tier 3: Consider-recall | Generic patterns — requires 2+ matches to trigger |
| 5 | Non-English detection | Unicode ratio >40% triggers recall (international users) |
| 6 | Latin non-English | Catch-all for Latin-script non-English text |
| 7 | User learning nudge | Quiet-only, one-time nudge after N interactions; fires only when no higher priority matched. Controlled by `userLearning` and `userLearningThreshold` feature flags |

**Recall trigger categories (Tiers 1-3):**

| Category | Example patterns |
|----------|-----------------|
| Architecture & decisions | `architect`, `design`, `refactor`, `migrate`, `should we` |
| Debugging & bugs | `bug`, `error`, `crash`, `fix`, `debug`, `not working` |
| Past work context | `last time`, `previously`, `remember when`, `why did we` |
| Existing patterns | `similar to`, `same as`, `consistent with`, `convention` |
| New features | `add`, `implement`, `create`, `new feature`, `integrate` |
| Technical domains | `auth`, `database`, `cache`, `redis`, `deploy`, `api`, `config` |

**Skip patterns (no nudge):**
- Trivial responses: `yes`, `no`, `ok`, `sure`, `thanks`, `great`
- Continuation commands: `do it`, `go ahead`, `proceed`, `continue`
- Empty messages

**Input (stdin):**
```json
{
  "prompt": "How does the authentication flow work?"
}
```

**Output when triggered (stdout):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Before responding, consider calling `recall` to check your persistent memory..."
  }
}
```

**Output when skipped (stdout):**
```json
{}
```

---

### PreCompact Hook

**File:** `hooks/claude-code/pre-compact.mjs`

Fires before Claude Code compacts the conversation context. Captures the full session transcript so it can be indexed as a conversation memory after compaction.

**What it does:**

1. Reads the session transcript JSONL file
2. Extracts: user messages, assistant response snippets, tools used, files modified
3. Writes a cache file to `data/precompact/{sessionId}.json`
4. Sets a `data/pending-compact/{sessionId}.json` enforcement flag

The enforcement flag tells the `stop.mjs` hook to block Claude's next response until the session has been indexed in SynaBun's conversation memory.

**Input (stdin):**
```json
{
  "transcript": "path/to/session.jsonl"
}
```

**Output (stdout):**
```json
{}
```

> **Note:** This hook does not inject context. It only writes cache files for other hooks to consume.

---

### Stop Hook

**File:** `hooks/claude-code/stop.mjs`

Fires when Claude finishes generating a response. Checks enforcement flags and blocks the response if required memory operations haven't been completed.

**Enforcement checks:**

1. **Pending compact** — If `data/pending-compact/{sessionId}.json` exists, the session has been compacted but not yet indexed. Returns `{ decision: "block" }` with a message instructing Claude to index the session immediately. Max 3 retries before allowing through.

2. **Pending remember** — If `data/pending-remember/{sessionId}.json` exists and `editCount >= 3`, Claude has made significant edits without storing a memory. Returns `{ decision: "block" }` with a nudge to call `remember`. Max 3 retries.

**Input (stdin):**
```json
{
  "stop_reason": "end_turn"
}
```

**Output when blocking (stdout):**
```json
{
  "decision": "block",
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "You must index this session before continuing..."
  }
}
```

**Output when allowing (stdout):**
```json
{}
```

---

### PostToolUse Hook

**File:** `hooks/claude-code/post-remember.mjs`

Fires after specific tool calls. Matches on `Edit`, `Write`, `NotebookEdit`, and `SynaBun__remember` tool names.

**Two responsibilities:**

1. **Edit tracking** — When `Edit`, `Write`, or `NotebookEdit` is called, increments `editCount` in `data/pending-remember/{sessionId}.json`. At every 3rd unremembered edit, emits a nudge suggesting Claude call `remember`.

2. **Flag clearing** — When `remember` is called:
   - With `category: "conversations"` → deletes the `pending-compact` flag (session indexed successfully)
   - With any other category → resets `editCount` to 0 (work remembered), preserves session-level stats (`totalEdits`, `rememberCount`)

**Input (stdin):**
```json
{
  "tool_name": "Edit",
  "tool_input": { "file_path": "/path/to/file.ts", "old_string": "...", "new_string": "..." }
}
```

**Output when nudging (stdout):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "You've made 3 edits without storing a memory..."
  }
}
```

---

## Hook Feature Flags

Hook behavior can be toggled via `data/hook-features.json`:

```json
{
  "conversationMemory": true,
  "greeting": true,
  "userLearning": true,
  "userLearningThreshold": 8
}
```

| Flag | Default | Effect |
|------|---------|--------|
| `conversationMemory` | `true` | When `false`, disables conversation indexing (Directive 4) in SessionStart and Stop hooks |
| `greeting` | `true` | When `false`, disables the greeting directive at session start |
| `userLearning` | `true` | When `false`, disables Directive 5 (user observation) in SessionStart and Priority 7 nudge in PromptSubmit |
| `userLearningThreshold` | `8` | Number of interactions before the user learning nudge fires (configurable 3-30) |

Toggle boolean flags via the Neural Interface: Settings > Connections > Features, or via API:
```
PUT /api/claude-code/hook-features
{ "feature": "conversationMemory", "enabled": false }
```

Set numeric/config values:
```
PUT /api/claude-code/hook-features/config
{ "key": "userLearningThreshold", "value": 10 }
```

---

## Installation

### Via Neural Interface (recommended)

1. Open the Neural Interface at `http://localhost:3344`
2. Navigate to **Settings** > **Integrations**
3. Click **Enable** next to "Claude Code Hooks"
4. Choose the target: **Global** (all projects) or a specific project path

This writes the hook configuration to the appropriate `.claude/settings.json` file.

### Manual Installation

Add the following to your `.claude/settings.json` file:

**Global** (`~/.claude/settings.json`):
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/Synabun/hooks/claude-code/session-start.mjs\"",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/Synabun/hooks/claude-code/prompt-submit.mjs\"",
            "timeout": 3
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/Synabun/hooks/claude-code/pre-compact.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/Synabun/hooks/claude-code/stop.mjs\"",
            "timeout": 3
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^Edit$|^Write$|^NotebookEdit$|SynaBun__remember",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/Synabun/hooks/claude-code/post-remember.mjs\"",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

**Per-project** (`<project>/.claude/settings.json`): Same structure, but scoped to that project only.

Replace `/path/to/Synabun` with your actual SynaBun installation path. On Windows, use forward slashes (e.g., `J:/Sites/Apps/Synabun`).

---

## How Hooks Work

### Lifecycle

```
1. Claude Code fires a lifecycle event (SessionStart, UserPromptSubmit, PreCompact, Stop, or PostToolUse)
2. Claude Code spawns the hook script as a child process
3. Event data is piped to the script via stdin as JSON
4. The script processes the input and writes JSON to stdout
5. Claude Code reads the output within the timeout window
6. For most events: if output contains hookSpecificOutput.additionalContext,
   that text is injected into the AI's system context
7. For Stop events: if output contains { decision: "block" },
   Claude's response is blocked and it must retry
8. If the script times out or crashes, the output is silently ignored
```

### Input Contract

The hook receives JSON on **stdin** with event-specific fields:

| Event | stdin fields |
|-------|-------------|
| `SessionStart` | `{ cwd: string, source: string }` |
| `UserPromptSubmit` | `{ prompt: string }` |
| `PreCompact` | `{ transcript: string }` (path to JSONL) |
| `Stop` | `{ stop_reason: string }` |
| `PostToolUse` | `{ tool_name: string, tool_input: object }` |

**Important:** stdin may be a TTY (no data) in some environments. Always handle this gracefully:

```javascript
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('{}');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 2000);
  });
}
```

### Output Contract

The hook must write valid JSON to **stdout**. Two formats:

**With context injection:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Your context text here..."
  }
}
```

**Without context (no-op):**
```json
{}
```

### Error Handling

If the hook throws an error, Claude Code ignores the output. Both built-in hooks use a `.catch()` fallback pattern:

```javascript
main().catch(() => {
  // Output valid JSON even on error
  process.stdout.write(JSON.stringify({}));
});
```

---

## Writing Custom Hooks

### Minimal Hook Template

```javascript
#!/usr/bin/env node

/**
 * Custom SynaBun Hook
 * Event: SessionStart | UserPromptSubmit
 */

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('{}');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 2000);
  });
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  // Your logic here...
  const shouldInject = true;

  if (shouldInject) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart', // or 'UserPromptSubmit'
        additionalContext: 'Your injected context here.',
      },
    }));
  } else {
    process.stdout.write(JSON.stringify({}));
  }
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
```

### Guidelines

- **Keep it fast.** Hooks block the session start or prompt processing. Stay well under the timeout.
- **Always output valid JSON.** Even on error. Use the `.catch()` fallback pattern.
- **Handle missing stdin gracefully.** Check `process.stdin.isTTY` and use a timeout.
- **Use ES modules.** Both built-in hooks use `.mjs` extension and `import` syntax.
- **No dependencies required.** The built-in hooks use only Node.js built-in modules (`fs`, `path`, `url`).

---

## Customizing Project Detection

The SessionStart hook auto-detects the current project from the working directory using a `PROJECT_MAP` constant:

```javascript
// hooks/claude-code/session-start.mjs (line 33)
const PROJECT_MAP = {
  criticalpixel: 'criticalpixel',
  ellacred: 'ellacred',
};
```

The detection algorithm:
1. Convert `cwd` to lowercase, normalize path separators
2. Check if any `PROJECT_MAP` key appears in the path
3. If no match, use the directory basename (sanitized to lowercase kebab-case)
4. If basename is empty, fall back to `"global"`

**To add your projects:** Edit the `PROJECT_MAP` object with your project directory names and identifiers:

```javascript
const PROJECT_MAP = {
  'my-app': 'my-app',
  'backend-api': 'backend',
  'company-site': 'website',
};
```

The same map exists in `mcp-server/src/config.ts` for the MCP server's project detection. Keep them in sync.

---

## Customizing Recall Triggers

The PromptSubmit hook uses regex arrays to decide when to nudge the AI. Edit these in `hooks/claude-code/prompt-submit.mjs`:

### Adding Triggers

Add patterns to the `RECALL_TRIGGERS` array:

```javascript
const RECALL_TRIGGERS = [
  // ... existing patterns ...

  // Custom: your project-specific keywords
  /\b(graphql|prisma|trpc)/i,
  /\b(stripe|payment|billing)/i,
];
```

### Adding Skip Patterns

Add patterns to the `SKIP_PATTERNS` array to suppress the recall nudge:

```javascript
const SKIP_PATTERNS = [
  // ... existing patterns ...

  // Custom: skip for these messages too
  /^(show me|read|cat|open)/i,
  /^(commit|push|deploy)/i,
];
```

### Adjusting Sensitivity

The current threshold is `matches.length >= 1` (any single trigger fires the nudge). To require stronger signals:

```javascript
// Require 2+ triggers to fire
if (matches.length >= 2) {
  // inject context...
}
```
