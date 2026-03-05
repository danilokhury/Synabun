# SynaBun — Persistent Vector Memory for AI Coding Tools

Persistent vector memory via SQLite + local Transformers.js embeddings. Memories survive across sessions.

---

## Memory Ruleset

> Portable ruleset — copy into any project's `CLAUDE.md`. Copy button in Neural Interface: Settings > Connections > Claude Code > Copy Ruleset.

### Tools

| Tool | Purpose |
|------|---------|
| `remember` | Store memory (content, category, project, tags, importance, related_files) |
| `recall` | Semantic search across memories |
| `forget` / `restore` | Trash / restore a memory by ID |
| `reflect` | Update existing memory (importance, tags, content, category) |
| `memories` | List recent or stats (recent, by-category, by-project) |
| `sync` | Detect stale memories (file content changed) |
| `category_create/update/delete/list` | Manage category hierarchy |

### Auto-Recall

- Session start: `recall` current project context
- Topic mentioned: `recall` what you know
- Before decisions: `recall` past decisions
- Debugging: `recall` similar bugs

### Auto-Remember (MANDATORY)

After ANY task (bug fix, feature, refactor, config change, investigation, architecture decision), MUST `remember` BEFORE responding.

**Steps:**
1. `remember` — what + why + how, appropriate category, set project, related_files, importance (5=routine, 6-7=significant, 8+=critical), and 3-5 tags

`remember` now returns the full UUID and accepts all fields (tags, importance) directly. No need to recall+reflect afterward.

**NOT triggered by:** Simple Q&A, file reads with no findings, trivial typos.

**Importance:** 1-2=trivial, 3-4=low, 5=normal, 6-7=significant, 8-9=critical, 10=foundational. User says "remember this" → 8+. Architecture decisions → 8+. API quirks → 6+.

### Category Selection

1. Match existing child → use it
2. Parent fits but no child → `category_create` child → use it
3. Nothing fits → `category_create` parent + child → use it

Never store directly in parent categories.

### Tool Quirks

- `remember` returns the full UUID and accepts tags + importance directly.
- `reflect` requires FULL UUID — use the one returned by `remember`, or `recall` to find existing memories.
- Sequential MCP calls only — never parallel.

---

## Condensed Rulesets

### Cursor
```
# Memory: SynaBun MCP (SQLite + local embeddings)
## Tools: remember, recall, forget, restore, reflect, memories, sync, category_create/update/delete/list
## Rules
- Session start: recall project context
- After any task: remember what+why+how with tags + importance (MANDATORY)
- Bug fixes: importance 7+. Architecture: 8+. User says "remember this": 8+
- remember returns full UUID. Use reflect only to update existing memories.
- Sequential MCP calls only
- Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical, 10=foundational
```

### Generic
```
## Memory: SynaBun MCP
Tools: remember, recall, forget, restore, reflect, memories, sync, category_*
- Recall at session start. Remember after every task with tags + importance (MANDATORY).
- remember returns full UUID. reflect is for updating existing memories.
- Sequential calls only. Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical
```

### Gemini
```
## Memory: SynaBun MCP
Tools: remember, recall, forget, restore, reflect, memories, sync, category_*
- Recall at session start. Remember after every task with tags + importance (MANDATORY).
- remember returns full UUID. reflect is for updating existing memories.
- Sequential calls only. Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical
```

### Codex
```
## Memory: SynaBun MCP
Tools: remember, recall, forget, restore, reflect, memories, sync, category_*
- Recall at session start. Remember after every task with tags + importance (MANDATORY).
- remember returns full UUID. reflect is for updating existing memories.
- Sequential calls only. Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical
```

---

## Hook System

5 Claude Code hooks in `hooks/claude-code/`, registered in `~/.claude/settings.json`.

| Hook | Script | Purpose |
|------|--------|---------|
| SessionStart | `session-start.mjs` | Injects directives + category tree. Handles compaction restarts. |
| UserPromptSubmit | `prompt-submit.mjs` | Tiered recall nudges based on message content. |
| PreCompact | `pre-compact.mjs` | Caches session data, sets pending-compact flag. |
| Stop | `stop.mjs` | Blocks if pending-compact or 3+ edits without remember. |
| PostToolUse | `post-remember.mjs` | Tracks edits. Clears flags on remember. |

**Compaction chain:** PreCompact → flag → SessionStart injects → Claude remembers(conversations) → PostToolUse clears → Stop allows.
**Task chain:** PostToolUse tracks edits → Stop blocks at 3+ → Claude remembers → cleared.

---

## Category System

Stored in `mcp-server/data/custom-categories-{connId}.json`. Managed via MCP tools or Neural Interface UI.

Descriptions are routing instructions: `"ONLY for deal/pricing memories"` not `"Pricing and stores"`.

---

## Development

```
synabun/
├── mcp-server/          # TS MCP server → dist/ (npm run build)
├── hooks/claude-code/   # 5 hook scripts (.mjs, ESM)
├── neural-interface/    # Express + public/{index,onboarding}.html
├── skills/              # Claude Code skill definitions
├── data/                # Runtime flags, features, API keys
└── .env                 # All config (optional overrides)
```

```bash
node neural-interface/server.js                    # UI on :3344
cd mcp-server && npm run build                     # Build MCP
claude mcp add SynaBun -s user -e DOTENV_PATH="..." -- node ".../mcp-server/dist/preload.js"
```

**Architecture:** SQLite database (data/memory.db), local Transformers.js embeddings (384 dims), per-connection categories, ESM hooks, single-file Neural Interface (vanilla JS + Three.js), paths from `resolve(__dirname, '..')`.
