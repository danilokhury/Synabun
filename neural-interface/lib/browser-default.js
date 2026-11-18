// The owner's default browser and the Chromium browsers installed on this computer, for the extension's one-button
// setup (Settings → Browser → "Connect your browser", docs/browser-extension-bridge.md → One-button setup).
//
// Nothing here touches the system by itself: every read goes through the injected `run(cmd, args)` (a program and its
// arguments, never a shell), `exists(path)` and `list(dir)`, so tests feed fixtures and never read the real registry,
// LaunchServices database or desktop files. `launchPlan` / `revealPlan` say which program SynaBun starts, with which
// arguments; nothing here starts it. The server runs a plan with execFile (no shell; lib/browser-extension-setup.js).
//
// Supported: the Chromium browsers that load an unpacked Manifest V3 extension (Chrome, Edge, Brave, Arc, Vivaldi,
// Opera, Chromium). Safari and Firefox are named as the default when they are, with `supported: false`, so the page can
// offer an installed Chromium browser instead.
import { join } from 'node:path';

/** Every browser SynaBun can name, with how each operating system spells it. */
export const BROWSERS = Object.freeze({
  chrome: { id: 'chrome', name: 'Google Chrome', supported: true, extensionsUrl: 'chrome://extensions',
    mac: { bundleIds: ['com.google.chrome', 'com.google.chrome.beta', 'com.google.chrome.dev', 'com.google.chrome.canary'], apps: ['Google Chrome.app', 'Google Chrome Beta.app', 'Google Chrome Dev.app', 'Google Chrome Canary.app'] },
    win: { progId: /^Chrome(HTML|BHTML|DHTML|SSHTM)\b/i, client: /^Google Chrome/i },
    linux: { desktop: ['google-chrome.desktop', 'google-chrome-stable.desktop', 'google-chrome-beta.desktop', 'google-chrome-unstable.desktop', 'com.google.Chrome.desktop'] } },
  edge: { id: 'edge', name: 'Microsoft Edge', supported: true, extensionsUrl: 'edge://extensions',
    mac: { bundleIds: ['com.microsoft.edgemac', 'com.microsoft.edgemac.beta', 'com.microsoft.edgemac.dev', 'com.microsoft.edgemac.canary'], apps: ['Microsoft Edge.app', 'Microsoft Edge Beta.app', 'Microsoft Edge Dev.app', 'Microsoft Edge Canary.app'] },
    win: { progId: /^MSEdge(HTM|BHTML|DHTML|CHTML)\b/i, client: /^Microsoft Edge/i },
    linux: { desktop: ['microsoft-edge.desktop', 'microsoft-edge-stable.desktop', 'microsoft-edge-beta.desktop', 'microsoft-edge-dev.desktop', 'com.microsoft.Edge.desktop'] } },
  brave: { id: 'brave', name: 'Brave', supported: true, extensionsUrl: 'brave://extensions',
    mac: { bundleIds: ['com.brave.browser', 'com.brave.browser.beta', 'com.brave.browser.nightly'], apps: ['Brave Browser.app', 'Brave Browser Beta.app', 'Brave Browser Nightly.app'] },
    win: { progId: /^Brave(HTML|BHTML|DHTML|SSHTM)\b/i, client: /^Brave/i },
    linux: { desktop: ['brave-browser.desktop', 'brave-browser-beta.desktop', 'brave-browser-nightly.desktop', 'com.brave.Browser.desktop', 'brave_brave.desktop'] } },
  arc: { id: 'arc', name: 'Arc', supported: true, extensionsUrl: 'arc://extensions',
    mac: { bundleIds: ['company.thebrowser.browser'], apps: ['Arc.app'] },
    win: { progId: /^Arc/i, client: /^Arc\b/i },
    linux: { desktop: [] } },
  vivaldi: { id: 'vivaldi', name: 'Vivaldi', supported: true, extensionsUrl: 'vivaldi://extensions',
    mac: { bundleIds: ['com.vivaldi.vivaldi', 'com.vivaldi.vivaldi.snapshot'], apps: ['Vivaldi.app', 'Vivaldi Snapshot.app'] },
    win: { progId: /^VivaldiHTM/i, client: /^Vivaldi/i },
    linux: { desktop: ['vivaldi-stable.desktop', 'vivaldi.desktop', 'vivaldi-snapshot.desktop', 'com.vivaldi.Vivaldi.desktop', 'vivaldi_vivaldi-stable.desktop'] } },
  opera: { id: 'opera', name: 'Opera', supported: true, extensionsUrl: 'opera://extensions',
    mac: { bundleIds: ['com.operasoftware.opera', 'com.operasoftware.operagx', 'com.operasoftware.operanext'], apps: ['Opera.app', 'Opera GX.app', 'Opera Beta.app'] },
    win: { progId: /^Opera(GX)?(Stable|Beta|Developer)\b/i, client: /^Opera/i },
    linux: { desktop: ['opera.desktop', 'opera-beta.desktop', 'opera-developer.desktop', 'com.opera.Opera.desktop', 'opera_opera.desktop'] } },
  chromium: { id: 'chromium', name: 'Chromium', supported: true, extensionsUrl: 'chrome://extensions',
    mac: { bundleIds: ['org.chromium.chromium'], apps: ['Chromium.app'] },
    win: { progId: /^ChromiumHTM/i, client: /^Chromium/i },
    linux: { desktop: ['chromium.desktop', 'chromium-browser.desktop', 'org.chromium.Chromium.desktop', 'chromium_chromium.desktop'] } },
  safari: { id: 'safari', name: 'Safari', supported: false, extensionsUrl: null,
    mac: { bundleIds: ['com.apple.safari', 'com.apple.safaritechnologypreview'], apps: [] }, win: { progId: /^$/, client: /^$/ }, linux: { desktop: [] } },
  firefox: { id: 'firefox', name: 'Firefox', supported: false, extensionsUrl: null,
    mac: { bundleIds: ['org.mozilla.firefox', 'org.mozilla.firefoxdeveloperedition', 'org.mozilla.nightly'], apps: [] },
    win: { progId: /^Firefox(URL|HTML)/i, client: /^Firefox/i },
    linux: { desktop: ['firefox.desktop', 'firefox-esr.desktop', 'org.mozilla.firefox.desktop', 'firefox_firefox.desktop'] } },
});
/** The ids an owner may pick ("open in X instead"): the supported ones. */
export const SUPPORTED_BROWSER_IDS = Object.freeze(Object.values(BROWSERS).filter(b => b.supported).map(b => b.id));

