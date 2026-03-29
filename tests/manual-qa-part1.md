# SynaBun Manual QA Checklist — Part 1

Covers CHANGELOG entries **March 17-27, 2026**.
Sections 1-5: Server API, Hooks, Claude Panel, Automation Studio, Browser/Screencast.

**How to use:** Work through each section. Check `[x]` when verified. Note failures inline.

---

## 1. Server API & Backend (18 tests)

### 1.1 Hook-Recall Endpoint
**Ref:** 2026-03-27 — Added POST /api/hook-recall
**Prereq:** NI server running, at least 1 memory stored

- [ ] **1.1a** POST `/api/hook-recall` with `{ "query": "authentication", "limit": 3, "min_score": 0.4 }` returns `{ results: [...] }` with up to 3 items, each having `content` truncated to 300 chars
- [ ] **1.1b** POST `/api/hook-recall` with `{ "query": "" }` returns `{ results: [] }` (graceful degradation)
- [ ] **1.1c** POST `/api/hook-recall` with `{ "query": "test", "limit": 1 }` returns at most 1 result

### 1.2 Recall Impact
**Ref:** 2026-03-26 — Changed recall token estimation

- [ ] **1.2a** GET `/api/recall-impact` returns JSON with `rows` array (per-importance groups with `avg_tags_len`, `avg_files_len`) and `sessionStats` object (count, `avg_summary_len`, `avg_details_len`)

### 1.3 Session History Context Window
**Ref:** 2026-03-27 — Fixed session history endpoint

- [ ] **1.3a** GET `/api/claude-code/sessions/:id/messages` — context window values show 200K (not 1M) for Opus/Sonnet 4.6
- [ ] **1.3b** Token counts use per-turn `assistant.message.usage`, not cumulative `result.usage`

### 1.4 Content Negotiation & Markdown
**Ref:** 2026-03-19 — Added content negotiation endpoints

- [ ] **1.4a** POST `/api/fetch-markdown` with `{ "url": "https://example.com" }` returns `{ url, title, markdown, tokens }`
- [ ] **1.4b** With active browser: GET `/api/browser/sessions/:id/markdown` returns `{ url, title, markdown, tokens }`

### 1.5 Image Gallery API
**Ref:** 2026-03-20 — Added Image Gallery

- [ ] **1.5a** GET `/api/images` returns array with metadata (filename, type from prefix, size)
- [ ] **1.5b** POST `/api/images/favorite` toggles favorite; DELETE `/api/images/:filename` removes file + cleans favorites

### 1.6 Cron Scheduler
**Ref:** 2026-03-20 — Added cron-driven scheduler

- [ ] **1.6a** Full CRUD: POST/GET/GET:id/PUT:id/DELETE:id on `/api/schedules` all work correctly
- [ ] **1.6b** POST `/api/schedules/:id/test` fires immediately; invalid cron/template rejected on create

### 1.7 Agent System
**Ref:** 2026-03-19 — Added isolated agent system

- [ ] **1.7a** Full lifecycle: POST `/api/agents/launch`, GET `/api/agents`, GET `:id`, POST `:id/stop`, DELETE `:id`
- [ ] **1.7b** Agent spawns with `--max-turns 200` (check server logs for spawn command)

### 1.8 Auto Backup
**Ref:** 2026-03-18 — Added auto backup system

- [ ] **1.8a** GET/PUT `/api/system/auto-backup` reads and updates config, restarts scheduler
- [ ] **1.8b** POST `/api/system/auto-backup/trigger` creates valid backup ZIP at configured path

### 1.9 Multi-Browser Tabs
**Ref:** 2026-03-22 — Added multi-tab browser architecture

- [ ] **1.9a** With active browser: GET `.../tabs` lists, POST `.../tabs` creates, POST `.../tabs/:tabId/activate` switches, DELETE `.../tabs/:tabId` closes

### 1.10 Loop Caps
**Ref:** 2026-03-24 — Fixed loop caps silently clamped

- [ ] **1.10a** POST `/api/loop/launch` with `maxMinutes: 300` is NOT clamped to 60 (accepts up to 480)
- [ ] **1.10b** POST `/api/loop/launch` with `totalIterations: 150` is NOT clamped to 50 (accepts up to 200)

---

## 2. Hook System (12 tests)

### 2.1 Auto-Recall Injection
**Ref:** 2026-03-27 — Added hook-side auto-recall

- [ ] **2.1a** Substantive prompt (>20 chars) — output contains `=== SynaBun: Related Memories ===` with up to 3 memories
- [ ] **2.1b** First message (no flag file) — auto-recall skipped, greeting takes priority
- [ ] **2.1c** Short prompts ("yes", "ok") — no memory injection
- [ ] **2.1d** NI server unreachable — hook completes within 3s, exits 0

### 2.2 Stop Hook User Learning
**Ref:** 2026-03-27 — Fixed user learning enforcement

