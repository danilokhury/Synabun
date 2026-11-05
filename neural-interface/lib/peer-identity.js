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
// No allowlist: nothing the owner uses has to be known for it to keep working. A client socket that is no longer in
// the table when it is looked up (the client closed it before its request was read) is refused: a browser waiting for
// its answer still holds its socket.
//
// When there is no answer, two cases are told apart (the verdict's `kind`, peerAuthority() reads it for every caller):
//   • unsupported — the lookup does not run on this server: another platform than macOS, or SYNABUN_PEER_IDENTITY=off
//     (the owner's explicit choice, logged at start). The callers keep their rules from before this module, so
//     Windows and Linux work as they always did;
//   • failed — the lookup should have run here (macOS) and could not: netstat or ps missing, denied (a server started
//     inside a sandbox), slow past the cap, an output this parser does not read, a connection with no address, or an
//     error in the lookup itself. That is no proof of who is asking, so the request gets no owner authority: no page
//     secret, no brain credential, and the owner's writes, reads and sockets are answered 503 PEER_UNAVAILABLE (the
//     app's pages and every other read still load). A failure that may pass (a timeout, a busy system) is tried once
//     more at once and is kept on its connection for a moment only (NEGATIVE_TTL_MS), so an open tab recovers by
//     itself; a client that left is never kept. The server probes netstat and ps once at start (probe()), keeps the
//     state for GET /api/health (`ownerAuthority`: ok / degraded / unsupported / off), says the change in one loud log
//     line, and the page shows a banner while it is degraded (public/shared/ui-owner-authority.js).
// Only a machine elsewhere on the network ('remote', below) still keeps the rules from before without a lookup: what to
// do about a LAN client is a separate decision (TODO(peer-identity-remote): decide the LAN policy).
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
// macOS only (netstat's process:pid column, ps -E). Elsewhere every answer is "unknown, unsupported" (the rules from
// before). On macOS a credential whose check could not run (the lookup failed, or ps -E could not be read) is dropped
// too: nothing proves the brain sent it.
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
/** The longest one attempt at a lookup may keep a request waiting (a failure that may pass gets one more attempt). */
export const LOOKUP_CAP_MS = 2500;
/** How long a failed lookup is kept on its connection: a burst of requests is not looked up again each, an open tab
 *  is soon. */
