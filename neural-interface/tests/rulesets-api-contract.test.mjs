import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import archiver from 'archiver';
import { spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { createRulesetInstaller } from '../lib/rulesets/installer.js';
import { createWriterLock, LOCK_FILE_NAME } from '../lib/rulesets/lock.js';
import { BACKUP_PREFIX, createVerifiedBackup, isLockOnlyDataFile, LOCK_ONLY_DATA_FILES, verifyBackupArchive } from '../lib/backup-service.js';
import { extractZipEntry, openZipArchive } from '../lib/backup-zip-reader.js';
import { planRestoreWrites, restoreTargetFor } from '../lib/system-restore.js';
import { registerLegacyRulesetRoutes, registerRulesetRoutes } from '../lib/rulesets/api.js';
import { readRulesetManifest, renderRuleset, RULESET_HOSTS, sha12 } from '../lib/rulesets/render.js';

const LEGACY_TEXT = '## Memory: SynaBun MCP\nTools: remember, recall\n- Recall at session start.\n- Sequential calls only.';
const LEGACY = [{ sha: sha12(LEGACY_TEXT), lines: 4, firstLine: '## Memory: SynaBun MCP', host: 'codex' }];
const HOST_KEYS = ['carrier', 'path', 'state', 'installedVersion', 'managed', 'error'];

/** An Express app with the rules routes over an installer that only knows a temp home. No Neural Interface server. */
async function startApp(t, { clis = ['claude', 'codex', 'gemini', 'opencode'], installerOptions = {}, routeOptions = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synabun-rules-api-'));
  const home = join(root, 'home');
  const dataHome = join(root, 'data-home');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const dirs = { claude: join(home, '.claude'), codex: join(home, '.codex'), gemini: join(home, '.gemini'), opencode: join(home, '.config', 'opencode') };
  mkdirSync(home, { recursive: true });
  for (const cli of clis) mkdirSync(dirs[cli], { recursive: true });
  const make = (overrides = {}) => createRulesetInstaller({ home, dataHome, projects: () => [{ path: project }], env: {}, legacyHashes: LEGACY, ...overrides });
  const installer = make(typeof installerOptions === 'function' ? installerOptions({ home, dataHome, project, dirs, make }) : installerOptions);
  const app = express();
  app.use(express.json());
  registerRulesetRoutes(app, { installer, ...routeOptions });
  registerLegacyRulesetRoutes(app);
  const server = await new Promise((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  t.after(() => new Promise((done) => server.close(() => { rmSync(root, { recursive: true, force: true }); done(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  return { call, home, dataHome, project, dirs, installer, make };
}

test('GET /api/setup/rules reports every host, the pasted copies and the notice', async (t) => {
  const { call, dirs, project } = await startApp(t);
  writeFileSync(join(dirs.codex, 'config.toml'), '[mcp_servers.SynaBun]\ncommand = "node"\n');
  writeFileSync(join(project, 'AGENTS.md'), `# Project\n\n${LEGACY_TEXT}\n`);

  const { status, json } = await call('GET', '/api/setup/rules');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json).sort(), ['autoUpdate', 'hosts', 'legacy', 'notice', 'ok', 'version']);
  assert.equal(json.ok, true);
  assert.equal(json.version, readRulesetManifest().version);
  assert.equal(json.autoUpdate, true);
  assert.deepEqual(Object.keys(json.hosts), [...RULESET_HOSTS]);
  for (const host of RULESET_HOSTS) for (const key of HOST_KEYS) assert.ok(key in json.hosts[host], `${host}.${key}`);
  assert.deepEqual(json.hosts.cursor, { ...json.hosts.cursor, carrier: 'none', path: null, state: 'manual', managed: null });
  assert.deepEqual([json.hosts.claude.carrier, json.hosts.opencode.carrier, json.hosts.codex.carrier, json.hosts.gemini.carrier], ['file', 'file', 'block', 'block']);
  assert.equal(json.hosts.claude.path, join(dirs.claude, 'rules', 'synabun.md'));
  assert.equal(json.hosts.codex.path, join(dirs.codex, 'AGENTS.md'));
  assert.equal(json.hosts.gemini.path, join(dirs.gemini, 'GEMINI.md'));
  assert.equal(json.hosts.opencode.path, join(dirs.opencode, 'synabun.md'));
  assert.deepEqual(json.legacy.map(({ path, host, kind }) => ({ path, host, kind })), [{ path: join(project, 'AGENTS.md'), host: 'codex', kind: 'exact' }]);
  assert.deepEqual(json.notice, { kind: 'offer-install', hosts: ['codex'] });
});

test('GET /api/setup/rules/:host/text returns the rendered text', async (t) => {
  const { call } = await startApp(t);
  for (const host of RULESET_HOSTS) {
    const { status, json } = await call('GET', `/api/setup/rules/${host}/text`);
    const rendered = renderRuleset(host);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, host, text: rendered.text, version: rendered.version, hash: rendered.hash });
  }
  const snippet = await call('GET', '/api/setup/rules/coexistence/text');
  assert.equal(snippet.json.copyOnly, true);
  assert.match(snippet.json.text, /\[OtherTool\]/);
  const unknown = await call('GET', '/api/setup/rules/generic/text');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.ok, false);
});

test('POST and DELETE /api/setup/rules/:host install and remove', async (t) => {
  const { call, dirs } = await startApp(t);
  const file = join(dirs.gemini, 'GEMINI.md');
  writeFileSync(file, 'Be terse.\n');

  const installed = await call('POST', '/api/setup/rules/gemini');
  assert.equal(installed.status, 200);
  for (const key of ['ok', 'state', 'path', 'changed', 'backupPath']) assert.ok(key in installed.json, key);
  assert.deepEqual({ ok: installed.json.ok, state: installed.json.state, path: installed.json.path, changed: installed.json.changed }, { ok: true, state: 'installed', path: file, changed: true });
  assert.equal(readFileSync(installed.json.backupPath, 'utf8'), 'Be terse.\n');
  assert.equal((await call('POST', '/api/setup/rules/gemini')).json.changed, false);
  assert.equal((await call('GET', '/api/setup/rules')).json.hosts.gemini.managed, true);

  writeFileSync(file, readFileSync(file, 'utf8').replace('one at a time', 'all at once'));
  const refused = await call('POST', '/api/setup/rules/gemini', {});
  assert.equal(refused.status, 409);
  assert.deepEqual({ ok: refused.json.ok, state: refused.json.state, changed: refused.json.changed }, { ok: false, state: 'modified', changed: false });
  const forced = await call('POST', '/api/setup/rules/gemini', { force: true });
  assert.deepEqual([forced.status, forced.json.state, forced.json.changed], [200, 'installed', true]);

  const removed = await call('DELETE', '/api/setup/rules/gemini');
  assert.deepEqual({ status: removed.status, ok: removed.json.ok, state: removed.json.state, changed: removed.json.changed }, { status: 200, ok: true, state: 'not-installed', changed: true });
  assert.equal(readFileSync(file, 'utf8'), 'Be terse.\n');
  assert.equal((await call('GET', '/api/setup/rules')).json.hosts.gemini.managed, false);

  assert.equal((await call('POST', '/api/setup/rules/nope')).status, 400);
  assert.equal((await call('DELETE', '/api/setup/rules/nope')).status, 400);
  const cursor = await call('POST', '/api/setup/rules/cursor');
  assert.deepEqual([cursor.status, cursor.json.state, cursor.json.changed], [200, 'manual', false]);
});

test('DELETE leaves an edited copy to the user (200, kept); force removes it; damaged markers are a 409', async (t) => {
  const { call, dirs } = await startApp(t);
  const cases = { claude: join(dirs.claude, 'rules', 'synabun.md'), codex: join(dirs.codex, 'AGENTS.md') };
  writeFileSync(cases.codex, 'Mine.\n');
  for (const [host, file] of Object.entries(cases)) {
    assert.equal((await call('POST', `/api/setup/rules/${host}`)).status, 200);
    const edited = readFileSync(file, 'utf8').replace('one at a time', 'all at once');
    writeFileSync(file, edited);

    const kept = await call('DELETE', `/api/setup/rules/${host}`);
    assert.equal(kept.status, 200, host);
    assert.deepEqual({ ok: kept.json.ok, state: kept.json.state, changed: kept.json.changed, kept: kept.json.kept },
      { ok: true, state: 'modified', changed: false, kept: [{ path: file, reason: 'edited' }] }, host);
    assert.match(kept.json.message, /was edited, so SynaBun left it in place and no longer manages it/, host);
    assert.equal(readFileSync(file, 'utf8'), edited, host);
    const status = (await call('GET', '/api/setup/rules')).json.hosts[host];
    assert.deepEqual([status.state, status.managed, 'partialRemoval' in status], ['modified', false, false], host);

    // Connecting again is an install on an edited copy: 409 modified, Replace offered.
    const again = await call('POST', `/api/setup/rules/${host}`);
    assert.deepEqual([again.status, again.json.state], [409, 'modified'], host);

    // force: as a query on one, as a JSON body on the other.
    const forced = host === 'claude' ? await call('DELETE', '/api/setup/rules/claude?force=1') : await call('DELETE', '/api/setup/rules/codex', { force: true });
    assert.deepEqual({ status: forced.status, ok: forced.json.ok, state: forced.json.state, changed: forced.json.changed, kept: forced.json.kept },
      { status: 200, ok: true, state: 'not-installed', changed: true, kept: undefined }, host);
    assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : null, host === 'codex' ? 'Mine.\n' : null, host);
  }

  // Damaged markers are refused, forced or not: 409 REMOVE_INCOMPLETE, still managed, and the status says what stayed.
  const file = join(dirs.gemini, 'GEMINI.md');
  assert.equal((await call('POST', '/api/setup/rules/gemini')).status, 200);
  const twice = `${readFileSync(file, 'utf8')}\n${readFileSync(file, 'utf8')}`;
  writeFileSync(file, twice);
  for (const path of ['/api/setup/rules/gemini', '/api/setup/rules/gemini?force=true']) {
    const refused = await call('DELETE', path);
    assert.equal(refused.status, 409, path);
    assert.deepEqual({ ok: refused.json.ok, code: refused.json.code, state: refused.json.state, partial: refused.json.partial, managed: refused.json.managed, kept: refused.json.kept },
      { ok: false, code: 'REMOVE_INCOMPLETE', state: 'conflict', partial: true, managed: true, kept: [{ path: file, reason: 'conflict' }] }, path);
  }
  assert.equal(readFileSync(file, 'utf8'), twice);
  const host = (await call('GET', '/api/setup/rules')).json.hosts.gemini;
  assert.deepEqual([host.state, host.managed, host.partialRemoval.paths], ['conflict', true, [file]]);
});

test('the MCP toggles remove without force, and their `rules` object says which edited copy stayed', async (t) => {
  // server.js hands the installer's own result back as `rules`, and never asks for force on a disconnect.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const sync = server.slice(server.indexOf('function syncRulesWithMcp(host, action, body) {'), server.indexOf('// GET/POST/DELETE /api/setup/rules/*'));
  assert.match(sync, /return rulesetInstaller\.remove\(host\);/);
  assert.doesNotMatch(sync, /force/);
  for (const host of ['claude', 'gemini', 'codex', 'opencode']) assert.match(server, new RegExp(`rules: syncRulesWithMcp\\('${host}', 'remove'\\)|response\\.rules = syncRulesWithMcp\\('${host}', 'remove'\\)`), host);

  // A toggle succeeds whatever the rules answer: syncRulesWithMcp returns the installer's result, or the message of
  // what it threw, and each route puts that under `rules` next to its own `ok: true`.
  assert.match(sync, /return rulesetInstaller\.install\(host\);/);
  assert.match(sync, /\} catch \(err\) \{\s*console\.warn\(`\[rulesets\] \$\{action\} \$\{host\} failed: \$\{err\.message\}`\);\s*return \{ ok: false, error: err\.message \};/);

  // What that call answers for an edited copy: the `rules` a toggle's DELETE carries.
  const { installer, dirs, make } = await startApp(t);
  // And while another SynaBun process holds the rules lock: an answer, not an exception, with the sentence to show.
  const waiting = make({ lockTimeoutMs: 50 });
  const other = createWriterLock(installer.lockPath, { timeoutMs: 50 });
  t.after(() => { other.close(); waiting.close(); installer.close(); });
  other.enter();
  for (const rules of [waiting.install('claude'), waiting.remove('claude')]) {
    assert.deepEqual([rules.ok, rules.code, rules.retryable, rules.changed], [false, 'BUSY', true, false]);
    assert.equal(rules.error, 'Another SynaBun process is working on the rules right now, so nothing was changed. Try again in a moment.');
  }
  other.leave();
  for (const [host, file] of [['claude', join(dirs.claude, 'rules', 'synabun.md')], ['gemini', join(dirs.gemini, 'GEMINI.md')], ['opencode', join(dirs.opencode, 'synabun.md')]]) {
    installer.install(host);
    writeFileSync(file, readFileSync(file, 'utf8').replace('one at a time', 'all at once'));
    const rules = installer.remove(host);
    assert.deepEqual({ ok: rules.ok, changed: rules.changed, kept: rules.kept, path: rules.path }, { ok: true, changed: false, kept: [{ path: file, reason: 'edited' }], path: file }, host);
    assert.ok(existsSync(file), host);
  }
  // The UI reads it: Settings and onboarding both say the edited rules were left in place, with the path, and both
  // show the sentence of a `rules` that failed.
  const settings = readFileSync(new URL('../public/shared/ui-settings.js', import.meta.url), 'utf8');
  const onboarding = readFileSync(new URL('../public/onboarding.html', import.meta.url), 'utf8');
  assert.match(settings, /if \(data\.rules\?\.ok === false && data\.rules\.error\) showCCToast\(data\.rules\.error, 6000\);/);
  assert.match(onboarding, /\} else if \(rules && rules\.ok === false && rules\.error\) \{/);
  // Settings asks i18n for the sentence (settings.redesign.setup.*); the wizard still carries it inline.
  assert.match(settings, /else if \(!nowOn && data\.rules\?\.kept\?\.length\) showCCToast\(kit\.tx\('settings\.redesign\.setup\.yourRulesWereLeftInPlace', \{ reason: data\.rules\.kept\[0\]\.reason === 'listed-in-config' \? '' : \(kit\.tx\('settings\.redesign\.setup\.edited'\) \+ " "\), path: data\.rules\.kept\[0\]\.path \}\), 6000\);/);
  const setupCopy = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8')).settings.redesign.setup;
  assert.deepEqual([setupCopy.yourRulesWereLeftInPlace, setupCopy.edited], ['Your {reason}rules were left in place: {path}', 'edited']);
  assert.match(onboarding, /text = `Your \$\{rules\.kept\[0\]\.reason === 'listed-in-config' \? '' : 'edited '\}rules were left in place: \$\{rules\.kept\[0\]\.path\}`;/);
});

test('POST with force never settles a marker conflict: 409 with the way out, for a file and for a block', async (t) => {
  const { call, dirs } = await startApp(t);
  const cases = { claude: join(dirs.claude, 'rules', 'synabun.md'), gemini: join(dirs.gemini, 'GEMINI.md') };
  mkdirSync(join(dirs.claude, 'rules'));
  for (const [host, file] of Object.entries(cases)) {
    assert.equal((await call('POST', `/api/setup/rules/${host}`)).status, 200);
    const text = `${readFileSync(file, 'utf8')}\n${readFileSync(file, 'utf8')}`;
    writeFileSync(file, text);
    const refused = await call('POST', `/api/setup/rules/${host}`, { force: true });
    assert.equal(refused.status, 409, host);
    assert.deepEqual({ ok: refused.json.ok, state: refused.json.state, changed: refused.json.changed }, { ok: false, state: 'conflict', changed: false }, host);
    assert.match(refused.json.error, /More than one SynaBun rules block.*then install again\./, host);
    assert.equal(readFileSync(file, 'utf8'), text, host);
  }
  // An owned file without markers is the user's own: the status tells the UI not to offer Replace.
  writeFileSync(cases.claude, 'My own notes.\n');
  const host = (await call('GET', '/api/setup/rules')).json.hosts.claude;
  assert.deepEqual([host.state, host.replaceable], ['modified', false]);
  assert.equal((await call('POST', '/api/setup/rules/claude', { force: true })).status, 409);
  assert.equal(readFileSync(cases.claude, 'utf8'), 'My own notes.\n');
});

test('a file that changed underneath is a 409 CHANGED_UNDERNEATH, and it is left as the other writer had it', async (t) => {
  // Another writer gets in between the installer's look at a file and its write. The route says so; nothing is retried.
  let racing = null;
  const { call, dirs, project } = await startApp(t, {
    installerOptions: { hooks: { beforeCommit: (path) => { if (path === racing) { racing = null; appendFileSync(path, 'A line someone else added.\n'); } } } },
  });
  const file = join(dirs.gemini, 'GEMINI.md');
  writeFileSync(file, 'Be terse.\n');
  racing = file;
  const refused = await call('POST', '/api/setup/rules/gemini', {});
  assert.deepEqual([refused.status, refused.json.ok, refused.json.code, refused.json.state, refused.json.changed], [409, false, 'CHANGED_UNDERNEATH', 'error', false]);
  assert.match(refused.json.error, /changed while SynaBun was about to write it, so nothing was written\. Try again\./);
  assert.equal(readFileSync(file, 'utf8'), 'Be terse.\nA line someone else added.\n');
  // Trying again is all it takes.
  assert.equal((await call('POST', '/api/setup/rules/gemini', {})).status, 200);
  assert.match(readFileSync(file, 'utf8'), /^Be terse\.\nA line someone else added\.\n\n<!-- synabun:rules:begin /);

  const legacy = join(project, 'CLAUDE.md');
  writeFileSync(legacy, `# Project\n\n${LEGACY_TEXT}\n`);
  racing = legacy;
  const pasted = await call('POST', '/api/setup/rules/legacy/remove', { path: legacy });
  assert.deepEqual([pasted.status, pasted.json.code, pasted.json.changed], [409, 'CHANGED_UNDERNEATH', false]);
  assert.equal(readFileSync(legacy, 'utf8'), `# Project\n\n${LEGACY_TEXT}\nA line someone else added.\n`);
});

test('a rules lock another SynaBun process holds is a 409 BUSY on every writing route: retryable, one plain sentence, nothing changed', async (t) => {
  // A second connection to the same lock stands in for the other process: it is inside its own operation.
  const { call, dirs, dataHome, project, installer } = await startApp(t, { installerOptions: { lockTimeoutMs: 60 } });
  const legacy = join(project, 'CLAUDE.md');
  writeFileSync(legacy, `# Project\n\n${LEGACY_TEXT}\n`);
  const other = createWriterLock(installer.lockPath, { timeoutMs: 60 });
  t.after(() => { other.close(); installer.close(); });
  other.enter();
  const routes = [
    ['POST', '/api/setup/rules/gemini', {}],
    ['DELETE', '/api/setup/rules/gemini', {}],
    ['POST', '/api/setup/rules/install-all', { hosts: ['gemini'] }],
    ['PUT', '/api/setup/rules/settings', { autoUpdate: false }],
    ['POST', '/api/setup/rules/legacy/remove', { path: legacy }],
    ['POST', '/api/setup/rules/notice/ack', {}],
  ];
  for (const [method, path, body] of routes) {
    const { status, json } = await call(method, path, body);
    assert.deepEqual([status, json.ok, json.code, json.retryable], [409, false, 'BUSY', true], `${method} ${path}`);
    assert.equal(json.error, 'Another SynaBun process is working on the rules right now, so nothing was changed. Try again in a moment.', `${method} ${path}`);
  }
  assert.equal(existsSync(join(dataHome, 'data', 'rulesets.json')), false, 'no state was saved');
  assert.equal(existsSync(join(dirs.gemini, 'GEMINI.md')), false, 'no carrier was written');
  assert.equal(readFileSync(legacy, 'utf8'), `# Project\n\n${LEGACY_TEXT}\n`, 'the pasted copy is where it was');
  // Reading takes no lock.
  const status = await call('GET', '/api/setup/rules');
  assert.deepEqual([status.status, status.json.ok, status.json.hosts.gemini.state], [200, true, 'not-installed']);
  assert.equal((await call('GET', '/api/setup/rules/gemini/text')).status, 200);

  // The other process is done: the same requests go through, one save each.
  other.leave();
  assert.equal((await call('POST', '/api/setup/rules/gemini', {})).status, 200);
  assert.equal((await call('PUT', '/api/setup/rules/settings', { autoUpdate: false })).status, 200);
  assert.equal((await call('POST', '/api/setup/rules/legacy/remove', { path: legacy })).status, 200);
  const settled = JSON.parse(readFileSync(join(dataHome, 'data', 'rulesets.json'), 'utf8'));
  assert.deepEqual([settled.autoUpdate, settled.hosts.gemini.managed, settled.revision], [false, true, 2]);
  assert.deepEqual(readdirSync(join(dataHome, 'data')).sort(), ['rulesets-lock.db', 'rulesets.json']);
});

test('a lock file that cannot be used is a 500 LOCK_UNAVAILABLE on every writing route, and nothing runs unlocked', async (t) => {
  const { call, dirs, dataHome, project, installer } = await startApp(t);
  t.after(() => installer.close());
  const legacy = join(project, 'CLAUDE.md');
  writeFileSync(legacy, `# Project\n\n${LEGACY_TEXT}\n`);
  mkdirSync(join(dataHome, 'data', 'rulesets-lock.db'), { recursive: true }); // a directory where the lock file belongs
  const routes = [
    ['POST', '/api/setup/rules/gemini', {}],
    ['DELETE', '/api/setup/rules/gemini', {}],
    ['POST', '/api/setup/rules/install-all', {}],
    ['PUT', '/api/setup/rules/settings', { autoUpdate: false }],
    ['POST', '/api/setup/rules/legacy/remove', { path: legacy }],
    ['POST', '/api/setup/rules/notice/ack', {}],
  ];
  for (const [method, path, body] of routes) {
    const { status, json } = await call(method, path, body);
    assert.deepEqual([status, json.ok, json.code, json.retryable], [500, false, 'LOCK_UNAVAILABLE', false], `${method} ${path}`);
    assert.match(json.error, /^SynaBun could not use its rules lock \(.*rulesets-lock\.db\): .+\. Nothing was changed\.$/, `${method} ${path}`);
  }
  assert.deepEqual(readdirSync(join(dataHome, 'data')), ['rulesets-lock.db']);
  assert.equal(existsSync(join(dirs.gemini, 'GEMINI.md')), false);
  assert.equal(readFileSync(legacy, 'utf8'), `# Project\n\n${LEGACY_TEXT}\n`);
  assert.equal((await call('GET', '/api/setup/rules')).status, 200);
});

test('a file that vanishes while it is being taken out is a 409, never a 500 with a raw ENOENT', async (t) => {
  let vanishing = null;
  const gone = (path) => { if (path === vanishing) { vanishing = null; rmSync(path); } };
  for (const seam of ['beforeCommit', 'afterCheck']) {
    const { call, dirs, project, installer } = await startApp(t, { installerOptions: { hooks: { [seam]: gone } } });
    t.after(() => installer.close());
    // The pasted-copy removal: the documented, retryable CHANGED_UNDERNEATH.
    const legacy = join(project, 'CLAUDE.md');
    writeFileSync(legacy, `# Project\n\n${LEGACY_TEXT}\n`);
    if (seam === 'beforeCommit') {
      vanishing = legacy;
      const pasted = await call('POST', '/api/setup/rules/legacy/remove', { path: legacy });
      assert.deepEqual([pasted.status, pasted.json.code, pasted.json.changed], [409, 'CHANGED_UNDERNEATH', false]);
      assert.match(pasted.json.error, /CLAUDE\.md changed while SynaBun was about to write it, so nothing was written\. Try again\./);
    }
    // An owned file that disappears under DELETE, before the look or between the look and the unlink.
    assert.equal((await call('POST', '/api/setup/rules/claude', {})).status, 200);
    vanishing = join(dirs.claude, 'rules', 'synabun.md');
    const removed = await call('DELETE', '/api/setup/rules/claude', {});
    assert.deepEqual([removed.status, removed.json.ok, removed.json.code], [409, false, 'REMOVE_INCOMPLETE'], seam);
    assert.match(removed.json.error, /synabun\.md changed while SynaBun was about to write it, so nothing was written\. Try again\./, seam);
    assert.doesNotMatch(removed.json.error, /ENOENT|no such file/, seam);
    assert.equal((await call('DELETE', '/api/setup/rules/claude', {})).status, 200, `${seam}: asked again, a plain success`);
  }
});

test('a backup never opens the rules lock file and a restore never replaces it: the lock holds across both', async (t) => {
  // Another SynaBun process on the same home: one operation, giving up on the lock after 150 ms.
  const installerUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'rulesets', 'installer.js')).href;
  const script = `
    import { createRulesetInstaller } from ${JSON.stringify(installerUrl)};
    const [home, dataHome] = process.argv.slice(-2);
    const result = createRulesetInstaller({ home, dataHome, env: {}, legacyHashes: [], lockTimeoutMs: 150 }).ackNotice();
    process.stdout.write(JSON.stringify({ ok: result.ok, code: result.code || null }));
  `;
  let probe = null;
  let seen = null;
  const { home, dataHome, dirs, installer } = await startApp(t, {
    installerOptions: { lockTimeoutMs: 150, hooks: { afterInspect: () => { if (probe) { seen = probe(); probe = null; } } } },
  });
  const otherProcess = () => {
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, home, dataHome], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const out = mkdtempSync(join(tmpdir(), 'synabun-rules-restore-'));
  t.after(() => { installer.close(); rmSync(out, { recursive: true, force: true }); });

  // The installer has run one operation: its connection is open, on the lock file as it is now.
  assert.equal(installer.install('claude').ok, true);
  const lockPath = installer.lockPath;
  const identity = () => { const info = statSync(lockPath, { bigint: true }); return `${info.dev}:${info.ino}`; };
  const live = identity();
  assert.deepEqual([...LOCK_ONLY_DATA_FILES], [LOCK_FILE_NAME]);
  for (const name of [LOCK_FILE_NAME, `${LOCK_FILE_NAME}-journal`, `${LOCK_FILE_NAME}-wal`, `${LOCK_FILE_NAME}-shm`, LOCK_FILE_NAME.toUpperCase()]) assert.equal(isLockOnlyDataFile(name), true, name);
  for (const name of ['rulesets.json', `${LOCK_FILE_NAME}.bak`, 'memory.db', 'lock.db']) assert.equal(isLockOnlyDataFile(name), false, name);

  // 1. A backup, taken while this process is inside the lock: the file is not in the archive, and the lock is not
  // dropped by the backup having looked at it (closing a descriptor on the file would do that).
  const held = createWriterLock(lockPath, { timeoutMs: 50 });
  t.after(() => held.close());
  held.enter();
  const snapshot = await createVerifiedBackup({ dataHome, folderPath: join(out, 'backups'), kind: 'scheduled' });
  const archived = (await verifyBackupArchive(snapshot.path)).files;
  assert.ok(archived.includes('data/rulesets.json'), 'the state is backed up');
  assert.deepEqual(archived.filter((name) => name.toLowerCase().includes('rulesets-lock')), [], 'the lock file is not');
  assert.deepEqual(otherProcess(), { ok: false, code: 'BUSY' }, 'still held after the backup');
  held.leave();
  assert.deepEqual(otherProcess(), { ok: true, code: null });

  // 2. A restore of an archive that carries a lock file, its SQLite side files and the state.
  const restoredState = `${JSON.stringify({ revision: 41, autoUpdate: false, hosts: {} }, null, 2)}\n`;
  const files = {
    'data/rulesets-lock.db': 'SQLite format 3\u0000 from another machine',
    'data/rulesets-lock.db-journal': 'journal',
    'data/rulesets-lock.db-wal': 'wal',
    'data/rulesets-lock.db-shm': 'shm',
    'data/RULESETS-LOCK.DB': 'another letter case',
    'data/nested/../rulesets-lock.db': 'by a detour',
    'data/rulesets.json': restoredState,
    'data/other.json': '{"kept":true}\n',
  };
  const zipPath = join(out, 'restore.zip');
  await new Promise((done, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip');
    output.on('close', done);
    archive.on('error', reject);
    archive.pipe(output);
    for (const [name, data] of Object.entries(files)) archive.append(data, { name: `${BACKUP_PREFIX}/${name}` });
    archive.finalize().catch(reject);
  });
  const roots = { data: join(dataHome, 'data'), mcpData: join(dataHome, 'mcp-data') };
  for (const rel of Object.keys(files).filter((name) => name.toLowerCase().includes('rulesets-lock'))) assert.equal(restoreTargetFor(rel, roots), null, rel);
  const zip = await openZipArchive(zipPath);
  const { writes, unsafe } = planRestoreWrites(zip, BACKUP_PREFIX, roots);
  // What the restore route does with a plan: every write it lists, and nothing else.
  for (const { entry, target } of writes) await extractZipEntry(zip, entry, target);
  await zip.close();
  assert.deepEqual([unsafe, writes.map((write) => write.rel).sort()], [[], ['data/other.json', 'data/rulesets.json']]);
  assert.equal(identity(), live, 'the live lock file is the same file: same device, same inode');
  assert.equal(statSync(lockPath).size, 0, 'and still empty');
  assert.deepEqual(readdirSync(join(dataHome, 'data')).sort(), ['other.json', LOCK_FILE_NAME, 'rulesets.json'].sort(), 'no side file, no second spelling, no temp file');
  assert.equal(readFileSync(join(dataHome, 'data', 'rulesets.json'), 'utf8'), restoredState, 'the state file is restored as the archive had it');

  // The installer whose connection was open before the restore still keeps another process out while it works...
  probe = otherProcess;
  assert.equal(installer.install('gemini').ok, true);
  assert.deepEqual(seen, { ok: false, code: 'BUSY' }, 'a child process cannot take the lock while the installer is inside its operation');
  // ...and is on the same file as everyone else afterwards.
  assert.deepEqual(otherProcess(), { ok: true, code: null });
  assert.equal(identity(), live);
  // The restored state is what the next operation loaded: the older revision counts on from there.
  const state = JSON.parse(readFileSync(join(dataHome, 'data', 'rulesets.json'), 'utf8'));
  assert.deepEqual([state.revision, state.autoUpdate, state.hosts.gemini.managed, state.hosts.claude.managed], [42, false, true, null]);
  assert.ok(existsSync(join(dirs.claude, 'rules', 'synabun.md')), 'the copy the restored state does not know is left on disk');
});

test('a CLI that is not installed is a 409 with the reason, and no directory appears', async (t) => {
  const { call, dirs } = await startApp(t, { clis: ['gemini'] });
  const result = await call('POST', '/api/setup/rules/codex');
  assert.equal(result.status, 409);
  assert.deepEqual({ ok: result.json.ok, state: result.json.state, changed: result.json.changed }, { ok: false, state: 'not-installed', changed: false });
  assert.match(result.json.error, /does not seem to be installed/);
  assert.equal(existsSync(dirs.codex), false);
});

test('install-all, settings, legacy/remove and notice/ack are literal routes, not hosts', async (t) => {
  const { call, dirs, project } = await startApp(t);
  writeFileSync(join(dirs.gemini, 'settings.json'), JSON.stringify({ mcpServers: { SynaBun: { command: 'node' } } }));
  writeFileSync(join(project, 'CLAUDE.md'), `# Project\n\n${LEGACY_TEXT}\n\n## Build\n`);

  const all = await call('POST', '/api/setup/rules/install-all');
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(all.json.results), ['gemini']);
  assert.deepEqual([all.json.ok, all.json.changed, all.json.status.hosts.gemini.state, all.json.status.hosts.claude.state], [true, true, 'installed', 'not-installed']);
  const picked = await call('POST', '/api/setup/rules/install-all', { hosts: ['claude', 'cursor', 'bogus'] });
  assert.deepEqual(Object.keys(picked.json.results), ['claude']);

  const off = await call('PUT', '/api/setup/rules/settings', { autoUpdate: false });
  assert.deepEqual([off.status, off.json], [200, { ok: true, autoUpdate: false }]);
  assert.equal((await call('GET', '/api/setup/rules')).json.autoUpdate, false);
  assert.equal((await call('PUT', '/api/setup/rules/settings', { autoUpdate: 'no' })).status, 400);

  assert.equal((await call('POST', '/api/setup/rules/legacy/remove', {})).status, 400);
  const outside = await call('POST', '/api/setup/rules/legacy/remove', { path: join(project, '..', 'home', '.claude.json') });
  assert.equal(outside.status, 403);
  const removed = await call('POST', '/api/setup/rules/legacy/remove', { path: join(project, 'CLAUDE.md') });
  assert.deepEqual([removed.status, removed.json.ok, removed.json.changed, removed.json.removed], [200, true, true, 1]);
  assert.equal(readFileSync(join(project, 'CLAUDE.md'), 'utf8'), '# Project\n\n## Build\n');
  assert.equal(readFileSync(removed.json.backupPath, 'utf8'), `# Project\n\n${LEGACY_TEXT}\n\n## Build\n`);

  const ack = await call('POST', '/api/setup/rules/notice/ack');
  assert.deepEqual([ack.status, ack.json], [200, { ok: true, notice: null }]);
});

