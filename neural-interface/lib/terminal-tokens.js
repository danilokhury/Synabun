// ── Who a run is: the per-run terminal token (X-Synabun-Terminal-Token) ──
//
// Every automation that uses SynaBun's browser names itself in X-Synabun-Terminal (lib/browser-owner.js): a loop's
// terminal id, a native run's or a dispatched worker's run id, `agent:<uuid>` for an automation-window agent. The
// header is self-asserted, and its value is no secret (it is in loop files, logs, task text and process
// environments), so before 2026-11-04 any local process could name another run and recover, move, adopt, drive or
// close that run's browser tab (review finding 9).
//
// The same answer SynaBun already gives the Assistant's brain (assistant-runtime.js mintBrainCredential): a credential
// minted per launch, kept in memory only, handed to that launch's own MCP server alone, and compared in constant time.
// Here it is one token per run, minted where the server mints the run's terminal id (issue()), and handed to the
// run's SynaBun MCP through its environment or an MCP header that names the environment variable (never a file
// under data/, which every backup holds, and never a command line, which every account of the computer can read):
//
//   • an automation-window agent: SYNABUN_TERMINAL_TOKEN in the agent CLI's environment, named by the stdio SynaBun
//     entry of its mcp.json (`${SYNABUN_TERMINAL_TOKEN}`, expanded by the CLI);
//   • a Claude Code terminal loop: the PTY's environment, named by the loop's MCP config header;
//   • an exec loop (Codex, OpenCode, Antigravity in a shell): the PTY's environment; Codex forwards it by name
//     (`mcp_servers.SynaBun.env_vars`), OpenCode's loop config names it (`{env:SYNABUN_TERMINAL_TOKEN}`), Antigravity's
//     MCP child inherits it;
//   • a native run (a loop, a schedule, a dispatched worker): NativeLoopRuntime issues it at launch and resume and
//     passes it to the provider as a function (`terminalTokenProvider`, never in the state file);
//   • a sandboxed worker on the worker-only MCP channel: the channel adds it itself, from the run its path token names.
//
// The MCP server sends it with X-Synabun-Terminal on every request to the Neural Interface, only for the id it was
// given for (mcp-server/src/services/identity.ts callerTerminalToken). The server reads both (server.js
// browserCaller) and decides with verdict():
//
//   • verified      — the id has a proof (a token, or a brain's bound credential) and the request carries it;
//   • unregistered  — an id SynaBun gave no proof (an MCP process's own client id, a CLI window's MCP session, the
//                     Antigravity panel's agy, a run from before this server started): self-asserted, as before (an id
//                     SynaBun minted a proof for can never be claimed this way);
//   • missing       — the id has a proof and the request carries none: refused (403 TERMINAL_TOKEN_REQUIRED), unless
//                     SYNABUN_TERMINAL_TOKEN_MODE=grace while its window is open (accepted and logged: a stale MCP build);
//   • invalid       — a token that is not the id's: refused (403 TERMINAL_TOKEN_INVALID), in every mode;
//   • revoked       — the run ended (revoke()), or holds no live process (retire(): a worker waiting for its resume
//                     after a restart): refused like an invalid token, in every mode. Kept for the last
//                     REVOKED_KEPT_MAX ended runs, so an ended run's id is never reopened to self-assertion.
//
// Lifecycle: revoke() at the run's end (server.js endAutomationBrowser, the native runtime's finish, a launch that
// failed). Nothing is persisted: after a restart the registry is empty; PTY loops and agents end with the server,
// and a dispatched worker that resumes gets a new token with its new process (the moment its tab and desktop grant
// are renewed). A token belongs to one process of the run: rotate() gives the run a new one and the old one is
// nothing from then on (a native run's resume, a side panel's new CLI or serve), and a suspended run holds none.
//
// Side panels and Assistant brains (2026-11-04, follow-up to review c0eab425): a Claude Code panel tab, a Codex panel
// connection and an OpenCode panel serve get a token of their own where their id is minted (rotated with every process
// they start, revoked when the tab, the connection or the serve ends). An Assistant brain already holds a per-launch
// credential that only its own SynaBun MCP has (`sbb_…`, assistant-runtime.js mintBrainCredential): bind() makes that
// credential the proof of the brain's id, so no second secret exists; its MCP presents it in X-Synabun-Terminal-Token
// like a token (or the server reads X-Synabun-Brain-Token when that header is absent), and it is revoked with the brain.
// Ids SynaBun does not mint stay unregistered: a CLI window's own MCP session, the Antigravity panel's agy (it runs
// with the user's own MCP configuration, which names no pin), an MCP process's own client id.
//
// Grace (SYNABUN_TERMINAL_TOKEN_MODE=grace): every acceptance of a run's id without its token is logged (one line per
// run a minute at most, with how many more there were), and grace ends by itself SYNABUN_TERMINAL_TOKEN_GRACE_MINUTES
// after the server started (24 hours unless set; `never` keeps it while the mode says so), strict from then on.

