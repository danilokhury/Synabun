// The two pieces between the operating system and the application: the native
// entry (compiled here, run against a stand-in for Node) and the packaged
// bootstrap (run against a stand-in for the supervisor). Paths have spaces and
// non-ASCII characters throughout, and nothing here touches a real install.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { HOOK_SCRIPTS, PACKAGED_HOOK_MODE, hookCommandString } from '../../lib/claude-hooks.js';
import { readPackagedRuntime } from '../../lib/packaged-runtime.js';
import { PACKAGING_ROOT, REPO_ROOT } from '../lib/targets.mjs';
import { HOOK_MODE } from '../runtime/bootstrap.mjs';
import { which } from '../lib/util.mjs';

const posix = process.platform !== 'win32';
const compiler = posix ? which('cc') : null;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'synabun entry tést ✓-')));
const NODE_FLAG = '--disable-warning=ExperimentalWarning';
const children = new Set();
after(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
});

function freePort() {
  return new Promise((done) => {
    const server = createTcpServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

const manifest = (resources, entry, extra = {}) => writeFileSync(join(resources, 'synabun-package.json'), JSON.stringify({
  synabunPackage: 1, name: 'synabun', version: '9.9.9', app: 'app',
  target: { id: 'test', platform: process.platform, arch: process.arch },
  artifact: 'test', entry: relative(resources, entry), runtime: { node: process.versions.node, bin: 'runtime/bin' }, ...extra,
}));

// ─────────────────────────── the native entry ───────────────────────────

/** A bundle laid out like the real one, with a script that reports how it was started in place of Node. */
function nativeTree(name) {
  const root = join(scratch, name);
  const mac = process.platform === 'darwin';
  const entry = mac ? join(root, 'SynaBun.app', 'Contents', 'MacOS', 'SynaBun') : join(root, 'SynaBun.AppDir', 'AppRun');
  const resources = mac ? join(root, 'SynaBun.app', 'Contents', 'Resources') : join(root, 'SynaBun.AppDir', 'usr', 'lib', 'synabun');
  mkdirSync(join(entry, '..'), { recursive: true });
  mkdirSync(join(resources, 'runtime', 'bin'), { recursive: true });
  mkdirSync(join(resources, 'app', 'mcp-server'), { recursive: true });
  manifest(resources, entry);
  writeFileSync(join(resources, 'bootstrap.mjs'), '');
  writeFileSync(join(resources, 'app', 'mcp-server', 'run.mjs'), '');
  const report = join(resources, 'report.mjs');
  writeFileSync(report, [
    "import { readFileSync } from 'node:fs';",
    "const stdin = process.env.STANDIN_READ ? readFileSync(0, 'utf8') : null;",
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), entry: process.env.SYNABUN_PACKAGED_ENTRY, path: process.env.PATH, stdin }));",
    "process.exit(Number(process.env.STANDIN_EXIT || 0));",
    '',
  ].join('\n'));
  const standIn = join(resources, 'runtime', 'bin', 'node');
  writeFileSync(standIn, `#!/bin/sh\nexec '${process.execPath}' '${report}' "$@"\n`);
  chmodSync(standIn, 0o755);
  const built = spawnSync(compiler, ['-O1', '-std=c99', '-Wall', '-Wextra', '-Werror', '-o', entry, join(PACKAGING_ROOT, 'launcher', 'launcher.c')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  return { root, entry, resources, appDir: join(root, 'SynaBun.AppDir') };
}

const started = (entry, args = [], options = {}) => {
  const result = spawnSync(entry, args, { encoding: 'utf8', ...options, env: { PATH: '/usr/bin:/bin', ...options.env } });
  return { ...result, report: result.stdout ? JSON.parse(result.stdout) : null };
};

test('the native entry', { skip: !compiler && 'needs a C compiler on a POSIX system' }, async (t) => {
  const tree = nativeTree('Install Földer ✓');

  await t.test('starts the bootstrap with the bundled Node, and says where it lives', () => {
    const { status, report } = started(tree.entry);
    assert.equal(status, 0);
    assert.deepEqual(report.argv, [NODE_FLAG, join(tree.resources, 'bootstrap.mjs')]);
    assert.equal(report.entry, tree.entry);
    // node, npm and npx started by name are the bundled ones.
    assert.equal(report.path.split(':')[0], join(tree.resources, 'runtime', 'bin'));
    assert.ok(report.path.endsWith(':/usr/bin:/bin'));
  });

  await t.test('passes arguments through untouched: no shell ever reads them', () => {
    const hostile = ['start', 'two words', 'ünï ✓ 字', '$(touch pwned)', '; touch pwned', '`touch pwned`', '"quoted"', "it's", '', '--x=a b'];
    const cwd = join(scratch, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const { status, report } = started(tree.entry, hostile, { cwd });
    assert.equal(status, 0);
    assert.deepEqual(report.argv.slice(2), hostile);
    assert.equal(existsSync(join(cwd, 'pwned')), false);
  });

  await t.test('runs the MCP server directly for `mcp`, with nothing in between', () => {
    const { report } = started(tree.entry, ['mcp', '--flag', 'v a l']);
    assert.deepEqual(report.argv, [NODE_FLAG, join(tree.resources, 'app', 'mcp-server', 'run.mjs'), '--flag', 'v a l']);
  });

  await t.test('is the process it starts: exit code and stdio are the child\'s own', () => {
    assert.equal(started(tree.entry, [], { env: { STANDIN_EXIT: '42' } }).status, 42);
    const piped = started(tree.entry, ['mcp'], { input: '{"jsonrpc":"2.0"}\n', env: { STANDIN_READ: '1' } });
    assert.equal(piped.report.stdin, '{"jsonrpc":"2.0"}\n');
    assert.equal(piped.stderr, '');
  });

  await t.test('finds itself through a link', () => {
    const link = join(scratch, 'a link to synabun');
    symlinkSync(tree.entry, link);
    const { report } = started(link, ['version']);
    assert.equal(report.entry, tree.entry);
    assert.deepEqual(report.argv, [NODE_FLAG, join(tree.resources, 'bootstrap.mjs'), 'version']);
  });

  await t.test('refuses to run as an incomplete copy, and says so on stderr only', () => {
    const alone = join(scratch, 'alone');
    mkdirSync(alone);
    copyFileSync(tree.entry, join(alone, 'SynaBun'));
    chmodSync(join(alone, 'SynaBun'), 0o755);
    const result = spawnSync(join(alone, 'SynaBun'), ['mcp'], { encoding: 'utf8' });
    assert.equal(result.status, 127);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /incomplete/);
  });

  await t.test('names the image, not the mount, when it runs from an AppImage', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
    const image = join(scratch, 'SynaBun.AppImage');
    writeFileSync(image, '');
    assert.equal(started(tree.entry, [], { env: { APPIMAGE: image, APPDIR: tree.appDir } }).report.entry, image);
    // An APPIMAGE inherited from some other application's mount is not ours.
    assert.equal(started(tree.entry, [], { env: { APPIMAGE: image, APPDIR: scratch } }).report.entry, tree.entry);
    assert.equal(started(tree.entry, [], { env: { APPIMAGE: image } }).report.entry, tree.entry);
  });
});

