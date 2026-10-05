// Fake Baileys runtime for tests and SYNABUN_WHATSAPP_FAKE=1. Exports the same
// names as connector/entry.mjs, with a socket that implements exactly the
// surface baileys-adapter.js and host-core.js use, plus `fake`: a controller
// that plays the phone side (scan, inbound from the owner or a stranger, text
// or image, disconnect by reason name, forbidden, crash) and records every
// outgoing call so tests can assert who the host talked to.
//
// Module state is per process: call fake.reset() between tests.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { FALLBACK_CODEC } from './auth-store.js';

export const BAILEYS_VERSION = 'fake';

// Same shape as Baileys' TypeScript numeric enum (408 reverse-maps to timedOut).
export const DisconnectReason = (() => {
  const r = {};
  for (const [name, code] of [
    ['connectionClosed', 428], ['connectionLost', 408], ['connectionReplaced', 440], ['timedOut', 408],
    ['loggedOut', 401], ['badSession', 500], ['restartRequired', 515], ['multideviceMismatch', 411],
    ['forbidden', 403], ['unavailableService', 503],
  ]) {
    r[name] = code;
    r[code] = name;
  }
  return Object.freeze(r);
})();

export const Browsers = Object.freeze({
  ubuntu: (browser) => ['Ubuntu', browser, '22.04.4'],
  macOS: (browser) => ['Mac OS', browser, '14.4.1'],
  baileys: (browser) => ['Baileys', browser, '6.5.0'],
  windows: (browser) => ['Windows', browser, '10.0.22631'],
  appropriate: (browser) => ['Mac OS', browser, '14.4.1'],
});

export const BufferJSON = FALLBACK_CODEC;

export const proto = Object.freeze({
  Message: Object.freeze({
    AppStateSyncKeyData: Object.freeze({ fromObject: (o) => ({ ...o, revivedByProto: true }) }),
    encode: (m) => ({ finish: () => Buffer.from(JSON.stringify(m ?? {})) }),
    decode: (b) => JSON.parse(Buffer.from(b).toString('utf8')),
    fromObject: (o) => o,
  }),
});

export function initAuthCreds() {
  const kp = () => ({ public: randomBytes(32), private: randomBytes(32) });
  return {
    noiseKey: kp(),
    pairingEphemeralKeyPair: kp(),
    signedIdentityKey: kp(),
    signedPreKey: { keyPair: kp(), signature: randomBytes(64), keyId: 1 },
    registrationId: 1 + Math.floor(Math.random() * 16000),
    advSecretKey: randomBytes(32).toString('base64'),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false,
    pairingCode: undefined,
    lastPropHash: undefined,
    routingInfo: undefined,
  };
}

export function jidDecode(jid) {
  const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1;
  if (sepIdx < 0) return undefined;
  const server = jid.slice(sepIdx + 1);
  const userCombined = jid.slice(0, sepIdx);
  const [userAgent, device] = userCombined.split(':');
  const [user, agent] = userAgent.split('_');
  return { server, user, domainType: server === 'lid' ? 1 : agent ? parseInt(agent, 10) : 0, device: device ? +device : undefined };
}

