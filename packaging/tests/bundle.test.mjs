// A finished bundle, run for real. Skipped unless SYNABUN_BUNDLE_ENTRY names
// the entry executable of a build (`build --keep-work` leaves one in the
// staging folder):
//
//   SYNABUN_BUNDLE_ENTRY=<...>/SynaBun.app/Contents/MacOS/SynaBun npm run test:packaging
//
// SYNABUN_BUNDLE_LIVE=1 also starts the real server from the bundle, on a port
// nothing uses and in a throwaway home, and stops it again.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { findPrivatePaths } from '../lib/stage.mjs';
import { FORMAT_PLATFORM, nativeFormat, walk } from '../lib/util.mjs';
import { fingerprint, fingerprintChanges, mcpHandshake, smokeEnv } from '../lib/verify.mjs';

// The path with every link resolved: it is the one the entry reports for itself.
const entry = process.env.SYNABUN_BUNDLE_ENTRY ? realpathSync(resolve(process.env.SYNABUN_BUNDLE_ENTRY)) : null;
const skip = !entry && 'set SYNABUN_BUNDLE_ENTRY to the entry executable of a build';
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'synabun-bundle-')));
const children = new Set();
after(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

function locate() {
  const folder = dirname(entry);
  const resources = [join(folder, '..', 'Resources'), join(folder, 'usr', 'lib', 'synabun'), join(folder, 'resources')]
    .map(candidate => resolve(candidate)).find(candidate => existsSync(join(candidate, 'synabun-package.json')));
  assert.ok(resources, 'the bundle has no synabun-package.json next to its entry');
  return { resources, app: join(resources, 'app'), manifest: JSON.parse(readFileSync(join(resources, 'synabun-package.json'), 'utf8')) };
}
const fromBundle = (app, file) => import(pathToFileURL(join(app, file)).href);
const run = (args, env) => spawnSync(entry, args, { encoding: 'utf8', env, cwd: scratch, timeout: 180000 });
const posix = process.platform !== 'win32';

/**
 * One hook command, the way Claude Code runs it: a command line in a shell, the
 * event on stdin, and a PATH with no Node anywhere on it. `server` is the only
 * Neural Interface the handler may reach (the handlers default to the user's).
 */
function fireHook(command, event, { env, server }) {
  const bare = join(scratch, 'no node here');
  const project = join(scratch, 'a prôject ✓');
  for (const folder of [bare, project]) mkdirSync(folder, { recursive: true });
  const input = JSON.stringify({
    hook_event_name: event, session_id: 'bundle-test ✓', cwd: project, source: 'startup', prompt: 'hello',
    tool_name: 'Read', tool_input: {}, stop_hook_active: false,
  });
  return spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8', input, cwd: project, timeout: 60000,
    env: { ...env, PATH: bare, CLAUDE_PROJECT_DIR: project, SYNABUN_NI_URL: server },
  });
}

/** It started, it was the handler that answered, and what it answered is one JSON value or nothing. */
function assertHookRan(result, label) {
  assert.equal(result.error, undefined, label);
  assert.equal(result.status, 0, `${label}: exit ${result.status}\n${result.stderr}`);
  assert.equal(result.stderr, '', label);
  if (result.stdout.trim()) assert.doesNotThrow(() => JSON.parse(result.stdout), `${label}: ${result.stdout.slice(0, 200)}`);
}

