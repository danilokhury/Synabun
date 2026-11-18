// ═══════════════════════════════════════════
// SynaBun — Agents: native export and import (phase P6)
// ═══════════════════════════════════════════
//
// A SynaBun agent definition as the file a host reads its own agents from, and back. Two hosts have such a file in
// what SynaBun's adapters know:
//
//   Claude Code   <config dir>/agents/<id>.md, <project>/.claude/agents/<id>.md: YAML frontmatter (name, description,
//                 tools, model, and the newer effort / skills / mcpServers) and a body that is the agent's prompt.
//                 The reader is the registry's parseClaudeAgent (lib/agents/registry.js).
//   OpenCode      the `agents.<id>` entry of an `opencode.json` (OpenCode 2's schema, lib/opencode-config.js:
//                 `system`, `description`, `permissions` as rules). OpenCode has one document for many things, so
//                 the export is that one key, never a whole file.
//
// Codex and Antigravity have none: their adapters here read rules (AGENTS.md, GEMINI.md), prompts and skills, and
// none of those names a model, tools and limits for one agent. For them the answer says so (`supported: false`),
// with what to do instead; no format is made up.
//
// A native file holds less than a definition does. Every mapping says what it left out (`unrepresented`: the field,
// its value, why), so nobody reads a native agent as the reviewed one: the capability guard, the browser, the
// MoreLogin profile, SynaBun's tool groups, routing and revisions stay SynaBun's.
//
// Pure: no file, network or clock access. Where an export may be written, and the write itself, is
// lib/agents/native-export-targets.js; who may ask for it is lib/agents-studio-api.js (the owner's page only).

import { createHash } from 'node:crypto';
import * as YAML from 'yaml';
import { OPENCODE_CONFIG_SCHEMA, agentOf, opencodeAgentEntry, parseJsonc, permissionRule } from '../opencode-config.js';
import { AgentRegistryError, parseClaudeAgent, scopeOf, slugifyAgentId } from './registry.js';
import { AGENT_LIMITS, AGENT_PROVIDERS, normalizeAgentDefinition } from './schema.js';

export const NATIVE_EXPORT_VERSION = 1;
/** The largest OpenCode document an import reads (a user's opencode.json is a few kilobytes). */
export const OPENCODE_IMPORT_MAX_BYTES = 1024 * 1024;

