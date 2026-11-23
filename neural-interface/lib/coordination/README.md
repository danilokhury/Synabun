# Agents system: the contracts (phase P0) and durable messaging (phase P2)

Phase P0 made four modules that later phases build on. Phase P2 wired the last of them, the coordination store, into the Assistant: its dispatcher and its runtime now talk through `lib/coordination/service.js` (the section [The coordination service](#libcoordinationservicejs-phase-p2) below). The first three are still wired into nothing. This file is the reference for the workers of the phases that follow.

| Module | What it is | Tests |
|---|---|---|
| `lib/agents/schema.js` | The AgentDefinition contract: shape, canonical form, errors, warnings, revisions, `agent_ref` | `tests/agents-schema.test.mjs` |
| `lib/agents/density.js` | Agent density: how many workers one task may get, and the wording | `tests/agents-density.test.mjs` |
| `lib/teams/schema.js` | The team plan: slices, owned paths, dependencies, worktree and branch names | `tests/teams-schema.test.mjs` |
| `lib/coordination/store.js` | The durable store: events, deliveries, claims, journal, outbox | `tests/coordination-store.test.mjs` |
| `lib/coordination/service.js` | The one owner of the store while the server runs: run events, the Assistant's mailbox, typed run-event reads, follow-ups, the team channel | `tests/coordination-service.test.mjs` |
| `lib/assistant-run-wait.js` | `agent_wait`: state waits, typed event waits with a cursor, workflow waits that follow the workflow | `tests/assistant-dispatch-durable.test.mjs` |
| `lib/assistant-run-tail.js` | A run's transcript tail and the whole text of its last turn on disk, read in pages | `tests/assistant-dispatch-durable.test.mjs` |

Run one with `node --test tests/<name>.test.mjs` from `neural-interface/`.

The first three are pure (no file, network, git or clock access; `node:path` and `node:crypto` only compute; `agents/schema.js` also imports the tool catalog from `mcp-server/dist`, which is data). The store is the only one that touches the disk. Each validator comes under a short and a long name (`validate` / `validateAgentDefinition`, `normalize` / `normalizeTeamPlan`, …): import the long one where two modules meet in one file.

## Owner decisions these contracts encode

Taken with the owner on 2026-11-15; a later phase follows them, it does not reopen them.

- **Density starts at Solo.** One worker per task unless the user raises the level. A level is a cap, never a quota.
- **Agents never use the user's branch or checkout.** Every worker of a team works in its own worktree under `<project>/.worktrees/`, on its own branch. A dirty working tree is therefore not a reason to stop, and nothing is stashed or committed for the user.
- **The result lands on an integration branch, and the user merges it.** `synabun/<team>/integration`. Nothing is merged into the user's branch by SynaBun unless the owner later allows that.
- **Agent definitions live in a global library plus per project.** A project's agent of an id wins over the global one.
- **Only the owner approves an agent definition.** What the Assistant or an agent makes waits in review.

## `lib/agents/schema.js`

An agent is a named, reviewed way to launch a worker.

### Fields

Content (what the etag covers, `AGENT_CONTENT_FIELDS`):

| Field | Type | Notes |
|---|---|---|
| `id` | slug | lower-case letters, digits, hyphens, 1 to 64; not one of `RESERVED_AGENT_IDS` |
| `name` | text | required, one line, at most 80 |
| `description` | text | at most 400; the Assistant picks agents by it |
| `instructions` | text | at most 16,000 |
| `provider` | `claude-code` \| `codex` \| `opencode` \| `antigravity` | required |
| `model`, `effort` | text \| null | null: the provider default |
| `accountId` | text \| null | Claude Code and Codex only; `auto` allowed |
| `tools` | string[] \| null | SynaBun group ids, or `all`. `null`: the worker's default list; `[]`: always-on tools only. Never `mcp:` items, never a gated group (`agents`, `skills`, `computer`), never a group the tool catalog does not have |
| `mcpServers` | string[] | exact server names (1 to 64 letters, digits, `.`, `_`, `:`, `-`), or `['*']` |
| `capability` | `read-only` \| `workspace` \| `full` | default `workspace` (the dispatcher's own default is `full`) |
| `permissionPolicy` | `auto` \| `ask` \| `restricted` | default `auto` |
| `usesBrowser`, `usesComputer` | boolean | |
| `moreloginProfile` | text \| null | needs `usesBrowser` |
| `skills` | string[] | skill names (`name`, `plugin:name`) or library ids (`skl_…`) |
| `scope` | `{ kind: 'global' }` \| `{ kind: 'project', path }` | `path` absolute, kept normalized |
| `memoryCategory` | text \| null | a category name |
| `taskClasses` | string[] | the Assistant's task classes |
| `icon` | text \| null | an icon name, never markup or a URL |
| `color` | text \| null | a style-guide token name `group.key` (`status.info`, `primary.500`); a raw colour is refused |

Revision metadata (`AGENT_META_FIELDS`): `schemaVersion`, `revision` (from 1), `parentRevision`, `status` (`draft` \| `in_review` \| `approved` \| `withdrawn`), `author` (`{ kind: owner | assistant | agent | system, ref }`), `createdAt`, `approvedAt` (ISO 8601 UTC), `etag` (`sha256:<64 hex>` of the content).

### Exports

- `normalize(input)` → a definition with every field, spellings folded (`uses_browser`, `{status.info}`, `mcp:name`), lists de-duplicated and sorted. Never throws. Recomputes the etag.
- `validate(input, { knownMcpServers, requireMeta })` → `{ ok, errors: [{ field, code, message }], value }`. `value` is the normalized definition, also when `ok` is false. `tools` and `mcpServers` are read by the resolver a dispatch uses (`resolveToolList` of the tool catalog), so what validates is what can start: an unknown group is `unknown_tool` (with what it probably meant), a gated one `gated_tool`. Pass the MCP servers that exist as `knownMcpServers` to refuse unknown names; `requireMeta: true` for a stored revision (needs `createdAt`, and a given `etag` must match the content).
- `lint(input, { knownTaskClasses, knownSkills, knownColorTokens, knownCategories, knownModels })` → `[{ field, code, message }]`. Never a refusal. Codes include `full_with_browser`, `full_with_computer`, `full_capability`, `empty_instructions`, `empty_description`, `long_instructions`, `unknown_task_class`, `no_task_classes`, `all_tools`, `always_on_tool`, `all_mcp_servers`, `account_ignored`, `read_only_for_code`.
- Revisions: `AGENT_STATUS_TRANSITIONS`, `canTransition(from, to)`, `isEditable(def)` (draft only), `isRunnable(def)` (approved only), `createDraft(input, { now, base, revision, author })`, `applyTransition(def, to, { now, actor })`. `applyTransition` throws `AgentSchemaError` with `invalid_transition`, `approval_requires_owner` (403) or `not_valid` (with `errors`). The module reads no clock: pass `now`.
- Review: `privilegesOf(def)`, `privilegeDelta(before, after, { defaultTools })` → `{ escalates, changes: [{ field, from, to, escalates }] }`. `before` null is a first revision. `tools: null` is compared group by group as the catalog's `DEFAULT_TOOLS` (override with `defaultTools`).
- Runs: `dispatchFields(def)` → the fields a dispatch takes, in the dispatcher's spelling (`provider`, `model`, `effort`, `accountId`, `tools` with `mcp:<name>` appended, `capability`, `permissionPolicy`, `usesBrowser`, `usesComputer`, `moreloginProfile`). The task, cwd, session and budget stay the dispatch's own.
- Refs: `parseAgentRef(ref)` → `{ id, revision, scope } | null`, `formatAgentRef(parts)`, `resolutionOrder(parsed, projectPath)` (project first, then global), `sameScope(a, b)`. A ref is `<id>`, `<id>@<revision>`, `global:<id>` or `project:<id>@<revision>`.
- `computeEtag(def)`, `contentOf(def)`, and the constant lists (`AGENT_PROVIDERS`, `AGENT_CAPABILITIES`, `AGENT_PERMISSION_POLICIES`, `AGENT_TASK_CLASSES`, `AGENT_STATUSES`, `AGENT_LIMITS`, …).

The provider, task class, capability and permission policy lists are copies; `tests/agents-schema.test.mjs` compares them with `assistant-config.js`, `assistant-router.js` and `mcp-server/src/tools/agents.ts` and fails when one drifts. Tool groups are not copied: the module imports `mcp-server/dist/services/tool-catalog.js` and `tool-list.js` (the catalog is the one table of groups, and `tests/tool-catalog-single-source.test.mjs` fails on a second one anywhere in `lib/`). Never write a list of group ids into an Agents module: ask the catalog (`isBrowserGroup`, `isGatedGroup`, `SELECTABLE_GROUP_IDS`).

### For the registry and resolver phase

- Store revisions as written by `createDraft` / `applyTransition`; validate what is read back with `requireMeta: true`.
- An approved revision is never edited. A change is `createDraft(patch, { base: approved })`, which gets the next revision number and `parentRevision`.
- Resolve only `isRunnable` revisions, and pin the revision number and etag on the run so a later edit does not change a run under way.
- `agent_dispatch` already has an `agent` field (OpenCode's native agent). Use a new `agent_ref` field; do not change what `agent` means.
- A definition with `capability: 'full'` and browser or computer use starts only when the dispatch carries the tag `user-authorized-full` (the dispatcher's existing rule). The resolver must not add that tag by itself.

## `lib/agents/density.js`

| Level | Label | Workers on one task |
|---|---|---|
| `solo` (default) | Solo | 1 |
| `pair` | Pair | 2 |
| `team` | Team | 4 |
| `swarm` | Swarm | 6 |

Exports: `AGENT_DENSITIES`, `DEFAULT_AGENT_DENSITY`, `AGENT_DENSITY_LABELS`, `AGENT_DENSITY_WORKERS`, `MAX_TEAM_WORKERS`, `AGENTS_HEADER` (`[SynaBun Agents]`), `normalize(value, fallback)` (also `normalizeAgentDensity`), `agentDensityLabel(level)`, `maxWorkers(level)`, `allowsTeams(level)`, `clampWorkers(level, requested)`, `fitsDensity(level, workers)`, `densityForWorkers(n)`, `agentDensitySummary(level)`, `agentDensityPersonaLine(level, { where })`, `agentDensityStamp(level)`.

It mirrors `assistant-test-density.js` on purpose, so it is wired the same way: a per-session value on the session record (`null` is the default), a `set_agent_density` socket message, the persona line among the Rails, `agentDensityStamp()` sent to a running brain when the level changes, and the cap enforced by the server (`validate` of a team plan with `{ density }`), never by the brain's prompt alone.

## `lib/teams/schema.js`

A team is one task given to several workers. Its plan:

```js
{
  teamId: 'auth-rework',                 // slug, at most 40
  projectPath: '/Users/me/app',          // absolute
  baseCommit: '<40 or 64 hex>',          // a full commit id, never a branch name
  slices: [{
    id: 'api',                           // slug; 'integration' is reserved
    title: 'The API',
    task: 'What this worker is told.',
    agentRef: 'backend@2',               // optional (see parseAgentRef)
    ownedPaths: ['src/api/**', 'package.json'],
    dependsOn: [],                       // slice ids
    lockfileOwner: true,                 // at most one slice
  }],
}
```

`validate(plan, { density, maxSlices })` → `{ ok, errors: [{ field, code, message, … }], value }`, with `field` naming the place (`slices[1].ownedPaths[0]`). It refuses:

| Code | Meaning |
|---|---|
| `overlapping_paths` | two slices own a common file (`with` names the other slice and pattern) |
| `dependency_cycle` | the slices wait for each other in a circle (`cycle` lists it) |
| `multiple_lockfile_owners` | more than one slice has `lockfileOwner: true` |
| `lockfile_not_owner` | a slice names a lockfile outright without being the lockfile owner |
| `too_many_slices` | more slices than the density allows (`limit`, `count`). With no `density` and no `maxSlices`, Solo applies: one slice |
| `path_escape` | an owned path is absolute, starts with `~` or a drive, or has a `..` segment |
| `reserved_path`, `unsupported_glob`, `invalid_glob` | inside `.git` or `.worktrees`; uses `[ ]`, `{ }` or `!`; malformed |
| `unknown_dependency`, `self_dependency`, `duplicate`, `reserved`, `required`, `invalid_format`, `invalid_type`, `too_long`, `too_many` | the rest |

### Owned paths

Project-relative patterns with forward slashes. `*` and `?` match inside one segment, `**` (a whole segment) any number of segments. Three rules follow from "a file has one owner":

- A pattern also owns everything beneath what it matches, like a git pathspec: `src/api` owns `src/api/users.js`.
- Matching ignores letter case (two names that differ only in case are one file on the default macOS and Windows file systems).
- Lockfiles (`LOCKFILE_NAMES`, by file name, anywhere in the tree) belong to the lockfile owner and to nobody else. A slice whose pattern merely covers one does not own it; with no lockfile owner in the plan, nobody may change one.

### Exports

- `normalize(plan)`, `validate(plan, options)` (also `normalizeTeamPlan`, `validateTeamPlan`).
- `pathOwner(plan, relPath)` → slice id or null.
- `integrationOrder(plan)` → slice ids, each after the slices it depends on, otherwise in plan order (deterministic). Throws `TeamPlanError` (`dependency_cycle`, `unknown_dependency`, `duplicate`).
- `readySlices(plan, finished)` → the slices that can run now.
- `claimablePaths(plan, sliceId)` → the patterns a slice claims in the store while it works: its owned paths without the ones that name a lockfile (those are owned by rule). Of a valid plan, every slice's claim of them is granted.
- `dependencyCycle(plan)` → the cycle or null.
- `worktreePath(projectPath, teamId, sliceId)` → always `<project>/.worktrees/<team>/<slice>`. Throws for a relative project path or an id that is not a slug, so no id can climb out.
- `worktreesRoot(projectPath)`, `integrationWorktreePath(projectPath, teamId)`, `parseWorktreePath(projectPath, absPath)` → `{ teamId, sliceId } | null`.
- `branchName(teamId, sliceId)` → `synabun/<team>/<slice>`; `integrationBranchName(teamId)`; `parseBranchName(branch)`.
- `globsOverlap(a, b)`, `matchesOwnedPath(glob, relPath)`, `normalizeOwnedPath(glob)`, `ownedPathProblem(glob)`, `normalizeRelPath(path)`, `isLockfilePath(path)`, `isTeamSlug(value)`.
- Constants: `WORKTREES_DIR`, `BRANCH_PREFIX`, `INTEGRATION_SLICE_ID`, `LOCKFILE_NAMES`, `RESERVED_PATH_ROOTS`, `TEAM_LIMITS`, `TEAM_STATES`, `SLICE_STATES`.

### For the worktree and scheduler phases

- This module runs no git. The phase that does must check that `<project>/.worktrees/<team>` does not exist before it creates a team: a hand-made worktree may already sit under `.worktrees` with the same name as a team id.
- `.worktrees/` must be ignored in the project. Add it to `.git/info/exclude` when it is not, never to the project's `.gitignore`.
- `baseCommit` is what the user's branch pointed at when the plan was made. A dirty working tree does not matter to a team: workers never see it.
- `TEAM_STATES` and `SLICE_STATES` are the names for the store's journal. The store does not enforce them.
- A plan with one slice is valid at every level: one worker in a worktree.

## `lib/coordination/store.js`

One SQLite file in WAL mode (`node:sqlite`, no new dependency), `DATA_HOME/data/coordination.db` by `coordinationDbPath(dataDir)`. Apart from `memory.db` on purpose. A backup includes it without anything being registered: `backup-service.js` takes a consistent snapshot of every `.db` in the data home. A restore therefore brings back the open events and claims of that time. Phase P2 treats them like a restart: the sessions restored with them are told what was open for them, and what is open for a session that no longer exists is settled.

```js
const store = createCoordinationStore({ path });
await store.ready;
```

A dedicated worker opens and migrates the file. All database methods below return promises. SQLite reads and writes share a FIFO, so even a read submitted immediately after an unawaited write observes its commit if it succeeds. Subscriptions register synchronously. Long polls release the queue after registration. The server keeps committed claim and count projections in memory for the synchronous worker guard and scheduling predicates.

The worker retries locked transactions with backoff for up to `busyTimeoutMs` (default 5 seconds). An exhausted request rejects with `SQLITE_BUSY`. Unexpected exit rejects outstanding requests with `WORKER_EXIT` and reopens the disk store. A write that lost its reply may already have committed. Reconcile by stable event or outbox ID before resubmitting. A lost in-memory store stays unavailable.

Await `store.close()` after scheduler shutdown. It stops admission and drains accepted requests, closes the WAL connection and answers outstanding waits. At the 8-second default shutdown deadline, it terminates the worker and reports `DRAIN_TIMEOUT`. The schema and existing WAL files are compatible across this change. Custom JavaScript migration callbacks are exercised inside the database engine. The worker uses the versioned steps in `MIGRATIONS`.

### Event schema

| Field | Type | Notes |
|---|---|---|
| `id` | text | the caller's, or generated. Appending an existing id stores nothing and returns `duplicate: true` |
| `seq` | integer | assigned by the store, only ever grows, never reused |
| `sessionId`, `teamId`, `runId` | text \| null | what the event belongs to |
| `kind` | text | lower-case, `a.b` style, at most 64 |
| `priority` | `critical` \| `normal` \| `low` | default: `KIND_PRIORITY[kind]`, else `normal` |
| `payload` | JSON | at most 256 KB |
| `createdAt` | ISO 8601 UTC | |

`append` also takes `to` (one recipient or a list) and `coalesceKey`. A mailbox read adds `delivery: { recipient, deliveredAt, ackedAt, attempts, redelivered, merged }`.

Recipients are plain names. Use `sessionRecipient(id)` → `session:<id>`, `runRecipient(id)` → `run:<id>`, `teamRecipient(id)` → `team:<id>`. The store does not expand groups: whoever appends lists every recipient.

Kinds the phases share (`EVENT_KINDS`, with their default priority):

| Kind | Priority | | Kind | Priority |
|---|---|---|---|---|
| `run.progress` | low | | `team.state` | normal |
| `run.result` | normal | | `slice.state` | normal |
| `run.needs_input` | critical | | `slice.progress` | low |
| `run.permission` | critical | | `claim.conflict` | critical |
| `run.failed` | critical | | `integration.conflict` | critical |
| `run.stalled` | critical | | `integration.ready` | normal |
| `run.interrupted` | critical | | `team.message` | normal |
| `run.message` | normal | | `session.memory_due` | normal |
| `run.stopped` | normal | | `route.decided`, `route.expired`, `route.declined` | normal |
| `run.completed` | normal | | `clarify.answered`, `clarify.declined` | normal |
| `run.budget` | normal (the cap reached: critical) | | | |
| `run.notice` | normal | | | |

The second half of the list came with phase P2: what the dispatcher emits beyond the first seven, and the Assistant session's own items (a memory reminder, a route card's or a clarify card's outcome).

Any other kind of the right form is accepted. Add a shared one to `EVENT_KINDS` and `KIND_PRIORITY` rather than spelling it in two places.

### Delivery semantics

- **At-least-once.** An event addressed to a recipient stays open for it until that recipient acknowledges it. Reading does not acknowledge. An open event is handed out again by the next read, also by a store opened on the file after a restart. Consumers must be idempotent; `delivery.redelivered` (attempts above 1) says the event was handed out before.
- **Idempotent append.** Give every event a deterministic `id` (for example `run:<runId>:turn:<n>:result`). A retry then stores nothing and wakes nobody.
- **Cursor.** Per recipient, the seq up to which everything addressed to it is acknowledged. It never moves back. `read` starts from it by default.
- **Order.** `read` is oldest first. `pending` is critical events first (oldest first among themselves), then everything else oldest first.
- **Coalescing.** `coalesce(recipient)` folds open `low` events that say the same kind of thing (same `coalesceKey`, else same kind, run, team and session) into the newest, which reports how many it stands for in `delivery.merged`. Critical and normal events are never touched, and the log keeps every event.
- **Wake-ups are not deliveries.** `subscribe` and `waitFor` are called after the transaction that appended an event has committed, in this process only, in seq order. A duplicate id and a rolled-back append wake nobody. What must not be missed is read from the mailbox.
- **One writer.** The Neural Interface server writes (the `/mcp` endpoint is mounted in it). Another process that opens the file reads and writes safely but is not woken: it passes `pollMs` to `waitFor`.

### API

Events and the log:

- `append(event)` → `{ id, seq, duplicate }`
- `appendMany(events)` → the same per event, all in one transaction or none
- `get(id)` → the event with `to`, or null
- `events({ afterSeq, teamId, sessionId, runId, runIds, kinds, limit })` → the log, oldest first; delivers nothing. `runIds`: several runs at once (at most 500; an empty list matches nothing)
- `lastSeq()`

The mailbox:

- `read({ recipient, afterSeq, kinds, limit, includeAcked, peek })` → open events after `afterSeq` (default: the cursor). Records the delivery unless `peek`.
- `pending(recipient, { kinds, limit, peek, coalesce })` → everything open, critical first
- `ack(recipient, eventIds)` → `{ acked, cursor }`; harmless to repeat
- `ackThrough(recipient, seq)` → `{ acked, cursor }`
- `cursor(recipient)`
- `coalesce(recipient)` → `{ merged, kept: [{ id, seq, merged }] }`
- `openCount(recipient, { kinds, priority })` → how many events the recipient has not acknowledged (hands out nothing)
- `recipients({ prefix })` → `[{ recipient, open, oldestSeq }]`: who has something open (after a restart: whose mailbox still holds events)

Wake-ups:

- `subscribe(filter, fn)` → `unsubscribe()`. `filter`: `{ recipient, kinds, priority, teamId, sessionId, runId }`, a predicate `(event, { recipients })`, or null. `fn(event, { recipients })`.
- `waitFor({ recipient, kinds, afterSeq, timeoutMs, limit, teamId, sessionId, runId, signal, pollMs })` → `Promise<{ events, timedOut, closed, aborted }>`. With `recipient` it waits on the mailbox and reads like `read`; without one it waits on the log for events after `afterSeq` (default: the newest now). Resolves at once when something is there. A timeout resolves with `timedOut: true`, never rejects. Default 30 s, at most 10 minutes. Its timers are unreferenced: a wait nobody answers never keeps a process alive (a server going down, a script that is done); `close()` answers it.

Claims (team-scoped; patterns are owned paths of `lib/teams/schema.js`):

- `claim({ teamId, sliceId, runId, globs })` (for a planned slice, `globs` is `claimablePaths(plan, sliceId)`) → `{ ok: true, claims }` or `{ ok: false, code: 'CLAIM_CONFLICT', conflicts: [{ glob, heldBy }] }`. All of the patterns are taken or none. A slice re-claiming its own pattern keeps the one claim.
- `release({ teamId, sliceId, runId, globs })` → `{ released }`; `teamId` alone releases the team's
- `claimsFor({ teamId, sliceId, runId, path, includeReleased })` → claims; `path` asks who holds a file

Journal of team tasks (append-only; the newest entry of a team or slice is its state):

- `journal.write({ teamId, sliceId, state, runId, data })` → the entry. No `sliceId`: the team itself. `data` is what recovery needs (the plan, a branch, a commit, an error), at most 64 KB.
- `journal.read({ teamId, sliceId, afterId, limit })`
- `journal.state(teamId)` → `{ teamId, team, slices: { [sliceId]: entry } }`
- `journal.teams({ states })` → each team's newest own entry (after a restart: which teams were under way)

Outbox (follow-ups for runs):

- `outbox.enqueue({ id, runId, text, sessionId, meta, maxQueued })` → `{ id, duplicate }`. `maxQueued` is the admission bound: with that many of the run's items unsent, nothing is stored and `OUTBOX_FULL` (409, with `queued` and `limit`) is thrown
- `outbox.take(runId, { limit })` → unsent items in the order they were queued. Taking marks nothing: an item comes back until `markSent` names it.
- `outbox.markSent(ids)` → `{ sent }`
- `outbox.count(runId)` → how many are unsent
- `outbox.cancel({ runId, ids })` → `{ cancelled }`: unsent items leave the queue for good (the run ended before it could take them); sent ones are left alone
- `outbox.get(id)`, `outbox.runs()` → the runs with something queued

Housekeeping:

- `prune({ olderThanMs })` → `{ events, claims, outbox }`. Never drops an event somebody has not acknowledged; never prunes the journal.
- `stats()`, `appliedMigrations()`, `close()` (answers every waiter with `closed: true`; safe to call twice), `closed`.

### Schema

Tables: `events`, `deliveries`, `cursors`, `claims`, `team_tasks`, `outbox`, `migrations`. Version 1 is `MIGRATIONS[0]`. A change is a new entry appended to `MIGRATIONS` with the next version; an entry that shipped is never edited. A file written by a newer SynaBun is refused (`SCHEMA_NEWER`) and left as it is; a migration that fails is rolled back (`MIGRATION_FAILED`).

### For the phases that use it

- Go through the service (`lib/coordination/service.js`), not through a second store on the file: it is the one owner while the server runs, and `server.js` shares it (`shareCoordinationService`). A module that needs the store itself (claims, the journal) takes `service.store`.
- A worker's MCP `wait` is `service.team.wait(…)` (or `store.waitFor({ recipient: runRecipient(runId), … })`) with the tool's own cap; keep it under the MCP client's request timeout as `agent_wait` does (50 s default).
- Never append inside another module's SQLite transaction or state lock, and never call a model while holding one of this store's transactions (there is no way to: every method returns before it could).
- Tests open the store on a temporary file, or in memory (`path` is injectable; a service made with no path lives in memory). Never point a test at `DATA_HOME`.
- No schema change came with phase P2: version 1 is still the only migration. The next one is `MIGRATIONS[1]`.

## `lib/coordination/service.js` (phase P2)

The Assistant's mailbox was a list in the runtime's memory: batched for a fixed 2 s, cut at 40 items whatever they were, gone at a restart, removed before the turn that carried it had started. `agent_wait until:"event"` fired on any change of a run, follow-ups for a busy or suspended run sat in arrays, and a run's transcript tail died with its worker. Phase P2 replaced all of that with the store, behind one service.

```js
const service = createCoordinationService({ dataDir });   // or { path }, or { store }; nothing: in memory
await service.ready;
shareCoordinationService(service);                         // server.js: the dispatcher and the runtime take it by themselves
```

`server.js` has one block (marked `Agents P2`) that creates it on `DATA_HOME/data/coordination.db`, shares it and keeps it in `_assistantCoordination`: the one instance of the server (a test reads `server.js` and fails on a second `createCoordinationService(`). It is closed on every stop path: on SIGINT / SIGTERM after the Assistant's own shutdown handlers, and at the end of the graceful shutdown (Restart Server, `/api/server/shutdown`, an update) once the workers are suspended or stopped and before the memory database closes; closing twice does nothing. A crash leaves the write-ahead log, which the next open reads back. The later team scheduler takes this service's `store` for `createTeams({ store })` (`lib/teams/`): claims, the journal, the team channel and the run events are then one file at one schema version (`tests/agents-integration-seams.test.mjs`). A dispatcher or a runtime that is given no service and finds none shared keeps one in memory (tests). A file that cannot be opened (damaged, or written by a newer SynaBun) is left as it is and replaced by a store in memory, with a warning: `service.degraded` says why, `service.durable` is false.

### What is wired

| Where | What |
|---|---|
| `assistant-dispatch.js` `emit` | `service.recordDispatch(payload)` before the broadcast and the listeners: the event is in the log in the step that changed the run |
| `assistant-dispatch.js` `wait` | `createRunWaits` (`assistant-run-wait.js`): `until:"event"` reads typed events after a cursor; a workflow's runs are looked up at every check |
| `assistant-dispatch.js` `sendTurn`, the turn loop, `resumeRun`, `notResumed`, `stop`, `finalize` | follow-ups go through `service.followUps` (the outbox) |
| `assistant-dispatch.js` `transcript`, `pushRingLine`, `finalize` | `createRunTailStore` (`assistant-run-tail.js`): the tail and the last turn's text on disk |
| `assistant-runtime.js` mailbox section | `service.mailbox`: the mailbox is the open events of `session:<id>` |
| `assistant-api.js` `/wait`, `/runs/:id/wait`, `/runs/:id/transcript` | pass `afterSeq`, `kinds`, `offset`; settle what a brain read with an event wait |
| `mcp-server/src/tools/agents.ts` | `agent_wait` `after_seq` / `kinds` (and `run_ids` up to 50), `agent_read` `offset` |

### Run events

`service.recordDispatch(payload)` takes the dispatcher's `{ type: 'assistant:dispatch', reason, run, … }` and appends one event. It never throws (a failure is logged and answered with null: the run goes on).

| Dispatcher reason | Kind | Priority | Told to the owning session |
|---|---|---|---|
| `turn_completed` | `run.result` | normal | yes (not when the turn ended asking: `needs_input` carries it) |
| `needs_input` | `run.needs_input` | critical | yes |
| `permission_request` | `run.permission` | critical | yes |
| `failed` | `run.failed` | critical | yes |
| `interrupted` | `run.interrupted` | critical | yes |
| `stalled` | `run.stalled` | critical | yes |
| `budget_exceeded` | `run.budget` | critical | yes |
| `budget_warning`, `budget_unpriced` | `run.budget` | normal | yes |
| `stopped` | `run.stopped` | normal | only for a stop by the user, a budget or the work-time cap (`time_cap`: the cap's timer, or a queued follow-up dropped because the work time is used up) (`MAILBOX_STOP_REASONS`); its `text` names the follow-ups that were never delivered |
| `user_intervened` | `run.notice` | normal | yes |
| `queue_started`, `suspended`, `resumed` | `run.progress` | low | yes (folded per run) |
| `completed` | `run.completed` | normal | no (its result came as `run.result`) |
| everything else (`turn_started`, `idle`, `running`, `follow_up_queued`, `memory_stored`, `tools_changed`, …) | `run.progress` | low | no: logged only |

- **Stable ids.** `runEventId(payload)`: a turn's result is `run:<runId>:turn:<n>:result`, its question `run:<runId>:turn:<n>:needs_input`, a relayed request `run:<runId>:request:<requestId>`, anything else `run:<runId>:<reason>:v<version>:<updatedAt>` (the run's version and time of that change). Recording the same event again stores nothing. The runtime records every dispatcher event it hears too: with the shared service that is always a duplicate, and it is what makes a dispatcher without the service (a test's stand-in) work.
- **Payload.** The mailbox item of that reason, small: `kind` (what the brain reads: `result`, `needs_input`, `failed`, …), `reason`, `turn`, `taskId`, `summary` (400 characters), `question`, `files` (50), `follow_ups` (10), `request`, `error`, `text`, `unverified`, `resultSource`, `media`, and `run`: a brief (`runBrief`: id, provider, model, title, state, outcome, completion reason, cost, memory flag, workflow, limit, escalation, and for a run that runs as an agent its `agentRef` and `agentRevision`, from the run's first event on; a plain worker's brief has neither key, and the pin's detail and the role block never ride in an event). An event wait's events (`eventBrief`) carry `agentRef` too. Never the worker's text or its turns: a run view is tens of kilobytes, an event a few hundred bytes.
- `service.runEvents({ runIds, afterSeq, kinds, limit })` → the events of those runs after a position, oldest first, as `eventBrief` (`seq`, `id`, `kind`, `priority`, `runId`, `at`, and `reason`, `turn`, `summary`, `question`, `error`, `text`, `state`, `outcome`, `request` when there). Reads the log: nothing is delivered or acknowledged, so the same position gives the same events again.
- `RUN_WAIT_KINDS`: what an event wait takes when no kinds are named (everything but `run.progress`). `RUN_EVENT_KINDS`: every kind a run's events are logged as. `mcp-server/src/tools/agents.ts` carries a copy; `tests/coordination-service.test.mjs` fails when one drifts.

### The mailbox

`service.mailbox`, per Assistant session (`session:<id>`):

- `post(sessionId, item, { id, kind, priority, runId, coalesceKey })` → `{ id, seq, duplicate, kind, priority }`. For what is not a run's own event: `memory_due`, `route_decided` / `route_expired` / `route_declined`, `clarify_answered` / `clarify_declined`. `item.kind` picks the event kind (`MAILBOX_ITEM_KINDS`; unknown: `session.notice`). `item.run` is cut down to a brief.
- `pending(sessionId, { limit, peek })` → `{ items, more }`: critical first, then oldest first, low-priority progress folded (`merged` on the newest). At most `limit` (default 30) items; `more` is how many stay open. Each item is the event's payload plus `eventId`, `seq`, `eventKind`, `priority`, `at`, and `redelivered` when it was handed out before.
- `ack(sessionId, eventIds)`, `count(sessionId, { priority })`, `discard(sessionId, match)` (settle without telling: a removed run, a request answered elsewhere, a result the brain read itself; `match` null: everything), `sessions()` (who has something open), `subscribe(fn)` (`fn(sessionId, event)` after an append committed).

How the runtime uses it (`assistant-runtime.js`, the mailbox section):

- **No batch window.** A critical event schedules its turn with no timer (`pumpSoon`); it starts as soon as the session is free (measured on a file-backed store: 0.4 to 2.4 ms from the event to the brain's turn, 101.5 ms for a result; both took 2,000 ms). Every other event waits `mailboxDebounceMs` (default 100, never above 150; `mailboxBatchMs`, the old 2 s setting, is read as this) so results that arrive together go in one turn. A critical event inside that window takes the waiting ones with it, at once.
- **Busy.** While a turn runs, or a plan card is open, nothing is delivered and nothing is handed out: events wait in the store and go when the session is free (the turn's end pumps; `busyRecheckMs` covers a brain that frees up without one).
- **Acknowledged after the start.** The turn is composed from `pending`, sent with `runQuery`, and only `{ ok: true }` (the brain took the prompt) acknowledges its events. A refusal, a failure or `ASSISTANT_BUSY` leaves every one of them open. After a failed start the turn is tried again (`mailboxRetryDelaysMs`, default 1 s, 5 s, 30 s), then the mailbox holds until a turn of the session ends, a new event arrives or the budget changes: it never spins.
- **A restart.** Open events stay in the file. Once the server answers its workers (`dispatcher.whenServerReady()`, then `mailboxBootDelayMs`), every session with something open is delivered again. A session that was removed has its events settled; one the user closed keeps them until it is opened again (and a closed session stays closed across a graceful restart).
- **Duplicates.** An event has one id and one delivery per session: appended twice it is one event, acknowledged it is never handed out again. A result the brain read with `agent_wait`, `agent_read` or `agent_status` (the dispatcher's delivery mark) is settled when it is recorded and again before a turn is composed; events it read with `agent_wait until:"event"` are settled by their ids once the answer is out.
- **Depth.** Nothing is dropped for being many. A message carries at most `mailboxItems` (30) events and says how many follow; the rest go in the next turn. `live.mailbox` in the runtime is a look at the store (`pending` with `peek`), kept for diagnostics and tests; nothing is stored on the session.
- `mailboxAuto: false` (a test setting) stops the scheduler from starting mailbox turns; `_internals.deliverMailbox(live)` starts one.

### Run waits (`lib/assistant-run-wait.js`)

`dispatcher.wait({ runId, runIds, workflowId, assistantSessionId, until, mode, timeoutMs, afterSeq, kinds, unseenFor })`:

- `until: 'idle' | 'terminal'` read the runs' state as before. The answer gained `cursor` (the log's newest seq), nothing else changed.
- `until: 'event'` waits for typed events. `kinds` narrows them (default `RUN_WAIT_KINDS`; an unknown kind is `INVALID_KINDS`, 400). `afterSeq` is the cursor of an earlier answer (`INVALID_CURSOR` when it is not a whole number from 0). Without one the wait starts at the newest event, or, with `unseenFor: <sessionId>` (the API passes the asking brain's session), at the oldest event of those runs that session has not been told yet. The answer adds `events` (at most 50, with their `seq`) and `cursor`: pass it back to go on from there.
- `mode` defaults to `'any'` for an event wait (the next event of any of the runs) and to `'all'` for a state wait (a barrier).
- A run that ended always answers an event wait. One that waits for a decision (`awaiting_permission`, `awaiting_route`) answers at once only without a cursor; with one, only what is new does, so a caller that saw the request does not spin.
- A workflow's members are looked up at every check and at the answer: a run dispatched into it after the wait began is waited for. One wait follows at most 200 runs (it used to take 20 and ignore the rest); `notWaitedFor` says how many were left out, `TOO_MANY_RUNS` refuses a longer explicit list.

### Follow-ups

`service.followUps`: `enqueue({ runId, text, sessionId, origin, taskId, at, id })` → `{ id, duplicate, position }` (throws `OUTBOX_FULL` past `followUpsPerRun`, 20), `next(runId)` (the oldest unsent, or null), `markSent(ids)`, `count(runId)`, `cancel(runId, ids)` → the items, `runs()`.

In the dispatcher every follow-up goes through it, also one an idle run takes at once: `sendTurn` queues it and wakes the turn loop, which takes the oldest unsent item. It is marked sent in `runInnerTurn` right before the provider is handed the prompt, so a restart from then on continues that turn (`resumeInfo.inFlight`) and never sends the text twice; one that was taken but not handed over yet comes back. `sendTurn` answers with `followUpId`, and refuses the 21st waiting follow-up with `FOLLOW_UP_QUEUE_FULL` (409, `queued`, `limit`). A run that ends, is stopped or does not resume has its unsent follow-ups cancelled, and its notes say how many and quote the first; at a start, follow-ups queued for runs that are gone or ended are cancelled the same way (`settleOrphanFollowUps`).

### Transcripts (`lib/assistant-run-tail.js`)

`<dataDir>/run-tails/<run>.tail.json` holds the run's last transcript lines (the dispatcher's ring; written at most once a second while it works, and when it ends); `<run>.text.json` the whole text of its last turn (at most 1,000,000 characters). `transcript(runId, { format, tail, maxChars, offset })` reads a live run's ring, else the file, so `agent_read` `tail` works after the run ended and after a restart, and a resumed run's tail goes on where it was. `offset` pages the text of `text` and `tail`: without it the answer is the END of the text (as before) with `offset` (where that page starts), `totalChars` and `nextOffset: null`; with it the page starts there and `nextOffset` is where the next one starts. The files go with the run when the registry drops it (and a sweep a while after each start).

### The team channel: what the `team` tool sits on

Phase P4 exposed it: a team slice's worker reaches it through the MCP `team` tool, `/api/assistant/team/*` and the team scheduler's `post` / `read` / `wait` / `ack` (`lib/teams/scheduler.js`; `docs/agents.md` → Teams → The tools). `service.team` is the API under it; it is tested (`tests/coordination-service.test.mjs`).

- A team has a **lead** mailbox, `teamRecipient(teamId)` (`team:<id>`: the scheduler, the integrator, or the Assistant session that runs the team), and one mailbox per **member**, `teamMemberRecipient(teamId, runId)` (`team:<id>:run:<runId>`). A member's mailbox holds that team's messages for that run and nothing else, so reading, waiting and acknowledging are scoped by team and run by construction; the same run in another team has another mailbox.
- `team.post({ teamId, fromRunId, to, members, kind, text, payload, priority, id, sessionId })` → `{ id, seq, duplicate, recipients }`. `to`: `'all'` (default: every other member and the lead, never the sender), `'lead'`, a run id or a list. `members`: the team's runs when the caller knows them; default `team.members(teamId)`, the runs the journal's newest slice entries name (the worktree phase writes those). `kind` defaults to `team.message`; `text` is at most 8,000 characters; `payload` is merged into the event's payload beside `from` and `text`. Give retries an `id`.
- `team.read({ teamId, runId, afterSeq, kinds, limit, peek })` → the member's events after a position (default: its cursor), oldest first; no `runId`: the lead's. Reading acknowledges nothing.
- `team.wait({ teamId, runId, afterSeq, kinds, timeoutMs, limit, signal })` → `{ events, timedOut, closed, aborted }`, like the store's `waitFor`.
- `team.ack({ teamId, runId, eventIds })` or `{ throughSeq }` → `{ acked, cursor }`. `team.cursor({ teamId, runId })`.
- `team.log({ teamId, afterSeq, kinds, limit })` → everything said in the team, whoever it was for (a timeline; delivers nothing).

What that phase had to decide, and did (`lib/teams/scheduler.js`): the caller is its run's proven pin and its team is the scheduler's record of that run, never an argument; a worker that waits warm gets a message as a follow-up (`dispatcher.sendTurn`, origin `peer`) and a working one keeps it in its mailbox until its next `team` call or the end of its turn; a post to the lead is a `team_message` event of the session's mailbox (kind `team.lead_message`; the scheduler appends it itself, with the team's id, rather than through `MAILBOX_ITEM_KINDS`); posts are counted per worker; a team run's record carries `teamId`, so its events are in `team.log`. The list as it was written for that phase:

- **Who may post as whom.** The service trusts `fromRunId`. The tool must take the caller's run from its proven pin (`X-Synabun-Terminal` with its proof, as `runReadAllowed` in `assistant-api.js` does) and its team from the journal, never from an argument.
- **Reaching a worker.** A message in a member's mailbox wakes nobody by itself: a worker reads at its `wait` call. To put text into a worker's conversation instead, use `dispatcher.sendTurn(runId, text)` (the outbox; bounded at 20 per run).
- **The lead.** For a team the Assistant runs, post `to: 'lead'` events also into the session's mailbox (`service.mailbox.post(sessionId, { kind: … })`) when the brain must react, with a kind added to `MAILBOX_ITEM_KINDS` and to `formatMailbox` in `assistant-persona.js`. `claim.conflict` and `integration.conflict` are critical already.
- **Limits.** No rate limit, no per-team quota and no pruning of read team messages beyond the store's `prune` (settled events older than 14 days). Add what the tool needs.
- **Run events of a team's runs** carry no `teamId` today (the dispatcher's run view has none). Once a run record knows its team, set `run.teamId` and `recordDispatch` stores it, so `team.log` shows the runs' results in the channel.
