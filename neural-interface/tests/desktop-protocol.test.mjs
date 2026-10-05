// Desktop helper protocol: framing, error shape, fit math, configure merge,
// guard semantics — and a drift guard against the Swift helper's own constants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUNDLE_PREFIX_RE, BYPASS_COMMANDS, COMMANDS, COMMAND_NAMES, ERROR_CODES, EVENTS, PROTOCOL_VERSION, READY_FEATURES,
  TARGET_CHANGED_FIELDS, compareVerify, createLineParser, encodeMessage, fitImageSize, hasBundlePrefix, helperError,
  matchGuard, mergeConfigure, normalizeVerify, validateGuardSpec, verifyText, clipGraphemes,
} from '../lib/desktop/protocol.js';
import { HELPER_SOURCE_PATH } from '../lib/desktop/build.js';
import { createFakeHelperCore } from '../lib/desktop/fake-helper.js';

const PROTOCOL_SOURCE = new URL('../lib/desktop/protocol.js', import.meta.url);
const FAKE_SOURCE = new URL('../lib/desktop/fake-helper.js', import.meta.url);
const WEB_APP = 'com.apple.Safari.WebApp.7EF0F3F3-27FA-4C9A-9D7C-74020761B996';

function collect(opts) {
  const messages = [];
  const errors = [];
  const parser = createLineParser((m) => messages.push(m), { onError: (e) => errors.push(e), ...opts });
  return { parser, messages, errors };
}

test('protocol constants', () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(COMMANDS.CLICK, 'click');
  assert.equal(COMMAND_NAMES.length, 29);
  assert.deepEqual([...BYPASS_COMMANDS].sort(), ['abort', 'cursor', 'panic', 'permissions', 'session_state', 'shutdown']);
  for (const c of BYPASS_COMMANDS) assert.ok(COMMAND_NAMES.includes(c), c);
  assert.equal(EVENTS.EMERGENCY_STOP, 'emergency_stop');
  assert.equal(Object.keys(ERROR_CODES).length, 19);
  assert.equal(ERROR_CODES.TARGET_CHANGED, 'TARGET_CHANGED');
  for (const [k, v] of Object.entries(ERROR_CODES)) assert.equal(k, v);
  assert.deepEqual(Object.values(READY_FEATURES), ['axVerify', 'guardPrefixes', 'axEnrich']);
  assert.ok(Object.isFrozen(COMMANDS) && Object.isFrozen(ERROR_CODES) && Object.isFrozen(BYPASS_COMMANDS) && Object.isFrozen(READY_FEATURES));
});

test('encodeMessage writes exactly one line per object', () => {
  const line = encodeMessage({ id: 1, cmd: 'type', args: { text: 'a\nb c' } });
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.deepEqual(JSON.parse(line), { id: 1, cmd: 'type', args: { text: 'a\nb c' } });
});

test('line parser: split chunks, several lines per chunk, split UTF-8', () => {
  const { parser, messages, errors } = collect();
  const payload = encodeMessage({ id: 1, ok: true, result: { s: 'olá 👩‍👩‍👧' } }) + encodeMessage({ event: 'ready', protocol: 1 });
  const bytes = Buffer.from(payload, 'utf8');
  // Byte-by-byte: every multi-byte character is split across chunks.
  for (let i = 0; i < bytes.length; i++) parser.push(bytes.subarray(i, i + 1));
  assert.deepEqual(messages, [{ id: 1, ok: true, result: { s: 'olá 👩‍👩‍👧' } }, { event: 'ready', protocol: 1 }]);

  messages.length = 0;
  parser.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":'));
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
  assert.equal(parser.bufferedBytes, 5);
  parser.push('3}\r\n\n  \n');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.equal(errors.length, 0);
});

