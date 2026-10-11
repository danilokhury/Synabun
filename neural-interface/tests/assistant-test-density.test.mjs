// Run with: env -u SYNABUN_ASSISTANT_SESSION SYNABUN_TYPESAFE=off node --test tests/assistant-test-density.test.mjs
// Test density (lib/assistant-test-density.js): the levels, the TESTING block of a worker brief and
// the classes that get it, the brain's lines, and when a "Not tested" result is not a claim to check.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEST_DENSITY, TEST_DENSITIES, claimCheckWaived, normalizeTestDensity, reportsUntested,
  testDensityLabel, testDensityPersonaLine, testDensityStamp, testingApplies, testingBlock, testingFollowUpLine,
} from '../lib/assistant-test-density.js';
import { buildFollowUpPrompt, buildTaskPrompt, buildResultRetryPrompt, resultContractText } from '../lib/assistant-task-prompt.js';
import { buildAssistantPersona } from '../lib/assistant-persona.js';
import { TASK_CLASSES } from '../lib/assistant-router.js';
import * as panel from '../public/shared/assistant/asst-state.js';

const count = (text, needle) => text.split(needle).length - 1;

test('levels: four ids, Light by default, anything else normalizes to it', () => {
  assert.deepEqual([...TEST_DENSITIES], ['none', 'light', 'standard', 'thorough']);
  assert.equal(DEFAULT_TEST_DENSITY, 'light');
  for (const value of [undefined, null, '', 'heavy', 0, {}, 'NONE ']) {
    assert.equal(normalizeTestDensity(value), value === 'NONE ' ? 'none' : 'light', String(value));
  }
  assert.equal(normalizeTestDensity('Thorough'), 'thorough');
  assert.equal(normalizeTestDensity('heavy', null), null, 'a caller can tell "not set" apart');
  assert.deepEqual(TEST_DENSITIES.map((id) => testDensityLabel(id)), ['None', 'Light', 'Standard', 'Thorough']);
  assert.equal(testDensityLabel('nope'), 'Light');
  // The panel's copy of the levels agrees with the server's.
  assert.deepEqual(panel.TEST_DENSITIES, [...TEST_DENSITIES]);
  assert.equal(panel.DEFAULT_TEST_DENSITY, DEFAULT_TEST_DENSITY);
  assert.equal(panel.normalizeTestDensity('everything'), 'light');
  assert.equal(panel.normalizeTestDensity(null, null), null);
  assert.deepEqual(panel.TEST_DENSITIES.map((id) => panel.testDensityBars(id)), [0, 1, 2, 3]);
});

test('a tab keeps its test density across a reload; an older payload reads as the server default', () => {
  const state = panel.createTabState('assistant-1', { provider: 'claude-code' }, { testDensity: 'none' });
  assert.equal(panel.deserializeTabState(JSON.stringify(panel.serializeTabState(state))).testDensity, 'none');
  assert.equal(panel.serializeTabState({ ...state, testDensity: 'everything' }).testDensity, null);
  assert.equal(panel.deserializeTabState({ sessionId: 'assistant-1', brain: { provider: 'codex' } }).testDensity, null);
});

