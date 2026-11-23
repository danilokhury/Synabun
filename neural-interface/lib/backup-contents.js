// ═══════════════════════════════════════════
// BACKUP CONTENTS — the owner's choice of what a backup holds, and how big it is
// ═══════════════════════════════════════════
//
// Settings → Backups → What to back up. One choice for every backup this server makes on request or on schedule
// (the download into a folder, the browser download, the scheduled backup, Back up now), kept in
// DATA_HOME/data/backup-selection.json as { version, groups: { id: boolean } }. A group nothing was said about has
// its default (backup-groups.js): everything that cannot be made again is on, caches and working folders are off.
//
// The sizes next to the switches are measured on a worker thread (backup-service.js measureBackupContents: names and
// sizes, no file opened), never in a request: a request only reads the last measurement and, when it is missing, old
// or asked for again, starts one. The page asks again while `estimate.state` is `measuring`.
//
//   createBackupContentsService({ configPath, measure, … })   the choice and the measurement
//   backupContentsHandlers(service)                            GET and PUT /api/system/backup/contents
// ═══════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BACKUP_GROUPS, BACKUP_GROUP_IDS, irreplaceableLeftOut, normalizeBackupSelection, selectedBackupGroups } from './backup-groups.js';

export const BACKUP_ESTIMATE_TTL_MS = 5 * 60_000;

const emptySize = () => ({ files: 0, bytes: 0, archiveBytes: 0 });

/**
 * @param {object} o
 * @param {string} o.configPath                         where the choice is kept
 * @param {() => Promise<{ groups: object, never: object }>} o.measure   one measurement (a worker thread)
 * @param {number} [o.ttlMs]                            how long a measurement is shown before a new one is made
 * @param {() => number} [o.now]
 * @param {(line: string) => void} [o.log]
 */
export function createBackupContentsService({ configPath, measure, ttlMs = BACKUP_ESTIMATE_TTL_MS, now = Date.now, log = () => {} } = {}) {
  if (!configPath || typeof measure !== 'function') throw new Error('configPath and measure are required');
  let measured = null;   // { at, groups, never }
  let measuring = null;  // the measurement under way
  let failure = null;    // the last one's error, until one succeeds

  function selection() {
    try { return normalizeBackupSelection(JSON.parse(readFileSync(configPath, 'utf-8'))?.groups); }
    catch { return normalizeBackupSelection(null); }
  }

  /** The ids a backup made now would hold. */
  const groups = () => selectedBackupGroups(selection());

  function save(value) {
    mkdirSync(dirname(configPath), { recursive: true });
    const temp = `${configPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ version: 1, groups: value }, null, 2)}\n`, 'utf-8');
      renameSync(temp, configPath);
    } catch (error) {
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* nothing to remove */ }
      throw error;
    }
  }

  /**
   * Switch groups on or off: `patch` is { id: boolean } for the groups that change. Refused (status 400): anything
   * but booleans for known groups, and a choice that leaves nothing to back up.
   */
  function setSelection(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw Object.assign(new Error('Say which groups to switch: { groups: { id: true | false } }.'), { status: 400, code: 'SELECTION_INVALID' });
    }
    const next = selection();
    for (const [id, value] of Object.entries(patch)) {
      if (!BACKUP_GROUP_IDS.includes(id)) throw Object.assign(new Error(`There is no backup group "${String(id).slice(0, 40)}".`), { status: 400, code: 'GROUP_UNKNOWN' });
      if (typeof value !== 'boolean') throw Object.assign(new Error(`"${id}" is switched with true or false.`), { status: 400, code: 'SELECTION_INVALID' });
      next[id] = value;
    }
    if (!selectedBackupGroups(next).length) {
      throw Object.assign(new Error('A backup needs at least one group switched on.'), { status: 400, code: 'NOTHING_SELECTED' });
    }
    save(next);
    return next;
  }

  /** Start a measurement unless one is running; the one under way otherwise. Never throws, never rejects. */
  function measureNow() {
    if (measuring) return measuring;
    measuring = Promise.resolve()
      .then(() => measure())
      .then((result) => {
        const sizes = {};
        for (const id of BACKUP_GROUP_IDS) {
          const got = result?.groups?.[id] || {};
          sizes[id] = { files: Number(got.files) || 0, bytes: Number(got.bytes) || 0, archiveBytes: Number(got.archiveBytes) || 0 };
        }
        measured = { at: now(), groups: sizes, never: { files: Number(result?.never?.files) || 0, bytes: Number(result?.never?.bytes) || 0 } };
        failure = null;
      }, (error) => {
        failure = error?.message || String(error);
        log(`[backup] The size of the backup groups could not be measured: ${failure}`);
      })
      .finally(() => { measuring = null; });
    return measuring;
  }

  /**
   * What the page shows. Reads the last measurement and starts a new one when there is none, when it is older than
   * `ttlMs`, or when `refresh` asks; the answer never waits for it.
   */
  function snapshot({ refresh = false } = {}) {
    const chosen = selection();
    if (refresh || !measured || now() - measured.at >= ttlMs) measureNow();
    const selected = emptySize();
    const everything = emptySize();
    const rows = BACKUP_GROUPS.map((group) => {
      const size = measured ? measured.groups[group.id] : null;
      if (size) {
        for (const key of ['files', 'bytes', 'archiveBytes']) {
          everything[key] += size[key];
          if (chosen[group.id]) selected[key] += size[key];
        }
      }
      return { id: group.id, kind: group.kind, default: group.default, enabled: chosen[group.id], ...(size || { files: null, bytes: null, archiveBytes: null }) };
    });
    return {
      ok: true,
      groups: rows,
      totals: measured ? { selected, everything } : null,
      never: measured ? measured.never : null,
      irreplaceableOff: irreplaceableLeftOut(chosen),
      estimate: {
        state: measuring ? 'measuring' : measured ? 'ready' : failure ? 'failed' : 'none',
        measuredAt: measured ? new Date(measured.at).toISOString() : null,
        error: failure,
      },
    };
  }

  return {
    selection, groups, setSelection, snapshot,
    /** Settles when the measurement under way ended (tests, shutdown). */
    idle: () => (measuring || Promise.resolve()),
    /** The data changed in a way a measurement cannot know (a restore): the next reading measures again. */
    invalidate: () => { measured = null; },
  };
}

/**
 * GET (the state; `?refresh=1` measures again) and PUT ({ groups: { id: boolean } }) of /api/system/backup/contents.
 * @param {ReturnType<typeof createBackupContentsService>} service
 */
export function backupContentsHandlers(service) {
  const refuse = (res, error) => res.status(Number(error?.status) || 500).json({ ok: false, error: error?.message || String(error), code: error?.code || null });
  return {
    status(req, res) {
      try { res.json(service.snapshot({ refresh: req.query?.refresh === '1' })); } catch (error) { refuse(res, error); }
    },
    update(req, res) {
      try { service.setSelection(req.body?.groups); res.json(service.snapshot()); } catch (error) { refuse(res, error); }
    },
  };
}
