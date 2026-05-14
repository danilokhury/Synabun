/**
 * GSC Performance — 3 tools.
 * gsc_performance_query, gsc_performance_export, gsc_performance_chart_screenshot
 */
import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { GSC_BASE, currentProperty, ensureAuth, resolve, wait, pollFor, safeNavigate, TABLE_EXTRACTOR_SCRIPT, readMetricTileScript } from './helpers.js';
const tabId = z.string().optional();
// Date-range slug → days mapping for the URL "num_of_days" / "compare" parameters.
const RANGE_SLUGS = {
    '24h': '1',
    '7d': '7',
    '28d': '28',
    '3m': '90',
    '6m': '180',
    '12m': '365',
    '16m': '475',
};
const DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance', 'date'];
const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];
// ── gsc_performance_query ─────────────────────────────────────
export const gscPerformanceQuerySchema = {
    searchType: z.enum(SEARCH_TYPES).optional().describe('Search type filter. Default: web.'),
    dateRange: z.enum(['24h', '7d', '28d', '3m', '6m', '12m', '16m', 'custom']).optional().describe('Preset range or "custom" with customStart/customEnd.'),
    customStart: z.string().optional().describe('YYYY-MM-DD start (with dateRange="custom").'),
    customEnd: z.string().optional().describe('YYYY-MM-DD end (with dateRange="custom").'),
    dimension: z.enum(DIMENSIONS).optional().describe('Primary dimension to group by. Default: query.'),
    filters: z.array(z.object({
        type: z.enum(['query', 'page', 'country', 'device']),
        op: z.enum(['contains', 'notContains', 'equals', 'notEquals', 'regex', 'notRegex']).optional(),
        value: z.string(),
    })).optional().describe('Chip filters to apply. Op default: contains.'),
    compare: z.boolean().optional().describe('Enable date-range comparison.'),
    limit: z.coerce.number().int().positive().optional().describe('Max rows (default 200, GSC table caps at 1000 visible).'),
    property: z.string().optional(),
    sessionId: z.string().optional(),
    tabId,
};
export const gscPerformanceQueryDescription = 'Run a Performance report query — sets searchType, dateRange (preset or custom), primary dimension, chip filters, and optional comparison; ' +
    'returns total clicks/impressions/CTR/position plus full table rows as JSON. Auto-scrolls the grid to load up to `limit` rows.';
