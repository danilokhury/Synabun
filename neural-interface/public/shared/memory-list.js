// SynaBun — the page's memory list, read in pages (server: lib/memory-list-page.js).
//
// The 3D page needs every memory (the sidebar's counts, the explorer, search, the cards, the map's tooltips) and
// used to read them in one answer: about 32 MB, parsed in one long task. It now reads pages of MEMORY_PAGE_SIZE
// memories, the first one fetched by index.html before any module loads, the others one or two at a time; each
// parse is a short task between frames. Nothing is shown from a part of the list: the caller gets the whole list,
// in the order the single answer had (newest first, the bridge's nodes last), the same nodes, and the same shape
// ({ nodes, links, totalVectors, openclawNodes }).
//
// Every page has an ETag of its own, so a reload of an unchanged list is answered 304 page by page (the browser's
// cache keeps each page by its URL; the URL of a page never changes while its place does not). A page carries the
// version of the list it was cut from: two versions in one read mean the list changed while it was read, and the
// read starts again (twice at most, then the list is read in one answer, as before). A server from before pages
// answers the first request with the whole list (no `page`): that is the list.
//
// No imports and no DOM: tests/memory-list.test.mjs runs it under node with a fake fetch.

/** Memories per page: about 2.7 MB of JSON, a 20–30 ms parse. */
export const MEMORY_PAGE_SIZE = 2500;
/** The whole list in one answer (the shape every reader already knows, and the last resort here). */
export const MEMORY_LIST_URL = '/api/memories?links=false&fields=graph';

/** The address of one page. index.html fetches memoryPageUrl(0) itself, before any module loads. */
export function memoryPageUrl(offset, limit = MEMORY_PAGE_SIZE) {
  return `${MEMORY_LIST_URL}&offset=${offset}&limit=${limit}`;
}

async function getJson(fetchFn, url) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The pages after the first, as offsets. */
export function remainingOffsets(page) {
  const out = [];
  if (!page || !Number.isInteger(page.limit) || page.limit < 1) return out;
  for (let offset = page.offset + page.limit; offset < page.total; offset += page.limit) out.push(offset);
  return out;
}

/**
 * Join pages read in order into the single answer's shape. Nodes are kept once (by id), in page order.
 * @param {Array<{ nodes: any[], totalVectors?: number, openclawNodes?: number, page?: any }>} pages
 */
export function joinPages(pages) {
  const seen = new Set();
  const nodes = [];
  for (const data of pages) {
    for (const node of data?.nodes || []) {
      const id = node?.id;
      if (id != null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      nodes.push(node);
    }
  }
  const last = pages[pages.length - 1] || {};
  const first = pages[0] || {};
  return {
    nodes,
    links: [],
    totalVectors: Number.isFinite(first.page?.total) ? first.page.total : (first.totalVectors ?? nodes.length),
    openclawNodes: last.openclawNodes ?? first.openclawNodes ?? 0,
  };
}

/**
 * Read the whole memory list in pages. Never throws: a failure comes back as `{ error }`, as the old prefetch did.
 * @param {{
 *   fetch?: typeof fetch,
 *   first?: Promise<any> | null,   the first page, already asked for (index.html); its answer or `{ error }`
 *   pageSize?: number,
 *   concurrency?: number,          pages in flight at once after the first
 *   attempts?: number,             reads of the pages before the one-answer fallback
 * }} [options]
 */
export async function loadMemoryList({
  fetch: fetchFn = globalThis.fetch?.bind(globalThis),
  first = null,
  pageSize = MEMORY_PAGE_SIZE,
  concurrency = 1,
  attempts = 2,
} = {}) {
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      let head = attempt === 0 && first ? await first : null;
      if (head?.error) throw head.error;
      if (!head) head = await getJson(fetchFn, memoryPageUrl(0, pageSize));
      // A server from before pages: the whole list, in one answer.
      if (!head?.page) return head;
      const offsets = remainingOffsets(head.page);
      const pages = new Array(offsets.length);
      let next = 0;
      let changed = false;
      const worker = async () => {
        while (!changed && next < offsets.length) {
          const index = next++;
          const data = await getJson(fetchFn, memoryPageUrl(offsets[index], head.page.limit));
          if (!data?.page || data.page.version !== head.page.version || data.page.total !== head.page.total) {
            changed = true;
            return;
          }
          pages[index] = data;
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, offsets.length)) }, worker));
      if (!changed) return joinPages([head, ...pages]);
      // The list changed while it was read: read it again from the first page.
    }
    // It kept changing: one answer, which is one moment of the list.
    return await getJson(fetchFn, MEMORY_LIST_URL);
  } catch (error) {
    return { error };
  }
}
