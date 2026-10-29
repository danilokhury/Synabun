// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the simple install flow, as data
// ═══════════════════════════════════════════
//
// Installing an approved skill is one decision (where) and one press (Install). This module decides, without a
// page: the one status a library skill shows everywhere (the workspace header, its Library row, the banner), what
// is ticked when Publish opens (the review's targets, else where the skill already is, else Claude Code for every
// project: never everything), the simple picker (one tile per runtime in one scope; everything else, accounts,
// the shared folder, other projects, lives under Advanced and is only reported here), the version picked by
// default (the approved one when the latest was made by an agent and is not approved), the one line each target
// of a plan gets (what will happen there, as a code the view words), what an install must ask first (a folder
// SynaBun did not install or that changed since, the scan's findings) and never asks otherwise, the words of the
// one button, and the outcome of an install. The plan and the install themselves stay the service's
// (lib/skills/deploy.js) through sx-plan.js: nothing here changes what is sent, only what is asked and shown.
// No DOM; imports sx-subject.js and sx-plan.js only.

import { targetKey, targetState, defaultTargets, seenThrough } from './sx-subject.js';
import { installableRows, decisionsOf } from './sx-plan.js';

export const STATUS_CODES = Object.freeze(['draft', 'review', 'changes', 'approved', 'installed', 'outdated', 'none']);
export const LINE_CODES = Object.freeze(['create', 'replace-owned', 'replace-modified', 'replace-unowned', 'identical', 'blocked']);
// What a tile says of a runtime: the target's state, 'via-claude' when OpenCode sees the skill through Claude Code's
// folder (ticked, or holding it) and is not ticked itself, 'unavailable' when there is no folder for it here.
export const TILE_STATES = Object.freeze(['installed', 'outdated', 'present', 'bridge', 'none', 'off', 'unavailable', 'via-claude', 'not-installed']);

/** The runtimes that are installed on this computer (the status' `assistants.installed`), or null when not known. */
export function installedRuntimesOf(source) {
  const list_ = source?.assistants?.installed ?? source?.installed ?? null;
  return Array.isArray(list_) ? list_.filter((r) => typeof r === 'string') : null;
}

/**
 * "Also install for Codex · OpenCode": the assistants in effect (user scope, default account) that do not have a
 * skill that is installed somewhere already; empty when nothing is missing, when nothing is installed yet (Publish
 * is the way), or when the skill is not a library skill. A runtime known not to be installed here is left out.
 * @param {{ skill?: object|null, row?: object|null, targets: object[], assistants?: string[]|null, installed?: string[]|null }} o
 * @returns {object[]} targets of installTargets()
 */
export function alsoInstallTargets({ skill = null, row = null, targets = [], assistants = null, installed = null } = {}) {
  if (!skill || row?.source === 'synabun' || !list(skill.installations).length) return [];
  const wanted = Array.isArray(assistants) && assistants.length ? assistants : [];
  return SIMPLE_RUNTIMES.filter((r) => wanted.includes(r) && !(Array.isArray(installed) && !installed.includes(r)))
    .map((r) => list(targets).find((t) => t.key === keyIn(r, 'user')) || null)
    .filter((t) => t && !t.off && !['installed', 'outdated', 'present'].includes(targetState(t, { skill, row }).state));
}

/**
 * The version "Also install for …" sends: the one the installations hold (the one most of them hold when they
 * differ; on a tie the approved one, then the latest), else the approved one, else the latest; null for none.
 */
export function alsoInstallRevision(skill) {
  const held = list(skill?.installations).map((i) => i?.sourceRevisionId).filter((r) => typeof r === 'string' && r);
  const pointers = skill?.pointers || {};
  if (!held.length) return pointers.approved || pointers.latest || null;
  const count = new Map();
  for (const r of held) count.set(r, (count.get(r) || 0) + 1);
  const rank = (r) => (r === pointers.approved ? 2 : r === pointers.latest ? 1 : 0);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || rank(b[0]) - rank(a[0]) || held.indexOf(a[0]) - held.indexOf(b[0]))[0][0];
}
export const BUTTON_CODES = Object.freeze(['install', 'update', 'installed', 'checking', 'installing', 'nothing', 'blocked']);
export const SIMPLE_RUNTIMES = Object.freeze(['claude', 'codex', 'opencode']);
const APPROVED_STATES = ['approved', 'partial', 'publish_failed'];

const list = (v) => (Array.isArray(v) ? v : []);

/** Where an installation is, as a target (the view words it: "Claude Code · all projects"). */
export function whereOf(i) {
  const scope = i?.scope === 'project' ? 'project' : 'user';
  return { runtime: i?.runtime || 'claude', scope, projectPath: scope === 'project' ? i.projectPath || null : null, accountId: scope === 'user' ? i?.accountId || 'default' : 'default', outdated: !!i?.updateAvailable };
}

