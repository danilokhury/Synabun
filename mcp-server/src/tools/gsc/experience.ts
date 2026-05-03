/**
 * GSC Experience + Enhancements + Links.
 * Tools: gsc_cwv_report, gsc_https_report, gsc_security_issues,
 *        gsc_manual_actions, gsc_enhancements, gsc_links_report, gsc_links_export
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { GSC_BASE, encodeProperty, currentProperty, ensureAuth, resolve, wait, pollFor, safeNavigate, TABLE_EXTRACTOR_SCRIPT, readMetricTileScript } from './helpers.js';

const tabId = z.string().optional();

async function loadAndExtract(
  sessionId: string | undefined,
  tabIdArg: string | undefined,
  property: string | undefined,
  path: string,
) {
  const r = await resolve(sessionId, tabIdArg);
  if ('error' in r) return { err: r.error, r: null as never };
  const prop = property || (await currentProperty(r));
  if (!prop) return { err: 'No active property.', r };
  const sep = path.includes('?') ? '&' : '?';
  const nav = await safeNavigate(r, `${GSC_BASE}${path}${sep}resource_id=${encodeProperty(prop)}`);
  if (nav.error) return { err: `Navigation failed: ${nav.error}`, r };
  const authErr = await ensureAuth(r);
  if (authErr) return { err: authErr, r };
  await pollFor(r, `(() => document.body.innerText.length > 200 ? true : null)()`, 20000, 500);
  await wait(700);
  return { err: null, r };
}

// ── gsc_cwv_report ────────────────────────────────────────────

export const gscCwvReportSchema = {
  device: z.enum(['mobile', 'desktop'] as const),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscCwvReportDescription =
  'Read Core Web Vitals report for mobile or desktop. Returns counts of poor / needs-improvement / good URLs and per-issue URL group examples.';

export async function handleGscCwvReport(args: { device: string; property?: string; sessionId?: string; tabId?: string }) {
  const path = args.device === 'desktop' ? '/core-web-vitals?device=DESKTOP' : '/core-web-vitals?device=MOBILE';
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, path);
  if (err) return text(err);

  const noData = await ni.evaluate(
    r.sessionId,
    `(() => /Nenhum dado|No data|No CWV data/i.test(document.body.innerText) && !document.querySelector('[role="grid"], [role="table"]'))()`,
    r.tabId,
  );
  if (noData.result) {
    return text(JSON.stringify({ device: args.device, summary: { poor: '0', needsImprovement: '0', good: '0' }, issues: { headers: [], rows: [] }, status: 'no_data' }, null, 2));
  }

  const [poorRes, niRes, goodRes, tableRes] = await Promise.all([
    ni.evaluate(r.sessionId, readMetricTileScript('poor'), r.tabId),
    ni.evaluate(r.sessionId, readMetricTileScript('needsImprovement'), r.tabId),
    ni.evaluate(r.sessionId, readMetricTileScript('good'), r.tabId),
    ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId),
  ]);
  const summary = {
    poor: (poorRes.result as string | null) ?? null,
    needsImprovement: (niRes.result as string | null) ?? null,
    good: (goodRes.result as string | null) ?? null,
  };
  // Distinguish "no data" (caught above) from "parse failed" — when the
  // tile reader missed every metric AND no grid rendered, surface that.
  if (summary.poor === null && summary.needsImprovement === null && summary.good === null && !tableRes.result) {
    return text(JSON.stringify({ device: args.device, summary, issues: { headers: [], rows: [] }, status: 'parse_failed' }, null, 2));
  }
  return text(JSON.stringify({ device: args.device, summary, issues: tableRes.result || { headers: [], rows: [] } }, null, 2));
}

// ── gsc_https_report ──────────────────────────────────────────

export const gscHttpsReportSchema = {
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscHttpsReportDescription =
  'Read the HTTPS report — counts of HTTPS vs non-HTTPS URLs and reasons for non-HTTPS URLs with examples.';

export async function handleGscHttpsReport(args: { property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/https');
  if (err) return text(err);
  // The HTTPS report often shows a tiny per-row table with HTTPS / Não HTTPS
  // headers — read counts directly from the row instead of grepping body text.
  const summary = await ni.evaluate(
    r.sessionId,
    `(() => {
      const cells = Array.from(document.querySelectorAll('th, td, [role="columnheader"], [role="gridcell"], [role="cell"]'));
      let httpsUrls = null, nonHttpsUrls = null;
      const norm = (el) => (el.innerText || el.textContent || '').trim();
      for (let i = 0; i < cells.length; i++) {
        const t = norm(cells[i]);
        if (/^HTTPS$/i.test(t)) {
          // The number is usually in the next sibling column or row.
          const sib = cells[i + 1] || cells[i].parentElement?.nextElementSibling?.querySelector('td, [role="gridcell"]');
          if (sib) {
            const m = norm(sib).match(/-?\\d[\\d.,]*/);
            if (m) httpsUrls = m[0];
          }
        }
        if (/^(Non[- ]?HTTPS|N[aã]o\\s*HTTPS|HTTP)$/i.test(t)) {
          const sib = cells[i + 1] || cells[i].parentElement?.nextElementSibling?.querySelector('td, [role="gridcell"]');
          if (sib) {
            const m = norm(sib).match(/-?\\d[\\d.,]*/);
            if (m) nonHttpsUrls = m[0];
          }
        }
      }
      return { httpsUrls, nonHttpsUrls };
    })()`,
    r.tabId,
  );
  let s = (summary.result as { httpsUrls: string | null; nonHttpsUrls: string | null } | null) || { httpsUrls: null, nonHttpsUrls: null };
  if (s.httpsUrls === null && s.nonHttpsUrls === null) {
    const [hRes, nRes] = await Promise.all([
      ni.evaluate(r.sessionId, readMetricTileScript('httpsUrls'), r.tabId),
      ni.evaluate(r.sessionId, readMetricTileScript('nonHttpsUrls'), r.tabId),
    ]);
    s = {
      httpsUrls: (hRes.result as string | null) ?? null,
      nonHttpsUrls: (nRes.result as string | null) ?? null,
    };
  }
  const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId);
  return text(JSON.stringify({ summary: s, reasons: tableRes.result || { headers: [], rows: [] } }, null, 2));
}

// ── gsc_security_issues ───────────────────────────────────────

export const gscSecurityIssuesSchema = {
  action: z.enum(['list', 'request_review'] as const).optional().describe('list (default) returns active issues; request_review submits a reconsideration request.'),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscSecurityIssuesDescription =
  'Read Security Issues. action=list returns active + history. action=request_review clicks "Request review" (mutating, requires fixed issues).';

export async function handleGscSecurityIssues(args: { action?: string; property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/security-issues');
  if (err) return text(err);
  const action = args.action || 'list';
  if (action === 'request_review') {
    const click = await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const req = btns.find(b => /request\\s*review|solicitar\\s*revisão/i.test(b.textContent || '')); if (req) { req.click(); return true; } return false; })()`,
      r.tabId,
    );
    if (!click.result) return text('Request review button not found — no fixable issues, or review already pending.');
    return text('Review request flow opened. Use browser_snapshot to inspect form, then submit via browser_click.');
  }
  const issues = await ni.evaluate(
    r.sessionId,
    `(() => {
      const cards = Array.from(document.querySelectorAll('section, [role="region"], .issue-card'));
      return cards.map(c => c.innerText.trim().replace(/\\s+/g, ' ').slice(0, 600)).filter(t => t.length > 20);
    })()`,
    r.tabId,
  );
  return text(JSON.stringify({ issues: issues.result || [] }, null, 2));
}

