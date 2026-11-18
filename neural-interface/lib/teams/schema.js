// ═══════════════════════════════════════════
// SynaBun — Teams: the team plan contract
// ═══════════════════════════════════════════
//
// A team is one task given to several workers at once. Its plan says how the task is cut: a pinned base commit and
// a list of slices, each with the files it owns, the slices it waits for and the agent that does it. The rules a
// plan must pass are what make working side by side safe:
//
//   - no file is owned by two slices (owned paths never overlap), so two workers never write the same file;
//   - the slices' dependencies have no cycle, so there is an order to join them in;
//   - at most one slice changes dependency lockfiles, and lockfiles belong to that slice only;
//   - there are no more slices than the user's Agent density allows (lib/agents/density.js);
//   - every owned path stays inside the project.
//
// Every slice works in its own git worktree, on its own branch, cut from the plan's base commit:
//
//   <project>/.worktrees/<team>/<slice>     branch synabun/<team>/<slice>
//   <project>/.worktrees/<team>/integration branch synabun/<team>/integration   (where finished slices are joined)
//
// The user's own checkout and branch are never a worker's (owner decision, 2026-11-15): the joined result waits on
// the integration branch for the user to merge. Worktrees live under the project's own .worktrees folder, never
// beside the project.
//
// This module is the contract only: the shape, the canonical form, what is refused, and the helpers that answer
// "who owns this file", "in what order are slices joined" and "where does this slice work". Running git, claiming
// files while work is under way (lib/coordination/store.js) and scheduling are later phases.
//
// Pure: no file, network, git or clock access. node:path only reads the text of a path.

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_AGENT_DENSITY, MAX_TEAM_WORKERS, maxWorkers, normalizeAgentDensity } from '../agents/density.js';
import { parseAgentRef } from '../agents/schema.js';

export const TEAM_PLAN_SCHEMA_VERSION = 1;
/** The folder inside a project that holds every team's worktrees. */
export const WORKTREES_DIR = '.worktrees';
/** The first part of every branch a team makes. */
export const BRANCH_PREFIX = 'synabun';
/** The slice id that is never a slice: the worktree and branch where a team's finished slices are joined. */
export const INTEGRATION_SLICE_ID = 'integration';
export const RESERVED_SLICE_IDS = Object.freeze([INTEGRATION_SLICE_ID]);

export const TEAM_LIMITS = Object.freeze({
  id: 40, title: 80, task: 16000, ownedPaths: 64, glob: 300, dependsOn: MAX_TEAM_WORKERS - 1, projectPath: 1024, agentRef: 90,
});

/**
 * Dependency lockfiles by file name, wherever they are in the tree. They belong to the plan's one lockfile owner:
 * two workers installing packages at once produce a lockfile nobody can merge.
 */
export const LOCKFILE_NAMES = Object.freeze([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'cargo.lock', 'poetry.lock', 'uv.lock', 'pdm.lock', 'pipfile.lock', 'composer.lock', 'gemfile.lock', 'go.sum',
  'mix.lock', 'pubspec.lock', 'podfile.lock', 'packages.lock.json', 'flake.lock', 'gradle.lockfile',
]);

/** Folders no slice may own: git's own data and the worktrees themselves. */
export const RESERVED_PATH_ROOTS = Object.freeze(['.git', WORKTREES_DIR]);

/**
 * The states a team and a slice move through, for the journal of lib/coordination/store.js (which stores any state
 * name and does not enforce these). `ready`: every slice is joined on the integration branch and waits for the user.
 * `creating`, `integrating` and `landing` are written before the step they name runs, so a crash in the middle of it
 * is seen (lib/teams/recovery.js). A slice is `planned` when its task is recorded, `rejected` when it changed files
 * it does not own, `conflict` when its commits do not apply on the integration branch, `tests-failed` when the test
 * command failed on the commit that joined it (lib/teams/integration.js).
 */
