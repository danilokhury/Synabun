// SynaBun's own file, never Claude's native credential store. Atomic 0600 writes
// work on every supported platform without a Keychain prompt or service naming.
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateProviderApiKey, providerApiKeyError } from './provider-panel-api-key-auth.js';
export const CLAUDE_API_KEY_FILE = '.synabun-api-key';
// The same file holds an account's key for either provider (Claude: an
// Anthropic key in its CLAUDE_CONFIG_DIR; Codex: an OpenAI key in its
// CODEX_HOME, lib/codex-accounts.js), checked against that provider's format.
export function readProfileApiKey(home, provider = 'claude') {
  let fd;
  try {
    fd = openSync(join(home, CLAUDE_API_KEY_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe credential permissions');
    return validateProviderApiKey(provider, readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not read the saved API key. Sign in again.');
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function readClaudeProfileApiKey(home) { return readProfileApiKey(home, 'claude'); }
export function saveProfileApiKey(home, key, provider = 'claude') {
  key = validateProviderApiKey(provider, key);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = join(home, CLAUDE_API_KEY_FILE), temp = `${target}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, key, { mode: 0o600, flag: 'wx' }); renameSync(temp, target); }
  finally { rmSync(temp, { force: true }); }
}
export function saveClaudeProfileApiKey(home, key) { saveProfileApiKey(home, key, 'claude'); }
export function clearProfileApiKey(home) { rmSync(join(home, CLAUDE_API_KEY_FILE), { force: true }); }
export function clearClaudeProfileApiKey(home) { clearProfileApiKey(home); }
export async function verifyClaudeApiKey(key, fetchRequest = fetch) {
  let response;
  try {
    response = await fetchRequest('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
  } catch { throw providerApiKeyError('verification_unreachable'); }
  finally { key = null; }
  // Discard the body without letting a cleanup failure mask the HTTP result.
  // Neither provider response bodies nor exception text are surfaced or logged.
  try { await response.body?.cancel(); } catch {}
  if ([401, 403].includes(response.status)) throw providerApiKeyError('key_rejected');
  if (!response.ok) throw providerApiKeyError('verification_unavailable');
}

// OpenAI's read-only model list answers whether a key is accepted. The key goes
// in the Authorization header only; the body and any error text are dropped.
export async function verifyOpenAiApiKey(key, fetchRequest = fetch) {
  let response;
  try {
    response = await fetchRequest('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
  } catch { throw providerApiKeyError('verification_unreachable', 'codex'); }
  finally { key = null; }
  try { await response.body?.cancel(); } catch {}
  if ([401, 403].includes(response.status)) throw providerApiKeyError('key_rejected', 'codex');
  if (!response.ok) throw providerApiKeyError('verification_unavailable', 'codex');
}
