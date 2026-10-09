/**
 * SynaBun — packaged runtime bootstrap
 *
 * What the native entry runs, with the bundled Node, for everything except
 * `mcp` (which it starts directly, so nothing stands between an IDE and the
 * MCP server's stdio). The builder copies this file to <resources>/bootstrap.mjs,
 * next to the application in <resources>/app.
 *
 *   SynaBun                 start from the desktop: opens the installed PWA when a server
 *                           already answers, otherwise starts one in the background
 *   SynaBun start           the supervisor (setup.js) in the foreground, nothing else
 *   SynaBun launcher ...    the synabun:// handler (lib/start-launcher.js)
 *   SynaBun diagnostics     what this build is and where it keeps things
 *   SynaBun claude-hook <s> one Claude Code hook handler, for the command the
 *                           application registers (lib/claude-hooks.js); silent
 *   SynaBun <anything else> the usual CLI: version, doctor, profile, migrate-data ...
 *
 * It decides nothing about the application. It gives the existing entry points
 * the environment a packaged build needs, and gets out of the way.
 */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RESOURCES = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = join(RESOURCES, 'app');
const NODE_FLAG = '--disable-warning=ExperimentalWarning';
/** As PACKAGED_HOOK_MODE in lib/claude-hooks.js, which writes the command. */
export const HOOK_MODE = 'claude-hook';
const PTY_PROBE = 'synabun-pty-ok';

const load = (relative) => import(pathToFileURL(join(APP_ROOT, relative)).href);

const USAGE = `SynaBun (packaged application)

  SynaBun                  start SynaBun, or open it when it is already running
  SynaBun start            run the server in this terminal
  SynaBun mcp              the MCP server on stdio, for an AI tool
  SynaBun diagnostics      what this build is and where it keeps its data
                           (--json, --natives to load the native modules)
  SynaBun version | doctor | profile | migrate-data | restore-backup
                           the same commands as the npm install
`;

/** macOS runs an app that was never moved out of its download from a random read-only path. */
export function isTranslocated(path) {
  return /\/AppTranslocation\//.test(String(path || ''));
}

async function runtimeFacts() {
  const { readPackagedRuntime, withPackagedPath } = await load('lib/packaged-runtime.js');
  const runtime = readPackagedRuntime({ packageRoot: APP_ROOT });
  if (!runtime) throw new Error(`this is not a packaged SynaBun (no ${join(RESOURCES, 'synabun-package.json')})`);
  return { runtime, withPackagedPath };
}

/** The environment every child of a packaged start gets. */
export async function packagedEnv(env = process.env) {
  const { runtime, withPackagedPath } = await runtimeFacts();
  const next = { ...withPackagedPath(env, runtime) };
  // A handler registered from a path that changes on every launch would point
  // at nothing by the next one.
  if (isTranslocated(runtime.entry)) next.SYNABUN_LAUNCHER_REGISTER = '0';
  return { env: next, runtime };
}

/** Run the supervisor in the foreground and end the way it ends. */
export function superviseForeground(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [NODE_FLAG, join(APP_ROOT, 'setup.js'), ...args], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      windowsHide: env.SYNABUN_DESKTOP_BACKGROUND === '1',
    });
    // While the supervisor runs, a signal sent to this process is meant for it.
    const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = signals.map((signal) => {
      const handler = () => { try { child.kill(signal); } catch {} };
      process.on(signal, handler);
      return [signal, handler];
    });
    const settle = (result) => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      done(result);
    };
    child.on('error', (error) => {
      console.error(`SynaBun could not start: ${error.message}`);
      settle({ code: 1 });
    });
    child.on('exit', (code, signal) => settle({ code: code ?? 1, signal }));
  });
}

/**
 * A start from the desktop (no arguments). The desktop gives a bare
 * environment and no terminal, and a second click should show the page
 * instead of failing on the port the first one holds.
 */
export async function startFromDesktop() {
  const { env, runtime } = await packagedEnv();
  const { runLauncher, resolvePort, noteDesktopLaunch } = await load('lib/start-launcher.js');
  const { getDataHome } = await load('lib/paths.js');
  const { backgroundCommand, openDesktopPwa, pwaServerReady } = await load('lib/desktop-pwa.js');
  const dataHome = getDataHome({ env });
  const port = resolvePort({ env, dataHome });
  const deadline = Date.now() + 5 * 60 * 1000;
  const result = await runLauncher({
    env, packageRoot: APP_ROOT, background: true,
    spawnImpl: (file, args, options) => {
      const command = backgroundCommand(runtime, options.env);
      return spawn(command.file, command.args, { ...options, env: command.env, cwd: command.cwd || options.cwd });
    },
  });
  if (result.code) return result.code;
  // An occupied port is also the duplicate-start guard. Wait for the real API,
  // including when another desktop click or supervisor is still starting.
  while (!await pwaServerReady(port)) {
    if (Date.now() >= deadline) {
      noteDesktopLaunch(dataHome, `server on port ${port} is not ready`);
      throw new Error(`server on port ${port} is not ready; see the user-data data/launcher.log`);
    }
    await new Promise(done => setTimeout(done, 300));
  }
  let opened;
  try { opened = await openDesktopPwa({ port, env }); }
  catch (error) { noteDesktopLaunch(dataHome, `could not open the PWA or installation guide: ${error.message}`); throw error; }
  noteDesktopLaunch(dataHome, `${result.outcome}; ${opened.kind}`);
  if (process.stdout.isTTY) console.log(`SynaBun: ${result.outcome}; ${opened.kind}.`);
  return 0;
}

