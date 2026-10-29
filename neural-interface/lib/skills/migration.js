// ── From the old prompt and command bridges to native skill folders ──
// SynaBun used to give Codex a custom prompt (~/.codex/prompts/<name>.md, a pointer back to the bundled skill)
// and OpenCode a command (~/.config/opencode/command/<name>.md, the skill's text with a banner). Both runtimes now
// read real skill folders (verified with codex-cli 0.163.0 and opencode 2.0.32), so a bridge moves to a native
// install of the same skill (owner decision, 2026-10-22). The move is:
//
//   - owned first: a bridge moves by itself only when the install ledger recorded exactly these bytes, they are
//     exactly what SynaBun writes for that bundled skill today, or exactly what an earlier SynaBun version wrote for
//     that runtime and skill from this install's folder (`ledger`, `generated-current`, `generated-previous`: the
//     shipped list of earlier generations, lib/skills/known-bridges.js). One that only carries the bridge's own
//     signature banner (`generated-signature`: SynaBun's wording, but edited since, or bytes no list knows) is offered
//     like any unproven file of a shipped skill, and moves only when the owner confirms its exact bytes (`confirm`).
//     A file without any of that is not SynaBun's: it is listed and left alone.
//   - native before anything is removed: the skill is installed into the runtime's skills folder through
//     lib/skills/deploy.js (plan, digest, backup of anything there) and checked by digest;
//   - backup-first: the bridge's exact bytes are copied into the migration's journal folder and read back before
//     the bridge is taken out of the runtime's folder (removed only while it still is those bytes);
//   - journaled: DATA_HOME/data/skills/migrations/<journalId>/journal.json lists every step and its outcome, and
//     the install ledger's journal gets a line per bridge;
//   - idempotent: a bridge already moved is gone from the plan; running the plan again changes nothing;
//   - reversible: revert(journalId) puts every bridge back where it was (only into a free place) and rolls back
//     each native install the migration made (only while it still holds what was installed).
//
// When it runs (owner decision 2026-10-22: switch to native folders with backups, and 2026-10-23: by itself): once at
// every server start, `autoMigrate()` moves the bridges that are proven SynaBun's (and only those), journaled and
// reversible as above, and leaves a one-time notice (`notice()`) the Studio shows with Undo. A bridge that is not
// proven SynaBun's is never moved by itself: the plan lists it with `offer` when SynaBun ships a skill of its name,
// and the owner may move it from the Studio or Settings by confirming its exact bytes (`confirm[bridgeId] =
// digest`). Undoing an automatic move pauses the automatic run (`autoPaused`) until the owner moves by hand again,
// so a move the owner took back never comes back by itself. The routes are the owner's, from the app's own page
// (POST /api/skills-studio/v2/migrations/bridges with the plan's digest); the server runs only `autoMigrate`.

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { PathConfineError } from '../path-confine.js';
import { readConfinedFile, replaceFileAtomic, writeConfinedFile } from '../confined-fs.js';
import { fileEntry, manifestDigest, sha256 } from './digest.js';
import { digestOf } from './library.js';
import { matchPreviousBridge } from './known-bridges.js';

export const MIGRATION_SCHEMA = 1;
const JOURNAL_RE = /^mig_[0-9a-f]{20}$/;
const BRIDGE_MAX_BYTES = 2 * 1024 * 1024;
const AUTO_STATE = 'auto-state.json';

