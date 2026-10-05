import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../public/shared/cp/cp-permission-model.js';
import * as restore from '../public/shared/cp/cp-restore.js';

// Whose mode is it. A tab is in Bypass only because the user chose that for it
// (the mode control, the plan card, a saved tab whose Bypass was picked one of
// those ways, or their own settings for a tab that never picked a mode), and
// their latest pick wins. So a mode that comes from anywhere else is never
// stored or stated as the tab's own: not what an automation run reports, not
// what an older build left in storage, not a report of the tab's session that
// arrives after the user left Bypass. The decisions are the functions of
// cp/cp-permission-model.js, tested here; the monolith cannot be imported in
// Node, so that it goes through them at every write is pinned in its source.

const HERE = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(HERE, '..', 'public/shared/ui-claude-panel.js'), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (signature) => {
  const start = panel.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = panel.slice(start + signature.length);
  const next = rest.search(/\n(?:export )?(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
};
const BYPASS = 'bypassPermissions';
// A tab as createTab() makes it when no default is stored: it never picked a mode.
const newTab = (over = {}) => ({ permissionMode: 'default', planMode: false, modeChosen: false, bypassChosen: false, planFrom: null, modeSeq: 0, ...over });
const need = (name) => { assert.equal(typeof model[name], 'function', `cp-permission-model.js exports ${name}()`); return model[name]; };
const SETTINGS = { settingsPick: true };
// A bridge that runs Bypass and numbers statements (capabilities bypass_mode and mode_statements): only there does Bypass exist.
const REAL = { settingsPick: true, numbered: true, bypass: true };

// ── An automation run's mode is not the tab's ──

test('an automation run\'s events never set the tab\'s mode', () => {
  const runEvent = need('runEvent');
  // The user picked Default in the tab; the run that attached to it is in Bypass.
  const tab = newTab();
  need('pickMode')(tab, 'default');
  const before = JSON.stringify(tab);
  const init = { type: 'system', subtype: 'init', session_id: 's1', permissionMode: BYPASS, tools: ['Bash'] };
  const cleaned = runEvent(tab, init);
  assert.deepEqual(cleaned, { ...init, permissionMode: '' }, 'the rest of the event is what it was');
  assert.equal(init.permissionMode, BYPASS, 'the run\'s own event is not changed');
  assert.equal(runEvent(tab, { type: 'system', subtype: 'status', status: null, permissionMode: BYPASS }).permissionMode, '');
  assert.equal(runEvent(tab, { type: 'mode_changed', mode: BYPASS }), null, 'a run switches no tab');
  assert.equal(tab.runMode, BYPASS, 'kept as information about the run');
  assert.equal(JSON.stringify({ ...tab, runMode: undefined }), before, 'and nothing of the tab\'s own mode changed');
  assert.deepEqual(need('statedMode')(tab, SETTINGS), { permissionMode: 'default' });
  const other = { type: 'assistant', message: { content: [] } };
  assert.equal(runEvent(tab, other), other, 'an event without a mode goes on as it is');
  assert.equal(runEvent(tab, null), null);

  // The run's events are marked where they enter, the mark travels with the message (it may wait in
  // the tab's buffer), and the one dispatcher hands them to the tab through runEvent().
  assert.match(fnBody('export function handleClaudeAutomationEvent(runId, payload) {'), /handleTabMsg\(tab, \{ type: 'event', event, fromRun: true \}\);/);
  // While one of its events is handled the tab is marked (`_runEvent`): what the run does is not written as the tab's either.
  assert.match(panel, /if \(msg\.fromRun === true\) \{ tab\._runEvent = true; try \{ handleTabEvent\(tab, runEvent\(tab, msg\.event\)\); \} finally \{ tab\._runEvent = false; \} \}\n      else handleTabEvent\(tab, msg\.event\);\n      break;/);
  assert.equal(panel.split('handleTabEvent(').length - 1, 3, 'its definition and the two branches of that one dispatcher');
  assert.equal(panel.split('handleTabMsg(tab, {').length - 1, 1, 'the run\'s events enter in one place');
  // A cleaned event that is dropped (null) is ignored by the handler's first line.
  assert.match(fnBody('function handleTabEvent(tab, ev) {'), /^\n  if \(!ev\?\.type\) return;/);
  // Attaching a run writes nothing of the tab's mode, whichever tab it lands in.
  const attach = fnBody('export async function attachClaudeAutomation(run, { focus = !!run?.focus, isCancelled = () => false } = {}) {');
  assert.doesNotMatch(attach, /permissionMode|modeChosen|bypassChosen|planMode|planFrom|modeSeq|pickMode|leavePlanMode|sessionMode|sessionReport/);
  // Nothing saved for a tab is the run's mode: runMode is not in what saveTabs writes.
  assert.doesNotMatch(fnBody('function saveTabs() {'), /runMode/);
});

test('a manual follow-up after a run goes out in the tab\'s own mode', () => {
  const statedMode = need('statedMode');
  const pickMode = need('pickMode');
  // The user had picked Default in the tab the run attached to. The run was in Bypass; none of it was written.
  const picked = newTab();
  pickMode(picked, 'default');
  assert.deepEqual(statedMode(picked, SETTINGS), { permissionMode: 'default' });
  // A tab made for the run never picked a mode: it gets what such a tab gets.
  assert.deepEqual(statedMode(newTab(), SETTINGS), { modeFromSettings: true });
  assert.deepEqual(statedMode(newTab()), { permissionMode: 'default' }, 'a bridge that cannot leave it to the settings is told Default');
  // And a tab an older build left holding the run's mode does not state it either.
  const inherited = newTab({ permissionMode: BYPASS });
  assert.deepEqual(statedMode(inherited, SETTINGS), { modeFromSettings: true });
  assert.deepEqual(statedMode(inherited), { permissionMode: 'default' });
  assert.deepEqual(statedMode(newTab({ permissionMode: BYPASS, modeChosen: true }), SETTINGS), { modeFromSettings: true }, 'a mode was chosen once, but not this one');
  // Every query, warm start and starting control states the mode through that one function.
  const options = fnBody('function _applySessionOptions(tab, msg) {');
  assert.match(options, /Object\.assign\(msg, statedMode\(tab, \{ settingsPick: hasCapability\(tab, 'permission_modes_v2'\), \.\.\._modeBridge\(tab\) \}\)\);/);
  assert.doesNotMatch(options, /tab\.permissionMode/);
  assert.equal((panel.match(/\bpermissionMode = /g) || []).length, 0, 'the monolith assigns no mode itself');
});

test('the mode control is there for a tab whose run has ended, and hidden while it runs', () => {
  const dropdown = fnBody('function populateModeDropdown($dd, tab) {');
  assert.match(dropdown, /\$dd\.hidden = !tab\.sdkMode \|\| !!tab\.automationActive;/);
  assert.doesNotMatch(dropdown, /automationRunId/);
  // The control follows the run's state when it changes under the active tab.
  const attach = fnBody('export async function attachClaudeAutomation(run, { focus = !!run?.focus, isCancelled = () => false } = {}) {');
  assert.match(attach, /tab\.automationActive = running;/);
  assert.match(attach, /if \(tab === activeTab\(\)\) populateModeDropdown\(_panel\?\.querySelector\('#cp-mode'\), tab\);/);
  // While it runs, the run's own mode is shown as information, as the run's.
  assert.match(fnBody('function runSlashCommand(tab, raw) {'), /if \(tab\.automationActive && tab\.runMode\) html \+= row\('Automation run', /);
});

// ── The user's pick ──

test('Bypass is the tab\'s own mode only as the user\'s recorded pick', () => {
  const pickMode = need('pickMode');
  const ownMode = need('ownMode');
  const statedMode = need('statedMode');
  const tab = newTab();
  assert.equal(ownMode(tab), '', 'never picked');
  pickMode(tab, BYPASS);
  assert.deepEqual([tab.permissionMode, tab.modeChosen, tab.bypassChosen, tab.planMode], [BYPASS, true, true, false]);
  assert.deepEqual(statedMode(tab, REAL), { permissionMode: BYPASS, modeSeq: 1 });
  // Only against a bridge that runs Bypass and numbers statements: to any other the pick waits and Default is stated.
  assert.deepEqual(statedMode(tab, SETTINGS), { permissionMode: 'default' });
  pickMode(tab, 'acceptEdits');
  assert.deepEqual([tab.permissionMode, tab.modeChosen, tab.bypassChosen], ['acceptEdits', true, false], 'another pick ends it');
  pickMode(tab, 'plan');
  assert.deepEqual([tab.permissionMode, tab.planMode, ownMode(tab)], ['plan', true, 'plan']);
  pickMode(tab, 'default');
  assert.deepEqual(statedMode(tab, SETTINGS), { permissionMode: 'default' }, 'a picked Default is stated, not left to the settings');
  // The two places a pick is made: the mode control's one setter, and the plan card's answer.
  assert.equal((panel.match(/\bpickMode\(/g) || []).length, 2);
  assert.match(fnBody('function setPermissionModeUI(tab, mode, { announce = true } = {}) {'), /\n  pickMode\(tab, mode\);\n/);
  assert.match(fnBody('function _planApproved(tab, inner) {'), /pickMode\(tab, mode === 'acceptEdits' \|\| mode === BYPASS_MODE \? mode : 'default'\);/);
  assert.doesNotMatch(panel, /bypassChosen = |modeChosen = /, 'the record is written nowhere else');
  // Leaving plan to carry the plan out is not a pick. A tab with no record of what it was before plan mode
  // (an older build saved it) goes on in Default, and a left-over mark does not land it in Bypass.
  const leavePlanMode = need('leavePlanMode');
  const planning = newTab({ permissionMode: 'plan', planMode: true, bypassChosen: true });
  leavePlanMode(planning);
  assert.deepEqual([planning.permissionMode, planning.planMode, planning.bypassChosen], ['default', false, false]);
  // It lands in Bypass only as the pick the user had made before plan mode, recorded as theirs.
  const forged = newTab({ permissionMode: 'plan', planMode: true, planFrom: { mode: BYPASS } });
  leavePlanMode(forged);
  assert.deepEqual([forged.permissionMode, forged.modeChosen, forged.bypassChosen], ['default', false, false], 'a Bypass to go back to needs its own record');
  assert.equal((panel.match(/\bleavePlanMode\(/g) || []).length, 2, 'the exits that name no mode (_leavePlanUI), and the post-plan card answering a pending approval');
});

test('a pick is said to the tab\'s session at once, running or idle', () => {
  const setter = fnBody('function setPermissionModeUI(tab, mode, { announce = true } = {}) {');
  assert.match(setter, /\n  if \(_stateOwnMode\(tab\)\) \{/);
  // An idle session still starts turns by itself (a background task, a scheduled wakeup):
  // a tab that left Bypass must not wait for its next message to leave it there.
  const state = fnBody('function _stateOwnMode(tab, { quiet = false } = {}) {');
  assert.match(state, /if \(!\(tab\.running \|\| \(tab\.sessionId && !tab\.automationActive\)\)\) return false;/);
  // A statement that cannot be sent is kept for when the socket is back.
  assert.match(state, /if \(tab\.ws\?\.readyState !== WebSocket\.OPEN\) \{ tab\.modeUnsent = true; return false; \}/);
  assert.match(state, /tab\.ws\.send\(JSON\.stringify\(\{ type: 'set_permission_mode', \.\.\.modeStatement\(tab, _modeBridge\(tab\)\) \}\)\);\n  if \(statementSent\(tab, _modeBridge\(tab\)\)\) saveTabs\(\);/);
});

// ── What the tab's own session reports ──

test('a Bypass the session reports is taken only where it is the user\'s', () => {
  const sessionReport = need('sessionReport');
  const sessionMode = need('sessionMode');
  const pickMode = need('pickMode');
  const statedMode = need('statedMode');
  const savedMode = need('savedMode');
  // A report of the tab's session, numbered with the tab's latest statement.
  const taken = (tab, mode, from) => sessionReport(tab, mode, from, { seq: tab.modeSeq, numbered: true, mayBypass: mode === BYPASS }).taken;
  for (const from of ['init', 'status', 'mode_changed']) {
    // The user left Bypass (or never was in it) and picked a mode: a report that
    // was on its way, queued or replayed does not put the tab back.
    const left = newTab();
    pickMode(left, BYPASS);
    pickMode(left, 'default');
    assert.equal(taken(left, BYPASS, from), false, from);
    assert.deepEqual([left.permissionMode, left.bypassChosen], ['default', false], from);
    assert.deepEqual(statedMode(left, REAL), { permissionMode: 'default', modeSeq: 2 }, from);
    // The tab's own pick: the session confirms it, or returns to it.
    const chosen = newTab();
    pickMode(chosen, BYPASS);
    assert.equal(taken(chosen, BYPASS, from), true, from);
    assert.deepEqual(statedMode(chosen, REAL), { permissionMode: BYPASS, modeSeq: 1 }, from);
    // A tab that never picked a mode: its session started in the one the user's
    // settings name. The tab shows it; it is not its pick, and is not stated or saved as one.
    const settings = newTab();
    assert.equal(taken(settings, BYPASS, from), true, from);
    assert.deepEqual([settings.permissionMode, settings.modeChosen, settings.bypassChosen], [BYPASS, false, false], from);
    // (Saved as a tab that never picked; `sessionBypass` only keeps the warning on screen across a reload.)
    assert.deepEqual(savedMode(settings), { permissionMode: 'default', modeChosen: false, bypassChosen: false, sessionBypass: true }, from);
    assert.deepEqual(statedMode(settings, REAL), { modeFromSettings: true, modeSeq: 1 }, from);
    assert.equal(taken(settings, BYPASS, from), true, 'and the next turn says so again');
    // A bridge that does not number statements cannot run Bypass: a Bypass it names is nobody's, pick or no pick.
    for (const old of [newTab(), (() => { const t = newTab(); pickMode(t, 'acceptEdits'); return t; })()]) {
      const before = JSON.stringify(old);
      assert.equal(sessionMode(old, BYPASS, from), false, from);
      assert.equal(JSON.stringify(old), before, from);
    }
  }
});

test('the session\'s other reports are followed, and only the bridge\'s word ends the record of a pick', () => {
  const sessionReport = need('sessionReport');
  const sessionMode = need('sessionMode');
  const pickMode = need('pickMode');
  const tab = newTab();
  pickMode(tab, BYPASS);
  const taken = (mode, from, seq = tab.modeSeq) => sessionReport(tab, mode, from, { seq, numbered: true, mayBypass: mode === BYPASS }).taken;
  // The model entered plan mode by itself: the pick is kept as where the plan leaves to.
  assert.equal(taken('plan', 'status'), true);
  assert.deepEqual([tab.permissionMode, tab.planMode, tab.bypassChosen, tab.planFrom], ['plan', true, true, { mode: BYPASS, bypassChosen: true }]);
  // A turn's init that was sent before a switch landed carries an older number: nothing of the tab's own changes.
  assert.equal(taken('default', 'init', tab.modeSeq - 1), false);
  assert.equal(tab.permissionMode, 'plan');
  need('leavePlanMode')(tab);
  assert.equal(taken(BYPASS, 'mode_changed'), true, 'the bridge confirms the pick');
  assert.equal(tab.permissionMode, BYPASS);
  // Refused, undone or switched: the bridge says the tab is in another mode.
  assert.equal(taken('default', 'mode_changed'), true);
  assert.deepEqual([tab.permissionMode, tab.bypassChosen, tab.modeChosen], ['default', false, true]);
  assert.equal(taken(BYPASS, 'status'), false, 'from there a Bypass is not the tab\'s');
  assert.equal(sessionMode(tab, '', 'init'), false);
  assert.equal(sessionMode(tab, undefined, 'status'), false);

  // The four places the page hears the session, all through one function, and what it does with a report that is not taken.
  assert.equal((panel.match(/\bsessionMode\(/g) || []).length, 0, 'no second way to take a report');
  assert.equal((panel.match(/\b_sessionSaysMode\(tab, /g) || []).length, 6, 'its definition, and init, status, mode_changed, mode_state and the answer to reattach');
  const handler = fnBody('function handleTabEvent(tab, ev) {');
  assert.match(handler, /const verdict = _sessionSaysMode\(tab, ev\.mode, 'mode_changed', ev\);/);
  assert.match(handler, /if \(ev\.permissionMode\) _sessionSaysMode\(tab, ev\.permissionMode, 'init', ev\);/);
  assert.match(fnBody('function _syncPermissionModeFromCli(tab, mode, modeSeq, ev) {'), /_sessionSaysMode\(tab, mode, 'status', \{ modeSeq, mayBypass: ev\?\.mayBypass, switching: ev\?\.switching, modeRev: ev\?\.modeRev, modeRevOf: ev\?\.modeRevOf \}\);/);
  assert.match(panel, /_sessionSaysMode\(tab, msg\.mode, 'reattach', msg\);/);
  // The tab says its own mode to the session again, so the session leaves the Bypass too.
  const says = fnBody('function _sessionSaysMode(tab, mode, from, carrier) {');
  assert.match(says, /const verdict = sessionReport\(tab, numbered && typeof mode !== 'string' \? '' : mode, from, \{ seq: carrier\?\.modeSeq, numbered, mayBypass: carrier\?\.mayBypass, switching: carrier\?\.switching, failed: carrier\?\.failed, rev: carrier\?\.modeRev, revOf: carrier\?\.modeRevOf \}\);\n  if \(verdict\.restate\) _stateOwnMode\(tab, \{ quiet: true \}\);/);
  assert.deepEqual(need('modeStatement')(newTab({ permissionMode: 'acceptEdits', modeChosen: true })), { mode: 'acceptEdits' });
  assert.deepEqual(need('modeStatement')(newTab()), { mode: 'default' }, 'a tab that never picked one, to a bridge that cannot go back to the settings');
});

// ── What is saved, and what comes back ──

test('what is saved for a tab is its own mode, with the record of a Bypass pick', () => {
  const savedMode = need('savedMode');
  const pickMode = need('pickMode');
  const tab = newTab();
  assert.deepEqual(savedMode(tab), { permissionMode: 'default', modeChosen: false, bypassChosen: false });
  // (With the number of the tab's latest statement: it only grows, and must survive a reload.)
  pickMode(tab, 'acceptEdits');
  assert.deepEqual(savedMode(tab), { permissionMode: 'acceptEdits', modeChosen: true, bypassChosen: false, modeSeq: 1 });
  pickMode(tab, BYPASS);
  assert.deepEqual(savedMode(tab), { permissionMode: BYPASS, modeChosen: true, bypassChosen: true, modeSeq: 2 });
  // A mode the tab only shows (its session reported it from the settings) is not saved as the tab's.
  assert.deepEqual(savedMode(newTab({ permissionMode: 'auto' })), { permissionMode: 'default', modeChosen: false, bypassChosen: false });
  // A record left over from before the tab's mode changed is not saved as one.
  assert.deepEqual(savedMode(newTab({ permissionMode: 'plan', planMode: true, modeChosen: true, bypassChosen: true })), { permissionMode: 'plan', modeChosen: true, bypassChosen: false });
  assert.match(fnBody('function saveTabs() {'), /planMode: t\.planMode \|\| false, \.\.\.savedMode\(t\), toolPolicy: /);
});

test('a saved Bypass comes back as Bypass only with the record that the user picked it', () => {
  const restoredMode = need('restoredMode');
  const neverPicked = { permissionMode: 'default', modeChosen: false };
  // (Every restored tab also gets: no plan record, its statement number, and nothing known of its session's mode.)
  const REST = { planFrom: null, modeSeq: 0, mayBypass: false, actualMode: '', actualSeq: undefined };
  const none = { permissionMode: 'default', planMode: false, modeChosen: false, bypassChosen: false, ...REST };
  // What the previous build left: the Auto-approve toggle set tabs to Bypass,
  // every new tab started in the stored default, and a tab that showed an
  // automation run was saved with the run's mode. None of it carries the record.
  assert.deepEqual(restoredMode({ permissionMode: BYPASS, planMode: false }, neverPicked), none);
  assert.deepEqual(restoredMode({ permissionMode: BYPASS, automationRunId: 'run-1', automationActive: false }, neverPicked), none);
  assert.deepEqual(restoredMode({ permissionMode: BYPASS, modeChosen: true }, neverPicked), none, 'a mode was chosen once, but not this one');
  for (const forged of ['true', 1, {}, null]) assert.deepEqual(restoredMode({ permissionMode: BYPASS, bypassChosen: forged }, neverPicked), none, `bypassChosen: ${JSON.stringify(forged)}`);
  // Where new tabs start in the approval mode last picked, so does such a tab.
  assert.deepEqual(restoredMode({ permissionMode: BYPASS }, { permissionMode: 'acceptEdits', modeChosen: true }), { permissionMode: 'acceptEdits', planMode: false, modeChosen: true, bypassChosen: false, ...REST });
  // The user's own pick, recorded by this build when they made it.
  assert.deepEqual(restoredMode({ permissionMode: BYPASS, modeChosen: true, bypassChosen: true }, neverPicked), { permissionMode: BYPASS, planMode: false, modeChosen: true, bypassChosen: true, ...REST });

  // Every other saved mode comes back as it did.
  // A mode saved before the record of a pick existed was the user's pick (it was stated then, and still is);
  // one saved with the record that it was not picked (the session reported it from the settings) is not the tab's.
  const old = restoredMode({ permissionMode: 'acceptEdits' }, neverPicked);
  assert.deepEqual(old, { permissionMode: 'acceptEdits', planMode: false, modeChosen: true, bypassChosen: false, ...REST });
  assert.deepEqual(need('statedMode')(old, SETTINGS), { permissionMode: 'acceptEdits' });
  assert.deepEqual(restoredMode({ permissionMode: 'auto', modeChosen: false }, neverPicked), none);
  assert.deepEqual(restoredMode({ planMode: true }, neverPicked), { permissionMode: 'plan', planMode: true, modeChosen: false, bypassChosen: false, ...REST }, 'stored planMode without a mode');
  assert.deepEqual(restoredMode({ permissionMode: 'default', modeChosen: true }, neverPicked), { permissionMode: 'default', planMode: false, modeChosen: true, bypassChosen: false, ...REST }, 'a picked Default stays picked');
  assert.equal(restoredMode({ permissionMode: 'default', modeChosen: true, modeSeq: 7 }, neverPicked).modeSeq, 7, 'the statement number comes back');
  assert.deepEqual(restoredMode({ permissionMode: 'default', modeChosen: false }, { permissionMode: 'default', modeChosen: true }).modeChosen, false, 'and a tab that never picked stays that');
  assert.deepEqual(restoredMode({ permissionMode: 'dontAsk', bypassChosen: true }, neverPicked).bypassChosen, false, 'the record means nothing without the mode');
  assert.deepEqual(restoredMode({ permissionMode: 'root' }, neverPicked), none, 'a mode that is none is not taken on trust');
  assert.deepEqual(restoredMode(null, neverPicked), none);

  // restoreTabs asks that function, with what a new tab gets.
  const restoreTabs = fnBody('function restoreTabs() {');
  assert.match(restoreTabs, /if \(t\) Object\.assign\(t, restoredMode\(saved, \{ permissionMode: t\.permissionMode, modeChosen: t\.modeChosen \}\)\);/);
  assert.doesNotMatch(restoreTabs, /saved\.permissionMode|saved\.planMode/, 'no second reading of the saved mode');
  // A new tab starts without the record.
  assert.match(panel, /\n    bypassChosen: false,[^\n]*\n/);
});

test('the scrub after a server restart keeps a Bypass only with that record', () => {
  const { scrubSavedTab } = restore;
  const kept = scrubSavedTab({ id: 'a', sessionId: 's', permissionMode: BYPASS, modeChosen: true, bypassChosen: true });
  assert.deepEqual([kept.permissionMode, kept.modeChosen, kept.bypassChosen], [BYPASS, true, true]);
  for (const saved of [{ permissionMode: BYPASS }, { permissionMode: BYPASS, modeChosen: true }, { permissionMode: BYPASS, bypassChosen: 'true' }, { permissionMode: BYPASS, automationRunId: 'run-1' }]) {
    const out = scrubSavedTab({ id: 'a', sessionId: 's', ...saved });
    for (const key of ['permissionMode', 'modeChosen', 'bypassChosen']) assert.equal(key in out, false, `${JSON.stringify(saved)}: ${key}`);
  }
  // Other modes and their own record are kept as they were.
  const edits = scrubSavedTab({ id: 'a', permissionMode: 'acceptEdits', modeChosen: true, bypassChosen: true });
  assert.deepEqual([edits.permissionMode, edits.modeChosen, 'bypassChosen' in edits], ['acceptEdits', true, false]);
  assert.equal('modeChosen' in scrubSavedTab({ id: 'a', permissionMode: 'default' }), false, 'a tab saved before the record existed says nothing');
});
