// ═══════════════════════════════════════════
// SynaBun — Greeting: the records (what SynaBun already knows)
// ═══════════════════════════════════════════
//
// Reads, for one project, what a greeting is built from, wherever SynaBun
// already records it: the Assistant's thread records and the session summaries
// every agent leaves in SynaBun memory, the significant memories of the last
// working period, the runs the person dispatched and how they ended, the
// schedules that did not complete, the branch and uncommitted work, and what
// is known about the person. Reads only: a SQLite SELECT, a registry view, one
// `git status`. Everything is injected, so nothing here opens the memory
// database itself, and every reader answers an empty list on failure.

import { execFile } from 'node:child_process';
import { CATEGORIES } from '../assistant-user-context-budgets.js';
import { openItems, parseThread } from '../assistant-user-threads.js';
import { readGitBranch } from '../assistant-user-context.js';
import { gitRead } from '../git-read.js';
import { FACTS } from './budgets.js';
import { PROBLEMS, runStatus } from './facts.js';

const ms = (value) => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
const marks = (n) => Array.from({ length: n }, () => '?').join(',');
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/**
 * A session summary memory ("## Session: …" with a "### Summary" block) → { title, summary, open[], sessionId } | null.
 * `open`: the bullets under an "Open" / "Still owed" / "Follow-ups" / "Next steps" line, when the summary has one.
 */
