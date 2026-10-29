/** Release-only VirusTotal API v3 client. No API calls occur on import. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DIRECT_LIMIT = 32 * 1024 * 1024;
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
  constructor({ key, fetchImpl = globalThis.fetch, sleep = delay, now = Date.now, intervalMs = 15500, requestMs = 120000, uploadMs = 900000, scanMs = 1200000, pollMs = 30000, retries = 3 } = {}) {
    this.key = credentials(key); this.fetch = fetchImpl; this.sleep = sleep; this.now = now;
    Object.assign(this, { intervalMs, requestMs, uploadMs, scanMs, pollMs, retries }); this.nextRequest = 0; this.queue = Promise.resolve();
  }
  async wait(ms, deadline) {
    if (this.now() + ms >= deadline) throw new Error('VirusTotal analysis deadline exceeded; retry the same bytes later');
    if (ms > 0) await this.sleep(ms);
  }
  async pace(deadline) {
    // Reserve request starts serially, even when library callers scan concurrently.
    const turn = this.queue.then(async () => {
      await this.wait(Math.max(0, this.nextRequest - this.now()), deadline);
      if (this.now() >= deadline) throw new Error('VirusTotal analysis deadline exceeded');
      this.nextRequest = this.now() + this.intervalMs;
    });
    this.queue = turn.catch(() => {});
    await turn;
  }
  async request(path, { method = 'GET', body, headers = {}, deadline = this.now() + this.scanMs, notFound = false, timeoutMs = this.requestMs } = {}) {
    const url = trustedUrl(path.startsWith('https:') ? path : API + path);
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.pace(deadline);
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
        if (attempt === this.retries) throw new Error('VirusTotal request failed or timed out; no verdict available');
        await this.wait(1000 * 2 ** attempt, deadline); continue;
      }
      if (response.status === 404 && notFound) return null;
      if (response.status === 429 || response.status >= 500) {
        if (attempt === this.retries) throw new Error(`VirusTotal HTTP ${response.status}; retry budget exhausted`);
        const retry = response.headers.get('retry-after');
        const ms = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.now() : 1000 * 2 ** attempt;
        await this.wait(Math.max(1000, Number.isFinite(ms) ? ms : 1000), deadline); continue;
      }
      if (!response.ok) throw new Error(`VirusTotal HTTP ${response.status}; no verdict available`);
      try { return JSON.parse(payload); } catch { throw new Error('VirusTotal returned invalid JSON'); }
    }
  }
  async poll(id, deadline) {
    if (typeof id !== 'string' || !id) throw new Error('VirusTotal did not return an analysis ID');
    for (let count = 0; count < 40; count++) {
      const result = await this.request(`analyses/${encodeURIComponent(id)}`, { deadline });
      const status = result?.data?.attributes?.status;
      if (status === 'completed') return result;
      if (!['queued', 'in-progress'].includes(status)) throw new Error('VirusTotal returned an unknown analysis status');
      await this.wait(this.pollMs, deadline);
    }
    throw new Error('VirusTotal analysis unfinished after 40 polls; retry later');
  }
  async file(path, expectedHash) {
    const size = (await stat(path)).size;
    if (size > UPLOAD_LIMIT) throw new Error(`VirusTotal 650 MB upload limit exceeded: ${basename(path)}`);
    const sha256 = await hashFile(path);
    if (expectedHash && sha256 !== expectedHash) throw new Error(`SHA-256 mismatch: ${basename(path)}`);
    const deadline = this.now() + this.scanMs;
    const cached = await this.request(`files/${sha256}`, { deadline, notFound: true });
    let report;
    const a = cached?.data?.attributes;
    if (cached && (cached.data.id !== sha256 || a?.sha256 !== sha256)) throw new Error('VirusTotal file SHA-256 mismatch');
    if (cached && this.fresh(a?.last_analysis_date)) {
      report = this.evidence({ kind: 'file', name: basename(path), sha256, size }, a.last_analysis_stats, a.last_analysis_results, a.last_analysis_date, 'cached');
    } else {
      let analysis;
      if (cached) analysis = await this.request(`files/${sha256}/analyse`, { method: 'POST', deadline });
      else {
        const upload = size > DIRECT_LIMIT ? (await this.request('files/upload_url', { deadline }))?.data : API + 'files';
        if (typeof upload !== 'string') throw new Error('VirusTotal did not return an upload URL');
        const boundary = `synabun-${sha256}`;
        const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName(basename(path))}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const tail = `\r\n--${boundary}--\r\n`;
        analysis = await this.request(upload, { method: 'POST', deadline, timeoutMs: this.uploadMs, body: () => multipart(path, boundary),
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(Buffer.byteLength(head) + size + Buffer.byteLength(tail)) } });
      }
      const result = await this.poll(analysis?.data?.id, deadline);
      if (result.meta?.file_info?.sha256 !== sha256) throw new Error('VirusTotal analysis SHA-256 mismatch');
      const attrs = result.data.attributes;
      report = this.evidence({ kind: 'file', name: basename(path), sha256, size }, attrs.stats, attrs.results, attrs.date, cached ? 'reanalysed' : 'uploaded', analysis.data.id);
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
    const submitted = await this.request('urls', { method: 'POST', body: new URLSearchParams({ url: subject }), deadline });
    const result = await this.poll(submitted?.data?.id, deadline);
    // Verify the URL object too; do not attribute an analysis to an unrelated URL.
    const object = await this.request(`urls/${id}`, { deadline });
    if (object?.data?.attributes?.url !== subject) throw new Error('VirusTotal URL mismatch');
    if (result.meta?.url_info?.url !== subject || !/^[a-f0-9]{64}$/.test(object.data.id)) throw new Error('VirusTotal URL analysis identity mismatch');
    const a = result.data.attributes;
    return this.evidence({ kind: 'url', name: subject, sha256: createHash('sha256').update(subject).digest('hex'), url: subject }, a.stats, a.results, a.date, 'submitted', submitted.data.id, object.data.id);
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
export const approved = items => items.length > 0 && items.every(item => item.status === 'no-detections' || (item.status === 'detections' && item.review));
const md = value => String(value).replace(/[|\r\n<>`\[\]\\]/g, ' ');
export function reports(items) {
  const sorted = [...items].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const report = { schema: 1, policy: { minimum_file_engines: 10, minimum_url_engines: 20, max_age_days: 7 }, approved: approved(sorted), items: sorted };
  const markdown = ['## VirusTotal verification', '', 'Match the exact file and SHA-256. Results describe engine detections and coverage at the analysis date, not a guarantee of safety. Website results describe URL reputation, not a vulnerability audit.', '',
    '| Package / URL | SHA-256 | Status | Supported / total engines | Analysis date | Report |', '| --- | --- | --- | --- | --- | --- |',
    ...sorted.map(i => `| ${md(i.name)} | ${i.sha256} | ${i.status}${i.review ? ' (owner reviewed)' : ''} | ${i.supported_engines ?? 0} / ${i.total_engines ?? 0} | ${md(i.analysis_date ?? 'unavailable')} | ${i.permalink ? `[VirusTotal](${i.permalink})` : 'unavailable'} |`), '',
    ...sorted.filter(i => i.review).map(i => `Review for ${md(i.name)} (${i.sha256}), evidence ${i.evidence_digest}: ${md(i.review.reviewer)}; ${md(i.review.reason)}; reference ${md(i.review.reference)}; expires ${md(i.review.expires_at)}.`),
    ...sorted.filter(i => i.error).map(i => `${md(i.name)}: ${md(i.error)}`), ''].join('\n');
  return { json: JSON.stringify(report, null, 2) + '\n', markdown, report };
}
