// ── The Review queue ──
// What the SynaBun Assistant (or any agent) makes goes here, never straight into a runtime (owner decision,
// 2026-10-22): a submission is one immutable revision of a library skill, with its digest, the targets it is meant
// for, the checks of exactly those bytes, what it can do compared with the revision approved before it (the scan's
// authority inventory, side by side), release notes, the author's assumptions, and who made it. The owner
// approves, asks for changes or rejects; only an approval moves the skill's `approved` pointer, and only an
// approved revision of an agent's is installed (lib/skills/deploy.js refuses the rest). New bytes need a new
// submission: an approval belongs to the digest it was given for.
//
//   pending ──► approved ──► publishing ──► published | partial | publish_failed
//      │  └──► changes_requested ──► (a new submission links back to it)
//      ├──► rejected
//      └──► withdrawn (the author, or the owner)
//
// DATA_HOME/data/skills/reviews.json (schema 2), written whole and atomically.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PathConfineError } from '../path-confine.js';
import { readConfinedFile, replaceFileAtomic } from '../confined-fs.js';
import { normalizeAuthor } from './library.js';

export const REVIEWS_SCHEMA = 2;
export const REVIEW_POLICY = 'review-policy-1';
export const REVIEW_STATES = Object.freeze(['pending', 'changes_requested', 'approved', 'publishing', 'published', 'partial', 'publish_failed', 'rejected', 'withdrawn']);
const OPEN = new Set(['pending', 'changes_requested']);
const MAX_REVIEWS = 2000;
const MAX_COMMENTS = 200;
const REVIEW_RE = /^rvw_[0-9a-f]{20}$/;

