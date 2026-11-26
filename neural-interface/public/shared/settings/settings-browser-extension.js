// Settings → Browser → "Existing browser via extension". The approved redesign (docs/design/browser-extension:
// "Settings card"): a connection status that says what to do next, the agent access, the tabs agents hold grouped by
// agent with an immediate Take back, the one-button setup, and the rest behind two disclosures. Settings' own markup,
// tokens and 22 px controls; no native dropdown and no new palette.
//
// Layout: the card is one row of the Browser group (`.stg-field`, for the group's row spacing and hairline), but it
// never has a label, an input or a compact control as a DIRECT child: the Settings rule for a compact control
// (`.stg-field:has(> input[type="number"])`) would turn the whole card into a two-column grid and put every help
// paragraph into the same cell (styles.css, "Fields: label, control, one-line help"). Each part is a block of its own
// that reads top to bottom: status, agent access, tabs, setup, files and limits, connection details, the actions.
//
// The mode: "Full control" (the default) or "Only shared sites and tabs". It is the owner's: switched here (POST
// /api/browser/extension/mode, behind the owner route) or in the extension popup, and confirmed first either way.
// The dropdown is the app's .cc-dropdown (Settings wires every .stg-dropdown, wireStgDropdowns); a server from before
// the mode existed reports no `fullControl` and the section stays hidden. Disconnect and Revoke pairing are confirmed
// too; Take back is immediate and never closes the tab.
import { beginExtensionUpdateRead } from '../browser-extension-updates.js';
import { extensionUpdateHTML, wireExtensionUpdate } from './settings-extension-update.js';

const SYMBOL = {
  ok: '<path d="m5 12 4 4 10-10"></path>',
  warn: '<path d="M9 5v14M15 5v14"></path>',
  err: '<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01"></path>',
  off: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"></path>',
  sync: '<path d="M20 7a9 9 0 0 0-15-1L2 9m0-6v6h6M4 17a9 9 0 0 0 15 1l3-3m0 6v-6h-6"></path>',
};
const CHEVRON = '<svg class="cc-section-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

