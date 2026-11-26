// ─────────────────────────────────────────────────────────────────────────────
// The Background tasks view (DOM)
//
// One module for every panel that runs an agent with background work: the
// Claude Code side panel and the Assistant panel today, Codex, OpenCode and
// Antigravity once their adapters feed the same registry (bg-tasks-model.js).
// It draws:
//   paintBgBadge(host, count)       the "⟳ N" badge of a header button or a tray pill
//   createBgTasksView({ … })        the list that takes the transcript's place: per task its kind, status,
//                                   time, exit code, its live output (follow, jump to latest, open full output)
//                                   and the events a watch delivered; Stop (asked first) and Clear finished
//   renderBgNoticeCard(view, { … }) a task-notification as a compact card of the transcript
// The output is the OpenCode panel's terminal block and follower (ocp-v2-shell-block.js,
// ocp-v2-shell-logic.js): read in pages from the panel's own route, only while a task is open in a view on
// screen, at most once a second. Everything a task printed goes in as text, never as markup.
// ─────────────────────────────────────────────────────────────────────────────

import { createTerminalBlock } from '../ocp-v2/ocp-v2-shell-block.js';
import { createShellFollower, formatBytes } from '../ocp-v2/ocp-v2-shell-logic.js';
import { BG_TASKS_COPY, bgTaskRows, fillBgCopy, isBgRunning } from './bg-tasks-model.js';
import { BG_RUNNING_ATTR } from '../ui-tray-columns.js';

/** No read of a running task's output comes sooner than this after the last one brought nothing new. */
export const BG_OUTPUT_POLL_MS = 1000;
const BG_OUTPUT_POLL_MAX_MS = 4000;
const STYLE_ID = 'sbt-styles';

