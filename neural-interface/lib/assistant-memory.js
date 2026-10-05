// ═══════════════════════════════════════════
// SynaBun — Assistant memory integration
// ═══════════════════════════════════════════
//
// Provider-neutral memory obligations for the central assistant:
//   • recallForPrompt  — token-budgeted auto-recall per user turn (dedup by
//                        context generation), returned as the same block the
//                        Claude Code hooks inject. System and trivial prompts
//                        are skipped for free; Jev's prompt-urgency judgment
//                        (run beside a ranked, floored recall) decides whether
//                        and how many memories to inject.
//   • claudeHooks      — in-process Claude Agent SDK hooks (UserPromptSubmit
//                        recall, PreCompact generation bump, PostToolUse
//                        remember tracking, Stop nudge).
//   • rememberDispatch — deterministic memory for a completed dispatched run
//                        (skipped when the worker already stored one for it).
//
// All heavy dependencies are injectable so the module is unit-testable; the
// defaults use the in-process MCP services already loaded by the server.

import { hookRecall as defaultHookRecall } from './memory-api.js';
// Pure and dependency-free (the hooks use it too). Read through a namespace so
// a changed shape falls back to the local rules below instead of failing to load.
import * as promptOrigin from '../../hooks/claude-code/prompt-origin.mjs';

export const MEMORY_BLOCK_START = '=== SynaBun: Related Memories ===';
export const MEMORY_BLOCK_END = '=== End Memories ===';
export const ALREADY_PRESENT_LINE = 'SynaBun: Relevant memories for this topic were already supplied in this context. Reuse them; refresh only if evidence is missing or conflicting.';

// Messages that never need recall (mirrors hooks/claude-code/prompt-submit.mjs).
export const RECALL_SKIP_PATTERNS = [
  /^(yes|no|ok|sure|thanks|ty|thank you|perfect|great|good|nice|cool|got it|yep|nope|nah)\b/i,
  /^(do it|go ahead|proceed|continue|keep going|next|done|stop|cancel|abort|nevermind)\b/i,
  /^\s*$/,
  /^\/\w+/,
  /^.{1,7}$/,
  /^(read|open|show|cat|look at|check) .+\.\w{1,5}$/i,
  /^(run|execute|start|npm|node|git|pnpm|yarn|bun) /i,
  /^\[SynaBun Mailbox\]/i,
];
// The ack, "do it / next …", "open file.ext" and command rules describe a SHORT
// message. A long prompt that merely begins with "Run …", "No, …" or "Next, …" is a
// real request: the 2026-09-24 acceptance prompt ("Run a live acceptance test …",
// 9k characters) was skipped by the command rule when the urgency judgment timed out.
const SHORT_ONLY_SKIP = new Set([RECALL_SKIP_PATTERNS[0], RECALL_SKIP_PATTERNS[1], RECALL_SKIP_PATTERNS[5], RECALL_SKIP_PATTERNS[6]]);
export const SHORT_PROMPT_MAX = 60;

export function shouldSkipRecall(prompt) {
  const trimmed = String(prompt || '').trim();
  const short = trimmed.length <= SHORT_PROMPT_MAX && !trimmed.includes('\n');
  return RECALL_SKIP_PATTERNS.some((pattern) => (short || !SHORT_ONLY_SKIP.has(pattern)) && pattern.test(trimmed));
}

/** After a `must` block: the injected memories may not be the whole story. */
export const MUST_RECALL_NUDGE = 'SynaBun: this asks about past work or an earlier decision. If these memories do not settle it, call recall with a focused query before answering.';

// Local fallbacks, used only if prompt-origin.mjs ever changes shape.
const LOCAL_SYSTEM_MARKER = /^\[SynaBun (?:Mailbox|Router|Browser|Loop)\]/i;
const LOCAL_TRIVIAL = [/^\s*$/, /^[\s\S]{1,7}$/, /^\/[\w:.-]+(?:\s[\s\S]*)?$/];

/** Who wrote this turn: { origin: 'system'|'human', text } (text without IDE/hook wrappers). */
export function classifyTurn(raw) {
  try {
    const out = typeof promptOrigin.classifyPrompt === 'function' ? promptOrigin.classifyPrompt(raw) : null;
    if (out && (out.origin === 'system' || out.origin === 'human') && typeof out.text === 'string') return out;
  } catch { /* fall through */ }
  const text = String(raw ?? '').trim();
  return LOCAL_SYSTEM_MARKER.test(text) ? { origin: 'system', text, marker: 'synabun' } : { origin: 'human', text, marker: null };
}

