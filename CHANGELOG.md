# SynaBun Changelog

## 2026-03-14

### Fixed — Find & Replace Focus Loss and Replace Accuracy (File Editor)
- **Find input losing focus on every keystroke** — Each character typed in the find input triggered `doFind()` → `selectFindMatch()` which unconditionally called `textarea.focus()`, stealing focus from the find input. Added `focusTextarea` parameter to `selectFindMatch()` — only `findNext()`/`findPrev()` (Enter/Shift+Enter) pass `true`. Live typing keeps focus in the find input while still scrolling to matches.
- **Replace jumping back to first match** — After replacing match N, `doFind()` recalculated all matches and reset `_findIndex` to 0, jumping back to the first match instead of staying at the current position. Now saves and restores `_findIndex` after recalculation, clamped to the new match count.
- **Replace All not refreshing syntax highlighting** — `doReplaceAll()` sets `textarea.value` directly without dispatching an `input` event, so `updateHighlight()` was never called. Added explicit `updateHighlight()` call after replace-all operations.

### Added — SynaBun Branded Tool Cards in Claude Code Side Panel
- **Gold-themed tool card rendering for all SynaBun MCP tools** — SynaBun tool interactions (`recall`, `remember`, `reflect`, `forget`, `restore`, `memories`, `sync`, `category`, browser/discord/whiteboard/card/git/loop tools) now render with a distinct gold/amber visual identity instead of the generic grey MCP tool card. Cards use `rgba(255,195,0,...)` border tints, gold icon backgrounds, and gold tool name text via the `.synabun-card` CSS class family.
- **Friendly tool names** — Raw MCP identifiers like `mcp__SynaBun__recall` are replaced with clean labels: "Recall", "Remember", "Reflect", etc. Grouped tools auto-format (e.g., `mcp__SynaBun__browser_navigate` → "Browser: Navigate"). Implemented via `SYNABUN_TOOLS` registry map, `SYNABUN_GROUPS` wildcard prefix matching, and `getSynaBunMeta()` lookup in `ui-claude-panel.js`.
- **Custom SVG icons per tool** — 15 unique 16×16 stroke-based SVGs: memory tools share a lightbulb base with unique overlays (magnifier for recall, plus for remember, X for forget, circular arrows for reflect/sync), plus distinct icons for browser (globe), discord (chat bubble), whiteboard (board+pen), card (window frame), git (branch), loop (infinity), tictactoe (grid).
- **Formatted inputs** — `formatSynaBunInput()` renders tool parameters as readable key-value pairs with styled `.synabun-tag` pills for arrays, `.synabun-value` highlighting for numbers/booleans, and truncated strings — replacing raw `JSON.stringify` dumps.
- **Rich result rendering** — `formatRecallResult()` parses recall output into mini `.synabun-memory-card` elements with `.synabun-mem-score` percentage badges, category lines, tag pills, content previews with gradient-fade overflow, and short UUIDs. `formatRememberResult()` shows confirmation cards with checkmarks. `formatSBConfirmation()` handles reflect/forget/restore/category/sync results. Session context entries render with blue-tinted score badges. Falls back to `<pre>` for unparseable output.
  - `buildSynaBunTool(block)` — intercepts `buildTool()` for SynaBun tools, stores `block.name` in `dataset.toolName` for result routing
  - `updateSynaBunResult(card, ev)` — intercepts `updateToolResult()`, routes to per-tool formatter based on `synaBunToolKey()`
- **Permission prompts enhanced** — `renderPermissionPrompt()` detects SynaBun tools via `isSynaBunTool()`, applies `.synabun-perm` class for gold-tinted border/header, and shows friendly name instead of raw MCP identifier.
- **Session history support** — Tool summary lines use friendly labels via `getSynaBunMeta()`, and session history result rendering routes SynaBun cards through `updateSynaBunResult()`.

### Fixed — Post-Plan "Continue with Implementation" Infinite Loop (Claude Skin)
- **Plan mode not disabled before sending implementation prompt** — Clicking "Continue with implementation" in the post-plan action buttons called `send()` while `tab.planMode` was still `true`, so the prompt got wrapped in `[PLAN MODE — do NOT make code changes]`. This contradicted the "implement" instruction, causing Claude to respond "exit plan mode first" in a loop. Fix: `renderPostPlanActions()` now sets `tab.planMode = false` and removes the `.active` class from the plan toggle before calling `send()` in the prompt-based action branch.

### Changed — Post-Plan Actions Restyled as Card Panel (Claude Skin)
- **Replaced flat floating buttons with card panel** — Post-plan actions now render as a full message bubble with Claude avatar and a `.post-plan-card` panel, matching the permission prompt card style. Features a green-themed border/glow (matching plan mode identity), `PLAN COMPLETE` uppercase header label, primary green button for "Continue with implementation", and secondary subtle buttons for "Compact context" / "Edit plan". Card dims to 0.45 opacity after click, consistent with resolved permission cards.
- **Updated cleanup selector in `send()`** — Changed from `.post-plan-actions` to `.post-plan-card`, traversing up to the parent `.msg` element to remove the entire message bubble on new input.

### Changed — Context Gauge Bar Restyle (Claude Panel)
- **Thinner, more refined gauge** — Reduced gauge height from 6px to 3px with tighter border-radius (2px). Added subtle `box-shadow` glow on urgency states (`warn`, `high`, `critical`). Section width transitions now use `cubic-bezier(0.4, 0, 0.2, 1)` for smoother easing. Section colors softened from 0.5 to 0.45 opacity.
- **Compact button redesign** — Removed border entirely for a cleaner borderless text button. Lighter font weight (600→500), wider letter-spacing (0.5px). Compacting state replaced opacity pulse (`cp-compact-pulse`) with a sweeping gradient underline animation (`cp-compact-sweep`) — a 1px purple line slides beneath the text. Button text simplified to `compacting` without trailing ellipsis.
- **Cohesive compacting animation** — Gauge shimmer replaced with purple-tinted flow animation (`cp-gauge-flow`, `rgba(140,130,220)`) matching the button's color scheme. Gauge opacity reduced to 0.6 with a subtle purple `box-shadow` glow during compaction.

### Fixed — Duplicate Compacting Status Messages (Claude Panel)
- **Two status lines appearing during context compaction** — `compact_started` and `compact_boundary` events each called `appendStatus()` independently, creating two separate status lines in the message area. Replaced with a single reusable `.msg-compact-status` element: `compact_started` creates it (or reuses existing), `compact_boundary` updates its text in-place. Result: one clean status line throughout the entire compaction process.

### Added — Live Browser Embed in Claude Code Side Panel
- **CDP screencast rendered inside the panel** — When MCP browser tools create a browser session while the Claude panel is open, a live screencast canvas auto-appears at the bottom of the panel (above the input area). Uses `sync:browser:created` / `sync:browser:deleted` events from `ui-sync.js` to auto-show/hide. WebSocket connection to `/ws/browser/${sessionId}` receives CDP `Page.screencastFrame` JPEG frames drawn to a `<canvas>` element.
- **Full interaction forwarding** — Mouse events (click, dblclick, wheel) forwarded with coordinate scaling from display-size canvas to full browser viewport. Keyboard events (keydown/keyup/keypress) forwarded. Canvas is focusable (`tabIndex=0`).
- **Toolbar with nav controls** — Back, forward, reload buttons, URL bar with Enter-to-navigate, detach-to-floating-window button, and close button.
- **Detach to floating window** — "Detach" button emits `browser:reconnect` event (distinct from `browser:open`) which triggers `reconnectBrowserSession()` in `ui-terminal.js` to reattach the existing session as a floating window without creating a new browser.
- **Terminal coordination** — Terminal's `sync:browser:created` listener checks for `.claude-panel.open` and skips if the panel is already handling the session, preventing double-open.
- **Aspect-ratio responsive layout** — Canvas wrapper uses `aspect-ratio: 16/10` instead of fixed height, so the browser view scales proportionally with panel width. Positioned between messages container and input area.

