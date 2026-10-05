import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  LEVELS, brainCapsLevel, clampBrainModes, clampDispatchSpec, clampRouteMode, createRemotePolicyRegistry, effectiveLevel,
  isComputerTool, isDeniedRemoteTool, remoteBrainLimited, remoteBrainNotice, remoteCwdAllowed, remoteToolDenial, requiresHumanApproval, runExceedsPolicy,
  COMPUTER_REASONS, COMPUTER_STATES, COMPUTER_SWITCH_PATH, remoteComputerDenial, remoteComputerUse,
} from '../lib/remote-policy.js';

process.env.SYNABUN_TYPESAFE = 'off';

const HOME = '/Users/owner';
const PATHS = { home: HOME, dataHome: `${HOME}/.synabun`, waHome: null, env: {} };
const denied = (tool, input) => isDeniedRemoteTool(tool, input, PATHS);

test('levels: paused reads as read-only, an expired or unarmed autonomous window as ask, untrusted caps at ask', () => {
  assert.deepEqual([...LEVELS], ['read-only', 'ask', 'autonomous']);
  const t = 1_000_000;
  assert.equal(effectiveLevel(null), null);
  assert.equal(effectiveLevel({ level: 'ask' }, { now: t }), 'ask');
  assert.equal(effectiveLevel({ level: 'nonsense' }, { now: t }), 'read-only', 'an unknown level fails closed');
  assert.equal(effectiveLevel({ level: 'autonomous', autonomousUntil: t + 1 }, { now: t }), 'autonomous');
  assert.equal(effectiveLevel({ level: 'autonomous', autonomousUntil: t - 1 }, { now: t }), 'ask', 'expired → ask');
  assert.equal(effectiveLevel({ level: 'autonomous' }, { now: t }), 'ask', 'never armed → ask');
  assert.equal(effectiveLevel({ level: 'autonomous', autonomousUntil: t + 1 }, { now: t, untrusted: true }), 'ask');
  assert.equal(effectiveLevel({ level: 'read-only' }, { now: t, untrusted: true }), 'read-only');
  assert.equal(effectiveLevel({ level: 'autonomous', autonomousUntil: t + 1, paused: true }, { now: t }), 'read-only');
});

test('clampBrainModes: read-only forces plan mode (a desktop-approved plan may run), ask forces default, autonomous keeps', () => {
  const t = 5;
  const modes = { permissionMode: 'bypassPermissions', planMode: false };
  assert.deepEqual(clampBrainModes(null, modes), modes);
  assert.deepEqual(clampBrainModes({ level: 'read-only' }, modes), { permissionMode: 'default', planMode: true });
  assert.deepEqual(clampBrainModes({ level: 'read-only' }, modes, { planApproved: true }), { permissionMode: 'default', planMode: false });
  assert.deepEqual(clampBrainModes({ level: 'ask' }, { permissionMode: 'acceptEdits', planMode: true }), { permissionMode: 'default', planMode: true });
  assert.deepEqual(clampBrainModes({ level: 'ask' }, { permissionMode: 'auto' }), { permissionMode: 'default', planMode: false }, 'Codex/OpenCode auto-accept too');
  assert.deepEqual(clampBrainModes({ level: 'autonomous', autonomousUntil: t + 1 }, modes, { now: t }), modes);
  assert.deepEqual(clampBrainModes({ level: 'autonomous', autonomousUntil: t + 1 }, modes, { now: t, untrusted: true }), { permissionMode: 'default', planMode: false });
  assert.deepEqual(clampBrainModes({ level: 'ask' }, { permissionMode: 'plan' }), { permissionMode: 'default', planMode: true }, 'legacy plan mode');
});

test('route mode: every task is approved on a route card below autonomous', () => {
  assert.equal(clampRouteMode(null, 'never'), 'never');
  assert.equal(clampRouteMode({ level: 'ask' }, 'never'), 'always-ask');
  assert.equal(clampRouteMode({ level: 'read-only' }, 'ask-unsure'), 'always-ask');
  assert.equal(clampRouteMode({ level: 'autonomous', autonomousUntil: 10 }, 'never', { now: 5 }), 'never');
  assert.equal(requiresHumanApproval({ level: 'ask', strictWorkerApprovals: true }), true);
  assert.equal(requiresHumanApproval({ level: 'ask' }), false);
  assert.equal(requiresHumanApproval({ level: 'autonomous', autonomousUntil: 10, strictWorkerApprovals: true }, { now: 5 }), false);
});

