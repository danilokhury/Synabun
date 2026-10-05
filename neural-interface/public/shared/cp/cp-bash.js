// ── Bash cards: streaming-style output, exit pill, background task tray ──

import { cpCtx } from './cp-ctx.js';
import { backgroundTaskIdOf } from './cp-tool-results.js';

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
export function stripAnsi(text) { return String(text ?? '').replace(ANSI_RE, ''); }

const MAX_OUT_CHARS = 20000;

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function buildBashCard(block, tab) {
  const { toolIconSvg } = cpCtx;
  const i = block.input || {};
  const isBg = i.run_in_background === true;

  const card = document.createElement('div');
  card.className = 'tool-card cp-bash-card';
  card.dataset.toolId = block.id || '';
  card.dataset.toolName = 'Bash';

  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr';
  const icon = document.createElement('span'); icon.className = 'tool-icon';
  icon.innerHTML = toolIconSvg('Bash');
  const name = document.createElement('span'); name.className = 'tool-name'; name.textContent = 'Bash';
  const detail = document.createElement('span'); detail.className = 'tool-detail';
  detail.textContent = (i.command || '').slice(0, 60);
  hdr.append(icon, name, detail);
  if (isBg) {
    const bg = document.createElement('span');
    bg.className = 'cp-bg-badge';
    bg.textContent = 'bg';
    hdr.appendChild(bg);
  }
  const exitPill = document.createElement('span');
  exitPill.className = 'cp-exit-pill';
  exitPill.hidden = true;
  hdr.appendChild(exitPill);
  const elapsed = document.createElement('span');
  elapsed.className = 'cp-bash-elapsed';
  hdr.appendChild(elapsed);
  const chevron = document.createElement('span'); chevron.className = 'tool-chevron'; chevron.innerHTML = '&#x203A;';
  hdr.appendChild(chevron);
  hdr.addEventListener('click', () => card.classList.toggle('open'));

  const body = document.createElement('div');
  body.className = 'tool-body';
  const cmd = document.createElement('pre');
  cmd.className = 'cp-bash-cmd';
  cmd.textContent = i.command || '';
  body.appendChild(cmd);
  if (i.description) {
    const desc = document.createElement('div');
    desc.className = 'cp-bash-desc';
    desc.textContent = i.description;
    body.appendChild(desc);
  }
  const out = document.createElement('pre');
  out.className = 'cp-bash-out';
  out.hidden = true;
  body.appendChild(out);
  // Hidden generic RESULT section kept for compatibility with updateToolResult fallback paths
  const rLbl = document.createElement('div'); rLbl.className = 'tool-section-label tool-result-label'; rLbl.textContent = 'RESULT'; rLbl.hidden = true;
  const rSec = document.createElement('div'); rSec.className = 'tool-section tool-result-content'; rSec.hidden = true;
  body.append(rLbl, rSec);
  card.append(hdr, body);

  // Elapsed ticker while unresolved
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!card.isConnected || card.dataset.resolved === '1') { clearInterval(timer); elapsed.textContent = card.dataset.resolved === '1' ? elapsed.textContent : ''; return; }
    elapsed.textContent = fmtElapsed(Date.now() - startedAt);
  }, 1000);

  // Background task registration (bgTasks is inherited by agent scopes — root map).
  // A launch replayed from the transcript is history: it is not registered as
  // running (nothing would ever end it). What is still alive comes from the
  // session's own task list (reattach / background_tasks_changed → tab.tasks).
  if (isBg && tab?.bgTasks && !tab._replaying) {
    tab.bgTasks.set(block.id, {
      toolUseId: block.id,
      label: (i.command || '').slice(0, 40),
      status: 'running',
      bashId: null,
      cardEl: card,
      startedAt,
      dismissed: false,           // user-dismissed from the bg-tray chip (hides the pill, keeps the entry so the card still receives its exit pill on completion)
    });
    renderBgTray(tab?._rootTab || tab);
  }
  return card;
}

function extractResultText(ev) {
  let text = '';
  if (Array.isArray(ev.content)) {
    text = ev.content.map(b => (b?.type === 'text' ? (b.text || '') : '')).filter(Boolean).join('\n');
  } else if (typeof ev.content === 'string') {
    text = ev.content;
  }
  return stripAnsi(text);
}

