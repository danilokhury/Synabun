// ═══════════════════════════════════════════
// SynaBun — Agents: the registry (phase P1)
// ═══════════════════════════════════════════
//
// Where agent definitions are kept. One folder per agent and scope under SynaBun's data home:
//
//   DATA_HOME/data/agents/<id>/global/            the global library's agent of that id
//   DATA_HOME/data/agents/<id>/p-<16 hex>/        the same id pinned to one project (the hex is its path's digest)
//       agent.json                                { id, scope, createdAt }, written once
//       draft.json                                the one working revision: status draft or in_review
//       revisions/000003.json                     a stored revision: approved, or withdrawn
//
// The lifecycle is the contract's (lib/agents/schema.js: createDraft, applyTransition) and follows the skills
// library (lib/skills/library.js, reviews.js): one editable draft, sent to review, and only the owner's approval
// makes it a revision a run may use. A stored revision's content is never changed: it is created exclusively, and
// the one later write it can get is its withdrawal, which is refused unless the content digest is the same. A change
// to an approved agent is a new draft over it, with the next number.
//
// Every write is one atomic file replace (lib/confined-fs.js) and every method is synchronous, so two requests
// never interleave inside one. A draft is checked by etag: an update names the etag it read, and a draft that
// changed meanwhile is a 409 with the current one.
//
// This module decides nothing about who may call it (lib/agents-studio-api.js does) beyond what the contract
// itself enforces: only an actor of kind `owner` approves.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import * as YAML from 'yaml';
import { createFrontmatter } from '../../public/shared/skills/ss-frontmatter.js';
import { readConfinedFile, replaceFileAtomic, writeConfinedFile } from '../confined-fs.js';
import {
  AGENT_CONTENT_FIELDS, AGENT_LIMITS, RESERVED_AGENT_IDS, AgentSchemaError,
  applyTransition, contentOf, createDraft, formatAgentRef, lintAgentDefinition, normalizeAgentDefinition, privilegeDelta,
  sameScope, validateAgentDefinition,
} from './schema.js';

export const AGENT_BUNDLE_FORMAT = 'synabun-agents';
export const AGENT_BUNDLE_VERSION = 1;
export const REGISTRY_LIMITS = Object.freeze({
  /** One stored file (a definition with 16,000 characters of instructions is far below it). */
  fileBytes: 512 * 1024,
  /** Agents in one bundle. */
  bundleAgents: 200,
  /** A Claude Code agent file read by importClaudeAgent. */
  claudeAgentBytes: 256 * 1024,
  /** Lines per side of an instructions diff; longer texts are compared whole, without a line list. */
  diffLines: 1500,
});

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SCOPE_KEY_RE = /^(?:global|p-[0-9a-f]{16})$/;
const REVISION_FILE_RE = /^(\d{6})\.json$/;
const ETAG_RE = /^sha256:[0-9a-f]{64}$/;
const META_KEYS = new Set(['schemaVersion', 'revision', 'parentRevision', 'parent_revision', 'status', 'author', 'createdAt', 'created_at', 'approvedAt', 'approved_at', 'etag']);
const frontmatter = createFrontmatter(YAML);

export class AgentRegistryError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {object} [extra] */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AgentRegistryError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const iso = (value) => (typeof value === 'number' ? new Date(value).toISOString() : String(value));
const pad = (n) => String(n).padStart(6, '0');

/** The scope a caller names, in the contract's form. Throws 400 for one that is not a scope. */
export function scopeOf(input) {
  if (input === undefined || input === null || input === '' || input === 'global') return { kind: 'global' };
  const raw = isObject(input) ? input : { kind: 'project', path: String(input) };
  const kind = String(raw.kind || '').trim().toLowerCase();
  if (kind !== 'global' && kind !== 'project') throw new AgentRegistryError(400, 'invalid_scope', 'scope is { kind: "global" } or { kind: "project", path }.');
  const scope = normalizeAgentDefinition({ scope: { kind, path: raw.path } }).scope;
  if (scope.kind === 'global') return scope;
  // eslint-disable-next-line no-control-regex
  if (typeof raw.path !== 'string' || !scope.path || /[\u0000-\u001f\u007f]/.test(scope.path) || !isAbsolute(scope.path) || scope.path.length > AGENT_LIMITS.projectPath) {
    throw new AgentRegistryError(400, 'invalid_scope', 'A project agent names its project: scope.path is the absolute path of the project folder.');
  }
  return scope;
}

/** The folder name of a scope: `global`, or `p-` and 16 hex digits of the project path's digest. Never request text. */
export function scopeKey(scope) {
  const s = scopeOf(scope);
  return s.kind === 'project' ? `p-${createHash('sha256').update(s.path).digest('hex').slice(0, 16)}` : 'global';
}

function requireId(id) {
  const value = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (!ID_RE.test(value) || RESERVED_AGENT_IDS.includes(value)) throw new AgentRegistryError(400, 'invalid_id', 'An agent id is lower-case letters, digits and hyphens (at most 64), and not a reserved word.');
  return value;
}

/** A name as an id: "Release Notes Writer" → "release-notes-writer". '' when nothing is left. */
export function slugifyAgentId(name) {
  const slug = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, AGENT_LIMITS.id).replace(/-+$/g, '');
  return slug && !RESERVED_AGENT_IDS.includes(slug) ? slug : (slug ? `${slug}-agent`.slice(0, AGENT_LIMITS.id) : '');
}

const snakeOf = (key) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
/**
 * The content a caller sent, in the contract's spelling (`usesBrowser`, also when it was written `uses_browser`),
 * without the revision metadata (which only the registry writes) and without keys the contract does not have.
 * A field the caller did not name is not in the answer: a patch changes what it names and nothing else.
 */
function contentInput(input) {
  const src = isObject(input) ? input : {};
  const out = {};
  for (const field of AGENT_CONTENT_FIELDS) {
    if (META_KEYS.has(field)) continue;
    const snake = snakeOf(field);
    if (Object.prototype.hasOwnProperty.call(src, field)) { if (src[field] !== undefined) out[field] = src[field]; }
    else if (snake !== field && Object.prototype.hasOwnProperty.call(src, snake) && src[snake] !== undefined) out[field] = src[snake];
  }
  return out;
}

/** Type errors of a patch: a value that cannot be what its field holds is refused, not silently defaulted. */
function typeErrors(input) {
  return validateAgentDefinition(isObject(input) ? input : {}).errors.filter((error) => error.code === 'invalid_type');
}

