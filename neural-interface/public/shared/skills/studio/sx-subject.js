// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: what a Library row opens as
// ═══════════════════════════════════════════
//
// A row of the Library (sx-library.js) opens in one workspace, in one of four modes:
//   library   a skill in SynaBun's managed library: edits go to its draft (PATCH /v2/drafts), Versions lists its
//             revisions, Publish installs one of them into the runtimes' folders (owner decision 2026-10-22:
//             runtime folders are destinations, not edited in place);
//   adopt     a skill folder of the owner's that is not in the library yet: it opens as it is on disk, and the
//             first save takes the folder into the library (POST /v2/skills { artifactId }) with the edit as its
//             draft, so it reaches the folder again only through Publish;
//   inplace   an agent or a command (one file): the library holds skill folders only, so it is saved where it is,
//             over the revision it was opened at (the P0 routes: PUT /api/skills-studio/artifact/:id);
//   readonly  what SynaBun does not write: a skill it ships, a plugin's, a Claude account's, a runtime's own
//             (Codex system skills, managed settings), a folder no route can reach. A skill can be copied into the
//             library ("Customize a copy").
// Also here: the P0 artifact id of an entry (when those routes can reach it), and the install targets a skill can
// be published to, read from the catalog's roots. No DOM; imports only ss-ids.js.

import { encodeArtifactId } from '../ss-ids.js';

const READ_ONLY_REASON = { synabun: 'bundled', plugin: 'plugin', account: 'account', system: 'system', shared: 'shared' };

/**
 * The artifact id the P0 routes (/api/skills-studio/artifact/:id) take for an entry, encoded, or null when they
 * cannot reach it: they read Claude Code's own folders only (~/.claude/skills|commands|agents of the default
 * account, a registered project's .claude/…), and the bundled source.
 */
export function v1IdFor(entry) {
  if (!entry || typeof entry.path !== 'string' || !entry.path) return null;
  const kind = entry.kind;
  if (!['skill', 'command', 'agent'].includes(kind)) return null;
  const bundled = entry.sourceKind === 'bundled' || entry.family === 'synabun';
  const claudeOwn = entry.family === 'claude' && entry.sourceKind === 'native'
    && (entry.scope === 'project' || (entry.scope === 'user' && (!entry.accountId || entry.accountId === 'default')));
  if (!bundled && !claudeOwn) return null;
  if (bundled && kind !== 'skill') return null;
  return encodeArtifactId(`${kind}:${entry.path}`);
}

/** The entry of a row the P0 routes reach, when one of its locations is such (an account's link, a project's own). */
function addressableEntry(row) {
  for (const e of [row.primary, ...(row.entries || [])]) if (e && v1IdFor(e)) return e;
  return null;
}

/**
 * What a row opens as.
 * @param {object} row a row of sx-library.js buildRows()
 * @param {{ guest?: boolean, caps?: Set<string> }} [o] caps: the service's capabilities (GET /v2/capabilities)
 * @returns {{ mode: 'library'|'adopt'|'inplace'|'readonly', editable: boolean, reason: string|null,
 *   canCustomize: boolean, canAdopt: boolean, canPublish: boolean, hasVersions: boolean, v1Id: string|null,
 *   artifactId: string|null, skillId: string|null, readsFiles: 'library'|'v1'|'catalog'|'head' }}
 */