### Fixed — Browser Embed Shrinking Viewport to Mobile Size (Claude Panel)
- **Panel ResizeObserver sent `resize` messages to the server** — When the browser embed connected, the `ResizeObserver` on the canvas wrapper sent the display-size dimensions (e.g., 562×351) as a `resize` WebSocket message. The server handler at `server.js:11338` called `page.setViewportSize()` with those dimensions, shrinking the actual Playwright browser viewport from 1280×800 to the small canvas size. This caused pages to render in mobile/responsive mode. Fixed by removing the viewport resize from the panel embed — the browser stays at its original viewport and the canvas just scales the received frames to fit via `drawImage()`. The floating terminal window can still resize the viewport since it's full-size.

### Changed — MCP Response Boilerplate Elimination (FastMCP-Inspired Refactor)
- **New `text()` and `image()` response helpers** — Created `mcp-server/src/tools/response.ts` with two functions that wrap the verbose MCP response format. `text(msg)` replaces `{ content: [{ type: 'text' as const, text: msg }] }`, `image(data, mimeType)` replaces the equivalent image pattern. Inspired by FastMCP's approach of letting tools return simple values — full migration was evaluated and rejected (too opinionated for SynaBun's custom architecture with dynamic schemas, file watchers, and dual transport), but the response helper pattern was worth stealing.
- **Applied across all 25 tool source files** — Every MCP tool handler (`remember`, `recall`, `reflect`, `forget`, `restore`, `memories`, `sync`, `category`, `loop`, `browser-navigate`, `browser-interact`, `browser-observe`, `browser-advanced`, `card-tools`, `git-tools`, `tictactoe-tools`, `whiteboard-tools`, and all 8 `discord-*.ts` files) now imports from `response.ts`. Local `text` variables renamed to `msg` or `output` where they conflicted with the helper name.
- **Net reduction of ~423 lines** — 102 files changed (26 source + 76 compiled), removing ~1505 lines of verbose response objects and adding ~1082 lines of clean `text(...)` calls. Zero behavioral changes — purely mechanical boilerplate elimination.

### Fixed — Changelog Skill Double-Panel Prompt
- **`/synabun changelog` spawned two acceptance panels** — Phase 5 (Memory) used `AskUserQuestion` to ask whether to remember the changelog update, creating a second panel after the Phase 3 save confirmation. Removed the interactive prompt and replaced with silent auto-remember, consistent with the mandatory auto-remember rule in `CLAUDE.md`. Only one panel (Save/Edit/Cancel) now appears. (`skills/synabun/modules/changelog.md`)

## 2026-03-13

### Fixed — Claude Skin Cannot Access Sibling Directories
- **Added `--add-dir dirname(workDir)`** — The model self-restricted from accessing files outside the working directory, asking via text "I need permission to read X" instead of using tools. Adding the parent directory via `--add-dir` lets the model know it CAN access sibling project directories (e.g., `J:\Sites\Apps\SynaBunWebsite` when cwd is `J:\Sites\Apps\Synabun`). Confirmed working: Glob, Read, and Write on sibling directories now succeed.
- **`--print` is REQUIRED for stream-json** — Previous fix (March 12) incorrectly removed `--print`. The CLI docs explicitly state `--input-format` and `--output-format` "only work with --print". Restored.

### Added — Server-Side Permission Gate for Claude Skin
- **`--print` mode auto-approves all tools — server implements its own permission layer** — Confirmed via debug logs: `--print + --permission-mode default` emits zero `control_request` events for any tool (Edit, Write, Bash all auto-approved). Since `--print` is required for stream-json, the server now intercepts `assistant` events containing `tool_use` blocks for gated tools (`Edit`, `Write`, `Bash`, `MultiEdit`) and generates synthetic `control_request` messages to the client. The client's existing `renderPermissionPrompt` / `sendPermissionResponse` UI handles the rest. The tool already executed in the CLI process (can't prevent in --print mode), but the result is buffered and only shown when the user clicks Allow. Deny kills the process.
- **Server-side auto-allow set** — When the user checks "Always" and clicks Allow, the server adds that tool to `serverAutoAllow` set, bypassing the gate for future uses in the same session. Syncs with the client-side `_autoAllowTools` set.
- **`always` flag in `sendPermissionResponse`** — Client now passes `always: true` in control_response when the Always checkbox is checked, so the server knows to add the tool to auto-allow.

### Added — Stall Auto-Kill (120s Timeout)
- **API stream drops cause infinite hangs** — After Write tool execution, the CLI process stays alive but produces no output (API stream dropped mid-generation, likely rate limit or output token limit on long blog posts). Added `STALL_KILL_SEC = 120` — if no events for 120 seconds, the process is killed and the client receives an error message prompting to retry. Stall detector still logs warnings at 30s+ for diagnostics.

## 2026-03-12

### Added — Permission Prompt UI for Claude Code Skin
- **`renderPermissionPrompt()` in standalone chat** — Full permission prompt cards with tool name, detail (file path, command, or pattern), and three action buttons: Allow, Deny, Always Allow. Always Allow adds the tool to `_autoAllowTools` set for the session. Cards get a `.resolved` class after interaction to prevent double-clicks. Ported from the panel implementation to `claude-chat.js`.
- **`sendPermissionResponse()` function** — Sends `control_response` with `{ behavior: 'allow' | 'deny' }` back to the Claude CLI process via WebSocket. Re-shows the thinking indicator after response.
- **Permission card CSS** — `.perm-card`, `.perm-tool-line`, `.perm-tool-icon`, `.perm-tool-name`, `.perm-detail`, `.perm-actions`, `.perm-btn`, `.perm-btn-allow`, `.perm-btn-deny`, `.perm-always`, `.perm-card.resolved` styles in `claude-chat.css`.

### Fixed — Permission Prompts Never Appearing in Claude Code Skin
- **`-p` flag in spawn args auto-approved all tools** — `spawnProc()` in `server.js` passed `-p` (print mode) to the Claude CLI, which forces non-interactive mode and auto-approves every tool use. The CLI never emitted `control_request` events, so the client-side permission rendering code was never triggered. Removed `-p` from the args array — `--input-format stream-json` already handles stdin piping without needing print mode.
- **Rewrote `handleControlRequest()` in `claude-chat.js`** — Previously only handled `AskUserQuestion` tool (lines 642-648). Now extracts `request_id` and `tool_name`, routes to `renderAskUserQuestion()` for user questions or `renderPermissionPrompt()` for tool permissions, with `_autoAllowTools` auto-allow bypass.

### Fixed — Multi-Selection "More..." Navigation Broken
- **`sendControlResponse()` nesting `request_id` inside response wrapper** — The function wrapped `request_id` inside `response.response` with an extra `subtype: 'success'` layer. Claude CLI expects `request_id` at the top level of the `control_response` message. Fixed format to `{ type: 'control_response', request_id, response: { behavior: 'allow', updatedInput } }`.
- **Answer buffering for race conditions** — Added `pendingAskRequestId` and `pendingAskBufferedAnswer` state variables. If the user clicks a selection before the `control_request` arrives (race condition), the answer is buffered and flushed when the request comes in.

