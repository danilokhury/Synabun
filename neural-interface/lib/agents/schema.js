// ═══════════════════════════════════════════
// SynaBun — Agents: the AgentDefinition contract
// ═══════════════════════════════════════════
//
// An agent is a named, reviewed way to launch a worker: who it is (name, description, instructions), what it runs
// on (provider, model, effort, account), what it may touch (tools, MCP servers, capability, permission policy,
// browser, computer, MoreLogin profile, skills), where it applies (the global library or one project) and what it
// is for (task classes, memory category). A definition is kept as revisions, like a skill of the library
// (lib/skills/library.js, reviews.js): a draft is edited, sent to review, and only an approval makes it something a
// run may use. An approved revision is never edited; a change is a new draft on top of it.
//
//   draft ──► in_review ──► approved ──► withdrawn
//     │           ├──► draft      (changes requested: back to the editor)
//     │           └──► withdrawn
//     └──► withdrawn
//
// This module is the contract only: the shape, the canonical form (normalize), what is refused (validate), what is
// merely worth a second look (lint), the revision rules and the fields a dispatch takes from a definition. The
// registry that stores definitions, the resolver that turns an `agent_ref` into a run and the page are later
// phases; they import this file and never keep a second copy of these rules.
//
// Pure: no file, network or clock access (callers pass the time). node:crypto only hashes, node:path only reads
// the text of a path. Which tool groups exist, which are gated and which drive the browser is the tool catalog's
// to say (mcp-server tool-catalog.ts, read through the same resolver a dispatch uses): no list of groups is kept here.

import { createHash } from 'node:crypto';
import { isAbsolute, normalize as normalizePath, sep } from 'node:path';
import { DEFAULT_TOOLS, isBrowserGroup } from '../../../mcp-server/dist/services/tool-catalog.js';
import { resolveToolList } from '../../../mcp-server/dist/services/tool-list.js';

export const AGENT_SCHEMA_VERSION = 1;

/** Worker runtimes (assistant-config.js ROUTE_PROVIDERS; tests/agents-schema.test.mjs checks they stay equal). */
export const AGENT_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode', 'antigravity']);
/** The providers whose runs name an account (assistant-config.js ROUTE_ACCOUNT_PROVIDERS). */
export const AGENT_ACCOUNT_PROVIDERS = Object.freeze(['claude-code', 'codex']);
/** Lowest authority first (lib/worker-confinement.js says what each one means). */
export const AGENT_CAPABILITIES = Object.freeze(['read-only', 'workspace', 'full']);
export const AGENT_PERMISSION_POLICIES = Object.freeze(['auto', 'ask', 'restricted']);
/** The Assistant's task classes (assistant-router.js TASK_CLASSES; checked equal by the test). */
export const AGENT_TASK_CLASSES = Object.freeze(['chat', 'quick', 'code', 'complex', 'review', 'research', 'browser', 'computer', 'automation', 'design', 'image_gen', 'video_gen']);
export const AGENT_STATUSES = Object.freeze(['draft', 'in_review', 'approved', 'withdrawn']);
export const AGENT_SCOPE_KINDS = Object.freeze(['global', 'project']);
/** Who made a revision (lib/skills/library.js AUTHOR_KINDS). Only the owner approves. */
export const AGENT_AUTHOR_KINDS = Object.freeze(['owner', 'assistant', 'agent', 'system']);

/** Ids an agent cannot have: words an `agent_ref` or a menu already uses for something else. */
export const RESERVED_AGENT_IDS = Object.freeze(['all', 'assistant', 'auto', 'default', 'global', 'me', 'new', 'none', 'project', 'synabun']);

export const AGENT_LIMITS = Object.freeze({
  id: 64, name: 80, description: 400, instructions: 16000, model: 200, effort: 40, accountId: 64,
  mcpServers: 32, mcpServerName: 64, skills: 32, skillRef: 129, taskClasses: 12,
  moreloginProfile: 200, memoryCategory: 64, icon: 40, color: 81, projectPath: 1024, authorRef: 200,
});
/** Instructions longer than this are a lint warning: every run of the agent pays for them. */
export const LONG_INSTRUCTIONS_CHARS = 6000;

/** The fields that say what an agent is. The etag is their digest; everything else is revision metadata. */
export const AGENT_CONTENT_FIELDS = Object.freeze([
  'id', 'name', 'description', 'instructions', 'provider', 'model', 'effort', 'accountId', 'tools', 'mcpServers',
  'capability', 'permissionPolicy', 'usesBrowser', 'usesComputer', 'moreloginProfile', 'skills', 'scope',
  'memoryCategory', 'taskClasses', 'icon', 'color',
]);
export const AGENT_META_FIELDS = Object.freeze(['schemaVersion', 'revision', 'parentRevision', 'status', 'author', 'createdAt', 'approvedAt', 'etag']);

