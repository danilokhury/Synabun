/**
 * Google Search Console — shared helpers.
 *
 * GSC paths use English slugs regardless of UI locale; selectors prefer
 * material-icon ligatures, stable aria roles, and structural anchors over
 * translated label text. The locale dictionary below centralises label
 * matching across en + pt-BR so report parsers stay locale-tolerant.
 */
import * as ni from '../../services/neural-interface.js';
export const GSC_BASE = 'https://search.google.com/search-console';
export async function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export async function resolve(sessionId, tabId, autoCreate = true) {
    const r = await ni.resolveSession(sessionId, autoCreate ? { url: GSC_BASE } : undefined, tabId);
    if ('error' in r)
        return r;
    return { sessionId: r.sessionId, tabId: r.tabId };
}
/** URL-encoded `resource_id` segment for use in any GSC URL. */
export function encodeProperty(property) {
    return encodeURIComponent(property);
}
/**
 * Read the current property from the URL bar (`?resource_id=…`).
 * Returns null if not on a GSC page or property missing.
 */
export async function currentProperty(r) {
    const res = await ni.evaluate(r.sessionId, `(() => { const u = new URL(location.href); return u.searchParams.get('resource_id'); })()`, r.tabId);
    if (res.error)
        return null;
    return res.result || null;
}
/**
 * Build a GSC URL for `path` keeping the active `resource_id` in the query.
 * Pass an explicit `property` to override.
 */
export async function gscUrl(r, path, property) {
    const prop = property || (await currentProperty(r)) || '';
    const sep = path.includes('?') ? '&' : '?';
    return `${GSC_BASE}${path}${prop ? `${sep}resource_id=${encodeProperty(prop)}` : ''}`;
}
/**
 * Verify session is on accounts.google.com — caller must be signed in.
 * Returns error string if redirected to login, otherwise null.
 */
export async function ensureAuth(r) {
    const res = await ni.evaluate(r.sessionId, `location.href`, r.tabId);
    const url = String(res.result || '');
    if (/accounts\.google\.com/.test(url)) {
        return 'Not authenticated. Sign into the Google account that owns the GSC property in the open browser, then retry.';
    }
    return null;
}
/**
 * Poll a JS predicate every `interval` ms until it returns truthy.
 * `script` MUST evaluate to JSON-serializable value; truthy → success,
 * `null`/`undefined`/`false` → keep polling. Returns last value or null on timeout.
 */
export async function pollFor(r, script, timeoutMs = 30000, interval = 400) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        const res = await ni.evaluate(r.sessionId, script, r.tabId);
        if (!res.error) {
            const v = res.result;
            if (v)
                return v;
            last = v;
        }
        await wait(interval);
    }
    return last;
}
// ── Locale-tolerant label dictionary ─────────────────────────────
// Lists per-locale forms for canonical metric keys. Used by metricRegex and
// readMetricTileScript to recognise GSC labels in en + pt-BR without ad-hoc
// alternations scattered through every handler.
export const LOCALE_LABELS = {
    totalClicks: ['Total clicks', 'Total de cliques', 'Cliques totais', 'Cliques'],
    totalImpressions: ['Total impressions', 'Total de impressões', 'Impressões totais', 'Impressões'],
    avgCTR: ['Average CTR', 'CTR médio', 'CTR média'],
    avgPosition: ['Average position', 'Posição média'],
    indexed: ['Pages indexed', 'Páginas indexadas', 'Indexadas', 'Indexados', 'Indexed'],
    notIndexed: ['Pages not indexed', 'Páginas não indexadas', 'Não indexadas', 'Não indexados', 'Not indexed'],
    valid: ['Valid', 'Válido', 'Válidos', 'Válidas', 'Itens válidos', 'Entidades válidas'],
    warnings: ['Warning', 'Warnings', 'Aviso', 'Avisos'],
    errors: ['Error', 'Errors', 'Erro', 'Erros', 'Entidades inválidas'],
    good: ['Good URLs', 'Good', 'Boas', 'Bons', 'URLs boas'],
    needsImprovement: [
        'Need improvement',
        'Needs improvement',
        'Precisa de melhorias',
        'Precisam de melhorias',
        'Melhorias necessárias',
    ],
    poor: ['Poor URLs', 'Poor', 'Ruins'],
    httpsUrls: ['HTTPS URLs', 'HTTPS'],
    nonHttpsUrls: ['Non-HTTPS URLs', 'Non HTTPS', 'Não HTTPS', 'HTTP'],
    totalRequests: [
        'Total crawl requests',
        'Total de solicitações de rastreamento',
        'Solicitações de rastreamento',
        'Crawl requests',
    ],
    totalDownloadSize: ['Total download size', 'Tamanho total do download'],
    avgResponseTime: ['Average response time', 'Tempo médio de resposta'],
};
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Build a single combined regex (case-insensitive) matching any locale form for `key`. */
export function metricRegex(key) {
    const list = LOCALE_LABELS[key] || [];
    if (list.length === 0)
        return /(?!)/;
    // Sort longest-first so multi-word labels match before single-word substrings.
    const alt = [...list].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
    return new RegExp(alt, 'i');
}
/**
 * Build a JS source string that finds a metric tile by label and returns
 * the FIRST numeric value within the tile (not all numbers in the parent).
 *
 * The tile is detected by walking up from the matched label node to the
 * smallest ancestor that also contains a numeric child — which mirrors the
 * GSC metric-card structure (label + big number stacked).
 */
