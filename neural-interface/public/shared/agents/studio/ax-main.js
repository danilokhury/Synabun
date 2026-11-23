// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the window and its places
// ═══════════════════════════════════════════
//
// Where the owner keeps its agents: named, reviewed ways to launch a worker (docs/agents.md). The window is Skills
// Studio's sibling and behaves as it does (it carries that window's classes, so its chrome, its docking, its
// resizing and its narrow layouts are the same rules of styles.css): non-modal unless the owner dims the
// background, dockable beside the side panels, opened where it was left at the size it had, with a rail of places
// (Library · Create · Review · Teams) and, from a place, one agent with its tabs (Edit · Revisions · Runs · Test
// run). One view machine (ax-views.js) and one render switch; every place listens on the one main area and ends
// its listeners when another is drawn.
//
// It is built on /api/agents-studio/v1 (ax-api.js). The server says what it can do (GET /capabilities) and a place
// or an action is shown only while its capability is listed: `public/` reloads at any time, `lib/` only on a
// restart. Changes made anywhere (the Assistant drafting an agent, another window, an approval) arrive as
// `assistant:agents-changed`, a team's as `assistant:team-changed`; both read the library again a moment later
// without taking the keyboard or what is being typed. Keys reach the window only while the focus is in it: Escape
// closes the topmost thing that is open (a question, a menu), leaves a text field, and only then closes the window,
// which asks first when the editor has unsaved changes. Every answer that arrives after the window closed is
// dropped. Strings are `agentsStudio.*` (i18n/en.json, pt-BR.json).

import { t, tp, getLocale } from '../../i18n.js';
import { storage } from '../../storage.js';
import { emit } from '../../state.js';
import { isGuest, showGuestToast } from '../../ui-sync.js';
import { KEYS } from '../../constants.js';
import { createUnloadGuard } from '../../editor/editor-safety.js';
import { askInPanel, dialogOpen, closeDialog } from '../../skills/ss-dialog.js';
import { closeDropdowns } from '../../cc-dropdown.js';
import { frameRect } from '../../app-frame.js';
import { initialRect, openRect } from '../../skills/studio/sx-geometry.js';
import { html, setHTML, ICONS, inTextField, focusableIn, trapIndex } from '../../skills/studio/sx-dom.js';
import { createAgentsApi } from './ax-api.js';
import { parseOpen, initialView, viewToSave, navigate, railModel, agentKeyText, capsFailure, PLACES } from './ax-views.js';
import { cleanFilters, countAgents, STATUSES } from './ax-library.js';
import { activeTeams } from './ax-teams.js';
import { AX_ICONS } from './ax-icons.js';
import { errorText, emptyHTML } from './ax-ui.js';
import { renderLibrary, leaveLibrary } from './ax-library-view.js';
import { renderReview, leaveReview, forgetReview } from './ax-review-view.js';
import { renderCreate, leaveCreate, newCreateState } from './ax-create-view.js';
import { renderTeams, leaveTeams, stopTeams, onTeamChanged as teamChanged, newTeamsState } from './ax-teams-view.js';
import { renderAgent, leaveAgent, closeAgentMenu, newEditor, agentEditor, loadAgent, saveEditor, agentShortcut, editorDirty } from './ax-agent-view.js';

export const PANEL_ID = 'agents-studio-panel';
const DOCK_KEY = 'agents-studio-docked';
const DIM_KEY = 'agents-studio-dim';
const RAIL_KEY = 'agents-studio-rail-collapsed';
const VIEW_KEY = 'agents-studio-view';
const FILTERS_KEY = 'agents-studio-filters';
const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
const RAIL_ICONS = { library: ICONS.library, create: ICONS.create, review: ICONS.review, teams: AX_ICONS.teams };

// ── State ──

const S = {
  panel: null, backdrop: null, gen: 0, life: null, unload: null, opener: null,
  caps: null, info: null, capsFailed: false,
  agents: [], counts: countAgents([]), loading: null, loadError: null, loaded: false,
  view: initialView(null), filters: cleanFilters(null),
  ed: null, create: newCreateState(), teams: newTeamsState(),
  sources: newSources(),
  docked: false, dim: false, changeTimer: 0, awaitingDraft: false, reading: null, readWanted: false,
};
let _capsPromise = null;
const api = createAgentsApi();

function newSources() {
  return { models: null, modelsState: 'idle', accounts: {}, toolCatalog: null, toolsState: 'idle', profiles: [], profilesState: 'idle', skills: [], skillsState: 'idle', categories: [], categoriesState: 'idle', efforts: null };
}

