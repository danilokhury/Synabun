# Changelog — Auto-Generate CHANGELOG.md Entries

You are now in **changelog mode**. Your job is to analyze the current session's work — conversation context, git changes, and code modifications — then generate properly formatted CHANGELOG.md entries and write them to the project's changelog file.

**Input**: $ARGUMENTS

- If the input is empty → analyze the full session context and all recent git changes
- If the input contains text → use it as a focus hint (e.g., "changelog the auth refactor" → focus on that specific work within the session)

## CRITICAL: SynaBun MCP Tool Quirks

- Make ALL SynaBun MCP calls **sequentially** (never in parallel — one failure cascades).
- `remember` accepts `tags` and `importance` directly and returns the full UUID.
- `reflect` requires the **FULL UUID**. Use the UUID returned by `remember`, or `recall` to find existing memories.

---

## Process

Execute these phases in order. Do NOT skip phases or combine them.

---

### Phase 1 — Context Gathering

> **SCOPE RULE:** Only document work performed in THIS session. Git history contains commits from other sessions — you MUST use `$SESSION_START_COMMIT` to filter. If a git change doesn't match anything in your conversation context, **exclude it**.

Analyze all available information about the session's work:

1. **Conversation analysis** — Scan the entire conversation history in your context window. Extract all work performed: features added, bugs fixed, things refactored/changed, configuration modifications, file creation/deletion. Note specific function names, file paths, and technical details. **This is your primary source of truth.**

2. **Session baseline** — Search your conversation context for a line matching `Session start commit:` followed by a commit hash. Store it as `$SESSION_START_COMMIT`. If not found, fall back to `git log --oneline -1 --before='8 hours ago' --format='%H'` as a rough approximation.

3. **Git state** — Run these Bash commands to understand the actual code changes **scoped to this session**:
   - `git rev-parse --show-toplevel` — determine the project root. Store as `$PROJECT_ROOT`.
   - `git diff --stat` — see uncommitted file changes. Cross-reference against conversation context — only include changes you actually made in this session.
   - `git log --oneline $SESSION_START_COMMIT..HEAD` — see only commits made since this session started. Do NOT use `git log -20` or any other unscoped log command.
   - `git diff $SESSION_START_COMMIT --stat` — aggregate changes since session start.

4. **Focus filtering** — If `$ARGUMENTS` contains a focus hint, narrow the analysis to only changes related to that topic. Ignore unrelated work.

5. **Cross-check** — Before proceeding, verify every identified change exists in BOTH the conversation context AND the session-scoped git output. Remove anything that only appears in git but was not discussed or worked on in this conversation.

6. **Date** — Determine today's date in `YYYY-MM-DD` format (from conversation context or `date +%Y-%m-%d`).

**Output to user:** A brief summary of what was found:

```
Found [N] changes to document:
- [N] additions, [N] fixes, [N] modifications
- [N] files touched
```

---

### Phase 2 — Categorize & Draft

Before drafting, do a final scope check: remove any item from your list that documents work you did NOT perform in this conversation. Git commits from other sessions must not appear in the changelog output.

Categorize each piece of work into exactly one section type:

- **Added** — New features, new capabilities, new files/systems that did not exist before
- **Fixed** — Bug fixes, corrections to existing behavior, things that were broken and now work
- **Changed** — Refactors, modifications to existing behavior, config changes, dependency updates, UI polish

Draft entries following the project's exact CHANGELOG.md format:

```markdown
### Added — Descriptive Feature Name
- **Bold title** — Description with specific technical detail. Include `functionName()`, `path/to/file.ts`, actual behavior changes. Be precise — someone reading this should understand what changed without looking at code.
  - Sub-bullet for additional detail when an entry covers multiple related changes

### Fixed — Descriptive Bug Name (Scope)
- **What was broken** — What the bug was, root cause, and how it was fixed. Reference actual code constructs.

### Changed — Descriptive Modification Name
- **What changed** — What the old behavior was, what the new behavior is, and why.
```

**Format rules:**
- Section header: `### Added/Fixed/Changed — Descriptive Name`
- Entry format: `- **Bold title** — Description` (em dash ` — `, not hyphen)
- Sub-entries: 2-space indent, same bullet format
- Inline backticks for code references (`functionName()`, `path/to/file.ts`, `configKey`)
- No version numbers — use date-only headers
- Group related changes under a single `### Type — Name` header with multiple entries
- Unrelated changes of the same type get separate `### Type — Name` headers (e.g., two unrelated features each get their own `### Added — Name` section)

