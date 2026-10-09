import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_NOT_INSTALLED,
  findOnPath,
  resolveClaudeLauncher,
  resolveClaudeSdkExecutable,
  selectWindowsLauncher,
  windowsClaudeTargets,
  withoutPackageBins,
} from '../lib/claude-executable.js';
import { getAugmentedPath } from '../lib/augmented-path.js';
import { queryClaudeCliModels, shellCommand, checkClaudeCliSkew, clearClaudeModelCache } from '../lib/claude-model-catalog.js';
import { generateSessionTitle } from '../lib/session-title-generator.js';

// Claude Code is installed by the user, separately from SynaBun. These tests
// are about finding that installation and nothing else: on PATH, in the folders
// the installers use, behind an npm command file on Windows, under a folder
// with a space in its name; never a copy inside SynaBun; and an ordinary answer
// when there is none.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'synabun-claude-exec-')));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));
const posix = process.platform !== 'win32';

function executable(file, text = '#!/bin/sh\necho "2.1.300 (Claude Code)"\n') {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, 0o755);
  return file;
}

// A Windows machine, described: which files exist. Paths are compared the way Windows does.
function windowsDisk(files) {
  const set = new Set(files.map(file => file.toLowerCase()));
  const has = (file) => set.has(String(file).toLowerCase());
  return {
    exists: has,
    isLaunchable: has,
    validate: (spec) => {
      if (!has(spec)) return { ok: false, path: null, reason: `Not found: ${spec}` };
      if (/\.(c|m)?js$/i.test(spec)) return { ok: true, path: spec, kind: 'script', reason: null };
      if (/\.exe$/i.test(spec)) return { ok: true, path: spec, kind: 'native', reason: null };
      return { ok: false, path: null, reason: `${spec} is not a .exe` };
    },
  };
}

test('PATH order decides between folders; inside one folder a real executable beats a command file', () => {
  const npm = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm';
  const native = 'C:\\Users\\Jane Doe\\.local\\bin';
  // `where claude` in an npm folder: the extensionless shell script comes first.
  assert.equal(selectWindowsLauncher([`${npm}\\claude`, `${npm}\\claude.cmd`, `${npm}\\claude.ps1`]), `${npm}\\claude.cmd`);
  assert.equal(selectWindowsLauncher([`${npm}\\claude.ps1`, `${npm}\\claude.bat`, `${npm}\\claude.cmd`, `${npm}\\claude.exe`]), `${npm}\\claude.exe`);
  assert.equal(selectWindowsLauncher([`${npm}\\claude.ps1`, `${npm}\\claude.bat`]), `${npm}\\claude.bat`);
  // An earlier folder wins even when a later one holds a real executable: that is what PATH means.
  assert.equal(selectWindowsLauncher([`${npm}\\claude`, `${npm}\\claude.cmd`, `${native}\\claude.exe`]), `${npm}\\claude.cmd`);
  assert.equal(selectWindowsLauncher([`${native}\\claude.exe`, `${npm}\\claude.cmd`]), `${native}\\claude.exe`);
  // Only the script Windows cannot start: the last resort, never dropped silently.
  assert.equal(selectWindowsLauncher([`${npm}\\claude`]), `${npm}\\claude`);
  assert.equal(selectWindowsLauncher([]), null);
  // A filter (a copy inside SynaBun) takes a folder's entries out before the choice.
  const inside = 'C:\\Program Files\\SynaBun\\resources\\app\\neural-interface\\node_modules\\.bin';
  assert.equal(selectWindowsLauncher([`${inside}\\claude.cmd`, `${npm}\\claude.cmd`], file => !file.startsWith('C:\\Program Files\\SynaBun')), `${npm}\\claude.cmd`);
});

test('a command from a node_modules/.bin folder on PATH is never the user\'s tool', () => {
  assert.equal(withoutPackageBins('/app/node_modules/.bin:/usr/local/bin:/app/neural-interface/node_modules/.bin/:/opt/homebrew/bin', 'linux'), '/usr/local/bin:/opt/homebrew/bin');
  assert.equal(withoutPackageBins('C:\\app\\node_modules\\.bin;C:\\Users\\u\\AppData\\Roaming\\npm', 'win32'), 'C:\\Users\\u\\AppData\\Roaming\\npm');
});

