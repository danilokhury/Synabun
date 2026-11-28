// The "Connect your browser" page's DOM glue (public/extension-setup.html). What it shows is decided by es-view.js;
// this reads the server's setup status, renders, and does the page's few actions. The one-time token goes into
// #synabun-setup-ticket only while the extension's content script is on this page and the server waits for it, and is
// taken out again as soon as the setup moves on.
import { extensionUpdateView } from '../extension-update-view.js';
import { makeTranslator, pageLocale, pageTurns, revealKey, setupView, wantsTicket } from './es-view.js';

const $ = id => document.getElementById(id);
let t = key => key;
const tx = (key, params) => t(`browserExtension.setup.${key}`, params);
const API = '/api/browser/extension/setup';
let status = { state: 'idle' }, offeredAt = 0, tickets = 0, busy = false;

async function call(path, body) {
  const res = await fetch(`${API}/${path}`, body === undefined ? { cache: 'no-store' }
    : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: JSON.stringify(body) });
  const value = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(value.error || res.statusText), { code: value.code });
  return value;
}
const extensionSeen = () => document.documentElement.dataset.synabunExtension || '';
const pairAnswer = () => document.documentElement.dataset.synabunPair || '';
function clearTicket() { const node = $('synabun-setup-ticket'); delete node.dataset.token; delete node.dataset.bridgePort; }

// ── One pairing page at a time ──
// The guide's "Copy address & open <Browser>" opens this page with ?focus=1 only to bring the browser forward: the
// owner pastes the extensions address over it. That page never asks for a token (es-view.js `focus`).
const FOCUS_ONLY = (() => { try { return new URLSearchParams(globalThis.location?.search || '').get('focus') === '1'; } catch { return false; } })();
// The pairing page may still be open more than once: only the newest one that sees the extension asks for tokens
// (es-view.js pageTurns). The others wait with no token on the page, and ask afresh once their turn comes back.
let peers = null, waitingTurn = false;
try { if (!FOCUS_ONLY && typeof BroadcastChannel === 'function') { peers = new BroadcastChannel('synabun-extension-setup'); peers.unref?.(); } } catch { peers = null; }
const turns = pageTurns({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, born: Date.now(), channel: peers });
globalThis.addEventListener?.('pagehide', () => turns.gone());

