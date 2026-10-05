// WhatsApp Link host protocol — shared by the main-side manager (manager.js)
// and the child host (host.js → host-core.js). Bump PROTOCOL_VERSION on any
// incompatible change: the manager kills a host announcing another version.
//
// Main ↔ host (child_process IPC, serialization:'advanced'):
//   main→host  {op, reqId?, ...fields}         every op with a reqId is answered
//   host→main  {t:'reply', reqId, ok, data? | error:{code, message}}
//              {t:'ready'|'state'|'qr'|'pairing_code'|'linked'|'owner_bound'|
//                 'inbound'|'ignored'|'throttled'|'fatal'|'log', ...}
//
// Addressing: no op that makes the host talk to WhatsApp carries an address.
// send/react/presence/read always reach the bound owner (sendToOwner in
// host-core.js is the only sendMessage call site) and validateOp rejects any
// address-shaped key on them. Events never carry a JID or a phone number: the
// schemas below are closed, so a stray field fails validation instead of
// leaking. The single exception is the claim_start reply, whose wa.me link
// holds the dedicated account's own number for the local settings tab.

export const PROTOCOL_VERSION = 1;

export const OP = Object.freeze({
  CONFIGURE: 'configure',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  LOGOUT: 'logout',
  CONFIRM_OWNER: 'confirm_owner',
  CLAIM_START: 'claim_start',
  CLAIM_CANCEL: 'claim_cancel',
  OWNER_RESET: 'owner_reset',
  SEND: 'send',
  REACT: 'react',
  PRESENCE: 'presence',
  READ: 'read',
  STATUS: 'status',
  SHUTDOWN: 'shutdown',
  // Test driver for the fake socket; the host refuses it unless the runtime is fake.
  FAKE: '__fake',
});

export const EV = Object.freeze({
  READY: 'ready',
  REPLY: 'reply',
  STATE: 'state',
  QR: 'qr',
  PAIRING_CODE: 'pairing_code',
  LINKED: 'linked',
  OWNER_BOUND: 'owner_bound',
  INBOUND: 'inbound',
  IGNORED: 'ignored',
  THROTTLED: 'throttled',
  FATAL: 'fatal',
  LOG: 'log',
});

/** conn.state values. `held` is set by the manager (crash breaker), never by the host. */
export const CONN = Object.freeze({
  IDLE: 'idle',
  UNLINKED: 'unlinked',
  CONNECTING: 'connecting',
  QR: 'qr',
  PAIRING: 'pairing',
  AWAITING_CONFIRM: 'awaiting_confirm',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  LOGGED_OUT: 'logged_out',
  REPLACED: 'replaced',
  FORBIDDEN: 'forbidden',
  LINK_EXPIRED: 'link_expired',
  LOCKED: 'locked',
  HELD: 'held',
  ERROR: 'error',
});

export const ERR = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  UNKNOWN_OP: 'UNKNOWN_OP',
  ADDRESS_FORBIDDEN: 'ADDRESS_FORBIDDEN',
  RUNTIME_MISSING: 'RUNTIME_MISSING',
  RUNTIME_ERROR: 'RUNTIME_ERROR',
  LOCKED: 'LOCKED',
  // The credential store refused to open: its folder / files could not be made private (0700 / 0600, ours).
  AUTH_PERMS: 'AUTH_PERMS',
  NOT_LINKED: 'NOT_LINKED',
  ALREADY_LINKED: 'ALREADY_LINKED',
  MODE_MISMATCH: 'MODE_MISMATCH',
  NOT_CONNECTED: 'NOT_CONNECTED',
  NOT_CONFIRMED: 'NOT_CONFIRMED',
  NOT_AWAITING: 'NOT_AWAITING',
  NO_OWNER: 'NO_OWNER',
  OWNER_BOUND: 'OWNER_BOUND',
  PAUSED: 'PAUSED',
  THROTTLED: 'THROTTLED',
  TOO_LONG: 'TOO_LONG',
  BAD_TARGET: 'BAD_TARGET',
  BAD_PHONE: 'BAD_PHONE',
  CLAIM_INACTIVE: 'CLAIM_INACTIVE',
  SEND_FAILED: 'SEND_FAILED',
  TIMEOUT: 'TIMEOUT',
  HOST_UNAVAILABLE: 'HOST_UNAVAILABLE',
  HELD: 'HELD',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  NOT_FAKE: 'NOT_FAKE',
  INTERNAL: 'INTERNAL',
});

