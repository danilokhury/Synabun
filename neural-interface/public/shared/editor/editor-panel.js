// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the panel
// ═══════════════════════════════════════════
//
// The File Explorer's editor panel (#fe-editor-panel, markup in html-shell.js):
// the documents that are open in it, each in a tab of its own, and what is
// done with them: opening, saving, discarding and closing, the plan and
// changelog tabs other panels drive through the bus, the Markdown preview,
// unsaved work (the question on leaving, the copies, the check against the
// disk), and what the server can do for the editor (asked once per page: an
// older server still opens and saves files, without the newer checks).
//
// One CodeMirror view shows the tab that is selected; every other tab keeps
// its own state (text, history, selection, folds) and scroll position here.
// The decisions that need no page are in editor-tabs-logic.js,
// editor-panel-logic.js, editor-safety.js, editor-doc.js and
// editor-languages.js; the strip, the status bar and the menus are drawn by
// editor-tabs.js, editor-statusbar.js and editor-menu.js. What a document
// shows beyond its text is built by a module each and kept in its state: the
// lines that differ from the last commit (editor-git.js), the problems of a
// JSON file (editor-lint.js), the minimap (editor-minimap.js). The command
// palette and go-to-file are editor-palette.js.

import { emit, on } from '../state.js';
import { t } from '../i18n.js';
import { storage } from '../storage.js';
import { KEYS } from '../constants.js';
import { deleteBlob, fetchBlob, flushBlobs, putBlob } from '../blob-store.js';
import { loadCodeMirror } from './editor-loader.js';
import { createEditorView } from './editor-view.js';
import { editorSearch } from './editor-search.js';
import { editorAi } from './editor-ai.js';
import { editorCompare } from './editor-compare.js';
import { GIT_REFRESH_MS, editorGit } from './editor-git.js';
import { gitMarks, readHeadResponse } from './editor-git-logic.js';
import { editorLint, lintKind } from './editor-lint.js';
import { editorMinimap } from './editor-minimap.js';
import { createPalette } from './editor-palette.js';
import { projectFor } from './editor-palette-logic.js';
import { highlightSpecs } from './editor-theme.js';
import { closeEditorMenu, openEditorMenu } from './editor-menu.js';
import { createTabStrip } from './editor-tabs.js';
import { LANGUAGE_AUTO, LANGUAGE_PLAIN, createStatusBar } from './editor-statusbar.js';
import { EDITOR_COMMANDS, formatKey, runCommand, shortcutRows } from './editor-commands.js';
import { createEditorPrefs } from './editor-prefs.js';
import { pickNeighbors } from './editor-ai-logic.js';
import {
  chooseIndentation, detectIndentation, detectLineEnding, isLargeDocument, looksLossyDecoded, minimalChange, saveFixes, serializeDocument, splitBom,
} from './editor-doc.js';
import { baseName, isMarkdownFile, languageLabel } from './editor-languages.js';
import { renderMarkdown } from './editor-markdown.js';
import {
  closeConfirm, controlsState, describeOpenFailure, displayPath, isSamePlan, isSamePlanOwner,
  matchesExpectedMarkdown, minimapShown, nextWhitespace, planEvent, planIdentityKey, planSourceLabel, viewMenuChange, viewMenuItems,
} from './editor-panel-logic.js';
import {
  activateTab, closeTab, closeTargets, createTabs, findTab, getTab, moveTab, neighborTab, normalizePath, openTab, pinTab,
  recallTabs, rememberTabs, repointPath, repointRemembered, restoreTabs, serializeTabs, tabKey, tabLabels, updateTab,
} from './editor-tabs-logic.js';
import {
  BACKUP_MAX_CHARS, blobBackupStore, createBackups, createDiskWatcher, createUnloadGuard, describeBackup,
  layeredBackupStore, localBackupStore, safetyBar, sameVersion, textFingerprint,
} from './editor-safety.js';

const $ = (id) => document.getElementById(id);
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform || '');
/** The open tabs are written to storage this long after they last changed (a tab opened, closed, edited)... */
const PERSIST_DELAY_MS = 400;
/** ...and at most this often while only a caret or a view moves. */
const POSITION_PERSIST_MS = 2000;

// What the File Explorer lends the panel (initEditorPanel).
let _host = { toast: () => {}, projectRoot: () => null, beforeOpen: () => {}, openSettings: () => {}, revealInTree: null, fileIcon: () => null };

let _cm = null;              // the vendored CodeMirror bundle, once loaded
let _editor = null;          // the CodeMirror view (editor-view.js)
let _search = null;
let _ai = null;              // AI autocomplete (editor-ai.js), built with the editor
let _compare = null;         // the comparison with another text (editor-compare.js)
let _git = null;             // the git markers (editor-git.js)
let _lint = null;            // the problem check (editor-lint.js)
let _minimap = null;         // the minimap (editor-minimap.js)
let _palette = null;         // the command palette and go-to-file (editor-palette.js)
let _width = 0;              // the editor's width in pixels: under 760 there is no room for a minimap
let _capabilities = null;    // Set of what the server offers the editor, once asked
const _prefs = createEditorPrefs();

let _open = false;           // the panel is showing
let _model = createTabs();   // which tabs, in which order, which one is selected (editor-tabs-logic.js)
const _docs = new Map();     // tab id → the document of that tab
let _shownId = null;         // the tab whose state is in the view
let _session = false;        // the tabs of this opening of the panel are being kept for a project
let _project = '';           // that project's folder ('' when none is selected)
let _queue = Promise.resolve();   // opens run one after another, in the order they were asked for
let _epoch = 0;              // an open asked for before the panel was closed is given up on
let _pendingPlans = 0;
let _quiet = 0;              // the panel itself is changing a document: not an edit
let _statusFrame = 0;
let _persistTimer = 0;
let _persisted = '';         // what was last written of the tabs, to write nothing when nothing changed
let _strip = null;
let _status = null;
let _backups = null;
// Tabs whose copy of unsaved text is still on its way to the name their file has now (the file was renamed while
// the text was only in the store): { at, now, steps }. `at`: the path the copy is under, which is where the tab
// stays remembered; `now`: where the file is. A tab is remembered at a new path only once its copy is under it,
// so a page that goes at any moment finds the two together (editor-safety.js: move, `commit`).
const _onTheWay = [];
let _watcher = null;

const toast = (message) => _host.toast(message);

// ── The documents ──
//
// One per tab: { id, kind, key, path, name } as the tab has them, and
//   file         { path, name, size, version, eol, mixed, diskEol, diskMixed, bom, detectedIndent, indentChoice, indent, markdown }
//   state        its CodeMirror state while it is not the one in the view (the view holds the shown one's)
//   scroll, top  where it was scrolled to when it left the view
//   savedDoc     the document as it was last saved (a CodeMirror Text); `dirty` is "the text differs from it"
//   loaded       false for a tab that came back from storage and was not read yet (`place`: where it was)
//   plan         { contract, filePath, source, tabId } for a plan tab
//   refused      { key } for a file the editor does not open; failed: the editor itself did not load
//   saving, reloading   a save, or a "Reload", is under way: the text is read-only until it ends
//   bars         id → kind (editor-safety.js: safetyBar)
//   large        over 2 MB: no minimap, no git markers, no problem check
//   head         { text, lines } the file as the last commit has it; null when git does not know it (or was not asked)
//   gitColumn, lintKind, minimap   what its state has of the three; diff: it is shown against the last commit

function createDoc(tab, extra = {}) {
  const doc = {
    id: tab.id, kind: tab.kind, key: tab.key, path: tab.path, name: tab.name,
    file: null, state: null, scroll: null, top: 0, savedDoc: null, loaded: false, loading: false, place: null,
    dirty: false, saving: false, reloading: false, eolChanged: false, preview: false,
    plan: null, banner: null, refused: null, failed: false,
    language: null, languageChoice: null, languageName: '', languageSeq: 0,
    bars: new Map(), comparing: false, pendingVersion: null, deleted: false, base: null, prefs: null,
    large: false, head: null, headSeq: 0, gitTimer: 0, gitColumn: false, diff: false, lintKind: null, lintSeq: 0, minimap: false,
    ...extra,
  };
  _docs.set(doc.id, doc);
  return doc;
}

const active = () => _docs.get(_model.activeId) || null;
const isActive = (doc) => !!doc && doc.id === _model.activeId;
const isShown = (doc) => !!doc && doc.id === _shownId;
const isOpen = (doc) => !!doc && _docs.get(doc.id) === doc;
/** A document's state: the view's when it is the one showing. */
const stateOf = (doc) => (isShown(doc) && _editor ? _editor.view.state : doc.state);
/** Unsaved text: in the buffer, or (a tab that was not read yet) in the copy it came back with. */
const isDirty = (doc) => !!doc && (doc.loaded ? doc.dirty : !!doc.place?.dirty);
const canCompare = () => !!_capabilities?.has('file-stat');
/** The features this server has, as commands name them: a command of another feature is not listed anywhere. */
const features = () => [...(_capabilities?.has('complete') ? ['ai'] : []), ...(_capabilities?.has('git-head') ? ['git'] : [])];

/** Change a document, wherever its state is. */
function applyTo(doc, spec) {
  const next = _editor.apply(isShown(doc) ? null : doc.state, spec);
  if (!isShown(doc)) doc.state = next;
  return next;
}

/** A change the panel makes itself (a reload, a restored copy): the view's listener does not take it for an edit. */
function quietly(work) {
  _quiet++;
  try { return work(); } finally { _quiet--; }
}

// ── Plan tabs ──

const planIdentity = (doc) => ({ ...doc.plan.contract, source: doc.plan.source, tabId: doc.plan.tabId });
const planRequest = (doc) => ({ ...doc.plan.contract, filePath: doc.plan.filePath, source: doc.plan.source, tabId: doc.plan.tabId });
const planDocs = () => [..._docs.values()].filter((doc) => doc.plan);

function emitPlanState(doc) {
  if (doc?.plan) emit('plan-editor-state', planEvent(planIdentity(doc), { dirty: doc.dirty, saving: doc.saving, open: _open }));
}

// ── What the server offers ──

let _capabilitiesAsked = null;

/** Ask the server once per page what it offers the editor. A server without the route offers nothing new. */
function askCapabilities() {
  if (_capabilities) return Promise.resolve(_capabilities);
  if (!_capabilitiesAsked) {
    _capabilitiesAsked = (async () => {
      let known = false;
      let list = [];
      try {
        const res = await fetch('/api/editor/capabilities');
        if (res.ok) {
          const body = await res.json().catch(() => null);
          if (Array.isArray(body?.capabilities)) list = body.capabilities.filter((c) => typeof c === 'string');
          known = true;
        } else if (res.status !== 0 && res.status < 500) {
          known = true;   // no such route (or not for this user): an answer, and it will not change
        }
      } catch { /* the server did not answer: ask again with the next file */ }
      const found = new Set(list);
      if (known) _capabilities = found;
      else _capabilitiesAsked = null;
      if (found.has('config')) await _prefs.load();
      return found;
    })();
  }
  return _capabilitiesAsked;
}

// ── Unsaved work ──

/**
 * The copies of unsaved buffers. On a server whose blob store has a place only the owner reaches, they are
 * kept there (and looked for in this browser too, where they were kept before that server was restarted);
 * until then, in this browser.
 */