export function jidNormalizedUser(jid) {
  const result = jidDecode(jid);
  if (!result) return '';
  const { user, server } = result;
  return `${user || ''}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
}

export function normalizeMessageContent(content) {
  if (!content) return undefined;
  for (let i = 0; i < 5; i++) {
    const inner = content?.ephemeralMessage || content?.viewOnceMessage || content?.documentWithCaptionMessage
      || content?.viewOnceMessageV2 || content?.viewOnceMessageV2Extension || content?.editedMessage
      || content?.associatedChildMessage || content?.groupStatusMessage || content?.groupStatusMessageV2;
    if (!inner) break;
    content = inner.message;
  }
  return content;
}

export function getContentType(content) {
  if (!content) return undefined;
  return Object.keys(content).find((k) => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage');
}

export async function downloadMediaMessage(message, _type, _options, ctx) {
  const img = normalizeMessageContent(message?.message)?.imageMessage;
  if (!img) throw new Error('not a media message');
  if (img.fakeFail) {
    if (ctx?.reuploadRequest) await ctx.reuploadRequest(message);
    throw Object.assign(new Error('fake download failed'), { status: 404 });
  }
  return Buffer.from(img.fakeData || []);
}

export async function fetchLatestBaileysVersion() {
  state.versionFetches += 1;
  return { version: [...state.latestVersion], isLatest: true };
}

export function makeCacheableSignalKeyStore(store) {
  return {
    get: async (type, ids) => store.get(type, ids),
    set: async (data) => store.set(data),
    clear: async () => store.clear?.(),
  };
}

// ── Scripted world ──

const state = {
  sockets: [],
  sent: [],
  presence: [],
  reads: [],
  pairingRequests: [],
  logouts: 0,
  versionFetches: 0,
  ignoredByJid: 0,
  latestVersion: [2, 3000, 1027934701],
  failNextSend: false,
  seq: 0,
  account: { pn: '15550001111', lid: '99887766554433', name: 'Fake Account' },
  people: {
    owner: { pn: '15550003333', lid: '55443322110099' },
    stranger: { pn: '15550002222', lid: '11223344556677' },
  },
};

function boom(statusCode, message = 'fake disconnect') {
  const err = new Error(message);
  err.isBoom = true;
  err.output = { statusCode, payload: { statusCode, message } };
  return err;
}

function userOf(jid) {
  return jidDecode(jid)?.user || null;
}

/** Message ids without long digit runs, so tests can grep events for phone numbers. */
function randomLetters(n) {
  return [...randomBytes(n)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
}

function makeSocket(config) {
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  ev.setMaxListeners(50);
  ws.setMaxListeners(50);
  const creds = config.auth.creds;
  let closed = false;
  let qrCount = 0;

  const sock = {
    type: 'md',
    ws,
    ev,
    config,
    authState: { creds, keys: config.auth.keys },
    get user() { return creds.me; },
    get closed() { return closed; },
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => {
          const user = userOf(lid);
          const who = [state.account, ...Object.values(state.people)].find((p) => p.lid === user);
          return who ? `${who.pn}@s.whatsapp.net` : null;
        },
        getLIDForPN: async (pn) => {
          const user = userOf(pn);
          const who = [state.account, ...Object.values(state.people)].find((p) => p.pn === user);
          return who ? `${who.lid}@lid` : null;
        },
      },
    },
    sendMessage: async (jid, content, options) => {
      if (closed) throw boom(428, 'Connection Closed');
      if (state.failNextSend) {
        state.failNextSend = false;
        throw new Error('fake send failure');
      }
      const id = `FAKEOUT${++state.seq}`;
      state.sent.push({
        jid,
        kind: content?.react ? 'react' : content?.text !== undefined ? 'text' : 'other',
        text: content?.text,
        react: content?.react ? { text: content.react.text, keyId: content.react.key?.id, keyJid: content.react.key?.remoteJid } : undefined,
        linkPreview: content?.linkPreview,
        quotedId: options?.quoted?.key?.id ?? null,
        at: Date.now(),
      });
      const message = content?.react ? { reactionMessage: content.react } : { extendedTextMessage: { text: content?.text ?? '' } };
      return { key: { remoteJid: jid, fromMe: true, id }, message, messageTimestamp: Math.floor(Date.now() / 1000) };
    },
    requestPairingCode: async (phone) => {
      state.pairingRequests.push(phone);
      creds.pairingCode = 'FAKE2345';
      creds.me = { id: `${phone}@s.whatsapp.net`, name: '~' };
      ev.emit('creds.update', creds);
      return creds.pairingCode;
    },
    logout: async () => {
      state.logouts += 1;
      sock.end(boom(401, 'Intentional Logout'));
    },
    end: (error) => {
      if (closed) return;
      closed = true;
      setImmediate(() => {
        ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });
        ev.removeAllListeners();
        ws.removeAllListeners();
      });
    },
    sendPresenceUpdate: async (type, jid) => {
      state.presence.push({ type, jid });
    },
    readMessages: async (keys) => {
      for (const k of keys) state.reads.push({ id: k.id, jid: k.remoteJid });
    },
    updateMediaMessage: async (m) => m,
    emitQr() {
      if (closed) return;
      qrCount += 1;
      const b64 = () => randomBytes(32).toString('base64');
      ev.emit('connection.update', { qr: `https://wa.me/settings/linked_devices#2@FAKEref${qrCount}${randomBytes(12).toString('base64')},${b64()},${b64()},${b64()},1` });
    },
  };

  process.nextTick(() => {
    if (closed) return;
    ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    if (creds.me?.id && creds.account) {
      setImmediate(() => {
        if (closed) return;
        ev.emit('creds.update', { me: { ...creds.me } });
        ev.emit('connection.update', { connection: 'open' });
      });
    } else {
      setImmediate(() => sock.emitQr());
    }
  });
  return sock;
}

