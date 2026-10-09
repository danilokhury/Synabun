/** Browser-owned PWA shortcuts only. No browser databases and no --app= window. */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

export function pwaAppId(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}

export function pwaOrigins(port) {
  return [`http://localhost:${port}/`, `http://127.0.0.1:${port}/`, `http://[::1]:${port}/`];
}

export function matchesPwaUrl(value, port, installRoute = false) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && Number(url.port || 80) === Number(port)
      && (url.pathname === '/' || (installRoute && url.pathname === '/install-app.html')) && !url.search && !url.hash;
  } catch { return false; }
}

/** Conservative argument reader for browser-generated shortcuts, never a shell. */
export function shortcutArgs(text) {
  const args = [];
  let token = '', quoted = false, active = false;
  for (const c of String(text).trim()) {
    if (c === '"') { quoted = !quoted; active = true; }
    else if (/\s/.test(c) && !quoted) {
      if (active) args.push(token);
      token = ''; active = false;
    } else { token += c; active = true; }
  }
  if (quoted) return [];
  if (active) args.push(token);
  return args;
}

/** Rebuild the launch arguments from an installed app identity; drop nothing silently. */
export function chromiumShortcut(args, port) {
  let id = null, profile = null;
  for (const arg of args) {
    if (/^--app-id=[a-p]{32}$/.test(arg) && !id) id = arg.slice(9);
    else if (/^--profile-directory=[\w -]{1,80}$/.test(arg) && !profile) profile = arg.slice(20);
    else if (/^--app-launch-source=\d+$/.test(arg)) continue;
    else return null; // Includes --app=URL, shell syntax and additional browser switches.
  }
  if (!id || !pwaOrigins(port).some(url => pwaAppId(url) === id)) return null;
  return [`--app-id=${id}`, ...(profile ? [`--profile-directory=${profile}`] : [])];
}

function list(folder) {
  try { return readdirSync(folder).sort(); } catch { return []; }
}
function inside(file, folder) {
  try { return realpathSync(file).startsWith(realpathSync(folder) + sep); } catch { return false; }
}
function smallFile(file) {
  try { return statSync(file).size <= 1024 * 1024; } catch { return false; }
}
function appName(name) { return /^synabun(?:\.app|\.lnk)?$/i.test(String(name || '')); }

function plistUrls(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    ['CrAppModeShortcutURL', 'LSWebApplicationURL', 'WebAppURL', 'WebsiteURL', 'URL', 'start_url', 'manifestId'].includes(key)
      && typeof item === 'string' ? [item] : plistUrls(item));
}

export function macPwa(plist, file, port) {
  if (!appName(plist.CFBundleDisplayName || plist.CFBundleName || basename(file))) return null;
  const bundleId = String(plist.CFBundleIdentifier || '');
  const safari = /^com\.apple\.Safari\.WebApp\./.test(bundleId);
  const chrome = /^(com\.google\.Chrome|com\.microsoft\.edgemac)\.app\./.test(bundleId);
  if (!(safari || chrome) || !plistUrls(plist).some(url => matchesPwaUrl(url, port, safari))) return null;
  if (chrome && !/^[a-p]{32}$/.test(plist.CrAppModeShortcutID || bundleId.split('.').pop())) return null;
  return { kind: safari ? 'Safari web app' : 'Chromium installed PWA', file: '/usr/bin/open', args: ['-a', file] };
}

