# Git teams: managed worktrees, path claims, integration and landing (Agents system, phase P3)

One task given to several workers at once, with git doing the isolation: every slice of the task gets its own worktree and branch, slices hold the files they own while they work, finished slices are joined on an integration branch and tested there, and the user's branch receives the result only through a separate landing step.

This is a library with injected dependencies: a coordination store (`lib/coordination/store.js`), a git runner and a test-command runner. Phase P4 wired it: `scheduler.js` owns a team's life on top of it (the section [The scheduler](#the-scheduler-phase-p4) below; `docs/agents.md` → Teams is the reference for the tools and the routes), and `server.js` makes the one `createTeams(...)` and the one scheduler in its `agents-p4` block.

The contracts it builds on are phase P0's, documented in `lib/coordination/README.md`: the team plan (`lib/teams/schema.js`) and the store's claims and journal.

| Module | What it is | Tests |
|---|---|---|
| `index.js` | `createTeams(deps)`: the one object a scheduler uses | all of the below |
| `worktrees.js` | create a team, list, inspect, start a slice, remove, prune; the dependency setup step | `tests/teams-worktrees.test.mjs` |
| `claims.js` | path claims in the store, `checkWrite`, the context for the worker guard, the ownership check after the fact | `tests/teams-claims.test.mjs` |
| `integration.js` | finish a slice (server-managed commit), join it on the integration branch, run the tests, conflict reports | `tests/teams-integration.test.mjs` |
| `landing.js` | `land`: the integration branch into the user's branch | `tests/teams-landing.test.mjs` |
| `recovery.js` | `recover`: after a crash, a record that matches git and the disk | `tests/teams-recovery.test.mjs` |
| `state.js` | a team's record, folded from the store's journal | used by all |
| `git.js` | the git runner, the readers of git's answers, the locks | `tests/teams-worktrees.test.mjs`, `tests/git-read-safety.test.mjs` |
| `test-runner.js` | the default test-command runner | `tests/teams-integration.test.mjs` |
| `scheduler.js` | phase P4: `createTeamScheduler(deps)`, a team's life over the dispatcher, the density check, the events, the channel | `tests/teams-scheduler.test.mjs`, `tests/teams-channel.test.mjs` |
| `brief.js` | phase P4: the TEAM block of a slice's brief, the follow-ups, the untrusted-peer wrapper | `tests/teams-channel.test.mjs` |
| `api.js` | phase P4: the routes (`/api/assistant/teams/*`, `/api/assistant/team/*`, `/api/agents-studio/v1/teams*`) | `tests/teams-api.test.mjs` |
| `test-sandbox.js` | phase P4: the integration tests under the worker sandbox (macOS) | `tests/teams-test-sandbox.test.mjs` |
| `../worker-confinement.js` | the team-slice rule of the worker guard | `tests/teams-claims.test.mjs`, `tests/worker-confinement*.test.mjs` |

Run one with `node --test tests/<name>.test.mjs` from `neural-interface/`. The tests work on real git repositories in a temporary folder (`tests/helpers/team-repo.mjs`).

## Owner rules these modules encode

Taken with the owner on 2026-11-15. They are binding; a later phase follows them.

- **Agents never work in the user's checkout or on the user's branch.** Every slice worker gets its own worktree and branch, cut from one pinned base commit. The user's uncommitted files are never touched, stashed, committed or seen: a worktree is a checkout of a commit, and nothing here writes the user's checkout, index, stash or branch before a landing.
- **Everything lives under the project's own `.worktrees` folder**: `<project>/.worktrees/<team>/<slice>`, the integration worktree at `<project>/.worktrees/<team>/integration`; branches `synabun/<team>/<slice>` and `synabun/<team>/integration` (the schema's helpers). `.worktrees/` is added to the repository's `.git/info/exclude` when the project does not ignore it yet, never to `.gitignore`.
- **The combined result goes to the integration branch.** The user's branch receives it only through `land`, a step somebody asks for.

## A team's life

```js
import { createTeams, cloneNodeModules } from './lib/teams/index.js';

const teams = createTeams({ store });           // + git, runTests, setup, identity when not the defaults
await teams.recover();                           // once, at start-up, before anything else

const made = await teams.create(plan, { density: 'team', testCommand: 'npm test', createdBy: sessionId });
// made.team.worktrees: [{ sliceId, path, branch }], made.team.baseCommit: the pinned commit

const started = await teams.startSlice(teamId, 'api', { runId });
// dispatch the worker with cwd = started.worktree and capability workspace; the worker guard knows the slice
// by that folder (no adapter change needed), or pass started.context as resolveWorkerConfinement({ team })

const finished = await teams.finishSlice(teamId, 'api', { runId, message });   // SynaBun commits the slice's own files
const joined = await teams.integrate(teamId, 'api');                            // cherry-pick + tests on that commit
// …or teams.integrateAll(teamId): every finished slice, in dependency order

const landed = await teams.land(teamId, { targetBranch: 'main', mode: 'ff' });  // only when asked for
await teams.remove(teamId);                                                      // worktrees and branches, after the landing
```