// ─────────────────────────── the bootstrap ───────────────────────────

/** <resources> with the real bootstrap and library files, and a supervisor that reports instead of starting a server. */
function bootstrapTree(name) {
  const resources = join(scratch, name);
  const app = join(resources, 'app');
  mkdirSync(join(app, 'lib'), { recursive: true });
  mkdirSync(join(resources, 'runtime', 'bin'), { recursive: true });
  copyFileSync(join(PACKAGING_ROOT, 'runtime', 'bootstrap.mjs'), join(resources, 'bootstrap.mjs'));
  for (const file of ['paths.js', 'packaged-runtime.js', 'start-launcher.js', 'desktop-pwa.js']) copyFileSync(join(REPO_ROOT, 'lib', file), join(app, 'lib', file));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'synabun', version: '9.9.9', type: 'module' }));
  writeFileSync(join(app, 'setup.js'), [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    'const out = process.env.STANDIN_OUT;',
    'writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv, path: process.env.PATH, mark: process.env.SYNABUN_LAUNCH_ENV || null }));',
    'if (process.env.STANDIN_WAIT) {',
    "  process.on('SIGTERM', () => { appendFileSync(out + '.signal', 'SIGTERM'); process.exit(0); });",
    '  setInterval(() => {}, 1000);',
    '} else process.exit(Number(process.env.STANDIN_EXIT || 0));',
    '',
  ].join('\n'));
  // What the launcher starts in place of the real entry: it says how it was
  // called, then answers on the port like a server that came up.
  const helper = join(resources, 'entry-helper.mjs');
  writeFileSync(helper, [
    "import { writeFileSync } from 'node:fs';",
    "import { createServer } from 'node:http';",
    'writeFileSync(process.env.STANDIN_OUT, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, mark: process.env.SYNABUN_LAUNCH_ENV || null, port: process.env.NEURAL_PORT, dataHome: process.env.SYNABUN_DATA_HOME }));',
    "createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, storage: 'sqlite', projectDir: 'fixture', startLauncher: {} })); }).listen(Number(process.env.NEURAL_PORT), '127.0.0.1');",
    'setTimeout(() => process.exit(0), 30000);',
    '',
  ].join('\n'));
  const entry = join(resources, 'entry stand-in');
  writeFileSync(entry, `#!/bin/sh\nexec '${process.execPath}' '${helper}' "$@"\n`);
  chmodSync(entry, 0o755);
  manifest(resources, entry);
  return { resources, app, entry, bootstrap: join(resources, 'bootstrap.mjs') };
}