/** What a field holds when a definition does not say. `capability` is `workspace`, not the dispatcher's `full`: an agent that is not guarded says so. */
export const AGENT_DEFAULTS = Object.freeze({
  model: null, effort: null, accountId: null, tools: null, mcpServers: Object.freeze([]), capability: 'workspace',
  permissionPolicy: 'auto', usesBrowser: false, usesComputer: false, moreloginProfile: null, skills: Object.freeze([]),
  scope: Object.freeze({ kind: 'global' }), memoryCategory: null, taskClasses: Object.freeze([]), icon: null, color: null,
});

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ACCOUNT_RE = /^[a-z0-9-]{1,64}$/;
const SKILL_RE = /^(?:skl_[0-9a-f]{20}|[a-z0-9][a-z0-9-]{0,63}(?::[a-z0-9][a-z0-9-]{0,63})?)$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ICON_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A style-guide token: "{group.key}" or "group.key" (lib/style-guide/schema.js parseAlias). */
const TOKEN_RE = /^([A-Za-z0-9-]{1,40})\.([A-Za-z0-9-]{1,40})$/;
const RAW_COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(.*\)|var\s*\(.*\)|--[\w-]+)$/i;
const ETAG_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const AUTO_WORDS = new Set(['', 'auto', 'default']);
// Control characters other than tab, line feed and carriage return: never part of a name or of instructions.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const LINE_CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class AgentSchemaError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AgentSchemaError';
    this.code = code;
    this.status = 400;
    Object.assign(this, extra);
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
/** A field under either spelling: `permissionPolicy` or `permission_policy` (the MCP tools use the second). */
function pick(input, key) {
  if (has(input, key)) return input[key];
  const snake = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
  return snake !== key && has(input, snake) ? input[snake] : undefined;
}
const text = (value) => (typeof value === 'string' ? value : '');
const oneLine = (value) => text(value).replace(/\s+/g, ' ').trim();
const lower = (value) => text(value).trim().toLowerCase();
function uniqueSorted(values) { return [...new Set(values)].sort(); }
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}
function bool(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return typeof value === 'string' ? value.trim() : null;
}

/** "{primary.500}" / "primary.500" → "primary.500"; anything else as written (validate refuses it). */
function normalizeColor(value) {
  const raw = text(value).trim();
  if (!raw) return null;
  const bare = raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1).trim() : raw;
  return TOKEN_RE.test(bare) ? bare : raw;
}

function normalizeScope(value) {
  if (!isObject(value)) return { kind: 'global' };
  const kind = lower(value.kind);
  if (kind !== 'project') return { kind: AGENT_SCOPE_KINDS.includes(kind) ? kind : 'global' };
  const raw = text(value.path).trim();
  // A path is compared by its text, so it is kept in one form: no "a/../b", no doubled or trailing separator.
  let path = raw && isAbsolute(raw) ? normalizePath(raw) : raw;
  while (path.length > 1 && path.endsWith(sep) && !/^[A-Za-z]:\\$/.test(path)) path = path.slice(0, -1);
  return { kind: 'project', path };
}

function normalizeAuthor(value) {
  const kind = isObject(value) ? lower(value.kind) : lower(value);
  const ref = isObject(value) && typeof value.ref === 'string' && value.ref.trim() ? value.ref.trim().slice(0, AGENT_LIMITS.authorRef) : null;
  return { kind: AGENT_AUTHOR_KINDS.includes(kind) ? kind : 'owner', ref };
}

/** The list a dispatch of this definition names: its groups, then `mcp:<name>` for each MCP server. */
function dispatchToolItems(def) {
  return [...(def.tools || []).filter((id) => !id.startsWith('mcp:')), ...def.mcpServers.map((name) => `mcp:${name}`)];
}
/**
 * The tool groups a definition names, as the catalog reads them (`all` is every selectable group). Empty when it
 * names none, and when the list is one the catalog refuses (validate says why).
 */
function namedGroups(def) {
  if (!def.tools) return [];
  const read = resolveToolList(def.tools.filter((id) => !id.startsWith('mcp:')), { source: 'runtime' });
  return read.ok ? read.groups : [];
}
/** Does the definition drive the SynaBun browser: by its switch, or by a browser group it names? */
function usesBrowserTools(def) {
  return def.usesBrowser || namedGroups(def).some(isBrowserGroup);
}
const TOOL_PROBLEM_CODES = Object.freeze({ unknown: 'unknown_tool', gated: 'gated_tool', 'too-long': 'too_long', 'too-many': 'too_many', 'non-selectable': 'invalid_format', 'not-a-string': 'invalid_type' });

/**
 * A definition in its one canonical form: every field present, spellings folded (`uses_browser`, "Read-Only",
 * "{primary.500}", `mcp:name`), lists de-duplicated and sorted, unknown keys dropped. Never throws and never
 * judges: a value that cannot be what its field holds is kept as written when it is text (so `validate` can name
 * it) and replaced by the default otherwise. The etag is recomputed from the content, never taken from the input.
 * @param {object} [input]
 * @returns {object} an AgentDefinition (see the README for the field list)
 */
