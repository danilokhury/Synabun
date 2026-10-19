// Managed ChatGPT auth stays inside the existing account-scoped app-server. An API key never goes
// through here: Codex keeps one credential per CODEX_HOME, so a native API-key login would replace the
// account's ChatGPT sign-in. SynaBun keeps the key per account instead (lib/codex-accounts.js).
export function createCodexPanelAuth({ request, accountId, onChange = () => {}, onSuccess = async () => {}, timeoutMs = 10 * 60_000 }) {
  let state = { status: 'idle' }, generation = 0, timer, early = [];
  const snapshot = () => state.accountId && state.accountId !== accountId() ? { status: 'idle', accountId: accountId() } : ({ ...state, accountId: state.accountId || accountId() });
  const update = patch => { state = { ...state, ...patch }; onChange(snapshot()); return snapshot(); };
  const active = () => ['starting', 'pending'].includes(state.status);
  async function complete(params) {
    if (state.status === 'starting') { early.push(params); return; }
    if (state.status !== 'pending' || !params.loginId || params.loginId !== state.loginId || state.accountId !== accountId()) return;
    const epoch = generation;
    clearTimeout(timer);
    update({ status: params.success ? 'success' : 'error', authUrl: '', verificationUrl: '', userCode: '', error: params.success ? '' : (params.error || 'Codex sign-in failed. Try again.') });
    if (params.success) {
      try { await onSuccess(state.accountId); }
      catch { if (epoch === generation) update({ error: 'Signed in, but account details could not refresh. Use Refresh.' }); }
    }
  }
  async function start(loginType = 'chatgpt') {
    if (!['chatgpt', 'chatgptDeviceCode'].includes(loginType)) throw new Error('Unsupported managed login type');
    if (active()) return snapshot();
    const epoch = ++generation;
    early = [];
    update({ status: 'starting', accountId: accountId(), loginId: null, authUrl: '', verificationUrl: '', userCode: '', error: '' });
    try {
      const login = await request('account/login/start', { type: loginType }, 15000);
      if (epoch !== generation) {
        if (login?.loginId) await request('account/login/cancel', { loginId: login.loginId }, 10000);
        return snapshot();
      }
      if (!login?.loginId) throw new Error('Codex did not return a managed sign-in attempt. Update Codex and retry.');
      update({ status: 'pending', loginId: login.loginId, authUrl: login.authUrl || '', verificationUrl: login.verificationUrl || '', userCode: login.userCode || '' });
      timer = setTimeout(() => {
        const timedGeneration = generation;
        void cancel().then(() => {
          if (generation === timedGeneration + 1 && state.status === 'cancelled') update({ status: 'error', error: 'Codex sign-in timed out. Try again.' });
        }).catch(() => {});
      }, timeoutMs); timer.unref?.();
      for (const params of early) await complete(params);
      early = [];
    } catch (error) { if (epoch === generation) update({ status: 'error', error: error.message }); }
    return snapshot();
  }
  async function cancel() {
    if (!active()) return snapshot();
    const loginId = state.loginId;
    const epoch = ++generation; clearTimeout(timer);
    update({ status: 'cancelled', authUrl: '', verificationUrl: '', userCode: '', error: '' });
    if (loginId) {
      try { await request('account/login/cancel', { loginId }, 10000); }
      catch (error) { if (epoch === generation) update({ status: 'error', error: `Could not cancel Codex sign-in: ${error.message}` }); throw error; }
    }
    return snapshot();
  }
  function interrupted() {
    ++generation; clearTimeout(timer);
    if (active()) update({ status: 'error', authUrl: '', verificationUrl: '', userCode: '', error: 'Codex disconnected during sign-in. Reconnect and retry.' });
  }
  function reset() { ++generation; clearTimeout(timer); state = { status: 'idle', accountId: accountId() }; return update({}); }
  return { start, cancel, complete, snapshot, active, interrupted, reset };
}
