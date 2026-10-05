// ═══════════════════════════════════════════
// SynaBun — Assistant usage (exact token accounting)
// ═══════════════════════════════════════════
//
// A "task" is one human prompt in an Assistant session plus everything it
// causes: brain turns, dispatched worker runs (claude-code / codex / opencode),
// their sub-agents and helper calls. Every token of a task is counted once,
// normalized to five additive classes, and shown live.
//
// Pure module: Node built-ins only, no HTTP, no SDK. Four parts.
//
// 1. TOKENS  { input, cacheWrite, cacheRead, output, reasoning }: non-negative
//    integers that never overlap, so their sum is the total. The same meaning
//    for every provider: `input` is uncached input only, `output` is visible
//    output only. Views add the two sides people read: inputTotal (input +
//    cacheWrite + cacheRead: everything sent to the model) and outputTotal
//    (output + reasoning: everything it generated); total = inputTotal +
//    outputTotal. Normalizers turn each provider's usage into that shape:
//      claudeUsageTokens(usage)        Anthropic usage (result.usage / message.usage)
//      claudeModelUsageTokens(entry)   one SDK ModelUsage entry
//      codexUsageTokens(usage)         → { tokens, mismatch } (Codex input includes cached, output includes reasoning)
//      openCodeTokens(tokens)          already five classes
//
// 2. METERS  one per provider session. Each keeps a small JSON-safe state()
//    the caller persists and hands back as { state }.
//      createClaudeMeter    onEvent(sdkMessage) → { settled, pendingChanged }. A `result` settles the
//                           per-model DELTA of the cumulative result.modelUsage (main loop, Task
//                           sub-agents, sidechains, compaction, helper models). settled.rows is ready
//                           for ledger.settle(). pending() is the live estimate between results.
//      createCodexMeter     poll() → the NEW usage since the last poll, read from the thread's rollout
//                           files (root + sub-agent threads), one row per thread and turn.
//                           poll({ discover: true }) discovers new files immediately at turn end.
//      createOpenCodeMeter  onEvent(type, event) → true when totals changed; total(), markTurn(),
//                           reconcile(). Counts every session of the run's own `opencode serve`.
//
// 3. LEDGER  createUsageLedger({ dataDir }): one append-only file per assistant
//    session, <dataDir>/assistant-usage/<sessionId>.jsonl, plus in-memory
//    provisional ("pending") tokens for turns still running. Failed appends stay
//    queued until the next append or flush(). Dropped sessions ignore late writes
//    until beginTask() reopens them. taskView() is what the panel gauge renders:
//    its `session` block (every task of the session added up, read back from the
//    file after a restart) is the headline, its `task` the current task's detail.
//
// 4. HOW A CALLER WIRES IT (the contract the dispatcher, runtime, API and UI code against)
//      human prompt            ledger.beginTask(sessionId, { title })           → { id, n }
//      run dispatched          remember the task id on the run; pass it as taskId on every settle
//      Claude SDK message      const { settled, pendingChanged } = meter.onEvent(message)
//                              settled        → for (const row of settled.rows) ledger.settle({ ...ids, ...row,
//                                               fidelity: settled.fidelity, reason: settled.reason, source: settled.source })
//                              pendingChanged → ledger.setPending(sessionId, agentKey, { ...ids, tokens: meter.pending().tokens })
//      Codex turn end / tick   for (const row of meter.poll()) ledger.settle({ ...ids, part: row.part, tokens: row.tokens,
//                                               model: row.model || runModel, fidelity: row.fidelity, reason: row.reason, source: row.source })
//                              (price row.usage, the raw provider keys, with assistant-budget's codexUsageCostUsd)
//      OpenCode event          if (meter.onEvent(type, event)) ledger.setPending(…, { tokens: live delta since the last mark })
//      OpenCode turn end       await meter.reconcile(fetchers); const d = meter.markTurn(); settle d.main as part 'main'
//                              and d.subagents as part 'subagents'
//    agentKey is 'brain' for the brain and the runId for a run. settle() clears
//    that agent's pending (its provisional tokens are booked now), except for
//    part 'aux'. Persist meter.state() with the run / session and pass it back
//    after a restart, otherwise a Claude meter cannot difference its first result.
//
// Why modelUsage and not result.usage (SDK 0.3.288): result.usage is the main
// agent loop only, per turn; result.modelUsage is cumulative for the query()
// call and covers everything. Measured on a 17-result brain session: 151.3M
// tokens by modelUsage deltas against 58.3M by result.usage.
// Why Codex rollout records and not turn.completed.usage: the latter is
// cumulative for a resumed thread (second turns were booked twice), and the
// per-response `token_usage_record` lines also include the compaction call.

import nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Part 1: tokens ───────────────────────────────────────────────────────────

/** The five additive token classes, in the order ledger rows store them. */
export const TOKEN_KEYS = Object.freeze(['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning']);

/** A non-negative integer, 0 for anything else. */
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** A non-negative finite USD amount, 0 for anything else. */
function usd(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const roundUsd = (value) => Number(usd(value).toFixed(8));

export function zeroTokens() {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
}

/** Any token-ish value (object, ledger row array, null) as a clean five-class object. */
export function cleanTokens(value) {
  if (Array.isArray(value)) return rowToTokens(value);
  const t = value && typeof value === 'object' ? value : {};
  return { input: count(t.input), cacheWrite: count(t.cacheWrite), cacheRead: count(t.cacheRead), output: count(t.output), reasoning: count(t.reasoning) };
}

export function addTokens(a, b) {
  const x = cleanTokens(a);
  const y = cleanTokens(b);
  for (const key of TOKEN_KEYS) x[key] += y[key];
  return x;
}

/** a - b, each class clamped at 0. */
export function subTokens(a, b) {
  const x = cleanTokens(a);
  const y = cleanTokens(b);
  for (const key of TOKEN_KEYS) x[key] = Math.max(0, x[key] - y[key]);
  return x;
}

/** The per-class maximum of a and b (snapshots of one growing message). */
export function maxTokens(a, b) {
  const x = cleanTokens(a);
  const y = cleanTokens(b);
  for (const key of TOKEN_KEYS) x[key] = Math.max(x[key], y[key]);
  return x;
}

export function totalTokens(tokens) {
  const t = cleanTokens(tokens);
  return t.input + t.cacheWrite + t.cacheRead + t.output + t.reasoning;
}

/** The five classes plus `total` and its two sides: inputTotal (input + cacheWrite + cacheRead) and outputTotal (output + reasoning). */
export function withTotal(tokens) {
  const t = cleanTokens(tokens);
  const inputTotal = t.input + t.cacheWrite + t.cacheRead;
  const outputTotal = t.output + t.reasoning;
  return { ...t, total: inputTotal + outputTotal, inputTotal, outputTotal };
}

/** Tokens as the ledger's array: [input, cacheWrite, cacheRead, output, reasoning]. */
export function tokensToRow(tokens) {
  const t = cleanTokens(tokens);
  return TOKEN_KEYS.map((key) => t[key]);
}

export function rowToTokens(row) {
  const list = Array.isArray(row) ? row : [];
  return { input: count(list[0]), cacheWrite: count(list[1]), cacheRead: count(list[2]), output: count(list[3]), reasoning: count(list[4]) };
}

const sameTokens = (a, b) => TOKEN_KEYS.every((key) => a[key] === b[key]);

/**
 * Anthropic usage (result.usage or message.usage). Thinking tokens are inside
 * output_tokens, so they are split out. Every other key (iterations,
 * server_tool_use, the cache_creation split, fallback credits) is ignored.
 */
export function claudeUsageTokens(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const out = count(u.output_tokens);
  const reasoning = Math.min(out, count(u.output_tokens_details?.thinking_tokens));
  return { input: count(u.input_tokens), cacheWrite: count(u.cache_creation_input_tokens), cacheRead: count(u.cache_read_input_tokens), output: out - reasoning, reasoning };
}

/** One SDK ModelUsage entry ({ inputTokens, outputTokens, thinkingTokens?, cacheReadInputTokens, cacheCreationInputTokens }); thinkingTokens is already inside outputTokens. */
export function claudeModelUsageTokens(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const out = count(e.outputTokens);
  const reasoning = Math.min(out, count(e.thinkingTokens));
  return { input: count(e.inputTokens), cacheWrite: count(e.cacheCreationInputTokens), cacheRead: count(e.cacheReadInputTokens), output: out - reasoning, reasoning };
}

/** The provider keys a Codex usage object carries, in snake_case. */
export const CODEX_USAGE_KEYS = Object.freeze(['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']);
const CODEX_CAMEL = Object.freeze({ input_tokens: 'inputTokens', cached_input_tokens: 'cachedInputTokens', cache_write_input_tokens: 'cacheWriteInputTokens', output_tokens: 'outputTokens', reasoning_output_tokens: 'reasoningOutputTokens', total_tokens: 'totalTokens' });

/** Codex usage in snake_case whatever spelling it came in; total_tokens is null when the provider sent none. */
function codexRawUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const raw = {};
  for (const key of CODEX_USAGE_KEYS) raw[key] = count(u[key] ?? u[CODEX_CAMEL[key]]);
  const total = u.total_tokens ?? u.totalTokens;
  raw.total_tokens = Number.isFinite(Number(total)) && total !== null && total !== '' ? count(total) : null;
  return raw;
}

/**
 * Codex usage, snake_case or camelCase. Codex input INCLUDES the cached and
 * cache-write tokens and output INCLUDES reasoning (total = input + output), so
 * both are taken apart. `mismatch` is true when the provider's own total is
 * present and differs from the five classes' sum.
 * @returns {{ tokens: object, mismatch: boolean }}
 */
export function codexUsageTokens(usage) {
  const raw = codexRawUsage(usage);
  const tokens = {
    input: Math.max(0, raw.input_tokens - raw.cached_input_tokens - raw.cache_write_input_tokens),
    cacheWrite: raw.cache_write_input_tokens,
    cacheRead: raw.cached_input_tokens,
    output: Math.max(0, raw.output_tokens - raw.reasoning_output_tokens),
    reasoning: raw.reasoning_output_tokens,
  };
  return { tokens, mismatch: raw.total_tokens !== null && raw.total_tokens !== totalTokens(tokens) };
}