export function normalizeAgentDefinition(input = {}) {
  const src = isObject(input) ? input : {};
  const provider = lower(pick(src, 'provider')) || null;
  const model = text(pick(src, 'model')).trim();
  const effort = lower(pick(src, 'effort'));
  const accountId = lower(pick(src, 'accountId'));
  const rawTools = pick(src, 'tools');
  const servers = stringList(pick(src, 'mcpServers')).map((name) => (name.toLowerCase().startsWith('mcp:') ? name.slice(4).trim() : name)).filter(Boolean);
  const moreloginProfile = text(pick(src, 'moreloginProfile')).trim();
  const memoryCategory = lower(pick(src, 'memoryCategory'));
  const icon = lower(pick(src, 'icon'));
  const content = {
    id: lower(pick(src, 'id')),
    name: oneLine(pick(src, 'name')),
    description: oneLine(pick(src, 'description')),
    instructions: text(pick(src, 'instructions')).replace(/\r\n?/g, '\n').trim(),
    provider,
    model: model && !AUTO_WORDS.has(model.toLowerCase()) ? model : null,
    effort: effort && !AUTO_WORDS.has(effort) ? effort : null,
    accountId: accountId && accountId !== 'default' ? accountId : null,
    // null: the worker's default tools (as a dispatch with no `tools`); []: the always-on tools only.
    tools: Array.isArray(rawTools) ? uniqueSorted(stringList(rawTools).map((id) => id.toLowerCase())) : null,
    mcpServers: servers.includes('*') ? ['*'] : uniqueSorted(servers),
    capability: lower(pick(src, 'capability')).replace(/_/g, '-') || AGENT_DEFAULTS.capability,
    permissionPolicy: lower(pick(src, 'permissionPolicy')) || AGENT_DEFAULTS.permissionPolicy,
    usesBrowser: bool(pick(src, 'usesBrowser'), false),
    usesComputer: bool(pick(src, 'usesComputer'), false),
    moreloginProfile: moreloginProfile || null,
    skills: uniqueSorted(stringList(pick(src, 'skills')).map((ref) => ref.toLowerCase())),
    scope: normalizeScope(pick(src, 'scope')),
    memoryCategory: memoryCategory || null,
    taskClasses: uniqueSorted(stringList(pick(src, 'taskClasses')).map((cls) => cls.toLowerCase().replace(/-/g, '_'))),
    icon: icon || null,
    color: normalizeColor(pick(src, 'color')),
  };
  const revision = Number(pick(src, 'revision'));
  const parent = Number(pick(src, 'parentRevision'));
  const status = lower(pick(src, 'status')).replace(/-/g, '_');
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    ...content,
    revision: Number.isInteger(revision) && revision >= 1 ? revision : 1,
    parentRevision: Number.isInteger(parent) && parent >= 1 ? parent : null,
    status: status || 'draft',
    author: normalizeAuthor(pick(src, 'author')),
    createdAt: isoOrNull(pick(src, 'createdAt')),
    approvedAt: isoOrNull(pick(src, 'approvedAt')),
    etag: computeEtag(content),
  };
}

/** The content fields of a definition, in their fixed order (what the etag covers and what a review compares). */
export function contentOf(definition = {}) {
  const out = {};
  for (const field of AGENT_CONTENT_FIELDS) out[field] = definition[field] === undefined ? null : definition[field];
  return out;
}

/**
 * The digest of a definition's content, `sha256:<64 hex>`. Two definitions with one etag run the same agent; the
 * revision number, status, dates and author are not part of it. An approval belongs to the etag it was given for.
 * Give it a normalized definition (or its `contentOf`).
 */
export function computeEtag(definition = {}) {
  const content = contentOf(definition);
  const scope = isObject(content.scope) ? content.scope : { kind: 'global' };
  // Keys are written in a fixed order so the digest never depends on how an object was built.
  const canonical = AGENT_CONTENT_FIELDS.map((field) => [field, field === 'scope'
    ? (scope.kind === 'project' ? { kind: 'project', path: scope.path ?? '' } : { kind: scope.kind ?? 'global' })
    : content[field]]);
  return `sha256:${createHash('sha256').update(JSON.stringify([AGENT_SCHEMA_VERSION, canonical])).digest('hex')}`;
}

const issue = (field, code, message) => ({ field, code, message });

