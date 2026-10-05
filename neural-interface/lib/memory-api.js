import { Router } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { retrieveMemory, compactRecall, excerpt, estimateTokens } from '../../mcp-server/dist/services/memory-retrieval.js';
import { getDb, updatePayload, softDeleteMemory } from '../../mcp-server/dist/services/sqlite.js';
import { maintenanceStatus, pauseMaintenance, memoryHistory, memoryRevision, undoRevision, setRelation } from '../../mcp-server/dist/services/memory-maintenance.js';
import {
  judgePromptTurn, judgeAgentMessage, judgeRelevance, judgeStopTurn, judgeLoopGoal, judgeCompactDigest, judgePlanConflicts,
  orderByJudgedScore, relevanceLevel, RELEVANCE_CANDIDATE_CLIP,
} from '../../mcp-server/dist/services/memory-judgments.js';
import { triageMemories, MAX_TRIAGE_LIMIT } from '../../mcp-server/dist/services/memory-triage.js';
import {
  judge, noul, typesafeStats, typesafeKeyInfo, typesafeBaseUrl, typesafeEnabled, resetTypeSafeKey,
  clearTypeSafeCache, resetTypeSafeMetrics,
} from '../../mcp-server/dist/services/typesafe.js';
import {
  typesafeConfig, invalidateTypeSafeConfig, mutateTypeSafeConfig, validateTypeSafeConfigPatch, surfaceConfig,
  readTypeSafeLog, typesafeLogCount, typesafeLogStats, typesafeSessions, annotateTypeSafeLog, cleanSessionId, redactCredentials,
  SURFACES, SURFACE_META, ORIGINS, KNOWN_MODELS, DEFAULT_BASE_URL,
} from '../../mcp-server/dist/services/typesafe-config.js';
import { noteEdit, takeStaleVerdicts, flushEditChecks } from '../../mcp-server/dist/services/edit-stale.js';
import { detectProject } from '../../mcp-server/dist/config.js';
import { browserAssistView, resetBrowserAssistCounters } from '../../mcp-server/dist/services/browser-assist-gate.js';
import { runBrowserBench, recordBrowserBenchRun } from '../../mcp-server/dist/services/browser-bench.js';
import { desktopAssistView, resetDesktopAssistCounters } from '../../mcp-server/dist/services/desktop-assist-gate.js';
import { runDesktopBench, recordDesktopBenchRun } from '../../mcp-server/dist/services/desktop-bench.js';
import { backfillStatus, controlBackfill, judgedCoverage } from '../../mcp-server/dist/services/memory-judge-backfill.js';
import { runBench, recordBenchRun, BENCH_SURFACES } from '../../mcp-server/dist/services/typesafe-bench.js';

// Whether this process was launched from a shell that exported the key. A
// key saved through the settings page updates process.env too, so the two
// agree until the next restart — at which point the export wins again. The
// page has to say that, or "Save" looks like it silently failed later.
const LAUNCH_SHELL_KEY = process.env.TYPESAFE_API_KEY?.trim() || null;

const EMPTY_SURFACE_METRICS = { calls: 0, hits: 0, failures: 0, cached: 0, skipped: 0, inputTokens: 0, outputTokens: 0, totalMs: 0, avgMs: 0 };

/** Everything the Judgments tab renders, in one shape. Never includes the key. */
export function typesafeConfigView() {
  invalidateTypeSafeConfig();
  const cfg = typesafeConfig();
  const key = typesafeKeyInfo();
  const base = typesafeBaseUrl();
  const stats = typesafeStats();
  const surfaces = {};
  for (const name of SURFACES) surfaces[name] = { ...cfg.surfaces[name], ...SURFACE_META[name], metrics: stats.surfaces[name] ?? EMPTY_SURFACE_METRICS };
  return {
    ok: true,
    enabled: typesafeEnabled(), killSwitch: stats.killSwitch, masterEnabled: cfg.enabled,
    hasKey: key.hasKey, maskedKey: key.last4 ? `***${key.last4}` : null, keySource: key.source, shadowed: key.shadowed,
    launchShellExport: Boolean(LAUNCH_SHELL_KEY),
    baseUrl: base.url, baseUrlSource: base.source, baseUrlShadowed: base.shadowed, configuredBaseUrl: cfg.baseUrl, baseUrlDefault: DEFAULT_BASE_URL,
    model: cfg.model, models: KNOWN_MODELS.includes(cfg.model) ? KNOWN_MODELS : [...KNOWN_MODELS, cfg.model],
    defaultTimeoutMs: cfg.defaultTimeoutMs, backfillConcurrency: cfg.backfillConcurrency,
    costPerMillionInput: cfg.costPerMillionInput, costPerMillionOutput: cfg.costPerMillionOutput,
    applyJudgedImportance: cfg.applyJudgedImportance, applyMinConfidence: cfg.applyMinConfidence,
    benchRunAt: cfg.benchRunAt, bench: cfg.bench,
    browserAssist: browserAssistView(cfg),
    desktopAssist: desktopAssistView(cfg),
    surfaces, stats, backfill: backfillStatus(), coverage: judgedCoverage(), logCount: typesafeLogCount(),
    logStats: typesafeLogStats(), origins: [...ORIGINS], supersessions: { active: activeSupersessionCount() },
    updatedAt: cfg.updatedAt,
  };
}

function activeSupersessionCount() {
  try { return Number(getDb().prepare("SELECT count(*) AS n FROM memory_relations WHERE kind='supersedes' AND automatic=1 AND active=1").get()?.n || 0); } catch { return 0; }
}

/**
 * Who is asking, for the judgment log: the Claude session and project a hook
 * request comes from. The hooks send `session_id` (older ones only
 * `claudeSessionId`) and `cwd`; the project is resolved the way the MCP
 * server resolves it, from the registry.
 */