/** OpenCode message tokens ({ input, output, reasoning, cache:{ read, write } }): already five additive classes. */
export function openCodeTokens(tokens) {
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  return { input: count(t.input), cacheWrite: count(t.cache?.write), cacheRead: count(t.cache?.read), output: count(t.output), reasoning: count(t.reasoning) };
}

// ── Part 2A: Claude meter ────────────────────────────────────────────────────

/** Counters that only grow inside one query(); a lower value means the counter restarted. thinkingTokens is left out: a resumed session may record it only partly. */
const CLAUDE_COUNTERS = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']);
const CLAUDE_RESULT_MEMORY = 20;
/** `source` of a row counted from the stream because no result will count it (see createClaudeMeter). */
export const CLAUDE_ESTIMATE_SOURCE = 'claude-stream-estimate';

/** "claude-opus-5-5[1m]" → "claude-opus-5-5": modelUsage keys carry a variant suffix that message.model does not. */
export function baseModel(model) {
  return String(model || '').replace(/\[[^\]]*\]$/, '').trim();
}

/** result.modelUsage as { [model]: counters }, or null when it is missing or empty. */
function readModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  const out = {};
  for (const [model, entry] of Object.entries(modelUsage)) {
    if (!entry || typeof entry !== 'object') continue;
    out[model] = {
      inputTokens: count(entry.inputTokens),
      outputTokens: count(entry.outputTokens),
      thinkingTokens: count(entry.thinkingTokens),
      cacheReadInputTokens: count(entry.cacheReadInputTokens),
      cacheCreationInputTokens: count(entry.cacheCreationInputTokens),
      costUSD: usd(entry.costUSD),
    };
  }
  return Object.keys(out).length ? out : null;
}

const modelUsageIsZero = (current) => Object.values(current).every((c) => CLAUDE_COUNTERS.every((key) => c[key] === 0) && c.costUSD === 0);

/** The model that spent the most tokens in a { [model]: counters } map, or null. */
function topModel(current) {
  let best = null;
  let bestTotal = -1;
  for (const [model, counters] of Object.entries(current || {})) {
    const total = totalTokens(claudeModelUsageTokens(counters));
    if (total > bestTotal) { best = model; bestTotal = total; }
  }
  return best;
}

/**
 * What ran outside the main loop: tokens minus main. Output and reasoning are
 * differenced together first, so a turn whose two sources split thinking
 * differently still gives total(tokens) - total(main).
 */
function outsideMain(tokens, main) {
  const out = Math.max(0, tokens.output + tokens.reasoning - main.output - main.reasoning);
  const reasoning = Math.min(out, Math.max(0, tokens.reasoning - main.reasoning));
  return {
    input: Math.max(0, tokens.input - main.input),
    cacheWrite: Math.max(0, tokens.cacheWrite - main.cacheWrite),
    cacheRead: Math.max(0, tokens.cacheRead - main.cacheRead),
    output: out - reasoning,
    reasoning,
  };
}

/**
 * Meter for ONE Claude provider session. Feed every Claude Agent SDK message
 * in order with onEvent(message).
 *
 * onEvent → { settled, pendingChanged }
 *   settled is null except on a `result` that settles a turn:
 *   { byModel:[{ model, tokens, costUsd }], tokens, main, subagents, costUsd,
 *     fidelity:'exact'|'partial', reason, source, resultUuid, sessionId, rows }
 *     tokens     everything the turn spent (the per-model delta of result.modelUsage)
 *     main       claudeUsageTokens(result.usage): the main agent loop
 *     subagents  tokens - main: Task sub-agents, sidechains, compaction, helper models
 *     costUsd    sum of the models' costUSD deltas (null when it cannot be differenced)
 *     rows       [{ model, part:'main'|'subagents'|'aux', tokens, costUsd }] summing exactly to
 *                `tokens`, ready for ledger.settle(). A model's cost rides on its first row (null
 *                on the other). 'aux' is a model that produced no assistant message in this
 *                turn (a helper call such as a title or summary).
 *   fidelity 'partial' reasons:
 *     'no-baseline'       the session had earlier turns and no snapshot: only `main` is known
 *     'no-model-usage'    a result without modelUsage (old CLI): only `main` is known
 *     'counter-mismatch'  the main loop reported more than the delta, so the counter restarted
 *                         unseen; the turn is raised to at least `main`
 *   A duplicate result (same uuid as one of the last 20) and an error result
 *   whose modelUsage is missing or all zero settle nothing and leave the snapshot alone.
 *   pendingChanged is true when pending() changed (a result clears it).
 *   A failed result (the turn was interrupted) can leave a main-loop call out of its
 *   totals: the call was cut off mid-answer, the CLI never counts it, the provider billed
 *   it. Such calls are added to `rows` as estimates, each with its own { fidelity:'partial',
 *   reason:'interrupted', source:'claude-stream-estimate', costUsd:null }, and summed in
 *   `estimated`. Exact rows carry no such fields: the settled turn's own apply to them.
 *
 * settlePending({ reason }) → rows of the same estimate shape for everything pending
 *   (reason 'no-result' by default), for when no result will come at all: the turn was
 *   aborted, the process is going. What they count is taken off the next result's delta
 *   should one arrive after all, so a call the CLI did count is never booked twice.
 *
 * pending() → { tokens, byModel:[{ model, tokens }] }: the live estimate since
 *   the last result, from `assistant` messages (sub-agent calls included) and
 *   `stream_event` message_start / message_delta. Never settle it. A background
 *   sub-agent can still report after a result; that is settled by the NEXT
 *   result, so when no further turn will come call clearPending().
 * expectHistory()  the session has earlier turns this meter never saw.
 * reset()          the caller started a fresh, non-resumed process: forget the snapshot.
 * state()          { snapshot, unbaselined, results, history, sessionId } (JSON-safe).
 */
