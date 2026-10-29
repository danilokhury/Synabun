// Discover only reads explicitly enabled public catalogs. Downloads become inert, scanned Review submissions.
// GitHub's API is the transport for pinned upstream folders; no CLI, clone, hooks, installer or remote assets.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { localRecord } from './local-store.js';
import { buildBundle, readBundle, createImportStaging, bundlePathProblem } from './bundle.js';
import { readHeadOf } from './export.js';
import { folderDigest } from './library.js';

export const DISCOVER_SOURCES = Object.freeze([
  { id: 'anthropic', label: 'Anthropic skills', repo: 'anthropics/skills', prefix: 'skills/', license: 'Per-skill terms; review LICENSE files', licenseCode: 'perSkill', transport: 'github' },
  { id: 'openai', label: 'OpenAI skills', deprecated: true, repo: 'openai/skills', prefix: 'skills/.curated/', license: 'Per-skill terms; review LICENSE files', licenseCode: 'perSkill', transport: 'github' },
  { id: 'claude-plugins', label: 'Claude official plugins', repo: 'anthropics/claude-plugins-official', prefix: '', license: 'Per-publisher terms', licenseCode: 'perPublisher', transport: 'github' },
  { id: 'skills-sh', label: 'skills.sh', license: 'Upstream repository terms', licenseCode: 'upstream', transport: 'catalog-import', reason: 'No verified public catalog API contract; import a catalog of pinned GitHub sources.' },
  { id: 'skillsmp', label: 'SkillsMP', license: 'Upstream repository terms', licenseCode: 'upstream', transport: 'catalog-import', reason: 'API credentials and terms are not configured; import a catalog of pinned GitHub sources.' },
  { id: 'clawhub', label: 'ClawHub', license: 'MIT-0 for published skill content', licenseCode: 'mitZero', transport: 'catalog-import', reason: 'Registry artifact API contract is not configured; import a catalog of pinned GitHub mirrors with MIT-0 terms.' },
]);
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const repoOK = (v) => typeof v === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) && !v.split('/').some((x) => x === '.' || x === '..');