- [ ] **2.2a** Flag with `editCount: 3` + `userLearningPending: true` — single bundled block mentions both obligations
- [ ] **2.2b** UL standalone (`editCount: 0`) — blocks once, allows after 1 retry (not 3)

### 2.3 isWaitingForUser Guard
**Ref:** 2026-03-27 — Added isWaitingForUser()

- [ ] **2.3a** `last_assistant_message` with "please attach" / "upload the file" — soft obligations suppressed

### 2.4 Post-Plan Content Matching
**Ref:** 2026-03-19 — Fixed plan storage cross-session leak

- [ ] **2.4a** Two plan files in `~/.claude/plans/`. Post-plan with `tool_response` matching one — correct plan matched by content, not mtime

### 2.5 Session-Start Loop Scoping
**Ref:** 2026-03-26 — Fixed loop detection hijacking

- [ ] **2.5a** Loop file with `terminalSessionId: "other-terminal"`. Session-start WITHOUT that env — loop NOT detected

### 2.6 Loop Claim Scoping
**Ref:** 2026-03-23 — Fixed multi-loop isolation

- [ ] **2.6a** Pending loop with `terminalSessionId: "A"`. Prompt-submit from terminal B — file NOT claimed

### 2.7 Response Ordering
**Ref:** 2026-03-20 — Changed response ordering system

- [ ] **2.7a** Stop hook block reason includes instruction to end response with task completion summary

### 2.8 Loop Pending-Claim Server-Side
**Ref:** 2026-03-17 — Fixed loop pending-claim

- [ ] **2.8a** `attachLoopDriver` scans `pending-*.json` matching its terminal, writes begin message via `pty.write()`

### 2.9 Loop History Deletion
**Ref:** 2026-03-17 — Fixed loop history accumulation

- [ ] **2.9a** GET `/api/loop/history` returns `[]`; loop files deleted on finish/stop/fail

---

## 3. Claude Panel (14 tests)

### 3.1 AskUserQuestion Dedup
**Ref:** 2026-03-27 — Fixed duplicate cards

- [ ] **3.1a** Trigger AskUserQuestion — only ONE card renders (not two). Check sidepanel AND standalone chat

### 3.2 File Attachments
**Ref:** 2026-03-27 — Fixed file attachments not reaching agent

- [ ] **3.2a** Attach file (no text, no images) via "Send to AI" — send button enabled, message sends
- [ ] **3.2b** After sending, path chips (`.cp-path-chip`) removed from input area
- [ ] **3.2c** Sent files show as file chips (SVG + filename) in the chat bubble
- [ ] **3.2d** BTW interrupt: attach file → get interrupted → after resend, file still included

### 3.3 Batched AskUserQuestion
**Ref:** 2026-03-27 — Changed batched submission UX

- [ ] **3.3a** Multi-question ask: options toggle freely. Submit shows `(0/N)`, counter updates, enables only when all answered
- [ ] **3.3b** Free-text questions render inline `input.ask-text-input` (not main chat input)

### 3.4 Context Gauge
**Ref:** 2026-03-27 — Fixed inflated values

- [ ] **3.4a** After several tool calls, gauge stays within 200K — NOT inflated to multiples
- [ ] **3.4b** Gauge tooltip appears positioned correctly (fixed position, not clipped by panel)

### 3.5 Shift+Tab Plan Mode
**Ref:** 2026-03-27 — Added shortcut

- [ ] **3.5a** Focus `#cp-input`, press Shift+Tab — plan mode toggles on/off, button state updates

### 3.6 Session Button Group
**Ref:** 2026-03-27 — Connected session + rename buttons

- [ ] **3.6a** Session selector and rename icon render as joined button group (no gap, shared radius)

### 3.7 Edit Plan in Code Editor
**Ref:** 2026-03-25 — Added edit plan in code editor

- [ ] **3.7a** Click "Edit plan" on post-plan card — file editor opens with green banner. Save sends content to Claude

### 3.8 Changelog Edit & Cancel
**Ref:** 2026-03-26 — Fixed "Edit first" and cancel

- [ ] **3.8a** "Edit first" on changelog ask opens file editor (not just sending text)
- [ ] **3.8b** Close editor without saving — options re-enable (not stuck disabled)

### 3.9 Session Isolation
**Ref:** 2026-03-18 — Fixed session isolation leak

- [ ] **3.9a** Two sidepanel tabs, different projects — each keeps its own project/model/effort
- [ ] **3.9b** Standalone chat in two browser tabs — project selection doesn't leak between tabs

### 3.10 Attach Accepts Images
**Ref:** 2026-03-24 — Fixed attach button rejecting images

- [ ] **3.10a** Paperclip button file picker shows images. Select image — appears as thumbnail (not rejected)

---

## 4. Automation Studio (10 tests)

### 4.1 Inline Launch Panel
**Ref:** 2026-03-23 — Changed launch flow

