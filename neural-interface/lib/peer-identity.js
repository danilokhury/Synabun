// ═══════════════════════════════════════════
// SynaBun — who is at the other end of a loopback connection (owner authority by peer-process identity)
// ═══════════════════════════════════════════
//
// The owner's authority over SynaBun is the page secret (lib/page-session.js): an HttpOnly cookie the server hands
// to the app's own pages and asks of every owner write. Markers (a cookie and a header SynaBun's automation browser
// carries) and port denylists (lib/worker-sandbox.js, lib/worker-relay-ports.js) keep a worker from getting it, and
// each kept leaking at an edge: a host spelling the marker test missed, a service worker the browser's request
// interception never sees, a local proxy the denylist did not know. This module answers the question all of those
// approximate, at the one place nothing can spoof it: the kernel's TCP table. For a request on a connection from
// this computer, it finds the process that owns the client end of the socket, walks its parents, and says whether
// that process may hold or use the owner's page secret:
//
//   • refused: SynaBun's automation browser and any browser started for automation (--remote-debugging-port or
//     --remote-debugging-pipe, MoreLogin's Chromium, Playwright's WebKit / Firefox pipes), whatever host or port it
//     used and whether or not a service worker made the request (a service worker's fetch leaves from the browser's
//     own network process);
//   • refused: an AI agent's process tree (a Claude Code CLI, Codex, OpenCode, …) — every dispatched worker, its
//     shell, its scripts, a detached child — and another SynaBun server;
//   • refused: a relay — ssh / sshd, socat, nc, a proxy or tunnel program by name (privoxy, mitmproxy, Clash, Surge,
//     sing-box, cloudflared, ngrok, …), and any other program that itself listens on a TCP port and then calls
//     SynaBun (a dev server's proxy, a small node SOCKS server): a relay hides who really asked;
//   • allowed: everything else — the owner's own browser (Safari's WebKit networking, Chrome's network service,
//     Firefox, Arc…), the SynaBun app's window, the owner's own terminal.
//
// No allowlist: nothing the owner uses has to be known for it to keep working. When the lookup itself cannot run
// (netstat or ps missing, slow or unreadable, another platform) the answer is "unknown" and the caller keeps its
// rules from before this module (the sandbox stays the boundary for workers): the owner is never locked out by a
// failed lookup. A client socket that is no longer in the table when it is looked up (the client closed it before
// its request was read) is refused: a browser waiting for its answer still holds its socket.
//
// Cheap: one `netstat -anvl -p tcp` (~4 ms on macOS, one sysctl) per NEW connection, shared by every lookup that is
// waiting when it starts; the process table (`ps`, ~20 ms) is read only for a process not seen in the last few
// minutes; the answer is kept on the socket, so keep-alive requests reuse it for free. Requests that carry no page
// secret and no brain credential and ask for none (hooks, MCP, static files) are never looked up at all.
//
// The same lookup proves a brain credential (X-Synabun-Brain-Token) is used by the brain it was minted for: the
// credential is in that brain's own process environment only (SYNABUN_BRAIN_TOKEN, assistant-runtime.js), so a
// request carrying it must come from a process that holds it in its environment, or a descendant of one (the
// Claude brain's CLI, the Codex / OpenCode brain's stdio MCP child) — or from this server itself (the in-process
// MCP server relays a brain's /mcp call, whose own connection was checked when it arrived). A credential read out
// of a brain's environment (`ps -E` cannot be blocked between processes of one user) and sent through a relay is
// dropped from the request, which then has no brain authority.
//
// macOS only (netstat's process:pid column, ps -E). Elsewhere every answer is "unknown" (the rules from before).
// Parsers and the classifier are pure and unit-tested (tests/peer-identity.test.mjs); the reader takes an injected
// `run` so tests drive it with fixed tables.

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { posix } from 'node:path';

/** Where the verdict for a request is kept (on the request object). */
export const PEER_VERDICT = Symbol.for('synabun.peerVerdict');
/** The brain credential header (assistant-api.js BRAIN_CREDENTIAL_HEADER). */
export const BRAIN_HEADER = 'x-synabun-brain-token';

const NETSTAT = '/usr/sbin/netstat';
/** `netstat -anvl -p tcp`: every TCP socket, numeric, with its process (-v), IPv6 addresses written in full (-l). */
export const NETSTAT_ARGS = Object.freeze(['-anvl', '-p', 'tcp']);
const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';
/** `lsof -a -p <pid> -d cwd -Fn`: one process's working directory, as field output (lines `p…`, `fcwd`, `n<path>`). */
export const lsofCwdArgs = (pid) => ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'];
const TABLE_TIMEOUT_MS = 1500;
const PS_TIMEOUT_MS = 2000;
const LOOKUP_CAP_MS = 2500;
const PS_SNAPSHOT_TTL_MS = 2000;
// A process's parents and command line do not change while it lives (a parent that exits leaves it to launchd, which
// only ever takes an agent or a browser out of the chain, never puts one in): kept half an hour, checked against
// netstat's kernel name on every lookup (a reused pid under another name is read again).
const CHAIN_TTL_MS = 30 * 60 * 1000;
const ENV_TTL_MS = 10 * 60 * 1000;
const LOCAL_ADDR_TTL_MS = 10 * 1000;
const LOG_EVERY_MS = 60 * 1000;
const MAX_CHAIN = 64;

// ── Addresses ────────────────────────────────────────────────────────────────

/**
 * An IPv6 literal → its eight 16-bit groups, or null. Takes brackets, a zone id, `::` and a dotted IPv4 tail
 * (::ffff:127.0.0.1), in any case.
 */
