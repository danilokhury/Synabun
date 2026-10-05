// One server operation owns each scroll/readiness/extract cycle. Nothing here
// retries a scroll after an uncertain browser failure.
export const EXTRACTION_TIMEOUT_MS = 15_000;

const identity = (item, keys) => {
  for (const key of keys) if (item[key] !== null && item[key] !== undefined && item[key] !== '') return `${key}:${item[key]}`;
  return JSON.stringify(item);
};

function extractionError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** Apply the output budget to complete items, after deduplication, preserving JSON. */
export function budgetExtractionItems(items, { fields, maxItems = 50, maxChars } = {}) {
  const selected = [];
  let chars = 2; // JSON array brackets
  let reason;
  for (const item of items) {
    if (selected.length >= maxItems) { reason = 'max_items'; break; }
    const value = fields ? Object.fromEntries(fields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])) : item;
    const size = JSON.stringify(value).length + (selected.length ? 1 : 0);
    if (maxChars !== undefined && chars + size > maxChars) { reason = 'max_chars'; break; }
    selected.push(value);
    chars += size;
  }
  return { items: selected, truncated: selected.length < items.length, budgetReason: reason };
}

/**
 * Expressions are the same trusted extraction scripts accepted by browser_evaluate.
 * runtime supports an HTTP disconnect signal and the request's absolute deadline.
 */
