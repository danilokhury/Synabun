// Log redaction for the WhatsApp Link. Everything the host or its runtime
// prints passes through redactWa before it reaches a SynaBun log: phone
// numbers, JIDs, QR payloads, pairing/claim codes, the Autonomous "ALLOW 1234"
// answer, key material and the credential shapes the Jev secret gate knows about.
//
// JIDs become `self`, `owner` or `other#<hmac8>`. The HMAC key is random per
// process, so the same stranger keeps one tag inside a log without the tag
// being reversible or comparable across processes. The host tells this module
// who self and owner are (setRedactionContext); the main process never learns
// a JID, so there everything is `other#…`.

import { createHmac, randomBytes } from 'node:crypto';

/**
 * Mirror of CREDENTIAL_PATTERNS in mcp-server/src/services/typesafe-config.ts
 * (tests/whatsapp-redact.test.mjs fails when the two lists drift apart).
 */
export const CREDENTIAL_PATTERNS = [
  { type: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, precise: true },
  { type: 'api-key', re: /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant|or|api)?[-_]?[A-Za-z0-9_-]{16,}/g, precise: true },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, precise: true },
  { type: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, precise: true },
  { type: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, precise: true },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, precise: true },
  { type: 'bearer', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1, precise: false },
  { type: 'secret', re: /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd|token|secret|authorization)\s*["']?\s*[:=]\s*["']?([^\s"',;]{8,})/gi, group: 1, precise: false },
];

const HMAC_KEY = randomBytes(32);
let context = { self: new Set(), owner: new Set() };

const SERVERS = 's\\.whatsapp\\.net|c\\.us|hosted\\.lid|hosted|lid|g\\.us|broadcast|newsletter';
const JID_RE = new RegExp(`(?<![A-Za-z0-9._%+-])([A-Za-z0-9-]{1,64})(?:_\\d{1,3})?(?::\\d{1,4})?@(${SERVERS})(?![A-Za-z0-9.-])`, 'g');
const QR_URL_RE = /https?:\/\/wa\.me\/settings\/linked_devices#[^\s"'<>)\]]+/g;
const QR_REF_RE = /(?<![A-Za-z0-9])\d@[A-Za-z0-9+/=_-]{16,}(?:,[A-Za-z0-9+/=_-]{8,})*/g;
const BUFFER_DUMP_RE = /<Buffer(?: [0-9a-f]{2})*(?: \.\.\. \d+ more bytes?)?>/g;
const TYPED_ARRAY_DUMP_RE = /\b(?:Uint8Array|Buffer|ArrayBuffer)\(\d+\) \[[^\]]*\]/g;
const BYTE_ARRAY_RE = /\[(?:\s*\d{1,3}\s*,){7,}\s*\d{1,3}\s*\]/g;
const CLAIM_CODE_RE = /\bSB-\d{6}\b/gi;
const ALLOW_CODE_RE = /\b(allow)\s+\d{4}\b/gi;
const PAIRING_DASH_RE = /\b[1-9A-HJ-NP-TV-Z]{4}-[1-9A-HJ-NP-TV-Z]{4}\b/g;
const PAIRING_BARE_RE = /\b(?=[1-9A-HJ-NP-TV-Z]{8}\b)(?=[A-Z]*[1-9])(?=[1-9]*[A-Z])[1-9A-HJ-NP-TV-Z]{8}\b/g;
const HEX_RE = /\b[0-9a-fA-F]{24,}\b/g;
const B64_RE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{24,}={0,2}(?![A-Za-z0-9+/=_-])/g;
const NUMBER_RE = /(?<![A-Za-z0-9_#])\+?\(?\d(?:[ .()-]{0,2}\d){6,}(?![A-Za-z0-9_])/g;
const DATE_LIKE_RE = /^\d{4}-\d{2}-\d{2}$|^\d{2}:\d{2}:\d{2}/;

function userKey(user, server) {
  const s = server === 'c.us' ? 's.whatsapp.net' : server === 'hosted' ? 's.whatsapp.net' : server === 'hosted.lid' ? 'lid' : server;
  return `${s}:${user}`;
}

function toKeys(list) {
  const out = new Set();
  for (const jid of list || []) {
    if (typeof jid !== 'string') continue;
    const m = /^([A-Za-z0-9-]{1,64})(?:_\d{1,3})?(?::\d{1,4})?@(.+)$/.exec(jid.trim());
    if (m) out.add(userKey(m[1], m[2]));
  }
  return out;
}

/** The host's own account and the bound owner (JIDs in any form); called whenever either changes. */
export function setRedactionContext({ self = [], owner = [] } = {}) {
  context = { self: toKeys(self), owner: toKeys(owner) };
}

export function tagFor(user, server) {
  const key = userKey(user, server);
  if (context.self.has(key)) return 'self';
  if (context.owner.has(key)) return 'owner';
  return `other#${createHmac('sha256', HMAC_KEY).update(key).digest('hex').slice(0, 8)}`;
}

function redactCredentials(text) {
  const spans = [];
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      const whole = match[0];
      const secret = pattern.group ? match[pattern.group] : whole;
      if (!secret) continue;
      const start = (match.index ?? 0) + (pattern.group ? whole.indexOf(secret) : 0);
      spans.push({ start, end: start + secret.length, type: pattern.type });
    }
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start) + `[redacted:${span.type}]`;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

function looksLikeKey(run) {
  if (/[+=]/.test(run)) return /\d/.test(run) || run.length >= 32;
  return /\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run);
}