/**
 * The one status of a library skill: draft (no version yet), in review, changes asked for, approved but not
 * installed, installed (where), installed with an update available, or not installed. Null for what is not a
 * library skill (a plugin's, SynaBun's own, a folder not adopted): those keep their source and health.
 * @param {{ skill?: object|null, row?: object|null }} o the library summary (GET /skills) and its Library row
 */
export function installStatus({ skill = null, row = null } = {}) {
  if (!skill || row?.source === 'synabun') return null;
  const installs = list(skill.installations);
  const review = row?.review || null;
  const reviewState = review?.state || null;
  if (installs.length) {
    const outdated = !row?.keptUpdate && installs.some((i) => !!i.updateAvailable);
    return { code: outdated ? 'outdated' : 'installed', where: installs.map(whereOf), reviewState, reviewId: review?.reviewId || null };
  }
  if (reviewState === 'pending') return { code: 'review', where: [], reviewState, reviewId: review.reviewId };
  if (reviewState === 'changes_requested') return { code: 'changes', where: [], reviewState, reviewId: review.reviewId };
  if (APPROVED_STATES.includes(reviewState)) return { code: 'approved', where: [], reviewState, reviewId: review.reviewId };
  if (!skill.revisions) return { code: 'draft', where: [], reviewState: null, reviewId: null };
  return { code: 'none', where: [], reviewState: null, reviewId: null };
}

/**
 * What is ticked when Publish opens: the targets the review named (those that exist and are on), else where the
 * skill already is, else the owner's assistants (sx-subject.js defaultTargets: never everything, no second copy
 * for a runtime that reads a ticked folder).
 * @param {{ review?: object|null, targets: object[], skill?: object|null, row?: object|null, assistants?: string[]|null }} o targets: sx-subject.js installTargets()
 * @returns {Set<string>} target keys
 */
export function defaultSelection({ review = null, targets = [], skill = null, row = null, assistants = null } = {}) {
  const named = list(review?.targets).filter((x) => x && typeof x.runtime === 'string');
  const keys = new Set(named.map((x) => targetKey(x)));
  const fromReview = targets.filter((x) => !x.off && keys.has(x.key)).map((x) => x.key);
  if (fromReview.length) return new Set(fromReview);
  // The review named targets and none of them is here (another computer's project, the shared folder off): nothing
  // is ticked, and the view says what is missing; never a silent fallback to the assistants.
  if (named.length) return new Set();
  return defaultTargets(targets, { skill, row, assistants });
}

/** The assistants in effect (GET /v2/config or /status `assistants.effective`), or null when the server has none. */
export function assistantsOf(source) {
  const list_ = source?.assistants?.effective ?? source?.effective ?? null;
  return Array.isArray(list_) && list_.length ? list_.filter((r) => typeof r === 'string') : null;
}

/** The scope a selection sits in: 'user', 'project:<path>' when every ticked target is of one project, else null (mixed). */
export function scopeOf(checked, targets) {
  const picked = list(targets).filter((t) => checked?.has?.(t.key));
  const scopes = new Set(picked.map((t) => (t.scope === 'project' ? `project:${t.projectPath}` : 'user')));
  if (scopes.size === 1) return [...scopes][0];
  return scopes.size ? null : 'user';
}

/** The key of a runtime's target in a scope ('user' or 'project:<path>'), the default account. */
export const keyIn = (runtime, scope) => (scope && scope.startsWith('project:') ? `${runtime}:project:${scope.slice(8)}` : `${runtime}:user:default`);

/**
 * The simple picker: one tile per runtime for the scope chosen (ticked or not, what is there now), and whatever
 * else is ticked (another account, the shared folder, another project: changed under Advanced only).
 * @param {{ targets: object[], checked: Set<string>, scope: string, skill?: object|null, row?: object|null, revisionId?: string|null }} o
 */