- [ ] **4.1a** Click launch on template — config renders inline (NOT full-screen modal). Back/Escape restores editor

### 4.2 Panel Closes After Launch
**Ref:** 2026-03-23 — Fixed panel staying open

- [ ] **4.2a** Launch automation — AS window closes after toast

### 4.3 Icon Picker (13 Icons)
**Ref:** 2026-03-22 — Added icons

- [ ] **4.3a** Template editor icon picker shows: X, Instagram, Facebook, LinkedIn, TikTok, YouTube, WhatsApp, Discord, Claude, OpenAI, Gemini, Leonardo, Pin

### 4.4 Sidebar Scroll Preserved
**Ref:** 2026-03-22 — Fixed scroll reset

- [ ] **4.4a** Scroll down in sidebar, click mid-list template — scroll position preserved

### 4.5 Quick Timer
**Ref:** 2026-03-20 — Changed UX

- [ ] **4.5a** Click preset (15m) — highlights but does NOT start. Click "Go" — starts
- [ ] **4.5b** Timer appears exactly once in Active list (no duplicate from WS echo)

### 4.6 Schedule Editor
**Ref:** 2026-03-20 — Changed form layout

- [ ] **4.6a** New schedule form: 18 presets in 3 groups (Frequency/Daily/Weekly) grid. Day themes Mon-first, 2-column

### 4.7 Launch Destination
**Ref:** 2026-03-22 — Added destination prompt

- [ ] **4.7a** Launch dialog: "Floating" / "Side Panel" toggle. Side Panel → terminal snaps to Claude panel, browser embeds

### 4.8 Agent DOM Timing
**Ref:** 2026-03-19 — Fixed DOM reads after destroy

- [ ] **4.8a** Launch agent with SynaBun checkbox — agent gets SynaBun MCP config (not empty `{}`)

### 4.9 Focus Buttons & Badge Removed
**Ref:** 2026-03-27 — Removed dead code

- [ ] **4.9a** AS, Skills Studio, Settings — no focus mode button in headers. No active badge in AS

### 4.10 Multi-Loop Coexistence
**Ref:** 2026-03-22 — Changed coexistence

- [ ] **4.10a** Two concurrent automations run independently. `/api/loop/active` returns both. Stopping one spares the other

---

## 5. Browser / Screencast (12 tests)

### 5.1 Close Button After Reconnection
**Ref:** 2026-03-26 — Fixed stale closure bug

- [ ] **5.1a** Floating browser → disconnect/reconnect → close (X) and pin buttons still work

### 5.2 Resize Decoupled
**Ref:** 2026-03-27 — Removed ResizeObserver sync

- [ ] **5.2a** Resize floating browser — Playwright viewport stays 1280x800. Canvas scales via `object-fit: contain`

### 5.3 30fps Frame Cap
**Ref:** 2026-03-27 — Added frame throttle

- [ ] **5.3a** Active browser page — frames at ~30fps. DevTools Performance: no frames < 33ms apart

### 5.4 Pause/Resume on Minimize
**Ref:** 2026-03-27 — Pause screencast on minimize

- [ ] **5.4a** Minimize to pill → frames stop. Restore → frames resume

### 5.5 Focus Throttle
**Ref:** 2026-03-27 — Added focus-based throttle

- [ ] **5.5a** Two browsers open. Non-focused one throttles to ~2fps. Refocus → full framerate

### 5.6 Idle Timeout
**Ref:** 2026-03-27 — Added 5-minute idle timeout

- [ ] **5.6a** No interaction for 5 min → screencast pauses. Click canvas → resumes

### 5.7 Multi-Browser Isolation
**Ref:** 2026-03-23 — Dedicated session per automation

- [ ] **5.7a** Two automations → separate `browserSessionId` each (check server logs)

### 5.8 Multi-Tab CRUD
**Ref:** 2026-03-22 — Multi-tab architecture

- [ ] **5.8a** Create tab, switch tabs, close tab — all work. Tab list updates via WebSocket

### 5.9 Screencast Freeze Fix
**Ref:** 2026-03-18 — Fixed canvas freeze

- [ ] **5.9a** Rapid page changes — canvas keeps updating (no permanent freeze). All three surfaces: floating, side panel, reconnected

### 5.10 Server Backpressure
**Ref:** 2026-03-18 — WebSocket buffer check

- [ ] **5.10a** Slow connection: server skips frames at `bufferedAmount > 512KB`. Default `everyNthFrame` is 2

### 5.11 Browser Re-launch
**Ref:** 2026-03-21/22 — Fixed zombie blocking

- [ ] **5.11a** Open browser → close → open again — new session launches (no stale/zombie block)

### 5.12 --allowedTools Comma Join
**Ref:** 2026-03-22 — Fixed join character

- [ ] **5.12a** Agent with approved tools — `--allowedTools` uses comma-separated list (check server logs)
