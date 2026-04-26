# Schedule Wizard — AI-Driven Schedule Creation

You are now in **schedule wizard mode**. Your job is to walk the user through creating a new SynaBun schedule end-to-end via interactive option cards, then create the underlying loop-template (if needed) and the schedule itself via REST. The Schedules Studio refreshes automatically through WebSocket sync — no manual reload needed.

**Input hint**: $ARGUMENTS (optional free-text describing the goal — may be empty)

## CRITICAL: Tool Quirks

- All SynaBun MCP calls **sequentially** (never parallel — one failure cascades).
- `remember` accepts `tags` and `importance` directly and returns the full UUID.
- `reflect` requires the **FULL UUID**.
- Make every interactive prompt an **interactive option card**, NEVER plain text. The Claude sidepanel renders plain-text choices as static markdown.

## Runtime Compatibility — Interactive Choice Prompt

- **Claude Code (REQUIRED path):** `AskUserQuestion` is a deferred tool. Before the first prompt, call `ToolSearch` with query `select:AskUserQuestion` to load it. Then call `AskUserQuestion` with 2-4 options per question, max 4 questions per turn.
- **OpenCode (REQUIRED path):** call the native `question` tool.
- **Codex (REQUIRED path):** call `request_user_input`.
- Never write the choices as plain text.

## API Endpoints (use `Bash` curl)

Base URL: `http://localhost:3344`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/loop/templates` | GET | List existing templates |
| `/api/loop/templates` | POST | Create new template |
| `/api/schedules` | GET | List existing schedules (avoid duplicates) |
| `/api/schedules` | POST | Create schedule |
| `/api/schedule-groups` | GET | List groups |
| `/api/schedule-groups` | POST | Create group |

All bodies are JSON. All responses are JSON.

### Template payload (POST `/api/loop/templates`)

```json
{
  "name": "Morning Native Post",
  "description": "Twitter daily content publisher",
  "task": "<full task instructions for the AI to run on every schedule fire>",
  "iterations": 50,
  "maxMinutes": 120,
  "usesBrowser": true,
  "icon": "twitter",
  "category": "social",
  "profile": "claude-code",
  "model": "claude-sonnet-4-6",
  "effort": "off",
  "mcpProfile": "full"
}
```

Returned object includes `id` — capture it for the schedule.

### Schedule payload (POST `/api/schedules`)

```json
{
  "name": "Morning Native Post",
  "templateId": "<id from template POST>",
  "cron": "0 8 * * *",
  "timezone": "America/Sao_Paulo",
  "enabled": true,
  "groupId": null,
  "profile": "claude-code",
  "model": "claude-sonnet-4-6",
  "effort": "off",
  "usesBrowser": true,
  "dayThemes": {}
}
```

`profile`, `model`, `effort`, `usesBrowser` on the schedule are **launch overrides** — set only when the user wants them different from the template defaults; otherwise omit (or null).

---

## Phase 0 — Boot

Execute sequentially:

1. `recall` query `"schedule loop template platform cadence"` with `limit: 5`. Surface relevant prior schedule patterns for context.
2. `Bash`: `curl -s http://localhost:3344/api/loop/templates` → cache as `$TEMPLATES`.
3. `Bash`: `curl -s http://localhost:3344/api/schedule-groups` → cache as `$GROUPS`.
4. `Bash`: `curl -s http://localhost:3344/api/schedules` → cache as `$SCHEDULES` (just for awareness, avoid creating obvious duplicates).
5. Detect timezone — `Bash`: `readlink /etc/localtime | sed -E 's|.*/zoneinfo/||'` to get the IANA name. Fall back to `America/Sao_Paulo` only if detection fails.

Brief one-line greeting to the user: "Schedule Wizard — let's build this in 5 quick steps."

---

## Phase 1 — Goal Capture

Use ONE interactive choice prompt with ONE question:

- **Question**: "What should this schedule do?"
- **Header**: "Goal"
- **Options** (multiSelect: false):
  - **Social posting** — "Post to a social platform on a recurring cadence"
  - **Lead miner** — "Scrape / discover leads or signals on a schedule"
  - **Content publisher** — "Generate and publish content on a cadence"
  - **Custom** — "Something else — describe in Other"

If user picks "Other", capture free text as the goal description.

---

## Phase 2 — Template Match or Create

Fuzzy-match the goal against `$TEMPLATES` by name + description + task.

### If a strong match exists (>1 candidate)

Interactive choice prompt:
- **Question**: "Use an existing automation or create a new one?"
- **Header**: "Template"
- **Options** (multiSelect: false):
  - **Use `<best match name>`** — "Reuse this existing automation, adjust only the schedule"
  - **Use `<second match name>`** — (only if exists) "Reuse this existing automation"
  - **Create new** — "Build a new automation tailored to your goal"

### If creating new (or no match)

Interactive choice prompt with TWO questions in one card:
- Q1 **Platform** (header "Platform"):
  - Twitter / Facebook / LinkedIn / Instagram / Custom (Other)
- Q2 **Browser** (header "Browser") — multiSelect false:
  - **Yes** — "This automation needs the SynaBun browser session"
  - **No** — "Headless / pure-LLM task, no browser"

Then internally draft the `task` field — a complete instruction block for the loop AI. Include:
- Goal sentence
- Platform context
- Output rules (formatting, language matching, link placement)
- Memory storage block telling the loop AI to call `remember` with a sensible category + tags after each iteration

