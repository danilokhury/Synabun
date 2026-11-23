// The dispatcher's mailbox, outbox and team channel share the same worker FIFO
// as direct store operations. Composite service operations execute in one turn there.
import { markActivity } from '../loop-stall.js';
import { createCoordinationStore, coordinationDbPath, sessionRecipient } from './store.js';
import { COORDINATION_SERVICE_LIMITS, dispatchEvent, itemOf, teamMemberRecipient } from './operations.js';
import { teamRecipient } from './contract.js';
export {
  COORDINATION_SERVICE_LIMITS, MAILBOX_ITEM_KINDS, MAILBOX_STOP_REASONS, RUN_EVENT_KINDS, RUN_EVENT_REASONS,
  RUN_WAIT_KINDS, SESSION_NOTICE_KIND, compactItem, eventBrief, runBrief, runEventId, teamMemberRecipient,
} from './operations.js';
export { CoordinationError, EVENT_KINDS, KIND_PRIORITY, coordinationDbPath, runRecipient, sessionRecipient, teamRecipient } from './contract.js';

export function createCoordinationService({ store: givenStore, path, dataDir, now = Date.now, log = () => {}, limits: overrides, autoPrune } = {}) {
  const limits = { ...COORDINATION_SERVICE_LIMITS, ...overrides };
  const store = givenStore || createCoordinationStore({
    path: path || (dataDir ? coordinationDbPath(dataDir) : ':memory:'), now, log, allowDegraded: true, limits,
  });
  const call = (op, ...args) => store.serviceRequest(op, [overrides, args]);
  const group = (name, methods) => Object.fromEntries(methods.split(' ').map(method => [method, (...args) => call(name + '.' + method, ...args)]));
  const mailbox = {
    ...group('mailbox', 'post pending count ack sessions'),
    cachedCount: store.mailboxCount,
    subscribe(fn) {
      return store.subscribe(null, (event, { recipients }) => {
        for (const r of recipients) if (r.startsWith('session:')) fn(r.slice(8), event);
      });
    },
    discard(sessionId, match) {
      return store.discard(sessionRecipient(sessionId), event => !match || match(itemOf(event)));
    },
  };
  const admissions = new Map();
  const followUps = {
    ...group('followUps', 'next markSent count cancel runs'),
    cachedCount(runId) { return store.outboxCount(runId) + (admissions.get(runId) || 0); },
    async enqueue(item) {
      const key = item?.runId;
      admissions.set(key, (admissions.get(key) || 0) + 1);
      try { return await call('followUps.enqueue', item); }
      finally {
        const remaining = admissions.get(key) - 1;
        if (remaining) admissions.set(key, remaining); else admissions.delete(key);
      }
    },
  };
  const team = {
    ...group('team', 'members post read ack log cursor'),
    recipient: teamMemberRecipient, leadRecipient: teamRecipient,
    wait({ teamId, runId, ...options }) {
      return store.waitFor({ ...options, recipient: runId ? teamMemberRecipient(teamId, runId) : teamRecipient(teamId) });
    },
  };
  function report(tag, error) { if (!store.closed) { try { log(tag, error.message); } catch { /* best effort */ } } }
  async function prune() {
    markActivity('timer:coordination-prune');
    try { return await store.prune({ olderThanMs: limits.pruneAfterMs }); }
    catch (error) { report('coordination:prune-error', error); return { events: 0, claims: 0, outbox: 0 }; }
  }
  const durable = () => store.path !== ':memory:' && !store.degraded;
  const timer = (autoPrune ?? durable()) ? setInterval(prune, limits.pruneEveryMs) : null;
  timer?.unref();
  return Object.freeze({
    store, limits, mailbox, team, followUps,
    get ready() { return store.ready; }, get degraded() { return store.degraded; },
    get durable() { return durable(); }, get closed() { return store.closed; },
    async recordDispatch(payload) {
      try {
        const event = dispatchEvent(payload, limits);
        if (!event || store.closed) return null;
        const result = await store.append(event);
        return { ...result, kind: event.kind, priority: event.priority, delivered: event.to.length > 0 };
      } catch (error) { report('coordination:record-error', error); return null; }
    },
    runEvents: (...args) => call('runEvents', ...args),
    lastSeq: () => store.closed ? Promise.resolve(0) : store.lastSeq(),
    prune, stats: async () => ({ ...await store.stats(), durable: durable(), degraded: store.degraded }),
    close() { clearInterval(timer); return store.close(); },
  });
}

// ── the server's one service ─────────────────────────────────────────────────
// server.js makes one service on DATA_HOME/data/coordination.db and shares it here; a dispatcher or a runtime that
// is given none takes it, so both read and write the same store without it being passed through every call. A test
// shares nothing: each dispatcher and runtime then keeps a store of its own in memory.
let shared = null;
/** Make `service` the one a dispatcher and a runtime use when they are given none. → the service. */
export function shareCoordinationService(service) {
  shared = service || null;
  return service;
}
/** The shared service while it is open, else null. */
export function sharedCoordinationService() {
  return shared && !shared.closed ? shared : null;
}
