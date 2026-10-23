// ── The Skills Service ──
// One service for everything that reads, drafts, checks, reviews and installs skills: the Studio (HTTP v2,
// lib/skills/api-v2.js), the MCP `skill` tool (which calls HTTP v2), and the legacy install routes of server.js.
// It composes the pieces and adds no second copy of their rules:
//   roots      lib/skills/roots.js      every runtime folder, with its policy
//   catalog    lib/skills/catalog.js    what those folders hold (async, bounded, cached)
//   library    lib/skills/library.js    complete folders as immutable revisions, drafts, pointers
//   deployer   lib/skills/deploy.js     plans and per-target installs, rollback, verify
//   reviews    lib/skills/reviews.js    the Review queue
//   migration  lib/skills/migration.js  old bridges → native skill folders
// Every change it makes is announced (`emit`: skill.changed, revision.created, review.changed,
// installation.changed, migration.changed), which drops the catalog's cache and reaches the pages as
// `skills:changed` on the sync socket.

import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PathConfineError, isPlainName, realPathOf } from '../path-confine.js';
import { readConfinedFile, replaceFileAtomic } from '../confined-fs.js';
import { collectFolder } from './bundle.js';
import { folderDigest } from './library.js';
import { readHeadOf, readSidecar } from './export.js';
import { lintText, frontmatterData, asText } from './frontmatter.js';
import { scanArtifact } from './scan.js';
import { authorityDelta } from './reviews.js';
import { effectiveInstallName, nameChecks } from './deploy.js';
import { PROFILES, TARGET_PROFILE, lintForProfile, profileList, readInvocationIntent, getProfile } from '../../public/shared/skills/ss-profiles.js';
import { analyzeResources, argumentDiagnostics } from '../../public/shared/skills/ss-resources.js';
import { isEditableText } from '../../public/shared/skills/ss-doc.js';

export const SERVICE_VERSION = 'skills-service-p3-2026-10-23';
export const SERVICE_CAPABILITIES = Object.freeze([
  'roots', 'catalog', 'library', 'revisions', 'drafts', 'diff', 'profiles', 'lint-profiles', 'scan', 'reviews',
  'install-plan', 'install-native', 'rollback', 'verify', 'bridge-migration', 'shared-root-opt-in', 'events',
  // P2 (Studio 2.0): a catalog skill's files, a revision against an installed folder, exports, when a head file changed,
  // taking a skill out of the library (DELETE /skills/:id, the owner's).
  'catalog-file', 'compare-folder', 'export', 'catalog-updated', 'library-delete',
  // P3: drafting a skill with AI from sources (/creations, lib/skills/creation.js) and the skill-forge guide (/guide).
  'ai-create', 'skill-guide',
]);

