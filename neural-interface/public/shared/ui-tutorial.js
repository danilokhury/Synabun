// A reversible, viewport-based tour shared by both variants. It annotates the
// user's current view: no config writes, forced focus mode or session creation.
// What it changes to show a step (an open menu, the Assistant panel) it puts back.
import { storage, flushStorage } from './storage.js';
import { state, emit, on } from './state.js';
import { KEYS } from './constants.js';
import { t } from './i18n.js';
import { registerHelpSection, getVariant } from './registry.js';
import { TUTORIAL_STEPS, FEATURE_STEPS, SKIP_HINT, CHAPTERS, buildExplorePrompt, resumeIndex } from './ui-tutorial-steps.js';
import { CLI_PROFILES, ensureModelsForProfile, modelSelectorValue, formatModelOptionLabel } from './agent-runtime-options.js';
import { isAssistantPanelOpen, toggleAssistantPanel, assistantPanelPeekable } from './assistant/asst-sidepanel.js';
import { createOutline, createAnimatedArrow, createHandDrawnUnderline, createDoodle } from './ui-tutorial-draw.js';
import { visibleRect, unionRect, outlineShape, outlineRect, placeNote, arrowPoints } from './ui-tutorial-layout.js';

const NS = 'http://www.w3.org/2000/svg';
const INK = '#6da4ff';                       // target outline, arrow, underline (Style Guide dark primary)
const CHALK = 'rgba(240, 243, 247, 0.62)';   // the note's own outline
const DRAW = 250;                            // one stroke (Style Guide motion "normal")
const ERASE = 120;                           // the previous step's strokes fading out
const SETTLE_MAX = 600;                      // longest wait for an opening menu or panel to stop moving
const GUARDED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
  'touchstart', 'dragstart', 'pointerover', 'mouseover', 'mouseenter', 'mousemove'];
// Chrome the note leaves visible when there is free space.
const KEEP_CLEAR = ['#title-bar', '#topright-controls', '#term-minimized-tray', '#wb-toolbar'];
const PEER_PANEL_BUTTONS = ['#topright-claude-panel-btn', '#topright-codex-panel-btn', '#topright-opencode-panel-btn'];
// Names the copy mentions, read off the control on screen so the text matches it
// in every locale; the i18n key covers a control that is not in the DOM.
const NAMES = {
  explorer: ['#topright-memory-explorer-btn', 'tutorial.names.explorer'],
  focus: ['#titlebar-viz-toggle', 'tooltip.toggleViz'],
  apps: ['[data-menu="apps"] > .menubar-label', 'nav.apps'],
  browser: ['#menu-terminal-browser', 'menu.apps.browser'],
  studio: ['#menu-open-automation-studio', 'menu.automations.studio'],
  schedules: ['#menu-automations-schedules', 'tutorial.names.schedules'],
  keybinds: ['#topright-keybinds-btn', 'tutorial.names.keybinds'],
  settings: ['#menubar-settings-btn', 'nav.settings'],
  projects: [null, 'settings.redesign.nav.projects.label'],
  computer: [null, 'assistant.computer.toggle'],
  more: [null, 'assistant.toolbar.more'],
  budget: [null, 'assistant.budget.title'],
};
const WELCOME = TUTORIAL_STEPS.findIndex(s => s.id === 'welcome');

let active = false, initialized = false, index = WELCOME, firstRun = false, skipHint = false, resumed = false;
let svg, dom, note, ui, observer, targetObserver, previousFocus, nextButton;
let inks = {}; // the strokes on screen, by part: { g, key }
let menuState = [], panelPeek = null, passthrough = false, placed = false, lastBox = null;
let onScreen = null; // the step whose text is in the note: the next one is drawn only once its target holds still
let timers = new Set(), generation = 0, resizeFrame = 0, stepAbort = null;
let offLoaded = null, autoTimer = null, lastGeometry = '', beforeAdvance = null, onPrimary = null, onLater = null, ready = null;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const tr = (key, params) => t(`tutorial.${key}`, params);
const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
const currentStep = () => (skipHint ? SKIP_HINT : TUTORIAL_STEPS[index]);

function later(fn, ms) {
  const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
  timers.add(id);
  return id;
}
function clearStep() {
  generation++;
  for (const id of timers) clearTimeout(id);
  timers.clear();
  stepAbort?.abort(); stepAbort = null;
}

