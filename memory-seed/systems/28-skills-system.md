---
category: mcp-tools
tags: [skills, slash-command, synabun-skill, brainstorm, audit, memorize]
importance: 8
project: synabun
source: self-discovered
related_files:
  - skills/synabun/SKILL.md
  - skills/synabun/modules/idea.md
  - skills/synabun/modules/audit.md
  - skills/synabun/modules/memorize.md
---

# SynaBun Skills System

Skills are SKILL.md prompt files that provide specialized workflows invoked via slash commands. Not MCP tools — they're Claude Code's native skill system.

## /synabun Skill

**Trigger:** `/synabun`, `synabun`, `memory menu`, `synabun menu`
**Args:** `[idea|audit|memorize|health|search]` or blank for interactive menu

### Routes

| Args | Destination |
|------|-------------|
| `idea` / `brainstorm` | Brainstorming module (`modules/idea.md`) |
| `audit` | Memory audit module (`modules/audit.md`) |
| `memorize` / `remember` / `store` / `save` | Context-to-memory module (`modules/memorize.md`) |
| `health` / `stats` | Inline health dashboard |
| `search` / `recall` / `find` | Inline memory search |
| (empty) | Interactive paginated menu via AskUserQuestion |

### Health Dashboard (inline)
Calls `memories` with `action: "stats"`, then `sync`. Renders formatted dashboard with totals, per-category/project breakdown, and stale memory report.

### Memory Search (inline)
Calls `recall` with `limit: 10`. Presents numbered results. Offers: view full (requires UUID), search again, done. View-full offers: update (reflect), delete (forget), back.

## Brainstorming Module (/synabun idea)

5-phase creative workflow:
1. **Landscape Survey**: `category_list` (tree) + `memories` (stats)
2. **Multi-Round Recall**: 5 sequential rounds — direct, adjacent, problem-space, solution-space, cross-domain. Each `limit: 5, min_score: 0.2`
3. **Synthesis**: Cross-category connections, gap-filling, pattern transfer, contradiction resolution
4. **Present**: 3-5 ideas with reasoning chain + provenance (memory IDs)
5. **Capture**: Auto-creates `ideas` category if needed, stores via remember + reflect

## Audit Module (/synabun audit)

Systematic memory quality review: checks for duplicates, outdated content, orphaned categories, importance distribution, and suggests cleanup actions.

## Memorize Module (/synabun memorize)

Converts current conversation context into a structured memory. Analyzes the conversation, identifies key learnings/decisions, and stores them with appropriate categorization.

## Installation

Skills installed at `~/.claude/skills/synabun/`. Can be symlinked from the SynaBun repo's `skills/synabun/` directory.

## Skills Studio (Neural Interface)

The Neural Interface includes a Skills Studio at `/api/skills-studio/*` for managing skills:
- Library browsing and search
- Skill creation, import, export
- Artifact management
- Validation

## Critical MCP Quirks

Called out explicitly in SKILL.md:
- All SynaBun MCP calls MUST be sequential, never parallel
- `remember` accepts `tags` and `importance` directly
- `reflect` requires FULL UUID format (36 characters)
