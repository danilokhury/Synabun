// What changes when this package runs inside a packaged application, and that
// nothing changes when it does not.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';
import {
  HOOK_SCRIPTS, PACKAGED_HOOK_MODE, ensureHookRoot, hookCommandString, hookInstallBlocker, hookInstallPlan, isSynaBunHookCommand, sweepSettingsHooks,
} from '../../lib/claude-hooks.js';
import { buildCanonicalMcpDefinition } from '../../lib/client-config-repair.js';
import {
  durableEntry, isTransientPath, mcpStdioCommand, PACKAGED_ENTRY_ENV, readPackagedRuntime, withPackagedPath,
} from '../../lib/packaged-runtime.js';
import { buildLauncherPlan, desktopExecArg, shQuote, winQuote } from '../../lib/start-launcher.js';
import { buildSynabunInstallPlan } from '../lib/synabun-update-plan.js';

const scratch = mkdtempSync(join(tmpdir(), 'synabun-packaged-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** <resources>/app with a manifest next to it, and an entry executable where the manifest says. */
function packagedTree(name, manifest = {}) {
  const resources = join(scratch, name, 'Resources dir');
  const packageRoot = join(resources, 'app');
  const entry = join(scratch, name, 'MacOS', "Syna Bun's ✓");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(join(entry, '..'), { recursive: true });
  writeFileSync(entry, '');
  chmodSync(entry, 0o755);
  writeFileSync(join(resources, 'synabun-package.json'), JSON.stringify({
    synabunPackage: 1, name: 'synabun', version: '2.0.0', app: 'app',
    target: { id: 'macos-arm64', platform: 'darwin', arch: 'arm64' },
    artifact: 'macos-app', entry: `../MacOS/Syna Bun's ✓`, runtime: { node: '22.19.0', bin: 'runtime/bin' },
    ...manifest,
  }));
  return { resources, packageRoot, entry };
}

test('an npm or Git install is not a packaged application', () => {
  const plain = join(scratch, 'node_modules', 'synabun');
  mkdirSync(plain, { recursive: true });
  assert.equal(readPackagedRuntime({ packageRoot: plain, env: {} }), null);
  // The environment alone never makes it one.
  assert.equal(readPackagedRuntime({ packageRoot: plain, env: { [PACKAGED_ENTRY_ENV]: process.execPath } }), null);
  assert.deepEqual(mcpStdioCommand('/x/preload.js', { packageRoot: plain, env: {} }), { command: 'node', args: ['/x/preload.js'] });
  const env = { PATH: '/usr/bin' };
  assert.equal(withPackagedPath(env, null), env);
});

test('a manifest that describes another folder is ignored', () => {
  const { resources } = packagedTree('other');
  const sibling = join(resources, 'checkout');
  mkdirSync(sibling);
  assert.equal(readPackagedRuntime({ packageRoot: sibling, env: {} }), null);
  const { packageRoot } = packagedTree('unmarked', { synabunPackage: undefined });
  assert.equal(readPackagedRuntime({ packageRoot, env: {} }), null);
  const broken = packagedTree('broken');
  writeFileSync(join(broken.resources, 'synabun-package.json'), '{ not json');
  assert.equal(readPackagedRuntime({ packageRoot: broken.packageRoot, env: {} }), null);
});

test('a packaged application knows its entry, and prefers the one it was started through', () => {
  const { packageRoot, entry, resources } = packagedTree('entry');
  const runtime = readPackagedRuntime({ packageRoot, env: {} });
  assert.equal(runtime.entry, entry);
  assert.equal(runtime.version, '2.0.0');
  assert.equal(runtime.target, 'macos-arm64');
  assert.equal(runtime.runtimeBin, join(resources, 'runtime', 'bin'));

  // An AppImage runs from a mount; the image file is what the launcher names.
  const image = join(scratch, 'SynaBun.AppImage');
  writeFileSync(image, '');
  assert.equal(readPackagedRuntime({ packageRoot, env: { [PACKAGED_ENTRY_ENV]: image } }).entry, image);
  // A stale or relative value is not trusted over what the builder recorded.
  assert.equal(readPackagedRuntime({ packageRoot, env: { [PACKAGED_ENTRY_ENV]: join(scratch, 'gone') } }).entry, entry);
  assert.equal(readPackagedRuntime({ packageRoot, env: { [PACKAGED_ENTRY_ENV]: 'SynaBun.AppImage' } }).entry, entry);
});

test('MCP clients are given the entry executable, not a node they do not have', () => {
  const { packageRoot, entry } = packagedTree('mcp');
  assert.deepEqual(mcpStdioCommand('/x/preload.js', { packageRoot, env: {} }), { command: entry, args: ['mcp'] });

  const packaged = buildCanonicalMcpDefinition({ dataHome: join(scratch, 'data'), packageRoot });
  assert.equal(packaged.command, entry);
  assert.deepEqual(packaged.args, ['mcp']);

  const plain = join(scratch, 'plain-install');
  mkdirSync(plain, { recursive: true });
  const usual = buildCanonicalMcpDefinition({ dataHome: join(scratch, 'data'), packageRoot: plain });
  assert.equal(usual.command, 'node');
  assert.deepEqual(usual.args, [join(plain, 'mcp-server', 'dist', 'preload.js').replace(/\\/g, '/')]);
  // The data paths are the same for both kinds of install.
  assert.deepEqual(packaged.env, usual.env);
});

test('the bundled runtime goes first on PATH, once', () => {
  const { packageRoot, resources } = packagedTree('path');
  const runtime = readPackagedRuntime({ packageRoot, env: {} });
  const bin = join(resources, 'runtime', 'bin');
  const once = withPackagedPath({ PATH: ['/usr/bin', '/bin'].join(delimiter), OTHER: '1' }, runtime);
  assert.equal(once.PATH, [bin, '/usr/bin', '/bin'].join(delimiter));
  assert.equal(once.OTHER, '1');
  assert.equal(withPackagedPath(once, runtime), once);
  // Windows spells the variable its own way.
  assert.equal(withPackagedPath({ Path: 'C:\\Windows' }, runtime).Path, [bin, 'C:\\Windows'].join(delimiter));
});

test('the synabun:// handler of a packaged application is its entry executable', () => {
  const entry = "/Applications/Syna Bun's ✓.app/Contents/MacOS/SynaBun";
  const base = { nodePath: '/bundle/runtime/bin/node', packageRoot: '/bundle/app', home: '/Users/me', entry };

  const mac = buildLauncherPlan({ ...base, platform: 'darwin', port: 4455 });
  const [, handler, terminal] = mac.files;
  assert.ok(handler.content.includes(`ENTRY=${shQuote(entry)}`));
  assert.ok(handler.content.includes(`exec "$ENTRY" 'launcher' '--via=protocol' '--port' '4455'`));
  assert.ok(terminal.content.includes(`exec ${shQuote(entry)} start`));
  assert.ok(terminal.content.includes("export NEURAL_PORT='4455'"));
  for (const file of [handler, terminal]) {
    assert.ok(!file.content.includes('launcher.mjs') && !file.content.includes('setup.js') && !file.content.includes('NODE='), file.path);
  }

  const linux = buildLauncherPlan({ ...base, platform: 'linux', entry: '/home/me/Apps/SynaBun $1.AppImage' });
  assert.ok(linux.files[0].content.includes(`Exec=${['/home/me/Apps/SynaBun $1.AppImage', 'launcher', '--via=protocol', '--'].map(desktopExecArg).join(' ')} %u`));

  const windowsEntry = 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\SynaBun\\SynaBun.exe';
  const windows = buildLauncherPlan({ ...base, platform: 'win32', entry: windowsEntry });
  assert.equal(windows.registry.at(-1).value, `${[windowsEntry, 'launcher', '--via=protocol', '--'].map(winQuote).join(' ')} "%1"`);
});

test('without an entry the handler is what it always was', () => {
  const base = { nodePath: '/usr/local/bin/node', packageRoot: '/opt/synabun', home: '/Users/me' };
  const mac = buildLauncherPlan({ ...base, platform: 'darwin' });
  assert.ok(mac.files[1].content.includes(`NODE='/usr/local/bin/node'`));
  assert.ok(mac.files[1].content.includes(`exec "$NODE" '/opt/synabun/launcher.mjs' '--via=protocol'`));
  assert.ok(mac.files[2].content.includes(`exec "$NODE" --disable-warning=ExperimentalWarning '/opt/synabun/setup.js'`));
  const linux = buildLauncherPlan({ ...base, platform: 'linux' });
  assert.ok(linux.files[0].content.includes('Exec="/usr/local/bin/node" "/opt/synabun/launcher.mjs" "--via=protocol" "--" %u'));
  const windows = buildLauncherPlan({ nodePath: 'C:\\node\\node.exe', packageRoot: 'C:\\synabun', platform: 'win32' });
  assert.equal(windows.registry.at(-1).value, '"C:\\node\\node.exe" "C:\\synabun\\launcher.mjs" "--via=protocol" "--" "%1"');
});

test('the updater never installs into a packaged application', () => {
  const repoUrl = 'https://github.com/danilokhury/Synabun';
  const request = { current: '2.0.0', latest: '2.1.0', updateAvailable: true, targetOnNpm: true, repoUrl };
  const packaged = buildSynabunInstallPlan({ ...request, installSource: { kind: 'packaged-app' } });
  assert.equal(packaged.canAutoUpdate, false);
  assert.equal(packaged.reason, 'packaged-app');
  assert.equal(packaged.installSpec, undefined);
  assert.equal(packaged.manualCommand, null);
  assert.equal(packaged.openUrl, `${repoUrl}/releases`);
  assert.match(packaged.manualHint, /Nothing was installed/);
  // An npm install of the same release still updates itself.
  const npm = buildSynabunInstallPlan({ ...request, installSource: { kind: 'npm-global' } });
  assert.equal(npm.canAutoUpdate, true);
  assert.equal(npm.installSpec, 'synabun@2.1.0');
});

// ─────────────────────────── Claude Code hooks ───────────────────────────

const posix = process.platform !== 'win32';
const REPO = resolve(import.meta.dirname, '..', '..');
const NODE_FORM = /^node -e "const f=require\('node:fs'\).*" stop\.mjs$/;

/** What `/bin/sh -c <command>` hands the program it starts: one argument per line, from a stand-in for it. */
function argvThroughShell(command, standIn, env = {}) {
  writeFileSync(standIn, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
  chmodSync(standIn, 0o755);
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').slice(0, -1);
}

test('a path that ends with the run is never the entry the outside world is given', () => {
  assert.equal(isTransientPath('/private/var/folders/ab/T/AppTranslocation/1F2E/d/SynaBun.app/Contents/MacOS/SynaBun', {}), true);
  assert.equal(isTransientPath('/tmp/.mount_SynaBuAbCdEf/AppRun', {}), true);
  assert.equal(isTransientPath('/run/user/1000/appimage/AppRun', { APPDIR: '/run/user/1000/appimage/' }), true);
  // Another application's mount in the environment says nothing about this path.
  assert.equal(isTransientPath('/home/me/Apps/SynaBun.AppImage', { APPDIR: '/tmp/.mount_CursorXyZ123' }), false);
  assert.equal(isTransientPath('/Applications/SynaBun.app/Contents/MacOS/SynaBun', {}), false);
  assert.equal(isTransientPath('C:\\Users\\Zoë\\AppData\\Local\\Programs\\SynaBun\\SynaBun.exe', {}), false);
  assert.equal(isTransientPath('', {}), false);

  assert.equal(durableEntry(null), null);
  assert.equal(durableEntry({ entry: null }), null);
  assert.equal(durableEntry({ entry: '/Applications/SynaBun.app/Contents/MacOS/SynaBun' }, {}), '/Applications/SynaBun.app/Contents/MacOS/SynaBun');
  assert.equal(durableEntry({ entry: '/tmp/.mount_SynaBuAbCdEf/AppRun' }, {}), null);
});

test('an npm or Git install registers the hooks it always did', () => {
  const plain = join(scratch, 'hooks-plain');
  mkdirSync(plain, { recursive: true });
  assert.equal(readPackagedRuntime({ packageRoot: plain, env: {} }), null);
  for (const { script } of HOOK_SCRIPTS) {
    const command = hookCommandString(script, undefined, null);
    assert.ok(command.startsWith('node -e "const f=require(\'node:fs\')') && command.endsWith(`" ${script}`), script);
    // The default is this install, which is not a packaged one.
    assert.equal(hookCommandString(script), command);
    assert.equal(isSynaBunHookCommand(command, script), true);
  }
  assert.equal(hookInstallBlocker(null), null);
  const settings = {};
  assert.equal(ensureHookRoot(settings, undefined, plain, null), true);
  assert.equal(settings.env.SYNABUN_HOOK_ROOT, plain);
  assert.throws(() => hookCommandString('not-a-hook.mjs', undefined, null), /Unknown SynaBun hook/);
});

test('a packaged application registers its hooks through its entry executable', { skip: !posix && 'POSIX shell' }, () => {
  const { packageRoot, entry } = packagedTree('hooks');
  const runtime = readPackagedRuntime({ packageRoot, env: {} });
  const command = hookCommandString('stop.mjs', undefined, runtime);
  assert.equal(command, `"${entry}" ${PACKAGED_HOOK_MODE} stop.mjs`);
  assert.ok(!/\bnode\b/.test(command.replace(entry, '')), 'no Node from the PATH');
  // The shell Claude Code runs it in starts that very file, with these arguments.
  assert.deepEqual(argvThroughShell(command, entry), [PACKAGED_HOOK_MODE, 'stop.mjs']);

  // Everything a POSIX shell still reads inside double quotes.
  const hostile = join(scratch, 'hooks', 'a "b" $HOME `id` \\ ✓ 字', 'SynaBun');
  mkdirSync(join(hostile, '..'), { recursive: true });
  const marker = join(scratch, 'hooks', 'pwned');
  const hostileCommand = hookCommandString('pre-task.mjs', undefined, { ...runtime, entry: hostile });
  assert.deepEqual(argvThroughShell(hostileCommand, hostile, { HOME: `$(touch '${marker}')` }), [PACKAGED_HOOK_MODE, 'pre-task.mjs']);
  assert.throws(() => readFileSync(marker), /ENOENT/);
  assert.equal(isSynaBunHookCommand(hostileCommand, 'pre-task.mjs'), true);

  // The settings get no hook root: the command needs none.
  const settings = {};
  assert.equal(ensureHookRoot(settings, undefined, packageRoot, runtime), false);
  assert.deepEqual(settings, {});
  assert.equal(hookInstallBlocker(runtime), null);
});

test('a hook command names the AppImage, never the mount it runs from', () => {
  const { packageRoot } = packagedTree('hooks-appimage');
  const image = join(scratch, 'Syna Bun-2.0.0-x86_64.AppImage');
  writeFileSync(image, '');
  const mount = join(scratch, 'hooks-appimage');
  const runtime = readPackagedRuntime({ packageRoot, env: { [PACKAGED_ENTRY_ENV]: image } });
  const command = hookCommandString('session-start.mjs', undefined, runtime);
  assert.equal(command, `"${image}" ${PACKAGED_HOOK_MODE} session-start.mjs`);
  assert.ok(!command.includes(mount + '/'), 'nothing of the mount');
  const settings = { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: hookCommandString('session-start.mjs', undefined, null), timeout: 5 }] }] } };
  assert.equal(sweepSettingsHooks(settings, undefined, {}, packageRoot, runtime), true);
  assert.equal(JSON.stringify(settings).includes(mount + '/'), false);
  assert.equal(settings.env, undefined);
});

