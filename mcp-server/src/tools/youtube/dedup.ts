/**
 * YouTube trailer dedup — shared key logic.
 *
 * Every uploaded trailer is recorded as a SynaBun memory in the `youtube-videos`
 * category, tagged with canonical, exact-match keys. youtube_source reads those
 * keys (via sqlite.getPostedTrailerKeys) and drops any candidate that matches —
 * so the model never even sees an already-posted trailer. This replaces the old
 * fuzzy `recall` dedup, which returned only the top-K most-similar memories and
 * let repeats slip through as the posted set grew.
 *
 * Key scheme (a candidate/upload is the same trailer if ANY key matches):
 *   igdb:<igdbId>     exact IGDB game id            (IGDB/auto candidates)
 *   appid:<appid>     exact Steam appid             (IGDB/auto/steam candidates)
 *   ytid:<videoId>    exact source trailer video id (case-sensitive)
 *   name:<normalized> game name, lowercased+stripped (cross-backend safety net —
 *                     YouTube-search candidates carry no igdb/appid, so the name
 *                     key is what catches a game already posted via IGDB, etc.)
 */

/** The dedup ledger category — one memory per uploaded trailer. */
export const TRAILER_CATEGORY = 'youtube-videos';

/** Lowercase + strip every non-alphanumeric char. "Hollow Knight: Silksong" → "hollowknightsilksong". */
export function normalizeGameName(name?: string | null): string {
  if (!name) return '';
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
}

type TrailerIdentity = {
  game?: string | null;
  igdbId?: number | null;
  appid?: number | null;
  ytTrailerIds?: Array<string | null | undefined>;
  sourceTrailerId?: string | null;
};

/** Canonical dedup keys for a youtube_source candidate. */
export function candidateDedupKeys(c: TrailerIdentity): string[] {
  const keys: string[] = [];
  if (c.igdbId != null) keys.push(`igdb:${c.igdbId}`);
  if (c.appid != null) keys.push(`appid:${c.appid}`);
  for (const y of c.ytTrailerIds || []) if (y) keys.push(`ytid:${y}`);
  const n = normalizeGameName(c.game);
  if (n.length >= 3) keys.push(`name:${n}`);
  return keys;
}

/** Tags written to the ledger memory on upload (dedup keys + human-readable labels). */
export function ledgerTags(id: TrailerIdentity): string[] {
  const tags = ['yt-posted', 'youtube', 'trailer'];
  if (id.igdbId != null) tags.push(`igdb:${id.igdbId}`);
  if (id.appid != null) tags.push(`appid:${id.appid}`);
  if (id.sourceTrailerId) tags.push(`ytid:${id.sourceTrailerId}`);
  const n = normalizeGameName(id.game);
  if (n.length >= 3) tags.push(`name:${n}`);
  return tags;
}
