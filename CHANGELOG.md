# SynaBun v.2026.09.05

A Claude Code model release: the model picker stops quietly serving a stale built-in list, sidepanel sessions run the model the picker actually offered, and Fable 5.1 is priced correctly.

## 🛠 Fixed

- **The Claude model picker silently served a static fallback list** — Model discovery spawns the Claude Code CLI to read its live model table, and that spawn goes through a shell whenever the resolved binary is a bare command name rather than a full path. A shell concatenates its arguments instead of passing them through, so the empty string in `--setting-sources ''` vanished, the CLI exited with `option '--setting-sources <sources>' argument missing`, and discovery came back empty. The flag is now a single `--setting-sources=` token, which survives both spawn paths. The failure was invisible by design: an empty result falls back to a four-entry list of unversioned aliases with no Fable entry at all, so the picker looked merely out of date rather than broken.
- **Discovery missed a Claude CLI installed outside the login shell's `PATH`** — SynaBun is routinely started from Finder or launchd with a minimal environment, where a CLI in `~/.local/bin`, Homebrew, Bun, or an npm global prefix is invisible. The same `PATH` augmentation the rest of the server already used is now applied to the model-discovery and version probes, so those installations are found.
- **The sidepanel offered Fable 5.1 but ran Fable 5** — The picker reads the CLI you have installed, while sidepanel chats run the CLI bundled inside `@anthropic-ai/claude-agent-sdk`. The two had drifted apart, and the older bundle's model table knows only `claude-fable-5` — so choosing Fable 5.1, or the `fable`/`best` aliases, quietly launched Fable 5 with no symptom beyond the model naming a different version of itself. The SDK is bumped `0.3.220` → `0.3.258` to close the gap. The guard test that exists to catch exactly this had been passing vacuously, because it probed for a CLI under the un-augmented `PATH` and skipped whenever it could not find one; it now runs on the machines it was written to protect.
- **Fable 5.1 sessions reported the wrong cost** — With no pricing row of its own, `claude-fable-5-1` fell through to the Sonnet fallback and understated input and output by roughly 3.3x. It now carries its own rates, which are deliberately not a copy of the Fable 5 row: same input and output pricing, cheaper cache reads.

---

# SynaBun v.2026.09.01

A Codex and memory-hooks release: Codex sidepanels no longer strand `already has an active writer` errors across tab switches, thread history moves off Codex's deprecated hydration path, and the Claude Code memory hooks stop re-issuing a block they were never able to clear.

## 🛠 Fixed

- **The "Unstored file edits" block never cleared** — A `remember` call without a `category` reset nothing, because the entire pending-remember reset was gated behind a branch that Claude Code rarely reaches: it routinely sends `remember` with `{ content }` alone. The flag was never cleared, so the Stop hook re-issued the identical block on every turn for the rest of the session — confirmed against a real session flag showing `rememberCount: 0` after four successful `remember` calls. The reset is now unconditional for any successful `remember` or `reflect`. Failure detection fails open by design: only an explicit `isError` / `success: false` / `status: "error"` counts as a failure, so a future payload change cannot silently reintroduce a block that never clears. A new `MAX_TASK_BLOCKS` session ceiling bounds the worst case.
- **Edit nudges never reached the model** — Every PostToolUse nudge was written as a bare top-level `{ additionalContext }`, but PostToolUse only reads `hookSpecificOutput: { hookEventName, additionalContext }`. The output was valid JSON, so it failed silently rather than erroring, and no "N file edits — remember to store this work" message was ever delivered. Fixed in `post-remember.mjs`, and in the five emission sites in `post-plan.mjs` that had the same bug — all now routed through one shared helper.
- **`reflect` was excluded by the hook matcher** — `post-remember.mjs` already handled `reflect`, but the registered PostToolUse matcher ended at `remember`, making that code unreachable: `reflect` calls never reached the hook. The matcher now covers both, anchored so it still never fires for `recall`, `memories`, or `forget`, and matches both Claude Code's `mcp__SynaBun__remember` and OpenCode's `SynaBun_remember` spelling.
- **Every hook invocation stalled about two seconds** — `readStdin()` resolved promptly, but its 2000 ms fallback timer stayed pending afterwards and held the event loop open, so each hook lingered for the full timeout before exiting — measured at 2.05 s against a configured 3 s hook timeout. Clearing and unref-ing the guard brings it to 0.02 s across every hook.
- **Memories were filed under the wrong project** — The MCP server read `claude-code-projects.json` from a data directory that has never existed, so registered project labels were silently ignored and every project fell back to a raw directory basename — `/Apps/EllaCred` was stored as `ellacred` rather than the registered label `elacred`. Over the HTTP transport `process.cwd()` is the Neural Interface's own directory, which labeled every HTTP-sourced memory `neural-interface` regardless of the caller; that case now resolves to `global`, a recoverable mislabel rather than one indistinguishable from a real project.
- **Codex sidepanels stranded "already has an active writer"** — A tab's intentional socket close was invisible to the server, so it orphaned an idle Codex app-server for the full 30-minute grace period and the next `thread/resume` collided with SynaBun's own abandoned writer. Ownership is now handed back through a release handshake before the socket closes, retirement waits for observed process exit rather than a kill flag, and only connections with genuinely reattachable work — active turns, pending approvals, in-flight RPCs — keep the grace period. Rapid tab switching can no longer strand or resurrect a hidden writer, and a genuinely external writer still reports an actionable error instead of requiring a restart.
- **Codex thread history rode a deprecated hydration path** — Full history was requested through `thread/read` and `thread/resume`. SynaBun now rebuilds the same client shape by paging `thread/turns/list` and `thread/items/list` in chronological order, and falls back to paginated turns with `itemsView: "full"` when a store reports that item pagination is unsupported. Repeated cursors, invalid pages, duplicate ids, and items with no matching turn are rejected before they can loop or poison a transcript; timeouts and unrelated protocol failures still surface rather than being misread as compatibility gaps.
- **The Codex Resume dropdown blocked on a full account scan** — It now serves from the cached session catalog when rows exist and refreshes in the background, falling back to a full multi-account walk only when the cache is cold; the same cached catalog backs Codex search metadata. Windows path matching resolves with `path.win32` and compares case-insensitively, so drive-letter case and slash direction no longer drop valid sessions from project grouping. Cache warmup also starts earlier at boot, so the dropdown is usually warm by the time it is opened.
- **Agent-selected MCP profiles did not expose their tools** — Profile state was module-global even though the HTTP transport hosts multiple stateful MCP sessions in one process, so a profile switch could mutate the most recently registered server instead of the caller's. Each stdio process and HTTP client session now owns an isolated profile runtime. The `tools/list_changed` notification is also no longer emitted synchronously from inside `profile set` — where OpenCode could abort or discard the in-flight roundtrip — but delayed and coalesced until after the tool result returns, so newly enabled tools are usable within the same agent turn.
- **Codex could not call newly enabled tools mid-turn** — Codex snapshots deferred MCP tools when a turn starts, so a successful refresh updated the app-server inventory without making anything callable by the running agent. Canonical Codex registrations now start SynaBun with the full deferred catalog, while per-sidepanel and automation profiles remain isolated focus selections. Profile changes no longer trigger a global `config/mcpServer/reload` that restarted unrelated MCP servers and reported success before startup had finished, and repeating a valid `profile.set` now re-reports the runtime and emits a fresh notification so a strictly profiled host can heal a stale catalog.

