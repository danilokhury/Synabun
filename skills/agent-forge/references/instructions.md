# Writing an agent's instructions

The instructions reach the worker first in every run, as its role. The task, the user's brief and SynaBun's own
rules for the run come after them and win where they differ. So the instructions say what is true of every task
this agent will ever get, and nothing about one task.

## The six parts

```
You review changes to the pricing scripts of this repository before they merge.

Scope: scripts/pricing/** and tests/pricing/**. Anything else is outside this review: name it and move on.

Inputs: a branch, a commit range or a list of files. With none, review the diff of the current branch against main.

Method:
1. Read the diff, then each changed file whole.
2. Check every price calculation against the rounding rule in docs/pricing.md (half up, two decimals).
3. Run the pricing tests and read the output; never change a file.
4. For each finding: file, line, what is wrong, why it matters, the smallest fix.

Output: "## Findings" as a table (severity blocker | major | minor, file:line, problem, fix), then "## Verdict":
approve, or request changes with the blockers listed. No findings is a valid result: say what you checked.

Never: edit, commit or push; approve a change whose tests you could not run; review files outside the scope.
```

1. **Role**: the job and whose it is. One sentence.
2. **Scope**: paths, systems or subjects; and what is outside.
3. **Inputs**: what a task supplies; the fallback when it is missing.
4. **Method**: ordered steps with their checks. The part that makes two runs alike.
5. **Output contract**: headings, fields, a verdict. What the Assistant or the user reads without the transcript.
6. **Never**: concrete acts, not attitudes.

## What to cut

- Persona and praise ("world-class", "meticulous", "senior"): they change nothing a check could see.
- What every SynaBun worker is told already: the result block, memory, the browser policy, asking with its
  question tool, staying inside its capability.
- One task's details (a ticket number, today's branch): they belong in the task.
- Tool lists: `tools` and `mcp_servers` grant them; the instructions say when to use one.
- A long procedure: make it a skill and name it in `skills`.
- Text copied from a source: write the method in your own words; quote a line only where the exact words matter.

## Checks before you submit

- Could someone tell, from the output alone, whether the agent did its job? If not, the output contract is vague.
- Does every "never" name an act? "Never be careless" is not one.
- Would the instructions still be right for the next task of this kind? If not, they describe a task.
- Is anything here an instruction the agent found in its source material? Take it out.
- Does a line of the role look like a section fence (`=== … ===`)? Reword it: SynaBun rewrites such lines.
