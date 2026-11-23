#!/usr/bin/env node

/**
 * Restore durable SynaBun state from a verified v2/v3 backup.
 *
 * The archive is fully checksum-verified before extraction. Restore happens in
 * a sibling staging directory; the existing target is renamed (never deleted)
 * immediately before the staged tree is atomically activated.
 *
 * A backup that says it leaves groups out (Settings → Backups → What to back up; `groups` in its manifest) restores
 * only what it holds: everything of the present data home that belongs to a group it does not contain is carried
 * into the restored one (moved out of the displaced copy), and a backup without the memories leaves the present
 * memory database in place. A backup from before groups restores as it always did.
 *
 * An encrypted backup (Settings → Backups → Password protection; docs/backup-encryption.md) is opened with the
 * password it was made with, typed at a hidden prompt or written to standard input (--password-stdin), never given
 * as an argument or an environment variable. A wrong password stops before anything is written. The archive inside
 * is read through the decrypting reader: no plaintext copy of it is made.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Streaming reader: AdmZip buffered the whole archive, which Node refuses past
// 2 GiB, so large data homes could be backed up but never restored.
import {
  extractZipEntry,
  openZipArchive,
  readBackupManifest,
  verifyBackupChecksums,
} from '../neural-interface/lib/backup-zip-reader.js';
import { BACKUP_ENCRYPTION_FILE, backupGroupOf, checkManifestGroups, isBackupEncryptionFile, readManifestGroups } from '../neural-interface/lib/backup-groups.js';
import { BackupEncryptionError, isEncryptedBackupFile } from '../neural-interface/lib/backup-crypto.js';
import { openEncryptedBackupSource } from '../neural-interface/lib/backup-crypto-io.js';
import { makePrivateRestoreStage, restoreStagePath, sweepRestoreStages } from '../neural-interface/lib/backup-restore-stage.js';

function pathIsInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function timestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * The password of an encrypted backup, from the person at the terminal: typed without echo, or the first line of
 * standard input when `fromStdin` (a password manager's output piped in). Never an argument, never the environment.
 */
export async function readBackupPassword({ fromStdin = false, input = process.stdin, output = process.stderr, prompt = 'Backup password: ' } = {}) {
  if (fromStdin) {
    let text = '';
    input.setEncoding('utf8');
    for await (const chunk of input) {
      text += chunk;
      if (text.length > 8192) break;
    }
    return text.split(/\r?\n/)[0];
  }
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new BackupEncryptionError('BACKUP_PASSWORD_REQUIRED', 'This backup is encrypted. Run the command in a terminal to type its password, or add --password-stdin and write the password to standard input.', { status: 401 });
  }
  output.write(prompt);
  return new Promise((resolvePassword, reject) => {
    let typed = '';
    const finish = (settle, value) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      settle(value);
    };
    function onData(chunk) {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n' || char === '\u0004') { finish(resolvePassword, typed); return; }
        if (char === '\u0003') { finish(reject, new Error('Cancelled.')); return; }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    }
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
  });
}

/** The archive opened as a ZIP: the file itself, or the ZIP inside an encrypted backup once its password opened it. */
async function openArchive(backupPath, { password, readPassword }) {
  if (!(await isEncryptedBackupFile(backupPath))) return openZipArchive(backupPath);
  const given = password ?? (typeof readPassword === 'function' ? await readPassword() : null);
  if (given == null) throw new BackupEncryptionError('BACKUP_PASSWORD_REQUIRED', 'This backup is encrypted: its password is needed to restore it.', { status: 401 });
  // This command has no server thread to keep free: it decrypts on its own.
  const source = await openEncryptedBackupSource(backupPath, { password: given, inline: true });
  return openZipArchive(backupPath, { source });
}

/** Open the archive and stream-verify every checksum before anything is extracted. */
async function parseArchive(backupPath, keys = {}) {
  const zip = await openArchive(backupPath, keys);
  try {
    const found = await readBackupManifest(zip);
    if (!found || !found.prefix) throw new Error('Invalid backup: manifest.json is missing');
    const { manifest, prefix } = found;
    if (![2, 3].includes(manifest.version)) {
      throw new Error(`Unsupported backup version: ${manifest.version}. Expected v2 or v3.`);
    }
    // An archive that records its groups holds exactly those, or nothing of it is restored.
    const problems = checkManifestGroups(manifest, zip.entries.filter(entry => !entry.isDirectory).map(entry => entry.name), prefix);
    if (problems.length) throw new Error(`Invalid backup: ${problems[0]}`);
    await verifyBackupChecksums(zip, { prefix, manifest, label: 'Invalid backup' });
    // An encrypted backup: every part of the file has now passed its check, the ones no entry reaches too.
    if (zip.encrypted) await zip.source.authenticateRest();
    return { zip, entries: zip.entries, manifest, prefix };
  } catch (error) {
    await zip.close().catch(() => {});
    throw error;
  }
}