// ── What the copy and the annotations read from the live UI ──

function names() {
  const out = {};
  for (const [name, [selector, key]] of Object.entries(NAMES)) {
    const el = selector && document.querySelector(selector);
    const label = el && (el.querySelector('.menu-text')?.textContent || el.dataset.tooltip || el.textContent);
    // A tooltip may end in its shortcut: "Focus Mode (V)".
    out[name] = label?.replace(/\s*\([^)]*\)\s*$/, '').trim() || t(key);
  }
  out.menu = document.querySelector('[data-menu="graph"] > .menubar-label')?.textContent.trim()
    || t(getVariant() === '2d' ? 'nav.graph' : 'nav.map');
  out.view = out.menu.toLocaleLowerCase();
  return out;
}
// A dropdown the tour opened is still fading in when its item is first measured.
const shown = (el) => !el.checkVisibility
  || el.checkVisibility({ checkOpacity: !el.closest('.menubar-item.open, #assistant-panel.open'), checkVisibilityCSS: true });
function targetRect(selector, lastSelector) {
  for (const el of document.querySelectorAll(selector)) {
    if (!shown(el)) continue;
    const last = lastSelector && document.querySelector(lastSelector);
    const rect = unionRect([el.getBoundingClientRect(), last && shown(last) ? last.getBoundingClientRect() : null]);
    if (visibleRect(rect, innerWidth, innerHeight)) return rect;
  }
  return null;
}
// The first alternative on screen. A hidden toolbar (or a guest's missing control) leaves `missing`.
function resolveStep(step) {
  const targets = step.targets || [];
  for (let i = 0; i < targets.length; i++) {
    const [selector, copy = 'body', lastSelector] = targets[i];
    const rect = targetRect(selector, lastSelector);
    if (rect) return { rect, alternative: i, copy: i === 0 && step.copy?.[getVariant()] || copy, missing: false };
  }
  return { rect: null, alternative: -1, copy: step.copy?.[getVariant()] || 'body', missing: targets.length > 0 };
}

// ── What the tour changes to show a step, and puts back ──

function showStage(step) {
  for (const [el, open] of menuState) {
    if (el.isConnected) el.classList.toggle('open', step.menu ? el.dataset.menu === step.menu : open);
  }
  if (step.panel !== 'assistant') { hidePanelPeek(); return; }
  // With no session tab, opening the Assistant starts a session: its button is annotated instead.
  if (panelPeek || isAssistantPanelOpen() || !assistantPanelPeekable()) return;
  panelPeek = {
    peers: PEER_PANEL_BUTTONS.map(s => document.querySelector(s)).filter(b => b?.classList.contains('active')),
    lastActivePanel: state.lastActivePanel, lastActiveSidepanel: state.lastActiveSidepanel,
  };
  toggleAssistantPanel();
}
function hidePanelPeek() {
  if (!panelPeek) return;
  const peek = panelPeek; panelPeek = null;
  if (isAssistantPanelOpen()) toggleAssistantPanel();
  // Showing the Assistant hid the docked panel that was open: bring it back.
  passthrough = true;
  for (const button of peek.peers) if (!button.classList.contains('active')) button.click();
  passthrough = false;
  state.lastActivePanel = peek.lastActivePanel; state.lastActiveSidepanel = peek.lastActiveSidepanel;
}
function restoreStage() {
  for (const [el, open] of menuState) if (el.isConnected) el.classList.toggle('open', open);
  hidePanelPeek();
}

