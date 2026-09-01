## FRESH CHANGELOG ##

## 2026-08-31

### Fixed — Codex History Hydration Uses the Paginated App-Server APIs

- **Full thread history no longer rides on `thread/read` or `thread/resume`** — Both calls request metadata/live state without populated turns, avoiding Codex's full-history hydration deprecation. SynaBun now rebuilds the existing `thread.turns` client shape by paging `thread/turns/list` and `thread/items/list` in chronological order.
- **Older thread stores retain complete history** — When `thread/items/list` explicitly reports that item pagination is unsupported, SynaBun falls back to paginated `thread/turns/list` with `itemsView: "full"`. Timeouts and unrelated protocol failures still surface instead of being misclassified as compatibility gaps.
- **Malformed pagination cannot loop or poison a transcript** — Repeated cursors, invalid pages, duplicate turn/item ids, and items without a matching turn are rejected before history reaches the sidepanel. Threads that have not received their first user message restore as valid empty histories.

### Fixed — Codex Writer Recovery Covers Abrupt Disconnects and Turn Start

- **Abrupt idle WebSocket closes now retire their app-server immediately** — The server-side lifecycle check includes active turns, pending approval requests, client RPCs, and writer operations. Only connections with real reattachable work receive the 30-minute orphan grace period.
- **Reconnects clean stale same-window processes without interrupting work** — Idle and exited orphan entries from the same window are retired before a fresh process can spawn, while active detached turns and requests remain eligible for reattach.
- **`thread/resume` and `turn/start` receive one bounded recovery attempt** — Exact `already has an active writer` conflicts first reclaim registered idle writers; when none exists, SynaBun recycles only its idle requesting app-server and retries once. A persistent or genuinely external writer still returns `CODEX_THREAD_ACTIVE_ELSEWHERE`, and unrelated failures are never retried.

### Added — Codex Pagination and Writer Lifecycle Regression Coverage

- **Focused tests lock the new protocol and safety boundaries** — Coverage now exercises multi-page turn/item assembly, unsupported item-pagination fallback, malformed cursors and entries, all active-work signals, idle-close retirement, same-window cleanup, and single-retry resume/turn-start contracts.

### Fixed — Codex MCP Profiles No Longer Depend on Mid-Turn Tool Injection

- **Codex receives the complete SynaBun catalog when the turn starts** — Codex snapshots deferred MCP tools per turn, so a successful `tools/list_changed` or `config/mcpServer/reload` could update the app-server inventory without making newly enabled tools callable by the running agent. Canonical Codex registrations now start SynaBun in `full` deferred-catalog mode; per-sidepanel and automation profiles remain isolated focus selections while every built-in tool stays discoverable.
- **Agent profile changes no longer restart every Codex MCP server** — The old 250 ms `config/mcpServer/reload` fallback raced SynaBun's standard list-change notification, restarted unrelated MCPs, and reported success before asynchronous startup had finished. Codex profile changes now persist and synchronize their runtime/UI state without a global reload.
- **Explicit retries are recoverable on profiled hosts** — Repeating the same valid `profile.set` now re-reports the runtime and emits one fresh coalesced list-change notification, allowing OpenCode and other strictly profiled hosts to heal a stale catalog instead of treating the retry as a no-op.

### Added — Real Codex Catalog Regression Coverage

- **A Codex 0.151 app-server smoke test verifies the startup inventory** — The temporary-home test launches the real installed app-server against SynaBun and requires representative profile, browser, Facebook, GSC, YouTube, and Discord tools to be present before any profile switch. Runtime isolation, same-profile retry, canonical config healing, and no-global-reload contracts are covered separately.

## 2026-08-14

### Fixed — Codex Resume Dropdown Now Uses the Cached Catalog First

