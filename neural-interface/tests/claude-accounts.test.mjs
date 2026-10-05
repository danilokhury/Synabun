import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createClaudeAccounts, ClaudeAccountError, readClaudeIdentity } from '../lib/claude-accounts.js';

function harness(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-claude-accounts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homeDir = resolve(root, 'home');
  const defaultHome = resolve(homeDir, '.claude');
  mkdirSync(resolve(defaultHome, 'commands'), { recursive: true });
  writeFileSync(resolve(defaultHome, 'settings.json'), '{"permissions":{}}');
  writeFileSync(resolve(defaultHome, 'CLAUDE.md'), '# rules');
  writeFileSync(resolve(defaultHome, '.claude.json'), JSON.stringify({
    mcpServers: { SynaBun: { type: 'http', url: 'http://localhost:3344/mcp' } },
    theme: 'dark',
    oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Org' },
    primaryApiKey: 'secret',
  }));
  const accounts = createClaudeAccounts({ dataHome: resolve(root, 'data-home'), homeDir, pollIntervalMs: 10 });
  return { root, homeDir, defaultHome, accounts };
}

test('default account reflects the ambient ~/.claude identity and never gets an env override', (t) => {
  const { accounts } = harness(t);
  const rows = accounts.listForClient();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'default');
  assert.equal(rows[0].email, 'me@example.com');
  assert.equal(rows[0].isDefault, true);
  assert.deepEqual(accounts.envFor('default'), {});
  assert.equal(accounts.homeFor('default'), null);
});

test('create seeds an isolated home with shared symlinks and a sanitized .claude.json', (t) => {
  const { accounts, defaultHome } = harness(t);
  const account = accounts.create({ label: 'Work' });
  assert.match(account.id, /^cacct-/);
  assert.equal(account.label, 'Work');
  assert.equal(account.loggedIn, false);
  assert.ok(existsSync(resolve(account.home, 'projects')));
  assert.ok(lstatSync(resolve(account.home, 'settings.json')).isSymbolicLink());
  assert.ok(lstatSync(resolve(account.home, 'commands')).isSymbolicLink());
  assert.ok(lstatSync(resolve(account.home, 'CLAUDE.md')).isSymbolicLink());
  assert.equal(existsSync(resolve(account.home, 'plugins')), false, 'missing shared items are skipped');
  const seeded = JSON.parse(readFileSync(resolve(account.home, '.claude.json'), 'utf8'));
  assert.equal(seeded.hasCompletedOnboarding, true);
  assert.equal(seeded.theme, 'dark');
  assert.deepEqual(Object.keys(seeded.mcpServers), ['SynaBun']);
  assert.equal(seeded.oauthAccount, undefined);
  assert.equal(seeded.primaryApiKey, undefined);
  assert.deepEqual(accounts.envFor(account.id), { CLAUDE_CONFIG_DIR: account.home });
  assert.deepEqual(accounts.loginCommand(account.id).env, { CLAUDE_CONFIG_DIR: account.home });
  assert.ok(account.seeded.linked.includes('settings.json'));
  // Re-seeding is idempotent.
  const again = accounts.seedHome(account.id);
  assert.deepEqual(again.linked, []);
  assert.equal(again.seededJson, false);
  assert.ok(existsSync(defaultHome));
});

test('rename, identity detection via watchLogin, and removal guards', async (t) => {
  const { accounts } = harness(t);
  const account = accounts.create({});
  assert.match(account.label, /^Claude \d+$/);
  accounts.rename(account.id, 'Personal');
  assert.equal(accounts.get(account.id).label, 'Personal');
  assert.throws(() => accounts.rename('default', 'x'), (e) => e instanceof ClaudeAccountError && e.code === 'DEFAULT_ACCOUNT');
  const logins = [];
  const stop = accounts.watchLogin(account.id, { onLogin: (identity) => logins.push(identity), timeoutMs: 5000 });
  t.after(stop);
  const claudeJson = resolve(account.home, '.claude.json');
  const current = JSON.parse(readFileSync(claudeJson, 'utf8'));
  writeFileSync(claudeJson, JSON.stringify({ ...current, oauthAccount: { emailAddress: 'work@example.com', organizationName: 'Acme' } }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(logins.length, 1);
  assert.equal(logins[0].email, 'work@example.com');
  assert.equal(accounts.get(account.id).email, 'work@example.com');
  assert.equal(accounts.get(account.id).loggedIn, true);
  assert.deepEqual(readClaudeIdentity(account.home), { email: 'work@example.com', organization: 'Acme', accountUuid: null });
  assert.throws(() => accounts.remove('default'), (e) => e.code === 'DEFAULT_ACCOUNT');
  assert.throws(() => accounts.remove(account.id, { inUse: () => 'busy with run 1' }), (e) => e.code === 'ACCOUNT_IN_USE' && e.status === 409);
  const removed = accounts.remove(account.id, { inUse: () => null });
  assert.equal(removed.removed, account.id);
  assert.equal(existsSync(account.home), false, 'home under the accounts root is deleted');
  assert.equal(accounts.get(account.id), null);
});
