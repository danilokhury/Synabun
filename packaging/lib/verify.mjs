/**
 * Checks on a finished bundle, before it is turned into an artifact.
 *
 *   audit   read-only: the files a start needs are there, every native binary
 *           is for the target's processor, the executables may run, nothing
 *           private came along, and none of the tools the user installs
 *           separately (Claude Code, Codex, OpenCode, Gemini CLI).
 *   smoke   runs the bundle on the build machine, in a throwaway home, on a
 *           port nothing uses: its version, its native modules (a real PTY, the
 *           embedding runtime) and an MCP conversation over stdio.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalToolPayloadReason, externalToolsInLock } from '../../lib/external-tools.js';
import { elfSymbols, unmetImports } from './cross.mjs';
import { findPrivatePaths } from './stage.mjs';
import { BuildError, FORMAT_PLATFORM, nativeFormat, note, run, step, walk } from './util.mjs';

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
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
    'synabun-package.json', 'bootstrap.mjs',
    'app/package.json', 'app/setup.js', 'app/launcher.mjs', 'app/lib/packaged-runtime.js', 'app/lib/start-launcher.js',
    'app/neural-interface/server.js', 'app/mcp-server/run.mjs', 'app/mcp-server/dist/index.js', 'app/mcp-server/dist/preload.js',
    // setup.js reads these to know the dependencies are installed.
    'app/mcp-server/node_modules/.package-lock.json', 'app/neural-interface/node_modules/.package-lock.json',
    windows ? 'runtime/node.exe' : 'runtime/bin/node',
    windows ? 'runtime/node_modules/npm/bin/npm-cli.js' : 'runtime/lib/node_modules/npm/bin/npm-cli.js',
  ];
  for (const file of required) if (!existsSync(join(resources, file))) problems.push(`missing: ${file}`);
  if (!existsSync(entry)) problems.push(`missing: the entry executable ${entry}`);

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
    if (FORMAT_PLATFORM[format.format] !== platform) foreign.push(file.relative);
    else if (!format.archs.includes(arch)) problems.push(`wrong processor: ${file.relative} is ${format.archs.join('+')}, this is a ${arch} build`);
  }

  if (!windows) {
    const { vendoredBinaryTargets } = await import(pathToFileURL(join(app, 'neural-interface', 'lib', 'native-binary-runtime.js')).href);
    const mustRun = [entry, join(resources, 'runtime', 'bin', 'node'), ...vendoredBinaryTargets({ root: join(app, 'neural-interface'), platform }).map(target => target.path)];
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

  ctx.report.audit = { files, bytes, natives, foreignBinaries: foreign.length, externalTools: { found: external.size, lockfilesRead: lockfiles.length } };
  if (foreign.length) note(`${foreign.length} binaries for other systems remain inside third-party packages (never loaded here)`);
  if (problems.length) throw new BuildError(`The bundle failed its audit (${problems.length} problem${problems.length === 1 ? '' : 's'}). No artifact was created.`, { details: problems.slice(0, 40) });
  note(`${files} files, ${(bytes / 1024 / 1024).toFixed(0)} MB, ${natives.length} native modules for ${platform}-${arch}, no external tool`);
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
  note(`Node ${facts.node.version} ${facts.node.platform}-${facts.node.arch} from the bundle; terminal and embedding runtime load, no external tool inside`);

  let mcp;
  try {
    mcp = await mcpHandshake(entry, { env, cwd: home });
  } catch (error) {
    throw new BuildError(`MCP over stdio failed: ${error.message}`, { details: String(error.stderr || '').trim().split('\n').slice(-12) });
  }
  note(`MCP over stdio: ${mcp.serverInfo.name} ${mcp.serverInfo.version || ''}, ${mcp.tools.length} tools, nothing else on stdout`);

  // A signed bundle and a read-only image cannot be written to: running must leave every file as it was.
  const touched = fingerprintChanges(before, fingerprint(root));
  if (touched.length) throw new BuildError('Running the application changed files inside its own bundle. No artifact was created.', { details: touched.slice(0, 30) });
  note('nothing inside the bundle was written to');
  ctx.report.smoke = { version: version.stdout.trim(), node: facts.node, natives: facts.natives, mcp: { serverInfo: mcp.serverInfo, tools: mcp.tools.length } };
}
