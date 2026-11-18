# The fields of an agent definition

Every value comes from `agent_definition` action `catalog`, never from memory or from this page. In `definition`
the fields are written as below; leave a field out to keep its default.

## Who it is

| Field | What | Limits |
|---|---|---|
| `id` | The name a dispatch uses (`agent_ref`). Lower-case letters, digits and hyphens, starting and ending with a letter or a digit. Fixed once the draft exists. | 64 characters; not a reserved word (`all`, `assistant`, `auto`, `default`, `global`, `me`, `new`, `none`, `project`, `synabun`) |
| `name` | The name people see. | 80 characters, one line |
| `description` | What it is for and when to use it, in one or two sentences. The Assistant picks agents by it. | 400 characters |
| `instructions` | The role (see instructions.md). | 16,000 characters; a warning over 6,000 |

## What it runs on

| Field | What | Default |
|---|---|---|
| `provider` | The worker runtime. Required. | none |
| `model` | A model id the catalog lists for that provider. | the provider's default |
| `effort` | An effort that model lists. | the model's default |
| `account_id` | An account of the provider, or `auto`. Only for providers the catalog shows accounts for. | the default account |

## What it may touch

| Field | What | Default |
|---|---|---|
| `capability` | `read-only`, `workspace` or `full`. | `workspace` |
| `permission_policy` | `auto`, `ask` (every permission request goes to the user) or `restricted` (a sandbox; not with `full`). | `auto` |
| `tools` | Tool group ids from the catalog. Leave out for the worker's default list; an empty list means the always-on tools only. An MCP server is never named here. | the default list |
| `mcp_servers` | Names of MCP servers from the catalog. A server a provider cannot take is left out of the run, with a correction. | none |
| `uses_browser` | The SynaBun browser. Required when `tools` names a browser group. | off |
| `uses_computer` | Computer use on the desktop. | off |
| `morelogin_profile` | A MoreLogin profile the owner lets agents choose (the catalog lists them). Needs `uses_browser`. A profile that is not allowed refuses the run. | none |
| `skills` | Names of skills (or library ids) the agent works with; they are named in its role, not installed. | none |

## Where it applies and what it is for

| Field | What | Default |
|---|---|---|
| `scope` + `project` (tool arguments, not in `definition`) | `global`: the library for every project. `project` with a registered project's path: that project only; its agent of an id wins over the global one. An agent cannot move: copy it instead. | global |
| `task_classes` | The task classes it is offered for, from the catalog. None: only when asked for by name. | none |
| `memory_category` | The memory category its findings are filed under. | none |
| `color` | A style-guide colour token `group.key` from the catalog (pass `project`). Never a raw colour. | none |
| `icon` | An icon name (lower-case letters, digits, hyphens). Never markup, a path or a URL. | none |

## What lint says

Errors stop a submission: fix every one. Warnings are for the owner to weigh; these are the ones to act on.

| Warning | What to do |
|---|---|
| `empty_instructions`, `empty_description` | Write them: an agent without them is a plain worker under another name, and it is never picked. |
| `long_instructions` | Cut (instructions.md). Move a procedure into a skill and name it in `skills`. |
| `full_capability`, `full_with_browser`, `full_with_computer` | Go down to `workspace` unless the user asked for `full` in their words; then say so in the rationale. |
| `read_only_for_code` | A read-only agent cannot edit: change the task classes, or the capability. |
| `all_tools`, `all_mcp_servers` | List the groups and servers it needs. |
| `always_on_tool` | Take it out of `tools`: every worker has it. |
| `no_task_classes` | Add the classes the job is, unless it should run only when named. |
| `unknown_task_class`, `unknown_model`, `unknown_skill`, `unknown_color_token` | Use a value the catalog lists. |
| `account_ignored`, `computer_without_class`, `restricted_with_full` | The fields contradict each other: keep the one the job needs. |
