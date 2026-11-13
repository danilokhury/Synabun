/** Release-only VirusTotal API v3 client. No API calls occur on import. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DIRECT_LIMIT = 32 * 1024 * 1024;
// Files above this size go through the large-upload URL, where VirusTotal can take
// long to show the analysis; they get the large deadline when it is the longer one.
export const LARGE_FILE = DIRECT_LIMIT;
export const MAX_SCAN_MINUTES = 240;
/** A deadline in minutes from the environment: a number above 0, at most MAX_SCAN_MINUTES. */
export function scanMinutes(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const text = String(value).trim(); const minutes = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || !(minutes > 0) || minutes > MAX_SCAN_MINUTES) throw new Error(`${name} must be a number of minutes above 0 and at most ${MAX_SCAN_MINUTES}`);
  return minutes;
}
export const UPLOAD_LIMIT = 650 * 1024 * 1024;
export const API = 'https://www.virustotal.com/api/v3/';
export const README_VERIFICATION = '<!-- synabun:verification:start -->\nPackage verification: [downloadable VirusTotal reports and SHA-256 hashes](https://github.com/danilokhury/Synabun/releases/latest). Match the report to your exact version and file hash. Reports record engine coverage and analysis dates; they are not a guarantee of safety. Website results describe URL reputation, not a vulnerability audit.\n<!-- synabun:verification:end -->';
export function verificationReadme(text) {
  return text.includes('<!-- synabun:verification:start -->')
    ? text.replace(/<!-- synabun:verification:start -->[\s\S]*?<!-- synabun:verification:end -->/, README_VERIFICATION)
    : `${text.trimEnd()}\n\n${README_VERIFICATION}\n`;
}
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function evidenceDigest(item) {
  const { source, analysis_id, evidence_digest, review, ...evidence } = item;
  return digest(evidence);
}
export function credentials(key = process.env.VIRUSTOTAL_API_KEY) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('Set VIRUSTOTAL_API_KEY locally or as a GitHub Actions secret. Eligible VirusTotal API access and public sample-sharing consent are required; see docs/release-pipeline.md.');
  return key.trim();
}
const safeName = name => name.replace(/[^a-zA-Z0-9_.-]/g, '_');
// URL objects omit zero counters which the analysis endpoint includes.
const urlStats = stats => stats && ({ confirmed_timeout: 0, failure: 0, harmless: 0, malicious: 0, suspicious: 0, timeout: 0, type_unsupported: 0, undetected: 0, ...stats });
export function trustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !(url.hostname === 'virustotal.com' || url.hostname.endsWith('.virustotal.com')) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('VirusTotal returned an untrusted upload URL');
  return url.href;
}
export async function* multipart(path, boundary) {
  yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName(basename(path))}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  yield* createReadStream(path);
  yield Buffer.from(`\r\n--${boundary}--\r\n`);
}

