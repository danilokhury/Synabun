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
| `profile` | Inspect or switch MCP tool profiles/tool selector at runtime |

### Auto-Recall

- Session start: `recall` current project context
- Topic mentioned: `recall` what you know
- Before decisions: `recall` past decisions
- Debugging: `recall` similar bugs

### Auto-Remember (MANDATORY)

After ANY task (bug fix, feature, refactor, config change, investigation, architecture decision), MUST `remember` BEFORE responding.

**Steps:**
1. `remember` — what + why + how, appropriate category, set project, related_files, importance (5=routine, 6-7=significant, 8+=critical), and 3-5 tags

`remember` accepts every field directly and returns the full UUID — no recall+reflect afterward. `category` and `project` are **required on every call**; a call that omits them is rejected. Set `importance` deliberately (5 only when the work is genuinely routine). Storing a memory is also what clears the stop hook's unstored-edits block.

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

- `remember` requires `category` and `project` on every call, accepts tags + importance directly, and returns the full UUID.
- `reflect` requires FULL UUID — use the one returned by `remember`, or `recall` to find existing memories.
- Sequential MCP calls only — never parallel.

### MCP Profile / Tool Selector

- Before using platform-specific or heavy tool groups, call `profile` with `action: "get"` unless the current profile is already known from this turn.
- Switch with `profile` `action: "set"` only when the current profile does not expose the needed tools.
- Choose the narrowest useful profile: `core` for memory-only work, `standard` for normal coding/git/memory work, `browser` for generic browser automation, `twitter` / `facebook` / `tiktok` / `whatsapp` / `instagram` / `linkedin` for social-platform work, `gsc` for Search Console/SEO work, and `full` only when the task truly needs broad unrelated tool families.
- If you switch for a temporary task, keep the previous profile in turn-local context and restore it when finished unless the user asks to keep the new profile.
- After `profile set`, the Neural Interface profile selector should update immediately. If the UI appears out of sync, call `profile get` and report the mismatch instead of guessing.

### Browser Sessions