test('a Windows entry is one quoted argument for cmd.exe and Git Bash alike', () => {
  const runtime = { entry: 'C:\\Users\\Zoë Ana\\AppData\\Local\\Programs\\SynaBun\\SynaBun.exe' };
  const command = hookCommandString('stop.mjs', undefined, runtime);
  assert.equal(command, `"C:/Users/Zoë Ana/AppData/Local/Programs/SynaBun/SynaBun.exe" ${PACKAGED_HOOK_MODE} stop.mjs`);
  assert.equal(isSynaBunHookCommand(command, 'stop.mjs'), true);
  // One written with the path as Windows spells it is still ours.
  assert.equal(isSynaBunHookCommand(`"${runtime.entry}" ${PACKAGED_HOOK_MODE} stop.mjs`, 'stop.mjs'), true);
});

test('only SynaBun\'s own handlers are taken for SynaBun\'s', () => {
  const ours = `"/Applications/SynaBun.app/Contents/MacOS/SynaBun" ${PACKAGED_HOOK_MODE} stop.mjs`;
  assert.equal(isSynaBunHookCommand(ours, 'stop.mjs'), true);
  assert.equal(isSynaBunHookCommand(ours, 'pre-task.mjs'), false);
  for (const foreign of [
    '"/usr/local/bin/other tool" hook stop.mjs',
    `/Applications/SynaBun.app/Contents/MacOS/SynaBun ${PACKAGED_HOOK_MODE} stop.mjs --and more`,
    `"/x/SynaBun" ${PACKAGED_HOOK_MODE} stop.mjs; rm -rf "$HOME"`,
    `echo "/x/SynaBun" ${PACKAGED_HOOK_MODE} stop.mjs`,
    'node /opt/other/hooks/stop.mjs',
    'node -e "require(\'./stop.mjs\')" stop.mjs',
    '', null, undefined, 7,
  ]) assert.equal(isSynaBunHookCommand(foreign, 'stop.mjs'), false, String(foreign));
});

