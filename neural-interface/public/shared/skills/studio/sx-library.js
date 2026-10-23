// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Library's rows
// ═══════════════════════════════════════════
//
// Every skill, agent and command a runtime can load, once each, with where it lives, who made it, its health and
// which runtimes have it. Built from what the Skills Service answers (lib/skills/api-v2.js): the catalog of every
// runtime folder (GET /catalog), the managed library (GET /skills), the service status (GET /status) and the open
// reviews (GET /reviews?open=true).
//
// One row per thing, not per path a runtime reads it through:
//   - the same folder seen through two roots (a Claude account whose folder is a link to ~/.claude) is one row;
//   - a plugin cached in several versions is one row (its copies counted);
//   - an old prompt / command bridge (~/.codex/prompts, ~/.config/opencode/command) is not a row of its own: it is
//     how that runtime reaches the skill it points to, shown in that skill's runtime column;
//   - a skill SynaBun ships is one row with its installed copies (a folder of its name in a runtime's own folder);
//   - a library skill is the row of the folder it was adopted from or installed into, else a row of its own (a
//     draft not installed anywhere yet).
// Health is a list of codes with a severity (err, warn, info, off, ok), never a colour alone: the view writes the
// words (i18n `skillsStudio.health.*`). No DOM and no imports.

export const RUNTIMES = Object.freeze(['claude', 'codex', 'opencode']);
export const SORTS = Object.freeze(['attention', 'name', 'updated', 'kind', 'source']);
export const KINDS = Object.freeze(['skill', 'agent', 'command']);
export const SOURCES = Object.freeze(['mine', 'project', 'synabun', 'plugin', 'account', 'system', 'shared', 'library']);
export const HEALTH_FILTERS = Object.freeze(['attention', 'invalid', 'warnings', 'update', 'duplicates', 'drafts', 'readonly', 'ok']);
export const VIEWS = Object.freeze(['all', 'attention', 'mine', 'synabun', 'plugins', 'account', 'drafts']);

import { revealHidden } from '../ss-unicode.js';

const SEVERITY_RANK = { err: 0, warn: 1, info: 2, off: 3, ok: 4 };
// What a row weighs when the Library is sorted by "needs attention".
const ATTENTION = { 'not-text': 1000, invalid: 1000, update: 400, shadowed: 300, twice: 300, 'same-description': 200, bridge: 150, warnings: 100, review: 80, draft: 50 };

const str = (v) => (typeof v === 'string' ? v : '');
const lower = (v) => str(v).toLowerCase();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Where an entry comes from, as the Library groups it. */
export function sourceOf(entry) {
  if (!entry) return 'library';
  if (entry.sourceKind === 'bundled' || entry.family === 'synabun') return 'synabun';
  if (entry.scope === 'plugin') return 'plugin';
  if (entry.scope === 'synced') return 'account';
  if (entry.scope === 'managed' || entry.scope === 'system' || entry.scope === 'admin') return 'system';
  if (entry.scope === 'shared') return 'shared';
  if (entry.scope === 'project') return 'project';
  return 'mine';
}

/** The kind a row is shown as: a Codex prompt and a legacy command file are commands. */
const rowKind = (entry) => (entry?.kind === 'prompt' ? 'command' : (KINDS.includes(entry?.kind) ? entry.kind : 'skill'));

/** An old bridge (a SynaBun pointer file), and the runtime it serves: { runtime, skill } or null. */
function bridgeOf(entry) {
  const b = entry?.bridge;
  if (!b || typeof b !== 'object' || typeof b.skill !== 'string' || !b.skill) return null;
  const runtime = RUNTIMES.includes(b.runtime) ? b.runtime : (entry.family === 'codex' ? 'codex' : entry.family === 'opencode' ? 'opencode' : null);
  return runtime ? { runtime, skill: b.skill } : null;
}

const problemsOf = (entry) => ({ errors: num(entry?.problems?.errors), warnings: num(entry?.problems?.warnings) });

