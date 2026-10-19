// Saved routes name stable account ids. Labels and credential state are read live.
export const hasRouteAccounts = provider => provider === 'claude-code' || provider === 'codex';

export function routeAccountText(target, { accounts = {}, brain = {}, workers = {} } = {}) {
  if (!hasRouteAccounts(target?.provider)) return '';
  const direct = target.kind === 'direct' && target.provider === brain.provider;
  if (target.accountId === 'auto') return 'Auto · most usage left (signed-in subscriptions only)';
  const id = target.accountId || (direct ? brain.accountId || 'default' : workers[target.provider] || null);
  if (!id) return 'workers default';
  const row = (accounts[target.provider] || []).find(a => a.id === id);
  if (!row) return `${id} · account removed`;
  const mode = row.signedIn === false ? 'signed out' : row.mode === 'apiKey' ? 'API key' : target.provider === 'codex' ? 'ChatGPT account' : 'Claude account';
  return `${row.label || row.id} · ${mode}`;
}
