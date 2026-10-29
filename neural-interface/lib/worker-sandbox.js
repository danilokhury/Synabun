// ═══════════════════════════════════════════
// SynaBun — macOS Seatbelt isolation for guarded worker trees (pure + small fs)
// ═══════════════════════════════════════════
//
// A dispatched worker (capability read-only / workspace, Protect workers = Enforce) can reach SynaBun's own control
// listener on localhost:<NEURAL_PORT> from any program it runs — node -e, python, a script, a detached process —
// fetch the owner's page cookie, and act as the owner (dispatch a full worker, turn Protect workers off, install a
// skill). The in-code shell guard is only a speed bump: arbitrary code is opaque to it.
//
// On macOS the real boundary is the OS: run the worker's whole process tree under sandbox-exec with a profile that
// blocks outbound connections to SynaBun's control port (and the other local endpoints that can relay commands or
// owner authority), while leaving everything legitimate working — the internet, reads anywhere, writes per
// capability, the project's tests, and the worker's own SynaBun MCP tools, which reach SynaBun through a worker-only
// channel on a port the profile leaves open (see lib/worker-mcp-channel.js).
//
// Proven on macOS 26 (scratch probes, 2026-10-23 / 2026-10-24), the facts this module relies on:
//   • `(deny network-outbound (remote ip "*:<port>"))` blocks that port on EVERY host — 127.0.0.1, localhost, ::1,
//     [::ffff:127.0.0.1] (the IPv4-mapped IPv6 form a dual-stack app.listen answers on), 0.0.0.0, this Mac's LAN /
//     interface IPs and its hostname — while a different port and the public internet stay open. The earlier
//     `localhost:<port>` literal did NOT cover [::ffff:127.0.0.1] (a verified full bypass of the whole layer on the
//     dual-stack listener): Seatbelt's `localhost` resolves to 127.0.0.1 + ::1 only. The host literal must be `*`
//     or `localhost` (a numeric IP literal is rejected by the parser); `*` is the only form that is address-proof.
//     Seatbelt has no port-range syntax (`*:4120-4400` is rejected), so a reserved range is emitted one port a line.
//   • `(deny file-read* file-write* (subpath "<canonical>"))` blocks reads AND writes under a path; a later
//     `(allow file-read* file-write* (subpath "<canonical>"))` wins (Seatbelt is last-match-wins within a filter),
//     so SynaBun's whole data home can be denied and the run's own scratch / cwd / config folder allowed back after
//     it. Seatbelt matches the RESOLVED path, so every literal must be canonicalised (/tmp is a symlink to
//     /private/tmp; an un-resolved literal never matches, and an allow-back must resolve the same way as its deny).
//   • The sandbox is inherited by detached / nohup grandchildren, so a worker cannot escape it by backgrounding.
//   • A same-user `KERN_PROCARGS2` read (ps -E / a tiny C program) CANNOT be blocked by Seatbelt (it is a same-uid
//     kernel allowance, not a sandbox-governed operation). So a worker inside the sandbox can still read another
//     same-user process's argv+env — including a brain's SYNABUN_BRAIN_TOKEN, or a relay's password in env. That
//     theft is harmless here because the token/password is useless without reaching a port this profile blocks on
//     every address; a Codex worker (which this module cannot wrap — nested sandbox-exec is refused) is held by
//     running with its network off instead.
//
// This module is macOS-only. On every other platform sandboxSupported() is false; and even on macOS the caller
// gates on sandboxExecAvailable() (a one-time boot probe that /usr/bin/sandbox-exec exists and runs a trivial
// allow-default profile), falling back to the in-code guard alone when it does not. Pure but for canonicalising
// paths, the boot probe, and writing the profile / wrapper into a run's own scratch folder; unit-tested in
// tests/worker-sandbox.test.mjs.
//
// NOT EQUIVALENT OFF macOS (stated plainly; HIGH elsewhere). Where this module does not apply — Linux, Windows, or a
// macOS host whose sandbox-exec is unavailable — a protected (Enforce, read-only/workspace) worker is held only by the
// in-code guard (the shell heuristic + the tool hooks), which reads the command line only and so is a lexical
// speed-bump, not a boundary: a script file (`node /path/x.js`), hidden-address inline code, or any program doing its
// own networking slips past it. Two things the macOS profile closes that nothing else does there: (a) SynaBun's
// OpenCode serve band 4096-4400 is unblocked, so a worker's script can connect to a serve; (b) a SHARED (non-protected)
// serve keeps its OPENCODE_PASSWORD in its process environment (lib/opencode-protocol.js serveSpecFor env mode; only a
// protected worker's OWN isolated serve hides it via passwordFrom 'stdout'), and a same-uid process can read another
// process's environment (KERN_PROCARGS2 / /proc/<pid>/environ) — a read no sandbox blocks — so a prompt-injected worker
// off macOS could read that password and open a full-control session on the shared serve. On macOS under Enforce the
// 4096-4400 deny (plus the data-home/credential denies below) is the real boundary that stops both. The protected-
// worker IN-FOLDER confinement off macOS is therefore best-effort, not a guarantee. See docs/assistant.md → Worker
// confinement → "Protected-worker in-folder confinement off macOS is NOT equivalent to macOS".

