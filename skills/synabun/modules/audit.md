# Audit — Memory Validation Against Codebase

You are now in **memory audit mode**. Your job is to systematically validate SynaBun memories against the current state of the codebase, identify stale or invalid memories, and help the user clean them up interactively.

**Input scope**: $ARGUMENTS

- If the input is empty → interactively ask the user to choose a scope (Phase 1b)
- If the input is "all" → audit all categories
- If the input matches a category name → audit that category (and its children if it is a parent)

## CRITICAL: SynaBun MCP Tool Quirks

- Make ALL SynaBun MCP calls **sequentially** (never in parallel — one failure cascades to all sibling calls in the batch).
- `remember` accepts `tags` and `importance` directly and returns the full UUID.
- `reflect` requires the **FULL UUID** (e.g., `8f7cab3b-644e-4cea-8662-de0ca695bdf2`). Use the UUID returned by `remember`, or `recall` to find existing memories.
- The `forget` tool also requires the full UUID.
- The `memories` tool maxes out at 50 results per call. If a category has more than 50 memories, warn the user that only the 50 most recent will be audited.

## Classification Definitions

| Status | Meaning | Default Action |
|--------|---------|----------------|
| **VALID** | Memory content is still accurate per the current codebase | Keep as-is |
| **STALE** | Memory references something that has changed — info is outdated | Update via `reflect` |
| **INVALID** | Memory references things that no longer exist (deleted files, removed functions, renamed patterns) | Delete via `forget` |
| **UNVERIFIABLE** | Cannot determine accuracy from code alone (process decisions, external API behavior, user preferences, conversation context) | Skip (manual review) |

---

## Process

Execute these phases in order. Do NOT skip phases or combine them.

---

### Phase 1 — Configuration

This phase collects three pieces of information: audit scope, model choice, and user confirmation.

#### Step 1a: Landscape Survey

1. Call `category_list` with format `tree` to get the full category hierarchy.
2. Call `memories` with action `stats` to get total counts and per-category breakdowns.
3. Internalize the results — you'll need them for every subsequent step.

#### Step 1b: Scope Selection

**If `$ARGUMENTS` is not empty and is not "all":**
- Check if the argument matches a category name (parent or child) from the tree.
- If it matches a parent, the scope is that parent and all its children.
- If it matches a child, the scope is just that child category.
- If it matches nothing, inform the user and fall through to interactive selection.

**If `$ARGUMENTS` is "all":**
- Scope is every category. Proceed to Step 1c.

**If `$ARGUMENTS` is empty or did not match:**

Use `AskUserQuestion` with these options:

- **Audit everything** — "Full audit of all [N] memories across all categories"
- **Audit a parent category** — "Audit a parent and all its children"
- **Audit a specific category** — "Audit just one category"

If user picks **parent category**, follow up with another `AskUserQuestion` listing only parent categories with their total memory counts (sum of parent + all children). Let the user pick one.

If user picks **specific category**, follow up with another `AskUserQuestion` listing all categories (flat) with their memory counts. Let the user pick one.

#### Step 1c: Model Selection

Use `AskUserQuestion` to ask which model should verify memories against code:

- **Sonnet (Recommended)** — "Good balance of quality and cost"
- **Opus** — "Most thorough analysis, highest token cost"
- **Haiku** — "Fastest and cheapest, may miss subtle staleness"

Store the selection. This will be used as the `model` parameter when calling the `Task` tool in Phase 4.

#### Step 1d: Cost Warning and Confirmation

Calculate the estimated scope:
- Count total memories in scope (from stats).
- Count categories in scope.

Use `AskUserQuestion`:

- **Proceed** — "Start the audit"
- **Abort** — "Cancel and return to normal mode"

Frame the question with this context (adapt numbers to actual counts):

> **Token cost warning**: This audit will check **N memories** across **M categories** using **[model]**. Each memory requires reading its content and verifying against the codebase. This can be a high-token-cost operation, especially with Opus on large scopes.

If user aborts, end gracefully with a message.

---

### Phase 2 — Checksum Pre-scan (Fast Pass)

This phase uses the `sync` MCP tool for instant staleness detection on memories that have stored file checksums. This is essentially free — no LLM verification tokens needed.

1. Call `sync` (with `project` parameter if scope is project-specific, otherwise without).
2. Parse the results:
   - Memories flagged as stale by sync → **pre-classified as STALE** with HIGH confidence.
   - Note the specific files that changed for each stale memory.
3. Filter results to only include memories whose category matches the selected scope.

