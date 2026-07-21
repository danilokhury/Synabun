const MAX_ID_LENGTH = 128;

/** Ownership data supplied only by an interactive "Run now" caller. */
export function createScheduleSidepanelIntent({ sidepanelWindowId, sidepanelClaimToken } = {}) {
  const windowId = String(sidepanelWindowId || '').trim().slice(0, MAX_ID_LENGTH);
  const claimToken = String(sidepanelClaimToken || '').trim().slice(0, MAX_ID_LENGTH);
  if (!windowId || !claimToken) return null;
  return { windowId, claimToken, focus: true };
}

/**
 * Persisted schedules are refreshed before launch. Re-apply only the explicitly
 * transient queue fields so ownership/focus survives queueing and mutex deferral
 * without leaking into loop-schedules*.json.
 */
export function mergeScheduleLaunchSnapshot(fresh, queued) {
  if (!fresh) return queued || null;
  if (!queued) return fresh;
  const merged = { ...fresh };
  for (const key of ['_forced', '_quickTimer', '_sidepanelLaunch']) {
    if (Object.prototype.hasOwnProperty.call(queued, key)) merged[key] = queued[key];
  }
  return merged;
}

export function resolveScheduleRunPresentation(schedule, isClaimRevoked = () => false) {
  const intent = schedule?._sidepanelLaunch || null;
  const manual = !!intent?.windowId
    && !!intent?.claimToken
    && !isClaimRevoked(intent.windowId, intent.claimToken);
  const quickTimer = schedule?._quickTimer === true;
  return {
    source: quickTimer
      ? (manual ? 'quick-timer-manual' : 'quick-timer')
      : (manual ? 'schedule-manual' : 'schedule'),
    focus: manual && intent.focus !== false,
    claimedBy: manual ? intent.windowId : null,
  };
}

