// Small shared sign-in view; each caller supplies its panel's existing classes
// and native transport. Nothing here handles provider credentials.
export function providerAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function providerAuthSnapshot(container) {
  if (!container?.querySelector?.('[data-provider-auth-card], [data-provider-auth], [data-provider-logged-out]')) return container?.innerHTML || '';
  const clone = container.cloneNode(true);
  clone.querySelectorAll('[data-provider-auth-card], [data-provider-auth], [data-provider-logged-out]').forEach(node => node.remove());
  return clone.innerHTML;
}

// `statusText(account, state)` (optional): what the card says while no sign-in is under way, from the
// caller's own account model (Claude: its subscription and API key). `providerSignedIn(account)`
// (optional): whether the provider's own login is there ("Sign in again" instead of "Sign in").
export function mountProviderAuth({ host, provider, read, start, cancel, refresh, submitCode, buttonClass, inputClass, textClass, isCurrent = () => true, onSuccess = () => {}, onAccountChange = () => {}, pollMs = 1500, statusText = null, providerSignedIn = null }) {
  const root = document.createElement('div');
  root.dataset.providerAuth = provider;
  const status = document.createElement('div'); status.className = textClass; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div');
  const handoff = document.createElement('a'); handoff.className = buttonClass; handoff.target = '_blank'; handoff.rel = 'noopener noreferrer'; handoff.textContent = 'Open sign-in page'; handoff.hidden = true;
  const code = document.createElement('div'); code.className = textClass; code.hidden = true;
  const manual = document.createElement('form'); manual.hidden = true;
  const codeInput = document.createElement('input'); codeInput.type = 'password'; codeInput.autocomplete = 'off'; codeInput.className = inputClass || ''; codeInput.setAttribute('aria-label', 'Claude sign-in code'); codeInput.placeholder = 'Paste code only if Claude asks';
  const codeSubmit = document.createElement('button'); codeSubmit.type = 'submit'; codeSubmit.className = buttonClass; codeSubmit.textContent = 'Submit code';
  manual.append(codeInput, codeSubmit);
  manual.addEventListener('submit', event => { event.preventDefault(); const value = codeInput.value; codeInput.value = ''; if (value && submitCode) void perform(() => submitCode(state, value)); });
  root.append(status, actions, handoff, code, manual); host.append(root);
  let state = { status: 'idle' }, account = null, timer, disposed = false, busy = false, succeeded = false, version = 0, pushed = 0, transportError = '';
  const current = () => !disposed && root.isConnected && isCurrent();
  const pending = () => ['starting', 'pending'].includes(state.status);
  function button(label, work) {
    const el = document.createElement('button'); el.type = 'button'; el.className = buttonClass; el.textContent = label; el.disabled = busy;
    el.addEventListener('click', () => void perform(work)); actions.append(el); return el;
  }
  function apply(result) {
    if (result?.state) { state = result.state; if (pending()) succeeded = false; }
    if (result?.account) {
      account = result.account;
      if (account.loggedIn === false && state.status === 'success') state = { ...state, status: 'idle' };
      onAccountChange(account);
    }
  }
  function render() {
    actions.replaceChildren();
    const signedIn = typeof providerSignedIn === 'function' ? providerSignedIn(account) === true : account?.loggedIn === true;
    // Asked on every render (the caller also learns the state); used only while no sign-in is under way.
    const own = typeof statusText === 'function' ? statusText(account, state) : '';
    status.textContent = transportError || state.error || (['starting', 'pending', 'cancelled'].includes(state.status) ? '' : own) || ({ starting: 'Starting sign-in…', pending: 'Finish sign-in in your browser, then return here.', success: `Signed in${account?.email ? ` as ${account.email}` : ''}.`, cancelled: 'Sign-in cancelled.' }[state.status])
      || (signedIn ? `Signed in${account.email ? ` as ${account.email}` : ''}.` : 'Not signed in.');
    if (pending()) button('Cancel sign-in', () => cancel(state));
    else button(signedIn ? `Sign in again with ${provider}` : `Sign in with ${provider}`, () => start());
    button('Refresh', async () => {
      const result = await refresh();
      return result;
    });
    const url = providerAuthUrl(state.authUrl || state.verificationUrl);
    handoff.hidden = !pending() || !url;
    if (url && pending()) handoff.href = url; else handoff.removeAttribute('href');
    code.hidden = !pending() || !state.userCode;
    code.textContent = state.userCode ? `Enter this code: ${state.userCode}` : '';
    manual.hidden = !submitCode || state.status !== 'pending'; codeSubmit.disabled = busy;
    if (manual.hidden) codeInput.value = '';
  }
  async function perform(work) {
    if (busy || !current()) return;
    busy = true; transportError = ''; const epoch = ++version; const push = pushed; clearTimeout(timer); render();
    try {
      const result = await work();
      if (!current() || epoch !== version) return;
      // Native notifications may have completed while a request was in flight.
      if (push === pushed) apply(result);
    } catch (error) { if (current() && epoch === version) transportError = error.message || 'Sign-in could not continue. Try again.'; }
    finally {
      busy = false;
      if (current() && epoch === version) {
        render();
        schedule();
      }
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (!current()) return;
    if (pending()) timer = setTimeout(poll, pollMs);
    else if (state.status === 'success' && !succeeded) {
      succeeded = true;
      void perform(async () => { const result = await refresh(); await onSuccess(result); return result; });
    }
  }
  async function poll() {
    if (!current()) return;
    const epoch = version, push = pushed;
    try { const result = await read(); if (!current() || epoch !== version || push !== pushed) return; apply(result); render(); schedule(); }
    catch (error) { if (current()) { status.textContent = error.message || 'Could not refresh sign-in. Use Refresh to retry.'; } }
  }
  render();
  void perform(() => refresh());
  return { update(result) { if (!current()) return; ++pushed; apply(result); render(); if (!busy) schedule(); }, dispose() { disposed = true; ++version; clearTimeout(timer); root.remove(); } };
}