test('clampDispatchSpec matrix: per level and provider', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-remote-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = resolve(root, 'home');
  const project = resolve(home, 'code', 'app');
  mkdirSync(project, { recursive: true });
  const projects = [project, home];
  const opts = (extra = {}) => ({ registeredProjects: projects, home, now: 5, ...extra });
  const base = { provider: 'claude-code', task: 'x', cwd: project, usesComputer: 'true', tags: ['user-authorized-full', 'keep'], capability: 'full', permissionPolicy: 'auto' };

  assert.throws(() => clampDispatchSpec({ level: 'read-only' }, base, opts()), (e) => e.code === 'REMOTE_READ_ONLY' && e.status === 409);
  assert.throws(() => clampDispatchSpec({ level: 'ask', paused: true }, base, opts()), (e) => e.code === 'REMOTE_READ_ONLY', 'paused = read-only');

  const notes = [];
  const ask = clampDispatchSpec({ level: 'ask' }, base, opts({ notes }));
  assert.equal(ask.usesComputer, false, 'no computer use (the string "true" too)');
  assert.deepEqual(ask.tags, ['keep'], 'user-authorized-full dropped');
  assert.equal(ask.permissionPolicy, 'auto', 'strict approvals off: the policy stays');
  assert.ok(notes.length >= 2);

  const strictClaude = clampDispatchSpec({ level: 'ask', strictWorkerApprovals: true }, base, opts());
  assert.equal(strictClaude.permissionPolicy, 'ask');
  assert.equal(strictClaude.capability, 'full');
  const strictCodex = clampDispatchSpec({ level: 'ask', strictWorkerApprovals: true }, { ...base, provider: 'codex' }, opts());
  assert.deepEqual([strictCodex.capability, strictCodex.permissionPolicy], ['read-only', 'restricted'], 'Codex has no approval channel');
  const strictOpenCode = clampDispatchSpec({ level: 'ask', strictWorkerApprovals: true }, { ...base, provider: 'opencode' }, opts());
  assert.equal(strictOpenCode.permissionPolicy, 'ask');

  assert.throws(() => clampDispatchSpec({ level: 'ask' }, { ...base, cwd: home }, opts()), (e) => e.code === 'REMOTE_CWD_NOT_ALLOWED', 'never $HOME, registered or not');
  assert.throws(() => clampDispatchSpec({ level: 'ask' }, { ...base, cwd: resolve(root, 'elsewhere') }, opts()), (e) => e.code === 'REMOTE_CWD_NOT_ALLOWED');
  assert.throws(() => clampDispatchSpec({ level: 'ask' }, { ...base, cwd: '' }, opts({ defaultCwd: resolve(root, 'pkg') })), (e) => e.code === 'REMOTE_CWD_NOT_ALLOWED', 'the default cwd is checked too');
  assert.equal(clampDispatchSpec({ level: 'ask' }, { ...base, cwd: resolve(project, 'src') }, opts()).cwd, resolve(project, 'src'), 'inside a registered project');

  const auto = clampDispatchSpec({ level: 'autonomous', autonomousUntil: 10, strictWorkerApprovals: true }, { ...base, cwd: home }, opts());
  assert.equal(auto.usesComputer, false, 'autonomous: still no computer use');
  assert.deepEqual(auto.tags, base.tags, 'autonomous keeps the rest');
  assert.equal(auto.cwd, home);
  const expired = () => clampDispatchSpec({ level: 'autonomous', autonomousUntil: 1 }, { ...base, cwd: home }, opts());
  assert.throws(expired, (e) => e.code === 'REMOTE_CWD_NOT_ALLOWED', 'an expired window is ask again');
  assert.equal(clampDispatchSpec(null, base, opts()), base, 'no policy: untouched');

  assert.equal(remoteCwdAllowed('relative/path', projects, { home }), false);
  assert.equal(remoteCwdAllowed('/', [resolve('/')], { home }), false, 'a parent of $HOME never counts');
});

