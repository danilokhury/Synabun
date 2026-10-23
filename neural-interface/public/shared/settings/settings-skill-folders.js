// ═══════════════════════════════════════════
// SynaBun Neural Interface — Settings → Skills: skill folders, read (no DOM)
// ═══════════════════════════════════════════
//
// What the Skills Service says (GET /api/skills-studio/v2/status, the bridge migration's plan and outcome) turned
// into what Settings → Skills shows: whether the old Codex prompt / OpenCode command bridges can move to native
// skill folders, what each would do, the outcome of a move or an undo, the shared ~/.agents/skills switch, and
// each runtime chip's state (a native folder, an old bridge, someone else's folder). Every sentence is a
// settings.redesign.skills.* key; the pane (settings-skill-folders-pane.js) draws it.

const RUNTIME = { claude: 'settings.redesign.product.claude', codex: 'settings.redesign.product.codex', opencode: 'settings.redesign.product.opencode' };

/** What the status answer says, or that the server cannot say it yet (one from before the Skills Service). */
export function readFoldersStatus(answer) {
  if (!answer || answer.ok !== true || !answer.bridges) return { available: false, message: { key: 'settings.redesign.skills.folders.unavailable' } };
  const synabun = Number(answer.bridges.synabun) || 0;
  const other = Number(answer.bridges.other) || 0;
  return {
    available: true,
    sharedAgentsRoot: answer.config?.sharedAgentsRoot === true,
    bridges: { synabun, other },
    message: synabun === 0 ? { key: 'settings.redesign.skills.folders.bridgesNone' } : synabun === 1 ? { key: 'settings.redesign.skills.folders.bridgesOne' } : { key: 'settings.redesign.skills.folders.bridgesMany', params: { count: synabun } },
    others: other === 0 ? null : other === 1 ? { key: 'settings.redesign.skills.folders.othersOne' } : { key: 'settings.redesign.skills.folders.othersMany', params: { count: other } },
    canReview: synabun > 0,
  };
}

/**
 * The lines of a migration plan, one per bridge of SynaBun's, and whether anything would move. The prompt and
 * command files that are not SynaBun's are only counted (the status says how many): they are never moved, and a
 * line each would bury the ones that are.
 */
export function readMigrationPlan(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const lines = steps.filter((s) => s.action !== 'leave' || s.proof !== 'none' || s.ledgerRecord).map((s) => {
    const params = { runtime: { key: RUNTIME[s.runtime] || RUNTIME.codex }, name: `/${s.name}`, destination: s.native?.destination || '', why: s.why || '' };
    if (s.action === 'migrate') return { tone: 'ok', key: 'settings.redesign.skills.folders.stepMigrate', params };
    if (s.action === 'blocked') return { tone: 'warn', key: 'settings.redesign.skills.folders.stepBlocked', params };
    return { tone: 'muted', key: 'settings.redesign.skills.folders.stepLeave', params };
  });
  const movable = steps.filter((s) => s.action === 'migrate').length;
  return { lines, movable, planDigest: typeof plan?.planDigest === 'string' ? plan.planDigest : null, empty: movable === 0 ? { key: 'settings.redesign.skills.folders.nothing' } : null };
}

/** What a move answered: done, in part (which and why), nothing to do. */
export function readMigrationOutcome(out) {
  if (!out) return { tone: 'warn', key: 'settings.redesign.skills.folders.failed', params: { message: '' } };
  if (out.nothingToDo) return { tone: 'muted', key: 'settings.redesign.skills.folders.nothing' };
  if (out.status === 'done') return { tone: 'ok', key: 'settings.redesign.skills.folders.moved', params: { id: out.journalId } };
  const failed = (out.results || []).filter((r) => r.outcome !== 'migrated').map((r) => `/${r.name}: ${r.error || r.outcome}`).join('; ');
  if (out.status === 'failed') return { tone: 'warn', key: 'settings.redesign.skills.folders.failed', params: { message: failed } };
  return { tone: 'warn', key: 'settings.redesign.skills.folders.movedPartly', params: { details: failed } };
}

/** What an undo answered. */
export function readRevertOutcome(out) {
  if (!out) return { tone: 'warn', key: 'settings.redesign.skills.folders.failed', params: { message: '' } };
  if (out.status === 'reverted') return { tone: 'ok', key: 'settings.redesign.skills.folders.undone' };
  const details = (out.results || []).filter((r) => r.bridge === 'conflict' || r.bridge === 'failed' || r.native === 'kept').map((r) => r.why || r.path).join('; ');
  return { tone: 'warn', key: 'settings.redesign.skills.folders.undonePartly', params: { details } };
}

/** The last move that can be undone, from GET /migrations (newest first). */
export function lastUndoable(list) {
  const rows = (Array.isArray(list) ? list : []).filter((m) => m && (m.status === 'done' || m.status === 'partial' || m.status === 'partially-reverted') && m.migrated > 0);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return rows[0] || null;
}

/**
 * A runtime chip of a skill: its state (`native`: SynaBun's skill folder; `bridge`: an old bridge not moved yet;
 * `shared`: SynaBun's copy in ~/.agents/skills, which Codex and OpenCode both read; `other`: a folder of that name
 * SynaBun did not install, in the runtime's folder or the shared one; `installed`: a server from before the skill
 * folders says only that it is there; `off`) and its title key.
 * @param {object|undefined} state the skill's targetStates[runtime] from GET /api/skills
 * @param {boolean} installed the older single flag (installedTargets[runtime])
 */
export function chipState(state, installed) {
  if (!state) return installed ? { state: 'installed', on: true, key: 'settings.redesign.skills.chip.installed' } : { state: 'off', on: false, key: 'settings.redesign.skills.installFor' };
  if (state.native === 'native' || state.native === 'modified') return { state: 'native', on: true, key: 'settings.redesign.skills.chip.native' };
  if (state.bridge) return { state: 'bridge', on: true, key: 'settings.redesign.skills.chip.bridge' };
  if (state.shared === 'native') return { state: 'shared', on: true, key: 'settings.redesign.skills.chip.shared' };
  if (state.native === 'other') return { state: 'other', on: false, key: 'settings.redesign.skills.chip.other' };
  if (state.shared === 'other') return { state: 'other', on: false, key: 'settings.redesign.skills.chip.otherShared' };
  return { state: 'off', on: false, key: 'settings.redesign.skills.installFor' };
}

/**
 * The toast after a chip installed a skill: a skill folder of its own, whether an old bridge of it is still there,
 * and what the runtime needs to see it (`refresh` of the install answer: automatic, reload-skills, new-session).
 */
export function installedToast(answer) {
  if (answer?.shared) return 'settings.redesign.skills.chip.installedShared';
  if (answer?.bridge) return 'settings.redesign.skills.chip.installedBridgeLeft';
  const kinds = new Set((Array.isArray(answer?.refresh) ? answer.refresh : []).map((r) => r?.kind));
  if (kinds.has('new-session')) return 'settings.redesign.skills.chip.installedNewSession';
  if (kinds.has('reload-skills')) return 'settings.redesign.skills.chip.installedReload';
  return 'settings.redesign.skills.chip.installedNative';
}
