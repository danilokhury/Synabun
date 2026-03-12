import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Test the event routing logic from handleEvent ──
// We test the pure decision-making: what gets stored, what triggers rendering.

interface EventCallbacks {
  onInit: (sessionId: string) => void;
  onAssistant: (msg: any) => void;
  onToolResult: (ev: any) => void;
  onCost: (amount: number, sessionId?: string) => void;
  onHideThinking: () => void;
}

function createEventHandler(callbacks: EventCallbacks) {
  let _sessionId: string | null = null;
  let _totalCost = 0;

  return {
    handleEvent(ev: any) {
      if (!ev?.type) return;

      if (ev.type === 'system' && ev.subtype === 'init') {
        if (ev.session_id) {
          _sessionId = ev.session_id;
          callbacks.onInit(ev.session_id);
        }
        // Don't hide thinking on init — wait for actual content (assistant, control_request, etc.)
        return;
      }

      if (ev.type === 'assistant' && ev.message) {
        callbacks.onHideThinking();
        callbacks.onAssistant(ev.message);
        return;
      }

      if (ev.type === 'tool_result') {
        callbacks.onToolResult(ev);
        return;
      }

      if (ev.type === 'result') {
        if (ev.total_cost_usd != null) {
          _totalCost += ev.total_cost_usd;
          callbacks.onCost(ev.total_cost_usd, ev.session_id);
        }
        if (ev.session_id) _sessionId = ev.session_id;
      }
    },
    getSessionId: () => _sessionId,
    getTotalCost: () => _totalCost,
  };
}

describe('handleEvent — event routing', () => {
  let callbacks: {
    onInit: ReturnType<typeof vi.fn>;
    onAssistant: ReturnType<typeof vi.fn>;
    onToolResult: ReturnType<typeof vi.fn>;
    onCost: ReturnType<typeof vi.fn>;
    onHideThinking: ReturnType<typeof vi.fn>;
  };
  let handler: ReturnType<typeof createEventHandler>;

  beforeEach(() => {
    callbacks = {
      onInit: vi.fn(),
      onAssistant: vi.fn(),
      onToolResult: vi.fn(),
      onCost: vi.fn(),
      onHideThinking: vi.fn(),
    };
    handler = createEventHandler(callbacks);
  });

  describe('system/init event', () => {
    it('captures session_id', () => {
      handler.handleEvent({ type: 'system', subtype: 'init', session_id: 'sid-123' });
      expect(handler.getSessionId()).toBe('sid-123');
      expect(callbacks.onInit).toHaveBeenCalledWith('sid-123');
    });

    it('does NOT hide thinking on init (wait for actual content)', () => {
      handler.handleEvent({ type: 'system', subtype: 'init', session_id: 'sid-1' });
      expect(callbacks.onHideThinking).not.toHaveBeenCalled();
    });

    it('ignores init without session_id', () => {
      handler.handleEvent({ type: 'system', subtype: 'init' });
      expect(handler.getSessionId()).toBeNull();
      expect(callbacks.onInit).not.toHaveBeenCalled();
    });
  });

  describe('assistant event', () => {
    it('routes to onAssistant with message', () => {
      const msg = { content: [{ type: 'text', text: 'hello' }] };
      handler.handleEvent({ type: 'assistant', message: msg });
      expect(callbacks.onAssistant).toHaveBeenCalledWith(msg);
    });

    it('hides thinking before rendering', () => {
      handler.handleEvent({ type: 'assistant', message: { content: [] } });
      expect(callbacks.onHideThinking).toHaveBeenCalled();
    });

    it('ignores assistant without message', () => {
      handler.handleEvent({ type: 'assistant' });
      expect(callbacks.onAssistant).not.toHaveBeenCalled();
    });
  });

  describe('tool_result event', () => {
    it('routes to onToolResult', () => {
      const ev = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result', is_error: false };
      handler.handleEvent(ev);
      expect(callbacks.onToolResult).toHaveBeenCalledWith(ev);
    });
  });

  describe('result event', () => {
    it('accumulates cost', () => {
      handler.handleEvent({ type: 'result', total_cost_usd: 0.05, session_id: 'sid-1' });
      expect(handler.getTotalCost()).toBe(0.05);
      expect(callbacks.onCost).toHaveBeenCalledWith(0.05, 'sid-1');
    });

    it('accumulates across multiple results', () => {
      handler.handleEvent({ type: 'result', total_cost_usd: 0.05 });
      handler.handleEvent({ type: 'result', total_cost_usd: 0.10 });
      expect(handler.getTotalCost()).toBeCloseTo(0.15, 10);
    });

    it('captures session_id from result', () => {
      handler.handleEvent({ type: 'result', session_id: 'sid-final' });
      expect(handler.getSessionId()).toBe('sid-final');
    });

    it('ignores result without cost', () => {
      handler.handleEvent({ type: 'result' });
      expect(callbacks.onCost).not.toHaveBeenCalled();
      expect(handler.getTotalCost()).toBe(0);
    });

    it('handles null cost', () => {
      handler.handleEvent({ type: 'result', total_cost_usd: null });
      expect(callbacks.onCost).not.toHaveBeenCalled();
    });

    it('handles zero cost', () => {
      handler.handleEvent({ type: 'result', total_cost_usd: 0 });
      // 0 != null is true, so it passes the check
      expect(callbacks.onCost).toHaveBeenCalledWith(0, undefined);
    });
  });

  describe('unknown events', () => {
    it('ignores events with no type', () => {
      handler.handleEvent({});
      expect(callbacks.onAssistant).not.toHaveBeenCalled();
      expect(callbacks.onInit).not.toHaveBeenCalled();
    });

    it('ignores null events', () => {
      handler.handleEvent(null);
      // No crash
    });

    it('ignores undefined events', () => {
      handler.handleEvent(undefined);
      // No crash
    });

    it('ignores unrecognized event types', () => {
      handler.handleEvent({ type: 'unknown_type', data: 'test' });
      expect(callbacks.onAssistant).not.toHaveBeenCalled();
      expect(callbacks.onToolResult).not.toHaveBeenCalled();
    });
  });
});
