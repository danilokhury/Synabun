// ═══════════════════════════════════════════
// SynaBun — Greeting (the engine)
// ═══════════════════════════════════════════
//
// One greeting for every agent. When a person comes back and opens a fresh
// session (the Assistant, the Claude Code / Codex / OpenCode panels, a
// terminal Claude Code session), SynaBun says in one or two sentences what
// they were doing last here, what is open, and what finished or failed while
// they were away. The harness writes it; the session's own model never greets,
// it is only told once what was said.
//
//   prepared  in the background. Every human prompt is noted per project
//             (noteActivity); a sweep looks at the projects that went quiet and
//             calls the writer when their facts changed (a growing interval
//             while the person stays away, a daily cap).
//   open      a lookup: local facts, a fingerprint compare, the prepared
//             sentence or the deterministic line. Never a model call, and
//             nothing at all unless this opening is a return: an hour away,
//             something real to say, something new since the last greeting.
//   known     the surface echoes the greeting's id with the first prompt and
//             the session's model gets one short note (consumeNote), once.
//   visible   every greeting carries the records it was built from and what
//             the writer cost.
//
// Everything heavy is injected (the records, the writer), so the module is
// unit-testable and never opens the memory database itself. Nothing here
// throws into a session: a failure is logged and the session opens quietly.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GREETING_DEFAULTS, ID_RE, PREPARE, RETURN, STATE, SURFACES, TEXT, estimateTokens, greetingKilled, normalizeGreetingSettings } from './budgets.js';
import { agentNote, awayText, basisOf, buildFacts, clipLabel, decide, fallbackLine, fingerprint, gitKey } from './facts.js';

export const GREETING_EVENT = 'greeting:changed';
const STATE_VERSION = 1;
const SURFACE_AGENT = Object.freeze({ assistant: 'assistant', 'claude-panel': 'claude-code', 'claude-cli': 'claude-code', 'codex-panel': 'codex', 'opencode-panel': 'opencode' });

const iso = (at) => new Date(at).toISOString();
const ms = (value) => { const at = typeof value === 'number' ? value : Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);
const localDay = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/**
 * @param {object} deps
 * @param {string} deps.settingsPath        DATA_HOME/data/greeting.json ({ enabled }), read live
 * @param {string} [deps.statePath]         DATA_HOME/data/greeting-state.json (operational state)
 * @param {object} deps.sources             sources.js createGreetingSources()
 * @param {{ available: Function, write: Function } | null} [deps.writer]  writer.js createGreetingWriter()
 * @param {(text:string) => string} [deps.redact]   credentials out of anything read
 * @param {(event:object) => void} [deps.broadcast] tells open windows a setting changed
 */
