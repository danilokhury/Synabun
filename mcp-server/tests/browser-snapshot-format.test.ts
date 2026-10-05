import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/neural-interface.js', () => ({}));
vi.mock('../src/services/sqlite.js', () => ({ getMemory: vi.fn() }));

import { formatAiSnapshotBody } from '../src/tools/browser-observe.js';

describe('AI snapshot response formatting', () => {
  it('does not retruncate a server-budgeted delivered baseline', () => {
    const snapshotText = '- button "Save" [ref=e123]';
    const output = formatAiSnapshotBody({ snapshotText, snapshotBudgetApplied: true, snapshotId: 'snapshot-1' }, 10);
    expect(output).toContain(snapshotText);
    expect(output).toContain('Snapshot: snapshot-1');
  });

  it('truncates old-server responses on complete lines', () => {
    const output = formatAiSnapshotBody({ snapshotText: '- heading "Title"\n- button "Save" [ref=e123]' }, 35);
    expect(output).toContain('- heading "Title"');
    expect(output).not.toContain('[ref=');
    expect(output).toContain('truncated');
  });

  it('marks deletion-only diffs and baseline IDs explicitly', () => {
    const output = formatAiSnapshotBody({
      snapshotId: 'second', baselineId: 'first', snapshotIsDiff: true, snapshotBudgetApplied: true,
      snapshotText: '- - button "Deleted" [ref=e1]', diffRemovedLines: 1, diffAddedLines: 0,
    }, 1000);
    expect(output).toContain('baseline: first');
    expect(output).toContain('- removed, + added');
    expect(output).toContain('- - button "Deleted"');
    expect(output).not.toContain('previous refs');
  });

  it('describes unchanged truncated observations without claiming the whole page is unchanged', () => {
    const output = formatAiSnapshotBody({ unchanged: true, snapshotTruncated: true, snapshotId: 'next' }, 1000);
    expect(output).toContain('observed scope unchanged');
    expect(output).toContain('truncated');
    expect(output).not.toContain('page unchanged');
    expect(output).not.toContain('refs remain valid');
  });
});
