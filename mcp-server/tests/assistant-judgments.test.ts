import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, closeDatabase } from '../src/services/sqlite.js';
import {
  judgeWorkerOutcome, workerOutcomeState, WORKER_STATUS_OPTIONS, WORKER_CAUSE_OPTIONS,
} from '../src/services/assistant-judgments.js';
import { judgeStopTurn, unsupportedClaimQuestion } from '../src/services/memory-judgments.js';
import { invalidateTypeSafeConfig, readTypeSafeLog } from '../src/services/typesafe-config.js';
import { resetTypeSafeKey, clearTypeSafeCache, resetTypeSafeMetrics } from '../src/services/typesafe.js';

/**
 * The Assistant's worker judgments (surfaces worker-outcome, worker-claim).
 * A stubbed fetch answers by question id; nothing reaches the paid API.
 */

const answers: { status: unknown; cause: unknown; claim: unknown } = { status: null, cause: null, claim: null };
const requests: Array<{ state: any; questions: Record<string, any> }> = [];
function stubFetch({ status = 200 } = {}) {
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    if (!String(url).includes('/v1/systemone')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (status !== 200) return { ok: false, status, headers: { get: () => null }, json: async () => ({}) };
    const out: Record<string, unknown> = {};
    if ('status' in body.questions && answers.status) out.status = answers.status;
    if ('cause' in body.questions && answers.cause) out.cause = answers.cause;
    if ('unsupported_claim' in body.questions && answers.claim) out.unsupported_claim = answers.claim;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 40, output_tokens: 0 }, answers: out }) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const choiceOf = (choice: string, confidence: number) => ({ type: 'choice', choice, confidence, probabilities: {} });
const noulOf = (p: number) => ({ type: 'noul', noul: p });

const INPUT = {
  task: 'Fix the login redirect and make the tests pass',
  message: 'I changed the redirect in auth.ts. All tests pass now.',
  filesEdited: ['src/auth.ts'],
  commands: [{ command: 'ls', exit: 'ok', output_tail: 'src' }],
  toolResults: [],
};

beforeAll(() => { getDb(); });
beforeEach(() => {
  getDb().exec('DELETE FROM kv_config; DELETE FROM typesafe_log;');
  invalidateTypeSafeConfig();
  requests.length = 0;
  Object.assign(answers, { status: choiceOf('done', 0.91), cause: choiceOf('access', 0.88), claim: noulOf(0.95) });
  delete process.env.SYNABUN_TYPESAFE; process.env.TYPESAFE_API_KEY = 'test-key'; process.env.DOTENV_PATH = '/nonexistent/.env';
  resetTypeSafeKey(); clearTypeSafeCache(); resetTypeSafeMetrics();
});
afterEach(() => {
  vi.unstubAllGlobals(); delete process.env.TYPESAFE_API_KEY; delete process.env.DOTENV_PATH; process.env.SYNABUN_TYPESAFE = 'off'; resetTypeSafeKey();
});
afterAll(() => closeDatabase());