/** A human prompt that can never benefit from a judgment or a recall (whole-string rules). */
export function isTrivialTurn(text) {
  try { if (typeof promptOrigin.isTrivialPrompt === 'function') return !!promptOrigin.isTrivialPrompt(text); } catch { /* fall through */ }
  const trimmed = String(text ?? '').trim();
  return LOCAL_TRIVIAL.some((pattern) => pattern.test(trimmed));
}

/**
 * Memories per urgency, from the configured limit / token budget (3 / 600 by
 * default): consider 2 / 400, should 3 / 600, must 5 / 900.
 */
export function recallTier(decision, { limit = 3, tokenBudget = 600 } = {}) {
  if (decision === 'must') return { name: 'must', limit: Math.min(10, limit + 2), tokenBudget: Math.min(2000, Math.round(tokenBudget * 1.5)) };
  if (decision === 'consider') return { name: 'consider', limit: Math.max(1, limit - 1), tokenBudget: Math.max(100, Math.round((tokenBudget * 2) / 3)) };
  return { name: 'should', limit, tokenBudget };
}

/** Head and tail of a long prompt, as the hooks clip it for a judgment. */
function clipForJudge(text, max = 6000, head = 4000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const marker = '\n[…]\n';
  return s.slice(0, head) + marker + s.slice(s.length - (max - head - marker.length));
}

/**
 * The memory block. A ranked recall says so on its closing line, with the
 * number of candidates the relevance floor dropped (the hook's tag); a nudge
 * line follows the block when given.
 */
export function formatMemoryBlock(data, { ranked, dropped, nudge = '' } = {}) {
  if (!data) return '';
  const withNudge = (block) => (block && nudge ? `${block}\n${nudge}` : block);
  if (data.already_present) return withNudge(ALREADY_PRESENT_LINE);
  if (!Array.isArray(data.results) || data.results.length === 0) return '';
  const isRanked = ranked ?? !!data.ranked;
  const n = Number(dropped ?? (Array.isArray(data.dropped) ? data.dropped.length : 0)) || 0;
  const tag = isRanked ? ` [ranked by Jev${n > 0 ? `; ${n} low-relevance ${n === 1 ? 'match' : 'matches'} dropped` : ''}]` : '';
  if (data.context) {
    return withNudge(`${MEMORY_BLOCK_START}\n${data.context}\nUse these as evidence; fetch full UUIDs only when more detail is needed.${tag}\n${MEMORY_BLOCK_END}`);
  }
  const lines = data.results.map((row, index) => {
    const score = Number.isFinite(row.score) ? `${(row.score * 100).toFixed(0)}% match` : '';
    const tags = Array.isArray(row.tags) && row.tags.length ? row.tags.join(', ') : 'none';
    return `${index + 1}. [${row.category || 'memory'} | importance ${row.importance ?? '?'}${score ? `, ${score}` : ''}] ${row.content}\n   Tags: ${tags}`;
  });
  return withNudge([MEMORY_BLOCK_START, ...lines, `These memories may be relevant. Use as context — call recall for deeper search if needed.${tag}`, MEMORY_BLOCK_END].join('\n'));
}

function extractMemoryId(rememberResult) {
  const text = Array.isArray(rememberResult?.content)
    ? rememberResult.content.map((block) => block?.text || '').join('\n')
    : String(rememberResult?.text || rememberResult || '');
  const match = /\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i.exec(text);
  return match ? match[1] : null;
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+\n/g, '\n').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param {object} deps
 * @param {(body:object)=>Promise<object>} [deps.hookRecall]
 * @param {(args:object)=>Promise<object>} [deps.rememberFn]   MCP handleRemember-compatible
 * @param {(runId:string)=>boolean} [deps.memoryStoredForRun]  true when a memory with source_ref=runId exists
 * @param {(runId:string)=>string|null} [deps.findMemoryForRun]  id of a live memory with source_ref=runId, or null
 * @param {(name:string, description:string, parent?:string)=>Promise<void>|void} [deps.ensureCategoryFn]
 * @param {(cwd:string)=>string} [deps.detectProject]
 * @param {object} [deps.config]  { autoRecall, tokenBudget, limit, minScore, recallBudgetMs, autoRemember, category, parentCategory }
 * @param {object} [deps.judge]   createAssistantJev() — { promptUrgency, annotate, retryAfterMs }; null = no Jev
 */