export function readMetricTileScript(key) {
    const list = LOCALE_LABELS[key] || [];
    const alt = [...list].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
    if (!alt)
        return `(() => null)()`;
    return `(() => {
    const re = new RegExp(${JSON.stringify(alt)}, 'i');
    const exact = new RegExp('^\\\\s*(?:' + ${JSON.stringify(alt)} + ')\\\\s*[:：]?\\\\s*$', 'i');
    const numRe = /-?\\d[\\d.,]*\\s*%?/;
    const candidates = Array.from(document.querySelectorAll('div, span, p, dt, label, h2, h3, td, th'));
    // Prefer exact-match label nodes (e.g. "Total de cliques") to avoid grabbing
    // body paragraphs that mention the term in passing.
    const labels = candidates.filter(n => exact.test((n.textContent || '').trim()));
    const fallback = candidates.filter(n => re.test(n.textContent || ''));
    const nodes = labels.length ? labels : fallback.slice(0, 6);
    for (const node of nodes) {
      let cur = node;
      for (let depth = 0; cur && depth < 6; depth++, cur = cur.parentElement) {
        const txt = (cur.innerText || cur.textContent || '');
        if (re.test(txt) && numRe.test(txt)) {
          // Strip the label so we don't pick up digits inside it.
          const stripped = txt.replace(re, ' ');
          const m = stripped.match(numRe);
          if (m) return m[0].trim();
        }
      }
    }
    return null;
  })()`;
}
/**
 * Extract a GSC accessibility-tree grid as `{ headers, rows }`.
 * `scopeSelector` should target a `[role="grid"]` or its container.
 *
 * - Strips nested tooltip/icon text from header cells (GSC often inlines a
 *   help-icon tooltip into the column header textContent).
 * - Header fallback: when no `[role="columnheader"]`/`th` exists, treats the
 *   first body row as the header row (some report tables are pure tr-based).
 * - List fallback: when no grid/table is found, attempts to extract rows from
 *   `[role="listitem"]`/`mat-list-item`/`li` cards in the scope.
 */
