// This port has one synchronous consumer. A busy writer holds its place while later
// requests remain in the port FIFO. A long poll registers here, then releases the port.
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { openCoordinationDatabase } from './database.js';
import { coordinationOperations } from './operations.js';
import { CoordinationError } from './contract.js';

const { path, synchronous, busyTimeoutMs, allowDegraded, limits } = workerData || {};
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const waits = new Map();
let db, service, timestamp, openError, requestDeadline;
const clock = () => timestamp ?? Date.now();
function retry(fn) {
  const deadline = requestDeadline ?? performance.now() + busyTimeoutMs;
  let delay = 5;
  for (;;) {
    try { return fn(); } catch (error) {
      if (((error.errcode ?? error.cause?.errcode) & 255) !== 5) throw error;
      const left = deadline - performance.now();
      if (left <= 0) throw new CoordinationError('SQLITE_BUSY', `Coordination database remained locked for ${busyTimeoutMs} ms.`, { status: 503 });
      Atomics.wait(sleeper, 0, 0, Math.min(delay, left));
      delay = Math.min(100, delay * 2);
    }
  }
}
const log = (tag, detail) => parentPort.postMessage({ log: { tag, detail } });
function open() {
  let degraded = null;
  const connect = file => openCoordinationDatabase({ path: file, busyTimeoutMs: 0, synchronous, now: clock, retry, log });
  try { db = retry(() => connect(path)); } catch (error) {
    if (!allowDegraded || error.code === 'SQLITE_BUSY') throw error;
    degraded = { path, code: error.code || 'OPEN_FAILED', message: error.message };
    db = connect(':memory:');
    log('coordination:degraded', `Could not open ${path} (${error.message}); keeping events in memory until restart`);
  }
  openError = null;
  service = coordinationOperations(db, { now: clock, limits });
  db.subscribe(null, (event, { recipients }) => parentPort.postMessage({ notice: { event, recipients } }));
  return {
    degraded, schemaVersion: db.schemaVersion,
    mailboxes: db.recipients({ prefix: 'session:' }),
    outboxes: db.outbox.runs().map(id => [id, db.outbox.count(id)]),
    claims: db.activeClaimTeams().map(teamId => [teamId, db.claimsFor({ teamId })]),
  };
}
function execute(op, args, id) {
  if (op === 'open') return open();
  if (op === 'close') { db?.close(); return; }
  if (openError) throw openError;
  if (op === 'waitFor') {
    const controller = new AbortController();
    waits.set(id, controller);
    return db.waitFor({ ...args[0], signal: controller.signal }).finally(() => waits.delete(id));
  }
  const segments = op.split('.');
  const method = segments.pop();
  let target = db;
  if (segments[0] === 'service') {
    segments.shift();
    const [options, params] = args;
    target = options ? coordinationOperations(db, { now: clock, limits: options }) : service;
    args = params;
  }
  for (const name of segments) target = target[name];
  let sentRuns;
  if (op === 'outbox.markSent' || op === 'service.followUps.markSent') {
    sentRuns = [...new Set([args[0]].flat().map(key => db.outbox.get(key)?.runId).filter(Boolean))];
  }
  // Operations containing several transactions must never be replayed as a unit.
  // Writes retry at their transaction boundary. Pure queries can retry as a unit.
  const result = target[method](...args);
  let recipient;
  if (['ack', 'ackThrough', 'coalesce', 'pending'].includes(op)) recipient = args[0];
  if (['service.mailbox.pending', 'service.mailbox.ack'].includes(op)) recipient = 'session:' + args[0];
  const update = {};
  if (recipient?.startsWith('session:')) update.mailbox = [recipient, db.openCount(recipient)];
  if (op === 'claim' || op === 'release' || (op === 'journal.write' && args[0].claimGlobs)) {
    update.claims = [args[0].teamId, db.claimsFor({ teamId: args[0].teamId })];
  }
  if (['outbox.enqueue', 'outbox.cancel', 'service.followUps.enqueue'].includes(op)) sentRuns = [args[0].runId];
  if (op === 'service.followUps.cancel') sentRuns = [args[0]];
  if (sentRuns?.length) update.outboxes = sentRuns.map(key => [key, db.outbox.count(key)]);
  if (Object.keys(update).length) parentPort.postMessage({ update });
  return result;
}
if (workerData?.coordinationStorage) parentPort.on('message', ({ id, op, args, at, deadline, abort }) => {
  if (abort) { waits.get(abort)?.abort(); return; }
  timestamp = at;
  requestDeadline = deadline;
  const failed = error => parentPort.postMessage({ id, error: { ...error, name: error.name, message: error.message, code: error.code || 'STORAGE_ERROR' } });
  try {
    const result = execute(op, args, id);
    if (op === 'close') {
      // Closing the DB settles long polls. Flush their promise replies first.
      setImmediate(() => { parentPort.postMessage({ id }); parentPort.close(); });
    } else if (result instanceof Promise) result.then(value => parentPort.postMessage({ id, value }), failed);
    else parentPort.postMessage({ id, value: result });
  } catch (error) { if (op === 'open') { db?.close(); db = null; openError = error; } failed(error); }
  finally { requestDeadline = undefined; }
});
