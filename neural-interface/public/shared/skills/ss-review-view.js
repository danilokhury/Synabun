// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: the Review queue and install plans, as words
// ═══════════════════════════════════════════
//
// What the Review queue (lib/skills/reviews.js) and an install plan (lib/skills/deploy.js) say, turned into what
// the owner reads and decides on: a card per submission (who made it, what it does, what it can do that the
// approved revision could not, the checks of exactly its bytes), the targets an install can choose, a row per
// target of a plan (where, who sees it, what is there, what it needs confirmed), the decisions the confirmations
// make, and the outcome per target. No DOM: the tests read it (Skills Studio 2.0 draws Review with studio/sx-review-view.js).

export const REVIEW_STATE_LABEL = Object.freeze({
  pending: 'Waiting for your review',
  changes_requested: 'Changes asked for',
  approved: 'Approved, not installed yet',
  publishing: 'Installing',
  published: 'Installed',
  partial: 'Installed in part',
  publish_failed: 'Install failed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
});

export const RUNTIME_LABEL = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', agents: 'Shared (~/.agents/skills)' });

/** A target as a person reads it: the runtime, and the project or the account when it is not the default one. */
export function targetLabel(t) {
  const runtime = RUNTIME_LABEL[t?.runtime] || t?.runtime || '?';
  if (t?.scope === 'project' && t.projectPath) return `${runtime} (project ${t.projectPath})`;
  if (t?.accountId && t.accountId !== 'default') return `${runtime} (account ${t.accountId})`;
  return runtime;
}

/** A target as an install sends it: only the fields a target has (runtime, scope, projectPath, accountId). */
function wholeTarget(t) {
  if (typeof t === 'string') return { runtime: t };
  const out = { runtime: t?.runtime };
  for (const key of ['scope', 'projectPath', 'accountId']) if (typeof t?.[key] === 'string' && t[key]) out[key] = t[key];
  return out;
}
const plainTarget = (t) => (!t.scope || t.scope === 'user') && !t.projectPath && (!t.accountId || t.accountId === 'default');

const AUTHORITY_WORDS = {
  scripts: 'scripts', binaries: 'files that are not text', dynamicContext: 'commands run when it loads', hooks: 'session hooks',
  toolGrants: 'pre-approved tools', domains: 'web addresses', sensitive: 'reads of private data', persistentWrites: 'lasting configuration changes', installers: 'software installs',
};

/** What a revision can do that the approved one could not, in words. */
export function authorityLines(delta) {
  if (!delta || !delta.byKind) return [];
  const out = [];
  for (const [kind, change] of Object.entries(delta.byKind)) {
    const words = AUTHORITY_WORDS[kind] || kind;
    if (change.added?.length) out.push(`Adds ${words}: ${change.added.slice(0, 6).join(', ')}${change.added.length > 6 ? ` and ${change.added.length - 6} more` : ''}`);
    if (change.removed?.length) out.push(`No longer has ${words}: ${change.removed.slice(0, 6).join(', ')}${change.removed.length > 6 ? ` and ${change.removed.length - 6} more` : ''}`);
  }
  return out;
}

function authorLine(author) {
  if (!author) return 'Unknown author';
  if (author.kind === 'owner') return 'You';
  const who = author.kind === 'assistant' ? 'The SynaBun Assistant' : 'An agent';
  const bits = [author.provider, author.model, author.runId ? `run ${author.runId}` : null].filter(Boolean);
  return bits.length ? `${who} (${bits.join(', ')})` : who;
}

function scanLine(scan) {
  if (!scan) return { text: 'Not scanned', severity: 'medium' };
  const counts = scan.counts || {};
  const found = Object.values(counts).reduce((n, c) => n + (Number(c) || 0), 0);
  if (scan.status === 'error') return { text: 'The scan failed: it cannot be approved', severity: 'high' };
  if (scan.gate === 'blocked') return { text: `The scan blocks it (${found} finding${found === 1 ? '' : 's'})`, severity: 'high' };
  if (scan.status === 'no_findings') return { text: 'No findings in the scanned content', severity: 'none' };
  return { text: `${found} finding${found === 1 ? '' : 's'} to review${scan.status === 'incomplete' ? '; part of it could not be read' : ''}`, severity: scan.gate === 'review' ? 'medium' : 'none' };
}

