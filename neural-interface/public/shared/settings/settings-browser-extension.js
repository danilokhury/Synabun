// Settings → Browser → "My browser · use the extension" (docs/browser-extension-bridge.md; the design handoff of
// 2026-11-27): which installed browser to set up, a status that says how far that browser got (Not set up → Extension
// detected → Allow user scripts → Ready in <Browser>, plus the stops in between), the agent access, the tabs agents
// hold with an immediate Take back, and the rest behind one Advanced disclosure. The setup itself is a six-step guide
// drawn in this same Settings page (extensionGuideHTML): one browser action per page, SynaBun's side of each action
// done here (the browser's Extensions page opened, the verified folder prepared and shown on request), and the next
// page chosen by what the extension reports, never by a socket alone (settings-extension-guide.js decides).
//
// Layout: the card is one row of the Browser group (`.stg-field`, for the group's row spacing and hairline), but it
// never has a label, an input or a compact control as a DIRECT child: the Settings rule for a compact control
// (`.stg-field:has(> input[type="number"])`) would turn the whole card into a two-column grid (styles.css, "Fields:
// label, control, one-line help"). Each part is a block of its own.
//
// Owner-only and never silent: the agent access is confirmed both ways (POST /api/browser/extension/mode), Disconnect,
// Revoke pairing and Repair are confirmed, Take back is immediate and never closes the tab. Choosing a browser here
// changes which browser the guide sets up and nothing else: never the AI browser profile, never the agent access.
// Dropdowns are the app's .cc-dropdown (the mode: Settings' .stg-dropdown wiring; the browser pickers: cc-dropdown.js
// wireDropdowns on their own containers). No native select, no new palette.
import { beginExtensionUpdateRead } from '../browser-extension-updates.js';
import { dropdownHTML, wireDropdowns } from '../cc-dropdown.js';
import { extensionUpdateHTML, wireExtensionUpdate } from './settings-extension-update.js';
import { guideFigure } from './settings-extension-diagrams.js';
import {
  GUIDE_STEPS, READY_STEP, GUIDE_STORE_KEY, branchStep, entryStep, extensionStage, osOf, pasteKeys, pickTarget, readGuideStore,
  readyChecks, shortName, stageView, writeGuideStore, developerLayout,
} from './settings-extension-guide.js';

