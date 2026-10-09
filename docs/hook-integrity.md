# Hook identity, state, and measurement

SynaBun has 10 executable hook scripts with 11 registrations covering nine Claude Code events. The canonical
definitions live in `lib/claude-hooks.js`. Every settings scope gets the same
handler command, matcher, and timeout. Claude Code can therefore deduplicate
the handler for each event even when both project and global hooks are installed.

The command resolves a SynaBun checkout from the current project (including
subdirectories), then falls back to the installer-managed `SYNABUN_HOOK_ROOT`.
A packaged application registers `"<entry>" claude-hook <script>` instead: its
entry executable runs the handler with the Node that came with it, and no
`SYNABUN_HOOK_ROOT` is written. Both forms are recognized by either kind of
install, so changing from one to the other leaves one handler per hook.
The tracked template contains no machine-specific root. Server startup repairs
recognized old commands in global settings and registered projects' settings
and local settings. Other handlers, including plugins, retain their own behavior.
Repairing one settings file without the other can temporarily retain duplicate
execution; no event is suppressed by a guessed identity or a marker file.

## State integrity

- `post-plan` and MCP `remember` use the same transactional writer. A plan's
  retry key includes its project, canonical source path, and content hash.
  Concurrent retries return the same UUID. An edited plan gets a new entry.
- A verified old plan receipt can acquire a retry key without copying its row.
  Stop records a retry count, never a successful receipt before storage succeeds.
- Short JSON read–modify–write operations are serialized with SQLite's writer
  lock in `data/hook-state-lock.sqlite`. JSON replacement is atomic. The
  coordination database contains no memories; process death releases its lock.
- Compaction flags carry a session ID and generation. The matching conversation
  remember must carry `source_ref: synabun-compaction:<session>:<generation>`.
  Hook instructions supply this value. Legacy generationless flags can only be
  cleared by their own session. An old completion cannot clear a new generation.

Runtime state resides under `SYNABUN_DATA_HOME` (normally `~/.synabun`). Existing
memory rows are not deleted by this repair.

## Recall admission

Hybrid `score` remains a ranking value, preserving compatibility. Retrieval also
exposes `semantic_score`, `passage_score`, `keyword_coverage`, and `fusion_score`.
An absent channel value means that channel was not measured or did not qualify;
it is not a zero or a probability.

Automatic injection requires document or passage similarity of at least 0.4.
Explicit recall can still retrieve keyword-only evidence such as error codes.
Short referential questions such as “is there a better setting for that?” do not
start another automatic search. Repeatedly supplied evidence produces no new
context. MiniLM and its existing vectors are retained.

## Reproducible accounting

From the repository root:

```sh
node scripts/audit-claude-hook-usage.mjs --since 2026-09-14T06:27:59.243Z --until 2026-09-15T06:27:59.243Z --output benchmarks/hook-repair-usage-24h.json
node scripts/audit-memory-duplicates.mjs --output benchmarks/hook-repair-duplicate-candidates.json
```

Usage records are deduplicated by API message ID. Uncached input, cache writes,
cache reads, and output remain separate. Payloads retain request provenance,
Unicode character counts, UTF-8 byte counts, image counts, and hashes. The join
to the next recorded request does not prove subsequent retention or billing.
Unknown component token counts are `null`, never character-based estimates.

The duplicate audit is read-only. Exact hashes and near-duplicate candidates
include UUIDs and metadata for review; they are not deletion instructions.

For an isolated provider measurement, supply a transcript containing an exact
duplicate SynaBun SessionStart block:

```sh
node scripts/measure-claude-hook-overhead.mjs --run --transcript /path/to/session.jsonl --output benchmarks/hook-repair-provider-measurement.json
```

This runs four short Claude requests: two reversed-order pairs with identical
system/user text and the recorded context. Only temporary fixture hooks run;
tools and MCP servers are disabled. It also checks native handler multiplicity.

The September 15, 2026 probe used `claude-sonnet-5` and a 525-character recorded
startup block. Legacy registrations ran SessionStart, UserPromptSubmit, and Stop
twice each; canonical registrations ran them once each. Both pairs measured
**940 versus 748 input tokens: 192 tokens removed per startup fixture**. This is
not an attribution of historical account-wide usage or every hook's token cost.

## Watchdogs and rollout

Both sidepanel engines use `high: 120s`, `xhigh: 300s`, `max: 300s`. Lower efforts
retain the engine's existing default. Legacy retries retain their budget across
respawns.

After changing MCP code, build with `npm run mcp:build` and restart the Neural
Interface server. A build alone leaves the running server's ESM imports cached.