/** One submission as a card. `actions`: what the owner can do with it now. */
export function reviewCard(review) {
  const ev = review.evidence || {};
  const lintErrors = Object.values(ev.lint?.profiles || {}).reduce((n, p) => n + (p.errors || 0), 0);
  const changed = ev.diff?.files || [];
  const scan = scanLine(ev.scan);
  const actions = review.state === 'pending' ? ['approve', 'request_changes', 'reject']
    : review.state === 'changes_requested' ? ['reject']
    : ['approved', 'partial', 'publish_failed', 'published'].includes(review.state) ? ['install'] : [];
  return {
    id: review.reviewId,
    title: review.skillName || review.skillId,
    state: review.state,
    stateLabel: REVIEW_STATE_LABEL[review.state] || review.state,
    author: authorLine(review.author),
    notes: review.releaseNotes || '',
    assumptions: Array.isArray(review.assumptions) ? review.assumptions : [],
    targets: (review.targets || []).map(targetLabel),
    scan,
    lint: lintErrors ? `${lintErrors} problem${lintErrors === 1 ? '' : 's'} for its targets` : 'No problems for its targets',
    lintSeverity: lintErrors ? 'high' : 'none',
    authority: authorityLines(ev.authority),
    changes: ev.diff ? `${changed.length} file${changed.length === 1 ? '' : 's'} changed since the approved revision` : (review.baseApprovedRevisionId ? '' : 'A new skill'),
    reason: review.decisionReason || '',
    comments: (review.comments || []).slice(-5).map((c) => `${c.by?.kind === 'owner' ? 'You' : authorLine(c.by)}: ${c.body}`),
    revisionId: review.submittedRevisionId,
    // The folder name it installs under (its SKILL.md's), and the scan's findings for exactly its bytes.
    installAs: typeof ev.installName === 'string' && ev.installName ? ev.installName : null,
    findings: (ev.scan?.findings || []).slice(0, 5).map((f) => ({ severity: ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low', text: `${f.severity}: ${f.message}` })),
    actions,
  };
}

/**
 * The targets an install can choose: the ones a submission named, whole (scope, project, account) and turned on,
 * then each runtime's own folder for the default account, off (Claude Code on when nothing was named). Each choice
 * carries the `target` an install sends.
 */
export function targetChoices({ sharedAgentsRoot = false } = {}, suggested = []) {
  const asked = (suggested || []).map(wholeTarget).filter((t) => typeof t.runtime === 'string' && t.runtime);
  const seen = new Set();
  const choices = [];
  for (const target of asked) {
    const key = JSON.stringify(target);
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({ key, runtime: target.runtime, target, label: targetLabel(target), on: true });
  }
  const plainAsked = new Set(asked.filter(plainTarget).map((t) => t.runtime));
  for (const runtime of ['claude', 'codex', 'opencode', ...(sharedAgentsRoot ? ['agents'] : [])]) {
    if (plainAsked.has(runtime)) continue;
    const target = { runtime };
    choices.push({ key: JSON.stringify(target), runtime, target, label: targetLabel(target), on: !asked.length && runtime === 'claude' });
  }
  return choices;
}

/** One row per target of a plan: where, who sees it, and what it needs. */
export function planRows(plan) {
  return (plan?.targets || []).map((t) => {
    const replace = (t.needs || []).find((n) => n.code === 'confirm_replace') || null;
    const scanAck = (t.needs || []).find((n) => n.code === 'acknowledge_scan') || null;
    const status = t.blocked?.length ? 'blocked' : (t.needs?.length ? 'needs' : 'ready');
    const lines = [];
    if (t.destination) lines.push(`Goes to ${t.destination}`);
    if (t.affectedRuntimes?.length > 1) lines.push(`Read by ${t.affectedRuntimes.map((r) => RUNTIME_LABEL[r] || r).join(' and ')}`);
    for (const b of t.blocked || []) lines.push(b.message);
    for (const tr of t.export?.transforms || []) lines.push(`Changed for this runtime only: ${tr.reason}`);
    for (const o of t.overlap || []) lines.push(o.why);
    if (t.lint?.warnings) lines.push(`${t.lint.warnings} warning${t.lint.warnings === 1 ? '' : 's'} for this runtime`);
    return {
      targetKey: t.targetKey,
      label: targetLabel(t),
      status, lines,
      replace: replace ? { currentDigest: replace.currentDigest, message: replace.message } : null,
      scanAck: scanAck ? { digest: scanAck.digest, message: scanAck.message, findings: (t.scan?.findings || []).slice(0, 10).map((f) => `${f.severity}: ${f.message}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`) } : null,
      refresh: (t.refresh || []).map((r) => r.message).filter(Boolean),
    };
  });
}

/**
 * The decisions an install sends: for each target, exactly what the owner confirmed (the digest of what is there
 * now, the digest whose scan findings they reviewed). Nothing is confirmed by default.
 * @param {object} plan @param {{ replace: Iterable<string>, scan: Iterable<string> }} confirmed target keys
 */
export function decisionsFor(plan, { replace = [], scan = [] } = {}) {
  const r = new Set(replace); const s = new Set(scan);
  const out = {};
  for (const row of planRows(plan)) {
    const d = {};
    if (row.replace && r.has(row.targetKey)) d.expectedDestinationDigest = row.replace.currentDigest;
    if (row.scanAck && s.has(row.targetKey)) d.acknowledgedDigest = row.scanAck.digest;
    if (Object.keys(d).length) out[row.targetKey] = d;
  }
  return out;
}

/** Whether an install of this plan would do anything with these confirmations. */
export function installable(plan, confirmed = {}) {
  const r = new Set(confirmed.replace || []); const s = new Set(confirmed.scan || []);
  return planRows(plan).some((row) => row.status !== 'blocked' && (!row.replace || r.has(row.targetKey)) && (!row.scanAck || s.has(row.targetKey)));
}

const RESULT_WORDS = { committed: 'Installed', skipped: 'Not installed', 'needs-confirmation': 'Not installed: it needs your confirmation', failed: 'Failed' };

/** The outcome per target, never one word for all. */
export function resultLines(result) {
  return (result?.results || []).map((r) => {
    const why = r.error || (r.reasons || []).map((x) => x.message).filter(Boolean).join(' ');
    const refresh = (r.refresh || []).map((x) => x.message).filter(Boolean).join(' ');
    return { targetKey: r.targetKey, ok: r.status === 'committed', text: `${RESULT_WORDS[r.status] || r.status}${r.unchanged ? ' (it was already there)' : ''}${why ? `: ${why}` : ''}${r.status === 'committed' && refresh ? ` ${refresh}` : ''}` };
  });
}
