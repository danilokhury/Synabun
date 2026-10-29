// ═══════════════════════════════════════════
// SynaBun — relay-capable local listeners a guarded worker must not reach (macOS netstat / Linux lsof, + ps)
// ═══════════════════════════════════════════
//
// A guarded worker's Seatbelt profile (lib/worker-sandbox.js) denies SynaBun's own control port and the OpenCode
// serve range. But other LOCAL listeners can relay the worker back to owner authority just as well:
//   • a browser control port — MoreLogin's Chromium CDP endpoint (http://127.0.0.1:<debugPort>/json/version), the
//     attach-mode Chrome's --remote-debugging-port, any Chromium-family browser started with remote debugging, a
//     browser whose DevTools port was switched on from its own settings, a Node inspector (--inspect): with it a
//     worker runs code outside its sandbox, clears the automation marker, loads SynaBun and acts as owner;
//   • MoreLogin's local API (:40000, :15523): a worker starts another profile with its own CDP;
//   • any OTHER SynaBun instance's server (a dev/test :3344 and its live memory), a stale OpenCode serve, the
//     Codex app-server, a listening AI agent — each a password-in-env or page-cookie relay;
//   • SynaBun's own MCP server over HTTP (mcp-server/dist/http.js, `npm run start:http`): SynaBun takes its pinned
//     calls like an MCP tool's (lib/peer-identity.js), so a worker that reached it would act through it;
//   • a proxy or tunnel — ssh -D / -L, socat, privoxy, mitmproxy, Clash / mihomo, Surge, sing-box, V2Ray / Xray,
//     shadowsocks, cloudflared, ngrok, frpc … — which carries the worker's connection to SynaBun's port from a
//     process outside the sandbox.
//
// These ports are DYNAMIC (MoreLogin's CDP is a high random port; a stale serve or a proxy is wherever it bound), so
// a fixed guess cannot find them. This module reads the live LISTEN set (macOS: `netstat -anvl`, which names the
// owning process of every socket in ~4 ms; Linux: lsof) and classifies each owner by its process identity (kernel
// name, argv[0], command line; lib/peer-identity.js processKinds) with `ps`, then returns only the ports owned by a
// relay-capable process. The owner's own dev servers (a plain `node server.mjs`, vite, python) and the worker's own
// servers are NOT in the set — they are not relay-capable identities, so they stay reachable. A proxy the system or
// the environment names for internet access (HTTP(S)_PROXY / ALL_PROXY, macOS's network proxy settings) is kept
// reachable too, so a worker whose internet goes through it keeps its internet: the server refuses that proxy by
// identity when it relays to SynaBun (lib/peer-identity.js), which is the boundary for it.
//
// The answer says whether detection WORKED (`ok`): a missing or slow netstat / lsof / ps, an empty list, or a list
// that does not even hold SynaBun's own port or process is a failure, never "no relays". The caller then writes a
// stricter profile for the run (no local port but the worker channel; lib/worker-sandbox.js strictLocal) and says so
// in the run's transcript. Pure classifier + parsers (unit-tested); the collector takes an injected `run` and NEVER
// throws. macOS / Linux only; on Windows the caller does not run OS isolation at all.

import { existsSync } from 'node:fs';
import {
  MORELOGIN_PATH_RE, NETSTAT_ARGS, lsofCwdArgs, mcpHttpNeedsCwd, mcpHttpScriptPath, normalizeAddress, parseLsofCwd, parseNetstatTcp, parsePsColumn,
  parsePsParents, processKinds,
} from './peer-identity.js';
import { INTERNET_PORTS } from './worker-sandbox.js';

const PORT_RE = /:(\d{1,5})$/;
const NETSTAT = '/usr/sbin/netstat';
const firstExisting = (paths, fallback) => paths.find((p) => { try { return existsSync(p); } catch { return false; } }) || fallback;
/** The commands this module runs, by absolute path where the system has them (PATH is not trusted for these). */
export const RELAY_TOOLS = Object.freeze({
  netstat: NETSTAT,
  get ps() { return firstExisting(['/bin/ps', '/usr/bin/ps'], 'ps'); },
  get lsof() { return firstExisting(['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'], 'lsof'); },
});
/** Ports the internet needs (SSH, DNS, HTTP, HTTPS): a relay found on one of them is denied on this computer's own
 *  addresses only (`localhost:<port>`), never on every host, or the worker would lose the internet (worker-sandbox.js). */