import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/**
 * The ports the internet needs (SSH, DNS, HTTP, HTTPS). A relay found listening on one of them is denied on this
 * computer's own addresses only (`localhost:<port>`: 127.0.0.1, ::1, every interface address and the hostname —
 * not the IPv4-mapped spelling, which only `*` covers), never with `*:<port>`, which would cut the worker's internet.
 * The strict profile (detection failed) allows exactly these, plus the worker channel.
 */
export const INTERNET_PORTS = Object.freeze([22, 53, 80, 443]);
/** Local ports no guarded worker has a reason to open: SSH to this computer (Remote Login) is a shell outside the
 *  sandbox. Denied on this computer's own addresses in every guarded profile; ssh to other hosts is untouched. */
export const ALWAYS_LOCAL_DENY_PORTS = Object.freeze([22]);

/** macOS only: the platform where the Seatbelt primitives above hold. A cheap pure check for tests and early gates. */
export function sandboxSupported(platform = process.platform) {
  return platform === 'darwin';
}

// Whether /usr/bin/sandbox-exec exists AND runs a trivial allow-default profile: probed once (cheap, ~15 ms) and
// cached, so a host where Seatbelt is missing or broken falls back to the in-code guard instead of failing every
// guarded worker. null = not yet probed.
let _sandboxExecProbe = null;
/**
 * macOS AND sandbox-exec works. Cached after the first probe. The caller (server.js) gates OS isolation on this,
 * never on sandboxSupported() alone, so a missing / broken sandbox-exec is a visible fall-back, not a launch failure.
 */
