// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: a workspace
// ═══════════════════════════════════════════
//
// What opens from the Library: a breadcrumb back (the open documents stay), the name with its kind and, for a
// library skill, one status (draft, in review, approved · not installed, installed where: sx-install.js
// installStatus; it opens Publish) and its health only when something is wrong; the actions (Save, more), four tabs
// (Edit · Test · Versions · Publish; Alt+1…4 outside a text field, the arrows on the tab bar) and the banners that
// say what this is: read-only and why, an update SynaBun ships, a folder not in the library yet, a draft not
// installed, a submission in review, and an approved one with "Install for …" (sx-install-flow.js: the plan, one
// question only when the plan asks one, then the install; the banner then says where it went).

import { studioErrorText } from './sx-errors.js';
import { html, setHTML, ICONS } from './sx-dom.js';
import { loadWorkspace, dirtyTabs, saveVersion } from './sx-docs.js';
import { healthCapsule, sourceLabel, statusPill } from './sx-library-view.js';
import { installStatus } from './sx-install.js';
import { reviewTargets, installFlow, flowWords, installBusy, acquireInstall, alsoInstall, alsoInstallNow } from './sx-install-flow.js';
import { changedFiles } from './sx-diff.js';
import { renderEditTab, editShortcut, disposeEditor, forgetEditorWorkspace, saveActive, editTabsDirty, onEditExternalChange } from './sx-edit-view.js';
import { renderVersionsTab } from './sx-versions-view.js';
import { renderPublishTab } from './sx-publish-view.js';
import { renderTestTab, leaveTestTab, testShortcut } from './sx-test-view.js';
import { reviewUpdateFlow } from './sx-review-view.js';
import { customizeCopy, adoptNow, deleteSubject, exportSubject, canDeleteFromLibrary, deleteFromLibrary } from './sx-actions.js';

const TABS = ['edit', 'test', 'versions', 'publish'];
let _menu = null;   // the open "more" menu: { el, button }

/** Close the workspace's own menus (Escape); true when one was open. */
export function closeWorkspaceMenus(panel) {
  if (!_menu) return false;
  const button = _menu.button;
  _menu.el.remove();
  if (_menu.outside) document.removeEventListener('pointerdown', _menu.outside, true);
  _menu = null;
  button?.setAttribute('aria-expanded', 'false');
  if (button?.isConnected && panel?.contains(button)) button.focus({ preventScroll: true });
  return true;
}

/** The workspace closed (the window closed, or the thing was deleted): its editor states go. */
export function disposeWorkspace(ws) {
  for (const tab of ws.tabs || []) { tab.cmState = null; }
  ws.onExternalChange = null;
  forgetEditorWorkspace(ws);
}

/**
 * The window closes: every workspace goes, then the window's one editor (its view, listeners, timers and an image's
 * object URL). Called before the panel is removed, so it cannot ask the page whether the panel is still there.
 */
export function disposeStudio(workspaces) {
  leaveTestTab();
  for (const ws of workspaces) disposeWorkspace(ws);
  disposeEditor();
}

/** A key of the workspace: ⌘/Ctrl+S saves, ⌘/Ctrl+Enter is the tab's main action, Alt+1…4 picks a tab. */
export function workspaceShortcut(e, ctx) {
  const mod = ctx.mac ? e.metaKey : e.ctrlKey;
  const ws = currentWs(ctx);
  if (!ws) return false;
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') { saveActive(ctx, ws); return true; }
  if (e.altKey && !mod && /^Digit[1-4]$/.test(e.code) && !e.target.closest?.('input, textarea, .cm-editor')) {
    switchTab(ctx, ws, TABS[Number(e.code.slice(5)) - 1]);
    return true;
  }
  if (testShortcut(e, ctx, ws)) return true;
  return editShortcut(e, ctx, ws);
}

const currentWs = (ctx) => [...ctx.workspaces.values()].find((w) => w.shown) || null;

