// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Edit tab
// ═══════════════════════════════════════════
//
// Three panes (Files | Document | Details) and a status bar; at a narrow window one pane at a time, picked above
// them. The document is the app's code editor (sx-cm.js over public/shared/editor/), one state per open file; the
// Details pane is the inspector (sx-inspector.js). Files of a skill open in tabs; a binary file opens in a viewer
// (an image is shown, anything else is described), never as text. ⌘/Ctrl+S saves the file on screen; what is typed
// while it saves stays unsaved; a file changed elsewhere since it was opened is never overwritten unasked (Keep
// editing is where the keyboard starts). The preview is the shared Markdown renderer (escaped first, links limited
// to http, https and mailto), Mermaid blocks drawn by the vendored Mermaid in strict mode.

import { studioErrorText } from './sx-errors.js';
import { createFrontmatter } from '../ss-frontmatter.js';
import { toEditing } from '../ss-doc.js';
import { refreshDirty } from '../ss-tabs.js';
import { revealHidden } from '../ss-unicode.js';
import { lintArtifact } from '../ss-lint.js';
import { renderMarkdown } from '../../editor/editor-markdown.js';
import { dropdownHTML, wireDropdowns, setDropdownValue } from '../../cc-dropdown.js';
import { html, raw, setHTML, ICONS, formatBytes, formatNumber, base64Url, fileToBase64, rovingFocus } from './sx-dom.js';
import { createStudioEditor } from './sx-cm.js';
import { HEAD, openFile, saveTab, reloadTab, closeTab, discardTab, dirtyTabs, noteDraft, dropDraft, putFiles, deleteFile, renameFile, isTextFile, changedElsewhere } from './sx-docs.js';
import { documentFacts, fileKind, shortDigest } from './sx-editor-model.js';
import { renderInspector } from './sx-inspector.js';
import { applySnippet } from './sx-snippets.js';
import { refreshWorkspaceChrome } from './sx-workspace-view.js';

// The frontmatter is read with the copy of `yaml` vendored in /vendor/yaml/ (the server reads it with the same package).
const YAML_MODULE = '/vendor/yaml/yaml-2.9.1.min.js';

let _ed = null;           // the editor of the window (one, with a state per document)
let _edLoading = null;
let _edPanel = null;
let _edFailed = null;
let _fm = null;
let _fmLoading = null;
let _ctx = null;          // the views' context of the last drawing
let _shown = null;        // { ws, tab } in the editor now
let _quiet = false;       // a state being put in the view: not an edit
let _inspTimer = 0;
let _statusTimer = 0;
let _life = null;
let _mermaid = null;
let _blobUrl = null;
// The Edit tab on screen → the workspace it shows. A save, a read or a timer of one workspace changes the page only
// while its own Edit is the one drawn: never the tree, the tabs or the status of another skill opened meanwhile.
const _editOf = new WeakMap();

/** Whether `ws`'s Edit tab is the one on screen now. */
function editShows(ctx, ws) {
  const el = ctx?.panel?.querySelector('.sx-edit');
  return !!el && _editOf.get(el) === ws && !!ws.shown && ws.tab === 'edit';
}

function loadFrontmatter() {
  if (_fm) return Promise.resolve(_fm);
  if (!_fmLoading) {
    _fmLoading = import(YAML_MODULE).then((YAML) => (_fm = createFrontmatter(YAML))).catch((err) => { _fmLoading = null; throw err; });
  }
  return _fmLoading;
}

/** The window closed: its editor goes (the view, its listeners, the timers, an image's object URL). */
export function disposeEditor() {
  try { _ed?.destroy(); } catch { /* already gone */ }
  // An editor still loading is destroyed as it arrives (ensureEditor: it is no longer the one being loaded).
  _ed = null; _edLoading = null; _edPanel = null; _shown = null; _edFailed = null; _ctx = null;
  clearTimeout(_inspTimer); clearTimeout(_statusTimer);
  _life?.abort(); _life = null;
  if (_blobUrl) { URL.revokeObjectURL(_blobUrl); _blobUrl = null; }
}

/** A workspace closed (or its skill was deleted): the window's editor no longer shows or follows any of its documents. */
export function forgetEditorWorkspace(ws) {
  if (_shown?.ws !== ws) return;
  _shown = null;
  try { _ed?.clear(); } catch { /* the view is going anyway */ }
}

export const editTabsDirty = (ws) => dirtyTabs(ws).length > 0;

function ensureEditor(ctx) {
  if (_ed && _edPanel === ctx.panel) return Promise.resolve(_ed);
  if (_edPanel !== ctx.panel) { try { _ed?.destroy(); } catch { /* */ } _ed = null; _edLoading = null; }
  if (!_edLoading) {
    const parent = document.createElement('div');
    _edPanel = ctx.panel;
    const loading = createStudioEditor({
      parent, t: ctx.t,
      actions: { save: () => { if (_shown && _ctx) saveDocument(_ctx, _shown.ws, _shown.tab); } },
      onUpdate: (update) => onEditorUpdate(update),
    }).then((ed) => {
      // The window closed (or another opened) while it loaded: destroyed at once, never kept.
      if (_edLoading !== loading) { try { ed.destroy(); } catch { /* */ } throw Object.assign(new Error('The window closed.'), { code: 'closed' }); }
      _ed = ed; _edFailed = null; return ed;
    }).catch((err) => { if (_edLoading === loading) { _edLoading = null; _edFailed = err; } throw err; });
    _edLoading = loading;
  }
  return _edLoading;
}

function onEditorUpdate(update) {
  if (_quiet || !_shown) return;
  const { ws, tab } = _shown;
  tab.cmState = update.state;
  if (!update.docChanged) return;
  tab.content = update.state.doc.toString();
  refreshDirty(tab);
  noteDraft(ws, tab);
  const ctx = _ctx;
  if (!ctx) return;
  markDocTab(ctx, ws, tab);
  refreshWorkspaceChrome(ctx, ws);
  scheduleInspector(ctx, ws);
  scheduleStatus(ctx, ws);
}

// ── Layout ──

const fileLabel = (path) => revealHidden(path === null ? '' : String(path).split('/').pop());