export function initTutorial() {
  if (initialized) return;
  initialized = true;
  const css = node('link'); css.rel = 'stylesheet'; css.href = '/shared/ui-tutorial.css'; css.id = 'tutorial-styles';
  // The first note is measured with its stylesheet and handwriting font in place.
  ready = Promise.race([
    Promise.all([new Promise(done => { css.onload = css.onerror = done; }),
      document.fonts?.load("700 34px 'Caveat'").catch(() => {}), document.fonts?.load("26px 'Caveat'").catch(() => {})]),
    new Promise(done => setTimeout(done, 1200)),
  ]);
  document.head.append(css);
  const opener = document.querySelector('#titlebar-tutorial-btn');
  if (opener) {
    opener.dataset.tooltip = tr('title');
    opener.setAttribute('aria-label', tr('title'));
    opener.setAttribute('aria-pressed', 'false');
  }
  // No HTML interpolation of translations: help registration accepts static HTML.
  const help = node('div', 'help-section');
  help.append(node('div', 'help-section-title', tr('title')), node('div', 'help-row', tr('helpDescription')));
  registerHelpSection({ order: 95, html: help.outerHTML });
  if (![KEYS.TUTORIAL_COMPLETED, KEYS.TUTORIAL_SKIPPED, KEYS.TUTORIAL_STARTED].some(k => storage.getItem(k))) {
    offLoaded = on('data-loaded', () => {
      offLoaded?.(); offLoaded = null;
      autoTimer = setTimeout(() => { autoTimer = null; if (!active) startTutorial(false); }, 500);
    });
  }
}

export { resumeIndex } from './ui-tutorial-steps.js';

// Navbar calls startTutorial(true): it is a toggle, preserving every choice.
export function startTutorial(manual = false) {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  offLoaded?.(); offLoaded = null;
  if (active) { destroyTutorial(); return; }
  firstRun = !manual && !storage.getItem(KEYS.TUTORIAL_COMPLETED) && !storage.getItem(KEYS.TUTORIAL_SKIPPED);
  index = resumeIndex(storage.getItem(KEYS.TUTORIAL_STEP), firstRun);
  resumed = index > WELCOME + 1;
  active = true; skipHint = false; placed = false; onScreen = null; lastBox = null; lastGeometry = ''; previousFocus = document.activeElement;
  menuState = [...document.querySelectorAll('.menubar-item')].map(el => [el, el.classList.contains('open')]);
  storage.setItem(KEYS.TUTORIAL_STARTED, 'true');
  svg = document.createElementNS(NS, 'svg'); svg.id = 'wb-tutorial'; svg.setAttribute('aria-hidden', 'true');
  dom = node('div'); dom.id = 'wb-tutorial-dom';
  buildNote();
  // Keep showcase menus and the underlying board from handling tour controls.
  for (const event of ['click', 'pointerdown', 'wheel']) dom.addEventListener(event, e => e.stopPropagation());
  document.body.append(dom, svg);
  document.querySelector('#titlebar-tutorial-btn')?.setAttribute('aria-pressed', 'true');
  window.addEventListener('keydown', keyHandler, true);
  for (const event of GUARDED) window.addEventListener(event, guardPointer, true);
  window.addEventListener('wheel', guardWheel, { capture: true, passive: false });
  window.addEventListener('focusin', guardFocus, true);
  window.addEventListener('resize', scheduleLayout);
  window.visualViewport?.addEventListener('resize', scheduleLayout);
  document.addEventListener('transitionend', onSettled, true);
  window.addEventListener('pagehide', destroyTutorial);
  observer = new ResizeObserver(scheduleLayout);
  observer.observe(note);
  targetObserver = new MutationObserver(records => {
    if (records.some(r => !r.target.closest?.('#wb-tutorial, #wb-tutorial-dom'))) scheduleLayout();
  });
  targetObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'hidden'], childList: true, subtree: true });
  emit('tutorial:start');
  const token = ++generation;
  (ready || Promise.resolve()).then(() => { if (active && token === generation) renderStep(); });
}

export function destroyTutorial() {
  if (!active) return;
  clearStep(); active = false;
  cancelAnimationFrame(resizeFrame); resizeFrame = 0;
  observer?.disconnect(); observer = null;
  targetObserver?.disconnect(); targetObserver = null;
  svg?.remove(); dom?.remove(); svg = dom = note = ui = nextButton = null; inks = {};
  window.removeEventListener('keydown', keyHandler, true);
  for (const event of GUARDED) window.removeEventListener(event, guardPointer, true);
  window.removeEventListener('wheel', guardWheel, true);
  window.removeEventListener('focusin', guardFocus, true);
  window.removeEventListener('resize', scheduleLayout);
  window.visualViewport?.removeEventListener('resize', scheduleLayout);
  document.removeEventListener('transitionend', onSettled, true);
  window.removeEventListener('pagehide', destroyTutorial);
  restoreStage(); menuState = [];
  document.querySelector('#titlebar-tutorial-btn')?.setAttribute('aria-pressed', 'false');
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
  flushStorage(); emit('tutorial:exit');
}

