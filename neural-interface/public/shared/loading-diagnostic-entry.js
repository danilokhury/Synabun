// The complete wire format. Neither a health body, a translated subtitle, a URL,
// nor an exception/refusal message belongs in the trail or the server log.
export const DIAGNOSTIC_BATCH = 20;
const loadingTitles = [
  'loading.serverOffline', 'loading.connectionFailed', 'loading.health.databaseUnreachable.title',
  'loading.health.remoteUnreachable.title', 'loading.health.authError.title', 'loading.health.connectionError.title',
];

const bool = value => typeof value === 'boolean';
const count = value => Number.isInteger(value) && value >= 1 && value <= 20;
const oneOf = (...values) => value => values.includes(value);
const states = oneOf('idle', 'launching', 'starting', 'waiting', 'stalled', 'failed', 'online', 'restarting', 'refused');
const moduleName = oneOf('entry', 'app');
const bootTag = value => typeof value === 'string' && /^(?:[0-9a-f]{8})?$/.test(value);
const events = {
  'startup-shown': {},
  'startup-status': { reason: oneOf('offline', 'loading', 'manual-retry') },
  'boot-complete': {},
  // The first frame's overlay handed to the app's shell (taken over, or a shell's own overlay replaced it), and the
  // first frame's fallback ended by the app's boot.
  'startup-adopt': { mode: oneOf('adopted', 'duplicate') },
  'boot-cleanup': { adopted: bool, removed: bool, hidden: bool, aborted: bool },
  'overlay-dedupe': { removed: count },
  'overlay-error': { title: oneOf(...loadingTitles, 'other'), serverOffline: bool },
  'overlay-reveal': { reason: oneOf('init', 'show', 'restart', 'probe') },
  'overlay-conceal': { reason: oneOf('hide', 'recovered', 'dismissed') },
  'hide-skipped': { state: states },
  'bridge-created': { reason: oneOf('restart', 'offline'), state: states },
  'bridge-stopped': { state: states },
  'bridge-state': { state: states },
  'bridge-probe': { result: oneOf('healthy', 'stopping', 'unhealthy', 'unreachable'), seenBoot: bootTag },
  'restart-request': { asked: bool, announced: bool, restartShown: bool, hasBridge: bool },
  'restart-snapshot': { asked: bool, accepted: bool, down: bool, refused: bool },
  'recover': { seenBoot: bootTag, needsReload: bool, appWasVisible: bool, restartShown: bool, reloadPending: bool },
  'reload-scheduled': { reason: oneOf('startup', 'restart', 'boot-changed', 'unknown-boot') },
  'probe-miss': { reason: oneOf('unreachable', 'unhealthy', 'stopping', 'boot-changed'), confirmation: bool },
  // Probes went unanswered and the offline screen was held back (server-presence.js): the server is only slow, or
  // the tab is hidden and cannot tell. Then the answer that ended that row, with how long it lasted.
  'probe-held': { reason: oneOf('slow', 'hidden'), misses: count },
  'probe-answered': { misses: count, seconds: value => Number.isInteger(value) && value >= 0 && value <= 3600 },
  'import-failed': { module: moduleName },
  'import-retry': { module: moduleName },
};

function matches(object, fields) {
  return object !== null && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === Object.keys(fields).length
    && Object.entries(fields).every(([key, accepts]) => Object.hasOwn(object, key) && accepts(object[key]));
}

const envelope = {
  iso: s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
  pageId: s => typeof s === 'string' && /^[a-f0-9]{12}$/.test(s),
  currentBoot: bootTag,
  visibility: oneOf('visible', 'hidden', 'prerender'),
  event: s => typeof s === 'string' && Object.hasOwn(events, s),
  data: value => value !== null && typeof value === 'object',
};

export function validDiagnosticEntry(entry) {
  return matches(entry, envelope) && matches(entry.data, events[entry.event]);
}