export class NativeExportError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {object} [extra] */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'NativeExportError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * What each host has for an agent of its own. `kind`: `file` (one file per agent) or `entry` (one key of a document
 * that holds other things). `locations` are where the host reads it, in words (the real paths are the targets').
 */
const FORMATS = Object.freeze({
  'claude-code': Object.freeze({
    host: 'claude-code', supported: true, format: 'claude-agent-markdown', label: 'Claude Code agent file', kind: 'file',
    mediaType: 'text/markdown', imports: true,
    locations: Object.freeze({ account: '<Claude Code config dir>/agents/<id>.md', project: '<project>/.claude/agents/<id>.md' }),
    carries: Object.freeze(['id', 'description', 'instructions', 'model', 'effort', 'skills', 'mcpServers', 'capability (read-only)']),
  }),
  opencode: Object.freeze({
    host: 'opencode', supported: true, format: 'opencode-agent-entry', label: 'OpenCode agent entry (opencode.json, agents.<id>)', kind: 'entry',
    mediaType: 'application/json', imports: true,
    locations: Object.freeze({ account: '<OpenCode config dir>/opencode.json', project: '<project>/opencode.json' }),
    carries: Object.freeze(['id', 'description', 'instructions', 'capability (read-only)', 'permissionPolicy (ask)']),
  }),
  codex: Object.freeze({
    host: 'codex', supported: false, format: null, label: 'Codex', kind: null, imports: false,
    reason: 'Codex has no agent definition file that SynaBun reads or writes: its adapter knows rules (AGENTS.md), prompts and skills, and none of them names a model, tools and limits for one agent.',
    instead: 'Run the agent through SynaBun (agent_ref on a dispatch runs it on Codex when its provider is codex), or export a SynaBun bundle.',
  }),
  antigravity: Object.freeze({
    host: 'antigravity', supported: false, format: null, label: 'Antigravity', kind: null, imports: false,
    reason: 'Antigravity has no agent definition file that SynaBun reads or writes: its adapter knows rules (GEMINI.md), skills and MCP servers, and none of them names a model, tools and limits for one agent.',
    instead: 'Run the agent through SynaBun (agent_ref on a dispatch runs it on Antigravity when its provider is antigravity), or export a SynaBun bundle.',
  }),
});

/** One row per host SynaBun runs workers on (lib/agents/schema.js AGENT_PROVIDERS): what it has, or why it has nothing. */
export function nativeFormats() {
  return AGENT_PROVIDERS.map((host) => FORMATS[host] || { host, supported: false, format: null, label: host, kind: null, imports: false, reason: `SynaBun knows no agent definition file for ${host}.`, instead: 'Run the agent through SynaBun, or export a SynaBun bundle.' });
}

/** The row of one host. Throws 400 `unknown_host` for a host SynaBun does not run. */
export function nativeFormatOf(host) {
  const id = typeof host === 'string' ? host.trim().toLowerCase() : '';
  const row = nativeFormats().find((format) => format.host === id);
  if (!row) throw new NativeExportError(400, 'unknown_host', `host is one of ${AGENT_PROVIDERS.join(', ')}.`, { hosts: [...AGENT_PROVIDERS] });
  return row;
}

/** `sha256:<64 hex>` of a text as it would be written (UTF-8). */
export function nativeDigest(content) {
  return `sha256:${createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')}`;
}

/** Keys in one order at every depth, so the digest of an entry never depends on how its object was built. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
/** The digest of a JSON value (an OpenCode agent entry as a document holds it). */
export function entryDigest(entry) {
  return nativeDigest(JSON.stringify(canonical(entry ?? null)));
}

// ── what a native agent cannot hold ──────────────────────────────────────────

const WHY = Object.freeze({
  name: (host) => `${host} names an agent by its id: the display name is not kept.`,
  provider: (host, provider) => `The definition runs on ${provider}; this is ${host}'s own file, and what it runs there is ${host}'s to decide.`,
  model: (host, provider) => `The model belongs to ${provider}: it is not a model ${host} can be told to use.`,
  effort: (host, provider) => `The effort belongs to ${provider}.`,
  accountId: (host) => `A native agent runs in the account ${host} is signed in to.`,
  tools: () => 'SynaBun tool groups are served by SynaBun\'s MCP server: a native agent has them only as far as its session has that server.',
  mcpAll: (host) => `"*" (every MCP server you allow) has no form in a native file: the agent has the servers ${host} is configured with.`,
  workspace: (host) => `The workspace guard (writes inside the project, the temp folder and the run's scratch folder only) is SynaBun's worker guard: a native agent writes wherever ${host}'s own permissions let it.`,
  full: (host) => `Full capability is a SynaBun dispatch setting: a native agent writes wherever ${host}'s own permissions let it.`,
  readOnlyShell: () => 'A read-only SynaBun worker may still run read-only commands and the project\'s tests: a tool list cannot say that, so the agent has no shell.',
  policy: (host) => `The permission policy is how SynaBun's dispatcher answers a worker's permission requests: a native agent follows ${host}'s own permission mode.`,
  browser: () => 'The SynaBun browser is given to a dispatched worker: a native agent has no browser from this file.',
  computer: () => 'Computer use is granted to a dispatched worker by SynaBun: a native agent has none from this file.',
  profile: () => 'A MoreLogin profile is chosen by SynaBun for a dispatched worker\'s browser tab.',
  skillId: () => 'A library id (skl_…) names a skill of SynaBun\'s library: only skill names are carried.',
  memory: () => 'The memory category is part of the role block SynaBun gives a dispatched worker.',
  classes: () => 'Task classes are how SynaBun\'s Assistant picks an agent for a task.',
  icon: () => 'The icon is shown in SynaBun only.',
  color: () => 'The colour is a token of SynaBun\'s style guide.',
});

/** The findings every host shares: what is SynaBun's own and no native file holds. */
function sharedLosses(def, host, lost) {
  if (def.name && def.name !== def.id) lost('name', def.name, WHY.name(host));
  if (def.accountId) lost('accountId', def.accountId, WHY.accountId(host));
  if (def.tools !== null) lost('tools', def.tools, WHY.tools());
  if (def.usesBrowser) lost('usesBrowser', true, WHY.browser());
  if (def.usesComputer) lost('usesComputer', true, WHY.computer());
  if (def.moreloginProfile) lost('moreloginProfile', def.moreloginProfile, WHY.profile());
  if (def.memoryCategory) lost('memoryCategory', def.memoryCategory, WHY.memory());
  if (def.taskClasses.length) lost('taskClasses', def.taskClasses, WHY.classes());
  if (def.icon) lost('icon', def.icon, WHY.icon());
  if (def.color) lost('color', def.color, WHY.color());
}

const COPY_NOTE = 'A native file is a copy: SynaBun\'s review, revisions and run records do not follow it, and a later change of the agent does not update it.';

// ── Claude Code ──────────────────────────────────────────────────────────────

/** The tools of a Claude Code agent that only reads (the registry's reader takes a list without Write, Edit or Bash as read-only). */
const CLAUDE_READ_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}(?::[a-z0-9][a-z0-9-]{0,63})?$/;
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function claudeAgent(def) {
  const host = 'Claude Code';
  const unrepresented = [];
  const notes = [];
  const lost = (field, value, reason, extra = {}) => unrepresented.push({ field, value, reason, ...extra });
  const own = def.provider === 'claude-code';
  const fm = { name: def.id, description: def.description || def.name || def.id };
  if (!def.description) notes.push('The definition has no description: its name stands in, because Claude Code picks an agent by its description.');

  const servers = def.mcpServers.filter((name) => name !== '*' && SERVER_NAME_RE.test(name) && name.toLowerCase() !== 'synabun');
  if (def.mcpServers.includes('*')) lost('mcpServers', ['*'], WHY.mcpAll(host));
  if (def.capability === 'read-only') {
    // A list with nothing that writes: what the reader takes as read-only. The MCP servers it names are let in by name.
    fm.tools = [...CLAUDE_READ_TOOLS, ...servers.map((name) => `mcp__${name}`)].join(', ');
    // Carried, but not whole: `partial` says the field is in the file and this is what it does not say there.
    lost('capability', 'read-only', WHY.readOnlyShell(), { partial: true });
    if (servers.length) notes.push('The MCP servers are named in the tool list, so their tools are available: a server\'s tool that writes is not held back here, as SynaBun\'s read-only guard would.');
  } else {
    lost('capability', def.capability, def.capability === 'full' ? WHY.full(host) : WHY.workspace(host));
  }
  if (!own) {
    lost('provider', def.provider, WHY.provider(host, def.provider));
    if (def.model) lost('model', def.model, WHY.model(host, def.provider));
    if (def.effort) lost('effort', def.effort, WHY.effort(host, def.provider));
  }
  fm.model = own && def.model ? def.model : 'inherit';
  if (own && def.effort) fm.effort = def.effort;
  const skills = def.skills.filter((ref) => SKILL_NAME_RE.test(ref));
  const skillIds = def.skills.filter((ref) => !SKILL_NAME_RE.test(ref));
  if (skills.length) fm.skills = skills;
  if (skillIds.length) lost('skills', skillIds, WHY.skillId());
  if (servers.length) fm.mcpServers = servers;
  if (def.permissionPolicy !== 'auto') lost('permissionPolicy', def.permissionPolicy, WHY.policy(host));
  sharedLosses(def, host, lost);
  if (!def.instructions) notes.push('The definition has no instructions: the file has an empty body.');
  notes.push(COPY_NOTE);

  const yaml = YAML.stringify(fm, { lineWidth: 0 });
  const content = `---\n${yaml}---\n\n${def.instructions}${def.instructions ? '\n' : ''}`;
  return { fileName: `${def.id}.md`, content, frontmatter: fm, unrepresented, notes };
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

function openCodeAgent(def) {
  const host = 'OpenCode';
  const unrepresented = [];
  const notes = [];
  const lost = (field, value, reason) => unrepresented.push({ field, value, reason });
  const own = def.provider === 'opencode';
  const entry = {};
  if (def.description) entry.description = def.description;
  if (def.instructions) entry.system = def.instructions;
  else notes.push('The definition has no instructions: the entry has no system prompt.');

  const rules = [];
  if (def.capability === 'read-only') {
    // What SynaBun's own read-only OpenCode agent is made of (lib/assistant-brains/opencode.js): no edits, every command asks.
    rules.push(permissionRule('edit', 'deny'), permissionRule('shell', 'ask'));
    if (def.permissionPolicy === 'ask') notes.push('The "ask" policy is in the read-only rules already: edits are refused and every command asks.');
    else if (def.permissionPolicy !== 'auto') lost('permissionPolicy', def.permissionPolicy, WHY.policy(host));
  } else {
    lost('capability', def.capability, def.capability === 'full' ? WHY.full(host) : WHY.workspace(host));
    if (def.permissionPolicy === 'ask') rules.push(permissionRule('edit', 'ask'), permissionRule('shell', 'ask'));
    else if (def.permissionPolicy !== 'auto') lost('permissionPolicy', def.permissionPolicy, WHY.policy(host));
  }
  if (rules.length) entry.permissions = rules;

  if (!own) lost('provider', def.provider, WHY.provider(host, def.provider));
  // SynaBun writes no model into an OpenCode agent entry anywhere, so it has no checked form for one: left out
  // rather than guessed, because a document OpenCode cannot read stops OpenCode.
  if (def.model) lost('model', def.model, own ? 'SynaBun has no checked form for a model in an OpenCode agent entry: pick the model in OpenCode.' : WHY.model(host, def.provider));
  if (def.effort) lost('effort', def.effort, own ? 'An OpenCode agent entry has no effort: pick the variant in OpenCode.' : WHY.effort(host, def.provider));
  if (def.mcpServers.length) lost('mcpServers', def.mcpServers, def.mcpServers.includes('*') ? WHY.mcpAll(host) : 'An OpenCode agent has the MCP servers of its configuration: a list per agent is not part of the entry.');
  if (def.skills.length) lost('skills', def.skills, 'An OpenCode agent entry names no skills: OpenCode offers the skills of its folders to every agent.');
  sharedLosses(def, host, lost);
  notes.push('The entry sets no `mode`: OpenCode decides whether the agent is a primary agent or a subagent; add `mode` in opencode.json to choose.');
  notes.push('An `opencode.jsonc` beside the file wins over it: an agent of this id there replaces this entry.');
  notes.push(COPY_NOTE);

  const document = { $schema: OPENCODE_CONFIG_SCHEMA, agents: { [def.id]: entry } };
  return { fileName: 'opencode.json', content: `${JSON.stringify(document, null, 2)}\n`, entry, entryPath: `agents.${def.id}`, unrepresented, notes };
}

/**
 * A definition as `host`'s native agent.
 *
 * @param {object} definition a definition in any accepted spelling (it is normalized first)
 * @param {string} host one of the worker providers
 * @returns {{
 *   host: string, supported: true, format: string, label: string, kind: 'file'|'entry', mediaType: string,
 *   fileName: string, content: string, digest: string, entry?: object, entryPath?: string, entryDigest?: string,
 *   unrepresented: { field: string, value: any, reason: string, partial?: true }[], notes: string[],
 * } | { host: string, supported: false, format: null, label: string, reason: string, instead: string, unrepresented: [], notes: string[] }}
 *   `content` is the text of the file (for OpenCode: a document that holds only the agent's entry; a write merges
 *   that one key into the user's own file and leaves the rest of it as it is).
 * @throws {NativeExportError} 400 `unknown_host`, 400 `not_exportable` (a definition without an id)
 */
export function exportNative(definition, host) {
  const format = nativeFormatOf(host);
  if (!format.supported) {
    return { host: format.host, supported: false, format: null, label: format.label, reason: format.reason, instead: format.instead, unrepresented: [], notes: [format.instead] };
  }
  const def = normalizeAgentDefinition(definition);
  if (!def.id || slugifyAgentId(def.id) !== def.id) throw new NativeExportError(400, 'not_exportable', 'The definition has no usable id: a native agent is named by it.');
  const made = format.host === 'claude-code' ? claudeAgent(def) : openCodeAgent(def);
  return {
    host: format.host, supported: true, format: format.format, label: format.label, kind: format.kind, mediaType: format.mediaType,
    fileName: made.fileName, content: made.content, digest: nativeDigest(made.content),
    ...(made.entry ? { entry: made.entry, entryPath: made.entryPath, entryDigest: entryDigest(made.entry) } : {}),
    unrepresented: made.unrepresented, notes: made.notes,
  };
}

// ── back: a native agent as the content of a draft ───────────────────────────

const modelText = (value) => {
  if (typeof value === 'string') return value.trim() || null;
  if (!isObject(value)) return null;
  const provider = typeof value.providerID === 'string' ? value.providerID.trim() : '';
  const model = [value.modelID, value.id, value.model].find((part) => typeof part === 'string' && part.trim());
  return provider && model ? `${provider}/${model.trim()}` : null;
};
const ruleFor = (rules, action, effect) => rules.some((rule) => isObject(rule) && rule.action === action && rule.effect === effect && (rule.resource === undefined || rule.resource === '*'));

/**
 * An OpenCode agent as the content of a SynaBun agent draft, with what was mapped and what was left out. Pure.
 * @param {string|object} source the text of an opencode.json / .jsonc, the document as an object, or one agent entry
 * @param {{ name?: string, id?: string, scope?: object }} [options] `name`: which agent of the document (needed when
 *   it holds more than one, or when `source` is an entry)
 * @returns {{ content: object, notes: string[] }}
 * @throws {AgentRegistryError} 400 `opencode_agent_unreadable`, 413 `too_large`
 */
export function parseOpenCodeAgent(source, { name = '', id = null, scope = null } = {}) {
  let value = source;
  if (typeof source === 'string') {
    if (!source.trim()) throw new AgentRegistryError(400, 'opencode_agent_unreadable', 'Send the text of an opencode.json, or one agent entry.');
    if (Buffer.byteLength(source, 'utf8') > OPENCODE_IMPORT_MAX_BYTES) throw new AgentRegistryError(413, 'too_large', `An OpenCode document is at most ${OPENCODE_IMPORT_MAX_BYTES / 1024} KB.`);
    try { value = parseJsonc(source); } catch (error) { throw new AgentRegistryError(400, 'opencode_agent_unreadable', `The document could not be read: ${error?.message || 'it is not JSON'}.`); }
  }
  if (!isObject(value)) throw new AgentRegistryError(400, 'opencode_agent_unreadable', 'An OpenCode document, or one agent entry, is a JSON object.');
  const notes = [];
  let wanted = typeof name === 'string' ? name.trim() : '';
  let entry;
  const holds = isObject(value.agents) || isObject(value.agent);
  if (holds) {
    const names = [...new Set([...Object.keys(isObject(value.agent) ? value.agent : {}), ...Object.keys(isObject(value.agents) ? value.agents : {})])];
    if (!wanted) {
      if (names.length !== 1) throw new AgentRegistryError(400, 'opencode_agent_unreadable', names.length ? `The document holds ${names.length} agents: name the one to take (${names.slice(0, 12).join(', ')}).` : 'The document holds no agent.', { agents: names.slice(0, 50) });
      [wanted] = names;
    }
    if (!names.includes(wanted)) throw new AgentRegistryError(400, 'opencode_agent_unreadable', `The document has no agent "${wanted.slice(0, 80)}".`, { agents: names.slice(0, 50) });
    entry = agentOf(value, wanted);
  } else {
    if (!wanted) throw new AgentRegistryError(400, 'opencode_agent_unreadable', 'Name the agent: an entry does not hold its own name.');
    entry = opencodeAgentEntry(value);
  }
  const agentId = id ? String(id).trim().toLowerCase() : slugifyAgentId(wanted);
  if (!agentId) throw new AgentRegistryError(400, 'opencode_agent_unreadable', 'The agent\'s name gives no usable id: pass one.');

  let description = typeof entry.description === 'string' ? entry.description.replace(/\s+/g, ' ').trim() : '';
  if (description.length > AGENT_LIMITS.description) {
    description = `${description.slice(0, AGENT_LIMITS.description - 1).trimEnd()}…`;
    notes.push(`The description was cut to ${AGENT_LIMITS.description} characters.`);
  }
  let instructions = typeof entry.system === 'string' ? entry.system.replace(/\r\n?/g, '\n').trim() : '';
  if (instructions.length > AGENT_LIMITS.instructions) {
    instructions = instructions.slice(0, AGENT_LIMITS.instructions).trimEnd();
    notes.push(`The instructions were cut to ${AGENT_LIMITS.instructions} characters.`);
  }
  const rules = Array.isArray(entry.permissions) ? entry.permissions : [];
  const readOnly = ruleFor(rules, 'edit', 'deny');
  const asks = !readOnly && (ruleFor(rules, 'edit', 'ask') || ruleFor(rules, 'shell', 'ask'));
  if (rules.length) notes.push(`Permission rules read: ${readOnly ? 'edits are refused, so the agent is read-only' : asks ? 'edits or commands ask, so the policy is "ask"' : 'none that changes the capability or the policy'}. Other rules are not carried over.`);
  const model = modelText(entry.model);
  const known = new Set(['description', 'system', 'model', 'permissions']);
  const dropped = Object.keys(entry).filter((key) => !known.has(key));
  if (dropped.length) notes.push(`Not carried over: ${dropped.slice(0, 12).join(', ')}.`);
  notes.push('OpenCode\'s tools are not SynaBun tool groups: the agent keeps the worker\'s default tools.');

  return {
    content: {
      id: agentId,
      name: wanted.replace(/\s+/g, ' ').slice(0, AGENT_LIMITS.name) || agentId,
      description,
      instructions,
      provider: 'opencode',
      model,
      tools: null,
      mcpServers: [],
      capability: readOnly ? 'read-only' : 'workspace',
      permissionPolicy: asks ? 'ask' : 'auto',
      scope: scope ? scopeOf(scope) : { kind: 'global' },
    },
    notes,
  };
}

/**
 * A host's native agent as the content of a draft: `{ content, notes }`. Nothing is stored and nothing is approved:
 * the registry lands it as a draft (lib/agents/registry.js create / importClaudeAgent).
 * @param {string} host
 * @param {string|object} source the file's text (Claude Code: markdown; OpenCode: JSON, or an entry object)
 * @param {{ fileName?: string, name?: string, id?: string, scope?: object }} [options]
 * @throws {NativeExportError} 400 `unknown_host`, 400 `no_native_format`; the readers' own errors otherwise
 */
export function importNative(host, source, { fileName = '', name = '', id = null, scope = null } = {}) {
  const format = nativeFormatOf(host);
  if (!format.supported) throw new NativeExportError(400, 'no_native_format', format.reason, { host: format.host, instead: format.instead });
  if (format.host === 'claude-code') return parseClaudeAgent(source, { fileName, id, scope });
  return parseOpenCodeAgent(source, { name, id, scope });
}
