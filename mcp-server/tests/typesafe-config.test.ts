import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/services/sqlite.js';
import {
  typesafeConfig, invalidateTypeSafeConfig, updateTypeSafeConfig, mutateTypeSafeConfig, surfaceConfig,
  validateTypeSafeConfigPatch, DEFAULT_TYPESAFE_CONFIG, SURFACES, SURFACE_META, ORIGINS,
  writeTypeSafeLog, readTypeSafeLog, pruneTypeSafeLog, typesafeLogCount,
  redactCredentials, statePreview, findCredentialSpans,
} from '../src/services/typesafe-config.js';
import { autoHealGate, browserTargetBasis, resetFixtureCorpusMemo } from '../src/services/browser-assist-gate.js';
import { desktopPressGate, desktopTargetBasis, DESKTOP_TARGET_DEFAULTS } from '../src/services/desktop-assist-gate.js';
import {
  judge, noul, typesafeEnabled, typesafeKeyInfo, typesafeBaseUrl, resetTypeSafeKey, clearTypeSafeCache,
  resetTypeSafeMetrics, typesafeMetrics, typesafeStats,
} from '../src/services/typesafe.js';

/**
 * The knobs are data so every process — the Neural Interface, HTTP MCP
 * sessions and stdio servers — sees a toggle flip without a rebuild or a
 * restart. These tests pin the read path (defaults, TTL, invalidation, deep
 * merge), the write path (validation), the kill-switch precedence, and the
 * judgment log that makes "why did it decide that" answerable.
 */

const ok = (answers: unknown) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 12, output_tokens: 2 }, answers }),
});