function typeProblems(src) {
  const out = [];
  const want = (key, kind, test) => {
    const value = pick(src, key);
    if (value === undefined || value === null) return;
    if (!test(value)) out.push(issue(key, 'invalid_type', `${key} must be ${kind}.`));
  };
  const isString = (v) => typeof v === 'string';
  const isBool = (v) => v === true || v === false || v === 'true' || v === 'false';
  const isStrings = (v) => Array.isArray(v) && v.every(isString);
  for (const key of ['id', 'name', 'description', 'instructions', 'provider', 'model', 'effort', 'accountId', 'capability', 'permissionPolicy', 'moreloginProfile', 'memoryCategory', 'icon', 'color', 'status']) want(key, 'text', isString);
  for (const key of ['usesBrowser', 'usesComputer']) want(key, 'true or false', isBool);
  for (const key of ['tools', 'mcpServers', 'skills', 'taskClasses']) want(key, 'a list of text items', isStrings);
  want('scope', 'an object like { kind: "global" } or { kind: "project", path }', isObject);
  want('revision', 'a whole number from 1', (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && typeof v !== 'boolean');
  want('parentRevision', 'a whole number from 1', (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && typeof v !== 'boolean');
  return out;
}

/**
 * Is this a definition SynaBun may keep and run? Structured errors, never an exception.
 *
 * @param {object} input a definition in any accepted spelling (it is normalized first)
 * @param {object} [options]
 * @param {Iterable<string>} [options.knownMcpServers]  the MCP servers that exist: a name outside it is `unknown_mcp_server`
 * @param {boolean} [options.requireMeta]               a stored revision: `createdAt` is required and `etag`, when the input carries one, must match the content
 * @returns {{ ok: boolean, errors: { field: string, code: string, message: string }[], value: object }}
 *   `value` is the normalized definition (also when `ok` is false, so a form can show it).
 */
export function validateAgentDefinition(input, { knownMcpServers = null, requireMeta = false } = {}) {
  if (!isObject(input)) {
    return { ok: false, errors: [issue('', 'invalid_type', 'An agent definition is an object.')], value: normalizeAgentDefinition({}) };
  }
  const errors = typeProblems(input);
  const typed = new Set(errors.map((error) => error.field));
  const def = normalizeAgentDefinition(input);
  const add = (field, code, message) => { if (!typed.has(field)) errors.push(issue(field, code, message)); };
  const tooLong = (field, value, max) => { if (typeof value === 'string' && value.length > max) add(field, 'too_long', `${field} is at most ${max} characters.`); };

  // ── identity ──
  if (!def.id) add('id', 'required', 'id is required: a lower-case name like "release-notes".');
  else if (def.id.length > AGENT_LIMITS.id) add('id', 'too_long', `id is at most ${AGENT_LIMITS.id} characters.`);
  else if (!ID_RE.test(def.id)) add('id', 'invalid_format', 'id uses lower-case letters, digits and hyphens, and starts and ends with a letter or a digit.');
  else if (RESERVED_AGENT_IDS.includes(def.id)) add('id', 'reserved', `"${def.id}" is a reserved word; pick another id.`);
  if (!def.name) add('name', 'required', 'name is required.');
  tooLong('name', def.name, AGENT_LIMITS.name);
  tooLong('description', def.description, AGENT_LIMITS.description);
  tooLong('instructions', def.instructions, AGENT_LIMITS.instructions);
  if (LINE_CONTROL_RE.test(def.name)) add('name', 'invalid_format', 'name has a control character.');
  if (CONTROL_RE.test(def.instructions)) add('instructions', 'invalid_format', 'instructions have a control character.');

  // ── what it runs on ──
  if (!def.provider) add('provider', 'required', `provider is required: one of ${AGENT_PROVIDERS.join(', ')}.`);
  else if (!AGENT_PROVIDERS.includes(def.provider)) add('provider', 'unknown_value', `provider must be one of ${AGENT_PROVIDERS.join(', ')}.`);
  tooLong('model', def.model, AGENT_LIMITS.model);
  if (def.model && LINE_CONTROL_RE.test(def.model)) add('model', 'invalid_format', 'model has a control character.');
  if (def.effort && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(def.effort)) add('effort', 'invalid_format', `effort is a level name of at most ${AGENT_LIMITS.effort} characters, like "high".`);
  if (def.accountId && def.accountId !== 'auto' && !ACCOUNT_RE.test(def.accountId)) add('accountId', 'invalid_format', 'accountId is an account profile id (lower-case letters, digits, hyphens) or "auto".');

  // ── what it may touch ──
  for (const id of def.tools || []) {
    if (id.startsWith('mcp:')) add('tools', 'mcp_in_tools', `"${id}" is an MCP server: name it in mcpServers ("${id.slice(4)}"), not in tools.`);
  }
  if (def.mcpServers.length > AGENT_LIMITS.mcpServers) add('mcpServers', 'too_many', `mcpServers lists at most ${AGENT_LIMITS.mcpServers} servers.`);
  // The list is read by the resolver a dispatch uses (tool-list.ts), so what is kept here is what can start: unknown
  // and gated groups, server names that cannot be selected and lists over the catalog's limits are its to refuse.
  const read = resolveToolList(dispatchToolItems(def), { source: 'dispatch', provider: def.provider, usesBrowser: def.usesBrowser });
  if (!read.ok) {
    for (const problem of read.problems) {
      const field = problem.item.startsWith('mcp:') ? 'mcpServers' : 'tools';
      const what = problem.reason === 'too-many' ? `The tool list has ${problem.item}` : `"${problem.item}"`;
      add(field, TOOL_PROBLEM_CODES[problem.reason] || 'invalid_tool', `${what}${problem.hint ? `: ${problem.hint}` : ' is not something a tool list can name'}.`);
    }
  }
  const servers = knownMcpServers ? new Set(knownMcpServers) : null;
  for (const name of def.mcpServers) {
    if (servers && name !== '*' && !servers.has(name)) add('mcpServers', 'unknown_mcp_server', `Unknown MCP server "${name}".`);
  }
  if (!AGENT_CAPABILITIES.includes(def.capability)) add('capability', 'unknown_value', `capability must be one of ${AGENT_CAPABILITIES.join(', ')}.`);
  if (!AGENT_PERMISSION_POLICIES.includes(def.permissionPolicy)) add('permissionPolicy', 'unknown_value', `permissionPolicy must be one of ${AGENT_PERMISSION_POLICIES.join(', ')}.`);
  const browserTools = namedGroups(def).filter(isBrowserGroup);
  // The dispatcher refuses the same pair (assistant-tools.js browserToolsConflict): a definition that can never start is not kept.
  if (!def.usesBrowser && browserTools.length) add('usesBrowser', 'browser_tools_without_browser', `tools names browser groups (${def.tools.includes('all') ? 'all' : browserTools.join(', ')}) but usesBrowser is false: set it, or drop them.`);
  tooLong('moreloginProfile', def.moreloginProfile, AGENT_LIMITS.moreloginProfile);
  if (def.moreloginProfile && !def.usesBrowser) add('moreloginProfile', 'profile_without_browser', 'moreloginProfile names the MoreLogin profile of the agent\'s browser tab: set usesBrowser with it, or leave it out.');
  if (def.skills.length > AGENT_LIMITS.skills) add('skills', 'too_many', `skills lists at most ${AGENT_LIMITS.skills} skills.`);
  for (const ref of def.skills) if (!SKILL_RE.test(ref)) add('skills', 'invalid_format', `"${ref.slice(0, 80)}" is not a skill name ("release-notes", "plugin:skill") or a library id (skl_…).`);

  // ── where it applies, what it is for ──
  const rawScope = pick(input, 'scope');
  if (isObject(rawScope) && !AGENT_SCOPE_KINDS.includes(lower(rawScope.kind))) add('scope', 'unknown_value', `scope.kind must be one of ${AGENT_SCOPE_KINDS.join(', ')}.`);
  if (def.scope.kind === 'project') {
    if (isObject(rawScope) && rawScope.path !== undefined && typeof rawScope.path !== 'string') add('scope.path', 'invalid_type', 'scope.path must be text.');
    else if (!def.scope.path) add('scope.path', 'required', 'A project agent names its project: scope.path is the project folder.');
    else if (def.scope.path.includes('\u0000') || LINE_CONTROL_RE.test(def.scope.path)) add('scope.path', 'invalid_format', 'scope.path has a control character.');
    else if (!isAbsolute(def.scope.path)) add('scope.path', 'path_not_absolute', 'scope.path must be an absolute path.');
    else if (def.scope.path.length > AGENT_LIMITS.projectPath) add('scope.path', 'too_long', `scope.path is at most ${AGENT_LIMITS.projectPath} characters.`);
  }
  if (def.memoryCategory && !CATEGORY_RE.test(def.memoryCategory)) add('memoryCategory', 'invalid_format', 'memoryCategory is a category name: lower-case letters, digits and hyphens.');
  if (def.taskClasses.length > AGENT_LIMITS.taskClasses) add('taskClasses', 'too_many', `taskClasses lists at most ${AGENT_LIMITS.taskClasses} classes.`);
  for (const cls of def.taskClasses) if (!/^[a-z][a-z0-9_]{0,39}$/.test(cls)) add('taskClasses', 'invalid_format', `"${cls.slice(0, 80)}" is not a task class name.`);
  if (def.icon && !ICON_RE.test(def.icon)) add('icon', 'invalid_format', 'icon is an icon name (lower-case letters, digits, hyphens): never markup, a path or a URL.');
  if (def.color && !TOKEN_RE.test(def.color)) {
    if (RAW_COLOR_RE.test(def.color)) add('color', 'raw_color', 'color is a style-guide token name like "status.info": never a raw colour value.');
    else add('color', 'invalid_format', 'color is a style-guide token name in the form "group.key" (for example "primary.500" or "status.info").');
  }

  // ── revision metadata ──
  if (!AGENT_STATUSES.includes(def.status)) add('status', 'unknown_value', `status must be one of ${AGENT_STATUSES.join(', ')}.`);
  for (const field of ['createdAt', 'approvedAt']) {
    if (def[field] !== null && !(ISO_RE.test(def[field]) && Number.isFinite(Date.parse(def[field])))) add(field, 'invalid_date', `${field} must be an ISO 8601 UTC time like 2026-11-15T12:00:00.000Z.`);
  }
  if (def.parentRevision !== null && def.parentRevision >= def.revision) add('parentRevision', 'invalid_revision', 'parentRevision is an earlier revision than revision.');
  if (def.status === 'approved' && !def.approvedAt) add('approvedAt', 'required', 'An approved revision says when it was approved.');
  if (def.status !== 'approved' && def.status !== 'withdrawn' && def.approvedAt) add('approvedAt', 'not_approved', 'approvedAt belongs to an approved revision only.');
  if (def.approvedAt && def.createdAt && ISO_RE.test(def.approvedAt) && ISO_RE.test(def.createdAt) && Date.parse(def.approvedAt) < Date.parse(def.createdAt)) add('approvedAt', 'invalid_date', 'approvedAt is not earlier than createdAt.');
  const author = pick(input, 'author');
  if (author !== undefined && author !== null) {
    const kind = isObject(author) ? author.kind : author;
    if (typeof kind !== 'string' || !AGENT_AUTHOR_KINDS.includes(kind.trim().toLowerCase())) add('author', 'unknown_value', `author.kind must be one of ${AGENT_AUTHOR_KINDS.join(', ')}.`);
  }
  const givenEtag = pick(input, 'etag');
  if (givenEtag !== undefined && givenEtag !== null) {
    if (typeof givenEtag !== 'string' || !ETAG_RE.test(givenEtag)) add('etag', 'invalid_format', 'etag is "sha256:" and 64 hex digits.');
    else if (requireMeta && givenEtag !== def.etag) add('etag', 'etag_mismatch', 'etag is not the digest of this content: the definition was changed after its etag was written.');
  }
  if (requireMeta && !def.createdAt) add('createdAt', 'required', 'A stored revision says when it was made.');

  return { ok: errors.length === 0, errors, value: def };
}

/**
 * Softer findings on a definition that `validate` accepts: things an owner should look at before approving, never a
 * refusal. Runs on the normalized form; pass what the caller knows to get the checks that need it.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {Iterable<string>} [options.knownTaskClasses] defaults to AGENT_TASK_CLASSES
 * @param {Iterable<string>} [options.knownSkills]      skill names / ids that exist
 * @param {Iterable<string>} [options.knownColorTokens] style-guide tokens ("group.key") the project defines
 * @param {Iterable<string>} [options.knownCategories]  memory categories that exist
 * @param {Iterable<string>} [options.knownModels]      model ids the provider lists
 * @returns {{ field: string, code: string, message: string }[]}
 */
export function lintAgentDefinition(input, { knownTaskClasses = AGENT_TASK_CLASSES, knownSkills = null, knownColorTokens = null, knownCategories = null, knownModels = null } = {}) {
  const def = normalizeAgentDefinition(input);
  const out = [];
  const warn = (field, code, message) => out.push(issue(field, code, message));
  const browserUse = usesBrowserTools(def);

  if (!def.instructions) warn('instructions', 'empty_instructions', 'The agent has no instructions: it would run as a plain worker under another name.');
  else if (def.instructions.length > LONG_INSTRUCTIONS_CHARS) warn('instructions', 'long_instructions', `The instructions are over ${LONG_INSTRUCTIONS_CHARS} characters: every run of this agent pays for them.`);
  if (!def.description) warn('description', 'empty_description', 'The agent has no description: the Assistant chooses agents by it.');
  if (def.capability === 'full' && browserUse) warn('capability', 'full_with_browser', 'Full capability with browser use: pages are untrusted input and nothing guards what the worker then does. Such a run starts only when tagged "user-authorized-full".');
  if (def.capability === 'full' && def.usesComputer) warn('capability', 'full_with_computer', 'Full capability with computer use: the screen is untrusted input and nothing guards what the worker then does. Such a run starts only when tagged "user-authorized-full".');
  if (def.capability === 'full' && !browserUse && !def.usesComputer) warn('capability', 'full_capability', 'Full capability is never guarded: the worker can write anywhere this user can. Workspace is enough for most coding agents.');
  if (def.capability === 'read-only' && def.taskClasses.some((cls) => cls === 'code' || cls === 'complex' || cls === 'quick')) warn('capability', 'read_only_for_code', 'A read-only agent cannot edit files, but it is offered for coding tasks.');
  if (def.usesComputer && def.taskClasses.length && !def.taskClasses.includes('computer')) warn('taskClasses', 'computer_without_class', 'usesComputer is on but the agent is not offered for the "computer" task class.');
  if (def.permissionPolicy === 'restricted' && def.capability === 'full') warn('permissionPolicy', 'restricted_with_full', 'permissionPolicy "restricted" runs a workspace-write sandbox, which contradicts capability "full".');
  if ((def.tools || []).includes('all')) warn('tools', 'all_tools', 'tools "all" gives the agent every selectable SynaBun group; list the ones it needs.');
  const readTools = def.tools ? resolveToolList(def.tools.filter((id) => !id.startsWith('mcp:')), { source: 'runtime' }) : null;
  for (const id of readTools?.ok ? readTools.dropped : []) warn('tools', 'always_on_tool', `"${id}" is always available to a worker: naming it changes nothing.`);
  if (def.mcpServers.includes('*')) warn('mcpServers', 'all_mcp_servers', 'mcpServers "*" gives the agent every MCP server you allow; list the ones it needs.');
  if (def.accountId && def.provider && !AGENT_ACCOUNT_PROVIDERS.includes(def.provider)) warn('accountId', 'account_ignored', `${def.provider} has no accounts in SynaBun: accountId is ignored.`);
  const classes = new Set(knownTaskClasses);
  for (const cls of def.taskClasses) if (!classes.has(cls)) warn('taskClasses', 'unknown_task_class', `Unknown task class "${cls}": the Assistant never routes one, so it never picks this agent for it.`);
  if (!def.taskClasses.length) warn('taskClasses', 'no_task_classes', 'No task class is named: the agent is offered only when it is asked for by name.');
  if (knownSkills) { const set = new Set(knownSkills); for (const ref of def.skills) if (!set.has(ref)) warn('skills', 'unknown_skill', `Skill "${ref}" was not found.`); }
  if (knownColorTokens && def.color && !new Set(knownColorTokens).has(def.color)) warn('color', 'unknown_color_token', `The style guide has no token "${def.color}".`);
  if (knownCategories && def.memoryCategory && !new Set(knownCategories).has(def.memoryCategory)) warn('memoryCategory', 'unknown_category', `Memory category "${def.memoryCategory}" does not exist yet; it is created the first time the agent saves.`);
  if (knownModels && def.model && !new Set(knownModels).has(def.model)) warn('model', 'unknown_model', `Model "${def.model}" is not in the provider's list.`);
  return out;
}

// ── revisions ────────────────────────────────────────────────────────────────

/** Which status may follow which. A revision that reached `withdrawn` stays there; a change of an approved one is a new draft. */
export const AGENT_STATUS_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['in_review', 'withdrawn']),
  in_review: Object.freeze(['approved', 'draft', 'withdrawn']),
  approved: Object.freeze(['withdrawn']),
  withdrawn: Object.freeze([]),
});

