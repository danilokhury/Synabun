// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link config: kv_config `whatsapp_config`
// ═══════════════════════════════════════════
//
// Knobs are data: one JSON row re-read with a short TTL, so a change from
// Settings → WhatsApp (or from the bridge, a phone command, another process)
// applies within seconds without a restart. get/set of the kv row are
// injected so tests never touch the live database.
//
// Two kinds of fields:
//   user     what Settings edits (update(), validated, versioned: a stale
//            expectedVersion is a 409 like lib/assistant-config.js)
//   service  what SynaBun owns (mode, the conversation, the bound owner, the
//            autonomous window, pause) — written by the service and the
//            bridge through write(), refused in update().
// Raising the level to 'autonomous' never applies here: update() needs
// confirmEscalation and answers {pending:true}; the service applies it after
// the phone answers "ALLOW <code>". Lowering applies at once.
// `computerUse` is the owner's switch for controlling this Mac from a
// WhatsApp conversation: off by default, a plain boolean, changed only through
// update() (Settings on this computer: the guarded PUT /api/whatsapp/config).
// No phone command and no service path writes it; what it allows at each level
// is lib/remote-policy.js remoteComputerUse.
// `brain` is which model runs the WhatsApp conversation: null (same as the
// Assistant) or { provider, model, effort }. Its shape is checked here; the
// service checks the model and the effort against the Assistant's catalog
// before it calls update() (lib/whatsapp/brain.js).

import { LEVELS } from '../remote-policy.js';
import { cleanBrainChoice } from './brain.js';

export const WHATSAPP_CONFIG_KEY = 'whatsapp_config';

export const USER_DEFAULTS = Object.freeze({
  enabled: false,
  level: 'ask',
  progress: 'key',
  forwardBackground: true,
  replyLabel: null,
  maxMessages: 3,
  rotation: 'idle6h',
  selfTrigger: 'all',
  activityText: false,
  strictWorkerApprovals: false,
  computerUse: false,
  brain: null,
});

export const SERVICE_DEFAULTS = Object.freeze({
  mode: 'self',
  sessionId: null,
  previousSessionIds: Object.freeze([]),
  owner: null,              // { masked, boundAt, via } — never a number
  autonomousUntil: null,    // epoch ms while an autonomous window is open
  paused: false,
  pausedBy: null,           // 'desktop' | 'phone'
  version: 0,
});

export const USER_FIELDS = Object.freeze(Object.keys(USER_DEFAULTS));
export const SERVICE_FIELDS = Object.freeze(Object.keys(SERVICE_DEFAULTS));
/** Service-side state that is not a setting (the bridge's restart bookkeeping, the setup intent). */
const INTERNAL_FIELDS = Object.freeze(['bridgeState', 'setup']);

export const PROGRESS = Object.freeze(['off', 'key', 'all']);
export const MAX_MESSAGES = Object.freeze([1, 3, 5]);
export const ROTATIONS = Object.freeze(['idle6h', 'daily', 'never']);
export const SELF_TRIGGERS = Object.freeze(['all', 'prefix']);
export const MODES = Object.freeze(['self', 'dedicated']);
export const REPLY_LABEL_MAX = 24;

const RANK = Object.freeze({ 'read-only': 0, ask: 1, autonomous: 2 });

function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

function configError(field, message, { code = 'CONFIG_INVALID', status = 400 } = {}) {
  const error = new Error(message);
  error.code = code;
  error.field = field;
  error.status = status;
  return error;
}

/** A reply label: printable, one line, 1-24 characters; '' → null (the mode's default label). */
function cleanLabel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const label = value.normalize('NFC').trim();
  if (!label) return null;
  if (label.length > REPLY_LABEL_MAX || /[\u0000-\u001f\u007f\u2028\u2029]/.test(label)) return undefined;
  return label;
}

