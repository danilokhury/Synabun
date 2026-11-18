// ═══════════════════════════════════════════
// SynaBun — Agents: from an `agent_ref` to a run (phase P1)
// ═══════════════════════════════════════════
//
// A dispatch may name an agent: `agent_ref: "release-notes"` (also `release-notes@3`, `global:release-notes`,
// `project:release-notes@2`; lib/agents/schema.js parseAgentRef). This module turns that into the fields the
// dispatcher takes, and is the only place that decides how a definition and a dispatch combine:
//
//   1. Where the agent is looked up: the project the run is for first (a definition pinned to the run's folder or
//      to a folder above it, the deepest one first), then the global library. Only an approved revision is used;
//      an id nobody has is AGENT_UNKNOWN, one with nothing approved is AGENT_NOT_APPROVED.
//   2. Who wins: what the dispatch says itself always wins over the definition. An approved route's provider,
//      model, effort and account stay binding (the router writes them over the spec after this module ran). The
//      definition fills everything the dispatch left out.
//   3. A definition never widens what the session or the dispatch allows. What it asks for beyond that is taken
//      down, and said: each such change is a correction on the run and in the dispatch's answer.
//        capability   `full` with browser or computer use needs the dispatch's own "user-authorized-full" tag
//                     (the dispatcher's rule); without it the agent runs as `workspace`. A ceiling the caller
//                     gives (`limits.capability`) is kept too.
//        computer     off for a session whose Computer toggle is off.
//        MCP servers  only the ones the dispatcher would deliver to that provider in that folder (asked of the
//                     dispatcher's own check, so the two can never disagree); the rest are left out.
//        browser      a dispatch that says `uses_browser: false` gets no browser groups and no MoreLogin profile
//                     from the definition.
//      One thing is refused instead of taken down: a MoreLogin profile the owner has not allowed agents to choose.
//      It goes through the dispatcher's own check like a dispatch's `morelogin_profile` and the run does not start
//      (MORELOGIN_PROFILE_NOT_ALLOWED), because the alternative is the default browser, which is another identity:
//      the dispatcher never puts a run there in place of the profile it was meant for.
//   4. What the run keeps: the ref, the revision number and the etag it resolved to (`agentRef`, `agentRevision`,
//      `agentPin` on the run record), so a later edit of the agent does not change a run under way, and the
//      definition's instructions as a delimited role block at the top of the run's context.
//
// Reads the registry (lib/agents/registry.js); writes nothing.

import { sep } from 'node:path';
import { isBrowserGroup } from '../../../mcp-server/dist/services/tool-catalog.js';
import { resolveToolList } from '../../../mcp-server/dist/services/tool-list.js';
import {
  AGENT_CAPABILITIES, dispatchFields, formatAgentRef, isRunnable, normalizeAgentDefinition, parseAgentRef, resolutionOrder, sameScope,
  validateAgentDefinition,
} from './schema.js';

/** The tag a dispatch carries when the user asked for a full-capability run that reads pages or drives the desktop. */
export const FULL_AUTHORIZED_TAG = 'user-authorized-full';
export const ROLE_BLOCK_OPEN = '=== AGENT ROLE';
export const ROLE_BLOCK_CLOSE = '=== END AGENT ROLE ===';

/**
 * Where a resolved agent rides on a dispatch spec, from this module to the run record. A symbol: a request body
 * cannot carry one, so nothing a caller sends can pass for a resolved agent.
 */
export const AGENT_PIN = Symbol('synabun.agentPin');