function clearStored() {
  getDb().prepare("DELETE FROM kv_config WHERE key='typesafe_config'").run();
  invalidateTypeSafeConfig();
}
function storeRaw(value: string) {
  getDb().prepare("INSERT INTO kv_config(key,value) VALUES('typesafe_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
}

describe('typesafe config store', () => {
  beforeEach(() => { clearStored(); });
  afterEach(() => { clearStored(); });

  it('returns the defaults when kv_config has no row', () => {
    expect(typesafeConfig()).toEqual(DEFAULT_TYPESAFE_CONFIG);
    expect(surfaceConfig('relations')).toEqual({ enabled: true, timeoutMs: 8000, minConfidence: 0.7 });
    expect(surfaceConfig('not-a-surface')).toEqual({ enabled: true, timeoutMs: 8000 });
  });

  it('serves the cached copy inside the TTL and re-reads after invalidation', () => {
    expect(typesafeConfig().enabled).toBe(true);
    storeRaw(JSON.stringify({ enabled: false }));
    expect(typesafeConfig().enabled).toBe(true);
    invalidateTypeSafeConfig();
    expect(typesafeConfig().enabled).toBe(false);
  });

  it('deep-merges one surface without dropping the others or the defaults', () => {
    updateTypeSafeConfig({ surfaces: { relations: { enabled: false, timeoutMs: 2500 } } });
    const cfg = typesafeConfig();
    expect(cfg.surfaces.relations).toEqual({ enabled: false, timeoutMs: 2500, minConfidence: 0.7 });
    expect(cfg.surfaces.rerank).toEqual(DEFAULT_TYPESAFE_CONFIG.surfaces.rerank);
    expect(cfg.updatedAt).toBeTruthy();
    // A second write for another surface keeps the first.
    updateTypeSafeConfig({ surfaces: { rerank: { enabled: false } } });
    expect(typesafeConfig().surfaces.relations.enabled).toBe(false);
    expect(typesafeConfig().surfaces.rerank.enabled).toBe(false);
  });

  it('mutate sees the stored value, not the cache, and applies a functional update', () => {
    updateTypeSafeConfig({ backfill: { judged: 5 } });
    const next = mutateTypeSafeConfig(current => ({ backfill: { judged: current.backfill.judged + 3 } }));
    expect(next.backfill.judged).toBe(8);
    expect(next.backfill.relationsCreated).toEqual({ similar: 0, possible_conflict: 0, duplicate_of: 0 });
  });

  it('falls back to defaults on malformed JSON without throwing', () => {
    storeRaw('not json at all');
    invalidateTypeSafeConfig();
    expect(() => typesafeConfig()).not.toThrow();
    expect(typesafeConfig()).toEqual(DEFAULT_TYPESAFE_CONFIG);
  });

  it('validates a patch the way the settings endpoint needs', () => {
    expect(() => validateTypeSafeConfigPatch({ surfaces: { nope: { enabled: true } } })).toThrow(/Unknown surface/);
    expect(() => validateTypeSafeConfigPatch({ surfaces: { relations: { timeoutMs: 5 } } })).toThrow(/timeoutMs/);
    expect(() => validateTypeSafeConfigPatch({ applyJudgedImportance: true })).toThrow(/bench/);
    expect(() => validateTypeSafeConfigPatch({ baseUrl: 'ftp://x' })).toThrow(/baseUrl/);
    expect(() => validateTypeSafeConfigPatch({ model: 'has spaces' })).toThrow(/model/);
    expect(validateTypeSafeConfigPatch({ baseUrl: '' })).toEqual({ baseUrl: null });
    expect(validateTypeSafeConfigPatch({ baseUrl: 'https://proxy.local/' })).toEqual({ baseUrl: 'https://proxy.local' });
    expect(validateTypeSafeConfigPatch({ enabled: false, surfaces: { rerank: { enabled: false, minConfidence: 0.4 } }, costPerMillionInput: 0.05 }))
      .toEqual({ enabled: false, surfaces: { rerank: { enabled: false, minConfidence: 0.4 } }, costPerMillionInput: 0.05 });
    updateTypeSafeConfig({ benchRunAt: '2026-09-19T00:00:00.000Z' });
    expect(validateTypeSafeConfigPatch({ applyJudgedImportance: true })).toEqual({ applyJudgedImportance: true });
    expect(SURFACES).toHaveLength(28);
  });

  it('ships the Assistant worker and desktop surfaces on, with the claim rider riding the outcome request', () => {
    expect(SURFACES.slice(-3)).toEqual(['worker-outcome', 'worker-claim', 'desktop-target']);
    expect(surfaceConfig('worker-outcome')).toEqual({ enabled: true, timeoutMs: 2500, minConfidence: 0.7 });
    expect(surfaceConfig('worker-claim')).toEqual({ enabled: true, timeoutMs: 2500, minProbability: 0.9 });
    expect(surfaceConfig('desktop-target')).toEqual({ enabled: true, timeoutMs: 1200, minConfidence: 0.85, minProbability: 0.9 });
    expect(SURFACE_META['worker-claim'].ridesWith).toBe('worker-outcome');
    expect(SURFACE_META['worker-outcome'].ridesWith).toBeUndefined();
    // The Assistant is its own origin, and the "live" filter (everything but backfill and bench) still covers it.
    expect(ORIGINS).toContain('assistant');
    expect(ORIGINS.slice(-2)).toEqual(['backfill', 'bench']);
  });

  it('ships the three browser surfaces on, with a Noul floor beside the Choice threshold', () => {
    expect(surfaceConfig('browser-page-state')).toEqual({ enabled: true, timeoutMs: 1000, minConfidence: 0.65, minProbability: 0.8 });
    expect(surfaceConfig('browser-target')).toEqual({ enabled: true, timeoutMs: 1200, minConfidence: 0.85, minProbability: 0.9 });
    expect(surfaceConfig('browser-social')).toEqual({ enabled: true, timeoutMs: 1200, minConfidence: 0.75 });
    // Existing surfaces did not grow a probability floor.
    expect(surfaceConfig('relations')).not.toHaveProperty('minProbability');
    updateTypeSafeConfig({ surfaces: { 'browser-target': { minProbability: 0.95 } } });
    expect(typesafeConfig().surfaces['browser-target']).toEqual({ enabled: true, timeoutMs: 1200, minConfidence: 0.85, minProbability: 0.95 });
    expect(() => validateTypeSafeConfigPatch({ surfaces: { 'browser-target': { minProbability: 1.5 } } })).toThrow(/minProbability must be between 0 and 1/);
    expect(validateTypeSafeConfigPatch({ surfaces: { 'browser-target': { minProbability: 0.7 } } })).toEqual({ surfaces: { 'browser-target': { minProbability: 0.7 } } });
  });
});

describe('browser assistance gate through the settings validator', () => {
  let fixtures: string;
  const pin = () => updateTypeSafeConfig({ model: 'jev-1.13.0' });
  const recordPass = (passed = true) => mutateTypeSafeConfig(current => ({
    browserAssist: { targetBench: { at: '2026-09-19T00:00:00.000Z', model: current.model, basis: browserTargetBasis(current)!, passed, reportFile: null } },
  }));
  beforeEach(() => {
    clearStored();
    fixtures = mkdtempSync(join(tmpdir(), 'synabun-browser-fixtures-'));
    writeFileSync(join(fixtures, 'target.json'), JSON.stringify({ schema: 1, suite: 'target', cases: [] }));
    process.env.SYNABUN_BROWSER_FIXTURES_DIR = fixtures;
    resetFixtureCorpusMemo();
  });
  afterEach(() => {
    clearStored();
    delete process.env.SYNABUN_BROWSER_FIXTURES_DIR;
    resetFixtureCorpusMemo();
    rmSync(fixtures, { recursive: true, force: true });
  });

  it('defaults to off with no benchmark, and the key survives an unrelated write', () => {
    expect(typesafeConfig().browserAssist).toEqual({ autoHealEnabled: false, targetBench: null });
    pin(); recordPass();
    updateTypeSafeConfig({ surfaces: { rerank: { enabled: false } } });
    expect(typesafeConfig().browserAssist.targetBench).toMatchObject({ model: 'jev-1.13.0', passed: true });
    // A malformed stored bench is ignored rather than trusted.
    storeRaw(JSON.stringify({ model: 'jev-1.13.0', browserAssist: { autoHealEnabled: true, targetBench: { passed: 'yes' } } }));
    invalidateTypeSafeConfig();
    expect(typesafeConfig().browserAssist).toEqual({ autoHealEnabled: true, targetBench: null });
    expect(autoHealGate(typesafeConfig()).mode).toBe('shadow');
  });

  it('refuses to enable without a matching pass, and says why', () => {
    expect(() => validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: true } })).toThrow(/stays locked: No browser-target benchmark/);
    recordPass();                       // recorded under the jev-latest alias
    expect(() => validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: true } })).toThrow(/alias that moves/);
    pin(); recordPass(false);
    expect(() => validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: true } })).toThrow(/did not pass every gate/);
    recordPass();
    expect(validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: true } })).toEqual({ browserAssist: { autoHealEnabled: true } });
  });

  it('judges the merged request, so one PUT cannot lower a threshold and enable together', () => {
    pin(); recordPass();
    expect(() => validateTypeSafeConfigPatch({ surfaces: { 'browser-target': { minConfidence: 0.5 } }, browserAssist: { autoHealEnabled: true } }))
      .toThrow(/Changed since the benchmark: confidence 0\.85 → 0\.5/);
    expect(() => validateTypeSafeConfigPatch({ model: 'jev-latest', browserAssist: { autoHealEnabled: true } })).toThrow(/stays locked/);
  });

  it('a later threshold change leaves the toggle as intent, the pass on record, and the mode in shadow', () => {
    pin(); recordPass();
    updateTypeSafeConfig(validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: true } }));
    expect(autoHealGate(typesafeConfig()).mode).toBe('auto-heal');
    updateTypeSafeConfig(validateTypeSafeConfigPatch({ surfaces: { 'browser-target': { minProbability: 0.5 } } }));
    const cfg = typesafeConfig();
    expect(cfg.browserAssist.autoHealEnabled).toBe(true);
    expect(cfg.browserAssist.targetBench?.passed).toBe(true);
    expect(autoHealGate(cfg)).toMatchObject({ eligible: false, mode: 'shadow' });
    // Off is always allowed, locked or not.
    expect(validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: false } })).toEqual({ browserAssist: { autoHealEnabled: false } });
  });

  it('never lets the settings API write the benchmark record or an unknown field', () => {
    expect(() => validateTypeSafeConfigPatch({ browserAssist: { targetBench: { at: 'x', model: 'jev-1.13.0', basis: 'y', passed: true } } })).toThrow(/written by the browser benchmark/);
    expect(() => validateTypeSafeConfigPatch({ browserAssist: { autoHeal: true } })).toThrow(/Unknown browserAssist field: autoHeal/);
    expect(() => validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: 'yes' } })).toThrow(/must be a boolean/);
    expect(() => validateTypeSafeConfigPatch({ browserAssist: [] })).toThrow(/must be an object/);
  });
});

