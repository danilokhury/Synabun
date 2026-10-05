// Version parsing and ordering for the update check (lib/synabun-version.js).
// SynaBun moved from date-style versions (2026.9.5) to plain semver at 2.0.0.
// Plain semver puts every date-style release above 2.x, and the date-style
// scheme read a numeric suffix as a post-release iteration, which semver reads
// as a prerelease. These tests pin both rules and the parser's strictness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseSemver, compareSemver, semverNewer,
  isDateStyleSynabunVersion, synabunReleaseChannel, compareSynabunVersion, synabunVersionNewer,
  SYNABUN_DATE_VERSION_MIN_MAJOR,
} from '../lib/synabun-version.js';

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
// The selection half of the update check (tests/synabun-update-plan.test.mjs covers its behaviour).
const UPDATE_PLAN = readFileSync(new URL('../lib/synabun-update-plan.js', import.meta.url), 'utf8');
const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const parsed = (major, minor, patch, pre = null, iter = null, build = null) => ({ major, minor, patch, pre, iter, build });
/** Asserts the list is in strictly ascending order under `compare`, every pair both ways. */
function assertAscending(versions, compare, label) {
  for (let i = 0; i < versions.length; i++) {
    for (let j = 0; j < versions.length; j++) {
      const sign = Math.sign(compare(versions[i], versions[j]));
      assert.equal(sign, Math.sign(i - j), `${label}: ${versions[i]} vs ${versions[j]}`);
    }
  }
}

test('parseSemver reads both schemes, the v and v. prefixes and the suffix kinds', () => {
  assert.deepEqual(parseSemver('2.0.0'), parsed(2, 0, 0));
  assert.deepEqual(parseSemver('v2.0.1'), parsed(2, 0, 1));
  assert.deepEqual(parseSemver('v.2.0.1'), parsed(2, 0, 1));
  assert.deepEqual(parseSemver('  2.0.1\n'), parsed(2, 0, 1), 'surrounding whitespace is trimmed');
  assert.deepEqual(parseSemver('2.1.0-beta.3'), parsed(2, 1, 0, 'beta.3'));
  assert.deepEqual(parseSemver('2.1.0-rc-1.x-y'), parsed(2, 1, 0, 'rc-1.x-y'), 'hyphens inside an identifier');
  assert.deepEqual(parseSemver('v.2026.09.05'), parsed(2026, 9, 5), 'zero-padded date parts of a git tag');
  assert.deepEqual(parseSemver('2026.9.5'), parsed(2026, 9, 5));
  assert.deepEqual(parseSemver('2026.3.31008'), parsed(2026, 3, 31008));
  assert.deepEqual(parseSemver('2026.4.26-beta.3'), parsed(2026, 4, 26, 'beta.3'));
  assert.deepEqual(parseSemver('2026.7.20-beta1'), parsed(2026, 7, 20, 'beta1'));
  assert.deepEqual(parseSemver('v2026.4.2-beta.0'), parsed(2026, 4, 2, 'beta.0'));
});

test('a numeric suffix is an iteration only on a date-style version', () => {
  assert.deepEqual(parseSemver('2026.4.20-2'), parsed(2026, 4, 20, '2', 2), 'date-style: the second post-release iteration');
  assert.deepEqual(parseSemver('2.0.0-1'), parsed(2, 0, 0, '1'), 'semver era: a prerelease, no iteration');
  assert.deepEqual(parseSemver('0.160.0-7'), parsed(0, 160, 0, '7'), 'a CLI tool version: a prerelease too');
  assert.deepEqual(parseSemver('2026.4.2-1.1'), parsed(2026, 4, 2, '1.1'), 'two identifiers are not one number');
});

test('build metadata is read and kept out of the prerelease', () => {
  assert.deepEqual(parseSemver('2.0.1+build.7'), parsed(2, 0, 1, null, null, 'build.7'));
  assert.deepEqual(parseSemver('2.0.1-rc.1+sha.5114f85'), parsed(2, 0, 1, 'rc.1', null, 'sha.5114f85'));
  assert.deepEqual(parseSemver('v2.0.1+001'), parsed(2, 0, 1, null, null, '001'));
  assert.deepEqual(parseSemver('2026.4.20-2+local'), parsed(2026, 4, 20, '2', 2, 'local'));
});

test('parseSemver takes a whole version string and nothing else', () => {
  for (const bad of [
    '2.0.1junk', '2.0.1-', '2.0.1+', '2.0.1-+build', '2.0.1.', '2.0.1.4', '2.0', '2', '.2.0.1',
    '2.0.1-beta..1', '2.0.1-.beta', '2.0.1-beta.', '2.0.1-beta_1', '2.0.1+build..7', '2.0.1+a+b',
    '2.0.1 (Claude Code)', 'codex-cli 0.147.0', 'version 2.0.1', '2.0.1 2.0.2', '2.0.x', 'x.0.1', '-2.0.1',
    'vv2.0.1', 'v..2.0.1', 'V2.0.1', '2 .0.1', 'Beta', 'latest', '', '   ', null, undefined,
  ]) {
    assert.equal(parseSemver(bad), null, JSON.stringify(bad));
  }
  assert.equal(semverNewer('2.0.0', '2.0.1junk'), false, 'a string that is not a version is never an update');
  assert.equal(synabunVersionNewer('2.0.0', '2.0.1-'), false);
  assert.equal(synabunVersionNewer('2.0.0', '9.9.9 or so'), false);
});