export function hookContext(body = {}) {
  const sessionId = cleanSessionId(body.session_id) ?? cleanSessionId(body.claudeSessionId) ?? cleanSessionId(body.session) ?? null;
  let project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : null;
  if (!project && typeof body.cwd === 'string' && body.cwd.trim()) { try { project = detectProject(body.cwd.trim()); } catch { project = null; } }
  return { origin: 'hook', sessionId, project };
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

// Suppress only automated context whose delivery is scoped to a known context
// generation. Plain clients/manual recall remain stateless and repeatable.
const injections = new Map();
export function filterInjected(results, { caller, session, generation } = {}, commit = true) {
  if (!caller || !session || !generation) return results;
  const key = JSON.stringify([caller,session,generation]);
  let seen = injections.get(key);
  if (!seen) { seen = new Set(); injections.set(key,seen); }
  if (injections.size > 500) injections.delete(injections.keys().next().value);
  const fresh = results.filter(r=>!seen.has(`${r.id}:${r.revision}`));
  if(commit)for (const r of fresh) seen.add(`${r.id}:${r.revision}`);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  return fresh;
}
function input(body) {
  if (typeof body?.query !== 'string' || !body.query.trim() || body.query.length > 16000) throw new Error('query must be non-empty text of at most 16000 characters.');
  const out = {query:body.query};
  for (const key of ['project','category','currentProject']) if (body[key] !== undefined) {
    if (typeof body[key] !== 'string' || !body[key]) throw new Error(`${key} must be text.`);
    out[key]=body[key];
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 50 || body.tags.some(t=>typeof t !== 'string')) throw new Error('tags must be an array of strings.');
    out.tags=body.tags;
  }
  for (const [key,min,max] of [['limit',1,50],['min_score',0,1],['min_importance',0,10]]) if (body[key] !== undefined) {
    const n=Number(body[key]); if (!Number.isFinite(n) || n<min || n>max || (key!=='min_score' && !Number.isInteger(n))) throw new Error(`Invalid ${key}.`);
    out[key]=n;
  }
  for (const [key,allowed] of [['scope',['all','project']],['tag_match',['any','all']]]) if (body[key] !== undefined) {
    if (!allowed.includes(body[key])) throw new Error(`Invalid ${key}.`); out[key]=body[key];
  }
  for (const key of ['after','before']) if(body[key]!==undefined) {
    if (typeof body[key]!=='string' || !Number.isFinite(Date.parse(body[key]))) throw new Error(`Invalid ${key}.`);
    out[key]=new Date(body[key]).toISOString();
  }
  if(out.after && out.before && out.after>out.before)throw new Error('after must not be later than before.');
  return out;
}

// A short follow-up referring to existing context is not a fresh search topic.
// Preserve explicit filenames, paths, error codes, and camelCase identifiers.
export function isReferentialFollowup(query) {
  const words = query.trim().split(/\s+/);
  if (words.length > 12 || /(?:[\w-]+[./:][\w/-]+|[A-Z][A-Z0-9_]{2,}|[a-z][A-Z][a-z]|\w*\d\w*)/.test(query)) return false;
  return /\b(?:that|this|it|those|there|isso|esse|essa|aquilo)\b/i.test(query)
    && /\b(?:better|best|same|instead|setting|settings|option|options|melhor|mesmo)\b/i.test(query);
}

/**
 * Judgments for the Claude Code hooks. The hooks are per-event processes and
 * the API key belongs server-side, so they ask here rather than calling
 * TypeSafe themselves — the same reason /hook-recall exists.
 *
 * Always resolves. An empty object means "no judgment available"; the hook
 * then falls back to its own regex rules.
 */
export async function hookJudge(body = {}, retrieve = retrieveMemory) {
  if (!body || typeof body !== 'object' || body.judge === false) return {};
  // Kill switch first: a session that opted out (or a test) never opens the store.
  if (!typesafeEnabled()) return {};
  const ctx = hookContext(body);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (body.kind === 'compact-digest') return compactDigest(body, ctx);
  if (!text || text.length > 16000) return {};
  if (body.kind === 'prompt') return promptTurn(text, body, ctx);
  if (body.kind === 'plan-conflict') return planConflict(text, body, ctx, retrieve);
  if (body.kind === 'agent-message') {
    const verdict = await judgeAgentMessage(text);
    return verdict ?? {};
  }
  if (body.kind === 'stop-turn') return stopTurn(text, body, ctx);
  if (body.kind === 'loop-goal') {
    const iteration = Number(body.iteration) || 0, total = Number(body.total) || 0;
    // After the final iteration there is nothing left for "stop early" to save.
    if (total > 0 && iteration >= total) return {};
    const p = await judgeLoopGoal({
      task: typeof body.task === 'string' ? body.task : '',
      context: typeof body.context === 'string' ? body.context : null,
      journal: Array.isArray(body.journal) ? body.journal.slice(-5) : [],
      progressSummary: typeof body.progress_summary === 'string' ? body.progress_summary : null,
      lastMessage: text, iteration, total,
    }, ctx);
    if (p === null) return {};
    return { goalMet: p >= (surfaceConfig('loop-goal').minConfidence ?? 0.8), goalProbability: p };
  }
  return {};
}

/**
 * The prompt hook's questions in one request: urgency leads, and each rider
 * (task boundary, session lookup, user learning) is asked only when the hook
 * asked for it and its surface is on. Thresholds are the surfaces' knobs; the
 * raw probabilities go back beside the booleans.
 */
