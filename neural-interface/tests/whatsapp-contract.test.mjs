// WhatsApp Link contracts that span the codebase: one send call site, Baileys
// loaded only through the adapter, never a SynaBun dependency, server.js
// wiring (admin prefix, owner-only broadcasts, the WebSocket Origin check,
// both shutdown hooks, the kill switch), the npm tarball shipping the
// connector, and the session keys living outside the backed-up data folder.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONNECTOR_FILES } from '../lib/whatsapp/installer.js';
import { isInside, resolveWhatsAppPaths } from '../lib/whatsapp/paths.js';
import { KEYS } from '../public/shared/constants.js';

const NI = fileURLToPath(new URL('../', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const WA = join(NI, 'lib', 'whatsapp');
const SERVER = readFileSync(join(NI, 'server.js'), 'utf8');
const rel = (file) => relative(REPO, file).split(sep).join('/');

/** Source files under `dir` (no node_modules, no vendored bundles, no lockfiles). */
function sources(dir, { exts = /\.(?:m?js|cjs|ts)$/ } = {}) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'vendor') continue;
      const full = join(current, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (exts.test(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
/** Code without comments (a line comment only after whitespace or at the start, so URLs survive). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

test('exactly one sendMessage( call site in lib/whatsapp: sendToOwner in host-core.js', () => {
  const sites = [];
  for (const file of sources(WA)) {
    const text = code(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(/\.sendMessage\s*\(|\[\s*['"`]sendMessage['"`]\s*\]/g)) sites.push(`${rel(file)}@${match.index}`);
  }
  assert.equal(sites.length, 1, sites.join(', '));
  assert.match(sites[0], /^neural-interface\/lib\/whatsapp\/host-core\.js@/);
  const core = code(readFileSync(join(WA, 'host-core.js'), 'utf8'));
  const at = core.indexOf('.sendMessage(');
  assert.ok(core.lastIndexOf('async function sendToOwner(', at) > core.lastIndexOf('\n  function ', at) - 1, 'inside sendToOwner');
  assert.match(core.slice(at - 600, at + 80), /const target = assertOwnerTarget\(\);[\s\S]*sock\.sendMessage\(target,/, 'always to the asserted owner');
});

test('Baileys is loaded only through lib/whatsapp/baileys-adapter.js (inside the host)', () => {
  const RUNTIME_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"`](?:@whiskeysockets\/baileys|baileys|libsignal)(?:\/[^'"`]*)?['"`]/;
  const roots = ['neural-interface', 'mcp-server/src', 'hooks', 'lib', 'bin', 'scripts', 'skills'].map((d) => join(REPO, d)).filter(existsSync);
  // Shipped code only: test files may name the package in their assertions.
  const files = [...roots.flatMap((dir) => sources(dir)), ...['setup.js', 'postinstall.js', 'preuninstall.js', 'updater.mjs'].map((f) => join(REPO, f)).filter(existsSync)]
    .filter((file) => !/[\\/]tests[\\/]/.test(file));
  const importers = files.filter((file) => RUNTIME_IMPORT.test(code(readFileSync(file, 'utf8')))).map(rel);
  assert.deepEqual(importers, ['neural-interface/lib/whatsapp/connector/entry.mjs'], 'only the connector entry names the package (it runs from DATA_HOME/runtime/whatsapp)');
  // The connector entry (and the fake) are imported by the adapter alone.
  const loaders = sources(join(NI, 'lib')).concat(join(NI, 'server.js'))
    .filter((file) => /\bimport\s*\(/.test(code(readFileSync(file, 'utf8'))) && /entry\.mjs|fake-baileys\.js/.test(code(readFileSync(file, 'utf8'))))
    .map(rel);
  assert.deepEqual(loaders, ['neural-interface/lib/whatsapp/baileys-adapter.js']);
  // The main process never reaches the adapter: only the host does (host-core.js, and host.js for --probe).
  const adapterUsers = sources(join(NI, 'lib')).concat(join(NI, 'server.js'))
    .filter((file) => /['"`]\.{1,2}\/(?:whatsapp\/)?baileys-adapter\.js['"`]/.test(code(readFileSync(file, 'utf8'))))
    .map(rel).sort();
  assert.deepEqual(adapterUsers, ['neural-interface/lib/whatsapp/host-core.js', 'neural-interface/lib/whatsapp/host.js']);
  for (const file of ['server.js', 'lib/whatsapp/service.js', 'lib/whatsapp/api.js', 'lib/whatsapp/bridge.js']) {
    assert.doesNotMatch(code(readFileSync(join(NI, file), 'utf8')), /host-core\.js|baileys-adapter\.js/, `${file} never loads the host side`);
  }
});

test('no SynaBun package.json or lockfile names baileys or libsignal', () => {
  for (const file of ['package.json', 'package-lock.json', 'neural-interface/package.json', 'neural-interface/package-lock.json', 'mcp-server/package.json', 'mcp-server/package-lock.json']) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    assert.doesNotMatch(readFileSync(path, 'utf8'), /baileys|libsignal|whiskeysockets/i, file);
  }
});

test('server.js wiring: lazy mount, admin-only prefix, owner-only broadcasts, WS Origin check, both shutdown hooks, kill switch', () => {
  // Mounted synchronously, answering while the Assistant boots.
  assert.match(SERVER, /\napp\.use\('\/api\/whatsapp', \(req, res, next\) => \{\n  if \(_whatsapp\) return _whatsapp\.router\(req, res, next\);/);
  assert.match(SERVER, /req\.method === 'GET' && req\.path === '\/status'\) return res\.json\(\{ ok: true, v: 1, state: 'unavailable', reason: _whatsappDownReason \}\)/);
  assert.match(SERVER, /return res\.status\(503\)\.json\(\{ ok: false, code: 'UNAVAILABLE', error \}\);/);
  assert.ok(SERVER.indexOf("app.use('/api/whatsapp'") < SERVER.indexOf('const httpServer = app.listen('), 'mounted before the server listens');
  // Admin-only and owner-only.
  const admin = SERVER.slice(SERVER.indexOf('const ADMIN_ONLY_PREFIXES = ['), SERVER.indexOf('];', SERVER.indexOf('const ADMIN_ONLY_PREFIXES = [')));
  assert.match(admin, /'\/api\/whatsapp',/);
  const broadcast = SERVER.slice(SERVER.indexOf('function broadcastSync('), SERVER.indexOf('function broadcastSync(') + 400);
  assert.match(broadcast, /const ownerOnly = \[[^\]]*'whatsapp:'[^\]]*\]/);
  // The WebSocket Origin check (details in ws-origin.test.mjs).
  assert.match(SERVER, /if \(!isAllowedWebSocketOrigin\(req, \{ port: PORT, allowedOrigins: publicWebOrigins \}\)\) \{\n    refuseUpgrade\(socket, 403\);/);
  // Graceful shutdown: before the terminal host and the DB close. Hard exit: killNow.
  const graceful = SERVER.slice(SERVER.indexOf('async function runGracefulShutdown('), SERVER.indexOf('\n}\n', SERVER.indexOf('async function runGracefulShutdown(')));
  const stop = graceful.indexOf('await _whatsapp?.shutdown({ timeoutMs: 1500 })');
  assert.ok(stop > 0, 'graceful shutdown stops WhatsApp');
  assert.ok(stop < graceful.indexOf('await terminalHost.shutdown('), 'before the terminal host');
  assert.ok(stop < graceful.indexOf('closeDb()'), 'before the database closes');
  const exit = SERVER.slice(SERVER.lastIndexOf("process.on('exit', () => {"));
  assert.match(exit, /try \{ _whatsapp\?\.killNow\(\); \} catch \{\}/);
  // Built after the Assistant, guarded, with the kill switch and the shared defaults.
  const start = SERVER.slice(SERVER.indexOf('async function startWhatsAppLink()'), SERVER.indexOf('\n}\n', SERVER.indexOf('async function startWhatsAppLink()')));
  assert.match(start, /if \(_whatsappDownReason === 'env'\)/, 'SYNABUN_WHATSAPP=off loads nothing');
  assert.match(SERVER, /String\(process\.env\.SYNABUN_WHATSAPP \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'off' \? 'env' : 'starting'/);
  assert.match(start, /await import\('\.\/lib\/whatsapp\/service\.js'\)/, 'a guarded dynamic import');
  assert.match(start, /getRuntime: \(\) => _assistantRuntime,\s*getDispatcher: \(\) => _assistantDispatcher,/);
  assert.match(start, /getKvConfig, setKvConfig, broadcastSync, isGuestRequest,/);
  assert.match(start, /getDefaultBrain: readAssistantPanelBrain,/);
  assert.doesNotMatch(start, /policy:|createRemotePolicyRegistry/, 'no second remote-policy registry');
  assert.match(start, /catch \(err\) \{\s*_whatsappDownReason = 'error';/, 'a failure degrades to unavailable');
  assert.match(SERVER, /\/\/ WhatsApp Link: after the runtime and dispatcher exist[^\n]*\n  await startWhatsAppLink\(\);\n\}\)\(\);/, 'called at the end of the Assistant block');
  // The panel's last-used brain key.
  assert.equal(KEYS.ASSISTANT_BRAIN, 'neural-assistant-brain');
  assert.match(SERVER, /loadUiState\(\)\['neural-assistant-brain'\]/);
});

test('the npm tarball ships every connector file (the lock as npm-shrinkwrap.json), the vendored QR code and the docs', { timeout: 120_000 }, () => {
  const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
  });
  const files = new Set(JSON.parse(out)[0].files.map((f) => f.path));
  for (const name of CONNECTOR_FILES) assert.ok(files.has(`neural-interface/lib/whatsapp/connector/${name}`), `ships connector/${name}`);
  assert.deepEqual([...CONNECTOR_FILES].sort(), ['entry.mjs', 'manifest.json', 'npm-shrinkwrap.json', 'package.json']);
  assert.ok(!files.has('neural-interface/lib/whatsapp/connector/package-lock.json'));
  for (const path of ['neural-interface/lib/whatsapp/vendor/qrcodegen.js', 'neural-interface/lib/whatsapp/host.js', 'neural-interface/lib/http-guards.js', 'neural-interface/lib/remote-policy.js', 'docs/whatsapp.md']) {
    assert.ok(files.has(path), `ships ${path}`);
  }
  // The notices the vendored QR code and the on-demand connector are listed in travel with the code.
  for (const path of ['NOTICE', 'THIRD-PARTY-LICENSES.md', 'LICENSE']) assert.ok(files.has(path), `ships ${path}`);
});

test('WA_HOME and runtime/whatsapp live outside DATA_HOME/data (backups never copy a live session)', () => {
  for (const platform of ['darwin', 'linux']) {
    const dataHome = '/home/ana/.synabun';
    const paths = resolveWhatsAppPaths({ dataHome, env: {}, platform });
    const dataDir = `${dataHome}/data`;
    assert.equal(isInside(paths.waHome, dataDir, platform), false, `${platform} waHome`);
    assert.equal(isInside(paths.authDir, dataDir, platform), false, `${platform} authDir`);
    assert.equal(isInside(paths.runtimeDir, dataDir, platform), false, `${platform} runtimeDir`);
    const inside = resolveWhatsAppPaths({ dataHome, env: { SYNABUN_WHATSAPP_HOME: `${dataDir}/wa` }, platform });
    assert.equal(inside.waHome, paths.waHome, 'an override inside data/ is refused');
    assert.equal(inside.warnings.length, 1);
  }
  const win = resolveWhatsAppPaths({ dataHome: 'C:\\Users\\Ana\\.synabun', env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' }, platform: 'win32' });
  assert.equal(win.waHome, 'C:\\Users\\Ana\\AppData\\Local\\synabun\\whatsapp', 'Windows: not in a roaming profile');
  assert.equal(isInside(win.runtimeDir, 'C:\\Users\\Ana\\.synabun\\data', 'win32'), false);
});