async function startSupervisor(args) {
  const { env } = await packagedEnv();
  return finish(await superviseForeground(args, env));
}

function finish({ code, signal }) {
  if (signal) {
    // End by the same signal, so a shell that is waiting reports it as such.
    try { process.kill(process.pid, signal); } catch {}
  }
  return code;
}

/** The synabun:// handler: the existing launch logic, with the entry as the thing it starts. */
async function runProtocolLauncher(argv) {
  const { env, runtime } = await packagedEnv();
  const { runLauncher, BEACON_LINGER_MS } = await load('lib/start-launcher.js');
  const { backgroundCommand } = await load('lib/desktop-pwa.js');
  if (!runtime.entry) throw new Error('the entry executable of this build could not be found');
  const result = await runLauncher({
    argv,
    env,
    packageRoot: APP_ROOT,
    beacon: true,
    lingerMs: BEACON_LINGER_MS,
    background: true,
    // The supervisor is started through the entry executable, never through
    // this process's own files: an AppImage's mount ends with the process
    // that opened it, and a start has to outlive this one.
    spawnImpl: (file, args, options) => {
      const command = backgroundCommand(runtime, options.env);
      return spawn(command.file, command.args, { ...options, env: command.env, cwd: command.cwd || options.cwd });
    },
  });
  if (process.stdout.isTTY) {
    // (the same sentences launcher.mjs prints for an npm or Git install)
    const said = {
      ignored: 'Nothing to do for that link.',
      'already-running': `SynaBun is already running on port ${result.port}.`,
      'already-starting': 'SynaBun is already starting.',
      started: `SynaBun is running on port ${result.port}.`,
      spawned: 'SynaBun is starting; it has not answered yet.',
      failed: 'SynaBun could not be started. Run it with "start" in a terminal to see why.',
    }[result.outcome];
    if (said) console.log(said);
  }
  // Like launcher.mjs: the launch is over, whatever is still open.
  process.exit(result.code);
}

function isExecutable(path) {
  if (process.platform === 'win32') return existsSync(path);
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** Load each native module the way the application does, and say what happened. */
async function probeNatives() {
  const out = {};

  // The terminal: a real PTY that runs one command.
  out.nodePty = await new Promise((done) => {
    const settle = (value) => done(value);
    try {
      const pty = createRequire(join(APP_ROOT, 'neural-interface', 'package.json'))('node-pty');
      const [shell, args] = process.platform === 'win32'
        ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `echo ${PTY_PROBE}`]]
        : ['/bin/sh', ['-c', `echo ${PTY_PROBE}`]];
      const term = pty.spawn(shell, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
      let seen = '';
      const timer = setTimeout(() => { try { term.kill(); } catch {} settle({ ok: false, error: 'no output within 10 s' }); }, 10000);
      term.onData((data) => { seen += data; });
      term.onExit(() => { clearTimeout(timer); settle({ ok: seen.includes(PTY_PROBE), ...(seen.includes(PTY_PROBE) ? {} : { error: 'the command produced no output' }) }); });
    } catch (error) {
      settle({ ok: false, error: String(error?.message || error) });
    }
  });

  // Embeddings: the runtime's native binding. In a child, ended hard, because
  // the binding can abort on a normal exit after it has been loaded.
  const onnx = spawnSync(process.execPath, ['-e',
    "require('onnxruntime-node');process.stdout.write('loaded',()=>process.kill(process.pid,'SIGKILL'))",
  ], { cwd: join(APP_ROOT, 'mcp-server'), encoding: 'utf8', timeout: 30000 });
  out.onnxruntime = onnx.stdout === 'loaded'
    ? { ok: true }
    : { ok: false, error: String(onnx.stderr || onnx.error?.message || 'did not load').trim().split('\n').pop() };

  // The application's own native helpers (the terminal's spawn helper, where the
  // platform has one): allowed to run.
  const { vendoredBinaryTargets } = await load('neural-interface/lib/native-binary-runtime.js');
  const binaries = vendoredBinaryTargets({ root: join(APP_ROOT, 'neural-interface') })
    .map(target => ({ id: target.id, kind: target.kind, executable: isExecutable(target.path) }));
  out.vendoredBinaries = { ok: binaries.every(binary => binary.executable), binaries };

  // Claude Code, Codex, OpenCode and Gemini CLI are the user's own
  // installations: an application that carries one was built wrong.
  const { externalToolsInstalledIn } = await load('lib/external-tools.js');
  const inside = ['mcp-server', 'neural-interface']
    .flatMap(folder => externalToolsInstalledIn(join(APP_ROOT, folder, 'node_modules')).map(item => `${folder}: ${item.name}`));
  out.externalTools = inside.length
    ? { ok: false, error: `packaged, though the user installs them: ${inside.join(', ')}`, packaged: inside }
    : { ok: true, packaged: [] };
  return out;
}