function readJson(key, fallback) {
  try { const v = JSON.parse(storage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
}

// ── Capabilities and data ──

/** What the server can do (GET /capabilities), once per page; the answer also names the choices of the editor. */
export function capabilities() {
  if (S.caps) return Promise.resolve(S.caps);
  if (!_capsPromise) {
    _capsPromise = api.capabilities()
      .then((res) => { S.info = res; S.caps = new Set(Array.isArray(res?.capabilities) ? res.capabilities.filter((c) => typeof c === 'string') : []); S.capsFailed = false; return S.caps; })
      .catch((error) => { S.capsFailed = true; S.capsError = error; _capsPromise = null; throw error; });
  }
  return _capsPromise;
}

/** Read the library (every agent of every scope). */
export function loadData() {
  if (S.loading) return S.loading;
  const run = (async () => {
    await capabilities();
    const res = await api.list({});
    S.agents = Array.isArray(res.agents) ? res.agents : [];
    S.counts = countAgents(S.agents);
    S.loaded = true;
    return S.agents;
  })();
  S.loading = run;
  run.then(() => { S.loadError = null; if (S.loading === run) S.loading = null; }, (error) => { S.loadError = error; if (S.loading === run) S.loading = null; });
  return run;
}

/**
 * What the editor's dropdowns offer, each read from where the app keeps it: the model catalog, the accounts, the
 * tool catalog, the MoreLogin profiles agents may be given, the skills, the memory categories. Each arrives by
 * itself; one that fails says so in its field and leaves the others alone.
 */
function loadSources() {
  const src = S.sources;
  const gen = S.gen;
  const arrived = () => { if (gen === S.gen && S.panel && S.ed && isEditorOnScreen()) S.ed.refresh?.(); };
  const settle = (name, work) => {
    if (src[`${name}State`] === 'loading' || src[`${name}State`] === 'ready') return;
    src[`${name}State`] = 'loading';
    Promise.resolve().then(work).then(() => { src[`${name}State`] = 'ready'; }, () => { src[`${name}State`] = 'failed'; }).then(arrived);
  };
  settle('models', async () => {
    const [picker, options] = await Promise.all([import('../../assistant/asst-brain-picker.js'), import('../../agent-runtime-options.js')]);
    src.efforts = (provider, row) => (row ? options.getEffortLevelsForModel(provider, row) : options.getEffortLevelsForProfile(provider));
    src.models = await picker.loadModelCatalog();
    const [claude, codex] = await Promise.allSettled([options.fetchClaudeAccounts(), options.fetchCodexAccounts()]);
    src.accounts = { ...(claude.status === 'fulfilled' ? { 'claude-code': claude.value } : {}), ...(codex.status === 'fulfilled' ? { codex: codex.value } : {}) };
  });
  settle('tools', async () => {
    const options = await import('../../agent-runtime-options.js');
    src.toolCatalog = await options.fetchToolCatalog();
    if (!src.toolCatalog) throw new Error('no tool catalog');
  });
  settle('profiles', async () => {
    const res = await fetch('/api/morelogin/agent-profiles', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data?.profiles)) throw new Error('no profile list');
    src.profiles = data.profiles;
  });
  settle('skills', async () => {
    const appApi = await import('../../api.js');
    const [library, catalog] = await Promise.allSettled([appApi.fetchSkillsList(), appApi.fetchSkillsCatalog({ kind: 'skill', limit: 500 })]);
    const rows = [...(library.status === 'fulfilled' && Array.isArray(library.value?.skills) ? library.value.skills : []), ...(catalog.status === 'fulfilled' && Array.isArray(catalog.value?.items) ? catalog.value.items : [])];
    if (library.status !== 'fulfilled' && catalog.status !== 'fulfilled') throw new Error('no skill list');
    src.skills = rows.filter((row) => row && typeof row.name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}(?::[a-z0-9][a-z0-9-]{0,63})?$/.test(row.name.toLowerCase())).map((row) => ({ name: row.name, description: row.description || '' }));
  });
  settle('categories', async () => {
    const appApi = await import('../../api.js');
    const data = await appApi.fetchCategories();
    const list = Array.isArray(data) ? data : Array.isArray(data?.categories) ? data.categories : null;
    if (!list) throw new Error('no category list');
    src.categories = list;
  });
}

const isEditorOnScreen = () => (S.view.place === 'agent' && S.view.tab === 'edit') || (S.view.place === 'create' && S.ed?.mode === 'new');

/** Launch prefetch: nothing is drawn; the first opening paints from what was read. */
export function prefetchStudio() {
  if (S.loaded || isGuest()) return Promise.resolve();
  return loadData().catch(() => {});
}

