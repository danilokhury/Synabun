// ═══════════════════════════════════════════
// SynaBun — AI skill creation: what a request is (P3)
// ═══════════════════════════════════════════
//
// The request the Studio's Create place (and the Assistant's `skill` tool) sends to start drafting a skill with AI:
// the owner's words, an optional example of a good result, the sources the draft is made from, the options, and the
// worker that drafts it. The server checks it with the same function (lib/skills/creation.js) before anything runs:
// one reading of a request for the page and the server. No DOM and no imports.
//
//   describe      the owner's words only
//   conversation  one session transcript of Claude Code, Codex or OpenCode (read by the server, as data)
//   url           a web page, read by the server with the SynaBun browser before the worker starts (as data)
//   repo          a registered project, read by the server: its file tree, docs, manifests and the files named
//   memory        a recall over SynaBun's memory
//   import        an imported skill (a staged import), or a skill of the catalog or the library, as the starting point

export const SOURCE_KINDS = Object.freeze(['describe', 'conversation', 'url', 'repo', 'memory', 'import']);
export const CONVERSATION_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode']);
/**
 * Who drafts: Claude Code only. A drafting worker reads hostile sources, so it is held to its folder with file tools
 * only (lib/skills/draft-confinement.js), which Claude Code enforces before any permission mode; Codex starts MCP
 * servers outside its sandbox and OpenCode answers its own permission prompts, so neither can be held there yet.
 */
/** The providers a drafting run can be held to its folder on (lib/skills/draft-confinement.js draftConfinementSupport). */
export const DRAFT_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode']);
export const CREATION_TARGET_RUNTIMES = Object.freeze(['claude', 'codex', 'opencode', 'agents']);

/** The stages of a creation, in order; the last four end it. */
export const CREATION_STAGES = Object.freeze(['queued', 'gathering', 'drafting', 'checking', 'submitting', 'done', 'failed', 'cancelled', 'interrupted']);
export const ACTIVE_CREATION_STAGES = Object.freeze(['queued', 'gathering', 'drafting', 'checking', 'submitting']);
export const isActiveCreation = (state) => ACTIVE_CREATION_STAGES.includes(String(state || ''));

export const CREATION_LIMITS = Object.freeze({
  promptChars: 8000, exampleChars: 8000, nameChars: 64, sources: 5,
  urlChars: 2000, queryChars: 500, memoryLimit: { min: 1, max: 20, default: 10 },
  paths: 20, pathChars: 512, sessionIdChars: 128, labelChars: 200, targets: 8, projectPathChars: 2000,
  // The drafting worker's work time (minutes of work, not of waiting) and its spend ceiling when a budget is set.
  maxMinutes: { min: 20, max: 90, default: 30 },
  budgetUsd: { min: 0.5, max: 20, default: 3 },
});

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SESSION_RE = /^[A-Za-z0-9_.:-]{6,128}$/;
const STAGING_RE = /^[0-9a-f]{24}$/;
const SKILL_RE = /^skl_[0-9a-f]{20}$/;
const ARTIFACT_RE = /^art_[0-9a-f]{20}$/;
const MODEL_RE = /^[A-Za-z0-9._:/@[\]-]{1,200}$/;
const EFFORT_RE = /^[a-z]{2,20}$/;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/;

const str = (v) => (typeof v === 'string' ? v : '');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A relative path inside a project: no absolute path, no "..", forward slashes. */
export function relativePathProblem(p) {
  const s = str(p);
  if (!s.trim()) return 'empty';
  if (s.length > CREATION_LIMITS.pathChars) return 'too-long';
  if (s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:/.test(s) || s.includes('\\') || s.includes('\0')) return 'absolute';
  if (s.split('/').some((part) => part === '..')) return 'parent';
  return null;
}

/**
 * A web address the server may open for a draft: http or https, no user name or password in it, and nothing a URL
 * parser would quietly drop (a line break, a tab, a control character or a space): what is checked is what is opened.
 */