function newRow(key, entry) {
  return {
    key,
    kind: rowKind(entry),
    name: str(entry?.name) || str(entry?.folderName),
    folderName: str(entry?.folderName) || str(entry?.name),
    description: str(entry?.description),
    invocationName: str(entry?.invocationName) || str(entry?.name),
    source: sourceOf(entry),
    scope: entry?.scope || 'library',
    pluginId: entry?.pluginId || null,
    projectLabel: entry?.projectLabel || null,
    projectPath: entry?.projectPath || null,
    path: entry?.path || null,
    primary: entry || null,
    entries: entry ? [entry] : [],
    bridges: [],
    copies: entry ? 1 : 0,
    accounts: entry?.accountId ? [entry.accountId] : [],
    skill: null,
    review: null,
    readOnly: entry ? !!entry.readOnly : false,
    binary: !!entry?.binary,
    problems: problemsOf(entry),
    collisions: Array.isArray(entry?.collisions) ? entry.collisions.slice() : [],
    update: null,
    updatedAt: entry?.updatedAt || entry?.ownership?.installedAt || null,
    sameDescriptionAs: [],
    runtimes: {},
    health: [],
    attention: 0,
  };
}

function absorb(row, entry) {
  if (!entry || row.entries.includes(entry)) return;
  row.entries.push(entry);
  if (entry.accountId && !row.accounts.includes(entry.accountId)) row.accounts.push(entry.accountId);
  for (const c of entry.collisions || []) if (!row.collisions.some((x) => x.runtime === c.runtime && x.outcome === c.outcome)) row.collisions.push(c);
  if (entry.updatedAt && (!row.updatedAt || entry.updatedAt > row.updatedAt)) row.updatedAt = entry.updatedAt;
}

const isOwnerFolder = (entry) => entry?.kind === 'skill' && !entry.readOnly && (entry.scope === 'user' || entry.scope === 'shared');

/**
 * The rows of the Library.
 * @param {object} o
 * @param {object[]} [o.entries] catalog items (GET /catalog `items`, every page)
 * @param {object[]} [o.skills] library skill summaries (GET /skills)
 * @param {object} [o.status] GET /status (updatesAvailable)
 * @param {object[]} [o.reviews] open reviews (GET /reviews?open=true)
 * @param {object} [o.upstream] bundled skill name → { revisionId, headDigest } of what this app version ships
 * @param {Record<string, string>} [o.kept] skill name → the upstream revision the owner said "Keep mine" to: no update
 *   is shown for it (no health, no banner, no older-version marks) until SynaBun ships another version
 * @returns {object[]}
 */
