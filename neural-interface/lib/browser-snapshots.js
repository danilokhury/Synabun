import { randomBytes } from 'node:crypto';

// Keep only whole snapshot lines: cutting through a ref makes it unusable.
export function truncateSnapshotLines(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const end = text.lastIndexOf('\n', maxChars);
  return { text: end < 0 ? '' : text.slice(0, end), truncated: true };
}

export function diffSnapshotText(previous, next) {
  if (previous === next) return { unchanged: true };
  const before = previous ? previous.split('\n') : [];
  const after = next ? next.split('\n') : [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const text = [...removed.map(line => `- ${line}`), ...added.map(line => `+ ${line}`)].join('\n');
  // A full view is cheaper when most of the observed region changed.
  if (text.length > next.length * 0.7) return { full: next };
  return { diff: text, prefixLines: prefix, suffixLines: suffix, removedLines: removed.length, addedLines: added.length };
}

export async function captureAiSnapshot(page, { scopeSel = null, depth } = {}) {
  const options = { mode: 'ai', timeout: 8000 };
  if (Number.isInteger(depth) && depth > 0) options.depth = depth;
  const text = await page.locator(scopeSel || 'body').ariaSnapshot(options);
  return text.replace(/ \[cursor=pointer\]/g, '');
}

/** Caller-scoped delivered observations. Weak page state detects same-URL reloads. */
export function createAiSnapshotStore({
  capture = captureAiSnapshot,
  enabled = () => process.env.SYNABUN_BROWSER_V2 !== '0',
  measure = (_name, run) => run(),
  maxEntries = 128,
} = {}) {
  const entries = new Map();
  const pages = new WeakMap();
  let nextPageId = 0;

  function pageState(page) {
    let state = pages.get(page);
    if (!state) {
      state = { id: ++nextPageId, generation: 0, serial: 0, pending: Promise.resolve() };
      pages.set(page, state);
      page.on?.('framenavigated', frame => {
        if (frame === page.mainFrame()) state.generation++;
      });
      page.on?.('close', () => {
        state.generation++;
        for (const [key, entry] of entries) if (entry.pageId === state.id) entries.delete(key);
      });
    }
    return state;
  }

  async function buildOne(page, opts, state) {
    const mode = 'ai';
    const scopeSel = opts.scopeSel || null;
    const budget = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.floor(opts.maxChars) : 30000;
    const explicitDepth = Number.isInteger(opts.depth) && opts.depth > 0 ? opts.depth : undefined;
    const generation = state.generation;
    const url = page.url();
    const context = JSON.stringify([opts.aiCacheKey || null, state.id, generation, url, scopeSel,
      explicitDepth ?? null, budget, !!opts.viewport]);
    const previous = opts.aiCacheKey ? entries.get(context) : undefined;
    const baseline = previous && (!opts.baselineId || previous.id === opts.baselineId) ? previous : undefined;
    const v2 = enabled();
    let depth = explicitDepth ?? ((v2 || opts.diff) ? previous?.depth : undefined) ?? (v2 ? 12 : undefined);
    let text;
    let captureCount = 0;
    const read = async () => {
      // Requests can expire while waiting behind another capture of this page.
      // Never let an abandoned capture replace the current Playwright ref map.
      opts.assertActive?.();
      captureCount++;
      const result = await measure('snapshotCapture', () => capture(page, { scopeSel, depth }));
      opts.assertActive?.();
      return result;
    };
    try {
      text = await read();
      if (!explicitDepth && text.length > budget) {
        if (v2 && depth > 9) {
          depth = 9;
          text = await read();
        } else if (!v2 && !(opts.diff && baseline)) {
          for (const candidate of [16, 12, 9]) {
            depth = candidate;
            text = await read();
            if (text.length <= budget) break;
          }
        }
      }
    } catch (error) {
      return { mode, snapshotText: null, snapshotError: error.message };
    }
    if (state.generation !== generation || page.url() !== url) {
      return { mode, snapshotText: null, snapshotError: 'Page navigated during capture; request a fresh snapshot.' };
    }

    const delivered = truncateSnapshotLines(text, budget);
    const id = randomBytes(8).toString('base64url');
    const serial = ++state.serial;
    const entry = { id, text: delivered.text, depth, pageId: state.id, serial, owner: opts.aiCacheKey };
    // Register before sending, but commit only after the HTTP response finishes.
    // Unsent, aborted and failed responses must never become implicit baselines.
    opts.onDelivered?.(() => {
      try { opts.assertActive?.(); } catch { return; }
      if (state.generation !== generation || page.url() !== url) return;
      if ((entries.get(context)?.serial || 0) > serial) return;
      entries.delete(context);
      entries.set(context, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    });

    const metadata = {
      mode, snapshotId: id, snapshotBudgetApplied: true,
      snapshotTruncated: delivered.truncated, snapshotTotalChars: text.length,
      snapshotCaptureCount: captureCount,
      ...(depth && !explicitDepth ? { aiDepth: depth } : {}),
    };
    const comparable = baseline && baseline.depth === depth;
    // Intent ranking needs every ref of THIS capture even when only a diff or
    // "unchanged" is shown. A second capture would replace the ref map, so the
    // full text rides along instead; the caller parses it and never prints it.
    const full = opts.includeFullText ? { snapshotFullText: delivered.text } : {};
    if (comparable && !opts.force && baseline.text === delivered.text) {
      return { ...metadata, ...full, snapshotText: null, unchanged: true, baselineId: baseline.id };
    }
    if (comparable && opts.diff && !opts.force) {
      const delta = diffSnapshotText(baseline.text, delivered.text);
      if (delta.diff !== undefined) {
        return {
          ...metadata, ...full, snapshotText: delta.diff, snapshotIsDiff: true, baselineId: baseline.id,
          diffPrefixLines: delta.prefixLines, diffSuffixLines: delta.suffixLines,
          diffRemovedLines: delta.removedLines, diffAddedLines: delta.addedLines,
        };
      }
    }
    return { ...metadata, snapshotText: delivered.text };
  }

  return {
    // Two callers capturing one page must not interleave Playwright ref maps.
    async build(page, opts = {}) {
      const state = pageState(page);
      const result = state.pending.then(() => buildOne(page, opts, state));
      state.pending = result.catch(() => {});
      return result;
    },
    clear(sessionId, tabId) {
      const prefix = `${sessionId}:${tabId ? `${tabId}:` : ''}`;
      for (const [key, entry] of entries) if (entry.owner?.startsWith(prefix)) entries.delete(key);
    },
  };
}

// Bound both the browser timer (background tabs may never paint) and transport.
export async function settleBrowserPage(page, { cap = 800, v2 = false } = {}) {
  const deadline = Date.now() + Math.max(0, cap);
  let timer;
  const run = async () => {
    if (!v2) await page.waitForTimeout(Math.min(120, Math.max(0, deadline - Date.now()))).catch(() => {});
    let remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await page.waitForLoadState('domcontentloaded', { timeout: remaining }).catch(() => {});
    remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await page.evaluate(ms => new Promise(resolve => {
      let first;
      let second;
      const done = () => {
        clearTimeout(timeout);
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
        resolve();
      };
      const timeout = setTimeout(done, ms);
      first = requestAnimationFrame(() => { second = requestAnimationFrame(done); });
    }), remaining).catch(() => {});
  };
  try {
    await Promise.race([run(), new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, cap)); })]);
  } finally {
    clearTimeout(timer);
  }
}
