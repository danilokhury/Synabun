// ─────────────────────────────────────────────────────────────────────────────
// Which process a pid is.
//
// The OS gives a pid to a new process once the old one is gone: a server
// SynaBun started and recorded by its pid may have exited, and that number now
// belong to another program. A pid together with the time its process started
// and its command line, as the OS reports them, names one process and no other.
// SynaBun records all three when it starts a server (readProcessIdentity) and
// signals that pid only while the OS still reports the same three
// (sameProcess), checked again right before each signal. A process whose
// identity cannot be read is never taken for SynaBun's.
//
// A start time to the second can still be shared by two processes, and a pid,
// a start time and a command line mean something only on the machine, for the
// user and in the boot they were read in. So a serve SynaBun spawns also
// carries a random token in its environment (SERVE_TOKEN_ENV, newServeToken),
// which the OS gives back for the user's own processes (readEnvironmentHas:
// `ps -E` on macOS, /proc/<pid>/environ on Linux; Windows cannot read another
// process's environment, and its start times are to the fraction of a second),
// and every record says where it was written (readHostScope: the machine's id,
// the user, the boot). The parent chain (readProcessParentAsync) and the
// listeners of a port (listPortListenersAsync) tell whether what answers on a
// port is a process SynaBun spawned, or one that process started.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The environment variable that carries the token of a serve SynaBun spawned. */
export const SERVE_TOKEN_ENV = 'SYNABUN_SERVE_TOKEN';

/** A fresh token for one spawn: 128 random bits, hex. */
export function newServeToken() {
  return randomBytes(16).toString('hex');
}

