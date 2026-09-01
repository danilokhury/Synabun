# Schedule — Conversational Schedule Creation

You are in **schedule mode**. The user wants to create a recurring SynaBun schedule with minimal friction. You greet once, let the user describe the automation in plain language, **infer everything you can**, ask **only** for genuine gaps (0–2 quick cards), confirm once, then create the loop-template + schedule (and a group if asked) in **one shot** via REST. The Schedules Studio refreshes itself over WebSocket — no reload needed.

**Input hint**: $ARGUMENTS (optional free-text goal — may be empty).

---

## CRITICAL — Tool Quirks

- All SynaBun MCP calls run **sequentially** (never parallel — one failure cascades).
- `remember` requires `category` and `project` on every call, accepts `tags` + `importance` directly, and returns the full UUID; `reflect` needs the FULL UUID.
- **Interactive choice prompt** = a clickable option card, never plain text:
  - **Claude Code (REQUIRED):** `AskUserQuestion` is deferred — call `ToolSearch` with `select:AskUserQuestion` **before the first card**, then `AskUserQuestion` (2–4 options, ≤4 questions per card).
  - **OpenCode:** native `question` tool. **Codex:** `request_user_input`. Never write choices as plain text.
- **Stop-hook rule:** emit a card **alone** — never chain `Bash`/`Write` in the same turn as an `AskUserQuestion`; wait for the answer first.

## CRITICAL — Model-Override Safety Rules (read before any write)

These exist because group-level launch overrides historically clobbered per-schedule models. Follow them exactly so the schedule stays steerable:

1. Write `model` and `profile` at the **schedule top level** in the POST body — that is exactly where the runtime reads them (`cliModel = schedule.model || group.model || template.model`).
2. **Do NOT send `codexAccountId`** on a schedule or template unless the user explicitly named a ChatGPT/OpenAI account. An account only pins `CODEX_HOME`; it never selects the model and only adds confusion.
3. **Do NOT create a group with `profile`/`model`/`effort`/`codexAccountId` set, and never set a group's launch fields,** unless the user explicitly wants *every* schedule in that group to share one model. Create groups with **name + color only**.
4. Always choose a `model` that exists in the profile's option list (see the table below) so the Studio shows it pre-selected and the user can change it later.

---

## API (use `Bash` curl) — base `http://localhost:3344`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/loop/templates` | GET / POST | List / create automation templates |
| `/api/schedules` | GET / POST | List / create schedules |
| `/api/schedule-groups` | GET / POST | List / create groups |

All bodies + responses are JSON. Capture the returned `id` from each POST.

**Accepted fields (never invent others):**
- **Template** — required `name`, `task`. Optional: `description, context, iterations(=10), maxMinutes(=30), usesBrowser, icon(=🔄), category(=custom), profile, model, effort, mcpProfile, folderId, codexAccountId`. Server generates `id`.
- **Schedule** — required `name`, `templateId`, `cron` (exactly 5 whitespace fields). Optional top-level launch overrides: `profile, model, effort, mcpProfile, usesBrowser, codexAccountId`; plus `groupId, timezone, enabled, dayThemes, overrides`. Only `{iterations, maxMinutes}` go inside `overrides{}`.
- **Group** — required `name`. Optional `color`. Returns `id` = `sg_…`.

**Vocabularies:**
- CLI profiles: `claude-code`, `codex`, `gemini`, `opencode`.
- Default model per profile: `claude-code → claude-sonnet-4-6` · `codex → gpt-5.4-mini` · `gemini → gemini-2.5-pro` · `opencode → null` (last-used).
- Categories (only these): `social`, `productivity`, `monitoring`, `custom`.
- Icon keys: `twitter, x, instagram, facebook, linkedin, tiktok, youtube, whatsapp, discord, search, research, chart, mail, globe, monitor, code, pencil, chat, refresh, brain, clock, claude, openai, gemini, leonardo, pin, sparkle`.

---

## Phase 0 — Quick Boot (no card)

