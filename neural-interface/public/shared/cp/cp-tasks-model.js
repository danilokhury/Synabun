// ── Background tasks, hooks and message provenance (DOM-free) ──
// The CLI reports every task it runs for a session (subagents, shells,
// monitors, workflows, MCP tasks) with task_started / task_progress /
// task_updated / task_notification. This module keeps the tab's task map from
// those events, and reads hook events and message origins into display text.

import { fmtTokens, fmtDuration } from './cp-events.js';

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const TYPE_LABELS = { local_agent: 'agent', local_bash: 'shell', local_workflow: 'workflow', remote_agent: 'remote agent', mcp_task: 'MCP task', monitor: 'monitor' };
const DONE = new Set(['completed', 'failed', 'stopped', 'killed', 'ended']);
const MAX_FINISHED = 20;

/**
 * Apply one task event to the tab's task map (task_id → task).
 * @returns the task that changed, or null when the event was not a task event.
 */
export function reduceTaskEvent(tasks, ev, now = Date.now()) {
  if (!(tasks instanceof Map) || ev?.type !== 'system' || !ev.task_id) return null;
  const id = String(ev.task_id);
  const prev = tasks.get(id);
  const base = prev || { id, type: '', description: '', status: 'running', background: false, toolUseId: '', startedAt: now, tokens: 0, toolUses: 0, lastTool: '', summary: '', ambient: false, error: '', outputFile: '', endedAt: 0 };
  let task = base;
  switch (ev.subtype) {
    case 'task_started':
      task = {
        ...base,
        type: TYPE_LABELS[ev.task_type] || ev.task_type || (ev.subagent_type ? 'agent' : 'task'),
        description: clip(ev.description || ev.workflow_name || '', 200),
        agentType: ev.subagent_type || '',
        toolUseId: ev.tool_use_id || base.toolUseId,
        background: ev.is_backgrounded === true,
        ambient: ev.ambient === true || ev.skip_transcript === true,
        status: 'running',
      };
      break;
    case 'task_progress':
      task = {
        ...base,
        description: base.description || clip(ev.description || '', 200),
        agentType: base.agentType || ev.subagent_type || '',
        toolUseId: ev.tool_use_id || base.toolUseId,
        tokens: Number(ev.usage?.total_tokens) || base.tokens,
        toolUses: Number(ev.usage?.tool_uses) || base.toolUses,
        durationMs: Number(ev.usage?.duration_ms) || base.durationMs || 0,
        lastTool: ev.last_tool_name || base.lastTool,
        summary: ev.summary ? clip(ev.summary, 200) : base.summary,
      };
      break;
    case 'task_updated': {
      const p = ev.patch && typeof ev.patch === 'object' ? ev.patch : {};
      task = {
        ...base,
        ...(p.status ? { status: p.status === 'killed' ? 'stopped' : p.status } : {}),
        ...(p.description ? { description: clip(p.description, 200) } : {}),
        ...(typeof p.is_backgrounded === 'boolean' ? { background: p.is_backgrounded } : {}),
        ...(p.error ? { error: clip(p.error, 300) } : {}),
        ...(p.end_time ? { endedAt: Number(p.end_time) } : {}),
      };
      break;
    }
    case 'task_notification':
      task = {
        ...base,
        toolUseId: ev.tool_use_id || base.toolUseId,
        status: ev.status || 'completed',
        summary: ev.summary ? clip(ev.summary, 300) : base.summary,
        tokens: Number(ev.usage?.total_tokens) || base.tokens,
        toolUses: Number(ev.usage?.tool_uses) || base.toolUses,
        durationMs: Number(ev.usage?.duration_ms) || base.durationMs || 0,
        outputFile: ev.output_file || base.outputFile,
        ambient: base.ambient || ev.ambient === true || ev.skip_transcript === true,
        endedAt: now,
      };
      break;
    default:
      return null;
  }
  if (DONE.has(task.status) && !task.endedAt) task.endedAt = now;
  tasks.set(id, task);
  // Finished tasks are kept for a while, oldest dropped first.
  const finished = [...tasks.values()].filter(t => DONE.has(t.status)).sort((a, b) => a.endedAt - b.endedAt);
  for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) tasks.delete(old.id);
  return task;
}

export const isTaskRunning = (task) => !!task && !DONE.has(task.status);