test('the TESTING block: one header and four rules per level', () => {
  const header = (label) => `TESTING (the user's Test density setting: ${label}). Binding: it overrides any heavier test or verification instruction in TASK or CONTEXT. Exception: when writing or running tests is itself what TASK asks you to deliver, do that work in full.`;
  const first = {
    none: '- Do not write tests and do not run test suites.',
    light: '- Run only the existing test files that directly cover the code you changed: a few files, never the whole suite.',
    standard: '- Add focused tests for the behavior you add or change.',
    thorough: '- Cover the change with unit and integration tests, including edge cases and failure paths; add or update browser tests for user-facing changes.',
  };
  for (const id of TEST_DENSITIES) {
    const lines = testingBlock(id, 'code').split('\n');
    assert.equal(lines[0], header(testDensityLabel(id)), id);
    assert.equal(lines[1], first[id], id);
    assert.equal(lines.length, 5, `${id}: header + 4 rules`);
    assert.match(lines[4], /^- In ## Result /, id);
  }
  assert.match(testingBlock('none', 'code'), /In ## Result say "Not tested" and list what a person should check\./);
  assert.match(testingBlock('none', 'code'), /No browser, visual or live checks\.$/m);
  assert.match(testingBlock('light', 'code'), /at most one new test file\./);
  assert.match(testingBlock('standard', 'code'), /then that package's regular non-browser suite once at the end\./);
  assert.match(testingBlock('thorough', 'code'), /Run the whole suite and fix what you broke\./);
  // Only None, Light and Standard hold a worker back; no level but Thorough asks for the whole suite.
  for (const id of ['none', 'light', 'standard']) assert.doesNotMatch(testingBlock(id, 'code'), /Run the whole suite|Verify the result live/, id);
  assert.equal(testingBlock('everything', 'code'), testingBlock('light', 'code'), 'an unknown level is Light');
  assert.equal(testingBlock(null, 'code'), '', 'no level given: no block');
});

test('class gating: code, complex, quick and no class get the block; the other classes do not', () => {
  const gets = TASK_CLASSES.filter((cls) => testingApplies(cls));
  assert.deepEqual(gets, ['quick', 'code', 'complex']);
  for (const cls of [null, undefined, '']) assert.equal(testingApplies(cls), true, 'no class counts as code');
  for (const cls of ['review', 'research', 'browser', 'computer', 'automation', 'design', 'image_gen', 'video_gen', 'chat']) {
    assert.equal(testingBlock('thorough', cls), '', cls);
  }
});

test('a worker prompt carries exactly one TESTING block, after CONTEXT and before the output contract', () => {
  const base = { task: 'Fix the login redirect and run the full test suite afterwards', context: 'Verify everything end to end.', cwd: '/repo', project: 'proj', runId: 'run-1', provider: 'codex' };
  for (const taskClass of ['code', 'complex', 'quick', null]) {
    for (const id of TEST_DENSITIES) {
      const prompt = buildTaskPrompt({ ...base, taskClass, testDensity: id });
      assert.equal(count(prompt, 'TESTING (the user\'s Test density setting:'), 1, `${taskClass} ${id}`);
      assert.match(prompt, new RegExp(`Test density setting: ${testDensityLabel(id)}\\)`));
      assert.ok(prompt.indexOf('CONTEXT (from the assistant):') < prompt.indexOf('TESTING (') && prompt.indexOf('TESTING (') < prompt.indexOf('OUTPUT CONTRACT'), `${taskClass} ${id}: order`);
    }
  }
  for (const taskClass of ['review', 'research', 'browser', 'computer', 'automation', 'design', 'image_gen', 'video_gen']) {
    const prompt = buildTaskPrompt({ ...base, taskClass, testDensity: 'none' });
    assert.equal(prompt, buildTaskPrompt({ ...base, taskClass }), `${taskClass}: unchanged`);
    assert.doesNotMatch(prompt, /TESTING \(/, taskClass);
  }
  // Nothing else SynaBun writes into a worker prompt asks for tests or verification.
  const bare = buildTaskPrompt({ task: 'x', cwd: '/repo', project: 'proj', runId: 'run-1', provider: 'codex', taskClass: 'code' });
  const own = [bare.replace(/\nTASK:\nx\n/, '\n'), resultContractText(), resultContractText({ requireJson: true }), buildResultRetryPrompt(), buildFollowUpPrompt('do more', {})].join('\n');
  assert.doesNotMatch(own, /\b(?:tests?|testing|suite|verify|verification)\b/i);
});

test('a follow-up turn names the level only when it changed', () => {
  assert.doesNotMatch(buildFollowUpPrompt('also rename it', { runId: 'r', project: 'p' }), /TESTING/);
  const changed = buildFollowUpPrompt('also rename it', { runId: 'r', project: 'p' }, { testDensity: 'none' });
  assert.equal(count(changed, 'TESTING changed'), 1);
  assert.ok(changed.includes(testingFollowUpLine('none')));
  assert.match(changed, /setting is now None; this replaces the TESTING block of your brief\): Do not write tests and do not run test suites\./);
  assert.match(changed, /end with the ## Result block\.$/);
});

test('the claim check at None: "Not tested" is not a claim; "tests passed" and a failed command still are', () => {
  const ran = { commands: [{ command: 'node --check src/a.js', exit: 'ok', output_tail: '' }], results: [], hasEvidence: true };
  const notTested = '## Result\nstatus: done\nsummary: Renamed the helper. Not tested.\nchanges:\n- src/a.js — renamed\nfollow_ups:\n- Check the settings page still opens';
  assert.equal(claimCheckWaived({ level: 'none', taskClass: 'code', text: notTested, evidence: ran }), true);
  assert.equal(claimCheckWaived({ level: 'none', taskClass: null, text: 'Done. No tests were run; the syntax check is clean.', evidence: ran }), true);
  assert.equal(claimCheckWaived({ level: 'none', taskClass: 'quick', text: 'Changed the label. Untested.', evidence: ran }), true);
  // A claim that tests passed is judged at every level.
  for (const text of ['Not tested in the browser, but all tests pass.', 'Not tested live. The suite is green.', 'Untested by hand; 12 passed.']) {
    assert.equal(claimCheckWaived({ level: 'none', taskClass: 'code', text, evidence: ran }), false, text);
  }
  // Something failed in the turn: that is not missing test output.
  assert.equal(claimCheckWaived({ level: 'none', taskClass: 'code', text: notTested, evidence: { commands: [{ command: 'node --check src/a.js', exit: 'error', output_tail: 'SyntaxError' }], results: [] } }), false);
  assert.equal(claimCheckWaived({ level: 'none', taskClass: 'code', text: notTested, evidence: { commands: [], results: [{ tool: 'Edit', is_error: true, tail: 'no match' }] } }), false);
  // A result that does not say it: judged as before.
  assert.equal(claimCheckWaived({ level: 'none', taskClass: 'code', text: 'Renamed the helper and it works.', evidence: ran }), false);
  // The other levels, a class with no TESTING block, and a run that was told no level: as before.
  for (const level of ['light', 'standard', 'thorough', null, undefined]) assert.equal(claimCheckWaived({ level, taskClass: 'code', text: notTested, evidence: ran }), false, String(level));
  assert.equal(claimCheckWaived({ level: 'none', taskClass: 'review', text: notTested, evidence: ran }), false);
  assert.equal(claimCheckWaived(), false);
});

test('the brain: its prompt states the level, the prefix and what to do with an unverified claim', () => {
  const none = buildAssistantPersona({ assistantSessionId: 'assistant-1', testDensity: 'none' });
  assert.ok(none.includes(testDensityPersonaLine('none')));
  assert.match(none, /- Test density: None \(the user's setting, next to the permission toggle\)/);
  assert.match(none, /SynaBun adds the matching binding TESTING rules to every code \/ complex \/ quick worker brief\./);
  assert.match(none, /Do not write test or verification requirements into a task beyond what the user asked for in this request/);
  assert.match(none, /do not dispatch a run whose only purpose is to test another run at None or Light unless the user asks/);
  assert.match(none, /At None or Light, report what was not tested instead of verifying it yourself\./);
  assert.ok(none.indexOf('## Rails you must respect') < none.indexOf('- Test density: None') && none.indexOf('- Test density: None') < none.indexOf('## Memory obligations'), 'under Rails');
  assert.match(none, /route-mode changes as "\[SynaBun Router\]" lines, and a change of the Test density as a "\[SynaBun Tests\]" line\./);
  assert.match(none, /At this Test density, do not run tests to settle it/);
  const thorough = buildAssistantPersona({ assistantSessionId: 'assistant-1', testDensity: 'thorough' });
  assert.match(thorough, /- Test density: Thorough \(/);
  assert.doesNotMatch(thorough, /At this Test density, do not run tests to settle it/);
  assert.equal(reportsUntested('light'), true);
  assert.equal(reportsUntested('standard'), false);
  // A chat channel has no composer to point at.
  assert.match(buildAssistantPersona({ assistantSessionId: 'assistant-1', testDensity: 'light', channel: 'whatsapp' }), /- Test density: Light \(the user's setting, in the Assistant panel\)/);
  // Without a level the prompt is the one from before the setting.
  const plain = buildAssistantPersona({ assistantSessionId: 'assistant-1' });
  assert.doesNotMatch(plain, /Test density|SynaBun Tests/);
  // The line a change sends, one per level.
  assert.match(testDensityStamp('light'), /^\[SynaBun Tests\] Test density: Light - workers run only the test files that cover the change/);
  assert.equal(new Set(TEST_DENSITIES.map((id) => testDensityStamp(id))).size, 4);
  for (const id of TEST_DENSITIES) assert.equal(testDensityStamp(id).includes('\n'), false, id);
});