// ── Opening and closing ──

export const isStudioOpen = () => !!S.panel;

/**
 * Open the Studio (or bring it forward), going where `detail` says (ax-views.js parseOpen); with nothing said, it
 * opens where it was the last time.
 */
export async function openStudio(detail = {}) {
  if (isGuest()) { showGuestToast(t('agentsStudio.guestDisabled')); return; }
  const want = parseOpen(detail);
  if (S.panel) {
    S.panel.focus({ preventScroll: true });
    if (want.explicit) await go({ type: 'open', want });
    return;
  }
  S.gen++;
  S.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  S.docked = storage.getItem(DOCK_KEY) === 'true';
  S.floating = null;
  S.dim = storage.getItem(DIM_KEY) === 'true' && !S.docked;
  S.filters = cleanFilters(readJson(FILTERS_KEY, null));
  S.view = initialView(readJson(VIEW_KEY, null));
  S.create = newCreateState();
  S.teams = newTeamsState();
  S.sources = newSources();
  S.ed = null;
  if (want.explicit) S.view = navigate(S.view, { type: 'open', want });
  S.backdrop = document.createElement('div');
  S.backdrop.className = `studio-backdrop sx-backdrop ax-backdrop${S.dim ? '' : ' backdrop-hidden'}`;
  document.body.appendChild(S.backdrop);
  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  // Skills Studio's window classes carry the chrome, the docking and the narrow layouts; `agents-studio-panel ax`
  // is what this window adds (the Agents Studio section of styles.css).
  panel.className = `skills-studio-panel sx agents-studio-panel ax glass resizable${S.docked ? ' sx-docked' : ''}`;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'ax-title');
  panel.setAttribute('aria-modal', S.dim ? 'true' : 'false');
  if (storage.getItem(RAIL_KEY) === 'true') panel.classList.add('sx-rail-collapsed');
  setHTML(panel, shellHTML());
  document.body.appendChild(panel);
  S.panel = panel;
  document.body.classList.toggle('ax-studio-docked', S.docked);
  placeWindow();
  wireShell();
  S.unload = createUnloadGuard({ target: window, isDirty: () => editorDirty(S.ed) });
  S.unload.install();
  const gen = S.gen;
  enterView();
  render();
  requestAnimationFrame(() => { S.backdrop?.classList.add('open'); S.panel?.classList.add('open'); });
  panel.focus({ preventScroll: true });
  emit('agents:window', { open: true });
  try {
    await loadData();
  } catch { /* the place says what failed */ }
  if (gen !== S.gen || !S.panel) return;
  // The editor's lists are asked for only from a server that answered: one that refused this caller, or has no
  // Agents routes, is asked for nothing more.
  if (S.caps) loadSources();
  // The agent the window was left on may be gone: the Library then.
  if (S.view.place === 'agent' && S.loaded && !S.agents.some((a) => agentKeyText(a) === agentKeyText(S.view.agent))) { dropEditor(); S.view = navigate(S.view, { type: 'place', place: 'library' }); }
  enterView();
  render({ keepFocus: true });
  focusPlace();
}

function placeWindow(floating = null) {
  const panel = S.panel;
  if (S.docked) { panel.style.left = ''; panel.style.top = ''; panel.style.width = ''; panel.style.height = ''; return; }
  const view = { vw: window.innerWidth, vh: window.innerHeight, frame: frameRect() };
  let rect;
  if (floating) rect = initialRect({ ...view, saved: floating }); // Undocked: the size it had before docking.
  else {
    // Opening: the shared size, at the position the panel system saved (ui-panels.js savePanelLayout).
    let saved = null;
    try { saved = JSON.parse(storage.getItem(`${KEYS.PANEL_PREFIX}${PANEL_ID}`) || 'null'); } catch { saved = null; }
    rect = openRect({ ...view, saved });
  }
  Object.assign(panel.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

/** Leaving the editor with unsaved changes: save, discard or stay. True when it may be left. */
async function mayLeaveEditor() {
  if (!editorDirty(S.ed)) return true;
  const ed = S.ed;
  const answer = await ask({
    title: t('agentsStudio.dialog.unsavedTitle'),
    lines: [t('agentsStudio.dialog.unsavedHelp', { name: ed.form.name || ed.key?.id || t('agentsStudio.editor.newTitle') })],
    className: 'ax-dlg',
    buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'discard', label: t('agentsStudio.dialog.discard'), kind: 'danger' }, { id: 'save', label: t(ed.mode === 'new' ? 'agentsStudio.action.createDraft' : 'agentsStudio.action.saveDraft'), kind: 'primary' }],
  });
  if (answer === 'discard') { ed.dirty = false; return true; }
  if (answer !== 'save') return false;
  // A new agent's save opens it (the navigation that was asked for is given up: the draft is what is shown).
  if (ed.mode === 'new') { await saveEditor(ctx(), ed); return false; }
  return saveEditor(ctx(), ed);
}