export const TABLE_EXTRACTOR_SCRIPT = (scope) => `(() => {
    const root = document.querySelector(${JSON.stringify(scope)}) || document;
    const stripText = (el) => {
      if (!el) return '';
      const clone = el.cloneNode(true);
      // Remove tooltip/help-icon clutter that GSC inlines into header cells.
      clone.querySelectorAll('[role="tooltip"], [aria-hidden="true"], .material-icons, .material-icons-extended, .material-icons-outlined, mat-icon, .mdc-tooltip, [class*="tooltip" i], [class*="help-icon" i], [class*="help_outline" i], [data-md-tooltip], gmat-tooltip, gmat-help').forEach(n => n.remove());
      return (clone.textContent || '').trim().replace(/\\s+/g,' ');
    };
    // Prefer aria-label on a columnheader/cell when it exists — it's the
    // canonical column name without inlined tooltip body text.
    const ariaOrText = (el) => {
      if (!el) return '';
      const al = el.getAttribute('aria-label');
      if (al && al.trim() && al.length < 80) return al.trim().replace(/\\s+/g, ' ');
      return stripText(el);
    };
    const grid = root.matches?.('[role="grid"],[role="table"],table') ? root : root.querySelector('[role="grid"],[role="table"],table');
    if (grid) {
      let headers = [];
      const headerRow = grid.querySelector('[role="row"]:has([role="columnheader"]), thead tr');
      if (headerRow) {
        headers = Array.from(headerRow.querySelectorAll('[role="columnheader"], th')).map(ariaOrText);
      }
      let bodyRows = Array.from(grid.querySelectorAll('[role="row"]:not(:has([role="columnheader"])), tbody tr'));
      if (bodyRows.length === 0) bodyRows = Array.from(grid.querySelectorAll('[role="row"], tr'));
      // Header fallback: if no columnheader row, promote the first body row.
      if (headers.length === 0 && bodyRows.length > 0) {
        const first = bodyRows[0];
        headers = Array.from(first.querySelectorAll('[role="gridcell"], [role="cell"], td, th, [role="columnheader"]')).map(stripText);
        bodyRows = bodyRows.slice(1);
      }
      const rows = bodyRows.map(tr => {
        const cells = Array.from(tr.querySelectorAll('[role="gridcell"], [role="cell"], td')).map(stripText);
        const link = tr.querySelector('a[href]')?.href || null;
        const obj = {};
        cells.forEach((v, i) => { obj[headers[i] || ('col' + i)] = v; });
        if (link && link !== 'https://search.google.com/#') obj.url = link;
        // Drop rows that just echo the header labels (some grids re-render
        // the header inside the body when no data rows exist).
        const isHeaderEcho = headers.length > 0 && Object.values(obj).every(v =>
          !v || (headers.some(h => h && String(v).trim() === String(h).trim())));
        if (isHeaderEcho) return null;
        return obj;
      }).filter(r => r && Object.values(r).some(v => v && String(v).trim()));
      return { headers, rows };
    }
    // List fallback (e.g. Users page renders mat-list cards instead of a grid).
    const items = Array.from(root.querySelectorAll('[role="listitem"], mat-list-item, li'));
    if (items.length === 0) return null;
    const rows = items.map(li => {
      const text = stripText(li);
      const link = li.querySelector('a[href]')?.href || null;
      const obj = { text };
      if (link) obj.url = link;
      return obj;
    }).filter(r => r.text && r.text.length > 0 && r.text.length < 400);
    return rows.length > 0 ? { headers: [], rows } : null;
  })()`;
/**
 * Navigate with a one-time retry on Playwright timeout. GSC's first paint
 * occasionally exceeds the underlying 15s `domcontentloaded` budget; a
 * second attempt almost always succeeds.
 */
export async function safeNavigate(r, url) {
    let res = await ni.navigate(r.sessionId, url, r.tabId);
    if (res.error && /Timeout/i.test(res.error)) {
        await wait(500);
        res = await ni.navigate(r.sessionId, url, r.tabId);
    }
    return res;
}
/** Click a sidebar nav item by its material-icon ligature (locale-independent). */
export async function clickSidebarIcon(r, iconText) {
    const res = await ni.evaluate(r.sessionId, `(() => {
      const els = Array.from(document.querySelectorAll('.material-icons, .material-icons-extended, [class*="icon"]'));
      for (const el of els) {
        if (el.textContent.trim() === ${JSON.stringify(iconText)}) {
          const link = el.closest('a, [role="link"], [role="button"], button');
          if (link) { link.click(); return true; }
        }
      }
      return false;
    })()`, r.tabId);
    if (res.error)
        return { ok: false, error: res.error };
    return { ok: !!res.result };
}
//# sourceMappingURL=helpers.js.map