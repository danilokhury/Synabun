// The toolbar popup's DOM glue (popup.html). popup-view.js decides what is shown; this renders it and sends the owner's
// actions to the service worker, which alone acts on them (docs/browser-extension-bridge.md). The messages are the
// ones the worker has always taken from this page: status, pair, share, revokeTab, revokeSite, options, mode,
// disconnect, resume, revoke. Disconnect, Revoke pairing, a mode change and removing a shared site are confirmed
// first; Take back is immediate (the owner's fast interrupt) and never closes the tab.
import { publicOrigin, hostPattern } from './protocol.js';
import { popupLocale, translator } from './popup-strings.js';
import { popupView } from './popup-view.js';

const $ = id => document.getElementById(id);
const locale = popupLocale([globalThis.chrome?.i18n?.getUILanguage?.(), ...(globalThis.navigator?.languages || []), globalThis.navigator?.language].filter(Boolean));
const t = translator(locale);
const coded = code => Object.assign(new Error(code), { code });

async function ask(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw Object.assign(new Error(result?.error || 'EXTENSION_UNAVAILABLE'), { code: result?.code || 'EXTENSION_UNAVAILABLE' });
  return result;
}
// Whether a pairing credential is stored: its size only, never its value. null where the browser cannot say.
async function storedPairing() {
  try { const bytes = await chrome.storage.local.getBytesInUse?.('credential'); return typeof bytes === 'number' ? bytes > 0 : null; }
  catch { return null; }
}
// SynaBun's own address, from this extension's manifest (the setup page's content script names the app's origin).
function appOrigin() {
  try {
    const own = chrome.runtime.getManifest().content_scripts || [];
    const pattern = own.flatMap(entry => entry.js?.includes('setup-content.js') ? entry.matches || [] : [])[0];
    if (pattern) return new URL(pattern.replace(/\*$/, '')).origin;
  } catch {}
  return 'http://127.0.0.1:3344';
}
const openTab = url => chrome.tabs.create({ url });

// ── the words that never change while the popup is open ──
function fixedText() {
  document.documentElement.lang = locale;
  const set = (id, key) => { const node = $(id); if (node) node.textContent = t(key); };
  set('p-brand-sub', 'brandSub');
  const openApp = $('p-open-app'); openApp.setAttribute('aria-label', t('openApp')); openApp.setAttribute('title', t('openApp'));
  set('p-footer-app', 'openApp'); set('disconnect', 'disconnect'); set('revoke', 'revoke');
  set('p-mode-label', 'agentAccess'); set('p-mode-full', 'full'); set('p-mode-restricted', 'restricted');
  set('p-empty-title', 'emptyTitle'); set('p-empty-help', 'emptyHelp');
  set('p-shared-title', 'sharedSites'); set('p-shared-empty-title', 'noShared'); set('p-shared-empty-help', 'noSharedHelp'); set('p-waiting-title', 'sharedTabs');
  set('share', 'shareTab'); set('site', 'shareSite'); set('p-newtabs-label', 'newTabs'); set('p-uploads-label', 'uploads');
  set('p-files-summary', 'advanced'); set('p-downloads-label', 'downloads'); set('p-download-note', 'downloadNote'); set('p-downloads-denied', 'downloadsDenied');
  set('p-upload-title', 'uploadFolder'); set('p-upload-help', 'uploadHelpPopup'); set('p-limits', 'limits');
  set('p-connection-summary', 'details'); set('p-bridge-label', 'bridge');
  set('p-pair-summary', 'pairCode'); set('p-pair-help', 'pairCodeHelp'); set('p-port-label', 'pairPort'); set('p-code-label', 'pairCodeLabel'); set('p-pair-submit', 'pairAction');
  set('p-confirm-cancel', 'cancel');
}

// ── state ──
let view = null, lastState = '', refreshing = false, portTouched = false;
const busy = new Set(), rowErrors = new Set();

const SYMBOLS = { connected: 'good', disconnected: 'warn', connecting: 'sync', reconnecting: 'sync', loading: 'sync', error: 'bad', unpaired: 'link' };
const PRIMARY_LABEL = { resume: 'reconnect', connect: 'connect', retry: 'retry', 'open-app': 'openApp' };