export function urlProblem(u) {
  const s = str(u).trim();
  if (!s) return 'empty';
  if (s.length > CREATION_LIMITS.urlChars) return 'too-long';
  if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return 'invalid';
  let parsed;
  try { parsed = new URL(s); } catch { return 'invalid'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'scheme';
  if (parsed.username || parsed.password) return 'credentials';
  return null;
}

/** The address as the browser will open it (the parser's own spelling), or '' when urlProblem() refuses it. */
export function normalizedUrl(u) {
  if (urlProblem(u)) return '';
  try { return new URL(str(u).trim()).href; } catch { return ''; }
}

function normalizeSource(raw, i, problems) {
  const at = `sources[${i}]`;
  if (!isObject(raw)) { problems.push({ field: at, code: 'source-shape' }); return null; }
  const kind = raw.kind;
  if (!SOURCE_KINDS.includes(kind)) { problems.push({ field: `${at}.kind`, code: 'source-kind' }); return null; }
  const label = str(raw.label).slice(0, CREATION_LIMITS.labelChars);
  if (kind === 'describe') return { kind };
  if (kind === 'conversation') {
    const provider = raw.provider;
    if (!CONVERSATION_PROVIDERS.includes(provider)) problems.push({ field: `${at}.provider`, code: 'conversation-provider' });
    const sessionId = str(raw.sessionId).trim();
    if (!SESSION_RE.test(sessionId)) problems.push({ field: `${at}.sessionId`, code: 'conversation-session' });
    const project = str(raw.project).trim() || null;
    return { kind, provider, sessionId, project, label };
  }
  if (kind === 'url') {
    const url = str(raw.url).trim();
    const why = urlProblem(url);
    if (why) problems.push({ field: `${at}.url`, code: `url-${why}` });
    return { kind, url: why ? url : normalizedUrl(url), label };
  }
  if (kind === 'repo') {
    const project = str(raw.project).trim();
    if (!project) problems.push({ field: `${at}.project`, code: 'repo-project' });
    const paths = Array.isArray(raw.paths) ? raw.paths : [];
    if (paths.length > CREATION_LIMITS.paths) problems.push({ field: `${at}.paths`, code: 'repo-paths-many' });
    const clean = [];
    paths.slice(0, CREATION_LIMITS.paths).forEach((p, j) => {
      const why = relativePathProblem(p);
      if (why) problems.push({ field: `${at}.paths[${j}]`, code: `repo-path-${why}` });
      else if (!clean.includes(p)) clean.push(p);
    });
    return { kind, project, paths: clean, label };
  }
  if (kind === 'memory') {
    const query = str(raw.query).trim();
    if (!query) problems.push({ field: `${at}.query`, code: 'memory-query' });
    else if (query.length > CREATION_LIMITS.queryChars) problems.push({ field: `${at}.query`, code: 'memory-query-long' });
    const { min, max, default: dflt } = CREATION_LIMITS.memoryLimit;
    const limit = Number.isInteger(raw.limit) ? Math.min(max, Math.max(min, raw.limit)) : dflt;
    const project = str(raw.project).trim() || null;
    return { kind, query, limit, project, label };
  }
  // import: exactly one of a staged import, a library skill, a catalog entry.
  const given = ['stagingId', 'skillId', 'artifactId'].filter((k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '');
  if (given.length !== 1) { problems.push({ field: at, code: 'import-one' }); return { kind, label }; }
  const key = given[0];
  const value = str(raw[key]);
  const ok = key === 'stagingId' ? STAGING_RE.test(value) : key === 'skillId' ? SKILL_RE.test(value) : ARTIFACT_RE.test(value);
  if (!ok) problems.push({ field: `${at}.${key}`, code: 'import-id' });
  return { kind, [key]: value, label };
}

/**
 * Check and normalize a creation request.
 * @param {object} body
 * @param {{ submitDefault?: boolean }} [o] whether the draft goes to Review by itself when the request does not say
 *   (the Studio: yes; the Assistant: no, it looks first)
 * @returns {{ ok: boolean, request: object, problems: { field: string, code: string }[] }}
 */
export function normalizeCreationRequest(body, { submitDefault = true } = {}) {
  const problems = [];
  const b = isObject(body) ? body : {};
  const prompt = str(b.prompt).trim();
  if (prompt.length > CREATION_LIMITS.promptChars) problems.push({ field: 'prompt', code: 'prompt-long' });
  const example = str(b.example).trim();
  if (example.length > CREATION_LIMITS.exampleChars) problems.push({ field: 'example', code: 'example-long' });
  const name = str(b.name).trim();
  if (name && (name.length > CREATION_LIMITS.nameChars || !NAME_RE.test(name))) problems.push({ field: 'name', code: 'name-format' });
  const invocation = b.invocation === 'manual' ? 'manual' : 'auto';
  const rawSources = Array.isArray(b.sources) ? b.sources : [];
  if (rawSources.length > CREATION_LIMITS.sources) problems.push({ field: 'sources', code: 'sources-many' });
  const sources = rawSources.slice(0, CREATION_LIMITS.sources).map((s, i) => normalizeSource(s, i, problems)).filter((s) => s && s.kind !== 'describe');
  if (!prompt && !sources.length) problems.push({ field: 'prompt', code: 'prompt-required' });
  // The worker that drafts: a provider, a model (or its default), an effort; null leaves it to the owner's route.
  let target = null;
  if (b.target !== undefined && b.target !== null) {
    const t = isObject(b.target) ? b.target : {};
    if (!DRAFT_PROVIDERS.includes(t.provider)) problems.push({ field: 'target.provider', code: 'target-provider' });
    const model = str(t.model).trim();
    if (model && !MODEL_RE.test(model)) problems.push({ field: 'target.model', code: 'target-model' });
    const effort = str(t.effort).trim();
    if (effort && !EFFORT_RE.test(effort)) problems.push({ field: 'target.effort', code: 'target-effort' });
    target = { provider: t.provider, model: model || null, effort: effort || null };
  }
  const mm = CREATION_LIMITS.maxMinutes;
  const maxMinutes = Number.isFinite(Number(b.maxMinutes)) && Number(b.maxMinutes) > 0 ? Math.min(mm.max, Math.max(mm.min, Math.round(Number(b.maxMinutes)))) : mm.default;
  const bu = CREATION_LIMITS.budgetUsd;
  const budgetUsd = Number.isFinite(Number(b.budgetUsd)) && Number(b.budgetUsd) > 0 ? Math.min(bu.max, Math.max(bu.min, Number(b.budgetUsd))) : bu.default;
  // Where the owner may install it, as the Review card and the install plan read a target (lib/skills/deploy.js
  // normalizeTarget): a runtime, user or project scope, an account, a project's path. Kept whole; what is not one
  // is refused here (the server also checks that a project is registered).
  const targets = [];
  const rawTargets = Array.isArray(b.targets) ? b.targets : [];
  if (rawTargets.length > CREATION_LIMITS.targets) problems.push({ field: 'targets', code: 'targets-many' });
  rawTargets.slice(0, CREATION_LIMITS.targets).forEach((t, i) => {
    const at = `targets[${i}]`;
    if (!isObject(t) || !CREATION_TARGET_RUNTIMES.includes(t.runtime)) { problems.push({ field: `${at}.runtime`, code: 'targets-runtime' }); return; }
    const scope = t.scope === undefined || t.scope === null || t.scope === '' ? 'user' : t.scope;
    if (scope !== 'user' && scope !== 'project') { problems.push({ field: `${at}.scope`, code: 'targets-scope' }); return; }
    if (t.runtime === 'agents' && scope !== 'user') { problems.push({ field: `${at}.scope`, code: 'targets-agents-scope' }); return; }
    const accountId = t.accountId === undefined || t.accountId === null || t.accountId === '' ? 'default' : t.accountId;
    if (typeof accountId !== 'string' || !ACCOUNT_RE.test(accountId)) { problems.push({ field: `${at}.accountId`, code: 'targets-account' }); return; }
    let projectPath = null;
    if (scope === 'project') {
      projectPath = str(t.projectPath).trim();
      const absolute = projectPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(projectPath);
      if (!projectPath || !absolute || projectPath.length > CREATION_LIMITS.projectPathChars || /[\u0000-\u001f\u007f]/.test(projectPath)) { problems.push({ field: `${at}.projectPath`, code: 'targets-project' }); return; }
    }
    const key = scope === 'project' ? `${t.runtime}:project:${projectPath}` : `${t.runtime}:user:${accountId}`;
    if (targets.some((x) => x.key === key)) return;
    targets.push({ key, runtime: t.runtime, scope, accountId, ...(projectPath ? { projectPath } : {}) });
  });
  const submit = typeof b.submit === 'boolean' ? b.submit : submitDefault;
  return {
    ok: problems.length === 0,
    request: { prompt, example, name, invocation, sources, target, maxMinutes, budgetUsd: Math.round(budgetUsd * 100) / 100, targets: targets.length ? targets.map(({ key: _k, ...t }) => t) : [{ runtime: 'claude', scope: 'user', accountId: 'default' }], submit },
    problems,
  };
}

/** Where a source came from, in a few words (a chip's label when the request carries none). */
export function sourceSummary(source) {
  if (!isObject(source)) return '';
  if (source.label) return source.label;
  switch (source.kind) {
    case 'conversation': return `${source.provider} ${String(source.sessionId || '').slice(0, 8)}`;
    case 'url': { try { const u = new URL(source.url); return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 80); } catch { return String(source.url || '').slice(0, 80); } }
    case 'repo': { const parts = String(source.project || '').split(/[\\/]/).filter(Boolean); return `${parts[parts.length - 1] || source.project}${source.paths?.length ? ` (${source.paths.length})` : ''}`; }
    case 'memory': return `“${String(source.query || '').slice(0, 60)}”`;
    case 'import': return source.stagingId ? 'import' : source.skillId || 'catalog';
    default: return '';
  }
}
