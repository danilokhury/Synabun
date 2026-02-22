# Contributing to SynaBun

Thanks for your interest in contributing to SynaBun! This document explains how to get started, make changes, and submit them for review.

## Development Setup

### Prerequisites

- Node.js 18+
- Docker (for Qdrant)
- An embedding API key (OpenAI, Google Gemini, or any [supported provider](./README.md#embedding-providers))

### Quick Start

```bash
git clone https://github.com/your-username/synabun.git
cd synabun
npm start
```

This installs dependencies, builds the MCP server, and opens the onboarding wizard. See the [README](./README.md#quick-start) for detailed setup instructions.

### Development Modes

**MCP Server** (TypeScript, hot reload):
```bash
cd mcp-server
npm run dev          # Runs via tsx with hot reload
npm run build        # Compile TypeScript to dist/
```

**Neural Interface** (JavaScript):
```bash
cd neural-interface
npm start            # Express server on port 3344
```

**Qdrant** (Docker):
```bash
docker compose up -d     # Start
docker compose down      # Stop
docker compose logs -f   # View logs
```

## Project Structure

```
synabun/
├── mcp-server/         # MCP Protocol server (TypeScript)
│   └── src/
│       ├── tools/      # 11 MCP tools (remember, recall, forget, restore, reflect, memories, sync, category_*)
│       └── services/   # Qdrant, embeddings, categories, file-checksums
├── neural-interface/   # 3D visualization UI (Express + Three.js)
│   ├── server.js       # REST API backend (55+ endpoints)
│   └── public/         # Frontend HTML/JS (3D + 2D variants)
├── hooks/              # Claude Code lifecycle hooks
│   └── claude-code/    # 5 hooks: SessionStart, PromptSubmit, PreCompact, Stop, PostToolUse
├── skills/             # Claude Code skills (slash commands)
│   └── synabun/        # /synabun command hub (brainstorm, audit, health, search)
├── data/               # Runtime data (flags, caches, feature toggles)
├── memory-seed/        # Bootstrap seed data for new installations
├── .tests/             # Vitest test suite (unit + scenario/cost tests)
├── docs/               # Extended documentation
└── setup.js            # One-command setup wizard
```

See the [README File Structure](./README.md#file-structure) section for a complete listing.

## Making Changes

### Workflow

1. Fork the repository
2. Create a branch from `main`: `git checkout -b my-feature`
3. Make your changes
4. Test manually (see [Testing](#testing) below)
5. Commit with a clear message
6. Open a pull request

### Where to Make Changes

| Change type | Where |
|------------|-------|
| New MCP tool | `mcp-server/src/tools/` (TypeScript) — register in `index.ts` |
| Qdrant queries | `mcp-server/src/services/qdrant.ts` |
| Embedding logic | `mcp-server/src/services/embeddings.ts` |
| Category management | `mcp-server/src/services/categories.ts` |
| File hash tracking | `mcp-server/src/services/file-checksums.ts` |
| Neural Interface API | `neural-interface/server.js` |
| 3D visualization | `neural-interface/public/index.html` |
| 2D visualization | `neural-interface/public/index2d.html` |
| Setup wizard | `neural-interface/public/onboarding.html` |
| Claude Code hooks | `hooks/claude-code/` (5 hook files) |
| Claude Code skills | `skills/synabun/` (SKILL.md + modules/) |
| Hook feature flags | `data/hook-features.json` |
| Seed data | `memory-seed/` (categorized markdown files) |

### After Making Changes

- **MCP server changes:** Run `npm run build` in `mcp-server/`, then restart Claude Code to load the new MCP server.
- **Neural Interface changes:** Restart the Express server (`npm start` in `neural-interface/`).
- **Hook changes:** No build needed. Hooks are plain `.mjs` files loaded at runtime.
- **Skill changes:** No build needed. Skills are `.md` prompt files. Install globally by copying to `~/.claude/skills/`.

## Code Style

- **ES modules** throughout (`"type": "module"` in all package.json files)
- **TypeScript** for the MCP server, **plain JavaScript** for the Neural Interface and hooks
- **File naming:** kebab-case (`category-create.ts`, `session-start.mjs`)
- **Types/interfaces:** PascalCase (`MemoryPayload`, `CustomCategory`)
- **Two-space indentation**
- **Single quotes** for strings

There is no linter configured yet. We rely on consistent style through convention.

## Testing

### Automated Tests (Vitest)

SynaBun includes a Vitest test suite in `.tests/`:

```bash
cd .tests
npm install
npx vitest run          # Run all tests
npx vitest run unit     # Unit tests only
npx vitest run scenarios # Scenario/cost tests only
```

- **Unit tests** cover all 11 MCP tools (remember, recall, forget, restore, reflect, memories, sync, category_*)
- **Scenario tests** simulate usage patterns (light/medium/heavy user) and benchmark Claude API call costs

### Manual Testing

1. **MCP tools:** Restart Claude Code, run `/mcp` to verify all 11 tools are listed, then use `remember`, `recall`, etc.
2. **Neural Interface:** Open `http://localhost:3344`, verify the 3D graph renders, test search, category management, trash, sync, and memory editing.
3. **Hooks:** Start a new Claude Code session and verify the category tree and 4 directives appear in the system context.
4. **Skills:** Run `/synabun` to access the command hub, test all menu options (Brainstorm Ideas, Audit Memories, Memory Health, Search Memories).

If you add a new MCP tool, register it in `mcp-server/src/index.ts` and verify it appears in Claude Code's tool list via `/mcp`.

## Pull Requests

When submitting a PR, please:

1. **Describe the change** — what it does and why
2. **Update documentation** if your change affects:
   - New/changed MCP tools -> update the README [MCP Tools](./README.md#mcp-tools) table
   - New/changed API endpoints -> update [docs/api-reference.md](./docs/api-reference.md)
   - New/changed env vars -> update [.env.example](./.env.example) and README [Configuration](./README.md#configuration)
   - New/changed hooks -> update [docs/hooks.md](./docs/hooks.md) and README [Claude Code Hooks](./README.md#claude-code-hooks) table
   - New/changed skills -> update README [Claude Code Skills](./README.md#claude-code-skills) section
   - New seed data -> add to `memory-seed/` in the appropriate subdirectory
3. **Test your changes** manually before submitting

## Reporting Issues

When opening an issue, include:

- **Operating system** and version
- **Node.js version** (`node --version`)
- **Docker version** (`docker --version`)
- **Error output** (full stack trace if available)
- **Steps to reproduce**

## Trademark Notice

"SynaBun" is a trademark. If you fork this project, please use a different name for your fork. The Apache 2.0 license (Section 6) does not grant permission to use the SynaBun name, trademarks, or branding.

You are free to:
- Use, modify, and distribute the code
- Build your own memory system based on this codebase
- Reference SynaBun as the original project

You must not:
- Use "SynaBun" as the name of your fork or derivative product
- Imply official endorsement or affiliation
