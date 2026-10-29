// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the window and its places
// ═══════════════════════════════════════════
//
// The Studio's shell, in Automation Studio's manner (one view machine, one render switch): a window with a rail of
// three places (Library · Review · Create) and, from a place, one workspace for the skill, agent or command opened
// (Edit · Test · Versions · Publish). Built on the Skills Service (lib/skills/api-v2.js): the catalog of every
// runtime folder, the managed library, its drafts, revisions, install plans and the Review queue.
//
// The window is non-modal unless the owner dims the background (then the page under it waits, and the keyboard
// stays in the window); it can be docked beside the side panels so a conversation stays usable next to it; it
// opens where it was left, at the size it had. Keys reach it only while the focus is in it: Escape closes the
// topmost thing that is open (a question, a menu), leaves a text field, and only then closes the window, which
// asks first when something is unsaved. Every answer that arrives after the window closed (or another workspace
// opened) is dropped. Strings are `skillsStudio.*` (i18n/en.json, pt-BR.json).

import { studioErrorText } from './sx-errors.js';
import { t, tp, getLocale } from '../../i18n.js';
import { storage } from '../../storage.js';
import { emit } from '../../state.js';
import { isGuest, hasPermission, showGuestToast } from '../../ui-sync.js';
import { KEYS } from '../../constants.js';
import { createUnloadGuard } from '../../editor/editor-safety.js';
import { askInPanel, dialogOpen, closeDialog } from '../ss-dialog.js';
import { closeDropdowns } from '../../cc-dropdown.js';
import * as api from '../../api.js';
import { readWholeCatalog, buildRows, countRows, projectsOf, keepSelection } from './sx-library.js';
import { initialRect, parseOpen } from './sx-geometry.js';
import { frameRect } from '../../app-frame.js';
import { updateCards, reviewCount } from './sx-review.js';
import { newWorkspace, dirtyTabs, saveTab, dropDraft, backups, keptDrafts } from './sx-docs.js';
import { html, setHTML, ICONS, idempotencyKey, inTextField, focusableIn, trapIndex } from './sx-dom.js';
import { renderLibraryPlace, focusLibrary, leaveLibraryPlace } from './sx-library-view.js';
import { renderReviewPlace, leaveReviewPlace, forgetReviewOutcomes } from './sx-review-view.js';
import { renderCreatePlace, startImport, leaveCreatePlace, openCreation } from './sx-create-view.js';
import { importFile } from './sx-import.js';
import { renderWorkspace, closeWorkspaceMenus, workspaceShortcut, disposeWorkspace, disposeStudio, refreshWorkspaceChrome } from './sx-workspace-view.js';
import { refreshPublishBusy } from './sx-publish-view.js';
import { leaveTestTab } from './sx-test-view.js';
import { renderOperationsPlace, leaveOperationsPlace } from './sx-operations-view.js';
import { onInstallBusy } from './sx-install-flow.js';

const PANEL_ID = 'skills-studio-panel';
const DOCK_KEY = 'skills-studio-docked';
const DIM_KEY = 'skills-studio-dim';
const RAIL_KEY = 'skills-studio-rail-collapsed';
const KEPT_UPDATES_KEY = 'skills-studio-kept-updates';
const LIB_KEY = 'skills-studio-library-view';
const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');

// ── State ──

const S = {
  panel: null, backdrop: null, gen: 0, life: null, unload: null, opener: null,
  caps: null, capsFailed: false,
  data: null, loading: null, loadError: null,
  rows: [], counts: null, projects: [], updates: [],
  place: 'library', ws: null, workspaces: new Map(),
  lib: { view: 'all', kind: 'all', source: 'all', runtime: 'all', health: 'any', q: '', sort: 'attention', selected: new Set(), focus: null },
  docked: false, dim: false, changeTimer: 0,
};
let _cache = null;          // what was last read (a later opening paints from it, then reads again behind it)
let _capsPromise = null;

const guest = () => isGuest();