export const LIMITS = Object.freeze({
  MAX_TEXT: 3500,
  MAX_INBOUND_TEXT: 8192,
  MAX_IMAGE_BYTES: 5242880,
  MAX_IMAGES: 4,
  MAX_READ_IDS: 20,
});

/** Keys that name a WhatsApp recipient. None may appear on send/react/presence/read. */
export const ADDRESS_KEYS = Object.freeze(['jid', 'to', 'remoteJid', 'chat', 'number', 'participant', 'recipient']);

/** Status reactions the bridge may set on an owner message (null clears it). */
export const REACTIONS = Object.freeze({
  seen: '👀',
  queued: '⏳',
  done: '✅',
  failed: '❌',
  stopped: '⏹️',
});

export const MODES = Object.freeze(['self', 'dedicated']);
export const SELF_TRIGGERS = Object.freeze(['all', 'prefix']);
export const DEFAULT_PREFIX = 'sb';

const ADDRESSLESS_OPS = new Set([OP.SEND, OP.REACT, OP.PRESENCE, OP.READ]);
const MSG_ID_RE = /^[A-Za-z0-9._:+/=-]{1,128}$/;
const PREFIX_RE = /^[^\s]{1,16}$/;

// ── Tiny closed-schema checker ──
// A spec is { field: check } where check(value, present) returns an error
// string or null. Fields not in the spec are rejected.

const t = {
  str: (max = 1 << 20) => (v, p) => (!p ? 'is required' : typeof v !== 'string' ? 'must be a string' : v.length > max ? `is longer than ${max}` : null),
  optStr: (max = 1 << 20) => (v, p) => (!p || v === undefined ? null : typeof v !== 'string' ? 'must be a string' : v.length > max ? `is longer than ${max}` : null),
  num: () => (v, p) => (!p ? 'is required' : typeof v !== 'number' || !Number.isFinite(v) ? 'must be a finite number' : null),
  optNum: () => (v, p) => (!p || v === undefined ? null : typeof v !== 'number' || !Number.isFinite(v) ? 'must be a finite number' : null),
  bool: () => (v, p) => (!p ? 'is required' : typeof v !== 'boolean' ? 'must be a boolean' : null),
  optBool: () => (v, p) => (!p || v === undefined ? null : typeof v !== 'boolean' ? 'must be a boolean' : null),
  oneOf: (list) => (v, p) => (!p ? 'is required' : !list.includes(v) ? `must be one of ${list.join('|')}` : null),
  optOneOf: (list) => (v, p) => (!p || v === undefined ? null : !list.includes(v) ? `must be one of ${list.join('|')}` : null),
  obj: (spec) => (v, p) => (!p ? 'is required' : checkObject(v, spec)),
  optObj: (spec) => (v, p) => (!p || v === undefined ? null : checkObject(v, spec)),
  objOrNull: (spec) => (v, p) => (!p ? 'is required' : v === null ? null : checkObject(v, spec)),
  plainObj: () => (v, p) => (!p ? 'is required' : !isPlainObject(v) ? 'must be an object' : null),
  optPlainObj: () => (v, p) => (!p || v === undefined ? null : !isPlainObject(v) ? 'must be an object' : null),
  counts: () => (v, p) => {
    if (!p) return 'is required';
    if (!isPlainObject(v)) return 'must be an object';
    for (const [k, n] of Object.entries(v)) {
      if (!/^[a-z_]{1,40}$/.test(k)) return `has a bad key '${k}'`;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return `.${k} must be a count`;
    }
    return null;
  },
  msgId: () => (v, p) => (!p ? 'is required' : typeof v !== 'string' || !MSG_ID_RE.test(v) ? 'must be a message id' : null),
  any: () => () => null,
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
}

function checkObject(v, spec) {
  if (!isPlainObject(v)) return 'must be an object';
  for (const key of Object.keys(v)) {
    if (!Object.hasOwn(spec, key)) return `has an unknown field '${key}'`;
  }
  for (const [key, check] of Object.entries(spec)) {
    const err = check(v[key], Object.hasOwn(v, key));
    if (err) return `.${key} ${err}`;
  }
  return null;
}

// ── Prefs (configure) ──

const PREFS_SPEC = {
  mode: t.optOneOf(MODES),
  selfTrigger: t.optOneOf(SELF_TRIGGERS),
  prefix: (v, p) => (!p || v === undefined ? null : typeof v !== 'string' || !PREFIX_RE.test(v) ? 'must be 1-16 non-space characters' : null),
};
export const PREF_KEYS = Object.freeze(Object.keys(PREFS_SPEC));