- For public-web browsing, search, or page retrieval, use only the configured SynaBun browser tools (`browser_*` and SynaBun's platform-specific browser tools).
- Never use WebSearch, WebFetch, Playwright MCP, Chrome DevTools MCP, or another browser/search/fetch tool for the public web unless the user explicitly requests that specific alternative.
- Use agent-facing Playwright and Chrome DevTools only for testing or debugging localhost/loopback UIs (`localhost`, `127.0.0.1`, `[::1]`) unless the user explicitly directs otherwise.
- If the configured SynaBun browser is unavailable, report that limitation and do not silently substitute another web tool.
- When starting a browser session, **always create a new tab** — never reuse or navigate an existing tab. Existing tabs may contain the user's active work, unsaved state, or authenticated sessions that must not be disrupted.

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

**SynaBun also owns public-web access by default:**
- Use only the configured SynaBun browser for public-web browsing, search, and page retrieval.
- Do not silently substitute WebSearch, WebFetch, Playwright MCP, Chrome DevTools MCP, or another web tool; an alternative requires an explicit user request.
- Keep agent-facing Playwright and Chrome DevTools limited to localhost/loopback UI testing or debugging unless explicitly directed otherwise.
- If the SynaBun browser is unavailable, report it instead of switching tools, and always open public-web work in a new tab.

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
## Tools: remember, recall, forget, restore, reflect, memories, sync, category_create/update/delete/list, profile
Tool names may be prefixed by the host. Only call tools by their EXACT names from your available tools list. Never invent or guess tool names.
## Rules
- Session start: recall project context
- After any task: remember what+why+how with tags + importance (MANDATORY)
- Response ordering: call remember FIRST, then write your summary LAST. Never summary-then-tools.
- Bug fixes: importance 7+. Architecture: 8+. User says "remember this": 8+
- remember requires category + project on every call; returns full UUID. Use reflect only to update existing memories.
- Sequential MCP calls only
- Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical, 10=foundational
- Plan mode: ALWAYS use AskUserQuestion for questions — never plain text. Use ExitPlanMode for plan approval.
- AskUserQuestion: use multiSelect: true when options aren't mutually exclusive (multiple tags, features, effects, actions).
- Browser: use only the configured SynaBun browser for public-web browsing, search, and page retrieval. Never silently fall back to WebSearch, WebFetch, Playwright MCP, Chrome DevTools MCP, or another web tool; an alternative requires an explicit user request. Use agent-facing Playwright/Chrome DevTools only for localhost or loopback UI testing/debugging by default. If the SynaBun browser is unavailable, report it instead of switching tools. Always create a new tab — never reuse or navigate an existing tab.
- Tool selector: use `profile` get/set to switch only when needed, choose the narrowest profile (`standard` coding, `browser` generic web, platform profiles for social/GSC), and restore temporary switches when done.
```

### Generic
```
## Memory: SynaBun MCP
Tools: remember, recall, forget, restore, reflect, memories, sync, category_*, profile
Tool names are prefixed by the host (e.g. SynaBun_remember in OpenCode, mcp__SynaBun__remember in Claude Code, SynaBun_profile / mcp__SynaBun__profile for the tool selector).
IMPORTANT: Only call tools by their EXACT names from your available tools list. Never invent or guess tool names.
- Recall at session start. Remember after every task with tags + importance (MANDATORY).
- Response ordering: call remember FIRST, then write your summary LAST. Never summary-then-tools.
- remember requires category + project on every call; returns full UUID. reflect is for updating existing memories.
- Sequential calls only. Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical
- Plan mode: ALWAYS use AskUserQuestion for questions — never plain text. Use ExitPlanMode for plan approval.
- AskUserQuestion: use multiSelect: true when options aren't mutually exclusive (multiple tags, features, effects, actions).
- Browser: use only the configured SynaBun browser for public-web browsing, search, and page retrieval. Never silently fall back to WebSearch, WebFetch, Playwright MCP, Chrome DevTools MCP, or another web tool; an alternative requires an explicit user request. Use agent-facing Playwright/Chrome DevTools only for localhost or loopback UI testing/debugging by default. If the SynaBun browser is unavailable, report it instead of switching tools. Always create a new tab — never reuse or navigate an existing tab.
- Tool selector/profile: before platform-specific work, call profile get, then profile set only if needed. Prefer the narrowest profile: core/standard for local work, browser for generic web, twitter/facebook/tiktok/whatsapp/instagram/linkedin for social platforms, gsc for Search Console, full only as a last resort. Restore temporary switches when done.
```

### Gemini
```
## Memory: SynaBun MCP
Tools: remember, recall, forget, restore, reflect, memories, sync, category_*, profile
Tool names may be prefixed by the host (e.g. SynaBun_remember). Only call tools by their EXACT names from your available tools list.
- Recall at session start. Remember after every task with tags + importance (MANDATORY).
- Response ordering: call remember FIRST, then write your summary LAST. Never summary-then-tools.
- remember requires category + project on every call; returns full UUID. reflect is for updating existing memories.
- Sequential calls only. Scale: 1-2=trivial, 5=normal, 7=significant, 9=critical
- Plan mode: ALWAYS use AskUserQuestion for questions — never plain text. Use ExitPlanMode for plan approval.
- AskUserQuestion: use multiSelect: true when options aren't mutually exclusive (multiple tags, features, effects, actions).
- Browser: use only the configured SynaBun browser for public-web browsing, search, and page retrieval. Never silently fall back to WebSearch, WebFetch, Playwright MCP, Chrome DevTools MCP, or another web tool; an alternative requires an explicit user request. Use agent-facing Playwright/Chrome DevTools only for localhost or loopback UI testing/debugging by default. If the SynaBun browser is unavailable, report it instead of switching tools. Always create a new tab — never reuse or navigate an existing tab.
- Tool selector: use `profile` get/set only when a task needs a different MCP tool profile; choose the narrowest profile and restore temporary switches when done.
```

### Codex
```
## Memory: SynaBun MCP
Use SynaBun for ALL memory operations. Tool names are prefixed by the host:
- OpenCode: SynaBun_remember, SynaBun_recall, SynaBun_forget, SynaBun_restore, SynaBun_reflect, SynaBun_memories, SynaBun_sync, SynaBun_category, SynaBun_loop, SynaBun_git, SynaBun_image_staged, SynaBun_profile
- Claude Code / Codex: mcp__SynaBun__remember, mcp__SynaBun__recall, mcp__SynaBun__profile, etc.
IMPORTANT: Only call tools by their EXACT names as they appear in your available tool list. Never invent, guess, or use colon-separated tool names.
- Session start: recall current project context, recent sessions, known issues, and prior decisions before substantial work.
- During work: recall before architecture decisions, debugging, migrations, or when the user references prior work or existing patterns.
- After any substantive task: remember what changed, why, and how with project, related_files, 3-5 tags, and importance (5=routine, 6-7=significant, 8+=critical). Do this BEFORE your final summary.
- Response ordering: call remember/reflect FIRST, then write your completion summary LAST. Never summary-then-tools.
- remember requires `category` and `project` on every call and returns the full UUID. Use reflect only to update an existing memory; reflect requires the full UUID.
- Category routing: use an existing child category when possible; otherwise create the needed child under the right parent. Never store directly in parent categories.
- If you produce an approved implementation plan with durable value, store it in the appropriate `plans-*` category.
- Sequential MCP calls only. Never parallelize SynaBun memory-tool calls.
- Planning: while planning, do research and analysis only. Do not edit files until the plan is approved. Ask concise clarification questions only when necessary.
- User preferences: when communication style matters, recall communication-style memories first. If you discover a stable new preference, store or update it there.
- Coexistence: SynaBun owns memory. Do not use other tools or services for storing, recalling, or updating long-term context.
- Capability boundary: Claude Code in this repo has additional hook-based automations. Codex should follow these rules via AGENTS.md + MCP and must not assume Claude hook events or `.claude/settings.json` behavior exist.
- Browser: use only the configured SynaBun browser for public-web browsing, search, and page retrieval. Never silently fall back to WebSearch, WebFetch, Playwright MCP, Chrome DevTools MCP, or another web tool; an alternative requires an explicit user request. Use agent-facing Playwright/Chrome DevTools only for localhost or loopback UI testing/debugging by default. If the SynaBun browser is unavailable, report it instead of switching tools. Always create a new tab — never reuse or navigate an existing tab.
- Tool selector/profile: use `profile` with `action: "get"` before platform-specific or heavy tool work unless the current profile is known. Use `profile` with `action: "set"` only when needed, choose the narrowest profile (`core`, `standard`, `browser`, social platform profiles, `gsc`; `full` only as a last resort), and restore temporary switches when finished unless the user asks to keep them. After a switch, the sidepanel profile selector should update immediately; if it appears stale, verify with `profile get` and report the mismatch.
```

---

## Plan Files

When in plan mode, write plan files to `~/.synabun/data/plans/YYYY-MM-DD/your-plan-slug.md` — a date-organized folder with a short descriptive slug derived from the plan title.

- **Format:** `~/.synabun/data/plans/2026-04-06/fix-session-crosstalk.md`
- **Slug rules:** lowercase, kebab-case, max 60 chars, strip leading "Plan:" prefix
- **Do NOT** create `PLAN.md` at the project root
- **Do NOT** write to `~/.claude/plans/` — that directory is treated as sensitive by Claude Code, causing repeated permission prompts that don't persist across context compactions

The `post-plan.mjs` hook auto-migrates any legacy flat plans and stores approved plans in SQLite memory on ExitPlanMode.

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

Stored in `~/.synabun/mcp-data/custom-categories-{connId}.json` by default. Managed via MCP tools or Neural Interface UI.

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
├── lib/                 # Shared data-home and migration helpers
└── ~/.synabun/          # Runtime state and optional .env (outside Git)
```

```bash
node neural-interface/server.js                    # UI on :3344
cd mcp-server && npm run build                     # Build MCP
claude mcp add SynaBun node ".../mcp-server/run.mjs" -s user
```

**Architecture:** SQLite database (`~/.synabun/mcp-data/memory.db`), local Transformers.js embeddings (384 dims), per-connection categories, ESM hooks, modular Neural Interface (vanilla JS + Three.js, shared/ modules), and a platform-owned data home kept outside the code checkout.