function treeOf(ws) {
  // Folders and files as a nested list, SKILL.md first.
  const root = { dirs: new Map(), files: [] };
  const dirNode = (path) => {
    let node = root;
    for (const part of path.split('/').filter(Boolean)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node === root ? part : `${node.path}/${part}`, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    return node;
  };
  for (const d of ws.dirs || []) dirNode(d);
  for (const f of ws.files || []) {
    if (f.path === null) { root.files.push(f); continue; }
    const parts = f.path.split('/');
    const parent = parts.length > 1 ? dirNode(parts.slice(0, -1).join('/')) : root;
    parent.files.push(f);
  }
  return root;
}

function treeHTML(ctx, ws, node, depth = 0) {
  const { t } = ctx;
  const active = ws.tabs[ws.active];
  const files = node.files.slice().sort((a, b) => (a.path === HEAD ? -1 : b.path === HEAD ? 1 : String(a.path).localeCompare(String(b.path))));
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const canChange = ws.subject.editable && ws.kind === 'skill';
  const fileRow = (f) => {
    const kind = fileKind(f.path || 'x.md', { binary: !!f.binary });
    const tab = ws.tabs.find((tb) => tb.path === f.path);
    const isHead = f.path === HEAD || f.path === null;
    const problems = isHead && ws.lastProblems ? ws.lastProblems.studio.errors.length + ws.lastProblems.studio.warnings.length : 0;
    return html`<li role="none"><div class="sx-tree-row${active && active.path === f.path ? ' is-current' : ''}" style="--depth:${depth}">
      <button type="button" class="sx-tree-item" role="treeitem" data-file="${f.path === null ? '' : f.path}" data-head="${isHead ? '1' : ''}" aria-selected="${active && active.path === f.path ? 'true' : 'false'}" tabindex="-1">
        ${kind.kind === 'image' ? ICONS.image : ICONS.file}<span class="sx-tree-name">${f.path === null ? `${ws.label}.md` : fileLabel(f.path)}</span>
        ${tab?.dirty ? html`<span class="sx-dot" role="img" aria-label="${t('skillsStudio.ws.unsaved')}"></span>` : ''}
        ${problems ? html`<span class="sx-tree-badge sx-tree-badge--warn" aria-label="${ctx.tp('skillsStudio.edit.problemsCount', problems)}">${problems}</span>` : ''}
        ${f.binary || kind.kind === 'image' ? html`<span class="sx-tree-badge">${t(kind.kind === 'image' ? 'skillsStudio.edit.image' : 'skillsStudio.edit.binary')}</span>` : ''}
      </button>
      ${canChange && !isHead ? html`<span class="sx-tree-actions">
        ${ws.subject.mode === 'library' ? html`<button type="button" class="sx-icon-btn sx-icon-btn--sm" data-rename="${f.path}" aria-label="${t('skillsStudio.edit.renameNamed', { name: f.path })}" title="${t('skillsStudio.edit.rename')}">${ICONS.edit}</button>` : ''}
        <button type="button" class="sx-icon-btn sx-icon-btn--sm" data-delete="${f.path}" aria-label="${t('skillsStudio.edit.deleteNamed', { name: f.path })}" title="${t('skillsStudio.edit.delete')}">${ICONS.trash}</button></span>` : ''}
    </div></li>`;
  };
  const dirRow = (d) => html`<li role="none"><div class="sx-tree-row sx-tree-row--dir" style="--depth:${depth}"><span class="sx-tree-item sx-tree-dir" role="treeitem" aria-expanded="true" tabindex="-1">${ICONS.folder}<span class="sx-tree-name">${revealHidden(d.name)}/</span></span></div>
    <ul role="group" class="sx-tree-group">${treeHTML(ctx, ws, d, depth + 1)}</ul></li>`;
  return html`${files.map(fileRow)}${dirs.map(dirRow)}`;
}

function newFileHTML(ctx, ws) {
  const { t } = ctx;
  if (!ws.subject.editable || ws.kind !== 'skill') return '';
  const entries = [
    { value: '', label: t('skillsStudio.edit.newFile'), selected: true, disabled: true },
    { value: 'reference', label: t('skillsStudio.edit.newKind.reference') },
    { value: 'script', label: t('skillsStudio.edit.newKind.script') },
    { value: 'asset', label: t('skillsStudio.edit.newKind.asset') },
    { value: 'other', label: t('skillsStudio.edit.newKind.other') },
  ];
  return html`<div class="sx-tree-tools">
    ${raw(dropdownHTML('sx-new-file', entries, { label: t('skillsStudio.edit.newFile'), classes: 'sx-dd' }))}
    <button type="button" class="sx-btn" data-edit="upload">${ICONS.upload}<span>${t('skillsStudio.edit.upload')}</span></button>
    <input type="file" id="sx-upload-input" hidden>
  </div>`;
}

function docTabsHTML(ctx, ws) {
  const { t } = ctx;
  return html`${ws.tabs.map((tab, i) => html`<div class="sx-doc-tab${i === ws.active ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}" data-doc-index="${i}">
    <button type="button" class="sx-doc-tab-btn" role="tab" aria-selected="${i === ws.active ? 'true' : 'false'}" tabindex="${i === ws.active ? '0' : '-1'}" data-doc="${i}" title="${tab.label}">
      ${tab.dirty ? html`<span class="sx-dot" role="img" aria-label="${t('skillsStudio.ws.unsaved')}"></span>` : ''}<span>${fileLabel(tab.path) || tab.label}</span></button>
    ${tab.path === HEAD || tab.path === null ? '' : html`<button type="button" class="sx-doc-tab-close" data-doc-close="${i}" aria-label="${t('skillsStudio.edit.closeTab', { name: tab.label })}">${ICONS.close}</button>`}
  </div>`)}`;
}

function layoutHTML(ctx, ws) {
  const { t } = ctx;
  const active = ws.tabs[ws.active] || null;
  const md = active && !active.binary && fileKind(active.path || 'x.md').kind === 'markdown';
  const pane = ws.pane || 'doc';
  return html`<div class="sx-edit" data-pane="${pane}">
    <div class="sx-pane-switch" role="group" aria-label="${t('skillsStudio.edit.showPane')}">
      ${['files', 'doc', 'details'].map((p) => html`<button type="button" data-pane-show="${p}" aria-pressed="${pane === p ? 'true' : 'false'}">${t(`skillsStudio.edit.pane.${p}`)}</button>`)}
    </div>
    <div class="sx-panes">
      <aside class="sx-pane sx-pane--files" aria-labelledby="sx-files-h">
        <p class="sx-pane-label" id="sx-files-h">${t('skillsStudio.edit.pane.files')}</p>
        <ul class="sx-tree" role="tree" aria-labelledby="sx-files-h" id="sx-tree">${treeHTML(ctx, ws, treeOf(ws))}</ul>
        ${ws.filesTruncated ? html`<p class="sx-help">${t('skillsStudio.edit.filesTruncated')}</p>` : ''}
        ${newFileHTML(ctx, ws)}
      </aside>
      <section class="sx-pane sx-pane--doc" aria-label="${t('skillsStudio.edit.pane.doc')}">
        <div class="sx-doc-bar">
          <div class="sx-doc-tabs" role="tablist" aria-label="${t('skillsStudio.edit.openFiles')}" id="sx-doc-tabs">${docTabsHTML(ctx, ws)}</div>
          <span class="sx-spacer"></span>
          ${md ? html`<button type="button" class="sx-btn sx-btn--sm" data-edit="preview" aria-pressed="${ws.preview ? 'true' : 'false'}">${ICONS.eye}<span>${t('skillsStudio.edit.preview')}</span></button>` : ''}
          ${active && !active.binary && !active.readOnly ? html`<button type="button" class="sx-btn sx-btn--sm" data-edit="compare" aria-pressed="${ws.compare ? 'true' : 'false'}" title="${t('skillsStudio.edit.compareHelp')}">${ICONS.code}<span>${t('skillsStudio.edit.compare')}</span></button>` : ''}
        </div>
        <div class="sx-doc-body">
          <div class="sx-ed-host" id="sx-ed-host"${active && !active.binary && !ws.preview ? '' : ' hidden'}><p class="sx-help sx-ed-loading" role="status">${t('skillsStudio.edit.loadingEditor')}</p></div>
          <div class="sx-preview" id="sx-preview" tabindex="0" aria-label="${t('skillsStudio.edit.previewLabel')}"${ws.preview && md ? '' : ' hidden'}></div>
          <div class="sx-binary" id="sx-binary"${active?.binary ? '' : ' hidden'}></div>
        </div>
      </section>
      <aside class="sx-pane sx-pane--details" aria-label="${t('skillsStudio.edit.pane.details')}" id="sx-details"></aside>
    </div>
    <div class="sx-statusbar" id="sx-status" role="status" aria-live="polite"></div>
  </div>`;
}

/** Draw the Edit tab of a workspace. */
export function renderEditTab(panel, ctx, ws) {
  _ctx = ctx;
  _life?.abort();
  _life = new AbortController();
  const signal = _life.signal;
  if (_shown && _shown.ws === ws && _ed) _shown.tab.cmScroll = _ed.snapshotScroll();
  setHTML(panel, layoutHTML(ctx, ws));
  _editOf.set(panel.querySelector('.sx-edit'), ws);
  wireEdit(panel, ctx, ws, signal);
  const tree = panel.querySelector('#sx-tree');
  if (tree) rovingFocus(tree, '.sx-tree-item[data-file]', { signal });
  renderStatus(ctx, ws);
  if (!_fm) loadFrontmatter().then(() => { if (_ctx === ctx && editShows(ctx, ws)) { renderDetails(ctx, ws); scheduleStatus(ctx, ws); } }).catch(() => renderDetails(ctx, ws));
  renderDetails(ctx, ws);
  showActive(ctx, ws);
  if (ws.pendingReveal) {
    const { file, line } = ws.pendingReveal;
    ws.pendingReveal = null;
    (async () => {
      if (file && file !== (ws.tabs[ws.active]?.path)) await openDocument(ctx, ws, file);
      if (line) setTimeout(() => _ed?.reveal(line), 60);
    })();
  }
}

async function showActive(ctx, ws) {
  const panel = ctx.panel;
  const tab = ws.tabs[ws.active];
  const host = panel?.querySelector('#sx-ed-host');
  const preview = panel?.querySelector('#sx-preview');
  const binary = panel?.querySelector('#sx-binary');
  if (!host) return;
  if (!tab) { host.hidden = true; return; }
  if (tab.binary) {
    host.hidden = true;
    if (preview) preview.hidden = true;
    renderBinary(binary, ctx, ws, tab);
    _shown = null;
    return;
  }
  if (binary) binary.hidden = true;
  if (ws.preview && preview && fileKind(tab.path || 'x.md').kind === 'markdown') { host.hidden = true; preview.hidden = false; renderPreview(preview, tab.content); }
  else { host.hidden = false; if (preview) preview.hidden = true; }
  const gen = ctx.gen();
  let ed;
  try { ed = await ensureEditor(ctx); } catch (err) {
    if (!ctx.alive(gen)) return;
    mountFallback(host, ctx, ws, tab, err);
    return;
  }
  if (!ctx.alive(gen) || !host.isConnected || ws.tabs[ws.active] !== tab) return;
  host.querySelector('.sx-ed-loading')?.remove();
  if (ed.view.dom.parentElement !== host) host.append(ed.view.dom);
  if (!tab.cmState) tab.cmState = ed.createState({ text: tab.content, readOnly: tab.readOnly || !ws.subject.editable });
  _quiet = true;
  try { ed.show(tab.cmState, { scroll: tab.cmScroll || null }); } finally { _quiet = false; }
  _shown = { ws, tab };
  ed.remeasure();
  if (!tab.cmLanguage) {
    tab.cmLanguage = true;
    ed.language(tab.path || `${ws.label}.md`).then((support) => {
      if (!support || !tab.cmState) return;
      tab.cmState = ed.apply(_shown?.tab === tab ? null : tab.cmState, { effects: ed.effects.language(support) });
    }).catch(() => {});
  }
  const head = tab.path === HEAD || tab.path === null;
  if (head && !tab.cmLint) {
    tab.cmLint = true;
    ed.lintExtension((text) => diagnosticsFor(ws, text)).then((ext) => {
      if (!ext || !tab.cmState) return;
      tab.cmState = ed.apply(_shown?.tab === tab ? null : tab.cmState, { effects: ed.effects.lint(ext) });
    }).catch(() => {});
  }
  if (ws.compare) applyCompare(ctx, ws, tab, true);
}

/** The editor could not load: a plain text box edits the same document (nothing is lost, nothing is shown wrong). */
function mountFallback(host, ctx, ws, tab, err) {
  const { t } = ctx;
  setHTML(host, html`<div class="sx-fallback">
    <p class="sx-note sx-note--warn" role="alert">${t('skillsStudio.edit.editorFailed', { error: studioErrorText(ctx.t, err) })} <button type="button" class="sx-link" data-edit="retry-editor">${t('skillsStudio.shell.retry')}</button></p>
    <label class="sx-sr" for="sx-fallback-text">${tab.label}</label>
    <textarea class="sx-input sx-fallback-text" id="sx-fallback-text" spellcheck="false"${tab.readOnly || !ws.subject.editable ? ' readonly' : ''}>${tab.content}</textarea>
  </div>`);
  const area = host.querySelector('#sx-fallback-text');
  area?.addEventListener('input', () => {
    tab.content = area.value;
    tab.cmState = null;
    refreshDirty(tab);
    noteDraft(ws, tab);
    markDocTab(ctx, ws, tab);
    refreshWorkspaceChrome(ctx, ws);
    scheduleInspector(ctx, ws);
    scheduleStatus(ctx, ws);
  });
  area?.addEventListener('keydown', (e) => { if ((ctx.mac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveDocument(ctx, ws, tab); } });
  host.querySelector('[data-edit="retry-editor"]')?.addEventListener('click', () => { _edFailed = null; showActive(ctx, ws); });
  _shown = null;
}

function diagnosticsFor(ws, text) {
  if (!_fm) return [];
  try {
    const folderName = ws.kind === 'skill' ? (ws.row.folderName || ws.label) : '';
    return lintArtifact({ type: ws.kind, parsed: _fm.parse(text), folderName }).all;
  } catch { return []; }
}

function renderBinary(host, ctx, ws, tab) {
  if (!host) return;
  const { t, locale } = ctx;
  host.hidden = false;
  if (_blobUrl) { URL.revokeObjectURL(_blobUrl); _blobUrl = null; }
  const kind = fileKind(tab.path || '', { binary: true });
  let viewer = html`<span class="sx-binary-icon" aria-hidden="true">${ICONS.file}</span>`;
  if (kind.kind === 'image' && tab.base64) {
    try { _blobUrl = base64Url(tab.base64, kind.mime); viewer = html`<img class="sx-binary-img" src="${_blobUrl}" alt="${t('skillsStudio.edit.imageAlt', { name: tab.label })}">`; } catch { /* described below */ }
  }
  setHTML(host, html`<div class="sx-binary-view" role="group" aria-label="${tab.label}">
    ${viewer}
    <p class="sx-binary-name">${revealHidden(tab.label)}</p>
    <p class="sx-help">${tab.size ? t('skillsStudio.edit.binaryInfo', { size: formatBytes(tab.size, locale) }) : t('skillsStudio.edit.binaryInfoNoSize')}</p>
    ${tab.path === HEAD ? html`<p class="sx-note sx-note--warn" role="note">${t('skillsStudio.edit.binaryHead')}</p>` : ''}
    ${_blobUrl ? html`<a class="sx-btn" href="${_blobUrl}" download="${String(tab.path || 'file').split('/').pop()}">${ICONS.download}<span>${t('skillsStudio.edit.download')}</span></a>` : ''}
  </div>`);
}

function renderPreview(host, text) {
  // The shared renderer escapes the text before it writes a tag, and links only to http, https, mailto and relative
  // targets (a relative one is a file of this skill: wireEdit opens it here).
  setHTML(host, raw(`<div class="sx-md">${renderMarkdown(text)}</div>`));
  const blocks = host.querySelectorAll('pre > code.lang-mermaid');
  if (!blocks.length) return;
  (async () => {
    try {
      if (!_mermaid) {
        // The copy vendored in /vendor/mermaid/ (tests/vendored-markdown-libs.test.mjs reads this literal path).
        const mod = await import('/vendor/mermaid/mermaid-11.17.2.esm.min.mjs');
        _mermaid = mod.default;
        _mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      }
      let n = 0;
      for (const code of blocks) {
        const source = code.textContent || '';
        try {
          const { svg } = await _mermaid.render(`sx-mmd-${Date.now().toString(36)}-${n++}`, source);
          const box = document.createElement('div');
          box.className = 'sx-mermaid';
          box.innerHTML = svg;   // Mermaid in strict mode sanitises what it draws
          code.parentElement.replaceWith(box);
        } catch { /* the code block stays as it is */ }
      }
    } catch { /* Mermaid could not load: the code blocks stay */ }
  })();
}

function renderDetails(ctx, ws) {
  const host = ctx.panel?.querySelector('#sx-details');
  if (!host || !editShows(ctx, ws)) return;
  const head = ws.tabs.find((tb) => tb.path === HEAD || tb.path === null) || null;
  const active = ws.tabs[ws.active] || null;
  renderInspector(host, {
    ctx, ws, fm: _fm, head,
    headShowing: !!head && active === head,
    knownNames: ctx.rows.filter((r) => r.source === 'synabun').map((r) => r.folderName),
    replaceHead: (next, o = {}) => replaceDocumentText(ctx, ws, head, next, o),
    reveal: (line) => setTimeout(() => _ed?.reveal(line), 30),
    openHead: () => { const at = ws.tabs.indexOf(head); if (at >= 0 && at !== ws.active) switchDocument(ctx, ws, at); },
    caret: () => (_shown?.tab === active && _ed ? _ed.caret() : null),
    insertSnippet: (snippet) => insertSnippet(ctx, ws, snippet),
  });
}

function scheduleInspector(ctx, ws) {
  if (!editShows(ctx, ws)) return;   // another skill's Edit keeps its own timer
  clearTimeout(_inspTimer);
  const gen = ctx.gen();
  _inspTimer = setTimeout(() => {
    if (!ctx.alive(gen) || !editShows(ctx, ws)) return;
    const host = ctx.panel?.querySelector('#sx-details');
    // A field being typed in is not redrawn under the cursor: the rest follows when it is left.
    if (host && host.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    renderDetails(ctx, ws);
    const tree = ctx.panel?.querySelector('#sx-tree');
    if (tree) setHTML(tree, treeHTML(ctx, ws, treeOf(ws)));
  }, 300);
}

function scheduleStatus(ctx, ws) {
  if (!editShows(ctx, ws)) return;   // another skill's Edit keeps its own timer
  clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => renderStatus(ctx, ws), 120);
}

function renderStatus(ctx, ws) {
  const host = ctx.panel?.querySelector('#sx-status');
  if (!host || !editShows(ctx, ws)) return;
  const { t, locale } = ctx;
  const tab = ws.tabs[ws.active];
  if (!tab) { setHTML(host, ''); return; }
  const facts = documentFacts({ path: tab.path, text: tab.content, eol: tab.eol, mixed: tab.mixedEol, bom: tab.bom, binary: tab.binary, size: tab.size, head: (tab.path === HEAD) });
  const kindWord = t(`skillsStudio.edit.kind.${facts.kind}`);
  const state = tab.saving ? t('skillsStudio.edit.state.saving') : tab.dirty ? t('skillsStudio.edit.state.unsaved')
    : tab.readOnly || !ws.subject.editable ? t('skillsStudio.edit.state.readOnly')
    : ws.subject.mode === 'library' ? t('skillsStudio.edit.state.draftSaved') : t('skillsStudio.edit.state.saved');
  const rev = ws.subject.mode === 'library' ? (ws.revision ? t('skillsStudio.edit.revision', { id: shortDigest(ws.revision.contentDigest) }) : t('skillsStudio.edit.noVersion')) : (tab.saved.revision ? t('skillsStudio.edit.fileRevision', { id: shortDigest(tab.saved.revision) }) : '');
  const parts = [
    html`<span>${fileLabel(tab.path) || tab.label}</span>`,
    html`<span>${kindWord}</span>`,
    facts.binary ? '' : html`<span>${facts.eol}${facts.bom ? ' · BOM' : ''}</span>`,
    facts.binary ? '' : html`<span>${ctx.tp('skillsStudio.edit.lines', facts.lines, { n: formatNumber(facts.lines, locale) })}</span>`,
    facts.binary ? '' : html`<span title="${t('skillsStudio.edit.tokensHelp')}">${t('skillsStudio.edit.tokens', { n: formatNumber(facts.tokens, locale) })}</span>`,
    facts.guidance ? html`<span class="sx-guidance${facts.guidance.over ? ' is-over' : ''}" title="${t('skillsStudio.edit.guidanceHelp', { lines: facts.guidance.maxLines, tokens: formatNumber(facts.guidance.maxTokens, locale) })}"><span class="sx-meter" aria-hidden="true"><i style="width:${Math.round(facts.guidance.ratio * 100)}%"></i></span>${t('skillsStudio.edit.guidance', { tokens: formatNumber(facts.guidance.tokens, locale), max: formatNumber(facts.guidance.maxTokens, locale) })}</span>` : '',
    html`<span>${formatBytes(facts.bytes, locale)}</span>`,
    html`<span class="sx-state">${state}</span>`,
    rev ? html`<span>${rev}</span>` : '',
  ];
  setHTML(host, html`${parts}`);
}

function markDocTab(ctx, ws, tab) {
  const bar = ctx.panel?.querySelector('#sx-doc-tabs');
  if (!bar || !editShows(ctx, ws)) return;
  const at = ws.tabs.indexOf(tab);
  const el = bar.querySelector(`[data-doc-index="${at}"]`);
  if (!el) return;
  const was = el.classList.contains('is-dirty');
  if (was === tab.dirty) return;
  setHTML(bar, docTabsHTML(ctx, ws));
}

// ── Documents ──

function switchDocument(ctx, ws, index) {
  if (index === ws.active || index < 0 || index >= ws.tabs.length) return;
  if (_shown && _shown.ws === ws && _ed) _shown.tab.cmScroll = _ed.snapshotScroll();
  ws.active = index;
  ws.compare = false;
  ctx.render();
}

async function openDocument(ctx, ws, path) {
  const gen = ctx.gen();
  try {
    await openFile(ws, path, ctx.api, { ask: (tab) => askRestore(ctx, tab) });
  } catch (err) {
    if (!ctx.alive(gen)) return;
    const words = err.code === 'needs-restart' ? ctx.t('skillsStudio.edit.needsRestart')
      : err.code === 'needs-library' ? ctx.t('skillsStudio.edit.needsLibrary')
      : ctx.t('skillsStudio.edit.openFailed', { file: path, error: studioErrorText(ctx.t, err) });
    ctx.toast(words, 'error');
    return;
  }
  // The workspace it was opened for is shown again only when its Edit is still the one on screen.
  if (!ctx.alive(gen) || !editShows(ctx, ws)) return;
  ws.compare = false;
  ctx.render();
}

async function askRestore(ctx, tab) {
  const { t } = ctx;
  const answer = await ctx.ask({
    title: t('skillsStudio.dialog.restoreTitle'),
    lines: [t('skillsStudio.dialog.restoreChanged', { file: tab.label })],
    buttons: [{ id: 'drop', label: t('skillsStudio.dialog.restoreDrop'), kind: 'danger' }, { id: 'restore', label: t('skillsStudio.dialog.restorePut'), kind: 'primary' }],
    cancelId: null,
  });
  return answer === 'restore';
}

/** Change a document's whole text (a form field, a snippet): through the editor when it shows, one undo step. */
function replaceDocumentText(ctx, ws, tab, next, { caret = null } = {}) {
  if (!tab || tab.readOnly) return;
  if (_shown?.tab === tab && _ed) { _ed.replaceText(next, { caret }); return; }
  tab.content = next;
  tab.cmState = null;   // made again from the text when it shows
  refreshDirty(tab);
  noteDraft(ws, tab);
  markDocTab(ctx, ws, tab);
  refreshWorkspaceChrome(ctx, ws);
  scheduleInspector(ctx, ws);
}

async function insertSnippet(ctx, ws, snippet) {
  const { t } = ctx;
  const active = ws.tabs[ws.active];
  const head = ws.tabs.find((tb) => tb.path === HEAD || tb.path === null);
  const target = snippet.kind === 'frontmatter' ? head : active;
  if (!target || target.readOnly || target.binary) return;
  if (snippet.kind === 'frontmatter' && active !== head) { ctx.toast(t('skillsStudio.snippets.openHeadFirst'), 'error'); return; }
  const caret = _shown?.tab === target && _ed ? _ed.caret() : null;
  if (snippet.kind === 'frontmatter' && !_fm) { try { await loadFrontmatter(); } catch { ctx.toast(t('skillsStudio.snippets.failed.other'), 'error'); return; } }
  // A frontmatter snippet is keys merged by the one-key patch; a body snippet goes in at the caret.
  const res = applySnippet(target.content, snippet, { caret, fm: _fm });
  if (!res.ok) { ctx.toast(t(`skillsStudio.snippets.failed.${['invalid', 'unsupported', 'alias'].includes(res.reason) ? 'yaml' : 'other'}`), 'error'); return; }
  replaceDocumentText(ctx, ws, target, res.text, { caret: res.caret });
  ctx.announce(t('skillsStudio.snippets.inserted', { name: snippet.custom ? snippet.name : t(`skillsStudio.snippets.${snippet.id}.name`) }));
  _ed?.focus();
}

// ── Saving ──

/** Save the document on screen (⌘/Ctrl+S, the Save button). */
export function saveActive(ctx, ws) {
  const tab = ws.tabs[ws.active];
  if (tab) saveDocument(ctx, ws, tab);
}

export async function saveDocument(ctx, ws, tab, { over = null } = {}) {
  const { t } = ctx;
  if (!tab || tab.binary || tab.readOnly || !ws.subject.editable) return false;
  if (!tab.dirty && !over) { ctx.announce(t('skillsStudio.toast.nothingToSave')); return true; }
  const gen = ctx.gen();
  const wasAdopt = ws.subject.mode === 'adopt';
  const pending = saveTab(ws, tab, ctx.api, { over, key: ctx.key });
  refreshWorkspaceChrome(ctx, ws);
  scheduleStatus(ctx, ws);
  let res;
  try { res = await pending; } catch (err) {
    if (ctx.alive(gen)) { ctx.toast(t('skillsStudio.toast.saveFailed', { file: tab.label, error: studioErrorText(ctx.t, err) }), 'error'); refreshWorkspaceChrome(ctx, ws); scheduleStatus(ctx, ws); }
    return false;
  }
  if (!ctx.alive(gen)) return res.status === 'saved';
  // The saved document's workspace may not be the one on screen any more (another skill was opened while it saved):
  // the toast says what happened; its tree, tabs and status are drawn only into its own Edit.
  refreshWorkspaceChrome(ctx, ws);
  scheduleStatus(ctx, ws);
  if (res.status === 'saved') {
    const errors = (res.diagnostics || []).filter((d) => d.severity === 'error').length;
    const msg = res.stillDirty ? t('skillsStudio.toast.savedTypedSince', { file: tab.label })
      : errors ? ctx.tp('skillsStudio.toast.savedWithProblems', errors, { file: tab.label })
      : ws.subject.mode === 'library' ? t('skillsStudio.toast.savedDraft', { file: tab.label }) : t('skillsStudio.toast.saved', { file: tab.label });
    ctx.toast(msg, errors ? 'error' : 'info');
    ctx.announce(msg);
    if (_ed && _shown?.tab === tab) _ed.apply(null, { effects: _ed.effects.saved() });
    if (wasAdopt && ws.subject.mode === 'library') { if (ws.shown) ctx.render(); ctx.reload(); }
    else if (editShows(ctx, ws)) {
      const tree = ctx.panel?.querySelector('#sx-tree');
      if (tree) setHTML(tree, treeHTML(ctx, ws, treeOf(ws)));
      const bar = ctx.panel?.querySelector('#sx-doc-tabs');
      if (bar) setHTML(bar, docTabsHTML(ctx, ws));
    }
    return true;
  }
  if (res.status === 'unchanged') return true;
  return resolveConflict(ctx, ws, tab, res);
}

/** A save found the file changed (or removed) elsewhere: keep editing, take theirs, or write mine over it. */
async function resolveConflict(ctx, ws, tab, res) {
  const { t } = ctx;
  const gone = res.status === 'gone';
  const buttons = gone
    ? [{ id: 'cancel', label: t('skillsStudio.dialog.keepEditing') }, ...(ws.subject.mode === 'inplace' ? [] : [{ id: 'overwrite', label: t('skillsStudio.dialog.recreate'), kind: 'primary' }])]
    : [{ id: 'cancel', label: t('skillsStudio.dialog.keepEditing') }, { id: 'reload', label: t('skillsStudio.dialog.loadTheirs'), kind: 'danger' }, { id: 'overwrite', label: t('skillsStudio.dialog.overwriteMine'), kind: 'primary' }];
  const answer = await ctx.ask({
    title: t(gone ? 'skillsStudio.dialog.goneTitle' : 'skillsStudio.dialog.conflictTitle'),
    lines: [t(gone ? 'skillsStudio.dialog.goneBody' : 'skillsStudio.dialog.conflictBody', { file: tab.label }), t('skillsStudio.dialog.stillHere')],
    buttons,
    focus: 'cancel',
  });
  if (answer === 'overwrite') return saveDocument(ctx, ws, tab, { over: res.current || 'absent' });
  if (answer === 'reload') {
    const gen = ctx.gen();
    try { await reloadTab(ws, tab, ctx.api); } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.toast.reloadFailed', { error: studioErrorText(ctx.t, err) }), 'error'); return false; }
    tab.cmState = null; tab.cmLanguage = false; tab.cmLint = false;
    if (ctx.alive(gen) && editShows(ctx, ws)) ctx.render();
  }
  return false;
}

/** Ask what happens to a document's unsaved text before it closes. @returns {Promise<boolean>} it may close */
async function settleTab(ctx, ws, tab) {
  if (!tab.dirty) return true;
  const { t } = ctx;
  const answer = await ctx.ask({
    title: t('skillsStudio.dialog.unsavedTitle'),
    lines: [t('skillsStudio.dialog.unsavedOne', { file: tab.label })],
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'discard', label: t('skillsStudio.dialog.discard'), kind: 'danger' }, { id: 'save', label: t('skillsStudio.dialog.save'), kind: 'primary' }],
    focus: 'cancel',
  });
  if (answer === 'save') return saveDocument(ctx, ws, tab);
  if (answer === 'discard') { discardTab(ws, tab); return true; }
  return false;
}

