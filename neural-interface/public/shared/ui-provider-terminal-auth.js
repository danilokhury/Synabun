import { apiKeyErrorText } from './account-view.js';

export const PROVIDER_TERMINAL_AUTH_STYLES = `
  .provider-auth-required { padding: 0 !important; }
  .provider-auth-required::before,
  .provider-auth-required > :not([data-provider-logged-out]) { display: none !important; }
  [data-provider-logged-out] {
    display: flex; flex: 1; min-height: 100%; box-sizing: border-box;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; padding: 24px; text-align: center;
    color: var(--cxp-text-2, var(--t-primary)); font: inherit;
  }
  [data-provider-logged-out][hidden] { display: none; }
  .provider-auth-logo { width: 48px; height: 48px; color: var(--cxp-text, var(--t-bright)); }
  .provider-auth-logo svg { width: 100%; height: 100%; }
  .provider-auth-message { margin: 0; font-size: var(--cxp-fs-md, 13px); }
  .provider-auth-button {
    border: none; border-radius: var(--cxp-radius-sm, var(--r-small)); padding: 8px 12px;
    background: var(--cxp-solid, var(--s-active)); color: var(--cxp-on-solid, var(--t-bright));
    font: inherit; font-size: var(--cxp-fs-sm, 12px); font-weight: 500; cursor: pointer;
  }
  .provider-auth-button:disabled { opacity: .6; cursor: default; }
  .provider-auth-button:focus-visible { outline: 2px solid var(--cxp-focus, var(--t-bright)); outline-offset: 2px; }
  .provider-auth-secondary {
    background: transparent; color: var(--cxp-text-2, var(--t-muted));
    border: 1px solid var(--cxp-border, var(--b-light));
  }
  .provider-auth-key { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 280px; }
  .provider-auth-key[hidden], .provider-auth-secondary[hidden] { display: none; }
  .provider-auth-key input {
    min-width: 0; box-sizing: border-box; width: 100%; padding: 8px 12px;
    border: 1px solid var(--cxp-border, var(--b-light)); border-radius: var(--cxp-radius-sm, var(--r-small));
    background: var(--cxp-surface-1, var(--s-subtle)); color: var(--cxp-text, var(--t-bright)); font: inherit;
  }
  .provider-auth-key input:focus-visible { outline: 2px solid var(--cxp-focus, var(--t-bright)); outline-offset: 2px; }
  .provider-auth-key-actions { display: flex; justify-content: center; gap: 8px; }
  .provider-auth-error { margin: 0; color: var(--cxp-danger, var(--t-muted)); font-size: var(--cxp-fs-sm, 12px); }
`;

async function terminalRequest(provider, accountId, method = 'GET') {
  const response = await fetch(`/api/provider-panel-auth/${provider}/${encodeURIComponent(accountId)}/terminal`, {
    method, cache: 'no-store', ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'Could not open the sign-in terminal.');
  return data.terminal;
}

// Open a provider's own sign-in for an account in SynaBun's terminal (the guarded route picks the
// CLI, the account's config directory and its environment; no command text leaves the page).
export async function startProviderTerminalLogin(provider, accountId, label = '') {
  const terminal = await terminalRequest(provider, accountId, 'POST');
  if (terminal.status === 'error') throw new Error(terminal.error || 'Could not open the sign-in terminal.');
  const { openProviderLoginTerminal } = await import('./ui-terminal.js');
  await openProviderLoginTerminal(terminal.sessionId, label || `${provider === 'claude' ? 'Claude' : 'Codex'} sign-in`);
  return terminal;
}

// Only local, allowlisted messages enter the DOM; never provider error text (account-view.js words them).
function apiKeyErrorMessage(provider, code) {
  return apiKeyErrorText(provider, code);
}

// `target` is ignored by servers since keys are kept per account (an older page sent its connection's).
export async function providerApiKeyRequest(provider, accountId, key, target) {
  const failure = code => Object.assign(new Error(apiKeyErrorMessage(provider, code)), { code });
  try {
    let response;
    try {
      response = await fetch(`/api/provider-panel-auth/${provider}/${encodeURIComponent(accountId)}/api-key`, {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, ...(target ? { target } : {}) }),
      });
    } catch { throw failure('server_unreachable'); }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      let code = { 400: 'invalid_key', 401: 'key_rejected', 403: 'permission_denied', 404: 'account_unavailable', 409: 'account_busy', 413: 'invalid_key', 503: 'verification_unavailable' }[response.status] || 'storage_failed';
      if (response.status === 400 && data?.code === 'oauth_token') code = 'oauth_token';
      if (response.status === 503 && data?.code === 'verification_unreachable') code = 'verification_unreachable';
      throw failure(code);
    }
    if (data?.ok !== true) throw failure('storage_failed');
  } finally { key = null; }
}

