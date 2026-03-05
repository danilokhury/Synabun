---
category: hooks
tags: [greeting, per-project, templates, session-start, prompt-submit]
importance: 7
project: synabun
source: self-discovered
related_files:
  - hooks/claude-code/session-start.mjs
  - hooks/claude-code/prompt-submit.mjs
  - data/greeting-config.json
  - neural-interface/server.js
---

# SynaBun Greeting System

Per-project configurable greeting that Claude delivers at the start of each session.

## Configuration

`data/greeting-config.json` format:
```json
{
  "defaults": {
    "enabled": true,
    "template": "{time_greeting}, ready to work on **{project_label}** ({branch})."
  },
  "projects": {
    "criticalpixel": {
      "template": "Custom greeting for CriticalPixel on {branch}.",
      "reminders": [
        { "label": "Dev server", "command": "npm run dev" }
      ]
    }
  }
}
```

## Template Variables

| Variable | Value |
|----------|-------|
| `{time_greeting}` | "Good morning" / "Good afternoon" / "Good evening" (based on hour) |
| `{project_name}` | Project identifier (e.g., "criticalpixel") |
| `{project_label}` | Display label (e.g., "CriticalPixel") |
| `{branch}` | Current git branch (via `git rev-parse --abbrev-ref HEAD`) |
| `{date}` | Current date |

## How It Works

### SessionStart Hook
- Loads greeting config, merges project-specific overrides with defaults
- Resolves template variables
- Injects greeting directive: "Output this greeting: ..."
- Also formats `reminders` list as clickable command references

### PromptSubmit Hook — Greeting Reinforcement
- On `messageCount === 1` (first user message): outputs "Output the greeting from GREETING DIRECTIVE NOW"
- On messages 2+: appends stale-greeting cancellation notice

### Neural Interface API
- `GET /api/greeting/config` — read greeting configuration
- `PUT /api/greeting/config` — update greeting configuration

## Design Decision

The greeting is a DIRECTIVE, not direct output. SessionStart injects "you must say this greeting", and PromptSubmit reinforces it on the first message. This two-step approach ensures the greeting appears naturally as Claude's first response, not as a system message.