function switchTab(ctx, ws, tab) {
  if (!TABS.includes(tab) || ws.tab === tab) return;
  ws.tab = tab;
  ctx.render();
  requestAnimationFrame(() => ctx.panel?.querySelector(`#sx-tab-${tab}`)?.focus());
}

function bannersHTML(ctx, ws) {
  const { t } = ctx;
  const s = ws.subject;
  const row = ws.row;
  const out = [];
  const banner = (kind, icon, text, actions = '') => html`<div class="sx-banner sx-banner--${kind}" role="note">${icon}<span class="sx-banner-text">${text}</span>${actions}</div>`;
  if (ctx.guest) out.push(banner('info', ICONS.lock, t('skillsStudio.ws.banner.guest')));
  else if (s.mode === 'readonly') {
    const reason = s.reason || 'not-writable';
    const words = reason === 'plugin' ? t('skillsStudio.ws.banner.plugin', { plugin: row.pluginId || '' }) : t(`skillsStudio.ws.banner.${reason}`);
    out.push(banner(reason === 'not-text' ? 'warn' : 'info', reason === 'not-text' ? ICONS.warn : ICONS.lock, words,
      s.canCustomize ? html`<button type="button" class="sx-btn" data-ws="customize">${t('skillsStudio.ws.customize')}</button>` : ''));
  } else if (s.mode === 'adopt') {
    out.push(banner('info', ICONS.info, t('skillsStudio.ws.banner.adopt', { path: row.path || '' }),
      html`<button type="button" class="sx-btn" data-ws="adopt">${t('skillsStudio.ws.adoptNow')}</button>`));
  }
  if (row.update && row.source === 'synabun') {
    out.push(banner('update', ICONS.update, t('skillsStudio.ws.banner.update', { name: row.folderName }),
      html`<button type="button" class="sx-btn" data-ws="update-review">${t('skillsStudio.ws.reviewChanges')}</button>
        <button type="button" class="sx-btn" data-ws="update-apply">${t('skillsStudio.ws.update')}</button>
        <button type="button" class="sx-btn sx-btn--ghost" data-ws="update-keep">${t('skillsStudio.ws.keepMine')}</button>`));
  }
  if (s.mode === 'library' && ws.draft && ws.revision) {
    const changes = changedFiles(ws.revision.manifest?.files || [], ws.draft.files || []);
    if (changes.length) {
      out.push(banner('draft', ICONS.draft, ctx.tp('skillsStudio.ws.banner.draftChanged', changes.length),
        html`<button type="button" class="sx-btn" data-ws="save-version">${t('skillsStudio.ws.saveVersion')}</button>
          <button type="button" class="sx-btn" data-ws="go-publish">${t('skillsStudio.ws.publish')}</button>`));
    }
  } else if (s.mode === 'library' && ws.skill && !ws.skill.revisions) {
    out.push(banner('draft', ICONS.draft, t('skillsStudio.ws.banner.newDraft'), html`<button type="button" class="sx-btn" data-ws="go-publish">${t('skillsStudio.ws.publish')}</button>`));
  }
  // Installed for one assistant, not the others in effect: one press adds them (never a second copy of what is there).
  if (!ctx.guest && (ws.skill || row.skill) && row.source !== 'synabun') {
    const status = installStatus({ skill: ws.skill || row.skill, row });
    const also = ['installed', 'outdated'].includes(status?.code) ? alsoInstall(ctx, { skill: ws.skill || row.skill, row }) : { targets: [] };
    if (also.targets.length) {
      const busy = installBusy((ws.skill || row.skill)?.skillId);
      const where = [...new Set(status.where.map((w) => t(`skillsStudio.runtime.${['claude', 'codex', 'opencode', 'agents'].includes(w.runtime) ? w.runtime : 'claude'}`)))].join(' · ');
      out.push(banner('info', ICONS.publish, t('skillsStudio.ws.banner.alsoInstall', { where, targets: also.words }),
        html`<button type="button" class="sx-btn sx-btn--primary" data-ws="also-install" id="sx-ws-also-install"${busy ? ' disabled' : ''} aria-disabled="${busy ? 'true' : 'false'}">${ICONS.publish}<span>${busy ? t('skillsStudio.review.installing') : t('skillsStudio.ws.alsoInstallFor', { targets: also.words })}</span></button>`));
    }
  }
  if (row.review) {
    const status = installStatus({ skill: ws.skill || row.skill, row });
    if (status?.code === 'approved' && !ctx.guest) {
      // Approved, not installed: one press installs it to the targets the submission named (the plan, one question
      // only when it asks one). The label names where it goes, from the very targets the press sends
      // (sx-install-flow.js reviewTargets: the same roots and the same settings); when none of what it named is
      // available here, the banner says so and offers Publish instead of installing elsewhere.
      const dest = reviewTargets(ctx, { review: row.review, skill: ws.skill || row.skill, row });
      const busy = installBusy((ws.skill || row.skill)?.skillId);
      const where = dest.words.join(', ');
      const unavailable = dest.missing.map((m) => t('skillsStudio.review.targetUnavailable', { target: m.words, reason: m.why }));
      const text = unavailable.length
        ? html`<span class="sx-block">${t('skillsStudio.ws.banner.review.approved')}</span><ul class="sx-plain-list sx-banner-lines">${unavailable.map((l) => html`<li class="sx-warn-text">${l}</li>`)}${!dest.targets.length ? html`<li>${t('skillsStudio.review.noDestination')}</li>` : ''}</ul>`
        : t('skillsStudio.ws.banner.review.approved');
      out.push(banner('info', ICONS.review, text,
        html`${dest.targets.length ? html`<button type="button" class="sx-btn sx-btn--primary" data-ws="install-review" id="sx-ws-install"${busy ? ' disabled' : ''} aria-disabled="${busy ? 'true' : 'false'}">${ICONS.publish}<span>${busy ? t('skillsStudio.review.installing') : t('skillsStudio.ws.installFor', { targets: where })}</span></button>`
          : html`<button type="button" class="sx-btn sx-btn--primary" data-ws="go-publish">${t('skillsStudio.review.openPublish')}</button>`}
          <button type="button" class="sx-btn sx-btn--ghost" data-ws="open-review">${t('skillsStudio.ws.openReview')}</button>`));
    } else {
      out.push(banner('info', ICONS.review, t(`skillsStudio.ws.banner.review.${row.review.state}`), html`<button type="button" class="sx-btn" data-ws="open-review">${t('skillsStudio.ws.openReview')}</button>`));
    }
  }
  if (ws.notice) {
    const lines = Array.isArray(ws.notice.lines) ? ws.notice.lines : [];
    out.push(banner(ws.notice.kind || 'info', ws.notice.kind === 'ok' ? ICONS.ok : ws.notice.kind === 'warn' ? ICONS.warn : ICONS.info,
      lines.length ? html`<span class="sx-block">${ws.notice.text}</span><ul class="sx-plain-list sx-banner-lines">${lines.map((l) => html`<li>${l}</li>`)}</ul>` : ws.notice.text,
      html`<button type="button" class="sx-btn sx-btn--ghost" data-ws="dismiss-notice">${t('skillsStudio.dialog.dismiss')}</button>`));
  }
  return out;
}

