---
category: hooks
tags: [skill, brainstorming, idea, slash-command, recall, multi-round]
importance: 8
project: synabun
source: self-discovered
subcategory: skills
related_files:
  - skills/idea/SKILL.md
---

# SynaBun `/idea` Skill — Memory-Powered Brainstorming

## What It Is

A Claude Code skill (slash command) that orchestrates SynaBun's MCP tools into a structured brainstorming workflow. Not an MCP tool itself — it's a prompt file (`SKILL.md`) that teaches Claude how to use `recall`, `remember`, `reflect`, `category_list`, and `memories` in a multi-round pattern.

## Location

- **Source (distributed with SynaBun):** `skills/idea/SKILL.md`
- **Installed (global Claude Code):** `~/.claude/skills/idea/SKILL.md`

## Usage

```
/idea real-time notifications    # Topic-focused brainstorm
/idea                            # Freeform exploration
```

## How It Works — 5 Phases

### Phase 1: Landscape Survey
Calls `category_list` (tree) and `memories` (stats) to understand what memory domains exist, their sizes, and which are relevant vs. distant from the topic.

### Phase 2: Multi-Round Recall (5 rounds, sequential)

| Round | Strategy | Purpose |
|-------|----------|---------|
| 1 | Direct | Topic verbatim — core cluster |
| 2 | Adjacent | Related concepts from Round 1 — expand radius |
| 3 | Problem-space | Bugs, constraints, pain points — find friction |
| 4 | Solution-space | Past patterns, architectures — find building blocks |
| 5 | Cross-domain | Unrelated category, abstract query — force surprise |

Each round: `recall` with `limit: 5`, `min_score: 0.2`. Produces 15-25 memory snippets.

### Phase 3: Synthesis
Maps connections between memories from different categories/rounds. Looks for:
- Cross-category connections
- Gap-filling (problem without solution)
- Pattern transfer (solution from domain A applied to domain B)
- Contradiction resolution

### Phase 4: Present
Generates 3-5 ideas, each with:
- Concept summary
- Reasoning chain (which memories, which connection)
- Provenance (specific memory IDs and categories)
- Next steps

### Phase 5: Capture
Offers to save ideas. Auto-creates `ideas` category under current project parent if needed. Uses `remember` then `reflect` (two-step, to work around tag/importance quirk).

## Key Design Decisions

1. **Sequential recall rounds** — each round's results inform the next round's query
2. **Cross-domain round** — Round 5 deliberately queries an unrelated category to force surprising connections
3. **Provenance tracking** — every idea must cite at least 2 specific memories
4. **Auto-category creation** — `ideas` category created on-demand, not pre-existing
5. **No complex argument parsing** — just freeform topic text via `$ARGUMENTS`

## Creating Custom Skills

Skills follow Claude Code's SKILL.md format:
```
~/.claude/skills/<name>/SKILL.md
```

Frontmatter: `name`, `description`, `argument-hint`. Body: prompt instructions that can call any SynaBun MCP tool.