test('moving to the application, or moving the application, leaves one handler per hook', () => {
  const { packageRoot, entry } = packagedTree('hooks-sweep');
  const runtime = readPackagedRuntime({ packageRoot, env: {} });
  const foreign = { matcher: '', hooks: [{ type: 'command', command: 'node /opt/other/hooks/stop.mjs', timeout: 9 }] };
  const elsewhere = `"/Volumes/Old Disk/SynaBun.app/Contents/MacOS/SynaBun" ${PACKAGED_HOOK_MODE}`;
  const settings = {
    env: { SYNABUN_HOOK_ROOT: '/usr/local/lib/node_modules/synabun', KEEP: '1' },
    hooks: {
      // From the npm install this person used before.
      Stop: [foreign, { matcher: '', hooks: [{ type: 'command', command: hookCommandString('stop.mjs', undefined, null), timeout: 3 }] }],
      // From where the application used to be, twice.
      SessionStart: [
        { matcher: '', hooks: [{ type: 'command', command: `${elsewhere} session-start.mjs`, timeout: 5 }] },
        { matcher: '', hooks: [{ type: 'command', command: `${elsewhere} session-start.mjs`, timeout: 5 }, { type: 'command', command: 'echo mine' }] },
      ],
    },
  };
  const stats = {};
  assert.equal(sweepSettingsHooks(settings, undefined, stats, packageRoot, runtime), true);
  const commands = (event) => settings.hooks[event].flatMap(group => group.hooks.map(hook => hook.command));
  assert.deepEqual(commands('Stop'), ['node /opt/other/hooks/stop.mjs', `"${entry}" ${PACKAGED_HOOK_MODE} stop.mjs`]);
  assert.deepEqual(commands('SessionStart'), ['echo mine', `"${entry}" ${PACKAGED_HOOK_MODE} session-start.mjs`]);
  assert.equal(stats.removed, 1);
  assert.equal(stats.repaired, 2);
  // Nothing of the person's own is rewritten, and nothing points at a package root.
  assert.deepEqual(settings.env, { SYNABUN_HOOK_ROOT: '/usr/local/lib/node_modules/synabun', KEEP: '1' });
  assert.deepEqual(settings.hooks.Stop[0], foreign);
  // A second pass has nothing to do.
  const before = JSON.stringify(settings);
  assert.equal(sweepSettingsHooks(settings, undefined, {}, packageRoot, runtime), false);
  assert.equal(JSON.stringify(settings), before);

  // And back: an npm install takes the application's handlers for its own.
  assert.equal(sweepSettingsHooks(settings, undefined, {}, join(scratch, 'plain-root'), null), true);
  assert.match(commands('Stop')[1], NODE_FORM);
  assert.equal(commands('Stop').length, 2);
});

