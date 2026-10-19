// The only module that touches the Baileys runtime. It loads the connector
// entry (DATA_HOME/runtime/whatsapp/entry.mjs, installed on demand by
// installer.js) — or fake-baileys.js when SYNABUN_WHATSAPP_FAKE=1 — builds the
// socket config, maps disconnects, and turns WhatsApp messages into plain data.
// host-core.js owns the lifecycle and every decision; nothing here sends.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONN, CONN_WARNINGS, ERR, LIMITS, VOICE_MARKER } from './protocol.js';
import { parseJid, sameAccount } from './identity.js';
import { redactWa } from './redact.js';

/** What connector/entry.mjs must export (the installer's probe checks the same list). */
export const RUNTIME_EXPORTS = Object.freeze([
  'makeWASocket', 'DisconnectReason', 'Browsers', 'BufferJSON', 'initAuthCreds', 'proto', 'jidNormalizedUser', 'jidDecode',
  'downloadMediaMessage', 'normalizeMessageContent', 'getContentType', 'fetchLatestBaileysVersion', 'makeCacheableSignalKeyStore',
]);

const QUOTED_MAX = 1000;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
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

// Baileys 7.0.0-rc14 (the pinned connector) closes with 500 for more than a
// bad session: 500 is DisconnectReason.badSession, but it is also the code
// getErrorCodeFromStreamError (Utils/generics.js) gives any <stream:error>
// without a code of its own ("Stream Errored (<first child tag>)", the child
// node in `data`), the code getCodeFromWSError gives a WebSocket error it
// cannot place ("WebSocket Error (…)"), and the default of a <failure> without
// a reason ("Connection Failure"). Baileys itself never names a bad session:
// only WhatsApp's own stream-error child tag can, and only that wipes the
// saved credentials. Every other 500 is transport noise and is retried.
const STREAM_ERROR = /^Stream Errored \(/;
const INVALID_SESSION_TAG = /\b(?:bad[-_ ]?session|not[-_ ]?authori[sz]ed|invalid[-_ ]?session)\b/i;

/** WhatsApp said the saved session is invalid: a stream error whose reason tag names it (`<not-authorized/>`). */
export function invalidSessionSignal(err) {
  const message = typeof err?.message === 'string' ? err.message : '';
  if (!STREAM_ERROR.test(message)) return false;
  const tag = typeof err?.data?.tag === 'string' ? err.data.tag : '';
  return INVALID_SESSION_TAG.test(`${message} ${tag}`);
}

/** Which kind of generic 500 this is (the reason a log line and lastDisconnect carry). */
function transportReason(err) {
  const message = typeof err?.message === 'string' ? err.message : '';
  if (STREAM_ERROR.test(message)) return 'stream_error';
  if (/^WebSocket Error \(/.test(message)) return 'websocket_error';
  if (/^Connection Failure\b/.test(message)) return 'connection_failure';
  return 'status_500';
}

/**
 * Map a lastDisconnect error to what the host does next, by DisconnectReason
 * NAME (408 is both connectionLost and timedOut; the enum's reverse map says
 * timedOut). A saved session never gives up on its own: only 401 (logged out)
 * and an explicitly invalid session stop it, and both wipe the credentials.
 * 440 and 403 retry from the longest delay (`delay: 'long'`) and carry a
 * `warning` the service shows (CONN_WARNINGS). While linking (no saved
 * session) anything but 515, 405, 401 and 403 means the QR or code ran out.
 * @returns {{action:'reconnect_now'|'refresh_version'|'backoff'|'stop', state:string, wipe:boolean, reason:string, code:number|null,
 *   delay?:'long', warning?:'replaced'|'forbidden'}}
 */
export function classifyDisconnect(err, { linking = false, DisconnectReason = {} } = {}) {
  const code = disconnectCode(err);
  const name = code !== null && typeof DisconnectReason[code] === 'string' ? DisconnectReason[code] : null;
  const out = (action, state, wipe, reason, extra = null) => ({ action, state, wipe, reason, code, ...(extra || {}) });
  // 500: an explicit bad session, or noise (a generic stream / WebSocket / failure error).
  const reason = name === 'badSession' ? (invalidSessionSignal(err) ? 'badSession' : transportReason(err)) : name;
  if (code === 405) return out('refresh_version', linking ? CONN.CONNECTING : CONN.RECONNECTING, false, 'outdated_version');
  if (name === 'restartRequired') return out('reconnect_now', CONN.CONNECTING, false, name);
  if (name === 'loggedOut') return out('stop', CONN.LOGGED_OUT, true, name);
  if (linking) {
    if (name === 'forbidden') return out('stop', CONN.FORBIDDEN, false, name);
    // A timeout or a closed stream means the QR / code ran out: stop instead of looping through fresh QR codes.
    return out('stop', CONN.LINK_EXPIRED, true, reason || 'link_failed');
  }
  if (reason === 'badSession') return out('stop', CONN.LOGGED_OUT, true, reason);
  const warning = CONN_WARNINGS[code];
  if (warning) {
    // Two copies of one session would kick each other every few seconds, and a refused account is not hammered.
    return out('backoff', CONN.RECONNECTING, false, name || `status_${code}`, { delay: 'long', warning });
  }
  // timedOut / connectionLost / connectionClosed / unavailableService / multideviceMismatch /
  // a generic 500 / anything unknown: keep the credentials and try again.
  return out('backoff', CONN.RECONNECTING, false, reason || (code === null ? 'closed' : `status_${code}`));
}

/**
 * Reconnect delays 2/4/8/16/32/64/128/256/300 s, each ±20% and never above
 * 300 s; the ladder starts over after 10 minutes connected (noteStable). It
 * never gives up. `next({ long: true })` (440, 403) goes to the top at once and
 * stays there until that stable connection: after a session another copy took
 * or an account WhatsApp refused, any drop waits the long delay (a refused
 * account may fail in other ways too, and two copies must not trade quick
 * retries), the same 10 minutes that end the warning Settings shows.
 */
export function createReconnectPolicy({
  rng = Math.random,
  scheduleSec = [2, 4, 8, 16, 32, 64, 128, 256, 300],
  jitter = 0.2,
  maxMs = 300_000,
} = {}) {
  let idx = 0;
  let attempts = 0;
  return {
    /** @returns {{delayMs:number}} */
    next({ long = false } = {}) {
      if (long) idx = Math.max(idx, scheduleSec.length - 1);
      const base = scheduleSec[Math.min(idx, scheduleSec.length - 1)] * 1000;
      idx += 1;
      attempts += 1;
      const factor = 1 + (rng() * 2 - 1) * jitter;
      return { delayMs: Math.min(maxMs, Math.max(0, Math.round(base * factor))) };
    },
    /** Connected long enough: start the ladder over. */
    noteStable() { idx = 0; },
    reset() { idx = 0; attempts = 0; },
    /** Retries scheduled since the last reset (an explicit connect). */
    get attempts() { return attempts; },
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

// audioMessage (voice notes and audio files) is kind 'audio': transcribed on this computer (transcription.js).
const UNSUPPORTED = Object.freeze({
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
 * @returns {{drop:string} | {type:string, kind:'text'|'image'|'audio'|'unsupported', inner:object|null,
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
  if (type === 'audioMessage') {
    return { type, kind: 'audio', inner, contextInfo, text: captionOf(inner), unsupportedType: null };
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

/** A size or duration a message declares about itself (a number, a protobuf Long, a string), or null when it says none. */
function declared(value) {
  if (value === null || value === undefined || value === '') return null;
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'bigint' || typeof value === 'string') n = Number(value);
  else if (typeof value?.toNumber === 'function') { try { n = value.toNumber(); } catch { n = NaN; } }
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A voice note or audio file (kind 'audio'), only for a message host-core already accepted:
 * → { transcript, recorded } or { unsupported: { type: 'audio', reason } }. `recorded`: a voice note
 * the sender recorded in WhatsApp (ptt), not an audio file attached to the chat. Nothing is downloaded while
 * transcription is off or cannot run here, or when the message says it is over a limit.
 *   transcriber  transcription.js createTranscriber() (enabled, available(), transcribe())
 *   stale        sent so long ago that the bridge will skip it anyway: not worth transcribing
 */
async function readAudio(msg, { mod, sock, logger, inner, transcriber, stale }) {
  const refuse = (reason) => ({ unsupported: { type: 'audio', reason } });
  if (!transcriber || !transcriber.enabled) return refuse('transcription_disabled');
  let ready = false;
  try { ready = transcriber.available() === true; } catch { ready = false; }
  if (!ready) return refuse('transcription_unavailable');
  if ((declared(inner?.fileLength) ?? 0) > LIMITS.MAX_AUDIO_BYTES) return refuse('too_large');
  if ((declared(inner?.seconds) ?? 0) > LIMITS.MAX_AUDIO_SECONDS) return refuse('too_long');
  if (stale) return refuse('stale');
  let bytes;
  try {
    const buf = await withTimeout(
      mod.downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock?.updateMediaMessage }),
      DOWNLOAD_TIMEOUT_MS,
      'audio download',
    );
    bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  } catch {
    return refuse('transcription_failed');
  }
  if (bytes.length > LIMITS.MAX_AUDIO_BYTES) return refuse('too_large');
  if (!bytes.length) return refuse('transcription_failed');
  let result = null;
  try { result = await transcriber.transcribe(bytes); } catch { result = null; }
  if (result?.ok && typeof result.text === 'string' && result.text.trim()) return { transcript: result.text.trim(), recorded: inner?.ptt === true };
  // Turned off while the note waited its turn: said as such, not as a failure.
  return refuse(['too_long', 'too_large', 'transcription_disabled'].includes(result?.reason) ? result.reason : 'transcription_failed');
}

/**
 * Turn an accepted message into the parts of an InboundMessage (never a JID).
 * A transcribed voice note: `text` is VOICE_MARKER + the transcript, then "\n" + the caption when
 * there is one (the transcript first when the text is cut), and `voice: true`; `audioFile: true` when
 * it is an audio file rather than a note recorded in WhatsApp (its words may be anyone's: the bridge
 * treats it like a picture).
 * @returns {Promise<{text:string, images:Array, unsupported:null|{type:string, reason?:string}, forwarded:boolean,
 *   quoted:null|{id:string,text:string,fromBot:boolean}, voice:boolean, audioFile:boolean}>}
 */
export async function extractInbound(msg, { mod, sock, logger, sentIds, described, text, transcriber = null, audioStale = false }) {
  const d = described;
  let body = String(text ?? d.text ?? '').slice(0, LIMITS.MAX_INBOUND_TEXT);
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
  let voice = false;
  let audioFile = false;
  if (d.kind === 'unsupported') unsupported = { type: d.unsupportedType };
  if (d.kind === 'audio') {
    const audio = await readAudio(msg, { mod, sock, logger, inner: d.inner, transcriber, stale: audioStale });
    if (audio.transcript) {
      const caption = String(text ?? d.text ?? '');
      body = `${VOICE_MARKER} ${audio.transcript}${caption.trim() ? `\n${caption}` : ''}`.slice(0, LIMITS.MAX_INBOUND_TEXT);
      voice = true;
      audioFile = !audio.recorded;
    } else {
      // The same unsupported-audio shape as before, with why; a caption still gets through.
      unsupported = audio.unsupported;
    }
  }
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
  return { text: body, images, unsupported, forwarded, quoted, voice, audioFile };
}

/**
 * The sendMessage content for a file prepared by local-file.js (prepareLocalFile): a document
 * (mimetype + fileName, the caption when there is one), a photo or a video (the caption), or audio
 * (never a caption, never a voice note). `jpegThumbnail: null` keeps Baileys from building a preview,
 * which for a video means running FFmpeg through a shell: SynaBun never decodes the file it sends.
 */
export function fileMessage(file) {
  const caption = typeof file?.caption === 'string' && file.caption ? { caption: file.caption } : {};
  switch (file?.type) {
    case 'image': return { image: file.data, mimetype: file.mimetype, jpegThumbnail: null, ...caption };
    case 'video': return { video: file.data, mimetype: file.mimetype, jpegThumbnail: null, ...caption };
    case 'audio': return { audio: file.data, mimetype: file.mimetype, ptt: false };
    default: return { document: file.data, mimetype: file.mimetype, fileName: file.fileName || 'file', ...caption };
  }
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