export function ipv6Groups(text) {
  let s = String(text ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  let tail = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const parts = dotted.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return null;
    tail = [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]];
    s = s.slice(0, -dotted[0].length);
    if (!s.endsWith(':')) return null;
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (h) => (h ? h.split(':') : []).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = groupsOf(halves[0]);
  const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1 && given !== 8) return null;
  if (halves.length === 2 && given > 7) return null;
  const groups = [...head, ...new Array(8 - given).fill(0), ...rest, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The IPv4 address an IPv4-mapped IPv6 literal (::ffff:a.b.c.d, ::ffff:7f00:1) stands for, or null. */
export function mappedIPv4(text) {
  const g = ipv6Groups(text);
  if (!g || !g.slice(0, 5).every((x) => x === 0) || g[5] !== 0xffff) return null;
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

/**
 * An address as both sides print it, for comparing them: lowercase, no brackets, no zone id; an IPv4-mapped IPv6
 * address (::ffff:127.0.0.1, the dual-stack listener's view of an IPv4 client) as its IPv4 form; any other IPv6
 * address as its eight groups written out (so "::1" and "0:0:0:0:0:0:0:1" are one address).
 */
export function normalizeAddress(addr) {
  const a = String(addr ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!a.includes(':')) return a;
  const v4 = mappedIPv4(a);
  if (v4) return v4;
  const g = ipv6Groups(a);
  return g ? g.map((x) => x.toString(16)).join(':') : a.replace(/%.*$/, '');
}

/** One netstat endpoint ("127.0.0.1.54683", "::1.3344", "fe80::1%lo0.80", "*.3344", "*.*") → { addr, port }. */
export function parseNetstatEndpoint(text) {
  const t = String(text || '');
  const dot = t.lastIndexOf('.');
  if (dot <= 0) return null;
  const port = Number(t.slice(dot + 1));
  return { addr: normalizeAddress(t.slice(0, dot)), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null };
}

/**
 * `netstat -anvl -p tcp` (macOS) → { rows: [{ local, foreign, state, pid, name }], listening: Set<pid> }.
 * Two layouts are read: the current one, whose `process:pid` column sits before eight fixed columns (a process name
 * may hold spaces, "Code Helper (Plu:55264"), and the older one with separate `pid` and `epid` columns (found by
 * the header). A row without a pid (a socket no process owns any more) keeps pid 0.
 */
export function parseNetstatTcp(text) {
  const rows = [];
  const listening = new Set();
  const lines = String(text || '').split('\n');
  let layout = 'process';
  let pidIndex = -1;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Proto\b/.test(line)) {
      const head = line.replace(/Local Address/, 'LocalAddress').replace(/Foreign Address/, 'ForeignAddress').split(/\s+/);
      if (head.includes('process:pid')) layout = 'process';
      else if (head.includes('pid')) { layout = 'pid'; pidIndex = head.indexOf('pid'); }
      continue;
    }
    if (!/^tcp/.test(line)) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 6) continue;
    const local = parseNetstatEndpoint(tokens[3]);
    const foreign = parseNetstatEndpoint(tokens[4]);
    if (!local) continue;
    const state = tokens[5];
    let pid = 0;
    let name = '';
    if (layout === 'process') {
      // …shiwat <process name, maybe with spaces>:<pid> state options gencnt flags flags1 usecnt rtncnt fltrs
      if (tokens.length >= 19) {
        const procToken = tokens[tokens.length - 9];
        const m = /:(\d+)$/.exec(procToken);
        if (m) {
          pid = Number(m[1]);
          name = tokens.slice(10, tokens.length - 8).join(' ').replace(/:\d+$/, '');
        }
      }
    } else if (pidIndex >= 0) {
      // The older layout: header columns map one to one once the two-word address headers are joined.
      const n = Number(tokens[pidIndex]);
      if (Number.isInteger(n) && n > 0) pid = n;
    }
    if (!Number.isInteger(pid) || pid < 0) pid = 0;
    rows.push({ local, foreign, state, pid, name });
    if (state === 'LISTEN' && pid > 0) listening.add(pid);
  }
  return { rows, listening };
}

/** `ps -Ao pid=,ppid=,ucomm=` → Map<pid, { ppid, ucomm }> (the kernel's own process name, which a title cannot change). */
export function parsePsParents(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid > 0) out.set(pid, { ppid: Number(m[2]), ucomm: m[3] });
  }
  return out;
}

/** `ps -A -o pid=,<column>=` → Map<pid, string> (everything after the pid; paths with spaces included). */
export function parsePsColumn(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid > 0) out.set(pid, m[2]);
  }
  return out;
}

/** `lsof -a -p <pid> -d cwd -Fn` → the working directory (the `n` line of the `fcwd` file), or null. */
export function parseLsofCwd(text) {
  let cwd = false;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('f')) cwd = line === 'fcwd';
    else if (cwd && line.startsWith('n/')) return line.slice(1);
  }
  return null;
}

// ── Process identities ───────────────────────────────────────────────────────

const lower = (s) => String(s ?? '').toLowerCase();
const baseName = (p) => { const s = String(p ?? '').replace(/\/+$/, ''); return lower(s.slice(s.lastIndexOf('/') + 1)); };