export function canTransition(from, to) {
  return (AGENT_STATUS_TRANSITIONS[from] || []).includes(to);
}
/** Only a draft is edited in place. */
export function isEditable(definition) { return definition?.status === 'draft'; }
/** Only an approved revision is something a run may use. */
export function isRunnable(definition) { return definition?.status === 'approved'; }

const actorKind = (actor) => (isObject(actor) ? lower(actor.kind) : lower(actor));
const stamp = (now) => (typeof now === 'number' ? new Date(now).toISOString() : String(now));

/**
 * A first draft, or the next draft over an earlier revision of the same agent.
 * @param {object} input the content (and optionally `author`)
 * @param {object} options
 * @param {string|number} options.now the time, as an ISO string or epoch milliseconds (this module reads no clock)
 * @param {object|null} [options.base] the revision this draft is made over: its number becomes `parentRevision`
 * @param {number} [options.revision]  the number the registry gives this draft (default: base's + 1, or 1)
 * @param {object|string} [options.author] who is making it (default: the input's, else owner)
 */
export function createDraft(input, { now, base = null, revision = null, author = null } = {}) {
  if (now === undefined || now === null) throw new AgentSchemaError('now_required', 'createDraft needs the time: pass { now }.');
  const baseRevision = base ? Number(base.revision) : null;
  if (base && isObject(input) && lower(pick(input, 'id')) && lower(pick(input, 'id')) !== base.id) {
    throw new AgentSchemaError('id_changed', 'A revision keeps the id of the agent it revises.', { field: 'id' });
  }
  return normalizeAgentDefinition({
    ...(base ? contentOf(base) : {}),
    ...(isObject(input) ? input : {}),
    revision: revision ?? (baseRevision ? baseRevision + 1 : 1),
    parentRevision: baseRevision,
    status: 'draft',
    author: author ?? (isObject(input) ? pick(input, 'author') : null) ?? 'owner',
    createdAt: stamp(now),
    approvedAt: null,
  });
}