export const BG_TASKS_CSS = `
.sbt-scope, .sbt-view, .sbt-notice, .sbt-badge {
  /* DESIGN.md status roles (success, warning, danger); the rest are the app's own tokens. */
  --sbt-ok: #86efac; --sbt-warn: #fbbf24; --sbt-err: #fca5a5;
}
.sbt-badge { display: inline-flex; align-items: center; gap: 3px; font: 500 10px/1 'JetBrains Mono', ui-monospace, monospace;
  color: var(--accent-gold); background: var(--accent-gold-bg); border: 1px solid var(--accent-gold-border);
  border-radius: var(--r-pill); padding: 2px 6px; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.sbt-badge:hover { border-color: var(--accent-gold); }
.sbt-badge[hidden] { display: none; }
.sbt-badge-spin { display: inline-block; animation: sbt-spin 1.6s linear infinite; }
@keyframes sbt-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .sbt-badge-spin { animation: none; } }
.term-minimized-pill .sbt-badge { margin-left: 4px; padding: 1px 5px; font-size: 9px; }
/* On a header button (paintBgBadge corner: true): a notification count on the icon's top-right corner, out of the
   row's flow, so the button keeps its size and the row its height. Gold is DESIGN.md accent, the figure its background;
   the ring is the header's own colour (--sbt-badge-ring, set by each panel) so the count reads on top of the icon. */
.sbt-badge.sbt-badge-corner { position: absolute; top: -4px; right: -5px; z-index: 1; box-sizing: border-box; justify-content: center;
  gap: 0; min-width: 14px; height: 14px; padding: 0 3px; border: 0; border-radius: 7px;
  font: 600 9px/1 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums;
  color: #050505; background: #ffd700; box-shadow: 0 0 0 1.5px var(--sbt-badge-ring, #050505); }
.sbt-badge.sbt-badge-corner .sbt-badge-spin { display: none; }

.sbt-view { display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--t-primary); font-size: var(--fs-xs, 12px); }
.sbt-view[hidden] { display: none; }
/* In place of the transcript: over it, in the same frame (DESIGN.md neutral 900). */
.sbt-overlay { position: absolute; inset: 0; z-index: 6; background: #0a0a0c; border-radius: inherit; }
/* Or in the transcript's own place in a column (the Assistant): it takes the room the transcript had. */
.sbt-inline { flex: 1 1 auto; min-height: 0; height: auto; }
.sbt-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--b-subtle); flex-shrink: 0; }
.sbt-title { font: 600 13px/1.3 'Space Grotesk', Inter, sans-serif; color: var(--t-bright); margin-right: auto; }
.sbt-count { color: var(--t-secondary); font-weight: 400; margin-left: 6px; }
.sbt-btn { font: 500 11px/1 Inter, sans-serif; color: var(--t-primary); background: var(--s-light); border: 1px solid var(--b-light);
  border-radius: 5px; padding: 5px 8px; cursor: pointer; }
.sbt-btn:hover:not(:disabled) { background: var(--s-hover); border-color: var(--b-hover); color: var(--t-bright); }
.sbt-btn:disabled { opacity: .5; cursor: default; }
.sbt-btn[hidden] { display: none; }
.sbt-btn-danger { color: var(--sbt-err); }
.sbt-btn-danger:hover:not(:disabled) { color: var(--sbt-err); border-color: var(--sbt-err); }
.sbt-list { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.sbt-empty { color: var(--t-secondary); padding: 16px 4px; }
.sbt-row { border: 1px solid var(--b-subtle); border-radius: 9px; background: var(--s-subtle); }
.sbt-row.sbt-finished { opacity: .6; }
.sbt-row.sbt-finished:hover, .sbt-row.sbt-finished.sbt-open { opacity: .85; }
.sbt-row.sbt-flash { border-color: var(--accent-gold-border); }
.sbt-row-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 8px; background: none; border: 0; color: inherit;
  font: inherit; text-align: left; cursor: pointer; border-radius: 9px; }
.sbt-row-head:hover { background: var(--s-hover); }
.sbt-row-head:focus-visible { outline: 1px solid #93c5fd; outline-offset: -1px; }
.sbt-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--t-bright); }
.sbt-chip { font: 600 9px/1 'JetBrains Mono', ui-monospace, monospace; padding: 3px 6px; border-radius: 0; background: var(--s-light);
  color: var(--t-secondary); white-space: nowrap; flex-shrink: 0; text-transform: lowercase; }
.sbt-chip-running, .sbt-chip-unknown { color: var(--accent-gold); background: var(--accent-gold-bg); }
.sbt-chip-completed { color: var(--sbt-ok); }
.sbt-chip-failed { color: var(--sbt-err); }
.sbt-chip-stopped, .sbt-chip-expired, .sbt-chip-ended { color: var(--sbt-warn); }
.sbt-chip-stale { color: var(--sbt-warn); }
.sbt-time, .sbt-exit { font: 400 10px/1 'JetBrains Mono', ui-monospace, monospace; color: var(--t-secondary); white-space: nowrap; flex-shrink: 0; }
.sbt-exit-bad { color: var(--sbt-err); }
.sbt-meta { padding: 0 8px 7px 8px; color: var(--t-secondary); display: flex; flex-wrap: wrap; gap: 4px 10px; }
.sbt-meta:empty { display: none; }
.sbt-meta .sbt-last { font-family: 'JetBrains Mono', ui-monospace, monospace; color: var(--t-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.sbt-detail { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 6px; }
.sbt-detail[hidden] { display: none; }
.sbt-cmd { margin: 0; font: 400 11px/1.45 'JetBrains Mono', ui-monospace, monospace; color: var(--t-primary); background: var(--s-light);
  border-radius: 5px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; max-height: 96px; overflow: auto; }
.sbt-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sbt-confirm { color: var(--t-bright); }
.sbt-section { font: 600 10px/1 Inter, sans-serif; color: var(--t-secondary); text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
.sbt-events { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow: auto; }
.sbt-events li { font: 400 11px/1.4 'JetBrains Mono', ui-monospace, monospace; color: var(--t-primary); white-space: pre-wrap; word-break: break-word;
  border-left: 2px solid var(--b-light); padding-left: 6px; }
.sbt-events time { color: var(--t-muted); margin-right: 6px; }
.sbt-term { display: flex; flex-direction: column; gap: 4px; }
.sbt-term-note { display: flex; align-items: center; gap: 8px; color: var(--t-secondary); }
.sbt-term-note[hidden] { display: none; }
.sbt-term-out { margin: 0; font: 400 11px/1.45 'JetBrains Mono', ui-monospace, monospace; color: var(--t-primary); background: rgba(0,0,0,.28);
  border: 1px solid var(--b-subtle); border-radius: 5px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
.sbt-term-out[hidden] { display: none; }
.sbt-term-foot { display: flex; align-items: center; gap: 6px; color: var(--t-secondary); min-height: 20px; }
.sbt-term-state { margin-right: auto; }

.sbt-notice { display: flex; align-items: center; gap: 6px; margin: 4px 0; padding: 5px 8px; border: 1px solid var(--b-subtle); border-radius: 9px;
  background: var(--s-subtle); color: var(--t-secondary); font-size: var(--fs-xs, 12px); cursor: pointer; text-align: left; width: 100%; font-family: inherit; }
.sbt-notice:hover { border-color: var(--b-hover); color: var(--t-primary); }
.sbt-notice:focus-visible { outline: 1px solid #93c5fd; outline-offset: -1px; }
.sbt-notice-icon { color: var(--accent-gold); flex-shrink: 0; }
.sbt-notice-desc { color: var(--t-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.sbt-notice-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; }
.sbt-notice.sbt-stale { opacity: .6; }
`;