function restoredRelativePath(entryName, prefix) {
  const rel = entryName.slice(`${prefix}/`.length);
  if (rel === 'env.bak') return '.env';
  if (rel === 'database/memory.db') return 'mcp-data/memory.db';
  // The backup-encryption key file is the installation's own: no archive brings one (backup-groups.js).
  if (isBackupEncryptionFile(basename(rel))) return null;
  if (rel.startsWith('data/') || rel.startsWith('mcp-data/')) return rel;
  return null;
}

async function writeSelectedEntries({ zip, entries, prefix, stageRoot }) {
  const selected = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.startsWith(`${prefix}/`)) continue;
    const rel = restoredRelativePath(entry.name, prefix);
    if (!rel) continue;
    const target = resolve(stageRoot, rel);
    if (!pathIsInside(target, stageRoot) || target === resolve(stageRoot)) throw new Error(`Unsafe backup path: ${entry.name}`);
    selected.push({ entry, rel, target });
  }
  for (const { entry, target } of selected) await extractZipEntry(zip, entry, target);
  return [...new Set(selected.map(item => item.rel))].sort();
}

function normalizeEnv(stageRoot, targetRoot) {
  const envPath = resolve(stageRoot, '.env');
  const values = new Map([
    ['SYNABUN_DATA_HOME', resolve(targetRoot)],
    ['MEMORY_DATA_DIR', resolve(targetRoot, 'mcp-data')],
    ['SQLITE_DB_PATH', resolve(targetRoot, 'mcp-data', 'memory.db')],
    ['DOTENV_PATH', resolve(targetRoot, '.env')],
  ]);
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const seen = new Set();
  const lines = original.split(/\r?\n/).map(line => {
    const match = line.match(/^(\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*)(.*)$/);
    if (!match || !values.has(match[2])) return line;
    seen.add(match[2]);
    return `${match[1]}${values.get(match[2])}`;
  });
  for (const [key, value] of values) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  writeFileSync(envPath, `${lines.join('\n').replace(/^\n+|\n+$/g, '')}\n`, 'utf-8');
}

function walkJson(root, current = root, result = []) {
  if (!existsSync(current)) return result;
  const stat = statSync(current);
  if (stat.isFile()) {
    if (current.endsWith('.json')) result.push(current);
    return result;
  }
  for (const name of readdirSync(current)) walkJson(root, resolve(current, name), result);
  return result;
}

/**
 * JSON that does not parse is restored exactly as it was backed up and
 * reported. The checksums already proved these bytes match the archive, so a
 * bad file here was bad in the source. One torn hook-state write
 * (data/pending-remember/*.json) used to refuse the restore of a whole data home.
 */
function findInvalidJson(stageRoot) {
  const invalid = [];
  for (const path of walkJson(stageRoot)) {
    try { JSON.parse(readFileSync(path, 'utf-8')); }
    catch (error) { invalid.push({ path: relative(stageRoot, path), error: error.message }); }
  }
  return invalid;
}

/**
 * What of the present data home a backup that leaves groups out does not replace: [{ rel, group }] with `rel` the
 * path inside the data home (a top-level entry of data/ or mcp-data/, the memory database with its WAL files, the
 * .env). Empty for a backup that holds every group, and for one from before groups.
 */
