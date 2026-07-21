// One-shot vendor bundler — bundles xterm.js + addons into public/vendor/xterm/
// as a version-stamped ESM file, and copies xterm.css alongside it.
// Run via `npm run build:vendor` (also wired into postinstall).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
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
