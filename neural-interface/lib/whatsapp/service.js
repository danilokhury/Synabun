// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link service (the composition root)
// ═══════════════════════════════════════════
//
// Builds and wires the pieces: the config store (kv `whatsapp_config`), the
// connector installer and the host manager (Package A), the bridge to the
// Assistant (Package B) over a transport adapter on the manager, and the
// /api/whatsapp router (api.js). Nothing here loads Baileys or knows a phone
// number: the host (a forked child) owns both.
//
// The Settings tab reads one state machine:
//   unavailable | not_installed | installing | install_failed | ready |
//   linking (method qr|code; phase starting|waiting|scanned) | link_expired |
//   confirm_owner (kind self|code) | connected | reconnecting | paused |
//   logged_out (reason removed|inactive|banned) | error (code)
//
// Secrets keep to one path each: a link QR or pairing code only goes down the
// NDJSON response of the tab that asked for it, the claim code and wa.me link
// only down the claim stream, the ALLOW code only in the PUT /config answer.
// Broadcasts go through toSyncPayload() alone: states and counters, never a
// QR, SVG, code, number, name or message text. The activity log (a memory
// ring + DATA_HOME/data/logs/whatsapp-YYYYMMDD.log, 0600, 7 days) passes
// everything through redactWa and keeps message text only while
// `activityText` is on.

import { randomInt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createWhatsAppApi } from './api.js';
import { brainChoiceView, checkBrainChoice, cleanBrainChoice } from './brain.js';
import { createWhatsAppBridge, outboxPlan } from './bridge.js';
import { parseCommand } from './commands.js';
import { createWhatsAppConfigStore, currentLevel, MODES, SERVICE_DEFAULTS, USER_DEFAULTS, USER_FIELDS } from './config.js';
import { chunk, toWhatsApp } from './format.js';
import { composePrompt, createCoalescer } from './inbound.js';
import { createWhatsAppInstaller, NPM_CI_ARGS } from './installer.js';
import { createWhatsAppManager } from './manager.js';
import { isInside, resolveWhatsAppPaths } from './paths.js';
import { renderQrSvg } from './qr-svg.js';
import { maskNumber, redactWa } from './redact.js';
import { providerLabel, remoteBrainLimited, remoteBrainNotice } from '../remote-policy.js';
import { normalizePhone, PHONE_ERRORS } from '../../public/shared/whatsapp/wa-phone.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SERVICE_LIMITS = Object.freeze({
  linkTimeoutMs: 5 * MINUTE,     // a link stream gives up after this
  claimTtlMs: 10 * MINUTE,       // a dedicated-mode claim code lives this long
  escalationMs: 5 * MINUTE,      // the phone has this long to answer ALLOW <code>
  escalationTries: 3,
  escalationEchoMs: 10 * MINUTE, // a late ALLOW after this is passed on as text
  autonomousMs: 8 * HOUR,
  testEveryMs: 20_000,
  activityMax: 200,
  logRetentionDays: 7,
  broadcastDebounceMs: 150,
  inactiveAfterMs: 13 * DAY,     // logged out after this long without a connection reads as "inactive"
});

export const TEST_MESSAGE = 'SynaBun test message. If you can read this, WhatsApp is working.';

const STATES = Object.freeze(['unavailable', 'not_installed', 'installing', 'install_failed', 'ready', 'linking', 'link_expired', 'confirm_owner', 'connected', 'reconnecting', 'paused', 'logged_out', 'error']);
export const TAB_STATES = STATES;

const globalTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

/** An error the API answers as {ok:false, code, error, field?} with `status`. */
export function whatsappError(status, code, message, field) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (field) error.field = field;
  return error;
}

