/**
 * GSC URL Inspection — 4 tools.
 * gsc_inspect_url, gsc_inspect_test_live, gsc_inspect_request_indexing, gsc_inspect_view_crawled
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { GSC_BASE, encodeProperty, currentProperty, ensureAuth, resolve, wait, pollFor, safeNavigate } from './helpers.js';
import type { Resolved } from './helpers.js';

const tabId = z.string().optional();

// Match either an English or PT-BR verdict line in the inspection result.
const VERDICT_RE_SRC =
  'URL is on Google|O URL está no Google|URL está no Google|URL is not on Google|O URL não está no Google|URL não está no Google|page is indexed|A página está indexada|not indexed|não indexada|não está indexada';

const INSPECT_RESULT_SCRIPT = `
(() => {
  // Locate the inspection result panel: the verdict header lives inside a
  // [role="region"]/section/dialog whose innerText starts with the verdict text.
  const verdictRe = new RegExp(${JSON.stringify(VERDICT_RE_SRC)}, 'i');
  const allRegions = Array.from(document.querySelectorAll('[role="region"], section, [role="main"], main, [aria-label*="inspect" i], [aria-label*="inspeção" i]'));
  const region = allRegions.find(r => verdictRe.test((r.innerText || '').slice(0, 800))) || document.body;
  const regionText = (region.innerText || '').replace(/\\s+/g, ' ').trim();
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  // Walk the region's text content to extract label/value pairs from
  // GSC's <dt>/<dd>-style rows.
  const findValueByLabel = (re) => {
    const nodes = Array.from(region.querySelectorAll('dt, [role="term"], [class*="label" i], div, span'));
    for (const n of nodes) {
      const txt = norm(n.textContent || '');
      if (txt && re.test(txt) && txt.length < 80) {
        // Prefer sibling dd/role=definition; fall back to next-sibling node.
        const sib = n.nextElementSibling || n.parentElement?.querySelector('dd, [role="definition"], [class*="value" i]');
        if (sib) {
          const v = norm(sib.textContent || '');
          if (v && v !== txt) return v;
        }
        // As a last resort, strip the label out of the parent's innerText and
        // return the first remaining line.
        const par = n.parentElement;
        if (par) {
          const stripped = norm(par.textContent || '').replace(re, '').trim();
          if (stripped && stripped.length < 200) return stripped;
        }
      }
    }
    return null;
  };
  const verdictMatch = regionText.match(verdictRe);
  const verdict = verdictMatch ? verdictMatch[0] : null;
  const indexedPositive = /URL is on Google|O URL está no Google|URL está no Google|page is indexed|A página está indexada/i;
  const indexedNegative = /not on Google|não está no Google|not indexed|não indexada|não está indexada/i;
  const pageIndexed = !!verdict && indexedPositive.test(verdict) && !indexedNegative.test(verdict);
  return {
    pageIndexed,
    verdict,
    summary: regionText.slice(0, 600),
    indexingState: findValueByLabel(/^(?:Indexing|Indexação)\\b/i),
    coverage: findValueByLabel(/^(?:Coverage|Cobertura)\\b/i),
    canonicalUser: findValueByLabel(/user-declared canonical|canônica declarada/i),
    canonicalGoogle: findValueByLabel(/google-selected canonical|canônica selecionada pelo google|canônica selecionada/i),
    lastCrawl: findValueByLabel(/last crawl|último rastreamento|última vez rastreada/i),
    crawlStatus: findValueByLabel(/crawled as|rastreada como/i),
    crawlAllowed: findValueByLabel(/crawl allowed|rastreamento permitido/i),
    fetchStatus: findValueByLabel(/page fetch|busca de página|recuperação da página/i),
    robotsAllowed: findValueByLabel(/indexing allowed|indexação permitida|robots\\.txt/i),
    sitemap: findValueByLabel(/sitemap|mapa do site/i),
    referringPage: findValueByLabel(/referring page|página de referência/i),
    httpStatus: findValueByLabel(/^HTTP\\b|status\\s*HTTP/i),
    enhancements: Array.from(region.querySelectorAll('[role="listitem"], li')).slice(0, 50).map(li => norm(li.textContent)).filter(t => t && t.length < 200),
    fullText: regionText.slice(0, 4000),
  };
})()
`.trim();

const URL_INSPECTION_INPUT_SELECTOR = 'input[role="combobox"][aria-label*="URL" i]';

// Predicate that fires when either a verdict line OR a known error appears.
const INSPECT_READY_SCRIPT = `
(() => {
  const txt = document.body.innerText || '';
  const page = document.title + '\\n' + txt;
  if (/Error 404|Not Found|Não encontrado/i.test(page)) return { error: 'google_404', href: location.href };
  const verdictRe = new RegExp(${JSON.stringify(VERDICT_RE_SRC)}, 'i');
  if (verdictRe.test(txt)) return true;
  return null;
})()
`.trim();

/**
 * Drive the URL Inspection tool. Tries direct URL navigation first
 * (`/inspect?id=<encoded>&resource_id=<prop>`), then falls back to the
 * top-of-page form-fill flow if the direct route doesn't render results.
 */
