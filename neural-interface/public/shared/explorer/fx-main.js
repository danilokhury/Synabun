// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer: the controller
// ═══════════════════════════════════════════
//
// Holds what the explorer knows of a project (the folders that were read,
// which are open, the git state, what is cut, what the editor has open) and
// keeps the tree (fx-tree.js) true to it: it answers the tree's questions,
// acts on what the user did, follows the disk through the server's watcher,
// and remembers the tree per project. ui-file-explorer.js creates one and
// hands in what belongs to the app around it (the editor, the side panels,
// storage, the icons); this module is loaded by its address, because the
// editor's browser tests run ui-file-explorer.js without its imports.

import { t, tp } from '../i18n.js';
import { on } from '../state.js';
import { formatKey } from '../editor/editor-commands.js';
import { openEditorMenu } from '../editor/editor-menu.js';
import { createPalette } from '../editor/editor-palette.js';
import { getEditorTabs, repointEditorTab } from '../editor/editor-panel.js';
import { createExplorerApi } from './fx-api.js';
import { createEditorLink, createSender } from './fx-links.js';
import {
  GIT_MARKS, baseName, buildPathTree, dirName, failureMessage, fileKind, formatBytes, gitIndex, isWithin, latestOnly, matchRange, menuModel, nameMatches,
  recallTreeState, relativeTo, rememberTreeState, sameListing, sortItems, trimSlash,
} from './fx-logic.js';
import { createOps } from './fx-ops.js';
import { closeFlyout, createNotice, isFlyoutOpen, openContextMenu, openPreviewCard } from './fx-popups.js';
import { createTree } from './fx-tree.js';

export { t, tp };

const TREE_KEY = 'neural-file-explorer-tree';
const SORT_KEY = 'neural-file-explorer-sort';
const SORTS = ['name', 'date', 'size'];
const FILTER_DELAY_MS = 180;
const GIT_DELAY_MS = 250;
const GIT_MIN_INTERVAL_MS = 1500;
const DISK_MIN_INTERVAL_MS = 1000;
const PERSIST_DELAY_MS = 500;
const FOCUS_REFRESH_MS = 5000;
const EXPAND_LEVEL_MAX = 200;

/**
 * @param {object} host
 * @param {HTMLElement} host.panel #file-explorer-panel
 * @param {{ getItem: Function, setItem: Function }} host.storage @param {object} host.KEYS
 * @param {{ openFile: Function, save: Function }} host.editor shared/editor/editor-panel.js
 * @param {object} host.send what each side panel offers for a path (fx-links.js createSender)
 * @param {(name: string) => object} host.fileIcon @param {string} host.folderSvg
 * @param {{ all: { hex: string, key: string }[], of: (path: string) => string | undefined, set: Function, move: Function }} host.colors
 * @param {(git: { isGit: boolean, branch: string, count: number }) => void} host.onGit
 * @param {() => void} host.addProject
 * @param {typeof fetch} [host.fetchImpl]
 */
