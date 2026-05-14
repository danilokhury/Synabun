import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
import { formatInlineSnapshot } from './browser-observe.js';
const tabIdField = z.string().optional().describe('Target a specific tab within the session. Auto-resolved from environment if omitted.');
const returnSnapshotField = z.object({
    mode: z.enum(['full', 'interactive', 'landmarks']).optional(),
    selector: z.string().optional(),
    viewport: z.boolean().optional(),
    maxChars: z.number().int().positive().optional(),
    format: z.enum(['text', 'json']).optional(),
}).optional().describe('If set, the server also captures a snapshot after the action and returns it in the same response — one round-trip instead of two. Matches browser_snapshot params.');
function formatBrowserLocation(result, action) {
    if (ni.isBrowserCompactMode()) {
        const title = typeof result.title === 'string' && result.title ? ` "${result.title}"` : '';
        return `${action}${title}`;
    }
    return `${action} ${result.url} — "${result.title}"`;
}
// ── browser_navigate ──
export const browserNavigateSchema = {
    url: z.string().describe('The URL to navigate to.'),
    returnSnapshot: returnSnapshotField,
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session or creates a new one.'),
    tabId: tabIdField,
};
export const browserNavigateDescription = 'Navigate the browser to a URL. If no browser session exists, one is created automatically. Pass returnSnapshot to fold a browser_snapshot into the same call.';
export async function handleBrowserNavigate(args) {
    const resolved = await ni.resolveSession(args.sessionId, { url: args.url }, args.tabId);
    if ('error' in resolved)
        return text(resolved.error);
    const rs = args.returnSnapshot ? {
        mode: args.returnSnapshot.mode,
        selector: args.returnSnapshot.selector,
        viewport: args.returnSnapshot.viewport,
    } : undefined;
    const result = await ni.navigate(resolved.sessionId, args.url, resolved.tabId, rs);
    if (result.error)
        return text(`Navigation failed: ${result.error}`);
    let msg = formatBrowserLocation(result, 'Navigated');
    if (args.returnSnapshot) {
        const snap = formatInlineSnapshot(result, {
            mode: args.returnSnapshot.mode,
            format: args.returnSnapshot.format,
            maxChars: args.returnSnapshot.maxChars,
        });
        msg += `\n\n--- Snapshot (${args.returnSnapshot.mode || 'full'}) ---\n${snap}`;
    }
    return text(msg);
}
// ── browser_go_back ──
export const browserGoBackSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
    tabId: tabIdField,
};
export const browserGoBackDescription = 'Go back to the previous page in browser history.';
export async function handleBrowserGoBack(args) {
    const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.goBack(resolved.sessionId, resolved.tabId);
    if (result.error)
        return text(`Go back failed: ${result.error}`);
    return text(formatBrowserLocation(result, 'Went back to'));
}
// ── browser_go_forward ──
export const browserGoForwardSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
    tabId: tabIdField,
};
export const browserGoForwardDescription = 'Go forward to the next page in browser history.';
export async function handleBrowserGoForward(args) {
    const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.goForward(resolved.sessionId, resolved.tabId);
    if (result.error)
        return text(`Go forward failed: ${result.error}`);
    return text(formatBrowserLocation(result, 'Went forward to'));
}
// ── browser_reload ──
export const browserReloadSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
    tabId: tabIdField,
};
export const browserReloadDescription = 'Reload the current page. Useful after making changes or when content is stale.';
export async function handleBrowserReload(args) {
    const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
    if ('error' in resolved)
        return text(resolved.error);
    const result = await ni.reload(resolved.sessionId, resolved.tabId);
    if (result.error)
        return text(`Reload failed: ${result.error}`);
    return text(formatBrowserLocation(result, 'Reloaded'));
}
//# sourceMappingURL=browser-navigate.js.map