export class MigrationError extends PathConfineError {
  constructor(status, message, code, extra = {}) {
    super(status, message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// The text SynaBun's bridges carried (lib/skill-prompt-bridge.js and server.js buildCliSkillPrompt): the Codex pointer
// (since 2026-07-13) and the OpenCode banner. Codex bridges written before 2026-07-13 were the OpenCode text with an
// invocation note: no Codex signature, so only the list of earlier generations (proof generated-previous) knows them.
const CODEX_SIGNATURE = /\n# SynaBun Skill Bridge\n\nRead `([^`\n]+)` with the local file tools and follow it exactly\./;
const OPENCODE_SIGNATURE = /\n> SynaBun skill bridge — full instructions live in the bundled SynaBun repo at\n> ([^\n]+)\. Load any referenced module files using your runtime's file-read tool\.\n/;

/** What a file says about being one of SynaBun's bridges: `{ runtime, skill, pointsTo }`, or null. */
export function bridgeSignature(text, { name, family }) {
  const s = String(text || '');
  if (family === 'codex') {
    const m = CODEX_SIGNATURE.exec(s);
    if (!m) return null;
    const pointsTo = m[1];
    const skill = /([^\\/]+)[\\/]SKILL\.md$/.exec(pointsTo)?.[1] || null;
    return skill === name ? { runtime: 'codex', skill, pointsTo } : null;
  }
  if (family === 'opencode') {
    const m = OPENCODE_SIGNATURE.exec(s);
    if (!m) return null;
    const pointsTo = m[1];
    const skill = /([^\\/]+)$/.exec(pointsTo)?.[1] || null;
    return skill === name ? { runtime: 'opencode', skill, pointsTo } : null;
  }
  return null;
}

/**
 * @param {object} o
 * @param {string} o.dataDir DATA_HOME/data/skills
 * @param {object} o.roots lib/skills/roots.js resolver
 * @param {object} o.ownership lib/skills/ownership.js installer
 * @param {object} o.deployer lib/skills/deploy.js
 * @param {(name: string) => object|null} o.bundledRevision the library revision of a bundled skill (its upstream)
 * @param {(name: string, runtime: string) => string|null} [o.currentBridge] what SynaBun's bridge for it would be today
 * @param {(name: string) => string|null} [o.bundledSkillDir] the bundled skill's folder as the generator wrote it into
 *   a bridge; by default read from today's bridges (OpenCode's banner names it, Codex's pointer its SKILL.md)
 * @param {Map<string, object[]>} [o.knownBridges] the earlier generations (lib/skills/known-bridges.js readKnownBridges);
 *   by default the shipped list
 */
export function createBridgeMigration({ dataDir, roots, ownership, deployer, bundledRevision, currentBridge = () => null, bundledSkillDir = null, knownBridges = undefined, emit = () => {}, now = () => new Date().toISOString(), newId = () => `mig_${randomBytes(10).toString('hex')}` }) {
  const home = join(dataDir, 'migrations');

  /** The bundled folder of a skill as its bridges name it, or null (then no earlier generation can be proven). */
  function skillDirOf(name) {
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    if (bundledSkillDir) { const dir = safe(() => bundledSkillDir(name)); return typeof dir === 'string' && dir ? dir : null; }
    const oc = safe(() => currentBridge(name, 'opencode'));
    const banner = typeof oc === 'string' ? bridgeSignature(oc, { name, family: 'opencode' }) : null;
    if (banner) return banner.pointsTo;
    const cx = safe(() => currentBridge(name, 'codex'));
    const pointer = typeof cx === 'string' ? bridgeSignature(cx, { name, family: 'codex' }) : null;
    // join(folder, 'SKILL.md'): the folder is the pointer without its last separator and file name.
    if (pointer && /[\\/]SKILL\.md$/.test(pointer.pointsTo)) return pointer.pointsTo.slice(0, -'/SKILL.md'.length);
    return null;
  }

  /** Every old bridge in the runtimes' folders, with its proof of being SynaBun's. */
  function findBridges() {
    const out = [];
    const seen = new Set();
    const dirs = new Map();
    const dirOf = (name) => { if (!dirs.has(name)) dirs.set(name, skillDirOf(name)); return dirs.get(name); };
    // Exactly the bytes an earlier SynaBun version wrote for this runtime and skill, from this install's folder.
    const earlierGeneration = (bytes, name, runtime) => {
      const dir = dirOf(name);
      return dir ? matchPreviousBridge(bytes, { runtime, name, skillDir: dir, ...(knownBridges ? { known: knownBridges } : {}) }) : null;
    };
    for (const root of roots.listRoots()) {
      if (root.sourceKind !== 'legacy-bridge' || root.status !== 'ok') continue;
      const where = root.resolvedPath || root.path;
      if (seen.has(where)) continue;   // an account's prompts/ that links to Default's is one folder
      seen.add(where);
      let names = [];
      try { names = readdirSync(where).filter((n) => /\.md$/i.test(n) && !n.startsWith('.')).sort(); } catch { continue; }
      for (const file of names.slice(0, 500)) {
        const path = join(root.path, file);
        const name = file.replace(/\.md$/i, '');
        let st;
        try { st = lstatSync(path); } catch { continue; }
        const bridgeId = `brg_${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 20)}`;
        const row = { bridgeId, runtime: root.family, rootId: root.rootId, accountId: root.accountId || 'default', path, name, kind: st.isSymbolicLink() ? 'link' : (st.isFile() ? 'file' : 'other') };
        if (row.kind !== 'file') { out.push({ ...row, proof: 'none', digest: null, why: 'Not a regular file: left as it is.' }); continue; }
        let bytes;
        try { bytes = readConfinedFile(root.path, path, { maxBytes: BRIDGE_MAX_BYTES }); } catch (err) { out.push({ ...row, proof: 'none', digest: null, why: `Cannot be read (${err?.message || err}).` }); continue; }
        const digest = sha256(bytes);
        const text = bytes.toString('utf-8');
        const record = ownership.recordFor(path);
        const ledgerOwned = !!record && record.digest === digestManifest(bytes, (st.mode & 0o111) !== 0);
        const today = (() => { try { return currentBridge(name, root.family); } catch { return null; } })();
        const signature = bridgeSignature(text, { name, family: root.family });
        let proof = 'none';
        let previous = null;
        if (ledgerOwned) proof = 'ledger';
        else if (today !== null && today === text) proof = 'generated-current';
        else if ((previous = earlierGeneration(bytes, name, root.family))) proof = 'generated-previous';
        else if (signature) proof = 'generated-signature';
        out.push({ ...row, digest, size: bytes.length, proof, signature, ...(previous ? { previous: { since: previous.firstDate || null, firstCommit: previous.firstCommit || null } } : {}), ledgerRecord: !!record, why: proof === 'none' ? (record ? 'SynaBun installed a bridge here, but it was changed since: left as it is.' : 'Not one of SynaBun\'s bridges: left as it is.') : '' });
      }
    }
    return out;
  }

  /**
   * What a migration would do, bridge by bridge, with the native install plan of each. A bridge that is not proven
   * SynaBun's is left (`action: 'leave'`) and, when SynaBun ships a skill of its name, offered (`offer: { digest }`):
   * `confirm[bridgeId] === digest` is the owner's word for exactly those bytes, and the step then moves (proof
   * `owner-confirmed`). The plan's digest covers the proofs, so a confirmation is part of what a move is taken by.
   * @param {{ confirm?: Record<string, string> }} [o]
   */
  async function plan({ confirm = {} } = {}) {
    const bridges = findBridges();
    const steps = [];
    for (const b of bridges) {
      const step = { ...b, action: 'skip', native: null, offer: null };
      // By itself only on exact bytes (the ledger's, today's generation, or an earlier version's). A signature-only
      // bridge (edited since, or bytes no list knows) and any other file of a shipped skill wait for the owner's word.
      if (b.proof === 'none' || b.proof === 'generated-signature') {
        const shipped = b.kind === 'file' && b.digest ? bundledRevision(b.name) : null;
        if (shipped) step.offer = { digest: b.digest, revisionId: shipped.revisionId, signature: b.proof === 'generated-signature' };
        if (shipped && confirm && typeof confirm === 'object' && confirm[b.bridgeId] === b.digest) step.proof = 'owner-confirmed';
        else { step.action = 'leave'; if (b.proof === 'generated-signature' && !step.why) step.why = 'It has SynaBun\'s bridge wording but not the bytes SynaBun writes today (edited, or an older version): moved only when you confirm it.'; steps.push(step); continue; }
      }
      const revision = bundledRevision(b.name);
      if (!revision) { step.action = 'leave'; step.why = `SynaBun no longer ships a "${b.name}" skill to install in its place: left as it is.`; steps.push(step); continue; }
      const target = { runtime: b.runtime, scope: 'user', accountId: b.runtime === 'codex' ? b.accountId : 'default' };
      try {
        const p = await deployer.plan({ revisionId: revision.revisionId, targets: [target] });
        const t = p.targets[0];
        step.native = { revisionId: revision.revisionId, planDigest: p.planDigest, target, destination: t.destination, state: t.destinationState?.state || null, blocked: t.blocked, needs: t.needs, ready: t.ready, artifactDigest: t.export?.artifactDigest || null };
        if (t.blocked.length) { step.action = 'blocked'; step.why = t.blocked.map((x) => x.message).join(' '); }
        else if (t.needs.some((n) => n.code === 'confirm_replace')) { step.action = 'blocked'; step.why = `A "${b.name}" skill folder that SynaBun did not install is already there (${t.destination}): resolve it first; the bridge is left as it is.`; }
        else step.action = 'migrate';
      } catch (err) { step.action = 'blocked'; step.why = err?.message || String(err); }
      steps.push(step);
    }
    const subject = steps.map((s) => [s.bridgeId, s.path, s.digest, s.proof, s.action, s.native?.planDigest || null]);
    return { steps, planDigest: digestOf(subject), counts: { migrate: steps.filter((s) => s.action === 'migrate').length, leave: steps.filter((s) => s.action === 'leave').length, blocked: steps.filter((s) => s.action === 'blocked').length, offered: steps.filter((s) => s.action === 'leave' && s.offer).length }, createdAt: now() };
  }

  // ── The automatic run and its notice ──

  function readAutoState() {
    try { return { autoPaused: false, lastAuto: null, noticeDismissedAt: null, ...JSON.parse(readConfinedFile(home, join(home, AUTO_STATE), { maxBytes: 1024 * 1024, encoding: 'utf-8' })) }; } catch { return { autoPaused: false, lastAuto: null, noticeDismissedAt: null }; }
  }
  function writeAutoState(state) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    replaceFileAtomic(join(home, AUTO_STATE), `${JSON.stringify({ schemaVersion: 1, ...state, updatedAt: now() }, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * The server's one run at start: move what is proven SynaBun's, if anything, and leave the notice. Nothing moves
   * while the owner's undo of an earlier automatic move stands (`autoPaused`). Never throws.
   * @returns {Promise<{ ran: boolean, reason?: string, result?: object, plan?: object }>}
   */
  async function autoMigrate() {
    const state = readAutoState();
    if (state.autoPaused) return { ran: false, reason: 'paused' };
    let fresh;
    try { fresh = await plan(); } catch (err) { return { ran: false, reason: 'plan-failed', error: err?.message || String(err) }; }
    if (!fresh.counts.migrate) return { ran: false, reason: 'nothing', plan: fresh };
    let result;
    try { result = await migrate({ planDigest: fresh.planDigest, principal: { kind: 'system' }, auto: true }); } catch (err) { return { ran: false, reason: 'failed', error: err?.message || String(err), plan: fresh }; }
    let noticeError = null;
    if (result.journalId) {
      // The move stands whatever happens to the notice: a notice that cannot be written is said, never thrown.
      try {
        writeAutoState({ ...state, lastAuto: { journalId: result.journalId, at: now(), status: result.status, migrated: result.results.filter((r) => r.outcome === 'migrated').map((r) => ({ runtime: r.runtime, name: r.name, path: r.path, destination: r.destination, proof: r.proof })), notMoved: result.results.filter((r) => r.outcome !== 'migrated').map((r) => ({ runtime: r.runtime, name: r.name, path: r.path, outcome: r.outcome, error: r.error || null })) }, noticeDismissedAt: null });
      } catch (err) { noticeError = err?.message || String(err); }
    }
    return { ran: true, result, plan: fresh, ...(noticeError ? { noticeError } : {}) };
  }

  /**
   * What the Studio shows once: the last automatic move while it stands (not undone, not dismissed), the bridges
   * left behind that the owner may move by confirming them (`offers`, with the plan digest a confirmed move is
   * taken by), and whether the automatic run is paused by an undo.
   */
  async function notice() {
    const state = readAutoState();
    let pending = null;
    if (state.lastAuto && !state.noticeDismissedAt) {
      let journal = null;
      try { journal = readJournal(state.lastAuto.journalId); } catch { journal = null; }
      if (journal && !['reverted', 'partially-reverted'].includes(journal.status)) pending = { ...state.lastAuto, status: journal.status };
    }
    let offers = [];
    let planDigest = null;
    let left = 0;
    try {
      const fresh = await plan();
      planDigest = fresh.planDigest;
      offers = fresh.steps.filter((s) => s.action === 'leave' && s.offer).map((s) => ({ bridgeId: s.bridgeId, runtime: s.runtime, name: s.name, path: s.path, digest: s.offer.digest, why: s.why || '' }));
      left = fresh.steps.filter((s) => s.action === 'leave' && !s.offer).length;
    } catch { /* no offers: the plan could not be made */ }
    return { pending, offers, planDigest, left, autoPaused: !!state.autoPaused };
  }

  /** The owner read the notice: it is not shown again (the journal stays, Undo stays in Settings). */
  function dismissNotice() {
    const state = readAutoState();
    writeAutoState({ ...state, noticeDismissedAt: now() });
    return { ok: true };
  }

  function journalDir(id) {
    if (typeof id !== 'string' || !JOURNAL_RE.test(id)) throw new MigrationError(400, 'Not a migration id.', 'invalid_journal');
    return join(home, id);
  }
  function readJournal(id) {
    const dir = journalDir(id);
    try { return JSON.parse(readConfinedFile(dir, join(dir, 'journal.json'), { maxBytes: 8 * 1024 * 1024, encoding: 'utf-8' })); } catch {
      throw new MigrationError(404, 'There is no such migration.', 'journal_not_found');
    }
  }
  function writeJournal(j) {
    const dir = journalDir(j.journalId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    j.updatedAt = now();
    replaceFileAtomic(join(dir, 'journal.json'), `${JSON.stringify(j, null, 2)}\n`, { mode: 0o600 });
  }
  function listJournals() {
    let names = [];
    try { names = readdirSync(home).filter((n) => JOURNAL_RE.test(n)).sort(); } catch { names = []; }
    return names.map((n) => { try { return readJournal(n); } catch { return null; } }).filter(Boolean).map((j) => ({ journalId: j.journalId, createdAt: j.createdAt, status: j.status, steps: j.steps.length, migrated: j.steps.filter((s) => s.bridgeRemoved).length }));
  }

  /**
   * Move every bridge the plan marks `migrate`. `planDigest` must be the plan's: anything that changed since
   * (a file, a proof, a destination) makes it 409 with the new plan, and nothing happens.
   */
  async function migrate({ planDigest, confirm = {}, principal = { kind: 'owner' }, auto = false }) {
    const fresh = await plan({ confirm });
    if (typeof planDigest !== 'string' || planDigest !== fresh.planDigest) throw new MigrationError(409, 'The bridges or their destinations changed since the plan was shown. Nothing was moved; look at the new plan.', 'plan_changed', { plan: fresh });
    const todo = fresh.steps.filter((s) => s.action === 'migrate');
    if (!todo.length) return { ok: true, journalId: null, results: [], plan: fresh, nothingToDo: true };
    // A move the owner asks for by hand lifts the pause an undo of an automatic move left.
    if (!auto) { const state = readAutoState(); if (state.autoPaused) writeAutoState({ ...state, autoPaused: false, pausedBy: null }); }
    const journal = { schemaVersion: MIGRATION_SCHEMA, journalId: newId(), createdAt: now(), status: 'running', by: principal?.kind || 'owner', auto: !!auto, planDigest, steps: [], events: [] };
    if (!JOURNAL_RE.test(journal.journalId)) throw new MigrationError(500, 'Bad migration id.', 'bad_id');
    writeJournal(journal);
    const event = (text) => { journal.events.push({ at: now(), text }); };
    for (const s of todo) {
      const step = { bridgeId: s.bridgeId, runtime: s.runtime, path: s.path, name: s.name, digest: s.digest, proof: s.proof, revisionId: s.native.revisionId, destination: s.native.destination, installationId: null, nativeCommitted: false, nativeWasThere: s.native.state === 'identical' || s.native.state === 'owned', bridgeBackup: null, bridgeRemoved: false, outcome: 'pending' };
      journal.steps.push(step);
      writeJournal(journal);
      try {
        // 1. The native folder, first.
        const result = await deployer.install({ revisionId: s.native.revisionId, targets: [s.native.target], planDigest: s.native.planDigest, principal, migration: { journalId: journal.journalId, bridgeId: s.bridgeId } });
        const r = result.results[0];
        if (r.status !== 'committed') { step.outcome = 'native-not-installed'; step.error = r.error || (r.reasons || []).map((x) => x.message).join(' '); event(`${s.path}: the native skill was not installed; the bridge stays.`); writeJournal(journal); continue; }
        step.installationId = r.installationId;
        step.nativeCommitted = true;
        event(`${s.path}: installed ${s.name} at ${r.destination}.`);
        writeJournal(journal);
        // 2. The bridge's bytes, kept and read back.
        const dir = journalDir(journal.journalId);
        const keep = join(dir, 'bridges', `${s.bridgeId}.md`);
        const bytes = readConfinedFile(dirname(s.path), s.path, { maxBytes: BRIDGE_MAX_BYTES });
        if (sha256(bytes) !== s.digest) { step.outcome = 'bridge-changed'; event(`${s.path}: changed since the plan; left in place.`); writeJournal(journal); continue; }
        const st = lstatSync(s.path);
        writeConfinedFile(dir, keep, bytes, { exclusive: true, mode: 0o600 });
        if (sha256(readConfinedFile(dir, keep, { maxBytes: BRIDGE_MAX_BYTES })) !== s.digest) throw new MigrationError(500, 'The bridge\'s copy does not read back.', 'backup_failed');
        step.bridgeBackup = `bridges/${s.bridgeId}.md`;
        step.bridgeMode = st.mode & 0o777;
        writeJournal(journal);
        // 3. Out of the runtime's folder, while it still is those bytes.
        const again = lstatSync(s.path);
        const now2 = readConfinedFile(dirname(s.path), s.path, { maxBytes: BRIDGE_MAX_BYTES });
        if (again.ino !== st.ino || sha256(now2) !== s.digest) { step.outcome = 'bridge-changed'; event(`${s.path}: changed while it was moved; left in place.`); writeJournal(journal); continue; }
        // The intent first: a crash between the removal and its record would otherwise leave a bridge gone that an
        // undo believes was never removed (revert restores from the kept copy whenever the file is missing).
        step.removing = true;
        writeJournal(journal);
        unlinkSync(s.path);
        step.bridgeRemoved = true;
        step.outcome = 'migrated';
        ownership.forget({ destination: s.path, target: s.runtime, name: s.name, reason: `bridge moved to ${s.native.destination} (${journal.journalId})` });
        ownership.note({ action: 'migrate-bridge', target: s.runtime, name: s.name, destination: resolve(s.path), result: 'moved', digest: s.digest, journalId: journal.journalId, installationId: step.installationId });
        event(`${s.path}: moved out (kept in the journal).`);
        writeJournal(journal);
      } catch (err) {
        step.outcome = 'failed';
        step.error = err?.message || String(err);
        event(`${s.path}: ${step.error}`);
        writeJournal(journal);
      }
    }
    journal.status = journal.steps.every((x) => x.outcome === 'migrated') ? 'done' : (journal.steps.some((x) => x.outcome === 'migrated') ? 'partial' : 'failed');
    writeJournal(journal);
    emit({ type: 'migration.changed', journalId: journal.journalId });
    return { ok: journal.status === 'done', journalId: journal.journalId, status: journal.status, results: journal.steps, plan: fresh };
  }

  /** Undo a migration: bridges back where they were (only into a free place), native installs rolled back. */
  async function revert(journalId, { principal = { kind: 'owner' } } = {}) {
    const journal = readJournal(journalId);
    if (journal.status === 'reverted') return { ok: true, journalId, status: 'reverted', results: journal.steps, already: true };
    const dir = journalDir(journalId);
    const results = [];
    for (const step of [...journal.steps].reverse()) {
      const out = { bridgeId: step.bridgeId, path: step.path, bridge: 'untouched', native: 'untouched' };
      if ((step.bridgeRemoved || step.removing) && step.bridgeBackup && !step.bridgeRestored) {
        try {
          const bytes = readConfinedFile(dir, join(dir, step.bridgeBackup), { maxBytes: BRIDGE_MAX_BYTES });
          if (sha256(bytes) !== step.digest) throw new MigrationError(500, 'The kept copy does not match.', 'backup_corrupt');
          let present = true;
          try { lstatSync(step.path); } catch { present = false; }
          // Present and never recorded as removed: the move stopped before the removal; nothing to put back.
          if (present && !step.bridgeRemoved) { out.bridge = 'untouched'; }
          else if (present) { out.bridge = 'conflict'; out.why = `${step.path} exists again: the kept bridge was not put over it (it stays in ${join(dir, step.bridgeBackup)}).`; }
          else {
            mkdirSync(dirname(step.path), { recursive: true });
            writeConfinedFile(dirname(step.path), step.path, bytes, { exclusive: true, mode: step.bridgeMode || 0o644 });
            step.bridgeRestored = true;
            out.bridge = 'restored';
            ownership.recordWrite({ target: step.runtime, name: step.name, destination: step.path, digest: digestManifest(bytes, ((step.bridgeMode || 0) & 0o111) !== 0), kind: 'file', source: { kind: 'bridge-restore', journalId } });
          }
        } catch (err) { out.bridge = 'failed'; out.why = err?.message || String(err); }
      }
      // The native install this move made is rolled back whatever was there before: a folder of an older SynaBun
      // install comes back from its backup (and its installation is the one in place again); one that already held
      // these bytes is left as it is (deploy.js rollback changes no file for an install that wrote nothing).
      if (step.nativeCommitted && step.installationId && !step.nativeRolledBack) {
        try {
          deployer.rollback(step.installationId, { principal });
          step.nativeRolledBack = true;
          out.native = 'rolled-back';
        } catch (err) { out.native = 'kept'; out.why = `${out.why ? `${out.why} ` : ''}The native skill was left in place: ${err?.message || err}`; }
      }
      results.push(out);
    }
    const clean = results.every((r) => r.bridge !== 'conflict' && r.bridge !== 'failed' && r.native !== 'kept');
    journal.status = clean ? 'reverted' : 'partially-reverted';
    journal.events.push({ at: now(), text: `Reverted by ${principal?.kind || 'owner'}: ${clean ? 'everything is back' : 'some steps could not be undone'}.` });
    writeJournal(journal);
    // An automatic move the owner took back stays taken back: the next start moves nothing by itself.
    if (journal.auto) { const state = readAutoState(); writeAutoState({ ...state, autoPaused: true, pausedBy: journalId }); }
    ownership.note({ action: 'revert-migration', journalId, result: journal.status });
    emit({ type: 'migration.changed', journalId });
    return { ok: clean, journalId, status: journal.status, results };
  }

  return { findBridges, plan, migrate, revert, autoMigrate, notice, dismissNotice, readJournal, listJournals, paths: { home } };
}

/** The one-file manifest digest an install records for a bridge (lib/skills/ownership.js payloadFromText). */
function digestManifest(bytes, executable) {
  return manifestDigest([fileEntry('.', bytes, { executable })]);
}

/**
 * Whether the server may move the owner's bridges by itself at this start: never under a test run (NODE_TEST_CONTEXT,
 * VITEST), never with the kill switch (SYNABUN_SKILLS_AUTO_MIGRATE=off|0), and never from a temporary data home, whatever
 * HOME is: a dev or test boot with the real HOME and a data home under the system's temporary folders (os.tmpdir(),
 * TMPDIR, /tmp, /private/tmp, /var/tmp, /var/folders and their /private twins) must not touch the owner's real
 * folders. Paths are compared as real paths (macOS keeps /tmp and /var behind /private).
 */
export function autoMigrationAllowed({ env = process.env, dataHome = null, tmp = tmpdir() } = {}) {
  if (env.SYNABUN_SKILLS_AUTO_MIGRATE === 'off' || env.SYNABUN_SKILLS_AUTO_MIGRATE === '0') return false;
  if (env.NODE_TEST_CONTEXT || env.VITEST) return false;
  if (!dataHome) return false;
  const real = (p) => {
    // A path that is not there yet (a data home about to be made): its nearest existing ancestor's real path, then the rest.
    let head = resolve(String(p));
    const tail = [];
    for (;;) {
      try { return tail.length ? join(realpathSync(head), ...tail) : realpathSync(head); } catch { /* not there: one up */ }
      const parent = dirname(head);
      if (parent === head) return resolve(String(p));
      tail.unshift(head.slice(parent.length).replace(/^[\\/]/, ''));
      head = parent;
    }
  };
  const inside = (child, parent) => { const c = real(child); const p = real(parent); return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`); };
  const roots = [tmp, env.TMPDIR, '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'].filter(Boolean);
  for (const root of roots) { try { if (inside(dataHome, root)) return false; } catch { /* a root that cannot be read is not the data home's */ } }
  return true;
}
