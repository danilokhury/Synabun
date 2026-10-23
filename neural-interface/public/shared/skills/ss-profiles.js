// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: runtime profiles
// ═══════════════════════════════════════════
//
// A skill is one folder; each runtime reads it its own way. A profile says, for one runtime or surface, which
// fields it reads, which it requires, its limits, where it looks for skills, how a skill is invoked and how a
// change reaches a running session, with the sources it was read from and how it was verified. The checks of a
// profile (lintForProfile) are separate from the Studio's editing checks (ss-lint.js): a field Claude Code reads
// may be an error in a strict upload and ignored by Codex, and each is said for the profile that sees it. Profiles
// are data with a version: a runtime that changes is a new version, never a silent edit of the old one.
//
// Invocation is kept as intent, apart from any one runtime's spelling of it: who may start the skill (the user
// by name, the model on its own), read from every dialect a folder carries (Claude Code fields, Codex's
// agents/openai.yaml, OpenCode's metadata) and compared with what a target would read from the exported bytes,
// so an install never lets a model start a skill its author kept explicit-only (invocationPlan).
//
// No DOM, no I/O: the page and the server load it; YAML is parsed by the caller.

import { findHiddenChars } from './ss-unicode.js';

export const PROFILE_SET_VERSION = '2026-10-22';

const RETRIEVED = '2026-10-21';
const SOURCES = Object.freeze({
  standard: { title: 'Agent Skills specification', url: 'https://agentskills.io/specification', retrieved: RETRIEVED },
  claude: { title: 'Claude Code skills', url: 'https://code.claude.com/docs/en/skills', retrieved: RETRIEVED },
  claudeUpload: { title: 'Claude Code: frontmatter outside Claude Code', url: 'https://code.claude.com/docs/en/skills#using-skill-frontmatter-outside-claude-code', retrieved: RETRIEVED },
  codex: { title: 'Build skills (Codex)', url: 'https://learn.chatgpt.com/docs/build-skills', retrieved: RETRIEVED },
  codexPrompts: { title: 'Codex custom prompts (deprecated)', url: 'https://learn.chatgpt.com/docs/custom-prompts', retrieved: RETRIEVED },
  opencode: { title: 'OpenCode skills', url: 'https://opencode.ai/docs/skills/', retrieved: RETRIEVED },
  opencodeCommands: { title: 'OpenCode commands', url: 'https://opencode.ai/docs/commands/', retrieved: RETRIEVED },
});

