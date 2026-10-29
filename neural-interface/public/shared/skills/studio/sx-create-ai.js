// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: drafting a skill with AI (P3), what decides
// ═══════════════════════════════════════════
//
// Create's AI box: the owner's words, an example of a good result, the sources (a session transcript, a web page, a
// registered project, memories, an existing skill), and the options (name, who invokes it, the runtimes, the worker
// that drafts it, its work time). This module keeps that form as plain data (it survives the window: storage), turns
// it into the request the server checks with the same rules (../ss-creation.js), and says what a creation shows:
// its steps, its state, what it made or why it stopped. No DOM; the view (sx-create-view.js) draws it.

import { CREATION_LIMITS, DRAFT_PROVIDERS, isActiveCreation, normalizeCreationRequest, sourceSummary } from '../ss-creation.js';

export const AI_FORM_KEY = 'skills-studio-create-ai';
/** The places a source is added from (describe is the prompt itself). */
export const AI_SOURCE_KINDS = Object.freeze(['conversation', 'url', 'repo', 'memory', 'import']);
export const DRAFT_RUNTIMES = Object.freeze(['claude', 'codex', 'opencode']);
export const WORK_MINUTES = Object.freeze([20, 30, 45, 60, 90]);
/** The steps a creation shows, in order. */
export const CREATION_STEPS = Object.freeze(['sources', 'drafting', 'checking', 'review']);
/** Error codes the view words (`skillsStudio.create.ai.error.<code>`); anything else is said as `other`. */
export const CREATION_ERRORS = Object.freeze(['needs_browser', 'needs_input', 'worker_blocked', 'worker_failed', 'worker_ended', 'draft_invalid', 'draft_unchanged', 'draft_unsafe', 'budget_exceeded', 'provider_unsupported', 'request_too_long', 'source_failed', 'source_not_found', 'source_empty', 'source_unavailable', 'dispatch_failed', 'drafting_unavailable', 'too_many_creations', 'interrupted', 'invalid_request', 'other']);

export function emptyAiForm() {
  return { prompt: '', example: '', showExample: false, sources: [], name: '', invocation: 'auto', runtimes: ['claude'], target: '', minutes: CREATION_LIMITS.maxMinutes.default };
}

/** The form as it was kept (a bad or old copy gives the empty form, its prompt kept when it can be). */
export function readAiForm(text, legacyPrompt = '') {
  const base = emptyAiForm();
  let saved = null;
  try { saved = text ? JSON.parse(text) : null; } catch { saved = null; }
  if (!saved || typeof saved !== 'object') return { ...base, prompt: typeof legacyPrompt === 'string' ? legacyPrompt : '' };
  const runtimes = Array.isArray(saved.runtimes) ? saved.runtimes.filter((r) => DRAFT_RUNTIMES.includes(r)) : base.runtimes;
  return {
    prompt: typeof saved.prompt === 'string' ? saved.prompt.slice(0, CREATION_LIMITS.promptChars) : '',
    example: typeof saved.example === 'string' ? saved.example.slice(0, CREATION_LIMITS.exampleChars) : '',
    showExample: saved.showExample === true || (typeof saved.example === 'string' && saved.example !== ''),
    sources: Array.isArray(saved.sources) ? saved.sources.filter((s) => s && AI_SOURCE_KINDS.includes(s.kind)).slice(0, CREATION_LIMITS.sources) : [],
    name: typeof saved.name === 'string' ? saved.name.slice(0, CREATION_LIMITS.nameChars) : '',
    invocation: saved.invocation === 'manual' ? 'manual' : 'auto',
    runtimes: runtimes.length ? runtimes : base.runtimes,
    // A worker kept from before that can no longer draft (only Claude Code can) goes back to the default.
    target: typeof saved.target === 'string' && DRAFT_PROVIDERS.includes(targetOf(saved.target)?.provider) ? saved.target.slice(0, 260) : '',
    minutes: WORK_MINUTES.includes(Number(saved.minutes)) ? Number(saved.minutes) : base.minutes,
  };
}

export const writeAiForm = (form) => JSON.stringify(form);

/** A source the same as one already there (the same session, address, project and paths, query, skill). */
export function sameSource(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'conversation': return a.provider === b.provider && a.sessionId === b.sessionId;
    case 'url': return a.url === b.url;
    case 'repo': return a.project === b.project && JSON.stringify(a.paths || []) === JSON.stringify(b.paths || []);
    case 'memory': return a.query === b.query && (a.project || '') === (b.project || '');
    case 'import': return (a.stagingId || a.skillId || a.artifactId) === (b.stagingId || b.skillId || b.artifactId);
    default: return false;
  }
}

