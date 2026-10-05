// Style Guide store (lib/style-guide/store.js): paths and the hash, load / save with revisions and history
// (30 kept), the artifacts a save writes, proposals (the agents' only write path), the project pointers
// and what a dispatched run is told. Every test works in a temp data home and a temp project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkDtcg } from '../lib/style-guide/export-dtcg.js';
import { POINTER_END, findPointer, pointerBlock, pointerText, removePointer, upsertPointer } from '../lib/style-guide/pointers.js';
import { findBlocks, wrap } from '../lib/rulesets/managed-text.js';
import { defaultStyleGuide } from '../lib/style-guide/schema.js';
import {
  EXPORT_FORMATS, HISTORY_COALESCE_MS, HISTORY_LIMIT, StyleGuideError, artifactFiles, createStyleGuideStore, loadStyleGuideForRun,
  renderFormat, styleGuideHash, styleGuidesDir,
} from '../lib/style-guide/store.js';
import { estimateTokens } from '../lib/style-guide/summary.js';

/** A store over a temp data home with one registered project; `clock.at` is what now() answers. */
function sandbox(t, { projects = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synabun-sg-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataHome = join(root, 'data-home');
  const project = join(root, 'project');
  mkdirSync(join(dataHome, 'data'), { recursive: true });
  mkdirSync(project, { recursive: true });
  const clock = { at: Date.parse('2026-10-02T10:00:00.000Z') };
  const store = createStyleGuideStore({ dataHome, projects: projects || (() => [{ path: project, label: 'Acme' }]), now: () => new Date(clock.at) });
  const read = (path) => readFileSync(path, 'utf8');
  return { root, dataHome, project, store, clock, read };
}
const edit = (config, patch) => ({ ...config, ...patch });
const code = (fn, expected) => assert.throws(fn, (error) => error instanceof StyleGuideError && error.code === expected.code && error.status === expected.status, JSON.stringify(expected));

test('paths: one folder in the data home, keyed by sha1(projectPath)[0:16]', (t) => {
  const { dataHome, project, store } = sandbox(t);
  const hash = createHash('sha1').update(project).digest('hex').slice(0, 16);
  assert.equal(styleGuideHash(project), hash);
  assert.equal(styleGuideHash(`${project}/`), hash, 'the resolved path is hashed');
  assert.equal(store.dir, join(dataHome, 'data', 'style-guides'));
  assert.deepEqual(store.paths(project), { hash, json: join(store.dir, `${hash}.json`), history: join(store.dir, `${hash}.history.json`), proposals: join(store.dir, `${hash}.proposals.json`), assets: join(store.dir, 'assets', hash) });
  assert.equal(styleGuidesDir({ dataHome }), store.dir);
  assert.equal(styleGuidesDir({ dataDir: join(dataHome, 'data') }), store.dir);
});

test('resolveProject: any path inside a registered project is that project; the deepest wins; nothing else resolves', (t) => {
  const { root, project } = sandbox(t);
  const inner = join(project, 'packages', 'web');
  const store = createStyleGuideStore({ dataHome: join(root, 'data-home'), projects: () => [{ path: project, label: 'Acme' }, { path: inner }, 'relative/never'] });
  assert.deepEqual(store.resolveProject(project), { path: project, label: 'Acme' });
  assert.deepEqual(store.resolveProject(join(project, 'src', 'app.css')), { path: project, label: 'Acme' });
  assert.deepEqual(store.resolveProject(join(inner, 'src')), { path: inner, label: 'web' }, 'a nested project is its own');
  for (const outside of [root, join(root, 'project-other'), `${project}-suffix`, '/', '', 'relative/path', null, 42]) assert.equal(store.resolveProject(outside), null, String(outside));
  // Without a projects function the registry file is read.
  writeFileSync(join(root, 'data-home', 'data', 'claude-code-projects.json'), JSON.stringify([{ path: project, label: 'From file' }]));
  assert.deepEqual(createStyleGuideStore({ dataHome: join(root, 'data-home') }).listProjects(), [{ path: project, label: 'From file' }]);
});

test('load: defaults until something is saved; a saved v1 file loads as v2; a damaged file never throws', (t) => {
  const { project, store } = sandbox(t);
  assert.deepEqual(store.load(project), { config: defaultStyleGuide(project), saved: false });
  assert.equal(existsSync(store.dir), false, 'reading creates nothing');
  mkdirSync(store.dir, { recursive: true });
  writeFileSync(store.paths(project).json, JSON.stringify({ projectPath: '/somewhere/else', updatedAt: '2026-05-17T00:00:00.000Z', colors: { primary: { 500: '#ff0000' } }, typography: { heading: { family: 'Sora' } }, logo: { variants: [], iconLibrary: 'phosphor', imageryNotes: '' } }));
  const v1 = store.load(project);
  assert.deepEqual([v1.saved, v1.config.schemaVersion, v1.config.projectPath, v1.config.colors.palettes.primary.base, v1.config.typography.fonts.heading.family, v1.config.iconography.library, v1.config.revision], [true, 2, project, '#ff0000', 'Sora', 'phosphor', 0]);
  assert.deepEqual(v1.config.motion, defaultStyleGuide(project).motion, 'every field v1 never had takes its default');
  writeFileSync(store.paths(project).json, '{ not json');
  assert.deepEqual([store.load(project).saved, store.load(project).config.schemaVersion], [true, 2]);
});

test('save: revision + 1, the artifacts in the project, history; a save that changes nothing keeps the revision', (t) => {
  const { project, store, read } = sandbox(t);
  const first = store.save(project, store.load(project).config);
  assert.deepEqual([first.changed, first.config.revision, first.config.updatedAt, first.config.projectPath], [true, 1, '2026-10-02T10:00:00.000Z', project]);
  assert.deepEqual(first.written.map(({ format, path, changed }) => [format, path, changed]), [
    ['design-md', join(project, 'DESIGN.md'), true], ['dtcg', join(project, '.synabun/style-guide/tokens.json'), true],
    ['css', join(project, '.synabun/style-guide/tokens.css'), true], ['tailwind-v4', join(project, '.synabun/style-guide/tailwind.css'), true],
  ]);
  // The four files hold what the exporters produce for the saved config.
  assert.ok(read(join(project, 'DESIGN.md')).startsWith('---\nversion: 2\n'));
  assert.ok(read(join(project, 'DESIGN.md')).endsWith('_Generated by SynaBun Style Guide rev 1 — edit in Neural Interface → Style Guide, not by hand._\n'));
  const tokens = JSON.parse(read(join(project, '.synabun/style-guide/tokens.json')));
  assert.deepEqual(tokens.$extensions['dev.synabun'], { revision: 1, generatedAt: '2026-10-02T10:00:00.000Z', projectPath: project, skipped: [] });
  assert.deepEqual(walkDtcg(tokens).problems, []);
  assert.ok(read(join(project, '.synabun/style-guide/tokens.css')).includes('[data-theme="dark"] {'));
  assert.ok(read(join(project, '.synabun/style-guide/tailwind.css')).includes('@theme {'));
  for (const format of ['design-md', 'dtcg', 'css', 'tailwind-v4']) assert.equal(read(first.written.find((file) => file.format === format).path), renderFormat(first.config, format).text, format);
  assert.deepEqual(store.load(project), { config: first.config, saved: true });
  assert.deepEqual(store.history(project), [{ revision: 1, at: '2026-10-02T10:00:00.000Z', source: 'ui', label: '' }]);
  assert.deepEqual(store.written(project, first.config).map((file) => [file.format, file.exists]), [['design-md', true], ['dtcg', true], ['css', true], ['tailwind-v4', true]]);

  // The same config again: nothing bumps, nothing is rewritten.
  const again = store.save(project, first.config);
  assert.deepEqual([again.changed, again.config.revision, again.config.updatedAt, again.written.map((file) => file.changed)], [false, 1, '2026-10-02T10:00:00.000Z', [false, false, false, false]]);
  assert.equal(store.history(project).length, 1);
  // A deleted artifact comes back on the next save even when nothing changed.
  rmSync(join(project, 'DESIGN.md'));
  assert.equal(store.save(project, first.config).written[0].changed, true);

  // A real change: revision 2, and whatever the caller sent for revision / updatedAt / projectPath is not trusted.
  const second = store.save(project, edit(first.config, { brand: { ...first.config.brand, name: 'Acme' }, revision: 99, updatedAt: 'x', projectPath: '/elsewhere' }), { source: 'import:css', label: 'From the app' });
  assert.deepEqual([second.changed, second.config.revision, second.config.projectPath, second.config.brand.name], [true, 2, project, 'Acme']);
  assert.deepEqual(store.history(project).slice(0, 1), [{ revision: 2, at: '2026-10-02T10:00:00.000Z', source: 'import:css', label: 'From the app' }]);
  assert.match(read(join(project, 'DESIGN.md')), /name: "Acme"/);
  // No stray temp files anywhere.
  for (const dir of [store.dir, project, join(project, '.synabun/style-guide')]) assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], dir);
});