export class VirusTotal {
  constructor({ key, env = process.env, fetchImpl = globalThis.fetch, sleep = delay, now = Date.now, intervalMs = 15500, requestMs = 120000,
    uploadMs = scanMinutes(env.SYNABUN_VT_UPLOAD_MINUTES, 15, 'SYNABUN_VT_UPLOAD_MINUTES') * 60000,
    scanMs = scanMinutes(env.SYNABUN_VT_SCAN_MINUTES, 15, 'SYNABUN_VT_SCAN_MINUTES') * 60000,
    largeScanMs = scanMinutes(env.SYNABUN_VT_LARGE_SCAN_MINUTES, 15, 'SYNABUN_VT_LARGE_SCAN_MINUTES') * 60000,
    largeFileBytes = LARGE_FILE, pollMs = 30000, retries = 3 } = {}) {
    this.key = credentials(key); this.fetch = fetchImpl; this.sleep = sleep; this.now = now;
    for (const [name, value] of Object.entries({ scanMs, largeScanMs, uploadMs, pollMs })) if (!Number.isFinite(value) || value <= 0) throw new Error(`VirusTotal ${name} must be a positive number`);
    Object.assign(this, { intervalMs, requestMs, uploadMs, scanMs, largeScanMs, largeFileBytes, pollMs, retries }); this.nextRequest = 0; this.queue = Promise.resolve();
  }
  /** The analysis deadline for one file (it starts once the upload is done): large files get the longer one, never a shorter one. */
  scanMsFor(size) { return size > this.largeFileBytes ? Math.max(this.scanMs, this.largeScanMs) : this.scanMs; }
  /** How many polls fit before `until`; bounds every waiting loop even if the clock stalls. */
  pollLimit(until) { return Math.min(10000, Math.max(1, Math.ceil((until - this.now()) / this.pollMs) + 1)); }
  /** `phase` names the clock in the error: 'upload' (lookup, upload URL, upload) or 'analysis'. */
  async wait(ms, deadline, phase = 'analysis') {
    if (this.now() + ms >= deadline) throw new Error(`VirusTotal ${phase} deadline exceeded; retry the same bytes later`);
    if (ms > 0) await this.sleep(ms);
  }
  async pace(deadline, phase = 'analysis') {
    // Reserve request starts serially, even when library callers scan concurrently.
    const turn = this.queue.then(async () => {
      await this.wait(Math.max(0, this.nextRequest - this.now()), deadline, phase);
      if (this.now() >= deadline) throw new Error(`VirusTotal ${phase} deadline exceeded`);
      this.nextRequest = this.now() + this.intervalMs;
    });
    this.queue = turn.catch(() => {});
    await turn;
  }
  async request(path, { method = 'GET', body, headers = {}, deadline = this.now() + this.scanMs, phase = 'analysis', notFound = false, timeoutMs = this.requestMs } = {}) {
    const url = trustedUrl(path.startsWith('https:') ? path : API + path);
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.pace(deadline, phase);
      let response;
      let payload;
      try {
        response = await this.fetch(url, { method, headers: { ...headers, 'x-apikey': this.key },
          body: typeof body === 'function' ? body() : body, duplex: 'half', redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - this.now()))) });
        // Read a bounded JSON response, including its body in the HTTP timeout.
        const chunks = []; let size = 0;
        for await (const chunk of response.body || []) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) throw new Error('response too large');
          chunks.push(Buffer.from(chunk));
        }
        payload = Buffer.concat(chunks).toString('utf8');
      } catch {
        if (this.now() >= deadline) throw new Error(`VirusTotal ${phase} deadline exceeded; retry the same bytes later`);
        if (attempt === this.retries) throw new Error('VirusTotal request failed or timed out; no verdict available');
        await this.wait(1000 * 2 ** attempt, deadline, phase); continue;
      }
      if (response.status === 404 && notFound) return null;
      if (response.status === 429 || response.status >= 500) {
        if (attempt === this.retries) throw new Error(`VirusTotal HTTP ${response.status}; retry budget exhausted`);
        const retry = response.headers.get('retry-after');
        const ms = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.now() : 1000 * 2 ** attempt;
        await this.wait(Math.max(1000, Number.isFinite(ms) ? ms : 1000), deadline, phase); continue;
      }
      if (!response.ok) throw Object.assign(new Error(`VirusTotal HTTP ${response.status}; no verdict available`), { status: response.status });
      try { return JSON.parse(payload); } catch { throw new Error('VirusTotal returned invalid JSON'); }
    }
  }
  /**
   * Polls analyses/{id}. A 404 there is an analysis VirusTotal has accepted but
   * does not show yet (a large upload takes a while to appear): it counts as
   * queued. With `settle` the poll stops at `until` and returns null, so the
   * caller can look at the file object instead; without it, it throws.
   */
  async poll(id, deadline, { until = deadline, settle = false } = {}) {
    if (typeof id !== 'string' || !id) throw new Error('VirusTotal did not return an analysis ID');
    const limit = this.pollLimit(until);
    for (let count = 0; count < limit; count++) {
      const result = await this.request(`analyses/${encodeURIComponent(id)}`, { deadline, notFound: true });
      const status = result === null ? 'queued' : result?.data?.attributes?.status;
      if (status === 'completed') return result;
      if (!['queued', 'in-progress'].includes(status)) throw new Error('VirusTotal returned an unknown analysis status');
      if (this.now() + this.pollMs >= until) break;
      await this.wait(this.pollMs, deadline);
    }
    if (settle) return null;
    throw new Error(`VirusTotal analysis unfinished after ${limit} polls; retry later`);
  }
  /** The file object, identity-checked; null while VirusTotal does not have it. */
  async fileObject(sha256, deadline, phase = 'analysis') {
    const object = await this.request(`files/${sha256}`, { deadline, phase, notFound: true });
    if (object && (object.data?.id !== sha256 || object.data?.attributes?.sha256 !== sha256)) throw new Error('VirusTotal file SHA-256 mismatch');
    return object;
  }
  /**
   * Waits on files/{sha256} until it carries a fresh analysis (the same fresh()
   * rule and evidence checks as a cached verdict). Used when VirusTotal says the
   * file is already submitted (409), when an analysis never showed as completed,
   * and when the object exists but is still being analysed. Returns null at
   * `until`; past `deadline` it throws like every other wait.
   */
  async awaitFile(subject, deadline, { until = deadline, analysisId = null } = {}) {
    const limit = this.pollLimit(until);
    for (let count = 0; count < limit; count++) {
      const a = (await this.fileObject(subject.sha256, deadline))?.data?.attributes;
      if (a && this.fresh(a.last_analysis_date)) return this.evidence(subject, a.last_analysis_stats, a.last_analysis_results, a.last_analysis_date, 'awaited', analysisId);
      if (this.now() + this.pollMs >= until) break;
      await this.wait(this.pollMs, deadline);
    }
    return null;
  }
  async file(path, expectedHash) {
    const size = (await stat(path)).size;
    if (size > UPLOAD_LIMIT) throw new Error(`VirusTotal 650 MB upload limit exceeded: ${basename(path)}`);
    const sha256 = await hashFile(path);
    if (expectedHash && sha256 !== expectedHash) throw new Error(`SHA-256 mismatch: ${basename(path)}`);
    // Two clocks, one after the other, so the wall time of a file is at most uploadMs + scanMsFor(size):
    // - the upload clock (uploadMs) runs from here and covers what comes before VirusTotal has the
    //   bytes: the files/{sha} lookup, files/upload_url, the upload POST (or files/{sha}/analyse),
    //   their pace() turns and retries. The upload request's timeout is what is left of it.
    // - the analysis clock (scanMsFor(size)) starts when that phase ends: right after the lookup when
    //   the object is cached without an analysis date (it is awaited, and a reanalysis asked for after
    //   that runs on the analysis clock already started), else when the upload or analyse POST answers,
    //   409 AlreadySubmitted included. It covers the polls, the settle fallback and awaitFile.
    const budget = this.scanMsFor(size);
    const uploadDeadline = this.now() + this.uploadMs;
    let deadline = null, settle = null;
    const startAnalysis = () => {
      if (deadline !== null) return;
      deadline = this.now() + budget;
      // The last quarter of the deadline is kept for the file object, whatever the analysis did.
      settle = deadline - Math.floor(budget / 4);
    };
    const before = () => deadline === null ? { deadline: uploadDeadline, phase: 'upload' } : { deadline, phase: 'analysis' };
    const subject = { kind: 'file', name: basename(path), sha256, size };
    const cached = await this.fileObject(sha256, uploadDeadline, 'upload');
    const a = cached?.data?.attributes;
    let report = null;
    if (cached && this.fresh(a?.last_analysis_date)) {
      report = this.evidence(subject, a.last_analysis_stats, a.last_analysis_results, a.last_analysis_date, 'cached');
    } else {
      // An object without an analysis date is still being analysed: wait for it before asking again.
      if (cached && a?.last_analysis_date == null) { startAnalysis(); report = await this.awaitFile(subject, deadline, { until: settle }); }
      if (!report) {
        let analysis = null;
        try {
          if (cached) analysis = await this.request(`files/${sha256}/analyse`, { method: 'POST', ...before() });
          else {
            const upload = size > DIRECT_LIMIT ? (await this.request('files/upload_url', before()))?.data : API + 'files';
            if (typeof upload !== 'string') throw new Error('VirusTotal did not return an upload URL');
            const boundary = `synabun-${sha256}`;
            const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName(basename(path))}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
            const tail = `\r\n--${boundary}--\r\n`;
            analysis = await this.request(upload, { method: 'POST', ...before(), timeoutMs: this.uploadMs, body: () => multipart(path, boundary),
              headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(Buffer.byteLength(head) + size + Buffer.byteLength(tail)) } });
          }
        } catch (error) {
          // 409 AlreadySubmitted: these bytes are already being analysed. Never upload again; wait for the file object.
          if (error.status !== 409) throw error;
        }
        startAnalysis();
        const analysisId = analysis ? analysis.data?.id : null;
        if (analysis && (typeof analysisId !== 'string' || !analysisId)) throw new Error('VirusTotal did not return an analysis ID');
        const result = analysisId ? await this.poll(analysisId, deadline, { until: settle, settle: true }) : null;
        if (result) {
          if (result.meta?.file_info?.sha256 !== sha256) throw new Error('VirusTotal analysis SHA-256 mismatch');
          const attrs = result.data.attributes;
          report = this.evidence(subject, attrs.stats, attrs.results, attrs.date, cached ? 'reanalysed' : 'uploaded', analysisId);
        } else {
          report = await this.awaitFile(subject, deadline, { analysisId });
          if (!report) throw new Error('VirusTotal analysis unfinished before the deadline; retry the same bytes later');
        }
      }
    }
    if (await hashFile(path) !== sha256 || (await stat(path)).size !== size) throw new Error(`Artifact changed during scanning: ${basename(path)}`);
    return report;
  }
  fresh(date) { return Number.isInteger(date) && date > 0 && date * 1000 <= this.now() + 300000 && this.now() - date * 1000 <= 7 * 86400000; }
  async url(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Website reputation scan requires a public HTTPS URL');
    const subject = url.href; const id = Buffer.from(subject).toString('base64url');
    const deadline = this.now() + this.scanMs;
    const cached = await this.request(`urls/${id}`, { deadline, notFound: true });
    const cachedAttrs = cached?.data?.attributes;
    if (cached && (cachedAttrs?.url !== subject || !/^[a-f0-9]{64}$/.test(cached.data.id))) throw new Error('VirusTotal URL mismatch');
    // Reuse the exact fresh verdict so an owner review survives a retry.
    // New dates or engine findings still change the evidence digest.
    if (cached && this.fresh(cachedAttrs?.last_analysis_date)) {
      return this.evidence({ kind: 'url', name: subject, sha256: createHash('sha256').update(subject).digest('hex'), url: subject },
        urlStats(cachedAttrs.last_analysis_stats), cachedAttrs.last_analysis_results, cachedAttrs.last_analysis_date, 'cached', null, cached.data.id);
    }
    const submitted = await this.request('urls', { method: 'POST', body: new URLSearchParams({ url: subject }), deadline });
    const result = await this.poll(submitted?.data?.id, deadline);
    // Verify the URL object too; do not attribute an analysis to an unrelated URL.
    const object = await this.request(`urls/${id}`, { deadline });
    if (object?.data?.attributes?.url !== subject) throw new Error('VirusTotal URL mismatch');
    if (result.meta?.url_info?.url !== subject || !/^[a-f0-9]{64}$/.test(object.data.id)) throw new Error('VirusTotal URL analysis identity mismatch');
    const a = result.data.attributes;
    return this.evidence({ kind: 'url', name: subject, sha256: createHash('sha256').update(subject).digest('hex'), url: subject }, urlStats(a.stats), a.results, a.date, 'submitted', submitted.data.id, object.data.id);
  }
  evidence(subject, stats, results, date, source, analysisId = null, urlId = null) {
    if (!stats || !results || typeof results !== 'object' || !this.fresh(date)) throw new Error('VirusTotal evidence missing or stale; no verdict available');
    const counts = Object.fromEntries(Object.keys(stats).sort().map(key => [key, stats[key]]));
    if (!Object.values(counts).every(n => Number.isInteger(n) && n >= 0)) throw new Error('VirusTotal invalid engine counts');
    const engines = Object.keys(results).sort().map(key => ({ id: key, category: results[key].category ?? null, engine: results[key].engine_name ?? key, version: results[key].engine_version ?? null, update: results[key].engine_update ?? null, result: results[key].result ?? null }));
    for (const [category, count] of Object.entries(counts)) if (engines.filter(engine => engine.category === category).length !== count) throw new Error('VirusTotal engine counts do not match evidence');
    if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== engines.length || engines.some(engine => !Object.hasOwn(counts, engine.category))) throw new Error('VirusTotal engine counts do not match evidence');
    const supported = ['harmless', 'undetected', 'malicious', 'suspicious'].reduce((n, key) => n + (counts[key] || 0), 0);
    const detections = (counts.malicious || 0) + (counts.suspicious || 0);
    const status = supported < (subject.kind === 'file' ? 10 : 20) ? 'inconclusive' : detections ? 'detections' : 'no-detections';
    const evidence = { ...subject, status, analysis_status: 'completed', analysis_date: new Date(date * 1000).toISOString(), source, analysis_id: analysisId,
      supported_engines: supported, total_engines: engines.length, counts, engines,
      permalink: `https://www.virustotal.com/gui/${subject.kind === 'file' ? 'file/' + subject.sha256 : 'url/' + urlId}` };
    return { ...evidence, evidence_digest: evidenceDigest(evidence), review: null };
  }
}

