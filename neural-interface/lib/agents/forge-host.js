// ═══════════════════════════════════════════
// SynaBun — Agents: what agent-forge reads from this server (phase P6)
// ═══════════════════════════════════════════
//
// agent-forge is the workflow the Assistant follows to turn a request into an agent definition (the shipped skill
// `skills/agent-forge`, read through the MCP tool `agent_definition` action "guide"). To fill a definition without
// guessing it needs what exists here: the providers and their models and efforts, the tool groups, the MCP servers,
// the colour tokens, the MoreLogin profiles agents may choose, the registered projects. None of that is a list kept
// in this file: each piece is asked of the part of the server that owns it (the Assistant's catalog, the tool
// catalog, the style guide, the browser settings), handed over by server.js.
//
// It also holds the two things that touch the disk for agent-forge and native export, each confined:
//   - the guide: one file of the shipped skill folder, by a name the folder itself lists;
//   - a Claude Code agent file given by its path: read only from an agents folder Claude Code reads (an account's
//     `agents/`, a registered project's `.claude/agents/`), never from anywhere else on the disk.
// Where a native export is written is lib/agents/native-export-targets.js, made here from the same folders.

import os from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { toolCatalogView } from '../../../mcp-server/dist/services/tool-catalog.js';
import { readConfinedFile } from '../confined-fs.js';
import { PathConfineError, isInside, realPathOf } from '../path-confine.js';
import { collectFolder } from '../skills/bundle.js';
import { createNativeExportTargets } from './native-export-targets.js';
import { REGISTRY_LIMITS } from './registry.js';
import { AGENT_ACCOUNT_PROVIDERS, AGENT_PROVIDERS } from './schema.js';

/** The shipped skill agent-forge is (skills/agent-forge). */
export const AGENT_FORGE = 'agent-forge';
export const FORGE_LIMITS = Object.freeze({
  /** Models listed per provider (a provider with more is searched: `provider` + `q`). */
  models: 40,
  /** Colour tokens listed. */
  colorTokens: 120,
  mcpServers: 100,
  projects: 200,
  moreloginProfiles: 100,
  /** One file of the guide. */
  guideBytes: 512 * 1024,
});

export class AgentForgeError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {object} [extra] */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AgentForgeError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const arr = (value) => (Array.isArray(value) ? value : []);
const text = (value, max = 400) => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * The colour tokens a style guide defines, as an agent's `color` names them ("group.key": lib/agents/schema.js).
 * A status colour, a semantic role, a step of a palette. Pure.
 * @param {object|null} config a style guide (lib/style-guide/schema.js), or null
 * @returns {string[]}
 */
export function colorTokensOf(config) {
  if (!isObject(config?.colors)) return [];
  const out = [];
  const keys = (map) => (isObject(map) ? Object.keys(map) : []);
  for (const key of keys(config.colors.status)) out.push(`status.${key}`);
  const theme = config.colors.themes?.default;
  const semantic = isObject(config.colors.semantic) ? (config.colors.semantic[theme] || Object.values(config.colors.semantic).find(isObject)) : null;
  for (const key of keys(semantic)) out.push(`semantic.${key}`);
  for (const [name, palette] of Object.entries(isObject(config.colors.palettes) ? config.colors.palettes : {})) {
    for (const step of keys(palette?.steps)) out.push(`${name}.${step}`);
  }
  return [...new Set(out.filter((token) => /^[A-Za-z0-9-]{1,40}\.[A-Za-z0-9-]{1,40}$/.test(token)))];
}

/** One model row, as much of it as a definition needs. */
function modelRow(row) {
  return {
    id: row.id, ...(row.label && row.label !== row.id ? { label: text(row.label, 80) } : {}),
    tier: row.tier || null, vision: row.vision ?? null,
    ...(arr(row.efforts).length ? { efforts: row.efforts } : {}),
    ...(row.defaultEffort ? { defaultEffort: row.defaultEffort } : {}),
    ...(row.default ? { default: true } : {}),
  };
}

/**
 * @param {object} o
 * @param {string} o.skillsDir the folder of the skills SynaBun ships (PACKAGE_ROOT/skills)
 * @param {(q: { provider?: string|null, q?: string|null }) => Promise<object|null>} [o.catalog] the Assistant's model
 *   catalog in its brain view (lib/assistant-catalog.js get), or null while the Assistant is not built
 * @param {(projectPath: string) => object|null} [o.styleGuide] a project's style guide, or null
 * @param {() => { envId: string, name: string|null }[]} [o.moreloginProfiles] the profiles the owner lets agents choose
 * @param {() => { path: string, label?: string }[]} [o.projects] the registered projects
 * @param {() => string} o.claudeHome Claude Code's config dir
 * @param {() => { id: string, home: string }[]} [o.claudeHomes] every Claude Code account's config dir (default: the one)
 * @param {() => string} o.opencodeConfigDir OpenCode's configuration folder
 * @param {string} [o.homeDir] the user's home folder (for a path written `~/…`)
 * @param {(event: object) => void} [o.onExport] told when the owner wrote a native export
 */
