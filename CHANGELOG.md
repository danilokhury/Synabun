# SynaBun Changelog

Raw internal changelogs are archived in [changelog/](changelog/).

## New Features

- **Dedicated Schedules studio** — Standalone window with Cron, Timers, Groups, and Activity tabs. Pulls schedule management out of the Automation Studio detail pane and adds cron presets, timezone, day selection, group assignment, and per-schedule launch overrides (profile, model, effort, MCP profile, browser).
- **Schedule groups** — Group recurring schedules with full CRUD endpoints and ordering. Group membership and launch metadata persist with each schedule.
- **Claude Code plugin install from MCP UI** — Settings > MCP > "+ Install from GitHub" auto-detects whether a repo is an MCP server or a Claude Code plugin and installs via the `claude plugin marketplace add` + `claude plugin install` flow. Plugin slash commands surface in the sidepanel `/` autocomplete with a `(plugin: <name>)` suffix.
- **Installed MCPs cross-CLI sub-tab** — Settings > MCP now has a unified "Installed" view aggregating servers across SynaBun, Claude Code, Gemini, Codex, and OpenCode with per-CLI badges (SB/CC/OC/CX/GE) and one-click cross-CLI uninstall.
- **CLI-not-installed banner across sidepanels** — Claude, Codex, and OpenCode panels detect missing or broken CLI binaries (including spawn-failure patterns like `ENOENT` or `app-server exited`) and render a sticky orange banner with the install command, docs link, and Re-check button. Send button is gated until the CLI is detected.
- **Workspace trust flow for Windows** — Amber **Trust workspace** prompt in both the file explorer and onboarding wizard when Windows flags a repo with "dubious ownership."
- **One-click CLI install toggles** — Onboarding Step 5 now exposes live install toggles for Claude Code, Gemini CLI, Codex CLI, and OpenCode. Cursor/Windsurf live in a collapsible JSON section.
- **OpenCode panel greeting** — Fully isolated greeting config for OpenCode, separate from Claude and Codex state.
- **Multi-CLI Resume with provider picker** — Resume dropdown switches between Claude, Codex, Gemini, and OpenCode sessions via a pill bar.
- **Hybrid session content search** — SQLite FTS5 full-body search combined with semantic embeddings (Claude). Sidepanel session menus surface match-kind pills ("strong match," "related") with highlighted snippets.
- **GitHub MCP installer** — Settings > MCP > "From GitHub" clones a repo, auto-detects MCP config, installs dependencies, and pre-fills the form. Includes central env vault, auto profile registration, and sensitive-key masking.
- **Multi-runtime skills** — `/synabun` and `/leonardo` install independently to Claude, Codex, and OpenCode via per-target chips in Settings.

## Schedules

- **Live ticking countdown on schedule cards** — Replaced static "Next: 4h" with a 1-second-tick adaptive countdown (`2d 3h`, `4h 23m`, `15m 42s`, `Overdue`). Tabular-nums styling prevents layout jitter.
- **Edit prompt shortcut on schedule cards** — New script icon between Run Now and Edit Schedule jumps directly to the linked automation template in detail view.
- **Quick timer controls** — Quick timer creation, run-now actions, active timer countdowns, saved schedule timers, plus pause/resume, trigger, edit, and delete from inside the schedules window.
- **Automations submenu expanded** — Added Schedules, New Cron Schedule, Quick Timer, and Schedule Groups menu items that open the dedicated schedules window directly to the requested flow.

## Front End / Sidepanel UI

