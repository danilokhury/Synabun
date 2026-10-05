import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The browser tool handlers with Jev beside them. The Neural Interface client
 * is mocked, so every transport call is counted: "shadow mode sends no second
 * request" and "a heal is attempted exactly once" are call-count facts here.
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: any[] }>,
  state: {
    inBatch: false, compact: false, signal: undefined as AbortSignal | undefined,
    navigate: {} as Record<string, unknown>, click: {} as Record<string, unknown>, heal: {} as Record<string, unknown>,
    fill: {} as Record<string, unknown>, snapshot: {} as Record<string, unknown>, context: {} as Record<string, unknown>,
    extract: {} as Record<string, unknown>, evaluate: {} as Record<string, unknown>, xCompose: {} as Record<string, unknown>,
  },
}));

vi.mock('../src/services/neural-interface.js', () => {
  const record = (fn: string, reply: () => unknown) => async (...args: any[]) => { h.calls.push({ fn, args }); return reply(); };
  return {
    isBrowserCompactMode: () => h.state.compact, isBrowserFastMode: () => false, isBrowserV2Enabled: () => true,
    inBrowserBatch: () => h.state.inBatch, currentBrowserSignal: () => h.state.signal,
    resolveSession: async () => ({ sessionId: 's1', tabId: 't1' }),
    navigate: record('navigate', () => h.state.navigate), click: record('click', () => h.state.click), clickAutoHeal: record('clickAutoHeal', () => h.state.heal),
    fill: record('fill', () => h.state.fill), type: record('type', () => h.state.fill), hover: record('hover', () => h.state.fill),
    selectOption: record('selectOption', () => h.state.fill), upload: record('upload', () => h.state.fill),
    snapshot: record('snapshot', () => h.state.snapshot), semanticContext: record('semanticContext', () => h.state.context),
    extract: record('extract', () => h.state.extract), evaluate: record('evaluate', () => h.state.evaluate), xComposeState: record('xComposeState', () => h.state.xCompose),
  };
});

import { getDb } from '../src/services/sqlite.js';
import { invalidateTypeSafeConfig, updateTypeSafeConfig, mutateTypeSafeConfig, readTypeSafeLog } from '../src/services/typesafe-config.js';
import { resetTypeSafeKey, clearTypeSafeCache, resetTypeSafeMetrics, typesafeMetrics } from '../src/services/typesafe.js';
import { browserTargetBasis, resetFixtureCorpusMemo, browserAssistCounters, resetBrowserAssistCounters } from '../src/services/browser-assist-gate.js';
import { handleBrowserNavigate } from '../src/tools/browser-navigate.js';
import { handleBrowserClick, handleBrowserFill, handleBrowserSelect, handleBrowserUpload } from '../src/tools/browser-interact.js';
import { handleBrowserSnapshot, handleBrowserExtractTweets, handleBrowserFbComposerState, handleBrowserXComposeState } from '../src/tools/browser-observe.js';

const scenario: Record<string, any> = {};
const requests: Array<{ model: string; state: any; questions: Record<string, any> }> = [];
let fetchMode: 'ok' | 'hang' | '429' | 'garbage' = 'ok';
let onJudge: (() => void) | null = null;
function stubFetch() {
  const fn = vi.fn((_url: string, init: RequestInit) => {
    if (fetchMode === 'hang') return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    if (fetchMode === '429') return Promise.resolve({ ok: false, status: 429, headers: { get: (k: string) => (k === 'retry-after' ? '30' : null) }, json: async () => ({}) });
    if (fetchMode === 'garbage') return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ nope: 1 }) });
    const body = JSON.parse(String(init.body));
    requests.push(body);
    onJudge?.();
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(body.questions)) {
      if (key === 'page_state') answers[key] = { type: 'choice', choice: scenario.pageState, confidence: scenario.pageConfidence, probabilities: {} };
      else if (key === 'goal_satisfied') answers[key] = { type: 'noul', noul: scenario.goal };
      else if (key === 'target') answers[key] = { type: 'choice', choice: scenario.target, confidence: scenario.targetConfidence, probabilities: scenario.probabilities };
      else if (key === 'target_exists') answers[key] = { type: 'noul', noul: scenario.exists };
      else if (key === 'social_state') answers[key] = { type: 'choice', choice: scenario.social, confidence: 0.9, probabilities: {} };
      else if (key === 'social_candidate') answers[key] = { type: 'choice', choice: scenario.socialCandidate, confidence: 0.9, probabilities: {} };
    }
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 90, output_tokens: 6 }, answers }) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const out = (r: { content: Array<{ text?: string }> }) => String(r.content[0].text);
const callsTo = (fn: string) => h.calls.filter(c => c.fn === fn);