### Fixed — control_response Protocol Format Wrong (Claude Code Skin)
- **Flat format caused CLI to hang on all responses** — Both `sendControlResponse()` (AskUserQuestion answers) and `sendPermissionResponse()` (tool permission Allow/Deny) sent `{ type: "control_response", request_id: "...", response: { behavior: "allow" } }` with `request_id` at the top level. Extracted the actual format from the Claude Code SDK source (`node_modules/@anthropic-ai/claude-code/cli.js`) — 3 independent code paths (RemoteAgentTask, RemoteSessionManager, respondToPermissionRequest) and the Zod schema all use a doubly-nested structure: `{ type: "control_response", response: { subtype: "success", request_id: "...", response: { behavior: "allow", updatedInput?: {...} } } }`. The CLI reads `msg.response.request_id` and `msg.response.subtype` — our flat format left both as `undefined`, so the CLI couldn't match responses to pending requests.
  - Fixed `sendControlResponse()` in `claude-chat.js` and `ui-claude-panel.js` — now includes `subtype: 'success'`, `request_id` inside `response`, and `behavior: 'allow'` alongside `updatedInput` for AskUserQuestion answers
  - Fixed `sendPermissionResponse()` in `claude-chat.js` and `ui-claude-panel.js` — same nested structure with `{ behavior }` inside `response.response`
  - Added `console.log` debug tracing in `handleControlRequest()` for verifying control_request events arrive

### Fixed — Thinking Indicator and Timer
- **Thinking indicator disappeared on first streaming chunk** — `hideThinking()` was called in `handleEvent()` on the first `assistant` event, removing the activity indicator while Claude was still working. Replaced with `repositionThinking()` that moves the indicator below new content as messages stream in. Only `finish()` removes it.
- **Persistent timer across repositions** — Added `sendStartTime` (standalone) / `tab.sendStartedAt` (panel) that persists across `showThinking()` calls. Timer shows elapsed seconds since the user sent their message, not since the last reposition.
- **Think toggle now suppresses thinking blocks** — Added `if (!_getEffort()) thinks.length = 0;` in `ui-claude-panel.js` `renderAssistant()` to filter thinking content when the effort toggle is off.

### Fixed — Textarea Overflow on Large Paste (Claude Chat Skin)
- **Pasted text overflowed horizontally** — Long unbroken strings (file paths, CLI commands) in the `#chat-input` textarea had no word wrapping, pushing the container wider than the viewport. Added `overflow-wrap: break-word` and `word-break: break-word` to `claude-chat.css`. Also added `min-width: 0` on both `#chat-input` and `#chat-input-inner` to prevent flex children from overflowing, and changed `align-items: center` to `flex-end` so the send button stays at the bottom when the textarea grows tall.

### Fixed — Context Gauge Miscalculating Usage (Claude Panel Skin)
- **Percentage included output tokens** — `renderGauge()` in `ui-claude-panel.js` calculated context usage as `inputTokens + outputTokens`, but only input tokens consume the context window. Fixed to use `inputTokens` only.
- **Output section removed from gauge bar** — Output tokens don't represent context consumption; moved output info to the tooltip instead.
- **Label improved** — Changed from bare `27%` to `55K/200K` format with detailed breakdown (percentage, output tokens, turn count) in the tooltip.
- **Urgency color tiers** — Added `data-urgency` attribute with CSS transitions: yellow at 50%+, orange at 75%+, red at 90%+. Label color also shifts via `:has()` selectors on `.cp-context-bar`.
- **Gauge height bumped** — 4px to 6px with matching border-radius for better visibility.

### Fixed — Compact Button Not Actually Compacting (Claude Panel Skin)
- **Kill/restart replaced with real compaction** — Server handler in `server.js` no longer kills the subprocess and respawns with `--continue` (which reloaded the same full context). Now sends `/compact` as a user message to the subprocess stdin, letting Claude Code handle compaction natively.
- **Gauge no longer resets to zero** — Removed the misleading `tab.usage = {0,0,0,0}` reset from the compact event handler in `ui-claude-panel.js`. The next streaming event updates the gauge with real post-compaction numbers.
- **Running guard added** — Compact is blocked while Claude is processing, both via button click and `/compact` slash command. Shows status message instead of interrupting.
- **Tooltip added** — Compact button now has `title="Compress conversation context to free up space"`.

### Changed — Greeting Settings Project Selector Hint
- **"Per-project or global" helper text** — Added a faint hint label (`font-size:10px`, `color:var(--t-faint)`) next to the project dropdown in the greeting configuration section of `ui-settings.js`. Clarifies that greetings can be configured per-project or set globally via the selector.

### Added — Changelog Button on Floating CLI Windows
- **Changelog shortcut button** — Added a "Generate changelog" button to the floating terminal window header for CLI profiles (`claude-code`, `codex`, `gemini`). Uses a document-with-lines SVG icon, placed between the rename and pin buttons in `.term-float-tab-actions`. Clicking the button sends `/synabun changelog\r` as input to the session's websocket, spawning the changelog skill directly in the TUI. Button is conditionally rendered — does not appear on shell or browser floating windows.

### Added — Git Commit Output Display in File Explorer
- **In-popover commit log** — After a git commit via the file explorer, the popover now swaps its controls (branch selector, commit input, summary) for a result view showing the full git operation output. Success shows a green checkmark header with the raw `git commit` stdout (branch, hash, files changed, insertions/deletions). Errors show a red X header with stderr in a red-tinted `<pre>` block.
- **`showCommitOutput(text, isSuccess)`** — New function in `ui-file-explorer.js` that hides `.fe-git-controls`, populates `.fe-git-output` with a header + monospace `<pre>`, and widens the popover to 300px via `.fe-git-output-mode` class. `resetCommitOutput()` restores normal state on popover close/reopen.
- **Dynamic popover width** — `positionGitPopover()` now reads `pop.offsetWidth` instead of hardcoded `248`, so the flip-to-left overflow check works correctly in both normal (240px) and output (300px) modes.
- **CSS** — `.fe-git-output-mode` (width transition), `.fe-git-output-header` (9px mono uppercase), `.fe-git-output-pre` (dark bg, 10px mono, `max-height:160px` with scroll), `.fe-git-output-pre.error` (red tint) in `styles.css`.

### Fixed — Floating TUI/CLI Rendering Glitches (Terminal)
- **Spacer/scrollTop desync causing blank rows** — Alt screen transitions and rapid buffer changes caused `scrollTop` to become stale within a single rAF frame, making `firstVisible` point beyond valid data. Added `_isLive` tracking mode in `html-term-renderer.js` that bypasses spacer math entirely during live viewing — always sets `firstVisible = scrollbackLength`. Scroll events toggle `_isLive` based on whether the user is at the bottom. Alt screen transitions, `fit()`, `scrollToBottom()`, and keyboard input all force `_isLive = true`.
- **innerHTML DOM churn on every dirty row** — `_renderRowData()` rebuilt the entire row HTML string and set `el.innerHTML` on every render. During Ink/React full-screen redraws (most rows dirty every frame), this caused heavy DOM destruction/creation and GC pressure. Replaced with **span pool DOM diffing** via `_rowSpanPools[]` — reuses existing `<span>` elements, updating `className`/`style.cssText`/`textContent` instead of rebuilding HTML. Falls back to `innerHTML` only for rows with hyperlinks (`data-url` attribute).
- **Alt screen transitions leaving stale scroll state** — Added `_altTransitionPending` flag in `vterm-buffer.js`, set by `_switchToAltBuffer()` and `_switchToMainBuffer()`. Renderer detects the flag in `write()`, forces `_isLive = true`, and clears it — ensuring clean scroll reset on every buffer switch.
- **Redundant dirty Set operations during full-screen redraws** — Every cell write, erase, scroll, and insert/delete operation called `this._dirty.add(row)` even when `_allDirty` was already `true`. Guarded all `_dirty.add()` calls in `vterm-buffer.js` with `if (!this._allDirty)`. Also optimized `_eraseDisplay` modes 2/3 to set `_allDirty = true` directly. `print()` hot path uses local variable caching for `_allDirty`, `cols`, `_attr`, `_currentUrl`.

