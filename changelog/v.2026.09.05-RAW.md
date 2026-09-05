## FRESH CHANGELOG ##

## 2026-09-02

### Fixed — Claude Code Model Discovery Silently Served the Static Fallback List

- **An empty-string argument disappeared into the shell and took the whole model list with it** — `queryClaudeCliModels()` in `neural-interface/lib/claude-model-catalog.js` passed `'--setting-sources', ''`, but the same function falls back to `shell: true` whenever the resolved binary is a bare command name rather than a path. A shell concatenates argv instead of passing it through, so the empty string vanished, the CLI exited with `option '--setting-sources <sources>' argument missing`, and discovery reported an empty list. The flag is now written as a single `--setting-sources=` token, which survives both spawn paths.
- **The symptom was indistinguishable from an out-of-date picker** — a failed discovery falls back to `CLAUDE_FALLBACK_MODELS`, a four-entry list of unversioned aliases with no Fable entry at all. The sidepanel looked merely stale rather than broken.
- **Discovery now finds CLIs installed outside the login shell's PATH** — `getAugmentedPath()` moved from `server.js` into `neural-interface/lib/augmented-path.js` and is applied to the spawn environment of both `queryClaudeCliModels()` and `queryClaudeCliVersion()`. SynaBun is routinely launched from Finder/launchd with a minimal PATH, where a CLI in `~/.local/bin` or Homebrew was previously invisible to discovery. All eight existing `server.js` call sites are unchanged.

### Fixed — Sidepanel Offered Fable 5.1 But Sessions Ran Fable 5

- **`@anthropic-ai/claude-agent-sdk` bumped `0.3.220` → `0.3.258`** — the model picker reads the installed CLI while sidepanel chats run the CLI bundled inside the Agent SDK. Those had drifted to 2.1.220 vs 2.1.258, and the older bundle's model table contains only `claude-fable-5` with `latest_per_family:{fable:"claude-fable-5"}`. Selecting Fable 5.1 — or the `fable`/`best` aliases — silently launched Fable 5, with no symptom beyond the model naming a different version of itself. Same failure mode as the Opus 5 → Opus 4.8 bug one release earlier. The pin stays exact; the repaired guard test below is what catches the next drift.

### Fixed — The Version-Skew Guard Test Passed Vacuously

- **It probed a bare `claude` under the raw PATH, so it skipped on the machines it was written to protect** — `checkClaudeCliSkew('claude', …)` could not resolve a CLI installed in `~/.local/bin`, returned `null`, and hit the test's "nothing to compare" early return. The suite was fully green while a live 2.1.258-vs-2.1.220 skew was in effect. With the augmented PATH in place the comparison now actually runs, and the skip is narrowed: when no CLI resolves, the test asserts that none is installed rather than assuming it.

### Added — Fable 5.1 Pricing

- **`MODEL_PRICING` in `neural-interface/server.js` gains `claude-fable-5-1`: `[10, 50, 12.50, 0.25]`** — without a row, cost fell through to the `claude-sonnet-4-6` fallback and understated input/output by roughly 3.3x. The figures come from the CLI's own tier table, which tags Fable 5.1 as `tier_10_50_cache_read_0_25`: identical input/output to Fable 5 but a cheaper `cache_read` (0.25 vs 1.00), so it is deliberately not a copy of the Fable 5 row.

### Added — Model Catalog Regression Coverage

- **Bare-name discovery is now a test** — `discovery works when the binary is a bare command name, not a path` fails against the old empty-string argv, closing the gap that let a silent fallback ship.
- **Point-release labels are locked in** — `versionedLabel('Fable', 'Fable 5.1 · …')` must yield `Fable 5.1`, not `Fable 5`. The `CLI_MODELS` fixture was recaptured from CLI 2.1.258 and now carries `claude-fable-5-1[1m]`, including the assertion that a selector saved against `claude-fable-5[1m]` does not light up its successor.

