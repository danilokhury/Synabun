// ─────────────────────────────────────────────────────────────────────────────
// Background tasks of one conversation (no DOM, no socket, no provider)
//
// A shell command the agent started in the background, or a watch (Monitor),
// returns at once: its tool card closes while the work goes on for minutes or
// hours. This registry keeps what the session itself said about each one, so a
// panel can show what still runs, what it is doing now and how it ended.
//
// It knows no provider. An adapter turns a provider's own stream into facts
// (bg-tasks-claude.js for Claude Code; Codex, OpenCode and Antigravity can add
// theirs) and `applyBgFact` folds them in:
//   { kind: 'call',    toolUseId, type: 'shell' | 'watch', description, command, timeoutMs, at }
//   { kind: 'result',  toolUseId, taskId, outputFile, timeoutMs, persistent, isError, at }
//   { kind: 'started', taskId, toolUseId, type, description, at }      (the provider's own task start)
//   { kind: 'notice',  taskId, toolUseId, status, summary, outputFile, event, reason, at, uid }
//   { kind: 'updated', taskId, status, error, endedAt }
//   { kind: 'live',    tasks: [{ id, type, description, ambient }] }   (the whole live set: replace)
//   { kind: 'stopping', taskId, by: 'owner' | 'agent' } / { kind: 'stop-failed', taskId, error }
//   { kind: 'ended-all', at }                                         (the process that ran them is gone)
// The server rebuilds the same registry from the transcript (lib/claude-bg-tasks.js), so a reload or a restart
// starts from what the session recorded, never from page memory. What a task printed is never in here: a panel
// reads that in pages, for the owner's eyes only.
// ─────────────────────────────────────────────────────────────────────────────

/** The English words of the view; `bgTasks.*` in i18n/en.json must equal them (tests/bg-tasks-model.test.mjs). */
export const BG_TASKS_COPY = Object.freeze({
  title: 'Background tasks',
  toggle: 'Background tasks',
  badgeTitle: '{count} running in the background',
  back: 'Back to the conversation',
  empty: 'Nothing has run in the background in this conversation.',
  clearFinished: 'Clear finished',
  kindShell: 'shell',
  kindWatch: 'watch',
  statusRunning: 'running',
  statusCompleted: 'completed',
  statusFailed: 'failed',
  statusStopped: 'stopped',
  statusExpired: 'expired',
  statusEnded: 'ended',
  statusUnknown: 'checking',
  stoppedByOwner: 'Stopped by you',
  stoppedByAgent: 'Stopped by the agent',
  stopping: 'Stopping…',
  stop: 'Stop',
  stopConfirm: 'Stop this task?',
  stopYes: 'Stop it',
  stopNo: 'Keep running',
  stopFailed: 'Could not stop it: {error}',
  exitCode: 'exit {code}',
  events: 'Events',
  eventCount: '{count} events',
  eventCountOne: '1 event',
  noEvents: 'No events yet.',
  expiresIn: 'expires in {time}',
  outputLabel: 'Output of the background task',
  loadFull: 'Open full output',
  loading: 'Loading…',
  jump: 'Jump to latest',
  copy: 'Copy',
  copied: 'Copied',
  noOutputYet: 'Nothing printed yet.',
  noOutput: 'It printed nothing.',
  outputGone: 'Its output file is no longer there.',
  needsRestart: 'Its output shows once the SynaBun server has restarted.',
  outputPartial: 'Showing the last {shown} of {size}.',
  outputCapped: 'Showing the last {shown} of {size}: the whole output is too long to show here.',
  noticeFinished: '{kind} {status}',
  noticeEvent: 'Watch event',
  noticeStale: 'stale: the task had already ended',
  noticeOpen: 'Show in Background tasks',
  ended: 'The session that ran it is gone.',
});

/** A `BG_TASKS_COPY` sentence with its `{params}` filled in. */
export function fillBgCopy(key, params = {}) {
  return String(BG_TASKS_COPY[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? params[name] : whole));
}