function readJson(key, fallback) {
  try { const v = JSON.parse(storage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
}

// ── Capabilities and data ──

/** What the service can do (GET /v2/capabilities), once per page; null while unknown. */
export function capabilities() {
  if (S.caps) return Promise.resolve(S.caps);
  if (!_capsPromise) {
    _capsPromise = api.fetchSkillsCapabilities()
      .then((res) => { S.caps = new Set(Array.isArray(res?.capabilities) ? res.capabilities.filter((c) => typeof c === 'string') : []); S.capsFailed = false; return S.caps; })
      .catch((err) => { S.capsFailed = true; _capsPromise = null; throw err; });
  }
  return _capsPromise;
}

async function readCatalog() {
  return readWholeCatalog(api.fetchSkillsCatalog);
}

/** What this app version ships of each bundled skill: its upstream revision and the digest of its SKILL.md. */
async function readUpstream(skills) {
  const out = {};
  for (const s of skills.filter((x) => x.origin?.kind === 'bundled' && x.pointers?.upstream)) {
    try {
      const rev = (await api.fetchSkillsRevision(s.pointers.upstream)).revision;
      const head = (rev?.manifest?.files || []).find((f) => f.path === 'SKILL.md');
      out[String(s.origin.name || s.name).toLowerCase()] = { revisionId: rev.revisionId, headDigest: head?.digest || null };
    } catch { /* an update cannot be told for it: no card */ }
  }
  return out;
}

/** Read everything the Library shows (the catalog, the library, the status, the queue). */
export function loadData() {
  if (S.loading) return S.loading;
  const run = (async () => {
    await capabilities();
    const [catalog, skills, status, reviews, config, notice, archived] = await Promise.all([
      readCatalog(),
      api.fetchSkillsList().then((r) => r.skills || []),
      api.fetchSkillsStatus().catch(() => null),
      api.fetchSkillsReviews({}).then((r) => r.reviews || []).catch(() => []),
      // The skills settings (the shared folder on or off): what a review's install goes to is decided with them.
      api.fetchSkillsConfig().then((r) => r.config || {}).catch(() => ({ sharedAgentsRoot: false })),
      // The start-up move of the old bridges, said once (a server from before it has no notice: nothing is shown).
      S.caps?.has('auto-migration') ? api.fetchSkillsMigrationNotice().then((r) => r.notice || null).catch(() => null) : Promise.resolve(null),
      // The skills deleted from the library (a server from before Restore lists none).
      S.caps?.has('library-restore') ? api.fetchSkillsArchived().then((r) => (Array.isArray(r.archived) ? r.archived : [])).catch(() => []) : Promise.resolve([]),
    ]);
    const upstream = await readUpstream(skills);
    _cache = { catalog, skills, status, reviews, upstream, config, notice, archived, at: Date.now() };
    return _cache;
  })();
  S.loading = run;
  // Settle the loading state before callers render the fulfilled/rejected request.
  // A chained finally runs after an awaiting caller's catch and could leave the Library stuck on Loading.
  run.then(() => { S.loadError = null; if (S.loading === run) S.loading = null; }, (err) => { S.loadError = err; if (S.loading === run) S.loading = null; });
  return run;
}

function deriveRows() {
  const d = _cache;
  if (!d) { S.rows = []; S.counts = countRows([]); S.projects = []; S.updates = []; return; }
  S.data = d;
  // "Keep mine" is read here once for every place: the rows (health, attention, runtimes), the workspace banner, the
  // Review cards and the rail's count all leave a kept update out.
  const kept = readJson(KEPT_UPDATES_KEY, {});
  S.rows = buildRows({ entries: d.catalog.items, skills: d.skills, status: d.status, reviews: d.reviews.filter((r) => ['pending', 'changes_requested', 'approved', 'partial', 'publish_failed'].includes(r.state)), upstream: d.upstream, kept });
  S.counts = countRows(S.rows);
  S.counts.views.archived = Array.isArray(d.archived) ? d.archived.length : 0;
  S.projects = projectsOf(d.catalog.roots, S.rows);
  S.updates = updateCards(S.rows, kept);
  S.lib.selected = keepSelection(S.lib.selected, S.rows);
  // An open workspace follows its row (a new library state, installations, a review).
  for (const ws of S.workspaces.values()) {
    const row = S.rows.find((r) => r.key === ws.key) || (ws.skill ? S.rows.find((r) => r.skill?.skillId === ws.skill.skillId) : null);
    // The Library's summary is what was just read: its installations and pointers win over what the workspace read
    // earlier (the earlier reading keeps only what the summary lacks, its log).
    if (row) { ws.row = row; if (row.skill) ws.skill = { ...(ws.skill?.skillId === row.skill.skillId ? ws.skill : {}), ...row.skill }; }
  }
}

/** Launch prefetch: the Library read once after the page painted, so the first opening paints at once. */
export function prefetchStudio() {
  if (_cache || (guest() && !hasPermission('skills'))) return Promise.resolve();
  return loadData().catch(() => {});
}

// ── Opening and closing ──

export const isStudioOpen = () => !!S.panel;

/**
 * Open the Studio (or bring it forward), going where `detail` says (sx-geometry.js parseOpen).
 * @param {object} [detail]
 */
export async function openStudio(detail = {}) {
  if (guest() && !hasPermission('skills')) { showGuestToast(t('skillsStudio.guestDisabled')); return; }
  const want = parseOpen(detail);
  if (S.panel) {
    S.panel.focus({ preventScroll: true });
    await navigateTo(want);
    return;
  }
  S.gen++;
  S.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  S.docked = storage.getItem(DOCK_KEY) === 'true';
  S.dim = storage.getItem(DIM_KEY) === 'true' && !S.docked;
  S.lib = { ...S.lib, ...readJson(LIB_KEY, {}), selected: new Set(), focus: null, installNotice: null };
  S.backdrop = document.createElement('div');
  S.backdrop.className = `studio-backdrop sx-backdrop${S.dim ? '' : ' backdrop-hidden'}`;
  document.body.appendChild(S.backdrop);
  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.className = `skills-studio-panel sx glass resizable${S.docked ? ' sx-docked' : ''}`;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'sx-title');
  panel.setAttribute('aria-modal', S.dim ? 'true' : 'false');
  if (storage.getItem(RAIL_KEY) === 'true') panel.classList.add('sx-rail-collapsed');
  setHTML(panel, shellHTML());
  document.body.appendChild(panel);
  S.panel = panel;
  // Docked, it holds the work area as the code editor does: the map's top-right toolbar steps aside.
  document.body.classList.toggle('sx-studio-docked', S.docked);
  placeWindow();
  wireShell();
  S.unload = createUnloadGuard({ target: window, isDirty: () => anyDirty(), beforeLeave: () => backups().flush({ leaving: true }) });
  S.unload.install();
  const gen = S.gen;
  if (_cache) deriveRows();
  S.place = want.place === 'library' && !want.skillId && !want.artifactId && !want.name ? 'library' : want.place;
  render();
  requestAnimationFrame(() => { S.backdrop?.classList.add('open'); S.panel?.classList.add('open'); });
  panel.focus({ preventScroll: true });
  try {
    await loadData();
    if (gen !== S.gen || !S.panel) return;
    deriveRows();
    render({ keepFocus: true });
    await navigateTo(want, { first: true });
  } catch (err) {
    if (gen !== S.gen || !S.panel) return;
    render({ keepFocus: true });
  }
}

/**
 * Import a bundle file the menu's "Import…" picked before the Studio was loaded (the picker opens in the click that
 * asked for it; the Studio is loaded while the file is chosen): open on Create, read what the server can do, import.
 */
export async function openStudioWithImport(file) {
  await openStudio({ place: 'create' });
  if (!S.panel || !file) return;
  await importFile(ctx(), file, capabilities);
}

function placeWindow() {
  const panel = S.panel;
  if (S.docked) { panel.style.left = ''; panel.style.top = ''; panel.style.width = ''; panel.style.height = ''; return; }
  // Where the shared panel system saved it the last time it was moved or resized (ui-panels.js savePanelLayout).
  let saved = null;
  try { saved = JSON.parse(storage.getItem(`${KEYS.PANEL_PREFIX}${PANEL_ID}`) || 'null'); } catch { saved = null; }
  const rect = initialRect({ vw: window.innerWidth, vh: window.innerHeight, saved, frame: frameRect() });
  Object.assign(panel.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

function anyDirty() {
  for (const ws of S.workspaces.values()) if (dirtyTabs(ws).length) return true;
  return false;
}

/** Close the window. Unsaved documents are saved, kept for later (they come back), or discarded: the owner says. */
export async function requestCloseStudio() {
  if (!S.panel || dialogOpen()) return;
  const dirty = [];
  for (const ws of S.workspaces.values()) for (const tab of dirtyTabs(ws)) dirty.push({ ws, tab });
  if (dirty.length) {
    const names = dirty.slice(0, 6).map(({ ws, tab }) => `• ${ws.label} › ${tab.label}`);
    if (dirty.length > 6) names.push(`• ${t('skillsStudio.dialog.andMore', { count: dirty.length - 6 })}`);
    const answer = await ask({
      title: t('skillsStudio.dialog.unsavedTitle'),
      lines: [tp('skillsStudio.dialog.unsavedFiles', dirty.length), ...names, t('skillsStudio.dialog.keepForLaterHelp')],
      buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'discard', label: t('skillsStudio.dialog.discard'), kind: 'danger' }, { id: 'keep', label: t('skillsStudio.dialog.keepForLater') }, { id: 'save', label: t('skillsStudio.dialog.saveAll'), kind: 'primary' }],
    });
    if (answer === 'save') {
      for (const { ws, tab } of dirty) {
        try {
          const res = await saveTab(ws, tab, api, { key: idempotencyKey });
          if (res.status === 'conflict' || res.status === 'gone') { toast(t('skillsStudio.toast.saveConflict', { file: tab.label }), 'error'); return; }
        } catch (err) { toast(t('skillsStudio.toast.saveFailed', { file: tab.label, error: studioErrorText(t, err) }), 'error'); return; }
      }
    } else if (answer === 'discard') {
      for (const { ws, tab } of dirty) dropDraft(ws, tab);
    } else if (answer === 'keep') {
      backups().flush();
    } else return;
  }
  closeStudio();
}

/** Close now (the owner already said what happens to unsaved text). */
export function closeStudio() {
  if (!S.panel) return;
  S.gen++;   // every answer still on its way belongs to this opening: dropped
  clearTimeout(S.changeTimer);
  closeDialog();
  closeWorkspaceMenus(null);
  // The workspaces and the window's editor go now (the editor's view and listeners would outlive the panel).
  disposeStudio(S.workspaces.values());
  // The place drawn last ends its listeners, timers and follow-ups too (a creation's clock would tick on a removed panel).
  leaveLibraryPlace(); leaveReviewPlace(); leaveCreatePlace(); leaveTestTab(); leaveOperationsPlace();
  forgetReviewOutcomes();
  S.life?.abort();
  S.life = null;
  S.unload?.remove();
  S.unload = null;
  S.backdrop?.remove();
  S.backdrop = null;
  S.panel.remove();
  S.panel = null;
  document.body.classList.remove('sx-studio-docked');
  S.ws = null;
  S.workspaces.clear();
  S.place = 'library';
  storage.setItem(LIB_KEY, JSON.stringify({ view: S.lib.view, kind: S.lib.kind, source: S.lib.source, runtime: S.lib.runtime, health: S.lib.health, sort: S.lib.sort }));
  const back = S.opener;
  S.opener = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
}

// ── The shell ──

function shellHTML() {
  const handles = ['t', 'r', 'b', 'l', 'tl', 'tr', 'bl', 'br'].map((d) => html`<div class="resize-handle resize-handle-${d}" data-resize="${d}"></div>`);
  return html`${handles}
    <header class="sx-head${S.docked ? '' : ' drag-handle'}" data-drag="${PANEL_ID}">
      <span class="sx-head-mark" aria-hidden="true">${ICONS.mark}</span>
      <h2 class="sx-title" id="sx-title">${t('skillsStudio.title')}</h2>
      <span class="sx-head-note" id="sx-head-note" role="status"></span>
      <span class="sx-spacer"></span>
      <button type="button" class="sx-icon-btn" data-act="toggle-rail" aria-pressed="false" aria-label="${t('skillsStudio.shell.collapseRail')}" title="${t('skillsStudio.shell.collapseRail')}">${ICONS.library}</button>
      <button type="button" class="sx-icon-btn" data-act="dock" aria-pressed="${S.docked ? 'true' : 'false'}" aria-label="${t('skillsStudio.shell.dock')}" title="${t('skillsStudio.shell.dockHelp')}">${S.docked ? ICONS.undock : ICONS.dock}</button>
      <button type="button" class="sx-icon-btn" data-act="dim" aria-pressed="${S.dim ? 'true' : 'false'}" aria-label="${t('skillsStudio.shell.dim')}" title="${t('skillsStudio.shell.dimHelp')}"${S.docked ? ' disabled' : ''}>${ICONS.dim}</button>
      <button type="button" class="sx-icon-btn sx-close" data-act="close" aria-label="${t('skillsStudio.shell.close')}" title="${t('skillsStudio.shell.close')}">${ICONS.close}</button>
    </header>
    <div class="sx-body">
      <nav class="sx-rail" id="sx-rail" aria-label="${t('skillsStudio.title')}"></nav>
      <main class="sx-main" id="sx-main" aria-labelledby="sx-title"></main>
    </div>
    <p class="sx-sr" id="sx-live" role="status" aria-live="polite"></p>`;
}

function wireShell() {
  S.life?.abort();
  S.life = new AbortController();
  const signal = S.life.signal;
  S.panel.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !S.panel.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'close') requestCloseStudio();
    else if (act === 'dock') toggleDock();
    else if (act === 'dim') toggleDim();
    else if (act === 'toggle-rail') toggleRail();
    else if (act === 'place') goPlace(el.dataset.place);
    else if (act === 'view') { S.lib.view = el.dataset.view; S.lib.focus = null; goPlace('library'); }
    else if (act === 'runtime-filter') { S.lib.runtime = el.dataset.runtime; S.lib.view = 'all'; goPlace('library'); }
    else if (act === 'runtime-fix') openSkillFolders();
  }, { signal });
  // Keys only while the focus is in the Studio: the window is not modal, and the page beside it keeps its own.
  document.addEventListener('keydown', onKeydown, { signal });
  window.addEventListener('resize', () => { if (S.docked) return; placeWithinViewport(); }, { signal });
}

