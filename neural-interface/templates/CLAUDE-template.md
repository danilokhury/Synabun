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

### Response Ordering (IMPORTANT)

When finishing a task, structure your response as:
1. Call `remember` (and any other memory tools) **FIRST**
2. Write your completion summary / final message **LAST**

Tool call results appear above text within a single response, so the summary naturally ends up at the bottom where the user sees it. This prevents memory tool calls from burying your completion message under noise.

**Never** write your summary first and then call memory tools — the stop hook will block you, forcing a new response of memory tool calls that pushes your summary off-screen.

### Category Selection

1. Match existing child → use it
2. Parent fits but no child → `category_create` child → use it
3. Nothing fits → `category_create` parent + child → use it

Never store directly in parent categories.

### Tool Quirks

- `remember` returns the full UUID and accepts tags + importance directly.
- `reflect` requires FULL UUID — use the one returned by `remember`, or `recall` to find existing memories.
- Sequential MCP calls only — never parallel.

### Plan Mode (MANDATORY)

**CRITICAL**: Plan mode = research and planning ONLY. Do NOT use Edit, Write, or NotebookEdit. Read files, search code, investigate — then present the plan. Do NOT implement until the user approves and you exit plan mode.

When you need clarification or have questions:
- **ALWAYS** use `AskUserQuestion` to present options — never write questions as plain text
- Load the tool via `ToolSearch` first if its schema is not yet available
- Structure as distinct choices (2-4 options per question, max 4 questions)
- Use for approach clarification BEFORE finalizing the plan
- Use `ExitPlanMode` (not AskUserQuestion) for final plan approval

### Multi-Select Questions

When using `AskUserQuestion`, set `multiSelect: true` when options are NOT mutually exclusive — i.e., the user could reasonably want more than one. Examples: selecting multiple features, tags, effects, or follow-up actions. Keep single-select (default) for inherently exclusive choices (one model, one style, one dimension).

---

## Coexistence with Other Tools

When running SynaBun alongside other memory or code intelligence tools (CogniLayer, mem0, etc.):

**SynaBun owns ALL memory operations:**
- Storing information: `remember`
- Searching past context: `recall`
- Updating memories: `reflect`
- Deleting/restoring: `forget` / `restore`
- Browsing: `memories`
- Stale detection: `sync`
- Categories: `category` (create/update/delete/list)

**Other tools** should be restricted to their non-memory capabilities only (e.g., AST-based code search, code impact analysis).

**Enforcement rule for CLAUDE.md / project instructions:**
```
For ALL memory operations (store, search, recall, update, delete), use SynaBun tools exclusively.
[OtherTool] is restricted to [specific use case, e.g., code_search, code_context, code_impact].
Never use [OtherTool] for remembering, recalling, or reflecting on past work.
```

If you notice the AI defaulting to another tool's memory features, add the enforcement rule above to your project's `CLAUDE.md`.

---

## Condensed Rulesets

### Cursor
```
# Memory: SynaBun MCP (SQLite + local embeddings)
## Tools: remember, recall, forget, restore, reflect, memories, sync, category_create/update/delete/list
## Rules
- Session start: recall project context
- After any task: remember what+why+how with tags + importance (MANDATORY)
- Response ordering: call remember FIRST, then write your summary LAST. Never summary-then-tools.
- Bug fixes: importance 7+. Architecture: 8+. User says "remember this": 8+
- remember returns full UUID. Use reflect only to update existing memories.
- Sequential MCP calls only
- Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical, 10=foundational
- Plan mode: ALWAYS use AskUserQuestion for questions — never plain text. Use ExitPlanMode for plan approval.
- AskUserQuestion: use multiSelect: true when options aren't mutually exclusive (multiple tags, features, effects, actions).
```