const SYMBOL = {
  ok: '<path d="m5 12 4 4 10-10"></path>',
  warn: '<path d="M9 5v14M15 5v14"></path>',
  err: '<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01"></path>',
  off: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"></path>',
  sync: '<path d="M20 7a9 9 0 0 0-15-1L2 9m0-6v6h6M4 17a9 9 0 0 0 15 1l3-3m0 6v-6h-6"></path>',
};
const CHEVRON = '<svg class="cc-section-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const ARROW = '<svg class="cc-dropdown-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const ICON = {
  left: '<path d="m14 6-6 6 6 6"/>', open: '<path d="M13 4h7v7m0-7-10 10M10 6H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V4H4v12h4"/>', folder: '<path d="M3 7V5h7l2 2h9v12H3z"/>',
  good: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>', pending: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>', browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-9v.2"/>',
};
const icon = name => `<svg class="bc-guide-icon" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
// SynaBun's two-bar mark, drawn (never a raster): the product row and the extension card in the drawings.
const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9h10M7 15h10"></path></svg>';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function extensionSettingsHTML(kit) {
  const t = key => kit.te(`browserExtension.${key}`);
  const c = key => kit.te(`browserExtension.card.${key}`);
  const button = (action, key, extra = '') => `<button type="button" class="cli-detect-btn" data-extension-action="${action}"${extra}>${t(key)}</button>`;
  const cardButton = (action, key, extra = '') => `<button type="button" class="cli-detect-btn" data-extension-action="${action}"${extra}>${c(key)}</button>`;
  const modes = [['full', t('modeFull')], ['restricted', t('modeRestricted')]];
  const symbols = Object.entries(SYMBOL).map(([name, path]) => `<svg class="bc-ext-sym" data-sym="${name}" viewBox="0 0 24 24">${path}</svg>`).join('');
  return `${extensionUpdateHTML(kit)}<div class="stg-field bc-extension" id="bc-extension" data-card-state="loading" data-stage="loading" hidden>
    <div class="bc-ext-head" id="bc-extension-head" data-tone="">
      <div class="bc-ext-product">
        <span class="bc-ext-mark" aria-hidden="true">${MARK}</span>
        <div class="bc-ext-product-text"><h4 class="stg-subhead" id="bc-extension-product-title">${c('productTitle')}</h4><p class="stg-help bc-ext-text">${c('productHelp')}</p></div>
      </div>
      <div class="bc-ext-notice" id="bc-extension-default-notice" data-tone="warn" role="note" hidden>
        <p class="bc-ext-notice-title" id="bc-extension-default-title"></p><p class="stg-help bc-ext-text" id="bc-extension-default-help"></p>
      </div>
      <div class="bc-ext-row" id="bc-extension-target-row" hidden>
        <div class="bc-ext-row-text"><p class="bc-ext-row-label" id="bc-extension-target-label">${c('targetLabel')}</p><p class="stg-help bc-ext-text" id="bc-extension-target-help">${c('targetHelp')}</p></div>
        <div class="bc-ext-target" id="bc-extension-target-host"></div>
        <button type="button" class="cli-detect-btn" data-extension-action="browsers" id="bc-extension-browsers-again" hidden>${c('checkBrowsers')}</button>
      </div>
      <div class="bc-ext-row bc-ext-status-row">
        <div class="bc-ext-row-text">
          <div class="bc-ext-status-line">
            <span class="bc-ext-symbol" aria-hidden="true">${symbols}</span>
            <span class="bc-ext-label" id="bc-extension-status-label">${t('statusTitle')}</span>
            <span class="stg-badge bc-ext-status" id="bc-extension-status" role="status" aria-live="polite" aria-labelledby="bc-extension-status-label"></span>
          </div>
          <p class="stg-help bc-ext-text bc-ext-status-help" id="bc-extension-status-help"></p>
        </div>
        <div class="bc-inline-group bc-ext-actions" id="bc-extension-status-actions">
          <button type="button" class="cli-detect-btn bc-ext-primary" id="bc-extension-cta" data-extension-action="guide" hidden></button>
          <button type="button" class="cli-detect-btn bc-ext-primary" data-extension-action="resume" hidden>${c('reconnect')}</button>
          <button type="button" class="cli-detect-btn" data-extension-action="retry" hidden>${c('retry')}</button>
          <button type="button" class="cli-detect-btn" data-extension-action="reload-confirm" hidden>${c('reloadConfirm')}</button>
        </div>
      </div>
      <p class="stg-help bc-ext-text bc-ext-note" id="bc-extension-moved" hidden>${c('movedHelp')}</p>
      <p class="stg-help bc-ext-text bc-ext-note" id="bc-extension-reload" data-tone="warn" data-reload-text="${t('reloadNeeded')}" data-repaired-text="${t('reloadRepaired')}" hidden>${t('reloadNeeded')}</p>
      <p class="stg-help bc-ext-text bc-ext-note" id="bc-extension-update" data-tone="warn" role="status" data-updating-text="${c('updating')}" data-failed-text="${c('updateFailed')}" hidden></p>
      <div class="bc-inline-group bc-ext-actions" id="bc-extension-update-actions" hidden>${button('update', 'card.retry')}</div>
    </div>
    <section class="bc-ext-section" data-extension-section="mode" aria-labelledby="bc-extension-mode-title" hidden>
      <h4 class="stg-subhead" id="bc-extension-mode-title">${c('agentAccessTitle')}</h4>
      <div class="bc-ext-row bc-ext-mode-row">
        <div class="bc-ext-row-text"><p class="bc-ext-row-label" id="bc-extension-mode-label">${c('accessLabel')}</p><p class="stg-help bc-ext-text" id="bc-extension-mode-help" data-full-text="${t('modeFullHelp')}" data-restricted-text="${t('modeRestrictedHelp')}"></p></div>
        <input type="hidden" id="bc-extension-mode" value="full">
        <div class="cc-dropdown stg-dropdown bc-ext-mode" data-for="bc-extension-mode" role="group">
          <button class="cc-dropdown-trigger" type="button" aria-haspopup="listbox" aria-labelledby="bc-extension-mode-label"><span class="cc-dropdown-value">${modes[0][1]}</span>${ARROW}</button>
          <div class="cc-dropdown-menu">${modes.map(([value, label], i) => `<div class="cc-dropdown-item${i === 0 ? ' active' : ''}" data-value="${value}">${label}</div>`).join('')}</div>
        </div>
      </div>
    </section>
    <section class="bc-ext-section" data-extension-section="shared" aria-labelledby="bc-extension-shared-title" hidden>
      <div class="bc-ext-title-row"><h4 class="stg-subhead" id="bc-extension-shared-title">${t('sharedTitle')}</h4><span class="bc-ext-count" id="bc-extension-count"></span></div>
      <p class="stg-help bc-ext-text" id="bc-extension-summary" hidden></p>
      <div class="bc-ext-list" id="bc-extension-tabs" data-empty-text="${t('noTabs')}" data-empty-full-text="${t('noControlled')}"></div>
      <div class="bc-ext-list" id="bc-extension-sites" aria-label="${c('sharedSites')}"></div>
      <p class="stg-help bc-ext-text" id="bc-extension-tabs-help" data-live-text="${c('takeBackHelp')}" data-stale-text="${c('staleHelp')}" hidden></p>
    </section>
    <details class="stg-advanced bc-ext-advanced" id="bc-extension-advanced" data-extension-section="advanced">
      <summary>${CHEVRON}<span>${c('advancedTitle')}</span></summary>
      <div class="bc-ext-advanced-body">
        <section class="bc-ext-part" data-extension-section="install" aria-labelledby="bc-extension-install-title">
          <h4 class="stg-subhead" id="bc-extension-install-title">${t('installTitle')}</h4>
          <p class="stg-help bc-ext-text" id="bc-extension-version"></p>
          <p class="stg-help bc-ext-text">${t('install')}</p>
          <label class="bc-ext-label" for="bc-extension-folder">${t('folder')}</label>
          <div class="bc-ext-control-row">
            <input class="browser-cfg-input bc-ext-path" id="bc-extension-folder" readonly spellcheck="false" autocomplete="off" placeholder="${c('folderPending')}">
            <div class="bc-inline-group bc-ext-actions">${button('copy', 'copy')}${button('refresh', 'refresh')}</div>
          </div>
          <div class="bc-inline-group bc-ext-actions" id="bc-extension-file-actions">${cardButton('update', 'update')}${cardButton('repair', 'repair')}</div>
          <p class="stg-help bc-ext-text" id="bc-extension-files-status" role="status" aria-live="polite"></p>
        </section>
        <section class="bc-ext-part" data-extension-section="setup" id="bc-extension-setup" data-state="idle" aria-labelledby="bc-extension-setup-title">
          <h4 class="stg-subhead" id="bc-extension-setup-title">${c('setupAgainTitle')}</h4>
          <p class="stg-help bc-ext-text" id="bc-extension-setup-status" role="status" aria-live="polite"></p>
          <div class="bc-inline-group bc-ext-actions">
            <button type="button" class="cli-detect-btn" id="bc-extension-setup-start" data-extension-action="setup-start" hidden>${t('setupConnect')}</button>
            <button type="button" class="cli-detect-btn" id="bc-extension-setup-reopen" data-extension-action="setup-reopen" hidden>${c('openGuide')}</button>
            <button type="button" class="cli-detect-btn" id="bc-extension-setup-cancel" data-extension-action="setup-cancel" hidden>${t('setupCancel')}</button>
          </div>
          <div class="bc-inline-group bc-ext-actions" id="bc-extension-setup-alternatives" hidden></div>
        </section>
        <section class="bc-ext-part" data-extension-section="pairing-actions" id="bc-extension-footer" aria-labelledby="bc-extension-pairing-actions-title" hidden>
          <h4 class="stg-subhead" id="bc-extension-pairing-actions-title">${c('pairingActionsTitle')}</h4>
          <div class="bc-inline-group bc-ext-actions">${button('disconnect', 'disconnect')}${button('revoke', 'revoke', ' data-tone="danger"')}</div>
        </section>
        <details class="bc-ext-sub" id="bc-extension-details" data-extension-section="details">
          <summary>${CHEVRON}<span>${c('manualPairing')}</span></summary>
          <section class="bc-ext-part" data-extension-section="pairing" aria-labelledby="bc-extension-pairing-title">
            <h4 class="stg-subhead" id="bc-extension-pairing-title">${t('pairingTitle')}</h4>
            <p class="stg-help bc-ext-text">${c('manualPairHelp')}</p>
            <div class="bc-ext-port-row">
              <label class="bc-ext-label" for="bc-extension-port">${t('port')}</label>
              <input class="browser-cfg-input bc-ext-port" id="bc-extension-port" type="number" min="1024" max="65535" value="3345">
            </div>
            <div class="bc-inline-group bc-ext-actions">${button('pair', 'pair')}</div>
            <p class="bc-ext-code" id="bc-extension-code" role="status"></p>
          </section>
        </details>
        <details class="bc-ext-sub" id="bc-extension-files" data-extension-section="files">
          <summary>${CHEVRON}<span>${c('fileLimits')}</span></summary>
          <section class="bc-ext-part" data-extension-section="uploads" aria-labelledby="bc-extension-uploads-title">
            <h4 class="stg-subhead" id="bc-extension-uploads-title">${t('uploadsTitle')}</h4>
            <p class="stg-help bc-ext-text" id="bc-extension-upload"></p>
            <p class="stg-help bc-ext-text">${c('uploadHelp')}</p>
            <p class="stg-help bc-ext-text bc-ext-limits">${t('limits')}</p>
          </section>
        </details>
      </div>
    </details>
    <div class="bc-ext-confirm" id="bc-extension-confirm" role="alertdialog" aria-labelledby="bc-extension-confirm-title" aria-describedby="bc-extension-confirm-body" hidden>
      <h4 class="stg-subhead" id="bc-extension-confirm-title"></h4>
      <p class="stg-help bc-ext-text" id="bc-extension-confirm-body"></p>
      <div class="bc-inline-group bc-ext-actions">
        <button type="button" class="cli-detect-btn" id="bc-extension-confirm-cancel" data-extension-action="confirm-cancel">${c('cancel')}</button>
        <button type="button" class="cli-detect-btn" id="bc-extension-confirm-ok" data-extension-action="confirm-ok"></button>
      </div>
    </div>
  </div>`;
}
/** The guide's place in the Browser page: empty and hidden until the owner opens it (wireExtensionSettings draws it). */
export function extensionGuideHTML() {
  return '<section class="bc-guide" id="bc-ext-guide" aria-labelledby="bc-guide-title" data-step="0" hidden></section>';
}

// ── what the card shows, decided without the DOM (exported for tests) ──
/** The card's coarse state (data-card-state): kept for the update flow and older tests; the stage is the detail. */
export function cardState(data, setup = null, { failed = false, launching = false } = {}) {
  if (failed && !data) return 'error';
  const running = setup?.state || data?.setup;
  if (launching) return 'launching';
  if (data?.connected) return failed ? 'error' : 'connected';
  if (running === 'downloading') return 'downloading';
  if (running === 'waiting-for-extension') return 'setup';
  if (running === 'pairing') return 'pairing';
  if (running === 'unsupported') return 'unsupported';
  if (failed) return 'error';
  if (data?.paired) return 'disconnected';
  return 'unpaired';
}
/** The setup's download errors (lib/browser-extension-setup.js DOWNLOAD_ERRORS): each has its own sentence, and Try again. */
export const DOWNLOAD_ERRORS = Object.freeze(['EXTENSION_DOWNLOAD_OFFLINE', 'EXTENSION_DOWNLOAD_UNAVAILABLE', 'EXTENSION_VERIFY_FAILED']);
/** How far a download is, 0 to 100 (0 while the size is not known). */
export function downloadPercent(download) {
  const total = Number(download?.total) || 0, received = Number(download?.received) || 0;
  return total > 0 ? Math.max(0, Math.min(100, Math.floor(received / total * 100))) : 0;
}
/** 'updating' while the folder's own update is on its way, 'failed' when it did not arrive, else null. */
export function updateNote(data) {
  const pkg = data?.package;
  if (!pkg || pkg.needs !== 'update') return null;
  return pkg.phase === 'failed' ? 'failed' : 'updating';
}
/** Host and path of an address: the query and fragment (sign-in challenges, tokens) are never shown. */
export function shownAddress(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return ''; }
  if (u.href === 'about:blank') return 'about:blank';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}//`;
  return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
}
/** The tabs agents hold, grouped by the opaque agent id the server reports, in the server's order. */
export function groupByAgent(tabs = []) {
  const groups = new Map();
  for (const tab of tabs) {
    if (!tab?.owner) continue;
    const id = String(tab.owner).replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || '?';
    if (!groups.has(tab.owner)) groups.set(tab.owner, { owner: tab.owner, id, tabs: [] });
    groups.get(tab.owner).tabs.push(tab);
  }
  return [...groups.values()];
}

