/**
 * HTTP client for communicating with the Neural Interface Express server.
 * The MCP server delegates all browser operations to the Neural Interface
 * which manages Playwright sessions, CDP screencast, stealth, etc.
 */
const BASE_URL = process.env.NEURAL_INTERFACE_URL
    || `http://localhost:${process.env.NEURAL_PORT || '3344'}`;
const DEFAULT_TIMEOUT = 10_000;
const LONG_TIMEOUT = 30_000;
async function request(method, path, body, timeout = DEFAULT_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
        };
        if (body && method !== 'GET') {
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(`${BASE_URL}${path}`, opts);
        const data = await res.json();
        if (!res.ok && !data.error) {
            data.error = `HTTP ${res.status}`;
        }
        return data;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('abort')) {
            return { error: `Request timed out after ${timeout}ms` };
        }
        return { error: `Neural Interface unreachable: ${msg}. Is the Neural Interface server running?` };
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Resolve which session ID to use.
 * - If sessionId provided, return it immediately (server returns 404 if invalid).
 * - If 1 session exists, auto-select it.
 * - If 0 sessions exist and autoCreate is true, create one.
 * - If multiple sessions and no ID, return error listing them.
 */
export async function resolveSession(sessionId, autoCreate) {
    if (sessionId) {
        // Trust the server — it will 404 if the session doesn't exist.
        // Skipping the extra GET /api/browser/sessions verification call saves a full round-trip.
        return { sessionId };
    }
    // List sessions
    const data = await request('GET', '/api/browser/sessions');
    if (data.error)
        return { error: data.error };
    const sessions = (data.sessions || []);
    if (sessions.length === 1) {
        return { sessionId: sessions[0].id };
    }
    if (sessions.length === 0) {
        if (autoCreate) {
            const created = await request('POST', '/api/browser/sessions', {
                url: autoCreate.url || 'about:blank',
            });
            if (created.error)
                return { error: `Failed to auto-create session: ${created.error}` };
            return { sessionId: created.sessionId };
        }
        return { error: 'No browser sessions open. Use browser_session to create one first, or use browser_navigate with a URL to auto-create.' };
    }
    // Multiple sessions — require explicit ID
    const list = sessions.map(s => `  ${s.id} — ${s.title || s.url}`).join('\n');
    return { error: `Multiple browser sessions open. Specify sessionId:\n${list}` };
}
// ── Cache invalidation ──
export async function invalidateCache(reason) {
    try {
        await request('POST', '/api/cache/invalidate', { reason });
    }
    catch {
        // Fire-and-forget — don't block MCP tools if Neural Interface is down
    }
}
// ── Session management ──
export async function listSessions() {
    return request('GET', '/api/browser/sessions');
}
export async function createSession(url) {
    return request('POST', '/api/browser/sessions', { url: url || 'about:blank' });
}
export async function closeSession(sessionId) {
    return request('DELETE', `/api/browser/sessions/${sessionId}`);
}
// ── Navigation ──
export async function navigate(sessionId, url) {
    return request('POST', `/api/browser/sessions/${sessionId}/navigate`, { url }, LONG_TIMEOUT);
}
export async function goBack(sessionId) {
    return request('POST', `/api/browser/sessions/${sessionId}/back`);
}
export async function goForward(sessionId) {
    return request('POST', `/api/browser/sessions/${sessionId}/forward`);
}
export async function reload(sessionId) {
    return request('POST', `/api/browser/sessions/${sessionId}/reload`, undefined, LONG_TIMEOUT);
}
// ── Interaction (selector-based) ──
export async function click(sessionId, selector, nthMatch) {
    return request('POST', `/api/browser/sessions/${sessionId}/click`, { selector, ...(nthMatch !== undefined && { nthMatch }) });
}
export async function fill(sessionId, selector, value) {
    return request('POST', `/api/browser/sessions/${sessionId}/fill`, { selector, value });
}
export async function type(sessionId, selector, text) {
    return request('POST', `/api/browser/sessions/${sessionId}/type`, { selector, text });
}
export async function hover(sessionId, selector) {
    return request('POST', `/api/browser/sessions/${sessionId}/hover`, { selector });
}
export async function selectOption(sessionId, selector, value) {
    return request('POST', `/api/browser/sessions/${sessionId}/select`, { selector, value });
}
export async function pressKey(sessionId, key) {
    return request('POST', `/api/browser/sessions/${sessionId}/press`, { key });
}
export async function scroll(sessionId, opts) {
    return request('POST', `/api/browser/sessions/${sessionId}/scroll`, opts);
}
export async function upload(sessionId, selector, filePaths) {
    return request('POST', `/api/browser/sessions/${sessionId}/upload`, { selector, filePaths }, LONG_TIMEOUT);
}
// ── Observation ──
export async function snapshot(sessionId, selector) {
    if (selector)
        return request('POST', `/api/browser/sessions/${sessionId}/snapshot`, { selector });
    return request('GET', `/api/browser/sessions/${sessionId}/snapshot`);
}
export async function getContent(sessionId) {
    return request('GET', `/api/browser/sessions/${sessionId}/content`);
}
export async function screenshot(sessionId) {
    return request('GET', `/api/browser/sessions/${sessionId}/screenshot-base64`);
}
// ── Advanced ──
export async function evaluate(sessionId, script) {
    return request('POST', `/api/browser/sessions/${sessionId}/evaluate`, { script }, LONG_TIMEOUT);
}
export async function waitFor(sessionId, opts) {
    return request('POST', `/api/browser/sessions/${sessionId}/wait`, opts, LONG_TIMEOUT);
}
// ── Whiteboard ──
export async function getWhiteboard() {
    return request('GET', '/api/whiteboard');
}
export async function addWhiteboardElements(elements, coordMode, layout) {
    return request('POST', '/api/whiteboard/elements', { elements, coordMode, layout });
}
export async function updateWhiteboardElement(id, updates, coordMode) {
    return request('PUT', `/api/whiteboard/elements/${id}`, { updates, coordMode });
}
export async function removeWhiteboardElement(id) {
    return request('DELETE', `/api/whiteboard/elements/${id}`);
}
export async function clearWhiteboard() {
    return request('POST', '/api/whiteboard/clear');
}
export async function whiteboardScreenshot() {
    return request('GET', '/api/whiteboard/screenshot', undefined, 15_000);
}
// ── Cards (Memory Card MCP integration) ──
export async function getCards() {
    return request('GET', '/api/cards');
}
export async function openCard(memoryId, opts) {
    return request('POST', '/api/cards/open', { memoryId, ...opts });
}
export async function closeCard(memoryId) {
    return request('POST', '/api/cards/close', memoryId ? { memoryId } : {});
}
export async function updateCard(memoryId, updates, coordMode) {
    return request('PUT', `/api/cards/${memoryId}`, { ...updates, coordMode });
}
export async function cardsScreenshot() {
    return request('GET', '/api/cards/screenshot', undefined, 15_000);
}
// ── TicTacToe ──
export async function tictactoeStart(piece) {
    return request('POST', '/api/games/tictactoe/start', { piece });
}
export async function tictactoeMove(cell) {
    return request('POST', '/api/games/tictactoe/move', { cell });
}
export async function tictactoeState() {
    return request('GET', '/api/games/tictactoe/state');
}
export async function tictactoeEnd() {
    return request('POST', '/api/games/tictactoe/end');
}
//# sourceMappingURL=neural-interface.js.map