describe('judgeWorkerOutcome', () => {
  it('asks only the questions it was asked for: worker-outcome leads, worker-claim rides', async () => {
    stubFetch();
    const all = await judgeWorkerOutcome(INPUT, { status: true, cause: true, claim: true }, { origin: 'assistant', entityId: 'run-abc', sessionId: 'assistant-1', project: 'synabun' });
    expect(all).toEqual({ status: 'done', statusConfidence: 0.91, cause: 'access', causeConfidence: 0.88, claimProbability: 0.95 });
    expect(Object.keys(requests[0].questions).sort()).toEqual(['cause', 'status', 'unsupported_claim']);
    const [row] = readTypeSafeLog({ entityId: 'run-abc' });
    expect(row.surface).toBe('worker-outcome');
    expect(row.origin).toBe('assistant');
    expect(row.entity_id).toBe('run-abc');
    expect(row.session_id).toBe('assistant-1');
    expect(row.project).toBe('synabun');
    expect(row.surfaces).toEqual(['worker-outcome', 'worker-claim']);

    requests.length = 0;
    const claimOnly = await judgeWorkerOutcome({ ...INPUT, message: 'Different message so the cache is not hit.' }, { status: false, cause: false, claim: true }, { origin: 'assistant', entityId: 'run-claim' });
    expect(claimOnly).toEqual({ claimProbability: 0.95 });
    expect(Object.keys(requests[0].questions)).toEqual(['unsupported_claim']);
    const [claimRow] = readTypeSafeLog({ entityId: 'run-claim' });
    expect(claimRow.surface).toBe('worker-claim');
    expect(claimRow.surfaces).toBeNull();

    requests.length = 0;
    const causeOnly = await judgeWorkerOutcome({ ...INPUT, message: 'Blocked: permission denied writing /etc/hosts.' }, { status: false, cause: true, claim: false });
    expect(causeOnly).toEqual({ cause: 'access', causeConfidence: 0.88 });
    expect(Object.keys(requests[0].questions)).toEqual(['cause']);
    expect(await judgeWorkerOutcome(INPUT, { status: false, cause: false, claim: false })).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('sends the Stop hook\'s claim question verbatim', async () => {
    stubFetch();
    await judgeWorkerOutcome(INPUT, { status: false, cause: false, claim: true });
    await judgeStopTurn({ message: 'All tests pass now, verified.', commands: [{ command: 'ls', exit: 'ok' }] }, { agentMessage: false, turnWorth: false, claimCheck: true });
    expect(requests).toHaveLength(2);
    expect(requests[0].questions.unsupported_claim).toEqual(requests[1].questions.unsupported_claim);
    expect(requests[0].questions.unsupported_claim).toEqual(unsupportedClaimQuestion());
    expect(Object.keys(WORKER_STATUS_OPTIONS)).toEqual(['done', 'blocked', 'needs_input', 'unclear']);
    expect(Object.keys(WORKER_CAUSE_OPTIONS)).toEqual(['capability', 'access', 'needs_user', 'transient', 'other']);
  });

  it('bounds the state: 8 commands (300 / 500), 6 results (500), 20 files, message head + tail within 6000', async () => {
    stubFetch();
    const long = `START ${'a'.repeat(9000)} MIDDLE ${'b'.repeat(9000)} END`;
    await judgeWorkerOutcome({
      task: 't'.repeat(5000),
      message: long,
      declared: { status: 'blocked', summary: 's'.repeat(3000), question: 'q'.repeat(3000) },
      run: { provider: 'codex', state: 'failed', completionReason: 'provider_error', error: 'e'.repeat(3000) },
      filesEdited: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`),
      commands: Array.from({ length: 12 }, (_, i) => ({ command: `cmd${i} ${'x'.repeat(600)}`, exit: i === 11 ? 'error' : 'ok', output_tail: `${'o'.repeat(900)}END${i}` })),
      toolResults: Array.from({ length: 9 }, (_, i) => ({ tool: `tool${i}`, is_error: i === 8, tail: `${'r'.repeat(900)}TAIL${i}` })),
    }, { status: false, cause: true, claim: false });
    const state = requests[0].state;
    expect(state.task.length).toBeLessThanOrEqual(2000);
    expect(state.assistant_message.length).toBeLessThanOrEqual(6000);
    expect(state.assistant_message.startsWith('START ')).toBe(true);
    expect(state.assistant_message.endsWith(' END')).toBe(true);
    expect(state.assistant_message).toContain('\n[…]\n');
    expect(state.declared.summary.length).toBeLessThanOrEqual(1000);
    expect(state.declared.question.length).toBeLessThanOrEqual(500);
    expect(state.run).toEqual({ provider: 'codex', state: 'failed', completion_reason: 'provider_error', error: expect.any(String) });
    expect(state.run.error.length).toBeLessThanOrEqual(500);
    expect(state.files_edited).toHaveLength(20);
    expect(state.bash_commands).toHaveLength(8);
    expect(state.bash_commands[0].command.startsWith('cmd4 ')).toBe(true);
    expect(state.bash_commands.at(-1).exit).toBe('error');
    for (const c of state.bash_commands) { expect(c.command.length).toBeLessThanOrEqual(300); expect(c.output_tail.length).toBeLessThanOrEqual(500); }
    expect(state.bash_commands.at(-1).output_tail.endsWith('END11')).toBe(true);
    expect(state.tool_results).toHaveLength(6);
    for (const r of state.tool_results) expect(r.tail.length).toBeLessThanOrEqual(500);
    expect(state.tool_results.at(-1)).toMatchObject({ tool: 'tool8', is_error: true });
  });

  it('redacts credentials before anything leaves the machine', () => {
    const key = `sk-ant-${'A1b2C3d4'.repeat(4)}`;
    const token = `ghp_${'Z9y8X7w6'.repeat(4)}`;
    const state = workerOutcomeState({
      task: `deploy with ${key}`, message: `Used token ${token} and it failed`,
      commands: [{ command: `curl -H "Authorization: Bearer ${'q'.repeat(30)}" https://x`, exit: 'error', output_tail: `denied for ${key}` }],
      toolResults: [{ tool: 'Bash', is_error: true, tail: `password=hunter22222` }],
      run: { error: `401 for ${token}` }, declared: { summary: `stored ${key}` },
    });
    const wire = JSON.stringify(state);
    expect(wire).not.toContain(key);
    expect(wire).not.toContain(token);
    expect(wire).not.toContain('hunter22222');
    expect(wire).toContain('[redacted:api-key]');
    expect(wire).toContain('[redacted:github-token]');
  });

  it('drops mistyped and unknown answers; a failed request is null', async () => {
    stubFetch();
    Object.assign(answers, { status: choiceOf('finished', 0.99), cause: noulOf(0.9), claim: choiceOf('yes', 0.9) });
    expect(await judgeWorkerOutcome(INPUT, { status: true, cause: true, claim: true })).toBeNull();
    Object.assign(answers, { status: choiceOf('toString', 0.99), cause: choiceOf('transient', 0.6), claim: noulOf(0.2) });
    expect(await judgeWorkerOutcome({ ...INPUT, message: 'another message' }, { status: true, cause: true, claim: true })).toEqual({ cause: 'transient', causeConfidence: 0.6, claimProbability: 0.2 });
    // An answer to a question that was not asked is ignored.
    Object.assign(answers, { status: choiceOf('done', 0.9), cause: choiceOf('access', 0.9), claim: noulOf(0.99) });
    stubFetch();
    const fn = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ answers: { status: choiceOf('done', 0.9), unsupported_claim: noulOf(0.99) } }) }));
    vi.stubGlobal('fetch', fn);
    expect(await judgeWorkerOutcome({ ...INPUT, message: 'third message' }, { status: false, cause: true, claim: false })).toBeNull();
    vi.unstubAllGlobals();
    stubFetch({ status: 503 });
    expect(await judgeWorkerOutcome({ ...INPUT, message: 'fourth message' }, { status: true, cause: true, claim: true })).toBeNull();
  });

  it('asks nothing with the kill switch on', async () => {
    const fn = stubFetch();
    process.env.SYNABUN_TYPESAFE = 'off';
    expect(await judgeWorkerOutcome(INPUT, { status: true, cause: true, claim: true })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});
