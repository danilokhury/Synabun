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

`npm start` at project root runs `setup.js` (263 lines).

## setup.js Process

1. Check Node.js version >= 18 (exits with error if not met)
2. Check Docker availability (warns if not found, handles Windows Docker Desktop PATH issues)
3. Install npm dependencies for `neural-interface/` and `mcp-server/`
4. Build MCP server TypeScript (if `dist/` missing or stale compared to `src/`)
5. Detect setup state (checks `.env` for `SETUP_COMPLETE=true`)
6. Start Neural Interface Express server on port 3344
7. Auto-open browser to onboarding wizard (or main 3D graph page if setup already complete)

## Onboarding Wizard — 7-Step Guided Flow

(`neural-interface/public/onboarding.html`)

1. **Dependency Check**: Verifies Node.js, npm, Docker, Git versions via `GET /api/setup/check-deps`
2. **Embedding Provider**: Selection from 11 supported providers (OpenAI, Google Gemini, Ollama, Mistral, Cohere, Voyage AI, Together AI, Fireworks, Azure OpenAI, AWS Bedrock, Custom)
3. **API Key Entry**: Provider-specific key input with validation
4. **Docker/Qdrant Setup**: Configures ports, starts Docker Compose, waits for Qdrant health (30s timeout). Generates random 32-char hex API key if none exists.
5. **Collection Creation**: Creates Qdrant collection with vector config via `POST /api/setup/create-collection`
6. **MCP Registration**: Generates `.mcp.json` in target project directory via `POST /api/setup/write-mcp-json`
7. **CLAUDE.md Injection**: Appends memory usage instructions to project's CLAUDE.md via `POST /api/setup/write-instructions`

## Setup API Endpoints (10)

`check-deps`, `status`, `save-config`, `docker`, `create-collection`, `build`, `test-qdrant`, `test-qdrant-cloud`, `write-mcp-json`, `write-instructions`, `complete`
