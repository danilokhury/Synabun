// "No process has a file or a working directory inside this folder", on each platform, with no dependency.
//   macOS    the system's lsof, one full listing per check, with a positive control: lsof must see the directory
//            descriptor this thread holds, or an empty answer could just mean it saw nothing.
//   Linux    /proc, for this user's processes (workers run as this user; another user's process is not one of them).
//   Windows  renaming a folder fails while a process holds a file or a working directory inside it, so the folder is
//            renamed aside and straight back. A crash in between is put right at the start of the next pass.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Keep } from './scratch-evidence.js';

const run = promisify(execFile);
const LSOF = '/usr/sbin/lsof';
const LSOF_TIMEOUT_MS = 45_000;
const LSOF_MAX_BYTES = 512 * 1024 * 1024;
export const PROBE_SUFFIX = '.retention-probe';
const PROBE_NAME = /^([a-f0-9]{32})\.retention-probe$/;
const IN_USE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

const inside = (name, path) => name === path || name.startsWith(`${path}/`) || name.startsWith(`${path} `);

// lsof prints a byte it considers unprintable as \xNN.
function lsofName(text) {
  const bytes = text.includes('\\x')
    ? text.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    : text;
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

/** Read an lsof -Fpfn listing. Throws Keep when another holder is inside, or when our own descriptor is not seen. */
export function checkLsofListing(output, path, fd, pid = process.pid) {
  const marker = path.slice(path.lastIndexOf('/') + 1);
  let owner = null, descriptor = null, control = false;
  for (let start = 0; start < output.length;) {
    let end = output.indexOf('\n', start);
    if (end < 0) end = output.length;
    const kind = output[start];
    if (kind === 'p') owner = Number(output.slice(start + 1, end));
    else if (kind === 'f') descriptor = output.slice(start + 1, end);
    else if (kind === 'n') {
      const line = output.slice(start + 1, end);
      if (line.includes(marker) && inside(lsofName(line), path)) {
        if (owner === pid && descriptor === String(fd)) control = true;
        else throw new Keep('open-process');
      }
    }
    start = end + 1;
  }
  if (!control) throw new Keep('process-check-unavailable');
}

async function lsofProbe(path, fd) {
  let output;
  try {
    ({ stdout: output } = await run(LSOF, ['-nP', '-w', '-Fpfn'], {
      encoding: 'latin1', maxBuffer: LSOF_MAX_BYTES, timeout: LSOF_TIMEOUT_MS, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' },
    }));
  } catch (error) {
    // lsof exits 1 for a process it could not read; the positive control below says whether the listing is usable.
    if (error?.code !== 1 || typeof error.stdout !== 'string') throw new Keep('process-check-unavailable');
    output = error.stdout;
  }
  checkLsofListing(output, path, fd);
}

async function procProbe(path, fd, { proc = '/proc', uid = process.getuid?.(), pid: self = process.pid, pause = async () => {} } = {}) {
  let control = false;
  const gone = (error) => error?.code === 'ENOENT' || error?.code === 'ESRCH';
  const look = (read) => {
    try { return read(); }
    catch (error) {
      if (gone(error)) return null;
      throw new Keep('process-visibility');
    }
  };
  let pids;
  try { pids = readdirSync(proc).filter((name) => /^\d+$/.test(name)); }
  catch { throw new Keep('process-check-unavailable'); }
  for (const pid of pids) {
    await pause();
    const base = join(proc, pid);
    let owner;
    try { owner = statSync(base).uid; } catch { continue; }
    if (owner !== uid) continue;
    for (const link of ['cwd', 'root', 'exe']) {
      const target = look(() => readlinkSync(join(base, link)));
      if (target && inside(target, path)) throw new Keep('open-process');
    }
    for (const entry of look(() => readdirSync(join(base, 'fd'))) || []) {
      const target = look(() => readlinkSync(join(base, 'fd', entry)));
      if (!target || !inside(target, path)) continue;
      if (Number(pid) === self && entry === String(fd)) control = true;
      else throw new Keep('open-process');
    }
    const maps = look(() => readFileSync(join(base, 'maps'), 'utf8')) || '';
    for (const line of maps.split('\n')) {
      const at = line.indexOf('/');
      if (at >= 0 && inside(line.slice(at), path)) throw new Keep('open-process');
    }
  }
  if (!control) throw new Keep('process-check-unavailable');
}

export function renameProbe(path, { rename = renameSync } = {}) {
  const aside = `${path}${PROBE_SUFFIX}`;
  if (existsSync(aside)) throw new Keep('process-check-unavailable');
  try { rename(path, aside); }
  catch (error) { throw new Keep(IN_USE.has(error?.code) ? 'open-process' : 'process-check-unavailable'); }
  let failure = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rename(aside, path); return; } catch (error) { failure = error; }
  }
  throw new Keep(`probe-not-restored:${failure?.code || 'error'}`);
}

/** A folder a crash left under its probe name goes back, unless something took its name meanwhile. */
export function recoverProbes(root, { platform = process.platform, rename = renameSync } = {}) {
  if (platform !== 'win32') return 0;
  let restored = 0;
  for (const name of readdirSync(root)) {
    const match = PROBE_NAME.exec(name);
    if (!match || existsSync(join(root, match[1]))) continue;
    try { rename(join(root, name), join(root, match[1])); restored += 1; } catch { /* the next pass tries again */ }
  }
  return restored;
}

/** The check for this platform: `(path, fd) => Promise<void>`, throwing Keep when the folder must stay. */
export function createProcessProbe({ platform = process.platform, pause } = {}) {
  if (platform === 'darwin') return lsofProbe;
  if (platform === 'linux') return (path, fd) => procProbe(path, fd, { pause });
  if (platform === 'win32') return async (path) => renameProbe(path);
  return async () => { throw new Keep('process-check-unavailable'); };
}

export { procProbe as _procProbe };
