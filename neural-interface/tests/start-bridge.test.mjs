// Run with: node --test tests/start-bridge.test.mjs
// The Start Server button, page side: the bridge shared by the offline page
// and the in-app loading overlay, the commands offered instead, and the
// offline page exactly as the server renders it — its scripts run here against
// a stand-in DOM with the server "down".
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  START_BEACON_PATH, START_COPY, START_LIMITS, START_LINK, START_STORAGE, createStartBridge, fetchStartBeacon,
  formatStartElapsed, formatStartText, isMacPlatform, isWindowsPlatform,
  manualStartCommands, openStartLink, packagedStartCommand, quoteShellPath, readStartBeacon, startBeaconPort, startBeaconTarget,
  startButtonUsable, startLinkMode, startStatusView,
} from '../public/shared/start-bridge.js';
import { OFFLINE_SLOTS, moduleToClassicScript, renderOfflinePage, scriptJson } from '../lib/offline-page.js';

process.env.SYNABUN_TYPESAFE = 'off';

const NI = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(NI, path), 'utf8');
const BRIDGE_SOURCE = read('public/shared/start-bridge.js');
const OFFLINE_TEMPLATE = read('public/offline.html');

const UA = {
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { pending.delete(id); },
    /** Run every timer due within `ms`, letting async callbacks settle in between. */
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        for (let i = 0; i < 40; i++) await Promise.resolve();
      }
      now = until;
    },
    get size() { return pending.size; },
  };
}

// ── The commands offered instead ──

test('one command per install, written to work in any shell', () => {
  assert.deepEqual(manualStartCommands({ projectDir: '/Users/me/Apps/Synabun', install: 'git', windows: false }),
    [{ id: 'git', command: 'npm --prefix /Users/me/Apps/Synabun start' }]);
  assert.deepEqual(manualStartCommands({ projectDir: '/usr/local/lib/node_modules/synabun', install: 'npm', windows: false }),
    [{ id: 'npm', command: 'synabun' }]);
  // Not known (an older cached page): both, the global command first.
  assert.deepEqual(manualStartCommands({ projectDir: '/x', windows: false }).map(c => c.id), ['npm', 'git']);
  assert.deepEqual(manualStartCommands({}), [{ id: 'npm', command: 'synabun' }]);

  for (const { command } of manualStartCommands({ projectDir: 'C:\\Users\\Ana Maria\\synabun', install: 'git', windows: true })) {
    assert.equal(command, 'npm --prefix "C:\\Users\\Ana Maria\\synabun" start');
    // The old `cd "…" & npm start` failed in PowerShell and did not change drive in cmd.exe.
    assert.doesNotMatch(command, /\bcd\b|[;&]/);
  }
});