export function createClaudeMeter({ state } = {}) {
  let snapshot = readModelUsage(state?.snapshot);
  let results = Array.isArray(state?.results) ? state.results.filter((id) => typeof id === 'string').slice(-CLAUDE_RESULT_MEMORY) : [];
  let history = state?.history === true;
  let sessionId = typeof state?.sessionId === 'string' ? state.sessionId : null;
  let unbaselined = cleanTokens(state?.unbaselined);

  // Live estimate: message id → the highest counters seen for that API call.
  const calls = new Map();
  const openCall = new Map(); // parent_tool_use_id ('' for main) → message ids awaiting message_stop
  let pendingTokens = zeroTokens();
  let mainModel = null; // model of the main loop's last assistant message
  let subModels = new Set(); // models seen under a parent_tool_use_id since the last result

  const callTokens = (call) => {
    const reasoning = Math.min(call.out, call.thinking);
    return { input: call.input, cacheWrite: call.cacheWrite, cacheRead: call.cacheRead, output: call.out - reasoning, reasoning };
  };

  /** Raise one API call's counters to what this usage object says; true when the estimate grew. */
  function noteCall(id, model, usage, main = true) {
    if (!id || !usage || typeof usage !== 'object') return false;
    const call = calls.get(id) || { model: null, main, input: 0, cacheWrite: 0, cacheRead: 0, out: 0, thinking: 0 };
    const before = callTokens(call);
    if (!call.model && model) call.model = String(model);
    call.input = Math.max(call.input, count(usage.input_tokens));
    call.cacheWrite = Math.max(call.cacheWrite, count(usage.cache_creation_input_tokens));
    call.cacheRead = Math.max(call.cacheRead, count(usage.cache_read_input_tokens));
    call.out = Math.max(call.out, count(usage.output_tokens));
    call.thinking = Math.max(call.thinking, count(usage.output_tokens_details?.thinking_tokens));
    calls.set(id, call);
    const after = callTokens(call);
    if (sameTokens(before, after)) return false;
    pendingTokens = addTokens(subTokens(pendingTokens, before), after);
    return true;
  }

  function clearPending() {
    const had = calls.size > 0 && totalTokens(pendingTokens) > 0;
    calls.clear();
    openCall.clear();
    pendingTokens = zeroTokens();
    return had;
  }

  function pending() {
    const byModel = new Map();
    for (const call of calls.values()) {
      const model = call.model || 'unknown';
      byModel.set(model, addTokens(byModel.get(model), callTokens(call)));
    }
    return {
      tokens: { ...pendingTokens },
      byModel: [...byModel].filter(([, tokens]) => totalTokens(tokens) > 0).map(([model, tokens]) => ({ model, tokens })),
    };
  }

  function onAssistant(message) {
    const inner = message.message;
    if (!inner || typeof inner !== 'object') return false;
    const model = inner.model && inner.model !== '<synthetic>' ? String(inner.model) : null;
    if (model) {
      if (message.parent_tool_use_id) subModels.add(baseModel(model));
      else mainModel = baseModel(model);
    }
    return noteCall(inner.id, model, inner.usage, !message.parent_tool_use_id);
  }

  function onStreamEvent(message) {
    const event = message.event;
    if (!event || typeof event !== 'object') return false;
    const parent = message.parent_tool_use_id || '';
    if (event.type === 'message_start' && event.message?.id) {
      // A new start can arrive before the old message stops. Its deltas wait their turn.
      const queue = openCall.get(parent) || [];
      queue.push(event.message.id);
      openCall.set(parent, queue);
      return noteCall(event.message.id, event.message.model, event.message.usage, !parent);
    }
    // output_tokens here is cumulative for the message open under this parent.
    if (event.type === 'message_delta') return noteCall(openCall.get(parent)?.[0], null, event.usage, !parent);
    if (event.type === 'message_stop') {
      const queue = openCall.get(parent);
      queue?.shift();
      if (!queue?.length) openCall.delete(parent);
    }
    return false;
  }

  /** Split a settled turn into ledger rows that sum exactly to its tokens. */
  function splitRows(byModel, subagents) {
    if (!byModel.length) return [];
    const wanted = byModel.find((entry) => mainModel && baseModel(entry.model) === mainModel);
    const mainEntry = wanted || byModel.reduce((best, entry) => (totalTokens(entry.tokens) > totalTokens(best.tokens) ? entry : best), byModel[0]);
    const others = [];
    let rest = cleanTokens(subagents);
    for (const entry of byModel) {
      if (entry === mainEntry) continue;
      others.push({ model: entry.model, part: subModels.has(baseModel(entry.model)) ? 'subagents' : 'aux', tokens: entry.tokens, costUsd: entry.costUsd });
      rest = subTokens(rest, entry.tokens);
    }
    // What is left of the outside-the-main-loop tokens ran on the main model (sub-agents on the same model).
    const share = zeroTokens();
    for (const key of TOKEN_KEYS) share[key] = Math.min(rest[key], mainEntry.tokens[key]);
    const rows = [{ model: mainEntry.model, part: 'main', tokens: subTokens(mainEntry.tokens, share), costUsd: mainEntry.costUsd }];
    if (totalTokens(share) > 0) rows.push({ model: mainEntry.model, part: 'subagents', tokens: share, costUsd: null });
    return [...rows, ...others].filter((row) => totalTokens(row.tokens) > 0 || row.costUsd > 0);
  }

  const remember = (uuid) => { if (uuid) results = [...results, uuid].slice(-CLAUDE_RESULT_MEMORY); };

  /** A stream model name as result.modelUsage spells it ("claude-opus-5-5" → "claude-opus-5-5[1m]"), so its rows join that model's. */
  const usageModelName = (model) => Object.keys(snapshot || {}).find((key) => baseModel(key) === baseModel(model)) || String(model || 'unknown');

  /** The pending calls `only` keeps, as estimate rows: one per model and part. */
  function estimateRows(reason, only = () => true) {
    const groups = new Map();
    for (const call of calls.values()) {
      if (!only(call)) continue;
      const model = usageModelName(call.model);
      const part = call.main ? 'main' : 'subagents';
      const key = part + '\n' + model;
      const group = groups.get(key) || { model, part, tokens: zeroTokens(), costUsd: null, fidelity: 'partial', reason, source: CLAUDE_ESTIMATE_SOURCE };
      group.tokens = addTokens(group.tokens, callTokens(call));
      groups.set(key, group);
    }
    return [...groups.values()].filter((row) => totalTokens(row.tokens) > 0);
  }

  /**
   * Main-loop calls the stream showed and a failed result does not count: the turn was cut off
   * while they ran. The CLI leaves them out of its totals for good; the provider billed them.
   * Sub-agent calls are not judged here: a background one can still finish and be counted.
   */
  function lostCalls(byModel) {
    const rows = [];
    for (const row of estimateRows('interrupted', (call) => call.main)) {
      const counted = byModel.filter((entry) => baseModel(entry.model) === baseModel(row.model)).reduce((sum, entry) => addTokens(sum, entry.tokens), zeroTokens());
      const missing = outsideMain(row.tokens, counted);
      if (totalTokens(missing) > 0) rows.push({ ...row, tokens: missing });
    }
    return rows;
  }

  function mainOnly({ current, main, uuid, reason }) {
    const model = topModel(current) || (mainModel || 'unknown');
    return {
      byModel: [{ model, tokens: main, costUsd: null }],
      tokens: main, main, subagents: zeroTokens(), costUsd: null,
      fidelity: 'partial', reason, source: 'claude-result-usage', resultUuid: uuid, sessionId,
      rows: totalTokens(main) > 0 ? [{ model, part: 'main', tokens: main, costUsd: null }] : [],
      estimated: zeroTokens(),
    };
  }

  function onResult(message) {
    const uuid = typeof message.uuid === 'string' && message.uuid ? message.uuid : null;
    if (uuid && results.includes(uuid)) return null;
    const current = readModelUsage(message.modelUsage);
    const failed = message.is_error === true || String(message.subtype || '').startsWith('error');
    // A crash or startup-error result carries zeroed counters: it says nothing about the session's totals.
    if (failed && (!current || modelUsageIsZero(current))) return null;
    const main = claudeUsageTokens(message.usage);
    remember(uuid);
    if (!current) {
      unbaselined = addTokens(unbaselined, main);
      return mainOnly({ current: null, main, uuid, reason: 'no-model-usage' });
    }
    if (!snapshot && history) {
      snapshot = current;
      unbaselined = zeroTokens();
      return mainOnly({ current, main, uuid, reason: 'no-baseline' });
    }

    const previous = snapshot || {};
    // CLI process counters reset together, including models absent from this result.
    const restarted = Object.entries(current).some(([model, now]) => previous[model] && CLAUDE_COUNTERS.some((key) => now[key] < previous[model][key]));
    let byModel = [];
    for (const [model, now] of Object.entries(current)) {
      const before = previous[model];
      let delta = now;
      if (!restarted && before) {
        delta = { costUSD: Math.max(0, now.costUSD - before.costUSD), thinkingTokens: Math.max(0, now.thinkingTokens - before.thinkingTokens) };
        for (const key of CLAUDE_COUNTERS) delta[key] = now[key] - before[key];
        if (now.thinkingTokens < before.thinkingTokens) {
          // Thinking is inside output; use this turn's count when that counter reset alone.
          delta.thinkingTokens = Math.min(delta.outputTokens, count(message.usage?.output_tokens_details?.thinking_tokens));
        }
      }
      const tokens = claudeModelUsageTokens(delta);
      if (totalTokens(tokens) > 0 || delta.costUSD > 0) byModel.push({ model, tokens, costUsd: roundUsd(delta.costUSD) });
    }
    // After a restart the old counters of models that did not come back are gone too.
    snapshot = restarted ? current : { ...previous, ...current };
    let tokens = byModel.reduce((sum, entry) => addTokens(sum, entry.tokens), zeroTokens());
    let fidelity = 'exact';
    let reason = null;
    // Checked on the delta as the CLI reported it, before anything already booked is taken off it.
    const short = outsideMain(main, tokens);
    if (totalTokens(short) > 0) {
      // The main loop alone reported more than every model together: the counter restarted without
      // dropping below the snapshot. Count at least the main loop and flag the turn.
      const model = topModel(current) || 'unknown';
      const entry = byModel.find((item) => item.model === model);
      if (entry) entry.tokens = addTokens(entry.tokens, short);
      else byModel = [...byModel, { model, tokens: short, costUsd: 0 }];
      tokens = addTokens(tokens, short);
      fidelity = 'partial';
      reason = 'counter-mismatch';
    }
    // What was already booked and is contained in this cumulative delta is removed once, class by
    // class: a prior result without modelUsage (booked from result.usage), or calls booked as an
    // estimate when no result was expected (settlePending) that this late result counts after all.
    if (!restarted && totalTokens(unbaselined)) {
      let remaining = unbaselined;
      const preferred = mainModel || baseModel(topModel(current));
      for (const entry of [...byModel].sort((a, b) => Number(baseModel(b.model) === preferred) - Number(baseModel(a.model) === preferred))) {
        const deducted = zeroTokens();
        for (const key of TOKEN_KEYS) deducted[key] = Math.min(entry.tokens[key], remaining[key]);
        entry.tokens = subTokens(entry.tokens, deducted);
        remaining = subTokens(remaining, deducted);
      }
      tokens = byModel.reduce((sum, entry) => addTokens(sum, entry.tokens), zeroTokens());
    }
    unbaselined = zeroTokens();

    const subagents = outsideMain(tokens, main);
    const lost = failed ? lostCalls(byModel) : [];
    return {
      byModel, tokens, main, subagents,
      costUsd: roundUsd(byModel.reduce((sum, entry) => sum + entry.costUsd, 0)),
      fidelity, reason, source: 'claude-model-usage', resultUuid: uuid, sessionId,
      rows: [...splitRows(byModel, subagents), ...lost],
      estimated: lost.reduce((sum, row) => addTokens(sum, row.tokens), zeroTokens()),
    };
  }

  function onEvent(message) {
    if (!message || typeof message !== 'object') return { settled: null, pendingChanged: false };
    if (typeof message.session_id === 'string' && message.session_id) sessionId = message.session_id;
    if (message.type === 'assistant') return { settled: null, pendingChanged: onAssistant(message) };
    if (message.type === 'stream_event') return { settled: null, pendingChanged: onStreamEvent(message) };
    if (message.type !== 'result') return { settled: null, pendingChanged: false };
    const settled = onResult(message);
    if (!settled) return { settled: null, pendingChanged: false };
    const pendingChanged = clearPending();
    subModels = new Set();
    return { settled, pendingChanged };
  }

  return {
    onEvent,
    pending,
    /** Drop the live estimate (a later result settles those calls); true when it was not empty. */
    clearPending,
    settlePending({ reason = 'no-result' } = {}) {
      const rows = estimateRows(reason);
      if (rows.length) unbaselined = addTokens(unbaselined, pendingTokens);
      clearPending();
      return rows;
    },
    expectHistory() { history = true; },
    reset() { snapshot = null; unbaselined = zeroTokens(); history = false; clearPending(); },
    state: () => ({ snapshot: snapshot ? JSON.parse(JSON.stringify(snapshot)) : null, unbaselined: { ...unbaselined }, results: [...results], history, sessionId }),
  };
}

// ── Part 2B: Codex meter ─────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const CODEX_SEEN_MAX = 64;
const DISCOVER_EVERY_MS = 15_000;
const READ_CHUNK = 1024 * 1024;
const FIRST_LINE_MAX = 1024 * 1024;
const NEWLINE = 10;
/** A line longer than this is only parsed when its head names a type the meter reads. */
const SHORT_LINE = 16 * 1024;
const HEAD_TYPE = /"type"\s*:\s*"(token_usage_record|event_msg|turn_context)"/;

/** Where the Codex CLI keeps its sessions: $CODEX_HOME, else ~/.codex. */
export function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

/** Rollout folders are named by LOCAL date: YYYY/MM/DD. */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function zeroCodexUsage() {
  const usage = {};
  for (const key of CODEX_USAGE_KEYS) usage[key] = 0;
  return usage;
}

/** Cheap test before JSON.parse: rollouts hold huge tool-output lines the meter never needs. */
function meterReadsLine(line) {
  if (line.length <= SHORT_LINE) return line.includes('"token_usage_record"') || line.includes('"token_count"') || line.includes('"turn_context"');
  const head = HEAD_TYPE.exec(line.slice(0, 512));
  return !!head && (head[1] !== 'event_msg' || line.includes('"token_count"'));
}

