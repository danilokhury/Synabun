import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import archiver from 'archiver';

import { BACKUP_PREFIX, verifyBackupArchive } from '../lib/backup-service.js';
import { hashZipEntry, openZipArchive, readBackupManifest, readZipEntry } from '../lib/backup-zip-reader.js';
import { planRestoreWrites, restoreTargetFor } from '../lib/system-restore.js';

const sha = value => createHash('sha256').update(value).digest('hex');

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-zip-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** entries: [{ name, data, store?, stream? }] */
async function writeZip(path, entries, options = {}) {
  await new Promise((resolveWrite, reject) => {
    const output = createWriteStream(path);
    const archive = archiver('zip', options);
    output.on('close', resolveWrite);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) {
      // A stream source has no known size up front, so archiver writes a data
      // descriptor after it — the case a local-header-only reader gets wrong.
      const source = entry.stream ? Readable.from([entry.data]) : entry.data;
      archive.append(source, { name: entry.name, store: entry.store === true });
    }
    archive.finalize().catch(reject);
  });
}

async function writeBackup(path, files, { checksums } = {}) {
  const manifest = {
    version: 3,
    files: Object.keys(files),
    checksums: checksums || Object.fromEntries(Object.entries(files).map(([name, data]) => [name, `sha256:${sha(data)}`])),
  };
  await writeZip(path, [
    ...Object.entries(files).map(([name, data]) => ({ name: `${BACKUP_PREFIX}/${name}`, data })),
    { name: `${BACKUP_PREFIX}/manifest.json`, data: JSON.stringify(manifest) },
  ]);
  return manifest;
}

test('reads stored, deflated, data-descriptor and empty entries', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'mixed.zip');
  const text = Buffer.from('hello world '.repeat(4000));
  const media = Buffer.alloc(8192, 7);
  await writeZip(path, [
    { name: 'p/text.json', data: text },
    { name: 'p/media.png', data: media, store: true },
    { name: 'p/streamed.txt', data: text, stream: true },
    { name: 'p/empty.txt', data: Buffer.alloc(0) },
  ]);

  const zip = await openZipArchive(path);
  t.after(() => zip.close());
  assert.equal(zip.getEntry('p/text.json').method, 8);
  assert.equal(zip.getEntry('p/media.png').method, 0);
  assert.ok(zip.getEntry('p/streamed.txt').flags & 0x8, 'streamed entries carry a data descriptor');
  assert.deepEqual(await readZipEntry(zip, zip.getEntry('p/text.json')), text);
  assert.deepEqual(await readZipEntry(zip, zip.getEntry('p/media.png')), media);
  assert.equal(await hashZipEntry(zip, zip.getEntry('p/streamed.txt')), sha(text));
  assert.equal(await hashZipEntry(zip, zip.getEntry('p/empty.txt')), sha(Buffer.alloc(0)));
});

test('reads ZIP64 end-of-central-directory records and extra fields', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'zip64.zip');
  const payload = Buffer.from('x'.repeat(10_000));
  await writeZip(path, [
    { name: 'p/a.txt', data: payload },
    { name: 'p/b.png', data: payload, store: true },
  ], { forceZip64: true });
  // Prove the fixture really exercises the ZIP64 path.
  const bytes = readFileSync(path);
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'ZIP64 EOCD record present');
  assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), 'ZIP64 locator present');

  const zip = await openZipArchive(path);
  t.after(() => zip.close());
  assert.equal(zip.entries.length, 2);
  for (const entry of zip.entries) {
    assert.equal(entry.uncompressedSize, payload.length);
    assert.equal(await hashZipEntry(zip, entry), sha(payload));
  }
});

test('a corrupted entry fails its CRC instead of hashing garbage', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'corrupt.zip');
  const payload = Buffer.alloc(4096, 0x41);
  await writeZip(path, [{ name: 'p/data.png', data: payload, store: true }]);
  const bytes = readFileSync(path);
  const at = bytes.indexOf(payload.subarray(0, 64));
  bytes[at + 100] ^= 0xff;
  writeFileSync(path, bytes);

  const zip = await openZipArchive(path);
  t.after(() => zip.close());
  await assert.rejects(hashZipEntry(zip, zip.getEntry('p/data.png')), /CRC mismatch/);
});

test('a file that is not a ZIP is rejected', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'not.zip');
  writeFileSync(path, 'definitely not a zip archive');
  await assert.rejects(openZipArchive(path), /end of central directory not found/);
});

