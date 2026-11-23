import { join } from 'node:path';

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
  ROUTE_EXPIRED: 'route.expired',               // a route card closed without an answer (cards have no deadline)
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