export function buildRows({ entries = [], skills = [], status = null, reviews = [], upstream = {}, kept = {} } = {}) {
  const rows = [];
  const byPath = new Map();
  const byPlugin = new Map();
  const bridges = [];
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object' && typeof e.id === 'string');

  for (const entry of list) {
    const bridge = bridgeOf(entry);
    if (bridge) { bridges.push({ ...bridge, entry }); continue; }
    if (entry.scope === 'plugin') {
      const key = `plugin:${entry.pluginId || ''}:${rowKind(entry)}:${lower(entry.name)}`;
      const row = byPlugin.get(key);
      if (row) { absorb(row, entry); if (!row.entries.some((x) => x !== entry && x.path === entry.path)) row.copies = new Set(row.entries.map((x) => x.path)).size; continue; }
      const created = newRow(key, entry);
      byPlugin.set(key, created);
      rows.push(created);
      continue;
    }
    const key = `path:${entry.path || entry.id}`;
    const row = byPath.get(key);
    if (row) {
      absorb(row, entry);
      // The runtimes of one folder are those of every root it is seen through.
      continue;
    }
    const created = newRow(key, entry);
    byPath.set(key, created);
    rows.push(created);
  }

  // A skill SynaBun ships takes its installed copies (a folder of its name in a runtime's own folder) into its row.
  const bundled = rows.filter((r) => r.source === 'synabun' && r.kind === 'skill');
  for (const b of bundled) {
    for (const r of rows.slice()) {
      if (r === b || r.source === 'synabun' || r.kind !== 'skill' || !r.primary || !isOwnerFolder(r.primary)) continue;
      if (lower(r.folderName) !== lower(b.folderName)) continue;
      for (const e of r.entries) absorb(b, e);
      b.installedCopies = [...(b.installedCopies || []), ...r.entries];
      rows.splice(rows.indexOf(r), 1);
    }
  }

  // Bridges: the runtime they serve, in the row of the skill they point to.
  for (const br of bridges) {
    const target = bundled.find((r) => lower(r.folderName) === lower(br.skill))
      || rows.find((r) => r.kind === 'skill' && lower(r.folderName) === lower(br.skill));
    if (target) { target.bridges.push({ runtime: br.runtime, entry: br.entry }); continue; }
    // A bridge to a skill nobody has any more: listed as what it is.
    const row = newRow(`path:${br.entry.path || br.entry.id}`, br.entry);
    row.orphanBridge = br.runtime;
    rows.push(row);
  }

  // Library skills: the row of the folder they came from or went to, else a row of their own.
  const taken = new Set();
  const skillList = (Array.isArray(skills) ? skills : []).filter((s) => s && typeof s.skillId === 'string');
  const rank = (s) => (s.origin?.kind === 'adopted' ? 0 : s.origin?.kind === 'bundled' ? 1 : 2);
  // The folders a library skill was installed into are that skill: one row, with every runtime it reaches.
  const absorbInstalled = (row, s) => {
    const dests = new Set((s.installations || []).map((i) => i.destination).filter(Boolean));
    if (!dests.size) return;
    for (const r of rows.slice()) {
      if (r === row || taken.has(r) || r.source === 'synabun' || r.kind !== 'skill' || !r.entries.length) continue;
      if (!r.entries.every((e) => dests.has(e.path))) continue;
      for (const e of r.entries) absorb(row, e);
      rows.splice(rows.indexOf(r), 1);
    }
  };
  for (const s of skillList.slice().sort((a, b) => rank(a) - rank(b))) {
    let row = null;
    if (s.origin?.kind === 'bundled') row = bundled.find((r) => lower(r.folderName) === lower(s.origin.name));
    if (!row && s.origin?.kind === 'adopted') row = rows.find((r) => r.entries.some((e) => e.id === s.origin.artifactId || (s.origin.path && e.path === s.origin.path)));
    if (!row) {
      const dests = (s.installations || []).map((i) => i.destination).filter(Boolean);
      row = rows.find((r) => r.kind === 'skill' && r.entries.some((e) => dests.includes(e.path)));
    }
    if (row && !taken.has(row)) { row.skill = s; taken.add(row); absorbInstalled(row, s); continue; }
    const own = newRow(`lib:${s.skillId}`, null);
    own.kind = 'skill';
    own.name = str(s.name);
    own.folderName = str(s.name);
    own.invocationName = str(s.name);
    own.description = str(s.description);
    own.source = 'library';
    own.scope = 'library';
    own.skill = s;
    own.updatedAt = s.updatedAt || null;
    rows.push(own);
  }

  // Updates: an installation of a bundled skill from an older revision than this app ships, or an installed copy
  // whose SKILL.md is not the shipped one (a folder from before SynaBun kept a ledger cannot say more).
  const updates = Array.isArray(status?.updatesAvailable) ? status.updatesAvailable : [];
  for (const row of rows) {
    if (row.source !== 'synabun' || row.kind !== 'skill') continue;
    const up = upstream?.[lower(row.folderName)] || null;
    const deploy = updates.filter((u) => row.skill && u.skillId === row.skill.skillId);
    const legacy = (row.installedCopies || []).filter((e) => {
      if (!up?.headDigest || typeof e.revision !== 'string') return false;
      const installedByLibrary = (row.skill?.installations || []).some((i) => i.destination === e.path);
      return !installedByLibrary && e.revision !== up.headDigest;
    });
    if (deploy.length || legacy.length) {
      const upstreamRevisionId = up?.revisionId || deploy[0]?.to || row.skill?.pointers?.upstream || null;
      // "Keep mine" for exactly this version of SynaBun's: the copy is the owner's as it is, and says nothing more.
      if (upstreamRevisionId && kept && typeof kept === 'object' && kept[row.folderName] === upstreamRevisionId) { row.keptUpdate = upstreamRevisionId; continue; }
      row.update = {
        upstreamRevisionId,
        installations: deploy.map((u) => u.installationId),
        legacyCopies: legacy.map((e) => ({ path: e.path, runtimes: e.runtimes || [], artifactId: e.id })),
        kind: deploy.length ? 'deploy' : 'legacy',
      };
    }
  }

  // Open reviews, by skill.
  const open = (Array.isArray(reviews) ? reviews : []).filter((r) => r && ['pending', 'changes_requested', 'approved', 'partial', 'publish_failed'].includes(r.state));
  for (const row of rows) {
    if (!row.skill) continue;
    row.review = open.find((r) => r.skillId === row.skill.skillId) || null;
  }

  markSameDescriptions(rows);
  for (const row of rows) finishRow(row);
  return rows;
}

