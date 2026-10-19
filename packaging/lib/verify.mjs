/**
 * Checks on a finished bundle, before it is turned into an artifact.
 *
 *   audit   read-only: the files a start needs are there (the window, its
 *           code, the payload beside it, the headless entry), every native
 *           binary is for the target's processor, the executables may run,
 *           nothing private came along, and none of the tools the user
 *           installs separately (Claude Code, Codex, OpenCode, Gemini CLI). One
 *           program of somebody else's has to be there: cloudflared, the pinned
 *           build for the target, in its one place. A Windows bundle carries
 *           Git for Windows too (the Git Bash Claude Code needs there), the
 *           pinned tree file for file; no other bundle carries it.
 *   smoke   runs the bundle on the build machine, in a throwaway home, on a
 *           port nothing uses: its version, its native modules (a real PTY, the
 *           embedding runtime), its cloudflared (found by the application
 *           itself, and asked for its version), an MCP conversation over
 *           stdio, and (macOS, Windows) the window executable handing a
 *           command line call to the headless entry, as it does for a
 *           registration an older build wrote.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { basename, dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalToolPayloadReason, externalToolsInLock } from '../../lib/external-tools.js';
import { bundledNpmrc } from '../../lib/packaged-runtime.js';
import { npmRootIn, npmWrapperScript, WINDOWS_NPM_SHIMS } from './bundle.mjs';
import { elfSymbols, unmetImports } from './cross.mjs';
import { gitBashModulesOf } from './git-bash.mjs';
import { findPrivatePaths } from './stage.mjs';
import { BuildError, FORMAT_PLATFORM, nativeFormat, note, run, step, walk } from './util.mjs';

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** A file that goes by cloudflared's name: `cloudflared`, `cloudflared.exe`, a release file such as `cloudflared-linux-amd64`. */
const CLOUDFLARED_NAME = /^cloudflared(?:[-_.][\w.-]*)?$/i;

/**
 * What the application inside a bundle says about its cloudflared: the pins it will check its copy against
 * (neural-interface/lib/cloudflared/pins.json, read by the application's own reader), the pin of this target,
 * and where it will look for the copy that came with it. `error` when the bundle cannot say.
 */
async function cloudflaredOf({ app, resources, platform, arch }) {
  const lib = join(app, 'neural-interface', 'lib', 'cloudflared');
  try {
    const knows = await import(pathToFileURL(join(lib, 'pins.js')).href);
    const { hashFile } = await import(pathToFileURL(join(lib, 'install.js')).href);
    const pins = knows.readCloudflaredPins(join(lib, 'pins.json'));
    return { pin: knows.cloudflaredPinFor(pins, platform, arch), path: knows.bundledCloudflaredPath(resources, platform), hashFile, error: null };
  } catch (error) {
    return { pin: null, path: null, hashFile: null, error: String(error?.message || error).split('\n')[0] };
  }
}

/**
 * What the application inside a bundle says about its Git for Windows (neural-interface/lib/git-bash/): the pin of
 * this target (Windows only), and the application's own readers and checks. `error` when the bundle cannot say.
 */
async function gitBashOf({ app, platform, arch }) {
  try {
    const { pins, pinsModule, install } = await gitBashModulesOf(app);
    return { pin: pinsModule.gitBashPinFor(pins, platform, arch), added: pinsModule.ADDED_FILES, install, error: null };
  } catch (error) {
    return { pin: null, added: [], install: null, error: String(error?.message || error).split('\n')[0] };
  }
}

/** What Node.js's own Windows command files must start: the node.exe beside them and npm's scripts beside it. */
const WINDOWS_SHIM_MARKS = Object.freeze({
  'npm.cmd': ['%~dp0\\node.exe', 'node_modules\\npm\\bin\\npm-cli.js'],
  'npx.cmd': ['%~dp0\\node.exe', 'node_modules\\npm\\bin\\npx-cli.js'],
  'npm.ps1': ['$PSScriptRoot/node.exe', 'node_modules/npm/bin/npm-cli.js'],
  'npx.ps1': ['$PSScriptRoot/node.exe', 'node_modules/npm/bin/npx-cli.js'],
  npm: ['node_modules/npm/bin/npm-cli.js'],
  npx: ['node_modules/npm/bin/npx-cli.js'],
});

