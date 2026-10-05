import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMergePatch, normalizeStyleGuide, tokenKey } from '../lib/style-guide/schema.js';
import { fetchCommunityDesignMd, importDtcg, importTailwindTheme, parseYamlSubset, scanCodebase, splitFrontmatter } from '../lib/style-guide/import.js';
import { createStyleGuideStore, loadStyleGuideForRun, PROPOSAL_LIMIT } from '../lib/style-guide/store.js';
import { findPointer, pointerBlock, removePointer, upsertPointer } from '../lib/style-guide/pointers.js';
import { renderDesignMd } from '../lib/style-guide/render-design-md.js';
import { exportDtcg, walkDtcg } from '../lib/style-guide/export-dtcg.js';
import { exportCss } from '../lib/style-guide/export-css.js';
import { exportTailwindV4 } from '../lib/style-guide/export-tailwind.js';
import { parseEasing, parseShadow } from '../lib/style-guide/tokens.js';

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'synabun-sg-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(project); mkdirSync(outside);
  const store = createStyleGuideStore({ dataHome: join(root, 'data-home'), projects: () => [project] });
  return { root, project, outside, store };
}

test('project resolution refuses escaping and dangling symlinks, including missing descendants', (t) => {
  const { root, project, outside, store } = sandbox(t);
  symlinkSync(outside, join(project, 'escape'));
  symlinkSync(join(outside, 'missing'), join(project, 'dangling'));
  for (const path of ['escape', 'escape/new/file', 'dangling', 'dangling/new']) assert.equal(store.resolveProject(join(project, path)), null, path);
  assert.equal(store.resolveProject(join(project, 'new/file')).path, project);
  store.save(project, {});
  assert.equal(loadStyleGuideForRun(join(project, 'escape'), 'code', { dataHome: join(root, 'data-home') }), null);
});

test('saves and logo mirrors reject escaping links before committing a revision', (t) => {
  const { project, outside, store } = sandbox(t);
  symlinkSync(outside, join(project, '.synabun'));
  assert.throws(() => store.save(project, {}), { code: 'UNSAFE_PATH', status: 403 });
  assert.equal(store.isSaved(project), false);
  assert.equal(existsSync(join(project, 'DESIGN.md')), false);
  assert.equal(existsSync(join(outside, 'style-guide')), false);
  rmSync(join(project, '.synabun'));
  const saved = store.save(project, {}).config;
  symlinkSync(outside, join(project, 'tokens-out'));
  assert.throws(() => store.save(project, { ...saved, exports: { ...saved.exports, outDir: 'tokens-out' } }), { code: 'UNSAFE_PATH' });
  assert.equal(store.load(project).config.revision, 1);
  const assets = store.paths(project).assets;
  mkdirSync(assets, { recursive: true });
  symlinkSync(join(outside, 'secret.svg'), join(assets, 'logo.svg'));
  writeFileSync(join(outside, 'secret.svg'), 'secret');
  assert.throws(() => store.save(project, { ...saved, logo: { ...saved.logo, variants: [{ id: 'logo', file: 'logo.svg' }] } }), { code: 'UNSAFE_PATH' });
  assert.equal(store.load(project).config.revision, 1);
});

test('YAML flow maps and list-map keys cannot create prototypes or shadow constructors', () => {
  for (const yaml of ['x: {__proto__: {polluted: true}, constructor: evil, prototype: bad, ok: yes}', 'x:\n  - __proto__: {polluted: true}\n    constructor: evil\n    ok: yes']) {
    const doc = parseYamlSubset(yaml);
    const item = Array.isArray(doc.x) ? doc.x[0] : doc.x;
    assert.equal(Object.getPrototypeOf(item), Object.prototype);
    assert.deepEqual(Object.keys(item), ['ok']);
    assert.equal(item.ok, true);
  }
  assert.equal({}.polluted, undefined);
});

test('hostile YAML and JSON fail with bounded nesting and size, not stack overflow', () => {
  for (const yaml of [Array.from({ length: 80 }, (_, i) => `${' '.repeat(i * 2)}a:`).join('\n'), `x: ${'['.repeat(80)}0${']'.repeat(80)}`]) {
    assert.throws(() => parseYamlSubset(yaml), { code: 'BAD_YAML' });
  }
  const deep = '{"a":'.repeat(80) + '0' + '}'.repeat(80);
  for (const importer of [importDtcg, importTailwindTheme]) {
    assert.throws(() => importer(deep), { code: 'BAD_JSON' });
    assert.throws(() => importer(' '.repeat(2 * 1024 * 1024 + 1)), { code: 'TOO_LARGE' });
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']) assert.throws(() => importer(`{"x":{"${key}":{}}}`), { code: 'BAD_JSON' });
  }
  assert.throws(() => parseYamlSubset('x'.repeat(2 * 1024 * 1024 + 1)), { code: 'TOO_LARGE' });
  assert.throws(() => applyMergePatch({}, JSON.parse(deep)), /nesting/);
  assert.equal(normalizeStyleGuide(JSON.parse(deep)).schemaVersion, 2);
});

