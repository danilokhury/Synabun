import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_JUDGMENT_VERSION, BROWSER_DEFINITION_HASH, BROWSER_DEFINITIONS, BROWSER_TARGET_DEFAULTS,
  isPinnedModel, hashCorpusFiles, fixtureCorpusHash, resetFixtureCorpusMemo, defaultFixtureDir,
  browserTargetBasis, describeBasisDiff, autoHealGate, browserAssistSnapshot, confirmAutoHeal,
  readTargetBench, browserAssistCounters, countBrowserAssist, resetBrowserAssistCounters, browserAssistView,
  type GateConfig,
} from '../src/services/browser-assist-gate.js';
import { RISK_RULES_HASH } from '../src/services/browser-risk.js';

/**
 * The gate is what stands between a recorded benchmark and a click nobody
 * asked for twice, so every way a pass can go stale is pinned here: an alias
 * model, a moved threshold, an edited fixture, an edited sentence.
 */

let dir: string;
const cfg = (over: Partial<GateConfig> = {}): GateConfig => ({
  enabled: true, model: 'jev-1.13.0',
  surfaces: { 'browser-target': { ...BROWSER_TARGET_DEFAULTS } },
  browserAssist: { autoHealEnabled: false, targetBench: null },
  ...over,
});
const passFor = (c: GateConfig) => ({ at: '2026-09-19T00:00:00.000Z', model: c.model, basis: browserTargetBasis(c)!, passed: true, reportFile: null });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'synabun-fixtures-'));
  writeFileSync(join(dir, 'target.json'), JSON.stringify({ schema: 1, suite: 'target', cases: [{ id: 'a' }] }));
  writeFileSync(join(dir, 'README.md'), 'not hashed');
  process.env.SYNABUN_BROWSER_FIXTURES_DIR = dir;
  resetFixtureCorpusMemo();
  resetBrowserAssistCounters();
});
afterEach(() => {
  delete process.env.SYNABUN_BROWSER_FIXTURES_DIR;
  resetFixtureCorpusMemo();
  rmSync(dir, { recursive: true, force: true });
});

describe('definitions', () => {
  it('pins the version and the wording hash together, so an unbumped wording edit fails here', () => {
    // Editing a sentence, a cap or an acceptance threshold in BROWSER_DEFINITIONS
    // changes the hash. That is the point: update this pair deliberately, and
    // bump the version when the change is one a hash cannot see.
    expect({ version: BROWSER_JUDGMENT_VERSION, hash: BROWSER_DEFINITION_HASH }).toEqual({ version: 'bj1', hash: '42ae7bdf813d' });
  });

  it('keeps page text out of every instruction and states that page content is untrusted', () => {
    for (const key of ['pageState', 'goal', 'target', 'targetExists', 'socialState', 'socialCandidate'] as const) {
      expect(JSON.stringify(BROWSER_DEFINITIONS[key].instructions)).toMatch(/untrusted content copied from a webpage/);
    }
    expect(BROWSER_DEFINITIONS.policy.snapshotCandidates).toBe(24);
    expect(BROWSER_DEFINITIONS.policy.recoveryCandidates).toBe(12);
  });
});

describe('model pinning', () => {
  it('accepts a versioned id and refuses the aliases that move', () => {
    expect(isPinnedModel('jev-1.13.0')).toBe(true);
    expect(isPinnedModel('jev-2.0.1')).toBe(true);
    for (const id of ['jev-latest', 'jev-preview', 'jev', 'jev-1.13', 'JEV-1.13.0', '', 'latest']) expect(isPinnedModel(id)).toBe(false);
  });
});

