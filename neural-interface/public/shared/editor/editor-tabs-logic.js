// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the tabs, as a model
// ═══════════════════════════════════════════
//
// Which documents the editor panel holds, in which order, which one is shown,
// and what an open or a close does to that: a file that is already open is
// shown again, a tab nobody edited or pinned is reused by the next file, a
// closed tab gives its place to the one used before it. Also what is kept of
// the tabs per project, and what comes back from it. editor-panel.js holds the
// documents themselves (their text, history and file facts) by tab id;
// editor-tabs.js draws the strip. No DOM and no imports: loaded by
// `node --test` as it is.

/** Tabs kept per project, and projects kept at all. */
export const MAX_REMEMBERED_TABS = 20;
export const MAX_REMEMBERED_PROJECTS = 30;
export const REMEMBERED_VERSION = 1;

/**
 * @typedef {object} EditorTab
 * @property {string} id unique for the page
 * @property {string} key what it is a tab of: a file by its path, a plan or a changelog by its identity too
 * @property {'file' | 'plan' | 'changelog'} kind
 * @property {string} path
 * @property {string} name the file's name
 * @property {boolean} pinned false while the next file opened may take its place
 */

/**
 * @typedef {object} EditorTabs
 * @property {EditorTab[]} tabs in strip order
 * @property {string | null} activeId
 * @property {string[]} recent ids, the most recently shown first
 * @property {number} seq
 */

/** A path with forward slashes, the way the server answers it. */
export function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/');
}

/** The last part of a path. */
export function fileName(path) {
  const text = normalizePath(path);
  return text.slice(text.lastIndexOf('/') + 1);
}

/**
 * What a tab is a tab of. Two requests with the same key are the same tab.
 * @param {{ kind?: 'file' | 'plan' | 'changelog', path: string, identity?: string }} of `identity` tells one plan
 *   of a file from another (the panel that asked, the plan, the revision)
 */
export function tabKey({ kind = 'file', path, identity = '' } = {}) {
  const where = normalizePath(path);
  return kind === 'file' ? `file:${where}` : `${kind}:${identity}:${where}`;
}

/** @returns {EditorTabs} no tab open */
export function createTabs() {
  return { tabs: [], activeId: null, recent: [], seq: 0 };
}

export const getTab = (model, id) => model.tabs.find((tab) => tab.id === id) || null;
export const findTab = (model, key) => model.tabs.find((tab) => tab.key === key) || null;
export const tabIndex = (model, id) => model.tabs.findIndex((tab) => tab.id === id);
export const activeTab = (model) => getTab(model, model.activeId);

const shown = (recent, id) => [id, ...recent.filter((other) => other !== id)];

/** Show a tab. An id that is not open changes nothing. */
export function activateTab(model, id) {
  if (!getTab(model, id)) return model;
  if (model.activeId === id && model.recent[0] === id) return model;
  return { ...model, activeId: id, recent: shown(model.recent, id) };
}

/**
 * Open something in a tab and show it.
 * - Already open (same key): that tab is shown; `pin` pins it.
 * - A tab that was never pinned is open: the new document takes its place, under a new id.
 * - Otherwise a tab is added to the right of the one that is shown.
 * A plan or a changelog is pinned from the start; a file is pinned when `pin` says so.
 * @param {EditorTabs} model
 * @param {{ key: string, kind?: 'file' | 'plan' | 'changelog', path: string, name?: string, pin?: boolean }} request
 * @param {{ canReuse?: (tab: EditorTab) => boolean }} [o] a tab that may not be given up (unsaved text, a save
 *   under way) is not reused even when it was never pinned
 * @returns {{ model: EditorTabs, id: string, outcome: 'activated' | 'replaced' | 'added', replacedId: string | null }}
 */