// ── Input: the tour is modal. Nothing reaches the board, the graph or the panels behind it ──

const allowed = (el) => !!el?.closest?.('#wb-tutorial-dom, #titlebar-tutorial-btn');
function guardPointer(e) {
  if (passthrough || allowed(e.target)) return;
  if (e.cancelable) e.preventDefault();
  e.stopImmediatePropagation();
}
function guardWheel(e) { if (!e.target.closest?.('.tour-note')) { e.preventDefault(); e.stopImmediatePropagation(); } }
// The Assistant panel focuses its composer when it opens: the keyboard stays on the tour.
function guardFocus(e) { if (!passthrough && !allowed(e.target)) focusDefault(); }
function focusDefault() {
  const launch = !skipHint && TUTORIAL_STEPS[index].kind === 'launch';
  (nextButton && !nextButton.disabled && !launch ? nextButton : note)?.focus({ preventScroll: true });
}
function keyHandler(e) {
  if (!active) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); destroyTutorial(); return; }
  if (e.key === 'Tab') {
    const controls = [...dom.querySelectorAll('button:not(:disabled):not([hidden]), select:not(:disabled)')];
    const pos = controls.indexOf(document.activeElement);
    if (pos < 0 || (!e.shiftKey && pos === controls.length - 1) || (e.shiftKey && pos === 0)) {
      e.preventDefault(); (e.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
    e.stopImmediatePropagation(); return;
  }
  if (e.target.matches?.('select')) { e.stopImmediatePropagation(); return; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'ArrowLeft') back(); else if (!nextButton.disabled) advance();
    return;
  }
  if (e.key === 'Enter' && !e.target.closest?.('button')) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (!nextButton.disabled) advance();
    return;
  }
  // Native button Enter/Space still activate; product shortcuts never leak out.
  e.stopImmediatePropagation();
}

// ── Navigation ──

function go(next) {
  if (!active || next < (firstRun ? 0 : WELCOME) || next >= TUTORIAL_STEPS.length) return;
  index = next; skipHint = false; renderStep();
}
function back() {
  if (skipHint) { skipHint = false; renderStep(); return; }
  go(index - 1);
}
function advance() {
  if (skipHint) { destroyTutorial(); return; }
  const step = TUTORIAL_STEPS[index];
  beforeAdvance?.();
  if (step.kind === 'explore') {
    storage.setItem(KEYS.ONBOARDING_EXPLORE, 'no'); go(WELCOME); return;
  }
  if (step.kind === 'launch') return; // Only the explicit launch button starts work.
  if (index === TUTORIAL_STEPS.length - 1) {
    storage.setItem(KEYS.TUTORIAL_COMPLETED, 'true'); storage.removeItem(KEYS.TUTORIAL_STEP);
    destroyTutorial(); emit('tutorial:complete'); return;
  }
  go(index + 1);
}
function skip() {
  storage.setItem(KEYS.TUTORIAL_SKIPPED, 'true');
  skipHint = true; renderStep(); emit('tutorial:skip');
}

// ── The note: one element for the whole tour, so nothing blinks between steps ──

