---
category: hooks
tags: [hooks, installation, settings-json, customization, lifecycle, configuration]
importance: 8
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/session-start.mjs
  - hooks/claude-code/prompt-submit.mjs
  - hooks/claude-code/stop.mjs
  - hooks/claude-code/pre-compact.mjs
  - hooks/claude-code/post-remember.mjs
  - hooks/claude-code/post-plan.mjs
  - hooks/claude-code/pre-websearch.mjs
  - hooks/claude-code/shared.mjs
---

# SynaBun Hook Installation & Customization Guide

## All Hooks (8 files)

| File | Event | Lines | Purpose |
|------|-------|-------|---------|
| `session-start.mjs` | SessionStart | 385 | Greeting, context injection, compaction resume, loop detection |
| `prompt-submit.mjs` | UserPromptSubmit | 512 | Tiered recall nudging, loop task injection, greeting reinforcement, user learning |
| `stop.mjs` | Stop | 372 | Compaction enforcement, loop iteration driving, task-remember enforcement |
| `pre-compact.mjs` | PreCompact | 217 | Transcript parsing, precompact cache, pending-compact flag |
| `post-remember.mjs` | PostToolUse (Edit/Write/NotebookEdit/remember) | 196 | Edit counting, remember flag clearing, category reference injection |
| `post-plan.mjs` | PostToolUse (ExitPlanMode) | 298 | Auto-stores approved plans into SQLite with local embedding |
| `pre-websearch.mjs` | PreToolUse (WebSearch/WebFetch) | 90 | Blocks web search when SynaBun browser session is active |
| `shared.mjs` | (utility module) | 305 | Shared functions: stdin, project detection, category loading, ensureProjectCategories |

## Installation Methods

### 1. Via Neural Interface (recommended)

Settings > Integrations > Enable "Claude Code Hooks" > Choose Global or per-project. Auto-registers all hooks.

### 2. Manual

Add to `.claude/settings.json` (global: `~/.claude/settings.json`, per-project: `<project>/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/Synabun/hooks/claude-code/session-start.mjs\"", "timeout": 5 }]
    }],
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/Synabun/hooks/claude-code/prompt-submit.mjs\"", "timeout": 3 }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/Synabun/hooks/claude-code/stop.mjs\"", "timeout": 10 }]
    }],
    "PreCompact": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/Synabun/hooks/claude-code/pre-compact.mjs\"", "timeout": 10 }]
    }],
    "PostToolUse": [
      {
        "matcher": "^Edit$|^Write$|^NotebookEdit$|mcp__SynaBun__remember",
        "hooks": [{ "type": "command", "command": "node \"/path/to/Synabun/hooks/claude-code/post-remember.mjs\"", "timeout": 5 }]
      },
      {
        "matcher": "^ExitPlanMode$",
        "hooks": [{ "type": "command", "command": "node \"/path/to/Synabun/hooks/claude-code/post-plan.mjs\"", "timeout": 15 }]
      }
    ],
    "PreToolUse": [{
      "matcher": "^WebSearch$|^WebFetch$",
      "hooks": [{ "type": "command", "command": "node \"/path/to/Synabun/hooks/claude-code/pre-websearch.mjs\"", "timeout": 3 }]
    }]
  }
}
```

On Windows, use forward slashes in paths (e.g., `D:/Apps/Synabun`).

## Hook Contract

- **Input**: JSON on stdin with event-specific fields
- **Output**: JSON on stdout:
  - Context injection: `{ hookSpecificOutput: { hookEventName, additionalContext } }`
  - Block decision: `{ decision: "block", reason: "..." }`
  - No-op: `{}`
- Always handle TTY stdin gracefully (check `process.stdin.isTTY`, use timeout fallback)
- Always output valid JSON even on error (`.catch()` fallback pattern)
- Hooks are plain `.mjs` files (ES modules), no build step
- `shared.mjs` provides common utilities (imported by other hooks, never run directly)

## Customization Points

- **Recall triggers**: Regex arrays in `prompt-submit.mjs` (Tier 1/2/3 patterns)
- **Edit threshold**: `EDIT_THRESHOLD` constant in `stop.mjs` and `post-remember.mjs` (default: 3)
- **Message threshold**: `MESSAGE_THRESHOLD` in `stop.mjs` (default: 5)
- **User learning threshold**: `userLearningThreshold` in `prompt-submit.mjs` (default: 8 messages)
- **Greeting templates**: `data/greeting-config.json` — per-project, with template variables
- **Hook features**: `data/hook-features.json` — toggle individual features on/off
