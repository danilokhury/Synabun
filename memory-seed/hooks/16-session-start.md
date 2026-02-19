---
category: hooks
tags: [hooks, session-start, context-injection, categories, project-detection, mandatory-actions]
importance: 9
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - hooks/claude-code/session-start.mjs
  - mcp-server/data/custom-categories.json
---

# SynaBun SessionStart Hook — Context Injection at Session Start

**File:** `hooks/claude-code/session-start.mjs` (209 lines)
**Event:** SessionStart | **Timeout:** 5 seconds

Fires once at the beginning of every Claude Code session. Reads the category tree and injects comprehensive context into the AI's system prompt via `additionalContext`.

## Input (stdin JSON)

`{ cwd: "/path/to/project", source: "vscode" | "cli" }`

## What It Injects

1. **Category Tree**: Reads `mcp-server/data/custom-categories.json`, builds hierarchical display showing parent categories with their children and descriptions.
2. **Category Decision Tree (4 steps)**: Step-by-step algorithm for choosing where to store memories — match existing child → check parent and create child → create new parent+child → ask the user if uncertain.
3. **Project Detection**: Auto-detects current project from cwd using `PROJECT_MAP` (must mirror `mcp-server/src/config.ts`).
4. **Project Scoping Rules**: When to use project-specific vs `"global"` vs `"shared"` project values.
5. **Mandatory Actions**: Auto-recall on session start about current project status, auto-remember for significant work (bugs 7+, decisions 8+, quirks 6+, user requests 8+).
6. **Tool Usage Notes**: Sequential MCP calls only, reflect requires full UUID, importance scale reference.

## PROJECT_MAP

Maps directory keywords to project identifiers. Detection algorithm: lowercase cwd, check `PROJECT_MAP` keys, fall back to directory basename (sanitized), default `"global"`.

## Error Handling

`.catch()` fallback outputs minimal context: *"SynaBun memory is available but the session hook encountered an error loading categories. Use recall and remember tools manually."*

## Output

`{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "## SynaBun Persistent Memory — Active\n\n..." } }`
