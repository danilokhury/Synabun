// One long-lived worker owns the coordination DB. Requests (including reads) enter
// its MessagePort FIFO in submission order. Replies and notices follow SQLite commit.
import { Worker } from 'node:worker_threads';
import { markActivity } from '../loop-stall.js';
import { matchesOwnedPath } from '../teams/schema.js';
import { COORDINATION_LIMITS, CoordinationError, MIGRATIONS } from './contract.js';
export * from './contract.js';

const workerURL = new URL('./storage-worker.js', import.meta.url);
const unavailable = (code, message) => new CoordinationError(code, message, { status: 503 });
const methods = (names, call) => Object.fromEntries(names.split(' ').map(name => [name, (...args) => call(name, args)]));

export function createCoordinationStore({
  path, now = Date.now, newId, busyTimeoutMs = 5000, shutdownTimeoutMs = 8000,
  synchronous = 'FULL', log = () => {}, allowDegraded = false, limits, migrations = MIGRATIONS,
  createWorker = (url, options) => new Worker(url, options),
} = {}) {
  if (!path || typeof path !== 'string') throw new CoordinationError('PATH_REQUIRED', 'createCoordinationStore needs its database path.');
  if (migrations !== MIGRATIONS) throw new CoordinationError('MIGRATIONS_INVALID', 'Custom migration functions must run in the storage worker. Add the version to MIGRATIONS.');
  const pending = new Map(), subscribers = new Set();
  const mailboxes = new Map(), outboxes = new Map(), claims = new Map();
  let worker, generationReady, closePromise, openError, barrier, degraded = null, schemaVersion;
  let initialized = false, online = false, closed = false, id = 0, referenced = 0;
  const lockBudget = Number.isFinite(busyTimeoutMs) ? Math.max(0, busyTimeoutMs) : 5000;
  function releaseRef(op) {
    if (op !== 'waitFor' && --referenced === 0) worker.unref();
  }
  function report(tag, detail) { try { log(tag, detail); } catch { /* best effort */ } }
  function count(map, key, n) { if (n) map.set(key, n); else map.delete(key); }

  function receive(message) {
    if (message.log) return report(message.log.tag, message.log.detail);
    if (message.notice) {
      const { event, recipients } = message.notice;
      for (const r of recipients) if (r.startsWith('session:')) count(mailboxes, r, (mailboxes.get(r) || 0) + 1);
      for (const sub of [...subscribers]) {
        if (!subscribers.has(sub)) continue;
        try {
          const f = sub.filter;
          const info = { recipients: [...recipients] };
          const match = !f || (typeof f === 'function' ? f(event, info) :
            (!f.recipient || recipients.includes(f.recipient)) &&
            ['kinds', 'priority', 'teamId', 'sessionId', 'runId'].every(k => f[k] == null || [f[k]].flat().includes(event[k === 'kinds' ? 'kind' : k])));
          if (match) sub.fn(event, info);
        } catch (error) { report('coordination:subscriber-error', error.message); }
      }
      return;
    }
    if (message.update) {
      const u = message.update;
      if (u.mailbox) count(mailboxes, ...u.mailbox);
      if (u.claims) { const [team, rows] = u.claims; if (rows.length) claims.set(team, rows); else claims.delete(team); }
      for (const [key, n] of u.outboxes || []) count(outboxes, key, n);
      return;
    }
    const req = pending.get(message.id);
    if (!req) return;
    pending.delete(message.id);
    releaseRef(req.op);
    if (message.error) {
      const error = new CoordinationError(message.error.code, message.error.message, message.error);
      if (req.op === 'open') openError = error;
      req.reject(error);
    } else {
      if (req.op === 'open') {
        const data = message.value;
        initialized = online = true;
        degraded = data.degraded;
        schemaVersion = data.schemaVersion;
        for (const row of data.mailboxes) count(mailboxes, row.recipient, row.open);
        for (const [key, n] of data.outboxes) count(outboxes, key, n);
        for (const [key, rows] of data.claims) claims.set(key, rows);
      }
      req.resolve(req.op === 'open' ? undefined : message.value);
    }
  }
  function post(op, args, requestId = ++id) {
    return new Promise((resolve, reject) => {
      if (op !== 'waitFor' && referenced++ === 0) worker.ref();
      pending.set(requestId, { op, resolve, reject });
      try { worker.postMessage({ id: requestId, op, args, deadline: performance.now() + lockBudget, at: now === Date.now ? undefined : now() }); }
      catch (error) {
        pending.delete(requestId);
        releaseRef(op);
        reject(error.name === 'DataCloneError'
          ? new CoordinationError('PAYLOAD_INVALID', `Coordination ${op} requires serializable input: ${error.message}`)
          : error);
      }
    });
  }
  function start() {
    const instance = createWorker(workerURL, { workerData: {
      coordinationStorage: true, path: degraded ? ':memory:' : path, synchronous, limits, allowDegraded: allowDegraded && !initialized,
      busyTimeoutMs: lockBudget,
    }, execArgv: process.execArgv.filter(arg => arg === '--experimental-sqlite') });
    worker = instance;
    instance.on('message', receive);
    let cause;
    instance.once('error', err => { cause = err; });
    instance.once('exit', code => {
      if (worker !== instance) return;
      const reopen = online;
      worker = null;
      referenced = 0;
      online = false;
      const error = unavailable('WORKER_EXIT', `Coordination worker exited (${cause?.message || code}); outstanding commits are unconfirmed. Check durable IDs before retrying.`);
      for (const req of pending.values()) req.reject(error);
      pending.clear();
      claims.clear(); mailboxes.clear(); outboxes.clear();
      if (!closed) {
        report('coordination:worker-exit', error.message);
        // A disk connection can be reopened. A lost in-memory store cannot be recovered.
        if (initialized && (path === ':memory:' || degraded)) openError = error;
        else if (reopen) {
          try { start(); } catch (err) { report('coordination:worker-start-error', err.message); }
        }
      }
    });
    generationReady = post('open', []);
    generationReady.catch(() => {}); // callers also observe this through ready and every operation
  }
  start();
  function ensureWorker() {
    if (!worker) start();
    else if (openError?.code === 'SQLITE_BUSY') {
      openError = null;
      generationReady = post('open', []);
      generationReady.catch(() => {});
    }
  }
  function ordered(submit) {
    if (closed) return Promise.reject(unavailable('CLOSED', 'The coordination store is closed.'));
    if (openError && openError.code !== 'SQLITE_BUSY') return Promise.reject(openError);
    ensureWorker();
    const instance = worker;
    const call = (op, args) => {
      if (worker !== instance) return Promise.reject(unavailable('WORKER_EXIT', 'Coordination worker exited before submission.'));
      markActivity(`coordination:${op}`);
      return post(op, args);
    };
    return barrier ? barrier.then(() => submit(call)) : submit(call);
  }
  function request(op, args = []) {
    // postMessage normally snapshots input immediately. A reserved discard
    // delays posting, so take the same snapshot at submission in that case.
    if (barrier) {
      try { args = structuredClone(args); }
      catch (error) { return Promise.reject(new CoordinationError('PAYLOAD_INVALID', error.message)); }
    }
    return ordered(call => call(op, args));
  }

  // A mailbox predicate can depend on live dispatcher state. Reserve its FIFO
  // position across the reads and acknowledgement, including during close.
  function discard(recipient, match) {
    const work = ordered(async call => {
      let afterSeq = 0;
      const ids = [];
      for (;;) {
        const page = await call('read', [{ recipient, afterSeq, limit: COORDINATION_LIMITS.readLimit, peek: true }]);
        for (const event of page) if (match(event)) ids.push(event.id);
        if (page.length < COORDINATION_LIMITS.readLimit) break;
        afterSeq = page.at(-1).seq;
      }
      return ids.length ? (await call('ack', [recipient, ids])).acked : 0;
    });
    const settled = work.then(() => {}, () => {});
    barrier = settled;
    settled.then(() => { if (barrier === settled) barrier = null; });
    return work;
  }
  function subscribe(filter, fn) {
    if (closed) throw unavailable('CLOSED', 'The coordination store is closed.');
    if (typeof fn !== 'function') throw new CoordinationError('SUBSCRIBER_INVALID', 'subscribe needs a function to call.');
    if (filter?.kinds != null && ![filter.kinds].flat().every(k => /^[a-z][a-z0-9_.:-]{0,63}$/.test(k))) throw new CoordinationError('KIND_INVALID', 'Invalid event kind.');
    const sub = { filter, fn };
    subscribers.add(sub);
    return () => subscribers.delete(sub);
  }
  function waitFor({ signal, ...query } = {}) {
    const empty = { events: [], timedOut: false, closed, aborted: !closed && !!signal?.aborted };
    if (closed || signal?.aborted) return Promise.resolve(empty);
    const instance = worker;
    const requestId = ++id;
    return ordered(() => {
      if (instance && instance !== worker) throw unavailable('WORKER_EXIT', 'Coordination worker exited before wait.');
      if (signal?.aborted) return { ...empty, aborted: true };
      const owner = worker;
      const result = post('waitFor', [query], requestId);
      const abort = () => owner.postMessage({ abort: requestId });
      signal?.addEventListener('abort', abort, { once: true });
      return result.finally(() => signal?.removeEventListener('abort', abort));
    });
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    const instance = worker;
    let timer;
    const drained = Promise.resolve(barrier).then(() => {
      if (instance && instance !== worker) throw unavailable('WORKER_EXIT', 'Coordination worker exited during shutdown.');
      if (instance) return post('close', []);
    });
    closePromise = Promise.race([
      drained,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = unavailable('DRAIN_TIMEOUT', 'Coordination shutdown drain timed out; outstanding commits are unconfirmed.');
          instance?.off('message', receive);
          for (const req of pending.values()) req.reject(error);
          pending.clear();
          if (instance) {
            // An OS I/O call can outlive the deadline. Release callers now.
            worker = null;
            instance.unref();
            instance.terminate().catch(err => report('coordination:terminate-error', err.message));
          }
          reject(error);
        }, shutdownTimeoutMs);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      subscribers.clear();
      claims.clear(); mailboxes.clear(); outboxes.clear();
    });
    return closePromise;
  }
  const withId = input => newId && input && !input.id ? { ...input, id: newId() } : input;
  return Object.freeze({
    path, get ready() { return generationReady; }, get degraded() { return degraded; },
    get closed() { return closed; }, get schemaVersion() { return schemaVersion; },
    ...methods('get events lastSeq read pending ack ackThrough cursor coalesce openCount recipients claim release claimsFor prune appliedMigrations', request),
    append: event => request('append', [withId(event)]),
    appendMany: events => request('appendMany', [newId && Array.isArray(events) ? events.map(withId) : events]),
    journal: methods('write read state teams', (op, args) => request('journal.' + op, args)),
    outbox: methods('enqueue count cancel take markSent get runs', (op, args) => request('outbox.' + op, op === 'enqueue' ? [withId(args[0])] : args)),
    stats: async () => ({ ...await request('stats'), subscribers: subscribers.size }),
    // The guard and scheduling predicates run synchronously. These projections
    // reflect acknowledged worker changes and are rebuilt on connection open.
    holdsClaim: (team, slice, file) => claims.get(team)?.some(row => row.sliceId === slice && matchesOwnedPath(row.glob, file)) || false,
    mailboxCount: session => mailboxes.get('session:' + session) || 0,
    outboxCount: run => online ? outboxes.get(run) || 0 : Infinity,
    serviceRequest: (op, args) => request('service.' + op, args),
    subscribe, waitFor, discard, close,
  });
}