test('a packaged application is started through its own executable', () => {
  const mac = '/Applications/SynaBun.app/Contents/MacOS/SynaBun';
  // Neither npm nor a checkout: the person has no Node of their own.
  assert.deepEqual(manualStartCommands({ projectDir: '/Applications/SynaBun.app/Contents/Resources/app', install: 'app', entry: mac, windows: false }),
    [{ id: 'app', command: `${mac} start` }]);
  assert.equal(packagedStartCommand(`/Users/José Müller/My Apps/o'brien/SynaBun.app/Contents/MacOS/SynaBun`),
    `'/Users/José Müller/My Apps/o'\\''brien/SynaBun.app/Contents/MacOS/SynaBun' start`);
  assert.equal(packagedStartCommand('/home/me/Applications/SynaBun-2.0.0-x86_64.AppImage'), '/home/me/Applications/SynaBun-2.0.0-x86_64.AppImage start');

  // Windows: a plain path reads the same in cmd.exe and PowerShell, as Windows spells it.
  assert.equal(packagedStartCommand('C:/Users/ana/AppData/Local/Programs/SynaBun/SynaBun.exe'),
    'C:\\Users\\ana\\AppData\\Local\\Programs\\SynaBun\\SynaBun.exe start');
  // One that needs quotes: PowerShell does not run a quoted path by itself, cmd.exe has no `&` operator.
  const spaced = packagedStartCommand('C:\\Users\\Ana Maria\\AppData\\Local\\Programs\\SynaBun\\SynaBun.exe');
  assert.equal(spaced, 'cmd /c "C:\\Users\\Ana Maria\\AppData\\Local\\Programs\\SynaBun\\SynaBun.exe" start');
  assert.doesNotMatch(spaced, /^"|[;&]/);

  // The entry counts only for a packaged application, and only when it is known.
  assert.deepEqual(manualStartCommands({ projectDir: '/srv/synabun', install: 'git', entry: mac, windows: false }),
    [{ id: 'git', command: 'npm --prefix /srv/synabun start' }]);
  assert.deepEqual(manualStartCommands({ install: 'npm', entry: mac }), [{ id: 'npm', command: 'synabun' }]);
  assert.deepEqual(manualStartCommands({ projectDir: '/x', install: 'app', entry: '' }).map(c => c.id), ['npm', 'git']);
  assert.equal(START_STORAGE.entry, 'synabun-start-entry');
});

test('a path is one shell argument whatever is in it', () => {
  assert.equal(quoteShellPath('/Users/me/Apps/Synabun', false), '/Users/me/Apps/Synabun');
  assert.equal(quoteShellPath('/Users/me/My Apps/syna bun', false), `'/Users/me/My Apps/syna bun'`);
  assert.equal(quoteShellPath(`/Users/o'brien/s`, false), `'/Users/o'\\''brien/s'`);
  assert.equal(quoteShellPath('/opt/$HOME/`x`', false), "'/opt/$HOME/`x`'");
  assert.equal(quoteShellPath('C:\\Program Files\\synabun', true), '"C:\\Program Files\\synabun"');
});

test('platform and browser are read from the navigator', () => {
  assert.equal(isWindowsPlatform({ platform: 'Win32', userAgent: UA.chrome }), true);
  assert.equal(isWindowsPlatform({ userAgentData: { platform: 'Windows' } }), true);
  assert.equal(isWindowsPlatform({ platform: 'MacIntel', userAgent: UA.safari }), false);
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(isMacPlatform({ platform: 'Linux x86_64', userAgent: UA.firefox }), false);
  assert.equal(startLinkMode(UA.safari), 'top');
  assert.equal(startLinkMode(UA.chrome), 'top');
  assert.equal(startLinkMode(UA.firefox), 'frame', 'Firefox replaces the page when a top-level link has no handler');
});

test('the link is handed over from the top frame, or a hidden frame in Firefox', () => {
  const location = { href: 'http://localhost:3344/' };
  const appended = [];
  const document = { createElement: (tag) => ({ tag, style: {}, remove() {} }), body: { appendChild: (el) => appended.push(el) } };
  assert.equal(openStartLink({ document, location, userAgent: UA.safari }), 'top');
  assert.equal(location.href, START_LINK);
  assert.equal(appended.length, 0);

  location.href = 'http://localhost:3344/';
  assert.equal(openStartLink({ document, location, userAgent: UA.firefox }), 'frame');
  assert.equal(location.href, 'http://localhost:3344/', 'the page stays where it is');
  assert.deepEqual(appended.map(f => [f.tag, f.src, f.style.display]), [['iframe', START_LINK, 'none']]);
  assert.equal(START_LINK, 'synabun://start');
});

test('only a registration known to be missing takes the button away', () => {
  for (const state of ['registered', 'stale', 'skipped', '', null, undefined]) assert.equal(startButtonUsable(state), true, String(state));
  assert.equal(startButtonUsable('missing'), false);
});

// ── The button's life ──

function bridgeFixture({ up = () => false } = {}) {
  const clock = fakeClock();
  const states = [];
  let launches = 0;
  const bridge = createStartBridge({
    probe: async () => up(),
    launch: () => { launches++; },
    onState: (state, detail) => states.push([state, detail.clicks]),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { bridge, clock, states, launches: () => launches };
}

test('bridge: a click hands the link over once and the page reconnects when the server answers', async () => {
  let up = false;
  const { bridge, clock, states, launches } = bridgeFixture({ up: () => up });
  bridge.watch();
  assert.equal(bridge.start(), true);
  assert.equal(launches(), 1);
  assert.deepEqual(states, [['launching', 1]]);

  // Impatient clicks while it starts go nowhere: one prompt, one launch.
  assert.equal(bridge.start(), false);
  assert.equal(bridge.start(), false);
  assert.equal(launches(), 1);

  await clock.advance(3000);
  up = true;
  await clock.advance(START_LIMITS.pollMs);
  assert.deepEqual(states.at(-1), ['online', 1]);
  assert.equal(bridge.start(), false, 'nothing to start once it is up');
  assert.equal(clock.size, 0, 'no polling left behind');
});

test('bridge: no answer becomes a hint, then the button comes back', async () => {
  const { bridge, clock, states, launches } = bridgeFixture();
  bridge.start();
  await clock.advance(START_LIMITS.hintAfterMs - 1);
  assert.deepEqual(states.map(s => s[0]), ['launching']);
  await clock.advance(START_LIMITS.pollMs);
  assert.deepEqual(states.map(s => s[0]), ['launching', 'waiting']);
  await clock.advance(START_LIMITS.stallAfterMs);
  assert.deepEqual(states.map(s => s[0]), ['launching', 'waiting', 'stalled']);

  // Stalled is not the end: it keeps looking, and the button works again.
  assert.equal(bridge.start(), true);
  assert.equal(launches(), 2);
  assert.deepEqual(states.at(-1), ['launching', 2]);
});

test('bridge: a server started by hand is noticed without a click', async () => {
  let up = false;
  const { bridge, clock, states, launches } = bridgeFixture({ up: () => up });
  bridge.watch();
  await clock.advance(START_LIMITS.idlePollMs * 3);
  assert.deepEqual(states, []);
  up = true;
  await clock.advance(START_LIMITS.idlePollMs);
  assert.deepEqual(states, [['online', 0]]);
  assert.equal(launches(), 0);
});

test('bridge: a failing probe is "not up", and stop() ends the watch', async () => {
  const clock = fakeClock();
  const states = [];
  const bridge = createStartBridge({
    probe: async () => { throw new TypeError('Failed to fetch'); },
    launch: () => { throw new Error('blocked'); },
    onState: (s) => states.push(s),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  assert.equal(bridge.start(), true, 'a launch that throws does not break the page');
  await clock.advance(START_LIMITS.pollMs * 2);
  assert.deepEqual(states, ['launching']);
  bridge.stop();
  assert.equal(clock.size, 0);
  await clock.advance(120000);
  assert.deepEqual(states, ['launching']);
  assert.equal(bridge.start(), false);
});

// ── The offline page as the server sends it ──

test('the bridge becomes a classic script for the page that cannot fetch modules', () => {
  const script = moduleToClassicScript(BRIDGE_SOURCE);
  assert.doesNotMatch(script, /^\s*export\s/m);
  assert.doesNotMatch(script, /^\s*import\s/m);
  const sandbox = {};
  vm.runInNewContext(`${script}\nthis.exported = { createStartBridge, manualStartCommands, openStartLink, startButtonUsable, startLinkMode, isWindowsPlatform, isMacPlatform, START_LINK };`, sandbox);
  assert.equal(typeof sandbox.exported.createStartBridge, 'function');
  assert.equal(sandbox.exported.START_LINK, START_LINK);

  assert.throws(() => moduleToClassicScript(`import x from './y.js';\nexport function a() {}`), /no imports/);
  assert.throws(() => moduleToClassicScript(`export default function () {}`), /export function/);
  assert.throws(() => moduleToClassicScript(`export { a };`), /export function/);
});

// Built from code points: a separator typed into this file would be the bug itself.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

test('script-safe JSON: nothing in a value can end the script or break its parsing', () => {
  const hostile = [
    '</script><script>alert(1)</script>',
    '<!-- <script>',
    'a & b',
    `line${LINE_SEPARATOR}separator`,
    `paragraph${PARAGRAPH_SEPARATOR}separator`,
    'quote " backslash \\ newline \n',
  ];
  for (const value of hostile) {
    const encoded = scriptJson({ value });
    assert.doesNotMatch(encoded, /[<>&]/, `no markup character survives: ${JSON.stringify(value)}`);
    assert.ok(!encoded.includes(LINE_SEPARATOR) && !encoded.includes(PARAGRAPH_SEPARATOR), 'no raw line separator survives');
    assert.deepEqual(JSON.parse(encoded), { value }, 'and it is still the same value as JSON');
    // …and as the JavaScript the page runs.
    assert.equal(vm.runInNewContext(`(${encoded})`).value, value);
  }
  assert.equal(scriptJson('<&>'), '"\\u003c\\u0026\\u003e"');
  assert.equal(scriptJson(LINE_SEPARATOR + PARAGRAPH_SEPARATOR), '"\\u2028\\u2029"');
});

test('the renderer itself is free of raw separators and loads', async () => {
  // The module the server imports to build the offline page. A raw U+2028 in
  // one of its regex literals once made it a SyntaxError that
  // `node --check server.js` could not see (tests/entry-imports-parse.test.mjs
  // now parses the whole import graph).
  for (const file of ['lib/offline-page.js', 'public/shared/start-bridge.js', 'public/shared/ui-loading.js', 'public/offline.html', 'public/sw.js']) {
    const source = read(file);
    assert.ok(!source.includes(LINE_SEPARATOR) && !source.includes(PARAGRAPH_SEPARATOR), `${file} has no raw U+2028 / U+2029`);
  }
  const renderer = await import('../lib/offline-page.js');
  assert.deepEqual(Object.keys(renderer).sort(), ['OFFLINE_SLOTS', 'moduleToClassicScript', 'renderOfflinePage', 'scriptJson']);
  assert.match(read('lib/offline-page.js'), /\.replace\(\/\\u2028\/g, '\\\\u2028'\)/, 'the separators are written as escapes');
  assert.match(read('lib/offline-page.js'), /\.replace\(\/\\u2029\/g, '\\\\u2029'\)/);
});

test('the page modules this feature touches parse', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const file of ['public/shared/ui-loading.js', 'public/shared/start-bridge.js', 'public/shared/term-ready.js', 'public/shared/ui-terminal.js', 'public/variant/3d/main.js', 'public/variant/2d/main.js', 'public/sw.js', 'lib/offline-page.js']) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', resolve(NI, file)], { stdio: 'pipe' }), file);
  }
});

test('facts are written so no path can break out of the script', () => {
  const projectDir = `/Users/x/</script><script>alert(1)</script>/${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}&`;
  const facts = { projectDir, install: 'git', launcher: 'registered' };
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts });
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(!html.includes(LINE_SEPARATOR) && !html.includes(PARAGRAPH_SEPARATOR), 'the page carries no raw separator');
  assert.ok(!html.includes(OFFLINE_SLOTS.bridge) && !html.includes(OFFLINE_SLOTS.facts), 'both slots are filled');
  const assigned = /window\.__SYNABUN_OFFLINE__ = (.*);<\/script>/.exec(html)[1];
  assert.deepEqual(JSON.parse(assigned), facts);

  // The page's own view of it: every <script> of the rendered page parses, and
  // the facts one leaves exactly this object behind.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 3);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script), 'a script of the rendered page parses');
  const window = {};
  vm.runInNewContext(scripts[0], { window });
  assert.deepEqual(JSON.parse(JSON.stringify(window.__SYNABUN_OFFLINE__)), facts);

  // A template without the slots (a hand-edited or older file) is served as it is.
  assert.equal(renderOfflinePage('<html>plain</html>', { bridgeSource: BRIDGE_SOURCE, facts: {} }), '<html>plain</html>');
});