const MAC_PLIST = ['Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist'];
const WIN_USER_CHOICE = scheme => `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`;
const WIN_CLIENT_ROOTS = ['HKCU\\Software\\Clients\\StartMenuInternet', 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet'];
const LINUX_DIRS = home => ['/usr/share/applications', '/usr/local/share/applications', join(home, '.local/share/applications'),
  '/var/lib/flatpak/exports/share/applications', join(home, '.local/share/flatpak/exports/share/applications'), '/var/lib/snapd/desktop/applications'];

const describe = (browser, extra = {}) => ({ id: browser.id, name: browser.name, supported: browser.supported, extensionsUrl: browser.extensionsUrl, ...extra });
const unknown = raw => ({ id: 'unknown', name: raw ? String(raw).slice(0, 80) : 'Unknown browser', supported: false, extensionsUrl: null, raw: raw ? String(raw).slice(0, 200) : null });
const byBundleId = bundleId => Object.values(BROWSERS).find(b => b.mac.bundleIds.includes(String(bundleId || '').toLowerCase()));
const byProgId = progId => Object.values(BROWSERS).find(b => b.win.progId.test(String(progId || '')));
const byDesktop = id => Object.values(BROWSERS).find(b => b.linux.desktop.includes(String(id || '').trim()));

// ── macOS ──
/** The http(s) handler in a LaunchServices LSHandlers list (JSON from plutil). Https first; none means Safari. */
export function macHandlerFromJson(text) {
  let list; try { list = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(list)) return null;
  for (const scheme of ['https', 'http']) {
    const entry = list.find(e => e && typeof e === 'object' && String(e.LSHandlerURLScheme || '').toLowerCase() === scheme && typeof e.LSHandlerRoleAll === 'string');
    if (entry) return entry.LSHandlerRoleAll.toLowerCase();
  }
  return null;
}
/** The same from plutil's XML (a plist with a date or data value cannot become JSON). */
export function macHandlerFromXml(text) {
  const dicts = String(text || '').match(/<dict>[\s\S]*?<\/dict>/g) || [];
  const value = (dict, key) => dict.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
  for (const scheme of ['https', 'http']) {
    const dict = dicts.find(d => String(value(d, 'LSHandlerURLScheme') || '').toLowerCase() === scheme && value(d, 'LSHandlerRoleAll'));
    if (dict) return value(dict, 'LSHandlerRoleAll').toLowerCase();
  }
  return null;
}
async function macDefault({ run, home }) {
  const plist = join(home, ...MAC_PLIST);
  let bundleId = null;
  try { bundleId = macHandlerFromJson((await run('plutil', ['-extract', 'LSHandlers', 'json', '-o', '-', plist])).stdout); } catch {}
  if (!bundleId) { try { bundleId = macHandlerFromXml((await run('plutil', ['-extract', 'LSHandlers', 'xml1', '-o', '-', plist])).stdout); } catch {} }
  // No handler recorded: macOS opens web links in Safari.
  if (!bundleId) return describe(BROWSERS.safari, { raw: 'com.apple.safari' });
  const browser = byBundleId(bundleId);
  return browser ? describe(browser, { raw: bundleId, launch: { bundleId } }) : unknown(bundleId);
}
function macInstalled({ exists, home }) {
  const found = [];
  for (const browser of Object.values(BROWSERS)) {
    if (!browser.supported) continue;
    browser.mac.apps.some((app, i) => {
      const path = [join('/Applications', app), join(home, 'Applications', app)].find(p => exists(p));
      if (path) found.push(describe(browser, { launch: { bundleId: browser.mac.bundleIds[i] || browser.mac.bundleIds[0] }, path }));
      return !!path;
    });
  }
  return found;
}

// ── Windows ──
/** The value of `name` in `reg query … /v name` output (REG_SZ / REG_EXPAND_SZ). */
export function regValue(text, name) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s+(\S.*?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.*?)\s*$/);
    if (match && match[1].toLowerCase() === String(name).toLowerCase()) return match[2];
  }
  return null;
}
/** The subkey names under `root` in `reg query <root>` output. */
export function regSubkeys(text, root) {
  const prefix = `${root}\\`.toLowerCase();
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.toLowerCase().startsWith(prefix)).map(l => l.slice(prefix.length)).filter(n => n && !n.includes('\\'));
}
/** The program in a shell\open\command value: `"C:\…\chrome.exe" --flag "%1"` → `C:\…\chrome.exe`. */
export function commandProgram(value) {
  const text = String(value || '').trim();
  const quoted = text.match(/^"([^"]+)"/);
  const program = quoted ? quoted[1] : text.split(/\s+/)[0];
  return /\.exe$/i.test(program || '') ? program : null;
}
async function winDefault({ run }) {
  let progId = null;
  for (const scheme of ['https', 'http']) {
    try { progId = regValue((await run('reg', ['query', WIN_USER_CHOICE(scheme), '/v', 'ProgId'])).stdout, 'ProgId'); } catch {}
    if (progId) break;
  }
  if (!progId) return unknown(null);
  const browser = byProgId(progId);
  return browser ? describe(browser, { raw: progId }) : unknown(progId);
}
async function winInstalled({ run }) {
  const found = new Map();
  for (const root of WIN_CLIENT_ROOTS) {
    let names = [];
    try { names = regSubkeys((await run('reg', ['query', root])).stdout, root); } catch { continue; }
    for (const name of names) {
      const browser = Object.values(BROWSERS).find(b => b.supported && b.win.client.test(name));
      if (!browser || found.has(browser.id)) continue;
      let exe = null;
      try { exe = commandProgram(regValue((await run('reg', ['query', `${root}\\${name}\\shell\\open\\command`, '/ve'])).stdout, '(Default)')); } catch {}
      if (exe) found.set(browser.id, describe(browser, { launch: { exe } }));
    }
  }
  return [...found.values()];
}

