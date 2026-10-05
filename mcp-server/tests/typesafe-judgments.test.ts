import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  judge, noul, choice, score, readNoul, readChoice, readScore,
  clearTypeSafeCache, resetTypeSafeKey, typesafeMetrics, typesafeCacheSize,
} from '../src/services/typesafe.js';
import { mapRelation, bandToImportance, judgeMemory, judgeRelations, judgeHistoricalQuery } from '../src/services/memory-judgments.js';

/**
 * These tests never reach the network. The paths that matter here are the
 * failure paths: every call site falls back to a heuristic when `judge()`
 * returns null, so "returns null instead of throwing" is the actual contract —
 * a rejected promise inside the maintenance job would fail the whole index job,
 * and inside a hook it would block the agent.
 */

const ok = (answers: unknown) => ({
  ok: true, status: 200,
  json: async () => ({ model: 'jev-2026-09', usage: { input_tokens: 10, output_tokens: 3 }, answers }),
});

describe('typesafe client', () => {
  beforeEach(() => {
    // vitest.config.ts turns judgments off suite-wide so no other test can
    // reach the network. This file is the exception: it drives the client
    // directly against a stubbed fetch.
    delete process.env.SYNABUN_TYPESAFE;
    process.env.TYPESAFE_API_KEY = 'test-key';
    resetTypeSafeKey();
    clearTypeSafeCache();
    Object.assign(typesafeMetrics, { calls: 0, hits: 0, failures: 0, cached: 0, inputTokens: 0, outputTokens: 0, totalMs: 0, lastError: null });
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.TYPESAFE_API_KEY; process.env.SYNABUN_TYPESAFE = 'off'; resetTypeSafeKey(); });

  it('sends model, state and questions to /v1/systemone', async () => {
    const fetchMock = vi.fn(async () => ok({ q: { type: 'noul', noul: 0.9 } }));
    vi.stubGlobal('fetch', fetchMock);
    await judge({ text: 'hello' }, { q: noul('is it a greeting?') });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ text: 'hello' });
    expect(body.questions.q).toEqual({ type: 'noul', instructions: 'is it a greeting?' });
  });

  it('returns null rather than throwing on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    await expect(judge({ a: 1 }, { q: noul('x') })).resolves.toBeNull();
    expect(typesafeMetrics.lastError).toBe('HTTP 429');
  });

  it('returns null rather than throwing when the transport fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(judge({ a: 1 }, { q: noul('x') })).resolves.toBeNull();
    expect(typesafeMetrics.failures).toBe(1);
  });

  it('returns null on a malformed body instead of handing back junk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) })));
    await expect(judge({ a: 1 }, { q: noul('x') })).resolves.toBeNull();
  });

  it('returns null without a request when no key is configured', async () => {
    delete process.env.TYPESAFE_API_KEY;
    resetTypeSafeKey();
    process.env.DOTENV_PATH = '/nonexistent/.env';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(judge({ a: 1 }, { q: noul('x') })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.DOTENV_PATH;
  });

  it('serves an identical question from cache instead of paying twice', async () => {
    const fetchMock = vi.fn(async () => ok({ q: { type: 'noul', noul: 0.7 } }));
    vi.stubGlobal('fetch', fetchMock);
    await judge({ a: 1 }, { q: noul('x') });
    await judge({ a: 1 }, { q: noul('x') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(typesafeMetrics.cached).toBe(1);
    expect(typesafeCacheSize()).toBe(1);
  });

  it('rejects a score question with fewer than two levels at build time', () => {
    expect(() => score('how bad?', ['only one'])).toThrow(/at least two/);
  });
});

describe('answer readers', () => {
  it('reads each primitive and rejects a mismatched type', () => {
    expect(readNoul({ type: 'noul', noul: 0.8 })).toBe(0.8);
    expect(readChoice({ type: 'choice', choice: 'b', confidence: 0.6, probabilities: {} })).toEqual({ choice: 'b', confidence: 0.6 });
    expect(readScore({ type: 'score', score: 2.5, confidence: 0.4, legend: {}, probabilities: {} })?.score).toBe(2.5);
    // A noul carries no confidence field; asking for one must not invent it.
    expect(readChoice({ type: 'noul', noul: 0.8 } as never)).toBeNull();
    expect(readNoul(undefined)).toBeNull();
  });
});

describe('importance bands', () => {
  it('maps the rubric ends onto the documented 1-10 scale', () => {
    expect(bandToImportance(0)).toBeCloseTo(1.5);
    expect(bandToImportance(5)).toBeCloseTo(10);
    expect(bandToImportance(2)).toBeCloseTo(5);
  });
  it('interpolates between bands and clamps outside them', () => {
    expect(bandToImportance(2.5)).toBeCloseTo(5.75);
    expect(bandToImportance(-3)).toBeCloseTo(1.5);
    expect(bandToImportance(99)).toBeCloseTo(10);
  });
});

describe('relation mapping', () => {
  it('drops unrelated pairs entirely', () => {
    expect(mapRelation('unrelated', 0.9, 0.1)).toBeNull();
  });
  it('only writes duplicate_of when the choice is confident', () => {
    expect(mapRelation('duplicate', 0.9, 0.1)).toBe('duplicate_of');
    expect(mapRelation('duplicate', 0.5, 0.1)).toBe('similar');
  });
  it('requires the contradiction noul to agree before flagging a conflict', () => {
    expect(mapRelation('conflicting', 0.9, 0.8)).toBe('possible_conflict');
    expect(mapRelation('conflicting', 0.9, 0.2)).toBe('similar');
    // No noul at all: trust the choice rather than silently downgrading.
    expect(mapRelation('conflicting', 0.9, null)).toBe('possible_conflict');
  });
});

describe('judgments degrade to null, never to a wrong answer', () => {
  beforeEach(() => {
    // vitest.config.ts turns judgments off suite-wide so no other test can
    // reach the network. This file is the exception: it drives the client
    // directly against a stubbed fetch.
    delete process.env.SYNABUN_TYPESAFE;
    process.env.TYPESAFE_API_KEY = 'test-key';
    resetTypeSafeKey();
    clearTypeSafeCache();
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.TYPESAFE_API_KEY; process.env.SYNABUN_TYPESAFE = 'off'; resetTypeSafeKey(); });

  it('judgeMemory returns null when the API is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(judgeMemory('some memory')).resolves.toBeNull();
  });

  it('judgeHistoricalQuery returns null, which is distinct from false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    // null means "ask the regex"; false would mean "definitely not historical".
    await expect(judgeHistoricalQuery('what did we decide')).resolves.toBeNull();
  });

  it('judgeRelations batches every candidate into one request', async () => {
    const fetchMock = vi.fn(async () => ok({
      relation_0: { type: 'choice', choice: 'duplicate', confidence: 0.9, probabilities: {} },
      contradiction_0: { type: 'noul', noul: 0.1 },
      relation_1: { type: 'choice', choice: 'unrelated', confidence: 0.8, probabilities: {} },
      contradiction_1: { type: 'noul', noul: 0.0 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const verdicts = await judgeRelations('source text', [
      { id: 'a', content: 'first candidate' },
      { id: 'b', content: 'second candidate' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(verdicts?.get('a')?.relation).toBe('duplicate_of');
    expect(verdicts?.get('b')?.relation).toBeNull();
  });

  it('judgeRelations and judgeMemory clip oversized text so a request stays under the state cap', async () => {
    const fetchMock = vi.fn(async () => ok({ relation_0: { type: 'choice', choice: 'related', confidence: 0.8, probabilities: {} }, contradiction_0: { type: 'noul', noul: 0.1 }, importance: { type: 'score', score: 2, confidence: 0.7, legend: {}, probabilities: {} }, kind: { type: 'choice', choice: 'note', confidence: 0.7, probabilities: {} } }));
    vi.stubGlobal('fetch', fetchMock);
    const huge = 'x'.repeat(50_000);
    await judgeRelations(huge, [{ id: 'a', content: huge }]);
    const relationBody = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(relationBody.state.memory.content.length).toBeLessThan(6_100);
    expect(relationBody.state.candidates[0].content).toContain('[truncated, 50000 chars total]');
    await judgeMemory(huge);
    const memoryBody = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(memoryBody.state.memory_text.length).toBeLessThan(12_100);
    // Short text is sent untouched, so the cache key and the bench calibration hold.
    await judgeMemory('short memory');
    expect(JSON.parse((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as string).state.memory_text).toBe('short memory');
  });

  it('judgeRelations skips the request entirely when there are no candidates', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(judgeRelations('source', [])).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a candidate whose answer came back the wrong type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ relation_0: { type: 'noul', noul: 0.5 } })));
    const verdicts = await judgeRelations('source', [{ id: 'a', content: 'x' }]);
    expect(verdicts?.has('a')).toBe(false);
  });
});