/** The form with one more source: 'added', 'duplicate' or 'full' says what happened. */
export function addSource(form, source) {
  if (form.sources.some((s) => sameSource(s, source))) return { form, outcome: 'duplicate' };
  if (form.sources.length >= CREATION_LIMITS.sources) return { form, outcome: 'full' };
  return { form: { ...form, sources: [...form.sources, source] }, outcome: 'added' };
}

export const removeSource = (form, index) => ({ ...form, sources: form.sources.filter((_, i) => i !== index) });

/** A source's chip: its kind and a short label. */
export function sourceChip(source) {
  return { kind: source.kind, label: sourceSummary(source) || source.kind, title: source.kind === 'url' ? source.url : (source.project || source.query || source.label || '') };
}

/** "provider|model" of the model dropdown → a target ({} for the owner's default route). */
export function targetOf(value) {
  const s = String(value || '');
  if (!s) return null;
  const at = s.indexOf('|');
  const provider = at < 0 ? s : s.slice(0, at);
  const model = at < 0 ? '' : s.slice(at + 1);
  return { provider, ...(model ? { model } : {}) };
}

/**
 * The request the form sends (POST /v2/creations), checked with the server's own rules.
 * @returns {{ ok: boolean, body: object, problems: { field: string, code: string }[] }}
 */
export function buildCreationRequest(form) {
  const body = {
    prompt: form.prompt, ...(form.example && form.showExample ? { example: form.example } : {}), ...(form.name ? { name: form.name } : {}),
    invocation: form.invocation, sources: form.sources.map(({ label, ...rest }) => ({ ...rest, ...(label ? { label } : {}) })),
    targets: (form.runtimes.length ? form.runtimes : ['claude']).map((runtime) => ({ runtime })),
    ...(targetOf(form.target) ? { target: targetOf(form.target) } : {}),
    maxMinutes: form.minutes, submit: true,
  };
  const { ok, problems } = normalizeCreationRequest(body);
  return { ok, body, problems };
}

/** The key of what is wrong with a request, for the view (`skillsStudio.create.ai.problem.<key>`). */
export function problemKey(problem) {
  const code = String(problem?.code || '');
  if (code === 'prompt-required') return 'prompt';
  if (code === 'name-format') return 'name';
  if (code.startsWith('url-')) return 'url';
  if (code.startsWith('repo-')) return 'repo';
  if (code.startsWith('memory-')) return 'memory';
  if (code.startsWith('conversation-')) return 'conversation';
  if (code.startsWith('import-')) return 'import';
  if (code === 'target-provider') return 'provider';
  if (code.startsWith('targets-')) return 'targets';
  if (code.endsWith('-long')) return 'long';
  return 'other';
}
export const PROBLEM_KEYS = Object.freeze(['prompt', 'name', 'url', 'repo', 'memory', 'conversation', 'import', 'provider', 'targets', 'long', 'other']);

/**
 * The steps of a creation: each 'done', 'active', 'failed' or 'waiting'.
 * @param {object} job a creation (GET /v2/creations/:id)
 */
export function creationSteps(job) {
  const order = { queued: 0, gathering: 0, drafting: 1, checking: 2, submitting: 3, done: 4 };
  const state = String(job?.state || 'queued');
  // Where it stopped: the last step it reached.
  const reached = state in order ? order[state] : (job?.result ? 4 : job?.run ? (job?.files?.length ? 2 : 1) : (job?.sources?.length ? 1 : 0));
  return CREATION_STEPS.map((id, i) => {
    if (state === 'done') return { id, state: id === 'review' && !job?.result?.reviewId ? 'skipped' : 'done' };
    if (i < reached) return { id, state: 'done' };
    if (i === reached) return { id, state: isActiveCreation(state) ? 'active' : (state === 'failed' || state === 'interrupted' ? 'failed' : 'waiting') };
    return { id, state: 'waiting' };
  });
}

/** What a creation is called in lists: the name it made, the name asked for, or the first words of the prompt. */
export function creationTitle(job) {
  const name = job?.result?.name || job?.partial?.name || job?.request?.name;
  if (name) return name;
  const words = String(job?.request?.prompt || '').replace(/\s+/g, ' ').trim();
  return words ? (words.length > 60 ? `${words.slice(0, 59)}…` : words) : (job?.request?.sources?.[0] ? sourceSummary(job.request.sources[0]) : job?.jobId || '');
}