/**
 * background_tasks_changed lists every live background task. A background task
 * the list once carried and no longer does has ended (its own notification may
 * never come: the CLI process can be gone).
 */
export function reconcileTasks(tasks, liveTasks, now = Date.now()) {
  if (!(tasks instanceof Map)) return 0;
  const live = new Set((Array.isArray(liveTasks) ? liveTasks : []).map(t => String(t?.task_id || '')).filter(Boolean));
  let ended = 0;
  for (const task of tasks.values()) {
    if (!isTaskRunning(task)) continue;
    if (live.has(task.id)) { task.seenLive = true; task.background = true; continue; }
    if (!task.seenLive) continue;
    task.status = 'ended';
    task.endedAt = now;
    ended++;
  }
  return ended;
}

/**
 * The live list is the authority on what runs in the background. A tab that was
 * reloaded starts with an empty map and may never see another event for a task
 * that is already running: build its entry from the list, so the card can show
 * it and stop it. A task the map already tracks keeps its own, richer data.
 * @returns how many entries were added
 */
export function adoptLiveTasks(tasks, liveTasks, now = Date.now()) {
  if (!(tasks instanceof Map)) return 0;
  let added = 0;
  for (const t of Array.isArray(liveTasks) ? liveTasks : []) {
    const id = t?.task_id ? String(t.task_id) : '';
    if (!id || tasks.has(id)) continue;
    tasks.set(id, {
      id,
      type: TYPE_LABELS[t.task_type] || t.task_type || 'task',
      description: clip(t.description || '', 200),
      status: 'running',
      background: true,
      seenLive: true,
      toolUseId: t.tool_use_id || '',
      startedAt: now,
      tokens: 0,
      toolUses: 0,
      lastTool: '',
      summary: '',
      ambient: t.ambient === true,
    });
    added++;
  }
  return added;
}

/** Rows of the tasks card: running first (newest first), then what finished. */
export function taskRows(tasks, now = Date.now()) {
  const list = [...(tasks instanceof Map ? tasks.values() : [])].filter(t => !t.ambient);
  const rank = (t) => (isTaskRunning(t) ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b) || (b.startedAt - a.startedAt));
  return list.map((t) => {
    const stats = [];
    if (t.tokens > 0) stats.push(`${fmtTokens(t.tokens)} tokens`);
    if (t.toolUses > 0) stats.push(`${t.toolUses} tool use${t.toolUses === 1 ? '' : 's'}`);
    const elapsed = isTaskRunning(t) ? now - t.startedAt : (t.durationMs || (t.endedAt ? t.endedAt - t.startedAt : 0));
    if (elapsed > 0) stats.push(fmtDuration(elapsed));
    return {
      id: t.id,
      title: `${t.agentType || t.type || 'task'}${t.description ? `: ${t.description}` : ''}`,
      status: t.status === 'running' && !t.background ? 'running (foreground)' : t.status,
      running: isTaskRunning(t),
      foreground: isTaskRunning(t) && !t.background,
      toolUseId: t.toolUseId,
      line: t.error || t.summary || (isTaskRunning(t) && t.lastTool ? `using ${t.lastTool}` : ''),
      stats: stats.join(' · '),
    };
  });
}

/** One line for an agent card while its task runs. */
export function taskProgressLine(task) {
  if (!task) return '';
  const head = task.summary || (task.lastTool ? `using ${task.lastTool}` : '');
  const stats = [task.tokens > 0 ? `${fmtTokens(task.tokens)} tokens` : '', task.toolUses > 0 ? `${task.toolUses} tools` : ''].filter(Boolean).join(' · ');
  return [head, stats].filter(Boolean).join(' · ');
}

// ── Hooks ──

/**
 * A hook that ran, as the hook strip shows it. Output is hook-authored text
 * (it can carry injected context): cut short, shown only on demand.
 */
export function hookEntry(ev, startedAt = 0, now = Date.now()) {
  const outcome = ev?.outcome || 'success';
  const parts = [ev?.hook_name || 'hook'];
  if (outcome !== 'success') parts.push(outcome);
  if (Number.isFinite(ev?.exit_code) && ev.exit_code !== 0) parts.push(`exit ${ev.exit_code}`);
  if (startedAt && now - startedAt >= 1000) parts.push(fmtDuration(now - startedAt));
  const output = String(ev?.output || ev?.stdout || ev?.stderr || '').trim();
  return {
    event: String(ev?.hook_event || 'Hook'),
    detail: parts.join(' · '),
    output: clip(output, 600),
    outcome,
    real: true,
  };
}