/**
 * The markup of one guide page. `m`: the model the wiring builds (step, browser, browsers, address, os, folder …);
 * `t(key, params)`: browserExtension.guide.<key>, unescaped. Pure: node --test reads it.
 */
export function guidePageHTML(m, t) {
  const step = m.step, br = m.browser?.short || '', on = { browser: br };
  const act = (action, label, { primary = false, glyph = '', disabled = false, extra = '' } = {}) =>
    `<button type="button" class="cli-detect-btn${primary ? ' bc-ext-primary' : ''}" data-guide-action="${action}"${disabled ? ' disabled' : ''}${extra}>${glyph ? icon(glyph) : ''}<span>${esc(label)}</span></button>`;
  const link = (action, label) => `<button type="button" class="bc-guide-link" data-guide-action="${action}">${esc(label)}</button>`;
  const keys = m.keys.map(k => `<kbd>${esc(k)}</kbd>`).join('<span aria-hidden="true"> → </span>');
  // Ready says so only while every check holds; a check that lapses (the browser went away) is named, never hidden.
  const allOk = (m.checks || []).every(check => check.ok);
  const titles = { 1: t('step1Title', on), 2: t('step2Title'), 3: t('step3Title'), 4: t('step4Title'), 5: t('step5Title'), 6: t('step6Title'), [READY_STEP]: t(allOk ? 'readyTitle' : 'readyPendingTitle', on) };
  const helps = { 1: t('step1Help'), 2: t('step2Help'), 3: t('step3Help'), 4: t('step4Help'), 5: t('step5Help', on), 6: t('step6Help'), [READY_STEP]: t(allOk ? 'readyHelp' : 'readyPendingHelp', on) };
  const picker = `<div class="bc-guide-row"><p class="bc-ext-row-label" id="bc-guide-target-label">${esc(t('targetLabel'))}</p><div class="bc-guide-target">${m.browsers.length
    ? dropdownHTML('bc-guide-target', m.browsers.map(b => ({ value: b.id, label: b.short, selected: b.id === m.browser?.id })), { classes: 'bc-guide-dropdown', labelledBy: 'bc-guide-target-label' })
    : `<span class="stg-help">${esc(t('noBrowsers'))}</span>`}</div></div>`;
  let main = '', next = '';
  if (step === 1) {
    main = `${m.defaultNotice ? `<div class="bc-ext-notice" data-tone="warn" role="note"><p class="bc-ext-notice-title">${esc(m.defaultNotice.title)}</p><p class="stg-help bc-ext-text">${esc(m.defaultNotice.help)}</p></div>` : ''}
      <div class="bc-guide-group">${picker}
        <div class="bc-guide-row"><code class="bc-guide-address" id="bc-guide-address" tabindex="0" dir="ltr">${esc(m.address)}</code>${act('copy-address', t('copyAddress'), { glyph: 'copy' })}</div>
      </div>
      <div class="bc-guide-actions">${act('open-extensions', t('openExtensions', on), { primary: true, glyph: 'open', disabled: !m.address })}</div>
      <details class="bc-guide-fallback" id="bc-guide-fallback"${m.fallbackOpen ? ' open' : ''}><summary>${esc(t('fallbackTitle'))}</summary>
        <p class="stg-help">${esc(t('fallbackHelp', on))}</p>
        <div class="bc-guide-actions">${act('copy-open', t('copyAndOpen', on), { glyph: 'copy' })}<span class="bc-guide-keys" role="group" aria-label="${esc(t('keysLabel'))}">${keys}</span></div>
      </details>`;
    next = act('next', t('step1Next'), { primary: true });
  } else if ([2, 3, 5, 6].includes(step)) {
    const figure = guideFigure(step, { browser: { id: m.browser?.id, name: br }, address: m.address, t: (key, params) => t(key, params) });
    const where = step === 2 ? `<p class="stg-help bc-guide-where">${esc(t({ sidebar: 'devWhereSidebar', header: 'devWhereHeader', unverified: 'devWhereUnverified' }[developerLayout(m.browser?.id)], on))}</p>` : '';
    main = where + (figure ? figure.html : '');
    if (step === 3) main += `<p class="bc-guide-recovery">${esc(t('step3Recovery'))} ${link('developer', t('step3RecoveryAction'))}</p>`;
    if (step === 5) main += `<p class="bc-guide-recovery">${esc(t('step5Recovery'))} ${link('reopen', t('step5RecoveryAction', on))}</p>`;
    if (step === 6) main += `<p class="bc-guide-recovery" id="bc-guide-hint">${esc(t({ 'reload-required': 'step6HintReload', 'browser-update': 'step6HintUpdate', 'legacy-peer': 'step6HintLegacy' }[m.stage] || 'step6Hint', on))}</p>`;
    next = step === 6 ? act('probe', m.checking ? t('checking') : t('checkAgain'), { primary: true, disabled: m.checking })
      : act('next', t({ 2: 'step2Next', 3: 'step3Next', 5: 'step5Next' }[step]), { primary: true });
  } else if (step === 4) {
    if (m.prepError) {
      main = `<div class="bc-ext-notice" data-tone="warn" role="alert"><p class="bc-ext-notice-title">${icon('info')}<span>${esc(t(m.prepError.title))}</span></p><p class="stg-help bc-ext-text">${esc(t(m.prepError.help))}</p></div>`;
      next = act('retry-folder', t('retryFolder'), { primary: true });
    } else if (!m.folder) {
      main = `<p class="bc-guide-waiting" role="status">${icon('clock')}<span>${esc(m.download ? t('downloadProgress', m.download) : t('preparing'))}</span></p>`;
      next = '';
    } else {
      main = `<div class="bc-guide-group bc-guide-folder">
          <div class="bc-guide-row"><p class="bc-guide-folder-title">${icon('folder')}<span>${esc(t('folderLabel'))}</span></p>${m.folderVersion ? `<span class="bc-guide-verified">${icon('good')}<span>${esc(t('verified', { version: m.folderVersion }))}</span></span>` : ''}</div>
          <code class="bc-guide-path" id="bc-guide-path" tabindex="0" dir="ltr">${esc(m.folder)}</code>
          <div class="bc-guide-actions">${act('copy-folder', t('copyFolder'), { primary: true, glyph: 'copy' })}${act('reveal', t(m.os === 'mac' ? 'showMac' : m.os === 'windows' ? 'showWindows' : 'showLinux'), { glyph: 'folder' })}</div>
        </div>
        <p class="bc-guide-waiting" role="status">${icon('clock')}<span>${esc(t(m.stage === 'pairing' ? 'pairing' : 'waiting', on))}</span></p>
        <p class="stg-help bc-guide-recovery">${esc(t('pairNowHelp', on))}</p>`;
      next = act('pair-now', t('pairNow', on));
    }
  } else {
    main = `<ul class="bc-guide-checklist bc-guide-group">${m.checks.map(c => `<li data-check="${c.key}" data-ok="${c.ok}">${icon(c.ok ? 'good' : 'pending')}<div><p class="bc-guide-check-title">${esc(t(`check${c.key[0].toUpperCase()}${c.key.slice(1)}`, on))}</p><p class="stg-help">${esc(c.ok ? t(`check${c.key[0].toUpperCase()}${c.key.slice(1)}Help`, { version: m.extensionVersion || '' }) : t('checkPending'))}</p></div></li>`).join('')}</ul>`;
    next = act('done', t('done'), { primary: true });
  }
  const progress = step === READY_STEP ? t('progressDone') : t('progress', { step });
  const bars = GUIDE_STEPS.map((_, i) => `<i${i < step ? ' data-on="true"' : ''}></i>`).join('');
  return `<div class="bc-guide-head">${act('exit', t('backToSettings'), { glyph: 'left', extra: ' data-plain="true"' })}<p class="bc-guide-progress"><span>${esc(progress)}</span><span class="bc-guide-bars" aria-hidden="true">${bars}</span></p></div>
    <div class="bc-guide-main">
      <p class="bc-guide-crumb">${icon(step === READY_STEP ? 'good' : 'browser')}<span>${esc(t('crumb', on))}</span></p>
      <h2 class="bc-guide-title" id="bc-guide-title" tabindex="-1">${esc(titles[step])}</h2>
      <p class="stg-help bc-guide-help">${esc(helps[step])}</p>
      ${main}
      <p class="stg-help bc-guide-feedback" id="bc-guide-feedback" role="status" aria-live="polite">${esc(m.feedback || '')}</p>
    </div>
    <div class="bc-guide-foot">${step === READY_STEP ? '<span></span>' : act('back', t('back'), { glyph: 'left', extra: ' data-plain="true"' })}${next}</div>`;
}

