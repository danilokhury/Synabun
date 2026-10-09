import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { resolveBrowserLanguage, validateBrowserLanguageConfig } from '../lib/browser-language.js';

const DEFAULT_HEADER = 'en-US,en;q=0.9';
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `server.js markers found: ${start}, ${end}`);
  return source.slice(from, to);
}

const languageCases = [
  ['automatic wildcard', {}, '*', 'en-US', '*', ['en-US']],
  ['wildcard before concrete language', {}, '*,pt-BR;q=0.9', 'pt-BR', '*,pt-BR;q=0.9', ['pt-BR']],
  ['zero quality excluded', {}, 'en-US;q=0,pt-BR;q=0.9', 'pt-BR', 'en-US;q=0,pt-BR;q=0.9', ['pt-BR']],
  ['all qualities zero', {}, 'pt-BR;q=0,en;q=0.000', 'en-US', 'pt-BR;q=0,en;q=0.000', ['en-US']],
  ['saved locale canonicalized', { locale: ' PT-br ' }, '*', 'pt-BR', '*', ['pt-BR']],
  ['saved locale overrides header locale', { locale: 'pt-BR' }, 'en-US', 'pt-BR', 'en-US', ['en-US']],
  ['header order preserved across weights', {}, 'en-US;q=0.1,pt-BR;q=1', 'en-US', 'en-US;q=0.1,pt-BR;q=1', ['en-US', 'pt-BR']],
  ['canonical deduplication', {}, 'pt-br,PT-BR;q=0.5,pt;q=0.9,*', 'pt-BR', 'pt-br,PT-BR;q=0.5,pt;q=0.9,*', ['pt-BR', 'pt']],
  ['script and numeric region', {}, 'zh-Hant-TW,es-419;q=0.8', 'zh-Hant-TW', 'zh-Hant-TW,es-419;q=0.8', ['zh-Hant-TW', 'es-419']],
  ['HTTP range unsuitable for Intl locale', {}, 'x-private,pt-BR;q=0.9', 'pt-BR', 'x-private,pt-BR;q=0.9', ['pt-BR']],
  ['empty HTTP list elements ignored', {}, ' ,pt-BR,,en;q=0.9, ', 'pt-BR', ',pt-BR,,en;q=0.9,', ['pt-BR', 'en']],
  ['saved header precedes request', { acceptLanguage: 'pt-BR,pt;q=0.9' }, 'en-US', 'pt-BR', 'pt-BR,pt;q=0.9', ['pt-BR', 'pt']],
  ['defaults', {}, undefined, 'en-US', DEFAULT_HEADER, ['en-US', 'en']],
];
for (const [name, config, header, locale, acceptLanguage, languages] of languageCases) {
  test(`language resolution: ${name}`, () => {
    assert.deepEqual(resolveBrowserLanguage(config, header), { locale, acceptLanguage, languages, warnings: [] });
  });
}

test('invalid legacy settings fall back without modifying the saved object', () => {
  const config = { locale: '*', acceptLanguage: 'pt_BR', channel: 'msedge', secret: 'do-not-log' };
  const original = { ...config };
  assert.deepEqual(resolveBrowserLanguage(config, 'pt-BR,pt;q=0.9'), {
    locale: 'pt-BR', acceptLanguage: 'pt-BR,pt;q=0.9', languages: ['pt-BR', 'pt'],
    warnings: [{ field: 'locale', value: 'pt-BR' }, { field: 'acceptLanguage', value: 'pt-BR,pt;q=0.9' }],
  });
  assert.deepEqual(config, original);
});

test('wrong legacy field types cannot throw or bypass the default language', () => {
  for (const value of [0, 42, false, true, [], ['pt-BR'], {}]) {
    const result = resolveBrowserLanguage({ locale: value, acceptLanguage: value }, '*');
    assert.equal(result.locale, 'en-US');
    assert.equal(result.acceptLanguage, '*');
    assert.deepEqual(result.languages, ['en-US']);
    assert.deepEqual(result.warnings.map(warning => warning.field), ['locale', 'acceptLanguage']);
  }
});

