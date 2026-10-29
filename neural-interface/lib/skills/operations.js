import { localRecord } from './local-store.js';
import { createSkillTelemetry } from './telemetry.js';
import { createSkillHealth } from './health.js';
import { createSkillDiscover, DISCOVER_SOURCES } from './discover.js';
import { createSkillPackages } from './packages.js';
import { createExternalScanners, EXTERNAL_SCANNERS } from './scanners.js';
import { isSkillId } from './library.js';

export const OPERATIONS_DEFAULTS = Object.freeze({ telemetryEnabled: true, retentionDays: 30, healthEnabled: false, cadenceHours: 24, sources: [], scanners: [], protectedSkillIds: [] });

export function attachSkillOperations(service, { dataDir, notify, request, adapters, now = Date.now }) {
  const store = localRecord(dataDir, 'operations', OPERATIONS_DEFAULTS, 65536);
  const settings = () => ({ ...OPERATIONS_DEFAULTS, ...store.read() });
  function configure(patch) {
    const next = settings();
    const invalid = (message) => { throw Object.assign(new Error(message), { status: 400, code: 'invalid_config' }); };
    if (!patch || Array.isArray(patch) || typeof patch !== 'object') invalid('Settings are an object.');
    for (const key of Object.keys(patch)) if (!Object.hasOwn(OPERATIONS_DEFAULTS, key)) invalid(`Unknown setting: ${key}`);
    for (const key of ['telemetryEnabled', 'healthEnabled']) if (patch[key] !== undefined) { if (typeof patch[key] !== 'boolean') invalid(`${key} is true or false.`); next[key] = patch[key]; }
    for (const [key, min, max] of [['retentionDays', 1, 365], ['cadenceHours', 1, 168]]) if (patch[key] !== undefined) { if (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max) invalid(`${key} is an integer from ${min} to ${max}.`); next[key] = patch[key]; }
    for (const [key, allowed] of [['sources', DISCOVER_SOURCES.map((s) => s.id)], ['scanners', EXTERNAL_SCANNERS.map((s) => s.id)]]) if (patch[key] !== undefined) {
      if (!Array.isArray(patch[key]) || !patch[key].every((id) => allowed.includes(id))) invalid(`${key} names known providers.`);
      next[key] = [...new Set(patch[key])];
    }
    // Nothing with an unverified execution/disclosure contract can be enabled by guessing a CLI or API.
    for (const id of next.scanners) if (!adapters?.[id]?.version || !adapters[id].isolated || adapters[id].outbound || typeof adapters[id].scan !== 'function') invalid(`The verified local ${id} adapter is unavailable. Hosted analysis remains off.`);
    if (patch.protectedSkillIds !== undefined) { if (!Array.isArray(patch.protectedSkillIds) || patch.protectedSkillIds.length > 1000 || !patch.protectedSkillIds.every(isSkillId)) invalid('protectedSkillIds names library skills.'); next.protectedSkillIds = [...new Set(patch.protectedSkillIds)]; }
    store.write(next); service.telemetry.prune();
    service.announce({ type: 'operations.changed' });
    return next;
  }
  service.telemetry = createSkillTelemetry({ dataDir, deployer: service.deployer, settings, now });
  service.health = createSkillHealth({ dataDir, service, settings, notify, now });
  service.discover = createSkillDiscover({ dataDir, service, settings, ...(request ? { request } : {}), liveRoots: () => service.roots().map((r) => r.path), now });
  service.packages = createSkillPackages({ service });
  service.scanners = createExternalScanners({ settings, adapters, dataDir });
  service.library.setExternalEvidence((digest) => service.scanners.evidence(digest));
  service.deployer.setExternalScanner((revision, folder) => service.scanners.scan(revision, folder));
  service.operations = { settings, configure, proposals() {
    // A conservative, typed triage fallback: repeated tool failures support an investigation, never an edit.
    // No private trace mining, Jev call, model execution, grade or promotion is inferred from adoption.
    return service.telemetry.summary().rows.filter((r) => r.failed >= 2).map((r) => ({ kind: 'investigate_failures', skillId: r.skillId, revisionId: r.revisionId, runtime: r.runtime, evidence: { failures: r.failed, lastAt: r.lastAt }, judgment: null, action: 'Review failures and run independent task/trigger evaluations before proposing a new revision.', protected: settings().protectedSkillIds.includes(r.skillId), automatic: false }));
  } };
  return service;
}