// ── gsc_manual_actions ────────────────────────────────────────

export const gscManualActionsSchema = {
  action: z.enum(['list', 'reconsideration'] as const).optional(),
  body: z.string().optional().describe('Reconsideration request body text. Required for action=reconsideration.'),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscManualActionsDescription =
  'Read Manual Actions. action=list returns penalties (or "No issues detected"). action=reconsideration submits a reconsideration request with `body` (mutating).';

export async function handleGscManualActions(args: { action?: string; body?: string; property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/manual-actions');
  if (err) return text(err);
  const action = args.action || 'list';
  if (action === 'reconsideration') {
    if (!args.body) return text('body required for reconsideration.');
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const req = btns.find(b => /request\\s*review|solicitar\\s*reconsider/i.test(b.textContent || '')); if (req) req.click(); })()`,
      r.tabId,
    );
    await wait(1500);
    await ni.evaluate(
      r.sessionId,
      `(() => { const ta = document.querySelector('textarea'); if (ta) { ta.focus(); ta.value = ${JSON.stringify(args.body)}; ta.dispatchEvent(new Event('input', { bubbles: true })); } })()`,
      r.tabId,
    );
    await wait(400);
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const sub = btns.find(b => /^(submit|enviar)$/i.test((b.textContent || '').trim())); if (sub) sub.click(); })()`,
      r.tabId,
    );
    return text('Reconsideration request submitted (verify with browser_snapshot).');
  }
  const issues = await ni.evaluate(
    r.sessionId,
    `(() => {
      const main = document.querySelector('[role="main"], main') || document.body;
      const txt = (main.innerText || '');
      return {
        status: /no\\s*issues|nenhum\\s*problema/i.test(txt) ? 'clean' : 'issues_present',
        text: txt.slice(0, 4000),
      };
    })()`,
    r.tabId,
  );
  return text(JSON.stringify(issues.result, null, 2));
}

