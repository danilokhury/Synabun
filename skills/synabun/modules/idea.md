# Idea — Memory-Powered Brainstorming

You are now in **brainstorming mode**. Your job is to loop through SynaBun's persistent memory, find surprising connections between disparate memories, and synthesize novel ideas the user hasn't considered.

**Input topic**: $ARGUMENTS

If the input topic is empty, you are in **freeform mode** — explore the full memory landscape and surface the most interesting cross-domain connections you can find.

## CRITICAL: SynaBun MCP Tool Quirks

- Make ALL SynaBun MCP calls **sequentially** (never in parallel — one failure cascades)
- When using `remember`, **omit** the `tags` and `importance` parameters (they cause type errors via XML serialization). Use `reflect` after to set them.
- The `reflect` tool requires the **FULL UUID** (e.g., `8f7cab3b-644e-4cea-8662-de0ca695bdf2`), not the shortened ID. Use `recall` first to get the full UUID.

## Process

Execute these phases in order. Do NOT skip phases or combine them.

---

### Phase 1 — Landscape Survey

1. Call `category_list` with format `tree` to see all memory categories and their hierarchy.
2. Call `memories` with mode `stats` to understand the memory landscape (counts, categories, projects).
3. If a topic was provided, identify which categories are most relevant AND which are most distant (distant = higher cross-pollination potential).
4. If freeform mode, note the top 3 categories by memory count and the most underexplored category.

**Output to user**: Brief summary of what you found — how many memories exist, which domains are richest, and your brainstorming strategy for the rounds ahead.

---

### Phase 2 — Multi-Round Recall

Execute **5 sequential recall rounds**. Each round uses a different query strategy. After each round, briefly note what you found before moving to the next.

**IMPORTANT**: Make each `recall` call with `limit: 5` and `min_score: 0.2`. Do NOT filter by project unless the user's topic is clearly project-specific.

#### Round 1 — Direct
- If topic given: `recall` with the topic as the query
- If freeform: `recall` with query "recent important work decisions architecture" and `min_importance: 7`
- **Goal**: Establish the core memory cluster around the topic

#### Round 2 — Adjacent Exploration
- Extract 2-3 key concepts from Round 1 results (themes, technologies, patterns mentioned)
- `recall` with a query built from these adjacent concepts — things related to but distinct from the original topic
- **Goal**: Expand the radius beyond the obvious

#### Round 3 — Problem Space
- `recall` with query focused on challenges, bugs, constraints, pain points related to the topic area
- Example: if topic is "caching", query "cache problems bugs race condition invalidation challenges"
- If freeform: query "bugs challenges problems pain points unresolved"
- **Goal**: Find the friction — where problems exist, ideas are needed most

#### Round 4 — Solution Patterns
- `recall` with query focused on past solutions, patterns, architectures, approaches
- Example: if topic is "caching", query "caching strategy pattern architecture optimization solution"
- If freeform: query "solutions patterns architecture decisions implementations"
- **Goal**: Find the building blocks — proven approaches that can be recombined

#### Round 5 — Cross-Domain Surprise
- Pick a category that is **unrelated** to the topic (from Phase 1 landscape)
- `recall` with an abstract version of the topic, filtered to this distant category
- Example: if topic is "real-time notifications" and distant category is "deals", query "real-time updates synchronization" with `category: "deals"`
- If freeform: pick the least-explored category and query "interesting patterns approaches"
- **Goal**: Force unexpected connections — this is where the most creative ideas come from

After all 5 rounds, you should have **15-25 memory snippets** across different categories and domains.

---

### Phase 3 — Connection Mapping & Synthesis

Now synthesize. Do this internally (thinking), then produce ideas.

For each pair of memories from **different categories or rounds**:
1. What do they have in common at an abstract level?
2. What tension or contradiction exists between them?
3. What gap does one fill that the other exposes?
4. Could the approach from one be applied to the domain of the other?

Generate **3-5 concrete ideas**. Prioritize:
- **Cross-category connections** (e.g., a bug-fix pattern applied to a feature design)
- **Gap-filling** (a problem memory without a matching solution memory)
- **Pattern transfer** (a solution from domain A adapted to domain B)
- **Contradiction resolution** (two memories that suggest opposite approaches — the synthesis is often the best idea)

---

### Phase 4 — Present Ideas

Present each idea in this format:

```
## Brainstorm Results: [Topic or "Freeform Exploration"]

### Idea 1: [Concise Title]
**Concept**: [1-2 sentence description of the idea]

**Reasoning chain**:
- Started from [short-id] — [brief content] (category)
- Connected to [short-id] — [brief content] (different category)
- [Gap/tension/pattern identified]
- Synthesis: [How combining these produces the idea]

**Inspired by**: [short-id] (category), [short-id] (category), ...
**Next steps**: [2-3 concrete actions to explore or implement this idea]

---
```

After presenting all ideas, add a brief **"Threads to Pull"** section listing 2-3 additional directions that showed promise but weren't fully developed — seeds for future brainstorming sessions.

---

### Phase 5 — Capture

After presenting ideas, ask the user:

> "Want me to save any of these ideas to your SynaBun memory? I can store them in an `ideas` category so they persist across sessions."

If the user says yes:

1. Call `category_list` (flat format) to check if an `ideas` category already exists
2. If not, call `category_create` with:
   - `name`: "ideas"
   - `description`: "Brainstormed features, experiments, and creative explorations"
   - `parent`: the current project's parent category (e.g., "criticalpixel") — or no parent if no project match
3. For each idea the user wants saved, call `remember` with:
   - `content`: The full idea text (title + concept + reasoning chain + next steps)
   - `category`: "ideas"
   - `project`: current project name
   - (Omit `tags` and `importance` — known quirk)
4. Then call `reflect` on each saved memory to set:
   - `importance`: 6 for speculative ideas, 7 for actionable ones
   - `tags`: ["brainstorm", topic keywords]

---

## Guidelines

- **Be genuinely creative** — don't just summarize memories. The value is in the *connections* between them that the user hasn't seen.
- **Cite specific memories** — every idea must trace back to at least 2 memories. This is what makes it different from generic brainstorming.
- **Embrace surprises** — Round 5 (cross-domain) often produces the best ideas. Give it weight.
- **Quality over quantity** — 3 excellent ideas beat 5 mediocre ones.
- **Stay grounded** — ideas should be actionable, not abstract philosophy. Each needs concrete next steps.
- **Acknowledge limits** — if the memory landscape is thin (< 10 total memories), say so and suggest the user build up memories first before brainstorming.