const RUNNING = new Set(['running', 'unknown']);
export const FINISHED_STATUSES = Object.freeze(['completed', 'failed', 'stopped', 'expired', 'ended']);
const FINISHED = new Set(FINISHED_STATUSES);
/** How many finished tasks a registry keeps (the oldest go first). */
export const MAX_FINISHED_TASKS = 30;
/** How many tool calls it remembers while their results are on the way. */
const MAX_CALLS = 200;
/** How many events of a watch it keeps (the count goes on). */
export const MAX_TASK_EVENTS = 50;
const MAX_TEXT = 300;
const MAX_EVENT = 2000;

const clip = (value, n = MAX_TEXT) => {
  const s = String(value ?? '').replace(/\s+$/u, '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const plainId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '');
const time = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

export function createBgRegistry() {
  return { tasks: new Map(), calls: new Map(), seen: new Set(), cleared: new Set(), version: 0, liveSeen: false };
}

export const isBgRunning = (task) => !!task && RUNNING.has(task.status);
export const isBgFinished = (task) => !!task && FINISHED.has(task.status);

function newTask(id, at) {
  return {
    id, type: 'shell', toolUseId: '', description: '', command: '', outputFile: '',
    startedAt: at, endedAt: 0, status: 'running', exitCode: null, summary: '', error: '',
    events: [], eventCount: 0, lastEvent: '', timeoutMs: 0, persistent: false,
    stoppedBy: '', stopping: false, stopError: '', seenLive: false,
  };
}

function finish(task, status, at) {
  task.status = status;
  task.stopping = false;
  if (!task.endedAt) task.endedAt = at;
}

/** The exit code a summary names ("… completed (exit code 2)"), or null. */
export function exitCodeOf(summary) {
  const m = /exit code:?\s*(-?\d+)/i.exec(String(summary || ''));
  return m ? Number(m[1]) : null;
}

/** Whether a watch's notice says its deadline ended it. */
export function saysExpired(summary) {
  return /\bexpired\b|\btimed out\b/i.test(String(summary || ''));
}

const TAG = (body, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? m[1].trim() : '';
};

/**
 * Every `<task-notification>` block of a text, read into fields. Text outside the tags is the CLI's own advice to
 * the model and is left out. `{ taskId, toolUseId, outputFile, status, summary, event }` per block.
 */
export function parseTaskNotifications(text) {
  const out = [];
  const src = String(text || '');
  if (!src.includes('<task-notification>')) return out;
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  let m;
  while ((m = re.exec(src)) && out.length < 50) {
    const body = m[1];
    const taskId = plainId(TAG(body, 'task-id'));
    if (!taskId) continue;
    out.push({
      taskId,
      toolUseId: plainId(TAG(body, 'tool-use-id')),
      outputFile: TAG(body, 'output-file').slice(0, 4096),
      status: TAG(body, 'status').toLowerCase().slice(0, 40),
      summary: clip(TAG(body, 'summary')),
      event: TAG(body, 'event').slice(0, MAX_EVENT),
    });
  }
  return out;
}

/** The kind a provider's task type stands for, or '' when it is not a shell or a watch. */
export function kindOfTaskType(type) {
  const t = String(type || '').toLowerCase();
  if (!t) return '';
  if (t.includes('monitor') || t === 'watch') return 'watch';
  if (t === 'local_bash' || t === 'shell' || t === 'bash') return 'shell';
  return '';
}

function rememberCall(reg, fact) {
  const id = plainId(fact.toolUseId);
  if (!id) return;
  reg.calls.set(id, {
    type: fact.type === 'watch' ? 'watch' : 'shell',
    description: clip(fact.description, 200),
    command: clip(fact.command, 1000),
    timeoutMs: Math.max(0, Number(fact.timeoutMs) || 0),
    background: fact.background === true,
    at: time(fact.at, Date.now()),
  });
  while (reg.calls.size > MAX_CALLS) reg.calls.delete(reg.calls.keys().next().value);
}

function taskFor(reg, taskId, toolUseId, at) {
  const id = plainId(taskId);
  if (!id || reg.cleared.has(id)) return null;
  let task = reg.tasks.get(id);
  if (!task) {
    task = newTask(id, at);
    reg.tasks.set(id, task);
  }
  const callId = plainId(toolUseId);
  if (callId && !task.toolUseId) task.toolUseId = callId;
  const call = task.toolUseId ? reg.calls.get(task.toolUseId) : null;
  if (call) {
    task.type = call.type;
    if (!task.description) task.description = call.description;
    if (!task.command) task.command = call.command;
    if (!task.timeoutMs && call.timeoutMs) task.timeoutMs = call.timeoutMs;
    if (call.at && call.at < task.startedAt) task.startedAt = call.at;
  }
  return task;
}

function trimFinished(reg) {
  const finished = [...reg.tasks.values()].filter(isBgFinished).sort((a, b) => a.endedAt - b.endedAt);
  for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_TASKS))) reg.tasks.delete(old.id);
}

