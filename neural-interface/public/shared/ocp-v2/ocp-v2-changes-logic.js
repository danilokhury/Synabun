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

// ── Worktrees ───────────────────────────────────────────────────────────────

/**
 * Watch one worktree creation from request to ready.
 *
 * Subscribe before asking OpenCode to create the worktree (worktree.ready can
 * beat the reply), then call `identify(name)` with the name the reply carries.
 * Until then events are kept, not acted on: `worktree.ready` names its
 * worktree, so only the one for `name` counts, and another window's or
 * project's creation finishing first changes nothing.
 *
 * The outcome is decided by that ready event and nothing else. `worktree.failed`
 * carries a message and no name (1.18.34: `{ message }`), so a failure cannot
 * be told apart from the failure of another creation on the same serve
 * (another window, another project). It therefore never ends this creation:
 * the message is kept, the wait goes on, and a ready for `name` still wins. If
 * no ready arrives before `timeoutMs`, the last resort, the result says so and
 * quotes the failure that was seen, as what it is: possibly this creation's,
 * possibly not. What this costs: a creation that really failed is reported
 * after the timeout instead of at once.
 *
 *   subscribe(listener)  raw event subscription, returns unsubscribe
 *   returns { result, identify(name), cancel(error?) }
 *   result resolves { ok: true } or { ok: false, error, failureSeen? }
 */
export function watchWorktree(subscribe, {
  timeoutMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let name = '';
  let done = false;
  let unsubscribe = () => {};
  let timer = null;
  let failure = '';                    // the last unattributable worktree.failed message
  const readyNames = new Set();        // worktree.ready seen before identify()
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  const finish = (outcome) => {
    if (done) return;
    done = true;
    if (timer) clearTimer(timer);
    try { unsubscribe(); } catch { /* already gone */ }
    resolveResult(outcome);
  };

  unsubscribe = subscribe((eventType, ev) => {
    if (done) return;
    if (eventType === 'worktree.ready') {
      const readyName = typeof ev?.name === 'string' ? ev.name : '';
      if (!readyName) return;
      if (!name) readyNames.add(readyName);
      else if (readyName === name) finish({ ok: true });
    } else if (eventType === 'worktree.failed') {
      failure = ev?.message || 'OpenCode could not prepare a worktree.';
    }
  });
  timer = setTimer(() => finish(worktreeTimeoutOutcome(failure)), timeoutMs);

  return {
    result,
    /** The create reply named the worktree: act on what was seen so far. */
    identify(worktreeName) {
      if (done || name) return;
      name = String(worktreeName || '');
      if (!name) { finish({ ok: false, error: 'OpenCode did not name the new worktree.' }); return; }
      if (readyNames.has(name)) finish({ ok: true });
    },
    cancel(error = 'Worktree creation was cancelled.') { finish({ ok: false, error }); },
  };
}

/** What the wait reports when no ready event for the worktree came in time. */
export function worktreeTimeoutOutcome(failure) {
  if (!failure) return { ok: false, error: 'The worktree was not ready in time.' };
  return {
    ok: false,
    failureSeen: failure,
    error: `The worktree was not ready in time. OpenCode reported a worktree failure meanwhile, which may or may not be this one (the report names no worktree): ${failure}`,
  };
}

/**
 * Wait for the worktree called `name` (already known) to be ready.
 * Resolves { ok: true } on its worktree.ready, { ok: false, error } on a
 * failure or after `timeoutMs`.
 */
export function waitForWorktree(subscribe, name, options = {}) {
  const watch = watchWorktree(subscribe, options);
  watch.identify(name);
  return watch.result;
}

// ── New-session dialog ──────────────────────────────────────────────────────

/**
 * What "Save" in the new-session dialog does.
 *   { project, branch, currentBranch, wantsWorktree, cwd }
 * → { worktree, checkout, projectChanged }
 * A session in a new worktree never touches the project's own checkout: the
 * worktree is created from what the project has checked out now (OpenCode's
 * worktree.create takes no base), so no branch is switched for it.
 */
export function newSessionPlan({ project = '', branch = '', currentBranch = '', wantsWorktree = false, cwd = '' } = {}) {
  const worktree = !!wantsWorktree && !!project;
  const switchBranch = !worktree && !!project && !!branch && !!currentBranch && branch !== currentBranch;
  return {
    worktree,
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