### Changed — Terminal Resize Debounce Tuning
- **Renderer debounce 60ms → 150ms** — `RESIZE_DEBOUNCE_MS` in `html-term-renderer.js` increased to reduce layout thrashing during continuous resize drag. Tuned for Ink/React TUIs that re-render their entire screen on every SIGWINCH.
- **PTY resize coalescing at 250ms** — Added secondary debounce in `ui-terminal.js` `onResize` callbacks for both `openHtmlTermSession()` and `reconnectHtmlTermSession()`. Visual container adjusts at 150ms but PTY resize messages to the server are coalesced at 250ms, preventing Claude Code from re-rendering multiple times during a resize drag. Initial connect resize is still sent immediately.
- **CSS paint containment on terminal rows** — Upgraded `.html-term-rows` from `contain: layout style` to `contain: layout paint style` and `.html-term-row` from `contain: inline-size style` to `contain: layout paint style` in `styles.css`. Tells the browser that row paint changes don't affect siblings, enabling more aggressive compositing.

### Changed — Browser Tool Injection Lists Synced Across All Automation Entry Points
- **12 missing Instagram & LinkedIn extractors added to prompt context** — When "Use Browser" is enabled in Automation Studio, three injection points tell Claude which `browser_*` tools are available. All three were missing the 5 Instagram extractors (`browser_extract_ig_feed`, `ig_profile`, `ig_post`, `ig_reels`, `ig_search`) and 7 LinkedIn extractors (`browser_extract_li_feed`, `li_profile`, `li_post`, `li_notifications`, `li_messages`, `li_search_people`, `li_network`). Claude would never use these tools during browser automations because it wasn't told they existed.
  - `formatLoopCommand()` in `ui-automation-studio.js:732` — 18 → 38 tools (also added missing `browser_reload`, `browser_session`)
  - `BROWSER_CONTEXT` constant in `ui-automation-studio.js:741` — 26 → 38 tools
  - `buildBrowserNote()` in `hooks/claude-code/prompt-submit.mjs:81` — 26 → 38 tools
- **Consistent tool ordering applied** — All three lists now use the same grouping: Navigation → Interaction → Observation → Advanced → Extractors by platform (Twitter → Facebook → TikTok → WhatsApp → Instagram → LinkedIn).

### Fixed — Loop System Ending Abruptly After 3-4 Iterations
- **`driveNextIteration()` ignored prompt detection failures** — `waitForLoopPrompt()` in `server.js` returned `false` on timeout, but the caller never checked the return value. If the `>` prompt wasn't detected within 15s (slow PTY, ANSI stripping miss, buffer overflow), the function silently proceeded — sending `/clear` and iteration messages to a terminal that wasn't ready. Now checks the return value, retries once with a longer timeout (30s → 45s fallback), and aborts with full buffer diagnostic logging on failure. Returns a boolean so the driver can react.
- **No recovery from repeated prompt detection failures** — The loop driver interval had no failure tracking. A silently-failed `driveNextIteration()` would clear the `awaitingNext` flag and never retry, leaving the loop frozen forever. Added `consecutiveFailures` counter — after 3 failed drives, the loop is deactivated with `stopReason: 'prompt-detection-failed'` and logged to the server console.

### Fixed — Loop Time Cap Too Aggressive for Browser Automations
- **`MAX_MINUTES` hardcoded at 60** — Browser-based loop iterations take 15-20 minutes each (Instagram commenting, Facebook posting, etc.), so a 60-minute cap killed loops at iteration 3-4 out of 50. Raised `MAX_MINUTES` from 60 to 480 (8 hours) and `DEFAULT_MINUTES` from 30 to 60 in `mcp-server/src/tools/loop.ts`.

### Fixed — Loop Session ID Orphaning After `/clear`
- **Fallback scan window hardcoded at 5 minutes** — After `/clear` resets the Claude session (new session ID), `prompt-submit.mjs` scans for active loop files using `statSync().mtimeMs` with a 5-minute age cutoff. Browser iterations consistently exceed 5 minutes, so the scan skipped the loop file entirely — Claude received a bare `[SynaBun Loop]` message with no task context injected. Replaced the fixed 5-minute window with the loop's own `maxMinutes + 5min grace`, computed from `candidate.startedAt`. Removed unused `statSync` import.