/** Close the window. Unsaved changes are saved or discarded first: the owner says. */
export async function requestCloseStudio() {
  if (!S.panel || dialogOpen()) return;
  if (!(await mayLeaveEditor())) return;
  closeStudio();
}

/** Close now. */
export function closeStudio() {
  if (!S.panel) return;
  storage.setItem(VIEW_KEY, JSON.stringify(viewToSave(S.view)));
  saveFilters();
  S.gen++;   // every answer still on its way belongs to this opening: dropped
  clearTimeout(S.changeTimer);
  closeDialog();
  leavePlaces();
  stopTeams();
  dropEditor();
  forgetReview();
  S.life?.abort();
  S.life = null;
  S.unload?.remove();
  S.unload = null;
  S.backdrop?.remove();
  S.backdrop = null;
  S.panel.remove();
  S.panel = null;
  document.body.classList.remove('ax-studio-docked');
  emit('agents:window', { open: false });
  const back = S.opener;
  S.opener = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
}

function saveFilters() {
  const { q: _q, ...kept } = S.filters;
  storage.setItem(FILTERS_KEY, JSON.stringify(kept));
}

function dropEditor() {
  if (S.ed) { S.ed.closed = true; clearTimeout(S.ed.checkTimer); }
  S.ed = null;
}

function leavePlaces() {
  leaveLibrary(); leaveReview(); leaveCreate(); leaveTeams(); leaveAgent();
}

// ── The shell ──

function shellHTML() {
  const handles = ['t', 'r', 'b', 'l', 'tl', 'tr', 'bl', 'br'].map((d) => html`<div class="resize-handle resize-handle-${d}" data-resize="${d}"></div>`);
  return html`${handles}
    <header class="sx-head${S.docked ? '' : ' drag-handle'}" data-drag="${PANEL_ID}">
      <span class="sx-head-mark" aria-hidden="true">${AX_ICONS.mark}</span>
      <h2 class="sx-title" id="ax-title">${t('agentsStudio.title')}</h2>
      <span class="sx-head-note" id="ax-head-note" role="status"></span>
      <span class="sx-spacer"></span>
      <button type="button" class="sx-icon-btn" data-act="toggle-rail" aria-pressed="false" aria-label="${t('agentsStudio.shell.collapseRail')}" title="${t('agentsStudio.shell.collapseRail')}">${ICONS.library}</button>
      <button type="button" class="sx-icon-btn" data-act="dock" aria-pressed="${S.docked ? 'true' : 'false'}" aria-label="${t('agentsStudio.shell.dock')}" title="${t('agentsStudio.shell.dockHelp')}">${S.docked ? ICONS.undock : ICONS.dock}</button>
      <button type="button" class="sx-icon-btn" data-act="dim" aria-pressed="${S.dim ? 'true' : 'false'}" aria-label="${t('agentsStudio.shell.dim')}" title="${t('agentsStudio.shell.dimHelp')}"${S.docked ? html` disabled` : ''}>${ICONS.dim}</button>
      <button type="button" class="sx-icon-btn sx-close" data-act="close" aria-label="${t('agentsStudio.shell.close')}" title="${t('agentsStudio.shell.close')}">${ICONS.close}</button>
    </header>
    <div class="sx-body">
      <nav class="sx-rail" id="ax-rail" aria-label="${t('agentsStudio.title')}"></nav>
      <main class="sx-main" id="ax-main" aria-labelledby="ax-title"></main>
    </div>
    <p class="sx-sr" id="ax-live" role="status" aria-live="polite"></p>`;
}

function wireShell() {
  S.life?.abort();
  S.life = new AbortController();
  const signal = S.life.signal;
  // The header and the rail (the places listen on the main area themselves).
  S.panel.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !S.panel.contains(el) || el.disabled || el.closest('#ax-main')) return;
    const act = el.dataset.act;
    if (act === 'close') requestCloseStudio();
    else if (act === 'dock') toggleDock();
    else if (act === 'dim') toggleDim();
    else if (act === 'toggle-rail') toggleRail();
    else if (act === 'place') go({ type: 'place', place: el.dataset.place }).then((moved) => { if (moved) focusPlace(); });
    else if (act === 'status-view') { S.filters = { ...S.filters, status: el.dataset.status, scope: 'all', provider: 'all', q: '' }; saveFilters(); go({ type: 'place', place: 'library' }); }
  }, { signal });
  // Keys only while the focus is in the Studio: the window is not modal, and the page beside it keeps its own.
  document.addEventListener('keydown', onKeydown, { signal });
  window.addEventListener('resize', () => { if (!S.docked) placeWithinViewport(); }, { signal });
}