- **`/api/codex/sessions` no longer pays the full multi-account scan on the hot path** — `getCodexSessionsResponse()` in `server.js` now serves the Codex dropdown from `listSessionCache('codex')` when cached rows exist, kicks off `rebuildCodexCache()` through a memoized background refresh, and only falls back to `listCodexSessionsFromAccounts()` when the cache is cold. The same cached catalog also backs Codex search metadata joins, so reopening Resume no longer blocks on a full account walk.
- **Windows path matching now resolves like Windows** — `samePath()` in `neural-interface/lib/codex-session-catalog.js` uses `path.win32.resolve()` on win32 and compares case-insensitively, so Codex project/session grouping no longer drops valid sessions because of drive-letter case or slash differences.
- **Codex cache warmup starts earlier after boot** — the Codex session catalog refresh now begins sooner at startup so the dropdown is usually warm by the time the user opens it.

### Added — Codex Resume Cache and Windows Regression Coverage

- **`neural-interface/tests/codex-session-catalog.test.mjs` now covers platform-safe matching** — added assertions for `samePath()` on POSIX and Windows-style paths, including nested-path rejection.
- **`neural-interface/tests/codex-resume-integration-contract.test.mjs` now locks the cache-first Codex contract** — updated the integration contract so the Codex resume/search path must use the shared cached catalog, the memoized refresh helper, and `listSessionCache('codex')` instead of the old direct all-account scan.

## 2026-08-13

### Fixed — Stop Hook Never Cleared Unstored File Edits

- **A `remember` call without a `category` cleared nothing** — `post-remember.mjs` gated its entire pending-remember reset on `} else if (category) {`. Claude Code routinely sends `remember` with `{ content }` alone, so neither that branch nor the `conversations` branch ran, the flag was never reset, and the Stop hook re-issued the identical "Unstored file edits" block on every turn. Confirmed against a real session flag showing `rememberCount: 0` after four successful `remember` calls — that counter only increments inside the two dead branches. The reset is now unconditional for any successful `remember`/`reflect`.
- **Failure detection fails open by design** — New `toolCallFailed()` treats only an explicit `isError` / `is_error` / `success: false` / `status: "error"` as failure. A missing `tool_response`, a bare string, or an unrecognized object clears normally, so a future Claude Code payload change cannot silently reintroduce a never-clears block.
- **`reflect` was excluded by the hook matcher** — `post-remember.mjs` already contained `toolName.includes('reflect')` handling, but the registered PostToolUse matcher ended in `Syna[Bb]un__remember`, making that code unreachable. `reflect` calls carrying a valid category never reached the hook.
- **`retries` was a one-way latch** — Only the dead branch and `softCleanupFlag()` reset it, and the latter requires `editCount < 1` — the very state the dead branch was supposed to produce. After `MAX_RETRIES` blocks, task-memory enforcement stayed dead for the rest of the session. `post-remember.mjs` now resets `retries` when a new edit segment begins (`editCount` 0→1), paired with a new `MAX_TASK_BLOCKS = 12` session ceiling in `stop.mjs` because `stop_hook_active` is never honored.

### Fixed — PostToolUse Nudges Were Emitted in a Shape Claude Code Discards

- **Every edit nudge had been silently dropped** — `post-remember.mjs` wrote a bare top-level `{ additionalContext }`. PostToolUse only reads `hookSpecificOutput: { hookEventName, additionalContext }` — the form already used by `session-start.mjs`, `prompt-submit.mjs`, and `subagent-stop.mjs`. The output was valid JSON, so it failed silently rather than erroring, and no "N file edits — remember to store this work" message ever reached the model.
- **`post-plan.mjs` had the same bug in five places** — All five emission sites now route through a shared `emitContext()` helper rather than repeating the wrapper.

### Fixed — MCP Server Read the Project Registry From a Directory That Never Existed

- **`claude-code-projects.json` was read from the wrong data dir** — `mcp-server/src/config.ts` built `PROJECTS_PATH` from `config.dataDir` (`<dataHome>/mcp-data/`), but the registry is written to `<dataHome>/data/` by `neural-interface/server.js` and read from there by `hooks/claude-code/shared.mjs`. The `mcp-data` copy has never existed, so `loadRegisteredProjects()` always returned `[]` and `detectProject()` always fell through to a raw directory basename — `/Apps/EllaCred` resolved to `ellacred` instead of the registered label `elacred`.
- **`process.cwd()` is meaningless over the HTTP transport** — Every HTTP caller shares the Neural Interface process, so `detectProject()` labeled memories `neural-interface` regardless of the client's actual working directory. It now returns `global` when `!cwd && isHttpMode()` — a recoverable mislabel rather than one indistinguishable from a real project.