test('runExceedsPolicy: what a lowered level stops', () => {
  const projects = ['/work/app'];
  const home = '/Users/owner';
  const run = { provider: 'claude-code', cwd: '/work/app', tags: [], permissionPolicy: 'auto', capability: 'full', usesComputer: false };
  assert.equal(runExceedsPolicy({ level: 'read-only' }, run, { registeredProjects: projects, home }), true);
  assert.equal(runExceedsPolicy({ level: 'ask' }, run, { registeredProjects: projects, home }), false);
  assert.equal(runExceedsPolicy({ level: 'ask' }, { ...run, usesComputer: true }, { registeredProjects: projects, home }), true);
  assert.equal(runExceedsPolicy({ level: 'ask' }, { ...run, tags: ['user-authorized-full'] }, { registeredProjects: projects, home }), true);
  assert.equal(runExceedsPolicy({ level: 'ask' }, { ...run, cwd: '/tmp/x' }, { registeredProjects: projects, home }), true);
  assert.equal(runExceedsPolicy({ level: 'ask', strictWorkerApprovals: true }, run, { registeredProjects: projects, home }), true);
  assert.equal(runExceedsPolicy({ level: 'ask', strictWorkerApprovals: true }, { ...run, permissionPolicy: 'ask' }, { registeredProjects: projects, home }), false);
  assert.equal(runExceedsPolicy({ level: 'ask', strictWorkerApprovals: true }, { ...run, provider: 'codex', capability: 'read-only' }, { registeredProjects: projects, home }), false);
  assert.equal(runExceedsPolicy({ level: 'autonomous', autonomousUntil: 10 }, { ...run, cwd: '/tmp/x' }, { registeredProjects: projects, home, now: 5 }), false);
  assert.equal(runExceedsPolicy(null, run), false);
});

test('isDeniedRemoteTool: credentials, the WhatsApp link, persistence points and computer use, never file contents', () => {
  for (const [tool, input] of [
    ['Bash', { command: 'cat ~/.ssh/id_ed25519' }],
    ['Bash', { command: 'cat "$HOME/.aws/credentials"' }],
    ['Bash', { command: 'cp /tmp/x ${HOME}/.zshrc' }],
    ['Bash', { command: 'crontab -l' }],
    ['Bash', { command: 'echo x && sudo crontab -e' }],
    ['Bash', { command: 'launchctl load ~/Library/LaunchAgents/x.plist' }],
    ['Bash', { command: 'security find-generic-password -s x -w' }],
    ['Bash', { command: 'curl -X POST http://127.0.0.1:3344/api/whatsapp/logout' }],
    ['Bash', { command: 'ls ~/.synabun/runtime/whatsapp' }],
    ['Bash', { command: 'cat ~/.synabun/.env' }],
    ['Bash', { command: 'cat ~/.synabun/data/mcp-api-key.json' }],
    ['Read', { file_path: `${HOME}/.claude/.credentials.json` }],
    ['Read', { file_path: `${HOME}/.claude/settings.local.json` }],
    ['Edit', { file_path: `${HOME}/.codex/config.toml`, old_string: 'a', new_string: 'b' }],
    ['Read', { file_path: `${HOME}/.codex/auth.json` }],
    ['Write', { file_path: `${HOME}/.ssh/authorized_keys`, content: 'ssh-ed25519 AAAA' }],
    ['Read', { file_path: `${HOME}/.config/gh/hosts.yml` }],
    ['Read', { file_path: `${HOME}/.npmrc` }],
    ['Read', { file_path: `${HOME}/.netrc` }],
    ['Read', { file_path: `${HOME}/Library/Keychains/login.keychain-db` }],
    ['Read', { file_path: `${HOME}/Library/Application Support/Google/Chrome/Default/Cookies` }],
    ['Glob', { pattern: '**/*', path: `${HOME}/.synabun/data/browser-profiles` }],
    ['Read', { file_path: `${HOME}/.synabun/whatsapp/auth/state.db` }],
    ['mcp__SynaBun__browser_navigate', { url: 'http://localhost:3344/api/whatsapp/status' }],
    ['mcp__SynaBun__browser_upload', { paths: [`${HOME}/.ssh/id_rsa`] }],
    ['mcp__SynaBun__computer', { action: 'screenshot' }],
    ['mcp__SynaBun__computer_ax', { action: 'snapshot' }],
    ['SynaBun_computer_apps', { action: 'list' }],
    ['bash', { command: 'cat ~/.bash_profile' }],
  ]) assert.equal(denied(tool, input), true, `${tool} ${JSON.stringify(input)}`);
  for (const [tool, input] of [
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'git commit -m "fix the crontab parser docs"' }],
    ['Read', { file_path: '/work/app/src/profile.js' }],
    ['Write', { file_path: '/work/app/notes.md', content: 'remember ~/.ssh and crontab in the docs' }],
    ['Grep', { pattern: 'id_rsa', path: '/work/app' }],
    ['mcp__SynaBun__remember', { content: 'The user keeps SSH keys in ~/.ssh; crontab runs backups.' }],
    ['mcp__SynaBun__browser_navigate', { url: 'https://example.com/docs/cron' }],
    ['mcp__OtherServer__computer_like', {}],
  ]) assert.equal(denied(tool, input), false, `${tool} ${JSON.stringify(input)}`);
  assert.equal(denied('mcp__SynaBun__computer_anything_new', {}), true, 'every mcp__SynaBun__computer* tool');
  assert.match(remoteToolDenial('Bash', { command: 'cat ~/.ssh/config' }, PATHS), /SSH keys/);
  assert.equal(isComputerTool('mcp__SynaBun__computer_status'), true);
  // SYNABUN_WHATSAPP_HOME moves the link's home: still refused there.
  assert.equal(isDeniedRemoteTool('Read', { file_path: '/Volumes/secure/wa/auth/state.db' }, { ...PATHS, env: { SYNABUN_WHATSAPP_HOME: '/Volumes/secure/wa' } }), true);
});