/**
 * Move a revision to another status. Returns a new definition; the one given is not changed.
 * Approving is the owner's alone: an agent, the Assistant or the system never approves what it or another made.
 * @param {object} definition
 * @param {string} to one of AGENT_STATUSES
 * @param {object} options
 * @param {string|number} options.now
 * @param {object|string} options.actor `{ kind }` or the kind: owner | assistant | agent | system
 * @throws {AgentSchemaError} `invalid_transition`, `approval_requires_owner`, `not_valid` (with `errors`)
 */
export function applyTransition(definition, to, { now, actor } = {}) {
  const def = normalizeAgentDefinition(definition);
  const target = lower(to).replace(/-/g, '_');
  if (now === undefined || now === null) throw new AgentSchemaError('now_required', 'applyTransition needs the time: pass { now }.');
  if (!canTransition(def.status, target)) {
    throw new AgentSchemaError('invalid_transition', `A revision that is ${def.status} cannot become ${target || 'that'}.`, { status: 409, from: def.status, to: target });
  }
  const who = actorKind(actor);
  if (!AGENT_AUTHOR_KINDS.includes(who)) throw new AgentSchemaError('actor_required', `applyTransition needs who is acting: one of ${AGENT_AUTHOR_KINDS.join(', ')}.`);
  if (target === 'approved' && who !== 'owner') {
    throw new AgentSchemaError('approval_requires_owner', 'Only the owner approves an agent definition.', { status: 403 });
  }
  const next = { ...def, status: target, approvedAt: target === 'approved' ? stamp(now) : (target === 'withdrawn' ? def.approvedAt : null) };
  if (target === 'in_review' || target === 'approved') {
    const checked = validateAgentDefinition(next);
    if (!checked.ok) throw new AgentSchemaError('not_valid', 'The definition has errors; fix them first.', { errors: checked.errors });
  }
  return next;
}

