import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claudeStallSeconds } from '../lib/claude-stall-policy.js';

test('xhigh thinks at least as long as high, whatever the lower-effort default',()=>{
  for(const fallback of [45,90]) {
    assert.equal(claudeStallSeconds('high',fallback),120);
    assert.equal(claudeStallSeconds('xhigh',fallback),300);
    assert.equal(claudeStallSeconds('max',fallback),300);
    for(const effort of ['low','medium',undefined])assert.equal(claudeStallSeconds(effort,fallback),fallback);
    for(const elapsed of [46,91,121,299])assert.ok(elapsed<claudeStallSeconds('xhigh',fallback));
  }
});
// The retry budget must survive the restart a stall recovery does: a session
// that reset it whenever its process was recreated would retry forever.
test('the stall retry budget survives the restart of a recovery',()=>{
  const bridge=readFileSync(new URL('../lib/claude-agent-bridge.js',import.meta.url),'utf8');
  assert.match(bridge,/const killSec = claudeStallSeconds\(this\.effort, 90\);/);
  const resets=[...bridge.matchAll(/this\.stallRetries = 0;/g)].map(m=>m.index);
  assert.equal(resets.length,2,'set in the constructor, reset by a turn that ended: nowhere else');
  const ensure=bridge.slice(bridge.indexOf('  ensureQuery({ warm = false } = {}) {'),bridge.indexOf('  _warmSignature() {'));
  const recreate=bridge.slice(bridge.indexOf('  _recreateQuery(continuationPrompt) {'),bridge.indexOf('  _recoverLostSession() {'));
  assert.ok(ensure.length>1000&&recreate.length>100);
  assert.doesNotMatch(ensure,/stallRetries/);
  assert.doesNotMatch(recreate,/stallRetries/);
  const result=bridge.slice(bridge.indexOf('  _handleResult(m) {'),bridge.indexOf('  // Coalesce text/thinking deltas per content block'));
  assert.match(result,/this\.stallRetries = 0;/);
  // The per-turn engine that carried its own copy of this budget is gone.
  const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.doesNotMatch(server,/function spawnProc\(/);
  assert.doesNotMatch(server,/claudeStallSeconds/);
});
