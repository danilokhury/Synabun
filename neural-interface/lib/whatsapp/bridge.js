// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link: the bridge between the owner's chat and the Assistant
// ═══════════════════════════════════════════
//
// Owner messages become Assistant turns (runtime.submit, origin 'whatsapp');
// what the Assistant says, asks and decides comes back as WhatsApp text. The
// bridge only observes the runtime (runtime.observe: never a socket, so the
// panel's replay buffer and idle disposal stay the panel's) and answers
// through the same paths as the panel (answerControl, answerDispatchControl,
// stopTurn) with origin 'whatsapp'.
//
// Turns, per session: IDLE → SUBMITTING → RUNNING(wa) → FINALIZE for the
// owner's messages; a synabun.mailbox event is RUNNING(mailbox), a turn the
// CLI starts itself RUNNING(background), and a turn nobody here submitted (a
// prompt typed on the desktop) RUNNING(external) — tracked, never forwarded.
// The turn object exists before submit is called: brain events can arrive
// before it resolves.
//
// Any message carries the conversation on. While something waits for the
// owner (a question, an approval, a route, a plan, a worker's request), a
// clear answer answers it (cards.js); anything else is never an answer to
// wait behind: a question takes the owner's words as its answer, an approval
// closes WITHOUT being granted (denied, cancelled) and the message goes to the
// Assistant as the next prompt. An approval is only ever granted by a "yes"
// the bridge matched on a message the owner typed, aimed at that request while
// it is open: never by the model, by a forwarded message, by a reply that
// quotes something else or by anything that merely looks like an answer.
// Messages that arrive while a turn runs wait as one merged prompt and go in
// as soon as it ends; a queue watch lets go of a turn whose end never came.
// A request that appears while such a message waits closes at once, unseen and
// without a grant: text written before a request existed never answers it.
//
// Computer use: the owner's switch (config.computerUse) rides on the policy of
// the current conversation only; a retired conversation never drives the Mac.
// At Ask the runtime raises one "control your Mac for this?" request per turn:
// it is answered like every other approval here (a plain yes from the owner's
// phone grants it for that turn; anything else closes it without a grant).
// A route card for a computer task done here carries that question itself
// (cards.js routeControlsMac): one yes, and no second request in that turn.
// Computer control stopped at the Mac is told to the phone in one line.
//
// Sessions: "WhatsApp · <Mon D>", remote (lib/remote-policy.js) at the
// configured level, on the brain Settings → WhatsApp names (lib/whatsapp/
// brain.js; a changed choice switches the session's brain before the next
// message, like the panel's own model switch), rotated per config.rotation or
// /new — never silently on a budget refusal. Up to 3 retired sessions keep
// forwarding late results for 24 h. Transport, config, formatting and inbound
// composition are injected (Packages A and C); nothing here knows a phone number.

import { assistantEventKey } from '../../public/shared/assistant/asst-state.js';
import { brainCapsLevel, defaultRemotePolicyRegistry, effectiveLevel, remoteBrainNotice } from '../remote-policy.js';
import { brainSignature, resolveBrainChoice } from './brain.js';
import { answerCard, cardFromPacket, failClosedResponse, isBareAnswer, randomTag, renderCard } from './cards.js';
import { HELP_TEXT, SETTINGS_REFUSAL, parseCommand, statusText } from './commands.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const BRIDGE_LIMITS = Object.freeze({
  onItMs: 10_000,            // "On it…" when a turn is still running after this
  stillFirstMs: 90_000,      // first "Still working…"
  stillEveryMs: 5 * MINUTE,  // then every this long…
  stillMax: 3,               // …at most this many times
  narrationGapMs: 20_000,    // progress 'all': narration at least this far apart
  dispatchBatchMs: 30_000,   // "Started agent: …" notes are batched this long
  typingEveryMs: 20_000,     // typing presence refresh
  drainMs: 300,              // the next queued message goes this long after a turn ends
  busyRetryMs: 5_000,        // a busy refusal retries after this when no turn end comes
  watchdogMs: 30 * MINUTE,   // a turn nobody hears the end of is let go
  letGoMs: 20_000,           // a turn the runtime no longer runs, silent this long, is over (its end was missed)
  queueWatchMs: 5_000,       // while messages wait, the queue is tried again this often
  queueMax: 5,
  mergeChars: 12_000,        // messages that wait together go in as one prompt, up to this much text…
  mergeImages: 4,            // …and this many pictures
  staleMs: 10 * MINUTE,      // older when received: not acted on
  staleNoticeMs: 3_000,      // the "skipped N older messages" note waits for the burst to end
  unsupportedEveryMs: 10 * MINUTE,
  perMinute: 20,
  perDay: 300,
  idleRotateMs: 6 * HOUR,
  retiredKeepMs: 24 * HOUR,
  retiredMax: 3,
  forwardPerHour: 6,
  desktopAnsweredMs: 10 * MINUTE, // a number sent this soon after the desktop answered a card: "Already answered"
  outboxMax: 20,
  throttleRetryMs: 30_000,   // a THROTTLED send without a retryAfterMs is tried again after this
  policyTickMs: 30_000,
});

/** Send refusals that mean "not now": the reply waits in the outbox for the next connect. */
const RESEND_ON_CONNECT = /DISCONNECT|NOT_CONNECTED|OFFLINE|RECONNECT|CLOSED|TIMEOUT|HOST_UNAVAILABLE/i;
/**
 * What happens to a reply the transport refused: 'connect' (it waits for the
 * next connect), 'later' (THROTTLED: sent again after its retryAfterMs) or
 * 'drop'. PAUSED (an owner anomaly paused sending) and HELD (the connector
 * kept crashing) drop it: the service records why in the activity log and the
 * Settings tab shows the state.
 */
export function outboxPlan(code) {
  const value = String(code || '');
  if (value === 'THROTTLED') return 'later';
  return RESEND_ON_CONNECT.test(value) ? 'connect' : 'drop';
}

const DEFAULT_CONFIG = Object.freeze({
  enabled: true, level: 'ask', progress: 'key', forwardBackground: true, replyLabel: null, maxMessages: 3,
  rotation: 'idle6h', strictWorkerApprovals: false, computerUse: false, mode: 'self', paused: false, pausedBy: null, autonomousUntil: null,
});
const ALREADY_ANSWERED = new Set(['CONTROL_UNKNOWN', 'ROUTE_ALREADY_DECIDED', 'ROUTE_NOT_FOUND', 'CLARIFY_ALREADY_ANSWERED', 'CLARIFY_NOT_FOUND', 'PERMISSION_ALREADY_RESOLVED', 'NO_PENDING_REQUEST', 'RUN_NOT_FOUND']);
const ROUTE_DONE_PHASES = new Set(['decided', 'auto', 'expired', 'declined', 'cancelled']);
// What a worker is told when its request closes because the owner wrote something else.
const WORKER_MOVED_ON_NOTE = 'The user did not approve this on WhatsApp (they moved on to something else). Do not retry it: continue without it, or report it as blocked.';
const CLARIFY_DONE_PHASES = new Set(['answered', 'declined', 'chat', 'cancelled', 'expired']);
// Computer control was stopped at the Mac (Esc, the corner, the Stop button): one line to the phone.
export const MAC_STOP_TEXT = 'Computer control was stopped on your Mac: I am no longer controlling it.';
const usd = (value) => `$${(Number(value) || 0).toFixed(2)}`;
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const monthDay = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function tsMs(ts, fallback) { const n = Number(ts); if (!Number.isFinite(n) || n <= 0) return fallback; return n < 1e12 ? n * 1000 : n; }
/** The most recent 04:00 (local) at or before `ms`. */
function lastFourAm(ms) { const d = new Date(ms); d.setHours(4, 0, 0, 0); if (d.getTime() > ms) d.setDate(d.getDate() - 1); return d.getTime(); }

const globalTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

/**
 * @param {object} deps
 * @param {() => object} deps.getRuntime       the Assistant runtime (createAssistantRuntime)
 * @param {() => object} [deps.getDispatcher]  the dispatcher (runs of the session, /stop)
 * @param {object} deps.transport              { send(text,{replyTo}) → {ok,id}|{ok:false,code}, react(id, name|null), presence(state), markRead(ids), connected() }
 * @param {object} deps.config                 { read(), write(servicePatch) } (whatsapp_config)
 * @param {object} deps.format                 { toWhatsApp(md), chunk(text, {max, maxChunks, prefix, tail}) }
 * @param {object} deps.inbound                { composePrompt(parts, {rng}), createCoalescer({windowMs, maxImages, onFlush, timers}) }
 * @param {object} [deps.policy]               lib/remote-policy.js registry
 * @param {() => object|null} [deps.getDefaultBrain]  the brain the panel would start (its last used brain); null → the Assistant's default
 * @param {() => object|null} [deps.getCatalog]       the Assistant's model catalog ({ peek() }): checks the configured WhatsApp brain
 * @param {object} [deps.limits]               BRIDGE_LIMITS overrides (tests)
 */