export function extensionSettingsHTML(kit) {
  const t = key => kit.te(`browserExtension.${key}`);
  const c = key => kit.te(`browserExtension.card.${key}`);
  const button = (action, key, extra = '') => `<button type="button" class="cli-detect-btn" data-extension-action="${action}"${extra}>${t(key)}</button>`;
  const modes = [['full', t('modeFull')], ['restricted', t('modeRestricted')]];
  const symbols = Object.entries(SYMBOL).map(([name, path]) => `<svg class="bc-ext-sym" data-sym="${name}" viewBox="0 0 24 24">${path}</svg>`).join('');
  return `${extensionUpdateHTML(kit)}<div class="stg-field bc-extension" id="bc-extension" data-card-state="loading" hidden>
    <div class="bc-ext-head" id="bc-extension-head" data-tone="">
      <div class="bc-ext-status-row">
        <span class="bc-ext-symbol" aria-hidden="true">${symbols}</span>
        <span class="bc-ext-label" id="bc-extension-status-label">${t('statusTitle')}</span>
        <span class="stg-badge bc-ext-status" id="bc-extension-status" role="status" aria-live="polite" aria-labelledby="bc-extension-status-label"></span>
      </div>
      <p class="stg-help bc-ext-text bc-ext-status-help" id="bc-extension-status-help"></p>
      <p class="stg-help bc-ext-text bc-ext-note" id="bc-extension-moved" hidden>${c('movedHelp')}</p>
      <div class="bc-inline-group bc-ext-actions" id="bc-extension-status-actions" hidden>
        <button type="button" class="cli-detect-btn bc-ext-primary" data-extension-action="resume">${c('reconnect')}</button>
        <button type="button" class="cli-detect-btn" data-extension-action="retry" hidden>${c('retry')}</button>
      </div>
    </div>
    <section class="bc-ext-section" data-extension-section="mode" aria-labelledby="bc-extension-mode-title" hidden>
      <div class="bc-ext-mode-row">
        <h4 class="stg-subhead" id="bc-extension-mode-title">${t('modeTitle')}</h4>
        <input type="hidden" id="bc-extension-mode" value="full">
        <div class="cc-dropdown stg-dropdown bc-ext-mode" data-for="bc-extension-mode" role="group">
          <button class="cc-dropdown-trigger" type="button" aria-haspopup="listbox" aria-labelledby="bc-extension-mode-title"><span class="cc-dropdown-value">${modes[0][1]}</span><svg class="cc-dropdown-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button>
          <div class="cc-dropdown-menu">${modes.map(([value, label], i) => `<div class="cc-dropdown-item${i === 0 ? ' active' : ''}" data-value="${value}">${label}</div>`).join('')}</div>
        </div>
      </div>
      <p class="stg-help bc-ext-text" id="bc-extension-mode-help" data-full-text="${t('modeFullHelp')}" data-restricted-text="${t('modeRestrictedHelp')}"></p>
    </section>
    <section class="bc-ext-section" data-extension-section="shared" aria-labelledby="bc-extension-shared-title" hidden>
      <div class="bc-ext-title-row"><h4 class="stg-subhead" id="bc-extension-shared-title">${t('sharedTitle')}</h4><span class="bc-ext-count" id="bc-extension-count"></span></div>
      <p class="stg-help bc-ext-text" id="bc-extension-summary" hidden></p>
      <div class="bc-ext-list" id="bc-extension-tabs" data-empty-text="${t('noTabs')}" data-empty-full-text="${t('noControlled')}"></div>
      <div class="bc-ext-list" id="bc-extension-sites" aria-label="${c('sharedSites')}"></div>
      <p class="stg-help bc-ext-text" id="bc-extension-tabs-help" data-live-text="${c('takeBackHelp')}" data-stale-text="${c('staleHelp')}" hidden></p>
    </section>
    <section class="bc-ext-section" data-extension-section="setup" id="bc-extension-setup" data-state="idle" aria-labelledby="bc-extension-setup-title" hidden>
      <h4 class="stg-subhead" id="bc-extension-setup-title" data-connect-text="${c('settingsTitle')}" data-again-text="${c('setupAgainTitle')}">${c('settingsTitle')}</h4>
      <p class="stg-help bc-ext-text" id="bc-extension-setup-help" data-connect-text="${t('setupHelp')}" data-again-text="${c('setupAgainHelp')}">${t('setupHelp')}</p>
      <div class="bc-inline-group bc-ext-actions">
        <button type="button" class="cli-detect-btn" id="bc-extension-setup-start" data-extension-action="setup-start" data-connect-text="${t('setupConnect')}" data-reconnect-text="${t('setupReconnect')}" data-reinstall-text="${t('setupReinstall')}">${t('setupConnect')}</button>
        <button type="button" class="cli-detect-btn" id="bc-extension-setup-reopen" data-extension-action="setup-reopen" hidden>${c('openGuide')}</button>
        <button type="button" class="cli-detect-btn" id="bc-extension-setup-cancel" data-extension-action="setup-cancel" hidden>${t('setupCancel')}</button>
      </div>
      <p class="stg-help bc-ext-text" id="bc-extension-setup-status" role="status" aria-live="polite"></p>
      <div class="bc-inline-group bc-ext-actions" id="bc-extension-setup-alternatives" hidden></div>
      <p class="stg-help bc-ext-text bc-ext-note" id="bc-extension-setup-default">${c('setupDefault')}</p>
      <p class="stg-help bc-ext-text bc-ext-note" id="bc-extension-reload" data-tone="warn" data-reload-text="${t('reloadNeeded')}" data-repaired-text="${t('reloadRepaired')}" hidden>${t('reloadNeeded')}</p>
      <div class="bc-inline-group bc-ext-actions" id="bc-extension-reload-actions" hidden>
        <button type="button" class="cli-detect-btn" data-extension-action="reload-confirm">${c('reloadConfirm')}</button>
      </div>
      <p class="stg-help bc-ext-text bc-ext-note" id="bc-extension-update" data-tone="warn" role="status" data-updating-text="${c('updating')}" data-failed-text="${c('updateFailed')}" hidden></p>
      <div class="bc-inline-group bc-ext-actions" id="bc-extension-update-actions" hidden>
        <button type="button" class="cli-detect-btn" data-extension-action="update">${c('retry')}</button>
      </div>
    </section>
    <details class="stg-advanced bc-ext-advanced" id="bc-extension-files" data-extension-section="files">
      <summary>${CHEVRON}<span>${c('advanced')}</span></summary>
      <div class="bc-ext-advanced-body">
        <h4 class="stg-subhead" id="bc-extension-uploads-title">${t('uploadsTitle')}</h4>
        <p class="stg-help bc-ext-text" id="bc-extension-upload"></p>
        <p class="stg-help bc-ext-text">${c('uploadHelp')}</p>
        <p class="stg-help bc-ext-text bc-ext-limits">${t('limits')}</p>
      </div>
    </details>
    <details class="stg-advanced bc-ext-advanced" id="bc-extension-details" data-extension-section="details">
      <summary>${CHEVRON}<span>${c('details')}</span></summary>
      <div class="bc-ext-advanced-body">
        <section class="bc-ext-part" data-extension-section="install" aria-labelledby="bc-extension-install-title">
          <h4 class="stg-subhead" id="bc-extension-install-title">${t('installTitle')}</h4>
          <p class="stg-help bc-ext-text">${t('install')}</p>
          <label class="bc-ext-label" for="bc-extension-folder">${t('folder')}</label>
          <div class="bc-ext-control-row">
            <input class="browser-cfg-input bc-ext-path" id="bc-extension-folder" readonly spellcheck="false" autocomplete="off" placeholder="${c('folderPending')}">
            <div class="bc-inline-group bc-ext-actions">${button('copy', 'copy')}${button('refresh', 'refresh')}</div>
          </div>
        </section>
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
      </div>
    </details>
    <div class="bc-ext-footer" id="bc-extension-footer" hidden>
      <div class="bc-inline-group bc-ext-actions">${button('disconnect', 'disconnect')}${button('revoke', 'revoke', ' data-tone="danger"')}</div>
    </div>
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

// ── what the card shows, decided without the DOM (exported for tests) ──
/**
 * The card's state. `data`: GET /api/browser/extension (null when it failed); `setup`: the setup status (when one is
 * running); `failed`: the last read failed; `launching`: the owner's setup start is on its way.
 */
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
/**
 * What the card says about the folder's own update (a folder older than this release's extension, which SynaBun
 * downloads by itself): 'updating' while it is on its way or about to be, 'failed' when it did not arrive, else null.
 */
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

// The badge's tone for each state the card reports (Settings' own .stg-badge-ok / -warn / -err; none is the plain word).
const STATUS_TONES = ['stg-badge-ok', 'stg-badge-warn', 'stg-badge-err'];
const HEAD = {
  connected: ['ok', 'connectedHelp'], disconnected: ['warn', 'disconnectedHelp'], unpaired: ['off', 'unpairedHelp'],
  launching: ['sync', 'launchingHelp'], downloading: ['sync', 'downloadingHelp'], setup: ['sync', 'setupRunningHelp'], pairing: ['sync', 'pairingHelp'],
  unsupported: ['err', 'unsupportedHelp'], error: ['err', 'errorHelp'],
};
const CONFIRMS = {
  disconnect: ['disconnectTitle', 'disconnectBody', 'disconnect'],
  revoke: ['revokeTitle', 'revokeBody', 'revoke'],
  restrict: ['restrictTitle', 'restrictBody', 'restrictConfirm'],
  full: ['fullTitle', 'fullBody', 'fullConfirm'],
};

export function wireExtensionSettings(root, { tx, signal }) {
  wireExtensionUpdate(root, { tx, signal });
  const pane = root.querySelector('#bc-extension'); if (!pane) return;
  const t = (key, params) => tx(`browserExtension.${key}`, params);
  const c = (key, params) => tx(`browserExtension.card.${key}`, params);
  const query = id => root.querySelector(`#bc-extension-${id}`);
  let folder = '', busy = false, full = null, last = null, lastSetup = null, launching = false;
  const pendingTabs = new Set(), failedTabs = new Set();
  function setStatus(text, tone = '') {
    const node = query('status'); node.textContent = text;
    for (const name of STATUS_TONES) node.classList.remove(name);
    if (tone) node.classList.add(`stg-badge-${tone}`);
  }
  async function api(action, body = {}) {
    // `setup/status` is a read; every other action a POST.
    const read = !action || action === 'setup/status';
    const res = await fetch(`/api/browser/extension${action ? '/' + action : ''}`, read ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: JSON.stringify(body), signal });
    const value = await res.json(); if (!res.ok) throw new Error(value.error || t('restart')); return value;
  }
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  // One tab: its title and safe address, and its one action.
  function tabRow(tab, { action, label, aria, disabled }) {
    void action; // take-back or stop-sharing: both end the tab's sharing or holding (revoke-tab)
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
  function empty(node, text) { const p = el('p', 'stg-help bc-ext-empty', text); node.append(p); }
  // The tabs: agents' tabs grouped by agent (Take back), and in restricted mode the shared tabs nobody holds yet (Stop
  // sharing) and the shared sites (Remove). Rebuilt only when what they show changed, so a focused button stays.
  let shownKey = '';
  function showTabs(data, live) {
    const tabs = Array.isArray(data?.tabs) ? data.tabs : [], sites = full ? [] : Array.isArray(data?.sites) ? data.sites : [];
    const groups = groupByAgent(tabs), waiting = full ? [] : tabs.filter(tab => tab && !tab.owner);
    const total = groups.reduce((sum, g) => sum + g.tabs.length, 0);
    const key = JSON.stringify([full, live, groups.map(g => [g.owner, g.tabs.map(x => [x.handle, x.title, shownAddress(x.url)])]), waiting.map(x => [x.handle, x.title, shownAddress(x.url)]), sites, [...pendingTabs], [...failedTabs]]);
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
        box.append(tabRow(tab, { action: 'take-back', label: t('takeBack'), aria: c('takeBackLabel', { title, agent }), disabled: !live }));
      }
      list.append(box);
    }
    if (waiting.length) {
      const box = el('div', 'bc-ext-agent'); box.append(el('div', 'bc-ext-agent-head', c('sharedTabs')));
      for (const tab of waiting) {
        const title = String(tab.title || '').trim() || c('untitledTab');
        box.append(tabRow(tab, { action: 'stop-sharing', label: c('stopSharing'), aria: c('stopSharingLabel', { title }), disabled: !live }));
      }
      list.append(box);
    }
    if (!total && !waiting.length && list.dataset.emptyText) empty(list, full ? list.dataset.emptyFullText : list.dataset.emptyText);
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
    const lead = el('span', 'bc-ext-code-lead', `${t('code')} `);
    const value = el('strong', 'bc-ext-code-value', code);
    const expiry = el('span', 'bc-ext-code-expiry', ` · ${t('expires')}`);
    node.replaceChildren(lead, value, expiry);
  }
  // The mode as the server reports it: the dropdown, its sentence, the tabs part's title. `fullControl` missing is a
  // server from before the mode: the section stays hidden and the card reads as it did.
  function showMode(value, visible = true) {
    full = typeof value === 'boolean' ? value : null;
    const section = pane.querySelector('[data-extension-section="mode"]');
    section.hidden = full === null || !visible;
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
  // The one-button setup ("Connect your browser"): shown only by a server that has it (`setup` in the status). Not
  // paired, it is the card's main action; paired, it is the way to run the setup again (Reconnect while away,
  // Reinstall while connected), lower in the card.
  function showSetup(data, setup, state) {
    const section = query('setup');
    section.hidden = typeof data?.setup !== 'string';
    if (section.hidden) return;
    const running = setup?.state || data.setup;
    section.dataset.state = running;
    const again = !!data.paired && !['setup', 'pairing', 'unsupported', 'launching', 'downloading'].includes(state);
    section.dataset.mode = again ? 'again' : 'connect';
    const title = query('setup-title'), help = query('setup-help');
    title.textContent = again ? title.dataset.againText : title.dataset.connectText;
    help.textContent = again ? help.dataset.againText : help.dataset.connectText;
    const start = query('setup-start');
    // A download that failed is tried again by the same button, under its own words.
    const downloadFailed = running === 'error' && DOWNLOAD_ERRORS.includes(setup?.code);
    start.textContent = downloadFailed ? c('retry') : data.connected ? start.dataset.reinstallText : data.paired ? start.dataset.reconnectText : start.dataset.connectText;
    start.classList.toggle('bc-ext-primary', !data.paired);
    start.disabled = launching;
    const active = !['idle', 'connected'].includes(running);
    start.hidden = ['downloading', 'waiting-for-extension', 'pairing'].includes(running);
    query('setup-cancel').hidden = !active;
    query('setup-reopen').hidden = running !== 'waiting-for-extension';
    query('setup-default').hidden = again || active;
    const name = setup?.browser?.name || '';
    const known = ['downloading', 'waiting-for-extension', 'pairing', 'connected', 'unsupported'].includes(running);
    query('setup-status').textContent = launching ? c('launching') : running === 'idle' ? '' : known ? tx(`browserExtension.setup.settings_${running.replace(/-/g, '_')}`, { browser: name, percent: downloadPercent(setup?.download) })
      : downloadFailed ? tx(`browserExtension.setup.error${setup.code}`) : tx('browserExtension.setup.settings_error', { code: setup?.code || '' });
    const alternatives = query('setup-alternatives'); alternatives.replaceChildren();
    const others = running === 'unsupported' ? (setup?.installedBrowsers || []).filter(b => b?.supported && b.id !== setup?.browser?.id) : [];
    for (const browser of others) {
      const option = el('button', 'cli-detect-btn', tx('browserExtension.setup.openIn', { browser: browser.name })); option.type = 'button';
      option.dataset.extensionAction = 'setup-open-in'; option.dataset.browser = browser.id;
      alternatives.append(option);
    }
    alternatives.hidden = !others.length;
    // The browser's Reload: for an older copy or a port change, or in a repair's own words (files that were not the
    // extension were replaced, and the browser may still run them). Said until the setup page sees the extension (a port change) or
    // the owner confirms the Reload below (a repair).
    const reload = query('reload'), reloadText = data.reloadRepaired === true ? reload.dataset.repairedText : reload.dataset.reloadText;
    reload.hidden = !!data.update || !(data.reloadNeeded === true);
    if (reloadText && reload.textContent !== reloadText) reload.textContent = reloadText;
    // A repair's Reload ends only by the owner's click here (POST reload/confirm): the copy the browser still runs
    // would answer the setup page just the same, so nothing it says, nor any refresh of this card, clears it.
    query('reload-actions').hidden = !!data.update || !(data.reloadNeeded === true && data.reloadRepaired === true);
    // The folder's own update (never while a setup shows its own download): on its way, or failed with Try again.
    const update = active || data.update ? null : updateNote(data), note = query('update');
    note.hidden = !update; note.textContent = update ? (update === 'failed' ? note.dataset.failedText : note.dataset.updatingText) : '';
    query('update-actions').hidden = update !== 'failed';
  }
  // The status at the top: a symbol, the word (Settings' badge), what it means, the one action that helps.
  function showHead(state, data, error) {
    const [tone, help] = HEAD[state] || HEAD.error;
    pane.dataset.cardState = state;
    query('head').dataset.tone = tone;
    const modeWord = full === null ? '' : ` · ${t(full ? 'statusFull' : 'statusRestricted')}`;
    if (error) setStatus(`${t('restart')} ${error}`, 'err');
    else if (state === 'connected') setStatus(`${t('connected')}${modeWord}`, 'ok');
    else if (state === 'disconnected') setStatus(`${t('disconnected')}${modeWord}`, 'warn');
    else if (['setup', 'pairing', 'launching', 'downloading'].includes(state)) setStatus(c(state === 'setup' ? 'setupRunningTitle' : state, { browser: lastSetup?.browser?.name || '' }));
    else if (state === 'unsupported') setStatus(c('unsupported'));
    else setStatus(t('unpaired'));
    query('status-help').textContent = c(help, { browser: lastSetup?.browser?.name || '' });
    const actions = query('status-actions');
    const resume = actions.querySelector('[data-extension-action="resume"]'), retry = actions.querySelector('[data-extension-action="retry"]');
    resume.hidden = state !== 'disconnected'; retry.hidden = !error;
    // Paired, and the browser stays away: the extension may have been loaded from the old folder inside the app.
    query('moved').hidden = !(state === 'disconnected' && !error);
    actions.hidden = resume.hidden && retry.hidden;
    query('footer').hidden = !data?.paired;
    query('files').hidden = !data?.paired;
  }
  function render(error = '') {
    const data = last, state = cardState(data, lastSetup, { failed: !!error, launching });
    if (data) {
      folder = data.folder; query('folder').value = folder || ''; query('folder').title = folder || '';
      const path = el('code', 'bc-ext-path-text', data.uploadFolder ?? ''); path.title = data.uploadFolder ?? '';
      query('upload').replaceChildren(`${t('upload')} `, path);
    }
    const connected = !!data?.connected;
    showMode(data?.fullControl, connected);
    showSetup(data, lastSetup, state);
    showHead(state, data, error);
    // Full control: the server lists every tab of the browser; the card shows the ones agents hold. Sites are not
    // shared in that mode. While the browser is away the last tabs stay, marked out of date, their actions off.
    const section = pane.querySelector('[data-extension-section="shared"]');
    section.hidden = !data || !(connected || (data.paired && (data.tabs || []).some(tab => tab.owner)));
    showTabs(data, connected && !error);
  }
  async function refresh() {
    const accept = beginExtensionUpdateRead();
    const data = await api();
    let setup = null;
    if (typeof data.setup === 'string' && data.setup !== 'idle') { try { setup = await api('setup/status'); } catch { setup = null; } }
    last = data; lastSetup = setup;
    if (!signal.aborted) accept(data.update || null);
    render();
  }
  async function takeBack(handle) {
    if (pendingTabs.has(handle)) return;
    pendingTabs.add(handle); failedTabs.delete(handle); render();
    try { await api('revoke-tab', { tab: handle }); }
    catch { failedTabs.add(handle); }
    finally { pendingTabs.delete(handle); }
    try { await refresh(); } catch (error) { if (!signal.aborted) render(error.message); }
  }
  // Confirmations: in the card itself (it lives inside the Settings dialog), Cancel focused first, Escape cancels, the
  // focus returns to the control that asked.
  let confirming = null;
  function confirmFirst(kind, opener, then) {
    const [title, body, ok] = CONFIRMS[kind];
    const box = query('confirm');
    query('confirm-title').textContent = c(title); query('confirm-body').textContent = c(body);
    const button = query('confirm-ok'); button.textContent = c(ok); button.dataset.kind = kind;
    box.dataset.kind = kind;
    // Next to what asked: after the part of the card that holds the control.
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
      else if (action === 'setup-start' || action === 'setup-open-in') {
        launching = true; render();
        try { await api('setup/start', action === 'setup-open-in' ? { browser: body?.browser } : {}); } finally { launching = false; }
      }
      else if (action === 'setup-cancel') await api('setup/cancel', {});
      else if (action === 'setup-reopen') await api('setup/reopen', {});
      else if (action === 'reload-confirm') await api('reload/confirm', { reloaded: true });
      else if (!['refresh', 'retry'].includes(action)) {
        const data = await api(action, body || (action === 'pair' ? { port: Number(query('port').value) } : {}));
        if (action !== 'mode') showCode(action === 'pair' ? data.code : null);
        if (action === 'pair') setTimeout(() => { if (!signal.aborted) showCode(null); }, 120000);
      }
      await refresh();
    } catch (error) { if (!signal.aborted) render(error.message); }
    finally {
      busy = false;
      if (queuedMode) { const next = queuedMode; queuedMode = null; if (next.fullControl !== full) void perform('mode', next); }
    }
  }
  // The owner's mode switch: the dropdown writes its hidden input and fires `change`; the change is confirmed first,
  // and a cancelled one puts the dropdown back.
  query('mode').addEventListener('change', () => {
    const next = query('mode').value === 'full';
    if (next === full) return;
    const trigger = pane.querySelector('.bc-ext-mode .cc-dropdown-trigger'), current = full;
    confirmFirst(next ? 'full' : 'restrict', trigger, () => perform('mode', { fullControl: next }));
    confirming.cancelled = () => showMode(current, true);
  }, { signal });
  pane.addEventListener('click', event => {
    const target = event.target.closest('[data-extension-action]'), action = target?.dataset.extensionAction;
    if (!action) return;
    if (action === 'confirm-cancel') { closeConfirm(false); return; }
    if (action === 'confirm-ok') { closeConfirm(true); return; }
    if (action === 'disconnect' || action === 'revoke') { confirmFirst(action, target, () => perform(action)); return; }
    void perform(action, action === 'setup-open-in' ? { browser: target.dataset.browser } : undefined);
  }, { signal });
  pane.addEventListener('keydown', event => {
    if (event.key === 'Escape' && confirming) { event.preventDefault(); event.stopPropagation(); closeConfirm(false); }
  }, { signal });
  const mode = root.querySelector('#bc-connectMode');
  const show = () => { pane.hidden = mode?.value !== 'extension'; if (!pane.hidden) void perform('refresh'); };
  mode?.addEventListener('change', show, { signal });
  root.querySelectorAll('.bc-dropdown[data-for="bc-connectMode"] .cc-dropdown-item').forEach(item => item.addEventListener('click', show, { signal }));
  const timer = setInterval(() => { if (!pane.hidden && !busy) void perform('refresh'); }, 3000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  show(); return show;
}