/** The error code the view words. */
export function errorCode(job) {
  const code = String(job?.error?.code || '');
  if (CREATION_ERRORS.includes(code)) return code;
  if (code.startsWith('dispatch_')) return 'dispatch_failed';
  return 'other';
}

/** Seconds since a time (for "2 min"); null without one. */
export function elapsedSeconds(job, now = Date.now()) {
  const from = Date.parse(job?.createdAt || '');
  if (!Number.isFinite(from)) return null;
  const to = job?.finishedAt ? Date.parse(job.finishedAt) : now;
  return Math.max(0, Math.round((to - from) / 1000));
}

/** "1:05" or "12 s". */
export function clockText(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return m < 60 ? `${m}:${s}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}`;
}

/** A size in bytes as the file list says it. */
export function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** How long to wait before asking for a running creation again (a long poll holds most of it). */
export function pollSeconds(job) {
  if (!isActiveCreation(job?.state)) return null;
  return job.state === 'queued' || job.state === 'gathering' ? 5 : 20;
}

/**
 * The providers that draft, as the server lists them (GET /creations/options `drafting.providers`, Claude Code first
 * and the default) with what it says of each (`providerStatus`: one that cannot start here now is greyed out with its
 * plain reason and cannot be picked). A server without the list: Claude Code alone. A provider the server says nothing
 * of on its own takes what it says of drafting as a whole (an older server: `available: false` and why).
 * @returns {{ provider: string, available: boolean, reason: string|null }[]}
 */
export function draftingProviders(drafting) {
  const listed = Array.isArray(drafting?.providers) ? drafting.providers.filter((p) => typeof p === 'string' && DRAFT_PROVIDERS.includes(p)) : [];
  const providers = listed.length ? [...new Set(listed)] : ['claude-code'];
  const status = new Map((Array.isArray(drafting?.providerStatus) ? drafting.providerStatus : []).filter((p) => p && typeof p.provider === 'string').map((p) => [p.provider, p]));
  const allOff = drafting?.available === false;
  return providers.sort((a, b) => (a === 'claude-code' ? -1 : b === 'claude-code' ? 1 : 0)).map((provider) => {
    const st = status.get(provider);
    if (st) return { provider, available: st.available === true, reason: st.available === true ? null : String(st.reason || '') };
    return allOff ? { provider, available: false, reason: String(drafting.reason || '') } : { provider, available: true, reason: null };
  });
}


/**
 * The model dropdown: the owner's route first (when it is one that drafts and can start here), then the models of
 * each provider the server lists from the Assistant's catalog; a provider that cannot draft here now is one greyed
 * option with its reason, never selectable. The default (Claude Code's own model, when there is no route) is greyed
 * too when Claude Code cannot start here, so the first provider that can is what the list then shows chosen.
 */
export function modelEntries({ defaultTarget = null, catalog = null, selected = '', words, providers = null }) {
  const list_ = Array.isArray(providers) && providers.length ? providers : [{ provider: 'claude-code', available: true, reason: null }];
  const can = (p) => list_.some((x) => x.provider === p && x.available);
  const routed = defaultTarget?.provider && can(defaultTarget.provider) && defaultTarget.route === true;
  const defaultOff = !routed && !can('claude-code');
  const entries = [{ value: '', label: routed ? words.route(defaultTarget) : words.fallback, selected: !selected && !defaultOff, ...(defaultOff ? { disabled: true } : {}) }];
  for (const { provider, available, reason } of list_) {
    if (!available) { entries.push({ group: words.provider(provider), options: [{ value: provider, label: words.providerOff(provider, reason || ''), disabled: true, selected: false }] }); continue; }
    const rows = Array.isArray(catalog?.[provider]) ? catalog[provider] : [];
    const options = [{ value: provider, label: words.providerDefault(provider), selected: selected === provider }];
    for (const row of rows.slice(0, 60)) {
      if (!row?.id || row.status === 'unavailable') continue;
      const value = `${provider}|${row.id}`;
      options.push({ value, label: String(row.label || row.id), selected: selected === value });
    }
    entries.push({ group: words.provider(provider), options });
  }
  // A choice kept from before that the catalog no longer lists stays visible (and chosen), never silently swapped;
  // one of a provider that cannot draft here now is shown greyed and the default is chosen instead.
  if (selected && !entries.some((e) => (e.options || [e]).some((o) => o.value === selected))) {
    const t = targetOf(selected);
    const off = !can(t.provider);
    entries.push({ value: selected, label: `${words.provider(t.provider)} · ${t.model || ''}`.trim(), selected: !off, disabled: off });
    if (off && !defaultOff) entries[0].selected = true;
  }
  return entries;
}