// Children of `container` follow `items` in order, each kept by its key so focus and scroll survive a refresh.
function reconcile(container, items, key, make, update) {
  const existing = new Map([...container.children].map(el => [el.dataset.key, el]));
  items.forEach((item, i) => {
    const k = key(item);
    let el = existing.get(k);
    if (!el) { el = make(item); el.dataset.key = k; }
    existing.delete(k);
    update(el, item);
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
  for (const el of existing.values()) el.remove();
}
function element(tag, className, attrs = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}
function textOnce(node, text) { if (node.textContent !== text) node.textContent = text; }

// A tab row: its title and safe address, and one action (Take back, or Stop sharing for a shared tab nobody holds).
function makeRow(kind) {
  return () => {
    const row = element('div', 'p-row');
    const text = element('div', 'p-row-text');
    text.append(element('span', 'p-row-title'), element('span', 'p-row-address'));
    const button = element('button', 'p-btn', { type: 'button', 'data-action': kind });
    const error = element('p', 'p-row-error', { role: 'alert' }); error.hidden = true;
    row.append(text, button, error);
    return row;
  };
}
function updateRow(row, tab, { kind, agent = '', disabled }) {
  row.dataset.handle = tab.handle; row.dataset.stale = String(!!disabled);
  const [text, button, error] = row.children;
  const [title, address] = text.children;
  textOnce(title, tab.title); title.setAttribute('title', tab.title);
  textOnce(address, tab.address);
  button.dataset.handle = tab.handle;
  const pending = busy.has(tab.handle);
  textOnce(button, t(pending ? 'busy' : kind === 'take-back' ? 'takeBack' : 'stopSharing'));
  button.setAttribute('aria-label', kind === 'take-back' ? t('takeBackLabel', { title: tab.title, agent }) : t('stopSharingLabel', { title: tab.title }));
  button.disabled = !!disabled || pending;
  error.hidden = !rowErrors.has(tab.handle);
  textOnce(error, rowErrors.has(tab.handle) ? t('actionError') : '');
}

function render(next) {
  view = next;
  const popup = $('popup');
  popup.dataset.state = view.state; popup.setAttribute('aria-busy', 'false');
  // status
  const status = $('p-status'); status.dataset.tone = view.tone; status.dataset.sym = SYMBOLS[view.state] || 'sync';
  textOnce($('p-status-title'), view.title); textOnce($('p-status-help'), view.help);
  const primary = $('p-primary');
  primary.hidden = !view.primary; $('p-status-actions').hidden = !view.primary;
  if (view.primary) { primary.dataset.action = view.primary; textOnce(primary, t(PRIMARY_LABEL[view.primary])); primary.className = `p-btn ${view.primary === 'open-app' ? '' : 'p-btn-primary'}`.trim(); }
  // A connection change is announced once, never every poll.
  if (view.state !== lastState) { lastState = view.state; $('p-live').textContent = `${t('statusLabel')}: ${view.title}`; }
  // agent access
  $('p-mode').hidden = !view.showMode;
  const chosen = view.full ? 'full' : 'restricted';
  textOnce($('p-mode-value'), t(chosen));
  for (const option of $('p-mode-list').children) option.setAttribute('aria-selected', String(option.dataset.value === chosen));
  textOnce($('p-mode-help'), t(view.full ? 'fullHelp' : 'restrictedHelp'));
  // activity: the tabs agents hold, by agent
  $('p-activity').hidden = !view.showActivity;
  const total = view.groups.reduce((sum, g) => sum + g.tabs.length, 0);
  textOnce($('p-activity-title'), t(view.stale ? 'pausedTabs' : 'controlled'));
  textOnce($('p-activity-count'), total ? String(total) : '');
  $('p-activity-summary').hidden = !total; textOnce($('p-activity-summary'), view.summary);
  reconcile($('p-groups'), view.groups, g => g.owner, () => {
    const group = element('div', 'p-agent');
    const heading = element('div', 'p-agent-heading');
    heading.append(element('span', 'p-agent-mark', { 'aria-hidden': 'true' }), element('span', 'p-agent-name'));
    group.append(heading, element('div', 'p-agent-tabs'));
    return group;
  }, (group, g) => {
    const [heading, list] = group.children;
    textOnce(heading.children[0], g.mark); textOnce(heading.children[1], g.label);
    reconcile(list, g.tabs, tab => tab.handle, makeRow('take-back'), (row, tab) => updateRow(row, tab, { kind: 'take-back', agent: g.label, disabled: !view.live }));
  });
  $('p-empty').hidden = !(view.live && !total);
  textOnce($('p-activity-help'), t(view.stale ? 'staleHelp' : 'takeBackHelp'));
  $('p-activity-help').hidden = !total;
  // restricted mode: what the owner shares
  $('p-shared').hidden = !view.showShared;
  reconcile($('p-sites'), view.sites, site => site, () => {
    const row = element('div', 'p-row');
    const text = element('div', 'p-row-text'); text.append(element('code', 'p-row-title'));
    row.append(text, element('button', 'p-btn p-btn-ghost p-btn-danger', { type: 'button', 'data-action': 'confirm-site' }));
    return row;
  }, (row, site) => {
    textOnce(row.children[0].children[0], site);
    const button = row.children[1]; button.dataset.site = site; textOnce(button, t('removeSite')); button.setAttribute('aria-label', t('removeSiteLabel', { site }));
  });
  reconcile($('p-waiting'), view.showShared ? view.waiting : [], tab => tab.handle, makeRow('stop-sharing'), (row, tab) => updateRow(row, tab, { kind: 'stop-sharing', disabled: !view.live }));
  $('p-waiting-title').hidden = !view.waiting.length;
  $('p-shared-empty').hidden = !!(view.sites.length || view.waiting.length);
  $('newTabs').checked = view.options.allowNewTabs; $('uploads').checked = view.options.uploads; $('downloads').checked = view.options.downloads;
  // files and limits, the typed code
  $('p-files').hidden = !view.showFiles;
  textOnce($('p-bridge'), `127.0.0.1:${view.port}`);
  $('p-pair-code').hidden = !view.showPairCode;
  if (!portTouched) $('port').value = String(view.port);
  // footer
  $('disconnect').hidden = !view.canDisconnect;
  $('revoke').hidden = !view.canRevoke;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    let result = null;
    try { result = await ask({ action: 'status' }); } catch { result = null; }
    render(popupView(result, { paired: result ? await storedPairing() : null, t }));
  } finally { refreshing = false; }
}

// ── feedback ──
let toastTimer;
function toast(text, tone = '') {
  const node = $('p-toast'); node.textContent = text; node.dataset.tone = tone;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.textContent = ''; }, 6000);
}
function failure(error) {
  const code = String(error?.code || '');
  if (code === 'SITE_DENIED') return t('siteDenied');
  if (code === 'EXTENSION_UNAVAILABLE') return t('unavailable');
  return t('actionFailed', { code: code || 'OPERATION_FAILED' });
}
// Runs one owner action, says how it went, and shows the worker's state after it.
async function run(fn, done) {
  try { await fn(); if (done) toast(done); }
  catch (error) { toast(failure(error), 'bad'); }
  await refresh();
}

