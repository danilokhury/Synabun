// Review 4 of the Claude panel parity build (the release gate), browser side.
// T06: the panel looks a session's owning project up in the catalogue of the
//      tab's Claude account, not always the default one.
// W03: the Skills Studio import asks before a bundle replaces files that
//      already exist, and sends the overwrite only after a yes.
// api.js has no imports and runs in Node with a stand-in fetch; the two UI
// files are checked by source contract (they cannot be imported in Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as api from '../public/shared/api.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(HERE, '..', 'public', 'shared', ...p), 'utf8').replace(/\r\n/g, '\n');
const panel = read('ui-claude-panel.js');
const skills = read('ui-skills.js');
const apiSrc = read('api.js');
const fn = (src, name) => new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(src)?.[0] || '';
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

// A stand-in for fetch: records the requests, answers from a queue.
function withFetch(answers, run) {
  const calls = [];
  const events = [];
  const before = { fetch: globalThis.fetch, window: globalThis.window, CustomEvent: globalThis.CustomEvent };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    const a = answers.shift() || { status: 200, body: {} };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.body === undefined) throw new Error('no body'); return a.body; } };
  };
  globalThis.window = { dispatchEvent: (e) => events.push(e) };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  return Promise.resolve(run(calls, events)).finally(() => {
    globalThis.fetch = before.fetch;
    if (before.window === undefined) delete globalThis.window; else globalThis.window = before.window;
    if (before.CustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = before.CustomEvent;
  });
}

// ── T06 ──

test('T06: the session list is asked for the tab\'s account, and for the default account exactly as before', async () => {
  await withFetch([{ status: 200, body: { projects: [] } }, { status: 200, body: { projects: [] } }, { status: 200, body: { projects: [] } }, { status: 200, body: { projects: [] } }], async (calls) => {
    await api.fetchClaudeSessions({ search: SID, limit: 5, account: 'work' });
    assert.equal(new URL(calls[0].url, 'http://x').searchParams.get('account'), 'work');
    assert.equal(new URL(calls[0].url, 'http://x').searchParams.get('search'), SID);
    // The default account: the request the menu has always made.
    await api.fetchClaudeSessions({ search: SID, limit: 5 });
    await api.fetchClaudeSessions({ search: SID, limit: 5, account: '' });
    await api.fetchClaudeSessions({ search: SID, limit: 5, account: 'default' });
    for (const c of calls.slice(1)) assert.equal(c.url, `/api/claude-code/sessions?limit=5&search=${SID}`);
  });
});

test('T06: the panel passes the tab\'s account through the owner lookup', () => {
  const owner = fn(panel, '_transcriptOwner');
  assert.match(owner, /function _transcriptOwner\(sid, project, account\)/);
  assert.match(owner, /fetchClaudeSessions\(\{ search: sid, limit: 5, account: account \|\| '' \}\)/, 'the account reaches the request');
  // The one caller: the history read of a tab, which knows the tab.
  const calls = [...panel.matchAll(/_transcriptOwner\(([^)]*)\)/g)].map(m => m[1]).filter(a => a !== 'sid, project, account');
  assert.deepEqual(calls, ["sid, project, accountTab?.accountId || ''"]);
  // The history read that follows names the same account (it did already).
  assert.match(panel, /if \(accountTab\?\.accountId\) params\.set\('account', accountTab\.accountId\);/);
});

// ── W03 ──

const BUNDLE = { format: 'synabun-skill-bundle', version: 1, type: 'command', name: 'fresh', files: { 'fresh.md': 'new', 'existing.md': 'x' } };
const REFUSAL = { status: 409, body: { error: 'Command "fresh" was not imported: a file it would replace already exists (existing.md). Nothing was written.', code: 'import_exists', existing: ['existing.md'] } };

test('W03: an import never carries the overwrite unless it is asked for', async () => {
  await withFetch([{ status: 200, body: { ok: true, name: 'fresh', type: 'command' } }, { status: 200, body: { ok: true } }], async (calls) => {
    const result = await api.importSkillsBundle(BUNDLE, 'global', '');
    assert.deepEqual(result, { ok: true, name: 'fresh', type: 'command' });
    assert.deepEqual(calls[0], { url: '/api/skills-studio/import', method: 'POST', body: { bundle: BUNDLE, scope: 'global', projectPath: '' } });
    assert.equal('overwrite' in calls[0].body, false);
    await api.importSkillsBundle(BUNDLE, 'project', '/work/app', { overwrite: true });
    assert.deepEqual(calls[1].body, { bundle: BUNDLE, scope: 'project', projectPath: '/work/app', overwrite: true });
  });
});

