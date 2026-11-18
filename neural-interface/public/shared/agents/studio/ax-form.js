// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the editor's form state
// ═══════════════════════════════════════════
//
// The editor holds one plain object with the content fields of an AgentDefinition (lib/agents/schema.js
// AGENT_CONTENT_FIELDS, in the contract's own spelling). This module turns a stored definition into that object,
// says what a save sends (only the fields that differ from what was read: a patch changes what it names and nothing
// else), which field every problem the server reports belongs to, and what a conflict changed. The rules themselves
// (what is valid, what is merely worth a look) stay the server's: the page asks POST /validate and shows the answer
// (never a second copy of them here). The one thing decided on the page is the id suggested from a name, which the
// server then checks like any other id.
// No DOM and no imports.

/** The fields of the form, in the order the editor shows them (the contract's content fields). */
export const FORM_FIELDS = Object.freeze([
  'name', 'id', 'description', 'instructions', 'provider', 'model', 'effort', 'accountId', 'tools', 'mcpServers',
  'capability', 'permissionPolicy', 'usesBrowser', 'usesComputer', 'moreloginProfile', 'skills', 'scope',
  'memoryCategory', 'taskClasses', 'icon', 'color',
]);
/** The sections of the editor and the fields each one holds (every field is in exactly one). */
export const FORM_SECTIONS = Object.freeze([
  { id: 'identity', fields: ['name', 'id', 'description', 'icon', 'color'] },
  { id: 'instructions', fields: ['instructions'] },
  { id: 'runtime', fields: ['provider', 'model', 'effort', 'accountId'] },
  { id: 'access', fields: ['capability', 'permissionPolicy', 'tools', 'mcpServers', 'usesBrowser', 'moreloginProfile', 'usesComputer', 'skills'] },
  { id: 'use', fields: ['scope', 'taskClasses', 'memoryCategory'] },
]);
const LIST_FIELDS = new Set(['mcpServers', 'skills', 'taskClasses']);
const BOOL_FIELDS = new Set(['usesBrowser', 'usesComputer']);
const NULLABLE_TEXT = new Set(['model', 'effort', 'accountId', 'moreloginProfile', 'memoryCategory', 'icon', 'color']);

const text = (value) => (typeof value === 'string' ? value : '');
const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : []);
const scopeOf = (value) => (value && value.kind === 'project' ? { kind: 'project', path: text(value.path) } : { kind: 'global' });

/** A form with nothing in it but what a new agent starts from. */
export function blankForm({ provider = '', scope = null } = {}) {
  return {
    name: '', id: '', description: '', instructions: '', provider: text(provider), model: null, effort: null, accountId: null,
    tools: null, mcpServers: [], capability: 'workspace', permissionPolicy: 'auto', usesBrowser: false, usesComputer: false,
    moreloginProfile: null, skills: [], scope: scopeOf(scope), memoryCategory: null, taskClasses: [], icon: null, color: null,
  };
}

/** The form of a stored definition (a missing field takes the blank form's value; nothing else is carried). */
export function formOf(definition) {
  const d = definition && typeof definition === 'object' ? definition : {};
  const out = blankForm();
  for (const field of FORM_FIELDS) {
    if (field === 'scope') out.scope = scopeOf(d.scope);
    else if (field === 'tools') out.tools = Array.isArray(d.tools) ? list(d.tools) : null;
    else if (LIST_FIELDS.has(field)) out[field] = list(d[field]);
    else if (BOOL_FIELDS.has(field)) out[field] = d[field] === true;
    else if (NULLABLE_TEXT.has(field)) out[field] = text(d[field]) || null;
    else if (typeof d[field] === 'string') out[field] = d[field];
  }
  return out;
}

/**
 * A name as an id, as the registry suggests one (lib/agents/registry.js slugifyAgentId): "Release Notes Writer" →
 * "release-notes-writer". '' when nothing is left. The server checks the result like any id.
 */
export function slugOf(name, limit = 64) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, limit).replace(/-+$/g, '');
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Lists are compared as the contract keeps them: without duplicates, sorted. */
const canon = (field, value) => {
  if (field === 'tools') return Array.isArray(value) ? [...new Set(value)].sort() : null;
  if (LIST_FIELDS.has(field)) return [...new Set(list(value))].sort();
  if (field === 'scope') return scopeOf(value);
  if (BOOL_FIELDS.has(field)) return value === true;
  if (NULLABLE_TEXT.has(field)) return text(value).trim() || null;
  if (field === 'instructions') return text(value).replace(/\r\n?/g, '\n').trim();
  return text(value).replace(/\s+/g, ' ').trim();
};

/** The fields of `form` that differ from `base` (a stored definition, or a form). */
export function changedFields(base, form) {
  const b = formOf(base);
  return FORM_FIELDS.filter((field) => !same(canon(field, b[field]), canon(field, form?.[field])));
}

