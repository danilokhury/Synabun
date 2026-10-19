/**
 * From a staged application to the desktop app a person installs.
 *
 *   payload   what every build carries, next to the app's window: the Node
 *             runtime, the application, cloudflared (staged by stage.mjs),
 *             Git for Windows on Windows (git-bash.mjs), the bootstrap, and a
 *             manifest that says what this build is
 *             (lib/packaged-runtime.js reads it), with the headless native
 *             entry (launcher/launcher.c) compiled for the target
 *   app       the Electron window around the payload (lib/desktop.mjs):
 *             SynaBun.app, SynaBun.exe with its installer, or the AppImage
 *   artifacts .dmg + .zip (macOS), -setup.exe (Windows), .AppImage (Linux),
 *             their blockmaps, and the update feed files
 *
 * Signing is off unless credentials are given in the environment (see
 * packaging/README.md); an unsigned macOS app is signed ad hoc. Nothing here
 * uploads anything.
 *
 * A cross build (lib/cross.mjs) compiles the entry (and node-pty) with zig and
 * makes the AppImage with mksquashfs; the window comes from the same pinned
 * Electron archive either way.
 */

import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { bundledNpmrc } from '../../lib/packaged-runtime.js';
import { compileEntry, compileResources, writeAppImage } from './cross.mjs';
import { buildDesktopApp, desktopArtifacts, FEED_URL, feedFragment, shellLayoutFor, writeFeeds } from './desktop.mjs';
import { artifactNames, PACKAGING_ROOT } from './targets.mjs';
import { toolchain } from './preflight.mjs';
import { BuildError, fetchVerified, nativeFormat, note, removeTree, run, step, which } from './util.mjs';

const LAUNCHER_SOURCE = join(PACKAGING_ROOT, 'launcher', 'launcher.c');
const ICON_SOURCE = ['neural-interface', 'public', 'icon-512.png'];

const builtAt = () => new Date(process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now()).toISOString();

/** The npm and npx commands Node.js ships on Windows: command files, PowerShell and sh shims, all beside node.exe. */
export const WINDOWS_NPM_SHIMS = Object.freeze(['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1']);

/**
 * `bin/npm` or `bin/npx` of a macOS or Linux runtime. Node.js ships them as links to npm's own scripts, which start
 * with `#!/usr/bin/env node`: they run on whichever node comes first on PATH and on none at all where there is no
 * Node. These run npm with the Node beside them, whatever PATH says, the way Node's own Windows command files do,
 * through a link or from a folder with spaces in its name. The runtime's bin goes on the end of PATH for what npm
 * starts in turn (a package's `#!/usr/bin/env node` command), so it finds a Node without ever coming before the
 * user's own.
 */
export function npmWrapperScript(tool) {
  if (tool !== 'npm' && tool !== 'npx') throw new Error(`no wrapper for ${tool}`);
  return [
    '#!/bin/sh',
    `# ${tool} of the Node.js that came with SynaBun, always run by that Node: never by`,
    '# whichever node comes first on PATH. Written by packaging/lib/bundle.mjs.',
    'self=$0',
    'while [ -h "$self" ]; do',
    '  link=$(readlink "$self")',
    '  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac',
    'done',
    'bin=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd -P) || exit 1',
    'case ":$PATH:" in',
    '  *":$bin:"*) ;;',
    '  *) PATH=${PATH:+$PATH:}$bin; export PATH ;;',
    'esac',
    `exec "$bin/node" "$bin/../lib/node_modules/npm/bin/${tool}-cli.js" "$@"`,
    '',
  ].join('\n');
}

/** Where npm's own files are in a runtime folder of `platform` (relative). */
export const npmRootIn = (platform) => (platform === 'win32' ? join('node_modules', 'npm') : join('lib', 'node_modules', 'npm'));

/**
 * Move the parts of the unpacked Node that run an application, npm and npx included (features run them on machines
 * without a Node of their own); leave headers and docs behind. In a native build that Node also runs the rest of the
 * build (npm, electron-builder): it is copied then, not moved. npm gets its builtin settings
 * (lib/packaged-runtime.js bundledNpmrc): its global installs go to a per-user folder, never into the application.
 */