- **Sidepanel tray placeholder pills** — Saved Claude / Codex / OpenCode tabs render as minimized pills before the provider panel has been lazy-loaded; clicking opens the matching provider with the selected tab preserved.
- **Codex effort and response controls expanded** — Codex footer effort toggle now supports `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Settings expose `model_reasoning_summary` (auto/concise/detailed/none) and `model_verbosity` (low/medium/high).
- **Slash-hints dropdown polish** — Larger 320 px max-height, no longer clipped by the input wrapper, and `overscroll-behavior: contain` so wheel scroll inside the dropdown doesn't bubble to the message list. First `/` keystroke now reliably shows the dropdown even before the skills cache loads.
- **Unified context gauge** — Single-fill bar across Claude, Codex, and OpenCode with threshold-based color (gray → amber >60% → red >80%). OpenCode gauge now uses model-specific context windows with full token breakdown.
- **OpenCode agents drawer redesign** — Gradient backdrop, color-coded subagent type chips, shimmering init placeholder, per-agent ✕ abort button, and amber stop button with pulse. Expandable inline step view with live in-place elapsed timer.
- **OpenCode tool activity dock** — Floating left-edge dock lists every tool call; click a row to scroll to the card. `Ctrl/Cmd+Shift+A` toggles.
- **OpenCode permission cards** — Now show the actual tool (bash/edit/write/read/webfetch), command or path, matched patterns, and expandable diff instead of a generic "Permission request" chip.
- **Claude sidepanel view mode picker** — Normal / Transcript / Focus now visible on the project bar instead of only via `Ctrl+O`.
- **TODO widget → left-edge slide-out drawer (Claude)** — Tag docks on the edge when todos exist; click to expand. Per-tab persistence; `Ctrl+T` toggles.
- **New session modal rebuilt** — Centered overlay on "+" with Project, Branch, and Name fields. Branch checkout defers to Save. Applies to Claude, Codex, and OpenCode.
- **Codex sidepanel feature parity** — Model selector, effort toggle, plan mode, auto-accept, image attachments, file-path chips, hold-to-talk voice, slash hints, FIFO prompt queue with drag-reorder, copy buttons, thread fork/archive, settings overlay, stall detection, auto-compact. Fully isolated from the Claude panel.
- **Session menu overhaul (Claude + Codex)** — Sticky search, "Hide empty" / "Archived" filters, per-item archive/unarchive, Claude branch dropdown, and infinite scroll.
- **Multi-question cards** — All questions from one `AskUserQuestion` call render in a single card with multi-select, "Other" custom-answer inputs, and `Submit (x/y)` progress (OpenCode + Codex + Claude).
- **Syntax highlighting, file-path linkification, language labels, hover-only copy buttons** — All across OpenCode code blocks.
- **Throttled streaming + live thinking** — 32ms render throttle during streaming; thinking blocks update in real time.
- **MCP Settings toggle matrix** — Replaced drag-and-drop pill system with a clickable permission grid: tool groups as rows, profiles as columns.
- **Universal MCP add form** — Smart-paste textarea auto-detects 5 config formats; multi-platform sync registers a server to every selected CLI in one action.
- **Capability badges & filters (OpenCode)** — 9 colored pills (Reason, Tools, Vision, Audio, Video, PDF, ImgGen, TTS, Files) per model, with filter pills in chat dropdown, Models, and Providers settings.
- **AskUserQuestion polish** — Consistent card spacing, always-available custom-answer input, multi-select square checkboxes, and "Select all that apply" hint text.

## Terminal & Rendering

- **Stable xterm DOM renderer for long CLI sessions** — Skips `addon-webgl` / `addon-canvas` to avoid WebGL atlas/context corruption seen across multiple long-lived floating CLI sessions. Output writes are serialized into 64 KB chunks with backpressure.
- **Snapshot-based reconnects** — Per-PTY virtual-terminal buffer (with alt-buffer support) replaces arbitrary raw-ANSI tail replay on reconnect, so reconnects render correctly without replaying mid-frame escape sequences.
- **Single xterm renderer** — Collapsed the legacy HTML terminal renderer (~2,400 lines removed). All CLI profiles route through xterm + WebGL with Canvas fallback.
- **Long-session rendering glitches fixed** — Periodic texture-atlas pruning, coalesced resize fits, 64 KB output-burst cap, ordered WebGL dispose on close, Windows ConPTY hint, and post-open fit+refresh for fresh and resumed sessions.
- **Terminal tab close/detach reliability** — Enlarged hit targets and suppressed redundant re-renders so the × and detach icons land during CLI streaming.
- **Banner no longer doubles on reconnect** — PTY buffer replay now resets the xterm before paint. Ink splash screens render once.
- **Boot flicker eliminated** — PTY launches at the real viewport size instead of 120×30, removing the SIGWINCH redraw and stray zsh `%`.
- **Floating terminal Escape forwarding** — Raw `\x1b` now reaches OpenCode when the floating window is focused, restoring cancel/close behavior.

## Automation Studio

- **Loop launch no longer hangs on orphan Chrome** — Pre-launch sweep kills stale `user-data-dir` Chromiums (Unix `pgrep -f` + `SIGKILL`, Windows PowerShell + `taskkill`) before relaunching. A 45 s `launchPersistentContext` timeout acts as a final safety net.
- **Loop tab isolation hardened** — `SYNABUN_BROWSER_TAB` env now wins over caller-supplied `tabId` so an agent or model can't accidentally leak into another loop's tab. Removed the active-tab churn from concurrent loop launches.
- **Codex loop fast-fail detection** — Iteration sentinel now captures exit code and per-iter duration. Three consecutive non-zero exits or sub-30 s iterations stop the loop with `fast-fail-rc` / `fast-fail-duration` instead of running ghost iterations.
- **Zombie loop file fix** — PTY exit handler now marks the on-disk loop file `active: false` with `stoppedReason: 'pty-exit-<code>'`, ending phantom-running loop UI state.
- **Diagnostic alerts when toast host is offscreen** — Loop attach and confirm-launch failures fall back to a browser `alert()` when the terminal panel is hidden, so the error reaches the user instead of disappearing into an invisible toast.
- **User-created folders in sidebar** — Collapsible folders with name, color, and icon. Drag-and-drop to move templates, right-click for rename/recolor/delete. Included in backup/restore and export/import.
- **Per-template launch defaults** — Each template remembers CLI, model, thinking effort, and MCP profile. Launch modal pre-selects the preset.
- **OpenCode CLI as fourth option** — Alongside Claude, Codex, Gemini with a curated model list.
- **Runtime card cleanup** — CLI, Model, MCP Profile moved from chips to native selects in a 2-column "Runtime" layout. Labels no longer truncate.
- **Per-loop stop** — Stop button targets a specific loop instead of killing every running automation.

## CLI Integrations & MCP

- **Auto-repair of legacy plugin installs on startup** — Purges old `synabun-symlink` marketplace entries and reinstalls via the Claude Code CLI so installs survive CC restarts. `POST /api/plugins/repair` triggers the same flow manually.
- **Self-fetching runtime preflight** — `uvx`, `pipx`, `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, etc. no longer trigger local dep installs. Missing binaries surface OS-specific install hints (`brew install uv`, winget, etc.) instead of failing silently at launch.
- **GitHub MCP installer no longer discards servers on dep failure** — Local `pip install` / `npm install` errors are now soft warnings; the server still registers and the user sees a `⚠` line in the install form.
- **Codex MCP approval respects per-tab Auto state** — The silent MCP accept path is now gated on the visible tab's Auto toggle and travels with each query, preventing background accept of `mcp__SynaBun__remember` and similar tools when Auto is off.
- **Unified update commands** — OpenCode, Claude Code, Codex, and Gemini CLI all update via `npm install -g <package>@latest`, plus OpenCode's built-in `opencode upgrade` fallback.
- **Codex Settings wired to SDK** — Config read/write via correct RPCs; model, reasoning effort, approval policy, sandbox mode, and web search read from a cached effective config. Layer badges (`user` / `project` / `default`) per field.
- **Codex MCP env fix** — Added `DOTENV_PATH`, `SYNABUN_DATA_HOME`, `MEMORY_DATA_DIR` so the server finds its data directory.
- **OpenCode OAuth flow repaired** — Authorize body now sends `{ method: idx }`, auth buttons only render when methods actually exist, save/failure toasts added.
- **Native skills cross-runtime** — `/synabun` and `/leonardo` no longer hard-depend on `AskUserQuestion` or Claude-only tool names.
- **MCP server add on Windows** — `claude mcp add` command fixed: removed `--` separator, properly quotes `-e "KEY=VALUE"` pairs across PowerShell shims.