// `ps -o uid= -o lstart=` in the C locale and UTC: "  501 Tue Oct 21 04:12:50 2026" (the day may be padded with a
// space). The uid is optional here: a test may hand in what an older query printed.
const PS_LINE = /^(?:(\d+)\s+)?(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*)$/;
const PS_PARENT = /^(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})$/;
// One locale and one time zone, so a record reads the same after either changes.
const C_ENV = () => ({ ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' });

const pidOf = (pid) => {
  const n = Number(pid);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const firstLine = (out) => String(out ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '';

function powershell(script, timeout = 8000) {
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], options: { encoding: 'utf8', timeout, windowsHide: true } };
}

// What asks the OS about one pid: `ps -ww -o uid= -o lstart= -o command=` (the user, the start time to the second,
// the whole command line) on macOS and Linux; the process's CreationDate and CommandLine (CIM, through PowerShell)
// on Windows.
function identityQuery(n, platform) {
  if (platform === 'win32') {
    return powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine }`);
  }
  return {
    file: 'ps',
    args: ['-ww', '-o', 'uid=', '-o', 'lstart=', '-o', 'command=', '-p', String(n)],
    options: { encoding: 'utf8', timeout: 5000, env: C_ENV() },
  };
}

function parseIdentity(n, platform, out) {
  const text = String(out ?? '');
  if (platform === 'win32') {
    const [first = '', ...rest] = text.split(/\r?\n/);
    const startedAt = first.trim();
    const command = rest.join('\n').trim();
    return startedAt && command ? { pid: n, startedAt, command } : null;
  }
  const match = PS_LINE.exec(firstLine(text));
  if (!match) return null;
  const identity = { pid: n, startedAt: match[2].replace(/\s+/g, ' '), command: match[3].trim() };
  if (match[1] != null) identity.uid = match[1];
  return identity;
}

/**
 * `{ pid, startedAt, command }` of a running process (`uid` too on macOS and Linux), or null: gone, or the OS could
 * not be asked. macOS and Linux: `ps -ww -o uid= -o lstart= -o command=` (the start time to the second, the whole
 * command line); Windows: the process's CreationDate (to the fraction of a second) and CommandLine (CIM, through
 * PowerShell).
 * @param {number} pid
 * @param {{ platform?: string, run?: typeof execFileSync }} [o] `run`: tests hand in what the OS would answer
 */
export function readProcessIdentity(pid, { platform = process.platform, run = execFileSync } = {}) {
  const n = pidOf(pid);
  if (!n) return null;
  const query = identityQuery(n, platform);
  try {
    return parseIdentity(n, platform, run(query.file, query.args, { ...query.options, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // ps exits 1 for a pid nothing runs under; a missing ps or PowerShell is "could not be asked".
    return null;
  }
}

/**
 * readProcessIdentity without holding the event loop while the OS answers (PowerShell takes about a second):
 * for a look that may read several pids, such as the sweep of SynaBun's leftover serves.
 * @param {number} pid
 * @param {{ platform?: string, run?: (file: string, args: string[], options: object) => Promise<string> }} [o]
 */
export async function readProcessIdentityAsync(pid, { platform = process.platform, run = runFile } = {}) {
  const n = pidOf(pid);
  if (!n) return null;
  const query = identityQuery(n, platform);
  try {
    return parseIdentity(n, platform, await run(query.file, query.args, query.options));
  } catch {
    return null;
  }
}

function runFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout)));
  });
}

/** Is `current` (readProcessIdentity now) the process `recorded` was: the same pid, start time and command line? */
export function sameProcess(recorded, current) {
  if (!recorded || !current || !recorded.startedAt || !recorded.command) return false;
  return Number(recorded.pid) === Number(current.pid)
    && String(recorded.startedAt) === String(current.startedAt)
    && String(recorded.command) === String(current.command);
}

/**
 * Does any process run under `pid`? true, false (none: the OS said so), or null (it could not be told). Signal 0
 * sends nothing: the OS only checks the pid. A process of another user answers EPERM, which is a process too.
 * @param {number} pid
 * @param {{ kill?: (pid: number, signal: number | string) => void }} [o]
 */
export function pidExists(pid, { kill = (p, s) => process.kill(p, s) } = {}) {
  const n = pidOf(pid);
  if (!n) return false;
  try {
    kill(n, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
  }
}

// ── The environment a process started with ──────────────────────────────────

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VALUE = /^[A-Za-z0-9_.:-]+$/;

// macOS prints the environment after the command line (`ps -E`) only for a process it lets the user read: the
// user's own, and not a binary of the system's. The line must start with the command line read for the identity
// (else the pid is another process's by now), and hold more than that (else the environment was not shown).
function parseEnvironmentHas(out, command, name, value) {
  const text = firstLine(out);
  const plain = String(command ?? '').trim();
  if (!plain || !text.startsWith(plain)) return null;
  const environment = text.slice(plain.length);
  if (!environment.trim()) return null;
  return new RegExp(`(?:^|\\s)${name}=${value}(?=\\s|$)`).test(environment);
}

function linuxEnvironmentHas(n, name, value, readFile) {
  let text;
  try { text = readFile(`/proc/${n}/environ`, 'utf8'); } catch { return null; } // gone, or another user's
  const vars = String(text).split('\0').filter(Boolean);
  if (!vars.length) return null; // a process that has ended shows none
  return vars.includes(`${name}=${value}`);
}

function environmentQuery(n) {
  return { file: 'ps', args: ['-E', '-ww', '-o', 'command=', '-p', String(n)], options: { encoding: 'utf8', timeout: 5000, env: C_ENV() } };
}

/**
 * Does the environment `pid` started with hold `name=value`? true, false (it was read, and does not), or null (it
 * could not be read: gone, another user's, or the OS does not say). macOS: `ps -E`, given the command line just
 * read for the process's identity; Linux: /proc/<pid>/environ; Windows and anything else: null.
 * @param {number} pid
 * @param {string} name
 * @param {string} value
 * @param {{ command?: string, platform?: string, run?: typeof execFileSync, readFile?: typeof readFileSync }} [o]
 */
export function readEnvironmentHas(pid, name, value, { command = '', platform = process.platform, run = execFileSync, readFile = readFileSync } = {}) {
  const n = pidOf(pid);
  if (!n || !ENV_NAME.test(String(name)) || !ENV_VALUE.test(String(value))) return null;
  if (platform === 'linux') return linuxEnvironmentHas(n, name, value, readFile);
  if (platform !== 'darwin') return null;
  const query = environmentQuery(n);
  try {
    return parseEnvironmentHas(run(query.file, query.args, { ...query.options, stdio: ['ignore', 'pipe', 'ignore'] }), command, name, value);
  } catch {
    return null;
  }
}

/** readEnvironmentHas without holding the event loop while the OS answers. */
export async function readEnvironmentHasAsync(pid, name, value, { command = '', platform = process.platform, run = runFile, readFile = readFileSync } = {}) {
  const n = pidOf(pid);
  if (!n || !ENV_NAME.test(String(name)) || !ENV_VALUE.test(String(value))) return null;
  if (platform === 'linux') return linuxEnvironmentHas(n, name, value, readFile);
  if (platform !== 'darwin') return null;
  const query = environmentQuery(n);
  try {
    return parseEnvironmentHas(await run(query.file, query.args, query.options), command, name, value);
  } catch {
    return null;
  }
}

// ── Where: the machine, the user, the boot ──────────────────────────────────

const WINDOWS_SCOPE = "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid; "
  + "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); "
  + '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value';

const clean = (v) => {
  const text = String(v ?? '').trim();
  return text || null;
};

function uidOf(getuid) {
  try { const uid = getuid?.(); return Number.isInteger(uid) && uid >= 0 ? String(uid) : null; } catch { return null; }
}

function readFirst(readFile, paths) {
  for (const path of paths) {
    try { const text = clean(readFile(path, 'utf8')); if (text) return text; } catch { /* the next one */ }
  }
  return null;
}

const machineFromIoreg = (out) => clean(/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(String(out ?? ''))?.[1]);
const bootFromBoottime = (out) => {
  const sec = /sec\s*=\s*(\d+)/.exec(String(out ?? ''))?.[1];
  return sec ? `boottime:${sec}` : null;
};
function scopeFromPowershell(out) {
  const [machine, boot, uid] = String(out ?? '').split(/\r?\n/).map(clean);
  return { machine: machine || null, uid: uid || null, boot: boot || null };
}

/**
 * Where a record is written, and for whom: `{ machine, uid, boot }`, each a string, or null where the OS could not
 * tell. macOS: the platform UUID (ioreg), the user's uid, the boot session's UUID (kern.bootsessionuuid; the boot
 * time when that is missing); Linux: /etc/machine-id, the uid, /proc/sys/kernel/random/boot_id; Windows: the
 * MachineGuid, the user's SID and the last boot time (one PowerShell).
 * @param {{ platform?: string, run?: typeof execFileSync, readFile?: typeof readFileSync, getuid?: () => number }} [o]
 */
export function readHostScope({ platform = process.platform, run = execFileSync, readFile = readFileSync, getuid = process.getuid } = {}) {
  const ask = (file, args, timeout = 5000) => {
    try { return run(file, args, { encoding: 'utf8', timeout, env: C_ENV(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
  };
  if (platform === 'darwin') {
    return {
      machine: machineFromIoreg(ask('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])),
      uid: uidOf(getuid),
      boot: clean(ask('sysctl', ['-n', 'kern.bootsessionuuid'])) || bootFromBoottime(ask('sysctl', ['-n', 'kern.boottime'])),
    };
  }
  if (platform === 'linux') {
    return {
      machine: readFirst(readFile, ['/etc/machine-id', '/var/lib/dbus/machine-id']),
      uid: uidOf(getuid),
      boot: readFirst(readFile, ['/proc/sys/kernel/random/boot_id']),
    };
  }
  if (platform === 'win32') {
    const query = powershell(WINDOWS_SCOPE, 15000);
    return scopeFromPowershell(ask(query.file, query.args, 15000));
  }
  return { machine: null, uid: uidOf(getuid), boot: null };
}

/** readHostScope without holding the event loop while the OS answers (PowerShell takes about a second). */
export async function readHostScopeAsync({ platform = process.platform, run = runFile, readFile = readFileSync, getuid = process.getuid } = {}) {
  const ask = async (file, args, timeout = 5000) => {
    try { return await run(file, args, { encoding: 'utf8', timeout, env: C_ENV(), windowsHide: true }); } catch { return null; }
  };
  if (platform === 'darwin') {
    const [ioreg, session] = await Promise.all([ask('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']), ask('sysctl', ['-n', 'kern.bootsessionuuid'])]);
    return {
      machine: machineFromIoreg(ioreg),
      uid: uidOf(getuid),
      boot: clean(session) || bootFromBoottime(await ask('sysctl', ['-n', 'kern.boottime'])),
    };
  }
  if (platform === 'win32') {
    const query = powershell(WINDOWS_SCOPE, 15000);
    return scopeFromPowershell(await ask(query.file, query.args, 15000));
  }
  return readHostScope({ platform, readFile, getuid });
}

// ── The parent chain, and who listens on a port ─────────────────────────────

/**
 * The parent of a running process and when the process started: `{ pid, ppid, startedAt }`, or null (gone, or the
 * OS could not be asked). macOS and Linux: `ps -o ppid= -o lstart=`; Windows: CIM's ParentProcessId and CreationDate
 * (a parent pid Windows keeps after that parent ended: the caller compares start times).
 * @param {number} pid
 * @param {{ platform?: string, run?: (file: string, args: string[], options: object) => Promise<string> }} [o]
 */
export async function readProcessParentAsync(pid, { platform = process.platform, run = runFile } = {}) {
  const n = pidOf(pid);
  if (!n) return null;
  try {
    if (platform === 'win32') {
      const query = powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}"; if ($p) { $p.ParentProcessId; $p.CreationDate.ToUniversalTime().ToString('o') }`);
      const [ppid = '', startedAt = ''] = String(await run(query.file, query.args, query.options)).split(/\r?\n/).map((l) => l.trim());
      return /^\d+$/.test(ppid) && startedAt ? { pid: n, ppid: Number(ppid), startedAt } : null;
    }
    const out = await run('ps', ['-o', 'ppid=', '-o', 'lstart=', '-p', String(n)], { encoding: 'utf8', timeout: 5000, env: C_ENV() });
    const match = PS_PARENT.exec(firstLine(out));
    return match ? { pid: n, ppid: Number(match[1]), startedAt: match[2].replace(/\s+/g, ' ') } : null;
  } catch {
    return null;
  }
}