test('the installed Claude Code is found on PATH, in PATH order, through folders with spaces', { skip: !posix && 'POSIX executables' }, () => {
  const home = join(scratch, 'Jane Doe');
  const first = executable(join(home, '.local', 'bin', 'claude'));
  const second = executable(join(home, 'homebrew bin', 'claude'));
  const bundled = executable(join(scratch, 'SynaBun', 'neural-interface', 'node_modules', '.bin', 'claude'));
  writeFileSync(join(home, 'homebrew bin', 'not-executable'), '');
  const pathValue = [join(scratch, 'SynaBun', 'neural-interface', 'node_modules', '.bin'), join(home, 'homebrew bin'), join(home, '.local', 'bin')].join(':');

  assert.deepEqual(findOnPath('claude', { pathValue }), [bundled, second, first]);
  assert.deepEqual(findOnPath('not-executable', { pathValue }), [], 'a file that cannot be started is not a command');

  const found = resolveClaudeLauncher({ pathValue });
  assert.deepEqual(found, { path: second, source: 'path', rejected: [] }, 'the .bin folder is skipped, then PATH order');
  // What the SDK is given: that same file, as it is.
  assert.deepEqual(resolveClaudeSdkExecutable({ launcher: found.path }), {
    path: second, source: 'installed', kind: 'native', reason: null, ignored: null, launcher: second,
  });
});

test('a copy inside SynaBun is passed over wherever it sits, and reported', { skip: !posix && 'POSIX executables' }, () => {
  const root = join(scratch, 'inside');
  const stale = executable(join(root, 'SynaBun', 'vendor', 'claude'));
  const real = executable(join(root, 'usr', 'bin', 'claude'));
  const isInsideSynabun = (file) => file.startsWith(join(root, 'SynaBun'));
  const pathValue = [join(root, 'SynaBun', 'vendor'), join(root, 'usr', 'bin')].join(':');

  assert.deepEqual(resolveClaudeLauncher({ pathValue, isInsideSynabun }), { path: real, source: 'path', rejected: [stale] });
  // Only the copy: then nothing is installed, as far as SynaBun is concerned.
  assert.deepEqual(resolveClaudeLauncher({ pathValue: join(root, 'SynaBun', 'vendor'), isInsideSynabun }), { path: null, source: 'missing', rejected: [stale] });
  // The same for a configured path and for what the SDK would be handed.
  assert.equal(resolveClaudeLauncher({ configured: stale, pathValue, isInsideSynabun }).path, real);
  const refused = resolveClaudeSdkExecutable({ launcher: stale, isInsideSynabun });
  assert.equal(refused.path, null);
  assert.match(refused.reason, /is inside SynaBun, not an installation of Claude Code/);
});

test('the command from Settings > Terminal is honoured: a path as it is, a name through PATH', { skip: !posix && 'POSIX executables' }, () => {
  const root = join(scratch, 'configured');
  const custom = executable(join(root, 'my tools', 'claude-nightly'));
  const onPath = executable(join(root, 'bin', 'claude'));
  const pathValue = [join(root, 'bin'), join(root, 'my tools')].join(':');
  assert.deepEqual(resolveClaudeLauncher({ configured: custom, pathValue }), { path: custom, source: 'configured', rejected: [] });
  assert.deepEqual(resolveClaudeLauncher({ configured: 'claude-nightly', pathValue }), { path: custom, source: 'configured', rejected: [] });
  // The default name, a name that resolves to nothing, a path that is gone: the ordinary lookup.
  for (const configured of ['claude', 'claude-missing', join(root, 'gone', 'claude'), '']) {
    assert.deepEqual(resolveClaudeLauncher({ configured, pathValue }), { path: onPath, source: 'path', rejected: [] }, configured);
  }
});