// ── Linux ──
async function linuxDefault({ run }) {
  let id = null;
  try { id = String((await run('xdg-settings', ['get', 'default-web-browser'])).stdout || '').trim(); } catch {}
  if (!id) return unknown(null);
  const browser = byDesktop(id);
  return browser ? describe(browser, { raw: id }) : unknown(id);
}
function linuxInstalled({ list, home }) {
  const found = new Map();
  for (const dir of LINUX_DIRS(home)) {
    let names = [];
    try { names = list(dir) || []; } catch { continue; }
    for (const name of names) {
      const browser = byDesktop(name);
      if (browser?.supported && !found.has(browser.id)) found.set(browser.id, describe(browser, { launch: { desktopFile: join(dir, name) } }));
    }
  }
  return [...found.values()];
}

/**
 * { browser, installedBrowsers }: the default browser (`supported` false for Safari, Firefox and anything unknown) and
 * the supported browsers found installed. The default, when supported and installed, carries the installed entry's
 * `launch`. Never throws: a read that fails is an unknown default or a browser not listed.
 */
export async function detectBrowsers({ platform = process.platform, home, run, exists = () => false, list = () => [] } = {}) {
  let browser, installed;
  if (platform === 'darwin') { browser = await macDefault({ run, home }); installed = macInstalled({ exists, home }); }
  else if (platform === 'win32') { browser = await winDefault({ run }); installed = await winInstalled({ run }); }
  else { browser = await linuxDefault({ run }); installed = linuxInstalled({ list, home }); }
  const match = installed.find(b => b.id === browser.id);
  if (match) browser = { ...browser, launch: browser.launch || match.launch };
  return { browser, installedBrowsers: installed };
}

