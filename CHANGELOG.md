# SynaBun v.2026.07.30

A point release on top of 2026.07.20, focused on correct Claude Code model selection, a new project storage cleanup tool, and a stricter default browser policy.

## ✨ New

- **Live Claude Code model discovery** — The model list is now read from the installed Claude Code CLI at runtime rather than from two hand-maintained lists that had drifted out of date. Adds `GET /api/claude/models`, and `/api/claude/config` now reports a `modelsSource`. Every picker is covered: sidepanel, standalone chat, Automation Studio, Schedules Studio, and the resume/provider picker. Discovery falls back to a small static list when the CLI cannot be reached.
- **Project storage cleanup** — A new Projects area in Settings measures and clears build, test, cache, and dependency directories across macOS, Windows, and Linux, backed by admin-only `GET`/`POST /api/settings/project-storage` endpoints. Git-tracked files, nested repositories, SynaBun's own runtime dependencies, incomplete scans, and broad cache roots all fail closed, and cleanup revalidates the complete selection before deleting anything.
- **`xhigh` thinking is reachable** — The CLI has advertised `low/medium/high/xhigh/max` for some time, but `xhigh` was being filtered out at six spawn sites, including the engine the sidepanel actually uses. All six now share one effort list, and models that advertise no effort levels disable the toggle instead of passing a flag the CLI ignores.

## 🛠 Fixed

- **First launch after an update could look frozen** — The pre-update snapshot protects your data home before a new version starts, but it ran silently, so on a large data home there was nothing on screen for long enough that the upgrade looked hung and got killed — and an interrupted run left a partial archive behind that nothing reclaimed. The snapshot now reports its collect, checksum, archive, and verify phases with file counts and sizes; skips `data/youtube-downloads`, a re-downloadable cache rather than user state; stores already-compressed payloads instead of spending full CPU deflating video and images for no gain; and reclaims temporary files orphaned by an interrupted run. On a 1.8 GB data home this took the snapshot from 17.8s and 543 MB to 9.7s and 172 MB.
- **Sidepanel launched Opus 4.8 when Opus 5 was picked** — The model picker read its list from the standalone Claude Code CLI, while sidepanel chats ran on the Agent SDK's own bundled CLI. Both accept the same alias selectors and each resolved them against its own model table, so the picker could show one model while the session launched another. `@anthropic-ai/claude-agent-sdk` moves `0.3.174` → `0.3.220` so both sides resolve identically, and a version skew between the two is now reported instead of passing silently. Takes effect after a server restart, not just an install.
- **Claude model pricing** — Corrected against published list prices. Opus 5 was missing from the table entirely and fell through to a Sonnet fallback, while the Opus and Fable rows were inflated roughly 3x. Displayed cost for past Opus and Fable sessions drops accordingly and now tracks what was actually billed.
- **Coexistence ruleset preview included neighbouring sections** — The extraction boundary matched an LF-only marker that was absent from the template's CRLF section, so the preview could return the condensed rulesets alongside the requested coexistence rules. It now stops at a stable heading.
- **Duplicate OpenCode model names in schedule selectors** — Group launch-override and Cron schedule editors now render provider-aware `Model — Service` labels while preserving the stored selector value.

## ⚙️ Changed

- **The SynaBun browser is the default public-web path** — Public-web browsing, search, and page retrieval now go through the configured SynaBun browser. Other web tools require an explicit request, and agent-facing Playwright and Chrome DevTools default to localhost and loopback testing. Unavailable browser access is reported rather than silently substituted. All five provider rulesets move `1.0.0` → `1.1.0`, so existing users are notified to refresh their defaults.

---

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
