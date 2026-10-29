# Review, recovery and partial results

Read this when a step fails, when the owner asks for changes, or before you report.

## The Review queue

- `review_submit` names one immutable revision (`revisionId`). The owner sees its checks for each target runtime,
  its scan, what it can do that the approved version could not (scripts, hooks, tool grants, domains), the diff,
  your release notes and your assumptions.
- The owner approves, asks for changes (with a reason) or rejects, in Skills Studio → Review. Only the owner installs,
  and only an approved revision.
- **Changes requested**: `review_list` shows the reason. Make a new draft over the reviewed revision
  (`draft_create` with `skillId` and `baseRevisionId`), change what the reason names, `lint`, `scan`, `snapshot`,
  then `review_submit` with `previousReviewId`.
- **Withdraw** your own submission (`withdraw`) when it is no longer wanted; the owner may close any.

## When something fails

| What happened | What to do |
|---|---|
| `create` failed with `needs_input` | The worker asked a question: answer it from the conversation or memory and start again with a clearer `prompt`, or ask the user. |
| `needs_browser` | A web page needs the SynaBun browser, which could not open it. Report "needs the SynaBun browser"; never fetch it another way. |
| `budget_exceeded` | The worker reached its `budgetUsd` and was stopped; what it wrote is kept as a draft (`create_status` names it). Finish it yourself, or start again with a higher ceiling if the user agrees. |
| `provider_unsupported` | Drafting runs on Claude Code only: leave `target` out or name a Claude Code model. |
| `draft_unsafe` | The drafting folder held a link: nothing in it was used. Start again; say so if it repeats. |
| `draft_invalid` | The worker's folder failed the checks twice: read the problems, then start again with them in the `prompt`, or draft it yourself and fix them. |
| `source_failed`, `source_not_found` | A source could not be read (a session moved, a project not registered): say which, drop or replace it. |
| `too_many_creations` | Wait for a creation to finish (`create_status`) or cancel one (`create_cancel`). |
| `draft_conflict` (409) on `draft_patch` / `snapshot` | The draft changed: `read` it again and apply your change over what is there now. |
| A scan that blocks | Fix what it names (a remote installer, a decode-and-run chain, an embedded secret); a blocked revision cannot be approved. |
| Lint errors you cannot fix | Keep the draft (it is recoverable), submit nothing, and say what is wrong. |

## When an evaluation fails

| What happened | What to do |
|---|---|
| `no_suite`, `suite_invalid` | The version has no `evals/evals.json`, or it has problems (listed): fix the draft, `snapshot`, start again. |
| `runtime_unavailable`, `nothing_can_run` | No runtime here can run it (a case with `"shell": true` needs the OS sandbox): say so and leave the test gate pending. |
| `budget_below_estimate`, `time_below_estimate` | The estimate is above the ceiling: run fewer cases (`kinds`, `caseIds`) or ask the user for a higher one. |
| `no_held_out`, or a problem `test-sealed` | Held-out (test) cases run only with `purpose` "final", and "final" needs some. |
| `optimise_unavailable` | Optimising needs a positive and a near-miss trigger in train and one in validation. |
| `queue_full` | Wait for an evaluation to finish (`eval_status`) or cancel yours (`eval_cancel`). |
| `stopped` | It reached its spend or time ceiling: what it measured is kept, and `eval_report` says which cases did not run. |
| `interrupted` | SynaBun stopped while it ran: start it again. |
| Graded "not independent" | Only the author's provider could grade it: say so, the scores are weaker evidence. |

## Partial results

A creation that was cancelled, stopped at its spend ceiling, or cut short because SynaBun stopped keeps what the
worker wrote as a library draft when it is a usable folder (`create_status` names it). A draft with problems is kept, never deleted: say where it is. Report honestly what was
made, what was checked and what was not.

## Before you report

- The skill's name and ids (skill, revision, review).
- The checks: errors and warnings per runtime, the scan's status and gate, the test prompts (task, positive,
  near-miss).
- The evaluation, when one ran: its id, the pass rate with the skill and without it, the triggers picked and
  missed, the grader, the cost; or "not evaluated" and why.
- The assumptions you made and the sources you used.
- What the owner does next: review it in Skills Studio → Review, approve, then publish to the runtimes they choose.
- Never say it is installed, tested or approved unless the service says so. After a publish, `installations` says
  what is on disk: the approved bytes or not, found by each runtime or not, and what a running session needs.