export const PORTABLE_FIELDS = Object.freeze(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
export const CLAUDE_FIELDS = Object.freeze([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable',
  'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell',
  'metadata', 'license', 'compatibility',
]);
const OPENCODE_FIELDS = Object.freeze(['name', 'description', 'license', 'compatibility', 'metadata', 'disable-model-invocation']);
const CODEX_FIELDS = Object.freeze(['name', 'description', 'metadata']);

export const PORTABLE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CODEX_SIDECAR = 'agents/openai.yaml';
const CLAUDE_BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', '1', '0']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SHELLS = new Set(['bash', 'powershell']);

/**
 * The profiles. `verified` is what was seen to work, not what a page says: the native roots of Codex and OpenCode
 * were each confirmed on 2026-10-22 by starting the installed runtime in a temporary home and listing the skills
 * it found (tests/skills-p1-native-runtimes.test.mjs repeats that check).
 */
export const PROFILES = Object.freeze({
  'portable-six-field': Object.freeze({
    id: 'portable-six-field', version: '2026-10-21', title: 'Agent Skills (portable)', runtime: 'portable', status: 'current',
    sources: [SOURCES.standard], verified: null,
    fields: { recognized: PORTABLE_FIELDS, required: ['name', 'description'], strictTopLevel: false },
    limits: { nameChars: 64, descriptionChars: 1024, compatibilityChars: 500, bodyLinesGuidance: 500, bodyTokensGuidance: 5000 },
    invocation: { model: 'not defined by the format', user: 'not defined by the format' },
    substitutions: null,
    roots: [],
    reload: null,
  }),
  'claude-code': Object.freeze({
    id: 'claude-code', version: '2026-10-21', title: 'Claude Code', runtime: 'claude', status: 'current',
    sources: [SOURCES.claude], verified: { runtime: 'claude', version: '2.1.305', method: 'documentation and CLI help; discovery not fixture-tested' },
    fields: { recognized: CLAUDE_FIELDS, required: [], strictTopLevel: false },
    limits: { nameChars: 64, descriptionChars: 1024, listingChars: 1536, compatibilityChars: 500, bodyLinesGuidance: 500, bodyTokensGuidance: 5000 },
    invocation: { model: '`disable-model-invocation: true` keeps the model from starting it', user: '`user-invocable: false` hides /name' },
    substitutions: { body: ['$ARGUMENTS', '$ARGUMENTS[N]', '$N (from 0)', '$name (declared in arguments)', '${CLAUDE_SKILL_DIR}', '${CLAUDE_PROJECT_DIR}', '${CLAUDE_SESSION_ID}', '${CLAUDE_EFFORT}'], dynamicContext: true },
    roots: [
      { scope: 'user', path: '<config dir>/skills', note: 'the account\'s CLAUDE_CONFIG_DIR, ~/.claude by default' },
      { scope: 'project', path: '<project>/.claude/skills', note: 'from the working folder up to the repository root' },
      { scope: 'managed', path: '<managed settings>/.claude/skills', note: 'read-only' },
      { scope: 'synced', path: '<config dir>/skills/synced', note: 'account skills, read-only' },
      { scope: 'plugin', path: '<plugin>/skills', note: 'namespaced /plugin:name, read-only' },
    ],
    reload: { file: 'automatic', newRoot: 'reload-skills', note: 'Claude Code watches the skill folders that existed when it started; a folder created later needs /reload-skills.' },
  }),
  'claude-upload': Object.freeze({
    id: 'claude-upload', version: '2026-10-21', title: 'Claude.ai / API upload', runtime: 'claude-cloud', status: 'export-only',
    sources: [SOURCES.claudeUpload, SOURCES.standard], verified: null,
    fields: { recognized: PORTABLE_FIELDS, required: ['name', 'description'], strictTopLevel: true },
    limits: { nameChars: 64, descriptionChars: 1024, compatibilityChars: 500, uploadBytes: null, note: 'The app\'s ZIP size limit is not published; the API takes under 30 MB uncompressed.' },
    invocation: { model: 'chosen by relevance; no Claude Code flag applies', user: 'no slash engine' },
    substitutions: null,
    roots: [],
    reload: null,
  }),
  'codex-native': Object.freeze({
    id: 'codex-native', version: '2026-10-22', title: 'Codex', runtime: 'codex', status: 'current',
    sources: [SOURCES.codex], verified: { runtime: 'codex', version: '0.163.0', method: 'isolated app-server skills/list, 2026-10-22' },
    fields: { recognized: CODEX_FIELDS, required: ['name', 'description'], strictTopLevel: false, sidecars: [CODEX_SIDECAR] },
    limits: { nameChars: 64, descriptionChars: 1024, displayNameChars: 64, shortDescriptionChars: 1024, defaultPromptChars: 1024 },
    invocation: { model: '`policy.allow_implicit_invocation: false` in agents/openai.yaml keeps the model from starting it', user: '$name or /skills; no flag hides it' },
    substitutions: { body: [], note: 'A native skill body is read as written: $ARGUMENTS is not filled.' },
    roots: [
      { scope: 'user', path: '$CODEX_HOME/skills', note: '~/.codex/skills by default (the installer\'s default); each Codex account has its own' },
      { scope: 'shared', path: '~/.agents/skills', note: 'read by Codex and OpenCode; SynaBun writes there only when the owner turned it on' },
      { scope: 'project', path: '<project>/.agents/skills', note: 'from the working folder up to the repository root' },
      { scope: 'project-compat', path: '<project>/.codex/skills', note: 'read by Codex 0.163.0; not in the guide' },
      { scope: 'system', path: '$CODEX_HOME/skills/.system', note: 'Codex\'s own, read-only' },
      { scope: 'admin', path: '/etc/codex/skills', note: 'read-only' },
    ],
    reload: { file: 'automatic', newRoot: 'automatic', config: 'restart', note: 'Codex picks up skill files by itself; a change to config.toml ([[skills.config]]) needs a restart.' },
  }),
  'opencode-native': Object.freeze({
    id: 'opencode-native', version: '2026-10-22', title: 'OpenCode', runtime: 'opencode', status: 'current',
    sources: [SOURCES.opencode], verified: { runtime: 'opencode', version: '2.0.32', method: 'isolated serve /api/skill, 2026-10-22' },
    fields: { recognized: OPENCODE_FIELDS, required: ['name', 'description'], strictTopLevel: false },
    limits: { nameChars: 64, descriptionChars: 1024, compatibilityChars: 500 },
    invocation: { model: '`metadata["opencode/autoinvoke"]: "false"` keeps it out of the model\'s list', user: '`metadata["opencode/slash"]: "true"` shows /name; the skill tool loads any skill by its exact name' },
    substitutions: { body: [], note: 'A native skill body is read as written; $ARGUMENTS and $1 belong to commands.' },
    roots: [
      { scope: 'user', path: '<config>/opencode/skills', note: 'XDG_CONFIG_HOME, ~/.config by default' },
      { scope: 'user-compat', path: '<config>/opencode/skill', note: 'the singular folder, read by OpenCode 2.0.32' },
      { scope: 'project', path: '<project>/.opencode/skills', note: '' },
      { scope: 'shared', path: '~/.agents/skills and <project>/.agents/skills', note: '' },
      { scope: 'claude-compat', path: '~/.claude/skills and <project>/.claude/skills', note: 'not read when OPENCODE_DISABLE_CLAUDE_CODE is set, as in SynaBun\'s own OpenCode panel' },
    ],
    reload: { file: 'new-session', newRoot: 'new-session', note: 'A running OpenCode may not see a new skill; start a new session (or restart the server) to be sure.' },
  }),
  'codex-prompt': Object.freeze({
    id: 'codex-prompt', version: '2026-10-21', title: 'Codex custom prompt (deprecated)', runtime: 'codex', status: 'legacy',
    sources: [SOURCES.codexPrompts], verified: null,
    fields: { recognized: ['description', 'argument-hint'], required: [], strictTopLevel: false },
    limits: {},
    invocation: { model: 'never', user: '/prompts:name' },
    substitutions: { body: ['$1-$9 (from 1)', '$ARGUMENTS', 'KEY=value', '$$'] },
    roots: [{ scope: 'user', path: '$CODEX_HOME/prompts', note: 'where SynaBun\'s old bridges were written' }],
    reload: { file: 'new-session' },
  }),
  'opencode-command': Object.freeze({
    id: 'opencode-command', version: '2026-10-21', title: 'OpenCode command', runtime: 'opencode', status: 'legacy',
    sources: [SOURCES.opencodeCommands], verified: { runtime: 'opencode', version: '2.0.32', method: 'isolated serve /api/command lists command/ and commands/, 2026-10-22' },
    fields: { recognized: ['description', 'agent', 'model', 'subtask'], required: [], strictTopLevel: false },
    limits: {},
    invocation: { model: 'never', user: '/name' },
    substitutions: { body: ['$ARGUMENTS', '$1… (from 1)', '!`command`', '@file'] },
    roots: [{ scope: 'user', path: '<config>/opencode/command and commands', note: 'command/ is where SynaBun\'s old bridges were written' }],
    reload: { file: 'new-session' },
  }),
});

/** The profile an install into a runtime is checked against. */
export const TARGET_PROFILE = Object.freeze({ claude: 'claude-code', codex: 'codex-native', opencode: 'opencode-native', agents: 'portable-six-field' });

export function getProfile(id) {
  return Object.prototype.hasOwnProperty.call(PROFILES, id) ? PROFILES[id] : null;
}

/** Every profile, as the API lists them. */
export function profileList() {
  return Object.values(PROFILES).map((p) => ({
    id: p.id, version: p.version, title: p.title, runtime: p.runtime, status: p.status, sources: p.sources, verified: p.verified,
    fields: p.fields, limits: p.limits, invocation: p.invocation, substitutions: p.substitutions, roots: p.roots, reload: p.reload,
  }));
}

// ── Reading values ──

const has = (data, key) => !!data && Object.prototype.hasOwnProperty.call(data, key);
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const kindOf = (value) => {
  if (value === undefined) return 'absent';
  if (value === null) return 'empty';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return typeof value === 'string' ? 'text' : `a ${typeof value}`;
};

/** A Claude Code boolean field as Claude Code reads it: true / false, or null when it says neither. */
export function claudeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string' && CLAUDE_BOOLEAN_WORDS.has(value.trim().toLowerCase())) return ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase());
  return null;
}

