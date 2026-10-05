// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — changes review
//   • a bar above the composer: "3 files changed  +12 −4  Review"
//   • a viewer over the panel: one collapsible diff per file, for what this
//     session changed and (when the server offers vcs:diff) for the working
//     tree against HEAD.
// The session's diffs arrive with the session.diff event, so the bar and the
// session tab work without any request; the numbers come from
// ocp-v2-changes-logic.js.
// ─────────────────────────────────────────────────────────────────────────────

import { api, supports } from './ocp-v2-ws.js';
import { getDefaultStore } from './ocp-v2-state.js';
import { replyFailed, replyError } from './ocp-v2-caps.js';
import { normalizeFileDiffs, changesBarView, changesTabs } from './ocp-v2-changes-logic.js';
import { parseUnifiedDiff } from './ocp-v2-tools-logic.js';
import { captureBinding, boundReader, onRebind } from './ocp-v2-binding.js';

const MAX_LINES_PER_FILE = 600;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fileNode(row, open) {
  const details = el('details', 'ocpv2-changes-file');
  details.open = open;
  const summary = el('summary', 'ocpv2-changes-file-head');
  summary.appendChild(el('span', `ocpv2-changes-mark ocpv2-changes-${row.status}`, row.mark));
  const name = el('span', 'ocpv2-changes-name', row.file);
  name.title = row.file;
  summary.appendChild(name);
  summary.appendChild(el('span', 'ocpv2-changes-stat', `+${row.additions} −${row.deletions}`));
  details.appendChild(summary);

  const body = el('div', 'ocpv2-tool-output ocpv2-tc-diff');
  const lines = parseUnifiedDiff(row.patch);
  if (!lines.length) {
    body.appendChild(el('div', 'ocpv2-diff-line ocpv2-diff-meta', 'No patch available for this file.'));
  }
  for (const line of lines.slice(0, MAX_LINES_PER_FILE)) {
    body.appendChild(el('div', `ocpv2-diff-line ocpv2-diff-${line.type}`, line.text || ' '));
  }
  if (lines.length > MAX_LINES_PER_FILE || row.patchTruncated) {
    body.appendChild(el('div', 'ocpv2-diff-line ocpv2-diff-meta', '… diff truncated'));
  }
  details.appendChild(body);
  return details;
}

function openViewer(panelEl, store) {
  if (!panelEl || panelEl.querySelector('.ocpv2-changes-overlay')) return;
  const overlay = el('div', 'ocpv2-changes-overlay');
  const sheet = el('div', 'ocpv2-changes-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  overlay.appendChild(sheet);

  const head = el('div', 'ocpv2-changes-head');
  const tabsEl = el('div', 'ocpv2-mode-toggle');
  const close = el('button', 'ocpv2-msg-action', 'Close');
  close.type = 'button';
  head.append(tabsEl, close);
  const list = el('div', 'ocpv2-changes-list');
  sheet.append(head, list);

  let active = 'session';
  // The viewer shows the changes of the session it was opened on, and of that
  // session only: it closes when the panel is bound to another one, and a diff
  // that comes back after that (or after a newer tab was picked) is dropped.
  const opened = captureBinding(store);
  const readDiff = boundReader(store);
  let unsubscribeRebind = () => {};
  const dismiss = () => {
    document.removeEventListener('keydown', onKey, true);
    try { unsubscribeRebind(); } catch { /* already gone */ }
    overlay.remove();
  };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } };
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
  document.addEventListener('keydown', onKey, true);
  unsubscribeRebind = onRebind(store, dismiss);

  // `at` is the binding snapshot of this read: session and directory are the
  // ones the viewer shows, never the live state's.
  async function load(tab, at) {
    if (tab === 'worktree') {
      const res = await api.vcsDiff({ cwd: at.directory || undefined, mode: 'git' });
      if (replyFailed(res)) throw new Error(replyError(res, 'Could not read the working tree diff'));
      return res.data;
    }
    // The server's answer is the full picture; without it, what the events brought.
    if (supports('session:diff') && at.sessionId) {
      const res = await api.sessionDiff({ sessionId: at.sessionId, cwd: at.cwd || undefined });
      if (!replyFailed(res)) return res.data;
    }
    // What the events brought, of this session: the store holds another
    // session's diffs once the panel moved.
    return at.isCurrent() ? store.getState().sessionDiff : [];
  }

  async function show(tab) {
    active = tab;
    for (const btn of tabsEl.children) btn.classList.toggle('active', btn.dataset.tab === tab);
    list.textContent = '';
    list.appendChild(el('div', 'ocpv2-session-menu-empty', 'Loading…'));
    if (!opened.isCurrent()) { dismiss(); return; }
    try {
      await readDiff((at) => load(tab, at).then(normalizeFileDiffs), (rows) => {
        list.textContent = '';
        if (!rows.length) {
          list.appendChild(el('div', 'ocpv2-session-menu-empty', tab === 'worktree' ? 'The working tree is clean.' : 'This session has not changed any file.'));
          return;
        }
        rows.forEach((row) => list.appendChild(fileNode(row, rows.length <= 3)));
      });
    } catch (err) {
      // Only the latest read of the binding on screen reports its failure.
      list.textContent = '';
      list.appendChild(el('div', 'ocpv2-session-menu-empty', err?.message || 'Could not load the changes'));
    }
  }

  for (const tab of changesTabs(supports)) {
    const btn = el('button', 'ocpv2-mode-btn', tab.label);
    btn.type = 'button';
    btn.dataset.tab = tab.id;
    btn.addEventListener('click', () => show(tab.id));
    tabsEl.appendChild(btn);
  }
  panelEl.appendChild(overlay);
  show(active);
}

export function mountChangesBar(panelEl, store = getDefaultStore()) {
  if (!panelEl) return { element: null, destroy() {} };
  const bar = el('button', 'ocpv2-changes-bar');
  bar.type = 'button';
  bar.hidden = true;
  const label = el('span', 'ocpv2-changes-bar-label');
  const stat = el('span', 'ocpv2-changes-stat');
  const action = el('span', 'ocpv2-changes-bar-action', 'Review');
  bar.append(label, stat, action);
  bar.addEventListener('click', () => openViewer(panelEl, store));
  panelEl.appendChild(bar);

  function sync() {
    const view = changesBarView(store.getState());
    bar.hidden = !view.visible;
    if (!view.visible) return;
    label.textContent = view.label;
    stat.textContent = view.stat;
  }
  const unsubscribe = store.subscribe((event) => {
    const type = event?.type;
    if (type === 'diff:set' || type === 'session:set' || type === 'session:info' || type === 'messages:clear') sync();
  });
  sync();
  return { element: bar, destroy() { try { unsubscribe(); } catch {} bar.remove(); } };
}