// ── confirmations (a styled <dialog>; Cancel has the focus first; focus returns where it came from) ──
const CONFIRMS = {
  disconnect: ['disconnectTitle', 'disconnectBody', 'disconnect', 'danger'],
  revoke: ['revokeTitle', 'revokeBody', 'revoke', 'danger'],
  restrict: ['restrictTitle', 'restrictBody', 'restrictConfirm', 'primary'],
  full: ['fullTitle', 'fullBody', 'fullConfirm', 'primary'],
  site: ['removeTitle', 'removeBody', 'removeSite', 'danger'],
};
let pending = null;
function confirmFirst(kind, opener, action) {
  const [title, body, ok, tone] = CONFIRMS[kind];
  const dialog = $('p-confirm');
  $('p-confirm-title').textContent = t(title); $('p-confirm-body').textContent = t(body);
  const button = $('p-confirm-ok'); button.textContent = t(ok); button.className = `p-btn p-btn-${tone}`;
  dialog.dataset.kind = kind;
  pending = { action, opener };
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  $('p-confirm-cancel').focus();
}
function closeConfirm() {
  const dialog = $('p-confirm'), opener = pending?.opener;
  pending = null;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close(); else dialog.removeAttribute('open');
  if (opener?.isConnected && !opener.hidden) opener.focus(); else $('p-status-title').focus?.();
}