/** Puts the view's style sheet in a document once. */
export function installBgTasksStyles(doc = globalThis.document) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = BG_TASKS_CSS;
  doc.head.appendChild(style);
}

/** A translator over the app's i18n `t` that falls back to the English copy. */
export function bgWords(t) {
  return (key, params = {}) => {
    const full = `bgTasks.${key}`;
    let text = '';
    try { text = typeof t === 'function' ? t(full, params) : ''; } catch { text = ''; }
    return text && text !== full ? String(text) : fillBgCopy(key, params);
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The "⟳ N" badge inside `host` (a header button, a tray pill): shown while `count` > 0. A click opens the view
 * (`onClick`) and does not reach the host's own click. `corner`: a header button's form, a count on the icon's corner
 * (above 9 it reads "9+"); without it the badge sits in the host's row (a tray pill).
 */
export function paintBgBadge(host, count, { t = null, onClick = null, corner = false } = {}) {
  if (!host) return null;
  const word = bgWords(t);
  let badge = host.querySelector(':scope > .sbt-badge');
  const n = Math.max(0, Number(count) || 0);
  if (!badge) {
    if (!n) return null;
    badge = el('span', 'sbt-badge');
    badge.setAttribute('role', 'button');
    badge.tabIndex = 0;
    badge.innerHTML = '<span class="sbt-badge-spin" aria-hidden="true">⟳</span><span class="sbt-badge-n"></span>';
    const open = (event) => { event.stopPropagation(); event.preventDefault(); badge._onClick?.(); };
    badge.addEventListener('click', open);
    badge.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(event); });
    const close = host.querySelector(':scope > .term-minimized-pill-close');
    if (close) host.insertBefore(badge, close); else host.appendChild(badge);
  }
  badge._onClick = onClick;
  badge.hidden = !n;
  badge.classList.toggle('sbt-badge-corner', !!corner);
  badge.querySelector('.sbt-badge-n').textContent = corner && n > 9 ? '9+' : String(n);
  const title = word('badgeTitle', { count: n });
  badge.title = title;
  badge.setAttribute('aria-label', title);
  badge.dataset.count = String(n);
  // The tray reads the count on the host itself (ui-tray-columns.js trayColumnOf): Running while it is above 0.
  if (n) { if (host.getAttribute(BG_RUNNING_ATTR) !== String(n)) host.setAttribute(BG_RUNNING_ATTR, String(n)); }
  else if (host.hasAttribute(BG_RUNNING_ATTR)) host.removeAttribute(BG_RUNNING_ATTR);
  return badge;
}