export function placeRuntime(ctx, destination) {
  const from = ctx.runtime.root;
  const take = ctx.tool?.root === from
    ? (source, target) => cpSync(source, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    : renameSync;
  mkdirSync(destination, { recursive: true });
  const windows = ctx.target.platform === 'win32';
  if (windows) {
    for (const name of ['node.exe', ...WINDOWS_NPM_SHIMS]) {
      if (!existsSync(join(from, name))) throw new BuildError(`The Node.js ${ctx.runtime.version} archive has no ${name}: npm and npx would be missing.`);
      take(join(from, name), join(destination, name));
    }
    mkdirSync(join(destination, 'node_modules'));
    take(join(from, 'node_modules', 'npm'), join(destination, 'node_modules', 'npm'));
  } else {
    mkdirSync(join(destination, 'bin'));
    mkdirSync(join(destination, 'lib', 'node_modules'), { recursive: true });
    take(join(from, 'bin', 'node'), join(destination, 'bin', 'node'));
    take(join(from, 'lib', 'node_modules', 'npm'), join(destination, 'lib', 'node_modules', 'npm'));
    for (const tool of ['npm', 'npx']) {
      writeFileSync(join(destination, 'bin', tool), npmWrapperScript(tool));
      chmodSync(join(destination, 'bin', tool), 0o755);
    }
  }
  writeFileSync(join(destination, npmRootIn(ctx.target.platform), 'npmrc'), bundledNpmrc(ctx.target.platform));
  if (existsSync(join(from, 'LICENSE'))) copyFileSync(join(from, 'LICENSE'), join(destination, 'LICENSE'));
}

/**
 * Move the staged cloudflared (stage.mjs provisionCloudflared) beside the runtime: `<resources>/cloudflared/`,
 * where the application looks for the copy that came with it (neural-interface/lib/cloudflared/pins.js
 * bundledCloudflaredPath). Its path there, or null when none was staged: the audit refuses such a bundle.
 */
export function placeCloudflared(ctx, resources) {
  if (!ctx.cloudflared) return null;
  const folder = join(resources, basename(ctx.cloudflared.folder));
  renameSync(ctx.cloudflared.folder, folder);
  return join(folder, ctx.cloudflared.name);
}

/**
 * Move the staged Git for Windows (git-bash.mjs provisionGitBash, Windows targets only) beside the runtime:
 * `<resources>/git/`, where the application looks for the copy that came with it
 * (neural-interface/lib/git-bash/pins.js bundledGitRoot). Its folder there, or null when none was staged.
 */
export function placeGitBash(ctx, resources) {
  if (!ctx.gitBash) return null;
  const folder = join(resources, basename(ctx.gitBash.folder));
  renameSync(ctx.gitBash.folder, folder);
  return folder;
}

function versionQuad(version) {
  const parts = String(version).split(/[.+-]/).slice(0, 3).map(part => (/^\d+$/.test(part) ? Math.min(Number(part), 65535) : 0));
  while (parts.length < 4) parts.push(0);
  return parts;
}

/** A one-image .ico around a PNG (Windows reads PNG entries since Vista). */
export function pngToIco(png) {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width > 256 || height > 256) throw new Error('an .ico image is at most 256 pixels');
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(1, 4);            // one image
  header[6] = width === 256 ? 0 : width;
  header[7] = height === 256 ? 0 : height;
  header.writeUInt16LE(1, 10);           // planes
  header.writeUInt16LE(32, 12);          // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);          // image offset
  return Buffer.concat([header, png]);
}

function windowsIcon(ctx, folder) {
  const source = join(ctx.repoRoot, ...ICON_SOURCE);
  const resized = join(folder, 'icon-256.png');
  try {
    if (process.platform !== 'win32') {
      // A cross build: sips where there is one (macOS); otherwise the interface's
      // 192-pixel icon, which fits an .ico as it is.
      if (which('sips')) run('sips', ['-z', '256', '256', source, '--out', resized], { capture: true, env: process.env, label: 'render the icon' });
      else copyFileSync(join(dirname(source), 'icon-192.png'), resized);
    } else {
      // Paths travel in the environment, so no quoting of them is ever needed.
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Drawing; $s=[System.Drawing.Image]::FromFile($env:SYNABUN_ICON_IN); $b=New-Object System.Drawing.Bitmap 256,256; $g=[System.Drawing.Graphics]::FromImage($b); $g.InterpolationMode="HighQualityBicubic"; $g.DrawImage($s,0,0,256,256); $b.Save($env:SYNABUN_ICON_OUT,[System.Drawing.Imaging.ImageFormat]::Png)',
      ], { env: { ...process.env, SYNABUN_ICON_IN: source, SYNABUN_ICON_OUT: resized }, capture: true, label: 'render the icon' });
    }
    const ico = join(folder, 'synabun.ico');
    writeFileSync(ico, pngToIco(readFileSync(resized)));
    return ico;
  } catch (error) {
    note(`No icon for the executable (${error.message}).`);
    return null;
  }
}

