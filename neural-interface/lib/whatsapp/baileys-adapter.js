// The only module that touches the Baileys runtime. It loads the connector
// entry (DATA_HOME/runtime/whatsapp/entry.mjs, installed on demand by
// installer.js) — or fake-baileys.js when SYNABUN_WHATSAPP_FAKE=1 — builds the
// socket config, maps disconnects, and turns WhatsApp messages into plain data.
// host-core.js owns the lifecycle and every decision; nothing here sends.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONN, ERR, LIMITS } from './protocol.js';
import { parseJid, sameAccount } from './identity.js';
import { redactWa } from './redact.js';

/** What connector/entry.mjs must export (the installer's probe checks the same list). */
export const RUNTIME_EXPORTS = Object.freeze([
  'makeWASocket', 'DisconnectReason', 'Browsers', 'BufferJSON', 'initAuthCreds', 'proto', 'jidNormalizedUser', 'jidDecode',
  'downloadMediaMessage', 'normalizeMessageContent', 'getContentType', 'fetchLatestBaileysVersion', 'makeCacheableSignalKeyStore',
]);

const QUOTED_MAX = 1000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const VERSION_RECHECK_MS = 6 * 3600_000;

function adapterError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// ── Runtime ──

/**
 * @returns {Promise<{mod:object, fake:boolean, version:string|null, codec:{replacer,reviver}, reviveKey:Function}>}
 */
export async function loadRuntime({ runtimeDir, env = process.env } = {}) {
  let mod;
  let fake = false;
  if (env.SYNABUN_WHATSAPP_FAKE === '1') {
    mod = await import('./fake-baileys.js');
    fake = true;
  } else {
    const entry = runtimeDir ? join(runtimeDir, 'entry.mjs') : '';
    if (!entry || !existsSync(entry)) throw adapterError(ERR.RUNTIME_MISSING, 'the WhatsApp connector is not installed');
    try {
      mod = await import(pathToFileURL(entry).href);
    } catch (err) {
      throw adapterError(ERR.RUNTIME_ERROR, `the WhatsApp connector failed to load: ${redactWa(err?.message || err).slice(0, 200)}`, err);
    }
  }
  const missing = RUNTIME_EXPORTS.filter((name) => mod[name] === undefined);
  if (missing.length) throw adapterError(ERR.RUNTIME_ERROR, `the WhatsApp connector lacks ${missing.join(', ')}`);
  let version = typeof mod.BAILEYS_VERSION === 'string' ? mod.BAILEYS_VERSION : null;
  if (!version && !fake && runtimeDir) {
    try { version = JSON.parse(readFileSync(join(runtimeDir, '.installed.json'), 'utf8')).version || null; } catch {}
  }
  const AppStateSyncKeyData = mod.proto?.Message?.AppStateSyncKeyData;
  return {
    mod,
    fake,
    version: fake ? 'fake' : version,
    codec: { replacer: mod.BufferJSON.replacer, reviver: mod.BufferJSON.reviver },
    reviveKey: (type, value) => (type === 'app-state-sync-key' && value && AppStateSyncKeyData?.fromObject ? AppStateSyncKeyData.fromObject(value) : value),
  };
}

/** Linked = paired and signed by the phone (a pairing code alone already sets creds.me). */
export function isLinkedCreds(creds) {
  return !!(creds?.me?.id && creds?.account);
}

// ── Socket config ──