// The badge's tone for each stage (Settings' own .stg-badge-ok / -warn / -err; none is the plain word).
const STATUS_TONES = ['stg-badge-ok', 'stg-badge-warn', 'stg-badge-err'];
const CONFIRMS = {
  disconnect: ['disconnectTitle', 'disconnectBody', 'disconnect'],
  revoke: ['revokeTitle', 'revokeBody', 'revoke'],
  restrict: ['restrictTitle', 'restrictBody', 'restrictConfirm'],
  full: ['fullTitle', 'fullBody', 'fullConfirm'],
  repair: ['repairTitle', 'repairBody', 'repairConfirm'],
};
const PREP_ERRORS = {
  EXTENSION_DOWNLOAD_OFFLINE: { title: 'prepOfflineTitle', help: 'prepOffline' },
  EXTENSION_DOWNLOAD_UNAVAILABLE: { title: 'prepUnavailableTitle', help: 'prepUnavailable' },
  EXTENSION_VERIFY_FAILED: { title: 'prepVerifyTitle', help: 'prepVerify' },
};

/**
 * Wires the card and the guide. `hydrated`: the connection menu (#bc-connectMode) already holds the saved mode. Settings
 * passes false: its menu starts on its first option ("extension") until GET /api/browser/config answers, and nothing
 * may show, poll or start a setup for an owner who uses another mode; the function this returns is then called once the
 * saved mode is in the menu (and after every later change of it). `revealRequested(el)`: whether the deep link that
 * opened Settings asked for something inside `el` (ui-settings.js settingsRevealRequested): a guide left open is not
 * restored over such a target.
 */