/** Run the page's scripts with the server down, against the least DOM they need. */
function openOfflinePage({ html, navigator, storage = {}, serverUp = () => false, href = 'http://localhost:3344/', beacon = null }) {
  const clock = fakeClock();
  const elements = new Map();
  const make = (tag = 'div', id = '') => {
    const handlers = {};
    const classes = new Set();
    const el = {
      tag, id, children: [], style: {}, hidden: id === 'start' || id === 'manualNote', disabled: false, textContent: '', className: '', type: '', src: '',
      attributes: {},
      setAttribute(name, value) { el.attributes[name] = String(value); },
      getAttribute(name) { return name in el.attributes ? el.attributes[name] : null; },
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      appendChild(child) { el.children.push(child); return child; },
      append(...kids) { el.children.push(...kids); },
      replaceChildren(...kids) { el.children = kids; },
      remove() {},
      click() { return handlers.click?.({}); },
      get text() { return el.children.length ? el.children.map(c => c.text ?? c.textContent ?? '').join('') : el.textContent; },
    };
    return el;
  };
  const byId = (id) => { if (!elements.has(id)) elements.set(id, make('div', id)); return elements.get(id); };
  byId('startLabel').textContent = 'Start Server';
  byId('retryText').textContent = 'Checking for server...';
  // As a browser has it: the parts of the address the page reads to find the beacon.
  const url = new URL(href);
  const location = { href, protocol: url.protocol, hostname: url.hostname, port: url.port, reloads: 0, reload() { location.reloads++; } };
  const asked = [];
  const body = make('body');
  const window = {
    document: { getElementById: byId, createElement: (tag) => make(tag), createTextNode: (text) => ({ textContent: text, text }), body },
    navigator: { clipboard: { writeText: async () => {} }, ...navigator },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } },
    location,
    fetch: async (target, options = {}) => {
      asked.push(String(target));
      // The launcher's beacon is another origin on this machine; the server is this one.
      if (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(target))) {
        const report = beacon ? beacon(String(target), options) : null;
        if (!report) throw new TypeError('Failed to fetch');
        return { ok: true, json: async () => report };
      }
      if (!serverUp()) throw new TypeError('Failed to fetch');
      return { ok: true };
    },
    setTimeout: (fn, ms) => clock.setTimer(fn, ms),
    clearTimeout: (id) => clock.clearTimer(id),
    setInterval: (fn, ms) => { const tick = () => { fn(); clock.setTimer(tick, ms); }; return clock.setTimer(tick, ms); },
    clearInterval: (id) => clock.clearTimer(id),
    Date: { now: () => clock.now() },
    Math, JSON, Promise, console,
  };
  window.window = window;
  const context = vm.createContext(window);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // Top-level const/let of one classic script are visible to the next, as in a page.
  vm.runInContext(scripts.join('\n;\n'), context);
  const commands = () => byId('manualList').children.filter(c => c.className === 'cmd-block').map(b => b.children[0].text);
  const trail = () => byId('startTrail').children.map(li => li.children.map(c => c.textContent).join(' @ '));
  return { clock, byId, location, body, commands, trail, asked, scriptCount: scripts.length };
}

const MAC = { platform: 'MacIntel', userAgent: UA.safari };

test('offline page: Start Server on macOS hands the link over, waits, and reconnects', async () => {
  const html = renderOfflinePage(OFFLINE_TEMPLATE, {
    bridgeSource: BRIDGE_SOURCE,
    facts: { projectDir: '/Users/me/Apps/Synabun', install: 'git', launcher: 'registered' },
  });
  let up = false;
  const page = openOfflinePage({ html, navigator: MAC, serverUp: () => up });
  assert.equal(page.scriptCount, 3);

  assert.equal(page.byId('start').hidden, false, 'the button is there');
  assert.equal(page.byId('manualLabel').textContent, 'Or start it from a terminal');
  assert.equal(page.byId('manualNote').hidden, true);
  assert.deepEqual(page.commands(), ['npm --prefix /Users/me/Apps/Synabun start'], 'the one command for a GitHub install');

  page.byId('startBtn').click();
  assert.equal(page.location.href, 'synabun://start');
  assert.equal(page.byId('startBtn').disabled, true);
  assert.equal(page.byId('startLabel').textContent, 'Starting...');
  // At once, and only what is known: the request was handed over, nothing has confirmed it.
  assert.equal(page.byId('startStatus').textContent, 'Asked your system to start SynaBun. If your browser shows a prompt, choose Open.');
  assert.equal(page.byId('retryText').textContent, 'Waiting for the server...');
  assert.equal(page.byId('mascot').getAttribute('data-state'), 'waking');
  assert.equal(page.byId('heading').textContent, 'Starting the server');
  assert.equal(page.byId('startElapsed').textContent, '0 s');

  page.location.href = 'http://localhost:3344/';
  page.byId('startBtn').click(); // a second click while it starts
  assert.equal(page.location.href, 'http://localhost:3344/', 'no second hand-off');

  await page.clock.advance(3000);
  assert.equal(page.byId('startElapsed').textContent, '3 s', 'the page\'s own clock keeps running');
  await page.clock.advance(6000);
  assert.match(page.byId('startStatus').textContent, /^No word from the launcher yet\. .* a Terminal window then opens with the server\.$/);
  assert.deepEqual(page.trail(), [], 'nothing was reported, so no step is listed');
  assert.ok(page.asked.some(u => u === `http://127.0.0.1:13344${START_BEACON_PATH}`), 'it asks the launcher, on the beacon of this server\'s port');

  // Found within one poll of the server answering, and reloaded without a pause to admire it.
  up = true;
  await page.clock.advance(START_LIMITS.pollMs);
  assert.equal(page.byId('retryText').textContent, 'Server is back! Reconnecting...');
  assert.equal(page.byId('retry').classList.contains('connected'), true);
  assert.equal(page.byId('mascot').getAttribute('data-state'), 'ready');
  assert.equal(page.byId('startStatus').textContent, 'The server is up. Loading SynaBun.');
  assert.equal(page.location.reloads, 0);
  await page.clock.advance(START_LIMITS.reloadDelayMs);
  assert.equal(page.location.reloads, 1);
  assert.ok(START_LIMITS.pollMs + START_LIMITS.reloadDelayMs <= 500, 'the page adds at most half a second to a start');
});

