// ═══════════════════════════════════════════
// SETTINGS — About (what it says)
// ═══════════════════════════════════════════
//
// The About page reads GET /api/system/about (lib/system-about.js). A server from before that route answers 404
// until it restarts (the page's files are served live): the page then shows what /api/health and
// /api/system/version already say, with a note, and nothing fails. This module turns either answer into what the
// page draws: labels, the dependency lists a filter leaves, the plain-text block "Copy info" puts on the clipboard.
//
// No DOM and no imports: node --test loads it as it is (tests/settings-about.test.mjs). Strings come through the
// translate function the caller passes (`tx`, the kit's); the keys are written out in full so the i18n audit sees them.

export const ABOUT_URL = '/api/system/about';
/** The filter field shows once there are more dependencies than this. */
export const ABOUT_FILTER_MIN = 20;

const INSTALL_KEYS = {
  desktop: 'settings.redesign.about.install.desktop',
  app: 'settings.redesign.about.install.app',
  npm: 'settings.redesign.about.install.npm',
  git: 'settings.redesign.about.install.git',
};
const BUILD_KEYS = {
  stable: 'settings.redesign.about.channel.stable',
  prerelease: 'settings.redesign.about.channel.prerelease',
  dev: 'settings.redesign.about.channel.dev',
};
export const LINK_KEYS = {
  repository: 'settings.redesign.about.link.repository',
  releases: 'settings.redesign.about.link.releases',
  changelog: 'settings.redesign.about.link.changelog',
  issues: 'settings.redesign.about.link.issues',
  website: 'settings.redesign.about.link.website',
  docs: 'settings.redesign.about.link.docs',
  npm: 'settings.redesign.about.link.npm',
  license: 'settings.redesign.about.link.license',
  discord: 'settings.redesign.about.link.discord',
  x: 'settings.redesign.about.link.x',
};
const PACKAGE_KEYS = {
  'neural-interface': 'settings.redesign.about.package.neural_interface',
  'mcp-server': 'settings.redesign.about.package.mcp_server',
  desktop: 'settings.redesign.about.package.desktop',
  'whatsapp-connector': 'settings.redesign.about.package.whatsapp_connector',
};

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const SEP = ' · ';

const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const list = (value) => (Array.isArray(value) ? value : []);

/** An address the page may link to: https only. */
export const isExternalUrl = (url) => typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url);

