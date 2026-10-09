/**
 * Staging: everything that goes into a packaged application, produced in a
 * work folder and nowhere else.
 *
 *   1. the pinned Node for the target, downloaded and checked against its pin
 *   2. the application, as exactly the files `npm pack` would publish
 *   3. its production dependencies, installed by the target's own npm, and
 *      none of the tools the user installs separately (Claude Code, Codex,
 *      OpenCode, Gemini CLI: lib/external-tools.js)
 *   4. the native modules: compiled where there is no prebuilt binary, made
 *      executable, and stripped of other platforms' binaries
 *   5. the public embedding model, checked against its pins
 *
 * Nothing is copied from the source checkout's node_modules or from a user's
 * data, and nothing is installed into the source checkout.
 *
 * In a cross build the target's Node cannot run here. `ctx.runtime` is still
 * the Node that is packaged; `ctx.tool` is the Node that does the work, which
 * is then the build machine's own pinned one (lib/cross.mjs has the rest).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalToolsInLock, pruneExternalTools, stripExternalToolsFromLock } from '../../lib/external-tools.js';
import { compilePty, crossNpmEnv, fetchEmbeddingModel, linksIn, verifySelection, writeWindowsShims } from './cross.mjs';
import { readLocks } from './preflight.mjs';
import { hostRuntimeFor, nodeRuntimeFor, PACKAGING_ROOT } from './targets.mjs';
import { BuildError, fetchVerified, FORMAT_PLATFORM, isolatedEnv, nativeFormat, note, removeTree, run, sha256File, step, walk, which } from './util.mjs';

/** Paths that never belong in a package, whatever the file list says. */
const PRIVATE_PATTERNS = [
  [/(^|\/)\.env(?!\.example$)(\.[^/]*)?$/, 'environment file'],
  [/\.(db|db-shm|db-wal|sqlite)$/i, 'database'],
  [/\.db\.backup-/i, 'database backup'],
  [/^(data|mcp-data|mcp-server\/data|neural-interface\/data)\//, 'runtime data'],
  [/(^|\/)\.(claude|codex|gemini|opencode|synabun|git)\//, 'local tool state'],
  [/(^|\/)(CLAUDE|AGENTS)\.md$/, 'local agent instructions'],
  [/(^|\/)(connections\.json|\.npmrc)$/, 'credentials or registry configuration'],
  [/\.(pem|key|p12|pfx|keystore|mobileprovision)$/i, 'key material'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)/, 'key material'],
  [/-RAW\.md$/, 'raw worklog'],
  [/(^|\/)memory-seed\//, 'seed data'],
  [/(^|\/)\.DS_Store$/, 'desktop metadata'],
  [/\.tgz$/, 'package archive'],
];
/** Shipped on purpose: the connector's npm settings (no credentials in it). */
const PRIVATE_EXCEPTIONS = new Set(['neural-interface/lib/whatsapp/connector/.npmrc']);

/** The entries of `paths` (package-relative, forward slashes) that must not ship: [{ path, reason }]. */
export function findPrivatePaths(paths) {
  const found = [];
  for (const path of paths) {
    if (PRIVATE_EXCEPTIONS.has(path)) continue;
    const hit = PRIVATE_PATTERNS.find(([pattern]) => pattern.test(path));
    if (hit) found.push({ path, reason: hit[1] });
  }
  return found;
}

/** Local instructions may exist in a development package list; exclude them only from staging. */
export function publicPackageSelection(paths) {
  const privatePaths = findPrivatePaths(paths);
  const excluded = privatePaths.filter(item => item.reason === 'local agent instructions');
  const blocked = privatePaths.filter(item => item.reason !== 'local agent instructions');
  const omitted = new Set(excluded.map(item => item.path));
  return { files: paths.filter(path => !omitted.has(path)), excluded, blocked };
}

const systemTar = () => (process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

/** Download a pinned Node archive, verify it and unpack it into the work folder: where its parts are. */
async function unpackNode(ctx, pin, folder, windows) {
  const archive = await fetchVerified({ url: pin.url, sha256: pin.sha256, destination: join(ctx.cache, 'node', pin.file), label: pin.file });
  const root = join(ctx.work, folder);
  mkdirSync(root, { recursive: true });
  // The Windows archive is a zip: Windows' own tar reads one, and so does bsdtar (the tar of macOS).
  const tar = pin.file.endsWith('.zip') && process.platform !== 'win32' ? which('bsdtar') || 'tar' : systemTar();
  run(tar, ['-xf', archive, '-C', root, '--strip-components=1'], { label: 'unpack the Node runtime' });
  return {
    version: pin.version,
    root,
    bin: windows ? root : join(root, 'bin'),
    node: windows ? join(root, 'node.exe') : join(root, 'bin', 'node'),
    npmCli: windows ? join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js') : join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  };
}

/** Download, verify and unpack the target's Node; then run it once, or in a cross build read what it is. */
export async function fetchRuntime(ctx) {
  const pin = nodeRuntimeFor(ctx.target, ctx.pins);
  step(`Node ${pin.version} for ${ctx.target.id}`);
  const windows = ctx.target.platform === 'win32';
  ctx.runtime = await unpackNode(ctx, pin, 'node', windows);
  ctx.tool = { ...ctx.runtime, platform: ctx.target.platform, arch: ctx.target.arch };

  if (ctx.cross) {
    const format = nativeFormat(ctx.runtime.node);
    if (FORMAT_PLATFORM[format?.format] !== ctx.target.platform || !format.archs.includes(ctx.target.arch)) {
      throw new BuildError(`The ${ctx.target.id} Node archive does not hold a ${ctx.target.platform}-${ctx.target.arch} Node.`);
    }
    note(`for ${ctx.target.platform}-${ctx.target.arch} by its header; it cannot run on this machine`);
    const host = ctx.verdict.host;
    const hostPin = hostRuntimeFor(host, ctx.pins);
    step(`Node ${hostPin.version} for this machine (runs npm and the compiler)`);
    ctx.tool = { ...await unpackNode(ctx, hostPin, 'host-node', false), platform: host.platform, arch: host.arch };
  }

  ctx.env = isolatedEnv({
    home: join(ctx.work, 'home'),
    tmp: join(ctx.work, 'tmp'),
    npmCache: join(ctx.cache, 'npm'),
    pathEntries: [ctx.tool.bin],
    // node-gyp compiles against the headers that came in this same archive.
    // A cross build compiles nothing through npm: it tells npm whose packages to install.
    extra: ctx.cross ? crossNpmEnv(ctx.target) : windows ? {} : { npm_config_nodedir: ctx.runtime.root },
  });

  // The definitive host check: this machine has to run the Node that installs
  // everything that is packaged. In a native build that is the target's own,
  // which also loads it.
  const probe = run(ctx.tool.node, ['-p', '[process.version, process.platform, process.arch].join(" ")'], {
    capture: true, env: ctx.env, allowFailure: true,
  });
  const expected = `v${pin.version} ${ctx.tool.platform} ${ctx.tool.arch}`;
  if (!probe.ok || probe.stdout.trim() !== expected) {
    throw new BuildError(`This machine cannot run the ${ctx.cross ? 'pinned' : ctx.target.id} Node runtime, so ${ctx.target.id} cannot be built here.`, {
      details: [`expected "${expected}", got "${probe.stdout.trim() || probe.error?.message || `exit ${probe.status}`}"`],
    });
  }
  note(`runs here: ${expected}`);
}

function npm(ctx, args, cwd, label) {
  return run(ctx.tool.node, [ctx.tool.npmCli, ...args], { cwd, env: ctx.env, label });
}

/** The application files: what `npm pack` puts in the tarball, and nothing else. */
export function stageApplication(ctx) {
  step('Application files (the published file list)');
  const packDir = join(ctx.work, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packed = run(ctx.tool.node, [ctx.tool.npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', packDir], {
    cwd: ctx.repoRoot, env: ctx.env, capture: true, label: 'npm pack',
  });
  let info;
  try { [info] = JSON.parse(packed.stdout); } catch { throw new BuildError('npm pack did not describe what it packed', { details: [packed.stdout.slice(0, 400)] }); }
  if (info.version !== ctx.version) throw new BuildError(`npm pack produced version ${info.version}, expected ${ctx.version}`);

  const listed = info.files.map(file => file.path);
  const selection = publicPackageSelection(listed);
  const offending = selection.blocked;
  if (offending.length) {
    throw new BuildError('The package file list contains files that must never ship. Nothing was staged from it.', {
      details: offending.slice(0, 30).map(item => `${item.path} (${item.reason})`),
    });
  }
  run(systemTar(), [...selection.excluded.map(item => `--exclude=package/${item.path}`), '-xzf', join(packDir, info.filename), '-C', packDir], { label: 'unpack the package' });
  ctx.app = join(ctx.work, 'app');
  renameSync(join(packDir, 'package'), ctx.app);
  removeTree(packDir);
  ctx.report.packedFiles = selection.files.length;
  ctx.report.sourceExclusions = selection.excluded;
  note(`${selection.files.length} files, none private; ${selection.excluded.length} local instruction files excluded in staging`);
}

/** Strip executable dependency edges from copies in the disposable stage, never the source locks. */
export function prepareStagedLocks(ctx) {
  if (ctx.repoRoot) {
    const offset = ctx.work && relative(resolve(ctx.work), resolve(ctx.app));
    if (!offset || offset.startsWith('..') || isAbsolute(offset) || resolve(ctx.app) === resolve(ctx.repoRoot)) {
      throw new BuildError('Dependency exclusions require a disposable application stage, never the source checkout.');
    }
  }
  const report = [];
  for (const folder of ['mcp-server', 'neural-interface']) {
    const file = join(ctx.app, folder, 'package-lock.json');
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    const found = stripExternalToolsFromLock(lock);
    if (found.packages.length || found.edges.length) {
      writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
      report.push({ folder, packages: found.packages.length, edges: found.edges.length });
    }
  }
  ctx.report.stagedLockExclusions = report;
}

/** Production dependencies, by the target's npm, with no lifecycle script run on its own. */
export async function installDependencies(ctx) {
  prepareStagedLocks(ctx);
  step('MCP server: build from source');
  const mcp = join(ctx.app, 'mcp-server');
  removeTree(join(mcp, 'dist'));
  npm(ctx, ['ci', '--ignore-scripts'], mcp, 'npm ci (mcp-server, with its build tools)');
  run(ctx.tool.node, [join('node_modules', 'typescript', 'bin', 'tsc')], { cwd: mcp, env: ctx.env, label: 'compile the MCP server' });
  for (const file of ['dist/index.js', 'dist/preload.js', 'dist/scripts/setup-embeddings.js']) {
    if (!existsSync(join(mcp, file))) throw new BuildError(`The MCP server build did not produce ${file}`);
  }
  npm(ctx, ['prune', '--omit=dev', '--ignore-scripts'], mcp, 'npm prune (mcp-server)');

  step('Neural Interface: production dependencies');
  npm(ctx, ['ci', '--omit=dev', '--ignore-scripts'], join(ctx.app, 'neural-interface'), 'npm ci (neural-interface)');

  excludeExternalTools(ctx);

  if (ctx.cross) {
    step(`Dependencies: installed for ${ctx.target.id}, not for this machine`);
    verifySelection(ctx, readLocks(ctx.app));
    if (ctx.target.platform === 'win32') {
      let shims = 0;
      for (const folder of ['mcp-server', 'neural-interface']) shims += await writeWindowsShims(ctx, join(ctx.app, folder, 'node_modules'));
      const links = linksIn(ctx.app);
      if (links.length) throw new BuildError('The staged application holds symbolic links, which do not work on Windows.', { details: links.slice(0, 30) });
      note(`${shims} package commands rewritten as Windows command files`);
    }
  }
}

/**
 * Claude Code, Codex, OpenCode and Gemini CLI are installed by the user and are
 * never part of an application. The lockfiles hold none of them, so npm should
 * have downloaded none; whatever came anyway is removed here, before anything
 * is compiled, counted or packaged, and the audit refuses a bundle that still
 * holds one. The build report says what was found.
 */
export function excludeExternalTools(ctx) {
  step('External tools: none is packaged (the user installs them)');
  const report = { lockfileEntries: [], removed: [] };
  for (const folder of ['mcp-server', 'neural-interface']) {
    const root = join(ctx.app, folder);
    const locked = externalToolsInLock(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')));
    for (const item of locked.packages) report.lockfileEntries.push(`${folder}/${item.path}`);
    const pruned = pruneExternalTools(join(root, 'node_modules'));
    if (pruned.failed.length) {
      throw new BuildError('An external tool could not be removed from the staged application. Nothing was packaged.', {
        details: pruned.failed.map(item => `${item.path}: ${item.error}`),
      });
    }
    for (const item of pruned.removed) report.removed.push(`${folder}/node_modules/${item.kind === 'command' ? `.bin/${item.name}` : item.name}`);
    // npm may have reconstructed an SDK edge in its hidden installation record.
    for (const name of ['package-lock.json', 'node_modules/.package-lock.json']) {
      const file = join(root, name);
      if (!existsSync(file)) continue;
      const lock = JSON.parse(readFileSync(file, 'utf8'));
      const stripped = stripExternalToolsFromLock(lock);
      if (stripped.packages.length || stripped.edges.length) writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
    }
  }
  ctx.report.externalTools = report;
  if (report.lockfileEntries.length) note(`warning: the lockfiles name ${report.lockfileEntries.length} external tool packages; run node scripts/strip-external-tools.mjs`);
  note(report.removed.length
    ? `removed ${report.removed.length} that npm installed: ${report.removed.join(', ')}`
    : 'npm installed none: the lockfiles hold none');
}

const list = (folder) => { try { return readdirSync(folder); } catch { return []; } };

/** Make every `bin` script of every installed package executable (POSIX). */
function ensureBinScripts(nodeModules) {
  let fixed = 0;
  const visit = (folder) => {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')); } catch { return; }
    const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin || {});
    for (const bin of bins) {
      const file = join(folder, String(bin));
      try {
        const info = statSync(file);
        if (info.isFile() && (info.mode & 0o111) !== 0o111) { chmodSync(file, info.mode | 0o755); fixed++; }
      } catch {}
    }
  };
  for (const name of list(nodeModules)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) for (const scoped of list(join(nodeModules, name))) visit(join(nodeModules, name, scoped));
    else visit(join(nodeModules, name));
  }
  return fixed;
}

/** Every `prebuilds` folder under a node_modules tree. */
function prebuildFolders(folder, found = []) {
  let entries;
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'prebuilds') found.push(join(folder, entry.name));
    else prebuildFolders(join(folder, entry.name), found);
  }
  return found;
}

/** Remove native code that belongs to another operating system or processor. */
function pruneForeign(ctx, packageDir) {
  const { platform, arch } = ctx.target;
  const removed = [];
  const drop = (path) => { if (existsSync(path)) { removeTree(path); removed.push(path.slice(ctx.app.length + 1)); } };
  const nodeModules = join(packageDir, 'node_modules');

  const onnx = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v3');
  for (const os of list(onnx)) {
    for (const cpu of list(join(onnx, os))) if (os !== platform || cpu !== arch) drop(join(onnx, os, cpu));
    if (!list(join(onnx, os)).length) drop(join(onnx, os));
  }
  // prebuilds/<platform>-<arch>[+<arch>]: the convention of every package that
  // ships one binary per system (node-pty and others). A folder for another
  // system or processor goes; what is inside a matching one is left alone,
  // glibc and musl variants included.
  for (const prebuilds of prebuildFolders(nodeModules)) {
    for (const name of list(prebuilds)) {
      const [system, cpus = ''] = [name.slice(0, name.indexOf('-')), name.slice(name.indexOf('-') + 1)];
      if (system !== platform || !cpus.split('+').includes(arch)) drop(join(prebuilds, name));
    }
  }
  // Windows console helpers that node-pty carries for every system.
  if (platform !== 'win32') drop(join(nodeModules, 'node-pty', 'third_party'));
  for (const file of walk(nodeModules)) {
    if (file.link) continue;
    if (/\.pdb$/i.test(file.relative)) { drop(file.path); continue; }
    // Whatever is left for this system but another processor, wherever a package keeps it.
    const format = nativeFormat(file.path);
    if (format && FORMAT_PLATFORM[format.format] === platform && !format.archs.includes(arch)) drop(file.path);
  }
  return removed;
}

/** Compile, repair and trim the native modules of the staged application. */
export async function prepareNatives(ctx) {
  step('Native modules');
  const { platform, arch } = ctx.target;
  const neural = join(ctx.app, 'neural-interface');
  const ptyDir = join(neural, 'node_modules', 'node-pty');
  if (!existsSync(ptyDir)) throw new BuildError('node-pty was not installed: the terminal would not work');

  if (existsSync(join(ptyDir, 'prebuilds', `${platform}-${arch}`, 'pty.node'))) {
    note(`node-pty: prebuilt binary for ${platform}-${arch}`);
  } else {
    // An install with scripts ignored leaves no terminal at all here. Build it.
    note(`node-pty: no prebuilt binary for ${platform}-${arch}, compiling from source`);
    if (ctx.cross) compilePty(ctx, ptyDir);
    else npm(ctx, ['rebuild', 'node-pty', '--foreground-scripts'], neural, 'compile node-pty');
    const release = join(ptyDir, 'build', 'Release');
    if (!existsSync(join(release, 'pty.node'))) throw new BuildError('node-pty did not build: the terminal would not work', { details: ['A C++ toolchain, make and python3 are needed.'] });
    // Keep what is loaded at run time; the rest names this build machine's paths.
    for (const name of list(join(ptyDir, 'build'))) if (name !== 'Release') removeTree(join(ptyDir, 'build', name));
    for (const name of list(release)) if (!/\.node$/.test(name) && name !== 'spawn-helper') removeTree(join(release, name));
  }

  const pruned = [...pruneForeign(ctx, neural), ...pruneForeign(ctx, join(ctx.app, 'mcp-server'))];
  note(`removed ${pruned.length} folders and files built for other platforms`);
  ctx.report.prunedForeign = pruned;

  if (platform !== 'win32') {
    // The application's own sweep: the PTY helper of every prebuild that is left.
    const { ensureVendoredExecutables } = await import(pathToFileURL(join(neural, 'lib', 'native-binary-runtime.js')).href);
    const sweep = ensureVendoredExecutables({ root: neural, platform });
    if (sweep.failed.length) {
      throw new BuildError('Some bundled executables cannot be launched', { details: sweep.failed.map(item => `${item.path}: ${item.state}`) });
    }
    const scripts = ensureBinScripts(join(neural, 'node_modules')) + ensureBinScripts(join(ctx.app, 'mcp-server', 'node_modules'));
    note(`executable bits: ${sweep.checked} native executables checked, ${sweep.repaired.length} repaired, ${scripts} scripts repaired`);
    ctx.report.executablesRepaired = sweep.repaired.length + scripts;
  }
}

/**
 * The local embedding model. The application loads it offline from inside its
 * own files, which a packaged application cannot add to later (a signed bundle,
 * a read-only image), so it is fetched now by the application's own installer
 * and every file is checked against its pin.
 */
export async function provisionEmbeddingModel(ctx) {
  if (!ctx.options.embeddingModel) {
    ctx.report.embeddingModel = 'absent';
    note('Embedding model left out (--no-embedding-model): this build recalls by keyword only.');
    return;
  }
  const pin = ctx.pins.embeddingModel;
  step(`Embedding model ${pin.id}`);
  const mcp = join(ctx.app, 'mcp-server');
  const cacheRoot = join(mcp, 'node_modules', '@huggingface', 'transformers', '.cache');
  if (ctx.cross) {
    // The installer loads the embedding runtime, which is the target's. Fetch what it would fetch.
    if (ctx.options.updateModelPins) throw new BuildError('--update-model-pins needs a native build: a cross build only accepts files that match their pins.');
    await fetchEmbeddingModel(ctx, cacheRoot);
  } else {
    const scratch = join(ctx.work, 'model-home');
    run(ctx.runtime.node, [join('dist', 'scripts', 'setup-embeddings.js')], {
      cwd: mcp,
      env: { ...ctx.env, SYNABUN_DATA_HOME: scratch, MEMORY_DATA_DIR: join(scratch, 'mcp-data'), SYNABUN_TYPESAFE: 'off' },
      label: 'download the embedding model',
    });
    removeTree(scratch);
  }

  const prefix = `${pin.id}/`;
  const actual = {};
  const strays = [];
  for (const file of walk(cacheRoot)) {
    if (file.link || !file.relative.startsWith(prefix)) { strays.push(file.relative); continue; }
    actual[file.relative.slice(prefix.length)] = await sha256File(file.path);
  }
  const listing = Object.entries(actual).map(([name, hash]) => `${name}  ${hash}`);
  if (strays.length) throw new BuildError('The model download left files that are not part of the model', { details: strays });
  if (!Object.keys(actual).length) throw new BuildError('The model download produced no files');

  if (ctx.options.updateModelPins) {
    const pinsPath = join(PACKAGING_ROOT, 'pins.json');
    const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
    pins.embeddingModel.files = Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(pinsPath, JSON.stringify(pins, null, 2) + '\n');
    note(`packaging/pins.json updated with ${listing.length} model files. Review the change before committing it.`);
  } else {
    const expected = pin.files || {};
    const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const wrong = [...names].filter(name => expected[name] !== actual[name]);
    if (wrong.length) {
      throw new BuildError('The embedding model does not match its pins. Nothing was packaged.', {
        details: [`differs: ${wrong.join(', ')}`, 'downloaded:', ...listing, 'To accept new files deliberately: build once with --update-model-pins and review packaging/pins.json.'],
      });
    }
  }
  ctx.report.embeddingModel = 'bundled';
  note(`${listing.length} files verified`);
}
