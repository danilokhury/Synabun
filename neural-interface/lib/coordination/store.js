// ═══════════════════════════════════════════
// SynaBun — Coordination store
// ═══════════════════════════════════════════
//
// What agents that work together tell each other, kept on disk. The Assistant's mailbox was a list in memory
// (assistant-runtime.js enqueueMailbox): cut at 40 items, gone at a restart, and "something changed" was the only
// thing a wait could ask for. This is its durable replacement: one SQLite file in WAL mode holding
//
//   events      an append-only log. Every event gets a `seq` that only ever grows; an event appended twice under
//               the same caller-supplied `id` is stored once.
//   deliveries  one row per event and recipient it is addressed to: when it was first handed out and when the
//               recipient acknowledged it. Nothing is acknowledged by being read, so an event a recipient never
//               acknowledged is handed out again, also after a restart (at-least-once).
//   cursors     per recipient, the seq up to which everything addressed to it is acknowledged.
//   claims      which slice of a team holds which files while it works (overlap is refused).
//   team_tasks  the journal of a team's and its slices' states, for recovery after a crash.
//   outbox      follow-ups queued for a run, kept until the run took them.
//   migrations  which schema versions this file has had applied.
//
// Waiting is a wake-up, never a poll: `subscribe` and `waitFor` are called back after the transaction that
// appended an event has committed, in this process. The file is its own (DATA_HOME/data/coordination.db), apart
// from memory.db: that one is shared with the MCP server and backed up, and coordination churn has no place in it.
//
// One process writes (the Neural Interface server, where /mcp is mounted too); everything here is synchronous
// except `waitFor`, so a JavaScript turn is never interleaved with another's. The Assistant's dispatcher and runtime
// use it through service.js (the mailbox, typed waits, the follow-up outbox); README.md beside this file is the
// reference for the phases that build on it.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { globsOverlap, isTeamSlug, matchesOwnedPath, normalizeOwnedPath, normalizeRelPath, ownedPathProblem } from '../teams/schema.js';

export const COORDINATION_SCHEMA_VERSION = 1;
export const COORDINATION_DB_FILE = 'coordination.db';
/** Most urgent first. `pending` hands out critical events before everything else. */
export const EVENT_PRIORITIES = Object.freeze(['critical', 'normal', 'low']);
export const DEFAULT_EVENT_PRIORITY = 'normal';

/**
 * Event kinds the phases agree on, so two modules never name one thing twice. The store takes any kind of the
 * right form; a kind listed here gets its priority from KIND_PRIORITY when an event names none.
 */
export const EVENT_KINDS = Object.freeze({
  RUN_PROGRESS: 'run.progress',                 // a worker is still at it (what it is doing now)
  RUN_RESULT: 'run.result',                     // a worker turn ended with a ## Result
  RUN_NEEDS_INPUT: 'run.needs_input',           // a worker asked a question only the user or the brain can answer
  RUN_PERMISSION: 'run.permission',             // a worker waits for a permission decision
  RUN_FAILED: 'run.failed',                     // a run ended without a result
  RUN_STALLED: 'run.stalled',                   // a run shows no sign of life
  RUN_MESSAGE: 'run.message',                   // text from one agent to another (payload.text, payload.from)
  RUN_STOPPED: 'run.stopped',                   // a run was stopped (the user, a budget, a cap); payload.run.completionReason says by what
  RUN_INTERRUPTED: 'run.interrupted',           // a server restart ended a run that could not be resumed
  RUN_COMPLETED: 'run.completed',               // a run ended after its work was done (its result came as run.result)
  RUN_BUDGET: 'run.budget',                     // the session budget: a warning, the cap reached, usage that cannot be priced
  RUN_NOTICE: 'run.notice',                     // something the owner of a run should hear once (the user wrote to the worker)
  SESSION_MEMORY_DUE: 'session.memory_due',     // a finished run has no memory yet (the runtime's reminder to its brain)
  ROUTE_DECIDED: 'route.decided',               // the user picked a model on a route card
  ROUTE_EXPIRED: 'route.expired',               // a route card got no answer in time
  ROUTE_DECLINED: 'route.declined',             // the user declined a route card
  CLARIFY_ANSWERED: 'clarify.answered',         // the user answered the Assistant's questions
  CLARIFY_DECLINED: 'clarify.declined',         // the user skipped them
  TEAM_MESSAGE: 'team.message',                 // text on a team's channel (payload.text, payload.from)
  TEAM_STATE: 'team.state',                     // a team moved to another state (lib/teams/schema.js TEAM_STATES)
  SLICE_STATE: 'slice.state',                   // a slice moved to another state (SLICE_STATES)
  SLICE_PROGRESS: 'slice.progress',             // a slice's worker is still at it
  CLAIM_CONFLICT: 'claim.conflict',             // a worker needs a file another slice holds
  INTEGRATION_CONFLICT: 'integration.conflict', // joining a slice on the integration branch did not apply cleanly
  INTEGRATION_READY: 'integration.ready',       // every slice is joined; the branch waits for the user
});
export const KIND_PRIORITY = Object.freeze({
  'run.progress': 'low', 'slice.progress': 'low',
  'run.result': 'normal', 'run.message': 'normal', 'team.state': 'normal', 'slice.state': 'normal', 'integration.ready': 'normal',
  'run.stopped': 'normal', 'run.completed': 'normal', 'run.budget': 'normal', 'run.notice': 'normal',
  'session.memory_due': 'normal', 'team.message': 'normal',
  // A card's outcome is the user's own act: whoever relayed it (the WhatsApp bridge) finishes its bookkeeping first,
  // so it rides the short debounce of normal events instead of starting a turn inside that call.
  'route.decided': 'normal', 'route.expired': 'normal', 'route.declined': 'normal', 'clarify.answered': 'normal', 'clarify.declined': 'normal',
  'run.needs_input': 'critical', 'run.permission': 'critical', 'run.failed': 'critical', 'run.stalled': 'critical',
  'run.interrupted': 'critical',
  'claim.conflict': 'critical', 'integration.conflict': 'critical',
});

export const COORDINATION_LIMITS = Object.freeze({
  id: 200, kind: 64, recipient: 200, recipients: 64, payloadBytes: 256 * 1024, readLimit: 1000, defaultReadLimit: 100,
  outboxText: 20000, state: 40, journalDataBytes: 64 * 1024, claimGlobs: 64, runIds: 500,
  defaultWaitMs: 30_000, maxWaitMs: 10 * 60_000,
});

/** The recipient name of an Assistant session, of a run, of a team's integrator: one spelling for every module. */
export const sessionRecipient = (sessionId) => `session:${sessionId}`;
export const runRecipient = (runId) => `run:${runId}`;
export const teamRecipient = (teamId) => `team:${teamId}`;

/** Where the store lives under a data folder (DATA_HOME/data). */
export function coordinationDbPath(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) throw new CoordinationError('PATH_REQUIRED', 'coordinationDbPath needs the data folder.');
  return join(dataDir, COORDINATION_DB_FILE);
}

export class CoordinationError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CoordinationError';
    this.code = code;
    this.status = code === 'CLOSED' ? 503 : 400;
    Object.assign(this, extra);
  }
}