export function applyReviews(items, reviews = [], now = Date.now()) {
  if (!Array.isArray(reviews)) throw new Error('Review file must contain an array');
  return items.map(item => {
    if (item.status !== 'detections') return item;
    const review = reviews.find(r => r.sha256 === item.sha256 && r.name === item.name && r.evidence_digest === item.evidence_digest);
    if (!review) return item;
    const at = Date.parse(review.reviewed_at), expires = Date.parse(review.expires_at);
    if (![review.reviewer, review.reason, review.reference].every(v => typeof v === 'string' && v.trim().length >= 3) || !Number.isFinite(at) || !Number.isFinite(expires) || at > now || expires <= now || expires - at > 7 * 86400000) throw new Error('Matching VirusTotal review is incomplete or expired');
    return { ...item, review: { reviewer: review.reviewer, reason: review.reason, reference: review.reference, reviewed_at: review.reviewed_at, expires_at: review.expires_at } };
  });
}
export const EQUIVALENT_TO_CLEAN = 'equivalent-to-clean';
/**
 * A macOS dmg VirusTotal gave no verdict for passes only as 'equivalent-to-clean':
 * the release gate found its .app byte-identical to the .app of the same-arch zip,
 * and that zip, by the exact name and SHA-256 recorded, is in the same report
 * with no detections (an owner-reviewed detection does not count).
 */