function headHTML(ctx, ws) {
  const { t } = ctx;
  const row = ws.row;
  const s = ws.subject;
  const src = sourceLabel(row, t);
  const dirty = dirtyTabs(ws).length;
  const kind = row.kind === 'command' ? t('skillsStudio.kind.commandLegacy') : t(`skillsStudio.kind.${row.kind}`);
  // A library skill shows one status (it opens Publish) and its health only when something is wrong; the rest shows
  // where it comes from and its health.
  const status = installStatus({ skill: ws.skill || row.skill, row });
  const worst = row.health[0] || { sev: 'ok' };
  return html`<div class="sx-ws-head">
    <nav class="sx-crumb" aria-label="${t('skillsStudio.ws.breadcrumb')}">
      <button type="button" class="sx-link" data-ws="back">${ICONS.back}<span>${t('skillsStudio.rail.library')}</span></button>
      <span aria-hidden="true">›</span><span aria-current="page">${ws.label}</span>
    </nav>
    <div class="sx-ws-title">
      <h3 class="sx-ws-name" id="sx-ws-name" tabindex="-1">${ws.label}</h3>
      <span class="sx-tag">${kind}</span>
      ${status ? statusPill(status, ctx, { button: s.canPublish ? 'go-publish' : null, id: 'sx-ws-status' }) : html`<span class="sx-tag" title="${src.detail}">${src.label}${src.detail ? html` · ${src.detail}` : ''}</span>`}
      ${!status || worst.sev === 'err' || worst.sev === 'warn' ? healthCapsule(row, t) : ''}
      <span class="sx-spacer"></span>
      ${s.editable ? html`<button type="button" class="sx-btn" data-ws="save" id="sx-save"${dirty ? '' : ' disabled'} aria-keyshortcuts="${ctx.mac ? 'Meta+S' : 'Control+S'}">${t('skillsStudio.ws.save')} <kbd>${ctx.mac ? '⌘S' : 'Ctrl+S'}</kbd></button>` : ''}
      <button type="button" class="sx-icon-btn" data-ws="more" aria-haspopup="menu" aria-expanded="false" aria-label="${t('skillsStudio.ws.more')}" title="${t('skillsStudio.ws.more')}">${ICONS.more}</button>
    </div>
    <div class="sx-tabs" role="tablist" aria-label="${ws.label}">
      ${TABS.map((tab, i) => html`<button type="button" class="sx-tab" role="tab" id="sx-tab-${tab}" aria-controls="sx-tabpanel" aria-selected="${ws.tab === tab ? 'true' : 'false'}" tabindex="${ws.tab === tab ? '0' : '-1'}" data-tab="${tab}" aria-keyshortcuts="Alt+${i + 1}">${t(`skillsStudio.ws.tabs.${tab}`)}${tab === 'edit' && dirty ? html`<span class="sx-dot" role="img" aria-label="${t('skillsStudio.ws.unsaved')}"></span>` : ''}</button>`)}
    </div>
  </div>`;
}

