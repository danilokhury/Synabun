import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
// ── browser_navigate ──
export const browserNavigateSchema = {
    url: z.string().describe('The URL to navigate to.'),
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session or creates a new one.'),
};
export const browserNavigateDescription = 'Navigate the browser to a URL. If no browser session exists, one is created automatically.';
export async function handleBrowserNavigate(args) {
    const resolved = await ni.resolveSession(args.sessionId, { url: args.url });
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.navigate(resolved.sessionId, args.url);
    if (result.error)
        return { content: [{ type: 'text', text: `Navigation failed: ${result.error}` }] };
    return {
        content: [{ type: 'text', text: `Navigated to ${result.url} — "${result.title}"` }],
    };
}
// ── browser_go_back ──
export const browserGoBackSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserGoBackDescription = 'Go back to the previous page in browser history.';
export async function handleBrowserGoBack(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.goBack(resolved.sessionId);
    if (result.error)
        return { content: [{ type: 'text', text: `Go back failed: ${result.error}` }] };
    return {
        content: [{ type: 'text', text: `Went back to ${result.url} — "${result.title}"` }],
    };
}
// ── browser_go_forward ──
export const browserGoForwardSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserGoForwardDescription = 'Go forward to the next page in browser history.';
export async function handleBrowserGoForward(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.goForward(resolved.sessionId);
    if (result.error)
        return { content: [{ type: 'text', text: `Go forward failed: ${result.error}` }] };
    return {
        content: [{ type: 'text', text: `Went forward to ${result.url} — "${result.title}"` }],
    };
}
// ── browser_reload ──
export const browserReloadSchema = {
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};
export const browserReloadDescription = 'Reload the current page. Useful after making changes or when content is stale.';
export async function handleBrowserReload(args) {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved)
        return { content: [{ type: 'text', text: resolved.error }] };
    const result = await ni.reload(resolved.sessionId);
    if (result.error)
        return { content: [{ type: 'text', text: `Reload failed: ${result.error}` }] };
    return {
        content: [{ type: 'text', text: `Reloaded — now at ${result.url} "${result.title}"` }],
    };
}
//# sourceMappingURL=browser-navigate.js.map