test('no Claude Code is an ordinary answer, with the sentence the panel shows its install help on', () => {
  const empty = join(scratch, 'empty bin');
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(resolveClaudeLauncher({ pathValue: empty }), { path: null, source: 'missing', rejected: [] });
  assert.deepEqual(resolveClaudeLauncher({ pathValue: '' }), { path: null, source: 'missing', rejected: [] });
  // What getClaudeBin() hands on when nothing was found, and nothing at all.
  for (const launcher of ['claude', null, '', '   ']) {
    const missing = resolveClaudeSdkExecutable({ launcher });
    assert.equal(missing.path, null);
    assert.equal(missing.source, 'missing');
    assert.equal(missing.reason, CLAUDE_NOT_INSTALLED);
  }
  assert.match(CLAUDE_NOT_INSTALLED, /Claude CLI not found/);
  assert.match(CLAUDE_NOT_INSTALLED, /installed separately from SynaBun/);
});

test('Windows: the native installer\'s claude.exe is used directly, PATH order kept', () => {
  const home = 'C:\\Users\\Jane Doe';
  const exe = `${home}\\.local\\bin\\claude.exe`;
  const disk = windowsDisk([exe, `${home}\\AppData\\Roaming\\npm\\claude.cmd`]);
  const pathValue = `C:\\Windows\\System32;${home}\\.local\\bin;${home}\\AppData\\Roaming\\npm`;
  const found = resolveClaudeLauncher({ platform: 'win32', pathValue, isLaunchable: disk.isLaunchable, exists: disk.exists });
  assert.deepEqual(found, { path: exe, source: 'path', rejected: [] });
  const sdk = resolveClaudeSdkExecutable({ launcher: found.path, platform: 'win32', exists: disk.exists, validate: disk.validate });
  assert.equal(sdk.path, exe);
  assert.equal(sdk.source, 'installed');
});