// ── the mode dropdown: the app's .cc-dropdown keyboard model (never a native select) ──
const trigger = () => $('p-mode-trigger'), options = () => [...$('p-mode-list').children];
let highlighted = 0, typed = '', typedAt = 0;
function openMenu(open) {
  const menu = $('p-mode-list');
  menu.hidden = !open; trigger().setAttribute('aria-expanded', String(open));
  if (open) highlight(options().findIndex(o => o.getAttribute('aria-selected') === 'true'));
  else { trigger().removeAttribute('aria-activedescendant'); for (const o of options()) o.classList.remove('p-highlight'); }
}
function highlight(index) {
  const list = options();
  highlighted = Math.max(0, Math.min(list.length - 1, index));
  list.forEach((o, i) => o.classList.toggle('p-highlight', i === highlighted));
  trigger().setAttribute('aria-activedescendant', list[highlighted].id);
}
function choose(value) {
  openMenu(false); trigger().focus();
  const full = value === 'full';
  if (!view || full === view.full) return;
  confirmFirst(full ? 'full' : 'restrict', trigger(), () => run(() => ask({ action: 'mode', fullControl: full }), t('modeSaved')));
}
function menuKey(event) {
  const open = trigger().getAttribute('aria-expanded') === 'true', list = options();
  if (event.key === 'Tab') { if (open) openMenu(false); return; }
  if (event.key === 'Escape') { if (open) { event.preventDefault(); openMenu(false); } return; }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Enter', ' '].includes(event.key)) {
    event.preventDefault();
    if (!open) { openMenu(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { choose(list[highlighted].dataset.value); return; }
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[event.key];
    highlight(event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : highlighted + step);
    return;
  }
  if (event.key?.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (Date.now() - typedAt > 600) typed = '';
    typedAt = Date.now(); typed += event.key.toLowerCase();
    if (!open) openMenu(true);
    const i = list.findIndex(o => o.textContent.toLowerCase().startsWith(typed));
    if (i >= 0) highlight(i);
  }
}

// ── actions ──
function nextFocus(button) {
  // After a row leaves, the focus goes to the next row's action, else the previous one, else the section title.
  const all = [...$('popup').querySelectorAll('[data-action="take-back"]')];
  const i = all.indexOf(button);
  return all[i + 1] || all[i - 1] || null;
}
async function takeBack(button, verb) {
  const handle = button.dataset.handle;
  if (!handle || busy.has(handle)) return;
  const after = nextFocus(button);
  busy.add(handle); rowErrors.delete(handle); render(view);
  let ok = false;
  try { await ask({ action: 'revokeTab', tab: handle }); ok = true; }
  catch { rowErrors.add(handle); }
  finally { busy.delete(handle); }
  await refresh();
  if (ok) {
    toast(t(verb === 'take-back' ? 'takenBack' : 'saved'));
    if (!button.isConnected) (after?.isConnected ? after : $('p-activity-title'))?.focus?.();
  }
}
async function act(action, target) {
  if (action === 'open-app') { await openTab(`${appOrigin()}/`); return; }
  if (action === 'connect') { await openTab(`${appOrigin()}/extension-setup`); toast(t('connectOpened')); return; }
  if (action === 'retry') { await refresh(); return; }
  if (action === 'resume') { await run(() => ask({ action: 'resume' }), t('reconnectingToast')); return; }
  if (action === 'confirm-disconnect') { confirmFirst('disconnect', target, () => run(() => ask({ action: 'disconnect' }), t('disconnectedToast'))); return; }
  if (action === 'confirm-revoke') { confirmFirst('revoke', target, () => run(() => ask({ action: 'revoke' }), t('revokedToast'))); return; }
  if (action === 'confirm-site') { const site = target.dataset.site; confirmFirst('site', target, () => run(() => ask({ action: 'revokeSite', site }), t('saved'))); return; }
  if (action === 'take-back' || action === 'stop-sharing') { await takeBack(target, action); return; }
  if (action === 'cancel-confirm') { closeConfirm(); return; }
  if (action === 'do-confirm') { const next = pending?.action; closeConfirm(); if (next) await next(); return; }
  // Restricted mode: share the browser's active tab (and its site), or only its site for new tabs. The site permission
  // is asked in this click, as before.
  if (action === 'share' || action === 'site') {
    const siteOnly = action === 'site';
    await run(async () => {
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      const site = publicOrigin(tab?.url);
      if (!await chrome.permissions.request({ origins: [hostPattern(site)] })) throw coded('SITE_DENIED');
      await ask({ action: 'share', tab: tab.id, siteOnly });
    }, t(siteOnly ? 'siteToast' : 'sharedToast'));
  }
}

function wire() {
  document.addEventListener('click', event => {
    const option = event.target.closest?.('[role="option"]');
    if (option && $('p-mode-list').contains(option)) { choose(option.dataset.value); return; }
    if (event.target.closest?.('.p-dropdown-trigger')) { openMenu(trigger().getAttribute('aria-expanded') !== 'true'); return; }
    const target = event.target.closest?.('[data-action]');
    if (target && !target.disabled) void act(target.dataset.action, target);
  });
  trigger().addEventListener('keydown', menuKey);
  document.addEventListener('pointerdown', event => { if (!event.target.closest?.('.p-dropdown')) openMenu(false); });
  const dialog = $('p-confirm');
  // Escape cancels (the dialog's own cancel event); the focus goes back to the control that opened it.
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeConfirm(); });
  for (const id of ['newTabs', 'uploads', 'downloads']) $(id).addEventListener('change', () => run(async () => {
    $('p-downloads-denied').hidden = true;
    if (id === 'downloads' && $('downloads').checked && !await chrome.permissions.request({ permissions: ['downloads'] })) {
      $('downloads').checked = false; $('p-downloads-denied').hidden = false; $('p-files').open = true;
    }
    await ask({ action: 'options', options: { allowNewTabs: $('newTabs').checked, uploads: $('uploads').checked, downloads: $('downloads').checked } });
  }, t('saved')));
  $('port').addEventListener('input', () => { portTouched = true; });
  $('pair').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => { await ask({ action: 'pair', code: $('code').value, port: Number($('port').value) }); $('code').value = ''; }, t('pairStarted'));
  });
}

fixedText();
wire();
render(popupView(undefined, { t }));
await refresh();
const timer = setInterval(() => { void refresh(); }, 1500);
window.addEventListener('unload', () => clearInterval(timer));
