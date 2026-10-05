// What the Codex panel shows for a thread after a revert, a reload or a goal
// update: retained history, the name the user gave, the goal's own status.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  codexRevertedHistory, codexRevertNotice, codexNotificationItem, codexTranscriptPresentation,
} from '../public/shared/cdx/cdx-protocol.js';

const read = (name) => readFileSync(new URL(`../public/shared/cdx/${name}`, import.meta.url), 'utf8');

test('a rollback reply replaces the transcript only for the shown thread and only with a full history', () => {
  const retained = { id: 'thread-a', turns: [{ id: 't1', items: [{ id: 'u1', type: 'userMessage' }] }] };
  assert.deepEqual(codexRevertedHistory(retained, 'thread-a'), { thread: retained, empty: false });
  assert.equal(codexRevertedHistory(retained, 'thread-b'), null, 'another thread is never rendered into this tab');
  assert.equal(codexRevertedHistory({ id: 'thread-a' }, 'thread-a'), null, 'a reply without turns says nothing about the history');
  assert.equal(codexRevertedHistory(null, 'thread-a'), null);
  assert.equal(codexRevertedHistory(retained, null), null);
  for (const turns of [[], [{ id: 't1', items: [] }], [{ id: 't1' }]]) {
    assert.equal(codexRevertedHistory({ id: 'thread-a', turns }, 'thread-a').empty, true);
  }
});

test('a revert shows one notice whichever of the notification and the reply comes first', () => {
  const run = (events) => {
    let pending = ''; let visible = 0;
    for (const event of events) {
      const step = codexRevertNotice(pending, event);
      pending = step.pending;
      if (event === 'rendered') visible = 0; // the re-render wipes the transcript, earlier notice included
      if (step.show) visible += 1;
    }
    return { pending, visible };
  };
  assert.deepEqual(run(['notified', 'rendered']), { pending: '', visible: 1 });
  assert.deepEqual(run(['rendered', 'notified']), { pending: '', visible: 1 });
  assert.deepEqual(run(['notified', 'rendered', 'rendered', 'notified']), { pending: '', visible: 1 });
  assert.equal(run(['notified']).visible, 1, 'a revert made elsewhere is still announced');
});

test('the revert reply re-renders the transcript; the notice no longer asks for a reload', () => {
  const tabs = read('cdx-tabs.js');
  assert.match(tabs, /msg\.type === 'thread_rolled_back' && renderRevertedThread\(msg\.thread\)\) noteCodexRevert\('rendered'\)/);
  assert.match(tabs, /case 'thread\/reverted':[\s\S]{0,160}noteCodexRevert\('notified'\)/);
  assert.doesNotMatch(tabs, /Reload this session/);
  const renderReverted = tabs.slice(tabs.indexOf('function renderRevertedThread('), tabs.indexOf('function noteCodexRevert('));
  assert.match(renderReverted, /renderHistory\(retained\.thread, null, \{ authoritative: true \}\)/);
  assert.match(renderReverted, /if \(retained\.empty\) invalidateThreadSnapshot\(retained\.thread\.id\)/);
  // The saved rendering still holds the reverted turns: an authoritative history never falls back to it.
  assert.match(read('cdx-render.js'), /resolveHistoryRenderSource\(\s*thread,\s*fallbackItems,\s*authoritative \? null : storedSnapshot,\s*\)/);
});

test('a name the user gave survives history loads; a provider name or preview fills in otherwise', () => {
  const source = read('cdx-tabs.js');
  const start = source.indexOf('export function setThread(thread) {');
  const end = source.indexOf('export async function ensureProjectsLoaded', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const context = vm.createContext({
    _boundTab: null, _sessionLabel: '',
    persistThread: (id) => calls.push(['persist', id]),
    setSessionLabel: (label) => calls.push(['label', label]),
    applyCodexProviderTitle: (label) => calls.push(['provider', label]),
    syncSessionControls() {},
    getThreadLabel: (thread, fallback) => thread.name || thread.preview || fallback,
    hasCustomSessionLabel: (tab) => !['new session', 'saved session', 'untitled session', 'codex'].includes(String(tab.sessionLabel || '').toLowerCase()),
  });
  vm.runInContext(`${source.slice(start, end).replace('export function ', 'function ')}
    function run(tab, label, thread) { _boundTab = tab; _sessionLabel = label; setThread(thread); }`, context);

  const reloaded = { id: 'thread-a', preview: 'Run the shell command "curl …" and tell me the first line.' };
  context.run({ titleByUser: true, sessionLabel: '0.160 recheck' }, '0.160 recheck', reloaded);
  assert.deepEqual(calls, [['persist', 'thread-a'], ['provider', reloaded.preview]],
    'the preview goes through the guard that keeps the name and re-sends it, never straight into the label');

  calls.length = 0;
  context.run({ titleByUser: true, sessionLabel: '0.160 recheck' }, '0.160 recheck', { id: 'thread-a' });
  assert.deepEqual(calls.at(-1), ['provider', '0.160 recheck'], 'a new thread without name or preview keeps the given name');

  for (const tab of [{ titleByUser: false, sessionLabel: 'Agent thread' }, { titleByUser: true, sessionLabel: 'New session' }, null]) {
    calls.length = 0;
    context.run(tab, tab?.sessionLabel || '', reloaded);
    assert.deepEqual(calls.at(-1), ['label', reloaded.preview]);
  }

  // The marker is set where the user types a name, saved with the tab, and dropped with the thread it named.
  assert.match(source, /function markCodexSessionTitleByUser\(tab\) \{\s*markCodexSessionTitleManual\(tab\);\s*if \(tab\) tab\.titleByUser = true;\s*\}/);
  assert.equal(source.match(/markCodexSessionTitleByUser\(/g).length, 4, 'the naming dialog, the header rename and the session-menu rename');
  assert.match(source, /titleByUser: !!tab\.titleByUser,/);
  assert.match(source, /titleByUser: !!saved\.titleByUser,/);
  // Resuming another thread drops the marker and, having a title already, never asks for a generated one.
  assert.match(source, /if \(tab\.threadId !== threadId\) tab\.titleByUser = false;[\s\S]{0,160}markCodexSessionTitleManual\(tab\);\s*persistThread\(threadId\);/);
  assert.match(source, /function requestCodexSessionTitle\([^)]*\) \{\s*if \(!tab \|\| tab\.closed \|\| tab\.automationActive \|\| tab\.titleState !== 'default'\) return;/);
  assert.equal(source.match(/_boundTab\.titleByUser = false;/g).length, 2, 'reset with the thread and with the account');
});

test('the goal card shows the goal\'s own status', () => {
  for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']) {
    const item = codexNotificationItem('thread/goal/updated', { threadId: 'a', turnId: null, goal: { threadId: 'a', objective: 'recheck', status, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
    assert.equal(item.id, 'goal:a'); assert.equal(item.type, 'threadGoal');
    assert.equal(codexTranscriptPresentation(item).status, status);
  }
  const cleared = { ...codexNotificationItem('thread/goal/updated', { threadId: 'a', goal: { objective: 'recheck', status: 'active' } }), ...codexNotificationItem('thread/goal/cleared', { threadId: 'a' }) };
  assert.equal(codexTranscriptPresentation(cleared).status, 'cleared');
  assert.equal(codexTranscriptPresentation(cleared).text, 'Goal cleared');
});