test('W03: a refused import says which files are in the way', async () => {
  await withFetch([{ ...REFUSAL }, { status: 409, body: { error: 'Skill "kit" already exists. Delete it first.' } }, { status: 500, body: undefined }, { status: 403, body: { error: 'Guests cannot do that' } }], async (calls, events) => {
    await assert.rejects(api.importSkillsBundle(BUNDLE, 'global', ''), (err) => err.code === 'import_exists' && err.existing.join() === 'existing.md' && /existing\.md/.test(err.message));
    // Another refusal (a skill that exists) is an ordinary error: nothing to confirm.
    await assert.rejects(api.importSkillsBundle(BUNDLE, 'global', ''), (err) => err.code === undefined && err.existing === undefined && /Delete it first/.test(err.message));
    await assert.rejects(api.importSkillsBundle(BUNDLE, 'global', ''), /HTTP 500/);
    // A guest is told the way every other request tells them.
    await assert.rejects(api.importSkillsBundle(BUNDLE, 'global', ''), (err) => err.forbidden === true);
    assert.deepEqual(events.map(e => [e.type, e.detail]), [['synabun:forbidden', 'Guests cannot do that']]);
  });
});

test('W03: the import asks before replacing, and replaces only after a yes', async () => {
  // Nothing in the way: nobody is asked.
  await withFetch([{ status: 200, body: { ok: true, name: 'fresh', type: 'command' } }], async (calls) => {
    const asked = [];
    const result = await api.importSkillsBundleAsking(BUNDLE, 'global', '', (existing) => { asked.push(existing); return true; });
    assert.deepEqual(result, { ok: true, name: 'fresh', type: 'command' });
    assert.deepEqual(asked, []);
    assert.equal(calls.length, 1);
  });
  // In the way, and the user says no: nothing more is sent.
  for (const answer of [false, undefined, null, 'yes', 1]) {
    await withFetch([{ ...REFUSAL }], async (calls) => {
      const asked = [];
      const result = await api.importSkillsBundleAsking(BUNDLE, 'global', '', (existing) => { asked.push(existing); return answer; });
      assert.equal(result, null, `answer ${JSON.stringify(answer)} is not a yes`);
      assert.deepEqual(asked, [['existing.md']], 'the question names the files');
      assert.equal(calls.length, 1, 'no second request');
      assert.equal('overwrite' in calls[0].body, false);
    });
  }
  // In the way, and the user says yes: the same bundle again, confirmed.
  await withFetch([{ ...REFUSAL }, { status: 200, body: { ok: true, name: 'fresh', type: 'command' } }], async (calls) => {
    const result = await api.importSkillsBundleAsking(BUNDLE, 'project', '/work/app', async () => true);
    assert.deepEqual(result, { ok: true, name: 'fresh', type: 'command' });
    assert.equal(calls.length, 2);
    assert.equal('overwrite' in calls[0].body, false);
    assert.deepEqual(calls[1].body, { bundle: BUNDLE, scope: 'project', projectPath: '/work/app', overwrite: true });
  });
  // Any other failure is not a question.
  await withFetch([{ status: 409, body: { error: 'Skill "kit" already exists. Delete it first.' } }], async (calls) => {
    let asked = 0;
    await assert.rejects(api.importSkillsBundleAsking(BUNDLE, 'global', '', () => { asked++; return true; }), /Delete it first/);
    assert.equal(asked, 0);
    assert.equal(calls.length, 1);
  });
});

test('W03: the Skills Studio import dialog is the asking import, with a confirm that lists the files', () => {
  const trigger = fn(skills, 'triggerImport');
  assert.ok(trigger, 'triggerImport is there');
  assert.match(trigger, /await importSkillsBundleAsking\(bundle, scope, projectPath, \(existing\) => confirm\(importOverwriteQuestion\(existing\)\)\)/);
  assert.equal(/[^A-Za-z]importSkillsBundle\(/.test(trigger), false, 'no import that skips the question');
  assert.equal(/overwrite/.test(trigger.replace(/importOverwriteQuestion/g, '')), false, 'the dialog never sets the overwrite itself');
  // A no leaves everything as it was, and says so.
  assert.match(trigger, /if \(!result\) \{ toast\('Import cancelled\. Nothing was replaced\.', 'info'\); return; \}/);
  const question = fn(skills, 'importOverwriteQuestion');
  assert.match(question, /existing/);
  assert.match(question, /already exist/);
  assert.match(question, /Replace/);
});

test('W03: every name Skills Studio imports from api.js is exported there', () => {
  const block = /import \{([^}]*)\} from '\.\/api\.js';/.exec(skills);
  assert.ok(block);
  const names = block[1].split(',').map(s => s.trim()).filter(Boolean);
  assert.ok(names.includes('importSkillsBundleAsking'));
  for (const name of names) {
    assert.equal(typeof api[name], 'function', `${name} is exported by api.js`);
    assert.match(apiSrc, new RegExp(`export (?:async )?function ${name}\\(`));
  }
});