**Output to user**: Brief summary — "Pre-scan found X memories with changed files out of Y total memories with file checksums."

If sync returns no results or errors, that's fine — move on. Not all memories have file checksums.

---

### Phase 3 — Memory Retrieval (Bulk Fetch)

Fetch all memories in the selected scope to get their full UUIDs, content, and metadata.

**For "all categories" scope:**
- Iterate through each category from Phase 1.
- For each category with memories, call `memories` with action `by-category`, category set to the current one, limit `50`.
- Collect all results into a master list.

**For parent category scope:**
- Identify all child categories from the Phase 1 tree.
- Call `memories` with action `by-category` for each child (and the parent itself if it has direct memories), limit `50`.

**For single category scope:**
- Call `memories` with action `by-category` for that category, limit `50`.

**Progress reporting**: After fetching, output: "Fetched N memories across M categories."

**After retrieval, triage into buckets:**

- **Bucket A**: Memories already flagged STALE by sync (Phase 2) → confirmed stale, skip verification.
- **Bucket B**: Memories with `related_files` whose checksums matched (not flagged by sync) → classify VALID, skip verification.
- **Bucket C**: Memories with `related_files` where the referenced file no longer exists on disk → INVALID candidates, verify in Phase 4.
- **Bucket D**: Memories without `related_files` metadata → require full semantic verification in Phase 4.

**Output to user**: Summary of bucket sizes:
```
Ready to verify:
  Pre-confirmed stale (checksums changed):  [A count]
  Pre-confirmed valid (checksums match):    [B count]
  Possibly invalid (files missing):         [C count]
  Need semantic verification (no checksums): [D count]
```

**Edge cases:**
- Empty categories → skip silently, don't call the MCP tool for them.
- If Buckets C and D are both empty → skip Phase 4 entirely, output "All memories verified via checksum comparison."

---

### Phase 4 — Semantic Verification (Task Agent Delegation)

This is the most token-intensive phase. Only Bucket C and Bucket D memories need verification.

**Skip this phase entirely** if Buckets C and D are both empty.

#### Verification via Task Tool

Batch memories from Buckets C and D into groups of **5 memories** per Task call. Sort by importance descending so the most critical memories are verified first.

For each batch, call the `Task` tool with:
- `description`: "Verify N SynaBun memories"
- `subagent_type`: "general-purpose"
- `model`: the model selected in Phase 1c (opus / sonnet / haiku)
- `prompt`: A detailed prompt containing the verification instructions and memories (see template below)

**Verification prompt template for each Task call:**

```
You are verifying stored memories against the current state of the codebase.
For each memory below, determine if the information is still accurate.

Use Read, Grep, and Glob tools to check the codebase. Be thorough but efficient.
- Check if referenced files still exist
- Check if referenced functions, patterns, or configurations are still present
- Check if described behavior matches current code

For each memory, output EXACTLY this format:

---
MEMORY_ID: [full uuid]
STATUS: VALID | STALE | INVALID | UNVERIFIABLE
CONFIDENCE: HIGH | MEDIUM | LOW
REASON: [1-2 sentence explanation]
SUGGESTED_ACTION: KEEP | UPDATE | DELETE | SKIP
SUGGESTED_CONTENT: [If STATUS is STALE, provide corrected content. Otherwise "N/A"]
---

Classification rules:
- VALID: Code/files/patterns described still exist and work as described.
- STALE: Code exists but has changed — memory describes an older version.
- INVALID: Files, functions, or patterns referenced no longer exist at all.
- UNVERIFIABLE: Memory describes decisions, preferences, external behavior, or conversation context that cannot be verified by reading code.

Memories to verify:

[For each memory in batch:]
=== Memory [full-uuid] ===
Category: [category]
Project: [project]
Importance: [importance]
Created: [created_at]
Content:
[full memory content]
===
```

After each Task completes, parse its structured output and add results to the master results list.

**Progress reporting**: After each batch, output:
"Verified batch X/Y — [count] VALID, [count] STALE, [count] INVALID, [count] UNVERIFIABLE so far..."

---

### Phase 5 — Interactive Results

Present findings and let the user decide what to do with each flagged memory.

#### Summary Dashboard

Output this formatted summary:

```
══════════════════════════════════════════
       MEMORY AUDIT RESULTS
══════════════════════════════════════════
 Scope:    [description of scope]
 Model:    [model used]
 Checked:  [total] memories

 VALID:          [count]
 STALE:          [count]
 INVALID:        [count]
 UNVERIFIABLE:   [count]
══════════════════════════════════════════
```

