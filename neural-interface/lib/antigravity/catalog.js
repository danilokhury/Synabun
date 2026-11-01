// ═══════════════════════════════════════════
// SynaBun — Antigravity's models and past sessions, asked of the CLI itself
// ═══════════════════════════════════════════
//
// Models: what an ACP session offers, because SynaBun drives every Antigravity brain, run and panel
// over ACP. agy 1.4.12's ACP sessions offer a model option of base models (gemini-4-argon,
// gemini-3.8-flash) and a thinking-level option (low / medium / high), and list each pair as one
// id (`models.availableModels`: gemini-4-argon-high …). `agy models` lists more (Claude and GPT-OSS
// models its own TUI runs), which ACP refuses ("Unknown model ID"), and it has no
// `--output-format` in 1.4.12. So the list is read from a short-lived `agy acp` in a throwaway
// home (lib/antigravity/home.js; the sign-in is the keychain's, nothing of the user's changes),
// and `agy models` (text, or JSON from a later agy) is only the fallback of an agy without ACP.
// Nothing here names a model of its own: what Antigravity offers is the list.
//
// Sessions: ACP session/list on a short-lived `agy acp` (lib/antigravity/acp-connection.js),
// page by page, grouped under SynaBun's registered projects for the Resume window.
// Both answer `{ ..., error, authRequired }` instead of throwing: a CLI that is
// missing, signed out or slow is a state the page shows.

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { acpErrorInfo, createAcpConnection, isAuthRequired, redactSecrets } from './acp-connection.js';

const MODELS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 2 * 1024 * 1024;
/** Antigravity's thinking levels, lowest first (`--effort` takes low … max; ACP sessions offer what each model has). */
export const ANTIGRAVITY_THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const LEVEL_SUFFIX = new RegExp(`^(.+)-(${ANTIGRAVITY_THINKING_LEVELS.join('|')})$`);

/**
 * An Antigravity model id as its base model and thinking level: "gemini-4-argon-high" → { model: 'gemini-4-argon',
 * effort: 'high' }. `known` (base ids, optional): the split is made only when the base is one of them. An id
 * without a level suffix is its own base ({ model, effort: null }).
 */
export function splitAntigravityModel(id, known = null) {
  const text = String(id || '').trim();
  const match = LEVEL_SUFFIX.exec(text);
  if (!match) return { model: text || null, effort: null };
  const list = known instanceof Set ? known : Array.isArray(known) ? new Set(known) : null;
  if (list && !list.has(match[1]) && list.has(text)) return { model: text, effort: null };
  if (list && !list.has(match[1])) return { model: text, effort: null };
  return { model: match[1], effort: match[2] };
}

/**
 * The models an ACP session offers ({ models, configOptions } of session/new or session/resume):
 * [{ id, label, efforts, default? }], one row per base model, its thinking levels from the session's own
 * model × level ids (else the level option's values). [] when the session lists none.
 */
export function antigravitySessionModels(session) {
  const options = Array.isArray(session?.configOptions) ? session.configOptions : [];
  const modelOption = options.find((option) => option?.category === 'model' || option?.id === 'model');
  const levelOption = options.find((option) => option?.category === 'thought_level' || option?.id === 'thought_level');
  const flat = (option) => {
    const out = [];
    for (const entry of Array.isArray(option?.options) ? option.options : []) {
      for (const value of Array.isArray(entry?.options) ? entry.options : [entry]) {
        if (value && value.value !== undefined && value.value !== null) out.push({ value: String(value.value), name: typeof value.name === 'string' ? value.name : String(value.value), description: typeof value.description === 'string' ? value.description : '' });
      }
    }
    return out;
  };
  const levels = flat(levelOption).map((entry) => entry.value);
  const available = Array.isArray(session?.models?.availableModels) ? session.models.availableModels : [];
  const bases = flat(modelOption);
  const known = new Set(bases.map((entry) => entry.value));
  // A session without a model option still names its model × level pairs: their bases are the models.
  if (!bases.length) {
    for (const row of available) {
      const { model } = splitAntigravityModel(row?.modelId);
      if (model && !known.has(model)) { known.add(model); bases.push({ value: model, name: String(row?.name || model).replace(/\s*\([^)]*\)\s*$/, ''), description: '' }); }
    }
  }
  const efforts = new Map();
  for (const row of available) {
    const { model, effort } = splitAntigravityModel(row?.modelId, known);
    if (model && effort) { if (!efforts.has(model)) efforts.set(model, []); efforts.get(model).push(effort); }
  }
  const current = modelOption?.currentValue !== undefined ? String(modelOption.currentValue) : splitAntigravityModel(session?.models?.currentModelId, known).model;
  const order = (list) => [...new Set(list)].sort((a, b) => ANTIGRAVITY_THINKING_LEVELS.indexOf(a) - ANTIGRAVITY_THINKING_LEVELS.indexOf(b));
  return bases.map((entry) => {
    const row = { id: entry.value, label: entry.name || entry.value };
    if (entry.description) row.description = entry.description;
    const own = efforts.get(entry.value);
    const list = own?.length ? order(own) : (entry.value === current && levels.length ? order(levels) : []);
    if (list.length) row.efforts = list;
    if (entry.value === current) row.default = true;
    return row;
  });
}

