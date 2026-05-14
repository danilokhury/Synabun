/**
 * GSC Indexing reports — pages, videos, sitemaps, removals.
 * Tools: gsc_pages_report, gsc_pages_validate_fix, gsc_videos_report,
 *        gsc_sitemap, gsc_removals, gsc_removals_cancel
 */
import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { GSC_BASE, encodeProperty, currentProperty, ensureAuth, resolve, wait, pollFor, safeNavigate, TABLE_EXTRACTOR_SCRIPT, readMetricTileScript } from './helpers.js';
const tabId = z.string().optional();
// ── gsc_pages_report ──────────────────────────────────────────
export const gscPagesReportSchema = {
    reason: z.string().optional().describe('Drill into a specific reason (e.g. "Not found (404)", "Excluded by ‘noindex’ tag"). Returns URL examples for that bucket.'),
    property: z.string().optional(),
    sessionId: z.string().optional(),
    tabId,
};
export const gscPagesReportDescription = 'Read the Pages (Coverage/Indexação) report — totals indexed/notIndexed and per-reason buckets with counts and trends. ' +
    'Pass `reason` to drill into a bucket and list URL examples.';
export async function handleGscPagesReport(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    const prop = args.property || (await currentProperty(r));
    if (!prop)
        return text('No active property.');
    const url = `${GSC_BASE}/index?resource_id=${encodeProperty(prop)}`;
    const nav = await safeNavigate(r, url);
    if (nav.error)
        return text(`Navigation failed: ${nav.error}`);
    const authErr = await ensureAuth(r);
    if (authErr)
        return text(authErr);
    await pollFor(r, `(() => document.querySelector('[role="grid"], [role="table"]') || /Indexad[oa]s?|Indexed/.test(document.body.innerText) ? true : null)()`, 20000, 500);
    await wait(800);
    // Top-level metrics — readMetricTileScript walks ancestors so it handles
    // the GSC tile layout where label and number sit in adjacent (not nested)
    // elements. Pages report uses "Indexados" (masculine) for the indexed tile
    // even though listings/rows use "Indexadas" — both forms are in LOCALE_LABELS.
    const [indexedRes, notIndexedRes] = await Promise.all([
        ni.evaluate(r.sessionId, readMetricTileScript('indexed'), r.tabId),
        ni.evaluate(r.sessionId, readMetricTileScript('notIndexed'), r.tabId),
    ]);
    const metrics = {
        result: {
            indexed: indexedRes.result ?? null,
            notIndexed: notIndexedRes.result ?? null,
        },
    };
    const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId);
    const reasons = (tableRes.result || { rows: [] });
    if (args.reason) {
        // Click row matching reason name
        const click = await ni.evaluate(r.sessionId, `(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
        const target = rows.find(row => (row.textContent || '').toLowerCase().includes(${JSON.stringify(args.reason.toLowerCase())}));
        if (target) {
          const link = target.querySelector('a, button, [role="link"]');
          (link || target).click();
          return true;
        }
        return false;
      })()`, r.tabId);
        if (!click.result)
            return text(`Reason not found: "${args.reason}". Available reasons:\n${JSON.stringify(reasons.rows, null, 2)}`);
        // Wait for either URL change to a drilldown OR a new grid with a URL
        // column to appear — fixed waits race the SPA load.
        await pollFor(r, `(() => {
        if (location.search.includes('issue=') || location.pathname.includes('/drilldown')) return true;
        const grids = document.querySelectorAll('[role="grid"], [role="table"]');
        for (const g of grids) {
          const heads = Array.from(g.querySelectorAll('[role="columnheader"], th')).map(c => (c.textContent || '').trim());
          if (heads.some(h => /^URL$/i.test(h))) return true;
        }
        return null;
      })()`, 8000, 400);
        await wait(400);
        // Tag the last grid (drilldown panel renders below summary) so the
        // shared TABLE_EXTRACTOR_SCRIPT can scope to it via a unique selector.
        await ni.evaluate(r.sessionId, `(() => {
        document.querySelectorAll('[data-gsc-drilldown="1"]').forEach(n => n.removeAttribute('data-gsc-drilldown'));
        const grids = document.querySelectorAll('[role="grid"], [role="table"], table');
        if (grids.length === 0) return false;
        grids[grids.length - 1].setAttribute('data-gsc-drilldown', '1');
        return true;
      })()`, r.tabId);
        const examples = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[data-gsc-drilldown="1"]'), r.tabId);
        const examplesResult = examples.result || (await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"]'), r.tabId)).result;
        return text(JSON.stringify({ metrics: metrics.result, reason: args.reason, examples: examplesResult }, null, 2));
    }
    return text(JSON.stringify({ metrics: metrics.result, reasons: reasons.rows }, null, 2));
}
// ── gsc_pages_validate_fix ────────────────────────────────────
export const gscPagesValidateFixSchema = {
    reason: z.string().describe('Reason name for which to start a "Validate fix" run (e.g. "Server error (5xx)").'),
    property: z.string().optional(),
    sessionId: z.string().optional(),
    tabId,
};
export const gscPagesValidateFixDescription = '[mutating — starts a Google validation cycle] Open a Pages-report reason bucket and click "Validate fix" so Google re-checks the URLs. Returns confirmation status.';
export async function handleGscPagesValidateFix(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    await handleGscPagesReport({ reason: args.reason, property: args.property, sessionId: args.sessionId, tabId: args.tabId });
    const click = await ni.evaluate(r.sessionId, `(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const v = btns.find(b => /validate\\s*fix|validar\\s*correção/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      if (v) { v.click(); return true; }
      return false;
    })()`, r.tabId);
    if (!click.result)
        return text('"Validate fix" button not found — reason may not support validation, or all issues already fixed.');
    const result = await pollFor(r, `(() => {
      const txt = document.body.innerText;
      if (/Validation started|Validação iniciada|We've started validating/i.test(txt)) return { started: true };
      if (/Validation already in progress|já em andamento/i.test(txt)) return { started: false, reason: 'already_running' };
      return null;
    })()`, 20000, 600);
    return text(`Validate fix:\n${JSON.stringify(result || { started: false, reason: 'no_confirmation' }, null, 2)}`);
}
// ── gsc_videos_report ─────────────────────────────────────────
export const gscVideosReportSchema = {
    property: z.string().optional(),
    sessionId: z.string().optional(),
    tabId,
};
export const gscVideosReportDescription = 'Read the Video indexing report — same shape as gsc_pages_report but for video pages.';
export async function handleGscVideosReport(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    const prop = args.property || (await currentProperty(r));
    if (!prop)
        return text('No active property.');
    const nav = await safeNavigate(r, `${GSC_BASE}/video-index?resource_id=${encodeProperty(prop)}`);
    if (nav.error)
        return text(`Navigation failed: ${nav.error}`);
    // Wait for either grid or no-data marker rather than only the grid.
    await pollFor(r, `(() => (document.querySelector('[role="grid"], [role="table"]') || /no data|nenhum dado|no video pages|nenhuma página de vídeo/i.test(document.body.innerText)) ? true : null)()`, 20000, 500);
    await wait(800);
    const [indexedRes, notIndexedRes, tableRes] = await Promise.all([
        ni.evaluate(r.sessionId, readMetricTileScript('indexed'), r.tabId),
        ni.evaluate(r.sessionId, readMetricTileScript('notIndexed'), r.tabId),
        ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId),
    ]);
    const metrics = {
        indexed: indexedRes.result ?? null,
        notIndexed: notIndexedRes.result ?? null,
    };
    const issues = tableRes.result;
    if (!issues && metrics.indexed === null && metrics.notIndexed === null) {
        return text(JSON.stringify({ metrics: { indexed: '0', notIndexed: '0' }, issues: { headers: [], rows: [] }, status: 'no_data' }, null, 2));
    }
    return text(JSON.stringify({ metrics, issues: issues || { headers: [], rows: [] } }, null, 2));
}
// ── gsc_sitemap ───────────────────────────────────────────────
export const gscSitemapSchema = {
    action: z.enum(['list', 'submit', 'delete', 'view_errors']),
    url: z.string().optional().describe('Sitemap URL (relative or absolute) for submit/delete/view_errors.'),
    property: z.string().optional(),
    sessionId: z.string().optional(),
    tabId,
};
export const gscSitemapDescription = 'Manage sitemaps. action=list returns all submitted sitemaps; action=submit adds a sitemap (mutating); ' +
    'action=delete removes one (mutating); action=view_errors opens the per-sitemap detail and returns issues.';