export function createAssistantMemory({
  hookRecall = defaultHookRecall,
  rememberFn = null,
  memoryStoredForRun = () => false,
  findMemoryForRun = null,
  ensureCategoryFn = null,
  detectProject = () => 'global',
  config = {},
  log = () => {},
  judge = null,
} = {}) {
  const settings = {
    autoRecall: config.autoRecall !== false,
    tokenBudget: Math.max(100, Math.min(600, Number(config.tokenBudget) || 600)),
    autoRemember: config.autoRemember !== false,
    category: String(config.category || 'agent-runs'),
    parentCategory: String(config.parentCategory || 'automation'),
    minScore: Number.isFinite(Number(config.minScore)) ? Number(config.minScore) : 0.4,
    limit: Math.max(1, Math.min(10, Number(config.limit) || 3)),
    // Upper bound on what the gate adds to a turn: the urgency judgment and the ranking share it.
    recallBudgetMs: Math.max(500, Math.min(5000, Number(config.recallBudgetMs) || 2500)),
  };
  let categoryEnsured = false;

  const none = (skipped, extra = {}) => ({ block: '', results: [], alreadyPresent: false, skipped, decision: null, urgency: null, ...extra });
  function annotateUrgency(u, outcome) {
    if (!u?.logId) return;
    try { judge?.annotate?.(u.logId, outcome); } catch { /* diagnostics */ }
  }
  /** skip ≥ 0.5 skips (a weaker skip is a consider); no judgment → the skip regex, else should. */
  function decide(u, text) {
    if (u?.urgency) {
      if (u.urgency === 'skip') return (Number(u.confidence) || 0) >= 0.5 ? { decision: 'skip', fallback: false } : { decision: 'consider', fallback: false };
      if (u.urgency === 'must' || u.urgency === 'should' || u.urgency === 'consider') return { decision: u.urgency, fallback: false };
    }
    return shouldSkipRecall(text) ? { decision: 'skip', fallback: true } : { decision: 'should', fallback: true };
  }
  /** Nothing to inject, whether deferred (candidates after the floor) or rendered (results). */
  function emptyRecall(data) {
    if (!data || data.already_present) return false;
    if (data.deferred) return Number(data.candidates) === 0;
    return !(Array.isArray(data.results) && data.results.length);
  }

  /**
   * One user turn's memories.
   *  1. Free pre-filter: system text (mailbox, router stamp, task notices…)
   *     and trivial prompts cost no judgment and no search.
   *  2. Jev's prompt-urgency judgment and a ranked, floored recall run in
   *     parallel (both bounded by `recallBudgetMs`).
   *  3. A confident skip returns at once; so does a recall with nothing left
   *     after the floor. The other side finishes in the background.
   *  4. The urgency sizes the injection (consider / should / must); without a
   *     judgment the old skip regex decides, else `should`.
   * → { block, results, alreadyPresent, skipped, decision, urgency }
   */
  async function recallForPrompt({ prompt, project, session, generation, tokenBudget } = {}) {
    if (!settings.autoRecall) return none('disabled');
    const origin = classifyTurn(prompt);
    if (origin.origin === 'system') return none('system');
    const text = String(origin.text || '').trim();
    if (!text || isTrivialTurn(text)) return none('trivial');
    const projectLabel = project && project !== 'global' ? project : null;
    const limits = { limit: settings.limit, tokenBudget: tokenBudget || settings.tokenBudget };
    let inRetryAfter = false;
    try { inRetryAfter = Number(judge?.retryAfterMs?.()) > 0; } catch { inRetryAfter = false; }
    let canJudge = typeof judge?.promptUrgency === 'function';
    try { if (canJudge && typeof judge.available === 'function') canJudge = !!judge.available(); } catch { canJudge = false; }
    // No judgment to ask (Jev off, no key, retry-after, stale dist): today's rule, before any search.
    if (!canJudge && shouldSkipRecall(text)) return none('pattern', { decision: 'skip' });
    const body = {
      query: text.slice(0, 2000),
      project: projectLabel || undefined,
      // An older hookRecall without `defer` renders exactly today's request (should tier).
      limit: limits.limit,
      min_score: settings.minScore,
      token_budget: limits.tokenBudget,
      format: 'compact',
      caller: 'assistant',
      session: session || undefined,
      context_generation: generation || undefined,
      surface: 'rerank',
      floor: true,
      budget_ms: settings.recallBudgetMs,
    };
    // A 429 is pending: no ranking and no retrieval judgment either.
    if (inRetryAfter) body.judge = false;
    const urgencyP = canJudge
      ? Promise.resolve().then(() => judge.promptUrgency({ prompt: clipForJudge(text), project: projectLabel, sessionId: session || null, timeoutMs: settings.recallBudgetMs })).catch(() => null)
      : Promise.resolve(null);
    const recallP = Promise.resolve().then(() => hookRecall(body, undefined, { origin: 'assistant', defer: true }))
      .then((data) => ({ data }), (error) => ({ error }));
    const release = (settled) => { try { if (settled?.data?.deferred) settled.data.finish?.(null); } catch { /* nothing committed */ } };

    // Early exits: whichever side settles first may already decide the turn.
    const first = await Promise.race([
      urgencyP.then((u) => ({ side: 'urgency', u })),
      recallP.then((r) => ({ side: 'recall', r })),
    ]);
    if (first.side === 'urgency') {
      const { decision, fallback } = decide(first.u, text);
      if (decision === 'skip') {
        // Never wait for a recall the judgment already declined; it is withheld, not committed.
        recallP.then(release);
        annotateUrgency(first.u, { decision, fallback, tier: null, injected: [] });
        return none(fallback ? 'pattern' : 'judged', { decision, urgency: first.u?.urgency || null });
      }
    } else if (first.r.data && emptyRecall(first.r.data)) {
      release(first.r);
      urgencyP.then((u) => annotateUrgency(u, { decision: 'nothing-retrieved', fallback: !u?.urgency, tier: null, injected: [] }));
      return none('nothing-retrieved');
    }
    const [u, settled] = await Promise.all([urgencyP, recallP]);
    const { decision, fallback } = decide(u, text);
    if (settled.error) {
      log('recall-error', settled.error?.message || String(settled.error));
      annotateUrgency(u, { decision, fallback, tier: null, injected: [], error: 'recall' });
      return none('error', { decision, urgency: u?.urgency || null });
    }
    const data = settled.data;
    if (decision === 'skip') {
      release(settled);
      annotateUrgency(u, { decision, fallback, tier: null, injected: [] });
      return none(fallback ? 'pattern' : 'judged', { decision, urgency: u?.urgency || null });
    }
    const tier = recallTier(decision, limits);
    let view = data;
    try { if (data?.deferred && typeof data.finish === 'function') view = data.finish(tier); }
    catch (error) { log('recall-error', error?.message || String(error)); view = null; }
    const results = Array.isArray(view?.results) ? view.results : [];
    const block = formatMemoryBlock(view, { nudge: decision === 'must' ? MUST_RECALL_NUDGE : '' });
    annotateUrgency(u, { decision, fallback, tier: tier.name, injected: results.map((row) => row.id).filter(Boolean) });
    return { block, results, alreadyPresent: !!view?.already_present, skipped: null, decision, urgency: u?.urgency || null };
  }

  /**
   * Claude Agent SDK hook matchers for the assistant brain.
   * ctx: { session (assistant id), project, getGeneration, bumpGeneration,
   *        hasPendingObligations(), markRemembered(), onRecall(result),
   *        describeTurn(text) → { system, prompt } | null (the runtime's record
   *        of the turn it sent: the mailbox / router text is system, and a
   *        router-stamped prompt recalls on the user's own words) }
   */
  function claudeHooks(ctx = {}) {
    const state = { nudgedTurn: false };
    const hooks = {
      UserPromptSubmit: [{
        hooks: [async (input) => {
          state.nudgedTurn = false;
          const raw = typeof input?.prompt === 'string' ? input.prompt : '';
          let meta = null;
          try { meta = ctx.describeTurn?.(raw) || null; } catch { meta = null; }
          if (meta?.system) return {};
          const recalled = await recallForPrompt({
            prompt: meta?.prompt ?? raw, project: ctx.project, session: ctx.session, generation: ctx.getGeneration?.(),
          });
          try { ctx.onRecall?.(recalled); } catch {}
          if (!recalled.block) return {};
          return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: recalled.block } };
        }],
      }],
      PreCompact: [{
        hooks: [async () => { try { ctx.bumpGeneration?.(); } catch {} return {}; }],
      }],
      PostToolUse: [{
        matcher: 'mcp__SynaBun__remember|mcp__SynaBun__reflect|SynaBun_remember|SynaBun_reflect',
        hooks: [async () => { try { ctx.markRemembered?.(); } catch {} return {}; }],
      }],
      Stop: [{
        hooks: [async (input) => {
          if (input?.stop_hook_active || state.nudgedTurn) return {};
          let pending = false;
          try { pending = !!ctx.hasPendingObligations?.(); } catch {}
          if (!pending) return {};
          state.nudgedTurn = true;
          return {
            decision: 'block',
            reason: 'SynaBun: store what was accomplished with remember (category + project + related_files) before finishing — one memory per completed dispatch or workflow, then the summary.',
          };
        }],
      }],
    };
    return hooks;
  }

  async function ensureCategory() {
    if (categoryEnsured) return;
    categoryEnsured = true;
    if (typeof ensureCategoryFn !== 'function') return;
    try {
      await ensureCategoryFn(settings.category,
        'Outcomes of tasks dispatched by the SynaBun assistant to worker agents (provider, model, result, changed files). Store here automatically after a dispatched run completes.',
        settings.parentCategory);
    } catch (error) {
      log('ensure-category-error', error?.message || String(error));
    }
  }

  /**
   * Deterministic memory for a completed dispatch. `view` is the dispatcher's
   * run view: { runId, title, task, provider, model, accountId, cwd, project,
   * status, completionReason, lastResult, costUsd, elapsedMs, tags }.
   * Returns the memory id, or null when skipped/failed.
   */
  async function rememberDispatch(view = {}) {
    if (!settings.autoRemember || typeof rememberFn !== 'function' || !view?.runId) return null;
    try { if (memoryStoredForRun(view.runId)) return null; } catch {}
    const result = view.lastResult || {};
    const status = result.status || view.status || 'unknown';
    const project = view.project || (view.cwd ? detectProject(view.cwd) : 'global') || 'global';
    const files = Array.isArray(result.files) ? result.files.slice(0, 20) : [];
    const changes = Array.isArray(result.changes) ? result.changes.slice(0, 12) : [];
    const followUps = Array.isArray(result.follow_ups) ? result.follow_ups.slice(0, 8) : [];
    const elapsed = Number.isFinite(view.elapsedMs) ? `${Math.round(view.elapsedMs / 1000)}s` : 'n/a';
    const cost = Number.isFinite(view.costUsd) && view.costUsd > 0 ? `$${view.costUsd.toFixed(2)}` : 'n/a';
    const lines = [
      `[Dispatch] ${clip(view.title || view.task, 80)} via ${view.provider}${view.model ? `/${view.model}` : ''}${view.accountId && view.accountId !== 'default' ? ` (account ${view.accountId})` : ''} on ${project}.`,
      `What: ${clip(result.summary || 'No result summary provided.', 900)}`,
      `Task: ${clip(view.task, 400)}`,
      changes.length ? `Changes: ${changes.map((change) => `${change.path}${change.note ? ` (${change.note})` : ''}`).join('; ')}` : 'Changes: none reported',
      `Outcome: ${status}${view.completionReason ? ` (${view.completionReason})` : ''} in ${elapsed}, cost ${cost}. Follow-ups: ${followUps.length ? followUps.join('; ') : 'none'}.`,
      `Run id: ${view.runId}`,
    ];
    await ensureCategory();
    const tags = ['agent-run', String(view.provider || 'agent'), ...(Array.isArray(view.tags) ? view.tags : [])]
      .map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
    const args = {
      content: lines.join('\n'),
      category: settings.category,
      project,
      tags: [...new Set(tags)].slice(0, 8),
      importance: status === 'done' ? 5 : 6,
      source: 'auto-saved',
      kind: 'note',
      related_files: files,
      source_ref: view.runId,
      idempotency_key: `dispatch:${view.runId}`,
    };
    try {
      const stored = await rememberFn(args);
      return extractMemoryId(stored);
    } catch (error) {
      log('remember-dispatch-error', error?.message || String(error));
      return null;
    }
  }

  /** The memory already stored for a dispatched run (source_ref = run id), or null. */
  function memoryForRun(runId) {
    if (!runId || typeof findMemoryForRun !== 'function') return null;
    try { return findMemoryForRun(String(runId)) || null; } catch { return null; }
  }

  return { recallForPrompt, claudeHooks, rememberDispatch, memoryForRun, settings, shouldSkipRecall, formatMemoryBlock };
}