function placeWithinViewport() {
  if (!S.panel) return;
  const r = initialRect({ vw: window.innerWidth, vh: window.innerHeight, frame: frameRect(), saved: { left: S.panel.style.left, top: S.panel.style.top, width: S.panel.style.width, height: S.panel.style.height } });
  Object.assign(S.panel.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}

/**
 * Dimmed, the window is modal (aria-modal): Tab and Shift+Tab go round inside it, from the last control to the first
 * and back, and bring the keyboard back in from the page under it. True when the key was taken.
 */
function trapTab(e, inside) {
  if (!S.dim || e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return false;
  const items = focusableIn(S.panel);
  const active = document.activeElement;
  let pos = null;
  if (inside) {
    const at = items.indexOf(active);
    pos = at >= 0 ? at : items.filter((el) => el.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).length - 0.5;
  }
  const to = trapIndex(items.length, pos, { shift: e.shiftKey });
  if (to === -1) return false;
  e.preventDefault();
  (to === -2 ? S.panel : items[to]).focus({ preventScroll: false });
  return true;
}

function onKeydown(e) {
  if (!S.panel || e.defaultPrevented || dialogOpen()) return;
  const inside = S.panel.contains(e.target) || S.panel.contains(document.activeElement);
  if (trapTab(e, inside)) return;
  if (!inside) return;
  const mod = MAC ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape') {
    // The topmost thing that is open, and nothing under it.
    if (closeDropdowns(S.panel, { focus: true })) { e.preventDefault(); return; }
    if (closeWorkspaceMenus(S.panel)) { e.preventDefault(); return; }
    if (inTextField(e.target) && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      if (e.target.type === 'search' && e.target.value) { e.target.value = ''; e.target.dispatchEvent(new Event('input', { bubbles: true })); }
      else e.target.blur();
      e.preventDefault();
      return;
    }
    e.preventDefault();
    requestCloseStudio();
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); goPlace('library'); focusLibrary(S.panel); return; }
  if (S.place === 'workspace' && S.ws && workspaceShortcut(e, ctx())) { e.preventDefault(); return; }
}