### Fixed — Every Hook Invocation Stalled ~2 Seconds

- **The stdin guard timer kept the event loop alive after resolution** — `readStdin()` resolved promptly on `end`, but its 2000 ms `setTimeout` fallback remained pending, so the process lingered for the full timeout before exiting. Measured at 2.05 s per invocation against a configured 3 s hook timeout. Adding `clearTimeout` on `end` plus `guard.unref?.()` brings it to 0.02 s across `post-remember.mjs`, `stop.mjs`, `session-start.mjs`, `prompt-submit.mjs`, and `shared.mjs`.

### Changed — `remember` Now Requires `category` and `project`

- **Both fields are required in the tool schema** — `mcp-server/src/tools/remember.ts` declared them `.optional()`, and the `category` description ended *"If omitted, a project default is used."* Hosts took the hint and sent `{ content }` alone, which is what broke the stop hook. A JSON Schema `required` entry is enforcement; a description is advice, and the advice was already being ignored. `resolveCategory()` is retained as the safety net for misspelled-but-present names, so a bad value is still remapped rather than lost.
- **`importance` stays optional but prescriptive** — Nothing downstream depends on it, unlike `category` (drives the stop hook) and `project` (structurally wrong over HTTP).
- **The memory ruleset now states this accurately** — `neural-interface/templates/CLAUDE-template.md` claimed *"no need to recall+reflect afterward"* without mentioning that omitting `category` silently misfiles the memory and leaves the stop hook blocked. Updated across all six template sites plus `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/usage-guide.md`, and the `skills/synabun` modules. `ruleset-versions.json` bumped to `1.2.0`.

### Changed — Hook Matchers Now Cover `reflect` and Repair Drift at Startup

- **Matcher rewritten to `^Edit$|^Write$|^NotebookEdit$|Syna[Bb]un_+(remember|reflect)`** — `_+` matches both Claude Code's `mcp__SynaBun__remember` and OpenCode's `SynaBun_remember`. Anchors keep the edit tools exact, and the alternation never reaches `recall`, `memories`, or `forget`.
- **A matcher change never propagated to installed settings** — `dedupeAllSettingsHooks()` short-circuited on `matching.length === 1 && hadCanonical`, comparing only the command string. Any `HOOK_SCRIPTS` matcher edit updated fresh installs but left every existing `.claude/settings.json` on the old value indefinitely. The sweep now compares the matcher too, counts repairs in `stats.matchers`, reports them on the startup `Hooks:` line, and is idempotent.
- **`sweepSettingsHooks()` hoisted to top level** — Previously an inner closure, so it could not be extracted and exercised by the existing `extractFn()` test pattern.

### Added — Hook and Schema Regression Coverage

- **`tests/post-remember-clearing.test.mjs`** — 11 cases against a throwaway `SYNABUN_DATA_HOME`, including the exact reported failure (categoryless `remember` clears), an end-to-end block → `remember` → no-block assertion through the real `stop.mjs`, `reflect` and OpenCode tool-name forms, fail-closed on explicit error, fail-open on unrecognized `tool_response` shapes, and the `hookSpecificOutput` emission shape.
- **`neural-interface/tests/hook-matchers.test.mjs`** — Parses the live `HOOK_SCRIPTS` literal out of `server.js` so the test cannot disagree with what actually ships; asserts positive and negative tool-name matches and that the tracked `.claude/settings.json` carries the shipped matcher.
- **`neural-interface/tests/hook-matcher-drift.test.mjs`** — Covers stale-matcher repair, idempotency, no-op on correct input, duplicate collapse, and non-interference with third-party hook entries.
- **`mcp-server/tests/remember-schema.test.ts`** — Asserts `category`/`project` are required, `importance` optional and bounded, and that the description no longer contains "if omitted".
- **CI now runs the root suites** — `.github/workflows/ci.yml` ran only the mcp-server vitest job plus four named Windows files, so none of `tests/` or `neural-interface/tests/` executed — which is how the stale matcher survived unnoticed. Added `npm test` (`node --test tests/*.test.mjs neural-interface/tests/*.test.mjs`) and `npm run test:mcp` scripts and wired the former into CI. Also replaced the hardcoded `'1.1.0'` / `'2026-07-29'` assertion in `tests/ruleset-browser-policy.test.mjs` with a shape check, since pinning a literal version broke the test on every legitimate ruleset bump.


