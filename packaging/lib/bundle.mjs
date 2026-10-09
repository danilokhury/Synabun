/**
 * From a staged application to something a person installs.
 *
 *   macOS    SynaBun.app                 -> .dmg (and .zip)
 *   Windows  SynaBun\SynaBun.exe + files -> NSIS installer, or a .zip when makensis is not installed
 *   Linux    SynaBun.AppDir              -> AppImage, or a portable .tar.gz
 *
 * Every bundle has the same inside: the native entry, and next to it the Node
 * runtime, the application, the bootstrap and a manifest that says what this
 * build is (lib/packaged-runtime.js reads it).
 *
 * Signing is off unless credentials are given in the environment (see
 * packaging/README.md). Nothing here uploads anything.
 *
 * A cross build (lib/cross.mjs) makes the same bundles and the same artifacts
 * with other tools: zig for the entry, mksquashfs for the AppImage.
 */

import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compileEntry, compileResources, writeAppImage } from './cross.mjs';
import { artifactNames, PACKAGING_ROOT } from './targets.mjs';
import { toolchain } from './preflight.mjs';
import { BuildError, fetchVerified, nativeFormat, note, removeTree, run, step, walk, which } from './util.mjs';

const LAUNCHER_SOURCE = join(PACKAGING_ROOT, 'launcher', 'launcher.c');
const ICON_SOURCE = ['neural-interface', 'public', 'icon-512.png'];
const BUNDLE_ID = 'ai.synabun.app';

/** Where each kind of bundle keeps things, relative to its root. */
const LAYOUTS = Object.freeze({
  'macos-app': { root: 'SynaBun.app', entry: 'Contents/MacOS/SynaBun', resources: 'Contents/Resources', manifestEntry: '../MacOS/SynaBun', runtimeBin: 'runtime/bin' },
  'windows-dir': { root: 'SynaBun', entry: 'SynaBun.exe', resources: 'resources', manifestEntry: '../SynaBun.exe', runtimeBin: 'runtime' },
  'linux-appdir': { root: 'SynaBun.AppDir', entry: 'AppRun', resources: 'usr/lib/synabun', manifestEntry: '../../../AppRun', runtimeBin: 'runtime/bin' },
});

const builtAt = () => new Date(process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now()).toISOString();

/** Move the parts of the unpacked Node that run an application; leave headers and docs behind. */
function placeRuntime(ctx, destination) {
  const from = ctx.runtime.root;
  mkdirSync(destination, { recursive: true });
  if (ctx.target.platform === 'win32') {
    for (const name of ['node.exe', 'npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1']) {
      if (existsSync(join(from, name))) renameSync(join(from, name), join(destination, name));
    }
    mkdirSync(join(destination, 'node_modules'));
    renameSync(join(from, 'node_modules', 'npm'), join(destination, 'node_modules', 'npm'));
  } else {
    mkdirSync(join(destination, 'bin'));
    mkdirSync(join(destination, 'lib', 'node_modules'), { recursive: true });
    renameSync(join(from, 'bin', 'node'), join(destination, 'bin', 'node'));
    renameSync(join(from, 'lib', 'node_modules', 'npm'), join(destination, 'lib', 'node_modules', 'npm'));
    symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(destination, 'bin', 'npm'));
    symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', join(destination, 'bin', 'npx'));
  }
  if (existsSync(join(from, 'LICENSE'))) copyFileSync(join(from, 'LICENSE'), join(destination, 'LICENSE'));
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

function macIcon(ctx, resources) {
  if (!which('sips') || !which('iconutil')) return false;
  const source = join(ctx.repoRoot, ...ICON_SOURCE);
  const iconset = join(ctx.work, 'SynaBun.iconset');
  mkdirSync(iconset, { recursive: true });
  try {
    for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512]]) {
      run('sips', ['-z', String(size), String(size), source, '--out', join(iconset, `icon_${name}.png`)], { capture: true, env: process.env });
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'SynaBun.icns')], { capture: true, env: process.env });
    return true;
  } catch (error) {
    note(`No application icon (${error.message}).`);
    return false;
  } finally {
    removeTree(iconset);
  }
}