test('a built bundle', { skip }, async (t) => {
  const { resources, app, manifest } = locate();
  const env = await smokeEnv(join(scratch, 'home'));
  const untouched = fingerprint(resources);

  await t.test('is native code for its target, with a Node of its own', () => {
    const { platform, arch } = manifest.target;
    const node = join(resources, manifest.runtime.bin, platform === 'win32' ? 'node.exe' : 'node');
    for (const file of [entry, node]) {
      const format = nativeFormat(file);
      assert.equal(FORMAT_PLATFORM[format?.format], platform, file);
      assert.ok(format.archs.includes(arch), `${file} is ${format.archs}`);
      if (platform !== 'win32') accessSync(file, constants.X_OK);
    }
  });

  await t.test('carries no private file and no code for another processor of its system', () => {
    const { platform, arch } = manifest.target;
    const own = [];
    for (const file of walk(app)) {
      if (!file.relative.includes('node_modules/')) own.push(file.relative);
      if (file.link) continue;
      const format = nativeFormat(file.path);
      if (format && FORMAT_PLATFORM[format.format] === platform) assert.ok(format.archs.includes(arch), `${file.relative} is ${format.archs}`);
    }
    assert.deepEqual(findPrivatePaths(own), []);
    assert.ok(own.includes('setup.js') && own.includes('lib/packaged-runtime.js'));
  });

  await t.test('reports its version and loads its native modules in an isolated home', () => {
    const version = run(['version'], env);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), `synabun v${manifest.version}`);

    const diagnosed = run(['diagnostics', '--json', '--natives'], env);
    assert.equal(diagnosed.status, 0, diagnosed.stdout + diagnosed.stderr);
    const facts = JSON.parse(diagnosed.stdout);
    assert.equal(facts.node.version, `v${manifest.runtime.node}`);
    assert.equal(facts.node.arch, manifest.target.arch);
    assert.ok(facts.node.path.startsWith(resources), 'the Node that runs is the bundled one');
    assert.equal(facts.dataHome, env.SYNABUN_DATA_HOME);
    assert.equal(facts.embeddingModel, manifest.embeddingModel);
    // A real pseudo-terminal ran a command; the embedding runtime loaded; the application's own helpers may run;
    // and none of the tools the user installs (Claude Code, Codex, OpenCode, Gemini CLI) is inside.
    for (const name of ['nodePty', 'onnxruntime', 'vendoredBinaries', 'externalTools']) assert.equal(facts.natives[name].ok, true, `${name}: ${facts.natives[name].error}`);
    assert.deepEqual(facts.natives.externalTools.packaged, []);
    assert.equal(facts.natives.claude, undefined, 'no Claude executable is part of the application');
  });

  await t.test('speaks MCP on stdio and nothing else', async () => {
    const answer = await mcpHandshake(entry, { env, cwd: scratch });
    assert.ok(answer.serverInfo.name);
    assert.ok(answer.tools.includes('remember') && answer.tools.includes('recall'), 'the memory tools are listed');
    // What it created is in the isolated data home.
    assert.ok(existsSync(env.SYNABUN_DATA_HOME));
  });

  await t.test('registers itself through the entry executable', async () => {
    const { readPackagedRuntime } = await fromBundle(app, 'lib/packaged-runtime.js');
    const runtime = readPackagedRuntime({ packageRoot: app, env: {} });
    assert.equal(runtime.entry, entry);
    const { buildCanonicalMcpDefinition } = await fromBundle(app, 'lib/client-config-repair.js');
    const definition = buildCanonicalMcpDefinition({ dataHome: env.SYNABUN_DATA_HOME, packageRoot: app });
    assert.equal(definition.command, entry.replace(/\\/g, '/'));
    assert.deepEqual(definition.args, ['mcp']);
    const { buildLauncherPlan } = await fromBundle(app, 'lib/start-launcher.js');
    const plan = buildLauncherPlan({ packageRoot: app, home: env.HOME, entry: runtime.entry, platform: manifest.target.platform });
    const text = JSON.stringify(plan);
    assert.ok(text.includes('launcher'));
    assert.ok(!text.includes('launcher.mjs'), 'the handler is the entry, not a script run by some node');
  });

  await t.test('runs every Claude Code hook through its entry, with no Node on the PATH', { skip: !posix && 'POSIX shell' }, async () => {
    const { HOOK_SCRIPTS, PACKAGED_HOOK_MODE, hookCommandString, hookInstallBlocker } = await fromBundle(app, 'lib/claude-hooks.js');
    const { readPackagedRuntime } = await fromBundle(app, 'lib/packaged-runtime.js');
    const runtime = readPackagedRuntime({ packageRoot: app, env: {} });
    assert.equal(hookInstallBlocker(runtime), null);
    for (const { script, event } of HOOK_SCRIPTS) {
      const command = hookCommandString(script, undefined, runtime);
      assert.equal(command, `"${entry}" ${PACKAGED_HOOK_MODE} ${script}`);
      // Nothing listens on this port: the handler works alone, and never reaches a server of the user's.
      assertHookRan(fireHook(command, event, { env, server: env.NEURAL_INTERFACE_URL }), `${event} ${script}`);
    }
    const [first] = HOOK_SCRIPTS;
    const started = fireHook(hookCommandString(first.script, undefined, runtime), first.event, { env, server: env.NEURAL_INTERFACE_URL });
    assert.match(started.stdout, /hookSpecificOutput/, 'the real handler answered');
  });

  await t.test('is never changed by the in-app updater', async () => {
    const { buildSynabunInstallPlan } = await fromBundle(app, 'neural-interface/lib/synabun-update-plan.js');
    const plan = buildSynabunInstallPlan({
      current: manifest.version, latest: '99.0.0', updateAvailable: true, targetOnNpm: true,
      installSource: { kind: 'packaged-app' }, repoUrl: 'https://github.com/danilokhury/Synabun',
    });
    assert.equal(plan.canAutoUpdate, false);
    assert.equal(plan.reason, 'packaged-app');
    assert.equal(plan.installSpec, undefined);
  });

  await t.test('desktop start leaves the real backend alive, reuses it, preserves cold-start behavior, and stops', { skip: process.env.SYNABUN_BUNDLE_LIVE !== '1' && 'set SYNABUN_BUNDLE_LIVE=1' }, async () => {
    const live = { ...await smokeEnv(join(scratch, 'live-home')), SYNABUN_WHATSAPP: 'off' };
    const base = `http://127.0.0.1:${live.NEURAL_PORT}`;
    const child = spawn(entry, [], { env: live, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise(done => child.on('exit', (code, signal) => done({ code, signal })));
    const get = async (path, init) => fetch(base + path, { signal: AbortSignal.timeout(15000), ...init });

    let up = false;
    const healthDeadline = Date.now() + 240000;
    while (!up && Date.now() < healthDeadline) {
      // Successful desktop-launcher exit is expected; the detached backend still runs.
      if (child.exitCode !== null && child.exitCode !== 0) break;
      try { up = (await get('/api/health')).ok; } catch {}
      if (!up) await new Promise(r => setTimeout(r, 500));
    }
    try {
      assert.ok(up, `the server did not answer on ${base}\n${output.slice(-3000)}`);
      const launchEnded = await Promise.race([exited, new Promise(done => setTimeout(() => done(null), 15000))]);
      assert.equal(launchEnded?.code, 0, 'native desktop launcher exits successfully');
      const supervisorPath = join(live.SYNABUN_DATA_HOME, 'data', 'supervisor.json');
      const firstSupervisor = JSON.parse(readFileSync(supervisorPath, 'utf8')).pid;
      assert.doesNotThrow(() => process.kill(firstSupervisor, 0), 'supervisor survives desktop launcher exit');
      const second = run([], live);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(JSON.parse(readFileSync(supervisorPath, 'utf8')).pid, firstSupervisor, 'second click reuses the same supervisor');
      assert.equal((await get('/api/health')).ok, true, 'backend is independent of the desktop window');
      // The supervisor ran with the bundled runtime; the server knows it is packaged.
      const status = await (await get('/api/setup/status')).json();
      assert.equal(status.paths.mcpCommand, entry.replace(/\\/g, '/'));
      assert.deepEqual(status.paths.mcpArgs, ['mcp']);
      const update = await get('/api/system/run-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(update.status, 409);
      assert.equal((await update.json()).packaged, true);

      // What a person is shown to copy: the entry, never `node` or an npm command.
      const shown = entry.replace(/\\/g, '/');
      assert.ok(status.claude.cliCommand.includes(`"${shown}" mcp`) && !/\bnode\b/.test(status.claude.cliCommand.replace(shown, '')), status.claude.cliCommand);
      const onboarding = await (await get('/api/setup/onboarding')).json();
      assert.equal(onboarding.mcpCommand, shown);
      assert.deepEqual(onboarding.mcpArgs, ['mcp']);
      const health = await (await get('/api/health')).json();
      assert.equal(health.install, 'app');
      assert.equal(health.entry, entry);

      // A first start without Claude Code, Codex, OpenCode or Gemini CLI: this run can
      // see none (SYNABUN_TOOL_DISCOVERY in smokeEnv) and the application carries none.
      // Each is reported as not installed, with the command that installs it; the lists
      // that would come from one are empty or the built-in fallback; and the server goes on.
      const tools = (await (await get('/api/system/tool-versions?force=1', { signal: AbortSignal.timeout(60000) })).json()).tools;
      for (const key of ['claude-code', 'codex', 'opencode', 'gemini']) {
        assert.equal(tools[key]?.installed, null, `${key} is reported as ${tools[key]?.installed}: nothing of it is installed here`);
        assert.ok(tools[key].installCommand, `${key}: the user is told how to install it`);
      }
      const claudeModels = await (await get('/api/claude/models?refresh=1', { signal: AbortSignal.timeout(60000) })).json();
      assert.equal(claudeModels.source, 'fallback');
      assert.ok(claudeModels.models.length > 0);
      const codexModels = await (await get('/api/codex/models?refresh=1', { signal: AbortSignal.timeout(60000) })).json();
      assert.equal(codexModels.ok, false);
      assert.deepEqual(codexModels.models, []);
      assert.match(codexModels.error, /\S/);
      assert.equal((await get('/api/health')).ok, true, 'the server is still up after asking for tools that are not there');
      const offline = await (await get('/offline.html')).text();
      assert.ok(offline.includes('"install":"app"') && offline.includes(`"entry":${JSON.stringify(entry)}`), 'the offline page knows how this install is started');
      assert.ok(offline.includes('function packagedStartCommand('));

      // Hooks, written by the real server into the throwaway home's settings.
      const { HOOK_SCRIPTS, PACKAGED_HOOK_MODE } = await fromBundle(app, 'lib/claude-hooks.js');
      const install = await get('/api/claude-code/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'global' }) });
      assert.equal(install.status, 200, await install.clone().text());
      const settings = JSON.parse(readFileSync(join(live.HOME, '.claude', 'settings.json'), 'utf8'));
      const commands = Object.values(settings.hooks).flat().flatMap(group => group.hooks.map(hook => hook.command));
      assert.deepEqual([...commands].sort(), HOOK_SCRIPTS.map(({ script }) => `"${shown}" ${PACKAGED_HOOK_MODE} ${script}`).sort());
      assert.equal(settings.env?.SYNABUN_HOOK_ROOT, undefined, 'no package root in the settings');
      const integrations = await (await get('/api/claude-code/integrations')).json();
      assert.equal(integrations.global.installed, true);
      assert.ok(Object.values(integrations.global.hooks).every(Boolean));
      // One of them, exactly as it was written, against the server it belongs to.
      if (posix) {
        const sessionStart = settings.hooks.SessionStart[0].hooks[0].command;
        const fired = fireHook(sessionStart, 'SessionStart', { env: live, server: base });
        assertHookRan(fired, 'SessionStart from the settings');
        assert.match(fired.stdout, /hookSpecificOutput/);
      }
    } finally {
      try { await get('/api/server/shutdown', { method: 'POST' }); } catch {}
      child.kill('SIGTERM');
      // A failed assertion must also clean up the detached supervisor we own.
      try {
        const record = JSON.parse(readFileSync(join(live.SYNABUN_DATA_HOME, 'data', 'supervisor.json'), 'utf8'));
        if (record.pid && !record.endedAt) process.kill(record.pid, 'SIGTERM');
      } catch {}
    }
    const ended = await Promise.race([exited, new Promise(done => setTimeout(() => done(null), 30000))]);
    assert.ok(ended, 'the desktop entry did not end');
    // Nothing is left listening.
    await new Promise(r => setTimeout(r, 1500));
    const stillOpen = await new Promise((done) => {
      const socket = connect({ port: Number(live.NEURAL_PORT), host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
    });
    assert.equal(stillOpen, false);
    // Everything it wrote is under the throwaway home.
    assert.ok(existsSync(join(live.SYNABUN_DATA_HOME, 'data')));
  });

  await t.test('leaves every file of the bundle as it was', () => {
    // A signed application and a read-only image cannot be written to.
    assert.deepEqual(fingerprintChanges(untouched, fingerprint(resources)), []);
  });
});