// ── a small line diff (for instructions) ─────────────────────────────────────
/** → [{ op: ' ' | '+' | '-', line }] or null when either side is over the limit. */
function lineDiff(before, after, limit = REGISTRY_LIMITS.diffLines) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  if (a.length > limit || b.length > limit) return null;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: ' ', line: a[i] }); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { out.push({ op: '-', line: a[i] }); i += 1; }
    else { out.push({ op: '+', line: b[j] }); j += 1; }
  }
  while (i < a.length) { out.push({ op: '-', line: a[i] }); i += 1; }
  while (j < b.length) { out.push({ op: '+', line: b[j] }); j += 1; }
  return out;
}

const sameValue = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/** What differs between two definitions, field by field, and what the second may do that the first may not. */
export function diffDefinitions(before, after) {
  const a = before ? contentOf(normalizeAgentDefinition(before)) : null;
  const b = contentOf(normalizeAgentDefinition(after));
  const changes = [];
  for (const field of AGENT_CONTENT_FIELDS) {
    const from = a ? a[field] : null;
    if (a && sameValue(from, b[field])) continue;
    if (!a && sameValue(b[field], null)) continue;
    const change = { field, from, to: b[field] };
    if (field === 'instructions') {
      const lines = lineDiff(from, b[field]);
      if (lines) {
        change.lines = lines;
        change.added = lines.filter((row) => row.op === '+').length;
        change.removed = lines.filter((row) => row.op === '-').length;
      }
    }
    changes.push(change);
  }
  return { changed: changes.length > 0, changes, privileges: privilegeDelta(before || null, after) };
}

// ── a Claude Code agent file ─────────────────────────────────────────────────
// ~/.claude/agents/<name>.md or <project>/.claude/agents/<name>.md: YAML frontmatter (name, description, tools,
// model, and newer keys) and a body that is the agent's system prompt.

const CLAUDE_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'bash']);
const CLAUDE_MODEL_INHERIT = new Set(['', 'inherit', 'default', 'auto']);

function claudeToolNames(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return null;
}

/**
 * A Claude Code agent file as the content of a SynaBun agent draft, with what was mapped and what was left out.
 * Pure: reads no file. The tool names of a Claude agent (Read, Bash…) are Claude Code's own, not SynaBun tool
 * groups, so `tools` stays the worker's default; the MCP servers its tool list names become `mcpServers`, and a
 * tool list with nothing that writes makes the agent read-only.
 * @param {string} markdown the file's text
 * @param {{ fileName?: string, id?: string, scope?: object }} [options]
 * @returns {{ content: object, notes: string[] }}
 * @throws {AgentRegistryError} 400 `claude_agent_unreadable`, 413 `too_large`
 */
export function parseClaudeAgent(markdown, { fileName = '', id = null, scope = null } = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new AgentRegistryError(400, 'claude_agent_unreadable', 'Send the text of a Claude Code agent file (frontmatter and body).');
  if (Buffer.byteLength(markdown, 'utf8') > REGISTRY_LIMITS.claudeAgentBytes) throw new AgentRegistryError(413, 'too_large', `A Claude Code agent file is at most ${REGISTRY_LIMITS.claudeAgentBytes / 1024} KB.`);
  const parsed = frontmatter.parse(markdown);
  const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (parsed.data === null || errors.length) {
    throw new AgentRegistryError(400, 'claude_agent_unreadable', `The frontmatter could not be read: ${errors[0]?.message || 'it is not a YAML mapping'}.`, { diagnostics: errors.slice(0, 10) });
  }
  const fm = parsed.data || {};
  const notes = [];
  const baseName = String(fileName || '').replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '');
  const rawName = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : baseName;
  const agentId = id ? String(id).trim().toLowerCase() : slugifyAgentId(rawName);
  if (!agentId) throw new AgentRegistryError(400, 'claude_agent_unreadable', 'The file names no agent: its frontmatter has no name, and no file name was given.');
  if (!parsed.hasFrontmatter) notes.push('The file has no frontmatter: the whole text became the instructions.');

  let description = typeof fm.description === 'string' ? fm.description.replace(/\s+/g, ' ').trim() : '';
  if (description.length > AGENT_LIMITS.description) {
    description = `${description.slice(0, AGENT_LIMITS.description - 1).trimEnd()}…`;
    notes.push(`The description was cut to ${AGENT_LIMITS.description} characters.`);
  }
  let instructions = String(parsed.body || '').replace(/\r\n?/g, '\n').trim();
  if (instructions.length > AGENT_LIMITS.instructions) {
    instructions = instructions.slice(0, AGENT_LIMITS.instructions).trimEnd();
    notes.push(`The instructions were cut to ${AGENT_LIMITS.instructions} characters.`);
  }

  const model = typeof fm.model === 'string' && !CLAUDE_MODEL_INHERIT.has(fm.model.trim().toLowerCase()) ? fm.model.trim() : null;
  const effort = typeof fm.effort === 'string' && fm.effort.trim() ? fm.effort.trim().toLowerCase() : null;
  const tools = claudeToolNames(fm.tools);
  const servers = new Set();
  for (const name of tools || []) {
    // Claude Code writes an MCP tool as mcp__<server>__<tool> (or mcp__<server> for every tool of it).
    const match = /^mcp__(.+?)(?:__.*)?$/.exec(name);
    if (match && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(match[1]) && match[1].toLowerCase() !== 'synabun') servers.add(match[1]);
  }
  if (isObject(fm.mcpServers)) for (const name of Object.keys(fm.mcpServers)) if (/^[A-Za-z0-9._:-]{1,64}$/.test(name) && name.toLowerCase() !== 'synabun') servers.add(name);
  if (Array.isArray(fm.mcpServers)) for (const name of fm.mcpServers) if (typeof name === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(name) && name.toLowerCase() !== 'synabun') servers.add(name);
  const readOnly = (tools && tools.length > 0 && !tools.some((name) => CLAUDE_WRITE_TOOLS.has(name.toLowerCase().replace(/\(.*$/, '')))) || String(fm.permissionMode || '').toLowerCase() === 'plan';
  if (tools) notes.push(`Claude Code tools (${tools.slice(0, 12).join(', ')}${tools.length > 12 ? ', …' : ''}) are not SynaBun tool groups: the agent keeps the worker's default tools${readOnly ? ' and is read-only, because that list has nothing that writes' : ''}.`);
  if (servers.size) notes.push(`MCP servers named by the file: ${[...servers].join(', ')}.`);
  const skills = Array.isArray(fm.skills) ? fm.skills.filter((item) => typeof item === 'string').map((item) => item.trim().toLowerCase()).filter(Boolean)
    : (typeof fm.skills === 'string' ? fm.skills.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) : []);
  if (fm.color !== undefined) notes.push('The colour was left out: a SynaBun agent takes a style-guide token.');
  const known = new Set(['name', 'description', 'tools', 'model', 'effort', 'skills', 'color', 'mcpServers', 'permissionMode']);
  const dropped = Object.keys(fm).filter((key) => !known.has(key));
  if (dropped.length) notes.push(`Not carried over: ${dropped.slice(0, 12).join(', ')}.`);

  return {
    content: {
      id: agentId,
      name: rawName.replace(/\s+/g, ' ').slice(0, AGENT_LIMITS.name) || agentId,
      description,
      instructions,
      provider: 'claude-code',
      model,
      effort,
      tools: null,
      mcpServers: [...servers],
      capability: readOnly ? 'read-only' : 'workspace',
      skills,
      scope: scope ? scopeOf(scope) : { kind: 'global' },
    },
    notes,
  };
}