test('offline page: nothing answers — the button returns with the way out', async () => {
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts: { projectDir: 'C:\\Users\\Ana Maria\\synabun', install: 'git', launcher: 'registered' } });
  const page = openOfflinePage({ html, navigator: { platform: 'Win32', userAgent: UA.chrome } });
  assert.deepEqual(page.commands(), ['npm --prefix "C:\\Users\\Ana Maria\\synabun" start']);
  page.byId('startBtn').click();
  await page.clock.advance(9000);
  assert.match(page.byId('startStatus').textContent, /a console window then opens with the server\.$/);
  assert.equal(page.byId('startBtn').disabled, true);
  await page.clock.advance(60000);
  assert.equal(page.byId('startBtn').disabled, false);
  assert.equal(page.byId('startLabel').textContent, 'Start Server');
  assert.match(page.byId('startStatus').textContent, /^Nothing has answered\. If no prompt or window appeared, run the command below once/);
  assert.equal(page.byId('mascot').getAttribute('data-state'), 'stalled');
  assert.equal(page.byId('startElapsed').textContent, '', 'no clock once nothing is under way');
  assert.equal(page.location.reloads, 0);
});

test('offline page: a packaged application shows its own start command, never npm', () => {
  const entry = '/Applications/Syna Bun.app/Contents/MacOS/SynaBun';
  const facts = { projectDir: '/Applications/Syna Bun.app/Contents/Resources/app', install: 'app', launcher: 'registered', entry };
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts });
  assert.ok(html.includes('"install":"app"') && html.includes(`"entry":${JSON.stringify(entry)}`));
  const page = openOfflinePage({ html, navigator: MAC });
  assert.deepEqual(page.commands(), [`'${entry}' start`]);
  // What the last health answer said wins over the cached copy, as for the other facts.
  const moved = openOfflinePage({ html, navigator: MAC, storage: { 'synabun-start-entry': '/Users/me/Applications/SynaBun.app/Contents/MacOS/SynaBun' } });
  assert.deepEqual(moved.commands(), ['/Users/me/Applications/SynaBun.app/Contents/MacOS/SynaBun start']);
  // Any other install kind is still read as a checkout.
  assert.ok(renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts: { install: 'elsewhere' } }).includes('"install":"git"'));
});

test('offline page: Firefox on Linux uses a hidden frame and says where the server runs', async () => {
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts: { projectDir: '/usr/lib/node_modules/synabun', install: 'npm', launcher: 'registered' } });
  const page = openOfflinePage({ html, navigator: { platform: 'Linux x86_64', userAgent: UA.firefox } });
  assert.deepEqual(page.commands(), ['synabun'], 'an npm install is started by name');
  page.byId('startBtn').click();
  assert.equal(page.location.href, 'http://localhost:3344/');
  assert.deepEqual(page.body.children.map(c => [c.tag, c.src]), [['iframe', 'synabun://start']]);
  await page.clock.advance(9000);
  assert.match(page.byId('startStatus').textContent, /the server then starts in the background\.$/);
});

test('offline page: a launcher known to be missing shows the command, not a dead button', async () => {
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts: { projectDir: '/srv/synabun', install: 'git', launcher: 'missing' } });
  let up = false;
  const page = openOfflinePage({ html, navigator: MAC, serverUp: () => up });
  assert.equal(page.byId('start').hidden, true);
  assert.equal(page.byId('manualNote').hidden, false, 'and says that running it once sets the button up');
  assert.deepEqual(page.commands(), ['npm --prefix /srv/synabun start']);
  // It still reconnects on its own once the command was run.
  up = true;
  await page.clock.advance(3000);
  await page.clock.advance(600);
  assert.equal(page.location.reloads, 1);
  assert.deepEqual(page.asked.filter(u => u.includes('13344')).length <= START_LIMITS.idleBeaconChecks, true, 'an idle page does not keep knocking on the beacon');
});

test('offline page: what the last health check stored wins over what the cached page was built with', () => {
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts: { projectDir: '/old/place', install: 'git', launcher: 'missing' } });
  const page = openOfflinePage({
    html, navigator: MAC,
    storage: { [START_STORAGE.projectDir]: '/new/place', [START_STORAGE.install]: 'git', [START_STORAGE.launcher]: 'registered' },
  });
  assert.equal(page.byId('start').hidden, false);
  assert.deepEqual(page.commands(), ['npm --prefix /new/place start']);
});

test('offline page: served by a server that predates the bridge, it still shows commands and reconnects', async () => {
  // public/ reloads at any time, lib/ only on a restart: until then the old
  // route sends the new template with its slots unfilled.
  let up = false;
  const page = openOfflinePage({ html: OFFLINE_TEMPLATE, navigator: MAC, storage: { 'synabun-project-dir': '/Users/me/Apps/Synabun' }, serverUp: () => up });
  assert.equal(page.byId('start').hidden, true, 'no bridge, no button');
  assert.deepEqual(page.commands(), ['synabun', 'npm --prefix "/Users/me/Apps/Synabun" start']);
  up = true;
  await page.clock.advance(3000);
  await page.clock.advance(600);
  assert.equal(page.location.reloads, 1);
});

// ── What a launch reports, and what the page makes of it ──

/** A beacon answer as lib/start-launcher.js writes it. */
function report({ port = 3344, id = 'launch-1', startedAt, now, state = 'starting', steps = [], supervisor = null, error = null, log = '/home/me/.synabun/data/launcher.log' } = {}) {
  return {
    synabun: 'start-beacon', v: 1, port, launchId: id, startedAt, now: now ?? startedAt, state,
    steps: [{ id: 'received', at: startedAt }, ...steps], supervisor, error, log,
  };
}