/** Draw a workspace (and read what it holds the first time). */
export function renderWorkspace(host, ctx, ws) {
  for (const w of ctx.workspaces.values()) w.shown = w === ws;
  // A "more" menu open in the drawing before (opened while the workspace was still loading) goes with it: kept, it
  // would stay pointed at markup that is gone, and the next click on More would only close it.
  closeWorkspaceMenus(null);
  // The Test tab's listeners, timers and long polls end with every drawing (drawn again below when it is shown).
  leaveTestTab();
  const { t } = ctx;
  if (!ws.loaded && !ws.loadingPromise) {
    const gen = ctx.gen();
    ws.loadingPromise = loadWorkspace(ws, ctx.api, { ask: (tab) => askRestore(ctx, tab) })
      .catch((err) => { ws.error = err; })
      .finally(() => {
        ws.loadingPromise = null;
        if (!ctx.alive(gen) || !ws.shown) return;
        ctx.render();
      });
  }
  ws.onExternalChange = (event) => onExternalChange(ctx, ws, event);
  setHTML(host, html`<section class="sx-place sx-place--ws" aria-labelledby="sx-ws-name">
    ${headHTML(ctx, ws)}
    <div class="sx-banners" id="sx-banners">${bannersHTML(ctx, ws)}</div>
    <div class="sx-tabpanel" id="sx-tabpanel" role="tabpanel" aria-labelledby="sx-tab-${ws.tab}" tabindex="-1"></div>
  </section>`);
  const panel = host.querySelector('#sx-tabpanel');
  if (ws.error && !ws.loaded) {
    setHTML(panel, html`<div class="sx-empty" role="alert"><h4 class="sx-empty-title">${t('skillsStudio.ws.loadFailed')}</h4><p class="sx-dim">${studioErrorText(ctx.t, ws.error)}</p><button type="button" class="sx-btn" data-ws="retry">${t('skillsStudio.shell.retry')}</button></div>`);
  } else if (!ws.loaded) {
    setHTML(panel, html`<div class="sx-empty" role="status"><p>${t('skillsStudio.ws.loading')}</p></div>`);
  } else if (ws.tab === 'edit') renderEditTab(panel, ctx, ws);
  else if (ws.tab === 'test') renderTestTab(panel, ctx, ws);
  else if (ws.tab === 'versions') renderVersionsTab(panel, ctx, ws);
  else if (ws.tab === 'publish') renderPublishTab(panel, ctx, ws);
  wireHead(host, ctx, ws);
}

