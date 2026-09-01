import { resolve } from 'node:path';

const ACTIVE_WRITER_PATTERN = /already has an active writer/i;

export function codexWriterKey(codexHome, threadId) {
  if (!codexHome || !threadId) return '';
  return `${resolve(String(codexHome))}\u0000${String(threadId)}`;
}

export function isCodexActiveWriterConflict(error) {
  if (!error) return false;
  const parts = [
    typeof error === 'string' ? error : error.message,
    typeof error === 'object' && error.data != null
      ? (typeof error.data === 'string' ? error.data : JSON.stringify(error.data))
      : '',
  ];
  return ACTIVE_WRITER_PATTERN.test(parts.filter(Boolean).join(' '));
}

export function codexWriterHasActiveWork({
  activeTurnId = null,
  pendingServerRequestCount = 0,
  pendingRpcRequestCount = 0,
  operationsInFlight = 0,
} = {}) {
  return !!activeTurnId
    || Number(pendingServerRequestCount || 0) > 0
    || Number(pendingRpcRequestCount || 0) > 0
    || Number(operationsInFlight || 0) > 0;
}

export function shouldReleaseCodexWriter({
  requested = false,
  activeTurnId = null,
  pendingServerRequestCount = 0,
  pendingRpcRequestCount = 0,
  operationsInFlight = 0,
} = {}) {
  return !!requested && !codexWriterHasActiveWork({
    activeTurnId,
    pendingServerRequestCount,
    pendingRpcRequestCount,
    operationsInFlight,
  });
}

export function codexOrphanCollisionAction({
  hasPrevious = false,
  previousIdle = false,
  currentIdle = false,
} = {}) {
  if (!hasPrevious) return 'register-current';
  if (previousIdle) return 'replace-idle-previous';
  if (currentIdle) return 'retire-idle-current';
  return 'retain-both';
}

export function retireCodexChildProcess(proc, { forceAfterMs = 2000 } = {}) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) {
    return Promise.resolve({ exited: true, forced: false });
  }

  return new Promise((resolveRetirement) => {
    let settled = false;
    let forceTimer = null;
    let forced = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      proc.off?.('close', onClose);
      resolveRetirement({ exited: true, forced });
    };
    const onClose = () => finish();
    proc.once('close', onClose);
    if (proc.exitCode != null || proc.signalCode != null) return finish();

    try { proc.kill('SIGTERM'); } catch {}
    forceTimer = setTimeout(() => {
      if (proc.exitCode != null || proc.signalCode != null) return finish();
      forced = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, Math.max(0, Number(forceAfterMs) || 0));
    forceTimer.unref?.();
  });
}

export class CodexWriterRetirementRegistry {
  constructor() {
    this.entries = new Map();
    this.recentlySettled = new Map();
  }

  register(codexHome, threadIds, retirement) {
    const keys = [...new Set((threadIds || [])
      .map((threadId) => codexWriterKey(codexHome, threadId))
      .filter(Boolean))];
    if (!keys.length) return Promise.resolve(retirement);

    const tracked = Promise.resolve(retirement).catch(() => {});
    for (const key of keys) {
      let pending = this.entries.get(key);
      if (!pending) {
        pending = new Set();
        this.entries.set(key, pending);
      }
      pending.add(tracked);
    }

    tracked.finally(() => {
      const settledAt = Date.now();
      for (const key of keys) {
        const pending = this.entries.get(key);
        pending?.delete(tracked);
        if (!pending?.size) this.entries.delete(key);
        this.recentlySettled.set(key, settledAt);
      }
    });
    return tracked;
  }

  has(codexHome, threadId) {
    return !!this.entries.get(codexWriterKey(codexHome, threadId))?.size;
  }

  settledRecently(codexHome, threadId, { withinMs = 2000 } = {}) {
    const key = codexWriterKey(codexHome, threadId);
    const settledAt = key ? this.recentlySettled.get(key) : null;
    if (!settledAt) return false;
    if (Date.now() - settledAt <= Math.max(0, Number(withinMs) || 0)) return true;
    this.recentlySettled.delete(key);
    return false;
  }

  async wait(codexHome, threadId, { timeoutMs = 5000 } = {}) {
    const key = codexWriterKey(codexHome, threadId);
    const pending = key ? [...(this.entries.get(key) || [])] : [];
    if (!pending.length) return { waited: false, timedOut: false };

    let timer = null;
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), Math.max(0, Number(timeoutMs) || 0));
    });
    const outcome = await Promise.race([
      Promise.allSettled(pending).then(() => 'settled'),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    return { waited: true, timedOut: outcome === 'timeout' };
  }
}