async function promptTurn(text, body, ctx) {
  const ask = body.ask && typeof body.ask === 'object' ? body.ask : {};
  const want = {
    urgency: surfaceConfig('prompt-urgency').enabled,
    newTask: ask.new_task === true && surfaceConfig('task-boundary').enabled,
    pastSession: ask.past_session === true && surfaceConfig('session-lookup').enabled,
    revealsPreference: ask.reveals_preference === true && surfaceConfig('user-learning').enabled,
  };
  const u = body.unsaved_work && typeof body.unsaved_work === 'object' ? body.unsaved_work : null;
  const unsavedWork = u ? {
    previousPrompt: typeof u.previous_prompt === 'string' ? u.previous_prompt : null,
    files: Array.isArray(u.files) ? u.files.filter(f => typeof f === 'string').slice(0, 10) : [],
    editCount: Number(u.edit_count) || 0,
  } : null;
  const verdict = await judgePromptTurn({ prompt: text, project: ctx.project ?? undefined, unsavedWork }, want, ctx);
  if (!verdict) return {};
  const out = {};
  if (verdict.urgency) { out.urgency = verdict.urgency; out.confidence = verdict.confidence; }
  const bar = (surface, fallback) => surfaceConfig(surface).minProbability ?? fallback;
  if (verdict.newTask !== undefined) { out.newTask = verdict.newTask >= bar('task-boundary', 0.6); out.newTaskProbability = verdict.newTask; }
  if (verdict.pastSession !== undefined) { out.pastSession = verdict.pastSession >= bar('session-lookup', 0.7); out.pastSessionProbability = verdict.pastSession; }
  if (verdict.revealsPreference !== undefined) { out.revealsPreference = verdict.revealsPreference >= bar('user-learning', 0.7); out.preferenceProbability = verdict.revealsPreference; }
  return out;
}

/**
 * The Stop hook's questions in one request. What ran in the turn (commands,
 * tool results) is redacted before it leaves the machine. The session's
 * edit-time stale checks are started now; whatever has finished by the time
 * the judgment answers rides back as `stale` (peeked, not delivered).
 */
async function stopTurn(text, body, ctx) {
  const claimAsked = body.ask && typeof body.ask === 'object' && body.ask.unsupported_claim === true;
  const ask = { agentMessage: surfaceConfig('agent-message').enabled, turnWorth: surfaceConfig('turn-worth').enabled, claimCheck: claimAsked && surfaceConfig('claim-check').enabled };
  const files = Array.isArray(body.files) ? body.files.filter(f => typeof f === 'string').slice(0, 20) : [];
  const commands = Array.isArray(body.bash_commands) ? body.bash_commands
    .filter(c => c && typeof c.command === 'string' && c.command.trim()).slice(-12)
    .map(c => ({ command: redactCredentials(c.command.slice(0, 300)), exit: typeof c.exit === 'string' ? c.exit : null, output_tail: typeof c.output_tail === 'string' ? redactCredentials(c.output_tail.slice(-500)) : null })) : [];
  const toolResults = Array.isArray(body.tool_results) ? body.tool_results
    .filter(t => t && typeof t.tool === 'string').slice(-6)
    .map(t => ({ tool: t.tool, is_error: Boolean(t.is_error), tail: typeof t.tail === 'string' ? redactCredentials(t.tail.slice(-500)) : null })) : [];
  if (ctx.sessionId) flushEditChecks(ctx.sessionId).catch(() => {});
  const worth = surfaceConfig('turn-worth');
  const verdict = await judgeStopTurn(
    { message: text, filesEdited: files, editCount: Number(body.edit_count) || 0, commands, toolResults },
    ask, { ...ctx, worthThreshold: worth.minConfidence ?? 0.35 },
  );
  const out = {};
  if (verdict) {
    for (const key of ['humanBlocker', 'waitingForUser', 'worthRemembering', 'worthProbability']) if (verdict[key] !== undefined) out[key] = verdict[key];
    if (verdict.worthProbability !== undefined) out.bashOnlyWorth = verdict.worthProbability >= (worth.bashOnlyMinProbability ?? 0.8);
    if (verdict.claimProbability !== undefined) {
      out.unsupportedClaim = verdict.claimProbability >= (surfaceConfig('claim-check').minProbability ?? 0.9);
      out.claimProbability = verdict.claimProbability;
    }
  }
  if (body.want_stale === true && ctx.sessionId) {
    const stale = takeStaleVerdicts(ctx.sessionId, { peek: true });
    if (stale.length) out.stale = stale;
  }
  return out;
}

const DIGEST_PRIORITY = { goal: 4, decision: 3, open_issue: 2, finding: 2, routine: 0 };

/**
 * Pick what a compaction memory should keep: label each candidate message,
 * then take the most informative per role (goals and decisions first), in
 * chronological order. An empty pick means "no judgment": the hook keeps its
 * first-N fallback.
 */
async function compactDigest(body, ctx) {
  const settings = surfaceConfig('compact-digest');
  if (!settings.enabled) return {};
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && Number.isInteger(m.i) && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(0, 48)
    .map(m => ({ i: m.i, role: m.role, text: redactCredentials(m.text.slice(0, 700)) }));
  if (!messages.length) return {};
  const logIds = [];
  const verdicts = await judgeCompactDigest(messages, { goal: typeof body.goal === 'string' ? redactCredentials(body.goal.slice(0, 1000)) : null },
    { ...ctx, maxItems: settings.maxItems ?? 40, onLogged: id => { if (id) logIds.push(id); } });
  if (!verdicts?.length) return {};
  const floor = settings.minConfidence ?? 0.5;
  const pickUser = clampInt(body.pick?.user, 1, 30, 10), pickAssistant = clampInt(body.pick?.assistant, 0, 10, 3);
  const roleOf = new Map(messages.map(m => [m.i, m.role]));
  const ranked = verdicts.filter(v => v.label !== 'routine' && v.confidence >= floor)
    .sort((a, b) => DIGEST_PRIORITY[b.label] - DIGEST_PRIORITY[a.label] || b.confidence - a.confidence);
  const picked = [];
  let users = 0, assistants = 0;
  for (const v of ranked) {
    const role = roleOf.get(v.i);
    if (role === 'user' && users < pickUser) { picked.push(v.i); users++; }
    else if (role === 'assistant' && assistants < pickAssistant) { picked.push(v.i); assistants++; }
  }
  picked.sort((a, b) => a - b);
  for (const id of logIds) annotateTypeSafeLog(id, { picked: picked.length, of: messages.length });
  return { labels: verdicts.map(v => ({ i: v.i, label: v.label, confidence: v.confidence })), picked };
}

