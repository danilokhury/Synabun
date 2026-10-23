// ── /api/skills-studio/v2: the Skills Service over HTTP ──
// The routes the Studio, Settings and the MCP `skill` tool use (lib/skills/service.js does the work). Under the
// Skills Studio permission like the rest of /api/skills-studio; on top of it, who may do what:
//
//   read         everyone the permission lets in (the catalog, the library, plans, reviews, profiles, status);
//   draft        the owner and agents (the Assistant, a worker): drafts, snapshots, checks, adopting a folder,
//                submitting a revision for review, commenting on it, withdrawing one's own. Never a guest.
//   deploy       the owner, from SynaBun's own page only: installing, rolling back, removing, approving or
//                rejecting a review, migrating the old bridges, moving a pointer, deleting a skill from the
//                library, the settings. A request that
//                carries an agent's headers is refused (403 UI_ONLY) whatever else it says, as is a guest, another
//                site's page, or a request without the page's X-SynaBun-UI header. An agent asks for a plan
//                (POST /installations/plan) and submits for review; the owner installs.
//
// Ids in paths are opaque (`skl_`, `rev_`, `drf_`, `rvw_`, `ins_`, `mig_`, `art_`) and checked by shape before
// anything is looked up; no id is ever a path. Errors are JSON `{ ok: false, error, code, … }` with 400/422 for
// what the request says, 403 for who sent it, 404, 409 for a conflict (with what is current), 413 for a limit.
// A POST that creates something takes an idempotency key (header `Idempotency-Key` or `idempotencyKey`): the same
// key from the same caller within ten minutes gets the first answer again, and nothing is made twice.

import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { AGENT_HEADERS, sendGuardError } from '../http-guards.js';
import { PathConfineError } from '../path-confine.js';
import { readConfinedFile } from '../confined-fs.js';
import { isArtifactId } from './catalog.js';
import { checkFolder, folderDigest, isDraftId, isRevisionId, isSkillId } from './library.js';
import { buildBundle, bundlePathProblem, collectFolder } from './bundle.js';
import { buildExport } from './export.js';
import { effectiveInstallName } from './deploy.js';
import { isEditableText } from '../../public/shared/skills/ss-doc.js';

/** The largest file of a catalog skill the Studio reads (a SKILL.md's bound, as the P0 routes read one). */
const CATALOG_FILE_MAX_BYTES = 2 * 1024 * 1024;

export const V2_BASE = '/api/skills-studio/v2';
const IDS = {
  skillId: isSkillId, revisionId: isRevisionId, draftId: isDraftId, artifactId: isArtifactId,
  reviewId: (v) => typeof v === 'string' && /^rvw_[0-9a-f]{20}$/.test(v),
  installationId: (v) => typeof v === 'string' && /^ins_[0-9a-f]{20}$/.test(v),
  journalId: (v) => typeof v === 'string' && /^mig_[0-9a-f]{20}$/.test(v),
};
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX = 500;

/**
 * Who is asking: an agent (its headers), a guest, or the owner. An agent is the Assistant only when `assistantOf`
 * resolves the credential its brain was launched with (X-Synabun-Brain-Token: assistant-runtime.js
 * mintBrainCredential) to that brain's session: X-Synabun-Role is a header any local process can send, so without a
 * verifier, or without the credential, an agent is only an agent.
 * @param {(req) => string|null} [assistantOf] the Assistant session a request's brain credential belongs to
 */
export function principalOf(req, isGuestRequest = null, assistantOf = null) {
  const h = req.headers || {};
  if (AGENT_HEADERS.some((name) => h[name] !== undefined)) {
    const role = typeof h['x-synabun-role'] === 'string' ? h['x-synabun-role'] : '';
    let session = null;
    if (role === 'assistant' && typeof assistantOf === 'function') { try { session = assistantOf(req) || null; } catch { session = null; } }
    return { kind: session ? 'assistant' : 'agent', role: role || null, terminal: typeof h['x-synabun-terminal'] === 'string' ? h['x-synabun-terminal'].slice(0, 200) : null, ...(session ? { assistantSessionId: String(session) } : {}) };
  }
  let guest = false;
  if (typeof isGuestRequest === 'function') { try { guest = !!isGuestRequest(req); } catch { guest = true; } }
  return guest ? { kind: 'guest' } : { kind: 'owner' };
}