export function parseSessionSummary(content) {
  const text = String(content ?? '');
  const head = /^#{1,3}\s*Session\s*:\s*(.+)$/im.exec(text);
  if (!head) return null;
  const title = head[1].replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '').replace(/[*_`]+/g, '').trim();
  if (!title || /^\{.*\}$/.test(title)) return null;
  const block = /^#{2,4}\s*Summary\s*$\n([\s\S]*?)(?=^\s*#{2,4}\s|\s*$(?![\s\S]))/im.exec(text);
  const summary = block ? block[1].replace(/\s+/g, ' ').replace(/[*_`]+/g, '').trim() : '';
  const session = /\*\*Session ID\*\*\s*:\s*([A-Za-z0-9_-]{6,})/.exec(text);
  const owed = /^(?:#{2,4}\s*)?(?:open(?:\s+(?:at|items?)\b[^\n:]*)?|still\s+(?:open|owed)[^\n:]*|follow[- ]?ups?|next\s+steps?|pending)\s*:?\s*$\n((?:[ \t]*[-*][ \t]+.+(?:\n|$))+)/im.exec(text);
  const open = owed ? owed[1].split('\n').map((line) => line.replace(/^[ \t]*[-*][ \t]+/, '').replace(/\s+/g, ' ').replace(/[*_`]+/g, '').trim()).filter(Boolean).slice(0, 4) : [];
  return { title, summary, open, sessionId: session ? session[1] : null };
}

/**
 * `git status --porcelain` → the number of changed and untracked paths, or null (not a repository, too slow).
 * Run as lib/git-read.js runs a read: nothing the project's own git configuration names is started for it.
 */
export function gitDirtyCount(cwd, { timeoutMs = 1500, run = execFile } = {}) {
  return new Promise((done) => {
    if (!cwd) return done(null);
    gitRead(cwd, ['status', '--porcelain']).then((read) => {
      run('git', read.args, { cwd, env: read.env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return done(null);
        done(String(stdout || '').split('\n').filter((line) => line.trim()).length);
      });
    }).catch(() => done(null));
  });
}

/**
 * @param {object} deps
 * @param {() => object} deps.getDb                       node:sqlite handle of the memory database
 * @param {() => object[]} [deps.listRuns]                the dispatcher's run views (assistant-dispatch.js list())
 * @param {() => object[]} [deps.listSchedules]           loop schedules ({ id, name, enabled, lastRun, lastRunResult })
 * @param {() => {path:string,label:string}[]} [deps.projects]   the project registry
 * @param {(cwd:string) => string} [deps.detectProject]   a directory's memory project
 * @param {() => string[]} [deps.sessionCategories]       where session summaries are filed ("conversations" and its children)
 * @param {(project:string) => {id:string,statement:string}[]} [deps.knowledge]  what is known about the person, ranked
 * @param {() => object[]} [deps.workingThreads]          the user-context engine's working threads (newer than their memory)
 * @param {(cwd:string) => Promise<number|null>} [deps.gitDirty]
 */
export function createGreetingSources({
  getDb, listRuns = () => [], listSchedules = () => [], projects = () => [], detectProject = () => 'global',
  sessionCategories = () => ['conversations'], knowledge = () => [], workingThreads = () => [],
  gitDirty = gitDirtyCount, readBranch = readGitBranch, log = () => {},
} = {}) {
  const safe = (fn, fallback) => { try { const value = fn(); return value == null ? fallback : value; } catch (error) { log('greeting:source-error', error?.message || String(error)); return fallback; } };
  const normalize = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  /** The registry entry of a project key: { key, label, path } (label and path null when unregistered). */
  function projectInfo(project) {
    const key = String(project || 'global');
    for (const entry of safe(() => projects(), [])) {
      if (!entry?.path) continue;
      const detected = safe(() => detectProject(entry.path), null);
      if (same(detected, key) || same(normalize(entry.label), key)) return { key, label: String(entry.label || key), path: String(entry.path) };
    }
    return { key, label: key, path: null };
  }
  function projectOf(cwd) {
    const key = cwd ? safe(() => detectProject(String(cwd)), 'global') : 'global';
    return String(key || 'global');
  }

  function threadRows(project) {
    const out = [];
    const seen = new Set();
    // A working thread is newer than its own memory (which is written 45 s after a turn).
    for (const thread of safe(() => workingThreads(), [])) {
      if (!thread?.sessionId || !(Number(thread.prompts) > 0) || !same(thread.project || 'global', project)) continue;
      seen.add(String(thread.sessionId));
      out.push({
        memoryId: thread.memoryId || null, sessionId: String(thread.sessionId), title: thread.title || 'Untitled', endedAt: thread.lastAt || thread.startedAt,
        asks: (thread.asks || []).map((ask) => ask?.text || '').filter(Boolean),
        open: safe(() => openItems(thread).map((item) => item.text), []),
      });
    }
    const rows = safe(() => getDb().prepare(`SELECT id, content, project, updated_at FROM memories
      WHERE trashed_at IS NULL AND category = ? AND lower(project) = lower(?) ORDER BY updated_at DESC LIMIT ?`).all(CATEGORIES.threads, project, FACTS.threads + 2), []);
    for (const row of rows) {
      const parsed = safe(() => parseThread(row.content, { updatedAt: row.updated_at }), null);
      if (!parsed || !(parsed.prompts > 0) || (parsed.sessionId && seen.has(parsed.sessionId))) continue;
      out.push({ memoryId: String(row.id), sessionId: parsed.sessionId, title: parsed.title, endedAt: parsed.endedAt || row.updated_at, asks: parsed.asks, open: parsed.open });
    }
    return out.sort((a, b) => (ms(b.endedAt) ?? 0) - (ms(a.endedAt) ?? 0)).slice(0, FACTS.threads);
  }

  function summaryRows(project) {
    const categories = [...new Set(safe(() => sessionCategories(), ['conversations']).map(String).filter((name) => name && name !== CATEGORIES.threads))];
    if (!categories.length) return [];
    const rows = safe(() => getDb().prepare(`SELECT id, content, created_at FROM memories
      WHERE trashed_at IS NULL AND category IN (${marks(categories.length)}) AND lower(project) = lower(?) ORDER BY created_at DESC LIMIT ?`).all(...categories, project, FACTS.sessions * 3), []);
    const out = [];
    for (const row of rows) {
      const parsed = parseSessionSummary(row.content);
      if (!parsed) continue;
      out.push({ id: String(row.id), sessionId: parsed.sessionId, title: parsed.title, summary: parsed.summary, open: parsed.open, at: row.created_at, agent: null, source: 'summary' });
      if (out.length >= FACTS.sessions) break;
    }
    return out;
  }

  /** Significant memories written around the last working period (not the knowledge or thread records themselves). */
  function memoryRows(project, { from, to, exclude = [] }) {
    if (from == null) return [];
    const skip = [...new Set([CATEGORIES.threads, CATEGORIES.knowledge, CATEGORIES.knowledgeParent, ...exclude])];
    const rows = safe(() => getDb().prepare(`SELECT id, content, category, importance, created_at FROM memories
      WHERE trashed_at IS NULL AND lower(project) = lower(?) AND importance >= ? AND created_at >= ? AND created_at <= ?
        AND category NOT IN (${marks(skip.length)}) ORDER BY importance DESC, created_at DESC LIMIT ?`)
      .all(project, FACTS.memoryImportance, new Date(from).toISOString(), new Date(to).toISOString(), ...skip, FACTS.memories), []);
    return rows.map((row) => ({ id: String(row.id), title: firstLine(row.content).replace(/^#+\s*/, ''), excerpt: String(row.content || '').replace(/^#+\s*/gm, ''), category: row.category, importance: row.importance, at: row.created_at }));
  }

  function runRows(project, { since, now }) {
    const floor = Math.max(since ?? 0, now - FACTS.newsWindowMs);
    const here = [];
    for (const run of safe(() => listRuns(), [])) {
      if (!run?.runId || run.removed || !same(run.project || 'global', project)) continue;
      const finished = ms(run.finishedAt || run.completedAt);
      if (run.active === true) { if ((ms(run.createdAt) ?? 0) >= floor) here.push(run); continue; }
      if (finished != null && finished > floor && finished <= now) here.push(run);
    }
    return here.map((run) => ({ runId: run.runId, title: run.title || run.task || 'Untitled run', state: run.state, outcome: run.outcome, active: run.active === true, finishedAt: run.finishedAt || run.completedAt || null, provider: run.provider || null }));
  }

  /** Failures in other projects since the person was last anywhere: counts per project, never a detail. */
  function elsewhereRows(project, { globalSince, now, told = new Set() }) {
    const floor = Math.max(globalSince ?? 0, now - FACTS.newsWindowMs);
    const byProject = new Map();
    const keys = [];
    for (const run of safe(() => listRuns(), [])) {
      if (!run?.runId || run.removed || run.active === true || same(run.project || 'global', project)) continue;
      const finished = ms(run.finishedAt || run.completedAt);
      if (finished == null || finished <= floor || finished > now) continue;
      const status = runStatus(run);
      if (status !== 'failed' && status !== 'interrupted' && !PROBLEMS.has(status)) continue;
      const key = `run:${run.runId}`;
      if (told.has(key)) continue;
      const name = String(run.project || 'global');
      const entry = byProject.get(name.toLowerCase()) || { project: name, label: projectInfo(name).label, runs: 0, schedules: 0 };
      entry.runs += 1;
      byProject.set(name.toLowerCase(), entry);
      keys.push(key);
    }
    return { rows: [...byProject.values()].sort((a, b) => b.runs - a.runs), keys };
  }

  /** Enabled schedules whose last run, since the person was last anywhere, did not complete. */
  function scheduleRows({ globalSince, now, told = new Set() }) {
    const floor = Math.max(globalSince ?? 0, now - FACTS.newsWindowMs);
    const rows = [];
    for (const schedule of safe(() => listSchedules(), [])) {
      if (!schedule?.id || schedule.enabled === false) continue;
      const at = ms(schedule.lastRun);
      const result = String(schedule.lastRunResult ?? '').trim();
      if (at == null || at <= floor || at > now || !result || result === 'completed' || result === 'launched') continue;
      const key = `schedule:${schedule.id}:${schedule.lastRun}`;
      if (told.has(key)) continue;
      rows.push({ id: String(schedule.id), name: schedule.name || String(schedule.id), result: firstLine(result), at: schedule.lastRun, key });
    }
    return rows.sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
  }

  /**
   * Everything facts.js needs for one project.
   * `since`: the person's last message in the project (ms) or null; `globalSince`: anywhere.
   * `activity`: the engine's own record of their last prompts per surface ([{ surface, at, words }]).
   * → the raw input of buildFacts, plus `toldKeys` (the unscoped news in it, said once).
   */
  async function collect(project, { since = null, globalSince = null, now = Date.now(), activity = [], told = new Set(), gitTimeoutMs = 1500 } = {}) {
    const info = projectInfo(project);
    const threads = threadRows(info.key);
    const sessions = summaryRows(info.key);
    for (const entry of Array.isArray(activity) ? activity : []) {
      // The person's own last words on a surface that leaves no thread record of its own.
      if (!entry?.words || entry.surface === 'assistant' || ms(entry.at) == null) continue;
      sessions.push({ id: null, sessionId: `${entry.surface}:${entry.at}`, title: entry.words, summary: '', at: entry.at, agent: entry.agent || null, source: 'capture' });
    }
    const lastAt = Math.max(...[...threads.map((thread) => ms(thread.endedAt)), ...sessions.map((session) => ms(session.at))].filter((at) => at != null), 0) || null;
    const anchor = since ?? lastAt;
    const memories = anchor == null ? [] : memoryRows(info.key, { from: anchor - FACTS.memoryWindowMs, to: now, exclude: safe(() => sessionCategories(), []) });
    const runs = anchor == null ? [] : runRows(info.key, { since: anchor, now });
    const schedules = scheduleRows({ globalSince: globalSince ?? anchor, now, told });
    const elsewhere = elsewhereRows(info.key, { globalSince: globalSince ?? anchor, now, told });
    let git = null;
    if (info.path) {
      const branch = safe(() => readBranch(info.path), null);
      // dirty null: `git status` gave no answer in time, so nothing is claimed about changes.
      if (branch) git = { branch, dirty: await Promise.resolve(gitDirty(info.path, { timeoutMs: gitTimeoutMs })).catch(() => null) };
    }
    const known = safe(() => knowledge(info.key), []).filter((row) => row?.statement).slice(0, FACTS.ownerNotes);
    const words = threads[0]?.asks?.length ? threads[0].asks.slice(-FACTS.ownerWords) : sessions.filter((session) => session.source === 'capture').map((session) => session.title).slice(0, FACTS.ownerWords);
    return {
      project: info.key, label: info.label, now, since: since ?? null,
      threads, sessions, memories, runs,
      schedules: schedules.map(({ key: _key, ...rest }) => rest),
      elsewhere: elsewhere.rows,
      git,
      owner: { notes: known.map((row) => row.statement), noteIds: known.map((row) => String(row.id)), words },
      toldKeys: [...schedules.map((row) => row.key), ...elsewhere.keys],
      lastAt,
    };
  }

  /** When the person last worked in a project, from the records alone (an engine with no activity of its own yet). */
  function lastWorkAt(project) {
    const info = projectInfo(project);
    const times = [...threadRows(info.key).map((thread) => ms(thread.endedAt)), ...summaryRows(info.key).map((session) => ms(session.at))].filter((at) => at != null);
    return times.length ? Math.max(...times) : null;
  }

  /** The projects with the newest thread records and session summaries (boot: what to prepare first). */
  function recentProjects({ limit = 6 } = {}) {
    const categories = [...new Set([CATEGORIES.threads, ...safe(() => sessionCategories(), ['conversations'])])];
    const rows = safe(() => getDb().prepare(`SELECT lower(project) AS project, MAX(updated_at) AS at FROM memories
      WHERE trashed_at IS NULL AND category IN (${marks(categories.length)}) GROUP BY lower(project) ORDER BY at DESC LIMIT ?`).all(...categories, limit), []);
    return rows.map((row) => String(row.project || 'global')).filter(Boolean);
  }

  return { projectInfo, projectOf, collect, lastWorkAt, recentProjects };
}