test('artifacts follow the exports flags: only what is on is written, and a generated file that is no longer wanted goes', (t) => {
  const { project, store, read } = sandbox(t);
  const base = store.save(project, store.load(project).config).config;
  const dir = join(project, '.synabun/style-guide');
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  const v3 = store.save(project, edit(base, { exports: { ...base.exports, tailwind: 'v3', tokensJson: false } }));
  assert.deepEqual(v3.written.map((file) => file.format), ['design-md', 'css', 'tailwind-v3']);
  assert.deepEqual(readdirSync(dir).sort(), ['notes.txt', 'tailwind.tokens.cjs', 'tokens.css'], 'tokens.json and tailwind.css were ours, so they are removed');
  assert.match(read(join(dir, 'tailwind.tokens.cjs')), /^\/\* SynaBun Style Guide rev 2: Tailwind v3 theme/);
  // A file with one of our names that the project wrote itself is never removed.
  writeFileSync(join(dir, 'tokens.json'), '{"mine":true}');
  const none = store.save(project, edit(v3.config, { exports: { ...v3.config.exports, tailwind: 'none', cssVars: false, designMd: false } }));
  assert.deepEqual(none.written, []);
  assert.deepEqual(readdirSync(dir).sort(), ['notes.txt', 'tokens.json']);
  assert.equal(read(join(dir, 'tokens.json')), '{"mine":true}');
  assert.ok(existsSync(join(project, 'DESIGN.md')), 'DESIGN.md is left where it is when its export is turned off');
  assert.deepEqual(store.written(project, none.config), []);
  // Explicit formats select only enabled exports and do not remove unrelated files.
  const forced = store.writeArtifacts(project, none.config, { formats: ['dtcg', 'tailwind', 'nope'] });
  assert.deepEqual(forced, []);
  assert.equal(read(join(dir, 'tokens.json')), '{"mine":true}');
  // A custom outDir.
  const moved = store.save(project, edit(none.config, { exports: { ...none.config.exports, cssVars: true, outDir: 'src/styles/tokens' } }));
  assert.deepEqual(moved.written.map((file) => file.path), [join(project, 'src/styles/tokens/tokens.css')]);
  assert.deepEqual(artifactFiles(project, defaultStyleGuide(project)).map((file) => file.relative), ['DESIGN.md', '.synabun/style-guide/tokens.json', '.synabun/style-guide/tokens.css', '.synabun/style-guide/tailwind.css']);
  assert.deepEqual([...EXPORT_FORMATS], ['design-md', 'dtcg', 'css', 'tailwind-v4', 'tailwind-v3']);
  assert.equal(renderFormat(base, 'nope'), null);
});