export async function runBrowserExtraction(page, script, opts = {}, runtime = {}) {
  if (typeof script !== 'string' || !script.trim()) throw new Error('script required');
  const scrolls = Math.min(Math.max(Math.trunc(opts.scrolls ?? 0), 0), 10);
  const maxItems = Math.max(1, Math.trunc(opts.maxItems || 50));
  const dedupeKeys = Array.isArray(opts.dedupeKeys) ? opts.dedupeKeys : [];
  const timeoutMs = Math.min(Math.max(opts.timeoutMs || EXTRACTION_TIMEOUT_MS, 1), 30_000);
  const deadline = Math.min(Date.now() + timeoutMs, runtime.deadline ?? Infinity);
  const signal = runtime.signal;
  const measure = runtime.measure || ((_name, fn) => fn());
  const collected = new Map();
  let raw = 0;
  let scrollsUsed = 0;
  let stopReason = 'scroll_limit';
  let failureReason;
  let dryRounds = 0;
  let bonusRounds = 0;

  function active() {
    if (signal?.aborted) throw extractionError('Extraction cancelled; collected items are preserved.', 'cancelled');
    if (Date.now() >= deadline) throw extractionError('Extraction deadline reached; collected items are preserved.', 'deadline');
  }
  async function bounded(name, fn) {
    active();
    let timer;
    let abort;
    try {
      return await Promise.race([
        measure(name, fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(extractionError('Extraction deadline reached; collected items are preserved.', 'deadline')), Math.max(1, deadline - Date.now()));
          abort = () => reject(extractionError('Extraction cancelled; collected items are preserved.', 'cancelled'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  function merge(items) {
    if (!Array.isArray(items)) throw new Error('Extractor must return an array of objects.');
    raw += items.length;
    const before = collected.size;
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Extractor must return an array of objects.');
      const key = identity(item, dedupeKeys);
      // Map replacement retains discovery order while refreshing counts/text
      // when a previously observed identity finishes hydration or changes.
      collected.set(key, item);
    }
    return collected.size - before;
  }

  try {
    let items = await bounded('extraction', () => page.evaluate(script));
    for (let round = 0; ; round++) {
      active();
      const added = merge(items);
      const budget = budgetExtractionItems([...collected.values()], opts);
      if (budget.budgetReason) { stopReason = budget.budgetReason; break; }
      if (collected.size >= maxItems) { stopReason = 'max_items'; break; }
      if (opts.minItems && collected.size >= opts.minItems) { stopReason = 'min_items'; break; }
      if (opts.scrollIfEmpty && round === 0 && collected.size === 0) bonusRounds = 1;
      dryRounds = added ? 0 : dryRounds + 1;
      if (dryRounds >= 2) { stopReason = 'end_of_feed'; break; }
      if (round >= scrolls + bonusRounds) break;

      const distance = (opts.scrollDistance ?? 1200) * (opts.scrollDirection ?? 1);
      const scrollTarget = opts.scrollTarget || 'window';
      const loadingBefore = await bounded('action', () => page.evaluate(({ scrollTarget, distance }) => {
        const target = (0, eval)(scrollTarget);
        if (!target || typeof target.scrollBy !== 'function') throw new Error('Scroll container not found.');
        const root = target === window ? document : target;
        const busy = '[aria-busy="true"], [role="progressbar"]';
        const loading = !!(root.matches?.(busy) || root.querySelector(busy));
        target.scrollBy(0, distance);
        return loading;
      }, { scrollTarget, distance }));
      scrollsUsed++;
      // Poll inside the renderer, not over HTTP. Reuse the first newly visible
      // extraction so virtualized items cannot disappear between wait and read.
      const waitMs = Math.min(opts.settleMs ?? 3000, Math.max(1, deadline - Date.now()));
      try {
        items = await bounded('readiness', async () => {
          const handle = await page.waitForFunction(state => {
            const { script, dedupeKeys, seen, scrollTarget } = state;
            const items = (0, eval)(script);
            if (!Array.isArray(items)) throw new Error('Extractor must return an array of objects.');
            const known = new Set(seen);
            const hasNew = items.some(item => {
              if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Extractor must return an array of objects.');
              let key;
              for (const field of dedupeKeys) {
                if (item[field] !== null && item[field] !== undefined && item[field] !== '') { key = `${field}:${item[field]}`; break; }
              }
              return !known.has(key ?? JSON.stringify(item));
            });
            const target = (0, eval)(scrollTarget);
            const root = target === window ? document : target;
            if (!root) throw new Error('Scroll container disappeared while waiting.');
            const busy = '[aria-busy="true"], [role="progressbar"]';
            const loading = !!(root.matches?.(busy) || root.querySelector(busy));
            // Playwright reuses this argument between predicate polls. Remember
            // loading that begins after scroll dispatch as well as before it.
            state.loadingBefore ||= loading;
            const loadingEnded = state.loadingBefore && !loading;
            return !loading && (hasNew || loadingEnded) ? { items } : false;
          }, { script, dedupeKeys, seen: [...collected.keys()], scrollTarget, loadingBefore }, { timeout: waitMs, polling: 50 });
          try { return (await handle.jsonValue()).items; } finally { await handle.dispose(); }
        });
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        // Read once at the readiness boundary, but never accept known loading
        // skeletons merely because the readiness timer elapsed.
        const finalRead = await bounded('extraction', () => page.evaluate(({ script, scrollTarget }) => {
          const target = (0, eval)(scrollTarget);
          const root = target === window ? document : target;
          if (!root) throw new Error('Scroll container disappeared while waiting.');
          const busy = '[aria-busy="true"], [role="progressbar"]';
          const loading = !!(root.matches?.(busy) || root.querySelector(busy));
          return { loading, items: loading ? [] : (0, eval)(script) };
        }, { script, scrollTarget }));
        if (finalRead.loading) throw extractionError('Feed is still loading after the readiness deadline; collected items are preserved.', 'readiness_timeout');
        items = finalRead.items;
      }
    }
  } catch (error) {
    stopReason = ['deadline', 'cancelled', 'readiness_timeout'].includes(error.code) ? error.code : 'extraction_error';
    failureReason = error.message;
  }

  const budget = budgetExtractionItems([...collected.values()], opts);
  return {
    ...budget, raw, scrollsUsed, stopReason: budget.budgetReason || stopReason,
    partial: !!failureReason && collected.size > 0,
    ...(failureReason ? { failureReason, ...(collected.size === 0 ? { error: failureReason } : {}) } : {}),
  };
}

/** Scoped HTML reader: clone before cleaning, and retain link source URLs. */
export async function readBrowserContentHtml(page, selector) {
  const target = page.locator(selector || 'body');
  if (selector && await target.count() !== 1) throw new Error('Content selector must match exactly one element.');
  return target.evaluate((element, scoped) => {
    const clone = element.cloneNode(true);
    const noise = scoped
      ? 'script,style,noscript,iframe'
      : 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],.sidebar,.nav,.footer,.header,.advertisement,.ad,.ads,[class*="cookie"],[class*="popup"],[class*="modal"],[class*="overlay"],script,style,noscript,iframe';
    clone.querySelectorAll(noise).forEach(node => node.remove());
    clone.querySelectorAll('a[href],img[src]').forEach(node => {
      const attr = node.tagName === 'A' ? 'href' : 'src';
      try { node.setAttribute(attr, new URL(node.getAttribute(attr), document.baseURI).href); } catch { /* Keep unresolvable links verbatim. */ }
    });
    const main = scoped ? clone : (clone.querySelector('main') || clone.querySelector('article') || clone.querySelector('[role="main"]') || clone);
    return scoped ? main.outerHTML : main.innerHTML;
  }, !!selector);
}