/**
 * Does an approved plan go against something already decided in its project?
 * Candidates are the project's decisions and preferences retrieved against the
 * plan — never plans themselves, never superseded records. Advisory only.
 */
async function planConflict(text, body, ctx, retrieve) {
  const settings = surfaceConfig('plan-conflict');
  if (!settings.enabled || !ctx.project) return {};
  const exclude = new Set(Array.isArray(body.exclude_ids) ? body.exclude_ids.map(String) : []);
  const query = text.slice(0, 2000);
  const result = await retrieve({ query, project: ctx.project, limit: 12, min_score: 0.3, min_semantic_score: 0.45, include_sessions: false, judge: false });
  const kindOf = getDb().prepare('SELECT kind FROM memory_metadata WHERE memory_id=?');
  const decisions = result.results
    .filter(h => h.type === 'memory' && !exclude.has(h.id) && !h.flags?.includes('superseded') && !String(h.category).startsWith('plans'))
    .map(h => ({ hit: h, kind: kindOf.get(h.id)?.kind ?? null }))
    .filter(entry => entry.kind === 'decision' || entry.kind === 'preference')
    .slice(0, clampInt(settings.maxItems, 1, 20, 6));
  if (!decisions.length) return { checked: 0, conflicts: [] };
  let logId = null;
  const verdicts = await judgePlanConflicts(text,
    decisions.map(({ hit, kind }) => ({ id: hit.id, content: excerpt(hit.content, query, 1500), recordedAt: hit.created_at, kind })),
    { ...ctx, onLogged: id => { logId = id; } });
  if (!verdicts) return {};
  const floor = settings.minProbability ?? 0.75;
  const conflicts = decisions.filter(({ hit }) => (verdicts.get(hit.id) ?? 0) >= floor)
    .map(({ hit }) => ({ id: hit.id, probability: verdicts.get(hit.id), category: hit.category, created_at: hit.created_at, excerpt: excerpt(hit.content, query, 240) }));
  annotateTypeSafeLog(logId, { checked: decisions.length, conflicts: conflicts.map(c => c.id) });
  return { checked: decisions.length, conflicts };
}