function button(text, fn, cls = '') {
  const el = node('button', cls, text); el.type = 'button'; el.addEventListener('click', fn); return el;
}
function buildNote() {
  note = node('section', 'tour-note tour-snap'); note.tabIndex = -1;
  note.setAttribute('role', 'dialog'); note.setAttribute('aria-modal', 'true');
  note.setAttribute('aria-labelledby', 'tour-heading'); note.setAttribute('aria-describedby', 'tour-copy');
  const progress = node('div', 'tour-progress');
  const dots = node('span', 'tour-dots'); dots.setAttribute('role', 'img');
  for (const chapter of CHAPTERS) { const dot = node('span'); dot.dataset.chapter = chapter; dots.append(dot); }
  ui = {
    label: node('span'), dots,
    restart: button(tr('restart'), () => { resumed = false; go(WELCOME); }, 'tour-link'),
    body: node('div', 'tour-body'),
    prev: button(tr('back'), back),
    skip: button('', () => (onLater || skip)(), 'tour-link tour-skip'),
  };
  nextButton = button('', () => (onPrimary || advance)(), 'primary');
  progress.append(ui.label, ui.restart, dots);
  const nav = node('nav', 'tour-nav'); nav.setAttribute('aria-label', tr('navigation'));
  nav.append(ui.prev, nextButton, ui.skip);
  note.append(progress, ui.body, nav, node('p', 'tour-key-hint', tr('keys')));
  dom.append(note);
}
// Handwriting appears word by word; the text itself is ordinary DOM text.
function write(el, text, start) {
  if (reduced()) { el.textContent = text; return; }
  const words = text.split(' ');
  const pace = Math.min(26, 400 / words.length);
  el.replaceChildren();
  words.forEach((word, i) => {
    const span = node('span', 'tour-word', word);
    span.style.animationDelay = `${Math.round(start + i * pace)}ms`;
    el.append(span);
    if (i < words.length - 1) el.append(' ');
  });
}
function renderStep() {
  clearStep();
  const step = currentStep();
  if (!skipHint) storage.setItem(KEYS.TUTORIAL_STEP, step.id);
  flushStorage();
  const show = () => { showStage(step); settle(step, () => { fillNote(step); layout(true); keepFocus(step); }); };
  // Holding an arrow key runs through the steps: only the one it stops on moves the Assistant panel.
  const panelMoves = panelPeek ? step.panel !== 'assistant'
    : step.panel === 'assistant' && !isAssistantPanelOpen() && assistantPanelPeekable();
  if (panelMoves) later(show, 150); else show();
  emit('tutorial:step', { index, id: step.id });
}
// A menu or panel the tour just opened is still moving: draw once the target holds still.
function settle(step, done) {
  const staged = !!step.menu || (step.panel === 'assistant' && isAssistantPanelOpen());
  // Staged, the target is the control inside the menu or panel, not the fallback outside it.
  const inside = step.targets ? step.targets.length - (step.panel ? 1 : 0) : 0;
  const started = performance.now();
  let last = null;
  const tick = () => {
    const found = resolveStep(step);
    const now = found.rect ? [found.alternative, found.rect.left, found.rect.top, found.rect.width, found.rect.height].map(Math.round).join() : '';
    const arrived = !staged || (found.alternative >= 0 && found.alternative < inside);
    if ((now === last && arrived) || performance.now() - started > SETTLE_MAX) { done(); return; }
    last = now; later(tick, 32);
  };
  tick();
}
function fillNote(step) {
  onScreen = step; beforeAdvance = onPrimary = onLater = null;
  const found = resolveStep(step);
  const featureIndex = FEATURE_STEPS.indexOf(step);
  const setup = !!step.kind && step.kind !== 'welcome';
  note.dataset.step = step.id;
  ui.label.textContent = setup ? tr('setupProgress', { n: index + 1, total: WELCOME })
    : featureIndex >= 0 ? `${tr(`chapters.${step.chapter}`)} · ${tr('progress', { n: featureIndex + 1, total: FEATURE_STEPS.length })}`
      : tr('title');
  ui.dots.hidden = !step.chapter;
  ui.dots.setAttribute('aria-label', step.chapter ? tr(`chapters.${step.chapter}`) : '');
  for (const dot of ui.dots.children) dot.classList.toggle('current', dot.dataset.chapter === step.chapter);
  ui.restart.hidden = !(resumed && featureIndex > 0);

  const heading = node('h2'); heading.id = 'tour-heading';
  const copy = node('p', 'tour-copy'); copy.id = 'tour-copy'; copy.dataset.copy = found.copy;
  // After the target's outline and the arrow; at once when there is no target.
  const base = found.rect ? 350 : 100;
  write(heading, tr(`steps.${step.id}.title`), base);
  write(copy, tr(`steps.${step.id}.${found.copy}`, names()), base + 150);
  const unavailable = node('p', 'tour-status tour-unavailable', tr('unavailable')); unavailable.hidden = !found.missing;
  const extra = node('div', 'tour-extra');
  ui.body.replaceChildren(heading, copy, unavailable, extra);

  ui.prev.disabled = !skipHint && index <= (firstRun ? 0 : WELCOME);
  ui.skip.hidden = skipHint || index === TUTORIAL_STEPS.length - 1;
  // Past the first setup screen the way out of the exploration is "later": the tour itself is skipped from its welcome.
  const postpone = setup && step.kind !== 'explore';
  ui.skip.textContent = postpone ? tr('later') : tr('skip');
  if (postpone) onLater = () => go(WELCOME);
  nextButton.disabled = false;
  nextButton.textContent = skipHint ? tr('close') : step.kind === 'welcome' ? tr('start') : step.kind === 'explore' ? tr('later')
    : index === TUTORIAL_STEPS.length - 1 ? tr('finish') : tr('next');
  if (setup) renderOnboarding(step, extra);
}
// Focus stays on the button the user is working with; it moves only when that button is gone.
function keepFocus(step) {
  const focused = document.activeElement;
  if (!dom.contains(focused) || focused === note || focused.disabled || focused.hidden || (step.kind === 'launch' && focused === nextButton)) focusDefault();
}
function scheduleLayout() {
  if (!active || resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; layout(false); });
}
function onSettled(e) { if (!e.target.closest?.('#wb-tutorial, #wb-tutorial-dom')) scheduleLayout(); }
function lastLine(el, origin) {
  const range = document.createRange(); range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter(r => r.width > 0);
  const bottom = Math.max(...rects.map(r => r.bottom));
  const line = unionRect(rects.filter(r => r.bottom > bottom - 8));
  return { left: line.left - origin.left, bottom: line.bottom - origin.top, width: line.width };
}
// One part of the drawing (the target's strokes, the note's) is redrawn only when its geometry changed.
function redraw(part, key, motion, draw) {
  const old = inks[part];
  if (old?.key === key) return;
  if (old) {
    if (motion) { old.g.classList.add('tour-leaving'); setTimeout(() => old.g.remove(), ERASE); } else old.g.remove();
  }
  const g = document.createElementNS(NS, 'g'); svg.append(g);
  inks[part] = { g, key };
  draw(g);
}
function layout(animate) {
  // A relayout follows the step on screen; the one being prepared is not drawn early.
  const step = onScreen;
  if (!active || !note || !step) return;
  const found = resolveStep(step);
  // The view changed under an open step (the whiteboard toolbar appeared): its copy follows.
  const copy = ui.body.querySelector('#tour-copy');
  if (copy.dataset.copy !== found.copy) { copy.dataset.copy = found.copy; copy.textContent = tr(`steps.${step.id}.${found.copy}`, names()); }
  ui.body.querySelector('.tour-unavailable').hidden = !found.missing;

  const rects = (selectors) => selectors.flatMap(s => [...document.querySelectorAll(s)])
    .filter(shown).map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
  const avoid = rects(['.menubar-item.open .menubar-dropdown']), keep = rects(KEEP_CLEAR);
  const key = (...values) => values.map(v => Math.round(v)).join(',');
  const flat = (list) => list.flatMap(r => [r.left, r.top, r.width, r.height]);
  // The app redraws itself all the time: nothing the note depends on moved, nothing to do.
  const geometry = key(innerWidth, innerHeight, note.offsetWidth, note.scrollHeight, ...flat(found.rect ? [found.rect] : []), -1, ...flat(avoid), -1, ...flat(keep));
  if (geometry === lastGeometry && !animate) return;
  const moved = geometry !== lastGeometry;
  lastGeometry = geometry;
  note.style.maxHeight = '';
  const box = placeNote(found.rect, innerWidth, innerHeight, note.offsetWidth, note.offsetHeight, { avoid, keep, near: lastBox });
  note.style.maxHeight = `${box.height}px`;

  const motion = animate && !reduced();
  const glide = motion && placed && moved ? DRAW : 0;
  const stroke = (ms) => (motion ? ms : 0);
  note.classList.toggle('tour-snap', !glide);
  note.style.transform = `translate(${Math.round(box.left)}px, ${Math.round(box.top)}px)`;
  note.classList.add('tour-placed');
  placed = true; lastBox = box;
  svg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);

  // Order: the target's outline, the arrow, then the note with its text.
  let at = 0, arrowFrom = null;
  if (found.rect) {
    const shape = outlineShape(found.rect);
    const ring = outlineRect(found.rect, innerWidth, innerHeight, shape);
    const arrow = arrowPoints(box, ring, 6);
    arrowFrom = arrow.from;
    redraw('target', key(ring.left, ring.top, ring.width, ring.height, arrow.from.x, arrow.from.y, arrow.to.x, arrow.to.y), motion, (g) => {
      createOutline(g, ring, { shape, color: INK, strokeWidth: 2.5, wobbleSeed: step.id, duration: stroke(DRAW) });
      createAnimatedArrow(g, { ...arrow, color: INK, strokeWidth: 2.5, wobbleSeed: step.id,
        duration: stroke(DRAW), delay: stroke(Math.max(200, glide)) });
      at = stroke(350);
    });
  } else redraw('target', '', motion, () => {});
  // The underline is SVG, the heading is not: natural wrapping, reliable font
  // metrics and semantic copy for screen readers.
  const origin = note.getBoundingClientRect();
  const line = lastLine(ui.body.querySelector('h2'), origin);
  redraw('note', key(box.left, box.top, box.width, box.height, line.left, line.bottom, line.width, arrowFrom?.x || 0), motion, (g) => {
    const edge = { left: box.left - 5, top: box.top - 5, right: box.right + 5, bottom: box.bottom + 5, width: box.width + 10, height: box.height + 10 };
    createOutline(g, edge, { shape: 'box', radius: 18, wobble: 2.4, color: CHALK, strokeWidth: 1.6,
      wobbleSeed: `${step.id}-note`, duration: stroke(DRAW + 100), delay: Math.max(at, glide) });
    createHandDrawnUnderline(g, { left: box.left + line.left, bottom: box.top + line.bottom, width: line.width },
      { color: INK, wobbleSeed: step.id, duration: stroke(200), delay: Math.max(at, glide) + stroke(300), offset: 3 });
    // The flourish sits on the note's top corner, the one the arrow does not leave from.
    const corner = arrowFrom && arrowFrom.x > box.left + box.width / 2 && arrowFrom.y < box.top + 60 ? box.left - 8 : box.right - 22;
    createDoodle(g, step.kind === 'warning' ? 'alert' : 'sparkle', { x: corner, y: Math.max(4, box.top - 20),
      scale: 0.7, color: INK, duration: stroke(200), delay: Math.max(at, glide) + stroke(400) });
  });
}