// ── Files ──

const STARTERS = {
  reference: (n) => ({ path: `references/${n}.md`, content: `# ${n}\n\n` }),
  script: (n) => ({ path: `scripts/${n}.sh`, content: '#!/usr/bin/env bash\nset -euo pipefail\n\n', executable: true }),
  asset: (n) => ({ path: `assets/${n}`, content: '' }),
  other: (n) => ({ path: n, content: '' }),
};

function pathProblem(path, ws) {
  const p = String(path || '').trim();
  if (!p) return 'required';
  if (p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '.' || s === '')) return 'invalid';
  if (p.split('/').some((s) => s.startsWith('.'))) return 'hidden';
  if ((ws.files || []).some((f) => f.path && f.path.toLowerCase() === p.toLowerCase())) return 'exists';
  return null;
}

async function askName(ctx, { title, label, value, ws }) {
  const { t } = ctx;
  const box = document.createElement('div');
  box.className = 'sx-dlg-form';
  const lab = document.createElement('label');
  lab.className = 'sx-field-label';
  lab.htmlFor = 'sx-name-input';
  lab.textContent = label;
  const input = document.createElement('input');
  input.id = 'sx-name-input';
  input.className = 'sx-input';
  input.value = value;
  input.autocomplete = 'off';
  input.spellcheck = false;
  const err = document.createElement('p');
  err.className = 'ss-dlg-error';
  err.setAttribute('role', 'alert');
  box.append(lab, input, err);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  let chosen = null;
  const answer = await ctx.ask({
    title, extra: box,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'ok', label: t('skillsStudio.dialog.ok'), kind: 'primary' }],
    accept: (id) => {
      if (id !== 'ok') return true;
      const why = pathProblem(input.value, ws);
      if (why) { err.textContent = t(`skillsStudio.edit.pathProblem.${why}`); return false; }
      chosen = input.value.trim();
      return true;
    },
  });
  return answer === 'ok' ? chosen : null;
}