/** Redact one log line / message. Accepts anything; always returns a string. */
export function redactWa(value) {
  let text;
  if (typeof value === 'string') text = value;
  else if (value instanceof Error) text = `${value.name}: ${value.message}`;
  else {
    try { text = String(value); } catch { text = '[unprintable]'; }
  }
  if (!text) return '';
  text = redactCredentials(text);
  text = text.replace(QR_URL_RE, '[qr]').replace(QR_REF_RE, '[qr]');
  text = text.replace(BUFFER_DUMP_RE, '[buffer]').replace(TYPED_ARRAY_DUMP_RE, '[bytes]').replace(BYTE_ARRAY_RE, '[bytes]');
  text = text.replace(JID_RE, (_m, user, server) => tagFor(user, server));
  text = text.replace(ALLOW_CODE_RE, (_m, word) => `${word} [code]`);
  text = text.replace(CLAIM_CODE_RE, '[code]').replace(PAIRING_DASH_RE, '[code]').replace(PAIRING_BARE_RE, '[code]');
  text = text.replace(HEX_RE, '[key]').replace(B64_RE, (run) => (looksLikeKey(run) ? '[key]' : run));
  text = text.replace(NUMBER_RE, (run) => (DATE_LIKE_RE.test(run) ? run : '[number]'));
  return text;
}

/**
 * A local file path for the send_file audit line and its Activity row: credentials, QR payloads,
 * JIDs, codes and phone numbers are redacted as in redactWa, but not the key-shape heuristics
 * (HEX_RE, B64_RE), which read most real paths (`/Users/<you>/App2/…`, a run id folder) as key
 * material and would leave nothing of the path to audit. Paths only: never for message text.
 */
export function redactFilePath(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  if (!text) return '';
  text = redactCredentials(text);
  text = text.replace(QR_URL_RE, '[qr]').replace(QR_REF_RE, '[qr]');
  text = text.replace(JID_RE, (_m, user, server) => tagFor(user, server));
  text = text.replace(ALLOW_CODE_RE, (_m, word) => `${word} [code]`);
  text = text.replace(CLAIM_CODE_RE, '[code]').replace(PAIRING_DASH_RE, '[code]');
  text = text.replace(NUMBER_RE, (run) => (DATE_LIKE_RE.test(run) ? run : '[number]'));
  return text.slice(0, 2048);
}

// A run of key-shaped characters inside a path, between separators, dashes, underscores, dots and spaces.
const PATH_KEY_RUN_RE = /[A-Za-z0-9+=]{24,}/g;

/**
 * A path the Assistant asked for and SynaBun refused (its Activity row): redactFilePath, and any run of
 * 24 or more hex or key-shaped characters between the path's separators, dashes, underscores, dots and
 * spaces masked too, because the text came from the model and need not name a file at all. Ordinary
 * names stay readable (their words are short); a real file's canonical path keeps redactFilePath alone.
 */
export function redactRequestedPath(value) {
  return redactFilePath(value).replace(PATH_KEY_RUN_RE, (run) => (/^[0-9a-fA-F]+$/.test(run) || looksLikeKey(run) ? '[key]' : run));
}

const FILE_AUDIT_PREFIX = '[whatsapp] file send ';
const FILE_AUDIT_TYPES = new Set(['document', 'image', 'video', 'audio']);
const MASKED_CHAT_RE = /^(?:••••|••\d{2}|••••\d{4}|linked id ••[A-Za-z0-9]{0,2})$/;

/**
 * The send_file audit line (host-core.js noteFileSend), checked field by field: exactly
 * { path, size, chat, type } with a masked chat and a known form, the path through
 * redactFilePath. → the line, or null for anything else (which gets redactWa like every log line).
 */
export function fileAuditLine(message) {
  const text = typeof message === 'string' ? message : '';
  if (!text.startsWith(FILE_AUDIT_PREFIX)) return null;
  let entry;
  try { entry = JSON.parse(text.slice(FILE_AUDIT_PREFIX.length)); } catch { return null; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const keys = Object.keys(entry);
  if (keys.length !== 4 || keys.join(',') !== 'path,size,chat,type') return null;
  if (typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.chat !== 'string' || !MASKED_CHAT_RE.test(entry.chat) || !FILE_AUDIT_TYPES.has(entry.type)) return null;
  return `${FILE_AUDIT_PREFIX}${JSON.stringify({ path: redactFilePath(entry.path), size: entry.size, chat: entry.chat, type: entry.type })}`;
}

/**
 * One log line on its way to SynaBun's log (manager.js, service.js): redactWa, except a send_file
 * audit line (after the host's "[whatsapp-host] " tag or not), which fileAuditLine checks and keeps.
 */
export function redactLogLine(message) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  const tag = text.startsWith('[whatsapp-host] ') ? '[whatsapp-host] ' : '';
  const audit = fileAuditLine(text.slice(tag.length));
  return audit ? `${tag}${audit}` : redactWa(text);
}

/** A phone number for display: never more than the last four digits. */
export function maskNumber(digits) {
  const d = String(digits ?? '').replace(/\D/g, '');
  if (d.length >= 8) return `••••${d.slice(-4)}`;
  if (d.length >= 5) return `••${d.slice(-2)}`;
  return '••••';
}