async function submitUrlInspection(r: Resolved, prop: string, url: string): Promise<string | null> {
  // ── Strategy 1: direct URL ─────────────────────────────────────
  const directUrl = `${GSC_BASE}/inspect?id=${encodeURIComponent(url)}&resource_id=${encodeProperty(prop)}`;
  const directNav = await safeNavigate(r, directUrl);
  if (directNav.error) {
    // Network-level failure — fall through to fill-flow.
  } else {
    const authErr = await ensureAuth(r);
    if (authErr) return authErr;
    // Wait briefly for SPA to either render the result panel or stay stuck.
    const direct = await pollFor<boolean | { error?: string }>(
      r,
      `(() => {
        const txt = document.body.innerText || '';
        if (/Error 404|Not Found|Não encontrado/i.test(document.title + '\\n' + txt)) return { error: 'google_404' };
        const verdictRe = new RegExp(${JSON.stringify(VERDICT_RE_SRC)}, 'i');
        if (verdictRe.test(txt)) return true;
        if (location.pathname.includes('/inspect') && /retrieving|recuperando|loading|carregando/i.test(txt)) return null;
        return null;
      })()`,
      8000,
      400,
    );
    if (direct === true) return null;
    // GSC renders its 404 SPA AT the /inspect path, so a path-only success
    // check would short-circuit on the 404 page. Detect 404 first and fall
    // through to the form-fill flow when seen.
    const got404 = !!(direct && typeof direct === 'object' && (direct as { error?: string }).error === 'google_404');
    if (!got404) {
      // If direct route landed on /inspect but no verdict yet, that's fine — caller
      // will keep polling. Only fall back if we ended up somewhere else.
      const href = await ni.evaluate(r.sessionId, `location.pathname`, r.tabId);
      if (typeof href.result === 'string' && href.result.includes('/inspect')) return null;
    }
  }

  // ── Strategy 2: top-of-page form fill ─────────────────────────
  const homeUrl = `${GSC_BASE}?resource_id=${encodeProperty(prop)}`;
  const nav = await safeNavigate(r, homeUrl);
  if (nav.error) return `Navigation failed: ${nav.error}`;

  const authErr = await ensureAuth(r);
  if (authErr) return authErr;

  const fill = await ni.fill(r.sessionId, URL_INSPECTION_INPUT_SELECTOR, url, undefined, r.tabId, 'Inspect any URL');
  if (fill.error) {
    const fallback = await ni.evaluate(
      r.sessionId,
      `(() => {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const inputs = Array.from(document.querySelectorAll('input[role="combobox"], input[aria-label], input'));
        const target = inputs.find((el) => {
          const label = [el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ');
          return isVisible(el) && /inspect|inspecionar|url/i.test(label);
        });
        if (!target) return false;
        target.focus();
        target.value = ${JSON.stringify(url)};
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(url)} }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      r.tabId,
    );
    if (fallback.error) return `Could not fill URL inspection field: ${fallback.error}`;
    if (!fallback.result) return 'Could not find the GSC URL inspection input.';
  }

  const press = await ni.pressKey(r.sessionId, 'Enter', r.tabId);
  if (press.error) return `Could not submit URL inspection: ${press.error}`;

  const routed = await pollFor<string | { error?: string; href?: string }>(
    r,
    `(() => {
      const u = new URL(location.href);
      const page = document.title + '\\n' + (document.body.innerText || '');
      if (/Error 404|Not Found|Não encontrado/i.test(page)) return { error: 'google_404', href: location.href };
      if (location.pathname.includes('/inspect') && u.searchParams.get('id')) return location.href;
      return null;
    })()`,
    15000,
    500,
  );

  if (routed && typeof routed === 'object' && routed.error === 'google_404') {
    return `Google returned 404 while starting URL inspection (${routed.href || 'unknown URL'}).`;
  }
  if (!routed) {
    const href = await ni.evaluate(r.sessionId, `location.href`, r.tabId);
    return `URL inspection did not start after submitting the URL. Current URL: ${String(href.result || 'unknown')}`;
  }

  return null;
}

// ── gsc_inspect_url ───────────────────────────────────────────

export const gscInspectUrlSchema = {
  url: z.string().describe('Absolute URL to inspect (must belong to the active GSC property).'),
  property: z.string().optional().describe('Override active property (e.g. "sc-domain:example.com").'),
  timeoutMs: z.coerce.number().int().positive().optional().describe('Polling timeout in ms (default 30000).'),
  sessionId: z.string().optional(),
  tabId,
};

export const gscInspectUrlDescription =
  'Run URL Inspection on a URL — opens the inspect tool, fills the URL, polls up to 30s for the result panel, returns structured JSON ' +
  '(pageIndexed, verdict, indexingState, coverage, canonicalUser, canonicalGoogle, lastCrawl, crawlStatus, crawlAllowed, fetchStatus, robotsAllowed, sitemap, referringPage, httpStatus, enhancements, summary, fullText).';

export async function handleGscInspectUrl(args: { url: string; property?: string; timeoutMs?: number; sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  const prop = args.property || (await currentProperty(r));
  if (!prop) return text('No active property. Call gsc_navigate or gsc_property action=select first.');

  const submitErr = await submitUrlInspection(r, prop, args.url);
  if (submitErr) return text(submitErr);

  const ready = await pollFor<boolean | { error?: string; href?: string }>(
    r,
    INSPECT_READY_SCRIPT,
    args.timeoutMs ?? 30000,
    500,
  );
  if (ready && typeof ready === 'object' && ready.error === 'google_404') {
    return text(`Google returned 404 while loading URL inspection (${ready.href || 'unknown URL'}).`);
  }
  if (!ready) {
    const href = await ni.evaluate(r.sessionId, `location.href`, r.tabId);
    return text(`Inspect timed out after ${(args.timeoutMs ?? 30000) / 1000}s. Result may still be loading. Current URL: ${String(href.result || 'unknown')}`);
  }

  const res = await ni.evaluate(r.sessionId, INSPECT_RESULT_SCRIPT, r.tabId);
  if (res.error) return text(`Extract failed: ${res.error}`);
  return text(`Inspect for ${args.url}:\n${JSON.stringify(res.result, null, 2)}`);
}

// ── gsc_inspect_test_live ─────────────────────────────────────

export const gscInspectTestLiveSchema = {
  url: z.string().optional().describe('URL to inspect first (skip if already on the inspect result page).'),
  timeoutMs: z.coerce.number().int().positive().optional().describe('Polling timeout (default 90000 — live test is slow).'),
  sessionId: z.string().optional(),
  tabId,
};

export const gscInspectTestLiveDescription =
  'Click the "Test live URL" button on the URL Inspection page and poll up to 90s for results. ' +
  'Useful to verify a live page after a fix without waiting for re-indexing. Returns same shape as gsc_inspect_url with `liveTest:true`.';

export async function handleGscInspectTestLive(args: { url?: string; timeoutMs?: number; sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  if (args.url) {
    const inspectRes = await handleGscInspectUrl({ url: args.url, sessionId: args.sessionId, tabId: args.tabId });
    // ignore inspect text; the page is now loaded
    if (typeof (inspectRes as { content?: unknown }).content === 'undefined') return inspectRes;
  }

  const click = await ni.evaluate(
    r.sessionId,
    `(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const live = btns.find(b => /test\\s*live\\s*url|testar\\s*o\\s*url\\s*publicado|test\\s*live/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      if (live) { live.click(); return true; }
      return false;
    })()`,
    r.tabId,
  );
  if (!click.result) return text('Could not find "Test live URL" button. Run gsc_inspect_url first.');

  const ready = await pollFor(
    r,
    `(() => /Live test results|Resultados do teste|test (?:complete|finished)|live URL/i.test(document.body.innerText) && !/Testing|Loading|Carregando/i.test(document.body.innerText) ? true : null)()`,
    args.timeoutMs ?? 90000,
    1000,
  );
  if (!ready) return text(`Live test timed out after ${(args.timeoutMs ?? 90000) / 1000}s.`);

  const res = await ni.evaluate(r.sessionId, INSPECT_RESULT_SCRIPT, r.tabId);
  if (res.error) return text(`Extract failed: ${res.error}`);
  const data = (res.result || {}) as Record<string, unknown>;
  data.liveTest = true;
  return text(`Live test result:\n${JSON.stringify(data, null, 2)}`);
}

// ── gsc_inspect_request_indexing ──────────────────────────────

export const gscInspectRequestIndexingSchema = {
  url: z.string().optional().describe('URL to inspect first. Skip if already on the inspect result page.'),
  timeoutMs: z.coerce.number().int().positive().optional().describe('Polling timeout (default 60000).'),
  sessionId: z.string().optional(),
  tabId,
};

export const gscInspectRequestIndexingDescription =
  '[mutating — affects Google\'s crawl queue] Submit a URL to Google\'s indexing queue. ' +
  'Clicks "Request indexing" on the inspection result page (running a live test first if needed). ' +
  'Polls for the success/error modal and returns `{ requested, queued, error }`. Quota: ~10/day per property.';

export async function handleGscInspectRequestIndexing(args: { url?: string; timeoutMs?: number; sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  if (args.url) {
    await handleGscInspectUrl({ url: args.url, sessionId: args.sessionId, tabId: args.tabId });
  }

  const click = await ni.evaluate(
    r.sessionId,
    `(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const req = btns.find(b => /request\\s*indexing|solicitar\\s*indexação|solicitar\\s*novamente/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      if (req) { req.click(); return true; }
      return false;
    })()`,
    r.tabId,
  );
  if (!click.result) return text('Could not find "Request indexing" button. URL may already be queued or page not loaded.');

  const result = await pollFor<Record<string, unknown>>(
    r,
    `(() => {
      const txt = document.body.innerText;
      if (/Indexing requested|Indexação solicitada|URL added to a priority crawl queue|adicionado a uma fila de prioridade/i.test(txt)) return { requested: true, queued: true };
      if (/Quota exceeded|Cota excedida/i.test(txt)) return { requested: false, error: 'quota_exceeded' };
      if (/error|erro/i.test(txt) && /indexing|indexação/i.test(txt)) return { requested: false, error: 'indexing_error' };
      return null;
    })()`,
    args.timeoutMs ?? 60000,
    800,
  );

  if (!result) return text(`Request submitted but confirmation not detected within ${(args.timeoutMs ?? 60000) / 1000}s. Check browser_snapshot.`);
  return text(`Indexing request:\n${JSON.stringify(result, null, 2)}`);
}

// ── gsc_inspect_view_crawled ──────────────────────────────────

export const gscInspectViewCrawledSchema = {
  view: z.enum(['html', 'screenshot', 'http_response', 'more_info'] as const).describe('Which crawled-page view to open.'),
  sessionId: z.string().optional(),
  tabId,
};

export const gscInspectViewCrawledDescription =
  'Open the "View crawled page" panel from the URL Inspection result and switch to the requested view ' +
  '(html / screenshot / http_response / more_info). Use browser_screenshot or browser_snapshot afterwards to capture content.';

export async function handleGscInspectViewCrawled(args: { view: string; sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  const open = await ni.evaluate(
    r.sessionId,
    `(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const view = btns.find(b => /view\\s*crawled\\s*page|ver\\s*a\\s*página\\s*rastreada/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      if (view) { view.click(); return true; }
      return false;
    })()`,
    r.tabId,
  );
  if (!open.result) return text('Could not find "View crawled page" button. Run gsc_inspect_url first.');
  await wait(1500);

  const tabMap: Record<string, RegExp> = {
    html: /HTML/i,
    screenshot: /screenshot|captura/i,
    http_response: /HTTP\s*response|resposta\s*HTTP/i,
    more_info: /more\s*info|mais\s*informações/i,
  };
  const re = tabMap[args.view];
  if (!re) return text(`Unknown view: ${args.view}`);

  const click = await ni.evaluate(
    r.sessionId,
    `(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"], button, [role="button"]'));
      const target = tabs.find(t => ${re.toString()}.test(t.textContent || ''));
      if (target) { target.click(); return true; }
      return false;
    })()`,
    r.tabId,
  );
  if (!click.result) return text(`Tab "${args.view}" not found in panel.`);
  await wait(800);
  return text(`Crawled-page view "${args.view}" opened. Use browser_snapshot or browser_screenshot to read content.`);
}
