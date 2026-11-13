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

/**
 * Apply the output budget to complete items, after deduplication, preserving JSON.
 * `types` is read before the projection: the distinct `type` of the returned items (null for
 * an item without a string one), so a caller whose `fields` drop `type` still knows what it got
 * (browser_extract_tweets says "trend(s)" for an Explore tab's trends).
 */
export function budgetExtractionItems(items, { fields, maxItems = 50, maxChars } = {}) {
  const selected = [];
  const types = new Set();
  let chars = 2; // JSON array brackets
  let reason;
  for (const item of items) {
    if (selected.length >= maxItems) { reason = 'max_items'; break; }
    const value = fields ? Object.fromEntries(fields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])) : item;
    const size = JSON.stringify(value).length + (selected.length ? 1 : 0);
    if (maxChars !== undefined && chars + size > maxChars) { reason = 'max_chars'; break; }
    selected.push(value);
    types.add(typeof item.type === 'string' ? item.type : null);
    chars += size;
  }
  return { items: selected, types: [...types], truncated: selected.length < items.length, budgetReason: reason };
}

// ── Page functions ──
// Everything that runs in the page is a function with the extractor and the scroll
// target written into its source. Playwright evaluates a function's source once,
// inside the DevTools call, which Chromium exempts from the page's Content Security
// Policy; the readiness polls that follow run the compiled function on the page's
// own timer, where the page's CSP applies and nothing may call eval. Until
// 2026-11-06 the polls did `(0, eval)(script)` in the page, and x.com, whose
// `script-src` has no 'unsafe-eval', refused the second poll of every scrolled
// extraction with an EvalError ("the tweet extractor doesn't work on X").

const BUSY_SELECTOR = '[aria-busy="true"], [role="progressbar"]';

/** An extractor or a scroll target is one JavaScript expression (statements go in an IIFE). */
function expressionSource(source, what) {
  const text = typeof source === 'string' ? source.trim().replace(/;+\s*$/, '') : '';
  if (!text) throw new Error(`${what} required`);
  return text;
}

/**
 * Compile a page function from its source. The function is only ever serialized for
 * the page (Playwright sends its source and runs it there); nothing calls it here.
 * A script that is not an expression fails here, before anything touches the page.
 */
function pageFunction(parameter, body, what) {
  try {
    return new Function(parameter, body);
  } catch (error) {
    throw new Error(`${what} must be a JavaScript expression that returns an array of objects: ${error.message}`);
  }
}

/**
 * The four page functions of one extraction: the first read, the scroll (returns whether
 * the scroll root was already loading), the readiness predicate `page.waitForFunction`
 * polls, and the one read after a readiness timeout. None of them evaluates a string.
 * Their own locals are `__sb`-prefixed: the extractor and the scroll target were evaluated
 * in the page's global scope before, and an expression that names `items`, `root` or
 * `target` must still mean the page's, never a local of the function around it.
 */
export function extractionPageFunctions(script, scrollTarget = 'window') {
  const items = expressionSource(script, 'Extractor script');
  const target = expressionSource(scrollTarget, 'Scroll target');
  const observe = `
    const __sbTarget = (
${target}
    );
    const __sbRoot = __sbTarget === window ? document : __sbTarget;
    if (!__sbRoot) throw new Error('Scroll container disappeared while waiting.');
    const __sbBusy = ${JSON.stringify(BUSY_SELECTOR)};
    const __sbLoading = !!(__sbRoot.matches?.(__sbBusy) || __sbRoot.querySelector(__sbBusy));`;
  return {
    read: pageFunction('', `return (
${items}
);`, 'Extractor script'),
    scroll: pageFunction('__sbState', `
    const __sbTarget = (
${target}
    );
    if (!__sbTarget || typeof __sbTarget.scrollBy !== 'function') throw new Error('Scroll container not found.');
    const __sbRoot = __sbTarget === window ? document : __sbTarget;
    const __sbBusy = ${JSON.stringify(BUSY_SELECTOR)};
    const __sbLoading = !!(__sbRoot.matches?.(__sbBusy) || __sbRoot.querySelector(__sbBusy));
    __sbTarget.scrollBy(0, __sbState.distance);
    return __sbLoading;`, 'Scroll target'),
    readiness: pageFunction('__sbState', `
    const __sbItems = (
${items}
    );
    if (!Array.isArray(__sbItems)) throw new Error('Extractor must return an array of objects.');
    const __sbKnown = new Set(__sbState.seen);
    const __sbHasNew = __sbItems.some(__sbItem => {
      if (!__sbItem || typeof __sbItem !== 'object' || Array.isArray(__sbItem)) throw new Error('Extractor must return an array of objects.');
      let __sbKey;
      for (const __sbField of __sbState.dedupeKeys) {
        if (__sbItem[__sbField] !== null && __sbItem[__sbField] !== undefined && __sbItem[__sbField] !== '') { __sbKey = __sbField + ':' + __sbItem[__sbField]; break; }
      }
      return !__sbKnown.has(__sbKey ?? JSON.stringify(__sbItem));
    });${observe}
    // Playwright reuses this argument between predicate polls. Remember loading
    // that begins after scroll dispatch as well as before it.
    __sbState.loadingBefore ||= __sbLoading;
    const __sbLoadingEnded = __sbState.loadingBefore && !__sbLoading;
    return !__sbLoading && (__sbHasNew || __sbLoadingEnded) ? { items: __sbItems } : false;`, 'Extractor script'),
    finalRead: pageFunction('', `${observe}
    return { loading: __sbLoading, items: __sbLoading ? [] : (
${items}
    ) };`, 'Extractor script'),
  };
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
  // A script that is not an expression is refused here, before any page call.
  const fns = extractionPageFunctions(script, opts.scrollTarget || 'window');
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
    let items = await bounded('extraction', () => page.evaluate(fns.read));
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
      const loadingBefore = await bounded('action', () => page.evaluate(fns.scroll, { distance }));
      scrollsUsed++;
      // Poll inside the renderer, not over HTTP. Reuse the first newly visible
      // extraction so virtualized items cannot disappear between wait and read.
      const waitMs = Math.min(opts.settleMs ?? 3000, Math.max(1, deadline - Date.now()));
      try {
        items = await bounded('readiness', async () => {
          const handle = await page.waitForFunction(fns.readiness, { dedupeKeys, seen: [...collected.keys()], loadingBefore }, { timeout: waitMs, polling: 50 });
          try { return (await handle.jsonValue()).items; } finally { await handle.dispose(); }
        });
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        // Read once at the readiness boundary, but never accept known loading
        // skeletons merely because the readiness timer elapsed.
        const finalRead = await bounded('extraction', () => page.evaluate(fns.finalRead));
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