/** A link's address without the scheme, for the quiet line beside its name. */
export const linkHost = (url) => String(url || '').replace(/^https:\/\//, '').replace(/\/+$/, '');

/** A package's page on npm, or null for a name npm would not have. */
export const npmUrl = (name) => (typeof name === 'string' && NPM_NAME.test(name) ? `https://www.npmjs.com/package/${name}` : null);

function readDependency(dep) {
  if (!dep || typeof dep !== 'object' || !str(dep.name)) return null;
  return {
    name: dep.name,
    declared: str(dep.declared) || '',
    version: dep.installed ? str(dep.version) : null,
    installed: !!dep.installed && !!str(dep.version),
    license: str(dep.license),
    optional: !!dep.optional,
  };
}

function readDependencies(deps) {
  if (!deps || typeof deps !== 'object') return null;
  const packages = list(deps.packages).filter((p) => p && str(p.id)).map((p) => ({
    id: p.id,
    name: str(p.name) || p.id,
    onDemand: !!p.onDemand,
    runtime: list(p.runtime).map(readDependency).filter(Boolean),
    dev: list(p.dev).map(readDependency).filter(Boolean),
  }));
  const vendored = list(deps.vendored).filter((b) => b && str(b.id)).map((b) => ({
    id: b.id,
    label: str(b.label) || b.id,
    version: str(b.version),
    packages: list(b.packages).filter((p) => p && str(p.name) && str(p.version))
      .map((p) => ({ name: p.name, declared: '', version: p.version, installed: true, license: str(p.license), optional: false })),
  }));
  return { packages, vendored, counts: countDependencies({ packages, vendored }) };
}

/** How many runtime, dev and vendored dependencies a set of lists holds. */
export function countDependencies({ packages = [], vendored = [] } = {}) {
  const runtime = packages.reduce((n, p) => n + p.runtime.length, 0);
  const dev = packages.reduce((n, p) => n + p.dev.length, 0);
  const bundled = vendored.reduce((n, b) => n + b.packages.length, 0);
  return { runtime, dev, vendored: bundled, total: runtime + dev + bundled };
}

/**
 * What the page shows, from the answers it got. `about` is the body of GET /api/system/about when it answered
 * (anything else: null); `health` and `version` are the bodies of /api/health and /api/system/version, or null.
 * `full` is false when the About route did not answer: the page then says that a restart brings the rest.
 */
export function readAboutAnswer({ about = null, health = null, version = null } = {}) {
  const full = !!(about && typeof about === 'object' && about.app && typeof about.app === 'object');
  if (full) {
    const app = about.app;
    const install = INSTALL_KEYS[app.install] ? app.install : null;
    const channel = app.channel === 'prerelease' ? 'prerelease' : 'stable';
    const git = app.git && typeof app.git === 'object' ? { branch: str(app.git.branch), commit: str(app.git.commit) } : null;
    const rt = about.runtime && typeof about.runtime === 'object' ? about.runtime : {};
    const os = rt.os && typeof rt.os === 'object' ? rt.os : null;
    return {
      full: true,
      app: {
        version: str(app.version),
        channel,
        build: install === 'git' ? 'dev' : channel,
        install,
        git: git && (git.branch || git.commit) ? git : null,
        description: str(app.description),
        license: str(app.license),
        copyright: app.copyright && str(app.copyright.years) && str(app.copyright.holder) ? { years: app.copyright.years, holder: app.copyright.holder } : null,
      },
      runtime: {
        node: str(rt.node),
        sqlite: str(rt.sqlite),
        os: os ? { name: str(os.name), version: str(os.version), arch: str(os.arch), kernel: str(os.kernel) } : null,
        dataHome: str(rt.dataHome),
        port: Number.isFinite(Number(rt.port)) && Number(rt.port) > 0 ? Number(rt.port) : null,
      },
      links: list(about.links).filter((l) => l && LINK_KEYS[l.id] && isExternalUrl(l.url)).map((l) => ({ id: l.id, url: l.url })),
      dependencies: readDependencies(about.dependencies),
    };
  }
  // An older server: what /api/health and /api/system/version say.
  const h = health && typeof health === 'object' ? health : {};
  const v = version && typeof version === 'object' ? version : {};
  const install = v.desktopManaged ? 'desktop' : (INSTALL_KEYS[h.install] && h.install !== 'desktop' ? h.install : null);
  const channel = v.installedChannel === 'prerelease' ? 'prerelease' : 'stable';
  return {
    full: false,
    app: {
      version: str(h.version) || str(v.current),
      channel,
      build: install === 'git' ? 'dev' : channel,
      install,
      git: null,
      description: null,
      license: null,
      copyright: null,
    },
    runtime: { node: null, sqlite: null, os: null, dataHome: null, port: null },
    links: [],
    dependencies: null,
  };
}

/**
 * What the page itself knows about where it runs: inside the desktop app, the Electron and Chromium versions
 * its window reports in the user agent (the app never changes it), and the app's own platform and processor.
 */
export function readClientRuntime({ userAgent = '', desktop = null } = {}) {
  const ua = String(userAgent || '');
  const electron = /\bElectron\/(\d[\w.-]*)/.exec(ua)?.[1] || null;
  const inApp = !!desktop || !!electron;
  return {
    desktop: inApp,
    electron: inApp ? electron : null,
    chromium: inApp ? (/\bChrome\/(\d[\w.-]*)/.exec(ua)?.[1] || null) : null,
    platform: desktop && str(desktop.platform),
    arch: desktop && str(desktop.arch),
  };
}

/** "Stable", "Pre-release" or "Development build". */
export const buildLabel = (app, tx) => tx(BUILD_KEYS[app?.build] || BUILD_KEYS.stable);

/** "Desktop app", "npm install", "Git clone" …, or null when the server did not say. */
export const installLabel = (app, tx) => (INSTALL_KEYS[app?.install] ? tx(INSTALL_KEYS[app.install]) : null);

/** The install line under the version: "Git clone · Dev · 295547c". */
export function installLine(app, tx) {
  const parts = [installLabel(app, tx)];
  if (app?.git) parts.push(app.git.branch, app.git.commit);
  return parts.filter(Boolean).join(SEP);
}

/** The version line: "Version 2.0.5 · Stable". */
export function versionLine(app, tx) {
  if (!app?.version) return buildLabel(app, tx);
  return `${tx('settings.redesign.about.version', { version: app.version })}${SEP}${buildLabel(app, tx)}`;
}

/** "macOS 26.1 · arm64" from the server's answer; the desktop app's platform and processor when there is none. */
export function osLine(runtime, client = {}) {
  const os = runtime?.os;
  if (os && (os.name || os.version)) return [[os.name, os.version].filter(Boolean).join(' '), os.arch].filter(Boolean).join(SEP);
  return [client.platform, client.arch].filter(Boolean).join(SEP) || null;
}

/** A package of the product by its id, in the page's language; its npm name otherwise. */
export const packageLabel = (pkg, tx) => (PACKAGE_KEYS[pkg?.id] ? tx(PACKAGE_KEYS[pkg.id]) : (pkg?.name || ''));

/** A link's name in the page's language. */
export const linkLabel = (link, tx) => (LINK_KEYS[link?.id] ? tx(LINK_KEYS[link.id]) : linkHost(link?.url));

/**
 * The lists a filter leaves: every dependency whose name holds the query (case-insensitive), and the counts of
 * what is shown. An empty query leaves everything.
 */
export function filterDependencies(deps, query = '') {
  const q = String(query || '').trim().toLowerCase();
  const keep = (dep) => !q || dep.name.toLowerCase().includes(q);
  const packages = list(deps?.packages).map((p) => ({ ...p, runtime: p.runtime.filter(keep), dev: p.dev.filter(keep) }));
  const vendored = list(deps?.vendored).map((b) => ({ ...b, packages: b.packages.filter(keep) }));
  return { query: q, packages, vendored, counts: countDependencies({ packages, vendored }) };
}

/**
 * The plain-text block "Copy info" copies: version and channel, install, runtime, system, and the version of every
 * runtime dependency and bundled library. No path, no address, nothing from a setting.
 */
export function diagnosticsText(model, client = {}, { tx }) {
  const lines = [];
  const app = model?.app || {};
  const rt = model?.runtime || {};
  lines.push(`SynaBun ${app.version || '?'} (${buildLabel(app, tx)})`);
  const install = installLine(app, tx);
  if (install) lines.push(`${tx('settings.redesign.about.row.install')}: ${install}`);
  if (rt.node) lines.push(`Node.js: ${rt.node}`);
  if (rt.sqlite) lines.push(`SQLite: ${rt.sqlite}`);
  if (client.electron) lines.push(`Electron: ${client.electron}`);
  if (client.chromium) lines.push(`Chromium: ${client.chromium}`);
  const os = osLine(rt, client);
  if (os) lines.push(`${tx('settings.redesign.about.row.os')}: ${os}`);
  const deps = model?.dependencies;
  if (deps) {
    for (const pkg of deps.packages) {
      if (!pkg.runtime.length) continue;
      lines.push('', `${packageLabel(pkg, tx)} (${pkg.name})`);
      for (const dep of pkg.runtime) lines.push(`  ${dep.name} ${dep.installed ? dep.version : `${dep.declared} (${tx('settings.redesign.about.deps.notInstalled')})`}`);
    }
    if (deps.vendored.length) {
      lines.push('', tx('settings.redesign.about.deps.vendored'));
      for (const bundle of deps.vendored) lines.push(`  ${bundle.label} ${bundle.version || '?'}`);
    }
  } else if (model && !model.full) {
    lines.push('', tx('settings.redesign.about.restartNote'));
  }
  return lines.join('\n');
}