/**
 * Fold one fact into the registry.
 * @returns {{ task: object|null, notice: object|null }} what changed; `notice` (for a notice fact) carries
 * `stale: true` when its task had already ended before it arrived
 */
export function applyBgFact(reg, fact, now = Date.now()) {
  const none = { task: null, notice: null };
  if (!reg || !fact || typeof fact !== 'object') return none;
  const at = time(fact.at, now);
  let task = null;
  let notice = null;
  switch (fact.kind) {
    case 'call':
      rememberCall(reg, fact);
      return none;
    case 'result': {
      const call = reg.calls.get(plainId(fact.toolUseId));
      // Only a call that went to the background has a task id in its result.
      if (!call || fact.isError || !plainId(fact.taskId)) return none;
      task = taskFor(reg, fact.taskId, fact.toolUseId, at);
      if (!task) return none;
      if (fact.outputFile && !task.outputFile) task.outputFile = String(fact.outputFile).slice(0, 4096);
      if (Number(fact.timeoutMs) > 0) task.timeoutMs = Number(fact.timeoutMs);
      if (fact.persistent === true) task.persistent = true;
      break;
    }
    case 'started': {
      const kind = kindOfTaskType(fact.type);
      const known = reg.tasks.has(plainId(fact.taskId)) || reg.calls.has(plainId(fact.toolUseId));
      // Agents, workflows and MCP tasks have cards of their own: only shells and watches are listed.
      if (!kind && !known) return none;
      task = taskFor(reg, fact.taskId, fact.toolUseId, at);
      if (!task) return none;
      if (kind && !reg.calls.has(task.toolUseId)) task.type = kind;
      if (!task.description && fact.description) task.description = clip(fact.description, 200);
      break;
    }
    case 'notice': {
      const id = plainId(fact.taskId);
      if (!id) return none;
      // One delivery is folded once (a stream can say it twice: as it is queued and as it is read).
      if (fact.uid) {
        if (reg.seen.has(fact.uid)) return none;
        reg.seen.add(fact.uid);
        if (reg.seen.size > 2000) reg.seen.delete(reg.seen.values().next().value);
      }
      const existed = reg.tasks.get(id);
      const wasFinished = isBgFinished(existed);
      // A notice for a task that is not a shell or a watch of this registry (an agent's report) is not listed.
      if (!existed && !reg.calls.has(plainId(fact.toolUseId)) && !fact.event && !/^(?:background command|monitor)\b/i.test(String(fact.summary || ''))) return none;
      task = taskFor(reg, id, fact.toolUseId, at);
      if (!task) return none;
      if (!reg.calls.has(task.toolUseId) && (fact.event || /^monitor\b/i.test(String(fact.summary || '')))) task.type = 'watch';
      if (fact.outputFile && !task.outputFile) task.outputFile = String(fact.outputFile).slice(0, 4096);
      const status = String(fact.status || '').toLowerCase();
      if (fact.event) {
        task.eventCount += 1;
        task.lastEvent = clip(String(fact.event).split('\n').filter(Boolean).pop() || '', 200);
        task.events.push({ at, text: String(fact.event).slice(0, MAX_EVENT) });
        if (task.events.length > MAX_TASK_EVENTS) task.events.splice(0, task.events.length - MAX_TASK_EVENTS);
      }
      const isFinal = status === 'completed' || status === 'failed' || status === 'stopped' || status === 'killed';
      // After the end, a summary is only taken from another final report (a late event keeps the end's words).
      if (fact.summary && (!wasFinished || isFinal)) task.summary = clip(fact.summary);
      if (isFinal) {
        const code = exitCodeOf(fact.summary);
        if (code != null) task.exitCode = code;
        let end = status === 'killed' ? 'stopped' : status;
        if (task.type === 'watch' && saysExpired(fact.summary)) end = 'expired';
        if (!wasFinished) finish(task, end, at);
        if (end === 'stopped' && !task.stoppedBy) task.stoppedBy = fact.reason === 'worker_restart' ? '' : 'agent';
      }
      notice = {
        taskId: id, type: task.type, description: task.description, status: status || (fact.event ? 'event' : ''),
        summary: clip(fact.summary), event: fact.event ? clip(fact.event, 600) : '', exitCode: task.exitCode,
        // Something the task reported after it had ended (a watch's event behind its end) is stale; the same end
        // told twice (the SDK's own report and the queued one) is a repeat, which a transcript shows once.
        stale: wasFinished && !isFinal, repeat: wasFinished && isFinal, at,
      };
      break;
    }
    case 'updated': {
      task = reg.tasks.get(plainId(fact.taskId)) || null;
      if (!task) return none;
      const status = String(fact.status || '').toLowerCase();
      if (fact.error) task.error = clip(fact.error);
      if ((status === 'completed' || status === 'failed' || status === 'killed') && !isBgFinished(task)) {
        finish(task, status === 'killed' ? 'stopped' : status, time(fact.endedAt, at));
      }
      break;
    }
    case 'live': {
      // The provider's whole live set: a task in it runs; one it no longer names has ended (its own notice may
      // never come when the process is gone). A task the registry learnt about while no live set was known yet
      // (rebuilt from a transcript: 'unknown') is decided by the first set either way.
      const list = Array.isArray(fact.tasks) ? fact.tasks : [];
      const live = new Set(list.map(t => plainId(t?.id)).filter(Boolean));
      reg.liveSeen = true;
      let changed = false;
      for (const t of reg.tasks.values()) {
        if (live.has(t.id)) {
          if (t.status === 'unknown') { t.status = 'running'; changed = true; }
          t.seenLive = true;
          continue;
        }
        if (t.status === 'unknown' || (t.status === 'running' && t.seenLive)) { finish(t, 'ended', at); changed = true; }
      }
      // A live shell or watch this registry has no entry for (a page that started after it did) gets one.
      for (const t of list) {
        const id = plainId(t?.id);
        const kind = kindOfTaskType(t?.type);
        if (!id || !kind || t?.ambient === true && kind !== 'watch' || reg.tasks.has(id) || reg.cleared.has(id)) continue;
        const entry = newTask(id, at);
        entry.type = kind;
        entry.description = clip(t.description || '', 200);
        entry.seenLive = true;
        reg.tasks.set(id, entry);
        changed = true;
      }
      if (changed) reg.version += 1;
      trimFinished(reg);
      return { task: null, notice: null, changed };
    }
    case 'stopping': {
      task = reg.tasks.get(plainId(fact.taskId)) || null;
      if (!task) return none;
      task.stoppedBy = fact.by === 'agent' ? 'agent' : 'owner';
      task.stopError = '';
      if (isBgRunning(task)) task.stopping = true;
      break;
    }
    case 'stop-failed': {
      task = reg.tasks.get(plainId(fact.taskId)) || null;
      if (!task) return none;
      task.stopping = false;
      if (task.stoppedBy === 'owner' && isBgRunning(task)) task.stoppedBy = '';
      task.stopError = clip(fact.error || 'unknown error', 200);
      break;
    }
    case 'ended-all': {
      let changed = false;
      for (const t of reg.tasks.values()) if (isBgRunning(t)) { finish(t, 'ended', at); changed = true; }
      if (changed) reg.version += 1;
      return { task: null, notice: null, changed };
    }
    default:
      return none;
  }
  reg.version += 1;
  trimFinished(reg);
  return { task, notice };
}