export class ServiceError extends PathConfineError {
  constructor(status, message, code, extra = {}) {
    super(status, message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * @param {object} o
 * @param {string} o.dataDir DATA_HOME/data/skills
 * @param {object} o.roots @param {object} o.catalog @param {object} o.library @param {object} o.deployer
 * @param {object} o.reviews @param {object} o.migration @param {object} o.ownership
 * @param {string|null} [o.bundledDir] PACKAGE_ROOT/skills
 * @param {string} [o.appVersion]
 * @param {(event) => void} [o.broadcast]
 */
export function createSkillsService({ dataDir, roots, catalog, library, deployer, reviews, migration, ownership, bundledDir = null, appVersion = '', broadcast = () => {}, now = () => new Date().toISOString() }) {
  const configPath = join(dataDir, 'config.json');
  let bundledSyncedAt = 0;

  // ── Configuration ──

  function getConfig() {
    try {
      const parsed = JSON.parse(readConfinedFile(dataDir, configPath, { maxBytes: 64 * 1024, encoding: 'utf-8' }));
      return { sharedAgentsRoot: parsed?.sharedAgentsRoot === true };
    } catch { return { sharedAgentsRoot: false }; }
  }
  function setConfig(patch = {}) {
    const next = { ...getConfig() };
    if (patch.sharedAgentsRoot !== undefined) {
      if (typeof patch.sharedAgentsRoot !== 'boolean') throw new ServiceError(400, 'sharedAgentsRoot is true or false.', 'invalid_config');
      next.sharedAgentsRoot = patch.sharedAgentsRoot;
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    replaceFileAtomic(configPath, `${JSON.stringify({ schemaVersion: 1, ...next, updatedAt: now() }, null, 2)}\n`, { mode: 0o600 });
    announce({ type: 'skill.changed', reason: 'config' });
    return next;
  }

  function announce(event) {
    try { catalog.invalidate(); } catch {}
    try { broadcast({ ...event, at: now() }); } catch {}
  }

  // ── Bundled skills ──

  /** What PACKAGE_ROOT/skills holds now, each folder read without following a link. */
  function shippedSkills() {
    if (!bundledDir) return [];
    let names = [];
    try { names = readdirSync(bundledDir, { withFileTypes: true }).filter((d) => d.isDirectory() && isPlainName(d.name) && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch { return []; }
    const out = [];
    for (const name of names) {
      try {
        const real = realPathOf(join(bundledDir, name));
        const { files, dirs } = collectFolder(real);
        if (!files.some((f) => f.path === 'SKILL.md')) continue;
        out.push({ name, files, dirs });
      } catch { /* one that cannot be read is skipped */ }
    }
    return out;
  }

  /** Keep the library's copy of the bundled skills current (a new app version is a new `upstream` revision). */
  function syncBundled({ force = false } = {}) {
    if (!force && Date.now() - bundledSyncedAt < 60_000) return null;
    bundledSyncedAt = Date.now();
    const result = library.syncBundled(shippedSkills(), { appVersion });
    if (result.some((r) => r.changed)) announce({ type: 'revision.created', reason: 'bundled' });
    return result;
  }

  /** The revision of a bundled skill installs use: its upstream (what this app version ships). */
  function bundledRevision(name) {
    syncBundled();
    const skill = library.findSkill((s) => s.origin?.kind === 'bundled' && s.origin?.name === name);
    if (!skill || !skill.pointers.upstream) return null;
    return library.getRevision(skill.pointers.upstream);
  }

  // ── Checks ──

  /** Every check of a folder: the Studio's editing checks, each profile's, the references and the arguments. */
  function lintFolder({ files, dirs = [] }, { profiles = null, folderName = '' } = {}) {
    const { text, parsed } = readHeadOf(files);
    const head = files.find((f) => f.path === 'SKILL.md');
    const binaryHead = head ? !isEditableText(head.bytes) : false;
    const base = lintText({ type: 'skill', text, folderName, binary: binaryHead }).lint;
    const sidecar = readSidecar(files);
    const ids = Array.isArray(profiles) && profiles.length ? profiles.filter((p) => getProfile(p)) : ['portable-six-field', 'claude-code', 'codex-native', 'opencode-native'];
    const byProfile = {};
    for (const id of ids) {
      const lint = lintForProfile(id, { parsed, folderName, files: files.map((f) => ({ path: f.path, size: f.bytes.length })), sidecar });
      const args = argumentDiagnostics(getProfile(id).runtime, { body: parsed.body, bodyLine: parsed.bodyLine, declared: [] });
      byProfile[id] = { profile: lint.profile, errors: lint.errors.length + args.filter((d) => d.severity === 'error').length, warnings: lint.warnings.length + args.filter((d) => d.severity === 'warning').length, diagnostics: [...lint.all, ...args] };
    }
    const resources = analyzeResources({ files: files.map((f) => ({ path: f.path, size: f.bytes.length, text: isEditableText(f.bytes) ? f.bytes.toString('utf-8') : null })), dirs });
    return {
      studio: { profile: base.profile, errors: base.errors.length, warnings: base.warnings.length, diagnostics: base.all },
      profiles: byProfile, resources: { references: resources.references.slice(0, 500), orphans: resources.orphans.slice(0, 200), diagnostics: resources.diagnostics },
      invocation: readInvocationIntent({ data: parsed.data, sidecar }),
      sidecar: sidecar.present ? { present: true, error: sidecar.error } : { present: false },
    };
  }

  /**
   * The scan of a folder under the name it installs as. With `skill`, the shipped names it must not take are those
   * of every bundled skill but its own (deploy.js nameChecks); without, every bundled name.
   */
  function scanFolder({ files }, { name, digest, skill = null }) {
    const { parsed } = readHeadOf(files);
    const names = nameChecks(skill, name, bundledNames());
    return scanArtifact({ type: 'skill', name, files, frontmatter: parsed.data, digest, knownNames: names.knownNames, reservedNames: names.reservedNames });
  }

  /** The name a revision installs under, or null when it has none a folder can take (lint says why). */
  function installNameOf(skill, files) {
    try { return effectiveInstallName(skill, files); } catch { return null; }
  }

  function bundledNames() {
    if (!bundledDir) return [];
    try { return readdirSync(bundledDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  }

  // ── The library, through the service ──

  // The description a skill's SKILL.md gives, for the Library's list: a revision's never changes (cached by its id);
  // a skill with no revision yet is read from its draft.
  const descriptions = new Map();
  function headDescription(read) {
    try {
      const { bytes } = read();
      return isEditableText(bytes) ? asText(frontmatterData(bytes.toString('utf-8')).data.description).slice(0, 1024) : '';
    } catch { return ''; }
  }
  function revisionDescription(revision) {
    if (!revision) return '';
    if (!descriptions.has(revision.revisionId)) {
      if (descriptions.size > 2000) descriptions.clear();
      descriptions.set(revision.revisionId, headDescription(() => library.readRevisionFile(revision.revisionId, revision.entrypoint || 'SKILL.md')));
    }
    return descriptions.get(revision.revisionId);
  }
  function draftDescription(draftId) {
    if (!draftId) return '';
    return headDescription(() => {
      const head = library.readDraftFiles(draftId).files.find((f) => f.path === 'SKILL.md');
      if (!head) throw new Error('no SKILL.md');
      return { bytes: head.bytes };
    });
  }

  function skillSummary(skill) {
    const latest = skill.pointers.latest ? library.readRevision(skill.pointers.latest) : null;
    const installs = deployer.listInstallations({ skillId: skill.skillId, active: true });
    const upstream = skill.pointers.upstream;
    return {
      skillId: skill.skillId, name: skill.name, origin: skill.origin, createdAt: skill.createdAt, updatedAt: skill.updatedAt, etag: skill.etag,
      description: latest ? revisionDescription(latest) : draftDescription(skill.pointers.draft),
      pointers: skill.pointers, revisions: skill.revisions.length,
      latest: latest ? { revisionId: latest.revisionId, contentDigest: latest.contentDigest, createdAt: latest.createdAt, author: latest.author } : null,
      installations: installs.map((i) => ({ installationId: i.installationId, runtime: i.target.runtime, scope: i.target.scope, accountId: i.target.accountId, projectPath: i.target.projectPath, destination: i.destination.path, sourceRevisionId: i.sourceRevisionId, updateAvailable: !!upstream && i.sourceRevisionId !== upstream && skill.origin?.kind === 'bundled' })),
    };
  }

  function listSkills() { syncBundled(); return library.listSkills().map(skillSummary); }
  function getSkill(skillId) { const skill = library.getSkill(skillId); return { ...skillSummary(skill), log: skill.log.slice(-50) }; }

  function revisionView(revisionId) {
    const rev = library.getRevision(revisionId);
    // A skill taken out of the library leaves its versions readable (a closed review or an old installation names
    // them): with no record, no pointer names them.
    const skill = library.readSkill(rev.skillId);
    return { ...rev, labels: skill ? library.labelsOf(skill, revisionId) : [] };
  }

  /** Make a catalog entry (a skill folder in a runtime's folder) a library skill: its bytes, as they are now. */
  async function adopt({ artifactId, author }) {
    const entry = await catalog.find(artifactId);
    if (!entry) throw new ServiceError(404, 'There is no such entry in the catalog.', 'artifact_not_found');
    if (entry.kind !== 'skill') throw new ServiceError(400, 'Only a skill folder becomes a library skill.', 'not_a_skill');
    const { files, dirs, excluded } = collectFolder(entry.realPath);
    const existing = library.findSkill((s) => s.origin?.kind === 'adopted' && s.origin?.artifactId === artifactId);
    const source = { kind: 'adopted', path: entry.path, rootId: entry.rootId, artifactId, name: entry.folderName };
    const { parsed } = readHeadOf(files);
    const intent = readInvocationIntent({ data: parsed.data, sidecar: readSidecar(files) });
    if (existing) {
      const latest = existing.pointers.latest ? library.getRevision(existing.pointers.latest) : null;
      const revision = putRevisionIfChanged(existing.skillId, { files, dirs, parentRevisionId: latest?.revisionId || null, source, author, invocationIntent: intent });
      return { skill: skillSummary(library.getSkill(existing.skillId)), revision: revision.revision, created: false, unchanged: revision.unchanged, excluded };
    }
    const created = library.createSkill({ name: entry.folderName, files, dirs, source, author, origin: { kind: 'adopted', artifactId, rootId: entry.rootId, path: entry.path }, invocationIntent: intent, note: 'Adopted from a runtime folder.' });
    announce({ type: 'revision.created', skillId: created.skill.skillId, revisionId: created.revision.revisionId });
    return { skill: skillSummary(created.skill), revision: created.revision, created: true, excluded };
  }

  /**
   * Take a skill out of the library (the owner's Delete in Skills Studio). Refused for a skill SynaBun ships (403
   * `skill_bundled`: the next sync would bring it back; Customize a copy makes one of the owner's) and for one that is
   * installed somewhere (409 `skill_installed`, naming the installations: they are removed first, from Publish, each
   * with its backup). `expectedEtag` is the record the owner read (409 `skill_conflict` when it changed since). Its
   * record and draft move to the library's archive (library.js archiveSkill); its open reviews are withdrawn, by the
   * owner, since nothing is left to approve or install. No folder a runtime reads is touched.
   */
  function removeSkill(skillId, { expectedEtag = null, by = { kind: 'owner' } } = {}) {
    const skill = library.getSkill(skillId);
    if (skill.origin?.kind === 'bundled') throw new ServiceError(403, 'A skill SynaBun ships stays in the library: customize a copy to have one of your own.', 'skill_bundled');
    const installs = deployer.listInstallations({ skillId, active: true });
    if (installs.length) {
      throw new ServiceError(409, `It is installed in ${installs.length === 1 ? '1 place' : `${installs.length} places`}: remove ${installs.length === 1 ? 'that installation' : 'those installations'} first.`, 'skill_installed', {
        installations: installs.map((i) => ({ installationId: i.installationId, runtime: i.target.runtime, scope: i.target.scope, accountId: i.target.accountId, projectPath: i.target.projectPath || null, destination: i.destination.path })),
      });
    }
    const out = library.archiveSkill(skillId, { expectedEtag, by: by?.kind || 'owner', reason: 'deleted from the library' });
    const withdrawn = [];
    for (const review of reviews.list({ skillId, open: true })) {
      try { reviews.withdraw(review.reviewId, { by }); withdrawn.push(review.reviewId); } catch { /* one that cannot be closed stays as it is */ }
    }
    announce({ type: 'skill.changed', skillId, action: 'deleted' });
    return { ...out, withdrawnReviews: withdrawn };
  }

  function putRevisionIfChanged(skillId, opts) {
    const skill = library.getSkill(skillId);
    if (skill.pointers.latest) {
      const latest = library.getRevision(skill.pointers.latest);
      const { files, dirs } = opts;
      const digest = folderDigest({ files, dirs });
      if (latest.contentDigest === digest) return { revision: latest, unchanged: true };
    }
    const revision = library.putRevision(skillId, opts);
    announce({ type: 'revision.created', skillId, revisionId: revision.revisionId });
    return { revision, unchanged: false };
  }

  // ── Reviews ──

  function submitReview({ revisionId, targets = [], releaseNotes = '', assumptions = [], author, previousReviewId = null }) {
    const { files, dirs, revision } = library.readRevisionFiles(revisionId);
    const skill = library.getSkill(revision.skillId);
    const profiles = [...new Set((targets || []).map((t) => (t?.runtime === 'agents' ? 'portable-six-field' : TARGET_PROFILE[t?.runtime])).filter(Boolean))];
    // Checked under the name it installs as (its SKILL.md's), not the library's: that is the folder it would take.
    const installName = installNameOf(skill, files);
    const lint = lintFolder({ files, dirs }, { profiles: profiles.length ? profiles : null, folderName: installName || skill.name });
    const scan = scanFolder({ files }, { name: installName || skill.name, digest: revision.contentDigest, skill });
    let delta = null;
    if (skill.pointers.approved && skill.pointers.approved !== revisionId) {
      const base = library.readRevisionFiles(skill.pointers.approved);
      const baseScan = scanFolder({ files: base.files }, { name: installNameOf(skill, base.files) || skill.name, digest: base.revision.contentDigest, skill });
      delta = authorityDelta(baseScan.authority, scan.authority);
    } else delta = authorityDelta({}, scan.authority);
    const diff = skill.pointers.approved && skill.pointers.approved !== revisionId ? library.diffRevisions(skill.pointers.approved, revisionId) : null;
    const evidence = {
      lint: { studioErrors: lint.studio.errors, profiles: Object.fromEntries(Object.entries(lint.profiles).map(([id, p]) => [id, { errors: p.errors, warnings: p.warnings }])), resourceProblems: lint.resources.diagnostics.length },
      scan: { status: scan.status, gate: scan.gate, digest: scan.digest, counts: scan.counts, engine: scan.engine, engineVersion: scan.engineVersion, policy: scan.policy,
        findings: scan.findings.slice(0, 10).map(({ ruleId, severity, message, file, line }) => ({ ruleId, severity, message, file: file || null, line: line || null })) },
      installName,
      authority: delta,
      diff: diff ? { from: diff.from, to: diff.to, files: diff.files.map((f) => ({ path: f.path, status: f.status })) } : null,
      invocation: lint.invocation,
    };
    const res = reviews.submit({ revisionId, targets, releaseNotes, assumptions, author, evidence, previousReviewId });
    return { ...res, scan, lint };
  }

  function decideReview(reviewId, { decision, reason, by }) {
    const rec = reviews.get(reviewId);
    let scan = null;
    let installName = null;
    if (decision === 'approve') {
      const { files, revision } = library.readRevisionFiles(rec.submittedRevisionId);
      const skill = library.getSkill(revision.skillId);
      installName = installNameOf(skill, files);
      scan = scanFolder({ files }, { name: installName || skill.name, digest: revision.contentDigest, skill });
    }
    return reviews.decide(reviewId, { decision, reason, by, scan, installName });
  }

  // ── Installs ──

  async function installPlan({ revisionId, targets }) {
    return deployer.plan({ revisionId, targets });
  }

  async function install({ revisionId, targets, planDigest, decisions, principal, reviewId = null }) {
    if (reviewId) {
      const rec = reviews.get(reviewId);
      if (rec.submittedRevisionId !== revisionId) throw new ServiceError(400, 'That review is of another revision.', 'review_mismatch');
      if (!['approved', 'publishing', 'published', 'partial', 'publish_failed'].includes(rec.state)) throw new ServiceError(409, 'Only an approved review is installed.', 'review_state');
    }
    const result = await deployer.install({ revisionId, targets, planDigest, decisions, principal, reviewId });
    if (reviewId) { try { reviews.recordPublication(reviewId, { results: result.results }); } catch {} }
    announce({ type: 'installation.changed', revisionId, results: result.results.map((r) => ({ targetKey: r.targetKey, status: r.status })) });
    return result;
  }

  // ── Status ──

  async function status() {
    const installs = deployer.listInstallations({ active: true });
    const pending = reviews.list({ open: true });
    let bridges = [];
    try { bridges = migration.findBridges(); } catch { bridges = []; }
    const updates = [];
    for (const i of installs) {
      const skill = library.readSkill(i.skillId);
      if (skill?.origin?.kind === 'bundled' && skill.pointers.upstream && skill.pointers.upstream !== i.sourceRevisionId) updates.push({ installationId: i.installationId, skillId: i.skillId, name: skill.name, from: i.sourceRevisionId, to: skill.pointers.upstream });
    }
    return {
      version: SERVICE_VERSION, capabilities: SERVICE_CAPABILITIES, config: getConfig(),
      installations: installs.length, reviewsOpen: pending.length,
      bridges: { total: bridges.length, synabun: bridges.filter((b) => b.proof !== 'none').length, other: bridges.filter((b) => b.proof === 'none').length },
      updatesAvailable: updates, library: library.stats(),
    };
  }

  /** The legacy chips' view of one bundled skill: what each runtime has of it (native folder, old bridge, neither). */
  function legacyTargetStates(name) {
    const out = {};
    for (const runtime of ['claude', 'codex', 'opencode']) {
      const root = roots.installRoot({ runtime, scope: 'user', accountId: 'default' });
      const native = root ? deployer.activeAt(join(root.path, name)) : null;
      let nativeState = 'absent';
      if (root) {
        const inspected = ownership.inspect({ destination: join(root.path, name) });
        nativeState = inspected.state === 'absent' ? 'absent' : (native && inspected.current.digest === native.export.artifactDigest ? 'native' : (inspected.state === 'owned' ? 'native' : (inspected.state === 'modified' ? 'modified' : 'other')));
      }
      out[runtime] = { native: nativeState, installationId: native?.installationId || null, destination: root ? join(root.path, name) : null };
    }
    return out;
  }

  return {
    version: SERVICE_VERSION, capabilities: SERVICE_CAPABILITIES,
    getConfig, setConfig, announce,
    roots: () => roots.listRoots(), installRoot: (t) => roots.installRoot(t),
    catalogPage: (q) => catalog.page(q), catalogDetail: (id) => catalog.detail(id), catalogFind: (id) => catalog.find(id), catalogScan: (o) => catalog.scan(o),
    profiles: () => profileList(), profileIds: () => Object.keys(PROFILES),
    syncBundled, bundledRevision, shippedSkills,
    listSkills, getSkill, revisionView, adopt, removeSkill, lintFolder, scanFolder,
    library, deployer, reviews, migration,
    submitReview, decideReview, installPlan, install, status, legacyTargetStates,
  };
}