function backups() {
  if (!_backups) {
    const local = localBackupStore();
    const store = _capabilities?.has('backups') ? layeredBackupStore(blobBackupStore({ fetchBlob, putBlob, deleteBlob, flushBlobs }), local) : local;
    _backups = createBackups({ store });
  }
  return _backups;
}

/** What a copy of a document holds, read when the copy is made. */
function backupReader(doc) {
  return () => {
    if (!isOpen(doc) || !doc.loaded || !doc.dirty || !doc.file) return null;
    const state = stateOf(doc);
    if (state.doc.length > BACKUP_MAX_CHARS) return null;
    // What the text was written over: marked once per saved version.
    if (doc.base?.of !== doc.savedDoc) doc.base = { of: doc.savedDoc, mark: textFingerprint(doc.savedDoc.toString()) };
    return { path: doc.file.path, text: state.doc.toString(), base: doc.base.mark, eol: doc.file.eol };
  };
}

function syncBackup(doc) {
  if (!doc.file) return;
  if (doc.dirty) backups().touch(doc.key, backupReader(doc));
  else backups().drop(doc.key);
}

function startWatching() {
  if (!_open || !_capabilities?.has('file-stat')) return;
  if (!_watcher) {
    _watcher = createDiskWatcher({
      stat: async (paths) => {
        const res = await fetch('/api/file-stat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
        if (!res.ok) return null;
        const body = await res.json().catch(() => null);
        return body?.ok ? body.files : null;
      },
      // Files only: a plan is one revision of a document its own panel keeps, and a changelog draft is that panel's too.
      files: () => [..._docs.values()]
        .filter((doc) => doc.kind === 'file' && doc.loaded && doc.file && !doc.saving)
        .map((doc) => ({ id: doc.id, path: doc.file.path, version: doc.deleted ? null : doc.file.version })),
      onChange: onDiskChange,
      isActive: () => _open && document.visibilityState === 'visible',
    });
  }
  _watcher.start();
}

function onDiskChange(id, { exists, version, asked, path }) {
  const doc = _docs.get(id);
  if (!doc || !doc.loaded || !doc.file || doc.saving) return;
  // Renamed or moved while the answer was on its way: it is about a path this tab no longer has.
  if (path && path !== doc.file.path) return;
  // Saved or reloaded while the answer was on its way: it is about a version this tab no longer has.
  const known = doc.deleted ? null : doc.file.version;
  if (known !== asked && !sameVersion(known, asked)) return;
  if (!exists) {
    doc.deleted = true;
    setBar(doc, 'deleted');
    return;
  }
  if (!doc.dirty) { reloadClean(doc); return; }
  // The check runs every two seconds for as long as the tab and the disk differ. What it found the time before
  // is already on screen: drawing the bar and the comparison again would take the keyboard from their buttons.
  const told = !doc.deleted && doc.bars.has('disk') && sameVersion(doc.pendingVersion, version);
  doc.pendingVersion = version;
  doc.deleted = false;
  if (told) return;
  if (doc.bars.get('disk') !== 'conflict') setBar(doc, 'changed');
  if (doc.comparing) showCompare(doc);
}

// ── The CodeMirror view ──

let _editorLoading = null;

function ensureEditor() {
  if (_editor) return Promise.resolve(_editor);
  if (!_editorLoading) {
    _editorLoading = loadCodeMirror().then(({ cm }) => {
      _cm = cm;
      _search = editorSearch(cm, { t });
      _compare = editorCompare(cm, { t });
      _git = editorGit(cm);
      _lint = editorLint(cm);
      _minimap = editorMinimap(cm, { highlight: highlightSpecs(cm.tags), git: _git, problems: _lint });
      _ai = editorAi(cm, {
        t,
        prefs: _prefs,
        getDocument: () => {
          const doc = active();
          return doc?.loaded && doc.file ? { path: doc.file.path, language: doc.languageName, indentUnit: doc.file.indent?.unit || '  ' } : null;
        },
        getNeighbors: neighborSnippets,
        openSettings: () => _host.openSettings({ tab: 'code-editor', scrollTo: 'stg-sec-editor-ai' }),
      });
      _editor = createEditorView(cm, {
        parent: $('fe-editor-host'),
        search: _search,
        ai: _ai,
        actions: {
          save: () => saveEditorPanel(), toggleWordWrap, nextTab: () => cycleTab(1), previousTab: () => cycleTab(-1), closeTab: closeActiveTab,
          toggleMinimap: () => changeEditing({ minimap: !_prefs.get().editing.minimap }),
          toggleIndentGuides: () => changeEditing({ indentGuides: !_prefs.get().editing.indentGuides }),
          cycleWhitespace: () => changeEditing({ renderWhitespace: nextWhitespace(_prefs.get().editing.renderWhitespace) }),
          fontLarger: () => changeEditing(viewMenuChange('font:larger', _prefs.get().editing)),
          fontSmaller: () => changeEditing(viewMenuChange('font:smaller', _prefs.get().editing)),
          fontReset: () => changeEditing(viewMenuChange('font:reset', _prefs.get().editing)),
          openPalette: () => _palette?.openCommands(),
          openGoToFile: () => _palette?.openFiles(),
          nextProblem: (view) => _lint.next(view) === true,
          previousProblem: (view) => _lint.previous(view) === true,
          toggleDiff,
        },
        t,
        onUpdate: onEditorUpdate,
      });
      _editor.view.scrollDOM.addEventListener('scroll', () => schedulePersist({ soon: false }), { passive: true });
      watchWidth();
      return _editor;
    }).finally(() => { _editorLoading = null; });
  }
  return _editorLoading;
}

function onEditorUpdate(update) {
  const doc = _docs.get(_shownId);
  if (!doc || !doc.loaded) return;
  if (update.docChanged && !_quiet) {
    refreshDoc(doc);
    if (doc.dirty) backups().touch(doc.key, backupReader(doc));
  }
  if (update.docChanged && doc.head) scheduleGit(doc);
  if (update.docChanged || update.selectionSet) {
    scheduleStatus();
    schedulePersist({ soon: false });
  }
}

// AI autocomplete exists on this page only when the server has it: its chip is added to the status bar and its
// keys to the shortcuts list then, and not before.
function syncAi() {
  if (!_ai || !_capabilities) return;
  const capable = _capabilities.has('complete');
  _ai.setCapable(capable);
  if (!capable || $('fe-editor-ai')) return;
  _ai.mountChip($('fe-editor-statusbar'));
  buildShortcuts();
}

/** What the other open tabs of the document's language hold, for a completion request: the tabs used last first. */
function neighborSnippets() {
  const current = active();
  if (!current?.loaded || !current.file) return [];
  const tabs = _model.recent
    .filter((id) => id !== current.id)
    .map((id) => _docs.get(id))
    .filter((doc) => doc?.loaded && doc.file && doc.state)
    .map((doc) => ({
      path: doc.file.path, language: doc.languageName, length: doc.state.doc.length, head: doc.state.selection.main.head,
      slice: (from, to) => doc.state.sliceDoc(from, to),
    }));
  return pickNeighbors({ current: { path: current.file.path, language: current.languageName }, tabs, exclude: _prefs.get().ai.exclude });
}

// ── What the panel shows ──

/** Which of the three bodies is visible: the editor, the Markdown preview, or a message. */
function showBody(which) {
  const hostEl = $('fe-editor-host');
  const previewEl = $('fe-editor-preview');
  const messageEl = $('fe-editor-message');
  if (hostEl) hostEl.hidden = which !== 'editor';
  if (previewEl) previewEl.classList.toggle('visible', which === 'preview');
  if (messageEl) messageEl.hidden = which !== 'message';
}

function showMessage(text, { retry = null } = {}) {
  const textEl = $('fe-editor-message-text');
  const retryBtn = $('fe-editor-message-retry');
  if (textEl) textEl.textContent = text;
  if (retryBtn) {
    retryBtn.hidden = !retry;
    retryBtn.onclick = retry;
  }
  showBody('message');
}

/** The body of the selected tab: a message, its preview, or the editor. */
function renderBody(doc) {
  if (doc?.refused) { showMessage(t(doc.refused.key, { name: doc.name })); return; }
  if (doc?.failed) { showMessage(t('editor.error.bundle'), { retry: () => loadLater(doc) }); return; }
  if (doc?.preview && doc.file) {
    const previewEl = $('fe-editor-preview');
    if (previewEl) previewEl.innerHTML = renderMarkdown(stateOf(doc)?.doc.toString() || '');
    showBody('preview');
    return;
  }
  showBody('editor');
  _editor?.remeasure();
}

function renderHeader(doc) {
  const pathEl = $('fe-editor-filepath');
  if (!pathEl) return;
  const path = doc ? (doc.file?.path || doc.path) : '';
  pathEl.textContent = displayPath(path, _host.projectRoot());
  pathEl.title = String(path || '');
}

/** The header's dot and buttons, for the selected tab. */
function renderControls(doc) {
  const dirty = !!doc?.loaded && doc.dirty;
  $('fe-editor-dot')?.classList.toggle('dirty', dirty);
  const controls = controlsState({ ready: !!doc?.loaded && !!doc.file, dirty, saving: !!doc?.saving, plan: !!doc?.plan, changelog: doc?.kind === 'changelog' });
  const saveBtn = $('fe-editor-save');
  if (saveBtn) {
    saveBtn.disabled = controls.saveDisabled;
    saveBtn.classList.toggle('dirty', dirty);
  }
  const discardBtn = $('fe-editor-discard');
  if (discardBtn) discardBtn.disabled = controls.discardDisabled;
}

function renderBanner(doc) {
  const panel = $('fe-editor-panel');
  panel?.querySelector('.fe-plan-banner')?.remove();
  let text = '';
  if (doc?.banner) text = doc.banner;
  else if (doc?.plan) {
    text = doc.plan.source === 'codex'
      ? t('editor.banner.planReview')
      : t('editor.banner.planSend', { name: planSourceLabel(doc.plan.source) });
  } else if (doc?.kind === 'changelog') {
    text = t('editor.banner.changelog');
  }
  if (!text || !panel) return;
  const banner = document.createElement('div');
  banner.className = 'fe-plan-banner';
  banner.textContent = text;
  panel.prepend(banner);
}

// What each action of a bar does (editor-safety.js names the actions).
const BAR_ACTIONS = {
  compare: (doc) => showCompare(doc),
  closeCompare: (doc) => closeCompare(doc),
  closeDiff: (doc) => closeDiff(doc),
  reload: (doc) => reloadFromDisk(doc),
  overwrite: (doc) => saveDocument(doc, { force: true }),
  keepMine: (doc) => keepMine(doc),
  closeTab: (doc) => closeTabs([doc.id]),
  keep: (doc) => clearBar(doc, 'restored'),
  discard: (doc) => revertToSaved(doc),
};

/** The neutral bars under the header, for the selected tab: a sentence and the actions that answer it. */
function renderBars(doc) {
  const bars = $('fe-editor-bars');
  if (!bars) return;
  bars.textContent = '';
  for (const kind of doc?.bars.values() || []) {
    const described = safetyBar(kind, { canCompare: canCompare() && !doc.comparing });
    const bar = document.createElement('div');
    bar.className = 'fe-editor-bar';
    bar.dataset.bar = described.id;
    bar.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.className = 'fe-editor-bar-text';
    label.textContent = t(described.textKey);
    bar.append(label);
    for (const action of described.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fe-editor-bar-action';
      button.dataset.action = action.id;
      button.textContent = t(action.labelKey);
      // The bar may be gone once its action ran, and the button with it: the keyboard goes back to the text.
      button.addEventListener('click', () => {
        if (isOpen(doc)) Promise.resolve(BAR_ACTIONS[action.id](doc)).catch(() => {}).then(focusEditor);
      });
      bar.append(button);
    }
    bars.append(bar);
  }
}

/** Give the keyboard to the text of the selected tab, when it is showing. */
function focusEditor() {
  const doc = active();
  if (_editor && doc?.loaded && !doc.preview && isShown(doc)) _editor.focus();
}

function setBar(doc, kind) {
  doc.bars.set(safetyBar(kind).id, kind);
  if (isActive(doc)) renderBars(doc);
}

function clearBar(doc, id) {
  if (doc.bars.delete(id) && isActive(doc)) renderBars(doc);
}

function updateViewToggle(doc) {
  const markdown = !!doc?.file?.markdown;
  const toggle = $('fe-editor-view-toggle');
  const sep = $('fe-editor-sep-preview');
  if (toggle) toggle.style.display = markdown ? 'flex' : 'none';
  if (sep) sep.style.display = markdown ? '' : 'none';
  for (const button of document.querySelectorAll('#fe-editor-panel .fe-editor-toggle-btn')) {
    const on = (button.dataset.mode === 'preview') === !!doc?.preview;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  }
}

function setPreview(on) {
  const doc = active();
  if (!doc) return;
  doc.preview = !!on && !!doc.file?.markdown;
  updateViewToggle(doc);
  renderBody(doc);
}

/** The name of the language a document is shown in, as the status bar and a completion request have it. */
function languageNameOf(doc) {
  if (doc.languageChoice === LANGUAGE_PLAIN) return '';
  if (doc.languageChoice) return doc.languageChoice;
  return languageLabel(doc.name, doc.language?.name || null) || '';
}

function renderStatus(doc) {
  if (!_status) return;
  const file = doc?.file || null;
  _status.showFile(file ? {
    indent: file.indent, indentChoice: file.indentChoice, detected: chooseIndentation(file.detectedIndent, _prefs.get().editing, null),
    eol: file.eol, mixed: file.mixed, bom: file.bom, size: file.size,
  } : null);
  if (!file) { _status.showPosition(null); return; }
  const detected = _editor ? languageLabel(doc.name, _editor.describeLanguage(doc.name)?.name || null) : '';
  _status.showLanguage({ label: doc.languageName, choice: doc.languageChoice, detected: detected || t('editor.status.plainText') });
  showPosition();
}

function showPosition() {
  _statusFrame = 0;
  const doc = active();
  if (!_status) return;
  if (!_editor || !doc?.loaded || !isShown(doc)) { _status.showPosition(null); return; }
  const { state } = _editor.view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const selected = state.selection.ranges.reduce((sum, range) => sum + (range.to - range.from), 0);
  _status.showPosition({ line: line.number, column: head - line.from + 1, selected, cursors: state.selection.ranges.length });
}

// The position is written once per frame, however many updates a frame holds.
function scheduleStatus() {
  if (!_statusFrame) _statusFrame = requestAnimationFrame(showPosition);
}

function renderStrip() {
  announceTabs();
  if (!_strip) return;
  _strip.render({
    tabs: _model.tabs,
    activeId: _model.activeId,
    labels: tabLabels(_model.tabs),
    isDirty: (id) => isDirty(_docs.get(id)),
    titleOf: (id) => { const doc = _docs.get(id); return doc ? displayPath(doc.file?.path || doc.path, _host.projectRoot()) : ''; },
  });
}

/** Everything the panel shows of the selected tab. */
function renderActive() {
  const doc = active();
  renderHeader(doc);
  renderBanner(doc);
  renderBars(doc);
  updateViewToggle(doc);
  renderControls(doc);
  renderDiffButton(doc);
  renderStatus(doc);
  renderBody(doc);
  renderStrip();
}

/**
 * A document's dirty state, and what follows from a change of it: the header, the strip, the copy of the buffer,
 * and for a plan the state event its panel follows. A tab that has unsaved text is the user's to keep.
 */
function refreshDoc(doc, { force = false } = {}) {
  const state = stateOf(doc);
  const dirty = !!(doc.loaded && doc.file && state && doc.savedDoc && (!state.doc.eq(doc.savedDoc) || doc.eolChanged));
  const changed = dirty !== doc.dirty;
  doc.dirty = dirty;
  if (changed) {
    if (dirty) _model = pinTab(_model, doc.id);
    syncBackup(doc);
    renderStrip();
    schedulePersist();
  }
  if (!changed && !force) return;
  if (isActive(doc)) renderControls(doc);
  emitPlanState(doc);
}

// ── Preferences ──

/** Bring the shown document's state up to the preferences (a tab that was in the background when they changed). */
function syncPreferences(doc) {
  const { editing } = _prefs.get();
  if (!_editor || !doc?.loaded || !doc.file || !isShown(doc) || doc.prefs === editing) return;
  doc.prefs = editing;
  doc.file.indent = chooseIndentation(doc.file.detectedIndent, editing, doc.file.indentChoice);
  _editor.apply(null, { effects: [_editor.effects.wrap(editing.wordWrap), _editor.effects.editing(editing), _editor.effects.indent(doc.file.indent)] });
}

/** Store a change to the `editing` preferences (a View menu entry, a command). It applies at once, here and in Settings. */
function changeEditing(change) {
  if (change) _prefs.set({ editing: change });
}

// ── The minimap ──

const wantsMinimap = (doc) => minimapShown({ preference: _prefs.get().editing.minimap, width: _width, large: doc.large });

/** Bring a document's minimap up to the preference, the editor's width and its own size. */
function syncMinimap(doc) {
  if (!_editor || !_minimap || !doc?.loaded || !doc.file) return;
  const wanted = wantsMinimap(doc);
  if (wanted === doc.minimap) return;
  doc.minimap = wanted;
  applyTo(doc, { effects: _editor.effects.minimap(wanted ? _minimap.extension : null) });
}

/** The editor's width decides whether there is room for a minimap: follow it. */
function watchWidth() {
  const body = document.querySelector('#fe-editor-panel .fe-editor-body');
  if (!body) return;
  const measure = () => {
    const width = body.clientWidth;
    if (!width || width === _width) return;
    _width = width;
    syncMinimap(_docs.get(_shownId));
  };
  measure();
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(body);
}

// ── Git: the file against the last commit ──

/** Whether a document gets the git column: a file that is not large, on a server that reads the last commit. */
const wantsGit = (doc) => !!_capabilities?.has('git-head') && doc.kind === 'file' && !doc.large;

/** Ask for the file as the last commit has it, then mark the lines that differ. No answer is no markers. */
async function loadHead(doc) {
  if (!doc.loaded || !doc.file) return;
  if (!wantsGit(doc)) {
    // No longer a document git is asked about (it grew past 2 MB): nothing of the last commit is kept for it.
    if (doc.head) { doc.head = null; closeDiff(doc); if (isActive(doc)) renderDiffButton(doc); }
    return;
  }
  const mine = ++doc.headSeq;
  let reading = { tracked: false, text: null };
  try {
    const res = await fetch(`/api/file-head?path=${encodeURIComponent(doc.file.path)}`);
    reading = readHeadResponse({ status: res.status, body: await res.json().catch(() => null) });
  } catch { /* the server did not answer */ }
  if (!isOpen(doc) || !doc.loaded || mine !== doc.headSeq) return;
  const before = doc.head?.text ?? null;
  doc.head = reading.text === null ? null : { text: reading.text, lines: reading.text.split('\n') };
  refreshGit(doc);
  // A comparison that is showing follows the commit it compares with.
  if (doc.diff && (doc.head?.text ?? null) !== before) { if (doc.head) showDiff(doc); else closeDiff(doc); }
  if (isActive(doc)) renderDiffButton(doc);
}

/** Compare the document with the committed lines and show the result in its git column. */
function refreshGit(doc) {
  clearTimeout(doc.gitTimer);
  doc.gitTimer = 0;
  if (!_git || !isOpen(doc) || !doc.loaded || !doc.gitColumn) return;
  const state = stateOf(doc);
  if (!_git.has(state)) return;
  applyTo(doc, { effects: _git.marks(doc.head ? gitMarks(doc.head.lines, state.doc.toJSON()) : []) });
}

/** After an edit: compare again once typing pauses. Until then the marks move with the text. */
function scheduleGit(doc) {
  clearTimeout(doc.gitTimer);
  doc.gitTimer = setTimeout(() => refreshGit(doc), GIT_REFRESH_MS);
}

function renderDiffButton(doc) {
  const button = $('fe-editor-diff-btn');
  if (!button) return;
  const can = !!doc?.loaded && !!doc.head;
  button.hidden = !can;
  button.classList.toggle('active', can && doc.diff);
  button.setAttribute('aria-pressed', String(can && doc.diff));
}

/** Show the document against the last commit, inline; each difference can be put back to what was committed. */
async function showDiff(doc) {
  if (!doc?.loaded || !doc.head || !_compare) return;
  let extension;
  try {
    extension = await _compare.extension({ original: doc.head.text, revertLabel: t('editor.diff.revert'), gutter: false });
  } catch {
    if (isOpen(doc)) toast(t('editor.diff.failed'));
    return;
  }
  if (!isOpen(doc) || !doc.loaded || !doc.head) return;
  applyTo(doc, { effects: _editor.effects.compare(extension) });
  doc.comparing = false;
  doc.diff = true;
  doc.bars.set('compare', 'diffing');
  if (!isActive(doc)) return;
  if (doc.preview) setPreview(false);
  renderBars(doc);
  renderDiffButton(doc);
}

function closeDiff(doc) {
  if (!doc.diff) return;
  doc.diff = false;
  doc.bars.delete('compare');
  if (doc.loaded) applyTo(doc, { effects: _editor.effects.compare(null) });
  if (!isActive(doc)) return;
  renderBars(doc);
  renderDiffButton(doc);
}

function toggleDiff() {
  const doc = active();
  if (!doc?.loaded || !doc.head) return;
  if (doc.diff) closeDiff(doc); else showDiff(doc);
}

// ── Go to file ──

let _registered = null;   // the registered projects, asked for once when go-to-file needs them

/**
 * The folder go-to-file searches: the project selected in the File Explorer; without one (a file opened from a
 * link in a chat), the registered project the open file is in.
 */
async function searchRoot() {
  const selected = _host.projectRoot() || _project;
  if (selected) return selected;
  const doc = active();
  const path = doc?.file?.path || doc?.path;
  if (!path) return null;
  if (!_registered) {
    try {
      const body = await (await fetch('/api/projects')).json();
      if (Array.isArray(body?.projects)) _registered = body.projects;
    } catch { /* asked again the next time */ }
  }
  return projectFor(path, _registered);
}

// ── Problems ──

/** The check a document gets: none for a large one, or for a plan or a changelog. */
const lintKindOf = (doc) => (doc.large || doc.kind !== 'file' ? null : lintKind(doc.file?.path || doc.path, doc.languageName));

/** Bring a document's problem check up to its language (it may have been picked in the status bar). */
function syncLint(doc) {
  if (!_lint || !doc.loaded || !doc.file) return;
  const kind = lintKindOf(doc);
  if (kind === doc.lintKind) return;
  doc.lintKind = kind;
  const mine = ++doc.lintSeq;
  if (!kind) { applyTo(doc, { effects: _editor.effects.lint(null) }); return; }
  _lint.extension(kind).then((extension) => {
    if (isOpen(doc) && doc.loaded && mine === doc.lintSeq) applyTo(doc, { effects: _editor.effects.lint(extension) });
  }).catch(() => { if (mine === doc.lintSeq) doc.lintKind = null; });
}

/**
 * A CodeMirror state for a document's text, with what the document has beyond it from the start: the git column
 * (so the text does not move when the marks arrive), the problem check when its chunk is there, the minimap.
 */
function newState(doc, text, size) {
  const editing = _prefs.get().editing;
  doc.large = isLargeDocument({ size, length: text.length });
  doc.prefs = editing;
  doc.gitColumn = wantsGit(doc);
  doc.minimap = wantsMinimap(doc);
  const kind = lintKindOf(doc);
  const lint = _lint.ready(kind);
  doc.lintKind = lint ? kind : null;
  return _editor.createState({
    text, indent: doc.file.indent, wrap: editing.wordWrap, editing,
    git: doc.gitColumn ? _git.extension : null, lint, minimap: doc.minimap ? _minimap.extension : null,
  });
}

function applyPreferences() {
  const { editing } = _prefs.get();
  const panel = $('fe-editor-panel');
  if (panel) {
    panel.style.setProperty('--ed-font-size', `${editing.fontSize}px`);
    panel.style.setProperty('--ed-ligatures', editing.ligatures ? 'normal' : 'none');
  }
  const wrapBtn = $('fe-editor-word-wrap');
  if (wrapBtn) {
    wrapBtn.classList.toggle('active', editing.wordWrap);
    wrapBtn.setAttribute('aria-pressed', String(editing.wordWrap));
  }
  if (!_editor) return;
  const doc = _docs.get(_shownId);
  if (doc) {
    syncPreferences(doc);
    syncMinimap(doc);
    if (isActive(doc)) renderStatus(doc);
  }
  _editor.remeasure();
}

function toggleWordWrap() {
  _prefs.set({ editing: { wordWrap: !_prefs.get().editing.wordWrap } });
}

// ── Tabs ──

function openPanel() {
  _host.beforeOpen();
  const panel = $('fe-editor-panel');
  if (panel) {
    panel.inert = false;
    panel.classList.add('open');
    if (document.querySelector('.claude-panel.open')) panel.classList.add('panel-adjacent');
  }
  document.body.classList.add('fe-editor-open');
  _open = true;
  startWatching();
}

/** The panel leaves: no tab is open. */
function hidePanel() {
  persistTabs();
  _session = false;
  _open = false;
  _shownId = null;
  _watcher?.stop();
  closeEditorMenu();
  _ai?.documentChanged();
  if (_editor) {
    _search?.dismiss(_editor.view);
    _editor.clear();
  }
  renderActive();
  $('fe-editor-keybinds')?.classList.remove('open');

  // The panel stays in the page while it is closed: nothing in it keeps the keyboard or can be tabbed to.
  const panel = $('fe-editor-panel');
  if (panel) {
    if (panel.contains(document.activeElement)) document.activeElement.blur();
    panel.classList.remove('open');
    panel.inert = true;
  }
  document.body.classList.remove('fe-editor-open');
}

/** The shown document leaves the view: its state and where it was scrolled to are kept with it. */
function stash(doc) {
  if (!doc || !_editor || !doc.loaded || !doc.file) return;
  doc.state = _editor.view.state;
  doc.scroll = _editor.snapshotScroll();
  doc.top = _editor.topPosition();
}

/** Put a document in the view. */
function mount(doc) {
  _shownId = doc.id;
  if (!_editor) return;
  if (doc.loaded && doc.state) {
    _editor.show(doc.state, { scroll: doc.scroll, top: doc.top });
    doc.state = null;
    doc.scroll = null;
    syncPreferences(doc);
    syncMinimap(doc);
  } else if (!doc.loaded) {
    _editor.clear();
  }
}

/** Select a tab and show its document. */
function showTab(id, { focus = false } = {}) {
  const doc = _docs.get(id);
  if (!doc) return;
  if (_shownId !== id) {
    stash(_docs.get(_shownId));
    closeEditorMenu();
    _model = activateTab(_model, id);
    mount(doc);
    _ai?.documentChanged();
  } else {
    _model = activateTab(_model, id);
  }
  renderActive();
  schedulePersist();
  if (focus && doc.loaded && !doc.preview) _editor?.focus();
}

/** A tab the user went to: read it now when it came back from storage and was not read yet. */
function visitTab(id, { focus = true } = {}) {
  const doc = _docs.get(id);
  if (!doc) return;
  showTab(id, { focus });
  if (!doc.loaded && !doc.refused && !doc.failed) loadLater(doc);
}

function loadLater(doc) {
  if (doc.loading) return;
  doc.loading = true;
  enqueue(async (alive) => {
    try { if (alive() && isOpen(doc) && !doc.loaded) await loadDocument(doc); } finally { doc.loading = false; }
  });
}

function cycleTab(delta) {
  const id = neighborTab(_model, _model.activeId, delta);
  if (id) visitTab(id);
}

function closeActiveTab() {
  const doc = active();
  if (doc) closeTabs([doc.id]);
}

/**
 * Close tabs. One question is asked for all that have unsaved changes; a plan or a changelog that is closed
 * without being saved tells its panel.
 * @param {string[]} ids
 * @param {{ saved?: boolean }} [o] `saved`: the tab closes because its plan or changelog was saved
 * @returns {boolean} false when they stay open: a save is under way, or the user kept their changes
 */
function closeTabs(ids, { saved = false } = {}) {
  const docs = ids.map((id) => _docs.get(id)).filter(Boolean);
  if (!docs.length) return true;
  if (docs.some((doc) => doc.saving)) return false;
  if (!saved) {
    const question = closeConfirm(docs.filter(isDirty).map((doc) => doc.name), { only: _model.tabs.length === 1 });
    if (question && !confirm(t(question.key, question.params))) return false;
  }
  for (const doc of docs) {
    if (!saved) {
      // The panel that asked for the plan or the changelog hears that it was not saved.
      if (doc.plan) emit('plan-edit-cancelled', planEvent(planIdentity(doc)));
      if (doc.kind === 'changelog') emit('changelog-edit-cancelled');
    }
    // The unsaved text was given up, or saved: its copy goes with the tab.
    backups().drop(doc.key, { always: isDirty(doc) });
    _model = closeTab(_model, doc.id).model;
    _docs.delete(doc.id);
    if (_shownId === doc.id) _shownId = null;
  }
  if (!_model.tabs.length) { hidePanel(); return true; }
  if (_shownId !== _model.activeId) visitTab(_model.activeId, { focus: true });
  else renderActive();
  schedulePersist();
  return true;
}

/** What a command of a tab's menu does. */
function tabCommand(id, command) {
  const doc = _docs.get(id);
  if (!doc) return;
  if (command === 'close') closeTabs([id]);
  else if (command === 'closeOthers') closeTabs(closeTargets(_model, 'others', id));
  else if (command === 'closeSaved') closeTabs(closeTargets(_model, 'saved', id, (tab) => { const other = _docs.get(tab.id); return isDirty(other) || !!other?.saving; }));
  else if (command === 'copyPath') {
    // Said only when it happened: a page that is not allowed the clipboard copies nothing.
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(doc.file?.path || doc.path).then(() => toast(t('editor.toast.pathCopied'))).catch(() => {});
  } else if (command === 'reveal') {
    Promise.resolve(_host.revealInTree ? _host.revealInTree(doc.file?.path || doc.path) : false)
      .then((found) => { if (!found) toast(t('editor.toast.notInTree')); })
      .catch(() => toast(t('editor.toast.notInTree')));
  }
}

// ── What is kept of the tabs, per project ──

function readRemembered() {
  try { return JSON.parse(storage.getItem(KEYS.EDITOR_TABS) || 'null'); } catch { return null; }
}

/** What is to be remembered, with each tab whose copy is still on its way at the path that copy is under. */
function heldBack(snapshot) {
  if (!_onTheWay.length) return snapshot;
  const held = (path) => (typeof path === 'string' ? _onTheWay.find((entry) => entry.now === normalizePath(path))?.at ?? path : path);
  return { active: held(snapshot.active), tabs: snapshot.tabs.map((tab) => ({ ...tab, path: held(tab.path) })) };
}

/** Write the open tabs, the selected one and where each is, for the project the panel was opened in. */
function persistTabs() {
  clearTimeout(_persistTimer);
  _persistTimer = 0;
  if (!_session) return;
  const snapshot = heldBack(serializeTabs(_model, (tab) => {
    const doc = _docs.get(tab.id);
    if (!doc || doc.refused) return null;
    if (!doc.loaded) return doc.place || {};
    const state = stateOf(doc);
    const main = state.selection.main;
    return { anchor: main.anchor, head: main.head, top: isShown(doc) ? _editor.topPosition() : doc.top, dirty: doc.dirty };
  }));
  const written = `${_project}\n${JSON.stringify(snapshot)}`;
  if (written === _persisted) return;
  _persisted = written;
  try { storage.setItem(KEYS.EDITOR_TABS, JSON.stringify(rememberTabs(readRemembered(), _project, snapshot, Date.now()))); } catch { /* storage is not there: nothing is kept */ }
}

/**
 * Write the tabs soon. `soon: false` is for a caret or a view that moved: that is written at most every two
 * seconds, and never puts off a write that is already due.
 */
function schedulePersist({ soon = true } = {}) {
  if (!_session) return;
  if (!soon) {
    if (!_persistTimer) _persistTimer = setTimeout(persistTabs, POSITION_PERSIST_MS);
    return;
  }
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(persistTabs, PERSIST_DELAY_MS);
}

/** The panel is being opened: the tabs that were open in this project the last time come back, not read yet. */
function startSession() {
  if (_session) return;
  _session = true;
  _persisted = '';
  _project = String(_host.projectRoot() || '');
  const snapshot = recallTabs(readRemembered(), _project);
  if (!snapshot) return;
  // A tab that is still remembered at the path its copy is under opens where its file is by now.
  const ahead = (path) => (typeof path === 'string' ? _onTheWay.find((entry) => entry.at === normalizePath(path))?.now ?? path : path);
  const recalled = _onTheWay.length
    ? { active: ahead(snapshot.active), tabs: snapshot.tabs.map((tab) => (tab && typeof tab === 'object' ? { ...tab, path: ahead(tab.path) } : tab)) }
    : snapshot;
  const { model, places } = restoreTabs(recalled);
  _model = model;
  for (const tab of model.tabs) createDoc(tab, { place: places.get(tab.id) });
}

/** An open that showed nothing: when the panel is not up, the tabs that came back for it wait for the next one. */
function settleSession() {
  if (_open) return;
  _session = false;
  _model = createTabs();
  _docs.clear();
  _shownId = null;
}

// ── Opening ──

/** Opens run one at a time, in the order they were asked for. `alive()` is false once the panel was closed since. */
function enqueue(job) {
  const epoch = _epoch;
  const run = () => job(() => epoch === _epoch);
  _queue = _queue.then(run, run).catch((error) => console.error('[editor] could not open', error));
  return _queue;
}

async function readFile(path) {
  const [res] = await Promise.all([fetch(`/api/file-content?path=${encodeURIComponent(path)}`), askCapabilities()]);
  return { res, data: await res.json() };
}

/**
 * Open something in a tab: a file, a plan or a changelog. A document that is already open is shown again.
 * @param {{ kind?: 'file' | 'plan' | 'changelog', path: string, at?: { line?: number, column?: number } | null, pin?: boolean, plan?: object | null }} request
 * @param {() => boolean} alive
 */
async function openDocument({ kind = 'file', path, at = null, pin = false, plan = null }, alive) {
  const cancelled = () => {
    if (kind === 'plan') emit('plan-edit-cancelled', planEvent({ ...plan.contract, source: plan.source, tabId: plan.tabId }));
    if (kind === 'changelog') emit('changelog-edit-cancelled');
  };
  const giveUp = (message) => { toast(message); cancelled(); settleSession(); };
  const keyOf = (where) => tabKey({ kind, path: where, identity: plan ? planIdentityKey({ ...plan.contract, source: plan.source, tabId: plan.tabId }) : '' });

  startSession();
  let tab = findTab(_model, keyOf(path));
  if (tab) { await revisit(_docs.get(tab.id), { at, pin }); return; }

  let res; let data;
  try {
    ({ res, data } = await readFile(path));
  } catch {
    if (alive()) giveUp(t('editor.toast.openFailed')); else cancelled();
    return;
  }
  if (!alive()) { cancelled(); return; }
  if (!res.ok) {
    const failure = describeOpenFailure({ status: res.status, body: data, path });
    if (failure.kind === 'refused' && kind === 'file') { showRefused(String(path).replace(/\\/g, '/'), failure.key); return; }
    giveUp(failure.text || t(failure.key, { name: baseName(path), ...failure.params }));
    return;
  }
  // A server from before the encoding check decodes anything: a file that was not UTF-8 is not opened either.
  if (data.version === undefined && looksLossyDecoded(data.content, data.size)) {
    if (kind === 'file') showRefused(data.path, 'editor.refused.encoding');
    else giveUp(t('editor.refused.encoding', { name: data.name }));
    return;
  }
  const split = splitBom(data.content, data.bom);
  if (kind === 'plan' && !matchesExpectedMarkdown(split.text, plan.contract.expectedMarkdown)) {
    giveUp(t('editor.toast.planChanged'));
    return;
  }

  // The path as the server resolved it may be open under another spelling.
  tab = findTab(_model, keyOf(data.path));
  if (tab) { await revisit(_docs.get(tab.id), { at, pin }); return; }

  const doc = addDoc({ key: keyOf(data.path), kind, path: data.path, name: data.name || baseName(data.path), pin }, { plan: plan ? { ...plan, filePath: data.path } : null });
  await fillDocument(doc, data, split, { at });
}

/** A tab for a new document: the one nobody kept gives its place, or one is added. */
function addDoc(request, extra) {
  const opened = openTab(_model, request, { canReuse: (other) => { const doc = _docs.get(other.id); return !doc || (!isDirty(doc) && !doc.saving); } });
  _model = opened.model;
  if (opened.replacedId) {
    _docs.delete(opened.replacedId);
    if (_shownId === opened.replacedId) _shownId = null;
  }
  return createDoc(getTab(_model, opened.id), extra);
}

/** An open asked for a document that has a tab: show it, read it when it was not read yet, and bring it up to date. */
async function revisit(doc, { at = null, pin = false } = {}) {
  if (pin) _model = pinTab(_model, doc.id);
  openPanel();
  showTab(doc.id);
  if (!doc.loaded) { await loadDocument(doc, { at }); return; }
  if (at?.line && isShown(doc)) _editor.reveal(at.line, at.column || 1);
  if (!doc.preview) _editor?.focus();
  // Opened again by name: when nothing is unsaved, it shows what the disk holds now.
  if (doc.kind === 'file' && !doc.dirty && !doc.saving) await reloadClean(doc);
}

/**
 * A tab whose file could not be read. It goes, unless it came back with unsaved text: that tab stays, so the
 * text is not given up without a question, and its copy is there when the file can be read again.
 */
function dropUnreadable(doc, message) {
  if (!isOpen(doc)) return;
  toast(message);
  if (doc.place?.dirty) return;
  _model = closeTab(_model, doc.id).model;
  _docs.delete(doc.id);
  if (_shownId === doc.id) _shownId = null;
  if (!_model.tabs.length) { hidePanel(); return; }
  if (_shownId !== _model.activeId) visitTab(_model.activeId, { focus: true });
  else renderActive();
  schedulePersist();
}

/** Read the file of a tab that has none yet (it came back from storage, or the editor did not load) and fill it. */
async function loadDocument(doc, { at = null } = {}) {
  const asked = doc.path;
  // Renamed or moved while it was being read (repointEditorTab): it is read where it is now.
  const elsewhere = () => isOpen(doc) && !doc.loaded && doc.path !== asked;
  let res; let data;
  try {
    ({ res, data } = await readFile(asked));
  } catch {
    if (elsewhere()) { await loadDocument(doc, { at }); return; }
    dropUnreadable(doc, t('editor.toast.openFailed'));
    return;
  }
  if (!isOpen(doc)) return;
  if (elsewhere()) { await loadDocument(doc, { at }); return; }
  if (!res.ok) {
    const failure = describeOpenFailure({ status: res.status, body: data, path: doc.path });
    if (failure.kind === 'refused') { markRefused(doc, failure.key); return; }
    dropUnreadable(doc, failure.text || t(failure.key, { name: doc.name, ...failure.params }));
    return;
  }
  if (data.version === undefined && looksLossyDecoded(data.content, data.size)) { markRefused(doc, 'editor.refused.encoding'); return; }
  await fillDocument(doc, data, splitBom(data.content, data.bom), { at });
}

/** Give a tab its document: the file's facts, a CodeMirror state, the unsaved text a copy holds, the language. */
async function fillDocument(doc, data, { text, bom }, { at = null } = {}) {
  const ending = detectLineEnding(text);
  const detectedIndent = detectIndentation(text);
  const name = data.name || baseName(data.path);
  doc.path = data.path;
  doc.name = name;
  doc.file = {
    path: data.path, name, size: data.size || 0, version: data.version || null,
    eol: ending.eol, mixed: ending.mixed, diskEol: ending.eol, diskMixed: ending.mixed, bom,
    detectedIndent, indentChoice: null, indent: chooseIndentation(detectedIndent, _prefs.get().editing, null),
    markdown: isMarkdownFile(name),
  };
  doc.refused = null;
  doc.failed = false;
  doc.languageName = languageLabel(name, null) || '';
  _model = updateTab(_model, doc.id, { path: data.path, name });

  // A tab that is read while the user has gone on to another one stays in the background.
  if (isActive(doc)) {
    openPanel();
    showTab(doc.id);
  } else {
    renderStrip();
  }
  if (doc.plan) emitPlanState(doc);

  let editor; let backup;
  try {
    [editor, backup] = await Promise.all([ensureEditor(), backups().read(doc.key)]);
  } catch (error) {
    console.error('[editor] CodeMirror did not load', error);
    if (!isOpen(doc)) return;
    doc.file = null;
    doc.failed = true;
    if (isActive(doc)) renderActive();
    return;
  }
  if (!isOpen(doc)) return;

  doc.file.indent = chooseIndentation(detectedIndent, _prefs.get().editing, null);
  let state = newState(doc, text, data.size || 0);
  doc.savedDoc = state.doc;
  state = restoreBackup(doc, state, backup);
  // Where the caret and the view were, for a tab that came back: places in the text as it was left, unsaved
  // text included, so they are put back after that text is.
  if (doc.place) {
    const inside = (n) => Math.min(n, state.doc.length);
    state = state.update({ selection: { anchor: inside(doc.place.anchor), head: inside(doc.place.head) } }).state;
    doc.top = inside(doc.place.top);
  }
  doc.place = null;
  doc.state = state;
  doc.scroll = null;
  doc.loaded = true;
  if (isActive(doc)) mount(doc);

  useLanguage(doc, editor.describeLanguage(name));
  syncAi();
  startWatching();
  loadHead(doc);
  refreshDoc(doc, { force: true });
  schedulePersist();
  if (!isActive(doc)) { renderStrip(); return; }
  renderActive();
  if (at?.line) editor.reveal(at.line, at.column || 1);
  editor.focus();
}

/**
 * Unsaved text that was copied before the page went away comes back as the buffer, with a bar that says so.
 * The line ending the user had chosen comes back with it (it is unsaved too, even when the text is not).
 * @returns the state with the unsaved text in it; an undo takes it out again
 */
function restoreBackup(doc, state, backup) {
  if (!backup) return state;
  const disk = state.doc.toString();
  const verdict = describeBackup(backup, disk);
  const ending = backup.eol !== doc.file.eol;
  if (verdict === 'same' && !ending) { backups().drop(doc.key); return state; }
  if (ending) {
    doc.file.eol = backup.eol;
    doc.file.mixed = false;
    doc.eolChanged = true;
  }
  doc.bars.set('restored', verdict === 'restore-changed' ? 'restored-changed' : 'restored');
  const change = minimalChange(disk, backup.text);
  return change ? state.update({ changes: change }).state : state;
}

/** Show a document in a language (its chunk may still have to arrive), or in none. */
async function useLanguage(doc, description) {
  doc.language = description || null;
  doc.languageName = languageNameOf(doc);
  if (isActive(doc)) renderStatus(doc);
  syncLint(doc);
  const mine = ++doc.languageSeq;
  const support = await _editor.loadLanguage(doc.language);
  // A language that arrives late lands in its own tab, wherever that tab is by then.
  if (!isOpen(doc) || !doc.loaded || mine !== doc.languageSeq) return;
  applyTo(doc, { effects: _editor.effects.language(support) });
}

function markRefused(doc, key) {
  doc.file = null;
  doc.loaded = false;
  doc.failed = false;
  doc.refused = { key };
  doc.place = null;
  if (isActive(doc)) renderActive();
  renderStrip();
}

// A file that is not text the editor can hold: its tab says so in place of an editor.
function showRefused(path, key) {
  const where = String(path || '');
  const doc = addDoc({ key: tabKey({ path: where }), kind: 'file', path: where, name: baseName(where) }, { refused: { key } });
  openPanel();
  showTab(doc.id);
}

// ── The file on disk ──

/** The document now holds what the disk holds: its facts, and nothing unsaved. */
function adoptDisk(doc, data, { text, bom }) {
  const ending = detectLineEnding(text);
  const { file } = doc;
  file.size = data.size ?? file.size;
  file.version = data.version || null;
  file.eol = ending.eol;
  file.mixed = ending.mixed;
  file.diskEol = ending.eol;
  file.diskMixed = ending.mixed;
  file.bom = bom;
  file.detectedIndent = detectIndentation(text);
  doc.savedDoc = stateOf(doc).doc;
  doc.eolChanged = false;
  doc.deleted = false;
  doc.pendingVersion = null;
  doc.bars.delete('disk');
  doc.bars.delete('restored');
  backups().drop(doc.key);
  if (!file.indentChoice) {
    file.indent = chooseIndentation(file.detectedIndent, _prefs.get().editing, null);
    applyTo(doc, { effects: _editor.effects.indent(file.indent) });
  }
  refreshDoc(doc, { force: true });
  // What changed the file may have moved the last commit too (a checkout, a pull).
  loadHead(doc);
  if (isActive(doc)) renderActive();
  else renderStrip();
}

/**
 * A file with nothing unsaved changed on disk: the tab takes the new text without a word. The change is the
 * smallest one that does it, so the caret, the view and the undo history stay where they are.
 */
async function reloadClean(doc) {
  let res; let data;
  try { ({ res, data } = await readFile(doc.file.path)); } catch { return; }
  if (!isOpen(doc) || !doc.loaded || !doc.file || doc.dirty || doc.saving || !res.ok) return;
  if (data.version && sameVersion(data.version, doc.file.version) && !doc.deleted) return;
  if (data.version === undefined && looksLossyDecoded(data.content, data.size)) return;
  const split = splitBom(data.content, data.bom);
  const change = minimalChange(stateOf(doc).doc.toString(), split.text.replace(/\r\n?/g, '\n'));
  if (change) {
    quietly(() => {
      applyTo(doc, { changes: change, annotations: _cm.Transaction.addToHistory.of(false) });
      applyTo(doc, { effects: _editor.effects.saved() });
    });
    if (!isShown(doc)) {
      // Its place in the view moves with the text above it.
      doc.scroll = null;
      if (doc.top >= change.to) doc.top += change.insert.length - (change.to - change.from);
      else if (doc.top > change.from) doc.top = change.from;
    }
    if (doc.comparing) closeCompare(doc);
  }
  adoptDisk(doc, data, split);
}

/**
 * "Reload": the buffer is given up for what the disk holds (the user is asked when it has unsaved text).
 * From that answer until the file's text is in, the buffer is read-only: an edit made while the file is being
 * read would be replaced with the rest, and nobody was asked about that one.
 */
async function reloadFromDisk(doc) {
  if (doc.saving || doc.reloading || !doc.file) return;
  if (doc.dirty && !confirm(t('editor.confirm.reload'))) return;
  doc.reloading = true;
  // The lock is taken below. Whatever happens after it, a document that is still open ends as one of two things:
  // replaced by the file's text (`replaced`), or the buffer it was, to be typed into again. Never locked.
  let replaced = false;
  let failure = null;
  try {
    applyTo(doc, { effects: _editor.effects.readOnly(true) });
    let res; let data;
    try { ({ res, data } = await readFile(doc.file.path)); } catch { failure = t('editor.toast.openFailed'); }
    doc.reloading = false;
    if (!isOpen(doc) || !doc.file) return;
    if (!failure && !res.ok) failure = (typeof data?.error === 'string' && data.error) || t('editor.toast.cannotOpen');
    if (failure) return;
    // The new state is built whole before anything of the old one is given up.
    const split = splitBom(data.content, data.bom);
    const head = stateOf(doc).selection.main.head;
    let state = newState(doc, split.text, data.size ?? doc.file.size);
    state = state.update({ selection: { anchor: Math.min(head, state.doc.length) } }).state;
    if (isShown(doc)) {
      quietly(() => _editor.show(state, { top: Math.min(_editor.topPosition(), state.doc.length) }));
    } else {
      doc.state = state;
      doc.scroll = null;
      doc.top = Math.min(doc.top, state.doc.length);
    }
    replaced = true;
    doc.comparing = false;
    doc.diff = false;
    doc.bars.delete('compare');
    adoptDisk(doc, data, split);
    useLanguage(doc, doc.language);
  } catch (error) {
    // What was read could not be made into a document, or putting it in place failed.
    console.error('[editor] reload failed:', error);
    if (!replaced && !failure) failure = t('editor.toast.openFailed');
  } finally {
    doc.reloading = false;
    if (isOpen(doc) && !replaced) {
      // Nothing took the buffer's place: it is the user's as it was, and can be typed into again.
      try { applyTo(doc, { effects: _editor.effects.readOnly(false) }); } catch (error) { console.error('[editor] could not unlock the document:', error); }
      if (failure) toast(failure);
    }
  }
}

/** "Keep mine": the buffer stays, and the version on disk becomes the one the next save is checked against. */
function keepMine(doc) {
  if (!doc.file) return;
  if (doc.deleted) doc.file.version = null;
  else if (doc.pendingVersion) doc.file.version = doc.pendingVersion;
  doc.pendingVersion = null;
  clearBar(doc, 'disk');
}

/** Show the buffer against the file on disk, inline (or bring a comparison that is showing up to date). */
async function showCompare(doc) {
  if (!doc.loaded || !doc.file || !_compare) return;
  let extension;
  try {
    const { res, data } = await readFile(doc.file.path);
    if (!res.ok) throw new Error(data?.error || 'not read');
    const disk = splitBom(data.content, data.bom).text.replace(/\r\n?/g, '\n');
    extension = await _compare.extension({ original: disk, revertLabel: t('editor.compare.useDisk') });
  } catch {
    if (isOpen(doc)) toast(t('editor.compare.failed'));
    return;
  }
  if (!isOpen(doc) || !doc.loaded) return;
  applyTo(doc, { effects: _editor.effects.compare(extension) });
  doc.comparing = true;
  doc.diff = false;
  doc.bars.set('compare', 'comparing');
  if (!isActive(doc)) return;
  if (doc.preview) setPreview(false);
  renderBars(doc);
  renderDiffButton(doc);
}

function closeCompare(doc) {
  if (!doc.comparing) return;
  doc.comparing = false;
  doc.bars.delete('compare');
  if (doc.loaded) applyTo(doc, { effects: _editor.effects.compare(null) });
  if (isActive(doc)) renderBars(doc);
}

// ── Saving, discarding, closing ──

/**
 * Save a document. A plan with a save callback of its own is saved through it and nothing is written here;
 * anything else goes to /api/file-content in the file's own line ending and encoding.
 */
async function saveDocument(doc, { force = false } = {}) {
  if (!doc?.loaded || !doc.file || !_editor || doc.saving || doc.reloading) return;
  const changelog = doc.kind === 'changelog';
  // Nothing to write for an unchanged file. A plan or a changelog is still "saved": that is how it is approved.
  if (!doc.dirty && !doc.plan && !changelog && !force) return;
  if (doc.kind === 'file') applySaveFixes(doc);
  const savedState = stateOf(doc);
  const savedDoc = savedState.doc;
  const savedContent = savedDoc.toString();
  const savedPath = doc.file.path;
  const plan = doc.plan;
  const planIds = plan ? planEvent(planIdentity(doc)) : null;
  const contract = plan?.contract;
  doc.saving = true;
  applyTo(doc, { effects: _editor.effects.readOnly(true) });
  refreshDoc(doc, { force: true });
  let saved = false;
  let result = null;
  try {
    if (planIds?.source === 'codex' && typeof contract?.save !== 'function') {
      throw new Error(t('editor.error.planMissingRevision'));
    }
    if (typeof contract?.save === 'function') {
      result = await contract.save({ ...planIds, content: savedContent });
      if (!result?.ok) throw new Error(result?.reason || result?.error || t('editor.error.planChanged'));
    } else {
      const body = { path: savedPath, content: serializeDocument(savedContent, doc.file) };
      if (doc.deleted) {
        // The file is gone from the disk: the user kept the tab, a save puts it back. Unless it is there again by
        // now (made by someone else since the last look at the disk): the server then refuses, and the bar asks.
        body.create = true;
        if (!force) body.expectAbsent = true;
      } else if (_capabilities?.has('file-version') && doc.file.version) {
        body.expect = doc.file.version;
        if (force) body.force = true;
      }
      const res = await fetch('/api/file-content', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      result = await res.json();
      if (res.status === 409 && result?.code === 'changed') {
        if (isOpen(doc)) {
          doc.pendingVersion = result.current || doc.pendingVersion;
          doc.deleted = false;   // whatever the tab took the file for: it is there, and it is not the tab's text
          setBar(doc, 'conflict');
        }
        throw new Error(t('editor.toast.changedOnDisk'));
      }
      if (!res.ok) throw new Error(result.error || t('editor.toast.saveFailed'));
      if (result.version) {
        doc.file.version = result.version;
        doc.file.size = result.version.size ?? doc.file.size;
      }
    }
    saved = true;
  } catch (error) {
    const message = error?.message || t('editor.toast.saveFailed');
    toast(message);
    if (plan?.source === 'codex' && isOpen(doc)) {
      doc.banner = t('editor.banner.planSaveFailed', { message });
      if (isActive(doc)) renderBanner(doc);
    }
  }
  doc.saving = false;
  if (!isOpen(doc)) return;
  if (saved) {
    doc.savedDoc = savedDoc;
    doc.file.diskEol = doc.file.eol;
    doc.file.diskMixed = false;
    doc.file.mixed = false;
    doc.eolChanged = false;
    doc.deleted = false;
    doc.pendingVersion = null;
    doc.banner = null;
    doc.bars.delete('disk');
    doc.bars.delete('restored');
    if (doc.comparing) closeCompare(doc);
  }
  quietly(() => applyTo(doc, { effects: saved ? [_editor.effects.readOnly(false), _editor.effects.saved()] : _editor.effects.readOnly(false) }));
  refreshDoc(doc, { force: true });
  if (!saved) return;
  // What was saved needs no copy any more. A buffer that holds more than was saved (it changed while the save was
  // on its way) is unsaved text like any other: its copy is made again, not dropped.
  syncBackup(doc);
  // The commit the markers compare with may have moved since the file was opened.
  if (doc.kind === 'file') loadHead(doc);
  if (isActive(doc)) renderActive();

  if (plan && doc.plan === plan && savedPath === plan.filePath) {
    toast(t('editor.toast.planSaved'));
    emit('plan-saved', {
      ...planIds, filePath: result?.path || savedPath, content: savedContent,
      persisted: typeof contract?.save === 'function', savedRevision: result?.document?.revision,
    });
    closeTabs([doc.id], { saved: true });
    return;
  }
  if (changelog) {
    toast(t('editor.toast.changelogSaved'));
    emit('changelog-saved', { content: savedContent });
    closeTabs([doc.id], { saved: true });
    return;
  }
  toast(t('editor.toast.saved'));
}

/**
 * What the on-save preferences change in a file's text, as one edit the user can undo: spaces and tabs at the end
 * of lines go, and the text ends with one line break. Two spaces at the end of a line are a line break in
 * Markdown, so its lines are not trimmed.
 */
function applySaveFixes(doc) {
  const { trimTrailingWhitespace, insertFinalNewline } = _prefs.get().editing;
  if (!trimTrailingWhitespace && !insertFinalNewline) return;
  const changes = saveFixes(stateOf(doc).doc.toString(), { trimTrailingWhitespace: trimTrailingWhitespace && !doc.file.markdown, insertFinalNewline });
  if (changes.length) applyTo(doc, { changes, userEvent: 'synabun.save' });
}

/** Put a document back to what was last saved. One undo brings the edits back. */
function revertToSaved(doc) {
  if (!doc?.loaded || doc.saving || doc.reloading || !doc.savedDoc || !_editor) return;
  const state = stateOf(doc);
  const head = Math.min(state.selection.main.head, doc.savedDoc.length);
  doc.file.eol = doc.file.diskEol;
  doc.file.mixed = doc.file.diskMixed;
  doc.eolChanged = false;
  doc.bars.delete('restored');
  applyTo(doc, { changes: { from: 0, to: state.doc.length, insert: doc.savedDoc }, selection: { anchor: head } });
  refreshDoc(doc, { force: true });
  if (isActive(doc)) renderActive();
}

/**
 * Save the document of the selected tab.
 * @param {{ force?: boolean }} [o] `force`: write even though the file changed on disk since it was read
 */
export function saveEditorPanel({ force = false } = {}) {
  return saveDocument(active(), { force });
}

/** Put the selected tab's document back to what was last saved (the user is asked first). */
export function discardEditorPanel() {
  const doc = active();
  if (!doc?.loaded || doc.saving || !doc.savedDoc || !_editor) return;
  if (!confirm(t('editor.confirm.discard'))) return;
  revertToSaved(doc);
}

/**
 * Close the panel: every tab. One question lists the files that have unsaved changes.
 * @returns {boolean} false when it stays open: a save is under way, or the user kept their changes
 */
export function closeEditorPanel() {
  if (!closeTabs(closeTargets(_model, 'all', null))) return false;
  // An open that has not answered yet is given up on.
  ++_epoch;
  if (_open) hidePanel();
  return true;
}

// ── What the File Explorer and the bus ask for ──

/** Whether the panel is showing. */
export function isEditorPanelOpen() {
  return _open;
}

/** Whether the editor is open, or about to be (a plan being fetched). */
export function isEditorPanelBusy() {
  return _open || _pendingPlans > 0;
}

/**
 * Open a file in a tab. A file that is already open is shown again; a tab nobody edited or kept gives its place.
 * @param {string} filePath
 * @param {{ line?: number, column?: number, pin?: boolean }} [at] where to put the caret (1-based); `pin`: the
 *   tab is the user's to keep (a double click)
 */
export function openFileInEditor(filePath, { line, column, pin = false } = {}) {
  if (!filePath) return;
  enqueue((alive) => (alive() ? openDocument({ kind: 'file', path: filePath, at: line ? { line, column } : null, pin }, alive) : undefined));
}

/**
 * Open a plan in a tab of its own (`open-plan-editor`). Asking for the revision that is already open only
 * focuses it. The panel and tab that ask follow one plan at a time: an earlier plan of theirs gives its tab up.
 * @param {object} contract the event's payload: filePath, source, tabId, the plan's identity, and for a
 *   versioned plan `expectedMarkdown` and `save`
 */
export function openPlanInEditor(contract = {}) {
  const { filePath, source = 'claude', tabId = null } = contract;
  if (!filePath) return;
  const same = planDocs().find((doc) => isSamePlan(planRequest(doc), contract));
  if (same) {
    showTab(same.id);
    _editor?.focus();
    return;
  }
  _pendingPlans++;
  enqueue(async (alive) => {
    try {
      if (!alive()) { emit('plan-edit-cancelled', planEvent(contract)); return; }
      const earlier = planDocs().filter((doc) => isSamePlanOwner(planRequest(doc), contract));
      if (earlier.length && !closeTabs(earlier.map((doc) => doc.id))) {
        emit('plan-edit-cancelled', planEvent(contract));
        return;
      }
      await openDocument({ kind: 'plan', path: filePath, plan: { contract, filePath, source, tabId } }, alive);
    } finally {
      _pendingPlans--;
    }
  });
}

/** Open a changelog draft in a tab of its own (`open-changelog-editor`). There is one at a time. */
export function openChangelogInEditor({ filePath } = {}) {
  if (!filePath) return;
  enqueue(async (alive) => {
    if (!alive()) return;
    const key = tabKey({ kind: 'changelog', path: filePath });
    const others = [..._docs.values()].filter((doc) => doc.kind === 'changelog' && doc.key !== key);
    if (others.length && !closeTabs(others.map((doc) => doc.id))) return;
    await openDocument({ kind: 'changelog', path: filePath }, alive);
  });
}

// ── What other panels may know of the tabs ──

let _tabsSaid = '';

/** The tabs as another panel may read them: in strip order, and none while the panel is closed. */
function tabsSnapshot() {
  if (!_open) return { open: [], active: null };
  const pathOf = (doc) => doc.file?.path || doc.path;
  const open = [];
  for (const tab of _model.tabs) {
    const doc = _docs.get(tab.id);
    if (doc) open.push({ path: pathOf(doc), kind: doc.kind, dirty: isDirty(doc), pinned: !!tab.pinned });
  }
  const shown = active();
  return { open, active: shown ? pathOf(shown) : null };
}

/** Say on the bus (`editor-tabs-changed`) when the open tabs, what is unsaved in them or the one showing changed. */
function announceTabs() {
  const snapshot = tabsSnapshot();
  const said = JSON.stringify(snapshot);
  if (said === _tabsSaid) return;
  _tabsSaid = said;
  emit('editor-tabs-changed', snapshot);
}

/**
 * The open tabs, as `editor-tabs-changed` last said them (for a listener that starts after the tabs were opened).
 * @returns {{ open: { path: string, kind: 'file' | 'plan' | 'changelog', dirty: boolean, pinned: boolean }[], active: string | null }}
 *   `open`: in strip order, empty while the panel is closed; `dirty`: it has unsaved text; `pinned`: it is the
 *   user's to keep; `active`: the path of the tab that is showing
 */
export function getEditorTabs() {
  return tabsSnapshot();
}

/**
 * A file, or a folder of files, was renamed or moved on disk (the File Explorer did it): the tabs of those files
 * follow. Each keeps its document as it is: the text and what is unsaved of it, the caret, where it is scrolled to,
 * the undo history, whether it is the user's to keep. From here on it is read, saved, checked against the disk,
 * copied and remembered at its new path. Plan and changelog tabs stay: each belongs to the panel that asked for it.
 *
 * A tab that was open for the new path showed a file that was replaced. It goes; unless it has unsaved text: then
 * it stays, and the tab that would take its path stays at the old one (`kept`), where the check against the disk
 * says the file is gone. The tabs that are remembered while the panel is closed follow too, with their copies.
 * @param {string} fromPath the file or the folder as it was
 * @param {string} toPath as it is now
 * @returns {{ moved: { from: string, to: string }[], kept: string[] }} the open tabs that follow, and the paths of
 *   those that could not
 */
export function repointEditorTab(fromPath, toPath) {
  const moved = [];
  const kept = [];
  if (!fromPath || !toPath || normalizePath(fromPath) === normalizePath(toPath)) return { moved, kept };
  const since = Date.now();
  // One kept tab, of whichever project, is at its new path from now on.
  const remember = (pairs) => {
    try {
      let stored = readRemembered(); let changed = false;
      for (const [from, to] of pairs) {
        const next = repointRemembered(stored, from, to);
        if (next.moved.length) { stored = next.stored; changed = true; }
      }
      if (changed) storage.setItem(KEYS.EDITOR_TABS, JSON.stringify(stored));
    } catch { /* storage is not there: nothing is kept */ }
    if (_session) {
      _persisted = '';
      persistTabs();
    }
  };
  // A copy of unsaved text is stored under its document's key: it follows the document to the new one, and what is
  // remembered of the tab follows the copy (`commit`), never the other way round. The text of an open document is
  // the newest there is and goes under the new key in this very call. A copy that is only in the store (a kept tab
  // that is not open) is brought by the store's queue: until it has arrived the tab stays remembered where its
  // copy is (`_onTheWay`), also while the store is not chosen yet, which it is once the server has said what it
  // offers. `hint`: `read`, the buffer of an open document; `expected`, it is known to have unsaved text.
  let settled = [];   // what could be remembered at once: written together when this call is done
  const follow = (was, now, hint) => {
    const from = normalizePath(was); const to = normalizePath(now);
    let entry = _onTheWay.find((held) => held.now === from);
    if (entry) entry.now = to;
    else { entry = { at: from, now: to, steps: 0 }; _onTheWay.push(entry); }
    entry.steps++;
    const commit = () => {
      entry.at = to;
      if (--entry.steps <= 0 && _onTheWay.includes(entry)) _onTheWay.splice(_onTheWay.indexOf(entry), 1);
      if (settled) settled.push([from, to]); else remember([[from, to]]);
    };
    const move = () => backups().move(tabKey({ path: from }), tabKey({ path: to }), to, { ...hint, since, commit }).catch(() => {});
    if (_backups) move(); else askCapabilities().then(move).catch(() => {});
  };

  for (const doc of [..._docs.values()]) {
    if (doc.kind !== 'file' || !isOpen(doc)) continue;
    const was = doc.file?.path || doc.path;
    const now = repointPath(was, fromPath, toPath);
    if (!now || now === normalizePath(was)) continue;
    const key = tabKey({ path: now });
    const other = findTab(_model, key);
    if (other && other.id !== doc.id) {
      const there = _docs.get(other.id);
      if (there && (isDirty(there) || there.saving)) { kept.push(was); continue; }
      _model = closeTab(_model, other.id).model;
      _docs.delete(other.id);
      if (_shownId === other.id) _shownId = null;
    }
    const before = { key: doc.key, name: doc.name };
    const name = baseName(now);
    doc.key = key;
    doc.path = now;
    doc.name = name;
    if (doc.file) {
      doc.file.path = now;
      doc.file.name = name;
      doc.file.markdown = isMarkdownFile(name);
      if (!doc.file.markdown) doc.preview = false;
    }
    _model = updateTab(_model, doc.id, { key, path: now, name });
    follow(was, now, { read: backupReader(doc), expected: isDirty(doc) });
    // A check of the disk that ran while the file was on its way found nothing at the old path.
    if (doc.deleted) {
      doc.deleted = false;
      if (doc.bars.get('disk') === 'deleted') doc.bars.delete('disk');
    }
    if (doc.loaded && doc.file && _editor) {
      // Its language follows its name, unless the user picked one; the last commit is asked about the new path.
      if (name !== before.name && !doc.languageChoice) useLanguage(doc, _editor.describeLanguage(name));
      else syncLint(doc);
      loadHead(doc);
    }
    moved.push({ from: was, to: now });
  }

  // What is kept of the tabs: of this project while the panel is closed, and of every other one.
  try {
    // A tab that was already on its way (its file renamed a moment ago) and is not open: its copy goes on from
    // where it will be. The path it is still remembered at is no longer where its file is, so that path is not
    // taken for one of this rename.
    const open = new Set([...moved.map((pair) => pair.from), ...kept].map(normalizePath));
    const stale = new Set(_onTheWay.map((entry) => entry.at));
    for (const entry of [..._onTheWay]) {
      const again = repointPath(entry.now, fromPath, toPath);
      if (again && again !== entry.now) follow(entry.now, again, { expected: true });
    }
    for (const pair of repointRemembered(readRemembered(), fromPath, toPath).moved) {
      if (open.has(pair.from) || stale.has(pair.from)) continue;
      // A kept tab with unsaved text has that text in its copy only: it is remembered anew when the copy has arrived.
      if (pair.dirty) follow(pair.from, pair.to, { expected: true });
      else settled.push([pair.from, pair.to]);
    }
  } catch { /* storage is not there: nothing is kept */ }
  const now = settled;
  settled = null;
  remember(now);
  if (_open && (moved.length || kept.length)) {
    if (_model.activeId && _shownId !== _model.activeId) visitTab(_model.activeId, { focus: false });
    else renderActive();
    _ai?.documentChanged();
  }
  return { moved, kept };
}

// ── What the status bar's lists do ──

const statusActions = {
  setLanguage(id) {
    const doc = active();
    if (!doc?.loaded || !_editor) return;
    if (id === LANGUAGE_AUTO) { doc.languageChoice = null; useLanguage(doc, _editor.describeLanguage(doc.name)); return; }
    if (id === LANGUAGE_PLAIN) { doc.languageChoice = LANGUAGE_PLAIN; useLanguage(doc, null); return; }
    const description = _editor.languages().find((entry) => entry.name === id);
    if (!description) return;
    doc.languageChoice = description.name;
    useLanguage(doc, description);
  },
  setIndent(choice) {
    const doc = active();
    if (!doc?.loaded || !_editor) return;
    doc.file.indentChoice = choice;
    doc.file.indent = chooseIndentation(doc.file.detectedIndent, _prefs.get().editing, choice);
    applyTo(doc, { effects: _editor.effects.indent(doc.file.indent) });
    renderStatus(doc);
    _editor.focus();
  },
  // Applied by the next save: until then the document differs from the file by its line endings.
  setEol(eol) {
    const doc = active();
    if (!doc?.loaded || (eol !== 'LF' && eol !== 'CRLF')) return;
    doc.file.eol = eol;
    doc.file.mixed = false;
    doc.eolChanged = eol !== doc.file.diskEol || doc.file.diskMixed;
    refreshDoc(doc, { force: true });
    syncBackup(doc);
    renderStatus(doc);
    _editor?.focus();
  },
  goToLine() {
    const doc = active();
    if (!doc?.loaded || !_editor) return;
    if (doc.preview) setPreview(false);
    _search.openGoToLine(_editor.view);
  },
};

// ── Wiring ──

function buildShortcuts() {
  const list = $('fe-editor-keybinds');
  if (!list) return;
  list.textContent = '';
  const title = document.createElement('div');
  title.className = 'fe-editor-keybinds-title';
  title.textContent = t('editor.shortcuts.title');
  list.append(title);
  const word = (name) => t(`editor.shortcuts.${name.toLowerCase()}`);
  for (const row of shortcutRows(undefined, { features: features() })) {
    const line = document.createElement('div');
    line.className = 'fe-editor-kb';
    const key = document.createElement('kbd');
    key.textContent = formatKey(row.key, IS_MAC, row.gesture ? word : undefined);
    const name = document.createElement('span');
    name.textContent = t(row.titleKey);
    line.append(key, ' ', name);
    list.append(line);
  }
}

/**
 * Wire the panel. Called once, by the File Explorer.
 * @param {{ toast?: (message: string) => void, projectRoot?: () => string | null, beforeOpen?: () => void,
 *   openSettings?: (target: object) => void, revealInTree?: (path: string) => boolean | Promise<boolean>,
 *   fileIcon?: (fileName: string) => object | null }} [host]
 *   `toast` shows a short message; `projectRoot` is the selected project's folder (the header shows paths
 *   relative to it, and the open tabs are kept for it); `beforeOpen` runs as the panel opens (the File Explorer
 *   closes its menus); `openSettings` opens Settings on a page and section (AI autocomplete's popover links
 *   there); `revealInTree` shows a file in the tree and says whether it is there; `fileIcon` is the tree's
 *   icon for a file name.
 */
export function initEditorPanel(host = {}) {
  _host = { ..._host, ...host };

  $('fe-editor-back')?.addEventListener('click', () => closeEditorPanel());
  $('fe-editor-close')?.addEventListener('click', () => closeActiveTab());
  $('fe-editor-save')?.addEventListener('click', () => saveEditorPanel());
  $('fe-editor-discard')?.addEventListener('click', () => discardEditorPanel());

  const panel = $('fe-editor-panel');
  if (panel && !panel.classList.contains('open')) panel.inert = true;
  const openMenu = (menu) => openEditorMenu({ host: panel, ...menu });

  const tabsRoot = $('fe-editor-tabs');
  if (tabsRoot) {
    _strip = createTabStrip({
      root: tabsRoot,
      t,
      fileIcon: (name) => _host.fileIcon?.(name) || null,
      openMenu,
      on: {
        activate: (id, { keepFocus = false } = {}) => visitTab(id, { focus: !keepFocus }),
        close: (id) => closeTabs([id]),
        pin: (id) => { _model = pinTab(_model, id); renderStrip(); schedulePersist(); },
        move: (id, index) => { _model = moveTab(_model, id, index); renderStrip(); schedulePersist(); },
        command: tabCommand,
        // A tab was closed from the keyboard and the strip left with it (one file is open now). The keyboard
        // stays in the panel, on the control that does what was being done: not in the text, where a key still
        // held down would delete, and not on the page, where it would be the whiteboard's shortcut.
        keyboardLeft: () => { if (isEditorPanelOpen()) $('fe-editor-close')?.focus({ preventScroll: true }); },
      },
    });
  }
  if ($('fe-editor-statusbar')) {
    _status = createStatusBar({ t, openMenu, languages: () => (_editor ? _editor.languages() : []), actions: statusActions });
  }

  const withKey = (id, labelKey, key) => {
    const button = $(id);
    if (!button) return null;
    const label = t(labelKey);
    button.dataset.tooltip = `${label} (${formatKey(key, IS_MAC)})`;
    button.setAttribute('aria-label', label);
    return button;
  };
  withKey('fe-editor-find-btn', 'editor.header.find', 'Mod-f')?.addEventListener('click', () => {
    const doc = active();
    if (!_editor || !doc?.loaded) return;
    if (doc.preview) setPreview(false);
    _search.toggleFind(_editor.view);
  });
  withKey('fe-editor-word-wrap', 'editor.header.wordWrap', 'Alt-z')?.addEventListener('click', toggleWordWrap);
  $('fe-editor-diff-btn')?.addEventListener('click', toggleDiff);
  // The header is outside the editor's own element: a key pressed on one of its buttons (or let go of there,
  // after it closed a menu) stays in the panel.
  const header = panel?.querySelector('.fe-editor-header');
  for (const type of ['keydown', 'keyup', 'keypress']) header?.addEventListener(type, (event) => event.stopPropagation());

  // The View menu: what is drawn around the text. Every entry is stored with the preferences as it is chosen.
  const viewBtn = $('fe-editor-view-btn');
  const openViewMenu = (activeId = null) => {
    const items = viewMenuItems(_prefs.get().editing).map((entry) => (entry.separator ? entry : {
      id: entry.id, label: t(entry.labelKey), checked: entry.checked, toggle: entry.toggle, disabled: entry.disabled,
      hint: entry.hintKey ? t(entry.hintKey, entry.hintParams) : (entry.id === 'wordWrap' ? formatKey('Alt-z', IS_MAC) : ''),
    }));
    openMenu({
      anchor: viewBtn,
      label: t('editor.header.view'),
      items,
      activeId: activeId || items[0].id,
      onSelect: (id) => {
        changeEditing(viewMenuChange(id, _prefs.get().editing));
        // The text size is changed a step at a time: the menu stays for the next step.
        if (id.startsWith('font:')) openViewMenu(id);
      },
    });
  };
  viewBtn?.addEventListener('click', () => openViewMenu());

  // The command palette and go-to-file: at the top of the panel, under the header.
  _palette = createPalette({
    t,
    openMenu,
    position: () => {
      const frame = panel.getBoundingClientRect();
      const header = panel.querySelector('.fe-editor-header')?.getBoundingClientRect() || frame;
      return { x: frame.left + (frame.width - Math.min(460, frame.width - 16)) / 2, y: header.bottom + 6 };
    },
    mac: IS_MAC,
    commands: EDITOR_COMMANDS,
    features,
    run: (id) => { if (_editor) runCommand(id, { cm: _cm, view: _editor.view, actions: _editor.actions }); },
    project: searchRoot,
    // The files that are open, the one used last first: with nothing typed, Enter goes back to the file before this one.
    tabs: () => _model.recent.filter((id) => id !== _model.activeId).map((id) => _docs.get(id))
      .filter((doc) => doc && doc.kind === 'file' && !doc.refused).map((doc) => ({ path: doc.file?.path || doc.path, name: doc.name })),
    openFile: (path) => openFileInEditor(path, { pin: true }),
    onClose: focusEditor,
  });

  // Shortcuts popover
  const helpBtn = $('fe-editor-help-btn');
  const shortcuts = $('fe-editor-keybinds');
  if (helpBtn && shortcuts) {
    buildShortcuts();
    helpBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = shortcuts.classList.toggle('open');
      helpBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', () => {
      shortcuts.classList.remove('open');
      helpBtn.setAttribute('aria-expanded', 'false');
    });
    shortcuts.addEventListener('click', (event) => event.stopPropagation());
  }

  // Raw / Preview, for Markdown
  for (const button of document.querySelectorAll('#fe-editor-panel .fe-editor-toggle-btn')) {
    button.addEventListener('click', () => setPreview(button.dataset.mode === 'preview'));
  }

  // Leaving the page with unsaved text asks first; where the tabs are, and the copies that are due, are written
  // before the page goes whatever the answer.
  const leaving = () => {
    const kept = _session;
    persistTabs();
    // storage.js has sent the page's state off by now (its listener is older than this one, and a window's
    // listeners run in the order they were added): what was just written follows by itself.
    try {
      const value = kept ? storage.getItem(KEYS.EDITOR_TABS) : null;
      if (value && storage.persists !== false) navigator.sendBeacon?.('/api/ui-state', new Blob([JSON.stringify({ [KEYS.EDITOR_TABS]: JSON.parse(value) })], { type: 'application/json' }));
    } catch { /* the debounced write is what is left */ }
    _backups?.flush({ leaving: true });
  };
  createUnloadGuard({ target: window, isDirty: () => [..._docs.values()].some((doc) => doc.loaded && doc.dirty), beforeLeave: leaving }).install();
  window.addEventListener('pagehide', () => { persistTabs(); _backups?.flush({ leaving: true }); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { persistTabs(); _backups?.flush(); }
  });
  // Back in this window: the files may have changed meanwhile.
  window.addEventListener('focus', () => { if (_open) _watcher?.check().catch(() => {}); });

  _prefs.subscribe(applyPreferences);
  applyPreferences();
  // Preferences saved in another window.
  on('sync:editor:config-changed', (message) => { if (message?.config) _prefs.applyRemote(message.config); });

  renderActive();
}