const SCHEMA_V1 = `
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  session_id   TEXT,
  team_id      TEXT,
  run_id       TEXT,
  kind         TEXT NOT NULL,
  priority     TEXT NOT NULL CHECK (priority IN ('critical', 'normal', 'low')),
  payload      TEXT NOT NULL DEFAULT 'null',
  coalesce_key TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX events_team ON events (team_id, seq);
CREATE INDEX events_session ON events (session_id, seq);
CREATE INDEX events_run ON events (run_id, seq);

CREATE TABLE deliveries (
  recipient      TEXT NOT NULL,
  event_id       TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  delivered_at   INTEGER,
  acked_at       INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  coalesced_into TEXT,
  merged         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (recipient, event_id)
) WITHOUT ROWID;
CREATE INDEX deliveries_seq ON deliveries (recipient, seq);
CREATE INDEX deliveries_open ON deliveries (recipient, seq) WHERE acked_at IS NULL;
CREATE INDEX deliveries_event ON deliveries (event_id);

CREATE TABLE cursors (
  recipient  TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     TEXT NOT NULL,
  slice_id    TEXT NOT NULL,
  glob        TEXT NOT NULL,
  run_id      TEXT,
  created_at  INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX claims_team ON claims (team_id, released_at);
CREATE UNIQUE INDEX claims_one_active ON claims (team_id, slice_id, glob) WHERE released_at IS NULL;

CREATE TABLE team_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL,
  slice_id   TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL,
  run_id     TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX team_tasks_team ON team_tasks (team_id, slice_id, id);

CREATE TABLE outbox (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  run_id     TEXT NOT NULL,
  text       TEXT NOT NULL,
  session_id TEXT,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX outbox_run ON outbox (run_id, n);
CREATE INDEX outbox_unsent ON outbox (run_id, n) WHERE sent_at IS NULL;
`;

/** Every schema change, in order. A new one is appended with the next version; one that shipped is never edited. */
export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'events, deliveries, cursors, claims, team_tasks, outbox', up: (db) => db.exec(SCHEMA_V1) }),
]);

const KIND_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, extra) => new CoordinationError(code, message, extra);

function idText(value, field, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw fail('FIELD_REQUIRED', `${field} is required.`, { field });
    return null;
  }
  if (typeof value !== 'string' || value.length > COORDINATION_LIMITS.id || CONTROL_RE.test(value)) {
    throw fail('FIELD_INVALID', `${field} must be text of at most ${COORDINATION_LIMITS.id} characters with no control character.`, { field });
  }
  return value;
}
function recipientText(value) {
  if (typeof value !== 'string' || !value || value.length > COORDINATION_LIMITS.recipient || CONTROL_RE.test(value)) {
    throw fail('RECIPIENT_INVALID', `A recipient is a name of at most ${COORDINATION_LIMITS.recipient} characters, like "session:<id>" or "run:<id>".`, { field: 'recipient' });
  }
  return value;
}
function kindList(kinds) {
  if (kinds === null || kinds === undefined) return null;
  const list = (Array.isArray(kinds) ? kinds : [kinds]).map((kind) => String(kind));
  for (const kind of list) if (!KIND_RE.test(kind)) throw fail('KIND_INVALID', `"${kind.slice(0, 80)}" is not an event kind.`, { field: 'kinds' });
  return list.length ? [...new Set(list)] : null;
}
function limitOf(value, fallback = COORDINATION_LIMITS.defaultReadLimit) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, COORDINATION_LIMITS.readLimit) : fallback;
}
function seqOf(value, field = 'afterSeq') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw fail('SEQ_INVALID', `${field} must be a whole number from 0.`, { field });
  return n;
}
function jsonText(value, field, maxBytes) {
  let out;
  try { out = JSON.stringify(value === undefined ? null : value); } catch (error) { throw fail('PAYLOAD_INVALID', `${field} cannot be written as JSON: ${error?.message || error}`, { field }); }
  if (out === undefined) throw fail('PAYLOAD_INVALID', `${field} cannot be written as JSON.`, { field });
  if (Buffer.byteLength(out, 'utf8') > maxBytes) throw fail('PAYLOAD_TOO_LARGE', `${field} is larger than ${Math.round(maxBytes / 1024)} KB.`, { field });
  return out;
}
function parseJson(textValue, fallback = null) {
  try { return JSON.parse(textValue); } catch { return fallback; }
}

function applyMigrations(db, migrations, now) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const latest = ordered.length ? ordered[ordered.length - 1].version : 0;
  const applied = Number(db.prepare('SELECT MAX(version) AS version FROM migrations').get()?.version) || 0;
  // A file a newer SynaBun wrote is never read with older rules: its tables may mean something else by now.
  if (applied > latest) throw fail('SCHEMA_NEWER', `The coordination store was written by a newer SynaBun (schema ${applied}; this one knows ${latest}).`, { found: applied, known: latest });
  for (const migration of ordered) {
    if (migration.version <= applied) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, String(migration.name || ''), now());
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* the failure below is the one to report */ }
      throw fail('MIGRATION_FAILED', `Coordination store migration ${migration.version} failed: ${error?.message || error}`, { version: migration.version, cause: error });
    }
  }
  return latest;
}

/**
 * Open (and create or upgrade) the coordination store.
 *
 * @param {object} options
 * @param {string} options.path                the database file (`coordinationDbPath(dataDir)`); a test passes its own
 * @param {() => number} [options.now]         epoch milliseconds
 * @param {() => string} [options.newId]       ids for events, claims' rows and outbox items the caller did not name
 * @param {number} [options.busyTimeoutMs]     how long a statement waits for another connection's lock
 * @param {'FULL'|'NORMAL'} [options.synchronous] FULL (default): a committed event survives a power cut
 * @param {(tag: string, detail: any) => void} [options.log]
 * @param {readonly object[]} [options.migrations] the schema steps (tests add one to try an upgrade)
 */