const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const pick = (obj, keys) => Object.fromEntries(keys.map((key) => [key, obj[key]]));
/** "ABCD1234" → "ABCD-1234" (how WhatsApp shows a pairing code). */
export function formatPairingCode(code) {
  const clean = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/**
 * @param {object} deps
 * @param {string} deps.dataHome
 * @param {number|()=>number} deps.port              the Neural Interface port (Host/Origin guards)
 * @param {() => object|null} deps.getRuntime        the Assistant runtime
 * @param {() => object|null} [deps.getDispatcher]
 * @param {(key:string)=>string|null} deps.getKvConfig
 * @param {(key:string, value:string)=>void} deps.setKvConfig
 * @param {(message:object)=>void} [deps.broadcastSync]
 * @param {(req)=>boolean} [deps.isGuestRequest]
 * @param {Function} [deps.managerFactory]    (opts) → createWhatsAppManager-shaped object
 * @param {Function} [deps.installerFactory]  (opts) → createWhatsAppInstaller-shaped object
 * @param {Function} [deps.bridgeFactory]     (deps) → createWhatsAppBridge-shaped object
 * @param {() => object|null} [deps.getDefaultBrain]  the Assistant panel's brain ("Same as the Assistant")
 * @param {() => object|null} [deps.getCatalog]       the Assistant's model catalog ({ peek(), full() }): the WhatsApp brain is checked against it
 */
export function createWhatsAppService({
  dataHome,
  port = 3344,
  getRuntime = () => null,
  getDispatcher = () => null,
  getKvConfig,
  setKvConfig,
  broadcastSync = () => {},
  isGuestRequest = () => false,
  log = () => {},
  managerFactory = (opts) => createWhatsAppManager(opts),
  installerFactory = (opts) => createWhatsAppInstaller(opts),
  bridgeFactory = (deps) => createWhatsAppBridge(deps),
  // { issue, revoke } of the phone's authority (lib/remote-policy.js createPhoneAuthority), from the composition root.
  phoneAuthority = null,
  env = process.env,
  platform = process.platform,
  paths: pathsOverride = null,
  // Folders a backup copies besides DATA_HOME/data and mcp-data (server.js' additional entries).
  extraBackupRoots = [],
  policy = undefined,
  getDefaultBrain = null,
  getCatalog = null,
  rng = undefined,
  bridgeLimits = undefined,
  now = Date.now,
  timers = globalTimers,
  limits: limitOverrides = {},
} = {}) {
  if (typeof dataHome !== 'string' || !dataHome) throw new TypeError('createWhatsAppService requires dataHome');
  const L = { ...SERVICE_LIMITS, ...(limitOverrides || {}) };
  const T = { ...globalTimers, ...(timers || {}) };
  const disabled = String(env.SYNABUN_WHATSAPP || '').trim().toLowerCase() === 'off';
  const fake = env.SYNABUN_WHATSAPP_FAKE === '1';
  const paths = pathsOverride || resolveWhatsAppPaths({ dataHome, env, platform, extraBackupRoots });
  const say = (message, level = 'info') => { try { log(`[whatsapp] ${redactWa(message)}`, level); } catch {} };
  // A refused SYNABUN_WHATSAPP_HOME (inside a backed-up folder) says so once, in the server log.
  for (const warning of paths.warnings || []) say(warning, 'warn');

  const config = createWhatsAppConfigStore({ get: getKvConfig, set: setKvConfig, now, log: (tag, msg) => say(`${tag}: ${msg}`, 'warn') });
  const installer = disabled ? null : installerFactory({ dataHome, paths, env, platform, log: (msg, level) => say(msg, level), now });
  const manager = disabled ? null : managerFactory({ dataHome, paths, env, platform, log: (msg, level) => say(msg, level), now });

  const state = {
    started: false,
    stopping: false,
    install: null,          // { controller, stage, startedAt, update }
    installError: null,     // { code, message, at }
    installCache: null,     // { at, value }
    link: null,             // { method, phase, shown, stream, timer }
    linkOutcome: null,      // { state:'link_expired', at } while nothing is linked
    claim: null,            // { stream, attemptsLeft }
    fatal: null,            // { code, message, at }
    escalation: null,       // { code, expiresAt, attemptsLeft, timer }
    escalationEndedAt: 0,
    autonomousTimer: null,
    retentionTimer: null,
    lastConn: null,         // last conn snapshot (for transitions)
    lastStateAt: 0,
    connectedAt: 0,
    reconnectAttempt: 0,
    wasConnected: false,
    testAt: 0,
    notesSkipped: 0,        // self-chat notes without the "sb" trigger (never logged)
    bridge: null,
    rev: 0,
    lastSignature: '',
    broadcastTimer: null,
    logFile: null,
    offs: [],
  };
  const activity = [];

  // ── small readers ──────────────────────────────────────────────────────────
  function installerStatus() {
    if (!installer) return { installed: false, version: null, pinned: null, outdated: false, path: null, installedAt: null, approxSizeMB: null };
    if (state.installCache && now() - state.installCache.at < 2000) return state.installCache.value;
    let value;
    try { value = installer.status(); } catch (error) { value = { installed: false, version: null, pinned: null, outdated: false, error: error?.message }; }
    state.installCache = { at: now(), value };
    return value;
  }
  function managerStatus() {
    const empty = { host: { state: 'stopped', pid: null, restarts: 0, lastError: null }, conn: { state: 'idle', mode: null, registered: false, me: null, owner: null, lastDisconnect: null, retryInMs: null, counters: {}, paused: false, awaitingConfirmUntil: null, claim: null, lastError: null }, runtime: { loaded: false, version: null, fake: false, error: null } };
    if (!manager) return empty;
    try { const s = manager.status(); return { host: { ...empty.host, ...(s?.host || {}) }, conn: { ...empty.conn, ...(s?.conn || {}) }, runtime: { ...empty.runtime, ...(s?.runtime || {}) } }; }
    catch { return empty; }
  }
  const hostRunning = () => ['starting', 'running', 'backoff'].includes(managerStatus().host.state);
  const connectedNow = () => managerStatus().conn.state === 'open';
  /** A device is linked (the host says so, or the config remembers a link this process has not seen yet). */
  function isLinked(cfg = config.read(), conn = managerStatus().conn) {
    if (conn.registered === true && !['unlinked', 'logged_out', 'link_expired'].includes(conn.state)) return true;
    if (['unlinked', 'logged_out', 'forbidden', 'link_expired'].includes(conn.state) && state.lastConn) return false;
    return !!cfg.owner || !!cfg.setup?.linkedAt;
  }
  // The host's own "sb" filter stays off (selfTrigger 'all'): it would drop /stop,
  // /status and card answers too. selfTrigger 'prefix' is applied here (applyTrigger).
  function prefsOf(cfg) { return { mode: cfg.mode, selfTrigger: 'all' }; }
  function configureHost(cfg = config.read()) {
    if (!manager) return;
    Promise.resolve(manager.configure?.(prefsOf(cfg))).catch(() => {});
  }
  function replyPrefix(cfg = config.read()) {
    if (cfg.replyLabel) return cfg.replyLabel;
    return cfg.mode === 'dedicated' ? '' : 'SynaBun:';
  }

  // ── the tab's state machine ────────────────────────────────────────────────
  function logoutReason(cfg) {
    const last = Math.max(state.connectedAt || 0, Number(cfg.setup?.connectedAt) || 0);
    return last && now() - last > L.inactiveAfterMs ? 'inactive' : 'removed';
  }
  function errorCodeOf(conn) {
    if (state.fatal?.code && state.fatal.code !== 'LOGGED_OUT') return state.fatal.code;
    const reason = String(conn.lastError || '');
    if (reason === 'reconnect_limit') return 'RECONNECT_LIMIT';
    if (reason === 'pairing_code_failed') return 'PAIRING_FAILED';
    return 'SESSION_ERROR';
  }
  function tabState() {
    if (disabled) return { state: 'unavailable', reason: 'env' };
    if (state.install) return { state: 'installing', stage: state.install.stage || 'checking' };
    const inst = installerStatus();
    if (!inst.installed) return state.installError ? { state: 'install_failed', code: state.installError.code } : { state: 'not_installed' };
    if (state.link) return { state: 'linking', method: state.link.method, phase: state.link.phase };
    const cfg = config.read();
    const { host, conn } = managerStatus();
    if (host.state === 'held') return { state: 'error', code: 'HOST_HELD' };
    if (conn.paused === true && conn.state === 'open') return { state: 'error', code: 'OWNER_ANOMALY' };
    switch (conn.state) {
      case 'link_expired': return { state: 'link_expired' };
      case 'awaiting_confirm': return { state: 'confirm_owner', kind: 'self' };
      case 'open':
        if (cfg.mode === 'dedicated' && !conn.owner?.bound) return { state: 'confirm_owner', kind: 'code' };
        if (cfg.paused || !cfg.enabled) return { state: 'paused' };
        return { state: 'connected' };
      case 'connecting':
      case 'reconnecting':
        return { state: 'reconnecting' };
      case 'logged_out': return { state: 'logged_out', reason: cfg.setup?.lastEnd?.reason || logoutReason(cfg) };
      case 'forbidden': return { state: 'logged_out', reason: 'banned' };
      case 'replaced': return { state: 'error', code: 'REPLACED' };
      case 'locked': return { state: 'error', code: 'LOCKED' };
      case 'error': return { state: 'error', code: errorCodeOf(conn) };
      default: break;
    }
    if (isLinked(cfg, conn)) {
      if (!cfg.enabled || cfg.paused) return { state: 'paused' };
      if (state.fatal && !hostRunning()) return { state: 'error', code: state.fatal.code };
      return { state: 'reconnecting' };
    }
    if (state.linkOutcome?.state === 'link_expired') return { state: 'link_expired' };
    const end = cfg.setup?.lastEnd;
    if (end?.state === 'logged_out') return { state: 'logged_out', reason: end.reason };
    return { state: 'ready' };
  }

  // ── broadcasts ─────────────────────────────────────────────────────────────
  /** The only thing that ever leaves through broadcastSync. */
  function toSyncPayload() {
    const cfg = config.read();
    const tab = tabState();
    const inst = installerStatus();
    const conn = managerStatus().conn;
    const level = currentLevel(cfg, now());
    const counters = {};
    for (const [key, value] of Object.entries(conn.counters || {})) if (Number.isFinite(value)) counters[key] = value;
    return {
      type: 'whatsapp:status',
      v: 1,
      state: tab.state,
      phase: tab.phase || null,
      mode: cfg.mode,
      level,
      levelExpiresAt: level === 'autonomous' ? cfg.autonomousUntil : null,
      paused: cfg.paused,
      pausedBy: cfg.pausedBy,
      // The owner's switch for computer use from WhatsApp (what it allows per level: remoteComputerUse).
      computerUse: cfg.computerUse === true,
      // Which brain runs the WhatsApp conversation: null = same as the Assistant.
      brain: cfg.brain ? { provider: cfg.brain.provider, model: cfg.brain.model, effort: cfg.brain.effort || null } : null,
      rev: state.rev,
      connector: { installed: !!inst.installed, stage: state.install?.stage || null, updateAvailable: !!inst.outdated, errorCode: state.installError?.code || null },
      counters,
    };
  }
  function flushBroadcast() {
    state.broadcastTimer = null;
    if (state.stopping) return;
    const payload = toSyncPayload();
    const { rev: _rev, ...rest } = payload;
    const signature = JSON.stringify(rest);
    if (signature === state.lastSignature) return;
    state.lastSignature = signature;
    state.rev += 1;
    payload.rev = state.rev;
    try { broadcastSync(payload); } catch (error) { say(`broadcast failed: ${error?.message || error}`, 'warn'); }
  }
  function notify() {
    if (state.broadcastTimer || state.stopping) return;
    state.broadcastTimer = T.setTimeout(flushBroadcast, L.broadcastDebounceMs);
    state.broadcastTimer?.unref?.();
  }

  // ── activity log ───────────────────────────────────────────────────────────
  function appendLogLine(entry) {
    try {
      mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
      const file = path.join(paths.logsDir, `whatsapp-${ymd(entry.at)}.log`);
      const text = entry.text ? ` | ${entry.text.replace(/\r?\n/g, ' ⏎ ')}` : '';
      appendFileSync(file, `${new Date(entry.at).toISOString()} ${entry.kind} ${entry.detail}${text}\n`, { mode: 0o600 });
      if (state.logFile !== file) { state.logFile = file; try { chmodSync(file, 0o600); } catch {} }
    } catch {}
  }
  /** One activity row. `text` (a message body) is kept only while activityText is on. */
  function record(kind, detail, text = null) {
    const entry = { at: now(), kind, detail: redactWa(String(detail || '')).slice(0, 300) };
    if (text && config.read().activityText) entry.text = redactWa(String(text)).slice(0, 2000);
    activity.push(entry);
    if (activity.length > L.activityMax) activity.splice(0, activity.length - L.activityMax);
    appendLogLine(entry);
    return entry;
  }
  function logFiles() {
    try { return readdirSync(paths.logsDir).filter((name) => /^whatsapp-\d{8}\.log$/.test(name)); } catch { return []; }
  }
  function pruneLogs() {
    const cutoff = ymd(now() - L.logRetentionDays * DAY);
    for (const name of logFiles()) {
      if (name.slice(9, 17) < cutoff) { try { unlinkSync(path.join(paths.logsDir, name)); } catch {} }
    }
  }
  function describeInbound(message) {
    const parts = [];
    if (String(message.text || '').trim()) parts.push('text');
    const images = Array.isArray(message.images) ? message.images.length : 0;
    if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`);
    if (message.unsupported) parts.push(`${String(message.unsupported.type || 'unsupported')} (not supported)`);
    const flags = [message.forwarded ? 'forwarded' : null, message.quoted ? (message.quoted.fromBot ? 'reply to SynaBun' : 'quote') : null].filter(Boolean);
    return `Message from you: ${parts.join(', ') || 'empty'}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  }

  // ── transport + bridge ─────────────────────────────────────────────────────
  // Why a refused reply was dropped (the bridge's outboxPlan decides; the phone cannot be told).
  const DROPPED_BECAUSE = {
    PAUSED: 'sending is paused because the owner looked different than expected. See Setup & link',
    HELD: 'the WhatsApp connector kept crashing and was stopped. Press Reconnect',
  };
  const transport = {
    send: async (text, opts = {}) => {
      const result = await manager.send(text, opts);
      if (result?.ok) record('reply', `Sent a message (${String(text).length} characters)`, text);
      else {
        const code = String(result?.code || 'unknown');
        const plan = outboxPlan(code);
        // THROTTLED: the throttled event already says when sending resumes.
        if (plan === 'connect') record('state', `A reply waits until WhatsApp is back (${code})`);
        else if (plan === 'drop') record('error', `A reply was dropped: ${DROPPED_BECAUSE[code] || 'WhatsApp refused it'} (${code})`);
      }
      notify();
      return result;
    },
    react: (id, name) => manager.react(id, name),
    presence: (value) => manager.presence(value),
    markRead: (ids) => manager.markRead(ids),
    connected: () => connectedNow(),
  };
  const bridgeConfig = { read: () => config.read(), write: (patch) => config.write(patch) };
  // Every bridge built gets a fresh capability, which ends the one before; a bridge that is gone
  // leaves none behind. The capability goes straight to the bridge and is never kept here.
  const revokeAuthority = () => { try { phoneAuthority?.revoke?.(); } catch {} };
  function ensureBridge() {
    if (state.bridge || disabled || state.stopping) return state.bridge;
    try {
      state.bridge = bridgeFactory({
        getRuntime, getDispatcher, transport, config: bridgeConfig,
        authority: typeof phoneAuthority?.issue === 'function' ? phoneAuthority.issue() : null,
        format: { toWhatsApp, chunk }, inbound: { composePrompt, createCoalescer },
        // No policy of our own: the bridge uses the process-wide registry (defaultRemotePolicyRegistry).
        ...(policy ? { policy } : {}), ...(typeof getDefaultBrain === 'function' ? { getDefaultBrain } : {}),
        ...(typeof getCatalog === 'function' ? { getCatalog } : {}),
        ...(rng ? { rng } : {}), ...(bridgeLimits ? { limits: bridgeLimits } : {}), now, timers: T,
        log: (tag, message) => say(`${tag} ${message}`),
      });
    } catch (error) {
      say(`the bridge did not start: ${error?.message || error}`, 'warn');
      state.bridge = null;
      revokeAuthority();
    }
    return state.bridge;
  }
  async function dropBridge() {
    const bridge = state.bridge;
    // First the Mac: live computer control of the WhatsApp sessions ends (lib/whatsapp/bridge.js
    // endComputerUse, synchronous) while the bridge still exists. Only then is it dropped.
    try { bridge?.endComputerUse?.('bridge dropped'); } catch (error) { say(`ending computer use: ${error?.message || error}`, 'warn'); }
    state.bridge = null;
    revokeAuthority();
    if (!bridge) return;
    try { await bridge.shutdown?.(); } catch (error) { say(`bridge shutdown: ${error?.message || error}`, 'warn'); }
  }
  function bridgeStatus() { try { return state.bridge?.status?.() || null; } catch { return null; } }
  function refreshBridge() { try { state.bridge?.refresh?.(); } catch {} }
  /** A notice from SynaBun itself (escalation, autonomous expiry): straight to the phone, labelled like the bridge's replies. */
  async function notice(text) {
    if (!manager || !connectedNow()) return false;
    const prefix = replyPrefix();
    const result = await transport.send(prefix ? `${prefix} ${text}` : text).catch(() => null);
    return !!result?.ok;
  }

  // ── autonomous: the phone's ALLOW code, the 8 h window ────────────────────
  function endEscalation(reason) {
    const esc = state.escalation;
    if (!esc) return;
    T.clearTimeout(esc.timer);
    state.escalation = null;
    state.escalationEndedAt = now();
    if (reason !== 'allowed') record('security', `Autonomous was not turned on (${reason})`);
    notify();
  }
  function startEscalation() {
    if (state.escalation) endEscalation('replaced');
    const code = String(randomInt(0, 10_000)).padStart(4, '0');
    const esc = { code, expiresAt: now() + L.escalationMs, attemptsLeft: L.escalationTries, timer: null };
    esc.timer = T.setTimeout(() => {
      if (state.escalation !== esc) return;
      endEscalation('expired');
      notice('The ALLOW code expired: SynaBun stays on its current level.').catch(() => {});
    }, L.escalationMs);
    esc.timer?.unref?.();
    state.escalation = esc;
    record('security', 'Autonomous requested on this computer; waiting for the ALLOW code from the phone');
    notice('Autonomous was requested on your computer. To turn it on for 8 hours, reply ALLOW followed by the 4-digit code shown in SynaBun, within 5 minutes. Ignore this message if it was not you.').catch(() => {});
    notify();
    return { code, expiresAt: esc.expiresAt, attemptsLeft: esc.attemptsLeft };
  }
  function armAutonomousTimer() {
    T.clearTimeout(state.autonomousTimer);
    state.autonomousTimer = null;
    const cfg = config.read();
    if (cfg.level !== 'autonomous') return;
    const left = (cfg.autonomousUntil || 0) - now();
    if (left <= 0) { expireAutonomous(); return; }
    // setTimeout caps at 2^31-1 ms; 8 h is far below it.
    state.autonomousTimer = T.setTimeout(expireAutonomous, left);
    state.autonomousTimer?.unref?.();
  }
  function expireAutonomous() {
    state.autonomousTimer = null;
    const cfg = config.read();
    if (cfg.level !== 'autonomous') return;
    config.write({ level: 'ask', autonomousUntil: null });
    refreshBridge();
    record('security', 'Autonomous ended; back to Ask on my phone');
    notice('Autonomous ended: I ask on your phone again before acting.').catch(() => {});
    notify();
  }
  const sameCode = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
  /** "ALLOW 1234" from the owner: complete, refuse or explain. → true when consumed. */
  function handleAllow(message) {
    const match = /^\s*allow\s+(\d{4})\s*$/i.exec(String(message.text || ''));
    if (!match || message.forwarded || (Array.isArray(message.images) && message.images.length)) return false;
    const esc = state.escalation;
    if (!esc) {
      if (state.escalationEndedAt && now() - state.escalationEndedAt < L.escalationEchoMs) {
        notice('Nothing is waiting for an ALLOW code any more. Ask again from SynaBun on your computer.').catch(() => {});
        return true;
      }
      return false;
    }
    if (now() > esc.expiresAt) {
      endEscalation('expired');
      notice('That ALLOW code expired. Ask again from SynaBun on your computer.').catch(() => {});
      return true;
    }
    if (!sameCode(match[1], esc.code)) {
      esc.attemptsLeft -= 1;
      if (esc.attemptsLeft <= 0) {
        endEscalation('wrong code');
        notice('Wrong code three times: Autonomous stays off.').catch(() => {});
      } else {
        notice(`That code does not match. ${esc.attemptsLeft} ${esc.attemptsLeft === 1 ? 'try' : 'tries'} left.`).catch(() => {});
        notify();
      }
      return true;
    }
    const until = now() + L.autonomousMs;
    config.write({ level: 'autonomous', autonomousUntil: until });
    endEscalation('allowed');
    refreshBridge();
    armAutonomousTimer();
    record('security', `Autonomous turned on from the phone until ${hhmm(until)}`);
    notice(`Autonomous is on until ${hhmm(until)}. I act without asking for 8 hours, then go back to Ask. Send /pause to stop everything.`).catch(() => {});
    notify();
    return true;
  }

  // ── manager events ─────────────────────────────────────────────────────────
  function onState(snapshot) {
    const conn = snapshot?.conn || {};
    const prev = state.lastConn;
    state.lastConn = conn;
    state.lastStateAt = now();
    const cfg = config.read();
    if (conn.state === 'open' && prev?.state !== 'open') {
      state.connectedAt = now();
      state.reconnectAttempt = 0;
      state.fatal = null;
      config.write({ setup: { ...(cfg.setup || {}), connectedAt: now(), lastEnd: null, ...(conn.registered && !cfg.setup?.linkedAt ? { linkedAt: now() } : {}) } });
      record('state', 'Connected to WhatsApp');
    }
    if (conn.state === 'reconnecting' && prev?.state !== 'reconnecting') {
      state.reconnectAttempt += 1;
      if (prev?.state === 'open') record('state', 'Connection lost; reconnecting');
    }
    // The link's phase follows the host: a QR/code on screen is "waiting", the phone accepting it is "scanned".
    // Terminal states only count once the host took the link request (a fresh host starts out "unlinked").
    const link = state.link;
    if (link?.requested) {
      if (['connecting', 'qr', 'pairing'].includes(conn.state)) link.progressed = true;
      if (link.shown && conn.state === 'connecting' && link.phase !== 'scanned') {
        link.phase = 'scanned';
        link.stream.write({ type: 'state', state: 'linking', phase: 'scanned', method: link.method });
      } else if (link.progressed && ['link_expired', 'error', 'unlinked', 'logged_out', 'forbidden'].includes(conn.state)) {
        finishLink('failed', conn.state === 'link_expired' || conn.state === 'unlinked' ? { type: 'state', state: 'link_expired' } : { type: 'error', code: conn.state === 'forbidden' ? 'FORBIDDEN' : 'LINK_FAILED' });
      }
    }
    if (state.claim) {
      const claim = conn.claim;
      if (claim && Number.isFinite(claim.attemptsLeft) && claim.attemptsLeft !== state.claim.attemptsLeft) {
        state.claim.attemptsLeft = claim.attemptsLeft;
        state.claim.stream.write({ type: 'claim', attemptsLeft: claim.attemptsLeft, expiresAt: claim.expiresAt });
      }
      if (!claim?.active && !conn.owner?.bound && prev?.claim?.active) endClaim({ type: 'expired' });
    }
    if (['logged_out', 'forbidden'].includes(conn.state) && prev?.state !== conn.state) onLoggedOut(conn.state === 'forbidden' ? 'banned' : logoutReason(cfg));
    if (conn.state === 'unlinked' && prev && prev.state !== 'unlinked' && !state.link) {
      // Confirmation refused or timed out, or the host wiped the link.
      config.write({ owner: null, setup: cfg.setup ? { ...cfg.setup, linkedAt: null } : null });
    }
    // Every state change reaches the bridge (it sends the restart note and flushes its outbox on connect).
    const connected = conn.state === 'open';
    state.wasConnected = connected;
    const bridge = connected ? ensureBridge() : state.bridge;
    try { const r = bridge?.onConnection?.({ connected, state: conn.state }); if (r?.catch) r.catch(() => {}); } catch {}
    notify();
  }
  function onLoggedOut(reason) {
    const cfg = config.read();
    config.write({ owner: null, setup: { ...(cfg.setup || {}), linkedAt: null, lastEnd: { state: 'logged_out', reason, at: now() } } });
    record('security', reason === 'banned' ? 'WhatsApp refused this account (it may be banned)' : reason === 'inactive' ? 'WhatsApp logged SynaBun out after a long time offline' : 'WhatsApp logged SynaBun out (removed from the phone)');
    endEscalation('logged out');
    dropBridge().catch(() => {});
    // The host wiped the credentials; nothing is left for it to do.
    T.setTimeout(() => { if (!isLinked()) manager.stop().catch?.(() => {}); }, 1000)?.unref?.();
  }
  function onQr({ qr, expiresAt } = {}) {
    const link = state.link;
    if (!link || typeof qr !== 'string' || !qr) return;
    let svg;
    try { svg = renderQrSvg(qr, { label: 'WhatsApp link QR code' }); } catch (error) { say(`could not draw the link QR: ${error?.message || error}`, 'warn'); return; }
    link.shown = true;
    link.phase = 'waiting';
    link.stream.write({ type: 'qr', svg, expiresAt });
    notify();
  }
  function onPairingCode({ code, expiresAt } = {}) {
    const link = state.link;
    if (!link || !code) return;
    link.shown = true;
    link.phase = 'waiting';
    link.stream.write({ type: 'pairing_code', code: formatPairingCode(code), expiresAt });
    notify();
  }
  function onLinked({ mode, me } = {}) {
    const cfg = config.read();
    const linkedMode = MODES.includes(mode) ? mode : cfg.mode;
    config.write({ mode: linkedMode, enabled: true, owner: null, paused: false, pausedBy: null, setup: { ...(cfg.setup || {}), mode: linkedMode, linkedAt: now(), lastEnd: null } });
    state.linkOutcome = null;
    record('state', `Linked a WhatsApp account${me?.masked ? ` (${me.masked})` : ''} in ${linkedMode === 'self' ? '"Message yourself"' : 'second-number'} mode`);
    finishLink('linked', { type: 'linked', mode: linkedMode });
    configureHost();
    ensureBridge();
    notify();
  }
  function onOwnerBound({ masked, via } = {}) {
    const cfg = config.read();
    config.write({ owner: { masked: String(masked || '••••').slice(0, 32), boundAt: now(), via: via === 'claim' ? 'claim' : 'self_confirm' }, enabled: true, setup: { ...(cfg.setup || {}), linkedAt: cfg.setup?.linkedAt || now() } });
    record('security', via === 'claim' ? `Owner confirmed with the claim code (${masked})` : `You confirmed the linked account (${masked})`);
    endClaim({ type: 'bound', masked });
    ensureBridge();
    notify();
  }
  const TRIGGER_RE = /^\s*sb(?:\s+|:\s*|$)/i; // "sb hi", "sb:hi", or a bare "sb" caption on a picture
  const ALLOW_RE = /^\s*allow\s+\d{4}\s*$/i;
  /**
   * "Message yourself" with selfTrigger 'prefix': only messages that start with
   * "sb " or "sb:" are for SynaBun (the prefix is stripped). Commands (/stop,
   * /status …), the ALLOW answer and replies quoting SynaBun's own messages
   * always pass. Anything else is a note to self: dropped here, never logged.
   * → the message to act on, or null.
   */
  function applyTrigger(message) {
    const cfg = config.read();
    if (cfg.mode !== 'self' || cfg.selfTrigger !== 'prefix') return message;
    const text = typeof message.text === 'string' ? message.text : String(message.text ?? '');
    const hasImages = Array.isArray(message.images) && message.images.length > 0;
    const match = TRIGGER_RE.exec(text);
    if (match) {
      const rest = text.slice(match[0].length);
      return rest.trim() || hasImages ? { ...message, text: rest } : null;
    }
    if (!message.forwarded && ALLOW_RE.test(text)) return message;
    const command = parseCommand(message);
    if (command && (command.kind === 'command' || command.kind === 'refused')) return message;
    if (message.quoted?.fromBot === true) return message;
    return null;
  }
  /** The manager hands over the InboundMessage itself (a {message} wrapper is accepted too). */
  function onInbound(event) {
    const incoming = event?.message && typeof event.message === 'object' && !('owner' in event) ? event.message : event;
    if (!incoming || incoming.owner !== true) return;
    const message = applyTrigger(incoming);
    if (!message) { state.notesSkipped += 1; return; }
    // An ALLOW answer is consumed before anything is logged: its code never
    // reaches the activity log, whatever "Keep message text" says.
    if (handleAllow(message)) { record('inbound', 'Message from you: an ALLOW code (not kept)'); notify(); return; }
    record('inbound', describeInbound(message), message.text);
    const bridge = ensureBridge();
    try { const r = bridge?.onInbound?.(message); if (r?.catch) r.catch((error) => say(`inbound: ${error?.message || error}`, 'warn')); }
    catch (error) { say(`inbound: ${error?.message || error}`, 'warn'); }
    notify();
  }
  function onIgnored({ counts } = {}) {
    const total = Object.values(counts || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
    if (total) record('ignored', `Ignored ${total} message${total === 1 ? '' : 's'} that were not yours to answer (other chats, groups, strangers)`);
    notify();
  }
  function onThrottled({ retryAfterMs } = {}) {
    record('state', `SynaBun's WhatsApp send limit was reached; replies wait ${Math.ceil((Number(retryAfterMs) || 0) / 1000)} s and are sent then`);
    notify();
  }
  function onFatal({ code, message } = {}) {
    state.fatal = { code: String(code || 'ERROR'), message: message ? redactWa(message) : null, at: now() };
    const labels = {
      LOGGED_OUT: 'WhatsApp logged SynaBun out', REPLACED: 'Another copy of this link took over the session', FORBIDDEN: 'WhatsApp refused the connection',
      CONFIRM_TIMEOUT: 'The linked account was not confirmed within 10 minutes and was logged out', RECONNECT_LIMIT: 'Too many reconnects: SynaBun stopped trying',
      HOST_HELD: 'The WhatsApp connector kept crashing and was stopped', OWNER_ANOMALY: 'Sending paused: the owner looked different than expected', LOCKED: 'Another SynaBun is using the WhatsApp session files',
      AUTH_PERMS: 'The WhatsApp session files could not be made private (fix the folder permissions, then reconnect)',
    };
    record('error', labels[state.fatal.code] || `WhatsApp connector: ${state.fatal.code}`);
    if (state.link) finishLink('failed', { type: 'error', code: state.fatal.code });
    notify();
  }
  function wireManager() {
    if (!manager || state.offs.length) return;
    const on = (name, fn) => { try { state.offs.push(manager.on(name, (payload) => { try { fn(payload); } catch (error) { say(`${name} handler: ${error?.message || error}`, 'warn'); } })); } catch {} };
    on('state', onState);
    on('qr', onQr);
    on('pairing_code', onPairingCode);
    on('linked', onLinked);
    on('owner_bound', onOwnerBound);
    on('inbound', onInbound);
    on('ignored', onIgnored);
    on('throttled', onThrottled);
    on('fatal', onFatal);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  function requireAvailable() {
    if (disabled) throw whatsappError(409, 'UNAVAILABLE', 'WhatsApp is turned off on this computer (SYNABUN_WHATSAPP=off).');
  }
  /** Start the host and the linked session (autostart, resume, reconnect). */
  async function run() {
    const cfg = config.read();
    wireManager();
    const started = await manager.start(prefsOf(cfg));
    if (!started?.ok) {
      state.fatal = { code: started?.code || 'HOST_UNAVAILABLE', message: started?.message ? redactWa(started.message) : null, at: now() };
      notify();
      return started || { ok: false, code: 'HOST_UNAVAILABLE' };
    }
    const result = await manager.connect({ purpose: 'run', mode: cfg.mode });
    if (!result?.ok) {
      if (result?.code === 'NOT_LINKED') config.write({ owner: null, setup: cfg.setup ? { ...cfg.setup, linkedAt: null } : null });
      else state.fatal = { code: result?.code || 'CONNECT_FAILED', message: result?.message ? redactWa(result.message) : null, at: now() };
    } else {
      ensureBridge();
    }
    notify();
    return result;
  }
  async function start() {
    if (state.started) return status();
    state.started = true;
    if (disabled) { notify(); return status(); }
    wireManager();
    pruneLogs();
    state.retentionTimer = T.setInterval(pruneLogs, 6 * HOUR);
    state.retentionTimer?.unref?.();
    armAutonomousTimer();
    const cfg = config.read();
    configureHost(cfg);
    if (installerStatus().installed && cfg.enabled && isLinked(cfg)) {
      try { await run(); } catch (error) { say(`autostart failed: ${error?.message || error}`, 'warn'); }
    }
    notify();
    return status();
  }
  async function shutdown({ timeoutMs = 5000 } = {}) {
    state.stopping = true;
    for (const timer of [state.broadcastTimer, state.autonomousTimer, state.escalation?.timer, state.link?.timer]) if (timer) T.clearTimeout(timer);
    if (state.retentionTimer) T.clearInterval(state.retentionTimer);
    try { state.install?.controller?.abort(); } catch {}
    if (state.link) { state.link.stream.end({ type: 'error', code: 'SHUTTING_DOWN' }); state.link = null; }
    if (state.claim) { state.claim.stream.end({ type: 'error', code: 'SHUTTING_DOWN' }); state.claim = null; }
    // Bridge first (it may still say goodbye through the manager), then the host.
    await dropBridge();
    for (const off of state.offs.splice(0)) { try { off?.(); } catch {} }
    if (manager) { try { await manager.stop({ timeoutMs }); } catch (error) { say(`stop: ${error?.message || error}`, 'warn'); } }
  }
  function killNow() {
    state.stopping = true;
    const bridge = state.bridge;
    try { bridge?.endComputerUse?.('process exit'); } catch {}
    state.bridge = null;
    revokeAuthority();
    try { const r = bridge?.shutdown?.(); if (r?.catch) r.catch(() => {}); } catch {}
    try { manager?.killNow(); } catch {}
  }

  // ── linking (NDJSON to the tab that asked) ─────────────────────────────────
  function finishLink(outcome, lastEvent) {
    const link = state.link;
    if (!link) return;
    state.link = null;
    T.clearTimeout(link.timer);
    link.stream.end(lastEvent);
    if (outcome !== 'linked') {
      state.linkOutcome = { state: 'link_expired', at: now() };
      record('state', lastEvent?.code ? `Linking failed (${lastEvent.code})` : 'The link code expired before a phone used it');
      // Nothing linked: stop the host (and Baileys) until the next attempt.
      const r = manager.disconnect?.();
      Promise.resolve(r).finally(() => { if (!isLinked() && !state.link) Promise.resolve(manager.stop?.()).catch(() => {}); }).catch(() => {});
    }
    notify();
  }
  async function link(body = {}, openStream) {
    requireAvailable();
    const method = body.method === 'code' ? 'code' : body.method === 'qr' || body.method === undefined ? 'qr' : null;
    if (!method) throw whatsappError(400, 'BAD_METHOD', 'method must be "qr" or "code"', 'method');
    let phoneDigits = null;
    if (method === 'code') {
      const phone = normalizePhone(body.phone);
      if (!phone.ok) throw whatsappError(400, 'BAD_PHONE', phoneMessage(phone.code), 'phone');
      phoneDigits = phone.digits;
    }
    if (state.link) throw whatsappError(409, 'LINK_BUSY', 'Another SynaBun tab is already linking WhatsApp. Finish or close it first.');
    if (state.install) throw whatsappError(409, 'INSTALL_BUSY', 'The WhatsApp connector is still installing.');
    if (!installerStatus().installed) throw whatsappError(409, 'NOT_INSTALLED', 'Install the WhatsApp connector first.');
    const cfg = config.read();
    if (isLinked(cfg)) throw whatsappError(409, 'ALREADY_LINKED', 'A WhatsApp account is already linked. Unlink it first.');
    if (body.mode !== undefined) {
      if (!MODES.includes(body.mode)) throw whatsappError(400, 'BAD_MODE', 'mode must be "self" or "dedicated"', 'mode');
      if (body.mode !== cfg.mode) config.write({ mode: body.mode });
    }
    const mode = config.read().mode;
    const stream = openStream();
    const current = { method, phase: 'starting', shown: false, requested: false, progressed: false, stream, timer: null };
    state.link = current;
    state.linkOutcome = null;
    state.fatal = null;
    if (cfg.setup?.lastEnd) config.write({ setup: { ...cfg.setup, lastEnd: null } });
    stream.onAbort(() => {
      if (state.link !== current) return;
      state.link = null;
      T.clearTimeout(current.timer);
      record('state', 'Linking cancelled (the settings tab closed)');
      Promise.resolve(manager.disconnect?.()).finally(() => { if (!isLinked() && !state.link) Promise.resolve(manager.stop?.()).catch(() => {}); }).catch(() => {});
      notify();
    });
    stream.write({ type: 'state', state: 'linking', phase: 'starting', method });
    notify();
    wireManager();
    let started;
    let result;
    try {
      started = await manager.start(prefsOf({ ...config.read(), mode }));
      if (state.link !== current) return;
      if (!started?.ok) { finishLink('failed', { type: 'error', code: started?.code || 'HOST_UNAVAILABLE', message: started?.message ? redactWa(started.message) : undefined }); return; }
      current.requested = true;
      result = await manager.connect({ purpose: 'link', mode, link: { method, ...(phoneDigits ? { phone: phoneDigits } : {}) } });
    } catch (error) {
      result = { ok: false, code: 'LINK_FAILED', message: error?.message || String(error) };
    }
    if (state.link !== current) return;
    if (!result?.ok) { finishLink('failed', { type: 'error', code: result?.code || 'LINK_FAILED', message: result?.message ? redactWa(result.message) : undefined }); return; }
    current.timer = T.setTimeout(() => { if (state.link === current) finishLink('failed', { type: 'state', state: 'link_expired' }); }, L.linkTimeoutMs);
    current.timer?.unref?.();
    record('state', `Linking started (${method === 'qr' ? 'QR code' : 'phone number code'})`);
  }
  const phoneMessage = (code) => PHONE_ERRORS[code] || 'That phone number does not look right.';

  // ── owner ──────────────────────────────────────────────────────────────────
  async function confirmOwner(body = {}) {
    requireAvailable();
    if (typeof body.accept !== 'boolean') throw whatsappError(400, 'BAD_REQUEST', 'accept must be true or false', 'accept');
    const result = await manager.confirmOwner(body.accept);
    if (!result?.ok) throw whatsappError(409, result?.code || 'NOT_AWAITING', result?.message ? redactWa(result.message) : 'Nothing is waiting for confirmation.');
    if (!body.accept) {
      const cfg = config.read();
      config.write({ owner: null, setup: cfg.setup ? { ...cfg.setup, linkedAt: null } : null });
      record('security', 'You said the linked account is not yours; SynaBun logged it out');
      await dropBridge();
      Promise.resolve(manager.stop?.()).catch(() => {});
    }
    notify();
    return { ok: true, status: status() };
  }
  function endClaim(lastEvent) {
    const claim = state.claim;
    if (!claim) return;
    state.claim = null;
    claim.stream.end(lastEvent);
  }
  async function claimOwner(body = {}, openStream) {
    requireAvailable();
    const cfg = config.read();
    const conn = managerStatus().conn;
    if (cfg.mode !== 'dedicated') throw whatsappError(409, 'WRONG_MODE', 'Claim codes are for the second-number mode.');
    if (conn.state !== 'open') throw whatsappError(409, 'NOT_CONNECTED', 'WhatsApp is not connected.');
    if (conn.owner?.bound) throw whatsappError(409, 'OWNER_BOUND', 'An owner is already set. Reset it first.');
    const result = await manager.claimStart({ ttlMs: L.claimTtlMs });
    if (!result?.ok) throw whatsappError(409, result?.code || 'CLAIM_FAILED', result?.message ? redactWa(result.message) : 'Could not start a claim code.');
    if (state.claim) endClaim({ type: 'cancelled' });
    const digits = /wa\.me\/(\d{6,15})/.exec(String(result.link || ''))?.[1] || null;
    const stream = openStream();
    const current = { stream, attemptsLeft: managerStatus().conn.claim?.attemptsLeft ?? null };
    state.claim = current;
    stream.onAbort(() => {
      if (state.claim !== current) return;
      state.claim = null;
      Promise.resolve(manager.claimCancel?.()).catch(() => {});
      notify();
    });
    let qrSvg = null;
    if (result.link) { try { qrSvg = renderQrSvg(result.link, { label: 'QR code that opens the chat with the code filled in' }); } catch {} }
    stream.write({ type: 'claim', code: result.code, sendTo: digits ? maskNumber(digits) : null, waMeUrl: result.link || null, qrSvg, expiresAt: result.expiresAt, attemptsLeft: current.attemptsLeft });
    record('security', 'Claim code shown on this computer; waiting for the owner to send it');
    notify();
  }
  async function resetOwner() {
    requireAvailable();
    if (config.read().mode !== 'dedicated') throw whatsappError(409, 'WRONG_MODE', 'In "Message yourself" the owner is the linked account. Unlink to link another one.');
    const result = await manager.ownerReset();
    if (!result?.ok) throw whatsappError(409, result?.code || 'RESET_FAILED', result?.message ? redactWa(result.message) : 'Could not reset the owner.');
    // The second account stays linked: keep that on record while the owner is unbound.
    const cfg = config.read();
    config.write({ owner: null, setup: { ...(cfg.setup || {}), linkedAt: cfg.setup?.linkedAt || cfg.owner?.boundAt || now() } });
    endEscalation('owner reset');
    record('security', 'Owner reset; confirm the owner again');
    notify();
    return { ok: true, status: status() };
  }

  // ── connector ──────────────────────────────────────────────────────────────
  function startInstall({ update = false } = {}) {
    const controller = new AbortController();
    const job = { controller, stage: 'checking', startedAt: now(), update };
    state.install = job;
    state.installError = null;
    state.installCache = null;
    record('state', update ? 'Updating the WhatsApp connector' : 'Installing the WhatsApp connector');
    notify();
    (async () => {
      // The host holds the runtime's files open (Windows locks them): stop it first, restart after.
      if (hostRunning()) await dropBridge();
      try { await manager.stop(); } catch {}
      let result;
      try {
        result = await installer.install({
          signal: controller.signal,
          onProgress: ({ stage } = {}) => { if (stage && stage !== job.stage) { job.stage = stage; notify(); } },
        });
      } catch (error) {
        result = { ok: false, code: 'UNKNOWN', message: error?.message || String(error) };
      }
      if (state.install === job) state.install = null;
      state.installCache = null;
      if (result?.ok) {
        record('state', `WhatsApp connector ${result.version || ''} installed`.replace(/\s+/g, ' '));
      } else {
        state.installError = { code: result?.code || 'UNKNOWN', message: result?.message ? redactWa(result.message) : null, at: now() };
        record('error', result?.code === 'ABORTED' ? 'Connector install cancelled' : `Connector install failed (${state.installError.code})`);
        if (result?.code === 'ABORTED') state.installError = null;
      }
      const cfg = config.read();
      if (!state.stopping && installerStatus().installed && cfg.enabled && isLinked(cfg)) await run().catch(() => {});
      notify();
    })().catch((error) => { say(`install job: ${error?.message || error}`, 'warn'); state.install = null; notify(); });
    return job;
  }
  async function installConnector(body = {}) {
    requireAvailable();
    if (state.install) throw whatsappError(409, 'INSTALL_BUSY', 'The connector is already being installed.');
    const inst = installerStatus();
    const update = body.update === true || body.reinstall === true;
    if (inst.installed && !update) return { ok: true, already: true, status: status() };
    startInstall({ update });
    return { ok: true, started: true, status: status() };
  }
  async function cancelInstall() {
    requireAvailable();
    if (!state.install) return { ok: true, cancelled: false, status: status() };
    try { state.install.controller.abort(); } catch {}
    return { ok: true, cancelled: true, status: status() };
  }
  async function removeConnector() {
    requireAvailable();
    if (state.install) throw whatsappError(409, 'INSTALL_BUSY', 'The connector is being installed.');
    if (isLinked()) throw whatsappError(409, 'STILL_LINKED', 'Unlink WhatsApp before removing the connector.');
    try { await manager.stop(); } catch {}
    const result = await installer.uninstall();
    state.installCache = null;
    state.installError = null;
    if (!result?.ok) throw whatsappError(409, result?.code || 'UNINSTALL_FAILED', result?.message ? redactWa(result.message) : 'Could not remove the connector.');
    record('state', 'WhatsApp connector removed');
    notify();
    return { ok: true, status: status() };
  }
  function connectorLog({ limit = 200 } = {}) {
    requireAvailable();
    const n = Math.max(1, Math.min(1000, Number(limit) || 200));
    let lines = [];
    try { lines = installer.logTail(n) || []; } catch { lines = []; }
    return { ok: true, lines: lines.map((line) => redactWa(line)) };
  }

  // ── setup, test, pause, resume, reconnect, unlink, remove ──────────────────
  async function setup(body = {}) {
    requireAvailable();
    const mode = body.mode === undefined ? 'self' : body.mode;
    if (!MODES.includes(mode)) throw whatsappError(400, 'BAD_MODE', 'mode must be "self" or "dedicated"', 'mode');
    const method = body.method === undefined ? 'qr' : body.method;
    if (method !== 'qr' && method !== 'code') throw whatsappError(400, 'BAD_METHOD', 'method must be "qr" or "code"', 'method');
    if (method === 'code') {
      const phone = normalizePhone(body.phone);
      if (!phone.ok) throw whatsappError(400, 'BAD_PHONE', phoneMessage(phone.code), 'phone');
    }
    const cfg = config.read();
    if (isLinked(cfg)) {
      if (cfg.mode !== mode) throw whatsappError(409, 'ALREADY_LINKED', `WhatsApp is already linked in ${cfg.mode === 'self' ? '"Message yourself"' : 'second-number'} mode. Unlink it to switch.`);
      if (!cfg.enabled) config.write({ enabled: true });
      return { ok: true, next: 'none', status: status() };
    }
    // The intent (never the phone number: the tab keeps that for /link).
    config.write({ mode, enabled: true, setup: { ...(cfg.setup || {}), mode, method, requestedAt: now(), lastEnd: null } });
    state.linkOutcome = null;
    record('state', `Setup started: ${mode === 'self' ? '"Message yourself"' : 'second number'}, ${method === 'qr' ? 'QR code' : 'phone number code'}`);
    let next = 'link';
    if (state.install) next = 'install';
    else if (!installerStatus().installed) { startInstall(); next = 'install'; }
    notify();
    return { ok: true, next, status: status() };
  }
  async function test() {
    requireAvailable();
    if (!connectedNow()) throw whatsappError(409, 'NOT_CONNECTED', 'WhatsApp is not connected.');
    const wait = state.testAt + L.testEveryMs - now();
    if (wait > 0) {
      const error = whatsappError(429, 'RATE_LIMITED', 'Wait a few seconds before sending another test.');
      error.retryAfterMs = wait;
      throw error;
    }
    state.testAt = now();
    const result = await transport.send(TEST_MESSAGE);
    if (!result?.ok) throw whatsappError(502, result?.code || 'SEND_FAILED', result?.message ? redactWa(result.message) : 'The test message could not be sent.');
    return { ok: true };
  }
  function pause({ by = 'desktop' } = {}) {
    requireAvailable();
    // An agent's pause counts as the desktop's: the phone cannot undo it.
    const bridge = state.bridge;
    if (bridge?.pause) { try { bridge.pause('desktop'); } catch {} }
    config.write({ paused: true, pausedBy: 'desktop' });
    refreshBridge();
    record('security', by === 'agent' ? 'Paused by an agent on this computer' : 'Paused from this computer');
    notify();
    return { ok: true, status: status() };
  }
  async function resume() {
    requireAvailable();
    const cfg = config.read();
    config.write({ paused: false, pausedBy: null, ...(cfg.enabled ? {} : { enabled: true }) });
    try { state.bridge?.resume?.('desktop'); } catch {}
    refreshBridge();
    record('security', 'Resumed from this computer');
    if (isLinked() && !hostRunning() && installerStatus().installed) await run().catch(() => {});
    notify();
    return { ok: true, status: status() };
  }
  async function reconnect() {
    requireAvailable();
    if (!installerStatus().installed) throw whatsappError(409, 'NOT_INSTALLED', 'Install the WhatsApp connector first.');
    if (!isLinked()) throw whatsappError(409, 'NOT_LINKED', 'No WhatsApp account is linked.');
    const cfg = config.read();
    if (!cfg.enabled) config.write({ enabled: true });
    state.fatal = null;
    record('state', 'Reconnect requested from this computer');
    const result = await run();
    return { ok: !!result?.ok, code: result?.ok ? undefined : result?.code, status: status() };
  }
  /** Forget the link: log the device out of WhatsApp when the host can, wipe, reset the service-owned config. */
  async function unlinkInternal() {
    if (state.link) finishLink('failed', { type: 'error', code: 'UNLINKED' });
    endClaim({ type: 'cancelled' });
    endEscalation('unlinked');
    T.clearTimeout(state.autonomousTimer);
    state.autonomousTimer = null;
    await dropBridge();
    let loggedOut = false;
    let code = null;
    if (manager && installerStatus().installed) {
      if (!hostRunning()) { const started = await manager.start(prefsOf(config.read())); if (!started?.ok) code = started?.code || 'HOST_UNAVAILABLE'; }
      if (!code) {
        const result = await manager.logout();
        loggedOut = !!result?.ok;
        if (!result?.ok) code = result?.code || 'LOGOUT_FAILED';
      }
      try { await manager.stop(); } catch {}
    }
    const cfg = config.read();
    const { version: _version, ...serviceDefaults } = SERVICE_DEFAULTS;
    config.write({ ...serviceDefaults, previousSessionIds: [], enabled: false, level: cfg.level === 'autonomous' ? 'ask' : cfg.level, setup: null, bridgeState: null });
    state.linkOutcome = null;
    state.fatal = null;
    state.lastConn = null;
    state.wasConnected = false;
    return { loggedOut, code };
  }
  async function unlink() {
    requireAvailable();
    const result = await unlinkInternal();
    record('security', result.loggedOut ? 'Unlinked: SynaBun logged out of WhatsApp and deleted the session' : 'Unlinked on this computer; also remove SynaBun under WhatsApp → Linked devices on your phone');
    notify();
    return { ok: true, loggedOut: result.loggedOut, code: result.code || undefined, status: status() };
  }
  function removeWaHome() {
    const home = paths.waHome;
    const dataDir = path.join(path.resolve(dataHome), 'data');
    if (!home || path.basename(home) !== 'whatsapp' || isInside(home, dataDir) || !existsSync(home)) return false;
    try { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return true; } catch { return false; }
  }
  async function remove(body = {}) {
    requireAvailable();
    const deleteConversation = body.deleteConversation === true;
    if (state.install) { try { state.install.controller.abort(); } catch {} }
    const before = config.read();
    const sessionIds = [...new Set([bridgeStatus()?.sessionId, before.sessionId, ...(before.previousSessionIds || [])].filter(Boolean))];
    const unlinked = await unlinkInternal();
    try { await manager?.stop(); } catch {}
    const uninstall = installer ? await installer.uninstall().catch((error) => ({ ok: false, code: 'UNKNOWN', message: error?.message })) : { ok: true };
    state.installCache = null;
    state.installError = null;
    const wiped = removeWaHome();
    let deleted = 0;
    if (deleteConversation) {
      let rt = null;
      try { rt = getRuntime(); } catch { rt = null; }
      for (const id of sessionIds) { try { if (await rt?.destroySession?.(id)) deleted += 1; } catch {} }
    }
    activity.length = 0;
    for (const name of logFiles()) { try { unlinkSync(path.join(paths.logsDir, name)); } catch {} }
    state.logFile = null;
    const { version: _version, ...serviceDefaults } = SERVICE_DEFAULTS;
    config.write({ ...USER_DEFAULTS, ...serviceDefaults, previousSessionIds: [], setup: null, bridgeState: null });
    record('security', `WhatsApp removed from SynaBun${deleteConversation ? `; ${deleted} conversation${deleted === 1 ? '' : 's'} deleted` : ''}`);
    notify();
    return { ok: true, loggedOut: unlinked.loggedOut, uninstalled: !!uninstall?.ok, wipedSession: wiped, deletedConversations: deleted, status: status() };
  }

  // ── config, activity, session, fake ────────────────────────────────────────
  const userView = (cfg) => pick(cfg, USER_FIELDS);
  function getConfig() {
    const cfg = config.read();
    return { ok: true, config: userView(cfg), version: cfg.version, level: currentLevel(cfg, now()), levelExpiresAt: currentLevel(cfg, now()) === 'autonomous' ? cfg.autonomousUntil : null, escalation: escalationView() };
  }
  function escalationView() {
    const esc = state.escalation;
    return esc ? { pending: true, expiresAt: esc.expiresAt, attemptsLeft: esc.attemptsLeft } : null;
  }
  async function putConfig(body = {}) {
    requireAvailable();
    const control = new Set(['config', 'expectedVersion', 'confirmEscalation']);
    const sent = body && typeof body.config === 'object' && body.config !== null ? body.config : Object.fromEntries(Object.entries(body || {}).filter(([key]) => !control.has(key)));
    const patch = { ...sent };
    // Which brain runs WhatsApp: only a model the Assistant's own catalog lists (and the user
    // has not disabled) with an effort that model runs is ever stored; anything else is a 400.
    if (Object.hasOwn(patch, 'brain') && patch.brain !== undefined) {
      // The shape first (a 400 needs no catalog); then the model and effort against a fresh catalog.
      const shaped = cleanBrainChoice(patch.brain);
      const checked = checkBrainChoice(patch.brain, shaped ? await catalogValue({ fresh: true }) : null);
      if (!checked.ok) throw whatsappError(checked.status, checked.code, checked.message, checked.field);
      patch.brain = checked.brain;
    }
    const before = config.read();
    const wantsAutonomous = patch?.level === 'autonomous' && currentLevel(before, now()) !== 'autonomous';
    if (wantsAutonomous && body.confirmEscalation === true && !connectedNow()) {
      throw whatsappError(409, 'PHONE_REQUIRED', 'Connect WhatsApp first: your phone confirms Autonomous with an ALLOW code.', 'level');
    }
    const result = config.update(patch, { expectedVersion: body.expectedVersion ?? null, confirmEscalation: body.confirmEscalation === true });
    const after = result.config;
    let pending = null;
    if (result.pending) pending = startEscalation();
    else if (patch && Object.hasOwn(patch, 'level') && patch.level !== 'autonomous') endEscalation('level lowered');
    if (before.level !== after.level || before.autonomousUntil !== after.autonomousUntil) {
      armAutonomousTimer();
      record('security', `Level set to ${after.level === 'read-only' ? 'Read-only' : after.level === 'ask' ? 'Ask on my phone' : 'Autonomous'} from this computer`);
    }
    if (before.computerUse !== after.computerUse) record('security', after.computerUse ? 'Computer use from WhatsApp turned on from this computer' : 'Computer use from WhatsApp turned off from this computer');
    if (before.activityText !== after.activityText) record('settings', after.activityText ? 'Message text is now kept in this activity log' : 'Message text is no longer kept in this activity log');
    if (before.selfTrigger !== after.selfTrigger) record('settings', after.selfTrigger === 'prefix' ? 'Only messages that start with sb go to SynaBun now' : 'Every message in "Message yourself" goes to SynaBun now');
    if (JSON.stringify(before.brain) !== JSON.stringify(after.brain)) {
      record('settings', after.brain ? `WhatsApp now runs on ${providerLabel(after.brain.provider)} / ${after.brain.model}${after.brain.effort ? ` (${after.brain.effort})` : ''}, from the next message` : 'WhatsApp now runs on the same brain as the Assistant, from the next message');
    }
    refreshBridge();
    notify();
    return { ok: true, config: userView(after), version: after.version, pending };
  }
  function listActivity({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(L.activityMax, Number(limit) || 50));
    return { ok: true, entries: activity.slice(-n).reverse(), total: activity.length, textKept: config.read().activityText, counters: { ...(managerStatus().conn.counters || {}) } };
  }
  function clearActivity() {
    activity.length = 0;
    for (const name of logFiles()) { try { unlinkSync(path.join(paths.logsDir, name)); } catch {} }
    state.logFile = null;
    return { ok: true };
  }
  async function newSession() {
    requireAvailable();
    if (!isLinked()) throw whatsappError(409, 'NOT_LINKED', 'Link WhatsApp first.');
    const bridge = ensureBridge();
    if (!bridge?.newSession) throw whatsappError(409, 'BRIDGE_UNAVAILABLE', 'The WhatsApp conversation is not available right now.');
    let id;
    try { id = await bridge.newSession('desktop'); } catch (error) { throw whatsappError(409, error?.code || 'SESSION_FAILED', error?.message || 'Could not start a new conversation.'); }
    record('state', 'Started a fresh WhatsApp conversation from this computer');
    notify();
    return { ok: true, session: sessionView(id) };
  }
  function sessionView(id) {
    if (!id) return null;
    let title = null;
    try { title = getRuntime()?.getSession?.(id, { transcript: false })?.title || null; } catch { title = null; }
    return { id, title };
  }
  // ── which brain runs WhatsApp (lib/whatsapp/brain.js) ──────────────────────
  function catalogRef() { try { return typeof getCatalog === 'function' ? getCatalog() || null : null; } catch { return null; } }
  /** The Assistant's catalog as last built, or null. `build`: when there is none yet, start one for the next reader. */
  function catalogPeek({ build = false } = {}) {
    const catalog = catalogRef();
    let value = null;
    try { value = catalog?.peek?.() || null; } catch { value = null; }
    if (!value && build && catalog?.full) Promise.resolve().then(() => catalog.full()).catch(() => {});
    return value;
  }
  /** The catalog value, built when needed (`fresh`: what is enabled right now, for a save). null when there is none. */
  async function catalogValue({ fresh = false } = {}) {
    const catalog = catalogRef();
    if (!catalog) return null;
    try { if (catalog.full) return (await catalog.full(fresh ? { force: true } : {})) || null; } catch { /* fall through to what is cached */ }
    try { return catalog.peek?.() || null; } catch { return null; }
  }
  function panelBrain() { try { return typeof getDefaultBrain === 'function' ? getDefaultBrain() || null : null; } catch { return null; } }
  /** The stored choice, what a conversation runs on now, and why a stored choice is not used (status.brainChoice). */
  function brainChoice(cfg = config.read()) {
    // Only a stored choice needs checking: the default never builds the catalog from here.
    return brainChoiceView(cfg.brain || null, { catalog: catalogPeek({ build: !!cfg.brain }), panelBrain: panelBrain() });
  }
  /**
   * Ask and Autonomous hold on a Claude brain only (lib/remote-policy.js): the
   * WhatsApp conversation's brain (or the one a new conversation would get)
   * when it is Codex or OpenCode and the level asks for more than read-only.
   */
  function brainLimitView(cfg, sessionId) {
    if (currentLevel(cfg, now()) === 'read-only') return null;
    let provider = null;
    try { provider = sessionId ? getRuntime()?.getSession?.(sessionId, { transcript: false })?.brain?.provider || null : null; } catch { provider = null; }
    if (!provider) provider = brainChoice(cfg).effective?.provider || null;
    if (!remoteBrainLimited(provider)) return null;
    return { provider, label: providerLabel(provider), text: remoteBrainNotice(provider) };
  }
  const fakeEnabled = () => fake && !disabled;
  async function fakeAction(body = {}) {
    if (!fakeEnabled()) throw whatsappError(404, 'NOT_FOUND', 'Not found');
    const action = String(body.action || '');
    const cfg = config.read();
    const call = async (name, args = {}) => {
      const result = await manager.fake(name, args);
      if (result?.ok === false) throw whatsappError(409, result.code || 'FAKE_FAILED', result.message || `fake ${name} failed`);
      return result;
    };
    switch (action) {
      case 'scan': await call('scan'); break;
      case 'inbound': {
        const from = body.from === 'stranger' ? 'stranger' : cfg.mode === 'dedicated' ? 'owner' : 'self';
        const text = String(body.text ?? '').slice(0, 4000);
        // offline: WhatsApp delivers it after an offline spell (messages.upsert 'append'), sent ageMs ago.
        const ageMs = Math.min(Math.max(0, Number(body.ageMs) || 0), 7 * DAY);
        const held = body.offline === true ? { type: 'append', at: now() - ageMs } : {};
        await call('inbound', { from, text, ...(body.forwarded === true ? { forwarded: true } : {}), ...held });
        break;
      }
      case 'drop': await call('disconnect', { reason: 'connectionLost' }); break;
      case 'logout': await call('disconnect', { reason: 'loggedOut' }); break;
      case 'ban': await call('forbidden'); break;
      case 'crash': await call('crash'); break;
      case 'state': break;
      default: throw whatsappError(400, 'BAD_ACTION', 'action must be one of scan, inbound, drop, logout, ban, crash, state', 'action');
    }
    let sent = [];
    try {
      const snap = await manager.fake('snapshot');
      sent = (Array.isArray(snap?.sent) ? snap.sent : []).slice(-50).map((row) => ({ kind: row.kind, text: row.kind === 'text' ? String(row.text ?? '') : null, react: row.react?.text ?? null, at: row.at ?? null }));
    } catch { sent = []; }
    return { ok: true, action, sent, status: status() };
  }

  // ── status ─────────────────────────────────────────────────────────────────
  function status() {
    const cfg = config.read();
    const tab = tabState();
    const { conn, host, runtime } = managerStatus();
    const inst = installerStatus();
    const level = currentLevel(cfg, now());
    const bridge = bridgeStatus();
    const sessionId = bridge?.sessionId || cfg.sessionId || null;
    let confirm = null;
    if (tab.state === 'confirm_owner') {
      confirm = tab.kind === 'self'
        ? { kind: 'self', expiresAt: conn.awaitingConfirmUntil ?? null, attemptsLeft: null }
        : { kind: 'code', expiresAt: conn.claim?.active ? conn.claim.expiresAt : null, attemptsLeft: conn.claim?.active ? conn.claim.attemptsLeft : null };
    }
    const owner = cfg.owner ? { masked: cfg.owner.masked, boundAt: cfg.owner.boundAt } : conn.owner?.bound ? { masked: conn.owner.masked || '••••', boundAt: null } : null;
    return {
      ok: true,
      v: 1,
      ...tab,
      mode: cfg.mode,
      level,
      levelExpiresAt: level === 'autonomous' ? cfg.autonomousUntil : null,
      enabled: cfg.enabled,
      paused: cfg.paused,
      pausedBy: cfg.pausedBy,
      computerUse: cfg.computerUse === true,
      fake: fakeEnabled(),
      connector: {
        installed: !!inst.installed, version: inst.version ?? null, pinned: inst.pinned ?? null, outdated: !!inst.outdated, updateAvailable: !!inst.outdated,
        installedAt: inst.installedAt ?? null, approxSizeMB: inst.approxSizeMB ?? null, stage: state.install?.stage || null,
        errorCode: state.installError?.code || null, errorMessage: state.installError?.message || null, runtime: runtime.loaded ? { version: runtime.version, fake: runtime.fake } : null,
      },
      host: { state: host.state, restarts: host.restarts || 0 },
      account: conn.me ? { masked: conn.me.masked, name: conn.me.name ?? null } : null,
      owner,
      confirm,
      session: sessionView(sessionId),
      brainLimit: brainLimitView(cfg, sessionId),
      brainChoice: brainChoice(cfg),
      bridge: bridge ? { running: !!bridge.running, queued: bridge.queued || 0, pendingCards: bridge.pendingCards || 0, lastReplyAt: bridge.lastReplyAt || null } : null,
      connection: tab.state === 'reconnecting' ? { attempt: state.reconnectAttempt, nextRetryAt: Number.isFinite(conn.retryInMs) ? state.lastStateAt + conn.retryInMs : null } : null,
      counters: { ...(conn.counters || {}) },
      config: userView(cfg),
      version: cfg.version,
      escalation: escalationView(),
      manualCommand: `npm ${NPM_CI_ARGS.join(' ')}`,
      paths: { session: paths.authDir, connector: paths.runtimeDir, logs: paths.logsDir, installLog: paths.installLogPath },
      rev: state.rev,
    };
  }

  const ops = {
    status, setup, installConnector, cancelInstall, removeConnector, connectorLog,
    link, confirmOwner, claimOwner, resetOwner,
    test, pause, resume, reconnect, unlink, remove,
    getConfig, putConfig, listActivity, clearActivity, newSession,
    fakeEnabled, fake: fakeAction,
  };
  const router = createWhatsAppApi({ service: ops, isGuestRequest, port });

  return {
    router, start, shutdown, killNow, status,
    toSyncPayload,
    _internals: { state, config, ops, activity, record, tabState, handleAllow, flushBroadcast, manager, installer, paths, brainChoice },
  };
}

