import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { placeNote, arrowPoints, overlaps, overlapArea, lengthInside, unionRect, visibleRect, outlineShape, outlineRect } from '../public/shared/ui-tutorial-layout.js';
import { TUTORIAL_STEPS, FEATURE_STEPS, ONBOARDING_STEPS, SKIP_HINT, CHAPTERS, resumeIndex, buildExplorePrompt } from '../public/shared/ui-tutorial-steps.js';

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const NOTE_WIDTH = 480;

for (const [width, height] of [[1920, 1080], [1280, 800], [768, 1024], [375, 812], [320, 640]]) {
  test(`notes reflow and avoid their own targets at ${width}×${height}`, () => {
    const targets = [rect(width - 56, 8, 32, 32), rect(16, 120, 44, 380), rect(width / 3, 44, 150, 28)];
    for (const target of targets) {
      for (const noteHeight of [280, 340, 460]) {
        const note = placeNote(target, width, height, NOTE_WIDTH, noteHeight);
        assert.ok(visibleRect(note, width, height));
        assert.equal(overlaps(note, target), false);
        const arrow = arrowPoints(note, outlineRect(target, width, height));
        for (const point of Object.values(arrow)) {
          assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
          assert.ok(point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height);
        }
      }
    }
  });
}

test('a dropdown makes the note choose the free side', () => {
  const target = rect(450, 70, 160, 28), dropdown = rect(430, 48, 200, 520);
  const note = placeNote(target, 1280, 800, NOTE_WIDTH, 340, { avoid: [dropdown] });
  assert.equal(overlaps(note, dropdown, 12), false);
});

test('the note leaves the title bar, the toolbars and the session pills visible when it can', () => {
  // The live 1470×835 layout: title bar, top-right toolbar, session pills, whiteboard toolbar.
  const keep = [rect(0, 0, 1470, 59), rect(810, 79, 640, 40), rect(1290, 125, 160, 212), rect(20, 170, 42, 496)];
  const dropdown = rect(583, 48, 229, 240);
  const cases = [
    [rect(1304, 83, 108, 32), []],          // the side-panel buttons, inside the top-right toolbar
    [rect(962, 84, 30, 30), []],            // Memory Explorer
    [rect(591, 63, 213, 28), [dropdown]],   // Automation Studio, in its open menu
    [rect(591, 100, 213, 27), [dropdown]],  // Schedules, one row lower
    [rect(1262, 14, 30, 30), []],           // the ? button, in the title bar
    [rect(469, 16, 57, 26), []],            // a menubar label
  ];
  for (const [target, avoid] of cases) {
    const note = placeNote(target, 1470, 835, NOTE_WIDTH, 310, { avoid, keep });
    assert.equal(overlaps(note, target), false);
    assert.equal(avoid.some(r => overlaps(note, r, 12)), false);
    assert.equal(keep.reduce((sum, r) => sum + overlapArea(note, r), 0), 0, `note covers chrome for target at ${target.left},${target.top}`);
  }
});

test('the arrow to a menu entry does not run across the rest of the menu', () => {
  // 1920×1080: the Automations dropdown, its first two entries, the chrome on the right.
  const keep = [rect(0, 0, 1920, 59), rect(1260, 79, 640, 40), rect(1740, 125, 160, 520), rect(20, 290, 42, 496)];
  const dropdown = rect(583, 48, 229, 240);
  for (const target of [rect(591, 63, 213, 28), rect(591, 100, 213, 27)]) {
    const note = placeNote(target, 1920, 1080, NOTE_WIDTH, 310, { avoid: [dropdown], keep });
    const { from, to } = arrowPoints(note, outlineRect(target, 1920, 1080), 6);
    assert.ok(lengthInside(from, to, dropdown) < 24, `arrow crosses the menu for ${target.top}`);
    assert.equal(overlaps(note, dropdown, 12), false);
  }
  assert.equal(Math.round(lengthInside({ x: 0, y: 5 }, { x: 100, y: 5 }, rect(20, 0, 30, 10))), 30);
  assert.equal(lengthInside({ x: 0, y: 50 }, { x: 100, y: 50 }, rect(20, 0, 30, 10)), 0);
});