/** Keep only the preference keys the host understands (the service may pass its whole config). */
export function pickPrefs(prefs) {
  const out = {};
  if (!isPlainObject(prefs)) return out;
  for (const key of PREF_KEYS) if (prefs[key] !== undefined) out[key] = prefs[key];
  return out;
}

// ── Ops ──

const LINK_SPEC = {
  method: t.oneOf(['qr', 'code']),
  phone: t.optStr(32),
};

const OP_SPECS = {
  [OP.CONFIGURE]: { prefs: t.obj(PREFS_SPEC) },
  [OP.CONNECT]: { purpose: t.oneOf(['run', 'link']), mode: t.optOneOf(MODES), link: t.optObj(LINK_SPEC) },
  [OP.DISCONNECT]: {},
  [OP.LOGOUT]: {},
  [OP.CONFIRM_OWNER]: { accept: t.bool() },
  [OP.CLAIM_START]: { ttlMs: t.optNum() },
  [OP.CLAIM_CANCEL]: {},
  [OP.OWNER_RESET]: {},
  [OP.SEND]: { text: t.str(LIMITS.MAX_TEXT * 4), replyTo: (v, p) => (!p || v === undefined || v === null ? null : typeof v !== 'string' || !MSG_ID_RE.test(v) ? 'must be a message id' : null) },
  [OP.REACT]: { id: t.msgId(), reaction: (v, p) => (!p ? 'is required' : v === null || Object.hasOwn(REACTIONS, v) ? null : `must be one of ${Object.keys(REACTIONS).join('|')} or null`) },
  [OP.PRESENCE]: { state: t.oneOf(['composing', 'paused']) },
  [OP.READ]: {
    ids: (v, p) => {
      if (!p) return 'is required';
      if (!Array.isArray(v)) return 'must be an array';
      if (v.length > LIMITS.MAX_READ_IDS) return `holds more than ${LIMITS.MAX_READ_IDS} ids`;
      return v.every((id) => typeof id === 'string' && MSG_ID_RE.test(id)) ? null : 'must hold message ids';
    },
  },
  [OP.STATUS]: {},
  [OP.SHUTDOWN]: {},
  [OP.FAKE]: { action: t.str(64), args: t.optPlainObj() },
};

/** @returns {{ok:true} | {ok:false, code:string, message:string}} */
export function validateOp(msg) {
  if (!isPlainObject(msg)) return { ok: false, code: ERR.BAD_REQUEST, message: 'op must be an object' };
  const spec = OP_SPECS[msg.op];
  if (!spec) return { ok: false, code: ERR.UNKNOWN_OP, message: `unknown op '${String(msg.op).slice(0, 40)}'` };
  if (ADDRESSLESS_OPS.has(msg.op)) {
    const found = ADDRESS_KEYS.find((k) => Object.hasOwn(msg, k));
    if (found) return { ok: false, code: ERR.ADDRESS_FORBIDDEN, message: `${msg.op} never takes an address ('${found}')` };
  }
  if (msg.reqId !== undefined && !(Number.isSafeInteger(msg.reqId) && msg.reqId > 0)) {
    return { ok: false, code: ERR.BAD_REQUEST, message: 'reqId must be a positive integer' };
  }
  const { op: _op, reqId: _reqId, ...fields } = msg;
  const err = checkObject(fields, spec);
  return err ? { ok: false, code: ERR.BAD_REQUEST, message: `${msg.op}${err.startsWith('.') ? '' : ' '}${err}` } : { ok: true };
}

// ── Events ──

const MASKED_ME = t.objOrNull({ masked: t.str(64), name: (v, p) => (!p ? 'is required' : v === null || (typeof v === 'string' && v.length <= 100) ? null : 'must be a short string or null') });
const OWNER_INFO = t.objOrNull({ bound: t.bool(), masked: (v, p) => (!p ? 'is required' : v === null || (typeof v === 'string' && v.length <= 64) ? null : 'must be a short string or null') });