export function subjectOf(row, { guest = false, caps = new Set() } = {}) {
  const entry = row?.primary || null;
  const skill = row?.skill || null;
  const v1Entry = addressableEntry(row || {});
  const v1Id = v1Entry ? v1IdFor(v1Entry) : null;
  const catalogFiles = caps.has('catalog-file');
  const out = {
    mode: 'readonly', editable: false, reason: null, canCustomize: false, canAdopt: false, canPublish: false, hasVersions: false,
    v1Id, artifactId: entry?.id || null, skillId: skill?.skillId || null,
    readsFiles: v1Id ? 'v1' : catalogFiles ? 'catalog' : 'head',
  };
  if (!row) return out;
  if (skill && row.source !== 'synabun') {
    out.mode = 'library';
    out.readsFiles = 'library';
    out.hasVersions = true;
    out.canPublish = !guest;
    out.editable = !guest;
    if (guest) out.reason = 'guest';
    return out;
  }
  if (row.source === 'synabun') {
    // What SynaBun ships: its library copy holds the versions (`upstream`); it is installed, never edited.
    out.mode = 'readonly';
    out.reason = 'bundled';
    out.readsFiles = skill ? 'library' : out.readsFiles;
    out.hasVersions = !!skill;
    out.canPublish = !!skill && !guest;
    out.canCustomize = !guest && row.kind === 'skill';
    return out;
  }
  if (row.binary) {
    out.reason = 'not-text';
    out.canAdopt = false;
    return out;
  }
  if (row.kind === 'skill') {
    if (!row.readOnly && entry && (entry.scope === 'user' || entry.scope === 'project')) {
      out.mode = 'adopt';
      out.editable = !guest;
      out.canAdopt = !guest;
      out.reason = guest ? 'guest' : null;
      return out;
    }
    out.reason = guest ? 'guest' : (READ_ONLY_REASON[row.source] || 'not-writable');
    out.canCustomize = !guest && (out.readsFiles !== 'head');
    return out;
  }
  // An agent or a command: saved where it is, through the routes that reach it.
  if (!row.readOnly && v1Id) {
    out.mode = 'inplace';
    out.editable = !guest;
    out.reason = guest ? 'guest' : null;
    return out;
  }
  out.reason = guest ? 'guest' : (READ_ONLY_REASON[row.source] || (row.readOnly ? 'not-writable' : 'not-addressable'));
  return out;
}

// ── Install targets ──

/** The key an install plan gives a target (lib/skills/deploy.js normalizeTarget). */
export function targetKey(t) {
  const scope = t?.scope === 'project' ? 'project' : 'user';
  return scope === 'project' ? `${t.runtime}:project:${t.projectPath}` : `${t.runtime}:user:${t?.accountId || 'default'}`;
}

/** A target as a request names it: only the fields a target has. */
export function wholeTarget(t) {
  const out = { runtime: t.runtime };
  if (t.scope === 'project') { out.scope = 'project'; out.projectPath = t.projectPath; } else out.scope = 'user';
  if (t.accountId && t.accountId !== 'default') out.accountId = t.accountId;
  return out;
}

/** The keys of a list of targets, each once, sorted: a selection as it can be compared with another. */
export const selectionKeys = (targets) => [...new Set((Array.isArray(targets) ? targets : []).map(targetKey))].sort();

/**
 * Whether two asks of Publish are the same: one revision and exactly the same targets. A plan answers only what it
 * was asked for: shown or installed for anything else (another version picked, a target ticked meanwhile), it would
 * install what the owner no longer sees.
 * @param {{ revisionId: string|null, targets: object[] }|null} a @param {{ revisionId: string|null, targets: object[] }|null} b
 */
export function sameAsk(a, b) {
  if (!a || !b || !a.revisionId || a.revisionId !== b.revisionId) return false;
  const x = selectionKeys(a.targets); const y = selectionKeys(b.targets);
  return x.length > 0 && x.length === y.length && x.every((k, i) => k === y[i]);
}

const RUNTIME_OF_FAMILY = { claude: 'claude', codex: 'codex', opencode: 'opencode', shared: 'agents' };

/**
 * The targets a skill can be installed into: each runtime's own skills folder for each account, the shared
 * ~/.agents/skills (only while the owner turned it on), and the folders of the projects asked for.
 * @param {object} o
 * @param {object[]} [o.roots] the catalog's roots (GET /catalog `roots`)
 * @param {{ sharedAgentsRoot?: boolean }} [o.config]
 * @param {{ path: string, label: string }[]} [o.projects] projects to offer targets for
 * @returns {{ key, target, runtime, scope, accountId, projectPath, projectLabel, path, status, policy, shared }[]}
 */