function reportingBridge({ up = () => false, answer }) {
  const clock = fakeClock();
  const states = [];
  const views = [];
  let asked = 0;
  const bridge = createStartBridge({
    probe: async () => up(),
    launch: () => {},
    beacon: async () => { asked++; return answer(clock.now()); },
    port: 3344,
    onState: (state) => states.push(state),
    onUpdate: (snap) => views.push(startStatusView(snap, { platform: 'mac' })),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  return { bridge, clock, states, views, asked: () => asked, view: () => views.at(-1) };
}

test('beacon: only a page on the server\'s own machine has one to read', () => {
  const at = (href) => { const u = new URL(href); return startBeaconTarget({ protocol: u.protocol, hostname: u.hostname, port: u.port }); };
  assert.deepEqual(at('http://localhost:3344/'), { port: 3344, url: `http://127.0.0.1:13344${START_BEACON_PATH}` });
  assert.deepEqual(at('http://127.0.0.1:4455/index2d.html'), { port: 4455, url: `http://127.0.0.1:14455${START_BEACON_PATH}` });
  assert.equal(at('http://localhost/').port, 80);
  // A tunnel, an invite link, a LAN address: the launcher is on another machine than this browser.
  for (const href of ['https://my.tunnel.example/', 'http://192.168.1.20:3344/', 'https://localhost:3344/', 'http://synabun.local:3344/']) {
    assert.equal(at(href), null, href);
  }
  assert.equal(startBeaconTarget(undefined), null);
  assert.equal(startBeaconPort(65000), 55000);
});

test('beacon: an answer is believed only when it is this server\'s, and its end only when it is this page\'s', () => {
  const live = report({ startedAt: 50_000, now: 51_000 });
  assert.equal(readStartBeacon(live, { port: 3344 }).state, 'starting', 'a start under way is this server\'s start, whoever asked');
  assert.equal(readStartBeacon(live, { port: 4455 }), null, 'another server\'s');
  assert.equal(readStartBeacon({ ...live, v: 2 }, { port: 3344 }), null, 'a version this page does not know');
  for (const junk of [null, 'ok', 42, [], {}, { ok: true }, { ...live, synabun: 'x' }, { ...live, state: '50%' }, { ...live, launchId: '' }, { ...live, startedAt: 'soon' }]) {
    assert.equal(readStartBeacon(junk, { port: 3344 }), null);
  }

  // A failure still being reported from before this click is not this click's.
  const old = report({ startedAt: 50_000, state: 'failed', error: { code: 'X', message: 'earlier' } });
  assert.equal(readStartBeacon(old, { port: 3344 }), null, 'nobody asked');
  assert.equal(readStartBeacon(old, { port: 3344, askedAt: 80_000 }), null, 'asked long after it began');
  assert.equal(readStartBeacon(old, { port: 3344, askedAt: 49_500 }).state, 'failed', 'began after the click: this page\'s');
  assert.equal(readStartBeacon(old, { port: 3344, askedAt: 0 }).state, 'failed', 'a click at clock zero is a click');
  assert.equal(readStartBeacon(old, { port: 3344, following: 'launch-1' }).state, 'failed', 'the launch this page was already showing');
  assert.equal(readStartBeacon(old, { port: 3344, askedAt: 49_500, past: ['launch-1'] }), null, 'the try before a retry');

  // Only known fields come through, bounded.
  const noisy = readStartBeacon(report({
    startedAt: 1000, now: 9000,
    steps: [{ id: 'terminal', at: 1400 }, { id: 'rm -rf', at: 1500 }, { id: 'spawned', at: 'x' }],
    supervisor: { phase: 'snapshot', at: 3000, startedAt: 1600, detail: { files: 1200, bytes: 52428800, step: 'archive', extra: '<b>' }, phases: [{ phase: 'checking', at: 1600 }, { phase: 'nope', at: 1 }, { phase: 'snapshot', at: 3000 }] },
    log: 'x'.repeat(1000),
  }), { port: 3344 });
  assert.deepEqual(noisy.steps, [{ id: 'received', at: 1000 }, { id: 'terminal', at: 1400 }], 'a step that is not one, or has no time, is dropped');
  assert.equal(noisy.step, 'terminal');
  assert.deepEqual(noisy.supervisor.detail, { name: '', step: 'archive', files: 1200, bytes: 52428800 });
  assert.deepEqual(noisy.supervisor.phases, [{ phase: 'checking', at: 1600 }, { phase: 'snapshot', at: 3000 }]);
  assert.equal(noisy.quietMs, 6000, 'how long since it last saw something, on its own clock');
  assert.equal(noisy.log.length, 400);
  assert.equal(readStartBeacon(report({ startedAt: 1, supervisor: { phase: 'hacked' } }), { port: 3344 }).supervisor, null);
});

test('beacon: fetching it never throws and never waits on a launcher that is not there', async () => {
  const target = { port: 3344, url: 'http://127.0.0.1:13344/synabun-start-status' };
  const calls = [];
  const ok = await fetchStartBeacon(target, { fetchImpl: async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => ({ a: 1 }) }; } });
  assert.deepEqual(ok, { a: 1 });
  assert.equal(calls[0][0], target.url);
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.ok(calls[0][1].signal, 'bounded');
  assert.equal(await fetchStartBeacon(target, { fetchImpl: async () => { throw new TypeError('refused'); } }), null);
  assert.equal(await fetchStartBeacon(target, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), null);
  assert.equal(await fetchStartBeacon(target, { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('html'); } }) }), null);
  assert.equal(await fetchStartBeacon(null, { fetchImpl: async () => { throw new Error('never called'); } }), null);
});

test('bridge: what the launcher reports is shown as it happens, and a slow step is not a stall', async () => {
  // The click is at 0; the browser's prompt takes 2.2 s; then the launch reports itself.
  const launchedAt = 2200;
  const { bridge, clock, states, view } = reportingBridge({
    answer: (now) => {
      if (now < launchedAt) return null;
      const steps = now >= 2600 ? [{ id: 'locked', at: 2210 }, { id: 'terminal', at: 2570 }] : [{ id: 'locked', at: 2210 }];
      let supervisor = null;
      if (now >= 3000) supervisor = { phase: 'checking', at: 2700, startedAt: 2700, phases: [{ phase: 'checking', at: 2700 }] };
      if (now >= 4000) supervisor = { phase: 'snapshot', at: 3900, startedAt: 2700, detail: { files: 1840, bytes: 734003200, step: 'checksum' }, phases: [{ phase: 'checking', at: 2700 }, { phase: 'snapshot', at: 3900 }] };
      if (now >= 200_000) supervisor = { phase: 'server', at: 199_500, startedAt: 2700, phases: [{ phase: 'checking', at: 2700 }, { phase: 'snapshot', at: 3900 }, { phase: 'server', at: 199_500 }] };
      return report({ startedAt: launchedAt, now, steps, supervisor });
    },
  });
  bridge.start();
  assert.equal(view().headline.key, 'asked');
  assert.equal(view().mascot, 'waking');
  assert.deepEqual(view().trail, [], 'nothing is listed before it is reported');

  await clock.advance(2400);
  assert.deepEqual(states, ['launching', 'starting']);
  assert.equal(view().headline.key, 'launcherRunning');
  assert.equal(view().mascot, 'working');
  assert.deepEqual(view().trail, [{ key: 'trailLauncher', time: '2.2 s' }], 'the hand-off the page could not see, measured');

  await clock.advance(300);
  assert.equal(view().headline.key, 'terminalOpened');
  assert.deepEqual(view().trail.map(r => r.key), ['trailLauncher', 'trailTerminal']);

  await clock.advance(600);
  assert.equal(view().headline.key, 'checking');
  assert.deepEqual(view().trail.at(-1), { key: 'trailSupervisor', time: '2.7 s' });

  await clock.advance(1200);
  assert.deepEqual(view().headline, { key: 'snapshotSized', params: { files: 1840, megabytes: 700 } });

  // Three minutes of backup: it says so the whole time, the button stays put, nothing stalls.
  await clock.advance(180_000);
  assert.deepEqual(states, ['launching', 'starting']);
  assert.equal(view().busy, true);
  assert.equal(view().headline.key, 'snapshotSized');
  assert.equal(view().hint, null, 'silence during a step that is slow by nature is not remarked on');
  assert.equal(view().elapsed, '3 min 04 s');
  assert.equal(bridge.start(), false, 'no second launch on top of a reported one');

  await clock.advance(16_000);
  assert.equal(view().headline.key, 'server');
  assert.deepEqual(view().trail.at(-1), { key: 'trailServer', time: '200 s' });
});

