import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerRole, obtainIdentity, runWithIdentity, sanitizeRole } from '../src/services/identity.js';
import {
  AGENT_ROLE_DENIED, AGENT_TOOL_NAMES, TASK_CLASSES, agentDispatchDescription, agentRouteDescription,
  agentDispatchSchema, agentFocusSchema, agentListSchema, agentReadSchema, agentRouteSchema, agentSendSchema, agentStopSchema, agentWaitSchema,
  handleAgentCatalog, handleAgentDispatch, handleAgentFocus, handleAgentList, handleAgentRead, handleAgentSend,
  handleAgentStatus, handleAgentStop, handleAgentUsage, handleAgentWait, registerAgentTools, agentUsageDescription,
} from '../src/tools/agents.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const assistantIdentity = () => {
  const pin = `assistant-${randomUUID()}`;
  return obtainIdentity(pin, { source: 'header', pins: { terminalSessionId: pin }, role: 'assistant' });
};
const asAssistant = <T>(run: () => Promise<T>) => runWithIdentity(assistantIdentity(), run);
type ToolText = { content: Array<{ type: string; text?: string }> };
const textOf = (result: ToolText) => result.content[0]?.text ?? '';
const parsed = (result: ToolText) => JSON.parse(textOf(result));
type Call = { path: string; query: Record<string, string>; method: string; headers: Record<string, string>; body?: Record<string, unknown> };
const calls = (fetch: ReturnType<typeof vi.fn>): Call[] => fetch.mock.calls.map(([input, init]) => {
  const url = new URL(String(input));
  const opts = (init || {}) as RequestInit;
  return {
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    method: opts.method || 'GET',
    headers: (opts.headers || {}) as Record<string, string>,
    body: typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined,
  };
});
function stubFetch(data: unknown = { ok: true }, status = 200) {
  const fetch = vi.fn(async () => response(data, status));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => { vi.stubEnv('SYNABUN_ROLE', ''); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('agent_* schemas', () => {
  const dispatch = z.object(agentDispatchSchema);
  const base = { provider: 'codex', task: 'Write docs for hooks/', cwd: '/tmp/project', assistant_session_id: 'assistant-1' };

  it('accepts a minimal and a fully specified dispatch', () => {
    expect(dispatch.safeParse(base).success).toBe(true);
    expect(dispatch.safeParse({
      ...base, provider: 'claude-code', model: 'claude-sonnet-4-5', effort: 'high', mcp_profile: 'standard', account_id: 'work',
      permission_policy: 'ask', capability: 'workspace', max_minutes: 240, budget_usd: 0.1, uses_browser: false, focus: true,
      title: 'Docs', context: 'Prior findings', tags: ['docs'], workflow_id: 'wf-1', parent_run_id: 'run-0',
      output_schema: { type: 'object' }, idempotency_key: 'docs-1',
    }).success).toBe(true);
  });

  it('agent_route and agent_dispatch accept the image_gen and video_gen classes', () => {
    const route = z.object(agentRouteSchema);
    const proposal = { summary: 'A neon bunny logo', confidence: 0.8, assistant_session_id: 'assistant-1', proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-sol' }] };
    expect(TASK_CLASSES.slice(-4)).toEqual(['automation', 'design', 'image_gen', 'video_gen']);
    for (const task_class of ['image_gen', 'video_gen']) {
      expect(route.safeParse({ ...proposal, task_class }).success).toBe(true);
      expect(dispatch.safeParse({ ...base, task_class }).success).toBe(true);
    }
    expect(route.safeParse({ ...proposal, task_class: 'image' }).success).toBe(false);
  });

  it('agent_route and agent_dispatch accept the design class, and the descriptions say how it runs', () => {
    const route = z.object(agentRouteSchema);
    const proposal = { summary: 'Redesign the settings screen', confidence: 0.8, assistant_session_id: 'assistant-1', proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] };
    expect(TASK_CLASSES.indexOf('design')).toBe(TASK_CLASSES.indexOf('automation') + 1);
    expect(route.safeParse({ ...proposal, task_class: 'design' }).success).toBe(true);
    expect(dispatch.safeParse({ ...base, task_class: 'design' }).success).toBe(true);
    expect(route.safeParse({ ...proposal, task_class: 'designer' }).success).toBe(false);
    expect(agentRouteSchema.task_class.description).toMatch(/design \(UI\/UX research/);
    expect(agentRouteDescription).toMatch(/design to a worker whose model can see/);
    expect(agentDispatchDescription).toMatch(/A design run gets SynaBun's design rules/);
    expect(agentDispatchDescription).toMatch(/image_gen \/ video_gen \/ design \(and the other way round: ROUTE_CLASS_MISMATCH/);
    expect(agentDispatchDescription).toMatch(/runs only on a model confirmed to see \(MODEL_CANNOT_SEE otherwise\)/);
    expect(agentDispatchSchema.uses_browser.description).toMatch(/false keeps one off the browser/);
  });

  it.each([
    ['an unknown provider', { ...base, provider: 'gemini' }],
    ['no cwd', { provider: 'codex', task: 'x', assistant_session_id: 'a' }],
    ['no assistant_session_id', { provider: 'codex', task: 'x', cwd: '/tmp' }],
    ['an empty task', { ...base, task: '' }],
    ['a task over 16000 chars', { ...base, task: 'x'.repeat(16001) }],
    ['max_minutes below 1', { ...base, max_minutes: 0 }],
    ['max_minutes above 240', { ...base, max_minutes: 241 }],
    ['a fractional max_minutes', { ...base, max_minutes: 1.5 }],
    ['budget_usd below 0.1', { ...base, budget_usd: 0.05 }],
    ['budget_usd above 50', { ...base, budget_usd: 51 }],
    ['more than 10 tags', { ...base, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    ['a title over 80 chars', { ...base, title: 'x'.repeat(81) }],
    ['context over 8000 chars', { ...base, context: 'x'.repeat(8001) }],
    ['an unknown permission_policy', { ...base, permission_policy: 'yolo' }],
    ['an unknown capability', { ...base, capability: 'root' }],
  ])('rejects a dispatch with %s', (_label, input) => {
    expect(dispatch.safeParse(input).success).toBe(false);
  });

  it('bounds wait, read, send, stop, list and focus inputs', () => {
    const wait = z.object(agentWaitSchema);
    expect(wait.safeParse({ run_id: 'r1', until: 'event', timeout_seconds: 120 }).success).toBe(true);
    expect(wait.safeParse({ run_id: 'r1', timeout_seconds: 121 }).success).toBe(false);
    expect(wait.safeParse({ run_ids: Array.from({ length: 11 }, (_, i) => `r${i}`) }).success).toBe(false);
    expect(wait.safeParse({ workflow_id: 'wf', until: 'done' }).success).toBe(false);
    expect(wait.safeParse({ workflow_id: 'wf', mode: 'some' }).success).toBe(false);

    const read = z.object(agentReadSchema);
    expect(read.safeParse({ run_id: 'r1', format: 'tail', tail: 20, max_chars: 200 }).success).toBe(true);
    expect(read.safeParse({ run_id: 'r1', max_chars: 199 }).success).toBe(false);
    expect(read.safeParse({ run_id: 'r1', max_chars: 20001 }).success).toBe(false);
    expect(read.safeParse({ run_id: 'r1', format: 'markdown' }).success).toBe(false);

    const send = z.object(agentSendSchema);
    expect(send.safeParse({ run_id: 'r1', text: 'continue' }).success).toBe(true);
    expect(send.safeParse({ run_id: 'r1', reply: { request_id: 'q1', decision: 'answer', answers: { q: 'a' } } }).success).toBe(true);
    expect(send.safeParse({ run_id: 'r1', text: 'x'.repeat(8001) }).success).toBe(false);
    expect(send.safeParse({ run_id: 'r1', reply: { request_id: 'q1', decision: 'maybe' } }).success).toBe(false);
    expect(send.safeParse({ text: 'no run id' }).success).toBe(false);

    const stop = z.object(agentStopSchema);
    expect(stop.safeParse({ all: true, reason: 'user cancelled' }).success).toBe(true);
    expect(stop.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);

    const list = z.object(agentListSchema);
    expect(list.safeParse({}).success).toBe(true);
    expect(list.safeParse({ active_only: 'yes' }).success).toBe(false);
    expect(z.object(agentFocusSchema).safeParse({ focus: true }).success).toBe(false);
  });
});

describe('agent_* role guard', () => {
  it('denies every handler without the assistant role and never contacts the server', async () => {
    const fetch = stubFetch();
    const plain = obtainIdentity(`cli-${randomUUID()}`, { source: 'mcp-session' });
    const results = await runWithIdentity(plain, () => Promise.all([
      handleAgentCatalog(),
      handleAgentList({}),
      handleAgentDispatch({ provider: 'codex', task: 't', cwd: '/tmp', assistant_session_id: 'a' }),
      handleAgentStatus({ run_id: 'r1' }),
      handleAgentRead({ run_id: 'r1' }),
      handleAgentSend({ run_id: 'r1', text: 'hi' }),
      handleAgentWait({ run_id: 'r1' }),
      handleAgentStop({ run_id: 'r1' }),
      handleAgentFocus({ run_id: 'r1' }),
    ]));
    for (const result of results) expect(textOf(result)).toBe(AGENT_ROLE_DENIED);
    // No identity context at all (stdio) and no SYNABUN_ROLE: still denied.
    expect(textOf(await handleAgentCatalog())).toBe(AGENT_ROLE_DENIED);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts the role from the ALS identity or, for stdio children, from SYNABUN_ROLE', async () => {
    const fetch = stubFetch({ providers: [] });
    expect(sanitizeRole(' Assistant ')).toBe('assistant');
    expect(sanitizeRole('admin')).toBeNull();
    expect(sanitizeRole(undefined)).toBeNull();
    expect(callerRole()).toBeNull();
    await asAssistant(async () => {
      expect(callerRole()).toBe('assistant');
      expect(parsed(await handleAgentCatalog())).toEqual({ providers: [] });
    });
    vi.stubEnv('SYNABUN_ROLE', 'assistant');
    expect(callerRole()).toBe('assistant');
    expect(parsed(await handleAgentCatalog())).toEqual({ providers: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(calls(fetch).every(call => call.headers['X-Synabun-Role'] === 'assistant')).toBe(true);
  });
});

describe('agent_* proxies', () => {
  it('agent_catalog GETs the catalog with the assistant pin and role headers', async () => {
    const fetch = stubFetch({ providers: [{ id: 'codex' }] });
    const id = assistantIdentity();
    const result = await runWithIdentity(id, () => handleAgentCatalog());
    expect(textOf(result)).toBe(JSON.stringify({ providers: [{ id: 'codex' }] }, null, 2));
    const [call] = calls(fetch);
    expect(call).toMatchObject({ path: '/api/assistant/catalog', method: 'GET' });
    expect(call.headers['X-Synabun-Terminal']).toBe(id.clientId);
    expect(call.headers['X-Synabun-Role']).toBe('assistant');
  });

  it('agent_list maps filters to query parameters', async () => {
    const fetch = stubFetch({ runs: [] });
    await asAssistant(async () => {
      await handleAgentList({});
      await handleAgentList({ active_only: true, assistant_session_id: 'assistant-1', workflow_id: 'wf-1' });
    });
    const [bare, filtered] = calls(fetch);
    expect(bare).toMatchObject({ path: '/api/assistant/runs', method: 'GET', query: {} });
    expect(filtered).toMatchObject({ path: '/api/assistant/runs', query: { active: '1', assistantSessionId: 'assistant-1', workflowId: 'wf-1' } });
  });

  it('agent_dispatch POSTs a camelCase body with provider-specific account keys', async () => {
    const fetch = stubFetch({ runId: 'run-1', queued: false });
    const base = { task: 'Review the diff', cwd: '/tmp/project', assistant_session_id: 'assistant-1', account_id: 'acct-1' } as const;
    await asAssistant(async () => {
      await handleAgentDispatch({
        ...base, provider: 'codex', model: 'gpt-5.4-mini', effort: 'low', mcp_profile: 'core', permission_policy: 'restricted',
        capability: 'read-only', max_minutes: 30, budget_usd: 2, uses_browser: false, focus: false, title: 'Review', context: 'PR #1',
        tags: ['review'], workflow_id: 'wf-1', parent_run_id: 'run-0', output_schema: { type: 'object' }, idempotency_key: 'review-1',
      });
      await handleAgentDispatch({ ...base, provider: 'claude-code' });
      await handleAgentDispatch({ ...base, provider: 'opencode' });
    });
    const [codex, claude, opencode] = calls(fetch);
    expect(codex).toMatchObject({ path: '/api/assistant/dispatch', method: 'POST' });
    expect(codex.body).toEqual({
      provider: 'codex', task: 'Review the diff', cwd: '/tmp/project', assistantSessionId: 'assistant-1',
      model: 'gpt-5.4-mini', effort: 'low', mcpProfile: 'core', codexAccountId: 'acct-1',
      permissionPolicy: 'restricted', capability: 'read-only', maxMinutes: 30, budgetUsd: 2,
      usesBrowser: false, focus: false, title: 'Review', context: 'PR #1', tags: ['review'],
      workflowId: 'wf-1', parentRunId: 'run-0', outputSchema: { type: 'object' }, idempotencyKey: 'review-1',
    });
    expect(claude.body).toEqual({
      provider: 'claude-code', task: 'Review the diff', cwd: '/tmp/project', assistantSessionId: 'assistant-1', claudeAccountId: 'acct-1',
    });
    expect(opencode.body).toEqual({ provider: 'opencode', task: 'Review the diff', cwd: '/tmp/project', assistantSessionId: 'assistant-1' });
  });

  it('agent_status and agent_read address the run routes', async () => {
    const fetch = stubFetch({ runId: 'run/1' });
    await asAssistant(async () => {
      await handleAgentStatus({ run_id: 'run/1' });
      await handleAgentRead({ run_id: 'run-1' });
      await handleAgentRead({ run_id: 'run-1', format: 'tail', tail: 20, max_chars: 2000 });
      await handleAgentRead({ run_id: 'run-1', format: 'files' });
    });
    const [status, result, tail, files] = calls(fetch);
    expect(status).toMatchObject({ path: '/api/assistant/runs/run%2F1', method: 'GET' });
    expect(result).toMatchObject({ path: '/api/assistant/runs/run-1/result', method: 'GET', query: {} });
    expect(tail).toMatchObject({ path: '/api/assistant/runs/run-1/transcript', query: { format: 'tail', tail: '20', maxChars: '2000' } });
    expect(files).toMatchObject({ path: '/api/assistant/runs/run-1/transcript', query: { format: 'files' } });
  });

  it('agent_send routes text to /send and replies to /permission', async () => {
    const fetch = stubFetch({ ok: true });
    await asAssistant(async () => {
      await handleAgentSend({ run_id: 'run-1', text: 'Also update the README', queue: true });
      await handleAgentSend({ run_id: 'run-1', reply: { request_id: 'req-1', decision: 'deny', note: 'Not in scope' } });
      await handleAgentSend({ run_id: 'run-1', reply: { request_id: 'req-2', decision: 'answer', answers: { q1: 'yes' } } });
      const both = await handleAgentSend({ run_id: 'run-1', reply: { request_id: 'req-3', decision: 'allow' }, text: 'go on' });
      expect(parsed(both)).toEqual({ reply: { ok: true }, send: { ok: true } });
    });
    const [send, deny, answer, allow, chained] = calls(fetch);
    expect(send).toMatchObject({ path: '/api/assistant/runs/run-1/send', method: 'POST', body: { text: 'Also update the README', queue: true } });
    expect(deny).toMatchObject({ path: '/api/assistant/runs/run-1/permission', method: 'POST', body: { requestId: 'req-1', behavior: 'deny', message: 'Not in scope' } });
    expect(answer.body).toEqual({ requestId: 'req-2', behavior: 'allow', answers: { q1: 'yes' } });
    expect(allow.body).toEqual({ requestId: 'req-3', behavior: 'allow' });
    expect(chained).toMatchObject({ path: '/api/assistant/runs/run-1/send', body: { text: 'go on' } });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('agent_send without text or reply is rejected locally', async () => {
    const fetch = stubFetch();
    const result = await asAssistant(() => handleAgentSend({ run_id: 'run-1' }));
    expect(parsed(result)).toMatchObject({ code: 'INVALID_ARGS' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('agent_wait long-polls one run or POSTs a multi-run barrier', async () => {
    const fetch = stubFetch({ timedOut: false, runs: [] });
    await asAssistant(async () => {
      await handleAgentWait({ run_id: 'run-1' });
      await handleAgentWait({ run_id: 'run-1', until: 'event', timeout_seconds: 5 });
      await handleAgentWait({ run_ids: ['run-1', 'run-2'], mode: 'any', until: 'terminal', timeout_seconds: 120 });
      await handleAgentWait({ workflow_id: 'wf-1' });
      await handleAgentWait({ run_id: 'run-0', run_ids: ['run-1'] });
      expect(parsed(await handleAgentWait({}))).toMatchObject({ code: 'INVALID_ARGS' });
    });
    const [single, event, many, workflow, merged] = calls(fetch);
    // Default 50 s: a 60 s MCP client (the OpenCode brain) must get the wait's own answer, not -32001.
    expect(single).toMatchObject({ path: '/api/assistant/runs/run-1/wait', method: 'GET', query: { until: 'idle', timeout: '50000' } });
    expect(event.query).toEqual({ until: 'event', timeout: '5000' });
    expect(many).toMatchObject({ path: '/api/assistant/wait', method: 'POST', body: { runIds: ['run-1', 'run-2'], mode: 'any', until: 'terminal', timeoutMs: 120000 } });
    expect(workflow.body).toEqual({ workflowId: 'wf-1', mode: 'all', until: 'idle', timeoutMs: 50000 });
    expect(merged.body).toEqual({ runIds: ['run-0', 'run-1'], mode: 'all', until: 'idle', timeoutMs: 50000 });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('agent_wait keeps the HTTP deadline above the requested wait', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => resolve(response({ error: 'aborted' }, 499)));
      // The server answers a beat after the maximum wait — the client must still be listening.
      setTimeout(() => resolve(response({ timedOut: true })), 120_000 + 1_000);
    }));
    vi.stubGlobal('fetch', fetch);
    const pending = asAssistant(() => handleAgentWait({ run_id: 'run-1', timeout_seconds: 120 }));
    await vi.advanceTimersByTimeAsync(120_000 + 1_000);
    expect(signal?.aborted).toBe(false);
    expect(parsed(await pending)).toEqual({ timedOut: true });
  });

  it('agent_stop stops one run or kills all (scoped to the caller\'s session)', async () => {
    const fetch = stubFetch({ ok: true });
    await asAssistant(async () => {
      await handleAgentStop({ run_id: 'run-1', reason: 'user cancelled' });
      await handleAgentStop({ run_id: 'run-1' });
      // all:true without the session id would stop every session's runs.
      expect(parsed(await handleAgentStop({ all: true }))).toMatchObject({ code: 'INVALID_ARGS' });
      await handleAgentStop({ all: true, assistant_session_id: 'assistant-1' });
      await handleAgentStop({ workflow_id: 'wf-1', reason: 'done' });
      await handleAgentStop({ all: true, workflow_id: 'wf-2' });
      expect(parsed(await handleAgentStop({}))).toMatchObject({ code: 'INVALID_ARGS' });
    });
    const [one, bare, all, workflow, both] = calls(fetch);
    expect(one).toMatchObject({ path: '/api/assistant/runs/run-1/stop', method: 'POST', body: { reason: 'user cancelled' } });
    expect(bare.body).toEqual({});
    expect(all).toMatchObject({ path: '/api/assistant/kill-all', method: 'POST', body: { assistantSessionId: 'assistant-1' } });
    expect(workflow.body).toEqual({ workflowId: 'wf-1', reason: 'done' });
    expect(both.body).toEqual({ workflowId: 'wf-2' });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('agent_focus defaults to focusing the tab', async () => {
    const fetch = stubFetch({ ok: true });
    await asAssistant(async () => {
      await handleAgentFocus({ run_id: 'run-1' });
      await handleAgentFocus({ run_id: 'run-1', focus: false });
    });
    const [on, off] = calls(fetch);
    expect(on).toMatchObject({ path: '/api/assistant/runs/run-1/focus', method: 'POST', body: { focus: true } });
    expect(off.body).toEqual({ focus: false });
  });

  it('returns server error JSON and transport failures as text instead of throwing', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ error: 'Too many concurrent Codex runs', code: 'MAX_CONCURRENT', queued: false }, 429))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    vi.stubGlobal('fetch', fetch);
    await asAssistant(async () => {
      const rejected = parsed(await handleAgentDispatch({ provider: 'codex', task: 't', cwd: '/tmp', assistant_session_id: 'a' }));
      expect(rejected).toEqual({ error: 'Too many concurrent Codex runs', code: 'MAX_CONCURRENT', queued: false });
      const down = parsed(await handleAgentStatus({ run_id: 'run-1' }));
      expect(down.code).toBe('TRANSPORT_ERROR');
      expect(down.error).toContain('Neural Interface unreachable');
    });
  });
});

describe('agent_usage', () => {
  const S = 'assistant-usage-tool';
  const T = (input: number, cacheWrite: number, cacheRead: number, output: number, reasoning: number) => ({ input, cacheWrite, cacheRead, output, reasoning });

  /** The real usage ledger (the Neural Interface's own), holding two tasks: a brain turn and a run each. */
  async function ledgerWithTwoTasks() {
    // @ts-expect-error the Neural Interface module is plain JavaScript
    const { createUsageLedger } = await import('../../neural-interface/lib/assistant-usage.js');
    const dir = mkdtempSync(join(tmpdir(), 'synabun-agent-usage-'));
    const ledger = createUsageLedger({ dataDir: dir });
    ledger.beginTask(S, { title: 'First question' });
    ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'claude-opus-5-5[1m]', part: 'main', tokens: T(100, 2000, 10_000, 400, 100), costUsd: 0.05, costBasis: 'reported' });
    ledger.settle({ sessionId: S, scope: 'run', runId: 'run-a', provider: 'claude-code', model: 'claude-sonnet-5-5', part: 'main', tokens: T(40, 0, 400, 60, 0), costUsd: 0.02, costBasis: 'reported' });
    ledger.beginTask(S, { title: 'A follow-up' });
    ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'claude-opus-5-5[1m]', part: 'main', tokens: T(50, 500, 20_000, 400, 0), costUsd: 0.04, costBasis: 'reported' });
    ledger.settle({ sessionId: S, scope: 'run', runId: 'run-b', provider: 'codex', model: 'gpt-6-sol', part: 'main', tokens: T(60_000, 0, 40_000, 1500, 500), costUsd: 0.148, costBasis: 'estimated' });
    // The usage endpoint, answered from that ledger the way the Neural Interface answers it.
    const fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      const task = url.searchParams.get('task') || 'current';
      const run = url.searchParams.get('run');
      return response(task === 'all'
        ? { ok: true, session: ledger.sessionView(S), ...(run ? { run: ledger.runView(S, run) } : {}) }
        : { ok: true, usage: ledger.taskView(S, task) });
    });
    vi.stubGlobal('fetch', fetch);
    return { ledger, dir, fetch };
  }

  it('leads with the session the panel shows: every task added up, input and output apart, and equal to the ledger', async () => {
    const { ledger, dir } = await ledgerWithTwoTasks();
    try {
      const whole = ledger.sessionView(S);
      const current = parsed(await asAssistant(() => handleAgentUsage({ assistant_session_id: S })));
      // The current task is the follow-up; the session is both tasks.
      expect([current.task.id, current.tokens.total, current.session.tokens.total]).toEqual(['task-2', 122_950, 136_050]);
      expect(current.session.tokens).toEqual(whole.tokens);
      expect(current.session.tokens).toEqual({ input: 60_190, cacheWrite: 2500, cacheRead: 70_400, output: 2360, reasoning: 600, total: 136_050, inputTotal: 133_090, outputTotal: 2960 });
      expect(current.session.tokens.total).toBe(current.session.tokens.inputTotal + current.session.tokens.outputTotal);
      expect([current.session.costUsd, current.session.costBasis, current.session.fidelity, current.session.tasks]).toEqual([0.258, 'estimated', 'exact', 2]);
      expect(current.session.models).toEqual([
        { provider: 'codex', model: 'gpt-6-sol', inputTotal: 100_000, outputTotal: 2000, total: 102_000, cacheRead: 40_000, cacheWrite: 0, reasoning: 500, costUsd: 0.148, costBasis: 'estimated' },
        { provider: 'claude-code', model: 'claude-opus-5-5[1m]', inputTotal: 32_650, outputTotal: 900, total: 33_550, cacheRead: 30_000, cacheWrite: 2500, reasoning: 100, costUsd: 0.09, costBasis: 'reported' },
        { provider: 'claude-code', model: 'claude-sonnet-5-5', inputTotal: 440, outputTotal: 60, total: 500, cacheRead: 400, cacheWrite: 0, reasoning: 0, costUsd: 0.02, costBasis: 'reported' },
      ]);
      expect([current.costUsd, current.costBasis, current.fidelity]).toEqual([0.188, 'estimated', 'exact']);
      expect(current.agents.map((agent: any) => [agent.key, agent.total, agent.tokens.inputTotal, agent.tokens.outputTotal])).toEqual([['brain', 20_950, 20_550, 400], ['run-b', 102_000, 100_000, 2000]]);

      // task "all": the same session, with its tasks (each with both sides).
      const all = parsed(await asAssistant(() => handleAgentUsage({ assistant_session_id: S, task: 'all' })));
      expect([all.tokens, all.costUsd, all.costBasis, all.models]).toEqual([current.session.tokens, 0.258, 'estimated', current.session.models]);
      expect(all.tasks.map((task: any) => [task.id, task.total, task.inputTotal, task.outputTotal])).toEqual([['task-1', 13_100, 12_540, 560], ['task-2', 122_950, 120_550, 2400]]);
      expect(all.tasks.reduce((sum: number, task: any) => sum + task.total, 0)).toBe(all.tokens.total);
      // An earlier task by id still has its own numbers, under the same session headline.
      const first = parsed(await asAssistant(() => handleAgentUsage({ assistant_session_id: S, task: 'task-1' })));
      expect([first.task.id, first.tokens.total, first.session.tokens.total]).toEqual(['task-1', 13_100, 136_050]);
      // One run over the session.
      const run = parsed(await asAssistant(() => handleAgentUsage({ assistant_session_id: S, task: 'all', run_id: 'run-b' })));
      expect([run.run.total, run.tokens.total, run.tasks.map((task: any) => task.id)]).toEqual([102_000, 136_050, ['task-2']]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('says what the numbers mean, and stays a tool error on a failed lookup', async () => {
    expect(agentUsageDescription).toMatch(/inputTotal \(input \+ cacheWrite \+ cacheRead/);
    expect(agentUsageDescription).toMatch(/outputTotal \(output \+ reasoning\)/);
    expect(agentUsageDescription).toMatch(/list-price equivalent/);
    stubFetch({ ok: false, code: 'SESSION_NOT_FOUND', error: 'Unknown assistant session nope' }, 404);
    const failed = await asAssistant(() => handleAgentUsage({ assistant_session_id: 'nope' })) as ToolText & { isError?: boolean };
    expect(failed.isError).toBe(true);
    // A server without a ledger: metered:false, never a zero that reads as "nothing was spent".
    stubFetch({ ok: true, usage: null });
    expect(parsed(await asAssistant(() => handleAgentUsage({ assistant_session_id: S })))).toMatchObject({ metered: false, tokens: null });
  });
});

describe('registerAgentTools', () => {
  it('registers the nine agent_* tools as one group', () => {
    const server = new McpServer({ name: 'agents-test', version: '1.0.0' });
    const tools = registerAgentTools(server);
    expect(tools).toHaveLength(AGENT_TOOL_NAMES.length);
    expect(tools.every(tool => tool.enabled)).toBe(true);
  });
});
