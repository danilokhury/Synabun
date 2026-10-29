// ── Installing library revisions into runtime folders ──
// An install puts one revision of a library skill (lib/skills/library.js) into one or more runtime folders as a
// native skill folder: Claude Code (<config dir>/skills or a project's .claude/skills), Codex ($CODEX_HOME/skills
// or a project's .agents/skills), OpenCode (<config>/opencode/skills or a project's .opencode/skills), and the
// shared ~/.agents/skills only when the owner turned it on. It is two steps:
//
//   plan(…)    what each target would receive (the export of the revision for that runtime, with its digest),
//              where, which runtimes see that folder (and what else of that name they already see), what is there
//              now (absent, SynaBun's, changed since, not SynaBun's), the checks (the target profile's lint, the
//              scan of exactly those bytes, the review of an Assistant's revision), what each target needs
//              confirmed, and how a running session picks the change up. The plan has a digest.
//   install(…) takes the plan's digest: the plan is worked out again and must be the same, or nothing happens
//              (409 plan_changed, with the new plan). Then each target on its own: the export is written into a
//              staging folder beside the runtime's folder (never inside it), checked against its digest, what is
//              at the destination is backed up and checked again, swapped out, the export swapped in, checked
//              again, and only then the old copy goes. A target that fails is put back as it was; the others are
//              not undone (there is no transaction across runtimes, and the answer never pretends there is).
//
// Every install is recorded (DATA_HOME/data/skills/installations.json, schema 2): the revision, the export and its
// digest, the destination and the runtimes it reaches, what it replaced (its backup), and its state: written
// (checked by digest), discoverable (the runtime's rules, read statically), eligible (enabled in the runtime's
// settings, when that can be read), discovered (only what a runtime itself answered), loaded (never claimed), and
// the refresh a running session needs. A rollback puts back exactly what the install replaced; an uninstall
// removes only what SynaBun installed and still holds those bytes (or what the owner confirmed as it is now).

import { effectiveInstallName, nameChecks } from './scan-context.js';
export { effectiveInstallName, nameChecks } from './scan-context.js';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PathConfineError, isInside, isPlainName, realPathOf } from '../path-confine.js';
import { makeConfinedDir, readConfinedFile, removeConfinedEntry, replaceFileAtomic, writeConfinedFile } from '../confined-fs.js';
import { readManifest } from './digest.js';
import { LibraryError, digestOf } from './library.js';
import { buildExport, readHeadOf, readSidecar } from './export.js';
import { scanArtifact, scanAllows, withExternalScans, scanEvidenceKey } from './scan.js';
import { bundleNameProblem } from './bundle.js';
import { PORTABLE_NAME_RE, TARGET_PROFILE, getProfile, lintForProfile } from '../../public/shared/skills/ss-profiles.js';
import { analyzeResources, argumentDiagnostics } from '../../public/shared/skills/ss-resources.js';
import { isEditableText } from '../../public/shared/skills/ss-doc.js';

export const INSTALL_TARGETS = Object.freeze(['claude', 'codex', 'opencode', 'agents']);
export const INSTALLATIONS_SCHEMA = 2;
const MAX_INSTALLATIONS = 2000;