/** An OpenCode metadata switch ("true" / "false", or the YAML booleans OpenCode also takes): true / false / null. */
function openSwitch(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  return null;
}

// ── Invocation ──

/**
 * Who may start the skill, read from every dialect the folder carries. The most restrictive statement wins: one
 * "not by the model" anywhere means not by the model. `conflicts` names dialects that disagree.
 * @param {{ data: object|null, sidecar?: { data: object|null }|null }} o `data`: the SKILL.md frontmatter
 * @returns {{ user: boolean, model: boolean, slash: boolean|null, said: object, conflicts: string[] }}
 */
export function readInvocationIntent({ data, sidecar = null }) {
  const said = {};
  if (has(data, 'disable-model-invocation')) said.claudeModel = claudeBoolean(data['disable-model-invocation']) === true ? false : (claudeBoolean(data['disable-model-invocation']) === false ? true : null);
  if (has(data, 'user-invocable')) said.claudeUser = claudeBoolean(data['user-invocable']);
  const policy = isMap(sidecar?.data) && isMap(sidecar.data.policy) ? sidecar.data.policy : null;
  if (policy && has(policy, 'allow_implicit_invocation')) said.codexModel = typeof policy.allow_implicit_invocation === 'boolean' ? policy.allow_implicit_invocation : null;
  const meta = isMap(data?.metadata) ? data.metadata : null;
  if (meta && has(meta, 'opencode/autoinvoke')) said.opencodeModel = openSwitch(meta['opencode/autoinvoke']);
  if (meta && has(meta, 'opencode/slash')) said.opencodeSlash = openSwitch(meta['opencode/slash']);
  const modelSays = [said.claudeModel, said.codexModel, said.opencodeModel].filter((v) => v === true || v === false);
  const model = !modelSays.includes(false);
  const user = said.claudeUser !== false;
  const conflicts = [];
  if (modelSays.includes(false) && modelSays.includes(true)) conflicts.push('model');
  return { user, model, slash: said.opencodeSlash ?? null, said, conflicts };
}