// Auth is unknown until a provider says otherwise; a failed read never means logout.
// `message` (optional): the line under the logo (default "Sign in to Claude to continue.").
// `moreAction` (optional): { label, run } — one more quiet button under the others (the header account menu).
export function mountProviderTerminalAuth({ host, provider, accountId, logo, readAccount, isCurrent = () => true, message: messageText = '', moreAction = null,
  onSignedIn = () => {}, requestApiKey = providerApiKeyRequest, pollMs = 3000, requestTerminal = terminalRequest,
  openTerminal = async terminal => {
    const { openProviderLoginTerminal } = await import('./ui-terminal.js');
    await openProviderLoginTerminal(terminal.sessionId, `${provider === 'claude' ? 'Claude' : 'Codex'} sign-in`);
  } }) {
  if (!document.getElementById('provider-terminal-auth-styles')) {
    const style = document.createElement('style'); style.id = 'provider-terminal-auth-styles';
    style.textContent = PROVIDER_TERMINAL_AUTH_STYLES; document.head.append(style);
  }
  const root = document.createElement('div'); root.dataset.providerLoggedOut = provider;
  const icon = document.createElement('div'); icon.className = 'provider-auth-logo'; icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = logo; // A bundled provider SVG supplied by the owning panel.
  const message = document.createElement('p'); message.className = 'provider-auth-message';
  message.textContent = messageText || `Sign in to ${provider === 'claude' ? 'Claude' : 'Codex'} to continue.`;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'provider-auth-button';
  const error = document.createElement('p'); error.className = 'provider-auth-error'; error.setAttribute('role', 'status'); error.setAttribute('aria-live', 'polite');
  const secondary = document.createElement('button'); secondary.type = 'button';
  secondary.className = 'provider-auth-button provider-auth-secondary'; secondary.textContent = 'Use an API key instead';
  secondary.setAttribute('aria-expanded', 'false');
  const form = document.createElement('form'); form.className = 'provider-auth-key'; form.hidden = true;
  const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('aria-label', 'API key'); input.placeholder = 'Paste API key'; input.required = true;
  const actions = document.createElement('div'); actions.className = 'provider-auth-key-actions';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'provider-auth-button provider-auth-secondary'; save.textContent = 'Save';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'provider-auth-button provider-auth-secondary'; cancel.textContent = 'Cancel';
  actions.append(save, cancel); form.append(input, actions);
  root.append(icon, message, button, secondary, form, error);
  if (moreAction?.label && typeof moreAction.run === 'function') {
    const more = document.createElement('button'); more.type = 'button';
    more.className = 'provider-auth-button provider-auth-secondary provider-auth-more'; more.textContent = moreAction.label;
    more.addEventListener('click', () => { if (current()) moreAction.run(); });
    root.append(more);
  }
  let loggedIn, terminal = null, busy = false, disposed = false, suspended = false, checking = false, unattached = false, timer, push = 0, issue = '', keyOpen = false, keyBusy = false;
  const current = () => !disposed && isCurrent();
  const pending = () => busy || (!unattached && ['starting', 'pending'].includes(terminal?.status));
  function render() {
    if (!current()) return;
    const visible = loggedIn === false && !suspended;
    root.hidden = !visible; host.classList.toggle('provider-auth-required', visible);
    if (visible) { if (root.parentNode !== host) host.append(root); }
    else root.remove();
    button.disabled = pending() || keyBusy;
    secondary.hidden = keyOpen; secondary.disabled = pending() || keyBusy;
    secondary.setAttribute('aria-expanded', String(keyOpen));
    form.hidden = !keyOpen;
    input.disabled = save.disabled = cancel.disabled = keyBusy || pending();
    save.textContent = keyBusy ? 'Saving…' : 'Save';
    form.setAttribute('aria-busy', String(keyBusy));
    button.textContent = pending() ? 'Finish signing in in the terminal' : `Sign in with ${provider === 'claude' ? 'Claude' : 'Codex'}`;
    error.textContent = issue; error.hidden = !issue;
  }
  function apply(account) {
    if (typeof account?.loggedIn !== 'boolean') return;
    const was = loggedIn; loggedIn = account.loggedIn;
    if (loggedIn) {
      terminal = null; issue = ''; suspended = false; unattached = false; keyOpen = false; input.value = '';
      if (was === false) void onSignedIn();
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (current()) timer = setTimeout(() => void refresh(), pending() ? pollMs : pollMs * 5);
  }
  async function refresh() {
    if (!current() || checking) return;
    if (busy || keyBusy) { schedule(); return; }
    checking = true; const epoch = push;
    try {
      const account = await readAccount();
      if (!current() || epoch !== push) return;
      apply(account);
      if (loggedIn === false) {
        const next = await requestTerminal(provider, accountId);
        if (!current() || epoch !== push) return;
        const ended = terminal?.sessionId && terminal.sessionId === next.sessionId && ['exited', 'error'].includes(next.status);
        terminal = next;
        if (ended || next.status === 'error') issue = next.error || 'Sign-in finished without connecting. Try again.';
      }
    } catch {
      if (current() && epoch === push && pending()) {
        issue = 'Could not check sign-in. Try again.'; terminal = null;
      }
    } finally { checking = false; if (current()) { render(); schedule(); } }
  }
  button.addEventListener('click', async () => {
    if (!current() || pending() || keyBusy || loggedIn !== false) return;
    input.value = ''; keyOpen = false;
    busy = true; issue = ''; unattached = false; ++push; clearTimeout(timer); render();
    try {
      const next = await requestTerminal(provider, accountId, 'POST');
      if (!current() || loggedIn === true) return;
      terminal = next;
      if (next.status === 'error') throw new Error(next.error);
      await openTerminal(next);
    } catch (failure) {
      if (current()) { issue = failure.message || 'Could not open the sign-in terminal.'; unattached = true; }
    } finally { busy = false; if (current()) { render(); schedule(); } }
  });
  secondary.addEventListener('click', () => {
    if (!current() || pending() || keyBusy) return;
    keyOpen = true; issue = ''; render(); input.focus?.();
  });
  cancel.addEventListener('click', () => {
    if (keyBusy) return;
    input.value = ''; keyOpen = false; issue = ''; render(); secondary.focus?.();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    let key = input.value; input.value = '';
    if (!current() || pending() || keyBusy || loggedIn !== false || !key) { key = null; return; }
    keyBusy = true; issue = 'Saving API key…'; ++push; clearTimeout(timer); render();
    let saved = false;
    try {
      await requestApiKey(provider, accountId, key);
      key = null; saved = true;
      if (!current()) return;
      const epoch = push, account = await readAccount();
      if (!current() || epoch !== push) return;
      apply(account);
      if (loggedIn !== true) issue = 'Key saved. Checking sign-in…';
    } catch (failure) {
      if (current() && loggedIn !== true) issue = saved ? 'Key saved. Could not refresh sign-in. Reload the panel.' : apiKeyErrorMessage(provider, failure.code);
    } finally { key = null; keyBusy = false; if (current()) { render(); schedule(); } }
  });
  const observer = new MutationObserver(() => { if (current() && loggedIn === false && !suspended && root.parentNode !== host) render(); });
  observer.observe(host, { childList: true });
  render(); void refresh();
  return {
    refresh,
    update(account) { if (!current()) return; ++push; apply(account); render(); schedule(); },
    suspend() { suspended = true; input.value = ''; render(); },
    dispose() { input.value = ''; disposed = true; ++push; clearTimeout(timer); observer.disconnect(); host.classList.remove('provider-auth-required'); root.remove(); },
  };
}
