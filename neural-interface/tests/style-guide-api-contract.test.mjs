// Style Guide REST contract (lib/style-guide/api.js, SPEC §5): every route, its response shape and its
// refusals, over an Express app with a temp data home and a temp registered project. No Neural Interface
// server, never the live data home, and no network: the community fetch is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerStyleGuideRoutes, loadFonts } from '../lib/style-guide/api.js';
import { walkDtcg } from '../lib/style-guide/export-dtcg.js';
import { defaultStyleGuide } from '../lib/style-guide/schema.js';
import { createStyleGuideStore, styleGuideHash } from '../lib/style-guide/store.js';

const GET_KEYS = ['assetsHash', 'config', 'designMd', 'hasDesignFile', 'ok', 'projectPath', 'proposalsPending', 'revision', 'saved', 'summary', 'tokensEstimate', 'written'];
const SAVE_KEYS = [...GET_KEYS, 'changed', 'designPath', 'pointers', 'writtenNow'].sort();
const COMMUNITY = readFileSync(new URL('./fixtures/style-guide/community-DESIGN.md', import.meta.url), 'utf8');

async function startApp(t, { fetchImpl = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synabun-sg-api-'));
  const dataHome = join(root, 'data-home');
  const project = join(root, 'project');
  const other = join(root, 'unregistered');
  for (const dir of [join(dataHome, 'data'), join(project, 'src'), other]) mkdirSync(dir, { recursive: true });
  const store = createStyleGuideStore({ dataHome, projects: () => [{ path: project, label: 'Acme' }] });
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  registerStyleGuideRoutes(app, { store, fetchImpl });
  const server = await new Promise((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  t.after(() => new Promise((done) => server.close(() => { rmSync(root, { recursive: true, force: true }); done(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a text route */ }
    return { status: response.status, json, text, type: response.headers.get('content-type') || '', headers: response.headers };
  };
  const q = (path) => encodeURIComponent(path);
  return { call, base, store, project, other, dataHome, root, q };
}

test('GET /api/style-guide: the defaults for an unsaved project, with every key the spec lists; 400 and 403', async (t) => {
  const { call, project, other, q, dataHome } = await startApp(t);
  const { status, json } = await call('GET', `/api/style-guide?projectPath=${q(project)}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json).sort(), GET_KEYS);
  assert.deepEqual([json.ok, json.projectPath, json.saved, json.revision, json.hasDesignFile, json.assetsHash, json.proposalsPending], [true, project, false, 0, false, styleGuideHash(project), 0]);
  assert.deepEqual(json.config, { ...defaultStyleGuide(project) });
  assert.ok(json.designMd.startsWith('---\nversion: 2\n'));
  assert.ok(json.summary.startsWith('Brand: project') && json.tokensEstimate > 100 && json.tokensEstimate <= 600);
  assert.deepEqual(json.written, [
    { format: 'design-md', path: join(project, 'DESIGN.md'), exists: false }, { format: 'dtcg', path: join(project, '.synabun/style-guide/tokens.json'), exists: false },
    { format: 'css', path: join(project, '.synabun/style-guide/tokens.css'), exists: false }, { format: 'tailwind-v4', path: join(project, '.synabun/style-guide/tailwind.css'), exists: false },
  ]);
  assert.equal(existsSync(join(dataHome, 'data', 'style-guides')), false, 'a read writes nothing');
  // Any path inside the project is the project.
  const inside = await call('GET', `/api/style-guide?projectPath=${q(join(project, 'src', 'app.css'))}`);
  assert.deepEqual([inside.status, inside.json.projectPath, inside.json.assetsHash], [200, project, styleGuideHash(project)]);
  assert.deepEqual(await call('GET', '/api/style-guide').then((r) => [r.status, r.json]), [400, { ok: false, error: 'Missing projectPath', code: 'NO_PROJECT_PATH' }]);
  for (const path of [other, '/', 'relative/path', `${project}-sibling`]) {
    assert.deepEqual(await call('GET', `/api/style-guide?projectPath=${q(path)}`).then((r) => [r.status, r.json]), [403, { ok: false, error: 'Project not registered', code: 'PROJECT_NOT_REGISTERED' }], path);
  }
});

test('PUT /api/style-guide: normalize → revision + 1 → history → artifacts, answered like GET', async (t) => {
  const { call, project, other, q } = await startApp(t);
  const config = defaultStyleGuide(project);
  config.brand.name = 'Acme';
  const put = await call('PUT', '/api/style-guide', { projectPath: join(project, 'src'), config, source: 'ui', label: 'First' });
  assert.equal(put.status, 200);
  assert.deepEqual(Object.keys(put.json).sort(), SAVE_KEYS);
  assert.deepEqual([put.json.saved, put.json.revision, put.json.changed, put.json.hasDesignFile, put.json.designPath, put.json.config.brand.name], [true, 1, true, true, join(project, 'DESIGN.md'), 'Acme']);
  assert.match(put.json.config.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(put.json.written.map((file) => [file.format, file.exists]), [['design-md', true], ['dtcg', true], ['css', true], ['tailwind-v4', true]]);
  assert.deepEqual(put.json.writtenNow.map((file) => [file.format, file.changed]), [['design-md', true], ['dtcg', true], ['css', true], ['tailwind-v4', true]]);
  assert.deepEqual(put.json.pointers.map((file) => file.state), ['absent', 'absent']);
  assert.equal(readFileSync(join(project, 'DESIGN.md'), 'utf8'), put.json.designMd, 'the file is the rendered text');
  assert.deepEqual(walkDtcg(JSON.parse(readFileSync(join(project, '.synabun/style-guide/tokens.json'), 'utf8'))).problems, []);
  assert.ok(readFileSync(join(project, '.synabun/style-guide/tokens.css'), 'utf8').includes('[data-theme="dark"]'));
  assert.ok(readFileSync(join(project, '.synabun/style-guide/tailwind.css'), 'utf8').includes('@theme {'));
  const got = await call('GET', `/api/style-guide?projectPath=${q(project)}`);
  assert.deepEqual([got.json.saved, got.json.revision, got.json.config], [true, 1, put.json.config]);
  // A partial config is filled, an unchanged one keeps the revision, a source the editor may not claim is "ui".
  const partial = await call('PUT', '/api/style-guide', { projectPath: project, config: { schemaVersion: 2, brand: { name: 'Acme 2' } }, source: 'proposal:forged' });
  assert.deepEqual([partial.json.revision, partial.json.config.brand.name, partial.json.config.colors.palettes.primary.base, partial.json.config.typography.styles.h1.size], [2, 'Acme 2', '#3b82f6', 40]);
  const same = await call('PUT', '/api/style-guide', { projectPath: project, config: partial.json.config });
  assert.deepEqual([same.json.revision, same.json.changed], [2, false]);
  const history = await call('GET', `/api/style-guide/history?projectPath=${q(project)}`);
  assert.deepEqual(history.json.map((row) => [row.revision, row.source, row.label]), [[2, 'ui', ''], [1, 'ui', 'First']]);
  assert.deepEqual(Object.keys(history.json[0]), ['revision', 'at', 'source', 'label']);
  // Refusals.
  assert.deepEqual(await call('PUT', '/api/style-guide', { projectPath: project }).then((r) => [r.status, r.json.code]), [400, 'BAD_REQUEST']);
  assert.deepEqual(await call('PUT', '/api/style-guide', { projectPath: project, config: 'text' }).then((r) => r.status), 400);
  assert.deepEqual(await call('PUT', '/api/style-guide', { projectPath: other, config }).then((r) => [r.status, r.json.code]), [403, 'PROJECT_NOT_REGISTERED']);
  assert.equal(existsSync(join(other, 'DESIGN.md')), false);
});

test('the old editor keeps working: compat=v1 mirrors the v1 keys, and a v1-shaped save changes only what it edited', async (t) => {
  const { call, project, q } = await startApp(t);
  const first = await call('GET', `/api/style-guide?compat=v1&projectPath=${q(project)}`);
  for (const key of ['config', 'designMd', 'hasDesignFile', 'assetsHash']) assert.ok(key in first.json, key);
  const config = first.json.config;
  assert.deepEqual(Object.keys(config.colors.primary), ['50', '100', '300', '500', '900']);
  assert.deepEqual([config.typography.heading.family, config.typography.heading.scale, config.typography.body.size, config.shape.spacing, Object.keys(config.shape.shadows), config.logo.iconLibrary, config.logo.imageryNotes], ['Space Grotesk', { h1: 40, h2: 32, h3: 24, h4: 20 }, 16, [4, 8, 12, 16, 24, 32, 48, 64], ['sm', 'md', 'lg'], 'lucide', '']);
  // What ui-styleguide.js does: mutate in place, PUT the whole object.
  config.colors.primary['500'] = '#e11d48';
  config.colors.status.danger = '#b91c1c';
  config.typography.heading.family = 'Sora';
  config.typography.body.size = 17;
  config.shape.radius.md = 10;
  config.shape.spacing.push(96);
  config.logo.iconLibrary = 'phosphor';
  config.logo.imageryNotes = 'Warm.';
  const put = await call('PUT', '/api/style-guide', { projectPath: project, config, compat: 'v1' });
  assert.equal(put.status, 200);
  const saved = put.json.config;
  assert.deepEqual([saved.schemaVersion, saved.colors.palettes.primary.base, saved.colors.palettes.primary.steps['500'], saved.colors.primary['500'], saved.colors.status.danger], [2, '#e11d48', '#e11d48', '#e11d48', '#b91c1c']);
  assert.deepEqual([saved.typography.fonts.heading.family, saved.typography.heading.family, saved.typography.styles.body.size, saved.shape.radius.md, saved.layout.spacing.scale['5xl'], saved.iconography.library, saved.imagery.notes], ['Sora', 'Sora', 17, 10, 96, 'phosphor', 'Warm.']);
  assert.deepEqual(saved.shape.spacing, [4, 8, 12, 16, 24, 32, 48, 64, 96], 'the response is mirrored again, so the editor keeps reading its own shape');
  // The stored guide is pure v2, and a new-style reader gets no v1 key.
  const pure = await call('GET', `/api/style-guide?projectPath=${q(project)}`);
  assert.deepEqual(['primary' in pure.json.config.colors, 'heading' in pure.json.config.typography, 'spacing' in pure.json.config.shape, 'iconLibrary' in pure.json.config.logo], [false, false, false, false]);
  assert.match(readFileSync(join(project, 'DESIGN.md'), 'utf8'), /primary-500: "#e11d48"/);
  // A pure v1 body (no schemaVersion at all) is accepted too, and answered in the v1 shape without being asked.
  const v1 = await call('PUT', '/api/style-guide', { projectPath: project, config: { colors: { secondary: { 50: '#f0fdf4', 100: '#dcfce7', 300: '#86efac', 500: '#22c55e', 900: '#14532d' } }, typography: { mono: { family: 'Fira Code', weights: [400] } }, shape: { radius: { pill: 20, button: 10, card: 8, small: 6 } } } });
  assert.deepEqual([v1.status, v1.json.config.colors.palettes.secondary.base, v1.json.config.colors.secondary['500'], v1.json.config.typography.fonts.mono.family, v1.json.config.shape.radiusRoles.button], [200, '#22c55e', '#22c55e', 'Fira Code', 'button']);
});

test('GET /summary, /preview-md and /export: the text agents and the editor read, in every format', async (t) => {
  const { call, project, q } = await startApp(t);
  const summary = await call('GET', `/api/style-guide/summary?projectPath=${q(project)}`);
  assert.deepEqual(Object.keys(summary.json).sort(), ['ok', 'projectPath', 'revision', 'saved', 'summary', 'tokensEstimate']);
  assert.ok(summary.json.summary.startsWith('Brand: ') && summary.json.tokensEstimate <= 600 && summary.json.saved === false);
  const image = await call('GET', `/api/style-guide/summary?projectPath=${q(project)}&taskClass=image_gen`);
  assert.ok(image.json.summary.startsWith('Imagery: photography'));
  const preview = await call('GET', `/api/style-guide/preview-md?projectPath=${q(project)}`);
  assert.deepEqual([preview.status, /^text\/markdown/.test(preview.type), preview.text.startsWith('---\nversion: 2\n')], [200, true, true]);
  assert.equal(existsSync(join(project, 'DESIGN.md')), false, 'a preview writes nothing');
  const expected = { 'design-md': [/^text\/markdown/, /^---\nversion: 2\n/], dtcg: [/^application\/design-tokens\+json/, /^\{\n {2}"\$description"/], css: [/^text\/css/, /^\/\* SynaBun Style Guide rev 0: design tokens/], 'tailwind-v4': [/^text\/css/, /@theme \{/], 'tailwind-v3': [/^text\/javascript/, /module\.exports = \{/], summary: [/^text\/plain/, /^Brand: /], json: [/^application\/json/, /"theme": "light"/] };
  for (const [format, [type, body]] of Object.entries(expected)) {
    const out = await call('GET', `/api/style-guide/export?projectPath=${q(project)}&format=${format}`);
    assert.equal(out.status, 200, format);
    assert.match(out.type, type, format);
    assert.match(out.text, body, format);
    const wrapped = await call('GET', `/api/style-guide/export?projectPath=${q(project)}&format=${format}&as=json`);
    assert.deepEqual(Object.keys(wrapped.json), ['ok', 'format', 'contentType', 'filename', 'text', 'revision'], format);
    assert.equal(wrapped.json.text, out.text, format);
  }
  const dark = await call('GET', `/api/style-guide/export?projectPath=${q(project)}&format=json&theme=dark`);
  assert.deepEqual([dark.json.theme, dark.json.colors.background], ['dark', defaultStyleGuide(project).colors.palettes.neutral.steps['950']]);
  const flat = await call('GET', `/api/style-guide/export?projectPath=${q(project)}&format=css&theme=dark`);
  assert.ok(flat.text.includes('color-scheme: dark;') && !flat.text.includes('[data-theme='));
  assert.deepEqual(await call('GET', `/api/style-guide/export?projectPath=${q(project)}&format=pdf`).then((r) => [r.status, r.json.code]), [400, 'BAD_FORMAT']);
  assert.equal((await call('GET', '/api/style-guide/summary')).status, 400);
  assert.equal((await call('GET', `/api/style-guide/export?projectPath=${q('/nowhere')}&format=css`)).status, 403);
});

test('POST /export writes the saved guide\'s files now; it needs a saved guide', async (t) => {
  const { call, project } = await startApp(t);
  assert.deepEqual(await call('POST', '/api/style-guide/export', { projectPath: project }).then((r) => [r.status, r.json.code]), [409, 'NOT_SAVED']);
  await call('PUT', '/api/style-guide', { projectPath: project, config: defaultStyleGuide(project) });
  rmSync(join(project, '.synabun'), { recursive: true });
  const all = await call('POST', '/api/style-guide/export', { projectPath: project });
  assert.deepEqual([all.status, Object.keys(all.json), all.json.written.map((file) => [file.format, file.changed])], [200, ['ok', 'written'], [['design-md', false], ['dtcg', true], ['css', true], ['tailwind-v4', true]]]);
  const some = await call('POST', '/api/style-guide/export', { projectPath: project, formats: ['tailwind-v3', 'css'] });
  assert.deepEqual(some.json.written.map((file) => [file.format, file.path]), [['css', join(project, '.synabun/style-guide/tokens.css')]]);
  assert.equal(existsSync(join(project, '.synabun/style-guide/tailwind.tokens.cjs')), false, 'a requested format must still be enabled');
  assert.deepEqual(await call('POST', '/api/style-guide/export', { projectPath: project, formats: ['pdf'] }).then((r) => [r.status, r.json.code]), [400, 'BAD_FORMAT']);
});

test('POST /import: preview changes nothing, apply saves with source import:<kind>; merge and replace; every kind', async (t) => {
  let fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); return url.includes('/missing/') ? { ok: false, status: 404 } : { ok: true, status: 200, text: async () => COMMUNITY }; };
  const { call, project, q } = await startApp(t, { fetchImpl });
  const css = ':root { --color-primary-500: #e11d48; --radius-md: 10px; --font-heading: "Sora", sans-serif; }';
  const preview = await call('POST', '/api/style-guide/import', { projectPath: project, kind: 'css', text: css, mode: 'preview', merge: 'merge' });
  assert.equal(preview.status, 200);
  assert.deepEqual(Object.keys(preview.json), ['ok', 'mode', 'config', 'diff', 'warnings']);
  assert.deepEqual([preview.json.mode, preview.json.warnings, preview.json.config.colors.palettes.primary.base, preview.json.config.shape.radius.md, preview.json.config.typography.fonts.heading.family, preview.json.config.typography.fonts.heading.source], ['preview', [], '#e11d48', 10, 'Sora', 'google']);
  assert.ok(preview.json.diff.some((row) => row.path === 'shape.radius.md' && row.from === 8 && row.to === 10));
  assert.equal((await call('GET', `/api/style-guide?projectPath=${q(project)}`)).json.saved, false, 'a preview saves nothing');
  // mode defaults to preview, merge to merge.
  assert.equal((await call('POST', '/api/style-guide/import', { projectPath: project, kind: 'css', text: css })).json.mode, 'preview');
  const applied = await call('POST', '/api/style-guide/import', { projectPath: project, kind: 'css', text: css, mode: 'apply', merge: 'merge' });
  assert.deepEqual([applied.status, applied.json.saved, applied.json.revision, applied.json.mode, applied.json.config.colors.palettes.primary.base], [200, true, 1, 'apply', '#e11d48']);
  for (const key of [...SAVE_KEYS, 'diff', 'warnings']) assert.ok(key in applied.json, key);
  assert.deepEqual((await call('GET', `/api/style-guide/history?projectPath=${q(project)}`)).json.map((row) => row.source), ['import:css']);
  // The other text kinds, from the guide's own exports.
  for (const [kind, format] of [['design-md', 'design-md'], ['dtcg', 'dtcg'], ['tailwind-json', null]]) {
    const text = format ? (await call('GET', `/api/style-guide/export?projectPath=${q(project)}&format=${format}`)).text : JSON.stringify({ theme: { extend: { colors: { accent: { 500: '#f97316' } } } } });
    const out = await call('POST', '/api/style-guide/import', { projectPath: project, kind, text, mode: 'preview', merge: 'merge' });
    assert.deepEqual([out.status, out.json.ok], [200, true], kind);
    if (format) assert.deepEqual(out.json.diff, [], `${kind}: the guide's own export changes nothing`);
    else assert.equal(out.json.config.colors.palettes.accent.base, '#f97316');
  }
  // codebase: reads the project.
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'theme.css'), ':root { --color-secondary-500: #16a34a; }');
  const scan = await call('POST', '/api/style-guide/import', { projectPath: project, kind: 'codebase', mode: 'preview', merge: 'merge' });
  assert.deepEqual([scan.status, scan.json.files, scan.json.config.colors.palettes.secondary.base], [200, ['src/theme.css'], '#16a34a']);
  // community: the slug is checked before the request; replace wipes what the import does not carry.
  const community = await call('POST', '/api/style-guide/import', { projectPath: project, kind: 'community', slug: 'nimbus', mode: 'apply', merge: 'replace' });
  assert.deepEqual([community.status, community.json.config.brand.name, community.json.config.colors.themes.default, community.json.config.shape.radius, community.json.revision, community.json.source], [200, 'Nimbus', 'dark', { sm: 4, md: 8, lg: 12, pill: 9999 }, 2, 'https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/nimbus/DESIGN.md']);
  assert.match(community.json.warnings[0], /community collection/);
  assert.deepEqual(fetched, ['https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/nimbus/DESIGN.md']);
  fetched = [];
  assert.deepEqual(await call('POST', '/api/style-guide/import', { projectPath: project, kind: 'community', slug: '../../etc/passwd' }).then((r) => [r.status, r.json.code]), [400, 'BAD_SLUG']);
  assert.deepEqual(fetched, [], 'a refused slug is never fetched');
  assert.deepEqual(await call('POST', '/api/style-guide/import', { projectPath: project, kind: 'community', slug: 'missing' }).then((r) => [r.status, r.json.code]), [404, 'NOT_FOUND']);
  // Refusals.
  for (const [body, status, code] of [[{ kind: 'figma', text: 'x' }, 400, 'BAD_KIND'], [{ kind: 'css', text: css, mode: 'save' }, 400, 'BAD_MODE'], [{ kind: 'css', text: css, merge: 'overwrite' }, 400, 'BAD_MERGE'], [{ kind: 'css' }, 400, 'NO_TEXT'], [{ kind: 'dtcg', text: '{nope' }, 400, 'BAD_JSON']]) {
    assert.deepEqual(await call('POST', '/api/style-guide/import', { projectPath: project, ...body }).then((r) => [r.status, r.json.code, r.json.ok]), [status, code, false], JSON.stringify(body));
  }
  assert.equal((await call('POST', '/api/style-guide/import', { projectPath: '/nowhere', kind: 'css', text: css })).status, 403);
});

test('GET /presets and POST /presets/apply', async (t) => {
  const { call, project, q } = await startApp(t);
  const presets = await call('GET', '/api/style-guide/presets');
  assert.equal(presets.status, 200);
  assert.ok(Array.isArray(presets.json) && presets.json.length === 8);
  assert.deepEqual(Object.keys(presets.json[0]), ['id', 'name', 'description', 'swatches', 'fonts', 'theme']);
  assert.deepEqual(Object.keys(presets.json[0].fonts), ['heading', 'body']);
  const applied = await call('POST', '/api/style-guide/presets/apply', { projectPath: project, presetId: 'warm-organic' });
  assert.deepEqual([applied.status, applied.json.saved, applied.json.revision, applied.json.config.typography.fonts.heading.family, applied.json.config.colors.palettes.primary.base], [200, true, 1, 'Fraunces', '#b4532a']);
  assert.ok(Array.isArray(applied.json.diff) && applied.json.diff.length > 30);
  assert.deepEqual((await call('GET', `/api/style-guide/history?projectPath=${q(project)}`)).json.map((row) => row.source), ['preset:warm-organic']);
  // merge keeps what the guide already says.
  await call('PUT', '/api/style-guide', { projectPath: project, config: { ...applied.json.config, brand: { ...applied.json.config.brand, name: 'Acme' } }, label: 'named' });
  const merged = await call('POST', '/api/style-guide/presets/apply', { projectPath: project, presetId: 'editorial', merge: 'merge' });
  assert.deepEqual([merged.json.config.brand.name, merged.json.config.typography.fonts.heading.family, merged.json.revision], ['Acme', 'Playfair Display', 3]);
  const replaced = await call('POST', '/api/style-guide/presets/apply', { projectPath: project, presetId: 'minimal-saas' });
  assert.equal(replaced.json.config.brand.name, '', 'replace is the default');
  assert.deepEqual(await call('POST', '/api/style-guide/presets/apply', { projectPath: project, presetId: 'nope' }).then((r) => [r.status, r.json.code]), [404, 'PRESET_NOT_FOUND']);
});

test('GET /history and POST /history/restore', async (t) => {
  const { call, project, q } = await startApp(t);
  assert.deepEqual((await call('GET', `/api/style-guide/history?projectPath=${q(project)}`)).json, []);
  const config = defaultStyleGuide(project);
  for (const name of ['One', 'Two', 'Three']) await call('PUT', '/api/style-guide', { projectPath: project, config: { ...config, brand: { ...config.brand, name } }, label: name });
  const restored = await call('POST', '/api/style-guide/history/restore', { projectPath: project, revision: 1 });
  assert.deepEqual([restored.status, restored.json.revision, restored.json.config.brand.name, restored.json.saved], [200, 4, 'One', true]);
  for (const key of SAVE_KEYS) assert.ok(key in restored.json, key);
  assert.deepEqual((await call('GET', `/api/style-guide/history?projectPath=${q(project)}`)).json.map((row) => [row.revision, row.source, row.label]), [[4, 'restore:1', ''], [3, 'ui', 'Three'], [2, 'ui', 'Two'], [1, 'ui', 'One']]);
  assert.match(readFileSync(join(project, 'DESIGN.md'), 'utf8'), /name: "One"/);
  assert.deepEqual(await call('POST', '/api/style-guide/history/restore', { projectPath: project, revision: 99 }).then((r) => [r.status, r.json.code]), [404, 'REVISION_NOT_FOUND']);
  assert.deepEqual(await call('POST', '/api/style-guide/history/restore', { projectPath: project, revision: 'first' }).then((r) => [r.status, r.json.code]), [400, 'BAD_REVISION']);
});

test('proposals: POST records one, GET lists them with a diff, accept saves like PUT, reject answers { ok }', async (t) => {
  const { call, project, q } = await startApp(t);
  const changes = { colors: { status: { danger: '#dc2626' } } };
  assert.deepEqual(await call('POST', '/api/style-guide/proposals', { projectPath: project, changes, reason: 'Contrast' }).then((r) => [r.status, r.json.code]), [409, 'NOT_SAVED']);
  const config = defaultStyleGuide(project);
  await call('PUT', '/api/style-guide', { projectPath: project, config });
  const made = await call('POST', '/api/style-guide/proposals', { projectPath: join(project, 'src'), changes, reason: 'The danger red fails AA on white.', provider: 'codex', model: 'gpt-5' }, { 'X-Synabun-Terminal': 'run-abc' });
  assert.equal(made.status, 200);
  assert.deepEqual(Object.keys(made.json), ['ok', 'id', 'pending', 'ignored', 'diff']);
  assert.deepEqual([made.json.ok, made.json.pending, made.json.ignored, made.json.diff], [true, 1, [], [{ path: 'colors.status.danger', from: '#ef4444', to: '#dc2626' }]]);
  const second = await call('POST', '/api/style-guide/proposals', { projectPath: project, changes: { brand: { tagline: 'Faster' } }, reason: 'A tagline.', runId: 'run-named' });
  assert.equal(second.json.pending, 2);
  assert.equal((await call('GET', `/api/style-guide?projectPath=${q(project)}`)).json.proposalsPending, 2);
  const list = await call('GET', `/api/style-guide/proposals?projectPath=${q(project)}`);
  assert.ok(Array.isArray(list.json));
  assert.deepEqual(Object.keys(list.json[0]), ['id', 'at', 'status', 'decidedAt', 'runId', 'provider', 'model', 'reason', 'changes', 'diff']);
  assert.deepEqual(list.json.map((row) => [row.id, row.status, row.runId, row.provider, row.model]), [[second.json.id, 'pending', 'run-named', null, null], [made.json.id, 'pending', 'run-abc', 'codex', 'gpt-5']], 'without a runId the caller\'s terminal id names the run');
  assert.deepEqual(list.json[1].changes, changes);
  // Nothing changed yet.
  assert.equal((await call('GET', `/api/style-guide?projectPath=${q(project)}`)).json.config.colors.status.danger, '#ef4444');
  const rejected = await call('POST', `/api/style-guide/proposals/${second.json.id}/reject`, { projectPath: project });
  assert.deepEqual([rejected.status, rejected.json], [200, { ok: true, proposalsPending: 1 }]);
  const accepted = await call('POST', `/api/style-guide/proposals/${made.json.id}/accept`, { projectPath: project });
  assert.deepEqual([accepted.status, accepted.json.revision, accepted.json.config.colors.status.danger, accepted.json.proposalsPending], [200, 2, '#dc2626', 0]);
  for (const key of SAVE_KEYS) assert.ok(key in accepted.json, key);
  assert.deepEqual((await call('GET', `/api/style-guide/history?projectPath=${q(project)}`)).json[0].source, `proposal:${made.json.id}`);
  assert.deepEqual((await call('GET', `/api/style-guide/proposals?projectPath=${q(project)}&status=pending`)).json, []);
  assert.deepEqual((await call('GET', `/api/style-guide/proposals?projectPath=${q(project)}&status=accepted`)).json.map((row) => row.id), [made.json.id]);
  // Refusals: decided twice, unknown, malformed, and 422 when the user turned proposals off.
  assert.deepEqual(await call('POST', `/api/style-guide/proposals/${made.json.id}/accept`, { projectPath: project }).then((r) => [r.status, r.json.code]), [409, 'ALREADY_DECIDED']);
  assert.deepEqual(await call('POST', '/api/style-guide/proposals/prop-nope/reject', { projectPath: project }).then((r) => [r.status, r.json.code]), [404, 'PROPOSAL_NOT_FOUND']);
  assert.deepEqual(await call('POST', '/api/style-guide/proposals', { projectPath: project, changes: [], reason: 'x' }).then((r) => [r.status, r.json.code]), [400, 'BAD_CHANGES']);
  assert.deepEqual(await call('POST', '/api/style-guide/proposals', { projectPath: project, changes }).then((r) => [r.status, r.json.code]), [400, 'NO_REASON']);
  assert.deepEqual(await call('POST', '/api/style-guide/proposals', { projectPath: project, changes: { agents: { allowProposals: false } }, reason: 'x' }).then((r) => [r.status, r.json.code]), [400, 'NO_CHANGE']);
  await call('PUT', '/api/style-guide', { projectPath: project, config: { ...accepted.json.config, agents: { ...accepted.json.config.agents, allowProposals: false } } });
  assert.deepEqual(await call('POST', '/api/style-guide/proposals', { projectPath: project, changes: { brand: { name: 'X' } }, reason: 'x' }).then((r) => [r.status, r.json.code, r.json.ok]), [422, 'PROPOSALS_OFF', false]);
  assert.equal((await call('POST', '/api/style-guide/proposals', { projectPath: '/nowhere', changes, reason: 'x' })).status, 403);
  assert.equal((await call('GET', '/api/style-guide/proposals')).status, 400);
});

test('POST /contrast: the ratio, the AA / AAA verdicts and APCA; aliases with a project; 400 for what is not a color', async (t) => {
  const { call, project } = await startApp(t);
  const black = await call('POST', '/api/style-guide/contrast', { fg: '#000', bg: '#fff' });
  assert.deepEqual([black.status, black.json], [200, { ok: true, ratio: 21, aa: true, aaa: true, aaLarge: true, aaaLarge: true, apca: 106, fg: '#000000', bg: '#ffffff', size: 'normal' }]);
  const gray = await call('POST', '/api/style-guide/contrast', { fg: 'rgb(119 119 119)', bg: 'white' });
  assert.deepEqual([gray.json.ratio, gray.json.aa, gray.json.aaa, gray.json.aaLarge, gray.json.apca], [4.48, false, false, true, 71.1]);
  assert.deepEqual(await call('POST', '/api/style-guide/contrast', { fg: '#777777', bg: '#ffffff', size: 'large' }).then((r) => [r.json.aa, r.json.aaa, r.json.size]), [true, false, 'large']);
  const light = await call('POST', '/api/style-guide/contrast', { fg: '{semantic.text}', bg: '{semantic.background}', projectPath: project });
  const dark = await call('POST', '/api/style-guide/contrast', { fg: '{semantic.text}', bg: '{semantic.background}', projectPath: project, theme: 'dark' });
  assert.deepEqual([light.json.bg, light.json.aa, light.json.apca > 0, dark.json.bg, dark.json.aa, dark.json.apca < 0], ['#ffffff', true, true, defaultStyleGuide(project).colors.palettes.neutral.steps['950'], true, true]);
  assert.deepEqual(await call('POST', '/api/style-guide/contrast', { fg: '{semantic.text}', bg: '#fff' }).then((r) => [r.status, r.json.code, /pass projectPath/.test(r.json.error)]), [400, 'BAD_COLOR', true]);
  assert.deepEqual(await call('POST', '/api/style-guide/contrast', { fg: '#000', bg: 'nope' }).then((r) => [r.status, r.json.code, /bg "nope"/.test(r.json.error)]), [400, 'BAD_COLOR', true]);
  assert.equal((await call('POST', '/api/style-guide/contrast', { fg: '#000', bg: '#fff', projectPath: '/nowhere' })).status, 403);
});

test('POST /scale, POST /dark-semantic and GET /defaults: the editor\'s color tools and its reset source', async (t) => {
  const { call, project, q } = await startApp(t);
  const scale = await call('POST', '/api/style-guide/scale', { base: 'rgb(59 130 246)' });
  assert.deepEqual([scale.status, Object.keys(scale.json), scale.json.base, Object.keys(scale.json.steps), scale.json.steps['500']], [200, ['ok', 'base', 'steps', 'harmony', 'oklch'], '#3b82f6', ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'], '#3b82f6']);
  assert.deepEqual(scale.json.steps, defaultStyleGuide(project).colors.palettes.primary.steps, 'the scale the defaults were built with');
  assert.deepEqual([Object.keys(scale.json.harmony), Object.keys(scale.json.oklch)], [['complementary', 'analogous', 'triadic', 'splitComplementary'], ['l', 'c', 'h']]);
  const tuned = await call('POST', '/api/style-guide/scale', { base: '#3b82f6', hueShift: 20, chroma: 0.5 });
  assert.deepEqual([tuned.json.steps['500'], tuned.json.steps['100'] !== scale.json.steps['100']], ['#3b82f6', true]);
  assert.deepEqual(await call('POST', '/api/style-guide/scale', { base: 'nope' }).then((r) => [r.status, r.json.code]), [400, 'BAD_COLOR']);
  const dark = await call('POST', '/api/style-guide/dark-semantic', { light: { background: '#ffffff', surface: '{neutral.50}', primary: '{primary.500}' } });
  assert.deepEqual([dark.status, dark.json], [200, { ok: true, dark: { background: '{neutral.950}', surface: '{neutral.950}', primary: '{primary.400}' } }]);
  assert.deepEqual(await call('POST', '/api/style-guide/dark-semantic', { light: 'x' }).then((r) => [r.status, r.json.code]), [400, 'BAD_REQUEST']);
  // The defaults stay available after a save.
  await call('PUT', '/api/style-guide', { projectPath: project, config: { ...defaultStyleGuide(project), brand: { ...defaultStyleGuide(project).brand, name: 'Acme' } } });
  assert.deepEqual(await call('GET', `/api/style-guide/defaults?projectPath=${q(join(project, 'src'))}`).then((r) => [r.status, r.json]), [200, { ok: true, config: defaultStyleGuide(project) }]);
  assert.equal((await call('GET', '/api/style-guide/defaults')).status, 400);
});

test('the modules the editor may load in a browser import nothing from Node', () => {
  for (const name of ['color', 'schema', 'tokens', 'render-design-md', 'export-css', 'export-dtcg', 'export-tailwind', 'summary', 'presets']) {
    const source = readFileSync(new URL(`../lib/style-guide/${name}.js`, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import [^;]*? from '([^']+)';$/gm)].map((match) => match[1]);
    // presets.js reaches import.js (node:fs for the codebase scan): everything else is pure.
    const allowed = name === 'presets' ? /^\.\/(color|schema|import)\.js$/ : /^\.\/(color|schema|tokens|render-design-md|export-css|export-dtcg)\.js$/;
    for (const spec of imports) assert.match(spec, allowed, `${name}.js imports ${spec}`);
    assert.doesNotMatch(source, /\bprocess\.|\bBuffer\b/, name);
  }
});

test('GET /fonts: the bundled Google Fonts list, searchable', async (t) => {
  const { call } = await startApp(t);
  const all = await call('GET', '/api/style-guide/fonts');
  assert.ok(Array.isArray(all.json) && all.json.length >= 190 && all.json.length <= 260, `${all.json.length} fonts`);
  assert.deepEqual(all.json, loadFonts());
  for (const font of all.json) {
    assert.deepEqual(Object.keys(font), ['family', 'category', 'weights']);
    assert.ok(['sans-serif', 'serif', 'display', 'handwriting', 'monospace'].includes(font.category), font.family);
    assert.ok(font.weights.length >= 1 && font.weights.every((w) => Number.isInteger(w) && w >= 100 && w <= 900), font.family);
  }
  assert.equal(new Set(all.json.map((font) => font.family)).size, all.json.length, 'no family twice');
  for (const family of ['Inter', 'Space Grotesk', 'JetBrains Mono', 'Playfair Display', 'Fraunces', 'IBM Plex Sans', 'Source Serif 4', 'Fredoka', 'Nunito', 'DM Sans', 'DM Mono', 'Manrope', 'Source Sans 3', 'Source Code Pro', 'IBM Plex Mono']) assert.ok(all.json.some((font) => font.family === family), `${family}: a preset uses it`);
  assert.deepEqual((await call('GET', '/api/style-guide/fonts?q=plex')).json.map((font) => font.family), ['IBM Plex Mono', 'IBM Plex Sans', 'IBM Plex Serif']);
  assert.ok((await call('GET', '/api/style-guide/fonts?q=monospace')).json.every((font) => font.category === 'monospace'));
  assert.deepEqual((await call('GET', '/api/style-guide/fonts?q=zzzz')).json, []);
});

test('POST /pointers: the opt-in block in the project\'s CLAUDE.md and AGENTS.md', async (t) => {
  const { call, project, q } = await startApp(t);
  assert.deepEqual(await call('POST', '/api/style-guide/pointers', { projectPath: project, enabled: true }).then((r) => [r.status, r.json.code]), [409, 'NOT_SAVED']);
  assert.deepEqual(await call('POST', '/api/style-guide/pointers', { projectPath: project, enabled: false }).then((r) => [r.status, r.json.files.map((file) => file.state)]), [200, ['absent', 'absent']]);
  await call('PUT', '/api/style-guide', { projectPath: project, config: defaultStyleGuide(project) });
  writeFileSync(join(project, 'CLAUDE.md'), '# Acme\n');
  const on = await call('POST', '/api/style-guide/pointers', { projectPath: project, enabled: true });
  assert.deepEqual([on.status, Object.keys(on.json), on.json.files], [200, ['ok', 'enabled', 'files', 'revision'], [{ path: join(project, 'CLAUDE.md'), state: 'updated' }, { path: join(project, 'AGENTS.md'), state: 'created' }]]);
  assert.match(readFileSync(join(project, 'CLAUDE.md'), 'utf8'), /^# Acme\n\n<!-- synabun:styleguide:begin v=1 sha=[0-9a-f]{12} -->\n## Design system\n/);
  assert.equal((await call('GET', `/api/style-guide?projectPath=${q(project)}`)).json.config.exports.projectPointers, true, 'the switch is part of the guide');
  const off = await call('POST', '/api/style-guide/pointers', { projectPath: project, enabled: false });
  assert.deepEqual(off.json.files.map((file) => file.state), ['removed', 'deleted']);
  assert.deepEqual([readFileSync(join(project, 'CLAUDE.md'), 'utf8'), existsSync(join(project, 'AGENTS.md'))], ['# Acme\n\n', false]);
  assert.deepEqual(await call('POST', '/api/style-guide/pointers', { projectPath: project, enabled: 'yes' }).then((r) => [r.status, r.json.code]), [400, 'BAD_REQUEST']);
});

test('logo upload, delete and assets: as before, plus the variant\'s kind', async (t) => {
  const { base, call, project, store, q } = await startApp(t);
  const upload = async (query, body, type = 'image/svg+xml') => {
    const response = await fetch(`${base}/api/style-guide/logo?${query}`, { method: 'POST', headers: { 'Content-Type': type }, body });
    return { status: response.status, json: await response.json() };
  };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const made = await upload(`projectPath=${q(project)}&name=Wordmark&kind=wordmark&bg=dark`, svg);
  assert.equal(made.status, 200);
  assert.deepEqual(Object.keys(made.json), ['ok', 'variant', 'config', 'revision', 'assetsHash']);
  const { variant } = made.json;
  assert.match(variant.id, /^logo-[a-z0-9]+$/);
  assert.deepEqual(variant, { id: variant.id, name: 'Wordmark', kind: 'wordmark', file: `${variant.id}.svg`, bg: 'dark' });
  assert.deepEqual([made.json.revision, made.json.config.logo.variants, made.json.assetsHash], [1, [variant], styleGuideHash(project)]);
  assert.equal(readFileSync(join(store.paths(project).assets, variant.file), 'utf8'), svg);
  assert.equal(readFileSync(join(project, '.synabun/style-guide', variant.file), 'utf8'), svg, 'mirrored into the project');
  assert.match(readFileSync(join(project, 'DESIGN.md'), 'utf8'), new RegExp(`- \\*\\*Wordmark\\*\\* \\(wordmark, on dark\\) — \`\\.synabun/style-guide/${variant.file}\``));
  // Served back as a file to look at, never as a page that runs script.
  const served = await fetch(`${base}/api/style-guide/assets/${styleGuideHash(project)}/${variant.file}`);
  assert.deepEqual([served.status, await served.text(), served.headers.get('x-content-type-options')], [200, svg, 'nosniff']);
  assert.match(served.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  // Replacing a variant with another type removes the old file; unknown kind and bg keep what was there.
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const replaced = await upload(`projectPath=${q(project)}&variantId=${variant.id}&kind=nope&bg=nope`, png, 'image/png');
  assert.deepEqual(replaced.json.variant, { id: variant.id, name: 'Wordmark', kind: 'wordmark', file: `${variant.id}.png`, bg: 'dark' });
  assert.deepEqual(readdirSync(store.paths(project).assets), [`${variant.id}.png`]);
  assert.equal(existsSync(join(project, '.synabun/style-guide', variant.file)), false);
  // The old editor's call gets the v1 keys beside the v2 ones.
  const old = await upload(`projectPath=${q(project)}&compat=v1&name=Icon`, png, 'image/png');
  assert.deepEqual([old.json.config.logo.variants.length, old.json.config.logo.iconLibrary, old.json.variant.kind, old.json.variant.bg], [2, 'lucide', 'primary', 'primary']);
  // Refusals.
  assert.deepEqual(await upload(`projectPath=${q(project)}`, '').then((r) => [r.status, r.json.code]), [400, 'NO_IMAGE']);
  assert.deepEqual(await upload(`projectPath=${q(project)}`, 'text', 'text/plain').then((r) => r.status), 400);
  assert.deepEqual(await upload(`projectPath=${q('/nowhere')}`, svg).then((r) => r.status), 403);
  assert.deepEqual(await upload('', svg).then((r) => r.status), 400);
  for (const [hash, file, status] of [['zzzz', 'a.svg', 400], [styleGuideHash(project), '..%2F..%2Fx', 400], [styleGuideHash(project), 'missing.svg', 404], ['0123456789abcdef', `${variant.id}.png`, 404]]) {
    assert.equal((await fetch(`${base}/api/style-guide/assets/${hash}/${file}`)).status, status, `${hash}/${file}`);
  }
  // Delete.
  const gone = await call('DELETE', `/api/style-guide/logo/${variant.id}?projectPath=${q(project)}`);
  assert.deepEqual([gone.status, Object.keys(gone.json), gone.json.config.logo.variants.map((v) => v.id)], [200, ['ok', 'config', 'revision'], [old.json.variant.id]]);
  assert.deepEqual([existsSync(join(store.paths(project).assets, `${variant.id}.png`)), existsSync(join(project, '.synabun/style-guide', `${variant.id}.png`))], [false, false]);
  assert.deepEqual(await call('DELETE', `/api/style-guide/logo/${variant.id}?projectPath=${q(project)}`).then((r) => [r.status, r.json.code]), [404, 'VARIANT_NOT_FOUND']);
  assert.equal((await call('DELETE', `/api/style-guide/logo/x?projectPath=${q('/nowhere')}`)).status, 403);
});

test('GET /projects: every registered project with its guide\'s status', async (t) => {
  const { call, project } = await startApp(t);
  assert.deepEqual((await call('GET', '/api/style-guide/projects')).json, [{ path: project, label: 'Acme', saved: false, revision: 0, updatedAt: null, hasDesignFile: false, proposalsPending: 0 }]);
  const saved = await call('PUT', '/api/style-guide', { projectPath: project, config: defaultStyleGuide(project) });
  await call('POST', '/api/style-guide/proposals', { projectPath: project, changes: { brand: { name: 'X' } }, reason: 'Name it.' });
  assert.deepEqual((await call('GET', '/api/style-guide/projects')).json, [{ path: project, label: 'Acme', saved: true, revision: 1, updatedAt: saved.json.config.updatedAt, hasDesignFile: true, proposalsPending: 1 }]);
});

test('API refuses symlink escapes, non-image assets, unregistered asset hashes and oversized logos', async (t) => {
  const { call, base, project, other, store, q } = await startApp(t);
  symlinkSync(other, join(project, 'escape'));
  for (const method of ['GET', 'PUT']) {
    const response = method === 'GET'
      ? await call(method, `/api/style-guide?projectPath=${q(join(project, 'escape/missing'))}`)
      : await call(method, '/api/style-guide', { projectPath: join(project, 'escape/missing'), config: {} });
    assert.equal(response.status, 403);
  }
  const assets = store.paths(project).assets;
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(other, 'secret.svg'), 'secret');
  symlinkSync(join(other, 'secret.svg'), join(assets, 'linked.svg'));
  writeFileSync(join(assets, 'secret.txt'), 'private');
  assert.equal((await fetch(`${base}/api/style-guide/assets/${styleGuideHash(project)}/linked.svg`)).status, 403);
  assert.equal((await fetch(`${base}/api/style-guide/assets/${styleGuideHash(project)}/secret.txt`)).status, 400);
  const unregistered = store.paths(other);
  mkdirSync(unregistered.assets, { recursive: true });
  writeFileSync(join(unregistered.assets, 'logo.svg'), 'hidden');
  assert.equal((await fetch(`${base}/api/style-guide/assets/${unregistered.hash}/logo.svg`)).status, 404);
  const oversized = await fetch(`${base}/api/style-guide/logo?projectPath=${q(project)}`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(4 * 1024 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(Object.keys(await oversized.json()).sort(), ['code', 'error', 'ok']);
  assert.equal(store.isSaved(project), false);
  assert.deepEqual(await call('POST', '/api/style-guide/scale', { base: { r: 12 } }).then((r) => [r.status, r.json.code]), [400, 'BAD_COLOR']);
  assert.deepEqual(await call('POST', '/api/style-guide/scale', { base: { toString: 'hostile' } }).then((r) => [r.status, r.json.code]), [400, 'BAD_COLOR']);
  assert.deepEqual(await call('POST', '/api/style-guide/contrast', { fg: { r: 12 }, bg: '#fff' }).then((r) => [r.status, r.json.code]), [400, 'BAD_COLOR']);
  assert.deepEqual(await call('POST', '/api/style-guide/dark-semantic', { light: { background: { toString: 'hostile' } } }).then((r) => [r.status, r.json.code]), [400, 'BAD_REQUEST']);
});