/** Who may start the skill as one runtime reads these bytes. */
export function effectiveInvocation(profileId, { data, sidecar = null }) {
  const profile = getProfile(profileId);
  const runtime = profile?.runtime;
  if (runtime === 'claude') {
    return { model: claudeBoolean(data?.['disable-model-invocation']) !== true, user: claudeBoolean(data?.['user-invocable']) !== false };
  }
  if (runtime === 'codex') {
    const policy = isMap(sidecar?.data) && isMap(sidecar.data.policy) ? sidecar.data.policy : null;
    return { model: policy?.allow_implicit_invocation !== false, user: true };
  }
  if (runtime === 'opencode') {
    const meta = isMap(data?.metadata) ? data.metadata : null;
    // OpenCode 2.0.32 also reads Claude's disable-model-invocation, and a YAML boolean in the metadata: its
    // /api/skill answered `autoinvoke: false` for each in an isolated serve (2026-10-22).
    const claudeOff = claudeBoolean(data?.['disable-model-invocation']) === true;
    return { model: !(openSwitch(meta?.['opencode/autoinvoke']) === false || claudeOff), user: true, slash: openSwitch(meta?.['opencode/slash']) === true };
  }
  return { model: true, user: true };
}

/**
 * What an export for a target must change so the target does not start the skill more freely than its intent
 * says, and what it cannot express. Never widens: a change is only ever a restriction.
 * @returns {{ transforms: object[], diagnostics: object[] }} transforms: `{ file, op, key|path, value, reason }`
 */
export function invocationPlan(profileId, { intent, data, sidecar = null }) {
  const profile = getProfile(profileId);
  const transforms = [];
  const diagnostics = [];
  if (!profile || !intent) return { transforms, diagnostics };
  const now = effectiveInvocation(profileId, { data, sidecar });
  const runtime = profile.runtime;
  if (intent.conflicts?.includes('model')) {
    diagnostics.push({ ruleId: 'L-08-invocation-conflict', severity: 'warning', message: 'The folder says in one place that the model may start this skill and in another that it may not; the stricter one is kept.', file: 'SKILL.md', line: null });
  }
  if (!intent.model && now.model) {
    if (runtime === 'claude') transforms.push({ file: 'SKILL.md', op: 'frontmatter', key: 'disable-model-invocation', value: true, reason: 'Keeps Claude Code from starting it on its own, as the skill\'s other settings say.' });
    else if (runtime === 'codex') transforms.push({ file: CODEX_SIDECAR, op: 'sidecar', path: ['policy', 'allow_implicit_invocation'], value: false, reason: 'Keeps Codex from starting it on its own, as the skill\'s other settings say.' });
    else if (runtime === 'opencode') transforms.push({ file: 'SKILL.md', op: 'metadata', key: 'opencode/autoinvoke', value: 'false', reason: 'Keeps OpenCode\'s model list from offering it, as the skill\'s other settings say.' });
    else diagnostics.push({ ruleId: 'L-08-invocation-unrepresentable', severity: 'error', message: `${profile.title} has no way to keep the model from starting this skill.`, file: 'SKILL.md', line: null });
  }
  if (!intent.user && now.user) {
    if (runtime === 'claude') transforms.push({ file: 'SKILL.md', op: 'frontmatter', key: 'user-invocable', value: false, reason: 'Keeps /name hidden in Claude Code, as the skill\'s other settings say.' });
    else diagnostics.push({ ruleId: 'L-08-user-invocation-broader', severity: 'warning', message: `${profile.title} has no setting that hides a skill from the person: there it can still be started by name.`, file: 'SKILL.md', line: null });
  }
  return { transforms, diagnostics };
}