test('semver precedence: a release is above its prereleases, numeric below alphanumeric', () => {
  const ladder = ['2.0.0-1', '2.0.0-2', '2.0.0-11', '2.0.0-alpha', '2.0.0-alpha.1', '2.0.0-alpha.beta', '2.0.0-beta', '2.0.0-beta.2', '2.0.0-beta.11', '2.0.0-rc.1', '2.0.0', '2.0.1-0', '2.0.1', '2.1.0', '10.0.0'];
  assertAscending(ladder, compareSemver, 'compareSemver');
  assertAscending(ladder, compareSynabunVersion, 'compareSynabunVersion');
  assert.equal(semverNewer('2.1.277', '2.1.278'), true);
  assert.equal(semverNewer('0.160.0', '0.121.0'), false);
  assert.equal(semverNewer('1.0.0-beta.2', '1.0.0'), true);
  assert.equal(semverNewer('1.0.0', '1.0.0-1'), false, 'a numeric suffix is a prerelease for a CLI tool');
  assert.equal(semverNewer('1.0.0-1', '1.0.0'), true);
  assert.equal(semverNewer('x', '1.0.0'), false);
});

test('2.0.0-1 and 2.0.0-beta.1 are prereleases below 2.0.0', () => {
  assert.equal(synabunVersionNewer('2.0.0', '2.0.0-1'), false, '2.0.0-1 is not an update for 2.0.0');
  assert.equal(synabunVersionNewer('2.0.0-1', '2.0.0'), true, '2.0.0 is the update for 2.0.0-1');
  assert.equal(synabunVersionNewer('2.0.0', '2.0.0-beta.1'), false);
  assert.equal(synabunVersionNewer('2.0.0-beta.1', '2.0.0'), true);
  assert.equal(synabunVersionNewer('2.0.0-1', '2.0.0-beta.1'), true, 'numeric identifiers sort below alphanumeric ones');
  assert.ok(compareSynabunVersion('2.0.0-1', '2.0.0') < 0);
  assert.ok(compareSynabunVersion('2.0.0', '2.0.0-1') > 0);
  assert.equal(synabunVersionNewer('2.0.0', '2.0.1-1'), true, 'a prerelease of the next patch is still a higher version');
});

test('build metadata never changes the order', () => {
  assert.equal(compareSemver('2.0.0+a', '2.0.0+b'), 0);
  assert.equal(compareSynabunVersion('2.0.0', '2.0.0+build.9'), 0);
  assert.equal(synabunVersionNewer('2.0.0', '2.0.0+build.9'), false);
  assert.equal(synabunVersionNewer('2.0.0+build.9', '2.0.1'), true);
  assert.ok(compareSemver('2.0.0-rc.1+z', '2.0.0+a') < 0);
});

test('date-style versions keep the order they were published in', () => {
  const ladder = ['2026.4.25-beta.3', '2026.4.26-beta', '2026.4.26-beta.1', '2026.4.26-beta.16', '2026.4.26', '2026.4.26-1', '2026.4.26-2', '2026.4.26-6', '2026.4.27', '2026.4.27-1', '2026.5.14', '2026.7.34', '2026.9.5'];
  assertAscending(ladder, compareSemver, 'compareSemver');
  assertAscending(ladder, compareSynabunVersion, 'compareSynabunVersion');
  assert.equal(synabunVersionNewer('2026.4.26', '2026.4.26-1'), true, 'a date-style iteration is newer than its release');
  assert.equal(synabunVersionNewer('2026.4.26-1', '2026.4.26'), false);
  assert.equal(synabunVersionNewer('2026.4.26', '2026.4.26-beta.3'), false);
  assert.equal(synabunVersionNewer('2026.4.26-beta.16', '2026.4.26-1'), true, 'an iteration is newer than a prerelease');
  assert.equal(compareSemver('v.2026.09.05', '2026.9.5'), 0, 'a zero-padded tag is the same version');
});

test('a date-style version is recognised by its major', () => {
  for (const v of ['2026.9.5', 'v.2026.07.34', '2026.4.26-1', '2026.7.20-beta1', '2027.1.1', '2000.0.0']) assert.equal(isDateStyleSynabunVersion(v), true, v);
  for (const v of ['2.0.0', 'v2.0.0', '2.1.0-beta.1', '2.0.0-1', '10.4.2', '1999.0.0', 'Beta', '2026.9.5junk', '', null]) assert.equal(isDateStyleSynabunVersion(v), false, String(v));
  assert.equal(SYNABUN_DATE_VERSION_MIN_MAJOR, 2000);
});

