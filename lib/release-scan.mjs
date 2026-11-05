#!/usr/bin/env node
/** Shared required scan stage; failures still write auditable reports. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyReviews, credentials, hashFile, reports, VirusTotal } from './virustotal.mjs';

/**
 * `fallback(items)` (optional) runs after every scan of this run and may only turn
 * an error item into an auditable status approved() checks on its own
 * (the desktop gate's dmg equivalence, scripts/release/lib/dmg-equivalence.mjs).
 */
export async function scanRelease({ files = [], urls = [], out, prefix = 'virustotal', reviewFile, client = new VirusTotal(), now = Date.now(), fallback }) {
  if (!files.length && !urls.length) throw new Error('No scan subjects supplied');
  // Missing/mismatched local bytes are hard errors, never reviewable detections:
  // every file is checked before the first VirusTotal request.
  const subjects = [];
  for (const file of files) {
    const path = typeof file === 'string' ? file : file.path;
    const expected = typeof file === 'string' ? undefined : file.sha256;
    const sha256 = await hashFile(path);
    if (expected && sha256 !== expected) throw new Error(`SHA-256 mismatch: ${basename(path)}`);
    subjects.push({ path, sha256 });
  }
  // Scans run concurrently so slow analyses (large dmgs) wait at the same time;
  // the client's pace() still starts requests one at a time at the API rate.
  // Items keep input order (files, then URLs) whatever finishes first.
  const items = await Promise.all([
    ...subjects.map(({ path, sha256 }) => client.file(path, sha256)
      .catch(error => ({ kind: 'file', name: basename(path), sha256, status: 'error', analysis_status: 'unavailable', error: error.message }))),
    ...urls.map(url => client.url(url)
      .catch(error => ({ kind: 'url', name: url, status: 'error', analysis_status: 'unavailable', error: error.message }))),
  ]);
  const reviews = reviewFile ? JSON.parse(await readFile(reviewFile, 'utf8')) : [];
  const settled = fallback ? await fallback(items) : items;
  // A fallback may change error items only: a verdict VirusTotal gave is never rewritten.
  if (!Array.isArray(settled) || settled.length !== items.length || settled.some((item, i) => item !== items[i] && (items[i].status !== 'error' || !['error', 'equivalent-to-clean'].includes(item?.status) || item.name !== items[i].name || item.sha256 !== items[i].sha256))) throw new Error('VirusTotal fallback may only settle error items');
  const result = reports(applyReviews(settled, reviews, now));
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, `${prefix}.json`), result.json);
  await writeFile(resolve(out, `${prefix}.md`), result.markdown);
  if (!result.report.approved) throw new Error(`VirusTotal gate blocked; inspect ${prefix}.json/.md. Retry failures/inconclusive scans; detections require a hash- and evidence-specific review (docs/release-pipeline.md).`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    credentials();
    const files = []; const urls = []; let out, reviewFile, prefix = 'virustotal';
    const args = process.argv.slice(2);
    while (args.length) {
      const arg = args.shift();
      if (arg === '--out') out = args.shift();
      else if (arg === '--prefix') prefix = args.shift();
      else if (arg === '--review') reviewFile = args.shift();
      else if (arg === '--url') urls.push(args.shift());
      else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
      else files.push(arg);
    }
    if (!out) throw new Error('Usage: node lib/release-scan.mjs --out DIR [--review FILE] [--url https://synabun.ai/] [FILE ...]');
    if (!['virustotal', 'npm-virustotal'].includes(prefix)) throw new Error('Use prefix virustotal or npm-virustotal');
    await scanRelease({ files, urls, out, prefix, reviewFile });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
