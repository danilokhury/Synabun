// ─────────────────────────────────────────────────────────────────────────────
// Claude Code → background-task facts (no DOM)
//
// The one adapter between Claude Code and the provider-free registry
// (bg-tasks-model.js). It reads the same things from the two places they come
// from: an Agent SDK message on its way to a panel (`tool_use_result`, a user
// message with `origin.kind: 'task-notification'`, system task events), and a
// line of the session's transcript (`toolUseResult`, `queue-operation` lines).
// The page folds live messages, the server (lib/claude-bg-tasks.js) folds the
// transcript, and both get the same registry.
//
// What the CLI says, as checked on 2.1.33x:
//   Bash run_in_background → toolUseResult.backgroundTaskId, and the result text
//     "Command running in background with ID: b7l…. Output is being written to: /…/tasks/b7l….output. …"
//   Monitor → toolUseResult { taskId, timeoutMs, persistent }, text "Monitor started (task bku…, expires in 20s …)"
//   every event, end and expiry → a queued <task-notification> (task-id, tool-use-id, output-file, status,
//     summary, event), and the SDK's system/task_notification for the end
// ─────────────────────────────────────────────────────────────────────────────

import { parseTaskNotifications, kindOfTaskType } from './bg-tasks-model.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const at = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : undefined; };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (typeof b === 'string' ? b : (b?.type === 'text' ? (b.text || '') : ''))).filter(Boolean).join('\n');
}

/** The output file a result's text names ("Output is being written to: <path>."). */
export function outputFileOf(text) {
  const m = /Output is being written to:\s*(\S+?\.output)\b/i.exec(String(text || ''));
  return m ? m[1] : '';
}

/** The task id a result names: the typed field first, then the sentence the CLI prints. */
export function resultTaskIdOf(typed, text) {
  const s = obj(typed);
  if (s && typeof s.backgroundTaskId === 'string' && s.backgroundTaskId) return s.backgroundTaskId;
  if (s && typeof s.taskId === 'string' && s.taskId) return s.taskId;
  const src = String(text || '');
  const m = /running in background with ID:?\s*([A-Za-z0-9_-]{4,})/i.exec(src) || /Monitor started \(task\s+([A-Za-z0-9_-]{4,})/i.exec(src);
  return m ? m[1] : '';
}

function callFacts(content, when) {
  const facts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type !== 'tool_use' || !b.id) continue;
    const i = obj(b.input) || {};
    if (b.name === 'Bash') {
      facts.push({ kind: 'call', toolUseId: b.id, type: 'shell', description: i.description || '', command: i.command || '', background: i.run_in_background === true, at: when });
    } else if (b.name === 'Monitor') {
      facts.push({ kind: 'call', toolUseId: b.id, type: 'watch', description: i.description || '', command: i.command || i.ws?.url || '', timeoutMs: i.timeout_ms, at: when });
    } else if ((b.name === 'TaskStop' || b.name === 'KillShell' || b.name === 'KillBash') && (i.task_id || i.shell_id)) {
      facts.push({ kind: 'stopping', taskId: String(i.task_id || i.shell_id), by: 'agent', at: when });
    }
  }
  return facts;
}

function resultFacts(content, typed, when) {
  const facts = [];
  const results = (Array.isArray(content) ? content : []).filter(b => b?.type === 'tool_result' && b.tool_use_id);
  for (const b of results) {
    const text = textOf(b.content);
    // The typed output belongs to the message's one result.
    const own = results.length === 1 ? typed : null;
    const taskId = resultTaskIdOf(own, text);
    if (!taskId) continue;
    const t = obj(own) || {};
    facts.push({
      kind: 'result', toolUseId: b.tool_use_id, taskId, outputFile: outputFileOf(text),
      timeoutMs: Number(t.timeoutMs) || 0, persistent: t.persistent === true, isError: b.is_error === true, at: when,
    });
  }
  return facts;
}

function noticeFacts(text, when, uidBase) {
  return parseTaskNotifications(text).map((n, i) => ({
    kind: 'notice', ...n, at: when, uid: uidBase ? `${uidBase}:${i}` : '',
  }));
}

/**
 * Facts from one Agent SDK message as the bridge relays it (a panel's `event`, the Assistant's packet `event`).
 * Subagents' calls count too: the task ids are the session's.
 */
export function claudeFactsFromEvent(ev, { now = Date.now() } = {}) {
  if (!ev || typeof ev !== 'object') return [];
  switch (ev.type) {
    case 'assistant':
      return callFacts(ev.message?.content, now);
    case 'user': {
      const content = ev.message?.content;
      const facts = resultFacts(content, ev.tool_use_result, now);
      // A turn a background task started (its queued report): the notice, read once per message.
      const text = textOf(content);
      if (text.includes('<task-notification>')) facts.push(...noticeFacts(text, now, ev.uuid ? `u:${ev.uuid}` : ''));
      return facts;
    }
    case 'system':
      switch (ev.subtype) {
        case 'task_started':
          return [{ kind: 'started', taskId: ev.task_id, toolUseId: ev.tool_use_id, type: ev.task_type || '', description: ev.description || '', at: now }];
        case 'task_notification':
          // The end as the SDK reports it. The same end also comes as a queued notice; both fold into one end.
          return [{ kind: 'notice', taskId: ev.task_id, toolUseId: ev.tool_use_id || '', status: ev.status || '', summary: ev.summary || '', outputFile: ev.output_file || '', reason: ev.reason || '', event: '', at: now, uid: ev.uuid ? `n:${ev.uuid}` : '' }];
        case 'task_updated': {
          const p = obj(ev.patch) || {};
          return [{ kind: 'updated', taskId: ev.task_id, status: p.status || '', error: p.error || '', endedAt: p.end_time, at: now }];
        }
        case 'background_tasks_changed':
          return [{ kind: 'live', tasks: (Array.isArray(ev.tasks) ? ev.tasks : []).map(t => ({ id: t?.task_id, type: t?.task_type, description: t?.description, ambient: t?.ambient === true })), at: now }];
        default:
          return [];
      }
    default:
      return [];
  }
}

/** The live set as a reattach reports it (`backgroundTasks` of reattach_result). */
export function claudeLiveFact(tasks, now = Date.now()) {
  return { kind: 'live', tasks: (Array.isArray(tasks) ? tasks : []).map(t => ({ id: t?.task_id || t?.id, type: t?.task_type || t?.type, description: t?.description, ambient: t?.ambient === true })), at: now };
}

/**
 * Facts from one line of a session's transcript (JSONL, parsed). Every report is read from its
 * `queue-operation` enqueue line, the one line each delivery has (the attachment that folds it into a turn
 * repeats it).
 */
export function claudeFactsFromTranscriptLine(line, { now = Date.now() } = {}) {
  if (!line || typeof line !== 'object') return [];
  const when = at(line.timestamp) ?? now;
  if (line.type === 'assistant') return callFacts(line.message?.content, when);
  if (line.type === 'user') return resultFacts(line.message?.content, line.toolUseResult ?? line.tool_use_result, when);
  if (line.type === 'queue-operation' && line.operation === 'enqueue' && typeof line.content === 'string') {
    return noticeFacts(line.content, when, '');
  }
  return [];
}

/** Whether a task type the SDK names is one this view lists. */
export const isListedClaudeTaskType = (type) => !!kindOfTaskType(type);