/** Programs whose whole job is to carry a connection somewhere else (matched on the kernel name or argv[0]'s name). */
export const RELAY_NAMES = Object.freeze([
  'ssh', 'autossh', 'sshuttle', 'socat', 'nc', 'ncat', 'netcat', 'stunnel', 'spiped',
  'privoxy', 'squid', 'tinyproxy', 'polipo', 'haproxy',
  'mitmproxy', 'mitmdump', 'mitmweb',
  'clash', 'clashx', 'clash-meta', 'clash-verge', 'mihomo', 'verge-mihomo', 'sing-box', 'v2ray', 'xray',
  'ss-local', 'sslocal', 'ss-server', 'ssserver', 'ss-redir', 'obfs-local', 'trojan', 'trojan-go', 'hysteria', 'hysteria2',
  'tuic-client', 'naive', 'gost', '3proxy', 'sockd', 'danted', 'microsocks', 'redsocks', 'tun2socks', 'proxychains4',
  'cloudflared', 'ngrok', 'frpc', 'frps', 'chisel', 'bore', 'rathole', 'tailscaled', 'zrok', 'pinggy',
]);
/** Proxy / tunnel apps found by their bundle (their helpers carry other names). */
const RELAY_BUNDLE_RE = /\/(?:charles|proxyman|surge(?: mac)?|clashx[^/]*|clash verge|clash for windows|clash nyanpasu|flclash|shadowrocket|shadowsocksx[^/]*|v2rayu|v2rayx|qv2ray|v2rayn|stash|quantumult x|loon|proxifier|mitmproxy|ngrok|tailscale|cloudflare warp)\.app\//i;
/** The agents whose process trees never hold the owner's authority (argv[0]'s name). */
export const AGENT_NAMES = Object.freeze(['claude', 'codex', 'opencode', 'gemini', 'cursor-agent', 'aider', 'goose', 'qwen', 'crush']);
/** Browsers the owner browses with (their bundle or their network process): never taken for a relay because they
 *  happen to hold a listening socket; an automation flag on them is still refused. */
const BROWSER_BUNDLE_RE = /\/(?:safari|google chrome(?: beta| dev| canary)?|chromium|firefox(?: developer edition| nightly)?|arc|brave browser(?: beta| nightly)?|microsoft edge(?: beta| dev| canary)?|opera(?: gx)?|vivaldi|orion|zen(?: browser)?|thorium|comet|dia|sigmaos|yandex|duckduckgo|sidekick|wavebox|island)\.app\/|\/synabun\.app\/contents\/(?:macos\/synabun(?:\s|$)|frameworks\/synabun helper)/i;
/** MoreLogin's executables: its app bundle, and the browser it keeps under ~/Library/Application Support/MoreLogin. */
export const MORELOGIN_PATH_RE = /\/morelogin(?: [^/]*)?\.app\/|\/application support\/morelogin\//i;
/** Kernel names of interpreters and shells: whatever their argv says, they are not a browser. */
const INTERPRETER_RE = /^(?:node|nodejs|bun|deno|python[0-9.]*|pypy[0-9.]*|ruby|perl[0-9.]*|php|java|lua|tclsh|osascript|sh|bash|zsh|dash|fish|ksh|tcsh|csh)$/;

/**
 * What a process is, from its kernel name (`ucomm`), argv[0] (`comm`) and its whole command line (`args`):
 * { automation, agent, synabun, remoteLogin, relay, browser } (each a short reason string or false).
 */