test('normalize and merge patch sanitize nested pollution keys and CSS token names', () => {
  const hostile = JSON.parse('{"brand":{"__proto__":{"polluted":true},"name":"Safe"},"colors":{"palettes":{"constructor":{"base":"#000"}}},"layout":{"spacing":{"scale":{"a; color:red":8,"__proto__":9}}}}');
  const guide = normalizeStyleGuide(hostile);
  assert.equal(guide.brand.name, 'Safe');
  assert.equal(Object.hasOwn(guide.colors.palettes, 'constructor'), false);
  assert.deepEqual(guide.layout.spacing.scale, { 'a-color-red': 8 });
  assert.equal(tokenKey('a; } body {'), 'a-body');
  const patched = applyMergePatch({}, { list: [hostile.brand] });
  assert.equal(Object.hasOwn(patched.list[0], '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('normalization keeps a palette base at 500 even when a stale scale accompanies an edited base', () => {
  const guide = normalizeStyleGuide({ schemaVersion: 2, colors: { palettes: { primary: { base: '#ff0000', steps: { 500: '#0000ff' } } } } });
  assert.equal(guide.colors.palettes.primary.steps['500'], guide.colors.palettes.primary.base);
  assert.deepEqual(normalizeStyleGuide(guide), guide);
});

test('hostile object colors cannot persist invalid hex tokens or throw during normalization', () => {
  for (const value of [{ r: 12 }, { toString: 'invalid' }]) {
    const guide = normalizeStyleGuide({ colors: { palettes: { primary: { base: value, steps: { 500: value } } }, status: { danger: value, extra: value }, semantic: { light: { background: value } } } });
    assert.equal(guide.colors.palettes.primary.base, '#3b82f6');
    assert.deepEqual(walkDtcg(exportDtcg(guide)).problems, []);
    assert.ok(walkDtcg(exportDtcg(guide)).tokens.every((token) => token.value !== null));
  }
});

test('community reader stops oversized streams early and cancels them', async () => {
  let pulls = 0; let cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(24)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(fetchCommunityDesignMd('test', { maxBytes: 32, fetchImpl: async () => ({ ok: true, status: 200, body }) }), { code: 'TOO_LARGE' });
  assert.equal(pulls, 2); assert.equal(cancelled, true);
});

test('community reader refuses declared oversize and redirected responses without reading', async () => {
  let read = false;
  for (const extra of [{ headers: new Headers({ 'content-length': '99' }) }, { redirected: true, url: 'http://127.0.0.1/private' }]) {
    await assert.rejects(fetchCommunityDesignMd('test', { maxBytes: 32, fetchImpl: async (url, options) => {
      assert.match(url, /^https:\/\/raw\.githubusercontent\.com\//); assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, text: async () => { read = true; return ''; }, ...extra };
    } }), (error) => ['TOO_LARGE', 'FETCH_FAILED'].includes(error.code));
  }
  assert.equal(read, false);
});

test('codebase scan excludes linked files and directories and oversized files', (t) => {
  const { project, outside } = sandbox(t);
  writeFileSync(join(outside, 'tokens.css'), ':root { --color-primary-500: #000000; }');
  symlinkSync(outside, join(project, 'escape'));
  symlinkSync(join(outside, 'tokens.css'), join(project, 'linked.css'));
  writeFileSync(join(project, 'large.css'), ':root { --color-primary-500: #000000; }' + ' '.repeat(1024 * 1024));
  assert.deepEqual(scanCodebase(project).files, []);
});

test('pending proposals cannot be accepted after proposals are disabled; rejections keep their diff', (t) => {
  const { project, store } = sandbox(t);
  const saved = store.save(project, {}).config;
  const proposal = store.addProposal(project, { reason: 'Name', changes: { brand: { name: 'Changed' } } });
  store.save(project, { ...saved, agents: { ...saved.agents, allowProposals: false } });
  assert.throws(() => store.acceptProposal(project, proposal.id), { code: 'PROPOSALS_OFF', status: 422 });
  assert.equal(store.proposals(project)[0].status, 'pending');
  store.rejectProposal(project, proposal.id);
  assert.deepEqual(store.proposals(project)[0].diff, proposal.diff);
});

test('pending proposals have a hard cap rather than unbounded growth', (t) => {
  const { project, store } = sandbox(t);
  store.save(project, {});
  const rows = Array.from({ length: PROPOSAL_LIMIT }, (_, i) => ({ id: `p${i}`, status: 'pending', changes: {} }));
  writeFileSync(store.paths(project).proposals, JSON.stringify(rows));
  assert.throws(() => store.addProposal(project, { reason: 'Name', changes: { brand: { name: 'Next' } } }), { code: 'TOO_MANY_PROPOSALS', status: 429 });
  assert.equal(store.pendingCount(project), PROPOSAL_LIMIT);
});

test('pointer edits preserve bytes outside the block and refuse all damaged or duplicate markers', () => {
  const block = pointerBlock({ exports: { outDir: 'design' } });
  assert.match(block, /`design\/tokens.json`/);
  const prefix = '\uFEFF# Own notes\r\n\r\n\r\n';
  assert.ok(upsertPointer(prefix, block).startsWith(prefix));
  const file = `${prefix}${block.replaceAll('\n', '\r\n')}\r\n\r\nTail\r\n`;
  assert.equal(removePointer(file), `${prefix}\r\nTail\r\n`);
  for (const damaged of [`${block}\n${block}`, `${block}\n<!-- synabun:styleguide:end -->`, `<!-- synabun:styleguide:end -->\n${block}`]) {
    assert.equal(findPointer(damaged).damaged, true);
    assert.throws(() => upsertPointer(damaged, block), /damaged/);
    assert.throws(() => removePointer(damaged), /damaged/);
  }
});

test('default DESIGN.md uses all community frontmatter keys and community sections in order', () => {
  const community = readFileSync(new URL('./fixtures/style-guide/community-DESIGN.md', import.meta.url), 'utf8');
  const md = renderDesignMd({ projectPath: '/acme' });
  assert.deepEqual(Object.keys(splitFrontmatter(md).data), Object.keys(splitFrontmatter(community).data));
  const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings(md).filter((h) => headings(community).includes(h)), headings(community));
  assert.deepEqual(splitFrontmatter(renderDesignMd({ components: [] })).data.components, {});
  assert.equal(md, renderDesignMd({ projectPath: '/acme' }));
});

test('unexpressible shadows and invalid cubic bezier x coordinates are skipped in DTCG', () => {
  assert.equal(parseEasing('cubic-bezier(-1, 0, 2, 1)'), null);
  assert.deepEqual(parseEasing('cubic-bezier(0, -2, 1, 3)'), [0, -2, 1, 3]);
  assert.equal(parseShadow('0 1px -2px #000'), null);
  assert.equal(parseShadow('0 1px 2px rgb(nonsense)'), null);
  const doc = exportDtcg({ shape: { elevation: { invalid: { shadow: '0 1px -2px #000' } } }, motion: { easings: { invalid: 'cubic-bezier(2, 0, 2, 1)' } } });
  assert.deepEqual(doc.$extensions['dev.synabun'].skipped, ['shadow.invalid', 'cubicBezier.invalid']);
  assert.deepEqual(walkDtcg(doc).problems, []);
});

test('every Tailwind v4 color variable reference names a tokens.css variable', () => {
  const config = normalizeStyleGuide({});
  const css = exportCss(config);
  const names = new Set([...css.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  for (const ref of exportTailwindV4(config).matchAll(/var\((--[\w-]+)/g)) assert.ok(names.has(ref[1]), ref[1]);
});

test('dark attribute/class declarations override a custom ID root, on the root or an ancestor', () => {
  for (const [darkMode, selector] of [['attribute', '#app[data-theme="dark"], [data-theme="dark"] #app'], ['class', '#app.dark, .dark #app']]) {
    const config = normalizeStyleGuide({ exports: { cssSelector: '#app', darkMode } });
    for (const css of [exportCss(config), exportTailwindV4(config)]) {
      assert.ok(css.includes(`${selector} {`));
      const block = css.slice(css.indexOf(`${selector} {`));
      assert.match(block, /--color-background: var\(--color-neutral-950\)/);
    }
  }
});

test('the npm package includes the style guide documentation linked by shipped instructions', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('docs/style-guide.md'));
});
