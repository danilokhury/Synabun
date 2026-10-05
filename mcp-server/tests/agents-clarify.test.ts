import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { obtainIdentity, runWithIdentity } from '../src/services/identity.js';
import {
  AGENT_ROLE_DENIED, AGENT_TOOL_NAMES, agentClarifySchema, agentDispatchSchema, agentRouteSchema,
  handleAgentClarify, handleAgentDispatch, handleAgentRoute,
} from '../src/tools/agents.js';

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const assistantIdentity = () => {
  const pin = `assistant-${randomUUID()}`;
  return obtainIdentity(pin, { source: 'header', pins: { terminalSessionId: pin }, role: 'assistant' });
};
const asAssistant = <T>(run: () => Promise<T>) => runWithIdentity(assistantIdentity(), run);
type ToolText = { content: Array<{ type: string; text?: string }> };
const textOf = (result: ToolText) => result.content[0]?.text ?? '';
function stubFetch(data: unknown = { ok: true }, status = 200) {
  const fetch = vi.fn(async () => response(data, status));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const bodies = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([input, init]) => ({
  path: new URL(String(input)).pathname,
  method: ((init || {}) as RequestInit).method,
  headers: (((init || {}) as RequestInit).headers || {}) as Record<string, string>,
  body: JSON.parse(String(((init || {}) as RequestInit).body || '{}')),
}));

const question = (over: Record<string, unknown> = {}) => ({
  id: 'scope', header: 'Scope', question: 'Whole app or the settings page only?',
  options: [{ label: 'Whole app', description: 'Every screen' }, { label: 'Settings page only' }], ...over,
});
const clarify = { assistant_session_id: 'assistant-1', summary: 'Add dark mode', questions: [question()] };

beforeEach(() => { vi.stubEnv('SYNABUN_ROLE', ''); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('agent_clarify', () => {
  it('is one of the role-gated agent tools, listed right after agent_route', () => {
    expect(AGENT_TOOL_NAMES).toContain('agent_clarify');
    expect(AGENT_TOOL_NAMES.indexOf('agent_clarify')).toBe(AGENT_TOOL_NAMES.indexOf('agent_route') + 1);
  });

  it('keeps questions light: 1-3 questions of 2-4 options, short lists', () => {
    const schema = z.object(agentClarifySchema);
    expect(schema.safeParse({ ...clarify, constraints: ['Keep the light palette'], assumptions: ['Use CSS variables'] }).success).toBe(true);
    expect(schema.safeParse({ ...clarify, questions: [question(), question({ id: 'b' }), question({ id: 'c', multi_select: true })] }).success).toBe(true);
    expect(schema.safeParse({ ...clarify, questions: [] }).success).toBe(false);
    expect(schema.safeParse({ ...clarify, questions: [1, 2, 3, 4].map((n) => question({ id: `q${n}` })) }).success).toBe(false);
    expect(schema.safeParse({ ...clarify, questions: [question({ options: [{ label: 'Only one' }] })] }).success).toBe(false);
    expect(schema.safeParse({ ...clarify, questions: [question({ options: 'ABCDE'.split('').map((label) => ({ label })) })] }).success).toBe(false);
    expect(schema.safeParse({ ...clarify, assumptions: Array.from({ length: 7 }, (_, i) => `a${i}`) }).success).toBe(false);
    expect(schema.safeParse({ ...clarify, summary: '' }).success).toBe(false);
    expect(schema.safeParse({ summary: 'x', questions: [question()] }).success).toBe(false);
  });

  it('POSTs the questions to /api/assistant/clarify and returns the server\'s answer as data', async () => {
    const fetch = stubFetch({ ok: true, status: 'pending', briefId: 'brief-1', next: 'End your turn now' });
    const result = await asAssistant(() => handleAgentClarify({ ...clarify, assumptions: ['Use CSS variables'] }));
    expect(JSON.parse(textOf(result))).toMatchObject({ status: 'pending', briefId: 'brief-1' });
    const [call] = bodies(fetch);
    expect(call).toMatchObject({ path: '/api/assistant/clarify', method: 'POST' });
    expect(call.headers['X-Synabun-Role']).toBe('assistant');
    expect(Number(call.headers['X-Synabun-Deadline'])).toBeGreaterThan(Date.now() + 100_000);
    expect(call.body).toEqual({ assistantSessionId: 'assistant-1', summary: 'Add dark mode', questions: [question()], assumptions: ['Use CSS variables'] });
  });

  it('is refused without the assistant role and never reaches the server', async () => {
    const fetch = stubFetch();
    const plain = obtainIdentity(`cli-${randomUUID()}`, { source: 'mcp-session' });
    expect(textOf(await runWithIdentity(plain, () => handleAgentClarify(clarify)))).toBe(AGENT_ROLE_DENIED);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('agent_dispatch and agent_route after a clarification', () => {
  it('pass brief_id and independent through', async () => {
    expect(z.object(agentDispatchSchema).safeParse({ provider: 'codex', task: 't', cwd: '/tmp', assistant_session_id: 'a', brief_id: 'brief-1', independent: false }).success).toBe(true);
    expect(z.object(agentRouteSchema).safeParse({ assistant_session_id: 'a', task_class: 'code', summary: 's', confidence: 0.9, proposals: [{ kind: 'direct' }], independent: true }).success).toBe(true);
    const fetch = stubFetch({ ok: true });
    await asAssistant(async () => {
      await handleAgentDispatch({ provider: 'codex', task: 'Implement it', cwd: '/tmp/project', assistant_session_id: 'assistant-1', brief_id: 'brief-1' });
      await handleAgentDispatch({ provider: 'codex', task: 'Unrelated fix', cwd: '/tmp/project', assistant_session_id: 'assistant-1', independent: true });
      await handleAgentRoute({ assistant_session_id: 'assistant-1', task_class: 'quick', summary: 'Unrelated fix', confidence: 0.9, proposals: [{ kind: 'direct' }], independent: true });
    });
    const [withBrief, independent, route] = bodies(fetch);
    expect(withBrief.body).toMatchObject({ briefId: 'brief-1' });
    expect(withBrief.body).not.toHaveProperty('independent');
    expect(independent.body).toMatchObject({ independent: true });
    expect(independent.body).not.toHaveProperty('briefId');
    expect(route).toMatchObject({ path: '/api/assistant/route', body: { independent: true } });
  });
});
