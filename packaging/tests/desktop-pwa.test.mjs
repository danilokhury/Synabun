import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backgroundCommand, browserPwa, chromiumShortcut, findInstalledPwa, linuxPwa, macPwa,
  matchesPwaUrl, openDesktopPwa, pwaAppId, pwaServerReady, shortcutArgs } from '../../lib/desktop-pwa.js';
import { runLauncher } from '../../lib/start-launcher.js';
import { initPwaInstall, isStandalone, requestPwaInstall } from '../../neural-interface/public/shared/pwa-install.js';

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
