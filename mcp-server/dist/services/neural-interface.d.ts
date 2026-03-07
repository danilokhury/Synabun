/**
 * HTTP client for communicating with the Neural Interface Express server.
 * The MCP server delegates all browser operations to the Neural Interface
 * which manages Playwright sessions, CDP screencast, stealth, etc.
 */
export interface BrowserSessionInfo {
    id: string;
    url: string;
    title: string;
    createdAt: number;
    clients: number;
}
interface NiResponse {
    ok?: boolean;
    error?: string;
    [key: string]: unknown;
}
/**
 * Resolve which session ID to use.
 * - If sessionId provided, return it immediately (server returns 404 if invalid).
 * - If 1 session exists, auto-select it.
 * - If 0 sessions exist and autoCreate is true, create one.
 * - If multiple sessions and no ID, return error listing them.
 */
export declare function resolveSession(sessionId?: string, autoCreate?: {
    url?: string;
}): Promise<{
    sessionId: string;
} | {
    error: string;
}>;
export declare function invalidateCache(reason: string): Promise<void>;
export declare function listSessions(): Promise<NiResponse>;
export declare function createSession(url?: string): Promise<NiResponse>;
export declare function closeSession(sessionId: string): Promise<NiResponse>;
export declare function navigate(sessionId: string, url: string): Promise<NiResponse>;
export declare function goBack(sessionId: string): Promise<NiResponse>;
export declare function goForward(sessionId: string): Promise<NiResponse>;
export declare function reload(sessionId: string): Promise<NiResponse>;
export declare function click(sessionId: string, selector: string, nthMatch?: number): Promise<NiResponse>;
export declare function fill(sessionId: string, selector: string, value: string): Promise<NiResponse>;
export declare function type(sessionId: string, selector: string | null, text: string): Promise<NiResponse>;
export declare function hover(sessionId: string, selector: string): Promise<NiResponse>;
export declare function selectOption(sessionId: string, selector: string, value: string): Promise<NiResponse>;
export declare function pressKey(sessionId: string, key: string): Promise<NiResponse>;
export declare function scroll(sessionId: string, opts: {
    direction: string;
    distance?: number;
    selector?: string;
}): Promise<NiResponse>;
export declare function upload(sessionId: string, selector: string, filePaths: string[]): Promise<NiResponse>;
export declare function snapshot(sessionId: string, selector?: string): Promise<NiResponse>;
export declare function getContent(sessionId: string): Promise<NiResponse>;
export declare function screenshot(sessionId: string): Promise<NiResponse>;
export declare function evaluate(sessionId: string, script: string): Promise<NiResponse>;
export declare function waitFor(sessionId: string, opts: {
    selector?: string;
    state?: string;
    loadState?: string;
    timeout?: number;
}): Promise<NiResponse>;
export declare function getWhiteboard(): Promise<NiResponse>;
export declare function addWhiteboardElements(elements: Record<string, unknown>[], coordMode?: string, layout?: string): Promise<NiResponse>;
export declare function updateWhiteboardElement(id: string, updates: Record<string, unknown>, coordMode?: string): Promise<NiResponse>;
export declare function removeWhiteboardElement(id: string): Promise<NiResponse>;
export declare function clearWhiteboard(): Promise<NiResponse>;
export declare function whiteboardScreenshot(): Promise<NiResponse>;
export declare function getCards(): Promise<NiResponse>;
export declare function openCard(memoryId: string, opts?: {
    left?: number;
    top?: number;
    compact?: boolean;
    coordMode?: string;
}): Promise<NiResponse>;
export declare function closeCard(memoryId?: string): Promise<NiResponse>;
export declare function updateCard(memoryId: string, updates: Record<string, unknown>, coordMode?: string): Promise<NiResponse>;
export declare function cardsScreenshot(): Promise<NiResponse>;
export declare function tictactoeStart(piece?: string): Promise<NiResponse>;
export declare function tictactoeMove(cell: number): Promise<NiResponse>;
export declare function tictactoeState(): Promise<NiResponse>;
export declare function tictactoeEnd(): Promise<NiResponse>;
export {};
//# sourceMappingURL=neural-interface.d.ts.map