export function makeWASocket(config) {
  const sock = makeSocket(config);
  state.sockets.push(sock);
  return sock;
}

function current() {
  const sock = state.sockets[state.sockets.length - 1];
  if (!sock || sock.closed) throw new Error('no open fake socket');
  return sock;
}

function buildContent({ text, image, forwarded, quoted }) {
  const contextInfo = forwarded || quoted
    ? {
      ...(forwarded ? { isForwarded: true, forwardingScore: 1 } : {}),
      ...(quoted ? { stanzaId: quoted.id, quotedMessage: { conversation: quoted.text ?? '' } } : {}),
    }
    : undefined;
  if (image) {
    const data = Buffer.isBuffer(image.data) ? image.data : Buffer.from(image.base64 || '', 'base64');
    return {
      imageMessage: {
        mimetype: image.mimetype || 'image/jpeg',
        fileLength: image.fileLength ?? data.length,
        caption: text,
        url: 'https://fake.invalid/media',
        fakeData: data,
        fakeFail: !!image.fail,
        ...(contextInfo ? { contextInfo } : {}),
      },
    };
  }
  if (contextInfo) return { extendedTextMessage: { text: text ?? '', contextInfo } };
  return { conversation: text ?? '' };
}

/** Scripted phone actions. Everything returns JSON-safe data. */
export const fake = {
  get state() { return state; },
  get sockets() { return state.sockets; },
  current,
  reset() {
    for (const s of state.sockets) { try { s.end(undefined); } catch {} }
    state.sockets = [];
    state.sent = [];
    state.presence = [];
    state.reads = [];
    state.pairingRequests = [];
    state.logouts = 0;
    state.versionFetches = 0;
    state.ignoredByJid = 0;
    state.failNextSend = false;
    state.latestVersion = [2, 3000, 1027934701];
    state.seq = 0;
    state.account = { pn: '15550001111', lid: '99887766554433', name: 'Fake Account' };
    state.people = { owner: { pn: '15550003333', lid: '55443322110099' }, stranger: { pn: '15550002222', lid: '11223344556677' } };
  },
  /** The phone scans the QR (or confirms the pairing code): pair-success, then the server asks for a restart. */
  scan({ pn = state.account.pn, lid = state.account.lid, name = state.account.name } = {}) {
    const sock = current();
    const creds = sock.authState.creds;
    state.account = { pn, lid, name };
    creds.me = { id: `${pn}:12@s.whatsapp.net`, lid: `${lid}:12@lid`, name };
    creds.account = { details: 'ZmFrZQ==', accountSignatureKey: randomBytes(32), accountSignature: randomBytes(64), deviceSignature: randomBytes(64) };
    creds.platform = 'fake';
    sock.ev.emit('creds.update', { me: creds.me, account: creds.account, platform: creds.platform });
    sock.ev.emit('connection.update', { isNewLogin: true, qr: undefined });
    sock.end(boom(DisconnectReason.restartRequired, 'restart required'));
    return { ok: true };
  },
  nextQr() {
    current().emitQr();
    return { ok: true };
  },
  /**
   * One incoming message. from: 'self' (the linked account in its own chat),
   * 'self_other' (the linked account writing to a stranger), 'owner' (the
   * dedicated owner), 'stranger'. device: the sender's device (0 = phone).
   * type 'append' plays WhatsApp delivering what it held while the device was
   * offline: the stanza carries `offline` (unless offline: false) and `at`
   * (epoch ms, default now) is when the phone sent it.
   */
  inbound({
    from = 'self', text, image = null, device = 0, type = 'notify', addressing = 'pn', id, forwarded = false, quoted = null,
    requestId, noStanza = false, stanzaFrom, content, stub, at = null, offline = null,
  } = {}) {
    const sock = current();
    const creds = sock.authState.creds;
    const me = { pn: userOf(creds.me?.id), lid: userOf(creds.me?.lid) };
    const people = { self: [me, me, true], self_other: [state.people.stranger, me, true], owner: [state.people.owner, state.people.owner, false], stranger: [state.people.stranger, state.people.stranger, false] };
    const [chat, sender, fromMe] = people[from] || people.self;
    const lid = addressing === 'lid';
    const chatJid = lid ? `${chat.lid}@lid` : `${chat.pn}@s.whatsapp.net`;
    const chatAlt = lid ? `${chat.pn}@s.whatsapp.net` : `${chat.lid}@lid`;
    const senderJid = `${lid ? sender.lid : sender.pn}${device ? `:${device}` : ''}@${lid ? 'lid' : 's.whatsapp.net'}`;
    const msgId = id || `FAKEIN${++state.seq}X${randomLetters(8)}`;
    const ts = Math.floor((Number.isFinite(at) ? at : Date.now()) / 1000);
    const msg = {
      key: { remoteJid: chatJid, remoteJidAlt: fromMe ? undefined : chatAlt, fromMe, id: msgId, addressingMode: lid ? 'lid' : 'pn' },
      messageTimestamp: ts,
      pushName: 'fake',
      message: stub ? undefined : content || buildContent({ text, image, forwarded, quoted }),
      ...(stub ? { messageStubType: 1 } : {}),
    };
    const stanzaSender = stanzaFrom || senderJid;
    if (!noStanza) {
      const attrs = { id: msgId, from: stanzaSender, t: String(ts), type: 'text', addressing_mode: lid ? 'lid' : 'pn' };
      if (offline ?? type === 'append') attrs.offline = '1';
      if (fromMe) attrs.recipient = chatJid;
      else if (lid) attrs.sender_pn = `${sender.pn}@s.whatsapp.net`;
      else attrs.sender_lid = `${sender.lid}@lid`;
      sock.ws.emit('CB:message', { tag: 'message', attrs, content: [] });
    }
    // Baileys drops ignored JIDs (by the stanza's `from`) before decrypting.
    if (sock.config.shouldIgnoreJid?.(stanzaSender)) {
      state.ignoredByJid += 1;
      return { id: msgId, ignored: true };
    }
    const payload = { messages: [msg], type };
    if (requestId) payload.requestId = requestId;
    setImmediate(() => { if (!sock.closed) sock.ev.emit('messages.upsert', payload); });
    return { id: msgId, ignored: false };
  },
  /** Close the socket with a DisconnectReason name (or a numeric status such as 405). */
  disconnect(reason = 'connectionLost') {
    const code = typeof reason === 'number' ? reason : DisconnectReason[reason];
    current().end(boom(code ?? 500, `fake ${reason}`));
    return { ok: true };
  },
  forbidden() {
    return fake.disconnect('forbidden');
  },
  crash() {
    setImmediate(() => { throw new Error('fake runtime crash'); });
    return { ok: true };
  },
  failNextSend() {
    state.failNextSend = true;
    return { ok: true };
  },
  /** JSON-safe view of what the host did (used through the __fake op). */
  snapshot() {
    return {
      sockets: state.sockets.length,
      sent: state.sent.map((s) => ({ ...s })),
      presence: state.presence.map((p) => ({ ...p })),
      reads: state.reads.map((r) => ({ ...r })),
      pairingRequests: [...state.pairingRequests],
      logouts: state.logouts,
      versionFetches: state.versionFetches,
      ignoredByJid: state.ignoredByJid,
      account: { ...state.account },
      people: JSON.parse(JSON.stringify(state.people)),
    };
  },
  /** Dispatcher for the host's __fake op. */
  control(action, args = {}) {
    const actions = {
      reset: () => (fake.reset(), { ok: true }),
      scan: () => fake.scan(args),
      nextQr: () => fake.nextQr(),
      inbound: () => fake.inbound(args),
      disconnect: () => fake.disconnect(args.reason),
      forbidden: () => fake.forbidden(),
      crash: () => fake.crash(),
      failNextSend: () => fake.failNextSend(),
      snapshot: () => fake.snapshot(),
      setPeople: () => {
        if (args.owner) state.people.owner = { ...args.owner };
        if (args.stranger) state.people.stranger = { ...args.stranger };
        if (args.account) state.account = { ...state.account, ...args.account };
        return { ok: true };
      },
    };
    const fn = actions[action];
    if (!fn) throw new Error(`unknown fake action '${action}'`);
    return fn();
  },
};