const CAPABILITY_RANK = Object.freeze({ 'read-only': 0, workspace: 1, full: 2 });
// How much a policy lets a worker do without asking: "ask" relays every permission, "restricted" sandboxes, "auto" is free.
const POLICY_RANK = Object.freeze({ ask: 0, restricted: 1, auto: 2 });

/** What a definition lets its worker do, in one flat record (the review's "what can it do" and the base of privilegeDelta). */
export function privilegesOf(definition) {
  const def = normalizeAgentDefinition(definition);
  return {
    capability: def.capability,
    permissionPolicy: def.permissionPolicy,
    tools: def.tools,
    mcpServers: def.mcpServers,
    usesBrowser: usesBrowserTools(def),
    usesComputer: def.usesComputer,
    moreloginProfile: def.moreloginProfile,
    skills: def.skills,
    scope: def.scope.kind,
  };
}

/**
 * What `after` may do that `before` may not (lib/skills/reviews.js authorityDelta, for agents). `before` null: a
 * first revision, compared with an agent that may do nothing. A change that only narrows is not an escalation.
 * `tools: null` is the worker's default list, compared group by group as the tool catalog's DEFAULT_TOOLS (or the
 * list given as `defaultTools`; with `defaultTools: null` a move to or from the default list counts as an
 * escalation, because it cannot be told).
 * @param {object|null} before
 * @param {object} after
 * @param {{ defaultTools?: Iterable<string>|null }} [options]
 * @returns {{ escalates: boolean, changes: { field: string, from: any, to: any, escalates: boolean }[] }}
 */
