---
category: hooks
tags: [hooks, installation, settings-json, customization, mjs, configuration]
importance: 8
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/session-start.mjs
  - hooks/claude-code/prompt-submit.mjs
  - docs/hooks.md
---

# SynaBun Hook Installation & Customization Guide

## Installation Methods

### 1. Via Neural Interface (recommended)

Settings > Integrations > Enable "Claude Code Hooks" > Choose Global or per-project.

### 2. Manual

Add to `.claude/settings.json` (global: `~/.claude/settings.json`, per-project: `<project>/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/Synabun/hooks/claude-code/session-start.mjs\"",
        "timeout": 5
      }]
    }],
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/Synabun/hooks/claude-code/prompt-submit.mjs\"",
        "timeout": 3
      }]
    }]
  }
}
```

On Windows, use forward slashes in paths (e.g., `C:/Users/me/Synabun`).

## Hook Contract

- **Input**: JSON on stdin with event-specific fields
- **Output**: JSON on stdout with `{ hookSpecificOutput: { hookEventName, additionalContext } }` or `{}` for no-op
- Always handle TTY stdin gracefully (check `process.stdin.isTTY`, use timeout fallback)
- Always output valid JSON even on error (`.catch()` fallback pattern)
- Hooks are plain `.mjs` files (ES modules), no build step, no external dependencies (only Node.js builtins: `fs`, `path`, `url`)

## Customization

- **Project Detection**: Edit `PROJECT_MAP` in `session-start.mjs` (and keep in sync with `mcp-server/src/config.ts`)
- **Recall Triggers**: Add regex patterns to `RECALL_TRIGGERS` array in `prompt-submit.mjs`
- **Skip Patterns**: Add regex patterns to `SKIP_PATTERNS` array to suppress recall nudges
- **Sensitivity**: Change threshold from `matches.length >= 1` to `>= 2` for fewer nudges

## Writing Custom Hooks

See `docs/hooks.md` for a minimal template with `readStdin()`, `main()`, and `.catch()` fallback.