/**
 * Meter for ONE Codex thread and its sub-agent threads, read from the rollout
 * files <codexHome>/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl.
 *
 * poll({ discover }?) → the NEW usage since the previous poll (synchronous; [] when nothing is new):
 *   [{ threadId, part:'main'|'subagents', turnId, model, tokens, usage, responses, mismatches,
 *      fidelity, reason, source }], one row per thread, turn and source.
 *     tokens      five classes (codexUsageTokens of every counted response, summed)
 *     usage       the raw provider keys summed (input_tokens includes cached), for list pricing
 *     model       the thread's model from its last `turn_context` line, or null
 *     responses   model responses counted (the compaction call is one of them)
 *     mismatches  responses whose own total_tokens differed from their classes' sum
 *   Normal case (codex-cli ≥ 0.153): one `token_usage_record` line per model response; fidelity
 *   'exact', source 'codex-records'. A record counts iff its payload.thread_id is the file's own
 *   thread (an old CLI replays the parent's history inside a forked child), its timestamp is
 *   >= sinceMs, and lies above that file's timestamp/response-id high-water mark.
 *   Older CLI (a rollout with no such line): each `token_count` event's info.last_token_usage,
 *   fidelity 'partial', reason 'codex-no-records', source 'codex-token-count'. Codex repeats that
 *   event, so one whose running total did not move is skipped.
 *   Sub-agent threads are separate rollout files whose first line is a session_meta with
 *   payload.session_id === threadId and another id; they are looked for in the day folders from
 *   sinceMs to now (local dates, one day of slack). The root is also looked for by name in older
 *   folders, since a thread that began before sinceMs keeps appending to its first file.
 *   With `longPromptTokens` (a size, or model → size) a response whose prompt (input_tokens) is
 *   over that size goes to a row of its own with long:true, the others to long:false: OpenAI
 *   prices such a request at its long-context rates, whole. Without it (or for a model with no
 *   such size) rows carry no `long`.
 *   A missing rollout gives [] and is looked for again on the next poll.
 *   Tracked files are tailed on every poll. New-file discovery runs every 15 s after the root
 *   is found, or immediately with poll({ discover: true }) (useful when a turn closes).
 *
 * state() → { files:{ [path]:{ offset, inode, threadId, records, tc, model, turn, mark } }, seen:[responseId…] }
 *   (records = the file has token_usage_record lines, tc = the last token_count running total).
 * rollouts() → [{ path, threadId, part }] found so far.
 *
 * @param {object} options
 * @param {string} [options.codexHome] defaults to $CODEX_HOME, else ~/.codex
 * @param {string} options.threadId the root thread (the run's providerThreadId)
 * @param {number} [options.sinceMs] ignore usage older than this (0 = count the whole thread)
 * @param {number|((model: string|null) => number)} [options.longPromptTokens] split rows at this prompt size (0 = no split)
 * @param {object} [options.state] a previous state()
 * @param {object} [options.fs] node:fs-like (readdirSync, statSync, openSync, readSync, closeSync)
 * @param {() => number} [options.now]
 */
export function createCodexMeter({ codexHome = defaultCodexHome(), threadId, sinceMs = 0, longPromptTokens = 0, state, fs = nodeFs, now = Date.now } = {}) {
  const root = String(threadId || '');
  const since = Number(sinceMs) > 0 ? Number(sinceMs) : 0;
  const longSizeOf = (model) => {
    let size = 0;
    try { size = Number(typeof longPromptTokens === 'function' ? longPromptTokens(model) : longPromptTokens); } catch { size = 0; }
    return size > 0 ? size : 0;
  };
  const files = new Map(); // path → offset, identity, thread, fallback total and response high-water mark
  const notOurs = new Set(); // rollouts of other threads (memory only)
  let seenList = Array.isArray(state?.seen) ? state.seen.filter((id) => typeof id === 'string').slice(-CODEX_SEEN_MAX) : [];
  const seen = new Set(seenList);
  for (const [path, file] of Object.entries(state?.files && typeof state.files === 'object' ? state.files : {})) {
    if (!file || typeof file.threadId !== 'string') continue;
    files.set(path, {
      offset: count(file.offset), threadId: file.threadId, records: file.records === true,
      tc: Number.isFinite(file.tc) ? file.tc : null, model: file.model || null, turn: file.turn || null,
      inode: file.inode ?? null, mark: { at: String(file.mark?.at || ''), ids: Array.isArray(file.mark?.ids) ? file.mark.ids.filter((id) => typeof id === 'string') : [] },
    });
  }

  const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

  /** The day folders from `fromMs` to now (one day of slack on both ends); every folder when fromMs is 0. */
  function dayDirs(fromMs) {
    const lo = fromMs ? localDay(fromMs - DAY_MS) : '0000/00/00';
    const hi = localDay(now() + DAY_MS);
    const base = join(codexHome, 'sessions');
    const out = [];
    for (const year of list(base)) {
      if (!/^\d{4}$/.test(year) || year < lo.slice(0, 4) || year > hi.slice(0, 4)) continue;
      for (const month of list(join(base, year))) {
        const ym = `${year}/${month}`;
        if (!/^\d{2}$/.test(month) || ym < lo.slice(0, 7) || ym > hi.slice(0, 7)) continue;
        for (const day of list(join(base, year, month))) {
          const ymd = `${ym}/${day}`;
          if (/^\d{2}$/.test(day) && ymd >= lo && ymd <= hi) out.push(join(base, year, month, day));
        }
      }
    }
    return out.sort();
  }

  /** The file's first complete line, null while it has none yet, '' when it is too long to be a session_meta. */
  function firstLine(path) {
    let fd;
    try { fd = fs.openSync(path, 'r'); } catch { return null; }
    try {
      const parts = [];
      let position = 0;
      while (position < FIRST_LINE_MAX) {
        const chunk = Buffer.alloc(64 * 1024);
        const read = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (read <= 0) return null;
        const end = chunk.subarray(0, read).indexOf(NEWLINE);
        if (end !== -1) { parts.push(chunk.subarray(0, end)); return Buffer.concat(parts).toString('utf8'); }
        parts.push(chunk.subarray(0, read));
        position += read;
      }
      return '';
    } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }

  /** The sub-agent thread id when this rollout belongs to the root thread's family, false when not, null when not known yet. */
  function childThread(path) {
    const line = firstLine(path);
    if (line === null) return null;
    let entry = null;
    try { entry = JSON.parse(line); } catch { return false; }
    const payload = entry?.type === 'session_meta' ? entry.payload : null;
    if (!payload || payload.session_id !== root || typeof payload.id !== 'string' || payload.id === root) return false;
    return payload.id;
  }

  const track = (path, thread) => files.set(path, { offset: 0, inode: null, threadId: thread, records: false, tc: null, model: null, turn: null, mark: { at: '', ids: [] } });
  const hasRoot = () => [...files.values()].some((file) => file.threadId === root);
  let discoveredAt = -Infinity;

  /** Find the root rollout and sub-agent rollouts not tracked yet. */
  function discover() {
    if (!root) return;
    const suffix = `-${root}.jsonl`;
    for (const dir of dayDirs(since)) {
      for (const name of list(dir)) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        if (files.has(path) || notOurs.has(path)) continue;
        const thread = name.endsWith(suffix) ? root : childThread(path);
        if (thread === null) continue; // still being created: ask again next poll
        if (thread === false) { notOurs.add(path); continue; }
        track(path, thread);
      }
    }
    // A thread older than sinceMs keeps appending to the rollout in the folder of the day it began:
    // look for the root by name in every folder while it is missing.
    if (!since || hasRoot()) return;
    for (const dir of dayDirs(0)) {
      for (const name of list(dir)) {
        if (name.startsWith('rollout-') && name.endsWith(suffix) && !files.has(join(dir, name))) track(join(dir, name), root);
      }
    }
  }

  /** Call onLine for every complete line from `offset`; returns the offset after the last complete line. */
  function readLines(path, offset, size, onLine) {
    let fd;
    try { fd = fs.openSync(path, 'r'); } catch { return offset; }
    let consumed = offset;
    try {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK, Math.max(1, size - offset)));
      let carry = null;
      let position = offset;
      while (position < size) {
        const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (read <= 0) break;
        position += read;
        const data = carry ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
        let start = 0;
        for (let end = data.indexOf(NEWLINE, start); end !== -1; end = data.indexOf(NEWLINE, start)) {
          if (end > start) onLine(data.toString('utf8', start, end));
          start = end + 1;
        }
        consumed = position - (data.length - start);
        carry = start < data.length ? Buffer.from(data.subarray(start)) : null;
      }
    } catch { /* unreadable right now: keep what was consumed */ } finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
    return consumed;
  }

  const inWindow = (timestamp) => {
    if (!since) return true;
    const at = Date.parse(timestamp);
    return Number.isFinite(at) && at >= since;
  };

  function rememberResponse(id) {
    seen.add(id);
    seenList.push(id);
    if (seenList.length > CODEX_SEEN_MAX) seen.delete(seenList.shift());
  }

  /** Add one response's usage to its thread + turn group. */
  function book(groups, file, turnId, usage, source) {
    const raw = codexRawUsage(usage);
    const longSize = longSizeOf(file.model || null);
    const long = longSize ? raw.input_tokens > longSize : null;
    const key = `${file.threadId}|${turnId || ''}|${source}|${long === true ? 'long' : ''}`;
    let group = groups.get(key);
    if (!group) {
      const exact = source === 'codex-records';
      group = {
        threadId: file.threadId, part: file.threadId === root ? 'main' : 'subagents', turnId: turnId || null, model: file.model || null,
        tokens: zeroTokens(), usage: zeroCodexUsage(), responses: 0, mismatches: 0,
        fidelity: exact ? 'exact' : 'partial', reason: exact ? null : 'codex-no-records', source,
        ...(long === null ? {} : { long }),
      };
      groups.set(key, group);
    }
    const { tokens, mismatch } = codexUsageTokens(raw);
    group.tokens = addTokens(group.tokens, tokens);
    for (const name of CODEX_USAGE_KEYS) group.usage[name] += name === 'total_tokens' ? (raw.total_tokens ?? raw.input_tokens + raw.output_tokens) : raw[name];
    group.responses += 1;
    if (mismatch) group.mismatches += 1;
    if (file.model) group.model = file.model;
  }

  function onLine(file, line, groups) {
    if (!meterReadsLine(line)) return;
    let entry = null;
    try { entry = JSON.parse(line); } catch { return; }
    const payload = entry?.payload;
    if (!payload || typeof payload !== 'object') return;
    if (entry.type === 'turn_context') {
      if (payload.model) file.model = String(payload.model);
      if (payload.turn_id) file.turn = String(payload.turn_id);
      return;
    }
    if (entry.type === 'token_usage_record') {
      if (payload.thread_id !== file.threadId) return; // the parent's history replayed inside a forked child
      file.records = true;
      if (!inWindow(entry.timestamp)) return;
      const responseId = payload.response_id ? String(payload.response_id) : null;
      const at = String(entry.timestamp || '');
      if (at < file.mark.at || (at === file.mark.at && (!responseId || file.mark.ids.includes(responseId)))) return;
      if (responseId) {
        if (seen.has(responseId)) return;
        rememberResponse(responseId);
      }
      if (at > file.mark.at) file.mark = { at, ids: [] };
      if (responseId) file.mark.ids.push(responseId);
      book(groups, file, payload.turn_id || file.turn, payload.usage, 'codex-records');
      return;
    }
    if (entry.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info || file.records) return;
    const running = count(payload.info.total_token_usage?.total_tokens);
    if (running === file.tc) return; // the same event again (rate-limit refresh): nothing new was spent
    file.tc = running;
    if (!payload.info.last_token_usage || !inWindow(entry.timestamp)) return;
    book(groups, file, file.turn, payload.info.last_token_usage, 'codex-token-count');
  }

  function poll(options = {}) {
    if (options?.discover === true || !hasRoot() || now() - discoveredAt >= DISCOVER_EVERY_MS) { discover(); discoveredAt = now(); }
    const groups = new Map();
    const ordered = [...files].sort(([, a], [, b]) => Number(b.threadId === root) - Number(a.threadId === root));
    for (const [path, file] of ordered) {
      let size = 0;
      let inode = null;
      try { const stat = fs.statSync(path); size = stat.size; inode = stat.ino ?? null; } catch { continue; }
      if ((file.inode !== null && inode !== file.inode) || size < file.offset) {
        file.offset = 0; file.tc = null; file.records = false;
      }
      file.inode = inode;
      if (size === file.offset) continue;
      file.offset = readLines(path, file.offset, size, (line) => onLine(file, line, groups));
    }
    return [...groups.values()];
  }

  return {
    poll,
    rollouts: () => [...files].map(([path, file]) => ({ path, threadId: file.threadId, part: file.threadId === root ? 'main' : 'subagents' })),
    state: () => ({ files: Object.fromEntries([...files].map(([path, file]) => [path, { ...file }])), seen: [...seenList] }),
  };
}