// Token-budgeted, dedup-filtered recall used by the Claude Code hooks and by the
// assistant runtime (in-process). Returns the same JSON shape the /hook-recall
// route serves; throws on invalid input (the route swallows that into {results:[]}).
// The assistant passes { origin:'assistant', defer:true }: retrieval and ranking
// run now, but nothing is rendered or committed to the injection ledger until
// it calls finish(tier) with the size its prompt-urgency judgment chose;
// finish(null) withholds the memories. The HTTP route never passes options.
export async function hookRecall(body = {}, retrieve = retrieveMemory, { origin = null, defer = false } = {}) {
  const opts=input(body);
  const ctx=origin ? {...hookContext(body),origin} : hookContext(body);
  const judgeOff=body.judge === false;
  // `surface` implies ranking; `rank:true` alone keeps meaning brief-rank.
  const surface=body.surface==='rerank' || body.surface==='brief-rank' ? body.surface : body.rank===true ? 'brief-rank' : null;
  const floorWanted=body.floor===true;
  // Kill switch before any config read, so an opted-out session never opens the store.
  const canRank=Boolean(surface) && !judgeOff && typesafeEnabled() && surfaceConfig(surface).enabled;
  if (Array.isArray(body.stale_ack) && ctx.sessionId) takeStaleVerdicts(ctx.sessionId,{peek:true,ack:body.stale_ack.map(String)});
  const withStale=out=>{
    if (body.want_stale===true && ctx.sessionId) { const stale=takeStaleVerdicts(ctx.sessionId); if (stale.length) out.stale=stale; }
    return out;
  };
  const skipFollowup=()=>{
    const out=withStale({results:[],context:'',already_present:false,skipped:'referential-followup',estimated_tokens:0,ranked:false,rank_surface:null,judged:0,dropped:[],floor:null});
    return defer ? {...out,deferred:true,candidates:0,finish:()=>out} : out;
  };
  // A judged ranking decides relevance for follow-ups too; the regex is the
  // fallback for when there is no judgment to ask.
  if (!canRank && isReferentialFollowup(opts.query)) return skipFollowup();
  // rank: widen the shortlist, judge it for relevance to the query, then cut
  // back to `limit`. Fusion order is the fallback.
  const limit = opts.limit ?? 3;
  const started=Date.now();
  const result=await retrieve({...opts,limit:surface ? Math.max(limit, 10) : limit,min_score:opts.min_score ?? 0.4,
    min_semantic_score:Math.max(0.4,opts.min_score ?? 0.4),include_sessions:false,judge:!judgeOff,judgeContext:ctx});
  const budget=Math.max(100,Math.min(2000,Number(body.token_budget)||600));
  const identity={caller:body.caller,session:body.claudeSessionId || body.session,generation:body.context_generation};
  let candidates=filterInjected(result.results,identity,false);
  const alreadyPresent=result.results.length>0 && candidates.length===0;
  let ranked=false, scores=null, dropped=[], floor=null, logId=null;
  if (canRank && (candidates.length > 1 || (floorWanted && candidates.length === 1))) {
    const settings=surfaceConfig(surface);
    const remaining=Number(body.budget_ms)>0 ? Number(body.budget_ms)-(Date.now()-started)-50 : Infinity;
    const timeoutMs=Math.floor(Math.min(settings.timeoutMs,Number(body.rank_timeout_ms)||settings.timeoutMs,remaining));
    if (timeoutMs >= 250) {
      scores=await judgeRelevance(opts.query,candidates.map(r=>({id:r.id,content:excerpt(r.content,opts.query,RELEVANCE_CANDIDATE_CLIP)})),
        {...ctx,surface,single:floorWanted,timeoutMs,onLogged:id=>{logId=id;}});
      if (scores?.size) {
        candidates=orderByJudgedScore(candidates,scores);
        for (const r of candidates) if (scores.has(r.id) && Array.isArray(r.reasons)) r.reasons.push('judged relevance');
        ranked=true;
        if (floorWanted) {
          floor=settings.minScore ?? 1.5;
          dropped=candidates.filter(r=>scores.has(r.id) && scores.get(r.id)<floor).map(r=>({id:r.id,relevance:scores.get(r.id)}));
          const gone=new Set(dropped.map(d=>d.id));
          candidates=candidates.filter(r=>!gone.has(r.id));
        }
      }
    }
    if (!ranked && isReferentialFollowup(opts.query)) return skipFollowup();
  }
  // The first `lim` candidates that fit `tok` tokens (the classic path: limit / budget).
  const render=(lim,tok)=>{
    const pool=surface ? candidates.slice(0,lim) : candidates;
    const results=[];
    let tokens=40;
    for(const r of pool) {
      const row={id:r.id,revision:r.revision,score:r.score,category:r.category,project:r.project,
        semantic_score:r.semantic_score,passage_score:r.passage_score,keyword_coverage:r.keyword_coverage,fusion_score:r.fusion_score,
        content:excerpt(r.content,opts.query,300),tags:r.payload.tags,importance:r.payload.importance,
        created_at:r.created_at,related_files:r.payload.related_files};
      if (ranked && scores.has(r.id)) { row.relevance=scores.get(r.id); row.relevance_level=relevanceLevel(scores.get(r.id)); }
      tokens+=estimateTokens(JSON.stringify(row));
      if(tokens>tok)break;
      results.push(row);
    }
    const included=new Set(results.map(r=>r.id));
    const context=results.length ? compactRecall({...result,results:pool.filter(r=>included.has(r.id))},opts.query,Math.max(100,tok-60)) : '';
    const delivered=pool.filter(r=>context.includes(`[${r.id}]`));
    return {results,context,delivered};
  };
  // A judgment that logged and then failed (timeout, unreadable answer) leaves
  // `scores` null: the row is still annotated, with no candidates.
  const outcome=(extra)=>({surface,floor,
    candidates:scores ? [...scores].map(([id,relevance])=>({id,relevance,level:relevanceLevel(relevance)})) : [],
    ...extra,dropped:dropped.map(d=>d.id)});
  // Commit what was injected to the ledger, record it on the ranking's log row, shape the answer.
  const finalize=({results,context,delivered},extra={})=>{
    filterInjected(delivered,identity);
    if (logId) annotateTypeSafeLog(logId,outcome({injected:delivered.map(r=>r.id),...extra}));
    const out={results:results.filter(r=>delivered.some(h=>h.id===r.id)),context,already_present:alreadyPresent,
      estimated_tokens:estimateTokens(context),degraded:result.degraded,ranked,rank_surface:ranked ? surface : null,
      judged:scores?.size ?? 0,dropped,floor};
    if (ranked && !delivered.length && dropped.length) out.skipped='judged-irrelevant';
    return out;
  };
  if (!defer) return withStale(finalize(render(limit,budget)));
  // Deferred (the assistant): the caller sizes the injection from its urgency
  // judgment. finish runs once; finish(null) withholds and commits nothing, so
  // the next turn does not read these memories as "already supplied".
  let settled=null;
  const finish=(tier)=>{
    if (settled) return settled;
    if (!tier) {
      if (logId) annotateTypeSafeLog(logId,outcome({injected:[],withheld:'prompt-urgency'}));
      settled={results:[],context:'',already_present:false,estimated_tokens:0,degraded:result.degraded,ranked,
        rank_surface:ranked ? surface : null,judged:scores?.size ?? 0,dropped,floor,withheld:'prompt-urgency'};
      return settled;
    }
    const lim=Math.max(1,Math.min(50,Math.floor(Number(tier.limit))||limit));
    const tok=Math.max(100,Math.min(2000,Number(tier.tokenBudget)||budget));
    settled=withStale(finalize(render(lim,tok),{tier:tier.name ?? null,limit:lim,token_budget:tok}));
    return settled;
  };
  return {deferred:true,ranked,rank_surface:ranked ? surface : null,judged:scores?.size ?? 0,dropped,floor,
    already_present:alreadyPresent,degraded:result.degraded,candidates:candidates.length,finish};
}

/**
 * @param envPath / parseEnvFile / writeEnvFile — injected from server.js, which
 *   owns ~/.synabun/.env. `writeEnvFile` rewrites the whole file from `vars`,
 *   so every write here is read-modify-write.
 * @param benchDir — where bench reports are written (repo `benchmarks/`).
 */