export function simplePicker({ targets = [], checked = new Set(), scope = 'user', skill = null, row = null, revisionId = null, installed = null } = {}) {
  const tiles = SIMPLE_RUNTIMES.map((runtime) => {
    const key = keyIn(runtime, scope);
    const target = list(targets).find((t) => t.key === key) || null;
    const st = target ? targetState(target, { skill, row, revisionId }) : { state: 'none', path: null };
    const on = !!target && checked.has(key);
    const available = !!target && !target.off;
    // A terminal OpenCode reads Claude Code's folder: with that one ticked (or holding the skill) and OpenCode not
    // ticked, the tile says so; SynaBun's own OpenCode panel does not read it, so the tile also says a copy is needed.
    const via = available && !on && st.state === 'none' ? seenThrough(runtime, list(targets), checked, { scope, skill, row }) : null;
    // A runtime the resolver did not find on this computer: said on the tile (the folder can still be written for a
    // later install of the runtime; nothing fails), never ticked by default (the detected assistants leave it out).
    const notInstalled = Array.isArray(installed) && !installed.includes(runtime);
    const tileState = !available ? 'unavailable' : notInstalled && st.state === 'none' ? 'not-installed' : via ? 'via-claude' : st.state;
    return { runtime, key, target, on, available, state: target ? st.state : 'none', path: st.path || target?.path || null, via, notInstalled, tileState };
  });
  const own = new Set(tiles.map((x) => x.key));
  // What is ticked beyond the tiles, and would be sent: a target that is off (the shared folder turned off in
  // Settings) is never sent, so it is neither counted nor listed.
  const extra = list(targets).filter((t) => checked.has(t.key) && !own.has(t.key) && !t.off);
  return { tiles, extra };
}

/** The selection moved to another scope: each ticked tile of `from` is ticked in `to` instead; the rest stays. */
export function moveScope(checked, from, to) {
  const next = new Set();
  for (const key of checked || []) {
    const runtime = SIMPLE_RUNTIMES.find((r) => key === keyIn(r, from));
    next.add(runtime ? keyIn(runtime, to) : key);
  }
  return next;
}

/**
 * The version Publish picks by default: the one asked for, else what SynaBun ships for its own skill, else the
 * latest, unless the latest was made by an agent and is not the approved one (then the approved one: the latest
 * would be refused until it is reviewed).
 * @param {{ skill?: object|null, revisions?: object[], bundled?: boolean, asked?: string|null }} o
 */
export function defaultRevisionId({ skill = null, revisions = [], bundled = false, asked = null } = {}) {
  if (asked) return asked;
  const p = skill?.pointers || {};
  if (bundled) return p.upstream || p.approved || p.latest || null;
  const latest = list(revisions).find((r) => r.revisionId === p.latest) || null;
  const agentMade = !!latest && ['assistant', 'agent'].includes(latest.author?.kind);
  if (agentMade && p.approved && p.approved !== p.latest) return p.approved;
  return p.latest || p.approved || null;
}

/** The one plain label of a version in the install path (the rest, candidate and best, stay in Versions). */
export function plainLabel(labels) {
  const l = list(labels);
  if (l.includes('approved')) return 'approved';
  if (l.includes('upstream')) return 'upstream';
  if (l.includes('latest')) return 'latest';
  return null;
}

/**
 * One line per target of a plan (sx-plan.js planModel): what will happen there, as a code. `asks` says what the
 * owner is asked before it goes (a folder to replace, the scan's findings); `notes` are secondary facts.
 */
export function planLines(model) {
  return list(model?.rows).map((row) => {
    let code = 'create';
    if (row.blocked.length) code = 'blocked';
    else if (row.state === 'identical') code = 'identical';
    else if (row.replace) code = row.replace.state === 'modified' ? 'replace-modified' : 'replace-unowned';
    else if (row.state === 'owned') code = 'replace-owned';
    return {
      targetKey: row.targetKey, runtime: row.runtime, scope: row.scope, accountId: row.accountId, projectPath: row.projectPath,
      code, destination: row.destination || null,
      blocked: row.blocked, asks: { replace: !!row.replace, scan: !!row.scanAck },
      alsoReadBy: row.affectedRuntimes.filter((r) => r !== row.runtime),
      overlap: row.overlap, transforms: row.transforms, refresh: row.refresh, name: row.name || '',
      // The runtimes whose own settings turn a skill of this name off here (the view offers "Enable for …").
      disabledFor: Object.entries(row.eligibility || {}).filter(([, e]) => e.state === 'disabled').map(([runtime, e]) => ({ runtime, reason: e.reason })),
      unknownFor: Object.entries(row.eligibility || {}).filter(([, e]) => e.state === 'unknown' && e.reason).map(([runtime, e]) => ({ runtime, reason: e.reason })),
    };
  });
}

/**
 * What an install must ask first, and nothing else: the folders to replace (not SynaBun's, or changed since) and
 * the scan findings to read; what is blocked is said, never asked; the rest goes without a question.
 * @returns {{ replace: object[], scan: object[], blocked: object[], ready: object[], decisions: object }} decisions:
 *   what the install sends when the owner confirms everything asked (sx-plan.js decisionsOf)
 */
export function confirmations(model) {
  const rows = list(model?.rows);
  const replace = rows.filter((r) => !r.blocked.length && r.replace);
  const scan = rows.filter((r) => !r.blocked.length && r.scanAck);
  const blocked = rows.filter((r) => r.blocked.length);
  const keys = { replace: replace.map((r) => r.targetKey), scan: scan.map((r) => r.targetKey) };
  return { replace, scan, blocked, ready: installableRows(model, keys), decisions: decisionsOf(model, keys) };
}