// ── Checks ──

/**
 * The problems of a skill for one profile.
 * @param {string} profileId
 * @param {object} o
 * @param {object} o.parsed ss-frontmatter.js parse() of the head file
 * @param {string} [o.folderName] the skill's folder
 * @param {string} [o.headPath] the head file's name as it is in the folder
 * @param {{ path: string, size?: number }[]} [o.files] every file of the folder (for the sidecar's icons)
 * @param {{ present: boolean, data: object|null, error: string|null }|null} [o.sidecar] agents/openai.yaml as read
 * @returns {{ profile: { id, version }, errors: object[], warnings: object[], infos: object[], all: object[] }}
 */
export function lintForProfile(profileId, { parsed, folderName = '', headPath = 'SKILL.md', files = [], sidecar = null } = {}) {
  const profile = getProfile(profileId);
  const all = [];
  const add = (ruleId, severity, message, line = null, file = headPath) => all.push({ ruleId, severity, message, line, file, profile: profileId });
  if (!profile) {
    add('profile-unknown', 'error', `There is no profile "${profileId}".`);
    return finish(profileId, null, all);
  }
  const lineOf = (key) => parsed?.keys?.find((k) => k.key === key)?.line ?? (parsed?.split?.startLine || 1);
  for (const d of parsed?.diagnostics || []) if (d.severity === 'error') add(`L-01-${d.ruleId || 'yaml'}`, 'error', d.message, d.line);
  const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : null;
  const strictPortable = profile.id === 'portable-six-field' || profile.id === 'claude-upload';
  const runtime = profile.runtime;

  if (profile.id === 'claude-upload' && headPath !== 'SKILL.md') add('L-03-head-name', 'error', 'An upload needs the file named SKILL.md (upper case).');
  if (!parsed?.hasFrontmatter && data) {
    if (profile.fields.required.length) add('L-02-frontmatter-missing', 'error', `${profile.title} needs frontmatter with a name and a description.`, 1);
  }
  if (!data) return finish(profileId, profile, all);

  // name
  const nameRequired = profile.fields.required.includes('name');
  if (!has(data, 'name')) {
    if (nameRequired && parsed?.hasFrontmatter) add('L-02-name-missing', 'error', `${profile.title} needs a "name".`, lineOf('name'));
  } else {
    const name = data.name;
    if (typeof name !== 'string') add('L-02-name-type', 'error', `"name" must be text; it is ${kindOf(name)}.`, lineOf('name'));
    else if (!name.trim()) add('L-02-name-empty', 'error', '"name" is empty.', lineOf('name'));
    else {
      if (name.length > (profile.limits.nameChars || 64)) add('L-03-name-length', 'error', `"name" is ${name.length} characters; ${profile.title} takes ${profile.limits.nameChars || 64}.`, lineOf('name'));
      const hidden = findHiddenChars(name, { identifier: true });
      if (hidden.length || /[<>]/.test(name)) add('L-03-name-chars', 'error', `"name" holds characters ${profile.title} refuses (${hidden.length ? hidden.map((h) => h.label).join(', ') : 'an angle bracket'}).`, lineOf('name'));
      const portableName = PORTABLE_NAME_RE.test(name);
      if (!portableName) {
        if (strictPortable || runtime === 'opencode') add('L-03-name-format', 'error', `"name" must be lowercase letters, digits and single hyphens for ${profile.title}.`, lineOf('name'));
        else add('L-03-name-format', 'warning', `"name" is not lowercase letters, digits and single hyphens: other runtimes may refuse it.`, lineOf('name'));
      }
      if (folderName && name !== folderName) {
        if (strictPortable || runtime === 'opencode') add('L-03-name-folder', 'error', `"name" is "${name}" but the folder is "${folderName}": ${profile.title} needs them equal.`, lineOf('name'));
        else add('L-03-name-folder', 'warning', `"name" is "${name}" but the folder is "${folderName}".`, lineOf('name'));
      }
    }
  }
  if (runtime === 'claude' && folderName === 'synced') add('L-03-reserved', 'error', '"synced" is the folder Claude Code keeps account skills in: a skill cannot use it.', 1);
  if (runtime === 'claude' && typeof data.name === 'string' && /^anthropic-skills(?::|$)/.test(data.name)) add('L-03-reserved', 'warning', '"anthropic-skills" is the namespace of account skills in Claude Code.', lineOf('name'));

  // description
  const descRequired = profile.fields.required.includes('description');
  if (!has(data, 'description')) {
    if (descRequired && parsed?.hasFrontmatter) add('L-02-description-missing', 'error', `${profile.title} needs a "description": it is how the skill is chosen.`, lineOf('description'));
    else if (!descRequired && runtime === 'claude') add('L-02-description-missing', 'warning', 'No "description": Claude Code falls back to the first line of the body to decide when to use it.', lineOf('description'));
  } else {
    const desc = data.description;
    if (typeof desc !== 'string') add('L-02-description-type', 'error', `"description" must be text; it is ${kindOf(desc)}.`, lineOf('description'));
    else if (!desc.trim()) add('L-02-description-empty', 'error', '"description" is empty.', lineOf('description'));
    else if (desc.length > (profile.limits.descriptionChars || 1024)) {
      add('L-03-description-length', strictPortable || runtime === 'opencode' ? 'error' : 'warning', `"description" is ${desc.length} characters; ${profile.title} takes ${profile.limits.descriptionChars || 1024}.`, lineOf('description'));
    }
    if (runtime === 'claude' && typeof desc === 'string') {
      const listed = desc.length + (typeof data.when_to_use === 'string' ? data.when_to_use.length : 0);
      if (listed > profile.limits.listingChars) add('L-09-listing-cut', 'info', `Claude Code lists the first ${profile.limits.listingChars} characters of the description and when_to_use together (${listed} here).`, lineOf('description'));
    }
    if (profile.id === 'claude-upload' && typeof desc === 'string' && desc.length > 200) add('L-09-upload-description', 'info', 'Claude.ai\'s help asks for 200 characters or fewer; whether the app enforces it is not known.', lineOf('description'));
  }

  // optional portable fields
  if (has(data, 'license') && data.license !== null && typeof data.license !== 'string') add('L-04-license-type', 'error', `"license" must be text; it is ${kindOf(data.license)}.`, lineOf('license'));
  if (has(data, 'compatibility')) {
    const c = data.compatibility;
    if (typeof c !== 'string') add('L-04-compatibility-type', 'error', `"compatibility" must be text; it is ${kindOf(c)}.`, lineOf('compatibility'));
    else if (!c.trim()) add('L-04-compatibility-empty', strictPortable ? 'error' : 'warning', '"compatibility" is empty: leave it out instead.', lineOf('compatibility'));
    else if (c.length > (profile.limits.compatibilityChars || 500)) add('L-04-compatibility-length', strictPortable ? 'error' : 'warning', `"compatibility" is ${c.length} characters; the limit is ${profile.limits.compatibilityChars || 500}.`, lineOf('compatibility'));
  }
  if (has(data, 'metadata')) {
    const meta = data.metadata;
    if (!isMap(meta)) add('L-04-metadata-type', 'error', `"metadata" must be a mapping; it is ${kindOf(meta)}.`, lineOf('metadata'));
    else {
      for (const [key, value] of Object.entries(meta)) {
        if (typeof value === 'string') continue;
        const isOpencodeSwitch = key === 'opencode/autoinvoke' || key === 'opencode/slash';
        if (runtime === 'opencode' && isOpencodeSwitch && typeof value === 'boolean') {
          add('L-04-metadata-value', 'warning', `metadata "${key}" is a YAML ${value}; OpenCode reads it, but write it as text ("${value}") so other runtimes read it too.`, lineOf('metadata'));
        } else if (strictPortable || runtime === 'opencode') {
          add('L-04-metadata-value', 'error', `metadata "${key}" must be text; it is ${kindOf(value)}.`, lineOf('metadata'));
        } else if (runtime !== 'claude') {
          add('L-04-metadata-value', 'warning', `metadata "${key}" is ${kindOf(value)}; the portable format keeps text values only.`, lineOf('metadata'));
        }
      }
      if (runtime === 'opencode') {
        for (const key of ['opencode/autoinvoke', 'opencode/slash']) {
          if (has(meta, key) && openSwitch(meta[key]) === null) add('L-04-opencode-switch', 'error', `metadata "${key}" must be "true" or "false".`, lineOf('metadata'));
        }
      }
    }
  }
  if (has(data, 'allowed-tools')) {
    const tools = data['allowed-tools'];
    const textOk = typeof tools === 'string';
    const listOk = Array.isArray(tools) && tools.every((t) => typeof t === 'string' && t.trim());
    if (!textOk && !listOk) add('L-04-allowed-tools-type', 'error', `"allowed-tools" must be text or a list of tool names; it is ${kindOf(tools)}.`, lineOf('allowed-tools'));
    else if (strictPortable && !textOk) add('L-04-allowed-tools-list', 'warning', '"allowed-tools" is a list; the portable format writes it as one space-separated text.', lineOf('allowed-tools'));
    if (runtime === 'opencode') add('L-04-ignored-key', 'info', '"allowed-tools" is not one of the fields OpenCode reads: it grants nothing there.', lineOf('allowed-tools'));
    if (runtime === 'codex') add('L-04-ignored-key', 'info', '"allowed-tools" is not read by Codex: Codex\'s own approval settings apply.', lineOf('allowed-tools'));
  }

  // Claude Code's own fields
  if (runtime === 'claude') {
    for (const key of ['disable-model-invocation', 'user-invocable', 'background']) {
      if (has(data, key) && claudeBoolean(data[key]) === null) add(`L-04-${key}-type`, 'error', `"${key}" must be true or false; it is ${kindOf(data[key])}.`, lineOf(key));
    }
    if (has(data, 'effort') && !(typeof data.effort === 'string' && EFFORTS.has(data.effort))) add('L-04-effort', 'error', `"effort" must be one of ${[...EFFORTS].join(', ')}.`, lineOf('effort'));
    if (has(data, 'shell') && !(typeof data.shell === 'string' && SHELLS.has(data.shell))) add('L-04-shell', 'error', '"shell" must be bash or powershell.', lineOf('shell'));
    if (has(data, 'context') && data.context !== 'fork') add('L-04-context', 'warning', '"context" takes one value, fork.', lineOf('context'));
    if (has(data, 'background') && data.context !== 'fork') add('L-04-background', 'warning', '"background" applies only with context: fork.', lineOf('background'));
    if (has(data, 'agent') && data.context !== 'fork') add('L-04-agent', 'warning', '"agent" applies only with context: fork.', lineOf('agent'));
    for (const key of ['paths', 'arguments', 'disallowed-tools']) {
      if (!has(data, key)) continue;
      const v = data[key];
      if (!(typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))) add(`L-04-${key}-type`, 'error', `"${key}" must be text or a list of text; it is ${kindOf(v)}.`, lineOf(key));
    }
    for (const key of ['model', 'when_to_use', 'argument-hint', 'agent']) {
      if (has(data, key) && data[key] !== null && typeof data[key] !== 'string') add(`L-04-${key}-type`, 'error', `"${key}" must be text; it is ${kindOf(data[key])}.`, lineOf(key));
    }
    if (has(data, 'hooks') && !isMap(data.hooks)) add('L-04-hooks-type', 'error', `"hooks" must be a mapping of events; it is ${kindOf(data.hooks)}.`, lineOf('hooks'));
  }

  // Keys the profile does not read
  for (const key of Object.keys(data)) {
    if (profile.fields.recognized.includes(key)) continue;
    if (profile.fields.strictTopLevel) add('L-04-upload-key', 'error', `"${key}" is not one of the six fields an upload takes: the upload is refused with it.`, lineOf(key));
    else if (strictPortable) add('L-04-unknown-key', 'warning', `"${key}" is not part of the portable format: a strict validator refuses it, other runtimes ignore it.`, lineOf(key));
    else if (runtime === 'claude') add('L-04-ignored-key', 'info', `Claude Code does not read "${key}"; it is kept as written.`, lineOf(key));
    else if (CLAUDE_FIELDS.includes(key) && key !== 'allowed-tools') add('L-04-ignored-key', 'info', `"${key}" is a Claude Code field: ${profile.title} does not read it.`, lineOf(key));
    else add('L-04-ignored-key', 'info', `${profile.title} does not read "${key}"; it is kept as written.`, lineOf(key));
  }

  if (runtime === 'codex') lintCodexSidecar(sidecar, files, add);
  return finish(profileId, profile, all);
}