export function processKinds({ ucomm = '', comm = '', args = '' } = {}) {
  const u = lower(ucomm).trim();
  const c = String(comm ?? '');
  const a = String(args ?? '');
  const la = lower(a);
  const exe = baseName(c.split(/\s+--?[a-z]/i)[0] || c) || baseName(a.split(/\s+/)[0]);
  const names = new Set([u, exe].filter(Boolean));
  const has = (list) => list.find((n) => names.has(n)) || false;

  let automation = false;
  if (/(?:^|\s)--remote-debugging-(?:port|pipe)(?:[=\s]|$)/.test(la)) automation = 'remote debugging';
  // MoreLogin by where its executable is (its app, its bundled browser and their helpers live in a MoreLogin folder or
  // bundle) or by its kernel name — never by a word in the arguments (a test runner lists tests/morelogin*.test.mjs).
  else if (MORELOGIN_PATH_RE.test(c) || u.startsWith('morelogin')) automation = 'MoreLogin';
  else if (/(?:^|\s)--inspector-pipe(?:\s|$)/.test(la) || /\/pw_run\.sh(?:\s|$)/.test(la)) automation = 'Playwright WebKit';
  else if (/(?:^|\s)-juggler(?:-pipe)?(?:\s|$)/.test(la) || /(?:^|\s)--?marionette(?:\s|$)/.test(la)) automation = 'Firefox automation';

  let agent = has(AGENT_NAMES);
  if (!agent) {
    if (/\/claude\/versions\/[^/\s]+(?:\s|$)/.test(la) || /@anthropic-ai\/claude-code\/cli\.m?js(?:\s|$)/.test(la) || /@anthropic-ai\/claude-agent-sdk[^/\s]*\/claude(?:\s|$)/.test(la)) agent = 'claude';
    else if (/@openai\/codex\/bin\/codex(?:\.js)?(?:\s|$)/.test(la) || /(?:^|\s|\/)codex\s+(?:app-server|exec|mcp(?:-server)?|proto)\b/.test(la)) agent = 'codex';
    else if (/(?:^|\s|\/)opencode\s+serve\b/.test(la)) agent = 'opencode';
    else if (/@google\/gemini-cli\//.test(la)) agent = 'gemini';
  }

  const synabun = /neural-interface[/\\]server\.js(?:\s|$)/.test(a) ? 'SynaBun server' : false;
  const remoteLogin = (/^sshd(?:-session|-auth)?$/.test(u) || /^sshd(?:-session|-auth)?$/.test(exe) || /^sshd(?::|\s|$)/.test(lower(c).trim())) ? 'sshd' : false;
  let relay = remoteLogin ? false : has(RELAY_NAMES);
  if (!relay && RELAY_BUNDLE_RE.test(c || a)) relay = (RELAY_BUNDLE_RE.exec(c || a)?.[0] || 'proxy app').replace(/^\/|\.app\/$/gi, '');
  // A browser of the owner's, by its executable's place (argv[0]: the helper and network processes live inside the
  // app's bundle) — never by its arguments, and never when the kernel's own name for the process is an interpreter:
  // a script can rewrite its argv (process.title) to look like a browser, it cannot rename what the kernel ran.
  const browser = !automation && !INTERPRETER_RE.test(u)
    && (BROWSER_BUNDLE_RE.test(c) || /com\.apple\.webkit\.networking/.test(lower(c)) || u === 'com.apple.webkit')
    ? 'browser' : false;
  return { automation, agent, synabun, remoteLogin, relay, browser };
}

// ── SynaBun's own MCP server over HTTP ───────────────────────────────────────
//
// `node mcp-server/dist/http.js` (MCP_HTTP_PORT, 3345 by default; `npm run start:http` in mcp-server/ runs
// `node dist/preload-http.js`, which loads it) listens for MCP clients and calls this server's REST routes for their
// tools, with the same pin the stdio MCP server sends (X-Synabun-Terminal). It is a relay by design, so the listener
// rule alone would refuse every gated call of its tools. It is told apart by what the kernel ran (node, by its kernel
// name) and its main script: this install's mcp-server/dist/http.js or preload-http.js, written in full or relative to
// its working directory — never by a word elsewhere on its command line, never a copy outside this install. Its calls
// are then taken like an agent's (lib/owner-authority.js: pinned, its route's rules). What keeps a sandboxed worker
// from using it as a way in is that the worker cannot reach its port (lib/worker-relay-ports.js denies it, as it
// denies every relay identity; server.js denies the configured port as well), and a worker that can reach it is a
// full worker, which can reach SynaBun's own port anyway: a lookalike started by a worker gains nothing either way.

/** The main scripts of SynaBun's MCP server over HTTP, under a SynaBun install's root. */
export const MCP_HTTP_SCRIPTS = Object.freeze(['mcp-server/dist/http.js', 'mcp-server/dist/preload-http.js']);
const MCP_HTTP_TAIL_RE = /^(\/.*?\/mcp-server\/dist\/(?:preload-)?http\.js)(?:\s|$)/;
const MCP_HTTP_RELATIVE_RE = /^(?:\.\/)?(?:[^/\s]+\/)*dist\/(?:preload-)?http\.js$/;
/** node's options that take the next word as their value (the main script is the first word that is neither). */
const NODE_VALUE_OPTIONS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--title', '--input-type',
  '--env-file', '--env-file-if-exists', '--disable-warning', '--watch-path', '--redirect-warnings', '--openssl-config',
  '--icu-data-dir', '--diagnostic-dir', '--report-dir', '--report-filename', '--cpu-prof-dir', '--heap-prof-dir',
  '--stack-trace-limit', '--secure-heap', '--secure-heap-min', '--max-http-header-size', '--test-reporter',
  '--test-reporter-destination', '--trace-event-categories', '--trace-event-file-pattern',
]);
/** node's options after which no script file is the main module. */
const NODE_NO_SCRIPT = new Set(['-e', '--eval', '-p', '--print', '-i', '--interactive']);

/**
 * The main script of a `node …` command line: the first word after node's own options, as written (maybe relative),
 * and the command line from it on (`rest`: a full path may hold spaces). `args` is ps's command line (argv joined by
 * spaces), `comm` argv[0]. null when node runs no script file (-e, -p, a REPL).
 */
export function nodeMainScript({ comm = '', args = '' } = {}) {
  const a = String(args ?? '');
  const c = String(comm ?? '');
  let at = 0;
  if (c && a.startsWith(c)) at = c.length;
  else { const first = /^\s*\S+/.exec(a); at = first ? first[0].length : 0; }
  const word = /\S+/g;
  word.lastIndex = at;
  let valueNext = false;
  for (let m = word.exec(a); m; m = word.exec(a)) {
    const w = m[0];
    if (valueNext) { valueNext = false; continue; }
    if (w === '--') { const next = word.exec(a); return next ? { script: next[0], rest: a.slice(next.index) } : null; }
    if (w.startsWith('-')) {
      if (NODE_NO_SCRIPT.has(w.split('=')[0])) return null;
      if (!w.includes('=') && NODE_VALUE_OPTIONS.has(w)) valueNext = true;
      continue;
    }
    return { script: w, rest: a.slice(m.index) };
  }
  return null;
}

/** Whether a process's main script is a relative `…dist/http.js` / `…dist/preload-http.js`: where it runs decides. */
export function mcpHttpNeedsCwd({ ucomm = '', comm = '', args = '' } = {}) {
  if (!/^node$/i.test(String(ucomm || '').trim())) return false;
  const main = nodeMainScript({ comm, args });
  return !!main && !main.script.startsWith('/') && MCP_HTTP_RELATIVE_RE.test(main.script);
}

/**
 * The full path of a SynaBun MCP-over-HTTP main script a process runs (any SynaBun install: …/mcp-server/dist/http.js
 * or …/preload-http.js), or null. The kernel must have run node (its kernel name, which a title cannot change). A
 * relative script is resolved against `cwd` (null without one).
 */