describe('desktop assistance gate through the settings validator', () => {
  let fixtures: string;
  let browserFixtures: string;
  const pin = () => updateTypeSafeConfig({ model: 'jev-1.13.0' });
  const recordPass = (passed = true) => mutateTypeSafeConfig(current => ({
    desktopAssist: { targetBench: { at: '2026-09-23T00:00:00.000Z', model: current.model, basis: desktopTargetBasis(current)!, passed, reportFile: null } },
  }));
  beforeEach(() => {
    clearStored();
    fixtures = mkdtempSync(join(tmpdir(), 'synabun-desktop-fixtures-'));
    browserFixtures = mkdtempSync(join(tmpdir(), 'synabun-browser-fixtures-'));
    writeFileSync(join(fixtures, 'target.json'), JSON.stringify({ schema: 1, suite: 'desktop-target', cases: [] }));
    writeFileSync(join(browserFixtures, 'target.json'), JSON.stringify({ schema: 1, suite: 'target', cases: [] }));
    process.env.SYNABUN_DESKTOP_FIXTURES_DIR = fixtures;
    process.env.SYNABUN_BROWSER_FIXTURES_DIR = browserFixtures;
    resetFixtureCorpusMemo();
  });
  afterEach(() => {
    clearStored();
    delete process.env.SYNABUN_DESKTOP_FIXTURES_DIR;
    delete process.env.SYNABUN_BROWSER_FIXTURES_DIR;
    resetFixtureCorpusMemo();
    rmSync(fixtures, { recursive: true, force: true });
    rmSync(browserFixtures, { recursive: true, force: true });
  });

  it('ships off with no benchmark, keeps the desktop-target defaults, and the record survives an unrelated write', () => {
    expect(typesafeConfig().desktopAssist).toEqual({ pressEnabled: false, targetBench: null });
    expect(DEFAULT_TYPESAFE_CONFIG.desktopAssist).toEqual({ pressEnabled: false, targetBench: null });
    expect(surfaceConfig('desktop-target')).toEqual({ ...DESKTOP_TARGET_DEFAULTS });
    pin(); recordPass();
    updateTypeSafeConfig({ surfaces: { rerank: { enabled: false } } });
    expect(typesafeConfig().desktopAssist.targetBench).toMatchObject({ model: 'jev-1.13.0', passed: true });
    // A malformed stored bench is ignored rather than trusted.
    storeRaw(JSON.stringify({ model: 'jev-1.13.0', desktopAssist: { pressEnabled: true, targetBench: { passed: 'yes' } } }));
    invalidateTypeSafeConfig();
    expect(typesafeConfig().desktopAssist).toEqual({ pressEnabled: true, targetBench: null });
    expect(desktopPressGate(typesafeConfig()).mode).toBe('advisory');
  });

  it('refuses to enable without a matching pass, and says why', () => {
    expect(() => validateTypeSafeConfigPatch({ desktopAssist: { pressEnabled: true } })).toThrow(/Press by intent stays locked: No desktop-target benchmark/);
    recordPass();                       // recorded under the jev-latest alias
    expect(() => validateTypeSafeConfigPatch({ desktopAssist: { pressEnabled: true } })).toThrow(/alias that moves/);
    pin(); recordPass(false);
    expect(() => validateTypeSafeConfigPatch({ desktopAssist: { pressEnabled: true } })).toThrow(/did not pass every gate/);
    recordPass();
    expect(validateTypeSafeConfigPatch({ desktopAssist: { pressEnabled: true } })).toEqual({ desktopAssist: { pressEnabled: true } });
  });

  it('judges the merged request, so one PUT cannot lower a threshold and enable together', () => {
    pin(); recordPass();
    expect(() => validateTypeSafeConfigPatch({ surfaces: { 'desktop-target': { minConfidence: 0.5 } }, desktopAssist: { pressEnabled: true } }))
      .toThrow(/Press by intent stays locked: Changed since the benchmark: confidence 0\.85 → 0\.5/);
    expect(() => validateTypeSafeConfigPatch({ model: 'jev-latest', desktopAssist: { pressEnabled: true } })).toThrow(/stays locked/);
  });

  it('a later threshold change leaves the toggle as intent, the pass on record, and the mode advisory', () => {
    pin(); recordPass();
    updateTypeSafeConfig(validateTypeSafeConfigPatch({ desktopAssist: { pressEnabled: true } }));
    expect(desktopPressGate(typesafeConfig()).mode).toBe('press');
    updateTypeSafeConfig(validateTypeSafeConfigPatch({ surfaces: { 'desktop-target': { minProbability: 0.5 } } }));
    const cfg = typesafeConfig();
    expect(cfg.desktopAssist.pressEnabled).toBe(true);
    expect(cfg.desktopAssist.targetBench?.passed).toBe(true);
    expect(desktopPressGate(cfg)).toMatchObject({ eligible: false, mode: 'advisory' });
    // Off is always allowed, locked or not.
    expect(validateTypeSafeConfigPatch({ desktopAssist: { pressEnabled: false } })).toEqual({ desktopAssist: { pressEnabled: false } });
  });

  it('never lets the settings API write the benchmark record or an unknown field', () => {
    expect(() => validateTypeSafeConfigPatch({ desktopAssist: { targetBench: { at: 'x', model: 'jev-1.13.0', basis: 'y', passed: true } } })).toThrow(/written by the desktop benchmark/);
    expect(() => validateTypeSafeConfigPatch({ desktopAssist: { press: true } })).toThrow(/Unknown desktopAssist field: press/);
    expect(() => validateTypeSafeConfigPatch({ desktopAssist: { pressEnabled: 'yes' } })).toThrow(/desktopAssist.pressEnabled must be a boolean/);
    expect(() => validateTypeSafeConfigPatch({ desktopAssist: [] })).toThrow(/desktopAssist must be an object/);
    expect(validateTypeSafeConfigPatch({ desktopAssist: {} })).toEqual({});
  });

  it('the browser and the desktop gates are independent: a pass for one never unlocks the other', () => {
    pin();
    mutateTypeSafeConfig(current => ({ browserAssist: { targetBench: { at: '2026-09-19T00:00:00.000Z', model: current.model, basis: browserTargetBasis(current)!, passed: true, reportFile: null } } }));
    expect(autoHealGate(typesafeConfig()).eligible).toBe(true);
    expect(() => validateTypeSafeConfigPatch({ desktopAssist: { pressEnabled: true } })).toThrow(/No desktop-target benchmark/);
    clearStored(); pin(); recordPass();
    expect(desktopPressGate(typesafeConfig()).eligible).toBe(true);
    expect(() => validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: true } })).toThrow(/No browser-target benchmark/);
    // Both in one PUT: each is judged on its own record.
    expect(() => validateTypeSafeConfigPatch({ browserAssist: { autoHealEnabled: true }, desktopAssist: { pressEnabled: true } })).toThrow(/Safe auto-heal stays locked/);
  });
});