function toggleDock() {
  S.docked = !S.docked;
  storage.setItem(DOCK_KEY, S.docked ? 'true' : 'false');
  if (S.docked && S.dim) toggleDim(false);
  S.panel.classList.toggle('sx-docked', S.docked);
  document.body.classList.toggle('sx-studio-docked', S.docked);
  const head = S.panel.querySelector('.sx-head');
  head?.classList.toggle('drag-handle', !S.docked);
  const btn = S.panel.querySelector('[data-act="dock"]');
  if (btn) { btn.setAttribute('aria-pressed', S.docked ? 'true' : 'false'); setHTML(btn, S.docked ? ICONS.undock : ICONS.dock); }
  const dim = S.panel.querySelector('[data-act="dim"]');
  if (dim) dim.disabled = S.docked;
  placeWindow();
  announce(t(S.docked ? 'skillsStudio.shell.docked' : 'skillsStudio.shell.undocked'));
}

function toggleDim(force) {
  S.dim = typeof force === 'boolean' ? force : !S.dim;
  storage.setItem(DIM_KEY, S.dim ? 'true' : 'false');
  S.backdrop?.classList.toggle('backdrop-hidden', !S.dim);
  S.panel.setAttribute('aria-modal', S.dim ? 'true' : 'false');
  const btn = S.panel.querySelector('[data-act="dim"]');
  if (btn) btn.setAttribute('aria-pressed', S.dim ? 'true' : 'false');
  announce(t(S.dim ? 'skillsStudio.shell.dimmed' : 'skillsStudio.shell.notDimmed'));
}

