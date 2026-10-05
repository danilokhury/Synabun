// ═══════════════════════════════════════════
// SynaBun Assistant — account profiles (Claude + Codex)
// ═══════════════════════════════════════════
// Claude: POST /api/assistant/claude/accounts → POST …/:id/login opens a
// claude-code terminal tab under CLAUDE_CONFIG_DIR (emit terminal:attach-floating)
// → wait for sync:assistant:accounts-changed. Codex: POST …/codex/accounts/add-start
// → show the device-auth URL/code → poll fetchCodexAccounts(true).

import { emit, on } from '../state.js';
import { fetchClaudeAccounts, fetchCodexAccounts, getCachedClaudeAccounts, getCachedCodexAccounts } from '../agent-runtime-options.js';
import { getProviderMeta } from '../provider-icons.js';
import {
  createClaudeAccount, deleteClaudeAccount, loginClaudeAccount, patchClaudeAccount,
  deleteCodexAccount, patchCodexAccount, startCodexAccountAdd,
} from './asst-api.js';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_POLL_MS = 3000;
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

function listFor(provider) {
  return provider === 'codex' ? getCachedCodexAccounts() : getCachedClaudeAccounts();
}

async function refreshFor(provider) {
  return provider === 'codex' ? fetchCodexAccounts(true) : fetchClaudeAccounts(true);
}

/** Resolve once `sync:assistant:accounts-changed` fires for the provider (or times out). */
function waitForAccountsChanged(provider, timeoutMs = LOGIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const off = on('sync:assistant:accounts-changed', (msg) => {
      if (done) return;
      if (msg?.provider && msg.provider !== provider) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(true);
    });
    const timer = setTimeout(() => { if (!done) { done = true; off(); resolve(false); } }, timeoutMs);
  });
}

/**
 * Add-account flow. Returns { ok, account, cancelled }.
 * ui: { t, setStatus(text), showLogin({ authUrl, userCode }), isCancelled() }
 */
