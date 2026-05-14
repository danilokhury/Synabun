/**
 * Leonardo.ai Browser MCP tools.
 * 100% browser-based — all interaction happens via SynaBun's browser automation.
 * No API key required.
 *
 * Tools: leonardo_browser_navigate, leonardo_browser_generate, leonardo_browser_library, leonardo_browser_download, leonardo_browser_reference
 */
import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
const tabIdField = z.string().optional().describe('Target a specific tab within the session. Auto-resolved from environment if omitted.');
const LEO_BASE = 'https://app.leonardo.ai';
// ── Helper ────────────────────────────────────────────────────
async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ── Browser Navigate ──────────────────────────────────────────
export const browserNavigateSchema = {
    page: z.enum([
        'home', 'library', 'image', 'video', 'upscaler',
        'blueprints', 'flow-state', 'models',
    ]).describe('Leonardo.ai page to navigate to.'),
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
    tabId: tabIdField,
};
export const browserNavigateDescription = 'Navigate the browser to a specific Leonardo.ai page. Always use this as the first step before any browser-based generation.';
export async function handleBrowserNavigate(args) {
    const resolved = await ni.resolveSession(args.sessionId, { url: LEO_BASE }, args.tabId);
    if ('error' in resolved)
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
    const res = await ni.navigate(resolved.sessionId, `${LEO_BASE}${path}`, resolved.tabId);
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
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
    tabId: tabIdField,
};
export const browserGenerateDescription = 'Fill the prompt field and click Generate on the current Leonardo.ai page. Set all other settings (model, style, dimensions, motion controls) BEFORE calling this — use browser_click, browser_fill, and browser_snapshot to configure the UI first. This tool only handles: navigate to correct page if needed → clear & fill prompt → click Generate.';
export async function handleBrowserGenerate(args) {
    const resolved = await ni.resolveSession(args.sessionId, { url: LEO_BASE }, args.tabId);
    if ('error' in resolved)
        return text('No browser session available. Open Leonardo.ai first.');
    const genType = args.type || 'image';
    // Check current URL — navigate only if not already on the right page
    const snapshot = await ni.snapshot(resolved.sessionId, resolved.tabId);
    const currentUrl = snapshot?.url || '';
    const targetPath = genType === 'video' ? '/image-generation/video' : '/image-generation';
    if (!currentUrl.includes(targetPath)) {
        const navRes = await ni.navigate(resolved.sessionId, `${LEO_BASE}${targetPath}`, resolved.tabId);
        if (navRes.error)
            return text(`Navigation failed: ${navRes.error}`);
        await wait(3000);
    }
    // Clear and fill the prompt textbox
    const fillRes = await ni.fill(resolved.sessionId, '[aria-label="Prompt"], textbox[name="Prompt"], textarea', args.prompt, undefined, resolved.tabId);
    if (fillRes.error)
        return text(`Failed to fill prompt: ${fillRes.error}`);
    await wait(500);
    // Click the Generate button
    const clickRes = await ni.click(resolved.sessionId, 'button[aria-label="Generate"], button:has-text("Generate")', undefined, resolved.tabId);
    if (clickRes.error)
        return text(`Failed to click Generate: ${clickRes.error}`);
    return text(`Generation started (${genType}).\n\nPrompt: "${args.prompt.substring(0, 120)}${args.prompt.length > 120 ? '...' : ''}"\n\nThe generation is processing in Leonardo.ai. Use browser_snapshot or browser_screenshot to check progress and see results. Results also appear in the library.`);
}
// ── Browser Library ───────────────────────────────────────────
export const browserLibrarySchema = {
    action: z.enum(['view', 'search']).describe('Action: view (open library) or search (search for a term).'),
    query: z.string().optional().describe('Search query (for search action).'),
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
    tabId: tabIdField,
};
export const browserLibraryDescription = 'Open or search Leonardo.ai\'s library to view past generations. Use browser_snapshot after to see results.';
export async function handleBrowserLibrary(args) {
    const resolved = await ni.resolveSession(args.sessionId, { url: LEO_BASE }, args.tabId);
    if ('error' in resolved)
        return text('No browser session available.');
    const navRes = await ni.navigate(resolved.sessionId, `${LEO_BASE}/library`, resolved.tabId);
    if (navRes.error)
        return text(`Navigation failed: ${navRes.error}`);
    await wait(2000);
    if (args.action === 'search' && args.query) {
        const fillRes = await ni.fill(resolved.sessionId, 'input[placeholder*="Search" i]', args.query, undefined, resolved.tabId);
        if (fillRes.error)
            return text(`Failed to search: ${fillRes.error}`);
        await ni.pressKey(resolved.sessionId, 'Enter', resolved.tabId);
        return text(`Searched Leonardo.ai library for: "${args.query}". Use browser_snapshot to see results.`);
    }
    return text('Leonardo.ai library opened. Use browser_snapshot to see recent generations.');
}
// ── Browser Download / Screenshot ─────────────────────────────
export const browserDownloadSchema = {
    action: z.enum(['screenshot']).describe('Action: screenshot (capture current Leonardo.ai page state).'),
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
    tabId: tabIdField,
};
export const browserDownloadDescription = 'Capture a screenshot of the current Leonardo.ai page. Use to verify generation results or UI state.';
export async function handleBrowserDownload(args) {
    const resolved = await ni.resolveSession(args.sessionId, { url: LEO_BASE }, args.tabId);
    if ('error' in resolved)
        return text('No browser session available.');
    if (args.action === 'screenshot') {
        const res = await ni.screenshot(resolved.sessionId, resolved.tabId);
        if (res.error)
            return text(`Screenshot failed: ${res.error}`);
        return text('Screenshot captured of the current Leonardo.ai page.');
    }
    return text(`Unknown action: ${args.action}`);
}
// ── Browser Reference (upload reference images) ──────────────
export const browserReferenceSchema = {
    type: z.enum([
        'image_ref', 'style_ref', 'content_ref', 'character_ref',
        'image_to_image', 'start_frame', 'end_frame',
    ]).describe('Reference type. Image generation: image_ref, style_ref, content_ref, character_ref, image_to_image. ' +
        'Video generation: start_frame, end_frame. Availability depends on the selected model — check the model advisor.'),
    filePaths: z.array(z.string()).describe('Absolute file paths of images to upload as reference. Get paths from image_staged tool or from user-attached images.'),
    autoClear: z.boolean().optional().describe('Auto-delete the source images from data/images/ after successful upload. Default: true.'),
    sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
    tabId: tabIdField,
};
export const browserReferenceDescription = 'Upload reference image(s) to Leonardo.ai for guided generation. Supports image references, style/content/character references, ' +
    'image-to-image, and video start/end frames. Must be called AFTER selecting a model (reference type availability is model-dependent) ' +
    'and BEFORE calling leonardo_browser_generate. Uses browser automation to click the reference panel, upload the file(s), and confirm. ' +
    'By default, auto-clears uploaded images from the SynaBun image store after success.';
