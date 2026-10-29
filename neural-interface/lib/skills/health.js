// Deterministic maintenance on the existing scheduler tick. No model, install, repair or retirement runs here.
import { localRecord } from './local-store.js';
import { scanEvidenceKey, scanAllows, SCAN_ENGINE_VERSION, SCAN_POLICY } from './scan.js';

import { buildExport } from './export.js';
import { TARGET_PROFILE } from '../../public/shared/skills/ss-profiles.js';
import { folderDigest } from './library.js';

export function createSkillHealth({ dataDir, service, settings, notify = () => false, now = Date.now }) {
  const store = localRecord(dataDir, 'health', { checkedAt: null, rows: [], notifications: [] });
  let running = null;
  const view = () => ({ ...store.read(), enabled: settings().healthEnabled, cadenceHours: settings().cadenceHours, running: !!running, rules: `${SCAN_ENGINE_VERSION}:${SCAN_POLICY}` });
  async function flush() {
    const state = store.read();
    const keep = [];
    for (const item of state.notifications || []) { try { if (!await notify(item)) keep.push(item); } catch { keep.push(item); } }
    if (keep.length !== (state.notifications || []).length) { state.notifications = keep; store.write(state); }
  }
  async function check({ probe = false } = {}) {
    if (running) return running;
    running = (async () => {
      const previous = store.read();
      const rows = [];
      for (const inst of service.deployer.listInstallations({ active: true })) {
        try {
          const checked = await service.deployer.verify(inst.installationId, { probeRuntime: probe });
          let folder = service.library.readRevisionFiles(inst.sourceRevisionId);
          for (const runtime of inst.destination.affectedRuntimes) folder = buildExport(folder, TARGET_PROFILE[runtime]);
          const skill = service.library.getSkill(inst.skillId);
          const scan = service.scanFolder(folder, { name: inst.destination.relativePath, digest: folderDigest(folder), skill });
          const state = checked.state;
          const issues = [];
          if (!state.written) issues.push(state.writtenCheck || 'drift');
          if (!state.discoverable) issues.push('not_discoverable');
          if (state.eligibility === 'disabled') issues.push('disabled');
          if (probe && Object.values(state.discovered || {}).some((v) => v?.discovered === false)) issues.push('not_listed');
          const acknowledged = inst.scanAcknowledgement?.evidenceKey === scanEvidenceKey(scan) ? inst.scanAcknowledgement.digest : null;
          if (!scanAllows(scan, { digest: scan.digest, acknowledgedDigest: acknowledged }).ok) issues.push(`scan_${scan.gate === 'allowed' ? 'blocked' : scan.gate}`);
          const old = previous.rows.find((r) => r.installationId === inst.installationId);
          const rulesChanged = !!old && (old.scan?.engineVersion !== scan.engineVersion || old.scan?.policy !== scan.policy);
          rows.push({ installationId: inst.installationId, skillId: inst.skillId, revisionId: inst.sourceRevisionId,
            name: skill.name, runtime: inst.target.runtime, checkedAt: now(), state, scan, rulesChanged, issues,
            status: issues.length ? 'attention' : state.eligibility === 'unknown' || !probe || !inst.destination.affectedRuntimes.every((r) => state.discovered?.[r]?.discovered === true) ? 'unverified_runtime' : 'checked',
            discoveryFresh: probe,
            // A runtime listing is still not execution or proof of quality.
            executed: null });
        } catch (e) {
          rows.push({ installationId: inst.installationId, skillId: inst.skillId, revisionId: inst.sourceRevisionId,
            runtime: inst.target.runtime, checkedAt: now(), status: 'error', issues: ['check_error'], error: String(e.code || 'check_failed') });
        }
      }
      const notifications = [...(previous.notifications || [])];
      for (const row of rows) {
        const old = previous.rows.find((r) => r.installationId === row.installationId);
        if ((row.issues.length || row.rulesChanged) && JSON.stringify([old?.issues, old?.scan?.policy, old?.scan?.engineVersion, old?.scan?.findings]) !== JSON.stringify([row.issues, row.scan?.policy, row.scan?.engineVersion, row.scan?.findings])) {
          notifications.push({ kind: 'skills_health', text: `Skills Studio health: ${row.installationId} (${row.runtime}): ${row.issues.join(', ') || 'scanner rules changed'}. Review Health in Skills Studio. No installed files changed.`, installationId: row.installationId, revisionId: row.revisionId });
        }
      }
      store.write({ checkedAt: now(), rows, notifications: notifications.slice(-100) });
      service.announce({ type: 'health.changed', attention: rows.filter((r) => r.issues.length).length });
      await flush();
      return view();
    })();
    try { return await running; } finally { running = null; }
  }
  async function tick() {
    service.telemetry?.prune();
    if (!settings().healthEnabled) return;
    await flush();
    const current = view();
    if (!current.checkedAt || now() - current.checkedAt >= settings().cadenceHours * 3600000
      || current.rows.some((r) => r.scan && (r.scan.engineVersion !== SCAN_ENGINE_VERSION || r.scan.policy !== SCAN_POLICY))) await check();
  }
  return { view, check, tick };
}
