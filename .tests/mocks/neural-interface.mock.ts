/**
 * Configurable mock for the Neural Interface HTTP client.
 * Used by browser, whiteboard, and card tool tests.
 */
import { vi } from 'vitest';

export interface NiState {
  sessions: Array<{ id: string; url: string; title: string; createdAt: number }>;
  whiteboardElements: unknown[];
  viewport: { width: number; height: number };
  cards: unknown[];
  shouldError: boolean;
  errorMessage: string;
}

const defaultState = (): NiState => ({
  sessions: [{ id: 'test-session-1', url: 'https://example.com', title: 'Test Page', createdAt: Date.now() }],
  whiteboardElements: [],
  viewport: { width: 1920, height: 1080 },
  cards: [],
  shouldError: false,
  errorMessage: 'Neural Interface unreachable',
});

let _state = defaultState();

export function setNiState(partial: Partial<NiState>) {
  _state = { ..._state, ...partial };
}

export function resetNiState() {
  _state = defaultState();
}

export function setNiError(message = 'Neural Interface unreachable') {
  _state.shouldError = true;
  _state.errorMessage = message;
}

export function getNiState(): NiState {
  return _state;
}

function err() {
  return { error: _state.errorMessage };
}

export const mockNi = {
  resolveSession: vi.fn(async (sessionId?: string) => {
    if (_state.shouldError) return err();
    if (sessionId) return { sessionId };
    if (_state.sessions.length === 1) return { sessionId: _state.sessions[0].id };
    if (_state.sessions.length === 0) return { error: 'No browser sessions open. Use browser_session to create one first, or use browser_navigate with a URL to auto-create.' };
    const list = _state.sessions.map(s => `  ${s.id} — ${s.title || s.url}`).join('\n');
    return { error: `Multiple browser sessions open. Specify sessionId:\n${list}` };
  }),

  listSessions: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { sessions: _state.sessions };
  }),

  createSession: vi.fn(async (url?: string) => {
    if (_state.shouldError) return err();
    return { sessionId: `new-sess-${Date.now()}`, url: url || 'about:blank' };
  }),

  closeSession: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { ok: true };
  }),

  invalidateCache: vi.fn(async () => {}),

  // Navigation
  navigate: vi.fn(async (_sid: string, url: string) => {
    if (_state.shouldError) return err();
    return { url, title: 'Navigated Page' };
  }),
  goBack: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://prev.example.com', title: 'Previous Page' };
  }),
  goForward: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://next.example.com', title: 'Next Page' };
  }),
  reload: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'Reloaded Page' };
  }),

  // Interaction
  click: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'After Click' };
  }),
  fill: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'After Fill' };
  }),
  type: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'After Type' };
  }),
  hover: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'After Hover' };
  }),
  selectOption: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'After Select' };
  }),
  pressKey: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'After Press' };
  }),
  scroll: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'After Scroll' };
  }),
  upload: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'After Upload' };
  }),

  // Observation
  snapshot: vi.fn(async () => {
    if (_state.shouldError) return err();
    return {
      url: 'https://example.com',
      title: 'Test Page',
      snapshot: { role: 'document', name: 'Test', children: [{ role: 'button', name: 'Click me' }] },
    };
  }),
  getContent: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'Test Page', text: 'Page content here' };
  }),
  screenshot: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'Test Page', data: 'base64imagedata' };
  }),

  // Advanced
  evaluate: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { result: 42 };
  }),
  waitFor: vi.fn(async (_sid: string, opts: Record<string, unknown>) => {
    if (_state.shouldError) return err();
    return { url: 'https://example.com', title: 'Test Page', state: opts.state || 'visible' };
  }),

  // Whiteboard
  getWhiteboard: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { elements: _state.whiteboardElements, viewport: _state.viewport };
  }),
  addWhiteboardElements: vi.fn(async (elements: unknown[]) => {
    if (_state.shouldError) return err();
    const added = elements.map((e, i) => ({ id: `el-${i}`, type: (e as Record<string, unknown>).type || 'text', zIndex: i }));
    return { added };
  }),
  updateWhiteboardElement: vi.fn(async (id: string, updates: unknown) => {
    if (_state.shouldError) return err();
    return { element: { id, type: 'text', x: 100, y: 100, ...(updates as Record<string, unknown>) } };
  }),
  removeWhiteboardElement: vi.fn(async (id: string) => {
    if (_state.shouldError) return err();
    return { removed: { id, type: 'text' } };
  }),
  clearWhiteboard: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { ok: true };
  }),
  whiteboardScreenshot: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { data: 'base64whiteboardscreenshot' };
  }),

  // Cards
  getCards: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { cards: _state.cards, viewport: _state.viewport };
  }),
  openCard: vi.fn(async (memoryId: string, opts?: Record<string, unknown>) => {
    if (_state.shouldError) return err();
    return { result: { memoryId, left: opts?.left ?? 100, top: opts?.top ?? 100, alreadyOpen: false } };
  }),
  closeCard: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { ok: true };
  }),
  updateCard: vi.fn(async (memoryId: string, updates: Record<string, unknown>) => {
    if (_state.shouldError) return err();
    return { result: { memoryId, ...updates } };
  }),
  cardsScreenshot: vi.fn(async () => {
    if (_state.shouldError) return err();
    return { data: 'base64cardsscreenshot' };
  }),
};
