// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — changes review, decisions (no DOM)
// File diffs come from three places with one shape (SnapshotFileDiff):
//   session.diff event / session:diff   what this session changed
//   Session.summary                     the totals OpenCode keeps on the session
//   vcs:diff                            the working tree against HEAD
// `file` and `patch` are optional in the SDK, so everything is null-checked.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_MARKS = { added: 'A', deleted: 'D', modified: 'M' };

export function normalizeFileDiffs(list) {
  return (Array.isArray(list) ? list : [])
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      file: typeof row.file === 'string' && row.file ? row.file : '(unnamed file)',
      patch: typeof row.patch === 'string' ? row.patch : '',
      additions: Number(row.additions) || 0,
      deletions: Number(row.deletions) || 0,
      status: typeof row.status === 'string' ? row.status : 'modified',
      mark: STATUS_MARKS[row.status] || 'M',
      patchTruncated: row.patchTruncated === true,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Totals for the changes bar: from the diffs when there are any, else from Session.summary. */
export function changesSummary(diffs, sessionSummary) {
  const rows = normalizeFileDiffs(diffs);
  if (rows.length) {
    return {
      files: rows.length,
      additions: rows.reduce((sum, row) => sum + row.additions, 0),
      deletions: rows.reduce((sum, row) => sum + row.deletions, 0),
    };
  }
  return {
    files: Number(sessionSummary?.files) || 0,
    additions: Number(sessionSummary?.additions) || 0,
    deletions: Number(sessionSummary?.deletions) || 0,
  };
}

/** `{ visible, label, stat }` for the bar above the composer. */
export function changesBarView(state) {
  const summary = changesSummary(state?.sessionDiff, state?.sessionInfo?.summary);
  return {
    visible: summary.files > 0,
    label: `${summary.files} file${summary.files === 1 ? '' : 's'} changed`,
    stat: `+${summary.additions} −${summary.deletions}`,
    ...summary,
  };
}

/** Which tabs the viewer offers. The session tab works from the event data alone. */
export function changesTabs(supports = () => false) {
  const tabs = [{ id: 'session', label: 'This session' }];
  if (supports('vcs:diff')) tabs.push({ id: 'worktree', label: 'Working tree' });
  return tabs;
}

// ── New-session dialog ──────────────────────────────────────────────────────

/**
 * What "Save" in the new-session dialog does.
 *   { project, branch, currentBranch, cwd } → { checkout, projectChanged }
 */
export function newSessionPlan({ project = '', branch = '', currentBranch = '', cwd = '' } = {}) {
  const switchBranch = !!project && !!branch && !!currentBranch && branch !== currentBranch;
  return {
    checkout: switchBranch ? { path: project, branch } : null,
    projectChanged: !!project && project !== (cwd || ''),
  };
}

/** The answer of POST /api/terminal/checkout as `{ ok, error }`. */
export function checkoutOutcome(status, body) {
  if (status >= 200 && status < 300 && body?.ok !== false && !body?.error) return { ok: true };
  const detail = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${status}`;
  return { ok: false, error: `Could not switch branch: ${detail}` };
}
