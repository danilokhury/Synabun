/**
 * The desktop app: an Electron window around the staged payload.
 *
 * The payload (lib/stage.mjs, then bundle.mjs assemblePayload) is what a build
 * always made: SynaBun's own Node runtime, the application, cloudflared, the
 * bootstrap and the manifest. Electron becomes the window around it and the
 * payload goes beside the window's own code as extra resources, outside the
 * asar, so the server keeps running on SynaBun's Node (native modules keep the
 * Node ABI and need no rebuild for Electron). The headless entry
 * (launcher/launcher.c) stays next to the window executable; MCP clients and
 * Claude Code hooks are registered with it.
 *
 *   macOS    SynaBun.app (Electron) + Contents/MacOS/synabun-cli → .dmg + .zip
 *   Windows  SynaBun.exe (Electron) + synabun-cli.exe → per-user NSIS installer
 *            whose install page lists every step (installerFacts, desktop/build)
 *   Linux    synabun-desktop (Electron) + AppRun (the entry) → AppImage
 *
 * electron-builder (packaging/desktop/package.json, its own lockfile, pinned)
 * makes the window and the Windows installer; it is installed into the build
 * cache, never globally and never into the source tree, and given the pinned
 * Electron archive (pins.json electron). The disk image, the zip, the AppImage,
 * the update feed files (latest-mac.yml, latest.yml, latest-linux.yml) and
 * SHA256SUMS are made here. Signing is off unless credentials are given in
 * the environment (CSC_*, APPLE_*): an unsigned macOS build is signed ad hoc,
 * which Apple Silicon needs to run it at all.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { packagesInLock } from '../../neural-interface/lib/install-details.js';
import { PACKAGING_ROOT } from './targets.mjs';
import { BuildError, fetchVerified, note, removeTree, run, sha256File, step, walk, which } from './util.mjs';

export const DESKTOP_ROOT = join(PACKAGING_ROOT, 'desktop');
export const APP_ID = 'ai.synabun.app';
export const PRODUCT_NAME = 'SynaBun';
/** The public update feed: the latest GitHub release's own files (packaging/desktop/src/updater/feed.mjs reads the same). */
export const FEED_URL = 'https://github.com/danilokhury/Synabun/releases/latest/download';

/** Where each platform keeps the window, the entry and the payload, relative to the app's root. */
export const SHELL_LAYOUTS = Object.freeze({
  darwin: Object.freeze({
    root: 'SynaBun.app', resources: 'Contents/Resources', entry: 'Contents/MacOS/synabun-cli', window: 'Contents/MacOS/SynaBun',
    manifestEntry: '../MacOS/synabun-cli', manifestWindow: '../MacOS/SynaBun', runtimeBin: 'runtime/bin', bundle: 'macos-app',
  }),
  win32: Object.freeze({
    root: 'SynaBun', resources: 'resources', entry: 'synabun-cli.exe', window: 'SynaBun.exe',
    manifestEntry: '../synabun-cli.exe', manifestWindow: '../SynaBun.exe', runtimeBin: 'runtime', bundle: 'windows-dir',
  }),
  linux: Object.freeze({
    root: 'SynaBun.AppDir', resources: 'resources', entry: 'AppRun', window: 'synabun-desktop',
    manifestEntry: '../AppRun', manifestWindow: '../synabun-desktop', runtimeBin: 'runtime/bin', bundle: 'linux-appdir',
  }),
});

export const shellLayoutFor = (target) => SHELL_LAYOUTS[target.platform];

const electronPlatform = (target) => (target.platform === 'win32' ? 'win32' : target.platform);

/** The pinned Electron archive of a target: its file name, URL and SHA-256. */
export function electronArchiveFor(target, pins) {
  const electron = pins.electron;
  if (!electron?.version) throw new BuildError('packaging/pins.json names no Electron version.');
  const file = `electron-v${electron.version}-${electronPlatform(target)}-${target.arch}.zip`;
  const sha256 = electron.files?.[file];
  if (!sha256) throw new BuildError(`No pinned checksum for ${file} in packaging/pins.json`);
  return { version: electron.version, file, url: electron.baseUrl + file, sha256 };
}

// ── The tools ──

/**
 * electron-builder and its own dependencies, from packaging/desktop's lockfile,
 * in the build cache (one folder per lockfile): never globally, never into the
 * source tree. Install scripts stay off (the Electron package's would download
 * an Electron for this machine, which nothing here runs).
 */
export function desktopTools(ctx) {
  const lock = readFileSync(join(DESKTOP_ROOT, 'package-lock.json'));
  const hash = createHash('sha256').update(lock).update(readFileSync(join(DESKTOP_ROOT, 'package.json'))).digest('hex').slice(0, 16);
  const root = join(ctx.cache, 'desktop-tools', hash);
  const cli = join(root, 'node_modules', 'electron-builder', 'cli.js');
  if (!existsSync(join(root, 'node_modules', '.package-lock.json')) || !existsSync(cli)) {
    step('Desktop tools: electron-builder from packaging/desktop/package-lock.json');
    removeTree(root);
    mkdirSync(root, { recursive: true });
    copyFileSync(join(DESKTOP_ROOT, 'package.json'), join(root, 'package.json'));
    copyFileSync(join(DESKTOP_ROOT, 'package-lock.json'), join(root, 'package-lock.json'));
    run(ctx.tool.node, [ctx.tool.npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env: hostNpmEnv(ctx), label: 'npm ci (desktop tools)' });
  } else {
    note(`desktop tools: cached (${relative(ctx.cache, root)})`);
  }
  const requireTool = createRequire(join(root, 'package.json'));
  return { root, cli, requireTool };
}

/**
 * npm, for the tools of this machine (not the target's packages): a cross
 * build tells npm the target's os and cpu, which must not leak in here.
 */
function hostNpmEnv(ctx) {
  const env = { ...ctx.env };
  for (const key of ['npm_config_os', 'npm_config_cpu', 'npm_config_libc', 'npm_config_nodedir']) delete env[key];
  return env;
}

// ── The window's own app folder ──

function resizePng(source, size, destination) {
  if (which('sips')) {
    run('sips', ['-z', String(size), String(size), source, '--out', destination], { capture: true, env: process.env, label: `render a ${size} px icon` });
    return true;
  }
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Drawing; $s=[System.Drawing.Image]::FromFile($env:SYNABUN_ICON_IN); $n=[int]$env:SYNABUN_ICON_SIZE; $b=New-Object System.Drawing.Bitmap $n,$n; $g=[System.Drawing.Graphics]::FromImage($b); $g.InterpolationMode="HighQualityBicubic"; $g.DrawImage($s,0,0,$n,$n); $b.Save($env:SYNABUN_ICON_OUT,[System.Drawing.Imaging.ImageFormat]::Png)',
    ], { env: { ...process.env, SYNABUN_ICON_IN: source, SYNABUN_ICON_OUT: destination, SYNABUN_ICON_SIZE: String(size) }, capture: true, label: `render a ${size} px icon` });
    return true;
  }
  const convert = which('convert') || which('magick');
  if (convert) {
    run(convert, [source, '-resize', `${size}x${size}`, destination], { capture: true, env: process.env, label: `render a ${size} px icon` });
    return true;
  }
  return false;
}