test('a copy that macOS runs from a temporary path writes no hooks', () => {
  const { packageRoot } = packagedTree('hooks-translocated');
  const base = readPackagedRuntime({ packageRoot, env: {} });
  const runtime = { ...base, entry: '/private/var/folders/ab/T/AppTranslocation/1F2E/d/SynaBun.app/Contents/MacOS/SynaBun' };
  assert.match(hookInstallBlocker(runtime), /temporary location/);
  const installed = `"/Applications/SynaBun.app/Contents/MacOS/SynaBun" ${PACKAGED_HOOK_MODE} stop.mjs`;
  const settings = { hooks: { Stop: [{ matcher: 'stale', hooks: [{ type: 'command', command: installed, timeout: 1 }] }] } };
  const before = JSON.stringify(settings);
  // The installed copy's working registration is left exactly as it is.
  assert.equal(sweepSettingsHooks(settings, undefined, {}, packageRoot, runtime), false);
  assert.equal(JSON.stringify(settings), before);
  assert.equal(ensureHookRoot(settings, undefined, packageRoot, runtime), false);
  assert.equal(JSON.stringify(settings), before);

  const server = readFileSync(join(REPO, 'neural-interface', 'server.js'), 'utf8');
  const status = server.slice(server.indexOf("app.get('/api/claude-code/integrations'"), server.indexOf("app.post('/api/claude-code/integrations'"));
  assert.match(status, /for \(const p of hookInstallBlocker\(\) \? \[\] : projects\)/);
});