test('the pre-2.0 endpoints keep their shapes and are answered by the renderer', async (t) => {
  const { call } = await startApp(t);
  for (const [format, host] of [['claude', 'claude'], ['codex', 'codex'], ['cursor', 'cursor'], ['generic', 'opencode'], ['gemini', 'gemini']]) {
    const { status, json } = await call('GET', `/api/claude-code/ruleset?format=${format}`);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, ruleset: renderRuleset(host).text, format });
  }
  assert.deepEqual((await call('GET', '/api/claude-code/ruleset')).json.format, 'claude');
  const claude = (await call('GET', '/api/claude-code/ruleset?format=claude')).json.ruleset;
  assert.doesNotMatch(claude, /Coexistence|\[OtherTool\]/, 'the claude format no longer carries the coexistence snippet');
  const coexistence = await call('GET', '/api/claude-code/ruleset?format=coexistence');
  assert.equal(coexistence.json.ok, true);
  assert.match(coexistence.json.ruleset, /\[OtherTool\]/);
  const invalid = await call('GET', '/api/claude-code/ruleset?format=nope');
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /Invalid format: nope/);

  const versions = await call('GET', '/api/claude-code/ruleset/versions');
  const manifest = readRulesetManifest();
  assert.equal(versions.status, 200);
  assert.equal(versions.json.ok, true);
  assert.deepEqual(Object.keys(versions.json.formats), ['claude', 'codex', 'cursor', 'generic', 'gemini']);
  for (const entry of Object.values(versions.json.formats)) {
    assert.deepEqual(entry, { fingerprint: `v:${manifest.version}`, version: manifest.version, summary: manifest.summary, updatedAt: manifest.updatedAt, source: 'manifest' });
  }
});

