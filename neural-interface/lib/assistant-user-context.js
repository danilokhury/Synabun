// ═══════════════════════════════════════════
// SynaBun — Assistant user context (the engine)
// ═══════════════════════════════════════════
//
// What makes the Assistant behave like someone who knows the user, whatever
// model is routed: knowledge of the user from past sessions and small nudges
// from recent interactions, all of it in SynaBun memory. The harness does the
// learning and the injection itself (no provider hook, no brain tokens spent
// on capture), and every turn says what it did in one `synabun.automation`
// event the side panel draws.
//
//   store     user-knowledge (one memory = one statement) and assistant-threads
//             (one memory per conversation); legacy communication-style
//             memories are read in place as seeds. Operational state only: the
//             frozen digest and the delivery ledgers on the session record,
//             nudged-item keys and the working threads in
//             assistant-user-context.json.
//   digest    ≤ 300 tokens, deterministic, appended to the persona (so every
//             brain gets it in its system-level slot), frozen byte for byte
//             per provider conversation.
//   per turn  ≤ 120 tokens on the first prompt, ≤ 80 later, nothing when there
//             is nothing to say: the last thread, an environment change, an
//             open item, one knowledge cue, a delta. Each said once.
//   learning  assistant-user-learn.js, after the turn, serialized per session.
//
// Everything heavy is injected (the store, Jev, the writer, the usage ledger),
// so the module is unit-testable and never opens the memory database itself.
// Nothing here throws into a turn: a failure is logged and the turn goes on
// without the layer.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CATEGORIES, CATEGORY_DESCRIPTIONS, DIGEST, LEARN, NUDGES, THREAD, TURN_BLOCK, estimateTokens, normalizeUserContext } from './assistant-user-context-budgets.js';
import { clipText, nearest, parseKnowledge, renderDigest, usableKnowledge } from './assistant-user-knowledge.js';
import { dropRun, isClosingTurn, lastThreadLine, newThread, noteAsk, noteRun, openItems, overlap, parseThread, threadContent, threadIsRecent } from './assistant-user-threads.js';
import { createUserLearner, prefilter, typedEvidence } from './assistant-user-learn.js';

export const AUTOMATION_EVENT = 'synabun.automation';
export const TURN_BLOCK_HEADER = 'SynaBun notes (background):';
const STATE_VERSION = 1;

const iso = (ms) => new Date(ms).toISOString();
const shortHash = (value) => createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 10);
const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);

/**
 * Why Jev cannot answer the learning loop right now, or null when it can (Settings → Automation
 * behavior says it next to "Knowledge of you"). The same order the client refuses in: the
 * environment's kill switch, the master switch, the key, the surface, a wait the API asked for.
 * @param {object} deps
 * @param {object} deps.typesafe  mcp-server services/typesafe.js ({ typesafeApiKey, typesafeRetryAfterMs })
 * @param {object} deps.knobs     mcp-server services/typesafe-config.js ({ typesafeMasterEnabled, surfaceConfig })
 * @returns {'kill-switch'|'master-off'|'no-key'|'surface-off'|'waiting'|'unavailable'|null}
 */
export function learningJudgeReason({ env = process.env, typesafe = null, knobs = null, surface = 'user-learning' } = {}) {
  try {
    if (env?.SYNABUN_TYPESAFE === 'off') return 'kill-switch';
    if (!typesafe || !knobs) return 'unavailable';
    if (!knobs.typesafeMasterEnabled()) return 'master-off';
    if (typesafe.typesafeApiKey() === null) return 'no-key';
    if (knobs.surfaceConfig(surface).enabled === false) return 'surface-off';
    if (typesafe.typesafeRetryAfterMs() > 0) return 'waiting';
    return null;
  } catch { return 'unavailable'; }
}