## Memory / Plan / Session

- **"Continue planning" action across OpenCode, Codex, and Claude** — Post-plan card now offers Continue planning alongside Continue / Edit / Compact, allowing iterative plan refinement without exiting plan mode.
- **Codex plan mode handoff hardened** — Post-plan actions persist across tab state, plan turns run read-only server-side, and the prompt prefix instructs Codex to stop after producing the plan and wait for the sidepanel choice.
- **Plan files reorganized** — Plans now live in `data/plans/YYYY-MM-DD/slug.md` with descriptive kebab-case names. Legacy flat plans auto-migrate. Root `PLAN.md` is cleaned up on ExitPlanMode.
- **Recall output always shows full metadata** — Tags, related files, and source always appear (with `none` fallback instead of being omitted).
- **Session cache & cross-provider discovery** — Codex and OpenCode session discovery endpoints added; Claude paginates server-side, Codex/OpenCode virtual-paginate from SQLite.
- **Claude sidepanel cross-talk fix** — Orphan registry now keys by `windowId:sessionId` so multi-tab disconnects can't hand the wrong process to a reconnecting tab.

## Backup & Restore

- **Backup coverage expanded** — Auto and manual backups now include `stored-plans.json`, `synabun-plugins.json`, `mcp-registry.json`, `active-profile.json`, and the recursive `data/plans/YYYY-MM-DD/*.md` plan tree. Backward compatible with old backups (`version 1 || 2`).