test('a menu entry gets the note beside it even when the free gap is narrow', () => {
  // 1470×835: 521 px between the whiteboard toolbar and the Automations dropdown.
  const keep = [rect(0, 0, 1470, 59), rect(810, 79, 640, 40), rect(1290, 125, 160, 330), rect(20, 170, 42, 496)];
  const dropdown = rect(583, 48, 229, 240), target = rect(591, 63, 213, 28);
  const note = placeNote(target, 1470, 835, NOTE_WIDTH, 307, { avoid: [dropdown], keep, near: rect(768, 151, 480, 307) });
  assert.equal(keep.reduce((sum, r) => sum + overlapArea(note, r), 0), 0);
  const { from, to } = arrowPoints(note, outlineRect(target, 1470, 835), 6);
  assert.ok(Math.hypot(to.x - from.x, to.y - from.y) < 80, 'the arrow stays short');
});

test('the note stays put between neighbouring targets instead of jumping across the screen', () => {
  const keep = [rect(0, 0, 1470, 59), rect(810, 79, 640, 40)], avoid = [rect(583, 48, 229, 240)];
  const first = placeNote(rect(591, 63, 213, 28), 1470, 835, NOTE_WIDTH, 310, { avoid, keep });
  const second = placeNote(rect(591, 100, 213, 27), 1470, 835, NOTE_WIDTH, 310, { avoid, keep, near: first });
  assert.ok(Math.hypot(second.left - first.left, second.top - first.top) < 80);
});

test('missing targets stay centered and inside the viewport', () => {
  assert.ok(visibleRect(placeNote(null, 320, 640, NOTE_WIDTH, 800), 320, 640));
  const note = placeNote(null, 1920, 1080, NOTE_WIDTH, 300);
  assert.equal(note.left, (1920 - NOTE_WIDTH) / 2);
});

test('an outline wraps its target whatever the shape', () => {
  assert.equal(outlineShape(rect(0, 0, 30, 30)), 'ring');
  assert.equal(outlineShape(rect(0, 0, 32, 22)), 'ring');
  assert.equal(outlineShape(rect(0, 0, 42, 496)), 'box');   // the whiteboard toolbar
  assert.equal(outlineShape(rect(0, 0, 57, 26)), 'box');    // a word in the menubar
  assert.equal(outlineShape(rect(0, 0, 683, 40)), 'box');   // the Assistant's message box
  for (const target of [rect(962, 84, 30, 30), rect(20, 170, 42, 496), rect(759, 729, 683, 40), rect(1112, 95, 32, 22)]) {
    const outline = outlineRect(target, 1470, 835);
    assert.ok(outline.left < target.left && outline.top < target.top && outline.right > target.right && outline.bottom > target.bottom);
    assert.ok(visibleRect(outline, 1470, 835));
    if (outlineShape(target) === 'ring') {
      // An ellipse contains a rect when its corners are inside: (w/2a)² + (h/2b)² ≤ 1.
      assert.ok((target.width / outline.width) ** 2 + (target.height / outline.height) ** 2 <= 1);
    }
  }
  // At the viewport edge the outline is clamped, never drawn off screen.
  assert.ok(visibleRect(outlineRect(rect(1262, 0, 30, 30), 1280, 800), 1280, 800));
});

