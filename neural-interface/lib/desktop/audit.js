// ═══════════════════════════════════════════
// SynaBun — Desktop audit log (one JSONL file per day)
// ═══════════════════════════════════════════
//
// Every computer action — allowed or refused — is recorded with its owner,
// app, result code, warnings and the sha256 of the screenshot it acted on.
// Typed text is never stored: only its length and sha256.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function redactText(text) {
  if (text === undefined || text === null) return null;
  const value = String(text);
  return { length: value.length, sha256: createHash('sha256').update(value).digest('hex').slice(0, 16) };
}

export function createAuditLog({ dir, now = Date.now, retentionDays = () => 14, log = () => {} } = {}) {
  if (!dir) throw new Error('createAuditLog requires dir');
  let seq = 0;
  const day = (ms = now()) => new Date(ms).toISOString().slice(0, 10);
  const fileFor = (d) => resolve(dir, `${d}.jsonl`);

  function record(entry = {}) {
    seq += 1;
    const row = { at: new Date(now()).toISOString(), seq, ...entry };
    if ('text' in row) { row.text = redactText(row.text); }
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(fileFor(day()), JSON.stringify(row) + '\n', 'utf8');
    } catch (error) { log('desktop:audit-error', error?.message || String(error)); }
    return row;
  }
  function recent({ limit = 50, assistantSessionId = null } = {}) {
    const out = [];
    for (const d of [day(), day(now() - 86_400_000)]) {
      const path = fileFor(d);
      if (!existsSync(path)) continue;
      try {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) { try { out.push(JSON.parse(line)); } catch {} }
      } catch {}
    }
    const filtered = assistantSessionId ? out.filter((row) => row.owner?.assistantSessionId === assistantSessionId) : out;
    return filtered.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
  }
  function prune() {
    const days = Math.max(1, Number(typeof retentionDays === 'function' ? retentionDays() : retentionDays) || 14);
    const cutoff = day(now() - days * 86_400_000);
    try {
      if (!existsSync(dir)) return 0;
      let removed = 0;
      for (const name of readdirSync(dir)) {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (match && match[1] < cutoff) { rmSync(resolve(dir, name), { force: true }); removed += 1; }
      }
      return removed;
    } catch { return 0; }
  }
  return { record, recent, prune, dir };
}