/** How many tasks still run (the badge). */
export function runningBgCount(reg) {
  let n = 0;
  for (const t of reg?.tasks?.values?.() || []) if (isBgRunning(t)) n += 1;
  return n;
}

/** Forget the finished tasks (until the tab closes, a rebuild does not bring them back). @returns how many */
export function clearFinishedBg(reg) {
  let n = 0;
  for (const t of [...(reg?.tasks?.values?.() || [])]) {
    if (!isBgFinished(t)) continue;
    reg.tasks.delete(t.id);
    reg.cleared.add(t.id);
    n += 1;
  }
  if (n) reg.version += 1;
  return n;
}

/** "42s", "3m 05s", "1h 02m". */
export function fmtBgDuration(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const STATUS_KEYS = { running: 'statusRunning', completed: 'statusCompleted', failed: 'statusFailed', stopped: 'statusStopped', expired: 'statusExpired', ended: 'statusEnded', unknown: 'statusUnknown' };

/**
 * The rows of the view: running first (newest first), then what finished (newest first). Words are copy keys,
 * so a panel shows them in its locale: `{ key, params }`.
 */
export function bgTaskRows(reg, now = Date.now()) {
  const list = [...(reg?.tasks?.values?.() || [])];
  list.sort((a, b) => (isBgRunning(a) ? 0 : 1) - (isBgRunning(b) ? 0 : 1)
    || (isBgRunning(a) ? b.startedAt - a.startedAt : (b.endedAt || 0) - (a.endedAt || 0)));
  return list.map((t) => {
    const running = isBgRunning(t);
    const elapsed = running ? now - t.startedAt : ((t.endedAt || now) - t.startedAt);
    let note = null;
    if (t.stopping) note = { key: 'stopping' };
    else if (t.status === 'stopped' && t.stoppedBy === 'owner') note = { key: 'stoppedByOwner' };
    else if (t.status === 'stopped' && t.stoppedBy === 'agent') note = { key: 'stoppedByAgent' };
    else if (t.stopError) note = { key: 'stopFailed', params: { error: t.stopError } };
    else if (t.status === 'ended') note = { key: 'ended' };
    let expires = null;
    if (running && t.type === 'watch' && t.timeoutMs > 0 && !t.persistent) {
      const left = t.startedAt + t.timeoutMs - now;
      if (left > 0) expires = { key: 'expiresIn', params: { time: fmtBgDuration(left) } };
    }
    return {
      id: t.id,
      type: t.type,
      kindKey: t.type === 'watch' ? 'kindWatch' : 'kindShell',
      description: t.description || t.command || t.id,
      command: t.command,
      status: t.status,
      statusKey: STATUS_KEYS[t.status] || 'statusUnknown',
      running,
      finished: !running,
      canStop: running && !t.stopping,
      duration: elapsed > 0 ? fmtBgDuration(elapsed) : '',
      exitCode: t.exitCode,
      summary: t.summary,
      note,
      expires,
      eventCount: t.eventCount,
      lastEvent: t.lastEvent,
      events: t.events.slice(),
      hasOutput: !!t.outputFile,
    };
  });
}

/** One line for a task-notification card in the transcript: `{ key, params, stale }` plus the plain fields. */
export function noticeCardView(notice, task = null) {
  if (!notice) return null;
  const kindKey = (task?.type || notice.type) === 'watch' ? 'kindWatch' : 'kindShell';
  const isEvent = !!notice.event && !['completed', 'failed', 'stopped', 'killed'].includes(notice.status);
  const status = notice.status === 'killed' ? 'stopped' : notice.status;
  return {
    taskId: notice.taskId,
    kindKey,
    isEvent,
    statusKey: isEvent ? '' : (STATUS_KEYS[(task?.type === 'watch' && saysExpired(notice.summary)) ? 'expired' : status] || ''),
    description: task?.description || notice.description || notice.summary || notice.taskId,
    detail: isEvent ? String(notice.event).split('\n').filter(Boolean).pop() || '' : (notice.summary || ''),
    exitCode: notice.exitCode,
    stale: !!notice.stale,
  };
}

/** What a panel keeps between reloads besides the transcript: which finished tasks were cleared, which the owner stopped. */
export function bgPrefsOf(reg) {
  const ownerStopped = [...(reg?.tasks?.values?.() || [])].filter(t => t.stoppedBy === 'owner').map(t => t.id);
  return { cleared: [...(reg?.cleared || [])].slice(-200), ownerStopped: ownerStopped.slice(-200) };
}

/** Put a registry rebuilt by the server (`serializeBgRegistry`) under this one, keeping what the page knew. */
export function mergeRebuiltBg(reg, rebuilt, prefs = null) {
  if (!reg || !rebuilt) return false;
  for (const id of Array.isArray(prefs?.cleared) ? prefs.cleared : []) { const p = plainId(id); if (p) reg.cleared.add(p); }
  const owner = new Set((Array.isArray(prefs?.ownerStopped) ? prefs.ownerStopped : []).map(plainId).filter(Boolean));
  let changed = false;
  for (const raw of Array.isArray(rebuilt.tasks) ? rebuilt.tasks : []) {
    const id = plainId(raw?.id);
    if (!id || reg.cleared.has(id)) continue;
    const mine = reg.tasks.get(id);
    const incoming = { ...newTask(id, time(raw.startedAt, Date.now())), ...pickTask(raw) };
    if (owner.has(id) && incoming.status === 'stopped') incoming.stoppedBy = 'owner';
    if (!mine) {
      // A task the transcript has no end for runs only if the live set says so.
      if (incoming.status === 'running') incoming.status = reg.liveSeen ? 'ended' : 'unknown';
      if (incoming.status === 'ended' && !incoming.endedAt) incoming.endedAt = Date.now();
      reg.tasks.set(id, incoming);
      changed = true;
      continue;
    }
    // What the page saw live is newer; the transcript fills what it lacks (events before the reload, the path).
    if (!mine.outputFile && incoming.outputFile) { mine.outputFile = incoming.outputFile; changed = true; }
    if (!mine.command && incoming.command) { mine.command = incoming.command; changed = true; }
    if (!mine.description && incoming.description) { mine.description = incoming.description; changed = true; }
    if (incoming.eventCount > mine.eventCount) {
      mine.eventCount = incoming.eventCount; mine.events = incoming.events; mine.lastEvent = incoming.lastEvent; changed = true;
    }
    if (isBgFinished(incoming) && !isBgFinished(mine)) {
      Object.assign(mine, { status: incoming.status, endedAt: incoming.endedAt, exitCode: incoming.exitCode, summary: incoming.summary, stopping: false });
      if (owner.has(id) && incoming.status === 'stopped') mine.stoppedBy = 'owner';
      changed = true;
    }
    if (owner.has(id) && mine.status === 'stopped') mine.stoppedBy = 'owner';
  }
  if (changed) { reg.version += 1; trimFinished(reg); }
  return changed;
}

const TASK_FIELDS = ['type', 'toolUseId', 'description', 'command', 'outputFile', 'startedAt', 'endedAt', 'status', 'exitCode', 'summary', 'error', 'eventCount', 'lastEvent', 'timeoutMs', 'persistent', 'stoppedBy'];

function pickTask(raw) {
  const out = {};
  for (const k of TASK_FIELDS) if (raw[k] !== undefined) out[k] = raw[k];
  out.type = raw.type === 'watch' ? 'watch' : 'shell';
  out.status = RUNNING.has(raw.status) || FINISHED.has(raw.status) ? raw.status : 'running';
  out.events = (Array.isArray(raw.events) ? raw.events : []).slice(-MAX_TASK_EVENTS).map(e => ({ at: time(e?.at, 0), text: String(e?.text ?? '').slice(0, MAX_EVENT) }));
  out.exitCode = Number.isFinite(raw.exitCode) ? raw.exitCode : null;
  return out;
}

/** The registry as JSON (the server's rebuild, a test's snapshot). */
export function serializeBgRegistry(reg) {
  return {
    tasks: [...(reg?.tasks?.values?.() || [])].map((t) => {
      const out = {};
      for (const k of TASK_FIELDS) out[k] = t[k];
      out.events = t.events.slice(-MAX_TASK_EVENTS);
      out.id = t.id;
      return out;
    }),
  };
}