// `view` is the typed result (cp-tool-results.js describeToolResult) when the
// SDK delivered one: stdout apart from stderr, interrupted, the background id.
export function updateBashResult(card, ev, tab, view = null) {
  card.dataset.resolved = '1';
  const out = card.querySelector('.cp-bash-out');
  const exitPill = card.querySelector('.cp-exit-pill');
  const merged = extractResultText(ev);
  // stderr has its own section when the typed result split the streams.
  const text = typeof view?.stdout === 'string' ? stripAnsi(view.stdout) : merged;
  if (out && text) {
    out.hidden = false;
    out.textContent = text.length > MAX_OUT_CHARS ? text.slice(0, MAX_OUT_CHARS) + '\n…(truncated)' : text;
    out.scrollTop = out.scrollHeight;
  }
  if (exitPill) {
    const m = /exit code:?\s+(\d+)/i.exec(merged);
    const code = m ? Number(m[1]) : (ev.is_error ? 1 : 0);
    exitPill.textContent = String(code);
    exitPill.classList.add(code === 0 ? 'cp-exit-ok' : 'cp-exit-err');
    exitPill.hidden = false;
  }
  card.classList.add(ev.is_error ? 'tool-error' : 'tool-ok');

  // Background tasks: the task id the CLI gave this command (the typed result's
  // backgroundTaskId, or "…running in background with ID: b46v84ew2"), so a
  // later TaskStop and the live task list can be tied back to this card. A
  // command the user or the CLI moved to the background after it started has
  // no entry yet. A result replayed from the transcript registers nothing, like
  // its call (buildBashCard): that launch is history, nothing would ever end
  // the entry, and what still runs comes from the session's live task list.
  const bgId = backgroundTaskIdOf(view?.bgTaskId ? { backgroundTaskId: view.bgTaskId } : ev.tool_use_result, merged);
  let task = tab?.bgTasks?.get(ev.tool_use_id);
  if (!task && bgId && view?.bgTaskId && tab?.bgTasks && !tab._replaying) {
    task = {
      toolUseId: ev.tool_use_id,
      label: (card.querySelector('.cp-bash-cmd')?.textContent || 'background command').slice(0, 40),
      status: 'running', bashId: null, cardEl: card, startedAt: Date.now(), dismissed: false,
    };
    tab.bgTasks.set(ev.tool_use_id, task);
  }
  if (task) {
    if (bgId) task.bashId = bgId;
    // A bg Bash tool_result just acknowledges the launch — keep status running.
    renderBgTray(tab?._rootTab || tab);
  }
}

// background_tasks_changed carries every live task: a background command whose
// id is no longer in it has ended.
export function reconcileBgTasks(tab, liveTasks) {
  if (!tab?.bgTasks?.size) return false;
  const live = new Set((Array.isArray(liveTasks) ? liveTasks : []).map(t => t?.task_id).filter(Boolean));
  let changed = false;
  for (const task of tab.bgTasks.values()) {
    if (!task.bashId || task.status !== 'running') continue;
    if (live.has(task.bashId)) { task.seenLive = true; continue; }
    // Only a task the list once carried can be told finished by its absence.
    if (!task.seenLive) continue;
    task.status = 'done';
    changed = true;
  }
  if (changed) renderBgTray(tab);
  return changed;
}

// BashOutput / KillShell / TaskStop awareness: route output to the origin card.
export function handleBgToolUse(block, tab) {
  if (!tab?.bgTasks?.size) return;
  const shellId = block.input?.bash_id || block.input?.shell_id || block.input?.task_id || null;
  if (!shellId) return;
  for (const task of tab.bgTasks.values()) {
    if (task.bashId && (task.bashId === shellId)) {
      task._awaitingOutputToolId = block.id;
      if (block.name === 'KillShell' || block.name === 'TaskStop') {
        task.status = 'stopped';
        renderBgTray(tab);
      }
      return;
    }
  }
}

export function handleBgToolResult(ev, tab) {
  if (!tab?.bgTasks?.size) return false;
  for (const task of tab.bgTasks.values()) {
    if (task._awaitingOutputToolId === ev.tool_use_id) {
      task._awaitingOutputToolId = null;
      const text = extractResultText(ev);
      const out = task.cardEl?.querySelector('.cp-bash-out');
      if (out && text.trim()) {
        out.hidden = false;
        out.textContent = ((out.textContent || '') + '\n' + text).trim().slice(-MAX_OUT_CHARS);
        out.scrollTop = out.scrollHeight;
      }
      if (/\b(completed|exited|killed|failed)\b/i.test(text)) {
        task.status = /killed|failed/i.test(text) ? 'stopped' : 'done';
      }
      renderBgTray(tab?._rootTab || tab);
      return true;
    }
  }
  return false;
}

export function renderBgTray(tab) {
  const { panel, activeTab, scrollEnd } = cpCtx;
  const $panel = panel();
  if (!$panel || tab !== activeTab()) return;
  let tray = $panel.querySelector('#cp-bg-tray');
  if (!tray) {
    const bottom = $panel.querySelector('.cp-bottom');
    if (!bottom) return;
    tray = document.createElement('div');
    tray.id = 'cp-bg-tray';
    tray.className = 'cp-bg-tray';
    bottom.insertBefore(tray, bottom.firstChild);
  }
  const tasks = [...(tab.bgTasks?.values() || [])].filter(t => !t.dismissed);
  if (!tasks.length) { tray.hidden = true; tray.innerHTML = ''; return; }
  tray.hidden = false;
  tray.innerHTML = '';
  for (const task of tasks) {
    const chip = document.createElement('button');
    chip.className = `cp-bg-chip cp-bg-${task.status}`;
    chip.innerHTML = `<span class="cp-bg-dot"></span><span class="cp-bg-label"></span><span class="cp-bg-close" role="button" aria-label="Dismiss background task" title="Dismiss">&times;</span>`;
    chip.querySelector('.cp-bg-label').textContent = task.label;
    chip.title = `${task.label} — ${task.status}`;
    chip.addEventListener('click', (e) => {
      // Skip when the close glyph was hit — its own handler dismisses the chip.
      if (e.target.closest('.cp-bg-close')) return;
      if (task.cardEl?.isConnected) {
        task.cardEl.classList.add('open');
        task.cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    chip.querySelector('.cp-bg-close').addEventListener('click', (e) => {
      e.stopPropagation();
      task.dismissed = true;
      renderBgTray(tab);
    });
    tray.appendChild(chip);
  }
}