/** Whether a principal is the author a record names: the same kind of caller, from the same (non-empty) terminal. */
function sameAuthor(principal, author) {
  if (!principal || !author || principal.kind === 'owner' || author.kind === 'owner') return false;
  return principal.kind === author.kind && typeof principal.terminal === 'string' && principal.terminal !== '' && principal.terminal === author.terminal;
}

/** An author record for something a principal made, with what the request adds (an agent's run, provider, model). */
function authorOf(principal, body = {}) {
  const kind = principal.kind === 'owner' ? 'owner' : (principal.kind === 'assistant' ? 'assistant' : 'agent');
  const out = { kind };
  if (principal.terminal) out.terminal = principal.terminal;
  if (kind !== 'owner') for (const key of ['runId', 'provider', 'model', 'modelProvider', 'sessionId']) if (typeof body?.[key] === 'string' && body[key]) out[key] = body[key].slice(0, 200);
  return out;
}

function fail(res, err) {
  const status = err instanceof PathConfineError ? err.status : (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500);
  const body = { ok: false, error: status >= 500 && !(err instanceof PathConfineError) ? `The skills service failed: ${err?.message || err}` : (err?.message || String(err)) };
  if (typeof err?.code === 'string' && !/^E[A-Z]+$/.test(err.code)) body.code = err.code;
  for (const key of ['problems', 'currentEtag', 'currentDigest', 'currentRevision', 'plan', 'notRestored', 'installations']) if (err?.[key] !== undefined) body[key] = err[key];
  return res.status(status).json(body);
}

/**
 * @param {object} app express app
 * @param {object} o
 * @param {object} o.service lib/skills/service.js
 * @param {(req) => boolean} [o.isGuestRequest]
 * @param {Function} [o.ownerGuard] lib/http-guards.js ownerRouteGuard(…) of this server (Host, Origin, guests)
 * @param {(req) => string|null} [o.assistantOf] the Assistant session a request's brain credential belongs to (principalOf)
 */