test('every date-style release is older than every semver-era release', () => {
  assert.equal(synabunVersionNewer('2026.9.5', '2.0.0'), true, 'the last date-style release updates to 2.0.0');
  assert.equal(synabunVersionNewer('2.0.0', '2026.9.5'), false, '2.0.0 is never offered 2026.9.5');
  assert.equal(synabunVersionNewer('2.0.0', '2026.10.5'), false, 'nor a later date');
  assert.equal(synabunVersionNewer('2.0.0', 'v.2026.09.05'), false, 'nor a GitHub tag of the old scheme');
  assert.equal(synabunVersionNewer('2.0.0', '2026.4.26-6'), false, 'nor a date-style iteration');
  assert.equal(synabunVersionNewer('2.3.1', '2026.7.20-beta1'), false);
  assert.ok(compareSynabunVersion('2.0.0', '2026.9.5') > 0);
  assert.ok(compareSynabunVersion('2026.9.5', '2.0.0-beta.1') < 0, 'even a 2.x prerelease is the newer scheme');
  assert.ok(compareSynabunVersion('2026.4.26-6', '2.0.0-1') < 0);
  assert.ok(compareSemver('2026.9.5', '2.0.0') > 0, 'plain semver: the date-style release is the larger number');
});

test('inside one scheme the order is what semver says', () => {
  assert.equal(synabunVersionNewer('2.0.0', '2.0.1'), true);
  assert.equal(synabunVersionNewer('2.0.1', '2.0.0'), false);
  assert.equal(synabunVersionNewer('2.0.0', '2.0.0'), false);
  assert.equal(synabunVersionNewer('2.0.0', 'v2.0.0'), false);
  assert.equal(synabunVersionNewer('2.0.0', '2.1.0-rc.1'), true);
  assert.equal(synabunVersionNewer('2026.7.34', '2026.9.5'), true);
  assert.equal(synabunVersionNewer('2026.9.5', '2026.7.34'), false);
  assert.equal(synabunVersionNewer(null, '2.0.0'), false);
  assert.equal(synabunVersionNewer('2.0.0', 'not a version'), false);
});

test('the newest of a mixed list is the semver-era release', () => {
  const tags = ['v.2026.09.05', 'v2.0.0', 'v.2026.07.34', 'v2.0.1-1', 'v2.0.1', 'v2026.4.20', 'v.2026.4.26-6'];
  const newest = tags.reduce((best, tag) => (compareSynabunVersion(tag, best) > 0 ? tag : best));
  assert.equal(newest, 'v2.0.1');
});

test('channel: a semver-era suffix is a prerelease, a date-style iteration was a stable release', () => {
  for (const v of ['2.0.0', 'v2.0.1', '2.0.0+build.7', '2026.9.5', '2026.4.26-1', '2026.4.20-2', 'v.2026.07.34']) assert.equal(synabunReleaseChannel(v), 'stable', v);
  for (const v of ['2.0.0-1', '2.0.0-beta.1', '2.1.0-rc.1', '2.0.1-0', '2.0.0-1+build', '2026.4.26-beta.3', '2026.7.20-beta1', '2026.4.2-1.a']) assert.equal(synabunReleaseChannel(v), 'prerelease', v);
  for (const v of ['2.0.1junk', 'Beta', '', null, undefined]) assert.equal(synabunReleaseChannel(v), 'stable', `not a version: ${String(v)}`);
});

test('the update check orders SynaBun versions with the scheme rules, the CLI tools without them', () => {
  const check = SERVER.slice(SERVER.indexOf('async function checkSynabunUpdate()'), SERVER.indexOf("app.get('/api/system/version'"));
  assert.match(check, /const installedChannel = synabunReleaseChannel\(current\);/, 'the installed channel comes from the tested helper');
  assert.match(check, /selectSynabunUpdate\(\{/, 'the selection is delegated to lib/synabun-update-plan.js');
  for (const [name, source] of [['server.js', check], ['lib/synabun-update-plan.js', UPDATE_PLAN]]) {
    assert.doesNotMatch(source, /\.iter\b/, `${name}: no inline reading of the iteration`);
    assert.doesNotMatch(source, /\bsemverNewer\(|\bcompareSemver\(/, `${name}: no plain comparison of a SynaBun version is left`);
  }
  assert.match(UPDATE_PLAN, /const installedChannel = synabunReleaseChannel\(current\);/);
  assert.match(UPDATE_PLAN, /npmUpdateAvailable = !!\(npmLatest && synabunVersionNewer\(current, npmLatest\)\)/);
  assert.match(UPDATE_PLAN, /gitUpdateAvailable = !!\(gitOffer && synabunVersionNewer\(current, gitOffer\)\)/);
  assert.match(SERVER, /updateAvailable: !!\(installed && latest && semverNewer\(installed, latest\)\)/, 'tool versions: plain semver');
  assert.doesNotMatch(SERVER, /\nfunction (?:parseSemver|compareSemver|semverNewer)\(/, 'one definition, in lib/synabun-version.js');
});

test('this package is a semver-era release', () => {
  assert.ok(parseSemver(PKG.version), 'the root package.json version is a whole version string');
  assert.equal(isDateStyleSynabunVersion(PKG.version), false, 'and it is not date-style');
});