import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';
import { BROWSER_OWNER_ID_RE } from './browser-owner.js';
import { registerKnownSecret, forgetKnownSecret } from './terminal-token-redaction.js';
export { TOKEN_PLACEHOLDER, scrubTokenText, containsTokenText, redactTerminalSecrets, createTokenStreamRedactor, encodedSecretForms, registerKnownSecret, forgetKnownSecret } from './terminal-token-redaction.js';

/** The request header the MCP server sends the token in. */
export const TERMINAL_TOKEN_HEADER = 'x-synabun-terminal-token';
/** The environment variable a run's MCP server reads it from (stdio), or its MCP header names (Claude Code). */
export const TERMINAL_TOKEN_ENV = 'SYNABUN_TERMINAL_TOKEN';
/** A token's shape: `sbt_` + 32 random bytes, base64url (256 bits). */
export const TERMINAL_TOKEN_RE = /^sbt_[A-Za-z0-9_-]{43}$/;
/** `grace`: a registered id without a token is accepted (logged). Anything else, or nothing, is strict. */
export const TERMINAL_TOKEN_MODE_ENV = 'SYNABUN_TERMINAL_TOKEN_MODE';
/** How long grace lasts after the server started, in minutes (a positive number), or `never`. Unset: 24 hours. */
export const TERMINAL_TOKEN_GRACE_MINUTES_ENV = 'SYNABUN_TERMINAL_TOKEN_GRACE_MINUTES';
/** Grace's default window. */
export const GRACE_DEFAULT_MINUTES = 24 * 60;
/** At most one grace line per run in this long (the acceptances in between are counted in the next line). */
export const GRACE_LOG_EVERY_MS = 60_000;
/** An Assistant brain's launch credential (assistant-runtime.js BRAIN_CREDENTIAL_RE): what proves a brain's id. */
export const BRAIN_CREDENTIAL_SHAPE_RE = /^sbb_[A-Za-z0-9_-]{43}$/;
/** The header a brain's MCP sends its launch credential in (also read as the proof of its id when no token is sent). */
export const BRAIN_CREDENTIAL_HEADER = 'x-synabun-brain-token';
/** How many ended runs stay refused (oldest first out). */
export const REVOKED_KEPT_MAX = 10_000;
/**
 * How many closed MCP sessions stay refused, in a list of their own (oldest first out). Anybody on this computer can
 * open and close MCP sessions, so they never share the ended runs' list: before 2026-11-10 (review b6631e9d, finding
 * 7) 10,000 open-and-close cycles pushed every ended run out of it, and an ended run's id was sayable again.
 */
export const REVOKED_SESSIONS_KEPT_MAX = 10_000;

