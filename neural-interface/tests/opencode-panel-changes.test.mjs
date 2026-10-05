// OpenCode panel, cluster 6: changes review, live branch, worktrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { applyEvent } from '../public/shared/ocp-v2/ocp-v2-events.js';
import {
  normalizeFileDiffs, changesSummary, changesBarView, changesTabs, waitForWorktree,
} from '../public/shared/ocp-v2/ocp-v2-changes-logic.js';

// Captured from `GET /vcs/diff?mode=git` on a live 1.18.34 serve.
const LIVE_DIFF = [
  { file: 'sub/mod.js', patch: 'diff --git a/sub/mod.js b/sub/mod.js\n--- a/sub/mod.js\n+++ b/sub/mod.js\n@@ -1 +1,2 @@\n-export const a = 1;\n+export const a = 2;\n+export const b = 3;\n', additions: 2, deletions: 1, status: 'modified' },
  { file: 'added.txt', patch: 'diff --git a/added.txt b/added.txt\nnew file mode 100644\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+new\n', additions: 1, deletions: 0, status: 'added' },
];

test('file diffs are normalised: sorted, marked, and safe when file or patch is missing', () => {
  const rows = normalizeFileDiffs([...LIVE_DIFF, { additions: 4, deletions: 2 }, { file: 'gone.js', status: 'deleted', additions: 0, deletions: 9, patchTruncated: true }, null]);
  assert.deepEqual(rows.map((r) => [r.file, r.mark, r.additions, r.deletions]), [
    ['(unnamed file)', 'M', 4, 2],
    ['added.txt', 'A', 1, 0],
    ['gone.js', 'D', 0, 9],
    ['sub/mod.js', 'M', 2, 1],
  ]);
  assert.equal(rows[0].patch, '');
  assert.equal(rows[2].patchTruncated, true);
  assert.deepEqual(normalizeFileDiffs(undefined), []);
});

test('the summary comes from the diffs when there are any, else from Session.summary', () => {
  assert.deepEqual(changesSummary(LIVE_DIFF, { files: 99, additions: 99, deletions: 99 }), { files: 2, additions: 3, deletions: 1 });
  assert.deepEqual(changesSummary([], { files: 3, additions: 12, deletions: 4 }), { files: 3, additions: 12, deletions: 4 });
  assert.deepEqual(changesSummary(null, null), { files: 0, additions: 0, deletions: 0 });
});

test('session.diff fills the store and the bar appears; a new session starts clean', () => {
  const store = createPanelStore();
  store.setSession('ses_1', { id: 'ses_1' });
  assert.equal(changesBarView(store.getState()).visible, false);

  applyEvent(store, 'session.diff', { sessionID: 'ses_1', diff: LIVE_DIFF });
  const view = changesBarView(store.getState());
  assert.deepEqual([view.visible, view.label, view.stat], [true, '2 files changed', '+3 −1']);
  applyEvent(store, 'session.diff', { sessionID: 'ses_1', diff: LIVE_DIFF.slice(0, 1) });
  assert.equal(changesBarView(store.getState()).label, '1 file changed');
  // An event without a list empties it rather than throwing.
  applyEvent(store, 'session.diff', { sessionID: 'ses_1' });
  assert.equal(changesBarView(store.getState()).visible, false);

  // After a reload the totals OpenCode keeps on the session are enough for the bar.
  store.setSessionInfo({ id: 'ses_1', summary: { additions: 7, deletions: 2, files: 4 } });
  assert.deepEqual([changesBarView(store.getState()).label, changesBarView(store.getState()).stat], ['4 files changed', '+7 −2']);

  store.setSessionDiff(LIVE_DIFF);
  store.setSession('ses_2', { id: 'ses_2' });
  assert.deepEqual(store.getState().sessionDiff, []);
  assert.equal(changesBarView(store.getState()).visible, false);
  assert.equal(changesBarView(null).visible, false);
});

test('the viewer offers the working tree only when the server can diff it', () => {
  assert.deepEqual(changesTabs(() => false).map((t) => t.id), ['session']);
  assert.deepEqual(changesTabs((type) => type === 'vcs:diff').map((t) => t.id), ['session', 'worktree']);
});

// A subscription the test drives by hand.
function fakeEvents() {
  const listeners = new Set();
  return {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (type, ev) => { for (const fn of [...listeners]) fn(type, ev); },
    count: () => listeners.size,
  };
}

test('waitForWorktree resolves on ready, on failed, and on a timeout; it always unsubscribes', async () => {
  const ready = fakeEvents();
  const p1 = waitForWorktree(ready.subscribe, 'calm-river', { timeoutMs: 5000 });
  ready.emit('worktree.ready', { name: 'other-tree' });
  ready.emit('message.updated', {});
  assert.equal(ready.count(), 1, 'still waiting for its own worktree');
  ready.emit('worktree.ready', { name: 'calm-river', branch: 'opencode/calm-river' });
  assert.deepEqual(await p1, { ok: true });
  assert.equal(ready.count(), 0);

  // Without a name nothing can be matched: "the first ready event counts" let
  // another window's worktree start this session (review F09). The panel now
  // subscribes with watchWorktree and names the worktree once the reply has it.
  const any = fakeEvents();
  const p2 = waitForWorktree(any.subscribe, '', { timeoutMs: 5000 });
  any.emit('worktree.ready', { name: 'whatever' });
  assert.deepEqual(await p2, { ok: false, error: 'OpenCode did not name the new worktree.' });
  assert.equal(any.count(), 0);

  // worktree.failed carries no name, so it cannot be this creation's for sure:
  // it never ends the wait (review 2, R05). Only the timeout does, and then the
  // failure is quoted as what it is.
  const failed = fakeEvents();
  const timers = [];
  const p3 = waitForWorktree(failed.subscribe, 'x', {
    timeoutMs: 5000, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  failed.emit('worktree.failed', { message: 'git worktree add failed' });
  assert.deepEqual(timers.map((t) => t.ms), [5000], 'a failure arms no timer of its own');
  assert.equal(failed.count(), 1, 'still waiting');
  timers[0].fn();
  const timedOut = await p3;
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.failureSeen, 'git worktree add failed');
  assert.match(timedOut.error, /^The worktree was not ready in time\. OpenCode reported a worktree failure meanwhile, which may or may not be this one .*: git worktree add failed$/);
  assert.equal(failed.count(), 0);

  const silent = fakeEvents();
  let fire = null;
  const p4 = waitForWorktree(silent.subscribe, 'x', { timeoutMs: 10, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  fire();
  assert.deepEqual(await p4, { ok: false, error: 'The worktree was not ready in time.' });
  assert.equal(silent.count(), 0);
});

test('the branch dropdown re-reads the branch when OpenCode reports a change', () => {
  const projectbar = readFileSync(new URL('../public/shared/ocp-v2/ocp-v2-projectbar.js', import.meta.url), 'utf8');
  assert.match(projectbar, /if \(eventType !== 'vcs\.branch\.updated' \|\| !_branchDd\) return;/);
  assert.match(projectbar, /_branchCache\.delete\(cwd\);\s+syncToCwd\(cwd\);/);
});
