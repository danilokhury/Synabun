import { z } from 'zod';
import * as ni from '../services/neural-interface.js';

// ── browser_evaluate ──

export const browserEvaluateSchema = {
  script: z.string().describe('JavaScript code to execute in the browser page context. The return value will be serialized to JSON.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserEvaluateDescription =
  'Execute JavaScript in the browser page context and return the result. Useful for reading DOM state, extracting data, or performing actions not covered by other tools.';

export async function handleBrowserEvaluate(args: { script: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.evaluate(resolved.sessionId, args.script);
  if (result.error) return { content: [{ type: 'text' as const, text: `Evaluate failed: ${result.error}` }] };

  let text: string;
  try {
    text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
  } catch {
    text = String(result.result);
  }

  return { content: [{ type: 'text' as const, text }] };
}

// ── browser_wait ──

export const browserWaitSchema = {
  selector: z.string().optional().describe('CSS selector to wait for. If omitted, waits for the specified timeout.'),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('State to wait for (default: "visible"). Only used with selector.'),
  timeout: z.coerce.number().optional().describe('Timeout in milliseconds (default: 10000).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserWaitDescription =
  'Wait for an element to reach a certain state, or wait for a fixed timeout. Useful after navigation or clicks that trigger async content loading.';

export async function handleBrowserWait(args: {
  selector?: string;
  state?: string;
  timeout?: number;
  sessionId?: string;
}) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.waitFor(resolved.sessionId, {
    selector: args.selector,
    state: args.state,
    timeout: args.timeout,
  });
  if (result.error) return { content: [{ type: 'text' as const, text: `Wait failed: ${result.error}` }] };

  if (args.selector) {
    return { content: [{ type: 'text' as const, text: `"${args.selector}" is now ${result.state}` }] };
  }
  return { content: [{ type: 'text' as const, text: `Waited ${args.timeout || 1000}ms — now at ${result.url} "${result.title}"` }] };
}

// ── browser_session ──

export const browserSessionSchema = {
  action: z.enum(['list', 'create', 'close']).describe('"list" = list open sessions, "create" = open a new browser, "close" = close a session.'),
  url: z.string().optional().describe('Starting URL for "create" action (default: about:blank).'),
  sessionId: z.string().optional().describe('Session ID for "close" action. Required for close when multiple sessions exist.'),
};

export const browserSessionDescription =
  'Manage browser sessions — list open sessions, create a new browser, or close an existing one.';

export async function handleBrowserSession(args: {
  action: string;
  url?: string;
  sessionId?: string;
}) {
  if (args.action === 'list') {
    const result = await ni.listSessions();
    if (result.error) return { content: [{ type: 'text' as const, text: `List failed: ${result.error}` }] };
    const sessions = (result.sessions || []) as Array<{ id: string; url: string; title: string; createdAt: number }>;
    if (sessions.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No browser sessions open.' }] };
    }
    const lines = sessions.map(s => `  ${s.id} — ${s.title || s.url} (opened ${new Date(s.createdAt).toLocaleTimeString()})`);
    return { content: [{ type: 'text' as const, text: `${sessions.length} session(s):\n${lines.join('\n')}` }] };
  }

  if (args.action === 'create') {
    const result = await ni.createSession(args.url);
    if (result.error) return { content: [{ type: 'text' as const, text: `Create failed: ${result.error}` }] };
    return { content: [{ type: 'text' as const, text: `Created session ${result.sessionId} at ${args.url || 'about:blank'}` }] };
  }

  if (args.action === 'close') {
    const resolved = await ni.resolveSession(args.sessionId);
    if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

    const result = await ni.closeSession(resolved.sessionId);
    if (result.error) return { content: [{ type: 'text' as const, text: `Close failed: ${result.error}` }] };
    return { content: [{ type: 'text' as const, text: `Closed session ${resolved.sessionId}` }] };
  }

  return { content: [{ type: 'text' as const, text: `Unknown action "${args.action}". Use "list", "create", or "close".` }] };
}