export const NEGATIVE_TTL_MS = 2000;
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
// Antigravity's CLI runs as `antigravity` (the kernel's name for the binary Homebrew links as `agy`). Gemini CLI stays on
// the list though SynaBun no longer drives it: an agent the user still runs never holds the owner's authority either.
export const AGENT_NAMES = Object.freeze(['claude', 'codex', 'opencode', 'agy', 'antigravity', 'gemini', 'cursor-agent', 'aider', 'goose', 'qwen', 'crush']);
/** The agent backend of the Antigravity app and IDE (a `language_server` inside their bundles: Codeium's name, so only by its place). */
const ANTIGRAVITY_SERVER_RE = /\/antigravity(?: ide)?\.app\/contents\/resources\/(?:app\/extensions\/[^/]+\/)?bin\/language_server/i;
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
  if (agent === 'agy') agent = 'antigravity';
  if (!agent) {
    if (/\/claude\/versions\/[^/\s]+(?:\s|$)/.test(la) || /@anthropic-ai\/claude-code\/cli\.m?js(?:\s|$)/.test(la) || /@anthropic-ai\/claude-agent-sdk[^/\s]*\/claude(?:\s|$)/.test(la)) agent = 'claude';
    else if (/@openai\/codex\/bin\/codex(?:\.js)?(?:\s|$)/.test(la) || /(?:^|\s|\/)codex\s+(?:app-server|exec|mcp(?:-server)?|proto)\b/.test(la)) agent = 'codex';
    else if (/(?:^|\s|\/)opencode\s+serve\b/.test(la)) agent = 'opencode';
    else if (/(?:^|\s|\/)(?:agy|antigravity)\s+acp\b/.test(la) || ANTIGRAVITY_SERVER_RE.test(c || a)) agent = 'antigravity';
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

// ── Processes SynaBun starts for an agent ────────────────────────────────────
//
// A command an agent runs through SynaBun (the Antigravity panel's client terminals, lib/antigravity/acp-client-host.js)
// is a child of this server, not of the agent, so no agent is in its process tree by name. Its pid is registered here
// while it runs, and a chain that passes through one is an agent's tree. Like the name rule, a command that detaches
// from its parent (and so from the chain) is not seen.
const AGENT_PROCESSES = new Map(); // pid -> label

/** A process SynaBun started on an agent's behalf: its tree never holds the owner's authority while it runs. */
export function registerAgentProcess(pid, label = 'agent command') {
  if (Number.isInteger(pid) && pid > 1) AGENT_PROCESSES.set(pid, String(label || 'agent command').slice(0, 80));
}
/** That process ended (its pid can be reused). */
export function forgetAgentProcess(pid) {
  AGENT_PROCESSES.delete(pid);
}
/** The registered processes (for tests and diagnostics). */
export function agentProcesses() {
  return new Map(AGENT_PROCESSES);
}

/**
 * Whether the process at the client end of a connection, and its parents, may hold the owner's authority.
 * @param {Array<{pid:number, ppid:number, ucomm:string, comm:string, args:string}>} chain the peer first, then its
 *   parent, and so on (stops before this server, launchd or a loop)
 * @param {{ selfPid:number, listening:Set<number>, synabunMcp?:number }} o `synabunMcp`: the peer's pid when it is
 *   SynaBun's own MCP server over HTTP (isSynabunMcpServer): not refused as a relay, refused like an agent's tree
 *   (kind 'synabun-mcp': lib/owner-authority.js takes its pinned calls as an agent's own)
 *   `agentPids`: processes SynaBun started for an agent (registerAgentProcess), refused like an agent's tree
 * @returns {{ self:boolean, refuse: null | { why:string, kind:string, pid:number, name:string } }}
 */
export function classifyPeerChain(chain, { selfPid = process.pid, listening = new Set(), synabunMcp = 0, agentPids = AGENT_PROCESSES, debugClient = null } = {}) {
  const list = Array.isArray(chain) ? chain : [];
  if (!list.length) return { self: false, refuse: null };
  if (list[0].pid === selfPid) return { self: true, refuse: null };
  const nameOf = (p) => String(p.ucomm || baseName(p.comm) || `pid ${p.pid}`).trim();
  const refuse = (p, kind, why) => ({ self: false, refuse: { kind, why, pid: p.pid, name: nameOf(p) } });
  const peerKinds = processKinds(list[0]);
  const mcp = Number(synabunMcp) > 0 && list[0].pid === Number(synabunMcp);
  let exempted = false;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p.pid === selfPid || p.pid <= 1) break; // this server's own ancestry, and launchd, are not the peer's
    const k = i === 0 ? peerKinds : processKinds(p);
    // Local profiling (SYNABUN_ALLOW_DEBUG_CLIENT, debugClientPolicy): only the remote-debugging flag is forgiven, and
    // only on the port the policy names; every other rule below still applies to this process and its parents. The
    // process holds its debug port open itself, so the listener rule is not asked of that one process.
    const debugOk = !!k.automation && debugClientExempt(p, k, debugClient);
    if (debugOk) exempted = true;
    if (k.automation && !debugOk) return refuse(p, 'automation-browser', `a browser started for automation (${k.automation})`);
    if (k.agent) return refuse(p, 'agent', `an AI agent's process tree (${k.agent})`);
    const startedFor = agentPids?.get?.(p.pid);
    if (startedFor) return refuse(p, 'agent', `an AI agent's process tree (${startedFor}, started by SynaBun)`);
    if (k.synabun) return refuse(p, 'synabun-instance', 'another SynaBun server');
    if (k.remoteLogin) return refuse(p, 'remote-login', 'a remote login session (sshd)');
    // SynaBun's own MCP server over HTTP relays for its MCP clients by design: not refused as a relay or a listener
    // (its parents still are), its calls taken like an agent's (below).
    if (i === 0 && mcp) continue;
    if (i <= 1 && k.relay) return refuse(p, 'relay', `a relay or proxy program (${k.relay})`);
    // A program that serves TCP itself and calls SynaBun is relaying for whoever reached it (a dev server's proxy,
    // a small SOCKS / HTTP proxy). The owner's browsers are left out of this one rule (their network process, or a
    // browser that holds a socket for its own reasons): their automation flags are what is asked of them.
    if (i <= 1 && !peerKinds.browser && !debugOk && listening.has(p.pid)) return refuse(p, 'listener', 'a program that also listens for connections (a relay or proxy)');
  }
  if (exempted && !mcp) return { self: false, refuse: null, debugExempt: true };
  if (mcp) return refuse(list[0], 'synabun-mcp', 'SynaBun\'s own MCP server over HTTP (it calls for whichever MCP client reached it)');
  return { self: false, refuse: null };
}