describe('enablement and key source', () => {
  let dir: string;
  beforeEach(() => {
    clearStored();
    dir = mkdtempSync(join(tmpdir(), 'synabun-typesafe-env-'));
    delete process.env.SYNABUN_TYPESAFE;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_BASE_URL;
    process.env.DOTENV_PATH = join(dir, '.env');
    resetTypeSafeKey();
  });
  afterEach(() => {
    clearStored();
    delete process.env.TYPESAFE_API_KEY; delete process.env.DOTENV_PATH; delete process.env.TYPESAFE_BASE_URL;
    process.env.SYNABUN_TYPESAFE = 'off';
    resetTypeSafeKey();
    rmSync(dir, { recursive: true, force: true });
  });

  it('typesafeEnabled honours the env kill switch, the kv master switch and key presence, in that order', () => {
    expect(typesafeEnabled()).toBe(false); // no key anywhere
    process.env.TYPESAFE_API_KEY = 'env-key-0001'; resetTypeSafeKey();
    expect(typesafeEnabled()).toBe(true);
    updateTypeSafeConfig({ enabled: false });
    expect(typesafeEnabled()).toBe(false);
    updateTypeSafeConfig({ enabled: true });
    expect(typesafeEnabled()).toBe(true);
    process.env.SYNABUN_TYPESAFE = 'off';
    expect(typesafeEnabled()).toBe(false);
    expect(typesafeStats().killSwitch).toBe(true);
  });

  it('reports where the key comes from and whether a shell export shadows the .env', () => {
    expect(typesafeKeyInfo()).toEqual({ hasKey: false, last4: null, source: 'none', shadowed: false });
    writeFileSync(join(dir, '.env'), 'OTHER=1\nTYPESAFE_API_KEY="file-key-1234"\n');
    expect(typesafeKeyInfo()).toEqual({ hasKey: true, last4: '1234', source: 'dotenv', shadowed: false });
    process.env.TYPESAFE_API_KEY = 'file-key-1234';
    expect(typesafeKeyInfo()).toMatchObject({ source: 'dotenv', shadowed: false });
    process.env.TYPESAFE_API_KEY = 'shell-key-9999';
    expect(typesafeKeyInfo()).toEqual({ hasKey: true, last4: '9999', source: 'env', shadowed: true });
    // The resolved key follows the same precedence: the export wins.
    resetTypeSafeKey();
    process.env.TYPESAFE_API_KEY = 'shell-key-9999';
    expect(typesafeStats().enabled).toBe(true);
  });

  it('resolves the base URL from env, then config, then the default', () => {
    expect(typesafeBaseUrl()).toEqual({ url: 'https://api.typesafe.ai', source: 'default', shadowed: false });
    updateTypeSafeConfig({ baseUrl: 'https://proxy.local' });
    expect(typesafeBaseUrl()).toEqual({ url: 'https://proxy.local', source: 'config', shadowed: false });
    process.env.TYPESAFE_BASE_URL = 'https://env.local/';
    expect(typesafeBaseUrl()).toEqual({ url: 'https://env.local', source: 'env', shadowed: true });
  });
});