export const CONN_SPEC = {
  state: t.oneOf(Object.values(CONN)),
  mode: (v, p) => (!p ? 'is required' : v === null || MODES.includes(v) ? null : 'must be a mode or null'),
  registered: t.bool(),
  me: MASKED_ME,
  owner: OWNER_INFO,
  lastDisconnect: t.objOrNull({ reason: t.str(64), code: (v, p) => (!p ? 'is required' : v === null || Number.isFinite(v) ? null : 'must be a number or null'), at: t.num() }),
  retryInMs: (v, p) => (!p ? 'is required' : v === null || (Number.isFinite(v) && v >= 0) ? null : 'must be a delay or null'),
  counters: t.counts(),
  paused: t.bool(),
  awaitingConfirmUntil: (v, p) => (!p ? 'is required' : v === null || Number.isFinite(v) ? null : 'must be a time or null'),
  claim: t.objOrNull({ active: t.bool(), expiresAt: t.num(), attemptsLeft: t.num() }),
  lastError: (v, p) => (!p ? 'is required' : v === null || (typeof v === 'string' && v.length <= 200) ? null : 'must be a short string or null'),
};

export const RUNTIME_SPEC = {
  loaded: t.bool(),
  version: (v, p) => (!p ? 'is required' : v === null || (typeof v === 'string' && v.length <= 40) ? null : 'must be a version or null'),
  fake: t.bool(),
  error: (v, p) => (!p ? 'is required' : v === null || (typeof v === 'string' && v.length <= 200) ? null : 'must be a short string or null'),
};

const IMAGE_SPEC = { base64: t.str(Math.ceil(LIMITS.MAX_IMAGE_BYTES / 3) * 4 + 4), mediaType: t.oneOf(['image/jpeg', 'image/png', 'image/webp']), bytes: t.num() };

export const INBOUND_SPEC = {
  id: t.msgId(),
  ts: t.num(),
  chat: t.oneOf(['self', 'dm']),
  text: t.str(LIMITS.MAX_INBOUND_TEXT),
  images: (v, p) => {
    if (!p) return 'is required';
    if (!Array.isArray(v)) return 'must be an array';
    if (v.length > LIMITS.MAX_IMAGES) return `holds more than ${LIMITS.MAX_IMAGES} images`;
    for (const img of v) {
      const err = checkObject(img, IMAGE_SPEC);
      if (err) return `[]${err}`;
    }
    return null;
  },
  unsupported: t.objOrNull({ type: t.str(40), reason: t.optStr(40) }),
  forwarded: t.bool(),
  quoted: t.objOrNull({ id: t.msgId(), text: t.str(LIMITS.MAX_INBOUND_TEXT), fromBot: t.bool() }),
  owner: (v, p) => (!p ? 'is required' : v === true ? null : 'must be true'),
  // Delivered after an offline spell (messages.upsert 'append'); `ts` says when it was sent.
  backlog: t.optBool(),
};

const EVENT_SPECS = {
  [EV.READY]: { protocol: t.num(), pid: t.num(), runtime: t.obj(RUNTIME_SPEC), conn: t.obj(CONN_SPEC) },
  [EV.REPLY]: {
    reqId: t.num(),
    ok: t.bool(),
    data: t.any(),
    error: t.optObj({ code: t.str(40), message: t.optStr(500), retryAfterMs: t.optNum() }),
  },
  [EV.STATE]: { conn: t.obj(CONN_SPEC) },
  [EV.QR]: { qr: t.str(4096), expiresAt: t.num() },
  [EV.PAIRING_CODE]: { code: t.str(16), expiresAt: t.num() },
  [EV.LINKED]: { mode: t.oneOf(MODES), me: MASKED_ME },
  [EV.OWNER_BOUND]: { masked: t.str(64), via: t.oneOf(['claim', 'self_confirm']) },
  [EV.INBOUND]: { message: t.obj(INBOUND_SPEC) },
  [EV.IGNORED]: { counts: t.counts() },
  [EV.THROTTLED]: { retryAfterMs: t.num() },
  [EV.FATAL]: { code: t.str(40), message: t.optStr(500) },
  [EV.LOG]: { level: t.oneOf(['debug', 'info', 'warn', 'error']), message: t.str(4000) },
};

/** @returns {{ok:true} | {ok:false, code:string, message:string}} */
export function validateEvent(msg) {
  if (!isPlainObject(msg)) return { ok: false, code: ERR.BAD_REQUEST, message: 'event must be an object' };
  const spec = EVENT_SPECS[msg.t];
  if (!spec) return { ok: false, code: ERR.UNKNOWN_OP, message: `unknown event '${String(msg.t).slice(0, 40)}'` };
  const { t: _t, ...fields } = msg;
  const err = checkObject(fields, spec);
  return err ? { ok: false, code: ERR.BAD_REQUEST, message: `${msg.t}${err.startsWith('.') ? '' : ' '}${err}` } : { ok: true };
}