/** Only the parts that follow a change (the head's Save state and dirty dots, the banners), not the editor. */
export function refreshWorkspaceChrome(ctx, ws) {
  const host = ctx.panel?.querySelector('#sx-main');
  if (!host || !ws.shown) return;
  const save = host.querySelector('#sx-save');
  if (save) save.disabled = !dirtyTabs(ws).length || !!ws.tabs.find((tb) => tb.saving);
  const editTab = host.querySelector('#sx-tab-edit');
  if (editTab) {
    const dot = editTab.querySelector('.sx-dot');
    if (editTabsDirty(ws) && !dot) {
      const mark = document.createElement('span');
      mark.className = 'sx-dot';
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', ctx.t('skillsStudio.ws.unsaved'));
      editTab.append(mark);
    }
    if (!editTabsDirty(ws) && dot) dot.remove();
  }
  setHTML(host.querySelector('#sx-banners'), html`${bannersHTML(ctx, ws)}`);
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

function onExternalChange(ctx, ws, event) {
  if (!ws.shown) return;
  refreshWorkspaceChrome(ctx, ws);
  onEditExternalChange(ctx, ws, event);
}

function wireHead(host, ctx, ws) {
  const head = host.querySelector('.sx-ws-head');
  const tabs = host.querySelector('.sx-tabs');
  tabs?.addEventListener('keydown', (e) => {
    const btn = e.target.closest?.('.sx-tab');
    if (!btn) return;
    const at = TABS.indexOf(btn.dataset.tab);
    let to = null;
    if (e.key === 'ArrowRight') to = (at + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') to = (at - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = TABS.length - 1;
    if (to === null) return;
    e.preventDefault();
    switchTab(ctx, ws, TABS[to]);
  });
  host.querySelector('.sx-place--ws')?.addEventListener('click', (e) => {
    const tabBtn = e.target.closest?.('.sx-tab');
    if (tabBtn && tabs?.contains(tabBtn)) { switchTab(ctx, ws, tabBtn.dataset.tab); return; }
    const btn = e.target.closest?.('[data-ws]');
    if (!btn || btn.disabled) return;
    onAction(btn.dataset.ws, btn, ctx, ws);
  });
  void head;
}

async function onAction(act, btn, ctx, ws) {
  const { t } = ctx;
  switch (act) {
    case 'back': ctx.goPlace('library'); return;
    case 'retry': ws.error = null; ws.loaded = false; ctx.render(); return;
    case 'save': saveActive(ctx, ws); return;
    case 'go-publish': switchTab(ctx, ws, 'publish'); return;
    case 'more': openMore(btn, ctx, ws); return;
    case 'customize': customizeCopy(ctx, ws); return;
    case 'adopt': adoptNow(ctx, ws); return;
    case 'open-review': ctx.openReview(ws.row.review?.reviewId || null); return;
    case 'install-review': installFromBanner(ctx, ws); return;
    case 'also-install': installAlsoFromBanner(ctx, ws); return;
    case 'dismiss-notice': ws.notice = null; refreshWorkspaceChrome(ctx, ws); return;
    case 'update-review': reviewUpdateFlow(ctx, ws.row, 'review'); return;
    case 'update-apply': reviewUpdateFlow(ctx, ws.row, 'apply'); return;
    case 'update-keep': ctx.keepUpdate(ws.row.folderName, ws.row.update?.upstreamRevisionId); ctx.toast(t('skillsStudio.toast.keptMine', { name: ws.row.folderName })); ctx.render(); return;
    case 'save-version': {
      const gen = ctx.gen();
      if (dirtyTabs(ws).length) { ctx.toast(t('skillsStudio.toast.saveFirst'), 'error'); return; }
      try {
        const out = await saveVersion(ws, ctx.api, { key: ctx.key });
        if (!ctx.alive(gen)) return;
        ctx.toast(out.unchanged ? t('skillsStudio.toast.versionUnchanged') : t('skillsStudio.toast.versionSaved'));
        await ctx.reload();
      } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.toast.versionFailed', { error: studioErrorText(ctx.t, err) }), 'error'); }
      return;
    }
    default: return;
  }
}

function openMore(button, ctx, ws) {
  const { t } = ctx;
  if (_menu) { closeWorkspaceMenus(ctx.panel); return; }
  const s = ws.subject;
  const items = [
    { id: 'export', label: t('skillsStudio.ws.menu.export'), on: !!(s.v1Id || (ws.skill?.latest && ctx.caps.has('export'))) },
    { id: 'customize', label: t('skillsStudio.ws.customize'), on: s.canCustomize },
    { id: 'adopt', label: t('skillsStudio.ws.adoptNow'), on: s.canAdopt },
    { id: 'copy-path', label: t('skillsStudio.ws.menu.copyPath'), on: !!ws.row.path },
    { id: 'close', label: t('skillsStudio.ws.menu.close'), on: true },
    { id: 'delete', label: t('skillsStudio.ws.menu.delete'), on: !ctx.guest && (s.mode === 'inplace' || s.mode === 'adopt') && !!s.v1Id, danger: true },
    // A library skill (made here, or adopted): out of the library. Against an older server it says a restart is needed.
    { id: 'delete-library', label: t('skillsStudio.ws.menu.deleteLibrary'), on: canDeleteFromLibrary(ctx, ws), danger: true },
  ].filter((i) => i.on);
  const el = document.createElement('div');
  el.className = 'sx-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', t('skillsStudio.ws.more'));
  setHTML(el, html`${items.map((i, n) => html`<button type="button" role="menuitem" class="sx-menu-item${i.danger ? ' sx-menu-item--danger' : ''}" data-item="${i.id}" tabindex="${n === 0 ? '0' : '-1'}">${i.label}</button>`)}`);
  button.after(el);
  button.setAttribute('aria-expanded', 'true');
  _menu = { el, button };
  const focusAt = (n) => { const list = [...el.querySelectorAll('[role="menuitem"]')]; const k = (n + list.length) % list.length; list.forEach((b, j) => { b.tabIndex = j === k ? 0 : -1; }); list[k]?.focus(); };
  el.querySelector('[role="menuitem"]')?.focus();
  el.addEventListener('keydown', (e) => {
    const list = [...el.querySelectorAll('[role="menuitem"]')];
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(at + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(at - 1); } else if (e.key === 'Tab') closeWorkspaceMenus(null);
  });
  el.addEventListener('click', async (e) => {
    const item = e.target.closest?.('[data-item]');
    if (!item) return;
    closeWorkspaceMenus(ctx.panel);
    const id = item.dataset.item;
    if (id === 'export') exportSubject(ctx, ws);
    else if (id === 'customize') customizeCopy(ctx, ws);
    else if (id === 'adopt') adoptNow(ctx, ws);
    else if (id === 'copy-path') { try { await navigator.clipboard.writeText(ws.row.path); ctx.toast(t('skillsStudio.toast.pathCopied')); } catch { ctx.toast(ws.row.path); } }
    else if (id === 'close') closeWorkspace(ctx, ws);
    else if (id === 'delete') deleteSubject(ctx, ws);
    else if (id === 'delete-library') deleteFromLibrary(ctx, ws);
  });
  const outside = (e) => { if (_menu && !el.contains(e.target) && e.target !== button && !button.contains(e.target)) closeWorkspaceMenus(null); };
  _menu.outside = outside;   // removed by closeWorkspaceMenus, however the menu closes
  document.addEventListener('pointerdown', outside, true);
}

async function closeWorkspace(ctx, ws) {
  const { t, tp } = ctx;
  const dirty = dirtyTabs(ws);
  if (dirty.length) {
    const answer = await ctx.ask({
      title: t('skillsStudio.dialog.unsavedTitle'),
      lines: [tp('skillsStudio.dialog.unsavedFiles', dirty.length), ...dirty.slice(0, 6).map((tab) => `• ${tab.label}`), t('skillsStudio.dialog.closeWorkspaceKeeps')],
      buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'keep', label: t('skillsStudio.dialog.keepForLater'), kind: 'primary' }],
    });
    if (answer !== 'keep') return;
  }
  ctx.closeWorkspace(ws);
}

