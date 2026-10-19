// ═══════════════════════════════════════════
// SynaBun Assistant — account profiles (Claude + Codex)
// ═══════════════════════════════════════════
// One manager for both providers, from the same server state as the side
// panels' header account menus (lib/claude-accounts.js, lib/codex-accounts.js
// describe()): every account with what it runs on and who it is, its "Uses"
// switch when it holds both credentials, each credential's sign-in or sign-out,
// an API key pasted into it, the worker choice, rename and remove. Adding an
// account makes it at once; its row then offers the two ways to sign it in:
// the provider's own login in a SynaBun terminal (`claude auth login` /
// `codex login` under the account's folder), or an API key.

import { on } from '../state.js';
import {
  fetchClaudeAccounts, fetchCodexAccounts, getCachedClaudeAccounts, getCachedCodexAccounts, getClaudeWorkerAccountId, getCodexWorkerAccountId,
} from '../agent-runtime-options.js';
import { getProviderMeta } from '../provider-icons.js';
import {
  createClaudeAccount, deleteClaudeAccount, loginClaudeAccount, patchClaudeAccount, setClaudeWorkerAccount, signOutClaudeAccount,
  createCodexAccount, deleteCodexAccount, loginCodexAccount, patchCodexAccount, setCodexWorkerAccount, signOutCodexAccount,
} from './asst-api.js';
import { accountBadge, accountIdentity, accountName, accountText, accountUsable, apiKeyErrorText, credentialRows, modeChoices } from '../account-view.js';
import { providerApiKeyRequest } from '../ui-provider-terminal-auth.js';

const ICON_X = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tf(t) {
  return (key, fallback, params) => {
    const v = typeof t === 'function' ? t(key, params) : undefined;
    return v && v !== key ? v : fallback;
  };
}

// What each provider's account calls on the server (assistant API + the panels' owner-guarded routes).
const PROVIDER_API = {
  'claude-code': {
    view: 'claude', list: getCachedClaudeAccounts, refresh: () => fetchClaudeAccounts(true), worker: getClaudeWorkerAccountId,
    create: createClaudeAccount, login: loginClaudeAccount, patch: patchClaudeAccount, remove: deleteClaudeAccount,
    setWorker: setClaudeWorkerAccount, signOut: signOutClaudeAccount, keyProvider: 'claude', changed: 'sync:claude:accounts-changed',
  },
  codex: {
    view: 'codex', list: getCachedCodexAccounts, refresh: () => fetchCodexAccounts(true), worker: getCodexWorkerAccountId,
    create: createCodexAccount, login: loginCodexAccount, patch: patchCodexAccount, remove: deleteCodexAccount,
    setWorker: setCodexWorkerAccount, signOut: signOutCodexAccount, keyProvider: 'codex', changed: 'sync:codex:accounts-changed',
  },
};
const apiFor = (provider) => PROVIDER_API[provider === 'codex' ? 'codex' : 'claude-code'];

/**
 * Add-account flow: the account is made at once; how it signs in (the provider's own login, or an API key)
 * is chosen on its row next. Returns { ok, choose: true, account }.
 */
export async function startAddAccount(provider, label, ui = {}) {
  const t = tf(ui.t);
  const api = apiFor(provider);
  const name = String(label || '').trim();
  const created = await api.create(name || undefined);
  const account = created?.account || created;
  if (!account?.id) throw new Error(t('assistant.accounts.createFailed', 'Account could not be created'));
  const accounts = await api.refresh();
  return { ok: true, choose: true, account: accounts.find((a) => a.id === account.id) || account };
}

/**
 * Accounts manager modal. hooks: { t, onChanged(provider), onSelect(accountId) }
 * Returns { el, close, renderList, openAdd }.
 */