describe('fixture corpus hash', () => {
  it('hashes canonical JSON of the .json files only, so reformatting keeps a pass and an edit drops it', () => {
    const a = hashCorpusFiles([{ name: 'target.json', text: '{"a":1,"b":[1,2]}' }]);
    expect(hashCorpusFiles([{ name: 'target.json', text: '{\r\n  "a": 1,\r\n  "b": [1, 2]\r\n}' }])).toBe(a);
    expect(hashCorpusFiles([{ name: 'target.json', text: '{"a":2,"b":[1,2]}' }])).not.toBe(a);
    expect(hashCorpusFiles([{ name: 'other.json', text: '{"a":1,"b":[1,2]}' }])).not.toBe(a);
    expect(hashCorpusFiles([])).toBeNull();
    expect(hashCorpusFiles([{ name: 'broken.json', text: '{nope' }])).toBeNull();
  });

  it('resolves the override directory, ignores non-JSON, and re-reads when a file changes', () => {
    expect(defaultFixtureDir()).toBe(dir);
    const first = fixtureCorpusHash();
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    writeFileSync(join(dir, 'README.md'), 'still not hashed, but longer');
    resetFixtureCorpusMemo();
    expect(fixtureCorpusHash()).toBe(first);
    writeFileSync(join(dir, 'target.json'), JSON.stringify({ schema: 1, suite: 'target', cases: [{ id: 'a' }, { id: 'b' }] }));
    utimesSync(join(dir, 'target.json'), new Date(), new Date(Date.now() + 5000));
    resetFixtureCorpusMemo();
    expect(fixtureCorpusHash()).not.toBe(first);
  });

  it('is null for a missing directory, which keeps the gate shut', () => {
    expect(fixtureCorpusHash(join(dir, 'absent'))).toBeNull();
    process.env.SYNABUN_BROWSER_FIXTURES_DIR = join(dir, 'absent');
    resetFixtureCorpusMemo();
    expect(browserTargetBasis(cfg())).toBeNull();
    expect(autoHealGate(cfg()).reasons.join(' ')).toMatch(/fixture corpus is missing/);
  });
});

describe('basis', () => {
  it('is readable and names every input', () => {
    const basis = browserTargetBasis(cfg())!;
    expect(basis).toMatch(new RegExp(`^jev-1\\.13\\.0\\|bj1:${BROWSER_DEFINITION_HASH}\\|rk1:${RISK_RULES_HASH}\\|conf0\\.85\\|prob0\\.9\\|t1200\\|fx:[0-9a-f]{12}$`));
    // The classifier decides eligibility as much as the model does, so its rules are part of what a pass vouches for.
    expect(RISK_RULES_HASH).toMatch(/^[0-9a-f]{12}$/);
    expect(browserTargetBasis(cfg(), { model: 'jev-latest' })).toMatch(/^jev-latest\|/);
  });

  it('treats 0.850 and 0.85 as equal, 0.855 as different, and a missing threshold as the shipped default', () => {
    const base = browserTargetBasis(cfg());
    expect(browserTargetBasis(cfg({ surfaces: { 'browser-target': { enabled: true, timeoutMs: 1200, minConfidence: 0.850, minProbability: 0.90 } } }))).toBe(base);
    expect(browserTargetBasis(cfg({ surfaces: { 'browser-target': { enabled: true, timeoutMs: 1200, minConfidence: 0.855, minProbability: 0.9 } } }))).not.toBe(base);
    expect(browserTargetBasis(cfg({ surfaces: { 'browser-target': { enabled: true, timeoutMs: 1200 } } }))).toBe(base);
    expect(browserTargetBasis(cfg({ surfaces: {} }))).toBe(base);
  });

  it('says which segment moved', () => {
    const before = browserTargetBasis(cfg())!;
    const after = browserTargetBasis(cfg({ model: 'jev-latest', surfaces: { 'browser-target': { enabled: true, timeoutMs: 900, minConfidence: 0.5, minProbability: 0.9 } } }))!;
    expect(describeBasisDiff(before, after)).toBe('model jev-1.13.0 → jev-latest, confidence 0.85 → 0.5, timeout 1200 → 900');
    expect(describeBasisDiff(before, before.replace(`rk1:${RISK_RULES_HASH}`, 'rk1:000000000000'))).toBe(`risk rules rk1:${RISK_RULES_HASH} → rk1:000000000000`);
    expect(describeBasisDiff('garbage', 'garbage')).toMatch(/unreadable/);
  });
});