test('isDeniedRemoteTool (speed bump): the obvious spellings of the WhatsApp login, its runtime and SynaBun\'s own state', () => {
  const dataHome = `${HOME}/.synabun`;
  for (const [tool, input, paths] of [
    // absolute, ~, $HOME, ${HOME}, quoted and dot-segment forms of the session keys
    ['Bash', { command: `sqlite3 ${HOME}/.synabun/whatsapp/auth/state.db .dump` }],
    ['Bash', { command: 'cat "$HOME"/.synabun/whatsapp/auth/state.db' }],
    ['Bash', { command: 'cp ${HOME}/.synabun/whatsapp/auth/state.db /tmp/x' }],
    ['Bash', { command: `ls ${HOME}/.synabun/data/../whatsapp/auth` }],
    ['Bash', { command: 'ls ~/.syna"bun"/whats\'app\'/auth' }],
    ['Bash', { command: 'ls ~/.synabun/whats\\app/auth' }],
    ['Bash', { command: 'cd ~/.synabun && sqlite3 whatsapp/auth/state.db' }],
    ['Bash', { command: 'cd /tmp && cp state.db-wal /tmp/y' }],
    ['Read', { file_path: '/Volumes/work/sb/whatsapp/auth/state.db-shm' }],
    // the connector runtime and its staging folder, the config row that holds the level
    ['Bash', { command: `rm -rf ${HOME}/.synabun/runtime/whatsapp.staging` }],
    ['Bash', { command: "sqlite3 ~/.synabun/mcp-data/memory.db \"update kv_config set value='x' where key='whatsapp_config'\"" }],
    ['Bash', { command: 'echo [] > ~/.synabun/data/claude-code-projects.json' }],
    // OpenCode's own argument names (filePath) and camelCase keys of other tools
    ['read', { filePath: `${HOME}/.ssh/id_ed25519` }],
    ['edit', { filePath: `${HOME}/.zshrc`, oldString: 'a', newString: 'b' }],
    ['mcp__Other__upload', { localFilePath: `${HOME}/.aws/credentials` }],
    // a custom data home and a Windows-style LOCALAPPDATA session
    ['Read', { file_path: '/data/sb/whatsapp/auth/keys.json' }, { home: HOME, dataHome: '/data/sb', env: {} }],
    ['Bash', { command: 'type %LOCALAPPDATA%\\synabun\\whatsapp\\auth\\state.db' }],
  ]) assert.equal(isDeniedRemoteTool(tool, input, paths || { home: HOME, dataHome, env: {} }), true, `${tool} ${JSON.stringify(input)}`);
  // An override refused by paths.js (inside a backed-up folder) leaves the session at the default place: still protected.
  const refused = { home: HOME, dataHome, env: { SYNABUN_WHATSAPP_HOME: `${dataHome}/mcp-data/wa` } };
  assert.equal(isDeniedRemoteTool('Read', { file_path: `${dataHome}/whatsapp/auth/keys.json` }, refused), true);
  // A value too long to check in full is refused, not checked on its first part only.
  assert.equal(isDeniedRemoteTool('Bash', { command: `${' '.repeat(20_050)}cat ~/.ssh/id_rsa` }, PATHS), true);
  for (const [tool, input] of [
    ['Bash', { command: 'npm test' }],
    ['Read', { file_path: '/work/app/src/state.js' }],
    ['read', { filePath: '/work/app/README.md' }],
    ['mcp__SynaBun__remember', { content: 'the WhatsApp session lives in state.db under whatsapp/auth' }],
  ]) assert.equal(denied(tool, input), false, `${tool} ${JSON.stringify(input)}`);
});