/**
 * npm and npx of the bundled runtime, which features run on a machine without a Node of their own: npm's files, the
 * commands that start them (Node's own command files and shims on Windows, the wrappers bundle.mjs writes elsewhere),
 * and npm's builtin settings, which send `npm i -g` to a per-user folder instead of the read-only application. When
 * this machine runs the target's Node (`runnable`), `npm --version` and `npx --version` are run with that runtime
 * alone: no Node on PATH, a throwaway home and cache. Returns { problems, npm: { version, prefix, ran } }; reads only.
 */
export function auditBundledNpm({ resources, platform, runnable = false, home, run: runCommand = run }) {
  const problems = [];
  const windows = platform === 'win32';
  const runtime = join(resources, 'runtime');
  const npmRoot = join(runtime, npmRootIn(platform));
  const shown = (path) => path.slice(resources.length + 1).replace(/\\/g, '/');
  let version = null;
  try { version = JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')).version || null; } catch {}
  if (!version) problems.push(`npm: ${shown(join(npmRoot, 'package.json'))} is missing or names no version`);
  for (const file of ['npm-cli.js', 'npx-cli.js', ...(windows ? ['npm-prefix.js'] : [])]) {
    if (!existsSync(join(npmRoot, 'bin', file))) problems.push(`missing: ${shown(join(npmRoot, 'bin', file))}`);
  }
  let npmrc = null;
  try { npmrc = readFileSync(join(npmRoot, 'npmrc'), 'utf8'); } catch {}
  if (npmrc !== bundledNpmrc(platform)) {
    problems.push(`npm: ${shown(join(npmRoot, 'npmrc'))} ${npmrc === null ? 'is missing' : 'says something else'}: npm i -g would write into the application (expected "${bundledNpmrc(platform).trim()}")`);
  }
  const commands = windows ? WINDOWS_NPM_SHIMS.map(name => join(runtime, name)) : ['npm', 'npx'].map(tool => join(runtime, 'bin', tool));
  for (const file of commands) {
    let info = null;
    try { info = lstatSync(file); } catch {}
    if (!info) { problems.push(`missing: ${shown(file)}`); continue; }
    if (!info.isFile()) { problems.push(`npm: ${shown(file)} is not a plain file`); continue; }
    const text = readFileSync(file, 'utf8');
    if (windows) {
      const marks = WINDOWS_SHIM_MARKS[basename(file)] || [];
      for (const mark of marks) if (!text.includes(mark)) problems.push(`npm: ${shown(file)} does not start ${mark}`);
    } else {
      const tool = basename(file);
      if (text !== npmWrapperScript(tool)) problems.push(`npm: ${shown(file)} is not the wrapper that runs ${tool} with the Node beside it`);
      if (!executable(file)) problems.push(`not executable: ${shown(file)}`);
    }
  }
  let ran = null;
  if (runnable && version && !problems.length) {
    ran = {};
    if (!home) home = mkdtempSync(join(tmpdir(), 'synabun-npm-check-'));
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, 'tmp'), { recursive: true });
    const env = windows
      ? {
        USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'),
        PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
        ...Object.fromEntries(['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT'].filter(name => process.env[name]).map(name => [name, process.env[name]])),
      }
      : { HOME: home, TMPDIR: join(home, 'tmp'), PATH: '/usr/bin:/bin' };
    Object.assign(env, { npm_config_update_notifier: 'false', npm_config_cache: join(home, 'npm-cache') });
    for (const tool of ['npm', 'npx']) {
      // Windows: the command file, through cmd.exe as a terminal starts it; cmd /s /c strips one pair of quotes.
      const result = windows
        ? runCommand(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${join(runtime, `${tool}.cmd`)}" --version"`], { verbatim: true, capture: true, allowFailure: true, env, cwd: home, timeoutMs: 120000 })
        : runCommand(join(runtime, 'bin', tool), ['--version'], { capture: true, allowFailure: true, env, cwd: home, timeoutMs: 120000 });
      const said = String(result.stdout || '').trim();
      ran[tool] = said;
      if (!result.ok || said !== version) {
        const why = said || String(result.stderr || '').trim().split('\n').pop() || (result.error ? result.error.message : `exit ${result.status}`);
        problems.push(`npm: ${tool} --version with the bundled runtime alone said "${why}", not ${version}`);
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
  return { problems, npm: { version, prefix: bundledNpmrc(platform).trim().replace(/^prefix=/, ''), ran } };
}

/** Inspect ctx.bundle without running it. Throws a BuildError that lists every problem found. */
export async function auditBundle(ctx) {
  step('Audit the bundle');
  const { platform, arch } = ctx.target;
  const { root, resources, entry } = ctx.bundle;
  const app = join(resources, 'app');
  const problems = [];
  const windows = platform === 'win32';

  const required = [
    'synabun-package.json', 'bootstrap.mjs', 'synabun-shell', 'app-update.yml', 'app.asar',
    'app/package.json', 'app/setup.js', 'app/launcher.mjs', 'app/lib/packaged-runtime.js', 'app/lib/start-launcher.js',
    'app/neural-interface/server.js', 'app/mcp-server/run.mjs', 'app/mcp-server/dist/index.js', 'app/mcp-server/dist/preload.js',
    // The tunnel: what says which cloudflared this build carries, and what finds and checks it at run time.
    'app/neural-interface/lib/cloudflared/pins.json', 'app/neural-interface/lib/cloudflared/manager.js',
    // setup.js reads these to know the dependencies are installed.
    'app/mcp-server/node_modules/.package-lock.json', 'app/neural-interface/node_modules/.package-lock.json',
    windows ? 'runtime/node.exe' : 'runtime/bin/node',
    windows ? 'runtime/node_modules/npm/bin/npm-cli.js' : 'runtime/lib/node_modules/npm/bin/npm-cli.js',
  ];
  for (const file of required) if (!existsSync(join(resources, file))) problems.push(`missing: ${file}`);
  // npm and npx, which features run on a machine without Node: there, set up, and (where the target's Node runs here)
  // answering with the bundled runtime alone.
  const npmAudit = auditBundledNpm({ resources, platform, runnable: !ctx.cross, home: ctx.work ? join(ctx.work, 'npm-check-home') : null, run: ctx.runCommand });
  problems.push(...npmAudit.problems);
  // Electron's demo app: with it, an app whose app.asar went missing would open the demo instead of failing.
  if (existsSync(join(resources, 'default_app.asar'))) problems.push('Electron\'s default_app.asar is still in the app');
  if (!existsSync(entry)) problems.push(`missing: the entry executable ${entry}`);
  if (ctx.bundle.window && !existsSync(ctx.bundle.window)) problems.push(`missing: the window executable ${ctx.bundle.window}`);
  // The entry opens the window it names, relative to the payload.
  try {
    const named = readFileSync(join(resources, 'synabun-shell'), 'utf8').trim();
    if (ctx.bundle.window && join(resources, named) !== ctx.bundle.window) problems.push(`synabun-shell names ${named}, not the window executable`);
  } catch { /* reported as missing above */ }

  // The native modules a start loads, by the rule each one is found by.
  const neural = join(app, 'neural-interface', 'node_modules');
  const natives = [];
  const need = (label, path) => {
    const format = existsSync(path) ? nativeFormat(path) : null;
    natives.push({ label, path: path.slice(root.length + 1), found: !!format, archs: format?.archs || [] });
    if (!format) problems.push(`missing native module: ${label} (${path.slice(root.length + 1)})`);
  };
  for (const owner of ['mcp-server', 'neural-interface']) {
    need(`onnxruntime-node (${owner})`, join(app, owner, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', platform, arch, 'onnxruntime_binding.node'));
  }
  const ptyPrebuilt = join(neural, 'node-pty', 'prebuilds', `${platform}-${arch}`, 'pty.node');
  const ptyBuilt = join(neural, 'node-pty', 'build', 'Release', 'pty.node');
  need('node-pty', existsSync(ptyPrebuilt) ? ptyPrebuilt : ptyBuilt);

  // What was compiled on another system was never loaded: read back what it
  // asks of the target, and of the Node that will load it.
  if (ctx.cross && platform === 'linux') {
    const compiled = [['the native entry', entry, []]];
    if (!existsSync(ptyPrebuilt) && existsSync(ptyBuilt)) compiled.push(['node-pty', ptyBuilt, [elfSymbols(join(resources, 'runtime', 'bin', 'node'))]]);
    for (const [label, path, providers] of compiled) {
      if (!existsSync(path)) continue;
      const unmet = unmetImports(elfSymbols(path), { glibc: ctx.target.cross.glibc, providers });
      for (const problem of unmet) problems.push(`${label}: ${problem}`);
      if (!unmet.length) note(`${label}: asks only for glibc ${ctx.target.cross.glibc} or older${providers.length ? ' and what the bundled Node provides' : ''}`);
    }
  }

  // cloudflared (the tunnel behind invite links and remote MCP) is the one program of somebody else's a bundle
  // carries: exactly the build the application's own pins name for this target, where the application looks
  // for it, and no other cloudflared anywhere.
  const tunnel = await cloudflaredOf({ app, resources, platform, arch });
  const otherCloudflareds = [];
  // Git for Windows (the Git Bash Claude Code needs on Windows): checked as one pinned tree below, so its own
  // files (.NET assemblies built for any processor, MSYS2's 32-bit signal helper) are not judged one by one.
  const gitFolder = join(resources, 'git');
  const inGit = (path) => windows && path.startsWith(gitFolder + sep);

  // Every native binary in the bundle: right processor, or not for this system at all.
  let files = 0;
  let bytes = 0;
  const foreign = [];
  const relatives = [];
  // Claude Code, Codex, OpenCode and Gemini CLI are the user's own installations:
  // a package of one, its command, or its executable under any name it goes by
  // has no place in an application, whatever brought it.
  const external = new Map();
  for (const file of walk(root)) {
    files++;
    const packaged = externalToolPayloadReason(file.relative);
    if (packaged) external.set(packaged, (external.get(packaged) || 0) + 1);
    if (file.link) continue;
    try { bytes += statSync(file.path).size; } catch {}
    if (file.path.startsWith(app) && !file.relative.includes('/node_modules/')) relatives.push(file.path.slice(app.length + 1).replace(/\\/g, '/'));
    const format = nativeFormat(file.path);
    if (!format) continue;
    if (!packaged) {
      const executable = externalToolPayloadReason(file.relative, { native: true });
      if (executable) external.set(`${executable} (${file.relative})`, 1);
    }
    if (file.path !== tunnel.path && CLOUDFLARED_NAME.test(basename(file.relative))) otherCloudflareds.push(file.relative);
    if (FORMAT_PLATFORM[format.format] !== platform) foreign.push(file.relative);
    else if (!format.archs.includes(arch) && !inGit(file.path)) problems.push(`wrong processor: ${file.relative} is ${format.archs.join('+')}, this is a ${arch} build`);
  }

  // The bundled cloudflared: there, a program of this target, and the pinned one byte for byte.
  let cloudflared = null;
  if (tunnel.error) {
    problems.push(`cloudflared: the application does not say which one it uses (${tunnel.error})`);
  } else if (!tunnel.pin) {
    problems.push(`cloudflared: none is pinned for ${platform}-${arch} (neural-interface/lib/cloudflared/pins.json)`);
  } else {
    const place = tunnel.path.slice(root.length + 1);
    const format = existsSync(tunnel.path) ? nativeFormat(tunnel.path) : null;
    if (!existsSync(tunnel.path)) {
      problems.push(`missing: cloudflared ${tunnel.pin.version}, the tunnel program (${place})`);
    } else if (!format) {
      problems.push(`cloudflared: ${place} is not a program`);
    } else if (FORMAT_PLATFORM[format.format] !== platform || !format.archs.includes(arch)) {
      problems.push(`cloudflared: ${place} is a ${FORMAT_PLATFORM[format.format]} ${format.archs.join('+')} program; this is a ${platform}-${arch} build`);
    } else {
      const actual = await tunnel.hashFile(tunnel.path);
      if (actual.sha256 !== tunnel.pin.binary.sha256) problems.push(`cloudflared: ${place} is not the pinned cloudflared ${tunnel.pin.version} (sha256 ${actual.sha256}, pinned ${tunnel.pin.binary.sha256})`);
      else cloudflared = { path: place, version: tunnel.pin.version, sha256: actual.sha256, size: actual.size, file: tunnel.pin.file };
    }
    let beside = [];
    try { beside = readdirSync(dirname(tunnel.path)).filter(name => name !== basename(tunnel.path)); } catch { /* no such folder: reported above */ }
    for (const name of beside) problems.push(`cloudflared: an unexpected file beside it (${dirname(place)}/${name})`);
    for (const other of otherCloudflareds) problems.push(`cloudflared: another one in the bundle (${other}). Only the pinned one is packaged, at ${place}.`);
  }

  // Git for Windows: in a Windows bundle the pinned tree, file for file, with its license and source; in no other.
  let gitBash = null;
  const gitPlace = gitFolder.slice(root.length + 1);
  if (windows) {
    const git = await gitBashOf({ app, platform, arch });
    if (git.error) {
      problems.push(`Git for Windows: the application does not say which one it uses (${git.error})`);
    } else if (!git.pin) {
      problems.push(`Git for Windows: none is pinned for ${platform}-${arch} (neural-interface/lib/git-bash/pins.json)`);
    } else if (!existsSync(gitFolder)) {
      problems.push(`missing: Git for Windows ${git.pin.version}, the Git Bash Claude Code needs (${gitPlace})`);
    } else {
      const marker = git.install.readMarker(gitFolder);
      if (!marker || marker.version !== git.pin.version || marker.sha256 !== git.pin.sha256 || marker.tree?.sha256 !== git.pin.tree.sha256) problems.push(`Git for Windows: ${gitPlace}/synabun-git.json does not name the pinned release`);
      for (const name of git.added) if (!existsSync(join(gitFolder, name))) problems.push(`Git for Windows: ${gitPlace}/${name} is missing (its license and source ship with it)`);
      let digest = null;
      try { digest = git.install.treeDigest(gitFolder); } catch (error) { problems.push(`Git for Windows: ${error.message}`); }
      const wrong = digest ? git.install.treeMismatch(digest, git.pin) : null;
      if (wrong) problems.push(`Git for Windows: ${gitPlace} is not the pinned tree of ${git.pin.version} (${wrong})`);
      const key = git.install.keyFilesMismatch(gitFolder, git.pin, { platform: process.platform });
      if (key) problems.push(`Git for Windows: ${key}`);
      for (const rel of [git.pin.bash, git.pin.git]) {
        const format = nativeFormat(join(gitFolder, ...rel.split('/')));
        if (FORMAT_PLATFORM[format?.format] !== 'win32' || !format.archs.includes(arch)) problems.push(`Git for Windows: ${gitPlace}/${rel} is not a ${arch} Windows program`);
      }
      if (digest && !wrong && !key) gitBash = { path: gitPlace, version: git.pin.version, tag: git.pin.tag, files: digest.files, bytes: digest.bytes, sha256: digest.sha256 };
    }
  } else if (existsSync(gitFolder)) {
    problems.push(`Git for Windows in a ${platform} bundle (${gitPlace}): only the Windows installer carries it`);
  }

  if (!windows) {
    const { vendoredBinaryTargets } = await import(pathToFileURL(join(app, 'neural-interface', 'lib', 'native-binary-runtime.js')).href);
    const mustRun = [entry, join(resources, 'runtime', 'bin', 'node'), ...vendoredBinaryTargets({ root: join(app, 'neural-interface'), platform }).map(target => target.path)];
    if (ctx.bundle.window) mustRun.push(ctx.bundle.window);
    if (tunnel.path && existsSync(tunnel.path)) mustRun.push(tunnel.path);
    for (const path of mustRun) if (!executable(path)) problems.push(`not executable: ${path.slice(root.length + 1)}`);
  }

  for (const item of findPrivatePaths(relatives)) problems.push(`private file in the bundle: ${item.path} (${item.reason})`);

  for (const [reason, count] of external) problems.push(`external tool in the bundle: ${reason}${count > 1 ? `, ${count} files` : ''}. It is installed by the user, never packaged.`);
  // What npm would install again from inside the application, and what it says it installed.
  const lockfiles = ['mcp-server/package-lock.json', 'neural-interface/package-lock.json', 'mcp-server/node_modules/.package-lock.json', 'neural-interface/node_modules/.package-lock.json'];
  for (const relative of lockfiles) {
    let locked;
    try { locked = externalToolsInLock(JSON.parse(readFileSync(join(app, relative), 'utf8'))); } catch { continue; }
    for (const item of locked.packages) problems.push(`external tool in a lockfile of the bundle: ${relative} names ${item.path}`);
    for (const edge of locked.edges) problems.push(`external tool in a lockfile of the bundle: ${relative} has ${edge.from} depend on ${edge.name}`);
  }

  ctx.report.audit = { files, bytes, natives, foreignBinaries: foreign.length, externalTools: { found: external.size, lockfilesRead: lockfiles.length }, cloudflared, gitBash, npm: npmAudit.npm };
  if (foreign.length) note(`${foreign.length} binaries for other systems remain inside third-party packages (never loaded here)`);
  if (problems.length) throw new BuildError(`The bundle failed its audit (${problems.length} problem${problems.length === 1 ? '' : 's'}). No artifact was created.`, { details: problems.slice(0, 40) });
  note(`${files} files, ${(bytes / 1024 / 1024).toFixed(0)} MB, ${natives.length} native modules for ${platform}-${arch}, no external tool, cloudflared ${cloudflared.version} (the pinned binary)${gitBash ? `, Git for Windows ${gitBash.version} (the pinned tree, ${gitBash.files} files)` : ''}`);
  note(`npm and npx ${npmAudit.npm.version}: ${npmAudit.npm.ran ? `npm --version and npx --version answer ${npmAudit.npm.ran.npm} with the bundled runtime alone` : 'files and shims checked (this machine cannot run the target\'s Node)'}; global installs go to ${npmAudit.npm.prefix}`);
}

/** Every file of a bundle with its size and modification time: what "unchanged" is compared against. */
export function fingerprint(root) {
  const seen = new Map();
  for (const file of walk(root)) {
    try { const info = lstatSync(file.path); seen.set(file.relative, `${info.size}:${info.mtimeMs}`); } catch {}
  }
  return seen;
}

/** Paths added, removed or rewritten between two fingerprints. */
export function fingerprintChanges(before, after) {
  const changed = [];
  for (const [path, mark] of after) if (before.get(path) !== mark) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed.sort();
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/**
 * The environment a smoke run gets: a home of its own, a data home of its own,
 * a port nothing listens on, no registration with the operating system, no
 * browser, no paid API. Nothing of the build machine's user is reachable, its
 * Claude Code, Codex, OpenCode and Gemini CLI included (SYNABUN_TOOL_DISCOVERY
 * keeps the search to the PATH below): the run is a first start on a machine
 * that has none of them.
 */
export async function smokeEnv(home) {
  const port = await freePort();
  mkdirSync(home, { recursive: true });
  const windows = process.platform === 'win32';
  const env = {
    HOME: home,
    SYNABUN_DATA_HOME: join(home, 'synabun-data'),
    MEMORY_DATA_DIR: join(home, 'synabun-data', 'mcp-data'),
    NEURAL_PORT: String(port),
    NEURAL_INTERFACE_URL: `http://127.0.0.1:${port}`,
    SYNABUN_NI_URL: `http://127.0.0.1:${port}`,
    SQLITE_DB_PATH: join(home, 'synabun-data', 'mcp-data', 'memory.db'),
    SYNABUN_LAUNCHER_REGISTER: '0',
    SYNABUN_OPEN_BROWSER: '0',
    SYNABUN_LAUNCH_ENV: 'resolved',
    SYNABUN_TYPESAFE: 'off',
    SYNABUN_TOOL_DISCOVERY: 'path',
    PATH: windows ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(';') : '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: join(home, 'tmp'),
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  if (windows) {
    Object.assign(env, { USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: env.TMPDIR, TMP: env.TMPDIR });
    for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

/**
 * Speak MCP to `<entry> mcp` over stdio: initialize, then list the tools.
 * Every line on stdout has to be a JSON-RPC message; anything else there would
 * break a client. Resolves { serverInfo, tools } or rejects with what went wrong.
 */
export function mcpHandshake(entry, { env, cwd, timeoutMs = 120000, args = ['mcp'] } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(entry, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    let errors = '';
    let serverInfo = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      if (error) fail(Object.assign(error, { stderr: errors.slice(-2000) })); else done(value);
    };
    const timer = setTimeout(() => finish(new Error(`no MCP answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

    child.on('error', error => finish(error));
    child.on('exit', (code, signal) => finish(new Error(`the MCP server ended early (${signal || `exit ${code}`})`)));
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error(`stdout carried something that is not MCP: ${line.slice(0, 200)}`)); }
        if (message?.jsonrpc !== '2.0') return finish(new Error(`stdout carried something that is not MCP: ${line.slice(0, 200)}`));
        if (message.id === 1) {
          if (!message.result?.serverInfo) return finish(new Error(`initialize was refused: ${line.slice(0, 300)}`));
          serverInfo = message.result.serverInfo;
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          const tools = message.result?.tools;
          if (!Array.isArray(tools) || !tools.length) return finish(new Error('the MCP server listed no tools'));
          return finish(null, { serverInfo, tools: tools.map(tool => tool.name) });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synabun-packaging-check', version: '1' } } });
  });
}

/** Run the bundle for real, isolated. Throws a BuildError when anything is off. */
export async function smokeTest(ctx) {
  step('Run the bundle (isolated home, unused port)');
  const { entry, root } = ctx.bundle;
  const home = join(ctx.work, 'smoke-home');
  const env = await smokeEnv(home);
  const before = fingerprint(root);

  const version = run(entry, ['version'], { capture: true, env, cwd: home, label: 'entry version' });
  if (!version.stdout.includes(`synabun v${ctx.version}`)) throw new BuildError(`The entry reported "${version.stdout.trim()}", not synabun v${ctx.version}.`);
  note(version.stdout.trim());

  const diagnosed = run(entry, ['diagnostics', '--json', '--natives'], { capture: true, env, cwd: home, allowFailure: true, label: 'entry diagnostics' });
  let facts;
  try { facts = JSON.parse(diagnosed.stdout); } catch { throw new BuildError('The entry did not report its diagnostics', { details: [diagnosed.stdout.slice(-600), diagnosed.stderr.slice(-600)] }); }
  const wrong = [];
  if (facts.node?.version !== `v${ctx.runtime.version}`) wrong.push(`runs Node ${facts.node?.version}, not the bundled v${ctx.runtime.version}`);
  if (facts.node?.arch !== ctx.target.arch || facts.node?.platform !== ctx.target.platform) wrong.push(`runs as ${facts.node?.platform}-${facts.node?.arch}`);
  if (!String(facts.node?.path || '').startsWith(facts.resources)) wrong.push(`runs a Node outside the bundle: ${facts.node?.path}`);
  if (!String(facts.dataHome || '').startsWith(home)) wrong.push(`data home is ${facts.dataHome}, outside the isolated home`);
  if (facts.embeddingModel !== ctx.report.embeddingModel) wrong.push(`embedding model is ${facts.embeddingModel}, expected ${ctx.report.embeddingModel}`);
  for (const [name, result] of Object.entries(facts.natives || {})) if (!result.ok) wrong.push(`${name}: ${result.error || 'failed'}`);
  if (!facts.natives) wrong.push('the native modules were not probed');
  if (wrong.length) throw new BuildError('The bundle does not run correctly on this machine. No artifact was created.', { details: wrong });
  note(`Node ${facts.node.version} ${facts.node.platform}-${facts.node.arch} from the bundle; terminal and embedding runtime load, no external tool inside${facts.natives.cloudflared?.ok ? `, its own cloudflared ${facts.natives.cloudflared.version} answers` : ''}`);

  let mcp;
  try {
    mcp = await mcpHandshake(entry, { env, cwd: home });
  } catch (error) {
    throw new BuildError(`MCP over stdio failed: ${error.message}`, { details: String(error.stderr || '').trim().split('\n').slice(-12) });
  }
  note(`MCP over stdio: ${mcp.serverInfo.name} ${mcp.serverInfo.version || ''}, ${mcp.tools.length} tools, nothing else on stdout`);

  // Git for Windows (a Windows bundle): the Git Bash a Claude Code gets on a PC without one has to start, and so
  // does the git SynaBun's own git features fall back to.
  if (ctx.bundle.gitBash && ctx.gitBash?.pin) {
    const { pin } = ctx.gitBash;
    const bash = run(join(ctx.bundle.gitBash, ...pin.bash.split('/')), ['--noprofile', '--norc', '-c', 'echo synabun-git-bash'], { capture: true, env, cwd: home, allowFailure: true, timeoutMs: 120000, label: 'Git Bash' });
    const git = run(join(ctx.bundle.gitBash, ...pin.git.split('/')), ['--version'], { capture: true, env, cwd: home, allowFailure: true, timeoutMs: 120000, label: 'git --version' });
    if (!bash.ok || !bash.stdout.includes('synabun-git-bash') || !git.ok || !/git version/.test(git.stdout)) {
      throw new BuildError('The bundled Git for Windows does not start.', { details: [`bash: exit ${bash.status} ${bash.stdout.trim()} ${bash.stderr.trim()}`.slice(0, 400), `git: exit ${git.status} ${git.stdout.trim()} ${git.stderr.trim()}`.slice(0, 400)] });
    }
    note(`the bundled Git Bash starts; ${git.stdout.trim()}`);
  }

  // The window executable is not a command line tool: an older registration that names it is handed to the
  // headless entry (packaging/desktop/src/cli.mjs), stdio and exit code untouched, and no window opens.
  if (ctx.bundle.window && ctx.target.platform !== 'linux') {
    const delegated = run(ctx.bundle.window, ['version'], { capture: true, env: { ...env, CFFIXED_USER_HOME: home }, cwd: home, allowFailure: true, timeoutMs: 120000, label: 'window executable version' });
    if (!delegated.ok || !delegated.stdout.includes(`synabun v${ctx.version}`)) {
      throw new BuildError('The window executable did not hand a command line call to the headless entry.', { details: [delegated.stdout.slice(-400), delegated.stderr.slice(-400), `exit ${delegated.status}`] });
    }
    note(`the window executable hands "version" to the headless entry: ${delegated.stdout.trim()}`);
  }

  // A signed bundle and a read-only image cannot be written to: running must leave every file as it was.
  const touched = fingerprintChanges(before, fingerprint(root));
  if (touched.length) throw new BuildError('Running the application changed files inside its own bundle. No artifact was created.', { details: touched.slice(0, 30) });
  note('nothing inside the bundle was written to');
  ctx.report.smoke = { version: version.stdout.trim(), node: facts.node, natives: facts.natives, mcp: { serverInfo: mcp.serverInfo, tools: mcp.tools.length } };
}