async function newFile(ctx, ws, kind) {
  const { t } = ctx;
  const make = STARTERS[kind] || STARTERS.other;
  const suggestion = make(kind === 'other' ? 'notes.md' : kind === 'asset' ? 'template.txt' : kind === 'script' ? 'run' : 'guide');
  const path = await askName(ctx, { title: t('skillsStudio.edit.newFileTitle'), label: t(`skillsStudio.edit.newFileLabel.${kind}`), value: suggestion.path, ws });
  if (!path) return;
  const gen = ctx.gen();
  try {
    await putFiles(ws, [{ path, content: kind === 'script' ? STARTERS.script('x').content : (kind === 'reference' && path.endsWith('.md') ? `# ${path.split('/').pop().replace(/\.md$/, '')}\n\n` : ''), executable: kind === 'script' }], ctx.api, { key: ctx.key });
  } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.edit.createFailed', { error: studioErrorText(ctx.t, err) }), 'error'); return; }
  if (!ctx.alive(gen)) return;
  ctx.toast(t('skillsStudio.edit.created', { file: path }));
  await openDocument(ctx, ws, path);
}

async function uploadFile(ctx, ws, file) {
  const { t } = ctx;
  const path = await askName(ctx, { title: t('skillsStudio.edit.uploadTitle'), label: t('skillsStudio.edit.uploadLabel'), value: file.name, ws });
  if (!path) return;
  const gen = ctx.gen();
  try {
    const { base64, bytes } = await fileToBase64(file);
    const item = isTextFile(bytes) ? { path, content: new TextDecoder().decode(bytes) } : { path, contentBase64: base64 };
    await putFiles(ws, [item], ctx.api, { key: ctx.key });
  } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.edit.uploadFailed', { error: studioErrorText(ctx.t, err) }), 'error'); return; }
  if (!ctx.alive(gen)) return;
  ctx.toast(t('skillsStudio.edit.uploaded', { file: path }));
  await openDocument(ctx, ws, path);
}

