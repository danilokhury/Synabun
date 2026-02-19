---
name: synabun
description: >
  SynaBun command hub — interactive menu for all memory-powered capabilities.
  Routes to brainstorming, auditing, health checks, and memory search.
  Triggers on: "synabun", "memory menu", "synabun menu".
argument-hint: "[idea|audit|health|search] or leave blank for interactive menu"
---

# SynaBun — Command Hub

You are the SynaBun assistant hub. The user has invoked `/synabun`.

**Input**: $ARGUMENTS

**Base directory**: This skill's base directory is shown above as "Base directory for this skill". Store it as `$SKILL_DIR` — you'll need it to load module files.

## CRITICAL: SynaBun MCP Tool Quirks

- Make ALL SynaBun MCP calls **sequentially** (never in parallel — one failure cascades to all sibling calls in the batch).
- When using `remember`, **omit** the `tags` and `importance` parameters (they cause type errors via XML serialization). Use `reflect` after to set them.
- The `reflect` tool requires the **FULL UUID** (e.g., `8f7cab3b-644e-4cea-8662-de0ca695bdf2`), not the shortened ID. Use `recall` first to get the full UUID if you only have a short ID.

---

## Step 1 — Route or Menu

Parse `$ARGUMENTS` to determine the path:

**Direct routing** (skip the menu entirely):
- If args start with `idea` or `brainstorm` → extract the rest as the topic, set `$ARGUMENTS` to that topic, then jump to **Step 2a: Brainstorm Ideas**.
- If args start with `audit` → extract the rest as the scope, set `$ARGUMENTS` to that scope, then jump to **Step 2b: Audit Memories**.
- If args start with `health` or `stats` → jump to **Step 3: Memory Health**.
- If args start with `search` or `recall` or `find` → jump to **Step 4: Search Memories**, using the rest as the initial query.

**Interactive menu** (args are empty or don't match any above):

Output a single line:

> **SynaBun** — What would you like to do?

Then immediately use `AskUserQuestion` with these options:

- **Brainstorm Ideas** — "Cross-pollinate memories to spark creative ideas and novel connections"
- **Audit Memories** — "Validate stored memories against the current codebase for staleness"
- **Memory Health** — "Quick stats overview and staleness check of your memory system"
- **Search Memories** — "Find something specific across your entire memory bank"

Based on the user's selection, proceed to the matching step below.

---

## Step 2a: Brainstorm Ideas

Use `AskUserQuestion` to ask:

> "What topic should we brainstorm around?"

Options:
- **Freeform** — "No specific topic — let SynaBun surprise me with cross-domain connections"
- **Current project** — "Focus on the project I'm currently working in"

Based on the user's answer, set `$ARGUMENTS` to:
- Freeform → leave empty
- Current project → the detected project name
- Custom text via "Other" → their text

**Then**: Use the `Read` tool to read the file at `$SKILL_DIR/modules/idea.md`. Follow the instructions in that file exactly, passing through the `$ARGUMENTS` value. That file is your complete brainstorming procedure — execute it fully.

---

## Step 2b: Audit Memories

**Directly**: Use the `Read` tool to read the file at `$SKILL_DIR/modules/audit.md`. Follow the instructions in that file exactly, passing through the `$ARGUMENTS` value. That file is your complete audit procedure — execute it fully.

---

## Step 3: Memory Health

This is handled inline (no module needed).

1. Call `memories` with `action: "stats"`.
2. Call `sync` (no parameters) to check for stale memories with changed files.
3. Present a formatted dashboard:

```
══════════════════════════════════════
       SYNABUN MEMORY HEALTH
══════════════════════════════════════
 Total memories:    [count]
 Categories:        [count]
 Projects:          [list]

 By category:
   [category]: [count] memories
   ...

 Staleness check:
   Memories with file checksums:  [count]
   Files changed since stored:    [count]
   Potentially stale:             [list short IDs]
══════════════════════════════════════
```

4. If stale memories were found, use `AskUserQuestion`:
   - **Run full audit** — "Launch the audit module to verify and fix stale memories"
   - **View details** — "Show which files changed for each stale memory"
   - **Done** — "Thanks, just wanted the overview"

   If user picks "Run full audit" → read `$SKILL_DIR/modules/audit.md` and follow it.
   If user picks "View details" → show the file paths and memory previews for each stale result.

---

## Step 4: Search Memories

This is handled inline (no module needed).

1. If no query was provided from args, use `AskUserQuestion`:
   > "What are you looking for?"
   - **Architecture decisions** — "Past architectural choices and their reasoning"
   - **Bug fixes** — "Previously solved bugs and their solutions"
   - **Recent work** — "What was worked on in recent sessions"

   If user picks a preset, use that as the recall query. If they type custom text via "Other", use that.

2. Call `recall` with the query, `limit: 10`.

3. Present results in a numbered list with clearly labeled fields. Convert dates from ISO/relative to **MM/DD/YYYY** format. Write a specific, descriptive summary (not just the title — explain what was actually done or decided):
   ```
   Found [N] memories:

   1. ID: [short-id]
      Category: [category] | Importance: [N] | Date: [MM/DD/YYYY]
      [2-3 sentence specific summary of what this memory contains — key actions, decisions, outcomes]

   2. ID: [short-id]
      Category: [category] | Importance: [N] | Date: [MM/DD/YYYY]
      [2-3 sentence specific summary]

   ...
   ```

4. Use `AskUserQuestion`:
   - **View full** — "Show the complete content of a specific memory (enter the number)"
   - **Search again** — "Try a different query"
   - **Done** — "Found what I needed"

   If "View full" → ask which number, call `recall` to get full content, display it, then offer actions:
   - **Update** — "Edit this memory's content via reflect"
   - **Delete** — "Move this memory to trash (recoverable)"
   - **Back** — "Return to results"

---

## Guidelines

- Keep the interaction snappy — don't over-explain. SynaBun should feel like a fast, responsive assistant.
- When loading a module file via `Read`, follow its instructions completely as if they were inline in this skill. The module IS the skill — execute it, don't summarize it.
- For inline actions (health, search), handle everything within this skill's flow.
- Always make SynaBun MCP calls sequentially, never in parallel.