export function privilegeDelta(before, after, { defaultTools = DEFAULT_TOOLS } = {}) {
  const b = before ? privilegesOf(before) : { capability: null, permissionPolicy: null, tools: [], mcpServers: [], usesBrowser: false, usesComputer: false, moreloginProfile: null, skills: [], scope: null };
  const a = privilegesOf(after);
  const changes = [];
  const note = (field, from, to, escalates) => changes.push({ field, from, to, escalates });
  if (a.capability !== b.capability) note('capability', b.capability, a.capability, (CAPABILITY_RANK[a.capability] ?? 3) > (CAPABILITY_RANK[b.capability] ?? -1));
  if (a.permissionPolicy !== b.permissionPolicy) note('permissionPolicy', b.permissionPolicy, a.permissionPolicy, (POLICY_RANK[a.permissionPolicy] ?? 3) > (POLICY_RANK[b.permissionPolicy] ?? -1));
  const same = (x, y) => (x === null || y === null ? x === y : x.length === y.length && x.every((item, i) => item === y[i]));
  // `wild`: the item that stands for everything ("all", "*"). `fallback`: what a null list means, when known.
  const list = (field, from, to, wild, fallback) => {
    if (same(from, to)) return;
    const defaults = fallback ? [...fallback] : null;
    const had = from === null ? defaults : from;
    const has = to === null ? defaults : to;
    // A default list nobody spelled out cannot be compared: shown, and counted as wider.
    if (had === null || has === null) { note(field, from, to, true); return; }
    const widened = !!wild && has.includes(wild) && !had.includes(wild);
    const added = had.includes(wild) ? [] : has.filter((item) => !had.includes(item));
    note(field, from, to, widened || added.length > 0);
  };
  list('tools', b.tools, a.tools, 'all', defaultTools);
  list('mcpServers', b.mcpServers, a.mcpServers, '*', null);
  list('skills', b.skills, a.skills, null, null);
  if (a.usesBrowser !== b.usesBrowser) note('usesBrowser', b.usesBrowser, a.usesBrowser, a.usesBrowser);
  if (a.usesComputer !== b.usesComputer) note('usesComputer', b.usesComputer, a.usesComputer, a.usesComputer);
  if (a.moreloginProfile !== b.moreloginProfile) note('moreloginProfile', b.moreloginProfile, a.moreloginProfile, !!a.moreloginProfile);
  if (a.scope !== b.scope) note('scope', b.scope, a.scope, a.scope === 'global');
  return { escalates: changes.some((change) => change.escalates), changes };
}

// ── what a run takes from a definition ───────────────────────────────────────

/**
 * The fields a dispatch gets from an agent, in the dispatcher's own spelling (assistant-dispatch.js normalizeSpec):
 * what `agent_ref` pins on a run. `tools` is the dispatch list: the definition's groups plus `mcp:<name>` for each
 * MCP server (`mcp:*` for all), or undefined when the definition names neither (the worker's defaults apply).
 * The task text, cwd, session and budget are the dispatch's own and are not here.
 */
export function dispatchFields(definition) {
  const def = normalizeAgentDefinition(definition);
  const servers = def.mcpServers.map((name) => `mcp:${name}`);
  const out = {
    provider: def.provider,
    capability: def.capability,
    permissionPolicy: def.permissionPolicy,
    usesBrowser: def.usesBrowser,
    usesComputer: def.usesComputer,
  };
  if (def.model) out.model = def.model;
  if (def.effort) out.effort = def.effort;
  if (def.accountId && AGENT_ACCOUNT_PROVIDERS.includes(def.provider)) out.accountId = def.accountId;
  if (def.tools !== null || servers.length) out.tools = [...(def.tools || []), ...servers];
  if (def.moreloginProfile && def.usesBrowser) out.moreloginProfile = def.moreloginProfile;
  return out;
}

// ── agent_ref ────────────────────────────────────────────────────────────────

const REF_RE = /^(?:(global|project):)?([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:@([1-9][0-9]{0,8}))?$/;

/**
 * An `agent_ref` as a dispatch or a team slice writes it: `<id>`, `<id>@<revision>`, `global:<id>`,
 * `project:<id>@<revision>`. Without a scope the project's agent of that id wins over the global one; without a
 * revision the approved one is meant.
 * @returns {{ id: string, revision: number|null, scope: 'global'|'project'|null } | null} null: not a ref
 */
export function parseAgentRef(ref) {
  const match = typeof ref === 'string' ? REF_RE.exec(ref.trim().toLowerCase()) : null;
  if (!match || RESERVED_AGENT_IDS.includes(match[2])) return null;
  return { id: match[2], revision: match[3] ? Number(match[3]) : null, scope: match[1] || null };
}

/** The ref of a definition or of `{ id, revision, scope }` parts: the text `parseAgentRef` reads back. */
export function formatAgentRef({ id, revision = null, scope = null } = {}) {
  const kind = isObject(scope) ? scope.kind : scope;
  const out = `${kind === 'global' || kind === 'project' ? `${kind}:` : ''}${String(id || '').trim().toLowerCase()}${Number.isInteger(revision) && revision >= 1 ? `@${revision}` : ''}`;
  if (!parseAgentRef(out)) throw new AgentSchemaError('invalid_ref', `Not an agent ref: ${out || '(empty)'}`);
  return out;
}

/**
 * Where a ref is looked up, first match wins: the project's own agents, then the global library (the owner's
 * choice: a global library plus per-project agents). A ref that names a scope is looked up there only.
 * @param {{ scope: string|null }} parsed a parseAgentRef result
 * @param {string|null} projectPath the project the run is for
 * @returns {{ kind: 'project', path: string }|{ kind: 'global' }}[]
 */
export function resolutionOrder(parsed, projectPath = null) {
  const project = projectPath ? [{ kind: 'project', path: normalizeScope({ kind: 'project', path: projectPath }).path }] : [];
  if (parsed?.scope === 'global') return [{ kind: 'global' }];
  if (parsed?.scope === 'project') return project;
  return [...project, { kind: 'global' }];
}

/** Do two scopes name the same place? */
export function sameScope(a, b) {
  const x = normalizeScope(a);
  const y = normalizeScope(b);
  return x.kind === y.kind && (x.kind !== 'project' || x.path === y.path);
}

// The short names the phase plan uses.
export { normalizeAgentDefinition as normalize, validateAgentDefinition as validate, lintAgentDefinition as lint };