test('missing, null and blank fields are automatic without warnings', () => {
  for (const value of [undefined, null, '', ' \t ']) {
    assert.deepEqual(resolveBrowserLanguage({ locale: value, acceptLanguage: value }, value), {
      locale: 'en-US', acceptLanguage: DEFAULT_HEADER, languages: ['en-US', 'en'], warnings: [],
    });
  }
});

test('malformed incoming headers use defaults, but a valid saved header takes precedence', () => {
  for (const header of ['en_US', 'pt-BR;q=2', 'en-US\r\nX-Other: value', ['pt-BR']]) {
    const result = resolveBrowserLanguage({}, header);
    assert.equal(result.locale, 'en-US');
    assert.equal(result.acceptLanguage, DEFAULT_HEADER);
    assert.deepEqual(result.warnings, [{ field: 'request Accept-Language', value: DEFAULT_HEADER }]);
    assert.deepEqual(resolveBrowserLanguage({ acceptLanguage: 'pt-BR' }, header).warnings, []);
  }
});

test('save validation canonicalizes fields and preserves the rest without mutating input', () => {
  const config = { locale: ' PT-br ', acceptLanguage: ' pt-BR,pt;q=0.900,*;q=0.1 ', channel: 'msedge', proxy: { server: 'proxy' } };
  const normalized = validateBrowserLanguageConfig(config);
  assert.deepEqual(normalized, { ...config, locale: 'pt-BR', acceptLanguage: 'pt-BR,pt;q=0.900,*;q=0.1' });
  assert.equal(config.locale, ' PT-br ');
  assert.equal(config.acceptLanguage, ' pt-BR,pt;q=0.900,*;q=0.1 ');
  assert.notEqual(normalized, config);
  assert.deepEqual(validateBrowserLanguageConfig({ channel: 'msedge' }), { channel: 'msedge' });
  for (const value of [undefined, null, '', ' \t ']) {
    assert.deepEqual(validateBrowserLanguageConfig({ locale: value, acceptLanguage: value }), { locale: null, acceptLanguage: null });
  }
});

test('save validation rejects wildcard locales, lists, malformed tags and wrong types', () => {
  for (const locale of ['*', 'pt_BR', 'pt-BR,en-US', 'en-US;q=0.9', 0, true, ['pt-BR'], {}]) {
    assert.throws(() => validateBrowserLanguageConfig({ locale }), error => {
      assert.equal(error.status, 400);
      assert.equal(error.field, 'locale');
      assert.match(error.message, /single locale tag/);
      return true;
    });
  }
});

test('HTTP wildcards and valid qvalue boundaries are accepted on save', () => {
  for (const header of ['*', '*;q=0.5', 'pt-BR;q=0', 'pt-BR;q=0.001', 'pt-BR;q=0.123', 'pt-BR;q=1', 'pt-BR;q=1.000', 'pt-BR;q=0.', 'pt-BR;q=1.', 'pt-BR; Q = 0.900']) {
    assert.equal(validateBrowserLanguageConfig({ acceptLanguage: header }).acceptLanguage, header);
  }
});

test('save validation rejects malformed HTTP language ranges, weights and field types', () => {
  for (const acceptLanguage of ['pt_BR', 'en-*', ',', 'pt-BR;q=-1', 'pt-BR;q=2', 'pt-BR;q=1.001', 'pt-BR;q=0.1234', 'pt-BR;q=.9', 'pt-BR;q=NaN', 'pt-BR;q=0.9;q=0.8', 'pt-BR;unknown=1', '\npt-BR', 'pt-BR\u0000', 0, false, ['pt-BR'], {}]) {
    assert.throws(() => validateBrowserLanguageConfig({ acceptLanguage }), error => {
      assert.equal(error.status, 400);
      assert.equal(error.field, 'acceptLanguage');
      return true;
    });
  }
});