test('bridge: a failure is the launcher\'s own words, and a retry does not show it again', async () => {
  let attempt = 1;
  const { bridge, clock, states, view } = reportingBridge({
    answer: (now) => {
      if (attempt === 1) {
        return report({
          id: 'first', startedAt: 400, now, state: now >= 1500 ? 'failed' : 'starting',
          steps: [{ id: 'spawned', at: 500 }],
          error: now >= 1500 ? { code: 'SUPERVISOR_EXITED', message: 'npm could not install the MCP Server dependencies', exitCode: 1 } : null,
        });
      }
      // The first launcher is still saying it failed; the second has not come up yet.
      if (now < 9000) return report({ id: 'first', startedAt: 400, now, state: 'failed', error: { code: 'SUPERVISOR_EXITED', message: 'npm could not install the MCP Server dependencies' } });
      return report({ id: 'second', startedAt: 8800, now, steps: [{ id: 'spawned', at: 8900 }] });
    },
  });
  bridge.start();
  await clock.advance(900);
  assert.equal(view().headline.key, 'processStarted');
  await clock.advance(900);
  assert.deepEqual(states, ['launching', 'starting', 'failed']);
  assert.equal(view().mascot, 'failed');
  assert.equal(view().busy, false);
  assert.equal(view().button, 'retry');
  assert.deepEqual(view().headline, { key: 'failed', params: { reason: 'npm could not install the MCP Server dependencies' } });
  assert.deepEqual(view().error, { message: 'npm could not install the MCP Server dependencies', log: '/home/me/.synabun/data/launcher.log' });
  assert.equal(formatStartText(START_COPY.failed, view().headline.params), 'The start failed: npm could not install the MCP Server dependencies');
  assert.equal(view().elapsed, '', 'the clock stops with the start');

  await clock.advance(5000);
  attempt = 2;
  assert.equal(bridge.start(), true, 'the button works again');
  await clock.advance(1500);
  assert.equal(states.at(-1), 'launching', 'the old failure is not this try\'s');
  assert.equal(view().headline.key, 'asked');
  await clock.advance(1500);
  assert.equal(states.at(-1), 'starting');
  assert.equal(view().headline.key, 'processStarted');
});

test('bridge: a page reloaded in the middle of a start picks it up; an idle one stops asking', async () => {
  const joined = reportingBridge({
    answer: (now) => report({ startedAt: -40_000, now, steps: [{ id: 'terminal', at: -39_600 }], supervisor: { phase: 'dependencies', at: -39_000, startedAt: -39_400, detail: { name: 'Neural Interface' }, phases: [] } }),
  });
  joined.bridge.watch();
  await joined.clock.advance(50);
  assert.deepEqual(joined.states, ['starting'], 'no click was needed');
  assert.equal(joined.view().headline.key, 'dependencies');
  assert.equal(joined.view().busy, true);
  assert.equal(joined.view().elapsed, '40 s', 'counted from when that start began, not from the reload');
  assert.deepEqual(joined.view().trail[0], { key: 'trailLauncher', time: '0.0 s' });

  const idle = reportingBridge({ answer: () => null });
  idle.bridge.watch();
  await idle.clock.advance(60_000);
  assert.equal(idle.asked(), START_LIMITS.idleBeaconChecks, 'nothing under way: it does not keep knocking');
  assert.deepEqual(idle.states, []);
});

test('bridge: a launcher that gives up, or goes silent, puts the button back', async () => {
  const gaveUp = reportingBridge({
    answer: (now) => report({ startedAt: 300, now, state: now >= 5000 ? 'gave-up' : 'starting', steps: [{ id: 'terminal', at: 700 }], error: now >= 5000 ? { code: 'NO_ANSWER', message: 'no answer after 300 s' } : null }),
  });
  gaveUp.bridge.start();
  await gaveUp.clock.advance(2000);
  assert.equal(gaveUp.view().headline.key, 'terminalOpened');
  await gaveUp.clock.advance(3500);
  assert.equal(gaveUp.states.at(-1), 'stalled');
  assert.equal(gaveUp.view().headline.key, 'gaveUp');
  assert.equal(gaveUp.view().busy, false);
  assert.equal(gaveUp.view().mascot, 'stalled');

  // Reported for a while, then nothing: what it said last is not repeated as if still true.
  const silent = reportingBridge({ answer: (now) => (now < 2000 ? report({ startedAt: 300, now, steps: [{ id: 'terminal', at: 700 }] }) : null) });
  silent.bridge.start();
  await silent.clock.advance(1900);
  assert.equal(silent.view().headline.key, 'terminalOpened');
  await silent.clock.advance(START_LIMITS.lostAfterMs + 600);
  assert.equal(silent.states.at(-1), 'waiting');
  assert.equal(silent.view().headline.key, 'unconfirmedMac');
  assert.deepEqual(silent.view().trail, []);

  // A Terminal that was opened and then nothing: said, with the launcher's own count.
  const quiet = reportingBridge({ answer: (now) => report({ startedAt: 300, now, steps: [{ id: 'terminal', at: 700 }] }) });
  quiet.bridge.start();
  await quiet.clock.advance(20_000);
  assert.equal(quiet.view().headline.key, 'terminalQuiet');
  assert.ok(quiet.view().headline.params.seconds >= 15);
  assert.equal(quiet.view().busy, true);
});