const OS_LABEL = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** Stable per OS. The phone lists the device by the first element; 'Chrome' keeps a standard web client. */
export function browserTuple(platform = process.platform) {
  return [`SynaBun (${OS_LABEL[platform] || 'Desktop'})`, 'Chrome', '1.0.0'];
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

// Warnings about choices made on purpose, dropped instead of repeated on every
// connect. History sync stays off (shouldSyncHistoryMessage: () => false): the
// owner's own LID↔PN pair is stored at login and a dedicated owner's arrives
// with their first message, so the contact mappings the bootstrap carries are
// not needed — and history sync is the other spoofing path of CVE-2026-48063.
const INTENDED_WARNINGS = [/DISABLING ALL SYNC BY shouldSyncHistoryMsg/];

function formatLogArgs(args) {
  const parts = [];
  for (const a of args) {
    if (typeof a === 'string') parts.push(a);
    else if (a instanceof Error) parts.push(`${a.name}: ${a.message}`);
    else if (a && typeof a === 'object') {
      const err = a.err || a.error || a.trace;
      if (err instanceof Error) parts.push(`${err.name}: ${err.message}`);
      else if (typeof err === 'string') parts.push(err.split('\n')[0]);
      else if (err && typeof err.message === 'string') parts.push(err.message);
    } else if (a !== undefined && a !== null) parts.push(String(a));
  }
  return parts.join(' ').slice(0, 1000);
}

/**
 * Pino-shaped logger Baileys can call: silent below warn; warn and above go
 * through redactWa to `sink(level, message)`. Objects are never dumped — only
 * their error message — because Baileys puts nodes, keys and JIDs in them.
 */
export function createSilentLogger({ sink = () => {}, level = 'warn' } = {}) {
  const min = LEVELS.indexOf(level);
  const make = () => {
    const logger = { level };
    for (const name of LEVELS) {
      const idx = LEVELS.indexOf(name);
      logger[name] = (...args) => {
        if (idx < min || idx < LEVELS.indexOf('warn')) return;
        const text = redactWa(formatLogArgs(args));
        if (text && !INTENDED_WARNINGS.some((re) => re.test(text))) {
          try { sink(idx >= LEVELS.indexOf('error') ? 'error' : 'warn', text); } catch {}
        }
      };
    }
    logger.child = () => make();
    logger.isLevelEnabled = (name) => LEVELS.indexOf(name) >= Math.max(min, LEVELS.indexOf('warn'));
    return logger;
  };
  return make();
}

/**
 * Chats the socket should not even decrypt. Groups, status, broadcasts and
 * newsletters always; in self mode also every chat that is not the account's
 * own PN or LID. Dedicated mode keeps 1:1 DMs so the owner's LID alternate can
 * be matched.
 */
export function shouldIgnoreJid(jid, mode, self = {}) {
  const p = parseJid(jid);
  if (!p) return false;
  if (p.kind === 'group' || p.kind === 'broadcast' || p.kind === 'newsletter') return true;
  if (mode !== 'self') return false;
  if (!self.pn && !self.lid) return false; // not linked yet
  if (p.kind === 'pn' || p.kind === 'lid') return !(sameAccount(jid, self.pn) || sameAccount(jid, self.lid));
  // Hosted accounts, bots and calls are never the owner's own chat.
  return p.kind === 'hosted' || p.kind === 'hosted_lid' || p.kind === 'bot' || p.kind === 'call';
}

/** Sent messages are kept (protobuf, base64) so Baileys can answer retry requests. */
export function encodeSentMessage(mod, message) {
  try {
    if (!message) return null;
    return Buffer.from(mod.proto.Message.encode(message).finish()).toString('base64');
  } catch {
    return null;
  }
}

export function decodeSentMessage(mod, text) {
  try {
    return text ? mod.proto.Message.decode(Buffer.from(text, 'base64')) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build and open one socket.
 * @param {object} o
 * @param {object} o.runtime      loadRuntime() result
 * @param {object} o.store        auth-store (keys, sent)
 * @param {object} o.creds        the creds object (shared with the socket, mutated by it)
 * @param {'self'|'dedicated'} o.mode
 * @param {'qr'|'code'|null} o.method   linking method (code keeps each QR ref alive longer)
 * @param {object} o.logger       createSilentLogger()
 * @param {number[]|null} o.version  cached WA Web version, or null for the runtime default
 * @param {() => {pn:string|null, lid:string|null}} o.getSelfJids
 * @param {(node:object) => void} o.onStanza   raw <message> stanza tap
 */
export function createWaSocket({ runtime, store, creds, mode, method = null, logger, version = null, getSelfJids, onStanza, platform = process.platform }) {
  const mod = runtime.mod;
  const config = {
    auth: { creds, keys: mod.makeCacheableSignalKeyStore(store.keys, logger) },
    browser: browserTuple(platform),
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    emitOwnEvents: false,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => shouldIgnoreJid(jid, mode, getSelfJids?.() || {}),
    getMessage: async (key) => decodeSentMessage(mod, key?.id ? store.sent.get(key.id) : null),
  };
  if (Array.isArray(version) && version.length === 3 && version.every(Number.isInteger)) config.version = version;
  if (method === 'code') config.qrTimeout = 60_000;
  const sock = mod.makeWASocket(config);
  // The upserted message loses which device sent it and which stanza carried
  // it; the raw stanza has both. Listeners run in registration order inside one
  // synchronous emit, so this record exists long before the upsert.
  if (onStanza && sock?.ws?.on) sock.ws.on('CB:message', (node) => { try { onStanza(node); } catch {} });
  return sock;
}

/** The cached WA Web version, if any (host-core decides when to refresh it). */
export function cachedVersion(store) {
  const v = store?.meta?.get('wa_version');
  return Array.isArray(v?.version) && v.version.length === 3 ? v.version : null;
}

/**
 * After a 405: fetch the current WA Web version at most once per 6 hours.
 * @returns {Promise<boolean>} true when a new version was stored
 */
export async function refreshVersion({ runtime, store, now = () => Date.now() }) {
  const lastCheck = store.meta.get('wa_version_checked_at');
  if (Number.isFinite(lastCheck) && now() - lastCheck < VERSION_RECHECK_MS) return false;
  store.meta.set('wa_version_checked_at', now());
  try {
    const res = await runtime.mod.fetchLatestBaileysVersion();
    const v = res?.version;
    if (Array.isArray(v) && v.length === 3 && v.every(Number.isInteger)) {
      store.meta.set('wa_version', { version: v, fetchedAt: now() });
      return true;
    }
  } catch {}
  return false;
}

// ── Disconnects ──

export function disconnectCode(err) {
  const c = err?.output?.statusCode ?? err?.statusCode ?? err?.data?.statusCode;
  if (Number.isInteger(c)) return c;
  if (typeof c === 'string' && /^\d{3}$/.test(c)) return Number(c);
  return null;
}

/**
 * Map a lastDisconnect error to what the host does next, by DisconnectReason
 * NAME (408 is both connectionLost and timedOut; the enum's reverse map says
 * timedOut).
 * @returns {{action:'reconnect_now'|'refresh_version'|'backoff'|'stop', state:string, wipe:boolean, reason:string, code:number|null}}
 */
export function classifyDisconnect(err, { linking = false, DisconnectReason = {} } = {}) {
  const code = disconnectCode(err);
  const name = code !== null && typeof DisconnectReason[code] === 'string' ? DisconnectReason[code] : null;
  const out = (action, state, wipe, reason) => ({ action, state, wipe, reason, code });
  if (code === 405) return out('refresh_version', linking ? CONN.CONNECTING : CONN.RECONNECTING, false, 'outdated_version');
  switch (name) {
    case 'restartRequired':
      return out('reconnect_now', CONN.CONNECTING, false, name);
    case 'loggedOut':
      return out('stop', CONN.LOGGED_OUT, true, name);
    case 'connectionReplaced':
      return out('stop', CONN.REPLACED, false, name);
    case 'forbidden':
      return out('stop', CONN.FORBIDDEN, false, name);
    case 'badSession':
    case 'multideviceMismatch':
      return out('stop', CONN.ERROR, false, name);
    default:
      // timedOut / connectionLost / connectionClosed / unavailableService /
      // anything unknown. While linking that means the QR or code ran out:
      // stop instead of looping through fresh QR codes.
      if (linking) return out('stop', CONN.LINK_EXPIRED, true, name || 'link_failed');
      return out('backoff', CONN.RECONNECTING, false, name || (code === null ? 'closed' : `status_${code}`));
  }
}

/**
 * Reconnect delays 2/5/15/30/60/120/300 s ±20%; the ladder resets after 10
 * minutes connected; more than 10 reconnects inside 10 minutes gives up.
 */
export function createReconnectPolicy({
  now = () => Date.now(),
  rng = Math.random,
  scheduleSec = [2, 5, 15, 30, 60, 120, 300],
  jitter = 0.2,
  limit = 10,
  windowMs = 10 * 60_000,
} = {}) {
  let idx = 0;
  let attempts = [];
  return {
    /** @returns {{delayMs:number} | {giveUp:true}} */
    next() {
      const t = now();
      attempts = attempts.filter((a) => t - a < windowMs);
      if (attempts.length >= limit) return { giveUp: true };
      attempts.push(t);
      const base = scheduleSec[Math.min(idx, scheduleSec.length - 1)] * 1000;
      idx += 1;
      const factor = 1 + (rng() * 2 - 1) * jitter;
      return { delayMs: Math.max(0, Math.round(base * factor)) };
    },
    /** Connected long enough: start the ladder over. */
    noteStable() { idx = 0; },
    reset() { idx = 0; attempts = []; },
    get attempts() { return attempts.length; },
  };
}

// ── Messages ──

const DROP_TYPES = Object.freeze({
  protocolMessage: 'protocol',
  senderKeyDistributionMessage: 'protocol',
  messageHistoryBundle: 'protocol',
  keepInChatMessage: 'protocol',
  pinInChatMessage: 'protocol',
  encCommentMessage: 'protocol',
  editedMessage: 'edit',
  reactionMessage: 'reaction',
  encReactionMessage: 'reaction',
  pollUpdateMessage: 'poll_update',
  call: 'call',
  bcallMessage: 'call',
  callLogMesssage: 'call',
  scheduledCallCreationMessage: 'call',
  scheduledCallEditMessage: 'call',
  stickerMessage: 'sticker',
  lottieStickerMessage: 'sticker',
  stickerPackMessage: 'sticker',
});

const UNSUPPORTED = Object.freeze({
  audioMessage: 'audio',
  videoMessage: 'video',
  ptvMessage: 'video',
  documentMessage: 'document',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  pollCreationMessage: 'poll',
  pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll',
  pollCreationMessageV4: 'poll',
  pollCreationMessageV5: 'poll',
});

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function captionOf(inner) {
  return inner && typeof inner === 'object' && typeof inner.caption === 'string' ? inner.caption : '';
}

/**
 * Classify the content of one message without downloading anything.
 * @returns {{drop:string} | {type:string, kind:'text'|'image'|'unsupported', inner:object|null,
 *   contextInfo:object|null, text:string, unsupportedType:string|null}}
 */
export function describeContent(msg, mod) {
  if (!msg || !msg.key) return { drop: 'malformed' };
  if (msg.messageStubType) return { drop: 'stub' };
  if (!msg.message) return { drop: 'empty' };
  const content = mod.normalizeMessageContent(msg.message);
  if (!content) return { drop: 'empty' };
  const type = mod.getContentType(content);
  if (!type) return { drop: 'empty' };
  if (DROP_TYPES[type]) return { drop: DROP_TYPES[type] };
  const inner = content[type] && typeof content[type] === 'object' ? content[type] : null;
  const contextInfo = inner?.contextInfo && typeof inner.contextInfo === 'object' ? inner.contextInfo : null;
  if (type === 'conversation') {
    return { type, kind: 'text', inner: null, contextInfo: null, text: typeof content.conversation === 'string' ? content.conversation : '', unsupportedType: null };
  }
  if (type === 'extendedTextMessage') {
    return { type, kind: 'text', inner, contextInfo, text: typeof inner?.text === 'string' ? inner.text : '', unsupportedType: null };
  }
  if (type === 'imageMessage') {
    return { type, kind: 'image', inner, contextInfo, text: captionOf(inner), unsupportedType: null };
  }
  return { type, kind: 'unsupported', inner, contextInfo, text: captionOf(inner), unsupportedType: UNSUPPORTED[type] || 'other' };
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function quotedText(mod, quoted) {
  const content = mod.normalizeMessageContent(quoted);
  if (!content) return '';
  const type = mod.getContentType(content);
  if (type === 'conversation') return typeof content.conversation === 'string' ? content.conversation : '';
  const inner = type ? content[type] : null;
  if (type === 'extendedTextMessage') return typeof inner?.text === 'string' ? inner.text : '';
  return captionOf(inner);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const MSG_ID_RE = /^[A-Za-z0-9._:+/=-]{1,128}$/;

/**
 * Turn an accepted message into the parts of an InboundMessage (never a JID).
 * @returns {Promise<{text:string, images:Array, unsupported:null|{type:string, reason?:string}, forwarded:boolean, quoted:null|{id:string,text:string,fromBot:boolean}}>}
 */
export async function extractInbound(msg, { mod, sock, logger, sentIds, described, text }) {
  const d = described;
  const body = String(text ?? d.text ?? '').slice(0, LIMITS.MAX_INBOUND_TEXT);
  const ctx = d.contextInfo;
  const forwarded = !!(ctx && (ctx.isForwarded || Number(ctx.forwardingScore) > 0));
  let quoted = null;
  if (ctx?.quotedMessage && typeof ctx.stanzaId === 'string' && MSG_ID_RE.test(ctx.stanzaId)) {
    quoted = {
      id: ctx.stanzaId,
      text: quotedText(mod, ctx.quotedMessage).slice(0, QUOTED_MAX),
      fromBot: !!sentIds?.has?.(ctx.stanzaId),
    };
  }
  const images = [];
  let unsupported = null;
  if (d.kind === 'unsupported') unsupported = { type: d.unsupportedType };
  if (d.kind === 'image') {
    const mime = String(d.inner?.mimetype || '').split(';')[0].trim().toLowerCase();
    const declared = Number(d.inner?.fileLength ?? 0);
    if (!IMAGE_TYPES.has(mime)) unsupported = { type: 'image', reason: 'format' };
    else if (declared > LIMITS.MAX_IMAGE_BYTES) unsupported = { type: 'image', reason: 'too_large' };
    else {
      try {
        const buf = await withTimeout(
          mod.downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock?.updateMediaMessage }),
          DOWNLOAD_TIMEOUT_MS,
          'image download',
        );
        const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
        const sniffed = sniffImage(bytes);
        if (bytes.length > LIMITS.MAX_IMAGE_BYTES) unsupported = { type: 'image', reason: 'too_large' };
        else if (!sniffed) unsupported = { type: 'image', reason: 'format' };
        else images.push({ base64: bytes.toString('base64'), mediaType: sniffed, bytes: bytes.length });
      } catch {
        unsupported = { type: 'image', reason: 'download_failed' };
      }
    }
  }
  return { text: body, images, unsupported, forwarded, quoted };
}

/** The minimal message Baileys needs to quote an owner message in a reply. */
export function quotableCopy(msg, d) {
  const text = d?.text || '';
  return {
    key: { remoteJid: msg.key.remoteJid, fromMe: !!msg.key.fromMe, id: msg.key.id, ...(msg.key.participant ? { participant: msg.key.participant } : {}) },
    message: { conversation: text.slice(0, QUOTED_MAX) },
    messageTimestamp: msg.messageTimestamp,
  };
}