/** Two rows a runtime lists with the same description: the model cannot tell them apart. */
function markSameDescriptions(rows) {
  const groups = new Map();
  for (const row of rows) {
    const d = lower(row.description).replace(/\s+/g, ' ').trim();
    if (d.length < 24 || row.source === 'synabun') continue;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(row);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const row of list) row.sameDescriptionAs = list.filter((x) => x !== row).map((x) => x.name);
  }
}

/** What each runtime has of a row: installed, outdated, an old bridge only, present (a folder it reads), or none. */
function runtimeStates(row) {
  const out = Object.fromEntries(RUNTIMES.map((r) => [r, { state: 'none', paths: [] }]));
  const installs = row.skill?.installations || [];
  // An update the owner kept their copy over ("Keep mine") marks no installation as an older version.
  const older = (i) => !!i?.updateAvailable && !row.keptUpdate;
  for (const e of row.entries) {
    if (row.source === 'synabun' && e === row.primary) continue;   // the bundled source itself is read by no runtime
    for (const r of e.runtimes || []) {
      if (!out[r]) continue;
      const byLibrary = installs.find((i) => i.destination === e.path);
      const bySynabun = !!e.ownership && e.ownership.managedBy === 'synabun';
      const next = older(byLibrary) ? 'outdated' : (byLibrary || bySynabun ? 'installed' : 'present');
      if (rankState(next) > rankState(out[r].state)) out[r].state = next;
      if (!out[r].paths.includes(e.path)) out[r].paths.push(e.path);
    }
  }
  for (const i of installs) {
    if (!out[i.runtime]) continue;
    const next = older(i) ? 'outdated' : 'installed';
    if (rankState(next) > rankState(out[i.runtime].state)) out[i.runtime].state = next;
    if (i.destination && !out[i.runtime].paths.includes(i.destination)) out[i.runtime].paths.push(i.destination);
  }
  for (const copy of row.update?.legacyCopies || []) {
    for (const r of copy.runtimes) if (out[r] && out[r].state !== 'none') out[r].state = 'outdated';
  }
  for (const b of row.bridges) {
    if (out[b.runtime] && out[b.runtime].state === 'none') { out[b.runtime].state = 'bridge'; out[b.runtime].paths.push(b.entry.path); }
  }
  return out;
}
const STATE_RANK = { none: 0, bridge: 1, present: 2, installed: 3, outdated: 4 };
const rankState = (s) => STATE_RANK[s] ?? 0;

