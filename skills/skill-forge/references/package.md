# A complete skill package

Read this when you draft or fix a skill's files. The format checks are SynaBun's (`skill` action `lint`); this is
what makes a package good, not only valid.

## Layout

```text
<name>/
  SKILL.md                 the entry point (always)
  references/<topic>.md    detail the body points to (only when needed; one level deep)
  scripts/<tool>.<ext>     deterministic helpers (only when needed; executable)
  evals/evals.json         test prompts for evaluation (always, for a substantive skill)
  evals/files/…            inputs a test prompt names (only when needed)
```

Nothing else: no README, CHANGELOG or LICENSE file, no hidden files, no `node_modules`, no binary files unless the
skill needs an asset.

## SKILL.md

Frontmatter, portable across Claude Code, Codex and OpenCode:

```yaml
---
name: release-notes
description: Writes release notes from the pull requests merged since the last tag, grouped by kind. Use when the user asks for release notes, a changelog section or a summary of what changed in a release.
---
```

- `name`: the folder's name. Lowercase ASCII letters, digits and single hyphens, at most 64 characters, saying what
  the skill does. Never a name SynaBun ships (`synabun`, `skill-forge`).
- `description`: third person. What it does, then when to use it ("Use when …") with the words a user would
  actually say. At most 1,024 characters (Claude Code lists a description with a budget; aim for 200-600). No angle
  brackets (Claude.ai uploads refuse them).
- `disable-model-invocation: true` only when the skill must run only when called by name.
- Leave out `allowed-tools`, `hooks`, `model` and other runtime keys unless the request needs them: a grant or a hook
  is authority the reviewer has to accept.

Body:

- The steps in order, each one an instruction ("List the merged pull requests since the last tag").
- Inputs (what the user gives, what is read) and outputs (what is written or said).
- The decisions ("If there is no tag, …").
- How to check the result before reporting it, and what to do when a step fails.
- Short examples. Generic text: what came from a source as a name, a path or an id becomes an input or a placeholder.
- At most 500 lines and about 5,000 tokens (an estimate: characters ÷ 4). Over that, move detail to `references/`.

## references/

One file per topic, one level deep (`references/<topic>.md`). Each is linked from `SKILL.md` with a relative link
and a line saying when to read it, the way skill-forge's own `SKILL.md` links this file ("the full rules:" and the
link to `references/package.md`). A reference nobody links is never read.

## scripts/

Only for steps that are deterministic and repeat: parsing, validation, formatting, a calculation. Each script:

- is self-contained, reads its arguments, prints what it did;
- names its dependencies at the top, and needs nothing installed beyond them;
- never uses the network, never installs anything, never reads secrets;
- is tested on a small made-up input, never on real data or a real account.

A skill with no deterministic step has no scripts.

## Test prompts

`evals/evals.json`, what an evaluation runs (`skill` action `eval_start`, or the owner in Skills Studio's Test tab).
A case's test files (`files`) live under `evals/files/`: one inside `.claude/`, `.opencode/`, `.agents/`, `.codex/`,
`.config/` or `.git/`, or named `.mcp.json`, `opencode.json` or `.envrc` at the top, is something a runtime would load
as its own settings or code, and the test prompts are refused until it moves.

```json
{
  "schema": "synabun-evals/1",
  "skill_name": "release-notes",
  "evals": [
    { "id": "notes-basic", "group": "notes-basic", "split": "train",
      "prompt": "Write release notes for v2.3 from the PRs merged since v2.2.",
      "expected_output": "Notes grouped by kind that name every merged PR.",
      "files": [],
      "assertions": ["Every merged PR is named", "Changes are grouped by kind"] }
  ],
  "triggers": [
    { "id": "asks-notes", "group": "asks-notes", "split": "validation", "query": "can you write up the release notes for this sprint", "should_trigger": true },
    { "id": "near-lint", "group": "near-lint", "split": "test", "query": "lint CHANGELOG.md for broken links", "should_trigger": false }
  ]
}
```

- `evals`: at least 3 task cases: realistic requests with the details a user gives, what a good answer holds, and
  checks (`assertions`) a grader can verify.
- An assertion is a sentence a grader checks, or an object `{ "text": …, "check": { "type": …, "value": … } }`
  whose `check` code decides: `contains`, `not_contains`, `regex` (no backreference, no repeat inside a repeat),
  `file_exists` and `json_valid` (with `path`, a file the run writes), `max_lines`. Prefer a check where the words
  are exact; `"kind": "preference"` marks how the user wants it done rather than what it must hold.
- `"compare": true` on a task case asks for a blind comparison of the answers with and without the skill;
  `"shell": true` says it needs a shell (it then runs only where the OS sandbox holds one).
- `triggers`: at least 3 requests that should pick the skill and 2 near-misses (the same words, another intent).
- Every `id` is unique (a lowercase slug). Never the same request twice, not even reworded slightly.
- Variants of one request share a `group`, and a group lives in ONE `split` (train, validation or test): a group in
  two splits leaks the held-out answer.
- `test` cases are held out: their text never appears in `SKILL.md` or the references.
- No token counts: a length in characters is not a number of tokens.
- Files a task case needs go under `evals/files/` and are listed in its `files`.