**Do NOT output anything to the user during this phase** — drafting is internal.

---

### Phase 3 — Review & Confirm

Present the drafted entries to the user:

```
══════════════════════════════════════════
       AUTO CHANGELOG
══════════════════════════════════════════
 Date:     [YYYY-MM-DD]
 Project:  [project root basename]
 Entries:  [N] Added, [N] Fixed, [N] Changed
══════════════════════════════════════════
```

Then output the full drafted entries exactly as they would appear in CHANGELOG.md — the `### Added/Fixed/Changed` sections with all bullet points.

Then use `AskUserQuestion` with:

- **Save as-is** — "Write these entries to CHANGELOG.md"
- **Edit first** — "I want to adjust entries before saving"
- **Cancel** — "Don't save anything"

**If user picks "Edit first":** Ask what they want to change (free text). Incorporate feedback, re-draft, and present again. Loop until satisfied or cancelled.

**If user picks "Cancel":** End with a brief message. Do not write anything.

---

### Phase 4 — Write to File

Once the user confirms:

1. Set the changelog path: `$PROJECT_ROOT/CHANGELOG.md`

2. Check if the file exists by attempting to `Read` it.

**If CHANGELOG.md does NOT exist:**

Create a new file using the `Write` tool:

```markdown
# Project Changelog

## [YYYY-MM-DD]

[all drafted entries]
```

**If CHANGELOG.md EXISTS:**

Read the entire file, then determine the insertion point:

- **Case A — Today's date section already exists** (a `## YYYY-MM-DD` line matching today's date is found):
  - Find the end of today's date block (just before the next `## ` line or end of file).
  - Insert the new `### Type — Name` sections at the end of today's block, before the next date header.
  - Do NOT duplicate entries — if a `### Added — Same Name` already exists under today's date with the same content, skip it.

- **Case B — Today's date section does NOT exist:**
  - Insert a new `## YYYY-MM-DD` section immediately after the first `# ` title line (and any blank line after it), before any existing `## ` date entries.
  - Place all drafted entries under the new date header.

Use the `Edit` tool for modifications to existing files.

After writing, confirm to the user:

```
══════════════════════════════════════════
 Changelog updated successfully.
 File:     [path]
 Date:     [YYYY-MM-DD]
 Entries:  [count] written
══════════════════════════════════════════
```

---

### Phase 5 — Memory (Auto)

Silently call `remember` with:
- `content`: Brief summary of what was added to the changelog (date, section types, one-line per entry)
- `category`: `conversations`
- `project`: current project name
- `importance`: 5
- `tags`: `["changelog", "documentation", "session-summary"]`
- `related_files`: `["CHANGELOG.md"]`

Do NOT use `AskUserQuestion` here — auto-remember is mandatory per project rules.

---

## Guidelines

- **Be specific, not generic** — "Added Instagram browser extractor tools (5 tools)" not "Added social media support". Every entry should mention actual code constructs.
- **Match the existing tone** — Read the existing CHANGELOG.md entries for the voice. This project uses detailed, technical entries with inline backticks, not marketing copy.
- **Em dashes, not hyphens** — Use ` — ` (space-em-dash-space) as the separator between bold titles and descriptions.
- **One concept per entry** — Don't combine unrelated changes. A bug fix and a feature addition are separate entries even if they touched the same file.
- **Sub-bullets for depth** — When a single entry has multiple related sub-items (e.g., 5 new tools), use 2-space-indented sub-bullets rather than cramming everything into one line.
- **Group related changes** — Multiple changes that are part of the same feature go under a single `### Added — Feature Name` header with multiple `- **Bold** — Description` entries.
- **Separate unrelated changes** — Two unrelated features both get their own `### Added — Name` section headers, even on the same day.
- **Don't duplicate** — If today's date section already has entries for the same work, skip those entries.
- **Conversation is truth (HARD RULE)** — NEVER include changes that were not discussed or worked on in this conversation, even if they appear in git history. Git is used only to enrich detail for work you already know about from the conversation. If a commit or diff doesn't match conversation context, it belongs to another session — skip it.
- **Sequential MCP calls only** — Never call two SynaBun tools in the same parallel batch.