export { INTERNET_PORTS };

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpn` field output → Map<pid, Set<port>>. */
export function parseLsofListeners(text) {
  const byPid = new Map();
  let pid = null;
  for (const raw of String(text || '').split('\n')) {
    if (!raw) continue;
    const tag = raw[0];
    const rest = raw.slice(1);
    if (tag === 'p') { pid = Number(rest); if (!Number.isInteger(pid) || pid <= 0) pid = null; continue; }
    if (tag === 'n' && pid) {
      // rest is an address like "*:7000", "127.0.0.1:3344", "[::1]:3344", "localhost:4096".
      const m = PORT_RE.exec(rest.trim());
      if (!m) continue;
      const port = Number(m[1]);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      if (!byPid.has(pid)) byPid.set(pid, new Set());
      byPid.get(pid).add(port);
    }
  }
  return byPid;
}

/** `netstat -anvl -p tcp` (macOS) → Map<pid, Set<port>> of the LISTEN sockets. */
export function netstatListeners(text) {
  const byPid = new Map();
  for (const row of parseNetstatTcp(text).rows) {
    if (row.state !== 'LISTEN' || !(row.pid > 0) || !row.local?.port) continue;
    if (!byPid.has(row.pid)) byPid.set(row.pid, new Set());
    byPid.get(row.pid).add(row.local.port);
  }
  return byPid;
}

/** Parse `ps -Ao pid=,<field>=` output → Map<pid, string> (comm or args; everything after the pid is the value). */
export function parsePsTable(text) {
  return parsePsColumn(text);
}

/**
 * Is a LISTENING process (by its executable path `comm`, full command line `args` and kernel name `ucomm`) a relay
 * back to owner / brain authority? Returns a short reason tag ('synabun' | 'synabun-mcp' | 'opencode' | 'morelogin' |
 * 'cdp' | 'codex' | 'inspector' | 'agent' | 'proxy') or null. Matches on process IDENTITY, kept specific so an
 * unrelated dev server is never caught:
 *   • a plain `node server.mjs 3000`, a vite/python dev server → null (reachable);
 *   • `node .synabun/design/mascot-hands/serve.mjs` → null (it is not a SynaBun server — only neural-interface/server.js is).
 * `cwd`: the process's working directory, for a relative MCP-over-HTTP script (collectRelayListenerPorts reads it).
 */
export function classifyRelayProcess({ comm = '', args = '', ucomm = '', cwd = null } = {}) {
  const c = String(comm || '').toLowerCase();
  const a = String(args || '').toLowerCase();
  const execBase = c.split('/').pop() || '';
  // A SynaBun server instance — its control port + launch beacon (this instance's are denied anyway; another
  // instance's live :3344 and its memory are the point). ONLY neural-interface/server.js, never a loose "synabun".
  if (/neural-interface[/\\]server\.js/.test(a)) return 'synabun';
  // SynaBun's MCP server over HTTP (any copy's mcp-server/dist/http.js or preload-http.js, run by node): SynaBun takes
  // its pinned calls like an MCP tool's (lib/peer-identity.js), so whoever reaches its port acts through it.
  if (mcpHttpScriptPath({ ucomm, comm, args }, { cwd })) return 'synabun-mcp';
  // An OpenCode serve (the shared one, an isolated one, a stale build on any port). Specific: the `opencode`
  // executable, or `opencode serve` on a command line — never a path that merely contains "opencode".
  if (execBase === 'opencode' || /(^|\/)opencode(\s|$)/.test(a) || /\bopencode\b\s+serve\b/.test(a)) return 'opencode';
  // MoreLogin: the desktop app, its local-API helper, and its bundled Chromium (all carry the MoreLogin bundle path),
  // by their executable's place or kernel name — never by a word in the arguments.
  if (MORELOGIN_PATH_RE.test(String(comm || '')) || /^morelogin/i.test(String(ucomm || ''))) return 'morelogin';
  // Any Chromium-family browser started with remote debugging (the CDP relay): the flag's presence is the signal
  // (a listening process that carries it has an open CDP port, whatever the value — including a 0 that Chrome
  // turned into a real random port).
  if (/--remote-debugging-port=/.test(a)) return 'cdp';
  // The Codex app-server / MCP server (the sidepanel's and the brain's engine).
  if (execBase === 'codex' || /codex-app-server/.test(a) || /\bcodex\b\s+(app-server|exec|mcp|serve)/.test(a)) return 'codex';
  const kinds = processKinds({ ucomm, comm, args });
  // Playwright's / Firefox's automation transports, and a browser the owner uses holding a TCP listener at all: a
  // browser listens only for its DevTools / remote-debugging endpoint (Chrome's own "remote debugging" switch).
  if (kinds.automation || kinds.browser) return 'cdp';
  // A Node (or Electron) inspector: whoever reaches it runs code in that process, outside the sandbox.
  if (/(?:^|\s)--inspect(?:-brk|-port|-wait)?(?:[=\s]|$)/.test(a)) return 'inspector';
  // A listening AI agent (an IDE bridge, an OAuth callback of a brain's CLI): never the worker's to call.
  if (kinds.agent) return 'agent';
  // A proxy / tunnel / port forwarder, by name or by its app bundle; a listening sshd (Remote Login, port forwards).
  if (kinds.relay || kinds.remoteLogin) return 'proxy';
  return null;
}

/**
 * Local proxies the system or the environment names for internet access: their ports stay reachable to a worker
 * (its internet may depend on them). From the server's environment (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, any case)
 * and macOS's network proxy settings (`scutil --proxy`: HTTP, HTTPS and SOCKS when enabled). Only a proxy on this
 * computer counts (a remote proxy is not a local listener anyway).
 */
export function localProxyPorts({ env = process.env, scutilText = '' } = {}) {
  const ports = new Set();
  const isLocal = (host) => {
    const h = normalizeAddress(host);
    return h === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0:0:0:0:0:0:0:1' || h === '0.0.0.0';
  };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const v = typeof env?.[key] === 'string' ? env[key].trim() : '';
    if (!v) continue;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`);
      const port = Number(u.port);
      if (isLocal(u.hostname) && port > 0) ports.add(port);
    } catch { /* not a URL */ }
  }
  const kv = {};
  for (const line of String(scutilText || '').split('\n')) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) kv[m[1]] = m[2];
  }
  for (const kind of ['HTTP', 'HTTPS', 'SOCKS']) {
    const port = Number(kv[`${kind}Port`]);
    if (kv[`${kind}Enable`] === '1' && isLocal(kv[`${kind}Proxy`]) && port > 0) ports.add(port);
  }
  return [...ports].sort((x, y) => x - y);
}