export function openAccountsManager({ provider = 'claude-code', t: tRaw, onChanged, onSelect } = {}) {
  const t = tf(tRaw);
  const api = apiFor(provider);
  const p = api.view;
  const meta = getProviderMeta(provider);
  const overlay = el('div', 'asst-modal-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('assistant.accounts.title', '{provider} accounts', { provider: meta.label }));
  const modal = el('div', 'asst-modal');
  modal.innerHTML = `
    <div class="asst-modal-head"><span class="asst-icon" style="color:${esc(meta.color)}">${meta.icon}</span><span>${esc(t('assistant.accounts.title', '{provider} accounts', { provider: meta.label }))}</span><button type="button" class="asst-iconbtn asst-modal-close" aria-label="${esc(t('common.close', 'Close'))}">${ICON_X}</button></div>
    <div class="asst-modal-body">
      <div class="asst-modal-note">${esc(provider === 'codex'
        ? t('assistant.accounts.noteCodex2', 'Each account has its own CODEX_HOME (sign-in, sessions) and runs on its ChatGPT subscription or its API key. "Default" is your ambient ~/.codex.')
        : t('assistant.accounts.noteClaude2', 'Each account has its own CLAUDE_CONFIG_DIR (settings, sign-in, sessions) and runs on its Claude subscription or its API key. "Default" is your ambient ~/.claude.'))}</div>
      <div class="asst-account-list"></div>
      <div class="asst-account-add"></div>
    </div>
    <div class="asst-modal-foot">
      <button type="button" class="asst-btn asst-btn-primary asst-account-add-btn">${esc(t('assistant.accounts.add', 'Add account…'))}</button>
      <span class="asst-modal-spacer"></span>
      <button type="button" class="asst-btn asst-btn-secondary asst-account-done">${esc(t('common.done', 'Done'))}</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const list = modal.querySelector('.asst-account-list');
  const addBox = modal.querySelector('.asst-account-add');
  let busy = false;
  let offChanged = null;

  function close() {
    document.removeEventListener('keydown', onKey, true);
    offChanged?.();
    overlay.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else e.stopPropagation();
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  modal.querySelector('.asst-modal-close').addEventListener('click', close);
  modal.querySelector('.asst-account-done').addEventListener('click', close);

  // Which account is fresh (just added: its row offers the two ways to sign in), which row has its API-key
  // form open, and the last thing a row said.
  const ui = { fresh: '', keyOpen: '', notice: null };
  async function openSignIn(acc) {
    const res = await api.login(acc.id);
    const sessionId = res?.login?.terminalSessionId || res?.terminalSessionId;
    if (sessionId) {
      const { openProviderLoginTerminal } = await import('../ui-terminal.js');
      await openProviderLoginTerminal(sessionId, `${p === 'codex' ? 'Codex' : 'Claude'} sign-in · ${accountName(acc, p)}`);
    }
  }
  function notice(id, text) { ui.notice = text ? { id, text } : null; renderList(); }
  async function act(acc, work, done = '') {
    try {
      await work();
      ui.notice = done ? { id: acc.id, text: done } : null;
      await api.refresh();
      onChanged?.(provider);
    } catch (err) { ui.notice = { id: acc.id, text: err?.message || String(err) }; }
    if (overlay.isConnected) renderList();
  }
  function button(row, text, onClick, kind = 'secondary') {
    const b = el('button', `asst-btn asst-btn-${kind}`, text);
    b.type = 'button';
    b.addEventListener('click', async () => { b.disabled = true; try { await onClick(); } finally { b.disabled = false; } });
    row.appendChild(b);
    return b;
  }
  function renderActions(acc, actionsRow, row) {
    const worker = api.worker() === acc.id;
    const label = accountName(acc, p);
    if (onSelect) {
      const use = button(actionsRow, t('assistant.accounts.useBrain', 'Use for the brain'), async () => { onSelect(acc.id); close(); });
      use.disabled = !accountUsable(acc);
    }
    if (!worker) {
      const workersSet = provider === 'codex'
        ? t('assistant.accounts.codexWorkersSet', 'Codex workers now use {label} when a dispatch names no account.', { label })
        : t('assistant.accounts.workersSet', 'Claude Code workers now use {label} when a dispatch names no account.', { label });
      const w = button(actionsRow, t('assistant.accounts.useWorkers', 'Use for workers'), () => act(acc, () => api.setWorker(acc.id), workersSet));
      w.disabled = !accountUsable(acc);
    }
    for (const m of modeChoices(acc, p)) {
      if (m.current) continue;
      button(actionsRow, `${accountText('uses', {}, p)}: ${m.label}`, () => act(acc, () => api.patch(acc.id, { mode: m.mode }),
        accountText(m.mode === 'apiKey' ? 'modeSetApiKey' : 'modeSetSubscription', { label }, p)));
    }
    for (const c of credentialRows(acc, p)) {
      if (c.action === 'signIn') button(actionsRow, c.actionText, () => act(acc, () => openSignIn(acc), accountText('signInPending', {}, p)), ui.fresh === acc.id ? 'primary' : 'secondary');
      if (c.action === 'addKey') button(actionsRow, c.actionText, async () => { ui.keyOpen = acc.id; ui.notice = null; renderList(); });
      if (c.action === 'signOut') button(actionsRow, `${c.actionText} · ${c.name}`, async () => {
        if (!window.confirm(accountText('confirmSignOut', { label }, p))) return;
        await act(acc, () => api.signOut(acc.id, 'subscription'), accountText('signedOutNote', { label }, p));
      });
      if (c.action === 'removeKey') button(actionsRow, c.actionText, async () => {
        if (!window.confirm(accountText('confirmRemoveKey', { label }, p))) return;
        await act(acc, () => api.signOut(acc.id, 'apiKey'), accountText('keyRemovedNote', { label }, p));
      });
    }
    if (ui.keyOpen === acc.id) {
      const form = el('form', 'asst-account-form');
      const input = document.createElement('input');
      input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.required = true;
      input.className = 'asst-dd-input'; input.placeholder = accountText('keyPlaceholder', {}, p);
      input.setAttribute('aria-label', accountText('keyLabel', { label }, p));
      const save = el('button', 'asst-btn asst-btn-primary', accountText('save', {}, p)); save.type = 'submit';
      const cancel = el('button', 'asst-btn asst-btn-secondary', accountText('cancel', {}, p)); cancel.type = 'button';
      cancel.addEventListener('click', () => { input.value = ''; ui.keyOpen = ''; renderList(); });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let key = input.value; input.value = '';
        if (!key) return;
        save.disabled = cancel.disabled = input.disabled = true;
        notice(acc.id, accountText('checkingKey', {}, p));
        try {
          await providerApiKeyRequest(api.keyProvider, acc.id, key);
          ui.keyOpen = ''; ui.fresh = '';
          ui.notice = { id: acc.id, text: accountText('keySavedNote', { label }, p) };
          await api.refresh();
          onChanged?.(provider);
        } catch (err) { ui.notice = { id: acc.id, text: apiKeyErrorText(p, err?.code) }; }
        finally { key = null; }
        if (overlay.isConnected) renderList();
      });
      form.append(input, save, cancel);
      row.appendChild(form);
      setTimeout(() => input.focus(), 0);
    }
    if (ui.notice?.id === acc.id) row.appendChild(el('div', 'asst-account-msg', ui.notice.text));
  }

  function renderList() {
    const accounts = api.list();
    list.innerHTML = '';
    if (!accounts.length) { list.appendChild(el('div', 'asst-modal-note', t('assistant.accounts.empty', 'No accounts yet.'))); return; }
    for (const acc of accounts) {
      const row = el('div', `asst-account-row ${p}`);
      row.dataset.id = acc.id;
      const main = el('div', 'asst-account-main');
      const head = el('div', 'asst-account-head');
      head.appendChild(el('span', 'asst-account-label', accountName(acc, p)));
      const badge = accountBadge(acc, p);
      const chip = el('span', 'asst-account-badge', badge.text);
      chip.dataset.tone = badge.tone;
      head.appendChild(chip);
      main.appendChild(head);
      const worker = api.worker() === acc.id;
      const sub = [accountIdentity(acc) || (acc.signedIn === false ? accountText('notSignedIn', {}, p) : accountText('checking', {}, p)), worker ? t('assistant.accounts.workerTag', 'workers use it') : ''].filter(Boolean).join(' · ');
      main.appendChild(el('div', 'asst-account-sub', sub));
      const creds = el('div', 'asst-account-creds');
      for (const c of credentialRows(acc, p)) {
        const line = el('div', 'asst-account-cred');
        line.appendChild(el('span', 'asst-account-cred-k', c.name));
        line.appendChild(el('span', '', `${c.text}${c.inUse ? ` · ${accountText('inUse', {}, p)}` : ''}`));
        creds.appendChild(line);
      }
      main.appendChild(creds);
      row.appendChild(main);
      const actions = el('div', 'asst-account-actions');
      row.appendChild(actions);
      renderActions(acc, actions, row);
      if (acc.id !== 'default' && !acc.isDefault) {
        button(actions, t('common.rename', 'Rename'), async () => {
          const value = window.prompt(t('assistant.accounts.renamePrompt', 'Name for {label}', { label: accountName(acc, p) }), acc.label || '');
          if (!value || !value.trim() || value.trim() === acc.label) return;
          await act(acc, () => api.patch(acc.id, { label: value.trim() }));
        });
        button(actions, t('common.remove', 'Remove'), async () => {
          if (!window.confirm(accountText('confirmRemove', { label: accountName(acc, p) }, p))) return;
          await act(acc, () => api.remove(acc.id));
        }, 'danger');
      }
      list.appendChild(row);
    }
  }

  function renderAddForm() {
    if (busy) return;
    addBox.innerHTML = '';
    const form = el('div', 'asst-login-box');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'asst-dd-input';
    input.placeholder = t('assistant.accounts.labelPlaceholder', 'Label (e.g. Work)');
    input.setAttribute('aria-label', input.placeholder);
    const actions = el('div', 'asst-control-actions');
    const go = el('button', 'asst-btn asst-btn-primary', t('assistant.accounts.create', 'Add account'));
    go.type = 'button';
    const cancel = el('button', 'asst-btn asst-btn-secondary', t('common.cancel', 'Cancel'));
    cancel.type = 'button';
    const status = el('div', 'asst-modal-note');
    actions.append(go, cancel);
    form.append(input, actions, status);
    addBox.appendChild(form);
    input.focus();
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go.click(); });
    cancel.addEventListener('click', () => { addBox.innerHTML = ''; });
    go.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      go.disabled = true;
      input.disabled = true;
      try {
        const result = await startAddAccount(provider, input.value, { t: tRaw });
        onChanged?.(provider);
        ui.fresh = result.account.id;
        ui.notice = { id: result.account.id, text: accountText('freshPrompt', { label: accountName(result.account, p) }, p) };
        addBox.innerHTML = '';
        renderList();
      } catch (err) {
        status.textContent = err?.message || String(err);
      } finally {
        busy = false;
        go.disabled = false;
        input.disabled = false;
      }
    });
  }

  modal.querySelector('.asst-account-add-btn').addEventListener('click', renderAddForm);
  renderList();
  api.refresh().then(() => { if (overlay.isConnected) renderList(); }).catch(() => {});
  // Another window or surface changed an account (signed in, a key, its mode): the list follows.
  offChanged = on(api.changed, () => {
    if (!overlay.isConnected) { offChanged?.(); return; }
    api.refresh().then(() => { if (overlay.isConnected && !ui.keyOpen) renderList(); }).catch(() => {});
  });

  return { el: overlay, close, renderList, openAdd: renderAddForm };
}
