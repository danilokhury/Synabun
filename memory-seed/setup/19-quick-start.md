---
category: setup
tags: [setup, onboarding, wizard, npm-start, installation, guided-setup]
importance: 8
project: synabun
source: self-discovered
related_files:
  - setup.js
  - neural-interface/public/onboarding.html
  - neural-interface/server.js
---

# SynaBun Quick Start & Onboarding Wizard

## Single-Command Setup

`npm start` at project root runs `setup.js`.

## setup.js Process

1. Check Node.js version >= 18 (exits with error if not met)
2. Install npm dependencies for `neural-interface/` and `mcp-server/`
3. Build MCP server TypeScript (if `dist/` missing or stale compared to `src/`)
4. Detect setup state (checks `.env` for `SETUP_COMPLETE=true`)
5. Initialize SQLite database at `data/memory.db` (created automatically if missing)
6. Start Neural Interface Express server on port 3344
7. Auto-open browser to onboarding wizard (or main 3D graph page if setup already complete)

## Onboarding Wizard — Guided Flow

(`neural-interface/public/onboarding.html`)

1. **Dependency Check**: Verifies Node.js, npm, Git versions via `GET /api/setup/check-deps`
2. **Database Setup**: Initializes SQLite database file at `data/memory.db`, creates tables and indexes automatically
3. **Local Embeddings**: Downloads and initializes Transformers.js model (all-MiniLM-L6-v2, 384 dims) on first run
4. **MCP Registration**: Generates `.mcp.json` in target project directory via `POST /api/setup/write-mcp-json`
5. **CLAUDE.md Injection**: Appends memory usage instructions to project's CLAUDE.md via `POST /api/setup/write-instructions`

## Setup API Endpoints

`check-deps`, `status`, `save-config`, `init-database`, `build`, `test-database`, `write-mcp-json`, `write-instructions`, `complete`