Every function answers `{ ok: true, … }` or a refusal `{ ok: false, code, message, … }`. None throws for something a caller can act on (a git that cannot be started throws `TeamGitError`).

States (the journal's; `TEAM_STATES` / `SLICE_STATES` in `schema.js`):

- team: `creating` → `planned` → `running` ⇄ `integrating` → `ready` → `landing` → `merged`; or `failed` (creation), `cancelled` (discarded). `removed: true` on the record once its worktrees and branches are gone.
- slice: `planned` (its task is recorded) → `pending` → `running` → `done` or `rejected` → `integrating` → `integrated`, `conflict` or `tests-failed`; or `failed`, `cancelled`.

`creating`, `integrating` and `landing` are written before the step they name runs. A team found in one of them after a restart was interrupted: every function refuses it (`TEAM_NEEDS_RECOVERY`) until `recover()` ran.

## `createTeams(deps)` (`index.js`)

```js
createTeams({ store, git, runTests, setup, identity, isIgnored, registry, now, log })
```

| Dependency | Default | |
|---|---|---|
| `store` | required | a coordination store. Claims, the journal and the event log are its |
| `git` | `createGitRunner()` | `(args, { cwd, input, env, timeoutMs }) => Promise<{ ok, status, stdout, stderr }>` |
| `runTests` | `createTestRunner()` | `({ cwd, command, commit, teamId, sliceId, projectPath }) => Promise<{ ok, exitCode?, output?, durationMs?, timedOut? }>` |
| `setup` | none | the dependency setup step of every new team (below) |
| `identity` | the repository's own | `{ name, email }` for SynaBun's commits |
| `isIgnored` | `git check-ignore` | `(worktree, relPath) => boolean` |
| `registry` | `lib/worker-confinement.js` | `{ register, unregister }`: where slices are registered for the worker guard |

It returns: `create`, `get`, `plan`, `list`, `inspect`, `startSlice`, `finishSlice`, `integrate`, `integrateAll`, `testIntegration`, `resolveInSlice`, `acceptIntegrationHead`, `land`, `remove`, `prune`, `recover`, `checkWrite`, `verifyOwnership`, `context`, and `modules` (`state`, `worktrees`, `claims`, `integration`, `landing`, `recovery`) for a caller that needs one module's own functions.

## Worktrees (`worktrees.js`)

**`create(plan, { density, maxSlices, testCommand, setup, createdBy })`** → `{ ok, team, setup, excluded, claims }`

- `plan` is a team plan. `baseCommit` may be left out: the project's HEAD is pinned. One it names must be a commit of the repository (a plan made earlier keeps its base).
- `density` / `maxSlices` are `validateTeamPlan`'s (the cap on slices). With neither, Solo applies: one slice.
- `testCommand`: text (run through the shell) or a list of arguments. Stored on the team; `integrate` runs it.
- Makes every slice's worktree and branch and the integration ones from the base, records the team (`creating`, then `planned`), and takes every slice's claims.
- The plan is stored whole (tasks included) and comes back from `plan(teamId)`.

Refusals: `NOT_A_GIT_REPOSITORY` (the message says to `git init` and commit, or use one worker), `PROJECT_NOT_REPO_ROOT`, `NO_COMMITS`, `PROJECT_NOT_FOUND`, `BASE_NOT_FOUND`, `INVALID_PLAN` (`errors`: `validateTeamPlan`'s), `INVALID_TEST_COMMAND`, `TEAM_EXISTS` (`existing`: what is in the way), `WORKTREE_FAILED` (what was made is taken back), `CLAIM_CONFLICT`.

`TEAM_EXISTS` is answered when the team's folder exists (`.worktrees/` also holds worktrees people make by hand, such as this repository's `.worktrees/agents-system`), when a `synabun/<team>/…` branch exists, when a worktree is registered under the team's folder, when a branch named `synabun` or `synabun/<team>` blocks the names, and when the journal already has the team. A team id is used once: also after the team is removed.

**Read-only plans.** The scheduler derives `readOnly: true` from `task_class: research|review`. Such slices have no owned paths, lockfile ownership or dependencies. `create` makes only slice worktrees from the pinned base; it skips integration, test commands and dependency setup. `finishSlice`, `integrate` and `land` refuse them with `TEAM_READ_ONLY`.

**`finishReadOnlySlice(teamId, sliceId, { failed })`** is called after the worker ends. It verifies the registered worktree, branch, pinned HEAD and clean status (including ignored files). Clean worktrees and their branches are removed; changes, commits, unknown state or removal failures are kept and reported in `cleanup`. Each slice ends as `completed` or `failed`; once all ended, the journal team is `completed`. Recovery never recreates finished worktrees. Read-only `remove` uses the same conservative check, even on discard.

**`startSlice(teamId, sliceId, { runId })`** → `{ ok, sliceId, worktree, branch, startCommit, rework, context }`

- A slice starts once the slices it depends on are `integrated` (`DEPENDENCIES_NOT_INTEGRATED`, with `waiting`). A slice with dependencies is first brought up to the integration branch by a fast-forward, so its dependencies' work is in its worktree; a slice without stays on the base.
- `startCommit` is where the slice's own work begins.
- Starting a slice that a worker has been at (`running`, `done`, `rejected`, `conflict`, `tests-failed`) is a rework: nothing moves, the slice is `running` again and holds its claims again.
- `context` is the slice's context for the worker guard.

**`inspect(teamId)`** → per slice: `path`, `branch`, `exists`, `registered`, `onBranch`, `head`, `base: { ahead, behind }`, `integration: { ahead, behind }`, `unintegrated` (commits whose change is not on the integration branch), `dirty`, `changes`, `lastCommit`, `state`; the integration branch (`head`, `recordedHead`, `moved`, `lastGood`, `tests`); the target branch (`head`, `fastForward`).

**`list({ projectPath, states, includeRemoved })`** → the teams the journal knows, oldest first.

**`remove(teamId, { discard, force })`** → `{ ok, complete, landed, removed, kept }`

- Only after a landing, or with `discard: true` (`TEAM_NOT_LANDED` otherwise).
- A worktree with uncommitted changes and a branch with commits that are nowhere else are kept and listed in `kept` (`reason: 'uncommitted_changes' | 'unintegrated_commits'`, with `files` or `commits`), unless `force: true`. So is a plain folder that sits where a worktree should be (`folder_is_not_a_worktree`): what is in it is unknown. After a landing a slice is measured against the integration branch; in a discard, against the user's branch.
- What is removed is written to the journal with the commit each branch pointed at (`removal.removed[].head`): until git's own garbage collection, `git branch <name> <head>` brings one back.
- The team is then `merged` or `cancelled`, with `removed: true` when nothing was kept. Its claims are given back.

**`prune({ projectPath })`** → clears worktree registrations whose folder is gone (`git worktree prune`) and empty folders of teams the journal knows. A branch is never pruned; a folder somebody made by hand is never touched.

### Dependency setup

Dependencies are not installed per worktree. `setup` is a step the caller supplies, called once per worktree with `{ projectPath, worktree, teamId, sliceId, git }`; a failure is reported in `create`'s `setup` list and is not fatal. The default is none.

`cloneNodeModules({ paths, limit })` is one such step: a copy-on-write clone of the project's `node_modules` folders (the ones beside a tracked `package.json`, or `paths`) into the worktree. Only folders git ignores, and only where the file system can clone (APFS, Btrfs, XFS with reflinks): elsewhere nothing is copied and the answer says `clone_not_supported`.

Changing dependencies is the lockfile-owner slice's: lockfiles belong to it by rule (`pathOwner`), and a manifest (`package.json`, `Cargo.toml`, `pyproject.toml`, …) changed by another slice is reported as a `manifest_changed` warning when that slice finishes. Give manifests to the lockfile owner in the plan.

## Claims and what a slice may write (`claims.js`)

Each slice holds its claimable paths (`claimablePaths(plan, sliceId)`) in the store from the moment the team is created; `startSlice` puts them in the run's name; `finishSlice` gives a finished slice's back; a landing or a removal gives the team's back.

**`checkWrite(teamId, sliceId, path)`** → `{ allow, decision: 'allow' | 'deny', owner, relPath, code, message }`

`path` is relative to the project (a slice's worktree is a checkout of it) or absolute inside the slice's own worktree.

| `code` | | |
|---|---|---|
| `owned` | allow | the slice's file, and its claim is held |
| `lockfile_owner` | allow | a dependency lockfile, and this slice is the plan's lockfile owner |
| `ignored` | allow | git ignores the file (build output, `node_modules`): it is never committed |
| `other_slice` | deny | `owner` is the slice that has it |
| `unowned` | deny | no slice owns it |
| `lockfile` | deny | a lockfile, and this slice is not the lockfile owner (`owner`: who is, or null) |
| `claim_released` | deny | the slice's own file, but the slice finished |
| `reserved_path` | deny | `.git` or `.worktrees` |
| `outside_worktree` | deny | an absolute path outside the slice's worktree (the user's checkout, another slice's worktree, anywhere) |
| `invalid_path`, `unknown_slice` | deny | |

A denial's `message` names the owner and says to ask over the team channel.

**`context(teamId, sliceId)`** → what the worker guard needs: `{ teamId, sliceId, worktree, projectPath, ownedPaths, lockfileOwner, channel, check(relPath) }`. `channel` is `teamRecipient(teamId)`.

**`verifyOwnership(teamId, sliceId)`** → `{ ok, head, reference, changed, violations, uncommitted, stray, warnings }`: what the slice's branch changed since it parted from the integration branch (`git diff` from their merge base), against what the slice owns. `violations` are committed changes to files that are not the slice's; `stray` are uncommitted ones. `finishSlice` runs it.

### The worker guard (`lib/worker-confinement.js`)

A run that works a team slice is confined to the slice's own worktree **and** its owned paths:

- `resolveWorkerConfinement({ …, team })` takes the slice's context. Without `team`, a working directory inside a registered slice's worktree makes the run that slice's: `claims.js` registers every slice of a team under way (`registerTeamSlice`), so an adapter that knows nothing about teams confines a slice all the same. The scheduler only has to start the worker in `started.worktree`.
- A team slice is **always guarded**: capability `full` is read as `workspace`, and the Protect workers setting does not turn the rule off or down to a warning. `confinement.team` carries the slice.
- A write to a file that is not the slice's is refused with rule `team-ownership`. The refusal names the owner and tells the worker to ask it over the team channel. This holds for Claude Code's file tools, redirections and writing programs in the shell, OpenCode's edit asks and Antigravity's edit / delete / move calls. The temp folder and the run's scratch folder stay writable; the rest of the project (the user's checkout, the other slices' worktrees) never is, also for a project kept under a folder a workspace run may write.
- git is for reading (rule `team-git`): `status`, `diff`, `log`, `show`, `blame`… run; `add`, `commit`, `stash`, `switch`, `push`, `merge` and the rest are refused, and so is the git tool's `commit` action. SynaBun commits the slice's work. `git stash` is shared by every worktree of a repository: a worker's `pop` would take the user's own stash.
- Runs with no team context are confined exactly as before.

**The limit, stated plainly.** The guard reads tool calls and command lines. A program a worker runs (a script, a build, a test runner, a formatter, `node -e`) writes what it writes without being seen, and Codex's sandbox confines a slice to its worktree but knows nothing of owned paths. What catches such a write is the check after the fact: `finishSlice` compares what the slice's branch changed with what it owns and rejects the slice. Under the macOS sandbox of a protected worker, the repository's own data is outside the worktree and not writable, so a worker cannot commit there in any case.

## Finishing and joining (`integration.js`)

**`finishSlice(teamId, sliceId, { message, allowStray, runId })`** → `{ ok, sliceId, head, committed, changed, stray, warnings, ignored }`

- Commits the files the slice owns that are changed in its worktree, on the slice's branch. A file that is not the slice's and was staged already (a program the worker ran staged it) is taken out of the index first; the file itself stays as it is. The commit uses the repository's own identity (`user.name` / `user.email`, as the user's commits do; `identity` when given; `SynaBun Agents <agents@synabun.invalid>` for a repository that has none), a subject from `message` or the slice's title, and the trailers `SynaBun-Team`, `SynaBun-Slice` and `SynaBun-Run`. It is not signed and runs no hook.
- Then checks the branch (`verifyOwnership`):
  - `OWNERSHIP_VIOLATION`: the slice's own commits touch a file it does not own (`violations`). The slice is `rejected`, whatever is passed.
  - `STRAY_CHANGES`: files it does not own are changed in the worktree (`stray`). They are left there, uncommitted; the slice's own files are committed; the slice is `rejected`. With `allowStray: true` the slice is `done` and the leftovers are reported: they never reach the integration branch.
- Ignored folders:
  - A file git tracks is committed even inside a folder the `.gitignore` covers (a force-tracked build output such as `mcp-server/dist`). Tracked paths are staged with `git add -u`, new ones with a plain `git add`, never `-f`.
  - A new file the `.gitignore` covers is never committed. It is named in `ignored` (`[{ path }]`; a wholly untracked ignored folder is one entry with a trailing `/`), which is also kept on the slice's record.
- Other refusals: `SLICE_NOT_STARTED`, `SLICE_ALREADY_INTEGRATED`, `SLICE_WORKTREE_MISSING`, `SLICE_BRANCH_MOVED` (the worktree is not on the slice's branch: nothing is committed), `SLICE_WORKTREE_BUSY`, `UNRESOLVED_CONFLICTS` (`files`), `GIT_FAILED`, `COMMIT_FAILED`.
- When staging or the commit fails (`GIT_FAILED`, `COMMIT_FAILED`), the answer carries:
  - `git: { command, status, output }`, where `output` is everything git said: stderr, then stdout, at most 4 KB, with both ends kept.
  - `indexRestored`: the index entries of the slice's own paths are put back exactly as they were before the attempt, unmerged stages included, so a failed attempt leaves nothing staged.
- A finished slice gives its claims back.

**`integrate(teamId, sliceId, { test, testCommand })`** → `{ ok, sliceId, method, commit, before, tests, ready }`

- Only a `done` slice, and only after the slices it depends on (`SLICE_NOT_DONE`, `DEPENDENCIES_NOT_INTEGRATED`).
- The slice's commits since its last join are cherry-picked onto the integration branch in the integration worktree (`method: 'cherry-pick'`). A slice that carries the integration branch in it (after `resolveInSlice`) is joined by fast-forward, or by a merge when the integration branch moved meanwhile. A slice with nothing new is `method: 'none'`.
- The test command (the team's, or `testCommand` for this join) runs on exactly the resulting commit: the runner gets `commit`, the worktree is on it with nothing uncommitted, and a run that moves the branch does not count. With `test: false` or no command, nothing runs and the head counts as untested.
- One join at a time per team.

It answers a refusal, and changes nothing on the integration branch, for:

- **`CONFLICT`**: the cherry-pick is aborted and the integration worktree is exactly as before. The slice is `conflict`. `report`:
  ```js
  { teamId, sliceId, method, integrationBranch, integrationHead, sliceBranch, sliceHead, stoppedAt, clean,
    files: [{ path, owner,
              ours:   { side: 'integration', commit, subject, slice, blob },   // what is on the integration branch
              theirs: { side: 'slice', commit, subject, slice, blob },          // the slice's commit
              base, excerpt }] }                                                 // the common version; the first conflict, markers included
  ```
  Route it to the slice's owner or to an integrator worker. Nothing is ever resolved by force. An `integration.conflict` event is appended to the store's log.
- **`TESTS_FAILED`**: the integration branch is taken back to the commit before the join, the last good one. The slice is `tests-failed`. `report: { teamId, sliceId, candidate, before, tests: { ok, exitCode, timedOut, output, … }, clean }`; `candidate` is the commit that failed (it stays in the repository until git collects it).
- `SLICE_MOVED` (the slice's branch moved since it was finished: finish it again), `INTEGRATION_MOVED` (the integration branch is not where SynaBun left it), `INTEGRATION_FAILED`, `INTEGRATION_WORKTREE_MISSING`.

When the last slice is joined the team is `ready` and an `integration.ready` event is appended.

**`integrateAll(teamId, options)`** → `{ ok, ready, results }`: every finished slice in `integrationOrder(plan)`; a slice that is not finished or waits for one that is not joined is skipped; a failure does not stop the slices that do not depend on it.

**`testIntegration(teamId, { testCommand })`**: runs the tests on the integration head as it is and records the answer for that commit. Nothing is taken back when they fail.

**`resolveInSlice(teamId, sliceId, { runId })`** → `{ ok, worktree, integrationHead, conflicts }`: for a slice in `conflict`. Brings the integration branch into the slice's worktree (a merge left open) with the conflicts in the slice's own files, for its owner. The slice is `running` again. `finishSlice` refuses while conflict markers are left (`UNRESOLVED_CONFLICTS`) and then commits the result; `integrate` joins it without a cherry-pick.

**`acceptIntegrationHead(teamId)`**: somebody committed on the integration branch itself, in its worktree (an integrator worker fixing what the slices together broke). Takes its head as the team's: only commits added on top of the recorded head (`INTEGRATION_REWOUND` otherwise), only a clean worktree. The new head counts as untested.

### The test command and its runner (`test-runner.js`)

`createTestRunner({ env, timeoutMs, outputBytes })`. Text is run through the shell, a list of arguments directly, in the integration worktree, 30 minutes at most, the end of its output kept. It runs with the server's rights and is **not sandboxed**: the code it runs is the team's work. A scheduler that wants the tests confined injects its own `runTests`. What the default keeps away is SynaBun's own environment: every `SYNABUN_*` and `TYPESAFE_*` variable, and anything that aims git at another repository.

## Landing (`landing.js`)

**`land(teamId, { targetBranch, mode, allowUntested, allowPartial })`** → `{ ok, landed, changed }`

- `targetBranch`: default, the branch the project was on when the team was created.
- `mode: 'ff'` (default) moves the target forward to the integration branch. `mode: 'merge'` makes a merge commit of the two (always, also when a fast-forward would do), computed without a checkout (`git merge-tree`, git 2.38 or newer), and moves the target to it.
- Where the target is checked out (the user's own checkout, usually), the branch, the index and the files are updated together by a fast-forward of that checkout. Every uncommitted change of a file the landing does not touch comes through unchanged, staged or not; nothing is stashed; no hook runs. Where the target is checked out nowhere, only the branch moves (compare-and-swap on its old commit).
- The team is then `merged` (`landed: { targetBranch, mode, from, to, mergeCommit, checkout, files, tested, partial }`) and its claims are given back.

A landing changes nothing, and answers with a `report`, for:

| Code | |
|---|---|
| `NOT_FAST_FORWARD` | `mode: 'ff'` and the target has commits the integration branch lacks (`targetOnly`, `integrationOnly`) |
| `MERGE_CONFLICT` | `mode: 'merge'` and the two do not merge cleanly (`files`). Never resolved |
| `TESTS_NOT_PASSED` | the tests have not passed on the integration head: no test command, not run on this commit, or failed. `allowUntested: true` lands on the caller's word |
| `TEAM_NOT_READY` | a slice is not joined (`slices`). `allowPartial: true` lands what is joined |
| `DIRTY_FILES_AFFECTED` | the landing would change a file that has uncommitted changes in the checkout that has the target, or write over a file that is there untracked or ignored (`files`) |
| `CHECKOUT_BUSY` | that checkout is in the middle of a merge, rebase, cherry-pick, revert or bisect |
| `CHECKOUT_REFUSED` | git would not update that checkout (it checks again as it starts) |
| `TARGET_MOVED` | the target moved while the landing was prepared |
| `INTEGRATION_MOVED`, `TARGET_NOT_FOUND`, `TARGET_REQUIRED`, `TARGET_IS_TEAM_BRANCH`, `NOTHING_TO_LAND`, `ALREADY_LANDED`, `INVALID_MODE`, `MERGE_UNAVAILABLE` | |

Where it applies, `report.userShouldRun` is what the user can run themselves (`git checkout <target>`, `git merge --ff-only synabun/<team>/integration`).

## Recovery (`recovery.js`)

**`recover({ teamId })`** → `{ ok, teams: [{ teamId, was, state, actions, attention }], claims }`. Call it once at start-up, before anything else. Safe to call again.

| Found | Done |
|---|---|
| `creating` | what is half-made is taken apart and made again (no worker had started: there is no work in it); the team is `planned`, or `failed` when it cannot be made |
| `integrating` | a cherry-pick or merge under way is aborted; the integration branch goes back to the commit before the join; the slice is `done` again. Also for a crash while the tests ran |
| `landing` | the target branch at the landing's commit: `merged`. Where it was: the team is as before. Anywhere else: reported |
| a worktree's folder gone | put back from its branch (what was uncommitted in the folder went with the folder) |
| a slice's branch and folder gone | the slice is `failed` |
| the integration branch and folder gone, every slice ended or gone, the integration head on the base branch already | the team is `merged` (merged outside `land`: `landed.external: true`, `landed.recovered: true`); nothing is made again |
| the integration branch and folder gone, every slice ended or gone, nothing joined (no slice `integrated`, the head still the base commit) | the team is `failed`; no empty integration branch is made |

A team closed that way gives its claims back, and `removed: true` is written when no branch or folder of it is left; a slice branch that is still there stays, for `remove` (after the landing) or a discard. The integration branch is still made again from its recorded head when any slice is at work or its branch is still there with its folder gone, when the head has commits the base branch does not have, or when the base branch is not there to compare with. Each closing is the action `team_closed` (`state`, `reason: 'merged_outside_landing' | 'nothing_integrated'`, `targetBranch`, `head`, `removed`).

It also takes the claims of every team under way again and registers every slice with the worker guard again (the guard's registry is in memory).

Recovery never deletes work. It removes only what a stopped creation left, and moves only the integration branch, back to a commit SynaBun recorded, when everything after that commit is a copy of commits a slice still has. What it does not understand it leaves alone and lists under `attention`: `branch_has_commits`, `unexpected_changes`, `integration_has_other_commits`, `integration_worktree_not_on_its_branch`, `integration_moved`, `folder_is_not_a_worktree`, `not_on_its_branch`, `target_moved`, `checkout_may_be_half_updated`, `slice_operation_under_way`.

## How git is run (`git.js`)

`createGitRunner({ binary, env, timeoutMs, maxBuffer, onCommand })`. Every command is an argument array, never a command line. A command that only asks goes through `lib/git-read.js`. A command that writes is given: no hook (`core.hooksPath` is the null device), no file system monitor program, no signing, no remote (`GIT_ALLOW_PROTOCOL` empty), no recorded conflict resolution (`rerere` off), no editor or prompt, no automatic garbage collection. Clean and smudge filters and custom merge drivers still run: a checkout or a merge without them is not the project's.

One thing every module checks before it writes in a folder: that the folder is a worktree of its own, on the branch it should be on (`branchAt` in `worktrees.js`). Asked inside a plain folder, git answers for the repository around it, which for a team's folders is the user's checkout. The reset that settles the integration worktree runs in a linked worktree only.

Operations on one repository's worktrees and branches take turns (`createLocks`): creation, removal, pruning and landing per repository; joins and tests per team; finishing per slice.

## The journal (`state.js`)

A team's record is its journal entries folded, oldest first: the newest entry's state is the state, and each entry's data lies over what came before. `teams.get(teamId)` returns it:

```js
{ teamId, state, plan, projectPath, baseCommit, baseBranch, headAtCreate, testCommand, createdBy,
  integration: { head, lastGood, tests: { ok, commit, command, at, exitCode, output } | null },
  integrating: { sliceId, before, sliceHead, method, phase: 'applying' | 'testing', candidate } | null,
  landing: { targetBranch, mode, from, to, checkout } | null, landed, removed, removal,
  slices: { [id]: { state, runId, task, ownedPaths, path, branch, startCommit, head, changed, stray, violations,
                    integrationCommit, integratedHead, method, conflict, tests } },
  createdAt, updatedAt }
```

Every entry is announced on the store's event log (kind `team.state` or `slice.state`, addressed to nobody, id `team:<team>:journal:<entry id>`, payload `{ teamId, sliceId, state, journalId }`), and `integration.conflict`, `integration.ready` and `claim.conflict` events are appended as they happen. A scheduler wakes on `store.subscribe({ teamId }, fn)` or `store.waitFor({ teamId, afterSeq })` and reads the record; nothing here addresses a recipient, so nothing waits in a mailbox.

A team id is the store's key: one store, one team of a name, whatever the project.

## The git tool (`mcp-server/src/tools/git-tools.ts`)

Two read-only actions for a worker or the Assistant, from git alone:

- `worktrees`: the repository's worktrees with their branch, head and uncommitted count; a team's are marked (`team <id> · slice <id>`).
- `team`: with `team`, the team's branches, how far each slice is joined on the integration branch, and whether the main checkout's branch can be fast-forwarded to it; without, the teams the repository has.

They ask git under the rules of a read and change nothing. The tool has no action that creates, joins, lands or removes: those are the scheduler's, through this library. Conflicts, test results and whether a team has landed are in the journal, not in git.

## The scheduler (phase P4)

`createTeamScheduler({ teams, coordination, dispatcher, density, router, session, git, dataDir, broadcast, limits })` (`scheduler.js`). `docs/agents.md` → Teams says what it does for the Assistant and the workers; this is what a caller of the library needs to know about it.

- **It is the only caller of the library in the server.** `server.js` shares it (`shareTeamScheduler`); the Assistant's API and the Agents Studio routes ask `sharedTeamScheduler()` when a request arrives. A test passes its own.
- **Its own record** is one JSON file per team in `<dataDir>/teams/<teamId>.json` (the session, the route, the dispatch settings, each slice's runs and retry counts, its status). Everything about git is read from the journal through the library, never kept twice. `remove(teamId)` deletes that file (and `teams/sandbox/<teamId>.sb`) for a closed team once git and the disk show nothing of it and no worker lives; the journal entry stays (a closed team's journal state is terminal, so `recover()` skips it, and its id is never made again), and a removed record is never saved again (`docs/agents.md` → Teams, Removing a closed team).
- **A team's steps never overlap**: every step of one team runs after the one before it (`inTurn`), and none runs before the library's `recover()` has.
- **The run id comes first.** `dispatchSlice` makes the run id, calls `startSlice(teamId, sliceId, { runId })` (or `resolveInSlice`), and only then dispatches with that id (`dispatcher.dispatch(spec, { team, runId })`): the claims are in the run's name before the worker exists. The dispatcher takes `team` and `runId` from the scheduler alone; no request body reaches them.
- **What it decides that the library leaves open** (the list below this section, as it was written for this phase): workers run with capability `workspace`; `STRAY_CHANGES` is answered with `allowStray: true` (the files stay out, the event names them); a conflict goes to the slice's own worker through `resolveInSlice`; `land` is never called because a team became ready; the workers are stopped before `remove`; the tests run through `test-sandbox.js`; the setup step is `cloneNodeModules()`; a team id is `<title>-<6 hex>`.
- **Limits** (`TEAM_SCHEDULER_LIMITS`): `maxRetries` 2 per slice and kind, `maxPeerDeferrals` 4, 40 posts per worker in 10 minutes, 4,000 characters a message, waits of at most 50 s.
- **Not done**: an integrator worker (somebody committing on the integration branch and `acceptIntegrationHead`) is not something the scheduler starts; an escalated run (`dispatcher.escalate`) of a slice is not its slice's run for the scheduler.

## For the scheduler phase

- Create one `createTeams({ store })` beside the store in `server.js`, call `await teams.recover()` before the first use, and nothing else needs wiring for the guard: dispatch a slice's worker with `cwd: started.worktree`. The store is the server's one coordination service's own (`_assistantCoordination.store` in `server.js`, `sharedCoordinationService().store` elsewhere; phase P2): never open a second one on the file. `service.team.members(teamId)` then reads the runs out of the journal these modules write, and `service.team.post / read / wait / ack` is the team channel (`tests/agents-integration-seams.test.mjs` runs both on one file).
- Dispatch slices with capability `workspace`. `full` is read as `workspace` for a slice, and the Protect workers setting does not apply to a team: tell the user so where the setting is shown.
- A worker of a slice cannot commit. Tell it to leave its changes in the working tree and to report; then call `finishSlice` and `integrate`.
- The refusals a worker reads say "ask over the team channel (`team:<id>`)". That channel is the scheduler's to provide (the store's events and mailbox, phase P2).
- `finishSlice` → `rejected` is the scheduler's to route: the report has the files and their owners. A worker cannot undo a stray change itself (the guard refuses writes to files it does not own). Either pass `allowStray: true` (the files stay out), or have the owning slice or the Assistant decide.
- `integrate` → `CONFLICT`: route the report; then either `resolveInSlice` (the slice's owner resolves in its own files) or an integrator worker in the integration worktree followed by `acceptIntegrationHead`.
- `land` is never called because a team became `ready`. It is the owner's step, or the Assistant's when the owner said so.
- Before `remove` or a discard, stop the team's runs.
- The default test runner is unsandboxed and the default dependency setup is none: decide both when wiring.
- One team id per store: derive it so two projects never ask for the same one.
- The MCP `git` tool's catalog line (`mcp-server/src/services/tool-catalog.ts`: `status/diff/commit/log/branches`) does not name the two new actions yet; the tool's own schema and description do.

## Confirmed cleanup after landing

Scheduler `land` retains the worktrees and branches and returns
`cleanup: { available: true, worktrees: [absolutePath], branches: [branchName], next }`.
The Assistant suggests cleanup once the task is finished and asks the owner to confirm.
`POST /api/assistant/teams/:id/cleanup` uses the land route's orchestration and session guards;
its body adds the strict boolean `user_confirmed`. No Studio cleanup route is registered.

`scheduler.cleanup(teamId, { sessionId, userConfirmed })` checks confirmation, landed status,
every historical team run (including removed runs and integrators), that every branch is merged
into the landing target, and clean, unlocked linked worktrees. Missing run evidence fails closed.

A branch is merged (`mergedInto` in `worktrees.js`) in one of two cases:
- `ancestor`: its head is an ancestor of the target.
- `patch-equivalent`: every commit it has beyond the team's base commit that the target cannot reach
  has a patch-equivalent commit the target reaches (`git cherry <target> <branch> <base>` prints no `+` line).
  This is the usual case for a slice, because `integrate` cherry-picks the slice's commits onto the
  integration branch and so only copies of them land.

Merge commits: a merge commit the target cannot reach is never patch-equivalent. It has no single patch, and
`git cherry` skips merges silently, so the check lists such commits from `git rev-list --merges <branch>
--not <target> <base>`. A slice that contains merges is joined by a merge or a fast-forward, which makes the
slice branch an ancestor of the target after the landing. Anything else is `BRANCH_NOT_MERGED`; the failing
`merged` check names the branch in `detail` and lists the commits that have no equivalent in `commits`.

All checks precede removal, under the library repository lock. Removal goes in this order:
1. Each patch-equivalent branch's worktree gets its HEAD detached at the checked commit
   (`update-ref --no-deref HEAD`; files and index are untouched).
2. One atomic `git update-ref --stdin` transaction runs: `verify` for every ancestor branch at its checked
   head, and `delete <ref> <checked head>` for every patch-equivalent branch. `git branch -d` would refuse
   these, and `-D` / `--force` is never used.
3. If the transaction fails, every detached HEAD is put back (`symbolic-ref`), nothing is removed, and
   cleanup refuses with `BRANCH_MOVED`.
4. Otherwise each worktree goes with `git worktree remove` (no force), and each ancestor branch with
   `git branch -d`. Then `git worktree prune` runs and the empty team folder is removed.

The legacy discard/removal behavior is separate from this guarded removal option.

Success is `{ ok: true, teamId, removed: [{ sliceId, path, branch }] }`, with
`confirmation: "unverified"` when no owner-turn dependency is configured. A repeated cleanup
returns `{ ok: true, teamId, alreadyClean: true, removed: [] }`. Refusals return
`{ ok: false, code, message, checks: [{ name, ok, detail }] }`; codes are
`CLEANUP_NOT_CONFIRMED`, `TEAM_NOT_LANDED`, `TEAM_RUNS_ACTIVE`, `BRANCH_NOT_MERGED`,
`WORKTREE_DIRTY`, and `BRANCH_MOVED` (a branch moved between the merged check and its deletion;
nothing removed, and a new cleanup checks it again), plus ordinary unknown-team/session errors. Successful cleanup persists
`cleanedAt` and emits `team_cleaned` (`team.cleaned`) through `assistant:team-changed`.

The optional scheduler dependency `lastOwnerTurnAt(sessionId)` must return the last trusted
UI user turn's epoch milliseconds or ISO timestamp. The runtime exposes this getter and stores
the timestamp in its session record. Add this property to `createTeamScheduler` in server.js:

```js
lastOwnerTurnAt: (sessionId) => _assistantRuntime?.lastOwnerTurnAt?.(sessionId) ?? null,
```

With that dependency present, absent, equal or earlier timestamps refuse cleanup. Without it,
confirmation timing is explicitly reported as unverified. Git failures during removal throw;
external concurrent filesystem changes cannot be made transactional across Git commands.

### A ready team merged outside `land`

Somebody may merge a ready team's integration branch into its base branch by hand, leaving its worktrees and
branches on disk. `onTarget(teamId)` (read only, no lock: a list asks it) answers `null` unless the journal says
`ready` and git says the recorded integration head, and the live integration branch, are ancestors of
`refs/heads/<baseBranch>`; then `{ branch, head, targetHead, live, moved, clean, dirty, unmerged, other }`, where
`clean` is every guarded check above passing against the base branch (`guardedChecks`, the same code the removal
runs), `dirty` the uncommitted files per worktree, `unmerged` the branches with commits the base branch lacks, and
`other` git's words for anything else. Live workers are the scheduler's to count (`liveRuns`), not the library's.

`remove(teamId, { guarded: true, mergedOutside: true })` reads the team again under the repository's lock, refuses
(`TEAM_NOT_READY`, `NOT_ON_TARGET`, then the guarded codes) with nothing changed, and otherwise journals the landing
somebody else made (`merged`, `landed.external: true`) before it removes anything, then removes exactly as a guarded
cleanup does. The scheduler's `cleanupMerged(teamId, { by: { kind: 'owner' }, userConfirmed: true })` adds the live
worker check, records the landing on the team, emits `team_cleaned` and removes the team's record. Nothing does this
at start-up: recovery closes such a team only when its integration branch and worktree are already gone.