/**
 * The pids that listen on a local TCP port: a list (empty: nothing listens that the user may see), or null when the
 * OS could not be asked. macOS and Linux: lsof (exit 1 with nothing printed is "none"; no lsof is null); Windows:
 * Get-NetTCPConnection, where an empty answer is null too (it lists every user's listeners: something answered on
 * the port a moment ago).
 * @param {number} port
 * @param {{ platform?: string, run?: (file: string, args: string[], options: object) => Promise<string> }} [o]
 */
export async function listPortListenersAsync(port, { platform = process.platform, run = runFile, selfPid = process.pid } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
  const pidsIn = (out) => [...new Set(String(out ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number))]
    .filter((n) => n > 0 && n !== selfPid);
  if (platform === 'win32') {
    const query = powershell(`Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }`);
    try {
      const pids = pidsIn(await run(query.file, query.args, query.options));
      return pids.length ? pids : null;
    } catch {
      return null;
    }
  }
  try {
    return pidsIn(await run('lsof', ['-nP', `-tiTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000, env: C_ENV() }));
  } catch (error) {
    // lsof exits 1 when nothing matched, and for some errors too: nothing printed but a warning is "cannot be told".
    if (error?.code !== 1) return null;
    const pids = pidsIn(error.stdout);
    if (pids.length) return pids;
    return String(error.stderr ?? '').trim() ? null : [];
  }
}