/** Rows from `agy models` text output: one `<id>\t<label>` line per model (status lines without a tab are skipped). */
export function parseAntigravityModelLines(text) {
  const rows = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const [id, ...rest] = line.split('\t');
    const key = String(id || '').trim();
    if (!key || !rest.length || seen.has(key) || /\s/.test(key)) continue;
    seen.add(key);
    rows.push({ id: key, label: rest.join('\t').trim() || key });
  }
  return rows;
}

const pick = (row, keys) => {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

/** Rows from a JSON model list (a later agy's `agy models`, a stand-in): [{ id, label, description?, default? }] (never throws). */
export function parseAntigravityModels(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim()); } catch { return []; }
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.models) ? data.models
      : Array.isArray(data?.availableModels) ? data.availableModels
        : Array.isArray(data?.data) ? data.data : [];
  const rows = [];
  const seen = new Set();
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry.trim() && !seen.has(entry.trim())) { seen.add(entry.trim()); rows.push({ id: entry.trim(), label: entry.trim() }); }
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const id = pick(entry, ['id', 'model_id', 'modelId', 'slug', 'model', 'value', 'name']);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = { id, label: pick(entry, ['display_name', 'displayName', 'label', 'name']) || id };
    const description = pick(entry, ['description', 'tagline', 'summary']);
    if (description) row.description = description;
    if (entry.is_default === true || entry.isDefault === true || entry.default === true || entry.selected === true || entry.current === true) row.default = true;
    const efforts = Array.isArray(entry.efforts) ? entry.efforts : Array.isArray(entry.thinking_levels) ? entry.thinking_levels : Array.isArray(entry.effort_levels) ? entry.effort_levels : null;
    if (efforts) row.efforts = efforts.map((e) => (typeof e === 'string' ? e : e?.id || e?.value || e?.name)).filter((e) => typeof e === 'string' && e);
    rows.push(row);
  }
  return rows;
}

/**
 * The models Antigravity offers SynaBun: those of an ACP session in a throwaway home (antigravitySessionModels),
 * else (an agy without ACP) `agy models`. `launch`: { command, args } of the CLI (null: not installed).
 * Answers { models, source: 'live' | 'unavailable', via: 'acp' | 'cli', error?, authRequired? }.
 */
export async function listAntigravityModels({ launch, env = process.env, spawnImpl = nodeSpawn, connect = createAcpConnection, timeoutMs = MODELS_TIMEOUT_MS, tempRoot = tmpdir() } = {}) {
  if (!launch?.command) return { models: [], source: 'unavailable', error: 'The Antigravity CLI (agy) is not installed.', cliMissing: true };
  let scratch = null;
  let conn = null;
  let acpError = null;
  try {
    scratch = mkdtempSync(join(tempRoot, 'synabun-agy-models-'));
    conn = connect({ command: launch.command, args: launch.args || [], acpArgs: ['--gemini-dir', scratch], env, cwd: scratch, spawnImpl, clientInfo: { name: 'synabun', title: 'SynaBun', version: '0' } });
    await conn.initialize();
    const session = await conn.request('session/new', { cwd: scratch, mcpServers: [] }, { timeoutMs });
    const models = antigravitySessionModels(session);
    // The plan the sign-in is on, as the session says it (_meta.antigravity.tier: "Google AI Pro" …).
    const tier = typeof session?._meta?.antigravity?.tier?.name === 'string' ? session._meta.antigravity.tier.name : null;
    try { if (session?.sessionId) await conn.request('session/close', { sessionId: session.sessionId }, { timeoutMs: 5_000 }); } catch { /* the home goes anyway */ }
    if (models.length) return { models, source: 'live', via: 'acp', signedIn: true, tier };
    acpError = { message: 'The Antigravity session offered no models.' };
  } catch (error) {
    if (isAuthRequired(error)) return { models: [], source: 'unavailable', error: 'Antigravity is not signed in.', authRequired: true, signedIn: false };
    acpError = acpErrorInfo(error);
  } finally {
    try { await conn?.close(); } catch { /* gone */ }
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the temp folder's own cleanup */ } }
  }
  const viaCli = await listAntigravityCliModels({ launch, env, spawnImpl, timeoutMs });
  if (viaCli.models.length) return viaCli;
  return { ...viaCli, error: viaCli.error || acpError?.message || 'Antigravity listed no models.' };
}

/**
 * `agy models` (its text lines; JSON from an agy that prints JSON): the fallback of an agy whose ACP session
 * could not list models. Answers { models, source, via: 'cli', error?, authRequired? }.
 */