function placeWithinViewport() {
  if (!S.panel) return;
  const r = initialRect({ vw: window.innerWidth, vh: window.innerHeight, frame: frameRect(), saved: { left: S.panel.style.left, top: S.panel.style.top, width: S.panel.style.width, height: S.panel.style.height } });
  Object.assign(S.panel.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}

/** Dimmed, the window is modal: Tab goes round inside it and comes back in from the page under it. */
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
  if (e.key === 'Escape') {
    // The topmost thing that is open, and nothing under it.
    if (closeDropdowns(S.panel, { focus: true })) { e.preventDefault(); return; }
    if (closeAgentMenu()) { e.preventDefault(); return; }
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
  if (S.ed && agentShortcut(e, ctx(), S.ed, MAC)) { e.preventDefault(); return; }
  const mod = MAC ? e.metaKey : e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); go({ type: 'place', place: 'library' }).then(() => S.panel?.querySelector('#ax-lib-search')?.focus()); }
}

function toggleDock() {
  if (!S.docked) { const { left, top, width, height } = S.panel.style; S.floating = { left, top, width, height }; }
  S.docked = !S.docked;
  storage.setItem(DOCK_KEY, S.docked ? 'true' : 'false');
  if (S.docked && S.dim) toggleDim(false);
  S.panel.classList.toggle('sx-docked', S.docked);
  document.body.classList.toggle('ax-studio-docked', S.docked);
  S.panel.querySelector('.sx-head')?.classList.toggle('drag-handle', !S.docked);
  const btn = S.panel.querySelector('[data-act="dock"]');
  if (btn) { btn.setAttribute('aria-pressed', S.docked ? 'true' : 'false'); setHTML(btn, S.docked ? ICONS.undock : ICONS.dock); }
  const dim = S.panel.querySelector('[data-act="dim"]');
  if (dim) dim.disabled = S.docked;
  placeWindow(S.docked ? null : S.floating);
  announce(t(S.docked ? 'agentsStudio.shell.docked' : 'agentsStudio.shell.undocked'));
}

function toggleDim(force) {
  S.dim = typeof force === 'boolean' ? force : !S.dim;
  storage.setItem(DIM_KEY, S.dim ? 'true' : 'false');
  S.backdrop?.classList.toggle('backdrop-hidden', !S.dim);
  S.panel.setAttribute('aria-modal', S.dim ? 'true' : 'false');
  S.panel.querySelector('[data-act="dim"]')?.setAttribute('aria-pressed', S.dim ? 'true' : 'false');
  announce(t(S.dim ? 'agentsStudio.shell.dimmed' : 'agentsStudio.shell.notDimmed'));
}