test('a hand-written DESIGN.md is kept once before the first save replaces it; logos are mirrored into the project', (t) => {
  const { project, store, read } = sandbox(t);
  writeFileSync(join(project, 'DESIGN.md'), '# Our design\n\nWritten by hand.\n');
  const config = store.load(project).config;
  mkdirSync(store.paths(project).assets, { recursive: true });
  writeFileSync(join(store.paths(project).assets, 'logo-a.svg'), '<svg/>');
  config.logo.variants.push({ id: 'logo-a', name: 'A', kind: 'primary', file: 'logo-a.svg', bg: 'white' }, { id: 'logo-b', name: 'Missing', kind: 'icon', file: 'logo-b.png', bg: 'dark' });
  const saved = store.save(project, config);
  const backup = join(project, '.synabun/style-guide/DESIGN.before-synabun.md');
  assert.equal(saved.written[0].backup, backup);
  assert.equal(read(backup), '# Our design\n\nWritten by hand.\n');
  assert.equal(read(join(project, '.synabun/style-guide/logo-a.svg')), '<svg/>');
  assert.equal(existsSync(join(project, '.synabun/style-guide/logo-b.png')), false, 'a variant without a file on disk is skipped');
  assert.match(read(join(project, 'DESIGN.md')), /- \*\*A\*\* \(primary, on white\) — `\.synabun\/style-guide\/logo-a\.svg`/);
  // Our own DESIGN.md is never backed up, and the first backup is never overwritten.
  const next = store.save(project, edit(saved.config, { brand: { ...saved.config.brand, name: 'Acme' } }));
  assert.equal(next.written[0].backup, undefined);
  assert.equal(read(backup), '# Our design\n\nWritten by hand.\n');
});

