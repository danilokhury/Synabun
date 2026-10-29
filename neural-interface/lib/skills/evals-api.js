// ── /api/skills-studio/v2/evals: skill evaluations over HTTP (P4) ──
// The routes of lib/skills/evals.js, beside the Skills Service's other v2 routes. Who may do what (as AI creation,
// lib/skills/creation-api.js: an evaluation runs workers and spends money):
//
//   the owner        from SynaBun's own page: every route, a read included, needs this boot's page secret cookie
//                    (lib/page-session.js: never handed to, nor accepted from, SynaBun's automation browser or a peer
//                    process the owner-authority lookup refuses) and the owner route guard (its Host, no guest); a
//                    write also its X-SynaBun-UI: 1 header (and the guard its Origin). Estimates, starts, reads, waits
//                    on and cancels every evaluation, writes review notes on its trials, exports and compares runs,
//                    converts another tool's suite, confirms Codex for a skill version. Nothing starts without the
//                    owner's Run (or the Assistant's request below). Where the peer lookup cannot run (not macOS, no
//                    `ps`), the page secret and the guard are what is asked, as before it (docs/skills-studio.md).
//   the Assistant    a request carrying the credential its brain's launch was given (X-Synabun-Brain-Token, resolved
//                    to that brain's session): estimates, starts (under its session's budget), reads, waits on,
//                    cancels and reports the evaluations of its own session, and reads whether Codex is confirmed for
//                    a version (it never confirms it). Its results are the owner's too (the Studio lists every
//                    evaluation). X-Synabun-Role and X-Synabun-Terminal prove nothing; a dispatched worker is
//                    refused whatever it sends.
//   anyone else      403 (a guest, an agent without a brain's credential).
//
// A trial's output file is answered as JSON text (never as a page of this origin), bounded, never through a link.

import AdmZip from 'adm-zip';
import { sendGuardError } from '../http-guards.js';
import { PathConfineError } from '../path-confine.js';
import { V2_BASE, principalOf } from './api-v2.js';
import { isTrialId } from './evals.js';
import { isEvalRunId } from '../../public/shared/skills/ss-eval-plan.js';

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const FORMATS = new Set(['native', 'skill-creator', 'agent-skills']);

function fail(res, err) {
  const status = err instanceof PathConfineError ? err.status : (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500);
  const body = { ok: false, error: status >= 500 && !(err instanceof PathConfineError) ? `The evaluation failed: ${err?.message || err}` : (err?.message || String(err)) };
  if (typeof err?.code === 'string' && !/^E[A-Z]+$/.test(err.code)) body.code = err.code;
  for (const key of ['problems', 'estimate', 'skipped', 'codex']) if (err?.[key] !== undefined) body[key] = err[key];
  return res.status(status).json(body);
}

/**
 * @param {object} app express app
 * @param {object} o
 * @param {object} o.evals lib/skills/evals.js
 * @param {(req) => boolean} [o.isGuestRequest]
 * @param {Function} [o.ownerGuard] lib/http-guards.js ownerRouteGuard(…) of this server
 * @param {(req) => ({ kind: 'assistant', assistantSessionId } | { kind: 'worker' } | null)} [o.assistantCaller]
 * @param {{ verify(req), require(req, res, next), attach(res) }} [o.pageSession] lib/page-session.js
 */