test('line parser: oversize lines are reported and skipped; the stream recovers', () => {
  const { parser, messages, errors } = collect({ maxLineBytes: 64 });
  const big = JSON.stringify({ data: 'x'.repeat(200) });
  parser.push(big.slice(0, 50));
  parser.push(big.slice(50, 120)); // crosses the limit mid-line
  parser.push(`${big.slice(120)}\n{"ok":1}\n`);
  assert.deepEqual(messages, [{ ok: 1 }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'LINE_TOO_LONG');

  // A complete oversize line in one chunk.
  parser.push(`${big}\n{"ok":2}\n`);
  assert.deepEqual(messages, [{ ok: 1 }, { ok: 2 }]);
  assert.equal(errors.length, 2);
});

test('line parser: bad JSON is reported, listener errors are contained, end() flushes', () => {
  const messages = [];
  const errors = [];
  const parser = createLineParser((m) => {
    if (m.boom) throw new Error('listener failed');
    messages.push(m);
  }, { onError: (e) => errors.push(e) });
  parser.push('not json\n{"boom":true}\n{"x":1}\n{"tail":true}');
  assert.deepEqual(messages, [{ x: 1 }]);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].code, 'BAD_LINE');
  assert.equal(errors[1].message, 'listener failed');
  parser.end();
  assert.deepEqual(messages, [{ x: 1 }, { tail: true }]);
});

test('helperError carries the protocol code and details', () => {
  const e = helperError('SECURE_FIELD', 'nope', { probe: { role: 'AXTextField' } });
  assert.ok(e instanceof Error);
  assert.equal(e.code, 'SECURE_FIELD');
  assert.equal(e.message, 'nope');
  assert.deepEqual(e.details, { probe: { role: 'AXTextField' } });
  assert.equal(helperError('TIMEOUT').message, 'TIMEOUT');
  assert.equal('details' in helperError('TIMEOUT', 'x'), false);
});

test('fitImageSize follows the helper math (same cases as its --self-test)', () => {
  assert.deepEqual(pick(fitImageSize({ w: 1470, h: 956 }, { w: 1280, h: 800 }, 2)), { w: 1230, h: 800 });
  assert.deepEqual(pick(fitImageSize({ w: 1470, h: 956 }, { w: 4000, h: 4000 }, 2)), { w: 2940, h: 1912 });
  assert.deepEqual(pick(fitImageSize({ w: 1920, h: 1080 }, { w: 1024, h: 768 }, 1)), { w: 1024, h: 576 });
  assert.deepEqual(pick(fitImageSize({ w: 300, h: 200 }, { w: 1568, h: 1568 }, 2)), { w: 600, h: 400 });
  assert.deepEqual(pick(fitImageSize({ w: 300, h: 200 }, undefined, 2)), { w: 600, h: 400 });
  assert.deepEqual(fitImageSize({ w: 0, h: 10 }, { w: 1, h: 1 }), { w: 0, h: 0, factor: 0 });
  const f = fitImageSize({ w: 1470, h: 956 }, { w: 1280, h: 800 }, 2);
  assert.ok(Math.abs(f.factor - 800 / 956) < 1e-12);
});

function pick({ w, h }) {
  return { w, h };
}

test('mergeConfigure keeps omitted keys at the field level', () => {
  const a = mergeConfigure(null, { guard: { blockedApps: [{ id: 'x' }], secureField: true }, monitor: { armed: true } });
  const b = mergeConfigure(a, { monitor: { esc: false }, input: { typeChunk: 5 }, bogus: 1 });
  assert.deepEqual(b, {
    guard: { blockedApps: [{ id: 'x' }], secureField: true },
    monitor: { armed: true, esc: false },
    input: { typeChunk: 5 },
  });
  const c = mergeConfigure(b, { guard: { blockedApps: [] } });
  assert.deepEqual(c.guard, { blockedApps: [], secureField: true });
  assert.deepEqual(a.monitor, { armed: true }, 'inputs are not mutated');
});

