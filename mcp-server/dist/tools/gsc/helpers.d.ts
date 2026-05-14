/**
 * Google Search Console — shared helpers.
 *
 * GSC paths use English slugs regardless of UI locale; selectors prefer
 * material-icon ligatures, stable aria roles, and structural anchors over
 * translated label text. The locale dictionary below centralises label
 * matching across en + pt-BR so report parsers stay locale-tolerant.
 */
export declare const GSC_BASE = "https://search.google.com/search-console";
export type Resolved = {
    sessionId: string;
    tabId?: string;
};
export declare function wait(ms: number): Promise<void>;
export declare function resolve(sessionId?: string, tabId?: string, autoCreate?: boolean): Promise<Resolved | {
    error: string;
}>;
/** URL-encoded `resource_id` segment for use in any GSC URL. */
export declare function encodeProperty(property: string): string;
/**
 * Read the current property from the URL bar (`?resource_id=…`).
 * Returns null if not on a GSC page or property missing.
 */
export declare function currentProperty(r: Resolved): Promise<string | null>;
/**
 * Build a GSC URL for `path` keeping the active `resource_id` in the query.
 * Pass an explicit `property` to override.
 */
export declare function gscUrl(r: Resolved, path: string, property?: string): Promise<string>;
/**
 * Verify session is on accounts.google.com — caller must be signed in.
 * Returns error string if redirected to login, otherwise null.
 */
export declare function ensureAuth(r: Resolved): Promise<string | null>;
/**
 * Poll a JS predicate every `interval` ms until it returns truthy.
 * `script` MUST evaluate to JSON-serializable value; truthy → success,
 * `null`/`undefined`/`false` → keep polling. Returns last value or null on timeout.
 */
export declare function pollFor<T = unknown>(r: Resolved, script: string, timeoutMs?: number, interval?: number): Promise<T | null>;
export declare const LOCALE_LABELS: Record<string, string[]>;
/** Build a single combined regex (case-insensitive) matching any locale form for `key`. */
export declare function metricRegex(key: keyof typeof LOCALE_LABELS | string): RegExp;
/**
 * Build a JS source string that finds a metric tile by label and returns
 * the FIRST numeric value within the tile (not all numbers in the parent).
 *
 * The tile is detected by walking up from the matched label node to the
 * smallest ancestor that also contains a numeric child — which mirrors the
 * GSC metric-card structure (label + big number stacked).
 */
export declare function readMetricTileScript(key: keyof typeof LOCALE_LABELS | string): string;
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
export declare const TABLE_EXTRACTOR_SCRIPT: (scope: string) => string;
/**
 * Navigate with a one-time retry on Playwright timeout. GSC's first paint
 * occasionally exceeds the underlying 15s `domcontentloaded` budget; a
 * second attempt almost always succeeds.
 */
export declare function safeNavigate(r: Resolved, url: string): Promise<{
    error?: string;
}>;
/** Click a sidebar nav item by its material-icon ligature (locale-independent). */
export declare function clickSidebarIcon(r: Resolved, iconText: string): Promise<{
    ok: boolean;
    error?: string;
}>;
//# sourceMappingURL=helpers.d.ts.map