test('such a copy still adds a project, and refuses only what is about hooks alone', () => {
  const { packageRoot } = packagedTree('hooks-plan');
  const installed = readPackagedRuntime({ packageRoot, env: {} });
  const temporary = { ...installed, entry: '/private/var/folders/ab/T/AppTranslocation/1F2E/d/SynaBun.app/Contents/MacOS/SynaBun' };
  const requests = [
    { target: 'global' },
    { target: 'global', hook: 'Stop' },
    { target: 'project', registered: false },
    { target: 'project', registered: true },
    { target: 'project', registered: false, hook: 'Stop' },
  ];
  // An npm or Git install, and an installed application: everything is written, as it always was.
  for (const request of requests) {
    assert.equal(hookInstallPlan(request, null), 'write');
    assert.equal(hookInstallPlan(request, installed), 'write');
  }
  // A new project is registered without hooks; a request that could only write hooks is refused.
  assert.deepEqual(requests.map(request => hookInstallPlan(request, temporary)), ['refuse', 'refuse', 'register-only', 'refuse', 'refuse']);
  assert.equal(hookInstallPlan(undefined, temporary), 'refuse');

  const server = readFileSync(join(REPO, 'neural-interface', 'server.js'), 'utf8');
  const install = server.slice(server.indexOf("app.post('/api/claude-code/integrations'"), server.indexOf("app.delete('/api/claude-code/integrations'"));
  const [global, project] = install.split("if (target === 'project') {");
  // Turning the hooks on everywhere is refused with the sentence, before anything is read or written.
  assert.match(global, /if \(target === 'global'\) \{\s+if \(blocker\) return res\.status\(409\)\.json\(\{ error: blocker \}\);\s+const filePath = getGlobalClaudeSettingsPath\(\);/);
  // A project: the plan decides, the settings are written only for 'write', and the project is saved either way.
  assert.match(project, /const plan = hookInstallPlan\(\{ target, registered, hook \}\);\s+if \(plan === 'refuse'\) return res\.status\(409\)\.json\(\{ error: blocker \}\);/);
  assert.match(project, /if \(plan === 'write'\) \{\s+const filePath = getClaudeSettingsPath\(normalized\);[\s\S]{0,220}addHookToSettings\(settings, hook \|\| undefined, normalized\);\s+writeClaudeSettings\(filePath, settings\);\s+\}/);
  assert.ok(project.indexOf('saveHookProjects(projects);') > project.indexOf("if (plan === 'write') {"));
  // The answer never says a hook was enabled when none was written.
  assert.match(project, /if \(plan !== 'write'\) \{\s+return res\.json\(\{ ok: true, message: `\$\{basename\(normalized\)\} was added without hooks\. \$\{blocker\}`, hooksSkipped: true, dubiousOwnership, trustPath \}\);/);
});

// ─────────────────────── what a person copies and pastes ───────────────────────

/** A function of a source file, found by its opening line, as a callable in a sandbox with the given globals. */
function extracted(source, opening, globals = {}) {
  const text = source.replace(/\r\n/g, '\n');
  const start = text.indexOf(opening);
  assert.ok(start >= 0, opening);
  // It ends at the first closing brace indented like its opening line.
  const close = `\n${text.slice(text.lastIndexOf('\n', start) + 1, start)}}`;
  const body = text.slice(start, text.indexOf(close, start) + close.length);
  const sandbox = { ...globals };
  vm.runInNewContext(`this.fn = ${body.replace(/^const\s+\w+\s*=\s*/, '')}`, sandbox);
  return sandbox.fn;
}

test('the `claude mcp add` line starts the very executable and arguments the server registers', { skip: !posix && 'POSIX shell' }, () => {
  const server = readFileSync(join(REPO, 'neural-interface', 'server.js'), 'utf8');
  const claudeMcpAddCommand = extracted(server, 'function claudeMcpAddCommand(');
  const bin = join(scratch, 'cli-bin');
  mkdirSync(bin, { recursive: true });
  const run = (line) => argvThroughShell(line, join(bin, 'claude'), { PATH: `${bin}:/usr/bin:/bin` });

  const { packageRoot } = packagedTree('cli');
  const entry = join(scratch, 'cli', 'a "b" $HOME `id` ✓', 'SynaBun');
  const { command, args } = mcpStdioCommand('/x/preload.js', { packageRoot, env: {}, runtime: { entry } });
  const envPath = '/Users/José Müller/.synabun/.env';
  assert.deepEqual(run(claudeMcpAddCommand({ mcpIndexPath: '/x/preload.js', envPath, mcpCommand: command, mcpArgs: args })),
    ['mcp', 'add', 'SynaBun', entry, 'mcp', '-s', 'user', '-e', `DOTENV_PATH=${envPath}`]);

  // An npm or Git install: the line it always was.
  const plain = claudeMcpAddCommand({ mcpIndexPath: '/opt/syna bun/mcp-server/dist/preload.js', envPath, mcpCommand: 'node', mcpArgs: ['/opt/syna bun/mcp-server/dist/preload.js'] });
  assert.equal(plain, `claude mcp add SynaBun node "/opt/syna bun/mcp-server/dist/preload.js" -s user -e "DOTENV_PATH=${envPath}"`);
  assert.deepEqual(run(plain), ['mcp', 'add', 'SynaBun', 'node', '/opt/syna bun/mcp-server/dist/preload.js', '-s', 'user', '-e', `DOTENV_PATH=${envPath}`]);

  const windows = claudeMcpAddCommand({ mcpIndexPath: 'x', envPath: 'C:/Users/Zoë/.synabun/.env', mcpCommand: 'C:/Users/Zoë Ana/SynaBun/SynaBun.exe', mcpArgs: ['mcp'] });
  assert.equal(windows, 'claude mcp add SynaBun "C:/Users/Zoë Ana/SynaBun/SynaBun.exe" mcp -s user -e "DOTENV_PATH=C:/Users/Zoë/.synabun/.env"');
});

test('the snippets in Settings and in the setup wizard use what the server says to run', () => {
  const entry = '/Applications/Syna "Bun" ✓.app/Contents/MacOS/SynaBun';
  const packaged = { mcpIndexPath: '/r/app/mcp-server/dist/preload.js', envPath: '/h/.synabun/.env', mcpCommand: entry, mcpArgs: ['mcp'] };
  const plain = { mcpIndexPath: '/opt/synabun/mcp-server/dist/preload.js', envPath: '/h/.synabun/.env', mcpCommand: 'node', mcpArgs: ['/opt/synabun/mcp-server/dist/preload.js'] };

  const settings = readFileSync(join(REPO, 'neural-interface', 'public', 'shared', 'ui-settings.js'), 'utf8');
  // (through JSON: what the sandbox returns belongs to another realm)
  const launchFor = (paths) => JSON.parse(JSON.stringify(extracted(settings, 'const mcpLaunch = () => {', { setupStatus: { paths } })()));
  assert.deepEqual(launchFor(packaged), { command: entry, args: ['mcp'] });
  assert.deepEqual(launchFor(plain), { command: 'node', args: [plain.mcpIndexPath] });
  // Before the server has answered: the placeholder it always showed.
  assert.deepEqual(launchFor(undefined), { command: 'node', args: ['<path-to>/mcp-server/run.mjs'] });
  // Every paste-in fallback goes through it; none spells out `node` by itself.
  const setup = settings.slice(settings.indexOf('const mcpLaunch = () => {'), settings.indexOf("wireRulesControls('coexistence', 'coexistence')"));
  assert.equal(setup.match(/mcpLaunch\(\)/g).length, 3);
  assert.doesNotMatch(setup.slice(setup.indexOf('// ── Gemini ──')), /command: 'node'|command = "node"/);
  // The Codex block is TOML: a JSON string is a TOML basic string.
  assert.match(setup, /command = \$\{JSON\.stringify\(launch\.command\)\}\\nargs = \[\$\{launch\.args\.map\(arg => JSON\.stringify\(arg\)\)\.join\(', '\)\}\]/);

  const onboarding = readFileSync(join(REPO, 'neural-interface', 'public', 'onboarding.html'), 'utf8');
  const wizard = (state) => JSON.parse(extracted(onboarding, 'function getGenericMcpJson() {', { wizardState: state, JSON })());
  const app = wizard({ dataHome: '/h/.synabun', packageRoot: '/tmp/.mount_SynaBuAbCdEf/usr/lib/synabun/app', mcpCommand: entry, mcpArgs: ['mcp'] });
  assert.equal(app.mcpServers.SynaBun.command, entry);
  assert.deepEqual(app.mcpServers.SynaBun.args, ['mcp']);
  assert.equal(JSON.stringify(app).includes('.mount_'), false, 'nothing of a mount in what is pasted');
  assert.deepEqual(app.mcpServers.SynaBun.env, { DOTENV_PATH: '/h/.synabun/.env', SYNABUN_DATA_HOME: '/h/.synabun', MEMORY_DATA_DIR: '/h/.synabun/mcp-data' });
  const npm = wizard({ dataHome: 'C:\\Users\\me\\.synabun', packageRoot: 'C:\\opt\\synabun', mcpCommand: 'node', mcpArgs: ['C:/opt/synabun/mcp-server/dist/preload.js'] });
  assert.deepEqual(npm.mcpServers.SynaBun, {
    command: 'node', args: ['C:/opt/synabun/mcp-server/run.mjs'],
    env: { DOTENV_PATH: 'C:/Users/me/.synabun/.env', SYNABUN_DATA_HOME: 'C:/Users/me/.synabun', MEMORY_DATA_DIR: 'C:/Users/me/.synabun/mcp-data' },
  });
  assert.match(onboarding, /wizardState\.mcpCommand = data\.mcpCommand;/);

  const server = readFileSync(join(REPO, 'neural-interface', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/setup/onboarding'"), server.indexOf("app.post('/api/setup/save-config'"));
  assert.match(route, /const \{ mcpCommand, mcpArgs \} = getMcpPaths\(\);/);
  assert.match(route, /mcpCommand,\s+mcpArgs,/);
});