/**
 * The one button: its code and whether it can be pressed.
 * @param {{ picked: number, states?: string[], model?: object|null, checking?: boolean, busy?: boolean, error?: boolean }} o
 *   picked: how many targets are ticked; states: what each ticked target has now (targetState); model: the plan
 */
export function installButton({ picked = 0, states = [], model = null, checking = false, busy = false, error = false } = {}) {
  if (busy) return { code: 'installing', enabled: false };
  if (!picked) return { code: 'nothing', enabled: false };
  if (checking || (!model && !error)) return { code: 'checking', enabled: false };
  if (error) return { code: 'install', enabled: false };
  const rows = list(model?.rows);
  if (rows.length && rows.every((r) => r.blocked.length)) return { code: 'blocked', enabled: false };
  if (rows.length && rows.every((r) => r.blocked.length || r.state === 'identical')) return { code: 'installed', enabled: false };
  return { code: states.includes('outdated') ? 'update' : 'install', enabled: true };
}

/** An install's outcome (sx-plan.js resultModel), summed up: where it went, where it did not, how sessions pick it up. */
export function installOutcome(results) {
  const rows = list(results);
  const ok = rows.filter((r) => r.status === 'committed');
  const failed = rows.filter((r) => r.status !== 'committed');
  const refresh = [];
  for (const r of ok) for (const x of r.refresh) if (x.kind !== 'automatic' && !refresh.some((y) => y.runtime === x.runtime && y.kind === x.kind)) refresh.push({ runtime: x.runtime, kind: x.kind });
  return { ok: ok.map((r) => r.targetKey), failed: failed.map((r) => ({ targetKey: r.targetKey, status: r.status, reason: r.error || r.reasons[0]?.message || '', ...(r.code || r.reasons[0]?.code ? { code: r.code || r.reasons[0].code } : {}) })), refresh, all: rows.length > 0 && !failed.length };
}

/** A target key back as a target ({ runtime, scope, accountId, projectPath }): the words the view gives it. */
export function parseTargetKey(key) {
  const s = String(key || '');
  const at = s.indexOf(':');
  const runtime = at > 0 ? s.slice(0, at) : s;
  const rest = at > 0 ? s.slice(at + 1) : '';
  if (rest.startsWith('project:')) return { runtime, scope: 'project', projectPath: rest.slice(8), accountId: 'default' };
  return { runtime, scope: 'user', projectPath: null, accountId: rest.startsWith('user:') ? rest.slice(5) || 'default' : 'default' };
}

/**
 * Where a review's install goes, said whole, never a silent fallback: the targets the submission named that exist
 * here and are on (`missing` names each one that does not, with why: no folder for it, or the shared folder turned
 * off); when it named none, where the skill is already installed, else Claude Code for every project (`fallback`
 * says which). When it named targets and none is available, nothing (`targets` empty): the caller refuses and
 * says why, and never installs elsewhere.
 * @param {{ review?: object|null, targets: object[], skill?: object|null, row?: object|null, assistants?: string[]|null }} o targets: installTargets()
 * @returns {{ keys: Set<string>, targets: object[], named: object[], missing: { target: object, reason: 'off'|'missing' }[],
 *   fallback: 'installed'|'claude'|'assistants'|null, projects: string[] }}
 */
export function reviewDestinations({ review = null, targets = [], skill = null, row = null, assistants = null } = {}) {
  const named = list(review?.targets).filter((x) => x && typeof x.runtime === 'string');
  const projects = [...new Set(named.filter((x) => x.scope === 'project' && x.projectPath).map((x) => x.projectPath))];
  const all = list(targets);
  if (named.length) {
    const keys = new Set();
    const missing = [];
    for (const x of named) {
      const key = targetKey(x);
      const have = all.find((t) => t.key === key);
      if (have && !have.off) keys.add(key);
      else missing.push({ target: x, reason: have?.off ? 'off' : 'missing' });
    }
    return { keys, targets: all.filter((t) => keys.has(t.key)).map((t) => t.target), named, missing, fallback: null, projects };
  }
  const there = all.filter((t) => !t.off && ['installed', 'outdated', 'present'].includes(targetState(t, { skill, row }).state));
  const keys = there.length ? new Set(there.map((t) => t.key)) : defaultTargets(all, { skill, row, assistants });
  const onlyClaude = [...keys].every((k) => k === keyIn('claude', 'user'));
  return { keys, targets: all.filter((t) => keys.has(t.key)).map((t) => t.target), named, missing: [], fallback: there.length ? 'installed' : (onlyClaude ? 'claude' : 'assistants'), projects };
}