export function mcpHttpScriptPath({ ucomm = '', comm = '', args = '' } = {}, { cwd = null } = {}) {
  if (!/^node$/i.test(String(ucomm || '').trim())) return null;
  const main = nodeMainScript({ comm, args });
  if (!main) return null;
  if (main.script.startsWith('/')) {
    const written = posix.normalize(main.script);
    if (/\/mcp-server\/dist\/(?:preload-)?http\.js$/.test(written)) return written;
    // A first word that is a whole script file of its own is another program (that may name the file further on).
    if (/\.[cm]?js$/i.test(main.script)) return null;
    // A full path with spaces: the command line from the script on starts with it.
    const m = MCP_HTTP_TAIL_RE.exec(main.rest);
    return m ? posix.normalize(m[1]) : null;
  }
  if (!MCP_HTTP_RELATIVE_RE.test(main.script) || typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  const full = posix.resolve(cwd, main.script);
  return /\/mcp-server\/dist\/(?:preload-)?http\.js$/.test(full) ? full : null;
}

/**
 * Whether a process is SynaBun's own MCP server over HTTP from one of `roots` (this server's install, as written and
 * as its real path): its main script is <root>/mcp-server/dist/http.js or …/preload-http.js, or a link to one.
 * @param {{ucomm:string, comm:string, args:string}} proc
 * @param {{ roots?: string[], cwd?: string|null, realpath?: (p:string) => string|null }} [o]
 */
export function isSynabunMcpServer(proc, { roots = [], cwd = null, realpath = null } = {}) {
  const script = mcpHttpScriptPath(proc, { cwd });
  if (!script) return false;
  const targets = new Set();
  for (const root of roots || []) {
    if (typeof root !== 'string' || !root.startsWith('/')) continue;
    for (const rel of MCP_HTTP_SCRIPTS) targets.add(posix.join(root, rel));
  }
  if (targets.has(script)) return true;
  if (typeof realpath !== 'function') return false;
  let real = null;
  try { real = realpath(script); } catch { real = null; }
  return typeof real === 'string' && targets.has(real);
}

/**
 * Whether the process at the client end of a connection, and its parents, may hold the owner's authority.
 * @param {Array<{pid:number, ppid:number, ucomm:string, comm:string, args:string}>} chain the peer first, then its
 *   parent, and so on (stops before this server, launchd or a loop)
 * @param {{ selfPid:number, listening:Set<number>, synabunMcp?:number }} o `synabunMcp`: the peer's pid when it is
 *   SynaBun's own MCP server over HTTP (isSynabunMcpServer): not refused as a relay, refused like an agent's tree
 *   (kind 'synabun-mcp': lib/owner-authority.js takes its pinned calls as an agent's own)
 * @returns {{ self:boolean, refuse: null | { why:string, kind:string, pid:number, name:string } }}
 */
export function classifyPeerChain(chain, { selfPid = process.pid, listening = new Set(), synabunMcp = 0 } = {}) {
  const list = Array.isArray(chain) ? chain : [];
  if (!list.length) return { self: false, refuse: null };
  if (list[0].pid === selfPid) return { self: true, refuse: null };
  const nameOf = (p) => String(p.ucomm || baseName(p.comm) || `pid ${p.pid}`).trim();
  const refuse = (p, kind, why) => ({ self: false, refuse: { kind, why, pid: p.pid, name: nameOf(p) } });
  const peerKinds = processKinds(list[0]);
  const mcp = Number(synabunMcp) > 0 && list[0].pid === Number(synabunMcp);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p.pid === selfPid || p.pid <= 1) break; // this server's own ancestry, and launchd, are not the peer's
    const k = i === 0 ? peerKinds : processKinds(p);
    if (k.automation) return refuse(p, 'automation-browser', `a browser started for automation (${k.automation})`);
    if (k.agent) return refuse(p, 'agent', `an AI agent's process tree (${k.agent})`);
    if (k.synabun) return refuse(p, 'synabun-instance', 'another SynaBun server');
    if (k.remoteLogin) return refuse(p, 'remote-login', 'a remote login session (sshd)');
    // SynaBun's own MCP server over HTTP relays for its MCP clients by design: not refused as a relay or a listener
    // (its parents still are), its calls taken like an agent's (below).
    if (i === 0 && mcp) continue;
    if (i <= 1 && k.relay) return refuse(p, 'relay', `a relay or proxy program (${k.relay})`);
    // A program that serves TCP itself and calls SynaBun is relaying for whoever reached it (a dev server's proxy,
    // a small SOCKS / HTTP proxy). The owner's browsers are left out of this one rule (their network process, or a
    // browser that holds a socket for its own reasons): their automation flags are what is asked of them.
    if (i <= 1 && !peerKinds.browser && listening.has(p.pid)) return refuse(p, 'listener', 'a program that also listens for connections (a relay or proxy)');
  }
  if (mcp) return refuse(list[0], 'synabun-mcp', 'SynaBun\'s own MCP server over HTTP (it calls for whichever MCP client reached it)');
  return { self: false, refuse: null };
}

/** The environment part of `ps -E` output for one process, given the same process's line without -E. */
export function envPart(withEnv, plain) {
  const w = String(withEnv ?? '');
  const p = String(plain ?? '');
  if (p && w.startsWith(p)) return w.slice(p.length);
  return null; // the two reads disagree (the process changed in between): nothing is taken from it
}

/** Whether an environment block (ps -E's tail) holds SYNABUN_BRAIN_TOKEN=<credential> as a whole variable. */
export function envHoldsCredential(env, credential) {
  if (typeof env !== 'string' || typeof credential !== 'string' || !/^sbb_[A-Za-z0-9_-]{43}$/.test(credential)) return false;
  const needle = `SYNABUN_BRAIN_TOKEN=${credential}`;
  let from = 0;
  for (;;) {
    const at = env.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? ' ' : env[at - 1];
    const after = env[at + needle.length];
    if (/\s/.test(before) && (after === undefined || /\s/.test(after))) return true;
    from = at + 1;
  }
}

// ── The reader ───────────────────────────────────────────────────────────────

function defaultRun(file, args, { timeout }) {
  return new Promise((resolve, reject) => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } }, (error, stdout) => {
        if (error) reject(error); else resolve(String(stdout || ''));
      });
    } catch (error) { reject(error); }
  });
}