export async function collectDiagnostics({ natives = false } = {}) {
  const { runtime } = await runtimeFacts();
  const { getDataHome } = await load('lib/paths.js');
  const manifest = JSON.parse(readFileSync(runtime.manifestPath, 'utf8'));
  const model = join(APP_ROOT, 'mcp-server', 'node_modules', '@huggingface', 'transformers', '.cache', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx');
  const facts = {
    packaged: true,
    version: runtime.version,
    target: manifest.target,
    artifact: runtime.artifact,
    builtAt: manifest.builtAt || null,
    node: { version: process.version, platform: process.platform, arch: process.arch, path: process.execPath },
    entry: runtime.entry,
    translocated: isTranslocated(runtime.entry),
    resources: RESOURCES,
    application: APP_ROOT,
    dataHome: getDataHome(),
    embeddingModel: existsSync(model) ? 'bundled' : 'absent',
    updates: 'install a newer build over this one; the in-app updater does not change a packaged application',
  };
  if (natives) facts.natives = await probeNatives();
  return facts;
}

async function printDiagnostics(args) {
  const facts = await collectDiagnostics({ natives: args.includes('--natives') });
  if (args.includes('--json')) {
    console.log(JSON.stringify(facts, null, 2));
  } else {
    console.log(`SynaBun ${facts.version} (${facts.target.id}, ${facts.artifact || 'application'})`);
    console.log(`  Node          ${facts.node.version} ${facts.node.platform}-${facts.node.arch}`);
    console.log(`  Entry         ${facts.entry}`);
    console.log(`  Application   ${facts.application}`);
    console.log(`  Data          ${facts.dataHome}`);
    console.log(`  Local model   ${facts.embeddingModel}`);
    console.log(`  Updates       ${facts.updates}`);
    if (facts.translocated) console.log('  Note          macOS is running this copy from a temporary path. Move SynaBun to Applications and open it again.');
    for (const [name, result] of Object.entries(facts.natives || {})) {
      console.log(`  ${name.padEnd(13)} ${result.ok ? 'ok' : `FAILED${result.error ? ` (${result.error})` : ''}`}`);
    }
  }
  const failed = Object.values(facts.natives || {}).some(result => !result.ok);
  return failed ? 1 : 0;
}

/**
 * One Claude Code hook handler. Claude Code reads this process's stdout as the
 * handler's answer, so nothing here prints. The handler is imported into this
 * process: the bundled Node, the caller's stdin, stdout and environment, and
 * the arguments it would find under `node -e <bootstrap> <script>`. It ends
 * the process the way it does there, and an AppImage stays mounted for as
 * long as this process lives.
 */
export async function runHook(argv, { appRoot = APP_ROOT } = {}) {
  const [script, ...rest] = argv;
  const { HOOK_SCRIPTS } = await import(pathToFileURL(join(appRoot, 'lib', 'claude-hooks.js')).href);
  if (!HOOK_SCRIPTS.some(hook => hook.script === script)) throw new Error(`unknown hook "${script ?? ''}"`);
  process.argv = [process.argv[0], script, ...rest];
  await import(pathToFileURL(join(appRoot, 'hooks', 'claude-code', script)).href);
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  if (mode === undefined) return startFromDesktop();
  if (mode === 'start') return startSupervisor(rest);
  if (mode === 'background-server') {
    const { env } = await packagedEnv();
    return finish(await superviseForeground([], { ...env, SYNABUN_OPEN_BROWSER: '0', SYNABUN_DESKTOP_BACKGROUND: '1' }));
  }
  if (mode === 'launcher') return runProtocolLauncher(rest);
  if (mode === 'diagnostics') return printDiagnostics(rest);
  if (mode === 'help' || mode === '--help' || mode === '-h') { process.stdout.write(USAGE); return 0; }
  // version, doctor, profile, migrate-data, restore-backup: setup.js owns them.
  return startSupervisor(argv);
}

function invokedDirectly() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly() && process.argv[2] === HOOK_MODE) {
  // The handler owns the process from here: no exit code and no timer of ours.
  runHook(process.argv.slice(3)).catch((error) => {
    console.error(`SynaBun hook: ${error?.message || error}`);
    process.exitCode = 1;
  });
} else if (invokedDirectly()) {
  const end = (code) => {
    process.exitCode = code;
    // A native module may leave a handle open; the answer has been given.
    setTimeout(() => process.exit(code), 3000).unref();
  };
  main().then((code) => end(code ?? 0), (error) => {
    console.error(`SynaBun: ${error.message}`);
    end(1);
  });
}
