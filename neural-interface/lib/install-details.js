// What this install has, for the Details areas of the setup wizard (GET /api/setup/install-details): the Node.js
// SynaBun runs on, the npm and npx it runs (each asked for its version, the command and its answer shown as they
// were), where `npm i -g` puts packages, the npm a terminal finds first, every part's dependencies with the
// versions installed, the MCP server's build, and what a packaged application brought with it (the embedding
// model, cloudflared, Git for Windows, the window's Electron) and whether the automation browser is there yet.
//
// Read only: nothing is installed, written or downloaded. Every command has a short time limit and a fixed
// argument list; nothing a request says reaches one. A command that fails is reported with what it wrote, with
// secrets taken out first (lib/log-redact.js: npm prints an invalid setting with its value, an error can name a
// URL with its password) and then cut to OUTPUT_MAX. The whole answer goes through the same redaction before it
// leaves (redactDeep), and nothing of it is kept.

import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { redactDeep, redactSecrets } from '../../lib/log-redact.js';

const COMMAND_TIMEOUT_MS = 8000;
const OUTPUT_MAX = 2000;

const readJsonFile = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** How many packages an npm install record (node_modules/.package-lock.json, or a package-lock.json) holds. */
export function packagesInLock(lock) {
  const entries = lock && typeof lock.packages === 'object' ? Object.keys(lock.packages) : [];
  return entries.filter(key => /(?:^|\/)node_modules\//.test(key)).length;
}

/**
 * A part's own dependencies (its package.json), each with the version installed in its node_modules, or null
 * when it is not installed. Sorted by name.
 */
export function directDependencies(dir, { readJson = readJsonFile } = {}) {
  const manifest = readJson(path.join(dir, 'package.json')) || {};
  const wanted = { ...(manifest.optionalDependencies || {}), ...(manifest.dependencies || {}) };
  return Object.keys(wanted).sort().map((name) => {
    const installed = readJson(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'));
    return { name, wanted: String(wanted[name]), installed: installed?.version ? String(installed.version) : null };
  });
}

/** The first file named `name` (on Windows `name.cmd`, `.exe` or the bare name) in the PATH `entries`, skipping `skip` folders. */
export function firstOnPath(name, entries, { platform = process.platform, exists = existsSync, skip = [] } = {}) {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const id = (dir) => (platform === 'win32' ? String(dir).toLowerCase().replace(/[\\/]+$/, '') : String(dir).replace(/\/+$/, ''));
  const skipped = new Set(skip.filter(Boolean).map(id));
  const names = platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of entries || []) {
    if (!dir || skipped.has(id(dir))) continue;
    for (const candidate of names) {
      const file = impl.join(dir, candidate);
      if (exists(file)) return file;
    }
  }
  return null;
}

/** Run `file --version` (a Windows command file through cmd.exe, the way a terminal starts it): { command, ok, output }. */
export function runVersion(file, { platform = process.platform, env = process.env, execFile = nodeExecFile, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const command = `${/\s/.test(file) ? `"${file}"` : file} --version`;
  return new Promise((done) => {
    const finish = (error, stdout = '', stderr = '') => {
      const text = redactSecrets(String(stdout || '').trim() || String(stderr || '').trim() || (error ? error.message : ''));
      done({ command: redactSecrets(command), ok: !error, output: text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}…` : text });
    };
    try {
      if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
        execFile(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}" --version"`], { env, timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: true }, finish);
      } else {
        execFile(file, ['--version'], { env, timeout: timeoutMs, windowsHide: true }, finish);
      }
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Everything the Details areas show. `packaged` is lib/packaged-runtime.js readPackagedRuntime() (null for an
 * npm or Git install) and `manifest` the packaged build's synabun-package.json; `osPath` the PATH a new terminal
 * gets (lib/os-path.js); `npmPrefix` where the npm SynaBun runs puts global packages (the one absolute prefix PATH
 * is built from: lib/child-path.js), `npmPrefixSource` why ('user' or 'synabun') and `npmPrefixFrom` what set it.
 */
export async function collectInstallDetails({
  packageRoot,
  packaged = null,
  manifest = null,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  nodeVersion = process.version,
  osPath = [],
  npmPrefix = null,
  npmPrefixSource = null,
  npmPrefixFrom = null,
  npmGlobalBin = null,
  browserExecutable = null,
  exists = existsSync,
  readJson = readJsonFile,
  version = runVersion,
} = {}) {
  const windows = platform === 'win32';
  const impl = windows ? path.win32 : path.posix;
  const runtimeBin = packaged?.runtimeBin || null;
  const ownNpm = runtimeBin ? impl.join(runtimeBin, windows ? 'npm.cmd' : 'npm') : firstOnPath('npm', String(env.PATH || env.Path || '').split(windows ? ';' : ':'), { platform, exists });
  const ownNpx = runtimeBin ? impl.join(runtimeBin, windows ? 'npx.cmd' : 'npx') : firstOnPath('npx', String(env.PATH || env.Path || '').split(windows ? ';' : ':'), { platform, exists });
  const [npm, npx] = await Promise.all([
    ownNpm ? version(ownNpm, { platform, env }) : Promise.resolve(null),
    ownNpx ? version(ownNpx, { platform, env }) : Promise.resolve(null),
  ]);
  // The npm a terminal finds first: the user's own, when there is one outside SynaBun.
  const userNpmPath = firstOnPath('npm', osPath, { platform, exists, skip: runtimeBin ? [runtimeBin, impl.dirname(execPath)] : [] });
  const userNpm = userNpmPath && userNpmPath !== ownNpm ? { path: userNpmPath, ...(await version(userNpmPath, { platform, env })) } : null;

  const parts = [['Neural Interface', 'neural-interface'], ['MCP server', 'mcp-server']].map(([name, folder]) => {
    const dir = path.join(packageRoot, folder);
    const installed = readJson(path.join(dir, 'node_modules', '.package-lock.json'));
    return { name, folder, packages: packagesInLock(installed), dependencies: directDependencies(dir, { readJson }) };
  });
  const mcpBuilt = exists(path.join(packageRoot, 'mcp-server', 'dist', 'index.js'));

  return redactDeep({
    kind: packaged ? 'app' : 'source',
    platform,
    app: packaged ? {
      version: packaged.version || null,
      target: packaged.target || null,
      electron: manifest?.shell?.electron || null,
      builtAt: manifest?.builtAt || null,
    } : null,
    node: { version: nodeVersion, path: execPath, bundled: !!runtimeBin && execPath.startsWith(packaged.resources) },
    npm: npm ? { path: ownNpm, bundled: !!runtimeBin, ...npm } : null,
    npx: npx ? { path: ownNpx, bundled: !!runtimeBin, ...npx } : null,
    globalPrefix: npmPrefix ? { path: npmPrefix, bin: npmGlobalBin || null, source: npmPrefixSource || null, from: npmPrefixFrom || null } : null,
    userNpm,
    parts,
    mcp: { built: mcpBuilt, file: 'mcp-server/dist/index.js' },
    bundled: packaged ? {
      embeddingModel: manifest?.embeddingModel === 'bundled' ? 'Xenova/all-MiniLM-L6-v2' : null,
      cloudflared: manifest?.cloudflared?.version || null,
      gitBash: manifest?.gitBash?.version || null,
    } : null,
    browser: browserExecutable ? { path: browserExecutable, installed: exists(browserExecutable) } : null,
  });
}