export function entriesToKeep(targetRoot, manifest) {
  const contents = readManifestGroups(manifest);
  if (!contents.recorded || !contents.excluded.length || !existsSync(targetRoot)) return [];
  const left = new Set(contents.excluded);
  const keep = [];
  if (left.has('settings') && existsSync(resolve(targetRoot, '.env'))) keep.push({ rel: '.env', group: 'settings' });
  for (const dir of ['data', 'mcp-data']) {
    const root = resolve(targetRoot, dir);
    let names = [];
    try { names = readdirSync(root).sort(); } catch { /* no such folder here */ }
    for (const name of names) {
      let isDir = false;
      try { isDir = statSync(resolve(root, name)).isDirectory(); } catch { continue; }
      // The memory database lives in mcp-data/ and is archived as database/memory.db, with its WAL beside it.
      const group = dir === 'mcp-data' && /^memory\.db(?:-wal|-shm|-journal)?$/i.test(name)
        ? 'memories'
        : backupGroupOf(`${dir}/${name}${isDir ? '/.' : ''}`);
      if (group && left.has(group)) keep.push({ rel: `${dir}/${name}`, group });
    }
  }
  return keep;
}

/** Move what the backup does not contain out of the displaced data home into the restored one. Never overwrites. */
function carryOver(displacedRoot, targetRoot, keep) {
  const kept = [];
  const notKept = [];
  for (const { rel, group } of keep) {
    const from = resolve(displacedRoot, rel);
    const to = resolve(targetRoot, rel);
    try {
      if (!existsSync(from)) continue;
      if (existsSync(to)) { notKept.push({ path: rel, group, error: 'the backup holds a file of that name' }); continue; }
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      kept.push(rel);
    } catch (error) {
      notKept.push({ path: rel, group, error: error.message });
    }
  }
  return { kept, notKept };
}

function validateStage(stageRoot, { requireDatabase = true } = {}) {
  const dbPath = resolve(stageRoot, 'mcp-data', 'memory.db');
  // A backup without the memories: the present database stays (entriesToKeep), there is none to check here.
  if (!existsSync(dbPath) && !requireDatabase) return null;
  if (!existsSync(dbPath)) throw new Error('Backup does not contain database/memory.db');
  let database;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const integrityRow = database.prepare('PRAGMA integrity_check').get();
    const integrity = integrityRow?.integrity_check || integrityRow?.integrity || 'unknown';
    if (integrity !== 'ok') throw new Error(`SQLite integrity check returned: ${integrity}`);
    const memories = Number(database.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count || 0);
    let categories = null;
    try { categories = Number(database.prepare('SELECT COUNT(*) AS count FROM categories').get()?.count || 0); } catch {}
    return { integrity, memories, categories, sizeBytes: statSync(dbPath).size };
  } finally {
    try { database?.close(); } catch {}
  }
}

