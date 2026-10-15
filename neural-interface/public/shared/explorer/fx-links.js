// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer: the editor and the agents
// ═══════════════════════════════════════════
//
// The two neighbours the tree talks to.
//
// The code editor (shared/editor/) says which files are open, which have
// unsaved text and which one is showing (`getEditorTabs()`, and the
// `editor-tabs-changed` event when that changes), and re-points the tab of a
// file that was renamed or moved (`repointEditorTab()`): the tab stays, with its
// text, caret, scroll position and undo history. The controller hands those
// in; nothing of the editor is read from the page or changed here.
//
// The agents: a path is handed to a side panel through the function each panel
// already has for it. What goes where, and the words for it, are decided here.

import { isWithin, trimSlash } from './fx-logic.js';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (check()) return true;
    if (Date.now() > end) return false;
    await wait(40);
  }
}
const sameSet = (a, b) => a.size === b.size && [...a].every((entry) => b.has(entry));
const laterFrame = (work) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(work) : setTimeout(work, 16));

/**
 * @param {object} o
 * @param {(path: string, at?: { pin?: boolean }) => void} o.openFile editor-panel.js openFileInEditor
 * @param {() => any} o.save editor-panel.js saveEditorPanel (the showing tab)
 * @param {() => { open: { path: string, dirty: boolean }[], active: string | null }} o.tabs editor-panel.js getEditorTabs
 * @param {(from: string, to: string) => { moved: object[], kept: string[] }} o.repoint editor-panel.js repointEditorTab
 * @param {(listener: (tabs: object) => void) => (() => void)} o.subscribe hears `editor-tabs-changed`; gives back how to stop
 * @param {(state: { open: Set<string>, dirty: Set<string>, active: string | null }) => void} o.onChange
 * @param {(work: () => void) => any} [o.later] runs `work` soon (a frame): several changes are one redraw
 */
export function createEditorLink({ openFile, save, tabs, repoint, subscribe, onChange, later = laterFrame }) {
  let state = { open: new Set(), dirty: new Set(), active: null };
  let stopHearing = null;
  let due = false;

  const shape = (said) => {
    const next = { open: new Set(), dirty: new Set(), active: null };
    for (const tab of said?.open || []) {
      const path = trimSlash(tab?.path || '');
      if (!path) continue;
      next.open.add(path);
      if (tab.dirty) next.dirty.add(path);
    }
    if (said?.active) next.active = trimSlash(said.active);
    return next;
  };
  /** What the editor has open right now. */
  const read = () => { try { return shape(tabs()); } catch { return shape(null); } };

  function refresh() {
    due = false;
    if (!stopHearing) return;
    const next = read();
    if (next.active === state.active && sameSet(next.open, state.open) && sameSet(next.dirty, state.dirty)) return;
    state = next;
    onChange(state);
  }
  // The editor says so while it works (a first letter typed, a tab closed): the tree is drawn after it, once.
  const schedule = () => { if (!due) { due = true; later(refresh); } };

  /** Start following what the editor has open. */
  function start() {
    if (stopHearing) return;
    stopHearing = subscribe(schedule) || (() => {});
    schedule();
  }
  function stop() {
    stopHearing?.();
    stopHearing = null;
  }

  /** The open files with unsaved text that are one of `paths`, or inside one of them. */
  const unsavedIn = (paths) => [...read().dirty].filter((file) => paths.some((path) => isWithin(path, file)));

  /** Save one open file: its tab is shown, saved, and checked. False when it still has unsaved text after that. */
  async function saveFile(path) {
    const file = trimSlash(path);
    openFile(file);
    if (!(await until(() => read().active === file, 4000))) return false;
    try { await save(); } catch { return false; }
    return until(() => { const now = read(); return now.active === file && !now.dirty.has(file); }, 6000);
  }

  /**
   * Entries were renamed or moved: the tabs of the files among them, or inside them, follow, each as it is.
   * @param {{ from: string, to: string }[]} moves
   * @returns {string[]} the open files that could not follow (the path each would take is open with unsaved text)
   */
  function follow(moves) {
    const kept = [];
    for (const move of moves) {
      try { kept.push(...(repoint(move.from, move.to)?.kept || [])); }
      catch (error) { console.warn('[file-explorer] the editor could not follow', move.from, error); }
    }
    return kept;
  }

  return { start, stop, state: () => state, read, unsavedIn, saveFile, follow };
}

