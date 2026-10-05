// The update check and click-to-update (lib/synabun-update-plan.js, updater.mjs).
// The version the check selects and shows is the version that gets installed:
// the plan pins it, never a dist-tag, and a version npm does not have is a
// manual update instead of an install of something else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectSynabunUpdate, buildSynabunInstallPlan, npmHasSynabunVersion, refuseStaleUpdateClick } from '../lib/synabun-update-plan.js';
import { formatSynabunVersion } from '../lib/synabun-version.js';

const REPO = 'https://github.com/danilokhury/Synabun';
const UPDATER = fileURLToPath(new URL('../../updater.mjs', import.meta.url));
const UPDATER_SOURCE = readFileSync(UPDATER, 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const UPDATE_UI = readFileSync(new URL('../public/shared/ui-update.js', import.meta.url), 'utf8');
const NPM_GLOBAL = { kind: 'npm-global' };
// What updater.mjs accepts as an exact-version install spec (sanitizeInstallSpec).
const PINNED_SPEC = /^synabun@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A registry document: dist-tags plus the published versions. */
function npmDoc(distTags, versions = Object.values(distTags)) {
  return { name: 'synabun', 'dist-tags': distTags, versions: Object.fromEntries(versions.map(v => [v, {}])) };
}
/** The check and the plan, as the server runs them. */
function check({ current, npm = null, github = null, installSource = NPM_GLOBAL }) {
  const found = selectSynabunUpdate({ current, npmDocument: npm, githubReleases: github });
  const plan = buildSynabunInstallPlan({ ...found, current, installSource, repoUrl: REPO });
  return { found, plan };
}
function assertPinned(plan, version) {
  assert.equal(plan.canAutoUpdate, true);
  assert.equal(plan.source, 'npm');
  assert.equal(plan.target, version, 'the target is the version shown');
  assert.equal(plan.installSpec, `synabun@${version}`, 'the install is pinned to it');
  assert.equal(plan.displayCommand, `npm i -g synabun@${version}`, 'and so is the command shown');
  assert.match(plan.installSpec, PINNED_SPEC, 'updater.mjs accepts the spec');
  assert.match(plan.installSpec, /^[A-Za-z0-9@.-]+$/, 'nothing a Windows or POSIX shell would interpret');
}
function assertManual(plan, reason) {
  assert.equal(plan.canAutoUpdate, false);
  assert.equal(plan.reason, reason);
  assert.equal('installSpec' in plan, false, 'a manual plan carries nothing to install');
}

test('a stable install is offered the stable release and the plan pins that version', () => {
  const { found, plan } = check({
    current: '2.0.0',
    npm: npmDoc({ latest: '2.0.1' }, ['2026.9.5', '2.0.0', '2.0.1']),
    github: { tag_name: 'v.2.0.1' },
  });
  assert.equal(found.installedChannel, 'stable');
  assert.equal(found.updateAvailable, true);
  assert.equal(found.source, 'both');
  assert.equal(found.latest, '2.0.1');
  assert.equal(found.targetOnNpm, true);
  assertPinned(plan, '2.0.1');
  assert.equal(plan.npmTag, 'latest');
  assert.equal(plan.current, '2.0.0');
  assert.equal(plan.channel, 'stable');
});

test('a stable install is never offered a prerelease, from npm or from GitHub', () => {
  const { found, plan } = check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.0', beta: '2.1.0-beta.2' }), github: { tag_name: 'v.2.0.0' } });
  assert.equal(found.updateAvailable, false);
  assert.equal(plan, null);

  // A GitHub release published without the prerelease flag is /releases/latest.
  // npm has that beta, so without the channel rule it would be pinned and installed.
  const mislabelled = check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.0', beta: '2.1.0-beta.1' }), github: { tag_name: 'v2.1.0-beta.1' } });
  assert.equal(mislabelled.found.gitLatest, '2.1.0-beta.1', 'still reported');
  assert.equal(mislabelled.found.gitUpdateAvailable, false);
  assert.equal(mislabelled.found.updateAvailable, false);
  assert.equal(mislabelled.found.latest, '2.0.0');
  assert.equal(mislabelled.plan, null);

  // The stable update next to it is still offered, and it is the one pinned.
  const both = check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.1', beta: '2.1.0-beta.1' }), github: { tag_name: 'v2.1.0-beta.1' } });
  assert.equal(both.found.source, 'npm');
  assertPinned(both.plan, '2.0.1');

  // A date-style numeric iteration was a stable release and is not caught by the rule.
  assert.equal(check({ current: '2026.4.26', npm: npmDoc({ latest: '2026.4.26' }), github: { tag_name: 'v.2026.4.26-1' } }).found.gitUpdateAvailable, true);
});

test('a beta install is offered the newer beta and gets it, not the stable release', () => {
  const { found, plan } = check({
    current: '2.1.0-beta.1',
    npm: npmDoc({ latest: '2.0.0', beta: '2.1.0-beta.2' }, ['2.0.0', '2.1.0-beta.1', '2.1.0-beta.2']),
    github: [{ tag_name: 'v2.1.0-beta.2', prerelease: true }, { tag_name: 'v2.1.0-beta.3', draft: true }, { tag_name: 'v.2.0.0' }, { tag_name: 'nightly' }],
  });
  assert.equal(found.installedChannel, 'prerelease');
  assert.equal(found.npmLatest, '2.1.0-beta.2');
  assert.equal(found.npmLatestTag, 'beta');
  assert.equal(found.gitLatestRaw, 'v2.1.0-beta.2', 'drafts and tags that are not versions are skipped');
  assert.equal(found.latest, '2.1.0-beta.2');
  assertPinned(plan, '2.1.0-beta.2');
  assert.equal(plan.npmTag, 'beta');
  assert.equal(plan.channel, 'prerelease');
});

test('a beta install moves to the stable release that supersedes it', () => {
  const { found, plan } = check({ current: '2.1.0-beta.2', npm: npmDoc({ latest: '2.1.0', beta: '2.1.0-beta.2' }), github: [{ tag_name: 'v2.1.0' }] });
  assert.equal(found.latest, '2.1.0');
  assertPinned(plan, '2.1.0');
  assert.equal(plan.npmTag, 'latest');
});

test('a release that is only on GitHub is a manual update, and nothing else is installed in its place', () => {
  // npm has nothing newer than the installed version.
  const upToDateOnNpm = check({ current: '2.0.1', npm: npmDoc({ latest: '2.0.1' }, ['2.0.0', '2.0.1']), github: { tag_name: 'v.2.0.2' } });
  assert.equal(upToDateOnNpm.found.updateAvailable, true);
  assert.equal(upToDateOnNpm.found.source, 'github');
  assert.equal(upToDateOnNpm.found.latest, '2.0.2');
  assert.equal(upToDateOnNpm.found.targetOnNpm, false);
  assertManual(upToDateOnNpm.plan, 'not-on-npm');
  assert.equal(upToDateOnNpm.plan.target, '2.0.2');
  assert.equal(upToDateOnNpm.plan.openUrl, `${REPO}/releases/tag/v.2.0.2`);
  assert.equal(upToDateOnNpm.plan.displayCommand, upToDateOnNpm.plan.openUrl);
  assert.match(upToDateOnNpm.plan.manualHint, /v2\.0\.2 is published on GitHub but is not on npm yet/);
  assert.match(upToDateOnNpm.plan.manualHint, /Nothing was installed/);

  // npm has an older update. The target shown is still 2.0.2, so 2.0.1 is not installed under its name.
  const olderOnNpm = check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.1' }, ['2.0.0', '2.0.1']), github: { tag_name: 'v.2.0.2' } });
  assert.equal(olderOnNpm.found.source, 'both');
  assert.equal(olderOnNpm.found.latest, '2.0.2');
  assertManual(olderOnNpm.plan, 'not-on-npm');

  // The registry is unreachable: the GitHub release cannot be confirmed on npm,
  // and the message says that instead of claiming npm does not have it.
  const npmDown = check({ current: '2.0.1', npm: null, github: { tag_name: 'v.2.0.2' } });
  assert.equal(npmDown.found.npmChecked, false);
  assertManual(npmDown.plan, 'npm-unreachable');
  assert.equal(npmDown.plan.target, '2.0.2');
  assert.equal(npmDown.plan.openUrl, `${REPO}/releases/tag/v.2.0.2`);
  assert.match(npmDown.plan.manualHint, /could not reach npm to confirm that v2\.0\.2 is published there/);
  assert.match(npmDown.plan.manualHint, /Nothing was installed/);
  assert.doesNotMatch(npmDown.plan.manualHint, /not on npm yet/);
  assert.equal(upToDateOnNpm.found.npmChecked, true);

  // Once npm lists the version, it is installable even before `latest` moves.
  const published = check({ current: '2.0.1', npm: npmDoc({ latest: '2.0.1' }, ['2.0.1', '2.0.2']), github: { tag_name: 'v.2.0.2' } });
  assert.equal(published.found.targetOnNpm, true);
  assertPinned(published.plan, '2.0.2');
  assert.equal(published.plan.npmTag, null, 'no dist-tag points at it yet');
});

test('an npm `latest` that points at an older or date-style version is neither offered nor installed', () => {
  // Older than the installed version.
  const older = check({ current: '2.0.1', npm: npmDoc({ latest: '2.0.0' }, ['2.0.0', '2.0.1']), github: { tag_name: 'v.2.0.1' } });
  assert.equal(older.found.updateAvailable, false);
  assert.equal(older.plan, null);

  // Date-style on both sources: plain semver would call 2026.9.5 newer than 2.0.0.
  const dateStyle = check({ current: '2.0.0', npm: npmDoc({ latest: '2026.9.5' }, ['2026.9.5', '2.0.0']), github: { tag_name: 'v.2026.07.31' } });
  assert.equal(dateStyle.found.updateAvailable, false);
  assert.equal(dateStyle.plan, null);

  // `latest` is stale, the real release is published: the plan names the release, never the tag.
  const stale = check({ current: '2.0.0', npm: npmDoc({ latest: '2026.9.5' }, ['2026.9.5', '2.0.0', '2.0.1']), github: { tag_name: 'v.2.0.1' } });
  assert.equal(stale.found.npmLatestStable, '2026.9.5', 'the dist-tag is reported as published');
  assert.equal(stale.found.npmLatest, '2.0.1', 'npm\'s offer is the newest stable version it has');
  assert.equal(stale.found.npmLatestTag, null);
  assert.equal(stale.found.npmUpdateAvailable, true);
  assert.equal(stale.found.gitUpdateAvailable, true);
  assert.equal(stale.found.latest, '2.0.1');
  assertPinned(stale.plan, '2.0.1');
  assert.equal(stale.plan.npmTag, null);

  // A date-style install is still offered the semver-era release.
  const fromDateStyle = check({ current: '2026.9.5', npm: npmDoc({ latest: '2.0.0' }, ['2026.9.5', '2.0.0']), github: { tag_name: 'v.2026.07.31' } });
  assert.equal(fromDateStyle.found.latest, '2.0.0');
  assertPinned(fromDateStyle.plan, '2.0.0');
});

test('npm candidates follow the installed channel, and an unusable `latest` falls back to the published versions', () => {
  // `latest` left on a date-style release and GitHub unreachable: the newest stable published version is offered.
  const leftBehind = check({ current: '2.0.0', npm: npmDoc({ latest: '2026.9.5' }, ['2026.9.5', '2.0.0', '2.0.1', '2.1.0-beta.1']), github: null });
  assert.equal(leftBehind.found.npmLatest, '2.0.1');
  assert.equal(leftBehind.found.npmLatestTag, null);
  assert.equal(leftBehind.found.updateAvailable, true);
  assert.equal(leftBehind.found.source, 'npm');
  assert.equal(leftBehind.found.latest, '2.0.1');
  assertPinned(leftBehind.plan, '2.0.1');
  assert.equal(leftBehind.plan.npmTag, null);

  // `latest` points at a prerelease: a stable install is not moved to it.
  const betaAsLatest = check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.1-beta.1' }, ['2.0.0', '2.0.1-beta.1']), github: null });
  assert.equal(betaAsLatest.found.npmLatest, '2.0.0');
  assert.equal(betaAsLatest.found.updateAvailable, false);
  assert.equal(betaAsLatest.plan, null);
  // ... and the stable release published next to it is still offered.
  assertPinned(check({ current: '2.0.0', npm: npmDoc({ latest: '2.1.0-beta.1' }, ['2.0.0', '2.0.1', '2.1.0-beta.1']), github: null }).plan, '2.0.1');

  // A usable `latest` is the publisher's choice: a newer version without the tag does not override it.
  const tagged = check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.1' }, ['2.0.0', '2.0.1', '2.0.2']), github: null });
  assert.equal(tagged.found.npmLatest, '2.0.1');
  assert.equal(tagged.found.npmLatestTag, 'latest');
  assertPinned(tagged.plan, '2.0.1');
  assert.equal(tagged.plan.npmTag, 'latest');

  // `latest` is not a version, or the registry has no dist-tags.
  assertPinned(check({ current: '2.0.0', npm: npmDoc({ latest: 'not-a-version' }, ['2.0.0', '2.0.1']) }).plan, '2.0.1');
  assertPinned(check({ current: '2.0.0', npm: { versions: { '2.0.0': {}, '2.0.1': {} } } }).plan, '2.0.1');
  assert.equal(check({ current: '2.0.0', npm: {} }).plan, null);

  // A registry that only has date-style releases keeps its `latest`.
  const dateOnly = check({ current: '2026.9.1', npm: npmDoc({ latest: '2026.9.5' }, ['2026.9.1', '2026.9.5', '2026.9.6']) });
  assert.equal(dateOnly.found.npmLatest, '2026.9.5');
  assert.equal(dateOnly.found.npmLatestTag, 'latest');
  assertPinned(dateOnly.plan, '2026.9.5');

  // A prerelease install: the stable offer is repaired the same way, and the newer beta still wins.
  const beta = check({ current: '2.1.0-beta.1', npm: npmDoc({ latest: '2026.9.5', beta: '2.1.0-beta.2' }, ['2026.9.5', '2.0.0', '2.1.0-beta.1', '2.1.0-beta.2']), github: null });
  assert.equal(beta.found.npmLatest, '2.1.0-beta.2');
  assert.equal(beta.found.npmLatestTag, 'beta');
  assertPinned(beta.plan, '2.1.0-beta.2');
  const superseded = check({ current: '2.1.0-beta.2', npm: npmDoc({ latest: '2026.9.5', beta: '2.1.0-beta.2' }, ['2026.9.5', '2.1.0-beta.2', '2.1.0']), github: null });
  assert.equal(superseded.found.npmLatestTag, null);
  assertPinned(superseded.plan, '2.1.0');
  // A prerelease dist-tag that is not a version is no candidate.
  assert.equal(check({ current: '2.1.0-beta.1', npm: npmDoc({ latest: '2.0.0', beta: 'soon' }, ['2.0.0']) }).found.updateAvailable, false);
});

test('the target is spelled the way npm names the version', () => {
  const { found, plan } = check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.0' }, ['2.0.0', '2.0.1']), github: { tag_name: 'v2.0.1+build.7' } });
  assert.equal(found.gitLatest, '2.0.1+build.7');
  assert.equal(found.latest, '2.0.1');
  assertPinned(plan, '2.0.1');
  assert.equal(npmHasSynabunVersion(npmDoc({ latest: '2026.9.5' }), 'v.2026.09.05'), true);
  assert.equal(npmHasSynabunVersion(npmDoc({ latest: '2.0.0' }), '2.0.1'), false);
  assert.equal(npmHasSynabunVersion(null, '2.0.1'), false);
  assert.equal(npmHasSynabunVersion(npmDoc({ latest: '2.0.0' }), 'not a version'), false);
  assert.equal(formatSynabunVersion('v.2026.09.05'), '2026.9.5');
  assert.equal(formatSynabunVersion('2.1.0-beta.2'), '2.1.0-beta.2');
  assert.equal(formatSynabunVersion('2.0.1junk'), null);
});

test('an install that did not come from npm keeps its manual plan', () => {
  const sources = { current: '2.0.0', npm: npmDoc({ latest: '2.0.1' }), github: { tag_name: 'v.2.0.1' } };
  const clone = check({ ...sources, installSource: { kind: 'github-clone', remote: 'git@github.com:danilokhury/Synabun.git' } }).plan;
  assertManual(clone, 'not-npm-install');
  assert.equal(clone.target, '2.0.1');
  assert.equal(clone.openUrl, REPO);
  assert.equal(clone.manualCommand, 'git pull --ff-only');
  assert.equal(clone.remote, 'git@github.com:danilokhury/Synabun.git');
  const local = check({ ...sources, installSource: { kind: 'local' } }).plan;
  assertManual(local, 'not-npm-install');
  assert.equal(local.manualCommand, null);
  assert.equal(check({ ...sources, installSource: null }).plan.reason, 'not-npm-install', 'an undetected install is not auto-updated');
});

test('no update, no plan; a failed check is not an update', () => {
  assert.equal(check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.0' }), github: { tag_name: 'v.2.0.0' } }).plan, null);
  const failed = check({ current: '2.0.0' });
  assert.equal(failed.found.updateAvailable, false);
  assert.equal(failed.found.latest, null);
  assert.equal(failed.plan, null);
});

test('a click for a version the server no longer plans is refused', () => {
  const plan = check({ current: '2.0.0', npm: npmDoc({ latest: '2.0.2' }, ['2.0.0', '2.0.1', '2.0.2']) }).plan;
  assertPinned(plan, '2.0.2');
  assert.equal(refuseStaleUpdateClick(plan, '2.0.2'), null, 'the version on screen is the planned one');
  assert.equal(refuseStaleUpdateClick(plan, 'v2.0.2'), null, 'spelling does not matter');
  const refusal = refuseStaleUpdateClick(plan, '2.0.1');
  assert.equal(refusal.code, 'target-changed');
  assert.match(refusal.error, /The update on screen \(v2\.0\.1\) is out of date: SynaBun now offers v2\.0\.2\. Nothing was installed\./);
  // An older page sends no target, and anything that is not a version is not echoed back.
  for (const absent of [undefined, null, '', 42, {}, '<img src=x>']) assert.equal(refuseStaleUpdateClick(plan, absent), null);
  assert.equal(refuseStaleUpdateClick(null, '2.0.1'), null);
});

test('the server builds its plan here and no longer installs a dist-tag', () => {
  const start = SERVER.indexOf('async function checkSynabunUpdate()');
  const end = SERVER.indexOf("app.get('/api/system/version'");
  assert.ok(start > 0 && end > start);
  const checkSource = SERVER.slice(start, end);
  assert.match(checkSource, /selectSynabunUpdate\(\{/);
  assert.match(checkSource, /buildSynabunInstallPlan\(\{/);
  assert.doesNotMatch(SERVER, /installSpec\s*=\s*['"`]synabun@latest/, 'no dist-tag install spec');
  assert.doesNotMatch(SERVER, /displayCommand:\s*['"`]npm i -g synabun@latest/);
  assert.doesNotMatch(SERVER, /\nfunction buildSynabunInstallPlan\(/, 'one definition, in lib/synabun-update-plan.js');
  // The handoff marker and the staged payload both carry the plan's target.
  const runUpdate = SERVER.slice(SERVER.indexOf("app.post('/api/system/run-update'"), SERVER.indexOf("app.post('/api/settings/move-db'"));
  assert.match(runUpdate, /target: installPlan\.target,/);
  assert.match(runUpdate, /installPlan\.canAutoUpdate === false/);
  // The click is checked against the plan before a snapshot is taken or anything is staged.
  const refusalAt = runUpdate.indexOf('refuseStaleUpdateClick(installPlan, req.body?.target)');
  assert.ok(refusalAt > 0, 'the click names the version it showed');
  assert.ok(refusalAt < runUpdate.indexOf('createVerifiedBackup('));
  assert.ok(refusalAt < runUpdate.indexOf('stageSynabunUpdater('));
  assert.match(runUpdate, /res\.status\(409\)\.json\(\{ \.\.\.staleClick, installPlan \}\)/);
  assert.match(UPDATE_UI, /body: JSON\.stringify\(\{ autoRestart, target: installPlan\.target \}\)/, 'the modal sends the version it shows');
  assert.match(UPDATE_UI, /err\.code === 'target-changed'/);
  // The updater is told where the relaunched launcher leaves its reason, and an
  // update that never reached the updater does not leave a pending handoff.
  assert.match(SERVER, /launcherLogPath: launcherLogPath\(DATA_HOME\),/);
  assert.match(runUpdate, /cancelUpdateHandoff\(preparedHandoffPath, msg\);\s*\n\s*return res\.status\(500\)/);
  assert.match(SERVER, /if \(handoff\?\.status !== 'prepared'\) return;/);
  assert.match(SERVER, /installSpec: installPlan\.installSpec,\s*\n\s*displayCommand: installPlan\.displayCommand,[\s\S]{0,160}target: installPlan\.target,/);
  // updater.mjs accepts exactly the spec shape the plan produces.
  assert.ok(UPDATER_SOURCE.includes(String.raw`/^synabun@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/`), 'sanitizeInstallSpec accepts a pinned version');
});

// ── updater.mjs, run for real against stand-ins ──
//
// The stand-in is the only `npm` on the child's PATH, so nothing is ever
// installed; a private prefix and an unroutable registry back that up. A
// relaunch finds only the stand-in `synabun` of the test, or none.

function runUpdater(payload, { npmExit = 0, synabun = null, legacyArgs = null, seedLauncherLog = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-updater-test-'));
  const bin = join(dir, 'bin');
  const data = join(dir, 'data');
  mkdirSync(bin);
  mkdirSync(data);
  const npmLog = join(dir, 'npm-args.txt');
  const launcherLog = join(data, 'server-stderr.log');
  const handoffPath = join(data, 'update-handoff.json');
  const standIn = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, 'utf8'); chmodSync(join(bin, name), 0o755); };
  standIn('npm', `printf '%s\\n' "$@" > "$FAKE_NPM_LOG"\nexit ${npmExit}`);
  if (synabun) standIn('synabun', synabun);
  if (seedLauncherLog) writeFileSync(launcherLog, seedLauncherLog, 'utf8');
  const prepared = { version: 1, status: 'prepared', current: payload?.current, target: payload?.target, snapshotPath: '/snapshots/pre-update.zip' };
  writeFileSync(handoffPath, JSON.stringify(prepared, null, 2) + '\n', 'utf8');
  let args = legacyArgs;
  if (!args) {
    const payloadPath = join(dir, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify({ autoRestart: false, cwd: dir, handoffPath, safetySnapshot: prepared.snapshotPath, ...payload }, null, 2), 'utf8');
    args = ['--payload', payloadPath];
  }
  const started = Date.now();
  const result = spawnSync(process.execPath, [UPDATER, ...args, '--no-hold'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: bin,
      HOME: dir,
      FAKE_NPM_LOG: npmLog,
      HANDOFF: handoffPath,
      LAUNCHER_LOG: launcherLog,
      npm_config_prefix: join(dir, 'prefix'),
      npm_config_registry: 'http://127.0.0.1:9/',
    },
  });
  const ms = Date.now() - started;
  const npmArgs = existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n') : null;
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, npmArgs, handoff, ms, launcherLog };
}
const posixOnly = { skip: process.platform === 'win32' ? 'the stand-in binaries are POSIX shell scripts' : false };

test('the updater installs the pinned version it was handed and records it', posixOnly, () => {
  for (const [current, npm] of [
    ['2.0.0', npmDoc({ latest: '2.0.1' })],
    ['2.1.0-beta.1', npmDoc({ latest: '2.0.0', beta: '2.1.0-beta.2' })],
  ]) {
    const { found, plan } = check({ current, npm });
    const run = runUpdater({ installSpec: plan.installSpec, displayCommand: plan.displayCommand, source: plan.source, current: plan.current, target: plan.target, channel: plan.channel });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.npmArgs, ['i', '-g', `synabun@${found.latest}`], 'npm installs the version that was shown');
    assert.match(run.output, new RegExp(`${current.replaceAll('.', '\\.')} -> ${found.latest.replaceAll('.', '\\.')}`));
    assert.equal(run.handoff.status, 'installed');
    assert.equal(run.handoff.target, found.latest, 'the handoff marker names the installed version');
    assert.equal(run.handoff.current, current);
    assert.equal(run.handoff.snapshotPath, '/snapshots/pre-update.zip');
  }
});

test('a payload that names a target must pin exactly that version', posixOnly, () => {
  const refused = (payload, message) => {
    const run = runUpdater({ current: '2.0.0', ...payload });
    assert.equal(run.status, 1, run.output);
    assert.equal(run.npmArgs, null, 'npm never ran');
    assert.match(run.output, message);
    assert.equal(run.handoff.status, 'failed', 'the handoff is closed: this update did not happen');
    assert.equal(run.handoff.snapshotPath, '/snapshots/pre-update.zip');
  };
  // The target with a dist-tag, and the target with no spec at all (which used to default to latest).
  refused({ target: '2.0.1', installSpec: 'synabun@latest' }, /shows v2\.0\.1 but does not pin that exact version to install\. Nothing was installed\./);
  refused({ target: '2.0.1' }, /shows v2\.0\.1 but does not pin that exact version to install\. Nothing was installed\./);
  // The target with another version.
  refused({ target: '2.0.2', installSpec: 'synabun@2.0.1' }, /shows v2\.0\.2 but would install v2\.0\.1\. Nothing was installed\./);
  // A target that is not printable is not echoed.
  refused({ target: '2.0.1; rm -rf ~', installSpec: 'synabun@latest' }, /shows v\? but does not pin/);
});

test('the dist-tag default is only for an invocation that names no target', posixOnly, () => {
  // The legacy command line: no payload at all.
  const bare = runUpdater(null, { legacyArgs: [] });
  assert.equal(bare.status, 0, bare.output);
  assert.deepEqual(bare.npmArgs, ['i', '-g', 'synabun@latest']);
  assert.equal(bare.handoff.status, 'prepared', 'no payload, no handoff to touch');
  const tagged = runUpdater(null, { legacyArgs: ['--tag', 'beta'] });
  assert.deepEqual(tagged.npmArgs, ['i', '-g', 'synabun@beta']);
});

test('a failed install closes the handoff as failed', posixOnly, () => {
  const run = runUpdater({ installSpec: 'synabun@2.0.1', current: '2.0.0', target: '2.0.1' }, { npmExit: 7 });
  assert.equal(run.status, 7);
  assert.deepEqual(run.npmArgs, ['i', '-g', 'synabun@2.0.1']);
  assert.equal(run.handoff.status, 'failed', 'a launcher never reuses the snapshot of an update that did not install');
  assert.equal(run.handoff.target, '2.0.1');
  assert.match(run.handoff.reason, /npm exited with code 7/);
});

test('the updater rejects an install spec that is not SynaBun at a version or a known tag', posixOnly, () => {
  const run = runUpdater({ installSpec: 'synabun@2.0.1 && echo pwned', current: '2.0.0', target: '2.0.1' });
  assert.equal(run.status, 1);
  assert.equal(run.npmArgs, null);
  assert.match(run.output, /No valid SynaBun install target was provided/);
});

// ── the relaunch ──

const UPDATE = { installSpec: 'synabun@2.0.1', current: '2.0.0', target: '2.0.1', autoRestart: true };
const OLD_STOP = '\n===== launcher stopped 2026-01-01T00:00:00.000Z (pid 1, exit 3) =====\nAN OLDER STOP THAT IS NOT THIS ONE\n';

test('a relaunch that stops is reported with the launcher\'s reason, not as launched', posixOnly, () => {
  const stops = [
    "printf '\\n===== launcher stopped %s (pid 1, exit 3) =====\\nSynaBun v2.0.1 did not start: the snapshot could not be created.\\nWhat failed: ENOSPC: no space left on device\\n' \"$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)\" >> \"$LAUNCHER_LOG\"",
    'exit 3',
  ].join('\n');
  const run = runUpdater({ ...UPDATE, relaunchObserveMs: 15_000 }, { synabun: stops, seedLauncherLog: OLD_STOP });
  assert.equal(run.status, 3, run.output);
  assert.deepEqual(run.npmArgs, ['i', '-g', 'synabun@2.0.1']);
  assert.match(run.output, /The update was installed, but SynaBun did not start \(it exited with code 3\)\./);
  assert.match(run.output, /SynaBun v2\.0\.1 did not start: the snapshot could not be created\.\nWhat failed: ENOSPC: no space left on device/);
  assert.ok(run.output.includes(`Launcher log: ${run.launcherLog}`));
  assert.doesNotMatch(run.output, /synabun launched/);
  assert.doesNotMatch(run.output, /AN OLDER STOP/);
  assert.equal(run.handoff.status, 'installed', 'the install itself succeeded');
  assert.ok(run.ms < 12_000, 'the stop was seen when it happened, not when the watch ended');
});

test('a relaunch that exits without a reason still fails, and an older stop record is not shown as its reason', posixOnly, () => {
  const run = runUpdater({ ...UPDATE, relaunchObserveMs: 15_000 }, { synabun: 'exit 1', seedLauncherLog: OLD_STOP });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /The update was installed, but SynaBun did not start \(it exited with code 1\)\./);
  assert.ok(run.output.includes(`Launcher log: ${run.launcherLog}`));
  assert.doesNotMatch(run.output, /AN OLDER STOP|synabun launched/);
});

test('a relaunch that cannot be started is a failure too', posixOnly, () => {
  const run = runUpdater({ ...UPDATE, relaunchObserveMs: 5_000 });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /The update was installed, but SynaBun did not start\./);
  assert.match(run.output, /ENOENT/);
  assert.doesNotMatch(run.output, /synabun launched/);
});

test('a relaunch that is still running, or that passed the launch check, is reported as launched', posixOnly, () => {
  const stillRunning = runUpdater({ ...UPDATE, relaunchObserveMs: 700 }, { synabun: 'exec /bin/sleep 3' });
  assert.equal(stillRunning.status, 0, stillRunning.output);
  assert.match(stillRunning.output, /synabun launched \(detached\)/);
  assert.doesNotMatch(stillRunning.output, /did not start/);

  // The launcher closes the handoff as verified once its pre-update check has passed: no need to wait the watch out.
  const passed = runUpdater({ ...UPDATE, relaunchObserveMs: 30_000 }, { synabun: 'printf \'{"status":"verified"}\' > "$HANDOFF"\nexec /bin/sleep 3' });
  assert.equal(passed.status, 0, passed.output);
  assert.match(passed.output, /synabun launched \(detached\)/);
  assert.ok(passed.ms < 15_000, `the watch ended early (${passed.ms} ms)`);
});
