// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Review place, as data
// ═══════════════════════════════════════════
//
// Review holds what waits for the owner (owner decision 2026-10-22: nothing the Assistant makes installs by itself):
//   - submissions of the Review queue (lib/skills/reviews.js): a new skill or a change, from the SynaBun Assistant
//     or another agent, with the evidence the service computed for exactly its bytes (the checks per target, the
//     scan, what it can do that the approved revision could not, the files it changes, the name it installs as);
//   - updates from SynaBun: a skill this app version ships in a newer version than the copy that is installed
//     (an installation of an older revision, or a folder of its name whose SKILL.md is not the shipped one).
// Cards are codes and data; the view words them (`skillsStudio.review.*`). An update the owner chose to keep as it
// is ("Keep mine") stays out of the list until SynaBun ships yet another version. No DOM and no imports.

import { revealHidden } from '../ss-unicode.js';

export const OPEN_STATES = Object.freeze(['pending', 'changes_requested', 'approved', 'partial', 'publish_failed']);
export const DECIDED_STATES = Object.freeze(['published', 'rejected', 'withdrawn']);
const AUTHORITY_KINDS = ['scripts', 'binaries', 'dynamicContext', 'hooks', 'toolGrants', 'domains', 'sensitive', 'persistentWrites', 'installers'];

const list = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** What a revision can do that the approved one could not: one entry per kind, with what was added and removed. */
export function authorityRows(delta) {
  const out = [];
  for (const [kind, change] of Object.entries(delta?.byKind || {})) {
    if (!AUTHORITY_KINDS.includes(kind)) continue;
    const added = list(change?.added).map(String);
    const removed = list(change?.removed).map(String);
    if (added.length || removed.length) out.push({ kind, added, removed });
  }
  return out;
}

/** The scan of a submission, as a code and a severity. */
export function scanState(scan) {
  if (!scan) return { code: 'not-scanned', sev: 'warn', found: 0 };
  const found = Object.values(scan.counts || {}).reduce((n, c) => n + num(c), 0);
  if (scan.status === 'error') return { code: 'error', sev: 'err', found };
  if (scan.gate === 'blocked') return { code: 'blocked', sev: 'err', found };
  if (scan.status === 'no_findings') return { code: 'clean', sev: 'ok', found: 0 };
  if (scan.status === 'incomplete') return { code: 'incomplete', sev: 'warn', found };
  return { code: scan.gate === 'review' ? 'review' : 'findings', sev: scan.gate === 'review' ? 'warn' : 'info', found };
}

/** What the owner can do with a submission now. */
export function reviewActions(review, { guest = false } = {}) {
  if (guest) return [];
  if (review?.state === 'pending') return ['approve', 'request_changes', 'reject'];
  if (review?.state === 'changes_requested') return ['reject'];
  if (['approved', 'partial', 'publish_failed'].includes(review?.state)) return ['install'];
  return [];
}

/**
 * One submission as a card.
 * @returns {object}
 */
export function reviewCardModel(review, { guest = false } = {}) {
  const ev = review?.evidence || {};
  const lintErrors = Object.values(ev.lint?.profiles || {}).reduce((n, p) => n + num(p?.errors), 0);
  const lintWarnings = Object.values(ev.lint?.profiles || {}).reduce((n, p) => n + num(p?.warnings), 0);
  const author = review?.author || {};
  return {
    id: review?.reviewId,
    skillId: review?.skillId || null,
    name: revealHidden(String(review?.skillName || review?.skillId || '')),
    kind: review?.baseApprovedRevisionId ? 'change' : 'new',
    state: review?.state || 'pending',
    author: { kind: author.kind === 'owner' ? 'owner' : author.kind === 'assistant' ? 'assistant' : 'agent', provider: author.provider || null, model: author.model || null, runId: author.runId || null },
    createdAt: review?.createdAt || null,
    decidedAt: review?.decidedAt || null,
    notes: String(review?.releaseNotes || ''),
    assumptions: list(review?.assumptions).map(String).slice(0, 20),
    targets: list(review?.targets).map((t) => ({ runtime: t?.runtime, scope: t?.scope || 'user', projectPath: t?.projectPath || null, accountId: t?.accountId || null })),
    installAs: typeof ev.installName === 'string' && ev.installName ? revealHidden(ev.installName) : null,
    lint: { errors: lintErrors, warnings: lintWarnings, resourceProblems: num(ev.lint?.resourceProblems) },
    scan: { ...scanState(ev.scan), findings: list(ev.scan?.findings).slice(0, 10).map((f) => ({ severity: ['critical', 'high', 'medium', 'low', 'info'].includes(f?.severity) ? f.severity : 'low', message: String(f?.message ?? ''), file: f?.file || null, line: f?.line || null, ruleId: f?.ruleId || null })) },
    authority: authorityRows(ev.authority),
    files: list(ev.diff?.files).map((f) => ({ path: String(f.path ?? ''), status: f.status })),
    fromRevisionId: ev.diff?.from?.revisionId || review?.baseApprovedRevisionId || null,
    revisionId: review?.submittedRevisionId || null,
    reason: review?.decisionReason || '',
    comments: list(review?.comments).slice(-5).map((c) => ({ by: c?.by?.kind === 'owner' ? 'owner' : (c?.by?.kind || 'agent'), body: String(c?.body ?? ''), at: c?.at || null })),
    publication: list(review?.publication?.targetResults).slice(-12).map((r) => ({ targetKey: r.targetKey, status: r.status, error: r.error || null })),
    actions: reviewActions(review, { guest }),
  };
}

