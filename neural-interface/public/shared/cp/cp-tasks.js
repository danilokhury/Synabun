// ── Background tasks card (DOM glue over cp-tasks-model.js) ──

import { cpCtx } from './cp-ctx.js';
import { taskRows } from './cp-tasks-model.js';

/**
 * The tab's tasks and scheduled wakeups, with a stop control per running task.
 * @param o.canControl  the bridge accepts stop_task / background_tasks
 * @param o.controlNote one line shown instead of the controls when a running task cannot be stopped from here
 * @param o.onStop      (taskId) => void
 * @param o.onBackground (toolUseId) => void
 */
export function renderTasksCard(tab, o = {}) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return null;
  $msgs.querySelectorAll('.cp-tasks-card').forEach(n => n.remove());
  const el = document.createElement('div');
  el.className = 'msg msg-info-card cp-tasks-card';
  const body = document.createElement('div');
  body.className = 'cp-info-body';
  const title = document.createElement('div');
  title.className = 'cp-info-title';
  title.textContent = 'Background work';
  body.appendChild(title);

  const rows = taskRows(tab.tasks);
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'cp-info-row muted';
    const live = (tab.backgroundWork || []).length;
    none.textContent = live ? `${live} task${live === 1 ? '' : 's'} running (details arrive with their next update).` : 'Nothing is running in the background.';
    body.appendChild(none);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = `cp-task-row${r.running ? ' cp-task-running' : ''}`;
    row.dataset.taskId = r.id;
    const head = document.createElement('div');
    head.className = 'cp-task-head';
    const name = document.createElement('span');
    name.className = 'cp-task-title';
    name.textContent = r.title;
    const status = document.createElement('span');
    status.className = `cp-chip${r.running ? ' cp-chip-info' : (r.status === 'completed' ? ' cp-chip-ok' : ' cp-chip-warn')}`;
    status.textContent = r.status;
    head.append(name, status);
    if (r.running && o.canControl) {
      if (r.foreground && r.toolUseId) {
        const bg = document.createElement('button');
        bg.type = 'button';
        bg.className = 'cp-engine-retry cp-task-bg';
        bg.textContent = 'Send to background';
        bg.addEventListener('click', () => { bg.disabled = true; o.onBackground?.(r.toolUseId); });
        head.appendChild(bg);
      }
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'cp-engine-retry cp-task-stop';
      stop.textContent = 'Stop';
      stop.addEventListener('click', () => { stop.disabled = true; o.onStop?.(r.id); });
      head.appendChild(stop);
    }
    row.appendChild(head);
    for (const [cls, text] of [['cp-task-line', r.line], ['cp-task-stats', r.stats]]) {
      if (!text) continue;
      const line = document.createElement('div');
      line.className = cls;
      line.textContent = text;
      row.appendChild(line);
    }
    body.appendChild(row);
  }
  if (!o.canControl && o.controlNote && rows.some(r => r.running)) {
    const note = document.createElement('div');
    note.className = 'cp-info-row muted cp-task-note';
    note.textContent = o.controlNote;
    body.appendChild(note);
  }

  const crons = Array.isArray(tab.sessionCrons) ? tab.sessionCrons : [];
  if (crons.length) {
    const label = document.createElement('div');
    label.className = 'cp-help-section-label';
    label.textContent = 'Scheduled for this session';
    body.appendChild(label);
    for (const c of crons) {
      const row = document.createElement('div');
      row.className = 'cp-task-row';
      const head = document.createElement('div');
      head.className = 'cp-task-head';
      const name = document.createElement('span');
      name.className = 'cp-task-title';
      name.textContent = `${c.schedule}${c.recurring ? ' (recurring)' : ''}`;
      head.appendChild(name);
      const line = document.createElement('div');
      line.className = 'cp-task-line';
      line.textContent = c.prompt;
      row.append(head, line);
      body.appendChild(row);
    }
  }

  el.appendChild(body);
  $msgs.appendChild(el);
  if (tab === cpCtx.activeTab()) cpCtx.scrollEnd();
  return el;
}