export function createCoordinationStore({
  path,
  now = Date.now,
  newId = randomUUID,
  busyTimeoutMs = 5000,
  synchronous = 'FULL',
  log = () => {},
  migrations = MIGRATIONS,
} = {}) {
  if (typeof path !== 'string' || !path) throw fail('PATH_REQUIRED', 'createCoordinationStore needs the path of its database file.');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let schemaVersion;
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA synchronous = ${synchronous === 'NORMAL' ? 'NORMAL' : 'FULL'}`);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(busyTimeoutMs) || 0))}`);
    db.exec('PRAGMA foreign_keys = ON');
    schemaVersion = applyMigrations(db, migrations, now);
  } catch (error) {
    try { db.close(); } catch { /* already unusable */ }
    throw error;
  }

  let closed = false;
  let inTransaction = false;
  const subscribers = new Set();   // { filter, fn }
  const waiters = new Set();       // { matches(notice), wake(), finish(result) }
  const notices = [];              // committed appends not yet told to subscribers and waiters
  let publishing = false;

  function open() { if (closed) throw fail('CLOSED', 'The coordination store is closed.'); }

  /** One write transaction. A call made inside another joins it. */
  function transaction(fn) {
    open();
    if (inTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    let out;
    try {
      out = fn();
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* nothing was open any more */ }
      throw error;
    } finally {
      inTransaction = false;
    }
    return out;
  }

  // ── rows → what callers get ────────────────────────────────────────────────
  const eventView = (row) => ({
    id: row.id,
    seq: Number(row.seq),
    sessionId: row.session_id ?? null,
    teamId: row.team_id ?? null,
    runId: row.run_id ?? null,
    kind: row.kind,
    priority: row.priority,
    payload: parseJson(row.payload),
    createdAt: iso(row.created_at),
  });
  const deliveryView = (row) => ({
    ...eventView(row),
    delivery: {
      recipient: row.recipient,
      deliveredAt: iso(row.delivered_at),
      ackedAt: iso(row.acked_at),
      attempts: Number(row.attempts) || 0,
      // Handed out before and not acknowledged then: the consumer may have seen it already.
      redelivered: (Number(row.attempts) || 0) > 1,
      // How many older low-priority events this one stands for (coalesce).
      merged: Number(row.merged) || 0,
    },
  });
  const claimView = (row) => ({
    id: Number(row.id), teamId: row.team_id, sliceId: row.slice_id, glob: row.glob, runId: row.run_id ?? null,
    createdAt: iso(row.created_at), releasedAt: iso(row.released_at),
  });
  const journalView = (row) => ({
    id: Number(row.id), teamId: row.team_id, sliceId: row.slice_id || null, state: row.state, runId: row.run_id ?? null,
    data: parseJson(row.data, {}), createdAt: iso(row.created_at),
  });
  const outboxView = (row) => ({
    id: row.id, runId: row.run_id, text: row.text, sessionId: row.session_id ?? null, meta: parseJson(row.meta, {}),
    createdAt: iso(row.created_at), sentAt: iso(row.sent_at), attempts: Number(row.attempts) || 0,
  });

  // ── events ─────────────────────────────────────────────────────────────────
  const selectEventById = db.prepare('SELECT * FROM events WHERE id = ?');
  const insertEvent = db.prepare('INSERT INTO events (id, session_id, team_id, run_id, kind, priority, payload, coalesce_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertDelivery = db.prepare('INSERT INTO deliveries (recipient, event_id, seq) VALUES (?, ?, ?)');
  const selectRecipientsOfEvent = db.prepare('SELECT recipient FROM deliveries WHERE event_id = ? ORDER BY recipient');

  function readEventInput(event) {
    if (!isObject(event)) throw fail('EVENT_INVALID', 'An event is an object with at least a kind.');
    const kind = typeof event.kind === 'string' ? event.kind.trim() : '';
    if (!KIND_RE.test(kind)) throw fail('KIND_INVALID', 'kind is a lower-case name like "run.result" (letters, digits, ".", "_", ":" and "-", at most 64).', { field: 'kind' });
    const priority = event.priority === undefined || event.priority === null || event.priority === '' ? (KIND_PRIORITY[kind] || DEFAULT_EVENT_PRIORITY) : String(event.priority).toLowerCase();
    if (!EVENT_PRIORITIES.includes(priority)) throw fail('PRIORITY_INVALID', `priority must be one of ${EVENT_PRIORITIES.join(', ')}.`, { field: 'priority' });
    const to = event.to === undefined || event.to === null ? [] : (Array.isArray(event.to) ? event.to : [event.to]);
    if (to.length > COORDINATION_LIMITS.recipients) throw fail('RECIPIENTS_TOO_MANY', `An event is addressed to at most ${COORDINATION_LIMITS.recipients} recipients.`, { field: 'to' });
    return {
      id: idText(event.id, 'id') || String(newId()),
      sessionId: idText(event.sessionId, 'sessionId'),
      teamId: idText(event.teamId, 'teamId'),
      runId: idText(event.runId, 'runId'),
      kind,
      priority,
      payload: jsonText(event.payload, 'payload', COORDINATION_LIMITS.payloadBytes),
      coalesceKey: idText(event.coalesceKey, 'coalesceKey'),
      to: [...new Set(to.map(recipientText))],
    };
  }

  function appendOne(input) {
    const existing = selectEventById.get(input.id);
    // The same id again: the event is there already. Nothing is written and nobody is woken a second time.
    if (existing) return { result: { id: existing.id, seq: Number(existing.seq), duplicate: true }, notice: null };
    const createdAt = now();
    const seq = Number(insertEvent.run(input.id, input.sessionId, input.teamId, input.runId, input.kind, input.priority, input.payload, input.coalesceKey, createdAt).lastInsertRowid);
    for (const recipient of input.to) insertDelivery.run(recipient, input.id, seq);
    const event = { id: input.id, seq, sessionId: input.sessionId, teamId: input.teamId, runId: input.runId, kind: input.kind, priority: input.priority, payload: parseJson(input.payload), createdAt: iso(createdAt) };
    return { result: { id: input.id, seq, duplicate: false }, notice: { event, recipients: input.to } };
  }

  /**
   * Add an event to the log and address it.
   * @param {object} event
   * @param {string} [event.id]         the caller's own id: appending it again stores nothing new (`duplicate: true`)
   * @param {string} event.kind         "run.result", "slice.state", …
   * @param {'critical'|'normal'|'low'} [event.priority] default: KIND_PRIORITY of the kind, else normal
   * @param {string} [event.sessionId]  the Assistant session it belongs to
   * @param {string} [event.teamId]
   * @param {string} [event.runId]
   * @param {any} [event.payload]       JSON, at most 256 KB
   * @param {string|string[]} [event.to] recipients: each gets a delivery it must acknowledge. None: logged only.
   * @param {string} [event.coalesceKey] low priority only: events of one key are merged by `coalesce` (default key: kind, run, team and session)
   * @returns {{ id: string, seq: number, duplicate: boolean }}
   */
  function append(event) {
    const input = readEventInput(event);
    const { result, notice } = transaction(() => appendOne(input));
    if (notice) publish(notice);
    return result;
  }

  /** Several events in one transaction: all of them are stored, or none. Same answers as `append`, in order. */
  function appendMany(events) {
    if (!Array.isArray(events)) throw fail('EVENT_INVALID', 'appendMany takes a list of events.');
    const inputs = events.map(readEventInput);
    const done = transaction(() => inputs.map(appendOne));
    for (const { notice } of done) if (notice) publish(notice);
    return done.map(({ result }) => result);
  }

  /** One event by its id (with the recipients it was addressed to), or null. */
  function get(id) {
    open();
    const row = selectEventById.get(String(id));
    return row ? { ...eventView(row), to: selectRecipientsOfEvent.all(row.id).map((r) => r.recipient) } : null;
  }

  /** The seq of the newest event (0 for an empty log). */
  function lastSeq() {
    open();
    return Number(db.prepare('SELECT MAX(seq) AS seq FROM events').get()?.seq) || 0;
  }

  /**
   * The log itself, oldest first: every event after `afterSeq` that matches, whoever it was addressed to. Reading
   * it delivers and acknowledges nothing (a timeline, a scheduler's replay). `read` is the mailbox.
   */
  function events({ afterSeq = 0, teamId = null, sessionId = null, runId = null, runIds = null, kinds = null, limit = null } = {}) {
    open();
    const where = ['seq > ?'];
    const args = [seqOf(afterSeq)];
    for (const [column, value, field] of [['team_id', teamId, 'teamId'], ['session_id', sessionId, 'sessionId'], ['run_id', runId, 'runId']]) {
      const wanted = idText(value, field);
      if (wanted !== null) { where.push(`${column} = ?`); args.push(wanted); }
    }
    // Several runs at once (a workflow's wait): an empty list matches nothing.
    if (runIds !== null && runIds !== undefined) {
      const runs = [...new Set((Array.isArray(runIds) ? runIds : [runIds]).map((id) => idText(id, 'runIds', { required: true })))];
      if (!runs.length) return [];
      if (runs.length > COORDINATION_LIMITS.runIds) throw fail('FIELD_INVALID', `runIds names at most ${COORDINATION_LIMITS.runIds} runs.`, { field: 'runIds' });
      where.push(`run_id IN (${runs.map(() => '?').join(', ')})`);
      args.push(...runs);
    }
    const list = kindList(kinds);
    if (list) { where.push(`kind IN (${list.map(() => '?').join(', ')})`); args.push(...list); }
    return db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`).all(...args, limitOf(limit)).map(eventView);
  }

  // ── the mailbox: deliveries, acknowledgements, the cursor ──────────────────
  const selectCursor = db.prepare('SELECT seq FROM cursors WHERE recipient = ?');
  const selectOpenFloor = db.prepare('SELECT MIN(seq) AS seq FROM deliveries WHERE recipient = ? AND acked_at IS NULL');
  const selectCeiling = db.prepare('SELECT MAX(seq) AS seq FROM deliveries WHERE recipient = ?');
  const upsertCursor = db.prepare('INSERT INTO cursors (recipient, seq, updated_at) VALUES (?, ?, ?) ON CONFLICT (recipient) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at');
  const markDelivered = db.prepare('UPDATE deliveries SET delivered_at = COALESCE(delivered_at, ?), attempts = attempts + 1 WHERE recipient = ? AND event_id = ?');
  const ackOne = db.prepare('UPDATE deliveries SET acked_at = ? WHERE recipient = ? AND event_id = ? AND acked_at IS NULL');
  const ackUpTo = db.prepare('UPDATE deliveries SET acked_at = ? WHERE recipient = ? AND seq <= ? AND acked_at IS NULL');

  /** The seq up to which everything addressed to the recipient is acknowledged (0: nothing yet). */
  function cursor(recipient) {
    open();
    return Number(selectCursor.get(recipientText(recipient))?.seq) || 0;
  }
  /**
   * How many events a recipient has not acknowledged (nothing is handed out or recorded).
   * @param {string} recipient
   * @param {{ kinds?: string|string[], priority?: string|string[] }} [options]
   */
  function openCount(recipient, { kinds = null, priority = null } = {}) {
    open();
    const who = recipientText(recipient);
    const list = kindList(kinds);
    const levels = priority === null || priority === undefined ? null : (Array.isArray(priority) ? priority : [priority]).map((level) => String(level));
    if (levels) for (const level of levels) if (!EVENT_PRIORITIES.includes(level)) throw fail('PRIORITY_INVALID', `priority must be one of ${EVENT_PRIORITIES.join(', ')}.`, { field: 'priority' });
    if (!list && !levels) return Number(db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE recipient = ? AND acked_at IS NULL').get(who)?.n) || 0;
    const where = ['d.recipient = ?', 'd.acked_at IS NULL'];
    const args = [who];
    if (list) { where.push(`e.kind IN (${list.map(() => '?').join(', ')})`); args.push(...list); }
    if (levels) { where.push(`e.priority IN (${levels.map(() => '?').join(', ')})`); args.push(...levels); }
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM deliveries d JOIN events e ON e.id = d.event_id WHERE ${where.join(' AND ')}`).get(...args)?.n) || 0;
  }
  /**
   * The recipients that have something open, with how many (after a restart: whose mailbox still holds events).
   * @param {{ prefix?: string }} [query] `prefix`: only names that start with it ("session:")
   * @returns {{ recipient: string, open: number, oldestSeq: number }[]}
   */
  function recipients({ prefix = null } = {}) {
    open();
    const rows = db.prepare('SELECT recipient, COUNT(*) AS n, MIN(seq) AS seq FROM deliveries WHERE acked_at IS NULL GROUP BY recipient ORDER BY MIN(seq) ASC').all();
    const start = prefix === null || prefix === undefined ? '' : String(prefix);
    return rows.filter((row) => !start || String(row.recipient).startsWith(start)).map((row) => ({ recipient: row.recipient, open: Number(row.n) || 0, oldestSeq: Number(row.seq) || 0 }));
  }
  /** After acknowledgements: the cursor is just below the oldest event still open, or at the newest when none is. */
  function settleCursor(recipient) {
    const floor = selectOpenFloor.get(recipient)?.seq;
    const next = floor === null || floor === undefined ? (Number(selectCeiling.get(recipient)?.seq) || 0) : Number(floor) - 1;
    const current = Number(selectCursor.get(recipient)?.seq) || 0;
    // Deliveries are only ever added above every earlier one, so the cursor never has a reason to move back.
    const seq = Math.max(current, next);
    if (seq !== current || !selectCursor.get(recipient)) upsertCursor.run(recipient, seq, now());
    return seq;
  }

  function handOut(rows, recipient, peek) {
    if (!peek && rows.length) {
      const at = now();
      for (const row of rows) {
        markDelivered.run(at, recipient, row.id);
        row.delivered_at = row.delivered_at ?? at;
        row.attempts = (Number(row.attempts) || 0) + 1;
      }
    }
    return rows.map(deliveryView);
  }

  const DELIVERY_COLUMNS = 'e.*, d.recipient, d.delivered_at, d.acked_at, d.attempts, d.merged';

  /**
   * A recipient's events after a position, oldest first: the cursor read.
   * By default from the recipient's cursor and only what it has not acknowledged, so a consumer that starts again
   * (a restart, a new turn) gets every open event once more. Handing an event out records `deliveredAt` and counts
   * an attempt; it acknowledges nothing.
   * @param {object} query
   * @param {string} query.recipient
   * @param {number} [query.afterSeq]      default: the recipient's cursor
   * @param {string|string[]} [query.kinds]
   * @param {number} [query.limit]         default 100, at most 1000
   * @param {boolean} [query.includeAcked] also what was acknowledged (a history view)
   * @param {boolean} [query.peek]         look without recording a delivery
   */
  function read({ recipient, afterSeq = null, kinds = null, limit = null, includeAcked = false, peek = false } = {}) {
    const who = recipientText(recipient);
    const list = kindList(kinds);
    const max = limitOf(limit);
    return transaction(() => {
      const from = afterSeq === null || afterSeq === undefined ? (Number(selectCursor.get(who)?.seq) || 0) : seqOf(afterSeq);
      const where = ['d.recipient = ?', 'd.seq > ?'];
      const args = [who, from];
      if (!includeAcked) where.push('d.acked_at IS NULL');
      if (list) { where.push(`e.kind IN (${list.map(() => '?').join(', ')})`); args.push(...list); }
      const rows = db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM deliveries d JOIN events e ON e.id = d.event_id WHERE ${where.join(' AND ')} ORDER BY d.seq ASC LIMIT ?`).all(...args, max);
      // An acknowledged event shown as history is not handed out again.
      return includeAcked ? rows.map(deliveryView) : handOut(rows, who, peek);
    });
  }

  /**
   * Everything a recipient has not acknowledged, in the order to deal with it: critical events first, then the rest,
   * each group oldest first. This is what a turn is composed from; like `read` it records the delivery.
   * @param {string} recipient
   * @param {object} [options]
   * @param {string|string[]} [options.kinds]
   * @param {number} [options.limit]     default 100, at most 1000
   * @param {boolean} [options.peek]     look without recording a delivery
   * @param {boolean} [options.coalesce] merge low-priority events first (`coalesce`)
   */
  function pending(recipient, { kinds = null, limit = null, peek = false, coalesce: merge = false } = {}) {
    const who = recipientText(recipient);
    const list = kindList(kinds);
    const max = limitOf(limit);
    return transaction(() => {
      if (merge) coalesce(who);
      const where = ['d.recipient = ?', 'd.acked_at IS NULL'];
      const args = [who];
      if (list) { where.push(`e.kind IN (${list.map(() => '?').join(', ')})`); args.push(...list); }
      const rows = db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM deliveries d JOIN events e ON e.id = d.event_id WHERE ${where.join(' AND ')} ORDER BY (e.priority = 'critical') DESC, d.seq ASC LIMIT ?`).all(...args, max);
      return handOut(rows, who, peek);
    });
  }

  /**
   * The recipient dealt with these events: they are not handed out again. Ids it was never sent, or already
   * acknowledged, are skipped, so acknowledging twice is harmless.
   * @returns {{ acked: number, cursor: number }}
   */
  function ack(recipient, eventIds) {
    const who = recipientText(recipient);
    const ids = (Array.isArray(eventIds) ? eventIds : [eventIds]).filter((id) => id !== null && id !== undefined).map((id) => String(id));
    return transaction(() => {
      const at = now();
      let acked = 0;
      for (const id of new Set(ids)) acked += Number(ackOne.run(at, who, id).changes) || 0;
      return { acked, cursor: settleCursor(who) };
    });
  }

  /** Acknowledge everything addressed to the recipient up to and including `seq`. */
  function ackThrough(recipient, seq) {
    const who = recipientText(recipient);
    const upTo = seqOf(seq, 'seq');
    return transaction(() => {
      const acked = Number(ackUpTo.run(now(), who, upTo).changes) || 0;
      return { acked, cursor: settleCursor(who) };
    });
  }

  /**
   * Fold a recipient's open low-priority events: of every group that says the same kind of thing (same
   * `coalesceKey`, else same kind, run, team and session) only the newest stays open, and it says how many it stands
   * for (`delivery.merged`). The older ones are settled, not deleted: the log keeps them. Critical and normal events
   * are never touched.
   * @returns {{ merged: number, kept: { id: string, seq: number, merged: number }[] }}
   */
  function coalesce(recipient) {
    const who = recipientText(recipient);
    return transaction(() => {
      const rows = db.prepare(`SELECT d.event_id, d.seq, d.merged, e.kind, e.run_id, e.team_id, e.session_id, e.coalesce_key
        FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE d.recipient = ? AND d.acked_at IS NULL AND e.priority = 'low' ORDER BY d.seq ASC`).all(who);
      const groups = new Map();
      for (const row of rows) {
        const key = row.coalesce_key !== null && row.coalesce_key !== undefined
          ? `key\u0000${row.coalesce_key}`
          : ['kind', row.kind, row.run_id ?? '', row.team_id ?? '', row.session_id ?? ''].join('\u0000');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const settle = db.prepare('UPDATE deliveries SET acked_at = ?, coalesced_into = ? WHERE recipient = ? AND event_id = ? AND acked_at IS NULL');
      const grow = db.prepare('UPDATE deliveries SET merged = merged + ? WHERE recipient = ? AND event_id = ?');
      const at = now();
      let merged = 0;
      const kept = [];
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const newest = group[group.length - 1];
        let folded = 0;
        for (const older of group.slice(0, -1)) {
          settle.run(at, newest.event_id, who, older.event_id);
          folded += 1 + (Number(older.merged) || 0);
        }
        grow.run(folded, who, newest.event_id);
        merged += group.length - 1;
        kept.push({ id: newest.event_id, seq: Number(newest.seq), merged: (Number(newest.merged) || 0) + folded });
      }
      if (merged) settleCursor(who);
      return { merged, kept };
    });
  }

  // ── wake-ups ───────────────────────────────────────────────────────────────
  function matchesFilter(filter, notice) {
    if (typeof filter === 'function') return !!filter(notice.event, { recipients: notice.recipients });
    if (!filter) return true;
    const { event, recipients } = notice;
    const among = (wanted, value) => (Array.isArray(wanted) ? wanted.includes(value) : wanted === value);
    if (filter.recipient !== undefined && filter.recipient !== null && !recipients.includes(filter.recipient)) return false;
    if (filter.kinds !== undefined && filter.kinds !== null && !among(filter.kinds, event.kind)) return false;
    if (filter.priority !== undefined && filter.priority !== null && !among(filter.priority, event.priority)) return false;
    for (const field of ['teamId', 'sessionId', 'runId']) {
      if (filter[field] !== undefined && filter[field] !== null && filter[field] !== event[field]) return false;
    }
    return true;
  }

  /**
   * Tell everyone who listens about committed events, oldest first. An event appended by a listener is told after
   * the one that is being told now, so every listener sees events in seq order.
   */
  function publish(notice) {
    notices.push(notice);
    if (publishing) return;
    publishing = true;
    try {
      while (notices.length) {
        const next = notices.shift();
        for (const subscriber of [...subscribers]) {
          if (!subscribers.has(subscriber)) continue;
          try { if (matchesFilter(subscriber.filter, next)) subscriber.fn(next.event, { recipients: [...next.recipients] }); }
          catch (error) { try { log('coordination:subscriber-error', error?.message || String(error)); } catch { /* a logger must not stop delivery */ } }
        }
        for (const waiter of [...waiters]) {
          if (!waiters.has(waiter)) continue;
          try { if (waiter.matches(next)) waiter.wake(); }
          catch (error) { waiter.finish(null, error); }
        }
      }
    } finally {
      publishing = false;
    }
  }

  /**
   * Be called for every event appended in this process from now on that matches, right after its transaction
   * committed (never for one that was rolled back, never for a duplicate id). A wake-up, not a delivery: it records
   * nothing and a listener that throws harms nobody else. What must not be missed is read from the mailbox.
   * @param {object|((event: object, info: { recipients: string[] }) => boolean)|null} filter
   *   `{ recipient, kinds, priority, teamId, sessionId, runId }` (each optional; `kinds` and `priority` take one or a list), a predicate, or null for every event
   * @param {(event: object, info: { recipients: string[] }) => void} fn
   * @returns {() => void} stop listening
   */
  function subscribe(filter, fn) {
    open();
    if (typeof fn !== 'function') throw fail('SUBSCRIBER_INVALID', 'subscribe needs a function to call.');
    if (isObject(filter) && filter.kinds !== undefined && filter.kinds !== null) kindList(filter.kinds);
    const subscriber = { filter: filter ?? null, fn };
    subscribers.add(subscriber);
    return () => { subscribers.delete(subscriber); };
  }

  /**
   * Wait until there is something to read, then read it.
   * With `recipient`: the mailbox, like `read` (open events after `afterSeq`, default the cursor). Without one: the
   * log, like `events` (events after `afterSeq`, default the newest now, so only what comes).
   * Resolves at once when something is there already. Never rejects for a timeout: `timedOut: true` and no events.
   * @param {object} query
   * @param {string} [query.recipient]
   * @param {string|string[]} [query.kinds]
   * @param {number} [query.afterSeq]
   * @param {number} [query.timeoutMs]  default 30 s, at most 10 minutes; 0 only looks
   * @param {number} [query.limit]
   * @param {string} [query.teamId]     the log only
   * @param {string} [query.sessionId]  the log only
   * @param {string} [query.runId]      the log only
   * @param {AbortSignal} [query.signal] give up early (`aborted: true`)
   * @param {number} [query.pollMs]     also look every so often: only for a file another process appends to, which
   *                                    cannot wake this one
   * @returns {Promise<{ events: object[], timedOut: boolean, closed: boolean, aborted: boolean }>}
   */
  function waitFor({ recipient = null, kinds = null, afterSeq = null, timeoutMs = COORDINATION_LIMITS.defaultWaitMs, limit = null, teamId = null, sessionId = null, runId = null, signal = null, pollMs = null } = {}) {
    const answer = (events_, extra = {}) => ({ events: events_, timedOut: false, closed: false, aborted: false, ...extra });
    let look;
    let matches;
    try {
      if (closed) return Promise.resolve(answer([], { closed: true }));
      const list = kindList(kinds);
      if (recipient !== null && recipient !== undefined) {
        const who = recipientText(recipient);
        const from = afterSeq === null || afterSeq === undefined ? cursor(who) : seqOf(afterSeq);
        look = () => read({ recipient: who, afterSeq: from, kinds: list, limit });
        matches = (notice) => notice.event.seq > from && notice.recipients.includes(who) && (!list || list.includes(notice.event.kind));
      } else {
        const from = afterSeq === null || afterSeq === undefined ? lastSeq() : seqOf(afterSeq);
        const scope = { teamId: idText(teamId, 'teamId'), sessionId: idText(sessionId, 'sessionId'), runId: idText(runId, 'runId') };
        look = () => events({ afterSeq: from, kinds: list, limit, ...scope });
        matches = (notice) => notice.event.seq > from && (!list || list.includes(notice.event.kind))
          && Object.entries(scope).every(([field, value]) => value === null || notice.event[field] === value);
      }
      const first = look();
      if (first.length) return Promise.resolve(answer(first));
    } catch (error) {
      return Promise.reject(error);
    }
    const asked = Number(timeoutMs);
    const budget = Math.max(0, Math.min(COORDINATION_LIMITS.maxWaitMs, Number.isFinite(asked) ? asked : COORDINATION_LIMITS.defaultWaitMs));
    if (budget === 0) return Promise.resolve(answer([], { timedOut: true }));
    if (signal?.aborted) return Promise.resolve(answer([], { aborted: true }));
    return new Promise((resolveWait, rejectWait) => {
      let timer = null;
      let poll = null;
      const onAbort = () => waiter.finish(answer([], { aborted: true }));
      const waiter = {
        matches,
        wake() {
          const found = look();
          if (found.length) waiter.finish(answer(found));
        },
        finish(result, error = null) {
          if (!waiters.delete(waiter)) return;
          if (timer) clearTimeout(timer);
          if (poll) clearInterval(poll);
          signal?.removeEventListener?.('abort', onAbort);
          if (error) rejectWait(error); else resolveWait(result);
        },
      };
      waiters.add(waiter);
      // A wait is never what keeps a process alive (a server that is going down, a script that is done): its timers
      // are unreferenced, as the dispatcher's own waits are (lib/assistant-run-wait.js). `close()` answers it.
      timer = setTimeout(() => waiter.finish(answer([], { timedOut: true })), budget);
      timer.unref?.();
      const every = Number(pollMs);
      if (Number.isFinite(every) && every > 0) {
        poll = setInterval(() => { try { waiter.wake(); } catch (error) { waiter.finish(null, error); } }, Math.max(20, every));
        poll.unref?.();
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  // ── claims ─────────────────────────────────────────────────────────────────
  const selectActiveClaims = db.prepare('SELECT * FROM claims WHERE team_id = ? AND released_at IS NULL ORDER BY id ASC');
  const insertClaim = db.prepare('INSERT INTO claims (team_id, slice_id, glob, run_id, created_at) VALUES (?, ?, ?, ?, ?)');
  const moveClaim = db.prepare('UPDATE claims SET run_id = ? WHERE id = ?');

  function slugText(value, field) {
    if (!isTeamSlug(value)) throw fail('FIELD_INVALID', `${field} is a lower-case name of letters, digits and hyphens (lib/teams/schema.js).`, { field });
    return value;
  }
  function globList(globs, { required = true } = {}) {
    if (globs === null || globs === undefined) {
      if (required) throw fail('FIELD_REQUIRED', 'globs is required: the patterns to claim.', { field: 'globs' });
      return null;
    }
    const list = [...new Set((Array.isArray(globs) ? globs : [globs]).map((glob) => normalizeOwnedPath(glob)))];
    if (!list.length && required) throw fail('FIELD_REQUIRED', 'globs is required: the patterns to claim.', { field: 'globs' });
    if (list.length > COORDINATION_LIMITS.claimGlobs) throw fail('CLAIM_INVALID', `One claim names at most ${COORDINATION_LIMITS.claimGlobs} patterns.`, { field: 'globs' });
    const problems = list.map((glob) => ({ glob, problem: ownedPathProblem(glob) })).filter((entry) => entry.problem);
    if (problems.length) throw fail('CLAIM_INVALID', problems[0].problem.message, { field: 'globs', problems: problems.map(({ glob, problem }) => ({ glob, ...problem })) });
    return list;
  }

  /**
   * A slice takes files for itself while it works. All of the patterns are taken, or none: when one of them overlaps
   * a pattern another slice of the team holds, nothing is written and the answer names every clash. The same slice
   * claiming a pattern it already holds keeps the one claim (a later run of the slice takes it over).
   * Patterns are owned paths (lib/teams/schema.js): project-relative, `*`, `?` and `**`, never outside the project.
   * @param {object} input
   * @param {string} input.teamId
   * @param {string} input.sliceId
   * @param {string} [input.runId]   the run that works the slice now
   * @param {string|string[]} input.globs
   * @returns {{ ok: true, claims: object[] } | { ok: false, code: 'CLAIM_CONFLICT', conflicts: { glob: string, heldBy: object }[] }}
   * @throws {CoordinationError} `CLAIM_INVALID` for a pattern that is not an owned path
   */
  function claim({ teamId, sliceId, runId = null, globs } = {}) {
    const team = slugText(teamId, 'teamId');
    const slice = slugText(sliceId, 'sliceId');
    const run = idText(runId, 'runId');
    const list = globList(globs);
    return transaction(() => {
      const active = selectActiveClaims.all(team);
      const conflicts = [];
      for (const glob of list) {
        for (const row of active) {
          if (row.slice_id !== slice && globsOverlap(glob, row.glob)) conflicts.push({ glob, heldBy: claimView(row) });
        }
      }
      if (conflicts.length) return { ok: false, code: 'CLAIM_CONFLICT', conflicts };
      const at = now();
      const claims = list.map((glob) => {
        const mine = active.find((row) => row.slice_id === slice && row.glob === glob);
        if (mine) {
          if (run && mine.run_id !== run) { moveClaim.run(run, mine.id); mine.run_id = run; }
          return claimView(mine);
        }
        const id = Number(insertClaim.run(team, slice, glob, run, at).lastInsertRowid);
        return claimView({ id, team_id: team, slice_id: slice, glob, run_id: run, created_at: at, released_at: null });
      });
      return { ok: true, claims };
    });
  }

  /**
   * Give claims back. `teamId` alone releases the whole team's; `sliceId`, `runId` and `globs` narrow it.
   * @returns {{ released: number }}
   */
  function release({ teamId, sliceId = null, runId = null, globs = null } = {}) {
    const where = ['team_id = ?', 'released_at IS NULL'];
    const args = [slugText(teamId, 'teamId')];
    if (sliceId !== null && sliceId !== undefined) { where.push('slice_id = ?'); args.push(slugText(sliceId, 'sliceId')); }
    const run = idText(runId, 'runId');
    if (run !== null) { where.push('run_id = ?'); args.push(run); }
    const list = globList(globs, { required: false });
    if (list && !list.length) return { released: 0 };
    if (list) { where.push(`glob IN (${list.map(() => '?').join(', ')})`); args.push(...list); }
    return transaction(() => ({ released: Number(db.prepare(`UPDATE claims SET released_at = ? WHERE ${where.join(' AND ')}`).run(now(), ...args).changes) || 0 }));
  }

  /**
   * The claims of a team, oldest first. `path`: only those that hold this project-relative file ("who has it?").
   * @param {object} query
   * @param {string} query.teamId
   * @param {string} [query.sliceId]
   * @param {string} [query.runId]
   * @param {string} [query.path]
   * @param {boolean} [query.includeReleased] also claims given back (history)
   */
  function claimsFor({ teamId, sliceId = null, runId = null, path = null, includeReleased = false } = {}) {
    open();
    const where = ['team_id = ?'];
    const args = [slugText(teamId, 'teamId')];
    if (!includeReleased) where.push('released_at IS NULL');
    if (sliceId !== null && sliceId !== undefined) { where.push('slice_id = ?'); args.push(slugText(sliceId, 'sliceId')); }
    const run = idText(runId, 'runId');
    if (run !== null) { where.push('run_id = ?'); args.push(run); }
    let rows = db.prepare(`SELECT * FROM claims WHERE ${where.join(' AND ')} ORDER BY id ASC`).all(...args);
    if (path !== null && path !== undefined) {
      const file = normalizeRelPath(path);
      if (file === null) throw fail('FIELD_INVALID', 'path is a file path relative to the project.', { field: 'path' });
      rows = rows.filter((row) => matchesOwnedPath(row.glob, file));
    }
    return rows.map(claimView);
  }

  // ── the journal of team tasks ──────────────────────────────────────────────
  const insertJournal = db.prepare('INSERT INTO team_tasks (team_id, slice_id, state, run_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)');

  function stateText(value) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(value)) throw fail('FIELD_INVALID', `state is a lower-case name of at most ${COORDINATION_LIMITS.state} characters, like "running".`, { field: 'state' });
    return value;
  }

  const journal = Object.freeze({
    /**
     * Record that a team (no `sliceId`) or one of its slices is in a state now. Entries are only ever added: the
     * newest one of a team or slice is its state, the ones before it are how it got there.
     * @param {{ teamId: string, sliceId?: string|null, state: string, runId?: string|null, data?: object }} entry
     *   `data`: what recovery needs to carry on (the plan, a branch, a commit, an error), JSON, at most 64 KB
     * @returns {object} the entry as stored
     */
    write({ teamId, sliceId = null, state, runId = null, data = {} } = {}) {
      const team = slugText(teamId, 'teamId');
      const slice = sliceId === null || sliceId === undefined || sliceId === '' ? '' : slugText(sliceId, 'sliceId');
      const name = stateText(state);
      const run = idText(runId, 'runId');
      if (!isObject(data)) throw fail('FIELD_INVALID', 'data is an object.', { field: 'data' });
      const body = jsonText(data, 'data', COORDINATION_LIMITS.journalDataBytes);
      return transaction(() => {
        const at = now();
        const id = Number(insertJournal.run(team, slice, name, run, body, at).lastInsertRowid);
        return journalView({ id, team_id: team, slice_id: slice, state: name, run_id: run, data: body, created_at: at });
      });
    },
    /**
     * A team's entries, oldest first. `sliceId` undefined: the team's and every slice's; null: the team's own only.
     * @param {{ teamId: string, sliceId?: string|null, afterId?: number, limit?: number }} query
     */
    read({ teamId, sliceId, afterId = 0, limit = null } = {}) {
      open();
      const where = ['team_id = ?', 'id > ?'];
      const args = [slugText(teamId, 'teamId'), seqOf(afterId, 'afterId')];
      if (sliceId !== undefined) { where.push('slice_id = ?'); args.push(sliceId === null || sliceId === '' ? '' : slugText(sliceId, 'sliceId')); }
      return db.prepare(`SELECT * FROM team_tasks WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`).all(...args, limitOf(limit, 500)).map(journalView);
    },
    /**
     * Where a team stands: its own newest entry and the newest entry of each slice.
     * @returns {{ teamId: string, team: object|null, slices: Record<string, object> }}
     */
    state(teamId) {
      open();
      const rows = db.prepare('SELECT * FROM team_tasks WHERE id IN (SELECT MAX(id) FROM team_tasks WHERE team_id = ? GROUP BY slice_id) ORDER BY id ASC').all(slugText(teamId, 'teamId'));
      const out = { teamId, team: null, slices: {} };
      for (const row of rows) {
        if (row.slice_id) out.slices[row.slice_id] = journalView(row);
        else out.team = journalView(row);
      }
      return out;
    },
    /**
     * Every team the journal knows, by its own newest entry, oldest team first. `states`: only teams whose newest
     * state is one of these (after a restart: the teams that were under way).
     * @param {{ states?: string[] }} [query]
     */
    teams({ states = null } = {}) {
      open();
      const rows = db.prepare("SELECT * FROM team_tasks WHERE id IN (SELECT MAX(id) FROM team_tasks WHERE slice_id = '' GROUP BY team_id) ORDER BY id ASC").all();
      const wanted = Array.isArray(states) ? new Set(states) : null;
      return rows.filter((row) => !wanted || wanted.has(row.state)).map(journalView);
    },
  });

  // ── the outbox: follow-ups for runs ────────────────────────────────────────
  const selectOutboxById = db.prepare('SELECT * FROM outbox WHERE id = ?');
  const insertOutbox = db.prepare('INSERT INTO outbox (id, run_id, text, session_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const selectUnsent = db.prepare('SELECT * FROM outbox WHERE run_id = ? AND sent_at IS NULL ORDER BY n ASC LIMIT ?');
  const countAttempt = db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?');
  const markSent = db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ? AND sent_at IS NULL');
  const countUnsent = db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE run_id = ? AND sent_at IS NULL');
  const selectAllUnsent = db.prepare('SELECT * FROM outbox WHERE run_id = ? AND sent_at IS NULL ORDER BY n ASC');
  const deleteUnsent = db.prepare('DELETE FROM outbox WHERE id = ? AND sent_at IS NULL');

  const outbox = Object.freeze({
    /**
     * Queue a follow-up for a run. It stays queued until `markSent` says the run took it, across restarts.
     * @param {{ id?: string, runId: string, text: string, sessionId?: string|null, meta?: object, maxQueued?: number }} item
     *   `id`: the caller's own; queueing it again stores nothing new (`duplicate: true`)
     *   `maxQueued`: the admission bound: with that many of the run's items still unsent, nothing is stored and
     *   `OUTBOX_FULL` (409, with `queued` and `limit`) is thrown
     * @returns {{ id: string, duplicate: boolean }}
     */
    enqueue({ id = null, runId, text, sessionId = null, meta = {}, maxQueued = null } = {}) {
      const run = idText(runId, 'runId', { required: true });
      if (typeof text !== 'string' || !text.trim()) throw fail('FIELD_REQUIRED', 'text is required: what the run is told.', { field: 'text' });
      if (text.length > COORDINATION_LIMITS.outboxText) throw fail('FIELD_INVALID', `text is at most ${COORDINATION_LIMITS.outboxText} characters.`, { field: 'text' });
      const session = idText(sessionId, 'sessionId');
      if (!isObject(meta)) throw fail('FIELD_INVALID', 'meta is an object.', { field: 'meta' });
      const body = jsonText(meta, 'meta', COORDINATION_LIMITS.journalDataBytes);
      const key = idText(id, 'id') || String(newId());
      const bound = maxQueued === null || maxQueued === undefined ? null : Math.floor(Number(maxQueued));
      if (bound !== null && (!Number.isFinite(bound) || bound < 1)) throw fail('FIELD_INVALID', 'maxQueued is a whole number from 1.', { field: 'maxQueued' });
      return transaction(() => {
        if (selectOutboxById.get(key)) return { id: key, duplicate: true };
        const queued = bound === null ? 0 : Number(countUnsent.get(run)?.n) || 0;
        if (bound !== null && queued >= bound) {
          throw fail('OUTBOX_FULL', `Run ${run} already has ${queued} follow-up${queued === 1 ? '' : 's'} waiting (at most ${bound}): wait until it took some, or send one message that says it all.`, { status: 409, runId: run, queued, limit: bound });
        }
        insertOutbox.run(key, run, text, session, body, now());
        return { id: key, duplicate: false };
      });
    },
    /** How many of a run's items are still unsent. */
    count(runId) {
      open();
      return Number(countUnsent.get(idText(runId, 'runId', { required: true }))?.n) || 0;
    },
    /**
     * Take unsent items out of the queue for good: the run ended, or was stopped, before it could take them. Sent
     * items are left alone. `ids` narrows it to those of the run's items.
     * @param {{ runId: string, ids?: string[] }} query
     * @returns {{ cancelled: object[] }} the items that were removed, in the order they were queued
     */
    cancel({ runId, ids = null } = {}) {
      const run = idText(runId, 'runId', { required: true });
      const only = ids === null || ids === undefined ? null : new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id)));
      return transaction(() => {
        const rows = selectAllUnsent.all(run).filter((row) => !only || only.has(row.id));
        for (const row of rows) deleteUnsent.run(row.id);
        return { cancelled: rows.map(outboxView) };
      });
    },
    /**
     * What is queued for a run and not sent yet, in the order it was queued. Taking marks nothing as sent: an item
     * comes back from every take until `markSent` names it (a crash between the two sends it again, never loses it).
     * @param {string} runId
     * @param {{ limit?: number }} [options]
     */
    take(runId, { limit = null } = {}) {
      const run = idText(runId, 'runId', { required: true });
      return transaction(() => {
        const rows = selectUnsent.all(run, limitOf(limit));
        for (const row of rows) { countAttempt.run(row.id); row.attempts = (Number(row.attempts) || 0) + 1; }
        return rows.map(outboxView);
      });
    },
    /** These items reached their run. @returns {{ sent: number }} */
    markSent(ids) {
      const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id !== null && id !== undefined).map((id) => String(id));
      return transaction(() => {
        const at = now();
        let sent = 0;
        for (const id of new Set(list)) sent += Number(markSent.run(at, id).changes) || 0;
        return { sent };
      });
    },
    /** One item by its id, or null. */
    get(id) {
      open();
      const row = selectOutboxById.get(String(id));
      return row ? outboxView(row) : null;
    },
    /** The runs that have something queued (after a restart: who still has to be told something). */
    runs() {
      open();
      return db.prepare('SELECT run_id FROM outbox WHERE sent_at IS NULL GROUP BY run_id ORDER BY MIN(n) ASC').all().map((row) => row.run_id);
    },
  });

  // ── housekeeping ───────────────────────────────────────────────────────────
  /**
   * Drop what is settled and old: events older than `olderThanMs` whose every delivery is acknowledged (their
   * deliveries go with them), claims given back that long ago, outbox items sent that long ago. An event somebody
   * has not acknowledged is kept however old it is; the journal is never pruned.
   * @returns {{ events: number, claims: number, outbox: number }}
   */
  function prune({ olderThanMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
    const age = Number(olderThanMs);
    if (!Number.isFinite(age) || age < 0) throw fail('FIELD_INVALID', 'olderThanMs must be a number of milliseconds.', { field: 'olderThanMs' });
    return transaction(() => {
      const before = now() - age;
      return {
        events: Number(db.prepare('DELETE FROM events WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = events.id AND d.acked_at IS NULL)').run(before).changes) || 0,
        claims: Number(db.prepare('DELETE FROM claims WHERE released_at IS NOT NULL AND released_at < ?').run(before).changes) || 0,
        outbox: Number(db.prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?').run(before).changes) || 0,
      };
    });
  }

  /** Counts for a diagnostics view. */
  function stats() {
    open();
    const count = (sql) => Number(db.prepare(sql).get()?.n) || 0;
    return {
      schemaVersion,
      events: count('SELECT COUNT(*) AS n FROM events'),
      lastSeq: lastSeq(),
      openDeliveries: count('SELECT COUNT(*) AS n FROM deliveries WHERE acked_at IS NULL'),
      activeClaims: count('SELECT COUNT(*) AS n FROM claims WHERE released_at IS NULL'),
      queuedFollowUps: count('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL'),
      journalEntries: count('SELECT COUNT(*) AS n FROM team_tasks'),
      subscribers: subscribers.size,
      waiters: waiters.size,
    };
  }

  /** The schema versions applied to this file, oldest first. */
  function appliedMigrations() {
    open();
    return db.prepare('SELECT version, name, applied_at FROM migrations ORDER BY version ASC').all().map((row) => ({ version: Number(row.version), name: row.name, appliedAt: iso(row.applied_at) }));
  }

  /**
   * Stop: everyone waiting is answered (`closed: true`), listeners are dropped and the file is closed. What was not
   * acknowledged stays in the file and is handed out again by the next store opened on it. Safe to call twice.
   */
  function close() {
    if (closed) return;
    closed = true;
    for (const waiter of [...waiters]) waiter.finish({ events: [], timedOut: false, closed: true, aborted: false });
    subscribers.clear();
    notices.length = 0;
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* another connection reads it: the WAL stays, nothing is lost */ }
    try { db.close(); } catch (error) { try { log('coordination:close-error', error?.message || String(error)); } catch { /* nothing to tell */ } }
  }

  return Object.freeze({
    path,
    schemaVersion,
    append, appendMany, get, events, lastSeq,
    read, pending, ack, ackThrough, cursor, coalesce, openCount, recipients,
    subscribe, waitFor,
    claim, release, claimsFor,
    journal, outbox,
    prune, stats, appliedMigrations, close,
    get closed() { return closed; },
  });
}
