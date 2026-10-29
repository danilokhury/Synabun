// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: an install plan, its outcome and its checks, as codes
// ═══════════════════════════════════════════
//
// The Publish tab installs one revision into the targets the owner picks, in the service's two steps
// (lib/skills/deploy.js): a plan (POST /v2/installations/plan: per target where it goes, who reads that folder,
// what is there now, the checks of the exported bytes, what blocks it, what needs the owner's confirmation, how a
// running session picks it up), then an install of exactly that plan (its digest) with only what the owner
// confirmed. This module turns a plan, an install's answer and a verify into rows of codes the view words
// (`skillsStudio.publish.*`); a message the service wrote (a reason it blocks) is kept as data next to its code.
// Nothing is confirmed by default. No DOM and no imports.

export const BLOCK_CODES = Object.freeze(['no_root', 'shared_root_off', 'root_read_only', 'root_unusable', 'lint_errors', 'scan_blocked', 'review_required', 'approval_stale', 'destination_unreadable']);
// panel-reload: SynaBun's own Codex / OpenCode panel lists the skill now (Codex: a forced reload of its skill list on
// skills:changed; OpenCode: its serve reads the folders again on every listing); a session open in a terminal needs a
// new one. new-session stays for a server from before this.
// terminal-only: a Claude Code folder OpenCode reads only outside SynaBun (its own serves start with
// OPENCODE_DISABLE_CLAUDE_CODE=1): install for OpenCode for SynaBun's panel and an OpenCode Assistant.
export const REFRESH_KINDS = Object.freeze(['automatic', 'reload-skills', 'new-session', 'panel-reload', 'terminal-only']);
// Why a runtime could not be asked on Verify (lib/skills/runtime-checks.js probe, deploy.js verify): each has its words.
export const PROBE_CODES = Object.freeze(['not-installed', 'not-running', 'no-answer', 'no-list', 'terminal-only']);
export const ELIGIBILITY_STATES = Object.freeze(['enabled', 'disabled', 'unknown']);
export const ELIGIBILITY_REASONS = Object.freeze(['codex-config', 'claude-override', 'claude-deny', 'opencode-permission', 'unreadable', 'invalid-json']);
export const RESULT_STATES = Object.freeze(['committed', 'skipped', 'needs-confirmation', 'failed']);

const list = (v) => (Array.isArray(v) ? v : []);

// ── What Publish holds ──
// A workspace's Publish state: the targets ticked (null until the first drawing picks them), the projects shown,
// the plan with exactly what it was asked for (`planRevision`, `planTargets`), what the owner confirmed of it, the
// last install's outcome, the verifies, and whether a request is on its way (`busy`: the targets and the version
// are locked meanwhile).

/**
 * Publish as it starts: nothing ticked yet (the first drawing picks the defaults), every project in one scope, no
 * plan and none on its way, nothing confirmed, Advanced and Export folded.
 */
export function newPublishState() {
  return { checked: null, projects: [], scope: 'user', plan: null, planTargets: null, planRevision: null, planning: null, planError: null, planTimer: 0, confirmed: { replace: new Set(), scan: new Set() }, results: null, verify: {}, busy: false, config: null, advanced: false, exportOpen: false };
}

/** Forget a plan and what was confirmed of it: a plan is installed only for what it was asked for. */
export function clearPlan(pub) {
  if (!pub) return;
  pub.plan = null;
  pub.planTargets = null;
  pub.planRevision = null;
  pub.planError = null;
  pub.confirmed = { replace: new Set(), scan: new Set() };
}

/**
 * Publish shows another version (its dropdown, Versions' "Publish this"): the plan made for the one before goes,
 * and so does the review it was installing when that review is of another version.
 * @param {object} ws a workspace @param {string|null} revisionId @param {{ reviews?: object[] }} [o] the reviews read
 */
export function choosePublishRevision(ws, revisionId, { reviews = [] } = {}) {
  if (ws.publishReviewId) {
    const review = list(reviews).find((r) => r?.reviewId === ws.publishReviewId);
    if (review?.submittedRevisionId !== revisionId) ws.publishReviewId = null;
  }
  ws.publishRevisionId = revisionId || null;
  if (ws.pub) { clearPlan(ws.pub); ws.pub.results = null; }
}

/**
 * One row per target of a plan.
 * @returns {{ planDigest: string|null, revisionId: string|null, name: string, rows: object[] }}
 */