test('history: newest first, 30 kept, autosaves coalesce, restore brings a design back as a new revision', (t) => {
  const { project, store, clock } = sandbox(t);
  let config = store.load(project).config;
  const name = (n) => edit(config, { brand: { ...config.brand, name: `Rev ${n}` } });
  for (let n = 1; n <= 35; n++) {
    clock.at += HISTORY_COALESCE_MS + 1000;
    config = store.save(project, name(n)).config;
  }
  assert.equal(config.revision, 35);
  const history = store.history(project);
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(HISTORY_LIMIT, 30);
  assert.deepEqual(history.map((row) => row.revision), Array.from({ length: 30 }, (_, i) => 35 - i));
  assert.deepEqual(Object.keys(history[0]), ['revision', 'at', 'source', 'label'], 'the list carries no configs');
  assert.equal(store.historyConfig(project, 5), null, 'revision 5 aged out');
  assert.equal(store.historyConfig(project, 20).brand.name, 'Rev 20');

  // Autosave: unlabeled editor saves a few seconds apart share one entry; a label, another source or a pause starts a new one.
  clock.at += 2000; store.save(project, name('a'));
  clock.at += 2000; store.save(project, name('b'));
  assert.deepEqual(store.history(project).slice(0, 2).map((row) => row.revision), [37, 34], 'revisions 35 and 36 were folded into 37');
  clock.at += 2000; store.save(project, name('c'), { label: 'Before the rebrand' });
  clock.at += 2000; store.save(project, name('d'), { source: 'preset:editorial' });
  clock.at += 2000; store.save(project, name('e'));
  assert.deepEqual(store.history(project).slice(0, 4).map((row) => [row.revision, row.source, row.label]), [[40, 'ui', ''], [39, 'preset:editorial', ''], [38, 'ui', 'Before the rebrand'], [37, 'ui', '']]);

  // Restore: the design of revision 20, the current agent and export settings, a new revision.
  const tuned = store.save(project, edit(store.load(project).config, { agents: { ...config.agents, instructions: 'Ask first.' }, exports: { ...config.exports, tailwind: 'v3' } }), { label: 'settings' }).config;
  const restored = store.restore(project, 20);
  assert.deepEqual([restored.config.revision, restored.config.brand.name, restored.config.agents.instructions, restored.config.exports.tailwind], [tuned.revision + 1, 'Rev 20', 'Ask first.', 'v3']);
  assert.deepEqual(store.history(project)[0], { revision: tuned.revision + 1, at: new Date(clock.at).toISOString(), source: 'restore:20', label: '' });
  code(() => store.restore(project, 3), { code: 'REVISION_NOT_FOUND', status: 404 });
});