test('matchGuard: blocked apps, protected windows, case-insensitivity, unknown titles', () => {
  const guard = {
    blockedApps: [
      { id: 'pw', bundleIds: ['com.1password.1password'], reason: 'password manager' },
      { id: 'bank', bundleIds: [], windowTitleRe: 'chase|wells fargo', reason: 'banking' },
      { id: 'term', nameRe: '^terminal$', reason: 'shell' },
      { id: 'empty', nameRe: '', windowTitleRe: '' },
    ],
    protectedWindows: [{ bundleIds: ['com.apple.Safari'], titleRe: 'keychain', reason: 'secrets' }, { titleRe: '^Private' }],
  };
  const hit = matchGuard({ bundleId: 'COM.1Password.1password', app: '1Password' }, guard, 'click');
  assert.equal(hit.code, 'BLOCKED_APP');
  assert.deepEqual(hit.details.rule, { id: 'pw', reason: 'password manager', matched: 'bundleId' });
  assert.equal(hit.details.context, 'click');
  assert.equal(matchGuard({ app: 'Chrome', windowTitle: 'Chase Online' }, guard).details.rule.matched, 'windowTitle');
  assert.equal(matchGuard({ app: 'terminal' }, guard).details.rule.id, 'term');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari', windowTitle: 'Keychain Help' }, guard).code, 'PROTECTED_WINDOW');
  assert.equal(matchGuard({ bundleId: 'com.apple.TextEdit', windowTitle: 'keychain notes' }, guard), null);
  assert.equal(matchGuard({ bundleId: 'com.apple.TextEdit', windowTitle: 'Private notes' }, guard).details.rule.index, 1);
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari', app: 'Safari' }, guard), null, 'no title → no title match');
  assert.equal(matchGuard({ app: 'Anything', windowTitle: 'Anything' }, { blockedApps: [{ nameRe: '', windowTitleRe: '' }] }), null);
  assert.equal(matchGuard({}, undefined), null);
});

test('matchGuard (protocol 2): bundle prefixes, app names, NFC', () => {
  const guard = {
    blockedApps: [{ id: 'webapps', bundlePrefixes: ['com.google.Chrome.app.'], reason: 'web apps' }],
    protectedWindows: [
      { id: 'settings', bundleIds: ['com.apple.systempreferences'], titleRe: '^(?:Câmera|Fotos)$|Privacidade\\se\\sSegurança', reason: 'settings' },
      { id: 'synabun-ui', bundleIds: ['com.apple.Safari'], bundlePrefixes: ['com.apple.Safari.WebApp.'], titleRe: 'SynaBun', appNameRe: '^(SynaBun|SynApp|Neural (Memory )?Interface)\\b', reason: 'ui' },
    ],
  };
  const blocked = matchGuard({ bundleId: 'COM.GOOGLE.CHROME.APP.abcdef', app: 'Gmail' }, guard, 'click');
  assert.deepEqual(blocked.details.rule, { id: 'webapps', reason: 'web apps', matched: 'bundlePrefix' });
  assert.equal(matchGuard({ bundleId: 'com.google.Chrome', app: 'Google Chrome' }, guard), null, 'a prefix never matches the bare browser id');
  assert.equal(matchGuard({ bundleId: 'com.google.Chrome.app', app: 'x' }, guard), null, 'the trailing dot is part of the prefix');

  // The SynaBun web app: protected by its name whatever the page title, and by title.
  const byName = matchGuard({ bundleId: WEB_APP, app: 'SynaBun', windowTitle: 'Restarting...' }, guard);
  assert.equal(byName.code, 'PROTECTED_WINDOW');
  assert.deepEqual(byName.details.rule, { index: 1, id: 'synabun-ui', reason: 'ui', matched: 'appName' });
  assert.match(byName.message, /SynaBun \(every window\) is protected/);
  assert.equal(matchGuard({ bundleId: WEB_APP, app: 'SynaBun' }, guard).code, 'PROTECTED_WINDOW', 'no title needed');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari.WebApp.X', app: 'Docs', windowTitle: 'SynaBun' }, guard).details.rule.matched, 'title');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari', app: 'Safari', windowTitle: 'Restarting...' }, guard), null, 'Safari itself is not protected by name');
  assert.equal(matchGuard({ bundleId: 'com.apple.TextEdit', app: 'SynaBun', windowTitle: 'SynaBun' }, guard), null, 'appNameRe is scoped like titleRe');
  assert.equal(matchGuard({ app: 'SynaBun Helper X' }, { protectedWindows: [{ appNameRe: '^SynaBun\\b' }] }).code, 'PROTECTED_WINDOW', 'no ids and no prefixes: any app');

  // NFC: decomposed titles / names / patterns all meet in the middle; \s covers the no-break space.
  const settings = (title) => matchGuard({ bundleId: 'com.apple.systempreferences', app: 'Ajustes do Sistema', windowTitle: title }, guard);
  assert.equal(settings('Privacidade e Segurança')?.code, 'PROTECTED_WINDOW');
  assert.equal(settings('Privacidade e Segurança')?.code, 'PROTECTED_WINDOW');
  assert.equal(settings('Câmera')?.code, 'PROTECTED_WINDOW', 'anchored name in NFD');
  assert.equal(settings('Câmera lenta'), null, 'anchored names match the whole title only');
  assert.equal(settings('Aparência'), null);
  assert.equal(matchGuard({ windowTitle: 'Segurança' }, { protectedWindows: [{ titleRe: 'Segurança' }] })?.code, 'PROTECTED_WINDOW', 'NFD pattern');
  assert.equal(matchGuard({ app: 'Café' }, { blockedApps: [{ id: 'c', nameRe: '^Café$' }] })?.details.rule.matched, 'name');

  assert.equal(hasBundlePrefix('com.apple.Safari.WebApp.1', ['com.apple.safari.webapp.']), true);
  assert.equal(hasBundlePrefix('com.apple.Safari', ['com.apple.Safari.WebApp.']), false);
  assert.equal(hasBundlePrefix(null, ['a.b.']), false);
});