const context = { page: { title: 'Sign in', origin: 'https://accounts.example.invalid', path: '/login', lang: 'en', readyState: 'complete' }, signals: { httpStatus: 200, busyCount: 0, progressCount: 0, passwordFieldCount: 1 }, headings: ['Sign in to continue'], alerts: [], dialogs: [], controls: [{ role: 'button', name: 'Sign in' }] };
const navigated = (over = {}) => ({ ok: true, url: 'https://accounts.example.invalid/login?next=%2Finvoices', title: 'Sign in', snapshotText: '- button "Sign in" [ref=e2]', snapshotId: 'snap1', snapshotBudgetApplied: true, semanticContext: context, ...over });
const cand = (id: string, name: string, over = {}) => ({ id, hintIndex: Number(id.slice(1)) - 1, selector: `role=link[name="${name}"]`, role: 'link', kind: 'link', name, disabled: false, inDialog: false, risk: 'navigation', healable: true, hrefPath: '/x', ...over });
const failedClick = (over: Record<string, unknown> = {}) => ({
  error: 'No elements match selector: a.nav-settings', actionStarted: false, hintsLabel: 'Try one of these selectors',
  hints: [{ role: 'a', text: 'Home', ariaLabel: '', placeholder: '', selector: 'role=link[name="Home"]' }, { role: 'a', text: 'Account settings', ariaLabel: '', placeholder: '', selector: 'role=link[name="Account settings"]' }, { role: 'a', text: 'Log out', ariaLabel: '', placeholder: '', selector: 'role=link[name="Log out"]' }],
  assist: { kind: 'no_match', truncated: false, page: { origin: 'https://app.example.invalid', path: '/dashboard', lang: 'en' }, contextId: 'ctx-1',
    candidates: [cand('c1', 'Home'), cand('c2', 'Account settings'), cand('c3', 'Log out', { risk: 'authentication', healable: false })] },
  ...over,
});

let fixtures: string;
const armAutoHeal = () => {
  updateTypeSafeConfig({ model: 'jev-1.13.0' });
  mutateTypeSafeConfig(c => ({ browserAssist: { autoHealEnabled: true, targetBench: { at: '2026-09-19T00:00:00.000Z', model: c.model, basis: browserTargetBasis(c)!, passed: true, reportFile: null } } }));
};

beforeAll(() => getDb());
beforeEach(() => {
  getDb().exec('DELETE FROM kv_config; DELETE FROM typesafe_log;');
  invalidateTypeSafeConfig();
  h.calls.length = 0; requests.length = 0; fetchMode = 'ok'; onJudge = null;
  Object.assign(h.state, { inBatch: false, compact: false, signal: undefined, navigate: navigated(), click: { ok: true, url: 'https://app.example.invalid/x', title: 'X' }, heal: { ok: true, url: 'https://app.example.invalid/settings', title: 'Settings', autoHealed: true }, fill: { ok: true }, snapshot: {}, context: { ok: true, context }, extract: { items: [], raw: 0, scrollsUsed: 1, truncated: false, stopReason: 'end_of_feed' }, evaluate: {}, xCompose: {} });
  Object.assign(scenario, { pageState: 'authentication_required', pageConfidence: 0.94, goal: 0.07, target: 'c2', targetConfidence: 0.95, exists: 0.97, probabilities: { c1: 0.03, c2: 0.95, c3: 0.02 }, social: 'composer_open_ready', socialCandidate: 'c1' });
  fixtures = mkdtempSync(join(tmpdir(), 'synabun-assist-fixtures-'));
  writeFileSync(join(fixtures, 'target.json'), JSON.stringify({ schema: 1, suite: 'target', cases: [] }));
  process.env.SYNABUN_BROWSER_FIXTURES_DIR = fixtures; resetFixtureCorpusMemo(); resetBrowserAssistCounters();
  delete process.env.SYNABUN_TYPESAFE; process.env.TYPESAFE_API_KEY = 'test-key'; process.env.DOTENV_PATH = '/nonexistent/.env';
  resetTypeSafeKey(); clearTypeSafeCache(); resetTypeSafeMetrics();
});
afterEach(() => {
  vi.unstubAllGlobals(); delete process.env.TYPESAFE_API_KEY; delete process.env.DOTENV_PATH; delete process.env.SYNABUN_BROWSER_FIXTURES_DIR;
  process.env.SYNABUN_TYPESAFE = 'off'; resetTypeSafeKey(); resetFixtureCorpusMemo(); rmSync(fixtures, { recursive: true, force: true });
});