async function removeFile(ctx, ws, path) {
  const { t } = ctx;
  const open = ws.tabs.find((tb) => tb.path === path);
  const unsaved = !!open?.dirty;
  const answer = await ctx.ask({
    title: t('skillsStudio.edit.deleteTitle', { file: path }),
    lines: [t(ws.subject.mode === 'library' ? 'skillsStudio.edit.deleteFromDraft' : 'skillsStudio.edit.deleteAdopt'), ...(unsaved ? [t('skillsStudio.edit.deleteUnsaved')] : [])],
    buttons: unsaved
      ? [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'keep', label: t('skillsStudio.edit.deleteKeep') }, { id: 'delete', label: t('skillsStudio.edit.deleteDiscard'), kind: 'danger' }]
      : [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'delete', label: t('skillsStudio.edit.delete'), kind: 'danger' }],
    focus: 'cancel',
  });
  if (answer !== 'delete' && answer !== 'keep') return;
  const gen = ctx.gen();
  try { await deleteFile(ws, path, ctx.api, { key: ctx.key }); } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.edit.deleteFailed', { error: studioErrorText(ctx.t, err) }), 'error'); return; }
  if (open) {
    if (answer === 'keep' && open.dirty) {
      // The text stays open, unsaved: the next save puts the file back.
      open.saved = { raw: open.saved.raw, revision: null };
      refreshDirty(open);
      noteDraft(ws, open);
    } else { dropDraft(ws, open); closeTab(ws, open); }
  }
  if (!ctx.alive(gen)) return;
  ctx.toast(answer === 'keep' && open ? t('skillsStudio.edit.deletedKept', { file: path }) : t('skillsStudio.edit.deleted', { file: path }));
  if (editShows(ctx, ws)) ctx.render();
}