function resourceScript(ctx, folder, icon) {
  const [major, minor, patch, build] = versionQuad(ctx.version);
  const quad = `${major},${minor},${patch},${build}`;
  const path = join(folder, 'launcher.rc');
  writeFileSync(path, [
    '#include <winver.h>',
    ...(icon ? [`1 ICON "${basename(icon)}"`] : []),
    'VS_VERSION_INFO VERSIONINFO',
    ` FILEVERSION ${quad}`,
    ` PRODUCTVERSION ${quad}`,
    ' FILEFLAGSMASK 0x3fL',
    ' FILEFLAGS 0x0L',
    ' FILEOS VOS_NT_WINDOWS32',
    ' FILETYPE VFT_APP',
    ' FILESUBTYPE 0x0L',
    'BEGIN',
    '  BLOCK "StringFileInfo"',
    '  BEGIN',
    '    BLOCK "040904b0"',
    '    BEGIN',
    '      VALUE "CompanyName", "The SynaBun Authors"',
    '      VALUE "FileDescription", "SynaBun"',
    `      VALUE "FileVersion", "${ctx.version}"`,
    '      VALUE "InternalName", "SynaBun"',
    '      VALUE "OriginalFilename", "SynaBun.exe"',
    '      VALUE "ProductName", "SynaBun"',
    `      VALUE "ProductVersion", "${ctx.version}"`,
    '    END',
    '  END',
    '  BLOCK "VarFileInfo"',
    '  BEGIN',
    '    VALUE "Translation", 0x409, 1200',
    '  END',
    'END',
    '',
  ].join('\r\n'));
  return path;
}