// ── Local profiling exemption (off unless the server's own environment asks) ─
//
// SYNABUN_ALLOW_DEBUG_CLIENT=1 (any debug port) or =<port> (only --remote-debugging-port=<port>) lets a client process
// started with --remote-debugging-port hold the owner's authority, so SynaBun's own window can be profiled over CDP.
// Read from the environment the server was started with only (server.js reads it before DATA_HOME/.env is loaded:
// never from a file a client can write), loopback peers only (127.0.0.0/8, ::1), and only that flag: a
// --remote-debugging-pipe, MoreLogin, Playwright WebKit / Firefox automation, agents, relays and every other rule
// still refuse.

/** The policy from an environment object: { enabled, port } (port null = any). Anything but 1/on/true/yes or a port is off. */
export function debugClientPolicy(env = process.env) {
  const raw = String(env?.SYNABUN_ALLOW_DEBUG_CLIENT ?? '').trim().toLowerCase();
  if (/^(?:1|on|true|yes)$/.test(raw)) return { enabled: true, port: null };
  if (/^[0-9]{4,5}$/.test(raw) && Number(raw) >= 1024 && Number(raw) <= 65535) return { enabled: true, port: Number(raw) };
  return { enabled: false, port: null };
}

/** Whether this process's automation flag is the one the policy forgives. */
export function debugClientExempt(proc, kinds, policy) {
  if (!policy?.enabled || kinds?.automation !== 'remote debugging') return false;
  const la = lower(proc?.args);
  if (/(?:^|\s)--remote-debugging-pipe(?:[=\s]|$)/.test(la)) return false;
  // The other automation rules are asked as if the flag were not there: MoreLogin, Playwright, Firefox automation.
  if (MORELOGIN_PATH_RE.test(String(proc?.comm ?? '')) || lower(proc?.ucomm).trim().startsWith('morelogin')) return false;
  if (/(?:^|\s)--inspector-pipe(?:\s|$)/.test(la) || /\/pw_run\.sh(?:\s|$)/.test(la) || /(?:^|\s)-juggler(?:-pipe)?(?:\s|$)/.test(la) || /(?:^|\s)--?marionette(?:\s|$)/.test(la)) return false;
  if (/(?:^|\s)--(?:enable-automation|headless)(?:[=\s]|$)/.test(la)) return false;
  const ports = [...la.matchAll(/(?:^|\s)--remote-debugging-port(?:=|\s+)([0-9]+)(?=\s|$)/g)].map((m) => Number(m[1]));
  if (!ports.length) return false;
  return policy.port == null || ports.every((n) => n === policy.port);
}

/** Whether a normalized address is loopback. */
export const isLoopbackAddress = (addr) => /^127\.\d+\.\d+\.\d+$/.test(String(addr || '')) || String(addr || '') === '::1';

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

// ── Verdicts without an answer, and what a verdict means for the owner's authority ─

/** The lookup does not run on this server (another platform, SYNABUN_PEER_IDENTITY=off): the callers' rules from before. */
export function unsupportedPeerVerdict(reason = 'peer lookup is not available here') {
  return { status: 'unknown', kind: 'unsupported', retryable: false, reason: String(reason) };
}
/** The lookup should have run here (macOS) and could not: no owner authority for the request (503 PEER_UNAVAILABLE). */
export function failedPeerVerdict(reason = 'the lookup failed', { retryable = false } = {}) {
  return { status: 'unknown', kind: 'failed', retryable: retryable === true, reason: String(reason) };
}

const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY', 'EINTR']);
/**
 * Whether a failure of netstat / ps may pass by itself: its own timeout ended it (execFile kills it and says
 * `killed` / `signal`), or the system was short of something for a moment (no process slot, no file descriptor).
 * A program that is missing (ENOENT), denied (EPERM, EACCES: a sandbox) or answers what cannot be read does not.
 */
export function isTransientLookupError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.killed === true || (typeof error.signal === 'string' && error.signal)) return true;
  return TRANSIENT_CODES.has(String(error.code || ''));
}
/** A short reason for a failed program ("timed out", "EPERM", "netstat named no processes…"). */
function failureText(error) {
  if (error && typeof error === 'object' && (error.killed === true || (typeof error.signal === 'string' && error.signal))) return 'timed out';
  return String(error?.code || error?.message || error || 'failed');
}

