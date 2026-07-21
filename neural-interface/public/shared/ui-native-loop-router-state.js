export function isNewerRunDescriptor(next, current, terminalStatuses) {
  if (!current) return true;
  const nextTerminal = terminalStatuses.has(next.status);
  const currentTerminal = terminalStatuses.has(current.status);
  if (currentTerminal !== nextTerminal) return nextTerminal;
  const nextVersion = Number(next.version) || 0;
  const currentVersion = Number(current.version) || 0;
  if (nextVersion !== currentVersion) return nextVersion > currentVersion;
  const nextTime = new Date(next.updatedAt || next.startedAt || 0).getTime() || 0;
  const currentTime = new Date(current.updatedAt || current.startedAt || 0).getTime() || 0;
  if (nextTime !== currentTime) return nextTime > currentTime;
  return (Number(next.currentIteration) || 0) >= (Number(current.currentIteration) || 0);
}

export function hasActiveForeignClaim(run, windowId, claimTtlMs, now = Date.now) {
  if (!run?.claimedBy || run.claimedBy === windowId) return false;
  const claimedAt = new Date(run.claimedAt || 0).getTime();
  const claimAge = claimedAt ? now() - claimedAt : Infinity;
  return claimAge <= claimTtlMs;
}

/**
 * Resolve the descriptor to attach after acquiring (or reusing) a claim.
 *
 * The claim endpoint broadcasts before its HTTP response is delivered. That
 * broadcast may replace latestEntry while claim() is in flight; a compatible
 * self-claim is therefore fresh state, not a reason to release the claim.
 */
export async function resolveRouteClaim({
  entry,
  alreadyOwned,
  claim,
  getLatestEntry,
  windowId,
  claimTtlMs,
  terminalStatuses,
  now = Date.now,
}) {
  let claimedRun = entry?.run || null;
  if (!alreadyOwned) {
    claimedRun = await claim(claimedRun);
    if (!claimedRun) return { ok: false, release: false, reason: 'claim_failed' };
  }

  const latestEntry = getLatestEntry();
  if (!latestEntry?.run) {
    return { ok: false, release: !alreadyOwned, reason: 'route_removed' };
  }
  if (hasActiveForeignClaim(latestEntry.run, windowId, claimTtlMs, now)) {
    return { ok: false, release: false, reason: 'foreign_claim' };
  }

  const run = isNewerRunDescriptor(latestEntry.run, claimedRun, terminalStatuses)
    ? latestEntry.run
    : claimedRun;
  return {
    ok: true,
    run,
    focus: latestEntry.focus ?? entry?.focus,
  };
}

export class LocalReleaseTracker {
  constructor({ ttlMs = 5_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  mark(runId) {
    this.prune();
    const token = {};
    this.entries.set(runId, { token, at: this.now() });
    return token;
  }

  consume(runId) {
    const entry = this.entries.get(runId);
    if (!entry) return false;
    this.entries.delete(runId);
    return this.now() - entry.at <= this.ttlMs;
  }

  clear(runId, token) {
    if (this.entries.get(runId)?.token === token) this.entries.delete(runId);
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [runId, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(runId);
    }
  }
}