// ── Part 2C: OpenCode meter ──────────────────────────────────────────────────

const OPENCODE_SESSION_MAX = 500;
const modelKey = (provider, model) => String(provider || '') + '\n' + String(model || '');
const splitModelKey = (key) => { const at = key.indexOf('\n'); return { provider: key.slice(0, at) || null, model: key.slice(at + 1) || 'unknown' }; };

/**
 * Meter for one isolated OpenCode serve. Message maxima stay in memory for the
 * meter lifetime. State stores only per-session counted totals and the highest
 * message id, so a restart can ignore replayed events without serializing messages.
 * markTurn and live difference each session before classifying it under the root.
 */
export function createOpenCodeMeter({ state } = {}) {
  let root = typeof state?.root === 'string' ? state.root : null;
  const entries = new Map(); // session:id → { session, id, key, tokens, cost }
  const base = new Map(); // restored or reconciled totals → { upTo, cost, models }
  const sessions = new Set();
  const mark = new Map(); // session → totals at the last markTurn

  const blank = () => ({ upTo: '', cost: 0, models: new Map() });
  const getBase = (session) => {
    if (!base.has(session)) base.set(session, blank());
    return base.get(session);
  };
  const readSummary = (raw) => {
    const summary = blank();
    summary.upTo = String(raw?.upTo || '');
    summary.cost = usd(raw?.cost);
    for (const [key, row] of Object.entries(raw?.models || {})) summary.models.set(key, rowToTokens(row));
    return summary;
  };
  const encodeSummary = (summary) => ({
    upTo: summary.upTo, cost: summary.cost,
    models: Object.fromEntries([...summary.models].map(([key, tokens]) => [key, tokensToRow(tokens)])),
  });
  const addEntry = (summary, entry) => {
    summary.models.set(entry.key, addTokens(summary.models.get(entry.key), entry.tokens));
    summary.cost += entry.cost;
    if (entry.id > summary.upTo) summary.upTo = entry.id;
  };
  const summaryTokens = (summary) => [...summary.models.values()].reduce(addTokens, zeroTokens());

  for (const [session, raw] of Object.entries(state?.sessions || {})) {
    base.set(session, readSummary(raw));
    sessions.add(session);
  }
  // Accept previously persisted folded states while moving to the compact format.
  if (!state?.sessions) {
    for (const [session, raw] of Object.entries(state?.base || {})) {
      base.set(session, readSummary(raw));
      sessions.add(session);
    }
    for (const row of Array.isArray(state?.entries) ? state.entries : []) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') continue;
      entries.set(row[0] + ':' + row[1], { session: row[0], id: row[1], key: String(row[2] ?? modelKey('', '')), tokens: rowToTokens(row[3]), cost: usd(row[4]) });
      sessions.add(row[0]);
    }
  }
  for (const [session, raw] of Object.entries(state?.marks || {})) mark.set(session, readSummary(raw));

  function sessionTotals() {
    const all = new Map([...base].map(([session, summary]) => [session, {
      upTo: summary.upTo, cost: summary.cost, models: new Map([...summary.models].map(([key, tokens]) => [key, { ...tokens }])),
    }]));
    for (const entry of entries.values()) {
      if (!all.has(entry.session)) all.set(entry.session, blank());
      addEntry(all.get(entry.session), entry);
    }
    return all;
  }

  function view(all, earlier = null) {
    const main = zeroTokens();
    const subagents = zeroTokens();
    const models = new Map();
    let cost = 0;
    for (const [session, summary] of all) {
      const prior = earlier?.get(session);
      const part = !root || session === root ? main : subagents;
      for (const [key, tokens] of summary.models) {
        const delta = prior ? subTokens(tokens, prior.models.get(key)) : tokens;
        for (const name of TOKEN_KEYS) part[name] += delta[name];
        models.set(key, addTokens(models.get(key), delta));
      }
      cost += prior ? Math.max(0, summary.cost - prior.cost) : summary.cost;
    }
    return {
      tokens: addTokens(main, subagents), costUsd: roundUsd(cost), main, subagents,
      byModel: [...models].filter(([, tokens]) => totalTokens(tokens) > 0)
        .map(([key, tokens]) => ({ ...splitModelKey(key), tokens }))
        .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)),
    };
  }

  // Older state held a global mark. Assign its counted model totals to the
  // sessions that supplied them, so an unmarked turn still survives upgrade.
  if (!state?.marks && state?.mark) {
    const all = sessionTotals();
    const ordered = [...all].sort(([a], [b]) => Number(b === root) - Number(a === root));
    for (const [key, row] of Object.entries(state.mark.models || {})) {
      let remaining = rowToTokens(row);
      for (const [session, summary] of ordered) {
        const available = summary.models.get(key);
        if (!available) continue;
        const counted = zeroTokens();
        for (const name of TOKEN_KEYS) counted[name] = Math.min(remaining[name], available[name]);
        const prior = mark.get(session) || blank();
        prior.models.set(key, addTokens(prior.models.get(key), counted));
        mark.set(session, prior);
        remaining = subTokens(remaining, counted);
      }
    }
    let cost = usd(state.mark.cost);
    for (const [session, summary] of ordered) {
      const prior = mark.get(session) || blank();
      prior.cost = Math.min(cost, summary.cost);
      cost -= prior.cost;
      mark.set(session, prior);
    }
  }

  function merge(info, fallbackSession = null) {
    if (!info || typeof info !== 'object' || info.role !== 'assistant') return false;
    const session = String(info.sessionID || fallbackSession || '');
    const id = String(info.id || '');
    if (!session || !id) return false;
    sessions.add(session);
    const mapKey = session + ':' + id;
    const known = entries.get(mapKey);
    if (!known && id <= (base.get(session)?.upTo || '')) return false;
    const tokens = openCodeTokens(info.tokens);
    const cost = usd(info.cost);
    if (!known) {
      if (totalTokens(tokens) === 0 && cost === 0) return false;
      entries.set(mapKey, { session, id, key: modelKey(info.providerID, info.modelID), tokens, cost });
      return true;
    }
    const raised = maxTokens(known.tokens, tokens);
    const changed = !sameTokens(raised, known.tokens) || cost > known.cost;
    known.tokens = raised;
    known.cost = Math.max(known.cost, cost);
    if (known.key === modelKey('', '') && (info.providerID || info.modelID)) known.key = modelKey(info.providerID, info.modelID);
    return changed;
  }

  function onEvent(eventType, event) {
    const type = String(eventType || event?.type || '').replace(':', '.');
    const info = event?.info || event?.message?.info || event?.properties?.info || null;
    if (type === 'session.created' || type === 'session.updated') {
      if (info?.id && sessions.size < OPENCODE_SESSION_MAX) sessions.add(String(info.id));
      return false;
    }
    if (type !== 'message.updated') return false;
    return merge(info);
  }

  async function reconcile({ children = async () => [], messages = async () => [] } = {}) {
    const queue = [...(root ? [root] : []), ...sessions];
    const visited = new Set();
    let changed = false;
    while (queue.length && visited.size < OPENCODE_SESSION_MAX) {
      const session = queue.shift();
      if (!session || visited.has(session)) continue;
      visited.add(session);
      let stored = [];
      try { stored = await messages(session); } catch { stored = []; }
      const storedMessages = new Map();
      for (const item of Array.isArray(stored) ? stored : []) {
        const info = item?.info || item;
        if (info?.role !== 'assistant' || !info.id) continue;
        const id = String(info.id);
        const key = modelKey(info.providerID, info.modelID);
        const prior = storedMessages.get(id);
        const tokens = openCodeTokens(info.tokens);
        const cost = usd(info.cost);
        storedMessages.set(id, prior ? { id, key: prior.key, tokens: maxTokens(prior.tokens, tokens), cost: Math.max(prior.cost, cost) } : { id, key, tokens, cost });
        if (merge(info, session)) changed = true;
      }
      // A restored meter does not retain old messages. A full storage scan can
      // still reveal an old snapshot that was missed before the restart.
      const expected = blank();
      for (const entry of storedMessages.values()) addEntry(expected, entry);
      const actual = sessionTotals().get(session) || blank();
      const target = getBase(session);
      const missing = subTokens(summaryTokens(expected), summaryTokens(actual));
      if (totalTokens(missing)) {
        const key = [...expected.models].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))[0]?.[0] || modelKey('', '');
        target.models.set(key, addTokens(target.models.get(key), missing));
        changed = true;
      }
      if (expected.cost > actual.cost) { target.cost += expected.cost - actual.cost; changed = true; }
      if (expected.upTo > target.upTo) target.upTo = expected.upTo;
      let kids = [];
      try { kids = await children(session); } catch { kids = []; }
      for (const kid of Array.isArray(kids) ? kids : []) queue.push(typeof kid === 'string' ? kid : String(kid?.id || ''));
    }
    return changed;
  }

  return {
    onEvent,
    setRoot(sessionId) { root = sessionId ? String(sessionId) : null; if (root) sessions.add(root); },
    total: () => view(sessionTotals()),
    live: () => view(sessionTotals(), mark),
    markTurn() {
      const totals = sessionTotals();
      const delta = view(totals, mark);
      mark.clear();
      for (const [session, summary] of totals) mark.set(session, summary);
      return delta;
    },
    reconcile,
    state: () => ({
      root,
      sessions: Object.fromEntries([...sessionTotals()].map(([session, summary]) => [session, encodeSummary(summary)])),
      marks: Object.fromEntries([...mark].map(([session, summary]) => [session, encodeSummary(summary)])),
    }),
  };
}