export async function startAddAccount(provider, label, ui = {}) {
  const t = tf(ui.t);
  const name = String(label || '').trim() || (provider === 'codex' ? 'Codex account' : 'Claude account');
  if (provider === 'claude-code') {
    const created = await createClaudeAccount(name);
    const account = created?.account || created;
    if (!account?.id) throw new Error(t('assistant.accounts.createFailed', 'Account could not be created'));
    ui.setStatus?.(t('assistant.accounts.openingLogin', 'Opening a Claude Code terminal for login…'));
    const login = await loginClaudeAccount(account.id);
    if (login?.terminalSessionId) {
      emit('terminal:expect-managed');
      emit('terminal:attach-floating', { terminalSessionId: login.terminalSessionId, profile: login.profile || 'claude-code', snapToPanel: true });
    }
    ui.setStatus?.(t('assistant.accounts.waitingLogin', 'Finish the login in the terminal window. Waiting…'));
    const changed = await waitForAccountsChanged('claude-code');
    const accounts = await refreshFor('claude-code');
    const fresh = accounts.find(a => a.id === account.id) || account;
    return { ok: changed || !!fresh?.email, account: fresh, timedOut: !changed };
  }
  if (provider === 'codex') {
    const started = await startCodexAccountAdd(name);
    const accountId = started?.accountId || started?.account?.id;
    const login = started?.login || {};
    ui.showLogin?.({ authUrl: login.authUrl || login.url || '', userCode: login.userCode || login.code || '' });
    ui.setStatus?.(t('assistant.accounts.waitingDevice', 'Complete the sign-in in your browser. Waiting…'));
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let changedEarly = false;
    const offChanged = on('sync:assistant:accounts-changed', (msg) => { if (!msg?.provider || msg.provider === 'codex') changedEarly = true; });
    try {
      while (Date.now() < deadline) {
        if (ui.isCancelled?.()) return { ok: false, cancelled: true };
        const accounts = await fetchCodexAccounts(true).catch(() => []);
        const found = accounts.find(a => a.id === accountId);
        if (found && (found.email || found.loggedIn === true || found.status === 'ready' || changedEarly)) return { ok: true, account: found };
        await new Promise(r => setTimeout(r, CODEX_POLL_MS));
      }
    } finally {
      offChanged();
    }
    return { ok: false, timedOut: true, account: { id: accountId, label: name } };
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Accounts manager modal. hooks: { t, onChanged(provider), onSelect(accountId) }
 * Returns { el, close }.
 */
export function openAccountsManager({ provider = 'claude-code', t: tRaw, onChanged, onSelect } = {}) {
  const t = tf(tRaw);
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
        ? t('assistant.accounts.noteCodex', 'Each account maps to its own CODEX_HOME. Removing an account that a run is using is refused.')
        : t('assistant.accounts.noteClaude', 'Each account gets its own CLAUDE_CONFIG_DIR (settings, credentials, sessions). "Default" is your ambient ~/.claude.'))}</div>
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
  let cancelled = false;
  let busy = false;

  function close() {
    cancelled = true;
    document.removeEventListener('keydown', onKey, true);
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

  function renderList() {
    const accounts = listFor(provider);
    list.innerHTML = '';
    if (!accounts.length) { list.appendChild(el('div', 'asst-modal-note', t('assistant.accounts.empty', 'No accounts yet.'))); return; }
    for (const acc of accounts) {
      const row = el('div', 'asst-account-row');
      row.dataset.id = acc.id;
      const main = el('div', 'asst-account-main');
      main.appendChild(el('div', 'asst-account-label', acc.label || acc.id));
      const sub = [acc.email, acc.isDefault || acc.id === 'default' ? t('assistant.accounts.ambient', 'ambient config') : '', acc.inUse ? t('assistant.accounts.inUse', 'in use') : ''].filter(Boolean).join(' · ');
      main.appendChild(el('div', 'asst-account-sub', sub || acc.id));
      row.appendChild(main);

      if (onSelect) {
        const use = el('button', 'asst-btn asst-btn-secondary', t('assistant.accounts.use', 'Use'));
        use.type = 'button';
        use.addEventListener('click', () => { onSelect(acc.id); close(); });
        row.appendChild(use);
      }
      if (provider === 'claude-code' && !acc.email && acc.id !== 'default') {
        const login = el('button', 'asst-btn asst-btn-secondary', t('assistant.accounts.login', 'Log in'));
        login.type = 'button';
        login.addEventListener('click', async () => {
          login.disabled = true;
          try {
            const res = await loginClaudeAccount(acc.id);
            if (res?.terminalSessionId) {
              emit('terminal:expect-managed');
              emit('terminal:attach-floating', { terminalSessionId: res.terminalSessionId, profile: res.profile || 'claude-code', snapToPanel: true });
            }
            await waitForAccountsChanged('claude-code');
            await refreshFor(provider);
            onChanged?.(provider);
            renderList();
          } catch (err) {
            addBox.textContent = err?.message || String(err);
          } finally { login.disabled = false; }
        });
        row.appendChild(login);
      }
      const rename = el('button', 'asst-btn asst-btn-secondary', t('common.rename', 'Rename'));
      rename.type = 'button';
      rename.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'asst-dd-input';
        input.value = acc.label || '';
        main.replaceWith(input);
        input.focus();
        input.select();
        const commit = async () => {
          const value = input.value.trim();
          if (value && value !== acc.label) {
            try {
              if (provider === 'codex') await patchCodexAccount(acc.id, { label: value });
              else await patchClaudeAccount(acc.id, { label: value });
              await refreshFor(provider);
              onChanged?.(provider);
            } catch (err) { addBox.textContent = err?.message || String(err); }
          }
          renderList();
        };
        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { input.value = acc.label || ''; input.blur(); }
        });
      });
      row.appendChild(rename);
      if (acc.id !== 'default' && !acc.isDefault) {
        const remove = el('button', 'asst-btn asst-btn-danger', t('common.remove', 'Remove'));
        remove.type = 'button';
        remove.addEventListener('click', async () => {
          if (!window.confirm(t('assistant.accounts.confirmRemove', 'Remove account "{label}"? Its config directory is kept on disk.', { label: acc.label || acc.id }))) return;
          remove.disabled = true;
          try {
            if (provider === 'codex') await deleteCodexAccount(acc.id);
            else await deleteClaudeAccount(acc.id);
            await refreshFor(provider);
            onChanged?.(provider);
            renderList();
          } catch (err) {
            addBox.textContent = err?.status === 409 ? t('assistant.accounts.inUseError', 'That account is in use by a running session.') : (err?.message || String(err));
            remove.disabled = false;
          }
        });
        row.appendChild(remove);
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
    const go = el('button', 'asst-btn asst-btn-primary', provider === 'codex' ? t('assistant.accounts.startDevice', 'Start sign-in') : t('assistant.accounts.createAndLogin', 'Create & log in'));
    go.type = 'button';
    const cancel = el('button', 'asst-btn asst-btn-secondary', t('common.cancel', 'Cancel'));
    cancel.type = 'button';
    const status = el('div', 'asst-modal-note');
    const loginInfo = el('div', 'asst-login-box');
    loginInfo.hidden = true;
    actions.append(go, cancel);
    form.append(input, actions, status, loginInfo);
    addBox.appendChild(form);
    input.focus();
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go.click(); });
    cancel.addEventListener('click', () => { cancelled = true; addBox.innerHTML = ''; });
    go.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      cancelled = false;
      go.disabled = true;
      input.disabled = true;
      try {
        const result = await startAddAccount(provider, input.value, {
          t: tRaw,
          setStatus: (text) => { status.textContent = text; },
          isCancelled: () => cancelled,
          showLogin: ({ authUrl, userCode }) => {
            loginInfo.hidden = false;
            loginInfo.innerHTML = `${authUrl ? `<a class="asst-btn asst-btn-primary" href="${esc(authUrl)}" target="_blank" rel="noopener">${esc(t('assistant.accounts.openLogin', 'Open sign-in page'))}</a>` : ''}${userCode ? `<div>${esc(t('assistant.accounts.enterCode', 'Enter this code:'))} <span class="asst-login-code">${esc(userCode)}</span></div>` : ''}`;
          },
        });
        await refreshFor(provider);
        onChanged?.(provider);
        renderList();
        if (result.ok) {
          addBox.innerHTML = '';
          if (onSelect && result.account?.id) onSelect(result.account.id);
        } else if (result.cancelled) {
          addBox.innerHTML = '';
        } else {
          status.textContent = t('assistant.accounts.loginTimeout', 'Login was not confirmed. The account was created — use "Log in" to retry.');
        }
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
  refreshFor(provider).then(() => { if (overlay.isConnected) renderList(); }).catch(() => {});

  return { el: overlay, close, renderList, openAdd: renderAddForm };
}
