# Contributing to SynaBun

## How to Contribute

SynaBun is open-source software maintained by a single author. We welcome bug reports, feature requests, and discussions through [GitHub Issues](https://github.com/danilokhury/Synabun/issues), but **we do not accept pull requests**.

You are free to fork and modify SynaBun under the [Apache 2.0 license](./LICENSE).

### Report a Bug

Open an issue using the **Bug Report** template. Include:

- Operating system and version
- Node.js version (`node --version`) — requires 22.19+
- Full error output or stack trace
- Steps to reproduce

### Request a Feature

Open an issue using the **Feature Request** template. Describe:

- The problem you are trying to solve
- Your proposed solution (if any)
- Why this would be valuable

### Security Vulnerabilities

Do NOT open a public issue for security vulnerabilities. Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability). See [SECURITY.md](./SECURITY.md) for details.

## Why No Pull Requests?

SynaBun is maintained by a single author. Accepting external code contributions adds review overhead, license complexity, and maintenance burden that would slow down development. We prefer to move fast and keep the codebase coherent.

Your bug reports and feature requests are invaluable — they directly shape the roadmap.

## Forking

You are free to fork SynaBun and modify it for any purpose under the [Apache 2.0 license](./LICENSE). If you fork the project, you **must** use a different name — see the [Trademark Notice](#trademark-notice) below.

---

## Development Setup (for forkers)

### Prerequisites

- Node.js 22.19+ (required by the current runtime dependencies)

### Quick Start

```bash
git clone --depth=1 https://github.com/your-username/synabun.git
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

## Project Structure (for forkers)

```
synabun/
├── mcp-server/         # MCP Protocol server (TypeScript)
│   └── src/            # Tools, services, transports, and shared types
├── neural-interface/   # Local UI and agent sidepanels
│   ├── lib/            # Server-side modules
│   ├── public/         # Frontend HTML, CSS, and JavaScript
│   ├── tests/          # Node.js regression tests
│   └── server.js       # Express backend
├── hooks/              # Claude Code lifecycle hooks
│   └── claude-code/
├── skills/             # Bundled multi-runtime skills
├── lib/                # Shared path and configuration helpers
└── setup.js            # One-command setup wizard
```

Runtime data is not stored in the checkout. It defaults to `~/.synabun` on macOS/Linux and `%APPDATA%\synabun` on Windows; `SYNABUN_DATA_HOME` overrides the location.

See the [README File Structure](./README.md#file-structure) section for a complete listing.

## Where to Make Changes (for forkers)

| Change type | Where |
|------------|-------|
| New MCP tool | `mcp-server/src/tools/` (TypeScript) — register in `index.ts` |
| Database queries | `mcp-server/src/services/sqlite.ts` |
| Embedding logic | `mcp-server/src/services/local-embeddings.ts` |
| Category management | `mcp-server/src/services/categories.ts` |
| File hash tracking | `mcp-server/src/services/file-checksums.ts` |
| Neural Interface API | `neural-interface/server.js` |
| 3D visualization | `neural-interface/public/index.html` |
| 2D visualization | `neural-interface/public/index2d.html` |
| Setup wizard | `neural-interface/public/onboarding.html` |
| Claude Code hooks | `hooks/claude-code/` (7 hook files) |
| Claude Code skills | `skills/synabun/` (SKILL.md + modules/) |
| Regression tests | `neural-interface/tests/` |

### After Making Changes

- **MCP server changes:** Run `npm run build` in `mcp-server/`, then restart Claude Code to load the new MCP server.
- **Neural Interface changes:** Restart the Express server (`npm start` in `neural-interface/`).
- **Hook changes:** No build needed. Hooks are plain `.mjs` files loaded at runtime.
- **Skill changes:** No build needed. Skills are `.md` prompt files. Install globally by copying to `~/.claude/skills/`.

## Code Style (for forkers)

- **ES modules** throughout (`"type": "module"` in all package.json files)
- **TypeScript** for the MCP server, **plain JavaScript** for the Neural Interface and hooks
- **File naming:** kebab-case (`category-create.ts`, `session-start.mjs`)
- **Types/interfaces:** PascalCase (`MemoryPayload`, `CustomCategory`)
- **Two-space indentation**
- **Single quotes** for strings

There is no linter configured yet. We rely on consistent style through convention.

## Testing (for forkers)

### Automated Checks

```bash
npm --prefix mcp-server run build
node --test neural-interface/tests/*.test.mjs
```

Run checks from the repository root after installing the package dependencies.

### Manual Testing

1. **MCP tools:** Restart your MCP client, verify the selected SynaBun profile loads, then exercise the tools affected by your change.
2. **Neural Interface:** Open `http://localhost:3344`, verify the 3D graph renders, test search, category management, trash, sync, and memory editing.
3. **Hooks:** Start a new Claude Code session and verify the category tree and 5 directives appear in the system context.
4. **Skills:** Run `/synabun` to access the command hub, test all menu options (Brainstorm Ideas, Audit Memories, Memory Health, Search Memories).

If you add a new MCP tool, register it in `mcp-server/src/index.ts` and verify it appears in Claude Code's tool list via `/mcp`.

## Trademark Notice

"SynaBun" is a trademark. If you fork this project, you **must** use a different name for your fork or derivative work. The license does not grant permission to use the SynaBun name, trademarks, or branding.

You are free to:
- Use, modify, and distribute the code under Apache 2.0
- Build your own memory system based on this codebase
- Reference SynaBun as the original project

You must not:
- Use "SynaBun" as the name of your fork or derivative product
- Imply official endorsement or affiliation

## License

SynaBun is licensed under the [Apache License 2.0](./LICENSE). Premium features and enterprise extensions may be offered under a separate commercial license. See [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md) for details.
