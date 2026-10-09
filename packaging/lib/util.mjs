/**
 * Small things every build step needs: running a command, a verified
 * download, an isolated environment, walking a tree, reading what kind of
 * native binary a file is.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** What the CLI exits with. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, hostMismatch: 2, blocked: 3, missingTools: 4, usage: 64 });

export class BuildError extends Error {
  constructor(message, { exitCode = EXIT.failed, details = [] } = {}) {
    super(message);
    this.name = 'BuildError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

// Progress goes to stderr: stdout is kept for what a command was asked to print.
export function step(message) { process.stderr.write(`\n==> ${message}\n`); }
export function note(message) { process.stderr.write(`    ${message}\n`); }

export function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}

/**
 * Download `url` to `destination` unless a file with the pinned checksum is
 * already there. A file that does not match its pin is removed and the build
 * stops: nothing unverified is ever unpacked or run.
 */
export async function fetchVerified({ url, sha256, destination, label = url }) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) throw new BuildError(`No pinned SHA-256 for ${label}; refusing to download it.`);
  if (existsSync(destination) && await sha256File(destination) === sha256) {
    note(`${label}: cached, checksum verified`);
    return destination;
  }
  mkdirSync(dirname(destination), { recursive: true });
  const partial = `${destination}.${process.pid}.part`;
  note(`${label}: downloading ${url}`);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!response.ok || !response.body) throw new BuildError(`Download failed (${response.status}) for ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    const actual = await sha256File(partial);
    if (actual !== sha256) {
      throw new BuildError(`Checksum mismatch for ${label}`, { details: [`expected ${sha256}`, `received ${actual}`, `from ${url}`] });
    }
    renameSync(partial, destination);
  } finally {
    rmSync(partial, { force: true });
  }
  note(`${label}: checksum verified`);
  return destination;
}

/**
 * Run a command without a shell. Its output goes to this process's stderr, or
 * is returned when `capture` is set. A non-zero exit is a BuildError.
 */
export function run(file, args, {
  cwd, env, capture = false, input, timeoutMs = 45 * 60 * 1000, label = null, allowFailure = false, verbatim = false,
} = {}) {
  const result = spawnSync(file, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 2, capture ? 'pipe' : 2],
  });
  const failed = result.error || result.status !== 0;
  if (failed && !allowFailure) {
    const what = label || `${file} ${args.join(' ')}`;
    const why = result.error ? result.error.message : result.signal ? `ended by ${result.signal}` : `exit code ${result.status}`;
    const tail = capture ? String(result.stderr || result.stdout || '').trim().split('\n').slice(-25) : [];
    throw new BuildError(`${what} failed (${why})`, { details: tail });
  }
  return { ok: !failed, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error || null };
}

/** The full path of a command on PATH, or null. */
export function which(name, env = process.env) {
  const pathValue = env.PATH || env.Path || '';
  const extensions = process.platform === 'win32' ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const folder of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(folder, name + extension);
      try { if (lstatSync(candidate).isDirectory()) continue; return candidate; } catch {}
    }
  }
  return null;
}

/**
 * The environment dependency and packaging steps run in: the target's Node
 * first on PATH, a throwaway home, npm told to read nobody's configuration.
 * Nothing of the caller's environment gets in except what is named here, so
 * no token, key or profile setting can reach a lifecycle script or a bundle.
 */
export function isolatedEnv({ home, tmp, npmCache, pathEntries = [], extra = {}, source = process.env } = {}) {
  for (const folder of [home, tmp, npmCache]) mkdirSync(folder, { recursive: true });
  // Two empty files: npm refuses to read one file as both its user and its global configuration.
  const userConfig = join(home, 'npmrc-user');
  const globalConfig = join(home, 'npmrc-global');
  writeFileSync(userConfig, '');
  writeFileSync(globalConfig, '');
  const windows = process.platform === 'win32';
  const systemPath = windows
    ? [join(source.SystemRoot || 'C:\\Windows', 'System32'), source.SystemRoot || 'C:\\Windows', join(source.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')]
    : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env = {
    PATH: [...pathEntries, ...systemPath].join(delimiter),
    HOME: home,
    TMPDIR: tmp,
    LANG: windows ? undefined : 'en_US.UTF-8',
    CI: 'true',
    npm_config_cache: npmCache,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'warn',
  };
  if (windows) {
    Object.assign(env, { USERPROFILE: home, TEMP: tmp, TMP: tmp, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') });
    // What Windows programs (and node-gyp's search for Visual Studio) cannot run without.
    for (const name of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
      if (source[name] !== undefined) env[name] = source[name];
    }
  }
  // A proxy or a private certificate authority is how this machine reaches the network at all.
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'SOURCE_DATE_EPOCH', 'DEVELOPER_DIR']) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  Object.assign(env, extra);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

/** Every file and link under `root`, never following a link. */
export function* walk(root, relative = '') {
  let entries;
  try { entries = readdirSync(join(root, relative), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(root, rel);
    else yield { path: join(root, rel), relative: rel, link: entry.isSymbolicLink() };
  }
}

const MACHO_CPU = { 0x0100000c: 'arm64', 0x01000007: 'x64', 0x00000007: 'ia32', 0x0000000c: 'arm' };
const ELF_CPU = { 62: 'x64', 183: 'arm64', 3: 'ia32', 40: 'arm' };
const PE_CPU = { 0x8664: 'x64', 0x014c: 'ia32', 0xaa64: 'arm64' };

/** Which operating system runs each native format. */
export const FORMAT_PLATFORM = Object.freeze({ macho: 'darwin', elf: 'linux', pe: 'win32' });

/** { format: 'macho' | 'elf' | 'pe', archs } for a native binary, null for anything else. */
export function nativeFormat(path) {
  const head = Buffer.alloc(4096);
  let size = 0;
  let fd;
  try {
    fd = openSync(path, 'r');
    size = readSync(fd, head, 0, head.length, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (size < 64) return null;
  const magic = head.readUInt32BE(0);
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
    return { format: 'macho', archs: [MACHO_CPU[head.readUInt32LE(4)] || 'other'] };
  }
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    // A universal binary lists a few slices; a Java class file has a version here instead.
    const count = head.readUInt32BE(4);
    if (count < 1 || count > 8) return null;
    const width = magic === 0xcafebabf ? 32 : 20;
    const archs = [];
    for (let i = 0; i < count && 8 + i * width + 4 <= size; i++) archs.push(MACHO_CPU[head.readUInt32BE(8 + i * width)] || 'other');
    return { format: 'macho', archs };
  }
  if (magic === 0x7f454c46) return { format: 'elf', archs: [ELF_CPU[head.readUInt16LE(18)] || 'other'] };
  if (head[0] === 0x4d && head[1] === 0x5a) {
    const at = head.readUInt32LE(0x3c);
    if (at + 6 <= size && head.readUInt32LE(at) === 0x00004550) return { format: 'pe', archs: [PE_CPU[head.readUInt16LE(at + 4)] || 'other'] };
  }
  return null;
}

export function removeTree(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}