function compileWindowsLauncher(ctx, output) {
  const { msvc, mingw } = ctx.cross ? {} : toolchain(ctx.target);
  const folder = join(ctx.work, 'launcher');
  mkdirSync(folder, { recursive: true });
  const icon = windowsIcon(ctx, folder);

  // The icon is decoration; the executable is not. Try with it, then without.
  const attempts = icon ? [icon, null] : [null];
  let lastError = null;
  for (const withIcon of attempts) {
    const script = resourceScript(ctx, folder, withIcon);
    try {
      if (ctx.cross) {
        const resources = join(folder, 'launcher.res');
        compileResources(ctx, script, resources);
        compileEntry(ctx, LAUNCHER_SOURCE, output, [resources]);
      } else if (msvc) {
        const resources = join(folder, 'launcher.res');
        const batch = join(folder, 'build.cmd');
        writeFileSync(batch, [
          '@echo off',
          `call "${msvc}" ${ctx.target.arch === 'ia32' ? 'x86' : 'x64'} >nul`,
          'if errorlevel 1 exit /b 1',
          `cd /d "${folder}"`,
          `rc /nologo /fo "${resources}" "${script}"`,
          'if errorlevel 1 exit /b 1',
          `cl /nologo /O2 /W3 /MT /utf-8 /DUNICODE /D_UNICODE "${LAUNCHER_SOURCE}" "${resources}" /Fe"${output}" /link /SUBSYSTEM:WINDOWS shell32.lib`,
          'if errorlevel 1 exit /b 1',
          '',
        ].join('\r\n'));
        // cmd /s /c strips one pair of quotes: the second pair keeps a path with spaces whole.
        run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${batch}""`], { verbatim: true, env: process.env, label: 'compile the native entry (MSVC)' });
      } else if (mingw) {
        const objects = [];
        if (mingw.windres) {
          const object = join(folder, 'launcher-res.o');
          run(mingw.windres, [script, '-O', 'coff', '-o', object], { cwd: folder, env: process.env, label: 'compile the resources' });
          objects.push(object);
        }
        run(mingw.gcc, ['-O2', '-Wall', '-municode', '-mwindows', '-lshell32', '-static', '-o', output, LAUNCHER_SOURCE, ...objects], { env: process.env, label: 'compile the native entry (MinGW-w64)' });
      } else {
        throw new BuildError('No C compiler for Windows was found (Visual Studio C++ tools or MinGW-w64).');
      }
      if (icon && !withIcon) note('The executable was built without its icon.');
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function compileLauncher(ctx, output) {
  mkdirSync(dirname(output), { recursive: true });
  const { platform, arch } = ctx.target;
  if (platform === 'darwin') {
    run('clang', ['-O2', '-Wall', '-Wextra', '-std=c99', '-arch', arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=11.0', '-o', output, LAUNCHER_SOURCE], { env: process.env, label: 'compile the native entry' });
  } else if (platform === 'linux' && ctx.cross) {
    compileEntry(ctx, LAUNCHER_SOURCE, output);
  } else if (platform === 'linux') {
    run('cc', ['-O2', '-Wall', '-Wextra', '-std=c99', '-o', output, LAUNCHER_SOURCE], { env: process.env, label: 'compile the native entry' });
  } else {
    compileWindowsLauncher(ctx, output);
  }
  if (platform !== 'win32') chmodSync(output, 0o755);
  const format = nativeFormat(output);
  const wanted = { darwin: 'macho', linux: 'elf', win32: 'pe' }[platform];
  if (format?.format !== wanted || !format.archs.includes(arch)) {
    throw new BuildError(`The native entry was built as ${format ? `${format.format} ${format.archs.join('+')}` : 'something unreadable'}, not ${wanted} ${arch}.`);
  }
}

export function macIcon(ctx, folder, name = 'SynaBun.icns') {
  if (!which('sips') || !which('iconutil')) return false;
  const source = join(ctx.repoRoot, ...ICON_SOURCE);
  const iconset = join(ctx.work, 'SynaBun.iconset');
  mkdirSync(iconset, { recursive: true });
  try {
    for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512]]) {
      run('sips', ['-z', String(size), String(size), source, '--out', join(iconset, `icon_${name}.png`)], { capture: true, env: process.env });
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', join(folder, name)], { capture: true, env: process.env });
    return true;
  } catch (error) {
    note(`No application icon (${error.message}).`);
    return false;
  } finally {
    removeTree(iconset);
  }
}

/**
 * The AppImage tools of electron-builder's own toolset (pinned in pins.json
 * tools.appimage-tools): mksquashfs for this machine, the type 2 runtime
 * (the same file as tools.appimage-runtime, checked against that pin too) and
 * the libraries electron-builder puts into every Electron AppImage.
 */
async function provisionAppImageTools(ctx) {
  const pin = ctx.pins.tools['appimage-tools'];
  const archive = await fetchVerified({ url: pin.url, sha256: pin.sha256, destination: join(ctx.cache, 'tools', `appimage-tools-${pin.version}`, pin.file), label: `${pin.file} ${pin.version}`, fetchImpl: ctx.fetch });
  const root = join(dirname(archive), 'unpacked');
  if (!existsSync(join(root, 'runtimes', 'runtime-x64'))) {
    removeTree(root);
    mkdirSync(root, { recursive: true });
    run('tar', ['-xzf', archive, '-C', root], { label: 'unpack the AppImage tools' });
  }
  const host = process.platform === 'darwin' ? `darwin/${process.arch === 'arm64' ? 'arm64' : 'x64'}` : `linux/${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const mksquashfs = process.env.MKSQUASHFS || join(root, ...host.split('/'), 'mksquashfs');
  const runtime = join(root, 'runtimes', 'runtime-x64');
  const { sha256File } = await import('./util.mjs');
  if (await sha256File(runtime) !== ctx.pins.tools['appimage-runtime'].sha256) {
    throw new BuildError('The AppImage runtime of the toolset is not the pinned runtime (pins.json tools.appimage-runtime).');
  }
  if (!existsSync(mksquashfs)) throw new BuildError(`No mksquashfs for ${process.platform}-${process.arch} in the AppImage tools (set MKSQUASHFS).`);
  return { mksquashfs, runtime, libraries: join(root, 'lib', 'x64') };
}

/**
 * Put the staged parts together as the payload, compile the headless entry,
 * and make the desktop app around them. Sets ctx.bundle (lib/desktop.mjs).
 */
export async function assembleBundle(ctx) {
  step(`Payload: runtime, application, cloudflared, ${ctx.gitBash ? 'Git for Windows, ' : ''}bootstrap, manifest`);
  const layout = shellLayoutFor(ctx.target);
  const windows = ctx.target.platform === 'win32';
  const payload = join(ctx.work, 'payload');
  removeTree(payload);
  mkdirSync(payload, { recursive: true });

  renameSync(ctx.app, join(payload, 'app'));
  ctx.app = join(payload, 'app');
  placeRuntime(ctx, join(payload, 'runtime'));
  const cloudflared = placeCloudflared(ctx, payload);
  const gitBash = placeGitBash(ctx, payload);
  copyFileSync(join(PACKAGING_ROOT, 'runtime', 'bootstrap.mjs'), join(payload, 'bootstrap.mjs'));
  // One line for the native entry: the window it opens when it is run with no argument.
  writeFileSync(join(payload, 'synabun-shell'), `${layout.manifestWindow}\n`);
  // electron-updater's own settings (Windows and Linux): the public feed and where it keeps a download.
  writeFileSync(join(payload, 'app-update.yml'), `provider: generic\nurl: ${FEED_URL}\nupdaterCacheDirName: synabun-updater\n`);

  const manifest = {
    synabunPackage: 1,
    name: 'synabun',
    version: ctx.version,
    app: 'app',
    target: { id: ctx.target.id, platform: ctx.target.platform, arch: ctx.target.arch, libc: ctx.target.libc || null },
    artifact: layout.bundle,
    entry: layout.manifestEntry,
    runtime: { node: ctx.runtime.version, bin: layout.runtimeBin },
    embeddingModel: ctx.report.embeddingModel,
    cloudflared: ctx.report.cloudflared ? { version: ctx.report.cloudflared.version, sha256: ctx.report.cloudflared.binary.sha256 } : null,
    gitBash: ctx.report.gitBash?.packaged ? { version: ctx.report.gitBash.version, sha256: ctx.report.gitBash.sha256, tree: ctx.report.gitBash.tree.sha256 } : null,
    shell: { kind: 'electron', window: layout.manifestWindow, electron: ctx.pins.electron.version },
    builtAt: builtAt(),
    sourceCommit: ctx.sourceCommit || null,
  };
  writeFileSync(join(payload, 'synabun-package.json'), JSON.stringify(manifest, null, 2) + '\n');

  const entryFile = join(ctx.work, 'entry', windows ? 'synabun-cli.exe' : 'synabun-cli');
  compileLauncher(ctx, entryFile);
  ctx.payloadManifest = manifest;
  ctx.payloadCloudflared = cloudflared;
  ctx.payloadGitBash = gitBash;
  if (ctx.target.platform === 'linux') ctx.appImageTools = await provisionAppImageTools(ctx);

  await buildDesktopApp(ctx, { payload, entryFile, iconTools: { pngToIco, macIcon } });
  for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) {
    if (ctx.target.platform !== 'darwin' && existsSync(join(ctx.bundle.resources, 'app', name)) && !existsSync(join(ctx.bundle.root, name))) {
      copyFileSync(join(ctx.bundle.resources, 'app', name), join(ctx.bundle.root, name));
    }
  }
}

/**
 * Create the distributable files of this target in ctx.out, with the target's
 * part of the update feed. Returns [{ kind, path, signed }].
 */
export async function createArtifacts(ctx, { releaseNotes = null } = {}) {
  mkdirSync(ctx.out, { recursive: true });
  const names = artifactNames(ctx.target, ctx.version);
  const wanted = ctx.options.artifacts?.length ? ctx.options.artifacts : ctx.target.artifacts;
  const unknown = wanted.filter(kind => !ctx.target.artifacts.includes(kind));
  if (unknown.length) throw new BuildError(`${ctx.target.id} has no "${unknown.join(', ')}" artifact. It has: ${ctx.target.artifacts.join(', ')}.`);
  const artifacts = await desktopArtifacts(ctx, names, wanted, { writeAppImage });
  const fragment = await feedFragment(ctx, artifacts, { releaseNotes });
  writeFileSync(join(ctx.out, `${names.base}.feed.json`), JSON.stringify(fragment, null, 2) + '\n');
  ctx.report.feed = await writeFeeds(ctx.out);
  note(`update feed: ${ctx.report.feed.feeds.join(', ')}; SHA256SUMS over ${ctx.report.feed.sums.length} files`);
  return artifacts;
}