const CHECKS = {
  enabled: (v) => typeof v === 'boolean',
  level: (v) => LEVELS.includes(v),
  progress: (v) => PROGRESS.includes(v),
  forwardBackground: (v) => typeof v === 'boolean',
  maxMessages: (v) => MAX_MESSAGES.includes(v),
  rotation: (v) => ROTATIONS.includes(v),
  selfTrigger: (v) => SELF_TRIGGERS.includes(v),
  activityText: (v) => typeof v === 'boolean',
  strictWorkerApprovals: (v) => typeof v === 'boolean',
  computerUse: (v) => typeof v === 'boolean',
};
const MESSAGES = {
  enabled: 'enabled must be true or false',
  level: `level must be one of ${LEVELS.join(', ')}`,
  progress: `progress must be one of ${PROGRESS.join(', ')}`,
  forwardBackground: 'forwardBackground must be true or false',
  replyLabel: `replyLabel must be one line of at most ${REPLY_LABEL_MAX} characters, or empty for the default`,
  maxMessages: `maxMessages must be one of ${MAX_MESSAGES.join(', ')}`,
  rotation: `rotation must be one of ${ROTATIONS.join(', ')}`,
  selfTrigger: `selfTrigger must be one of ${SELF_TRIGGERS.join(', ')}`,
  activityText: 'activityText must be true or false',
  strictWorkerApprovals: 'strictWorkerApprovals must be true or false',
  computerUse: 'computerUse must be true or false',
  brain: 'brain must be null (same as the Assistant) or { provider, model, effort } with a provider of claude-code, codex or opencode',
};

/** Validate a user patch (Settings fields only). → the cleaned patch; throws 400 CONFIG_INVALID {field}. */
export function validateConfigPatch(patch = {}) {
  if (!isPlainObject(patch)) throw configError('config', 'config must be an object');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (SERVICE_FIELDS.includes(key) || INTERNAL_FIELDS.includes(key)) throw configError(key, `"${key}" is managed by SynaBun and cannot be set here`);
    if (!USER_FIELDS.includes(key)) throw configError(key, `Unknown WhatsApp setting "${key}"`);
    if (key === 'replyLabel') {
      const label = cleanLabel(value);
      if (label === undefined) throw configError(key, MESSAGES.replyLabel);
      out.replyLabel = label;
      continue;
    }
    if (key === 'brain') {
      const brain = cleanBrainChoice(value);
      if (brain === undefined) throw configError(key, MESSAGES.brain);
      out.brain = brain;
      continue;
    }
    if (!CHECKS[key](value)) throw configError(key, MESSAGES[key]);
    out[key] = value;
  }
  return out;
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanOwner(value) {
  if (!isPlainObject(value)) return null;
  const masked = typeof value.masked === 'string' ? value.masked.slice(0, 32) : null;
  if (!masked) return null;
  return { masked, boundAt: toMs(value.boundAt), via: value.via === 'claim' ? 'claim' : 'self_confirm' };
}

/** Defaults + stored values; a bad stored value falls back to its default, field by field. */
export function effectiveConfig(stored = {}) {
  const raw = isPlainObject(stored) ? stored : {};
  const out = {};
  for (const key of USER_FIELDS) {
    if (key === 'replyLabel') { const label = cleanLabel(raw.replyLabel); out.replyLabel = label === undefined ? null : label; continue; }
    if (key === 'brain') { const brain = cleanBrainChoice(raw.brain); out.brain = brain === undefined ? null : brain; continue; }
    out[key] = raw[key] !== undefined && CHECKS[key](raw[key]) ? raw[key] : USER_DEFAULTS[key];
  }
  out.mode = MODES.includes(raw.mode) ? raw.mode : SERVICE_DEFAULTS.mode;
  out.sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId.slice(0, 200) : null;
  out.previousSessionIds = Array.isArray(raw.previousSessionIds)
    ? raw.previousSessionIds.map((id) => (typeof id === 'string' ? id : id?.id)).filter((id) => typeof id === 'string' && id).slice(0, 10)
    : [];
  out.owner = cleanOwner(raw.owner);
  out.autonomousUntil = toMs(raw.autonomousUntil);
  out.paused = raw.paused === true;
  out.pausedBy = out.paused && (raw.pausedBy === 'desktop' || raw.pausedBy === 'phone') ? raw.pausedBy : null;
  out.version = Number.isSafeInteger(raw.version) && raw.version >= 0 ? raw.version : 0;
  if (isPlainObject(raw.bridgeState)) out.bridgeState = raw.bridgeState;
  if (isPlainObject(raw.setup)) out.setup = raw.setup;
  return out;
}