export class DeployError extends PathConfineError {
  constructor(status, message, code, extra = {}) {
    super(status, message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// How a running session sees a change (checked 2026-10-23 in temporary homes: codex-cli 0.164.0's app-server lists
// a new or changed skill only when skills/list is asked with forceReload, which SynaBun's Codex panel does on every
// skills:changed; opencode 2.1.4's serve reads its skill folders again on every /api/skill, so SynaBun's OpenCode panel
// lists it at once. A Codex or OpenCode session open elsewhere, in a terminal, is not SynaBun's to refresh: it needs a
// new session. Claude Code watches the folders that existed when it started. A Claude Code skills folder is read by
// a terminal OpenCode only: SynaBun starts every OpenCode serve of its own, the panel's and an Assistant brain's, with
// OPENCODE_DISABLE_CLAUDE_CODE=1, so those never see it, `terminal-only`.)
const REFRESH = {
  claude: (rootExisted) => (rootExisted
    ? { kind: 'automatic', message: 'Claude Code picks up the change in sessions that are already open.' }
    : { kind: 'reload-skills', message: 'This skills folder did not exist before: run /reload-skills in Claude Code sessions that are already open (new sessions see it).' }),
  codex: () => ({ kind: 'panel-reload', message: 'SynaBun\'s Codex panel reloads its skills now; a Codex open in a terminal needs a new session.' }),
  opencode: (rootExisted, root) => (root?.family === 'claude'
    ? { kind: 'terminal-only', message: 'An OpenCode open in a terminal reads Claude Code\'s folder (new session); SynaBun\'s own OpenCode panel and an OpenCode Assistant do not: install for OpenCode for those.' }
    : { kind: 'panel-reload', message: 'SynaBun\'s OpenCode panel lists it now; an OpenCode open in a terminal needs a new session.' }),
};

const RUNTIME_LABEL = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', agents: 'the shared agents folder' };

/** A target as a request may name it, checked. */
export function normalizeTarget(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new DeployError(400, 'A target is { runtime, scope }.', 'invalid_target');
  const runtime = t.runtime;
  if (!INSTALL_TARGETS.includes(runtime)) throw new DeployError(400, `A target's runtime is one of ${INSTALL_TARGETS.join(', ')}.`, 'invalid_target');
  const scope = t.scope === undefined ? 'user' : t.scope;
  if (scope !== 'user' && scope !== 'project') throw new DeployError(400, 'A target\'s scope is user or project.', 'invalid_target');
  if (runtime === 'agents' && scope !== 'user') throw new DeployError(400, 'The shared agents folder is a user folder; a project\'s .agents/skills is the codex target with scope project.', 'invalid_target');
  const accountId = t.accountId === undefined || t.accountId === null || t.accountId === '' ? 'default' : t.accountId;
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw new DeployError(400, 'Not an account id.', 'invalid_target');
  if (scope === 'project' && (typeof t.projectPath !== 'string' || !t.projectPath)) throw new DeployError(400, 'A project target names its project (projectPath).', 'invalid_target');
  const projectPath = scope === 'project' ? resolve(t.projectPath) : null;
  const key = scope === 'project' ? `${runtime}:project:${projectPath}` : `${runtime}:user:${accountId}`;
  return { runtime, scope, accountId, projectPath, key };
}

/**
 * Write a folder into place by swapping it in: staged beside the runtime's folder, checked, then renamed over
 * what is there (which is checked again first and kept until the new folder is in place and checked).
 * @param {object} o
 * @param {string} o.root the runtime's skills folder (made when it is missing)
 * @param {string|null} o.anchor a project the root must really be inside
 * @param {string} o.name the folder's name in the root
 * @param {{ files, dirs }} o.folder
 * @param {string} o.digest what the folder must read back as
 * @param {string|null} o.expectedCurrentDigest what must be at the destination now (null: nothing)
 * @returns {{ destination: string, leftover: string|null, rootCreated: boolean }}
 */
export function swapFolderIn({ root, anchor = null, name, folder, digest, expectedCurrentDigest, random = () => randomBytes(8).toString('hex') }) {
  if (!isPlainName(name) || bundleNameProblem(name)) throw new DeployError(400, `"${name}" cannot be a skill folder's name.`, 'invalid_name');
  let rootCreated = false;
  try { lstatSync(root); } catch { rootCreated = true; }
  // The runtime's folder: made when missing, and it must be where it says (in its project, when it has one).
  const parent = dirname(root);
  if (anchor) {
    let realParent;
    try { realParent = realPathOf(parent); } catch { throw new DeployError(403, 'The runtime\'s folder leads somewhere that cannot be resolved.', 'root_unsafe'); }
    if (!isInside(realPathOf(anchor), realParent, { allowRoot: true })) throw new DeployError(403, 'The runtime\'s folder leads out of the project through a link.', 'root_unsafe');
  }
  mkdirSync(root, { recursive: true });
  const realRoot = realPathOf(root);
  if (anchor && !isInside(realPathOf(anchor), realRoot)) throw new DeployError(403, 'The runtime\'s folder leads out of the project through a link.', 'root_unsafe');
  const realParent = dirname(realRoot);
  const destination = join(realRoot, name);
  // Staging beside the folder (on the same disk when it can be), never inside it: a runtime that scans its folder
  // deep would otherwise see the staged copy for a moment.
  let stageHome = realParent;
  try { if (lstatSync(realParent).dev !== lstatSync(realRoot).dev) stageHome = realRoot; } catch { stageHome = realRoot; }
  const tag = random();
  const stage = join(stageHome, `.synabun-stage-${tag}`);
  const staged = join(stage, name);
  const old = join(stageHome, `.synabun-old-${tag}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    makeConfinedDir(stage, staged);
    for (const d of folder.dirs || []) makeConfinedDir(staged, join(staged, d));
    // A file's own mode when the folder carries one (a backup put back by a rollback: a private 0600 file stays
    // 0600); else 0755 / 0644 by its executable bit, as an install writes them.
    for (const f of folder.files) {
      const mode = Number.isInteger(f.mode) ? f.mode & 0o777 : (f.executable ? 0o755 : 0o644);
      writeConfinedFile(staged, join(staged, f.path), f.bytes, { exclusive: true, mode });
      if (Number.isInteger(f.mode)) chmodSync(join(staged, f.path), mode);
    }
    const written = readManifest(staged);
    if (written.digest !== digest) throw new DeployError(500, 'The staged files do not match what was meant to be written. Nothing was changed.', 'stage_mismatch');
    const now = readManifest(destination);
    const nowDigest = now.kind === 'absent' ? null : now.digest;
    if (now.kind !== 'absent' && !now.digest) throw new DeployError(409, `"${destination}" could not be read whole: nothing was replaced.`, 'destination_unreadable');
    if (nowDigest !== (expectedCurrentDigest ?? null)) throw new DeployError(409, `"${destination}" changed since the plan was made: nothing was replaced. Plan again.`, 'destination_changed', { currentDigest: nowDigest });
    let moved = false;
    if (now.kind !== 'absent') { renameSync(destination, old); moved = true; }
    try {
      renameSync(staged, destination);
    } catch (err) {
      if (moved) { try { renameSync(old, destination); } catch { /* the backup holds it */ } }
      throw new DeployError(500, `The new folder could not be put in place (${err?.code || err?.message}). What was there is back.`, 'swap_failed');
    }
    const check = readManifest(destination);
    if (check.digest !== digest) {
      try { rmSync(destination, { recursive: true, force: true }); } catch {}
      if (moved) { try { renameSync(old, destination); } catch {} }
      throw new DeployError(500, 'The installed folder does not read back as it was written. What was there is back.', 'verify_failed');
    }
    // The folders' own modes last (deepest first, the folder itself at the end), once the folder reads back.
    const dirModes = Object.entries(folder.dirModes || {}).sort((a, b) => (b[0] === '.' ? -1 : b[0].split('/').length) - (a[0] === '.' ? -1 : a[0].split('/').length));
    for (const [rel, mode] of dirModes) { try { chmodSync(rel === '.' ? destination : join(destination, rel), mode & 0o777); } catch { /* keeps the mode it was made with */ } }
    let leftover = null;
    if (moved) { try { rmSync(old, { recursive: true, force: true }); } catch { leftover = old; } }
    return { destination, leftover, rootCreated };
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

/**
 * @param {object} o
 * @param {object} o.library lib/skills/library.js
 * @param {object} o.roots lib/skills/roots.js resolver
 * @param {object} o.ownership lib/skills/ownership.js installer (ledger, backups)
 * @param {string} o.dataDir DATA_HOME/data/skills
 * @param {() => object} [o.config] { sharedAgentsRoot }
 * @param {(id: string) => Promise<object|null>} [o.catalogEntries] every catalog entry (for what else a runtime sees)
 * @param {(o) => Promise<object|null>} [o.probe] ask a runtime itself whether it lists the skill
 * @param {(o) => string} [o.eligibility] 'enabled' | 'disabled' | 'unknown' from the runtime's settings
 * @param {(o) => { state: string, reason: object|null }} [o.eligibilityDetail] the same, with the setting that turns it off
 * @param {(event) => void} [o.emit]
 * @param {() => string[]} [o.shippedNames] the names of the skills SynaBun ships (what a scan checks names against)
 * @param {(revisionId: string) => ({ installName: string|null }|null)} [o.approvalOf] the approval a revision has
 *   (lib/skills/reviews.js approvalOf): an agent's revision installs only under the name it was approved for
 */
export function createDeployer({ library, roots, ownership, dataDir, config = () => ({}), catalogEntries = async () => [], probe = null, eligibility = () => 'unknown', eligibilityDetail = null, emit = () => {}, now = () => new Date().toISOString(), newId = (p) => `${p}_${randomBytes(10).toString('hex')}`, shippedNames = () => [], approvalOf = null }) {
  let externalScanner = async () => [];
  function setExternalScanner(scan) { externalScanner = scan; }
  const storePath = join(dataDir, 'installations.json');

  function readStore() {
    try {
      const parsed = JSON.parse(readConfinedFile(dataDir, storePath, { maxBytes: 32 * 1024 * 1024, encoding: 'utf-8' }));
      if (parsed?.schemaVersion === INSTALLATIONS_SCHEMA && Array.isArray(parsed.records)) return parsed;
    } catch { /* none yet */ }
    return { schemaVersion: INSTALLATIONS_SCHEMA, records: [] };
  }
  function writeStore(store) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const records = store.records.length > MAX_INSTALLATIONS ? [...store.records.filter((r) => r.active), ...store.records.filter((r) => !r.active).slice(-(MAX_INSTALLATIONS - store.records.filter((r) => r.active).length))] : store.records;
    replaceFileAtomic(storePath, `${JSON.stringify({ schemaVersion: INSTALLATIONS_SCHEMA, records }, null, 2)}\n`, { mode: 0o600 });
  }
  const sameDest = (a, b) => resolve(a) === resolve(b);

  function listInstallations({ skillId = null, active = null } = {}) {
    return readStore().records.filter((r) => (!skillId || r.skillId === skillId) && (active === null || r.active === active));
  }
  function getInstallation(id) {
    const rec = readStore().records.find((r) => r.installationId === id);
    if (!rec) throw new DeployError(404, 'There is no such installation.', 'installation_not_found');
    return rec;
  }
  function activeAt(destination) {
    return readStore().records.find((r) => r.active && sameDest(r.destination.path, destination)) || null;
  }

  const installName = effectiveInstallName;
  const shipped = () => { try { return shippedNames() || []; } catch { return []; } };

  /**
   * The checks of one target: the profile of each runtime that reads that folder. An error blocks only for a
   * runtime the folder is meant for (`primary`); a runtime that reads it only for compatibility (OpenCode in
   * ~/.claude/skills) turns its errors into warnings that name it.
   */
  function lintTarget(runtimes, folder, name, primary = runtimes) {
    const { parsed } = readHeadOf(folder.files);
    const sidecar = readSidecar(folder.files);
    const diagnostics = [];
    const profiles = [];
    for (const runtime of runtimes) {
      const profileId = TARGET_PROFILE[runtime];
      if (!profileId || profiles.includes(profileId)) continue;
      profiles.push(profileId);
      const secondary = !primary.includes(runtime);
      const own = [
        ...lintForProfile(profileId, { parsed, folderName: name, files: folder.files.map((f) => ({ path: f.path, size: f.bytes.length })), sidecar }).all,
        ...argumentDiagnostics(getProfile(profileId).runtime, { body: parsed.body, bodyLine: parsed.bodyLine, declared: [] }).map((d) => ({ ...d, profile: profileId })),
      ];
      diagnostics.push(...own.map((d) => (secondary && d.severity === 'error' ? { ...d, severity: 'warning', message: `${RUNTIME_LABEL[runtime]}, which also reads this folder: ${d.message}` } : d)));
    }
    const textFiles = folder.files.map((f) => ({ path: f.path, size: f.bytes.length, text: isEditableText(f.bytes) ? f.bytes.toString('utf-8') : null }));
    diagnostics.push(...analyzeResources({ files: textFiles, dirs: folder.dirs }).diagnostics);
    // One problem said once, even when two profiles see it.
    const seen = new Set();
    const unique = diagnostics.filter((d) => { const k = `${d.ruleId}\0${d.file}\0${d.line}\0${d.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { profiles, diagnostics: unique, errors: unique.filter((d) => d.severity === 'error').length, warnings: unique.filter((d) => d.severity === 'warning').length };
  }

  /**
   * What installing a revision into these targets would do.
   * @param {{ revisionId: string, targets: object[], reviewId?: string }} o
   */
  async function plan({ revisionId, targets }) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 12) throw new DeployError(400, 'Name 1 to 12 targets.', 'invalid_target');
    const revision = library.getRevision(revisionId);
    const skill = library.getSkill(revision.skillId);
    const source = library.readRevisionFiles(revisionId);
    const name = installName(skill, source.files);
    const wanted = targets.map(normalizeTarget);
    if (new Set(wanted.map((t) => t.key)).size !== wanted.length) throw new DeployError(400, 'A target is named twice.', 'invalid_target');
    let entries = [];
    try { entries = await catalogEntries(); } catch { entries = []; }
    const agentMade = revision.author?.kind === 'assistant' || revision.author?.kind === 'agent';
    const reviewNeeded = agentMade && skill.pointers.approved !== revisionId;
    // An approval covers the name it was given under: one without a name (from before this check) or under another
    // name is stale, and the revision goes back to review.
    let approvalStale = null;
    if (agentMade && !reviewNeeded && typeof approvalOf === 'function') {
      let approval = null;
      try { approval = approvalOf(revisionId); } catch { approval = null; }
      if (!approval || approval.installName !== name) {
        approvalStale = approval?.installName
          ? `It was approved to install as "${approval.installName}"; it would install as "${name}": review it again.`
          : `Its approval does not say which name it covers (it installs as "${name}"): review it again.`;
      }
    }
    const names = nameChecks(skill, name, shipped());
    const out = [];
    for (const target of wanted) {
      const blocked = [];
      const needs = [];
      const root = roots.installRoot(target);
      if (!root) {
        out.push({ targetKey: target.key, ...target, name, blocked: [{ code: 'no_root', message: target.scope === 'project' ? 'That project is not registered in SynaBun.' : `There is no ${RUNTIME_LABEL[target.runtime]} folder for that account.` }], needs, ready: false });
        continue;
      }
      if (root.policy?.write === 'owner-opt-in') blocked.push({ code: 'shared_root_off', message: 'Installing into ~/.agents/skills is off: turn on the shared agents folder in Settings → Skills first.' });
      else if (root.policy?.write !== 'owner') blocked.push({ code: 'root_read_only', message: root.policy?.reason || 'SynaBun does not write into this folder.' });
      if (root.status !== 'ok' && root.status !== 'absent') blocked.push({ code: 'root_unusable', message: `The folder is ${root.status === 'not-a-folder' ? 'not a folder' : 'unreadable'}: ${root.path}` });
      const runtimes = root.runtimes.length ? root.runtimes : [target.runtime];
      const profileId = target.runtime === 'agents' ? 'portable-six-field' : TARGET_PROFILE[target.runtime];
      // One export per folder: for a folder several runtimes read, the strictest invocation each needs is applied.
      let exported = { files: source.files, dirs: source.dirs, digest: source.revision.contentDigest, transforms: [], diagnostics: [] };
      for (const runtime of runtimes) {
        const next = buildExport({ files: exported.files, dirs: exported.dirs }, TARGET_PROFILE[runtime]);
        exported = { ...next, transforms: [...exported.transforms, ...next.transforms], diagnostics: [...exported.diagnostics, ...next.diagnostics] };
      }
      // Who the folder is for: the target's runtime, or every runtime of the shared folder.
      const primary = target.runtime === 'agents' ? runtimes : [target.runtime];
      const lint = lintTarget(runtimes, exported, name, primary);
      const exportDiagnostics = exported.diagnostics;
      if (lint.errors || exportDiagnostics.some((d) => d.severity === 'error')) blocked.push({ code: 'lint_errors', message: `${lint.errors + exportDiagnostics.filter((d) => d.severity === 'error').length} problem(s) keep it from working in ${runtimes.map((r) => RUNTIME_LABEL[r]).join(' and ')}.` });
      const { parsed } = readHeadOf(exported.files);
      const scan = withExternalScans(scanArtifact({ type: 'skill', name, files: exported.files, frontmatter: parsed.data, digest: exported.digest, knownNames: names.knownNames, reservedNames: names.reservedNames }), await externalScanner({ ...revision, contentDigest: exported.digest }, exported));
      // What SynaBun ships was reviewed with the app it ships in: its findings are shown, not asked about again.
      // Everything else (an import, a folder of the user's, an agent's revision) needs the findings confirmed.
      const trustedBundled = revision.source?.kind === 'bundled' && !scan.external?.length && !['error', 'incomplete'].includes(scan.status);
      if (scan.gate === 'blocked') blocked.push({ code: 'scan_blocked', message: scan.status === 'error' ? `The scan failed (${scan.error}): nothing is installed without one.` : 'The scan found something that blocks this install.' });
      else if (scan.gate === 'review' && !trustedBundled) needs.push({ code: 'acknowledge_scan', digest: exported.digest, message: 'Review the scan\'s findings and confirm them for these exact files.' });
      if (reviewNeeded) blocked.push({ code: 'review_required', message: 'The Assistant made this revision: approve it in the Review queue before it is installed.' });
      else if (approvalStale) blocked.push({ code: 'approval_stale', message: approvalStale });
      const destination = join(root.path, name);
      const inspected = ownership.inspect({ destination, payload: { kind: 'dir', digest: exported.digest } });
      const state = inspected.state;
      const currentDigest = inspected.current.kind === 'absent' ? null : inspected.current.digest;
      if (state === 'unreadable') blocked.push({ code: 'destination_unreadable', message: `"${destination}" cannot be read whole: move it away yourself first.` });
      if (state === 'modified' || state === 'unowned') needs.push({ code: 'confirm_replace', currentDigest, message: `"${destination}" ${state === 'modified' ? 'was installed by SynaBun but has been changed since' : 'was not installed by SynaBun'}. Replace it? A backup is kept.` });
      // What else these runtimes see under this name, elsewhere.
      const overlap = entries.filter((e) => e.kind === 'skill' && (e.invocationName === name || e.name === name) && e.rootId !== root.rootId && e.runtimes.some((r) => runtimes.includes(r)))
        .map((e) => {
          // The page words it from `code`, `name`, `runtimes` and `path` (skillsStudio.publish.overlapOne / overlapMany);
          // `why` is the English for a caller without the page's strings (the MCP tool, a log).
          const seen = e.runtimes.filter((r) => runtimes.includes(r));
          return { id: e.id, code: 'overlap', name, path: e.path, scope: e.scope, runtimes: seen, why: `${seen.map((r) => RUNTIME_LABEL[r]).join(' and ')} also ${seen.length > 1 ? 'see' : 'sees'} a "${name}" skill at ${e.path}.` };
        });
      const refresh = runtimes.map((r) => ({ runtime: r, ...(REFRESH[r] ? REFRESH[r](root.status === 'ok', root) : { kind: 'unknown', message: '' }) }));
      // Whether each runtime's own settings let a skill of this name, at this place, through (read statically; the
      // page offers the one-click fix for a runtime that turns it off). Not part of the plan's digest: it changes
      // nothing of what is written.
      const eligible = {};
      for (const r of runtimes) {
        try {
          const d = typeof eligibilityDetail === 'function' ? eligibilityDetail({ runtime: r, name, skillMd: join(destination, 'SKILL.md'), accountId: target.accountId, projectPath: target.projectPath }) : { state: eligibility({ runtime: r, name, skillMd: join(destination, 'SKILL.md'), accountId: target.accountId, projectPath: target.projectPath }) || 'unknown', reason: null };
          eligible[r] = { state: ['enabled', 'disabled', 'unknown'].includes(d?.state) ? d.state : 'unknown', reason: d?.reason || null };
        } catch { eligible[r] = { state: 'unknown', reason: null }; }
      }
      out.push({
        targetKey: target.key, ...target, name,
        root: { rootId: root.rootId, path: root.path, status: root.status, scope: root.scope, sourceKind: root.sourceKind, policy: root.policy },
        destination, affectedRuntimes: runtimes, overlap,
        export: { profileId, profileVersion: getProfile(profileId)?.version || null, artifactDigest: exported.digest, sourceDigest: revision.contentDigest, transforms: exported.transforms },
        lint: { profiles: lint.profiles, errors: lint.errors, warnings: lint.warnings, diagnostics: [...exportDiagnostics, ...lint.diagnostics].slice(0, 300) },
        scan: { status: scan.status, gate: scan.gate, digest: scan.digest, engineVersion: scan.engineVersion, policy: scan.policy, evidenceKey: scanEvidenceKey(scan), external: scan.external || [], counts: scan.counts, findings: scan.findings.slice(0, 50), coverage: scan.coverage, disclosure: scan.disclosure, trustedBundled },
        destinationState: { state, currentDigest, installedBySynabun: !!inspected.record, activeInstallationId: activeAt(destination)?.installationId || null },
        refresh, eligibility: eligible, blocked, needs, ready: !blocked.length && !needs.length,
      });
    }
    const subject = { revisionId, contentDigest: revision.contentDigest, targets: out.map((t) => [t.targetKey, t.destination || null, t.export?.artifactDigest || null, t.destinationState?.currentDigest ?? null, t.destinationState?.state || null, t.blocked.map((b) => b.code), t.scan?.evidenceKey || null, t.needs.map((n) => [n.code, n.digest || null])]) };
    return {
      skillId: skill.skillId, skillName: skill.name, revisionId, contentDigest: revision.contentDigest, author: revision.author, name,
      targets: out, planDigest: digestOf(subject), createdAt: now(),
    };
  }

  /**
   * Install a planned revision. `decisions[targetKey]`: `{ expectedDestinationDigest, acknowledgedDigest }` (the
   * person confirmed replacing exactly what is there, and the scan's findings for exactly these bytes).
   */
  async function install({ revisionId, targets, planDigest, decisions = {}, principal = { kind: 'owner' }, reviewId = null, migration = null }) {
    const fresh = await plan({ revisionId, targets });
    if (typeof planDigest !== 'string' || planDigest !== fresh.planDigest) {
      throw new DeployError(409, 'What would be installed changed since the plan was shown. Nothing was installed; look at the new plan.', 'plan_changed', { plan: fresh });
    }
    const results = [];
    for (const t of fresh.targets) {
      const decision = decisions && typeof decisions === 'object' ? (decisions[t.targetKey] || {}) : {};
      if (t.blocked.length) { results.push({ targetKey: t.targetKey, status: 'skipped', reasons: t.blocked }); continue; }
      const missing = t.needs.filter((n) => (n.code === 'confirm_replace' && decision.expectedDestinationDigest !== n.currentDigest)
        || (n.code === 'acknowledge_scan' && decision.acknowledgedDigest !== n.digest));
      if (missing.length) { results.push({ targetKey: t.targetKey, status: 'needs-confirmation', reasons: missing }); continue; }
      const scanOk = scanAllows({ digest: t.scan.digest, status: t.scan.status, gate: t.scan.gate }, { digest: t.export.artifactDigest, acknowledgedDigest: t.scan.trustedBundled ? t.export.artifactDigest : (decision.acknowledgedDigest || null) });
      if (!scanOk.ok) { results.push({ targetKey: t.targetKey, status: 'skipped', reasons: [{ code: scanOk.code, message: scanOk.message }] }); continue; }
      try {
        const source = library.readRevisionFiles(revisionId);
        let exported = { files: source.files, dirs: source.dirs };
        for (const runtime of t.affectedRuntimes) exported = buildExport(exported, TARGET_PROFILE[runtime]);
        if (exported.digest !== t.export.artifactDigest) throw new DeployError(409, 'The export changed while it was being installed.', 'export_changed');
        let backupId = null;
        const previous = activeAt(t.destination);
        if (t.destinationState.state !== 'absent' && t.destinationState.state !== 'identical') {
          backupId = ownership.backup({ destination: t.destination, target: t.runtime, name: t.name, reason: `install of ${revisionId} over ${t.destinationState.state}` });
        }
        let swap = { destination: t.destination, leftover: null, rootCreated: false };
        if (t.destinationState.state !== 'identical') {
          swap = swapFolderIn({ root: t.root.path, anchor: t.scope === 'project' ? t.projectPath : null, name: t.name, folder: exported, digest: t.export.artifactDigest, expectedCurrentDigest: t.destinationState.currentDigest });
        }
        // What the ledger said of this place before: a rollback puts that claim back (or none, when there was none).
        const priorRecord = ownership.recordFor(t.destination);
        ownership.recordWrite({ target: t.runtime, name: t.name, destination: t.destination, digest: t.export.artifactDigest, kind: 'dir', source: { kind: 'library', skillId: fresh.skillId, revisionId, digest: fresh.contentDigest } });
        const installationId = newId('ins');
        const record = {
          schemaVersion: INSTALLATIONS_SCHEMA, installationId, skillId: fresh.skillId, sourceRevisionId: revisionId, sourceDigest: fresh.contentDigest,
          export: { profileId: t.export.profileId, profileVersion: t.export.profileVersion, artifactDigest: t.export.artifactDigest, manifestDigest: t.export.artifactDigest, transforms: t.export.transforms },
          target: { runtime: t.runtime, scope: t.scope, accountId: t.accountId, projectPath: t.projectPath },
          destination: { rootId: t.root.rootId, root: t.root.path, path: t.destination, relativePath: t.name, method: 'copy', affectedRuntimes: t.affectedRuntimes },
          ownership: {
            managedBy: 'synabun', adopted: false, replaced: t.destinationState.state, expectedDestinationDigest: t.destinationState.currentDigest,
            // 'identical': the bytes were there already and nothing was written; a rollback then changes no file.
            wrote: t.destinationState.state !== 'identical',
            priorRecord: priorRecord ? { target: priorRecord.target, name: priorRecord.name, kind: priorRecord.kind, digest: priorRecord.digest, source: priorRecord.source || null } : null,
          },
          previousInstallationId: previous?.installationId || null,
          backup: backupId ? { backupId, manifestDigest: t.destinationState.currentDigest } : null,
          migration, reviewId,
          scanAcknowledgement: (decision.acknowledgedDigest === t.scan.digest || t.scan.trustedBundled) ? { digest: t.scan.digest, evidenceKey: t.scan.evidenceKey, engineVersion: t.scan.engineVersion, policy: t.scan.policy, at: now() } : null,
          authorization: { principal: principal?.kind || 'owner', planDigest },
          transaction: { state: 'committed', at: now(), leftover: swap.leftover },
          state: { written: true, verifiedDigest: t.export.artifactDigest, discoverable: null, eligibility: 'unknown', discovered: null, loadedRevisionId: null, refresh: t.refresh, tested: false, checkedAt: now() },
          active: true, createdAt: now(),
        };
        const store = readStore();
        for (const r of store.records) if (r.active && sameDest(r.destination.path, t.destination)) { r.active = false; r.supersededBy = installationId; }
        store.records.push(record);
        writeStore(store);
        results.push({ targetKey: t.targetKey, status: 'committed', installationId, backupId, destination: t.destination, refresh: t.refresh, unchanged: t.destinationState.state === 'identical', leftover: swap.leftover });
        emit({ type: 'installation.changed', skillId: fresh.skillId, installationId, rootIds: [t.root.rootId], action: 'install' });
      } catch (err) {
        results.push({ targetKey: t.targetKey, status: 'failed', error: err?.message || String(err), code: err?.code || null });
      }
    }
    const committed = results.filter((r) => r.status === 'committed').length;
    return { ok: committed === results.length, partial: committed > 0 && committed < results.length, results, plan: fresh };
  }

  /**
   * Put back what an installation replaced (or remove it, when nothing was there). An installation that found its
   * exact bytes already there wrote nothing: its rollback changes no file, and gives the place back to whoever had
   * it before (the earlier installation, the ledger's earlier record, or nobody: the user's own folder).
   */
  function rollback(installationId, { expectedDestinationDigest = null, principal = { kind: 'owner' } } = {}) {
    const inst = getInstallation(installationId);
    if (!inst.active) throw new DeployError(409, 'This installation is no longer the one in place.', 'not_active');
    const destination = inst.destination.path;
    const current = readManifest(destination);
    const currentDigest = current.kind === 'absent' ? null : current.digest;
    if (current.kind !== 'absent' && !current.digest) throw new DeployError(409, `"${destination}" cannot be read whole: nothing was changed.`, 'destination_unreadable');
    if (currentDigest !== inst.export.artifactDigest && expectedDestinationDigest !== currentDigest) {
      throw new DeployError(409, `"${destination}" was changed since it was installed. To roll back anyway, confirm it as it is now: a backup is kept.`, 'rollback_conflict', { currentDigest });
    }
    let restoredTo = 'absent';
    const wroteNothing = inst.ownership?.wrote === false || inst.ownership?.replaced === 'identical';
    const safety = !wroteNothing && current.kind !== 'absent' ? ownership.backup({ destination, target: inst.target.runtime, name: inst.destination.relativePath, reason: `rollback of ${installationId}` }) : null;
    if (wroteNothing) {
      restoredTo = 'unchanged';
    } else if (inst.backup?.backupId) {
      const kept = ownership.readBackup(inst.backup.backupId);
      if (kept.kind === 'dir' && !kept.links.length) {
        swapFolderIn({ root: inst.destination.root, anchor: inst.target.scope === 'project' ? inst.target.projectPath : null, name: inst.destination.relativePath, folder: { files: kept.files, dirs: kept.dirs, dirModes: kept.dirModes }, digest: kept.meta.digest, expectedCurrentDigest: currentDigest });
      } else {
        if (current.kind !== 'absent') removeConfinedEntry(inst.destination.root, destination);
        ownership.restore(inst.backup.backupId, { root: inst.destination.root });
      }
      restoredTo = 'previous';
    } else if (current.kind !== 'absent') {
      removeConfinedEntry(inst.destination.root, destination);
    }
    const store = readStore();
    const rec = store.records.find((r) => r.installationId === installationId);
    rec.active = false;
    rec.rolledBackAt = now();
    rec.rollback = { by: principal?.kind || 'owner', safetyBackupId: safety, restoredTo };
    // What was there before is SynaBun's again only when it was an earlier SynaBun install of exactly those bytes.
    const prior = inst.previousInstallationId ? store.records.find((r) => r.installationId === inst.previousInstallationId) : null;
    const back = readManifest(destination);
    const priorRecord = inst.ownership?.priorRecord || null;
    if (prior && back.digest && back.digest === prior.export.artifactDigest) {
      prior.active = true;
      prior.supersededBy = null;
      ownership.recordWrite({ target: prior.target.runtime, name: prior.destination.relativePath, destination, digest: back.digest, kind: 'dir', source: { kind: 'library', skillId: prior.skillId, revisionId: prior.sourceRevisionId, digest: prior.sourceDigest } });
    } else if (priorRecord && back.digest && back.digest === priorRecord.digest) {
      // An install SynaBun made another way (the ledger's record, no installation of it): its claim is back.
      ownership.recordWrite({ target: priorRecord.target, name: priorRecord.name, destination, digest: priorRecord.digest, kind: priorRecord.kind || 'dir', source: priorRecord.source });
    } else {
      ownership.forget({ destination, target: inst.target.runtime, name: inst.destination.relativePath, reason: `rolled back ${installationId}` });
    }
    writeStore(store);
    emit({ type: 'installation.changed', skillId: inst.skillId, installationId, rootIds: [inst.destination.rootId], action: 'rollback' });
    return { ok: true, installationId, restoredTo, safetyBackupId: safety, reactivated: prior && back.digest === prior.export.artifactDigest ? prior.installationId : null };
  }

  /** Remove an installation's folder: SynaBun's own bytes, or what the owner confirmed as it is now. A backup is kept. */
  function uninstall(installationId, { expectedDestinationDigest = null, principal = { kind: 'owner' } } = {}) {
    const inst = getInstallation(installationId);
    if (!inst.active) throw new DeployError(409, 'This installation is no longer the one in place.', 'not_active');
    const destination = inst.destination.path;
    const current = readManifest(destination);
    const currentDigest = current.kind === 'absent' ? null : current.digest;
    let backupId = null;
    if (current.kind !== 'absent') {
      if (!current.digest) throw new DeployError(409, `"${destination}" cannot be read whole: nothing was removed.`, 'destination_unreadable');
      if (currentDigest !== inst.export.artifactDigest && expectedDestinationDigest !== currentDigest) {
        throw new DeployError(409, `"${destination}" was changed since it was installed. To remove it anyway, confirm it as it is now: a backup is kept.`, 'uninstall_conflict', { currentDigest });
      }
      backupId = ownership.backup({ destination, target: inst.target.runtime, name: inst.destination.relativePath, reason: `uninstall of ${installationId}` });
      const again = readManifest(destination);
      if (again.digest !== currentDigest) throw new DeployError(409, 'That folder changed while it was being removed. Nothing was removed.', 'destination_changed');
      removeConfinedEntry(inst.destination.root, destination);
    }
    ownership.forget({ destination, target: inst.target.runtime, name: inst.destination.relativePath, reason: `uninstalled ${installationId}` });
    const store = readStore();
    const rec = store.records.find((r) => r.installationId === installationId);
    rec.active = false;
    rec.removedAt = now();
    rec.removal = { by: principal?.kind || 'owner', backupId };
    writeStore(store);
    emit({ type: 'installation.changed', skillId: inst.skillId, installationId, rootIds: [inst.destination.rootId], action: 'uninstall' });
    return { ok: true, installationId, backupId, removed: current.kind !== 'absent' };
  }

  /**
   * Check an installation: the bytes (by digest), what the runtime's rules say of the folder, its settings
   * (eligibility), and — only when asked and a probe exists — whether the runtime itself lists it now.
   */
  async function verify(installationId, { probeRuntime = false } = {}) {
    const inst = getInstallation(installationId);
    const destination = inst.destination.path;
    const current = readManifest(destination);
    const written = current.kind === 'absent' ? 'missing' : (current.digest === inst.export.artifactDigest ? 'verified' : 'changed');
    const checks = [];
    let discoverable = written === 'verified';
    let live = null;
    if (written === 'verified') {
      // The folder must still be one the runtime reads: OPENCODE_CONFIG_DIR set after the install, or an account
      // folder that moved, leaves the skill where nothing looks.
      try { live = roots.listRoots().find((r) => resolve(r.path) === resolve(inst.destination.root)) || null; } catch { live = null; }
      for (const runtime of inst.destination.affectedRuntimes) {
        if (live && live.runtimes.includes(runtime)) continue;
        discoverable = false;
        checks.push({ runtime, ok: false, message: `${RUNTIME_LABEL[runtime] || runtime} does not read ${inst.destination.root} now${live?.policy?.reason ? `: ${live.policy.reason}` : '.'}` });
      }
      try {
        const head = readConfinedFile(destination, join(destination, 'SKILL.md'), { maxBytes: 2 * 1024 * 1024 });
        const files = [{ path: 'SKILL.md', bytes: head }];
        const { parsed } = readHeadOf(files);
        for (const runtime of inst.destination.affectedRuntimes) {
          const lint = lintForProfile(TARGET_PROFILE[runtime], { parsed, folderName: basename(destination) });
          if (lint.errors.length) { discoverable = false; checks.push({ runtime, ok: false, message: lint.errors[0].message }); }
          else if (live && live.runtimes.includes(runtime)) checks.push({ runtime, ok: true, message: `${RUNTIME_LABEL[runtime]}'s rules find it at ${destination}.` });
        }
      } catch (err) { discoverable = false; checks.push({ ok: false, message: `SKILL.md cannot be read (${err?.message || err}).` }); }
    }
    const eligibilityByRuntime = {};
    for (const runtime of inst.destination.affectedRuntimes) {
      try { eligibilityByRuntime[runtime] = eligibility({ runtime, name: inst.destination.relativePath, path: destination, skillMd: join(destination, 'SKILL.md'), accountId: inst.target.accountId, projectPath: inst.target.projectPath }) || 'unknown'; } catch { eligibilityByRuntime[runtime] = 'unknown'; }
    }
    const discovered = {};
    if (probeRuntime && typeof probe === 'function' && written === 'verified') {
      for (const runtime of inst.destination.affectedRuntimes) {
        // A Claude Code folder reaches a terminal OpenCode only: SynaBun's own serve (OPENCODE_DISABLE_CLAUDE_CODE=1)
        // would answer "not listed" for a folder it never reads, so it is not asked (REFRESH `terminal-only`).
        if (runtime === 'opencode' && live?.family === 'claude') { discovered[runtime] = { discovered: null, code: 'terminal-only', method: 'none', reason: 'SynaBun\'s OpenCode never reads Claude Code\'s folder; an OpenCode in a terminal does.' }; continue; }
        try { discovered[runtime] = await probe({ runtime, name: inst.destination.relativePath, skillMd: join(destination, 'SKILL.md'), accountId: inst.target.accountId, projectPath: inst.target.projectPath }); } catch (err) { discovered[runtime] = { discovered: null, code: 'no-answer', error: err?.message || String(err) }; }
      }
    }
    const store = readStore();
    const rec = store.records.find((r) => r.installationId === installationId);
    rec.state = {
      ...rec.state, written: written === 'verified', writtenCheck: written, verifiedDigest: current.digest || null, discoverable, checks,
      eligibility: Object.values(eligibilityByRuntime).includes('disabled') ? 'disabled' : (Object.values(eligibilityByRuntime).every((v) => v === 'enabled') ? 'enabled' : 'unknown'),
      eligibilityByRuntime, discovered: Object.keys(discovered).length ? discovered : rec.state.discovered, loadedRevisionId: null, checkedAt: now(),
    };
    writeStore(store);
    return rec;
  }

  return { setExternalScanner, plan, install, rollback, uninstall, verify, listInstallations, getInstallation, activeAt, paths: { storePath } };
}