// Text that changed only: the same words set again would be read out again by a screen reader on every poll.
const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };
// The words that never change while the page is open.
function fixedText() {
  put($('es-browser-label'), tx('browserLabel'));
  put($('es-copy-url'), tx('copyAddress')); put($('es-copy-folder'), tx('copyFolder'));
  put($('es-folder-label'), tx('folderLabel'));
  put($('es-reveal'), tx(revealKey(navigator.userAgentData?.platform || navigator.platform || '')));
  put($('es-alternatives-title'), tx('alternativesTitle'));
  put($('es-back'), tx('backToApp')); put($('es-pin'), tx('pinTip'));
  put($('es-full-title'), tx('fullTitle')); put($('es-full-help'), tx('fullHelp'));
  put($('es-trouble-title'), tx('needHelp')); put($('es-trouble-help'), tx('helpText')); put($('es-moved-help'), tx('movedText')); put($('es-policy-help'), tx('policyText'));
}
function render() {
  const view = setupView(status, { extensionVersion: extensionSeen(), pairAnswer: pairAnswer(), focus: FOCUS_ONLY });
  const update = extensionUpdateView(status.update, t);
  const updating = update && ['idle', 'connected'].includes(view.state);
  const main = $('es-setup');
  main.dataset.state = view.state; main.dataset.layout = view.layout; main.setAttribute('aria-busy', 'false');
  // The Settings guide's companion: the same page, its steps left to Settings (es-view.js `companion`).
  main.dataset.companion = String(view.companion);
  put($('es-title'), updating ? update.title : tx(view.title));
  $('es-lead').hidden = !!updating;
  put($('es-lead'), tx(view.lead, { browser: view.browser }));
  $('es-eyebrow').hidden = !view.eyebrow; put($('es-eyebrow'), view.eyebrow ? tx(view.eyebrow, { browser: view.browser }) : '');
  const live = $('es-live'); put(live, updating ? update.message : tx(view.live, view.liveParams)); live.dataset.tone = updating ? (update.due ? 'warn' : 'ok') : view.tone;
  $('es-status').dataset.tone = live.dataset.tone || 'idle';
  put($('es-status-title'), updating ? t('browserExtension.statusTitle') : tx(view.statusTitle));
  $('es-help').hidden = !!updating || !view.help; put($('es-help'), view.help ? tx(view.help) : '');
  $('es-progress').hidden = !view.progress; put($('es-progress'), view.progress ? tx('downloadProgress', view.progress) : '');
  $('es-browser').hidden = !view.browser; put($('es-browser-name'), view.browser);
  $('es-steps').hidden = !!updating || !view.showSteps;
  for (const step of view.steps) {
    const id = { stepOpenTitle: 'open', stepDeveloperTitle: 'developer', stepLoadTitle: 'load', stepPairTitle: 'pair' }[step.title];
    put($(`es-step-${id}-title`), tx(step.title));
    put($(`es-step-${id}`), tx(step.key, { ...step.params, browser: view.browser }));
    main.querySelector(`[data-step="${id}"]`).dataset.done = String(step.done);
  }
  put($('es-extensions-url'), view.extensionsUrl || '');
  $('es-copy-url').hidden = !view.extensionsUrl;
  put($('es-folder'), view.folder);
  $('es-copy-folder').hidden = $('es-reveal').hidden = !view.folder;
  $('es-alternatives').hidden = !view.showAlternatives;
  const list = $('es-alternatives-list'), wanted = view.alternatives.map(b => `${b.id}:${b.name}`).join('|');
  if (list.dataset.shown !== wanted) {
    list.dataset.shown = wanted; list.replaceChildren();
    for (const browser of view.alternatives) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'es-button';
      button.dataset.action = 'open-in'; button.dataset.browser = browser.id; button.textContent = tx('openIn', { browser: browser.name });
      list.append(button);
    }
  }
  const note = update ? (!updating && update.due ? [update.title, update.message].join(' ') : '')
    : view.reloadNeeded || view.updateNeeded ? tx(view.updateNeeded ? 'updateNeeded' : view.reloadRepaired ? 'reloadRepaired' : 'reloadNeeded', { browser: view.browser }) : '';
  $('es-reload').hidden = !note; put($('es-reload'), note);
  $('es-update-flow').hidden = !update?.due; put($('es-update-flow'), t('browserExtension.updateFlow.review'));
  $('es-restart').hidden = !!updating || !view.restart; put($('es-restart'), tx(view.restartLabel));
  $('es-back').hidden = updating ? update.due : !view.back; $('es-pin').hidden = !!updating || !view.pinTip;
  // The row is hidden by the code that fills it (never found by a :has(), which every hidden toggle re-checks).
  $('es-actions').hidden = $('es-restart').hidden && $('es-back').hidden && $('es-update-flow').hidden;
  if (!['waiting-for-extension', 'extension-found'].includes(view.state)) clearTicket();
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    status = await call('status');
    // The extension's content script ran on this page, on this port: the browser runs the folder's manifest for it, so
    // the Reload a port change asked for is done (the server keeps saying "reload" until then). Never for a repair: the
    // copy the browser still runs would answer the same, so this page only says to confirm in SynaBun Settings (and the
    // server ignores `seen` for it anyway).
    if (status.reloadNeeded && !status.reloadRepaired && (!status.update || status.update.reason === 'port') && extensionSeen() && extensionSeen() === status.folderVersion) status = await call('seen', {});
    if (extensionSeen()) turns.here();
    const turn = !FOCUS_ONLY && turns.mine();
    // A newer pairing page took over: this one's token comes off the page. Its turn again: a fresh token, at once.
    if (!turn) { waitingTurn = true; clearTicket(); }
    else if (waitingTurn) { waitingTurn = false; offeredAt = 0; }
    if (turn && wantsTicket(status, { extensionVersion: extensionSeen(), pairAnswer: pairAnswer(), offeredAt, tickets })) {
      tickets++;
      const ticket = await call('ticket', {});
      delete document.documentElement.dataset.synabunPair;
      const node = $('synabun-setup-ticket'); node.dataset.bridgePort = String(ticket.bridgePort); node.dataset.token = ticket.token;
      offeredAt = Date.now();
    }
  } catch (error) { if (status.state !== 'connected') status = { ...status, state: 'error', code: error.code || '' }; }
  finally { busy = false; render(); }
}

async function act(action, target) {
  const note = $('es-copied');
  try {
    if (action === 'copy-url') { await navigator.clipboard.writeText(status.browser?.extensionsUrl || '').then(() => { note.textContent = tx('copiedAddress'); }, () => { note.textContent = tx('copyFailed'); }); }
    else if (action === 'copy-folder') { await navigator.clipboard.writeText(status.folder || '').then(() => { note.textContent = tx('copiedFolder'); }, () => { note.textContent = tx('copyFailed'); }); }
    else if (action === 'reveal') { const r = await call('reveal', {}); note.textContent = tx(r.ok === false ? 'revealFailed' : 'revealed'); }
    else if (action === 'open-in') { status = await call('start', { browser: target.dataset.browser }); offeredAt = 0; tickets = 0; note.textContent = tx('openedIn', { browser: status.browser?.name || '' }); }
    // Beside the Settings guide this starts the guide's kind of setup again (nothing opened); otherwise the page's own.
    else if (action === 'restart') { status = await call('start', setupView(status).restartBody); offeredAt = 0; tickets = 0; note.textContent = ''; }
  } catch (error) { note.textContent = error.message; }
  render();
}

// The browser's language (pt → Português, else English), English behind it key by key.
{
  const locale = pageLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
  const load = name => fetch(`/i18n/${name}.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  const [english, active] = await Promise.all([load('en'), locale === 'en' ? null : load(locale)]);
  t = makeTranslator(active || english, english);
  document.documentElement.lang = locale;
}
document.title = tx('documentTitle');
fixedText();
document.addEventListener('click', event => { const target = event.target.closest('[data-action]'); if (target) void act(target.dataset.action, target); });
// The content script announces the extension and its answer on <html>: render (and offer a ticket) at once.
new MutationObserver(() => { render(); void poll(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-synabun-extension', 'data-synabun-pair'] });
await poll();
setInterval(() => { void poll(); }, 1500);
