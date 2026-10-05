// The OpenCode panel is served as static ES modules and reloads at any moment.
// An import that names an export which does not exist breaks the whole panel
// at load time, and nothing else in the Node suite would notice: every module
// here is parsed and each named import is checked against its target file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/shared/ocp-v2');

function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default\b/m.test(src)) names.add('default');
  const star = /^export\s+\*\s+from\s+['"]/m.test(src);
  return { names, star };
}

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(/^import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+['"]([^'"]+)['"]/gm)) {
    const [, defaultName, named, spec] = m;
    if (!spec.startsWith('.')) continue;
    const names = [];
    if (defaultName) names.push('default');
    for (const piece of (named || '').split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
    out.push({ spec, names });
  }
  return out;
}

test('every relative import of the OpenCode panel names an export that exists', () => {
  const files = readdirSync(PANEL_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 17, 'panel modules found');
  const problems = [];
  for (const name of files) {
    const file = resolve(PANEL_DIR, name);
    for (const { spec, names } of importsOf(file)) {
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) { problems.push(`${name}: ${spec} does not exist`); continue; }
      const { names: exported, star } = exportsOf(target);
      if (star) continue;
      for (const wanted of names) {
        if (!exported.has(wanted)) problems.push(`${name}: ${spec} has no export "${wanted}"`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('nothing under ocp-v2 imports the retired ocp/ tree', () => {
  for (const name of readdirSync(PANEL_DIR).filter((f) => f.endsWith('.js'))) {
    const specs = importsOf(resolve(PANEL_DIR, name)).map((i) => i.spec);
    assert.deepEqual(specs.filter((spec) => /(^|\/)ocp\//.test(spec)), [], name);
  }
});

test('markdown reaches innerHTML only through the sanitizer', () => {
  const render = readFileSync(resolve(PANEL_DIR, 'ocp-v2-render.js'), 'utf8');
  assert.match(render, /import \{ sanitizeHtmlString \} from '\.\.\/assistant\/asst-sanitize\.js'/);
  assert.match(render, /html = sanitizeHtmlString\(_marked\.parse\(text\)\)/);
  // The only other producer of markup for renderMarkdown is the escaper.
  const body = render.slice(render.indexOf('function renderMarkdown'), render.indexOf('function escapeHtml'));
  assert.equal((body.match(/_marked\.parse\(/g) || []).length, 1);
  assert.equal((body.match(/html = /g) || []).length, 3);
  // Every innerHTML sink fed by model text goes through renderMarkdown.
  for (const m of render.matchAll(/\.innerHTML = ([^;]+);/g)) {
    const value = m[1].trim();
    const safe = value.startsWith('renderMarkdown(') || value.startsWith("'") || /^[A-Z_]+$/.test(value) || value === 'info.icon';
    assert.ok(safe, `unexpected innerHTML source: ${value}`);
  }
});
