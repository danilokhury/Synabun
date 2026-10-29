// The account menu in a side panel's header: one component for the Claude and
// the Codex panel (docs/claude-sidepanel.md, docs/codex-sidepanel.md →
// Accounts). The trigger names the tab's account and what it runs on; the menu
// lists every account (picking one switches the tab under the panel's rules)
// and manages them: add, sign in, use an API key, the "Uses" switch, sign out
// per credential, rename, remove. account-view.js decides every word; the
// panel hands in its rows and does the work (`actions`).
//
// Keyboard: the trigger is a menu button (Enter, Space, ArrowDown, ArrowUp).
// In the list, arrows move, Home / End jump, Tab and Escape close and give the
// focus back to the trigger. "Manage …" turns the popup into a small dialog:
// Escape goes back to the list (or leaves an open form), Tab stays inside.

import {
  accountManageModel, accountMenuModel, accountText, apiKeyErrorText, serverAccountId,
} from './account-view.js';
import { frameRect } from './app-frame.js';

const STYLE_ID = 'account-menu-styles';
// Values come from the panel's own tokens: Claude's global --t-* / --s-* scale, Codex's --cxp-* scale
// (cdx-styles.js lists .acct-menu--codex in its token scope, as it does for its context popover).
const STYLES = `
.acct-menu, .acct-menu-trigger {
  --acct-bg: rgba(22,22,26,0.98); --acct-border: var(--b-light); --acct-line: var(--b-subtle);
  --acct-text: var(--t-bright); --acct-muted: var(--t-primary); --acct-faint: var(--t-secondary);
  --acct-hover: var(--s-hover); --acct-active: var(--s-light); --acct-ok: #86efac; --acct-warn: #fbbf24;
  --acct-focus: var(--t-primary); --acct-radius: 5px; --acct-pop-radius: var(--r-card); --acct-shadow: 0 8px 32px rgba(0,0,0,0.4);
  --acct-font: Inter, -apple-system, sans-serif; --acct-fs: 12px; --acct-fs-sm: 11px;
}
.acct-menu--codex, .acct-menu-trigger.acct-menu--codex {
  --acct-bg: var(--cxp-pop); --acct-border: var(--cxp-border); --acct-line: var(--cxp-border);
  --acct-text: var(--cxp-text); --acct-muted: var(--cxp-text-2); --acct-faint: var(--cxp-text-3);
  --acct-hover: var(--cxp-surface-1); --acct-active: var(--cxp-surface-2); --acct-ok: var(--cxp-success); --acct-warn: var(--cxp-warning);
  --acct-focus: var(--cxp-focus); --acct-radius: var(--cxp-radius-sm); --acct-pop-radius: var(--cxp-radius-md); --acct-shadow: var(--cxp-shadow-pop);
  --acct-font: var(--cxp-font); --acct-fs: var(--cxp-fs-md); --acct-fs-sm: var(--cxp-fs-sm);
}
.acct-menu-trigger {
  display: inline-flex; align-items: center; gap: 6px; min-width: 64px; max-width: 150px; width: 140px; height: 24px; padding: 0 8px;
  border: 1px solid transparent; border-radius: var(--acct-radius); background: transparent; color: var(--acct-text);
  font: 500 var(--acct-fs-sm)/1 var(--acct-font); cursor: pointer; flex: 0 1 140px; container: acct-trigger / inline-size;
}
.acct-menu-trigger:hover, .acct-menu-trigger[aria-expanded="true"] { background: var(--acct-hover); border-color: var(--acct-border); }
.acct-menu-trigger:focus-visible { outline: 1px solid var(--acct-focus); outline-offset: 1px; }
.acct-menu-trigger[hidden] { display: none; }
.acct-menu-trigger-name { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: start; }
.acct-menu-trigger-badge { flex-shrink: 0; color: var(--acct-muted); font-weight: 400; white-space: nowrap; }
.acct-menu-trigger[data-tone="warn"] .acct-menu-trigger-badge { color: var(--acct-warn); }
.acct-menu-trigger-arrow { flex-shrink: 0; color: var(--acct-faint); font-size: 9px; }
@container acct-trigger (max-width: 110px) { .acct-menu-trigger-badge { display: none; } }
.acct-menu {
  position: fixed; box-sizing: border-box; width: 320px; max-width: calc(100vw - 16px); max-height: min(70vh, 520px); overflow-x: hidden; overflow-y: auto;
  padding: 4px; background: var(--acct-bg); border: 1px solid var(--acct-border); border-radius: var(--acct-pop-radius);
  box-shadow: var(--acct-shadow); color: var(--acct-text); font: 400 var(--acct-fs)/1.45 var(--acct-font); outline: none;
  scrollbar-width: thin; scrollbar-color: var(--acct-border) transparent; overscroll-behavior: contain;
}
.acct-menu[hidden] { display: none; }
.acct-menu-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; padding: 0 4px 0 8px; }
.acct-menu-title { flex: 1 1 0; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 var(--acct-fs)/16px var(--acct-font); color: var(--acct-text); }
.acct-menu-note { margin: 0 0 8px; color: var(--acct-muted); font-size: var(--acct-fs-sm); }
.acct-menu-footnote { margin: 0; padding: 4px 8px 6px; color: var(--acct-muted); font-size: var(--acct-fs-sm); overflow-wrap: anywhere; }
.acct-menu-section + .acct-menu-section { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--acct-line); }
.acct-menu-row { display: flex; align-items: stretch; border-radius: var(--acct-radius); margin: 2px 0; }
.acct-menu-row[data-current="true"] { background: var(--acct-active); }
.acct-menu-row:hover, .acct-menu-row:focus-within { background: var(--acct-hover); }
.acct-menu-item {
  flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 6px 4px 6px 8px; box-sizing: border-box;
  border: none; border-radius: var(--acct-radius); background: transparent; color: var(--acct-text); font: inherit; text-align: left; cursor: pointer;
}
.acct-menu-item:focus-visible, .acct-menu-more:focus-visible, .acct-menu-action:focus-visible, .acct-menu-refresh:focus-visible { outline: 2px solid var(--acct-focus); outline-offset: -2px; }
.acct-menu-avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 28px; height: 28px; border-radius: var(--acct-radius); background: var(--acct-hover); color: var(--acct-muted); font-weight: 500; }
.acct-menu-item-main { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.acct-menu-item-heading, .acct-menu-item-meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
.acct-menu-item-name { flex: 1 1 0; font-weight: 500; }
.acct-menu-item-name, .acct-menu-item-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acct-menu-item-id { min-width: 0; color: var(--acct-muted); font-size: var(--acct-fs-sm); }
.acct-menu-badge { flex-shrink: 0; color: var(--acct-muted); font-size: var(--acct-fs-sm); white-space: nowrap; }
.acct-menu-item-meta .acct-menu-badge { background: var(--acct-hover); border-radius: var(--acct-radius); padding: 0 4px; }
.acct-menu-badge[data-tone="warn"] { color: var(--acct-warn); }
.acct-menu-badge[data-tone="ok"] { color: var(--acct-muted); }
.acct-menu-check { flex-shrink: 0; color: var(--acct-text); font-size: 11px; }
.acct-menu-usage { color: var(--acct-muted); font-size: var(--acct-fs-sm); }
.acct-menu-usage[data-tone="warn"] { color: var(--acct-warn); }
.acct-menu-more {
  flex: 0 0 28px; align-self: center; height: 28px; margin-inline-end: 4px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: var(--acct-radius);
  background: transparent; color: var(--acct-muted); font: inherit; cursor: pointer; opacity: 0;
}
.acct-menu-row:hover .acct-menu-more, .acct-menu-row:focus-within .acct-menu-more { opacity: 1; }
.acct-menu-more:hover { background: var(--acct-hover); color: var(--acct-text); }
.acct-menu-refresh { flex: 0 0 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: var(--acct-radius); background: transparent; color: var(--acct-muted); cursor: pointer; }
.acct-menu-refresh:hover { background: var(--acct-hover); color: var(--acct-text); }
.acct-menu-refresh:disabled { opacity: .5; cursor: default; }
.acct-menu-refresh-icon { width: 14px; height: 14px; background: currentColor; mask: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6a8 8 0 0 1 13.3 4M4.6 14A8 8 0 0 0 17.9 18"/></g></svg>') center / contain no-repeat; }
.acct-menu-refresh[aria-busy="true"] .acct-menu-refresh-icon { animation: acct-refresh 1s linear infinite; }
.acct-menu-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.acct-menu-action {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 6px 8px; box-sizing: border-box; border: none; border-radius: var(--acct-radius);
  background: transparent; color: var(--acct-text); font: inherit; text-align: left; cursor: pointer;
}
.acct-menu-add::before { content: '+'; flex: 0 0 28px; text-align: center; color: var(--acct-muted); font-size: 18px; font-weight: 300; }
.acct-menu-action:hover { background: var(--acct-hover); }
.acct-menu-back { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px 0 0; border: none; background: none; color: var(--acct-muted); font: inherit; cursor: pointer; }
.acct-menu-back:hover, .acct-menu-back:focus-visible { color: var(--acct-text); outline: none; }
.acct-menu-kv { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; }
.acct-menu-k { flex: 0 0 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--acct-muted); }
.acct-menu-v { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.acct-menu-inuse { color: var(--acct-ok); font-size: var(--acct-fs-sm); }
.acct-menu-btn {
  box-sizing: border-box; flex-shrink: 0; height: 22px; padding: 0 10px; border: 1px solid var(--acct-border); border-radius: var(--acct-radius);
  background: var(--acct-hover); color: var(--acct-text); font: 400 var(--acct-fs)/20px var(--acct-font); cursor: pointer;
}
.acct-menu-btn:hover:not(:disabled) { background: var(--acct-active); }
.acct-menu-btn:disabled { opacity: 0.45; cursor: default; }
.acct-menu-btn:focus-visible, .acct-menu-seg button:focus-visible, .acct-menu-input:focus-visible { outline: 1px solid var(--acct-focus); outline-offset: 2px; }
.acct-menu-seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--acct-border); border-radius: var(--acct-radius); }
.acct-menu-seg button { height: 20px; padding: 0 8px; border: none; border-radius: var(--acct-radius); background: transparent; color: var(--acct-muted); font: inherit; font-size: var(--acct-fs-sm); cursor: pointer; }
.acct-menu-seg button[aria-checked="true"] { background: var(--acct-active); color: var(--acct-text); }
.acct-menu-form { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
.acct-menu-input {
  flex: 1 1 0; min-width: 0; height: 24px; box-sizing: border-box; padding: 0 8px; border: 1px solid var(--acct-border); border-radius: var(--acct-radius);
  background: var(--acct-hover); color: var(--acct-text); font: inherit;
}
.acct-menu-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.acct-menu-status { margin: 8px 0 0; color: var(--acct-muted); font-size: var(--acct-fs-sm); }
.acct-menu-status:empty { display: none; }
.acct-menu-status { padding: 0 8px 4px; overflow-wrap: anywhere; }
.acct-menu[data-view="manage"] { padding: 8px; }
.acct-menu[data-view="manage"] .acct-menu-kv { flex-wrap: wrap; gap: 6px; }
.acct-menu[data-view="manage"] .acct-menu-note { overflow-wrap: anywhere; }
@keyframes acct-refresh { to { transform: rotate(360deg); } }
@media (hover: none), (pointer: coarse) {
  .acct-menu-more { opacity: 1; flex-basis: 44px; height: 44px; }
  .acct-menu-refresh { flex-basis: 44px; height: 44px; }
  .acct-menu-action { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) { .acct-menu-refresh[aria-busy="true"] .acct-menu-refresh-icon { animation: none; } }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.append(style);
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

let _menuIds = 0;

/**
 * Mount the trigger into `container` (before `before`, if given) and return the
 * menu's controller: { trigger, open({ manage, fresh, status }), close(), toggle(), render(), isOpen(), destroy() }.
 * `read()` → { rows, currentId, hasConversation, available, busy, error, loading }.
 * `actions`: pick(id), add() → row, signIn(id), saveKey(id, key), setMode(id, mode),
 * signOut(id, credential), rename(id, label), remove(id), load({ refresh }).
 */
export function mountAccountMenu({ provider = 'claude', container, before = null, read, actions = {}, layer = null, confirm = (text) => window.confirm(text) } = {}) {
  ensureStyles();
  const p = provider === 'codex' ? 'codex' : 'claude';
  const menuId = `acct-menu-${p}-${++_menuIds}`;
  const trigger = h('button', {
    type: 'button', className: `acct-menu-trigger acct-menu--${p}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId,
  }, h('span', { className: 'acct-menu-trigger-name' }), h('span', { className: 'acct-menu-trigger-badge' }), h('span', { className: 'acct-menu-trigger-arrow', 'aria-hidden': 'true', text: '▾' }));
  if (container) container.insertBefore(trigger, before && before.parentNode === container ? before : container.firstChild);
  const popup = h('div', { id: menuId, className: `acct-menu acct-menu--${p}`, role: 'menu', tabindex: '-1', hidden: true });
  document.body.append(popup);

  // view: 'list' | 'manage'; manageId: the account being managed; form: 'key' | 'rename' | ''; status: the last word said.
  const ui = { view: 'list', manageId: '', form: '', status: '', statusId: '', untilSignedIn: '', working: false, refreshing: false };
  let open = false;
  let destroyed = false;

  const state = () => {
    const value = (typeof read === 'function' ? read() : null) || {};
    return { rows: Array.isArray(value.rows) ? value.rows : [], currentId: value.currentId || '', hasConversation: !!value.hasConversation, available: value.available !== false, busy: !!value.busy, error: value.error || '', loading: !!value.loading };
  };
  const rowOf = (id) => state().rows.find((row) => row.id === id) || null;
  const say = (text, id = '') => { ui.status = text || ''; ui.statusId = id; };

  function renderTrigger() {
    const s = state();
    const model = accountMenuModel({ provider: p, rows: s.rows, currentId: s.currentId, hasConversation: s.hasConversation });
    trigger.hidden = !s.available;
    trigger.querySelector('.acct-menu-trigger-name').textContent = model.trigger.name;
    trigger.querySelector('.acct-menu-trigger-badge').textContent = model.trigger.short || model.trigger.badge;
    trigger.dataset.tone = model.trigger.tone || 'muted';
    trigger.setAttribute('aria-label', model.trigger.label);
    trigger.title = model.trigger.label;
    return model;
  }

  function focusables() {
    return [...popup.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter((node) => !node.closest('[hidden]'));
  }
  function focusKey(node) { return node?.dataset?.focus || ''; }
  function restoreFocus(key) {
    if (!open) return;
    // Only while the menu owns the focus: a sign-in terminal that just opened (or anything else the
    // user moved to) keeps it, so the keys typed there never land in the menu.
    const active = document.activeElement;
    if (active && active !== document.body && active !== trigger && !popup.contains(active)) return;
    const target = (key && popup.querySelector(`[data-focus="${CSS.escape(key)}"]`)) || focusables()[0] || popup;
    target.focus?.();
    target.scrollIntoView?.({ block: 'nearest' });
  }

  function listView(model, s) {
    const rows = model.rows.map((item) => {
      const row = s.rows.find((value) => value.id === item.id);
      const identity = row?.mode === 'apiKey' ? row.apiKey?.hint || row.identity : row?.subscription?.email || row?.identity;
      // Compare the identity itself, before a plan is appended. An email used as
      // the account name is shown once; CSS performs the only truncation.
      const duplicate = String(identity || '').trim().toLowerCase() === item.label.trim().toLowerCase();
      const detail = duplicate ? '' : item.identity;
      const badge = row?.mode === 'subscription' && row.signedIn === true ? accountText('subscriptionShort', {}, p) : item.badge;
      const usage = row?.mode === 'subscription' && row.signedIn === true ? row.usage : null;
      const percent = typeof usage?.remainingPercent === 'number' && Number.isFinite(usage.remainingPercent)
        ? Math.round(Math.max(0, Math.min(100, usage.remainingPercent))) : null;
      const usageLabel = usage?.limited ? accountText('usageLimited', {}, p) : percent !== null ? accountText('usageLeft', { percent }, p) : '';
      const reset = usage?.resetsAt ? new Date(usage.resetsAt) : null;
      const resetTitle = reset && Number.isFinite(reset.getTime()) ? accountText('usageResets', { time: reset.toLocaleString(document.documentElement?.lang || undefined) }, p) : '';
      return h('div', { className: 'acct-menu-row', role: 'none', dataset: { current: String(item.current) } },
      h('button', {
        type: 'button', className: 'acct-menu-item', role: 'menuitemradio', 'aria-checked': String(item.current), dataset: { focus: `pick:${item.id}` },
        title: [item.label, item.badge, item.identity].filter(Boolean).join(' · '),
        'aria-label': [item.label, detail, item.badge, usageLabel].filter(Boolean).join(' · '),
        onClick: () => pick(item.id),
      },
      h('span', { className: 'acct-menu-avatar', 'aria-hidden': 'true', text: Array.from(item.label.trim())[0]?.toLocaleUpperCase() || '?' }),
      h('span', { className: 'acct-menu-item-main' },
        h('span', { className: 'acct-menu-item-heading' },
          h('span', { className: 'acct-menu-item-name', text: item.label, title: item.label }),
          item.current ? h('span', { className: 'acct-menu-check', 'aria-hidden': 'true', text: '✓' }) : null),
        h('span', { className: 'acct-menu-item-meta' },
          detail ? h('span', { className: 'acct-menu-item-id', text: detail, title: detail }) : null,
          h('span', { className: 'acct-menu-badge', dataset: { tone: item.tone }, text: badge })),
        usageLabel ? h('span', { className: 'acct-menu-usage', title: resetTitle || usageLabel, dataset: { tone: usage.limited ? 'warn' : 'muted' }, text: usageLabel }) : null)),
      h('button', {
        type: 'button', className: 'acct-menu-more', role: 'menuitem', dataset: { focus: `manage:${item.id}` },
        'aria-label': accountText('manage', { label: item.label }, p), title: accountText('manage', { label: item.label }, p),
        onClick: () => showManage(item.id),
      }, '⋯'));
    });
    const empty = !model.rows.length ? h('p', { className: 'acct-menu-footnote', text: s.error || accountText(s.loading ? 'reading' : 'emptyAccounts', {}, p) }) : null;
    return [
      h('div', { className: 'acct-menu-section' },
        h('div', { className: 'acct-menu-head' }, h('p', { className: 'acct-menu-title', text: model.title }),
          h('button', { type: 'button', className: 'acct-menu-refresh', role: 'menuitem', dataset: { focus: 'refresh' }, title: accountText('refresh', {}, p), 'aria-label': accountText('refresh', {}, p), 'aria-busy': String(ui.refreshing), disabled: ui.refreshing, onClick: () => reload(true) },
            h('span', { className: 'acct-menu-refresh-icon', 'aria-hidden': 'true' }), h('span', { className: 'acct-menu-sr', text: accountText('refresh', {}, p) }))),
        empty, ...rows),
      h('div', { className: 'acct-menu-section' },
        h('button', { type: 'button', className: 'acct-menu-action acct-menu-add', role: 'menuitem', dataset: { focus: 'add' }, disabled: ui.working, text: accountText('addAccount', {}, p), onClick: () => addAccount() }),
        h('p', { className: 'acct-menu-footnote', text: model.note })),
      h('p', { className: 'acct-menu-status', role: 'status', 'aria-live': 'polite', text: (model.rows.length ? s.error : '') || (ui.statusId ? '' : ui.status) }),
    ];
  }

  function manageView(row, s) {
    const model = accountManageModel(row, p);
    const busyHere = s.busy && row.id === serverAccountId(s.currentId);
    const modes = model.modes.length ? h('div', { className: 'acct-menu-kv' },
      h('span', { className: 'acct-menu-k', text: accountText('uses', {}, p) }),
      h('span', { className: 'acct-menu-seg', role: 'radiogroup', 'aria-label': model.usesLabel },
        ...model.modes.map((m) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(m.current), dataset: { focus: `mode:${m.mode}` }, title: m.detail || m.label,
          disabled: ui.working || busyHere, text: m.label, onClick: () => setMode(row, m.mode),
        })))) : null;
    const creds = model.credentials.map((c) => h('div', { className: 'acct-menu-kv' },
      h('span', { className: 'acct-menu-k', text: c.name }),
      h('span', { className: 'acct-menu-v', title: c.text }, c.text, c.inUse ? h('span', { className: 'acct-menu-inuse', text: ` · ${accountText('inUse', {}, p)}` }) : null),
      h('button', { type: 'button', className: 'acct-menu-btn', dataset: { focus: `cred:${c.kind}` }, disabled: ui.working || busyHere, text: c.actionText, onClick: () => credentialAction(row, c) })));
    const keyForm = ui.form === 'key' ? h('form', { className: 'acct-menu-form', onSubmit: (event) => saveKey(event, row) },
      h('input', { className: 'acct-menu-input', type: 'password', name: 'key', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: accountText('keyPlaceholder', {}, p), 'aria-label': accountText('keyLabel', { label: model.title }, p), dataset: { focus: 'key-input' }, disabled: ui.working }),
      h('button', { type: 'submit', className: 'acct-menu-btn', disabled: ui.working, text: accountText('save', {}, p) }),
      h('button', { type: 'button', className: 'acct-menu-btn', disabled: ui.working, text: accountText('cancel', {}, p), onClick: () => closeForm('cred:apiKey') })) : null;
    const renameForm = ui.form === 'rename' ? h('form', { className: 'acct-menu-form', onSubmit: (event) => saveName(event, row) },
      h('input', { className: 'acct-menu-input', type: 'text', name: 'label', maxlength: '80', autocomplete: 'off', value: row.label || '', 'aria-label': accountText('nameLabel', {}, p), dataset: { focus: 'rename-input' }, disabled: ui.working }),
      h('button', { type: 'submit', className: 'acct-menu-btn', disabled: ui.working, text: accountText('save', {}, p) }),
      h('button', { type: 'button', className: 'acct-menu-btn', disabled: ui.working, text: accountText('cancel', {}, p), onClick: () => closeForm('rename') })) : null;
    const manageActions = model.canRename || model.canRemove ? h('div', { className: 'acct-menu-actions' },
      model.canRename ? h('button', { type: 'button', className: 'acct-menu-btn', dataset: { focus: 'rename' }, disabled: ui.working, text: accountText('rename', {}, p), onClick: () => { ui.form = 'rename'; render('rename-input'); } }) : null,
      model.canRemove ? h('button', { type: 'button', className: 'acct-menu-btn', dataset: { focus: 'remove' }, disabled: ui.working || row.id === serverAccountId(s.currentId) && s.busy, text: accountText('remove', {}, p), onClick: () => removeAccount(row) }) : null) : null;
    return [
      h('div', { className: 'acct-menu-section' },
        h('div', { className: 'acct-menu-head' },
          h('button', { type: 'button', className: 'acct-menu-back', dataset: { focus: 'back' }, onClick: () => showList(`manage:${row.id}`) }, h('span', { 'aria-hidden': 'true', text: '‹' }), accountText('back', {}, p))),
        h('div', { className: 'acct-menu-kv' }, h('p', { className: 'acct-menu-title', text: model.title }), h('span', { className: 'acct-menu-badge', dataset: { tone: model.tone }, text: model.badge })),
        model.identity ? h('p', { className: 'acct-menu-note', text: model.identity }) : null),
      h('div', { className: 'acct-menu-section' }, modes, ...creds, keyForm),
      manageActions || renameForm ? h('div', { className: 'acct-menu-section' }, renameForm, manageActions) : null,
      h('p', { className: 'acct-menu-status', role: 'status', 'aria-live': 'polite', text: busyHere ? accountText('busyTurn', {}, p) : ui.statusId === row.id ? ui.status : '' }),
    ];
  }

  /** Draw the trigger and, when open, the menu. `focus`: the data-focus key to land on (else the focused one stays). */
  function render(focus = null) {
    if (destroyed) return;
    const s = state();
    const model = renderTrigger();
    if (!open) return;
    // A sign-in this menu started is said until the account's subscription is signed in.
    if (ui.untilSignedIn && rowOf(ui.untilSignedIn)?.subscription?.signedIn === true) { ui.untilSignedIn = ''; say(''); }
    // An open form keeps what is typed in it: a change from elsewhere waits until it closes.
    if (!focus && ui.form && popup.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    const keep = focus || focusKey(popup.contains(document.activeElement) ? document.activeElement : null);
    const row = ui.view === 'manage' ? rowOf(ui.manageId) : null;
    if (ui.view === 'manage' && !row) { ui.view = 'list'; ui.form = ''; }
    popup.dataset.view = ui.view;
    // A section a view leaves out (null) is not a node: replaceChildren would print "null".
    popup.replaceChildren(...(ui.view === 'manage' && row ? manageView(row, s) : listView(model, s)).filter(Boolean));
    if (ui.view === 'manage' && row) {
      popup.setAttribute('role', 'dialog');
      popup.setAttribute('aria-label', accountText('manage', { label: accountManageModel(row, p).title }, p));
    } else {
      popup.setAttribute('role', 'menu');
      popup.setAttribute('aria-label', model.title);
    }
    place();
    restoreFocus(keep);
  }

  function place() {
    if (!open) return;
    let rect = trigger.getBoundingClientRect();
    // A header too narrow for the trigger hides it (the panels' container queries); the menu,
    // opened from the cog's Account row, then hangs from the row the trigger sits in.
    if (!rect.width && !rect.height && trigger.parentElement) rect = trigger.parentElement.getBoundingClientRect();
    const owner = layer?.() || trigger.closest('[class*="panel"]');
    const ownerWidth = owner?.getBoundingClientRect?.().width;
    // Inside the app frame (app-frame.js; the whole window on a page without it), 8px clear of its edges.
    const f = frameRect();
    popup.style.width = `${Math.max(0, Math.min(320, ownerWidth > 240 ? ownerWidth - 16 : 320, f.width - 16))}px`;
    const width = popup.offsetWidth || 300;
    const left = Math.max(f.left + 8, Math.min(rect.right - width, f.right - width - 8));
    const below = f.bottom - rect.bottom - 14;
    const above = rect.top - f.top - 14;
    const flip = below < 180 && above > below;
    popup.style.maxHeight = `${Math.max(80, Math.min(520, flip ? above : below))}px`;
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(flip ? Math.max(f.top + 8, rect.top - 6 - popup.offsetHeight) : rect.bottom + 6)}px`;
    let z = 201;
    try { z = (parseInt(getComputedStyle(owner).zIndex, 10) || 200) + 1; } catch {}
    popup.style.zIndex = String(z);
  }

  function showList(focus = null) { ui.view = 'list'; ui.form = ''; ui.manageId = ''; render(focus); }
  function showManage(id, focus = 'back') { ui.view = 'manage'; ui.manageId = id; ui.form = ''; if (ui.statusId && ui.statusId !== id) say(''); render(focus); }
  function closeForm(focus) { ui.form = ''; render(focus); }

  async function reload(refresh = false) {
    if (refresh && ui.refreshing) return;
    if (refresh) { ui.refreshing = true; say(''); render(); }
    try { await actions.load?.({ refresh }); } catch { say(accountText('readFailed', {}, p)); }
    finally { if (refresh) ui.refreshing = false; }
    render();
  }
  async function work(task, { id = '', done = '', focus = null, after = null } = {}) {
    if (ui.working) return false;
    ui.working = true;
    render(focus);
    let ok = false;
    try {
      await task();
      say(typeof done === 'function' ? done() : done, id);
      ok = true;
    } catch (error) {
      say(error?.message || accountText('failed', {}, p), id);
    } finally {
      ui.working = false;
    }
    try { await actions.load?.({ refresh: false }); } catch {}
    after?.(ok);
    render(focus);
    return ok;
  }

  function pick(id) {
    const message = actions.pick?.(id);
    close({ restore: true });
    if (typeof message === 'string' && message) say(message);
  }
  async function addAccount() {
    let created = null;
    const ok = await work(async () => { created = await actions.add?.(); }, { focus: 'add' });
    if (ok && created?.id) {
      say(accountText('freshPrompt', { label: created.label || created.id }, p), created.id);
      showManage(created.id, 'cred:subscription');
    }
  }
  function busyFor(row) {
    const s = state();
    if (s.busy && row.id === serverAccountId(s.currentId)) { say(accountText('busyTurn', {}, p), row.id); render(); return true; }
    return false;
  }
  async function credentialAction(row, c) {
    if (busyFor(row)) return;
    const label = accountManageModel(row, p).title;
    if (c.action === 'addKey') { ui.form = 'key'; say('', ''); render('key-input'); return; }
    if (c.action === 'signIn') {
      const ok = await work(() => actions.signIn(row.id), { id: row.id, done: accountText('signInPending', {}, p), focus: `cred:${c.kind}` });
      if (ok) ui.untilSignedIn = row.id;
      return;
    }
    if (c.action === 'signOut') {
      if (!confirm(accountText('confirmSignOut', { label }, p))) return;
      await work(() => actions.signOut(row.id, 'subscription'), { id: row.id, done: accountText('signedOutNote', { label }, p), focus: `cred:${c.kind}` });
      return;
    }
    if (c.action === 'removeKey') {
      if (!confirm(accountText('confirmRemoveKey', { label }, p))) return;
      await work(() => actions.signOut(row.id, 'apiKey'), { id: row.id, done: accountText('keyRemovedNote', { label }, p), focus: `cred:${c.kind}` });
    }
  }
  async function saveKey(event, row) {
    event.preventDefault();
    const input = event.currentTarget.querySelector('input');
    let key = input.value;
    input.value = '';
    if (!key || busyFor(row)) { key = null; return; }
    const label = accountManageModel(row, p).title;
    say(accountText('checkingKey', {}, p), row.id);
    try {
      await work(async () => {
        try { await actions.saveKey(row.id, key); }
        catch (error) { throw Object.assign(new Error(apiKeyErrorText(p, error?.code)), { code: error?.code }); }
        finally { key = null; }
        ui.form = '';
      }, { id: row.id, done: accountText('keySavedNote', { label }, p), focus: 'cred:apiKey' });
    } finally { key = null; }
  }
  async function saveName(event, row) {
    event.preventDefault();
    const value = event.currentTarget.querySelector('input').value.trim();
    if (!value || value === row.label) { closeForm('rename'); return; }
    await work(async () => { await actions.rename(row.id, value); ui.form = ''; }, { id: row.id, focus: 'rename' });
  }
  async function setMode(row, mode) {
    if (row.mode === mode || busyFor(row)) return;
    const label = accountManageModel(row, p).title;
    await work(() => actions.setMode(row.id, mode), { id: row.id, done: accountText(mode === 'apiKey' ? 'modeSetApiKey' : 'modeSetSubscription', { label }, p), focus: `mode:${mode}` });
  }
  async function removeAccount(row) {
    const label = accountManageModel(row, p).title;
    if (!confirm(accountText('confirmRemove', { label }, p))) return;
    const ok = await work(() => actions.remove(row.id), { id: row.id, focus: 'remove' });
    if (ok) showList('add');
  }

  // ── open / close and the keys ──
  function onKeydown(event) {
    if (!open) return;
    const inForm = event.target?.tagName === 'INPUT';
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (ui.form) { const back = ui.form === 'key' ? 'cred:apiKey' : 'rename'; closeForm(back); return; }
      if (ui.view === 'manage') { showList(`manage:${ui.manageId}`); return; }
      close({ restore: true });
      return;
    }
    if (!popup.contains(event.target)) return;
    // Keys typed into a field belong to the field (and never reach the panel's shortcuts).
    if (inForm) { event.stopPropagation(); return; }
    const items = focusables();
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Tab') {
      if (ui.view === 'list') { event.preventDefault(); close({ restore: true }); return; }
      event.preventDefault();
      const next = items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length];
      next?.focus();
      return;
    }
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move) { event.preventDefault(); (items[(index + move + items.length) % items.length] || items[0])?.focus(); return; }
    if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); return; }
    if (event.key === 'End') { event.preventDefault(); items[items.length - 1]?.focus(); }
  }
  function onPointerDown(event) {
    if (!open || popup.contains(event.target) || trigger.contains(event.target)) return;
    close();
  }
  function onViewport() { if (open) { if (!trigger.isConnected) close(); else place(); } }

  function openMenu({ manage = '', fresh = '', status = '', focusLast = false } = {}) {
    if (destroyed || !state().available) return;
    if (!open) {
      open = true;
      popup.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      window.addEventListener('keydown', onKeydown, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('resize', onViewport);
      window.addEventListener('scroll', onViewport, true);
    }
    if (status) say(status, manage || fresh || '');
    if (fresh) say(accountText('freshPrompt', { label: rowOf(fresh)?.label || fresh }, p), fresh);
    if (manage || fresh) showManage(manage || fresh, fresh ? 'cred:subscription' : 'back');
    else { ui.view = 'list'; ui.form = ''; render(focusLast ? 'add' : `pick:${serverAccountId(state().currentId)}`); }
    reload(false);
  }
  function close({ restore = false } = {}) {
    if (!open) return;
    open = false;
    popup.hidden = true;
    ui.form = '';
    trigger.setAttribute('aria-expanded', 'false');
    window.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('scroll', onViewport, true);
    if (restore) trigger.focus();
  }

  trigger.addEventListener('click', (event) => { event.stopPropagation(); if (open) close({ restore: true }); else openMenu(); });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu({ focusLast: event.key === 'ArrowUp' }); }
  });
  // The header moves a floating window: a press in the menu must not.
  popup.addEventListener('pointerdown', (event) => event.stopPropagation());
  trigger.addEventListener('pointerdown', (event) => event.stopPropagation());

  renderTrigger();
  return {
    trigger,
    popup,
    open: openMenu,
    close,
    toggle: () => (open ? close({ restore: true }) : openMenu()),
    isOpen: () => open,
    render: () => render(),
    say: (text, id = '') => { say(text, id); render(); },
    destroy() { close(); destroyed = true; trigger.remove(); popup.remove(); },
  };
}