export function createGreetingEngine({
  settingsPath = null, statePath = null, sources = null, writer = null, redact = (text) => text, broadcast = () => {},
  env = process.env, now = Date.now, log = () => {}, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, autoSweep = true,
} = {}) {
  let settingsCache = null; // { mtimeMs, value }
  let state = loadState();
  let stateTimer = null;
  let sweepTimer = null;
  let bootTimer = null;
  let sweeping = null;
  let stopped = false;
  const preparing = new Map(); // project → the preparation under way

  // ── settings ──
  function settings() {
    if (!settingsPath) return { ...GREETING_DEFAULTS };
    try {
      const stat = statSync(settingsPath);
      if (settingsCache && settingsCache.mtimeMs === stat.mtimeMs) return settingsCache.value;
      const value = normalizeGreetingSettings(JSON.parse(readFileSync(settingsPath, 'utf8')));
      settingsCache = { mtimeMs: stat.mtimeMs, value };
      return value;
    } catch {
      // No file yet (the default), or one that cannot be read: the default.
      return { ...GREETING_DEFAULTS };
    }
  }
  function killed() { return greetingKilled(env); }
  function enabled() { return settings().enabled && !killed(); }
  function setEnabled(value) {
    if (!settingsPath) throw new Error('The greeting setting has nowhere to be saved');
    const next = normalizeGreetingSettings({ enabled: value !== false });
    mkdirSync(dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, settingsPath);
    settingsCache = null;
    try { broadcast({ type: GREETING_EVENT, enabled: next.enabled }); } catch { /* nobody listening */ }
    return next;
  }

  // ── operational state ──
  function emptyState() {
    return { version: STATE_VERSION, activity: {}, lastActivityAt: null, prepared: {}, shown: {}, greetings: {}, sessions: {}, told: {}, rearm: {}, spend: { day: null, calls: 0, costUsd: 0, tokens: 0 } };
  }
  function loadState() {
    const empty = emptyState();
    if (!statePath) return empty;
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return empty;
      return {
        ...empty,
        activity: object(raw.activity), lastActivityAt: typeof raw.lastActivityAt === 'string' ? raw.lastActivityAt : null,
        prepared: object(raw.prepared), shown: object(raw.shown), greetings: object(raw.greetings), sessions: object(raw.sessions),
        told: object(raw.told), rearm: object(raw.rearm), spend: { ...empty.spend, ...object(raw.spend) },
      };
    } catch { return empty; }
  }
  const newest = (entries, at, keep) => Object.fromEntries(entries.sort((a, b) => (ms(at(b[1])) ?? 0) - (ms(at(a[1])) ?? 0)).slice(0, keep));
  function saveStateNow() {
    if (stateTimer) { timers.clearTimeout(stateTimer); stateTimer = null; }
    if (!statePath) return;
    try {
      state.greetings = newest(Object.entries(state.greetings), (row) => row.shownAt, STATE.greetingsKept);
      state.sessions = newest(Object.entries(state.sessions), (row) => row.at, STATE.sessionsKept);
      state.told = newest(Object.entries(state.told), (row) => row, STATE.toldKept);
      state.activity = newest(Object.entries(state.activity), (row) => row.at, STATE.projectsKept);
      for (const key of ['prepared', 'shown']) for (const project of Object.keys(state[key])) if (!state.activity[project]) delete state[key][project];
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      renameSync(tmp, statePath);
    } catch (error) { log('greeting:state-error', error?.message || String(error)); }
  }
  function saveState() {
    if (stateTimer || stopped) return;
    stateTimer = timers.setTimeout(() => { stateTimer = null; saveStateNow(); }, 500);
    stateTimer?.unref?.();
  }

  // ── who, where, when ──
  function projectKey({ project = null, cwd = null } = {}) {
    if (project) return String(project).toLowerCase();
    try { return String(sources?.projectOf?.(cwd) || 'global').toLowerCase(); } catch { return 'global'; }
  }
  function labelOf(project) {
    try { return sources?.projectInfo?.(project)?.label || project; } catch { return project; }
  }
  /** The person's last message in a project (ms), seeded from the records the first time it is asked. */
  function lastActivity(project) {
    const known = ms(state.activity[project]?.at);
    if (known != null) return known;
    let seeded = null;
    try { seeded = sources?.lastWorkAt?.(project) ?? null; } catch { seeded = null; }
    if (seeded != null) { state.activity[project] = { at: iso(seeded), seeded: true, surfaces: {} }; saveState(); }
    return seeded;
  }
  function activityList(project) {
    const surfaces = object(state.activity[project]?.surfaces);
    return Object.entries(surfaces).map(([surface, entry]) => ({ surface, agent: SURFACE_AGENT[surface] || null, at: entry?.at || null, words: entry?.words || '' }));
  }
  const toldSet = () => new Set(Object.keys(state.told));

  /**
   * A person sent a message (every surface calls this from its prompt path; never a loop, a
   * dispatched run, a subagent or a system turn). `words`: what they typed, kept as one short quote.
   */
  function noteActivity({ project = null, cwd = null, surface = 'assistant', words = '' } = {}) {
    try {
      const key = projectKey({ project, cwd });
      const at = iso(now());
      const entry = state.activity[key] && typeof state.activity[key] === 'object' ? state.activity[key] : { surfaces: {} };
      entry.at = at;
      delete entry.seeded;
      entry.surfaces = object(entry.surfaces);
      // With the greeting off only the time is kept: nothing they typed is stored for a feature that is not in use.
      const quote = enabled() ? clipLabel(safeRedact(words), TEXT.quoteChars) : '';
      entry.surfaces[String(surface)] = { at, ...(quote ? { words: quote } : {}) };
      state.activity[key] = entry;
      state.lastActivityAt = at;
      // They are here: the next absence starts its own preparation rhythm.
      if (state.prepared[key]) state.prepared[key].attempts = 0;
      saveState();
      return key;
    } catch (error) { log('greeting:activity-error', error?.message || String(error)); return null; }
  }
  function safeRedact(text) {
    try { return String(redact(String(text ?? '')) ?? ''); } catch { return ''; }
  }

  // ── facts ──
  async function factsFor(project, { fast = false } = {}) {
    const since = lastActivity(project);
    const at = now();
    const raw = await sources.collect(project, {
      since, globalSince: ms(state.lastActivityAt) ?? since, now: at, activity: activityList(project), told: toldSet(),
      gitTimeoutMs: fast ? 400 : 1500,
    });
    return { raw, facts: buildFacts(raw, { redact: safeRedact }), since, at };
  }
  /** The fingerprint the same facts will have once their unscoped news has been said. */
  function fingerprintAfterTelling(raw) {
    return fingerprint(buildFacts({ ...raw, schedules: [], elsewhere: [] }, { redact: safeRedact }));
  }

  // ── preparing ──
  function spendToday() {
    const day = localDay(now());
    if (state.spend.day !== day) state.spend = { day, calls: 0, costUsd: 0, tokens: 0 };
    return state.spend;
  }
  function writerAvailable() {
    try { return !!writer && (typeof writer.available !== 'function' || !!writer.available()); } catch { return false; }
  }
  function publicCost(result) {
    const tokens = result?.tokens && typeof result.tokens === 'object' ? result.tokens : null;
    return {
      model: result?.model || null,
      tokens: tokens ? { input: count(tokens.input), cacheWrite: count(tokens.cacheWrite), cacheRead: count(tokens.cacheRead), output: count(tokens.output) } : null,
      costUsd: Number.isFinite(Number(result?.costUsd)) && result?.costUsd != null ? Number(result.costUsd) : null,
      ms: count(result?.ms),
    };
  }

  /**
   * Write a project's greeting ahead of time. Nothing happens while the person is still there,
   * while the facts are the ones already written or already said, or before the interval is up.
   * `force` (Settings' preview) writes now. → the prepared entry, or null.
   */
  async function prepare(project, { force = false } = {}) {
    const key = String(project || 'global').toLowerCase();
    if (!sources || (!force && !enabled())) return null;
    if (preparing.has(key)) return preparing.get(key);
    const job = (async () => {
      const since = lastActivity(key);
      if (since == null) return null;
      if (!force && now() - since < PREPARE.settleMs) return state.prepared[key] || null;
      const current = state.prepared[key] || null;
      const attempts = count(current?.attempts);
      const wait = PREPARE.intervalsMs[Math.min(attempts, PREPARE.intervalsMs.length - 1)];
      if (!force && current?.lastTryAt && now() - (ms(current.lastTryAt) ?? 0) < wait) return current;
      const { facts } = await factsFor(key);
      if (!facts.substantive) { if (current) { delete state.prepared[key]; saveState(); } return null; }
      const print = fingerprint(facts);
      const tree = gitKey(facts);
      if (!force && current && current.fingerprint === print && (tree == null || current.gitKey === tree)) return current;
      // Already said and nothing new: a sentence nobody would be shown is not worth a call.
      if (!force && state.shown[key]?.fingerprint === print) return current;
      const fallback = fallbackLine(facts);
      const spend = spendToday();
      let result = { text: '', error: writerAvailable() ? null : 'no-writer' };
      if (writerAvailable()) {
        if (spend.calls >= PREPARE.dailyCalls) result = { text: '', error: 'daily-cap' };
        else {
          spend.calls += 1;
          try { result = await writer.write(facts, {}); } catch (error) { result = { text: '', error: String(error?.message || error).slice(0, 160) }; }
          const cost = publicCost(result);
          spend.costUsd = Number((Number(spend.costUsd || 0) + (cost.costUsd || 0)).toFixed(6));
          spend.tokens = count(spend.tokens) + (cost.tokens ? cost.tokens.input + cost.tokens.cacheWrite + cost.tokens.cacheRead + cost.tokens.output : 0);
        }
      }
      const text = result.text || fallback;
      if (!text) return null;
      const entry = {
        fingerprint: print, gitKey: tree ?? current?.gitKey ?? null, text, source: result.text ? 'writer' : 'fallback', error: result.text ? null : (result.error || null),
        ...publicCost(result), preparedAt: iso(now()), basis: basisOf(facts), attempts: attempts + 1, lastTryAt: iso(now()),
      };
      state.prepared[key] = entry;
      saveState();
      return entry;
    })().catch((error) => { log('greeting:prepare-error', error?.message || String(error)); return null; })
      .finally(() => { preparing.delete(key); });
    preparing.set(key, job);
    return job;
  }

  /** Every project the person worked in lately, one after the other. */
  function sweep() {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      if (stopped || !enabled() || !sources) return 0;
      // A fresh install of the engine: the projects with the newest records get their first entry.
      if (!Object.keys(state.activity).length) {
        let recent = [];
        try { recent = sources.recentProjects?.({ limit: PREPARE.projects }) || []; } catch { recent = []; }
        for (const project of recent) lastActivity(String(project).toLowerCase());
      }
      const floor = now() - PREPARE.activeDays * 24 * 3_600_000;
      const projects = Object.entries(state.activity).map(([project, entry]) => ({ project, at: ms(entry?.at) }))
        .filter((row) => row.at != null && row.at >= floor).sort((a, b) => b.at - a.at).slice(0, PREPARE.projects);
      let written = 0;
      for (const { project } of projects) {
        if (stopped) break;
        const before = state.prepared[project]?.preparedAt || null;
        const entry = await prepare(project);
        if (entry && entry.preparedAt !== before) written += 1;
      }
      return written;
    })().catch((error) => { log('greeting:sweep-error', error?.message || String(error)); return 0; })
      .finally(() => { sweeping = null; });
    return sweeping;
  }
  function start() {
    if (!autoSweep || stopped || sweepTimer) return;
    bootTimer = timers.setTimeout(() => { bootTimer = null; sweep(); }, PREPARE.bootDelayMs);
    bootTimer?.unref?.();
    sweepTimer = timers.setInterval(() => { sweep(); }, PREPARE.sweepMs);
    sweepTimer?.unref?.();
  }

  // ── opening a session ──
  function view(greeting) {
    if (!greeting) return null;
    const away = greeting.awaySince && greeting.shownAt ? (ms(greeting.shownAt) ?? 0) - (ms(greeting.awaySince) ?? 0) : null;
    return {
      id: greeting.id, text: greeting.text, project: greeting.project, label: greeting.label, surface: greeting.surface || null,
      source: greeting.source, error: greeting.error || null, model: greeting.model || null, tokens: greeting.tokens || null,
      costUsd: greeting.costUsd ?? null, ms: greeting.ms || 0, preparedAt: greeting.preparedAt || null,
      shownAt: greeting.shownAt, awaySince: greeting.awaySince || null, away: away != null && away > 0 ? awayText(away) : '',
      basis: Array.isArray(greeting.basis) ? greeting.basis : [], reason: greeting.reason || null,
    };
  }
  function rememberSession(sessionKey, id, reason) {
    if (!sessionKey) return;
    state.sessions[sessionKey] = { id: id || null, reason: id ? null : reason, at: iso(now()) };
  }

  /**
   * A person opened a fresh interactive session. → { greeting | null, reason }.
   * `session`: the surface's name for this conversation; the same one asking again (a reload, a
   * redraw) gets the same answer, so nothing greets twice. `note: true` (a surface with no later
   * call of its own: the terminal hook) also returns the model's note, given once.
   */
  async function open({ surface = 'assistant', project = null, cwd = null, session = null, note = false } = {}) {
    try {
      if (!enabled()) return { greeting: null, reason: killed() ? 'killed' : 'off' };
      if (!sources) return { greeting: null, reason: 'unavailable' };
      if (!Object.prototype.hasOwnProperty.call(SURFACES, surface)) return { greeting: null, reason: 'unknown-surface' };
      const key = projectKey({ project, cwd });
      const sessionKey = session && ID_RE.test(String(session)) ? `${surface}:${session}` : null;
      const prior = sessionKey ? state.sessions[sessionKey] : null;
      if (prior) {
        const again = prior.id ? state.greetings[prior.id] : null;
        return { greeting: again && !again.notedAt ? view(again) : null, reason: again ? 'repeat' : (prior.reason || 'nothing-to-say') };
      }
      const forced = state.rearm[key] === true;
      const since = lastActivity(key);
      // Being greeted is being here: an hour starts over from the last greeting too.
      const presentAt = Math.max(since ?? 0, ms(state.shown[key]?.at) ?? 0);
      if (!forced && since != null && now() - presentAt < RETURN.gapMs) { rememberSession(sessionKey, null, 'recent'); saveState(); return { greeting: null, reason: 'recent' }; }
      const { raw, facts, at } = await factsFor(key, { fast: true });
      const verdict = decide({ enabled: true, facts, now: at, since, shownFingerprint: state.shown[key]?.fingerprint || null, forced });
      if (!verdict.greet) { rememberSession(sessionKey, null, verdict.reason); saveState(); return { greeting: null, reason: verdict.reason }; }
      const print = fingerprint(facts);
      const tree = gitKey(facts);
      const prepared = state.prepared[key];
      const current = !!prepared?.text && prepared.fingerprint === print && (tree == null || prepared.gitKey == null || prepared.gitKey === tree);
      const text = current ? prepared.text : fallbackLine(facts);
      if (!text) { rememberSession(sessionKey, null, 'nothing-to-say'); saveState(); return { greeting: null, reason: 'nothing-to-say' }; }
      const greeting = {
        id: `g-${randomUUID().replace(/-/g, '').slice(0, 16)}`, project: key, label: facts.label, text, surface, session: sessionKey,
        source: current ? prepared.source : 'fallback', error: current ? (prepared.error || null) : (prepared ? 'out-of-date' : 'not-prepared'),
        model: current ? prepared.model : null, tokens: current ? prepared.tokens : null, costUsd: current ? prepared.costUsd : null, ms: current ? prepared.ms : 0,
        preparedAt: current ? prepared.preparedAt : null, basis: basisOf(facts), reason: verdict.reason,
        shownAt: iso(at), awaySince: since != null ? iso(since) : null, notedAt: null,
      };
      state.greetings[greeting.id] = greeting;
      state.shown[key] = { fingerprint: fingerprintAfterTelling(raw), at: greeting.shownAt, greetingId: greeting.id };
      for (const told of raw.toldKeys || []) state.told[told] = at;
      delete state.rearm[key];
      rememberSession(sessionKey, greeting.id, null);
      const out = { greeting: view(greeting), reason: verdict.reason };
      if (note) { out.note = agentNote(greeting.text); greeting.notedAt = iso(at); }
      saveState();
      return out;
    } catch (error) {
      log('greeting:open-error', error?.message || String(error));
      return { greeting: null, reason: 'error' };
    }
  }

  /**
   * The note for the session's model, once: the surface echoes the greeting's id with the first
   * prompt. '' for an id that is unknown, already told, or when the prompt is a slash command
   * (`skip`: the command's own flow comes first; the greeting is not owed to it later either).
   */
  function consumeNote(id, { skip = false } = {}) {
    try {
      const greeting = typeof id === 'string' && ID_RE.test(id) ? state.greetings[id] : null;
      if (!greeting || greeting.notedAt) return '';
      greeting.notedAt = iso(now());
      saveState();
      return skip ? '' : agentNote(greeting.text);
    } catch { return ''; }
  }
  /** The greeting a note would be about, without telling it (the Assistant's trace names its records). */
  function peek(id) {
    const greeting = typeof id === 'string' && ID_RE.test(id) ? state.greetings[id] : null;
    return greeting ? view(greeting) : null;
  }

  /**
   * What a new session in a project would be greeted with right now (Settings → Greeting). Marks
   * nothing as shown or told. `write: true` asks the writer now and keeps the answer as the
   * project's prepared greeting.
   */
  async function preview({ project = null, cwd = null, write = false } = {}) {
    const key = projectKey({ project, cwd });
    const base = { enabled: settings().enabled, killed: killed(), project: key, label: labelOf(key), writer: writerAvailable(), gapMs: RETURN.gapMs, maxChars: TEXT.maxChars };
    if (!sources) return { ...base, would: false, reason: 'unavailable', text: '', basis: [], lastHereAt: null, lastGreetingAt: null };
    try {
      if (write) await prepare(key, { force: true });
      const { facts, since, at } = await factsFor(key);
      const presentAt = Math.max(since ?? 0, ms(state.shown[key]?.at) ?? 0);
      const forced = state.rearm[key] === true;
      let verdict = decide({ enabled: enabled(), facts, now: at, since, shownFingerprint: state.shown[key]?.fingerprint || null, forced });
      // The same order a real opening decides in: here a moment ago comes before nothing new.
      if (!forced && enabled() && facts.substantive && since != null && at - presentAt < RETURN.gapMs) verdict = { greet: false, reason: 'recent' };
      const print = fingerprint(facts);
      const tree = gitKey(facts);
      const prepared = state.prepared[key];
      const current = !!prepared?.text && prepared.fingerprint === print && (tree == null || prepared.gitKey == null || prepared.gitKey === tree);
      const text = facts.substantive ? (current ? prepared.text : fallbackLine(facts)) : '';
      return {
        ...base, would: verdict.greet, reason: verdict.reason, text,
        source: current ? prepared.source : 'fallback', error: current ? (prepared.error || null) : (prepared ? 'out-of-date' : 'not-prepared'),
        model: current ? prepared.model : null, tokens: current ? prepared.tokens : null, costUsd: current ? prepared.costUsd ?? null : null, ms: current ? prepared.ms : 0,
        preparedAt: current ? prepared.preparedAt : null, basis: basisOf(facts),
        lastHereAt: since != null ? iso(since) : null, away: since != null ? awayText(at - since) : '',
        lastGreetingAt: state.shown[key]?.at || null, noteTokens: text ? estimateTokens(agentNote(text)) : 0,
        spend: { ...spendToday(), cap: PREPARE.dailyCalls },
      };
    } catch (error) {
      log('greeting:preview-error', error?.message || String(error));
      return { ...base, would: false, reason: 'error', text: '', basis: [], lastHereAt: null, lastGreetingAt: null };
    }
  }

  /** The next session opened in a project is greeted once, whatever the gap (the first live look). */
  function rearm({ project = null, cwd = null } = {}) {
    const key = projectKey({ project, cwd });
    state.rearm[key] = true;
    saveState();
    return key;
  }

  function status() {
    const shown = Object.values(state.greetings).sort((a, b) => (ms(b.shownAt) ?? 0) - (ms(a.shownAt) ?? 0));
    return {
      settings: settings(), killed: killed(), enabled: enabled(), writer: writerAvailable(),
      spend: { ...spendToday(), cap: PREPARE.dailyCalls }, gapMs: RETURN.gapMs,
      last: view(shown[0] || null), shownCount: shown.length,
    };
  }

  function shutdown() {
    stopped = true;
    if (bootTimer) { timers.clearTimeout(bootTimer); bootTimer = null; }
    if (sweepTimer) { timers.clearInterval(sweepTimer); sweepTimer = null; }
    saveStateNow();
  }

  return {
    settings, setEnabled, enabled, killed, noteActivity, open, consumeNote, peek, preview, prepare, sweep, start, rearm, status, shutdown,
    _internals: { state: () => state, saveStateNow, factsFor },
  };
}
