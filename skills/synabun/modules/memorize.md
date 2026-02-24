# Memorize — Convert Context to Persistent Memory

You are now in **memorize mode**. Your job is to analyze the full conversation context leading up to the `/synabun memorize` invocation, distill it into a well-structured markdown memory, and store it in SynaBun for future recall.

**Input**: $ARGUMENTS

- If the input is empty → analyze the entire conversation context
- If the input contains text → use it as a focus hint (e.g., "memorize the redis discussion" → focus on that topic within the conversation)

## CRITICAL: SynaBun MCP Tool Quirks

- Make ALL SynaBun MCP calls **sequentially** (never in parallel — one failure cascades).
- `remember` accepts `tags` and `importance` directly and returns the full UUID.
- `reflect` requires the **FULL UUID**. Use the UUID returned by `remember`, or `recall` to find existing memories.

---

## Process

Execute these phases in order. Do NOT skip phases or combine them.

---

### Phase 1 — Context Analysis

Analyze the ENTIRE conversation history available in your context window. Extract:

1. **Core topic(s)**: What was the conversation primarily about?
2. **Key decisions made**: Any architectural, design, or implementation choices
3. **Problems discussed**: Bugs, issues, blockers, pain points
4. **Solutions found**: Fixes, workarounds, patterns discovered
5. **Files touched**: Any files that were read, edited, or created
6. **Code patterns**: Notable code snippets, configurations, or commands
7. **Open threads**: Unfinished work, TODOs, things to revisit
8. **User preferences**: Any stated preferences about tools, approaches, workflows

**Do NOT output anything to the user during this phase** — this is internal analysis only.

---

### Phase 2 — Draft Memory

Compose the memory as a structured markdown document. Follow this template precisely:

```markdown
## Context: [Descriptive Title — 5-10 words capturing the essence]
**Date**: [YYYY-MM-DD]
**Project**: [detected project]
**Branch**: [current git branch if detectable]

### Summary
[2-4 sentences: What was discussed, what was accomplished, what was decided. Be specific — mention actual function names, file paths, error messages, not vague descriptions.]

### Key Details
[Bulleted list of the most important specifics. Include:]
- Decisions and their reasoning
- Technical details that would be hard to rediscover
- Configuration values, API endpoints, command invocations
- Error messages and their root causes
- Patterns or approaches chosen (and alternatives rejected)

### Files Referenced
[Bulleted list of file paths that were relevant, with brief annotation]
- `path/to/file.ts` — [what was done or discussed about it]

### Open Items
[If any — things left unfinished, TODOs, follow-ups needed]
- [ ] [description of unfinished work]

### Commands & Snippets
[If any notable commands or code snippets were part of the conversation]
```bash or ```typescript etc.
[the command or snippet]
```
```

**Rules for the draft:**
- **Be specific, not generic** — "Fixed race condition in price aggregation by adding mutex lock" not "Fixed a bug"
- **Include actual values** — file paths, function names, error messages, config keys
- **Preserve technical detail** — the memory should let future-you reconstruct context without re-reading the conversation
- **Omit sections that don't apply** — if there were no open items, skip that section. If no commands were notable, skip that section.
- **Keep it dense** — target 200-500 words. Long enough to be useful, short enough to be scannable.

---

### Phase 3 — Metadata Selection

Determine the appropriate metadata for this memory:

#### Category Selection
1. Check if the conversation topic fits an existing child category under `conversations` by calling `category_list` with format `tree`.
2. If the conversation has a clear specialized topic that doesn't fit existing children, consider creating a new child category under `conversations` — but only if it represents a genuinely distinct recurring topic (not a one-off).
3. **Default**: Use `conversations` as the category. Most context memories belong here.

#### Tags
Generate 3-5 lowercase tags. Include:
- The primary topic (e.g., "redis", "auth", "forum")
- The type of work (e.g., "bug-fix", "feature", "refactor", "investigation", "architecture")
- Key technologies or systems involved (e.g., "supabase", "next-js", "lexical")
- Always include `"context-memorize"` as a tag to distinguish these from auto-indexed session memories

#### Importance
- **5**: Routine work, standard feature additions, minor fixes
- **6**: Significant decisions, non-obvious solutions, multi-file changes
- **7**: Architectural decisions, hard-won debugging sessions, critical path work
- **8+**: Foundational decisions that affect the entire project

#### Related Files
Collect all file paths that were read, edited, or discussed. These enable the `sync` tool to detect staleness later.

---

### Phase 4 — Review & Confirm

Present the draft to the user for review:

```
══════════════════════════════════════════
       MEMORIZE CONTEXT
══════════════════════════════════════════
```

Then output the full drafted memory content (from Phase 2).

Then output the metadata:

```
──────────────────────────────────────────
 Category:    [category]
 Project:     [project]
 Importance:  [N] — [brief justification]
 Tags:        [tag1, tag2, tag3, ...]
 Files:       [count] referenced
──────────────────────────────────────────
```

Then use `AskUserQuestion`:

- **Save as-is** — "Store this memory exactly as drafted"
- **Edit first** — "I want to adjust the content or metadata before saving"
- **Cancel** — "Don't save anything"

**If user picks "Edit first":**
Use `AskUserQuestion` to ask what they want to change:

- **Edit content** — "Change the memory text (tell me what to modify)"
- **Change importance** — "Adjust the importance level"
- **Change tags** — "Modify the tags"
- **Change category** — "Use a different category"

After the user provides edits, incorporate them and re-present the updated draft. Loop until the user is satisfied or picks "Save as-is".

---

### Phase 5 — Store

Once the user confirms:

1. Call `remember` with:
   - `content`: The final markdown memory text
   - `category`: The selected category (default: `conversations`)
   - `project`: The detected project
   - `importance`: The determined importance level
   - `tags`: The generated tags (always including `"context-memorize"`)
   - `related_files`: Array of file paths referenced
   - `source`: `"user-told"`

2. Confirm storage to the user:

```
══════════════════════════════════════════
 Memory stored successfully.
 ID:    [short-id from returned UUID]
 Category: [category]
 Tags:  [tags]
══════════════════════════════════════════
```

---

## Guidelines

- **Density over length** — A 300-word memory with specific details is worth more than a 1000-word one full of filler.
- **The user's conversation IS the source** — don't invent details. Only memorize what was actually discussed.
- **Focus hints matter** — if the user said `/synabun memorize the pricing discussion`, zoom in on that topic even if the conversation covered other things too.
- **Dedup awareness** — if the conversation has already been indexed via compaction auto-store (a `conversations` memory with the same session ID exists), note this to the user and offer to either update the existing memory or create a supplementary one.
- **Sequential MCP calls only** — never call two SynaBun tools in the same parallel batch.
- **Full UUIDs always** — use the complete UUID from `remember` output, never shortened.