async function isolated(tree, name) {
  const home = join(scratch, `${name}-home`);
  mkdirSync(home, { recursive: true });
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    SYNABUN_DATA_HOME: join(home, 'data-home'),
    NEURAL_PORT: String(await freePort()),
    SYNABUN_OPEN_BROWSER: '0',
    SYNABUN_LAUNCHER_REGISTER: '0',
    STANDIN_OUT: join(home, 'supervisor.json'),
  };
}

const bootstrap = (tree, args, env) => spawnSync(process.execPath, [tree.bootstrap, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
const reported = (env) => JSON.parse(readFileSync(env.STANDIN_OUT, 'utf8'));

test('the packaged bootstrap', { skip: !posix && 'POSIX only' }, async (t) => {
  const tree = bootstrapTree('Resources ✓ bööt');

  await t.test('`start` is the supervisor in the foreground, with the bundled runtime first on PATH', async () => {
    const env = { ...await isolated(tree, 'start'), STANDIN_EXIT: '7' };
    const result = bootstrap(tree, ['start', 'a', 'b c'], env);
    assert.equal(result.status, 7, result.stderr);
    const seen = reported(env);
    assert.deepEqual(seen.argv, ['a', 'b c']);
    assert.deepEqual(seen.execArgv, [NODE_FLAG]);
    assert.equal(seen.path, `${join(tree.resources, 'runtime', 'bin')}:/usr/bin:/bin`);
    assert.equal(seen.mark, null);
  });

  await t.test('the usual commands reach the usual CLI', async () => {
    const env = await isolated(tree, 'cli');
    assert.equal(bootstrap(tree, ['doctor', '--json'], env).status, 0);
    assert.deepEqual(reported(env).argv, ['doctor', '--json']);
  });

  await t.test('a start from the desktop runs the supervisor when nothing answers', async () => {
    const env = await isolated(tree, 'desktop');
    const result = bootstrap(tree, [], env);
    assert.equal(result.status, 0, result.stderr);
    const seen = reported(env);
    assert.deepEqual(seen.argv, ['background-server']);
    assert.equal(result.stdout, '', 'desktop start is quiet');
    assert.doesNotThrow(() => process.kill(seen.pid, 0), 'backend survives launcher exit');
    process.kill(seen.pid, 'SIGKILL');
    // No terminal: the environment was resolved once, and says so to whatever it starts.
    assert.equal(seen.mark, 'resolved');
  });

  await t.test('a second start shows the running one and starts nothing', async () => {
    const env = await isolated(tree, 'running');
    const server = createServer((req, res) => res.end(JSON.stringify({ ok: true, storage: 'sqlite', projectDir: 'fixture', startLauncher: {} })));
    await new Promise(done => server.listen(Number(env.NEURAL_PORT), '127.0.0.1', done));
    try {
      const result = await new Promise((done) => {
        const child = spawn(process.execPath, [tree.bootstrap], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.on('exit', (code) => done({ code, stdout }));
      });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '', 'second desktop start is quiet');
      assert.equal(existsSync(env.STANDIN_OUT), false);
    } finally {
      server.close();
    }
  });

  await t.test('a signal sent to it ends the supervisor', async () => {
    const env = { ...await isolated(tree, 'signal'), STANDIN_WAIT: '1' };
    const child = spawn(process.execPath, [tree.bootstrap, 'start'], { env, stdio: 'ignore' });
    children.add(child);
    const ended = new Promise(done => child.on('exit', (code, signal) => done({ code, signal })));
    for (let i = 0; i < 100 && !existsSync(env.STANDIN_OUT); i++) await new Promise(r => setTimeout(r, 50));
    child.kill('SIGTERM');
    assert.deepEqual(await ended, { code: 0, signal: null });
    assert.equal(readFileSync(`${env.STANDIN_OUT}.signal`, 'utf8'), 'SIGTERM');
  });

  await t.test('diagnostics describe the build and keep to the given data home', async () => {
    const env = await isolated(tree, 'diagnostics');
    const result = bootstrap(tree, ['diagnostics', '--json'], env);
    assert.equal(result.status, 0, result.stderr);
    const facts = JSON.parse(result.stdout);
    assert.equal(facts.packaged, true);
    assert.equal(facts.version, '9.9.9');
    assert.equal(facts.entry, tree.entry);
    assert.equal(facts.dataHome, env.SYNABUN_DATA_HOME);
    assert.equal(facts.embeddingModel, 'absent');
    assert.equal(existsSync(env.SYNABUN_DATA_HOME), false, 'asking must not create the data home');
  });

  await t.test('the link handler starts the supervisor through the entry executable', async () => {
    const env = await isolated(tree, 'launcher');
    const result = spawnSync(process.execPath, [tree.bootstrap, 'launcher', '--via=protocol', '--', 'synabun://start'], { encoding: 'utf8', env, timeout: 60000 });
    let seen = null;
    try {
      assert.equal(result.status, 0, result.stderr);
      seen = reported(env);
      // `<entry> start`, never this process's own node and setup.js: an
      // AppImage's files are gone when the process that mounted them ends.
      assert.deepEqual(seen.argv, ['background-server']);
      assert.equal(seen.mark, 'resolved');
      assert.equal(seen.port, env.NEURAL_PORT);
      assert.equal(seen.dataHome, env.SYNABUN_DATA_HOME);
      assert.match(readFileSync(join(env.SYNABUN_DATA_HOME, 'data', 'launcher.log'), 'utf8'), /started: answering/);
    } finally {
      if (seen?.pid) { try { process.kill(seen.pid, 'SIGKILL'); } catch {} }
    }
    // A link that asks for anything else starts nothing.
    const other = await isolated(tree, 'launcher-other');
    assert.equal(spawnSync(process.execPath, [tree.bootstrap, 'launcher', '--via=protocol', '--', 'synabun://delete-everything'], { encoding: 'utf8', env: other, timeout: 30000 }).status, 0);
    assert.equal(existsSync(other.STANDIN_OUT), false);
  });
});

// ─────────────────────────── a Claude Code hook ───────────────────────────

/**
 * The real entry, the real bootstrap and library files, the Node these tests
 * run on as the bundled one, and handlers that say what reached them.
 */
function hookTree(name) {
  const root = join(scratch, name);
  const mac = process.platform === 'darwin';
  const entry = mac ? join(root, 'Syna Bun ✓.app', 'Contents', 'MacOS', 'SynaBun') : join(root, 'SynaBun.AppDir', 'AppRun');
  const resources = mac ? join(root, 'Syna Bun ✓.app', 'Contents', 'Resources') : join(root, 'SynaBun.AppDir', 'usr', 'lib', 'synabun');
  const app = join(resources, 'app');
  mkdirSync(join(entry, '..'), { recursive: true });
  mkdirSync(join(resources, 'runtime', 'bin'), { recursive: true });
  mkdirSync(join(app, 'lib'), { recursive: true });
  mkdirSync(join(app, 'hooks', 'claude-code'), { recursive: true });
  mkdirSync(join(app, 'mcp-server'), { recursive: true });
  writeFileSync(join(app, 'mcp-server', 'run.mjs'), '');
  manifest(resources, entry);
  symlinkSync(process.execPath, join(resources, 'runtime', 'bin', 'node'));
  copyFileSync(join(PACKAGING_ROOT, 'runtime', 'bootstrap.mjs'), join(resources, 'bootstrap.mjs'));
  for (const file of ['paths.js', 'packaged-runtime.js', 'claude-hooks.js']) copyFileSync(join(REPO_ROOT, 'lib', file), join(app, 'lib', file));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'synabun', version: '9.9.9', type: 'module' }));
  // Says what it was given, the way a handler answers Claude Code: on stdout.
  writeFileSync(join(app, 'hooks', 'claude-code', 'stop.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const input = readFileSync(0, 'utf8');",
    'process.stdout.write(JSON.stringify({',
    '  argv: process.argv.slice(1), input, node: process.execPath, flags: process.execArgv,',
    '  entry: process.env.SYNABUN_PACKAGED_ENTRY, path: process.env.PATH, project: process.env.CLAUDE_PROJECT_DIR, cwd: process.cwd(),',
    '}));',
    "if (process.env.STANDIN_STDERR) process.stderr.write(process.env.STANDIN_STDERR);",
    'process.exitCode = Number(process.env.STANDIN_EXIT || 0);',
    '',
  ].join('\n'));
  // Still at work after the three seconds the other modes allow themselves.
  writeFileSync(join(app, 'hooks', 'claude-code', 'post-plan.mjs'), "setTimeout(() => process.stdout.write('late answer'), 3300);\n");
  writeFileSync(join(app, 'hooks', 'claude-code', 'pre-compact.mjs'), "throw new Error('handler broke');\n");
  // A library of the handlers, not a handler.
  writeFileSync(join(app, 'hooks', 'claude-code', 'shared.mjs'), "process.stdout.write('not a hook');\n");
  const built = spawnSync(compiler, ['-O1', '-std=c99', '-Wall', '-Wextra', '-Werror', '-o', entry, join(PACKAGING_ROOT, 'launcher', 'launcher.c')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  return { root, entry, resources, app, appDir: join(root, 'SynaBun.AppDir') };
}

test('a Claude Code hook of a packaged application', { skip: !compiler && 'needs a C compiler on a POSIX system' }, async (t) => {
  const tree = hookTree('Hooks Földer ✓');
  const runtime = readPackagedRuntime({ packageRoot: tree.app, env: {} });
  // A PATH with no Node anywhere on it: what an IDE started by itself gives a hook.
  const bare = join(scratch, 'empty bin');
  mkdirSync(bare, { recursive: true });
  const project = join(scratch, 'a prôject ✓');
  mkdirSync(project, { recursive: true });
  // The way Claude Code runs a handler: one command line, in a shell.
  const fired = (command, options = {}) => spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8', cwd: project, timeout: 30000, ...options,
    env: { PATH: bare, CLAUDE_PROJECT_DIR: project, ...options.env },
  });

  await t.test('the command is the installed entry, and the mode the bootstrap answers to', () => {
    assert.equal(HOOK_MODE, PACKAGED_HOOK_MODE);
    assert.equal(runtime.entry, tree.entry);
    assert.equal(hookCommandString('stop.mjs', undefined, runtime), `"${tree.entry}" ${PACKAGED_HOOK_MODE} stop.mjs`);
    assert.notEqual(spawnSync('/bin/sh', ['-c', 'command -v node'], { env: { PATH: bare } }).status, 0, 'no node on this PATH');
  });

  await t.test('runs the handler with the bundled Node, its stdin and stdout untouched', () => {
    const payload = `${JSON.stringify({ hook_event_name: 'Stop', session_id: 'ünï ✓ 字', cwd: project })}\n`;
    const result = fired(hookCommandString('stop.mjs', undefined, runtime), { input: payload });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'silent');
    // Nothing but the handler's own answer.
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.input, payload);
    // What it finds under `node -e <bootstrap> stop.mjs`: the script name, then its arguments.
    assert.deepEqual(seen.argv, ['stop.mjs']);
    assert.equal(realpathSync(seen.node), realpathSync(process.execPath));
    assert.deepEqual(seen.flags, [NODE_FLAG]);
    assert.equal(seen.entry, tree.entry);
    // node, npm and npx started by name from a handler are the bundled ones.
    assert.equal(seen.path, `${join(tree.resources, 'runtime', 'bin')}:${bare}`);
    assert.equal(seen.project, project);
    assert.equal(realpathSync(seen.cwd), project);
  });

  await t.test('arguments, the exit code and stderr are the handler\'s own', () => {
    const command = `${hookCommandString('stop.mjs', undefined, runtime)} 'two words' "ünï ✓" --x=1`;
    const result = fired(command, { input: '', env: { STANDIN_EXIT: '2', STANDIN_STDERR: 'blocked: reason ✓' } });
    assert.equal(result.status, 2, 'the code Claude Code reads as a block');
    assert.equal(result.stderr, 'blocked: reason ✓');
    assert.deepEqual(JSON.parse(result.stdout).argv, ['stop.mjs', 'two words', 'ünï ✓', '--x=1']);
  });

  await t.test('lets a handler finish however long it takes', () => {
    const began = Date.now();
    const result = fired(hookCommandString('post-plan.mjs', undefined, runtime), { input: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'late answer');
    assert.ok(Date.now() - began >= 3300);
  });

  await t.test('says what went wrong on stderr only, and never as a block', () => {
    const broken = fired(hookCommandString('pre-compact.mjs', undefined, runtime), { input: '' });
    assert.equal(broken.status, 1);
    assert.equal(broken.stdout, '');
    assert.match(broken.stderr, /^SynaBun hook: handler broke\n$/);
    for (const name of ['shared.mjs', '../../../bootstrap.mjs', '', 'stop']) {
      const refused = fired(`"${tree.entry}" ${PACKAGED_HOOK_MODE} ${name}`, { input: '' });
      assert.equal(refused.status, 1, name);
      assert.equal(refused.stdout, '', name);
      assert.match(refused.stderr, /^SynaBun hook: unknown hook/, name);
    }
  });

  await t.test('every registered hook has a command, and none of them needs a Node on the PATH', () => {
    for (const { script } of HOOK_SCRIPTS) {
      const command = hookCommandString(script, undefined, runtime);
      assert.equal(command, `"${tree.entry}" ${PACKAGED_HOOK_MODE} ${script}`);
    }
    // An npm or Git install keeps the command it always had.
    assert.match(hookCommandString('stop.mjs', undefined, null), /^node -e "const f=require\('node:fs'\).*" stop\.mjs$/);
  });

  await t.test('from an AppImage the command names the image, not the mount', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
    const image = join(scratch, 'Syna Bun.AppImage');
    writeFileSync(image, '');
    // What the entry tells the application when the AppImage runtime started it.
    const told = started(tree.entry, ['diagnostics', '--json'], { env: { APPIMAGE: image, APPDIR: tree.appDir } });
    const facts = JSON.parse(told.stdout);
    assert.equal(facts.entry, image);
    const mounted = readPackagedRuntime({ packageRoot: tree.app, env: { SYNABUN_PACKAGED_ENTRY: facts.entry } });
    assert.equal(hookCommandString('stop.mjs', undefined, mounted), `"${image}" ${PACKAGED_HOOK_MODE} stop.mjs`);
  });
});