test('server.js wires the installer: routes, MCP toggles, setup status and boot', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /registerRulesetRoutes\(app, \{ installer: rulesetInstaller \}\)/);
  assert.match(server, /registerLegacyRulesetRoutes\(app\)/);
  assert.match(server, /'\/api\/connections', '\/api\/setup', '\/api\/system'/, '/api/setup stays admin-only');
  for (const host of ['claude', 'gemini', 'codex', 'opencode']) {
    assert.match(server, new RegExp(`syncRulesWithMcp\\('${host}', 'install', req\\.body\\)`), `${host} POST installs the rules`);
    assert.match(server, new RegExp(`syncRulesWithMcp\\('${host}', 'remove'\\)`), `${host} DELETE removes them`);
  }
  assert.match(server, /if \(body\?\.rules === false\) return \{ ok: true, skipped: true \}/, 'rules:false skips the install');
  assert.match(server, /res\.json\(\{ ok: true, claude, gemini, codex, opencode, rules, paths:/, '/api/setup/status carries rules');
  const dedupe = server.indexOf('const dedupStats = dedupeAllSettingsHooks();');
  // Synchronous file checks and no lock: nothing in the listen callback can wait.
  assert.equal([...server.matchAll(/rulesetInstaller\.reconcile\(/g)].length, 1, 'the boot is the only reconcile');
  const reconcile = server.indexOf('rulesetInstaller.reconcile()');
  assert.ok(dedupe !== -1 && reconcile > dedupe && reconcile - dedupe < 2500, 'reconcile runs at boot right after the hook dedupe');
  const boot = server.slice(reconcile - 400, reconcile + 1000);
  assert.match(boot, /try \{[\s\S]*rulesetInstaller\.reconcile\(\)[\s\S]*\} catch \(err\) \{\s*console\.warn\('  Rules reconcile warning:'/, 'a reconcile failure only logs');
  assert.doesNotMatch(boot, /LOCKED|wait: false|another SynaBun process is changing the rules/, 'there is no lock to find held');
  assert.doesNotMatch(server, /rulesets\.lock|lockWaitMs/);
  assert.doesNotMatch(server, /\/api\/setup\/write-instructions/, 'the caller-less write-instructions route is gone');
  assert.doesNotMatch(server, /CLAUDE-template\.md|ruleset-versions\.json/, 'nothing reads the old template');
  assert.match(server, /linkSharedCodexResource\(resolve\(home, 'AGENTS\.md'\)/, 'new Codex accounts share the global AGENTS.md');
});
