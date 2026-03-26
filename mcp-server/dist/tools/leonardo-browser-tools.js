/**
 * Leonardo.ai Browser MCP tools.
 * 100% browser-based — all interaction happens via SynaBun's browser automation.
 * No API key required.
 *
 * Tools: leonardo_browser_navigate, leonardo_browser_generate, leonardo_browser_library, leonardo_browser_download
 */
import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
const LEO_BASE = 'https://app.leonardo.ai';
// ── Helper: resolve or create session ─────────────────────────
async function getSession() {
    const resolved = await ni.resolveSession(undefined, { url: LEO_BASE });
    if ('error' in resolved)
        return null;
    return resolved.sessionId;
}
async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ── Browser Navigate ──────────────────────────────────────────
export const browserNavigateSchema = {
    page: z.enum([
        'home', 'library', 'image', 'video', 'upscaler',
        'blueprints', 'flow-state', 'models',
    ]).describe('Leonardo.ai page to navigate to.'),
};
export const browserNavigateDescription = 'Navigate the browser to a specific Leonardo.ai page. Always use this as the first step before any browser-based generation.';
export async function handleBrowserNavigate(args) {
    const sessionId = await getSession();
    if (!sessionId)
        return text('No browser session available. Open Leonardo.ai in the browser first using browser_navigate or the Apps menu.');
    const paths = {
        'home': '/',
        'library': '/library',
        'image': '/image-generation',
        'video': '/image-generation/video',
        'upscaler': '/universal-upscaler',
        'blueprints': '/blueprints',
        'flow-state': '/flow-state',
        'models': '/models-training',
    };
    const path = paths[args.page] || '/';
    const res = await ni.navigate(sessionId, `${LEO_BASE}${path}`);
    if (res.error)
        return text(`Navigation failed: ${res.error}`);
    // Wait for page to settle
    await wait(3000);
    return text(`Navigated to Leonardo.ai ${args.page} page (${LEO_BASE}${path}). Use browser_snapshot to see the current UI state.`);
}
// ── Browser Generate (full UI automation) ─────────────────────
export const browserGenerateSchema = {
    prompt: z.string().describe('The generation prompt to type into Leonardo.ai.'),
    type: z.enum(['image', 'video']).optional().describe('Generation type. Default: image.'),
};
export const browserGenerateDescription = 'Fill the prompt field and click Generate on the current Leonardo.ai page. Set all other settings (model, style, dimensions, motion controls) BEFORE calling this — use browser_click, browser_fill, and browser_snapshot to configure the UI first. This tool only handles: navigate to correct page if needed → clear & fill prompt → click Generate.';
export async function handleBrowserGenerate(args) {
    const sessionId = await getSession();
    if (!sessionId)
        return text('No browser session available. Open Leonardo.ai first.');
    const genType = args.type || 'image';
    // Check current URL — navigate only if not already on the right page
    const snapshot = await ni.snapshot(sessionId);
    const currentUrl = snapshot?.url || '';
    const targetPath = genType === 'video' ? '/image-generation/video' : '/image-generation';
    if (!currentUrl.includes(targetPath)) {
        const navRes = await ni.navigate(sessionId, `${LEO_BASE}${targetPath}`);
        if (navRes.error)
            return text(`Navigation failed: ${navRes.error}`);
        await wait(3000);
    }
    // Clear and fill the prompt textbox
    const fillRes = await ni.fill(sessionId, '[aria-label="Prompt"], textbox[name="Prompt"], textarea', args.prompt);
    if (fillRes.error)
        return text(`Failed to fill prompt: ${fillRes.error}`);
    await wait(500);
    // Click the Generate button
    const clickRes = await ni.click(sessionId, 'button[aria-label="Generate"], button:has-text("Generate")');
    if (clickRes.error)
        return text(`Failed to click Generate: ${clickRes.error}`);
    return text(`Generation started (${genType}).\n\nPrompt: "${args.prompt.substring(0, 120)}${args.prompt.length > 120 ? '...' : ''}"\n\nThe generation is processing in Leonardo.ai. Use browser_snapshot or browser_screenshot to check progress and see results. Results also appear in the library.`);
}
// ── Browser Library ───────────────────────────────────────────
export const browserLibrarySchema = {
    action: z.enum(['view', 'search']).describe('Action: view (open library) or search (search for a term).'),
    query: z.string().optional().describe('Search query (for search action).'),
};
export const browserLibraryDescription = 'Open or search Leonardo.ai\'s library to view past generations. Use browser_snapshot after to see results.';
export async function handleBrowserLibrary(args) {
    const sessionId = await getSession();
    if (!sessionId)
        return text('No browser session available.');
    const navRes = await ni.navigate(sessionId, `${LEO_BASE}/library`);
    if (navRes.error)
        return text(`Navigation failed: ${navRes.error}`);
    await wait(2000);
    if (args.action === 'search' && args.query) {
        const fillRes = await ni.fill(sessionId, 'input[placeholder*="Search" i]', args.query);
        if (fillRes.error)
            return text(`Failed to search: ${fillRes.error}`);
        await ni.pressKey(sessionId, 'Enter');
        return text(`Searched Leonardo.ai library for: "${args.query}". Use browser_snapshot to see results.`);
    }
    return text('Leonardo.ai library opened. Use browser_snapshot to see recent generations.');
}
// ── Browser Download / Screenshot ─────────────────────────────
export const browserDownloadSchema = {
    action: z.enum(['screenshot']).describe('Action: screenshot (capture current Leonardo.ai page state).'),
};
export const browserDownloadDescription = 'Capture a screenshot of the current Leonardo.ai page. Use to verify generation results or UI state.';
export async function handleBrowserDownload(args) {
    const sessionId = await getSession();
    if (!sessionId)
        return text('No browser session available.');
    if (args.action === 'screenshot') {
        const res = await ni.screenshot(sessionId);
        if (res.error)
            return text(`Screenshot failed: ${res.error}`);
        return text('Screenshot captured of the current Leonardo.ai page.');
    }
    return text(`Unknown action: ${args.action}`);
}
//# sourceMappingURL=leonardo-browser-tools.js.map