/**
 * What a request's peer verdict means for the owner's authority: the one reading lib/page-session.js,
 * lib/owner-authority.js and lib/assistant-api.js share. Pure, never throws.
 *   { decision: 'before' }       never looked up, the lookup does not run here (unsupported: another platform or
 *                                SYNABUN_PEER_IDENTITY=off), or a machine elsewhere on the network: the caller's rules
 *                                from before decide
 *   { decision: 'allowed', self } the owner's own process (or this server itself)
 *   { decision: 'refused', code: 'PEER_REFUSED', kind, why, pid, name, gone }  never the owner's authority (the caller
 *                                still applies its own exceptions, such as an agent's own call)
 *   { decision: 'unavailable', code: 'PEER_UNAVAILABLE', retryable, reason }   macOS, the lookup failed: no owner
 *                                authority, and the caller answers 503 (a verdict of a shape this does not know is
 *                                taken as this one: never the rules from before by accident)
 */
export function peerAuthority(verdict) {
  if (verdict === undefined || verdict === null) return { decision: 'before', reason: 'not looked up' };
  if (typeof verdict !== 'object') return { decision: 'unavailable', code: 'PEER_UNAVAILABLE', retryable: false, reason: 'the lookup gave no answer' };
  if (verdict.status === 'ok') {
    if (!verdict.refuse) return { decision: 'allowed', self: verdict.self === true };
    const r = verdict.refuse;
    return { decision: 'refused', code: 'PEER_REFUSED', kind: String(r.kind || 'refused'), why: String(r.why || 'a process that may not act as the owner'), pid: r.pid ?? null, name: String(r.name || ''), gone: false };
  }
  if (verdict.status === 'gone') {
    return { decision: 'refused', code: 'PEER_REFUSED', kind: 'gone', why: String(verdict.reason || 'the connection closed before its request was identified'), pid: verdict.pid ?? null, name: '', gone: true };
  }
  // TODO(peer-identity-remote): a client on another machine of the network keeps the rules from before; whether a LAN
  // client may ever hold the page secret is a separate decision (isRemote() reads headers only).
  if (verdict.status === 'remote') return { decision: 'before', reason: 'another machine' };
  if (verdict.status === 'unknown' && verdict.kind === 'unsupported') return { decision: 'before', reason: String(verdict.reason || 'peer lookup is not available here') };
  return { decision: 'unavailable', code: 'PEER_UNAVAILABLE', retryable: verdict.retryable === true, reason: String(verdict.reason || 'the lookup failed') };
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
 * @param {string} [o.platform] process.platform; only darwin is looked up (everything else is "unknown, unsupported").
 * @param {number} [o.selfPid] this server's pid (its own in-process calls are trusted).
 * @param {(file:string, args:string[], opts:{timeout:number}) => Promise<string>} [o.run] runs a program (execFile-shaped).
 * @param {() => Set<string>} [o.localAddresses] this computer's addresses (normalized).
 * @param {(line:string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {boolean} [o.disabled] SYNABUN_PEER_IDENTITY=off: nothing is looked up (the rules from before), said once.
 * @param {string[]} [o.synabunRoots] this server's install (the folder holding mcp-server/): its MCP server over HTTP
 *   is told apart from other listening programs (isSynabunMcpServer). None: it is refused as a listener, as any relay.
 * @param {(path:string) => string} [o.realpath] fs.realpathSync (tests inject one).
 * @param {number} [o.lookupCapMs] the cap of one attempt (LOOKUP_CAP_MS; tests shorten it).
 * @param {number} [o.negativeTtlMs] how long a failed lookup is kept on its connection (NEGATIVE_TTL_MS).
 */
export function createPeerIdentity({ platform = process.platform, selfPid = process.pid, run = defaultRun, localAddresses = null, log = () => {}, now = Date.now, disabled = false, synabunRoots = [], realpath = realpathSync, debugClient = null, lookupCapMs = LOOKUP_CAP_MS, negativeTtlMs = NEGATIVE_TTL_MS } = {}) {
  const supported = platform === 'darwin' && !disabled;
  const capMs = Number.isFinite(lookupCapMs) && lookupCapMs > 0 ? lookupCapMs : LOOKUP_CAP_MS;
  const ttlMs = Number.isFinite(negativeTtlMs) && negativeTtlMs >= 0 ? negativeTtlMs : NEGATIVE_TTL_MS;
  const debugPolicy = debugClient?.enabled ? { enabled: true, port: Number.isInteger(debugClient.port) ? debugClient.port : null } : null;
  if (debugPolicy) { try { log(`[peer-identity] WARNING: SYNABUN_ALLOW_DEBUG_CLIENT is set: a loopback client started with --remote-debugging-port${debugPolicy.port ? `=${debugPolicy.port}` : ''} is taken as the owner (local profiling only; unset it when done)`); } catch { /* logger */ } }
  if (disabled) { try { log('[peer-identity] off (SYNABUN_PEER_IDENTITY=off, the owner\'s explicit choice): no peer lookup; the page secret, the owner\'s routes and the brain credential keep their rules from before (a local process that fetches a page gets the secret)'); } catch { /* logger */ } }
  /** "Not looked up here" for this server: off, or another platform. */
  const unsupportedReason = disabled ? 'SYNABUN_PEER_IDENTITY=off' : `peer lookup is not available on ${platform}`;
  /** No answer: a failure where the lookup runs (macOS), the rules from before anywhere else. */
  const noAnswer = (reason, { retryable = false } = {}) => (supported ? failedPeerVerdict(reason, { retryable }) : unsupportedPeerVerdict(unsupportedReason));
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
  const stats = { lookups: 0, tableReads: 0, psReads: 0, envReads: 0, refused: 0, unknown: 0, failed: 0, retries: 0, gone: 0, totalMs: 0, maxMs: 0 };
  let addrCache = null;
  let addrAt = 0;

  const note = (key, line) => {
    const last = logged.get(key) || 0;
    if (now() - last < LOG_EVERY_MS) return;
    logged.set(key, now());
    if (logged.size > 500) logged.delete(logged.keys().next().value);
    try { log(line); } catch { /* a logger's own failure */ }
  };
  const say = (line) => { try { log(line); } catch { /* a logger's own failure */ } };

  // ── The state of the owner's authority (GET /api/health `ownerAuthority`, the page's banner) ──
  // off / unsupported never change. On macOS it is ok until the start probe or a lookup fails (degraded, with the
  // reason), and ok again after a whole lookup works (one that read the process table, not just this server's own
  // call, which needs netstat only). Each change is said once, loudly; a lookup that keeps failing is not said again.
  const iso = (ms) => { try { return new Date(ms).toISOString(); } catch { return null; } };
  let authority = disabled
    ? { state: 'off', reason: 'SYNABUN_PEER_IDENTITY=off', retryable: false, since: iso(now()) }
    : !supported
      ? { state: 'unsupported', reason: unsupportedReason, retryable: false, since: iso(now()) }
      : { state: 'ok', reason: null, retryable: false, since: iso(now()) };
  let probed = null; // the start probe's promise
  function degrade(reason, { retryable = false, source = 'lookup' } = {}) {
    if (!supported) return;
    const text = String(reason || 'the lookup failed');
    if (authority.state === 'degraded') {
      // The same outage, said once. Its reason stays what it was (the page's banner is dismissed by it), unless a cause
      // that does not pass by itself follows one that might (a denial after a timeout): that one is the news.
      if (authority.reason !== text) {
        if (authority.retryable && !retryable) authority = { ...authority, reason: text, retryable: false };
        note(`degraded:${text}`, `[peer-identity] still degraded: ${text}`);
      }
      return;
    }
    authority = { state: 'degraded', reason: text, retryable, since: iso(now()) };
    say(`[peer-identity] DEGRADED (${source}): SynaBun cannot tell which local program is calling it (${text}). Until a lookup works again it hands out no page secret, takes no brain credential and answers the owner's writes, reads and sockets 503 PEER_UNAVAILABLE; pages and other reads still load. If this persists, start SynaBun outside any sandbox, or set SYNABUN_PEER_IDENTITY=off in ~/.synabun/.env and restart (the rules from before, without this protection).`);
  }
  function restore(source = 'lookup') {
    if (!supported || authority.state === 'ok') return;
    const was = authority.reason;
    authority = { state: 'ok', reason: null, retryable: false, since: iso(now()) };
    say(`[peer-identity] owner authority restored (${source}): local programs are identified again${was ? ` (it was: ${was})` : ''}`);
  }
  /** What a lookup said about the lookup itself: a whole answer restores, a failure degrades (one about a single
   *  connection — it has no address any more — says nothing about the tools). */
  function noteOutcome(verdict) {
    if (!supported || !verdict || typeof verdict !== 'object') return;
    if (verdict.status === 'unknown' && verdict.kind === 'failed') { if (!verdict.connection) degrade(verdict.reason, { retryable: verdict.retryable === true }); }
    else if (verdict.status === 'ok' && !verdict.self) restore();
  }
  /** The state for GET /api/health: { state: 'ok'|'degraded'|'unsupported'|'off', reason, retryable, since }. */
  function authorityState() {
    return { state: authority.state, reason: authority.reason, retryable: authority.retryable === true, since: authority.since };
  }
  /**
   * The start probe (server.js runs it once, at start): netstat and ps, as a lookup runs them. A failure is the
   * degraded state at once, with its reason in the log and in GET /api/health, before any owner's request meets it.
   * Off macOS (or off) there is nothing to probe. Never rejects; asked twice, it runs once.
   */
  function probe() {
    if (!supported) return Promise.resolve(authorityState());
    if (probed) return probed;
    probed = (async () => {
      const failures = [];
      let retryable = false;
      try {
        const table = parseNetstatTcp(await run(NETSTAT, NETSTAT_ARGS, { timeout: TABLE_TIMEOUT_MS }));
        if (!table.rows.length) failures.push('netstat listed no TCP sockets');
        else if (!table.rows.some((r) => r.pid > 0)) failures.push('netstat named no processes (an unknown output layout)');
      } catch (error) { failures.push(`netstat: ${failureText(error)}`); retryable = retryable || isTransientLookupError(error); }
      try {
        const parents = parsePsParents(await run(PS, ['-Ao', 'pid=,ppid=,ucomm='], { timeout: PS_TIMEOUT_MS }));
        if (!parents.size) failures.push('ps listed no processes');
        else if (!parents.has(selfPid)) failures.push('ps did not list this server');
      } catch (error) { failures.push(`ps: ${failureText(error)}`); retryable = retryable || isTransientLookupError(error); }
      if (failures.length) degrade(failures.join('; '), { retryable, source: 'start probe' });
      else {
        say('[peer-identity] start probe: netstat and ps answer; the owner\'s authority is checked against the calling process');
        restore('start probe');
      }
      return authorityState();
    })().catch((error) => { degrade(`the probe failed (${error?.message || error})`, { source: 'start probe' }); return authorityState(); });
    return probed;
  }
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
    // (on macOS: no proof of who is asking, about this one connection — it says nothing about the tools)
    if (!remote || !remotePort || !localPort) return { ...noAnswer('the connection has no address'), connection: true };
    // TODO(peer-identity-remote): another machine of the network is not looked up and keeps the rules from before.
    if (!isThisMachine(remote)) return { status: 'remote' };
    if (!supported) return unsupportedPeerVerdict(unsupportedReason);
    let table;
    try { table = await tcpTable(); } catch (error) { return failedPeerVerdict(`netstat: ${failureText(error)}`, { retryable: isTransientLookupError(error) }); }
    const row = table.rows.find((r) => r.local.port === remotePort && r.local.addr === remote && r.foreign.port === localPort && (r.foreign.addr === local || !local));
    if (!row || !row.pid) return { status: 'gone', reason: 'the connection closed before its request was identified', ms: now() - started };
    if (row.pid === selfPid) return { status: 'ok', self: true, pid: row.pid, name: row.name, chain: [], refuse: null, ms: now() - started };
    let chain;
    try { chain = await chainOf(row.pid, row.name, table.startedAt); } catch (error) { return { ...failedPeerVerdict(`ps: ${failureText(error)}`, { retryable: isTransientLookupError(error) }), pid: row.pid }; }
    // The process table was read and the client is not in it: it sent its request and exited without waiting for the
    // answer (a one-shot relay). A browser or a brain waits for its answer; this is treated like a closed socket.
    if (!chain || !chain.length) return { status: 'gone', reason: 'the client process exited before it was identified', pid: row.pid, ms: now() - started };
    let synabunMcp = 0;
    try { synabunMcp = await synabunMcpPid(chain[0], table.listening); } catch { synabunMcp = 0; }
    const verdict = classifyPeerChain(chain, { selfPid, listening: table.listening, synabunMcp, debugClient: isLoopbackAddress(remote) ? debugPolicy : null });
    if (verdict.debugExempt) note(`debug:${row.pid}`, `[peer-identity] WARNING: accepted a debug client as the owner (pid ${row.pid}, ${row.name || chain[0].ucomm}) under SYNABUN_ALLOW_DEBUG_CLIENT`);
    return { status: 'ok', self: verdict.self, pid: row.pid, name: row.name || chain[0].ucomm, chain, refuse: verdict.refuse, ms: now() - started };
  }

  /** One attempt, capped: the request never waits past `capMs` for it (the programs it started end by their own timeouts). */
  function attempt(socket) {
    let timer = null;
    const cap = new Promise((resolve) => { timer = setTimeout(() => resolve(noAnswer(`the lookup took over ${capMs} ms`, { retryable: true })), capMs); timer.unref?.(); });
    const work = Promise.resolve().then(() => identify(socket)).catch((error) => noAnswer(`the lookup failed (${error?.message || error})`));
    return Promise.race([work, cap]).finally(() => clearTimeout(timer));
  }
  /** A lookup, and once more at once when its failure may pass (a timeout, a busy system). */
  async function settle(socket) {
    const first = await attempt(socket);
    if (!(first.status === 'unknown' && first.kind === 'failed' && first.retryable && !first.connection)) return first;
    stats.retries++;
    const second = await attempt(socket);
    return second.status === 'unknown' && second.kind === 'failed' ? { ...second, retried: true } : second;
  }
  /**
   * The peer of a request's connection, looked up once per connection (keep-alive requests share it). Never rejects.
   * Kept on the connection: an answer (ok, another machine, not looked up here) for its lifetime; a failed lookup for
   * `ttlMs` only (a burst of requests shares it, the next one after that looks again, so an open tab recovers once the
   * lookup works); a client that left never (gone: the next request on it is looked up afresh).
   */
  function lookup(req) {
    const socket = req?.socket || req?.connection || null;
    if (!socket || typeof socket !== 'object') return Promise.resolve({ ...noAnswer('no connection'), connection: true });
    const kept = bySocket.get(socket);
    if (kept && (kept.pending || kept.until > now())) return kept.promise;
    const entry = { pending: true, until: 0, promise: null };
    entry.promise = settle(socket).then((verdict) => {
      entry.pending = false;
      noteOutcome(verdict);
      const failed = verdict.status === 'unknown' && verdict.kind === 'failed';
      entry.until = verdict.status === 'gone' ? 0 : failed ? now() + ttlMs : Infinity;
      if (!(entry.until > now()) && bySocket.get(socket) === entry) bySocket.delete(socket);
      return verdict;
    });
    bySocket.set(socket, entry);
    return entry.promise;
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
   * authority, and keeps the verdict on the request (peerAuthority() reads it). A brain credential from a peer outside
   * the brain's own process tree is removed from the request. It never answers a request itself: on another platform
   * (or off) a lookup that cannot run leaves the rules from before in force; on macOS it leaves a failed verdict, which
   * the owner gate and the page secret answer with 503 PEER_UNAVAILABLE.
   */
  function middleware({ needs = () => false } = {}) {
    // Express 4 does not catch a rejected promise: the decision is made apart from next(), which is called exactly
    // once whatever happens in it.
    return function peerIdentity(req, res, next) {
      if (disabled) return next();
      let wanted = false;
      // A needs() that throws cannot say the request asks for nothing: where the lookup runs, it is looked up.
      try { wanted = needs(req) === true; } catch { wanted = supported; }
      const credential = typeof req.headers?.[BRAIN_HEADER] === 'string' ? req.headers[BRAIN_HEADER].trim() : null;
      if (!wanted && !credential) return next();
      decide(req, wanted, credential).then(() => next(), (error) => {
        try {
          if (supported) {
            // Never the rules from before by accident: on macOS a decision that broke is a lookup that failed, with no
            // owner authority and no brain credential for this request. (A request that cannot even hold the verdict
            // is left without one, which the callers of a server whose lookup runs take as a failed lookup too.)
            const verdict = failedPeerVerdict(`the lookup failed (${error?.message || error})`);
            if (req.headers && credential) delete req.headers[BRAIN_HEADER];
            noteOutcome(verdict);
            note(`error:${error?.message}`, `[peer-identity] the lookup failed (${error?.message || error}): no owner authority for this request (503 PEER_UNAVAILABLE)`);
            req[PEER_VERDICT] = verdict;
          } else {
            note(`error:${error?.message}`, `[peer-identity] the lookup failed (${error?.message || error}); the page secret's rules from before apply`);
          }
        } catch { /* a request that cannot be written to: see above */ }
        next();
      });
    };
  }
  /** The lookup for one request: the verdict kept on it, a brain credential from outside its brain's tree dropped. */
  async function decide(req, wanted, credential) {
    const t0 = now();
    let peer;
    try { peer = await lookup(req); } catch (error) { peer = noAnswer(`the lookup failed (${error?.message || error})`); }
    if (!peer || typeof peer !== 'object') peer = noAnswer('the lookup gave no answer');
    const ms = now() - t0;
    stats.lookups++; stats.totalMs += ms; if (ms > stats.maxMs) stats.maxMs = ms;
    req[PEER_VERDICT] = peer;
    if (peer.status === 'unknown') {
      stats.unknown++;
      if (peer.kind === 'failed') {
        stats.failed++;
        note(`failed:${peer.reason}`, `[peer-identity] could not tell who is asking (${peer.reason}${peer.retried ? ', tried twice' : ''}): no page secret, owner authority or brain credential for it (503 PEER_UNAVAILABLE)`);
      } else note(`unknown:${peer.reason}`, `[peer-identity] could not tell who is asking (${peer.reason}); the page secret's rules from before apply`);
    }
    if (peer.status === 'gone') { stats.gone++; note(`gone`, `[peer-identity] ${peer.reason || 'a connection closed before its request was identified'}: no owner authority for it`); }
    if (peer.status === 'ok' && peer.refuse && wanted) {
      stats.refused++;
      note(`refuse:${peer.refuse.pid}:${peer.refuse.kind}`, `[peer-identity] no page secret / owner authority for pid ${peer.refuse.pid} (${peer.refuse.name}): ${peer.refuse.why}`);
    }
    if (!credential) return;
    // Kept: from this server itself, from the brain's own tree (it holds the credential in its environment), or where
    // no lookup runs (another platform: the credential alone, as before). Dropped: from anywhere else, from a client
    // that left, and on macOS whenever its check could not run (the lookup failed, or ps -E could not be read).
    let keep = true;
    if (peer.status === 'gone') keep = false;
    else if (peer.status === 'unknown' && peer.kind === 'failed') keep = false;
    else if (peer.status === 'ok' && !peer.self) {
      try { keep = await chainHoldsCredential(peer.chain || [], credential); } catch (error) {
        keep = false;
        // The whole request then has no proven caller: answered 503 (retryable when ps -E only timed out).
        const failed = { ...failedPeerVerdict(`ps -E: ${failureText(error)}`, { retryable: isTransientLookupError(error) }), pid: peer.pid };
        req[PEER_VERDICT] = failed;
        noteOutcome(failed);
        note(`env:${error?.code || error?.message}`, `[peer-identity] could not read a brain's environment (${failureText(error)}): the brain credential was dropped and the request has no owner authority (503 PEER_UNAVAILABLE)`);
      }
    }
    if (!keep) {
      delete req.headers[BRAIN_HEADER];
      const why = peer.status === 'unknown' ? `its check could not run (${peer.reason})` : 'outside the brain\'s own process tree';
      note(`brain:${peer.pid || peer.status}`, `[peer-identity] a brain credential came from pid ${peer.pid || '?'} (${peer.name || (peer.status === 'gone' ? 'closed connection' : 'not identified')}), ${why}: it was dropped from the request`);
    }
  }

  /**
   * Why this request may not hold or use the owner's page secret (a short sentence), or null: a refused peer, a client
   * that left, and on macOS a lookup that failed (no proof of who is asking). Null when the peer is allowed, was never
   * looked up, or is not looked up here (another platform, off, another machine): the caller's rules from before.
   */
  function refusal(req) {
    const auth = peerAuthority(req?.[PEER_VERDICT]);
    if (auth.decision === 'refused') return auth.gone ? auth.why : `${auth.why}: pid ${auth.pid} (${auth.name})`;
    if (auth.decision === 'unavailable') return `a request SynaBun could not identify (${auth.reason})`;
    return null;
  }

  return { supported, lookup, middleware, refusal, chainHoldsCredential, probe, authorityState, stats: () => ({ ...stats, avgMs: stats.lookups ? Math.round((stats.totalMs / stats.lookups) * 10) / 10 : 0 }) };
}

/** Exposed for tests: whether an address is a literal IP (4 or 6). */
export function isIpLiteral(addr) { return isIP(normalizeAddress(addr)) !== 0; }