function toggleRail() {
  const on = !S.panel.classList.contains('sx-rail-collapsed');
  S.panel.classList.toggle('sx-rail-collapsed', on);
  storage.setItem(RAIL_KEY, on ? 'true' : 'false');
  S.panel.querySelector('[data-act="toggle-rail"]')?.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// ── Navigation ──

/** What the view needs before it is drawn (the editor's state of the agent it names). */
function enterView() {
  const v = S.view;
  if (v.place === 'agent' && v.agent) {
    if (!S.ed || S.ed.mode !== 'agent' || agentKeyText(S.ed.key) !== agentKeyText(v.agent)) {
      dropEditor();
      S.ed = agentEditor(v.agent);
    }
    // Read once the server has said what it can do (an opening reads its capabilities first).
    const ed = S.ed;
    if (ed.loading && S.caps && !ed.reading) {
      ed.reading = true;
      loadAgent(ctx(), ed).then(() => { ed.reading = false; if (S.ed === ed && S.panel) render({ keepFocus: true }); });
    }
  } else if (!(v.place === 'create' && S.ed?.mode === 'new')) dropEditor();
}

/**
 * Move the view and draw it. Leaving the editor with unsaved changes asks first (`force` skips the question: the
 * caller already dealt with them). True when the view moved.
 */
async function go(action, { force = false } = {}) {
  if (!S.panel) return false;
  const next = navigate(S.view, action);
  if (next === S.view) return false;
  const leavesEditor = S.ed && !(next.place === 'agent' && S.ed.mode === 'agent' && agentKeyText(next.agent) === agentKeyText(S.ed.key));
  if (leavesEditor && !force && !(await mayLeaveEditor())) return false;
  if (!S.panel) return false;
  if (leavesEditor) dropEditor();
  S.view = next;
  storage.setItem(VIEW_KEY, JSON.stringify(viewToSave(S.view)));
  enterView();
  render();
  focusPlace();
  return true;
}

function focusPlace() {
  requestAnimationFrame(() => {
    const target = S.panel?.querySelector('#ax-main [data-autofocus]') || S.panel?.querySelector('#ax-main h3, #ax-main h2');
    if (!target) return;
    if (!target.hasAttribute('tabindex') && !/^(INPUT|TEXTAREA|BUTTON)$/.test(target.tagName)) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  });
}

// ── Rendering ──

function railHTML() {
  const items = railModel(S.view, { total: S.loaded ? S.counts.total : null, review: S.counts.review, teams: S.teams.rows ? activeTeams(S.teams.rows) : null }, S.caps);
  const status = S.view.place === 'library' ? S.filters.status : null;
  return html`
    <ul class="sx-rail-list">${items.map((item) => html`<li><button type="button" class="sx-rail-item" data-act="place" data-place="${item.place}"${item.current ? html` aria-current="page"` : ''} title="${t(`agentsStudio.rail.${item.place}`)}">
      <span class="sx-rail-icon">${RAIL_ICONS[item.place]}</span><span class="sx-rail-label">${t(`agentsStudio.rail.${item.place}`)}</span>${item.count !== null ? html`<span class="sx-rail-count${item.place === 'review' ? ' ax-rail-count--review' : ''}">${item.count}${item.place === 'review' ? html`<span class="sx-sr"> ${t('agentsStudio.rail.waiting')}</span>` : ''}</span>` : ''}</button></li>`)}</ul>
    <div class="sx-rail-groups">
      <p class="sx-rail-group-label" id="ax-rail-status">${t('agentsStudio.rail.byStatus')}</p>
      <ul class="sx-rail-list" aria-labelledby="ax-rail-status">${STATUSES.map((s) => html`<li><button type="button" class="sx-rail-view" data-act="status-view" data-status="${s}"${status === s ? html` aria-current="true"` : ''}>
        <span class="sx-rail-label">${t(`agentsStudio.status.${s}`)}</span>${S.loaded ? html`<span class="sx-rail-count">${S.counts.byStatus[s] ?? 0}</span>` : ''}</button></li>`)}</ul>
    </div>`;
}

function headNote() {
  const note = S.panel?.querySelector('#ax-head-note');
  if (!note) return;
  if (S.capsFailed) setHTML(note, html`<span class="sx-note-warn">${t(NOTE_OF[capsFailure(S.capsError)])}</span>`);
  else if (S.loading && !S.loaded) setHTML(note, t('agentsStudio.state.loading'));
  else setHTML(note, '');
}

/** Draw the current place (keeping where the keyboard was when asked). */
export function render({ keepFocus = false } = {}) {
  if (!S.panel) return;
  const active = keepFocus ? document.activeElement : null;
  const activeId = active && S.panel.contains(active) ? active.id || null : null;
  // A redraw that keeps the keyboard also keeps where the place was scrolled to and where the caret was.
  const scroller = keepFocus ? S.panel.querySelector('#ax-main .ax-form, #ax-main .sx-place-scroll, #ax-main .sx-versions') : null;
  const scrolled = scroller ? { selector: scroller.classList.contains('ax-form') ? '.ax-form' : scroller.classList.contains('sx-versions') ? '.sx-versions' : '.sx-place-scroll', top: scroller.scrollTop } : null;
  const caret = activeId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  setHTML(S.panel.querySelector('#ax-rail'), railHTML());
  headNote();
  const main = S.panel.querySelector('#ax-main');
  const c = ctx();
  main.dataset.place = S.view.place;
  // Every place listens on the one main area: the one drawn before ends its listeners first.
  leavePlaces();
  if (S.capsFailed && !S.caps) { renderOlderServer(main); return; }
  const v = S.view;
  if (v.place === 'agent' && S.ed) renderAgent(main, c, S.ed);
  else if (v.place === 'create' && S.ed?.mode === 'new') renderAgent(main, c, S.ed);
  else if (v.place === 'create') renderCreate(main, c, S.create);
  else if (v.place === 'review') renderReview(main, c);
  else if (v.place === 'teams') renderTeams(main, c, S.teams);
  else renderLibrary(main, c);
  if (scrolled) { const again = main.querySelector(scrolled.selector); if (again) again.scrollTop = scrolled.top; }
  if (activeId) {
    const again = S.panel.querySelector(`#${CSS.escape(activeId)}`);
    again?.focus({ preventScroll: true });
    if (again && caret) { try { again.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field any more */ } }
  }
}

/** What the header says when the first read failed, by its reason (ax-views.js capsFailure). */
const NOTE_OF = Object.freeze({ refused: 'agentsStudio.shell.noAccess', older: 'agentsStudio.shell.olderServer', unreachable: 'agentsStudio.shell.unreachable' });

/**
 * The first read failed. A refusal is said as a refusal (who may open the Studio, never "restart the server": that
 * would change nothing); only a server that has no Agents routes is told to restart.
 */
function renderOlderServer(main) {
  const why = capsFailure(S.capsError);
  const words = why === 'refused'
    ? { icon: ICONS.lock, title: t('agentsStudio.shell.noAccessTitle'), lines: [errorText(t, S.capsError), t('agentsStudio.shell.noAccessHelp')] }
    : why === 'unreachable'
      ? { icon: ICONS.warn, title: t('agentsStudio.shell.unreachableTitle'), lines: [t('agentsStudio.error.network')] }
      : { icon: ICONS.warn, title: t('agentsStudio.shell.olderServerTitle'), lines: [t('agentsStudio.shell.olderServerHelp')] };
  main.dataset.failure = why;
  setHTML(main, emptyHTML({ ...words, actions: html`<button type="button" class="sx-btn" id="ax-retry-caps">${t('agentsStudio.state.retry')}</button>` }));
  main.querySelector('#ax-retry-caps')?.addEventListener('click', async () => {
    try { await loadData(); loadSources(); } catch { /* still not there */ }
    enterView();
    render();
  });
}

// ── Changes made elsewhere ──

/** An agent changed somewhere (the Assistant, another window, an approval): read again, a moment later. */
export function onAgentsChanged(msg = {}) {
  const event = msg?.event && typeof msg.event === 'object' ? msg.event : msg;
  if (!S.panel) { S.loaded = false; return; }
  clearTimeout(S.changeTimer);
  const gen = S.gen;
  S.changeTimer = setTimeout(async () => {
    const before = S.counts.review;
    try { await loadData(); } catch { return; }
    if (gen !== S.gen || !S.panel) return;
    forgetReview();
    // A draft the Assistant was asked for arrived in Review.
    if (S.awaitingDraft && S.counts.review > before) { S.awaitingDraft = false; toast(t('agentsStudio.toast.draftArrived')); announce(t('agentsStudio.toast.draftArrived')); }
    const ed = S.ed;
    const same = ed?.mode === 'agent' && event?.id === ed.key.id && agentKeyText({ id: event.id, scope: event.scope }) === agentKeyText(ed.key);
    if (ed && S.view.place === 'agent') {
      // The open agent: read again unless something is being typed (a save then says what changed).
      if (same && !editorDirty(ed) && !ed.busy) {
        if (event.action === 'deleted') { toast(t('agentsStudio.toast.goneElsewhere')); go({ type: 'back' }, { force: true }); return; }
        const was = `${ed.etag}|${ed.agent?.status}|${ed.agent?.draft?.status}|${ed.agent?.approvedRevision}`;
        await loadAgent(ctx(), ed);
        if (gen !== S.gen || S.ed !== ed) return;
        // What this window just wrote comes back as an event too: nothing new, nothing drawn again.
        if (was !== `${ed.etag}|${ed.agent?.status}|${ed.agent?.draft?.status}|${ed.agent?.approvedRevision}` || ed.error) render({ keepFocus: true });
        else setHTML(S.panel.querySelector('#ax-rail'), railHTML());
      } else setHTML(S.panel.querySelector('#ax-rail'), railHTML());
      return;
    }
    if (S.view.place === 'create') { setHTML(S.panel.querySelector('#ax-rail'), railHTML()); if (S.create.describe.sent && !S.ed) render({ keepFocus: true }); return; }
    render({ keepFocus: true });
  }, 300);
}

/**
 * This window wrote something: read the library again at once (a reading that was already on its way may be from
 * before the write, so another follows it), then draw the list places again and the rail's counts.
 */
function readAgain() {
  S.readWanted = true;
  if (S.reading) return;
  const gen = S.gen;
  S.reading = (async () => {
    while (S.readWanted && gen === S.gen) {
      S.readWanted = false;
      if (S.loading) await S.loading.catch(() => {});
      try { await loadData(); } catch { /* what was read stays */ }
    }
    S.reading = null;
    if (gen !== S.gen || !S.panel) return;
    if (S.view.place === 'library' || S.view.place === 'review') render({ keepFocus: true });
    else setHTML(S.panel.querySelector('#ax-rail'), railHTML());
  })();
}

/** A team changed (`assistant:team-changed` { teamId }). */
export function onTeamChanged(msg = {}) {
  if (!S.panel) return;
  teamChanged(ctx(), S.teams, typeof msg?.teamId === 'string' ? msg.teamId : (typeof msg?.event?.teamId === 'string' ? msg.event.teamId : null));
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
  const live = S.panel?.querySelector('#ax-live');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = String(message ?? ''); });
}