export const isDirty = (base, form) => changedFields(base, form).length > 0;

/**
 * What a save sends: the fields that differ from what was read, never the id or the scope (an agent keeps both;
 * the registry refuses a patch that moves it).
 */
export function patchOf(base, form) {
  const out = {};
  for (const field of changedFields(base, form)) {
    if (field === 'id' || field === 'scope') continue;
    out[field] = field === 'tools' ? (Array.isArray(form.tools) ? [...form.tools] : null) : canon(field, form[field]);
  }
  return out;
}

/** The whole definition a new agent is made from (and what POST /validate is asked). */
export function definitionOf(form) {
  const out = {};
  for (const field of FORM_FIELDS) out[field] = field === 'tools' ? (Array.isArray(form?.tools) ? [...form.tools] : null) : canon(field, form?.[field]);
  return out;
}

/**
 * Set one field. While the id was not typed by hand (a new agent), it follows the name. Turning the browser off
 * takes the MoreLogin profile with it (a profile is the browser tab's: the contract refuses one without the other).
 * @returns {object} a new form
 */
export function applyField(form, field, value, { idFollowsName = false, idLimit = 64 } = {}) {
  const next = { ...form, [field]: value };
  if (field === 'name' && idFollowsName) next.id = slugOf(value, idLimit);
  if (field === 'usesBrowser' && value !== true) next.moreloginProfile = null;
  if (field === 'provider' && value !== form.provider) { next.model = null; next.effort = null; next.accountId = null; }
  if (field === 'model' && value !== form.model) next.effort = null;
  return next;
}

/** The form field a reported problem belongs to (`scope.path` is the scope's; revision metadata is nobody's). */
export function fieldOfIssue(issue) {
  const field = text(issue?.field);
  if (field === 'scope.path') return 'scope';
  return FORM_FIELDS.includes(field) ? field : '_';
}

/**
 * The server's answer of POST /validate (or of a draft read) by field: `{ [field]: { errors: [], warnings: [] } }`.
 * What belongs to no field of the form is under `_`.
 */
export function issuesByField(errors = [], warnings = []) {
  const out = {};
  const at = (field) => (out[field] ||= { errors: [], warnings: [] });
  for (const issue of Array.isArray(errors) ? errors : []) at(fieldOfIssue(issue)).errors.push({ code: text(issue?.code), message: text(issue?.message) });
  for (const issue of Array.isArray(warnings) ? warnings : []) at(fieldOfIssue(issue)).warnings.push({ code: text(issue?.code), message: text(issue?.message) });
  return out;
}

/** How many problems, and in which sections (the section list's marks). */
export function issueCounts(byField) {
  let errors = 0;
  let warnings = 0;
  const sections = {};
  for (const [field, found] of Object.entries(byField || {})) {
    errors += found.errors.length;
    warnings += found.warnings.length;
    const section = FORM_SECTIONS.find((s) => s.fields.includes(field))?.id || '_';
    const mark = (sections[section] ||= { errors: 0, warnings: 0 });
    mark.errors += found.errors.length;
    mark.warnings += found.warnings.length;
  }
  return { errors, warnings, sections };
}

/** The length of a text against its limit: `{ length, limit, over, near }` (near: the last tenth). */
export function countOf(value, limit) {
  const length = text(value).length;
  const max = Number.isFinite(limit) && limit > 0 ? limit : null;
  return { length, limit: max, over: max !== null && length > max, near: max !== null && length <= max && length >= max * 0.9 };
}

/**
 * A save refused because the draft changed since it was read (409 etag_conflict). `base` is what the editor read,
 * `mine` the form, `theirs` the definition stored now. For every field that differs between the three:
 * `theirs` (changed there), `mine` (changed here), `clash` (changed on both sides, to different values).
 */
export function conflictFields(base, mine, theirs) {
  const b = formOf(base);
  const t = formOf(theirs);
  const out = [];
  for (const field of FORM_FIELDS) {
    const changedThere = !same(canon(field, b[field]), canon(field, t[field]));
    const changedHere = !same(canon(field, b[field]), canon(field, mine?.[field]));
    if (!changedThere && !changedHere) continue;
    out.push({ field, theirs: changedThere, mine: changedHere, clash: changedThere && changedHere && !same(canon(field, t[field]), canon(field, mine?.[field])) });
  }
  return out;
}

/**
 * The form after a conflict when the owner keeps its own text: the stored definition, with every field changed
 * here written over it. It is then saved against the etag that is current (a new draft content over theirs).
 */
export function mergeOverTheirs(base, mine, theirs) {
  const next = formOf(theirs);
  for (const field of changedFields(base, mine)) if (field !== 'id' && field !== 'scope') next[field] = mine[field];
  return next;
}
