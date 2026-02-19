# SynaBun Memory Seeds

Pre-built memory entries that document every aspect of the SynaBun system. Use these to bootstrap your AI assistant's knowledge about SynaBun for assisted development.

## What Are These?

Each `.md` file contains a single memory entry with:
- **YAML frontmatter** — metadata (category, tags, importance, project, related files)
- **Markdown body** — the memory content itself

These 28 files cover the full SynaBun system: architecture, MCP tools, Neural Interface API, hooks, skills, setup, and development practices.

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
| `architecture/` | 5 | System overview, config, Qdrant, categories, multi-connection |
| `mcp-tools/` | 7 | remember, recall, forget, reflect, memories, sync, category CRUD |
| `neural-interface/` | 5 | Express API, memory endpoints, graph edges, 3D visualization, sync UI |
| `hooks/` | 4 | SessionStart, PromptSubmit, installation & customization, `/idea` skill |
| `setup/` | 3 | Quick start, Docker, embedding providers |
| `development/` | 4 | File structure, code style, security, type system |

### Prerequisites

Before feeding these to your AI:

1. SynaBun must be installed and running (`npm start`)
2. The MCP server must be registered with your AI tool (`.mcp.json`)
3. Create the parent category first:
   ```
   Use category_create to make a parent category called "synabun"
   with description "Knowledge about the SynaBun memory system itself"
   ```
4. Create the 6 child categories (architecture, mcp-tools, neural-interface, hooks, setup, development) — or let the AI create them as it processes each file

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
synabun (parent)
  ├── architecture    — System architecture, components, data flow, config
  ├── mcp-tools       — The 10 MCP tools, parameters, scoring algorithm
  ├── neural-interface — 3D visualization UI, Express REST API, graph edges
  ├── hooks           — Claude Code lifecycle hooks, installation
  ├── setup           — Installation, Docker, embedding providers
  └── development     — Code style, project structure, security, types
```
