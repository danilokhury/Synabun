import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backgroundCommand, browserPwa, chromiumShortcut, findInstalledPwa, linuxPwa, macPwa,
  matchesPwaUrl, openDesktopPwa, pwaAppId, pwaServerReady, shortcutArgs } from '../../lib/desktop-pwa.js';
import { runLauncher } from '../../lib/start-launcher.js';
import { armPwaInstallHandoff, canPromptPwaInstall, initPwaInstall, installGuideMode, installGuideRequested,
  installGuideUrl, isStandalone, leavePwaInstallHandoff, offerPwaInstallOnce,
  requestPwaInstall } from '../../neural-interface/public/shared/pwa-install.js';

const port = 39876, id = pwaAppId(`http://localhost:${port}/`);
const args = [`--profile-directory=Profile 1`, `--app-id=${id}`];

test('installed Chromium shortcuts are bound to this loopback origin and never app mode', () => {
  assert.match(id, /^[a-p]{32}$/);
  assert.deepEqual(shortcutArgs(`--profile-directory="Profile 1" --app-id=${id}`), args);
  assert.deepEqual(chromiumShortcut(args, port), [`--app-id=${id}`, '--profile-directory=Profile 1']);
  for (const invalid of [args.concat('--app=http://localhost:39876'), args.concat('--load-extension=/tmp/x'),
    args.concat('$(touch owned)'), [`--app-id=${pwaAppId('http://localhost:3344/')}`], ['--app=http://localhost:39876/'],
    [`--app-id=${id}`, '--profile-directory=../../secrets']]) assert.equal(chromiumShortcut(invalid, port), null);
  assert.equal(matchesPwaUrl('http://localhost:39876/', port), true);
  for (const url of ['https://localhost:39876/', 'http://remote:39876/', 'http://localhost:3344/', 'http://user@localhost:39876/',
    'http://localhost:39876/unrelated', 'http://localhost:39876/?x=1']) assert.equal(matchesPwaUrl(url, port), false);
});

test('macOS checks both browser bundle identity and URL, including Safari first-run Add to Dock', () => {
  const base = { CFBundleName: 'SynaBun', CFBundleIdentifier: 'com.apple.Safari.WebApp.fixture',
    LSTemplateApplicationParameters: { LSWebApplicationURL: `http://localhost:${port}/install-app.html` } };
  assert.deepEqual(macPwa(base, '/fixture/SynaBun.app', port)?.args, ['-a', '/fixture/SynaBun.app']);
  assert.equal(macPwa({ ...base, CFBundleIdentifier: 'ai.synabun.app' }, '/fixture/SynaBun.app', port), null);
  assert.equal(macPwa(base, '/fixture/SynaBun.app', 3344), null);
  const safariManifest = { CFBundleName: 'SynaBun', CFBundleIdentifier: 'com.apple.Safari.WebApp.fixture',
    WKPushBundleMetadata: { manifestId: `http://localhost:${port}/` }, Manifest: { start_url: `http://localhost:${port}/` } };
  assert.equal(macPwa(safariManifest, '/fixture/SynaBun.app', port)?.kind, 'Safari web app');
  const chrome = { CFBundleName: 'SynaBun', CFBundleIdentifier: `com.google.Chrome.app.${id}`,
    CrAppModeShortcutID: id, CrAppModeShortcutURL: `http://localhost:${port}/` };
  assert.equal(macPwa(chrome, '/fixture/SynaBun.app', port)?.kind, 'Chromium installed PWA');
});

test('Linux and Windows shortcut parsers launch only allowlisted browser paths and installed app IDs', () => {
  const target = '/usr/bin/google-chrome';
  const text = `[Desktop Entry]\nType=Application\nName=SynaBun\nTerminal=false\nExec=${target} --profile-directory="Profile 1" --app-id=${id}\n`;
  assert.deepEqual(linuxPwa(text, port, [target])?.args, [`--app-id=${id}`, '--profile-directory=Profile 1']);
  for (const bad of [text.replace(target, '/tmp/arbitrary'), text.replace('Terminal=false', 'Terminal=true'),
    text.replace('Name=SynaBun', 'Name=Other'), text.replace(`--app-id=${id}`, '--app=http://localhost:39876/')])
    assert.equal(linuxPwa(bad, port, [target]), null);
  assert.equal(browserPwa({ name: 'SynaBun', target, args }, port, [target])?.file, target);
  assert.equal(browserPwa({ name: 'SynaBun', target: '/tmp/evil', args }, port, [target]), null);
});

