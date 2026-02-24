---
category: development
tags: [contributing, code-style, testing, es-modules, typescript]
importance: 7
project: synabun
source: self-discovered
related_files:
  - CONTRIBUTING.md
  - README.md
---

# SynaBun Code Style & Contributing Guidelines

## Code Style

- **ES modules** throughout (`"type": "module"` in all package.json files)
- **TypeScript** for the MCP server (`mcp-server/`), **plain JavaScript** for Neural Interface and hooks
- **File naming:** kebab-case (`category-create.ts`, `session-start.mjs`)
- **Types/interfaces:** PascalCase (`MemoryPayload`, `CustomCategory`)
- **Two-space indentation**
- **Single quotes** for strings
- No linter or formatter configured — relies on consistent style through convention

## Testing (manual only — no automated test suite)

1. **MCP Tools**: Restart Claude Code → run `/mcp` to verify tools are listed → test remember, recall, forget, reflect, memories
2. **Neural Interface**: Open `http://localhost:3344` → verify 3D graph renders → test search, category management, memory editing
3. **Hooks**: Start new Claude Code session → verify category tree appears in system context

## Development Modes

- **MCP Server**: `cd mcp-server && npm run dev` (tsx with hot reload)
- **Neural Interface**: `cd neural-interface && npm start` (Express server on port 3344)
- **Qdrant**: `docker compose up -d`

## Where to Make Changes

| Change type | Where |
|------------|-------|
| New MCP tool | `mcp-server/src/tools/` (TypeScript) |
| Qdrant queries | `mcp-server/src/services/qdrant.ts` |
| Embedding logic | `mcp-server/src/services/embeddings.ts` |
| Category management | `mcp-server/src/services/categories.ts` |
| Neural Interface API | `neural-interface/server.js` |
| 3D visualization | `neural-interface/public/index.html` |
| Setup wizard | `neural-interface/public/onboarding.html` |
| Claude Code hooks | `hooks/claude-code/` |

## Contributions

Pull requests are not accepted. Bug reports and feature requests are welcome via GitHub Issues. Users are free to fork and modify under Apache 2.0, but must use a different name for their fork.

## Trademark

"SynaBun" is trademarked — forks must use a different name. The license does not grant trademark rights.