test('view: no sentence names a step the snapshot holds no report of, and nothing is a percentage', () => {
  const evidenceFree = ['asked', 'unconfirmedMac', 'unconfirmedWindows', 'unconfirmedLinux', 'stalled', 'online'];
  for (const state of ['idle', 'launching', 'waiting', 'stalled', 'online']) {
    for (const platform of ['mac', 'windows', 'linux']) {
      const view = startStatusView({ state, clicks: 1, askedAt: 0, since: 0, elapsedMs: 12_000, launch: null }, { platform });
      if (view.headline) assert.ok(evidenceFree.includes(view.headline.key), `${state}: ${view.headline.key}`);
      assert.deepEqual(view.trail, []);
      assert.equal(view.error, null);
    }
  }
  assert.equal(startStatusView({ state: 'idle', launch: null }).headline, null);
  assert.equal(startStatusView({ state: 'idle', launch: null }).mascot, 'asleep');
  assert.equal(startStatusView(undefined).state, 'idle');

  // Every phase a supervisor can report has its own sentence, in every language file's source.
  for (const phase of ['checking', 'dependencies', 'browser', 'build', 'snapshot', 'server', 'listening']) {
    const launch = readStartBeacon(report({ startedAt: 1000, now: 1500, supervisor: { phase, at: 1400, startedAt: 1200, phases: [] } }), { port: 3344 });
    const view = startStatusView({ state: 'starting', askedAt: 900, since: 900, elapsedMs: 600, launch });
    assert.equal(view.headline.key, phase);
    assert.equal(typeof START_COPY[phase], 'string');
  }
  const answered = readStartBeacon(report({ startedAt: 1000, now: 1500, state: 'started' }), { port: 3344, askedAt: 900 });
  assert.equal(startStatusView({ state: 'starting', askedAt: 900, since: 900, elapsedMs: 600, launch: answered }).headline.key, 'answered');

  for (const [key, text] of Object.entries(START_COPY)) {
    assert.doesNotMatch(text, /%|percent/i, `${key} claims no percentage`);
    assert.doesNotMatch(text, /\balmost\b|\bnearly\b|\bjust a moment\b/i, `${key} promises nothing`);
  }
  assert.equal(formatStartElapsed(0), '0 s');
  assert.equal(formatStartElapsed(59_999), '59 s');
  assert.equal(formatStartElapsed(65_000), '1 min 05 s');
  assert.equal(formatStartText('{a} and {b}', { a: 1 }), '1 and {b}');
});

test('offline page: a real launch is shown step by step, with the mascot at work', async () => {
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts: { projectDir: '/Users/me/Apps/Synabun', install: 'git', launcher: 'registered' } });
  let up = false;
  let now = () => 0;
  const page = openOfflinePage({
    html, navigator: MAC, serverUp: () => up,
    beacon: (url, options) => {
      assert.equal(url, `http://127.0.0.1:13344${START_BEACON_PATH}`);
      assert.equal(options.credentials, 'omit');
      const t = now();
      if (t < 1800) return null; // the browser is still asking
      return report({
        startedAt: 1800, now: t,
        steps: t >= 2300 ? [{ id: 'locked', at: 1810 }, { id: 'terminal', at: 2170 }] : [{ id: 'locked', at: 1810 }],
        supervisor: t >= 2700 ? { phase: 'server', at: 2500, startedAt: 2300, detail: { pid: 5 }, phases: [{ phase: 'checking', at: 2300 }, { phase: 'server', at: 2500 }] } : null,
      });
    },
  });
  now = page.clock.now;
  page.byId('startBtn').click();
  assert.equal(page.byId('mascot').getAttribute('data-state'), 'waking');

  await page.clock.advance(2100);
  assert.equal(page.byId('startStatus').textContent, 'The launcher is running.');
  assert.equal(page.byId('mascot').getAttribute('data-state'), 'working');
  assert.deepEqual(page.trail(), ['Launcher started @ 1.8 s']);

  await page.clock.advance(300);
  assert.equal(page.byId('startStatus').textContent, 'A Terminal window was opened for the server.');
  await page.clock.advance(600);
  assert.equal(page.byId('startStatus').textContent, 'The server process is running. Waiting for it to answer.');
  assert.deepEqual(page.trail(), ['Launcher started @ 1.8 s', 'Terminal opened @ 2.2 s', 'Supervisor running @ 2.3 s', 'Server process started @ 2.5 s']);
  assert.equal(page.byId('startBtn').disabled, true);
  assert.equal(page.byId('startElapsed').getAttribute('aria-label'), 'Time since Start was pressed: 3 s');

  up = true;
  await page.clock.advance(START_LIMITS.pollMs + START_LIMITS.reloadDelayMs);
  assert.equal(page.byId('mascot').getAttribute('data-state'), 'ready');
  assert.equal(page.location.reloads, 1);
});

test('offline page: a failed launch says why, where the log is, and offers the retry', async () => {
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts: { projectDir: '/srv/synabun', install: 'git', launcher: 'registered' } });
  let now = () => 0;
  const page = openOfflinePage({
    html, navigator: { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
    beacon: () => (now() < 600 ? null : report({
      startedAt: 500, now: now(), state: 'failed', steps: [{ id: 'spawned', at: 560 }],
      error: { code: 'SETUP_MISSING', message: '/srv/synabun/setup.js is missing <img src=x onerror=alert(1)>' },
      log: '/home/me/.synabun/data/launcher.log',
    })),
  });
  now = page.clock.now;
  page.byId('startBtn').click();
  await page.clock.advance(900);
  assert.equal(page.byId('mascot').getAttribute('data-state'), 'failed');
  assert.equal(page.byId('heading').textContent, 'The server did not start');
  // Written as text: what the launcher said is never markup here.
  assert.equal(page.byId('startStatus').textContent, 'The start failed: /srv/synabun/setup.js is missing <img src=x onerror=alert(1)>');
  assert.equal(page.byId('startHint').textContent, 'Run the command below to see the full output, or try again.');
  assert.equal(page.byId('startLog').textContent, 'Launcher log: /home/me/.synabun/data/launcher.log');
  assert.equal(page.byId('startLog').hidden, false);
  assert.equal(page.byId('startBtn').disabled, false);
  assert.equal(page.byId('startLabel').textContent, 'Try again');
  assert.deepEqual(page.commands(), ['npm --prefix /srv/synabun start'], 'the manual way stays on the page');

  page.location.href = 'http://localhost:3344/';
  page.byId('startBtn').click();
  assert.equal(page.location.href, 'synabun://start', 'the retry hands the link over again');
  assert.equal(page.byId('startLog').hidden, true);
  await page.clock.advance(900);
  assert.equal(page.byId('mascot').getAttribute('data-state'), 'waking', 'the earlier failure is not shown for the new try');
});

test('offline page: on a tunnel or another machine it does not look for a launcher it could not reach', async () => {
  const html = renderOfflinePage(OFFLINE_TEMPLATE, { bridgeSource: BRIDGE_SOURCE, facts: { projectDir: '/srv/synabun', install: 'git', launcher: 'registered' } });
  const page = openOfflinePage({ html, navigator: MAC, href: 'https://my.tunnel.example/', beacon: () => { throw new Error('never asked'); } });
  page.byId('startBtn').click();
  await page.clock.advance(10_000);
  assert.ok(page.asked.length > 0 && page.asked.every(u => u === '/'), 'only its own server is asked');
  assert.match(page.byId('startStatus').textContent, /^No word from the launcher yet\./);
});