## ⚙️ Changed

- **`remember` now requires `category` and `project`** — Both were declared optional in the tool schema, and the `category` description merely noted that "if omitted, a project default is used." Hosts took the hint and sent `{ content }` alone — which is exactly what left the Stop hook blocked. A JSON Schema `required` entry is enforcement; a description is advice, and the advice was already being ignored. `importance` stays optional, since nothing downstream depends on it. Category names that are present but misspelled are still remapped rather than lost.
- **The memory ruleset now states this accurately** — The shipped `CLAUDE.md` template claimed no recall-and-reflect was needed afterwards, without mentioning that omitting `category` misfiles the memory and leaves the stop hook blocked. Corrected across all six template sites, the README, and the `/synabun` skill modules. The ruleset version is now `1.2.0`, so existing installs are offered the update.
- **Installed hook matchers repair themselves at startup** — A matcher change previously reached fresh installs but left every existing `.claude/settings.json` on the old value indefinitely, because the startup sweep compared only the command string and short-circuited. It now compares the matcher too, counts repairs, reports them on the startup `Hooks:` line, and is idempotent — so a stale matcher cannot keep a hook unreachable across upgrades.

---

# SynaBun v.2026.07.34

A reliability release: the Claude sidepanel no longer dies with a misleading "does not match this system's libc" error, and every bundled native binary is checked and repaired at startup.

## 🛠 Fixed

- **"Native binary exists but failed to launch"** — The Claude sidepanel could fail every turn with *"Claude Code native binary at `…/claude` exists but failed to launch. This usually means the binary does not match this system's libc…"*. On macOS and Windows that explanation is never right: the real cause is almost always a missing execute bit. npm does not preserve the execute bit for files a package ships without a `bin` entry, which is exactly how the Claude Agent SDK and Codex deliver their native payloads, so a perfectly good binary can land as mode `0644` and fail to spawn. SynaBun now stats the binary the SDK is about to launch, restores the execute bit when it is missing, and retries — and when it cannot repair it, it says what is actually wrong: a permission problem on macOS and Linux, Gatekeeper quarantine (with the `xattr -d com.apple.quarantine` command) on macOS, a genuine libc mismatch only on Linux, and an unlaunchable `.cmd`/`.bat`/`.ps1` shim on Windows.
- **Only the current machine's binaries were repaired** — The startup repair looked at one directory, `prebuilds/<your platform>-<your arch>`, so a checkout carrying several platform builds left the others broken — including `darwin-x64`, which is what an Intel Mac needs for terminals. Startup and postinstall now sweep every vendored binary that is present (Claude Agent SDK, Codex, `node-pty`) by walking the tree instead of consulting a hardcoded list, so new platform directories are covered automatically.
- **The postinstall repair had stopped doing anything** — `scripts/rebuild-pty.js` was still fixing permissions on `node_modules/.bin/claude` and `@anthropic-ai/claude-code/cli.js`, neither of which has existed since that package was replaced by the Agent SDK. Its prebuild list named Linux directories that are not shipped while missing ones that are. It now runs the shared sweep, and runs it *before* the "node-pty not found, skipping" guard — previously an install without node-pty skipped the Claude and Codex repair entirely.
- **A `.cjs` executable override was launched the wrong way** — A custom Claude executable ending in `.cjs` was treated as a script to run through Node, but the SDK spawns it directly, so it needed the execute bit and did not get it.