export async function handleBrowserReference(args) {
    const resolved = await ni.resolveSession(args.sessionId, { url: LEO_BASE }, args.tabId);
    if ('error' in resolved)
        return text('No browser session available. Open Leonardo.ai first.');
    const { type, filePaths, autoClear = true } = args;
    const isVideo = type === 'start_frame' || type === 'end_frame';
    // Step 1: Open the reference panel
    let openResult;
    if (isVideo) {
        // Video: click "Add Image Guidance to generation" button
        openResult = await ni.evaluate(resolved.sessionId, `(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent.includes('Image Guidance') || b.textContent.includes('Add Image')) {
          b.click(); return 'opened';
        }
      }
      return 'not found';
    })()`, resolved.tabId);
    }
    else {
        // Image: click "Add elements" button
        openResult = await ni.evaluate(resolved.sessionId, `(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent.includes('Add elements') || b.textContent.includes('Add Elements')) {
          b.click(); return 'opened';
        }
      }
      return 'not found';
    })()`, resolved.tabId);
    }
    if (openResult.error)
        return text(`Failed to open reference panel: ${openResult.error}`);
    await wait(1500);
    // Step 2: For image references, click the specific reference type tab/button
    if (!isVideo) {
        const typeLabels = {
            'image_ref': ['Image Reference', 'Image Ref', 'Image Input'],
            'style_ref': ['Style Reference', 'Style Ref'],
            'content_ref': ['Content Reference', 'Content Ref'],
            'character_ref': ['Character Reference', 'Character Ref'],
            'image_to_image': ['Image to Image', 'Img2Img'],
        };
        const labels = typeLabels[type] || [type];
        const labelSearch = labels.map(l => `b.textContent.includes('${l}')`).join(' || ');
        const selectResult = await ni.evaluate(resolved.sessionId, `(() => {
      const btns = document.querySelectorAll('button, [role="tab"], [role="menuitem"]');
      for (const b of btns) {
        if (${labelSearch}) { b.click(); return 'selected'; }
      }
      return 'not found — use browser_snapshot to see available options';
    })()`, resolved.tabId);
        if (selectResult.error)
            return text(`Failed to select reference type: ${selectResult.error}. Use browser_snapshot to see the panel.`);
        await wait(1000);
    }
    // Step 3: Find file input and upload
    const uploadResult = await ni.upload(resolved.sessionId, 'input[type="file"]', filePaths, undefined, resolved.tabId);
    if (uploadResult.error) {
        // Fallback: try broader selector
        const fallback = await ni.upload(resolved.sessionId, 'input[accept*="image"]', filePaths, undefined, resolved.tabId);
        if (fallback.error) {
            return text(`Failed to upload reference image(s): ${uploadResult.error}. ` +
                `The file input may not be visible yet — try browser_snapshot to inspect the panel, ` +
                `then use browser_upload manually with the correct selector.`);
        }
    }
    await wait(1000);
    // Step 4: Auto-clear source images if requested
    if (autoClear) {
        const { basename } = await import('path');
        for (const fp of filePaths) {
            const filename = basename(fp);
            try {
                await ni.deleteImage(filename);
            }
            catch { /* ignore cleanup errors */ }
        }
    }
    const typeLabel = type.replace(/_/g, ' ');
    return text(`Reference uploaded (${typeLabel}): ${filePaths.length} image(s).\n` +
        `${autoClear ? 'Source images auto-cleared from store.\n' : ''}` +
        `Use browser_snapshot to verify the reference is applied, then proceed with leonardo_browser_generate.`);
}
//# sourceMappingURL=leonardo-browser-tools.js.map