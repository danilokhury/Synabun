# CLAUDE.md

====================================END SYNBUN

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SynaBun

Persistent vector memory for AI assistants — SQLite + local Transformers.js embeddings (all-MiniLM-L6-v2, 384 dims). No external services, no API keys, no Docker. Installed via `npm install -g synabun` or cloned from GitHub.

## Commands

```bash
# Start everything (installs deps, builds MCP, launches Neural Interface)
npm start                                    # runs setup.js

# Neural Interface only (Express server on :3344)
node neural-interface/server.js

# Build MCP server (required after any TypeScript change)
cd mcp-server && npm run build               # ALWAYS use npm run build, never npx tsc

# Dev mode (auto-rebuild on change)
cd mcp-server && npm run dev                 # tsx src/index.ts

# Tests
cd mcp-server && npm test                    # vitest run
cd mcp-server && npm run test:watch          # vitest watch mode

# Register MCP with Claude Code
claude mcp add SynaBun -s user -- node "/path/to/Synabun/mcp-server/run.mjs"
```

## Architecture

Two independently running processes that share one SQLite database:

### MCP Server (`mcp-server/`)
TypeScript, compiles to `dist/`. Entry point: `run.mjs` → `dist/preload.js` → `dist/index.js`. Communicates with AI tools via MCP protocol (stdio or HTTP). 72 tools across 9 groups: Memory (8), Browser (39), Whiteboard (5), Cards (5), Discord (8), Leonardo (4), Git (1), Loop (1), TicTacToe (1).

- `src/index.ts` — tool registration, schema refresh, server creation
- `src/config.ts` — env config, project detection from `claude-code-projects.json`
- `src/types.ts` — `MemoryPayload` interface
- `src/http.ts` — HTTP MCP transport (stateless, fresh server per request)
- `src/services/sqlite.ts` — storage layer, vectors as Float32Array BLOBs, cosine similarity in JS
- `src/services/local-embeddings.ts` — Transformers.js embedding generation
- `src/services/categories.ts` — category CRUD, hierarchy, dynamic schema refresh
- `src/tools/` — one file per tool (or per tool group with a registration function)

### Neural Interface (`neural-interface/`)
Express server (`server.js`, ~15K lines) serving a vanilla JS + Three.js frontend. 55+ REST API endpoints. Runs on port 3344.

- `server.js` — monolithic Express server with all API routes, WebSocket, terminal (node-pty), Playwright browser management, session registry, loop orchestration
- `public/index.html` — 3D force-directed graph (Three.js)
- `public/index2d.html` — 2D canvas variant
- `public/onboarding.html` — first-time setup wizard
- `public/claude-chat.html` — standalone Claude Code chat page
- `public/shared/` — modular JS/CSS (~50 files): `ui-*.js` modules, `storage.js` (server-synced state), `styles.css`, `utils.js`
- `lib/db.js` — shared SQLite access (same DB as MCP server)
- `lib/session-indexer.js` — conversation session indexing
- `skins/` — theme system (CSS + JSON per skin)
- `i18n/` — internationalization (en.json)
- `templates/CLAUDE-template.md` — source of truth for memory rulesets injected into project CLAUDE.md files

### Hooks (`hooks/claude-code/`)
7 ESM (.mjs) lifecycle hooks for Claude Code, registered in `.claude/settings.json`:

| Hook | Event | Purpose |
|------|-------|---------|
| `session-start.mjs` | SessionStart | Greeting, boot sequence, compaction recovery, loop detection |
| `prompt-submit.mjs` | UserPromptSubmit | Tiered recall nudges, loop iteration injection |
| `pre-compact.mjs` | PreCompact | Transcript capture before context compaction |
| `stop.mjs` | Stop | Combined obligations: compaction, loops, task memory, user learning |
| `post-remember.mjs` | PostToolUse | Edit tracking, flag clearing, user learning |
| `pre-websearch.mjs` | PreToolUse | Blocks WebSearch/WebFetch during active browser sessions |
| `post-plan.mjs` | PostToolUse | Auto-stores plans as memories on ExitPlanMode |

