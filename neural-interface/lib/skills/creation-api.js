// ── /api/skills-studio/v2/creations: AI skill creation over HTTP (P3) ──
// The routes of lib/skills/creation.js, beside the rest of the Skills Service's v2 routes (lib/skills/api-v2.js),
// and the skill-forge guide the Assistant's `skill` tool reads (`GET /guide`). Who may do what:
//
//   the owner        from SynaBun's own page (no agent header, X-SynaBun-UI: 1, this boot's page secret cookie,
//                    lib/page-session.js, the owner route guard): starts,
//                    reads, waits on, cancels and retries every creation; lists the sessions a conversation source
//                    can use.
//   the Assistant    a request carrying the credential an Assistant brain's launch was given (X-Synabun-Brain-Token,
//                    assistant-runtime.js mintBrainCredential; the MCP `skill` tool forwards it), resolved to that
//                    brain's session (assistantCaller): starts, reads, waits on, cancels and retries the creations of
//                    its session, which pays for the worker. X-Synabun-Role and X-Synabun-Terminal prove nothing (any
//                    local process can send them): without the credential an agent is refused, and a dispatched worker
//                    is refused whatever it sends. Creating skills is not a worker's to do.
//   anyone else      403 (a guest, an agent without a brain's credential).
//
// A creation runs a worker and spends money: nothing here is open to a reader.

import { sendGuardError } from '../http-guards.js';
import { PathConfineError } from '../path-confine.js';
import { V2_BASE, principalOf } from './api-v2.js';
import { isCreationId } from './creation.js';
import { CONVERSATION_PROVIDERS, CREATION_LIMITS, DRAFT_PROVIDERS, SOURCE_KINDS } from '../../public/shared/skills/ss-creation.js';

export const SKILL_FORGE = 'skill-forge';
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

function fail(res, err) {
  const status = err instanceof PathConfineError ? err.status : (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500);
  const body = { ok: false, error: status >= 500 && !(err instanceof PathConfineError) ? `Skill creation failed: ${err?.message || err}` : (err?.message || String(err)) };
  if (typeof err?.code === 'string' && !/^E[A-Z]+$/.test(err.code)) body.code = err.code;
  for (const key of ['problems']) if (err?.[key] !== undefined) body[key] = err[key];
  return res.status(status).json(body);
}

/**
 * @param {object} app express app
 * @param {object} o
 * @param {object} o.creations lib/skills/creation.js
 * @param {object} o.service lib/skills/service.js (the bundled skill-forge for GET /guide)
 * @param {(req) => boolean} [o.isGuestRequest]
 * @param {Function} [o.ownerGuard] lib/http-guards.js ownerRouteGuard(…) of this server
 * @param {(req) => ({ kind: 'assistant', assistantSessionId: string } | { kind: 'worker' } | null)} [o.assistantCaller]
 *   who an agent request is: an Assistant brain (the session its credential belongs to), a dispatched worker, or nobody
 * @param {() => object} [o.options] what can run now: { conversation: string[] (providers), url: boolean, urlReason,
 *   repo: { path, label }[], memory: boolean, import: boolean, defaultTarget, drafting: { available, reason, providers } }
 * @param {{ verify(req): boolean, require(req, res, next), attach(res) }} [o.pageSession] lib/page-session.js: the owner's
 *   writes carry this boot's page secret; the owner's reads hand it to the page
 * @param {(q) => Promise<object[]>} [o.sessions] the sessions a conversation source can use
 */