async function renameDraftFile(ctx, ws, from) {
  const { t } = ctx;
  const to = await askName(ctx, { title: t('skillsStudio.edit.renameTitle', { file: from }), label: t('skillsStudio.edit.renameLabel'), value: from, ws });
  if (!to || to === from) return;
  const gen = ctx.gen();
  try { await renameFile(ws, from, to, ctx.api, { key: ctx.key }); } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.edit.renameFailed', { error: studioErrorText(ctx.t, err) }), 'error'); return; }
  if (!ctx.alive(gen)) return;
  ctx.toast(t('skillsStudio.edit.renamed', { from, to }));
  if (editShows(ctx, ws)) ctx.render();
}

async function applyCompare(ctx, ws, tab, on) {
  if (!_ed || _shown?.tab !== tab) return;
  if (!on) { tab.cmState = _ed.apply(null, { effects: _ed.effects.compare(null) }); return; }
  const ext = await _ed.compareExtension(toEditing(tab.saved.raw).text, ctx.t('skillsStudio.edit.revertChange'));
  if (!ext || _shown?.tab !== tab || !ws.compare) return;
  tab.cmState = _ed.apply(null, { effects: _ed.effects.compare(ext) });
}

function wireEdit(panel, ctx, ws, signal) {
  wireDropdowns(panel, { signal });
  // Escape in the text: the editor's own layers first (its search bar, a completion list, a problem's tooltip); with
  // none open, out of the text to the file's tab, so the next Escape reaches the window. (The shared editor keeps
  // its keys from the page, so without this Escape would do nothing there, and the keyboard could not leave it.)
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const ed = e.target.closest?.('.cm-editor');
    if (!ed || !panel.contains(ed) || ed.querySelector('.cm-search, .cm-tooltip-autocomplete, .cm-tooltip-lint')) return;
    e.preventDefault();
    e.stopPropagation();
    (panel.querySelector('.sx-doc-tab-btn[aria-selected="true"]') || ctx.panel)?.focus({ preventScroll: true });
  }, { capture: true, signal });
  // A link of the preview to a file of this skill (`references/guide.md`, relative to the file shown) opens it in its
  // tab; a web or mail link opens outside as it is.
  panel.addEventListener('click', (e) => {
    const a = e.target.closest?.('#sx-preview a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#') || href.startsWith('/')) return;
    e.preventDefault();
    const parts = String(ws.tabs[ws.active]?.path || HEAD).split('/').slice(0, -1);
    try {
      for (const seg of href.split(/[?#]/)[0].split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') parts.pop(); else parts.push(decodeURIComponent(seg));
      }
    } catch { /* a malformed escape: no such file */ }
    const path = parts.join('/');
    if ((ws.files || []).some((f) => f.path === path)) openDocument(ctx, ws, path);
    else ctx.toast(ctx.t('skillsStudio.edit.linkMissing', { file: path || href }), 'error');
  }, { signal });
  panel.querySelector('#sx-new-file')?.addEventListener('change', (e) => {
    const kind = e.target.value;
    setDropdownValue(e.target, '');
    if (kind) newFile(ctx, ws, kind);
  }, { signal });
  const upload = panel.querySelector('#sx-upload-input');
  upload?.addEventListener('change', () => { const f = upload.files?.[0]; upload.value = ''; if (f) uploadFile(ctx, ws, f); }, { signal });
  panel.addEventListener('click', async (e) => {
    const t = e.target;
    const paneBtn = t.closest?.('[data-pane-show]');
    if (paneBtn) { ws.pane = paneBtn.dataset.paneShow; panel.querySelector('.sx-edit').dataset.pane = ws.pane; panel.querySelectorAll('[data-pane-show]').forEach((b) => b.setAttribute('aria-pressed', b === paneBtn ? 'true' : 'false')); if (ws.pane === 'doc') _ed?.remeasure(); return; }
    const fileBtn = t.closest?.('.sx-tree-item[data-file]');
    if (fileBtn) { const path = fileBtn.dataset.head && ws.kind !== 'skill' ? null : fileBtn.dataset.file; const at = ws.tabs.findIndex((tb) => tb.path === path); if (at >= 0) switchDocument(ctx, ws, at); else await openDocument(ctx, ws, path); if (ws.pane === 'files') { ws.pane = 'doc'; } return; }
    const del = t.closest?.('[data-delete]');
    if (del) { removeFile(ctx, ws, del.dataset.delete); return; }
    const ren = t.closest?.('[data-rename]');
    if (ren) { renameDraftFile(ctx, ws, ren.dataset.rename); return; }
    const docBtn = t.closest?.('[data-doc]');
    if (docBtn) { switchDocument(ctx, ws, Number(docBtn.dataset.doc)); return; }
    const closeBtn = t.closest?.('[data-doc-close]');
    if (closeBtn) {
      const tab = ws.tabs[Number(closeBtn.dataset.docClose)];
      if (tab && await settleTab(ctx, ws, tab) && ws.tabs.includes(tab)) { closeTab(ws, tab); if (editShows(ctx, ws)) ctx.render(); }
      return;
    }
    const act = t.closest?.('[data-edit]')?.dataset.edit;
    if (act === 'upload') upload?.click();
    else if (act === 'preview') { ws.preview = !ws.preview; ctx.render(); }
    else if (act === 'compare') { ws.compare = !ws.compare; t.closest('[data-edit]').setAttribute('aria-pressed', ws.compare ? 'true' : 'false'); applyCompare(ctx, ws, ws.tabs[ws.active], ws.compare); }
  }, { signal });
  const docTabs = panel.querySelector('#sx-doc-tabs');
  docTabs?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const at = ws.active + (e.key === 'ArrowRight' ? 1 : -1);
    if (at < 0 || at >= ws.tabs.length) return;
    e.preventDefault();
    switchDocument(ctx, ws, at);
    requestAnimationFrame(() => ctx.panel?.querySelector(`[data-doc="${at}"]`)?.focus());
  }, { signal });
}