describe('browser_navigate', () => {
  it('asks for the context in the same round trip and adds one assessment line above the snapshot', async () => {
    const fetchMock = stubFetch();
    const text = out(await handleBrowserNavigate({ url: 'https://accounts.example.invalid/login?next=%2Finvoices', intent: 'read my open invoices' }));
    expect(callsTo('navigate')[0].args[6]).toEqual({ semanticContext: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toMatch(/^Navigated https:\/\/accounts\.example\.invalid\/login\?next=%2Finvoices — "Sign in"\nJev assessment: authentication_required \(94%\) — pause for human sign-in; goal satisfied 7%\n\n--- Snapshot ---/);
    expect(requests[0].state.intent).toBe('read my open invoices');
    // The judged state is the sanitized context, never the URL the agent navigated to.
    expect(JSON.stringify(requests[0])).not.toContain('next=');
    expect(browserAssistCounters.pageAssessments).toBe(1);
  });

  it('is byte-identical to today when Jev is off, times out, is rate limited or returns garbage', async () => {
    process.env.SYNABUN_TYPESAFE = 'off';
    const baseline = out(await handleBrowserNavigate({ url: 'https://accounts.example.invalid/login' }));
    expect(callsTo('navigate')[0].args[6]).toEqual({ semanticContext: false });
    expect(baseline).not.toContain('Jev');
    delete process.env.SYNABUN_TYPESAFE;
    const fetchMock = stubFetch();
    updateTypeSafeConfig({ surfaces: { 'browser-page-state': { timeoutMs: 200 } } });
    for (const mode of ['hang', 'garbage', '429'] as const) {
      fetchMode = mode;
      expect(out(await handleBrowserNavigate({ url: 'https://accounts.example.invalid/login' })), mode).toBe(baseline);
    }
    expect(typesafeMetrics.retryAfterUntil).toBeGreaterThan(Date.now());
    // While the 429's retry-after holds, nothing is asked: not the context, not the judgment.
    const before = fetchMock.mock.calls.length;
    fetchMode = 'ok';
    expect(out(await handleBrowserNavigate({ url: 'https://accounts.example.invalid/login' }))).toBe(baseline);
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(callsTo('navigate').at(-1)!.args[6]).toEqual({ semanticContext: false });
    expect(browserAssistCounters.skippedRateLimit).toBe(1);
    expect(browserAssistCounters.fallbackUnavailable).toBe(3);
  });

  it('compact mode hides an unremarkable "usable", shows it when an intent was given, and always shows blockers', async () => {
    stubFetch();
    h.state.compact = true;
    Object.assign(scenario, { pageState: 'usable', pageConfidence: 0.9, goal: 0.85 });
    expect(out(await handleBrowserNavigate({ url: 'https://example.invalid/' }))).not.toContain('Jev');
    expect(out(await handleBrowserNavigate({ url: 'https://example.invalid/', intent: 'see the dashboard' }))).toContain('Jev assessment: usable (90%); goal satisfied 85% (likely already done)');
    scenario.pageState = 'verification_required';
    expect(out(await handleBrowserNavigate({ url: 'https://example.invalid/' }))).toContain('Jev assessment: verification_required (90%) — pause for human verification');
    scenario.pageConfidence = 0.4;
    expect(out(await handleBrowserNavigate({ url: 'https://example.invalid/' }))).not.toContain('Jev');
  });

  it('inside a batch asks for nothing', async () => {
    const fetchMock = stubFetch();
    h.state.inBatch = true;
    expect(out(await handleBrowserNavigate({ url: 'https://example.invalid/' }))).not.toContain('Jev');
    expect(callsTo('navigate')[0].args[6]).toEqual({ semanticContext: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('browser_snapshot intent', () => {
  const snap = { ok: true, url: 'https://app.example.invalid/dashboard?tab=1', title: 'Dashboard', snapshotId: 's2', snapshotBudgetApplied: true,
    snapshotText: '- navigation "Main" [ref=e1]:\n  - link "Home" [ref=e2]\n  - link "Account settings" [ref=e4]\n  - link "Boost post" [ref=e5]\n- textbox "Notes" [ref=e7]: TYPED-CANARY' };

  it('ranks the refs of the delivered capture and names the best one; nothing is clicked', async () => {
    stubFetch();
    h.state.snapshot = snap;
    // c3 is "Boost post": likely enough to be listed as an alternative, and dropped because it is a paid control.
    scenario.probabilities = { c1: 0.2, c2: 0.7, c3: 0.08, c4: 0.02 };
    const text = out(await handleBrowserSnapshot({ intent: 'open account settings' }));
    expect(callsTo('snapshot')[0].args[3]).toMatchObject({ includeFullText: true });
    expect(text).toContain('- link "Account settings" [ref=e4]');
    expect(text).toMatch(/\n\nJev target: ref e4 "Account settings" \(choice 95%, match 97%\); alternatives: e2 "Home"$/);
    expect(JSON.stringify(requests[0])).not.toMatch(/TYPED-CANARY|tab=1|"ref"/);
    expect(h.calls.map(c => c.fn)).toEqual(['snapshot']);
  });

  it('uses the same capture\'s full text when only "unchanged" was shown, and says so when nothing qualifies', async () => {
    stubFetch();
    h.state.snapshot = { ...snap, snapshotText: null, unchanged: true, baselineId: 's1', snapshotFullText: snap.snapshotText };
    expect(out(await handleBrowserSnapshot({ intent: 'open account settings' }))).toMatch(/\(observed scope unchanged\)[\s\S]*Jev target: ref e4 "Account settings"/);
    scenario.target = 'none';
    expect(out(await handleBrowserSnapshot({ intent: 'open account settings' }))).toMatch(/Jev target: no candidate qualified$/);
    // A paid control is never put forward, whatever was asked for.
    Object.assign(scenario, { target: 'c3' });
    expect(out(await handleBrowserSnapshot({ intent: 'boost this post' }))).toMatch(/Jev target: no candidate qualified$/);
    expect(browserAssistCounters.blockedBySafety).toBe(1);
  });

  it('without an intent, in a legacy mode, or with Jev off, the call is exactly what it was', async () => {
    const fetchMock = stubFetch();
    h.state.snapshot = snap;
    const plain = out(await handleBrowserSnapshot({}));
    expect(callsTo('snapshot')[0].args[3]).not.toHaveProperty('includeFullText');
    expect(plain).not.toContain('Jev');
    await handleBrowserSnapshot({ mode: 'interactive', intent: 'open settings' });
    process.env.SYNABUN_TYPESAFE = 'off';
    expect(out(await handleBrowserSnapshot({ intent: 'open account settings' }))).toBe(plain);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('failed targets: shadow mode', () => {
  it('reorders and annotates the hints and sends no second request', async () => {
    stubFetch();
    h.state.click = failedClick();
    const text = out(await handleBrowserClick({ selector: 'a.nav-settings', textHint: 'Account settings' }));
    expect(callsTo('click')).toHaveLength(1);
    expect(callsTo('click')[0].args[9]).toBe(true);
    expect(callsTo('clickAutoHeal')).toHaveLength(0);
    expect(text).toMatch(/^Click failed: No elements match selector: a\.nav-settings\n\nTry one of these selectors:\n- a: "Account settings" → role=link\[name="Account settings"\]\n- a: "Home"/);
    expect(text).toContain('Jev target: link "Account settings" → role=link[name="Account settings"] (choice 95%, match 97%; navigation)');
    expect(requests[0].state).toMatchObject({ action: 'click', intent: 'Account settings', failure: 'no_match' });
    expect(browserAssistCounters).toMatchObject({ recommendations: 1, shadowAutoHealEligible: 1, autoHealAttempted: 0 });
  });

  it('never consults Jev unless the server stamped a pre-action resolution failure', async () => {
    const fetchMock = stubFetch();
    const plain = { error: 'Click target was replaced or changed its item while waiting; inspect before retrying.', staleTarget: true, actionStarted: false };
    for (const reply of [
      plain, { ...plain, moneyGuard: true }, { ...plain, quoteGuard: true }, { error: 'x', staleRef: true, actionStarted: false }, { error: 'x', moreLoginBlocked: true, actionStarted: false },
      failedClick({ actionStarted: true, outcome: 'uncertain' }), failedClick({ actionStarted: undefined, outcome: 'uncertain', code: 'TRANSPORT_ERROR' }),
      failedClick({ actionStarted: undefined, outcome: 'uncertain', code: 'REQUEST_TIMEOUT' }), { ...failedClick(), assist: { ...failedClick().assist, kind: 'something_else' } },
    ]) {
      h.state.click = reply;
      const text = out(await handleBrowserClick({ selector: 'a.nav-settings', textHint: 'Account settings' }));
      expect(text).not.toContain('Jev');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(callsTo('clickAutoHeal')).toHaveLength(0);
    // A ref target has no hint list to rank: the flag is not even sent.
    h.calls.length = 0;
    await handleBrowserClick({ ref: 'e12' });
    expect(callsTo('click')[0].args[9]).toBe(false);
  });

  it('what is being filled never reaches Jev or the log, and select / upload take a textHint too', async () => {
    stubFetch();
    h.state.fill = failedClick({ error: 'No elements match selector: input.email' });
    const text = out(await handleBrowserFill({ selector: 'input.email', value: 'VALUE-CANARY secret@example.invalid', textHint: 'Account settings' }));
    expect(callsTo('fill')[0].args[7]).toBe(true);
    expect(text).toContain('Jev target:');
    expect(JSON.stringify(requests)).not.toContain('VALUE-CANARY');
    expect(JSON.stringify(readTypeSafeLog({ limit: 20 }))).not.toContain('VALUE-CANARY');
    expect(callsTo('clickAutoHeal')).toHaveLength(0);
    await handleBrowserSelect({ selector: 'select.country', value: 'BR', textHint: 'Country' });
    expect(callsTo('selectOption')[0].args.slice(6)).toEqual(['Country', true]);
    await handleBrowserUpload({ selector: 'input[type=file]', filePaths: ['/tmp/a.png'], textHint: 'Add photo' });
    expect(callsTo('upload')[0].args.slice(6)).toEqual(['Add photo', true]);
    // A fill is never healed, armed or not.
    armAutoHeal();
    await handleBrowserFill({ selector: 'a.nav-settings', value: 'x', textHint: 'Account settings' });
    expect(callsTo('clickAutoHeal')).toHaveLength(0);
  });
});

describe('safe auto-heal', () => {
  it('locked: an armed-looking response still heals nothing', async () => {
    stubFetch();
    h.state.click = failedClick();
    await handleBrowserClick({ selector: 'a.nav-settings', textHint: 'Account settings' });
    expect(callsTo('clickAutoHeal')).toHaveLength(0);
  });

  it('armed: exactly one retry, through the server context, and the click reads as healed', async () => {
    stubFetch(); armAutoHeal();
    h.state.click = failedClick();
    const text = out(await handleBrowserClick({ selector: 'a.nav-settings', textHint: 'Account settings', snapshot: 'none' }));
    expect(callsTo('click')).toHaveLength(1);
    expect(callsTo('clickAutoHeal')).toHaveLength(1);
    expect(callsTo('clickAutoHeal')[0].args).toEqual(['s1', 't1', { contextId: 'ctx-1', candidateId: 'c2' }, 'none']);
    expect(text).toBe('Clicked "a.nav-settings" (auto-healed via Jev to "Account settings": choice 95%, match 97%; "a.nav-settings" matched nothing) — https://app.example.invalid/settings "Settings"');
    expect(browserAssistCounters).toMatchObject({ autoHealAttempted: 1, autoHealSucceeded: 1 });
  });

  it('a refused heal is reported and never retried; an uncertain one is reported in the server\'s words', async () => {
    stubFetch(); armAutoHeal();
    h.state.click = failedClick();
    h.state.heal = { error: 'Auto-heal refused (fingerprint_changed); nothing was clicked.', autoHealRejected: 'fingerprint_changed', actionStarted: false };
    const refused = out(await handleBrowserClick({ selector: 'a.nav-settings', textHint: 'Account settings' }));
    expect(callsTo('clickAutoHeal')).toHaveLength(1);
    expect(callsTo('click')).toHaveLength(1);
    expect(refused).toMatch(/^Click failed: No elements match selector: a\.nav-settings/);
    expect(refused).toContain('refused by the server: fingerprint_changed; nothing was clicked and it is not retried.');
    h.calls.length = 0;
    h.state.heal = { error: 'Browser deadline exceeded after execution began; outcome uncertain. Inspect before retrying.', actionStarted: true, outcome: 'uncertain' };
    const uncertain = out(await handleBrowserClick({ selector: 'a.nav-settings', textHint: 'Account settings' }));
    expect(callsTo('clickAutoHeal')).toHaveLength(1);
    expect(uncertain).toContain('its outcome is uncertain: Browser deadline exceeded after execution began; outcome uncertain. Inspect before retrying.');
    expect(uncertain).not.toContain('Try one of these selectors');
  });

  const noHeal: Array<[string, () => void, Record<string, unknown>?]> = [
    ['Choice below the confidence threshold', () => { scenario.targetConfidence = 0.6; }],
    ['existence below the probability threshold', () => { scenario.exists = 0.5; }],
    ['Jev answers none', () => { scenario.target = 'none'; }],
    ['the pick is not plain navigation', () => { scenario.target = 'c3'; }],
    ['the pick is not healable', () => { h.state.click = failedClick({ assist: { ...failedClick().assist, candidates: [cand('c1', 'Home'), cand('c2', 'Account settings', { healable: false, risk: 'unknown' })] } }); }],
    ['the pick is disabled', () => { h.state.click = failedClick({ assist: { ...failedClick().assist, candidates: [cand('c1', 'Home'), cand('c2', 'Account settings', { disabled: true })] } }); }],
    ['an ambiguous selector', () => { h.state.click = failedClick({ assist: { ...failedClick().assist, kind: 'ambiguous' } }); }],
    ['the server minted no context', () => { h.state.click = failedClick({ assist: { ...failedClick().assist, contextId: undefined } }); }],
    ['the phrase is a guess from a test id', () => {}, { selector: '[data-testid="settingsLink"]', textHint: undefined }],
    ['a scoped selector', () => {}, { selector: 'nav >> a.settings' }],
    ['the intent names an action', () => {}, { textHint: 'Log out' }],
    ['the caller already cancelled', () => { const c = new AbortController(); c.abort(); h.state.signal = c.signal; }],
    ['a threshold changed between the judgment and the click', () => { onJudge = () => updateTypeSafeConfig({ surfaces: { 'browser-target': { minConfidence: 0.5 } } }); }],
    ['auto-heal switched off between the judgment and the click', () => { onJudge = () => updateTypeSafeConfig({ browserAssist: { autoHealEnabled: false } }); }],
  ];
  for (const [label, arrange, args] of noHeal) {
    it(`no retry when ${label}`, async () => {
      stubFetch(); armAutoHeal();
      h.state.click = failedClick();
      arrange();
      const text = out(await handleBrowserClick({ selector: 'a.nav-settings', textHint: 'Account settings', ...args }));
      expect(callsTo('clickAutoHeal'), label).toHaveLength(0);
      expect(callsTo('click')).toHaveLength(1);
      expect(text).toMatch(/^Click failed:/);
    });
  }

  it('inside a batch nothing is asked and nothing is healed', async () => {
    const fetchMock = stubFetch(); armAutoHeal();
    h.state.inBatch = true;
    h.state.click = failedClick();
    const text = out(await handleBrowserClick({ selector: 'a.nav-settings', textHint: 'Account settings' }));
    expect(callsTo('click')[0].args[9]).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(callsTo('clickAutoHeal')).toHaveLength(0);
    expect(text).not.toContain('Jev');
  });
});

describe('empty extractors', () => {
  it('populated output is untouched and costs nothing; an empty one keeps its message and gains a diagnosis', async () => {
    const fetchMock = stubFetch();
    h.state.extract = { items: [{ url: 'https://x.com/a/status/1', text: 'hi' }], raw: 1, scrollsUsed: 0, truncated: false, stopReason: 'min_items' };
    expect(out(await handleBrowserExtractTweets({}))).toBe('1 tweet(s) (stopped: min_items):\n\n[{"url":"https://x.com/a/status/1","text":"hi"}]');
    expect(callsTo('semanticContext')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    h.state.extract = { items: [], raw: 0, scrollsUsed: 1, truncated: false, stopReason: 'end_of_feed' };
    expect(out(await handleBrowserExtractTweets({}))).toBe('No tweets found. Try browser_scroll (or pass scrolls:2) then retry.\nJev assessment: authentication_required (94%) — a sign-in wall is in the way; pause for human sign-in.');
    expect(callsTo('semanticContext')[0].args[2]).toEqual({ purpose: 'empty-extractor' });
    expect(requests[0].state).toMatchObject({ operation: 'browser_extract_tweets', expected_surface: 'an X/Twitter timeline, profile or search results page' });
  });

  it('busy or skeleton signals outrank a Jev "empty": that is the still-loading feed', async () => {
    stubFetch();
    Object.assign(scenario, { pageState: 'empty', pageConfidence: 0.9 });
    h.state.context = { ok: true, context: { ...context, signals: { ...context.signals, busyCount: 1, progressCount: 6 } } };
    expect(out(await handleBrowserExtractTweets({}))).toContain('Jev assessment: loading (busy regions or skeletons are visible, which outranks "empty") — wait, then retry.');
    h.state.context = { ok: true, context };
    expect(out(await handleBrowserExtractTweets({}))).toContain('Jev assessment: empty (90%) — the page is genuinely empty; scrolling or retrying will not help.');
  });

  it('the budget error still wins, and with Jev off the message is exactly today\'s', async () => {
    const fetchMock = stubFetch();
    h.state.extract = { items: [], budgetReason: 'max_chars' };
    expect(out(await handleBrowserExtractTweets({ maxChars: 10 }))).toBe('Extract failed: maxChars is too small for the first complete item. Increase maxChars or select fewer fields.');
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.SYNABUN_TYPESAFE = 'off';
    h.state.extract = { items: [], raw: 0, scrollsUsed: 0, truncated: false };
    expect(out(await handleBrowserExtractTweets({}))).toBe('No tweets found. Try browser_scroll (or pass scrolls:2) then retry.');
    expect(callsTo('semanticContext')).toHaveLength(0);
  });
});

describe('social composers', () => {
  const fbProbe = (over = {}) => ({
    modal: { open: true, title: 'MODAL-CANARY beitrag erstellen', closeSelector: 'x', containsComposer: true },
    composers: [{ index: 0, inDialog: true, visible: true, isComment: false, isPersonalProfile: false, isPostComposer: true, text: 'DRAFT-CANARY my post', ariaLabel: 'ARIA-CANARY', placeholder: 'P-CANARY' }],
    trigger: { found: false, text: 'TRIGGER-CANARY', suggestedSelector: null }, submitButton: null,
    submission: { state: 'composer-open', evidence: 'EVIDENCE-CANARY' }, recommendedAction: 'unknown',
    boostRisk: { present: true, controls: ['BOOST-CANARY'], boostWhenPublishedToggle: null, warning: 'W-CANARY' }, ...over,
  });
  const dialogControls = { ok: true, context: { ...context, candidates: [
    { id: 'c1', hintIndex: null, selector: '[role="dialog"] >> role=button[name="Zur Genehmigung senden"]', role: 'button', kind: 'button', name: 'Zur Genehmigung senden', disabled: false, inDialog: true, risk: 'publish', healable: false },
    { id: 'c2', hintIndex: null, selector: '#boost', role: 'button', kind: 'button', name: 'Beitrag bewerben', disabled: false, inDialog: true, risk: 'unknown', healable: false },
    { id: 'c3', hintIndex: null, selector: '#close', role: 'button', kind: 'button', name: 'Schließen', disabled: false, inDialog: true, risk: 'unknown', healable: false } ] } };

  it('an ambiguous Facebook probe gains a judgment; every deterministic field is unchanged; no draft leaves', async () => {
    stubFetch();
    h.state.evaluate = { ok: true, result: fbProbe() };
    h.state.context = dialogControls;
    const json = JSON.parse(out(await handleBrowserFbComposerState({})));
    const { judgment, ...rest } = json;
    expect(rest).toEqual(fbProbe());
    expect(judgment).toMatchObject({ advisory: true, state: 'composer_open_ready', suggestedControl: { purpose: 'submit', label: 'Zur Genehmigung senden', enabled: true } });
    expect(callsTo('semanticContext')[0].args[2]).toMatchObject({ purpose: 'social', social: true, scope: expect.stringContaining('[role="dialog"]') });
    // The promoted control is gone before Jev sees an option; the wire carries no draft, title, trigger text or evidence.
    expect(requests[0].state.controls.map((c: { name: string }) => c.name)).toEqual(['Zur Genehmigung senden', 'Schließen']);
    expect(JSON.stringify(requests)).not.toMatch(/CANARY/);
    expect(h.calls.map(c => c.fn)).toEqual(['evaluate', 'semanticContext']);
  });

  it('an unambiguous probe is returned exactly as it was, for free', async () => {
    const fetchMock = stubFetch();
    const decided = fbProbe({ submitButton: { label: 'Postar', scope: 'dialog', matchType: 'label', selector: 's', enabled: true }, recommendedAction: 'submit' });
    h.state.evaluate = { ok: true, result: decided };
    expect(out(await handleBrowserFbComposerState({}))).toBe(JSON.stringify(decided));
    const xDecided = { composerOpen: true, composerText: 'DRAFT-CANARY', charCount: 12, quoteCard: { present: false, type: 'none' }, submitButton: { present: true, enabled: true, testid: 'tweetButton' }, recommendedAction: 'submit', warnings: [] };
    h.state.xCompose = { ok: true, result: xDecided };
    expect(out(await handleBrowserXComposeState({}))).toBe(JSON.stringify(xDecided));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(callsTo('semanticContext')).toHaveLength(0);
  });

  it('an unknown X composer is judged from flags and counts only', async () => {
    stubFetch();
    Object.assign(scenario, { social: 'blocked_by_auth_or_verification', socialCandidate: 'none' });
    h.state.xCompose = { ok: true, result: { composerOpen: true, composerText: 'DRAFT-CANARY tweet', charCount: 18, overLimit: false, quoteCard: { present: true, type: 'quote', text: 'QUOTE-CANARY', author: 'AUTHOR-CANARY', url: 'https://x.com/u/status/1' }, submitButton: { present: false, enabled: false, testid: null }, isModal: true, composerCount: 1, hasStaleDraft: false, recommendedAction: 'unknown', warnings: [] } };
    h.state.context = dialogControls;
    const json = JSON.parse(out(await handleBrowserXComposeState({})));
    expect(json.composerText).toBe('DRAFT-CANARY tweet');
    expect(json.judgment).toMatchObject({ advisory: true, state: 'blocked_by_auth_or_verification' });
    expect(json.judgment).not.toHaveProperty('suggestedControl');
    expect(requests[0].state.probe).toMatchObject({ composerOpen: true, hasText: true, charCount: 18, quoteCardType: 'quote', recommendedAction: 'unknown' });
    expect(JSON.stringify(requests)).not.toMatch(/CANARY/);
  });
});