### Generic
```
## Memory: SynaBun MCP
Tools: remember, recall, forget, restore, reflect, memories, sync, category_*
- Recall at session start. Remember after every task with tags + importance (MANDATORY).
- Response ordering: call remember FIRST, then write your summary LAST. Never summary-then-tools.
- remember returns full UUID. reflect is for updating existing memories.
- Sequential calls only. Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical
- Plan mode: ALWAYS use AskUserQuestion for questions — never plain text. Use ExitPlanMode for plan approval.
- AskUserQuestion: use multiSelect: true when options aren't mutually exclusive (multiple tags, features, effects, actions).
```

### Gemini
```
## Memory: SynaBun MCP
Tools: remember, recall, forget, restore, reflect, memories, sync, category_*
- Recall at session start. Remember after every task with tags + importance (MANDATORY).
- Response ordering: call remember FIRST, then write your summary LAST. Never summary-then-tools.
- remember returns full UUID. reflect is for updating existing memories.
- Sequential calls only. Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical
- Plan mode: ALWAYS use AskUserQuestion for questions — never plain text. Use ExitPlanMode for plan approval.
- AskUserQuestion: use multiSelect: true when options aren't mutually exclusive (multiple tags, features, effects, actions).
```

### Codex
```
## Memory: SynaBun MCP
Tools: remember, recall, forget, restore, reflect, memories, sync, category_*
- Recall at session start. Remember after every task with tags + importance (MANDATORY).
- Response ordering: call remember FIRST, then write your summary LAST. Never summary-then-tools.
- remember returns full UUID. reflect is for updating existing memories.
- Sequential calls only. Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical
- Plan mode: ALWAYS use AskUserQuestion for questions — never plain text. Use ExitPlanMode for plan approval.
- AskUserQuestion: use multiSelect: true when options aren't mutually exclusive (multiple tags, features, effects, actions).
```

---

## Plan Files

When in plan mode, write plan files to the project's `data/plans/` directory — **NOT** `~/.claude/plans/`. The `~/.claude/` directory is treated as sensitive by Claude Code, causing repeated permission prompts that don't persist across context compactions. The `data/plans/` directory is within the project root and requires no special permissions.

---

## Hook System

7 Claude Code hooks in `hooks/claude-code/`, registered in `~/.claude/settings.json`.

| Hook | Script | Purpose |
|------|--------|---------|
| SessionStart | `session-start.mjs` | Greeting, boot sequence, compaction recovery, loop detection, session registration. |
| UserPromptSubmit | `prompt-submit.mjs` | Tiered recall nudges, loop iteration injection, category tree on first threshold. |
| PreCompact | `pre-compact.mjs` | Caches session data, sets pending-compact flag. |
| Stop | `stop.mjs` | Combined obligations: compaction, loops, task memory, user learning, conversation turns, auto-store, unstored plans. |
| PreToolUse | `pre-websearch.mjs` | Blocks WebSearch/WebFetch during active browser sessions. |
| PostToolUse | `post-remember.mjs` | Tracks edits. Clears flags on remember. User learning flag management. |
| PostToolUse | `post-plan.mjs` | Auto-stores plans in memory when exiting plan mode. |

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
├── hooks/claude-code/   # 7 hook scripts (.mjs, ESM)
├── neural-interface/    # Express server + public/ + templates/
│   ├── public/          # index.html, onboarding.html, shared/ (modular JS/CSS)
│   └── templates/       # CLAUDE-template.md (source of truth for rulesets)
├── skills/              # Claude Code skill definitions
├── data/                # Runtime flags, features, API keys
└── .env                 # All config (optional overrides)
```

```bash
node neural-interface/server.js                    # UI on :3344
cd mcp-server && npm run build                     # Build MCP
claude mcp add SynaBun -s user -- node ".../mcp-server/run.mjs"
```

**Architecture:** SQLite database (data/memory.db), local Transformers.js embeddings (384 dims), per-connection categories, ESM hooks, modular Neural Interface (vanilla JS + Three.js, shared/ modules), paths from `resolve(__dirname, '..')`.