export function openTab(model, { key, kind = 'file', path, name, pin = false }, { canReuse = () => true } = {}) {
  const existing = findTab(model, key);
  if (existing) {
    const tabs = pin && !existing.pinned ? model.tabs.map((tab) => (tab.id === existing.id ? { ...tab, pinned: true } : tab)) : model.tabs;
    return { model: activateTab({ ...model, tabs }, existing.id), id: existing.id, outcome: 'activated', replacedId: null };
  }
  const seq = model.seq + 1;
  const tab = { id: `tab-${seq}`, key, kind, path: normalizePath(path), name: name || fileName(path), pinned: !!pin || kind !== 'file' };
  const reusable = model.tabs.find((other) => !other.pinned && canReuse(other));
  if (reusable) {
    const tabs = model.tabs.map((other) => (other.id === reusable.id ? tab : other));
    const recent = shown(model.recent.filter((id) => id !== reusable.id), tab.id);
    return { model: { tabs, activeId: tab.id, recent, seq }, id: tab.id, outcome: 'replaced', replacedId: reusable.id };
  }
  const at = tabIndex(model, model.activeId);
  const tabs = [...model.tabs];
  tabs.splice(at === -1 ? tabs.length : at + 1, 0, tab);
  return { model: { tabs, activeId: tab.id, recent: shown(model.recent, tab.id), seq }, id: tab.id, outcome: 'added', replacedId: null };
}

/** Keep a tab: the next file opened no longer takes its place. */
export function pinTab(model, id) {
  const tab = getTab(model, id);
  if (!tab || tab.pinned) return model;
  return { ...model, tabs: model.tabs.map((other) => (other.id === id ? { ...other, pinned: true } : other)) };
}

/** Change what a tab says about itself (the path the server resolved, its name). The id and the order stay. */
export function updateTab(model, id, patch) {
  if (!getTab(model, id)) return model;
  return { ...model, tabs: model.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch, id: tab.id } : tab)) };
}

/**
 * Close a tab. When it was the one shown, the tab used before it is shown; when none was, its neighbour.
 * @returns {{ model: EditorTabs, activeId: string | null }}
 */
export function closeTab(model, id) {
  const at = tabIndex(model, id);
  if (at === -1) return { model, activeId: model.activeId };
  const tabs = model.tabs.filter((tab) => tab.id !== id);
  const recent = model.recent.filter((other) => other !== id);
  let activeId = model.activeId;
  if (activeId === id) activeId = recent.find((other) => tabs.some((tab) => tab.id === other)) || tabs[Math.min(at, tabs.length - 1)]?.id || null;
  const next = { ...model, tabs, activeId, recent: activeId ? shown(recent, activeId) : recent };
  return { model: next, activeId };
}

/**
 * The tabs a "close" command means.
 * @param {EditorTabs} model
 * @param {'one' | 'others' | 'saved' | 'all'} scope
 * @param {string | null} id the tab the command was given on
 * @param {(tab: EditorTab) => boolean} [isDirty] has unsaved changes ("saved" leaves those open)
 * @returns {string[]} ids, in strip order
 */
export function closeTargets(model, scope, id, isDirty = () => false) {
  if (scope === 'one') return getTab(model, id) ? [id] : [];
  if (scope === 'others') return model.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id);
  if (scope === 'saved') return model.tabs.filter((tab) => !isDirty(tab)).map((tab) => tab.id);
  return model.tabs.map((tab) => tab.id);
}

/** Put a tab at another place in the strip (`index` is its place afterwards). */
export function moveTab(model, id, index) {
  const from = tabIndex(model, id);
  if (from === -1) return model;
  const tabs = model.tabs.filter((tab) => tab.id !== id);
  const to = Math.max(0, Math.min(tabs.length, Math.floor(Number(index)) || 0));
  if (to === from) return model;
  tabs.splice(to, 0, model.tabs[from]);
  return { ...model, tabs };
}

/** The tab `delta` places from another in the strip, going round at the ends. Null when there is no other. */
export function neighborTab(model, id, delta) {
  const at = tabIndex(model, id);
  if (at === -1 || model.tabs.length < 2) return null;
  const count = model.tabs.length;
  return model.tabs[(((at + delta) % count) + count) % count].id;
}

/**
 * What each tab shows as its name. Two files with the same name also show the folders that tell them apart.
 * @param {EditorTab[]} tabs
 * @returns {Map<string, { name: string, hint: string }>} by tab id; `hint` is '' for a name that is the only one
 */
