// One-shot vendor bundler — bundles xterm.js + addons into public/vendor/xterm/
// as a version-stamped ESM file, and copies xterm.css alongside it; then the
// parts of three.js the memory map uses into public/vendor/three/, and the
// parts of CodeMirror 6 the code editor uses into public/vendor/codemirror/.
// Run via `npm run build:vendor` (also wired into postinstall).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

// CodeMirror is a set of devDependencies too: same rule as three. Unlike the
// two bundles above it is split: the entry, the core chunk it shares with the
// languages, and one chunk per language of @codemirror/language-data, loaded
// on demand (chunks/). The entry is named after its version: the version of
// @codemirror/view plus a digest of every output file, so any change in what
// is bundled gives a new name. manifest.json tells the client which entry to
// import and lists every package that went into the bundle.
const codemirrorPackages = [
  '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands',
  '@codemirror/search', '@codemirror/autocomplete', '@codemirror/lint', '@codemirror/merge',
  '@codemirror/language-data', '@codemirror/legacy-modes', '@lezer/highlight',
  '@replit/codemirror-indentation-markers',
];
const packageJsonOf = (name) => join(root, 'node_modules', name, 'package.json');
if (codemirrorPackages.some((name) => !existsSync(packageJsonOf(name)))) {
  console.log('CodeMirror is not installed — keeping the committed public/vendor/codemirror/ bundle');
} else {
  const cmDir = join(root, 'public', 'vendor', 'codemirror');
  const result = await build({
    entryPoints: { codemirror: join(root, 'scripts', 'vendor-codemirror-entry.js') },
    bundle: true,
    format: 'esm',
    splitting: true,
    minify: true,
    target: 'es2022',
    outdir: cmDir,
    chunkNames: 'chunks/[name]-[hash]',
    write: false,
    metafile: true,
    logLevel: 'warning',
  });

  // Every package a bundled file came from, with the version that was installed.
  const packages = {};
  for (const input of Object.keys(result.metafile.inputs)) {
    const at = input.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const parts = input.slice(at + 'node_modules/'.length).split('/');
    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!packages[name]) packages[name] = JSON.parse(readFileSync(packageJsonOf(name), 'utf8')).version;
  }
  const sortedPackages = Object.fromEntries(Object.keys(packages).sort().map((name) => [name, packages[name]]));

  const outputs = result.outputFiles
    .map((file) => ({ rel: relative(cmDir, file.path).split('\\').join('/'), contents: file.contents }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const entryOutput = outputs.find((file) => file.rel === 'codemirror.js');
  if (!entryOutput) throw new Error('CodeMirror bundle: esbuild produced no entry file');
  const digest = createHash('sha256');
  for (const file of outputs) digest.update(file.rel).update('\0').update(file.contents).update('\0');
  const cmVersion = `${packages['@codemirror/view']}-${digest.digest('hex').slice(0, 8)}`;
  const entry = `codemirror-${cmVersion}.min.js`;
  // The entry is renamed below, so no chunk may import it by the name esbuild gave it.
  if (outputs.some((file) => file !== entryOutput && Buffer.from(file.contents).includes('codemirror.js'))) {
    throw new Error('CodeMirror bundle: a chunk imports the entry file');
  }
  entryOutput.rel = entry;

  // New files first, then the manifest, then stale files: a page that reads the
  // manifest during a rebuild is never pointed at a file that is not there yet.
  mkdirSync(join(cmDir, 'chunks'), { recursive: true });
  for (const file of outputs) writeFileSync(join(cmDir, file.rel), file.contents);
  writeFileSync(join(cmDir, 'manifest.json'), JSON.stringify({ version: cmVersion, entry, packages: sortedPackages }, null, 2) + '\n');
  const keep = new Set(outputs.map((file) => file.rel));
  for (const f of readdirSync(cmDir)) {
    if (f.startsWith('codemirror-') && f.endsWith('.js') && !keep.has(f)) unlinkSync(join(cmDir, f));
  }
  for (const f of readdirSync(join(cmDir, 'chunks'))) {
    if (!keep.has(`chunks/${f}`)) unlinkSync(join(cmDir, 'chunks', f));
  }
  const bytes = outputs.reduce((sum, file) => sum + file.contents.length, 0);
  console.log(`vendored codemirror ${cmVersion} → public/vendor/codemirror/ (${outputs.length} files, ${(bytes / (1024 * 1024)).toFixed(2)} MB)`);
}