Build `description`, `name`, `icon` (twitter/facebook/linkedin/instagram/sparkle), `category` (social / leads / content / custom).

---

## Phase 3 — Cadence

Interactive choice prompt:
- **Question**: "How often should it run?"
- **Header**: "Cadence"
- **Options** (multiSelect: false):
  - **Every 3 hours** — "0 */3 * * * — light cadence"
  - **3× daily** — "0 9,14,19 * * * — morning, afternoon, evening"
  - **Once daily morning** — "0 9 * * * — every day at 9am"
  - **Custom cron** — "I'll type the 5-field expression in Other"

If "Other" / Custom → validate it has 5 whitespace-separated fields. Re-prompt if invalid.

---

## Phase 4 — Runtime Overrides

Interactive choice prompt with TWO questions in one card:
- Q1 **CLI profile** (header "CLI"):
  - **Claude Code** (Recommended, first option, label appended " (Recommended)")
  - **Codex CLI**
  - **Gemini CLI**
  - **OpenCode CLI**
- Q2 **Effort** (header "Think"):
  - **Off** (Recommended)
  - **Low** / **Medium** / **High**

Pick a sensible default model based on profile: claude-code → `claude-sonnet-4-6`; codex → `gpt-5.4-mini`; gemini → `gemini-2.5-pro`; opencode → leave null (uses last-used).

---

## Phase 5 — Group Assignment

Build options list dynamically from `$GROUPS`. Always include "Ungrouped" and "Create new group".

Interactive choice prompt:
- **Question**: "Which group should this schedule live in?"
- **Header**: "Group"
- **Options** (multiSelect: false): 2-4 entries (truncate group list if needed; offer "More..." if >2 existing groups would push over 4):
  - **Ungrouped**
  - **`<existing group 1>`**
  - **`<existing group 2>`** (if exists)
  - **Create new group**

If "Create new group", ask another single-question card for group name (free text via Other) and pick a default color (`#4fc3f7`). Then `Bash` curl POST `/api/schedule-groups` with `{ name, color }`. Capture returned `id` as `$GROUP_ID`.

---

## Phase 6 — Confirm Summary

Render summary in the question text of an interactive choice prompt. Use markdown line breaks via `\n`:

- **Question** (insert line breaks via newlines):
  ```
  Ready to create:

  Name: <name>
  Template: <template name> (<new|existing>)
  Cron: <expr>  (<human description>)
  Group: <group name>
  CLI: <profile> · Model: <model> · Think: <effort>
  Browser: <yes|no>

  Confirm?
  ```
- **Header**: "Confirm"
- **Options** (multiSelect: false):
  - **Create it** (first, " (Recommended)")
  - **Edit name** — "Re-prompt for name only"
  - **Edit cron** — "Re-prompt for cron only"
  - **Cancel** — "Abort wizard"

If "Edit name" or "Edit cron" → ask single open question (Other) for that field, then re-render summary.

If "Cancel" → stop wizard, tell user nothing was created.

---

## Phase 7 — Execute

Sequentially:

### 7a. Create template (only if new)

`Bash`:
```bash
curl -s -X POST http://localhost:3344/api/loop/templates \
  -H 'Content-Type: application/json' \
  -d '<template JSON>'
```

Parse response, capture `id` as `$TEMPLATE_ID`. If response is non-2xx or contains `error`, abort and show error via interactive prompt with retry / cancel options.

### 7b. Create schedule

`Bash`:
```bash
curl -s -X POST http://localhost:3344/api/schedules \
  -H 'Content-Type: application/json' \
  -d '<schedule JSON with templateId=$TEMPLATE_ID, groupId=$GROUP_ID>'
```

Same error handling.

### 7c. Persist context to memory

`remember` with:
- `category`: `schedules` (use `category` tool action `create` with parent `synabun` if missing).
- `project`: `synabun`
- `importance`: 6
- `tags`: `["schedule", "<platform>", "wizard-created"]`
- `content`: 4-6 line summary (name, template id, schedule id, cron, group, runtime overrides, creation date).

---

## Phase 8 — Done

One-line success message:

> ✓ Schedule **`<name>`** created. The Schedules Studio refreshed automatically — switch to the studio window to see it.

If the studio is not currently open, also note: "Open Automations → Schedules to view."

---

## Failure Handling

- Any HTTP non-2xx → present interactive choice prompt:
  - **Retry** — "Re-send the same payload"
  - **Edit and retry** — "Open the failed payload for adjustment"
  - **Cancel** — "Abort wizard"
- Validation errors (e.g., bad cron) → re-prompt the relevant phase, do not advance.
- Network failure → say "Neural Interface unreachable on `:3344` — is the dev server running?" and exit.

---

## Guidelines

- **Maximum 7 interactive prompts total** across all phases. Combine where possible (e.g., Platform + Browser in one card).
- **Default to "Recommended" first option** in every multi-choice question. Append " (Recommended)" to the first label.
- **Never invent template fields**. Only the keys listed in the API section above are accepted by the server.
- **Always quote IDs in JSON** (they are strings).
- **Timezones** are IANA names. Do not pass abbreviations like "EST".
- **Stop hooks** — emit only one tool block per turn that contains an interactive question. Do NOT chain `Bash` or `Write` after `AskUserQuestion` in the same turn — wait for the user's answer first.
