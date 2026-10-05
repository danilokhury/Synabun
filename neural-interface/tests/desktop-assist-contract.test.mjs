// Source contracts for computer_ax intent and press by intent: orderings and
// boundaries a behavioural test cannot see, because breaking them only matters
// in a race or in a process that was started with a stale build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROWSER_BUNDLES, WEB_APP_BUNDLE_PREFIXES } from '../lib/desktop/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktopDir = `${root}/lib/desktop`;
const service = readFileSync(`${desktopDir}/service.js`, 'utf8');
const contexts = readFileSync(`${desktopDir}/press-contexts.js`, 'utf8');
const server = readFileSync(`${root}/server.js`, 'utf8');
const mcpAssist = readFileSync(fileURLToPath(new URL('../../mcp-server/src/services/desktop-assist.ts', import.meta.url)), 'utf8');

const between = (src, start, end) => {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} … ${end} not found`);
  return src.slice(from, to);
};
const pressByIntent = between(service, 'async function pressByIntent(', 'function pressFailure(');
const intentSnapshot = between(service, 'async function intentSnapshot(', 'async function pressByIntent(');

test('lib/desktop never imports mcp-server or the TypeSafe client: the rules and the gate are injected', () => {
  const files = readdirSync(desktopDir).filter((name) => name.endsWith('.js'));
  assert.ok(files.includes('service.js') && files.includes('press-contexts.js'));
  const seen = new Set();
  for (const name of files) {
    const src = readFileSync(`${desktopDir}/${name}`, 'utf8');
    const specifiers = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of specifiers) {
      seen.add(spec);
      assert.doesNotMatch(spec, /mcp-server|typesafe|judgments|desktop-risk|desktop-assist/i, `${name} imports ${spec}`);
    }
    assert.doesNotMatch(src, /\bjudge[A-Z]?\w*\(/, `${name} must never ask for a judgment`);
  }
  // The scan itself works: it finds the imports that are there.
  for (const spec of ['./press-contexts.js', './audit.js', './protocol.js', 'node:crypto']) assert.ok(seen.has(spec), spec);
});

test('press by intent: the context is spent before the gate, and ax() routes a context before its own gate', () => {
  const consume = pressByIntent.indexOf('pressContexts.consume(');
  const gate = pressByIntent.indexOf('await gate(token)');
  assert.ok(consume > 0 && gate > consume, 'consume before gate');
  assert.ok(pressByIntent.indexOf("refuse('mixed_target')") > consume && pressByIntent.indexOf("refuse('mixed_target')") < gate);
  const ax = between(service, 'async function ax(token', 'function candidateTags(');
  const routed = ax.indexOf('input?.press_context !== undefined) return pressByIntent(');
  assert.ok(routed > 0 && routed < ax.indexOf('await gate(token)'), 'a press context never reaches the ordinary gate first');
  // The store deletes before it validates.
  const consumeBody = between(contexts, 'function consume(', 'function dropAll(');
  assert.ok(consumeBody.indexOf('forget(contextId)') < consumeBody.indexOf('expired_context'));
  assert.ok(consumeBody.indexOf('expired_context') < consumeBody.indexOf('foreign_context'));
});

test('press by intent: nothing is awaited between the last pressGate() and the helper request, which carries verify', () => {
  const request = pressByIntent.indexOf("helper('ax_action'");
  assert.ok(request > 0, 'the press request located');
  // The call itself (a comment may mention pressGate() too).
  const lastGate = pressByIntent.lastIndexOf('= pressGate()', request);
  assert.ok(lastGate > 0, 'pressGate() is read before the request');
  const gap = pressByIntent.slice(lastGate, request);
  assert.doesNotMatch(gap, /\bawait\b/, `nothing may be awaited here: ${gap}`);
  const call = pressByIntent.slice(request, pressByIntent.indexOf('\n', request));
  assert.match(call, /action: 'press', verify: entry\.verify \}/);
  assert.equal(pressByIntent.split("helper('ax_action'").length - 1, 1, 'one request, never repeated');
  // Every re-check runs in the queue, before the gate read that closes the window.
  for (const check of ["refuse('not_pressable')", "refuse('helper_outdated')", "refuse('user_input'", "refuse('stopped')"]) {
    const at = pressByIntent.indexOf(check);
    assert.ok(at > pressByIntent.indexOf('exclusive(') && at < lastGate, check);
  }
  assert.ok(pressByIntent.indexOf("refuse('locked')") > lastGate && pressByIntent.indexOf("refuse('locked')") < request);
  assert.match(pressByIntent, /desktopRisk\.pressableEntry\(entry\)/, 'the stored entry is re-derived, never trusted');
});

test('intent snapshot: the guard check runs before any candidate is built; a context needs purpose, the gate and a verifying helper', () => {
  assert.ok(intentSnapshot.indexOf('matchGuard(') > 0 && intentSnapshot.indexOf('matchGuard(') < intentSnapshot.indexOf('buildDesktopCandidates('));
  assert.match(intentSnapshot, /enrich: true/);
  assert.match(intentSnapshot, /value: null \}/, 'lines are built without the value');
  const mint = intentSnapshot.slice(intentSnapshot.indexOf("if (input.purpose === 'press')"), intentSnapshot.indexOf('pressContexts.mint('));
  for (const needle of ['pressGate()', 'helperSupportsVerify()', 'desktopRisk.pressableEntry']) assert.ok(mint.includes(needle), needle);
});

test('press contexts are dropped wherever the user takes over or computer use stops', () => {
  const points = [
    ["case 'user_input':", 'user_input'], ["case 'emergency_stop':", 'stopped'], ['async function stopAll(', 'stopped'],
    ["async function stop({ scope = 'all'", 'stopped'], ['function onSessionToggle(', 'stopped'], ['function releaseOwner(', 'stopped'],
    ["if (input.action === 'release')", 'stopped'], ['async function shutdown(', 'stopped'],
  ];
  for (const [start, reason] of points) {
    const at = service.indexOf(start);
    assert.ok(at > 0, start);
    assert.match(service.slice(at, at + 400), new RegExp(`pressContexts\\.dropAll\\('${reason}'\\)`), start);
  }
});

test('server.js wires the compiled rules and a press gate that only reads config: no judgment in the desktop block', () => {
  const block = between(server, '// Computer use (macOS): native helper + desktop service.', "console.warn('[assistant] computer use unavailable:'");
  assert.doesNotMatch(block, /\bjudge[A-Z]?\w*\(/);
  assert.match(block, /import\('\.\.\/mcp-server\/dist\/services\/desktop-risk\.js'\)\.catch\(\(\) => null\)/);
  assert.match(block, /import\('\.\.\/mcp-server\/dist\/services\/desktop-assist-gate\.js'\)\.catch\(\(\) => null\)/);
  const gate = between(block, 'const desktopPressAllowed', 'assistantDesktop = createDesktopService(');
  assert.match(gate, /typesafeEnabled\(\)/);
  assert.ok(gate.indexOf('invalidateTypeSafeConfig()') > 0 && gate.indexOf('invalidateTypeSafeConfig()') < gate.indexOf('desktopPressGate(typesafeConfig())'));
  assert.match(gate, /\.mode === 'press'/);
  assert.match(gate, /catch \{ return false; \}/, 'any failure reads as locked');
  assert.match(block, /desktopRisk: desktopRisk && desktopAssistGate \? desktopRisk : null/);
  assert.match(block, /pressGate: desktopPressAllowed/);
});

test('the MCP layer confirms the basis on a fresh config right before its single press request, sent without the caller signal', () => {
  const press = mcpAssist.slice(mcpAssist.indexOf('export async function pressByIntent('));
  const request = press.indexOf('const pressed = await desktopAx({');
  assert.ok(request > 0);
  const invalidate = press.indexOf('invalidateTypeSafeConfig()');
  const confirm = press.indexOf('confirmDesktopPress(snap, typesafeConfig())');
  const cancelled = press.lastIndexOf('signal?.aborted', request);
  assert.ok(invalidate > 0 && invalidate < confirm && confirm < cancelled && cancelled < request, 'invalidate → confirm → cancellation check → press');
  const call = press.slice(request, press.indexOf('});', request));
  assert.doesNotMatch(call, /signal/, 'the press request is never cancelled halfway');
  assert.equal((press.match(/action: 'press', press_context/g) || []).length, 1, 'one press request, never retried');
  assert.equal((press.match(/await desktopAx\(/g) || []).length, 2, 'one snapshot and one press');
  assert.match(press, /purpose: 'press'/);
  assert.match(press, /pressMode \? \{ purpose: 'press' \} : \{\}/, 'the context is asked for only in press mode');
});

test('the desktop rules treat every browser and web app the guards know as restricted', async () => {
  const risk = await import('../../mcp-server/dist/services/desktop-risk.js');
  for (const id of BROWSER_BUNDLES) {
    assert.ok(risk.RESTRICTED_APP_BUNDLES.includes(id), id);
    assert.equal(risk.isRestrictedApp(id), true, id);
    assert.equal(risk.isBrowserApp(id), true, id);
  }
  for (const prefix of WEB_APP_BUNDLE_PREFIXES) {
    assert.ok(risk.RESTRICTED_APP_PREFIXES.includes(prefix), prefix);
    assert.equal(risk.isRestrictedApp(`${prefix}7EF0F3F3`), true, prefix);
    assert.equal(risk.isBrowserApp(`${prefix}7EF0F3F3`), true, prefix);
  }
});

test('the compiled modules the server and the tool import exist (run npm run mcp:build)', () => {
  for (const name of ['desktop-risk.js', 'desktop-assist-gate.js', 'desktop-judgments.js', 'desktop-assist.js', 'desktop-client.js']) {
    assert.ok(existsSync(fileURLToPath(new URL(`../../mcp-server/dist/services/${name}`, import.meta.url))), `${name} missing: run npm run mcp:build`);
  }
});