export class ReviewError extends PathConfineError {
  constructor(status, message, code, extra = {}) {
    super(status, message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/** What one revision can do that the other cannot (the scans' authority inventories compared). */
export function authorityDelta(before, after) {
  const keys = ['scripts', 'binaries', 'dynamicContext', 'hooks', 'toolGrants', 'domains', 'sensitive', 'persistentWrites', 'installers'];
  const label = (k, v) => {
    if (k === 'scripts' || k === 'binaries') return v.path;
    if (k === 'hooks') return `${v.event}`;
    if (k === 'toolGrants') return `${v.key}: ${v.tool}`;
    if (k === 'domains') return v;
    if (k === 'dynamicContext') return `${v.file}: ${v.command}`;
    return `${v.file}:${v.line}`;
  };
  const out = {};
  for (const k of keys) {
    const a = new Set((before?.[k] || []).map((v) => label(k, v)));
    const b = new Set((after?.[k] || []).map((v) => label(k, v)));
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) out[k] = { added: added.slice(0, 100), removed: removed.slice(0, 100) };
  }
  return { changed: Object.keys(out).length > 0, byKind: out };
}

/**
 * @param {object} o
 * @param {string} o.dataDir DATA_HOME/data/skills
 * @param {object} o.library lib/skills/library.js
 */
export function createReviewQueue({ dataDir, library, emit = () => {}, now = () => new Date().toISOString(), newId = () => `rvw_${randomBytes(10).toString('hex')}` }) {
  const storePath = join(dataDir, 'reviews.json');

  function read() {
    try {
      const parsed = JSON.parse(readConfinedFile(dataDir, storePath, { maxBytes: 32 * 1024 * 1024, encoding: 'utf-8' }));
      if (parsed?.schemaVersion === REVIEWS_SCHEMA && Array.isArray(parsed.records)) return parsed;
    } catch { /* none yet */ }
    return { schemaVersion: REVIEWS_SCHEMA, records: [] };
  }
  function write(store) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const records = store.records.length > MAX_REVIEWS ? store.records.slice(-MAX_REVIEWS) : store.records;
    replaceFileAtomic(storePath, `${JSON.stringify({ schemaVersion: REVIEWS_SCHEMA, records }, null, 2)}\n`, { mode: 0o600 });
  }
  function get(reviewId) {
    if (typeof reviewId !== 'string' || !REVIEW_RE.test(reviewId)) throw new ReviewError(400, 'Not a review id.', 'invalid_review');
    const rec = read().records.find((r) => r.reviewId === reviewId);
    if (!rec) throw new ReviewError(404, 'There is no such review.', 'review_not_found');
    return rec;
  }
  function update(reviewId, change) {
    const store = read();
    const rec = store.records.find((r) => r.reviewId === reviewId);
    if (!rec) throw new ReviewError(404, 'There is no such review.', 'review_not_found');
    change(rec);
    rec.updatedAt = now();
    write(store);
    emit({ type: 'review.changed', reviewId, skillId: rec.skillId, state: rec.state });
    return rec;
  }

  function list({ state = null, skillId = null, open = null } = {}) {
    return read().records.filter((r) => (!state || r.state === state) && (!skillId || r.skillId === skillId) && (open === null || OPEN.has(r.state) === open))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Submit a revision for review.
   * @param {object} o
   * @param {string} o.revisionId
   * @param {object[]} [o.targets] where it is meant to go ({ runtime, scope, accountId?, projectPath? })
   * @param {object} o.evidence { lint, scan, authority } of exactly that revision
   */
  function submit({ revisionId, targets = [], releaseNotes = '', assumptions = [], author, evidence = {}, previousReviewId = null }) {
    const revision = library.getRevision(revisionId);
    const skill = library.getSkill(revision.skillId);
    const store = read();
    const dup = store.records.find((r) => r.submittedRevisionId === revisionId && OPEN.has(r.state));
    if (dup) return { review: dup, existing: true };
    if (previousReviewId !== null) {
      const prev = store.records.find((r) => r.reviewId === previousReviewId);
      if (!prev || prev.skillId !== skill.skillId) throw new ReviewError(400, 'previousReviewId is not a review of this skill.', 'invalid_review');
    }
    const rec = {
      schemaVersion: REVIEWS_SCHEMA, reviewId: newId(), skillId: skill.skillId, skillName: skill.name,
      submittedRevisionId: revisionId, submittedDigest: revision.contentDigest, baseApprovedRevisionId: skill.pointers.approved || null,
      state: 'pending',
      targets: (Array.isArray(targets) ? targets : []).slice(0, 12).map((t) => ({ runtime: text(t?.runtime, 20), scope: text(t?.scope, 20) || 'user', accountId: text(t?.accountId, 64) || 'default', projectPath: text(t?.projectPath, 2000) || null })),
      evidence, releaseNotes: text(releaseNotes, 8000), assumptions: (Array.isArray(assumptions) ? assumptions : []).filter((a) => typeof a === 'string').slice(0, 50).map((a) => a.slice(0, 1000)),
      author: normalizeAuthor(author), reviewer: null, policyVersion: REVIEW_POLICY, decisionReason: null, exceptions: [],
      comments: [], publication: { jobId: null, targetResults: [] }, previousReviewId, createdAt: now(), updatedAt: now(),
    };
    if (!REVIEW_RE.test(rec.reviewId)) throw new ReviewError(500, 'Bad review id.', 'bad_id');
    store.records.push(rec);
    if (previousReviewId) { const prev = store.records.find((r) => r.reviewId === previousReviewId); if (prev) prev.supersededBy = rec.reviewId; }
    write(store);
    try { library.setPointer(skill.skillId, 'candidate', revisionId, { by: rec.author.kind, reason: `submitted for review (${rec.reviewId})` }); } catch { /* the pointer is a convenience: the review stands */ }
    emit({ type: 'review.changed', reviewId: rec.reviewId, skillId: rec.skillId, state: rec.state });
    return { review: rec, existing: false };
  }

  function comment(reviewId, { by, body }) {
    const t = text(body, 4000).trim();
    if (!t) throw new ReviewError(400, 'A comment has text.', 'invalid_comment');
    return update(reviewId, (rec) => {
      if (rec.comments.length >= MAX_COMMENTS) throw new ReviewError(413, 'This review has as many comments as it can hold.', 'too_many_comments');
      rec.comments.push({ at: now(), by: normalizeAuthor(by), body: t });
    });
  }

  /** The author takes a submission back (or the owner closes it). */
  function withdraw(reviewId, { by }) {
    return update(reviewId, (rec) => {
      if (!OPEN.has(rec.state)) throw new ReviewError(409, `A review that is ${rec.state} cannot be withdrawn.`, 'review_state');
      rec.state = 'withdrawn';
      rec.decisionReason = 'withdrawn';
      rec.reviewer = normalizeAuthor(by);
    });
  }

  /**
   * The owner's decision. `approve` binds the approval to the submitted digest (the revision must still read as
   * it was submitted, and its scan must not block) and moves the skill's `approved` pointer.
   * @param {'approve'|'reject'|'request_changes'} decision
   */
  /**
   * @param {object} o
   * @param {string|null} [o.installName] the name the revision installs under (deploy.js effectiveInstallName): an
   *   approval covers that name only, and an install under another name goes back to review
   */
  function decide(reviewId, { decision, reason = '', by, scan = null, installName = null }) {
    if (!['approve', 'reject', 'request_changes'].includes(decision)) throw new ReviewError(400, 'A decision is approve, reject or request_changes.', 'invalid_decision');
    const rec = get(reviewId);
    if (!OPEN.has(rec.state) || (decision === 'approve' && rec.state !== 'pending')) throw new ReviewError(409, `A review that is ${rec.state} cannot be ${decision === 'request_changes' ? 'sent back' : `${decision}d`}.`, 'review_state');
    if (decision === 'approve') {
      const revision = library.getRevision(rec.submittedRevisionId);
      if (revision.contentDigest !== rec.submittedDigest) throw new ReviewError(409, 'The revision does not read as it was submitted.', 'digest_mismatch');
      library.readRevisionFiles(rec.submittedRevisionId);   // every blob there and intact
      if (scan && scan.digest === rec.submittedDigest && (scan.gate === 'blocked' || scan.status === 'error')) {
        throw new ReviewError(409, 'The scan of these files blocks them: they cannot be approved.', 'scan_blocked');
      }
      library.setPointer(rec.skillId, 'approved', rec.submittedRevisionId, { by: 'owner', reason: `review ${reviewId} approved`, allowProtected: 'review' });
    }
    return update(reviewId, (r) => {
      r.state = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
      r.reviewer = normalizeAuthor(by);
      r.decisionReason = text(reason, 4000) || null;
      r.decidedAt = now();
      if (decision === 'approve') r.approvedInstallName = typeof installName === 'string' && installName ? installName : null;
    });
  }

  /** The approval a revision has: the newest approved review of it, with the name it was approved to install as. */
  function approvalOf(revisionId) {
    const approved = new Set(['approved', 'publishing', 'published', 'partial', 'publish_failed']);
    const found = read().records.filter((r) => r.submittedRevisionId === revisionId && approved.has(r.state))
      .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))[0];
    return found ? { reviewId: found.reviewId, installName: found.approvedInstallName || null } : null;
  }

  /** A publication of an approved review: its per-target outcomes, never one success for all. */
  function recordPublication(reviewId, { results, jobId = null }) {
    return update(reviewId, (rec) => {
      if (!['approved', 'publishing', 'published', 'partial', 'publish_failed'].includes(rec.state)) throw new ReviewError(409, 'Only an approved review is published.', 'review_state');
      const list = Array.isArray(results) ? results : [];
      rec.publication = { jobId, targetResults: [...(rec.publication?.targetResults || []), ...list.map((r) => ({ at: now(), targetKey: r.targetKey, status: r.status, installationId: r.installationId || null, error: r.error || null }))].slice(-200) };
      const committed = list.filter((r) => r.status === 'committed').length;
      rec.state = committed === list.length && list.length ? 'published' : committed ? 'partial' : 'publish_failed';
    });
  }

  return { list, get, submit, comment, withdraw, decide, approvalOf, recordPublication, paths: { storePath } };
}