// ── gsc_enhancements ──────────────────────────────────────────

const ENHANCE_PATHS: Record<string, string> = {
  breadcrumbs: '/r/breadcrumbs',
  faq: '/r/faq',
  sitelinks: '/r/sitelinks-search-box',
  videos: '/r/videos',
  products: '/r/product-snippets',
  recipes: '/r/recipes',
  review: '/r/review-snippets',
  events: '/r/events',
  jobposting: '/r/job-postings',
  speakable: '/r/speakable',
  qa: '/r/q-a',
  logos: '/r/logos',
  sitenames: '/r/sitenames',
  dataset: '/r/dataset',
  practice: '/r/practice-problems',
  math: '/r/math-solvers',
  merchant: '/r/merchant-listings',
};

export const gscEnhancementsSchema = {
  report: z.enum(Object.keys(ENHANCE_PATHS) as [string, ...string[]]),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscEnhancementsDescription =
  `Read a structured-data Enhancements report. Returns valid / warnings / errors counts and per-issue URL examples. Reports: ${Object.keys(ENHANCE_PATHS).join(', ')}.`;

export async function handleGscEnhancements(args: { report: string; property?: string; sessionId?: string; tabId?: string }) {
  const path = ENHANCE_PATHS[args.report];
  if (!path) return text(`Unknown enhancement report: ${args.report}`);
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, path);
  if (err) return text(err);
  // Scope summary tile reads to the top-of-report metric region so we don't
  // catch numbers from issue rows (which include "5xx" / "500", etc).
  const summaryRes = await ni.evaluate(
    r.sessionId,
    `(() => {
      const main = document.querySelector('[role="main"], main') || document.body;
      // Find a region above the issues grid that contains the chart + tiles.
      const grid = main.querySelector('[role="grid"], [role="table"], table');
      const allRegions = Array.from(main.querySelectorAll('section, [role="region"], [role="group"], div'));
      // Prefer a region that contains a chart (canvas/svg) AND comes before the grid.
      let scope = null;
      for (const region of allRegions) {
        if (!region.querySelector('canvas, svg')) continue;
        if (grid && (region.contains(grid) || region.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          scope = region;
          break;
        }
      }
      // Fallback: the first heading group that mentions valid/warning/error.
      if (!scope) {
        const headings = Array.from(main.querySelectorAll('h2, h3, [role="heading"]'));
        const h = headings.find(x => /valid|aviso|warning|erro|error/i.test(x.textContent || ''));
        if (h) scope = h.closest('section, [role="region"], div') || h.parentElement;
      }
      if (!scope) scope = main;
      const txt = (scope.innerText || '').replace(/\\s+/g, ' ');
      // Inline label-to-number readers — replicate readMetricTileScript scope-bound.
      const labels = {
        valid: ${JSON.stringify(['Valid', 'Válido', 'Válidos', 'Válidas', 'Itens válidos', 'Entidades válidas'])},
        warnings: ${JSON.stringify(['Warning', 'Warnings', 'Aviso', 'Avisos'])},
        errors: ${JSON.stringify(['Error', 'Errors', 'Erro', 'Erros', 'Entidades inválidas'])},
      };
      const numRe = /-?\\d[\\d.,]*/;
      const findFor = (alts) => {
        const alt = alts.slice().sort((a,b) => b.length - a.length).map(s => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('|');
        const exact = new RegExp('^\\\\s*(?:' + alt + ')\\\\s*[:：]?\\\\s*$', 'i');
        const re = new RegExp(alt, 'i');
        const candidates = Array.from(scope.querySelectorAll('div, span, p, dt, label, h2, h3, td, th'));
        const exacts = candidates.filter(n => exact.test((n.textContent || '').trim()));
        const fallback = candidates.filter(n => re.test(n.textContent || ''));
        const nodes = exacts.length ? exacts : fallback.slice(0, 6);
        for (const node of nodes) {
          let cur = node;
          for (let depth = 0; cur && depth < 6; depth++, cur = cur.parentElement) {
            const t = (cur.innerText || cur.textContent || '');
            if (re.test(t) && numRe.test(t)) {
              const stripped = t.replace(re, ' ');
              const m = stripped.match(numRe);
              if (m) return m[0].trim();
            }
          }
        }
        return null;
      };
      return {
        valid: findFor(labels.valid),
        warnings: findFor(labels.warnings),
        errors: findFor(labels.errors),
      };
    })()`,
    r.tabId,
  );
  const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId);
  const summary = (summaryRes.result as { valid: string | null; warnings: string | null; errors: string | null } | null)
    || { valid: null, warnings: null, errors: null };
  return text(JSON.stringify({ report: args.report, summary, issues: tableRes.result || { headers: [], rows: [] } }, null, 2));
}