export function createExplorer(host) {
  const { panel, storage, KEYS = {} } = host;
  const $ = (id) => document.getElementById(id);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const api = createExplorerApi({ fetchImpl: host.fetchImpl });
  const treeKey = KEYS.FILE_EXPLORER_TREE || TREE_KEY;
  const sortKey = KEYS.FILE_EXPLORER_SORT || SORT_KEY;

  const S = {
    root: null,                 // the project's folder
    label: '',
    dirs: new Map(),            // folder → { state: 'loading' | 'ready' | 'error', items, total, truncated, failure }
    expanded: new Set(),
    git: gitIndex(null),
    view: null,                 // the filter's tree or "changed only": { kind, dirs, count, note, pending }
    viewOpen: new Set(), viewClosed: new Set(),
    filter: '', search: null, changedOnly: false,
    sort: SORTS.includes(storage.getItem(sortKey)) ? storage.getItem(sortKey) : 'name',
    clipboard: null,
    visible: false,
  };
  let epoch = 0;                // a project that was left: what it asked for is dropped when it arrives
  let watcher = null;
  let saidLimited = false;      // this project was told once that not everything on disk is followed
  let loaded = Promise.resolve();
  let gitTimer = 0; let gitBusy = false; let gitAgain = false; let lastGitAt = 0;
  let diskTimer = 0; let lastDiskAt = 0; const diskDue = new Set();
  let filterTimer = 0; let searchAbort = null;
  let persistTimer = 0; let lastFocusRefresh = 0;
  let rereadTimer = 0; let lastLive = 'full';
  let palette = null;
  let realTop = 0;              // how far the real tree was scrolled when a view took its place
  const reads = latestOnly();   // which reading of each folder was asked for last

  const treeEl = $('fe-tree');
  const filterInput = $('fe-filter-input');
  const notice = createNotice($('fe-notice'), { dismiss: t('fileExplorer.notice.dismiss') });
  const rel = (path) => relativeTo(S.root, path) ?? '';
  const say = (failure) => { const message = failureMessage(failure); return t(message.key, message.params); };
  const revealWord = () => (api.abilities().platform === 'darwin' ? 'darwin' : api.abilities().platform === 'win32' ? 'win32' : 'other');

  // ── What the tree asks ──

  function itemsOf(dir) {
    const below = rel(dir);
    if (S.view && S.view.dirs.has(below)) {
      const items = sortItems(S.view.dirs.get(below), 'name');
      return { state: 'ready', items, total: items.length, truncated: false, note: below === '' ? S.view.note : '' };
    }
    const known = S.dirs.get(dir);
    if (!known || known.state === 'loading') return { state: 'loading' };
    if (known.state === 'error') return { state: 'error', message: say(known.failure) };
    return { state: 'ready', items: sortItems(known.items, S.sort), total: known.total, truncated: known.truncated, note: dir === S.root ? t('fileExplorer.state.emptyProject') : '' };
  }
  const isExpanded = (path) => (S.view ? S.viewOpen.has(path) : S.expanded.has(path));

  function rowInfo(path, item) {
    const below = rel(path);
    const isDir = item.type === 'dir';
    const ed = editor.state();
    const status = item.missing ? 'deleted' : S.git.statusOf(below, isDir);
    const tone = item.missing ? 'deleted' : S.git.toneOf(below, isDir);
    const ignored = S.git.isIgnored(below);
    const open = !isDir && ed.open.has(path);
    const dirty = !isDir && ed.dirty.has(path);
    const cut = !!S.clipboard && S.clipboard.mode === 'cut' && S.clipboard.paths.some((held) => isWithin(held, path));
    const words = [];
    if (status) words.push(t(`fileExplorer.git.${status}`)); else if (tone) words.push(t('fileExplorer.git.contains'));
    if (ignored) words.push(t('fileExplorer.git.ignored'));
    if (dirty) words.push(t('fileExplorer.row.unsaved')); else if (open) words.push(t('fileExplorer.row.open'));
    if (item.outside) words.push(t('fileExplorer.row.linkOutside')); else if (item.broken) words.push(t('fileExplorer.row.linkBroken')); else if (item.link) words.push(t('fileExplorer.row.link'));
    if (cut) words.push(t('fileExplorer.row.cut'));
    return {
      tone, letter: status ? GIT_MARKS[status].letter : '', ignored, open, dirty, cut, words,
      active: !isDir && ed.active === path,
      missing: !!item.missing,
      faint: !!item.outside || !!item.broken,
      link: !!item.link,
      color: isDir ? host.colors.of(path) : null,
      match: S.view?.kind === 'filter' && item.hit ? matchRange(item.name, S.filter) : null,
    };
  }

  const tree = createTree({
    el: treeEl,
    mac,
    icons: { folder: host.folderSvg, forFile: host.fileIcon },
    hooks: {
      itemsOf, isExpanded, rowInfo,
      words: {
        loading: t('fileExplorer.state.loading'),
        retry: t('fileExplorer.state.retry'),
        showMore: t('fileExplorer.state.showMore'),
        emptyFolder: t('fileExplorer.state.emptyFolder'),
        more: (count) => tp('fileExplorer.state.more', count),
        truncated: (shownCount, total) => t('fileExplorer.state.truncated', { shown: shownCount, total }),
      },
      onToggle: toggleFolder,
      onOpen: openEntry,
      onMenu: openMenu,
      onAction,
      onSelection: () => { updateCount(); persistSoon(); },
      onScroll: () => { if (!S.view) persistSoon(); },
      onRetry: (dir) => { S.dirs.delete(dir); tree.renderDir(dir); loadDir(dir).then(() => tree.renderDir(dir)); },
      // `why`: a name that was on its way when its row went, and was not kept: the server's reason.
      onEditLost: (name, why = '') => { if (why || name) notice.show(why || t('fileExplorer.edit.gone', { name }), { tone: 'error' }); },
      acceptsFiles: () => api.abilities().ops,
      onDrop: ({ rows, transfer, into, copy }) => (rows ? ops.transfer(rows, into, { copy }) : ops.upload(transfer, into)),
      onDragStart: (paths) => sender.dragStart(paths, saySent(paths)),
      onDragEnd: () => sender.dragEnd(),
    },
  });

  const editor = createEditorLink({
    openFile: host.editor.openFile,
    save: host.editor.save,
    tabs: getEditorTabs,
    repoint: repointEditorTab,
    subscribe: (listener) => on('editor-tabs-changed', listener),
    onChange: () => { tree.refreshRows(); syncToolbar(); },
  });
  const sender = createSender({ deps: host.send, t });
  const ops = createOps({
    api, t, tp, tree, notice, editor,
    openFile: host.editor.openFile,
    root: () => S.root,
    itemsIn: (dir) => (S.dirs.get(dir)?.state === 'ready' ? S.dirs.get(dir).items : null),
    openFolder,
    refresh: refreshDirs,
    moved,
    clipboard: { get: () => S.clipboard, set: (value) => { S.clipboard = value; tree.refreshRows(); } },
  });

  // ── Reading folders ──

  /**
   * Read one folder. Answers whether what it shows changed. Of two readings of a folder that overlap (it is being
   * opened, and the watcher tells of a change in it) the later one counts: the older answer may arrive last, and
   * would put the folder back as it was. It is dropped.
   */
  async function loadDir(dir) {
    const mine = epoch;
    const latest = reads.take(dir);
    const before = S.dirs.get(dir);
    if (!before) S.dirs.set(dir, { state: 'loading' });
    const got = await api.list(dir);
    if (mine !== epoch || !latest()) return false;
    if (!got.ok) {
      // A folder that was read stays as it is while the server does not answer: it is read again later.
      if (before?.state === 'ready' && got.code === 'offline') return false;
      S.dirs.set(dir, { state: 'error', failure: got });
      return true;
    }
    const next = { state: 'ready', items: got.items, total: got.total ?? got.items.length, truncated: !!got.truncated };
    S.dirs.set(dir, next);
    if (before?.state !== 'ready') return true;
    return !(before.truncated === next.truncated && sameListing(sortItems(before.items), sortItems(next.items)));
  }

  // The open folders that are in sight: every folder on the way to them is open too, and is still there.
  function shownDirs() {
    const out = [S.root];
    const open = S.view ? S.viewOpen : S.expanded;
    const walk = (dir) => {
      const known = S.dirs.get(dir);
      if (known?.state !== 'ready') return;
      for (const item of known.items) {
        if (item.type !== 'dir') continue;
        const path = `${dir}/${item.name}`;
        if (open.has(path)) { out.push(path); walk(path); }
      }
    };
    if (S.root) walk(S.root);
    return out;
  }

  // Open folders that are gone from disk are forgotten, with what was read of them.
  function prune() {
    if (!S.root) return;
    const there = (path) => {
      for (let at = path; at !== S.root;) {
        const parent = dirName(at);
        const known = S.dirs.get(parent);
        if (known?.state === 'ready' && !known.items.some((item) => item.type === 'dir' && item.name === baseName(at))) return false;
        if (!isWithin(S.root, parent) || parent === at) return false;
        at = parent;
      }
      return true;
    };
    for (const path of [...S.expanded]) if (!isWithin(S.root, path) || !there(path)) S.expanded.delete(path);
    for (const path of [...S.dirs.keys()]) if (path !== S.root && !there(path)) S.dirs.delete(path);
  }

  /** Read folders again (those that were read before) and draw the ones that changed. */
  async function refreshDirs(dirs) {
    const mine = epoch;
    const wanted = [...new Set(dirs)].filter((dir) => S.dirs.has(dir) || dir === S.root);
    const changed = await Promise.all(wanted.map((dir) => loadDir(dir)));
    if (mine !== epoch) return;
    prune();
    wanted.forEach((dir, at) => { if (changed[at]) tree.renderDir(dir); });
    if (changed.some(Boolean)) { syncWatch(); updateCount(); }
    queueGit();
  }
  const refreshAll = () => refreshDirs(shownDirs());

  /** Open a folder in the tree (and those on the way to it) and wait for its rows. */
  async function openFolder(dir) {
    if (!S.root || !isWithin(S.root, dir)) return false;
    const mine = epoch;
    const chain = [];
    for (let at = dir; at !== S.root; at = dirName(at)) chain.unshift(at);
    for (const path of [S.root, ...chain]) {
      if (path !== S.root) { (S.view ? S.viewOpen : S.expanded).add(path); S.viewClosed.delete(path); }
      if (S.dirs.get(path)?.state !== 'ready' && !(S.view && S.view.dirs.has(rel(path)))) await loadDir(path);
      if (mine !== epoch) return false;
    }
    tree.render();
    syncWatch();
    persistSoon();
    return dir === S.root || tree.has(dir);
  }

  function toggleFolder(path, open) {
    const set = S.view ? S.viewOpen : S.expanded;
    if (open) {
      set.add(path);
      S.viewClosed.delete(path);
      const virtual = S.view && S.view.dirs.has(rel(path));
      // A folder that was read before shows what it held at once and is read again behind it: nothing watched it
      // while it was closed.
      if (!virtual && S.dirs.get(path)?.state === 'ready') refreshDirs([path]);
      else if (!virtual) loadDir(path).then(() => { tree.renderDir(path); syncWatch(); });
    } else {
      set.delete(path);
      if (S.view) S.viewClosed.add(path);
    }
    tree.renderDir(path);
    syncWatch();
    persistSoon();
  }

  // ── Git ──

  async function loadGit() {
    if (!S.root) return;
    if (gitBusy) { gitAgain = true; return; }
    gitBusy = true;
    const mine = epoch;
    const got = await api.git(S.root);
    gitBusy = false;
    if (mine === epoch && got.ok) {
      S.git = gitIndex(got);
      host.onGit({ isGit: S.git.isGit, branch: S.git.branch, count: S.git.count });
      if (S.changedOnly) { buildView(); tree.render(); } else tree.refreshRows();
      updateCount();
    }
    if (gitAgain) { gitAgain = false; queueGit(); }
  }
  // Soon after the last sign of a change, and never more often than once in a while: a file that is written
  // without pause (a log, a database) does not make git run without pause.
  function queueGit() {
    clearTimeout(gitTimer);
    gitTimer = setTimeout(() => { lastGitAt = Date.now(); loadGit(); }, Math.max(GIT_DELAY_MS, lastGitAt + GIT_MIN_INTERVAL_MS - Date.now()));
  }

  // ── The filter and "changed only" ──

  function buildView() {
    const query = S.filter;
    if (S.changedOnly) {
      const all = S.git.changed();
      const entries = query ? all.filter((entry) => nameMatches(query.includes('/') ? entry.path : baseName(entry.path), query)) : all;
      S.view = {
        kind: 'changed', dirs: buildPathTree(entries), count: entries.length,
        note: !S.git.isGit ? t('fileExplorer.state.notRepo') : entries.length ? '' : t(query ? 'fileExplorer.state.noMatch' : 'fileExplorer.state.noChanges', { query }),
      };
    } else if (query) {
      const found = S.search?.query === query ? S.search : null;
      const items = found?.items || [];
      S.view = {
        kind: 'filter', dirs: buildPathTree(items), count: items.length, pending: !found || found.pending,
        note: !found || found.pending ? t('fileExplorer.state.searching') : found.failed ? t('fileExplorer.state.searchFailed') : items.length ? '' : t('fileExplorer.state.noMatch', { query }),
      };
    } else {
      S.view = null;
      S.viewOpen = new Set(); S.viewClosed = new Set();
      return;
    }
    // Every folder on the way to a row is open, unless the user closed it in this view; folders they opened stay.
    const onTheWay = [...S.view.dirs.keys()].filter(Boolean).map((below) => `${S.root}/${below}`);
    S.viewOpen = new Set([...onTheWay, ...[...S.viewOpen].filter((path) => !S.view.dirs.has(rel(path)))].filter((path) => !S.viewClosed.has(path)));
  }

  async function runFilter() {
    const query = S.filter;
    searchAbort?.abort();
    searchAbort = null;
    if (!query || S.changedOnly) { S.search = null; showView(); return; }
    const mine = epoch;
    const control = new AbortController();
    searchAbort = control;
    S.search = { query, pending: true };
    showView();
    const got = await api.search(S.root, query, control.signal);
    if (control.signal.aborted || mine !== epoch || S.filter !== query) return;
    S.search = got.ok ? { query, items: got.items, truncated: got.truncated, partial: got.partial } : { query, items: [], failed: true };
    showView();
    if (got.ok && (got.truncated || got.partial)) notice.show(t(got.truncated ? 'fileExplorer.state.moreMatches' : 'fileExplorer.state.partial', { count: got.items.length }));
  }

  // Draw the view (or the real tree again, where it was).
  function showView() {
    const had = !!S.view;
    if (!had) realTop = tree.scrollTop();
    buildView();
    tree.render();
    if (!S.view && had) tree.setScrollTop(realTop);
    updateCount();
    syncWatch();
  }

  function setFilter(text) {
    S.filter = text.trim();
    $('fe-filter-clear').hidden = !S.filter;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(runFilter, S.filter ? FILTER_DELAY_MS : 0);
  }
  function clearFilter() {
    if (filterInput.value) filterInput.value = '';
    if (S.filter) setFilter('');
  }
  function setChangedOnly(on) {
    S.changedOnly = !!on;
    S.viewClosed = new Set();
    syncToolbar();
    searchAbort?.abort();
    if (!S.changedOnly && S.filter) runFilter(); else showView();
    persistSoon();
  }

  // ── What is remembered ──

  const readStored = () => { try { return JSON.parse(storage.getItem(treeKey) || 'null'); } catch { return null; } };
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = 0;
    if (!S.root) return;
    const now = tree.selection();
    const state = { expanded: S.expanded, selected: S.view ? [] : now.selected, focus: S.view ? null : now.focus, top: S.view ? realTop : tree.scrollTop(), changedOnly: S.changedOnly };
    try { storage.setItem(treeKey, JSON.stringify(rememberTreeState(readStored(), S.root, state))); } catch { /* storage is not there: nothing is kept */ }
  }
  function persistSoon() { if (!persistTimer) persistTimer = setTimeout(persist, PERSIST_DELAY_MS); }

  // Entries have another path now: what is open, what was read and what has a colour follow them.
  function moved(pairs) {
    for (const { from, to } of pairs) {
      const swap = (path) => (isWithin(from, path) ? trimSlash(to) + path.slice(trimSlash(from).length) : path);
      S.expanded = new Set([...S.expanded].map(swap));
      for (const path of [...S.dirs.keys()]) if (path !== S.root && isWithin(from, path)) S.dirs.delete(path);
      if (S.clipboard) S.clipboard = { ...S.clipboard, paths: S.clipboard.paths.map(swap) };
      host.colors.move(from, to);
    }
    persistSoon();
  }

  // ── The disk ──

  function syncWatch() { watcher?.setDirs(shownDirs()); }
  // Anything may have changed without a word (the watch was lost, is back, or the stream was down): what is shown
  // is read again. At once the first time, and then not more often than a look at the window reads it: a watch
  // that keeps failing reports each time, and the tree is not listed each time.
  function rereadSoon() {
    if (rereadTimer) return;
    rereadTimer = setTimeout(() => { rereadTimer = 0; lastFocusRefresh = Date.now(); refreshAll(); }, Math.max(0, lastFocusRefresh + FOCUS_REFRESH_MS - Date.now()));
  }
  function startWatch() {
    stopWatch();
    if (!S.root || !S.visible || document.visibilityState === 'hidden' || !api.abilities().watch) return;
    lastLive = 'full';
    watcher = api.watch(S.root, {
      // The first change of a quiet spell is read at once; a folder that changes without pause (a database's
      // own files) is read again once a second at most.
      onChange: ({ dirs = [], git }) => {
        if (!dirs.length) { if (git) queueGit(); return; }
        for (const dir of dirs) diskDue.add(trimSlash(dir));
        if (diskTimer) return;
        diskTimer = setTimeout(() => {
          diskTimer = 0;
          lastDiskAt = Date.now();
          const due = [...diskDue];
          diskDue.clear();
          refreshDirs(due);
        }, Math.max(0, lastDiskAt + DISK_MIN_INTERVAL_MS - Date.now()));
      },
      // Up again after it was down: anything may have changed meanwhile.
      onReady: (again) => { syncWatch(); if (again) rereadSoon(); },
      // The server lost its watch on the project. It tries for it again by itself: nothing is sent back.
      onResync: rereadSoon,
      // A stream is not a watch that works: the system may have no watches left for the project, or for some of
      // its folders. Said once per project; from then on the tree is read again when it is looked at and after
      // what is done here, which it is in any case. Watched again after it was not: what happened meanwhile was
      // not told.
      onState: ({ live }) => {
        if (live === 'full' && lastLive !== 'full') rereadSoon();
        lastLive = live;
        if (live === 'full' || saidLimited) return;
        saidLimited = true;
        notice.show(t(live === 'none' ? 'fileExplorer.watch.none' : 'fileExplorer.watch.partial'), { ms: 12000 });
      },
    });
    syncWatch();
  }
  function stopWatch() { watcher?.close(); watcher = null; clearTimeout(diskTimer); diskTimer = 0; diskDue.clear(); clearTimeout(rereadTimer); rereadTimer = 0; }
  // The window is looked at again: read what is shown, whether or not a stream is up. A stream may have no watch
  // behind it; where only the shown folders are watched (Linux) a change inside a closed one never reached the git
  // marks; and an older server has no watch at all. Not more often than once in a while, except after the stream
  // was let go (the tab was hidden): then anything may have changed.
  function onAttention() {
    if (!S.root || !S.visible || document.visibilityState === 'hidden') return;
    const wasDown = api.abilities().watch && !watcher;
    if (wasDown) startWatch();
    if (!wasDown && Date.now() - lastFocusRefresh < FOCUS_REFRESH_MS) return;
    lastFocusRefresh = Date.now();
    refreshAll();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopWatch(); else onAttention(); });
  window.addEventListener('focus', onAttention);
  // The page is going: what is remembered is written, and sent on by a request of its own (storage.js has
  // flushed by then: a window's listeners run in the order they were added), and the watch is let go.
  window.addEventListener('pagehide', () => {
    const due = !!persistTimer;
    persist();
    if (due) {
      try {
        const value = storage.getItem(treeKey);
        if (value && storage.persists !== false) navigator.sendBeacon?.('/api/ui-state', new Blob([JSON.stringify({ [treeKey]: JSON.parse(value) })], { type: 'application/json' }));
      } catch { /* the debounced write is what is left */ }
    }
    stopWatch();
  });

  // ── Opening ──

  // The tree keeps the keyboard after a file was only looked at (Space): the editor takes it when it has loaded.
  function keepKeyboard(path) {
    const end = Date.now() + 2500;
    const tick = () => {
      if (document.activeElement?.closest?.('#fe-editor-panel')) { tree.focus(); return; }
      if (Date.now() < end && editor.read().active !== path) setTimeout(tick, 60);
      else if (Date.now() < end) setTimeout(() => { if (document.activeElement?.closest?.('#fe-editor-panel')) tree.focus(); }, 120);
    };
    setTimeout(tick, 60);
  }

  function openEntry(path, item, { pin = false, keep = false } = {}) {
    if (!item) return;
    const name = item.name;
    if (item.missing) { notice.show(t('fileExplorer.open.deleted', { name })); return; }
    if (item.outside) { notice.show(t('fileExplorer.open.linkOutside', { name })); return; }
    if (item.broken) { notice.show(t('fileExplorer.open.linkBroken', { name })); return; }
    const kind = fileKind(name);
    if (kind.kind === 'text') {
      closeFlyout({ refocus: false });
      host.editor.openFile(path, { pin });
      if (keep) keepKeyboard(path);
      return;
    }
    const can = api.abilities();
    const image = kind.kind === 'image';
    const url = image ? api.rawUrl(path) : null;
    const what = [image ? t('fileExplorer.preview.image') : t(`fileExplorer.kind.${kind.type}`), item.size !== undefined ? formatBytes(item.size) : ''].filter(Boolean).join(' · ');
    const why = image ? (url ? '' : t('fileExplorer.preview.noPreview')) : t('fileExplorer.preview.notText');
    openPreviewCard({
      panel,
      row: tree.rowOf(path),
      label: t('fileExplorer.preview.label', { name }),
      name,
      detail: why ? `${what}\n${why}` : what,
      imageUrl: url,
      imageAlt: name,
      imageFailed: t('fileExplorer.preview.failed'),
      actions: [
        ...(kind.alsoText ? [{ label: t('fileExplorer.preview.openAsText'), run: () => host.editor.openFile(path, { pin: true }) }] : []),
        ...(can.reveal ? [{ label: t(`fileExplorer.menu.reveal.${revealWord()}`), run: () => ops.reveal(path) }] : []),
        { label: t('fileExplorer.menu.copyPath.one'), run: () => ops.copyPath([path]) },
        { label: tp('fileExplorer.menu.send', 1, { name: sender.nameOf(sender.current()) }), run: () => sendPaths([path]) },
      ],
    });
  }

  const saySent = (paths) => (done) => notice.show(
    done.ok ? tp('fileExplorer.send.done', done.count, { name: baseName(paths[0]), target: done.name }) : t('fileExplorer.send.failed', { target: done.name }),
    { tone: done.ok ? 'ok' : 'error' },
  );
  const sendPaths = (paths, target = null) => sender.send(paths, target).then(saySent(paths));

  /** The editor's go-to-file, for the selected project (the editor's own module, opened beside the panel). */
  function jump() {
    if (!S.root) return;
    let layer = $('fe-jump-layer');
    if (!layer) { layer = document.createElement('div'); layer.id = 'fe-jump-layer'; layer.className = 'fe-jump-layer'; document.body.appendChild(layer); }
    palette ||= createPalette({
      t,
      openMenu: (menu) => openEditorMenu({ host: layer, ...menu }),
      position: () => {
        const frame = panel.getBoundingClientRect();
        const width = Math.min(460, window.innerWidth - 16);
        const free = window.innerWidth - frame.right;
        return { x: free >= width + 16 ? frame.right + (free - width) / 2 : (window.innerWidth - width) / 2, y: (parseFloat(getComputedStyle(panel).paddingTop) || 0) + 12 };
      },
      mac,
      commands: [],
      features: () => [],
      run: () => {},
      project: () => S.root,
      tabs: () => { const ed = editor.state(); return [...ed.open].filter((path) => path !== ed.active).map((path) => ({ path, name: baseName(path) })); },
      openFile: (path) => host.editor.openFile(path, { pin: true }),
    });
    closeFlyout({ refocus: false });
    palette.openFiles();
  }

  // ── The menu ──

  const folderFor = (path, item) => (!path ? S.root : item?.type === 'dir' ? path : dirName(path));

  function menuItems(model, { count }) {
    const target = sender.nameOf(sender.current());
    return model.map((entry) => {
      if (entry.separator) return entry;
      const { id } = entry;
      let label;
      if (id === 'send') label = tp('fileExplorer.menu.send', count, { name: target });
      else if (id === 'delete') label = count > 1 ? t('fileExplorer.menu.deleteMany', { count }) : t('fileExplorer.menu.delete');
      else if (id === 'copyPath' || id === 'copyRelativePath') label = tp(`fileExplorer.menu.${id}`, count);
      else if (id === 'reveal') label = t(`fileExplorer.menu.reveal.${revealWord()}`);
      else label = t(`fileExplorer.menu.${id}`);
      const key = id === 'delete' && mac ? 'Mod-Backspace' : entry.key;
      const why = entry.why === 'restart' ? t('fileExplorer.needsRestart') : entry.why === 'nothingCopied' ? t('fileExplorer.menu.nothingCopied') : entry.why === 'noReveal' ? t('fileExplorer.error.noReveal') : '';
      return { id, label, danger: entry.danger, disabled: entry.disabled, title: why, more: entry.more, checked: entry.checked, keyLabel: key ? formatKey(key, mac) : '' };
    });
  }
  const back = () => ({ id: 'back', back: true, label: t('fileExplorer.menu.back') });

  function openMenu({ paths = [], row = null, item = null, expanded = false, keyboard = false, y = null }) {
    if (!S.root) return;
    const can = api.abilities();
    const target = paths.length === 0 ? 'empty' : paths.length > 1 ? 'multi' : item?.type === 'dir' ? 'dir' : 'file';
    const model = menuModel({
      target, count: paths.length, caps: { ops: can.ops, reveal: can.reveal }, expanded, canPaste: !!S.clipboard,
      kind: item ? fileKind(item.name).kind : 'text', missing: !!item?.missing, changedOnly: S.changedOnly, sort: S.sort,
    });
    const path = paths[0] || null;
    openContextMenu({
      panel, row, keyboard,
      y: y ?? treeEl.getBoundingClientRect().top + 40,
      label: target === 'empty' ? t('fileExplorer.menu.labelProject') : target === 'multi' ? t('fileExplorer.menu.labelMany', { count: paths.length }) : t('fileExplorer.menu.label', { name: item?.name || '' }),
      items: menuItems(model, { count: Math.max(1, paths.length) }),
      onSelect: (chosen) => act(chosen.id, { paths, path, item }),
    });
  }

  // What a menu item does. A list it returns is the menu's next page.
  function act(id, { paths, path, item }) {
    const all = paths.length ? paths : [S.root];
    if (id.startsWith('to:')) { sendPaths(all, id.slice(3)); return undefined; }
    if (id.startsWith('color:')) { host.colors.set(path, id.slice(6) || null); tree.refreshRows(); return undefined; }
    if (id.startsWith('sort:')) { S.sort = id.slice(5); try { storage.setItem(sortKey, S.sort); } catch { /* not kept */ } tree.render(); return undefined; }
    switch (id) {
      case 'open': openEntry(path, item, { pin: false }); break;
      case 'openKeep': openEntry(path, item, { pin: true }); break;
      case 'preview': openEntry(path, item); break;
      case 'openAsText': host.editor.openFile(path, { pin: true }); break;
      case 'send': sendPaths(all); break;
      case 'sendTo': return [back(), ...sender.targets().map((entry) => ({ id: `to:${entry.id}`, label: entry.name, icon: 'send' }))];
      case 'newFile': ops.create('file', folderFor(path, item)); break;
      case 'newFolder': ops.create('dir', folderFor(path, item)); break;
      case 'expand': toggleFolder(path, true); break;
      case 'collapse': toggleFolder(path, false); break;
      case 'collapseChildren':
        for (const open of [...(S.view ? S.viewOpen : S.expanded)]) if (open !== path && isWithin(path, open)) { (S.view ? S.viewOpen : S.expanded).delete(open); if (S.view) S.viewClosed.add(open); }
        tree.renderDir(path); syncWatch(); persistSoon();
        break;
      case 'cut': ops.cut(all); break;
      case 'copy': ops.copy(all); break;
      case 'paste': ops.paste(folderFor(path, item)); break;
      case 'duplicate': ops.duplicate(all); break;
      case 'copyPath': ops.copyPath(all); break;
      case 'copyRelativePath': ops.copyPath(all, { relative: true }); break;
      case 'copyName': ops.copyName(path); break;
      case 'color': {
        const now = host.colors.of(path) || host.colors.all[0].hex;
        return [back(), ...host.colors.all.map((color) => ({ id: `color:${color.hex === host.colors.all[0].hex ? '' : color.hex}`, swatch: color.hex, label: t(`fileExplorer.colors.${color.key}`), checked: color.hex === now }))];
      }
      case 'rename': ops.rename(path); break;
      case 'delete': ops.remove(all); break;
      case 'reveal': ops.reveal(path || S.root); break;
      case 'changedOnly': setChangedOnly(!S.changedOnly); break;
      case 'sortBy': return [back(), ...SORTS.map((mode) => ({ id: `sort:${mode}`, label: t(`fileExplorer.menu.sort.${mode}`), checked: S.sort === mode }))];
      case 'expandAll': expandLevel(); break;
      case 'collapseAll': collapseAll(); break;
      case 'refresh': refreshAll(); break;
      default:
    }
    return undefined;
  }

  // A key of the tree that is about files rather than rows.
  function onAction(action, { paths, focus }) {
    const item = focus ? tree.itemOf(focus) : null;
    switch (action) {
      case 'delete': if (paths.length) ops.remove(paths); break;
      case 'rename': if (focus) ops.rename(focus); break;
      case 'copy': ops.copy(paths); break;
      case 'cut': ops.cut(paths); break;
      case 'paste': ops.paste(folderFor(focus, item)); break;
      case 'copyPath': ops.copyPath(paths.length ? paths : [S.root]); break;
      case 'copyRelativePath': ops.copyPath(paths.length ? paths : [S.root], { relative: true }); break;
      case 'jump': jump(); break;
      case 'escape':
        if (isFlyoutOpen()) closeFlyout();
        else if (S.clipboard) { S.clipboard = null; tree.refreshRows(); notice.clear(); }
        else if (S.filter) clearFilter();
        else if (focus) tree.select([focus], { focus });
        break;
      default:
    }
  }

  function collapseAll() {
    if (S.view) { for (const path of S.viewOpen) S.viewClosed.add(path); S.viewOpen = new Set(); } else S.expanded.clear();
    tree.render();
    syncWatch();
    persistSoon();
  }
  // Open every closed folder that is in sight, one level.
  async function expandLevel() {
    const closed = tree.order().filter((path) => tree.itemOf(path)?.type === 'dir' && !isExpanded(path)).slice(0, EXPAND_LEVEL_MAX);
    const set = S.view ? S.viewOpen : S.expanded;
    for (const path of closed) { set.add(path); S.viewClosed.delete(path); }
    tree.render();
    await Promise.all(closed.filter((path) => S.dirs.get(path)?.state !== 'ready' && !(S.view && S.view.dirs.has(rel(path)))).map(loadDir));
    tree.render();
    syncWatch();
    persistSoon();
  }

  // ── The panel around the tree ──

  function updateCount() {
    const count = $('fe-count');
    if (!count) return;
    const picked = tree.selection().selected.length;
    let text = '';
    if (!S.root) text = '';
    else if (picked > 1) text = tp('fileExplorer.count.selected', picked);
    else if (S.view?.pending) text = t('fileExplorer.state.searching');
    else if (S.view) text = tp(S.view.kind === 'changed' ? 'fileExplorer.count.changed' : 'fileExplorer.count.matches', S.view.count);
    else { const known = S.dirs.get(S.root); text = known?.state === 'ready' ? tp('fileExplorer.count.items', known.total) : ''; }
    count.textContent = text;
    const hint = $('fe-restart-hint');
    if (hint) hint.hidden = !(api.abilities().known && !api.abilities().ops);
  }
  function syncToolbar() {
    const changed = $('fe-changed-only');
    if (changed) { changed.setAttribute('aria-pressed', String(S.changedOnly)); changed.classList.toggle('active', S.changedOnly); }
    const shown = $('fe-reveal-active');
    const active = editor.state().active;
    if (shown) shown.disabled = !(active && S.root && isWithin(S.root, active));
  }

  function wire() {
    const on = (id, handler) => $(id)?.addEventListener('click', handler);
    const focusedFolder = () => { const at = tree.selection().focus; return folderFor(at, at ? tree.itemOf(at) : null); };
    on('fe-new-file', () => ops.create('file', focusedFolder()));
    on('fe-new-folder', () => ops.create('dir', focusedFolder()));
    on('fe-goto-file', jump);
    on('fe-changed-only', () => setChangedOnly(!S.changedOnly));
    on('fe-reveal-active', async () => {
      const active = editor.state().active;
      if (!active) { notice.show(t('fileExplorer.reveal.none')); return; }
      if (!(await reveal(active))) notice.show(t('fileExplorer.reveal.notShown', { name: baseName(active) }));
      else tree.focus();
    });
    on('fe-collapse-all', collapseAll);
    // Refresh also asks what the server has: one that was restarted since the page loaded is found out here.
    on('fe-refresh', async () => { await host.readServer?.(); await api.capabilities(); syncToolbar(); await refreshAll(); if (!watcher) startWatch(); });
    on('fe-more', (event) => { const box = event.currentTarget.getBoundingClientRect(); openMenu({ y: box.top + box.height / 2, keyboard: event.detail === 0 }); });
    on('fe-filter-clear', () => { clearFilter(); filterInput.focus(); });
    filterInput.addEventListener('input', () => setFilter(filterInput.value));
    filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && filterInput.value) { event.preventDefault(); event.stopPropagation(); clearFilter(); }
      else if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); tree.focus(); }
    });
    // Below the rows: the project itself.
    treeEl.addEventListener('pointerdown', (event) => { if (event.target === treeEl && event.button === 0 && !tree.isEditing()) tree.select([]); });
  }

  // ── A project ──

  function showNoProject() {
    tree.setRoot(null);
    const block = document.createElement('div');
    block.className = 'fe-empty';
    const words = document.createElement('p');
    words.textContent = t('fileExplorer.state.noProject');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fe-modal-btn fe-modal-cancel';
    button.textContent = t('fileExplorer.state.addProject');
    button.addEventListener('click', () => host.addProject());
    block.append(words, button);
    treeEl.append(block);
    updateCount();
  }

  /** Show a project (or none): its tree comes back as it was left. */
  function setProject(project) {
    persist();
    epoch++;
    stopWatch();
    saidLimited = false;
    closeFlyout({ refocus: false });
    searchAbort?.abort();
    clearTimeout(gitTimer);
    S.dirs = new Map(); S.git = gitIndex(null); S.view = null; S.viewOpen = new Set(); S.viewClosed = new Set();
    S.search = null; S.filter = ''; S.clipboard = null;
    reads.clear();
    if (filterInput) { filterInput.value = ''; $('fe-filter-clear').hidden = true; }
    host.onGit({ isGit: false, branch: '', count: 0 });
    if (!project?.path) { S.root = null; S.label = ''; S.expanded = new Set(); showNoProject(); loaded = Promise.resolve(); return loaded; }
    S.root = trimSlash(project.path);
    S.label = project.label || baseName(S.root);
    treeEl.setAttribute('aria-label', t('fileExplorer.tree', { project: S.label }));
    const kept = recallTreeState(readStored(), S.root);
    S.expanded = new Set(kept.expanded.filter((path) => isWithin(S.root, path) && path !== S.root));
    S.changedOnly = kept.changedOnly;
    syncToolbar();
    tree.setRoot(S.root);
    tree.render();
    const mine = epoch;
    loaded = (async () => {
      await api.capabilities();
      if (mine !== epoch) return;
      await loadDir(S.root);
      // The folders that were open, level by level: one that is gone takes its own with it.
      for (let round = 0; round < 40; round++) {
        if (mine !== epoch) return;
        prune();
        const next = shownDirs().filter((dir) => !S.dirs.has(dir));
        if (!next.length) break;
        await Promise.all(next.map(loadDir));
      }
      if (mine !== epoch) return;
      await (S.changedOnly ? loadGit() : (loadGit(), null));
      if (mine !== epoch) return;
      buildView();
      tree.render();
      if (!S.view) {
        tree.select(kept.selected, { focus: kept.focus, quiet: true, scroll: false });
        tree.setScrollTop(kept.top);
      }
      updateCount();
      startWatch();
    })();
    return loaded;
  }

  /** The panel is shown or hidden: the disk is followed only while it is shown. */
  function setVisible(visible) {
    S.visible = !!visible;
    if (S.visible) { if (S.root) { startWatch(); if (S.dirs.size) refreshAll(); } } else { persist(); stopWatch(); closeFlyout({ refocus: false }); }
  }

  /** Show a file of the project in the tree: its folders open, its row is selected and marked. */
  async function reveal(filePath) {
    const target = trimSlash(filePath);
    await loaded;
    if (!S.root || target === S.root || !isWithin(S.root, target)) return false;
    if (S.filter) { filterInput.value = ''; S.filter = ''; $('fe-filter-clear').hidden = true; S.search = null; }
    if (S.changedOnly && !S.git.statusOf(rel(target), false)) { S.changedOnly = false; syncToolbar(); }
    buildView();
    if (!(await openFolder(dirName(target))) || !tree.has(target)) { tree.render(); return false; }
    tree.select([target], { focus: target });
    tree.flash(target);
    updateCount();
    return true;
  }

  wire();
  editor.start();
  syncToolbar();

  return {
    setProject,
    setVisible,
    reveal,
    refresh: refreshAll,
    collapseAll,
    /** The icons changed: every row is drawn again. */
    redraw() { if (S.root) { const now = tree.selection(); const top = tree.scrollTop(); tree.setRoot(S.root); tree.render(); tree.select(now.selected, { focus: now.focus, quiet: true, scroll: false }); tree.setScrollTop(top); } },
    whenLoaded: () => loaded,
    /** Close the menu or the preview that is open (the editor is opening). */
    closeMenus: () => closeFlyout({ refocus: false }),
    notice,
    api,
    state: S,
    tree,
  };
}