/**
 * The live set of relay-capable LISTEN ports, by process identity. Never throws.
 * @param {object} o
 * @param {(file:string, args:string[]) => string} o.run runs a program and returns its stdout (execFileSync-shaped;
 *   a throw is a failed detection).
 * @param {string} [o.platform] default process.platform; anything but darwin/linux ⇒ { ok: false }.
 * @param {number} [o.expectPort] SynaBun's own port: a listener list without it is not believed (ok: false).
 * @param {number} [o.expectPid] SynaBun's own pid: a process list without it is not believed (ok: false).
 * @param {number[]} [o.keepPorts] ports never returned (the local proxies the worker's internet goes through).
 * @returns {{ ok:boolean, reason:string|null, ports:number[], detail:Array<{pid:number,port:number,why:string}> }}
 */
export function collectRelayListenerPorts({ run, platform = process.platform, expectPort = null, expectPid = null, keepPorts = [] } = {}) {
  const fail = (reason) => ({ ok: false, reason, ports: [], detail: [] });
  if (typeof run !== 'function') return fail('no way to run the system tools');
  if (platform !== 'darwin' && platform !== 'linux') return fail(`relay detection is not available on ${platform}`);
  const why = (error) => String(error?.code || error?.message || error || 'failed').slice(0, 160);
  let listeners;
  try {
    listeners = platform === 'darwin'
      ? netstatListeners(run(RELAY_TOOLS.netstat, [...NETSTAT_ARGS]))
      : parseLsofListeners(run(RELAY_TOOLS.lsof, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']));
  } catch (error) { return fail(`the list of listening programs could not be read (${why(error)})`); }
  if (!listeners.size) return fail('the list of listening programs came back empty');
  if (Number(expectPort) > 0 && ![...listeners.values()].some((set) => set.has(Number(expectPort)))) {
    return fail(`the list of listening programs did not include SynaBun's own port ${Number(expectPort)}`);
  }
  let parents, comms, argv;
  try {
    const ps = RELAY_TOOLS.ps;
    parents = parsePsParents(run(ps, ['-Ao', 'pid=,ppid=,ucomm=']));
    comms = parsePsColumn(run(ps, ['-Aww', '-o', 'pid=,comm=']));
    argv = parsePsColumn(run(ps, ['-Aww', '-o', 'pid=,args=']));
  } catch (error) { return fail(`the process list could not be read (${why(error)})`); }
  if (!argv.size) return fail('the process list came back empty');
  if (Number(expectPid) > 0 && !argv.has(Number(expectPid))) return fail('the process list did not include SynaBun\'s own server');
  const keep = new Set((keepPorts || []).map(Number));
  const ports = new Set();
  const detail = [];
  for (const [pid, portSet] of listeners) {
    const proc = { comm: comms.get(pid) || '', args: argv.get(pid) || '', ucomm: parents.get(pid)?.ucomm || '' };
    let tag = classifyRelayProcess(proc);
    // A relative `node dist/http.js` / `dist/preload-http.js` (`npm run start:http` in mcp-server/): its working
    // directory says whether it is SynaBun's MCP server over HTTP. One that cannot be read is taken for it (denied).
    if (!tag && mcpHttpNeedsCwd(proc)) {
      let cwd = null;
      try { cwd = parseLsofCwd(run(RELAY_TOOLS.lsof, lsofCwdArgs(pid))); } catch { cwd = null; }
      tag = cwd ? classifyRelayProcess({ ...proc, cwd }) : 'synabun-mcp';
    }
    if (!tag) continue;
    for (const port of portSet) {
      if (keep.has(port) || ports.has(port)) continue;
      ports.add(port);
      detail.push({ pid, port, why: tag });
    }
  }
  return { ok: true, reason: null, ports: [...ports].sort((x, y) => x - y), detail };
}
