const API_KEY_ERRORS = {
  invalid_key: { status: 400, message: "That doesn't look like an API key for this provider." },
  oauth_token: { status: 400, message: "That's a Claude sign-in token. Use Sign in with Claude." },
  key_rejected: { status: 401, message: 'The provider rejected that key.' },
  account_unavailable: { status: 404, message: 'This account is no longer available. Select an account again.' },
  account_busy: { status: 409, message: 'Finish sign-in or reconnect this account and try again.' },
  verification_unreachable: { status: 503, message: "Couldn't reach {vendor} to check the key. Try again." },
  verification_unavailable: { status: 503, message: "{vendor} couldn't check the key. Try again shortly." },
  storage_failed: { status: 500, message: "Couldn't save the key for this account." },
};
// `provider` names the vendor in the two verification messages (Anthropic for Claude, OpenAI for Codex).
export function providerApiKeyError(code, provider = 'claude') {
  const { status, message } = Object.hasOwn(API_KEY_ERRORS, code) ? API_KEY_ERRORS[code] : API_KEY_ERRORS.storage_failed;
  return Object.assign(new Error(message.replace('{vendor}', provider === 'codex' ? 'OpenAI' : 'Anthropic')), { status, code });
}

// Return the normalized value: clipboard padding is not part of a credential.
export function validateProviderApiKey(provider, key) {
  if (!['claude', 'codex'].includes(provider)) throw Object.assign(new Error('Unknown provider'), { status: 404 });
  if (typeof key !== 'string' || key.length > 4096) throw providerApiKeyError('invalid_key');
  key = key.trim();
  // setup-token produces an OAuth token, not an Anthropic API key. Never send
  // it to x-api-key or persist it under the API-key authentication method.
  if (provider === 'claude' && key.startsWith('sk-ant-oat01-')) throw providerApiKeyError('oauth_token');
  const pattern = provider === 'claude' ? /^sk-ant-[A-Za-z0-9_-]{16,}$/ : /^sk-(?!ant-)[A-Za-z0-9_-]{16,}$/;
  if (!pattern.test(key)) throw providerApiKeyError('invalid_key');
  return key;
}

// Defense in depth for native diagnostics/events. Never forward credential fields.
export function redactProviderSecrets(value) {
  if (typeof value === 'string') return value.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]');
  if (Array.isArray(value)) return value.map(redactProviderSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(api_?key|access_?token|refresh_?token|id_?token|authorization)$/i.test(key))
    .map(([key, item]) => [key, redactProviderSecrets(item)]));
  return value;
}

export function registerProviderPanelApiKeyAuthRoutes(app, { guard, claude, codex }) {
  app.post('/api/provider-panel-auth/:provider/:accountId/api-key', guard, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { provider, accountId } = req.params;
    let key = req.body?.key;
    // Express's parsed request body must not outlive this handler with a secret.
    if (req.body) delete req.body.key;
    try {
      key = validateProviderApiKey(provider, key);
      if (!/^[a-z0-9-]{1,64}$/.test(accountId)) throw providerApiKeyError('account_unavailable');
      // Codex keys are kept by SynaBun per account too (lib/codex-accounts.js): an older
      // page may still send the `target` of its live connection, which is not needed now.
      if (provider === 'claude') await claude(accountId, key);
      else await codex(accountId, key);
      res.json({ ok: true });
    } catch (error) {
      // Never serialize provider exceptions; a native error may echo its input.
      const fallback = { 400: 'invalid_key', 401: 'key_rejected', 404: 'account_unavailable', 409: 'account_busy', 503: 'verification_unavailable' }[error.status] || 'storage_failed';
      const code = Object.hasOwn(API_KEY_ERRORS, error.code) ? error.code : fallback;
      const safe = providerApiKeyError(code, provider);
      res.status(safe.status).json({ code, error: safe.message });
    } finally { key = null; }
  });
}

// Install immediately after the global JSON parser: its SyntaxError may contain
// a fragment of the secret-bearing body. Never pass that error to Express logs.
export function providerApiKeyBodyError(error, req, res, next) {
  if (req.method !== 'POST' || !/^\/api\/provider-panel-auth\/[^/]+\/[^/]+\/api-key(?:\?|$)/.test(req.originalUrl || req.url || '')) return next(error);
  delete error.body;
  req.body = undefined;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(error.status === 413 ? 413 : 400).json({ code: 'invalid_key', error: API_KEY_ERRORS.invalid_key.message });
}

// Native stderr arrives in arbitrary chunks. Redact complete lines so a split
// credential cannot leave an unmasked suffix; omit unterminated/oversized lines.
export function providerDiagnosticSink(write, maxChars = 65536) {
  let buffer = '', dropping = false;
  return chunk => {
    const parts = String(chunk).split(/\r?\n/);
    for (let i = 0; i < parts.length; i++) {
      if (!dropping) {
        buffer += parts[i];
        if (buffer.length > maxChars) { buffer = ''; dropping = true; }
      }
      if (i < parts.length - 1) {
        if (!dropping && buffer.trim()) write(redactProviderSecrets(buffer.trim()));
        buffer = ''; dropping = false;
      }
    }
  };
}
