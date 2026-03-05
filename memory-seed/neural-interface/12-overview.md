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

The Neural Interface (`neural-interface/server.js`, ~9000 lines) is an Express.js web server providing a 3D visualization UI and REST API for memory management, browser automation, terminal sessions, and system administration.

## Server

- Port: `NEURAL_PORT` environment variable (default 3344)
- Serves static files from `neural-interface/public/`
- Root `/` redirects to `/onboarding.html` if `SETUP_COMPLETE !== 'true'`
- 160+ REST API endpoints across 20+ groups
- WebSocket support for real-time terminal sessions (node-pty)
- Playwright-core integration for browser automation

## API Endpoint Groups

| Prefix | Description |
|--------|-------------|
| `/api/memories` | Memory CRUD, list, search, links, stats |
| `/api/memory/:id` | Single memory get/update/delete |
| `/api/search` | Semantic search with filters |
| `/api/categories` | Category CRUD, logos, export |
| `/api/trash` | Soft-deleted memory browsing, restore, purge |
| `/api/sync/check` | File checksum staleness detection |
| `/api/whiteboard` | Whiteboard element CRUD, clear, screenshot |
| `/api/cards` | Card open/close/update/screenshot |
| `/api/games/tictactoe` | TicTacToe game state management |
| `/api/browser/*` | Playwright browser control — sessions, navigate, click, fill, type, evaluate, screenshot, snapshot, content, detect-profiles |
| `/api/terminal/*` | PTY terminal sessions, profiles, files, branches, checkout, links |
| `/api/loop/*` | Loop templates CRUD, launch, stop, history, active status |
| `/api/settings` | Settings get/put, move-db, reindex |
| `/api/connections` | Connection management |
| `/api/claude-code/*` | Integrations, hook features, tool categories/permissions, ruleset, MCP config, skills, sessions |
| `/api/skills-studio/*` | Skill library, artifacts, install/create/import/export/validate |
| `/api/bridges/openclaw` | OpenClaw bridge sync |
| `/api/system/*` | Full backup/restore |
| `/api/tunnel/*` | Cloudflare tunnel start/stop/status |
| `/api/invite/*` | Invite session management, proxy, permissions |
| `/api/greeting/*` | Per-project greeting configuration |
| `/api/session-indexing/*` | Session transcript indexing start/cancel/status/mirror |
| `/api/setup/*` | Onboarding wizard endpoints |
| `/mcp` | MCP HTTP transport endpoint |

## Security

- Cloudflare tunnel traffic: only `/mcp` and `/invite` paths allowed unless cookie-authenticated
- Admin-only prefixes blocked for guest (invite) sessions: settings, connections, setup, invite management, claude-code, tunnel
- Invite sessions: 24-hour TTL, cookie `synabun_invite`

## 3D Visualization (public/index.html)

- Three.js + ForceGraph3D library for interactive 3D force-directed graph
- Memories rendered as nodes, relationships as edges (computed from cosine similarity, shared related files, same parent category, explicit links)
- Features: click to select, inline editing panel, semantic search bar
- Category sidebar with color-coded filtering and hierarchy editing
- Graphics quality presets: Low, Medium, High, Ultra (affects particle count, bloom effects, label rendering)
- Modular architecture: core graph in `variant/3d/`, camera in `variant/3d/camera.js`, settings in `variant/3d/settings-gfx.js`
- Memory Sync UI in Settings > Memory tab
- Resizable, draggable, pinnable panels with localStorage persistence

## Onboarding Wizard (public/onboarding.html)

- Guided setup flow for new users
- Steps: dependency check → database setup → local embeddings download → MCP registration → CLAUDE.md injection
- Option to restore from backup on welcome screen
- Communicates with setup API endpoints on the same server
