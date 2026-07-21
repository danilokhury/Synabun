import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const CODEX_REQUEST_STATUSES = Object.freeze([
  'pending',
  'answered',
  'dismissed',
  'timed_out',
  'turn_canceled',
  'delivery_failed',
]);

const TERMINAL_STATUSES = new Set(CODEX_REQUEST_STATUSES.slice(1));
const STORE_VERSION = 1;

function cleanId(value) {
  return value == null ? '' : String(value);
}

export function codexRequestCorrelation(value = {}) {
  return {
    sessionId: cleanId(value.sessionId),
    threadId: cleanId(value.threadId),
    turnId: cleanId(value.turnId),
    requestId: cleanId(value.requestId),
    toolCallId: cleanId(value.toolCallId),
  };
}

export function codexRequestKey(value = {}) {
  const ids = codexRequestCorrelation(value);
  return [ids.sessionId, ids.threadId, ids.turnId, ids.requestId, ids.toolCallId]
    .map((part) => encodeURIComponent(part))
    .join('|');
}

export function correlationMismatch(expected, actual) {
  const left = codexRequestCorrelation(expected);
  const right = codexRequestCorrelation(actual);
  for (const field of Object.keys(left)) {
    if (left[field] && right[field] && left[field] !== right[field]) return field;
  }
  return '';
}

function emptyStore() {
  return { version: STORE_VERSION, requests: {} };
}

function normalizeStore(value) {
  return {
    version: STORE_VERSION,
    requests: value?.requests && typeof value.requests === 'object' ? value.requests : {},
  };
}

export class CodexRequestJournal {
  constructor(filePath, { now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.store = this.load();
  }

  load() {
    try {
      if (!existsSync(this.filePath)) return emptyStore();
      return normalizeStore(JSON.parse(readFileSync(this.filePath, 'utf-8')));
    } catch {
      return emptyStore();
    }
  }

  save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.store, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, this.filePath);
  }

  register(correlation, details = {}) {
    const ids = codexRequestCorrelation(correlation);
    const key = codexRequestKey(ids);
    const existing = this.store.requests[key];
    if (existing) return existing;
    const createdAt = this.now();
    const entry = {
      key,
      ...ids,
      method: details.method || '',
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
      answerPersistedAt: null,
      deliveredAt: null,
      continuationObservedAt: null,
      deliveryAttempts: 0,
      responseToken: '',
      result: null,
      error: null,
    };
    this.store.requests[key] = entry;
    this.save();
    return entry;
  }

  get(correlation) {
    return this.store.requests[codexRequestKey(correlation)] || null;
  }

  findByRequestId({ sessionId = '', requestId = '' } = {}) {
    const matches = Object.values(this.store.requests).filter((entry) => (
      cleanId(entry.requestId) === cleanId(requestId)
      && (!sessionId || cleanId(entry.sessionId) === cleanId(sessionId))
    ));
    return matches.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }

  persistAnswer(correlation, { responseToken = '', result = null, error = null } = {}) {
    const entry = this.get(correlation);
    if (!entry) return { ok: false, reason: 'not_found', entry: null };
    const mismatch = correlationMismatch(entry, correlation);
    if (mismatch) return { ok: false, reason: `mismatched_${mismatch}`, entry };
    if (entry.status === 'answered' || entry.status === 'delivery_failed') {
      return { ok: true, duplicate: true, entry };
    }
    if (TERMINAL_STATUSES.has(entry.status)) {
      return { ok: false, reason: entry.status, entry };
    }
    const timestamp = this.now();
    Object.assign(entry, {
      status: 'answered',
      updatedAt: timestamp,
      answerPersistedAt: timestamp,
      responseToken: cleanId(responseToken),
      result,
      error,
    });
    this.save();
    return { ok: true, duplicate: false, entry };
  }

  recordDelivery(correlation, { ok, error = '' } = {}) {
    const entry = this.get(correlation);
    if (!entry) return null;
    const timestamp = this.now();
    entry.deliveryAttempts = Number(entry.deliveryAttempts || 0) + 1;
    entry.updatedAt = timestamp;
    if (ok) {
      entry.status = 'answered';
      entry.deliveredAt ||= timestamp;
      // The payload is needed only for retry. Once app-server accepts it, keep
      // lifecycle metadata but do not retain potentially sensitive answers.
      entry.result = null;
      entry.error = null;
    } else {
      entry.status = 'delivery_failed';
      entry.error = error || 'Delivery failed';
    }
    this.save();
    return entry;
  }

  finish(correlation, status, error = '') {
    if (!TERMINAL_STATUSES.has(status)) throw new Error(`Unknown request terminal status: ${status}`);
    const entry = this.get(correlation);
    if (!entry) return null;
    if (entry.answerPersistedAt) return entry;
    const timestamp = this.now();
    entry.status = status;
    entry.updatedAt = timestamp;
    entry.error = error || null;
    this.save();
    return entry;
  }

  markContinuation(correlation) {
    const entry = this.get(correlation);
    if (!entry || !entry.deliveredAt || entry.continuationObservedAt) return false;
    entry.continuationObservedAt = this.now();
    entry.updatedAt = entry.continuationObservedAt;
    this.save();
    return true;
  }

  unresolved({ sessionId = '', threadId = '' } = {}) {
    return Object.values(this.store.requests).filter((entry) => (
      (!sessionId || entry.sessionId === cleanId(sessionId))
      && (!threadId || entry.threadId === cleanId(threadId))
      && (entry.status === 'pending' || entry.status === 'delivery_failed')
    ));
  }
}