test('validateGuardSpec rejects what the helper would refuse', () => {
  validateGuardSpec({ blockedApps: [{ id: 'a', nameRe: 'x|y' }], protectedWindows: [{ titleRe: 'z' }] });
  validateGuardSpec(undefined);
  validateGuardSpec({
    blockedApps: [{ id: 'w', bundlePrefixes: ['com.apple.Safari.WebApp.', 'org.chromium.Chromium.app.'] }],
    protectedWindows: [{ appNameRe: '^SynaBun\\b', bundlePrefixes: [] }, { titleRe: 'x', appNameRe: 'y' }],
  });
  for (const bad of [
    'nope', [], { blockedApps: {} }, { blockedApps: [null] }, { blockedApps: [{ nameRe: '(' }] },
    { protectedWindows: [{}] }, { protectedWindows: [{ titleRe: '' }] }, { protectedWindows: [{ titleRe: '[' }] },
    { protectedWindows: [{ appNameRe: '(' }] }, { protectedWindows: [{ titleRe: '', appNameRe: '' }] },
    { blockedApps: [{ bundlePrefixes: 'com.apple.' }] }, { protectedWindows: [{ titleRe: 'x', bundlePrefixes: [5] }] },
    ...['com.apple.Safari', 'com.', '.com.apple.', 'com..apple.', 'com apple.', '', 'com.apple.*.'].map((p) => ({ blockedApps: [{ bundlePrefixes: [p] }] })),
  ]) {
    assert.throws(() => validateGuardSpec(bad), (e) => e.code === 'BAD_ARGS', JSON.stringify(bad));
  }
  assert.ok(BUNDLE_PREFIX_RE.test('com.apple.Safari.WebApp.') && !BUNDLE_PREFIX_RE.test('com.apple.Safari'));
});

test('verify: normalizeVerify reads what the helper reads; compareVerify names the first failed check', () => {
  const want = normalizeVerify({ pid: 42, role: 'AXButton', subrole: null, title: ' Voltar ', help: 'Go back', identifier: 'back' });
  assert.deepEqual(want, { pid: 42, role: 'AXButton', subrole: '', title: 'Voltar', description: '', help: 'Go back', identifier: 'back' });
  for (const [verify, action] of [
    ['yes', 'press'], [[], 'press'], [{ pid: 42, role: 'AXButton' }, 'toggle'], [{ role: 'AXButton' }, 'press'], [{ pid: 0, role: 'AXButton' }, 'press'],
    [{ pid: true, role: 'AXButton' }, 'press'], [{ pid: 42 }, 'press'], [{ pid: 42, role: '  ' }, 'press'], [{ pid: 42, role: 'AXButton', title: 5 }, 'press'],
  ]) {
    assert.throws(() => normalizeVerify(verify, action), (e) => e.code === 'BAD_ARGS', JSON.stringify([verify, action]));
  }
  const facts = {
    pid: 42, frontmostPid: 42, role: 'AXButton', title: 'Voltar', help: 'Go back', identifier: 'back', enabled: true,
    canPress: true, ancestorRoles: ['AXGroup', 'AXToolbar'], windowSubrole: 'AXStandardWindow', inFocusedWindow: true,
  };
  assert.equal(compareVerify(want, facts), null);
  const cases = [
    [{ pid: 43 }, 'pid'], [{ frontmostPid: 1 }, 'frontmost'], [{ role: 'AXLink' }, 'role'], [{ subrole: 'AXCloseButton' }, 'subrole'],
    [{ title: 'Apagar' }, 'title'], [{ description: 'x' }, 'description'], [{ help: null }, 'help'], [{ identifier: 'y' }, 'identifier'],
    [{ enabled: false }, 'enabled'], [{ enabled: undefined }, 'enabled'], [{ secure: true }, 'secure'], [{ canPress: false }, 'press'],
    [{ ancestorRoles: ['AXSheet'] }, 'sheet'], [{ ancestorRoles: ['AXPopover'] }, 'popover'], [{ windowSubrole: 'AXDialog' }, 'dialog'],
    [{ windowModal: true }, 'modal'], [{ focusedWindowIsSheet: true }, 'sheet'], [{ inFocusedWindow: false }, 'window'], [{ windowHasSheet: true }, 'sheet'],
  ];
  for (const [change, field] of cases) assert.equal(compareVerify(want, { ...facts, ...change }), field, JSON.stringify(change));
  assert.deepEqual([...new Set(cases.map(([, field]) => field))].sort(), [...TARGET_CHANGED_FIELDS].sort(), 'every field is reachable');
  assert.equal(compareVerify(normalizeVerify({ pid: 42, role: 'AXButton', title: 'Segurança', help: 'Go back', identifier: 'back' }), { ...facts, title: 'Segurança' }), null, 'NFC');
  const seen = 'a'.repeat(200);
  assert.equal(compareVerify({ ...want, title: seen }, { ...facts, title: `${seen} and more` }), null, 'text past the snapshot limit is ignored');
  assert.equal(verifyText(null, 10), '');
  assert.equal(verifyText('👩‍👩‍👧 x', 1).length > 0, true);
});