// Run the real session function against simulated Windows Edge contexts. VM imports
// are disabled, so the optional child_process scan cannot execute any real commands.
function sessionHarness(config = {}) {
  const launches = [], contextOptions = [], scripts = [], warnings = [];
  const browserSessions = new Map();
  let currentUrl = 'about:blank';
  const page = {
    goto: async url => { currentUrl = url; }, url: () => currentUrl,
    title: async () => 'Fixture', waitForLoadState: async () => {}, on: () => {},
    context: () => browserContext,
  };
  const browserContext = {
    pages: () => [{ close: async () => {} }], newPage: async () => page, on: () => {},
    newCDPSession: async () => ({
      send: async (method, params) => { if (method === 'Page.addScriptToEvaluateOnNewDocument') scripts.push(params.source); return {}; },
      detach: async () => {},
    }),
  };
  const chromium = {
    launch: async options => {
      launches.push({ mode: 'clean', options });
      return { newContext: async options => { contextOptions.push(options); return browserContext; } };
    },
    launchPersistentContext: async (root, options) => {
      launches.push({ mode: 'persistent', root, options });
      contextOptions.push(options);
      return browserContext;
    },
  };
  let post;
  const context = vm.createContext({
    console: { log: () => {}, error: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
    process: { platform: 'win32', pid: 123, env: { USERPROFILE: 'C:/Users/fixture', LOCALAPPDATA: 'C:/Users/fixture/AppData/Local' } },
    IS_WIN: true, DATA_HOME: 'C:/synabun', resolve, createHash, randomBytes,
    setTimeout: callback => { callback(); },
    loadBrowserConfig: () => ({ browser: 'msedge', persistStorage: false, ...config }),
    browserConfigUnreadable: () => null, resolveBrowserLanguage,
    findBrowserExecutable: () => 'C:/fake/msedge.exe',
    getManagedProfileRoot: () => 'C:/synabun/browser-profiles/synabun',
    lookupDetectedProfile: () => null, existsSync: () => false,
    chromium, browserSessions, attachConsoleBuffer: () => {},
    installMoneyGuardRoute: async () => {}, moreLoginBlockError: () => null,
    broadcastSync: () => {}, app: { post: (_path, handler) => { post = handler; } },
  });
  vm.runInContext(between('async function createBrowserSession(', '/**\n * Start CDP screencast'), context);
  vm.runInContext(between("app.post('/api/browser/sessions',", "app.delete('/api/browser/sessions/:id'"), context);
  return { context, launches, contextOptions, scripts, warnings, post };
}

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
  };
}

test('actual session POST accepts the MCP wildcard header and launches the selected Edge', async () => {
  const h = sessionHarness({ locale: null, acceptLanguage: null });
  const res = response();
  await h.post({ body: { url: 'about:blank' }, headers: { 'accept-language': '*' }, get: () => undefined }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profileMode, 'clean');
  assert.equal(h.launches[0].options.channel, 'msedge');
  assert.equal(h.contextOptions[0].locale, 'en-US');
  assert.equal(h.contextOptions[0].extraHTTPHeaders['Accept-Language'], '*');
  assert.deepEqual(h.warnings, []);
});

test('actual persistent session receives a concrete locale even when the wildcard comes first', async () => {
  const h = sessionHarness({ userDataDir: 'C:/fixture-profile', locale: null, acceptLanguage: null });
  const result = await h.context.createBrowserSession({ _realHeaders: { 'accept-language': '*,pt-BR;q=0.9' } });
  assert.equal(result.profileMode, 'direct');
  assert.equal(h.launches[0].mode, 'persistent');
  assert.equal(h.launches[0].options.channel, 'msedge');
  assert.equal(h.contextOptions[0].locale, 'pt-BR');
  assert.equal(h.contextOptions[0].extraHTTPHeaders['Accept-Language'], '*,pt-BR;q=0.9');
});