describe('gate', () => {
  it('stays shut with no benchmark, a failed benchmark, or an alias model', () => {
    expect(autoHealGate(cfg())).toMatchObject({ eligible: false, mode: 'shadow', modelPinned: true });
    expect(autoHealGate(cfg()).reasons[0]).toMatch(/No browser-target benchmark/);
    const failed = cfg(); failed.browserAssist = { autoHealEnabled: true, targetBench: { ...passFor(failed), passed: false } };
    expect(autoHealGate(failed)).toMatchObject({ eligible: false, mode: 'shadow' });
    expect(autoHealGate(failed).reasons.join(' ')).toMatch(/did not pass every gate/);
    const alias = cfg({ model: 'jev-latest' }); alias.browserAssist = { autoHealEnabled: true, targetBench: passFor(alias) };
    expect(autoHealGate(alias)).toMatchObject({ eligible: false, mode: 'shadow', modelPinned: false });
    expect(autoHealGate(alias).reasons.join(' ')).toMatch(/alias that moves/);
  });

  it('is eligible on a matching pass, and armed only with the toggle, the master switch and the surface on', () => {
    const c = cfg(); c.browserAssist = { autoHealEnabled: false, targetBench: passFor(c) };
    expect(autoHealGate(c)).toMatchObject({ eligible: true, mode: 'shadow', reasons: [] });
    c.browserAssist.autoHealEnabled = true;
    expect(autoHealGate(c).mode).toBe('auto-heal');
    expect(autoHealGate({ ...c, enabled: false }).mode).toBe('shadow');
    expect(autoHealGate({ ...c, surfaces: { 'browser-target': { ...BROWSER_TARGET_DEFAULTS, enabled: false } } }).mode).toBe('shadow');
  });

  it('a threshold, timeout, model or fixture edit makes a recorded pass stale without deleting it', () => {
    const c = cfg(); c.browserAssist = { autoHealEnabled: true, targetBench: passFor(c) };
    const lowered = { ...c, surfaces: { 'browser-target': { ...BROWSER_TARGET_DEFAULTS, minConfidence: 0.5 } } };
    const gate = autoHealGate(lowered);
    expect(gate).toMatchObject({ eligible: false, mode: 'shadow' });
    expect(gate.reasons[0]).toBe('Changed since the benchmark: confidence 0.85 → 0.5.');
    expect(lowered.browserAssist?.targetBench?.passed).toBe(true);
    expect(autoHealGate({ ...c, surfaces: { 'browser-target': { ...BROWSER_TARGET_DEFAULTS, timeoutMs: 3000 } } }).eligible).toBe(false);
    writeFileSync(join(dir, 'target.json'), JSON.stringify({ schema: 1, suite: 'target', cases: [] }));
    resetFixtureCorpusMemo();
    expect(autoHealGate(c).reasons[0]).toMatch(/^Changed since the benchmark: fixtures /);
  });

  it('confirms at the point of effect only while the same basis is still armed', () => {
    const c = cfg(); c.browserAssist = { autoHealEnabled: true, targetBench: passFor(c) };
    const snapshot = browserAssistSnapshot(c);
    expect(snapshot).toMatchObject({ mode: 'auto-heal', model: 'jev-1.13.0', target: { timeoutMs: 1200, minConfidence: 0.85, minProbability: 0.9 } });
    expect(confirmAutoHeal(snapshot, c)).toEqual({ ok: true, reason: null });
    expect(confirmAutoHeal(snapshot, { ...c, browserAssist: { ...c.browserAssist!, autoHealEnabled: false } }).ok).toBe(false);
    expect(confirmAutoHeal(snapshot, { ...c, surfaces: { 'browser-target': { ...BROWSER_TARGET_DEFAULTS, minProbability: 0.5 } } }).ok).toBe(false);
    expect(confirmAutoHeal(browserAssistSnapshot(cfg()), c).ok).toBe(false);
  });
});

describe('stored bench, counters and the view', () => {
  it('reads a well-formed bench, null, and refuses anything else', () => {
    expect(readTargetBench(null)).toBeNull();
    expect(readTargetBench({ at: 'a', model: 'm', basis: 'b', passed: true })).toEqual({ at: 'a', model: 'm', basis: 'b', passed: true, reportFile: null });
    expect(readTargetBench({ at: 'a', model: 'm', basis: 'b', passed: 'yes' })).toBeUndefined();
    expect(readTargetBench('pass')).toBeUndefined();
    expect(readTargetBench([])).toBeUndefined();
  });

  it('counts per process and resets', () => {
    countBrowserAssist('pageAssessments'); countBrowserAssist('blockedBySafety', 2);
    expect(browserAssistCounters).toMatchObject({ pageAssessments: 1, blockedBySafety: 2, autoHealAttempted: 0 });
    const view = browserAssistView(cfg());
    expect(view).toMatchObject({ autoHealEnabled: false, targetBench: null, eligible: false, mode: 'shadow', definition: { version: 'bj1' } });
    expect(view.counters.blockedBySafety).toBe(2);
    resetBrowserAssistCounters();
    expect(browserAssistCounters.blockedBySafety).toBe(0);
    expect(view.counters.blockedBySafety).toBe(2); // the view is a copy
  });
});