export function loadBuiltinAgents(path = new URL('./builtins.json', import.meta.url)) {
  try {
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('expected an array');
    return rows;
  } catch (error) {
    console.warn('Unable to load built-in agents:', error.message);
    return [];
  }
}

/**
 * @param {object} o
 * @param {string} o.dir DATA_HOME/data/agents
 * @param {object[]} [o.builtins] trusted definitions shipped with the application
 * @param {() => string|number} [o.now] the time (ISO text or epoch milliseconds)
 * @param {(event: object) => void} [o.emit] told of every change: { action, id, scope, revision, status }
 * @param {() => Iterable<string>|null} [o.knownMcpServers] the MCP servers that exist, for validation (null: not checked)
 */
export function createAgentRegistry({ dir, builtins = [], now = () => new Date().toISOString(), emit = () => {}, knownMcpServers = () => null } = {}) {
  if (!dir || typeof dir !== 'string') throw new Error('createAgentRegistry needs { dir }');
  // Shipped revision 1 lives only in the package. Owner revisions use the normal data directory.
  const library = new Map();
  const classAgents = new Map();
  const released = '2026-11-19T00:00:00.000Z';
  for (const row of Array.isArray(builtins) ? builtins : []) {
    try {
      const checked = validateAgentDefinition({ ...row, revision: 1, status: 'approved',
        author: { kind: 'system' }, createdAt: released, approvedAt: released }, { requireMeta: true });
      if (!checked.ok || row.id !== checked.value.id || checked.value.taskClasses.length !== 1 ||
          checked.value.scope.kind !== 'global' || library.has(row.id) || classAgents.has(checked.value.taskClasses[0])) {
        throw new Error(checked.errors[0]?.message || 'expected a unique global id and a unique task class');
      }
      library.set(row.id, checked.value);
      classAgents.set(checked.value.taskClasses[0], row.id);
    } catch (error) {
      console.warn('Skipping built-in agent:', row?.id, error.message);
    }
  }
  const stamp = () => iso(now());
  const announce = (event) => { try { emit(event); } catch { /* a listener's own failure */ } };
  const validationOptions = () => { let servers = null; try { servers = knownMcpServers() || null; } catch { servers = null; } return servers ? { knownMcpServers: servers } : {}; };

  // ── paths (an id is checked by shape and a scope key is computed: neither is ever a path a caller wrote) ──
  const agentDir = (id, scope) => join(dir, requireId(id), scopeKey(scope));
  const draftPath = (id, scope) => join(agentDir(id, scope), 'draft.json');
  const metaPath = (id, scope) => join(agentDir(id, scope), 'agent.json');
  const revisionsDir = (id, scope) => join(agentDir(id, scope), 'revisions');
  const revisionPath = (id, scope, n) => join(revisionsDir(id, scope), `${pad(n)}.json`);

  function readJson(path) {
    let text;
    try { text = readConfinedFile(dir, path, { maxBytes: REGISTRY_LIMITS.fileBytes, encoding: 'utf-8' }); } catch (error) {
      if (error?.code === 'ENOENT' || error?.status === 404) return undefined;
      throw error;
    }
    try { return JSON.parse(text); } catch { return null; }
  }
  function writeJson(path, value, { exclusive = false } = {}) {
    const data = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(data, 'utf8') > REGISTRY_LIMITS.fileBytes) throw new AgentRegistryError(413, 'too_large', 'The definition is too large to store.');
    if (exclusive) {
      try { writeConfinedFile(dir, path, data, { exclusive: true, mode: 0o600 }); } catch (error) {
        if (error?.code === 'EEXIST' || error?.status === 409) throw new AgentRegistryError(409, 'revision_exists', 'That revision already exists; a stored revision is never replaced.');
        throw error;
      }
      return;
    }
    replaceFileAtomic(path, data, { mode: 0o600 });
  }
  const ensureDirs = (id, scope) => mkdirSync(revisionsDir(id, scope), { recursive: true, mode: 0o700 });

  /**
   * A stored record → { definition, updatedAt, review, damaged }. A stored revision that no longer validates (its
   * content does not match its etag, a field is not what the contract holds) is kept and marked: it is never run.
   * A draft may be incomplete while it is worked on, so only one whose content was changed behind its etag, or
   * that is not a definition at all, is damaged.
   */
  function readRecord(path, { draft = false } = {}) {
    const raw = readJson(path);
    if (raw === undefined) return null;
    if (!isObject(raw) || !isObject(raw.definition)) return { definition: null, damaged: true, problems: [{ field: '', code: 'unreadable', message: 'The stored file is not an agent revision.' }] };
    const checked = validateAgentDefinition(raw.definition, { requireMeta: true });
    const problems = draft ? checked.errors.filter((error) => error.code === 'etag_mismatch' || error.field === 'id' || error.field === 'createdAt') : checked.errors;
    return {
      definition: checked.value,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : checked.value.createdAt,
      review: isObject(raw.review) ? raw.review : null,
      ...(problems.length ? { damaged: true, problems } : {}),
    };
  }
  const record = (definition, extra = {}) => ({ kind: 'synabun-agent-revision', definition, updatedAt: stamp(), ...extra });

  function revisionNumbers(id, scope) {
    let names = [];
    try { names = readdirSync(revisionsDir(id, scope)); } catch { return []; }
    return names.map((name) => REVISION_FILE_RE.exec(name)).filter(Boolean).map((match) => Number(match[1])).sort((a, b) => a - b);
  }

  /** Everything stored for one agent and scope, or null when there is none. */
  function load(id, scope) {
    const agentId = requireId(id);
    const where = scopeOf(scope);
    const bundled = where.kind === 'global' && library.get(agentId);
    const stored = existsSync(agentDir(agentId, where));
    if (!bundled && !stored) return null;
    const numbers = stored ? revisionNumbers(agentId, where) : [];
    const revisions = numbers.map((n) => ({ number: n, ...(readRecord(revisionPath(agentId, where, n)) || { definition: null, damaged: true }) }));
    let draft = stored ? readRecord(draftPath(agentId, where), { draft: true }) : null;
    // An approval writes the revision, then removes the draft: a draft whose number is already stored is that leftover.
    if (draft?.definition && numbers.includes(draft.definition.revision)) {
      try { unlinkSync(draftPath(agentId, where)); } catch { /* removed by the next write */ }
      draft = null;
    }
    const meta = stored ? readJson(metaPath(agentId, where)) : undefined;
    // An independently created owner agent (even a draft or damaged revision) keeps its entire history.
    if (bundled && meta == null && !numbers.includes(1) && (!draft || draft.definition?.revision > 1)) {
      revisions.unshift({ number: 1, definition: { ...structuredClone(bundled), source: 'builtin' }, updatedAt: bundled.createdAt });
    }
    if (!draft && !revisions.length) return null;
    const approved = [...revisions].reverse().find((rev) => rev.definition?.status === 'approved' && !rev.damaged) || null;
    return { id: agentId, scope: where, meta: isObject(meta) ? meta : null, draft, revisions, approved };
  }
  function require(id, scope) {
    const found = load(id, scope);
    if (!found) throw new AgentRegistryError(404, 'agent_not_found', `There is no agent "${String(id).slice(0, 80)}" in ${scopeOf(scope).kind === 'project' ? 'that project' : 'the global library'}.`);
    return found;
  }

  // ── views ──
  const revisionMeta = (rev) => (rev.definition ? {
    revision: rev.definition.revision, parentRevision: rev.definition.parentRevision, status: rev.definition.status, etag: rev.definition.etag,
    author: rev.definition.author, createdAt: rev.definition.createdAt, approvedAt: rev.definition.approvedAt, updatedAt: rev.updatedAt || null,
    ...(rev.review ? { review: rev.review } : {}), ...(rev.damaged ? { damaged: true } : {}),
  } : { revision: rev.number ?? null, damaged: true });

  function overallStatus(found) {
    if (found.approved) return 'approved';
    if (found.draft?.definition) return found.draft.definition.status;
    return 'withdrawn';
  }
  function summary(found) {
    const shown = found.approved?.definition || found.draft?.definition || [...found.revisions].reverse().find((rev) => rev.definition)?.definition || null;
    const times = [found.draft?.updatedAt, ...found.revisions.map((rev) => rev.updatedAt)].filter(Boolean).sort();
    return {
      id: found.id, scope: found.scope, ref: formatAgentRef({ id: found.id, scope: found.scope }),
      name: shown?.name || found.id, description: shown?.description || '',
      provider: shown?.provider || null, model: shown?.model || null, effort: shown?.effort || null,
      capability: shown?.capability || null, usesBrowser: !!shown?.usesBrowser, usesComputer: !!shown?.usesComputer,
      taskClasses: shown?.taskClasses || [], icon: shown?.icon || null, color: shown?.color || null,
      ...(shown?.source ? { source: shown.source } : {}),
      status: overallStatus(found),
      approvedRevision: found.approved?.definition.revision ?? null,
      approvedEtag: found.approved?.definition.etag ?? null,
      approvedAt: found.approved?.definition.approvedAt ?? null,
      draft: found.draft?.definition ? { ...revisionMeta(found.draft) } : null,
      revisionCount: found.revisions.length,
      createdAt: found.meta?.createdAt || shown?.createdAt || null,
      updatedAt: times.at(-1) || null,
      ...(found.draft?.damaged || found.revisions.some((rev) => rev.damaged) ? { damaged: true } : {}),
    };
  }
  function detail(found) {
    return {
      ...summary(found),
      draftDefinition: found.draft?.definition || null,
      approvedDefinition: found.approved?.definition || null,
      revisions: found.revisions.map(revisionMeta),
    };
  }
  /** A draft with what the page shows beside it: its problems and the softer findings. */
  function checks(definition) {
    const checked = validateAgentDefinition(definition, validationOptions());
    return { validation: { ok: checked.ok, errors: checked.errors }, warnings: lintAgentDefinition(definition) };
  }

  // ── listing ──
  /** The scope a folder `<id>/<key>` holds, read back from what is stored (the folder name is only its digest). */
  function storedScope(id, key) {
    if (!SCOPE_KEY_RE.test(key)) return null;
    if (key === 'global') return { kind: 'global' };
    let scope = null;
    try { const meta = readJson(join(dir, id, key, 'agent.json')); scope = isObject(meta?.scope) ? scopeOf(meta.scope) : null; } catch { scope = null; }
    return scope && scopeKey(scope) === key ? scope : null;
  }
  function scopeKeys(id) {
    let keys = [];
    try { keys = readdirSync(join(dir, id)); } catch { /* bundled only */ }
    if (library.has(id) && !keys.includes('global')) keys.push('global');
    return keys.sort();
  }

  function everyAgent() {
    let ids = [];
    try { ids = readdirSync(dir); } catch { /* a new installation has no owner agents */ }
    const out = [];
    for (const id of [...new Set([...ids, ...library.keys()])].sort()) {
      if (!ID_RE.test(id)) continue;
      for (const key of scopeKeys(id)) {
        const scope = storedScope(id, key);
        const found = scope ? load(id, scope) : null;
        if (found) out.push(found);
      }
    }
    return out;
  }

  /**
   * @param {object} [filter]
   * @param {'all'|'global'|'project'} [filter.scope] which library (default: all)
   * @param {string} [filter.projectPath] with scope `project`: the agents pinned to exactly that project
   * @param {string|string[]} [filter.status] approved | in_review | draft | withdrawn (the agent's overall status)
   * @param {string} [filter.q] text in the id, name or description
   */
  function list({ scope = 'all', projectPath = null, status = null, q = '' } = {}) {
    const wanted = status ? new Set([].concat(status).map((s) => String(s).trim().toLowerCase().replace(/-/g, '_'))) : null;
    const needle = String(q || '').trim().toLowerCase();
    const project = projectPath ? scopeOf({ kind: 'project', path: projectPath }) : null;
    return everyAgent().filter((found) => {
      if (scope === 'global' && found.scope.kind !== 'global') return false;
      if (scope === 'project' && (found.scope.kind !== 'project' || (project && !sameScope(found.scope, project)))) return false;
      if (wanted && !wanted.has(overallStatus(found)) && !(found.draft?.definition && wanted.has(found.draft.definition.status))) return false;
      if (needle) {
        const view = summary(found);
        if (![view.id, view.name, view.description].some((value) => String(value || '').toLowerCase().includes(needle))) return false;
      }
      return true;
    }).map(summary);
  }

  /** The scopes an id is stored under (the resolver walks them: a project's agent wins over the global one). */
  function scopesOf(id) {
    let agentId;
    try { agentId = requireId(id); } catch { return []; }
    return scopeKeys(agentId).map((key) => storedScope(agentId, key)).filter((scope) => scope && load(agentId, scope));
  }

  function get({ id, scope } = {}) { return detail(require(id, scope)); }
  function has({ id, scope } = {}) { try { return !!load(id, scope); } catch { return false; } }

  /** One stored revision's definition; `draft` is the working one. null when there is none. */
  function revision({ id, scope } = {}, which) {
    const found = load(id, scope);
    if (!found) return null;
    if (which === 'draft') return found.draft?.definition || null;
    if (which === 'approved' || which === 'current' || which === undefined || which === null) return found.approved?.definition || null;
    const n = Number(which);
    return found.revisions.find((rev) => rev.number === n)?.definition || null;
  }
  function revisions({ id, scope } = {}) { return require(id, scope).revisions.map(revisionMeta); }

  // ── drafts ──
  function draftBase(found) {
    return found.approved?.definition || [...found.revisions].reverse().find((rev) => rev.definition)?.definition || null;
  }
  function nextRevision(found) {
    return Math.max(0, ...found.revisions.map((rev) => rev.number)) + 1;
  }
  /** The revision a new draft is made over; an agent whose every stored revision is unreadable has none. */
  function requireBase(found) {
    const base = draftBase(found);
    if (!base) throw new AgentRegistryError(409, 'revision_damaged', 'None of this agent\'s stored revisions can be read, so no draft can be made over one.');
    return base;
  }
  function saveDraft(id, scope, definition, extra = {}) {
    ensureDirs(id, scope);
    writeJson(draftPath(id, scope), record(definition, extra));
    return definition;
  }
  function draftAnswer(found, definition, action) {
    const fresh = load(found.id, found.scope);
    announce({ action, id: found.id, scope: found.scope, revision: definition.revision, status: definition.status });
    return { agent: detail(fresh), draft: definition, etag: definition.etag, ...checks(definition) };
  }

  /**
   * A new agent: its first draft. The id and the scope are part of what is sent (`scope` defaults to the global
   * library). 409 `agent_exists` when that scope already has an agent of the id.
   * @param {object} input the content (any accepted spelling)
   * @param {{ author?: object|string }} [options]
   */
  function create(input, { author = 'owner' } = {}) {
    if (!isObject(input)) throw new AgentRegistryError(400, 'invalid_body', 'An agent definition is an object.');
    const types = typeErrors(contentInput(input));
    if (types.length) throw new AgentRegistryError(400, 'not_valid', types[0].message, { errors: types });
    const content = contentInput(input);
    const id = requireId(content.id);
    const scope = scopeOf(content.scope);
    if (load(id, scope)) throw new AgentRegistryError(409, 'agent_exists', `${scope.kind === 'project' ? 'That project' : 'The global library'} already has an agent "${id}".`);
    const definition = createDraft({ ...content, id, scope }, { now: stamp(), author });
    ensureDirs(id, scope);
    writeJson(metaPath(id, scope), { kind: 'synabun-agent', id, scope, createdAt: definition.createdAt });
    saveDraft(id, scope, definition);
    return draftAnswer({ id, scope }, definition, 'created');
  }

  /** The working draft, made over the newest revision when there is none yet. Changes nothing when one exists. */
  function openDraft({ id, scope } = {}, { author = 'owner' } = {}) {
    const found = require(id, scope);
    if (found.draft?.definition) return { agent: detail(found), draft: found.draft.definition, etag: found.draft.definition.etag, ...checks(found.draft.definition) };
    const base = requireBase(found);
    const definition = createDraft({}, { now: stamp(), base, revision: nextRevision(found), author });
    saveDraft(found.id, found.scope, definition);
    return draftAnswer(found, definition, 'draft_opened');
  }

  /**
   * Change the draft. `expectedEtag` is the etag the caller read: the draft's, or (when there is no draft yet and
   * this patch starts one) the newest revision's. A draft that is in review is not edited: it goes back first.
   * @throws 428 `etag_required`, 409 `etag_conflict` (with `currentEtag`), 409 `not_editable`, 409 `scope_changed`,
   *   400 `id_changed` / `not_valid`
   */
  function updateDraft({ id, scope } = {}, patch, { expectedEtag = null, author = null } = {}) {
    const found = require(id, scope);
    if (!isObject(patch)) throw new AgentRegistryError(400, 'invalid_body', 'A patch is an object of the fields to change.');
    const content = contentInput(patch);
    const types = typeErrors(content);
    if (types.length) throw new AgentRegistryError(400, 'not_valid', types[0].message, { errors: types });
    if (content.id !== undefined && content.id !== null && String(content.id).trim().toLowerCase() !== found.id) throw new AgentRegistryError(400, 'id_changed', 'A revision keeps the id of the agent it revises.', { field: 'id' });
    if (content.scope !== undefined && content.scope !== null && !sameScope(scopeOf(content.scope), found.scope)) {
      throw new AgentRegistryError(409, 'scope_changed', 'An agent stays in its library: copy it to the other one instead.', { field: 'scope' });
    }
    const current = found.draft?.definition || null;
    const base = current || requireBase(found);
    if (typeof expectedEtag !== 'string' || !ETAG_RE.test(expectedEtag)) throw new AgentRegistryError(428, 'etag_required', 'Name the etag you read (If-Match, or expectedEtag).', { currentEtag: base?.etag || null });
    if (base && expectedEtag !== base.etag) throw new AgentRegistryError(409, 'etag_conflict', 'The draft changed since you read it.', { currentEtag: base.etag, current: base });
    if (current && current.status !== 'draft') throw new AgentRegistryError(409, 'not_editable', 'This revision is in review: send it back to draft before changing it.', { revisionStatus: current.status });
    const { id: _id, scope: _scope, ...fields } = content;
    const definition = current
      ? normalizeAgentDefinition({ ...current, ...fields, id: found.id, scope: found.scope, status: 'draft', author: author || current.author, approvedAt: null })
      : createDraft(fields, { now: stamp(), base, revision: nextRevision(found), author: author || 'owner' });
    saveDraft(found.id, found.scope, definition);
    return draftAnswer(found, definition, 'draft_saved');
  }

  /** Throw the draft away (a draft only: one in review is withdrawn or sent back first). */
  function discardDraft({ id, scope } = {}, { expectedEtag = null } = {}) {
    const found = require(id, scope);
    const current = found.draft?.definition;
    if (!current) throw new AgentRegistryError(404, 'draft_not_found', 'This agent has no draft.');
    if (expectedEtag && expectedEtag !== current.etag) throw new AgentRegistryError(409, 'etag_conflict', 'The draft changed since you read it.', { currentEtag: current.etag });
    if (current.status !== 'draft') throw new AgentRegistryError(409, 'not_editable', 'A revision in review is withdrawn or sent back, not discarded.', { revisionStatus: current.status });
    try { unlinkSync(draftPath(found.id, found.scope)); } catch { /* already gone */ }
    announce({ action: 'draft_discarded', id: found.id, scope: found.scope, revision: current.revision });
    const left = load(found.id, found.scope);
    // An agent that was only ever a draft is gone with it.
    if (!left) { removeFolder(found.id, found.scope); return { agent: null, removed: true }; }
    return { agent: detail(left), removed: false };
  }

  // ── transitions ──
  function transitionError(error) {
    if (error instanceof AgentSchemaError) throw new AgentRegistryError(error.status || 400, error.code, error.message, { ...(error.errors ? { errors: error.errors } : {}), ...(error.from ? { from: error.from, to: error.to } : {}) });
    throw error;
  }
  function move(definition, to, actor) {
    try { return applyTransition(definition, to, { now: stamp(), actor }); } catch (error) { return transitionError(error); }
  }
  function requireDraft(found, expectedEtag) {
    const current = found.draft?.definition;
    if (!current) throw new AgentRegistryError(404, 'draft_not_found', 'This agent has no draft.');
    if (found.draft.damaged) throw new AgentRegistryError(409, 'revision_damaged', 'The stored draft no longer reads as a valid definition; fix it first.', { errors: found.draft.problems || [] });
    if (expectedEtag && expectedEtag !== current.etag) throw new AgentRegistryError(409, 'etag_conflict', 'The draft changed since you read it.', { currentEtag: current.etag, current });
    return current;
  }

  /** draft → in_review. The definition must be valid. */
  function submit({ id, scope } = {}, { actor = 'owner', expectedEtag = null, note = null } = {}) {
    const found = require(id, scope);
    const current = requireDraft(found, expectedEtag);
    const next = move(current, 'in_review', actor);
    saveDraft(found.id, found.scope, next, { review: { submittedAt: stamp(), submittedBy: normalizeAgentDefinition({ author: actor }).author, ...(note ? { note: String(note).slice(0, 2000) } : {}) } });
    return draftAnswer(found, next, 'submitted');
  }

  /** in_review → draft: the owner asks for changes, or the author takes it back to edit. */
  function requestChanges({ id, scope } = {}, { actor = 'owner', expectedEtag = null, note = null } = {}) {
    const found = require(id, scope);
    const current = requireDraft(found, expectedEtag);
    const next = move(current, 'draft', actor);
    saveDraft(found.id, found.scope, next, { review: { ...(found.draft.review || {}), returnedAt: stamp(), returnedBy: normalizeAgentDefinition({ author: actor }).author, ...(note ? { returnNote: String(note).slice(0, 2000) } : {}) } });
    return draftAnswer(found, next, 'changes_requested');
  }

  /**
   * The owner approves the draft: it becomes a stored revision, and the agent's current one. A draft the owner
   * did not send to review first is sent and approved in one step. `expectedEtag` is required: an approval belongs
   * to the content that was looked at.
   * @throws 403 `approval_requires_owner`, 428 `etag_required`, 409 `etag_conflict`, 400 `not_valid`
   */
  function approve({ id, scope } = {}, { actor = 'owner', expectedEtag = null, note = null } = {}) {
    const found = require(id, scope);
    if (typeof expectedEtag !== 'string' || !ETAG_RE.test(expectedEtag)) throw new AgentRegistryError(428, 'etag_required', 'Name the etag of the revision you are approving (If-Match, or expectedEtag).', { currentEtag: found.draft?.definition?.etag || null });
    let current = requireDraft(found, expectedEtag);
    if (current.status === 'draft') current = move(current, 'in_review', actor);
    const approved = move(current, 'approved', actor);
    ensureDirs(found.id, found.scope);
    writeJson(revisionPath(found.id, found.scope, approved.revision), record(approved, { review: { ...(found.draft.review || {}), decidedAt: stamp(), decision: 'approved', ...(note ? { decisionNote: String(note).slice(0, 2000) } : {}) } }), { exclusive: true });
    try { unlinkSync(draftPath(found.id, found.scope)); } catch { /* load() drops the leftover */ }
    announce({ action: 'approved', id: found.id, scope: found.scope, revision: approved.revision, status: 'approved' });
    return { agent: detail(load(found.id, found.scope)), revision: approved, etag: approved.etag };
  }

  /**
   * Withdraw a revision. With no `revision`: the working draft when there is one (it is kept as a withdrawn
   * revision), else the current approved revision. `all`: every approved revision and the draft, which takes the
   * agent out of use.
   * @returns {{ agent: object, withdrawn: number[] }}
   */
  function withdraw({ id, scope } = {}, { revision: which = null, all = false, actor = 'owner', note = null } = {}) {
    const found = require(id, scope);
    const done = [];
    const review = (rev) => ({ ...(rev?.review || {}), withdrawnAt: stamp(), withdrawnBy: normalizeAgentDefinition({ author: actor }).author, ...(note ? { withdrawNote: String(note).slice(0, 2000) } : {}) });
    let discarded = false;
    const withdrawDraft = () => {
      const current = found.draft?.definition;
      if (!current) return false;
      const next = move(current, 'withdrawn', actor);
      // A draft that never was a valid definition is not history: it is dropped, not stored as a revision.
      if (!validateAgentDefinition(next, { requireMeta: true }).ok) {
        try { unlinkSync(draftPath(found.id, found.scope)); } catch { /* already gone */ }
        discarded = true;
        return true;
      }
      ensureDirs(found.id, found.scope);
      writeJson(revisionPath(found.id, found.scope, next.revision), record(next, { review: review(found.draft) }), { exclusive: true });
      try { unlinkSync(draftPath(found.id, found.scope)); } catch { /* load() drops the leftover */ }
      done.push(next.revision);
      return true;
    };
    const withdrawStored = (rev) => {
      if (!rev?.definition) throw new AgentRegistryError(404, 'revision_not_found', 'There is no such revision.');
      if (rev.definition.source === 'builtin') throw new AgentRegistryError(409, 'builtin_read_only', 'Bundled revisions are read-only.');
      const next = move(rev.definition, 'withdrawn', actor);
      // The content of a stored revision is never changed: only its status moves.
      if (next.etag !== rev.definition.etag) throw new AgentRegistryError(500, 'revision_immutable', 'A stored revision cannot change its content.');
      writeJson(revisionPath(found.id, found.scope, rev.number), record(next, { review: review(rev) }));
      done.push(rev.number);
    };
    if (all) {
      withdrawDraft();
      for (const rev of found.revisions) if (rev.definition?.status === 'approved' && rev.definition.source !== 'builtin') withdrawStored(rev);
    } else if (which === null || which === undefined) {
      if (!withdrawDraft()) {
        if (!found.approved) throw new AgentRegistryError(409, 'invalid_transition', 'This agent has nothing to withdraw.');
        withdrawStored(found.approved);
      }
    } else if (which === 'draft' || Number(which) === found.draft?.definition?.revision) {
      if (!withdrawDraft()) throw new AgentRegistryError(404, 'draft_not_found', 'This agent has no draft.');
    } else {
      withdrawStored(found.revisions.find((rev) => rev.number === Number(which)));
    }
    if (!done.length && !discarded) throw new AgentRegistryError(409, 'invalid_transition', 'This agent has nothing to withdraw.');
    announce({ action: discarded && !done.length ? 'draft_discarded' : 'withdrawn', id: found.id, scope: found.scope, revisions: done, status: 'withdrawn' });
    const left = load(found.id, found.scope);
    if (!left) removeFolder(found.id, found.scope);
    return { agent: left ? detail(left) : null, withdrawn: done, ...(discarded ? { discarded: true } : {}) };
  }

  // ── removal ──
  function removeFolder(id, scope) {
    const folder = agentDir(id, scope);
    try { rmSync(folder, { recursive: true, force: true }); } catch { /* nothing to remove */ }
    try { rmdirSync(join(dir, requireId(id))); } catch { /* another scope still holds this id */ }
  }
  /** Delete an agent of one scope: its draft and every revision. Runs that pinned one keep what they started with. */
  function remove({ id, scope } = {}) {
    const found = require(id, scope);
    if (!found.draft && found.revisions.every((rev) => rev.definition?.source === 'builtin')) {
      throw new AgentRegistryError(409, 'builtin_read_only', 'Bundled agents are read-only. Open a draft to customize this agent.');
    }
    removeFolder(found.id, found.scope);
    announce({ action: 'deleted', id: found.id, scope: found.scope });
    return { removed: true, id: found.id, scope: found.scope };
  }

  // ── diff ──
  /**
   * What changed between two revisions. `from` / `to`: a number, `draft` or `approved`. Defaults: `to` is the draft
   * when there is one, else the current approved revision; `from` is what `to` was made over (null: a first revision).
   */
  function diff({ id, scope } = {}, { from = null, to = null } = {}) {
    const found = require(id, scope);
    const pick = (which) => {
      if (which === 'draft') return found.draft?.definition || null;
      if (which === 'approved' || which === 'current') return found.approved?.definition || null;
      return found.revisions.find((rev) => rev.number === Number(which))?.definition || null;
    };
    const after = to === null || to === undefined || to === '' ? (found.draft?.definition || found.approved?.definition) : pick(to);
    if (!after) throw new AgentRegistryError(404, 'revision_not_found', 'There is no such revision to compare.');
    let before = null;
    if (from !== null && from !== undefined && from !== '') {
      before = pick(from);
      if (!before) throw new AgentRegistryError(404, 'revision_not_found', 'There is no such revision to compare with.');
    } else if (after.parentRevision) before = pick(after.parentRevision);
    const side = (def) => (def ? { revision: def.revision, status: def.status, etag: def.etag } : null);
    return { id: found.id, scope: found.scope, from: side(before), to: side(after), ...diffDefinitions(before, after) };
  }

  // ── export / import ──
  /**
   * A JSON bundle of agents: for each, its current approved revision and its draft. `agents`: the ones to take
   * ({ id, scope }), default every agent.
   */
  function exportBundle({ agents = null } = {}) {
    const chosen = Array.isArray(agents) ? agents.map((key) => require(key.id, key.scope)) : everyAgent();
    return {
      format: AGENT_BUNDLE_FORMAT, version: AGENT_BUNDLE_VERSION, exportedAt: stamp(),
      agents: chosen.map((found) => ({
        id: found.id, scope: found.scope,
        approved: found.approved?.definition || null,
        draft: found.draft?.definition || null,
      })).filter((entry) => entry.approved || entry.draft),
    };
  }

  /**
   * Take the agents of a bundle in, each as a draft: nothing a bundle says is approved here. For an agent that
   * exists, the content becomes its draft over the current revision (`unchanged` when it is the same content).
   * @param {object} bundle an export, a list of definitions, or one definition
   * @param {object} [options]
   * @param {object|string} [options.author]
   * @param {object} [options.scope] put every agent in this scope instead of the one the bundle names
   * @param {boolean} [options.replaceDrafts] replace a draft that is already there (default: skip that agent)
   * @param {'approved'|'draft'} [options.prefer] which side of an entry to take when it has both (default approved)
   * @returns {{ results: { id, scope, action, reason?, errors?, revision?, etag? }[], imported: number }}
   */
  function importBundle(bundle, { author = 'owner', scope: forcedScope = null, replaceDrafts = false, prefer = 'approved' } = {}) {
    let entries;
    if (Array.isArray(bundle)) entries = bundle;
    else if (isObject(bundle) && Array.isArray(bundle.agents)) {
      if (bundle.format !== undefined && bundle.format !== AGENT_BUNDLE_FORMAT) throw new AgentRegistryError(400, 'invalid_bundle', `Not a SynaBun agents bundle (format "${String(bundle.format).slice(0, 40)}").`);
      if (Number(bundle.version) > AGENT_BUNDLE_VERSION) throw new AgentRegistryError(400, 'bundle_newer', 'This bundle was made by a newer SynaBun.');
      entries = bundle.agents;
    } else if (isObject(bundle) && (bundle.provider !== undefined || bundle.name !== undefined)) entries = [bundle];
    else throw new AgentRegistryError(400, 'invalid_bundle', 'Send a bundle ({ format: "synabun-agents", agents: [...] }), a list of definitions, or one definition.');
    if (entries.length > REGISTRY_LIMITS.bundleAgents) throw new AgentRegistryError(413, 'too_large', `A bundle holds at most ${REGISTRY_LIMITS.bundleAgents} agents.`);
    const target = forcedScope ? scopeOf(forcedScope) : null;
    const results = [];
    for (const entry of entries) {
      const source = isObject(entry) && (isObject(entry.approved) || isObject(entry.draft))
        ? (prefer === 'draft' ? (entry.draft || entry.approved) : (entry.approved || entry.draft))
        : entry;
      if (!isObject(source)) { results.push({ id: null, scope: null, action: 'invalid', reason: 'not a definition' }); continue; }
      const content = contentInput(source);
      let scope;
      try { scope = target || scopeOf(content.scope); } catch (error) { results.push({ id: String(content.id || '').slice(0, 80) || null, scope: null, action: 'invalid', reason: error.message }); continue; }
      const candidate = normalizeAgentDefinition({ ...content, scope });
      const checked = validateAgentDefinition({ ...contentOf(candidate) }, validationOptions());
      if (!checked.ok) { results.push({ id: candidate.id || null, scope, action: 'invalid', errors: checked.errors }); continue; }
      const found = load(candidate.id, scope);
      if (!found) {
        const made = create(contentOf(candidate), { author });
        results.push({ id: candidate.id, scope, action: 'created', revision: made.draft.revision, etag: made.etag });
        continue;
      }
      if (found.approved?.definition.etag === candidate.etag && !found.draft) { results.push({ id: candidate.id, scope, action: 'unchanged', revision: found.approved.definition.revision, etag: candidate.etag }); continue; }
      if (found.draft?.definition) {
        if (found.draft.definition.etag === candidate.etag) { results.push({ id: candidate.id, scope, action: 'unchanged', revision: found.draft.definition.revision, etag: candidate.etag }); continue; }
        if (!replaceDrafts) { results.push({ id: candidate.id, scope, action: 'skipped', reason: 'draft_exists' }); continue; }
        if (found.draft.definition.status !== 'draft') { results.push({ id: candidate.id, scope, action: 'skipped', reason: 'in_review' }); continue; }
      }
      const definition = createDraft(contentOf(candidate), { now: stamp(), base: draftBase(found), revision: nextRevision(found), author });
      saveDraft(found.id, found.scope, definition);
      announce({ action: 'draft_saved', id: found.id, scope: found.scope, revision: definition.revision, status: 'draft' });
      results.push({ id: candidate.id, scope, action: 'drafted', revision: definition.revision, etag: definition.etag });
    }
    return { results, imported: results.filter((row) => row.action === 'created' || row.action === 'drafted').length };
  }

  /**
   * A Claude Code agent file as a draft (parseClaudeAgent). For an agent that already exists in that scope the
   * content becomes its draft, unless one is already there (409 `draft_exists`; `replaceDraft` replaces a draft).
   */
  function importClaudeAgent(markdown, { fileName = '', id = null, scope = null, author = 'owner', replaceDraft = false } = {}) {
    const { content, notes } = parseClaudeAgent(markdown, { fileName, id, scope });
    const found = load(content.id, content.scope);
    if (!found) return { ...create(content, { author }), notes, action: 'created' };
    if (found.draft?.definition && (!replaceDraft || found.draft.definition.status !== 'draft')) {
      throw new AgentRegistryError(409, 'draft_exists', `Agent "${content.id}" already has a draft; change that one, or pass another id.`, { currentEtag: found.draft.definition.etag });
    }
    const definition = createDraft(content, { now: stamp(), base: draftBase(found), revision: nextRevision(found), author });
    saveDraft(found.id, found.scope, definition);
    return { ...draftAnswer(found, definition, 'draft_saved'), notes, action: 'drafted' };
  }

  /** A copy of an agent's newest content as a new draft under another id or in another scope. */
  function copy({ id, scope } = {}, { id: newId = null, scope: newScope = null, author = 'owner' } = {}) {
    const found = require(id, scope);
    const source = found.draft?.definition || draftBase(found);
    return create({ ...contentOf(source), id: newId || found.id, scope: newScope ? scopeOf(newScope) : found.scope }, { author });
  }

  /** How much is stored (for a status line and the tests). */
  function stats() {
    const all = everyAgent();
    let bytes = 0;
    const walk = (folder) => { let names = []; try { names = readdirSync(folder); } catch { return; } for (const name of names) { const path = join(folder, name); let st; try { st = statSync(path); } catch { continue; } if (st.isDirectory()) walk(path); else bytes += st.size; } };
    walk(dir);
    return { agents: all.length, approved: all.filter((found) => found.approved).length, drafts: all.filter((found) => found.draft).length, bytes };
  }

  return {
    dir,
    list, get, has, scopesOf, revision, revisions,
    builtinIdForClass: (taskClass) => classAgents.get(taskClass) || null,
    create, openDraft, updateDraft, discardDraft, copy,
    submit, requestChanges, approve, withdraw, remove,
    diff, exportBundle, importBundle, importClaudeAgent,
    validate: (input) => validateAgentDefinition(input, validationOptions()),
    lint: (input, options) => lintAgentDefinition(input, options),
    stats,
  };
}
