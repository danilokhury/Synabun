/**
 * GSC navigation + property management.
 * Tools: gsc_navigate, gsc_property
 */
import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { GSC_BASE, encodeProperty, currentProperty, ensureAuth, resolve, wait, pollFor, safeNavigate } from './helpers.js';
const tabId = z.string().optional().describe('Target a specific tab. Auto-resolved if omitted.');
// ── PAGE MAP ──────────────────────────────────────────────────
// Path keys are stable English slugs in GSC URLs regardless of UI locale.
const PAGE_PATHS = {
    overview: '',
    insights: '/performance/insights',
    performance_search: '/performance/search-analytics',
    performance_discover: '/performance/discover',
    performance_news: '/performance/google-news',
    inspect: '/inspect',
    pages: '/index',
    videos: '/video-index',
    sitemaps: '/sitemaps',
    removals: '/removals',
    cwv_mobile: '/core-web-vitals?device=MOBILE',
    cwv_desktop: '/core-web-vitals?device=DESKTOP',
    https: '/https',
    security: '/security-issues',
    manual_actions: '/manual-actions',
    enhancements_breadcrumbs: '/r/breadcrumbs',
    enhancements_faq: '/r/faq',
    enhancements_sitelinks: '/r/sitelinks-search-box',
    enhancements_videos: '/r/videos',
    enhancements_products: '/r/product-snippets',
    enhancements_recipes: '/r/recipes',
    enhancements_review: '/r/review-snippets',
    enhancements_events: '/r/events',
    enhancements_jobposting: '/r/job-postings',
    enhancements_speakable: '/r/speakable',
    enhancements_qa: '/r/q-a',
    enhancements_logos: '/r/logos',
    enhancements_sitenames: '/r/sitenames',
    enhancements_dataset: '/r/dataset',
    enhancements_practice: '/r/practice-problems',
    enhancements_math: '/r/math-solvers',
    enhancements_video_indexing: '/r/video-indexing',
    links: '/links',
    achievements: '/achievements',
    settings: '/settings',
    crawl_stats: '/settings/crawl-stats',
    users: '/users',
    change_address: '/settings/change-address',
    associations: '/settings/associations',
    disavow: 'https://search.google.com/search-console/disavow-links',
    shopping: '/r/shopping-list',
    merchant: '/r/merchant-listings',
};
const PAGE_KEYS = Object.keys(PAGE_PATHS);
// ── gsc_navigate ──────────────────────────────────────────────
export const gscNavigateSchema = {
    page: z.enum(PAGE_KEYS).describe('GSC section to open. Property is preserved from current resource_id unless `property` is set.'),
    property: z.string().optional().describe('Property to load (e.g. "sc-domain:example.com" or "https://example.com/"). Defaults to active property.'),
    sessionId: z.string().optional().describe('Browser session ID. Auto-resolved or auto-created.'),
    tabId,
};
export const gscNavigateDescription = 'Open a Google Search Console page (overview, performance, inspect, pages, sitemaps, removals, links, security, settings, etc.). Always call before any gsc_* tool to land on the right report. ' +
    `Pages: ${PAGE_KEYS.join(', ')}.`;
export async function handleGscNavigate(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    if (!(args.page in PAGE_PATHS))
        return text(`Unknown page: ${args.page}`);
    const path = PAGE_PATHS[args.page];
    const isAbs = path.startsWith('http');
    const prop = args.property || (await currentProperty(r));
    const sep = (p) => (p.includes('?') ? '&' : '?');
    let url;
    if (isAbs) {
        url = prop ? `${path}${sep(path)}resource_id=${encodeProperty(prop)}` : path;
    }
    else {
        url = `${GSC_BASE}${path}${prop ? `${sep(path)}resource_id=${encodeProperty(prop)}` : ''}`;
    }
    const nav = await safeNavigate(r, url);
    if (nav.error)
        return text(`Navigation failed: ${nav.error}`);
    const authErr = await ensureAuth(r);
    if (authErr)
        return text(authErr);
    // Wait for SPA route to finish hydrating
    await pollFor(r, `(() => { const b = document.querySelector('[aria-busy="true"]'); return !b ? location.href : null; })()`, 8000, 300);
    await wait(800);
    return text(`Opened GSC ${args.page} (${url})${prop ? ` for ${prop}` : ''}.`);
}
// ── gsc_property ──────────────────────────────────────────────
export const gscPropertySchema = {
    action: z.enum(['list', 'select', 'current', 'add']).describe('list = enumerate properties from picker; select = switch active property; current = read URL property; add = open Add Property dialog.'),
    property: z.string().optional().describe('Property string (e.g. "sc-domain:example.com" or "https://example.com/") for select. For add: domain or URL prefix value.'),
    type: z.enum(['domain', 'url_prefix']).optional().describe('For add action: property type. Default: domain.'),
    sessionId: z.string().optional(),
    tabId,
};
export const gscPropertyDescription = 'Manage GSC property selection — list registered properties, switch the active one (re-navigates current page), read the active property from the URL, or open the Add Property dialog. ' +
    '[mutating for action=add — adds a new property to the Google account]';
