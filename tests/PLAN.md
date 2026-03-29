# SynaBun Full Test Suite — Changelog Coverage (Mar 17-27, 2026)

## Overview

Two deliverables:
1. **`tests/manual-qa.md`** — Manual QA checklist (~99 test cases, 10 sections)
2. **`tests/automated/`** — Node.js test scripts (~60 automated tests)

Organized by **functional area**.

---

## Part 1: Manual QA Checklist (`tests/manual-qa.md`)

Each test case: changelog ref, prerequisites, steps, expected result, `[ ]` checkbox.

### Sections

#### 1. Server API & Backend (18 tests)
- `POST /api/hook-recall` — returns memories, respects limit/min_score, graceful degradation
- `GET /api/recall-impact` — avg_tags_len, avg_files_len, sessionStats
- Session History — 200K context window, per-turn usage
- Content negotiation — `/api/browser/sessions/:id/markdown`, `/api/fetch-markdown`
- Image Gallery API — CRUD, favorites, 24h cleanup
- Cron scheduler — CRUD, parsing, timezone, missed-fire
- Agent system — launch/list/stop/remove, 200 max turns
- Auto Backup — config CRUD, trigger, atomic write
- Multi-browser tabs — 4 REST endpoints
- Schedules — 6 REST endpoints
- Loop caps — maxMinutes=480, totalIterations=200

#### 2. Hook System (12 tests)
- prompt-submit auto-recall (top 3, score>=0.4, skip boot, skip loops)
- stop hook user learning (CHECK 2.5, bundled, 1-retry)
- isWaitingForUser() guard
- post-remember flag clearing
- post-plan content matching (not mtime)
- session-start loop scoping (own terminal)
- prompt-submit loop claim by terminalSessionId
- Response ordering summary suffix
- Loop pending-claim server-side
- Loop history deletion

#### 3. Claude Panel (14 tests)
- AskUserQuestion dedup
- File attachments (images, file-only sends, chips, BTW, visual feedback)
- Batched AskUserQuestion (toggle, counter, text input, gate)
- Context gauge (no inflation, re-render, tooltip)
- Shift+Tab plan mode
- Session button group
- Plan file permission
- Edit Plan in Code Editor
- Changelog "Edit first"
- Edit cancel re-enables
- Session isolation (per-tab)
- Standalone sessionStorage
- Attach accepts images

#### 4. Automation Studio (10 tests)
- Inline launch panel
- Panel closes after launch
- Icon picker (13 icons)
- Sidebar scroll preserved
- Quick Timer (select-then-go, no dupes)
- Schedule editor (18 presets, day themes)
- Launch destination toggle
- Agent DOM reads before destroy
- Agent boot (no CLAUDE.md hijack)
- Multi-loop coexistence

#### 5. Browser / Screencast (12 tests)
- Close button after reconnection
- Resize decoupled
- 30fps cap
- Pause/resume on minimize
- Focus throttle (~2fps)
- Idle timeout (5min)
- Re-launch (zombie, reconnect, guard)
- Multi-browser isolation
- Multi-tab CRUD
- Freeze fix (createFrameRenderer)
- Server backpressure
- --allowedTools comma join

#### 6. Terminal (5 tests)
- Context menu z-index
- Viewport clamping
- Image paste to PTY
- Clipboard LAN fallback
- Resize debounce

#### 7. Whiteboard (7 tests)
- List persist on reload
- Move handle
- Shape picker
- Circle ellipse
- Context menu z-index
- Send to terminal fallback
- Move positioning

#### 8. Settings & UI (8 tests)
- Recall presets
- Recall redesign
- Notifications tab
- Safari PWA
- Database polish
- Token estimation
- Window borders
- Window close (ESC only)

#### 9. Visual / CSS (9 tests)
- Toolbar modernization
- Header modernization
- Focus buttons removed
- Page margins
- Backdrop toggle
- Offline page
- Editor line highlight
- Dropdowns z-index
- Focus glow

#### 10. Leonardo & Integrations (5 tests)
- Leonardo browser-only
- LinkedIn Jobs extractor
- browser_content markdown
- Screenshot cross-platform
- Images in data/images/

---

## Part 2: Automated Tests

Pattern: standalone Node.js scripts (no framework — matches existing `test-user-learning.mjs`). Uses native `fetch`, `child_process`, `fs`.

### A. `tests/automated/test-utils.mjs` — Shared Helpers
- `assert(condition, name)` with colored pass/fail
- `httpGet(path)`, `httpPost(path, body)`, `httpPut(path, body)`, `httpDelete(path)` — fetch wrappers against NI server
- `runHook(scriptPath, stdinData)` — spawns hook as child process, returns parsed output
- `writeFlag(path, data)`, `readFlag(path)`, `cleanup(path)` — test fixture helpers
- Color constants, summary reporter

### B. `tests/automated/api-endpoints.test.mjs` (~25 tests)
Requires NI server running.