const ask = (o) => askInPanel({ host: S.panel, ...o });

/** Bring a dispatched run forward in the Assistant (its tab reopens when it was closed). */
async function focusRun(runId) {
  if (!runId) return;
  try {
    const assistant = await import('../../assistant/asst-api.js');
    await assistant.focusAssistantRun(runId);
  } catch (error) { toast(t('agentsStudio.toast.focusFailed', { error: errorText(t, error) }), 'error'); return; }
  try { const router = await import('../../ui-native-loop-router.js'); await router.focusNativeLoopRun(runId, { reopen: true }); } catch { /* the run's own window is not there */ }
}

/** What the views are given: the state they read, and what they may do. */
function ctx() {
  const guest = isGuest();
  return {
    t, tp, locale: getLocale(), mac: MAC, api, storage, emit,
    get caps() { return S.caps || new Set(); },
    // Whether the server has said what it can do: until then nothing is said to be missing from it.
    get capsKnown() { return !!S.caps; },
    get info() { return S.info; },
    owner: !guest,
    get canDraft() { return !guest && (!S.caps || S.caps.has('drafts')); },
    get panel() { return S.panel; },
    get view() { return S.view; },
    get filters() { return S.filters; },
    get sources() { return S.sources; },
    effortLevels: (provider, row) => (S.sources.efforts ? S.sources.efforts(provider, row) : []),
    get agents() { return S.agents; },
    get counts() { return S.counts; },
    get loading() { return !!S.loading && !S.loaded; },
    get loadError() { return S.loadError; },
    get awaitingDraft() { return S.awaitingDraft; },
    gen: () => S.gen,
    alive: (gen) => gen === S.gen && !!S.panel,
    render, go, toast, announce, ask, focusRun,
    saveFilters,
    /** Read the library again; `quiet` leaves the place as it is drawn (the caller draws). */
    reload: async ({ quiet = false } = {}) => {
      const gen = S.gen;
      try { await loadData(); } catch (error) { if (gen === S.gen && !quiet) toast(t('agentsStudio.toast.loadFailed', { error: errorText(t, error) }), 'error'); }
      if (gen !== S.gen || !S.panel) return;
      if (!quiet) render({ keepFocus: true }); else setHTML(S.panel.querySelector('#ax-rail'), railHTML());
    },
    /** Something this window wrote: the list and the rail follow (the server's event arrives too). */
    changed: () => { forgetReview(); readAgain(); },
    /** Read the open agent again and draw it (on `tab` when one is named). */
    reloadAgent: async ({ tab = null } = {}) => {
      const ed = S.ed;
      if (!ed || ed.mode !== 'agent') return;
      await loadAgent(ctx(), ed);
      if (S.ed !== ed || !S.panel) return;
      if (tab && tab !== S.view.tab) { S.view = navigate(S.view, { type: 'tab', tab }); storage.setItem(VIEW_KEY, JSON.stringify(viewToSave(S.view))); }
      render();
    },
    /** A new agent's editor, on an unsaved form. */
    startNew: ({ form = null, provider = '', source = 'blank' } = {}) => {
      dropEditor();
      S.ed = newEditor({ form, provider, source });
      S.view = { ...S.view, place: 'create', agent: null, create: source === 'template' ? 'template' : 'blank', from: 'create' };
      render();
      focusPlace();
    },
    /** A draft this window made exists now: open it. */
    adopted: async (key) => {
      const gen = S.gen;
      try { await loadData(); } catch { /* the agent is opened anyway */ }
      if (gen !== S.gen || !S.panel) return;
      dropEditor();
      S.view = navigate({ ...S.view, place: 'library', create: null }, { type: 'agent', key, tab: 'edit' });
      storage.setItem(VIEW_KEY, JSON.stringify(viewToSave(S.view)));
      enterView();
      render();
      focusPlace();
    },
    /** Hand a request to the SynaBun Assistant (the app's own way in: the Assistant opens with the prompt). */
    askAssistant: (prompt) => { S.awaitingDraft = true; emit('assistant:open', { prompt }); toast(t('agentsStudio.toast.sentToAssistant')); },
  };
}

export { PLACES };
