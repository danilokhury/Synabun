# SynaBun — Codex Instructions

## Memory: SynaBun MCP

Use SynaBun for ALL memory operations. In Codex these tools may appear with `mcp__SynaBun__*` prefixes.

Tools: `remember`, `recall`, `forget`, `restore`, `reflect`, `memories`, `sync`, `category_*`

- Session start: recall current project context, recent sessions, known issues, and prior decisions before substantial work.
- During work: recall before architecture decisions, debugging, migrations, or when the user references prior work or existing patterns.
- After any substantive task: remember what changed, why, and how with project, related_files, 3-5 tags, and importance (5=routine, 6-7=significant, 8+=critical). Do this BEFORE your final summary.
- Response ordering: call remember/reflect FIRST, then write your completion summary LAST. Never summary-then-tools.
- `remember` returns the full UUID. Use `reflect` only to update an existing memory; `reflect` requires the full UUID.
- Category routing: use an existing child category when possible; otherwise create the needed child under the right parent. Never store directly in parent categories.
- If you produce an approved implementation plan with durable value, store it in the appropriate `plans-*` category.
- Sequential MCP calls only. Never parallelize SynaBun memory-tool calls.
- Planning: while planning, do research and analysis only. Do not edit files until the plan is approved. Ask concise clarification questions only when necessary.
- User preferences: when communication style matters, recall communication-style memories first. If you discover a stable new preference, store or update it there.

## Coexistence

SynaBun owns memory. Do not use other tools or services for storing, recalling, or updating long-term context.

## Capability Boundary

Claude Code in this repo has additional hook-based automations. Codex should follow these rules via `AGENTS.md` + MCP and must not assume Claude hook events or `.claude/settings.json` behavior exist.