export const TEAM_STATES = Object.freeze(['creating', 'planned', 'running', 'integrating', 'ready', 'landing', 'merged', 'completed', 'failed', 'cancelled']);
export const SLICE_STATES = Object.freeze(['planned', 'pending', 'blocked', 'running', 'done', 'rejected', 'integrating', 'integrated', 'conflict', 'tests-failed', 'completed', 'failed', 'cancelled']);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class TeamPlanError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TeamPlanError';
    this.code = code;
    this.status = 400;
    Object.assign(this, extra);
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function pick(input, key) {
  if (has(input, key)) return input[key];
  const snake = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
  return snake !== key && has(input, snake) ? input[snake] : undefined;
}
const text = (value) => (typeof value === 'string' ? value : '');
const lower = (value) => text(value).trim().toLowerCase();
const issue = (field, code, message, extra = {}) => ({ field, code, message, ...extra });

/** Is this a team or slice id? Lower-case letters, digits and hyphens, at most 40: safe as a folder and as a branch part. */
export function isTeamSlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value);
}

// ── owned paths ──────────────────────────────────────────────────────────────
//
// An owned path is a project-relative pattern with forward slashes. `*` and `?` match inside one path segment,
// `**` (a whole segment) matches any number of segments. A pattern also owns everything beneath what it matches,
// as a git pathspec does: `src/api` owns `src/api/users.js`. Character classes, braces and negation are refused, so
// "do these two patterns share a file" always has an exact answer. Matching ignores letter case: two files whose
// names differ only in case are one file on the default macOS and Windows file systems.

/**
 * An owned path in its canonical form: `./` and doubled slashes removed, a trailing slash turned into `/**`.
 * Returns the text unchanged when it cannot be read as a pattern (`ownedPathProblem` says why).
 */
export function normalizeOwnedPath(value) {
  let glob = text(value).trim();
  if (!glob) return '';
  while (glob.startsWith('./')) glob = glob.slice(2);
  glob = glob.replace(/\/{2,}/g, '/');
  if (glob.length > 1 && glob.endsWith('/')) glob = `${glob}**`;
  glob = glob.replace(/(?:\/\*\*){2,}/g, '/**').replace(/^(?:\*\*\/){2,}/, '**/');
  return glob;
}

/**
 * Why a (normalized) owned path is refused, or null.
 * @returns {{ code: string, message: string } | null}
 */
export function ownedPathProblem(glob) {
  if (typeof glob !== 'string' || !glob) return { code: 'required', message: 'An owned path is a project-relative pattern like "src/api/**".' };
  if (glob.length > TEAM_LIMITS.glob) return { code: 'too_long', message: `An owned path is at most ${TEAM_LIMITS.glob} characters.` };
  if (CONTROL_RE.test(glob)) return { code: 'invalid_glob', message: 'An owned path has a control character.' };
  if (glob.includes('\\')) return { code: 'invalid_glob', message: 'An owned path uses forward slashes; a backslash is not allowed.' };
  if (glob.startsWith('/') || glob.startsWith('~') || /^[A-Za-z]:/.test(glob)) return { code: 'path_escape', message: `"${glob}" is not relative to the project: owned paths never leave it.` };
  const segments = glob.split('/');
  if (segments.includes('..')) return { code: 'path_escape', message: `"${glob}" climbs out of its folder with "..": owned paths never leave the project.` };
  if (segments.includes('.') || segments.includes('')) return { code: 'invalid_glob', message: `"${glob}" has an empty or "." segment.` };
  if (/[[\]{}!]/.test(glob)) return { code: 'unsupported_glob', message: `"${glob}" uses [ ], { } or !: owned paths take *, ? and ** only.` };
  if (segments.some((segment) => segment.includes('**') && segment !== '**')) return { code: 'invalid_glob', message: `"${glob}": ** stands alone between slashes.` };
  const first = segments[0].toLowerCase();
  if (RESERVED_PATH_ROOTS.includes(first)) return { code: 'reserved_path', message: `"${glob}" is inside ${segments[0]}, which no slice may own.` };
  return null;
}