export function registerSkillCreationRoutes(app, { creations, service, isGuestRequest = null, ownerGuard = null, assistantCaller = null, options = () => ({}), sessions = null, pageSession = null } = {}) {
  const idem = new Map();
  const route = (method, path, ...handlers) => app[method](`${V2_BASE}${path}`, ...handlers);
  const safe = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err); } };

  const json = (req, res, next) => {
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return sendGuardError(res, 403, 'CROSS_SITE', 'Cross-site requests are refused.');
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && typeof req.is === 'function' && !req.is('application/json')) return sendGuardError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON (Content-Type: application/json).');
    if (req.body !== undefined && req.body !== null && (typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ ok: false, error: 'The body is a JSON object.', code: 'invalid_body' });
    next();
  };

  /**
   * Who may create: the owner from the page, or an Assistant brain. `write`: the owner's page header and route
   * guard are asked too (a read from the page needs neither, but never a guest's).
   */
  const caller = (write) => (req, res, next) => {
    const principal = principalOf(req, isGuestRequest);
    if (principal.kind === 'guest') return sendGuardError(res, 403, 'GUEST_FORBIDDEN', 'Available to the owner only.');
    if (principal.kind === 'owner') {
      req.creator = { kind: 'owner', assistantSessionId: null };
      if (!write) { pageSession?.attach?.(res); return next(); }
      if (req.headers['x-synabun-ui'] !== '1') return sendGuardError(res, 403, 'UI_HEADER_REQUIRED', 'Send the X-SynaBun-UI: 1 header.');
      // The page secret (lib/page-session.js): what a local process that merely left the agent headers out lacks.
      if (pageSession && !pageSession.verify(req)) return pageSession.require(req, res, next);
      return ownerGuard ? ownerGuard(req, res, next) : next();
    }
    // An agent: only an Assistant brain, by its credential (never by a header any local process can send), and never
    // a dispatched worker.
    let who = null;
    try { who = typeof assistantCaller === 'function' ? assistantCaller(req) : null; } catch { who = null; }
    if (who?.kind === 'worker') return sendGuardError(res, 403, 'WORKERS_NOT_PERMITTED', 'Dispatched workers cannot create skills: the Assistant or the owner does.');
    if (who?.kind !== 'assistant' || typeof who.assistantSessionId !== 'string' || !who.assistantSessionId) {
      return sendGuardError(res, 403, 'ASSISTANT_CREDENTIAL_REQUIRED', 'Drafting skills with AI is the owner\'s (Skills Studio) and the SynaBun Assistant\'s own brain\'s (its launch credential): a role header is not enough.');
    }
    req.creator = { kind: 'assistant', assistantSessionId: who.assistantSessionId, terminal: principal.terminal || null };
    next();
  };
  /** The owner sees every creation; an Assistant brain the ones its own session started. */
  const ownOnly = (creation, req) => req.creator.kind === 'owner' || (creation.by?.kind === 'assistant' && typeof creation.assistantSessionId === 'string' && creation.assistantSessionId !== '' && creation.assistantSessionId === req.creator.assistantSessionId);
  const idCheck = (req, res, next) => (isCreationId(req.params.creationId) ? next() : res.status(400).json({ ok: false, error: 'Not a creation id.', code: 'invalid_id' }));
  /** Same caller, same route, same key within ten minutes: the first answer again (one creation, not two). */
  const once = (handler) => async (req, res) => {
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null);
    if (!key) return handler(req, res);
    if (key.length > 200) return res.status(400).json({ ok: false, error: 'An idempotency key is at most 200 characters.', code: 'invalid_idempotency_key' });
    const slot = `${req.creator?.kind}\0${req.creator?.assistantSessionId || ''}\0${req.method}\0${req.originalUrl || req.url}\0${key}`;
    const hit = idem.get(slot);
    if (hit && Date.now() - hit.at < IDEMPOTENCY_TTL_MS) return res.status(hit.status).json({ ...hit.body, replayed: true });
    const original = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 300) { idem.set(slot, { at: Date.now(), status: res.statusCode, body }); if (idem.size > 300) idem.delete(idem.keys().next().value); }
      return original(body);
    };
    return handler(req, res);
  };

  route('get', '/creations/options', caller(false), safe(async (req, res) => {
    const o = (typeof options === 'function' ? options() : options) || {};
    res.json({
      ok: true, kinds: SOURCE_KINDS, limits: CREATION_LIMITS, active: creations.activeCount(), maxActive: creations.limits.maxActive,
      conversation: Array.isArray(o.conversation) ? o.conversation.filter((p) => CONVERSATION_PROVIDERS.includes(p)) : [],
      url: o.url === true, ...(o.url !== true && typeof o.urlReason === 'string' && o.urlReason ? { urlReason: o.urlReason.slice(0, 400) } : {}),
      memory: o.memory === true, import: o.import === true,
      // Who drafts (every provider a drafting run can be held to its folder on: lib/skills/draft-confinement.js), whether
      // one can run here now, and, when the host says, each provider's own answer (`providerStatus`: installed or not,
      // with why, and how it is confined) so the page can grey out what cannot run.
      drafting: {
        providers: DRAFT_PROVIDERS, available: o.drafting?.available !== false,
        ...(o.drafting?.available === false && typeof o.drafting?.reason === 'string' ? { reason: o.drafting.reason.slice(0, 400) } : {}),
        ...(Array.isArray(o.drafting?.providers) && o.drafting.providers.every((p) => p && typeof p === 'object') ? { providerStatus: o.drafting.providers.filter((p) => DRAFT_PROVIDERS.includes(p.provider)).map((p) => ({ provider: p.provider, available: p.available === true, ...(p.reason ? { reason: String(p.reason).slice(0, 400) } : {}), ...(p.level ? { level: String(p.level) } : {}), ...(p.note ? { note: String(p.note).slice(0, 400) } : {}) })) } : {}),
      },
      repo: (Array.isArray(o.repo) ? o.repo : []).map((p) => ({ path: String(p.path), label: String(p.label || p.path) })).slice(0, 200),
      defaultTarget: o.defaultTarget && typeof o.defaultTarget === 'object' ? { provider: o.defaultTarget.provider, model: o.defaultTarget.model || null, effort: o.defaultTarget.effort || null, route: o.defaultTarget.route === true } : null,
    });
  }));
  route('get', '/creations/sessions', caller(false), safe(async (req, res) => {
    const q = req.query || {};
    const provider = typeof q.provider === 'string' ? q.provider : '';
    if (!CONVERSATION_PROVIDERS.includes(provider)) return res.status(400).json({ ok: false, error: `provider is one of ${CONVERSATION_PROVIDERS.join(', ')}.`, code: 'invalid_provider' });
    if (typeof sessions !== 'function') return res.status(409).json({ ok: false, error: 'This server lists no sessions.', code: 'source_unavailable' });
    const list = await sessions({ provider, project: typeof q.project === 'string' && q.project ? q.project.slice(0, 4000) : null, q: typeof q.q === 'string' ? q.q.slice(0, 200) : '', limit: Math.min(100, Math.max(1, Number(q.limit) || 40)) });
    res.json({ ok: true, provider, sessions: Array.isArray(list) ? list.slice(0, 100) : [] });
  }));
  route('get', '/creations', caller(false), safe(async (req, res) => {
    const all = creations.list({ limit: Number(req.query?.limit) || 30 });
    res.json({ ok: true, creations: req.creator.kind === 'owner' ? all : all.filter((c) => ownOnly(c, req)) });
  }));
  route('post', '/creations', json, caller(true), once(safe(async (req, res) => {
    const body = { ...(req.body || {}) };
    delete body.idempotencyKey; delete body.assistantSessionId; delete body.assistant_session_id;
    const creation = creations.start(body, {
      by: { kind: req.creator.kind },
      assistantSessionId: req.creator.assistantSessionId,
      // The owner's draft goes to Review by itself; the Assistant looks at it first unless it says otherwise.
      submitDefault: req.creator.kind === 'owner',
    });
    res.status(202).json({ ok: true, creation });
  })));
  route('get', '/creations/:creationId', caller(false), idCheck, safe(async (req, res) => {
    const creation = creations.get(req.params.creationId);
    if (!ownOnly(creation, req)) return sendGuardError(res, 403, 'NOT_YOURS', 'This creation was started by someone else.');
    res.json({ ok: true, creation });
  }));
  route('get', '/creations/:creationId/wait', caller(false), idCheck, safe(async (req, res) => {
    const current = creations.get(req.params.creationId);
    if (!ownOnly(current, req)) return sendGuardError(res, 403, 'NOT_YOURS', 'This creation was started by someone else.');
    const since = Number.isInteger(Number(req.query?.since)) ? Number(req.query.since) : -1;
    const creation = await creations.wait(req.params.creationId, { sinceVersion: since, timeoutMs: Math.min(50, Math.max(1, Number(req.query?.seconds) || 25)) * 1000 });
    res.json({ ok: true, creation });
  }));
  route('post', '/creations/:creationId/cancel', json, caller(true), idCheck, safe(async (req, res) => {
    const current = creations.get(req.params.creationId);
    if (!ownOnly(current, req)) return sendGuardError(res, 403, 'NOT_YOURS', 'This creation was started by someone else.');
    res.json({ ok: true, creation: await creations.cancel(req.params.creationId) });
  }));
  route('post', '/creations/:creationId/retry', json, caller(true), idCheck, once(safe(async (req, res) => {
    const current = creations.get(req.params.creationId);
    if (!ownOnly(current, req)) return sendGuardError(res, 403, 'NOT_YOURS', 'This creation was started by someone else.');
    const creation = creations.retry(req.params.creationId, { by: { kind: req.creator.kind }, assistantSessionId: req.creator.assistantSessionId });
    res.status(202).json({ ok: true, creation });
  })));

  // The skill-forge workflow SynaBun ships (skills/skill-forge), for the Assistant's `skill` action "guide": its
  // SKILL.md, or one of its files (`file`). Read from the library's copy of what this app version ships.
  route('get', '/guide', (req, res, next) => {
    const principal = principalOf(req, isGuestRequest);
    if (principal.kind === 'guest') return sendGuardError(res, 403, 'GUEST_FORBIDDEN', 'Available to the owner only.');
    next();
  }, safe(async (req, res) => {
    const file = typeof req.query?.file === 'string' && req.query.file ? req.query.file : 'SKILL.md';
    const revision = service.bundledRevision(SKILL_FORGE);
    if (!revision) return res.status(404).json({ ok: false, error: 'This SynaBun ships no skill-forge.', code: 'guide_missing' });
    const entry = revision.manifest.files.find((f) => f.path === file);
    if (!entry) return res.status(404).json({ ok: false, error: `skill-forge has no file "${String(file).slice(0, 200)}".`, code: 'file_not_found', files: revision.manifest.files.map((f) => f.path) });
    const { bytes } = service.library.readRevisionFile(revision.revisionId, entry.path);
    res.json({ ok: true, skill: SKILL_FORGE, revisionId: revision.revisionId, path: entry.path, files: revision.manifest.files.map((f) => f.path), content: bytes.toString('utf-8') });
  }));
}

