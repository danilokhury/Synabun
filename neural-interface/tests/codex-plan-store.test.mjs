import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexPlanStore } from '../lib/codex-plan-store.js';

test('plan store isolates threads, round-trips Markdown, and rejects stale editor writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createCodexPlanStore(root);
  const document = { id: 'plan', accountId: 'account', threadId: 'thread', markdown: '# Full plan\n\n```js\n1\n```\n', revision: 1, status: 'complete', approvedRevision: null };
  const first = store.save({ document });
  assert.equal(readFileSync(first.path, 'utf8'), document.markdown);
  assert.equal(store.read('another-account', 'thread'), null);
  const updated = { ...document, markdown: '# Edited plan', revision: 2 };
  store.save({ document: updated, expectedRevision: 1, expectedPlanId: 'plan' });
  assert.throws(() => store.save({ document: { ...updated, markdown: 'Stale edit' }, expectedRevision: 1, expectedPlanId: 'plan' }), { status: 409 });
  assert.equal(store.read('account', 'thread').history[0].markdown, document.markdown);
  assert.equal(createCodexPlanStore(root).read('account', 'thread').document.markdown, updated.markdown);
  store.save({ document: { ...updated, approvedRevision: 2 }, expectedRevision: 2, expectedPlanId: 'plan' });
  assert.equal(store.read('account', 'thread').document.approvedRevision, 2);
});

test('host-owned plan paths cannot traverse and materialization repairs stale files', t => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createCodexPlanStore(root);
  const document = { id: '../plan', accountId: '../account', threadId: '../../thread', markdown: 'Exact plan', revision: 1, status: 'complete' };
  const first = store.save({ document });
  assert.ok(first.path.startsWith(root));
  writeFileSync(first.path, 'External stale edit');
  const second = store.save({ document, expectedRevision: 1, expectedPlanId: '../plan' });
  assert.equal(readFileSync(second.path, 'utf8'), 'Exact plan');
});