/** Is this file name a dependency lockfile (LOCKFILE_NAMES, by its last segment, any letter case)? */
export function isLockfilePath(relPath) {
  const name = text(relPath).split('/').pop().toLowerCase();
  return LOCKFILE_NAMES.includes(name);
}

/** Does the pattern name a lockfile outright (its last segment is a lockfile's name)? `src/**` does not. */
function namesLockfile(glob) {
  return isLockfilePath(glob);
}

/** Do two single-segment patterns (`*`, `?`, letters) match a common name? */
function segmentsMeet(p, q) {
  const memo = new Map();
  const meet = (i, j) => {
    const key = i * (q.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let out;
    if (i === p.length && j === q.length) out = true;
    else if (i < p.length && p[i] === '*') out = meet(i + 1, j) || (j < q.length && meet(i, j + 1));
    else if (j < q.length && q[j] === '*') out = meet(i, j + 1) || (i < p.length && meet(i + 1, j));
    else if (i === p.length || j === q.length) out = false;
    else out = (p[i] === '?' || q[j] === '?' || p[i] === q[j]) && meet(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return meet(0, 0);
}

/** A pattern as segments, with the "and everything beneath" `**` at its end. */
function patternSegments(glob) {
  const segments = normalizeOwnedPath(glob).toLowerCase().split('/');
  if (segments[segments.length - 1] !== '**') segments.push('**');
  return segments;
}

/**
 * Is there a file both patterns own? Exact for the supported syntax; each pattern also owns what is beneath it.
 * `src/api/**` and `src/**\/*.test.js` overlap; `src/api/**` and `src/ui/**` do not.
 */
export function globsOverlap(a, b) {
  const x = patternSegments(a);
  const y = patternSegments(b);
  const memo = new Map();
  const meet = (i, j) => {
    const key = i * (y.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let out;
    if (i === x.length && j === y.length) out = true;
    else if (i < x.length && x[i] === '**') out = meet(i + 1, j) || (j < y.length && meet(i, j + 1));
    else if (j < y.length && y[j] === '**') out = meet(i, j + 1) || (i < x.length && meet(i + 1, j));
    else if (i === x.length || j === y.length) out = false;
    else out = segmentsMeet(x[i], y[j]) && meet(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return meet(0, 0);
}

/** A project-relative file path in the form patterns are matched against: forward slashes, no `./`. null: not inside the project. */
export function normalizeRelPath(relPath) {
  let path = text(relPath).trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || CONTROL_RE.test(path)) return null;
  const segments = path.split('/');
  if (segments.includes('..') || segments.includes('.')) return null;
  return path;
}

/** Does the pattern own this project-relative file (or a folder above it)? */
export function matchesOwnedPath(glob, relPath) {
  const path = normalizeRelPath(relPath);
  if (path === null) return false;
  // A file path is a pattern without wildcards: the same question as an overlap, with nothing beneath the file.
  const x = patternSegments(glob);
  const y = path.toLowerCase().split('/');
  const memo = new Map();
  const meet = (i, j) => {
    const key = i * (y.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let out;
    if (i === x.length) out = j === y.length;
    else if (x[i] === '**') out = meet(i + 1, j) || (j < y.length && meet(i, j + 1));
    else if (j === y.length) out = false;
    else out = segmentsMeet(x[i], y[j].replace(/[*?]/g, '\u0001')) && meet(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return meet(0, 0);
}

// ── the plan ─────────────────────────────────────────────────────────────────

function normalizeSlice(value) {
  const src = isObject(value) ? value : {};
  const owned = Array.isArray(pick(src, 'ownedPaths')) ? pick(src, 'ownedPaths') : [];
  const deps = Array.isArray(pick(src, 'dependsOn')) ? pick(src, 'dependsOn') : [];
  const agentRef = lower(pick(src, 'agentRef'));
  return {
    id: lower(pick(src, 'id')),
    title: text(pick(src, 'title')).replace(/\s+/g, ' ').trim(),
    task: text(pick(src, 'task')).replace(/\r\n?/g, '\n').trim(),
    agentRef: agentRef || null,
    ownedPaths: [...new Set(owned.filter((item) => typeof item === 'string').map(normalizeOwnedPath).filter(Boolean))],
    dependsOn: [...new Set(deps.filter((item) => typeof item === 'string').map((id) => id.trim().toLowerCase()).filter(Boolean))],
    lockfileOwner: pick(src, 'lockfileOwner') === true || pick(src, 'lockfileOwner') === 'true',
  };
}

/**
 * A plan in its canonical form: every field present, ids lower-cased, owned paths normalized, unknown keys dropped.
 * Never throws and never judges (`validateTeamPlan` does). `id` is accepted for `teamId`.
 * @returns {{ schemaVersion: number, teamId: string, projectPath: string, baseCommit: string, slices: object[] }}
 */
export function normalizeTeamPlan(input = {}) {
  const src = isObject(input) ? input : {};
  const rawPath = text(pick(src, 'projectPath')).trim();
  const slices = Array.isArray(src.slices) ? src.slices : [];
  return {
    schemaVersion: TEAM_PLAN_SCHEMA_VERSION,
    ...(src.readOnly === true || src.read_only === true ? { readOnly: true } : {}),
    teamId: lower(pick(src, 'teamId') ?? src.id),
    // Compared by its text everywhere, so kept in one form (no "a/../b", no trailing separator).
    projectPath: rawPath && isAbsolute(rawPath) ? resolve(rawPath) : rawPath,
    baseCommit: lower(pick(src, 'baseCommit')),
    slices: slices.map(normalizeSlice),
    ...(text(pick(src, 'fewerReason')).trim() ? { fewerReason: text(pick(src, 'fewerReason')).trim() } : {}),
  };
}

/** The dependency cycle a plan's slices form, as the ids along it (`['a', 'b', 'a']`), or null. Unknown ids are ignored. */
export function dependencyCycle(plan) {
  const slices = normalizeTeamPlan(plan).slices;
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const state = new Map(); // id → 1 on the path being walked, 2 finished
  const path = [];
  const walk = (id) => {
    state.set(id, 1);
    path.push(id);
    for (const dep of byId.get(id).dependsOn) {
      if (!byId.has(dep)) continue;
      if (state.get(dep) === 1) return [...path.slice(path.indexOf(dep)), dep];
      if (!state.has(dep)) { const found = walk(dep); if (found) return found; }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const slice of slices) {
    if (state.has(slice.id) || !slice.id) continue;
    const found = walk(slice.id);
    if (found) return found;
  }
  return null;
}

/**
 * Is this a plan a team may run? Structured errors, never an exception.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {string} [options.density]    the session's Agent density (lib/agents/density.js): the plan has at most
 *                                      `maxWorkers(density)` slices. Without it, and without `maxSlices`, the
 *                                      default level applies (Solo: one slice).
 * @param {number} [options.maxSlices]  the cap as a number, when the caller has already worked it out (never above
 *                                      the highest level's)
 * @returns {{ ok: boolean, errors: { field: string, code: string, message: string }[], value: object }}
 *   `field` names the place: `slices[2].ownedPaths[0]`. `value` is the normalized plan, also when `ok` is false.
 */
export function validateTeamPlan(input, { density = null, maxSlices = null } = {}) {
  const plan = normalizeTeamPlan(input);
  const errors = [];
  const add = (field, code, message, extra) => errors.push(issue(field, code, message, extra));
  if (!isObject(input)) return { ok: false, errors: [issue('', 'invalid_type', 'A team plan is an object.')], value: plan };

  // ── the team ──
  if (!plan.teamId) add('teamId', 'required', 'teamId is required: a short lower-case name like "auth-rework".');
  else if (!isTeamSlug(plan.teamId)) add('teamId', 'invalid_format', `teamId uses lower-case letters, digits and hyphens (at most ${TEAM_LIMITS.id}), and starts and ends with a letter or a digit.`);
  if (!plan.projectPath) add('projectPath', 'required', 'projectPath is required: the project folder.');
  else if (CONTROL_RE.test(plan.projectPath)) add('projectPath', 'invalid_format', 'projectPath has a control character.');
  else if (!isAbsolute(plan.projectPath)) add('projectPath', 'path_not_absolute', 'projectPath must be an absolute path.');
  else if (plan.projectPath.length > TEAM_LIMITS.projectPath) add('projectPath', 'too_long', `projectPath is at most ${TEAM_LIMITS.projectPath} characters.`);
  if (!plan.baseCommit) add('baseCommit', 'required', 'baseCommit is required: the full commit id every slice starts from.');
  else if (!COMMIT_RE.test(plan.baseCommit)) add('baseCommit', 'invalid_format', 'baseCommit is a full commit id (40 or 64 hex digits), never a branch name or a short id.');

  // ── how many ──
  if (!Array.isArray(input.slices)) add('slices', 'invalid_type', 'slices must be a list.');
  else if (!plan.slices.length) add('slices', 'required', 'A plan has at least one slice.');
  const level = density === null || density === undefined ? null : normalizeAgentDensity(density, null);
  if (density !== null && density !== undefined && level === null) add('density', 'unknown_value', `Unknown Agent density "${String(density).slice(0, 40)}".`);
  let cap = level ? maxWorkers(level) : maxWorkers(DEFAULT_AGENT_DENSITY);
  const asked = Number(maxSlices);
  if (maxSlices !== null && maxSlices !== undefined && Number.isInteger(asked) && asked >= 1) cap = Math.min(asked, level ? maxWorkers(level) : MAX_TEAM_WORKERS);
  if (plan.slices.length > cap) {
    const why = level
      ? `Agent density ${level} allows ${cap}`
      : (Number.isInteger(asked) && asked >= 1 ? `at most ${cap} are allowed` : `no Agent density was given, so ${DEFAULT_AGENT_DENSITY} applies and allows ${cap}`);
    add('slices', 'too_many_slices', `The plan has ${plan.slices.length} slices; ${why}. Use fewer slices, or one worker.`, { limit: cap, count: plan.slices.length });
  }

  // ── each slice ──
  const seen = new Map();
  const rawSlices = Array.isArray(input.slices) ? input.slices : [];
  plan.slices.forEach((slice, index) => {
    const at = `slices[${index}]`;
    const raw = rawSlices[index];
    if (!isObject(raw)) { add(at, 'invalid_type', 'A slice is an object.'); return; }
    if (!slice.id) add(`${at}.id`, 'required', 'A slice has an id: a short lower-case name like "api".');
    else if (!isTeamSlug(slice.id)) add(`${at}.id`, 'invalid_format', `A slice id uses lower-case letters, digits and hyphens (at most ${TEAM_LIMITS.id}), and starts and ends with a letter or a digit.`);
    else if (RESERVED_SLICE_IDS.includes(slice.id)) add(`${at}.id`, 'reserved', `"${slice.id}" is the name of the team's integration worktree; pick another slice id.`);
    else if (seen.has(slice.id)) add(`${at}.id`, 'duplicate', `Slice id "${slice.id}" is used twice (also slices[${seen.get(slice.id)}]).`);
    else seen.set(slice.id, index);
    if (!slice.title) add(`${at}.title`, 'required', 'A slice has a title.');
    else if (slice.title.length > TEAM_LIMITS.title) add(`${at}.title`, 'too_long', `A slice title is at most ${TEAM_LIMITS.title} characters.`);
    if (!slice.task) add(`${at}.task`, 'required', 'A slice has a task: the instructions its worker gets.');
    else if (slice.task.length > TEAM_LIMITS.task) add(`${at}.task`, 'too_long', `A slice task is at most ${TEAM_LIMITS.task} characters.`);
    else if (TEXT_CONTROL_RE.test(slice.task)) add(`${at}.task`, 'invalid_format', 'A slice task has a control character.');
    const rawRef = pick(raw, 'agentRef');
    if (rawRef !== undefined && rawRef !== null && rawRef !== '') {
      if (typeof rawRef !== 'string') add(`${at}.agentRef`, 'invalid_type', 'agentRef must be text.');
      else if (!parseAgentRef(rawRef)) add(`${at}.agentRef`, 'invalid_format', `"${rawRef.slice(0, 80)}" is not an agent ref ("<id>", "<id>@<revision>", "global:<id>", "project:<id>").`);
    }
    const rawOwned = pick(raw, 'ownedPaths');
    if ((!plan.readOnly || rawOwned != null) && (!Array.isArray(rawOwned) || rawOwned.some((item) => typeof item !== 'string'))) add(`${at}.ownedPaths`, 'invalid_type', 'ownedPaths must be a list of patterns.');
    else if (!plan.readOnly && !slice.ownedPaths.length) add(`${at}.ownedPaths`, 'required', 'A slice owns at least one path: the files only it may write.');
    if (plan.readOnly && (slice.ownedPaths.length || slice.lockfileOwner || slice.dependsOn.length)) add(at, 'read_only_slice', 'Research/review slices only read and report: no owned paths, lockfile owner or dependencies.');
    if (slice.ownedPaths.length > TEAM_LIMITS.ownedPaths) add(`${at}.ownedPaths`, 'too_many', `A slice owns at most ${TEAM_LIMITS.ownedPaths} patterns.`);
    slice.ownedPaths.forEach((glob, n) => {
      const problem = ownedPathProblem(glob);
      if (problem) add(`${at}.ownedPaths[${n}]`, problem.code, problem.message);
      else if (namesLockfile(glob) && !slice.lockfileOwner) add(`${at}.ownedPaths[${n}]`, 'lockfile_not_owner', `"${glob}" is a dependency lockfile: only the slice with lockfileOwner: true may own it.`);
    });
    const rawDeps = pick(raw, 'dependsOn');
    if (rawDeps !== undefined && rawDeps !== null && (!Array.isArray(rawDeps) || rawDeps.some((item) => typeof item !== 'string'))) add(`${at}.dependsOn`, 'invalid_type', 'dependsOn must be a list of slice ids.');
    if (slice.dependsOn.includes(slice.id) && slice.id) add(`${at}.dependsOn`, 'self_dependency', `Slice "${slice.id}" depends on itself.`);
    const rawLock = pick(raw, 'lockfileOwner');
    if (rawLock !== undefined && rawLock !== null && typeof rawLock !== 'boolean' && rawLock !== 'true' && rawLock !== 'false') add(`${at}.lockfileOwner`, 'invalid_type', 'lockfileOwner must be true or false.');
  });

  // ── between slices ──
  const ids = new Set(plan.slices.map((slice) => slice.id).filter(Boolean));
  plan.slices.forEach((slice, index) => {
    for (const dep of slice.dependsOn) {
      if (dep !== slice.id && !ids.has(dep)) add(`slices[${index}].dependsOn`, 'unknown_dependency', `Slice "${slice.id || index}" depends on "${dep}", which is not a slice of this plan.`);
    }
  });
  const cycle = dependencyCycle(plan);
  if (cycle && cycle.length > 2) add('slices', 'dependency_cycle', `The slices depend on each other in a circle: ${cycle.join(' → ')}.`, { cycle });
  const owners = plan.slices.map((slice, index) => ({ slice, index })).filter(({ slice }) => slice.lockfileOwner);
  if (owners.length > 1) {
    add('slices', 'multiple_lockfile_owners', `More than one slice is the lockfile owner (${owners.map(({ slice, index }) => slice.id || `slices[${index}]`).join(', ')}): at most one slice changes dependency lockfiles.`, { slices: owners.map(({ slice }) => slice.id) });
  }
  for (let i = 0; i < plan.slices.length; i += 1) {
    for (let j = i + 1; j < plan.slices.length; j += 1) {
      let reported = false;
      for (let m = 0; m < plan.slices[i].ownedPaths.length && !reported; m += 1) {
        const a = plan.slices[i].ownedPaths[m];
        // A pattern that names a lockfile is the lockfile owner's (checked above) and lockfiles are owned by rule,
        // whatever else covers them: it is not weighed against another slice's wider pattern.
        if (ownedPathProblem(a) || namesLockfile(a)) continue;
        for (let n = 0; n < plan.slices[j].ownedPaths.length; n += 1) {
          const b = plan.slices[j].ownedPaths[n];
          if (ownedPathProblem(b) || namesLockfile(b) || !globsOverlap(a, b)) continue;
          add(`slices[${j}].ownedPaths[${n}]`, 'overlapping_paths', `"${b}" of slice "${plan.slices[j].id || j}" overlaps "${a}" of slice "${plan.slices[i].id || i}": a file is owned by one slice only.`, { with: { slice: plan.slices[i].id, path: a } });
          reported = true;   // one finding per pair of slices is enough to act on
          break;
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, value: plan };
}

/**
 * The slice that owns a project-relative file, as its id, or null when no slice does. A dependency lockfile
 * belongs to the plan's lockfile owner and to nobody else: a slice whose pattern merely covers one (`packages/**`)
 * does not own it, and with no lockfile owner in the plan nobody may change one.
 * Meant for a valid plan (one where at most one slice matches a file).
 */
export function pathOwner(plan, relPath) {
  const value = normalizeTeamPlan(plan);
  const path = normalizeRelPath(relPath);
  if (path === null) return null;
  if (RESERVED_PATH_ROOTS.includes(path.split('/')[0].toLowerCase())) return null;
  if (isLockfilePath(path)) return value.slices.find((slice) => slice.lockfileOwner)?.id ?? null;
  for (const slice of value.slices) {
    if (slice.ownedPaths.some((glob) => !ownedPathProblem(glob) && matchesOwnedPath(glob, path))) return slice.id;
  }
  return null;
}

/**
 * The patterns a slice claims in the coordination store while it works (lib/coordination/store.js `claim`): its
 * owned paths without the ones that name a lockfile outright. Lockfiles are owned by rule (`pathOwner`), not by a
 * claim, because the lockfile owner may name one that another slice's wider pattern covers. For a valid plan the
 * claimable paths of two slices never overlap, so every slice's claim is granted.
 * @returns {string[]} empty for a slice the plan does not have
 */
export function claimablePaths(plan, sliceId) {
  const slice = normalizeTeamPlan(plan).slices.find((each) => each.id === String(sliceId ?? '').trim().toLowerCase());
  return slice ? slice.ownedPaths.filter((glob) => !ownedPathProblem(glob) && !namesLockfile(glob)) : [];
}

/**
 * The order in which finished slices are joined on the integration branch: every slice after the slices it depends
 * on, and otherwise in the order the plan lists them (so the same plan always gives the same order).
 * @returns {string[]} slice ids
 * @throws {TeamPlanError} `dependency_cycle` (with `cycle`), `unknown_dependency`
 */
export function integrationOrder(plan) {
  const slices = normalizeTeamPlan(plan).slices;
  const ids = new Set(slices.map((slice) => slice.id));
  if (ids.size !== slices.length || ids.has('')) throw new TeamPlanError('duplicate', 'Every slice needs an id of its own.');
  for (const slice of slices) {
    const missing = slice.dependsOn.find((dep) => !ids.has(dep));
    if (missing) throw new TeamPlanError('unknown_dependency', `Slice "${slice.id}" depends on "${missing}", which is not a slice of this plan.`, { slice: slice.id, dependency: missing });
  }
  const cycle = dependencyCycle({ slices });
  if (cycle) throw new TeamPlanError('dependency_cycle', `The slices depend on each other in a circle: ${cycle.join(' → ')}.`, { cycle });
  const done = new Set();
  const order = [];
  while (order.length < slices.length) {
    // The first listed slice whose dependencies are all joined already.
    const next = slices.find((slice) => !done.has(slice.id) && slice.dependsOn.every((dep) => done.has(dep)));
    done.add(next.id);
    order.push(next.id);
  }
  return order;
}

/**
 * The slices that can run now: not finished, and every slice they depend on finished.
 * @param {object} plan
 * @param {Iterable<string>} finished ids of slices whose work is done
 * @returns {string[]} slice ids, in plan order
 */
export function readySlices(plan, finished = []) {
  const done = new Set(finished);
  return normalizeTeamPlan(plan).slices
    .filter((slice) => !done.has(slice.id) && slice.dependsOn.every((dep) => done.has(dep)))
    .map((slice) => slice.id);
}

// ── where a slice works ──────────────────────────────────────────────────────

function slug(kind, value) {
  if (!isTeamSlug(value)) throw new TeamPlanError('invalid_format', `${kind} "${String(value).slice(0, 60)}" is not a lower-case name of letters, digits and hyphens.`, { field: kind });
  return value;
}
function projectRoot(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim() || !isAbsolute(projectPath.trim()) || CONTROL_RE.test(projectPath)) {
    throw new TeamPlanError('path_not_absolute', 'projectPath must be an absolute path.', { field: 'projectPath' });
  }
  return resolve(projectPath.trim());
}

/** `<project>/.worktrees`: the one folder that holds every team's worktrees of a project. */
export function worktreesRoot(projectPath) {
  return join(projectRoot(projectPath), WORKTREES_DIR);
}

/**
 * Where a slice's worktree is: always `<project>/.worktrees/<team>/<slice>`, never beside the project and never the
 * project itself. `sliceId` may be `integration` (the team's integration worktree).
 * @throws {TeamPlanError} for a relative project path, or an id that is not a plain lower-case name (so no id can
 *   climb out of the folder)
 */
export function worktreePath(projectPath, teamId, sliceId) {
  const root = projectRoot(projectPath);
  const out = join(root, WORKTREES_DIR, slug('teamId', teamId), slug('sliceId', sliceId));
  // What the ids were checked for, asked of the result itself.
  if (relative(root, out) !== join(WORKTREES_DIR, teamId, sliceId)) {
    throw new TeamPlanError('path_escape', 'A worktree path left the project\'s .worktrees folder.');
  }
  return out;
}

/** `<project>/.worktrees/<team>/integration`. */
export function integrationWorktreePath(projectPath, teamId) {
  return worktreePath(projectPath, teamId, INTEGRATION_SLICE_ID);
}

/** `synabun/<team>/<slice>`: the branch a slice's worker commits on. */
export function branchName(teamId, sliceId) {
  return `${BRANCH_PREFIX}/${slug('teamId', teamId)}/${slug('sliceId', sliceId)}`;
}

/** `synabun/<team>/integration`: where a team's finished slices are joined, for the user to merge. */
export function integrationBranchName(teamId) {
  return branchName(teamId, INTEGRATION_SLICE_ID);
}

/** `synabun/<team>/<slice>` → `{ teamId, sliceId }`, or null for any other branch (the user's own, for one). */
export function parseBranchName(branch) {
  const match = typeof branch === 'string' ? /^synabun\/([^/]+)\/([^/]+)$/.exec(branch.trim()) : null;
  return match && isTeamSlug(match[1]) && isTeamSlug(match[2]) ? { teamId: match[1], sliceId: match[2] } : null;
}

/**
 * Is this absolute path a team worktree of the project, or inside one? `{ teamId, sliceId }`, else null.
 * (What a guard asks before it lets a worker write: a worker's folder is one of these, never the project itself.)
 */
export function parseWorktreePath(projectPath, candidate) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return null;
  const rel = relative(worktreesRoot(projectPath), resolve(candidate));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const [teamId, sliceId] = rel.split(sep);
  return isTeamSlug(teamId) && isTeamSlug(sliceId) ? { teamId, sliceId } : null;
}

// The short names the phase plan uses.
export { normalizeTeamPlan as normalize, validateTeamPlan as validate };
