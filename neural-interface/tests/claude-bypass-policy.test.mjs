import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BYPASS_ROOT_REASON, bypassVerdict, resolveBypassPolicy, rootBypassBlock } from '../lib/claude-bypass-policy.js';
import { configureClaudeBridge, panelCapabilities } from '../lib/claude-agent-bridge.js';

// Whether a sidepanel tab may be put in Bypass, answered ahead of time so the
// panel can show the option as unavailable with the reason. Claude Code is what
// enforces it; this only has to say the same thing.

const DISABLE = { permissions: { disableBypassPermissionsMode: 'disable' } };
const fromSources = (...rows) => ({ effective: {}, sources: rows.map(([source, settings, p]) => ({ source, settings, ...(p ? { path: p } : {}) })) });

test('Claude Code refuses Bypass as root outside a sandbox, and only there', () => {
  assert.equal(rootBypassBlock({ platform: 'linux', getuid: () => 0, env: {} }), BYPASS_ROOT_REASON);
  assert.equal(rootBypassBlock({ platform: 'darwin', getuid: () => 0, env: { IS_SANDBOX: '0' } }), BYPASS_ROOT_REASON);
  assert.equal(rootBypassBlock({ platform: 'linux', getuid: () => 0, env: { IS_SANDBOX: '1' } }), '');
  assert.equal(rootBypassBlock({ platform: 'linux', getuid: () => 501, env: {} }), '');
  assert.equal(rootBypassBlock({ platform: 'win32', getuid: undefined, env: {} }), '');
  assert.equal(rootBypassBlock({ platform: 'win32', getuid: () => 0, env: {} }), '', 'Windows has no such check');
});

test('a setting that turns Bypass off in any settings file makes it unavailable, with the file named', () => {
  assert.deepEqual(bypassVerdict({ resolved: fromSources(['user', { model: 'opus' }]) }), { available: true, source: '', reason: '' });
  assert.deepEqual(bypassVerdict({}), { available: true, source: '', reason: '' });

  const user = bypassVerdict({ resolved: fromSources(['user', DISABLE, '/home/me/.claude/settings.json']) });
  assert.equal(user.available, false);
  assert.equal(user.source, 'user');
  assert.match(user.reason, /turned off by your Claude Code settings \(permissions\.disableBypassPermissionsMode in \/home\/me\/\.claude\/settings\.json\)/);

  const project = bypassVerdict({ resolved: fromSources(['user', {}], ['project', DISABLE, '/p/.claude/settings.json'], ['local', {}]) });
  assert.equal(project.source, 'project');
  assert.match(project.reason, /this project's settings/);

  // The highest tier that says it is the one named.
  const managed = bypassVerdict({ resolved: fromSources(['user', DISABLE, '/u'], ['managed', DISABLE]) });
  assert.equal(managed.source, 'managed');
  assert.match(managed.reason, /a managed policy \(permissions\.disableBypassPermissionsMode\)/);

  // Only the exact value counts, as in Claude Code's schema.
  for (const value of [true, 'enable', 'disabled', '', null]) {
    assert.equal(bypassVerdict({ resolved: fromSources(['user', { permissions: { disableBypassPermissionsMode: value } }]) }).available, true, String(value));
  }
  // A merged view that says so without a source list is believed too.
  assert.equal(bypassVerdict({ resolved: { effective: DISABLE } }).available, false);
  // Root wins over everything, and says root.
  assert.deepEqual(bypassVerdict({ root: BYPASS_ROOT_REASON, resolved: fromSources(['user', {}]) }), { available: false, source: 'root', reason: BYPASS_ROOT_REASON });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'bypass-policy-'));
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const accounts = path.join(root, 'accounts');
  const mk = (name) => { const dir = path.join(accounts, name); mkdirSync(dir, { recursive: true }); return dir; };
  return { root, home, mk, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the default account and a project are resolved with the SDK, project and local files included', async () => {
  const s = scratch();
  try {
    const calls = [];
    const resolveSettings = async (opts) => { calls.push(opts); return fromSources(['user', {}], ['local', DISABLE, '/p/.claude/settings.local.json']); };
    const policy = await resolveBypassPolicy({ resolveSettings, project: '/p', home: s.home, root: '' });
    assert.deepEqual(calls, [{ cwd: '/p' }], 'every source the session loads');
    assert.equal(policy.available, false);
    assert.equal(policy.source, 'local');
    assert.equal(policy.checked, true);

    // Without a project only the user's own settings are read (never the server's working directory).
    calls.length = 0;
    const none = await resolveBypassPolicy({ resolveSettings: async (opts) => { calls.push(opts); return fromSources(['user', {}]); }, home: s.home, root: '' });
    assert.deepEqual(calls, [{ settingSources: ['user'] }]);
    assert.deepEqual(none, { available: true, source: '', reason: '', checked: true });
  } finally { s.done(); }
});