// ── gsc_links_report ──────────────────────────────────────────

export const gscLinksReportSchema = {
  section: z.enum(['top_linked_external', 'top_linking_sites', 'top_linking_text', 'top_linked_internal'] as const),
  limit: z.coerce.number().int().positive().optional().describe('Max rows to scroll-load (default 100).'),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscLinksReportDescription =
  'Read a Links report section. top_linked_external / top_linking_sites / top_linking_text / top_linked_internal. Returns full table.';

export async function handleGscLinksReport(args: { section: string; limit?: number; property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/links');
  if (err) return text(err);

  const sectionLabels: Record<string, RegExp> = {
    top_linked_external: /Top linked pages|Páginas mais vinculadas/i,
    top_linking_sites: /Top linking sites|Sites com mais links/i,
    top_linking_text: /Top linking text|Texto âncora mais comum/i,
    top_linked_internal: /Internally linked|Páginas com links internos/i,
  };
  const re = sectionLabels[args.section];
  // Each section has a "more" link; click it to navigate to the full-table view.
  await ni.evaluate(
    r.sessionId,
    `(() => {
      const cards = Array.from(document.querySelectorAll('section, [role="region"], div'));
      const card = cards.find(c => ${re.toString()}.test(c.textContent || ''));
      if (card) {
        const more = card.querySelector('a, button, [role="link"], [role="button"]');
        if (more && /more|mais/i.test(more.textContent || '')) more.click();
      }
    })()`,
    r.tabId,
  );
  // Wait for navigation to a drilldown URL OR for a single full-page grid
  // with rows to appear. Without this, extraction races the overview cards.
  await pollFor(
    r,
    `(() => {
      if (/\\/links\\/(?:drilldown|details|external)/.test(location.pathname + location.search)) return true;
      const main = document.querySelector('[role="main"], main') || document.body;
      const grids = main.querySelectorAll('[role="grid"], [role="table"], table');
      // Drilldown view typically has exactly one grid with > 1 row.
      if (grids.length === 1) {
        const rows = grids[0].querySelectorAll('[role="row"]:not(:has([role="columnheader"])), tbody tr');
        if (rows.length > 0) return true;
      }
      return null;
    })()`,
    8000,
    400,
  );

  const limit = args.limit ?? 100;
  for (let i = 0; i < 8; i++) {
    const count = await ni.evaluate(r.sessionId, `(() => document.querySelectorAll('[role="main"] [role="grid"] [role="row"], [role="main"] [role="table"] tr, main [role="grid"] [role="row"], main [role="table"] tr').length)()`, r.tabId);
    if (Number(count.result || 0) >= limit) break;
    await ni.scroll(r.sessionId, { direction: 'down', distance: 1500 }, r.tabId);
    await wait(600);
  }
  const tableRes = await ni.evaluate(
    r.sessionId,
    TABLE_EXTRACTOR_SCRIPT('[role="main"] [role="grid"], [role="main"] [role="table"], main [role="grid"], main [role="table"]'),
    r.tabId,
  );
  const t = (tableRes.result || { headers: [], rows: [] }) as { headers: string[]; rows: Array<Record<string, unknown>> };
  t.rows = t.rows.slice(0, limit);
  return text(JSON.stringify({ section: args.section, table: t }, null, 2));
}

// ── gsc_links_export ──────────────────────────────────────────

export const gscLinksExportSchema = {
  scope: z.enum(['external', 'internal', 'sample_external', 'sample_internal'] as const).describe('Export scope from the Links report Export menu.'),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscLinksExportDescription =
  'Trigger Links report Export menu. Browser handles file download.';

export async function handleGscLinksExport(args: { scope: string; property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/links');
  if (err) return text(err);
  await ni.evaluate(
    r.sessionId,
    `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const exp = btns.find(b => /export\\s*external\\s*links|exportar\\s*links\\s*externos/i.test(b.textContent || '') || /^export$|^exportar$/i.test((b.textContent || '').trim())); if (exp) exp.click(); })()`,
    r.tabId,
  );
  await wait(800);
  const labels: Record<string, RegExp> = {
    external: /external links|links externos/i,
    internal: /internal links|links internos/i,
    sample_external: /sample.*external|amostra.*externos/i,
    sample_internal: /sample.*internal|amostra.*internos/i,
  };
  const re = labels[args.scope];
  await ni.evaluate(
    r.sessionId,
    `(() => { const items = Array.from(document.querySelectorAll('[role="menuitem"], a, button')); const t = items.find(i => ${re.toString()}.test(i.textContent || '')); if (t) t.click(); })()`,
    r.tabId,
  );
  await wait(2000);
  return text(`Links export triggered: ${args.scope}. Download in browser default dir.`);
}