const TERM_CLASSES = Object.freeze({
  wrap: 'sbt-term', note: 'sbt-term-note', noteText: 'sbt-term-note-text', load: 'sbt-btn sbt-term-load',
  out: 'sbt-term-out', foot: 'sbt-term-foot', state: 'sbt-term-state', jump: 'sbt-btn sbt-term-jump', copy: 'sbt-btn sbt-term-copy',
});

const timeOf = (ms) => { try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };

/**
 * createBgTasksView({ registry, readOutput, stopTask, onClear, onBack, t })
 *   registry()                         the tab's registry (bg-tasks-model.js)
 *   readOutput({ taskId, cursor, tail, limit, running }) → { status, data: { output, cursor, size, from } } or a refusal
 *   stopTask(taskId) → Promise<{ ok, error }>   the runtime's own stop (the panel's socket or its route)
 *   onClear()                           the owner cleared finished tasks (the panel saves what it keeps)
 *   onBack()                            back to the conversation
 * → { el, render(), open(taskId), setShown(bool), dispose() }
 */
export function createBgTasksView({ registry, readOutput, stopTask, outputSupported = () => true, onClear = () => {}, onBack = () => {}, onStopped = () => {}, t = null } = {}) {
  installBgTasksStyles();
  const word = bgWords(t);
  const root = el('section', 'sbt-scope sbt-view');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', word('title'));
  root.hidden = true;
  const head = el('div', 'sbt-head');
  const title = el('div', 'sbt-title', word('title'));
  const count = el('span', 'sbt-count');
  title.appendChild(count);
  const clear = el('button', 'sbt-btn sbt-clear', word('clearFinished'));
  clear.type = 'button';
  const back = el('button', 'sbt-btn sbt-back', word('back'));
  back.type = 'button';
  head.append(title, clear, back);
  const list = el('div', 'sbt-list');
  list.setAttribute('role', 'list');
  root.append(head, list);

  const rows = new Map();   // taskId → { el, parts, open, confirming, output }
  let shown = false;
  let ticker = null;
  let disposed = false;

  clear.addEventListener('click', () => { onClear(); render(); });
  back.addEventListener('click', () => onBack());

  const reg = () => { try { return registry?.() || null; } catch { return null; } };

  function outputFor(id, entry) {
    if (entry.output) return entry.output;
    const listeners = new Set();
    const output = { view: null, follower: null, block: null, place: { follow: true, top: 0 }, listeners };
    const tell = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a drawn block that is gone */ } } };
    const running = () => isBgRunning(reg()?.tasks?.get(id));
    output.start = () => {
      if (output.follower || disposed) return;
      output.follower = createShellFollower({
        api: { shellOutput: ({ shellId, cursor, tail, limit }) => readOutput({ taskId: shellId, cursor, tail, limit, running: running() }) },
        sessionId: 'bg', shellId: id,
        isRunning: running,
        isCurrent: () => shown && entry.open && !disposed,
        onUpdate: (view) => { output.view = view; tell(); },
        pollMinMs: BG_OUTPUT_POLL_MS, pollMaxMs: BG_OUTPUT_POLL_MAX_MS,
      });
      output.follower.start();
    };
    output.stop = () => { output.follower?.stop(); output.follower = null; };
    output.block = createTerminalBlock({
      shellId: id,
      read: () => ({ view: output.view, shell: { status: running() ? 'running' : 'done' } }),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      loadAll: () => output.follower?.loadAll(),
      place: output.place,
      classes: TERM_CLASSES,
      showEvent: 'sbt-term-show',
      words: {
        load: word('loadFull'), loading: word('loading'), jump: word('jump'), copy: word('copy'), copied: word('copied'),
        label: word('outputLabel'), noOutputYet: word('noOutputYet'), noOutput: word('noOutput'), reading: word('loading'), running: '',
        note: (view) => {
          if (!view) return '';
          if (view.gone) return word('outputGone');
          const params = { shown: formatBytes(view.text.length), size: formatBytes(view.size) };
          if (view.capped) return word('outputCapped', params);
          if (view.partial) return word('outputPartial', params);
          return '';
        },
      },
    });
    output.tell = tell;
    entry.output = output;
    return output;
  }

  function buildRow(id) {
    const row = el('div', 'sbt-row');
    row.setAttribute('role', 'listitem');
    row.dataset.taskId = id;
    const headBtn = el('button', 'sbt-row-head');
    headBtn.type = 'button';
    headBtn.setAttribute('aria-expanded', 'false');
    const desc = el('span', 'sbt-desc');
    const kind = el('span', 'sbt-chip sbt-kind');
    const status = el('span', 'sbt-chip sbt-status');
    const timeEl = el('span', 'sbt-time');
    const exit = el('span', 'sbt-exit');
    headBtn.append(desc, kind, status, exit, timeEl);
    const meta = el('div', 'sbt-meta');
    const detail = el('div', 'sbt-detail');
    detail.hidden = true;
    const cmd = el('pre', 'sbt-cmd');
    const actions = el('div', 'sbt-actions');
    const stop = el('button', 'sbt-btn sbt-btn-danger sbt-stop', word('stop'));
    stop.type = 'button';
    const confirmText = el('span', 'sbt-confirm', word('stopConfirm'));
    const yes = el('button', 'sbt-btn sbt-btn-danger sbt-stop-yes', word('stopYes'));
    yes.type = 'button';
    const no = el('button', 'sbt-btn sbt-stop-no', word('stopNo'));
    no.type = 'button';
    actions.append(stop, confirmText, yes, no);
    const termHost = el('div', 'sbt-term-host');
    const eventsLabel = el('div', 'sbt-section', word('events'));
    const events = el('ul', 'sbt-events');
    detail.append(cmd, actions, termHost, eventsLabel, events);
    row.append(headBtn, meta, detail);
    const entry = { el: row, open: false, confirming: false, output: null, parts: { headBtn, desc, kind, status, timeEl, exit, meta, detail, cmd, stop, confirmText, yes, no, termHost, eventsLabel, events } };
    headBtn.addEventListener('click', () => { entry.open = !entry.open; entry.confirming = false; render(); });
    stop.addEventListener('click', () => { entry.confirming = true; render(); yes.focus(); });
    no.addEventListener('click', () => { entry.confirming = false; render(); stop.focus(); });
    yes.addEventListener('click', async () => {
      entry.confirming = false;
      yes.disabled = true;
      render();
      let out = null;
      try { out = await stopTask(id); } catch (err) { out = { ok: false, error: err?.message || String(err) }; }
      onStopped(id, out);
      render();
    });
    rows.set(id, entry);
    return entry;
  }

  function paintRow(entry, r) {
    const p = entry.parts;
    entry.el.classList.toggle('sbt-finished', r.finished);
    entry.el.classList.toggle('sbt-open', entry.open);
    p.headBtn.setAttribute('aria-expanded', String(entry.open));
    p.desc.textContent = r.description;
    p.desc.title = r.command || r.description;
    p.kind.textContent = word(r.kindKey);
    p.status.textContent = word(r.statusKey);
    p.status.className = `sbt-chip sbt-status sbt-chip-${r.status}`;
    p.timeEl.textContent = r.duration;
    p.exit.textContent = r.exitCode != null ? word('exitCode', { code: r.exitCode }) : '';
    p.exit.hidden = r.exitCode == null;
    p.exit.classList.toggle('sbt-exit-bad', r.exitCode != null && r.exitCode !== 0);
    // The line under the head: what happened to it, a watch's deadline and count, its last word.
    const metaParts = [];
    if (r.note) metaParts.push(word(r.note.key, r.note.params || {}));
    if (r.expires) metaParts.push(word(r.expires.key, r.expires.params));
    if (r.type === 'watch' && r.eventCount) metaParts.push(r.eventCount === 1 ? word('eventCountOne') : word('eventCount', { count: r.eventCount }));
    p.meta.textContent = '';
    for (const text of metaParts) p.meta.appendChild(el('span', '', text));
    const last = r.type === 'watch' ? r.lastEvent : (r.finished ? r.summary : '');
    if (last) p.meta.appendChild(el('span', 'sbt-last', last));
    p.detail.hidden = !entry.open;
    if (!entry.open) {
      entry.output?.stop();
      return;
    }
    p.cmd.textContent = r.command || r.description;
    p.cmd.hidden = !r.command;
    const confirming = entry.confirming && r.canStop;
    p.stop.hidden = !r.canStop || confirming;
    p.confirmText.hidden = !confirming;
    p.yes.hidden = !confirming;
    p.yes.disabled = false;
    p.no.hidden = !confirming;
    p.stop.parentElement.hidden = !r.canStop;
    // Its output, read while the task is open and the view on screen (a server without the route says so instead).
    const canRead = outputSupported();
    let restartNote = p.termHost.parentElement?.querySelector(':scope > .sbt-term-restart');
    if (!canRead && r.hasOutput) {
      if (!restartNote) { restartNote = el('div', 'sbt-term-note sbt-term-restart', word('needsRestart')); p.termHost.before(restartNote); }
    } else restartNote?.remove();
    if (r.hasOutput && canRead) {
      const output = outputFor(r.id, entry);
      if (!output.block.isConnected) p.termHost.appendChild(output.block);
      if (shown) output.start(); else output.stop();
      if (output.follower && !r.running) output.follower.poke();
      output.tell();
    }
    p.termHost.hidden = !r.hasOutput || !canRead;
    const isWatch = r.type === 'watch';
    p.eventsLabel.hidden = !isWatch;
    p.events.hidden = !isWatch;
    if (isWatch) {
      p.events.textContent = '';
      if (!r.events.length) p.events.appendChild(el('li', '', word('noEvents')));
      for (const e of r.events) {
        const li = el('li');
        if (e.at) li.appendChild(el('time', '', timeOf(e.at)));
        li.appendChild(document.createTextNode(e.text));
        p.events.appendChild(li);
      }
      p.events.scrollTop = p.events.scrollHeight;
    }
  }

  function render() {
    if (disposed) return;
    const r = reg();
    const list_ = bgTaskRows(r);
    const running = list_.filter(x => x.running).length;
    count.textContent = list_.length ? `${running}/${list_.length}` : '';
    clear.hidden = !list_.some(x => x.finished);
    const keep = new Set(list_.map(x => x.id));
    for (const [id, entry] of rows) {
      if (keep.has(id)) continue;
      entry.output?.stop();
      entry.el.remove();
      rows.delete(id);
    }
    let empty = list.querySelector(':scope > .sbt-empty');
    if (!list_.length) {
      if (!empty) { empty = el('div', 'sbt-empty', word('empty')); list.appendChild(empty); }
    } else if (empty) empty.remove();
    let prev = null;
    for (const x of list_) {
      const entry = rows.get(x.id) || buildRow(x.id);
      paintRow(entry, x);
      // In order, moving only what is out of place (an open block keeps its scroll).
      const want = prev ? prev.nextSibling : list.firstChild;
      if (want !== entry.el) list.insertBefore(entry.el, want);
      prev = entry.el;
    }
  }

  function setShown(next) {
    shown = !!next;
    root.hidden = !shown;
    clearInterval(ticker);
    ticker = null;
    if (shown) {
      // The running times move once a second while the view is on screen, and only then.
      ticker = setInterval(() => { if (shown && !document.hidden) render(); }, 1000);
    }
    render();
    if (shown) for (const entry of rows.values()) if (entry.open && entry.output?.block) entry.output.block.dispatchEvent(new Event('sbt-term-show'));
  }

  return {
    el: root,
    render,
    setShown,
    isShown: () => shown,
    /** Open (and show) one task's row. */
    open(taskId) {
      const entry = rows.get(taskId) || (reg()?.tasks?.has(taskId) ? buildRow(taskId) : null);
      if (entry) entry.open = true;
      render();
      if (entry?.el?.isConnected) {
        entry.el.classList.add('sbt-flash');
        setTimeout(() => entry.el.classList.remove('sbt-flash'), 1200);
        try { entry.el.scrollIntoView({ block: 'nearest' }); } catch { /* not laid out */ }
      }
    },
    dispose() {
      disposed = true;
      clearInterval(ticker);
      for (const entry of rows.values()) entry.output?.stop();
      rows.clear();
      root.remove();
    },
  };
}