/**
 * The program and arguments that open `url` (http(s) only) in `browser` (its `launch`), or in the system's default
 * browser when `browser` has none. Never a shell: every value is one argument.
 */
export function launchPlan(platform, browser, url) {
  if (!/^https?:\/\/[^\s"<>]+$/.test(String(url || ''))) throw Object.assign(new Error('Only an http(s) address is opened.'), { code: 'INVALID_MESSAGE' });
  const launch = browser?.launch || {};
  if (platform === 'darwin') return launch.bundleId ? { cmd: 'open', args: ['-b', launch.bundleId, url] } : { cmd: 'open', args: [url] };
  if (platform === 'win32') return launch.exe ? { cmd: launch.exe, args: [url] } : { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  return launch.desktopFile ? { cmd: 'gio', args: ['launch', launch.desktopFile, url] } : { cmd: 'xdg-open', args: [url] };
}
/** The program and arguments that show `folder` in Finder, Explorer or the file manager. */
export function revealPlan(platform, folder) {
  if (typeof folder !== 'string' || !folder || /[\r\n\0]/.test(folder)) throw Object.assign(new Error('No folder to show.'), { code: 'INVALID_MESSAGE' });
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', folder] };
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [`/select,${folder}`] };
  return { cmd: 'xdg-open', args: [folder] };
}
