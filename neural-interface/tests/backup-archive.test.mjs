import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

import {
  BACKUP_PREFIX,
  createVerifiedBackup,
  verifyBackupArchive,
} from '../lib/backup-service.js';

test('backup archives remain compatible with file and buffer ZIP readers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-backup-test-'));
  try {
    const dataHome = join(root, 'data-home');
    const backupDir = join(root, 'backups');
    mkdirSync(join(dataHome, 'data'), { recursive: true });
    writeFileSync(join(dataHome, '.env'), 'SAMPLE_SETTING=enabled\n');
    writeFileSync(join(dataHome, 'data', 'settings.json'), '{"theme":"dark"}\n');

    const result = await createVerifiedBackup({
      dataHome,
      folderPath: backupDir,
      kind: 'manual',
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    });

    const manifest = verifyBackupArchive(result.path);
    assert.equal(manifest.verified, true);
    assert.ok(manifest.checksums['env.bak']);
    assert.ok(manifest.checksums['data/settings.json']);

    const zipFromBuffer = new AdmZip(readFileSync(result.path));
    const settings = zipFromBuffer.getEntry(`${BACKUP_PREFIX}/data/settings.json`);
    assert.equal(settings?.getData().toString('utf8'), '{"theme":"dark"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
