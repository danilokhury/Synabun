import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('server exposes the package root as the startup project directory', () => {
  const server = read('neural-interface/server.js');

  const offlineStart = server.indexOf("app.get('/offline.html'");
  const offlineEnd = server.indexOf("app.use('/i18n'", offlineStart);
  const offlineRoute = server.slice(offlineStart, offlineEnd);
  assert.match(offlineRoute, /JSON\.stringify\(PACKAGE_ROOT\)/);
  assert.doesNotMatch(offlineRoute, /JSON\.stringify\(DATA_HOME\)/);

  const onboardingStart = server.indexOf("app.get('/api/setup/onboarding'");
  const onboardingEnd = server.indexOf("app.post('/api/setup/save-config'", onboardingStart);
  const onboardingRoute = server.slice(onboardingStart, onboardingEnd);
  assert.match(onboardingRoute, /projectDir: PACKAGE_ROOT/);
  assert.match(onboardingRoute, /packageRoot: PACKAGE_ROOT/);
  assert.match(onboardingRoute, /dataHome: DATA_HOME/);

  const healthStart = server.indexOf("app.get('/api/health'");
  const healthEnd = server.indexOf("app.post('/api/health/start'", healthStart);
  const healthRoute = server.slice(healthStart, healthEnd);
  assert.match(healthRoute, /projectDir: PACKAGE_ROOT/);
  assert.doesNotMatch(healthRoute, /projectDir: DATA_HOME/);
});

test('offline command caches and uses the installation directory', () => {
  const loading = read('neural-interface/public/shared/ui-loading.js');
  const offline = read('neural-interface/public/offline.html');

  assert.match(loading, /localStorage\.setItem\('synabun-project-dir', health\.projectDir\)/);
  assert.match(offline, /localStorage\.getItem\('synabun-project-dir'\)/);
  assert.match(offline, /const sep = isWin \? ' & ' : ' ; '/);
  assert.match(offline, /`cd "\$\{projectDir\}"\$\{sep\}npm start`/);
});

test('onboarding keeps writable data home separate from package root', () => {
  const onboarding = read('neural-interface/public/onboarding.html');

  assert.match(onboarding, /dataHome: ''/);
  assert.match(onboarding, /wizardState\.dataHome = data\.dataHome/);
  assert.match(onboarding, /const dataHome = \(wizardState\.dataHome \|\| ''\)/);
  assert.match(onboarding, /const pkgRoot = \(wizardState\.packageRoot \|\| dataHome\)/);
  assert.doesNotMatch(onboarding, /wizardState\.projectRoot/);
});
