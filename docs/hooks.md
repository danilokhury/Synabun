# SynaBun - Claude Code Hooks

SynaBun ships with two [Claude Code hooks](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/hooks) that automate memory usage during coding sessions. Hooks are shell commands that Claude Code runs at specific lifecycle events, injecting context into the AI conversation.

## Table of Contents

- [Overview](#overview)
- [Built-in Hooks](#built-in-hooks)
- [Installation](#installation)
- [How Hooks Work](#how-hooks-work)
- [Writing Custom Hooks](#writing-custom-hooks)
- [Customizing Project Detection](#customizing-project-detection)
- [Customizing Recall Triggers](#customizing-recall-triggers)

---

## Overview

SynaBun provides two hooks that work as a pair:

| Hook | Event | Timeout | Purpose |
|------|-------|---------|---------|
| `session-start.mjs` | `SessionStart` | 5s | Injects category tree, project detection, and behavioral rules at the beginning of every session |
| `prompt-submit.mjs` | `UserPromptSubmit` | 3s | Nudges the AI to call `recall` before responding when the user's message matches recall-worthy patterns |

Together, these hooks ensure the AI:
1. Knows what categories exist and how to route memories to them
2. Automatically checks past knowledge before making decisions
3. Follows consistent memory storage rules (importance scale, sequential calls, etc.)

---

## Built-in Hooks

### SessionStart Hook

**File:** `hooks/claude-code/session-start.mjs`

Fires once at the start of every Claude Code session. Reads the category tree from `mcp-server/data/custom-categories.json` and injects comprehensive context.

**What it injects:**

1. **Category tree** — Full hierarchy of parent and child categories with descriptions
2. **Category decision tree** — Step-by-step algorithm for choosing where to store memories:
   - Step 1: Match to existing child category
   - Step 2: If no child fits, check parent descriptions and create a new child
   - Step 3: If no parent fits, create a new parent + child
   - Step 4: If uncertain, ask the user
3. **Project detection** — Auto-detects the current project from the working directory
4. **Project scoping rules** — When to use project-specific vs. global vs. shared
5. **Mandatory actions** — Auto-recall on session start, auto-remember for significant work
6. **Tool usage notes** — Sequential calls, full UUID requirement, importance scale

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

Fires on every user message. Analyzes the prompt text against a set of regex patterns and, if recall-worthy signals are detected, injects a brief nudge telling the AI to check memory before responding.

**Recall trigger categories:**

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
1. Claude Code fires a lifecycle event (SessionStart or UserPromptSubmit)
2. Claude Code spawns the hook script as a child process
3. Event data is piped to the script via stdin as JSON
4. The script processes the input and writes JSON to stdout
5. Claude Code reads the output within the timeout window
6. If the output contains hookSpecificOutput.additionalContext,
   that text is injected into the AI's system context
7. If the script times out or crashes, the output is silently ignored
```

### Input Contract

The hook receives JSON on **stdin** with event-specific fields:

| Event | stdin fields |
|-------|-------------|
| `SessionStart` | `{ cwd: string, source: string }` |
| `UserPromptSubmit` | `{ prompt: string }` |

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