## 2026-08-08

### Fixed — Codex Sidepanel Sessions Retained Stale Active Writers

- **Idle tab disconnects now release their Codex app-server writer** — The client’s intentional socket close was previously invisible to `handleCodexSkinWebSocket()`, so the server orphaned an idle process for the full 30-minute grace period and its later `thread/resume` collided with `thread ... already has an active writer`. `release` / `release_ack` ownership handshakes now unsubscribe idle thread families and retire the process before the socket closes.
- **Thread resume is serialized against actual writer exit** — `CodexWriterRetirementRegistry` in `neural-interface/lib/codex-writer-lifecycle.js` keys retirement barriers by `CODEX_HOME` and thread family, waits for process exit rather than `ChildProcess.killed`, reclaims matching idle orphans, and permits one bounded retry only after an observed local retirement. Genuine external writers receive an actionable error without requiring a SynaBun restart.
- **Active turns remain reattachable without split-brain lifecycle state** — Orphan idle/ownership checks now read live closure state, reattached sockets delegate messages and closes to the original handler, account/profile mismatches keep busy orphans pinned to their running configuration, and collision handling never retires an active detached writer.
- **Rapid tab switching cannot strand or resurrect a hidden writer** — `cdx-ws.js` now uses per-tab reconnect timers, blocks sends while release is pending, restores readiness after a rejected release, and handles A→B→A and A→B→A→B acknowledgement races. Inactive tabs retained during turns, compaction, approvals, or other requests release automatically once their work becomes idle.

### Added — Codex Writer Lifecycle Regression Coverage

- **Focused lifecycle and transport tests cover the failure modes** — Added `neural-interface/tests/codex-writer-lifecycle.test.mjs` and expanded `codex-ws-lifecycle.test.mjs` plus `codex-resume-integration-contract.test.mjs` to verify exact conflict classification, concurrent retirement barriers, signal-versus-exit semantics, active-orphan collision policy, accepted and rejected releases, pending-send gating, rapid switch-back behavior, per-tab reconnect cancellation, inactive background cleanup, and centralized resume recovery.

## 2026-08-05

### Fixed — Agent-Selected MCP Profiles Did Not Expose Their Tools

- **Profile state is now owned by each MCP server runtime** — `activeGroups`, registered tool references, and list-change notifications were module-global even though the HTTP transport hosts multiple stateful MCP sessions in one process. A profile switch could therefore mutate the most recently registered server instead of the caller. Each stdio process and HTTP client session now has an isolated `ProfileRuntime`.
- **The profile tool no longer refreshes the host while its own call is in flight** — `notifications/tools/list_changed` was emitted synchronously from `profile set`, which OpenCode could process by aborting or retaining the old tool roundtrip. Every MCP runtime now receives one delayed, coalesced notification after the tool result returns, so newly enabled tools can enter the same agent turn safely.
- **Managed OpenCode and Codex sidepanels perform an in-place host refresh** — OpenCode reconnects only the SynaBun MCP child on its isolated serve; Codex injects a stable runtime identity/profile file and invokes `config/mcpServer/reload`. Both paths preserve the conversation and current turn, update only the originating runtime, synchronize the footer after confirmation, and surface scoped refresh failures.
- **Regression coverage** now verifies same-process server isolation, response-before-notification ordering, runtime-file/default isolation, OpenCode reconnect wiring, and Codex runtime identity/reload wiring.