## ✨ New

- **Runtime notices in the Claude sidepanel** — A new amber notice sits between grey status text and a red fatal error: something went wrong, was worked around, and the session is continuing in a degraded state. You will see it when the bundled binary is repaired and retried, and when a session falls back to your globally installed Claude CLI. It appears in both the sidepanel and the standalone chat page.
- **Fallback to your installed Claude CLI** — If the bundled runtime cannot be launched or repaired, sessions and unattended automation loops now fall back to the Claude CLI you have installed rather than failing the turn. Because model aliases and effort levels resolve per-binary, a version difference between your CLI and the bundled runtime is reported alongside the fallback instead of silently changing which model runs.

## ⚙️ Changed

- **A custom Claude executable path is now validated before use** — The `claude-skin` → `sdkExecutable` override was passed straight through to the SDK, which uses it verbatim with no checks of its own. It is now vetted first, and a bare command name such as `claude` is rejected with an explanation: the SDK spawns without a shell and cannot resolve a name from `PATH`, so handing one over produces a worse and more confusing failure than the one being recovered from. Overrides may be either a script entrypoint or a native binary path, and the same rule now applies to automation loops, which previously accepted anything.

---

# SynaBun v.2026.07.33

A Windows release: Codex schedules and sidepanels now find a globally installed Codex runtime instead of failing at launch.

## 🛠 Fixed

- **Codex could not be found on Windows even with the global CLI installed** — SynaBun located the Codex runtime by looking it up on the inherited `PATH`, and the PATH it built for that lookup only added POSIX directories (`~/.local/bin`, `/usr/local/bin`, `~/.npm-global/bin`) that do not exist on Windows. Started from anywhere whose environment did not already carry the npm global bin — a shortcut, a service, a fresh terminal after an install — Codex was invisible and every Codex schedule failed. Discovery no longer depends on `PATH` at all: `@openai/codex` is now located under `npm root -g`, `%APPDATA%\npm\node_modules`, an `npm_config_prefix` override, the `node_modules` directory that contains SynaBun itself, and Node's own install directory. The Windows PATH augmentation also picks up `%APPDATA%\npm`, the configured npm prefix, and Node's directory, deduplicated, so the shell-aware launch paths improve too.
- **The native Codex executable was missed under current npm layouts** — The resolver looked in exactly one place, `vendor/<target>/codex/codex.exe` inside the platform package resolved through `require.resolve`. Current Codex releases ship the executable at `vendor/<target>/bin/`, and depending on the npm version the platform package sits either beside `@openai/codex` or nested inside its own `node_modules` — and package `exports` can block the resolve entirely. Both vendor layouts and all three package locations are now checked directly, so hoisting differences no longer read as "Codex is not installed".
- **Windows launched npm's shell shim instead of the real launcher** — `npm install -g` writes both an extensionless `codex` sh shim and a `codex.cmd`, and `where codex` lists the shim first, which Windows cannot spawn. The sidepanel launch path now prefers a `.cmd`, `.exe`, `.bat`, or `.ps1` launcher and keeps the first result only as a fallback for non-npm installations.

## ⚙️ Improved

- **A missing Codex runtime says which problem it is** — The failure notice now distinguishes "the global Codex package is installed but its Windows runtime is missing" from "Codex is not installed globally", and both point at `npm install -g @openai/codex@latest --include=optional`. The platform executable ships as an optional dependency, so an install that skipped optional packages leaves a Codex that looks present and cannot run. Successful resolution logs which layout it came from, and failures log the candidate paths that were checked.

---

# SynaBun v.2026.07.32

A follow-up to 2026.07.31 that makes updating fast again on a large data home.

## 🛠 Fixed

- **Updating took several minutes on a large data home** — Before a new version starts, SynaBun snapshots your data home so the update can be rolled back. That snapshot archived *everything*, so a multi-GB data home spent minutes compressing during `npm install` — one report was 9,470 files and 3,832 MB. An upgrade snapshot only needs to protect state: it never rewrites your generated images, audio, or video, and those survive a rollback on disk regardless. Upgrade snapshots now skip generated media, and if what remains is still over ~1 GB they fall back to irreplaceable state only — your `.env`, everything under `mcp-data/`, and any `.db`, `.sqlite`, or `.json`. Compression on the blocking path drops to the fastest level, since what is left is SQLite and JSON that still shrink well. The snapshot reports what it skipped and why, and its manifest records whether it is `state-only` or `complete` so a restore can never mistake one for the other. Scheduled and manual backups are unchanged and still capture everything.

---

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