export async function githubJSON(path, { fetcher = globalThis.fetch, maxBytes = 8 * 1024 * 1024 } = {}) {
  const response = await fetcher(`https://api.github.com${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SynaBun-Skills-Studio' } });
  if (!response.ok) fail(502, 'source_unavailable', `GitHub returned ${response.status}. Local skills are still available.`);
  if (Number(response.headers.get('content-length')) > maxBytes) fail(413, 'source_limit', 'The catalog response exceeds its limit.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) { await response.body.cancel?.().catch(() => {}); fail(413, 'source_limit', 'The catalog response exceeds its limit.'); } chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

export function createSkillDiscover({ dataDir, service, settings, request = githubJSON, liveRoots, now = Date.now }) {
  const store = localRecord(dataDir, 'discover', { catalogs: {} });
  const staging = createImportStaging({ dir: join(dataDir, 'discover-staging'), liveRoots });
  const sourceOf = (id) => { const s = DISCOVER_SOURCES.find((s) => s.id === id); if (!s) fail(400, 'invalid_source', 'Unknown Discover source.'); return s; };
  function enabled(id) { sourceOf(id); if (!settings().sources.includes(id)) fail(403, 'source_disabled', 'The owner must enable this source in Discover first.'); }
  function list({ sourceId = null, q = '' } = {}) {
    const state = store.read();
    const sources = DISCOVER_SOURCES.map((s) => ({ ...s, enabled: settings().sources.includes(s.id), checkedAt: state.catalogs[s.id]?.checkedAt || null, error: state.catalogs[s.id]?.error || null }));
    const items = Object.entries(state.catalogs).filter(([id]) => (!sourceId || sourceId === id) && settings().sources.includes(id)).flatMap(([id, c]) => (c.items || []).map((i) => ({ ...i, ...(c.evidence ? {} : { licenseCode: sourceOf(id).licenseCode }) }))).filter((i) => `${i.name} ${i.repo} ${i.subpath}`.toLowerCase().includes(String(q).toLowerCase())).slice(0, 500);
    return { sources, items, disclosure: 'Enabled refreshes send repository names and commit requests to api.github.com. No local skill content or usage is sent. Cached metadata and badges are not security approval.' };
  }
  async function tree(repo, commit) {
    if (!repoOK(repo) || !sha(commit)) fail(400, 'invalid_source_pin', 'A public GitHub repository and a full commit are required.');
    const result = await request(`/repos/${repo}/git/trees/${commit}?recursive=1`);
    if (result.truncated || !Array.isArray(result.tree) || result.tree.length > 20000) fail(413, 'catalog_incomplete', 'The complete upstream tree could not be read.');
    return result.tree;
  }
  async function refresh(sourceId) {
    enabled(sourceId);
    const source = sourceOf(sourceId);
    if (!source.repo) fail(409, 'catalog_import_required', source.reason);
    try {
      const pin = await request(`/repos/${source.repo}/commits/HEAD`);
      const rows = await tree(source.repo, pin.sha);
      const items = rows.filter((e) => e.type === 'blob' && e.mode === '100644' && e.path.startsWith(source.prefix) && e.path.endsWith('/SKILL.md')).slice(0, 500).map((e) => {
        const subpath = e.path.slice(0, -9);
        return { sourceId, name: subpath.split('/').pop(), repo: source.repo, subpath, commit: pin.sha, license: source.license, licenseCode: source.licenseCode, id: createHash('sha256').update(`${sourceId}:${source.repo}:${subpath}:${pin.sha}`).digest('hex') };
      });
      const state = store.read(); state.catalogs[sourceId] = { checkedAt: now(), items, error: null }; store.write(state);
      return list({ sourceId });
    } catch (e) {
      const state = store.read(); state.catalogs[sourceId] = { ...state.catalogs[sourceId], error: e.code || 'source_unavailable' }; store.write(state); throw e;
    }
  }
  function importCatalog(sourceId, entries) {
    enabled(sourceId);
    if (!Array.isArray(entries) || entries.length > 500) fail(400, 'invalid_catalog', 'A catalog has at most 500 pinned entries.');
    const items = entries.map((e) => {
      if (!repoOK(e.repo) || !sha(e.commit) || bundlePathProblem(e.subpath) || typeof e.license !== 'string' || e.license.length > 500) fail(400, 'invalid_catalog', 'Each entry needs repo, full commit, safe subpath and declared license.');
      if (sourceId === 'clawhub' && e.license !== 'MIT-0') fail(422, 'license_conflict', 'ClawHub content must carry MIT-0 terms.');
      return { sourceId, repo: e.repo, commit: e.commit, subpath: e.subpath, name: e.subpath.split('/').pop(), license: e.license, id: createHash('sha256').update(`${sourceId}:${e.repo}:${e.subpath}:${e.commit}`).digest('hex') };
    });
    const state = store.read(); state.catalogs[sourceId] = { items, checkedAt: now(), error: null, evidence: 'owner-imported catalog; unverified publisher claim' }; store.write(state);
    return list({ sourceId });
  }
  async function stage(itemId, author) {
    const entry = Object.values(store.read().catalogs).flatMap((c) => c.items || []).find((i) => i.id === itemId && settings().sources.includes(i.sourceId));
    if (!entry) fail(404, 'item_not_found', 'That enabled catalog has no such item.');
    enabled(entry.sourceId);
    const rows = await tree(entry.repo, entry.commit);
    const selected = rows.filter((r) => r.path.startsWith(`${entry.subpath}/`) && r.type !== 'tree');
    if (!selected.length || selected.length > 200 || selected.some((r) => !['100644', '100755'].includes(r.mode) || r.type !== 'blob' || !sha(r.sha) || bundlePathProblem(r.path.slice(entry.subpath.length + 1)))) fail(422, 'unsafe_source', 'The source is empty, too large, or contains links or unsupported paths.');
    if (selected.reduce((n, r) => n + (Number(r.size) || 0), 0) > 18 * 1024 * 1024) fail(413, 'source_limit', 'The skill is larger than the staging limit.');
    const files = []; let size = 0;
    // Repository license is evidence too; keep it alongside the skill when it has no own LICENSE.
    const license = rows.find((r) => /^(?:LICENSE|LICENSE\.md|LICENSE\.txt)$/.test(r.path) && r.type === 'blob' && r.mode === '100644' && sha(r.sha));
    if (license && !selected.some((r) => /\/LICENSE(?:\.[^/]+)?$/i.test(r.path))) selected.push({ ...license, path: `${entry.subpath}/LICENSE.upstream` });
    for (const row of selected) {
      enabled(entry.sourceId); // revocation during a download stops the next outbound request
      const blob = await request(`/repos/${entry.repo}/git/blobs/${row.sha}`);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') fail(502, 'invalid_blob', 'The upstream blob is not base64.');
      const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64'); size += bytes.length;
      if (size > 18 * 1024 * 1024 || bytes.length > 8 * 1024 * 1024) fail(413, 'source_limit', 'The skill is larger than the staging limit.');
      const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (digest !== row.sha) fail(409, 'source_changed', 'The upstream file does not match its immutable blob id.');
      files.push({ path: row.path.slice(entry.subpath.length + 1), bytes, executable: row.mode === '100755' });
    }
    const name = readHeadOf(files).parsed.data?.name;
    const read = readBundle(buildBundle({ type: 'skill', name, files, dirs: [] }).bundle);
    const digest = folderDigest({ files: read.files, dirs: read.dirs });
    const scan = service.scanFolder(read, { name, digest });
    const stagingId = staging.stage(read, { provenance: entry, scan, license: entry.license });
    const staged = staging.load(stagingId);
    const made = service.library.createSkill({ name, files: staged.files, dirs: staged.dirs, source: { kind: 'github', uri: `https://github.com/${entry.repo}`, subpath: entry.subpath, requestedRef: entry.commit, resolvedCommit: entry.commit, stagingId },
      author, origin: { kind: 'discover', sourceId: entry.sourceId, repo: entry.repo, license: entry.license } });
    const review = service.submitReview({ revisionId: made.revision.revisionId, author, assumptions: [`License: ${entry.license}. Publisher claims need review.`], releaseNotes: `Discovered from ${entry.repo}@${entry.commit}:${entry.subpath}. Inert staging ${stagingId}.` });
    service.announce({ type: 'revision.created', skillId: made.skill.skillId, revisionId: made.revision.revisionId });
    return { stagingId, skillId: made.skill.skillId, revisionId: made.revision.revisionId, reviewId: review.review.reviewId, scan, provenance: entry, installed: false };
  }
  return { list, refresh, importCatalog, stage };
}
