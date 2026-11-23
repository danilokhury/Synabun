// ═══════════════════════════════════════════
// RESTORE — the command line's private stage
// ═══════════════════════════════════════════
//
// `synabun restore-backup` extracts a backup into a sibling of the data home and swaps it in. Those files are the
// backup in plaintext, an encrypted backup's too, so the folder is private (0700) from its first moment, and a restore
// that was killed does not leave it behind: the next restore and the next server start remove it.
//
// No import from backup-service.js: the command-line restore loads this without the backup writer's dependencies.

import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const STALE_STAGE_MS = 24 * 60 * 60 * 1000;

const stageNameOf = (target) => basename(resolve(target)).replace(/^\.+/, '') || 'synabun';

function pidIsGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

/** Where a restore of `target` stages its files: a sibling named after the data home, this process and this moment. */
export function restoreStagePath(target, { pid = process.pid, now = Date.now } = {}) {
  return resolve(dirname(resolve(target)), `.${stageNameOf(target)}.restore-stage-${pid}-${now()}`);
}

/** Creates the stage, readable by its owner alone, whatever the umask says. It must not exist yet. */
export function makePrivateRestoreStage(stage) {
  mkdirSync(stage, { mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(stage, 0o700);
  return stage;
}

/**
 * Removes the stages a killed restore of `target` left: those whose process is gone, and any older than a day (a
 * process id can come back). Only real folders with exactly this data home's stage name are touched; a link is left
 * alone. Returns the names removed.
 */
export function sweepRestoreStages(target, { ownerGone = pidIsGone, now = Date.now, maxAgeMs = STALE_STAGE_MS } = {}) {
  const parent = dirname(resolve(target));
  const prefix = `.${stageNameOf(target)}.restore-stage-`;
  const removed = [];
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const match = name.slice(prefix.length).match(/^(\d+)-(\d+)$/);
    if (!match) continue;
    const path = resolve(parent, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const owner = Number(match[1]);
      const abandoned = owner !== process.pid && ownerGone(owner);
      if (!abandoned && now() - stat.mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch { /* another process is removing it */ }
  }
  return removed;
}
