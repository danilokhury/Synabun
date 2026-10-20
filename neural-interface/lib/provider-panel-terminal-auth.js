import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { claudeAuthEnv } from './claude-panel-auth.js';
import { applyCodexLaunchEnv } from './codex-accounts.js';

// Only server-owned account records and resolved executables enter the PTY.
// `codexConfigArgs`: the `-c` words every Codex SynaBun starts gets (the Admin sandbox setting's Windows sandbox).
export function providerLoginSpec({ provider, accountId, claudeAccounts, codexAccount, claudeExecutable, codexExecutable, env, codexConfigArgs = [] }) {
  if (!['claude', 'codex'].includes(provider) || typeof accountId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(accountId)) {
    throw Object.assign(new Error('Unknown provider account'), { status: 404 });
  }
  const account = provider === 'claude' ? claudeAccounts.profileFor(accountId) : codexAccount(accountId);
  if (!account || account.id !== accountId) throw Object.assign(new Error('Unknown provider account'), { status: 404 });
  const file = provider === 'claude' ? claudeExecutable()?.path : codexExecutable();
  if (!file || !isAbsolute(file) || /\.(cmd|bat)$/i.test(file)) {
    throw new Error(`Could not resolve the ${provider === 'claude' ? 'Claude' : 'Codex'} executable. Check its installation.`);
  }
  let baseEnv = { ...env };
  if (provider === 'codex') {
    // Every Codex account, Default too: `codex login` writes to that account's CODEX_HOME, with no
    // inherited OpenAI/Codex credential around it (lib/codex-accounts.js CODEX_CREDENTIAL_ENV).
    if (!account.home) throw new Error('This Codex account has no home folder.');
    baseEnv = applyCodexLaunchEnv(baseEnv, { env: { CODEX_HOME: account.home } });
  } else if (accountId !== 'default') {
    if (!account.home) throw new Error('This Claude account has no isolated home.');
    baseEnv = claudeAuthEnv(baseEnv, { CLAUDE_CONFIG_DIR: account.home });
  }
  const args = provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login', ...codexConfigArgs];
  return { launch: /\.[cm]?js$/i.test(file) ? { shell: process.execPath, args: [file, ...args] } : { shell: file, args }, baseEnv };
}

// `onSettled(provider, id, status)` (optional): told once when a sign-in terminal ends ('exited' when the
// CLI exited 0, else 'error'), so the host can ask the provider what it now says about the account.
export function createProviderPanelTerminalAuth({ resolveSpec, createSession, whenSpawned, killSession, timeoutMs = 10 * 60_000, onSettled = null }) {
  const operations = new Map();
  const key = (provider, id) => `${provider}:${id}`;
  const snapshot = op => ({ sessionId: op.sessionId, status: op.status, error: op.error || '' });
  function read(provider, id) {
    resolveSpec(provider, id); // Validate deleted accounts and unsupported providers on reads too.
    const op = operations.get(key(provider, id));
    return op ? snapshot(op) : { status: 'idle' };
  }
  async function start(provider, id) {
    const spec = resolveSpec(provider, id);
    const existing = operations.get(key(provider, id));
    if (existing && ['starting', 'pending'].includes(existing.status)) { await existing.ready; return snapshot(existing); }
    const op = { sessionId: randomBytes(16).toString('hex'), status: 'starting' };
    operations.set(key(provider, id), op);
    let timer;
    const finish = (status, error = '') => {
      if (!['starting', 'pending'].includes(op.status)) return;
      clearTimeout(timer); op.status = status; op.error = error;
      if (typeof onSettled === 'function') Promise.resolve().then(() => onSettled(provider, id, status)).catch(() => {});
    };
    op.ready = (async () => {
      try {
        createSession('shell', 120, 30, undefined, { ...spec, sessionId: op.sessionId,
          onExit: ({ exitCode }) => finish(exitCode === 0 ? 'exited' : 'error', exitCode === 0 ? '' : 'Sign-in failed. Try again.'),
          onClosed: () => finish('error', 'Sign-in terminal closed. Try again.'),
        });
        let spawnTimer;
        try {
          await Promise.race([whenSpawned(op.sessionId), new Promise((_, reject) => {
            spawnTimer = setTimeout(() => reject(new Error('Terminal host did not respond')), 15000);
          })]);
        } finally { clearTimeout(spawnTimer); }
        if (op.status === 'starting') {
          op.status = 'pending';
          timer = setTimeout(() => { finish('error', 'Sign-in timed out. Try again.'); killSession(op.sessionId); }, timeoutMs);
          timer.unref?.();
        }
      } catch {
        finish('error', 'Could not open the sign-in terminal. Try again.');
        killSession(op.sessionId);
      }
    })();
    await op.ready;
    return snapshot(op);
  }
  return { start, read };
}

export function registerProviderPanelTerminalAuthRoutes(app, { guard, auth }) {
  const route = '/api/provider-panel-auth/:provider/:id/terminal';
  app.get(route, guard, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json({ terminal: auth.read(req.params.provider, req.params.id) }); }
    catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });
  app.post(route, guard, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (Object.keys(req.body || {}).length) return res.status(400).json({ error: 'Only provider and account selection are accepted.' });
    try { res.json({ terminal: await auth.start(req.params.provider, req.params.id) }); }
    catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });
}