test('the Swift helper speaks the same protocol (drift guard)', () => {
  const src = readFileSync(HELPER_SOURCE_PATH, 'utf8');
  assert.equal(Number(src.match(/let PROTOCOL_VERSION = (\d+)/)?.[1]), PROTOCOL_VERSION);
  const bypass = src.match(/static let bypass: Set<String> = \[([^\]]*)\]/)?.[1];
  assert.ok(bypass, 'bypass set literal');
  assert.deepEqual(bypass.match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1)).sort(), [...BYPASS_COMMANDS].sort());
  const execute = src.slice(src.indexOf('enum Commands'), src.indexOf('enum Dispatcher'));
  for (const cmd of COMMAND_NAMES) assert.ok(execute.includes(`case "${cmd}"`), `helper handles ${cmd}`);
  const codes = new Set([...src.matchAll(/HelperError\("([A-Z_]+)"/g)].map((m) => m[1]));
  for (const code of codes) assert.ok(ERROR_CODES[code], `helper error code ${code} is in ERROR_CODES`);
  for (const name of Object.values(EVENTS)) assert.ok(src.includes(`"${name}"`), `helper emits ${name}`);
  assert.ok(src.includes('0x53594E42'), 'SYNB stamp');
});

/** The body of a function in a source file (from its declaration to the next top-level declaration). */
function body(src, start, end = /\n(?:func |export function |function |let |const |struct |enum |\/\/ MARK)/g) {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} not found`);
  end.lastIndex = at + start.length;
  const next = end.exec(src);
  return src.slice(at, next ? next.index : undefined);
}

function listLiteral(src, name) {
  const m = src.match(new RegExp(`\\b${name}(?:: Set<String>)? = (?:new Set\\()?\\[([^\\]]*)\\]`));
  assert.ok(m, `${name} literal`);
  return [...m[1].matchAll(/["']([A-Za-z]+)["']/g)].map((x) => x[1]).sort();
}

test('the Swift helper speaks protocol 2 (drift guard)', () => {
  const src = readFileSync(HELPER_SOURCE_PATH, 'utf8');
  const js = readFileSync(PROTOCOL_SOURCE, 'utf8');
  const fake = readFileSync(FAKE_SOURCE, 'utf8');
  for (const needle of ['bundlePrefixes', 'appNameRe', 'verifyTarget(', '"TARGET_CHANGED"', 'precomposedStringWithCanonicalMapping']) {
    assert.ok(src.includes(needle), `helper source has ${needle}`);
  }
  // The final check sits after the guard and right before the action switch.
  const action = body(src, 'func cmdAxAction(');
  const guardAt = action.indexOf('matchGuard(');
  const verifyAt = action.indexOf('verifyTarget(');
  const switchAt = action.indexOf('switch action');
  assert.ok(guardAt > 0 && guardAt < verifyAt && verifyAt < switchAt, `order: matchGuard ${guardAt} < verifyTarget ${verifyAt} < switch ${switchAt}`);
  assert.ok(action.indexOf('parseVerify(') < action.indexOf('Snapshots.element('), 'verify arguments are checked before anything is read');
  // Same checks, same order, same field names and limits as protocol.js compareVerify.
  const swiftCompare = body(src, 'func verifyCompare(');
  const jsCompare = body(js, 'export function compareVerify(');
  const returns = (text, q) => [...text.matchAll(new RegExp(`return ${q}([a-z]+)${q}`, 'g'))].map((m) => m[1]);
  assert.deepEqual(returns(swiftCompare, '"'), returns(jsCompare, "'"));
  assert.deepEqual([...new Set(returns(swiftCompare, '"'))].sort(), [...TARGET_CHANGED_FIELDS].sort());
  const limits = (text) => [...text.matchAll(/verifyText\(f\.(\w+), (\d+)\)/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(limits(swiftCompare), ['role:200', 'subrole:200', 'title:200', 'description:200', 'help:200', 'identifier:120']);
  assert.deepEqual(limits(jsCompare), limits(swiftCompare));
  // Guards: the prefix rule is the same regex.
  const swiftPrefix = src.match(/let BUNDLE_PREFIX_PATTERN = "([^"]+)"/)?.[1]?.replace(/\\\\/g, '\\');
  assert.equal(swiftPrefix, BUNDLE_PREFIX_RE.source);
  // Snapshot: new attributes and the tables the fake mirrors.
  const attrs = src.match(/let SNAPSHOT_ATTRS = \[([^\]]*)\]/)?.[1] || '';
  for (const attr of ['AXHelp', 'AXPlaceholderValue', 'AXIdentifier', 'AXTitleUIElement', 'AXModal']) assert.ok(attrs.includes(`"${attr}"`), attr);
  for (const table of ['GROUP_ROLES', 'BARE_GROUP_ROLES', 'DIALOG_SUBROLES', 'ROW_ROLES']) {
    assert.deepEqual(listLiteral(src, table), listLiteral(fake, table), `fake ${table} mirrors the helper`);
  }
  // Ready features: the helper and the fake announce the same protocol-2 flags.
  const ready = body(src, 'static func emitReady(', /\n    static func /g);
  for (const flag of Object.values(READY_FEATURES)) assert.ok(ready.includes(`"${flag}": true`), `helper announces ${flag}`);
  const fakeFeatures = createFakeHelperCore().readyEvent().features;
  for (const flag of Object.values(READY_FEATURES)) assert.equal(fakeFeatures[flag], true, `fake announces ${flag}`);
});

// ── verify contract: what the snapshot showed, clipped and trimmed, still verifies ──
// The helper clips title / description / help to 200 and identifier to 120 in a
// snapshot; the Neural Interface sends those values back trimmed (desktop-risk.ts
// verifyFacts, String.prototype.trim); the helper compares them with the live
// label after verifyText. Clipping must happen in the same unit on both sides
// (grapheme clusters, Swift's Character), and the trims must agree, or a long
// or decomposed label would read as TARGET_CHANGED and nothing could be pressed.

const GRAPHEME = new Intl.Segmenter('en', { granularity: 'grapheme' });

test('verify contract: clipGraphemes cuts where Swift\'s String.prefix does, whatever the normalization', () => {
  assert.equal(clipGraphemes('abc', 2), 'ab');
  assert.equal(clipGraphemes('abc', 10), 'abc');
  assert.equal(clipGraphemes('e\u0301'.repeat(3), 2), 'e\u0301e\u0301', 'a letter and its combining mark are one character');
  assert.equal(clipGraphemes('👩‍👩‍👧x', 1), '👩‍👩‍👧');
  assert.equal(verifyText('👩‍👩‍👧 x', 1), '👩‍👩‍👧');
  assert.equal(verifyText('e\u0301'.repeat(250), 200), 'é'.repeat(200), 'NFC after the same cut');
  assert.equal(verifyText('\uFEFF Voltar \u0085', 200), 'Voltar', 'the trim set is JavaScript\'s \\s plus NEL');
});

test('verify contract: long, decomposed and BOM-edged labels verify against their snapshot copy through the fake helper', async () => {
  const long = 'Mover para o Lixo '.repeat(15);
  const nfd = 'Seguranc\u0327a '.repeat(30);
  const core = createFakeHelperCore({
    frontmostPid: 303,
    apps: [{ pid: 303, bundleId: 'com.apple.TextEdit', name: 'TextEdit' }],
    windows: [{ windowId: 9, pid: 303, title: 'Doc', bounds: { x: 0, y: 0, w: 800, h: 600 }, layer: 0, onScreen: true }],
    axTrees: {
      303: {
        role: 'AXWindow', title: 'Doc', children: [
          { id: 'long', role: 'AXButton', title: long, actions: ['AXPress'] },
          { id: 'nfd', role: 'AXButton', title: nfd, description: nfd, help: long, identifier: `id-${'x'.repeat(200)}`, actions: ['AXPress'] },
          { id: 'bom', role: 'AXButton', title: '\uFEFFVoltar\uFEFF', help: ' Volta ', actions: ['AXPress'] },
        ],
      },
    },
  });
  core.start();
  let id = 1;
  const call = (cmd, args = {}) => core.handle({ id: id++, cmd, args });
  const snap = (await call('ax_snapshot')).result;
  const buttons = snap.nodes.filter((node) => node.role === 'AXButton');
  assert.equal(buttons.length, 3);
  assert.equal([...GRAPHEME.segment(buttons[1].title)].length, 200, 'the snapshot keeps 200 characters');
  assert.equal(buttons[1].identifier.length, 120);
  // Exactly what the Neural Interface sends (desktop-risk.ts verifyFacts).
  const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const verifyOf = (node) => ({ pid: 303, role: node.role, subrole: trimmed(node.subrole), title: trimmed(node.title), description: trimmed(node.description), help: trimmed(node.help), identifier: trimmed(node.identifier) });
  for (const node of buttons) {
    const reply = await call('ax_action', { snapshotId: snap.snapshotId, ref: node.ref, action: 'press', verify: verifyOf(node) });
    assert.equal(reply.ok, true, `${node.ref}: ${JSON.stringify(reply.error)}`);
  }
  assert.equal((await call('__fake_state')).result.actions.filter((a) => a.cmd === 'ax_action' && a.verified).length, 3);
  // A real change inside the kept part is still caught.
  await call('__fake_set', { axPatch: [{ id: 'nfd', patch: { title: `X${nfd}` } }] });
  const changed = await call('ax_action', { snapshotId: snap.snapshotId, ref: buttons[1].ref, action: 'press', verify: verifyOf(buttons[1]) });
  assert.deepEqual([changed.ok, changed.error.code, changed.error.details.field], [false, 'TARGET_CHANGED', 'title']);
});

test('verify contract: the helper clips and trims the way protocol.js and the fake do (drift guard)', () => {
  const src = readFileSync(HELPER_SOURCE_PATH, 'utf8');
  const js = readFileSync(PROTOCOL_SOURCE, 'utf8');
  const fake = readFileSync(FAKE_SOURCE, 'utf8');
  // Swift: NFC → prefix(limit) Characters → trimmed with VERIFY_TRIM (.whitespacesAndNewlines + U+FEFF).
  assert.match(src, /let VERIFY_TRIM = CharacterSet\.whitespacesAndNewlines\.union\(CharacterSet\(charactersIn: "\\u\{FEFF\}"\)\)/);
  assert.match(body(src, 'func verifyText('), /String\(nfc\(s\)\.prefix\(limit\)\)\.trimmingCharacters\(in: VERIFY_TRIM\)/);
  assert.match(body(src, 'func trimmed('), /s\.prefix\(limit\)/, 'the snapshot clips in Characters too');
  // JS: the same unit and the same set.
  assert.match(body(js, 'export function verifyText('), /clipGraphemes\(String\(value\)\.normalize\('NFC'\), limit\)\.replace\(VERIFY_TRIM_RE, ''\)/);
  assert.match(js, /const VERIFY_TRIM_RE = \/\^\[\\s\\u0085\]\+\|\[\\s\\u0085\]\+\$\/gu;/);
  assert.match(fake, /const clip = \(s, n\) => clipGraphemes\(s, n\);/);
});