test('Ask and Autonomous hold on a Claude brain only: a Codex or OpenCode brain makes the session read-only', (t) => {
  const t0 = 1_000;
  const auto = { level: 'autonomous', autonomousUntil: t0 + 10 };
  assert.equal(effectiveLevel({ level: 'ask' }, { provider: 'codex' }), 'read-only');
  assert.equal(effectiveLevel({ level: 'ask' }, { provider: 'opencode' }), 'read-only');
  assert.equal(effectiveLevel(auto, { now: t0, provider: 'opencode' }), 'read-only');
  assert.equal(effectiveLevel(auto, { now: t0, provider: 'claude-code' }), 'autonomous');
  assert.equal(effectiveLevel({ ...auto, brainProvider: 'codex' }, { now: t0 }), 'read-only', 'the registry carries the brain');
  assert.equal(effectiveLevel({ level: 'ask', brainProvider: 'claude-code' }), 'ask');
  assert.equal(effectiveLevel({ level: 'ask' }), 'ask', 'no brain known: the level as configured');
  assert.equal(brainCapsLevel({ level: 'ask', brainProvider: 'codex' }), true);
  assert.equal(brainCapsLevel({ level: 'read-only', brainProvider: 'codex' }), false, 'read-only anyway');
  assert.equal(brainCapsLevel({ level: 'ask', brainProvider: 'claude-code' }), false);
  assert.equal(remoteBrainLimited('codex'), true);
  assert.equal(remoteBrainLimited('claude-code'), false);
  assert.equal(remoteBrainNotice('codex'), 'This conversation runs read-only because its brain is Codex; switch the WhatsApp brain to Claude for Ask/Autonomous.');
  assert.equal(remoteBrainNotice('opencode'), 'This conversation runs read-only because its brain is OpenCode; switch the WhatsApp brain to Claude for Ask/Autonomous.');
  // What follows from read-only: plan mode, always-ask routing, no workers.
  assert.deepEqual(clampBrainModes({ level: 'ask', brainProvider: 'codex' }, { permissionMode: 'auto', planMode: false }), { permissionMode: 'default', planMode: true });
  assert.equal(clampRouteMode({ ...auto, brainProvider: 'opencode' }, 'never', { now: t0 }), 'always-ask');
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-remote-brain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => clampDispatchSpec({ level: 'ask', brainProvider: 'codex' }, { provider: 'claude-code', cwd: root }, { registeredProjects: [root], home: resolve(root, 'home') }),
    (e) => e.code === 'REMOTE_READ_ONLY' && /its brain is Codex/.test(e.message) && /switch the WhatsApp brain to Claude/.test(e.message));
  assert.equal(runExceedsPolicy({ level: 'ask', brainProvider: 'opencode' }, { provider: 'claude-code', cwd: root, tags: [] }, { registeredProjects: [root] }), true, 'a switch to such a brain stops the runs');
});