export function listAntigravityCliModels({ launch, env = process.env, spawnImpl = nodeSpawn, timeoutMs = MODELS_TIMEOUT_MS } = {}) {
  if (!launch?.command) return Promise.resolve({ models: [], source: 'unavailable', via: 'cli', error: 'The Antigravity CLI (agy) is not installed.', cliMissing: true });
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(result); } };
    try {
      child = spawnImpl(launch.command, [...(launch.args || []), 'models'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolveResult({ models: [], source: 'unavailable', via: 'cli', error: redactSecrets(error?.message || String(error)) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ models: [], source: 'unavailable', via: 'cli', error: `agy models did not answer within ${Math.round(timeoutMs / 1000)} s.` }); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
    child.on('error', (error) => finish({ models: [], source: 'unavailable', via: 'cli', error: redactSecrets(error?.message || String(error)) }));
    child.on('close', (code) => {
      // A later agy may print JSON; 1.4.12 prints `<id>\t<label>` lines after a status line.
      const json = parseAntigravityModels(stdout);
      const models = json.length ? json : parseAntigravityModelLines(stdout);
      if (models.length) { finish({ models, source: 'live', via: 'cli' }); return; }
      const said = redactSecrets((stderr || stdout).trim()).split('\n').filter(Boolean).slice(-3).join(' ');
      const authRequired = /sign in|log in|authenticat/i.test(said);
      finish({ models: [], source: 'unavailable', via: 'cli', error: said || `agy models exited with code ${code}.`, ...(authRequired ? { authRequired: true } : {}) });
    });
  });
}

/**
 * Every session ACP's session/list reports (all pages, up to `maxSessions`), through a short-lived `agy acp`.
 * Answers { sessions: [{ sessionId, cwd, title, updatedAt }], error?, authRequired? }.
 */
export async function listAntigravitySessions({ launch, env = process.env, connect = createAcpConnection, maxSessions = 500, cwd } = {}) {
  if (!launch?.command) return { sessions: [], error: 'The Antigravity CLI (agy) is not installed.', cliMissing: true };
  const conn = connect({ command: launch.command, args: launch.args || [], env, cwd, clientInfo: { name: 'synabun', title: 'SynaBun', version: '0' } });
  const sessions = [];
  try {
    await conn.initialize();
    let cursor = null;
    for (let page = 0; page < 50 && sessions.length < maxSessions; page++) {
      const answer = await conn.request('session/list', cursor ? { cursor } : {}, { timeoutMs: 20_000 });
      for (const row of Array.isArray(answer?.sessions) ? answer.sessions : []) {
        if (row && typeof row.sessionId === 'string') sessions.push({ sessionId: row.sessionId, cwd: typeof row.cwd === 'string' ? row.cwd : '', title: typeof row.title === 'string' ? row.title : '', updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null });
      }
      cursor = typeof answer?.nextCursor === 'string' && answer.nextCursor ? answer.nextCursor : null;
      if (!cursor) break;
    }
    return { sessions: sessions.slice(0, maxSessions) };
  } catch (error) {
    return { sessions, error: acpErrorInfo(error).message, ...(isAuthRequired(error) ? { authRequired: true } : {}) };
  } finally {
    conn.close();
  }
}

/** The Resume window's shape: one entry per registered project, its sessions newest first, searched and paged. */
export function groupSessionsByProject(sessions, projects, { targetProject = null, search = '', offset = 0, limit = 30 } = {}) {
  const roots = (Array.isArray(projects) ? projects : []).map((project) => ({ project, root: resolve(project.path) }))
    // The deepest project wins a session that sits in a nested one.
    .sort((a, b) => b.root.length - a.root.length);
  const byRoot = new Map(roots.map(({ root }) => [root, []]));
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session?.cwd) continue;
    const dir = resolve(session.cwd);
    const owner = roots.find(({ root }) => dir === root || dir.startsWith(root + sep));
    if (!owner) continue;
    byRoot.get(owner.root).push({
      sessionId: session.sessionId,
      firstPrompt: session.title || '',
      messageCount: null,
      created: null,
      modified: session.updatedAt || null,
      gitBranch: null,
      cwd: session.cwd,
    });
  }
  const needle = String(search || '').toLowerCase().trim();
  const result = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    const root = resolve(project.path);
    if (targetProject && root !== resolve(targetProject)) continue;
    let entries = byRoot.get(root) || [];
    entries.sort((a, b) => (Date.parse(b.modified || 0) || 0) - (Date.parse(a.modified || 0) || 0));
    if (needle) entries = entries.filter((e) => e.firstPrompt.toLowerCase().includes(needle) || e.sessionId.toLowerCase().includes(needle));
    result.push({ path: project.path, label: project.label || basename(project.path), total: entries.length, sessions: entries.slice(offset, offset + limit) });
  }
  return result;
}