function thisMachineAddresses() {
  const out = new Set(['127.0.0.1', '::1']);
  try {
    for (const list of Object.values(networkInterfaces())) for (const ni of list || []) if (ni?.address) out.add(normalizeAddress(ni.address));
  } catch { /* no interfaces readable: loopback only */ }
  return out;
}

/**
 * @param {object} [o]
 * @param {string} [o.platform] process.platform; only darwin is looked up (everything else is "unknown").
 * @param {number} [o.selfPid] this server's pid (its own in-process calls are trusted).
 * @param {(file:string, args:string[], opts:{timeout:number}) => Promise<string>} [o.run] runs a program (execFile-shaped).
 * @param {() => Set<string>} [o.localAddresses] this computer's addresses (normalized).
 * @param {(line:string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {boolean} [o.disabled] SYNABUN_PEER_IDENTITY=off: nothing is looked up (the rules from before), said once.
 * @param {string[]} [o.synabunRoots] this server's install (the folder holding mcp-server/): its MCP server over HTTP
 *   is told apart from other listening programs (isSynabunMcpServer). None: it is refused as a listener, as any relay.
 * @param {(path:string) => string} [o.realpath] fs.realpathSync (tests inject one).
 */
export function createPeerIdentity({ platform = process.platform, selfPid = process.pid, run = defaultRun, localAddresses = null, log = () => {}, now = Date.now, disabled = false, synabunRoots = [], realpath = realpathSync } = {}) {
  const supported = platform === 'darwin' && !disabled;
  if (disabled) { try { log('[peer-identity] off (SYNABUN_PEER_IDENTITY=off): the page secret\'s rules from before apply, with no peer lookup'); } catch { /* logger */ } }
  const bySocket = new WeakMap();
  const chains = new Map(); // pid → { at, ucomm, chain }
  const envs = new Map();   // `${pid}\0${credential}` → { at, holds }
  const mcpServers = new Map(); // `${pid}\0${args}` → { at, yes }
  // This install's root as written and as its real path (a linked install names either).
  const roots = [...new Set((Array.isArray(synabunRoots) ? synabunRoots : []).filter((r) => typeof r === 'string' && r.startsWith('/')).flatMap((r) => {
    const written = posix.normalize(r).replace(/(.)\/+$/, '$1');
    let real = null;
    try { real = typeof realpath === 'function' ? realpath(written) : null; } catch { real = null; }
    return typeof real === 'string' && real !== written ? [written, real] : [written];
  }))];
  const logged = new Map(); // key → last time
  const stats = { lookups: 0, tableReads: 0, psReads: 0, envReads: 0, refused: 0, unknown: 0, gone: 0, totalMs: 0, maxMs: 0 };
  let addrCache = null;
  let addrAt = 0;

  const note = (key, line) => {
    const last = logged.get(key) || 0;
    if (now() - last < LOG_EVERY_MS) return;
    logged.set(key, now());
    if (logged.size > 500) logged.delete(logged.keys().next().value);
    try { log(line); } catch { /* a logger's own failure */ }
  };
  const isThisMachine = (addr) => {
    if (typeof localAddresses === 'function') { try { return localAddresses().has(addr); } catch { return false; } }
    if (!addrCache || now() - addrAt > LOCAL_ADDR_TTL_MS) { addrCache = thisMachineAddresses(); addrAt = now(); }
    return addrCache.has(addr);
  };

  // One TCP table read serves every lookup that was waiting when it STARTED (a socket accepted after a read began
  // may not be in it, so its lookup waits for the next read).
  let tableRunning = null;
  let tableNext = null;
  function tcpTable() {
    if (tableNext) return tableNext;
    const after = tableRunning || Promise.resolve();
    tableNext = after.catch(() => {}).then(() => {
      tableNext = null;
      stats.tableReads++;
      const startedAt = now();
      // -l: full IPv6 addresses (without it macOS cuts a long one, fe80::105e:de82:…, and the client's row would not
      // be found: a connection taken for one that closed, refused).
      const read = run(NETSTAT, NETSTAT_ARGS, { timeout: TABLE_TIMEOUT_MS }).then((text) => {
        const table = parseNetstatTcp(text);
        if (!table.rows.length) throw new Error('netstat listed no TCP sockets');
        // A layout this parser does not read gives no process at all: that is a lookup that cannot run (the rules from
        // before), never "every client left".
        if (!table.rows.some((r) => r.pid > 0)) throw new Error('netstat named no processes (an unknown output layout)');
        return { ...table, startedAt };
      });
      tableRunning = read;
      read.catch(() => {}).then(() => { if (tableRunning === read) tableRunning = null; });
      return read;
    });
    return tableNext;
  }

  // The process table (pid, ppid, kernel name, argv[0], command line), kept a moment so a burst of lookups reads it
  // once. Each read remembers when it STARTED: a process that owned a socket when a netstat read started is in every
  // ps read that started after it (unless it has exited since), which is what `notBefore` asks for.
  let psSnap = null;
  let psPending = null;
  function processTable({ notBefore = null } = {}) {
    if (psSnap && (notBefore === null ? now() - psSnap.startedAt < PS_SNAPSHOT_TTL_MS : psSnap.startedAt >= notBefore)) return Promise.resolve(psSnap);
    if (psPending && (notBefore === null || psPending.startedAt >= notBefore)) return psPending.promise;
    stats.psReads++;
    const startedAt = now();
    const promise = Promise.all([
      run(PS, ['-Ao', 'pid=,ppid=,ucomm='], { timeout: PS_TIMEOUT_MS }),
      run(PS, ['-Aww', '-o', 'pid=,comm='], { timeout: PS_TIMEOUT_MS }),
      run(PS, ['-Aww', '-o', 'pid=,args='], { timeout: PS_TIMEOUT_MS }),
    ]).then(([parents, comms, args]) => {
      const snap = { parents: parsePsParents(parents), comm: parsePsColumn(comms), args: parsePsColumn(args), startedAt };
      if (!snap.parents.size) throw new Error('ps listed no processes');
      if (!psSnap || psSnap.startedAt <= startedAt) psSnap = snap;
      return snap;
    }).finally(() => { if (psPending?.promise === promise) psPending = null; });
    psPending = { promise, startedAt };
    return promise;
  }

  function chainFrom(snap, pid) {
    const chain = [];
    const seen = new Set();
    let at = pid;
    while (at > 0 && !seen.has(at) && chain.length < MAX_CHAIN) {
      seen.add(at);
      const row = snap.parents.get(at);
      if (!row) break;
      chain.push({ pid: at, ppid: row.ppid, ucomm: row.ucomm, comm: snap.comm.get(at) || '', args: snap.args.get(at) || '' });
      if (at === selfPid || at <= 1) break;
      at = row.ppid;
    }
    return chain;
  }

  /** The peer's chain; null when a ps read that started after `seenAt` (the netstat read that named it) lacks it. */
  async function chainOf(pid, kernelName, seenAt) {
    const hit = chains.get(pid);
    if (hit && now() - hit.at < CHAIN_TTL_MS && (!kernelName || !hit.ucomm || kernelName.startsWith(hit.ucomm.slice(0, 15)) || hit.ucomm.startsWith(kernelName.slice(0, 15)))) return hit.chain;
    let snap = await processTable();
    if (!snap.parents.has(pid)) snap = await processTable({ notBefore: Number.isFinite(seenAt) ? seenAt : now() });
    if (!snap.parents.has(pid)) return null;
    const chain = chainFrom(snap, pid);
    chains.set(pid, { at: now(), ucomm: chain[0]?.ucomm || '', chain });
    if (chains.size > 2000) chains.delete(chains.keys().next().value);
    return chain;
  }

  /**
   * The peer's pid when it is SynaBun's own MCP server over HTTP (it listens, the kernel ran node, its main script is
   * this install's dist/http.js or preload-http.js), else 0. Its working directory is read (lsof) only for a relative
   * script. Kept with the process's command line: a pid reused by another command is asked again.
   */
  async function synabunMcpPid(peer, listening) {
    if (!roots.length || !peer || !(peer.pid > 1) || !listening.has(peer.pid) || !/^node$/i.test(String(peer.ucomm || '').trim())) return 0;
    const key = `${peer.pid}\0${peer.args || ''}`;
    const hit = mcpServers.get(key);
    if (hit && now() - hit.at < CHAIN_TTL_MS) return hit.yes ? peer.pid : 0;
    let cwd = null;
    if (mcpHttpNeedsCwd(peer)) {
      try { cwd = parseLsofCwd(await run(LSOF, lsofCwdArgs(peer.pid), { timeout: PS_TIMEOUT_MS })); } catch { cwd = null; }
    }
    const yes = isSynabunMcpServer(peer, { roots, cwd, realpath });
    mcpServers.set(key, { at: now(), yes });
    if (mcpServers.size > 500) mcpServers.delete(mcpServers.keys().next().value);
    return yes ? peer.pid : 0;
  }

  async function identify(socket) {
    const started = now();
    const remote = normalizeAddress(socket?.remoteAddress);
    const remotePort = Number(socket?.remotePort);
    const local = normalizeAddress(socket?.localAddress);
    const localPort = Number(socket?.localPort);
    if (!remote || !remotePort || !localPort) return { status: 'unknown', reason: 'the connection has no address' };
    if (!isThisMachine(remote)) return { status: 'remote' };
    if (!supported) return { status: 'unknown', reason: `peer lookup is not available on ${platform}` };
    let table;
    try { table = await tcpTable(); } catch (error) { return { status: 'unknown', reason: `netstat: ${error?.code || error?.message || error}` }; }
    const row = table.rows.find((r) => r.local.port === remotePort && r.local.addr === remote && r.foreign.port === localPort && (r.foreign.addr === local || !local));
    if (!row || !row.pid) return { status: 'gone', reason: 'the connection closed before its request was identified', ms: now() - started };
    if (row.pid === selfPid) return { status: 'ok', self: true, pid: row.pid, name: row.name, chain: [], refuse: null, ms: now() - started };
    let chain;
    try { chain = await chainOf(row.pid, row.name, table.startedAt); } catch (error) { return { status: 'unknown', reason: `ps: ${error?.code || error?.message || error}`, pid: row.pid }; }
    // The process table was read and the client is not in it: it sent its request and exited without waiting for the
    // answer (a one-shot relay). A browser or a brain waits for its answer; this is treated like a closed socket.
    if (!chain || !chain.length) return { status: 'gone', reason: 'the client process exited before it was identified', pid: row.pid, ms: now() - started };
    let synabunMcp = 0;
    try { synabunMcp = await synabunMcpPid(chain[0], table.listening); } catch { synabunMcp = 0; }
    const verdict = classifyPeerChain(chain, { selfPid, listening: table.listening, synabunMcp });
    return { status: 'ok', self: verdict.self, pid: row.pid, name: row.name || chain[0].ucomm, chain, refuse: verdict.refuse, ms: now() - started };
  }

  /** The peer of a request's connection, looked up once per connection (keep-alive requests share it). Never rejects. */
  function lookup(req) {
    const socket = req?.socket || req?.connection || null;
    if (!socket || typeof socket !== 'object') return Promise.resolve({ status: 'unknown', reason: 'no connection' });
    let p = bySocket.get(socket);
    if (!p) {
      let timer = null;
      const cap = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'unknown', reason: `the lookup took over ${LOOKUP_CAP_MS} ms` }), LOOKUP_CAP_MS); timer.unref?.(); });
      p = Promise.race([identify(socket).catch((error) => ({ status: 'unknown', reason: error?.message || String(error) })), cap]).finally(() => clearTimeout(timer));
      bySocket.set(socket, p);
    }
    return p;
  }

  /** Whether some process in `chain` (the peer up to this server) holds the credential in its own environment. */
  async function chainHoldsCredential(chain, credential) {
    const pids = chain.filter((p) => p.pid > 1 && p.pid !== selfPid).map((p) => p.pid);
    if (!pids.length) return false;
    const key = (pid) => `${pid}\0${credential}`;
    const known = pids.map((pid) => envs.get(key(pid))).filter((e) => e && now() - e.at < ENV_TTL_MS);
    if (known.some((e) => e.holds)) return true;
    const ask = pids.filter((pid) => { const e = envs.get(key(pid)); return !e || now() - e.at >= ENV_TTL_MS; });
    if (!ask.length) return false;
    stats.envReads++;
    const list = ask.join(',');
    const [withEnv, plain] = await Promise.all([
      run(PS, ['-E', '-ww', '-o', 'pid=,command=', '-p', list], { timeout: PS_TIMEOUT_MS }),
      run(PS, ['-ww', '-o', 'pid=,command=', '-p', list], { timeout: PS_TIMEOUT_MS }),
    ]);
    const e = parsePsColumn(withEnv);
    const p = parsePsColumn(plain);
    let holds = false;
    for (const pid of ask) {
      const h = envHoldsCredential(envPart(e.get(pid), p.get(pid)), credential);
      envs.set(key(pid), { at: now(), holds: h });
      if (h) holds = true;
    }
    if (envs.size > 2000) envs.delete(envs.keys().next().value);
    return holds;
  }

  /**
   * Express middleware: looks the peer up when `needs(req)` says the request asks for, or carries, the owner's
   * authority, and keeps the verdict on the request (refusal() reads it). A brain credential from a peer outside the
   * brain's own process tree is removed from the request. Never fails a request: a lookup that cannot run leaves the
   * rules from before in force.
   */
  function middleware({ needs = () => false } = {}) {
    // Express 4 does not catch a rejected promise: the decision is made apart from next(), which is called exactly
    // once whatever happens in it (an unexpected error leaves the rules from before, and is said once).
    return function peerIdentity(req, res, next) {
      if (disabled) return next();
      let wanted = false;
      try { wanted = needs(req) === true; } catch { wanted = false; }
      const credential = typeof req.headers?.[BRAIN_HEADER] === 'string' ? req.headers[BRAIN_HEADER].trim() : null;
      if (!wanted && !credential) return next();
      decide(req, wanted, credential).then(() => next(), (error) => {
        note(`error:${error?.message}`, `[peer-identity] the lookup failed (${error?.message || error}); the page secret's rules from before apply`);
        next();
      });
    };
  }
  /** The lookup for one request: the verdict kept on it, a brain credential from outside its brain's tree dropped. */
  async function decide(req, wanted, credential) {
    const t0 = now();
    let peer;
    try { peer = await lookup(req); } catch (error) { peer = { status: 'unknown', reason: error?.message || String(error) }; }
    const ms = now() - t0;
    stats.lookups++; stats.totalMs += ms; if (ms > stats.maxMs) stats.maxMs = ms;
    req[PEER_VERDICT] = peer;
    if (peer.status === 'unknown') { stats.unknown++; note(`unknown:${peer.reason}`, `[peer-identity] could not tell who is asking (${peer.reason}); the page secret's rules from before apply`); }
    if (peer.status === 'gone') { stats.gone++; note(`gone`, `[peer-identity] ${peer.reason || 'a connection closed before its request was identified'}: no owner authority for it`); }
    if (peer.status === 'ok' && peer.refuse && wanted) {
      stats.refused++;
      note(`refuse:${peer.refuse.pid}:${peer.refuse.kind}`, `[peer-identity] no page secret / owner authority for pid ${peer.refuse.pid} (${peer.refuse.name}): ${peer.refuse.why}`);
    }
    if (!credential) return;
    let keep = true;
    if (peer.status === 'gone') keep = false;
    else if (peer.status === 'ok' && !peer.self) {
      try { keep = await chainHoldsCredential(peer.chain || [], credential); } catch (error) {
        keep = true; // the environment could not be read: the rules from before (the credential alone)
        note(`env:${error?.code || error?.message}`, `[peer-identity] could not read a brain's environment (${error?.code || error?.message || error}); the brain credential is taken as before`);
      }
    }
    if (!keep) {
      delete req.headers[BRAIN_HEADER];
      note(`brain:${peer.pid || 'gone'}`, `[peer-identity] a brain credential came from pid ${peer.pid || '?'} (${peer.name || 'closed connection'}), outside the brain's own process tree: it was dropped from the request`);
    }
  }

  /**
   * Why this request may not hold or use the owner's page secret (a short sentence), or null. Null as well when the
   * peer could not be identified or was never looked up: the caller's rules from before decide.
   */
  function refusal(req) {
    const peer = req?.[PEER_VERDICT];
    if (!peer) return null;
    if (peer.status === 'gone') return peer.reason || 'the connection closed before its request was identified';
    if (peer.status === 'ok' && peer.refuse) return `${peer.refuse.why}: pid ${peer.refuse.pid} (${peer.refuse.name})`;
    return null;
  }

  return { supported, lookup, middleware, refusal, chainHoldsCredential, stats: () => ({ ...stats, avgMs: stats.lookups ? Math.round((stats.totalMs / stats.lookups) * 10) / 10 : 0 }) };
}

/** Exposed for tests: whether an address is a literal IP (4 or 6). */
export function isIpLiteral(addr) { return isIP(normalizeAddress(addr)) !== 0; }