export function planModel(plan) {
  const rows = list(plan?.targets).map((t) => {
    const replace = list(t.needs).find((n) => n.code === 'confirm_replace') || null;
    const scanAck = list(t.needs).find((n) => n.code === 'acknowledge_scan') || null;
    const blocked = list(t.blocked).map((b) => ({ code: BLOCK_CODES.includes(b.code) ? b.code : 'other', message: String(b.message ?? '') }));
    return {
      targetKey: t.targetKey,
      runtime: t.runtime, scope: t.scope || 'user', accountId: t.accountId || 'default', projectPath: t.projectPath || null,
      destination: t.destination || null,
      affectedRuntimes: list(t.affectedRuntimes),
      status: blocked.length ? 'blocked' : (list(t.needs).length ? 'needs' : 'ready'),
      blocked,
      state: t.destinationState?.state || null,
      installedBySynabun: !!t.destinationState?.installedBySynabun,
      replace: replace ? { currentDigest: replace.currentDigest ?? null, state: t.destinationState?.state || null, message: String(replace.message ?? '') } : null,
      scanAck: scanAck ? { digest: scanAck.digest, findings: list(t.scan?.findings).slice(0, 12) } : null,
      transforms: list(t.export?.transforms).map((tr) => ({ op: tr.op, key: tr.key || null, file: tr.file || null, reason: String(tr.reason ?? '') })),
      overlap: list(t.overlap).map((o) => ({ path: o.path, runtimes: list(o.runtimes), name: typeof o.name === 'string' ? o.name : (t.name || plan?.name || ''), why: String(o.why ?? '') })),
      name: typeof t.name === 'string' ? t.name : (plan?.name || ''),
      lint: { errors: Number(t.lint?.errors) || 0, warnings: Number(t.lint?.warnings) || 0, diagnostics: list(t.lint?.diagnostics).slice(0, 50) },
      scan: { status: t.scan?.status || null, gate: t.scan?.gate || null, counts: t.scan?.counts || {}, trusted: !!t.scan?.trustedBundled, disclosure: t.scan?.disclosure || '' },
      refresh: list(t.refresh).map((r) => ({ runtime: r.runtime, kind: REFRESH_KINDS.includes(r.kind) ? r.kind : 'unknown', message: String(r.message ?? '') })),
      // Whether each runtime's own settings let the skill through (a server from before this says nothing: unknown).
      eligibility: Object.fromEntries(Object.entries(t.eligibility && typeof t.eligibility === 'object' ? t.eligibility : {}).map(([runtime, e]) => [runtime, {
        state: ELIGIBILITY_STATES.includes(e?.state) ? e.state : 'unknown',
        reason: e?.reason && typeof e.reason === 'object' ? { kind: ELIGIBILITY_REASONS.includes(e.reason.kind) ? e.reason.kind : 'other', file: typeof e.reason.file === 'string' ? e.reason.file : null, pattern: typeof e.reason.pattern === 'string' ? e.reason.pattern : null, rule: typeof e.reason.rule === 'string' ? e.reason.rule : null, key: typeof e.reason.key === 'string' ? e.reason.key : null } : null,
      }])),
    };
  });
  return { planDigest: plan?.planDigest || null, revisionId: plan?.revisionId || null, name: plan?.name || '', rows };
}

/**
 * The decisions an install sends: for each target exactly what the owner confirmed (the digest of what is there
 * now, the digest whose scan findings were read).
 * @param {object} model planModel()
 * @param {{ replace?: Iterable<string>, scan?: Iterable<string> }} confirmed target keys
 */
export function decisionsOf(model, { replace = [], scan = [] } = {}) {
  const r = new Set(replace); const s = new Set(scan);
  const out = {};
  for (const row of model.rows) {
    const d = {};
    if (row.replace && r.has(row.targetKey)) d.expectedDestinationDigest = row.replace.currentDigest;
    if (row.scanAck && s.has(row.targetKey)) d.acknowledgedDigest = row.scanAck.digest;
    if (Object.keys(d).length) out[row.targetKey] = d;
  }
  return out;
}

/** The targets an install with these confirmations would write (not blocked, and everything asked confirmed). */
export function installableRows(model, { replace = [], scan = [] } = {}) {
  const r = new Set(replace); const s = new Set(scan);
  return model.rows.filter((row) => row.status !== 'blocked' && (!row.replace || r.has(row.targetKey)) && (!row.scanAck || s.has(row.targetKey)));
}

/** The outcome per target of an install (200 or 207), never one word for all. */
export function resultModel(result) {
  return list(result?.results).map((r) => ({
    targetKey: r.targetKey,
    status: RESULT_STATES.includes(r.status) ? r.status : 'failed',
    unchanged: !!r.unchanged,
    installationId: r.installationId || null,
    backupId: r.backupId || null,
    reasons: list(r.reasons).map((x) => ({ code: x.code || 'other', message: String(x.message ?? '') })),
    error: r.error ? String(r.error) : null, ...(r.code ? { code: r.code } : {}),
    refresh: list(r.refresh).map((x) => ({ runtime: x.runtime, kind: REFRESH_KINDS.includes(x.kind) ? x.kind : 'unknown', message: String(x.message ?? '') })),
  }));
}

/** What a verify found, fact by fact; nothing is claimed that the service did not establish ("loaded" never is). */
export function verifyFacts(installation) {
  const s = installation?.state || {};
  const written = s.writtenCheck || (s.written === true ? 'verified' : s.written === false ? 'changed' : 'unknown');
  const discovered = s.discovered && typeof s.discovered === 'object'
    ? Object.entries(s.discovered).map(([runtime, v]) => ({ runtime, discovered: v?.discovered ?? (typeof v === 'boolean' ? v : null), error: v?.error || null, code: PROBE_CODES.includes(v?.code) ? v.code : null }))
    : [];
  return {
    written,
    discoverable: s.discoverable === true ? 'yes' : s.discoverable === false ? 'no' : 'unknown',
    eligibility: ['enabled', 'disabled'].includes(s.eligibility) ? s.eligibility : 'unknown',
    discovered,
    checks: list(s.checks).map((c) => ({ runtime: c.runtime || null, ok: !!c.ok, message: String(c.message ?? '') })),
    checkedAt: s.checkedAt || null,
  };
}

/** Whether an error of a rollback / uninstall asks the owner to confirm the folder as it is now. */
export const needsConfirmation = (err) => err?.status === 409 && (err.code === 'rollback_conflict' || err.code === 'uninstall_conflict') && typeof err.body?.currentDigest === 'string';