Sequentially, quietly:
1. `recall` query `"schedule loop template cadence platform"` `limit:5` — surface reusable patterns/templates.
2. One `Bash` block fetching all three lists for inference + dedup:
   ```bash
   curl -s http://localhost:3344/api/loop/templates;   echo;
   curl -s http://localhost:3344/api/schedule-groups;  echo;
   curl -s http://localhost:3344/api/schedules
   ```
   Cache as `$TEMPLATES`, `$GROUPS`, `$SCHEDULES`.
3. Detect timezone: `readlink /etc/localtime | sed -E 's|.*/zoneinfo/||'` — fallback `America/Sao_Paulo`.

Then: if `$ARGUMENTS` already describes a goal, skip the greeting and go to **Phase 1**. Otherwise print exactly one line and **stop, awaiting the user's free-text reply**:

> Sure — what do you need scheduled?

## Phase 1 — Capture & Infer (no card)

Read the user's free-text description and infer **every** field using the heuristics table below — this is plain reasoning, not a question:
- **name** — short, human (e.g. "CP GSC Daily Indexing").
- **template** — fuzzy-match the goal against `$TEMPLATES` (name+description+task). Strong match → **reuse** its `templateId`, create no template. Else draft a new template `task` block internally: goal sentence, platform/context, output rules, and a closing instruction telling the loop AI to `remember` its result each run.
- **usesBrowser, icon, category** — from platform/intent cues.
- **cron** — from the cadence phrase.
- **profile / model** — default `claude-code` / `claude-sonnet-4-6` unless the text implies a CLI (e.g. "use Codex", "cheap/fast model") or an existing group/template convention says otherwise.
- **effort** — default unset (off).
- **group** — if the user names an existing group, map to its `groupId`. If they ask for a new group, plan a create with **name + color only**. If unmentioned → `groupId: null` (Ungrouped).

Hold the three draft payloads in memory.

## Phase 2 — Targeted Gaps (0–2 cards, conditional)

Fire an interactive card **only** for genuinely ambiguous/critical fields. **At most one card**, bundling up to ~3 questions inside it. Skip this phase entirely when you can infer confidently. Ask only when:
- **Cadence** — no time/frequency cue at all in the text.
- **Platform/Browser** — the task clearly needs a site but none is named.
- **Profile/Model** — the user signalled the model matters but didn't name one.
- **Group** — ambiguous between an existing group and ungrouped.

First option of every question is the recommended one (append " (Recommended)"). Emit the card alone; wait.

## Phase 3 — Single Confirm Card (the only guaranteed card)

One interactive card. Question text (use `\n` line breaks):

```
Ready to create:

Name: <name>
Automation: <template name> (<new|reuse>)
Cron: <expr>  (<human description>)
Group: <group name|Ungrouped>
CLI: <profile> · Model: <model> · Think: <effort>
Browser: <yes|no>

Create it?
```
Header "Confirm" · options (single-select): **Create it (Recommended)** · **Tweak it** ("change a field first") · **Cancel**.
- "Tweak it" → ask one open follow-up for which field, patch the draft, re-render this card.
- "Cancel" → stop; tell the user nothing was created.

## Phase 4 — Execute (one shot, sequential)

In dependency order. After each curl, if the response is non-2xx or contains `error`, stop and surface it via a retry/cancel card.

**4a. Group — only if the user wants a NEW group** (name + color only — Safety Rule 3):
```bash
curl -s -X POST http://localhost:3344/api/schedule-groups \
  -H 'Content-Type: application/json' \
  -d '{"name":"<group name>","color":"#4fc3f7"}'
```
Capture `id` → `$GROUP_ID`.

**4b. Template — only if NOT reusing one:**
```bash
curl -s -X POST http://localhost:3344/api/loop/templates \
  -H 'Content-Type: application/json' \
  -d '{"name":"<name>","description":"<one-line>","task":"<full task block>","iterations":<n|10>,"maxMinutes":<n|30>,"usesBrowser":<true|false>,"icon":"<icon>","category":"<social|productivity|monitoring|custom>","profile":"<profile>","model":"<model>","effort":<"off"|null>,"mcpProfile":<"full"|null>}'
```
Capture `id` → `$TEMPLATE_ID`. (No `codexAccountId` unless the user named one.)

