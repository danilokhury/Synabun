import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidepanelController, readSidepanelLayout, clampSidepanelRect, resizeSidepanelRect } from '../public/shared/ui-sidepanel-state.js';

function harness(saved = new Map()) {
  const callbacks = [];
  let lastFocused;
  const controller = createSidepanelController({
    load: provider => saved.get(provider),
    save: (provider, value) => saved.set(provider, value),
    focused: view => { lastFocused = view.provider; },
  });
  const register = (id, provider = id) => controller.register({ id, provider,
    applyVisibility: visible => callbacks.push([id, visible]) });
  for (const provider of ['claude', 'codex', 'opencode']) register(provider);
  const visible = () => controller.all().filter(view => view.visible).map(view => view.id).sort();
  return { controller, callbacks, saved, register, visible, focused: () => lastFocused };
}

test('opening and redocking replace only the docked provider, preserving floats', () => {
  const { controller: c, visible } = harness();
  c.setVisible('claude', true);
  c.setMode('claude', 'floating');
  c.setVisible('codex', true);
  assert.deepEqual(visible(), ['claude', 'codex']);
  c.setVisible('opencode', true);
  assert.deepEqual(visible(), ['claude', 'opencode']);
  c.setMode('claude', 'docked');
  assert.deepEqual(visible(), ['claude']);
  c.setVisible('codex', true);
  assert.deepEqual(visible(), ['codex']);
});

test('all providers can float, and presentation changes never reapply session visibility', () => {
  const { controller: c, visible, callbacks } = harness();
  for (const provider of ['claude', 'codex', 'opencode']) {
    c.setVisible(provider, true);
    c.setMode(provider, 'floating');
  }
  assert.deepEqual(visible(), ['claude', 'codex', 'opencode']);
  assert.equal(callbacks.length, 3);
  const calls = callbacks.length;
  c.updateLayout('codex', { rect: { x: 40, y: 60, width: 400, height: 500 } });
  c.focus('claude');
  c.setMode('codex', 'docked');
  c.setMode('codex', 'docked');
  c.setVisible('codex', true);
  assert.equal(callbacks.length, calls);
});

test('minimize and restore retain geometry and do not hide another floating provider', () => {
  const { controller: c, visible } = harness();
  const rect = { x: 80, y: 90, width: 480, height: 600 };
  c.setMode('codex', 'floating');
  c.updateLayout('codex', { rect, dockedWidth: 350 });
  c.setVisible('codex', true);
  c.setVisible('codex', false);
  c.setMode('claude', 'floating');
  c.setVisible('claude', true);
  c.setVisible('codex', true);
  assert.deepEqual(visible(), ['claude', 'codex']);
  assert.deepEqual(c.get('codex').layout, { version: 1, mode: 'floating', rect, dockedWidth: 350 });
});

test('OpenCode parent/child views share a layout and exclude only the other provider view', () => {
  const { controller: c, register, visible } = harness();
  register('child', 'opencode');
  c.setMode('opencode', 'floating');
  c.updateLayout('opencode', { rect: { x: 30, y: 70, width: 400, height: 500 } });
  c.setVisible('claude', true);
  c.setVisible('opencode', true);
  c.setVisible('child', true);
  assert.deepEqual(visible(), ['child', 'claude']);
  assert.equal(c.get('opencode').layout, c.get('child').layout);
  c.setMode('child', 'docked');
  assert.deepEqual(visible(), ['child']);
  c.setVisible('opencode', true);
  assert.deepEqual(visible(), ['opencode']);
  c.unregister('child');
  assert.deepEqual(visible(), ['opencode']);
});

test('separate sessions of one provider keep independent visibility, geometry, and docking', () => {
  const { controller: c, visible } = harness();
  for (const id of ['codex-two', 'codex-three']) {
    c.register({ id, provider: 'codex', layoutKey: id, applyVisibility() {} });
    c.setMode(id, 'floating');
    c.setVisible(id, true);
  }
  c.setMode('codex', 'floating');
  c.setVisible('codex', true);
  assert.deepEqual(visible(), ['codex', 'codex-three', 'codex-two']);
  c.updateLayout('codex-two', { rect: { x: 20, y: 60, width: 400, height: 500 } });
  assert.equal(c.get('codex-three').layout.rect, null);
  c.setVisible('claude', true);
  c.setMode('codex-two', 'docked');
  assert.deepEqual(visible(), ['codex', 'codex-three', 'codex-two']);
  c.unregister('codex-two');
  assert.deepEqual(visible(), ['codex', 'codex-three']);
});

test('persistent layout restores without opening sessions or persisting live ownership', () => {
  const { controller: c, saved } = harness();
  const rect = { x: 90, y: 100, width: 420, height: 560 };
  c.setMode('codex', 'floating');
  c.updateLayout('codex', { rect, dockedWidth: 380 });
  c.setVisible('codex', true);
  c.persist('codex');
  const reloaded = harness(saved);
  assert.deepEqual(reloaded.visible(), []);
  assert.deepEqual(reloaded.controller.get('codex').layout.rect, rect);
  assert.equal(reloaded.controller.get('codex').layout.mode, 'floating');
  assert.equal(reloaded.callbacks.length, 0);
  assert.equal(JSON.parse(saved.get('codex')).visible, undefined);
});

test('focus follows exactly the last visible provider that was selected', () => {
  const { controller: c, focused } = harness();
  c.setMode('claude', 'floating');
  c.setVisible('claude', true);
  c.setVisible('codex', true);
  assert.equal(focused(), 'codex');
  c.focus('claude');
  assert.equal(focused(), 'claude');
  c.focus('opencode');
  assert.equal(focused(), 'claude');
});

test('invalid saved records fall back safely; invalid geometry never becomes CSS', () => {
  for (const value of [null, '{}', 'broken', '{"version":2,"mode":"floating"}']) {
    assert.deepEqual(readSidepanelLayout(value), { version: 1, mode: 'docked', rect: null, dockedWidth: null });
  }
  const saved = readSidepanelLayout({ version: 1, mode: 'floating', dockedWidth: 9000,
    rect: { x: Infinity, y: 0, width: -1, height: 700 } });
  assert.equal(saved.rect, null);
  assert.equal(saved.dockedWidth, 700);
});

test('rectangles remain reachable below the navbar, including very small screens', () => {
  assert.deepEqual(clampSidepanelRect({ x: -100, y: -60, width: 400, height: 500 },
    { width: 1200, height: 800, top: 48 }), { x: 8, y: 56, width: 400, height: 500 });
  assert.deepEqual(clampSidepanelRect({ x: 1400, y: 900, width: 600, height: 700 },
    { width: 300, height: 280, top: 48 }), { x: 8, y: 56, width: 284, height: 216 });
});

test('resizing clamps against viewport edges while keeping the opposite corner fixed', () => {
  const rect = { x: 100, y: 100, width: 400, height: 400 };
  const viewport = { width: 1000, height: 800, top: 48 };
  const resized = resizeSidepanelRect(rect, 'nw', -1000, -1000, viewport);
  assert.deepEqual(resized, { x: 8, y: 56, width: 492, height: 444 });
  assert.equal(resized.x + resized.width, rect.x + rect.width);
  assert.equal(resized.y + resized.height, rect.y + rect.height);
  assert.deepEqual(resizeSidepanelRect(rect, 'se', 3000, 3000, viewport),
    { x: 100, y: 100, width: 892, height: 692 });
  assert.deepEqual(resizeSidepanelRect(rect, 'nw', 3000, 3000, viewport),
    { x: 180, y: 180, width: 320, height: 320 });
});