export function createAgentForgeHost({
  skillsDir, catalog = async () => null, styleGuide = () => null, moreloginProfiles = () => [], projects = () => [],
  claudeHome, claudeHomes = null, opencodeConfigDir, homeDir = os.homedir(), onExport = () => {},
} = {}) {
  if (!skillsDir || typeof claudeHome !== 'function' || typeof opencodeConfigDir !== 'function') throw new Error('createAgentForgeHost needs { skillsDir, claudeHome, opencodeConfigDir }');
  const projectList = () => { try { return arr(projects()).filter((p) => p && typeof p.path === 'string' && p.path); } catch { return []; } };
  const isRegisteredProject = (path) => typeof path === 'string' && !!path && projectList().some((p) => resolve(p.path) === resolve(path));
  const targets = createNativeExportTargets({ claudeHome, opencodeConfigDir, isRegisteredProject });

  // ── the guide ──
  /**
   * One file of the shipped agent-forge skill: `SKILL.md`, or one the folder lists. A link in the folder is never
   * followed and a name the folder does not list is not a path that is tried.
   * @returns {{ skill: string, path: string, files: string[], content: string }}
   * @throws {AgentForgeError} 404 `guide_missing` / `file_not_found`
   */
  function guide(file = 'SKILL.md') {
    const wanted = typeof file === 'string' && file ? file : 'SKILL.md';
    let files;
    try { files = collectFolder(realPathOf(join(skillsDir, AGENT_FORGE))).files; } catch { files = []; }
    const names = files.map((entry) => entry.path).filter((path) => !path.startsWith('evals/'));
    if (!names.includes('SKILL.md')) throw new AgentForgeError(404, 'guide_missing', 'This SynaBun ships no agent-forge.');
    const entry = files.find((item) => item.path === wanted && names.includes(item.path));
    if (!entry) throw new AgentForgeError(404, 'file_not_found', `agent-forge has no file "${wanted.slice(0, 200)}".`, { files: names });
    if (entry.bytes.length > FORGE_LIMITS.guideBytes) throw new AgentForgeError(413, 'too_large', 'That file of the guide is too large to send.');
    return { skill: AGENT_FORGE, path: entry.path, files: names, content: entry.bytes.toString('utf-8') };
  }

  // ── the catalog a definition is filled from ──
  /**
   * @param {{ provider?: string|null, q?: string|null, projectPath?: string|null }} [query] `provider` and `q` narrow
   *   the models (a provider with more than the limit is searched this way); `projectPath` picks whose colour tokens
   * @returns {Promise<object>} see docs/agents.md → agent-forge
   */
  async function describe({ provider = null, q = null, projectPath = null } = {}) {
    const wantedProvider = AGENT_PROVIDERS.includes(provider) ? provider : null;
    let view = null;
    try { view = await catalog({ provider: wantedProvider, q: q ? text(q, 200) : null }); } catch { view = null; }
    const models = {};
    const providers = [];
    for (const id of AGENT_PROVIDERS) {
      if (wantedProvider && id !== wantedProvider) continue;
      const rows = arr(view?.models?.[id]);
      models[id] = rows.slice(0, FORGE_LIMITS.models).map(modelRow);
      const info = arr(view?.providers).find((row) => row?.id === id) || {};
      const accounts = AGENT_ACCOUNT_PROVIDERS.includes(id)
        ? arr(view?.accounts?.[id]).map((row) => ({ id: row?.id, ...(row?.label ? { label: text(row.label, 80) } : {}) })).filter((row) => typeof row.id === 'string' && row.id).slice(0, 20)
        : null;
      providers.push({
        id, efforts: arr(info.efforts), permissionPolicies: arr(info.permissionPolicies),
        priced: info.priced !== false, source: view?.sources?.[id] || (view ? 'unknown' : 'unavailable'),
        ...(rows.length > FORGE_LIMITS.models ? { more: rows.length - FORGE_LIMITS.models } : {}),
        ...(accounts ? { accounts } : {}),
      });
    }
    // The tool groups are the tool catalog's own (the one list: mcp-server tool-catalog.ts); never a copy kept here.
    const tools = toolCatalogView();
    let servers = [];
    try { servers = arr(view?.tools?.servers); } catch { servers = []; }
    const project = projectPath && isRegisteredProject(projectPath) ? resolve(projectPath) : null;
    let guideOf = null;
    try { guideOf = project ? styleGuide(project) : null; } catch { guideOf = null; }
    let profiles = [];
    try { profiles = arr(moreloginProfiles()); } catch { profiles = []; }
    const tokens = colorTokensOf(guideOf);
    return {
      modelsAvailable: !!view,
      providers, models,
      toolGroups: tools.groups.map((group) => ({ id: group.id, label: group.label, purpose: group.purpose, browser: group.browser })),
      defaultTools: tools.default,
      mcpServers: servers.filter((row) => row && typeof row.ref === 'string').slice(0, FORGE_LIMITS.mcpServers).map((row) => ({
        name: row.ref.replace(/^mcp:/, ''), ...(row.selectable === false ? { selectable: false } : {}),
        providers: Object.fromEntries(Object.entries(isObject(row.providers) ? row.providers : {}).filter(([id]) => AGENT_PROVIDERS.includes(id))),
      })),
      colorTokens: { project, source: project ? (tokens.length ? 'style-guide' : 'none') : 'no-project', tokens: tokens.slice(0, FORGE_LIMITS.colorTokens) },
      moreloginProfiles: profiles.filter((row) => row && typeof row.envId === 'string').slice(0, FORGE_LIMITS.moreloginProfiles).map((row) => ({ envId: row.envId, name: row.name || null })),
      projects: projectList().slice(0, FORGE_LIMITS.projects).map((p) => ({ path: p.path, label: text(p.label || '', 200) || basename(p.path) })),
    };
  }

  // ── a Claude Code agent file, by its path ──
  /** The agents folders Claude Code reads here: every account's, and every registered project's. */
  function claudeAgentFolders() {
    let homes = [];
    try { homes = typeof claudeHomes === 'function' ? arr(claudeHomes()).map((row) => row?.home).filter((home) => typeof home === 'string' && home) : []; } catch { homes = []; }
    let own = null;
    try { own = claudeHome(); } catch { own = null; }
    const bases = [...new Set([own, ...homes].filter(Boolean).map((home) => join(resolve(home), 'agents')))];
    for (const project of projectList()) bases.push(join(resolve(project.path), '.claude', 'agents'));
    return bases;
  }

  /**
   * The text of a Claude Code agent file named by its path. Only a `.md` file inside an agents folder Claude Code
   * reads (an account's, a registered project's) is read; a link that leads out of that folder is refused.
   * @param {string} path absolute, or `~/…`
   * @returns {{ markdown: string, fileName: string, path: string }}
   * @throws {AgentForgeError} 400 `invalid_path`, 403 `path_not_allowed`, 404 `file_not_found`, 413 `too_large`
   */
  function readClaudeAgentFile(path) {
    const raw = typeof path === 'string' ? path.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (!raw || raw.length > 4000 || /[\u0000-\u001f]/.test(raw)) throw new AgentForgeError(400, 'invalid_path', 'path is the absolute path of a Claude Code agent file (.md).');
    const expanded = raw === '~' || raw.startsWith('~/') ? join(homeDir, raw.slice(1)) : raw;
    if (!isAbsolute(expanded) || !/\.md$/i.test(expanded)) throw new AgentForgeError(400, 'invalid_path', 'path is the absolute path of a Claude Code agent file (.md).');
    const full = resolve(expanded);
    const base = claudeAgentFolders().find((folder) => isInside(folder, full));
    if (!base) throw new AgentForgeError(403, 'path_not_allowed', 'Only a file in an agents folder Claude Code reads is read by its path (an account\'s agents folder, or a registered project\'s .claude/agents): send the file\'s text instead.');
    try {
      const markdown = readConfinedFile(base, full, { maxBytes: REGISTRY_LIMITS.claudeAgentBytes, encoding: 'utf-8' });
      return { markdown, fileName: basename(full), path: full };
    } catch (error) {
      if (error instanceof PathConfineError) {
        const status = [403, 404, 413].includes(error.status) ? error.status : 400;
        throw new AgentForgeError(status, status === 404 ? 'file_not_found' : status === 413 ? 'too_large' : 'path_not_allowed', error.message);
      }
      throw error;
    }
  }

  return { guide, describe, readClaudeAgentFile, targets, isRegisteredProject, onExport: (event) => { try { onExport(event); } catch { /* a listener's own failure */ } } };
}
