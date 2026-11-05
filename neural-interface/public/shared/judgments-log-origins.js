// ═══════════════════════════════════════════
// SynaBun Neural Interface — the judgment log's origin filter
// ═══════════════════════════════════════════
// Which origins the log of Settings → AI decisions can be filtered by (ui-judgments.js draws the list). A server
// that knows coding-session attribution lists its own (`origins` in GET /api/typesafe/config); an older one sends
// none, and its log knows `live`, `backfill` and `bench` only. The list follows the latest answer both ways: the
// tab can open from a kept answer (settings/settings-data.js) and then hear from a server that lists none, and a
// filter it cannot apply must not stay offered.
// No DOM: runs under node --test as well.

/** What an older server's log can be filtered by: the list the tab offered before servers listed their own. */
export const LEGACY_LOG_ORIGINS = Object.freeze(['live', 'backfill', 'bench']);

/** The origins a config answer lists itself (non-empty strings, in its order); [] for a server that lists none. */
export function listedLogOrigins(cfg) {
  return Array.isArray(cfg?.origins) ? cfg.origins.filter((o) => typeof o === 'string' && o) : [];
}

/**
 * The origin filter for a config answer: `{ listed, values, key }`. `listed` is whether the server named them,
 * `values` the origins to offer (after "All origins"), `key` what the drawn list is compared by (the same values
 * drawn from the server's list and from the older one look different).
 */
export function logOriginFilter(cfg) {
  const own = listedLogOrigins(cfg);
  const listed = own.length > 0;
  const values = listed ? own : [...LEGACY_LOG_ORIGINS];
  return { listed, values, key: `${listed ? 'server' : 'legacy'}:${values.join('|')}` };
}