export function sandboxExecAvailable({ platform = process.platform, spawn = spawnSync, force = false } = {}) {
  if (!sandboxSupported(platform)) return false;
  if (_sandboxExecProbe !== null && !force) return _sandboxExecProbe;
  let ok = false;
  try {
    if (existsSync(SANDBOX_EXEC)) {
      const r = spawn(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' });
      ok = !r.error && r.status === 0 && !r.signal;
    }
  } catch { ok = false; }
  _sandboxExecProbe = ok;
  return ok;
}
/** Tests only: forget the cached probe result. */
export function _resetSandboxExecProbe() { _sandboxExecProbe = null; }

/** A Seatbelt string literal: double-quoted, with `\` and `"` escaped. */
function sexpr(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Where a path really is (Seatbelt matches the resolved path); the deepest existing ancestor resolved, rest as named. */
export function canonicalPath(abs) {
  let probe = isAbsolute(abs) ? abs : resolve(abs);
  const rest = [];
  for (let i = 0; i < 256; i++) {
    try { const real = realpathSync(probe); return rest.length ? join(real, ...rest.reverse()) : real; }
    catch { const parent = dirname(probe); if (parent === probe) return resolve(abs); rest.push(probe.slice(parent.length).replace(/^[/\\]+/, '')); probe = parent; }
  }
  return resolve(abs);
}

/** Valid, deduped, sorted ports from a list. */
function cleanPorts(ports) {
  return [...new Set((ports || []).map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536))].sort((a, b) => a - b);
}

/**
 * The ancestor DIRECTORIES of each allow-back that fall inside a denied tree. `(deny file-read* (subpath X))` denies
 * metadata too, so when a run's scratch folder is allowed back under a denied data home, node cannot even `lstat`
 * the denied ancestors (/dataHome, /dataHome/data, /dataHome/data/scratch) to resolve a path there — it fails EPERM
 * before it runs a script. Granting `file-read-metadata` on those exact directory nodes (a literal, not a subpath:
 * the directory itself, never its contents) lets the lookup through without exposing any file in the denied tree.
 * Canonical in, canonical out (the allow paths are already canonical, so their dirname chain is too).
 */
function metadataAncestors(allowPaths, denyPaths) {
  const denies = denyPaths.map((p) => (p.endsWith('/') ? p.slice(0, -1) : p)).filter(Boolean);
  const insideADeny = (dir) => denies.some((d) => dir === d || dir.startsWith(d + '/'));
  const out = new Set();
  for (const allow of allowPaths) {
    let dir = dirname(allow);
    for (let i = 0; i < 256; i++) {
      if (insideADeny(dir)) out.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...out];
}

/**
 * The Seatbelt profile for a guarded worker tree.
 * @param {object} o
 * @param {number[]} o.denyPorts individual ports to block OUTBOUND to, on EVERY host (NEURAL_PORT + its WebSockets,
 *                               the launch beacon, the shared OpenCode serve). The worker-only MCP channel port is
 *                               NOT here — the profile must leave it open.
 * @param {{from:number,to:number}} [o.denyPortRange] a reserved range (SynaBun's isolated OpenCode serves) blocked
 *                               in FULL, so a relay started after this profile is written is already denied. Each
 *                               port in it is a line (Seatbelt has no range syntax).
 * @param {string[]} [o.denyPaths] folders / files whose reads AND writes are denied (SynaBun's whole data home, the
 *                               other runtimes' credential files this run does not use). Each is canonicalised.
 * @param {string[]} [o.allowPaths] folders allowed back AFTER the denies (the run's own scratch / cwd / config), so
 *                               a path under a denied tree the run truly needs survives. Canonicalised; placed last
 *                               (last match wins).
 * @param {number[]} [o.denyLocalPorts] ports blocked OUTBOUND on this computer's own addresses only (`localhost:<port>`):
 *                               a relay found on an internet port (22, 53, 80, 443), and local SSH.
 * @param {{ allowPorts:number[] }} [o.strictLocal] relay detection FAILED for this run: no outbound connection at all
 *                               but the internet's ports (INTERNET_PORTS, on other hosts) and the worker channel
 *                               (`allowPorts`, on this computer). `*:*` is the only rule that covers every local
 *                               spelling (the IPv4-mapped one included); Seatbelt's `localhost` misses [::ffff:…],
 *                               and mixing `ip6` rules with `localhost` ones silently re-opens IPv4 loopback (verified
 *                               on macOS 26), so this is written as deny-all-then-allow, never as a loopback deny.
 * @param {string} [o.note] a short comment line (the run id), for readability in a log.
 * @returns {string} the profile text (ends with a newline).
 */
export function buildWorkerSandboxProfile({ denyPorts = [], denyLocalPorts = [], denyPortRange = null, denyPaths = [], allowPaths = [], note = '', strictLocal = null } = {}) {
  const localOnly = new Set(cleanPorts(denyLocalPorts));
  // A port the internet needs is never denied on every host: it goes to the local-only list instead.
  const ports = cleanPorts(denyPorts).filter((p) => { if (INTERNET_PORTS.includes(p)) { localOnly.add(p); return false; } return true; });
  const range = denyPortRange && Number.isInteger(Number(denyPortRange.from)) && Number.isInteger(Number(denyPortRange.to))
    ? { from: Math.max(1, Number(denyPortRange.from)), to: Math.min(65535, Number(denyPortRange.to)) } : null;
  const denies = [...new Set((denyPaths || []).filter((p) => typeof p === 'string' && p).map(canonicalPath))];
  const allows = [...new Set((allowPaths || []).filter((p) => typeof p === 'string' && p).map(canonicalPath))];
  const lines = ['(version 1)'];
  if (note) lines.push(`; ${String(note).replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
  lines.push('(allow default)');
  if (strictLocal) {
    // Detection failed: nothing local is known to be safe, so nothing local is reachable but the worker channel.
    // Deny every outbound IP connection, allow the internet's ports back on every host, take them away again on this
    // computer's own addresses, and allow the channel last (last match wins).
    lines.push('; strict: the relay detection failed for this run, so no local port is reachable but the worker channel');
    lines.push(`(deny network-outbound (remote ip ${sexpr('*:*')}))`);
    for (const port of INTERNET_PORTS) lines.push(`(allow network-outbound (remote ip ${sexpr(`*:${port}`)}))`);
    for (const port of INTERNET_PORTS) if (port !== 53) localOnly.add(port); // a local DNS resolver stays reachable
    for (const port of cleanPorts(strictLocal.allowPorts)) {
      localOnly.delete(port);
      lines.push(`(allow network-outbound (remote ip ${sexpr(`localhost:${port}`)}))`);
    }
  }
  // The control ports: a worker's own programs may not open them (its MCP tools are the way in). `*:<port>` blocks
  // the port on every address (127.0.0.1, ::1, [::ffff:127.0.0.1], 0.0.0.0, the LAN IPs, the hostname); the public
  // internet and every other port stay open.
  const seen = new Set();
  for (const port of ports) { seen.add(port); lines.push(`(deny network-outbound (remote ip ${sexpr(`*:${port}`)}))`); }
  // Local-only denies (an internet port a relay holds here, local SSH): this computer's own addresses, never the internet.
  for (const port of [...new Set([...localOnly, ...ALWAYS_LOCAL_DENY_PORTS])].sort((x, y) => x - y)) {
    if (strictLocal && cleanPorts(strictLocal.allowPorts).includes(port)) continue;
    lines.push(`(deny network-outbound (remote ip ${sexpr(`localhost:${port}`)}))`);
  }
  // The reserved relay range in full: every isolated OpenCode serve, whether it started before or after this profile.
  if (range) for (let p = range.from; p <= range.to; p++) { if (!seen.has(p)) { seen.add(p); lines.push(`(deny network-outbound (remote ip ${sexpr(`*:${p}`)}))`); } }
  // SynaBun's whole data home (its auth secrets, other runs' task text, the memory DB) and other runtimes' creds:
  // a worker neither reads nor writes them.
  for (const path of denies) lines.push(`(deny file-read* file-write* (subpath ${sexpr(path)}))`);
  // Allowed back LAST (last match wins): the run's own scratch folder, its cwd when that is inside the data home
  // (skill-drafting workspaces), and its OpenCode config folder — everything the run legitimately needs there.
  for (const path of allows) lines.push(`(allow file-read* file-write* (subpath ${sexpr(path)}))`);
  // Metadata-only on the denied ancestors of each allow-back, so `node scratch/probe.mjs` can lstat its way in
  // (without this, a denied data-home ancestor fails EPERM before the script runs). Directory nodes only (literal),
  // placed after the file allow-backs so this metadata grant is the last match for those paths.
  for (const dir of metadataAncestors(allows, denies)) lines.push(`(allow file-read-metadata (literal ${sexpr(dir)}))`);
  return `${lines.join('\n')}\n`;
}

/** sandbox-exec argv to run `command args…` under a written profile (OpenCode's serve launch). */
export function sandboxExecArgv(profilePath, command, args = []) {
  return [SANDBOX_EXEC, '-f', profilePath, command, ...(Array.isArray(args) ? args : [])];
}

/**
 * Write a run's Seatbelt profile and (for a CLI the Agent SDK spawns directly) a wrapper script that execs the real
 * executable under it. The SDK uses pathToClaudeCodeExecutable verbatim with shell:false, so the wrapper is a plain
 * shebang script that forwards its arguments; the sandbox is inherited by everything the CLI then starts.
 *
 * @param {object} o
 * @param {string} o.dir      a folder the run owns (its scratch folder): the profile and wrapper live here.
 * @param {string} o.profile  the profile text (buildWorkerSandboxProfile).
 * @param {string} [o.realExecutable] the executable the wrapper should exec (for Claude); omit for OpenCode.
 * @param {string} [o.nodeRunner] the node to run a `.js` entry with (default process.execPath); only used when the
 *                 real executable is a script the Agent SDK would itself have run via node (.js / .mjs / …).
 * @param {string} [o.name]   a basename stem (default 'worker').
 * @returns {{ profilePath: string, wrapperPath: string|null }}
 *
 * The wrapper must be named so the Agent SDK spawns it DIRECTLY (not via node): the SDK runs a
 * pathToClaudeCodeExecutable that ends in .js/.mjs/.ts/.tsx/.jsx through `node`, anything else directly. `.sh`
 * is spawned directly, so the wrapper execs sandbox-exec itself. If the REAL executable is such a script, the
 * wrapper runs it under node (what the SDK would have done), so the sandbox still wraps the whole tree.
 */
export function writeWorkerSandbox({ dir, profile, realExecutable = null, nodeRunner = process.execPath, name = 'worker' }) {
  if (!dir) throw new Error('writeWorkerSandbox needs a directory the run owns');
  mkdirSync(dir, { recursive: true });
  const stem = String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'worker';
  const profilePath = join(dir, `${stem}.sb`);
  writeFileSync(profilePath, profile, { mode: 0o600 });
  let wrapperPath = null;
  if (realExecutable) {
    wrapperPath = join(dir, `${stem}-wrap.sh`);
    // exec, so the wrapper process is replaced by sandbox-exec (no extra shell in the tree). "$@" forwards argv
    // verbatim. The real executable (and node, when the entry is a script) and the profile are single-quoted.
    const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const isScript = /\.(?:mjs|cjs|js|ts|tsx|jsx)$/i.test(realExecutable);
    const runTarget = isScript ? `${sh(nodeRunner)} ${sh(realExecutable)}` : sh(realExecutable);
    writeFileSync(wrapperPath, `#!/bin/sh\nexec ${sh(SANDBOX_EXEC)} -f ${sh(profilePath)} ${runTarget} "$@"\n`, { mode: 0o700 });
    chmodSync(wrapperPath, 0o700);
  }
  return { profilePath, wrapperPath };
}

/**
 * Everything a guarded Claude / OpenCode run needs for OS isolation, or null when it does not apply (not macOS, no
 * guard, warn / off, or the capability is full). The caller gathers the data-home trees and other-runtime creds to
 * deny and the run's own folders to allow back; this assembles the port set and gates on an enforced guard. Writing
 * is left to the caller (writeWorkerSandbox) so a failure to write never throws on the launch path — the caller
 * falls back to the in-code guard and says so.
 * @param {{ allowPorts:number[] }} [o.strictLocal] the relay detection failed: the strict profile (see
 *   buildWorkerSandboxProfile), with `allowPorts` the worker channel.
 * @returns {{ denyPorts:number[], denyLocalPorts:number[], denyPortRange:{from,to}|null, denyPaths:string[], allowPaths:string[], note:string, strictLocal:object|null } | null}
 */
export function workerSandboxPlan({ confinement, serverPort = null, reservedPortRange = null, extraDenyPorts = [], denyPaths = [], allowPaths = [], strictLocal = null, platform = process.platform } = {}) {
  if (!sandboxSupported(platform)) return null;
  if (!confinement || !confinement.enforced) return null; // only an enforced guard (read-only / workspace) is wrapped
  const denyPorts = [];
  const denyLocalPorts = [];
  const own = Number(serverPort || confinement.serverPort) || null;
  if (own) denyPorts.push(own);
  for (const p of extraDenyPorts || []) {
    const n = Number(p);
    if (!(n > 0)) continue;
    // A relay on an internet port is denied on this computer's addresses only; the internet keeps the port.
    if (INTERNET_PORTS.includes(n)) denyLocalPorts.push(n); else denyPorts.push(n);
  }
  const strictAllow = strictLocal ? cleanPorts(strictLocal.allowPorts) : [];
  return {
    denyPorts: [...new Set(denyPorts)],
    denyLocalPorts: [...new Set(denyLocalPorts)],
    denyPortRange: reservedPortRange && Number(reservedPortRange.from) > 0 && Number(reservedPortRange.to) > 0
      ? { from: Number(reservedPortRange.from), to: Number(reservedPortRange.to) } : null,
    denyPaths: [...new Set((denyPaths || []).filter(Boolean))],
    allowPaths: [...new Set((allowPaths || []).filter(Boolean))],
    note: `synabun worker ${confinement.capability} (${confinement.mode})${strictLocal ? ' strict' : ''}`,
    strictLocal: strictLocal ? { allowPorts: strictAllow } : null,
  };
}
