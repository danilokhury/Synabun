// ═══════════════════════════════════════════
// SynaBun Assistant — account menu (⚙ → Account profile)
// ═══════════════════════════════════════════
// Which Claude or Codex account this conversation runs on and which one
// dispatched workers use, in one popover that stays inside the panel
// (asst-menu.js `bounds`; only the list scrolls, the footer stays). Every
// account is listed once: its name, who it is when that adds to the name, the
// plan or API key, the usage left or the limit, and when it comes back. Auto is
// one line (its sentence is the tooltip). "Workers use" opens the workers'
// choice in the same popover (Esc goes back). The words come from
// account-view.js and account-usage.js; what a choice does is the caller's
// (asst-brain-picker.js). accountMenuRow is DOM-free (node --test loads it).
// The composer's Model menu lists the same rows (accountChoiceItems,
// accountModeItem, accountManageItem), so both show an account the same way.

import { accountBadge, accountName, accountText, accountUsable, modeChoices, planName } from '../account-view.js';
import { accountUsageLine, autoAccountLabel } from '../account-usage.js';
import { openMenu } from './asst-menu.js';

const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
// Auto: the usage gauge (the same drawing as the brain picker's effort icon).
const ICON_AUTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16a8 8 0 1 1 16 0"/><path d="m12 16 4-5"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';
// As wide as this in a wide panel; a narrow panel gets its own width less the menu's margins.
const MENU_WIDTH = 340;