export function createWhatsAppBridge({
  getRuntime,
  getDispatcher = () => null,
  transport,
  config,
  format,
  inbound,
  policy = defaultRemotePolicyRegistry,
  now = Date.now,
  timers = globalTimers,
  log = () => {},
  getDefaultBrain = null,
  getCatalog = null,
  rng = Math.random,
  limits: limitOverrides = {},
  // The capability that says "this is the owner's phone" (lib/remote-policy.js createPhoneAuthority),
  // handed over once by whoever builds the bridge. It lives in this closure only: never in `state`,
  // a card, a log line or anything returned. Presented where a grant can happen, nowhere else.
  authority: phoneAuthority = null,
} = {}) {
  if (typeof getRuntime !== 'function') throw new Error('createWhatsAppBridge requires getRuntime()');
  if (!transport?.send) throw new Error('createWhatsAppBridge requires transport.send');
  if (!config?.read) throw new Error('createWhatsAppBridge requires config.read');
  const L = { ...BRIDGE_LIMITS, ...(limitOverrides || {}) };
  const T = { ...globalTimers, ...(timers || {}) };

  const startCfg = readConfig();
  const bridgeState = startCfg.bridgeState && typeof startCfg.bridgeState === 'object' ? startCfg.bridgeState : {};
  const state = {
    sessionId: startCfg.sessionId || null,
    previous: [],                 // [{ id, until }] retired sessions whose results still forward
    queue: [],                    // prompt jobs waiting for the Assistant
    turns: new Map(),             // sessionId → turn
    cards: new Map(),             // key → card, in arrival order
    currentKey: null,
    cardByMessage: new Map(),     // WhatsApp message id → card key (quote-replies)
    closedCards: new Map(),       // key → { at, by } (recently closed)
    lastDesktopAnswerAt: 0,
    paused: startCfg.paused === true,
    pausedBy: startCfg.pausedBy || null,
    pausedNoticeSent: false,
    lastReplyAt: null,
    lastInboundId: null,
    lastActivityAt: Number(bridgeState.lastActivityAt) || null,
    rotateOnNextSubmit: false,
    inflight: bridgeState.inflight && typeof bridgeState.inflight === 'object' ? bridgeState.inflight : null,
    restartNotice: bridgeState.inflight || (Array.isArray(bridgeState.queuedIds) && bridgeState.queuedIds.length) ? { inflight: bridgeState.inflight || null, queued: (bridgeState.queuedIds || []).length } : null,
    outbox: [],
    outboxTimer: null,            // a THROTTLED reply's retry
    staleSkipped: 0,
    staleTimer: null,
    unsupportedAt: new Map(),
    minuteWindow: { start: 0, count: 0, noticed: false },
    dayWindow: { start: 0, count: 0, noticed: false },
    forwards: [],                 // timestamps of forwarded updates (last hour)
    forwardSuppressed: 0,
    forwardSummaryTimer: null,
    dispatchBatch: [],
    dispatchTimer: null,
    drainTimer: null,
    busyRetryTimer: null,
    policyTimer: null,
    policySeen: new Map(),        // sessionId → { signature, effective }
    followUp: null,               // { sessionId, at }: a card the phone saw was just decided
    queueTimer: null,             // tries the queue again while messages wait
    // { sessionId, signature }: the configured brain choice the session was last put on (brain.js).
    brainApplied: bridgeState.brainApplied && typeof bridgeState.brainApplied === 'object' ? { sessionId: String(bridgeState.brainApplied.sessionId || ''), signature: String(bridgeState.brainApplied.signature || 'assistant') } : null,
    starting: false,              // a job is between "not busy" and its turn: the next one waits
    flushed: null,                // the prompt a coalescer flushed while it was pushed
    buffered: 0,                  // messages inside the coalescer window (a coalescer without size())
    // "<session>:<provider>" the owner was told runs read-only because of its brain (once each).
    brainNotices: new Set(Array.isArray(bridgeState.brainNotices) ? bridgeState.brainNotices.map(String).slice(-20) : []),
    stopped: false,
  };
  const retired = bridgeState.retired && typeof bridgeState.retired === 'object' ? bridgeState.retired : {};
  for (const id of Array.isArray(startCfg.previousSessionIds) ? startCfg.previousSessionIds : []) {
    const sid = typeof id === 'string' ? id : id?.id;
    if (!sid) continue;
    const until = Number(retired[sid]) || Number(id?.until) || (now() + L.retiredKeepMs);
    if (until > now()) state.previous.push({ id: sid, until });
  }
  let runtimeRef = null;
  let unobserve = null;
  let unsubscribeRuntime = null;
  let coalescer = null;

  // ── config ─────────────────────────────────────────────────────────────────
  function readConfig() {
    let value = {};
    try { value = config.read() || {}; } catch (error) { log('whatsapp:bridge', `config read failed: ${error?.message || error}`); }
    return { ...DEFAULT_CONFIG, ...value };
  }
  function writeConfig(patch) {
    try { const result = config.write?.(patch); if (result && typeof result.catch === 'function') result.catch(() => {}); }
    catch (error) { log('whatsapp:bridge', `config write failed: ${error?.message || error}`); }
  }
  function persistBridgeState() {
    const retiredMap = Object.fromEntries(state.previous.map((row) => [row.id, row.until]));
    writeConfig({
      bridgeState: {
        inflight: state.inflight || null,
        queuedIds: state.queue.flatMap((job) => job.sourceIds || []),
        lastActivityAt: state.lastActivityAt || null,
        retired: retiredMap,
        brainNotices: [...state.brainNotices].slice(-20),
        brainApplied: state.brainApplied || null,
      },
    });
  }

  // ── runtime attachment ─────────────────────────────────────────────────────
  function runtime() {
    let rt = null;
    try { rt = getRuntime() || null; } catch { rt = null; }
    if (rt && rt !== runtimeRef) {
      try { unobserve?.(); } catch {}
      try { unsubscribeRuntime?.(); } catch {}
      runtimeRef = rt;
      unobserve = typeof rt.observe === 'function' ? rt.observe((message) => { try { onPacket(message); } catch (error) { log('whatsapp:bridge', `packet: ${error?.message || error}`); } }) : null;
      unsubscribeRuntime = typeof rt.subscribe === 'function' ? rt.subscribe((message) => { try { onRuntimeEvent(message); } catch {} }) : null;
      syncPolicies();
    }
    return rt;
  }
  function dispatcher() { try { return getDispatcher?.() || null; } catch { return null; } }
  function ours(sessionId) {
    if (!sessionId) return false;
    if (sessionId === state.sessionId) return true;
    return state.previous.some((row) => row.id === sessionId && row.until > now());
  }
  function sessionView(id) {
    const rt = runtime();
    if (!rt || !id) return null;
    try { return rt.getSession?.(id, { transcript: false }) || null; } catch { return null; }
  }
  /** The session's policy as the runtime sees it (its brainProvider included), else the registry's. */
  function policyOf(sessionId) {
    const rt = runtime();
    try { return rt?.sessionPolicy?.(sessionId) || policy?.getSessionPolicy?.(sessionId) || null; } catch { return null; }
  }
  function levelOf(sessionId) {
    const current = policyOf(sessionId);
    return current ? effectiveLevel(current, { now: now() }) : readConfig().level;
  }
  /**
   * Ask and Autonomous hold on a Claude brain only: a conversation on Codex or
   * OpenCode runs read-only, and the owner is told why once (per brain).
   */
  async function noticeBrainLimit(sessionId) {
    const current = policyOf(sessionId);
    const provider = current?.brainProvider || sessionView(sessionId)?.brain?.provider || null;
    if (!current || !provider || !brainCapsLevel(current, { provider, now: now() })) return;
    const key = `${sessionId}:${provider}`;
    if (state.brainNotices.has(key)) return;
    state.brainNotices.add(key);
    persistBridgeState();
    await say(remoteBrainNotice(provider), { maxChunks: 1 });
  }

  // ── sending ────────────────────────────────────────────────────────────────
  function prefix() {
    const cfg = readConfig();
    if (cfg.replyLabel) return String(cfg.replyLabel).trim();
    return cfg.mode === 'dedicated' ? '' : 'SynaBun:';
  }
  function isConnected() { try { return transport.connected ? transport.connected() !== false : true; } catch { return false; } }
  /**
   * Text to the owner, split per config. `markdown`: the Assistant's own words
   * (converted to WhatsApp formatting); `lead`: a line of ours put before them as is.
   * → the sent message ids.
   */
  async function say(text, { replyTo = null, markdown = false, maxChunks = null, lead = '', cardKey = null } = {}) {
    const body = String(text ?? '').trim();
    if (!body) return [];
    const cfg = readConfig();
    let converted = body;
    if (markdown && typeof format?.toWhatsApp === 'function') { try { converted = format.toWhatsApp(body) || body; } catch { converted = body; } }
    if (lead) converted = `${lead}\n${converted}`;
    let chunks = [converted];
    if (typeof format?.chunk === 'function') {
      try {
        chunks = format.chunk(converted, { max: 3500, maxChunks: maxChunks || Number(cfg.maxMessages) || 3, prefix: prefix() || undefined, tail: '… (the rest is in SynaBun on your computer)' }) || [converted];
      } catch { chunks = [converted]; }
    } else if (prefix()) {
      chunks = [`${prefix()} ${converted}`];
    }
    const ids = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const id = await sendRaw(chunks[i], { replyTo: i === 0 ? replyTo : null, cardKey });
      if (id) ids.push(id);
    }
    if (ids.length) { state.lastReplyAt = now(); state.lastActivityAt = now(); }
    return ids;
  }
  /** `cardKey`: the text is a request's message; it keeps that identity while it waits in the outbox. */
  async function sendRaw(text, { replyTo = null, cardKey = null } = {}) {
    if (!isConnected()) { queueOutbox(text, replyTo, null, null, cardKey); return null; }
    try {
      const result = await transport.send(text, replyTo ? { replyTo } : {});
      // Delivered: from here on the request it carries can be answered (replyToPending), and a quote of it names it.
      if (result?.ok) { if (cardKey && result.id) mapCardMessage(cardKey, result.id); return result.id || null; }
      if (result && result.ok === false) queueOutbox(text, replyTo, result.code, result.retryAfterMs, cardKey);
    } catch (error) { log('whatsapp:bridge', `send failed: ${error?.message || error}`); queueOutbox(text, replyTo, null, null, cardKey); }
    return null;
  }
  /** → true when the reply is waiting in the outbox, false when it was dropped (outboxPlan). */
  function queueOutbox(text, replyTo, code = null, retryAfterMs = null, cardKey = null) {
    const plan = code ? outboxPlan(code) : 'connect';
    if (plan === 'drop') return false;
    state.outbox.push({ text, replyTo, ...(cardKey ? { cardKey } : {}) });
    if (state.outbox.length > L.outboxMax) state.outbox.splice(0, state.outbox.length - L.outboxMax);
    if (plan === 'later') armOutboxRetry(retryAfterMs);
    return true;
  }
  /** THROTTLED: try the outbox again once the send caps free up (a connect flushes it sooner). */
  function armOutboxRetry(retryAfterMs) {
    if (state.outboxTimer || state.stopped) return;
    const wait = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0 ? Number(retryAfterMs) + 250 : L.throttleRetryMs;
    state.outboxTimer = T.setTimeout(() => {
      state.outboxTimer = null;
      if (!state.stopped && isConnected()) flushOutbox().catch((error) => log('whatsapp:bridge', `outbox: ${error?.message || error}`));
    }, wait);
    state.outboxTimer?.unref?.();
  }
  async function flushOutbox() {
    if (state.outboxTimer) { T.clearTimeout(state.outboxTimer); state.outboxTimer = null; }
    const pending = state.outbox.splice(0, state.outbox.length);
    for (let i = 0; i < pending.length; i += 1) {
      const { text, replyTo, cardKey = null } = pending[i];
      // A request that closed while its message waited is not asked late.
      if (cardKey && !state.cards.has(cardKey)) continue;
      const before = state.outbox.length;
      const id = await sendRaw(text, { replyTo, cardKey });
      // Delivered by the retry: a reply that quotes it is aimed at that request, like one sent at once.
      if (id && cardKey) mapCardMessage(cardKey, id);
      // Refused again and back in line (offline, throttled): the rest keeps its order behind it.
      if (state.outbox.length > before) {
        state.outbox.push(...pending.slice(i + 1));
        if (state.outbox.length > L.outboxMax) state.outbox.splice(0, state.outbox.length - L.outboxMax);
        return;
      }
    }
  }
  function react(ids, name) {
    for (const id of ids || []) { try { const r = transport.react?.(id, name); if (r?.catch) r.catch(() => {}); } catch {} }
  }
  function presence(value) { try { const r = transport.presence?.(value); if (r?.catch) r.catch(() => {}); } catch {} }

  // ── sessions ───────────────────────────────────────────────────────────────
  function defaultBrain() {
    let brain = null;
    try { brain = typeof getDefaultBrain === 'function' ? getDefaultBrain() : null; } catch { brain = null; }
    return brain && typeof brain === 'object' ? { ...brain } : {};
  }
  /** The brain Settings → WhatsApp names now: the stored choice, else the panel's (a disabled or unknown choice falls back). */
  function brainTarget() {
    let catalog = null;
    try { catalog = (typeof getCatalog === 'function' ? getCatalog() : null)?.peek?.() || null; } catch { catalog = null; }
    return resolveBrainChoice(readConfig().brain || null, { catalog, panelBrain: defaultBrain() });
  }
  /**
   * The choice changed since this session was last put on it: switch the
   * session's brain before its next turn (runtime.updateSession, what the
   * panel's model switch calls). A model or effort change keeps the provider's
   * conversation; another provider starts its own inside the same session.
   * "Same as the Assistant" is read when a conversation starts and when the
   * setting changes: the panel picking another model later does not move a
   * conversation that is under way.
   */
  async function applyBrainChoice(sessionId) {
    const target = brainTarget();
    const signature = brainSignature(target);
    const applied = state.brainApplied?.sessionId === sessionId ? state.brainApplied.signature : 'assistant';
    if (signature === applied) return;
    const rt = runtime();
    const want = target.brain || {};
    const have = sessionView(sessionId)?.brain || {};
    // The effort is part of the choice in both directions: an explicit effort must not outlive
    // the choice when "Same as the Assistant" names the same model at another (or the default) effort.
    const effortOf = (brain) => (brain.effort && brain.effort !== 'off' ? brain.effort : null);
    const differs = want.provider && (want.provider !== have.provider || (want.model && want.model !== have.model) || effortOf(want) !== effortOf(have));
    if (differs && rt?.updateSession) {
      try {
        // "off" is the explicit reset to the model's default effort (a missing effort would keep the old one).
        await rt.updateSession(sessionId, { brain: { provider: want.provider, ...(want.model ? { model: want.model } : {}), effort: effortOf(want) || 'off' } });
        log('whatsapp:bridge', `session ${sessionId}: brain set to ${want.provider}${want.model ? `/${want.model}` : ''} (${target.source === 'choice' ? 'the WhatsApp setting' : 'same as the Assistant'})`);
      } catch (error) {
        // Not applied (the model was disabled meanwhile, the runtime refused): the conversation stays on its brain; tried again at the next message.
        log('whatsapp:bridge', `session ${sessionId}: brain not switched: ${error?.message || error}`);
        return;
      }
    }
    state.brainApplied = { sessionId, signature };
    persistBridgeState();
  }
  function remoteFromConfig(cfg = readConfig()) {
    return { channel: 'whatsapp', level: cfg.level || 'ask', strictWorkerApprovals: cfg.strictWorkerApprovals === true, autonomousUntil: cfg.autonomousUntil || null, paused: state.paused, computerUse: cfg.computerUse === true && state.computerEnded !== true };
  }
  /** The policy of one of our sessions: computer use is the current conversation's alone. */
  function remoteFor(id, base = remoteFromConfig()) {
    return id === state.sessionId ? base : { ...base, computerUse: false };
  }
  const policySignature = (remote) => JSON.stringify([remote.level, remote.strictWorkerApprovals, remote.autonomousUntil, remote.paused, remote.computerUse]);
  async function createSession() {
    const rt = runtime();
    if (!rt?.createSession) throw Object.assign(new Error('The Assistant is not available right now.'), { code: 'RUNTIME_UNAVAILABLE' });
    const target = brainTarget();
    const session = await rt.createSession(
      { brain: target.brain, label: `WhatsApp · ${monthDay(now())}`, fallback: true, channel: 'whatsapp' },
      { remote: remoteFromConfig() },
    );
    state.sessionId = session.id;
    state.brainApplied = { sessionId: session.id, signature: brainSignature(target) };
    state.policySeen.delete(session.id);
    syncPolicies();
    writeConfig({ sessionId: session.id, previousSessionIds: state.previous.map((row) => row.id) });
    persistBridgeState();
    log('whatsapp:bridge', `session ${session.id} started`);
    return session.id;
  }
  function retire(id) {
    if (!id) return;
    state.previous = [{ id, until: now() + L.retiredKeepMs }, ...state.previous.filter((row) => row.id !== id && row.until > now())].slice(0, L.retiredMax);
    // Cards of a retired conversation are no longer the phone's to answer.
    for (const card of [...state.cards.values()]) if (card.sessionId === id) closeCard(card, 'retired', { quiet: true });
    // …and it stops driving the Mac now, not at the next sync: its policy loses computer use at once.
    if (policy?.registerSessionPolicy) {
      const remote = { ...remoteFromConfig(), computerUse: false };
      try { policy.registerSessionPolicy(id, remote); state.policySeen.set(id, { signature: policySignature(remote), effective: effectiveLevel({ ...remote }, { now: now() }) }); }
      catch (error) { log('whatsapp:bridge', `policy ${id}: ${error?.message || error}`); state.policySeen.delete(id); }
    }
  }
  async function newSession(reason = 'command') {
    const old = state.sessionId;
    retire(old);
    state.sessionId = null;
    state.rotateOnNextSubmit = false;
    const id = await createSession();
    log('whatsapp:bridge', `new session (${reason})${old ? `, retired ${old}` : ''}`);
    return id;
  }
  function rotationDue(activityBefore) {
    const cfg = readConfig();
    if (!state.sessionId || !activityBefore) return false;
    if (cfg.rotation === 'never') return false;
    if (cfg.rotation === 'daily') return activityBefore < lastFourAm(now());
    return now() - activityBefore > L.idleRotateMs;
  }
  /** The session the next prompt goes to (created, or rotated, when needed). */
  async function ensureSession() {
    const view = state.sessionId ? sessionView(state.sessionId) : null;
    if (state.sessionId && (!view || view.status === 'ended')) { state.sessionId = null; }
    if (state.sessionId && state.rotateOnNextSubmit) { retire(state.sessionId); state.sessionId = null; }
    state.rotateOnNextSubmit = false;
    return state.sessionId || createSession();
  }

  // ── policy ─────────────────────────────────────────────────────────────────
  /**
   * Keep the level of every WhatsApp session in line with the config (level,
   * strict approvals, the autonomous window, pause). A change — or an
   * autonomous window that just ran out — re-registers, which makes the
   * runtime re-apply the clamp and stop runs above it.
   */
  function syncPolicies() {
    const cfg = readConfig();
    applyPause(cfg);
    if (!policy?.registerSessionPolicy) return;
    const ids = [state.sessionId, ...state.previous.filter((row) => row.until > now()).map((row) => row.id)].filter(Boolean);
    const base = remoteFromConfig(cfg);
    for (const id of ids) {
      const remote = remoteFor(id, base);
      const signature = policySignature(remote);
      const effective = effectiveLevel({ ...remote }, { now: now() });
      const seen = state.policySeen.get(id);
      const registered = policy.getSessionPolicy?.(id);
      if (seen && seen.signature === signature && seen.effective === effective && registered && !registered.failClosed) continue;
      try { policy.registerSessionPolicy(id, remote); } catch (error) { log('whatsapp:bridge', `policy ${id}: ${error?.message || error}`); continue; }
      state.policySeen.set(id, { signature, effective });
    }
  }
  /** Pause lives in the config (Settings can pause and resume too): follow it. */
  function applyPause(cfg) {
    const paused = cfg.paused === true;
    if (paused !== state.paused) {
      state.paused = paused;
      state.pausedBy = paused ? (cfg.pausedBy || 'desktop') : null;
      state.pausedNoticeSent = false;
      if (!paused && state.queue.length) scheduleDrain(L.drainMs);
    } else if (paused && cfg.pausedBy) {
      state.pausedBy = cfg.pausedBy;
    }
  }

  // ── turns ──────────────────────────────────────────────────────────────────
  function makeTurn(sessionId, kind, extra = {}) {
    const turn = {
      sessionId, kind, state: kind === 'wa' ? 'SUBMITTING' : 'RUNNING', startedAt: now(), lastPacketAt: now(), sourceIds: [], replyTo: null,
      segments: [], seen: new Set(), resultText: null, resultError: null, endedEarly: null, repliedProgress: false,
      lastProgressAt: 0, stillCount: 0, timers: new Set(), intervals: new Set(), memoryOnly: false, stoppedByPhone: false,
      ...extra,
    };
    state.turns.set(sessionId, turn);
    arm(turn, L.watchdogMs, () => { if (state.turns.get(sessionId) === turn) finalizeTurn(sessionId, 'watchdog'); });
    return turn;
  }
  function arm(turn, ms, fn) {
    const id = T.setTimeout(() => { turn.timers.delete(id); try { fn(); } catch (error) { log('whatsapp:bridge', `timer: ${error?.message || error}`); } }, ms);
    turn.timers.add(id);
    return id;
  }
  function disarm(turn) {
    for (const id of turn.timers) T.clearTimeout(id);
    for (const id of turn.intervals) T.clearInterval(id);
    turn.timers.clear();
    turn.intervals.clear();
  }
  function ensureTurn(sessionId, kind = 'external') {
    return state.turns.get(sessionId) || makeTurn(sessionId, kind === 'external' && followUpFor(sessionId) ? 'followup' : kind);
  }
  /**
   * A route or clarify card of the phone's was just decided: the turn that
   * carries the task on (a continuation, the mailbox) answers the phone.
   */
  function followUpFor(sessionId) {
    const f = state.followUp;
    if (!f || f.sessionId !== sessionId) return null;
    if (now() - f.at > 5 * MINUTE) { state.followUp = null; return null; }
    return f;
  }
  /** The progress notes and the typing presence of a turn the owner is waiting for. */
  function startProgress(turn) {
    const cfg = readConfig();
    presence('composing');
    const typing = T.setInterval(() => { if (state.turns.get(turn.sessionId) === turn) presence('composing'); }, L.typingEveryMs);
    turn.intervals.add(typing);
    if (cfg.progress === 'off') return;
    // Nothing to say while the turn waits for the owner's own answer on a card.
    arm(turn, L.onItMs, () => {
      if (state.turns.get(turn.sessionId) !== turn || turn.repliedProgress || hasOpenCards(turn.sessionId)) return;
      turn.repliedProgress = true;
      turn.lastProgressAt = now();
      say('On it…', { maxChunks: 1 });
    });
    const still = () => {
      if (state.turns.get(turn.sessionId) !== turn || turn.stillCount >= L.stillMax) return;
      if (!hasOpenCards(turn.sessionId)) {
        turn.stillCount += 1;
        turn.lastProgressAt = now();
        say('Still working…', { maxChunks: 1 });
      }
      if (turn.stillCount < L.stillMax) arm(turn, L.stillEveryMs, still);
    };
    arm(turn, L.stillFirstMs, still);
  }
  function addSegment(turn, event) {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const text = blocks.filter((block) => block?.type === 'text' && block.text).map((block) => block.text).join('\n').trim();
    if (!text) return;
    // progress 'all': the previous top-level segment was narration.
    const cfg = readConfig();
    if (turn.kind === 'wa' && cfg.progress === 'all' && turn.segments.length && now() - turn.lastProgressAt >= L.narrationGapMs) {
      const previous = turn.segments[turn.segments.length - 1];
      if (previous && !turn.narrated?.has(previous)) {
        turn.narrated = turn.narrated || new Set();
        turn.narrated.add(previous);
        turn.lastProgressAt = now();
        turn.repliedProgress = true;
        say(previous, { markdown: true, maxChunks: 1 });
      }
    }
    turn.segments.push(text);
  }
  /**
   * The answer to send: the result's text, else the last text blocks. "Smart":
   * a short closing line after an earlier long segment carries that segment too.
   */
  function finalText(turn) {
    const segments = turn.segments.filter(Boolean);
    const result = typeof turn.resultText === 'string' ? turn.resultText.trim() : '';
    const final = result || segments[segments.length - 1] || '';
    if (!final) return '';
    if (final.length < 200) {
      const earlier = segments.filter((segment) => segment !== final && segment.length >= 280);
      const lead = earlier[earlier.length - 1];
      if (lead && !turn.narrated?.has(lead)) return `${lead}\n\n${final}`;
    }
    return final;
  }
  function closeBrainCards(sessionId) {
    for (const card of [...state.cards.values()]) {
      if (card.sessionId === sessionId && card.source === 'brain') closeCard(card, 'turn_ended', { quiet: true });
    }
  }
  async function finalizeTurn(sessionId, outcome = 'done', { message = null } = {}) {
    const turn = state.turns.get(sessionId);
    if (!turn) return;
    if (turn.state === 'SUBMITTING' && outcome !== 'watchdog') { turn.endedEarly = { outcome, message }; return; }
    state.turns.delete(sessionId);
    turn.state = 'FINALIZE';
    disarm(turn);
    closeBrainCards(sessionId);
    // The owner wrote something else while this turn waited for them (moveOn, or a request
    // that came after their message): their message is next. The brain was told to end with
    // no text unless it has a result (MOVED_ON_NOTE), so what it still says is forwarded as
    // it is, whatever its length. Only a turn that ends with nothing to say closes quietly:
    // no "Done.", no "Stopped.".
    const movedOn = turn.superseded === true && (outcome === 'done' || outcome === 'stopped') && !finalText(turn) && !turn.resultError;
    if (movedOn && (turn.kind === 'wa' || turn.kind === 'followup')) {
      if (turn.kind === 'followup') state.followUp = null;
      else { presence('paused'); state.inflight = null; persistBridgeState(); react(turn.sourceIds, 'done'); }
    } else if (turn.kind === 'followup') {
      // The task the phone decided on a card: its answer is a reply, not an update.
      state.followUp = null;
      const text = finalText(turn);
      if (outcome === 'failed') await say(`Something went wrong: ${String(message || turn.resultError || 'the turn failed').slice(0, 400)}`, { maxChunks: 1 });
      else if (text && outcome !== 'stopped') await say(text, { markdown: true });
    } else if (turn.kind === 'wa') {
      presence('paused');
      state.inflight = null;
      persistBridgeState();
      const text = finalText(turn);
      if (outcome === 'watchdog') {
        if (text) await say(text, { markdown: true, replyTo: turn.replyTo });
        await say('This is taking longer than 30 minutes, so I stopped waiting here. Check SynaBun on your computer for the result.', { maxChunks: 1 });
        react(turn.sourceIds, 'failed');
      } else if (outcome === 'failed') {
        if (text) await say(text, { markdown: true, replyTo: turn.replyTo });
        await say(`Something went wrong: ${String(message || turn.resultError || 'the turn failed').slice(0, 400)}`, { maxChunks: 1 });
        react(turn.sourceIds, 'failed');
      } else if (outcome === 'stopped') {
        // Stopped at the Mac: its one line was already said (onComputer); what the Assistant had to say still goes.
        if (turn.stoppedOnMac) { if (text) await say(text, { markdown: true, replyTo: turn.replyTo }); }
        else if (!turn.stoppedByPhone) await say(text ? `${text}\n\n(Stopped.)` : 'Stopped.', { markdown: !!text, replyTo: turn.replyTo });
        react(turn.sourceIds, 'stopped');
      } else {
        if (text) await say(text, { markdown: true, replyTo: turn.replyTo });
        else if (turn.resultError) await say(`The Assistant stopped (${turn.resultError}). Check SynaBun on your computer.`, { maxChunks: 1, replyTo: turn.replyTo });
        else if (!hasOpenCards(sessionId)) await say('Done.', { maxChunks: 1, replyTo: turn.replyTo });
        react(turn.sourceIds, turn.resultError ? 'failed' : 'done');
      }
    } else if ((turn.kind === 'mailbox' || turn.kind === 'background') && outcome === 'done') {
      forwardUpdate(turn);
    }
    if (sessionId === state.sessionId) scheduleDrain(L.drainMs);
  }
  function hasOpenCards(sessionId) { for (const card of state.cards.values()) if (card.sessionId === sessionId) return true; return false; }

  // ── forwarding results ─────────────────────────────────────────────────────
  function forwardUpdate(turn) {
    const cfg = readConfig();
    if (cfg.forwardBackground === false || turn.memoryOnly) return;
    const text = finalText(turn);
    if (!text) return;
    state.forwards = state.forwards.filter((at) => now() - at < HOUR);
    if (state.forwards.length >= L.forwardPerHour) {
      state.forwardSuppressed += 1;
      if (!state.forwardSummaryTimer) {
        const wait = Math.max(1000, HOUR - (now() - state.forwards[0]));
        state.forwardSummaryTimer = T.setTimeout(() => {
          state.forwardSummaryTimer = null;
          const n = state.forwardSuppressed;
          state.forwardSuppressed = 0;
          if (n > 0) say(`${n} more update${n === 1 ? '' : 's'} in SynaBun.`, { maxChunks: 1 });
        }, wait);
      }
      return;
    }
    state.forwards.push(now());
    const previous = turn.sessionId !== state.sessionId ? ' (earlier conversation)' : '';
    say(text, { markdown: true, lead: `*Update*${previous}` });
  }

  // ── runtime packets ────────────────────────────────────────────────────────
  function onRuntimeEvent(message) {
    if (message?.type !== 'assistant:session-ended') return;
    const id = message.session?.id;
    if (id && id === state.sessionId) { state.sessionId = null; log('whatsapp:bridge', `session ${id} ended; the next message starts a new one`); }
  }
  function onPacket({ sessionId, packet } = {}) {
    if (state.stopped || !packet || !ours(sessionId)) return;
    const type = packet.type;
    const live = state.turns.get(sessionId);
    if (live) live.lastPacketAt = now();
    if (type === 'event') { onEvent(sessionId, packet.event || {}, packet); return; }
    if (type === 'control_request') { onCard(sessionId, packet); return; }
    if (type === 'control_cancelled') { onCardClosed(sessionId, String(packet.request_id ?? ''), packet.reason === 'timeout' ? 'timeout' : 'cancelled'); return; }
    if (type === 'control_resolved') { onCardClosed(sessionId, String(packet.request_id ?? ''), packet.origin === 'whatsapp' ? 'answered' : 'desktop'); return; }
    if (type === 'turn_started') { if (!state.turns.has(sessionId)) makeTurn(sessionId, 'background'); return; }
    if (type === 'done') { finalizeTurn(sessionId, 'done'); return; }
    if (type === 'aborted') { finalizeTurn(sessionId, 'stopped'); return; }
    if (type === 'error') {
      // An error ends a turn only when nothing runs any more (a refused mailbox
      // turn, a failed start); a brain still busy carries on. Checked again shortly.
      const turn = state.turns.get(sessionId);
      if (!turn) return;
      const check = (left) => {
        if (state.turns.get(sessionId) !== turn || turn.state === 'SUBMITTING') return;
        let busy = false;
        try { busy = !!runtime()?.isBusy?.(sessionId); } catch { busy = false; }
        if (!busy) { finalizeTurn(sessionId, 'failed', { message: packet.message || null }); return; }
        if (left > 0) arm(turn, 1000, () => check(left - 1));
      };
      check(5);
      return;
    }
    if (type === 'assistant:dispatch') { onDispatch(sessionId, packet); return; }
    if (type === 'assistant:computer') { onComputer(sessionId, packet); }
  }
  /**
   * Computer control of this conversation was stopped at the Mac: the phone
   * hears it once, in one line (the turn that was stopped adds no "Stopped.").
   * A turn typed on the desktop is the desktop's: the person is at the Mac.
   */
  function onComputer(sessionId, packet) {
    if (packet.phase !== 'stopped' || packet.by !== 'mac') return;
    const turn = state.turns.get(sessionId);
    if (turn?.kind === 'external' || turn?.stoppedOnMac) return;
    if (turn) turn.stoppedOnMac = true;
    say(MAC_STOP_TEXT, { maxChunks: 1 });
  }
  function onEvent(sessionId, ev, packet) {
    switch (ev.type) {
      case 'synabun.user_prompt':
        // Our own prompt (the WhatsApp turn exists already); any other is someone else's turn.
        if (ev.origin !== 'whatsapp' && !state.turns.has(sessionId)) makeTurn(sessionId, 'external');
        return;
      case 'synabun.mailbox': {
        const items = Array.isArray(ev.items) ? ev.items : [];
        const turn = state.turns.get(sessionId);
        const memoryOnly = items.length > 0 && items.every((item) => item?.kind === 'memory_due');
        const kind = followUpFor(sessionId) && !memoryOnly ? 'followup' : 'mailbox';
        if (!turn) makeTurn(sessionId, kind, { memoryOnly });
        else if (turn.kind !== 'wa' && turn.kind !== 'followup') { turn.kind = kind; turn.memoryOnly = memoryOnly; }
        return;
      }
      case 'assistant': {
        if (ev.parent_tool_use_id) return;
        const turn = ensureTurn(sessionId, 'external');
        const key = assistantEventKey(ev);
        if (turn.seen.has(key)) return;
        turn.seen.add(key);
        addSegment(turn, ev);
        return;
      }
      case 'result': {
        if (ev.parent_tool_use_id) return;
        const turn = ensureTurn(sessionId, 'external');
        if (typeof ev.result === 'string' && ev.result.trim()) turn.resultText = ev.result;
        if (ev.is_error === true || /^error/.test(String(ev.subtype || ''))) turn.resultError = String(ev.subtype || 'error');
        return;
      }
      case 'synabun.dispatch_control_request':
        onCard(sessionId, packet);
        return;
      case 'synabun.dispatch_control_resolved':
        onCardClosed(sessionId, String(ev.request_id ?? ''), ev.resolvedBy === 'whatsapp' ? 'answered' : 'desktop', { runId: ev.runId });
        return;
      case 'synabun.route': {
        const routeId = ev.route?.routeId;
        if (!routeId || !ROUTE_DONE_PHASES.has(ev.phase)) return;
        for (const card of [...state.cards.values()]) {
          if (card.sessionId === sessionId && card.route?.routeId === routeId && !card.answering) closeCard(card, ev.phase === 'expired' ? 'expired' : 'desktop');
        }
        return;
      }
      case 'synabun.clarify': {
        const requestId = ev.brief?.round?.requestId ? String(ev.brief.round.requestId) : '';
        if (!requestId || !CLARIFY_DONE_PHASES.has(ev.phase)) return;
        // 'chat': a prompt (the phone's own, or the desktop's) settled the questions; nothing was answered elsewhere.
        onCardClosed(sessionId, requestId, ev.phase === 'chat' || ev.phase === 'cancelled' ? 'moved_on' : 'desktop');
        return;
      }
      default:
    }
  }
  function onDispatch(sessionId, packet) {
    if (packet.reason !== 'started' || !packet.run) return;
    const cfg = readConfig();
    if (cfg.progress === 'off' || state.turns.get(sessionId)?.kind === 'external') return;
    const run = packet.run;
    state.dispatchBatch.push(`Started agent: ${String(run.title || run.task || 'a task').slice(0, 80)} (${run.provider || 'agent'}${run.model ? `/${run.model}` : ''})`);
    if (state.dispatchTimer) return;
    state.dispatchTimer = T.setTimeout(() => {
      state.dispatchTimer = null;
      const lines = state.dispatchBatch.splice(0, state.dispatchBatch.length);
      if (lines.length) say(lines.join('\n'), { maxChunks: 1 });
    }, L.dispatchBatchMs);
  }

  // ── cards ──────────────────────────────────────────────────────────────────
  function onCard(sessionId, packet) {
    // A desktop turn's cards are the desktop's, except the request to control the Mac: in a
    // WhatsApp conversation only the owner's phone can grant that, whoever started the turn.
    const turn = state.turns.get(sessionId);
    const card = cardFromPacket(packet, { sessionId, level: levelOf(sessionId), now: now() });
    if (turn?.kind === 'external' && card?.kind !== 'computer') return;
    if (!card || state.cards.has(card.key) || state.closedCards.has(card.key)) return;
    // The owner already wrote something newer than this request: they moved on from the turn
    // that asks (moveOn), or a message of theirs waits for it to end (queued, or still inside
    // the coalescer window). The request closes at once without a grant, unseen: an approval is
    // denied, a question is cancelled (text written before it existed is not its answer), and
    // the waiting message is the next prompt. A worker's own request is still theirs to
    // answer: it holds no turn, so no message waits behind it. Only the conversation the
    // waiting message goes to counts: an earlier conversation's request holds nothing.
    if (card.source !== 'dispatch' && (turn?.superseded || (sessionId === state.sessionId && messageWaiting()))) {
      if (turn) turn.superseded = true;
      state.closedCards.set(card.key, { at: now(), by: 'moved_on' });
      failClose(card).catch(() => {});
      return;
    }
    state.cards.set(card.key, card);
    if (!state.currentKey) showNextCard();
  }
  /** A phone message is on its way to the Assistant: inside the coalescer window, in the queue, or being started. */
  function messageWaiting() {
    if (state.queue.length > 0 || state.starting) return true;
    let held = null;
    try { held = coalescer?.size?.(); } catch { held = null; }
    return (Number.isFinite(held) ? held : state.buffered) > 0;
  }
  function currentCard() { return state.currentKey ? state.cards.get(state.currentKey) || null : null; }
  function showNextCard({ replaced = false } = {}) {
    if (state.currentKey && state.cards.has(state.currentKey)) return;
    state.currentKey = null;
    const next = state.cards.values().next().value;
    if (!next) return;
    state.currentKey = next.key;
    // Several open requests, or one right after another was answered elsewhere: a code says which one a reply means.
    if (!next.tag && (state.cards.size > 1 || (replaced && now() - state.lastDesktopAnswerAt < MINUTE))) next.tag = randomTag(rng);
    sendCard(next);
  }
  async function sendCard(card) {
    const text = renderCard(card, { formatPlan: (plan) => { try { return format?.toWhatsApp ? format.toWhatsApp(plan) : plan; } catch { return plan; } } });
    const ids = await say(text, { maxChunks: card.kind === 'plan' ? null : 1, cardKey: card.key });
    for (const id of ids) mapCardMessage(card.key, id);
  }
  /** A WhatsApp message id is a request's message: a quote of it names that request (open, or closed by now). */
  function mapCardMessage(cardKey, id) {
    state.cardByMessage.set(id, cardKey);
    const card = state.cards.get(cardKey);
    if (card && !card.messageIds.includes(id)) card.messageIds.push(id);
  }
  function findCard(sessionId, requestId, runId = null) {
    for (const card of state.cards.values()) {
      if (card.sessionId === sessionId && card.requestId === requestId && (!runId || card.runId === runId)) return card;
    }
    return null;
  }
  function onCardClosed(sessionId, requestId, reason, { runId = null } = {}) {
    const card = findCard(sessionId, requestId, runId);
    if (!card || card.answering) return;
    if (reason === 'desktop') state.lastDesktopAnswerAt = now();
    closeCard(card, reason);
  }
  function closeCard(card, reason, { quiet = false, next = true } = {}) {
    state.closedCards.set(card.key, { at: now(), by: reason });
    if (state.closedCards.size > 100) state.closedCards.delete(state.closedCards.keys().next().value);
    if (!state.cards.delete(card.key)) return;
    const wasCurrent = state.currentKey === card.key;
    if (wasCurrent) state.currentKey = null;
    // A route or clarify card the phone saw was decided (here or on the desktop): what follows answers the phone.
    if ((card.kind === 'route' || card.kind === 'clarify') && (reason === 'answered' || reason === 'desktop')) {
      state.followUp = { sessionId: card.sessionId, at: now() };
    }
    if (!quiet && reason === 'timeout' && wasCurrent) {
      const minutes = Math.max(1, Math.round((now() - card.createdAt) / MINUTE));
      say(`No answer in ${minutes} min — declined.`, { maxChunks: 1 });
    } else if (!quiet && reason === 'expired' && wasCurrent) {
      say('That choice expired without an answer.', { maxChunks: 1 });
    }
    if (wasCurrent && next) showNextCard({ replaced: reason === 'desktop' });
  }
  /**
   * Close a request without granting anything, because the owner wrote
   * something else: a denial (permission, question, plan), a cancelled route or
   * clarify round. Through the same paths as an answer, with origin 'whatsapp',
   * so the desktop card locks as resolved. Never an approval.
   */
  async function failClose(card) {
    const rt = runtime();
    card.answering = true;
    try {
      // `superseded` travels as the caller's option: the runtime never takes it from a response.
      const { superseded: _superseded, ...response } = failClosedResponse(card, card.source === 'dispatch' ? WORKER_MOVED_ON_NOTE : undefined) || {};
      if (rt && card.source === 'dispatch') rt.answerDispatchControl(card.sessionId, card.runId, card.requestId, response, { origin: 'whatsapp' });
      else if (rt) await rt.answerControl(card.sessionId, card.requestId, response, { origin: 'whatsapp', superseded: true });
    } catch (error) {
      log('whatsapp:bridge', `closing ${card.requestId}: ${error?.message || error}`);
    } finally { card.answering = false; }
    closeCard(card, 'moved_on', { quiet: true, next: false });
  }
  /** The open requests of a session the bridge is not showing (a desktop turn's, or raised before this bridge started). */
  function untrackedPending(sessionId) {
    const rt = runtime();
    if (!rt?.pendingControls || !sessionId) return [];
    let packets = [];
    try { packets = rt.pendingControls(sessionId) || []; } catch { packets = []; }
    const out = [];
    for (const packet of packets) {
      const card = cardFromPacket(packet, { sessionId, level: levelOf(sessionId), now: now() });
      if (card && !state.cards.has(card.key)) out.push(card);
    }
    return out;
  }
  /**
   * The owner wrote something that answers nothing that waits: every open
   * request closes without a grant and the turn that asked is marked, so the
   * message that follows is never held behind it. Nothing is approved here.
   */
  async function moveOn() {
    // Only the conversation the next prompt goes to: a late request of an earlier conversation
    // (a worker of it) is not this message's to close; it stays open and is shown when its turn comes.
    const open = [...[...state.cards.values()].filter((card) => card.sessionId === state.sessionId), ...untrackedPending(state.sessionId)];
    const closed = await closeWithoutGrant(open);
    if (!state.currentKey) showNextCard();
    return closed;
  }
  async function closeWithoutGrant(open) {
    // Marked first: what the turn asks while these close (the brain trying something else) closes the same way (onCard).
    for (const card of open) {
      if (card.source === 'dispatch') continue;
      const turn = state.turns.get(card.sessionId);
      if (turn && turn.kind !== 'external') turn.superseded = true;
    }
    for (const card of open) await failClose(card);
    return open.length;
  }
  /** Open requests that hold the conversation the next prompt goes to (a worker's own request holds no turn). */
  function holdingCards() {
    return [...state.cards.values()].filter((card) => card.source !== 'dispatch' && card.sessionId === state.sessionId);
  }
  /** → true when the message was used up as an answer; false when it goes on as a prompt. */
  async function answer(card, result, message) {
    const rt = runtime();
    if (!rt) { await say('The Assistant is not available right now.', { maxChunks: 1 }); return true; }
    card.answering = true;
    let outcome;
    try {
      outcome = card.source === 'dispatch'
        ? rt.answerDispatchControl(card.sessionId, card.runId, card.requestId, result.response, { origin: 'whatsapp' })
        : await rt.answerControl(card.sessionId, card.requestId, result.response, { origin: 'whatsapp', authority: phoneAuthority });
    } catch (error) {
      outcome = { ok: false, code: error?.code || 'ANSWER_FAILED', message: error?.message || String(error) };
    } finally {
      card.answering = false;
    }
    if (outcome?.ok) {
      react([message?.id].filter(Boolean), 'done');
      closeCard(card, 'answered', { quiet: true });
      const ack = ackText(card, result);
      if (ack) await say(ack, { maxChunks: 1 });
      return true;
    }
    if (ALREADY_ANSWERED.has(outcome?.code)) {
      // Someone else answered it while this answer was on its way (the desktop won the race for
      // the same request). A bare answer gets the note. A message that says more ("use Opus",
      // "no, use staging") is the owner's next message: what is still open closes without a
      // grant and it goes on as a prompt. Nothing is granted on this path.
      const bare = isBareAnswer(message?.text);
      closeCard(card, 'desktop', { quiet: true, next: bare });
      if (bare) { await say('Already answered in SynaBun.', { maxChunks: 1 }); return true; }
      await moveOn();
      return false;
    }
    await say(`That answer did not go through: ${String(outcome?.message || outcome?.code || 'unknown error').slice(0, 300)}`, { maxChunks: 1 });
    return true;
  }
  /** One short line after an approval was answered. An answered question needs none: the Assistant carries on. */
  function ackText(card, result) {
    const summary = String(result.summary || '');
    if (card.kind === 'route') return summary === 'cancelled' ? "OK, I won't start that." : `OK, ${summary}.`;
    if (summary === 'computer allowed') return 'OK, I will use your Mac for this task. Esc on the Mac stops me.';
    if (summary === 'allowed once') return 'OK, going ahead.';
    if (summary === 'denied') return "OK, I won't.";
    if (summary === 'approved') return 'OK, going ahead with the plan.';
    if (summary === 'keep planning') return "OK, I'll keep planning.";
    if (summary === 'skipped' || summary === 'declined') return 'OK, skipping that.';
    return '';
  }
  /** The desktop answered a request the phone saw, and nothing has been said here since. */
  function recentlyAnsweredElsewhere() {
    return state.lastDesktopAnswerAt && now() - state.lastDesktopAnswerAt < L.desktopAnsweredMs && !(state.lastReplyAt > state.lastDesktopAnswerAt);
  }

  // ── commands ───────────────────────────────────────────────────────────────
  async function runCommand(command, message) {
    switch (command.name) {
      case 'help': await say(HELP_TEXT, { maxChunks: 2 }); return;
      case 'status': await say(statusText(statusSnapshot()), { maxChunks: 1 }); return;
      case 'stop': {
        const { stoppedRuns, clearedQueue } = await stopEverything({ reason: 'phone' });
        const n = stoppedRuns + clearedQueue;
        await say(`Stopped. Cancelled ${n} task${n === 1 ? '' : 's'}.`, { maxChunks: 1 });
        return;
      }
      case 'new':
        if (command.args) { await say('/new takes no arguments: send /new on its own, then your message.', { maxChunks: 1 }); return; }
        try { await newSession('command'); await say('New conversation started. Your next message goes to it.', { maxChunks: 1 }); }
        catch (error) { await say(`Could not start a new conversation: ${error?.message || error}`, { maxChunks: 1 }); }
        return;
      case 'pause':
        pause('phone');
        await say('Paused. I will not act on your messages until you send /resume.', { maxChunks: 1 });
        return;
      case 'resume': {
        if (!state.paused) { await say('Not paused.', { maxChunks: 1 }); return; }
        if (state.pausedBy && state.pausedBy !== 'phone') { await say('This was paused from SynaBun on your computer: resume it there.', { maxChunks: 1 }); return; }
        resume('phone');
        await say('Resumed. Send me what you need.', { maxChunks: 1 });
        return;
      }
      case 'cards': {
        if (!state.cards.size) { await say('Nothing is waiting for you.', { maxChunks: 1 }); return; }
        const card = currentCard();
        if (card) await sendCard(card);
        else showNextCard();
        if (state.cards.size > 1) await say(`${state.cards.size - 1} more after this one.`, { maxChunks: 1 });
        return;
      }
      default:
        void message;
    }
  }
  function statusSnapshot() {
    const view = state.sessionId ? sessionView(state.sessionId) : null;
    const turn = state.sessionId ? state.turns.get(state.sessionId) : null;
    const rt = runtime();
    let brainCapUsd = null;
    try { brainCapUsd = rt?.brainCapUsd?.() ?? null; } catch { brainCapUsd = null; }
    const cfg = readConfig();
    const current = currentCard();
    return {
      connected: isConnected(), sessionId: state.sessionId, title: view?.title || null, brain: view?.brain || null,
      running: !!turn || !!view?.running, turnKind: turn?.kind || null, queued: state.queue.length,
      pendingCards: state.cards.size, currentCard: current ? (current.kind === 'route' ? 'where to run a task' : current.kind === 'computer' ? 'controlling your Mac' : current.kind) : null,
      budget: view?.budget || null, brainUsd: view?.costUsd ?? null, brainCapUsd,
      level: state.sessionId ? levelOf(state.sessionId) : cfg.level, paused: state.paused, pausedBy: state.pausedBy,
      autonomousUntil: cfg.autonomousUntil || null,
    };
  }
  /** /stop and stopAll: the turn, the session's runs, open cards and the queue. */
  async function stopEverything({ reason = 'phone' } = {}) {
    const rt = runtime();
    const id = state.sessionId;
    let stoppedRuns = 0;
    const turn = id ? state.turns.get(id) : null;
    if (turn) turn.stoppedByPhone = reason === 'phone';
    if (rt && id) { try { await rt.stopTurn?.(id, { origin: 'whatsapp' }); } catch {} }
    const d = dispatcher();
    if (d?.list && d?.stop && id) {
      let runs = [];
      try { runs = d.list({ assistantSessionId: id, activeOnly: true }) || []; } catch { runs = []; }
      for (const run of runs) { try { await d.stop(run.runId, 'user'); stoppedRuns += 1; } catch {} }
    }
    for (const card of [...state.cards.values()]) {
      if (card.sessionId !== id) continue;
      const denied = answerCard(card, { type: 'cancel', rest: '' }, { quoted: true });
      if (denied.action === 'respond' && rt) {
        card.answering = true;
        try {
          if (card.source === 'dispatch') rt.answerDispatchControl(card.sessionId, card.runId, card.requestId, denied.response, { origin: 'whatsapp' });
          else await rt.answerControl(card.sessionId, card.requestId, denied.response, { origin: 'whatsapp' });
        } catch {} finally { card.answering = false; }
      }
      closeCard(card, 'stopped', { quiet: true });
    }
    const cleared = state.queue.splice(0, state.queue.length);
    for (const job of cleared) react(job.sourceIds, 'stopped');
    persistBridgeState();
    return { stoppedRuns, clearedQueue: cleared.length };
  }
  function pause(by = 'desktop') {
    state.paused = true;
    state.pausedBy = by === 'phone' ? 'phone' : 'desktop';
    state.pausedNoticeSent = false;
    writeConfig({ paused: true, pausedBy: state.pausedBy });
    state.policySeen.clear();
    syncPolicies();
    return status();
  }
  function resume(by = 'desktop') {
    if (!state.paused) return status();
    if (by === 'phone' && state.pausedBy && state.pausedBy !== 'phone') return status();
    state.paused = false;
    state.pausedBy = null;
    writeConfig({ paused: false, pausedBy: null });
    state.policySeen.clear();
    syncPolicies();
    scheduleDrain(L.drainMs);
    return status();
  }

  // ── inbound ────────────────────────────────────────────────────────────────
  function rateLimited() {
    const t = now();
    if (t - state.minuteWindow.start >= MINUTE) state.minuteWindow = { start: t, count: 0, noticed: false };
    if (t - state.dayWindow.start >= 24 * HOUR) state.dayWindow = { start: t, count: 0, noticed: false };
    state.minuteWindow.count += 1;
    state.dayWindow.count += 1;
    if (state.dayWindow.count > L.perDay) {
      if (!state.dayWindow.noticed) { state.dayWindow.noticed = true; say(`That is ${L.perDay} messages today, my daily limit. I will pick up again tomorrow.`, { maxChunks: 1 }); }
      return true;
    }
    if (state.minuteWindow.count > L.perMinute) {
      if (!state.minuteWindow.noticed) { state.minuteWindow.noticed = true; say('Too many messages at once: I will read new ones again in a minute.', { maxChunks: 1 }); }
      return true;
    }
    return false;
  }
  function noteStale() {
    state.staleSkipped += 1;
    if (state.staleTimer) T.clearTimeout(state.staleTimer);
    state.staleTimer = T.setTimeout(() => {
      state.staleTimer = null;
      const n = state.staleSkipped;
      state.staleSkipped = 0;
      if (n > 0) say(`I was offline and skipped ${n} older message${n === 1 ? '' : 's'}; resend what you still need.`, { maxChunks: 1 });
    }, L.staleNoticeMs);
  }
  /** One owner message from the transport (InboundMessage; never a number or a JID). */
  async function onInbound(message) {
    if (state.stopped || !message || message.owner !== true) return;
    if (message.id) { try { const r = transport.markRead?.([message.id]); if (r?.catch) r.catch(() => {}); } catch {} }
    // Sent longer ago than staleMs (WhatsApp held it while SynaBun was offline:
    // `backlog`): never acted on, only counted for one note. Checked first, so a
    // backlog neither uses up the rate limits nor counts as activity.
    if (now() - tsMs(message.ts, now()) > L.staleMs) { noteStale(); return; }
    if (rateLimited()) return;
    const activityBefore = state.lastActivityAt;
    state.lastActivityAt = now();
    state.lastInboundId = message.id || state.lastInboundId;
    runtime();
    syncPolicies();
    const text = String(message.text ?? '');
    const images = Array.isArray(message.images) ? message.images : [];
    if (message.unsupported && !text.trim() && !images.length) {
      const type = String(message.unsupported.type || 'this kind of');
      const last = state.unsupportedAt.get(type) || 0;
      if (now() - last >= L.unsupportedEveryMs) {
        state.unsupportedAt.set(type, now());
        await say(`I can read text and pictures for now; ${type} messages are not supported yet.`, { maxChunks: 1 });
      }
      return;
    }
    const command = parseCommand(message);
    if (command?.kind === 'command') { await runCommand(command, message); return; }
    if (command?.kind === 'refused') { await say(SETTINGS_REFUSAL, { maxChunks: 1 }); return; }
    const promptMessage = command?.kind === 'literal' ? { ...message, text: command.text } : message;
    if (state.paused) {
      if (!state.pausedNoticeSent) {
        state.pausedNoticeSent = true;
        await say(state.pausedBy === 'desktop' ? 'SynaBun is paused from your computer: resume it there to continue.' : 'Paused: send /resume to continue.', { maxChunks: 1 });
      }
      return;
    }
    // Something is waiting for the owner: a clear answer answers it; anything else closes it
    // without a grant and carries on as the next prompt. Only words the owner typed can answer:
    // never a forwarded message, a picture or "//text".
    const answerable = !images.length && command?.kind !== 'literal' && message.forwarded !== true;
    if (await replyToPending(message, { answerable })) return;
    if (rotationDue(activityBefore)) state.rotateOnNextSubmit = true;
    // A request raised between that look and here is older than this message too (onCard only sees
    // a message once it is buffered): it closes without a grant instead of holding the message.
    // The loop ends in the same synchronous step as the push below, so nothing can slip in after it.
    for (let i = 0; i < 3 && holdingCards().length; i += 1) {
      await closeWithoutGrant(holdingCards());
      if (!state.currentKey) showNextCard();
    }
    // A newer prompt from the phone: the computer approval the running turn holds ends now, before
    // this message is buffered or queued (it would otherwise keep the Mac until the message starts).
    if (state.sessionId) { try { runtime()?.supersedeComputerApproval?.(state.sessionId); } catch (error) { log('whatsapp:bridge', `computer approval: ${error?.message || error}`); } }
    await pushPrompt(promptMessage);
  }
  /**
   * → true when the message was an answer (used up here); false when it goes on as a prompt.
   * A reply that quotes something is aimed at what it quotes: it can answer that request, while
   * it is open, and no other. Quoting a closed request, an ordinary message or one this link
   * does not know answers nothing: what is open closes without a grant and the message goes on.
   */
  async function replyToPending(message, { answerable }) {
    const quotes = !!message.quoted;
    const quotedKey = message.quoted?.id ? state.cardByMessage.get(message.quoted.id) : null;
    const quotedCard = quotedKey ? state.cards.get(quotedKey) || null : null;
    // Nothing but an answer ("yes", "no", a bare option number): only that is a late answer to a
    // request that is gone. Anything that says more ("1. Explain the command first") is a message.
    const bare = answerable && isBareAnswer(message.text);
    // A bare yes / no to a request that is gone (answered on the desktop, timed out): say so; any other text is just the next message.
    if (quotedKey && !quotedCard && bare) { await say('Already answered in SynaBun.', { maxChunks: 1 }); return true; }
    let card = quotes ? quotedCard : currentCard();
    // A request whose message has not reached the phone yet (still being sent, throttled, waiting
    // in the outbox) cannot be what this message answers: the owner has not seen it. It closes
    // without a grant with everything else that is open, and the message goes on as a prompt.
    if (card && !card.messageIds.length) card = null;
    if (!card) {
      // Aimed at something that is not an open request: never an answer to one that is.
      if (quotes || holdingCards().length || currentCard()) { await moveOn(); return false; }
      const hidden = untrackedPending(state.sessionId);
      if (!hidden.length && bare && recentlyAnsweredElsewhere()) { await say('Already answered in SynaBun.', { maxChunks: 1 }); return true; }
      // Requests the phone never saw (a desktop turn's, or from before a restart of the link) must not hold the message.
      if (hidden.length) await moveOn();
      return false;
    }
    if (answerable) {
      const result = answerCard(card, String(message.text ?? ''), { quoted: !!quotedCard });
      if (result.action === 'respond') return answer(card, result, message);
      if (result.action === 'invalid' || result.action === 'desktop') { await say(result.message, { maxChunks: 1 }); return true; }
    }
    await moveOn();
    return false;
  }
  /** Into the coalescer (several quick messages are one prompt). → the prompt's handling when it flushed at once. */
  function pushPrompt(message) {
    const handle = (parts) => onCoalesced(parts).catch((error) => log('whatsapp:bridge', `prompt: ${error?.message || error}`));
    if (!coalescer && typeof inbound?.createCoalescer === 'function') {
      try { coalescer = inbound.createCoalescer({ windowMs: 1500, maxImages: 4, onFlush: (parts) => { state.buffered = 0; state.flushed = handle(parts); }, timers: T }); } catch { coalescer = null; }
    }
    const push = coalescer && (coalescer.push || coalescer.add || coalescer.feed);
    if (!push) return handle([message]);
    state.flushed = null;
    state.buffered += 1;
    push.call(coalescer, message);
    const flushed = state.flushed;
    state.flushed = null;
    return flushed || Promise.resolve();
  }
  async function onCoalesced(parts) {
    const list = (Array.isArray(parts) ? parts : Array.isArray(parts?.parts) ? parts.parts : Array.isArray(parts?.messages) ? parts.messages : [parts]).filter(Boolean);
    if (!list.length) return;
    let composed = null;
    try { composed = inbound?.composePrompt ? inbound.composePrompt(list, { rng }) : null; } catch (error) { log('whatsapp:bridge', `compose: ${error?.message || error}`); }
    if (!composed) composed = { text: list.map((part) => String(part.text || '')).filter(Boolean).join('\n\n'), images: list.flatMap((part) => part.images || []), sourceIds: list.map((part) => part.id).filter(Boolean), untrusted: list.some((part) => part.forwarded || part.quoted) };
    const images = Array.isArray(composed.images) ? composed.images.filter(Boolean) : [];
    const job = {
      text: String(composed.text || ''), images,
      // A picture carries content the owner did not type: the turn is capped at Ask.
      sourceIds: Array.isArray(composed.sourceIds) ? composed.sourceIds.filter(Boolean) : [], untrusted: composed.untrusted === true || images.length > 0,
      receivedAt: now(),
    };
    if (!job.text.trim() && !job.images.length) return;
    await enqueue(job);
  }
  /** Messages that wait together are one prompt: the Assistant reads them at once, like a person catching up. */
  function mergeJob(into, job) {
    if (!into || into.images.length + job.images.length > L.mergeImages || into.text.length + job.text.length > L.mergeChars) return false;
    into.text = [into.text, job.text].filter((part) => part && part.trim()).join('\n\n');
    into.images.push(...job.images);
    into.sourceIds.push(...job.sourceIds);
    into.untrusted = into.untrusted || job.untrusted;
    return true;
  }
  async function enqueue(job, { head = false } = {}) {
    const busy = currentBusy() || state.starting;
    if (busy || state.queue.length || state.paused) {
      if (head || !mergeJob(state.queue[state.queue.length - 1], job)) {
        if (!head && state.queue.length >= L.queueMax) {
          react(job.sourceIds, 'failed');
          await say(`${L.queueMax} messages are already waiting: send this again when I am done.`, { maxChunks: 1 });
          return;
        }
        if (head) state.queue.unshift(job); else state.queue.push(job);
      }
      react(job.sourceIds, 'queued');
      persistBridgeState();
      if (!busy && !state.paused) scheduleDrain(L.drainMs);
      watchQueue();
      return;
    }
    await startJob(job);
  }
  function currentBusy() {
    const id = state.sessionId;
    if (!id) return false;
    let busy = false;
    try { busy = !!runtime()?.isBusy?.(id); } catch { busy = false; }
    const turn = state.turns.get(id);
    // A turn whose end never reached us (the runtime no longer runs it and it has been silent) is let go.
    if (turn && turn.state === 'RUNNING' && !busy && now() - turn.lastPacketAt > L.letGoMs) { finalizeTurn(id, 'done'); return true; }
    return busy || !!turn;
  }
  function scheduleDrain(ms) {
    if (state.drainTimer) T.clearTimeout(state.drainTimer);
    state.drainTimer = T.setTimeout(() => { state.drainTimer = null; drain().catch((error) => log('whatsapp:bridge', `drain: ${error?.message || error}`)); }, ms);
  }
  /**
   * While messages wait, try the queue again on a timer: the end of a turn
   * drains it at once, but a turn whose end never arrives (letGoMs) must not
   * hold a message until the owner writes again.
   */
  function watchQueue() {
    if (state.queueTimer || state.stopped) return;
    state.queueTimer = T.setInterval(() => {
      if (!state.queue.length || state.stopped) { T.clearInterval(state.queueTimer); state.queueTimer = null; return; }
      drain().catch((error) => log('whatsapp:bridge', `queue watch: ${error?.message || error}`));
    }, L.queueWatchMs);
    state.queueTimer?.unref?.();
  }
  async function drain() {
    if (state.stopped || state.paused || state.starting || !state.queue.length || currentBusy()) return;
    const job = state.queue.shift();
    persistBridgeState();
    await startJob(job);
  }
  async function startJob(job, { retried = false } = {}) {
    const rt = runtime();
    if (!rt?.submit) { react(job.sourceIds, 'failed'); await say('The Assistant is not available right now.', { maxChunks: 1 }); return; }
    // One job at a time until its turn exists (creating the session awaits).
    state.starting = true;
    let sessionId;
    try { sessionId = await ensureSession(); } catch (error) {
      state.starting = false;
      react(job.sourceIds, 'failed');
      await say(`Could not start the Assistant: ${error?.message || error}`, { maxChunks: 1 });
      scheduleDrain(L.drainMs);
      return;
    }
    // The brain Settings names, if it changed since this conversation was last put on it.
    await applyBrainChoice(sessionId).catch((error) => log('whatsapp:bridge', `brain choice: ${error?.message || error}`));
    await noticeBrainLimit(sessionId).catch(() => {});
    // The turn exists before submit: brain events can arrive before it resolves.
    const turn = makeTurn(sessionId, 'wa', { sourceIds: [...job.sourceIds] });
    state.starting = false;
    const latest = job.sourceIds[job.sourceIds.length - 1] || null;
    turn.replyTo = latest && latest !== state.lastInboundId ? latest : null;
    react(job.sourceIds, 'seen');
    state.inflight = { sourceIds: [...job.sourceIds], startedAt: now() };
    persistBridgeState();
    startProgress(turn);
    let result;
    try { result = await rt.submit(sessionId, { text: job.text, images: job.images, origin: 'whatsapp', authority: phoneAuthority, requireIdle: true, untrusted: job.untrusted }); }
    catch (error) { result = { ok: false, code: error?.code || 'SUBMIT_FAILED', message: error?.message || String(error) }; }
    if (state.turns.get(sessionId) !== turn) return; // finalized meanwhile (watchdog, /stop)
    if (result?.ok) {
      turn.state = 'RUNNING';
      if (turn.endedEarly) finalizeTurn(sessionId, turn.endedEarly.outcome, { message: turn.endedEarly.message });
      return;
    }
    // Not submitted: this turn never ran.
    state.turns.delete(sessionId);
    disarm(turn);
    presence('paused');
    state.inflight = null;
    await onRefused(job, result || {}, { retried, sessionId });
  }
  async function onRefused(job, result, { retried, sessionId }) {
    const code = result.code || 'UNKNOWN';
    if (code === 'ASSISTANT_BUSY') {
      // Something else is running (a desktop turn, the mailbox): first in line again.
      state.queue.unshift(job);
      react(job.sourceIds, 'queued');
      persistBridgeState();
      if (state.busyRetryTimer) T.clearTimeout(state.busyRetryTimer);
      state.busyRetryTimer = T.setTimeout(() => { state.busyRetryTimer = null; drain().catch(() => {}); }, L.busyRetryMs);
      return;
    }
    if ((code === 'SESSION_NOT_FOUND' || code === 'SESSION_ENDED') && !retried) {
      if (state.sessionId === sessionId) state.sessionId = null;
      await startJob(job, { retried: true });
      return;
    }
    persistBridgeState();
    react(job.sourceIds, 'failed');
    if (code === 'SESSION_BUDGET_EXCEEDED' || code === 'BRAIN_BUDGET_EXCEEDED') { await say(budgetText(code, sessionId, result.message), { maxChunks: 1 }); return; }
    if (code === 'EMPTY_PROMPT') return;
    await say(`Could not start that: ${String(result.message || code).slice(0, 400)}`, { maxChunks: 1 });
  }
  /** Spend against the cap, and the two ways on: /new or a higher cap. Never a silent new session. */
  function budgetText(code, sessionId, fallback) {
    const view = sessionView(sessionId);
    let line = '';
    if (code === 'SESSION_BUDGET_EXCEEDED' && view?.budget && Number.isFinite(Number(view.budget.hardUsd))) {
      line = `This conversation spent ${usd(view.budget.totalUsd)} of its ${usd(view.budget.hardUsd)} cap.`;
    } else if (code === 'BRAIN_BUDGET_EXCEEDED') {
      let cap = null;
      try { cap = runtime()?.brainCapUsd?.() ?? null; } catch { cap = null; }
      line = cap !== null ? `The Assistant spent ${usd(view?.costUsd)} of its ${usd(cap)} cap in this conversation.` : '';
    }
    return `${line || String(fallback || 'This conversation reached its budget cap.')} Send /new to start a fresh conversation, or raise the cap in SynaBun.`;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  /** The transport's connection changed ({ connected } or a state name). */
  async function onConnection(info) {
    const connected = typeof info === 'boolean' ? info : info?.connected === true || info?.state === 'open';
    if (!connected) { presence('paused'); return; }
    runtime();
    syncPolicies();
    if (state.restartNotice) {
      const notice = state.restartNotice;
      state.restartNotice = null;
      const from = notice.inflight?.startedAt ? hhmm(Number(notice.inflight.startedAt)) : null;
      const parts = [];
      if (from) parts.push(`SynaBun restarted while working on your message from ${from}.`);
      if (notice.queued) parts.push(`${notice.queued} queued message${notice.queued === 1 ? ' was' : 's were'} not sent to the Assistant.`);
      parts.push('Send again what you still need.');
      state.inflight = null;
      persistBridgeState();
      await say(parts.join(' '), { maxChunks: 1 });
    }
    await flushOutbox();
  }
  function status() {
    const id = state.sessionId;
    let running = !!(id && state.turns.has(id));
    if (!running && id) { try { running = !!runtimeRef?.isBusy?.(id); } catch {} }
    return { sessionId: id || null, running, queued: state.queue.length, paused: state.paused, pausedBy: state.pausedBy, pendingCards: state.cards.size, lastReplyAt: state.lastReplyAt };
  }
  async function stopAll() {
    const result = await stopEverything({ reason: 'service' });
    return { ok: true, ...result };
  }
  /**
   * Live computer control ends with the bridge. Every WhatsApp session of ours, current and retired,
   * that is registered with computer use is registered again without it; the runtime hears that at
   * once: an open "control your Mac?" request closes without a grant, the desktop grant is held again,
   * the action in flight is aborted, held input and the lease are released, and the running turn is
   * done with the Mac for good. Without this an unlink left an approved turn with the Mac and no
   * phone to stop it. It sticks: nothing this bridge registers afterwards carries computer use.
   */
  function endComputerUse(reason = 'bridge dropped') {
    state.computerEnded = true;
    if (!policy?.registerSessionPolicy) return;
    const known = typeof policy.getSessionPolicy === 'function';
    const off = { ...remoteFromConfig(), computerUse: false };
    for (const id of [state.sessionId, ...state.previous.map((row) => row.id)].filter(Boolean)) {
      if (known ? policy.getSessionPolicy(id)?.computerUse !== true : id !== state.sessionId) continue;
      try { policy.registerSessionPolicy(id, off); state.policySeen.delete(id); log('whatsapp:bridge', `computer use of ${id} ended (${reason})`); }
      catch (error) { log('whatsapp:bridge', `ending computer use of ${id}: ${error?.message || error}`); }
    }
  }
  async function shutdown() {
    state.stopped = true;
    endComputerUse('bridge shut down'); // before anything else, and before any await
    for (const turn of state.turns.values()) disarm(turn);
    for (const timer of [state.drainTimer, state.busyRetryTimer, state.staleTimer, state.dispatchTimer, state.forwardSummaryTimer, state.outboxTimer]) if (timer) T.clearTimeout(timer);
    if (state.policyTimer) T.clearInterval(state.policyTimer);
    if (state.queueTimer) { T.clearInterval(state.queueTimer); state.queueTimer = null; }
    try { unobserve?.(); } catch {}
    try { unsubscribeRuntime?.(); } catch {}
    try { coalescer?.flush?.(); } catch {}
    presence('paused');
    persistBridgeState();
  }

  // Keep the level in line with the config (Settings edits, the autonomous window running out).
  state.policyTimer = T.setInterval(() => { try { runtime(); syncPolicies(); } catch {} }, L.policyTickMs);
  state.policyTimer?.unref?.();
  runtime();

  return {
    onInbound, onConnection, status, newSession, pause, resume, stopAll, shutdown,
    // Settings changed (level, strict approvals, autonomous window): re-apply now instead of at the next tick.
    refresh: () => { state.policySeen.clear(); runtime(); syncPolicies(); return status(); },
    endComputerUse,
    _internals: { state, finalText, syncPolicies, drain, onPacket, brainTarget, moveOn },
  };
}