export async function handleGscSitemap(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    const prop = args.property || (await currentProperty(r));
    if (!prop)
        return text('No active property.');
    const nav = await safeNavigate(r, `${GSC_BASE}/sitemaps?resource_id=${encodeProperty(prop)}`);
    if (nav.error)
        return text(`Navigation failed: ${nav.error}`);
    // Bump from 15s → 30s; sitemaps page often blocks past domcontentloaded.
    await pollFor(r, `(() => document.querySelector('[role="grid"], [role="table"], input[type="text"]') ? true : null)()`, 30000, 500);
    await wait(700);
    if (args.action === 'list') {
        const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId);
        return text(JSON.stringify(tableRes.result, null, 2));
    }
    if (args.action === 'submit') {
        if (!args.url)
            return text('url required for submit.');
        await ni.evaluate(r.sessionId, `(() => { const i = document.querySelector('input[type="text"], input:not([type])'); if (i) { i.focus(); i.value = ${JSON.stringify(args.url)}; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`, r.tabId);
        await wait(300);
        await ni.evaluate(r.sessionId, `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const sub = btns.find(b => /submit|enviar/i.test(b.textContent || '')); if (sub) sub.click(); })()`, r.tabId);
        const result = await pollFor(r, `(() => {
        const txt = document.body.innerText;
        if (/Sitemap submitted|Mapa do site enviado|Success/i.test(txt)) return { submitted: true };
        if (/Couldn't read|Não foi possível ler|error|erro/i.test(txt)) return { submitted: false, error: 'parse_failure' };
        return null;
      })()`, 30000, 800);
        return text(`Sitemap submit:\n${JSON.stringify(result || { submitted: false, error: 'no_confirmation' }, null, 2)}`);
    }
    if (args.action === 'delete') {
        if (!args.url)
            return text('url required for delete.');
        const click = await ni.evaluate(r.sessionId, `(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
        const row = rows.find(r => (r.textContent || '').includes(${JSON.stringify(args.url)}));
        if (!row) return false;
        const link = row.querySelector('a, button');
        (link || row).click();
        return true;
      })()`, r.tabId);
        if (!click.result)
            return text(`Sitemap not found: ${args.url}`);
        await wait(1500);
        await ni.evaluate(r.sessionId, `(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const more = btns.find(b => (b.getAttribute('aria-label') || '').match(/more|menu|mais opções/i));
        if (more) more.click();
      })()`, r.tabId);
        await wait(500);
        await ni.evaluate(r.sessionId, `(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"], button, [role="button"]'));
        const del = items.find(i => /remove\\s*sitemap|delete|excluir|remover/i.test(i.textContent || ''));
        if (del) del.click();
      })()`, r.tabId);
        await wait(800);
        await ni.evaluate(r.sessionId, `(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const conf = btns.find(b => /^(remove|delete|excluir|remover)$/i.test((b.textContent || '').trim()));
        if (conf) conf.click();
      })()`, r.tabId);
        return text(`Delete requested for sitemap: ${args.url}.`);
    }
    if (args.action === 'view_errors') {
        if (!args.url)
            return text('url required for view_errors.');
        await ni.evaluate(r.sessionId, `(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
        const row = rows.find(r => (r.textContent || '').includes(${JSON.stringify(args.url)}));
        if (row) { const link = row.querySelector('a'); (link || row).click(); }
      })()`, r.tabId);
        await wait(2500);
        const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId);
        return text(JSON.stringify(tableRes.result, null, 2));
    }
    return text(`Unknown action: ${args.action}`);
}
// ── gsc_removals ──────────────────────────────────────────────
export const gscRemovalsSchema = {
    action: z.enum(['list_temporary', 'list_outdated', 'list_safesearch', 'new']),
    removalType: z.enum(['temporary', 'outdated_content', 'safe_search']).optional().describe('Required for action=new.'),
    target: z.string().optional().describe('URL or prefix for action=new.'),
    scope: z.enum(['url', 'prefix']).optional().describe('For action=new + temporary: remove only this URL or all URLs starting with this prefix.'),
    property: z.string().optional(),
    sessionId: z.string().optional(),
    tabId,
};
export const gscRemovalsDescription = 'Manage URL removals. list_* returns existing requests; ' +
    'action=new submits a new removal (mutating). ' +
    'removalType: temporary (6-month hide), outdated_content (refresh Google\'s cached version), safe_search (report adult content).';