export class AgentResolveError extends Error {
  /** @param {string} code @param {number} status @param {string} message @param {object} [extra] */
  constructor(code, status, message, extra = {}) {
    super(message);
    this.name = 'AgentResolveError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
  toJSON() {
    const { name: _name, ...rest } = { ...this };
    return { ...rest, code: this.code, message: this.message };
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const given = (value) => value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
const firstGiven = (...values) => values.find(given);
const flag = (value) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined);
const projectPathOf = (path) => (given(path) ? normalizeAgentDefinition({ scope: { kind: 'project', path: String(path) } }).scope.path : null);
/** Is `child` the folder `parent`, or inside it? Both normalized, compared as text. */
function isWithin(parent, child) {
  if (!parent || !child) return false;
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}
const CAPABILITY_RANK = Object.freeze(Object.fromEntries(AGENT_CAPABILITIES.map((name, index) => [name, index])));

/** The ref a dispatch names, under either spelling. undefined when it names none. */
export function agentRefOf(spec) {
  if (!isObject(spec)) return undefined;
  const ref = firstGiven(spec.agentRef, spec.agent_ref);
  return ref === undefined ? undefined : String(ref).trim();
}

/**
 * The scopes a ref is looked up in for a run in `projectPath`, first match wins: every project the registry has
 * that agent pinned to and that the run's folder is (or is inside), the deepest first, then the global library.
 * A worker of a team runs in `<project>/.worktrees/<team>/<slice>`: the project's agents are its agents too.
 * @param {{ id: string, scope: string|null }} parsed a parseAgentRef result
 * @param {{ kind: string, path?: string }[]} stored the scopes that id is stored under
 * @param {string|null} projectPath
 */
export function lookupOrder(parsed, stored, projectPath = null) {
  if (parsed?.scope === 'global') return resolutionOrder(parsed, null);
  const cwd = projectPathOf(projectPath);
  const projects = (stored || [])
    .filter((scope) => scope.kind === 'project' && cwd && isWithin(scope.path, cwd))
    .sort((a, b) => b.path.length - a.path.length);
  return [
    ...projects.flatMap((scope) => resolutionOrder({ ...parsed, scope: 'project' }, scope.path)),
    ...(parsed?.scope === 'project' ? [] : resolutionOrder({ ...parsed, scope: 'global' }, null)),
  ];
}

/**
 * The approved revision a ref names.
 * @param {string} ref
 * @param {object} o
 * @param {object} o.registry lib/agents/registry.js
 * @param {string|null} [o.projectPath] the folder the run is for
 * @returns {{ definition: object, id: string, revision: number, etag: string, scope: object, name: string, ref: string, requested: string }}
 *   `ref` is the pinned form (`global:release-notes@3`): what resolves to this same revision again.
 * @throws {AgentResolveError} AGENT_REF_INVALID (400), AGENT_UNKNOWN (404), AGENT_NOT_APPROVED (409)
 */
export function resolveAgentRef(ref, { registry, projectPath = null } = {}) {
  const requested = typeof ref === 'string' ? ref.trim() : '';
  const parsed = parseAgentRef(requested);
  if (!parsed) {
    throw new AgentResolveError('AGENT_REF_INVALID', 400, `"${requested.slice(0, 80)}" is not an agent ref. Write an agent id from agent_catalog ("release-notes"), optionally with a revision ("release-notes@3") or a library ("global:release-notes", "project:release-notes").`, { agentRef: requested.slice(0, 200) });
  }
  if (!registry) throw new AgentResolveError('AGENTS_UNAVAILABLE', 503, 'Agents are not available on this server.', { agentRef: requested });
  const stored = registry.scopesOf(parsed.id);
  const seen = [];
  for (const scope of lookupOrder(parsed, stored, projectPath)) {
    if (!stored.some((other) => sameScope(other, scope))) continue;
    const key = { id: parsed.id, scope };
    const definition = registry.revision(key, parsed.revision ?? 'approved');
    if (!definition || !isRunnable(definition)) {
      let status = definition?.status || null;
      if (!status) { try { status = parsed.revision ? 'no_such_revision' : registry.get(key).status; } catch { status = 'unreadable'; } }
      seen.push({ scope: scope.kind, ...(scope.kind === 'project' ? { path: scope.path } : {}), status });
      continue;
    }
    return {
      definition, id: definition.id, revision: definition.revision, etag: definition.etag, scope: definition.scope, name: definition.name,
      ref: formatAgentRef({ id: definition.id, revision: definition.revision, scope: definition.scope }), requested,
    };
  }
  if (!seen.length) {
    const where = parsed.scope === 'global' ? 'the global library' : parsed.scope === 'project' ? 'this project' : 'this project or the global library';
    throw new AgentResolveError('AGENT_UNKNOWN', 404, `There is no agent "${parsed.id}" in ${where}. agent_catalog lists the agents that can run (agents).`, { agentRef: requested, agentId: parsed.id });
  }
  const what = parsed.revision ? `Revision ${parsed.revision} of agent "${parsed.id}" is not approved` : `Agent "${parsed.id}" has no approved revision`;
  throw new AgentResolveError('AGENT_NOT_APPROVED', 409, `${what} (${seen.map((row) => `${row.scope}: ${String(row.status).replace(/_/g, ' ')}`).join('; ')}). Only a revision the owner approved runs: ask the owner to review it in Agents, or dispatch without agent_ref.`, { agentRef: requested, agentId: parsed.id, found: seen });
}

// ── the role block ───────────────────────────────────────────────────────────

/**
 * A definition's instructions as the block a worker reads: delimited, named, and placed first in the run's
 * context. The task, the user's brief and SynaBun's own rules for the run stay above it.
 */
export function agentRoleBlock(definition, { ref = null } = {}) {
  const def = normalizeAgentDefinition(definition);
  // A line of the instructions that looks like one of the block's own fences is not one.
  const body = def.instructions.split('\n').map((line) => (/^\s*===\s*(?:END\s+)?AGENT ROLE/i.test(line) ? line.replace(/===/g, '= = =') : line)).join('\n');
  const lines = [
    `${ROLE_BLOCK_OPEN}: ${def.name || def.id} (agent ${ref || def.id}, revision ${def.revision}) ===`,
    `You run as the SynaBun agent "${def.name || def.id}". What follows says who that agent is and how it works; do the TASK as that agent. The TASK, the user's brief and SynaBun's rules for this run come first where they differ.`,
  ];
  if (def.description) lines.push(`What this agent is for: ${def.description}`);
  lines.push('', body || '(This agent has no instructions of its own.)');
  const extras = [];
  if (def.skills.length) extras.push(`Skills this agent works with, when they fit the task: ${def.skills.join(', ')}.`);
  if (def.memoryCategory) extras.push(`Memory: file what this agent learns under the category "${def.memoryCategory}", unless the task names another.`);
  if (extras.length) lines.push('', ...extras);
  lines.push(ROLE_BLOCK_CLOSE);
  return lines.join('\n');
}

/** A context without any role block (a run that is dispatched again carries its context along). */
export function stripRoleBlocks(context) {
  const text = typeof context === 'string' ? context : '';
  if (!text.includes(ROLE_BLOCK_OPEN)) return text.trim();
  const out = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (!inside && line.startsWith(ROLE_BLOCK_OPEN)) { inside = true; continue; }
    if (inside) { if (line.trim() === ROLE_BLOCK_CLOSE) inside = false; continue; }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The run's context with the role block first. */
export function withRoleBlock(context, block) {
  const rest = stripRoleBlocks(context);
  return rest ? `${block}\n\n${rest}` : block;
}

// ── a definition over a dispatch ─────────────────────────────────────────────

const correction = (field, from, to, reason, text) => ({ field, from, to, reason, text });

/** The SynaBun groups a tool list names that drive the browser (`all` names every one). */
function browserGroupsOf(tools) {
  const groups = (Array.isArray(tools) ? tools : []).filter((item) => typeof item === 'string' && !item.startsWith('mcp:'));
  const read = resolveToolList(groups, { source: 'runtime' });
  return read.ok ? read.groups.filter(isBrowserGroup) : [];
}

/**
 * The MCP servers of a list the dispatcher would deliver, asked of its own check (`resolveExternalTools`, which
 * refuses a list that names one it cannot deliver and says which). → { kept, dropped: [{ ref, reason }] }.
 * Without a check, a caller's own list (`allowed`: names, or `*`) decides; with neither, nothing is known and the
 * list is left as it is: the dispatcher still checks it when it builds the run.
 */
function deliverableServers(refs, { resolveExternalTools = null, spec = {}, allowed = null } = {}) {
  let kept = [...refs];
  const dropped = [];
  if (Array.isArray(allowed) || allowed === '*') {
    const names = allowed === '*' ? null : new Set(allowed.map(String));
    for (const ref of [...kept]) {
      if (ref === 'mcp:*' ? allowed !== '*' && !names.has('*') : names && !names.has(ref.slice(4))) {
        kept = kept.filter((item) => item !== ref);
        dropped.push({ ref, reason: 'not_allowed' });
      }
    }
  }
  if (typeof resolveExternalTools === 'function') {
    for (let round = 0; round < 3 && kept.length; round += 1) {
      try { resolveExternalTools(spec, kept); break; } catch (error) {
        const problems = Array.isArray(error?.problems) ? error.problems.filter((problem) => typeof problem?.item === 'string' && kept.includes(problem.item)) : [];
        // A check that fails without naming an item (a provider whose MCP settings cannot be read) proves nothing
        // about any of them: none is taken.
        const bad = problems.length ? problems : kept.map((item) => ({ item, reason: error?.code === 'MCP_DISCOVERY_FAILED' ? 'unverified' : (error?.code ? String(error.code).toLowerCase() : 'unverified') }));
        for (const problem of bad) dropped.push({ ref: problem.item, reason: String(problem.reason || 'unavailable') });
        kept = kept.filter((item) => !bad.some((problem) => problem.item === item));
      }
    }
  }
  return { kept, dropped };
}

/**
 * A dispatch spec with a definition applied: what the spec says wins, the definition fills the rest, and nothing
 * the definition asks for goes past what the session and the dispatch allow.
 *
 * @param {object} rawSpec the dispatch as the dispatcher received it (its own spelling: provider, model, effort,
 *   accountId, tools, capability, permissionPolicy, usesBrowser, usesComputer, moreloginProfile, tags, cwd, context)
 * @param {object} definition an AgentDefinition
 * @param {object} [ctx]
 * @param {string|null} [ctx.assistantSessionId]
 * @param {{ sessionAllows?(id): boolean }|null} [ctx.desktop] computer use (lib/desktop/service.js)
 * @param {Function|null} [ctx.resolveExternalTools] the dispatcher's own MCP server check
 * @param {{ capability?: string, usesComputer?: boolean, mcpServers?: string[]|'*', moreloginProfiles?: string[]|((name: string) => boolean) }} [ctx.limits]
 *   ceilings the caller sets on top (a server that wires none leaves the dispatcher's own checks to decide)
 * @param {string} [ctx.ref] the pinned ref, for the role block
 * @returns {{ spec: object, corrections: object[], filled: string[] }} `spec` is a copy; `filled` names the fields
 *   the definition supplied
 */
export function applyAgent(rawSpec = {}, definition, ctx = {}) {
  const def = normalizeAgentDefinition(definition);
  const fields = dispatchFields(def);
  const limits = isObject(ctx.limits) ? ctx.limits : {};
  const spec = { ...rawSpec };
  delete spec.agentRef;
  delete spec.agent_ref;
  const corrections = [];
  const filled = [];
  const fill = (key, value) => { spec[key] = value; filled.push(key); };
  const tags = Array.isArray(rawSpec.tags) ? rawSpec.tags.map((tag) => String(tag).trim()) : [];
  const name = def.name || def.id;

  // ── what it runs on ──
  const provider = given(rawSpec.provider) ? String(rawSpec.provider).trim().toLowerCase() : fields.provider;
  if (!given(rawSpec.provider)) fill('provider', provider);
  const sameProvider = provider === fields.provider;
  if (sameProvider) {
    // "auto" is the dispatch saying it has no preference (the dispatcher reads it as no model): the agent's applies.
    const modelSaid = given(rawSpec.model) && String(rawSpec.model).trim().toLowerCase() !== 'auto';
    if (!modelSaid && fields.model) fill('model', fields.model);
    if (!given(rawSpec.effort) && fields.effort) fill('effort', fields.effort);
    if (!given(firstGiven(rawSpec.accountId, rawSpec.codexAccountId, rawSpec.claudeAccountId)) && fields.accountId) fill('accountId', fields.accountId);
  } else if (fields.model || fields.effort || fields.accountId) {
    corrections.push(correction('provider', fields.provider, provider, 'explicit_provider', `agent ${name}: the dispatch runs on ${provider}, not the agent's ${fields.provider}, so the agent's model, effort and account were not applied`));
  }
  if (!given(rawSpec.permissionPolicy)) fill('permissionPolicy', fields.permissionPolicy);

  // ── browser: the dispatch's own word first ──
  const browserSaid = flag(rawSpec.usesBrowser);
  if (browserSaid === undefined && fields.usesBrowser) fill('usesBrowser', true);

  // ── tools and MCP servers ──
  if (!Array.isArray(rawSpec.tools) && Array.isArray(fields.tools)) {
    let tools = [...fields.tools];
    if (browserSaid === false) {
      const browser = browserGroupsOf(tools);
      if (browser.length) {
        const read = resolveToolList(tools.filter((item) => !item.startsWith('mcp:')), { source: 'runtime' });
        const groups = (read.ok ? read.groups : tools.filter((item) => !item.startsWith('mcp:'))).filter((id) => !browser.includes(id));
        corrections.push(correction('tools', browser, [], 'browser_off', `agent ${name}: the dispatch says uses_browser false, so the agent's browser groups (${browser.join(', ')}) were left out`));
        tools = [...groups, ...tools.filter((item) => item.startsWith('mcp:'))];
      }
    }
    fill('tools', tools);
  }

  // ── MoreLogin profile ──
  const profileSaid = firstGiven(rawSpec.moreloginProfile, rawSpec.morelogin_profile, rawSpec.moreloginEnvId, rawSpec.morelogin_env_id);
  if (!given(profileSaid) && fields.moreloginProfile) {
    const allowed = limits.moreloginProfiles;
    const refused = typeof allowed === 'function' ? allowed(fields.moreloginProfile) !== true : Array.isArray(allowed) ? !allowed.map(String).includes(fields.moreloginProfile) : false;
    if (browserSaid === false) {
      corrections.push(correction('moreloginProfile', fields.moreloginProfile, null, 'browser_off', `agent ${name}: the dispatch says uses_browser false, so the agent's MoreLogin profile "${fields.moreloginProfile}" was not used`));
    } else if (refused) {
      corrections.push(correction('moreloginProfile', fields.moreloginProfile, null, 'profile_not_allowed', `agent ${name}: MoreLogin profile "${fields.moreloginProfile}" is not one this session may use and was left out`));
    } else fill('moreloginProfile', fields.moreloginProfile);
  }

  // ── computer use ──
  const computerSaid = flag(rawSpec.usesComputer);
  if (computerSaid === undefined && fields.usesComputer) {
    let allowed = limits.usesComputer !== false;
    let reason = 'computer_not_allowed';
    if (allowed && ctx.assistantSessionId && typeof ctx.desktop?.sessionAllows === 'function') {
      try { allowed = ctx.desktop.sessionAllows(String(ctx.assistantSessionId)) !== false; } catch { allowed = false; }
      reason = 'computer_session_off';
    }
    if (allowed) fill('usesComputer', true);
    else corrections.push(correction('usesComputer', true, false, reason, `agent ${name}: computer use is ${reason === 'computer_session_off' ? 'switched off for this assistant session' : 'not allowed for this run'}, so the agent runs without it (the user turns the Computer toggle on)`));
  }

  // ── capability: the definition's is a request, the session's and the dispatch's ceiling stands ──
  if (!given(rawSpec.capability)) {
    let capability = fields.capability;
    const ceiling = given(limits.capability) && CAPABILITY_RANK[limits.capability] !== undefined ? limits.capability : null;
    if (ceiling && CAPABILITY_RANK[capability] > CAPABILITY_RANK[ceiling]) {
      corrections.push(correction('capability', capability, ceiling, 'capability_ceiling', `agent ${name}: capability "${capability}" is more than this session allows; it runs as "${ceiling}"`));
      capability = ceiling;
    }
    const reads = flag(spec.usesBrowser) === true || browserGroupsOf(spec.tools).length > 0;
    const drives = flag(spec.usesComputer) === true;
    if (capability === 'full' && (reads || drives) && !tags.includes(FULL_AUTHORIZED_TAG)) {
      corrections.push(correction('capability', 'full', 'workspace', 'full_not_authorized', `agent ${name}: capability "full" with ${drives ? 'computer' : 'browser'} use needs the dispatch's own "${FULL_AUTHORIZED_TAG}" tag (an explicit request of the user); it runs as "workspace"`));
      capability = 'workspace';
    }
    fill('capability', capability);
  }

  // ── MCP servers: last, so the dispatcher's own check reads the run as it will be ──
  if (filled.includes('tools')) {
    const refs = spec.tools.filter((item) => item.startsWith('mcp:'));
    if (refs.length) {
      const { kept, dropped } = deliverableServers(refs, { resolveExternalTools: ctx.resolveExternalTools, spec: { ...spec, provider }, allowed: limits.mcpServers ?? null });
      if (dropped.length) {
        spec.tools = [...spec.tools.filter((item) => !item.startsWith('mcp:')), ...kept];
        corrections.push(correction('mcpServers', refs.map((ref) => ref.slice(4)), kept.map((ref) => ref.slice(4)), 'mcp_not_available', `agent ${name}: MCP server${dropped.length === 1 ? '' : 's'} ${dropped.map((row) => `${row.ref.slice(4)} (${row.reason.replace(/[-_]/g, ' ')})`).join(', ')} ${dropped.length === 1 ? 'is' : 'are'} not available to this run and ${dropped.length === 1 ? 'was' : 'were'} left out`));
      }
    }
  }

  // ── the role block ──
  spec.context = withRoleBlock(rawSpec.context, agentRoleBlock(def, { ref: ctx.ref || null }));
  return { spec, corrections, filled };
}

// ── the run record ───────────────────────────────────────────────────────────

/** The pin a prepared spec carries, or null. */
export function agentPinOf(input) {
  const pin = isObject(input) ? input[AGENT_PIN] : null;
  return isObject(pin) ? pin : null;
}

/**
 * Write a resolved agent onto a run record as it is created: `agentRef` (the pinned ref), `agentRevision`, and
 * `agentPin` ({ id, revision, etag, scope, name, requested, corrections }), plus a note per correction. Does
 * nothing for a dispatch without an agent.
 */
export function stampAgentRun(entry, input) {
  const pin = agentPinOf(input);
  if (!pin || !isObject(entry)) return entry;
  entry.agentRef = pin.ref;
  entry.agentRevision = pin.revision;
  entry.agentPin = {
    id: pin.id, revision: pin.revision, etag: pin.etag, scope: pin.scope, name: pin.name, requested: pin.requested,
    ...(pin.status && pin.status !== 'approved' ? { status: pin.status, test: true } : {}),
    corrections: pin.corrections || [],
  };
  if (!Array.isArray(entry.notes)) entry.notes = [];
  entry.notes.push(`runs as agent "${pin.name}" (${pin.ref}${pin.status && pin.status !== 'approved' ? `, ${pin.status}: a test run` : ''})`);
  for (const item of pin.corrections || []) if (item?.text && !entry.notes.includes(item.text)) entry.notes.push(item.text);
  return entry;
}

/** The corrections of a prepared spec, for the dispatch's answer. */
export function agentCorrections(input) {
  return agentPinOf(input)?.corrections || [];
}

/** A run that is dispatched again as another run (an escalation, a retry) keeps the agent it ran as. */
export function carryAgentRun(parent, child) {
  if (!isObject(parent) || !isObject(child) || !parent.agentRef || child.agentRef) return child;
  child.agentRef = parent.agentRef;
  child.agentRevision = parent.agentRevision ?? null;
  if (isObject(parent.agentPin)) child.agentPin = { ...parent.agentPin };
  return child;
}

// ── the resolver ─────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {object} o.registry lib/agents/registry.js
 * @param {(ctx: object) => object|null} [o.limits] ceilings for a run on top of the dispatcher's own checks
 *   ({ capability, usesComputer, mcpServers, moreloginProfiles }), asked per dispatch
 */
export function createAgentResolver({ registry, limits = null } = {}) {
  if (!registry) throw new Error('createAgentResolver needs { registry }');

  const resolve = (ref, { projectPath = null } = {}) => resolveAgentRef(ref, { registry, projectPath });

  /** A definition applied to a spec, with its pin on the result. */
  function prepare(rawSpec, resolved, ctx = {}) {
    let extra = null;
    try { extra = typeof limits === 'function' ? limits({ ...ctx, rawSpec, definition: resolved.definition }) : limits; } catch { extra = null; }
    const applied = applyAgent(rawSpec, resolved.definition, { ...ctx, ref: resolved.ref, limits: { ...(isObject(extra) ? extra : {}), ...(isObject(ctx.limits) ? ctx.limits : {}) } });
    applied.spec[AGENT_PIN] = {
      id: resolved.id, revision: resolved.revision, etag: resolved.etag, scope: resolved.scope, name: resolved.name || resolved.id,
      ref: resolved.ref, requested: resolved.requested || resolved.ref, status: resolved.definition.status,
      corrections: applied.corrections, filled: applied.filled,
    };
    return applied.spec;
  }

  /**
   * The dispatcher's intake: a spec that names an agent comes back with the agent applied; one that names none
   * comes back as it is.
   * @param {object} rawSpec
   * @param {{ assistantSessionId?: string|null, origin?: string, desktop?: object|null, resolveExternalTools?: Function|null }} [ctx]
   */
  function intake(rawSpec = {}, ctx = {}) {
    const ref = agentRefOf(rawSpec);
    if (ref === undefined) return rawSpec;
    const resolved = resolve(ref, { projectPath: firstGiven(rawSpec.cwd, rawSpec.project) ?? null });
    return prepare(rawSpec, resolved, ctx);
  }

  /**
   * A spec for a run of one stored revision, approved or not: the owner's test run of a draft
   * (lib/agents-studio-api.js). Never reached from a dispatch's `agent_ref`.
   */
  function prepareRevision(rawSpec, definition, ctx = {}) {
    const def = normalizeAgentDefinition(definition);
    const checked = validateAgentDefinition(def);
    if (!checked.ok) throw new AgentResolveError('AGENT_NOT_VALID', 400, 'The definition has errors; fix them before running it.', { errors: checked.errors });
    return prepare(rawSpec, {
      definition: def, id: def.id, revision: def.revision, etag: def.etag, scope: def.scope, name: def.name,
      ref: formatAgentRef({ id: def.id, revision: def.revision, scope: def.scope }), requested: ctx.requested || null,
    }, ctx);
  }

  /**
   * agent_route: a proposal that names an agent gets the provider, model, effort and account the agent runs on,
   * where the proposal leaves them out. A proposal with an agent is a dispatch: an agent is a worker.
   * @param {object} body the agent_route request
   * @returns {object} the body, with such proposals filled (the same object when none names an agent)
   */
  function expandProposals(body = {}) {
    if (!isObject(body) || !Array.isArray(body.proposals) || !body.proposals.some((proposal) => agentRefOf(proposal) !== undefined)) return body;
    const projectPath = firstGiven(body.cwd, body.project) ?? null;
    const proposals = body.proposals.map((proposal) => {
      const ref = agentRefOf(proposal);
      if (ref === undefined) return proposal;
      const resolved = resolve(ref, { projectPath });
      const fields = dispatchFields(resolved.definition);
      const provider = given(proposal.provider) ? proposal.provider : fields.provider;
      const same = provider === fields.provider;
      const account = firstGiven(proposal.account_id, proposal.accountId);
      return {
        ...proposal, kind: 'dispatch', provider,
        ...(same && !given(proposal.model) && fields.model ? { model: fields.model } : {}),
        ...(same && !given(proposal.effort) && fields.effort ? { effort: fields.effort } : {}),
        ...(same && !given(account) && fields.accountId ? { account_id: fields.accountId } : {}),
        ...(given(proposal.reason) ? {} : { reason: `agent ${resolved.name || resolved.id}` }),
        agent_ref: resolved.ref,
      };
    });
    return { ...body, proposals };
  }

  /**
   * The agents that can run, as agent_catalog lists them. With `projectPath`: what a run in that folder would
   * get for each id (the project's own agent in place of the global one of the same id).
   */
  function runnable({ projectPath = null } = {}) {
    const rows = [];
    const taken = new Set();
    const approved = registry.list({ status: 'approved' }).filter((agent) => agent.approvedRevision);
    const cwd = projectPathOf(projectPath);
    const ordered = cwd
      ? [...approved.filter((agent) => agent.scope.kind === 'project' && isWithin(agent.scope.path, cwd)).sort((a, b) => b.scope.path.length - a.scope.path.length), ...approved.filter((agent) => agent.scope.kind === 'global')]
      : approved;
    for (const agent of ordered) {
      if (cwd) { if (taken.has(agent.id)) continue; taken.add(agent.id); }
      rows.push({
        ref: formatAgentRef({ id: agent.id, scope: agent.scope }), id: agent.id, name: agent.name, description: agent.description,
        provider: agent.provider, model: agent.model, effort: agent.effort, taskClasses: agent.taskClasses,
        scope: agent.scope.kind, ...(agent.scope.kind === 'project' ? { projectPath: agent.scope.path } : {}),
        revision: agent.approvedRevision, capability: agent.capability, usesBrowser: agent.usesBrowser, usesComputer: agent.usesComputer,
      });
    }
    return rows;
  }

  return { registry, resolve, prepare, prepareRevision, intake, expandProposals, runnable };
}

// ── one resolver for the process ─────────────────────────────────────────────
// The dispatcher and the Assistant's API take the resolver as a dependency; where none is handed to them they ask
// here (server.js sets it once, in its Agents block). A test passes its own and never sets this one.

let current = null;
/** Make `resolver` the one the dispatcher and the Assistant's API use (null: none). */
export function setAgentResolver(resolver) { current = resolver || null; return current; }
export function getAgentResolver() { return current; }

const resolverOf = (agents) => { try { return (typeof agents === 'function' ? agents() : agents) || null; } catch { return null; } };

/**
 * The dispatcher's one call: `rawSpec` with the agent it names applied, or `rawSpec` itself when it names none.
 * A spec that names an agent on a server with no resolver is refused, never started as a plain worker.
 * @param {object|(() => object)|null} agents a resolver (createAgentResolver), or what returns one
 */
export function agentIntake(agents, rawSpec = {}, ctx = {}) {
  const ref = agentRefOf(rawSpec);
  if (ref === undefined) return rawSpec;
  const resolver = resolverOf(agents);
  if (!resolver) throw new AgentResolveError('AGENTS_UNAVAILABLE', 503, 'This dispatch names an agent, and agents are not available on this server. Nothing was started.', { agentRef: ref.slice(0, 200) });
  return resolver.intake(rawSpec, ctx);
}

/** agent_route's proposals with their agents filled in; the body itself when there is nothing to fill. */
export function expandAgentProposals(agents, body = {}) {
  if (!isObject(body) || !Array.isArray(body.proposals) || !body.proposals.some((proposal) => agentRefOf(proposal) !== undefined)) return body;
  const resolver = resolverOf(agents);
  if (!resolver) throw new AgentResolveError('AGENTS_UNAVAILABLE', 503, 'A proposal names an agent, and agents are not available on this server.');
  return resolver.expandProposals(body);
}