/**
 * The banner's Install: the approved version to the targets the submission named, in one go (the plan, one question
 * only when it asks one, then exactly that plan). The banner then says where it went and what a running session
 * needs; Publish starts over from the new state.
 */
/** The banner's "Also install for …": the installed version to the assistants that lack it, in one go. */
async function installAlsoFromBanner(ctx, ws) {
  const gen = ctx.gen();
  const words = await alsoInstallNow(ctx, { skill: ws.skill || ws.row.skill, row: ws.row });
  if (!ctx.alive(gen) || !words) return;
  ws.notice = { kind: words.kind === 'info' ? 'ok' : 'warn', text: words.line, lines: words.lines };
  ctx.toast(words.line, words.kind);
  ctx.announce(words.line);
  ws.pub = null;
  try { ws.skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill; } catch { /* the reload */ }
  await ctx.reload();
}

async function installFromBanner(ctx, ws) {
  const { t } = ctx;
  const review = ws.row.review;
  if (!review || ctx.guest) return;
  const skillId = (ws.skill || ws.row.skill)?.skillId;
  // One install of a skill at a time, from whichever surface: a second press anywhere is refused while it is on its way.
  const release = acquireInstall(skillId);
  if (!release) { ctx.toast(t('skillsStudio.publish.busyElsewhere'), 'error'); return; }
  const gen = ctx.gen();
  let out;
  try {
    const { targets } = reviewTargets(ctx, { review, skill: ws.skill || ws.row.skill, row: ws.row });
    if (!targets.length) { release(); ctx.toast(t('skillsStudio.review.noDestination'), 'error'); switchTab(ctx, ws, 'publish'); return; }
    out = await installFlow(ctx, { revisionId: review.submittedRevisionId, targets, reviewId: review.reviewId });
  } catch (err) { out = { status: 'failed', error: studioErrorText(ctx.t, err) }; }
  finally { release(); }
  if (!ctx.alive(gen)) return;
  const words = flowWords(ctx, out);
  if (words) {
    ws.notice = { kind: words.kind === 'info' ? 'ok' : 'warn', text: words.line, lines: words.lines };
    ctx.toast(words.line, words.kind);
    ctx.announce(words.line);
  }
  if (out.status === 'done') { ws.pub = null; ws.publishReviewId = null; ws.publishRevisionId = null; }
  try { ws.skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill; } catch { /* the reload */ }
  await ctx.reload();
}