function knownBrowsers(platform, env, home) {
  if (platform === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter(Boolean).flatMap(root => ['Google/Chrome/Application/chrome', 'Microsoft/Edge/Application/msedge']
        .flatMap(tail => [join(root, `${tail}.exe`), join(root, `${tail}_proxy.exe`)]));
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/google-chrome',
    '/opt/google/chrome/chrome', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge/msedge'];
}

export function browserPwa({ name, target, args }, port, allowed) {
  if (!appName(name) || !allowed.includes(target)) return null;
  const safe = chromiumShortcut(Array.isArray(args) ? args : shortcutArgs(args), port);
  return safe ? { kind: 'Chromium installed PWA', file: target, args: safe } : null;
}

export function linuxPwa(text, port, allowed) {
  const section = String(text).split('[Desktop Entry]')[1]?.split(/\n\[/)[0];
  if (!section) return null;
  const values = Object.fromEntries(section.split(/\r?\n/).map(line => line.match(/^([\w-]+)=(.*)$/))
    .filter(Boolean).map(match => [match[1], match[2]]));
  if (values.Type !== 'Application' || values.Hidden === 'true' || values.Terminal === 'true') return null;
  // Desktop-entry strings escape backslashes once before the Exec quoting layer.
  const [target, ...args] = shortcutArgs(String(values.Exec || '').replace(/\\\\/g, '\\'));
  return browserPwa({ name: values.Name, target, args }, port, allowed);
}

/** Scan only app bundles or browser-generated application shortcuts bearing SynaBun's name. */
export function findInstalledPwa({ port, platform = process.platform, home = homedir(), env = process.env,
  run = spawnSync } = {}) {
  if (platform === 'darwin') {
    const roots = [join(home, 'Applications'), join(home, 'Applications', 'Chrome Apps.localized'),
      join(home, 'Applications', 'Edge Apps.localized'), '/Applications/Chrome Apps.localized', '/Applications/Edge Apps.localized'];
    for (const root of roots) for (const name of list(root).filter(name => /^synabun\.app$/i.test(name))) {
      const file = join(root, name), info = join(file, 'Contents', 'Info.plist');
      if (!inside(file, root) || !smallFile(info)) continue;
      const result = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
      try { const app = macPwa(JSON.parse(result.stdout), file, port); if (app) return app; } catch {}
    }
    return null;
  }
  const allowed = knownBrowsers(platform, env, home).filter(existsSync);
  if (platform === 'linux') {
    const roots = [join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'applications'), '/usr/share/applications'];
    for (const root of roots) for (const name of list(root).filter(name => /^(?:chrome|msedge)-[a-p]{32}-.+\.desktop$/.test(name))) {
      // Only the app IDs for this exact loopback origin, before reading any entry.
      if (!pwaOrigins(port).some(url => name.includes(pwaAppId(url)))) continue;
      const file = join(root, name);
      if (!inside(file, root) || !smallFile(file)) continue;
      try { const app = linuxPwa(readFileSync(file, 'utf8'), port, allowed); if (app) return app; } catch {}
    }
    return null;
  }
  if (platform === 'win32') {
    // WScript reads only SynaBun.lnk in these application folders. It never executes a link.
    const roots = [env.APPDATA && join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), join(home, 'Desktop')].filter(Boolean);
    const links = roots.flatMap(root => [root, join(root, 'Chrome Apps'), join(root, 'Edge Apps')])
      .flatMap(root => list(root).filter(name => /^synabun\.lnk$/i.test(name)).map(name => join(root, name)))
      .filter(file => smallFile(file));
    if (!links.length) return null;
    const script = "$w=New-Object -ComObject WScript.Shell; $r=@(); foreach($p in (ConvertFrom-Json $env:SYNABUN_PWA_LINKS)) { $s=$w.CreateShortcut($p); $r+=@{name='SynaBun';target=$s.TargetPath;args=$s.Arguments} }; ConvertTo-Json -Compress -InputObject @($r)";
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...env, SYNABUN_PWA_LINKS: JSON.stringify(links) },
    });
    try {
      for (const item of JSON.parse(result.stdout.replace(/^\uFEFF/, ''))) {
        // Windows paths are case-insensitive, but must still be a known installed browser.
        const target = allowed.find(path => path.toLowerCase() === String(item.target).toLowerCase());
        const app = target && browserPwa({ ...item, target }, port, allowed);
        if (app) return app;
      }
    } catch {}
  }
  return null;
}

export async function openDesktopPwa({ port, env = process.env, platform = process.platform,
  find = findInstalledPwa, spawnImpl = spawn } = {}) {
  if (env.SYNABUN_OPEN_BROWSER === '0') return { kind: 'suppressed' };
  const installed = find({ port, env, platform });
  const url = `http://localhost:${port}/install-app.html`;
  const fallback = platform === 'win32'
    ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
    : platform === 'darwin' ? { file: '/usr/bin/open', args: [url] } : { file: 'xdg-open', args: [url] };
  const launch = choice => new Promise((done, reject) => {
    const child = spawnImpl(choice.file, choice.args, { env, stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); done(); });
  });
  if (installed) {
    try { await launch(installed); return { kind: installed.kind }; } catch {}
  }
  await launch(fallback);
  return { kind: 'one-time browser installation', url };
}

/** A re-executed AppImage owns a fresh mount for the entire supervisor lifetime. */
export function backgroundCommand(runtime, env) {
  if (!runtime?.entry) throw new Error('the installed launcher is missing');
  const next = { ...env, SYNABUN_OPEN_BROWSER: '0', SYNABUN_LAUNCH_ENV: 'resolved' };
  const image = runtime.artifact === 'linux-appdir' && env.APPIMAGE;
  if (image) {
    const mount = String(env.APPDIR || '').replace(/\/+$/, '');
    if (mount && next.PATH) next.PATH = next.PATH.split(':').filter(path => path !== mount && !path.startsWith(`${mount}/`)).join(':');
    for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete next[key];
  }
  // The first image may unmount after handoff. No cwd or PATH of the fresh
  // runtime may depend on it; the launcher has already created the data home.
  return { file: runtime.entry, args: ['background-server'], env: next,
    cwd: image ? (next.SYNABUN_DATA_HOME || dirname(runtime.entry)) : undefined };
}

/** A port occupant prevents duplicates; only SynaBun's healthy API permits a PWA handoff. */
export async function pwaServerReady(port, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const data = await response.json();
    return data.ok === true && data.storage === 'sqlite' && typeof data.projectDir === 'string' && !!data.startLauncher;
  } catch { return false; }
}