**If 0 STALE and 0 INVALID**: Skip all interactive sections below and go straight to Phase 6. Just show the dashboard.

#### Stale Memories (Interactive)

Process stale memories one at a time, sorted by importance descending.

For each stale memory, output:

```
── STALE MEMORY ──────────────────────────
ID:         [short-id] | [category] | importance: [N]
Age:        [how old]
Confidence: [HIGH/MEDIUM/LOW]
Reason:     [why it's stale]

Current content (preview):
  [first 200 chars of content]

Suggested update (preview):
  [first 200 chars of suggested content]
──────────────────────────────────────────
```

Then use `AskUserQuestion` with these options:

- **Update** — "Apply the suggested content update via reflect"
- **Delete** — "Remove this memory entirely"
- **Skip** — "Leave it as-is for now"
- **View full** — "Show full current + suggested content, then decide"

If there are more than 1 stale memory remaining after presenting the first one, add bulk options:

- **Update all remaining** — "Apply suggested updates to ALL remaining stale memories"
- **Skip all remaining** — "Skip all remaining stale memories"

Actions:
- **Update**: Call `reflect` with `memory_id` (full UUID) and `content` (suggested update).
- **Delete**: Call `forget` with the full UUID.
- **View full**: Show both full texts, then re-present the same `AskUserQuestion`.
- **Update all**: Loop through remaining stale memories, call `reflect` for each sequentially.
- **Skip / Skip all**: Move on.

#### Invalid Memories (Interactive)

Same pattern but simpler — no suggested update.

For each invalid memory, output:

```
── INVALID MEMORY ────────────────────────
ID:         [short-id] | [category] | importance: [N]
Age:        [how old]
Confidence: [HIGH/MEDIUM/LOW]
Reason:     [what no longer exists]

Content (preview):
  [first 200 chars]
──────────────────────────────────────────
```

Use `AskUserQuestion` with options:

- **Delete** — "Remove this memory"
- **Skip** — "Keep it for now"
- **View full** — "Show full content, then decide"

Plus bulk options if more than 1 remaining:

- **Delete all remaining** — "Delete ALL remaining invalid memories"
- **Skip all remaining** — "Skip all remaining"

#### Unverifiable Memories (Informational Only)

If there are unverifiable memories, present as a numbered list. No interactive prompts — purely informational.

```
── UNVERIFIABLE (manual review) ──────────
These memories could not be verified from code alone:

1. [short-id] | [category] | imp: [N]
   Reason: [why unverifiable]
   [first 100 chars of content]

2. ...
──────────────────────────────────────────
```

---

### Phase 6 — Audit Report and Capture

#### Final Summary

```
══════════════════════════════════════════
       AUDIT COMPLETE
══════════════════════════════════════════
 Memories updated:      [count]
 Memories deleted:      [count]
 Memories skipped:      [count]
 Memories valid:        [count]
 Memories unverifiable: [count]
 Total checked:         [total]
══════════════════════════════════════════
```

#### Save Report

Use `AskUserQuestion`:

- **Save report** — "Store this audit report in SynaBun for tracking memory health over time"
- **No thanks** — "Skip saving"

If save:
1. Call `remember` with:
   - `content`: Structured summary — date, scope, model, counts per classification, list of updated/deleted memory short-IDs, notable findings
   - `category`: "synabun"
   - `project`: current detected project
   - `importance`: 6
   - `tags`: ["audit", "memory-health"]

---

## Guidelines

- **Respect the user's time** — if there are 0 STALE and 0 INVALID, skip interactive sections and just show the summary.
- **Sequential MCP calls only** — never call two SynaBun tools in the same parallel batch.
- **Full UUIDs always** — the `memories` tool returns full UUIDs in `[uuid]` brackets. Parse these carefully. Never use shortened IDs with `reflect` or `forget`.
- **Importance-first ordering** — always process higher-importance memories first. A stale importance-9 architectural decision matters more than a stale importance-3 debug note.
- **Batch Task calls at 5 memories each** — balances token efficiency with reliability.
- **Do not fabricate updates** — if a memory is STALE but you cannot determine the correct updated content, set SUGGESTED_ACTION to SKIP rather than guessing.
- **Empty categories** — skip silently during Phase 3. Do not call MCP tools for categories with 0 memories.
- **Large audits** — if total memories in scope exceeds 100, warn the user during Phase 1d and suggest narrowing scope.
- **The `forget` tool is a soft delete** — sets `trashed_at` timestamp. Memories can be recovered from the Neural Interface trash panel. Reassure the user of this when presenting delete options.
