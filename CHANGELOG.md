# SynaBun v.2026.07.20

Two months of work focused on native agent workflows, safer concurrent automation, broader browser tooling, and a much more resilient Neural Interface.

## ✨ New

- **Native automation sidepanels** — Claude Code, Codex, and OpenCode loops and schedules now run in their native SynaBun sidepanels instead of terminal PTYs, with faster launches, background execution, and correct focus for manual runs.
- **Claude Code Agent SDK engine** — The Claude sidepanel now delivers full CLI-style sessions with tool calls, permissions, plan review, multiple tabs, account-safe ownership, and restored-session support.
- **Bluesky MCP tools** — A new 15-tool AT Protocol suite covers feeds, search, profiles, threads, notifications, DMs, posting, images, engagement, and moderation through the logged-in `bsky.app` session.
- **MoreLogin browser support** — MoreLogin anti-detect profiles are now a first-class browser backend, with profile management in Settings and an MCP action tool for status, creation, start, stop, and default-profile selection.
- **Reference-based browser snapshots** — AI browser sessions can work from compact element references instead of repeatedly consuming full page snapshots, cutting tokens while keeping interactions deterministic.
- **Session-scoped MCP profiles** — Codex tabs, OpenCode sessions, loops, and schedules can own isolated tool profiles that switch in place without changing another runtime or the default for future sessions.
- **Codex workflow upgrades** — Added project-aware `@` file mentions, multi-account switching and resume, inline plan refinement, persistent MCP approvals, interactive SynaBun choices, live model metadata, and dynamic reasoning controls.
- **Stronger scheduling controls** — Added queue visibility, cross-group mutual exclusion, group-level launch overrides, per-launch OpenAI accounts, and shared runtime options across Automation Studio and Schedules Studio.
- **Current Claude model lineup** — Added selectable 1M-context variants across launchers, Claude Sonnet 5, Fable 5, and Opus 4.8, while keeping legacy saved selections compatible.

## 🛠 Fixed

- **Cross-session isolation** — Codex and OpenCode events, transcripts, child agents, approvals, tabs, projects, and accounts no longer leak into unrelated sidepanels or resumed sessions.
- **Concurrent browser automation** — Server-authoritative tab ownership now keeps loops, schedules, agents, and interactive sessions on dedicated tabs; recovery repairs wedged pages without stealing or destroying another automation’s work.
- **Schedule reliability** — Run Now launches no longer queue silently, missed jobs recover after macOS clamshell sleep, automatic runs stay in the background, and startup failures are persisted and shown instead of disappearing.
- **Agent interaction deadlocks** — Fixed permission stalls, premature prompt rejection, broken plan-approval actions, missing tool results, and loop hangs after transient API or socket errors across Claude, Codex, and OpenCode.
- **Codex resume and MCP recovery** — Resumable sessions are discovered across every configured account, stale entries are filtered out, MCP startup errors stay contained, and authentication can be completed directly from the failure notice.
- **Crash and corruption paths** — Fixed Playwright lifecycle crashes, graph-link heap exhaustion, `onnxruntime-node` shutdown failures, frozen supervised logs, and backup replacement errors in macOS-protected folders.
- **Sidepanel usability** — Streaming transcripts respect manual scrolling, scrollbars are easier to grab, project menus stay above terminals, and plan or permission cards no longer duplicate or become unresponsive.

## ⚙️ Improved

- **Safer application data** — Mutable state now lives outside the Git checkout by default, with verified migration, conflict detection, `synabun doctor`, rotating checksum-verified backups, recovery tooling, and automatic MCP client path repair.
- **Neural Interface performance** — Memory Explorer virtualization, faster file-tree scanning, shared debounce/throttle utilities, idle render-loop pausing, cheaper graph interactions, reduced screencast work, and lower-cost terminal rendering improve large projects and long sessions.
- **Browser lifecycle diagnostics** — MoreLogin/CDP teardown, pinned-tab recovery, co-ownership, route validation, and failure reporting now fail closed and expose clearer recovery state.
- **Automation throughput** — Leaner iteration delays, reusable Facebook composer-state probing, full-content memory fetch by ID, and more efficient browser typing/snapshot guidance reduce repeated work and token use.
- **Accessible UI polish** — Added global reduced-motion support, refined navigation styling, responsive permissions layouts, and smoother window dragging, resizing, tooltips, and detail cards.

Detailed technical notes: [v.2026.07.20-RAW.md](changelog/v.2026.07.20-RAW.md)
