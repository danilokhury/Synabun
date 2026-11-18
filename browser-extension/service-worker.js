import { channel, command, CONTROL, equalMac, fail, hostPattern, localDeadline, mac, nonce, object, pairingKey, parse, payload, QUEUE_LIMIT, reserve, safeError } from './protocol.js';
import { createEngine } from './engine.js';
import { badgeFor } from './popup-view.js';
import { popupLocale, translator } from './popup-strings.js';
let socket = null, wire = null, credential = null, port = 3345, paused = false, pairing = false;
// Handshakes in a row the server refused for the stored credential (it closed the socket after our resume hello):
// the server no longer takes that pairing (revoked, expired, a server that lost it), so SynaBun's setup page may pair
// this extension again (setupPair). Reset by every connection that authenticates.
let refusals = 0;
// The manifest version, sent in the hello so SynaBun can tell the owner when the browser runs an older copy than its
// extension folder holds (Reload needed). Absent where the runtime has no manifest (tests).
const extensionVersion = (() => { try { return String(chrome.runtime.getManifest?.()?.version || '') || null; } catch { return null; } })();
// `incoming` authenticates messages in order and is never held up by a command; `work` runs ordinary commands one at a time.
let delay = 1000, reconnectTimer, retryAt = 0, status = 'Disconnected', outbound = Promise.resolve(), incoming = Promise.resolve(), work = Promise.resolve();
// Bind queued sends to their original channel. A late signature must never go to a replacement socket.
const send = value => {
  const ws = socket, channelOut = wire;
  outbound = outbound.catch(() => {}).then(async () => {
    if (!channelOut || socket !== ws || wire !== channelOut || ws?.readyState !== WebSocket.OPEN) return;
    payload(value);
    await channelOut.encode(value, raw => {
      if (socket !== ws || wire !== channelOut || ws.readyState !== WebSocket.OPEN) fail('NOT_CONNECTED');
      ws.send(raw);
    });
  }); return outbound;
};
const engine = createEngine(chrome, {
  save: async value => {
    const { tabs, ...prefs } = value;
    await chrome.storage.session.set({ bridgeTabs: tabs });
    await chrome.storage.local.set({ bridgePrefs: prefs });
  },
  changed: inventory => { if (wire) void send({ type: 'state', inventory }).catch(() => {}); void badge().catch(() => {}); },
});
// The toolbar icon and its tooltip (docs/design/browser-extension → Toolbar badge): no badge text, a status dot in the
// icon's corner instead: green while connected to SynaBun (agents holding tabs or not), red otherwise (connecting,
// reconnecting, paused, not paired, refused). The tooltip says the exact state and the number of agent tabs in the
// browser's language. Only what this worker already knows is read; nothing here changes the connection.
const badgeText = translator(popupLocale([(() => { try { return chrome.i18n?.getUILanguage?.(); } catch { return ''; } })(), globalThis.navigator?.language].filter(Boolean)));
async function badge() {
  let controlled = 0;
  try { controlled = engine.current().tabs.filter(tab => tab.owner).length; } catch {}
  const shown = badgeFor({ connected: !!wire, paired: !!credential, paused, connecting: status === 'Connecting', refused: refusals, controlled }, badgeText);
  // Side by side: one call that never settles (a busy toolbar) holds up neither of the others.
  await Promise.all([
    chrome.action.setIcon({ path: { ...shown.icon } }),
    chrome.action.setBadgeText({ text: '' }),
    chrome.action.setTitle({ title: shown.title }),
  ]);
}
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get(['credential', 'port', 'paused', 'bridgePrefs']);
  const session = await chrome.storage.session.get('bridgeTabs');
  credential = saved.credential || null; port = saved.port || 3345; paused = saved.paused === true;
  await engine.restore({ ...saved.bridgePrefs, tabs: session.bridgeTabs || [] });
  await chrome.alarms.create('synabun-reconnect', { periodInMinutes: 0.5 });
  void badge().catch(() => {});
})();
// Ends a connection. The engine's connection generation moves first, synchronously, so nothing that came on it does
// anything more: a queued command is refused before it starts, a running one before its next browser action.
function drop(ws) { if (socket === ws) engine.disconnected(); ws.close(); }
const coded = code => Object.assign(new Error(code), { code });
// Runs a command and answers on the connection it came on, if that connection is still the current one. A server
// revoke or disconnect ends that connection only: a pairing, resume or pause made in the popup meanwhile is newer and
// wins (`connection` is the generation the control message itself set).
async function answer(ws, message, running, connection) {
  let result;
  try { result = await running; } catch (error) { result = safeError(error); }
  if (socket === ws && wire) {
    try { await send({ type: 'result', id: message.id, result, inventory: engine.current() }); }
    catch (error) { await send({ type: 'result', id: message.id, result: safeError(error), inventory: engine.current() }).catch(() => {}); }
  }
  const current = () => socket === ws && engine.ticket().connection === connection;
  if (message.op === 'revoke' && current()) { credential = null; await chrome.storage.local.remove('credential'); drop(ws); }
  if (message.op === 'disconnect' && current()) { paused = true; await chrome.storage.local.set({ paused }); drop(ws); }
}
// Ordinary commands not yet finished, by id, so the server's cancel can stop one ahead of the queue.
const commands = new Map();
// Queues an ordinary command under its deadline (`held.expires`, set when the message arrived). One timer, armed at
// arrival: at the deadline the command's ticket is stopped (so nothing it would still do reaches the browser) and it is
// answered TIMEOUT on its own channel if that is still current. A command still queued then is dropped and never starts,
// and so is one whose turn comes later than `held.startBy` (one margin before its deadline). Once it starts, the timer
// is re-armed for the earlier of the deadline and QUEUE_LIMIT, the watchdog for a browser call that never returns;
// either way the queue moves on to the next command at once. The server's cancel calls the same `expire`.
function enqueue(ws, message, held) {
  let timer, started = false, expire;
  const limit = new Promise((_resolve, reject) => { expire = () => { held.stopped = true; reject(coded('TIMEOUT')); }; });
  limit.catch(() => { if (!started) void answer(ws, message, limit).catch(() => {}); });
  // A delay above 2^31-1 ms would fire at once; no real deadline comes near it.
  const arm = ms => { clearTimeout(timer); timer = setTimeout(expire, Math.min(2147483647, Math.max(0, ms))); };
  const done = () => { clearTimeout(timer); if (commands.get(message.id) === expire) commands.delete(message.id); };
  commands.set(message.id, expire);
  arm(held.expires - engine.now());
  work = work.catch(() => {}).then(() => {
    if (!held.stopped && engine.now() >= held.startBy) expire();
    if (held.stopped) { done(); return; }
    started = true; arm(Math.min(QUEUE_LIMIT, held.expires - engine.now()));
    return answer(ws, message, Promise.race([engine.execute(message, held), limit]).finally(done));
  }).catch(() => {}); // A command failure is an answer, never a transport revocation.
}
function schedule() {
  clearTimeout(reconnectTimer);
  if (!paused && credential) {
    retryAt = Date.now() + delay;
    // Alarms wake a suspended MV3 worker; the timer gives a live worker the shorter backoff.
    void chrome.alarms.create('synabun-retry', { when: retryAt });
    reconnectTimer = setTimeout(() => { void connect(); }, delay); delay = Math.min(delay * 2, 30000);
  }
}
async function connect() {
  await ready;
  if (paused || !credential || socket && [0, 1].includes(socket.readyState)) return;
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`); } catch { schedule(); return; }
  socket = ws;
  let session, key, client = nonce(), hello = null; wire = null; status = 'Connecting';
  // Register socket callbacks before any Chrome API await: a delayed badge must not lose the challenge.
  void badge().catch(() => {});
  const timer = setTimeout(() => { if (!wire) ws.close(); }, 10000);
  ws.onmessage = event => {
    // A command's deadline counts from here, before it waits to be authenticated.
    const receivedAt = engine.now();
    incoming = incoming.catch(() => {}).then(async () => {
      if (socket !== ws) return;
      if (!wire) {
        const msg = parse(event.data, 2048);
        if (msg.type === 'challenge' && !session) {
          object(msg, ['type', 'session']); if (!/^[a-f0-9]{32}$/.test(msg.session)) fail('INVALID_MESSAGE');
          session = msg.session; key = credential; hello = pairing ? 'pair' : 'resume';
          ws.send(JSON.stringify({ type: 'hello', mode: hello, client, proof: await mac(key, `hello:${session}:${client}`), ...(extensionVersion ? { version: extensionVersion } : {}) }));
        } else {
          object(msg, ['type', 'proof']);
          if (msg.type !== 'welcome' || !session || !await equalMac(key, `welcome:${session}:${client}`, msg.proof)) fail('AUTH_FAILED');
          // A pairing, revoke or pause in the popup during that await replaced or ended this socket's authority.
          if (socket !== ws || credential !== key || paused) fail('AUTH_FAILED');
          wire = channel(key, session, 'extension'); pairing = false; refusals = 0; delay = 1000; retryAt = 0; clearTimeout(timer); clearTimeout(reconnectTimer);
          await chrome.storage.local.set({ credential: key, port, paused: false });
          status = 'Connected'; void badge().catch(() => {}); await send({ type: 'state', inventory: engine.current() });
        }
        return;
      }
      // The socket, its channel and the generations are taken before decoding: a pause, unpairing or new pairing
      // that completes during the await ends this message's authority, and nothing of it reaches the browser.
      const channelIn = wire, arrived = engine.ticket();
      const message = payload(await channelIn.decode(event.data));
      if (socket !== ws || wire !== channelIn || engine.ticket().connection !== arrived.connection) {
        // Refused with no effect, control messages included; an answer goes only to the channel it came on, if open.
        if (message.type === 'command' && socket === ws && wire === channelIn) {
          await send({ type: 'result', id: message.id, result: safeError(coded('NOT_CONNECTED')), inventory: engine.current() });
        }
        return;
      }
      if (message.type === 'ping') { await send({ type: 'pong' }); return; }
      // The server stopped waiting for a command: stop it now, ahead of the queue, as at its deadline.
      if (message.type === 'cancel') { commands.get(message.id)?.(); return; }
      command(message);
      // Owner revocations apply at once, ahead of commands still queued or running; those then find their ticket stale.
      if (CONTROL.includes(message.op)) {
        const running = engine.execute(message);
        await answer(ws, message, running, engine.ticket().connection); return;
      }
      // An ordinary command keeps the approval and connection generations of the moment it arrived (before its
      // decoding) and its deadline from that same moment, then waits its turn (enqueue).
      const expires = localDeadline(receivedAt, message.deadline);
      enqueue(ws, message, { ...arrived, stopped: false, expires, startBy: expires - reserve(message.deadline) });
    }).catch(() => { status = 'Connection refused — pair again'; drop(ws); });
  };
  ws.onerror = () => { status = 'Not connected — check SynaBun and the port'; };
  ws.onclose = () => {
    clearTimeout(timer); if (socket !== ws) return;
    // Closed after our resume hello and before a welcome: the server refused the stored credential.
    if (!wire && hello === 'resume') refusals++;
    engine.disconnected(); socket = wire = null; status = paused ? 'Paused' : 'Disconnected — reconnecting'; void badge().catch(() => {}); schedule();
  };
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (['synabun-reconnect', 'synabun-retry'].includes(alarm.name)) {
    if (Date.now() >= retryAt) void connect();
    void ready.then(() => engine.opened()).catch(() => {});
  }
});
chrome.tabs.onActivated.addListener(() => engine.activated());
chrome.tabs.onRemoved.addListener(id => { void ready.then(() => engine.closed(id)); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url) void ready.then(() => engine.updated(id));
  else if (change.title !== undefined) void ready.then(() => engine.retitled(id));
});
// Full control lists every tab of the browser: a new one is listed as soon as it opens.
chrome.tabs.onCreated.addListener(() => { void ready.then(() => engine.opened()); });
chrome.permissions.onRemoved.addListener(() => { engine.withdrawn(); void ready.then(async () => {
  for (const site of engine.current().sites) if (!await chrome.permissions.contains({ origins: [hostPattern(site)] })) await engine.revokeSite(site);
}); });
// ── One-button setup: SynaBun's "Connect your browser" page hands over a one-time token (setup-content.js) ──
// Accepted only from this extension's own content script, in the top frame of a tab, on exactly the setup page's origin
// and path as this manifest names them (SynaBun's app port on 127.0.0.1 and localhost), from a tab no agent holds, and
// only while this extension needs pairing: never paired, or the server refused its stored credential twice in a row.
// A paired, working or paused extension is never re-paired by a page (the popup and SynaBun's typed code still can).
// The token is used exactly like a typed code (pairingKey, the same HMAC handshake): it never crosses the socket, and
// the server accepts it once. Nothing of it is stored but the credential the handshake derives, as with a typed code.
const SETUP_KIND = 'synabun-setup-pair';
function setupPages() {
  try {
    return (chrome.runtime.getManifest?.()?.content_scripts || []).flatMap(entry => entry.js?.includes('setup-content.js') ? entry.matches || [] : [])
      .map(pattern => { const u = new URL(pattern.replace(/\*$/, '')); return `${u.origin}${u.pathname}`; });
  } catch { return []; }
}
function setupSender(sender) {
  if (sender?.id !== chrome.runtime.id || !sender.tab || !Number.isSafeInteger(sender.tab.id) || sender.frameId !== 0) return false;
  let u; try { u = new URL(sender.url); } catch { return false; }
  if (u.protocol !== 'http:' || u.username || u.password) return false;
  if (sender.origin !== undefined && sender.origin !== u.origin) return false;
  return setupPages().includes(`${u.origin}${u.pathname}`);
}
let setupAt = 0;
async function setupPair(msg, sender) {
  await ready;
  const refuse = code => ({ ok: false, code });
  try { object(msg, ['kind', 'token', 'bridgePort']); } catch { return refuse('INVALID_MESSAGE'); }
  if (msg.kind !== SETUP_KIND || typeof msg.token !== 'string' || !/^[a-f0-9]{64}$/.test(msg.token)
    || !Number.isInteger(msg.bridgePort) || msg.bridgePort < 1024 || msg.bridgePort > 65535) return refuse('INVALID_MESSAGE');
  // A tab an agent holds is never where pairing comes from (agents never reach SynaBun's pages anyway).
  if (engine.heldByAgent(sender.tab.id)) return refuse('NOT_OWNED');
  if (wire) return refuse('ALREADY_CONNECTED');
  if (credential && paused) return refuse('PAUSED');
  if (credential && !pairing && refusals < 2) return refuse('ALREADY_PAIRED');
  if (Date.now() - setupAt < 2000) return refuse('BUSY');
  setupAt = Date.now();
  // A new pairing ends what the old one allowed, before anything is awaited (as the popup's pair does).
  engine.disconnected(); socket?.close(); socket = wire = null; await engine.clear();
  credential = await pairingKey(msg.token); port = msg.bridgePort; pairing = true; paused = false; refusals = 0; void connect();
  return { ok: true };
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.tab) {
    if (msg?.kind !== SETUP_KIND || !setupSender(sender)) return;
    setupPair(msg, sender).then(respond, () => respond({ ok: false, code: 'REFUSED' }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab) return;
  (async () => {
    await ready; object(msg, ['action', 'code', 'port', 'tab', 'site', 'options', 'siteOnly', 'fullControl']);
    if (msg.action === 'pair') {
      if (!/^[a-fA-F0-9-]{20,24}$/.test(msg.code) || !Number.isInteger(msg.port) || msg.port < 1024 || msg.port > 65535) fail('INVALID_MESSAGE');
      // A new pairing ends what the old one allowed, before anything is awaited.
      engine.disconnected(); socket?.close(); socket = wire = null; await engine.clear();
      credential = await pairingKey(msg.code); port = msg.port; pairing = true; paused = false; void connect();
    } else if (msg.action === 'share') await engine.share(msg.tab, msg.siteOnly === true);
    else if (msg.action === 'revokeTab') await engine.revokeTab(msg.tab);
    else if (msg.action === 'revokeSite') await engine.revokeSite(msg.site);
    else if (msg.action === 'options') await engine.options(msg.options);
    // The owner's mode switch. Restricted takes effect here at once (a revocation); the server hears it with the
    // next inventory, which carries the newer mode version.
    else if (msg.action === 'mode') { if (typeof msg.fullControl !== 'boolean') fail('INVALID_MESSAGE'); await engine.setMode(msg.fullControl); }
    else if (msg.action === 'disconnect') { engine.disconnected(); paused = true; await chrome.storage.local.set({ paused }); socket?.close(); }
    else if (msg.action === 'resume') { paused = false; await chrome.storage.local.set({ paused }); void connect(); }
    else if (msg.action === 'revoke') {
      engine.disconnected(); const cleared = engine.clear();
      await send({ type: 'unpair' }); credential = null; paused = true; socket?.close(); await cleared;
      await chrome.storage.local.remove('credential'); await chrome.storage.local.set({ paused });
    } else if (msg.action !== 'status') fail('INVALID_MESSAGE');
    if (msg.action !== 'status') void badge().catch(() => {});
    return { ok: true, status, connected: !!wire, port, ...engine.current() };
  })().then(respond, error => respond(safeError(error)));
  return true;
});
void connect();