// ── Part 3: ledger ───────────────────────────────────────────────────────────

const LEDGER_DIR = 'assistant-usage';
const JUDGMENT_TTL_MS = 5000;
const TITLE_MAX = 200;
const PARTS = Object.freeze(['main', 'subagents', 'aux']);
/** How a dollar figure is known, weakest last: a sum is only as good as its weakest part. */
const COST_BASES = Object.freeze(['free', 'reported', 'estimated', 'unpriced']);
/** The weaker of two cost bases (null when neither is one). */
export function weakerCostBasis(a, b) {
  const x = COST_BASES.indexOf(a);
  const y = COST_BASES.indexOf(b);
  return x < 0 && y < 0 ? null : COST_BASES[Math.max(x, y)];
}

/** A session id as a file name; null when it cannot be one. */
function safeSessionId(sessionId) {
  const id = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return id && id !== '.' && id !== '..' ? id : null;
}

/** <dataDir>/assistant-usage/<sessionId>.jsonl, or null for an unusable id. */
export function usageLedgerPath(dataDir, sessionId) {
  const id = safeSessionId(sessionId);
  return id ? join(dataDir, LEDGER_DIR, `${id}.jsonl`) : null;
}

/**
 * Parse a ledger file: { tasks:[{ id, n, at, title }], rows:[use lines with tokens as an object],
 * judged:[{ task, at, input, output, calls, costUsd }], corrupt, endsClean }.
 * Corrupt lines are counted and skipped. A missing file is an empty ledger.
 */
export function readUsageLedgerFile(path, fs = nodeFs) {
  const out = { tasks: [], rows: [], judged: [], corrupt: 0, endsClean: true };
  let text = '';
  try { text = fs.readFileSync(path, 'utf8'); } catch { return out; }
  out.endsClean = text === '' || text.endsWith('\n');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry = null;
    try { entry = JSON.parse(line); } catch { out.corrupt += 1; continue; }
    if (entry?.t === 'task' && typeof entry.id === 'string') {
      out.tasks.push({ id: entry.id, n: count(entry.n), at: count(entry.at), title: typeof entry.title === 'string' ? entry.title : null });
    } else if (entry?.t === 'use' && typeof entry.task === 'string') {
      out.rows.push({ ...entry, tokens: rowToTokens(entry.tokens) });
    } else if (entry?.t === 'jev' && typeof entry.task === 'string') {
      out.judged.push({ task: entry.task, at: count(entry.at), input: count(entry.input), output: count(entry.output), calls: count(entry.calls), costUsd: usd(entry.cost) });
    } else out.corrupt += 1;
  }
  return out;
}

/** Who a row belongs to: 'brain', or the run id. */
const agentKeyOf = (scope, runId) => (scope === 'brain' ? 'brain' : String(runId || 'run'));

/** The larger of two judgment counts, field by field; the other when one is missing. */
function moreJudged(a, b) {
  if (!a || !b) return a || b || null;
  return { input: Math.max(a.input, b.input), output: Math.max(a.output, b.output), calls: Math.max(a.calls, b.calls), costUsd: Math.max(usd(a.costUsd), usd(b.costUsd)) };
}

/**
 * The usage ledger: one append-only file per assistant session
 * (<dataDir>/assistant-usage/<sessionId>.jsonl), loaded on first use and cached.
 *   {"t":"task","id","n","at","title"}
 *   {"t":"use","at","task","scope":"brain"|"run","run","turn","provider","model","part":"main"|"subagents"|"aux",
 *    "tokens":[input,cacheWrite,cacheRead,output,reasoning],"cost","basis","fid":"exact"|"partial","why","src"}
 *   {"t":"jev","at","task","input","output","calls","cost"}   a task's Jev judgments, as last counted (the largest wins)
 *
 * beginTask(sessionId, { title, at }) → { id, n }   a human prompt: id `task-<n>`, n from 1; becomes the current task
 * currentTask(sessionId) → { id, n, title, startedAt } | null
 * ensureTask(sessionId)  → the current task, creating { id:'task-0', n:0, title:null } when the session has none
 * settle({ sessionId, taskId, scope, runId, turn, provider, model, part, tokens, costUsd, costBasis, fidelity, reason, source })
 *     appends one row and returns it; null when it has zero tokens and no cost. taskId defaults to the
 *     current task (ensureTask); an unknown one falls back to it. tokens is a five-class object or a
 *     ledger array. part defaults to 'main', fidelity to 'exact'; `at` (ms) overrides the row time.
 *     Clears the pending of that agent ('brain', or the runId) unless part is 'aux'.
 * setPending(sessionId, agentKey, { taskId, scope, runId, provider, model, tokens })   replaces that agent's
 *     provisional tokens (zero tokens clear it); clearPending(sessionId, agentKey). Never written to disk.
 * taskView(sessionId, taskId = 'current') → the gauge's view (see below)
 * sessionView(sessionId) → { sessionId, tokens, pending, costUsd, costBasis, live, fidelity, unsynced, models,
 *     tasks:[{ id, n, title, startedAt, total, inputTotal, outputTotal, costUsd, fidelity, live }] } (oldest first)
 * flush(sessionId?) → remaining unsynced lines after retrying them in order
 * runView(sessionId, runId) → { tokens, pending, subagents:{ total }, fidelity, taskIds } | null, over every task the run worked in
 * subscribe(listener) → unsubscribe; listener(sessionId) after beginTask, settle and every pending change
 * dropSession(sessionId)  deletes the file and cache; late writes are ignored until beginTask(id)
 *
 * taskView:
 *   { sessionId,
 *     task: null | { id, n, title, startedAt, live, fidelity, tokens, pending, costUsd,
 *                    agents:[{ key, scope, runId, provider, model, tokens, pending, subagents:{ total }, fidelity, partialReason }],
 *                    costBasis, models:[{ provider, model, tokens, costUsd, costBasis }] },
 *     session:{ tokens, pending, costUsd, costBasis, live, fidelity, tasks, unsynced,
 *               models:[{ provider, model, tokens, costUsd, costBasis }] },
 *     recent:[{ id, n, title, total, inputTotal, outputTotal, costUsd, fidelity, live }] }
 *   `session` is the headline: every task of the session added up, so it only grows as tasks are
 *   added. It is built from the file, so a restart shows the same totals.
 *   Every `tokens` is settled + pending (five classes + total + inputTotal + outputTotal); `pending`
 *   is the provisional share inside it. live = an agent of the task has pending tokens. fidelity =
 *   'live' when live, else 'partial' when any of its rows is partial, else 'exact'. agents: brain
 *   first, then runs in first-seen order; an agent that used several models reports the one with
 *   most tokens; subagents.total counts its part 'subagents' rows. costUsd sums the rows that
 *   carried a cost; costBasis is the weakest basis among them ('free' < 'reported' < 'estimated' <
 *   'unpriced', null when no row named one). models: most tokens first.
 *   recent = up to 5 other tasks, newest first.
 *   With `judgments` (a SYNC function ({ sessionId, taskId, runIds, sinceMs, untilMs }) →
 *   { input, output, calls } | null) one more agent { key:'judgments', scope:'judgments',
 *   provider:'jev', calls } is added last and counted in the task and session totals; its answer is
 *   cached 5 s for the current task or one with pending tokens; a closed task with no pending
 *   keeps its final answer until dropSession() clears the session cache. The largest count seen
 *   for a task is written to the file ("jev" line) and never undercut: the judgment log is pruned,
 *   so a later read (or a restart) can find less than was shown.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => number} [options.now]
 * @param {(event: string, detail: string) => void} [options.log]
 * @param {Function|null} [options.judgments]
 * @param {object} [options.fs] node:fs-like (tests)
 */