export function createMemoryApi({ heartbeat = ()=>{}, invalidate = ()=>{}, retrieve = retrieveMemory, envPath = null, parseEnvFile = null, writeEnvFile = null, benchDir = null } = {}) {
  const router=Router();
  const fail = (res, error, status = 400) => res.status(status).json({ ok: false, error: error?.message || String(error) });

  // ── TypeSafe / Jev settings ──────────────────────────────────────────────
  router.get('/typesafe/config', (_req, res) => {
    try { res.json(typesafeConfigView()); } catch (error) { fail(res, error, 500); }
  });
  router.put('/typesafe/config', (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { apiKey, ...rest } = body;
      if (apiKey !== undefined) {
        if (typeof apiKey !== 'string') throw new Error('apiKey must be a string.');
        const value = apiKey.trim();
        // A masked value means "leave it alone" (the page sends the mask back
        // when the field was not touched); an empty string removes the key.
        if (!value.includes('*')) {
          if (!envPath || !parseEnvFile || !writeEnvFile) throw new Error('Key storage is not wired in this server.');
          if (value && !/^[A-Za-z0-9._~+/=-]{8,}$/.test(value)) throw new Error('apiKey has an unexpected format.');
          const vars = parseEnvFile(envPath);
          if (value) { vars.TYPESAFE_API_KEY = value; process.env.TYPESAFE_API_KEY = value; }
          else { delete vars.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY; }
          writeEnvFile(envPath, vars);
          resetTypeSafeKey();
        }
      }
      // Validate inside the write lock, against what is stored now: the gates
      // (judged importance, safe auto-heal) must not be judged against a copy
      // that can be three seconds older than a bench another process recorded.
      if (Object.keys(rest).length) mutateTypeSafeConfig(current => validateTypeSafeConfigPatch(rest, current));
      res.json(typesafeConfigView());
    } catch (error) { fail(res, error); }
  });
  router.post('/typesafe/test', async (_req, res) => {
    try {
      const stats = typesafeStats();
      if (!typesafeEnabled()) {
        const reason = stats.killSwitch ? 'SYNABUN_TYPESAFE=off kill switch is set' : !stats.masterEnabled ? 'the master switch is off' : 'no API key is configured';
        return res.json({ ok: false, reason });
      }
      const started = Date.now();
      let usage = null;
      const answers = await judge(
        { text: 'The deploy finished without errors and the service is back online.' },
        { completed: noul('Does `text` report that a task finished successfully?', { true: 'It reports a successful completion.', false: 'It reports a failure, a question, or something unrelated.' }) },
        { surface: 'connection-test', origin: 'ui', sessionId: null, project: null, noCache: true, onUsage: (u) => { usage = u; } },
      );
      if (!answers) return res.json({ ok: false, reason: typesafeStats().lastError || 'no answer', latencyMs: Date.now() - started });
      res.json({ ok: true, latencyMs: usage?.latencyMs ?? Date.now() - started, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, answer: answers, model: typesafeConfig().model, baseUrl: typesafeBaseUrl().url });
    } catch (error) { fail(res, error, 500); }
  });
  router.post('/typesafe/cache/clear', (_req, res) => { clearTypeSafeCache(); res.json({ ok: true, stats: typesafeStats() }); });
  router.post('/typesafe/metrics/reset', (_req, res) => { resetTypeSafeMetrics(); resetBrowserAssistCounters(); resetDesktopAssistCounters(); res.json({ ok: true, stats: typesafeStats() }); });

  router.post('/typesafe/backfill', (req, res) => {
    try {
      const { action, limit, project, confirm } = req.body || {};
      if (!['estimate', 'start', 'pause', 'resume', 'cancel'].includes(action)) throw new Error('action must be estimate, start, pause, resume or cancel.');
      const opts = { limit: limit === undefined || limit === null || limit === '' ? null : Number(limit), project: project ? String(project).trim() || null : null };
      if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new Error('limit must be a positive integer.');
      if (action === 'start' && confirm !== true) throw new Error('Start requires confirm:true after reviewing the estimate.');
      res.json({ ok: true, backfill: controlBackfill(action, opts) });
    } catch (error) { fail(res, error); }
  });
  router.get('/typesafe/backfill/status', (_req, res) => {
    try { res.json({ ok: true, backfill: backfillStatus() }); } catch (error) { fail(res, error, 500); }
  });

  let benchRunning = null;
  router.post('/typesafe/bench', async (req, res) => {
    try {
      const { surface, limit, project, sample, only } = req.body || {};
      if (surface !== 'browser' && surface !== 'desktop' && !BENCH_SURFACES.includes(surface)) throw new Error(`surface must be one of ${[...BENCH_SURFACES, 'browser', 'desktop'].join(', ')}.`);
      if (benchRunning) return res.status(409).json({ ok: false, error: `A ${benchRunning} bench is already running.` });
      if (!typesafeEnabled()) throw new Error('TypeSafe is not enabled: check the kill switch, the master switch and the API key.');
      benchRunning = surface;
      try {
        if (surface === 'browser') {
          // Labelled fixtures, production judgments. Always the configured model: a run under any
          // other model could not be recorded as this configuration's benchmark anyway.
          const report = await runBrowserBench({ only: ['target', 'page-state', 'social'].includes(only) ? only : null });
          let file = null;
          if (benchDir) {
            mkdirSync(benchDir, { recursive: true });
            file = join(benchDir, `typesafe-browser-${report.at.slice(0, 16).replace(':', '')}.json`);
            writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
          }
          const recorded = recordBrowserBenchRun(report, file);
          invalidateTypeSafeConfig();
          return res.json({ ok: true, surface, file, report, recorded, browserAssist: browserAssistView(typesafeConfig()) });
        }
        if (surface === 'desktop') {
          // Helper-shaped fixtures through the production candidate builder, judgment and eligibility.
          // Always the configured model, for the same reason as the browser bench.
          const report = await runDesktopBench();
          let file = null;
          if (benchDir) {
            mkdirSync(benchDir, { recursive: true });
            file = join(benchDir, `typesafe-desktop-${report.at.slice(0, 16).replace(':', '')}.json`);
            writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
          }
          const recorded = recordDesktopBenchRun(report, file);
          invalidateTypeSafeConfig();
          return res.json({ ok: true, surface, file, report, recorded, desktopAssist: desktopAssistView(typesafeConfig()) });
        }
        const report = await runBench(surface, {
          limit: Math.max(1, Math.min(200, Number(limit) || 50)),
          project: project ? String(project).trim() || undefined : undefined,
          sample: sample === 'recent' ? 'recent' : 'random',
        });
        let file = null;
        if (benchDir) {
          mkdirSync(benchDir, { recursive: true });
          // Timestamped so a run from the tab never overwrites the file a summary cites.
          file = join(benchDir, `typesafe-${surface}-${report.at.slice(0, 16).replace(':', '')}.json`);
          writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
        }
        const summary = recordBenchRun(report, file);
        invalidateTypeSafeConfig();
        res.json({ ok: true, surface, file, report, summary, benchRunAt: typesafeConfig().benchRunAt });
      } finally { benchRunning = null; }
    } catch (error) { fail(res, error); }
  });

  router.get('/typesafe/log', (req, res) => {
    try {
      const q = req.query || {};
      const str = key => (q[key] ? String(q[key]) : undefined);
      const rows = readTypeSafeLog({
        limit: Number(q.limit) || 50, surface: str('surface'), origin: str('origin'), entityId: str('entity'), before: str('before'),
        sessionId: str('session'), project: str('project'), after: str('after'), order: q.order === 'asc' ? 'asc' : 'desc',
      });
      res.json({ ok: true, rows, total: typesafeLogCount() });
    } catch (error) { fail(res, error, 500); }
  });
  // Sessions that asked for judgments: the Coding sessions view.
  router.get('/typesafe/sessions', (req, res) => {
    try {
      const q = req.query || {};
      res.json({ ok: true, rows: typesafeSessions({ since: q.since ? String(q.since) : undefined, project: q.project ? String(q.project) : undefined, limit: Number(q.limit) || 30 }) });
    } catch (error) { fail(res, error, 500); }
  });
  // Supersessions written by the judgment (surface supersession), for review:
  // Undo deactivates the relation (maintenance respects that from then on),
  // Keep turns it into a confirmed one.
  router.get('/typesafe/supersessions', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
      const d = getDb();
      const where = "r.kind='supersedes' AND r.automatic=1 AND r.active=1 AND f.trashed_at IS NULL AND t.trashed_at IS NULL";
      const rows = d.prepare(`SELECT r.id, r.from_id, r.to_id, r.created_at, r.automatic, f.project, f.category,
          substr(f.content,1,240) AS from_preview, substr(t.content,1,240) AS to_preview, f.created_at AS from_created_at, t.created_at AS to_created_at
        FROM memory_relations r JOIN memories f ON f.id=r.from_id JOIN memories t ON t.id=r.to_id WHERE ${where} ORDER BY r.created_at DESC LIMIT ?`).all(limit);
      const total = Number(d.prepare(`SELECT count(*) AS n FROM memory_relations r JOIN memories f ON f.id=r.from_id JOIN memories t ON t.id=r.to_id WHERE ${where}`).get()?.n || 0);
      res.json({ ok: true, rows, total });
    } catch (error) { fail(res, error, 500); }
  });
  router.post('/typesafe/supersessions/:id', (req, res) => {
    try {
      const { action } = req.body || {};
      const id = String(req.params.id);
      const d = getDb();
      if (!d.prepare("SELECT 1 FROM memory_relations WHERE id=? AND kind='supersedes'").get(id)) throw new Error('Supersession not found.');
      if (action === 'undo') d.prepare('UPDATE memory_relations SET active=0 WHERE id=?').run(id);
      else if (action === 'keep') d.prepare('UPDATE memory_relations SET automatic=0 WHERE id=?').run(id);
      else throw new Error('action must be undo or keep.');
      const row = d.prepare('SELECT from_id, to_id FROM memory_relations WHERE id=?').get(id);
      if (row) { invalidate(String(row.from_id)); invalidate(String(row.to_id)); }
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  // Memories whose judged category disagrees with the stored one (surface #3
  // records, never re-routes; this is where a person decides).
  router.get('/typesafe/category-checks', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
      const d = getDb();
      const where = 'm.trashed_at IS NULL AND md.category_judged IS NOT NULL AND md.category_judged != m.category';
      const rows = d.prepare(`SELECT m.id, m.project, m.category, md.category_judged, md.category_confidence, substr(m.content,1,240) AS preview, m.created_at
        FROM memory_metadata md JOIN memories m ON m.id=md.memory_id WHERE ${where} ORDER BY md.category_confidence DESC, m.created_at DESC LIMIT ?`).all(limit);
      const total = Number(d.prepare(`SELECT count(*) AS n FROM memory_metadata md JOIN memories m ON m.id=md.memory_id WHERE ${where}`).get()?.n || 0);
      res.json({ ok: true, rows, total });
    } catch (error) { fail(res, error, 500); }
  });
  router.post('/typesafe/category-checks/:id', async (req, res) => {
    try {
      const { action } = req.body || {};
      const id = String(req.params.id);
      const d = getDb();
      const row = d.prepare('SELECT m.id, m.category, md.category_judged FROM memories m JOIN memory_metadata md ON md.memory_id=m.id WHERE m.id=? AND m.trashed_at IS NULL').get(id);
      if (!row) throw new Error('Memory not found.');
      if (action === 'dismiss') {
        d.prepare('UPDATE memory_metadata SET category_judged=NULL, category_confidence=NULL WHERE memory_id=?').run(id);
      } else if (action === 'apply') {
        if (!row.category_judged) throw new Error('No judged category to apply.');
        await updatePayload(id, { category: String(row.category_judged) });
        d.prepare('UPDATE memory_metadata SET category=?, category_judged=NULL, category_confidence=NULL WHERE memory_id=?').run(String(row.category_judged), id);
        invalidate(id);
      } else throw new Error('action must be apply or dismiss.');
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });
  router.post('/search',async(req,res)=>{
    try {
      const opts=input(req.body);
      const result=await retrieveMemory({...opts,limit:opts.limit ?? 10,include_sessions:false,
        rerank:req.body?.rerank===true,judge:req.body?.judge!==false,judgeContext:{origin:'ui',sessionId:null,project:opts.project ?? null}});
      res.json({results:result.results.map(r=>({id:r.id,score:r.score,payload:r.payload,semantic_score:r.semantic_score,passage_score:r.passage_score,keyword_coverage:r.keyword_coverage,fusion_score:r.fusion_score})),query:opts.query,degraded:result.degraded});
    } catch(error) {res.status(400).json({error:error.message});}
  });
  router.post('/hook-recall',async(req,res)=>{
    try {
      if(req.body?.claudeSessionId)heartbeat(req.body.claudeSessionId);
      res.json(await hookRecall(req.body, retrieve));
    } catch {res.json({results:[]});}
  });
  router.post('/hook-judge',async(req,res)=>{
    try {res.json(await hookJudge(req.body, retrieve));} catch {res.json({});}
  });
  // An Edit/Write in a Claude Code session (post-remember hook). Answers at
  // once; memories that list the file are judged after a quiet period and the
  // verdicts ride back on the session's next hook-recall or stop-turn.
  router.post('/hook-edit',(req,res)=>{
    try {
      const b=req.body || {};
      const result=noteEdit({ sessionId:b.session_id, cwd:typeof b.cwd==='string' ? b.cwd : null, project:hookContext(b).project,
        filePath:typeof b.file_path==='string' ? b.file_path : '', tool:typeof b.tool==='string' ? b.tool : null,
        oldExcerpt:typeof b.old_excerpt==='string' ? b.old_excerpt : null, newExcerpt:typeof b.new_excerpt==='string' ? b.new_excerpt : null }, b.judge);
      res.status(result.scheduled ? 202 : 200).json({ok:true,...result});
    } catch {res.json({ok:true,scheduled:false,reason:'invalid'});}
  });
  router.get('/hook-edit/pending',(req,res)=>{
    try {
      const sid=cleanSessionId(req.query?.session_id);
      res.json({stale:sid ? takeStaleVerdicts(sid,{peek:req.query?.peek==='1' || req.query?.peek==='true'}) : []});
    } catch {res.json({stale:[]});}
  });
  // Trash triage (surface trash-triage): ranked forget candidates. The only
  // write to a memory is an explicit, reversible soft delete of one id; the
  // ranking itself only records its scores in memory_metadata.
  // ?stream=1 answers NDJSON: a line per judged batch, then the final ranking
  // with done:true. Once headers are out an error can only be a line — fail()
  // would throw, and an unhandled rejection takes the whole server down.
  router.get('/trash/candidates', async (req, res) => {
    const q = req.query || {};
    const options = { project: q.project ? String(q.project) : null, limit: Math.max(1, Math.min(MAX_TRIAGE_LIMIT, Number(q.limit) || 20)), origin: 'ui' };
    if (q.stream !== '1') {
      try { res.json({ ok: true, ...await triageMemories(options) }); } catch (error) { fail(res, error, 500); }
      return;
    }
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders();
    res.on('error', () => {});
    const line = (payload) => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(payload)}\n`); };
    try {
      const result = await triageMemories({ ...options, onProgress: (snapshot) => line({ ok: true, done: false, ...snapshot }) });
      line({ ok: true, done: true, ...result });
    } catch (error) {
      line({ ok: false, done: true, error: error?.message || String(error) });
    } finally {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  });
  // One human click per batch, the same reversible soft delete per id as the row button.
  router.post('/trash/candidates/trash-selected', async (req, res) => {
    try {
      const ids = req.body?.ids;
      if (!Array.isArray(ids)) throw new Error('ids must be an array of memory ids.');
      if (ids.length > 500) throw new Error('At most 500 ids per request.');
      const live = getDb().prepare('SELECT 1 FROM memories WHERE id=? AND trashed_at IS NULL');
      const skipped = [];
      let trashed = 0;
      for (const value of ids) {
        const id = String(value);
        if (!live.get(id)) { skipped.push(id); continue; }
        await softDeleteMemory(id);
        invalidate(id, 'memory:trashed');
        trashed++;
      }
      res.json({ ok: true, trashed, skipped });
    } catch (error) { fail(res, error); }
  });
  router.post('/trash/candidates/:id/trash', async (req, res) => {
    try {
      const id = String(req.params.id);
      if (!getDb().prepare('SELECT 1 FROM memories WHERE id=? AND trashed_at IS NULL').get(id)) throw new Error('Memory not found or already in the trash.');
      await softDeleteMemory(id);
      invalidate(id, 'memory:trashed');
      res.json({ ok: true, id });
    } catch (error) { fail(res, error); }
  });

  router.get('/memory-maintenance',(_req,res)=>{
    try { res.json({ ...maintenanceStatus(), backfill: backfillStatus() }); } catch (error) { fail(res, error, 500); }
  });
  router.post('/memory-maintenance',(req,res)=>{
    try {
      const {operation,id,from_id,to_id,kind}=req.body || {};
      if (operation==='pause' || operation==='resume') pauseMaintenance(operation==='pause');
      else if(operation==='retry')getDb().exec("UPDATE memory_jobs SET status='pending',attempts=0,error=NULL WHERE status='failed'");
      else if(operation==='undo-relation' && typeof id==='string')getDb().prepare('UPDATE memory_relations SET active=0 WHERE id=?').run(id);
      else if(operation==='confirm-relation' && ['supersedes','conflicts_with'].includes(kind)) {
        setRelation(String(from_id),String(to_id),kind);
        if(id)getDb().prepare('UPDATE memory_relations SET active=0 WHERE id=? AND automatic=1').run(id);
      } else throw new Error('Invalid maintenance operation.');
      res.json(maintenanceStatus());
    } catch(error){res.status(400).json({error:error.message});}
  });
  router.get('/memory/:id/history',(req,res)=>res.json({revision:memoryRevision(req.params.id),revisions:memoryHistory(req.params.id)}));
  router.post('/memory/:id/undo',(req,res)=>{
    try {
      const {revision,expected_revision}=req.body || {};
      if(!Number.isInteger(revision)||!Number.isInteger(expected_revision))throw new Error('revision and expected_revision are required integers.');
      const next=undoRevision(req.params.id,revision,expected_revision);
      invalidate(req.params.id);
      res.json({ok:true,revision:next});
    }catch(error){res.status(409).json({error:error.message});}
  });
  return router;
}
