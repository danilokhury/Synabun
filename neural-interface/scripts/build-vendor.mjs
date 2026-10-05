// One-shot vendor bundler — bundles xterm.js + addons into public/vendor/xterm/
// as a version-stamped ESM file, and copies xterm.css alongside it; then the
// parts of three.js the memory map uses into public/vendor/three/.
// Run via `npm run build:vendor` (also wired into postinstall).
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'vendor', 'xterm');
const version = JSON.parse(readFileSync(join(root, 'node_modules/@xterm/xterm/package.json'), 'utf8')).version;

mkdirSync(outDir, { recursive: true });

// Remove stale bundles from previous versions so only one copy ships.
for (const f of readdirSync(outDir)) {
  if (f.startsWith('xterm-') && !f.includes(version)) unlinkSync(join(outDir, f));
}

await build({
  entryPoints: [join(root, 'scripts', 'vendor-xterm-entry.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  outfile: join(outDir, `xterm-${version}.min.js`),
  logLevel: 'info',
});

copyFileSync(
  join(root, 'node_modules/@xterm/xterm/css/xterm.css'),
  join(outDir, `xterm-${version}.css`),
);

// Manifest lets the client (and future tooling) discover the current version.
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ version }, null, 2) + '\n');

console.log(`vendored xterm ${version} → public/vendor/xterm/`);

// three is a devDependency: the bundle is checked in, so an install without
// dev dependencies keeps the committed copy instead of failing here.
const threePkg = join(root, 'node_modules/three/package.json');
if (!existsSync(threePkg)) {
  console.log('three is not installed — keeping the committed public/vendor/three/ bundle');
} else {
  const threeVersion = JSON.parse(readFileSync(threePkg, 'utf8')).version;
  const threeDir = join(root, 'public', 'vendor', 'three');
  mkdirSync(threeDir, { recursive: true });
  for (const f of readdirSync(threeDir)) {
    if (f.startsWith('three-') && !f.includes(threeVersion)) unlinkSync(join(threeDir, f));
  }
  await build({
    entryPoints: [join(root, 'scripts', 'vendor-three-entry.js')],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    outfile: join(threeDir, `three-${threeVersion}.min.js`),
    logLevel: 'info',
  });
  writeFileSync(join(threeDir, 'manifest.json'), JSON.stringify({ version: threeVersion }, null, 2) + '\n');
  console.log(`vendored three ${threeVersion} → public/vendor/three/`);
}