// ── Where a turn came from ──

const TASK_NOTIFICATION = {
  'scheduled-trigger': 'A scheduled wakeup started this turn',
  'peer-send-message': 'A message from another session started this turn',
  'projects-relay': 'A project relay started this turn',
  'session-inbox': 'A session inbox message started this turn',
};

/** A line for a turn nobody typed (empty for a typed prompt or an unknown origin). */
export function describeOrigin(origin) {
  const o = origin && typeof origin === 'object' ? origin : null;
  if (!o || o.kind === 'human') return '';
  switch (o.kind) {
    case 'task-notification':
      return `${TASK_NOTIFICATION[o.subkind] || 'A background task reported back and started this turn'}${o.fireReason ? ` (${clip(o.fireReason, 80)})` : ''}.`;
    case 'channel': return `A message from the ${clip(o.server || 'channel', 60)} channel started this turn.`;
    case 'peer': return `A message from ${clip(o.name || o.from || 'another session', 60)} started this turn.`;
    case 'coordinator': return 'The team coordinator started this turn.';
    case 'observer': return `An observer (${clip(o.from || '', 60)}) started this turn.`;
    case 'auto-continuation': return 'Claude continued on its own.';
    default: return '';
  }
}

// ── Replayed history: the rows that are neither a prompt nor a reply ──

/**
 * A `system` row of GET …/messages as the transcript shows it:
 * { kind: 'status' | 'warn' | 'error' | 'output', text }, or null for a row
 * this panel has nothing to say about.
 */
export function describeHistorySystemRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  if (r.role !== 'system') return null;
  switch (r.subtype) {
    case 'origin': {
      const text = describeOrigin(r.origin);
      return text ? { kind: 'status', text } : null;
    }
    case 'informational': {
      const text = String(r.text || '').trim();
      if (!text) return null;
      return { kind: r.level === 'warning' || r.level === 'prevent_continuation' ? 'warn' : (r.level === 'error' ? 'error' : 'status'), text };
    }
    case 'local_command_output': {
      const text = String(r.text || '');
      return text.trim() ? { kind: 'output', text, isError: r.isError === true } : null;
    }
    default:
      return null;
  }
}

// ── What a restart of the session's process ends ──

const brief = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Background tasks and scheduled wake-ups live in the CLI process: ending it
 * (as "Forget this session's rules" does) ends them. This names them, from
 * what the tab knows (`tasks`: its task entries; `live`: the CLI's own list of
 * background tasks; `crons`: the scheduled wake-ups), so the panel can ask
 * before it does that.
 * @returns {{ tasks: string[], wakeups: string[], sentence: string }} `sentence` is '' when nothing would end
 */
export function workEndedByRestart({ tasks = null, live = [], crons = [] } = {}) {
  const named = new Map();
  for (const t of tasks instanceof Map ? tasks.values() : []) {
    if (!t || t.ambient || !isTaskRunning(t)) continue;
    named.set(String(t.id || named.size), brief(t.description || t.agentType || t.type || 'task', 60));
  }
  for (const t of Array.isArray(live) ? live : []) {
    if (!t || t.ambient) continue;
    const id = String(t.task_id || t.id || `live-${named.size}`);
    if (!named.has(id)) named.set(id, brief(t.description || t.task_type || 'task', 60));
  }
  const taskNames = [...named.values()];
  const wakeups = (Array.isArray(crons) ? crons : []).map(c => brief([c?.schedule, c?.prompt].filter(Boolean).join(': ') || 'wake-up', 60));
  const parts = [];
  if (taskNames.length) parts.push(`${taskNames.length} background task${taskNames.length === 1 ? '' : 's'} (${taskNames.slice(0, 3).join('; ')}${taskNames.length > 3 ? '; …' : ''})`);
  if (wakeups.length) parts.push(`${wakeups.length} scheduled wake-up${wakeups.length === 1 ? '' : 's'} (${wakeups.slice(0, 3).join('; ')}${wakeups.length > 3 ? '; …' : ''})`);
  return { tasks: taskNames, wakeups, sentence: parts.length ? `This also ends ${parts.join(' and ')}.` : '' };
}