test('background AppImage start uses the original executable with a fresh mount environment', () => {
  const command = backgroundCommand({ entry: '/home/user/SynaBun.AppImage', artifact: 'linux-appdir' },
    { APPIMAGE: '/home/user/SynaBun.AppImage', APPDIR: '/tmp/.mount_old', ARGV0: 'old', OWD: '/old',
      SYNABUN_DATA_HOME: '/home/user/.synabun', PATH: '/tmp/.mount_old/usr/lib/synabun/runtime/bin:/usr/bin', CUSTOM: 'kept' });
  assert.equal(command.file, '/home/user/SynaBun.AppImage');
  assert.deepEqual(command.args, ['background-server']);
  assert.equal(command.env.APPDIR, undefined);
  assert.equal(command.env.APPIMAGE, undefined);
  assert.equal(command.cwd, '/home/user/.synabun', 'fresh mount starts outside the old image');
  assert.equal(command.env.PATH, '/usr/bin', 'no stale mount path survives');
  assert.equal(command.env.CUSTOM, 'kept');
  assert.equal(command.env.SYNABUN_OPEN_BROWSER, '0');
});

test('Windows background launch returns after health, uses hidden detached process and log handles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-desktop-'));
  mkdirSync(join(root, 'app')); writeFileSync(join(root, 'app', 'setup.js'), 'fixture');
  let up = false, seen;
  try {
    const result = await runLauncher({ platform: 'win32', packageRoot: join(root, 'app'),
      home: root, env: { SYNABUN_DATA_HOME: join(root, 'data'), NEURAL_PORT: String(port) },
      background: true, probe: async () => up, runShell: () => ({ status: 1 }),
      spawnImpl: (file, argv, options) => {
        seen = options; up = true;
        return Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
      } });
    assert.equal(result.outcome, 'started');
    assert.equal(seen.windowsHide, true); assert.equal(seen.detached, true);
    assert.equal(seen.stdio[0], 'ignore'); assert.equal(typeof seen.stdio[1], 'number');
    assert.equal(seen.env.SYNABUN_OPEN_BROWSER, '0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('handoff opens a real app shortcut, or the honest install route after missing/failed shortcut', async () => {
  const seen = [];
  const spawnImpl = (file, argv, options) => {
    seen.push({ file, argv, options });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    queueMicrotask(() => child.emit(file === '/missing' ? 'error' : 'spawn', new Error('missing')));
    return child;
  };
  const installed = { file: '/browser', args: [`--app-id=${id}`], kind: 'PWA' };
  assert.equal((await openDesktopPwa({ port, env: {}, platform: 'linux', find: () => installed, spawnImpl })).kind, 'PWA');
  assert.equal(seen[0].options.windowsHide, true);
  await openDesktopPwa({ port, env: {}, platform: 'linux', find: () => null, spawnImpl });
  assert.deepEqual(seen[1].argv, [`http://localhost:${port}/install-app.html`]);
  await openDesktopPwa({ port, env: {}, platform: 'linux', find: () => ({ ...installed, file: '/missing' }), spawnImpl });
  assert.equal(seen.at(-1).file, 'xdg-open');
  const count = seen.length;
  await openDesktopPwa({ port, env: { SYNABUN_OPEN_BROWSER: '0' }, find: () => installed, spawnImpl });
  assert.equal(seen.length, count);
});

