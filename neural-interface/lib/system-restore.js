import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isLockOnlyDataFile } from './backup-service.js';
import { isBackupEncryptionFile, isBackupLockFile } from './backup-groups.js';

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

// ── A stable code for each failure of the restore routes ──
// The routes keep answering the sentences they always did (the command line and older pages read them); the code is
// added beside it, and it is what a page shows, through its own strings (settings-backup-encryption.js RESTORE_KEYS).
// The ZIP reader and the checksum check are loaded fresh from disk by the backup worker threads, while the running
// server keeps its old copy, so they are not changed: what they throw is recognised here, by the start of the sentence.
const THROWN_FAILURES = [
  [/^Invalid ZIP: /, 'RESTORE_ZIP_INVALID'],
  [/^Unsupported ZIP: /, 'RESTORE_ZIP_UNSUPPORTED'],
  [/^Invalid backup: checksum mismatch for /, 'RESTORE_CHECKSUM_MISMATCH'],
  [/^Invalid backup: .+ is unreadable \(/s, 'RESTORE_ENTRY_UNREADABLE'],
  [/^Invalid backup: .+ is missing$/s, 'RESTORE_ENTRY_MISSING'],
  [/ is too large to read into memory$/, 'RESTORE_MANIFEST_UNREADABLE'],
];
// The sentences of `results.errors`: a restore that answered 200 and could not do all of it.
const PARTIAL_FAILURES = [
  [/^Failed to restore database: /, 'RESTORE_DB_FAILED'],
  [/^This backup contains Qdrant snapshots /, 'RESTORE_QDRANT_FORMAT'],
  [/^Backup encryption could not be kept: /, 'RESTORE_KEY_NOT_KEPT'],
  [/^MCP server auto-build failed: /, 'RESTORE_MCP_BUILD_FAILED'],
];

/** Every code these routes add. The page has words for each (tests/settings-backup-encryption.test.mjs). */
export const RESTORE_FAILURE_CODES = Object.freeze([...new Set([
  'RESTORE_EMPTY_UPLOAD', 'RESTORE_MANIFEST_MISSING', 'RESTORE_MANIFEST_UNREADABLE', 'RESTORE_UNSUPPORTED_VERSION', 'RESTORE_UNSAFE_PATH',
  'RESTORE_WRITE_FAILED', 'RESTORE_FAILED', ...THROWN_FAILURES.map(([, code]) => code), ...PARTIAL_FAILURES.map(([, code]) => code),
])]);

/** The `code` of a thrown failure: the one it carries (a system error's, the group check's), else what its sentence is. */
export function restoreFailureCode(error) {
  if (error?.code) return error.code;
  if (error instanceof SyntaxError) return 'RESTORE_MANIFEST_UNREADABLE'; // the only JSON a restore parses before it writes
  const message = String(error?.message ?? '');
  return THROWN_FAILURES.find(([pattern]) => pattern.test(message))?.[1] || 'RESTORE_FAILED';
}

/** What a failed restore adds to its answer. Once it began writing, the answer says so: some files may be replaced. */
export function restoreFailureFields(error, res) {
  return res?.locals?.restoreWriting ? { code: 'RESTORE_WRITE_FAILED', partial: true } : { code: restoreFailureCode(error) };
}

/** The code of one sentence of `results.errors`. */
export function restoreWarningCode(sentence) {
  return PARTIAL_FAILURES.find(([pattern]) => pattern.test(String(sentence)))?.[1] || 'RESTORE_FAILED';
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
    // The hooks' state lock too (backup-groups.js): archives from before 2026-11-21 hold data/hook-state-lock.sqlite.
    if (dataRoots.has(prefix) && isBackupLockFile(basename(target))) return null;
    // The backup-encryption key file is this installation's own: no archive replaces it (backup-groups.js).
    if (dataRoots.has(prefix) && isBackupEncryptionFile(basename(target))) return null;
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
