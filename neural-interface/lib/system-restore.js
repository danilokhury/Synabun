import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isLockOnlyDataFile } from './backup-service.js';

/**
 * Helpers for POST /api/system/restore{,/preview}.
 *
 * The upload used to be buffered by express.raw (1 GB cap) and opened with
 * AdmZip, so a data home past 1 GB could not be restored from the UI at all.
 * It now streams to a staging file and is read with backup-zip-reader.
 */

export function pathIsInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const STALE_UPLOAD_MS = 60 * 60 * 1000;

/** Stream the request body to a fresh file under `stagingDir`; returns its path and size. */
export async function saveRestoreUpload(req, stagingDir) {
  mkdirSync(stagingDir, { recursive: true });
  // A restore killed mid-upload never reaches its finally; reclaim its file.
  for (const name of readdirSync(stagingDir)) {
    const path = join(stagingDir, name);
    try { if (Date.now() - statSync(path).mtimeMs > STALE_UPLOAD_MS) rmSync(path, { recursive: true, force: true }); } catch {}
  }
  const path = join(stagingDir, `upload-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.zip`);
  try {
    await pipeline(req, createWriteStream(path, { flags: 'wx' }));
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return { path, sizeBytes: statSync(path).size };
}

export function removeRestoreUpload(upload) {
  if (upload?.path && existsSync(upload.path)) rmSync(upload.path, { force: true });
}

/**
 * Map one archive-relative path (`data/x.json`, `skins/y/skin.css`, …) to the
 * file it restores. Returns null for paths the mode does not restore and
 * `{ unsafe: true }` for a path that would escape its root (zip-slip).
 *
 * A lock-only file of a data folder (the rules installer's writer lock and
 * its SQLite side files, backup-service.js) is never restored, whatever the
 * archive holds: extracting it would rename another file over the one a
 * running server holds its lock on. The live file is not touched in any way.
 */
export function restoreTargetFor(rel, roots) {
  if (rel === 'claude-settings.json') {
    return roots.claudeSettings ? { target: resolve(roots.claudeSettings) } : null;
  }
  const dataRoots = new Set(['data/', 'mcp-data/']);
  const mappings = [
    ['data/', roots.data],
    ['mcp-data/', roots.mcpData],
    ['global-skills/', roots.globalSkills],
    ['global-agents/', roots.globalAgents],
    ['bundled-skills/', roots.bundledSkills],
    ['skins/', roots.skins],
  ];
  for (const [prefix, root] of mappings) {
    if (!rel.startsWith(prefix) || rel === prefix) continue;
    if (!root) return null;
    const subPath = rel.slice(prefix.length);
    const target = resolve(root, subPath);
    if (subPath.includes('\0') || isAbsolute(subPath) || target === resolve(root) || !pathIsInside(target, root)) {
      return { unsafe: true };
    }
    // By the name the write would land on, so `data/x/../rulesets-lock.db` and another letter case count too.
    if (dataRoots.has(prefix) && isLockOnlyDataFile(basename(target))) return null;
    return { target };
  }
  return null;
}

/**
 * Plan every file write for a restore before touching disk, so one unsafe
 * entry rejects the whole archive instead of half-applying it.
 */
export function planRestoreWrites(zip, prefix, roots) {
  const writes = [];
  const unsafe = [];
  const lead = prefix ? `${prefix}/` : '';
  for (const entry of zip.entries) {
    if (entry.isDirectory || !entry.name.startsWith(lead)) continue;
    const rel = entry.name.slice(lead.length);
    const mapped = restoreTargetFor(rel, roots);
    if (!mapped) continue;
    if (mapped.unsafe) unsafe.push(entry.name);
    else writes.push({ entry, rel, target: mapped.target });
  }
  return { writes, unsafe };
}