/** The shape of the ids the MCP transport mints for its sessions (a random UUID): a bearer for that session. */
export const MCP_SESSION_ID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * `id` as a log line or a refusal may show it (finding 4 of the re-review of 2026-11-11): an id shaped like an MCP
 * session's (MCP_SESSION_ID_SHAPE_RE) or `isMcpSession` says is one, cut to its first 8 characters and "…" (as
 * mcp-server/src/http.ts sessionLogId); anything else (a run's id, which is nothing without its token) up to 128
 * characters, so a log still finds the run.
 */
export function logIdOf(id, isMcpSession = false) {
  const text = String(id ?? '');
  return isMcpSession === true || MCP_SESSION_ID_SHAPE_RE.test(text) ? `${text.slice(0, 8)}…` : text.slice(0, 128);
}

/** A new token. */
export function mintTerminalToken(random = cryptoRandomBytes) {
  return `sbt_${random(32).toString('base64url')}`;
}

/** `value` as a token, or null (absent, not a string, not shaped like one SynaBun mints). */
export function sanitizeTerminalToken(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return TERMINAL_TOKEN_RE.test(text) ? text : null;
}

/** `value` as a proof of an id: a terminal token, or a brain's launch credential (bind()), else null. */
export function sanitizeTerminalProof(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return TERMINAL_TOKEN_RE.test(text) || BRAIN_CREDENTIAL_SHAPE_RE.test(text) ? text : null;
}

/** 'grace' when the environment says so, else 'strict'. Read at every check. */
export function terminalTokenMode(env = process.env) {
  return String(env?.[TERMINAL_TOKEN_MODE_ENV] || '').trim().toLowerCase() === 'grace' ? 'grace' : 'strict';
}

/**
 * How long grace lasts after the server started (SYNABUN_TERMINAL_TOKEN_GRACE_MINUTES), in milliseconds: a positive
 * number of minutes, Infinity for `never`, else (unset, 0, anything unreadable) the 24-hour default.
 */
export function terminalTokenGraceWindowMs(env = process.env) {
  const raw = String(env?.[TERMINAL_TOKEN_GRACE_MINUTES_ENV] ?? '').trim().toLowerCase();
  if (raw === 'never') return Infinity;
  const minutes = Number(raw);
  return raw && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : GRACE_DEFAULT_MINUTES * 60_000;
}

const digestOf = (text) => createHash('sha256').update(String(text)).digest();

/**
 * The refusal of a request that names a run it cannot prove it is: 403 and a code, never the token.
 * @param {'missing'|'invalid'|'revoked'} status
 * @param {string} id the run the request named
 */
export function terminalRefusal(status, id) {
  // Finding 4 (re-review of 2026-11-11): the id a request names may be a live Mcp-Session-Id, a bearer for that MCP
  // session. A refusal goes back to the caller that sent it, but it can be copied into a log on its way (a route's
  // catch, a proxy), so an id of that shape is said by its short form here too (logIdOf).
  const run = logIdOf(id);
  if (status === 'missing') {
    return {
      status: 403, code: 'TERMINAL_TOKEN_REQUIRED',
      error: `This request names run ${run} (X-Synabun-Terminal) without that run's terminal token (X-Synabun-Terminal-Token). SynaBun gives the token to the run's own SynaBun MCP server when it starts the run; another process cannot act as that run. An MCP server built before this check needs \`npm run mcp:build\` and the run started again.`,
    };
  }
  if (status === 'revoked') {
    return {
      status: 403, code: 'TERMINAL_TOKEN_INVALID',
      error: `Run ${run} has ended: its terminal token was revoked, and nothing may act as that run any more.`,
    };
  }
  return {
    status: 403, code: 'TERMINAL_TOKEN_INVALID',
    error: `This request names run ${run} (X-Synabun-Terminal) with a terminal token that is not that run's (X-Synabun-Terminal-Token). Only the run's own SynaBun MCP server can act as it.`,
  };
}

/**
 * @param {{ random?: (n: number) => Buffer, equal?: (a: Buffer, b: Buffer) => boolean, mode?: () => 'strict'|'grace',
 *   maxRevoked?: number, log?: (line: string) => void, graceWindowMs?: () => number, now?: () => number,
 *   logEveryMs?: number }} [options]
 *   `equal` is the constant-time comparison (crypto.timingSafeEqual); tests hand in a counting one. `mode` is what the
 *   environment says (read at every check); `graceWindowMs` how long grace may last after the registry was made (the
 *   server's start), read at every check too; `now` the clock. `knownSecrets` is told every live proof and every one
 *   that stops proving anything (lib/terminal-token-redaction.js: the scrubbers then mask its base64 and hex too).
 *   `maxRevokedSessions`: how many closed MCP sessions stay refused, apart from the ended runs. `onEnded(id, kind)` is
 *   told every id whose owner ended (revoke() of a run, revokeSession() of an MCP session; never rotate() or retire(),
 *   which are a new process or a pause of the same owner): the server forgets what that id held (its MoreLogin
 *   profile pin and its saved choice, server.js forgetRunMoreLoginProfile), so nothing outlives its owner.
 */
export function createTerminalTokenRegistry({
  random = cryptoRandomBytes,
  equal = timingSafeEqual,
  mode = () => terminalTokenMode(),
  maxRevoked = REVOKED_KEPT_MAX,
  log = () => {},
  graceWindowMs = () => terminalTokenGraceWindowMs(),
  now = Date.now,
  logEveryMs = GRACE_LOG_EVERY_MS,
  knownSecrets = { add: registerKnownSecret, remove: forgetKnownSecret },
  maxRevokedSessions = REVOKED_SESSIONS_KEPT_MAX,
  onEnded = null,
} = {}) {
  const live = new Map(); // terminal id → { token, digest, kind: 'token' | 'credential' | 'mcp-session' }
  const revoked = new Set(); // ids of ended runs, oldest first
  const revokedSessions = new Set(); // ids of closed MCP sessions, oldest first: never in `revoked` (finding 7)
  const sessionCap = Math.max(1, Number(maxRevokedSessions) || REVOKED_SESSIONS_KEPT_MAX);
  /** Tell the host an id's owner ended (never a reason to fail a revoke). */
  const ended = (id, kind) => { if (typeof onEnded === 'function') { try { onEnded(id, kind); } catch { /* the host's own failure */ } } };
  const graceLog = new Map(); // id → { at, more }: when a grace acceptance was last logged, and how many since
  const cap = Math.max(1, Number(maxRevoked) || REVOKED_KEPT_MAX);
  const startedAt = now();
  let graceExpiryLogged = false;
  const idOf = (value) => (typeof value === 'string' && BROWSER_OWNER_ID_RE.test(value) ? value : null);
  const say = (line) => { try { log(line); } catch { /* a logger's own failure */ } };

  /** When grace ends (ms since the epoch), or Infinity. */
  function graceEndsAt() {
    let windowMs;
    try { windowMs = Number(graceWindowMs()); } catch { windowMs = GRACE_DEFAULT_MINUTES * 60_000; }
    if (!(windowMs > 0)) windowMs = GRACE_DEFAULT_MINUTES * 60_000;
    return startedAt + windowMs;
  }
  /** What the environment asks for ('grace' | 'strict'). */
  function configuredMode() {
    try { return mode() === 'grace' ? 'grace' : 'strict'; } catch { return 'strict'; }
  }
  /** The mode in force: grace only while the environment asks for it and its window is open. */
  function currentMode() {
    if (configuredMode() !== 'grace') return 'strict';
    if (now() < graceEndsAt()) return 'grace';
    if (!graceExpiryLogged) {
      graceExpiryLogged = true;
      say(`[terminal-tokens] grace has ended (${TERMINAL_TOKEN_GRACE_MINUTES_ENV}): a run named without its terminal token is refused from now on, as in strict mode`);
    }
    return 'strict';
  }
  /** One line per run a minute at most for grace acceptances, with how many more there were since the last one. */
  function noteGrace(terminalId) {
    const id = String(terminalId).slice(0, 128);
    const at = now();
    const seen = graceLog.get(id);
    if (seen && at - seen.at < logEveryMs) { seen.more += 1; return; }
    const more = seen?.more || 0;
    graceLog.delete(id);
    graceLog.set(id, { at, more: 0 });
    while (graceLog.size > cap) graceLog.delete(graceLog.keys().next().value);
    const ends = graceEndsAt();
    say(`[terminal-tokens] grace: run ${logIdOf(id)} was let through without its terminal token (${TERMINAL_TOKEN_MODE_ENV}=grace)${more ? `; ${more} more time${more === 1 ? '' : 's'} since the last line` : ''}${Number.isFinite(ends) ? `; grace ends at ${new Date(ends).toISOString()}` : ''}`);
  }

  /** The scrubbers learn a live proof's value and forget a dead one's (never a reason to fail a check). */
  const known = (op, token) => { try { knownSecrets?.[op]?.(token); } catch { /* scrubbing by shape still holds */ } };
  /** Drop `id`'s live proof, and tell the scrubbers (a credential bound to several ids stays known while one holds it). */
  function dropLive(id) {
    const held = live.get(id);
    if (!held) return false;
    live.delete(id);
    if (![...live.values()].some((other) => other.token === held.token)) known('remove', held.token);
    return true;
  }
  function setLive(id, token, kind) {
    revoked.delete(id);
    revokedSessions.delete(id);
    graceLog.delete(id);
    if (live.has(id)) dropLive(id);
    live.set(id, { token, digest: digestOf(token), kind });
    known('add', token);
    return token;
  }

  /** The live token of `terminalId`, minted now when it has none (also after a revoke: a run started again). */
  function issue(terminalId) {
    const id = idOf(terminalId);
    if (!id) return null;
    const held = live.get(id);
    if (held) return held.token;
    return setLive(id, mintTerminalToken(random), 'token');
  }

  /**
   * A new token for `terminalId` (a run's new process: a resume, a side panel's new CLI or serve): the one it held
   * stops proving anything, and the id is not an ended run's. Returns the new token, or null for an id SynaBun does
   * not mint.
   */
  function rotate(terminalId) {
    const id = idOf(terminalId);
    if (!id) return null;
    dropLive(id);
    return setLive(id, mintTerminalToken(random), 'token');
  }

  /**
   * Make an existing credential the proof of `terminalId`: an Assistant brain's launch credential (`sbb_…`) for the
   * pin its SynaBun MCP names, so the brain proves its id with the one secret it already has. Replaces what the id
   * held. Returns whether it was bound (false for an id or a credential of another shape).
   */
  function bind(terminalId, credential) {
    const id = idOf(terminalId);
    const proof = sanitizeTerminalProof(credential);
    if (!id || !proof) return false;
    setLive(id, proof, BRAIN_CREDENTIAL_SHAPE_RE.test(proof) ? 'credential' : 'token');
    return true;
  }

  /**
   * A proof for a plain MCP session of SynaBun's own HTTP MCP endpoint (a CLI window's Claude Code or Codex that SynaBun
   * did not start: its id is the Mcp-Session-Id the endpoint minted at its initialize). Kind 'mcp-session': it makes
   * the session's id verified (nobody else can name it any more, and the browser and MoreLogin routes know it is
   * that session), but it is not a run: moreLoginGate lets it work in a profile of its own (`use`) and never `start`
   * or `use-default` (kindOf). Never replaces a proof an id already holds (a run's token, a brain's credential), and
   * never reopens an ended id. Returns the token, or null.
   */
  function issueSession(sessionId) {
    const id = idOf(sessionId);
    if (!id || live.has(id) || revoked.has(id) || revokedSessions.has(id)) return null;
    return setLive(id, mintTerminalToken(random), 'mcp-session');
  }

  /**
   * The MCP session ended: its proof stops working and its id stays refused. Only a proof issueSession gave. The id
   * goes to the closed sessions' own list (revokedSessions), never to the ended runs' (finding 7: see
   * REVOKED_SESSIONS_KEPT_MAX), so no number of sessions opened and closed can make an ended run's id sayable again.
   */
  function revokeSession(sessionId) {
    const id = idOf(sessionId);
    if (!id || live.get(id)?.kind !== 'mcp-session') return false;
    dropLive(id);
    graceLog.delete(id);
    revokedSessions.delete(id);
    revokedSessions.add(id);
    while (revokedSessions.size > sessionCap) revokedSessions.delete(revokedSessions.values().next().value);
    ended(id, 'mcp-session');
    return true;
  }

  /** What proves `terminalId`: 'token' (a run, a panel), 'credential' (a brain), 'mcp-session', or null. */
  function kindOf(terminalId) {
    return (typeof terminalId === 'string' && live.get(terminalId)?.kind) || null;
  }

  /** The live token of `terminalId`, or null (none issued, or revoked). For a handoff to a process the run starts. */
  function tokenFor(terminalId) {
    const id = idOf(terminalId);
    return id ? live.get(id)?.token || null : null;
  }

  /** The run ended: its token stops working, and its id stays refused. Returns whether it held one. */
  function revoke(terminalId) {
    const id = idOf(terminalId);
    if (!id) return false;
    // An MCP session's proof ends in its own list, whoever asks (revokeSession).
    if (live.get(id)?.kind === 'mcp-session') return revokeSession(id);
    const had = dropLive(id);
    graceLog.delete(id);
    if (had || revoked.has(id)) {
      revoked.delete(id);
      revoked.add(id);
      while (revoked.size > cap) revoked.delete(revoked.values().next().value);
    }
    ended(id, 'run');
    return had;
  }

  /**
   * Refuse `terminalId` from now on although it holds no token here: a run this server knows to have no live process
   * (a dispatched worker a restart suspended, waiting for its resume, which issues a fresh token). Without this such an
   * id would be unregistered, taken as said. Returns whether the id was one SynaBun mints.
   */
  function retire(terminalId) {
    const id = idOf(terminalId);
    if (!id) return false;
    dropLive(id);
    graceLog.delete(id);
    revoked.delete(id);
    revoked.add(id);
    while (revoked.size > cap) revoked.delete(revoked.values().next().value);
    return true;
  }

  /**
   * 'verified' | 'unregistered' | 'missing' | 'invalid' | 'revoked' for a request naming `terminalId` with `presented`
   * (a token, or for a brain's id its launch credential). The comparison is of the SHA-256 digests with `equal`
   * (timingSafeEqual): its time does not depend on where a guess differs from the proof, and every well-formed guess
   * is compared.
   */
  function check(terminalId, presented) {
    const id = typeof terminalId === 'string' ? terminalId : '';
    const held = id ? live.get(id) : null;
    const absent = presented === undefined || presented === null || presented === '';
    if (!held) {
      if (id && (revoked.has(id) || revokedSessions.has(id))) return 'revoked';
      return 'unregistered';
    }
    if (absent) return 'missing';
    const proof = sanitizeTerminalProof(presented);
    if (!proof) return 'invalid';
    return equal(digestOf(proof), held.digest) ? 'verified' : 'invalid';
  }

  /**
   * The decision for one request: `{ status, accepted }`, and for a refusal its `code`, `error` and HTTP `httpStatus`.
   * `grace` lets a registered id without a token through while its window is open (every acceptance logged, a line a
   * minute per run at most); a wrong token or an ended run never.
   */
  function verdict(terminalId, presented) {
    const status = check(terminalId, presented);
    if (status === 'verified' || status === 'unregistered') return { status, accepted: true };
    if (status === 'missing' && currentMode() === 'grace') {
      noteGrace(terminalId);
      return { status, accepted: true, grace: true };
    }
    const refusal = terminalRefusal(status, terminalId);
    return { status, accepted: false, code: refusal.code, error: refusal.error, httpStatus: refusal.status };
  }

  return {
    issue,
    rotate,
    bind,
    issueSession,
    revokeSession,
    kindOf,
    tokenFor,
    revoke,
    retire,
    check,
    verdict,
    /** Whether `id` may be used by this request (the in-process MCP server's terminalAuth). */
    accepts: (terminalId, presented) => verdict(terminalId, presented).accepted,
    /** Whether `id` holds a live token (or a bound credential). */
    has: (terminalId) => live.has(terminalId),
    /** Whether `id` is an ended run's. */
    isRevoked: (terminalId) => revoked.has(terminalId) || revokedSessions.has(terminalId),
    /** The mode in force: 'grace' only while the environment asks for it and its window is open. */
    mode: () => currentMode(),
    /** For diagnostics: the mode in force, the one asked for, and when grace ends (an ISO time, or null for never). */
    graceState: () => {
      const ends = graceEndsAt();
      return { mode: currentMode(), configured: configuredMode(), endsAt: Number.isFinite(ends) ? new Date(ends).toISOString() : null };
    },
    /** For tests and diagnostics: how many runs hold a token, how many ended ones are kept. */
    stats: () => ({ live: live.size, revoked: revoked.size }),
    /** For tests and diagnostics: how many closed MCP sessions are kept refused (their own list, never the runs'). */
    sessionStats: () => ({ revokedSessions: revokedSessions.size }),
  };
}