export function createUsageLedger({ dataDir, now = Date.now, log = () => {}, judgments = null, fs = nodeFs } = {}) {
  if (!dataDir) throw new Error('createUsageLedger requires dataDir');
  const sessions = new Map();
  const dropped = new Set();
  const listeners = new Set();

  const newTask = ({ id, n, title = null, startedAt = 0 }) => ({ id, n, title, startedAt, order: [], agents: new Map(), partial: false, costUsd: 0 });
  const newAgent = (key, scope, runId) => ({
    key, scope, runId, provider: null, tokens: zeroTokens(), subagents: zeroTokens(), costUsd: 0,
    partial: false, partialReason: null, models: new Map(), money: new Map(), // money: model → { costUsd, basis }
  });

  function noteAgent(task, key) {
    if (!task.order.includes(key)) task.order.push(key);
  }

  /** Add one settled row to its task's aggregates. */
  function apply(session, row) {
    let task = session.tasks.get(row.task);
    if (!task) {
      // A row whose task line was lost (corrupt line): keep its tokens under a placeholder.
      const n = count(/^task-(\d+)$/.exec(row.task)?.[1]);
      task = newTask({ id: row.task, n, startedAt: count(row.at) });
      session.tasks.set(task.id, task);
      session.maxN = Math.max(session.maxN, n);
      if (!session.current) session.current = task.id;
    }
    const key = agentKeyOf(row.scope, row.run);
    noteAgent(task, key);
    let agent = task.agents.get(key);
    if (!agent) { agent = newAgent(key, row.scope === 'brain' ? 'brain' : 'run', row.scope === 'brain' ? null : row.run || null); task.agents.set(key, agent); }
    const tokens = cleanTokens(row.tokens);
    agent.tokens = addTokens(agent.tokens, tokens);
    if (row.part === 'subagents') agent.subagents = addTokens(agent.subagents, tokens);
    if (!agent.provider && row.provider) agent.provider = row.provider;
    const mKey = modelKey(row.provider, row.model);
    agent.models.set(mKey, addTokens(agent.models.get(mKey), tokens));
    const cost = usd(row.cost);
    agent.costUsd += cost;
    task.costUsd += cost;
    const money = agent.money.get(mKey) || { costUsd: 0, basis: null };
    money.costUsd += cost;
    money.basis = weakerCostBasis(money.basis, row.basis);
    agent.money.set(mKey, money);
    if (row.fid === 'partial') {
      task.partial = true;
      agent.partial = true;
      if (!agent.partialReason) agent.partialReason = row.why || 'partial';
    }
  }

  /** The session's cached aggregates, loaded from its file on first use; null for an unusable id. */
  function open(sessionId) {
    const path = usageLedgerPath(dataDir, sessionId);
    if (!path) return null;
    const id = String(sessionId);
    if (dropped.has(id)) return null;
    if (sessions.has(id)) return sessions.get(id);
    const session = { id, path, tasks: new Map(), current: null, maxN: 0, pending: new Map(), judged: new Map(), jev: new Map(), endsClean: true, retry: [] };
    const file = readUsageLedgerFile(path, fs);
    session.endsClean = file.endsClean;
    if (file.corrupt) log('assistant-usage:corrupt-lines', `${id}: ${file.corrupt} skipped`);
    for (const line of file.tasks) {
      const known = session.tasks.get(line.id);
      if (known) { known.n = line.n; known.title = line.title; known.startedAt = line.at; } else session.tasks.set(line.id, newTask({ id: line.id, n: line.n, title: line.title, startedAt: line.at }));
      session.maxN = Math.max(session.maxN, line.n);
      session.current = line.id;
    }
    for (const row of file.rows) apply(session, row);
    for (const line of file.judged) session.jev.set(line.task, moreJudged(session.jev.get(line.task), line));
    sessions.set(id, session);
    return session;
  }

  function drain(session) {
    while (session.retry.length) {
      try {
        fs.mkdirSync(join(dataDir, LEDGER_DIR), { recursive: true });
        // A torn last line (crash mid-append) must not swallow this one.
        fs.appendFileSync(session.path, `${session.endsClean ? '' : '\n'}${JSON.stringify(session.retry[0])}\n`);
        session.endsClean = true;
        session.retry.shift();
      } catch (error) {
        session.endsClean = readUsageLedgerFile(session.path, fs).endsClean;
        try { log('assistant-usage:append-error', error?.message || String(error)); } catch { /* an append failure stays queued */ }
        break;
      }
    }
    return session.retry.length;
  }

  function append(session, line) {
    session.retry.push(line);
    drain(session);
  }

  function flush(sessionId = null) {
    if (sessionId !== null) {
      const session = open(sessionId);
      if (!session) return 0;
      const before = session.retry.length;
      const remaining = drain(session);
      if (remaining !== before) notify(session.id);
      return remaining;
    }
    let remaining = 0;
    for (const session of sessions.values()) {
      const before = session.retry.length;
      const left = drain(session);
      if (left !== before) notify(session.id);
      remaining += left;
    }
    return remaining;
  }

  function notify(sessionId) {
    for (const listener of [...listeners]) {
      try { listener(sessionId); } catch (error) {
        try { log('assistant-usage:listener-error', error?.message || String(error)); } catch { /* a listener cannot break accounting */ }
      }
    }
  }

  const publicTask = (task) => (task ? { id: task.id, n: task.n, title: task.title, startedAt: task.startedAt } : null);

  function startTask(session, { id, n, title, at }) {
    const task = newTask({ id, n, title, startedAt: at });
    session.tasks.set(id, task);
    session.maxN = Math.max(session.maxN, n);
    session.current = id;
    append(session, { t: 'task', id, n, at, title });
    return task;
  }

  function beginTask(sessionId, { title = null, at = null } = {}) {
    if (!usageLedgerPath(dataDir, sessionId)) return null;
    dropped.delete(String(sessionId));
    const session = open(sessionId);
    if (!session) return null;
    const n = session.maxN + 1;
    const clean = typeof title === 'string' && title.trim() ? title.trim().slice(0, TITLE_MAX) : null;
    const task = startTask(session, { id: `task-${n}`, n, title: clean, at: count(at) || now() });
    notify(session.id);
    return { id: task.id, n: task.n };
  }

  function currentTask(sessionId) {
    const session = open(sessionId);
    return session ? publicTask(session.tasks.get(session.current)) : null;
  }

  function ensure(session) {
    return session.tasks.get(session.current) || startTask(session, { id: 'task-0', n: 0, title: null, at: now() });
  }

  function ensureTask(sessionId) {
    const session = open(sessionId);
    return session ? publicTask(ensure(session)) : null;
  }

  /** The task a caller named: an id, 'current' or nothing (both mean the current task). */
  function taskFor(session, taskId) {
    if (taskId && taskId !== 'current') {
      const task = session.tasks.get(String(taskId));
      if (task) return task;
      log('assistant-usage:unknown-task', `${session.id}: ${taskId}`);
    }
    return ensure(session);
  }

  function settle(input = {}) {
    const session = open(input.sessionId);
    if (!session) return null;
    const tokens = cleanTokens(input.tokens);
    const cost = Number.isFinite(input.costUsd) && input.costUsd >= 0 ? Number(input.costUsd) : null;
    if (totalTokens(tokens) === 0 && !cost) return null;
    const task = taskFor(session, input.taskId);
    const scope = input.scope === 'brain' ? 'brain' : 'run';
    const row = {
      t: 'use', at: count(input.at) || now(), task: task.id, scope,
      run: scope === 'brain' ? null : (input.runId ? String(input.runId) : null),
      turn: Number.isInteger(input.turn) ? input.turn : null,
      provider: input.provider ? String(input.provider) : null,
      model: input.model ? String(input.model) : null,
      part: PARTS.includes(input.part) ? input.part : 'main',
      tokens: tokensToRow(tokens),
      cost,
      basis: input.costBasis ? String(input.costBasis) : null,
      fid: input.fidelity === 'partial' ? 'partial' : 'exact',
      why: input.reason ? String(input.reason) : null,
      src: input.source ? String(input.source) : null,
    };
    append(session, row);
    apply(session, row);
    if (row.part !== 'aux') session.pending.delete(agentKeyOf(scope, row.run)); // provisional tokens are booked now
    notify(session.id);
    return row;
  }

  function setPending(sessionId, agentKey, input = {}) {
    const session = open(sessionId);
    const key = String(agentKey || '');
    if (!session || !key) return false;
    const tokens = cleanTokens(input.tokens);
    const known = session.pending.get(key);
    if (totalTokens(tokens) === 0) return clearPending(sessionId, key);
    const task = taskFor(session, input.taskId);
    const scope = key === 'brain' || input.scope === 'brain' ? 'brain' : 'run';
    const next = {
      taskId: task.id, scope, runId: scope === 'brain' ? null : String(input.runId || key),
      provider: input.provider ? String(input.provider) : null, model: input.model ? String(input.model) : null, tokens,
    };
    if (known && known.taskId === next.taskId && known.model === next.model && sameTokens(known.tokens, tokens)) return false;
    session.pending.set(key, next);
    if (task.id !== session.current && session.judged.get(task.id)?.closed) session.judged.delete(task.id); // a closed task is live again
    noteAgent(task, key);
    notify(session.id);
    return true;
  }

  function clearPending(sessionId, agentKey) {
    const session = open(sessionId);
    if (!session || !session.pending.delete(String(agentKey || ''))) return false;
    notify(session.id);
    return true;
  }

  /** The next task by number, whose start closes this task's time window. */
  function nextTask(session, task) {
    let next = null;
    for (const other of session.tasks.values()) if (other.n > task.n && (!next || other.n < next.n)) next = other;
    return next;
  }

  /**
   * Jev judgments of a task ({ input, output, calls, costUsd }); closed tasks without pending freeze.
   * Never less than what the file holds for the task, and a larger count is written to it: the
   * judgment log is pruned, so a count that was shown must not shrink later. Without a reader the
   * file's count stands.
   */
  function judged(session, task, liveTaskIds) {
    const saved = session.jev.get(task.id) || null;
    if (typeof judgments !== 'function') return saved;
    const closed = task.id !== session.current && !liveTaskIds.has(task.id);
    const cached = session.judged.get(task.id);
    if (cached && (closed ? cached.closed : now() - cached.at < JUDGMENT_TTL_MS)) return cached.value;
    let value = null;
    try {
      const answer = judgments({
        sessionId: session.id, taskId: task.id, sinceMs: task.startedAt, untilMs: nextTask(session, task)?.startedAt ?? null,
        runIds: [...task.agents.values()].filter((agent) => agent.scope === 'run' && agent.runId).map((agent) => agent.runId),
      });
      if (answer && typeof answer === 'object') value = { input: count(answer.input), output: count(answer.output), calls: count(answer.calls), costUsd: usd(answer.costUsd) };
    } catch (error) {
      log('assistant-usage:judgments-error', error?.message || String(error));
    }
    value = moreJudged(saved, value);
    session.judged.set(task.id, { at: now(), value, closed });
    const grew = value && (value.input || value.output || value.calls)
      && (!saved || value.input > saved.input || value.output > saved.output || value.calls > saved.calls || value.costUsd > saved.costUsd);
    if (grew) {
      session.jev.set(task.id, value);
      append(session, { t: 'jev', at: now(), task: task.id, input: value.input, output: value.output, calls: value.calls, cost: roundUsd(value.costUsd) });
    }
    return value;
  }

  /** Everything a view needs about one task: per-agent rows plus totals (settled + pending + judgments). */
  function summarize(session, task, liveTaskIds) {
    const agents = [];
    const models = new Map();
    const money = new Map(); // model → { costUsd, basis }
    let tokens = zeroTokens();
    let pending = zeroTokens();
    let costUsd = task.costUsd;
    const keys = [...task.order].sort((a, b) => Number(b === 'brain') - Number(a === 'brain'));
    for (const key of keys) {
      const agent = task.agents.get(key) || null;
      const held = session.pending.get(key);
      const mine = held && held.taskId === task.id ? held : null;
      if (!agent && !mine) continue;
      const agentPending = mine ? mine.tokens : zeroTokens();
      const agentModels = new Map(agent ? agent.models : []);
      if (mine) {
        const mKey = modelKey(mine.provider, mine.model);
        agentModels.set(mKey, addTokens(agentModels.get(mKey), agentPending));
      }
      let top = null;
      for (const [mKey, used] of agentModels) {
        models.set(mKey, addTokens(models.get(mKey), used));
        if (!top || totalTokens(used) > totalTokens(agentModels.get(top))) top = mKey;
      }
      for (const [mKey, held] of agent ? agent.money : []) {
        const known = money.get(mKey) || { costUsd: 0, basis: null };
        money.set(mKey, { costUsd: known.costUsd + held.costUsd, basis: weakerCostBasis(known.basis, held.basis) });
      }
      const all = addTokens(agent?.tokens, agentPending);
      const live = totalTokens(agentPending) > 0;
      tokens = addTokens(tokens, all);
      pending = addTokens(pending, agentPending);
      agents.push({
        key,
        scope: agent?.scope || mine.scope,
        runId: agent ? agent.runId : mine.runId,
        provider: agent?.provider || mine?.provider || null,
        model: top ? splitModelKey(top).model : null,
        tokens: withTotal(all),
        pending: withTotal(agentPending),
        subagents: { total: totalTokens(agent?.subagents) },
        fidelity: live ? 'live' : agent?.partial ? 'partial' : 'exact',
        partialReason: agent?.partial ? agent.partialReason : null,
      });
    }
    const jev = judged(session, task, liveTaskIds);
    if (jev && (jev.input || jev.output || jev.calls)) {
      const used = { ...zeroTokens(), input: jev.input, output: jev.output };
      tokens = addTokens(tokens, used);
      costUsd += jev.costUsd;
      models.set(modelKey('jev', 'jev'), used);
      // Jev reports no charge: its dollars are its tokens at the configured rate.
      money.set(modelKey('jev', 'jev'), { costUsd: jev.costUsd, basis: jev.costUsd > 0 ? 'estimated' : null });
      agents.push({
        key: 'judgments', scope: 'judgments', runId: null, provider: 'jev', model: 'jev',
        tokens: withTotal(used), pending: withTotal(zeroTokens()), subagents: { total: 0 }, fidelity: 'exact', partialReason: null, calls: jev.calls,
      });
    }
    const live = totalTokens(pending) > 0;
    const modelRows = [...models]
      .filter(([, used]) => totalTokens(used) > 0)
      .map(([mKey, used]) => ({ ...splitModelKey(mKey), tokens: withTotal(used), costUsd: roundUsd(money.get(mKey)?.costUsd), costBasis: money.get(mKey)?.basis || null }))
      .sort((a, b) => b.tokens.total - a.tokens.total);
    return {
      id: task.id, n: task.n, title: task.title, startedAt: task.startedAt,
      live, fidelity: live ? 'live' : task.partial ? 'partial' : 'exact',
      tokens: withTotal(tokens), pending: withTotal(pending), costUsd: roundUsd(costUsd),
      costBasis: modelRows.reduce((basis, row) => weakerCostBasis(basis, row.costBasis), null),
      agents,
      models: modelRows,
    };
  }

  const brief = (summary) => ({
    id: summary.id, n: summary.n, title: summary.title, total: summary.tokens.total, inputTotal: summary.tokens.inputTotal, outputTotal: summary.tokens.outputTotal,
    costUsd: summary.costUsd, fidelity: summary.fidelity, live: summary.live,
  });

  /**
   * Every task of the session summarized, oldest first, with the session totals: the tasks added
   * up, per class, per model and in dollars. Rows are only ever appended, so the settled part of
   * the total never goes down.
   */
  function summarizeSession(session) {
    const liveTaskIds = new Set([...session.pending.values()].filter((held) => totalTokens(held.tokens) > 0).map((held) => held.taskId));
    const tasks = [...session.tasks.values()].sort((a, b) => a.n - b.n).map((task) => summarize(session, task, liveTaskIds));
    let tokens = zeroTokens();
    let pending = zeroTokens();
    let costUsd = 0;
    const models = new Map();
    for (const summary of tasks) {
      tokens = addTokens(tokens, summary.tokens);
      pending = addTokens(pending, summary.pending);
      costUsd += summary.costUsd;
      for (const row of summary.models) {
        const mKey = modelKey(row.provider, row.model);
        const known = models.get(mKey) || { tokens: zeroTokens(), costUsd: 0, basis: null };
        models.set(mKey, { tokens: addTokens(known.tokens, row.tokens), costUsd: known.costUsd + row.costUsd, basis: weakerCostBasis(known.basis, row.costBasis) });
      }
    }
    const modelRows = [...models]
      .map(([mKey, held]) => ({ ...splitModelKey(mKey), tokens: withTotal(held.tokens), costUsd: roundUsd(held.costUsd), costBasis: held.basis }))
      .sort((a, b) => b.tokens.total - a.tokens.total);
    const live = totalTokens(pending) > 0;
    const partial = [...session.tasks.values()].some((task) => task.partial);
    return {
      tasks, tokens: withTotal(tokens), pending: withTotal(pending), costUsd: roundUsd(costUsd),
      costBasis: modelRows.reduce((basis, row) => weakerCostBasis(basis, row.costBasis), null),
      live, fidelity: live ? 'live' : partial ? 'partial' : 'exact', models: modelRows,
    };
  }

  /** The session block of a view: the headline. */
  const sessionBlock = (session, all) => ({
    tokens: all.tokens, pending: all.pending, costUsd: all.costUsd, costBasis: all.costBasis, live: all.live, fidelity: all.fidelity,
    tasks: all.tasks.length, unsynced: session.retry.length, models: all.models,
  });

  function taskView(sessionId, taskId = 'current') {
    const session = open(sessionId);
    const none = withTotal(zeroTokens());
    const empty = { sessionId: String(sessionId || ''), task: null, session: { tokens: none, pending: none, costUsd: 0, costBasis: null, live: false, fidelity: 'exact', tasks: 0, unsynced: 0, models: [] }, recent: [] };
    if (!session) return empty;
    const all = summarizeSession(session);
    const wanted = taskId === 'current' || !taskId ? session.current : String(taskId);
    const task = all.tasks.find((summary) => summary.id === wanted) || null;
    return {
      sessionId: session.id,
      task,
      session: sessionBlock(session, all),
      recent: all.tasks.filter((summary) => summary.id !== wanted).reverse().slice(0, 5).map(brief),
    };
  }

  function sessionView(sessionId) {
    const session = open(sessionId);
    const none = withTotal(zeroTokens());
    if (!session) return { sessionId: String(sessionId || ''), tokens: none, pending: none, costUsd: 0, costBasis: null, live: false, fidelity: 'exact', unsynced: 0, models: [], tasks: [] };
    const all = summarizeSession(session);
    const { tasks: _count, ...block } = sessionBlock(session, all);
    return { sessionId: session.id, ...block, tasks: all.tasks.map((summary) => ({ ...brief(summary), startedAt: summary.startedAt })) };
  }

  function runView(sessionId, runId) {
    const session = open(sessionId);
    const key = String(runId || '');
    if (!session || !key) return null;
    let tokens = zeroTokens();
    let subagents = zeroTokens();
    let partial = false;
    const taskIds = [];
    for (const task of [...session.tasks.values()].sort((a, b) => a.n - b.n)) {
      const agent = task.agents.get(key);
      if (!agent || agent.scope !== 'run') continue;
      tokens = addTokens(tokens, agent.tokens);
      subagents = addTokens(subagents, agent.subagents);
      partial = partial || agent.partial;
      taskIds.push(task.id);
    }
    const held = session.pending.get(key);
    const pending = held && held.scope === 'run' ? held.tokens : zeroTokens();
    if (held && held.scope === 'run' && !taskIds.includes(held.taskId)) taskIds.push(held.taskId);
    if (!taskIds.length) return null;
    const live = totalTokens(pending) > 0;
    return {
      tokens: withTotal(addTokens(tokens, pending)), pending: withTotal(pending), subagents: { total: totalTokens(subagents) },
      fidelity: live ? 'live' : partial ? 'partial' : 'exact', taskIds,
    };
  }

  function dropSession(sessionId) {
    const path = usageLedgerPath(dataDir, sessionId);
    if (!path) return false;
    const id = String(sessionId);
    sessions.delete(id);
    dropped.add(id);
    try { fs.rmSync(path, { force: true }); } catch (error) { log('assistant-usage:drop-error', error?.message || String(error)); return false; }
    notify(id);
    return true;
  }

  return {
    beginTask, currentTask, ensureTask, settle, setPending, clearPending,
    taskView, sessionView, runView, flush, dropSession,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