export function equivalentToClean(item, items) {
  const e = item?.equivalence, zip = e?.matched_zip;
  if (item?.status !== EQUIVALENT_TO_CLEAN || item.kind !== 'file' || !/\.dmg$/.test(item.name ?? '') || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) return false;
  if (!zip || typeof zip.name !== 'string' || zip.name !== item.name.replace(/\.dmg$/, '.zip') || !/^[a-f0-9]{64}$/.test(zip.sha256 ?? '')) return false;
  if (!/^[a-f0-9]{64}$/.test(e.app_manifest_digest ?? '') || !Number.isInteger(e.file_count) || e.file_count < 1) return false;
  return items.some(other => other.kind === 'file' && other.name === zip.name && other.sha256 === zip.sha256 && other.status === 'no-detections');
}
export const approved = items => items.length > 0 && items.every(item => item.status === 'no-detections' || (item.status === 'detections' && item.review) || equivalentToClean(item, items));
const md = value => String(value).replace(/[|\r\n<>`\[\]\\]/g, ' ');
export function reports(items) {
  const sorted = [...items].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const report = { schema: 1, policy: { minimum_file_engines: 10, minimum_url_engines: 20, max_age_days: 7,
    dmg_without_verdict: 'accepted only as equivalent-to-clean: its .app is byte-identical to the .app of the same-arch zip, which has no detections in this report' }, approved: approved(sorted), items: sorted };
  const markdown = ['## VirusTotal verification', '', 'Match the exact file and SHA-256. Results describe engine detections and coverage at the analysis date, not a guarantee of safety. Website results describe URL reputation, not a vulnerability audit.', '',
    // Five short columns, so the table reads on GitHub; the 64-character hashes go in a code block below it.
    '| File or URL | Status | Engines | Analysis date | Report |', '| --- | --- | --- | --- | --- |',
    ...sorted.map(i => `| ${md(i.name)} | ${i.status}${i.review ? ' (owner reviewed)' : ''}${i.status === EQUIVALENT_TO_CLEAN ? ' (no VirusTotal verdict; see below)' : ''} | ${i.supported_engines ?? 0} / ${i.total_engines ?? 0} | ${md(i.analysis_date ?? 'unavailable')} | ${i.permalink ? `[VirusTotal](${i.permalink})` : 'unavailable'} |`), '',
    ...(sorted.some(i => i.sha256) ? ['SHA-256 of each file (as in `SHA256SUMS`):', '', '```', ...sorted.filter(i => i.sha256).map(i => `${i.sha256}  ${md(i.name)}`), '```', ''] : []),
    ...sorted.filter(i => i.review).map(i => `Review for ${md(i.name)} (${i.sha256}), evidence ${i.evidence_digest}: ${md(i.review.reviewer)}; ${md(i.review.reason)}; reference ${md(i.review.reference)}; expires ${md(i.review.expires_at)}.`),
    ...sorted.filter(i => i.status === EQUIVALENT_TO_CLEAN).map(i => `${md(i.name)} (${i.sha256}): no VirusTotal verdict (${md(i.virustotal_error ?? 'unavailable')}); app identical to clean-scanned ${md(i.equivalence?.matched_zip?.name)} (${md(i.equivalence?.matched_zip?.sha256)}): ${md(i.equivalence?.app)}, ${i.equivalence?.file_count} entries, app tree digest ${md(i.equivalence?.app_manifest_digest)}.`),
    ...sorted.filter(i => i.error).map(i => `${md(i.name)}: ${md(i.error)}`), ''].join('\n');
  return { json: JSON.stringify(report, null, 2) + '\n', markdown, report };
}