export async function restoreDataHomeFromBackup({
  backupPath,
  targetRoot,
  legacyRoot = null,
  apply = false,
  // An encrypted backup: its password, or a function that asks for it (called only when the backup is encrypted).
  password = null,
  readPassword = null,
  now = () => new Date(),
} = {}) {
  if (!backupPath || !targetRoot) throw new Error('backupPath and targetRoot are required');
  const backup = resolve(backupPath);
  const target = resolve(targetRoot);
  if (!existsSync(backup)) throw new Error(`Backup not found: ${backup}`);

  // A wrong password, a damaged file or a changed one stops here: nothing has been created or moved yet.
  const parsed = await parseArchive(backup, { password, readPassword });
  const createdAt = now();
  const targetName = basename(target).replace(/^\.+/, '') || 'synabun';
  const parent = dirname(target);
  // What a killed restore left: decrypted files, in a folder nobody will come back to.
  try { sweepRestoreStages(target); } catch { /* a parent folder that cannot be listed: the mkdir below says so */ }
  const stage = restoreStagePath(target);
  const displacedTarget = resolve(parent, `.${targetName}.pre-restore-${timestamp(createdAt)}`);
  let activated = false;
  let targetMoved = false;
  try {
    mkdirSync(parent, { recursive: true });
    // Private (0700): what is extracted here is the backup in plaintext, the .env and the account files included.
    makePrivateRestoreStage(stage);
    const restoredFiles = await writeSelectedEntries({ ...parsed, stageRoot: stage });
    const contents = readManifestGroups(parsed.manifest);
    const keep = entriesToKeep(target, parsed.manifest);
    // A backup without the settings keeps the present .env: its keys are carried into the stage before the four
    // path values are set, so they are never replaced by an empty file.
    const keepsEnv = keep.some(item => item.rel === '.env');
    if (keepsEnv && !existsSync(resolve(stage, '.env'))) writeFileSync(resolve(stage, '.env'), readFileSync(resolve(target, '.env')));
    normalizeEnv(stage, target);
    // Backup encryption is the installation's own setting, in no archive: the present key file is carried into the
    // restored data home, so a restore never turns encryption off. Where there is none and this backup is encrypted,
    // its key is kept (the password that just opened it), so the backups made after this restore are encrypted too.
    const encryption = { encrypted: parsed.zip.encrypted === true, keyId: parsed.zip.source?.keyId || null, key: null };
    const presentKey = resolve(target, 'data', BACKUP_ENCRYPTION_FILE);
    const stagedKey = resolve(stage, 'data', BACKUP_ENCRYPTION_FILE);
    if (existsSync(presentKey)) {
      mkdirSync(dirname(stagedKey), { recursive: true });
      writeFileSync(stagedKey, readFileSync(presentKey), { mode: 0o600 });
      encryption.key = 'kept';
    } else if (encryption.encrypted) {
      const stamp = createdAt.toISOString();
      mkdirSync(dirname(stagedKey), { recursive: true });
      writeFileSync(stagedKey, `${JSON.stringify({ version: 1, recipient: parsed.zip.source.recipientForAdoption(), createdAt: stamp, changedAt: stamp }, null, 2)}\n`, { mode: 0o600 });
      encryption.key = 'adopted';
    }
    if (encryption.key && process.platform !== 'win32') chmodSync(stagedKey, 0o600);
    const database = validateStage(stage, { requireDatabase: !contents.recorded || contents.included.includes('memories') });
    const invalidJson = findInvalidJson(stage);
    const existingManifest = existsSync(resolve(target, '.synabun-data-home.json'))
      ? JSON.parse(readFileSync(resolve(target, '.synabun-data-home.json'), 'utf-8'))
      : {};
    const acknowledgedLegacyRoots = legacyRoot ? [resolve(legacyRoot)] : [];
    const manifest = {
      version: 1,
      installationId: existingManifest.installationId || createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32),
      dataSchemaVersion: 1,
      activatedAt: createdAt.toISOString(),
      activationReason: 'verified-backup-restore',
      restoredFrom: backup,
      restoredBackupVersion: parsed.manifest.version,
      restoredBackupCreatedAt: parsed.manifest.created || parsed.manifest.createdAt || null,
      acknowledgedLegacyRoots,
    };
    writeFileSync(resolve(stage, '.synabun-data-home.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    const result = {
      applied: false,
      backupPath: backup,
      targetRoot: target,
      displacedTarget: existsSync(target) ? displacedTarget : null,
      manifest: parsed.manifest,
      database,
      invalidJson,
      restoredFiles,
      // Whether the backup was encrypted, and what became of this installation's backup encryption: 'kept' (its own
      // key file), 'adopted' (none here: the backup's key, same password), or null (no encryption either side).
      encryption,
      // What the backup holds by group, and what of the present data home it therefore leaves in place.
      contents,
      keeps: keep.filter(item => item.rel !== '.env' || !keepsEnv).map(item => item.rel).concat(keepsEnv ? ['.env'] : []),
    };
    if (!apply) return result;

    // The restored folder keeps the mode the data home had; only its time as a stage is private.
    const targetMode = existsSync(target) ? statSync(target).mode & 0o777 : 0o777 & ~process.umask();
    if (existsSync(target)) {
      renameSync(target, displacedTarget);
      targetMoved = true;
    }
    renameSync(stage, target);
    activated = true;
    if (process.platform !== 'win32') chmodSync(target, targetMode);
    // The groups the backup does not contain: moved back from the displaced copy. One that cannot be moved stays
    // there, untouched, and is named (`notKept`): nothing is ever deleted.
    const carried = targetMoved ? carryOver(displacedTarget, target, keep.filter(item => item.rel !== '.env')) : { kept: [], notKept: [] };
    return { ...result, applied: true, kept: [...(keepsEnv ? ['.env'] : []), ...carried.kept], notKept: carried.notKept };
  } catch (error) {
    if (targetMoved && !existsSync(target) && existsSync(displacedTarget)) renameSync(displacedTarget, target);
    throw error;
  } finally {
    await parsed.zip.close().catch(() => {});
    if (!activated) rmSync(stage, { recursive: true, force: true });
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await restoreDataHomeFromBackup({
      backupPath: option('--backup') || option('--from'),
      targetRoot: option('--target'),
      legacyRoot: option('--legacy-root'),
      apply: process.argv.includes('--apply'),
      readPassword: () => readBackupPassword({ fromStdin: process.argv.includes('--password-stdin') }),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
