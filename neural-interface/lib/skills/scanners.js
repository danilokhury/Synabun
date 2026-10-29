import { localRecord } from './local-store.js';
// Optional engines have no ambient discovery, credentials, command fallback or automatic download.
// A verified host adapter is injected by the application. Unsupported contracts remain explicitly unavailable.
export const EXTERNAL_SCANNERS = Object.freeze([
  { id: 'cisco', license: 'Apache-2.0 client', licenseCode: 'apacheClient', boundary: 'Local static/code/dataflow only. LLM, AI Defense and VirusTotal uploads require separate consent.', preferred: true },
  { id: 'gitleaks', license: 'MIT core', licenseCode: 'mitCore', boundary: 'Local secret detection only; cannot certify prompt safety.' },
  { id: 'snyk', license: 'Apache-2.0 client; hosted terms separate', licenseCode: 'apacheHosted', boundary: 'Skill content leaves the computer. Retention and registry-scale entitlement must be agreed first.' },
  { id: 'socket', license: 'MIT CLI; hosted terms separate', licenseCode: 'mitHosted', boundary: 'No verified standalone skill analysis API. Dated registry badges are evidence only.' },
]);
export function createExternalScanners({ settings, adapters = {}, timeoutMs = 30000, dataDir = null }) {
  const store = dataDir ? localRecord(dataDir, 'external-scans', { records: {} }) : null;
  const signature = () => JSON.stringify(list().filter((e) => e.enabled).map((e) => [e.id, adapters[e.id]?.version || null, e.available]));
  function evidence(digest) {
    const record = store?.read().records[digest];
    if (record?.signature === signature()) return record.results;
    return list().filter((e) => e.enabled).map((e) => ({ engine: e.id, digest, required: true, status: 'incomplete', reason: 'scan_required' }));
  }
  function list() { return EXTERNAL_SCANNERS.map((e) => ({ ...e, enabled: settings().scanners.includes(e.id), available: !!(adapters[e.id]?.version && adapters[e.id]?.isolated && !adapters[e.id]?.outbound && typeof adapters[e.id]?.scan === 'function'), status: !settings().scanners.includes(e.id) ? 'skipped' : adapters[e.id]?.version && adapters[e.id]?.isolated && !adapters[e.id]?.outbound && typeof adapters[e.id]?.scan === 'function' ? 'ready' : 'unavailable' })); }
  async function scan(revision, folder) {
    let results = [];
    const startedSignature = signature();
    for (const engine of list()) {
      const base = { engine: engine.id, digest: revision.contentDigest, disclosure: engine.boundary, required: engine.enabled };
      if (!engine.enabled) { results.push({ ...base, status: 'skipped', reason: 'owner_opt_in_required' }); continue; }
      const adapter = adapters[engine.id];
      if (!adapter?.scan || !adapter.version || !adapter.isolated || adapter.outbound) { results.push({ ...base, status: 'error', reason: 'verified_local_adapter_unavailable' }); continue; }
      let timer;
      const controller = new AbortController();
      try {
        const out = await Promise.race([
          Promise.resolve().then(() => adapter.scan({ files: folder.files.map((f) => ({ ...f, bytes: Buffer.from(f.bytes) })), digest: revision.contentDigest, signal: controller.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('scanner_timeout')); }, timeoutMs); }),
        ]);
        if (!out || out.digest !== revision.contentDigest || !['no_findings', 'findings', 'error', 'skipped', 'incomplete'].includes(out.status)) throw new Error('invalid_scanner_result');
        if (out.status === 'findings' && !out.findings?.length || out.status === 'no_findings' && out.findings?.length || out.findings?.length > 400 || out.coverage?.complete === false) throw new Error('invalid_scanner_result');
        results.push({ ...base, engineVersion: adapter.version, status: out.status, findings: (out.findings || []).slice(0, 400).map((f) => ({ ruleId: String(f.ruleId || 'external').slice(0, 100), severity: ['critical', 'high', 'medium', 'low', 'info'].includes(f.severity) ? f.severity : 'high', file: folder.files.some((v) => v.path === f.file) ? f.file : null, line: Number.isInteger(f.line) ? f.line : null })) });
      } catch { results.push({ ...base, engineVersion: adapter.version, status: 'error', reason: controller.signal.aborted ? 'scanner_timeout' : 'scanner_failed' }); }
      finally { clearTimeout(timer); }
    }
    if (signature() !== startedSignature) {
      results = list().map((e) => ({ engine: e.id, digest: revision.contentDigest, required: e.enabled, status: e.enabled ? 'incomplete' : 'skipped', reason: 'scanner_configuration_changed' }));
    }
    if (store && results.some((r) => r.required)) {
      const state = store.read();
      delete state.records[revision.contentDigest];
      state.records[revision.contentDigest] = { signature: signature(), results };
      const keys = Object.keys(state.records);
      for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete state.records[key];
      store.write(state);
    }
    return results;
  }
  return { list, scan, evidence };
}
