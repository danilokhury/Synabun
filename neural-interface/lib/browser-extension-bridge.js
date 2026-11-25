import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { compareVersions } from './browser-extension-folder.js';
import { dirname } from 'node:path';
import { lookup } from 'node:dns/promises';
import { WebSocketServer } from 'ws';
import { anyOrigin, channel, command, COMMAND_WAIT, commandWait as operationWait, CONTROL, controlSurface, equalMac, ERROR_TEXT, fail, handle, HISTORY, inventory, localHost, LONG_OPS_SINCE, longOp, mac, MAX_MESSAGE, nonce, object, pairingKey, parse, payload, portOf, publicOrigin, safeError, string } from './browser-extension-protocol.js';
import { EXTENSION_ID } from './browser-extension-pin.js';

// The wire contract is the app's own copy of the extension's protocol.js (kept byte-identical by
// scripts/extension/check-browser-extension-pin.mjs), and the extension's identity is the app's pin: the server
// starts, restores a pairing and checks an Origin with no extension folder anywhere.
export { EXTENSION_ID };
const empty = () => ({ tabs: [], sites: [], allowNewTabs: false, uploads: false, downloads: false });
export async function publicDestination(url, resolver = lookup) {
  const origin = publicOrigin(url);
  const addresses = await resolver(new URL(origin).hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => {
    if (address.includes(':')) return !/^2[0-9a-f]{3}:/i.test(address) || /^2001:(0:|db8:)/i.test(address);
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  })) fail('SITE_NOT_APPROVED');
  return origin;
}

// An address that is this computer: loopback, unspecified, or one of its own interface addresses (`selfHosts`).
function selfAddress(address, selfHosts) {
  return localHost(address, selfHosts) || /^::ffff:/i.test(address) && localHost(address.slice(7), selfHosts);
}

/**
 * Where the paired credential and the owner's mode are kept across restarts: one JSON file, readable by the owner only
 * (0600, in a 0700 folder), replaced in one rename. It holds the credential (an HMAC key: never logged, never in a
 * status), its expiry, the port, whether the owner disconnected, and the mode with its version. Never throws.
 */