function toggleRail() {
  const on = !S.panel.classList.contains('sx-rail-collapsed');
  S.panel.classList.toggle('sx-rail-collapsed', on);
  storage.setItem(RAIL_KEY, on ? 'true' : 'false');
  S.panel.querySelector('[data-act="toggle-rail"]')?.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// ── Navigation ──

function goPlace(place) {
  if (!['library', 'review', 'create', 'discover', 'health'].includes(place)) return;
  S.place = place;
  render();
  focusPlace();
}

/**
 * Open a Library row in its workspace (the one it had, with its documents, when it was open before).
 * `revisionId`, `reviewId` and `preset` open Publish for something named (a version, an approved submission, an
 * update SynaBun ships, `preset(pub, targets)` ticking what it replaces): Publish starts over for it before it
 * is drawn, its ticks and any plan of before dropped.
 */
export async function openRow(key, { tab = null, file = null, line = null, revisionId = null, reviewId = null, preset = null } = {}) {
  const row = S.rows.find((r) => r.key === key);
  if (!row) return false;
  let ws = S.workspaces.get(row.key);
  if (!ws) { ws = newWorkspace(row, { guest: guest(), caps: S.caps || new Set() }); S.workspaces.set(row.key, ws); }
  if (tab) ws.tab = tab;
  if (revisionId || reviewId || preset) {
    ws.pub = null;
    ws.publishRevisionId = revisionId || null;
    ws.publishReviewId = reviewId || null;
    ws.pubPresetApply = typeof preset === 'function' ? preset : null;
  }
  if (file || line) ws.pendingReveal = { file, line };
  S.ws = ws;
  S.place = 'workspace';
  render();
  return true;
}

async function navigateTo(want, { first = false } = {}) {
  if (!S.panel) return;
  if (want.skillId || want.artifactId || want.name) {
    const row = S.rows.find((r) => (want.skillId && r.skill?.skillId === want.skillId) || (want.artifactId && r.entries.some((e) => e.id === want.artifactId))
      || (want.name && (r.folderName === want.name || r.name === want.name) && r.kind === 'skill'));
    if (row) { await openRow(row.key, { tab: want.tab, file: want.file, line: want.line }); return; }
  }
  if (want.place === 'review') { S.place = 'review'; S.reviewFocus = want.reviewId; render(); focusPlace(); return; }
  if (want.place === 'create') {
    S.place = 'create';
    // A link to an AI drafting opens it in Create's box (its progress, or what it made).
    if (want.creationId) openCreation(want.creationId);
    render();
    if (want.create === 'import') startImport(ctx());
    else focusPlace();
    return;
  }
  if (!first || S.place === 'library') { S.place = 'library'; render(); }
}

function focusPlace() {
  requestAnimationFrame(() => {
    const target = S.panel?.querySelector('#sx-main [data-autofocus]') || S.panel?.querySelector('#sx-main h3, #sx-main h2');
    if (target) { if (!target.hasAttribute('tabindex') && !/^(INPUT|TEXTAREA|BUTTON)$/.test(target.tagName)) target.tabIndex = -1; target.focus({ preventScroll: true }); }
  });
}

// ── Rendering ──

function railHTML() {
  const c = S.counts || countRows([]);
  const waiting = reviewCount((S.data?.reviews || []), S.updates);
  const place = S.place === 'workspace' ? 'library' : S.place;
  const item = (id, icon, label, count, extra = '') => html`<li><button type="button" class="sx-rail-item" data-act="place" data-place="${id}"${place === id ? html` aria-current="page"` : ''} title="${label}">
      <span class="sx-rail-icon">${icon}</span><span class="sx-rail-label">${label}</span>${count !== null ? html`<span class="sx-rail-count">${count}${extra ? html`<span class="sx-sr"> ${extra}</span>` : ''}</span>` : ''}</button></li>`;
  const views = ['attention', 'mine', 'synabun', 'plugins', 'account', 'drafts', ...(S.caps?.has('library-restore') ? ['archived'] : [])].map((v) => html`<li><button type="button" class="sx-rail-view" data-act="view" data-view="${v}"${S.place === 'library' && S.lib.view === v ? html` aria-current="true"` : ''}>
      <span class="sx-rail-label">${t(`skillsStudio.rail.views.${v}`)}</span><span class="sx-rail-count">${c.views[v] ?? 0}</span></button></li>`);
  const projects = S.projects.map((p) => html`<li><button type="button" class="sx-rail-view" data-act="view" data-view="${`project:${p.path}`}"${S.place === 'library' && S.lib.view === `project:${p.path}` ? html` aria-current="true"` : ''} title="${p.path}">
      <span class="sx-rail-label">${p.label}</span><span class="sx-rail-count">${p.count}</span></button></li>`);
  return html`
    <ul class="sx-rail-list">
      ${item('library', ICONS.library, t('skillsStudio.rail.library'), c.total, '')}
      ${item('review', ICONS.review, t('skillsStudio.rail.review'), waiting || null, t('skillsStudio.rail.waiting'))}
      ${item('create', ICONS.create, t('skillsStudio.rail.create'), null)}
      ${item('discover', ICONS.search, t('skillsStudio.operations.discover'), null)}
      ${item('health', ICONS.history, t('skillsStudio.operations.health'), null)}
    </ul>
    <div class="sx-rail-groups">
      <p class="sx-rail-group-label" id="sx-rail-views">${t('skillsStudio.rail.viewsTitle')}</p>
      <ul class="sx-rail-list" aria-labelledby="sx-rail-views">${views}</ul>
      ${S.projects.length ? html`<p class="sx-rail-group-label" id="sx-rail-projects">${t('skillsStudio.rail.projectsTitle')}</p><ul class="sx-rail-list" aria-labelledby="sx-rail-projects">${projects}</ul>` : ''}
    </div>
    ${runtimeFootHTML()}`;
}

/**
 * Settings → Skills → Skill folders, where the old bridge files are moved to skill folders (Move). The settings
 * module is loaded when asked for (never at the Studio's load: it is the page's, and heavy).
 */
async function openSkillFolders() {
  try {
    const m = await import('../../ui-settings.js');
    await m.openSettingsModal({ tab: 'tool-access', expand: ['stg-sec-skills'], scrollTo: 'stg-skill-folders' });
  } catch { toast(t('skillsStudio.rail.runtimeFixFailed'), 'error'); }
}

/**
 * The runtimes at the foot of the rail: ready, reached through old bridge files only (the old format: the row opens
 * Settings → Skills → Skill folders, where Move gives each skill a folder of its own), empty, or not set up.
 */
function runtimeFootHTML() {
  const roots = S.data?.catalog?.roots || [];
  const state = (runtime) => {
    const family = runtime;
    const own = roots.filter((r) => r.family === family && r.kind === 'skills' && r.scope === 'user' && r.sourceKind === 'native');
    const bridged = S.rows.some((r) => r.bridges.some((b) => b.runtime === runtime));
    if (bridged) return 'bridge';
    if (own.some((r) => r.status === 'ok')) return 'ready';
    return own.length ? 'empty' : 'unknown';
  };
  const rows = ['claude', 'codex', 'opencode'].map((rt) => {
    const st = state(rt);
    const name = t(`skillsStudio.runtime.${rt}`);
    const label = st === 'bridge' ? t('skillsStudio.rail.runtimeFix', { runtime: name }) : `${name}: ${t(`skillsStudio.rail.runtimeState.${st}`)}`;
    return html`<button type="button" class="sx-rt-row${st === 'bridge' ? ' sx-rt-row--fix' : ''}" data-act="${st === 'bridge' ? 'runtime-fix' : 'runtime-filter'}" data-runtime="${rt}" aria-label="${label}" title="${label}">
      <span class="sx-rt-dot sx-rt-${st}" aria-hidden="true"></span><span class="sx-rt-name">${name}</span><span class="sx-rt-state">${t(`skillsStudio.rail.runtimeState.${st}`)}</span></button>`;
  });
  return html`<div class="sx-rail-foot" role="group" aria-label="${t('skillsStudio.rail.runtimesTitle')}">${rows}</div>`;
}

function headNote() {
  const note = S.panel?.querySelector('#sx-head-note');
  if (!note) return;
  if (S.capsFailed) setHTML(note, html`<span class="sx-note-warn">${t('skillsStudio.shell.olderServer')}</span>`);
  else if (S.loading && !_cache) setHTML(note, t('skillsStudio.shell.loading'));
  else setHTML(note, '');
}

/** Draw the current place (keeping where the keyboard was when asked). */
export function render({ keepFocus = false } = {}) {
  if (!S.panel) return;
  const active = keepFocus ? document.activeElement : null;
  const activeId = active && S.panel.contains(active) ? active.id || null : null;
  setHTML(S.panel.querySelector('#sx-rail'), railHTML());
  headNote();
  const main = S.panel.querySelector('#sx-main');
  const c = ctx();
  main.dataset.place = S.place;
  if (S.capsFailed && !_cache) { renderOlderServer(main); return; }
  // Every place listens on the one main area: the one drawn before ends its listeners first (a Library listener left
  // on would also answer inside a workspace: a dropdown opened and closed by the same click).
  leaveLibraryPlace(); leaveReviewPlace(); leaveCreatePlace(); leaveTestTab(); leaveOperationsPlace();
  if (S.place === 'library') renderLibraryPlace(main, c);
  else if (S.place === 'review') renderReviewPlace(main, c);
  else if (S.place === 'create') renderCreatePlace(main, c);
  else if (S.place === 'discover' || S.place === 'health') renderOperationsPlace(main, c, S.place);
  else if (S.place === 'workspace' && S.ws) renderWorkspace(main, c, S.ws);
  else { S.place = 'library'; renderLibraryPlace(main, c); }
  if (activeId) { const again = S.panel.querySelector(`#${CSS.escape(activeId)}`); if (again) again.focus({ preventScroll: true }); }
}

function renderOlderServer(main) {
  setHTML(main, html`<div class="sx-empty" role="alert">
    <h3 class="sx-empty-title" tabindex="-1" data-autofocus>${t('skillsStudio.shell.olderServerTitle')}</h3>
    <p>${t('skillsStudio.shell.olderServerHelp')}</p>
    <button type="button" class="sx-btn" id="sx-retry-caps">${t('skillsStudio.shell.retry')}</button>
  </div>`);
  main.querySelector('#sx-retry-caps')?.addEventListener('click', async () => {
    try { await capabilities(); await loadData(); deriveRows(); } catch { /* still older */ }
    render();
  });
}

// ── Changes made elsewhere ──

// An install taken up or let go on any surface (sx-install-flow.js): the surfaces on screen draw it as on its way,
// or not, so no second one starts from a button that still looks free.
onInstallBusy(({ skillId }) => {
  if (!S.panel) return;
  if (S.place === 'review') { render({ keepFocus: true }); return; }
  if (S.place === 'workspace' && S.ws && S.ws.skill?.skillId === skillId) {
    const c = ctx();
    refreshWorkspaceChrome(c, S.ws);
    if (S.ws.tab === 'publish') refreshPublishBusy(c, S.ws);
  }
});

/** A skill changed somewhere (another window, the Assistant, an install, a review): read again, a moment later. */
export function onSkillsChanged(event = {}) {
  if (!S.panel) { _cache = null; return; }
  clearTimeout(S.changeTimer);
  const gen = S.gen;
  S.changeTimer = setTimeout(async () => {
    try {
      await loadData();
      if (gen !== S.gen || !S.panel) return;
      deriveRows();
      // A workspace that shows something being edited is not redrawn under the owner: its rail and its banners are.
      if (S.place === 'workspace' && S.ws) {
        setHTML(S.panel.querySelector('#sx-rail'), railHTML());
        S.ws.onExternalChange?.(event);
      } else render({ keepFocus: true });
    } catch { /* what was read stays */ }
  }, 300);
}

// ── Messages ──

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `ss-toast ss-toast--${kind === 'error' ? 'error' : 'info'}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = String(message ?? '');
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? 6000 : 2800);
}

export function announce(message) {
  const live = S.panel?.querySelector('#sx-live');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = String(message ?? ''); });
}

const ask = (o) => askInPanel({ host: S.panel, ...o });

/** What the views are given: the state they read, and what they may do. */
function ctx() {
  return {
    t, tp, locale: getLocale(), mac: MAC, api, storage, emit,
    guest: guest(),
    caps: S.caps || new Set(),
    // Whether the server has said what it can do: until then nothing is said to be missing from it.
    capsKnown: !!S.caps,
    panel: S.panel,
    get data() { return S.data; },
    get rows() { return S.rows; },
    get counts() { return S.counts; },
    get projects() { return S.projects; },
    get updates() { return S.updates; },
    get loading() { return !!S.loading && !_cache; },
    get loadError() { return S.loadError; },
    get reviewFocus() { return S.reviewFocus || null; },
    clearReviewFocus() { S.reviewFocus = null; },
    lib: S.lib,
    gen: () => S.gen,
    alive: (gen) => gen === S.gen && !!S.panel,
    render, goPlace, openRow, toast, announce, ask,
    // Review, with one submission brought forward (a finished AI draft's "Open in Review").
    openReview: (reviewId) => { S.reviewFocus = reviewId || null; goPlace('review'); },
    reload: async () => { const gen = S.gen; try { await loadData(); } catch (err) { if (gen === S.gen) toast(t('skillsStudio.toast.loadFailed', { error: studioErrorText(t, err) }), 'error'); } if (gen !== S.gen || !S.panel) return; deriveRows(); render({ keepFocus: true }); },
    keepUpdate: (name, revisionId) => { const kept = readJson(KEPT_UPDATES_KEY, {}); kept[name] = revisionId; storage.setItem(KEPT_UPDATES_KEY, JSON.stringify(kept)); deriveRows(); },
    saveLibraryView: () => storage.setItem(LIB_KEY, JSON.stringify({ view: S.lib.view, kind: S.lib.kind, source: S.lib.source, runtime: S.lib.runtime, health: S.lib.health, sort: S.lib.sort })),
    keptDrafts: () => keptDrafts(),
    workspaces: S.workspaces,
    closeWorkspace: (ws) => { disposeWorkspace(ws); S.workspaces.delete(ws.key); if (S.ws === ws) { S.ws = null; S.place = 'library'; render(); } },
    key: idempotencyKey,
    capabilities,
  };
}