/**
 * A task-notification of the transcript, as a card linked to its task (noticeCardView). A click (or Enter) opens
 * the task in the Background tasks view (`onOpen(taskId)`).
 */
export function renderBgNoticeCard(view, { t = null, onOpen = null } = {}) {
  installBgTasksStyles();
  const word = bgWords(t);
  const card = el('button', 'sbt-scope sbt-notice');
  card.type = 'button';
  card.dataset.taskId = view.taskId;
  card.dataset.staleText = word('noticeStale');
  card.title = word('noticeOpen');
  card.appendChild(el('span', 'sbt-notice-icon', '⟳'));
  card.appendChild(el('span', 'sbt-chip', word(view.kindKey)));
  card.appendChild(el('span', 'sbt-notice-desc', view.description));
  if (view.isEvent) card.appendChild(el('span', 'sbt-chip sbt-chip-running', word('noticeEvent')));
  else if (view.statusKey) {
    const status = el('span', `sbt-chip sbt-chip-${view.statusKey.replace(/^status/, '').toLowerCase()}`, word(view.statusKey));
    card.appendChild(status);
  }
  if (view.exitCode != null && !view.isEvent) card.appendChild(el('span', `sbt-exit${view.exitCode !== 0 ? ' sbt-exit-bad' : ''}`, word('exitCode', { code: view.exitCode })));
  card.appendChild(el('span', 'sbt-notice-detail', view.detail || ''));
  if (view.stale) {
    card.classList.add('sbt-stale');
    card.appendChild(el('span', 'sbt-chip sbt-chip-stale', word('noticeStale')));
  }
  // Without `onOpen` the transcript's one listener opens it (a card put back from a stored snapshot has none).
  if (onOpen) card.addEventListener('click', (event) => { event.stopPropagation(); onOpen(view.taskId); });
  return card;
}

/**
 * Replayed cards (`data-event="1"`, `data-at`) of an event that came after its task had ended are marked stale,
 * once the registry knows when that was.
 */
export function markStaleNoticeCards(container, reg) {
  if (!container?.querySelectorAll || !reg?.tasks) return 0;
  let n = 0;
  for (const card of container.querySelectorAll('.sbt-notice[data-event="1"][data-at]:not(.sbt-stale)')) {
    const task = reg.tasks.get(card.dataset.taskId);
    const at = Number(card.dataset.at) || 0;
    if (!task?.endedAt || !(at > task.endedAt)) continue;
    card.classList.add('sbt-stale');
    const chip = document.createElement('span');
    chip.className = 'sbt-chip sbt-chip-stale';
    chip.textContent = card.dataset.staleText || BG_TASKS_COPY.noticeStale;
    card.appendChild(chip);
    n += 1;
  }
  return n;
}

export { BG_TASKS_COPY };