test('a named account with its own settings file is judged by that file, not by the default account\'s', async () => {
  const s = scratch();
  try {
    writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify(DISABLE));
    const own = s.mk('work');
    writeFileSync(path.join(own, 'settings.json'), JSON.stringify({ model: 'opus' }));
    const calls = [];
    // The SDK would report the default account's user tier: it must not be asked for it.
    const resolveSettings = async (opts) => { calls.push(opts); return fromSources(...(opts.settingSources?.includes('user') || !opts.settingSources ? [['user', DISABLE, 'default-user']] : [])); };
    const free = await resolveBypassPolicy({ resolveSettings, project: '/p', home: s.home, accountHome: own, root: '' });
    assert.deepEqual(calls, [{ cwd: '/p', settingSources: ['project', 'local'] }]);
    assert.equal(free.available, true, 'the default account turning Bypass off says nothing about this one');

    writeFileSync(path.join(own, 'settings.json'), JSON.stringify(DISABLE));
    const off = await resolveBypassPolicy({ resolveSettings, project: '', home: s.home, accountHome: own, root: '' });
    assert.deepEqual(calls.at(-1), { settingSources: [] }, 'the policy tier is still read');
    assert.equal(off.available, false);
    assert.match(off.reason, new RegExp(`in ${path.join(own, 'settings.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    // An account that shares the default account's file (SynaBun's link) is the default tier.
    const shared = s.mk('linked');
    symlinkSync(path.join(s.home, '.claude', 'settings.json'), path.join(shared, 'settings.json'));
    calls.length = 0;
    const viaLink = await resolveBypassPolicy({ resolveSettings, project: '/p', home: s.home, accountHome: shared, root: '' });
    assert.deepEqual(calls, [{ cwd: '/p' }]);
    assert.equal(viaLink.available, false);
    assert.equal(viaLink.source, 'user');
  } finally { s.done(); }
});

test('settings that cannot be read claim nothing: the option stays offered and says it was not checked', async () => {
  const s = scratch();
  try {
    const broken = await resolveBypassPolicy({ resolveSettings: async () => { throw new Error('managed settings invalid'); }, project: '/p', home: s.home, root: '' });
    assert.deepEqual(broken, { available: true, source: '', reason: '', checked: false });
    const noSdk = await resolveBypassPolicy({ project: '/p', home: s.home, root: '' });
    assert.equal(noSdk.checked, false);
    const own = s.mk('broken');
    writeFileSync(path.join(own, 'settings.json'), '{ not json');
    const unparsed = await resolveBypassPolicy({ resolveSettings: async () => fromSources(), home: s.home, accountHome: own, root: '' });
    assert.deepEqual(unparsed, { available: true, source: '', reason: '', checked: false });
    // Root needs no settings at all.
    const root = await resolveBypassPolicy({ resolveSettings: async () => { throw new Error('never asked'); }, home: s.home, root: BYPASS_ROOT_REASON });
    assert.deepEqual(root, { available: false, source: 'root', reason: BYPASS_ROOT_REASON, checked: true });
  } finally { s.done(); }
});

test('the route exists where the capability says so, and the bridge shares the root check', async () => {
  configureClaudeBridge({ bypassPolicy: true });
  assert.ok(panelCapabilities().includes('bypass_policy'));
  configureClaudeBridge({});
  assert.equal(panelCapabilities().includes('bypass_policy'), false, 'a host without the route does not claim it');
  assert.ok(panelCapabilities().includes('bypass_mode'), 'the mode itself is the bridge\'s own');

  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /bypassPolicy: true,/);
  const route = server.slice(server.indexOf("app.get('/api/claude-code/bypass-policy'"));
  assert.ok(route.length > 100);
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /loadHookProjects\(\)\.some\(p => resolve\(p\.path\) === resolve\(requested\)\)/, 'only a registered project\'s settings are read');
  assert.match(body, /panelAccountHome\(req\.query\.account\)/);
  assert.match(body, /resolveBypassPolicy\(\{ resolveSettings: sdk\.resolveSettings, project, home: [^,]+, accountHome \}\)/);
  assert.ok(server.includes("'/api/claude-code', '/api/mcp-key'"), 'under the admin-only prefix');
  const bridge = await readFile(new URL('../lib/claude-agent-bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /import \{ rootBypassBlock \} from '\.\/claude-bypass-policy\.js';/);
});