export function registerSkillEvalRoutes(app, { evals, isGuestRequest = null, ownerGuard = null, assistantCaller = null, pageSession = null } = {}) {
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
   * Who may evaluate: the owner from the page (a read too: this boot's page secret and the owner route guard; a write
   * also the page header), or an Assistant brain by its credential.
   */
  const caller = (write, { ownerOnly = false } = {}) => (req, res, next) => {
    const principal = principalOf(req, isGuestRequest);
    if (principal.kind === 'guest') return sendGuardError(res, 403, 'GUEST_FORBIDDEN', 'Available to the owner only.');
    if (principal.kind === 'owner') {
      req.evaluator = { kind: 'owner', assistantSessionId: null };
      if (write && req.headers['x-synabun-ui'] !== '1') return sendGuardError(res, 403, 'UI_HEADER_REQUIRED', 'Send the X-SynaBun-UI: 1 header.');
      // The page secret (lib/page-session.js verify: absent, stale, carried by the automation browser or by a peer the
      // owner-authority lookup refuses, it is refused): what a local process that merely left the agent headers out lacks.
      if (pageSession && !pageSession.verify(req)) {
        if (write) return pageSession.require(req, res, next);
        return sendGuardError(res, 403, 'PAGE_SECRET_REQUIRED', 'Evaluations are read from SynaBun\'s own page. Reload the page and try again.');
      }
      return ownerGuard ? ownerGuard(req, res, next) : next();
    }
    let who = null;
    try { who = typeof assistantCaller === 'function' ? assistantCaller(req) : null; } catch { who = null; }
    if (who?.kind === 'worker') return sendGuardError(res, 403, 'WORKERS_NOT_PERMITTED', 'Dispatched workers cannot run skill evaluations: the Assistant or the owner does.');
    if (who?.kind !== 'assistant' || typeof who.assistantSessionId !== 'string' || !who.assistantSessionId) {
      return sendGuardError(res, 403, 'ASSISTANT_CREDENTIAL_REQUIRED', 'Skill evaluations are the owner\'s (Skills Studio) and the SynaBun Assistant\'s own brain\'s (its launch credential): a role header is not enough.');
    }
    if (ownerOnly) return sendGuardError(res, 403, 'UI_ONLY', 'Review notes and the Codex confirmation are the owner\'s, from Skills Studio.');
    req.evaluator = { kind: 'assistant', assistantSessionId: who.assistantSessionId };
    next();
  };
  /** The owner sees every evaluation; an Assistant brain those its own session started. */
  const ownOnly = (run, req) => req.evaluator.kind === 'owner' || (run.by?.kind === 'assistant' && typeof run.assistantSessionId === 'string' && run.assistantSessionId !== '' && run.assistantSessionId === req.evaluator.assistantSessionId);
  const idCheck = (req, res, next) => {
    if (!isEvalRunId(req.params.evalRunId)) return res.status(400).json({ ok: false, error: 'Not an evaluation id.', code: 'invalid_id' });
    if (req.params.trialId !== undefined && !isTrialId(req.params.trialId)) return res.status(400).json({ ok: false, error: 'Not a trial id.', code: 'invalid_trial' });
    next();
  };
  const mine = (req, res) => {
    const run = evals.get(req.params.evalRunId);
    if (!ownOnly(run, req)) { sendGuardError(res, 403, 'NOT_YOURS', 'This evaluation was started by someone else.'); return null; }
    return run;
  };
  /** Same caller, same route, same key within ten minutes: the first answer again (one evaluation, not two). */
  const once = (handler) => async (req, res) => {
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null);
    if (!key) return handler(req, res);
    if (key.length > 200) return res.status(400).json({ ok: false, error: 'An idempotency key is at most 200 characters.', code: 'invalid_idempotency_key' });
    const slot = `${req.evaluator?.kind}\0${req.evaluator?.assistantSessionId || ''}\0${req.method}\0${req.originalUrl || req.url}\0${key}`;
    const hit = idem.get(slot);
    if (hit && Date.now() - hit.at < IDEMPOTENCY_TTL_MS) return res.status(hit.status).json({ ...hit.body, replayed: true });
    const original = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 300) { idem.set(slot, { at: Date.now(), status: res.statusCode, body }); if (idem.size > 300) idem.delete(idem.keys().next().value); }
      return original(body);
    };
    return handler(req, res);
  };
  const bodyOf = (req) => { const b = { ...(req.body || {}) }; delete b.idempotencyKey; delete b.assistantSessionId; delete b.assistant_session_id; return b; };

  // The fixed paths first: they are not evaluation ids.
  route('get', '/evals/options', caller(false), safe(async (req, res) => res.json({ ok: true, ...(await evals.options()) })));
  route('get', '/evals/queue', caller(false), safe(async (req, res) => {
    const q = evals.queue();
    if (req.evaluator.kind === 'owner') return res.json({ ok: true, ...q });
    // The Assistant sees the queue's length and its own place in it, not what the owner runs.
    const own = (r) => r && evals.get(r.evalRunId)?.assistantSessionId === req.evaluator.assistantSessionId;
    res.json({ ok: true, active: q.active.filter(own), waiting: q.waiting.filter(own), activeCount: q.active.length, waitingCount: q.waiting.length, maxActive: q.maxActive, queueMax: q.queueMax });
  }));
  route('get', '/evals/compare', caller(false), safe(async (req, res) => {
    const a = String(req.query?.a || ''); const b = String(req.query?.b || '');
    if (!isEvalRunId(a) || !isEvalRunId(b)) return res.status(400).json({ ok: false, error: 'Name two evaluations (a, b).', code: 'invalid_id' });
    for (const id of [a, b]) { const run = evals.get(id); if (!ownOnly(run, req)) return sendGuardError(res, 403, 'NOT_YOURS', 'This evaluation was started by someone else.'); }
    res.json({ ok: true, comparison: evals.compare(a, b) });
  }));
  // Codex is the owner's opt-in per skill version (lib/skills/evals.js): whether it is confirmed, and the confirmation.
  route('get', '/evals/codex-trust', caller(false), safe(async (req, res) => {
    const ids = String(req.query?.revisionIds || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
    if (!ids.length || ids.some((x) => !/^rev_[0-9a-f]{20}$/.test(x))) return res.status(400).json({ ok: false, error: 'Name the version(s) (revisionIds).', code: 'invalid_request' });
    res.json({ ok: true, ...evals.codexTrust(ids) });
  }));
  route('post', '/evals/codex-trust', json, caller(true, { ownerOnly: true }), safe(async (req, res) => {
    const b = req.body || {};
    res.json({ ok: true, ...evals.setCodexTrust({ revisionIds: Array.isArray(b.revisionIds) ? b.revisionIds : [], trusted: b.trusted !== false }) });
  }));
  route('post', '/evals/estimate', json, caller(true), safe(async (req, res) => res.json({ ok: true, ...(await evals.estimate(bodyOf(req))) })));
  route('post', '/evals/import', json, caller(true), safe(async (req, res) => {
    const b = req.body || {};
    const tooBig = (v) => typeof v === 'string' ? v.length > 1024 * 1024 : JSON.stringify(v ?? null).length > 1024 * 1024;
    if (tooBig(b.tasks) || tooBig(b.triggers)) return res.status(413).json({ ok: false, error: 'A suite to import is at most 1 MB.', code: 'too_large' });
    const out = evals.importSuite({ tasks: b.tasks ?? null, triggers: b.triggers ?? null, skillName: typeof b.skillName === 'string' ? b.skillName.slice(0, 64) : '', seed: Number.isInteger(b.seed) ? b.seed : 42 });
    res.status(out.ok ? 200 : 422).json({ ok: out.ok, ...out, ...(out.ok ? {} : { error: out.problems[0]?.message || 'The suite cannot be imported.', code: out.problems[0]?.code || 'invalid_suite' }) });
  }));
  route('get', '/evals', caller(false), safe(async (req, res) => {
    const q = req.query || {};
    const skillId = typeof q.skillId === 'string' && /^skl_[0-9a-f]{20}$/.test(q.skillId) ? q.skillId : null;
    const revisionId = typeof q.revisionId === 'string' && /^rev_[0-9a-f]{20}$/.test(q.revisionId) ? q.revisionId : null;
    const list = evals.list({ skillId, revisionId, limit: Number(q.limit) || 30, ...(req.evaluator.kind === 'assistant' ? { assistantSessionId: req.evaluator.assistantSessionId } : {}) });
    res.json({ ok: true, evals: list, queue: req.evaluator.kind === 'owner' ? evals.queue() : null });
  }));
  route('post', '/evals', json, caller(true), once(safe(async (req, res) => {
    const run = await evals.start(bodyOf(req), { by: { kind: req.evaluator.kind }, assistantSessionId: req.evaluator.assistantSessionId });
    res.status(202).json({ ok: true, eval: run });
  })));
  route('get', '/evals/:evalRunId', caller(false), idCheck, safe(async (req, res) => {
    const run = mine(req, res); if (!run) return;
    res.json({ ok: true, eval: run });
  }));
  route('get', '/evals/:evalRunId/wait', caller(false), idCheck, safe(async (req, res) => {
    if (!mine(req, res)) return;
    const since = Number.isInteger(Number(req.query?.since)) ? Number(req.query.since) : -1;
    const run = await evals.wait(req.params.evalRunId, { sinceVersion: since, timeoutMs: Math.min(50, Math.max(1, Number(req.query?.seconds) || 25)) * 1000, compact: req.query?.full !== '1' });
    res.json({ ok: true, eval: run });
  }));
  route('post', '/evals/:evalRunId/cancel', json, caller(true), idCheck, safe(async (req, res) => {
    if (!mine(req, res)) return;
    res.json({ ok: true, eval: await evals.cancel(req.params.evalRunId) });
  }));
  route('post', '/evals/:evalRunId/feedback', json, caller(true, { ownerOnly: true }), idCheck, safe(async (req, res) => {
    const b = req.body || {};
    res.json({ ok: true, feedback: evals.feedback(req.params.evalRunId, { trialId: typeof b.trialId === 'string' ? b.trialId : '', text: typeof b.text === 'string' ? b.text : '', reviewed: typeof b.reviewed === 'boolean' ? b.reviewed : null }) });
  }));
  route('get', '/evals/:evalRunId/trials/:trialId', caller(false), idCheck, safe(async (req, res) => {
    if (!mine(req, res)) return;
    res.json({ ok: true, trial: evals.trial(req.params.evalRunId, req.params.trialId) });
  }));
  route('get', '/evals/:evalRunId/trials/:trialId/file', caller(false), idCheck, safe(async (req, res) => {
    if (!mine(req, res)) return;
    const path = typeof req.query?.path === 'string' ? req.query.path : '';
    if (!path || path.length > 300 || path.split('/').includes('..') || path.startsWith('/')) return res.status(400).json({ ok: false, error: 'Name a file the trial wrote (path).', code: 'invalid_path' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, file: evals.trialFile(req.params.evalRunId, req.params.trialId, path) });
  }));
  route('get', '/evals/:evalRunId/export', caller(false), idCheck, safe(async (req, res) => {
    if (!mine(req, res)) return;
    const format = typeof req.query?.format === 'string' && FORMATS.has(req.query.format) ? req.query.format : 'native';
    const out = evals.exportRun(req.params.evalRunId, format);
    const safeName = out.name.replace(/[^A-Za-z0-9._-]/g, '_');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (out.name.endsWith('.zip')) {
      const zip = new AdmZip();
      const folder = safeName.replace(/\.skill-creator\.zip$/, '');
      for (const e of out.entries) zip.addFile(`${folder}/${e.path}`, Buffer.from(e.text, 'utf-8'));
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="${safeName}"`);
      return res.send(zip.toBuffer());
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(out.entries[0].text);
  }));
}