/**
 * The folder electron-builder packs into app.asar: the window's code, its
 * assets (SynaBun's own logo and icons), a package.json that carries this
 * build's version, and its production dependencies (electron-updater, js-yaml),
 * installed from the same lockfile.
 */
export function stageShellApp(ctx, { iconTools }) {
  step('Desktop window: its code, assets and dependencies');
  const app = join(ctx.work, 'desktop-app');
  removeTree(app);
  mkdirSync(app, { recursive: true });
  cpSync(join(DESKTOP_ROOT, 'src'), join(app, 'src'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8'));
  manifest.version = ctx.version;
  writeFileSync(join(app, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const lock = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package-lock.json'), 'utf8'));
  lock.version = ctx.version;
  if (lock.packages?.['']) lock.packages[''].version = ctx.version;
  writeFileSync(join(app, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  run(ctx.tool.node, [ctx.tool.npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, env: hostNpmEnv(ctx), label: 'npm ci (desktop window dependencies)' });

  // Assets: SynaBun's own files (DESIGN.md: the primary wordmark and the app icon), copied, never redrawn.
  const publicDir = join(ctx.repoRoot, 'neural-interface', 'public');
  const assets = join(app, 'assets');
  mkdirSync(assets, { recursive: true });
  copyFileSync(join(publicDir, 'synabun.png'), join(assets, 'logo.png'));
  copyFileSync(join(publicDir, 'icon-512.png'), join(assets, 'icon.png'));
  const tray = join(assets, 'tray.png');
  if (!resizePng(join(publicDir, 'icon-512.png'), 32, tray)) copyFileSync(join(publicDir, 'icon-192.png'), tray);
  resizePng(join(publicDir, 'icon-512.png'), 64, join(assets, 'tray@2x.png'));
  if (ctx.target.platform === 'win32') writeFileSync(join(assets, 'tray.ico'), iconTools.pngToIco(readFileSync(tray)));
  return app;
}

/** Icons in the form electron-builder takes for each platform, in its build-resources folder. */
export function buildResources(ctx, { iconTools }) {
  const folder = join(ctx.work, 'desktop-build');
  removeTree(folder);
  mkdirSync(folder, { recursive: true });
  const source = join(ctx.repoRoot, 'neural-interface', 'public', 'icon-512.png');
  const out = { folder, icon: null };
  if (ctx.target.platform === 'darwin') {
    if (iconTools.macIcon(ctx, folder, 'icon.icns')) out.icon = join(folder, 'icon.icns');
  } else if (ctx.target.platform === 'win32') {
    const png = join(folder, 'icon-256.png');
    if (!resizePng(source, 256, png)) copyFileSync(join(dirname(source), 'icon-192.png'), png);
    writeFileSync(join(folder, 'icon.ico'), iconTools.pngToIco(readFileSync(png)));
    out.icon = join(folder, 'icon.ico');
    // The installer's own steps, and the unpacking with its progress on the install page.
    for (const name of INSTALLER_INCLUDES) copyFileSync(join(DESKTOP_ROOT, 'build', name), join(folder, name));
  } else {
    mkdirSync(join(folder, 'icons'), { recursive: true });
    copyFileSync(source, join(folder, 'icons', '512x512.png'));
    out.icon = join(folder, 'icons');
  }
  // Developer ID signing only (hardened runtime): the entitlements Node needs, as for every earlier build.
  copyFileSync(join(PACKAGING_ROOT, 'macos', 'entitlements.plist'), join(folder, 'entitlements.mac.plist'));
  return out;
}

// ── The Windows installer's install page ──

/** What the Windows installer includes from packaging/desktop/build (the facts file is written per build). */
export const INSTALLER_INCLUDES = Object.freeze(['installer.nsh', 'synabun-extract.nsh', 'synabun-upgrade.nsh', 'synabun-stop.ps1', 'synabun-verify.ps1']);
/** The facts of one build the install page names (included by installer.nsh, written beside it). */
export const INSTALLER_FACTS = 'synabun-installer-facts.nsh';
/** The manifest the installer checks the unpacked payload against (relative path + size per line, written into the payload). */
export const PAYLOAD_MANIFEST = join('resources', 'synabun-payload.manifest');
/**
 * The files SynaBun starts, install-relative: when the installer's full check of the payload cannot run, it checks
 * these at their sizes from the build instead (installer.nsh SynaKeyFilesCheck). One a build does not carry is left out.
 */
export const INSTALLER_KEY_FILES = Object.freeze([
  'SynaBun.exe', 'synabun-cli.exe', 'resources\\app.asar', 'resources\\synabun-package.json', 'resources\\bootstrap.mjs',
  'resources\\synabun-payload.manifest', 'resources\\runtime\\node.exe', 'resources\\app\\neural-interface\\server.js',
  'resources\\app\\mcp-server\\dist\\index.js', 'resources\\cloudflared\\cloudflared.exe', 'resources\\git\\bin\\bash.exe',
  'resources\\git\\usr\\bin\\msys-2.0.dll',
]);

/**
 * Write the payload manifest into the bundle: one `<install-relative path (\\)>\t<bytes>` line per file, so the
 * installer can confirm after unpacking that every file landed at its full size (a locked file or a full disk
 * otherwise leaves an incomplete install that only checks SynaBun.exe). The manifest lists every file except
 * itself. Returns its install-relative path, the number of files and their bytes. Links never appear (walk skips
 * them; a Windows payload has none).
 */
export function writePayloadManifest(bundleRoot) {
  const manifestRel = PAYLOAD_MANIFEST.replace(/\//g, '\\');
  const manifestPath = join(bundleRoot, PAYLOAD_MANIFEST);
  const lines = [];
  let bytes = 0;
  for (const file of walk(bundleRoot)) {
    if (file.link) continue;
    const rel = file.relative.replace(/\//g, '\\');
    if (rel.toLowerCase() === manifestRel.toLowerCase()) continue;
    const size = statSync(file.path).size;
    bytes += size;
    lines.push(`${rel}\t${size}`);
  }
  lines.sort();
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, lines.join('\r\n') + '\r\n');
  return { path: manifestPath, rel: manifestRel, count: lines.length, bytes };
}

/** INSTALLER_KEY_FILES a bundle carries, each with its size: [{ rel, size }] (what installerFacts writes for the installer). */
export function installerKeyFiles(bundleRoot) {
  const found = [];
  for (const rel of INSTALLER_KEY_FILES) {
    try {
      const info = lstatSync(join(bundleRoot, ...rel.split('\\')));
      if (info.isFile()) found.push({ rel, size: info.size });
    } catch { /* not in this build */ }
  }
  return found;
}

const nsisString = (value) => String(value ?? '').replace(/\$/g, '$$$$').replace(/"/g, '$\\"').replace(/[\r\n]+/g, ' ');
const grouped = (number) => (Number.isFinite(number) ? Math.round(number).toLocaleString('en-US') : '?');

/**
 * The install page's facts for one build, as NSIS defines: what it installs (files, size), the Node.js, npm and
 * npx it carries, the native modules and packages, the window's Electron, the embedding model, cloudflared and
 * Git for Windows, and where global npm packages go. With `keyFiles` ([{ rel, size }], installerKeyFiles), also
 * the SynaKeyFiles macro: the files SynaBun starts at their sizes, which the installer checks when its full check of
 * the payload cannot run. Pure (packaging/tests/desktop-build.test.mjs).
 */
export function installerFacts({ target, audit = {}, node, electron, embeddingModel = '', cloudflared = null, gitBash = null, packages = {}, keyFiles = [] }) {
  const natives = [...new Set((audit.natives || []).map(item => String(item.label || '').replace(/\s*\(.*\)$/, '')).filter(Boolean))].sort();
  const facts = {
    SYNABUN_TARGET: target?.label || target?.id || 'Windows x64',
    SYNABUN_FILES: grouped(audit.files),
    SYNABUN_SIZE_MB: grouped(Number.isFinite(audit.bytes) ? audit.bytes / 1048576 : NaN),
    SYNABUN_NODE_VERSION: node || '?',
    SYNABUN_NPM_VERSION: audit.npm?.version || '?',
    SYNABUN_ELECTRON_VERSION: electron || '?',
    SYNABUN_NATIVES: natives.join(', ') || '?',
    SYNABUN_NI_PACKAGES: grouped(packages.neuralInterface),
    SYNABUN_MCP_PACKAGES: grouped(packages.mcpServer),
    SYNABUN_EMBEDDING_MODEL: embeddingModel || '',
    SYNABUN_CLOUDFLARED_VERSION: cloudflared || '?',
    SYNABUN_GIT_VERSION: gitBash || '?',
    SYNABUN_NPM_PREFIX: '%APPDATA%\\synabun\\runtime\\npm-global',
  };
  const keys = keyFiles.filter(file => /^[\w.\\@-]+$/.test(file.rel) && Number.isSafeInteger(file.size) && file.size >= 0);
  return [
    '; What this build carries, for the install page (written by packaging/lib/desktop.mjs; included by installer.nsh).',
    ...Object.entries(facts).map(([name, value]) => `!define ${name} "${nsisString(value)}"`),
    ...(keys.length ? [
      '; The files SynaBun starts, at their sizes: checked when the full check of the payload cannot run.',
      '!macro SynaKeyFiles',
      ...keys.map(file => `  !insertmacro SynaKeyFile "${file.rel}" "${file.size}"`),
      '!macroend',
    ] : []),
    '',
  ].join('\r\n');
}

/** The text of one macro (`!macro <name> …` to its `!macroend`) in an NSIS file, or null. */
export function nsisMacro(text, name) {
  const start = String(text).search(new RegExp(`^!macro ${name}\\b`, 'm'));
  if (start < 0) return null;
  const end = String(text).indexOf('!macroend', start);
  return end < 0 ? null : String(text).slice(start, end + '!macroend'.length);
}

/** The Nsis7z calls the extract macros use: electron-builder's plain one, and ours with the progress on the page. */
export const EXTRACT_CALL = Object.freeze({
  plain: 'Nsis7z::Extract "${FILE}"',
  details: 'Nsis7z::ExtractWithDetails "${FILE}" "Unpacking SynaBun %s..."',
});

/**
 * Whether synabun-extract.nsh is a safe replacement for electron-builder's extractUsing7za: electron-builder must
 * still unpack the app with the Nsis7z plugin (so the ExtractWithDetails call is the same plugin, and we would notice
 * if it moved to another unpacker), and ours must unpack straight into the install folder with ExtractWithDetails and
 * no second copy (electron-builder's own macro unpacks into a temporary folder and then CopyFiles into place, a full
 * second write of the whole payload that this deliberately drops). { ok, reason }.
 */
export function extractMacroMatches(templateText, oursText) {
  const theirs = nsisMacro(templateText, 'extractUsing7za');
  const ours = nsisMacro(oursText, 'extractUsing7za');
  if (!theirs) return { ok: false, reason: 'electron-builder\'s templates have no extractUsing7za macro any more' };
  if (!ours) return { ok: false, reason: 'packaging/desktop/build/synabun-extract.nsh has no extractUsing7za macro' };
  if (!theirs.includes(EXTRACT_CALL.plain)) return { ok: false, reason: 'electron-builder no longer unpacks the app with Nsis7z::Extract: review synabun-extract.nsh against its new macro' };
  if (!ours.includes(EXTRACT_CALL.details)) return { ok: false, reason: 'synabun-extract.nsh does not call Nsis7z::ExtractWithDetails' };
  if (/\$PLUGINSDIR|CopyFiles/.test(ours)) return { ok: false, reason: 'synabun-extract.nsh should unpack straight into the install folder (no temporary folder, no CopyFiles)' };
  return { ok: true, reason: null };
}

const squeeze = (text) => String(text || '').replace(/[ \t]+/g, ' ').replace(/ ?\r?\n ?/g, '\n').trim();

/**
 * Whether synabun-upgrade.nsh is a safe replacement for electron-builder's uninstallOldVersion macro: theirs must
 * still be the two lines that run their function (installUtil.nsh), installSection.nsh must still follow it with
 * handleUninstallResult, and that function must still read the error flag and $R0, which ours leaves as a finished
 * uninstall would when the installed copy was moved aside. Ours must move the copy aside first and fall back to
 * their function, unchanged, when it did not. { ok, reason }.
 */
export function uninstallMacroMatches(installUtilText, installSectionText, oursText) {
  const theirs = nsisMacro(installUtilText, 'uninstallOldVersion');
  const ours = nsisMacro(oursText, 'uninstallOldVersion');
  if (!theirs) return { ok: false, reason: 'electron-builder\'s installUtil.nsh has no uninstallOldVersion macro any more' };
  if (!ours) return { ok: false, reason: 'packaging/desktop/build/synabun-upgrade.nsh has no uninstallOldVersion macro' };
  if (squeeze(theirs) !== '!macro uninstallOldVersion ROOT_KEY\nPush "${ROOT_KEY}"\nCall uninstallOldVersion\n!macroend') {
    return { ok: false, reason: 'electron-builder\'s uninstallOldVersion macro changed: review synabun-upgrade.nsh against it' };
  }
  if (!/!insertmacro uninstallOldVersion SHELL_CONTEXT\s*\n\s*!insertmacro handleUninstallResult SHELL_CONTEXT/.test(String(installSectionText))) {
    return { ok: false, reason: 'installSection.nsh no longer follows uninstallOldVersion with handleUninstallResult: review synabun-upgrade.nsh' };
  }
  const handle = String(installUtilText).slice(String(installUtilText).indexOf('Function handleUninstallResult'));
  const body = handle.slice(0, handle.indexOf('FunctionEnd'));
  if (!body || !/IfErrors 0 \+3/.test(body) || !/\$\{if\} \$R0 != 0/.test(body)) {
    return { ok: false, reason: 'handleUninstallResult no longer decides by the error flag and $R0: review synabun-upgrade.nsh' };
  }
  if (!/^!macroundef uninstallOldVersion$/m.test(String(oursText))) return { ok: false, reason: 'synabun-upgrade.nsh does not replace the macro (!macroundef)' };
  const order = ['Call SynaMoveAside', '${if} $SynaAside == ""', 'Push "${ROOT_KEY}"', 'Call uninstallOldVersion', '${else}', 'ClearErrors', 'StrCpy $R0 0', '${endIf}'];
  let at = -1;
  for (const line of order) {
    const next = ours.indexOf(line, at + 1);
    if (next < 0) return { ok: false, reason: `synabun-upgrade.nsh does not ${line.startsWith('Push') || line.startsWith('Call uninstall') ? 'fall back to electron-builder\'s own function' : 'move the installed copy aside first'} (${line})` };
    at = next;
  }
  return { ok: true, reason: null };
}

// ── Signing (only with credentials from the environment) ──

/** What signs this build: { mac: identity|null, notarize, windows: boolean }. Off unless the environment says otherwise. */
export function signingFrom(env = process.env) {
  const legacyMac = env.SYNABUN_MAC_SIGN_IDENTITY && env.SYNABUN_MAC_SIGN_IDENTITY !== '-' ? env.SYNABUN_MAC_SIGN_IDENTITY : null;
  const macIdentity = env.CSC_NAME || legacyMac || (env.CSC_LINK ? undefined : null);
  return {
    mac: macIdentity === undefined ? 'from-certificate' : macIdentity,
    notarize: !!((env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) || (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
      || env.APPLE_KEYCHAIN_PROFILE || env.SYNABUN_MAC_NOTARY_PROFILE),
    windows: !!(env.WIN_CSC_LINK || env.CSC_LINK || env.SYNABUN_WIN_SIGN_PFX || env.SYNABUN_WIN_SIGN_THUMBPRINT),
  };
}

/**
 * The electron-builder configuration of one target. Pure (tested in
 * packaging/tests/desktop-build.test.mjs).
 */
export function builderConfig({ target, version, electron, shellApp, output, resources, payload, entryFile, signing = signingFrom({}), env = {} }) {
  const mac = target.platform === 'darwin';
  const windows = target.platform === 'win32';
  const config = {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    copyright: 'Copyright © The SynaBun Authors',
    electronVersion: electron.version,
    electronDist: electron.dist,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    asar: true,
    compression: 'normal',
    // The app folder is the project folder electron-builder is pointed at (runElectronBuilder --projectDir).
    directories: { output, buildResources: resources.folder },
    files: ['package.json', 'src/**/*', 'assets/**/*', 'node_modules/**/*'],
    // The payload: beside the window's code, outside the asar.
    extraResources: [{ from: payload, to: '.', filter: ['**/*'] }],
    // What electron-builder removes from an Electron it downloads, removed from the pinned archive too.
    afterExtract: join(DESKTOP_ROOT, 'build', 'after-extract.cjs'),
    extraFiles: mac ? [{ from: entryFile, to: 'MacOS/synabun-cli' }] : windows ? [{ from: entryFile, to: 'synabun-cli.exe' }] : [],
    publish: [{ provider: 'generic', url: FEED_URL }],
    electronFuses: {
      runAsNode: false,
      // Off, as in a stock Electron: an encrypted cookie store asks the macOS keychain for its key before the
      // first request, and an ad hoc signature (unsigned builds) changes with every update, so every update
      // would stop at a keychain prompt. The window only talks to SynaBun's own loopback server.
      enableCookieEncryption: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: false,
      onlyLoadAppFromAsar: true,
      resetAdHocDarwinSignature: mac,
    },
  };
  if (mac) {
    const identity = signing.mac === 'from-certificate' ? undefined : signing.mac;
    config.mac = {
      target: [{ target: 'dir', arch: [target.arch] }],
      category: 'public.app-category.developer-tools',
      icon: resources.icon || undefined,
      ...(identity === undefined ? {} : { identity }),
      hardenedRuntime: signing.mac !== null,
      gatekeeperAssess: false,
      entitlements: join(resources.folder, 'entitlements.mac.plist'),
      entitlementsInherit: join(resources.folder, 'entitlements.mac.plist'),
      // Cloudflare's own signature stays: the pinned binary is compared byte for byte.
      signIgnore: ['/cloudflared/cloudflared$'],
      notarize: signing.mac !== null && signing.notarize,
      darkModeSupport: true,
      extendInfo: {
        CFBundleDisplayName: PRODUCT_NAME,
        NSAppleEventsUsageDescription: 'SynaBun asks other apps to do things you request, such as showing a folder picker or opening a Terminal window.',
      },
    };
  } else if (windows) {
    config.win = {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: resources.icon || undefined,
      executableName: PRODUCT_NAME,
      requestedExecutionLevel: 'asInvoker',
      // resedit sets the icon and version on any build machine; a signature needs a certificate.
      signAndEditExecutable: true,
      ...(env.SYNABUN_WIN_SIGN_THUMBPRINT ? { signtoolOptions: { certificateSha1: env.SYNABUN_WIN_SIGN_THUMBPRINT } } : {}),
    };
    config.nsis = {
      // electron-builder's assisted installer: its install page lists every step (installer.nsh), with no page before
      // it (per user, no folder to choose: customInstallMode) and a finish page that opens SynaBun. The one-click
      // installer shows a banner with a bar and nothing else. The app's own updates run it silently either way.
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: PRODUCT_NAME,
      uninstallDisplayName: PRODUCT_NAME,
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
      // elevate.exe (32-bit) only serves per-machine installs; this one never asks for administrator rights.
      packElevateHelper: false,
      differentialPackage: true,
      include: join(resources.folder, 'installer.nsh'),
      installerIcon: resources.icon || undefined,
      uninstallerIcon: resources.icon || undefined,
      artifactName: `SynaBun-${version}-${target.id}-setup.\${ext}`,
    };
  } else {
    config.linux = {
      target: [{ target: 'dir', arch: ['x64'] }],
      executableName: 'synabun-desktop',
      category: 'Development',
      icon: resources.icon || undefined,
      maintainer: 'The SynaBun Authors',
      synopsis: 'Persistent vector memory for AI assistants',
      description: 'Persistent vector memory for AI assistants',
    };
  }
  return config;
}

/** Run electron-builder with a configuration file, in this build's own folders and caches. */
export function runElectronBuilder(ctx, tools, config, args, label) {
  const file = join(ctx.work, `electron-builder-${label.replace(/\W+/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  const env = {
    ...hostNpmEnv(ctx),
    ELECTRON_CACHE: join(ctx.cache, 'electron'),
    ELECTRON_BUILDER_CACHE: join(ctx.cache, 'electron-builder'),
    // Only the certificates the environment names: never one this machine's keychain happens to hold.
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  };
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // The names earlier builds read, still honoured.
  if (process.env.SYNABUN_MAC_NOTARY_PROFILE && !env.APPLE_KEYCHAIN_PROFILE) env.APPLE_KEYCHAIN_PROFILE = process.env.SYNABUN_MAC_NOTARY_PROFILE;
  if (process.env.SYNABUN_WIN_SIGN_PFX && !env.WIN_CSC_LINK) env.WIN_CSC_LINK = process.env.SYNABUN_WIN_SIGN_PFX;
  if (process.env.SYNABUN_WIN_SIGN_PASSWORD && !env.WIN_CSC_KEY_PASSWORD) env.WIN_CSC_KEY_PASSWORD = process.env.SYNABUN_WIN_SIGN_PASSWORD;
  run(ctx.tool.node, [tools.cli, '--projectDir', ctx.desktopApp, '--config', file, '--publish', 'never', ...args], {
    cwd: ctx.desktopApp, env, label: `electron-builder (${label})`,
  });
}

/** The .app electron-builder made (mac/SynaBun.app, mac-arm64/SynaBun.app). */
function findMacApp(output) {
  for (const folder of readdirSync(output)) {
    const candidate = join(output, folder, `${PRODUCT_NAME}.app`);
    if (/^mac/.test(folder) && existsSync(candidate)) return candidate;
  }
  throw new BuildError(`electron-builder made no ${PRODUCT_NAME}.app in ${output}`);
}

/**
 * Ad hoc signature for a macOS build without a Developer ID: Apple Silicon runs
 * nothing unsigned, and an intact seal is also what the updater checks before
 * it swaps a downloaded copy in. Code in standard places is signed; everything
 * in Contents/Resources (the payload, with Node's and Cloudflare's own
 * signatures) is sealed as it is, never re-signed.
 */
export function signMacAdHoc(app) {
  run('codesign', ['--force', '--deep', '--sign', '-', app], { capture: true, env: process.env, label: 'ad hoc signature' });
  run('codesign', ['--verify', '--deep', '--strict', app], { capture: true, env: process.env, label: 'verify the signature' });
}

/**
 * Make the window around the payload. Sets ctx.bundle to the finished app
 * folder: root, resources, entry, window, layout.
 */
export async function buildDesktopApp(ctx, { payload, entryFile, iconTools }) {
  const layout = shellLayoutFor(ctx.target);
  const archive = electronArchiveFor(ctx.target, ctx.pins);
  step(`Electron ${archive.version} for ${ctx.target.id}`);
  const dist = join(ctx.cache, 'electron', archive.version);
  await fetchVerified({ url: archive.url, sha256: archive.sha256, destination: join(dist, archive.file), label: archive.file, fetchImpl: ctx.fetch });
  const tools = desktopTools(ctx);
  ctx.desktopTools = tools;
  const shellApp = stageShellApp(ctx, { iconTools });
  ctx.desktopApp = shellApp;
  const resources = buildResources(ctx, { iconTools });
  const output = join(ctx.work, 'electron-out');
  removeTree(output);
  const signing = signingFrom(process.env);
  const config = builderConfig({
    target: ctx.target, version: ctx.version, electron: { version: archive.version, dist }, shellApp, output, resources, payload, entryFile, signing, env: process.env,
  });
  ctx.desktop = { tools, config, output, signing, electron: archive };
  const platformFlag = { darwin: '--mac', win32: '--win', linux: '--linux' }[ctx.target.platform];
  step(`electron-builder: the ${ctx.target.label} app`);
  runElectronBuilder(ctx, tools, config, [platformFlag, 'dir', ctx.target.arch === 'arm64' ? '--arm64' : '--x64'], `${ctx.target.id} app`);

  let root;
  if (ctx.target.platform === 'darwin') {
    root = findMacApp(output);
    if (signing.mac === null) {
      step('Sign the app ad hoc (no Developer ID given)');
      signMacAdHoc(root);
      ctx.report.signed = 'ad-hoc';
    } else {
      ctx.report.signed = 'developer-id';
    }
  } else if (ctx.target.platform === 'win32') {
    root = join(output, 'win-unpacked');
    ctx.report.signed = signing.windows ? 'certificate' : false;
  } else {
    root = assembleAppDir(ctx, join(output, 'linux-unpacked'), { entryFile });
    ctx.report.signed = false;
  }
  ctx.report.electron = { version: archive.version, archive: archive.file, sha256: archive.sha256 };
  ctx.bundle = {
    root,
    resources: join(root, layout.resources),
    entry: join(root, layout.entry),
    window: join(root, layout.window),
    layout,
    manifest: ctx.payloadManifest,
    cloudflared: ctx.payloadCloudflared ? join(root, layout.resources, relative(payload, ctx.payloadCloudflared)) : null,
    gitBash: ctx.payloadGitBash ? join(root, layout.resources, relative(payload, ctx.payloadGitBash)) : null,
  };
  note(root);
}

/**
 * The AppDir of the AppImage: electron-builder's Linux app, the entry as
 * AppRun (so MCP and hooks never start the window, and a launch from the
 * desktop execs into the window with the image still mounted), the libraries
 * electron-builder puts into every AppImage for older desktops, the desktop
 * file and the icon.
 */
function assembleAppDir(ctx, unpacked, { entryFile }) {
  const appDir = join(ctx.work, 'electron-out', SHELL_LAYOUTS.linux.root);
  removeTree(appDir);
  renameSync(unpacked, appDir);
  copyFileSync(entryFile, join(appDir, 'AppRun'));
  chmodSync(join(appDir, 'AppRun'), 0o755);
  if (ctx.appImageTools?.libraries && existsSync(ctx.appImageTools.libraries)) {
    mkdirSync(join(appDir, 'usr', 'lib'), { recursive: true });
    for (const name of readdirSync(ctx.appImageTools.libraries)) cpSync(join(ctx.appImageTools.libraries, name), join(appDir, 'usr', 'lib', name), { recursive: true, verbatimSymlinks: true });
  }
  writeFileSync(join(appDir, 'synabun.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=SynaBun',
    'Comment=Persistent vector memory for AI assistants',
    'Exec=AppRun',
    'Icon=synabun',
    'Categories=Development;Utility;',
    'Terminal=false',
    'StartupWMClass=SynaBun',
    '',
  ].join('\n'));
  copyFileSync(join(ctx.repoRoot, 'neural-interface', 'public', 'icon-512.png'), join(appDir, 'synabun.png'));
  symlinkSync('synabun.png', join(appDir, '.DirIcon'));
  return appDir;
}

// ── Artifacts ──

export function sha512Base64(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha512');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('base64')));
  });
}

/** A blockmap next to `file` (`<file>.blockmap`), with electron-builder's own code. */
async function writeBlockmap(ctx, file) {
  const { buildBlockMap } = ctx.desktop.tools.requireTool('app-builder-lib/out/targets/blockmap/blockmap.js');
  await buildBlockMap(file, 'gzip', `${file}.blockmap`);
  return `${file}.blockmap`;
}

function macArtifacts(ctx, names, wanted) {
  const made = [];
  if (wanted.includes('dmg')) {
    step('Disk image');
    const volume = join(ctx.work, 'dmg');
    removeTree(volume);
    mkdirSync(volume, { recursive: true });
    const inVolume = join(volume, `${PRODUCT_NAME}.app`);
    renameSync(ctx.bundle.root, inVolume);
    try {
      symlinkSync('/Applications', join(volume, 'Applications'));
      const dmg = join(ctx.out, names.dmg);
      rmSync(dmg, { force: true });
      // LZFSE (macOS 10.11 and later; Electron itself needs macOS 12): smaller and faster to open than zlib.
      run('hdiutil', ['create', '-volname', PRODUCT_NAME, '-srcfolder', volume, '-ov', '-format', 'ULFO', dmg], { capture: true, env: process.env, label: 'hdiutil create' });
      made.push({ kind: 'dmg', path: dmg, signed: ctx.report.signed || false, notarized: ctx.desktop.signing.mac !== null && ctx.desktop.signing.notarize });
    } finally {
      renameSync(inVolume, ctx.bundle.root);
      removeTree(volume);
    }
  }
  if (wanted.includes('zip')) {
    step('Zip archive (what the updater installs)');
    const zip = join(ctx.out, names.zip);
    rmSync(zip, { force: true });
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', ctx.bundle.root, zip], { capture: true, env: process.env, label: 'ditto' });
    made.push({ kind: 'zip', path: zip, signed: ctx.report.signed || false, notarized: false });
  }
  return made;
}

/** The install page's facts of this build, beside installer.nsh in the build resources (installerFacts). */
function writeInstallerFacts(ctx, { keyFiles = [] } = {}) {
  const folder = ctx.desktop.config.directories.buildResources;
  const lockOf = (part) => { try { return JSON.parse(readFileSync(join(ctx.bundle.resources, 'app', part, 'node_modules', '.package-lock.json'), 'utf8')); } catch { return null; } };
  const text = installerFacts({
    target: ctx.target,
    audit: ctx.report.audit,
    node: ctx.runtime.version,
    electron: ctx.desktop.electron.version,
    embeddingModel: ctx.report.embeddingModel === 'bundled' ? ctx.pins.embeddingModel?.id : '',
    cloudflared: ctx.report.cloudflared?.version,
    gitBash: ctx.report.gitBash?.packaged ? ctx.report.gitBash.version : null,
    packages: { neuralInterface: packagesInLock(lockOf('neural-interface')), mcpServer: packagesInLock(lockOf('mcp-server')) },
    keyFiles,
  });
  writeFileSync(join(folder, INSTALLER_FACTS), text);
  return text;
}

function windowsArtifacts(ctx, names) {
  step('Installer (NSIS, per user, no administrator rights)');
  const output = join(ctx.work, 'electron-out-installer');
  removeTree(output);
  // The install page's unpacking runs electron-builder's own macro with the details call only: refuse anything else.
  const templates = join(ctx.desktop.tools.root, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
  const template = join(templates, 'include', 'extractAppPackage.nsh');
  const extract = extractMacroMatches(readFileSync(template, 'utf8'), readFileSync(join(DESKTOP_ROOT, 'build', 'synabun-extract.nsh'), 'utf8'));
  if (!extract.ok) throw new BuildError(`The installer's unpacking cannot be shown step by step: ${extract.reason}. No artifact was created.`, { details: [template] });
  // The installed copy is moved aside instead of uninstalled file by file: only while electron-builder's macro is the one replaced.
  const installUtil = join(templates, 'include', 'installUtil.nsh');
  const upgrade = uninstallMacroMatches(readFileSync(installUtil, 'utf8'), readFileSync(join(templates, 'installSection.nsh'), 'utf8'),
    readFileSync(join(DESKTOP_ROOT, 'build', 'synabun-upgrade.nsh'), 'utf8'));
  if (!upgrade.ok) throw new BuildError(`The installer cannot replace an installed copy in one step: ${upgrade.reason}. No artifact was created.`, { details: [installUtil] });
  // The payload manifest, written into the bundle before the audit snapshot so it packs with everything else and
  // does not trip the "unchanged" guard: the installer checks the unpacked payload against it (synabun-verify.ps1).
  const manifest = writePayloadManifest(ctx.bundle.root);
  ctx.report.payloadManifest = { rel: manifest.rel, files: manifest.count, bytes: manifest.bytes };
  note(`payload manifest: ${manifest.count} files, ${manifest.bytes} bytes, the installer checks after unpacking (${manifest.rel})`);
  const keyFiles = installerKeyFiles(ctx.bundle.root);
  const facts = writeInstallerFacts(ctx, { keyFiles });
  note(`install page: ${facts.split(/\r?\n/).filter(line => line.startsWith('!define')).length} facts of this build, every step listed; ${keyFiles.length} files SynaBun starts, checked by size when the full check cannot run`);
  const config = { ...ctx.desktop.config, directories: { ...ctx.desktop.config.directories, output } };
  // The installer packs this folder as it is when NSIS runs: it must still be the folder the audit read.
  const audited = treeMarks(ctx.bundle.root);
  runElectronBuilder(ctx, ctx.desktop.tools, config, ['--win', 'nsis', '--x64', '--prepackaged', ctx.bundle.root], `${ctx.target.id} installer`);
  const changed = treeChanges(audited, treeMarks(ctx.bundle.root));
  if (changed.length) throw new BuildError(`Making the installer changed ${changed.length} file${changed.length === 1 ? '' : 's'} of the audited app. No artifact was created.`, { details: changed.slice(0, 40) });
  const installer = join(output, names.installer);
  if (!existsSync(installer)) throw new BuildError(`electron-builder made no ${names.installer}`, { details: readdirSync(output) });
  const destination = join(ctx.out, names.installer);
  rmSync(destination, { force: true });
  renameSync(installer, destination);
  const made = [{ kind: 'installer', path: destination, signed: ctx.report.signed || false }];
  if (existsSync(`${installer}.blockmap`)) {
    rmSync(`${destination}.blockmap`, { force: true });
    renameSync(`${installer}.blockmap`, `${destination}.blockmap`);
  }
  return made;
}

/** Every entry of a folder with its size and modification time (links not followed). */
export function treeMarks(root) {
  const marks = new Map();
  for (const file of walk(root)) {
    try { const info = lstatSync(file.path); marks.set(file.relative, `${info.size}:${info.mtimeMs}`); } catch {}
  }
  return marks;
}

/** What was added, removed or rewritten between two treeMarks. */
export function treeChanges(before, after) {
  const changed = [];
  for (const [path, mark] of after) if (before.get(path) !== mark) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed.sort();
}

async function linuxArtifacts(ctx, names, { writeAppImage }) {
  step('AppImage');
  const image = join(ctx.out, names.appimage);
  rmSync(image, { force: true });
  const made = writeAppImage(ctx, { appDir: ctx.bundle.root, runtime: ctx.appImageTools.runtime, image, mksquashfs: ctx.appImageTools.mksquashfs });
  note(`runtime ${made.offset} bytes, then ${made.inodes} files, folders and links`);
  // An embedded blockmap, the way electron-builder makes its AppImages: the updater can download only what changed.
  const { buildBlockMap } = ctx.desktop.tools.requireTool('app-builder-lib/out/targets/blockmap/blockmap.js');
  const info = await buildBlockMap(image, 'deflate');
  chmodSync(image, 0o755);
  return [{ kind: 'appimage', path: image, signed: false, blockMapSize: info?.blockMapSize ?? null }];
}

/** Create this target's files in ctx.out. Returns [{ kind, path, signed, ... }]. */
export async function desktopArtifacts(ctx, names, wanted, { writeAppImage }) {
  mkdirSync(ctx.out, { recursive: true });
  if (ctx.target.platform === 'darwin') {
    const made = macArtifacts(ctx, names, wanted);
    for (const artifact of made) artifact.blockmap = await writeBlockmap(ctx, artifact.path);
    return made;
  }
  if (ctx.target.platform === 'win32') return windowsArtifacts(ctx, names);
  return linuxArtifacts(ctx, names, { writeAppImage });
}

// ── The update feed ──

const CHANNEL = Object.freeze({ darwin: 'latest-mac.yml', win32: 'latest.yml', linux: 'latest-linux.yml' });
export const channelFileFor = (platform) => CHANNEL[platform];

/** One target's part of the feed, from its artifacts: written as <base>.feed.json next to them. */
export async function feedFragment(ctx, artifacts, { releaseNotes = null, releaseDate = new Date().toISOString() } = {}) {
  const files = [];
  for (const artifact of artifacts) {
    if (!['dmg', 'zip', 'installer', 'appimage'].includes(artifact.kind)) continue;
    files.push({
      url: basename(artifact.path),
      sha512: await sha512Base64(artifact.path),
      size: statSync(artifact.path).size,
      arch: ctx.target.arch,
      kind: artifact.kind,
      ...(artifact.blockMapSize ? { blockMapSize: artifact.blockMapSize } : {}),
    });
  }
  const primary = files.find(file => ['zip', 'installer', 'appimage'].includes(file.kind)) || files[0];
  return { platform: ctx.target.platform, target: ctx.target.id, version: ctx.version, releaseDate, releaseNotes, files, primary: primary?.url || null };
}

const yamlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * A feed file in electron-builder's layout (what electron-updater reads):
 * version, files [{ url, sha512, size }], path and sha512 of the main file,
 * releaseDate, releaseNotes. `arch` marks each macOS file for this app's own
 * macOS updater.
 */
export function feedYaml({ version, files, path, releaseDate, releaseNotes }) {
  const lines = [`version: ${yamlString(version)}`, 'files:'];
  for (const file of files) {
    lines.push(`  - url: ${yamlString(file.url)}`, `    sha512: ${yamlString(file.sha512)}`, `    size: ${file.size}`);
    if (file.arch) lines.push(`    arch: ${yamlString(file.arch)}`);
    if (file.blockMapSize) lines.push(`    blockMapSize: ${file.blockMapSize}`);
  }
  const main = files.find(file => file.url === path) || files[0];
  lines.push(`path: ${yamlString(main.url)}`, `sha512: ${yamlString(main.sha512)}`, `releaseDate: ${yamlString(releaseDate)}`);
  if (releaseNotes) {
    lines.push('releaseNotes: |-');
    for (const line of String(releaseNotes).replace(/\r\n?/g, '\n').split('\n')) lines.push(line ? `  ${line}` : '');
  }
  return lines.join('\n') + '\n';
}

/**
 * The feed files of every platform found in `out`, from the fragments the
 * target builds wrote there: one latest-mac.yml for both macOS builds, one
 * latest.yml, one latest-linux.yml. A platform whose fragments disagree on the
 * version stops here. Then SHA256SUMS over every file to publish.
 */
export async function writeFeeds(out) {
  const fragments = readdirSync(out).filter(name => name.endsWith('.feed.json')).map(name => JSON.parse(readFileSync(join(out, name), 'utf8')));
  const written = [];
  for (const platform of ['darwin', 'win32', 'linux']) {
    const mine = fragments.filter(fragment => fragment.platform === platform);
    if (!mine.length) continue;
    const versions = [...new Set(mine.map(fragment => fragment.version))];
    if (versions.length !== 1) throw new BuildError(`The ${platform} builds in ${out} are of different versions (${versions.join(', ')}): one feed cannot describe them.`);
    // macOS: Apple Silicon first (the updater picks by its mark either way); zips before disk images.
    const order = (file) => (file.arch === 'arm64' ? 0 : 1) * 10 + (file.kind === 'zip' ? 0 : 1);
    const files = mine.flatMap(fragment => fragment.files).sort((a, b) => order(a) - order(b));
    const primary = (mine.find(fragment => fragment.target.endsWith('arm64')) || mine[0]).primary;
    const text = feedYaml({
      version: versions[0], files, path: primary,
      releaseDate: mine.map(fragment => fragment.releaseDate).sort().at(-1),
      releaseNotes: mine.find(fragment => fragment.releaseNotes)?.releaseNotes || null,
    });
    writeFileSync(join(out, CHANNEL[platform]), text);
    written.push(CHANNEL[platform]);
  }
  const publishable = readdirSync(out).filter(name => /\.(dmg|zip|exe|AppImage|blockmap|yml)$/.test(name)).sort();
  const sums = [];
  for (const name of publishable) sums.push(`${await sha256File(join(out, name))}  ${name}`);
  writeFileSync(join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
  return { feeds: written, sums: publishable };
}

// ── A release, as a dry run ──

/** The repository whose latest release the installed apps read (FEED_URL). */
export const RELEASE_REPO = 'danilokhury/Synabun';
/** Every file a desktop release carries: the installers and archives, then the feed. */
const RELEASE_PATTERNS = Object.freeze([
  { label: 'macOS Apple Silicon disk image', test: /-macos-arm64\.dmg$/ },
  { label: 'macOS Apple Silicon update archive', test: /-macos-arm64\.zip$/ },
  { label: 'macOS Intel disk image', test: /-macos-x64\.dmg$/ },
  { label: 'macOS Intel update archive', test: /-macos-x64\.zip$/ },
  { label: 'Windows x64 installer', test: /-windows-x64-setup\.exe$/ },
  { label: 'Linux x64 AppImage', test: /-linux-x64\.AppImage$/ },
]);

/** The files a feed file names, with what it says about each (the layout feedYaml writes). */
export function feedEntries(text) {
  const entries = [];
  let current = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const url = /^ {2}- url: '((?:[^']|'')*)'$/.exec(line);
    if (url) { current = { url: url[1].replace(/''/g, "'"), sha512: null, size: null, arch: null }; entries.push(current); continue; }
    const field = /^ {4}(sha512|size|arch): '?((?:[^']|'')*?)'?$/.exec(line);
    if (field && current) current[field[1]] = field[1] === 'size' ? Number(field[2]) : field[2].replace(/''/g, "'");
    else if (!/^ {4}/.test(line)) current = null;
  }
  const version = /^version: '((?:[^']|'')*)'$/m.exec(String(text))?.[1] || null;
  return { version, files: entries };
}

/**
 * What a release of the builds in `out` would be: which files go up, in which
 * order, to which release, what each feed file says, and whether it all agrees
 * (every file a feed names is there, with its size and SHA-512; one version;
 * every target present; a version the installed apps take as newer). Reads
 * only; uploads, tags and publishes nothing.
 */
export async function releasePlan(out, { tag = null, repo = RELEASE_REPO, newerThan = null } = {}) {
  const names = existsSync(out) ? readdirSync(out).sort() : [];
  const problems = [];
  const warnings = [];
  const feeds = [];
  const versions = new Set();
  for (const name of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) {
    if (!names.includes(name)) { problems.push(`${name} is missing: run "node packaging/build.mjs feed --out ${out}" after the builds`); continue; }
    const text = readFileSync(join(out, name), 'utf8');
    const parsed = feedEntries(text);
    if (parsed.version) versions.add(parsed.version);
    else problems.push(`${name} names no version`);
    const checked = [];
    for (const entry of parsed.files) {
      const path = join(out, entry.url);
      if (!names.includes(entry.url)) { problems.push(`${name} names ${entry.url}, which is not in ${out}`); checked.push({ ...entry, ok: false }); continue; }
      const size = statSync(path).size;
      const sha512 = await sha512Base64(path);
      const ok = size === entry.size && sha512 === entry.sha512;
      if (!ok) problems.push(`${name}: ${entry.url} is ${size} bytes with another SHA-512 than the feed says (${entry.size} bytes)`);
      checked.push({ ...entry, ok });
    }
    feeds.push({ name, text, version: parsed.version, files: checked });
  }
  const mac = feeds.find(feed => feed.name === 'latest-mac.yml');
  if (mac) {
    for (const arch of ['arm64', 'x64']) {
      if (!mac.files.some(file => file.arch === arch && /\.zip$/.test(file.url))) warnings.push(`latest-mac.yml has no ${arch} zip: ${arch === 'x64' ? 'Intel Macs' : 'Apple Silicon Macs'} get no update from this release`);
    }
  }
  if (versions.size > 1) problems.push(`the feed files name different versions: ${[...versions].join(', ')}`);
  const version = versions.size === 1 ? [...versions][0] : null;
  const expectedTag = version ? `v.${version}` : null;
  if (tag && version && String(tag).replace(/^v\.?/, '') !== version) problems.push(`the release ${tag} is not the version it carries (${version}): the workflow refuses it, and the apps would be offered ${version}`);
  if (version && /^\d{4,}\./.test(version)) warnings.push(`${version} is a date-style version: by SynaBun's rule every 2.x install takes it as OLDER, so no installed 2.x app would ever be offered it. Release a 2.x version.`);
  if (version && newerThan && !newerThan.isNewer(newerThan.version, version)) warnings.push(`${version} is not newer than ${newerThan.version} by SynaBun's rule: apps on ${newerThan.version} would not be offered it`);

  const uploads = { installers: [], feed: [] };
  for (const name of names) {
    const kind = RELEASE_PATTERNS.find(pattern => pattern.test.test(name));
    const blockmap = /\.(dmg|zip|exe)\.blockmap$/.test(name);
    if (!kind && !blockmap) continue;
    const path = join(out, name);
    uploads.installers.push({ name, label: kind ? kind.label : 'blockmap (smaller downloads for the next update)', size: statSync(path).size, sha256: await sha256File(path) });
  }
  for (const pattern of RELEASE_PATTERNS) {
    const found = names.filter(name => pattern.test.test(name));
    if (found.length !== 1) problems.push(`${found.length ? `${found.length} files` : 'no file'} for the ${pattern.label} (one expected)`);
  }
  for (const name of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml', 'SHA256SUMS']) {
    if (!names.includes(name)) { if (name === 'SHA256SUMS') problems.push('SHA256SUMS is missing'); continue; }
    const path = join(out, name);
    uploads.feed.push({ name, size: statSync(path).size, sha256: await sha256File(path) });
  }
  const releaseTag = tag || expectedTag;
  return {
    repo, tag: releaseTag, version,
    releaseUrl: releaseTag ? `https://github.com/${repo}/releases/tag/${releaseTag}` : null,
    feedUrl: FEED_URL,
    uploads, feeds, problems, warnings,
    commands: releaseTag ? [
      `gh release upload "${releaseTag}" --repo ${repo} --clobber ${uploads.installers.map(file => file.name).join(' ')}`,
      `gh release upload "${releaseTag}" --repo ${repo} --clobber ${uploads.feed.map(file => file.name).join(' ')}`,
    ] : [],
  };
}

/** The plan as the text a person reads before they publish. */
export function formatReleasePlan(plan) {
  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
  const lines = [
    'Release plan (dry run: nothing is uploaded, tagged or published)',
    '',
    `Release:  ${plan.tag || '(no version: the feed files are missing)'} of ${plan.repo}${plan.releaseUrl ? `  ${plan.releaseUrl}` : ''}`,
    `It must be the repository's Latest release: installed apps read ${plan.feedUrl}/<file>.`,
    '',
    '1. Installers, archives and blockmaps first:',
    ...plan.uploads.installers.map(file => `   ${file.name}  ${mb(file.size)}  sha256 ${file.sha256}  (${file.label})`),
    '',
    '2. The feed last (until it is there, installed apps find no update):',
    ...plan.uploads.feed.map(file => `   ${file.name}  ${file.size} bytes  sha256 ${file.sha256}`),
    '',
  ];
  if (plan.commands.length) lines.push('What the "Build applications" workflow runs for it (do not run by hand without the owner\'s OK):', ...plan.commands.map(command => `   ${command}`), '');
  for (const feed of plan.feeds) {
    lines.push(`--- ${feed.name} (v${feed.version || '?'}; every file named is in the folder with its size and SHA-512: ${feed.files.every(file => file.ok) ? 'yes' : 'NO'}) ---`);
    lines.push(...feed.text.replace(/\n$/, '').split('\n').map(line => `   ${line}`), '');
  }
  if (plan.warnings.length) lines.push('Warnings:', ...plan.warnings.map(item => `   - ${item}`), '');
  lines.push(plan.problems.length ? `NOT READY (${plan.problems.length}):` : plan.warnings.length ? 'The files agree, but read the warnings before publishing.' : 'Ready: every check passed.');
  lines.push(...plan.problems.map(item => `   - ${item}`));
  return lines.join('\n') + '\n';
}

/** What a macOS bundle's code signature says, for the build report. */
export function codesignSummary(app) {
  const result = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' });
  const text = String(result.stderr || '');
  return {
    signature: /Signature=adhoc/.test(text) ? 'ad-hoc' : (/Authority=([^\n]+)/.exec(text)?.[1] || 'unknown'),
    identifier: /Identifier=([^\n]+)/.exec(text)?.[1] || null,
  };
}
