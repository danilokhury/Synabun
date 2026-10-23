// One-shot vendor bundler — bundles xterm.js + addons into public/vendor/xterm/
// as a version-stamped ESM file, and copies xterm.css alongside it; then the
// parts of three.js the memory map uses into public/vendor/three/, the
// parts of CodeMirror 6 the code editor uses into public/vendor/codemirror/,
// and the browser builds of marked and mermaid into public/vendor/marked/ and
// public/vendor/mermaid/.
// Run via `npm run build:vendor` (also wired into postinstall).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
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

// marked (every Markdown sink of the panels), mermaid (the Skills preview's
// diagrams), highlight.js (the Codex panel's code blocks) and html2canvas (the
// card screenshot tool) are devDependencies too, and the same rule holds. They are copied,
// not bundled: each package ships its own browser build, and that build is what
// the pages loaded from a CDN before (marked@14 lib/marked.esm.js, mermaid@11
// dist/mermaid.esm.min.mjs and the chunks it imports by relative path, html2canvas
// 1.4.1 dist/html2canvas.min.js; highlight.js@11's stylesheet, beside the browser
// build of the same version, which the highlight.js package itself does not ship:
// @highlightjs/cdn-assets is its official one). The copy is those files, named after
// the version, with the source-map comment taken off (no map ships), beside the
// package's licence and a manifest.json naming the entry and any other file.
const stripSourceMap = (text) => text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');

function copyBuild(name, { pkg = name, entryFrom, entryName, chunksFrom = null, chunksTo = null, files = {}, license }) {
  const pkgDir = join(root, 'node_modules', pkg);
  if (!existsSync(join(pkgDir, 'package.json'))) {
    console.log(`${pkg} is not installed — keeping the committed public/vendor/${name}/ copy`);
    return;
  }
  const pkgVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  const dir = join(root, 'public', 'vendor', name);
  const entry = entryName(pkgVersion);
  const extra = Object.fromEntries(Object.entries(files).map(([key, [from, to]]) => [key, { from, to: to(pkgVersion) }]));
  const keep = new Set([entry, license, 'manifest.json', ...Object.values(extra).map((file) => file.to)]);
  mkdirSync(dir, { recursive: true });
  // New files first, then the manifest, then stale files (the CodeMirror order).
  if (chunksFrom) {
    const source = join(pkgDir, chunksFrom);
    const target = join(dir, chunksTo);
    mkdirSync(target, { recursive: true });
    for (const f of readdirSync(source).filter((f) => f.endsWith('.mjs'))) {
      const text = readFileSync(join(source, f), 'utf8');
      if (text.includes(entryFrom.split('/').pop())) throw new Error(`${name}: chunk ${f} imports the entry file`);
      writeFileSync(join(target, f), stripSourceMap(text));
      keep.add(`${chunksTo}/${f}`);
    }
  }
  writeFileSync(join(dir, entry), stripSourceMap(readFileSync(join(pkgDir, entryFrom), 'utf8')));
  for (const file of Object.values(extra)) writeFileSync(join(dir, file.to), stripSourceMap(readFileSync(join(pkgDir, file.from), 'utf8')));
  copyFileSync(join(pkgDir, license), join(dir, license));
  const named = Object.fromEntries(Object.entries(extra).map(([key, file]) => [key, file.to]));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: pkgVersion, entry, ...named }, null, 2) + '\n');
  // The folder is this step's own: any other file in it is a stale copy.
  for (const f of readdirSync(dir)) {
    if (!keep.has(f) && !statSync(join(dir, f)).isDirectory()) unlinkSync(join(dir, f));
  }
  if (chunksTo) {
    for (const f of readdirSync(join(dir, chunksTo))) {
      if (!keep.has(`${chunksTo}/${f}`)) unlinkSync(join(dir, chunksTo, f));
    }
  }
  console.log(`vendored ${name} ${pkgVersion} → public/vendor/${name}/`);
}

copyBuild('marked', {
  entryFrom: 'lib/marked.esm.js',
  entryName: (v) => `marked-${v}.esm.js`,
  license: 'LICENSE.md',
});
copyBuild('mermaid', {
  entryFrom: 'dist/mermaid.esm.min.mjs',
  entryName: (v) => `mermaid-${v}.esm.min.mjs`,
  chunksFrom: 'dist/chunks/mermaid.esm.min',
  chunksTo: 'chunks/mermaid.esm.min',
  license: 'LICENSE',
});
copyBuild('highlight', {
  pkg: '@highlightjs/cdn-assets',
  entryFrom: 'highlight.min.js',
  entryName: (v) => `highlight-${v}.min.js`,
  files: { stylesheet: ['styles/github-dark-dimmed.min.css', (v) => `github-dark-dimmed-${v}.min.css`] },
  license: 'LICENSE',
});
copyBuild('html2canvas', {
  entryFrom: 'dist/html2canvas.min.js',
  entryName: (v) => `html2canvas-${v}.min.js`,
  license: 'LICENSE',
});

// yaml: the Skills Studio's frontmatter form changes one key at a time and leaves
// every other byte of a SKILL.md as it was (public/shared/skills/ss-frontmatter.js).
// The server reads frontmatter with the `yaml` package itself (a dependency);
// the page gets the package's browser build, bundled into one file named after
// the version, beside the package's licence and a manifest.json naming it.
const yamlPkg = join(root, 'node_modules/yaml/package.json');
if (!existsSync(yamlPkg)) {
  console.log('yaml is not installed — keeping the committed public/vendor/yaml/ bundle');
} else {
  const yamlVersion = JSON.parse(readFileSync(yamlPkg, 'utf8')).version;
  const yamlDir = join(root, 'public', 'vendor', 'yaml');
  const yamlEntry = `yaml-${yamlVersion}.min.js`;
  mkdirSync(yamlDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'node_modules/yaml/browser/dist/index.js')],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    legalComments: 'none',
    outfile: join(yamlDir, yamlEntry),
    logLevel: 'info',
  });
  copyFileSync(join(root, 'node_modules/yaml/LICENSE'), join(yamlDir, 'LICENSE'));
  writeFileSync(join(yamlDir, 'manifest.json'), JSON.stringify({ version: yamlVersion, entry: yamlEntry }, null, 2) + '\n');
  // The folder is this step's own: any other file in it is a stale copy.
  for (const f of readdirSync(yamlDir)) {
    if (![yamlEntry, 'LICENSE', 'manifest.json'].includes(f)) unlinkSync(join(yamlDir, f));
  }
  console.log(`vendored yaml ${yamlVersion} → public/vendor/yaml/`);
}