test('both surfaces announce the sentence, not the clock, and stand still when asked to', async () => {
  // The offline page.
  assert.match(OFFLINE_TEMPLATE, /id="startStatus" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(OFFLINE_TEMPLATE, /id="startElapsed" role="timer" aria-live="off"/, 'a ticking clock is not read out every second');
  assert.match(OFFLINE_TEMPLATE, /if \(startStatus\.textContent !== line\) startStatus\.textContent = line;/, 'the live region is written only when it changes');
  assert.match(OFFLINE_TEMPLATE, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.mascot-wrap, \.mascot-wrap \.eye, \.zzz span, \.retry-dot, \.particles span \{\s*animation: none !important;/);
  for (const state of ['waking', 'working', 'ready', 'failed', 'stalled']) {
    assert.match(OFFLINE_TEMPLATE, new RegExp(`\\.mascot-wrap\\[data-state="${state}"\\] \\.eye`), `the mascot has a face for ${state}`);
  }
  assert.match(OFFLINE_TEMPLATE, /<svg viewBox="0 0 280 140"[^>]*aria-hidden="true"/, 'the mascot is decoration: the words carry the state');
  assert.doesNotMatch(OFFLINE_TEMPLATE, /<progress|aria-valuenow|width:\s*\d+%;\s*\/\* progress/, 'no progress bar: nothing here is measured as a fraction');

  // The in-app overlay.
  const shell = read('public/shared/html-shell.js');
  assert.match(shell, /id="loading-action-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(shell, /id="loading-action-elapsed" role="timer" aria-live="off"/);
  for (const id of ['loading-action-hint', 'loading-action-trail', 'loading-action-log']) assert.ok(shell.includes(`id="${id}"`), id);
  const loading = read('public/shared/ui-loading.js');
  assert.match(loading, /if \(\$status && \$status\.textContent !== line\) \$status\.textContent = line;/);
  assert.match(loading, /startStatusView\(snap, \{ platform \}\)/, 'the same view as the offline page');
  assert.match(loading, /beacon: beaconAt \? \(\) => fetchStartBeacon\(beaconAt\) : null/);
  assert.doesNotMatch(loading, /innerHTML = .*(reason|error|log)/, 'what the launcher said is written as text');
  const css = read('public/shared/styles.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*#loading-mascot, #loading-zzz \{ animation: none; \}/);

  // The overlay acts the states out with the app's own mascot rig: every pose it asks for exists.
  const { MASCOT_POSES } = await import('../public/shared/synabun-mascot.js');
  const poses = Object.fromEntries([...loading.matchAll(/^  (asleep|waking|working|ready|failed|stalled): '([a-z]+)',/gm)].map(m => [m[1], m[2]]));
  assert.deepEqual(Object.keys(poses).sort(), ['asleep', 'failed', 'ready', 'stalled', 'waking', 'working']);
  for (const [state, pose] of Object.entries(poses)) assert.ok(MASCOT_POSES.includes(pose), `${state} → ${pose}`);
  assert.match(loading, /import \{ createMascot \} from '\.\/synabun-mascot\.js';/, 'loaded with the app: nothing can be fetched once the server is down');
});

test('the cached offline page is replaced: a new cache name, refreshed on every online navigation', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /const CACHE_NAME = 'synabun-offline-v12';/);
  assert.match(sw, /names\.filter\(\(n\) => n !== CACHE_NAME\)\.map\(\(n\) => caches\.delete\(n\)\)/, 'the old copy goes with the old name');
  assert.match(sw, /cache\.add\(new Request\(OFFLINE_URL, \{ cache: 'reload' \}\)\)/, 'fetched past the HTTP cache');
});

// ── How it is wired in ──

test('the server renders the offline page and tells pages what they need for later', () => {
  const server = read('server.js');
  const routeStart = server.indexOf("app.get('/offline.html'");
  const route = server.slice(routeStart, server.indexOf("app.get('/claude-chat.html'", routeStart));
  assert.match(route, /renderOfflinePage\(html, \{/);
  assert.match(route, /start-bridge\.js/);
  assert.match(route, /facts: \{ projectDir: PACKAGE_ROOT, install: INSTALL_KIND, launcher: getStartLauncherState\(\), entry: START_ENTRY \}/);

  const healthStart = server.indexOf("app.get('/api/health'");
  const health = server.slice(healthStart, server.indexOf("app.post('/api/health/start'", healthStart));
  assert.match(health, /install: INSTALL_KIND, startLauncher: getStartLauncherState\(\), entry: START_ENTRY/);
  // A packaged application says so, and names the executable a person can start it with.
  assert.match(server, /const INSTALL_KIND = PACKAGED_RUNTIME \? 'app' : isGlobalInstall\(\) \? 'npm' : 'git';/);
  assert.match(server, /const START_ENTRY = durableEntry\(PACKAGED_RUNTIME\) \|\| '';/);

  assert.ok(OFFLINE_TEMPLATE.includes(`<script>${OFFLINE_SLOTS.facts}</script>`));
  assert.ok(OFFLINE_TEMPLATE.includes(`<script>${OFFLINE_SLOTS.bridge}</script>`));
  assert.doesNotMatch(OFFLINE_TEMPLATE, /innerHTML/, 'paths are written as text, never as markup');
});

test('the in-app overlay uses the same bridge and has its words in both languages', () => {
  const loading = read('public/shared/ui-loading.js');
  assert.match(loading, /from '\.\/start-bridge\.js'/);
  assert.match(loading, /createStartBridge\(\{/);
  assert.match(loading, /openStartLink\(\{ document, location: window\.location, userAgent: navigator\.userAgent \}\)/);
  assert.match(loading, /localStorage\.setItem\(START_STORAGE\.install, health\.install\)/);
  assert.match(loading, /localStorage\.setItem\(START_STORAGE\.launcher, health\.startLauncher\)/);
  // Both app variants hand their boot-time health answer over, or nothing is ever remembered.
  for (const variant of ['public/variant/3d/main.js', 'public/variant/2d/main.js']) {
    assert.match(read(variant), /const health = await healthRes\.json\(\);\r?\n\s+rememberHealth\(health\);/, variant);
  }
  assert.doesNotMatch(loading, /cd "\$\{projectDir\}"/, 'the manual command comes from manualStartCommands');

  const keys = [...loading.matchAll(/t\('(loading\.[A-Za-z.]+)'/g)].map(m => m[1]);
  const dictionaries = Object.fromEntries(['i18n/en.json', 'i18n/pt-BR.json'].map(file => [file, JSON.parse(read(file))]));
  for (const [file, strings] of Object.entries(dictionaries)) {
    for (const key of new Set(keys)) {
      const value = key.split('.').reduce((node, part) => node?.[part], strings);
      assert.equal(typeof value, 'string', `${file} has ${key}`);
      assert.ok(value.trim().length > 0);
    }
  }

  // The sentences of a start are the bridge's own (the offline page shows them
  // as they are): the app's English is the same text, and every other language
  // has every one of them with the same placeholders.
  assert.match(loading, /t\(`loading\.start\.\$\{line\.key\}`, line\.params\)/, 'the overlay reads the view\'s keys from the dictionary');
  assert.deepEqual(dictionaries['i18n/en.json'].loading.start, START_COPY);
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [file, strings] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(strings.loading.start).sort(), Object.keys(START_COPY).sort(), `${file} has every sentence`);
    for (const [key, english] of Object.entries(START_COPY)) {
      assert.deepEqual(placeholders(strings.loading.start[key]), placeholders(english), `${file} ${key} keeps its placeholders`);
    }
    for (const gone of ['startAllow', 'startWaitingMac', 'startWaitingWindows', 'startWaitingLinux', 'startStalled']) {
      assert.equal(strings.loading[gone], undefined, `${file} dropped ${gone}`);
    }
  }
});