export function tabLabels(tabs) {
  const labels = new Map(tabs.map((tab) => [tab.id, { name: tab.name, hint: '' }]));
  const byName = new Map();
  for (const tab of tabs) byName.set(tab.name, [...(byName.get(tab.name) || []), tab]);
  for (const same of byName.values()) {
    if (same.length < 2) continue;
    const folders = same.map((tab) => normalizePath(tab.path).split('/').slice(0, -1).filter(Boolean));
    const deepest = Math.max(...folders.map((parts) => parts.length));
    let depth = 1;
    const hintAt = (parts, n) => parts.slice(-n).join('/');
    while (depth < deepest && new Set(folders.map((parts) => hintAt(parts, depth))).size < same.length) depth++;
    same.forEach((tab, i) => { labels.set(tab.id, { name: tab.name, hint: hintAt(folders[i], depth) }); });
  }
  return labels;
}

// ── What is kept of the tabs ──

const position = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * The open files as they are kept for a project: their order, the one shown, and for each where the caret and
 * the top of the view were. Plans and changelogs are not kept: each belongs to the panel that asked for it.
 * @param {EditorTabs} model
 * @param {(tab: EditorTab) => ({ anchor?: number, head?: number, top?: number, dirty?: boolean } | null)} describe
 *   where a tab is; null leaves the tab out (a file that could not be opened)
 * @returns {{ active: string | null, tabs: { path: string, pinned: boolean, anchor: number, head: number, top: number, dirty: boolean }[] }}
 */
export function serializeTabs(model, describe = () => ({})) {
  let kept = [];
  for (const tab of model.tabs) {
    if (tab.kind !== 'file') continue;
    const at = describe(tab);
    if (!at) continue;
    kept.push({ id: tab.id, path: tab.path, pinned: !!tab.pinned, anchor: position(at.anchor), head: position(at.head), top: position(at.top), dirty: !!at.dirty });
  }
  if (kept.length > MAX_REMEMBERED_TABS) {
    // The ones used last stay, in strip order.
    const rank = (id) => { const at = model.recent.indexOf(id); return at === -1 ? Infinity : at; };
    const keep = new Set([...kept].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, MAX_REMEMBERED_TABS).map((tab) => tab.id));
    kept = kept.filter((tab) => keep.has(tab.id));
  }
  const active = kept.find((tab) => tab.id === model.activeId) || null;
  return { active: active ? active.path : null, tabs: kept.map(({ id, ...tab }) => tab) };
}

/**
 * A model from what was kept: every file as a tab that is not loaded yet.
 * @param {{ active?: string | null, tabs?: object[] } | null} snapshot from serializeTabs()
 * @returns {{ model: EditorTabs, places: Map<string, { anchor: number, head: number, top: number, dirty: boolean }> }}
 *   `places`: by tab id, where each tab was
 */
export function restoreTabs(snapshot) {
  let model = createTabs();
  const places = new Map();
  let unpinned = false;
  for (const entry of Array.isArray(snapshot?.tabs) ? snapshot.tabs.slice(0, MAX_REMEMBERED_TABS) : []) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) continue;
    const key = tabKey({ path: entry.path });
    if (findTab(model, key)) continue;
    // At most one tab is waiting to be reused; one with unsaved text never is.
    const pinned = entry.pinned !== false || !!entry.dirty || unpinned;
    if (!pinned) unpinned = true;
    const seq = model.seq + 1;
    const tab = { id: `tab-${seq}`, key, kind: 'file', path: normalizePath(entry.path), name: fileName(entry.path), pinned };
    model = { ...model, tabs: [...model.tabs, tab], seq };
    places.set(tab.id, { anchor: position(entry.anchor), head: position(entry.head), top: position(entry.top), dirty: !!entry.dirty });
  }
  const active = (typeof snapshot?.active === 'string' && findTab(model, tabKey({ path: snapshot.active }))) || model.tabs[0] || null;
  if (active) model = { ...model, activeId: active.id, recent: [active.id] };
  return { model, places };
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The stored value with one project's tabs replaced. A project with no tab open is forgotten; beyond
 * MAX_REMEMBERED_PROJECTS the ones not opened for the longest time are.
 * @param {object | null} stored what storage holds (parsed), or anything
 * @param {string} project the project's folder, '' when none is selected
 * @param {{ active: string | null, tabs: object[] }} snapshot from serializeTabs()
 * @param {number} now
 */