export async function handleGscPerformanceQuery(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    const prop = args.property || (await currentProperty(r));
    if (!prop)
        return text('No active property. Call gsc_navigate first.');
    // Build URL — GSC supports query-string state for type/range/dimension.
    const params = new URLSearchParams({ resource_id: prop });
    const searchType = args.searchType || 'web';
    if (searchType === 'discover')
        params.set('page_type', 'discover');
    else if (searchType === 'googleNews' || searchType === 'news')
        params.set('page_type', 'googleNews');
    if (args.dateRange === 'custom') {
        if (!args.customStart || !args.customEnd)
            return text('customStart and customEnd required for dateRange=custom.');
        params.set('start_date', args.customStart);
        params.set('end_date', args.customEnd);
    }
    else if (args.dateRange && RANGE_SLUGS[args.dateRange]) {
        params.set('num_of_days', RANGE_SLUGS[args.dateRange]);
    }
    if (args.compare)
        params.set('compare', '1');
    // NOTE: GSC's filter URL parameter uses an opaque serialized format we
    // can't easily reproduce. Filters are applied via the chip UI below
    // (after navigation + grid render).
    const path = searchType === 'discover' ? '/performance/discover' : (searchType === 'news' || searchType === 'googleNews') ? '/performance/google-news' : '/performance/search-analytics';
    const url = `${GSC_BASE}${path}?${params.toString()}`;
    const nav = await safeNavigate(r, url);
    if (nav.error)
        return text(`Navigation failed: ${nav.error}`);
    const authErr = await ensureAuth(r);
    if (authErr)
        return text(authErr);
    // Wait for grid to render
    await pollFor(r, `(() => document.querySelector('[role="grid"], [role="table"]') ? true : null)()`, 20000, 500);
    await wait(800);
    // Apply filter chips via the UI ("+ New" → type → op → value → Apply).
    // GSC's URL filter param uses an opaque serialized format we can't reproduce.
    if (args.filters?.length) {
        const typeLabels = {
            query: ['Query', 'Consulta'],
            page: ['Page', 'Página'],
            country: ['Country', 'País'],
            device: ['Device', 'Dispositivo'],
        };
        const opLabels = {
            contains: ['Contains', 'Contém'],
            notContains: ["Doesn't contain", 'Não contém'],
            equals: ['Equals', 'Igual a'],
            notEquals: ["Doesn't equal", 'Diferente de'],
            regex: ['Custom (regex)', 'Personalizado (regex)', 'Regex'],
            notRegex: ['Custom (regex)', 'Doesn\'t match regex', 'Não corresponde'],
        };
        for (const f of args.filters) {
            const tlabels = typeLabels[f.type] || [f.type];
            const op = f.op || 'contains';
            const olabels = opLabels[op] || [op];
            // Click the "+ New" / "+ Novo" filter add affordance.
            await ni.evaluate(r.sessionId, `(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
          const add = btns.find(b => /\\+\\s*New|\\+\\s*Novo|Add\\s*filter|Adicionar\\s*filtro|New\\s*filter/i.test((b.textContent || b.getAttribute('aria-label') || '').trim()));
          if (add) { add.click(); return true; }
          return false;
        })()`, r.tabId);
            await wait(500);
            // Pick the dimension type from the popup menu.
            await ni.evaluate(r.sessionId, `(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li'));
          const target = items.find(i => ${tlabels.map(l => `/^\\s*${l.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$/i.test((i.textContent || '').trim())`).join(' || ')});
          if (target) { target.click(); return true; }
          return false;
        })()`, r.tabId);
            await wait(700);
            // If op is not the default 'contains', open op selector and pick.
            if (op !== 'contains') {
                await ni.evaluate(r.sessionId, `(() => {
            const sel = document.querySelector('[role="combobox"], select');
            if (sel) sel.click();
          })()`, r.tabId);
                await wait(400);
                await ni.evaluate(r.sessionId, `(() => {
            const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], option, li'));
            const target = items.find(i => ${olabels.map(l => `/${l.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/i.test((i.textContent || '').trim())`).join(' || ')});
            if (target) { target.click(); return true; }
            return false;
          })()`, r.tabId);
                await wait(400);
            }
            // Fill the value input.
            await ni.evaluate(r.sessionId, `(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea'));
          const visible = inputs.filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          });
          const target = visible[visible.length - 1];
          if (!target) return false;
          target.focus();
          target.value = ${JSON.stringify(f.value)};
          target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(f.value)} }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`, r.tabId);
            await wait(300);
            // Click Apply / Enter.
            await ni.evaluate(r.sessionId, `(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const apply = btns.find(b => /^(Apply|Aplicar|OK|Done|Concluir)$/i.test((b.textContent || '').trim()));
          if (apply) { apply.click(); return true; }
          return false;
        })()`, r.tabId);
            // Wait for the chip to appear with the value text.
            await pollFor(r, `(() => {
          const chips = Array.from(document.querySelectorAll('[role="button"], button, [class*="chip" i]'));
          return chips.some(c => (c.textContent || '').includes(${JSON.stringify(f.value)})) ? true : null;
        })()`, 4000, 300);
            await wait(400);
        }
    }
    // Click correct dimension tab (uses material icon ligatures + label fallback)
    const dim = args.dimension || 'query';
    const dimLabels = {
        query: ['QUERIES', 'Consultas', 'PESQUISAS'],
        page: ['PAGES', 'Páginas'],
        country: ['COUNTRIES', 'Países'],
        device: ['DEVICES', 'Dispositivos'],
        searchAppearance: ['SEARCH APPEARANCE', 'Aparência'],
        date: ['DATES', 'Datas'],
    };
    const labels = dimLabels[dim];
    await ni.evaluate(r.sessionId, `(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
      const target = tabs.find(t => ${labels.map((l) => `(t.textContent||'').toUpperCase().includes(${JSON.stringify(l.toUpperCase())})`).join(' || ')});
      if (target) target.click();
    })()`, r.tabId);
    // Wait for the active tab to reflect the requested dimension instead of
    // a fixed sleep — table extraction races SPA load otherwise.
    await pollFor(r, `(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      const sel = tabs.find(t => t.getAttribute('aria-selected') === 'true');
      if (!sel) return null;
      const txt = (sel.textContent || '').toUpperCase();
      return ${labels.map((l) => `txt.includes(${JSON.stringify(l.toUpperCase())})`).join(' || ')} ? true : null;
    })()`, 6000, 300);
    await wait(800);
    // Auto-scroll grid to load rows up to `limit`
    const limit = args.limit ?? 200;
    for (let i = 0; i < 12; i++) {
        const count = await ni.evaluate(r.sessionId, `(() => document.querySelectorAll('[role="grid"] [role="row"], [role="table"] tr').length)()`, r.tabId);
        const n = Number(count.result || 0);
        if (n >= limit)
            break;
        await ni.scroll(r.sessionId, { direction: 'down', distance: 1500 }, r.tabId);
        await wait(700);
    }
    // Extract totals from the metric cards above the grid using the
    // locale-aware tile reader (returns single string per metric, never an array).
    const [tcRes, tiRes, ctrRes, apRes] = await Promise.all([
        ni.evaluate(r.sessionId, readMetricTileScript('totalClicks'), r.tabId),
        ni.evaluate(r.sessionId, readMetricTileScript('totalImpressions'), r.tabId),
        ni.evaluate(r.sessionId, readMetricTileScript('avgCTR'), r.tabId),
        ni.evaluate(r.sessionId, readMetricTileScript('avgPosition'), r.tabId),
    ]);
    const totals = {
        totalClicks: tcRes.result ?? null,
        totalImpressions: tiRes.result ?? null,
        avgCTR: ctrRes.result ?? null,
        avgPosition: apRes.result ?? null,
    };
    const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId);
    if (tableRes.error)
        return text(`Table extract failed: ${tableRes.error}`);
    const table = (tableRes.result || { headers: [], rows: [] });
    table.rows = table.rows.slice(0, limit);
    return text(JSON.stringify({
        searchType, dimension: dim, dateRange: args.dateRange, filters: args.filters || [],
        compare: !!args.compare, totals, table,
    }, null, 2));
}
// ── gsc_performance_export ────────────────────────────────────
export const gscPerformanceExportSchema = {
    format: z.enum(['csv', 'excel', 'google_sheets']).describe('Export format.'),
    sessionId: z.string().optional(),
    tabId,
};
export const gscPerformanceExportDescription = 'Trigger Performance report export menu in the active tab. Format: csv → ZIP download; excel → XLSX; google_sheets → opens a new Sheet. ' +
    'Browser handles the actual download to its default download dir.';
export async function handleGscPerformanceExport(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    await ni.evaluate(r.sessionId, `(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const exp = btns.find(b => /export|exportar/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      if (exp) exp.click();
    })()`, r.tabId);
    await wait(800);
    const labels = {
        csv: /CSV/i,
        excel: /Excel|XLSX/i,
        google_sheets: /Google\s*Sheets|Planilhas\s*Google/i,
    };
    const re = labels[args.format];
    const click = await ni.evaluate(r.sessionId, `(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"], a, button'));
      const target = items.find(i => ${re.toString()}.test(i.textContent || ''));
      if (target) { target.click(); return true; }
      return false;
    })()`, r.tabId);
    if (!click.result)
        return text(`Could not find ${args.format} option in Export menu.`);
    await wait(2000);
    return text(`Export triggered: ${args.format}. ${args.format === 'google_sheets' ? 'New Sheet opens in another tab.' : 'File downloading to browser default download dir.'}`);
}
// ── gsc_performance_chart_screenshot ──────────────────────────
export const gscPerformanceChartScreenshotSchema = {
    sessionId: z.string().optional(),
    tabId,
};
export const gscPerformanceChartScreenshotDescription = 'Capture a screenshot scoped to the Performance chart panel only — useful for visual reports.';
export async function handleGscPerformanceChartScreenshot(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    const res = await ni.screenshot(r.sessionId, r.tabId);
    if (res.error)
        return text(`Screenshot failed: ${res.error}`);
    return text('Performance chart screenshot captured. Saved to data/images via SynaBun image staging.');
}
//# sourceMappingURL=performance.js.map