test('the streaming verifier catches a checksum mismatch', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'mismatch.zip');
  await writeBackup(path, { 'data/settings.json': '{"real":true}' }, {
    checksums: { 'data/settings.json': `sha256:${sha('{"edited":true}')}` },
  });
  await assert.rejects(verifyBackupArchive(path), /Backup verification failed: checksum mismatch for data\/settings\.json/);
});

test('the streaming verifier catches a missing entry', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'missing.zip');
  await writeBackup(path, { 'data/settings.json': '{}' }, {
    checksums: {
      'data/settings.json': `sha256:${sha('{}')}`,
      'database/memory.db': `sha256:${sha('db')}`,
    },
  });
  await assert.rejects(verifyBackupArchive(path), /Backup verification failed: database\/memory\.db is missing/);
});

test('the streaming verifier requires a manifest and accepts a sound archive', async (t) => {
  const dir = tempDir(t);
  const noManifest = join(dir, 'no-manifest.zip');
  await writeZip(noManifest, [{ name: `${BACKUP_PREFIX}/data/a.json`, data: '{}' }]);
  await assert.rejects(verifyBackupArchive(noManifest), /manifest is missing/);

  const sound = join(dir, 'sound.zip');
  const written = await writeBackup(sound, { 'data/a.json': '{"a":1}', 'env.bak': 'X=1\n' });
  assert.deepEqual((await verifyBackupArchive(sound)).checksums, written.checksums);

  const zip = await openZipArchive(sound);
  t.after(() => zip.close());
  const found = await readBackupManifest(zip);
  assert.equal(found.prefix, BACKUP_PREFIX);
});

test('a backed-up manifest.json written before the real manifest is not mistaken for it', async (t) => {
  // A synced skill's own manifest.json is archived as
  // global-skills/…/manifest.json; here it precedes the backup manifest.
  const dir = tempDir(t);
  const path = join(dir, 'nested-manifest.zip');
  const written = await writeBackup(path, {
    'global-skills/synced/abc/manifest.json': '{"name":"a skill"}',
    'data/a.json': '{"a":1}',
  });
  assert.deepEqual((await verifyBackupArchive(path)).checksums, written.checksums);

  const zip = await openZipArchive(path);
  t.after(() => zip.close());
  const found = await readBackupManifest(zip);
  assert.equal(found.prefix, BACKUP_PREFIX);
  assert.equal(found.manifest.version, 3);
});

test('restore targets stay inside their roots; zip-slip entries are refused', (t) => {
  const root = tempDir(t);
  const roots = {
    data: resolve(root, 'home', 'data'),
    mcpData: resolve(root, 'home', 'mcp-data'),
    globalSkills: resolve(root, 'claude', 'skills'),
    globalAgents: resolve(root, 'claude', 'agents'),
    bundledSkills: resolve(root, 'pkg', 'skills'),
    skins: resolve(root, 'pkg', 'skins'),
    claudeSettings: resolve(root, 'claude', 'settings.json'),
  };
  assert.deepEqual(restoreTargetFor('data/ui-state.json', roots), { target: resolve(roots.data, 'ui-state.json') });
  assert.deepEqual(restoreTargetFor('mcp-data/custom-categories.json', roots), { target: resolve(roots.mcpData, 'custom-categories.json') });
  assert.deepEqual(restoreTargetFor('skins/dark/skin.css', roots), { target: resolve(roots.skins, 'dark', 'skin.css') });
  assert.deepEqual(restoreTargetFor('claude-settings.json', roots), { target: roots.claudeSettings });
  assert.equal(restoreTargetFor('database/memory.db', roots), null);
  assert.equal(restoreTargetFor('data/', roots), null);

  for (const rel of [
    'data/../../escaped.json',
    'mcp-data/../data/x.json',
    'global-skills/../../../etc/passwd',
    'skins/../server.js',
    'bundled-skills/..',
    'data//etc/passwd',
  ]) {
    assert.deepEqual(restoreTargetFor(rel, roots), { unsafe: true }, rel);
  }

  // The whole archive is refused before anything is planned for writing.
  const zip = {
    entries: [
      { name: `${BACKUP_PREFIX}/data/ok.json`, isDirectory: false },
      { name: `${BACKUP_PREFIX}/data/../../../evil.sh`, isDirectory: false },
      { name: `${BACKUP_PREFIX}/data/`, isDirectory: true },
      { name: 'outside/data/x.json', isDirectory: false },
    ],
  };
  const plan = planRestoreWrites(zip, BACKUP_PREFIX, roots);
  assert.deepEqual(plan.unsafe, [`${BACKUP_PREFIX}/data/../../../evil.sh`]);
  assert.deepEqual(plan.writes.map(write => write.rel), ['data/ok.json']);
});