test('a call whose arguments the host did not pass is refused, except SynaBun\'s own coordination tools', () => {
  const paths = { ...PATHS, argsComplete: false };
  assert.match(remoteToolDenial('Read', { file_path: '/work/app/a.js' }, paths), /could not see this call's arguments/);
  assert.match(remoteToolDenial('mcp__Other__fetch', {}, paths), /could not see/);
  assert.equal(remoteToolDenial('mcp__SynaBun__recall', {}, paths), null, 'memory and agent_* tools need no arguments checked');
  assert.equal(remoteToolDenial('SynaBun_agent_route', {}, paths), null);
  // Missing even though the host said it passed them: a shell or file tool without its target.
  assert.match(remoteToolDenial('Bash', {}, PATHS), /could not see/);
  assert.match(remoteToolDenial('Bash', { description: 'list files' }, PATHS), /could not see/);
  assert.match(remoteToolDenial('read', { offset: 1 }, PATHS), /could not see/);
  assert.match(remoteToolDenial('Write', null, PATHS), /could not see/);
  assert.equal(remoteToolDenial('Grep', { pattern: 'x' }, PATHS), null, 'a search without a path runs in its folder');
  assert.equal(remoteToolDenial('Bash', { command: 'npm test' }, PATHS), null);
});

test('registry: the session\'s brain rides on its policy (and survives a re-registration)', () => {
  const registry = createRemotePolicyRegistry({ now: () => 7 });
  const events = [];
  registry.subscribe((e) => events.push([e.sessionId, e.policy?.brainProvider ?? null]));
  registry.registerSessionPolicy('s1', { level: 'ask' });
  assert.equal(registry.getSessionPolicy('s1').brainProvider, null);
  registry.setSessionBrain('s1', 'codex');
  assert.equal(registry.getSessionPolicy('s1').brainProvider, 'codex');
  assert.equal(effectiveLevel(registry.getSessionPolicy('s1')), 'read-only');
  registry.registerSessionPolicy('s1', { level: 'autonomous', autonomousUntil: '2099-01-01T00:00:00Z' });
  assert.equal(registry.getSessionPolicy('s1').brainProvider, 'codex', 'the bridge re-registering does not forget the brain');
  registry.setSessionBrain('s1', 'codex');
  assert.equal(events.filter(([, p]) => p === 'codex').length, 2, 'setting the same brain again notifies nobody');
  registry.setSessionBrain('s1', 'claude-code');
  assert.equal(effectiveLevel(registry.getSessionPolicy('s1')), 'autonomous');
  registry.setSessionBrain('s2', 'opencode');
  assert.equal(registry.getSessionPolicy('s2'), null, 'a desktop session has no policy, brain or not');
  registry.markRemote('s2');
  assert.equal(registry.getSessionPolicy('s2').brainProvider, 'opencode');
  registry.forgetSession('s1');
  registry.markRemote('s1');
  assert.equal(registry.getSessionPolicy('s1').brainProvider, null, 'forget drops the brain too');
});

test('registry: register, change listeners, clear falls back to read-only for a flagged session, forget drops it', () => {
  const registry = createRemotePolicyRegistry({ now: () => 42 });
  const events = [];
  registry.subscribe((e) => events.push([e.sessionId, e.policy?.level, e.previous?.level || null]));
  assert.equal(registry.getSessionPolicy('s1'), null);
  const p = registry.registerSessionPolicy('s1', { level: 'ask', strictWorkerApprovals: true });
  assert.equal(p.level, 'ask');
  assert.equal(p.strictWorkerApprovals, true);
  assert.equal(registry.isRemote('s1'), true);
  registry.registerSessionPolicy('s1', { level: 'autonomous', autonomousUntil: '2099-01-01T00:00:00Z' });
  assert.equal(registry.getSessionPolicy('s1').autonomousUntil, Date.parse('2099-01-01T00:00:00Z'));
  assert.equal(registry.clearSessionPolicy('s1'), true);
  const fallback = registry.getSessionPolicy('s1');
  assert.equal(fallback.level, 'read-only');
  assert.equal(fallback.failClosed, true);
  assert.deepEqual(events, [['s1', 'ask', null], ['s1', 'autonomous', 'ask'], ['s1', 'read-only', 'autonomous']]);
  registry.markRemote('s2');
  assert.equal(registry.getSessionPolicy('s2').level, 'read-only', 'flagged at load, nobody registered it again');
  registry.forgetSession('s2');
  assert.equal(registry.getSessionPolicy('s2'), null);
  assert.equal(registry.registerSessionPolicy('s3', { level: 'bogus' }).level, 'read-only');
  assert.throws(() => registry.registerSessionPolicy('', {}), (e) => e.code === 'SESSION_REQUIRED');
});

// ── computer use: the one place that decides ─────────────────────────────────

test('remoteComputerUse: switch × level × paused × untrusted × brain, with the reason', () => {
  const now = 1_000_000;
  const READY = { supported: true, ready: true };
  // level name → the policy fields; effective → what effectiveLevel says for a trusted turn on Claude.
  const LEVEL_ROWS = {
    'read-only': { level: 'read-only', autonomousUntil: null },
    ask: { level: 'ask', autonomousUntil: null },
    'autonomous-active': { level: 'autonomous', autonomousUntil: now + 60_000 },
    'autonomous-expired': { level: 'autonomous', autonomousUntil: now - 1 },
    'autonomous-unarmed': { level: 'autonomous', autonomousUntil: null },
  };
  /** What the table must say, written out independently of the implementation's order of checks. */
  function expected({ on, levelName, paused, untrusted, provider }) {
    if (!on) return ['off', 'switch_off'];
    if (provider !== 'claude-code') return ['off', 'brain'];
    if (paused) return ['off', 'paused'];
    if (levelName === 'read-only') return ['off', 'read_only'];
    if (levelName === 'ask') return ['ask', 'ask'];
    if (levelName === 'autonomous-active') return untrusted ? ['ask', 'untrusted'] : ['allowed', 'autonomous'];
    return ['ask', 'autonomous_expired'];
  }
  let rows = 0;
  for (const on of [false, true]) {
    for (const [levelName, fields] of Object.entries(LEVEL_ROWS)) {
      for (const paused of [false, true]) {
        for (const untrusted of [false, true]) {
          for (const provider of ['claude-code', 'codex', 'opencode']) {
            const policy = { ...fields, paused, computerUse: on, brainProvider: provider, channel: 'whatsapp' };
            const got = remoteComputerUse(policy, { untrusted, now, desktop: READY });
            const label = JSON.stringify({ on, levelName, paused, untrusted, provider });
            assert.deepEqual([got.state, got.reason], expected({ on, levelName, paused, untrusted, provider }), label);
            // The level it reports is effectiveLevel's, unchanged.
            assert.equal(got.level, effectiveLevel(policy, { untrusted, now }), label);
            assert.ok(COMPUTER_STATES.includes(got.state) && COMPUTER_REASONS[got.state].includes(got.reason), label);
            // Never on without the switch, never unasked on an untrusted turn, never on a brain that cannot ask.
            if (!on || provider !== 'claude-code' || paused) assert.equal(got.state, 'off', label);
            if (untrusted) assert.notEqual(got.state, 'allowed', label);
            rows += 1;
          }
        }
      }
    }
  }
  assert.equal(rows, 2 * 5 * 2 * 2 * 3);
  const base = { level: 'autonomous', autonomousUntil: now + 60_000, computerUse: true, brainProvider: 'claude-code' };
  // The window is read against the moment asked about.
  assert.equal(remoteComputerUse(base, { now, desktop: READY }).state, 'allowed');
  assert.deepEqual(remoteComputerUse(base, { now: now + 60_000, desktop: READY }), { state: 'ask', reason: 'autonomous_expired', level: 'ask' });
  // The provider of a brain about to be set wins over the registered one.
  assert.equal(remoteComputerUse(base, { now, provider: 'codex', desktop: READY }).reason, 'brain');
  // The desktop: not available, or not set up, on this machine.
  assert.deepEqual(remoteComputerUse(base, { now, desktop: { supported: false, ready: false } }), { state: 'off', reason: 'unsupported', level: 'autonomous' });
  assert.deepEqual(remoteComputerUse(base, { now, desktop: { supported: true, ready: false } }), { state: 'off', reason: 'setup', level: 'autonomous' });
  assert.equal(remoteComputerUse({ ...base, computerUse: false }, { now, desktop: { supported: false, ready: false } }).reason, 'switch_off', 'the switch is named first: it is what the owner can change');
  assert.equal(remoteComputerUse(base, { now }).state, 'allowed', 'no desktop passed: not checked');
  // Only `true` is on (a string, a 1, a missing field are off); a desktop session has no answer here.
  for (const value of [undefined, null, 'true', 1, 'on']) assert.equal(remoteComputerUse({ ...base, computerUse: value }, { now }).reason, 'switch_off', String(value));
  assert.equal(remoteComputerUse(null), null);
});

test('the registry carries the switch; a session nobody registered again is off; refusals say where it is turned on', () => {
  const registry = createRemotePolicyRegistry();
  assert.equal(registry.registerSessionPolicy('s1', { level: 'ask' }).computerUse, false, 'off unless said');
  for (const value of ['true', 1, {}, null]) assert.equal(registry.registerSessionPolicy('s1', { level: 'ask', computerUse: value }).computerUse, false, JSON.stringify(value));
  assert.equal(registry.registerSessionPolicy('s1', { level: 'ask', computerUse: true }).computerUse, true);
  const changes = [];
  registry.subscribe((event) => changes.push([event.previous?.computerUse, event.policy?.computerUse]));
  registry.registerSessionPolicy('s1', { level: 'ask', computerUse: false });
  assert.deepEqual(changes, [[true, false]], 'listeners hear the switch change, with what it was');
  registry.registerSessionPolicy('s1', { level: 'autonomous', autonomousUntil: Date.now() + 60_000, computerUse: true });
  registry.clearSessionPolicy('s1');
  const failClosed = registry.getSessionPolicy('s1');
  assert.deepEqual([failClosed.failClosed, failClosed.computerUse, remoteComputerUse(failClosed).state], [true, false, 'off']);
  // The computer tools stay refused unless the caller says the decision allows this call.
  for (const tool of ['mcp__SynaBun__computer', 'mcp__SynaBun__computer_apps', 'mcp__SynaBun__computer_ax', 'mcp__SynaBun__computer_status', 'SynaBun_computer']) {
    assert.match(remoteToolDenial(tool, { action: 'screenshot' }, PATHS), /not available from WhatsApp right now/, tool);
    assert.equal(isDeniedRemoteTool(tool, { action: 'screenshot' }, PATHS), true, tool);
    assert.equal(remoteToolDenial(tool, { action: 'screenshot' }, { ...PATHS, computerAllowed: true }), null, `${tool} when allowed`);
    for (const truthy of ['true', 1, {}]) assert.notEqual(remoteToolDenial(tool, { action: 'screenshot' }, { ...PATHS, computerAllowed: truthy }), null, 'only true allows');
  }
  // Allowed, its arguments are still checked like any tool's (and a call without arguments is refused).
  assert.match(remoteToolDenial('mcp__SynaBun__computer_apps', { action: 'open', path: `${HOME}/.ssh/id_rsa` }, { ...PATHS, computerAllowed: true }), /SSH keys/);
  assert.match(remoteToolDenial('mcp__SynaBun__computer', null, { ...PATHS, computerAllowed: true, argsComplete: false }), /could not see this call's arguments/);
  assert.equal(COMPUTER_SWITCH_PATH, 'Settings → Messages → WhatsApp → Safety');
  assert.match(remoteComputerDenial('switch_off'), /off for WhatsApp conversations\. The user turns it on in SynaBun on their computer: Settings → Messages → WhatsApp → Safety\./);
  assert.match(remoteToolDenial('mcp__SynaBun__computer', {}, { ...PATHS, computerReason: 'paused' }), /WhatsApp is paused/);
  for (const reason of COMPUTER_REASONS.off) assert.ok(remoteComputerDenial(reason).length > 20 && !/right now/.test(remoteComputerDenial(reason)), reason);
});

test('a worker dispatched from a remote session never gets computer use, switch on and Autonomous included', () => {
  const home = '/Users/owner';
  const projects = ['/work/app'];
  const now = Date.now();
  for (const policy of [
    { level: 'autonomous', autonomousUntil: now + 60_000, computerUse: true, channel: 'whatsapp' },
    { level: 'ask', computerUse: true, channel: 'whatsapp' },
  ]) {
    const notes = [];
    const out = clampDispatchSpec(policy, { provider: 'claude-code', task: 'open Notes', cwd: '/work/app', usesComputer: true }, { registeredProjects: projects, home, now, notes });
    assert.equal(out.usesComputer, false, policy.level);
    assert.ok(notes.some((note) => /computer use is off for WhatsApp sessions/.test(note)), policy.level);
    assert.equal(runExceedsPolicy(policy, { provider: 'claude-code', cwd: '/work/app', tags: [], permissionPolicy: 'ask', usesComputer: true }, { registeredProjects: projects, home, now }), true, 'a computer run of this session is stopped');
  }
});

// ── The phone's authority: a capability, not a string ──
import { createPhoneAuthority } from '../lib/remote-policy.js';

test('createPhoneAuthority: only the capability last issued verifies; it cannot be rebuilt, guessed or serialized', () => {
  const authority = createPhoneAuthority();
  assert.equal(Object.isFrozen(authority), true);
  assert.deepEqual(Object.keys(authority).sort(), ['issue', 'revoke', 'verify']);
  // Nothing verifies before one is issued.
  for (const value of [undefined, null, '', 'whatsapp', 'synabun.phone-authority', 0, true, {}, Symbol('synabun.phone-authority'), Symbol.for('synabun.phone-authority')]) assert.equal(authority.verify(value), false, String(value));
  const first = authority.issue();
  assert.equal(typeof first, 'symbol');
  assert.equal(authority.verify(first), true);
  assert.equal(authority.verify(Symbol(first.description)), false, 'a symbol with the same description is another symbol');
  assert.equal(authority.verify(Symbol.for(first.description)), false);
  assert.equal(authority.verify(first.description), false);
  assert.equal(JSON.stringify({ a: first, b: [first] }), '{"b":[null]}', 'never in JSON');
  assert.throws(() => structuredClone(first), 'never across a process or worker boundary');
  // A new one ends the one before: one holder at a time.
  const second = authority.issue();
  assert.notEqual(second, first);
  assert.deepEqual([authority.verify(first), authority.verify(second)], [false, true]);
  authority.revoke();
  assert.deepEqual([authority.verify(first), authority.verify(second)], [false, false]);
  // Two authorities know nothing of each other.
  const other = createPhoneAuthority();
  const theirs = other.issue();
  assert.equal(authority.verify(theirs), false);
  assert.equal(other.verify(authority.issue()), false);
});
