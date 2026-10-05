import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const PUBLIC = new URL('../public/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, PUBLIC), 'utf8');

test('the 3D page loads three.js from the vendored bundle, never a CDN', () => {
  const html = read('index.html');
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  const target = map.imports.three;
  assert.match(target, /^\/vendor\/three\/three-[\d.]+\.min\.js$/);
  assert.ok(existsSync(new URL('.' + target, PUBLIC)), `${target} is missing — run npm run build:vendor`);
  const { version } = JSON.parse(read('vendor/three/manifest.json'));
  assert.equal(target, `/vendor/three/three-${version}.min.js`, 'import map and manifest disagree');
  // The import map has to precede any module load (the preload included).
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('rel="modulepreload"'));
  assert.doesNotMatch(html, /esm\.sh|unpkg|jsdelivr/);
});

test('nothing reaches for the old window globals or a CDN three', () => {
  const files = [
    'index.html',
    ...readdirSync(new URL('variant/3d/', PUBLIC)).map((f) => `variant/3d/${f}`),
    ...readdirSync(new URL('shared/', PUBLIC)).filter((f) => f.endsWith('.js')).map((f) => `shared/${f}`),
  ];
  for (const rel of files) {
    const src = read(rel);
    assert.doesNotMatch(src, /window\.(THREE|TWEEN|OrbitControls|EffectComposer|UnrealBloomPass)\b/, rel);
    assert.doesNotMatch(src, /esm\.sh\/three/, rel);
  }
});

test('only the renderer imports three (the rest of the map stays DOM/three-free or lazy)', () => {
  for (const f of readdirSync(new URL('variant/3d/', PUBLIC))) {
    const src = read(`variant/3d/${f}`);
    const importsThree = /from ['"]three['"]/.test(src);
    assert.equal(importsThree, f === 'map-renderer.js', `${f} ${importsThree ? 'imports' : 'does not import'} three`);
  }
  assert.match(read('variant/3d/main.js'), /await import\('\.\/map-renderer\.js'\)/, 'main.js loads the renderer lazily');
});
