// WhatsApp Link host core. Runs inside the forked host (host.js) — or, for
// tests and the SYNABUN_WHATSAPP_HOST=inproc kill switch, inside the main
// process (manager.js). It owns the Baileys socket, the credentials, the
// owner, and sendToOwner: the only place anything is sent to WhatsApp.
//
// Inbound pipeline (messages.upsert):
//   type 'notify', or 'append' for what WhatsApp held while this device was
//   offline (its <message offline> stanza; history sync and own echoes are
//   off in the socket config), no requestId (placeholder resends are how
//   CVE-2026-48063 spoofed messages) → drop stubs, edits, revokes, reactions,
//   poll votes, protocol and call messages → dedicated claim attempt (live
//   messages only) → awaiting_confirm drops everything → classifyInbound
//   (owner + the raw stanza that carried it) → a backlog message must come
//   from an offline stanza and be younger than 24 h → dedupe (seen) →
//   extract → 'inbound' event (`backlog: true` on offline ones; the bridge
//   skips those older than 10 minutes), which never carries a JID or a phone
//   number.
//
// Self mode after a fresh link sits in awaiting_confirm: nothing is accepted
// and nothing is sent until the desktop confirms the linked account
// (confirmOwner). Declining, or 10 minutes without an answer, logs the device
// out and wipes it — a stranger who scans the QR never gets a session.

import {
  CONN, DEFAULT_PREFIX, ERR, EV, LIMITS, OP, PROTOCOL_VERSION, REACTIONS, pickPrefs, validateEvent, validateOp,
} from './protocol.js';
import { openAuthStore } from './auth-store.js';
import * as adapter from './baileys-adapter.js';
import { classifyInbound, createClaim, createOwnerState, maskJid, normalizeUserJid, parseJid, sameAccount } from './identity.js';
import { redactWa, setRedactionContext } from './redact.js';

const CONFIRM_WINDOW_MS = 10 * 60_000;
const PRESENCE_REFRESH_MS = 10_000;
const PRESENCE_MAX_MS = 10 * 60_000;
const PACE_MIN_MS = 900;
const PACE_JITTER_MS = 600;
export const SEND_CAPS = Object.freeze([
  Object.freeze({ windowMs: 60_000, max: 10 }),
  Object.freeze({ windowMs: 3_600_000, max: 120 }),
  Object.freeze({ windowMs: 86_400_000, max: 500 }),
]);
// Status reactions (👀 ✅ ⏳ …) are cosmetic: they stop this many sends short of
// every cap, so they never push a reply into THROTTLED.
export const REACTION_RESERVE = 3;
const STABLE_OPEN_MS = 10 * 60_000;
const QR_FIRST_TTL_MS = 60_000;
const QR_NEXT_TTL_MS = 20_000;
const PAIRING_CODE_TTL_MS = 3 * 60_000;
const RESTART_BURST_MAX = 5;
const RESTART_BURST_WINDOW_MS = 10 * 60_000;
const TAP_TTL_MS = 10 * 60_000;
const BACKLOG_MAX_AGE_MS = 24 * 3_600_000;
const TAP_MAX = 1000;
const TAP_PER_SENDER = 50;
const RECENT_OWNER_MAX = 200;
const SENT_IDS_MAX = 2000;
const STATE_FLUSH_MS = 2000;
const IGNORED_FLUSH_MS = 2000;
const PRUNE_EVERY_MS = 3_600_000;
const LOGOUT_TIMEOUT_MS = 5000;
const LOG_BURST = 30;
const LOG_WINDOW_MS = 60_000;
const JID_IN_TEXT = /@(?:s\.whatsapp\.net|c\.us|lid|g\.us|broadcast|newsletter|hosted(?:\.lid)?)\b/;

export const WELCOME_TEXT = '✅ SynaBun is linked. Messages you send in this chat now reach your SynaBun Assistant.';
const LOCKED_REASON = 'another SynaBun process is using this WhatsApp session';
// conn.lastError (≤ 200 characters); the fatal event carries the store's own message (path, mode, errno).
const AUTH_PERMS_REASON = 'the WhatsApp session files could not be made private; fix the folder permissions, then reconnect';

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
};

function hostError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

const STOP_FATAL = {
  [CONN.LOGGED_OUT]: 'LOGGED_OUT',
  [CONN.REPLACED]: 'REPLACED',
  [CONN.FORBIDDEN]: 'FORBIDDEN',
  [CONN.ERROR]: 'SESSION_ERROR',
};

/**
 * @param {object} o
 * @param {(msg:object) => void} o.send       deliver one event to the main process
 * @param {{authDir:string, runtimeDir:string}} o.paths
 */