export async function handleGscRemovals(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    const prop = args.property || (await currentProperty(r));
    if (!prop)
        return text('No active property.');
    const nav = await safeNavigate(r, `${GSC_BASE}/removals?resource_id=${encodeProperty(prop)}`);
    if (nav.error)
        return text(`Navigation failed: ${nav.error}`);
    await pollFor(r, `(() => document.querySelector('[role="tab"], [role="grid"], button') ? true : null)()`, 15000, 400);
    await wait(700);
    const tabMap = {
        list_temporary: /Temporary|Temporárias/i,
        list_outdated: /Outdated|Conteúdo desatualizado/i,
        list_safesearch: /SafeSearch/i,
    };
    if (args.action.startsWith('list_')) {
        const re = tabMap[args.action];
        await ni.evaluate(r.sessionId, `(() => { const t = Array.from(document.querySelectorAll('[role="tab"]')).find(t => ${re.toString()}.test(t.textContent || '')); if (t) t.click(); })()`, r.tabId);
        await wait(1500);
        const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId);
        const t = (tableRes.result || { headers: [], rows: [] });
        // Empty-state placeholder filter: GSC renders a single row pointing at
        // the no-op `#` URL when there are no requests in the active tab.
        t.rows = t.rows.filter(row => {
            const keys = Object.keys(row);
            if (keys.length === 1 && row.url === 'https://search.google.com/#')
                return false;
            return true;
        });
        if (t.rows.length === 0) {
            return text(JSON.stringify({ ...t, status: 'no_requests' }, null, 2));
        }
        return text(JSON.stringify(t, null, 2));
    }
    if (args.action === 'new') {
        if (!args.removalType || !args.target)
            return text('removalType and target required for action=new.');
        await ni.evaluate(r.sessionId, `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const n = btns.find(b => /new\\s*request|nova\\s*solicitação/i.test(b.textContent || '')); if (n) n.click(); })()`, r.tabId);
        await wait(1200);
        // Click the right type tab inside the dialog
        const typeRe = {
            temporary: /Temporarily remove|Remover\\s*temporariamente/i,
            outdated_content: /Outdated|Desatualizado/i,
            safe_search: /SafeSearch/i,
        };
        const tre = typeRe[args.removalType];
        await ni.evaluate(r.sessionId, `(() => { const tabs = Array.from(document.querySelectorAll('[role="tab"], button, [role="button"]')); const t = tabs.find(t => ${tre.toString()}.test(t.textContent || '')); if (t) t.click(); })()`, r.tabId);
        await wait(700);
        // Fill URL input
        await ni.evaluate(r.sessionId, `(() => { const i = document.querySelector('input[type="text"], input[type="url"]'); if (i) { i.focus(); i.value = ${JSON.stringify(args.target)}; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`, r.tabId);
        await wait(300);
        // For temporary + prefix, click the prefix radio
        if (args.removalType === 'temporary' && args.scope === 'prefix') {
            await ni.evaluate(r.sessionId, `(() => { const radios = Array.from(document.querySelectorAll('[role="radio"], input[type="radio"]')); const p = radios.find(r => /prefix|prefixo|all\\s*URLs/i.test(r.closest('label')?.textContent || r.parentElement?.textContent || '')); if (p) p.click(); })()`, r.tabId);
        }
        await ni.evaluate(r.sessionId, `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const n = btns.find(b => /^(next|próximo|continue)$/i.test((b.textContent || '').trim())); if (n) n.click(); })()`, r.tabId);
        await wait(800);
        await ni.evaluate(r.sessionId, `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const sub = btns.find(b => /^(submit\\s*request|submit|enviar)$/i.test((b.textContent || '').trim())); if (sub) sub.click(); })()`, r.tabId);
        const result = await pollFor(r, `(() => {
        const txt = document.body.innerText;
        if (/Request submitted|Solicitação enviada|Status:\\s*(Pending|Pendente|In progress)/i.test(txt)) return { submitted: true };
        if (/Couldn't|Não foi possível|error|erro/i.test(txt)) return { submitted: false, error: 'submit_failed' };
        return null;
      })()`, 30000, 800);
        return text(`Removal request:\n${JSON.stringify(result || { submitted: false, error: 'no_confirmation' }, null, 2)}`);
    }
    return text(`Unknown action: ${args.action}`);
}
// ── gsc_removals_cancel ───────────────────────────────────────
export const gscRemovalsCancelSchema = {
    url: z.string().describe('URL of the removal request to cancel (must match exactly as listed).'),
    property: z.string().optional(),
    sessionId: z.string().optional(),
    tabId,
};
export const gscRemovalsCancelDescription = '[mutating] Cancel a pending temporary removal request. URL must match the listed entry exactly.';
export async function handleGscRemovalsCancel(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    await handleGscRemovals({ action: 'list_temporary', property: args.property, sessionId: args.sessionId, tabId: args.tabId });
    const click = await ni.evaluate(r.sessionId, `(() => {
      const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
      const row = rows.find(r => (r.textContent || '').includes(${JSON.stringify(args.url)}));
      if (!row) return false;
      const more = row.querySelector('[aria-label*="more" i], [aria-label*="opções" i], button');
      if (more) more.click();
      return true;
    })()`, r.tabId);
    if (!click.result)
        return text(`Removal request not found: ${args.url}`);
    await wait(500);
    await ni.evaluate(r.sessionId, `(() => { const items = Array.from(document.querySelectorAll('[role="menuitem"], button')); const c = items.find(i => /cancel|cancelar/i.test(i.textContent || '')); if (c) c.click(); })()`, r.tabId);
    await wait(800);
    await ni.evaluate(r.sessionId, `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const conf = btns.find(b => /^(cancel\\s*request|cancel|cancelar)$/i.test((b.textContent || '').trim())); if (conf) conf.click(); })()`, r.tabId);
    return text(`Cancellation requested for ${args.url}.`);
}
//# sourceMappingURL=indexing.js.map