/** Keys of the Edit tab beyond the editor's own: none today (⌘/Ctrl+S is handled by the workspace). */
export function editShortcut() { return false; }

/** A change made elsewhere (another window, the Assistant): an open document whose file changed says so, once. */
export async function onEditExternalChange(ctx, ws, event) {
  const { t } = ctx;
  if (ws.subject.mode === 'library' && ws.draft && (!event.skillId || event.skillId === ws.skill?.skillId)) {
    const gen = ctx.gen();
    let draft;
    try { draft = (await ctx.api.fetchSkillsDraft(ws.draft.draftId)).draft; } catch { return; }
    if (!ctx.alive(gen)) return;
    for (const path of changedElsewhere(ws, draft)) {
      const key = `${draft.etag}:${path}`;
      if (ws.seenElsewhere.has(key)) continue;
      ws.seenElsewhere.add(key);
      ctx.toast(t('skillsStudio.toast.changedElsewhere', { file: path }));
    }
    return;
  }
  if (ws.subject.mode === 'inplace' && typeof event.artifactId === 'string' && event.artifactId === ws.subject.v1Id && typeof event.revision === 'string') {
    const tab = ws.tabs[0];
    if (tab && !tab.saving && tab.saved.revision && tab.saved.revision !== event.revision && !ws.seenElsewhere.has(event.revision)) {
      ws.seenElsewhere.add(event.revision);
      ctx.toast(t('skillsStudio.toast.changedElsewhere', { file: tab.label }));
    }
  }
}