## Automation & Browser

- **Browser session ownership model** — `_loopOwned` / `_agentOwned` flags with registry cross-checks prevent loops and sidepanel Claude from fighting over the same tab. Pinned sessions auto-recover if destroyed.
- **Browser tooling upgrades** — New `browser_cheatsheet` tool replaces bloated per-platform descriptions. `browser_snapshot` adds `interactive` / `landmarks` modes and viewport filtering. `browser_navigate` / `click` / `scroll` can return a snapshot in one call. Failing selectors auto-heal via a `textHint` param.

## Stability & Fixes

- **High and moderate npm audit CVEs patched** — Bumped `playwright` to ^1.59.1 (SSL cert verification CVE) and `uuid` to ^14 (buffer bounds), and added `overrides` for `lodash`, `protobufjs`, `hono`, `@hono/node-server`, `postcss`, and `vite` across both Neural Interface and MCP server packages. `npm audit` now clean.
- **Codex sidepanel cross-talk fix** — Per-tab WebSocket identity (every message stamped with `sessionId`), strict orphan reattach keys (`windowId + sessionId`), and reconnect-state cleanup prevent buffered tool-call events from one tab replaying into another.
- **Codex sidepanel stop scope** — Stop button now aborts only the active tab instead of every running Codex tab; server validates `sessionId` / `threadId` on `interrupt` / `force_kill` and refuses unscoped stop messages.
- **OpenCode post-plan card no longer resurrects** — `setTabMode()` clears the post-plan flag on `plan → non-plan` transitions and the renderer guards on `tab.mode === 'plan'`, so a leaked flag can't re-render the PLAN COMPLETE card after the user moved to implementation.
- **Codex edit-plan cancel handoff** — Closing the file editor without saving now re-renders a fresh clickable post-plan card; saving reopens the PLAN UPDATED handoff correctly.
- **Right-side toolbar reservation tracks all owners** — Per-owner reservation map prevents one closing sidepanel from clearing layout while another right panel is still active.
- **Restored Claude tabs keep stable IDs** — Sidepanel tray placeholder click-through targets the restored tab instead of losing selection because the panel generated a fresh UUID during bootstrap.
- **Stop button + ESC reliability** — Abort works from anywhere in the Claude, Codex, and OpenCode panels, cancels in-flight fetches server-side via AbortController, and covers every running tab.
- **Orphan grace extended to 30 min** — Claude and Codex processes no longer die during brief WebSocket drops (sleep, network, tab throttling). Added server-side ping/pong keepalive.
- **1M context window activation** — The `[1m]` model-ID suffix is now applied correctly so Opus/Sonnet 1M variants actually use the 1M beta window.
- **Plan mode flow fixes** — Answers to `AskUserQuestion` in plan mode are now re-injected per-question instead of collapsed into one comma-joined string. Plan-approval card fires at detection, not after implementation streams. Process is killed on ExitPlanMode so buffered tool calls can't execute before the user approves.
- **Blank assistant row pivot fix** — Claude no longer leaves an empty bubble when an assistant message contains only tool calls or whitespace-only text.
- **"DONE" toast no longer fires mid-turn (OpenCode)** — Completion notifications wait for the real `session.idle` event.
- **Git UI on large-status repos** — `git status` no longer throws on repos with tens of thousands of changes; branch button and git popover render even when parsing fails.
- **Notifications permission status** — Updates live when the user unblocks browser notifications, with a manual Re-check button.
- **CLI notification spam suppressed** — Repeated OS notifications during long AskUserQuestion / permission prompts dedupe until the session returns to idle.
- **Concurrent agent/loop browser sessions** — Ownership flags set immediately on creation; grace timer uses in-memory ownership checks instead of racy file reads.
- **Neural Interface crash on Playwright dialog race** — `No dialog is showing` ProtocolError now ignored alongside frame-detached errors.

## Windows Support

- **Git UI reliability** — Resolved silent failures from PATH shims, old Git versions, and cmd.exe quoting. Works across Scoop, winget, and older Git for Windows, with a startup probe that surfaces problems.
- **CLI auto-detect after reinstall** — Detection commands now run with an augmented PATH including `~/.local/bin`, `/usr/local/bin`, `~/.npm-global/bin`.
- **Native dropdowns in dark mode** — Added `color-scheme: dark` so Windows Chrome/Edge stop rendering native `<select>` popups with white backgrounds.