test('Windows: an npm command file is followed to the program it runs, spaces in the path and all', () => {
  const npm = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm';
  const program = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const disk = windowsDisk([`${npm}\\claude`, `${npm}\\claude.cmd`, `${npm}\\claude.ps1`, program]);
  const found = resolveClaudeLauncher({ platform: 'win32', pathValue: `C:\\Windows;${npm}`, isLaunchable: disk.isLaunchable, exists: disk.exists });
  // The launcher a shell runs is the command file, not the script Windows cannot start…
  assert.equal(found.path, `${npm}\\claude.cmd`);
  // …and the SDK, which spawns without a shell, gets the executable behind it.
  const sdk = resolveClaudeSdkExecutable({ launcher: found.path, platform: 'win32', exists: disk.exists, validate: disk.validate });
  assert.deepEqual(sdk, { path: program, source: 'installed', kind: 'native', reason: null, ignored: null, launcher: `${npm}\\claude.cmd` });
  assert.deepEqual(windowsClaudeTargets(`${npm}\\claude.cmd`), [program, `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`]);

  // An older release: the program is cli.js, which the SDK runs with Node.
  const script = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const older = windowsDisk([`${npm}\\claude.cmd`, script]);
  const viaScript = resolveClaudeSdkExecutable({ launcher: `${npm}\\claude.cmd`, platform: 'win32', exists: older.exists, validate: older.validate });
  assert.equal(viaScript.path, script);
  assert.equal(viaScript.kind, 'script');

  // A project-local .bin folder has the package one level up.
  const bin = 'D:\\work\\node_modules\\.bin';
  assert.ok(windowsClaudeTargets(`${bin}\\claude.cmd`).includes('D:\\work\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
});

test('Windows: a command file whose program cannot be found is explained, never handed to the SDK', () => {
  const launcher = 'C:\\tools\\claude.cmd';
  const disk = windowsDisk([launcher]);
  const sdk = resolveClaudeSdkExecutable({ launcher, platform: 'win32', exists: disk.exists, validate: disk.validate });
  assert.equal(sdk.path, null);
  assert.match(sdk.reason, /Claude Code was found at C:\\tools\\claude\.cmd, but not the program that command runs/);
  assert.match(sdk.reason, /sdkExecutable/);
  // The explicit override is the way out, and it is honoured.
  const real = 'D:\\Claude\\claude.exe';
  const withOverride = windowsDisk([launcher, real]);
  const fixed = resolveClaudeSdkExecutable({ launcher, sdkExecutable: real, platform: 'win32', exists: withOverride.exists, validate: withOverride.validate });
  assert.equal(fixed.path, real);
  assert.equal(fixed.source, 'override');
});

test('an override that cannot be used is named, and the installed Claude Code runs instead', { skip: !posix && 'POSIX executables' }, () => {
  const real = executable(join(scratch, 'override', 'bin', 'claude'));
  const result = resolveClaudeSdkExecutable({ launcher: real, sdkExecutable: 'claude' });
  assert.equal(result.path, real);
  assert.equal(result.source, 'installed');
  assert.match(result.ignored, /bare command name/);
  // With no installation either, the override's problem is still reported beside the missing tool.
  const neither = resolveClaudeSdkExecutable({ launcher: 'claude', sdkExecutable: '/nowhere/claude' });
  assert.equal(neither.path, null);
  assert.equal(neither.reason, CLAUDE_NOT_INSTALLED);
  assert.match(neither.ignored, /Not found/);
});

test('a shell-run command with a space in its path is quoted; a configured command line is left alone', () => {
  const file = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd';
  assert.equal(shellCommand(file, true), `"${file}"`);
  assert.equal(shellCommand(file, false), file, 'without a shell the path is one argument already');
  assert.equal(shellCommand('claude', true), 'claude');
  assert.equal(shellCommand(`"${file}"`, true), `"${file}"`, 'never quoted twice');
  // Codex's command may be a command line the user typed: only a file is one word.
  assert.equal(shellCommand('wsl codex', true, { isFile: () => false }), 'wsl codex');
  assert.equal(shellCommand('C:\\Program Files\\nodejs\\codex.cmd', true, { isFile: () => true }), '"C:\\Program Files\\nodejs\\codex.cmd"');
});

test('SYNABUN_TOOL_DISCOVERY=path keeps discovery to the PATH the process was given', () => {
  const before = { discovery: process.env.SYNABUN_TOOL_DISCOVERY, path: process.env.PATH };
  try {
    process.env.PATH = '/only/this:/and/this';
    process.env.SYNABUN_TOOL_DISCOVERY = 'path';
    assert.equal(getAugmentedPath(), '/only/this:/and/this');
    delete process.env.SYNABUN_TOOL_DISCOVERY;
    const augmented = getAugmentedPath().split(process.platform === 'win32' ? ';' : ':');
    assert.ok(augmented.includes('/only/this') && augmented.includes('/and/this'), 'the given PATH is always part of it');
  } finally {
    if (before.discovery === undefined) delete process.env.SYNABUN_TOOL_DISCOVERY; else process.env.SYNABUN_TOOL_DISCOVERY = before.discovery;
    process.env.PATH = before.path;
  }
});

test('the model probe of a Claude Code that is not installed answers an empty list and never throws', async () => {
  // Nothing by that name anywhere: the spawn fails, or a shell says "not found" and exits.
  assert.deepEqual(await queryClaudeCliModels(join(scratch, 'nowhere', 'claude'), { timeoutMs: 5000 }), []);
  assert.deepEqual(await queryClaudeCliModels('synabun-no-such-claude-command', { timeoutMs: 5000 }), []);
});

test('an older Claude Code than the SDK was built against is one line in the log; a newer one is nothing', async () => {
  clearClaudeModelCache();
  const lines = [];
  const older = await checkClaudeCliSkew('/x/claude-old', { log: line => lines.push(line), queryVersion: async () => '2.1.100', referenceVersion: () => '2.1.288' });
  assert.deepEqual(older, { discovered: '2.1.100', reference: '2.1.288', skewed: true, installedOlder: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /installed Claude Code is 2\.1\.100/);
  assert.match(lines[0], /Sessions run the installed one/);
  assert.doesNotMatch(lines[0], /bundled/i);

  const newer = await checkClaudeCliSkew('/x/claude-new', { log: line => lines.push(line), queryVersion: async () => '2.1.300', referenceVersion: () => '2.1.288' });
  assert.equal(newer.installedOlder, false);
  assert.equal(lines.length, 1, 'a newer installation is the ordinary state');
  // Nothing installed: nothing to compare, nothing to say.
  assert.equal(await checkClaudeCliSkew('claude', { log: line => lines.push(line), queryVersion: async () => null, referenceVersion: () => '2.1.288' }), null);
  assert.equal(lines.length, 1);
  clearClaudeModelCache();
});

test('a session title is asked of the user\'s Claude Code, and falls back to its own words without one', async () => {
  let options = null;
  const claudeQuery = ({ options: given }) => {
    options = given;
    return (async function* () { yield { type: 'result', subtype: 'success', result: '{"title":"FixLoginBug"}' }; })();
  };
  const titled = await generateSessionTitle({ provider: 'claude-code', prompt: 'fix the login bug' }, {
    claudeQuery, claudeExecutable: () => ({ path: '/home/u/.local/bin/claude' }),
  });
  assert.deepEqual(titled, { title: 'FixLoginBug', source: 'agent' });
  assert.equal(options.pathToClaudeCodeExecutable, '/home/u/.local/bin/claude');

  // No Claude Code, and the real SDK: it is not called at all.
  const logged = [];
  const fallback = await generateSessionTitle({ provider: 'claude-code', prompt: 'fix the login bug' }, {
    claudeExecutable: () => ({ path: null, reason: CLAUDE_NOT_INSTALLED }), log: line => logged.push(line),
  });
  assert.equal(fallback.source, 'fallback');
  assert.ok(fallback.title);
  assert.match(logged.join('\n'), /Claude CLI not found/);
});

test('server.js hands every Claude and Codex SDK call the user\'s executable, and looks in no .bin folder of its own', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // One resolver for the panel, the Assistant's brain, native loops and session titles.
  assert.match(source, /claudeExecutable: \(\) => getClaudeSdkExecutable\(\)/);
  assert.match(source, /claudeExecutable: getClaudeSdkExecutable\(\),/);
  assert.match(source, /claudeExecutable: getClaudeSdkExecutable,/);
  assert.match(source, /resolveClaudeSdkExecutable\(\{\s*launcher: getClaudeBin\(\),\s*sdkExecutable: _readClaudeSkinConfig\(\)\.sdkExecutable \|\| null,\s*isInsideSynabun,/);
  assert.match(source, /resolveClaudeLauncher\(\{ configured, isInsideSynabun \}\)/);
  // Codex: the trusted global installation, or a refusal; never the SDK's own search.
  assert.match(source, /codexPath: getNativeCodexBin\(\)/);
  // The old first choice, a `claude` in SynaBun's own node_modules/.bin, is gone, with the runtime it fell back to.
  assert.doesNotMatch(source, /'node_modules', '\.bin', 'claude'/);
  assert.doesNotMatch(source, /alignedClaudeExecutable|claudeRuntime|alignedClaudeBin/);
  // What ended up in node_modules anyway is removed at start, by the shared list.
  assert.match(source, /pruneExternalTools\(root\)/);
  // A tool that was not found is looked for again: installing it must not take a restart.
  assert.match(source, /_claudeBinPath !== 'claude'\) return _claudeBinPath;\s*if \(_claudeBinPath && Date\.now\(\) - _claudeBinMissingAt < MISSING_TOOL_RECHECK_MS\)/);
  assert.match(source, /_codexBinSource !== 'missing' \|\| Date\.now\(\) - _codexBinMissingAt < MISSING_TOOL_RECHECK_MS/);
  // A packaged application counts in full as "inside SynaBun": its own Node and npm too.
  assert.match(source, /PACKAGED_RUNTIME\?\.resources/);
});