function tf(t) {
  return (key, fallback, params) => {
    const v = typeof t === 'function' ? t(key, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };
}

/** Who the account is, when that adds to its name: the subscription's email or the key's hint (never the name again). */
function identityOf(row, name) {
  const raw = row?.mode === 'apiKey' ? (row.apiKey?.hint || row.identity) : (row?.subscription?.email || row?.identity);
  const text = String(raw || '').trim();
  return text && text.toLowerCase() !== String(name || '').trim().toLowerCase() ? text : '';
}

/**
 * One account as the menu shows it: { id, name, initial, badge: { text, tone }, identity,
 * line: { text, tone, title } | null, usable, signedOut }. The badge is what it runs on (the
 * plan, "API key"), or that it is signed out; `line` is its usage, or how to sign it in.
 */
export function accountMenuRow(row, { provider = 'claude', t = null, now = Date.now(), locale } = {}) {
  const p = provider === 'codex' ? 'codex' : 'claude';
  const name = accountName(row, p) || String(row?.id || '');
  const signedOut = row?.signedIn === false;
  let badge;
  if (!signedOut && row?.mode === 'apiKey') badge = { text: accountText('apiKeyBadge', {}, p), tone: 'muted' };
  else if (!signedOut && row?.mode === 'subscription' && row.signedIn === true) badge = { text: planName(row.subscription?.plan) || accountText('subscriptionShort', {}, p), tone: 'muted' };
  else badge = accountBadge(row, p);
  let line = accountUsageLine(row, t, { now, locale });
  if (signedOut) {
    const text = accountText(row?.apiKey?.error ? 'keyUnreadableLong' : 'signIn', {}, p);
    line = { text, tone: 'muted', title: text };
  }
  return {
    id: row?.id,
    name,
    initial: Array.from(name.trim())[0]?.toLocaleUpperCase() || '?',
    badge: { text: badge.text || '', tone: badge.tone === 'warn' ? 'warn' : 'muted' },
    identity: signedOut ? '' : identityOf(row, name),
    line,
    usable: accountUsable(row),
    signedOut,
  };
}

/** The full words of a row, for its tooltip and its accessible name. */
function rowWords(r, extra = []) {
  return [r.name, r.identity, r.badge.text, r.line?.title || r.line?.text, ...extra].filter(Boolean).join(' · ');
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
function icon(className, svg) {
  const n = node('span', className);
  n.setAttribute('aria-hidden', 'true');
  n.innerHTML = svg;
  return n;
}

// avatar | name ✓ … badge / identity / usage
function drawAccount(btn, r, checked) {
  btn.classList.add('asst-acct-item');
  const avatar = node('span', 'asst-acct-avatar', r.initial);
  avatar.setAttribute('aria-hidden', 'true');
  const head = node('span', 'asst-acct-head');
  head.append(node('span', 'asst-acct-name', r.name));
  if (checked) head.append(icon('asst-acct-check', ICON_CHECK));
  if (r.badge.text) { const badge = node('span', 'asst-acct-badge', r.badge.text); badge.dataset.tone = r.badge.tone; head.append(badge); }
  const main = node('span', 'asst-acct-main');
  main.append(head);
  if (r.identity) main.append(node('span', 'asst-acct-line', r.identity));
  if (r.line) { const line = node('span', 'asst-acct-line', r.line.text); line.dataset.tone = r.line.tone; main.append(line); }
  btn.append(avatar, main);
}
function drawAuto(btn, label, checked) {
  btn.classList.add('asst-acct-item', 'asst-acct-auto');
  const head = node('span', 'asst-acct-head');
  head.append(node('span', 'asst-acct-name', label));
  if (checked) head.append(icon('asst-acct-check', ICON_CHECK));
  const main = node('span', 'asst-acct-main');
  main.append(head);
  btn.append(icon('asst-acct-avatar', ICON_AUTO), main);
}
// label … value ›
function drawValue(btn, label, value, tone) {
  btn.classList.add('asst-acct-value');
  const text = node('span', 'asst-acct-value-text', value);
  text.dataset.tone = tone;
  btn.append(node('span', 'asst-acct-value-label', label), text, icon('asst-acct-next', ICON_NEXT));
}
function drawBack(btn, label) {
  btn.classList.add('asst-acct-back');
  btn.append(icon('asst-acct-next', ICON_BACK), node('span', 'asst-acct-value-label', label));
}
function drawChoice(btn, label, checked) {
  btn.classList.add('asst-acct-choice');
  if (checked) btn.append(icon('asst-acct-check', ICON_CHECK));
  btn.append(node('span', '', label));
}

/**
 * The account choices as menu items (this menu and the composer's Model menu): Auto, every account
 * once, and the note that another account starts a new conversation. rows: accountMenuRow()s;
 * onAuto(), onPick(id) (never for the current account), onSignIn(id) (a signed-out account is its sign-in).
 */
export function accountChoiceItems({ t = null, rows = [], currentId = null, onAuto, onPick, onSignIn } = {}) {
  const tr = tf(t);
  const newConversation = tr('assistant.brain.newConversation', 'starts a new conversation');
  const items = [{
    kind: 'radio', id: 'auto', label: autoAccountLabel(t), selected: currentId === 'auto',
    title: tr('assistant.accountUsage.composerHint', 'Pick the subscription with most usage left and start a new conversation.'),
    render: (btn, { checked }) => drawAuto(btn, autoAccountLabel(t), checked),
    onSelect: () => onAuto?.(),
  }];
  for (const r of rows) {
    const current = r.id === currentId;
    // A signed-out account is listed with its way back in: choosing it opens its sign-in.
    const words = rowWords(r, [!current && !r.signedOut ? newConversation : '']);
    items.push({
      kind: current ? 'radio' : r.signedOut ? 'item' : 'radio', id: r.id, label: r.name, keywords: r.identity,
      selected: current, title: words, ariaLabel: words,
      render: (btn, { checked }) => drawAccount(btn, r, checked),
      onSelect: () => (r.signedOut ? onSignIn?.(r.id) : current ? null : onPick?.(r.id)),
    });
  }
  items.push({ kind: 'info', className: 'asst-acct-note', label: tr('assistant.accountMenu.switchNote', 'Another account starts a new conversation.') });
  return items;
}

/**
 * What an account holding both credentials uses, as one row of two choices ("Work uses  Subscription |
 * API key"); null for any other account. Waits while a turn runs. onSetMode(id, mode) for the other one.
 */
export function accountModeItem({ provider = 'claude', t = null, account = null, running = false, onSetMode } = {}) {
  const p = provider === 'codex' ? 'codex' : 'claude';
  const modes = modeChoices(account, p);
  if (!modes.length) return null;
  const tr = tf(t);
  const newConversation = tr('assistant.brain.newConversation', 'starts a new conversation');
  const name = accountName(account, p);
  return {
    kind: 'buttons', id: 'uses', label: tr('assistant.accountMenu.uses', '{label} uses', { label: name }), ariaLabel: accountText('usesGroup', { label: name }, p),
    buttons: modes.map((m) => {
      const text = accountText(m.mode === 'apiKey' ? 'apiKeyBadge' : 'subscriptionShort', {}, p);
      return {
        kind: 'radio', id: `mode:${m.mode}`, label: text, selected: m.current, disabled: running,
        title: [m.label, m.detail, !m.current ? newConversation : ''].filter(Boolean).join(' · '),
        render: (btn, { checked }) => drawChoice(btn, text, checked),
        onSelect: () => { if (!m.current) onSetMode?.(account.id, m.mode); },
      };
    }),
  };
}

/** Add account… and Manage… side by side. */
export function accountManageItem({ t = null, onAdd, onManage } = {}) {
  const tr = tf(t);
  return {
    kind: 'buttons', id: 'manage-row',
    buttons: [
      { id: '__add', label: tr('assistant.accounts.add', 'Add account…'), onSelect: () => onAdd?.() },
      { id: '__manage', label: tr('assistant.accounts.manage', 'Manage…'), onSelect: () => onManage?.() },
    ],
  };
}

/**
 * Open the menu from `anchor`. ctx: { provider: 'claude' | 'codex', t, placement, bounds,
 *   read() → { accounts, currentId, workerId, running },
 *   onAuto(), onPick(id), onSetWorker(id) → Promise, onSetMode(id, mode), onAdd(), onManage(id?), onError(err),
 *   now, locale (the clock and language of the reset times; default: now and the page's) }
 * Returns the asst-menu handle (or null).
 */
export function openAccountMenu(anchor, ctx = {}) {
  const tr = tf(ctx.t);
  const p = ctx.provider === 'codex' ? 'codex' : 'claude';
  const workersTitle = p === 'codex' ? tr('assistant.accounts.codexWorkersHeader', 'Codex workers use') : tr('assistant.accounts.workersHeader', 'Claude Code workers use');
  let view = 'main';
  let busy = false;
  let handle = null;

  const state = () => {
    const s = ctx.read?.() || {};
    const accounts = Array.isArray(s.accounts) ? s.accounts : [];
    const rows = accounts.map((a) => accountMenuRow(a, { provider: p, t: ctx.t, now: ctx.now, locale: ctx.locale }));
    return { accounts, rows, currentId: s.currentId || null, workerId: s.workerId || 'default', running: s.running === true };
  };

  function mainItems(s) {
    return accountChoiceItems({ t: ctx.t, rows: s.rows, currentId: s.currentId, onAuto: () => ctx.onAuto?.(), onPick: (id) => ctx.onPick?.(id), onSignIn: (id) => ctx.onManage?.(id) });
  }

  function mainFooter(s) {
    const footer = [];
    const uses = accountModeItem({ provider: p, t: ctx.t, account: s.accounts.find((a) => a.id === s.currentId), running: s.running, onSetMode: (id, mode) => ctx.onSetMode?.(id, mode) });
    if (uses) footer.push(uses);
    const worker = s.rows.find((r) => r.id === s.workerId);
    const workerName = worker ? worker.name : (s.workerId === 'default' ? accountText('defaultName', {}, p) : s.workerId);
    const workerState = worker?.signedOut ? worker.badge.text : worker?.line?.tone === 'warn' ? tr('assistant.accountUsage.limited', 'Limited') : '';
    const value = [workerName, workerState].filter(Boolean).join(' · ');
    const workersLabel = tr('assistant.accountMenu.workers', 'Workers use');
    footer.push({
      kind: 'item', id: 'workers', label: workersLabel, keywords: workerName, keepOpen: true,
      title: [`${workersTitle}: ${value}`, tr('assistant.accountMenu.workersHint', 'Used when a dispatch names no account.')].join(' · '),
      ariaLabel: `${workersTitle}: ${value}`,
      render: (btn) => drawValue(btn, workersLabel, value, workerState ? 'warn' : 'muted'),
      onSelect: () => showWorkers(),
    });
    footer.push(accountManageItem({ t: ctx.t, onAdd: () => ctx.onAdd?.(), onManage: () => ctx.onManage?.() }));
    return footer;
  }

  function workerItems(s) {
    const items = [{
      kind: 'item', id: 'back', label: accountText('back', {}, p), keepOpen: true,
      render: (btn) => drawBack(btn, accountText('back', {}, p)),
      onSelect: () => showMain('workers'),
    }];
    for (const r of s.rows) {
      const chosen = r.id === s.workerId;
      const words = rowWords(r);
      items.push({
        kind: 'radio', id: `worker:${r.id}`, label: r.name, keywords: r.identity, selected: chosen,
        disabled: !r.usable && !chosen, keepOpen: true, title: words, ariaLabel: words,
        render: (btn, { checked }) => drawAccount(btn, r, checked),
        onSelect: async () => {
          if (chosen) { showMain('workers'); return; }
          if (busy) return;
          busy = true;
          try { await ctx.onSetWorker?.(r.id); showMain('workers'); }
          catch (err) { ctx.onError?.(err); }
          finally { busy = false; }
        },
      });
    }
    items.push({ kind: 'info', className: 'asst-acct-note', label: tr('assistant.accountMenu.workersHint', 'Used when a dispatch names no account.') });
    return items;
  }

  function showMain(focus = null) {
    if (view === 'closed') return;
    view = 'main';
    const s = state();
    handle?.update({ title: accountText('menuTitle', {}, p), items: mainItems(s), footer: mainFooter(s), focus });
  }
  function showWorkers() {
    if (view === 'closed') return;
    view = 'workers';
    const s = state();
    handle?.update({ title: workersTitle, items: workerItems(s), footer: [], focus: `worker:${s.workerId}` });
  }

  const s = state();
  handle = openMenu(anchor, {
    title: accountText('menuTitle', {}, p),
    items: mainItems(s),
    footer: mainFooter(s),
    role: 'menu',
    placement: ctx.placement || 'auto',
    width: MENU_WIDTH,
    bounds: ctx.bounds || null,
    className: 'asst-account-menu',
    onEscape: () => { if (view !== 'workers') return false; showMain('workers'); return true; },
    onClose: () => { view = 'closed'; },
  });
  return handle;
}