**4c. Schedule — always:**
```bash
curl -s -X POST http://localhost:3344/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"name":"<name>","templateId":"<$TEMPLATE_ID|reused id>","cron":"<5-field>","timezone":"<IANA>","enabled":true,"groupId":<"$GROUP_ID"|"<existing>"|null>,"profile":"<profile>","model":"<model>","effort":<"off"|null>,"usesBrowser":<true|false>,"overrides":{"iterations":<n>,"maxMinutes":<n>},"dayThemes":{}}'
```
Rules baked in: `model`/`profile` **top level**; `{iterations,maxMinutes}` in `overrides`; **no `codexAccountId`** unless explicitly requested.

## Phase 5 — Remember (one MCP call)

`remember` `category:"schedules"` (if missing, `category` action `create` child under parent `synabun`), `project:"synabun"`, `importance:6`, `tags:["schedule","<platform/topic>","conversational-created"]`, content = 4–6 lines: name, template id, schedule id, cron, group, profile/model, date.

## Phase 6 — Done (one line)

> ✓ Schedule **`<name>`** created (`<model>`, `<cron-human>`). The Schedules Studio refreshed — open **Automations → Schedules** to view or change any field; the model is editable per-schedule there.

---

## Inference Heuristics (free-text cue → fields)

| Cue (case-insensitive) | icon | category | usesBrowser |
|---|---|---|---|
| twitter / tweet / x.com / @handle | `twitter` | social | true |
| instagram / ig / reels | `instagram` | social | true |
| facebook / fb / fb group | `facebook` | social | true |
| linkedin / li | `linkedin` | social | true |
| tiktok | `tiktok` | social | true |
| youtube / video upload | `youtube` | social | true |
| whatsapp · discord | `whatsapp`·`discord` | social | true |
| google / gsc / search console / indexing / seo | `globe` | productivity | true |
| email / gmail / inbox | `mail` | productivity | false (unless web UI) |
| research / scrape / lead / discover / monitor signals | `research`/`search` | productivity | true if a site is opened |
| write article / publish / blog / generate post/report | `pencil`/`globe` | productivity | depends on publish target |
| watch / alert me / check status / uptime / monitor X | `monitor`/`chart` | monitoring | false unless a page is checked |
| code / repo / build / PR / commit / deploy | `code` | productivity | false |
| anything unclear | `refresh` | custom | false |

**Browser rule:** `true` whenever the task must open a website/app (social, GSC, any UI); `false` for pure-LLM / API / filesystem / shell tasks.

**Cadence phrase → cron:**

| Phrase | cron |
|---|---|
| every morning / daily ~9am | `0 9 * * *` |
| twice a day | `0 9,18 * * *` |
| 3× daily | `0 9,14,19 * * *` |
| every hour | `0 * * * *` |
| every 3 hours | `0 */3 * * *` |
| every N hours | `0 */N * * *` |
| weekdays at 9 | `0 9 * * 1-5` |
| weekly Monday 9am | `0 9 * * 1` |

Always validate a custom cron has exactly 5 whitespace fields; re-ask cadence only if invalid.

---

## Failure Handling

- HTTP non-2xx → one card: **Retry** · **Edit and retry** · **Cancel**.
- Bad cron → re-ask cadence only; do not advance.
- Network down → "Neural Interface unreachable on `:3344` — is the dev server running?" then stop.

## Guidelines

- **≤3 stop-the-turn cards total** (optional Phase 2, the Phase 3 confirm, plus at most one error/tweak). Default to inference over asking.
- Never invent template/schedule fields; always quote IDs; IANA timezones only (no "EST").
- Re-state the Model-Override Safety Rules to yourself before Phase 4: schedule `model`/`profile` top-level; no `codexAccountId` unless named; groups are name+color only unless the user wants a shared group model.
