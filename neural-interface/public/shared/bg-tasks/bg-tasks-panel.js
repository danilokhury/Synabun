// ─────────────────────────────────────────────────────────────────────────────
// Background tasks of one panel tab: registry, rebuild, kept choices, view
//
// What a panel tab needs, in one place, whatever the provider: it hands in how
// its provider's messages become facts (`factsOf`, an adapter such as
// bg-tasks-claude.js), where the server keeps the rebuilt list and the output
// (`api`), and where the view goes (`host`). The panel then only says what it
// receives (`onEvent`, `onLive`, `ended`) and draws the badges `onChange`
// reports. Rebuilt from the server when the tab attaches (the transcript or
// the server's record), so a reload or a restart never starts from nothing.
// ─────────────────────────────────────────────────────────────────────────────

import { applyBgFact, bgPrefsOf, clearFinishedBg, createBgRegistry, mergeRebuiltBg, noticeCardView, runningBgCount } from './bg-tasks-model.js';
import { createBgTasksView, installBgTasksStyles, renderBgNoticeCard } from './bg-tasks-view.js';

const PREFS_PREFIX = 'synabun-bg-tasks:';

/**
 * createBgTasksPanel({ key, factsOf, api, storage, t, onChange, onShownChange })
 *   key            what the kept choices are saved under (`<provider>:<session id>`); setKey() when it is known
 *   factsOf(ev)    → facts (the provider's adapter)
 *   api            { list() → Promise<{ tasks, live? }>, output(q) → Promise<page>, stop(taskId) → Promise<{ ok, error }> }
 *   storage        getItem / setItem / removeItem (the app's server-synced storage)
 *   onChange({ running, total })   the counts changed (badges)
 */
export function createBgTasksPanel({ key = '', factsOf, liveFactOf = null, api, storage = null, t = null, overlay = true, onChange = () => {}, onShownChange = () => {} } = {}) {
  installBgTasksStyles();
  let reg = createBgRegistry();
  let storageKey = key ? PREFS_PREFIX + key : '';
  let view = null;
  let lastCounts = '';
  let rebuilding = null;
  let outputSupported = null; // false: the server has no output route yet (a restart of :3344 brings it)

  const readPrefs = () => {
    if (!storageKey || !storage) return null;
    try { return JSON.parse(storage.getItem(storageKey) || 'null'); } catch { return null; }
  };
  const writePrefs = () => {
    if (!storageKey || !storage) return;
    const prefs = bgPrefsOf(reg);
    try {
      if (!prefs.cleared.length && !prefs.ownerStopped.length) storage.removeItem?.(storageKey);
      else storage.setItem(storageKey, JSON.stringify(prefs));
    } catch { /* storage full or gone: the view still works */ }
  };
  // What the page kept is applied as soon as it is known: a cleared task never shows again.
  const applyPrefs = () => { const prefs = readPrefs(); for (const id of prefs?.cleared || []) reg.cleared.add(id); return prefs; };
  applyPrefs();

  function changed() {
    const counts = { running: runningBgCount(reg), total: reg.tasks.size };
    const sig = `${counts.running}/${counts.total}/${reg.version}`;
    if (view?.isShown()) view.render();
    if (sig === lastCounts) return;
    lastCounts = sig;
    try { onChange(counts); } catch { /* a badge that failed to draw */ }
  }

  function ensureView(host) {
    if (view) { if (host && view.el.parentElement !== host) host.appendChild(view.el); return view; }
    view = createBgTasksView({
      registry: () => reg,
      readOutput: (q) => api.output(q),
      outputSupported: () => outputSupported !== false,
      stopTask: async (taskId) => {
        applyBgFact(reg, { kind: 'stopping', taskId, by: 'owner' });
        writePrefs();
        changed();
        let out;
        try { out = await api.stop(taskId); } catch (err) { out = { ok: false, error: err?.message || String(err) }; }
        if (!out?.ok) { applyBgFact(reg, { kind: 'stop-failed', taskId, error: out?.error || 'unknown error' }); writePrefs(); changed(); }
        return out;
      },
      onClear: () => { clearFinishedBg(reg); writePrefs(); changed(); },
      onBack: () => setShown(false),
      t,
    });
    view.el.classList.add(overlay ? 'sbt-overlay' : 'sbt-inline');
    if (host) host.appendChild(view.el);
    return view;
  }

  function setShown(next, host = null) {
    const v = ensureView(host);
    v.setShown(!!next);
    try { onShownChange(!!next); } catch { /* ignore */ }
  }

  return {
    registry: () => reg,
    counts: () => ({ running: runningBgCount(reg), total: reg.tasks.size }),
    /** The kept choices' key (the session id arrives after the tab exists). */
    setKey(next) {
      const k = next ? PREFS_PREFIX + next : '';
      if (k === storageKey) return;
      storageKey = k;
      applyPrefs();
    },
    /**
     * One message of the provider's stream. → the task-notification cards it carries (`noticeCardView`), each
     * `{ view, task }`; a repeated end (the same end told twice) is left out.
     */
    onEvent(ev) {
      let facts = [];
      try { facts = factsOf(ev) || []; } catch { facts = []; }
      if (!facts.length) return [];
      const cards = [];
      for (const fact of facts) {
        const out = applyBgFact(reg, fact);
        if (out?.notice && !out.notice.repeat) cards.push({ view: noticeCardView(out.notice, out.task), task: out.task });
      }
      changed();
      return cards;
    },
    /** The live set (a reattach's list, `background_tasks_changed`). */
    onLive(tasks) {
      const fact = liveFactOf ? liveFactOf(tasks) : { kind: 'live', tasks };
      applyBgFact(reg, fact);
      changed();
    },
    /** The process that ran the tasks is gone. */
    ended() { applyBgFact(reg, { kind: 'ended-all' }); changed(); },
    /** Rebuild from the server (the transcript), keeping what the page knew and chose. */
    async rebuild() {
      if (!api?.list) return false;
      if (rebuilding) return rebuilding;
      rebuilding = (async () => {
        let data = null;
        try { data = await api.list(); } catch { data = null; }
        if (data?.unsupported) { outputSupported = false; view?.render(); return false; }
        if (data && data.supported !== false) outputSupported = true;
        if (!data || !Array.isArray(data.tasks)) return false;
        const merged = mergeRebuiltBg(reg, data, applyPrefs());
        if (Array.isArray(data.live)) applyBgFact(reg, liveFactOf ? liveFactOf(data.live) : { kind: 'live', tasks: data.live });
        changed();
        return merged;
      })().finally(() => { rebuilding = null; });
      return rebuilding;
    },
    /** A new conversation in the same tab: nothing of the old one is listed. */
    reset(nextKey = '') {
      reg = createBgRegistry();
      storageKey = nextKey ? PREFS_PREFIX + nextKey : '';
      applyPrefs();
      changed();
    },
    show(host, taskId = null) { setShown(true, host); if (taskId) view.open(taskId); },
    hide() { if (view) setShown(false); },
    isShown: () => !!view?.isShown(),
    toggle(host) { if (view?.isShown()) setShown(false); else setShown(true, host); return !!view?.isShown(); },
    /** A card for a notice of the transcript (`cards` from onEvent). */
    card(cardView, onOpen) { return renderBgNoticeCard(cardView, { t, onOpen }); },
    /** The tab closed: its kept choices go with it. */
    dispose({ forget = false } = {}) {
      view?.dispose();
      view = null;
      if (forget && storageKey && storage) { try { storage.removeItem?.(storageKey); } catch { /* ignore */ } }
    },
  };
}