export function wireExtensionSettings(root, { tx, signal, hydrated = true, revealRequested = () => false }) {
  wireExtensionUpdate(root, { tx, signal });
  const pane = root.querySelector('#bc-extension'); if (!pane) return;
  const t = (key, params) => tx(`browserExtension.${key}`, params);
  const c = (key, params) => tx(`browserExtension.card.${key}`, params);
  const g = (key, params) => tx(`browserExtension.guide.${key}`, params);
  const query = id => root.querySelector(`#bc-extension-${id}`);
  const host = root.querySelector('#bc-ext-guide');
  let folder = '', busy = false, full = null, last = null, lastSetup = null, launching = false, readFailed = '';
  // The installed browsers (GET …/setup/browsers): null until read; `legacy` when the server predates it (a server not
  // yet restarted after an update: the card then offers the old one-button setup, which opens the page itself).
  let inventory = null, legacy = false, inventoryKey = '';
  const pendingTabs = new Set(), failedTabs = new Set();
  // The guide: open or not, the page, how far each browser got, and the browser chosen (kept across openings).
  const store = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  const saved = readGuideStore(store?.getItem?.(GUIDE_STORE_KEY));
  // Closed until the mode is known: a guide left open is restored by restoreGuide(), once, in the extension mode only.
  const guide = { open: false, step: 0, progress: saved.progress, target: saved.target, feedback: '', checking: false, fallbackOpen: true, lastStage: null };
  // Every action of the guide belongs to the browser and the page it was asked on: a later change makes it stale.
  let generation = 0;
  const persist = () => { try { store?.setItem?.(GUIDE_STORE_KEY, writeGuideStore({ target: guide.target, open: guide.open, progress: guide.progress })); } catch {} };

  function setStatus(text, tone = '') {
    const node = query('status'); if (node.textContent !== text) node.textContent = text;
    for (const name of STATUS_TONES) node.classList.remove(name);
    if (tone) node.classList.add(`stg-badge-${tone}`);
  }
  async function api(action, body) {
    // Reads are GETs (the status, the setup status, the installed browsers); every other action a POST.
    const read = body === undefined;
    const res = await fetch(`/api/browser/extension${action ? '/' + action : ''}`, read ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: JSON.stringify(body), signal });
    const value = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(value.error || t('restart')), { code: value.code || '', status: res.status });
    return value;
  }
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const browsers = () => (Array.isArray(inventory?.installedBrowsers) ? inventory.installedBrowsers : []).map(b => ({ ...b, short: shortName(b) }));
  const targetBrowser = () => browsers().find(b => b.id === guide.target) || (lastSetup?.browser?.id === guide.target ? { ...lastSetup.browser, short: shortName(lastSetup.browser) } : null);
  const targetName = () => targetBrowser()?.short || shortName(lastSetup?.browser) || '';
  const installedIds = () => (inventory ? browsers().map(b => b.id) : null);
  const stageNow = () => extensionStage({ data: last, setup: lastSetup, target: guide.target, failed: !!readFailed, installed: installedIds() });

  // ── tabs (unchanged behaviour: agents' tabs grouped by agent with Take back, shared tabs, shared sites) ──
  function tabRow(tab, { label, aria, disabled }) {
    const row = el('div', 'bc-ext-item'); row.dataset.handle = tab.handle;
    const text = el('div', 'bc-ext-item-label');
    const title = String(tab.title || '').trim() || c('untitledTab');
    const name = el('span', 'bc-ext-item-title', title); name.title = title;
    text.append(name, el('span', 'bc-ext-item-address', shownAddress(tab.url)));
    const pending = pendingTabs.has(tab.handle);
    const button = el('button', 'cli-detect-btn', pending ? c('busy') : label); button.type = 'button';
    button.setAttribute('aria-label', aria); button.disabled = !!disabled || pending;
    button.addEventListener('click', () => takeBack(tab.handle), { signal });
    row.append(text, button);
    if (failedTabs.has(tab.handle)) { const error = el('p', 'stg-help bc-ext-row-error', c('actionError')); error.setAttribute('role', 'alert'); row.append(error); }
    return row;
  }
  let shownKey = '';
  function showTabs(data, live) {
    const tabs = Array.isArray(data?.tabs) ? data.tabs : [], sites = full ? [] : Array.isArray(data?.sites) ? data.sites : [];
    const groups = groupByAgent(tabs), waiting = full ? [] : tabs.filter(tab => tab && !tab.owner);
    const total = groups.reduce((sum, grp) => sum + grp.tabs.length, 0);
    const key = JSON.stringify([full, live, groups.map(grp => [grp.owner, grp.tabs.map(x => [x.handle, x.title, shownAddress(x.url)])]), waiting.map(x => [x.handle, x.title, shownAddress(x.url)]), sites, [...pendingTabs], [...failedTabs]]);
    query('count').textContent = total ? String(total) : '';
    const summary = query('summary');
    summary.hidden = !total;
    summary.textContent = !total ? '' : total === 1 ? c('oneTab') : groups.length === 1 ? c('oneAgent', { tabs: total }) : c('agentCount', { agents: groups.length, tabs: total });
    const help = query('tabs-help'); help.hidden = !total; help.textContent = live ? help.dataset.liveText : help.dataset.staleText;
    if (key === shownKey) return;
    shownKey = key;
    const list = query('tabs'); list.replaceChildren();
    for (const group of groups) {
      const box = el('div', 'bc-ext-agent'); box.dataset.owner = group.owner;
      const head = el('div', 'bc-ext-agent-head');
      const mark = el('span', 'bc-ext-agent-mark', group.id.slice(0, 2)); mark.setAttribute('aria-hidden', 'true');
      const agent = c('unknownAgent', { id: group.id });
      head.append(mark, el('span', 'bc-ext-agent-name', agent));
      box.append(head);
      for (const tab of group.tabs) {
        const title = String(tab.title || '').trim() || c('untitledTab');
        box.append(tabRow(tab, { label: t('takeBack'), aria: c('takeBackLabel', { title, agent }), disabled: !live }));
      }
      list.append(box);
    }
    if (waiting.length) {
      const box = el('div', 'bc-ext-agent'); box.append(el('div', 'bc-ext-agent-head', c('sharedTabs')));
      for (const tab of waiting) {
        const title = String(tab.title || '').trim() || c('untitledTab');
        box.append(tabRow(tab, { label: c('stopSharing'), aria: c('stopSharingLabel', { title }), disabled: !live }));
      }
      list.append(box);
    }
    if (!total && !waiting.length && list.dataset.emptyText) list.append(el('p', 'stg-help bc-ext-empty', full ? list.dataset.emptyFullText : list.dataset.emptyText));
    const siteList = query('sites'); siteList.replaceChildren();
    for (const site of sites) {
      const row = el('div', 'bc-ext-item');
      const label = el('span', 'bc-ext-item-label'); label.append(el('code', 'bc-ext-item-site', site));
      const button = el('button', 'cli-detect-btn', c('removeSite')); button.type = 'button';
      button.setAttribute('aria-label', c('removeSiteLabel', { site }));
      button.addEventListener('click', () => perform('revoke-site', { site }), { signal });
      row.append(label, button); siteList.append(row);
    }
  }
  function showCode(code) {
    const node = query('code');
    if (code == null) { node.textContent = ''; return; }
    node.replaceChildren(el('span', 'bc-ext-code-lead', `${t('code')} `), el('strong', 'bc-ext-code-value', code), el('span', 'bc-ext-code-expiry', ` · ${t('expires')}`));
  }
  // The agent access as the server reports it. `fullControl` missing is a server from before the mode: hidden.
  function showMode(value) {
    full = typeof value === 'boolean' ? value : null;
    const section = pane.querySelector('[data-extension-section="mode"]');
    section.hidden = full === null;
    if (full === null) return;
    const chosen = full ? 'full' : 'restricted', input = query('mode'), dropdown = pane.querySelector('.bc-ext-mode');
    input.value = chosen;
    for (const item of dropdown.querySelectorAll('.cc-dropdown-item')) {
      const on = item.dataset.value === chosen; item.classList.toggle('active', on);
      if (on) dropdown.querySelector('.cc-dropdown-value').textContent = item.textContent;
    }
    const help = query('mode-help'); help.textContent = full ? help.dataset.fullText : help.dataset.restrictedText;
    query('shared-title').textContent = t(full ? 'controlledTitle' : 'sharedTitle');
  }
  // The installed-browser picker: rebuilt only when the list or the choice changed (an open menu stays open).
  function showTarget() {
    const row = query('target-row'), list = browsers();
    row.hidden = legacy || !inventory;
    if (row.hidden) return;
    const key = JSON.stringify([list.map(b => [b.id, b.short]), guide.target]);
    if (key !== inventoryKey) {
      inventoryKey = key;
      const target = query('target-host');
      target.innerHTML = list.length
        ? dropdownHTML('bc-extension-target', list.map(b => ({ value: b.id, label: b.short, selected: b.id === guide.target })), { classes: 'bc-ext-target-dropdown', labelledBy: 'bc-extension-target-label' })
        : dropdownHTML('bc-extension-target', [{ value: '', label: c('noBrowsers') }], { classes: 'bc-ext-target-dropdown', labelledBy: 'bc-extension-target-label', disabled: true });
    }
    query('target-help').textContent = list.length ? c('targetHelp') : c('noBrowsersHelp');
    query('browsers-again').hidden = !!list.length;
    // A default browser that cannot run the extension is named, never changed.
    const def = inventory.defaultBrowser, notice = query('default-notice');
    notice.hidden = !(def && def.supported === false && def.name && def.id !== 'unknown');
    if (!notice.hidden) { query('default-title').textContent = c('defaultUnsupportedTitle', { browser: def.name }); query('default-help').textContent = c('defaultUnsupportedHelp', { browser: def.name }); }
  }
  // The status: the stage's word, what it means, and the one action that moves it on.
  function showHead(stage, error) {
    const view = stageView(stage, { savedStep: guide.progress[guide.target] || 0, legacyServer: legacy });
    pane.dataset.stage = stage;
    pane.dataset.cardState = cardState(last, lastSetup, { failed: !!error, launching });
    const symbol = view.tone || (stage === 'not-set-up' ? 'off' : '');
    query('head').dataset.tone = symbol;
    const name = targetName();
    if (error && !last) setStatus(`${t('restart')} ${error}`, 'err');
    else setStatus(launching ? c('launching') : c(view.status, { browser: name }), { ok: 'ok', warn: 'warn', err: 'err' }[view.tone] || '');
    const help = query('status-help'), helpText = error && last ? `${t('restart')} ${error}` : c(view.help, { browser: name });
    if (help.textContent !== helpText) help.textContent = helpText;
    const cta = query('cta'), retry = pane.querySelector('[data-extension-action="retry"]'), resume = pane.querySelector('[data-extension-action="resume"]');
    const noBrowser = !legacy && inventory && !browsers().length;
    resume.hidden = stage !== 'disconnected';
    retry.hidden = !error;
    cta.hidden = !view.cta || stage === 'loading' || (stage === 'error' && !!error) || view.cta === 'ctaReconnect' || noBrowser;
    cta.textContent = !view.cta ? '' : view.cta === 'retry' ? c('retry') : c(view.cta, { browser: name });
    cta.dataset.cta = view.cta || '';
    cta.disabled = launching;
    // A repair's Reload ends only by the owner's click here (POST reload/confirm).
    pane.querySelector('[data-extension-action="reload-confirm"]').hidden = !!last?.update || !(last?.reloadNeeded === true && last?.reloadRepaired === true);
    query('moved').hidden = !(stage === 'disconnected' && !error);
    const reload = query('reload'), reloadText = last?.reloadRepaired === true ? reload.dataset.repairedText : reload.dataset.reloadText;
    reload.hidden = !!last?.update || !(last?.reloadNeeded === true) || stage === 'reload-required';
    if (reloadText && reload.textContent !== reloadText) reload.textContent = reloadText;
    const running = lastSetup?.state || last?.setup || 'idle', active = ['downloading', 'waiting-for-extension', 'pairing'].includes(running);
    const update = active || last?.update ? null : updateNote(last), note = query('update');
    note.hidden = !update; note.textContent = update ? (update === 'failed' ? note.dataset.failedText : note.dataset.updatingText) : '';
    query('update-actions').hidden = update !== 'failed';
  }
  // Advanced: the folder, its version, the setup that is running (Cancel), the pairing actions.
  function showAdvanced(data, setup) {
    if (data) {
      folder = data.folder || ''; query('folder').value = folder; query('folder').title = folder;
      const path = el('code', 'bc-ext-path-text', data.uploadFolder ?? ''); path.title = data.uploadFolder ?? '';
      query('upload').replaceChildren(`${t('upload')} `, path);
      const version = data.folderVersion || data.pinnedVersion || '';
      query('version').textContent = version ? c('filesVersion', { version }) : '';
    }
    const running = setup?.state || data?.setup || 'idle';
    const section = query('setup'); section.dataset.state = running;
    section.hidden = typeof data?.setup !== 'string';
    const active = ['downloading', 'waiting-for-extension', 'pairing'].includes(running);
    // A setup that ended in an error stays until it is cleared: Cancel setup clears it (POST setup/cancel), so a failed
    // Set up or Repair is never stuck on the card.
    query('setup-cancel').hidden = !active && running !== 'error';
    query('setup-reopen').hidden = running !== 'waiting-for-extension';
    // The old one-button setup, for a server that does not know the guide's routes yet.
    query('setup-start').hidden = !legacy || active;
    const name = setup?.browser?.name || '';
    const known = ['downloading', 'waiting-for-extension', 'pairing', 'connected', 'unsupported'].includes(running);
    const downloadFailed = running === 'error' && DOWNLOAD_ERRORS.includes(setup?.code);
    query('setup-status').textContent = launching ? c('launching') : running === 'idle' ? '' : known ? tx(`browserExtension.setup.settings_${running.replace(/-/g, '_')}`, { browser: name, percent: downloadPercent(setup?.download) })
      : downloadFailed ? tx(`browserExtension.setup.error${setup.code}`) : tx('browserExtension.setup.settings_error', { code: setup?.code || '' });
    const alternatives = query('setup-alternatives'); alternatives.replaceChildren();
    const others = legacy && running === 'unsupported' ? (setup?.installedBrowsers || []).filter(b => b?.supported && b.id !== setup?.browser?.id) : [];
    for (const browser of others) {
      const option = el('button', 'cli-detect-btn', tx('browserExtension.setup.openIn', { browser: browser.name })); option.type = 'button';
      option.dataset.extensionAction = 'setup-open-in'; option.dataset.browser = browser.id;
      alternatives.append(option);
    }
    alternatives.hidden = !others.length;
    query('footer').hidden = !data?.paired;
    query('files').hidden = !data;
  }

  // ── the guide ──
  const PAGE = () => host?.closest?.('.stg-page') || null;
  function guideModel() {
    const stage = stageNow(), browser = targetBrowser(), list = browsers();
    const os = osOf(inventory?.platform || globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');
    const def = inventory?.defaultBrowser;
    // Only a setup that exists and is this browser's speaks for the folder; an idle one (a restarted server) does not.
    const setup = lastSetup && lastSetup.state && lastSetup.state !== 'idle' && (!lastSetup.browser?.id || lastSetup.browser.id === guide.target) ? lastSetup : null;
    const code = setup?.state === 'error' ? setup.code : null;
    return {
      step: guide.step, stage, browser, browsers: list, address: browser?.extensionsUrl || setup?.extensionsUrl || '',
      os, keys: pasteKeys(os),
      folder: setup?.state === 'downloading' ? '' : setup?.folder || last?.folder || '', folderVersion: last?.folderVersion || setup?.folderVersion || '',
      download: setup?.download && Number(setup.download.total) > 0 ? { received: Math.round(setup.download.received / 1024), total: Math.round(setup.download.total / 1024) } : null,
      prepError: code ? (PREP_ERRORS[code] || { title: 'prepFailedTitle', help: 'prepFailed' }) : null,
      checks: readyChecks({ data: last, setup: lastSetup, target: guide.target, installed: installedIds() }), extensionVersion: last?.extensionVersion || '',
      feedback: guide.feedback, checking: guide.checking, fallbackOpen: guide.fallbackOpen,
      defaultNotice: def && def.supported === false && def.id !== 'unknown' && def.name ? { title: c('defaultUnsupportedTitle', { browser: def.name }), help: c('defaultUnsupportedHelp', { browser: def.name }) } : null,
    };
  }
  let guideHTML = '';
  function drawGuide({ focusTitle = false } = {}) {
    if (!host) return;
    const page = PAGE(), paneEl = host.parentNode;
    if (!guide.open) {
      host.hidden = true; host.dataset.step = '0';
      if (page) delete page.dataset.bcGuide; if (paneEl?.dataset) delete paneEl.dataset.bcGuide;
      guideHTML = '';
      return;
    }
    host.hidden = false; host.dataset.step = String(guide.step);
    if (page) page.dataset.bcGuide = 'open'; if (paneEl?.dataset) paneEl.dataset.bcGuide = 'open';
    const html = guidePageHTML(guideModel(), g);
    if (html !== guideHTML) {
      // Keep the focus on the same control when only the words around it changed.
      const focused = host.contains?.(document.activeElement) ? document.activeElement?.dataset?.guideAction : null;
      guideHTML = html; host.innerHTML = html;
      if (!focusTitle && focused) host.querySelector(`[data-guide-action="${focused}"]`)?.focus?.();
    }
    if (focusTitle) {
      host.querySelector('#bc-guide-title')?.focus?.();
      const scroller = host.closest?.('.settings-tab-body'); if (scroller) scroller.scrollTop = 0;
    }
  }
  function goStep(step) {
    generation++;
    guide.step = step; guide.feedback = ''; guide.checking = false;
    if (guide.target) guide.progress[guide.target] = step;
    persist(); drawGuide({ focusTitle: true });
  }
  function say(text) {
    guide.feedback = text;
    const node = host?.querySelector('#bc-guide-feedback');
    if (node) { node.textContent = text; guideHTML = guidePageHTML(guideModel(), g); }
  }
  const setupFor = target => lastSetup && lastSetup.browser?.id === target && ['downloading', 'waiting-for-extension', 'pairing'].includes(lastSetup.state);
  // SynaBun's side of the install: the verified folder and the pairing window, for the chosen browser. Nothing opens.
  async function prepare() {
    const stage = stageNow();
    if (!guide.target || setupFor(guide.target) || ['ready', 'detected', 'allow-scripts', 'reload-required', 'browser-update', 'legacy-peer'].includes(stage)) return;
    try { lastSetup = await api('setup/start', { browser: guide.target, present: 'none' }); }
    catch (error) { say(g('setupFailed', { error: error.message })); }
  }
  async function openGuide(step) {
    guide.open = true; guide.prepared = true; guide.lastStage = stageNow();
    goStep(step);
    await prepare();
    await refresh().catch(() => {});
  }
  // `focus`: give the keyboard back to the card's action (Back to Settings, Done); a deep link keeps its own target.
  function closeGuide({ focus = true } = {}) {
    generation++;
    guide.open = false; guide.feedback = ''; persist(); drawGuide();
    if (focus) query('cta')?.focus?.();
  }
  async function copy(text, nodeId) {
    try { if (!text || !globalThis.navigator?.clipboard?.writeText) throw new Error('no clipboard'); await navigator.clipboard.writeText(text); return true; }
    catch {
      // The clipboard refused: select the text so a manual copy takes it.
      try { const node = host.querySelector(`#${nodeId}`); node?.focus?.(); const range = document.createRange(); range.selectNodeContents(node); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); } catch {}
      return false;
    }
  }
  async function guideAction(action) {
    const mine = ++generation, name = targetName(), stale = () => mine !== generation || !guide.open;
    const enter = guideModel().keys.at(-1);
    if (action === 'exit' || action === 'done') { closeGuide(); return; }
    if (action === 'back') { if (guide.step <= 1) closeGuide(); else goStep(guide.step === READY_STEP ? 6 : guide.step - 1); return; }
    if (action === 'next') { goStep(Math.min(READY_STEP, guide.step + 1)); return; }
    if (action === 'developer') { goStep(2); return; }
    if (action === 'retry-folder') { lastSetup = null; say(''); await prepare(); if (!stale()) { await refresh().catch(() => {}); } return; }
    if (action === 'copy-address') { const ok = await copy(guideModel().address, 'bc-guide-address'); if (!stale()) say(ok ? g('copiedAddress') : g('copyManualAddress')); return; }
    if (action === 'copy-folder') { const ok = await copy(guideModel().folder, 'bc-guide-path'); if (!stale()) say(ok ? g('copiedFolder') : g('copyManualFolder')); return; }
    if (action === 'copy-open') {
      const ok = await copy(guideModel().address, 'bc-guide-address');
      if (stale()) return;
      if (!ok) { say(g('copyManualAddress')); return; }
      let focused = false;
      try { focused = (await api('setup/focus', { browser: guide.target })).ok === true; } catch { focused = false; }
      if (!stale()) say(g(focused ? 'copiedPaste' : 'copiedFocusFailed', { browser: name, enter }));
      return;
    }
    if (action === 'open-extensions' || action === 'reopen') {
      let answer = null;
      try { answer = await api('setup/open-extensions', { browser: guide.target }); } catch (error) { answer = { ok: false, code: error.code }; }
      if (stale()) return;
      if (answer?.ok) say(g(action === 'reopen' ? 'reopened' : 'opened', { browser: name }));
      else if (guide.step === 1) { guide.fallbackOpen = true; say(g('openFailed', { browser: name })); drawGuide(); host.querySelector('#bc-guide-fallback')?.setAttribute?.('open', ''); }
      // "Page didn't open?" is Step 1's: elsewhere the sentence names the address itself.
      else say(g('reopenFailed', { browser: name, address: guideModel().address }));
      return;
    }
    if (action === 'reveal') {
      let answer = null;
      try { answer = await api('setup/reveal', {}); } catch { answer = { ok: false }; }
      if (!stale()) say(answer?.ok ? g('revealed', { app: g(guideModel().os === 'mac' ? 'finder' : guideModel().os === 'windows' ? 'explorer' : 'files') }) : g('revealFailed'));
      return;
    }
    if (action === 'pair-now') {
      // The setup's own pairing page, in the setup's browser (POST setup/reopen): the one launch that pairs. "Copy
      // address & open" brings the browser forward with a page that never pairs (setup/focus), so the paste that
      // replaces it takes no pairing with it, and the pages that do pair take turns (es-page.js).
      if (!setupFor(guide.target)) await prepare();
      if (stale()) return;
      // Never another browser's setup: without one for this browser there is no pairing page to open.
      if (!setupFor(guide.target)) { say(g('pairFailed', { browser: name })); return; }
      let answer = null;
      try { answer = await api('setup/reopen', {}); } catch { answer = null; }
      if (!stale()) say(g(answer?.opened === true ? 'pairOpened' : 'pairFailed', { browser: name }));
      return;
    }
    if (action === 'probe') {
      guide.checking = true; guide.feedback = g('checkingFeedback'); drawGuide();
      let answer = null;
      try { answer = await api('capabilities/check', {}); } catch { answer = null; }
      try { await refresh(); } catch {}
      if (stale()) return;
      guide.checking = false;
      const stage = stageNow();
      if (stage === 'ready') { goStep(READY_STEP); return; }
      guide.feedback = !answer ? g('probeFailed')
        : { 'allow-scripts': g('probeDisabled'), 'legacy-peer': g('probeLegacy'), 'browser-update': g('probeUnsupported', { browser: name }), 'reload-required': g('probeReload'), 'other-browser': g('probeOther', { browser: name }) }[stage]
          || g('probeNotConnected', { browser: name });
      drawGuide(); host.querySelector('[data-guide-action="probe"]')?.focus?.();
    }
  }
  // A new browser for the guide (either picker): its own progress, a fresh setup for it, nothing else changes.
  function chooseTarget(id) {
    if (!id || id === guide.target || !browsers().some(b => b.id === id)) return;
    generation++;
    guide.target = id; guide.feedback = '';
    persist(); render();
    if (guide.open) {
      const stage = stageNow();
      goStep(stage === 'ready' ? READY_STEP : Math.min(guide.progress[id] || 1, 3));
      void prepare().then(() => refresh()).catch(() => {});
    }
  }

  function render(error = readFailed) {
    const stage = stageNow();
    showMode(last?.fullControl);
    showTarget();
    showHead(stage, error);
    showAdvanced(last, lastSetup);
    // Full control lists every tab of the browser; the card shows the ones agents hold. While the browser is away the
    // last tabs stay, marked out of date, their actions off.
    const connected = !!last?.connected;
    pane.querySelector('[data-extension-section="shared"]').hidden = !last || !(connected || (last.paired && (last.tabs || []).some(tab => tab.owner)));
    showTabs(last, connected && !error);
    if (guide.open) {
      // A guide restored from another window (or after a restart) gets its pairing window back once, as Set up would.
      if (!guide.prepared && last && !legacy && guide.step < READY_STEP) { guide.prepared = true; void prepare(); }
      // New evidence chooses the next page (never backwards past the owner's own Back).
      const next = branchStep(guide.step, stage, guide.lastStage);
      guide.lastStage = stage;
      if (next !== guide.step) goStep(next); else drawGuide();
    }
  }
  async function readInventory(refreshNow = false) {
    try { inventory = await api(`setup/browsers${refreshNow ? '?refresh=1' : ''}`); legacy = false; }
    catch (error) { if ([404, 400].includes(error.status)) legacy = true; inventory = null; }
    guide.target = pickTarget(inventory, guide.target) || guide.target;
  }
  let inventoryRead = null;
  async function refresh() {
    const accept = beginExtensionUpdateRead();
    if (!inventoryRead) inventoryRead = readInventory();
    await inventoryRead;
    const data = await api();
    let setup = null;
    // The setup status also says which browser made the pairing (pairedThrough): read it whenever one may matter.
    if ((typeof data.setup === 'string' && data.setup !== 'idle') || data.paired) { try { setup = await api('setup/status'); } catch { setup = null; } }
    last = data; lastSetup = setup; readFailed = '';
    if (!signal.aborted) accept(data.update || null);
    render();
  }
  async function takeBack(handle) {
    if (pendingTabs.has(handle)) return;
    pendingTabs.add(handle); failedTabs.delete(handle); render();
    try { await api('revoke-tab', { tab: handle }); }
    catch { failedTabs.add(handle); }
    finally { pendingTabs.delete(handle); }
    try { await refresh(); } catch (error) { if (!signal.aborted) { readFailed = error.message; render(); } }
  }
  // Confirmations: in the card itself, Cancel focused first, Escape cancels, the focus returns to the control that asked.
  let confirming = null;
  function confirmFirst(kind, opener, then) {
    const [title, body, ok] = CONFIRMS[kind];
    const box = query('confirm');
    query('confirm-title').textContent = c(title); query('confirm-body').textContent = c(body);
    const button = query('confirm-ok'); button.textContent = c(ok); button.dataset.kind = kind;
    box.dataset.kind = kind;
    let part = opener; while (part && part.parentNode !== pane) part = part.parentNode;
    if (part && part !== box && part.nextSibling !== box) part.after(box);
    confirming = { then, opener };
    box.hidden = false;
    query('confirm-cancel').focus?.();
  }
  function closeConfirm(run) {
    const box = query('confirm'), pending = confirming;
    confirming = null; box.hidden = true;
    if (!run && pending?.cancelled) pending.cancelled();
    if (pending?.opener?.isConnected && !pending.opener.hidden) pending.opener.focus?.();
    if (run && pending) pending.then();
  }
  let queuedMode = null;
  async function perform(action, body) {
    // A mode switch made while a refresh runs is not lost: it runs right after.
    if (busy) { if (action === 'mode') queuedMode = body; return; }
    busy = true;
    try {
      if (action === 'copy') { if (folder) await navigator.clipboard.writeText(folder); }
      else if (action === 'browsers') { inventoryRead = readInventory(true); }
      else if (action === 'setup-start' || action === 'setup-open-in') {
        launching = true; render();
        try { await api('setup/start', action === 'setup-open-in' ? { browser: body?.browser } : {}); } finally { launching = false; }
      }
      else if (action === 'setup-cancel') await api('setup/cancel', {});
      else if (action === 'setup-reopen') await api('setup/reopen', {});
      else if (action === 'reload-confirm') await api('reload/confirm', { reloaded: true });
      else if (action === 'repair') { lastSetup = await api('setup/start', { browser: guide.target || undefined, present: 'none' }); }
      else if (!['refresh', 'retry'].includes(action)) {
        const data = await api(action, body || (action === 'pair' ? { port: Number(query('port').value) } : {}));
        if (action !== 'mode') showCode(action === 'pair' ? data.code : null);
        if (action === 'pair') setTimeout(() => { if (!signal.aborted) showCode(null); }, 120000);
      }
      await refresh();
    } catch (error) { if (!signal.aborted) { readFailed = error.message; render(); } }
    finally {
      busy = false;
      if (queuedMode) { const next = queuedMode; queuedMode = null; if (next.fullControl !== full) void perform('mode', next); }
    }
  }
  query('mode').addEventListener('change', () => {
    const next = query('mode').value === 'full';
    if (next === full) return;
    const trigger = pane.querySelector('.bc-ext-mode .cc-dropdown-trigger'), current = full;
    confirmFirst(next ? 'full' : 'restrict', trigger, () => perform('mode', { fullControl: next }));
    confirming.cancelled = () => showMode(current);
  }, { signal });
  // The browser pickers (card and guide) are cc-dropdown.js dropdowns wired on their own containers.
  const targetHost = query('target-host');
  // (A real page only: the node --test stand-in DOM drives the hidden inputs' `change` itself.)
  if (typeof HTMLElement !== 'undefined') { wireDropdowns(targetHost, { signal }); if (host) wireDropdowns(host, { signal }); }
  targetHost.addEventListener('change', event => { if (event.target?.id === 'bc-extension-target') chooseTarget(event.target.value); }, { signal });
  host?.addEventListener('change', event => { if (event.target?.id === 'bc-guide-target') chooseTarget(event.target.value); }, { signal });
  host?.addEventListener('click', event => {
    const target = event.target.closest?.('[data-guide-action]');
    if (target && !target.disabled) void guideAction(target.dataset.guideAction);
  }, { signal });
  host?.addEventListener('toggle', event => { if (event.target?.id === 'bc-guide-fallback') guide.fallbackOpen = !!event.target.open; }, { signal, capture: true });
  pane.addEventListener('click', event => {
    const target = event.target.closest('[data-extension-action]'), action = target?.dataset.extensionAction;
    if (!action) return;
    if (action === 'confirm-cancel') { closeConfirm(false); return; }
    if (action === 'confirm-ok') { closeConfirm(true); return; }
    if (action === 'disconnect' || action === 'revoke' || action === 'repair') {
      confirmFirst(action, target, () => perform(action).then(() => {
        if (action !== 'repair' || readFailed) return;
        // A Repair whose download failed says so (Advanced → Set up again keeps its Cancel); it never says "repaired".
        const failedCode = lastSetup?.state === 'error' ? lastSetup.code || '' : '';
        query('files-status').textContent = !failedCode ? c('repaired', { browser: targetName() })
          : DOWNLOAD_ERRORS.includes(failedCode) ? tx(`browserExtension.setup.error${failedCode}`) : tx('browserExtension.setup.settings_error', { code: failedCode });
      }));
      return;
    }
    // Update: the folder's own update when it is older than this release's extension; otherwise it says it is current.
    if (action === 'update' && target.closest('#bc-extension-file-actions')) {
      void perform('update').then(() => {
        if (readFailed) return;
        const version = last?.folderVersion || last?.pinnedVersion || '';
        query('files-status').textContent = last?.package?.needs === 'update' ? c('updating') : c('upToDate', { version });
      });
      return;
    }
    if (action === 'guide') {
      const cta = target.dataset.cta;
      if (cta === 'retry') { lastSetup = null; void openGuide(4); return; }
      if (legacy) { void perform('setup-start'); return; }
      void openGuide(entryStep(stageNow(), guide.progress[guide.target] || 0));
      return;
    }
    void perform(action, action === 'setup-open-in' ? { browser: target.dataset.browser } : undefined);
  }, { signal });
  pane.addEventListener('keydown', event => {
    if (event.key === 'Escape' && confirming) { event.preventDefault(); event.stopPropagation(); closeConfirm(false); }
  }, { signal });
  const mode = root.querySelector('#bc-connectMode');
  // The guide's page and everything else in it: a target outside the guide is what a deep link or a search result
  // asked to see, so the guide steps aside for it (its progress is kept, and the card says Resume setup).
  const paneOf = () => host?.parentNode || null;
  const outsideGuide = el => { const own = paneOf(); return !!(own && el && el !== own && own.contains?.(el) && !host.contains(el)); };
  // A guide left open (another window, another Settings page) opens where it was: once, when the saved mode is known
  // and is this one, and not over a deep link to something else on the page.
  let restored = false;
  function restoreGuide() {
    restored = true;
    if (!saved.open || pane.hidden) return;
    if ([...(paneOf()?.children || [])].some(child => child !== host && revealRequested(child))) { persist(); return; }
    guide.step = Math.max(1, Math.min(READY_STEP, guide.progress[guide.target] || 1));
    guide.open = true; drawGuide();
  }
  const show = () => {
    // Before the saved mode is known the menu holds its first option, not the owner's: nothing shows, polls or starts.
    pane.hidden = !hydrated || mode?.value !== 'extension';
    if (!hydrated) return;
    if (!restored) restoreGuide();
    // The guide belongs to the extension mode: another mode closes it (its progress is kept).
    if (pane.hidden && guide.open) { guide.open = false; drawGuide(); }
    if (!pane.hidden) void perform('refresh');
  };
  // The owner's own choice in the menu is the mode, whether or not the saved one has arrived.
  const chosen = () => { hydrated = true; show(); };
  mode?.addEventListener('change', chosen, { signal });
  root.querySelectorAll('.bc-dropdown[data-for="bc-connectMode"] .cc-dropdown-item').forEach(item => item.addEventListener('click', chosen, { signal }));
  // Settings' deep links and search results (settings-shell.js revealSettingsTarget) announce their target first.
  root.addEventListener('settings-reveal', event => { if (guide.open && outsideGuide(event.target)) closeGuide({ focus: false }); }, { signal });
  const timer = setInterval(() => { if (hydrated && !pane.hidden && !busy) void perform('refresh'); }, 3000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  show();
  return () => { hydrated = true; show(); };
}