export function createHostCore({
  send,
  paths,
  env = process.env,
  platform = process.platform,
  now = () => Date.now(),
  timers = defaultTimers,
  rng = Math.random,
  loadRuntime = adapter.loadRuntime,
  openStore = openAuthStore,
  reconnect = {},
  sendCaps = SEND_CAPS,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('createHostCore: send is required');
  if (!paths?.authDir) throw new TypeError('createHostCore: paths.authDir is required');

  let runtime = null;
  let runtimeInfo = { loaded: false, version: null, fake: false, error: null };
  let store = null;
  let storeFailure = null; // why init could not open the store: {code: ERR.LOCKED | ERR.AUTH_PERMS | ERR.INTERNAL, reason, message?}
  let creds = null;
  let prefs = { mode: 'self', selfTrigger: 'all', prefix: DEFAULT_PREFIX };
  let connState = CONN.IDLE;
  let lastError = null;
  let lastDisconnect = null;
  let retryAt = null;
  let sock = null;
  let gen = 0;
  let session = null; // {purpose, mode, method, phone, qrCount, pairingRequested}
  let owner = createOwnerState({ mode: 'self' });
  let awaitingConfirmUntil = null;
  let claim = null;
  let paused = false;
  let shuttingDown = false;
  let initialized = false;
  const sentIds = new Set();
  const taps = new Map();
  const tapsBySender = new Map(); // sender account → its tapped ids, oldest first
  const recentOwner = new Map();
  const restartBurst = [];
  let sendLog = [];
  let nextSendAt = 0;
  let sendChain = Promise.resolve();
  let inboundChain = Promise.resolve();
  let presenceActive = false;
  const counters = { inbound: 0, accepted: 0, ignored: 0, sent: 0, reactions: 0, throttled: 0, anomalies: 0, reconnects: 0 };
  const ignoredCounts = {};
  const logTimes = [];
  const timerIds = {};

  const policy = adapter.createReconnectPolicy({ now, rng, ...reconnect });
  const logger = adapter.createSilentLogger({ sink: (level, message) => say(level, message) });

  // ── Plumbing ──

  function setTimer(name, fn, ms) {
    clearTimer(name);
    timerIds[name] = { kind: 'timeout', id: timers.setTimeout(() => { delete timerIds[name]; fn(); }, ms) };
  }

  function setRepeat(name, fn, ms) {
    clearTimer(name);
    timerIds[name] = { kind: 'interval', id: timers.setInterval(fn, ms) };
  }

  function clearTimer(name) {
    const t = timerIds[name];
    if (!t) return;
    if (t.kind === 'interval') timers.clearInterval(t.id);
    else timers.clearTimeout(t.id);
    delete timerIds[name];
  }

  function sleep(ms) {
    return new Promise((resolve) => timers.setTimeout(resolve, ms));
  }

  function emit(ev) {
    const v = validateEvent(ev);
    if (!v.ok) {
      if (ev?.t !== EV.LOG) say('warn', `[whatsapp] dropped an invalid '${ev?.t}' event: ${v.message}`);
      return;
    }
    try { send(ev); } catch {}
  }

  function say(level, message) {
    const t = now();
    while (logTimes.length && t - logTimes[0] > LOG_WINDOW_MS) logTimes.shift();
    if (logTimes.length >= LOG_BURST) return;
    logTimes.push(t);
    const lvl = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'warn';
    emit({ t: EV.LOG, level: lvl, message: redactWa(String(message ?? '')).slice(0, 4000) });
  }

  function isLinked() {
    return adapter.isLinkedCreds(creds);
  }

  function storedMode() {
    const m = store?.meta.get('mode');
    return m === 'self' || m === 'dedicated' ? m : null;
  }

  function currentMode() {
    return (isLinked() && storedMode()) || session?.mode || prefs.mode || 'self';
  }

  function selfIds() {
    if (!creds?.me?.id) return { pn: null, lid: null };
    return { pn: normalizeUserJid(creds.me.id), lid: creds.me.lid ? normalizeUserJid(creds.me.lid) : null };
  }

  function refreshIdentity() {
    const self = isLinked() ? selfIds() : { pn: null, lid: null };
    if (currentMode() === 'self') {
      if (owner.mode !== 'self') owner = createOwnerState({ mode: 'self' });
      owner.setSelf(self);
    }
    setRedactionContext({
      self: [self.pn, self.lid].filter(Boolean),
      owner: owner.mode === 'dedicated' ? [owner.pn, owner.lid].filter(Boolean) : [],
    });
  }

  function loadOwner() {
    if (currentMode() === 'dedicated') {
      const row = store?.owner.get();
      owner = createOwnerState({ mode: 'dedicated', bound: row || null });
    } else {
      owner = createOwnerState({ mode: 'self' });
    }
    refreshIdentity();
  }

  function ownerConfirmed() {
    return !!store?.meta.get('owner_confirmed');
  }

  function connStatus() {
    const linked = isLinked();
    const mode = linked || session ? currentMode() : (prefs.mode || null);
    let ownerInfo = null;
    if (linked && mode === 'dedicated') ownerInfo = { bound: owner.bound, masked: owner.masked() };
    else if (linked && mode === 'self') ownerInfo = { bound: ownerConfirmed(), masked: maskJid(creds.me.id) };
    return {
      state: connState,
      mode: mode === 'self' || mode === 'dedicated' ? mode : null,
      registered: linked,
      me: linked ? { masked: maskJid(creds.me.id), name: typeof creds.me.name === 'string' && creds.me.name !== '~' ? creds.me.name.slice(0, 100) : null } : null,
      owner: ownerInfo,
      lastDisconnect: lastDisconnect ? { ...lastDisconnect } : null,
      retryInMs: retryAt ? Math.max(0, retryAt - now()) : null,
      counters: { ...counters },
      paused,
      awaitingConfirmUntil,
      claim: claim ? { active: claim.active, expiresAt: claim.expiresAt, attemptsLeft: claim.attemptsLeft } : null,
      lastError,
    };
  }

  function emitState() {
    clearTimer('stateFlush');
    emit({ t: EV.STATE, conn: connStatus() });
  }

  /** Counters moved: publish them soon, not on every message. */
  function touch() {
    if (!timerIds.stateFlush) setTimer('stateFlush', () => emitState(), STATE_FLUSH_MS);
  }

  function setState(next, { error } = {}) {
    connState = next;
    if (error !== undefined) lastError = error;
    emitState();
  }

  function bump(reason, n = 1) {
    ignoredCounts[reason] = (ignoredCounts[reason] || 0) + n;
    counters.ignored += n;
    if (!timerIds.ignoredFlush) {
      setTimer('ignoredFlush', () => emit({ t: EV.IGNORED, counts: { ...ignoredCounts } }), IGNORED_FLUSH_MS);
    }
    touch();
  }

  function anomaly(reason) {
    counters.anomalies += 1;
    paused = true;
    lastError = reason;
    say('warn', `[whatsapp] owner anomaly: ${reason}; sending paused`);
    emit({ t: EV.FATAL, code: 'OWNER_ANOMALY', message: reason });
    emitState();
  }

  function rememberSent(id, jid, message) {
    if (!id) return;
    sentIds.add(id);
    if (sentIds.size > SENT_IDS_MAX) sentIds.delete(sentIds.values().next().value);
    try { store?.sent.add(id, jid, adapter.encodeSentMessage(runtime.mod, message)); } catch (err) { say('warn', `[whatsapp] could not record a sent id: ${err?.message}`); }
  }

  function isOwnSent(id) {
    return sentIds.has(id) || !!store?.sent.has(id);
  }

  // ── Stanza tap ──

  /**
   * Only senders who could be the owner are recorded, so a flood from
   * strangers cannot evict the owner's entry before its message is processed
   * (the tap runs before Baileys' own shouldIgnoreJid check).
   */
  function tapWanted(from, alt) {
    if (currentMode() === 'self') {
      const self = selfIds();
      return (!!self.pn && sameAccount(from, self.pn)) || (!!self.lid && sameAccount(from, self.lid));
    }
    if (owner.bound) return owner.isOwnerJid(from) || (!!alt && owner.isOwnerJid(alt));
    const p = parseJid(from);
    return !!claim && !!p && (p.kind === 'pn' || p.kind === 'lid'); // the claim window
  }

  function tapStanza(node) {
    const attrs = node?.attrs;
    if (!attrs || typeof attrs.id !== 'string') return;
    const sender = attrs.participant || attrs.from;
    const p = parseJid(sender);
    if (!p) return;
    const lidAddressed = attrs.addressing_mode ? attrs.addressing_mode === 'lid' : p.kind === 'lid';
    const altRaw = lidAddressed
      ? attrs.participant_pn || attrs.sender_pn || attrs.peer_recipient_pn
      : attrs.participant_lid || attrs.sender_lid || attrs.peer_recipient_lid;
    const from = normalizeUserJid(sender);
    const alt = altRaw ? normalizeUserJid(altRaw) : null;
    if (!tapWanted(from, alt)) return;
    taps.set(attrs.id, { from, alt, device: p.device ?? 0, offline: attrs.offline !== undefined, at: now() });
    // Per sender first: during a claim window one noisy account can only
    // evict its own entries, never the claimant's.
    let ids = tapsBySender.get(from);
    if (!ids) tapsBySender.set(from, (ids = []));
    ids.push(attrs.id);
    while (ids.length > TAP_PER_SENDER) {
      const old = ids.shift();
      if (taps.get(old)?.from === from) taps.delete(old);
    }
    if (taps.size > TAP_MAX) taps.delete(taps.keys().next().value);
  }

  function stanzaFor(id) {
    const tap = taps.get(id);
    if (!tap) return null;
    if (now() - tap.at > TAP_TTL_MS) {
      taps.delete(id);
      return null;
    }
    return tap;
  }

  // ── Socket lifecycle ──

  function openSocket() {
    clearTimer('reconnect');
    retryAt = null;
    const g = ++gen;
    const mode = session.mode;
    let s;
    try {
      s = adapter.createWaSocket({
        runtime,
        store,
        creds,
        mode,
        method: session.purpose === 'link' ? session.method : null,
        logger,
        version: adapter.cachedVersion(store),
        getSelfJids: selfIds,
        onStanza: tapStanza,
        platform,
      });
    } catch (err) {
      sock = null;
      session = null;
      say('error', `[whatsapp] could not create the socket: ${err?.message}`);
      setState(CONN.ERROR, { error: 'socket_failed' });
      return;
    }
    sock = s;
    s.ev.on('connection.update', (u) => { if (g === gen) onConnectionUpdate(u); });
    s.ev.on('creds.update', (u) => { if (g === gen) onCredsUpdate(u); });
    s.ev.on('messages.upsert', (u) => {
      if (g !== gen) return;
      // One at a time: a slow image download must not let a later text overtake it.
      inboundChain = inboundChain
        .then(() => onUpsert(u))
        .catch((err) => say('warn', `[whatsapp] inbound processing failed: ${err?.message}`));
    });
  }

  /** Close the current socket ourselves (never a logout); its close event is ignored. */
  function closeSocket() {
    const s = sock;
    sock = null;
    gen += 1;
    clearTimer('stable');
    stopPresence({ notify: false });
    if (s) {
      try { s.end(undefined); } catch {}
    }
  }

  async function logoutSocket() {
    const s = sock;
    sock = null;
    gen += 1;
    clearTimer('stable');
    stopPresence({ notify: false });
    if (!s) return;
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => s.logout()),
        new Promise((resolve) => { timer = timers.setTimeout(resolve, LOGOUT_TIMEOUT_MS); }),
      ]);
    } catch {} finally {
      timers.clearTimeout(timer);
    }
    try { s.end(undefined); } catch {}
  }

  function onCredsUpdate(update) {
    if (!creds || !update || typeof update !== 'object') return;
    if (update !== creds) Object.assign(creds, update);
    try { store.saveCreds(creds); } catch (err) { say('error', `[whatsapp] could not save credentials: ${err?.message}`); }
    refreshIdentity();
  }

  function onConnectionUpdate(u) {
    if (!u || typeof u !== 'object') return;
    if (typeof u.qr === 'string' && u.qr) onQr(u.qr);
    // The phone accepted the QR / code: the server restarts the stream next.
    if (u.isNewLogin === true && session && [CONN.QR, CONN.PAIRING].includes(connState)) setState(CONN.CONNECTING);
    if (u.connection === 'connecting' && ![CONN.QR, CONN.PAIRING].includes(connState)) {
      if (connState !== CONN.RECONNECTING && connState !== CONN.CONNECTING) setState(CONN.CONNECTING);
    }
    if (u.connection === 'open') onOpen();
    if (u.connection === 'close') onClose(u.lastDisconnect?.error);
  }

  function onQr(qr) {
    if (!session || session.purpose !== 'link' || isLinked()) {
      // A QR while running means the server no longer knows these creds.
      closeSocket();
      session = null;
      stopWith(CONN.LOGGED_OUT, 'session_rejected', { wipe: true, fatal: 'LOGGED_OUT' });
      return;
    }
    session.qrCount += 1;
    if (session.method === 'code') {
      if (session.pairingRequested) return;
      session.pairingRequested = true;
      const s = sock;
      const g = gen;
      Promise.resolve()
        .then(() => s.requestPairingCode(session.phone))
        .then((code) => {
          if (g !== gen) return;
          const clean = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
          if (!clean) throw new Error('empty pairing code');
          emit({ t: EV.PAIRING_CODE, code: clean, expiresAt: now() + PAIRING_CODE_TTL_MS });
          setState(CONN.PAIRING);
        })
        .catch((err) => {
          if (g !== gen) return;
          say('warn', `[whatsapp] pairing code request failed: ${err?.message}`);
          closeSocket();
          stopWith(CONN.ERROR, 'pairing_code_failed', { wipe: true });
        });
      return;
    }
    const ttl = session.qrCount === 1 ? QR_FIRST_TTL_MS : QR_NEXT_TTL_MS;
    emit({ t: EV.QR, qr, expiresAt: now() + ttl });
    if (connState !== CONN.QR) setState(CONN.QR);
  }

  function onOpen() {
    retryAt = null;
    clearTimer('reconnect');
    setTimer('stable', () => policy.noteStable(), STABLE_OPEN_MS);
    const fresh = session?.purpose === 'link';
    if (fresh) {
      store.meta.set('mode', session.mode);
      store.meta.set('linked_at', now());
      store.meta.delete('owner_confirmed');
      store.meta.delete('awaiting_confirm_until');
      if (session.mode === 'dedicated') store.owner.clear();
      session = { purpose: 'run', mode: session.mode };
      loadOwner();
      emit({ t: EV.LINKED, mode: currentMode(), me: connStatus().me });
    } else {
      refreshIdentity();
    }
    lastError = null;
    if (currentMode() === 'self' && !ownerConfirmed()) {
      enterAwaitingConfirm();
      return;
    }
    setState(CONN.OPEN);
  }

  function enterAwaitingConfirm() {
    let until = store.meta.get('awaiting_confirm_until');
    if (!Number.isFinite(until)) {
      until = now() + CONFIRM_WINDOW_MS;
      store.meta.set('awaiting_confirm_until', until);
    }
    awaitingConfirmUntil = until;
    const left = until - now();
    if (left <= 0) {
      confirmTimeout().catch(() => {});
      return;
    }
    setTimer('confirm', () => { confirmTimeout().catch(() => {}); }, left);
    setState(CONN.AWAITING_CONFIRM);
  }

  async function confirmTimeout() {
    if (connState !== CONN.AWAITING_CONFIRM && !(awaitingConfirmUntil && now() >= awaitingConfirmUntil)) return;
    say('warn', '[whatsapp] the linked account was not confirmed within 10 minutes; logging it out');
    await forgetDevice();
    setState(CONN.UNLINKED, { error: 'confirm_timeout' });
    emit({ t: EV.FATAL, code: 'CONFIRM_TIMEOUT', message: 'the linked account was not confirmed in time' });
  }

  function onClose(error) {
    sock = null;
    gen += 1;
    clearTimer('stable');
    stopPresence({ notify: false });
    const linking = session?.purpose === 'link' && !isLinked();
    const c = adapter.classifyDisconnect(error, { linking, DisconnectReason: runtime.mod.DisconnectReason });
    lastDisconnect = { reason: c.reason, code: c.code, at: now() };
    if (shuttingDown) return;
    if (!session) {
      setState(isLinked() ? CONN.IDLE : CONN.UNLINKED);
      return;
    }
    switch (c.action) {
      case 'reconnect_now': {
        const t = now();
        while (restartBurst.length && t - restartBurst[0] > RESTART_BURST_WINDOW_MS) restartBurst.shift();
        if (restartBurst.length >= RESTART_BURST_MAX) {
          scheduleReconnect();
          return;
        }
        restartBurst.push(t);
        counters.reconnects += 1;
        openSocket();
        return;
      }
      case 'refresh_version': {
        const g = gen;
        adapter.refreshVersion({ runtime, store, now }).then((refreshed) => {
          if (g !== gen || shuttingDown || !session) return;
          if (refreshed) {
            counters.reconnects += 1;
            openSocket();
          } else if (session.purpose === 'link' && !isLinked()) {
            stopWith(CONN.LINK_EXPIRED, 'outdated_version', { wipe: true });
          } else {
            scheduleReconnect();
          }
        }, () => scheduleReconnect());
        return;
      }
      case 'backoff':
        scheduleReconnect();
        return;
      default:
        stopWith(c.state, c.reason, { wipe: c.wipe, fatal: STOP_FATAL[c.state] });
    }
  }

  function scheduleReconnect() {
    const next = policy.next();
    if (next.giveUp) {
      stopWith(CONN.ERROR, 'reconnect_limit', { fatal: 'RECONNECT_LIMIT' });
      return;
    }
    retryAt = now() + next.delayMs;
    setTimer('reconnect', () => {
      retryAt = null;
      if (shuttingDown || !session) return;
      counters.reconnects += 1;
      openSocket();
    }, next.delayMs);
    setState(CONN.RECONNECTING);
  }

  function stopWith(state, reason, { wipe = false, fatal = null } = {}) {
    clearTimer('reconnect');
    clearTimer('confirm');
    retryAt = null;
    session = null;
    if (wipe) wipeLocal();
    setState(state, { error: reason });
    if (fatal) emit({ t: EV.FATAL, code: fatal, message: reason });
  }

  /** Forget everything about the linked device (files included); keeps the lock. */
  function wipeLocal() {
    try { store?.wipe(); } catch (err) { say('error', `[whatsapp] wipe failed: ${err?.message}`); }
    creds = null;
    owner = createOwnerState({ mode: prefs.mode || 'self' });
    sentIds.clear();
    recentOwner.clear();
    taps.clear();
    tapsBySender.clear();
    claim = null;
    clearTimer('claim');
    clearTimer('confirm');
    awaitingConfirmUntil = null;
    paused = false;
    setRedactionContext({});
  }

  /** Log the device out (best effort) and wipe it. */
  async function forgetDevice() {
    session = null;
    clearTimer('reconnect');
    retryAt = null;
    await logoutSocket();
    wipeLocal();
  }

  // ── Inbound ──

  async function onUpsert(u) {
    const messages = Array.isArray(u?.messages) ? u.messages : [];
    if (u && typeof u === 'object' && Object.hasOwn(u, 'requestId')) {
      bump('placeholder_resend', messages.length || 1);
      return;
    }
    if (u?.type !== 'notify' && u?.type !== 'append') {
      bump('not_notify', messages.length || 1);
      return;
    }
    const backlog = u.type === 'append';
    for (const msg of messages) {
      try {
        await processIncoming(msg, { backlog });
      } catch (err) {
        bump('error');
        say('warn', `[whatsapp] could not process a message: ${err?.message}`);
      }
    }
  }

  async function processIncoming(msg, { backlog = false } = {}) {
    counters.inbound += 1;
    const d = adapter.describeContent(msg, runtime.mod);
    if (d.drop) {
      bump(d.drop);
      return;
    }
    const stanza = stanzaFor(msg.key.id);
    const mode = currentMode();
    // A claim is a live handshake: a held code (maybe an earlier claim's) never burns an attempt.
    if (!backlog && mode === 'dedicated' && claim && connState === CONN.OPEN && !owner.bound) {
      if (await tryClaim(msg, d, stanza)) return;
    }
    if (connState === CONN.AWAITING_CONFIRM) {
      bump('awaiting_confirm');
      return;
    }
    if (connState !== CONN.OPEN) {
      bump('not_open');
      return;
    }
    const verdict = classifyInbound(msg, owner, {
      mode,
      sentIds: { has: isOwnSent },
      prefix: mode === 'self' && prefs.selfTrigger === 'prefix' ? prefs.prefix || DEFAULT_PREFIX : null,
      stanza,
      text: d.text,
    });
    if (!verdict.accept) {
      bump(verdict.reason);
      if (verdict.reason === 'owner_conflict') anomaly('a message claimed the owner through a mismatching id');
      return;
    }
    if (backlog) {
      // The owner's, held for this device while it was offline: its stanza says so, and a day is the limit.
      if (stanza?.offline !== true) {
        bump('append_not_offline');
        return;
      }
      const sentAt = Number(msg.messageTimestamp) * 1000;
      if (!(sentAt > 0) || now() - sentAt > BACKLOG_MAX_AGE_MS) {
        bump('backlog_expired');
        return;
      }
    }
    const id = msg.key.id;
    if (store.seen.has(id)) {
      bump('duplicate');
      return;
    }
    store.seen.add(id, normalizeUserJid(msg.key.remoteJid) || '');
    if (mode === 'dedicated' && owner.learnAlternate(msg.key.remoteJid, msg.key.remoteJidAlt)) {
      store.owner.set(owner.snapshot());
      refreshIdentity();
    }
    owner.noteChat(msg.key.remoteJid);
    recentOwner.set(id, { copy: adapter.quotableCopy(msg, d), at: now() });
    if (recentOwner.size > RECENT_OWNER_MAX) recentOwner.delete(recentOwner.keys().next().value);
    const ex = await adapter.extractInbound(msg, { mod: runtime.mod, sock, logger, sentIds: { has: isOwnSent }, described: d, text: verdict.text });
    const ts = Number(msg.messageTimestamp);
    counters.accepted += 1;
    touch();
    emit({
      t: EV.INBOUND,
      message: {
        id,
        ts: Number.isFinite(ts) && ts > 0 ? ts * 1000 : now(),
        chat: verdict.chat,
        text: ex.text,
        images: ex.images,
        unsupported: ex.unsupported,
        forwarded: ex.forwarded,
        quoted: ex.quoted,
        owner: true,
        ...(backlog ? { backlog: true } : {}),
      },
    });
  }

  /** @returns {Promise<boolean>} true when the message was a claim attempt (consumed, never answered unless it matched) */
  async function tryClaim(msg, d, stanza) {
    if (msg.key.fromMe === true || d.kind !== 'text') return false;
    const chat = parseJid(msg.key.remoteJid);
    if (!chat || (chat.kind !== 'pn' && chat.kind !== 'lid')) return false;
    if (!stanza?.from || !sameAccount(stanza.from, msg.key.remoteJid)) return false;
    const result = claim.check(d.text);
    if (result === 'ignored' || result === 'inactive') return false;
    if (result === 'expired') {
      claim = null;
      clearTimer('claim');
      emitState();
      return false;
    }
    try { store.seen.add(msg.key.id, normalizeUserJid(msg.key.remoteJid) || ''); } catch {}
    if (result === 'mismatch' || result === 'exhausted') {
      bump('claim_mismatch');
      if (result === 'exhausted') {
        claim = null;
        clearTimer('claim');
      }
      emitState();
      return true; // silent: a wrong code never gets a reply
    }
    // match
    const ids = { pn: null, lid: null };
    for (const j of [msg.key.remoteJid, msg.key.remoteJidAlt]) {
      const p = parseJid(j);
      if (p?.kind === 'pn' && !ids.pn) ids.pn = normalizeUserJid(j);
      if (p?.kind === 'lid' && !ids.lid) ids.lid = normalizeUserJid(j);
    }
    try {
      const map = sock?.signalRepository?.lidMapping;
      if (ids.lid && !ids.pn && map?.getPNForLID) {
        const pn = normalizeUserJid(await map.getPNForLID(ids.lid));
        if (pn && parseJid(pn).kind === 'pn') ids.pn = pn;
      }
      if (ids.pn && !ids.lid && map?.getLIDForPN) {
        const lid = normalizeUserJid(await map.getLIDForPN(ids.pn));
        if (lid && parseJid(lid).kind === 'lid') ids.lid = lid;
      }
    } catch {}
    claim = null;
    clearTimer('claim');
    owner.bind({ ...ids, via: 'claim', boundAt: now() });
    owner.noteChat(msg.key.remoteJid);
    store.owner.set(owner.snapshot());
    paused = false;
    refreshIdentity();
    emit({ t: EV.OWNER_BOUND, masked: owner.masked() || '••••', via: 'claim' });
    emitState();
    sendToOwner({ text: WELCOME_TEXT }).catch((err) => say('warn', `[whatsapp] welcome message failed: ${err?.message}`));
    return true;
  }

  // ── Outbound: the only way out ──

  /** How long until one more send fits every cap, `reserve` sends short of each (0 = now). */
  function capWait(reserve = 0) {
    const t = now();
    sendLog = sendLog.filter((ts) => t - ts < sendCaps[sendCaps.length - 1].windowMs);
    let wait = 0;
    for (const cap of sendCaps) {
      const max = Math.max(1, cap.max - reserve);
      const inWindow = sendLog.filter((ts) => t - ts < cap.windowMs);
      if (inWindow.length >= max) {
        const oldest = inWindow[inWindow.length - max];
        wait = Math.max(wait, cap.windowMs - (t - oldest));
      }
    }
    return wait;
  }

  /**
   * The owner's chat, or NO_OWNER. Every miss is counted as an anomaly; only a
   * real mismatch (an owner is bound yet the target is not theirs) also pauses
   * sending and raises OWNER_ANOMALY — a send racing a deliberate owner reset
   * is not an attack.
   */
  function assertOwnerTarget() {
    const jid = owner.replyJid();
    if (jid && owner.isOwnerJid(jid)) return jid;
    if (owner.bound) {
      anomaly('the reply target is not the owner');
      throw hostError(ERR.NO_OWNER, 'the reply target is not the owner');
    }
    counters.anomalies += 1;
    touch();
    throw hostError(ERR.NO_OWNER, 'no owner is bound');
  }

  /**
   * Send `content` ({text} or {react}) to the owner — the ONLY socket send in
   * the WhatsApp Link. The target is always resolved here, from the owner
   * state; callers cannot name one.
   */
  async function sendToOwner(content, { replyTo = null } = {}) {
    if (!sock || connState !== CONN.OPEN) throw hostError(ERR.NOT_CONNECTED, 'WhatsApp is not connected');
    if (paused) throw hostError(ERR.PAUSED, 'sending is paused after an owner anomaly');
    assertOwnerTarget();
    if (typeof content?.text === 'string') {
      if (!content.text.trim()) throw hostError(ERR.BAD_REQUEST, 'text is empty');
      if (content.text.length > LIMITS.MAX_TEXT) throw hostError(ERR.TOO_LONG, `text is longer than ${LIMITS.MAX_TEXT} characters`);
    }
    const reaction = !!content?.react;
    const wait = capWait(reaction ? REACTION_RESERVE : 0);
    if (wait > 0 && reaction) throw hostError(ERR.THROTTLED, 'a status reaction yields to replies near the send limit', { retryAfterMs: wait });
    if (wait > 0) {
      counters.throttled += 1;
      emit({ t: EV.THROTTLED, retryAfterMs: wait });
      touch();
      throw hostError(ERR.THROTTLED, 'the WhatsApp send limit was reached', { retryAfterMs: wait });
    }
    sendLog.push(now());
    const run = async () => {
      const delay = nextSendAt - now();
      if (delay > 0) await sleep(delay);
      if (!sock || connState !== CONN.OPEN) throw hostError(ERR.NOT_CONNECTED, 'WhatsApp is not connected');
      if (paused) throw hostError(ERR.PAUSED, 'sending is paused after an owner anomaly');
      const target = assertOwnerTarget();
      const quoted = replyTo ? recentOwner.get(replyTo)?.copy : undefined;
      const payload = typeof content.text === 'string' ? { text: content.text, linkPreview: null } : content;
      let res;
      try {
        res = await sock.sendMessage(target, payload, quoted ? { quoted } : undefined);
      } catch (err) {
        throw hostError(ERR.SEND_FAILED, `WhatsApp send failed: ${redactWa(err?.message || err).slice(0, 200)}`);
      } finally {
        nextSendAt = now() + PACE_MIN_MS + Math.floor(rng() * PACE_JITTER_MS);
      }
      const id = res?.key?.id || null;
      rememberSent(id, target, res?.message);
      if (payload.react) counters.reactions += 1;
      else counters.sent += 1;
      touch();
      return { id };
    };
    const p = sendChain.then(run, run);
    sendChain = p.catch(() => {});
    return p;
  }

  // ── Presence ──

  function stopPresence({ notify = true } = {}) {
    const wasActive = presenceActive;
    presenceActive = false;
    clearTimer('presenceRefresh');
    clearTimer('presenceStop');
    if (notify && wasActive && sock && connState === CONN.OPEN) {
      const jid = owner.replyJid();
      if (jid && owner.isOwnerJid(jid)) Promise.resolve().then(() => sock?.sendPresenceUpdate('paused', jid)).catch(() => {});
    }
  }

  async function presence(stateName) {
    if (currentMode() === 'self') return { skipped: 'self' };
    if (!sock || connState !== CONN.OPEN) throw hostError(ERR.NOT_CONNECTED, 'WhatsApp is not connected');
    if (paused) throw hostError(ERR.PAUSED, 'sending is paused after an owner anomaly');
    const jid = assertOwnerTarget();
    if (stateName === 'paused') {
      stopPresence({ notify: false });
      await sock.sendPresenceUpdate('paused', jid);
      return { state: 'paused' };
    }
    await sock.sendPresenceUpdate('composing', jid);
    if (!presenceActive) {
      presenceActive = true;
      setRepeat('presenceRefresh', () => {
        const target = owner.replyJid();
        if (!sock || connState !== CONN.OPEN || !target || !owner.isOwnerJid(target)) {
          stopPresence({ notify: false });
          return;
        }
        Promise.resolve().then(() => sock.sendPresenceUpdate('composing', target)).catch(() => {});
      }, PRESENCE_REFRESH_MS);
      setTimer('presenceStop', () => stopPresence({ notify: true }), PRESENCE_MAX_MS);
    }
    return { state: 'composing' };
  }

  // ── Ops ──

  function requireRuntime() {
    if (!runtime) throw hostError(runtimeInfo.error === ERR.RUNTIME_ERROR ? ERR.RUNTIME_ERROR : ERR.RUNTIME_MISSING, 'the WhatsApp connector is not installed');
  }

  /** Nothing that needs the store runs without it; the refusal keeps init's code (LOCKED, AUTH_PERMS). */
  function requireStore() {
    if (!store) throw hostError(storeFailure?.code || ERR.INTERNAL, storeFailure?.reason || lastError || 'the WhatsApp session store is not available');
  }

  async function opConnect({ purpose, mode, link }) {
    requireRuntime();
    requireStore();
    if (purpose === 'run') {
      if (!isLinked()) throw hostError(ERR.NOT_LINKED, 'no WhatsApp account is linked');
      const stored = storedMode();
      if (mode && stored && mode !== stored) throw hostError(ERR.MODE_MISMATCH, `this device was linked in ${stored} mode`);
      if (sock && session?.purpose === 'run') return connStatus();
      if (timerIds.reconnect && session) {
        openSocket();
        return connStatus();
      }
      closeSocket();
      session = { purpose: 'run', mode: stored || mode || prefs.mode || 'self' };
      policy.reset();
      lastError = null;
      loadOwner();
      setState(CONN.CONNECTING);
      openSocket();
      return connStatus();
    }
    // purpose === 'link'
    if (isLinked()) throw hostError(ERR.ALREADY_LINKED, 'a WhatsApp account is already linked; log it out first');
    const method = link?.method || 'qr';
    let phone = null;
    if (method === 'code') {
      phone = String(link?.phone || '').replace(/[\s()+.-]/g, '');
      if (!/^\d{7,15}$/.test(phone)) throw hostError(ERR.BAD_PHONE, 'the phone number must be 7-15 digits, country code first');
    }
    closeSocket();
    wipeLocal();
    creds = runtime.mod.initAuthCreds();
    const linkMode = mode || prefs.mode || 'self';
    session = { purpose: 'link', mode: linkMode, method, phone, qrCount: 0, pairingRequested: false };
    policy.reset();
    lastError = null;
    lastDisconnect = null;
    owner = createOwnerState({ mode: linkMode });
    setState(CONN.CONNECTING);
    openSocket();
    return connStatus();
  }

  async function opDisconnect() {
    session = null;
    closeSocket();
    clearTimer('reconnect');
    clearTimer('confirm');
    retryAt = null;
    policy.reset();
    // Without a store (locked, or refused for its permissions) there is no idle to go back to.
    setState(!store ? connState : isLinked() ? CONN.IDLE : CONN.UNLINKED);
    return connStatus();
  }

  async function opLogout() {
    requireStore();
    await forgetDevice();
    setState(CONN.UNLINKED, { error: null });
    return connStatus();
  }

  async function opConfirmOwner({ accept }) {
    if (connState !== CONN.AWAITING_CONFIRM) throw hostError(ERR.NOT_AWAITING, 'nothing is waiting for confirmation');
    clearTimer('confirm');
    if (!accept) {
      await forgetDevice();
      setState(CONN.UNLINKED, { error: 'owner_rejected' });
      return connStatus();
    }
    store.meta.set('owner_confirmed', { at: now() });
    store.meta.delete('awaiting_confirm_until');
    awaitingConfirmUntil = null;
    paused = false;
    emit({ t: EV.OWNER_BOUND, masked: maskJid(creds.me.id), via: 'self_confirm' });
    setState(CONN.OPEN, { error: null });
    return connStatus();
  }

  function opClaimStart({ ttlMs }) {
    if (currentMode() !== 'dedicated') throw hostError(ERR.BAD_REQUEST, 'claim codes are for dedicated mode');
    if (connState !== CONN.OPEN) throw hostError(ERR.NOT_CONNECTED, 'WhatsApp is not connected');
    if (owner.bound) throw hostError(ERR.OWNER_BOUND, 'an owner is already bound; reset it first');
    claim?.cancel();
    claim = createClaim({ now, ttlMs: Number.isFinite(ttlMs) ? ttlMs : undefined });
    setTimer('claim', () => {
      claim = null;
      emitState();
    }, Math.max(0, claim.expiresAt - now()));
    const digits = parseJid(creds.me.id)?.user;
    emitState();
    return {
      code: claim.code,
      link: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(claim.code)}` : null,
      expiresAt: claim.expiresAt,
    };
  }

  function opClaimCancel() {
    claim?.cancel();
    claim = null;
    clearTimer('claim');
    emitState();
    return connStatus();
  }

  function opOwnerReset() {
    requireStore();
    if (currentMode() === 'dedicated') {
      owner.clear();
      store.owner.clear();
      claim = null;
      clearTimer('claim');
      paused = false;
      stopPresence({ notify: false });
      refreshIdentity();
      emitState();
      return connStatus();
    }
    // Self mode: the owner IS the linked account. Re-confirming could end in
    // a timeout logout, so a reset is refused; logging out changes accounts.
    throw hostError(ERR.BAD_REQUEST, 'in self mode the owner is the linked account; log out to link another one');
  }

  async function opReact({ id, reaction }) {
    const text = reaction === null ? '' : REACTIONS[reaction];
    const own = recentOwner.get(id);
    let key;
    if (own) key = { ...own.copy.key };
    else if (isOwnSent(id)) {
      const jid = owner.replyJid();
      if (!jid || !owner.isOwnerJid(jid)) throw hostError(ERR.NO_OWNER, 'no owner is bound');
      key = { remoteJid: jid, fromMe: true, id };
    } else throw hostError(ERR.BAD_TARGET, 'can only react to owner messages or SynaBun replies');
    return sendToOwner({ react: { text, key } });
  }

  async function opRead({ ids }) {
    if (currentMode() === 'self') return { skipped: 'self', read: 0 };
    if (!sock || connState !== CONN.OPEN) throw hostError(ERR.NOT_CONNECTED, 'WhatsApp is not connected');
    const keys = [];
    for (const id of ids.slice(0, LIMITS.MAX_READ_IDS)) {
      const own = recentOwner.get(id);
      if (own && owner.isOwnerJid(own.copy.key.remoteJid)) keys.push({ ...own.copy.key });
    }
    if (keys.length) await sock.readMessages(keys);
    return { read: keys.length };
  }

  async function dispatch(msg) {
    switch (msg.op) {
      case OP.CONFIGURE:
        prefs = { ...prefs, ...pickPrefs(msg.prefs) };
        if (!isLinked() && !session) owner = createOwnerState({ mode: prefs.mode || 'self' });
        emitState();
        return { prefs: { ...prefs } };
      case OP.CONNECT: return opConnect(msg);
      case OP.DISCONNECT: return opDisconnect();
      case OP.LOGOUT: return opLogout();
      case OP.CONFIRM_OWNER: return opConfirmOwner(msg);
      case OP.CLAIM_START: return opClaimStart(msg);
      case OP.CLAIM_CANCEL: return opClaimCancel();
      case OP.OWNER_RESET: return opOwnerReset();
      case OP.SEND: return sendToOwner({ text: msg.text }, { replyTo: msg.replyTo ?? null });
      case OP.REACT: return opReact(msg);
      case OP.PRESENCE: return presence(msg.state);
      case OP.READ: return opRead(msg);
      case OP.STATUS: return { conn: connStatus(), runtime: { ...runtimeInfo } };
      case OP.SHUTDOWN:
        await shutdown();
        return { ok: true };
      case OP.FAKE: {
        if (!runtime?.fake) throw hostError(ERR.NOT_FAKE, 'the fake runtime is not loaded');
        return runtime.mod.fake.control(msg.action, msg.args || {});
      }
      default:
        throw hostError(ERR.UNKNOWN_OP, `unknown op '${msg.op}'`);
    }
  }

  /** Replies are not schema-checked like events: redact any JID-bearing string as a backstop. */
  function scrubReply(v, depth = 0) {
    if (typeof v === 'string') return JID_IN_TEXT.test(v) ? redactWa(v) : v;
    if (v === null || typeof v !== 'object' || depth > 6) return v;
    if (Array.isArray(v)) return v.map((x) => scrubReply(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrubReply(x, depth + 1);
    return out;
  }

  function reply(reqId, ok, data, error) {
    if (!reqId) return;
    const ev = ok ? { t: EV.REPLY, reqId, ok: true, data: data ?? null } : { t: EV.REPLY, reqId, ok: false, error };
    emit(ev);
  }

  async function handleMessage(msg) {
    const v = validateOp(msg);
    if (!v.ok) {
      reply(msg?.reqId, false, null, { code: v.code, message: v.message });
      return;
    }
    if (!initialized && msg.op !== OP.SHUTDOWN) {
      reply(msg.reqId, false, null, { code: ERR.HOST_UNAVAILABLE, message: 'the WhatsApp host is still starting' });
      return;
    }
    try {
      const data = await dispatch(msg);
      // claim_start's wa.me link carries the dedicated account's own number by design.
      reply(msg.reqId, true, msg.op === OP.CLAIM_START || msg.op === OP.FAKE ? data : scrubReply(data));
    } catch (err) {
      const code = typeof err?.code === 'string' && ERR[err.code] ? err.code : ERR.INTERNAL;
      if (code === ERR.INTERNAL) say('warn', `[whatsapp] ${msg.op} failed: ${err?.message}`);
      const error = { code, message: redactWa(err?.message || String(err)).slice(0, 300) };
      if (Number.isFinite(err?.retryAfterMs)) {
        error.message = `${error.message} (retry in ${Math.ceil(err.retryAfterMs / 1000)} s)`;
        error.retryAfterMs = Math.max(0, Math.round(err.retryAfterMs));
      }
      reply(msg.reqId, false, null, error);
    }
  }

  // ── Lifecycle ──

  async function init() {
    try {
      runtime = await loadRuntime({ runtimeDir: paths.runtimeDir, env });
      runtimeInfo = { loaded: true, version: runtime.version ?? null, fake: !!runtime.fake, error: null };
    } catch (err) {
      runtime = null;
      runtimeInfo = { loaded: false, version: null, fake: false, error: err?.code === ERR.RUNTIME_ERROR ? ERR.RUNTIME_ERROR : ERR.RUNTIME_MISSING };
      if (err?.code === ERR.RUNTIME_ERROR) say('warn', `[whatsapp] ${err.message}`);
    }
    try {
      store = openStore({
        authDir: paths.authDir,
        ...(runtime ? { codec: runtime.codec, reviveKey: runtime.reviveKey } : {}),
        platform,
        now,
        log: (m, level) => say(level || 'warn', m),
      });
    } catch (err) {
      store = null;
      if (err?.code === 'LOCKED') {
        connState = CONN.LOCKED;
        lastError = LOCKED_REASON;
        storeFailure = { code: ERR.LOCKED, reason: LOCKED_REASON };
      } else if (err?.code === ERR.AUTH_PERMS) {
        // The linked-device keys would open readable by others (or owned by someone else): refused.
        connState = CONN.ERROR;
        lastError = AUTH_PERMS_REASON;
        storeFailure = { code: ERR.AUTH_PERMS, reason: AUTH_PERMS_REASON, message: redactWa(err.message || AUTH_PERMS_REASON).slice(0, 400) };
        say('error', `[whatsapp] ${storeFailure.message}`);
      } else {
        connState = CONN.ERROR;
        lastError = `auth store: ${redactWa(err?.message || err).slice(0, 150)}`;
        storeFailure = { code: ERR.INTERNAL, reason: lastError };
      }
    }
    if (store) {
      try { creds = store.loadCreds(); } catch (err) { say('error', `[whatsapp] could not read credentials: ${err?.message}`); creds = null; }
      for (const id of store.sent.recentIds()) sentIds.add(id);
      loadOwner();
      connState = isLinked() ? CONN.IDLE : CONN.UNLINKED;
      const pending = store.meta.get('awaiting_confirm_until');
      if (isLinked() && currentMode() === 'self' && !ownerConfirmed() && Number.isFinite(pending)) awaitingConfirmUntil = pending;
      setRepeat('prune', () => {
        try { store?.prune(); } catch {}
        const t = now();
        for (const [id, tap] of taps) if (t - tap.at > TAP_TTL_MS) taps.delete(id);
        tapsBySender.clear();
        for (const [id, tap] of taps) {
          if (!tapsBySender.has(tap.from)) tapsBySender.set(tap.from, []);
          tapsBySender.get(tap.from).push(id);
        }
      }, PRUNE_EVERY_MS);
      try { store.prune(); } catch {}
    }
    initialized = true;
    if (connState === CONN.LOCKED) emit({ t: EV.FATAL, code: 'LOCKED', message: lastError });
    if (storeFailure?.code === ERR.AUTH_PERMS) emit({ t: EV.FATAL, code: ERR.AUTH_PERMS, message: storeFailure.message });
    return { runtime: { ...runtimeInfo }, conn: connStatus() };
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    session = null;
    closeSocket();
    for (const name of Object.keys(timerIds)) clearTimer(name);
    try { store?.close(); } catch {}
  }

  return {
    init,
    handleMessage,
    shutdown,
    status: () => ({ conn: connStatus(), runtime: { ...runtimeInfo } }),
    get protocol() { return PROTOCOL_VERSION; },
  };
}