/** The branch checked out in `cwd` (or a parent), read from .git/HEAD: no process is started. null when unknown. */
export function readGitBranch(cwd) {
  try {
    let dir = resolve(String(cwd || ''));
    for (let depth = 0; depth < 16; depth += 1) {
      const dotGit = resolve(dir, '.git');
      if (existsSync(dotGit)) {
        let headPath = resolve(dotGit, 'HEAD');
        if (statSync(dotGit).isFile()) {
          // A worktree or a submodule: ".git" is a file that names the real directory.
          const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (!match) return null;
          headPath = resolve(dir, match[1].trim(), 'HEAD');
        }
        const head = readFileSync(headPath, 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1];
        return head ? `detached@${head.slice(0, 7)}` : null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* unreadable: unknown */ }
  return null;
}

// ── the store (SynaBun memory) ──────────────────────────────────────────────

function resultText(result) {
  if (Array.isArray(result?.content)) return result.content.map((block) => block?.text || '').join('\n');
  return String(result?.text ?? result ?? '');
}
const UUID_IN_BRACKETS = /\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

function toVector(blob) {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (!bytes.byteLength || bytes.byteLength % 4) return null;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/**
 * The engine's view of SynaBun memory. Reads go to SQLite directly (indexed by category, a few
 * hundred rows at most); writes go through the `remember` / `reflect` tool handlers, so their
 * duplicate and secret gates stay in place.
 * @param {object} deps
 * @param {() => object} deps.getDb                    node:sqlite handle of the memory database
 * @param {(args:object) => Promise<object>} deps.remember   MCP handleRemember
 * @param {(args:object) => Promise<object>} deps.reflect    MCP handleReflect
 * @param {(text:string) => Promise<ArrayLike<number>>} [deps.embed]  the local embedding model
 * @param {(name:string, description:string, parent:string, parentDescription:string) => void} [deps.ensureCategory]
 * @param {() => string[]} [deps.knowledgeCategories]  user-knowledge and the seed categories
 * @param {(sessionId:string|null, project:string|null, fn:Function) => any} [deps.withSession]
 *        runs a write so its write-time judgments are logged against the assistant session
 */
export function createUserContextStore({
  getDb, remember, reflect, embed = null, ensureCategory = null,
  knowledgeCategories = () => [CATEGORIES.knowledge, CATEGORIES.knowledgeParent],
  withSession = (_sessionId, _project, fn) => fn(),
  log = () => {},
} = {}) {
  let ensured = false;
  let cache = null; // { at, rows }
  const CACHE_MS = 5000;

  const categories = () => {
    let list = [];
    try { list = knowledgeCategories() || []; } catch { list = []; }
    const out = [...new Set([CATEGORIES.knowledge, ...list.map(String).filter(Boolean)])];
    return out.filter((name) => name !== CATEGORIES.threads);
  };
  const marks = (n) => Array.from({ length: n }, () => '?').join(',');

  /** The two categories, created on first use (lazily: nothing is created until something is stored). */
  function ensureCategories() {
    if (ensured) return true;
    if (typeof ensureCategory !== 'function') { ensured = true; return true; }
    try {
      ensureCategory(CATEGORIES.knowledge, CATEGORY_DESCRIPTIONS.knowledge, CATEGORIES.knowledgeParent, CATEGORY_DESCRIPTIONS.knowledgeParent);
      ensureCategory(CATEGORIES.threads, CATEGORY_DESCRIPTIONS.threads, CATEGORIES.threadsParent, CATEGORY_DESCRIPTIONS.threadsParent);
      ensured = true;
    } catch (error) { log('user-context:category-error', error?.message || String(error)); }
    return ensured;
  }

  /** Every live, not superseded memory of the knowledge categories, parsed, newest first. Cached for 5 s. */
  function listKnowledge({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
    const names = categories();
    let rows = [];
    try {
      const db = getDb();
      try {
        rows = db.prepare(`SELECT m.id, m.content, m.category, m.subcategory, m.project, m.importance, m.created_at, m.updated_at, m.related_memory_ids,
            md.kind, md.source_ref, (SELECT MAX(r.revision) FROM memory_revisions r WHERE r.memory_id = m.id) AS revision
          FROM memories m LEFT JOIN memory_metadata md ON md.memory_id = m.id
          WHERE m.trashed_at IS NULL AND m.category IN (${marks(names.length)})
            AND NOT EXISTS (SELECT 1 FROM memory_relations s WHERE s.kind = 'supersedes' AND s.active = 1 AND s.to_id = m.id)
          ORDER BY m.updated_at DESC LIMIT ?`).all(...names, DIGEST.readLimit);
      } catch {
        // A store without the v2 tables: the memories alone.
        rows = db.prepare(`SELECT id, content, category, subcategory, project, importance, created_at, updated_at, related_memory_ids
          FROM memories WHERE trashed_at IS NULL AND category IN (${marks(names.length)}) ORDER BY updated_at DESC LIMIT ?`).all(...names, DIGEST.readLimit);
      }
    } catch (error) { log('user-context:read-error', error?.message || String(error)); rows = []; }
    const parsed = rows.map((row) => parseKnowledge(row)).filter((item) => item.id && item.statement);
    cache = { at: Date.now(), rows: parsed };
    return parsed;
  }
  function invalidate() { cache = null; }

  /** id → the id of the memory that superseded it, for the ids given (active relations only). */
  function supersededBy(ids = []) {
    const list = [...new Set(ids.map(String).filter(Boolean))].slice(0, 200);
    const out = new Map();
    if (!list.length) return out;
    try {
      for (const row of getDb().prepare(`SELECT from_id, to_id FROM memory_relations WHERE kind = 'supersedes' AND active = 1 AND to_id IN (${marks(list.length)})`).all(...list)) out.set(String(row.to_id), String(row.from_id));
    } catch { /* no relations table: nothing was superseded */ }
    return out;
  }

  /** The known statements nearest to `text` (a local embedding search), usable for `project`, best first. */
  async function known(text, { project = 'global', limit = LEARN.knownStatements } = {}) {
    if (typeof embed !== 'function') return [];
    const all = usableKnowledge(listKnowledge(), { project });
    if (!all.length) return [];
    const names = categories();
    let vectors = [];
    try {
      vectors = getDb().prepare(`SELECT id, vector FROM memories WHERE trashed_at IS NULL AND category IN (${marks(names.length)}) ORDER BY updated_at DESC LIMIT ?`).all(...names, DIGEST.readLimit);
    } catch (error) { log('user-context:read-error', error?.message || String(error)); return []; }
    let query = null;
    try { query = await embed(String(text ?? '').slice(0, LEARN.messageClip)); } catch (error) { log('user-context:embed-error', error?.message || String(error)); return []; }
    const wanted = new Map(all.map((item) => [item.id, item]));
    const rows = vectors.filter((row) => wanted.has(String(row.id))).map((row) => ({ id: String(row.id), vector: toVector(row.vector) })).filter((row) => row.vector);
    return nearest(Array.from(query || []), rows, limit).map((hit) => ({ ...wanted.get(hit.id), similarity: hit.similarity }));
  }

  /** A new statement. → { id } | { duplicateOf } | { error } */
  async function create({ content, project = 'global', facet = 'expectations', kind = 'preference', sessionId = null, links = [], hash = null } = {}) {
    if (!ensureCategories()) return { error: 'no-category' };
    try {
      const stored = await withSession(sessionId, project, () => remember({
        content, category: CATEGORIES.knowledge, project: project || 'global', subcategory: facet, kind,
        tags: ['user-knowledge', facet, 'assistant-learned'], importance: 6, source: 'auto-saved',
        source_ref: sessionId ? `assistant-user:${sessionId}` : 'assistant-user',
        ...(hash ? { idempotency_key: `user-knowledge:${hash}` } : {}),
      }));
      const text = resultText(stored);
      const id = UUID_IN_BRACKETS.exec(text)?.[1] || null;
      invalidate();
      if (stored?.isError || !id) return { error: clipText(text || 'remember failed', 160) };
      if (/^Not stored/i.test(text)) return { duplicateOf: id };
      if (links.length) {
        try { await withSession(sessionId, project, () => reflect({ memory_id: id, related_memory_ids: links.map(String) })); }
        catch (error) { log('user-context:link-error', error?.message || String(error)); }
        invalidate();
      }
      return { id };
    } catch (error) { return { error: clipText(error?.message || String(error), 160) }; }
  }

  /** Rewrite a statement in place. → { ok } | { ok:false, error } */
  async function update(id, { content, expectedRevision = null, sessionId = null, project = null } = {}) {
    try {
      const args = { memory_id: String(id), content };
      if (Number(expectedRevision) > 0) args.expected_revision = Number(expectedRevision);
      const answer = await withSession(sessionId, project, () => reflect(args));
      const text = resultText(answer);
      invalidate();
      return answer?.isError || !/^Updated \[/.test(text) ? { ok: false, error: clipText(text || 'reflect failed', 160) } : { ok: true };
    } catch (error) { return { ok: false, error: clipText(error?.message || String(error), 160) }; }
  }

  /** `newId` supersedes `oldId` (a reversible relation; the old memory is not edited). */
  async function supersede(newId, oldId, { sessionId = null } = {}) {
    try {
      const answer = await withSession(sessionId, null, () => reflect({ memory_id: String(newId), supersedes: String(oldId) }));
      const text = resultText(answer);
      invalidate();
      return answer?.isError || !/^Updated \[/.test(text) ? { ok: false, error: clipText(text || 'reflect failed', 160) } : { ok: true };
    } catch (error) { return { ok: false, error: clipText(error?.message || String(error), 160) }; }
  }

  function threadMemoryFor(sessionId) {
    try {
      const db = getDb();
      const live = db.prepare('SELECT 1 FROM memories WHERE id = ? AND trashed_at IS NULL AND category = ?');
      for (const row of db.prepare('SELECT memory_id FROM memory_metadata WHERE source_ref = ?').all(`assistant-thread:${sessionId}`)) {
        if (live.get(row.memory_id, CATEGORIES.threads)) return String(row.memory_id);
      }
    } catch { /* no metadata table */ }
    return null;
  }

  /** Create the conversation's memory, or rewrite it in place. → { id } | { error } */
  async function writeThread({ sessionId, memoryId = null, content, project = 'global' } = {}) {
    if (!ensureCategories()) return { error: 'no-category' };
    try {
      let id = memoryId || threadMemoryFor(sessionId);
      if (id) {
        const answer = await withSession(sessionId, project, () => reflect({ memory_id: id, content }));
        const text = resultText(answer);
        if (!answer?.isError && /^Updated \[/.test(text)) return { id };
        // Gone (trashed or deleted by the owner): a fresh one below.
        if (!/not found/i.test(text)) return { error: clipText(text || 'reflect failed', 160) };
        id = null;
      }
      const stored = await withSession(sessionId, project, () => remember({
        content, category: CATEGORIES.threads, project: project || 'global', kind: 'session', subcategory: 'thread',
        tags: ['assistant-thread'], importance: 5, source: 'auto-saved', source_ref: `assistant-thread:${sessionId}`,
      }));
      const text = resultText(stored);
      const created = UUID_IN_BRACKETS.exec(text)?.[1] || null;
      if (stored?.isError || !created || /^Not stored/i.test(text)) return { error: clipText(text || 'remember failed', 160) };
      return { id: created };
    } catch (error) { return { error: clipText(error?.message || String(error), 160) }; }
  }

  /** The newest thread memories: [{ id, content, project, updated_at, revision }]. */
  function lastThreads({ limit = 5 } = {}) {
    try {
      const db = getDb();
      try {
        return db.prepare(`SELECT m.id, m.content, m.project, m.updated_at, (SELECT MAX(r.revision) FROM memory_revisions r WHERE r.memory_id = m.id) AS revision
          FROM memories m WHERE m.trashed_at IS NULL AND m.category = ? ORDER BY m.updated_at DESC LIMIT ?`).all(CATEGORIES.threads, limit);
      } catch {
        return db.prepare('SELECT id, content, project, updated_at FROM memories WHERE trashed_at IS NULL AND category = ? ORDER BY updated_at DESC LIMIT ?').all(CATEGORIES.threads, limit);
      }
    } catch { return []; }
  }

  return { ensureCategories, knowledgeCategories: categories, listKnowledge, invalidate, supersededBy, known, create, update, supersede, writeThread, lastThreads };
}

// ── the engine ──────────────────────────────────────────────────────────────

function freshDelivered() {
  return { opened: false, lastThread: false, cues: [], deltas: [], nudges: [] };
}

/** The session record's user-context state, made whole (older records, hand edits). */
export function userContextState(record) {
  const uc = record.userContext && typeof record.userContext === 'object' && !Array.isArray(record.userContext) ? record.userContext : (record.userContext = {});
  if (!uc.digest || typeof uc.digest !== 'object' || typeof uc.digest.text !== 'string') uc.digest = null;
  if (!uc.delivered || typeof uc.delivered !== 'object') uc.delivered = freshDelivered();
  for (const key of ['cues', 'deltas', 'nudges']) if (!Array.isArray(uc.delivered[key])) uc.delivered[key] = [];
  if (!uc.env || typeof uc.env !== 'object') uc.env = { branch: null, bootId: null, lastTurnAt: null };
  if (!uc.learn || typeof uc.learn !== 'object') uc.learn = { counts: { gate: 0, writer: 0, writes: 0 }, hashes: [] };
  if (!uc.learn.counts || typeof uc.learn.counts !== 'object') uc.learn.counts = { gate: 0, writer: 0, writes: 0 };
  if (!Array.isArray(uc.learn.hashes)) uc.learn.hashes = [];
  if (!Array.isArray(uc.learnedHere)) uc.learnedHere = [];
  if (!uc.totals || typeof uc.totals !== 'object') uc.totals = { turns: 0, injectedTokens: 0, learned: 0, jevRequests: 0, jevInputTokens: 0, writerCalls: 0, costUsd: 0 };
  return uc;
}

/**
 * @param {object} deps
 * @param {() => object} deps.settings       assistant-config.json `userContext` (read live)
 * @param {object} deps.store                createUserContextStore()
 * @param {{ ask: Function, available?: Function, reason?: Function } | null} [deps.judge]  Jev, surface `user-learning`
 *        (`reason()` names why it cannot answer: learningJudgeReason)
 * @param {{ write: Function, available?: Function } | null} [deps.writer]
 * @param {object | null} [deps.usage]       the usage ledger (the writer's tokens are settled there)
 * @param {(rows:object[], identity:{ session:string, generation:number }) => void} [deps.markInjected]
 *        the injection ledger Related Memories uses (memory-api.js filterInjected)
 * @param {(cwd:string) => string|null} [deps.readBranch]
 * @param {string} [deps.bootId]             this server process: a different one means SynaBun restarted
 * @param {string} [deps.statePath]          assistant-user-context.json
 */
export function createAssistantUserContext({
  settings = () => ({}), store = null, judge = null, writer = null, usage = null, markInjected = null,
  readBranch = readGitBranch, bootId = randomUUID(), statePath = null, rates = () => null,
  now = Date.now, log = () => {}, timers = { setTimeout, clearTimeout },
} = {}) {
  const learner = createUserLearner({ judge, writer, store, rates, now, log });
  const chains = new Map();       // sessionId → the learning under way (one at a time per session)
  const threadTimers = new Map(); // sessionId → the debounced thread write
  const cardGetters = new Map();  // sessionId → () => the cards left unanswered right now
  const installs = new Set();     // sessionIds whose brain was just built with the digest (the next trace shows its text)
  const lastThreads = new Map();  // sessionId → the open items of the thread offered at session open
  // How the statement writer's last one-shot went, since this server started (Settings says it): null = not tried yet.
  const health = { writer: null };
  let state = loadState();
  let stateTimer = null;
  let stopped = false;

  function layers() { return normalizeUserContext((() => { try { return settings(); } catch { return null; } })()); }

  // ── operational state file ──
  function loadState() {
    const empty = { version: STATE_VERSION, nudged: {}, threads: {} };
    if (!statePath) return empty;
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return empty;
      return { version: STATE_VERSION, nudged: raw.nudged && typeof raw.nudged === 'object' ? raw.nudged : {}, threads: raw.threads && typeof raw.threads === 'object' ? raw.threads : {} };
    } catch { return empty; }
  }
  function saveStateNow() {
    if (stateTimer) { timers.clearTimeout(stateTimer); stateTimer = null; }
    if (!statePath) return;
    const nudged = Object.entries(state.nudged).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, NUDGES.nudgedKept);
    state.nudged = Object.fromEntries(nudged);
    const threads = Object.values(state.threads).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || ''))).slice(0, NUDGES.threadsKept);
    state.threads = Object.fromEntries(threads.map((thread) => [thread.sessionId, thread]));
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      renameSync(tmp, statePath);
    } catch (error) { log('user-context:state-error', error?.message || String(error)); }
  }
  function saveState() {
    if (stateTimer || stopped) return;
    stateTimer = timers.setTimeout(() => { stateTimer = null; saveStateNow(); }, 500);
    stateTimer?.unref?.();
  }
  const nudgeKey = (sessionId, text) => `open:${sessionId}:${shortHash(String(text ?? '').toLowerCase())}`;
  const wasNudged = (key) => Object.prototype.hasOwnProperty.call(state.nudged, key);
  function markNudged(uc, key) {
    state.nudged[key] = now();
    uc.delivered.nudges = [...uc.delivered.nudges.filter((k) => k !== key), key].slice(-100);
    saveState();
  }

  // ── digest ──
  function buildDigest(record) {
    const rows = store ? store.listKnowledge({ fresh: true }) : [];
    const digest = renderDigest(rows, { project: record.project || 'global', now: now() });
    return { text: digest.text, tokens: digest.tokens, rows: digest.rows.map((row) => ({ id: row.id, revision: row.revision, statement: row.statement, facet: row.facet, seed: row.seed })), omitted: digest.omitted, candidates: digest.candidates, at: iso(now()), project: record.project || 'global' };
  }

  /**
   * What a brain is built for: a change means an idle brain restarts (the runtime's brainNeedsRestart).
   * Every brain carries the digest in its persona; only the Claude brain is built for the nudges
   * layer too (its CLI's environment tells pre-compact.mjs who keeps the thread record).
   */
  function brainKey(record = null) {
    const on = layers();
    const claude = !record || record.brain?.provider === 'claude-code';
    return `k${on.knowledge ? 1 : 0}${claude ? `n${on.nudges ? 1 : 0}` : ''}`;
  }

  /**
   * The digest to append to the persona of a brain about to start (synchronous: a SQLite read at
   * most). Built once per provider conversation and frozen on the session record.
   * → { text, key, nudges, digest }
   */
  function personaSuffix(record) {
    const on = layers();
    const key = brainKey(record);
    if (!on.knowledge || !store) return { text: '', key, nudges: on.nudges, digest: null };
    try {
      const uc = userContextState(record);
      if (!uc.digest) uc.digest = buildDigest(record);
      if (uc.digest.text) installs.add(record.id);
      return { text: uc.digest.text, key, nudges: on.nudges, digest: uc.digest };
    } catch (error) {
      log('user-context:digest-error', error?.message || String(error));
      return { text: '', key, nudges: on.nudges, digest: null };
    }
  }

  /** The conversation was replaced (provider, account or project switch; a resume into another provider session). */
  function conversationReplaced(record) {
    const uc = userContextState(record);
    uc.digest = null;
    uc.delivered = freshDelivered();
    uc.learnedHere = [];
    lastThreads.delete(record.id);
  }

  /** The brain's context was compacted or cleared: what was said once may be said again, where it still matters. */
  function onCompaction(record) {
    const uc = userContextState(record);
    uc.delivered.cues = [];
    uc.learnedHere = uc.learnedHere.map((item) => ({ ...item, compacted: true }));
  }

  /** The categories recall keeps out of Related Memories (they reach the brain as the digest or a cue), or null. */
  function divertCategories() {
    if (!layers().knowledge || !store) return null;
    try { return store.knowledgeCategories(); } catch { return null; }
  }

  // ── threads ──
  function threadOf(record) {
    let thread = state.threads[record.id];
    if (!thread) { thread = newThread({ sessionId: record.id, title: record.title, project: record.project || 'global', at: null }); state.threads[record.id] = thread; }
    return thread;
  }
  function cardsOf(sessionId) {
    try { return cardGetters.get(sessionId)?.() || []; } catch { return []; }
  }
  async function writeThread(sessionId) {
    const timer = threadTimers.get(sessionId);
    if (timer) { timers.clearTimeout(timer); threadTimers.delete(sessionId); }
    const thread = state.threads[sessionId];
    if (!thread || !store || !(Number(thread.prompts) > 0) || !layers().nudges) return null;
    const content = threadContent(thread, { cards: cardsOf(sessionId) });
    const hash = shortHash(content);
    if (hash === thread.hash && thread.memoryId) { thread.dirty = false; return thread.memoryId; }
    const written = await store.writeThread({ sessionId, memoryId: thread.memoryId || null, content, project: thread.project || 'global' });
    if (written?.id) { thread.memoryId = written.id; thread.hash = hash; thread.writtenAt = iso(now()); thread.dirty = false; saveState(); return written.id; }
    log('user-context:thread-error', written?.error || 'thread write failed');
    return null;
  }
  function scheduleThread(sessionId) {
    if (stopped) return;
    const existing = threadTimers.get(sessionId);
    if (existing) timers.clearTimeout(existing);
    const timer = timers.setTimeout(() => { threadTimers.delete(sessionId); writeThread(sessionId).catch((error) => log('user-context:thread-error', error?.message || String(error))); }, THREAD.writeDebounceMs);
    timer?.unref?.();
    threadTimers.set(sessionId, timer);
  }

  /** The most recent other conversation, from the working threads and the store. */
  function findLastThread(record) {
    let best = null;
    const consider = (candidate) => {
      if (!candidate?.title || !candidate.sessionId || candidate.sessionId === record.id) return;
      const ended = Date.parse(candidate.endedAt ?? '');
      if (!Number.isFinite(ended)) return;
      if (!best || ended > Date.parse(best.endedAt)) best = candidate;
    };
    for (const thread of Object.values(state.threads)) {
      if (!(Number(thread.prompts) > 0)) continue;
      consider({ title: thread.title, project: thread.project, endedAt: thread.lastAt, sessionId: thread.sessionId, open: openItems(thread, { cards: cardsOf(thread.sessionId) }).map((item) => item.text) });
    }
    if (store) {
      for (const row of store.lastThreads({ limit: 5 })) {
        const parsed = parseThread(row.content, { updatedAt: row.updated_at });
        // A working thread is newer than its own memory.
        if (parsed && !state.threads[parsed.sessionId]) consider({ ...parsed, project: parsed.project || row.project || 'global', memoryId: row.id, revision: row.revision });
      }
    }
    return best;
  }

  // ── a turn ──
  /**
   * A human turn about to reach the brain. → the turn's handle (never null).
   * input: { prompt, typed, origin, untrusted, generation, previousReply, cwd, taskId,
   *          emit(event), openCards() }
   */
  function beginTurn(record, input = {}) {
    const on = layers();
    const uc = userContextState(record);
    const at = now();
    const handle = {
      traceId: `auto-${randomUUID().slice(0, 12)}`, sessionId: record.id, at, layers: on,
      prompt: String(input.prompt ?? ''), origin: input.origin || null, generation: Number(input.generation) || 1,
      taskId: input.taskId || null, previousReply: String(input.previousReply ?? ''),
      first: !uc.delivered.opened, env: [], capture: null,
      // The greeting this conversation opened with (lib/greeting/), to be said once: { id, text, ids, source, model, costUsd } | null
      greeting: input.greeting && typeof input.greeting.text === 'string' && input.greeting.text.trim() ? input.greeting : null,
      injected: [], withheld: [], recall: null, block: '', blockTokens: 0, built: false, phase: 'pending', outcome: null,
      learning: null, emit: on.trace && typeof input.emit === 'function' ? input.emit : null, persist: typeof input.persist === 'function' ? input.persist : null,
    };
    try {
      uc.delivered.opened = true;
      uc.totals.turns = count(uc.totals.turns) + 1;
      if (typeof input.openCards === 'function') cardGetters.set(record.id, input.openCards);
      if (on.nudges) {
        const typed = typedEvidence({ prompt: handle.prompt, typed: input.typed });
        noteAsk(threadOf(record), { text: typed || handle.prompt, at: iso(at), title: record.title, project: record.project || 'global' });
        saveState();
        // What changed around the conversation since its last turn.
        const branch = (() => { try { return readBranch(input.cwd || record.brain?.cwd || '') || null; } catch { return null; } })();
        const before = uc.env;
        if (before.lastTurnAt) {
          if (before.branch && branch && before.branch !== branch) handle.env.push({ key: 'branch', text: `Git branch changed since the last turn: ${before.branch} → ${branch}.` });
          if (before.bootId && before.bootId !== bootId) handle.env.push({ key: 'restart', text: 'SynaBun restarted since the last turn: workers and browser tabs from before are gone.' });
          const gapHours = (at - Date.parse(before.lastTurnAt)) / 3_600_000;
          if (Number.isFinite(gapHours) && gapHours >= NUDGES.gapHours) handle.env.push({ key: 'gap', text: `${gapHours >= 36 ? `${Math.round(gapHours / 24)} days` : `${Math.round(gapHours)} h`} passed since the last message here.` });
        }
        uc.env = { branch: branch || before.branch || null, bootId, lastTurnAt: iso(at) };
      }
      handle.capture = on.knowledge
        ? prefilter({ origin: input.origin, untrusted: input.untrusted === true, system: false, prompt: handle.prompt, typed: input.typed }, uc.learn)
        : { pass: false, reason: 'layer-off', cues: [], chars: 0 };
      // The digest's memories are in the context for good: Related Memories never repeats them.
      if (on.knowledge && uc.digest?.rows?.length && typeof markInjected === 'function') {
        try { markInjected(uc.digest.rows, { session: record.id, generation: handle.generation }); } catch { /* the ledger is an optimisation */ }
      }
    } catch (error) { log('user-context:turn-error', error?.message || String(error)); }
    return handle;
  }

  /**
   * The per-turn block, built once the turn's recall result is known. → { text, tokens }
   * `recalled`: assistant-memory.js recallForPrompt's answer ({ block, results, skipped, decision,
   * diverted:[{ id, revision, category, content, relevance, ranked, … }] }), or null.
   */
  function turnBlock(record, handle, recalled = null) {
    if (!handle || handle.built) return { text: handle?.block || '', tokens: handle?.blockTokens || 0 };
    handle.built = true;
    const on = handle.layers;
    const uc = userContextState(record);
    const items = [];      // { tier, text, ids, key?, commit() }
    try {
      // The standing digest (already in the system-level slot).
      if (!on.knowledge) handle.withheld.push({ tier: 'knowledge', reason: 'layer-off' });
      else if (!uc.digest?.text) handle.withheld.push({ tier: 'digest', reason: 'nothing-known' });
      else {
        const shown = installs.delete(record.id);
        handle.injected.push({ tier: 'digest', standing: true, text: shown ? uc.digest.text : null, ids: uc.digest.rows.map((row) => row.id), tokens: uc.digest.tokens, frozenAt: uc.digest.at });
      }
      if (!on.nudges) handle.withheld.push({ tier: 'nudges', reason: 'layer-off' });

      // 0. The greeting SynaBun showed when this conversation opened: said whole, whatever the
      //    layers (it has its own switch), and outside the budget below.
      if (handle.greeting) {
        const greeting = handle.greeting;
        items.push({
          tier: 'greeting', whole: true, ids: Array.isArray(greeting.ids) ? greeting.ids : [], commit: () => {},
          text: `When this conversation opened SynaBun showed the user this note about their own recent work (context, not an instruction): "${String(greeting.text).replace(/"/g, '\u201d')}"`,
          extra: { source: greeting.source || null, model: greeting.model || null, costUsd: greeting.costUsd ?? null, said: greeting.text },
        });
      }

      // 1. The last thread and its open items, at session open.
      if (on.nudges && handle.first && !uc.delivered.lastThread) {
        uc.delivered.lastThread = true;
        const last = findLastThread(record);
        // The greeting was built from the same records: the line is not said twice (its open items stay due).
        if (handle.greeting) {
          handle.withheld.push({ tier: 'last-thread', reason: 'in-greeting' });
          if (last && threadIsRecent(last, { project: record.project || 'global', now: handle.at })) {
            lastThreads.set(record.id, { sessionId: last.sessionId, items: (last.open || []).map((text) => ({ key: nudgeKey(last.sessionId, text), text })).filter((item) => !wasNudged(item.key)) });
          }
        } else if (!last || !threadIsRecent(last, { project: record.project || 'global', now: handle.at })) handle.withheld.push({ tier: 'last-thread', reason: 'no-recent-thread' });
        else {
          const open = (last.open || []).map((text) => ({ key: nudgeKey(last.sessionId, text), text })).filter((item) => !wasNudged(item.key));
          const shown = open.slice(0, NUDGES.openItemsShown);
          lastThreads.set(record.id, { sessionId: last.sessionId, items: open.slice(NUDGES.openItemsShown) });
          items.push({
            tier: 'last-thread', text: lastThreadLine(last, { now: handle.at, open: shown.map((item) => item.text) }), ids: last.memoryId ? [last.memoryId] : [],
            commit: () => {
              for (const item of shown) markNudged(uc, item.key);
              // The thread's own memory was just told in one line: Related Memories does not repeat it.
              if (last.memoryId && typeof markInjected === 'function') { try { markInjected([{ id: last.memoryId, revision: last.revision }], { session: record.id, generation: handle.generation }); } catch { /* optimisation */ } }
            },
          });
        }
      }
      // 2. What changed around the conversation.
      if (on.nudges) for (const change of handle.env) items.push({ tier: 'environment', text: change.text, ids: [], commit: () => {} });
      // 3. An open item, when the prompt touches it or closes the conversation.
      if (on.nudges) {
        const own = openItems(threadOf(record), { cards: cardsOf(record.id) }).map((item) => ({ key: nudgeKey(record.id, item.text), text: item.text }));
        const carried = lastThreads.get(record.id)?.items || [];
        const closing = isClosingTurn(handle.prompt);
        const due = [...own, ...carried].filter((item) => !wasNudged(item.key) && (closing || overlap(handle.prompt, item.text) >= NUDGES.overlapWords)).slice(0, NUDGES.openItemsShown);
        if (due.length) items.push({ tier: 'open-item', text: `Still open: ${due.map((item) => item.text).join('; ')}.`, ids: [], commit: () => { for (const item of due) markNudged(uc, item.key); } });
      }
      // 4. One knowledge cue: a statement Jev ranked relevant, kept out of Related Memories.
      if (on.knowledge) {
        const diverted = Array.isArray(recalled?.diverted) ? recalled.diverted : [];
        const inDigest = new Set((uc.digest?.rows || []).map((row) => row.id));
        const replaced = new Set();
        if (diverted.length && store) for (const item of store.listKnowledge()) if (item.structured) for (const id of item.links || []) replaced.add(id);
        let picked = null;
        for (const row of diverted) {
          if (!row?.id) continue;
          const reason = !row.ranked ? 'not-ranked' : inDigest.has(row.id) ? 'in-digest' : uc.delivered.cues.includes(row.id) ? 'already-told' : replaced.has(row.id) ? 'replaced' : null;
          const parsed = parseKnowledge(row);
          if (reason || !parsed.statement) { handle.withheld.push({ tier: 'cue', reason: reason || 'unusable', ids: [row.id] }); continue; }
          if (picked) { handle.withheld.push({ tier: 'cue', reason: 'one-per-turn', ids: [row.id] }); continue; }
          picked = { row, statement: parsed.statement };
        }
        if (picked) {
          items.push({
            tier: 'cue', text: `About the user, relevant here: ${picked.statement}`, ids: [picked.row.id],
            commit: () => {
              uc.delivered.cues = [...uc.delivered.cues, picked.row.id].slice(-200);
              if (typeof markInjected === 'function') { try { markInjected([{ id: picked.row.id, revision: picked.row.revision }], { session: record.id, generation: handle.generation }); } catch { /* optimisation */ } }
            },
          });
        }
      }
      // 5. Delta: knowledge learned since the digest was frozen, or a fact that replaces one of its lines.
      if (on.knowledge && uc.digest && store) {
        const frozenAt = Date.parse(uc.digest.at);
        const digestRows = new Map(uc.digest.rows.map((row) => [row.id, row]));
        const here = new Map(uc.learnedHere.map((item) => [item.id, item]));
        const fresh = usableKnowledge(store.listKnowledge(), { project: record.project || 'global' }).filter((item) => {
          const updated = Date.parse(item.updatedAt ?? '');
          if (!Number.isFinite(updated) || updated <= frozenAt) return false;
          if (uc.delivered.deltas.includes(item.id)) return false;
          const inDigest = digestRows.get(item.id);
          if (inDigest && inDigest.statement === item.statement) return false;
          // Learned in this conversation: the brain heard the user say it, until a compaction.
          const mine = here.get(item.id);
          return !mine || mine.compacted === true;
        }).slice(0, TURN_BLOCK.deltasPerTurn);
        const replacedBy = fresh.length ? store.supersededBy([...digestRows.keys()]) : new Map();
        const oldOf = new Map([...replacedBy].map(([oldId, newId]) => [newId, digestRows.get(oldId)]));
        for (const item of fresh) {
          const old = oldOf.get(item.id) || (digestRows.has(item.id) ? digestRows.get(item.id) : null);
          const text = old?.statement && old.statement !== item.statement
            ? `Update about the user (replaces "${clipText(old.statement, 60)}"): ${item.statement}`
            : `Newly learned about the user: ${item.statement}`;
          items.push({ tier: 'delta', text, ids: [item.id], commit: () => { uc.delivered.deltas = [...uc.delivered.deltas, item.id].slice(-200); } });
        }
      }

      // Budget: items in order while they fit; what does not fit is withheld (and stays due).
      let budget = handle.first ? TURN_BLOCK.firstTokens : TURN_BLOCK.laterTokens;
      let text = '';
      for (const item of items) {
        // `whole` (the greeting): never clipped, and it does not take the other items' room.
        const line = `- ${item.whole ? item.text : clipText(item.text, TURN_BLOCK.itemMaxChars)}`;
        const next = text ? `${text}\n${line}` : `${TURN_BLOCK_HEADER}\n${line}`;
        if (item.whole) budget += estimateTokens(line);
        else if (estimateTokens(next) > budget) { handle.withheld.push({ tier: item.tier, reason: 'budget', text: item.text, ids: item.ids }); continue; }
        text = next;
        try { item.commit(); } catch { /* a ledger write must not cost the item */ }
        handle.injected.push({ tier: item.tier, text: item.extra?.said || line.slice(2), ids: item.ids, tokens: estimateTokens(line), ...(item.extra ? { source: item.extra.source, model: item.extra.model, costUsd: item.extra.costUsd } : {}) });
      }
      handle.block = text;
      handle.blockTokens = text ? estimateTokens(text) : 0;
      uc.totals.injectedTokens = count(uc.totals.injectedTokens) + handle.blockTokens;

      // Related Memories, for the whole picture of what this turn carried.
      if (recalled) {
        const ids = Array.isArray(recalled.results) ? recalled.results.map((row) => row.id).filter(Boolean) : [];
        handle.recall = { skipped: recalled.skipped || null, decision: recalled.decision || null, tokens: recalled.block ? estimateTokens(recalled.block) : 0, ids, alreadyPresent: recalled.alreadyPresent === true };
        if (recalled.block) handle.injected.push({ tier: 'recall', text: null, ids, tokens: handle.recall.tokens, decision: handle.recall.decision, alreadyPresent: handle.recall.alreadyPresent });
        else handle.withheld.push({ tier: 'recall', reason: recalled.skipped || (recalled.decision === 'skip' ? 'judged' : 'nothing-retrieved') });
      }
    } catch (error) {
      log('user-context:block-error', error?.message || String(error));
      handle.block = '';
      handle.blockTokens = 0;
    }
    handle.phase = 'sent';
    emit(record, handle);
    handle.persist?.();
    return { text: handle.block, tokens: handle.blockTokens };
  }

  function learningView(handle) {
    const capture = handle.capture || { pass: false, reason: 'layer-off', cues: [], chars: 0 };
    const view = { state: 'skipped', prefilter: { pass: capture.pass === true, reason: capture.reason || null, cues: capture.cues || [], chars: capture.chars || 0 } };
    if (!capture.pass) return view;
    if (!handle.learning) return { ...view, state: handle.phase === 'sent' ? 'waiting' : 'running' };
    return { ...view, state: 'done', gate: handle.learning.gate, writer: handle.learning.writer, action: handle.learning.action, cost: handle.learning.cost };
  }

  /** The turn's full snapshot (one `synabun.automation` event per phase, the same traceId). */
  function snapshot(record, handle) {
    const uc = userContextState(record);
    const sum = (tier) => handle.injected.filter((item) => (tier ? item.tier === tier : true)).reduce((total, item) => total + count(item.tokens), 0);
    return {
      type: AUTOMATION_EVENT, traceId: handle.traceId, phase: handle.phase, at: iso(now()), outcome: handle.outcome,
      first: handle.first, layers: { knowledge: handle.layers.knowledge, nudges: handle.layers.nudges },
      injected: handle.injected.map((item) => ({ ...item })),
      withheld: handle.withheld.map((item) => ({ ...item })),
      learning: learningView(handle),
      tokens: { digest: sum('digest'), turn: handle.blockTokens, recall: sum('recall'), budget: handle.first ? TURN_BLOCK.firstTokens : TURN_BLOCK.laterTokens, digestBudget: DIGEST.maxTokens },
      totals: {
        turns: count(uc.totals.turns), injectedTokens: count(uc.totals.injectedTokens), learned: count(uc.totals.learned),
        gate: count(uc.learn.counts.gate), gateCap: LEARN.gateCap, writer: count(uc.learn.counts.writer), writerCap: LEARN.writerCap,
        writes: count(uc.learn.counts.writes), writeCap: LEARN.writeCap, jevRequests: count(uc.totals.jevRequests), costUsd: Number(Number(uc.totals.costUsd || 0).toFixed(6)),
      },
    };
  }
  function emit(record, handle) {
    if (!handle.emit || (!handle.layers.knowledge && !handle.layers.nudges && !handle.greeting)) return;
    try { handle.emit(snapshot(record, handle)); } catch (error) { log('user-context:trace-error', error?.message || String(error)); }
  }

  async function runLearning(record, handle) {
    const uc = userContextState(record);
    const capture = handle.capture;
    let result = null;
    try {
      result = await learner.learn({
        sessionId: record.id, project: record.project || 'global', taskId: handle.taskId,
        text: capture.text, sentences: capture.sentences, cues: capture.cues, hash: capture.hash, previousReply: handle.previousReply,
      }, uc.learn);
    } catch (error) {
      log('user-context:learn-error', error?.message || String(error));
      result = { gate: null, writer: null, action: { type: 'none', reason: 'error' }, cost: { jevRequests: 0, jevInputTokens: 0, jevOutputTokens: 0, jevUsd: 0, writerTokens: null, writerUsd: 0, totalUsd: 0 } };
    }
    try {
      uc.totals.jevRequests = count(uc.totals.jevRequests) + count(result.cost?.jevRequests);
      uc.totals.jevInputTokens = count(uc.totals.jevInputTokens) + count(result.cost?.jevInputTokens);
      uc.totals.costUsd = Number(((Number(uc.totals.costUsd) || 0) + (Number(result.cost?.totalUsd) || 0)).toFixed(8));
      if (result.writer?.used) {
        uc.totals.writerCalls = count(uc.totals.writerCalls) + 1;
        // No draft: the one-shot itself failed (no Claude login, a timeout). A draft Jev turned down is the writer working.
        const failed = !result.writer.draft;
        health.writer = { ok: !failed, reason: failed ? String(result.writer.reason || 'writer-failed').slice(0, 160) : null, at: iso(now()) };
      }
      // The writer's tokens are a row of their own in the usage ledger (part 'aux': nothing pending is cleared).
      const tokens = result.writer?.tokens;
      if (usage?.settle && tokens && (count(tokens.input) + count(tokens.output) + count(tokens.cacheRead) + count(tokens.cacheWrite)) > 0) {
        try {
          usage.settle({
            sessionId: record.id, taskId: handle.taskId || undefined, scope: 'brain', provider: 'claude-code', model: result.writer.model || null, part: 'aux',
            tokens, costUsd: Number(result.writer.costUsd) > 0 ? Number(result.writer.costUsd) : undefined, costBasis: Number(result.writer.costUsd) > 0 ? 'reported' : null,
            reason: 'statement-writer', source: 'user-context',
          });
        } catch (error) { log('user-context:usage-error', error?.message || String(error)); }
      }
      if (result.action?.type && result.action.type !== 'none' && result.action.memoryId) {
        uc.totals.learned = count(uc.totals.learned) + 1;
        uc.learnedHere = [...uc.learnedHere.filter((item) => item.id !== result.action.memoryId), { id: result.action.memoryId, at: iso(now()), compacted: false }].slice(-50);
      }
    } catch (error) { log('user-context:learn-error', error?.message || String(error)); }
    handle.learning = result;
    handle.phase = 'learned';
    emit(record, handle);
    handle.persist?.();
    return result;
  }

  /**
   * The turn ended (`done`, `aborted` or `error`: the same for every brain). The trace moves under
   * the reply; learning runs now, off the reply path, one turn at a time per session.
   * → the learning promise (resolved at once when there is nothing to learn from).
   */
  function endTurn(record, handle, { outcome = 'done' } = {}) {
    if (!handle || handle.ended) return Promise.resolve(null);
    handle.ended = true;
    handle.outcome = outcome;
    // A Claude turn whose hook never ran (the CLI queued it away): its block was never built.
    if (!handle.built) { handle.built = true; handle.withheld.push({ tier: 'turn', reason: 'not-delivered' }); }
    handle.phase = 'turn_end';
    emit(record, handle);
    try {
      if (handle.layers.nudges) {
        const thread = threadOf(record);
        thread.lastAt = iso(now());
        if (record.title) thread.title = record.title;
        thread.dirty = true;
        saveState();
        scheduleThread(record.id);
      }
    } catch (error) { log('user-context:thread-error', error?.message || String(error)); }
    handle.persist?.();
    if (!handle.capture?.pass || !handle.layers.knowledge) return Promise.resolve(null);
    const previous = chains.get(record.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => runLearning(record, handle));
    chains.set(record.id, next);
    next.finally(() => { if (chains.get(record.id) === next) chains.delete(record.id); }).catch(() => {});
    return next;
  }

  /** The turn never reached the brain: nothing is traced or learned. */
  function cancelTurn(record, handle) {
    if (!handle) return;
    handle.ended = true;
    handle.built = true;
  }

  /** A dispatch event of the conversation (assistant-dispatch.js): its runs and their outcomes join the thread. */
  function onDispatch(record, payload = {}) {
    if (!layers().nudges) return;
    try {
      const thread = threadOf(record);
      if (payload.type === 'assistant:run-removed') { for (const runId of payload.runIds || []) dropRun(thread, runId); }
      else if (payload.run?.runId) noteRun(thread, payload.run, payload.reason || '', iso(now()));
      if (thread.dirty) { saveState(); if (Number(thread.prompts) > 0) scheduleThread(record.id); }
    } catch (error) { log('user-context:thread-error', error?.message || String(error)); }
  }

  /** The conversation closed: its thread memory is written now. */
  function sessionClosed(sessionId) {
    return writeThread(String(sessionId)).catch((error) => { log('user-context:thread-error', error?.message || String(error)); return null; });
  }
  /** The conversation was deleted: its working state goes (the thread memory stays: it is the owner's memory). */
  function sessionDestroyed(sessionId) {
    const id = String(sessionId);
    const timer = threadTimers.get(id);
    if (timer) { timers.clearTimeout(timer); threadTimers.delete(id); }
    delete state.threads[id];
    cardGetters.delete(id);
    lastThreads.delete(id);
    installs.delete(id);
    saveState();
  }

  /** What a new conversation in `project` would be told (Settings → Automation behavior). */
  function preview({ project = 'global' } = {}) {
    const rows = store ? store.listKnowledge({ fresh: true }) : [];
    const digest = renderDigest(rows, { project, now: now() });
    return {
      project, text: digest.text, tokens: digest.tokens, maxTokens: DIGEST.maxTokens, perFacet: DIGEST.perFacet,
      rows: digest.rows, omitted: digest.omitted, candidates: digest.candidates,
      total: rows.length, structured: rows.filter((row) => row.structured).length,
      categories: store ? store.knowledgeCategories() : [CATEGORIES.knowledge],
      turnBudget: { first: TURN_BLOCK.firstTokens, later: TURN_BLOCK.laterTokens },
    };
  }

  /**
   * What the layers can do on this server right now (Settings shows what is not there).
   * `jevReason`: why learning cannot run (learningJudgeReason, 'not-configured' without a judge), null while it can.
   * `writerLast`: { ok, reason, at } of the statement writer's last one-shot since the server started, or null.
   */
  function capabilities() {
    const jev = learner.available();
    let jevReason = null;
    if (!jev) {
      try { jevReason = (judge && typeof judge.reason === 'function' ? judge.reason() : null) || (judge ? 'unavailable' : 'not-configured'); }
      catch { jevReason = 'unavailable'; }
    }
    return {
      jev, jevReason,
      writer: !!writer && (typeof writer.available !== 'function' || !!writer.available()),
      writerLast: health.writer ? { ...health.writer } : null,
      store: !!store,
    };
  }

  /** Learning under way for a session (tests and shutdown wait on it). */
  function idle(sessionId = null) {
    const pending = sessionId ? [chains.get(String(sessionId))].filter(Boolean) : [...chains.values()];
    return Promise.allSettled(pending);
  }

  function shutdown() {
    stopped = true;
    for (const timer of threadTimers.values()) timers.clearTimeout(timer);
    threadTimers.clear();
    saveStateNow();
  }

  return {
    layers, brainKey, personaSuffix, conversationReplaced, onCompaction, divertCategories,
    beginTurn, turnBlock, endTurn, cancelTurn, onDispatch, sessionClosed, sessionDestroyed,
    preview, capabilities, idle, shutdown, flushThread: writeThread,
    _internals: { state: () => state, saveStateNow, snapshot, learner },
  };
}