export function registerSkillsV2Routes(app, { service, isGuestRequest = null, ownerGuard = null, assistantOf = null } = {}) {
  const idem = new Map();

  const json = (req, res, next) => {
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return sendGuardError(res, 403, 'CROSS_SITE', 'Cross-site requests are refused.');
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && typeof req.is === 'function' && !req.is('application/json')) return sendGuardError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON (Content-Type: application/json).');
    if (req.body !== undefined && req.body !== null && (typeof req.body !== 'object' || Array.isArray(req.body))) {
      return res.status(400).json({ ok: false, error: 'The body is a JSON object.', code: 'invalid_body' });
    }
    next();
  };
  const reader = (req, res, next) => { req.principal = principalOf(req, isGuestRequest, assistantOf); next(); };
  const writer = (req, res, next) => {
    req.principal = principalOf(req, isGuestRequest, assistantOf);
    if (req.principal.kind === 'guest') return sendGuardError(res, 403, 'GUEST_FORBIDDEN', 'Available to the owner only.');
    next();
  };
  const owner = (req, res, next) => {
    req.principal = principalOf(req, isGuestRequest, assistantOf);
    if (req.principal.kind !== 'owner') return sendGuardError(res, 403, req.principal.kind === 'guest' ? 'GUEST_FORBIDDEN' : 'UI_ONLY', req.principal.kind === 'guest' ? 'Available to the owner only.' : 'Installing, approving and migrating are the owner\'s, from SynaBun\'s own page: ask the owner to review it in Skills Studio.');
    if (req.headers['x-synabun-ui'] !== '1') return sendGuardError(res, 403, 'UI_HEADER_REQUIRED', 'Send the X-SynaBun-UI: 1 header.');
    if (!ownerGuard) return next();
    return ownerGuard(req, res, next);
  };
  const ids = (...names) => (req, res, next) => {
    for (const name of names) {
      if (!IDS[name](req.params[name])) return res.status(400).json({ ok: false, error: `Not a ${name.replace(/Id$/, '')} id.`, code: 'invalid_id' });
    }
    next();
  };
  /** Same caller, same route, same key within ten minutes: the first answer again. */
  const once = (handler) => async (req, res) => {
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null);
    if (!key) return handler(req, res);
    if (key.length > 200) return res.status(400).json({ ok: false, error: 'An idempotency key is at most 200 characters.', code: 'invalid_idempotency_key' });
    const slot = `${req.principal?.kind}\0${req.principal?.terminal || ''}\0${req.method}\0${req.originalUrl || req.url}\0${key}`;
    const hit = idem.get(slot);
    if (hit && Date.now() - hit.at < IDEMPOTENCY_TTL_MS) return res.status(hit.status).json({ ...hit.body, replayed: true });
    const original = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 300) {
        idem.set(slot, { at: Date.now(), status: res.statusCode, body });
        if (idem.size > IDEMPOTENCY_MAX) idem.delete(idem.keys().next().value);
      }
      return original(body);
    };
    return handler(req, res);
  };
  const safe = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err); } };
  const route = (method, path, ...handlers) => app[method](`${V2_BASE}${path}`, ...handlers);

  // ── Reading ──
  route('get', '/capabilities', reader, safe(async (req, res) => res.json({ ok: true, version: service.version, capabilities: service.capabilities })));
  route('get', '/status', reader, safe(async (req, res) => res.json({ ok: true, ...(await service.status()) })));
  route('get', '/roots', reader, safe(async (req, res) => res.json({ ok: true, roots: service.roots() })));
  route('get', '/profiles', reader, safe(async (req, res) => res.json({ ok: true, profiles: service.profiles() })));
  route('get', '/catalog', reader, safe(async (req, res) => {
    const q = req.query || {};
    const str = (v) => (typeof v === 'string' && v ? v.slice(0, 500) : null);
    const page = await service.catalogPage({ cursor: str(q.cursor), limit: Number(q.limit) || 100, kind: str(q.kind), runtime: str(q.runtime), rootId: str(q.rootId), scope: str(q.scope), q: str(q.q) || '' });
    const scan = await service.catalogScan();
    res.json({ ok: true, ...page, roots: scan.roots.map(({ rootId, family, kind, scope, sourceKind, runtimes, accountId, projectLabel, path, status, policy, count, truncated }) => ({ rootId, family, kind, scope, sourceKind, runtimes, accountId, projectLabel, path, status, policy, count, truncated })), diagnostics: scan.diagnostics.slice(0, 500) });
  }));
  route('get', '/catalog/:artifactId', reader, ids('artifactId'), safe(async (req, res) => {
    const found = await service.catalogDetail(req.params.artifactId);
    if (!found) return res.status(404).json({ ok: false, error: 'There is no such entry in the catalog.', code: 'artifact_not_found' });
    res.json({ ok: true, entry: found.entry });
  }));
  // One file of a catalog skill (a plugin's, a Claude account's, Codex's own, a folder of the owner's), read the way
  // the head file is: inside the skill's real folder, the last component opened without following a link, a regular
  // file, bounded. Hidden files and node_modules are left out, as an export leaves them out. Text comes as text,
  // anything else as base64. The Studio shows a skill it cannot write without copying it first.
  route('get', '/catalog/:artifactId/file', reader, ids('artifactId'), safe(async (req, res) => {
    const path = typeof req.query?.path === 'string' ? req.query.path : '';
    const why = path ? bundlePathProblem(path) : 'no path';
    if (why) return res.status(400).json({ ok: false, error: `Not a file of a skill: ${why}.`, code: 'invalid_path' });
    if (path.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) return res.status(403).json({ ok: false, error: 'Hidden files and node_modules are not read here.', code: 'hidden_file' });
    const entry = await service.catalogFind(req.params.artifactId);
    if (!entry) return res.status(404).json({ ok: false, error: 'There is no such entry in the catalog.', code: 'artifact_not_found' });
    if (entry.kind !== 'skill') return res.status(400).json({ ok: false, error: 'A command or an agent is one file: GET /catalog/:id carries its text.', code: 'not_a_skill' });
    let bytes;
    try { bytes = readConfinedFile(entry.realPath, join(entry.realPath, path), { maxBytes: CATALOG_FILE_MAX_BYTES }); } catch (err) {
      if (err?.code === 'ENOENT' || err?.status === 404) return res.status(404).json({ ok: false, error: 'The skill has no such file.', code: 'file_not_found' });
      throw err;
    }
    const text = isEditableText(bytes);
    res.json({ ok: true, path, size: bytes.length, binary: !text, ...(text ? { content: bytes.toString('utf-8') } : { contentBase64: bytes.toString('base64') }) });
  }));
  // A revision against a catalog skill folder as it is now (an installed copy against what SynaBun ships): the
  // folder is read whole the way an export reads it (no link followed, within an import's limits).
  route('get', '/compare', reader, safe(async (req, res) => {
    const { from, artifactId } = req.query || {};
    if (!isRevisionId(from) || !isArtifactId(artifactId)) return res.status(400).json({ ok: false, error: 'from is a revision id and artifactId a catalog entry.', code: 'invalid_id' });
    const entry = await service.catalogFind(artifactId);
    if (!entry || entry.kind !== 'skill') return res.status(404).json({ ok: false, error: 'There is no such skill in the catalog.', code: 'artifact_not_found' });
    const { files, dirs } = collectFolder(entry.realPath);
    res.json({ ok: true, diff: service.library.diffRevisionFolder(from, { files, dirs }, { path: entry.path }) });
  }));
  route('post', '/catalog/rescan', json, writer, safe(async (req, res) => { const s = await service.catalogScan({ force: true }); res.json({ ok: true, generation: s.generation, generatedAt: s.generatedAt, entries: s.entries.length, truncated: s.truncated }); }));
  route('get', '/config', reader, safe(async (req, res) => res.json({ ok: true, config: service.getConfig() })));
  route('put', '/config', json, owner, safe(async (req, res) => res.json({ ok: true, config: service.setConfig(req.body || {}) })));

  // ── The library ──
  route('get', '/skills', reader, safe(async (req, res) => res.json({ ok: true, skills: service.listSkills() })));
  route('post', '/skills', json, writer, once(safe(async (req, res) => {
    const body = req.body || {};
    const author = authorOf(req.principal, body);
    if (body.artifactId !== undefined) {
      if (!isArtifactId(body.artifactId)) return res.status(400).json({ ok: false, error: 'Not an artifact id.', code: 'invalid_id' });
      const out = await service.adopt({ artifactId: body.artifactId, author });
      return res.status(out.created ? 201 : 200).json({ ok: true, ...out });
    }
    const files = decodeFiles(body.files);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ ok: false, error: 'A new skill has a name.', code: 'invalid_name' });
    const draft = service.library.createDraft({ name, files, dirs: Array.isArray(body.dirs) ? body.dirs : [], author, origin: { kind: author.kind === 'owner' ? 'local' : 'assistant' } });
    service.announce({ type: 'skill.changed', skillId: draft.skillId });
    res.status(201).json({ ok: true, skillId: draft.skillId, draft: draftView(draft) });
  })));
  route('get', '/skills/:skillId', reader, ids('skillId'), safe(async (req, res) => res.json({ ok: true, skill: service.getSkill(req.params.skillId) })));
  // Taking a skill out of the library: the owner's, from the page. `expectedEtag` (optional, the record as read)
  // guards against deleting something changed since; an installed skill (409 skill_installed, with its
  // installations) and one SynaBun ships (403 skill_bundled) are refused. Its versions go to the library's archive.
  route('delete', '/skills/:skillId', json, owner, ids('skillId'), safe(async (req, res) => {
    const expectedEtag = req.body?.expectedEtag ?? null;
    if (expectedEtag !== null && !Number.isInteger(expectedEtag)) return res.status(400).json({ ok: false, error: 'expectedEtag is the etag number the skill was read with.', code: 'invalid_etag' });
    res.json({ ok: true, ...service.removeSkill(req.params.skillId, { expectedEtag, by: { kind: 'owner' } }) });
  }));
  route('get', '/skills/:skillId/revisions', reader, ids('skillId'), safe(async (req, res) => {
    const list = service.library.listRevisions(req.params.skillId);
    const skill = service.library.getSkill(req.params.skillId);
    res.json({ ok: true, revisions: list.map((r) => ({ revisionId: r.revisionId, parentRevisionId: r.parentRevisionId, contentDigest: r.contentDigest, createdAt: r.createdAt, author: r.author, source: r.source, files: r.manifest.files.length, labels: service.library.labelsOf(skill, r.revisionId), note: r.note })) });
  }));
  route('post', '/skills/:skillId/pointers', json, owner, ids('skillId'), safe(async (req, res) => {
    const { pointer, revisionId, expectedEtag = null, reason = '' } = req.body || {};
    if (revisionId !== null && !isRevisionId(revisionId)) return res.status(400).json({ ok: false, error: 'Not a revision id.', code: 'invalid_id' });
    const rec = service.library.setPointer(req.params.skillId, pointer, revisionId, { expectedEtag, by: 'owner', reason });
    service.announce({ type: 'skill.changed', skillId: rec.skillId });
    res.json({ ok: true, pointers: rec.pointers, etag: rec.etag });
  }));
  route('get', '/revisions/:revisionId', reader, ids('revisionId'), safe(async (req, res) => {
    if (typeof req.query?.file === 'string') {
      const { entry, bytes } = service.library.readRevisionFile(req.params.revisionId, req.query.file);
      return res.json({ ok: true, path: entry.path, digest: entry.digest, encoding: entry.encoding, mode: entry.mode, ...(entry.encoding === 'utf-8' ? { content: bytes.toString('utf-8') } : { contentBase64: bytes.toString('base64') }) });
    }
    res.json({ ok: true, revision: service.revisionView(req.params.revisionId) });
  }));
  route('get', '/diff', reader, safe(async (req, res) => {
    const { from, to } = req.query || {};
    if (!isRevisionId(from) || !isRevisionId(to)) return res.status(400).json({ ok: false, error: 'from and to are revision ids.', code: 'invalid_id' });
    res.json({ ok: true, diff: service.library.diffRevisions(from, to) });
  }));
  // A revision as a file to keep or hand over: `format=bundle` (a SynaBun bundle, what Import takes back) or `skill`
  // (a ZIP with the skill's folder at its root, the .skill format); `profile` the export of one runtime or surface
  // (`claude-upload` for Claude.ai) through the same transforms an install applies, on the copy only: the revision
  // is never rewritten. The name is the one the revision installs as.
  route('get', '/revisions/:revisionId/export', reader, ids('revisionId'), safe(async (req, res) => {
    const format = req.query?.format === 'skill' ? 'skill' : req.query?.format === undefined || req.query?.format === 'bundle' ? 'bundle' : null;
    if (!format) return res.status(400).json({ ok: false, error: 'format is bundle or skill.', code: 'invalid_format' });
    const profile = typeof req.query?.profile === 'string' && req.query.profile ? req.query.profile : null;
    if (profile && !service.profileIds().includes(profile)) return res.status(400).json({ ok: false, error: 'There is no such profile.', code: 'invalid_profile' });
    const { files, dirs, revision } = service.library.readRevisionFiles(req.params.revisionId);
    const skill = service.library.getSkill(revision.skillId);
    let folder = { files, dirs };
    if (profile) { const out = buildExport(folder, profile); folder = { files: out.files, dirs: out.dirs }; }
    let name;
    try { name = effectiveInstallName(skill, folder.files); } catch { name = skill.name; }
    if (format === 'bundle') {
      const { json } = buildBundle({ type: 'skill', name, files: folder.files, dirs: folder.dirs });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.skill.json"`);
      return res.send(json);
    }
    const zip = new AdmZip();
    for (const d of folder.dirs || []) zip.addFile(`${name}/${d}/`, Buffer.alloc(0), '', 0o755);
    for (const f of folder.files) zip.addFile(`${name}/${f.path}`, f.bytes, '', f.executable ? 0o755 : 0o644);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}${profile === 'claude-upload' ? '-claude' : ''}.${profile === 'claude-upload' ? 'zip' : 'skill'}"`);
    return res.send(zip.toBuffer());
  }));

  // ── Drafts ──
  route('post', '/drafts', json, writer, once(safe(async (req, res) => {
    const body = req.body || {};
    const author = authorOf(req.principal, body);
    let draft;
    if (body.skillId !== undefined) {
      if (!isSkillId(body.skillId)) return res.status(400).json({ ok: false, error: 'Not a skill id.', code: 'invalid_id' });
      if (body.baseRevisionId !== undefined && body.baseRevisionId !== null && !isRevisionId(body.baseRevisionId)) return res.status(400).json({ ok: false, error: 'Not a revision id.', code: 'invalid_id' });
      draft = service.library.createDraft({ skillId: body.skillId, baseRevisionId: body.baseRevisionId || null, author });
    } else {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return res.status(400).json({ ok: false, error: 'A draft of a new skill has a name.', code: 'invalid_name' });
      draft = service.library.createDraft({ name, files: decodeFiles(body.files), dirs: Array.isArray(body.dirs) ? body.dirs : [], author, origin: { kind: author.kind === 'owner' ? 'local' : 'assistant' } });
    }
    service.announce({ type: 'skill.changed', skillId: draft.skillId });
    res.status(201).json({ ok: true, draft: draftView(draft) });
  })));
  route('get', '/drafts/:draftId', reader, ids('draftId'), safe(async (req, res) => {
    if (typeof req.query?.file === 'string') {
      const { files } = service.library.readDraftFiles(req.params.draftId);
      const f = files.find((x) => x.path === req.query.file);
      if (!f) return res.status(404).json({ ok: false, error: 'The draft has no such file.', code: 'file_not_found' });
      const text = isText(f.bytes);
      return res.json({ ok: true, path: f.path, executable: f.executable, ...(text ? { content: f.bytes.toString('utf-8') } : { contentBase64: f.bytes.toString('base64') }) });
    }
    res.json({ ok: true, draft: draftView(service.library.getDraft(req.params.draftId)) });
  }));
  route('patch', '/drafts/:draftId', json, writer, ids('draftId'), safe(async (req, res) => {
    const { expectedEtag, ops } = req.body || {};
    const draft = service.library.patchDraft(req.params.draftId, { expectedEtag, ops });
    service.announce({ type: 'skill.changed', skillId: draft.skillId });
    res.json({ ok: true, draft: draftView(draft) });
  }));
  route('post', '/drafts/:draftId/snapshot', json, writer, ids('draftId'), once(safe(async (req, res) => {
    const body = req.body || {};
    const author = authorOf(req.principal, body);
    const { files } = service.library.readDraftFiles(req.params.draftId);
    const lint = service.lintFolder({ files, dirs: [] }, {});
    const out = service.library.snapshotDraft(req.params.draftId, { expectedEtag: body.expectedEtag, author, source: { kind: author.kind === 'owner' ? 'draft' : 'assistant' }, invocationIntent: lint.invocation, note: typeof body.note === 'string' ? body.note : '' });
    if (!out.unchanged) service.announce({ type: 'revision.created', skillId: out.revision.skillId, revisionId: out.revision.revisionId });
    res.status(out.unchanged ? 200 : 201).json({ ok: true, unchanged: out.unchanged, revision: service.revisionView(out.revision.revisionId), draft: draftView(service.library.getDraft(req.params.draftId)) });
  })));

  // ── Checks ──
  route('post', '/lint', json, writer, safe(async (req, res) => {
    const { folder, folderName } = await folderFrom(service, req.body || {});
    const profiles = Array.isArray(req.body?.profiles) ? req.body.profiles.filter((p) => typeof p === 'string').slice(0, 10) : null;
    res.json({ ok: true, ...service.lintFolder(folder, { profiles, folderName }) });
  }));
  route('post', '/scan', json, writer, safe(async (req, res) => {
    const { folder, folderName, digest } = await folderFrom(service, req.body || {});
    res.json({ ok: true, scan: service.scanFolder(folder, { name: folderName, digest }) });
  }));

  // ── Reviews ──
  route('get', '/reviews', reader, safe(async (req, res) => {
    const q = req.query || {};
    const open = q.open === 'true' ? true : q.open === 'false' ? false : null;
    res.json({ ok: true, reviews: service.reviews.list({ state: typeof q.state === 'string' ? q.state : null, skillId: isSkillId(q.skillId) ? q.skillId : null, open }) });
  }));
  route('get', '/reviews/:reviewId', reader, ids('reviewId'), safe(async (req, res) => res.json({ ok: true, review: service.reviews.get(req.params.reviewId) })));
  route('post', '/reviews', json, writer, once(safe(async (req, res) => {
    const body = req.body || {};
    if (!isRevisionId(body.revisionId)) return res.status(400).json({ ok: false, error: 'Name the revision to review (revisionId).', code: 'invalid_id' });
    if (body.previousReviewId !== undefined && body.previousReviewId !== null && !IDS.reviewId(body.previousReviewId)) return res.status(400).json({ ok: false, error: 'Not a review id.', code: 'invalid_id' });
    const out = service.submitReview({ revisionId: body.revisionId, targets: Array.isArray(body.targets) ? body.targets : [], releaseNotes: body.releaseNotes, assumptions: body.assumptions, author: authorOf(req.principal, body), previousReviewId: body.previousReviewId || null });
    res.status(out.existing ? 200 : 201).json({ ok: true, review: out.review, existing: out.existing });
  })));
  route('post', '/reviews/:reviewId/comment', json, writer, ids('reviewId'), safe(async (req, res) => res.json({ ok: true, review: service.reviews.comment(req.params.reviewId, { by: authorOf(req.principal, req.body), body: req.body?.body }) })));
  route('post', '/reviews/:reviewId/withdraw', json, writer, ids('reviewId'), safe(async (req, res) => {
    const rec = service.reviews.get(req.params.reviewId);
    // The owner may close any review; an agent only its own: the same kind of caller, from the same terminal (a
    // caller without one is nobody's author).
    if (req.principal.kind !== 'owner' && !sameAuthor(req.principal, rec.author)) return sendGuardError(res, 403, 'NOT_AUTHOR', 'Only who submitted it, or the owner, withdraws a review.');
    res.json({ ok: true, review: service.reviews.withdraw(req.params.reviewId, { by: authorOf(req.principal, req.body) }) });
  }));
  route('post', '/reviews/:reviewId/decision', json, owner, ids('reviewId'), safe(async (req, res) => {
    const { decision, reason } = req.body || {};
    res.json({ ok: true, review: service.decideReview(req.params.reviewId, { decision, reason, by: { kind: 'owner' } }) });
  }));

  // ── Installs ──
  route('post', '/installations/plan', json, writer, safe(async (req, res) => {
    const { revisionId, targets } = req.body || {};
    if (!isRevisionId(revisionId)) return res.status(400).json({ ok: false, error: 'Name the revision to install (revisionId).', code: 'invalid_id' });
    res.json({ ok: true, plan: await service.installPlan({ revisionId, targets }) });
  }));
  route('get', '/installations', reader, safe(async (req, res) => {
    const q = req.query || {};
    res.json({ ok: true, installations: service.deployer.listInstallations({ skillId: isSkillId(q.skillId) ? q.skillId : null, active: q.active === 'true' ? true : q.active === 'false' ? false : null }) });
  }));
  route('post', '/installations', json, owner, once(safe(async (req, res) => {
    const { revisionId, targets, planDigest, decisions, reviewId = null } = req.body || {};
    if (!isRevisionId(revisionId)) return res.status(400).json({ ok: false, error: 'Name the revision to install (revisionId).', code: 'invalid_id' });
    if (reviewId !== null && !IDS.reviewId(reviewId)) return res.status(400).json({ ok: false, error: 'Not a review id.', code: 'invalid_id' });
    const out = await service.install({ revisionId, targets, planDigest, decisions, principal: { kind: 'owner' }, reviewId });
    res.status(out.ok ? 200 : 207).json({ ok: out.ok, partial: out.partial, results: out.results, plan: out.plan });
  })));
  route('get', '/installations/:installationId', reader, ids('installationId'), safe(async (req, res) => res.json({ ok: true, installation: service.deployer.getInstallation(req.params.installationId) })));
  route('post', '/installations/:installationId/rollback', json, owner, ids('installationId'), safe(async (req, res) => {
    const out = service.deployer.rollback(req.params.installationId, { expectedDestinationDigest: req.body?.expectedDestinationDigest ?? null, principal: { kind: 'owner' } });
    service.announce({ type: 'installation.changed', installationId: req.params.installationId, action: 'rollback' });
    res.json(out);
  }));
  route('post', '/installations/:installationId/uninstall', json, owner, ids('installationId'), safe(async (req, res) => {
    const out = service.deployer.uninstall(req.params.installationId, { expectedDestinationDigest: req.body?.expectedDestinationDigest ?? null, principal: { kind: 'owner' } });
    service.announce({ type: 'installation.changed', installationId: req.params.installationId, action: 'uninstall' });
    res.json(out);
  }));
  route('post', '/installations/:installationId/verify', json, owner, ids('installationId'), safe(async (req, res) => {
    res.json({ ok: true, installation: await service.deployer.verify(req.params.installationId, { probeRuntime: req.body?.probe === true }) });
  }));

  // ── The old bridges ──
  route('get', '/migrations', reader, safe(async (req, res) => res.json({ ok: true, migrations: service.migration.listJournals() })));
  route('get', '/migrations/bridges/plan', reader, safe(async (req, res) => { service.syncBundled(); res.json({ ok: true, plan: await service.migration.plan() }); }));
  route('post', '/migrations/bridges', json, owner, once(safe(async (req, res) => {
    service.syncBundled();
    const out = await service.migration.migrate({ planDigest: req.body?.planDigest, principal: { kind: 'owner' } });
    service.announce({ type: 'migration.changed', journalId: out.journalId });
    res.json({ ok: out.ok, ...out });
  })));
  route('get', '/migrations/:journalId', reader, ids('journalId'), safe(async (req, res) => res.json({ ok: true, migration: service.migration.readJournal(req.params.journalId) })));
  route('post', '/migrations/:journalId/revert', json, owner, ids('journalId'), safe(async (req, res) => {
    const out = await service.migration.revert(req.params.journalId, { principal: { kind: 'owner' } });
    service.announce({ type: 'migration.changed', journalId: req.params.journalId });
    res.json(out);
  }));
}