test('proposals: the only way an agent changes a guide, and nothing changes until the user accepts', (t) => {
  const { project, store, clock, read } = sandbox(t);
  const patch = { colors: { status: { danger: '#dc2626' } }, shape: { radius: { xl: 20 } } };
  code(() => store.addProposal(project, { changes: patch, reason: 'x' }), { code: 'NOT_SAVED', status: 409 });
  const saved = store.save(project, store.load(project).config).config;
  code(() => store.addProposal(project, { changes: 'nope', reason: 'x' }), { code: 'BAD_CHANGES', status: 400 });
  code(() => store.addProposal(project, { changes: patch, reason: '  ' }), { code: 'NO_REASON', status: 400 });
  code(() => store.addProposal(project, { changes: { colors: { status: { danger: '#ef4444' } } }, reason: 'same' }), { code: 'NO_CHANGE', status: 400 });
  code(() => store.addProposal(project, { changes: { brand: { vibe: 'x'.repeat(70000) } }, reason: 'big' }), { code: 'TOO_LARGE', status: 413 });

  const first = store.addProposal(project, { changes: { ...patch, agents: { allowProposals: false }, exports: { outDir: 'elsewhere' }, revision: 50, projectPath: '/x' }, reason: 'The danger red fails AA on white.', runId: 'run-1', provider: 'codex', model: 'gpt-5' });
  assert.match(first.id, /^prop-[a-z0-9]+$/);
  assert.deepEqual([first.pending, first.ignored], [1, ['projectPath', 'revision', 'agents', 'exports']]);
  assert.deepEqual(first.diff, [{ path: 'colors.status.danger', from: '#ef4444', to: '#dc2626' }, { path: 'shape.radius.xl', from: 16, to: 20 }]);
  assert.deepEqual(store.load(project).config, saved, 'the guide is untouched');
  assert.doesNotMatch(read(join(project, 'DESIGN.md')), /#dc2626/);
  assert.equal(store.history(project).length, 1);

  clock.at += 60000;
  const second = store.addProposal(project, { changes: { brand: { tagline: 'Faster' } }, reason: 'A tagline helps the hero.' });
  assert.equal(second.pending, 2);
  assert.equal(store.pendingCount(project), 2);
  const listed = store.proposals(project);
  assert.deepEqual(listed.map((row) => [row.id, row.status, row.runId, row.provider, row.model, row.reason]), [[second.id, 'pending', null, null, null, 'A tagline helps the hero.'], [first.id, 'pending', 'run-1', 'codex', 'gpt-5', 'The danger red fails AA on white.']]);
  assert.deepEqual(Object.keys(listed[0]), ['id', 'at', 'status', 'decidedAt', 'runId', 'provider', 'model', 'reason', 'changes', 'diff']);
  assert.deepEqual(listed[1].changes, patch, 'the keys a proposal may not carry were dropped');
  assert.deepEqual(listed[1].diff, first.diff);

  // Reject one, accept the other.
  assert.deepEqual(store.rejectProposal(project, second.id), { ok: true });
  const accepted = store.acceptProposal(project, first.id);
  assert.deepEqual([accepted.config.revision, accepted.config.colors.status.danger, accepted.config.shape.radius.xl, accepted.config.brand.tagline], [2, '#dc2626', 20, '']);
  assert.deepEqual(accepted.config.agents, saved.agents);
  assert.match(read(join(project, 'DESIGN.md')), /danger: "#dc2626"/);
  assert.deepEqual(store.history(project)[0], { revision: 2, at: new Date(clock.at).toISOString(), source: `proposal:${first.id}`, label: 'The danger red fails AA on white.' });
  assert.deepEqual(store.proposals(project).map((row) => [row.id, row.status, row.decidedAt]), [[second.id, 'rejected', new Date(clock.at).toISOString()], [first.id, 'accepted', new Date(clock.at).toISOString()]]);
  assert.deepEqual(store.proposals(project, { status: 'accepted' }).map((row) => row.diff), [first.diff], 'a decided proposal keeps the diff it was accepted with');
  assert.deepEqual([store.proposals(project, { status: 'pending' }), store.pendingCount(project)], [[], 0]);
  code(() => store.acceptProposal(project, first.id), { code: 'ALREADY_DECIDED', status: 409 });
  code(() => store.rejectProposal(project, second.id), { code: 'ALREADY_DECIDED', status: 409 });
  code(() => store.acceptProposal(project, 'prop-nope'), { code: 'PROPOSAL_NOT_FOUND', status: 404 });

  // A pending proposal is always diffed against the guide as it is now.
  const third = store.addProposal(project, { changes: { shape: { radius: { xl: 24 } } }, reason: 'Rounder modals.' });
  store.save(project, edit(accepted.config, { shape: { ...accepted.config.shape, radius: { ...accepted.config.shape.radius, xl: 22 } } }), { label: 'manual' });
  assert.deepEqual(store.proposals(project, { status: 'pending' })[0].diff, [{ path: 'shape.radius.xl', from: 22, to: 24 }]);
  assert.equal(third.pending, 1);

  // Turned off by the user: refused with 422.
  store.save(project, edit(store.load(project).config, { agents: { ...saved.agents, allowProposals: false } }), { label: 'off' });
  code(() => store.addProposal(project, { changes: patch, reason: 'x' }), { code: 'PROPOSALS_OFF', status: 422 });
});

test('project pointers: an opt-in block in CLAUDE.md and AGENTS.md, beside SynaBun\'s rules block, removed when turned off', (t) => {
  const { project, store, read } = sandbox(t);
  const rules = wrap('## SynaBun\n- A rule.', { version: '2.1.0', host: 'claude' });
  writeFileSync(join(project, 'CLAUDE.md'), `# Acme\r\n\r\nOur notes.\r\n\r\n${rules.replace(/\n/g, '\r\n')}\r\n`);
  const base = store.save(project, store.load(project).config);
  assert.deepEqual(base.pointers.map((file) => file.state), ['absent', 'absent'], 'off by default: nothing is touched');
  assert.equal(existsSync(join(project, 'AGENTS.md')), false);

  const on = store.save(project, edit(base.config, { exports: { ...base.config.exports, projectPointers: true } }));
  assert.deepEqual(on.pointers, [{ path: join(project, 'CLAUDE.md'), state: 'updated' }, { path: join(project, 'AGENTS.md'), state: 'created' }]);
  const block = pointerBlock(on.config);
  assert.equal(read(join(project, 'AGENTS.md')), `${block}\n`, 'a created file holds only the block');
  const claude = read(join(project, 'CLAUDE.md'));
  assert.equal(claude, `# Acme\r\n\r\nOur notes.\r\n\r\n${rules.replace(/\n/g, '\r\n')}\r\n\r\n${block.replace(/\n/g, '\r\n')}\r\n`, 'appended in the file\'s own line endings');
  assert.match(block, /^<!-- synabun:styleguide:begin v=1 sha=[0-9a-f]{12} -->\n## Design system\nThis project has a SynaBun Style Guide\. Read `DESIGN\.md` before UI, design, copy or creative work and use its tokens \(`\.synabun\/style-guide\/tokens\.css`, `\.synabun\/style-guide\/tokens\.json`\)\. Never edit those files by hand; propose changes with the `style_guide` tool \(action `propose`\)\.\n<!-- synabun:styleguide:end -->$/);
  // The rules installer's reader still sees exactly one rules block: the two never collide.
  assert.deepEqual([findBlocks(claude).blocks.length, findBlocks(claude).conflict, findBlocks(claude).blocks[0].host], [1, null, 'claude']);
  assert.deepEqual(store.save(project, on.config).pointers.map((file) => file.state), ['unchanged', 'unchanged']);
  // The block follows the export settings.
  const moved = store.save(project, edit(on.config, { exports: { ...on.config.exports, outDir: 'design', tokensJson: false } }));
  assert.deepEqual(moved.pointers.map((file) => file.state), ['updated', 'updated']);
  assert.ok(read(join(project, 'AGENTS.md')).includes('use its tokens (`design/tokens.css`)'));

  const off = store.save(project, edit(moved.config, { exports: { ...moved.config.exports, projectPointers: false } }));
  assert.deepEqual(off.pointers, [{ path: join(project, 'CLAUDE.md'), state: 'removed' }, { path: join(project, 'AGENTS.md'), state: 'deleted' }]);
  assert.equal(read(join(project, 'CLAUDE.md')), `# Acme\r\n\r\nOur notes.\r\n\r\n${rules.replace(/\n/g, '\r\n')}\r\n\r\n`, 'only the managed block is removed');
  assert.equal(existsSync(join(project, 'AGENTS.md')), false, 'a file that held only the block is deleted');

  // A symlink is never written through, and damaged markers are reported, not guessed at.
  symlinkSync(join(project, 'CLAUDE.md'), join(project, 'AGENTS.md'));
  assert.deepEqual(store.syncPointers(project, on.config, true)[1], { path: join(project, 'AGENTS.md'), state: 'skipped', reason: 'not a regular file' });
  rmSync(join(project, 'AGENTS.md'));
  writeFileSync(join(project, 'AGENTS.md'), `# Mine\n\n<!-- synabun:styleguide:begin v=1 sha=000000000000 -->\nhalf a block\n`);
  assert.deepEqual(store.syncPointers(project, on.config, true)[1].state, 'error');
  assert.equal(read(join(project, 'AGENTS.md')), `# Mine\n\n<!-- synabun:styleguide:begin v=1 sha=000000000000 -->\nhalf a block\n`);
});

test('the pointer text helpers leave every byte outside the markers alone', () => {
  const block = pointerBlock({});
  assert.ok(block.endsWith(POINTER_END));
  assert.equal(pointerText({ exports: { cssVars: false, tokensJson: false } }).includes('use its tokens.'), true);
  assert.equal(upsertPointer('', block), `${block}\n`);
  assert.equal(upsertPointer('# A\n', block), `# A\n\n${block}\n`);
  assert.equal(upsertPointer('# A', block), `# A\n\n${block}\n`);
  assert.equal(upsertPointer('﻿# A\n\n\n', block), `﻿# A\n\n\n${block}\n`);
  const twice = upsertPointer(upsertPointer('# A\n', block), block);
  assert.equal(twice, `# A\n\n${block}\n`, 'idempotent');
  assert.equal(removePointer(twice), '# A\n\n');
  assert.equal(removePointer(`# A\n\n${block}\n\n## B\n`), '# A\n\n\n## B\n');
  assert.equal(removePointer(`${block}\n`), '');
  assert.equal(removePointer('# no block\n'), '# no block\n');
  assert.equal(findPointer('# no block\n'), null);
  assert.equal(findPointer(`x\n${block}\n`).damaged, false);
  assert.throws(() => upsertPointer(`${POINTER_END}\n`, block), /damaged/);
  assert.throws(() => removePointer('<!-- synabun:styleguide:begin v=1 -->\n'), /damaged/);
});

test('loadStyleGuideForRun: null without a saved guide or for a class the guide keeps out; else the summary and the paths', (t) => {
  const { dataHome, project, store } = sandbox(t);
  const options = { dataHome };
  assert.equal(loadStyleGuideForRun(project, 'code', options), null, 'no store folder at all');
  const saved = store.save(project, edit(store.load(project).config, { brand: { ...store.load(project).config.brand, name: 'Acme' }, imagery: { ...store.load(project).config.imagery, mood: 'Soft', generation: { promptPrefix: 'Flat illustration', negativePrompt: 'photos', aspectRatios: ['1:1'], styleReferences: [] } } })).config;
  const run = loadStyleGuideForRun(project, 'code', options);
  assert.deepEqual(Object.keys(run), ['projectPath', 'revision', 'summary', 'designPath', 'tokenFiles', 'imagery', 'proposals']);
  assert.deepEqual([run.projectPath, run.revision, run.designPath, run.proposals], [project, 1, join(project, 'DESIGN.md'), true]);
  assert.deepEqual(run.tokenFiles, [join(project, '.synabun/style-guide/tokens.json'), join(project, '.synabun/style-guide/tokens.css'), join(project, '.synabun/style-guide/tailwind.css')]);
  assert.deepEqual(run.imagery, { style: 'photography', mood: 'Soft', promptPrefix: 'Flat illustration', negativePrompt: 'photos', aspectRatios: ['1:1'] });
  assert.ok(run.summary.startsWith('Brand: Acme') && estimateTokens(run.summary) <= 600);
  // The same through the data folder the dispatcher holds, and from any folder inside the project.
  assert.deepEqual(loadStyleGuideForRun(join(project, 'src', 'deep', 'er'), 'complex', { dataDir: join(dataHome, 'data') }).summary, run.summary);
  // Classes: the five that build or create get it; the rest do not; a run without a class counts as coding.
  for (const taskClass of ['code', 'complex', 'design', 'image_gen', 'video_gen', null, undefined]) assert.ok(loadStyleGuideForRun(project, taskClass, options), String(taskClass));
  for (const taskClass of ['quick', 'review', 'research', 'browser', 'computer', 'automation', 'chat', 'made-up']) assert.equal(loadStyleGuideForRun(project, taskClass, options), null, taskClass);
  assert.ok(loadStyleGuideForRun(project, 'image_gen', options).summary.startsWith('Imagery: photography — Soft'), 'an image run reads the imagery first');
  // The user's switches decide.
  store.save(project, edit(saved, { agents: { ...saved.agents, allowProposals: false, inject: { ...saved.agents.inject, code: false, review: true } } }), { label: 'switches' });
  assert.equal(loadStyleGuideForRun(project, 'code', options), null);
  assert.equal(loadStyleGuideForRun(project, null, options), null);
  assert.equal(loadStyleGuideForRun(project, 'review', options).proposals, false);
  // Files that are not there are not named; nothing here ever throws.
  rmSync(join(project, 'DESIGN.md'));
  rmSync(join(project, '.synabun'), { recursive: true });
  assert.deepEqual([loadStyleGuideForRun(project, 'design', options).designPath, loadStyleGuideForRun(project, 'design', options).tokenFiles], [null, []]);
  for (const cwd of ['', 'relative', null, 42, join(dataHome, 'nowhere')]) assert.equal(loadStyleGuideForRun(cwd, 'code', options), null, String(cwd));
  writeFileSync(store.paths(project).json, '{ broken');
  assert.equal(loadStyleGuideForRun(project, 'design', options), null);
});