// ── The agents ──

export const SEND_TARGETS = Object.freeze(['claude', 'codex', 'opencode', 'assistant']);
const TARGET_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/**
 * @param {object} o
 * @param {object} o.deps what each panel offers: `sendToFocusedSession(kind, data)`, `claude(path)`, `codex(path)`,
 *   `opencode(path)`, `assistant(path)`, and `lastActive()` (the panel used last)
 * @param {(key: string, params?: object) => string} o.t
 */
export function createSender({ deps, t }) {
  const nameOf = (target) => (target === 'session' ? t('fileExplorer.send.session') : TARGET_NAMES[target] || t('fileExplorer.send.assistant'));
  /** Where "Send to AI" goes when nothing else is said: the panel that was used last. */
  const current = () => { let last = null; try { last = deps.lastActive(); } catch { last = null; } return SEND_TARGETS.includes(last) ? last : 'claude'; };

  /**
   * Hand paths to an agent, each as a file reference of that panel. Only what a panel took counts as sent: a
   * panel answers `false` for a path it did not take (the Assistant when it is switched off); anything else it
   * answers, or nothing, is a path that was taken.
   * @param {string[]} paths @param {string | null} [target] one of SEND_TARGETS; without it, the session window
   *   that has the focus, else the panel used last
   * @returns {Promise<{ ok: boolean, target: string, name: string, count: number }>} `count`: how many were taken;
   *   `ok`: at least one was, and nothing failed
   */
  async function send(paths, target = null) {
    const list = paths.filter(Boolean);
    let to = target;
    let taken = 0;
    try {
      if (!to) {
        // A detached session that has the focus takes it: all of it, or none.
        if (list.length && deps.sendToFocusedSession('path', list[0])) {
          for (const path of list.slice(1)) deps.sendToFocusedSession('path', path);
          return { ok: true, target: 'session', name: nameOf('session'), count: list.length };
        }
        to = current();
      }
      for (const path of list) if ((await deps[to](path)) !== false) taken++;
      return { ok: taken > 0, target: to, name: nameOf(to), count: taken };
    } catch (error) {
      console.warn('[file-explorer] could not send to', to, error);
      return { ok: false, target: to || current(), name: nameOf(to || current()), count: taken };
    }
  }

  // Rows dragged out of the tree onto a side panel: the panel takes them as it takes "Send to AI".
  let dragged = null; let marked = null; let onSent = () => {};
  const surfaceOf = (event) => event.target?.closest?.('[data-sidepanel-provider]') || null;
  const mark = (surface) => {
    if (marked === surface) return;
    marked?.classList.remove('fe-drop-agent');
    marked = surface;
    marked?.classList.add('fe-drop-agent');
  };
  const over = (event) => {
    const surface = surfaceOf(event);
    mark(surface && SEND_TARGETS.includes(surface.dataset.sidepanelProvider) ? surface : null);
    if (!marked) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  };
  const drop = (event) => {
    const surface = surfaceOf(event);
    const target = surface?.dataset.sidepanelProvider;
    const paths = dragged;
    mark(null);
    if (!paths || !SEND_TARGETS.includes(target)) return;
    event.preventDefault();
    event.stopPropagation();
    send(paths, target).then(onSent);
  };

  return {
    targets: () => SEND_TARGETS.map((id) => ({ id, name: nameOf(id) })),
    current,
    nameOf,
    send,
    /** Rows are being dragged: side panels take them until `dragEnd()`. */
    dragStart(paths, sent) {
      dragged = [...paths];
      onSent = sent || (() => {});
      document.addEventListener('dragover', over, true);
      document.addEventListener('drop', drop, true);
    },
    dragEnd() {
      dragged = null;
      mark(null);
      document.removeEventListener('dragover', over, true);
      document.removeEventListener('drop', drop, true);
    },
  };
}