// ── Helpers ──

const isText = (bytes) => {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return false; }
  return !bytes.includes(0);
};

/** `files` of a request: `[{ path, content | contentBase64, executable? }]` → bytes. */
export function decodeFiles(list) {
  if (!Array.isArray(list) || !list.length) throw new PathConfineError(400, 'files is a list of { path, content } (or contentBase64).');
  if (list.length > 2000) throw new PathConfineError(413, 'Too many files.');
  return list.map((f, i) => {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string') throw new PathConfineError(400, `files[${i}] has no path.`);
    let bytes;
    if (typeof f.content === 'string' && f.contentBase64 === undefined) bytes = Buffer.from(f.content, 'utf-8');
    else if (typeof f.contentBase64 === 'string' && f.content === undefined) {
      bytes = Buffer.from(f.contentBase64, 'base64');
      if (bytes.toString('base64') !== f.contentBase64) throw new PathConfineError(400, `files[${i}].contentBase64 is not canonical base64.`);
    } else throw new PathConfineError(400, `files[${i}] has either content (text) or contentBase64.`);
    return { path: f.path, bytes, executable: f.executable === true };
  });
}

/** The folder a check runs on: a revision, a draft, a catalog entry, or files sent with the request. */
async function folderFrom(service, body) {
  if (body.revisionId !== undefined) {
    if (!isRevisionId(body.revisionId)) throw new PathConfineError(400, 'Not a revision id.');
    const { files, dirs, revision } = service.library.readRevisionFiles(body.revisionId);
    const skill = service.library.getSkill(revision.skillId);
    return { folder: { files, dirs }, folderName: typeof body.folderName === 'string' ? body.folderName : skill.name, digest: revision.contentDigest };
  }
  if (body.draftId !== undefined) {
    if (!isDraftId(body.draftId)) throw new PathConfineError(400, 'Not a draft id.');
    const { files, dirs, draft } = service.library.readDraftFiles(body.draftId);
    const skill = service.library.getSkill(draft.skillId);
    return { folder: { files, dirs }, folderName: typeof body.folderName === 'string' ? body.folderName : skill.name, digest: folderDigest({ files, dirs }) };
  }
  if (body.artifactId !== undefined) {
    if (!isArtifactId(body.artifactId)) throw new PathConfineError(400, 'Not an artifact id.');
    const entry = await service.catalogFind(body.artifactId);
    if (!entry || entry.kind !== 'skill') throw new PathConfineError(404, 'There is no such skill in the catalog.');
    const { files, dirs } = collectFolder(entry.realPath);
    return { folder: { files, dirs }, folderName: entry.folderName, digest: folderDigest({ files, dirs }) };
  }
  const files = decodeFiles(body.files);
  const folder = checkFolder({ files, dirs: Array.isArray(body.dirs) ? body.dirs : [] });
  return { folder, folderName: typeof body.folderName === 'string' ? body.folderName : '', digest: folderDigest(folder) };
}

function draftView(d) {
  return { draftId: d.draftId, skillId: d.skillId, baseRevisionId: d.baseRevisionId, etag: d.etag, files: d.files.map((f) => ({ path: f.path, digest: f.blobId, executable: !!f.executable })), dirs: d.dirs, updatedAt: d.updatedAt, createdBy: d.createdBy };
}