export function createBridgeStore(path) {
  return {
    path,
    read() {
      try { if (!lstatSync(path).isFile()) return null; const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' ? value : null; }
      catch { return null; }
    },
    write(value) {
      const folder = dirname(path);
      mkdirSync(folder, { recursive: true, mode: 0o700 }); try { chmodSync(folder, 0o700); } catch {}
      const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
      finally { rmSync(temporary, { force: true }); }
      try { chmodSync(path, 0o600); } catch {}
    },
  };
}

/** Isolated loopback transport. Constructing it neither listens nor reads/writes user data (restore() does). */
// `commandWait` is how long a request waits for the extension's answer (COMMAND_WAIT; smaller only in tests), on the
// monotonic `clock`. Each command carries what is left of that wait when it is sent, as its `deadline`.
// A long operation (protocol.js longOp: `evaluate`, `wait` with `loadState`) waits its own time instead: its timeout
// plus a margin, at most LONG_WAIT (protocol.js commandWait). A smaller `commandWait` (tests) bounds those too.
// `fullControl` is the mode before the owner chose one (on: agents may use any http(s) site and any tab of the paired
// browser; off: only what the owner shares). `store` keeps the pairing and the mode across restarts (createBridgeStore).
// SynaBun's own addresses stay out of reach in both modes: `forbiddenOrigins` (its public aliases, any port),
// `blockedPorts` (its ports; the bridge's own is always added) on this computer, which is localhost, a loopback address
// or one of `selfHosts` (its names and interface addresses) or a name that resolves to one (`lookupAddresses`).
export function createExtensionBridge({ port = 3345, log = () => {}, onInventory = () => {}, resolvePublic = publicDestination, now = Date.now, forbiddenOrigins = () => [], revokedTabsKept = 1024,
  commandWait = COMMAND_WAIT, clock = () => performance.now(), fullControl = true, store = null, blockedPorts = () => [], selfHosts = () => [],
  lookupAddresses = host => lookup(host, { all: true }) } = {}) {
  if (!Number.isSafeInteger(commandWait) || commandWait < 1 || commandWait > COMMAND_WAIT) fail('INVALID_MESSAGE');
  const waitOf = (op, args) => commandWait < COMMAND_WAIT ? commandWait : operationWait(op, args);
  let server, wss, listening, pair = null, credential = null, peer = null, state = empty(), enabled = true;
  // The owner's mode and its version. The newer version wins on either side: the server's (Settings) or the
  // extension's (its popup, reported in an inventory). Only the owner changes it: setMode() behind the owner route,
  // or the popup. Nothing an agent sends carries a mode.
  let mode = { fullControl: fullControl === true, version: 0 };
  // A server process does not know the agents of the previous one: the first extension it hears from (one that knows
  // the `reset` message) gives every tab back to the owner.
  let resetDue = true;
  let revision = 0, pairingAttempts = 0, credentialUntil = 0;
  // When the current credential was paired (a stored one: 30 days before its expiry), and whether a pairing window is
  // the one-button setup's (`pair.setup`: its one-time token, made by beginSetupPairing, never a typed code).
  let pairedAt = 0;
  const PAIRING_LIFE = 30 * 86400000;
  // `authentication` moves on revoke, disconnect and every new pairing: a handshake commits only in the generation it
  // began in, and a peer is obeyed only in the generation it was admitted in. `revocations` moves when any owner
  // revocation begins: a command issued before it is never forwarded after it, and its result is refused.
  let authentication = 0, revocations = 0;
  // revokedSites: origin → the newest approval version known when the owner revoked it here. An inventory brings the
  // site back only with a newer version, which only the owner's gesture in the popup creates.
  // revokedTabs holds one random handle per tab revoked here, so it is the record that grows with use: it keeps the
  // newest `revokedTabsKept` (1024), dropping the oldest. The site maps hold one entry per distinct origin and are kept whole
  // (dropping one would let a stale inventory bring its site back). A new pairing clears all three.
  const revokedTabs = new Set(), revokedSites = new Map(), siteVersions = new Map();
  const revokeTabRecord = tab => {
    revokedTabs.delete(tab); revokedTabs.add(tab);
    for (const old of revokedTabs) { if (revokedTabs.size <= revokedTabsKept) break; revokedTabs.delete(old); }
  };
  const blockedHosts = () => forbiddenOrigins().map(value => { try { return new URL(value.includes('://') ? value : `https://${value}`).hostname; } catch { return ''; } }).filter(Boolean);
  const hostList = values => [...new Set((values || []).map(String).map(h => h.replace(/^\[|\]$/g, '')).filter(h => h.length <= 253 && /^[a-zA-Z0-9.:%-]+$/.test(h)))].slice(0, 200);
  // What no command may reach: SynaBun's own addresses (protocol.js controlSurface), sent with every command too.
  const targets = () => {
    let ports = []; try { ports = blockedPorts() || []; } catch {}
    const own = server?.address()?.port || port;
    ports = [...new Set([own, ...ports].map(Number).filter(p => Number.isSafeInteger(p) && p >= 1 && p <= 65535))].slice(0, 32);
    let self = []; try { self = selfHosts() || []; } catch {}
    return { blockedHosts: hostList(blockedHosts()), blockedPorts: ports, selfHosts: hostList(self) };
  };
  // Full control: any http(s) page or the blank page, never a browser page nor SynaBun's own (by its form).
  const openable = url => { anyOrigin(url); if (controlSurface(url, targets())) fail('SYNABUN_PAGE_BLOCKED'); };
  // ... and by DNS: a name on one of SynaBun's ports that resolves to this computer (or cannot be resolved) is refused.
  async function openDestination(url) {
    openable(url);
    if (url === 'about:blank') return;
    const u = new URL(url), seen = targets();
    if (!seen.blockedPorts.includes(portOf(u))) return;
    let addresses;
    try { addresses = await lookupAddresses(u.hostname.replace(/^\[|\]$/g, '')); } catch { fail('SYNABUN_PAGE_BLOCKED'); }
    if (!addresses?.length || addresses.some(({ address }) => selfAddress(String(address), seen.selfHosts))) fail('SYNABUN_PAGE_BLOCKED');
  }
  // Writes the pairing and the mode (owner-only file). A failure is logged by its code and never stops the bridge.
  function persist() {
    if (!store) return;
    try {
      store.write({ v: 1, ...(credential ? { credential, credentialUntil } : {}), port: server?.address()?.port || port, paused: !enabled,
        fullControl: mode.fullControl, modeVersion: mode.version });
    } catch { note('persist', null, 'OPERATION_FAILED'); }
  }
  const pending = new Map();
  const sockets = new Set();
  const note = (op, tab, code) => { try { log({ command: op, tab: typeof tab === 'string' && /^[a-f0-9]{32}$/.test(tab) ? tab : null, code: code === 'OK' || Object.hasOwn(ERROR_TEXT, code) ? code : 'OPERATION_FAILED' }); } catch {} };
  const coded = code => () => Object.assign(new Error(code), { code });
  const notConnected = coded('NOT_CONNECTED'), cancelled = coded('CANCELLED');
  // Rejects pending requests at once. `keepControl` spares the owner's own revocations, which must still reach the extension.
  function settle(error, keepControl = false) {
    for (const [id, p] of pending) {
      if (keepControl && CONTROL.includes(p.op)) continue;
      clearTimeout(p.timer); pending.delete(id); p.reject(error());
    }
  }
  // The extension's mode, when an inventory carries it: a newer one is the owner's latest choice (the popup) and is
  // taken; switching to restricted that way is a revocation. An older one (or the same version saying otherwise) is
  // told the server's choice, once per connection and version.
  function peerMode(from, fullControlNow, version) {
    if (version > mode.version) {
      const narrowing = mode.fullControl && !fullControlNow;
      mode = { fullControl: fullControlNow, version }; persist();
      if (narrowing) revoking();
    } else if (version < mode.version || fullControlNow !== mode.fullControl) pushMode(from);
  }
  function pushMode(to = peer) {
    const key = `${mode.version}:${mode.fullControl}`;
    if (!to || to !== peer || to.pushedMode === key) return;
    to.pushedMode = key;
    void request('mode', null, 'owner', { fullControl: mode.fullControl, version: mode.version }).catch(() => { if (to.pushedMode === key) to.pushedMode = null; });
  }
  function update(value, from = null) {
    const { versions, fullControl: fullControlNow, modeVersion, ...next } = inventory(value);
    if (from && modeVersion !== undefined) peerMode(from, fullControlNow, modeVersion);
    if (from && !from.ready) {
      from.ready = true;
      // Only an extension that knows `reset` (it reports a mode) is sent one; an older one keeps what it holds.
      if (resetDue && modeVersion !== undefined) { resetDue = false; void request('reset', null, 'owner').catch(() => { resetDue = true; }); }
    }
    if (versions) next.sites.forEach((site, i) => siteVersions.set(site, Math.max(siteVersions.get(site) || 0, versions[i])));
    next.tabs = next.tabs.filter(t => !revokedTabs.has(t.handle));
    next.sites = next.sites.filter((site, i) => !revokedSites.has(site) || (versions ? versions[i] : siteVersions.get(site) || 0) > revokedSites.get(site));
    state = next; revision++; onInventory({ ...state, fullControl: mode.fullControl });
  }
  // An owner revocation begins: cancel everything issued before it, synchronously, before the extension is told.
  function revoking() { revocations++; settle(cancelled, true); }
  // Ends the connection and every handshake still under way; nothing admitted before acts after.
  function cut() {
    enabled = false; authentication++; revocations++;
    peer = null; for (const ws of sockets) ws.close();
    settle(notConnected);
  }
  // The owner's Disconnect: kept across a restart (the bridge stays off until Resume).
  function disconnect() { cut(); persist(); }
  function forget() { cut(); credential = null; credentialUntil = 0; pairedAt = 0; pair = null; update(empty()); }
  // Revoke pairing: the stored credential goes too, so a restart does not bring it back.
  function revoke() { forget(); persist(); }
  async function start() {
    if (listening) return listening;
    listening = new Promise((resolve, reject) => {
      // An upload command id doubles as a short-lived capability. Only the paired extension
      // receives it. Each file can be read once, in order, while its command is authorized.
      server = createServer((req, res) => {
        const match = /^Bearer ([a-f0-9]{32})$/.exec(req.headers.authorization || '');
        const p = match && pending.get(match[1]);
        if (!p?.upload || req.method !== 'POST' || req.url !== '/upload/' + p.nextFile ||
            p.nextFile >= p.args.files.length || req.headers.origin !== `chrome-extension://${EXTENSION_ID}` ||
            req.headers.host !== `127.0.0.1:${server.address()?.port}` ||
            p.issued !== revocations || clock() >= p.expires) {
          res.writeHead(404).end(); return;
        }
        try {
          authorize('upload', p.tab, p.owner, p.args);
          const { bytes, type, lastModified } = p.upload.read(p.nextFile++);
          res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': type, 'Content-Length': bytes.length,
            'X-Content-Type-Options': 'nosniff', 'X-SynaBun-Last-Modified': lastModified }).end(bytes);
        } catch (error) {
          res.writeHead(400, { 'Cache-Control': 'no-store' }).end(safeError(error).code);
        }
      });
      wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
      server.on('upgrade', (req, socket, head) => {
        if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin !== `chrome-extension://${EXTENSION_ID}` || req.url !== '/bridge'
          || req.headers.host !== `127.0.0.1:${server.address()?.port}` || sockets.size >= 4) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => { void connect(ws); });
      });
      server.once('error', error => { listening = null; reject(error); });
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
    return listening;
  }
  async function connect(ws) {
    sockets.add(ws);
    const session = nonce(), admitted = authentication;
    let wire = null, chain = Promise.resolve(), outbound = Promise.resolve();
    // A command is checked, and its deadline set to what is left of the request's wait, right before it is signed, and
    // checked again in the same synchronous step that sends it (encode's `deliver`): a refusal then uses no sequence
    // number, so the channel stays in step. A command with less than a millisecond left is not sent (TIMEOUT).
    const send = body => {
      const check = () => {
        if (body.type !== 'command') return;
        const p = pending.get(body.id);
        if (!p || peer?.ws !== ws) fail('NOT_CONNECTED');
        if (!CONTROL.includes(body.op) && p.issued !== revocations) fail('CANCELLED');
        if (clock() >= p.expires) fail('TIMEOUT');
        authorize(body.op, body.tab, body.owner, body.args);
      };
      outbound = outbound.catch(() => {}).then(async () => {
        if (body.type === 'command') {
          check();
          const p = pending.get(body.id);
          body = command({ ...body, deadline: Math.max(1, Math.min(p.wait, Math.floor(p.expires - clock()))) });
        }
        await wire.encode(body, raw => { check(); if (ws.readyState !== 1) fail('NOT_CONNECTED'); ws.send(raw); });
      }); return outbound;
    };
    const timer = setTimeout(() => ws.close(), 10000); timer.unref?.();
    let lastSeen = Date.now();
    const heartbeat = setInterval(() => { if (Date.now() - lastSeen > 65000) ws.close(); else if (wire) void send({ type: 'ping' }).catch(() => ws.close()); }, 20000); heartbeat.unref?.();
    ws.send(JSON.stringify({ type: 'challenge', session }));
    ws.on('message', raw => {
      chain = chain.then(async () => {
        if (!wire) {
          // `version`: the extension's manifest version (1.2.0 and later send it), so the owner is told when the browser
          // still runs an older copy than the folder holds. Optional: an older extension sends none.
          const hello = parse(raw.toString(), 2048); object(hello, ['type', 'mode', 'client', 'proof', 'version']);
          if (hello.type !== 'hello' || !['pair', 'resume'].includes(hello.mode)) fail('AUTH_FAILED');
          handle(hello.client); string(hello.proof, 64);
          if (hello.version !== undefined && !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(string(hello.version, 23))) fail('AUTH_FAILED');
          if (admitted !== authentication) fail('AUTH_FAILED');
          const isPair = hello.mode === 'pair', pairWindow = pair;
          if (isPair && (!pairWindow || pairWindow.until < now() || ++pairingAttempts > 5)) fail('PAIRING_EXPIRED');
          const key = isPair ? pairWindow.key : now() < credentialUntil ? credential : null;
          if (!enabled || !key || !await equalMac(key, `hello:${session}:${hello.client}`, hello.proof)) fail('AUTH_FAILED');
          // A setup's token was presented: the setup shows "Pairing…" until the extension is connected.
          if (isPair && pairWindow.setup) pairWindow.attempted = true;
          // Authenticate the server too. A fake loopback server learns no reusable credential.
          const proof = await mac(key, `welcome:${session}:${hello.client}`);
          // The awaits above leave room for a revoke, a disconnect or a new pairing. Commit only if none happened: the
          // same generation, the bridge on, this socket open, and the key still the current credential or pairing window.
          if (admitted !== authentication || !enabled || ws.readyState !== 1
            || (isPair ? pair !== pairWindow || pairWindow.until < now() : key !== credential || now() >= credentialUntil)) fail('AUTH_FAILED');
          const previous = peer;
          peer = { ws, send, session, key, generation: admitted, ready: false, pushedMode: null, version: hello.version || null }; previous?.ws.close();
          if (previous) settle(notConnected);
          // A new pairing starts from a cleared extension: nothing of a previous process to hand back.
          // A setup's token is gone with it (single use): `pair` is cleared in this same step. A setup pairing, like a
          // typed one, starts from nothing revoked (beginPairing clears these when its window opens).
          if (isPair) {
            if (pairWindow.setup) { revokedTabs.clear(); revokedSites.clear(); siteVersions.clear(); }
            credential = key; pairedAt = now(); credentialUntil = pairedAt + PAIRING_LIFE; pair = null; resetDue = false; update(empty()); persist();
          }
          wire = channel(key, session, 'server'); clearTimeout(timer);
          ws.send(JSON.stringify({ type: 'welcome', proof }));
          return;
        }
        if (peer?.ws !== ws || !enabled) fail('AUTH_FAILED');
        const message = payload(await wire.decode(raw.toString())); lastSeen = Date.now();
        if (message.type === 'pong') return;
        if (message.type === 'unpair') { revoke(); return; }
        if (message.type !== 'state' && message.type !== 'result') fail('INVALID_MESSAGE');
        update(message.inventory, peer);
        if (message.type === 'result') {
          const p = pending.get(message.id); if (!p) return;
          pending.delete(message.id); clearTimeout(p.timer);
          try {
            if (!CONTROL.includes(p.op) && p.issued !== revocations) fail('CANCELLED');
            if (p.op !== 'create' && p.op !== 'claim' && p.op !== 'release' && !CONTROL.includes(p.op)) authorize(p.op, p.tab, p.owner, p.args);
            p.resolve(message.result);
          } catch (error) { p.reject(error); }
        }
      }).catch(error => { note('transport', null, safeError(error).code); ws.close(); });
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(timer); clearInterval(heartbeat); sockets.delete(ws);
      if (peer?.ws === ws) { peer = null; settle(notConnected); }
    });
  }
  function authorize(op, tab, owner, args = {}) {
    authorizeAccess(op, tab, owner, args);
    if (op === 'upload' && compareVersions(peer.version, '1.3.0') < 0) fail('UPLOAD_RELOAD_REQUIRED');
    // An extension from before the long operations ends the connection on a command it does not know (its payload()
    // throws while it authenticates the message): it is never sent one. The owner reloads the extension instead.
    if (longOp(op, args) && compareVersions(peer.version, LONG_OPS_SINCE) < 0) fail('EXTENSION_RELOAD_REQUIRED');
  }
  function authorizeAccess(op, tab, owner, args) {
    if (!enabled || !peer || peer.ws.readyState !== 1) fail('EXTENSION_NOT_CONNECTED');
    // The peer must hold the credential that is current now, admitted in the current generation: a replaced credential
    // is refused even before it would have expired.
    if (peer.generation !== authentication || !credential || peer.key !== credential || now() >= credentialUntil) fail('AUTH_FAILED');
    if (CONTROL.includes(op)) { if (owner !== 'owner') fail('NOT_OWNED'); return; }
    // Until the extension's first inventory on this connection (and the reset that may follow it) nothing else goes.
    if (!peer.ready) fail('EXTENSION_NOT_CONNECTED');
    if (op === 'create') { if (!mode.fullControl && !state.allowNewTabs) fail('PERMISSION_REQUIRED'); return; }
    const t = state.tabs.find(t => t.handle === tab); if (!t) fail('TAB_CLOSED');
    if (op === 'claim') { if (t.owner && t.owner !== owner) fail('NOT_OWNED'); if (mode.fullControl) openable(t.url); return; }
    if (t.owner !== owner) fail('NOT_OWNED');
    if (op === 'release') return;
    if (mode.fullControl) {
      // Full control: no sharing step. Any http(s) page, never a browser page or SynaBun's own.
      for (const url of [t.url, args.url].filter(Boolean)) openable(url);
      if (op === 'download' && !state.downloads) fail('PERMISSION_REQUIRED');
      return;
    }
    for (const url of [t.url, args.url].filter(Boolean)) if (url !== 'about:blank' && blockedHosts().includes(new URL(url).hostname)) fail('SITE_NOT_APPROVED');
    if (t.url !== 'about:blank' && !state.sites.includes(publicOrigin(t.url))) fail('SITE_NOT_APPROVED');
    if (t.url === 'about:blank' && op !== 'navigate' && !HISTORY.includes(op)) fail('SITE_NOT_APPROVED');
    if (args.url && !state.sites.includes(publicOrigin(args.url))) fail('SITE_NOT_APPROVED');
    if (op === 'download' && !state.downloads) fail('PERMISSION_REQUIRED');
  }
  async function request(op, tab, owner, args = {}, upload) {
    // The revocation generation this command was issued in; an owner revocation that begins later cancels it.
    const issued = revocations, stale = () => !CONTROL.includes(op) && issued !== revocations;
    if (pending.size >= 32) fail('TIMEOUT');
    // This command's wait: an ordinary command's, or a long operation's own. The timer, `expires` and the deadline the
    // command carries are all this one number.
    const wait = waitOf(op, args);
    const msg = command({ type: 'command', id: nonce(), op, tab, owner, args, ...targets(), deadline: wait });
    try {
      authorize(op, tab, owner, args);
      const version = revision, connection = peer, full = mode.fullControl;
      const current = state.tabs.find(t => t.handle === tab)?.url;
      // The destination rule of the mode, by DNS too: restricted, public addresses only; full control, never this
      // computer on one of SynaBun's ports.
      const check = url => full ? openDestination(url) : resolvePublic(url);
      if (!['release', 'claim', 'create'].includes(op) && !CONTROL.includes(op)) {
        if (current && current !== 'about:blank') await check(current);
        if (args.url && args.url !== 'about:blank') await check(args.url);
      } else if (op === 'claim' && full && current && current !== 'about:blank') await check(current);
      if (stale()) fail('CANCELLED');
      if (version !== revision || connection !== peer) authorize(op, tab, owner, args);
      const via = peer;
      const result = await new Promise((resolve, reject) => {
        // The wait starts here, and the deadline the command carries is what is left of it when it is sent. When the
        // wait ends the command is forgotten (a late result finds no pending entry and is dropped) and the extension is
        // told to stop it, ahead of its queue; its own deadline will already have stopped it.
        const timer = setTimeout(() => {
          pending.delete(msg.id); reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }));
          if (peer === via && via.ws.readyState === 1) void via.send({ type: 'cancel', id: msg.id }).catch(() => {});
        }, wait);
        pending.set(msg.id, { resolve, reject, timer, op, tab, owner, args, upload, nextFile: 0, issued, wait, expires: clock() + wait });
        via.send(msg).catch(error => { clearTimeout(timer); pending.delete(msg.id); reject(['CANCELLED', 'TIMEOUT'].includes(error?.code) ? coded(error.code)() : notConnected()); });
      });
      if (HISTORY.includes(op) && result.ok) {
        // The extension already refused an unapproved landing page and the result handler re-authorized against the
        // new inventory. Also hold the landing page to navigate's rules: the URL the result names is the one the
        // inventory holds, and it resolves to a public address. Otherwise nothing of it reaches the agent.
        const landed = state.tabs.find(t => t.handle === tab)?.url;
        if (!landed || result.url !== landed) fail(mode.fullControl ? 'TAB_NOT_APPROVED' : 'SITE_NOT_APPROVED');
        if (landed !== 'about:blank') await (mode.fullControl ? openDestination(landed) : resolvePublic(landed));
        if (stale()) fail('CANCELLED');
        authorize(op, tab, owner, args);
      }
      note(op, tab || result.tab, result.code || 'OK'); return result;
    } catch (error) { note(op, tab, safeError(error).code); throw error; }
  }
  return {
    request, authorize,
    // Whether an agent may be shown or given this page in full control (the session listing): never a browser page
    // or SynaBun's own.
    openable: url => { try { openable(url); return true; } catch { return false; } },
    // Loads the pairing and the mode a previous process stored, and listens again when the pairing is still valid,
    // so the extension reconnects by itself. Returns { restored, listening } (`listening`: the port, or a rejection).
    restore() {
      const saved = store?.read();
      if (!saved) return { restored: false };
      if (typeof saved.fullControl === 'boolean' && Number.isSafeInteger(saved.modeVersion) && saved.modeVersion >= 0) mode = { fullControl: saved.fullControl, version: saved.modeVersion };
      const valid = typeof saved.credential === 'string' && /^[a-f0-9]{64}$/.test(saved.credential) && Number.isSafeInteger(saved.credentialUntil)
        && saved.credentialUntil > now() && Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535;
      if (!valid) { if (saved.credential !== undefined) persist(); return { restored: false }; }
      credential = saved.credential; credentialUntil = saved.credentialUntil; pairedAt = credentialUntil - PAIRING_LIFE; port = saved.port; enabled = saved.paused !== true;
      const listening = start(); listening.catch(() => {});
      return { restored: true, listening };
    },
    // The owner's mode switch (Settings → Browser, behind the owner route). Restricted is a revocation: everything
    // issued before it is cancelled at once, and the extension is told ahead of its queue.
    async setMode(fullControlNext) {
      if (typeof fullControlNext !== 'boolean') fail('INVALID_MESSAGE');
      if (fullControlNext !== mode.fullControl) {
        if (!fullControlNext) revoking();
        mode = { fullControl: fullControlNext, version: Math.max(mode.version + 1, now()) }; persist();
        if (peer?.ready) { peer.pushedMode = `${mode.version}:${mode.fullControl}`; await request('mode', null, 'owner', { fullControl: mode.fullControl, version: mode.version }).catch(() => { if (peer) peer.pushedMode = null; }); }
      }
      return { fullControl: mode.fullControl };
    },
    mode: () => ({ ...mode }),
    async beginPairing(requestedPort = port) {
      if (!Number.isInteger(requestedPort) || (requestedPort < 1024 && !(requestedPort === 0 && port === 0)) || requestedPort > 65535) fail('INVALID_MESSAGE');
      if (!server?.listening) port = requestedPort;
      await start(); forget(); enabled = true; persist(); pairingAttempts = 0; revokedTabs.clear(); revokedSites.clear(); siteVersions.clear();
      const code = randomBytes(10).toString('hex'); pair = { key: await pairingKey(code), until: now() + 120000 };
      return { code, expiresAt: pair.until, port: server.address().port, extensionId: EXTENSION_ID };
    },
    // The one-button setup's pairing window (lib/browser-extension-setup.js; docs → One-button setup). The token is a
    // random 256-bit value that stands in for the typed code in the same HMAC handshake (pairingKey(token)): it never
    // crosses the socket, a pairing commits once and clears it, it expires at `until`, five failed proofs end it, and
    // it exists only while the owner's setup is active (endSetupPairing, a typed pairing, Revoke). Unlike a typed
    // pairing, opening the window does not end the current pairing: the token replaces the credential only when an
    // extension proves it. Returns { token, port, expiresAt }; the caller hands the token to the setup page only.
    async beginSetupPairing({ until, requestedPort = port } = {}) {
      if (!Number.isSafeInteger(until) || until <= now()) fail('INVALID_MESSAGE');
      if (!server?.listening) {
        if (!Number.isInteger(requestedPort) || (requestedPort < 1024 && !(requestedPort === 0 && port === 0)) || requestedPort > 65535) fail('INVALID_MESSAGE');
        port = requestedPort;
      }
      await start();
      const token = randomBytes(32).toString('hex');
      const key = await pairingKey(token);
      // A Disconnect is the owner's; starting a setup is the owner asking to connect, so the bridge listens again.
      enabled = true; pairingAttempts = 0; pair = { key, until, setup: true, attempted: false }; persist();
      return { token, port: server.address().port, expiresAt: until };
    },
    endSetupPairing() { if (pair?.setup) pair = null; },
    setupPairing: () => ({ active: !!pair?.setup && pair.until >= now() && pairingAttempts <= 5, attempted: pair?.setup ? pair.attempted === true : false }),
    // Diagnostics: how many revocation records the bridge keeps (counts only).
    records: () => ({ revokedTabs: revokedTabs.size, revokedSites: revokedSites.size, siteVersions: siteVersions.size }),
    status: () => ({ connected: !!peer && enabled && peer.ready === true, paired: !!credential, port: server?.address()?.port || port, extensionId: EXTENSION_ID,
      fullControl: mode.fullControl, pairedAt: credential ? pairedAt : 0, extensionVersion: peer?.ready ? peer.version : null, ...structuredClone(state) }),
    disconnect,
    resume: () => { enabled = true; persist(); },
    revoke,
    async revokeTab(tab) { handle(tab); revoking(); revokeTabRecord(tab); update(state); return request('revokeTab', tab, 'owner'); },
    async revokeSite(site) {
      publicOrigin(site); revoking();
      revokedSites.set(site, Math.max(revokedSites.get(site) || 0, siteVersions.get(site) || 0)); update(state);
      return request('revokeSite', null, 'owner', { site });
    },
    // Stops this process's bridge; what is stored stays (a restart reconnects).
    async close() { forget(); for (const ws of sockets) ws.terminate(); if (wss) wss.close(); if (server) await new Promise(resolve => server.close(resolve)); listening = null; },
  };
}