export function installTargets({ roots = [], config = {}, projects = [] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (t) => { if (seen.has(t.key)) return; seen.add(t.key); out.push(t); };
  for (const root of Array.isArray(roots) ? roots : []) {
    if (root?.kind !== 'skills' || !RUNTIME_OF_FAMILY[root.family]) continue;
    if (root.sourceKind !== 'native' && root.sourceKind !== 'shared') continue;
    const write = root.policy?.write;
    if (write !== 'owner' && write !== 'owner-opt-in') continue;
    const runtime = RUNTIME_OF_FAMILY[root.family];
    if (root.scope === 'project') continue;   // projects come from `projects`, one row per runtime
    const accountId = root.accountId || 'default';
    const target = { runtime, scope: 'user', ...(accountId !== 'default' ? { accountId } : {}) };
    push({ key: targetKey(target), target, runtime, scope: 'user', accountId, projectPath: null, projectLabel: null, path: root.path, status: root.status, policy: root.policy || null, shared: runtime === 'agents', off: runtime === 'agents' && !config.sharedAgentsRoot });
  }
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p?.path) continue;
    for (const runtime of ['claude', 'codex', 'opencode']) {
      const target = { runtime, scope: 'project', projectPath: p.path };
      const sub = runtime === 'claude' ? '.claude/skills' : runtime === 'codex' ? '.agents/skills' : '.opencode/skills';
      push({ key: targetKey(target), target, runtime, scope: 'project', accountId: 'default', projectPath: p.path, projectLabel: p.label || p.path, path: `${p.path.replace(/[\\/]+$/, '')}/${sub}`, status: null, policy: null, shared: false, off: false });
    }
  }
  const order = { claude: 0, codex: 1, opencode: 2, agents: 3 };
  return out.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'user' ? -1 : 1) || (a.projectLabel || '').localeCompare(b.projectLabel || '') || (order[a.runtime] - order[b.runtime]) || a.accountId.localeCompare(b.accountId));
}

/**
 * What a target has of a skill now: an installation of the library (current or older than the revision shown), a
 * folder of its name SynaBun did not install, an old bridge, or nothing.
 * @param {object} t a target of installTargets()
 * @param {object} o
 * @param {object|null} o.skill the library skill (GET /skills summary)
 * @param {object|null} o.row its Library row
 * @param {string|null} [o.revisionId] the revision the Publish tab shows
 */
export function targetState(t, { skill = null, row = null, revisionId = null } = {}) {
  const install = (skill?.installations || []).find((i) => i.runtime === t.runtime && (i.scope || 'user') === t.scope
    && (t.scope === 'project' ? i.projectPath === t.projectPath : (i.accountId || 'default') === t.accountId));
  if (install) {
    const current = revisionId ? install.sourceRevisionId === revisionId : !install.updateAvailable;
    return { state: current ? 'installed' : 'outdated', installation: install, path: install.destination };
  }
  const name = row?.folderName || skill?.name || '';
  const inFolder = (row?.entries || []).find((e) => e.kind === 'skill' && e.path && t.path && e.path.startsWith(`${t.path.replace(/[\\/]+$/, '')}/`) && e.path.slice(t.path.replace(/[\\/]+$/, '').length + 1) === name);
  if (inFolder) return { state: 'present', installation: null, path: inFolder.path };
  const bridge = (row?.bridges || []).find((b) => b.runtime === t.runtime && t.scope === 'user');
  if (bridge) return { state: 'bridge', installation: null, path: bridge.entry?.path || null };
  return { state: 'none', installation: null, path: null };
}

/** Targets checked to start with: where the skill is already, else Claude Code for the default account. */
export function defaultTargets(targets, { skill = null, row = null } = {}) {
  const there = targets.filter((t) => !t.off && ['installed', 'outdated', 'present'].includes(targetState(t, { skill, row }).state));
  if (there.length) return new Set(there.map((t) => t.key));
  const claude = targets.find((t) => t.runtime === 'claude' && t.scope === 'user' && t.accountId === 'default');
  return new Set(claude ? [claude.key] : []);
}