/** 'autonomous' only while its window is open; an expired window reads as 'ask'. */
export function currentLevel(config, now = Date.now()) {
  if (config?.level !== 'autonomous') return LEVELS.includes(config?.level) ? config.level : 'ask';
  return toMs(config.autonomousUntil) > now ? 'autonomous' : 'ask';
}

/**
 * @param {object} deps
 * @param {(key:string)=>string|null} deps.get   getKvConfig
 * @param {(key:string, value:string)=>void} deps.set  setKvConfig
 */
export function createWhatsAppConfigStore({ get, set, ttlMs = 3000, now = Date.now, log = () => {} } = {}) {
  let cache = null; // { at, value }

  function readStored() {
    if (typeof get !== 'function') return {};
    let raw = null;
    try { raw = get(WHATSAPP_CONFIG_KEY); } catch (error) { log('whatsapp:config-unreadable', error?.message || String(error)); return {}; }
    if (!raw) return {};
    try {
      const value = JSON.parse(raw);
      return isPlainObject(value) ? value : {};
    } catch (error) {
      log('whatsapp:config-corrupt', error?.message || String(error));
      return {};
    }
  }
  function persist(value) {
    if (typeof set === 'function') set(WHATSAPP_CONFIG_KEY, JSON.stringify(value));
    cache = null;
  }
  function read() {
    if (cache && now() - cache.at < ttlMs) return cache.value;
    const value = effectiveConfig(readStored());
    cache = { at: now(), value };
    return value;
  }

  /**
   * Service-owned write: service fields, internal state and user fields the
   * service decides (the confirmed autonomous level, its expiry). A change to
   * a user field bumps the version so an open Settings tab reloads first.
   */
  function write(patch = {}) {
    if (!isPlainObject(patch)) return read();
    const stored = readStored();
    const before = effectiveConfig(stored);
    const next = { ...stored };
    let userChanged = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!USER_FIELDS.includes(key) && !SERVICE_FIELDS.includes(key) && !INTERNAL_FIELDS.includes(key)) {
        log('whatsapp:config-ignored', `unknown field ${key}`);
        continue;
      }
      if (key === 'version') continue;
      // Computer use is turned on by the person at this computer only (update()); the service may only turn it off.
      if (key === 'computerUse' && value !== false) { log('whatsapp:config-ignored', 'computerUse is turned on in Settings only'); continue; }
      next[key] = value;
      if (USER_FIELDS.includes(key) && JSON.stringify(effectiveConfig(next)[key]) !== JSON.stringify(before[key])) userChanged = true;
    }
    if (userChanged) next.version = before.version + 1;
    persist(next);
    return read();
  }

  /**
   * User-facing write (Settings). → { config, version, pending }.
   * pending: the patch asked for 'autonomous'; everything else applied, the
   * level waits for the phone (the service holds the escalation).
   */
  function update(patch = {}, { expectedVersion = null, confirmEscalation = false } = {}) {
    const clean = validateConfigPatch(patch);
    const stored = readStored();
    const current = effectiveConfig(stored);
    if (expectedVersion !== null && expectedVersion !== undefined && Number(expectedVersion) !== current.version) {
      const error = configError('version', 'WhatsApp settings changed elsewhere; reload and try again.', { code: 'VERSION_CONFLICT', status: 409 });
      error.version = current.version;
      throw error;
    }
    let pending = false;
    if (clean.level !== undefined) {
      const effective = currentLevel(current, now());
      if (clean.level === 'autonomous') {
        if (effective !== 'autonomous') {
          if (confirmEscalation !== true) throw configError('level', 'Autonomous needs a second confirmation on this computer, then an ALLOW code from your phone.', { code: 'CONFIRM_REQUIRED' });
          pending = true;
        }
        delete clean.level;
      } else if (RANK[clean.level] < RANK[effective] || clean.level !== current.level) {
        // Lowering (or leaving an expired autonomous) applies at once and closes the window.
        clean.autonomousUntil = null;
      }
    }
    const next = { ...stored, ...clean };
    const changed = USER_FIELDS.some((key) => JSON.stringify(effectiveConfig(next)[key]) !== JSON.stringify(current[key]));
    if (changed) {
      next.version = current.version + 1;
      persist(next);
    }
    const config = read();
    return { config, version: config.version, pending };
  }

  function invalidate() { cache = null; }

  return { read, write, update, invalidate };
}
