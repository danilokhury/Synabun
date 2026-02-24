---
category: neural-interface
tags: [neural-interface, express, 3d-visualization, three-js, api, onboarding]
importance: 8
project: synabun
source: self-discovered
subcategory: architecture
related_files:
  - neural-interface/server.js
  - neural-interface/public/index.html
  - neural-interface/public/onboarding.html
---

# SynaBun Neural Interface Overview

The Neural Interface (`neural-interface/server.js`, 1557 lines) is an Express.js web server providing a 3D visualization UI and REST API for memory management.

## Server

- Port: `NEURAL_PORT` environment variable (default 3344)
- Serves static files from `neural-interface/public/`
- Root `/` redirects to `/onboarding.html` if `SETUP_COMPLETE !== 'true'` and no active connection exists
- `reloadConfig()` reads `.env` + `connections.json` on each relevant request for runtime config updates
- 30+ REST API endpoints across 7 groups: Memory (6), Categories (5), Connections (4), Settings (2), Sync (1), Setup (11), Hooks (4)

## 3D Visualization (public/index.html)

- Three.js + ForceGraph3D library for interactive 3D force-directed graph
- Memories rendered as nodes, relationships as edges (computed from cosine similarity, shared related files, same parent category, explicit links)
- Features: click to select, inline editing panel (content, tags, category), semantic search bar
- Category sidebar with color-coded filtering and hierarchy editing
- Graphics quality presets: Low, Medium, High, Ultra (affects particle count, bloom effects, label rendering)
- Memory Sync UI in Settings > Memory tab: check for stale memories, model selector (Haiku/Sonnet/Opus), copy sync prompt for Claude Code
- Resizable, draggable, pinnable panels with localStorage persistence for position/size/state

## Onboarding Wizard (public/onboarding.html)

- Guided 7-step setup flow for new users
- Steps: dependency check → provider selection → API key → Docker/Qdrant → collection → MCP registration → CLAUDE.md injection
- Communicates with setup API endpoints on the same server
