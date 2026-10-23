# Runtime notes

Read this only when a skill is meant for a specific runtime or uses a runtime-only feature. SynaBun's `lint`
checks every target's profile; `skill` action `profiles` lists them with their sources.

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Where SynaBun installs it | `~/.claude/skills/<name>/` | `$CODEX_HOME/skills/<name>/` | its config folder's `skills/<name>/` |
| Portable keys | `name`, `description` | `name`, `description` | `name`, `description` |
| Run only when called by name | `disable-model-invocation: true` | SynaBun's export adds `agents/openai.yaml` with `allow_implicit_invocation: false` | reads Claude's key |
| Arguments | `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` (zero-based), named arguments it declares | prompt text | prompt text |
| Picks up a change | automatically | automatically for skill files | a new session or a reload |

- Keep a skill portable unless the request needs a runtime-only key. A key one runtime needs and another ignores is
  a warning in the review, never a silent rewrite: SynaBun's export changes only the copy it installs.
- Claude Code-only keys (`allowed-tools`, `hooks`, `model`, `context`, `argument-hint`, `when_to_use`, …): use one
  only when the request needs it, and say why in the release notes. `allowed-tools` pre-approves tools for the turn;
  it is not a sandbox. Hooks stay active for the session once the skill is used.
- A skill installed in the shared `~/.agents/skills` is read by Codex and OpenCode both; the owner turns that folder
  on in Settings.