/** Open submissions first (pending, then the rest), newest first in each; decided ones apart. */
export function sortReviews(reviews) {
  const rank = { pending: 0, changes_requested: 1, approved: 2, partial: 3, publish_failed: 4 };
  const open = list(reviews).filter((r) => OPEN_STATES.includes(r?.state))
    .sort((a, b) => (rank[a.state] - rank[b.state]) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const decided = list(reviews).filter((r) => DECIDED_STATES.includes(r?.state))
    .sort((a, b) => String(b.updatedAt || b.decidedAt || '').localeCompare(String(a.updatedAt || a.decidedAt || '')));
  return { open, decided };
}

/**
 * The updates SynaBun ships, from the Library rows (sx-library.js marks a bundled row's `update`), less the ones the
 * owner keeps as they are for that upstream revision.
 * @param {object[]} rows
 * @param {Record<string, string>} [kept] skill name → the upstream revision id the owner said "Keep mine" to
 */
export function updateCards(rows, kept = {}) {
  return list(rows).filter((r) => r?.update && r.source === 'synabun' && r.kind === 'skill')
    .filter((r) => !(r.update.upstreamRevisionId && kept?.[r.folderName] === r.update.upstreamRevisionId))
    .map((r) => ({
      key: r.key,
      name: r.folderName,
      label: r.label || revealHidden(r.folderName || ''),
      skillId: r.skill?.skillId || null,
      upstreamRevisionId: r.update.upstreamRevisionId,
      kind: r.update.kind,
      installations: r.update.installations,
      legacyCopies: r.update.legacyCopies,
      runtimes: [...new Set([...(r.update.legacyCopies || []).flatMap((c) => c.runtimes || []), ...((r.skill?.installations || []).filter((i) => r.update.installations.includes(i.installationId)).map((i) => i.runtime))])],
    }));
}

/**
 * The install targets an update of a shipped skill replaces: the folder each old copy is in (the target whose root
 * holds it), and the target of each older installation. Never every runtime that reads a copy: OpenCode reads
 * Claude Code's folder too, and a second copy in its own folder would be listed twice.
 * @param {object} update a row's `update` (sx-library.js)
 * @param {object[]} installations the library skill's installations (GET /skills)
 * @param {{ key: string, path: string|null, runtime: string, scope: string, accountId: string, projectPath: string|null }[]} targets sx-subject.js installTargets()
 * @returns {string[]} target keys
 */
export function updateTargetKeys(update, installations, targets) {
  const trim = (p) => String(p || '').replace(/[\\/]+$/, '');
  const parent = (p) => trim(p).replace(/[\\/][^\\/]*$/, '');
  const folders = new Set(list(update?.legacyCopies).map((c) => parent(c?.path)).filter(Boolean));
  const ids = new Set(list(update?.installations));
  const keyOf = (i) => (i?.scope === 'project' ? `${i.runtime}:project:${i.projectPath}` : `${i?.runtime}:user:${i?.accountId || 'default'}`);
  const installed = new Set(list(installations).filter((i) => ids.has(i?.installationId)).map(keyOf));
  return list(targets).filter((tg) => !tg.off && ((tg.path && folders.has(trim(tg.path))) || installed.has(tg.key))).map((tg) => tg.key);
}

/** How many things wait in Review: open submissions that need the owner, and updates. */
export function reviewCount(reviews, updates = []) {
  return list(reviews).filter((r) => r?.state === 'pending' || ['approved', 'partial', 'publish_failed'].includes(r?.state)).length + list(updates).length;
}
