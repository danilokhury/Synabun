// SynaBun — the facts behind Settings → About (GET /api/system/about)
//
// What the About page shows: the app (version, channel, how it was installed, the Git branch of a clone), the
// runtime it runs on, the links its package.json and README give, and every dependency of the packages the
// product is made of, each with the version actually installed and its license. Everything is read from files
// on disk: package.json files, node_modules/<name>/package.json, the vendored bundles' manifest.json, LICENSE,
// .git/HEAD. No npm, no git process, no network. The answer is built on the first get() and kept for the life of
// the process: the code that runs does not change until a restart either.
//
// Never in it: an environment variable, a token, a setting. A path is the data folder's and nothing else.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import os from 'node:os';
import { formatSynabunVersion, synabunReleaseChannel } from './synabun-version.js';

/**
 * The packages the product is made of, relative to the package root. One that is not on disk (the desktop app's
 * shell is in a Git clone only; inside the desktop app it is packed where the server cannot read it) is left out.
 * `onDemand`: installed later, by SynaBun itself, into `installDirs` (the WhatsApp connector, lib/whatsapp/installer.js).
 */
export const ABOUT_PACKAGES = Object.freeze([
  Object.freeze({ id: 'neural-interface', dir: 'neural-interface' }),
  Object.freeze({ id: 'mcp-server', dir: 'mcp-server' }),
  Object.freeze({ id: 'desktop', dir: 'packaging/desktop' }),
  Object.freeze({ id: 'whatsapp-connector', dir: 'neural-interface/lib/whatsapp/connector', onDemand: true }),
]);

/** Front-end libraries bundled into public/vendor/ by scripts/build-vendor.mjs: folder → package and product name. */
const VENDOR_BUNDLES = Object.freeze({
  three: { label: 'three.js', name: 'three' },
  xterm: { label: 'xterm.js', name: '@xterm/xterm' },
  codemirror: { label: 'CodeMirror' },
});

// The community links README.md gives (package.json has no field for them).
const COMMUNITY_LINKS = Object.freeze([
  Object.freeze({ id: 'discord', url: 'https://discord.gg/x6yWqE9GZP' }),
  Object.freeze({ id: 'x', url: 'https://x.com/SynabunAI' }),
]);

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const MAX_TEXT = 200;

const text = (value, max = MAX_TEXT) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function readText(path, max = 256 * 1024) {
  try {
    const body = readFileSync(path, 'utf8');
    return body.length > max ? body.slice(0, max) : body;
  } catch { return ''; }
}

/** A package.json's license, as written: an SPDX expression, the old object, or the old list. */
export function licenseOf(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const one = (value) => (typeof value === 'string' ? text(value, 64) : value && typeof value === 'object' ? text(value.type, 64) : null);
  if (pkg.license != null) return one(pkg.license);
  if (Array.isArray(pkg.licenses)) {
    const all = pkg.licenses.map(one).filter(Boolean);
    return all.length ? all.join(' OR ').slice(0, 64) : null;
  }
  return null;
}