// ── First-run setup: the optional project exploration ──

function renderOnboarding(step, content) {
  const token = generation;
  const fresh = () => active && generation === token && content.isConnected;
  const saveChoice = (key, value) => { storage.setItem(key, value); flushStorage(); };
  const field = (labelText) => {
    const label = node('label', 'tour-field', labelText);
    const select = node('select'); label.append(select); content.append(label); return select;
  };
  const option = (select, label, value) => { const o = node('option', '', label); o.value = value; select.append(o); };
  const status = (text = tr('loading')) => { const el = node('p', 'tour-status', text); el.setAttribute('role', 'status'); content.append(el); return el; };
  const retry = () => content.append(button(tr('retry'), () => renderStep()));
  if (step.kind === 'explore') {
    content.append(button(tr('explore'), () => { saveChoice(KEYS.ONBOARDING_EXPLORE, 'yes'); go(index + 1); }));
  } else if (step.kind === 'cli') {
    const choices = node('div', 'tour-options'); content.append(choices);
    nextButton.disabled = !CLI_PROFILES.some(c => c.id === storage.getItem(KEYS.ONBOARDING_CLI));
    for (const cli of CLI_PROFILES) {
      const choice = button(cli.label, () => {
        if (storage.getItem(KEYS.ONBOARDING_CLI) !== cli.id) storage.removeItem(KEYS.ONBOARDING_MODEL);
        saveChoice(KEYS.ONBOARDING_CLI, cli.id); go(index + 1);
      }, 'tour-choice');
      choice.setAttribute('aria-pressed', String(storage.getItem(KEYS.ONBOARDING_CLI) === cli.id)); choices.append(choice);
    }
  } else if (step.kind === 'model') {
    const select = field(tr('model')); select.disabled = true; nextButton.disabled = true;
    const loading = status(); let settled = false;
    const finish = (models) => {
      if (!fresh() || settled) return;
      settled = true; clearTimeout(timeout); timers.delete(timeout);
      option(select, tr('cliDefault'), '');
      for (const m of models) option(select, formatModelOptionLabel(m, { includeService: true }), modelSelectorValue(m));
      select.value = storage.getItem(KEYS.ONBOARDING_MODEL) || '';
      if (select.selectedIndex < 0) select.value = '';
      select.disabled = false; nextButton.disabled = false;
      loading.textContent = models.length ? tr('catalog') : tr('catalogUnavailable');
      select.addEventListener('change', () => saveChoice(KEYS.ONBOARDING_MODEL, select.value));
      beforeAdvance = () => saveChoice(KEYS.ONBOARDING_MODEL, select.value);
      if (!models.length) retry();
    };
    const timeout = later(() => finish([]), 8000);
    ensureModelsForProfile(storage.getItem(KEYS.ONBOARDING_CLI)).then(m => finish(Array.isArray(m) ? m : [])).catch(() => finish([]));
  } else if (step.kind === 'project') {
    const select = field(tr('project')); select.disabled = true; nextButton.disabled = true;
    const loading = status();
    stepAbort = new AbortController();
    const abort = stepAbort;
    const timeout = later(() => abort.abort(), 8000);
    fetch('/api/terminal/profiles', { signal: abort.signal }).then(r => { if (!r.ok) throw new Error('profiles'); return r.json(); }).then(data => {
      if (!fresh()) return;
      const projects = (data.projects || []).filter(p => p.path);
      const name = (p) => p.label || p.path.split(/[\\/]/).filter(Boolean).pop();
      option(select, tr('chooseProject'), '');
      projects.forEach((p, i) => option(select, name(p), String(i)));
      let prior = null; try { prior = JSON.parse(storage.getItem(KEYS.ONBOARDING_PROJECT) || 'null'); } catch { /* choose again */ }
      const existing = projects.findIndex(p => p.path === prior?.path);
      select.value = existing >= 0 ? String(existing) : '';
      select.disabled = !projects.length; nextButton.disabled = existing < 0;
      loading.textContent = projects.length ? tr('projectHint') : tr('noProjects');
      select.addEventListener('change', () => {
        const project = projects[Number(select.value)];
        nextButton.disabled = select.value === '';
        if (select.value !== '' && project) saveChoice(KEYS.ONBOARDING_PROJECT, JSON.stringify({ path: project.path, label: name(project) }));
      });
    }).catch(() => {
      if (!fresh()) return;
      loading.textContent = tr('projectsUnavailable'); retry();
    }).finally(() => { clearTimeout(timeout); timers.delete(timeout); });
    content.append(button(tr('addProject', names()), async () => {
      // Explicit user action hands off to the existing Projects settings page.
      destroyTutorial(); const { openSettingsModal } = await import('./ui-settings.js');
      await openSettingsModal({ tab: 'projects', expand: ['stg-sec-workspaces'] });
    }));
  } else if (step.kind === 'launch') {
    nextButton.textContent = tr('begin');
    // A second click meant for the previous screen must not start the CLI.
    nextButton.disabled = true; later(() => { nextButton.disabled = false; }, 600);
    const loading = status('');
    let busy = false;
    onPrimary = () => {
      if (busy || !fresh()) return;
      let project = null; try { project = JSON.parse(storage.getItem(KEYS.ONBOARDING_PROJECT) || 'null'); } catch { /* handled below */ }
      const cli = storage.getItem(KEYS.ONBOARDING_CLI);
      if (!project?.path || !CLI_PROFILES.some(c => c.id === cli)) { loading.textContent = tr('selectionMissing'); return; }
      busy = true; nextButton.disabled = true; loading.textContent = tr('launching');
      // The same category slug Settings → Projects gives an exploration.
      const slug = (project.label || project.path.split(/[\\/]/).filter(Boolean).pop() || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const model = storage.getItem(KEYS.ONBOARDING_MODEL);
      const finish = (err) => {
        if (!fresh()) return;
        clearTimeout(timeout); timers.delete(timeout);
        if (err) { busy = false; nextButton.disabled = false; loading.textContent = tr('launchFailed'); }
        else { firstRun = false; go(WELCOME); } // setup is done: Back from the welcome does not return to it
      };
      const timeout = later(() => finish(new Error('timeout')), 15000);
      try {
        emit('terminal:launch-floating', { profile: cli, cwd: project.path, createOpts: model ? { model } : {},
          initialMessage: buildExplorePrompt(slug), autoSubmit: true, onDone: finish });
      } catch (err) { finish(err); }
    };
  }
}
