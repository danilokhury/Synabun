/** Cross/native Win32 helper build. No extra compiler/runtime: the release already uses Zig. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGING_ROOT } from './targets.mjs';
import { toolchain } from './preflight.mjs';
import { run, which } from './util.mjs';

export function nativeWindowTokens(css) {
  const value = name => {
    const roles = { background: 'bg', text: 'text', 'text-muted': 'muted', accent: 'gold', success: 'success', danger: 'danger' };
    const hex = new RegExp(`--(?:color-${name}|${roles[name]}):\\s*#([0-9a-f]{6,8});`, 'i').exec(css)?.[1];
    if (!hex) throw new Error(`Style Guide token color-${name} missing`);
    const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    const bg = name === 'background' ? [0, 0, 0] : value('background');
    return [0, 2, 4].map((i, channel) => Math.round(parseInt(hex.slice(i, i + 2), 16) * alpha + bg[channel] * (1 - alpha)));
  };
  const size = name => {
    const match = new RegExp(`--text-${name}-size:\\s*([0-9.]+)(px|rem);`).exec(css);
    if (!match) throw new Error(`Style Guide text-${name}-size missing`);
    return Math.round(Number(match[1]) * (match[2] === 'rem' ? 16 : 1));
  };
  return ['background', 'text', 'text-muted', 'accent', 'success', 'danger'].map(name =>
    `#define TOKEN_${name === 'text-muted' ? 'MUTED' : name.toUpperCase()} RGB(${value(name).join(', ')})`).join('\n') + `\n#define TOKEN_BODY_SIZE ${size('body')}\n#define TOKEN_CAPTION_SIZE ${size('caption')}\n#define TOKEN_HEADING_SIZE ${size('h2')}\n`;
}
/** Clean intentionally excludes .synabun/ and DESIGN.md. Derive identical roles from the owning shipped UI there. */
export function nativeWindowCss(repoRoot) {
  const guide = join(repoRoot, '.synabun/style-guide/tokens.css');
  if (existsSync(guide)) return readFileSync(guide, 'utf8');
  const splash = readFileSync(join(repoRoot, 'packaging/desktop/src/pages/splash.css'), 'utf8');
  const wpf = readFileSync(join(repoRoot, 'packaging/desktop/src/updater/install-window.ps1'), 'utf8');
  const body = /font:\s*400\s+(\d+)px\/1\.45 var\(--body-font\)/.exec(splash)?.[1];
  const caption = /Property="FontSize" Value="(\d+)"/.exec(wpf)?.[1];
  const heading = /\.wordmark\s*\{[^}]*height:\s*(\d+)px/.exec(splash)?.[1];
  if (!body || !caption || !heading) throw new Error('The owning splash/WPF typography changed: review native token mapping');
  return `${splash}\n:root { --text-body-size: ${body}px; --text-caption-size: ${caption}px; --text-h2-size: ${heading}px; }\n`;
}

export function buildNativeInstallWindow(ctx, folder) {
  const compiler = process.env.ZIG || which('zig');
  writeFileSync(join(folder, 'install-window-tokens.h'), nativeWindowTokens(nativeWindowCss(ctx.repoRoot)));
  const output = join(folder, 'SynaBun-install-window.exe');
  const source = join(PACKAGING_ROOT, 'desktop/native/install-window.c');
  if (!compiler && !ctx.cross && process.platform === 'win32') {
    const { msvc, mingw } = toolchain(ctx.target);
    if (msvc) {
      const batch = join(folder, 'build-install-window.cmd');
      writeFileSync(batch, [
        '@echo off', `call "${msvc}" x64 >nul`, 'if errorlevel 1 exit /b 1', `cd /d "${folder}"`,
        `cl /nologo /O2 /W3 /MT /std:c17 /utf-8 /I"${folder}" "${source}" /Fe"${output}" /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib shell32.lib`,
        'if errorlevel 1 exit /b 1', '',
      ].join('\r\n'));
      run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${batch}""`], { verbatim: true, env: process.env, label: 'compile SAC native window (MSVC)' });
      return output;
    }
    if (mingw) {
      run(mingw.gcc, ['-O2', '-Wall', '-municode', '-mwindows', '-static', '-I', folder, '-o', output, source, '-luser32', '-lgdi32', '-lshell32'], { env: process.env, label: 'compile SAC native window (MinGW)' });
      return output;
    }
  }
  if (!compiler) throw new Error('Zig is required to cross-build the SAC native install window (set ZIG)');
  run(compiler, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-s', '-Wall', '-Wextra', '-Werror', '-municode', '-Wl,/subsystem:windows',
    '-I', folder, '-o', output, source, '-luser32', '-lgdi32', '-lshell32'], {
    env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: join(ctx.cache, 'zig'), ZIG_LOCAL_CACHE_DIR: join(ctx.work, 'zig') }, label: 'compile SAC native install window (Zig)',
  });
  return output;
}