/** Is `child` the folder `parent` or inside it? */
function within(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where Node would find `name` for a package in `dir`: node_modules of `dir` and of each folder above it, up to
 * `root` and never past it, then the extra folders (an on-demand install). The package.json found, or null.
 */
function installedPackage(name, dir, root, extraDirs = []) {
  if (!NPM_NAME.test(name)) return null;
  const folders = [];
  if (within(dir, root)) {
    for (let at = dir; ; at = resolve(at, '..')) {
      folders.push(at);
      if (at === root || resolve(at, '..') === at) break;
    }
  }
  for (const extra of extraDirs) folders.push(extra);
  for (const folder of folders) {
    const pkg = readJson(join(folder, 'node_modules', ...name.split('/'), 'package.json'));
    if (pkg && typeof pkg.version === 'string') return pkg;
  }
  return null;
}

/** One dependency: the range package.json declares, the version installed (or null) and its license. */
function dependencyRow(name, declared, dir, root, extraDirs, extra = {}) {
  const pkg = installedPackage(name, dir, root, extraDirs);
  return {
    name: String(name).slice(0, 214),
    declared: text(String(declared ?? ''), 120) || '',
    version: pkg ? text(pkg.version, 64) : null,
    installed: !!pkg,
    license: licenseOf(pkg),
    ...extra,
  };
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en');

/** The dependency groups of one package of the product, or null when its package.json is not on disk. */
export function readProductPackage(spec, { root, installDirs = [] } = {}) {
  const dir = resolve(root, spec.dir);
  const pkg = readJson(join(dir, 'package.json'));
  if (!pkg || typeof pkg !== 'object') return null;
  const deps = (field) => (pkg[field] && typeof pkg[field] === 'object' && !Array.isArray(pkg[field]) ? Object.entries(pkg[field]) : []);
  const optional = new Set(deps('optionalDependencies').map(([name]) => name));
  const runtime = [
    ...deps('dependencies').filter(([name]) => !optional.has(name)).map(([name, range]) => dependencyRow(name, range, dir, root, installDirs)),
    ...deps('optionalDependencies').map(([name, range]) => dependencyRow(name, range, dir, root, installDirs, { optional: true })),
  ].sort(byName);
  const dev = deps('devDependencies').map(([name, range]) => dependencyRow(name, range, dir, root, installDirs)).sort(byName);
  return {
    id: spec.id,
    name: text(pkg.name, 214) || spec.id,
    version: text(pkg.version, 64),
    onDemand: !!spec.onDemand,
    runtime,
    dev,
  };
}

/** The bundles in public/vendor/: each with the version its manifest records, and the packages it holds. */
export function readVendored(vendorDir, { licenseFrom } = {}) {
  let folders = [];
  try { folders = readdirSync(vendorDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
  const out = [];
  for (const folder of folders) {
    const manifest = readJson(join(vendorDir, folder, 'manifest.json'));
    const version = text(manifest?.version, 64);
    if (!manifest || !version) continue; // no manifest, no honest version
    const known = VENDOR_BUNDLES[folder] || {};
    let packages;
    if (manifest.packages && typeof manifest.packages === 'object') {
      packages = Object.entries(manifest.packages)
        .filter(([name, v]) => NPM_NAME.test(name) && typeof v === 'string' && v)
        .map(([name, v]) => ({ name, version: v.slice(0, 64) }));
    } else {
      const name = known.name || folder;
      if (!NPM_NAME.test(name)) continue;
      packages = [{ name, version: version.replace(/-[0-9a-f]{8}$/, '') }];
    }
    for (const p of packages) p.license = licenseFrom ? licenseFrom(p.name, p.version) : null;
    packages.sort(byName);
    out.push({ id: folder, label: known.label || folder, version: version.replace(/-[0-9a-f]{8}$/, ''), packages });
  }
  return out;
}

/** `git+https://github.com/o/r.git` → `https://github.com/o/r`; null for anything but an https address. */
export function repositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return null;
  const url = raw.trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+\/[^\s]+$/.test(url) ? url : null;
}

const httpsOrNull = (value) => (typeof value === 'string' && /^https:\/\/\S+$/.test(value.trim()) ? value.trim().replace(/\/+$/, '') : null);

/**
 * The project's links, from the root package.json: repository, homepage, bugs, name. The website's docs and
 * changelog pages, the npm page and the community links are the addresses README.md gives; the license is the
 * README's ./LICENSE on GitHub's default branch. A link whose source is missing is left out.
 */
export function aboutLinks(pkg) {
  const repository = repositoryUrl(pkg?.repository);
  const github = repository && /^https:\/\/github\.com\//.test(repository) ? repository : null;
  const website = httpsOrNull(pkg?.homepage);
  const issues = httpsOrNull(typeof pkg?.bugs === 'string' ? pkg.bugs : pkg?.bugs?.url) || (github ? `${github}/issues` : null);
  const name = typeof pkg?.name === 'string' && NPM_NAME.test(pkg.name) ? pkg.name : null;
  const links = [
    { id: 'repository', url: repository },
    { id: 'releases', url: github ? `${github}/releases` : null },
    { id: 'changelog', url: website ? `${website}/changelog` : null },
    { id: 'issues', url: issues },
    { id: 'website', url: website },
    { id: 'docs', url: website ? `${website}/docs` : null },
    { id: 'npm', url: name && !pkg.private ? `https://www.npmjs.com/package/${name}` : null },
    { id: 'license', url: github ? `${github}/blob/main/LICENSE` : null },
    ...COMMUNITY_LINKS,
  ];
  return links.filter((link) => link.url);
}

/** The years and holder of the copyright line, from LICENSE (or NOTICE); the holder is package.json's author when it names one. */
export function copyrightOf({ license = '', notice = '', author = null } = {}) {
  const lines = `${license}\n${notice}`.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*Copyright\s+(?:\(c\)\s*|©\s*)?(\d{4}(?:\s*[-–]\s*\d{4})?)\s+(.+?)\s*$/i.exec(line);
    if (!m || /\[|\]/.test(m[2])) continue; // the Apache template's "[yyyy] [name of copyright owner]"
    return { years: m[1].replace(/\s*[-–]\s*/, '–'), holder: author || text(m[2], 120) };
  }
  return null;
}

const authorName = (author) => text(typeof author === 'string' ? author.replace(/\s*[<(].*$/, '') : author?.name, 120);

/** The branch and short commit of the checkout at `root`, read from .git (a worktree's `gitdir:` file too). */
export function readGitHead(root) {
  let gitDir = join(root, '.git');
  try {
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readText(gitDir, 4096));
      if (!m) return null;
      gitDir = resolve(root, m[1].trim());
    }
  } catch { return null; }
  const head = readText(join(gitDir, 'HEAD'), 4096).trim();
  if (!head) return null;
  const common = (() => {
    const pointer = readText(join(gitDir, 'commondir'), 4096).trim();
    return pointer ? resolve(gitDir, pointer) : gitDir;
  })();
  const ref = /^ref:\s*(refs\/heads\/([^\s]+))$/.exec(head);
  let commit = null;
  if (ref && !ref[1].split('/').includes('..')) {
    for (const dir of [gitDir, common]) {
      const loose = readText(join(dir, ...ref[1].split('/')), 4096).trim();
      if (/^[0-9a-f]{40,64}$/.test(loose)) { commit = loose; break; }
    }
    if (!commit) {
      const packed = readText(join(common, 'packed-refs'));
      const line = packed.split(/\r?\n/).find((l) => l.endsWith(` ${ref[1]}`));
      if (line && /^[0-9a-f]{40,64} /.test(line)) commit = line.split(' ')[0];
    }
  } else if (/^[0-9a-f]{40,64}$/.test(head)) {
    commit = head;
  }
  const branch = ref ? text(ref[2], 120) : null;
  if (!branch && !commit) return null;
  return { branch, commit: commit ? commit.slice(0, 7) : null };
}

/** The operating system's own name and version: macOS from SystemVersion.plist, Linux from os-release, Windows from os.version(). */
export function readOsInfo({ platform = process.platform, readFile = readText, osApi = os } = {}) {
  const kernel = `${osApi.type()} ${osApi.release()}`;
  let name = null;
  let version = null;
  if (platform === 'darwin') {
    const plist = readFile('/System/Library/CoreServices/SystemVersion.plist', 64 * 1024);
    const key = (k) => text(new RegExp(`<key>${k}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1], 64);
    name = key('ProductName') || 'macOS';
    version = key('ProductVersion');
  } else if (platform === 'linux') {
    const release = readFile('/etc/os-release', 64 * 1024);
    const field = (k) => text(new RegExp(`^${k}=("?)([^"\\n]*)\\1\\s*$`, 'm').exec(release)?.[2], 120);
    name = field('NAME') || 'Linux';
    version = field('VERSION_ID') || field('VERSION');
  } else if (platform === 'win32') {
    name = text(typeof osApi.version === 'function' ? osApi.version() : '', 120) || 'Windows';
    version = text(osApi.release(), 64);
  } else {
    name = text(osApi.type(), 64);
    version = text(osApi.release(), 64);
  }
  return { name, version, kernel: text(kernel, 120), platform, arch: process.arch };
}

/**
 * The About facts of this install, built on the first get() and kept.
 *
 * @param {Object} o
 * @param {string} o.packageRoot   the SynaBun package (PACKAGE_ROOT)
 * @param {string} o.dataHome      the data folder (shown on the page; it is the owner's, and the route is the owner's)
 * @param {number|string} o.port   the port the server listens on
 * @param {'desktop'|'app'|'npm'|'git'} o.install  how this copy was installed
 * @param {Object<string, string[]>} [o.installDirs]  more folders to resolve a package's dependencies in, by package id
 * @param {string} [o.vendorDir]   the vendored bundles (public/vendor of the Neural Interface)
 * @param {() => Object} [o.runtime]  the runtime facts (tests); default: this process
 */
export function createSystemAbout({ packageRoot, dataHome, port, install, installDirs = {}, vendorDir, runtime } = {}) {
  const root = resolve(packageRoot);
  let cached = null;

  const build = () => {
    const pkg = readJson(join(root, 'package.json')) || {};
    const version = typeof pkg.version === 'string' ? (formatSynabunVersion(pkg.version) || text(pkg.version, 64)) : null;
    const author = authorName(pkg.author);
    const packages = ABOUT_PACKAGES.map((spec) => readProductPackage(spec, { root, installDirs: installDirs[spec.id] || [] })).filter(Boolean);
    const ni = resolve(root, 'neural-interface');
    const vendored = readVendored(vendorDir || join(ni, 'public', 'vendor'), {
      // The bundle was built from the packages in the Neural Interface's node_modules: their license, when they are there.
      licenseFrom: (name) => licenseOf(installedPackage(name, ni, root)),
    });
    const count = (list) => list.length;
    const counts = {
      runtime: packages.reduce((n, p) => n + count(p.runtime), 0),
      dev: packages.reduce((n, p) => n + count(p.dev), 0),
      vendored: vendored.reduce((n, b) => n + count(b.packages), 0),
    };
    counts.total = counts.runtime + counts.dev + counts.vendored;
    const facts = runtime ? runtime() : {
      node: process.versions.node,
      sqlite: process.versions.sqlite || null,
      os: readOsInfo(),
    };
    return {
      app: {
        name: 'SynaBun',
        package: text(pkg.name, 214),
        version,
        channel: version ? synabunReleaseChannel(version) : 'stable',
        description: text(pkg.description),
        license: licenseOf(pkg),
        author,
        copyright: copyrightOf({ license: readText(join(root, 'LICENSE')), notice: readText(join(root, 'NOTICE')), author }),
        install: ['desktop', 'app', 'npm', 'git'].includes(install) ? install : null,
        git: install === 'git' ? readGitHead(root) : null,
      },
      runtime: {
        node: facts.node || null,
        sqlite: facts.sqlite || null,
        os: facts.os || null,
        dataHome: typeof dataHome === 'string' ? dataHome : null,
        port: Number(port) || null,
      },
      links: aboutLinks(pkg),
      dependencies: { packages, vendored, counts },
      builtAt: new Date().toISOString(),
    };
  };

  return {
    get() {
      if (!cached) cached = build();
      return cached;
    },
  };
}
