// ─────────────────────────────────────────────────────────────────────────────
// Every OpenCode listening on this computer, SynaBun's or not.
//
// The native browser boundary (lib/opencode-native-boundary.js) must know about an OpenCode serve someone started in a
// terminal, another app or an earlier SynaBun on ANY port, not only the ports SynaBun chose: a page of a native
// (MoreLogin) context reaches all of them. This module asks the OS which processes listen on TCP (lsof / PowerShell,
// lib/process-identity.js listTcpListenersAsync) and which of them are OpenCode, by what the OS says each process is:
// its name, the executable file it runs and its command line. OpenCode is recognised when installed by Homebrew
// (/opt/homebrew/bin/opencode → Cellar/opencode*/…), by its install script (~/.opencode/bin/opencode), by npm
// (node …/node_modules/opencode-ai/bin/opencode, the platform package opencode-darwin-arm64/bin/opencode) and run from
// source (bun …/packages/opencode/src/index.ts). What it finds is only named, never signalled: SynaBun never stops a
// serve it did not start.
//
// Fail closed: when the OS cannot be asked, answers in part, or a listening process cannot be identified while it
// still runs, the scan is not ok and the boundary refuses the native browser with the reason.
// ─────────────────────────────────────────────────────────────────────────────

import { listTcpListenersAsync, pidExists, readProcessExecutableAsync, readProcessIdentitiesAsync } from './process-identity.js';

// A file name that is OpenCode: opencode, opencode.exe, opencode.js / .mjs / .cjs / .ts, opencode-darwin-arm64 …
const OPENCODE_FILE = /^opencode(?:-(?:darwin|linux|windows|win32)(?:-[\w.]+)*)?(?:\.(?:exe|js|mjs|cjs|ts))?$/i;
// A folder on the way to OpenCode: the npm package, a platform package, a Homebrew keg, a source checkout.
const OPENCODE_DIR = /(?:^|[\\/])(?:opencode-ai|opencode-v\d+|opencode-(?:darwin|linux|windows|win32)(?:-[\w.]+)*|\.opencode|packages[\\/]opencode)(?:[\\/]|$)/i;
// The interpreters OpenCode is run through when it is not its own binary.
const WRAPPER = /^(?:node|nodejs|bun|bunx|deno|npx|tsx|ts-node)(?:\.exe)?$/i;

const baseName = (path) => String(path ?? '').split(/[\\/]/).filter(Boolean).pop() || '';

/** Does a path name an OpenCode program (its file, or a file inside an OpenCode package)? */
export function isOpencodePath(path) {
  const text = String(path ?? '').trim().replace(/^["']|["']$/g, '');
  if (!text) return false;
  // A script inside an OpenCode package (…/opencode-ai/dist/cli.js, …/packages/opencode/src/index.ts) counts; another
  // program that merely lives in such a folder (a language server OpenCode installed) does not.
  return OPENCODE_FILE.test(baseName(text)) || (OPENCODE_DIR.test(text) && /\.(?:[mc]?js|ts)$/i.test(baseName(text)));
}

/**
 * Is a process OpenCode? `{ name, executable, command }` as the OS reports them: its name or executable is OpenCode,
 * or it is an interpreter (node, bun, deno …) whose first script argument is.
 */
export function isOpencodeProcess({ name = '', executable = '', command = '' } = {}) {
  if (OPENCODE_FILE.test(baseName(name)) || isOpencodePath(executable)) return true;
  const words = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  if (isOpencodePath(words[0])) return true;
  const runner = baseName(words[0]);
  if (!WRAPPER.test(runner) && !WRAPPER.test(baseName(executable)) && !WRAPPER.test(baseName(name))) return false;
  // node [flags] <script> …, bun run <script> …: the first word that is not a flag or "run" / "x" / "exec".
  for (const word of words.slice(1, 8)) {
    if (word.startsWith('-') || /^(?:run|x|exec)$/i.test(word)) continue;
    return isOpencodePath(word);
  }
  return false;
}

/**
 * The OpenCode processes listening on TCP now: `{ ok: true, serves: [{ pid, name, startedAt, command, executable,
 * addresses }] }`, or `{ ok: false, detail }` when that cannot be told (fail closed). `selfPid` (this server) is left
 * out. Bounded by the OS queries' own timeouts (5 s each, three in a row at most).
 */
export async function scanOpencodeServes({ selfPid = process.pid, listeners = listTcpListenersAsync, identities = readProcessIdentitiesAsync,
  executable = readProcessExecutableAsync, alive = pidExists } = {}) {
  let listening;
  try { listening = await listeners({ selfPid }); } catch { listening = null; }
  if (!Array.isArray(listening)) return { ok: false, detail: 'the processes listening on TCP could not be listed (lsof, or Get-NetTCPConnection on Windows, failed or answered in part)' };
  if (!listening.length) return { ok: true, serves: [] };
  let ids;
  try { ids = await identities(listening.map((l) => l.pid)); } catch { ids = null; }
  if (!(ids instanceof Map)) return { ok: false, detail: 'the command lines of the processes listening on TCP could not be read (ps)' };
  const serves = [];
  const unknown = [];
  for (const l of listening) {
    const id = ids.get(l.pid);
    if (!id) {
      // Gone since lsof answered: nothing listens any more. Still running and unreadable: it could be OpenCode.
      // pidExists answers null when it cannot tell: that is "still there" here.
      if (alive(l.pid) !== false) unknown.push(l);
      continue;
    }
    const name = l.name || id.name || '';
    if (!id.command) {
      // No command line (Windows: a process of another user, a protected one): only its name says what it is. A name
      // that could be OpenCode, or an interpreter that could run it, cannot be ruled out: refused.
      if (OPENCODE_FILE.test(baseName(name)) || WRAPPER.test(baseName(name)) || !name) unknown.push(l);
      continue;
    }
    // The executable is read for a process that names OpenCode, or runs through an interpreter that could run it.
    let exe = null;
    const named = isOpencodeProcess({ name, command: id.command });
    if (named || WRAPPER.test(baseName(name)) || !name) {
      try { exe = await executable(l.pid); } catch { exe = null; }
    }
    if (!named && !isOpencodeProcess({ name, executable: exe || '', command: id.command })) continue;
    serves.push({ pid: l.pid, name: name || baseName(exe) || null, startedAt: id.startedAt, command: id.command, executable: exe, addresses: l.addresses });
  }
  if (unknown.length) {
    const list = unknown.map((l) => `pid ${l.pid} (${l.name || ids.get(l.pid)?.name || 'unnamed'}) on port ${l.addresses.map((a) => a.port).join(', ')}`).join('; ');
    return { ok: false, detail: `a process listening on TCP could not be identified, so it could be an OpenCode serve: ${list}` };
  }
  return { ok: true, serves };
}

/** What names one listening process at one moment: its pid, its start time and the sockets it listens on. */
export function listenerGenerationKey({ pid, startedAt, addresses = [] } = {}) {
  const socks = (Array.isArray(addresses) ? addresses : []).map((a) => `${String(a.host).toLowerCase()}:${a.port}`).sort().join(',');
  return `${pid}|${startedAt || '?'}|${socks}`;
}