/** The health capsule of a row: codes with a severity, worst first. */
export function healthOf(row) {
  const out = [];
  const add = (code, sev, extra = {}) => out.push({ code, sev, ...extra });
  if (row.binary) add('not-text', 'err');
  else if (row.problems.errors) add('invalid', 'err', { count: row.problems.errors });
  if (row.update) add('update', 'info');
  const shadowed = row.collisions.find((c) => c.outcome === 'shadowed');
  const twice = row.collisions.find((c) => c.outcome === 'both-listed');
  if (shadowed) add('shadowed', 'warn', { runtime: shadowed.runtime, why: str(shadowed.why) });
  else if (twice) add('twice', 'warn', { runtime: twice.runtime, why: str(twice.why) });
  if (row.sameDescriptionAs.length) add('same-description', 'warn', { names: row.sameDescriptionAs.slice(0, 3) });
  const bridgeOnly = row.bridges.filter((b) => row.runtimes[b.runtime]?.state === 'bridge');
  if (bridgeOnly.length || row.orphanBridge) add('bridge', 'warn', { runtimes: bridgeOnly.map((b) => b.runtime).concat(row.orphanBridge ? [row.orphanBridge] : []) });
  if (row.problems.warnings && !row.binary) add('warnings', 'warn', { count: row.problems.warnings });
  if (row.review) add('review', 'info', { state: row.review.state });
  const s = row.skill;
  if (s && (s.pointers?.draft || !s.revisions) && !(s.installations || []).length) add('draft', 'info');
  if (row.readOnly) add('readonly', 'off');
  if (!out.some((h) => h.sev === 'err' || h.sev === 'warn' || h.sev === 'info')) add('ok', 'ok');
  return out.sort((a, b) => SEVERITY_RANK[a.sev] - SEVERITY_RANK[b.sev]);
}

function finishRow(row) {
  // What the page shows: hidden and direction-changing characters escaped (U+202E), so a name reads as it is.
  row.label = revealHidden(row.name || row.folderName || '');
  row.shownDescription = revealHidden(row.description || '');
  row.runtimes = runtimeStates(row);
  row.health = healthOf(row);
  row.attention = row.health.reduce((n, h) => n + (ATTENTION[h.code] || 0) * (h.code === 'invalid' || h.code === 'warnings' ? Math.max(1, Math.min(9, num(h.count))) : 1), 0);
  row.needsAttention = row.attention > 0;
}

// ── Filtering, sorting, counting ──

/** Whether a row matches a health filter. */
export function healthMatches(row, health) {
  if (!health || health === 'any') return true;
  const codes = new Set(row.health.map((h) => h.code));
  switch (health) {
    case 'attention': return row.needsAttention;
    case 'invalid': return codes.has('invalid') || codes.has('not-text');
    case 'warnings': return codes.has('warnings');
    case 'update': return codes.has('update');
    case 'duplicates': return codes.has('shadowed') || codes.has('twice') || codes.has('same-description');
    case 'drafts': return codes.has('draft');
    case 'readonly': return codes.has('readonly');
    case 'ok': return codes.has('ok');
    default: return true;
  }
}

/** Whether a row belongs to a saved view of the rail (or a project: `project:<path>`). */
export function viewMatches(row, view) {
  if (!view || view === 'all') return true;
  if (view.startsWith('project:')) return row.projectPath === view.slice(8);
  switch (view) {
    case 'attention': return row.needsAttention;
    case 'mine': return row.source === 'mine' || row.source === 'project' || row.source === 'library';
    case 'synabun': return row.source === 'synabun';
    case 'plugins': return row.source === 'plugin';
    case 'account': return row.source === 'account';
    case 'drafts': return row.health.some((h) => h.code === 'draft');
    default: return true;
  }
}

/** The text a search looks in: name, description, invocation, plugin, project. */
const haystack = (row) => `${row.name} ${row.description} ${row.invocationName} ${row.pluginId || ''} ${row.projectLabel || ''}`.toLowerCase();

/**
 * @param {object[]} rows
 * @param {{ view?: string, kind?: string, source?: string, runtime?: string, health?: string, q?: string }} f
 */
