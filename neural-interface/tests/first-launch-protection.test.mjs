// The verified snapshot taken before a new version first runs
// (lib/first-launch-protection.js) and the launch gate in the launcher: when
// the snapshot cannot be created, SynaBun does not start. A fresh install and a
// launch of the version that already ran need no snapshot and launch as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  LAUNCHER_STOP_MARKER,
  SNAPSHOT_FAILED_EXIT_CODE,
  describeSnapshotFailure,
  launcherLogPath,
  protectFirstLaunchAfterUpdate,
  recordLauncherFailure,
} from '../../lib/first-launch-protection.js';
import { DATA_HOME_MANIFEST, dataHomeHasState } from '../../lib/data-home-migration.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LAUNCHER = join(PACKAGE_ROOT, 'setup.js');
const LAUNCHER_SOURCE = readFileSync(LAUNCHER, 'utf8');
const PKG = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const PREVIOUS = '2026.9.5';

const temps = [];
test.after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-first-launch-'));
  temps.push(dir);
  return dir;
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
/** A data home with user state, last run by `lastAppVersion` (null: no manifest). */
function dataHomeWithState({ lastAppVersion = PREVIOUS, handoff = null } = {}) {
  const dataHome = join(tempDir(), 'data-home');
  writeJson(join(dataHome, 'data', 'ui-state.json'), { theme: 'dark' });
  writeFileSync(join(dataHome, '.env'), 'SETUP_COMPLETE=true\n', 'utf8');
  if (lastAppVersion) writeJson(join(dataHome, DATA_HOME_MANIFEST), { version: 1, installationId: 'install-1', lastAppVersion });
  if (handoff) writeJson(join(dataHome, 'data', 'update-handoff.json'), handoff);
  return dataHome;
}
const manifestOf = dataHome => JSON.parse(readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8'));
const handoffOf = dataHome => JSON.parse(readFileSync(join(dataHome, 'data', 'update-handoff.json'), 'utf8'));
/**
 * A stand-in backup service that records its calls. `archive` is what
 * verification finds at a snapshot path: a manifest, or an Error to throw.
 */
function backupService({ fail = null, failRetention = null, archive = { kind: 'pre-update' } } = {}) {
  const calls = { loaded: 0, backups: [], retention: [], verified: [] };
  const load = async () => {
    calls.loaded++;
    return {
      createVerifiedBackup: async (options) => {
        calls.backups.push(options);
        if (fail) throw fail;
        const path = join(options.folderPath, 'synabun-auto-backup-pre-update.zip');
        mkdirSync(options.folderPath, { recursive: true });
        writeFileSync(path, 'zip');
        return { path, name: 'synabun-auto-backup-pre-update.zip' };
      },
      verifyBackupArchive: async (path) => {
        calls.verified.push(path);
        if (archive instanceof Error) throw archive;
        return archive;
      },
      applyBackupRetention: (options) => {
        calls.retention.push(options);
        if (failRetention) throw failRetention;
      },
    };
  };
  return { calls, load };
}
/** A data home an in-app update left behind: the handoff and the file it names. */
function handedOver({ status = 'installed', target = '2.0.0', lastAppVersion = PREVIOUS, snapshot = 'zip' } = {}) {
  const dataHome = dataHomeWithState({ lastAppVersion });
  const snapshotPath = join(dataHome, 'backups', 'updates', 'from-updater.zip');
  if (snapshot != null) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, snapshot);
  }
  writeJson(join(dataHome, 'data', 'update-handoff.json'), { version: 1, status, current: PREVIOUS, target, snapshotPath });
  return { dataHome, snapshotPath };
}

// ── the decision ──

test('a fresh install with no data home needs no snapshot and creates nothing', async () => {
  const dataHome = join(tempDir(), 'never-created');
  const service = backupService();
  const result = await protectFirstLaunchAfterUpdate({ dataHome, version: '2.0.0', loadBackupService: service.load });
  assert.deepEqual(result, { status: 'not-due', reason: 'no-state' });
  assert.equal(service.calls.loaded, 0, 'the backup service is not even loaded');
  assert.equal(existsSync(dataHome), false);
});