- `POST /api/hook-recall` — valid query returns results array
- `POST /api/hook-recall` — empty query returns `{ results: [] }`
- `POST /api/hook-recall` — respects limit parameter
- `GET /api/recall-impact` — returns object with avg_tags_len, avg_files_len, sessionStats
- `GET /api/images` — returns array with type metadata
- `POST /api/images/favorite` — toggles favorite, returns updated state
- `GET /api/schedules` — returns schedules array
- `POST /api/schedules` — creates schedule, validates cron
- `POST /api/schedules` — rejects invalid cron expression
- `PUT /api/schedules/:id` — updates, recomputes nextRun
- `DELETE /api/schedules/:id` — removes schedule
- `POST /api/schedules/:id/test` — fires immediately, returns result
- `GET /api/agents` — returns agents array
- `GET /api/system/auto-backup` — returns config object
- `PUT /api/system/auto-backup` — persists config changes
- `POST /api/fetch-markdown` — returns markdown from URL
- `GET /api/display-settings` — returns recallDefaults + profile
- `PUT /api/display-settings` — persists recall profile
- `PUT /api/display-settings` — round-trips all recallDefaults fields
- `GET /api/claude-code/sessions/:id/messages` — uses 200K context window
- `GET /api/whiteboard` — returns elements array
- `POST /api/whiteboard/elements` — creates element, returns id
- `DELETE /api/whiteboard/elements/:id` — removes element
- `/api/loop/active` — returns loops array (not single object)

### C. `tests/automated/hook-tests.test.mjs` (~20 tests)
Standalone — spawns hooks as child processes.

- prompt-submit: substantive prompt → additionalContext contains `=== SynaBun: Related Memories ===`
- prompt-submit: first message (session boot) → no memory injection
- prompt-submit: loop session (SYNABUN_LOOP env) → no memory injection
- prompt-submit: NI server down → completes within 3s, no crash, no injection
- prompt-submit: short/skip pattern prompts ("yes", "ok") → no injection
- stop hook: task memory + user learning pending → single combined block with both keywords
- stop hook: only user learning pending → blocks once, allows after 1 retry
- stop hook: isWaitingForUser phrases ("please attach", "upload the file") → no block
- stop hook: response ordering → block reason contains summary suffix text
- stop hook: no pending obligations → allows (exit 0, no additionalContext block)
- post-plan: ExitPlanMode with plan content → finds correct plan by content match
- post-plan: empty tool_response → falls back to mtime-based selection
- session-start: mismatched terminalSessionId → no loop detection, normal greeting
- session-start: matching terminalSessionId → loop detected, no greeting
- prompt-submit: loop claim filters by terminalSessionId (won't steal other session's loop)
- prompt-submit: recall nudge fires at threshold (message 3)
- prompt-submit: recall nudge does NOT fire below threshold

### D. `tests/automated/cron-parser.test.mjs` (~15 tests)
Standalone — imports cron functions from server.js (extracted or eval'd).

- `parseCronField('*', 0, 59)` → matches all 0-59
- `parseCronField('5', 0, 59)` → matches only [5]
- `parseCronField('1-5', 0, 59)` → matches [1,2,3,4,5]
- `parseCronField('1,3,5', 0, 59)` → matches [1,3,5]
- `parseCronField('*/15', 0, 59)` → matches [0,15,30,45]
- `parseCronField('*/2', 0, 23)` → matches [0,2,4,...,22]
- `cronMatchesDate('* * * * *', date)` → always true
- `cronMatchesDate('30 9 * * *', 9:30am)` → true
- `cronMatchesDate('30 9 * * *', 10:00am)` → false
- `cronMatchesDate('0 */2 * * *', 4:00am)` → true
- `cronMatchesDate('0 9 * * 1-5', weekday 9am)` → true
- `cronMatchesDate('0 9 * * 1-5', saturday 9am)` → false
- `getNextCronRun('0 9 * * *')` → next 9:00am
- `describeCron('*/15 * * * *')` → contains "15 minutes"
- `describeCron('0 9 * * 1-5')` → contains "weekday" or "Mon-Fri"

### E. `tests/automated/run-all.mjs` — Runner
- Imports and runs each test file sequentially
- Aggregates pass/fail counts
- Prints summary with total passed/failed/skipped
- Exits with code 1 if any failures

---

## File Structure

```
tests/
├── PLAN.md                               # This plan
├── manual-qa.md                          # Full manual QA checklist
└── automated/
    ├── run-all.mjs                       # Runner (node tests/automated/run-all.mjs)
    ├── test-utils.mjs                    # Shared helpers
    ├── api-endpoints.test.mjs            # ~25 API tests
    ├── hook-tests.test.mjs               # ~20 hook tests
    └── cron-parser.test.mjs              # ~15 cron tests
```

## Implementation Order

1. `tests/automated/test-utils.mjs` — shared helpers
2. `tests/automated/api-endpoints.test.mjs` — API tests
3. `tests/automated/hook-tests.test.mjs` — hook tests
4. `tests/automated/cron-parser.test.mjs` — cron tests
5. `tests/automated/run-all.mjs` — runner
6. `tests/manual-qa.md` — manual QA checklist

## Prerequisites

- NI server running for API tests (`node neural-interface/server.js`)
- Hook tests standalone (child_process spawning)
- Cron tests standalone (function import)
- No extra dependencies

## Totals

| Type | Count |
|------|-------|
| Manual QA | ~99 |
| Automated API | ~25 |
| Automated Hooks | ~20 |
| Automated Cron | ~15 |
| **Grand total** | **~159** |
