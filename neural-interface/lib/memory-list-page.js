// One page of the page's memory list (`GET /api/memories?links=false&offset=…&limit=…`).
//
// The 3D page used to fetch every memory in one answer (about 32 MB for 24,000 memories) and parse it in one go. It
// now asks for pages (public/shared/memory-list.js): the first arrives in a fraction of the time, each parse is a
// short task, and the server reads only the rows of the page. Without `limit` the route answers as it always did
// (every memory, the same body and ETag): other callers and a page from before this change are unaffected.
//
// A page carries `page.version`, the ETag the whole list would have now: a client that sees two versions across its
// pages knows the list changed while it read them and starts again. Each page has an ETag of its own (the version
// plus the page's place), so a reload of an unchanged list is answered `304 Not Modified` page by page.

/** The largest page a request may ask for. */
export const MEMORY_PAGE_MAX = 10_000;

/**
 * The page a query asks for: null when it asks for no page (no `limit`), `{ error }` when the numbers are not
 * usable, else `{ offset, limit }` (limit at most MEMORY_PAGE_MAX).
 * @param {Record<string, unknown>} query
 */
export function parseMemoryPage(query = {}) {
  const rawLimit = query.limit;
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') return null;
  const asInt = (value) => (typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN);
  const limit = asInt(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return { error: 'limit must be a whole number of at least 1' };
  const rawOffset = query.offset;
  const offset = rawOffset === undefined || rawOffset === '' ? 0 : asInt(rawOffset);
  if (!Number.isInteger(offset) || offset < 0) return { error: 'offset must be a whole number of at least 0' };
  return { offset, limit: Math.min(limit, MEMORY_PAGE_MAX) };
}

/** The ETag part that tells one page from another of the same list. */
export function pageEtagPart({ offset, limit }) {
  return `page:${offset}:${limit}`;
}

/**
 * The page's description in the answer. `total` counts the stored memories; the bridge's nodes (if any) ride on the
 * last page, after them, as in the unpaged answer.
 */
export function describePage({ offset, limit, total, count, version }) {
  const end = offset + limit;
  return { offset, limit, count, total, next: end < total ? end : null, version: version ?? null };
}

/** Whether this page is the last one, the one that carries what follows the stored memories. */
export function isLastPage({ offset, limit, total }) {
  return offset + limit >= total;
}
