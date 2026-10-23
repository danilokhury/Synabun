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

## Partial results

A creation that was cancelled, stopped at its spend ceiling, or cut short because SynaBun stopped keeps what the
worker wrote as a library draft when it is a usable folder (`create_status` names it). A draft with problems is kept, never deleted: say where it is. Report honestly what was
made, what was checked and what was not.

## Before you report

- The skill's name and ids (skill, revision, review).
- The checks: errors and warnings per runtime, the scan's status and gate, the test prompts (task, positive,
  near-miss).
- The assumptions you made and the sources you used.
- What the owner does next: review it in Skills Studio → Review, approve, then publish to the runtimes they choose.
- Never say it is installed, tested or approved unless the service says so. After a publish, `installations` says
  what is on disk: the approved bytes or not, found by each runtime or not, and what a running session needs.