export function filterRows(rows, f = {}) {
  const q = lower(f.q).trim();
  const words = q ? q.split(/\s+/) : [];
  return rows.filter((row) => viewMatches(row, f.view)
    && (!f.kind || f.kind === 'all' || row.kind === f.kind)
    && (!f.source || f.source === 'all' || row.source === f.source)
    && (!f.runtime || f.runtime === 'all' || ['installed', 'outdated', 'present', 'bridge'].includes(row.runtimes[f.runtime]?.state))
    && healthMatches(row, f.health)
    && (!words.length || words.every((w) => haystack(row).includes(w))));
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
const SOURCE_ORDER = Object.fromEntries(SOURCES.map((s, i) => [s, i]));
const KIND_ORDER = { skill: 0, agent: 1, command: 2 };

/** Rows in a sort order; ties by name. */
export function sortRows(rows, sort = 'attention') {
  const list = rows.slice();
  switch (sort) {
    case 'name': return list.sort(byName);
    case 'updated': return list.sort((a, b) => (a.updatedAt && b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) : a.updatedAt ? -1 : b.updatedAt ? 1 : 0) || byName(a, b));
    case 'kind': return list.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || byName(a, b));
    case 'source': return list.sort((a, b) => (SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]) || byName(a, b));
    default: return list.sort((a, b) => (b.attention - a.attention) || byName(a, b));
  }
}

/** How many rows each saved view, kind, source, runtime and health filter would show (for the rail and the menus). */
export function countRows(rows) {
  const count = (fn) => rows.reduce((n, r) => n + (fn(r) ? 1 : 0), 0);
  return {
    total: rows.length,
    views: Object.fromEntries(VIEWS.map((v) => [v, count((r) => viewMatches(r, v))])),
    kinds: Object.fromEntries(KINDS.map((k) => [k, count((r) => r.kind === k)])),
    sources: Object.fromEntries(SOURCES.map((s) => [s, count((r) => r.source === s)])),
    runtimes: Object.fromEntries(RUNTIMES.map((rt) => [rt, count((r) => ['installed', 'outdated', 'present', 'bridge'].includes(r.runtimes[rt]?.state))])),
    health: Object.fromEntries(HEALTH_FILTERS.map((h) => [h, count((r) => healthMatches(r, h))])),
  };
}

/** The registered projects, from the catalog's roots, with how many rows each has. */
export function projectsOf(roots = [], rows = []) {
  const seen = new Map();
  for (const root of Array.isArray(roots) ? roots : []) {
    if (root?.scope !== 'project' || typeof root.path !== 'string') continue;
    const path = typeof root.projectPath === 'string' && root.projectPath ? root.projectPath : null;
    const key = path || root.projectLabel;
    if (!key || seen.has(key)) continue;
    seen.set(key, { path: path || '', label: str(root.projectLabel) || (path ? path.split(/[\\/]/).filter(Boolean).pop() : '') });
  }
  // A root row from an older server carries no projectPath: the rows' own say which project they are in.
  for (const row of rows) {
    if (!row.projectPath) continue;
    const known = [...seen.values()].find((p) => p.path === row.projectPath || (!p.path && p.label === row.projectLabel));
    if (known) { if (!known.path) known.path = row.projectPath; continue; }
    seen.set(row.projectPath, { path: row.projectPath, label: row.projectLabel || row.projectPath.split(/[\\/]/).filter(Boolean).pop() });
  }
  return [...seen.values()].filter((p) => p.path).map((p) => ({ ...p, count: rows.filter((r) => r.projectPath === p.path).length }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/** The worst severity of a row's health (what its capsule is coloured by, next to its word). */
export const worstHealth = (row) => row.health[0] || { code: 'ok', sev: 'ok' };

/** Rows that hold a row key, in a list (bulk selection kept across redraws). */
export function keepSelection(selected, rows) {
  const keys = new Set(rows.map((r) => r.key));
  return new Set([...selected].filter((k) => keys.has(k)));
}