`shared.mjs` contains utilities used across hooks.

### Skills (`skills/`)
Claude Code slash commands with `SKILL.md` entry points and `modules/` subdirectories:
- `synabun/` — `/synabun` command hub (brainstorm, audit, health, search)
- `leonardo/` — `/leonardo` master media prompter (video, image, model advisor, prompt library)

### Data Flow
```
AI tool calls remember → MCP server embeds content → SQLite stores vector + payload
AI tool calls recall   → MCP server embeds query  → cosine similarity search → re-ranked results
Neural Interface       → reads same SQLite DB      → renders 3D graph, REST API, WebSocket
Hooks                  → fire on Claude Code events → inject context, enforce memory obligations
```

### Shared State
- `data/memory.db` — single SQLite database (memories, session chunks, trash)
- `data/ui-state.json` — Neural Interface UI state (synced via `storage.js`)
- `data/pending-compact/` — per-session compaction flags
- `data/pending-remember/` — per-session edit tracking flags
- `mcp-server/data/custom-categories-{connId}.json` — per-connection category definitions

## Key Patterns

- **Category descriptions are routing instructions**: Claude reads all category descriptions from the MCP tool schema to decide where to store memories. Descriptions must be prescriptive rules, not vague labels.
- **Dynamic schema refresh**: Category changes trigger `refreshCategorySchemas()` → `notifications/tools/list_changed` → Claude re-fetches tool list. No restart needed.
- **Per-tab session isolation**: Project/model/effort state stored per-tab in sidepanel (`ui-claude-panel.js`) and per-tab via `sessionStorage` in standalone (`claude-chat.js`). Global `ui-state.json` keys are "last used" defaults only.
- **Browser sessions**: Playwright with persistent Chromium profiles. Multi-session isolation via dedicated browser session per automation. Leonardo tools are 100% browser-based (no API key).
- **Compaction chain**: PreCompact → flag → SessionStart injects → Claude remembers(conversations) → PostToolUse clears → Stop allows.
- **MCP calls must be sequential**: Parallel MCP tool calls can cascade failures. Always call memory tools one at a time.

## Environment

- Node.js 22.5+ required (for built-in `node:sqlite`)
- `.env` at project root — `SQLITE_DB_PATH`, `NEURAL_PORT` (default 3344), `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`
- CLAUDE.md is gitignored (user-local)

## Persistent Memory

You have persistent vector memory via the `SynaBun` MCP server (72 tools).
Core memory tools: remember, recall, forget, restore, reflect, memories, sync, category.

### Auto-Recall
- Session start: recall current project context
- Topic mentioned: recall what you know
- Before architecture decisions: recall past decisions
- Debugging: recall similar bugs

### Auto-Remember (MANDATORY)
After ANY task (bug fix, feature, refactor, config change, investigation, architecture decision), MUST `remember` BEFORE responding.

Steps:
1. `remember` — what + why + how, appropriate category, set project, related_files, importance (5=routine, 6-7=significant, 8+=critical), and 3-5 tags

`remember` returns the full UUID and accepts all fields (tags, importance) directly. No need to recall+reflect afterward.

**NOT triggered by:** Simple Q&A, file reads with no findings, trivial typos.

**Importance scale:** 1-2=trivial, 3-4=low, 5=normal, 6-7=significant, 8-9=critical, 10=foundational. User says "remember this" → 8+. Architecture decisions → 8+.

### Response Ordering
When finishing a task: call `remember` (and any other memory tools) **FIRST**, then write your completion summary **LAST**. Never summary-then-tools — the stop hook will block you.

### Tool Quirks
- `remember` returns the full UUID and accepts tags + importance directly.
- `reflect` requires FULL UUID — use the one from `remember`, or `recall` to find existing memories.
- Sequential MCP calls only — never parallel.

### Plan Mode
When in plan mode and you need clarification:
- ALWAYS use `AskUserQuestion` to present options — never plain text questions
- Use `ExitPlanMode` for final plan approval
- Use `multiSelect: true` in AskUserQuestion when options aren't mutually exclusive
