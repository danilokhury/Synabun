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
export const REFRESH_KINDS = Object.freeze(['automatic', 'reload-skills', 'new-session']);
export const RESULT_STATES = Object.freeze(['committed', 'skipped', 'needs-confirmation', 'failed']);

const list = (v) => (Array.isArray(v) ? v : []);

// ── What Publish holds ──
// A workspace's Publish state: the targets ticked (null until the first drawing picks them), the projects shown,
// the plan with exactly what it was asked for (`planRevision`, `planTargets`), what the owner confirmed of it, the
// last install's outcome, the verifies, and whether a request is on its way (`busy`: the targets and the version
// are locked meanwhile).

/** Publish as it starts: nothing ticked yet, no plan, nothing confirmed. */
export function newPublishState() {
  return { checked: null, projects: [], plan: null, planTargets: null, planRevision: null, confirmed: { replace: new Set(), scan: new Set() }, results: null, verify: {}, busy: false, config: null };
}

/** Forget a plan and what was confirmed of it: a plan is installed only for what it was asked for. */
export function clearPlan(pub) {
  if (!pub) return;
  pub.plan = null;
  pub.planTargets = null;
  pub.planRevision = null;
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
      overlap: list(t.overlap).map((o) => ({ path: o.path, runtimes: list(o.runtimes), why: String(o.why ?? '') })),
      lint: { errors: Number(t.lint?.errors) || 0, warnings: Number(t.lint?.warnings) || 0, diagnostics: list(t.lint?.diagnostics).slice(0, 50) },
      scan: { status: t.scan?.status || null, gate: t.scan?.gate || null, counts: t.scan?.counts || {}, trusted: !!t.scan?.trustedBundled, disclosure: t.scan?.disclosure || '' },
      refresh: list(t.refresh).map((r) => ({ runtime: r.runtime, kind: REFRESH_KINDS.includes(r.kind) ? r.kind : 'unknown', message: String(r.message ?? '') })),
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
    error: r.error ? String(r.error) : null,
    refresh: list(r.refresh).map((x) => ({ runtime: x.runtime, kind: REFRESH_KINDS.includes(x.kind) ? x.kind : 'unknown', message: String(x.message ?? '') })),
  }));
}

/** What a verify found, fact by fact; nothing is claimed that the service did not establish ("loaded" never is). */
export function verifyFacts(installation) {
  const s = installation?.state || {};
  const written = s.writtenCheck || (s.written === true ? 'verified' : s.written === false ? 'changed' : 'unknown');
  const discovered = s.discovered && typeof s.discovered === 'object'
    ? Object.entries(s.discovered).map(([runtime, v]) => ({ runtime, discovered: v?.discovered ?? (typeof v === 'boolean' ? v : null), error: v?.error || null }))
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
