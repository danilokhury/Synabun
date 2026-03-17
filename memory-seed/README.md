# SynaBun Memory Seeds

Pre-built memory entries that document every aspect of the SynaBun system. Use these to bootstrap your AI assistant's knowledge about SynaBun for assisted development.

## What Are These?

Each `.md` file contains a single memory entry with:
- **YAML frontmatter** — metadata (category, tags, importance, project, related files)
- **Markdown body** — the memory content itself

These 47 files cover the full SynaBun system: architecture, ~50 MCP tools, Neural Interface API (160+ endpoints), 8 lifecycle hooks, skills, session indexing, browser automation, and development practices.

## How to Use

### Option 1: Feed to Your AI Agent (Recommended)

Point your AI assistant at this folder and ask it to remember each file:

```
Read all files in memory-seed/ and use the `remember` tool to store each one.
Use the YAML frontmatter for category, tags, importance, and project fields.
Use the markdown body as the memory content.
```

Your AI will need SynaBun's MCP server running to use the `remember` tool.

### Option 2: Manual Review

Browse the files by topic:

| Folder | Count | Topics |
|--------|-------|--------|
| `architecture/` | 5 | System overview, config, SQLite storage, categories, database architecture |
| `mcp-tools/` | 13 | Memory tools, browser automation, whiteboard, cards, loop, restore, tictactoe, sync |
| `neural-interface/` | 5 | Express API, memory endpoints, graph edges, 3D visualization, sync UI |
| `hooks/` | 10 | SessionStart, PromptSubmit, Stop, PreCompact, PostRemember, PostPlan, PreWebSearch, shared utilities, installation, `/idea` skill |
| `setup/` | 3 | Quick start, database setup, local embeddings |
| `development/` | 4 | File structure, code style, security, type system |
| `systems/` | 7 | Session indexing, greeting system, skills, backup/restore, trash, terminal, FTS5 |

### Prerequisites

Before feeding these to your AI:

1. SynaBun must be installed and running (`npm start`)
2. The MCP server must be registered with your AI tool (`.mcp.json`)
3. Create the parent category first:
   ```
   Use category_create to make a parent category called "synabun"
   with description "Knowledge about the SynaBun memory system itself"
   ```
4. Create child categories (or let the AI create them as it processes each file)

## File Format

```markdown
---
category: architecture
tags: [system, components, overview]
importance: 10
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - mcp-server/src/index.ts
  - neural-interface/server.js
---

# Memory Title

Memory content goes here...
```

## Category Structure

```
synabun (parent) — Knowledge about the SynaBun memory system itself
  ├── arch-v2            — System architecture, components, data flow, config, SQLite storage
  ├── mcp-tools          — The ~50 MCP tools, parameters, behavior, quirks, scoring algorithm
  ├── neural-interface   — 3D visualization UI, Express REST API (160+ endpoints), graph edges
  ├── hooks              — Claude Code lifecycle hooks (8 files), installation, customization
  ├── setup              — Installation, onboarding wizard, database, local embeddings
  ├── development        — Code style, project structure, security, type system, Vitest tests
  ├── synabun-bugs       — Bug fixes, debugging sessions, and resolved issues
  ├── automations        — Automated workflows, scripts, and scheduled tasks
  ├── synabun-project    — General project knowledge, decisions, and milestones
  ├── synabun-architecture — System design, tech stack, data flow, component architecture
  └── synabun-config     — Configuration, deployment, environment, and infrastructure

learning (parent) — User preferences and behavioral patterns
  ├── communication-style — Tone, formality, verbosity, language patterns
  └── personality         — User personality traits and preferences

plans (parent) — Implementation plans stored after plan mode approval
  ├── plans-criticalpixel — Plans for CriticalPixel project
  └── plans-{project}     — Plans for other projects (auto-created)

conversations — Session summaries and conversation indexing

social (parent) — Social media interactions and community engagement
  ├── social-interactions — Social media posts and engagement
  └── facebook-groups     — Facebook group management

{project} (parent) — Per-project parent categories (auto-created)
  ├── {project}-project       — General project knowledge
  ├── {project}-architecture  — System design and tech stack
  ├── {project}-bugs          — Bug fixes and debugging
  └── {project}-config        — Configuration and infrastructure
```

Note: Per-project categories are auto-created by the `ensureProjectCategories()` function in `hooks/claude-code/shared.mjs` when a project is registered. The category tree grows organically as projects are added.