test('an already resolved background environment keeps isolated CLI paths and never reads a login profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-desktop-env-'));
  mkdirSync(join(root, 'app')); writeFileSync(join(root, 'app', 'setup.js'), 'fixture');
  let up = false, seen, shellCalls = 0;
  try {
    await runLauncher({ platform: 'darwin', packageRoot: join(root, 'app'), home: root,
      env: { SYNABUN_DATA_HOME: join(root, 'data'), NEURAL_PORT: String(port),
        PATH: '/isolated/bin', SHELL: '/bin/bash', SYNABUN_LAUNCH_ENV: 'resolved' },
      background: true, probe: async () => up, runShell: () => { shellCalls++; throw new Error('must not read profile'); },
      spawnImpl: (file, argv, options) => {
        seen = options.env; up = true;
        return Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
      } });
    assert.equal(shellCalls, 0);
    assert.equal(seen.PATH, '/isolated/bin');
    assert.equal(seen.SYNABUN_OPEN_BROWSER, '0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readiness requires the SynaBun API, not any port occupant', async () => {
  const ready = data => pwaServerReady(port, { fetchImpl: async () => ({ ok: true, json: async () => data }) });
  assert.equal(await ready({ ok: true }), false);
  assert.equal(await ready({ ok: true, storage: 'sqlite', projectDir: '/app', startLauncher: {} }), true);
  assert.equal(await ready({ ok: false, storage: 'sqlite', projectDir: '/app', startLauncher: {} }), false);
});

test('one-time install flow waits for a user click and handles rejected single-use browser events', async () => {
  const events = {}, changes = [];
  const win = { addEventListener: (name, callback) => events[name] = callback, matchMedia: () => ({ matches: false }) };
  initPwaInstall({ win, nav: {}, changed: value => changes.push(value) });
  let prompts = 0;
  events.beforeinstallprompt({ preventDefault() {}, prompt: async () => prompts++, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(prompts, 0);
  assert.equal(await requestPwaInstall(win), 'dismissed');
  assert.equal(prompts, 1); assert.equal(win._pwaInstallPrompt, null);
  assert.equal(await requestPwaInstall(win), 'instructions');
  events.appinstalled(); assert.equal(changes.at(-1), 'installed');
  assert.equal(isStandalone({ matchMedia: query => ({ matches: query.includes('window-controls-overlay') }) }, {}), true);
});

test('the wizard opens the browser dialog once, from a real click, and never waits or asks again', () => {
  const events = {}, saved = {};
  const win = { addEventListener: (name, callback) => events[name] = callback, matchMedia: () => ({ matches: false }),
    sessionStorage: { getItem: key => saved[key] ?? null, setItem: (key, value) => { saved[key] = value; } } };
  const nav = { userActivation: { isActive: true } };
  let prompts = 0;
  // Never settles: a wizard that waited for the answer would hang here.
  const arrive = () => events.beforeinstallprompt({ preventDefault() {}, prompt: () => { prompts++; return new Promise(() => {}); } });
  initPwaInstall({ win, nav });
  assert.equal(offerPwaInstallOnce({ win, nav }), false, 'no event yet: this click does nothing');
  arrive();
  assert.equal(offerPwaInstallOnce({ win, nav: { userActivation: { isActive: false } } }), false, 'a scripted click keeps the event');
  assert.equal(prompts, 0);
  assert.equal(offerPwaInstallOnce({ win, nav }), true, 'the next click of the user opens it');
  assert.equal(prompts, 1); assert.equal(win._pwaInstallPrompt, null);
  arrive();
  assert.equal(offerPwaInstallOnce({ win, nav }), false, 'dismissed or not, never a second dialog');
  // A reload of the wizard in the same tab: a new window object, the same sessionStorage.
  const reloaded = { ...win, _pwaInstallOffered: false, _pwaInstallPrompt: { prompt: () => prompts++ } };
  assert.equal(offerPwaInstallOnce({ win: reloaded, nav }), false);
  assert.equal(prompts, 1);
  // Already the installed app: nothing, even with an event in hand.
  const app = { matchMedia: () => ({ matches: true }), _pwaInstallPrompt: { prompt: () => prompts++ } };
  assert.equal(offerPwaInstallOnce({ win: app, nav }), false);
  // An event the browser refuses is spent, and no storage at all is not an error.
  const refused = { matchMedia: () => ({ matches: false }), _pwaInstallPrompt: { prompt: () => { throw new Error('InvalidStateError'); } } };
  assert.equal(offerPwaInstallOnce({ win: refused, nav: {} }), false);
  assert.equal(refused._pwaInstallPrompt, null);
  assert.equal(prompts, 1);

  // The launcher's guide page: in Chrome or Edge it leaves for the wizard (first run) or the main UI (setup
  // done), and shows its button only when asked for or when the setup read did not answer.
  assert.equal(canPromptPwaInstall({ onbeforeinstallprompt: null }), true);
  assert.equal(canPromptPwaInstall({}), false);
  assert.equal(installGuideMode({ standalone: true, canPrompt: true, setupComplete: false }), 'app');
  assert.equal(installGuideMode({ canPrompt: true, setupComplete: false }), 'wizard');
  assert.equal(installGuideMode({ canPrompt: true, setupComplete: false, requested: true }), 'wizard');
  assert.equal(installGuideMode({ canPrompt: true, setupComplete: true }), 'handoff');
  assert.equal(installGuideMode({ canPrompt: true, setupComplete: true, requested: true }), 'button');
  assert.equal(installGuideMode({ canPrompt: true }), 'button', 'an unanswered setup read keeps the guide');
  assert.equal(installGuideMode({ setupComplete: false, vendor: 'Apple Computer, Inc.' }), 'safari');
  assert.equal(installGuideMode({ setupComplete: true, vendor: 'Apple Computer, Inc.' }), 'safari');
  assert.equal(installGuideMode({ setupComplete: false, vendor: '' }), 'other');
  // Only the Apps menu marks the page as asked for, and only where there is an install event: Safari adds
  // the page it is on to the Dock, and the launcher matches that URL without a query.
  assert.equal(installGuideUrl({ onbeforeinstallprompt: null }), '/install-app.html?from=menu');
  assert.equal(installGuideRequested('?from=menu'), true);
  assert.equal(installGuideRequested(''), false);
  assert.equal(matchesPwaUrl(`http://localhost:${port}${installGuideUrl({})}`, port, true), true);
});

test('the guide hands over to the main UI, which opens the dialog from one press of that page load only', () => {
  const saved = {};
  const sessionStorage = { getItem: key => saved[key] ?? null, setItem: (key, value) => { saved[key] = value; },
    removeItem: key => { delete saved[key]; } };
  // One page load in the tab: a new window object, the same sessionStorage.
  const load = () => {
    const listeners = {};
    return { listeners, sessionStorage, matchMedia: () => ({ matches: false }),
      addEventListener: (type, callback, capture) => { if (capture) listeners[type] = callback; },
      removeEventListener: (type, callback) => { if (listeners[type] === callback) delete listeners[type]; } };
  };
  const nav = { userActivation: { isActive: true } }, plain = { target: { closest: () => null } };
  let prompts = 0;
  const arrive = win => { win._pwaInstallPrompt = { prompt: () => { prompts++; return new Promise(() => {}); } }; };

  const normal = load();
  arrive(normal);
  armPwaInstallHandoff({ win: normal, nav });
  assert.deepEqual(normal.listeners, {}, 'a normal tab never listens: no stray click opens the dialog');

  assert.equal(leavePwaInstallHandoff({ sessionStorage }), true);
  const win = load(), item = {};
  armPwaInstallHandoff({ win, nav, leave: event => event.target === item });
  assert.deepEqual(Object.keys(win.listeners).sort(), ['click', 'keydown']);
  const reloaded = load();
  arrive(reloaded);
  armPwaInstallHandoff({ win: reloaded, nav });
  assert.deepEqual(reloaded.listeners, {}, 'the mark is taken once: a reload is not armed');

  win.listeners.click(plain);
  assert.equal(prompts, 0, 'no event yet: this press does nothing');
  arrive(win);
  win.listeners.click({ target: { closest: selector => selector === 'a[href]' ? {} : null } });
  win.listeners.keydown({ ...plain, key: 'r', metaKey: true });
  win.listeners.keydown({ ...plain, key: 'F5' });
  win.listeners.click({ target: item });
  assert.equal(prompts, 0, 'a link, a shortcut and the menu item keep their press');
  nav.userActivation.isActive = false;
  win.listeners.click(plain);
  assert.equal(prompts, 0, 'a scripted click keeps the event');
  nav.userActivation.isActive = true;
  win.listeners.keydown({ ...plain, key: 'a' });
  assert.equal(prompts, 1); assert.equal(win._pwaInstallPrompt, null, 'spent: the menu item goes to the guide page');
  assert.deepEqual(win.listeners, {}, 'one dialog: nothing listens after it');

  // Apps > Install as App before any dialog: the menu takes over and the handoff stands down.
  const other = {}, asked = load();
  asked.sessionStorage = { getItem: key => other[key] ?? null, setItem: (key, value) => { other[key] = value; },
    removeItem: key => { delete other[key]; } };
  leavePwaInstallHandoff(asked);
  armPwaInstallHandoff({ win: asked, nav })();
  assert.deepEqual(asked.listeners, {});
  // No storage to leave the mark in: the guide page keeps its button.
  assert.equal(leavePwaInstallHandoff({ sessionStorage: { setItem() { throw new Error('denied'); } } }), false);
});
