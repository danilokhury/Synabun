import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import AdmZip from 'adm-zip';

import {
  BACKUP_PREFIX,
  cleanupStaleBackupArtifacts,
  createVerifiedBackup,
  verifyBackupArchive,
} from '../lib/backup-service.js';

function makeDataHome() {
  const root = mkdtempSync(join(tmpdir(), 'synabun-backup-scope-'));
  mkdirSync(resolve(root, 'data'), { recursive: true });
  mkdirSync(resolve(root, 'mcp-data'), { recursive: true });
  return root;
}

test('re-downloadable bulk media is excluded from the snapshot', async () => {
  const dataHome = makeDataHome();
  const folderPath = resolve(dataHome, 'backups');
  try {
    // Kept: ordinary user state.
    writeFileSync(resolve(dataHome, 'data', 'settings.json'), '{"keep":true}');
    mkdirSync(resolve(dataHome, 'data', 'images'), { recursive: true });
    writeFileSync(resolve(dataHome, 'data', 'images', 'art.png'), Buffer.alloc(2048, 7));

    // Dropped: the YouTube pipeline cache that made snapshots read as a hang.
    mkdirSync(resolve(dataHome, 'data', 'youtube-downloads'), { recursive: true });
    writeFileSync(resolve(dataHome, 'data', 'youtube-downloads', 'clip.mp4'), Buffer.alloc(4096, 1));
    mkdirSync(resolve(dataHome, 'data', 'youtube-downloads', 'nested'), { recursive: true });
    writeFileSync(resolve(dataHome, 'data', 'youtube-downloads', 'nested', 'deep.mp4'), Buffer.alloc(4096, 2));

    const snapshot = await createVerifiedBackup({ dataHome, folderPath, kind: 'pre-update' });
    const archived = verifyBackupArchive(snapshot.path).files;

    assert.ok(archived.includes('data/settings.json'), 'user state must be protected');
    assert.ok(archived.includes('data/images/art.png'), 'generated images must be protected');
    assert.ok(
      !archived.some(path => path.startsWith('data/youtube-downloads/')),
      'youtube-downloads must not be archived',
    );
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
  }
});

test('already-compressed payloads are stored, not deflated', async () => {
  const dataHome = makeDataHome();
  const folderPath = resolve(dataHome, 'backups');
  try {
    // Incompressible in principle, but random-free so DEFLATE would shrink it
    // dramatically — proving the entry was stored rather than compressed.
    writeFileSync(resolve(dataHome, 'data', 'poster.png'), Buffer.alloc(64 * 1024, 9));
    writeFileSync(resolve(dataHome, 'data', 'notes.json'), JSON.stringify({ pad: 'x'.repeat(64 * 1024) }));

    const snapshot = await createVerifiedBackup({ dataHome, folderPath, kind: 'pre-update' });
    const zip = new AdmZip(snapshot.path);
    const entryFor = name => zip.getEntry(`${BACKUP_PREFIX}/${name}`);

    const png = entryFor('data/poster.png');
    assert.equal(png.header.method, 0, '.png must use the STORE method');
    assert.equal(png.header.compressedSize, png.header.size, 'stored entries keep their original size');

    const json = entryFor('data/notes.json');
    assert.notEqual(json.header.method, 0, 'compressible text must still be deflated');
    assert.ok(json.header.compressedSize < json.header.size, 'deflated entries must shrink');
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
  }
});

test('progress is reported for every long-running phase', async () => {
  const dataHome = makeDataHome();
  const folderPath = resolve(dataHome, 'backups');
  try {
    writeFileSync(resolve(dataHome, 'data', 'settings.json'), '{"keep":true}');
    const phases = [];
    await createVerifiedBackup({
      dataHome,
      folderPath,
      kind: 'pre-update',
      onProgress: event => phases.push(event.phase),
    });

    for (const phase of ['collect', 'checksum', 'archive', 'verify']) {
      assert.ok(phases.includes(phase), `expected a ${phase} progress event`);
    }
    assert.deepEqual(phases, ['collect', 'checksum', 'archive', 'verify'], 'phases must report in order');
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
  }
});

test('artifacts orphaned by an interrupted run are reclaimed', async () => {
  const dataHome = makeDataHome();
  const folderPath = resolve(dataHome, 'backups');
  try {
    mkdirSync(folderPath, { recursive: true });
    // Exactly what a Ctrl-C'd run leaves behind: it never reaches its finally.
    const orphanArchive = resolve(folderPath, 'synabun-pre-update-2026-01-01T00-00-00-000Z.zip.4242.tmp');
    const orphanDb = resolve(folderPath, '.synabun-db-4242-1700000000000.tmp');
    const orphanStage = resolve(folderPath, '.synabun-files-4242-abc');
    const liveArchive = resolve(folderPath, 'synabun-pre-update-2026-01-02T00-00-00-000Z.zip');
    writeFileSync(orphanArchive, Buffer.alloc(1024));
    writeFileSync(orphanDb, Buffer.alloc(1024));
    mkdirSync(orphanStage, { recursive: true });
    writeFileSync(resolve(orphanStage, '0'), Buffer.alloc(16));
    writeFileSync(liveArchive, Buffer.alloc(1024));

    // Anything younger than the age floor belongs to a run that may still be live.
    assert.deepEqual(cleanupStaleBackupArtifacts(folderPath), [], 'fresh temps must be left alone');

    const removed = cleanupStaleBackupArtifacts(folderPath, { now: () => Date.now() + 7200_000 }).sort();
    assert.deepEqual(removed, [
      '.synabun-db-4242-1700000000000.tmp',
      '.synabun-files-4242-abc',
      'synabun-pre-update-2026-01-01T00-00-00-000Z.zip.4242.tmp',
    ]);
    assert.ok(existsSync(liveArchive), 'published snapshots must never be reclaimed');
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
  }
});

test('a backup still succeeds when no progress callback is supplied', async () => {
  const dataHome = makeDataHome();
  const folderPath = resolve(dataHome, 'backups');
  try {
    writeFileSync(resolve(dataHome, 'data', 'settings.json'), '{"keep":true}');
    const snapshot = await createVerifiedBackup({ dataHome, folderPath, kind: 'pre-update' });
    assert.ok(verifyBackupArchive(snapshot.path).files.includes('data/settings.json'));
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
  }
});