function infoPlist(ctx, hasIcon) {
  const entry = (name, value) => `  <key>${name}</key>${value}`;
  const text = (value) => `<string>${String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    entry('CFBundleDevelopmentRegion', text('en')),
    entry('CFBundleExecutable', text('SynaBun')),
    entry('CFBundleIdentifier', text(BUNDLE_ID)),
    entry('CFBundleInfoDictionaryVersion', text('6.0')),
    entry('CFBundleName', text('SynaBun')),
    entry('CFBundleDisplayName', text('SynaBun')),
    entry('CFBundlePackageType', text('APPL')),
    entry('CFBundleShortVersionString', text(ctx.version)),
    entry('CFBundleVersion', text(ctx.version)),
    ...(hasIcon ? [entry('CFBundleIconFile', text('SynaBun'))] : []),
    entry('LSMinimumSystemVersion', text('11.0')),
    entry('LSApplicationCategoryType', text('public.app-category.developer-tools')),
    // A server with its interface in the browser: no Dock icon to bounce for a window that never comes.
    entry('LSUIElement', '<true/>'),
    entry('NSHighResolutionCapable', '<true/>'),
    entry('NSAppleEventsUsageDescription', text('SynaBun asks other apps to do things you request, such as showing a folder picker or opening a Terminal window.')),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Put the staged parts together as the bundle of this target. Sets ctx.bundle. */
export function assembleBundle(ctx) {
  step(`Bundle (${ctx.target.bundle})`);
  const layout = LAYOUTS[ctx.target.bundle];
  const root = join(ctx.work, 'bundle', layout.root);
  const resources = join(root, layout.resources);
  const entry = join(root, layout.entry);
  mkdirSync(resources, { recursive: true });

  renameSync(ctx.app, join(resources, 'app'));
  ctx.app = join(resources, 'app');
  placeRuntime(ctx, join(resources, 'runtime'));
  copyFileSync(join(PACKAGING_ROOT, 'runtime', 'bootstrap.mjs'), join(resources, 'bootstrap.mjs'));

  const manifest = {
    synabunPackage: 1,
    name: 'synabun',
    version: ctx.version,
    app: 'app',
    target: { id: ctx.target.id, platform: ctx.target.platform, arch: ctx.target.arch, libc: ctx.target.libc || null },
    artifact: ctx.target.bundle,
    entry: layout.manifestEntry,
    runtime: { node: ctx.runtime.version, bin: layout.runtimeBin },
    embeddingModel: ctx.report.embeddingModel,
    builtAt: builtAt(),
    sourceCommit: ctx.sourceCommit || null,
  };
  writeFileSync(join(resources, 'synabun-package.json'), JSON.stringify(manifest, null, 2) + '\n');

  compileLauncher(ctx, entry);

  if (ctx.target.bundle === 'macos-app') {
    const hasIcon = macIcon(ctx, resources);
    writeFileSync(join(root, 'Contents', 'Info.plist'), infoPlist(ctx, hasIcon));
    writeFileSync(join(root, 'Contents', 'PkgInfo'), 'APPL????');
  } else if (ctx.target.bundle === 'linux-appdir') {
    writeFileSync(join(root, 'synabun.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=SynaBun',
      'Comment=Persistent vector memory for AI assistants',
      'Exec=AppRun',
      'Icon=synabun',
      'Categories=Development;Utility;',
      'Terminal=false',
      '',
    ].join('\n'));
    copyFileSync(join(ctx.repoRoot, ...ICON_SOURCE), join(root, 'synabun.png'));
    symlinkSync('synabun.png', join(root, '.DirIcon'));
    // The name people type when they unpack the portable archive.
    symlinkSync('AppRun', join(root, 'synabun'));
  } else {
    for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']) {
      if (existsSync(join(ctx.app, name))) copyFileSync(join(ctx.app, name), join(root, name));
    }
  }

  ctx.bundle = { root, entry, resources, layout, manifest };
  note(root);
}

// ── Signing (only with credentials from the environment) ──

function signMac(ctx) {
  const identity = process.env.SYNABUN_MAC_SIGN_IDENTITY;
  if (!identity) return false;
  step('Sign the application');
  const entitlements = join(PACKAGING_ROOT, 'macos', 'entitlements.plist');
  const base = ['--force', '--options', 'runtime', '--entitlements', entitlements, ...(identity === '-' ? [] : ['--timestamp']), '--sign', identity];
  // Inside out: every Mach-O file first, the bundle that seals them last.
  const nested = [...walk(ctx.bundle.root)]
    .filter(file => !file.link && file.path !== ctx.bundle.entry && nativeFormat(file.path)?.format === 'macho')
    .map(file => file.path)
    .sort((a, b) => b.split('/').length - a.split('/').length);
  for (const file of nested) run('codesign', [...base, file], { capture: true, env: process.env, label: `codesign ${file.slice(ctx.bundle.root.length + 1)}` });
  run('codesign', [...base, ctx.bundle.root], { capture: true, env: process.env, label: 'codesign SynaBun.app' });
  run('codesign', ['--verify', '--deep', '--strict', ctx.bundle.root], { capture: true, env: process.env, label: 'verify the signature' });
  note(`${nested.length + 1} signatures (${identity === '-' ? 'ad hoc' : identity})`);
  return identity === '-' ? 'ad-hoc' : 'developer-id';
}

function notarizeMac(file) {
  const env = process.env;
  const credentials = env.SYNABUN_MAC_NOTARY_PROFILE
    ? ['--keychain-profile', env.SYNABUN_MAC_NOTARY_PROFILE]
    : env.APPLE_ID && env.APPLE_TEAM_ID && env.APPLE_APP_SPECIFIC_PASSWORD
      // notarytool reads the password from the environment itself: it never appears in a command line.
      ? ['--apple-id', env.APPLE_ID, '--team-id', env.APPLE_TEAM_ID, '--password', '@env:APPLE_APP_SPECIFIC_PASSWORD']
      : null;
  if (!credentials) return false;
  step('Notarize');
  run('xcrun', ['notarytool', 'submit', file, ...credentials, '--wait'], { env, label: 'notarytool submit' });
  run('xcrun', ['stapler', 'staple', file], { env, label: 'staple the ticket' });
  return true;
}

function signWindows(file) {
  const env = process.env;
  const selector = env.SYNABUN_WIN_SIGN_THUMBPRINT
    ? ['/sha1', env.SYNABUN_WIN_SIGN_THUMBPRINT]
    : env.SYNABUN_WIN_SIGN_PFX ? ['/f', env.SYNABUN_WIN_SIGN_PFX, ...(env.SYNABUN_WIN_SIGN_PASSWORD ? ['/p', env.SYNABUN_WIN_SIGN_PASSWORD] : [])] : null;
  if (!selector) return false;
  const signtool = env.SYNABUN_SIGNTOOL || which('signtool');
  if (!signtool) throw new BuildError('A Windows signing certificate was given but signtool was not found (set SYNABUN_SIGNTOOL).');
  run(signtool, ['sign', '/fd', 'SHA256', '/tr', env.SYNABUN_WIN_TIMESTAMP_URL || 'http://timestamp.digicert.com', '/td', 'SHA256', ...selector, file], {
    capture: true, env, label: `signtool sign ${basename(file)}`,
  });
  return true;
}

// ── Artifacts ──

function macArtifacts(ctx, names, wanted) {
  const signed = signMac(ctx);
  const made = [];
  if (wanted.includes('dmg')) {
    step('Disk image');
    const volume = join(ctx.work, 'dmg');
    mkdirSync(volume, { recursive: true });
    const inVolume = join(volume, 'SynaBun.app');
    renameSync(ctx.bundle.root, inVolume);
    try {
      symlinkSync('/Applications', join(volume, 'Applications'));
      const dmg = join(ctx.out, names.dmg);
      run('hdiutil', ['create', '-volname', 'SynaBun', '-srcfolder', volume, '-ov', '-format', 'UDZO', dmg], { capture: true, env: process.env, label: 'hdiutil create' });
      if (signed === 'developer-id') run('codesign', ['--force', '--timestamp', '--sign', process.env.SYNABUN_MAC_SIGN_IDENTITY, dmg], { capture: true, env: process.env, label: 'codesign the disk image' });
      const notarized = signed === 'developer-id' && notarizeMac(dmg);
      made.push({ kind: 'dmg', path: dmg, signed: signed || false, notarized });
    } finally {
      renameSync(inVolume, ctx.bundle.root);
      removeTree(volume);
    }
  }
  if (wanted.includes('zip')) {
    step('Zip archive');
    const zip = join(ctx.out, names.zip);
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', ctx.bundle.root, zip], { capture: true, env: process.env, label: 'ditto' });
    made.push({ kind: 'zip', path: zip, signed: signed || false, notarized: false });
  }
  return made;
}

/** The command line of makensis. Away from Windows its options start with a dash: a slash there starts a path. */
export function nsisArguments({ version, appDir, installer, icon, script }, platform = process.platform) {
  const option = platform === 'win32' ? '/' : '-';
  return [
    `${option}V2`, `${option}INPUTCHARSET`, 'UTF8',
    `${option}DAPP_VERSION=${version}`,
    `${option}DAPP_VERSION_QUAD=${versionQuad(version).join('.')}`,
    `${option}DAPP_DIR=${appDir}`,
    `${option}DOUT_FILE=${installer}`,
    ...(icon ? [`${option}DAPP_ICON=${icon}`] : []),
    script,
  ];
}

function windowsArtifacts(ctx, names, wanted) {
  const signed = signWindows(ctx.bundle.entry);
  const made = [];
  const { nsis } = toolchain(ctx.target);
  if (wanted.includes('installer') && nsis) {
    step('Installer (NSIS)');
    const installer = join(ctx.out, names.installer);
    const icon = join(ctx.work, 'launcher', 'synabun.ico');
    run(nsis, nsisArguments({
      version: ctx.version, appDir: ctx.bundle.root, installer, icon: existsSync(icon) ? icon : null,
      script: join(PACKAGING_ROOT, 'windows', 'installer.nsi'),
    }), { env: process.env, label: 'makensis' });
    made.push({ kind: 'installer', path: installer, signed: signWindows(installer) });
  }
  if (wanted.includes('zip') || !made.length) {
    if (!made.length && wanted.includes('installer')) note('makensis is not installed: this build is a portable zip, not an installer.');
    step('Zip archive (portable, no installer)');
    const zip = join(ctx.out, names.zip);
    if (ctx.cross) run('zip', ['-r', '-q', '-X', zip, basename(ctx.bundle.root)], { cwd: dirname(ctx.bundle.root), env: process.env, label: 'create the zip' });
    else run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', dirname(ctx.bundle.root), basename(ctx.bundle.root)], { env: process.env, label: 'create the zip' });
    made.push({ kind: 'zip (portable, no installer)', path: zip, signed });
  }
  return made;
}

async function linuxArtifacts(ctx, names, wanted) {
  const made = [];
  if (wanted.includes('appimage')) {
    try {
      step('AppImage');
      const tools = ctx.pins.tools;
      const fetchTool = async (pin) => {
        const path = await fetchVerified({ url: pin.url, sha256: pin.sha256, destination: join(ctx.cache, 'tools', `${pin.version}-${pin.file}`), label: `${pin.file} ${pin.version}` });
        chmodSync(path, 0o755);
        return path;
      };
      const runtime = process.env.APPIMAGE_RUNTIME_FILE || (ctx.options.toolDownloads ? await fetchTool(tools['appimage-runtime']) : null);
      const image = join(ctx.out, names.appimage);
      if (ctx.cross) {
        // appimagetool is a Linux program. What it does is done here with mksquashfs and the same pinned runtime.
        if (!runtime) throw new BuildError('the AppImage runtime is not at hand and tool downloads are off');
        const made = writeAppImage(ctx, { appDir: ctx.bundle.root, runtime, image });
        note(`runtime ${made.offset} bytes, then ${made.inodes} files, folders and links`);
      } else {
        // A tool that is already installed is used as it is; otherwise the pinned release, verified.
        const appimagetool = process.env.APPIMAGETOOL || which('appimagetool') || (ctx.options.toolDownloads ? await fetchTool(tools.appimagetool) : null);
        if (!appimagetool) throw new BuildError('appimagetool is not installed and tool downloads are off');
        run(appimagetool, ['--no-appstream', ...(runtime ? ['--runtime-file', runtime] : []), ctx.bundle.root, image], {
          // Unpack-and-run: appimagetool is itself an AppImage, and a build machine may have no FUSE.
          env: { ...process.env, ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' },
          label: 'appimagetool',
        });
      }
      chmodSync(image, 0o755);
      made.push({ kind: 'appimage', path: image, signed: false });
    } catch (error) {
      if (!wanted.includes('portable') && !ctx.options.portableFallback) throw error;
      note(`No AppImage (${error.message}). Building the portable archive instead.`);
    }
  }
  if (wanted.includes('portable') || !made.length) {
    step('Portable archive (not an AppImage: unpack it and run ./synabun)');
    const folder = join(dirname(ctx.bundle.root), names.base);
    renameSync(ctx.bundle.root, folder);
    try {
      const archive = join(ctx.out, names.portable);
      // COPYFILE_DISABLE: the tar of macOS would otherwise add its own metadata files.
      run('tar', ['-czf', archive, '-C', dirname(folder), basename(folder)], { env: { ...process.env, COPYFILE_DISABLE: '1' }, label: 'create the archive' });
      made.push({ kind: 'portable archive (not an AppImage)', path: archive, signed: false });
    } finally {
      renameSync(folder, ctx.bundle.root);
    }
  }
  return made;
}

/** Create the distributable files of this target in ctx.out. Returns [{ kind, path, signed }]. */
export async function createArtifacts(ctx) {
  mkdirSync(ctx.out, { recursive: true });
  const names = artifactNames(ctx.target, ctx.version);
  const wanted = ctx.options.artifacts?.length ? ctx.options.artifacts : [ctx.target.artifacts[0]];
  const unknown = wanted.filter(kind => !ctx.target.artifacts.includes(kind));
  if (unknown.length) throw new BuildError(`${ctx.target.id} has no "${unknown.join(', ')}" artifact. It has: ${ctx.target.artifacts.join(', ')}.`);
  if (ctx.target.bundle === 'macos-app') return macArtifacts(ctx, names, wanted);
  if (ctx.target.bundle === 'windows-dir') return windowsArtifacts(ctx, names, wanted);
  return linuxArtifacts(ctx, names, wanted);
}