export function rememberTabs(stored, project, snapshot, now) {
  const projects = { ...(isObject(stored) && stored.v === REMEMBERED_VERSION && isObject(stored.projects) ? stored.projects : {}) };
  const name = String(project ?? '');
  if (snapshot?.tabs?.length) projects[name] = { at: now, active: snapshot.active ?? null, tabs: snapshot.tabs };
  else delete projects[name];
  const names = Object.keys(projects);
  if (names.length > MAX_REMEMBERED_PROJECTS) {
    names.sort((a, b) => (Number(projects[b]?.at) || 0) - (Number(projects[a]?.at) || 0));
    for (const old of names.slice(MAX_REMEMBERED_PROJECTS)) delete projects[old];
  }
  return { v: REMEMBERED_VERSION, projects };
}

/** What is kept for a project, or null. */
export function recallTabs(stored, project) {
  if (!isObject(stored) || stored.v !== REMEMBERED_VERSION || !isObject(stored.projects)) return null;
  const entry = stored.projects[String(project ?? '')];
  return isObject(entry) && Array.isArray(entry.tabs) && entry.tabs.length ? { active: entry.active ?? null, tabs: entry.tabs } : null;
}

// ── A file that has another path now ──

const withoutEndSlash = (path) => { const text = normalizePath(path); return text.length > 1 ? text.replace(/\/+$/, '') : text; };

/**
 * Where `path` is after `from` was renamed or moved to `to`: `from` may be the file itself or a folder that holds
 * it.
 * @returns {string | null} null when `path` is neither `from` nor inside it
 */
export function repointPath(path, from, to) {
  const at = normalizePath(path);
  const old = withoutEndSlash(from);
  const now = withoutEndSlash(to);
  if (!at || !old || !now) return null;
  if (at === old) return now;
  return at.startsWith(`${old}/`) ? now + at.slice(old.length) : null;
}

/**
 * What is kept of the tabs (of every project) after a file, or a folder of files, was renamed or moved: each tab of
 * it is kept at its new path, with its place, its pin and its unsaved mark. A tab that was already kept for the
 * new path gives way to the one that moved there (the file it named was replaced).
 * @param {object | null} stored what storage holds (parsed), or anything
 * @returns {{ stored: object | null, moved: { from: string, to: string, dirty: boolean }[] }} `stored` is the value
 *   to write, the same object when nothing changed; `moved`: the kept tabs that have another path now
 */
export function repointRemembered(stored, from, to) {
  if (!isObject(stored) || stored.v !== REMEMBERED_VERSION || !isObject(stored.projects)) return { stored, moved: [] };
  const moved = new Map();   // the path a tab was kept at → { from, to, dirty }
  const projects = {};
  for (const [name, entry] of Object.entries(stored.projects)) {
    const tabs = isObject(entry) && Array.isArray(entry.tabs) ? entry.tabs : [];
    const next = tabs.map((tab) => {
      const now = tab && typeof tab.path === 'string' ? repointPath(tab.path, from, to) : null;
      return now && now !== normalizePath(tab.path) ? now : null;
    });
    if (!next.some(Boolean)) { projects[name] = entry; continue; }
    // One tab per file: the one that moved stays, a tab that was kept for the path it moved to goes.
    const arrived = new Set(next.filter(Boolean));
    const kept = [];
    tabs.forEach((tab, at) => {
      if (!next[at]) { if (!(tab && arrived.has(normalizePath(tab.path)))) kept.push(tab); return; }
      const old = normalizePath(tab.path);
      const pair = moved.get(old) || { from: old, to: next[at], dirty: false };
      pair.dirty = pair.dirty || !!tab.dirty;
      moved.set(old, pair);
      kept.push({ ...tab, path: next[at] });
    });
    const active = typeof entry.active === 'string' ? repointPath(entry.active, from, to) || entry.active : entry.active ?? null;
    projects[name] = { ...entry, active, tabs: kept };
  }
  return moved.size ? { stored: { ...stored, projects }, moved: [...moved.values()] } : { stored, moved: [] };
}