describe('judgment log', () => {
  beforeEach(() => {
    clearStored();
    getDb().exec('DELETE FROM typesafe_log');
    delete process.env.SYNABUN_TYPESAFE;
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.DOTENV_PATH = '/nonexistent/.env';
    resetTypeSafeKey(); clearTypeSafeCache(); resetTypeSafeMetrics();
  });
  afterEach(() => {
    vi.unstubAllGlobals(); clearStored();
    delete process.env.TYPESAFE_API_KEY; delete process.env.DOTENV_PATH; process.env.SYNABUN_TYPESAFE = 'off'; resetTypeSafeKey();
  });

  it('writes one row per call: answered, cached and failed', async () => {
    const fetchMock = vi.fn(async () => ok({ q: { type: 'noul', noul: 0.9 } }));
    vi.stubGlobal('fetch', fetchMock);
    await judge({ text: 'hello' }, { q: noul('is it a greeting?') }, { surface: 'prompt-urgency', entityId: 'mem-1' });
    await judge({ text: 'hello' }, { q: noul('is it a greeting?') }, { surface: 'prompt-urgency', entityId: 'mem-1' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) })));
    await judge({ text: 'other' }, { q: noul('x') }, { surface: 'relations', origin: 'backfill' });
    const rows = readTypeSafeLog({ limit: 10 });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ surface: 'relations', origin: 'backfill', error: 'HTTP 500', cached: 0 });
    expect(rows[1]).toMatchObject({ surface: 'prompt-urgency', cached: 1, input_tokens: 0, entity_id: 'mem-1' });
    expect(rows[2]).toMatchObject({ surface: 'prompt-urgency', cached: 0, input_tokens: 12, output_tokens: 2, question_count: 1, model: 'jev-1.13.0', error: null });
    expect(rows[2].answers).toEqual({ q: { type: 'noul', noul: 0.9 } });
    expect(readTypeSafeLog({ surface: 'relations' })).toHaveLength(1);
    expect(readTypeSafeLog({ origin: 'live' })).toHaveLength(2);
    expect(typesafeStats().surfaces['prompt-urgency']).toMatchObject({ calls: 1, hits: 1, cached: 1 });
    expect(typesafeStats().surfaces['relations']).toMatchObject({ calls: 1, failures: 1 });
  });

  it('makes no request and writes no row for a disabled surface, counting it as skipped', async () => {
    updateTypeSafeConfig({ surfaces: { relations: { enabled: false } } });
    const fetchMock = vi.fn(async () => ok({ q: { type: 'noul', noul: 0.9 } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(judge({ a: 1 }, { q: noul('x') }, { surface: 'relations' })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(typesafeLogCount()).toBe(0);
    expect(typesafeMetrics.skipped).toBe(1);
    expect(typesafeStats().surfaces.relations.skipped).toBe(1);
    // Other surfaces are untouched.
    await judge({ a: 1 }, { q: noul('x') }, { surface: 'rerank' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies the surface timeout from config when the caller passes none', async () => {
    updateTypeSafeConfig({ surfaces: { rerank: { timeoutMs: 200 } } });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    })));
    await expect(judge({ a: 1 }, { q: noul('x') }, { surface: 'rerank' })).resolves.toBeNull();
    expect(typesafeMetrics.lastError).toBe('timeout');
    expect(readTypeSafeLog()[0]).toMatchObject({ surface: 'rerank', error: 'timeout' });
  });

  it('remembers a 429 retry-after so the backfill can wait it out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, headers: { get: (h: string) => h === 'retry-after' ? '7' : null }, json: async () => ({}) })));
    await judge({ a: 1 }, { q: noul('x') }, { surface: 'relations' });
    expect(typesafeStats().retryAfterMs).toBeGreaterThan(5000);
    expect(typesafeStats().retryAfterMs).toBeLessThanOrEqual(7000);
  });

  it('keeps the state preview short and free of credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ q: { type: 'noul', noul: 0.1 } })));
    const state = {
      note: 'TYPESAFE_API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123 and Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      github: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      pad: 'x'.repeat(1000),
    };
    await judge(state, { q: noul('x') }, { surface: 'secret-gate' });
    const preview = readTypeSafeLog()[0].state_preview;
    expect(preview.length).toBeLessThanOrEqual(500);
    expect(preview).not.toContain('sk-live-');
    expect(preview).not.toContain('ghp_ABC');
    expect(preview).not.toContain('eyJhbGci');
    expect(preview).toContain('[redacted:api-key]');
  });

  it('logs the caller\'s preview instead of the state, and withholds browser state that forgot to pass one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ q: { type: 'noul', noul: 0.4 } })));
    const state = { headings: ['PAGE-CANARY quarterly payroll'], candidates: [{ id: 'c1', name: 'PAGE-CANARY Pay now' }] };
    await judge(state, { q: noul('x') }, { surface: 'browser-page-state', logPreview: 'navigate app.example.invalid/:id · 1 heading · 1 control' });
    await judge(state, { q: noul('x') }, { surface: 'browser-page-state', logPreview: 'navigate app.example.invalid/:id · 1 heading · 1 control' }); // cache hit
    await judge({ ...state, other: 1 }, { q: noul('x') }, { surface: 'browser-target' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) })));
    await judge({ ...state, other: 2 }, { q: noul('x') }, { surface: 'browser-social', logPreview: `social probe ${'token=sk-live-abcdefghijklmnopqrstuvwxyz0123 '.repeat(20)}` });
    const rows = readTypeSafeLog({ limit: 10 });
    expect(rows.map(r => [r.surface, r.cached, r.error])).toEqual([['browser-social', 0, 'HTTP 500'], ['browser-target', 0, null], ['browser-page-state', 1, null], ['browser-page-state', 0, null]]);
    expect(rows[3].state_preview).toBe('navigate app.example.invalid/:id · 1 heading · 1 control');
    expect(rows[2].state_preview).toBe(rows[3].state_preview);
    expect(rows[1].state_preview).toBe('[withheld]');
    // The override is still redacted and cut like any other preview.
    expect(rows[0].state_preview.length).toBeLessThanOrEqual(500);
    expect(rows[0].state_preview).not.toContain('sk-live-');
    for (const row of rows) expect(JSON.stringify(row)).not.toContain('PAGE-CANARY');
    // Desktop surfaces read someone's screen: withheld the same way.
    vi.stubGlobal('fetch', vi.fn(async () => ok({ q: { type: 'noul', noul: 0.4 } })));
    await judge({ ...state, other: 3 }, { q: noul('x') }, { surface: 'desktop-target' });
    expect(readTypeSafeLog({ surface: 'desktop-target' })[0].state_preview).toBe('[withheld]');
    // Memory surfaces keep their state preview.
    await judge({ note: 'plain memory text' }, { q: noul('y') }, { surface: 'relations' });
    expect(readTypeSafeLog({ surface: 'relations' })[0].state_preview).toContain('plain memory text');
  });

  it('keeps the surface timeout when the caller also passes a cancellation signal', async () => {
    updateTypeSafeConfig({ surfaces: { 'browser-target': { timeoutMs: 200 } } });
    const seen: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      seen.push(init.signal!);
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const caller = new AbortController();
    const started = Date.now();
    await expect(judge({ a: 1 }, { q: noul('x') }, { surface: 'browser-target', signal: caller.signal, logPreview: 'p' })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(typesafeMetrics.lastError).toBe('timeout');
    expect(caller.signal.aborted).toBe(false);
    // And the caller's own cancellation still ends the request early.
    const cancelled = judge({ a: 2 }, { q: noul('x') }, { surface: 'browser-target', signal: caller.signal, timeoutMs: 5000, logPreview: 'p' });
    caller.abort();
    await expect(cancelled).resolves.toBeNull();
    expect(seen).toHaveLength(2);
    expect(typesafeMetrics.lastError).not.toBe('timeout');
  });

  it('reports the answering model on usage events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ q: { type: 'noul', noul: 0.9 } })));
    const usage: Array<{ model?: string | null; cached: boolean }> = [];
    await judge({ a: 3 }, { q: noul('x') }, { surface: 'rerank', onUsage: u => usage.push(u) });
    expect(usage).toEqual([expect.objectContaining({ model: 'jev-1.13.0', cached: false })]);
  });

  it('prunes to the newest N rows', () => {
    for (let i = 0; i < 30; i++) writeTypeSafeLog({ surface: 'relations', origin: 'live', entity_id: null, model: 'm', question_count: 1, state_preview: `s${i}`, answers: null, latency_ms: 1, input_tokens: 1, output_tokens: 0, cached: 0, error: null });
    expect(pruneTypeSafeLog(10)).toBe(20);
    const rows = readTypeSafeLog({ limit: 100 });
    expect(rows).toHaveLength(10);
    expect(rows[0].state_preview).toBe('s29');
  });
});

describe('credential redaction', () => {
  it('finds precise tokens and contextual secrets, and leaves ordinary text alone', () => {
    const text = 'password: hunter2secret, key sk-proj-abcdefghijklmnopqrstuvwxyz, AKIAABCDEFGHIJKLMNOP, and the word token by itself';
    const spans = findCredentialSpans(text);
    expect(spans.map(s => [s.type, s.precise])).toEqual([['secret', false], ['api-key', true], ['aws-key', true]]);
    expect(redactCredentials(text)).toBe('password: [redacted:secret], key [redacted:api-key], [redacted:aws-key], and the word token by itself');
    expect(redactCredentials('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe('[redacted:private-key]');
    expect(redactCredentials('nothing to see: sk-short')).toBe('nothing to see: sk-short');
    expect(statePreview('a'.repeat(600)).length).toBe(500);
  });
});