test('actual stealth injection exposes concrete canonical languages without duplicates or q=0', async () => {
  for (const [header, expected] of [
    ['*,pt-br;q=0.9,PT-BR;q=0.8,en-US;q=0', ['pt-BR']],
    ['*', ['en-US']],
  ]) {
    const h = sessionHarness();
    await h.context.createBrowserSession({ _realHeaders: { 'accept-language': header } });
    assert.equal(h.scripts.length, 1);
    const globals = vm.createContext({ navigator: {}, window: { Permissions: { prototype: { query: () => {} } } } });
    vm.runInContext(h.scripts[0], globals);
    assert.deepEqual(Array.from(globals.navigator.languages), expected);
  }
});

test('actual session logs legacy language fallbacks without exposing unrelated settings', async () => {
  const h = sessionHarness({ locale: '*', acceptLanguage: false, secret: 'private-setting' });
  await h.context.createBrowserSession({ _realHeaders: { 'accept-language': 'pt-BR' } });
  assert.equal(h.contextOptions[0].locale, 'pt-BR');
  assert.deepEqual(h.warnings, ['[browser] Invalid locale; using "pt-BR"', '[browser] Invalid acceptLanguage; using "pt-BR"']);
  assert.ok(h.warnings.every(warning => !warning.includes('private-setting')));
});

test('actual context preserves extraHTTPHeaders override precedence', async () => {
  const h = sessionHarness({ extraHTTPHeaders: { 'Accept-Language': 'de-DE', 'X-Custom': 'fixture' } });
  await h.context.createBrowserSession({ _realHeaders: { 'accept-language': '*' } });
  assert.equal(h.contextOptions[0].locale, 'en-US');
  assert.equal(h.contextOptions[0].extraHTTPHeaders['Accept-Language'], 'de-DE');
  assert.equal(h.contextOptions[0].extraHTTPHeaders['X-Custom'], 'fixture');
});

function configHarness({ saveError } = {}) {
  let put;
  const saves = [], invalidations = [];
  const context = vm.createContext({
    app: { put: (_path, handler) => { put = handler; } },
    validateBrowserLanguageConfig,
    saveBrowserConfig: body => { if (saveError) throw saveError; saves.push(body); },
    PACKAGE_ROOT: '/fixture', resolve,
    // A URL resolution starts cache invalidation; no VM module import is permitted.
    pathToFileURL: path => { invalidations.push(path); return { href: 'file:///browser-test-stub.mjs' }; },
  });
  vm.runInContext(between("app.put('/api/browser/config',", '// Detect Chrome/Edge/Chromium profiles'), context);
  return { saves, invalidations, put };
}

test('actual config PUT rejects invalid fields before persistence or cache invalidation', () => {
  const h = configHarness();
  for (const [body, field] of [
    [{ locale: '*' }, 'locale'], [{ locale: ['pt-BR'] }, 'locale'],
    [{ locale: 'pt-br', acceptLanguage: 'pt-BR;q=2' }, 'acceptLanguage'],
    [{ acceptLanguage: {} }, 'acceptLanguage'],
  ]) {
    const original = JSON.stringify(body);
    const res = response();
    h.put({ body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.field, field);
    assert.match(res.body.error, new RegExp(`Invalid ${field}`));
    assert.equal(JSON.stringify(body), original);
  }
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.invalidations, []);
});

test('actual config PUT persists canonical locales, HTTP wildcards and automatic fields', () => {
  for (const [body, expected] of [
    [{ locale: ' PT-br ', acceptLanguage: ' * ', channel: 'msedge' }, { locale: 'pt-BR', acceptLanguage: '*', channel: 'msedge' }],
    [{ locale: '', acceptLanguage: ' \t ' }, { locale: null, acceptLanguage: null }],
    [{ locale: null, acceptLanguage: null }, { locale: null, acceptLanguage: null }],
    [{ channel: 'msedge' }, { channel: 'msedge' }],
  ]) {
    const h = configHarness();
    const res = response();
    h.put({ body }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(h.saves, [expected]);
    assert.equal(h.invalidations.length, 1);
  }
});

test('actual config PUT keeps persistence failures as HTTP 500 without invalidating caches', () => {
  const h = configHarness({ saveError: new Error('write failed') });
  const res = response();
  h.put({ body: { locale: 'pt-BR' } }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'write failed' });
  assert.deepEqual(h.invalidations, []);
});