export async function handleGscProperty(args) {
    const r = await resolve(args.sessionId, args.tabId);
    if ('error' in r)
        return text(r.error);
    if (args.action === 'current') {
        const prop = await currentProperty(r);
        return text(prop ? `Active property: ${prop}` : 'No active property — navigate to a GSC page first.');
    }
    if (args.action === 'list') {
        // Open the property picker, scrape items, close.
        const open = await ni.evaluate(r.sessionId, `(() => { const btn = document.querySelector('[aria-label*="property" i], [aria-label*="propriedade" i], [aria-label*="Pesquise" i]'); if (btn) { btn.click(); return true; } return false; })()`, r.tabId);
        if (open.error || !open.result)
            return text('Could not open property picker. Navigate to GSC first.');
        await wait(800);
        const list = await ni.evaluate(r.sessionId, `(() => {
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const items = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li[data-value], mat-option'));
        const out = [];
        for (const el of items) {
          const fullText = norm(el.textContent || '');
          // Skip the "Add property" / "Adicionar propriedade" affordance —
          // covers both prefix forms ("+ Add property") and bare label.
          if (/^(?:Add\\s*propert|Adicionar\\s*propriedade|\\+)/i.test(fullText.trim())) continue;
          if (/(?:^|\\s)(?:Add\\s*property|Adicionar\\s*propriedade)(?:$|\\s)/i.test(fullText)) continue;
          // Read each visible child element separately so the property name and
          // type label aren't concatenated into "synabun.aiPropriedade de domínio".
          const children = Array.from(el.querySelectorAll(':scope > *, :scope > span, :scope > div'))
            .map(c => norm(c.textContent || ''))
            .filter(Boolean);
          // Property string from data-value first; else first child line; else
          // strip the trailing "Propriedade de domínio"/"Domain property" hint.
          let property = el.getAttribute('data-value') || el.getAttribute('value') || (children[0] || fullText);
          if (!el.getAttribute('data-value')) {
            property = property.replace(/\\s*(?:Propriedade de dom[ií]nio|Domain property|Propriedade de prefixo de URL|URL prefix property)\\s*$/i, '').trim();
          }
          if (!property) continue;
          const typeText = children.find(c => /Propriedade de dom[ií]nio|Domain property|prefixo de URL|URL prefix/i.test(c)) || null;
          const type = typeText && /dom[ií]nio|domain/i.test(typeText) ? 'domain'
            : typeText && /prefixo|prefix/i.test(typeText) ? 'url_prefix' : null;
          out.push({ property, type, label: fullText.slice(0, 200) });
        }
        return out;
      })()`, r.tabId);
        // Close picker
        await ni.pressKey(r.sessionId, 'Escape', r.tabId);
        const props = list.result || [];
        if (props.length === 0)
            return text('No properties found in picker.');
        return text(`${props.length} propert${props.length === 1 ? 'y' : 'ies'}:\n${JSON.stringify(props, null, 2)}`);
    }
    if (args.action === 'select') {
        if (!args.property)
            return text('property is required for action=select.');
        // Re-navigate current page with new resource_id
        const url = new URL(`${GSC_BASE}/performance/search-analytics`);
        url.searchParams.set('resource_id', args.property);
        const nav = await safeNavigate(r, url.toString());
        if (nav.error)
            return text(`Switch failed: ${nav.error}`);
        await wait(1500);
        return text(`Switched active property to ${args.property}.`);
    }
    if (args.action === 'add') {
        if (!args.property)
            return text('property is required for action=add (domain or URL prefix value).');
        const open = await ni.evaluate(r.sessionId, `(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const add = btns.find(b => /add\\s*property|adicionar\\s*propriedade|\\+.*propert/i.test(b.textContent || b.getAttribute('aria-label') || ''));
        if (add) { add.click(); return true; }
        return false;
      })()`, r.tabId);
        if (!open.result)
            return text('Could not find Add Property button. Open the property picker first.');
        await wait(1000);
        const fieldType = args.type === 'url_prefix' ? 'url' : 'domain';
        const fill = await ni.evaluate(r.sessionId, `(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])'));
        const target = ${fieldType === 'domain' ? 'inputs[0]' : 'inputs[inputs.length - 1]'};
        if (!target) return false;
        target.focus();
        target.value = ${JSON.stringify(args.property)};
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`, r.tabId);
        if (!fill.result)
            return text('Could not fill property field.');
        await wait(400);
        await ni.evaluate(r.sessionId, `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const cont = btns.find(b => /continue|continuar|verify|verificar/i.test(b.textContent || '')); if (cont) cont.click(); })()`, r.tabId);
        return text(`Add Property dialog filled with ${args.property} (${fieldType}). Verification step requires user interaction.`);
    }
    return text(`Unknown action: ${args.action}`);
}
//# sourceMappingURL=navigate.js.map