test('a data home with folders but no user state needs no snapshot', async () => {
  const dataHome = join(tempDir(), 'data-home');
  mkdirSync(join(dataHome, 'data', 'images'), { recursive: true });
  mkdirSync(join(dataHome, 'mcp-data'), { recursive: true });
  const service = backupService();
  const result = await protectFirstLaunchAfterUpdate({ dataHome, version: '2.0.0', loadBackupService: service.load });
  assert.deepEqual(result, { status: 'not-due', reason: 'no-state' });
  assert.equal(service.calls.loaded, 0);
  assert.equal(existsSync(join(dataHome, DATA_HOME_MANIFEST)), false);
});

test('a launch of the version that already ran needs no snapshot and changes nothing', async () => {
  const dataHome = dataHomeWithState({ lastAppVersion: '2.0.0' });
  const before = readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8');
  const service = backupService({ fail: new Error('must not be called') });
  const result = await protectFirstLaunchAfterUpdate({ dataHome, version: '2.0.0', loadBackupService: service.load });
  assert.deepEqual(result, { status: 'not-due', reason: 'current-version' });
  assert.equal(service.calls.loaded, 0);
  assert.equal(readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8'), before);
  assert.equal(existsSync(join(dataHome, 'backups')), false);
});

test('the first launch of a new version takes the snapshot and records it', async () => {
  const dataHome = dataHomeWithState();
  const service = backupService();
  const logged = [];
  const result = await protectFirstLaunchAfterUpdate({
    dataHome, version: '2.0.0', loadBackupService: service.load,
    log: { info: m => logged.push(m), ok: m => logged.push(m), warn: m => logged.push(`WARN ${m}`) },
  });
  const folder = join(dataHome, 'backups', 'updates');
  assert.deepEqual(result, { status: 'protected', snapshotPath: join(folder, 'synabun-auto-backup-pre-update.zip'), created: true, recorded: true });
  assert.equal(service.calls.backups.length, 1);
  const options = service.calls.backups[0];
  assert.equal(options.dataHome, dataHome);
  assert.equal(options.folderPath, folder);
  assert.equal(options.databasePath, join(dataHome, 'mcp-data', 'memory.db'));
  assert.equal(options.kind, 'pre-update');
  assert.equal(options.appVersion, PREVIOUS, 'the snapshot is labelled with the version that wrote the data');
  assert.deepEqual(service.calls.retention, [{ folderPath: folder }]);
  const manifest = manifestOf(dataHome);
  assert.equal(manifest.lastAppVersion, '2.0.0');
  assert.equal(manifest.lastUpgradeSnapshot, result.snapshotPath);
  assert.equal(manifest.installationId, 'install-1', 'the rest of the manifest is kept');
  assert.ok(logged.some(m => m.includes('Protecting user state before first launch of v2.0.0')));
  assert.equal(logged.some(m => m.startsWith('WARN')), false);
});

test('a data home that predates the manifest is protected too', async () => {
  const dataHome = dataHomeWithState({ lastAppVersion: null });
  const service = backupService();
  const result = await protectFirstLaunchAfterUpdate({ dataHome, version: '2.0.0', loadBackupService: service.load });
  assert.equal(result.status, 'protected');
  assert.equal(service.calls.backups[0].appVersion, null);
  assert.equal(manifestOf(dataHome).lastAppVersion, '2.0.0');
});

test('a snapshot that cannot be created is a failure, and nothing is recorded as protected', async () => {
  const dataHome = dataHomeWithState();
  const manifestBefore = readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8');
  const stateBefore = readFileSync(join(dataHome, 'data', 'ui-state.json'), 'utf8');
  const cause = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const service = backupService({ fail: cause });
  const result = await protectFirstLaunchAfterUpdate({ dataHome, version: '2.0.0', loadBackupService: service.load });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, cause);
  assert.equal(result.previousVersion, PREVIOUS);
  assert.equal(result.backupFolder, join(dataHome, 'backups', 'updates'));
  assert.equal(service.calls.retention.length, 0);
  assert.equal(readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8'), manifestBefore, 'the manifest still names the old version, so the next launch tries again');
  assert.equal(readFileSync(join(dataHome, 'data', 'ui-state.json'), 'utf8'), stateBefore);
});

test('a backup service that cannot be loaded is a failure, not a launch', async () => {
  const dataHome = dataHomeWithState();
  const result = await protectFirstLaunchAfterUpdate({
    dataHome, version: '2.0.0',
    loadBackupService: async () => { throw new Error("Cannot find package 'archiver'"); },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /archiver/);
});

test('housekeeping and bookkeeping failures after a verified snapshot do not stop the launch', async () => {
  // Pruning older snapshots fails: the new one is still verified and recorded.
  const pruned = dataHomeWithState();
  const warnings = [];
  const pruneService = backupService({ failRetention: new Error('EPERM: unlink') });
  const pruneResult = await protectFirstLaunchAfterUpdate({ dataHome: pruned, version: '2.0.0', loadBackupService: pruneService.load, log: { warn: m => warnings.push(m) } });
  assert.equal(pruneResult.status, 'protected');
  assert.equal(pruneResult.recorded, true);
  assert.equal(manifestOf(pruned).lastAppVersion, '2.0.0');
  assert.match(warnings.join('\n'), /Could not prune older upgrade snapshots: EPERM: unlink/);

  // The manifest cannot be written (a directory sits at its path): the snapshot is safe, the launch goes on.
  const unrecorded = dataHomeWithState({ lastAppVersion: null });
  mkdirSync(join(unrecorded, DATA_HOME_MANIFEST));
  const recordWarnings = [];
  const result = await protectFirstLaunchAfterUpdate({ dataHome: unrecorded, version: '2.0.0', loadBackupService: backupService().load, log: { warn: m => recordWarnings.push(m) } });
  assert.equal(result.status, 'protected');
  assert.equal(result.recorded, false);
  assert.ok(existsSync(result.snapshotPath));
  assert.match(recordWarnings.join('\n'), /The upgrade snapshot is safe at .* but recording it failed/);
});

// ── the snapshot an in-app update hands over ──

test('the updater\'s snapshot is reused when it is for the version being launched and passes verification', async () => {
  const { dataHome, snapshotPath } = handedOver();
  const service = backupService({ fail: new Error('must not be called') });
  const result = await protectFirstLaunchAfterUpdate({ dataHome, version: '2.0.0', loadBackupService: service.load });
  assert.deepEqual(result, { status: 'protected', snapshotPath, created: false, recorded: true });
  assert.deepEqual(service.calls.verified, [snapshotPath], 'the archive was verified, not just found');
  assert.equal(service.calls.backups.length, 0);
  assert.equal(handoffOf(dataHome).status, 'verified');
  assert.equal(handoffOf(dataHome).launchedVersion, '2.0.0');
  assert.equal(handoffOf(dataHome).snapshotReused, true);
  assert.equal(manifestOf(dataHome).lastAppVersion, '2.0.0');
  assert.equal(manifestOf(dataHome).lastUpgradeSnapshot, snapshotPath);
});

test('a handoff that does not prove a snapshot for this launch is not trusted: a fresh one is taken', async () => {
  const cases = [
    // [why, the data home, the stand-in service, whether verification is even asked]
    ['prepared, never recorded as installed', handedOver({ status: 'prepared' }), backupService(), false],
    ['installed, but for another version', handedOver({ target: '2.0.1' }), backupService(), false],
    ['installed, snapshot file gone', handedOver({ snapshot: null }), backupService(), false],
    ['installed, file is not a valid archive', handedOver({ snapshot: 'not a zip' }), backupService({ archive: new Error('End of central directory record signature not found') }), true],
    ['installed, archive of another kind', handedOver(), backupService({ archive: { kind: 'scheduled' } }), true],
    ['installed, archive without a readable manifest', handedOver(), backupService({ archive: null }), true],
  ];
  for (const [why, { dataHome, snapshotPath }, service, verificationAsked] of cases) {
    const logged = [];
    const result = await protectFirstLaunchAfterUpdate({ dataHome, version: '2.0.0', loadBackupService: service.load, log: { info: m => logged.push(m) } });
    assert.equal(result.status, 'protected', why);
    assert.equal(result.created, true, `${why}: a fresh snapshot was taken`);
    assert.notEqual(result.snapshotPath, snapshotPath, why);
    assert.equal(service.calls.backups.length, 1, why);
    assert.deepEqual(service.calls.verified, verificationAsked ? [snapshotPath] : [], why);
    assert.equal(manifestOf(dataHome).lastUpgradeSnapshot, result.snapshotPath, why);
    const closed = handoffOf(dataHome);
    assert.equal(closed.status, 'verified', `${why}: the handoff is closed`);
    assert.equal(closed.snapshotReused, false, why);
    assert.equal(closed.snapshotPath, result.snapshotPath, why);
    assert.ok(logged.some(m => m.startsWith("The updater's snapshot is not used: ")), why);
  }
});

test('a prepared handoff for another version with a file that is not an archive protects nothing', async () => {
  // Prepared for 2.0.1 (its updater never ran), a file exists at the snapshot path, and 2.0.2 is launched.
  const first = handedOver({ status: 'prepared', target: '2.0.1', snapshot: 'not a zip' });
  const service = backupService({ archive: new Error('not an archive') });
  const result = await protectFirstLaunchAfterUpdate({ dataHome: first.dataHome, version: '2.0.2', loadBackupService: service.load });
  assert.equal(result.status, 'protected');
  assert.equal(result.created, true, '2.0.2 is recorded as protected only by a snapshot taken now');
  assert.notEqual(result.snapshotPath, first.snapshotPath);
  assert.equal(manifestOf(first.dataHome).lastAppVersion, '2.0.2');
  assert.equal(manifestOf(first.dataHome).lastUpgradeSnapshot, result.snapshotPath);

  // The same state when that snapshot cannot be taken: the launch stops and nothing is recorded.
  const second = handedOver({ status: 'prepared', target: '2.0.1', snapshot: 'not a zip' });
  const failing = backupService({ fail: new Error('ENOSPC: no space left on device') });
  const stopped = await protectFirstLaunchAfterUpdate({ dataHome: second.dataHome, version: '2.0.2', loadBackupService: failing.load });
  assert.equal(stopped.status, 'failed');
  assert.equal(manifestOf(second.dataHome).lastAppVersion, PREVIOUS);
  assert.equal(handoffOf(second.dataHome).status, 'prepared', 'the handoff is left open');
});

test('when the handed-over snapshot is rejected and a new one cannot be taken, the launch stops', async () => {
  const enospc = () => new Error('ENOSPC: no space left on device');
  for (const [why, home, service] of [
    ['wrong version', handedOver({ target: '2.0.1' }), backupService({ fail: enospc() })],
    ['file gone', handedOver({ snapshot: null }), backupService({ fail: enospc() })],
    ['invalid archive', handedOver({ snapshot: 'not a zip' }), backupService({ fail: enospc(), archive: new Error('not an archive') })],
    ['backup service cannot be loaded', handedOver(), { load: async () => { throw new Error("Cannot find package 'archiver'"); } }],
  ]) {
    const result = await protectFirstLaunchAfterUpdate({ dataHome: home.dataHome, version: '2.0.0', loadBackupService: service.load });
    assert.equal(result.status, 'failed', why);
    assert.equal(result.previousVersion, PREVIOUS, `${why}: the handoff names the version to go back to`);
    assert.equal(manifestOf(home.dataHome).lastAppVersion, PREVIOUS, why);
    assert.equal(handoffOf(home.dataHome).status, 'installed', `${why}: the handoff is left open`);
  }

  // The manifest already names the version being launched: the one to go back to is the handoff's.
  const relaunched = handedOver({ lastAppVersion: '2.0.0', snapshot: null });
  const relaunchedFailure = await protectFirstLaunchAfterUpdate({ dataHome: relaunched.dataHome, version: '2.0.0', loadBackupService: backupService({ fail: enospc() }).load });
  assert.equal(relaunchedFailure.status, 'failed');
  assert.equal(relaunchedFailure.previousVersion, PREVIOUS);

  // No recorded previous version at all: none is invented.
  const unrecorded = dataHomeWithState({ lastAppVersion: null });
  const unrecordedFailure = await protectFirstLaunchAfterUpdate({ dataHome: unrecorded, version: '2.0.0', loadBackupService: backupService({ fail: enospc() }).load });
  assert.equal(unrecordedFailure.status, 'failed');
  assert.equal(unrecordedFailure.previousVersion, null);
});

test('the real backup service: a real pre-update archive is reused, anything else is replaced', async () => {
  const { createVerifiedBackup } = await import('../lib/backup-service.js');
  const handOver = (dataHome, snapshotPath) => writeJson(join(dataHome, 'data', 'update-handoff.json'), { version: 1, status: 'installed', current: PREVIOUS, target: '2.0.0', snapshotPath });

  // What the in-app updater leaves: a verified pre-update archive.
  const good = dataHomeWithState();
  const archive = await createVerifiedBackup({ dataHome: good, folderPath: join(good, 'backups', 'updates'), kind: 'pre-update', appVersion: PREVIOUS });
  handOver(good, archive.path);
  const reused = await protectFirstLaunchAfterUpdate({ dataHome: good, version: '2.0.0' });
  assert.deepEqual(reused, { status: 'protected', snapshotPath: archive.path, created: false, recorded: true });

  // A file that only exists.
  const bogus = dataHomeWithState();
  const bogusPath = join(tempDir(), 'from-updater.zip');
  writeFileSync(bogusPath, 'this is not a zip archive');
  handOver(bogus, bogusPath);
  const replaced = await protectFirstLaunchAfterUpdate({ dataHome: bogus, version: '2.0.0' });
  assert.equal(replaced.status, 'protected');
  assert.equal(replaced.created, true);
  assert.notEqual(replaced.snapshotPath, bogusPath);
  assert.ok(existsSync(replaced.snapshotPath));

  // A real, valid archive that is not a pre-update snapshot.
  const scheduled = dataHomeWithState();
  const other = await createVerifiedBackup({ dataHome: scheduled, folderPath: join(tempDir(), 'scheduled'), kind: 'scheduled' });
  handOver(scheduled, other.path);
  const notReused = await protectFirstLaunchAfterUpdate({ dataHome: scheduled, version: '2.0.0' });
  assert.equal(notReused.created, true);
  assert.notEqual(notReused.snapshotPath, other.path);
});

// ── what the user is told, and where it is kept ──

test('the launcher stop record goes to the server stderr log, is not user state, and creates no data home', () => {
  const dataHome = dataHomeWithState();
  const path = recordLauncherFailure({ dataHome, exitCode: 3, headline: 'SynaBun v2.0.0 did not start: reason.', lines: ['What failed: x', 'Data home: y'], now: () => new Date('2026-10-05T10:00:00.000Z') });
  assert.equal(path, launcherLogPath(dataHome));
  assert.equal(path, join(dataHome, 'data', 'server-stderr.log'));
  assert.equal(readFileSync(path, 'utf8'), `\n${LAUNCHER_STOP_MARKER}2026-10-05T10:00:00.000Z (pid ${process.pid}, exit 3) =====\nSynaBun v2.0.0 did not start: reason.\nWhat failed: x\nData home: y\n`);
  // It appends: the server's own stderr shares the file.
  recordLauncherFailure({ dataHome, exitCode: 1, headline: 'SynaBun did not start: other.' });
  const text = readFileSync(path, 'utf8');
  assert.equal(text.split(LAUNCHER_STOP_MARKER).length - 1, 2);
  assert.ok(text.endsWith('SynaBun did not start: other.\n'));

  // The record is a runtime file: it never turns an empty data home into one with state.
  const empty = join(tempDir(), 'empty-home');
  mkdirSync(join(empty, 'data'), { recursive: true });
  assert.equal(recordLauncherFailure({ dataHome: empty, exitCode: 3, headline: 'h' }), launcherLogPath(empty));
  assert.equal(dataHomeHasState(empty), false);

  // No data folder: nothing is written and nothing is created.
  const missing = join(tempDir(), 'never-created');
  assert.equal(recordLauncherFailure({ dataHome: missing, exitCode: 3, headline: 'h' }), null);
  assert.equal(existsSync(missing), false);
  assert.equal(recordLauncherFailure({ exitCode: 3, headline: 'h' }), null);

  // updater.mjs is staged on its own and cannot import the constant: it must spell the same marker.
  assert.ok(readFileSync(join(PACKAGE_ROOT, 'updater.mjs'), 'utf8').includes(`const LAUNCHER_STOP_MARKER = '${LAUNCHER_STOP_MARKER}';`));
  assert.match(LAUNCHER_SOURCE, /recordLauncherFailure\(\{ dataHome: DATA_HOME, exitCode: SNAPSHOT_FAILED_EXIT_CODE, \.\.\.failure \}\)/);
});

test('the failure message says what failed, what state the data is in, where it is and what to do', () => {
  const dataHome = resolve(tmpdir(), 'home', 'user', '.synabun');
  const { headline, lines } = describeSnapshotFailure({
    error: new Error('ENOSPC: no space left on device, write'), dataHome, version: '2.0.0', previousVersion: PREVIOUS, backupFolder: join(dataHome, 'backups', 'updates'),
  });
  assert.match(headline, /SynaBun v2\.0\.0 did not start/);
  assert.match(headline, /snapshot .* could not be created/);
  assert.doesNotMatch(headline, /new version/, 'true for a data home whose previous version is unknown, too');
  const text = lines.join('\n');
  assert.match(text, /What failed: ENOSPC: no space left on device, write/);
  // Only what holds for the whole launch: an earlier step may have copied legacy data in.
  assert.match(text, /The server was not started, so v2\.0\.0 has not converted or deleted any of your memories or settings\./);
  assert.doesNotMatch(text, /Nothing was changed|exactly as they were|nothing was migrated/i);
  assert.ok(text.includes(`Data home: ${dataHome}`));
  assert.ok(text.includes(`Snapshot folder: ${join(dataHome, 'backups', 'updates')}`));
  assert.match(text, /free disk space or fix the permissions of the snapshot folder, then run "synabun" again/);
  assert.ok(text.includes(`Or go back to the version you had: npm i -g synabun@${PREVIOUS}`));
  const unknown = describeSnapshotFailure({ error: new Error('x'), dataHome, version: '2.0.0' }).lines.join('\n');
  assert.match(unknown, /Or, if you just updated, go back to the version you had: npm i -g synabun@<that version>/);
  assert.ok(unknown.includes(`Snapshot folder: ${resolve(dataHome, 'backups', 'updates')}`));
});

test('the launcher stops on a failed snapshot and has no override', () => {
  const gate = LAUNCHER_SOURCE.slice(LAUNCHER_SOURCE.indexOf('const protection = await protectFirstLaunchAfterUpdate('), LAUNCHER_SOURCE.indexOf('repairClientConfigs();\n  console.log'));
  assert.match(gate, /if \(protection\.status === 'failed'\) \{[\s\S]*process\.exit\(SNAPSHOT_FAILED_EXIT_CODE\);\s*\}/);
  assert.doesNotMatch(gate, /process\.env|process\.argv/, 'no environment variable or flag skips the stop');
  assert.ok(LAUNCHER_SOURCE.indexOf('process.exit(SNAPSHOT_FAILED_EXIT_CODE)') < LAUNCHER_SOURCE.lastIndexOf('startServer();'), 'the stop comes before the server start');
  assert.doesNotMatch(LAUNCHER_SOURCE, /\n\s*await protectFirstLaunchAfterUpdate\(/, 'the result is never discarded');
  assert.ok(Number.isInteger(SNAPSHOT_FAILED_EXIT_CODE) && SNAPSHOT_FAILED_EXIT_CODE > 0);
  assert.notEqual(SNAPSHOT_FAILED_EXIT_CODE, 75, 'not the supervisor restart code');
  assert.ok(PKG.files.includes('lib/first-launch-protection.js'), 'the module ships in the package');
});

// ── the launcher, run for real ──
//
// `node`, `npm` and `npx` on the child's PATH are stand-ins that only log
// their arguments, so the launcher can never install a dependency or download
// a browser. The launcher starts the server with its own node binary, which
// no PATH entry replaces, so a preload stands in there: in the server process
// it logs the call the same way and exits before server.js is loaded.
// Reaching the launch step shows up as a logged
// `node … neural-interface/server.js`. HOME and the data home are
// temporary directories. Skipped on Windows (the stand-ins are shell scripts)
// and in a checkout that still holds in-repository user state, which the
// launcher would first try to migrate.

const launcherSkip = process.platform === 'win32'
  ? 'the stand-in binaries are POSIX shell scripts'
  : dataHomeHasState(PACKAGE_ROOT) ? 'this checkout holds in-repository user state' : false;

function runLauncher(dataHome, extraEnv = {}) {
  const dir = tempDir();
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const log = join(dir, 'stand-in.log');
  for (const name of ['node', 'npm', 'npx']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s %s supervised=%s\\n' "${name}" "$*" "$SYNABUN_SUPERVISED" >> "$STAND_IN_LOG"\nexit 0\n`, 'utf8');
    chmodSync(join(bin, name), 0o755);
  }
  const preload = join(dir, 'stand-in-server.mjs');
  writeFileSync(preload, [
    "import { appendFileSync } from 'node:fs';",
    "if (/[\\\\/]neural-interface[\\\\/]server\\.js$/.test(process.argv[1] || '')) {",
    "  const args = [...process.execArgv, ...process.argv.slice(1)].join(' ');",
    "  appendFileSync(process.env.STAND_IN_LOG, `node ${args} supervised=${process.env.SYNABUN_SUPERVISED ?? ''}\\n`);",
    "  process.exit(0);",
    "}",
    '',
  ].join('\n'), 'utf8');
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', LAUNCHER], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: bin, HOME: home, SYNABUN_DATA_HOME: dataHome, STAND_IN_LOG: log, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ...extraEnv },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout}\n${result.stderr}`,
    serverStarts: calls.filter(line => line.startsWith('node ') && line.includes('server.js')),
  };
}
const snapshotsIn = dataHome => (existsSync(join(dataHome, 'backups', 'updates')) ? readdirSync(join(dataHome, 'backups', 'updates')).filter(name => name.endsWith('.zip')) : []);

test('launcher: a failed pre-update snapshot exits non-zero and the server never starts', { skip: launcherSkip }, () => {
  const dataHome = dataHomeWithState();
  // A file where the snapshot folder's parent should be: the folder cannot be created.
  writeFileSync(join(dataHome, 'backups'), 'not a directory');
  const manifestBefore = readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8');
  const stateBefore = readFileSync(join(dataHome, 'data', 'ui-state.json'), 'utf8');

  for (const extraEnv of [{}, { SYNABUN_SKIP_SNAPSHOT: '1', SYNABUN_FORCE: '1', SYNABUN_SUPERVISED: '1', CI: 'true' }]) {
    const run = runLauncher(dataHome, extraEnv);
    assert.equal(run.status, SNAPSHOT_FAILED_EXIT_CODE, run.output);
    assert.deepEqual(run.serverStarts, [], 'the server was never started');
    assert.ok(run.output.includes(`SynaBun v${PKG.version} did not start`), run.output);
    assert.match(run.output, /What failed: \S+/);
    assert.match(run.output, /The server was not started, so v\S+ has not converted or deleted any of your memories or settings\./);
    assert.ok(run.output.includes(`Data home: ${dataHome}`));
    assert.ok(run.output.includes(`This message is also in: ${launcherLogPath(dataHome)}`));
    assert.ok(run.output.includes(`Snapshot folder: ${join(dataHome, 'backups', 'updates')}`));
    assert.match(run.output, /free disk space or fix the permissions/);
    assert.ok(run.output.includes(`npm i -g synabun@${PREVIOUS}`));
    assert.doesNotMatch(run.output, /Starting Neural Interface server/);
  }
  assert.equal(readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8'), manifestBefore, 'the next launch tries again');
  assert.equal(readFileSync(join(dataHome, 'data', 'ui-state.json'), 'utf8'), stateBefore);
  assert.equal(readFileSync(join(dataHome, 'backups'), 'utf8'), 'not a directory');
  // A detached launch has no terminal: both stops left their reason in the log.
  const stopLog = readFileSync(launcherLogPath(dataHome), 'utf8');
  assert.equal(stopLog.split(LAUNCHER_STOP_MARKER).length - 1, 2);
  assert.match(stopLog, new RegExp(`exit ${SNAPSHOT_FAILED_EXIT_CODE}\\) =====\\nSynaBun v${PKG.version.replaceAll('.', '\\.')} did not start`));
  assert.match(stopLog, /What failed: \S+/);

  // The cause removed, the same data home launches: one verified snapshot, then the server.
  rmSync(join(dataHome, 'backups'));
  const retry = runLauncher(dataHome);
  assert.equal(retry.status, 0, retry.output);
  assert.equal(retry.serverStarts.length, 1, retry.output);
  assert.equal(snapshotsIn(dataHome).length, 1);
  assert.equal(manifestOf(dataHome).lastAppVersion, PKG.version);
  assert.match(retry.output, /Verified upgrade snapshot: /);
});

test('launcher: a handed-over snapshot that is not a valid archive is not trusted', { skip: launcherSkip }, () => {
  const dataHome = dataHomeWithState();
  const bogus = join(tempDir(), 'from-updater.zip');
  writeFileSync(bogus, 'this is not a zip archive');
  writeJson(join(dataHome, 'data', 'update-handoff.json'), { version: 1, status: 'installed', current: PREVIOUS, target: PKG.version, snapshotPath: bogus });
  writeFileSync(join(dataHome, 'backups'), 'not a directory');

  const run = runLauncher(dataHome);
  assert.equal(run.status, SNAPSHOT_FAILED_EXIT_CODE, run.output);
  assert.deepEqual(run.serverStarts, []);
  assert.match(run.output, /The updater's snapshot is not used: its snapshot did not pass verification/);
  assert.equal(handoffOf(dataHome).status, 'installed');
  assert.equal(manifestOf(dataHome).lastAppVersion, PREVIOUS);

  rmSync(join(dataHome, 'backups'));
  const retry = runLauncher(dataHome);
  assert.equal(retry.status, 0, retry.output);
  assert.equal(retry.serverStarts.length, 1);
  assert.equal(snapshotsIn(dataHome).length, 1, 'a fresh snapshot was taken');
  assert.equal(handoffOf(dataHome).status, 'verified');
  assert.equal(handoffOf(dataHome).snapshotReused, false);
  assert.notEqual(manifestOf(dataHome).lastUpgradeSnapshot, bogus);
});

test('launcher: a fresh install with no data home launches without a snapshot', { skip: launcherSkip }, () => {
  const dataHome = join(tempDir(), 'fresh-data-home');
  const run = runLauncher(dataHome);
  assert.equal(run.status, 0, run.output);
  assert.equal(run.serverStarts.length, 1, run.output);
  assert.match(run.serverStarts[0], /neural-interface\/server\.js supervised=1$/);
  assert.doesNotMatch(run.output, /Protecting user state|did not start/);
  assert.match(run.output, /First-time setup/);
  assert.deepEqual(snapshotsIn(dataHome), []);
  assert.equal(existsSync(join(dataHome, 'backups')), false);
  assert.equal(existsSync(join(dataHome, DATA_HOME_MANIFEST)), false);
});

test('launcher: a normal launch where no snapshot is due starts the server as before', { skip: launcherSkip }, () => {
  const dataHome = dataHomeWithState({ lastAppVersion: PKG.version });
  // Even a blocked snapshot folder does not matter when no snapshot is due.
  writeFileSync(join(dataHome, 'backups'), 'not a directory');
  const manifestBefore = readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8');
  const run = runLauncher(dataHome);
  assert.equal(run.status, 0, run.output);
  assert.equal(run.serverStarts.length, 1, run.output);
  assert.doesNotMatch(run.output, /Protecting user state|did not start/);
  assert.match(run.output, /Setup already complete/);
  assert.match(run.output, /Starting Neural Interface server/);
  assert.equal(readFileSync(join(dataHome, DATA_HOME_MANIFEST), 'utf8'), manifestBefore);
});
