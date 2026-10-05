// Source contracts for browser assistance: orderings and boundaries that a
// behavioural test cannot see, because breaking them only matters in a race.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = readFileSync(`${root}/server.js`, 'utf8');
const clickRoute = server.slice(server.indexOf("app.post('/api/browser/sessions/:id/click'"), server.indexOf("app.post('/api/browser/sessions/:id/fill'"));

test('auto-heal: the last look sits after every guard and immediately before the action starts', () => {
  assert.ok(clickRoute.length > 1000, 'click route located');
  const secondMoney = clickRoute.lastIndexOf('moneyGuardLabel(');
  const xGate = clickRoute.indexOf('xPublishGate(');
  const identity = clickRoute.indexOf('matchesTargetIdentity(');
  const verify = clickRoute.indexOf('verifyHealTarget(');
  const mark = clickRoute.indexOf('markBrowserActionStarted(req)');
  const click = clickRoute.indexOf('.click({ timeout: actionTimeout })');
  assert.ok(clickRoute.indexOf('moneyGuardLabel(') < secondMoney, 'the money guard runs twice');
  assert.ok(identity > 0 && identity < xGate && xGate < secondMoney && secondMoney < verify && verify < mark && mark < click,
    'order must be: target identity, X publish gate, second money check, heal verification, mark started, click');
  // Anything awaited between the verification and the mark reopens the window it closes.
  const afterVerify = clickRoute.slice(clickRoute.indexOf(';', clickRoute.indexOf('if (reason) return refuseHeal(reason)')) + 1, mark);
  assert.doesNotMatch(afterVerify, /\bawait\b/, `nothing may be awaited between verifyHealTarget and markBrowserActionStarted: ${afterVerify.trim()}`);
  // The element verified is the element clicked.
  assert.match(clickRoute, /verifyHealTarget\(targetIdentity\.handle,/);
  assert.match(clickRoute, /\(targetIdentity\?\.handle \|\| resolved\.target\)\.click\(/);
});

test('auto-heal: selector and fingerprint come from the server context, and a refusal offers nothing to retry with', () => {
  const open = server.slice(server.indexOf('function openAutoHeal('), server.indexOf("app.post('/api/browser/sessions/:id/click'"));
  assert.match(open, /assistContexts\.consume\(/);
  assert.ok(open.indexOf('assistContexts.consume(') < open.indexOf("reject: 'mixed_target'"), 'the context is spent before anything else is decided');
  assert.match(open, /X-Synabun-Batch/);
  assert.match(open, /browserAutoHealAllowed\(\)/);
  assert.match(clickRoute, /const selector = heal \? heal\.entry\.selector :/);
  assert.match(clickRoute, /heal \? undefined : nthMatch, heal \? undefined : textHint/, 'a heal never uses nthMatch or textHint');
  assert.match(clickRoute, /if \(heal\) return res\.status\(400\)\.json\(refuseHeal\('exception'\)\)/, 'a failed heal carries no hints');
  const refuse = /const refuseHeal = reason => \(\{([^}]*)\}\)/.exec(server)?.[1] ?? '';
  assert.doesNotMatch(refuse, /hints|assist/);
  // Only the click route mints.
  assert.equal(server.split('assistContexts.mint(').length - 1, 1);
  assert.ok(clickRoute.includes('assistContexts.mint('));
});

test('no TypeSafe call can originate in the Neural Interface browser layer', () => {
  const libs = readdirSync(`${root}/lib`).filter(name => /^browser-.*\.js$/.test(name));
  assert.ok(libs.includes('browser-semantic-context.js') && libs.includes('browser-assist-api.js'));
  for (const name of libs) {
    const source = readFileSync(`${root}/lib/${name}`, 'utf8');
    assert.doesNotMatch(source, /services\/typesafe\.js|\bjudge\(|memory-judgments|browser-judgments/, `${name} must not reach the TypeSafe client`);
    // Only the snapshot store may capture: every capture replaces Playwright's ref map.
    if (name !== 'browser-snapshots.js') assert.doesNotMatch(source, /\.ariaSnapshot\(/, `${name} must never capture a snapshot: it would replace the caller's refs`);
    if (name === 'browser-semantic-context.js' || name === 'browser-assist-api.js') assert.doesNotMatch(source, /console\./, `${name} must not log page-derived data`);
  }
  // server.js reads config and the gate, never the client's judge().
  const browserRegion = server.slice(server.indexOf("app.use('/api/browser', browserRequestMiddleware)"), server.indexOf("app.get('/api/browser/config'"));
  assert.doesNotMatch(browserRegion, /\bjudge[A-Z]\w*\(|\bjudge\(/);
});

test('the classifier the server uses is the compiled one the MCP layer and the bench use', () => {
  assert.ok(existsSync(fileURLToPath(new URL('../../mcp-server/dist/services/browser-risk.js', import.meta.url))), 'run npm run mcp:build');
  assert.match(readFileSync(`${root}/lib/browser-semantic-context.js`, 'utf8'), /from '\.\.\/\.\.\/mcp-server\/dist\/services\/browser-risk\.js'/);
});