### Fixed — Prompt Detection Fragility (ANSI Stripping & Buffer Size)
- **ANSI regex missed escape sequences** — `LOOP_ANSI_RE` in `server.js` didn't strip OSC sequences terminated by `\x1b\\`, cursor control codes (`\x1b[=<>78HMND]`), application mode keys (`\x1bO[A-Z]`), or carriage returns (`\r`). These leftover characters could prevent the `>` prompt regex from matching. Expanded the regex to cover all common terminal escape types.
- **Ring buffer too small** — Prompt detection buffer was 4KB with a 2KB retention window. Heavy PTY output (e.g., Claude's tool use summaries) could push the `>` prompt out of the buffer before `loopPromptReady()` checked it. Increased to 16KB / 8KB.
- **Prompt regex too strict** — Only matched `>\s*$` (end of buffer) or `^>\s*$/m` (own line). Added `>\s*\n\s*$` pattern to catch prompts followed by trailing newlines.

### Changed — Loop Stop Reason Tracking
- **`stopReason` field added to loop state** — `stop.mjs` now writes `'iteration-cap'` or `'time-cap'` when deactivating a loop that hit its limits. Previously, all loop endings looked identical in the state file — no way to tell if a loop completed naturally or was killed by the time cap. The prompt-detection-failed abort path in `server.js` also writes `stopReason: 'prompt-detection-failed'`.

### Added — Plan Rendering & Post-Plan Actions in Claude Panel Skin
- **Inline plan markdown rendering** — `buildPlanCard()` in `ui-claude-panel.js` detects when a `Write` tool targets `~/.claude/plans/*.md` (via `isPlanFile()` path regex) and renders the plan content as formatted markdown inside a collapsible `<details>` element (open by default) with green accent styling. Previously, plan content was buried in a collapsed tool card as raw JSON.
- **Post-plan quick-action buttons** — `renderPostPlanActions()` shows three pill buttons after a plan turn finishes: "Continue with implementation" (sends prompt), "Compact context" (triggers `/compact` flow), "Edit plan" (re-enters plan mode). Buttons render on both `result` and `done` events when `tab._exitedPlan` is flagged. Buttons are auto-cleared on next message send.
- **Auto-toggle planMode on ExitPlanMode** — `renderAssistant()` now detects `ExitPlanMode` tool in the turn's tool_use blocks, auto-sets `tab.planMode = false`, and updates the Plan toggle button UI.
- **CSS** — `.plan-card`, `.plan-icon`, `.plan-label`, `.plan-file`, `.plan-chevron`, `.plan-body` (green accent collapsible), `.post-plan-actions`, `.post-plan-action` (pill buttons with hover states).
- **Dedup & result handling** — Updated partial message dedup selector to include `.plan-card`, `updateToolResult()` handles plan cards by setting border color on success/error instead of looking for missing result sections.

## 2026-03-11

### Added — Wireframe Tool for Website Layout Sketching
- **New `section` element type with 12 presets** — Vibecoders can now sketch website layouts directly on the whiteboard using pre-built wireframe blocks. Section types: `navbar` (960x56), `hero` (960x340), `sidebar` (260x400), `content` (640x360), `footer` (960x100), `card` (260x180), `form` (380x280), `image-placeholder` (280x180), `button` (140x42), `text-block` (380x90), `grid` (640x320), `modal` (440x300). Each has default dimensions, color, and icon defined in `SECTION_TYPES` constant.
- **Toolbar button + section picker** — New wireframe icon button (`data-tool="section"`) in the whiteboard toolbar. Clicking it opens a 3-column glass panel picker (`#wb-section-picker`) with icon + label buttons for each section type. Built by `initSectionPicker()` at whiteboard init.
- **Click-to-place and drag-to-create** — Single click places a section at default dimensions centered on the click point. Click-and-drag creates a custom-sized section. Hold Ctrl for multi-placement (tool locking via `autoRevert()`).
- **Double-click label editing** — Double-clicking a section makes the `.wb-section-label` element contenteditable. Enter confirms, Escape cancels, blur saves. Label persists via `pushUndo()` + `persistDebounced()`.
- **Screenshot rendering** — `_captureScreenshot()` draws sections with `setLineDash([6,4])` dashed borders, 10%-alpha color fill, centered 32px icon at 20% opacity, and 12px monospace top-left label.

### Added — Wireframe MCP Integration
- **`whiteboard_add` section support** — Added `'section'` to the element type enum, plus `sectionType` enum (12 types) and `label` string fields in `whiteboardAddSchema`. Server-side `SEC_DEFAULTS` in POST `/api/whiteboard/elements` applies default width/height/color/label when Claude creates sections without specifying dimensions.
- **`whiteboard_read` semantic output** — `describeElement()` produces `[wb-id] SECTION:navbar at (100, 50) 960x56 "Navbar"` for AI-readable layout descriptions.
- **`whiteboard_update` section fields** — Added `sectionType` and `label` to the update schema so Claude can modify wireframe elements after placement.

### Added — Grid Snapping for Whiteboard Elements
- **`_snap()` helper** — New function in `ui-whiteboard.js` that rounds values to the nearest grid increment when `state.gridSnap` is enabled: `Math.round(v / gs) * gs` where `gs = state.gridSize || 20`.
- **Applied to all flows** — Grid snapping active during: element drag (single + multi-select), shape drag-to-create, section drag-to-create, resize handle, text/list/shape/section click-placement, and default-dimension placement centering.

### Fixed — Section Elements Not Resizable
- **Missing CSS selector for resize handle** — The opacity rule for `.wb-resize-handle` only listed `.wb-text.selected`, `.wb-image.selected`, and `.wb-shape.selected`. Section elements had the resize handle in their DOM but it was invisible. Added `.wb-section.selected .wb-resize-handle` to the `opacity: 1` selector in `styles.css`.

### Fixed — MCP Viewport Clipping Under Navbar and Terminal
- **Viewport included area hidden by navbar** — `_root.getBoundingClientRect()` reported the full `#wb-root` height starting at `top: 0`, but `#title-bar` overlays the top ~40px. MCP-generated layouts placed at `y: 0%` were hidden under the navbar. Fixed by measuring `#title-bar` height, subtracting it from reported `height`, and sending `yOffset` via WebSocket.
- **Server coordinate conversion now offset-aware** — `whiteboardViewport` stores `yOffset`. Percentage-to-pixel conversion in POST/PUT `/api/whiteboard/elements` adds `yOff` to all y-values: `y = yOff + (pct/100) * height`. `applyWhiteboardLayout()` offsets all layout modes (center, row, column, grid).
- **MCP reads report usable area** — `whiteboard_read` now shows `Usable viewport: WxH (y starts at N)` so Claude knows the coordinate space.

### Changed — Thinner Whiteboard Arrows
- **Reduced arrow stroke and arrowhead size** — SVG arrowhead markers shrank from `42x44` to `20x20` with a tighter path (`M 2 2 L 18 10 L 2 18 Z`). Stroke width updated in `renderArrows()` to `2px` default / `3px` selected. Arrows now look proportional instead of oversized.

### Fixed — Hooks Toggles Showing OFF (0/6) and Not Persisting State
- **`projs.every()` AND logic required all projects to have hooks** — `buildConnectionsTab()` in `ui-settings.js:1414-1419` computed each hook's on/off state as `gh.SessionStart && projs.every(p => p.hooks.SessionStart)`, requiring every registered project to have the hook installed. CriticalPixel had no `.claude/settings.json`, so `isSpecificHookInstalled(null, ...)` returned `false`, making `every()` fail for all 6 hooks — permanent 0/6 even though hooks were installed globally and running. Fixed by changing to `!!gh.SessionStart` — global section now reflects global settings only.
- **POST cascade skipped projects without settings files** — `addHookToSettings` cascade in `server.js:5716` had `if (projSettings)` guard that skipped projects where `readClaudeSettings()` returned `null`. CriticalPixel never got a settings file created, so toggles reverted on every Settings reopen. Fixed by using `readClaudeSettings(projFile) || {}` to create settings files for projects that don't have one.

### Added — Auto-Sync Globally-Enabled Hooks to Registered Projects
- **Self-healing hook sync on settings load** — GET `/api/claude-code/integrations` in `server.js` now iterates all globally-enabled hooks and checks each registered project. Any project missing a globally-enabled hook gets it auto-installed before the response is sent. Handles projects registered before the hook system existed, projects whose settings files were deleted, and newly registered projects that missed a cascade. Uses `isSpecificHookInstalled()` + `addHookToSettings()` for idempotent sync.

## 2026-03-10

### Fixed — File Explorer Click & Preview Mode
- **Left-click on files now opens context menu** — Previously, left-click opened the file editor directly while right-click opened the context menu. Changed left-click handler on files to also call `showContextMenu()`, making the behavior consistent — users access "Edit File" from the menu.
- **Markdown preview overlapping with raw code** — `setPreviewMode()` only hid the textarea and gutter when switching to preview, but left the syntax highlight overlay (`fe-editor-highlight`) and line highlight (`fe-editor-line-highlight`) visible. The rendered markdown and raw syntax-highlighted code rendered on top of each other. Fixed by hiding both overlay elements when preview is active.

### Fixed — Communication-Style User Learning System
- **Recall threshold filtering memories prematurely** — `searchMemories()` in `sqlite.ts` applied the `minScore` threshold (default 0.3) to raw cosine similarity scores, but `recall.ts` then boosted scores via `applyTimeDecay()` (recency, importance, access count). Memories with raw similarity 0.15–0.29 that would score 0.35–0.45 after adjustment were silently discarded at the DB level. Session-start recall for `communication-style` returned "No memories found" despite 9 entries existing. Fix: pass `minScore * 0.5` as the raw DB threshold, then filter on adjusted scores in `recall.ts` with `.filter()`. Same fix applied to session chunk search.
- **Unrelated reflects falsely clearing user learning flag** — `isReflectUL = toolName.includes('reflect')` in `post-remember.mjs` matched any reflect call. When `userLearningPending` was true and Claude called reflect on an unrelated memory during normal work, it falsely cleared the pending flag — bypassing stop hook enforcement. 47 sessions marked "observed" but only 9 memories actually stored. Fix: added `userLearningBlockActive` flag in `stop.mjs`. The stop hook sets it when blocking for user learning; `post-remember.mjs` only clears on reflect when both `userLearningPending` and `userLearningBlockActive` are true. `remember` with the correct category still always clears.
- **Tests updated** — Test 7 rewritten to verify reflect-without-blockActive does NOT clear, and reflect-with-blockActive DOES clear. All 78 user learning tests pass.

### Added — Floating Terminal Per-Color System
- **16-color accent palette** — Each floating terminal can have its own color theme. 16 presets: blue, indigo, purple, pink, red, orange, amber, yellow, lime, green, teal, cyan, sky, slate, warm, neutral. Colors driven by CSS custom properties (`--fh` hue, `--fs` saturation) so header gradient, border, and pinned glow all shift together.
- **Color strip indicator** — Vertical 4px color bar between the icon and title in the floating header. Widens to 6px on hover. Shows the current accent color at a glance.
- **Color picker popup** — Click the strip to open a 2-row × 8-column swatch grid. Active color shows a white ring, hover scales up. Appended to `document.body` with `position: fixed` to avoid overflow clipping. Positioned top-right of the strip.
- **Random color on detach** — New floating terminals get a random color from the 16 presets. Saved color persists across sessions via registry and layout snapshot.

### Added — Snap-to-Neighbor Drag System
- **Edge snapping** — 12px threshold. When dragging a floating terminal near another, edges snap flush: right→left, left→right, bottom→top, top→bottom.
- **Alignment snapping** — Matching left/right/top/bottom edges lock together for clean grid arrangements.
- **Viewport snapping** — Also snaps to screen edges (left=0, top=48, right, bottom).
- **Sharp corners on snapped edges** — When two terminals snap flush, touching corners lose their border-radius and the border goes transparent for a seamless join. `_updateSnappedEdges()` runs on drag move/end, resize end, dock, and close.
- **Magnetic feel** — `float-snapping` class adds 80ms ease-out transition so snaps feel smooth, not jumpy.

### Added — Tile All Terminals Button
- **Navbar tile button** — 2×2 grid icon on the top-right navbar (next to Snap to Grid). Accessible even when all terminals are floating and the docked panel is hidden.
- **Panel-aware tiling** — Respects open panels: left sidebars (`--explorer-width` + `--file-explorer-width`), right Claude panel (`--claude-panel-width`), bottom docked terminal panel height. Tiles only in the remaining whiteboard area.
- **Smart grid layout** — Calculates optimal columns/rows targeting ~16:9 cell aspect ratio. Detaches any docked sessions first so everything participates. Refits all terminals after layout.

### Changed — Floating Terminal Header Restyle
- **Header gradient** — Replaced flat `rgba(255,255,255,0.06)` with steel-blue gradient using CSS custom properties: `linear-gradient(180deg, hsla(--fh, --fs, 22%, 0.85), hsla(--fh, --fs, 10%, 0.9))`.
- **Border recolor** — White tint → accent-colored blue tint via `hsla()`. Top edge slightly brighter.
- **Drop shadow on drag only** — Resting state has only a thin 1px outline. Full layered shadow appears on `.float-dragging` with smooth 0.15s/0.2s fade in/out transitions.
- **Button sizing** — 28px → 22px, icons 16px → 13px, gap 6px → 2px, default opacity 0.6 → 0.35.
- **Visual separator** — 1px divider before minimize button splits utility actions (files, rename, pin) from window controls (minimize, dock, close).
- **Pin icon** — Replaced complex filled thumbtack SVG (turned to blob at 13px) with clean stroke-based pin. Rotates 45° when unpinned, straightens when pinned.
- **Hover colors** — Minimize=amber, pin=blue, dock=green, close=red. Generic base hover for all buttons.

### Added — Loop Memory Integration (Anti-Brain-Rot)
- **Loop journal system** — New `update` action in the loop MCP tool. Claude writes a 1-2 sentence summary after each iteration, stored in the loop state file as a rolling journal (last 10 entries, 200 chars each). A separate `progress` field holds a rolling summary (500 chars) of overall progress across all iterations.
- **Enriched iteration prompt** — Stop hook now injects the last 3 journal entries and rolling progress summary into every iteration prompt. Claude always knows what it did recently, even deep into a 50-iteration run.
- **Style anchoring** — At iteration checkpoints (1, 10, 20, 30, 40), the Stop hook appends a "STYLE ANCHOR" directive telling Claude to re-read the task rules. Counteracts progressive tone drift without requiring memory.
- **Memory enforcement for loops** — Every 5 iterations (configurable via `memoryInterval`), the Stop hook sets `memoryPending` and blocks Claude until it calls `remember` with accumulated progress. Uses the same block/retry pattern as edit-tracking (max 3 retries). Post-remember hook clears the flag and updates `lastMemoryAt`.
- **Compaction bridge** — Pre-compact hook now captures active loop state (task, journal, progressSummary, iteration count, browser flag) into the precompact cache. Session-start hook injects an ACTIVE LOOP RECOVERY block on compaction restart with full task context, journal entries, progress summary, and a `recall` directive to retrieve stored memories.
- **Loop state schema extended** — Loop state files now include `journal[]`, `progressSummary`, `lastMemoryAt`, `memoryInterval`, `memoryPending`, `memoryRetries`. All fields have fallback defaults for backward compatibility with existing loop files.

### Fixed — Resume Prompt Not Showing After Server Restart
- **Heartbeat deleting snapshot too early** — `saveSessionSnapshot()` runs every 30s via `setInterval`. On fresh server start with no active Claude Code sessions, the first heartbeat deleted `last-session.json` before the client could fetch it. Added a 2-minute grace period (`RESUME_GRACE_PERIOD_MS`) — the heartbeat skips file deletion during this window, giving the client time to show the resume prompt.
- **No reconnect-aware resume check** — `initTerminal()` only checked for the resume prompt on initial page load. If Neural Interface was already open when the server restarted, the sync WS reconnected but the resume check never re-ran. Added `checkResumePrompt()` (extracted from inline code) with a `session:info` listener that fires on every sync WS connect/reconnect — if all sessions are dead or none exist, re-checks for the resume prompt. Includes duplicate overlay guard and `console.warn` logging instead of silent `catch {}`.

### Fixed — Resume Session List (Message Count, Refresh, Missing Sessions)
- **Message count always showing "1 msg"** — `extractSessionMeta()` returned immediately after finding the first user message in the JSONL file, so `messageCount` was always 1. Separated concerns: metadata extraction (fast early-exit for first prompt, branch, etc.) stays fast; new `countSessionMessages()` does a full streaming scan of the entire file using string matching in 64KB chunks — no JSON parsing needed.
- **Cache merge discarding fresh data** — `buildSessionEntries()` only updated the `modified` timestamp for existing cache entries, silently discarding the re-extracted `messageCount`. Rewrote the merge logic to track `fileSize` per entry and re-count messages when the file has grown.
- **Refresh button was a no-op** — Cleared the in-memory cache but the persistent `sessions-cache-*.json` files survived, so `loadSessionCache()` immediately re-read the same stale data. Refresh now deletes persistent cache files, forcing full re-extraction.
- **Low default session limit** — UI fetched only 20 sessions per project, hiding most entries. Increased to 50.

### Fixed — Whiteboard Image Paste Stealing Focus
- **Image paste leaking to whiteboard from focused panels** — Pasting an image while a TUI terminal or Claude panel input was focused in focus mode caused the image to appear on both the whiteboard and the focused panel. The whiteboard's `onPaste` handler was registered on `document` and only checked if focus mode was enabled (`#static-bg.visible`), not whether the whiteboard itself had DOM focus. Added a focus-ownership guard that checks `document.activeElement` is inside `wb-root` before processing — paste events from other panels now correctly stay in their own handler.

### Added — Auto Changelog Skill (`/synabun changelog`)
- **Changelog module** — New `skills/synabun/modules/changelog.md` with a 5-phase workflow: context gathering (conversation analysis + `git diff`/`git log`), categorize into Added/Fixed/Changed sections, review via `AskUserQuestion` with edit loop, write to CHANGELOG.md (creates new file or appends to existing with today's date section merging), and optional memory storage.
- **Hub routing** — Updated `skills/synabun/SKILL.md` with direct routing for `changelog`/`changes`/`log` keywords → Step 2d. Supports focus hints (e.g., `/synabun changelog the auth refactor` narrows analysis to that topic).
- **Interactive menu entry** — "Auto Changelog" added to Page 2 of the `/synabun` interactive menu alongside Memory Health and Search Memories. `More...` description on Page 1 updated to reflect the new option.
- **Format enforcement** — Module instructions enforce the exact CHANGELOG.md format: `## YYYY-MM-DD` date headers, `### Type — Name` section headers, `- **Bold** — Description` entries with em dashes, 2-space indented sub-bullets, inline backtick code references.

## 2026-03-09

### Added — Instagram MCP Suite
- **Instagram browser extractor tools (5 tools)** — Full Instagram automation from Claude Code via headed browser. Follows the same pattern as Twitter/X, Facebook, TikTok, and WhatsApp extractors.
  - `browser_extract_ig_feed` — Home feed posts (username, postUrl, caption, likes, comments, time, isSponsored, hasFollow)
  - `browser_extract_ig_profile` — Profile page (username, displayName, bio, posts, followers, followerExact, following, isVerified, website, gridPosts, highlights)
  - `browser_extract_ig_post` — Single post + comments (author, caption, likes, commentCount, comments with username/text/time)
  - `browser_extract_ig_reels` — Reels feed (username, caption, likes, comments, audioName, audioUrl, hasFollow)
  - `browser_extract_ig_search` — Explore page grid (url, alt, isReel)
- **Instagram interaction hints** — Added Instagram-specific selectors to all 6 browser interaction tool descriptions:
  - `browserClickDescription` — Like, Comment, Share, Save, Follow, More options, sidebar nav, emoji picker (PT+EN)
  - `browserFillDescription` — Comment textarea selector
  - `browserTypeDescription` — Note: IG uses native textarea, not contenteditable
  - `browserScrollDescription` — Feed, profile grid, reels, comments, explore scroll distances
  - `browserSnapshotDescription` — Scope hints (article, header, main, form)
  - `browserUploadDescription` — New post creation via sidebar
- Total browser MCP tools: 26 → 31.

### Added — LinkedIn MCP Suite
- **LinkedIn browser extractor tools (7 tools)** — Full LinkedIn automation from Claude Code via headed browser. Follows the same pattern as the other social platform extractors.
  - `browser_extract_li_feed` — Feed posts (author, authorUrl, headline, time, text, reactions, commentsCount, mediaType, articleTitle, articleLink, isPromoted, isRepost, postUrl)
  - `browser_extract_li_profile` — Profile page (name, headline, location, profilePic, connections, about, sections[{heading, items}], recentActivity)
  - `browser_extract_li_post` — Single post + comments (author, authorUrl, headline, time, text, reactions, commentsCount, postUrn, comments[{author, text, time, likes}])
  - `browser_extract_li_notifications` — Notifications (text, time, isUnread, url, image)
  - `browser_extract_li_messages` — Messaging (conversations[{name, lastMessage, time, isUnread}], activeThread[{sender, text, time, direction}])
  - `browser_extract_li_search_people` — People search results (name, profileUrl, headline, location, mutual, actionButton, image)
  - `browser_extract_li_network` — My Network (invitations[{name, subtitle, profileUrl}], suggestions[{name, subtitle, followers, profileUrl, action}])
- Total browser MCP tools: 31 → 38.

### Added — Discord MCP Suite
- **Discord MCP tools (8 tools, ~40 actions)** — Full Discord server management from Claude Code. REST-only architecture using Discord API v10 via native `fetch()`, no discord.js dependency, no WebSocket Gateway.
  - `discord_guild` — Server info, list channels/members/roles, audit log
  - `discord_channel` — Create, edit, delete channels (text, voice, category, announcement, forum, stage), set permission overwrites
  - `discord_role` — Create, edit, delete roles, assign/remove from members
  - `discord_message` — Send, edit, delete, pin/unpin, react, bulk delete, list messages
  - `discord_member` — Member info, kick, ban, unban, timeout, nickname
  - `discord_onboarding` — Welcome screen, rules channel, verification level, onboarding prompts
  - `discord_webhook` — Create, edit, delete, list, execute webhooks
  - `discord_thread` — Create, archive, unarchive, lock, delete threads
- **Discord service layer** (`mcp-server/src/services/discord.ts`) — Rate limit handling with retry (429 + Retry-After, max 3 retries), name-or-ID resolution for channels/roles/users, human-readable permission flag mapping to bigint bitfields, in-memory cache with 5-minute TTL, guild ID fallback from env.
- **Discord settings tab** — New "Discord" tab under Connections in Neural Interface settings. Five collapsible sections: Bot Connection (token with eye toggle + test button), Required Permissions (grid + auto-generated invite link), Server Defaults (category, welcome/rules/log channels, mod role), Moderation Defaults (ban delete days, timeout minutes), MCP Tools Reference. All fields auto-save to `.env` with 800ms debounce.
- **Discord API endpoints** — `GET /api/discord/config` reads Discord env vars, `PUT /api/discord/config` saves individual keys to `.env`, `POST /api/discord/test` verifies bot token against Discord API and returns bot info + guild list.
- **Discord blog post** — Published "Making Claude Code Live in Discord" on synabun.ai blog covering the tool suite architecture, REST-only design, and settings tab.

### Added — File Explorer Context Menu & Folder Colors
- **Right-click context menu** — Proper `contextmenu` event handler for both files and folders, replacing the old left-click file menu. Files get: Copy Path, Copy Name, Send to AI, Edit File. Folders get: Copy Path, Copy Name, Send to AI, Change Color, Collapse/Expand, Collapse Children. Menu positions at cursor with panel-bounds clamping.
- **Folder color system** — 9 preset color swatches (amber, blue, green, red, purple, cyan, yellow, brown, grey) in a popup palette. Colors persist in storage (`FILE_EXPLORER_FOLDER_COLORS`) and apply to folder icon SVG fill+stroke. Reset button when a custom color is active.
- **Folder hover actions** — Color dot and copy path buttons fade in on the right side of folder rows on hover. Color dot opens the palette popup, copy button copies the folder path to clipboard.
- **Send to AI** — Context menu item for both files and folders. Opens the Claude Code side panel and pre-fills the input with the file/folder path via new `sendToPanel(text)` export in `ui-claude-panel.js`. Appends to existing input text if present.
- **File left-click opens editor directly** — Files now open the built-in editor on left-click instead of showing a menu. Right-click gets the full context menu.
- **File type icons** — Each file extension gets a distinct colored SVG icon. 10 shape categories: code (`{ }`), markup (`< />`), style (`#`), image (frame), terminal (prompt), document (page+lines), config (gear), lock (padlock), git (branch), database (cylinder). ~50 extensions mapped with language-brand colors (JS yellow, TS blue, HTML orange, CSS blue, Python blue, etc). Special filename detection for Dockerfile, Makefile, .gitignore, .env, LICENSE, README.
- **Context menu dark style** — Restyled to match the Claude panel dropdown: glassy dark backdrop (`rgba(12,12,14,0.98)` + `backdrop-filter: blur(20px)`), 10.5px JetBrains Mono, hover color transitions, 8px radius. Menu opens above cursor (top-right) with automatic flip when near edges.

### Added — Claude Code Skin
- **Multi-session tabs** — Run up to 5 simultaneous Claude Code sessions from the side panel, each with its own WebSocket, message history, attachments, and state. Switch between sessions via compact pills in the bottom toolbar. Pills show active highlight (blue border), running indicator (green pulsing dot), and close button on hover. Single tab hides pills; 2+ tabs reveals them. Tab state persists across page reloads via localStorage. Draft input text saved/restored on tab switch. First message auto-labels the pill. Session history dropdown rebinds the active tab rather than creating a new one.
- **Claude Code Chat skin** — Standalone chat page (`/claude-chat.html`) with project/branch/model selectors, stream-json NDJSON rendering, collapsible tool cards with INPUT/RESULT sections, markdown via marked.js, and abort support. GPT-style layout with SynaBun gold accent branding.
- **Claude Code side panel** — 420px slide-in panel for the main Neural Interface view. Same rendering engine as the chat page. Resizable via drag handle, toggled from navbar. Glass morphism backdrop with smooth slide animation.
- **Session history browser** — Both chat and panel can browse past sessions grouped by time (Today, Yesterday, This Week, Older). Click to load full conversation history with expandable tool cards, tool results, and markdown rendering.
- **Full session history loading** — JSONL parser extracts complete `tool_use` blocks (id, name, input) and `tool_result` entries. History renders full expandable tool cards instead of just tool name summaries. Limit increased to 500 messages.
- **Auto-load history on panel open** — Panel automatically loads conversation history when opened with a saved session, instead of showing a blank state.
- **Persistent monthly cost tracking** — Server-side `data/cost-tracking.json` tracks USD cost per month with query count and session list. `GET/POST /api/claude-skin/cost` endpoints. WS handler auto-tracks cost from `result` events. Display shows "Mar: $1.23" format.
- **File path linking** — File paths in assistant responses (e.g. `src/index.ts:42`) are detected and made clickable. Click copies the path to clipboard with visual feedback. Skips paths inside code blocks.
- **File attachment with validation** — Paperclip button in both chat and panel input areas. Select files to attach — contents are read as text and wrapped as `<file>` blocks in the prompt. Binary file rejection via `isTextFile()` whitelist (~70 text/code extensions). 100KB size limit with warning. File chips with name labels and X remove buttons for managing attachments before sending. Files placed before user text in prompt for better context ordering.
- **WebSocket handler for Claude skin** — `/ws/claude-skin` spawns `claude -p --output-format stream-json --verbose` as subprocess. Streams NDJSON events to browser, handles abort, cleanup, and env variable filtering.
- **Slash command support** — Server-side skill injection for `-p` pipe mode (which doesn't support skills natively). `resolveSkillPrompt()` reads SKILL.md from bundled or global skills directories, replaces `$ARGUMENTS`, wraps in `<skill-instructions>` XML tags. Client-side autocomplete dropdown fetches from `/api/claude-code/skills` — type `/` to see available skills, filter by prefix, Tab/click to complete, arrow keys to navigate.
- **AskUserQuestion interactive cards** — Pipe mode delivers AskUserQuestion as `tool_use` blocks instead of `control_request` events. `buildAskFromToolUse()` intercepts these and renders interactive option buttons with question headers. Dual response path: sends `control_response` if a pending control request ID exists, falls back to `tool_result` format. Supports both single-select and multi-select questions.
- **Image preview strip** — Clipboard paste and drag-and-drop images show as 48px thumbnail previews above the input area with X remove buttons. Drag-and-drop overlay on the input area. Images in tool results (`type: 'image'` content blocks) render as inline `<img>` elements instead of raw base64 text.
- **Partial message streaming** — `--include-partial-messages` now works correctly. Tracks `_currentMsgId`/`_currentMsgEl` so partial events with the same message ID update the existing DOM element instead of creating duplicates. Reset on turn completion.
- **Keyboard shortcuts** — Ctrl+L clears messages, Escape aborts running query, arrow keys + Tab for slash hint navigation.
- **Focus animation** — Conic-gradient spinning border glow on the input wrap when focused. White color scheme (`rgba(255,255,255,...)`) with smooth opacity transition and `cp-border-spin` keyframe animation. Background and box-shadow shift to subtle white on focus-within.
- **Textarea expand on focus** — Input textarea grows from 120px to 280px max height when focused, with smooth CSS transition. `autoResize()` respects focus state for dynamic height cap. Shrinks back on blur.
- **Claude skin test suite** — 133 tests across 9 files covering WS handler, JSONL parsing, NDJSON buffering, event routing, tool rendering, cost tracking, session flow, history loading, and file attachment validation. 3 custom mocks (child-process, WebSocket, JSONL builders).

### Added — Workspace Toolbar Icons
- **Memory Explorer toolbar button** — New icon in the top-right workspace toolbar (`#topright-controls`) that toggles the memory explorer panel. Uses a neural/sun SVG icon. Active state highlights when panel is open.
- **File Explorer toolbar button** — New icon in the workspace toolbar that toggles the file explorer panel. Uses a folder SVG icon. Active state highlights when panel is open.
- Both buttons sit between the keybinds button and the workspace pill, matching existing `topright-icon-btn` styling.

### Fixed — Resume Sessions Missing from Dropdown
- **24 sessions invisible due to 16KB buffer truncation** — `extractSessionMeta` read only the first 16KB of each JSONL session file. Sessions starting with `progress` or `queue-operation` lines (~800 bytes) followed by a user message line containing embedded CLAUDE.md, MCP tool definitions, and system-reminders (17KB–560KB) had their user message truncated mid-JSON. `JSON.parse` failed silently, permanently hiding those sessions. Replaced fixed buffer with chunked 64KB reads that accumulate complete newline-terminated lines before parsing (1MB max).
- **Refresh button in Resume dropdown** — New circular-arrows icon button next to the index button in the search bar. Clears the server's in-memory session cache and forces a full JSONL re-scan. Spins while loading.
- **Server-side refresh param** — `GET /api/claude-code/sessions?refresh=true` clears `_sessionCacheMap` to force complete re-discovery of all session files.

### Fixed — Floating Terminal Z-Index
- **Restored terminals appearing behind other floating windows** — `restoreTab()` did not update z-index when restoring a terminal from its minimized pill, so it kept its old z-index (base 10000) while other windows had incremented higher. Now calls `bringTabToFront(sessionId)` during restore to assign the next highest z-index, ensuring restored terminals always appear above all active floating windows.

### Fixed — Greeting System
- **Greeting suppressed by stale loop files** — The SessionStart hook's loop detection only checked file mtime (10-minute window), not whether the loop was actually still running. A finished loop with `stopped: true` and `finishedAt` set would still suppress the greeting if its mtime was recent. Now reads the pending file JSON and skips files where `stopped === true` or `finishedAt` is set.
- **Greeting missing for projects without config** — The `if (projectConfig)` guard meant no greeting was generated when a project had no entry in `greeting-config.json` and the global/defaults chain returned null. Removed the guard — now falls back to a hardcoded default template with project name and branch.
- **All registered projects now have greeting configs** — Added `synabun` and `synabun-website` entries to `greeting-config.json` alongside the existing `criticalpixel` entry. Synabun gets Neural Interface and MCP build reminders.
- **Auto-create greeting config for new projects** — When a project is registered via the Neural Interface (POST `/api/claude-code/integrations`), a greeting config entry is automatically created in `greeting-config.json` using the defaults template, `showLastSession: true`, and empty reminders. No more silent fallback to the bare global template.

### Fixed
- **MCP tools broken in Claude skin** — `--strict-mcp-config` flag was blocking ALL user/project MCP servers including SynaBun. Removed it — `CLAUDECODE` env variable stripping already prevents recursive MCP initialization.
- **Binary file attachment corrupting NDJSON stream** — Attaching binary files (images, etc.) via paperclip sent raw binary as prompt text, corrupting the stream-json pipe. Added `isTextFile()` whitelist, 100KB size limit, and server-side log truncation (80 chars max for spawn args).
- **Close button placement** — Moved from toolbar-right to the header row alongside the session selector, aligned right with `margin-left: auto`.
- **Stop hook edit counter not resetting** — `post-remember.mjs` conversations branch wasn't resetting `editCount`, `files`, `firstEditAt`, `lastEditAt` after remember calls, causing the Stop hook to keep blocking indefinitely. Now resets all tracking fields consistently across both code paths.

## 2026-03-08

### Added
- **Git controls in file explorer** — Branch button sits inline next to the project selector. Clicking it opens an animated popover with branch switching (via `git checkout`), a commit input with one-click commit, and a color-coded change summary (modified, added, deleted, untracked). Popover slides in with scale+opacity transition and an arrow pointing back at the button.
- **Auto-generate commit message** — Star button in the commit popover analyzes `git diff --stat`, counts added/removed lines, and generates a commit message from file names and change types.
- **Git API endpoints** — `GET /api/git/status`, `POST /api/git/commit`, `GET /api/git/diff-summary` for the new git UI.
- **Syntax highlighting in code editor** — Monochrome gray-blue palette with dark gold brackets and olive-green italic comments. Regex-based tokenizer with per-language rules for JS, TS, Python, JSON, CSS, HTML, Shell, SQL, YAML, TOML, Rust, Go, Ruby, and ENV. Uses textarea overlay technique (transparent text + colored `<pre>` behind). Viewport-based rendering for large files — only highlights visible lines plus buffer, re-renders on scroll.

### Fixed
- **Focus mode logo centering** — Logo and breathing effect now center horizontally relative to the content area when the memory explorer or file explorer sidebars are open. Uses `--sidebar-total-width` to account for both panels. Whiteboard and toolbar remain unaffected.