/** agents/openai.yaml, as Codex reads it (interface.rs, the creator's reference): what it shows and what it allows. */
function lintCodexSidecar(sidecar, files, add) {
  if (!sidecar?.present) return;
  const file = CODEX_SIDECAR;
  if (sidecar.error) { add('L-04-sidecar-yaml', 'error', `${file} cannot be read: ${sidecar.error}`, null, file); return; }
  const doc = sidecar.data;
  if (!isMap(doc)) { add('L-04-sidecar-type', 'error', `${file} must be a mapping.`, null, file); return; }
  const paths = new Set((files || []).map((f) => f.path));
  const iface = doc.interface;
  if (iface !== undefined) {
    if (!isMap(iface)) add('L-04-sidecar-interface', 'error', '"interface" must be a mapping.', null, file);
    else {
      const text = (key, max, recommended = null) => {
        if (!has(iface, key) || iface[key] === null) return;
        const v = iface[key];
        if (typeof v !== 'string' || !v.trim()) { add(`L-04-sidecar-${key}`, 'warning', `interface.${key} must be text; Codex ignores it otherwise.`, null, file); return; }
        if (v.length > max) add(`L-04-sidecar-${key}`, 'warning', `interface.${key} is ${v.length} characters; Codex takes ${max}.`, null, file);
        else if (recommended && (v.length < recommended[0] || v.length > recommended[1])) add(`L-09-sidecar-${key}`, 'info', `interface.${key} reads best at ${recommended[0]}–${recommended[1]} characters (${v.length} here).`, null, file);
      };
      text('display_name', 64);
      text('short_description', 1024, [25, 64]);
      text('default_prompt', 1024);
      for (const key of ['icon_small', 'icon_large']) {
        if (!has(iface, key) || iface[key] === null) continue;
        const v = iface[key];
        if (typeof v !== 'string' || !v.trim()) { add(`L-05-sidecar-${key}`, 'warning', `interface.${key} must be a path in the skill.`, null, file); continue; }
        const rel = v.replace(/^\.\//, '');
        if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) { add(`L-05-sidecar-${key}`, 'error', `interface.${key} must be a path inside the skill (${v}).`, null, file); continue; }
        if (!rel.startsWith('assets/')) add(`L-05-sidecar-${key}`, 'warning', `interface.${key} should be under assets/ (${v}).`, null, file);
        if (paths.size && !paths.has(rel)) add(`L-05-sidecar-${key}`, 'error', `interface.${key} names ${v}, which the skill does not have.`, null, file);
      }
      if (has(iface, 'brand_color') && iface.brand_color !== null && !(typeof iface.brand_color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(iface.brand_color))) {
        add('L-04-sidecar-brand_color', 'warning', 'interface.brand_color must be #RRGGBB; Codex ignores it otherwise.', null, file);
      }
    }
  }
  if (doc.policy !== undefined) {
    if (!isMap(doc.policy)) add('L-04-sidecar-policy', 'error', '"policy" must be a mapping.', null, file);
    else if (has(doc.policy, 'allow_implicit_invocation') && typeof doc.policy.allow_implicit_invocation !== 'boolean') add('L-04-sidecar-policy', 'error', 'policy.allow_implicit_invocation must be true or false.', null, file);
  }
  if (doc.dependencies !== undefined) {
    const tools = isMap(doc.dependencies) ? doc.dependencies.tools : undefined;
    if (!isMap(doc.dependencies) || (tools !== undefined && !Array.isArray(tools))) add('L-04-sidecar-dependencies', 'error', 'dependencies.tools must be a list.', null, file);
    else for (const [i, t] of (tools || []).entries()) {
      if (!isMap(t) || typeof t.type !== 'string' || typeof t.value !== 'string') add('L-04-sidecar-dependencies', 'error', `dependencies.tools[${i}] needs a type and a value (text).`, null, file);
    }
    if (Array.isArray(tools) && tools.length) add('L-10-dependencies', 'info', `Declares ${tools.length} tool ${tools.length === 1 ? 'dependency' : 'dependencies'}: a declaration, not a grant; Codex asks for them as usual.`, null, file);
  }
}

function finish(profileId, profile, all) {
  const rank = { error: 0, warning: 1, info: 2 };
  all.sort((a, b) => (rank[a.severity] - rank[b.severity]) || ((a.line || 0) - (b.line || 0)));
  return {
    profile: { id: profileId, version: profile?.version || null },
    errors: all.filter((d) => d.severity === 'error'),
    warnings: all.filter((d) => d.severity === 'warning'),
    infos: all.filter((d) => d.severity === 'info'),
    all,
  };
}