test('the arrow runs between facing edges and stops outside the outline', () => {
  const target = rect(20, 170, 42, 496), note = rect(118, 264, 480, 307);
  const beside = arrowPoints(note, target, 6);
  assert.ok(beside.from.x < note.left && beside.to.x > target.right);
  assert.ok(beside.to.y >= target.top && beside.to.y <= target.bottom);
  const below = arrowPoints(rect(737, 170, 480, 310), rect(953, 72, 49, 52), 6);
  assert.ok(below.from.y < 170 && below.to.y > 124);
  assert.deepEqual(unionRect([rect(0, 0, 10, 10), null, rect(20, 5, 10, 10)]), { left: 0, top: 0, right: 30, bottom: 15, width: 30, height: 15 });
});

test('resume keeps new ids, migrates retained legacy indices, and excludes returning onboarding', () => {
  const welcome = TUTORIAL_STEPS.findIndex(s => s.id === 'welcome');
  assert.equal(resumeIndex(null), welcome);
  assert.equal(resumeIndex('assistant-route'), TUTORIAL_STEPS.findIndex(s => s.id === 'assistant-route'));
  assert.equal(resumeIndex('18'), TUTORIAL_STEPS.findIndex(s => s.id === 'explain-memory-explorer'));
  assert.equal(resumeIndex('onboarding-model-picker'), welcome);
  assert.equal(resumeIndex('onboarding-model-picker', true), 3);
  assert.equal(resumeIndex('garbage'), welcome);
  assert.equal(resumeIndex(null, true), 0);
  assert.equal(FEATURE_STEPS.length, 14);
});

test('the storyboard is well formed', () => {
  assert.equal(new Set(TUTORIAL_STEPS.map(s => s.id)).size, TUTORIAL_STEPS.length);
  assert.deepEqual(CHAPTERS, ['memory', 'workspace', 'tools', 'automation', 'assistant', 'help']);
  for (const step of FEATURE_STEPS) {
    assert.ok(step.targets.length > 0, step.id);
    for (const [selector, copy = 'body'] of step.targets) assert.ok(typeof selector === 'string' && selector && copy, step.id);
  }
  // Steps that share a menu sit together, so it opens once.
  const menus = FEATURE_STEPS.map(s => s.menu || '').filter((m, i, all) => m !== all[i - 1]).filter(Boolean);
  assert.equal(new Set(menus).size, menus.length);
  // The Assistant chapter always has its real entry point to fall back on.
  for (const step of FEATURE_STEPS.filter(s => s.panel === 'assistant')) {
    assert.deepEqual(step.targets.at(-1), ['#topright-assistant-panel-btn', 'closed']);
  }
  assert.match(buildExplorePrompt('myapp'), /name: "myapp-architecture"/);
});

test('every step has its copy in every shipped locale, with the same placeholders', () => {
  const load = (locale) => JSON.parse(readFileSync(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8').replace(/^﻿/, '')).tutorial;
  const en = load('en'), pt = load('pt-BR');
  const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
  const enKeys = new Map(flat(en)), ptKeys = new Map(flat(pt));
  assert.deepEqual([...ptKeys.keys()].sort(), [...enKeys.keys()].sort());
  const holes = (text) => (text.match(/\{\w+\}/g) || []).sort().join();
  for (const [key, text] of enKeys) assert.equal(holes(ptKeys.get(key)), holes(text), key);
  for (const step of [...ONBOARDING_STEPS, { id: 'welcome' }, ...FEATURE_STEPS, SKIP_HINT]) {
    const copy = en.steps[step.id];
    assert.ok(copy?.title && copy.body, step.id);
    for (const [, key = 'body'] of step.targets || []) assert.ok(copy[key], `${step.id}.${key}`);
    for (const key of Object.values(step.copy || {})) assert.ok(copy[key], `${step.id}.${key}`);
    // One idea per step: at most two sentences.
    for (const text of Object.values(copy).slice(1)) assert.ok(text.split(/[.?!](?:\s|”|$)/).filter(s => s.trim()).length <= 3, `${step.id}: ${text}`);
  }
  for (const chapter of CHAPTERS) assert.ok(en.chapters[chapter] && pt.chapters[chapter]);
});
