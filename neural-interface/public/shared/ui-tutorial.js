// The Workspace tour's entry, and the project-exploration setup.
//
// The tour itself is public/shared/tour/: SynaBun's mascot narrates from its home in
// the Assistant panel and uses the panel as a whiteboard. This module opens it: from
// the ? button (a returning user gets the chapter list), or from the empty state's
// first-visit starter row ("Show me the workspace · 2 min", asst-panel.js). It never
// opens by itself. It presents the panel without starting a session
// (beginAssistantTour), keeps the saved cursor and the completed / skipped flags,
// and puts everything back when the tour ends.
//
// The setup (ONBOARDING_STEPS: explore → tokens → CLI → model → project → launch) is
// a separate small dialog, reached from the tour's chapter list. Only its explicit
// "Begin exploration" button starts a CLI; nothing else here starts work.
import { storage, flushStorage } from './storage.js';
import { emit, on } from './state.js';
import { KEYS } from './constants.js';
import { t } from './i18n.js';
import { registerHelpSection } from './registry.js';
import { ONBOARDING_STEPS, buildExplorePrompt } from './ui-tutorial-steps.js';
import { CLI_PROFILES, ensureModelsForProfile, modelSelectorValue, formatModelOptionLabel } from './agent-runtime-options.js';
import { beginAssistantTour } from './assistant/asst-sidepanel.js';
import { dropdownHTML, setDropdownDisabled, setDropdownItems, setDropdownValue, wireDropdowns } from './cc-dropdown.js';
import { showGuestToast } from './ui-sync.js';
import { BEATS, beatsFor, resumeBeat } from './tour/tour-beats.js';
import { markTourSeen, tourReturning } from './tour/tour-state.js';

let initialized = false;
let ready = null; // the tour's stylesheet and its handwriting, loaded once
let tour = null; // { engine, presentation }
let opening = false;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const tr = (key, params) => t(`tutorial.${key}`, params);
const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

function loadStyles() {
  if (ready) return ready;
  const sheets = ['/shared/tour/tour.css', '/shared/ui-tutorial.css', '/vendor/caveat/caveat.css'].map((href) => {
    if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
    const link = node('link');
    link.rel = 'stylesheet';
    link.href = href;
    const loaded = new Promise((done) => { link.onload = link.onerror = done; });
    document.head.append(link);
    return loaded;
  });
  // The handwriting is measured as it is written: wait for it (briefly; the fallback is cursive).
  ready = Promise.race([
    Promise.all([...sheets, document.fonts?.load('700 21px Caveat').catch(() => {}), document.fonts?.load('400 17px Caveat').catch(() => {})]),
    new Promise(done => setTimeout(done, 1200)),
  ]);
  return ready;
}

export function initTutorial() {
  if (initialized) return;
  initialized = true;
  const opener = document.querySelector('#titlebar-tutorial-btn');
  if (opener) {
    opener.dataset.tooltip = t('tour.title');
    opener.setAttribute('aria-label', t('tour.title'));
    opener.setAttribute('aria-pressed', 'false');
  }
  // No HTML interpolation of translations: help registration accepts static HTML.
  const help = node('div', 'help-section');
  help.append(node('div', 'help-section-title', t('tour.title')), node('div', 'help-row', tr('helpDescription')));
  registerHelpSection({ order: 95, html: help.outerHTML });
  // The empty state's starter row asks for the tour on the panel it sits in.
  on('tour:open', (request = {}) => { startTour({ host: request.host || null, from: request.from || 'starter' }); });
  window.addEventListener('pagehide', () => destroyTutorial());
}

/** The ? button: a toggle. A tour on screen ends (as Esc does); else it opens. */
export function startTutorial() {
  if (tour) { tour.engine.close('skip'); return; }
  startTour({ from: 'help' });
}

/** Ends a running tour at once (page hide, tests). */
export function destroyTutorial() {
  if (!tour) return;
  tour.engine.close('gone');
}

async function startTour({ host = null, from = 'help' } = {}) {
  if (tour || opening) return;
  opening = true;
  try {
    await loadStyles();
    let sent = null; // what the user sent from a session-free preview's composer
    const presentation = host ? null : beginAssistantTour({ onPreviewSend: (text) => { sent = text; tour?.engine.close('sent'); } });
    const stage = host || presentation?.host;
    if (!stage?.root || !stage.renderer) {
      presentation?.restore({ reason: 'skip' });
      if (!host) showGuestToast(t('assistant.panel.blocked'));
      return;
    }
    const returning = from === 'help' && tourReturning(storage);
    const saved = storage.getItem(KEYS.TUTORIAL_STEP);
    const resumeAt = saved != null && !storage.getItem(KEYS.TUTORIAL_COMPLETED) ? resumeBeat(saved) : -1;
    const { createTour } = await import('./tour/tour-engine.js');
    storage.setItem(KEYS.TUTORIAL_STARTED, 'true');
    const env = { computer: stage.computer !== false };
    const engine = createTour({
      host: stage,
      tr: (key, params) => t(key, params),
      reduced,
      env,
      beats: beatsFor(env),
      resumeAt,
      onBeat: (beat) => { storage.setItem(KEYS.TUTORIAL_STEP, beat.id); emit('tutorial:step', { id: beat.id }); },
      onComplete: () => {
        markTourSeen(storage, 'completed');
        storage.removeItem(KEYS.TUTORIAL_STEP);
        flushStorage();
        try { stage.refreshStarters?.(); } catch { /* the starters come back as they were */ }
        emit('tutorial:complete');
      },
      onExplore: () => openSetup(),
      onClose: (reason) => {
        if (reason === 'skip' && !storage.getItem(KEYS.TUTORIAL_COMPLETED)) {
          markTourSeen(storage, 'skipped');
          try { stage.refreshStarters?.(); } catch { /* as they were */ }
          emit('tutorial:skip');
        }
        flushStorage();
        presentation?.restore({ reason });
        if (reason === 'sent' && sent) presentation?.deliver(sent);
        if (reason === 'done' && (!presentation || presentation.live)) stage.focusComposer?.();
        tour = null;
        document.querySelector('#titlebar-tutorial-btn')?.setAttribute('aria-pressed', 'false');
        emit('tutorial:exit', { reason });
      },
    });
    tour = { engine, presentation };
    document.querySelector('#titlebar-tutorial-btn')?.setAttribute('aria-pressed', 'true');
    emit('tutorial:start', { from });
    if (returning) engine.openList();
    else engine.play(0);
  } finally {
    opening = false;
  }
}

export { BEATS as TOUR_BEATS };

/** The tour on screen (its engine: play, next, prev, close, index…), or null. For tests and devtools. */
export function currentTour() {
  return tour?.engine || null;
}

// ── The project-exploration setup: a small dialog of its own ──

let setup = null; // { dialog, index, generation, onPrimary, beforeAdvance, previousFocus, abort }

function names() {
  const settings = document.querySelector('#menubar-settings-btn .menu-text, #menubar-settings-btn')?.textContent?.trim() || t('nav.settings');
  return { settings, projects: t('settings.redesign.nav.projects.label') };
}

/** Open the setup at its first screen (or `index`). */
export function openSetup(index = 0) {
  if (setup) { renderSetup(index); return; }
  loadStyles();
  const overlay = node('div', 'tour-setup-overlay');
  const dialog = node('section', 'tour-setup');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'tour-setup-title');
  dialog.tabIndex = -1;
  overlay.append(dialog);
  document.body.append(overlay);
  const controller = new AbortController();
  wireDropdowns(dialog, { signal: controller.signal });
  setup = { overlay, dialog, index: 0, generation: 0, onPrimary: null, beforeAdvance: null, previousFocus: document.activeElement, controller, abort: null };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSetup(); }, { signal: controller.signal });
  window.addEventListener('keydown', onSetupKey, { capture: true, signal: controller.signal });
  renderSetup(index);
}

export function closeSetup() {
  if (!setup) return;
  const { overlay, controller, previousFocus, abort } = setup;
  abort?.abort();
  setup.generation += 1;
  setup = null;
  controller.abort();
  const leave = () => overlay.remove();
  if (reduced() || typeof overlay.animate !== 'function') leave();
  else overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'cubic-bezier(.2,0,1,.9)' }).finished.then(leave, leave);
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  flushStorage();
}

function onSetupKey(e) {
  if (!setup) return;
  if (e.key === 'Escape') {
    if (setup.dialog.querySelector('.cc-dropdown.open')) return; // the open dropdown closes first
    e.preventDefault(); e.stopImmediatePropagation(); closeSetup(); return;
  }
  if (e.key === 'Tab') {
    const controls = [...setup.dialog.querySelectorAll('button:not(:disabled)')].filter(el => el.getClientRects().length);
    const pos = controls.indexOf(document.activeElement);
    if (pos < 0 || (!e.shiftKey && pos === controls.length - 1) || (e.shiftKey && pos === 0)) {
      e.preventDefault(); (e.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
    e.stopImmediatePropagation();
    return;
  }
  // Product shortcuts never leak out of the dialog; its own buttons and dropdowns keep their keys.
  if (setup.dialog.contains(e.target)) e.stopImmediatePropagation();
}

function button(text, fn, cls = '') {
  const el = node('button', cls, text);
  el.type = 'button';
  el.addEventListener('click', fn);
  return el;
}

function goSetup(next) {
  if (!setup) return;
  if (next < 0) return;
  if (next >= ONBOARDING_STEPS.length) { closeSetup(); return; }
  renderSetup(next);
}

function renderSetup(index) {
  if (!setup) return;
  setup.abort?.abort();
  setup.abort = null;
  const my = ++setup.generation;
  setup.index = index;
  setup.onPrimary = setup.beforeAdvance = null;
  const step = ONBOARDING_STEPS[index];
  const fresh = () => !!setup && setup.generation === my;
  const { dialog } = setup;
  const heading = node('h2', 'tour-setup-title', tr(`steps.${step.id}.title`));
  heading.id = 'tour-setup-title';
  const progress = node('div', 'tour-setup-progress', tr('setupProgress', { n: index + 1, total: ONBOARDING_STEPS.length }));
  const copy = node('p', 'tour-setup-copy', tr(`steps.${step.id}.body`, names()));
  const extra = node('div', 'tour-setup-extra');
  const nav = node('nav', 'tour-setup-nav');
  nav.setAttribute('aria-label', tr('navigation'));
  const back = button(tr('back'), () => goSetup(index - 1), 'tour-setup-btn');
  back.disabled = index === 0;
  const later = button(tr('later'), () => closeSetup(), 'tour-setup-btn tour-setup-link');
  const primary = button(step.kind === 'explore' ? tr('later') : tr('next'), () => {
    if (setup?.onPrimary) { setup.onPrimary(); return; }
    setup?.beforeAdvance?.();
    if (step.kind === 'explore') { storage.setItem(KEYS.ONBOARDING_EXPLORE, 'no'); closeSetup(); return; }
    goSetup(index + 1);
  }, 'tour-setup-btn tour-setup-primary');
  nav.append(back, later, primary);
  if (step.kind === 'explore') later.hidden = true;
  dialog.replaceChildren(progress, heading, copy, extra, nav);
  if (!reduced()) dialog.animate([{ opacity: 0.4, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0,0,.38,.9)' });
  const saveChoice = (key, value) => { storage.setItem(key, value); flushStorage(); };
  const status = (text = tr('loading')) => { const el = node('p', 'tour-setup-status', text); el.setAttribute('role', 'status'); extra.append(el); return el; };
  const retry = () => extra.append(button(tr('retry'), () => renderSetup(index), 'tour-setup-btn'));
  const field = (label, id) => {
    const wrap = node('div', 'tour-setup-field');
    const caption = node('span', 'tour-setup-label', label);
    caption.id = `${id}-label`;
    wrap.append(caption);
    wrap.insertAdjacentHTML('beforeend', dropdownHTML(id, [{ value: '', label: tr('loading'), selected: true }], { labelledBy: caption.id, disabled: true }));
    extra.append(wrap);
    return wrap.querySelector(`#${id}`);
  };

  if (step.kind === 'explore') {
    extra.append(button(tr('explore'), () => { saveChoice(KEYS.ONBOARDING_EXPLORE, 'yes'); goSetup(index + 1); }, 'tour-setup-btn tour-setup-primary'));
  } else if (step.kind === 'cli') {
    const choices = node('div', 'tour-setup-options');
    extra.append(choices);
    primary.disabled = !CLI_PROFILES.some(c => c.id === storage.getItem(KEYS.ONBOARDING_CLI));
    for (const cli of CLI_PROFILES) {
      const choice = button(cli.label, () => {
        if (storage.getItem(KEYS.ONBOARDING_CLI) !== cli.id) storage.removeItem(KEYS.ONBOARDING_MODEL);
        saveChoice(KEYS.ONBOARDING_CLI, cli.id);
        goSetup(index + 1);
      }, 'tour-setup-choice');
      choice.setAttribute('aria-pressed', String(storage.getItem(KEYS.ONBOARDING_CLI) === cli.id));
      choices.append(choice);
    }
  } else if (step.kind === 'model') {
    const input = field(tr('model'), 'tour-setup-model');
    primary.disabled = true;
    const loading = status();
    let settled = false;
    const finish = (models) => {
      if (!fresh() || settled) return;
      settled = true;
      clearTimeout(timeout);
      const saved = storage.getItem(KEYS.ONBOARDING_MODEL) || '';
      const entries = [{ value: '', label: tr('cliDefault') }, ...models.map(m => ({ value: modelSelectorValue(m), label: formatModelOptionLabel(m, { includeService: true }) }))];
      setDropdownItems(input, entries.map(e => ({ ...e, selected: e.value === saved })));
      setDropdownValue(input, entries.some(e => e.value === saved) ? saved : '');
      setDropdownDisabled(input, false);
      primary.disabled = false;
      loading.textContent = models.length ? tr('catalog') : tr('catalogUnavailable');
      input.addEventListener('change', () => saveChoice(KEYS.ONBOARDING_MODEL, input.value));
      setup.beforeAdvance = () => saveChoice(KEYS.ONBOARDING_MODEL, input.value);
      if (!models.length) retry();
    };
    const timeout = setTimeout(() => finish([]), 8000);
    ensureModelsForProfile(storage.getItem(KEYS.ONBOARDING_CLI)).then(m => finish(Array.isArray(m) ? m : [])).catch(() => finish([]));
  } else if (step.kind === 'project') {
    const input = field(tr('project'), 'tour-setup-project');
    primary.disabled = true;
    const loading = status();
    const abort = new AbortController();
    setup.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 8000);
    fetch('/api/terminal/profiles', { signal: abort.signal }).then(r => { if (!r.ok) throw new Error('profiles'); return r.json(); }).then((data) => {
      if (!fresh()) return;
      const projects = (data.projects || []).filter(p => p.path);
      const name = (p) => p.label || p.path.split(/[\\/]/).filter(Boolean).pop();
      let prior = null;
      try { prior = JSON.parse(storage.getItem(KEYS.ONBOARDING_PROJECT) || 'null'); } catch { /* choose again */ }
      const existing = projects.findIndex(p => p.path === prior?.path);
      setDropdownItems(input, [{ value: '', label: tr('chooseProject') }, ...projects.map((p, i) => ({ value: String(i), label: name(p) }))]);
      setDropdownValue(input, existing >= 0 ? String(existing) : '');
      setDropdownDisabled(input, !projects.length);
      primary.disabled = existing < 0;
      loading.textContent = projects.length ? tr('projectHint') : tr('noProjects');
      input.addEventListener('change', () => {
        const project = projects[Number(input.value)];
        primary.disabled = input.value === '';
        if (input.value !== '' && project) saveChoice(KEYS.ONBOARDING_PROJECT, JSON.stringify({ path: project.path, label: name(project) }));
      });
    }).catch(() => {
      if (!fresh()) return;
      loading.textContent = tr('projectsUnavailable');
      retry();
    }).finally(() => clearTimeout(timeout));
    extra.append(button(tr('addProject', names()), async () => {
      // An explicit choice hands off to the Projects page of Settings.
      closeSetup();
      const { openSettingsModal } = await import('./ui-settings.js');
      await openSettingsModal({ tab: 'projects', expand: ['stg-sec-workspaces'] });
    }, 'tour-setup-btn tour-setup-link'));
  } else if (step.kind === 'launch') {
    primary.textContent = tr('begin');
    // A second click meant for the previous screen must not start the CLI.
    primary.disabled = true;
    const unlock = setTimeout(() => { if (fresh()) primary.disabled = false; }, 600);
    const loading = status('');
    let busy = false;
    setup.onPrimary = () => {
      if (busy || !fresh()) return;
      let project = null;
      try { project = JSON.parse(storage.getItem(KEYS.ONBOARDING_PROJECT) || 'null'); } catch { /* handled below */ }
      const cli = storage.getItem(KEYS.ONBOARDING_CLI);
      if (!project?.path || !CLI_PROFILES.some(c => c.id === cli)) { loading.textContent = tr('selectionMissing'); return; }
      busy = true;
      primary.disabled = true;
      loading.textContent = tr('launching');
      // The same category slug Settings → Projects gives an exploration.
      const slug = (project.label || project.path.split(/[\\/]/).filter(Boolean).pop() || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const model = storage.getItem(KEYS.ONBOARDING_MODEL);
      const finish = (err) => {
        clearTimeout(timeout);
        if (!fresh()) return;
        if (err) { busy = false; primary.disabled = false; loading.textContent = tr('launchFailed'); return; }
        closeSetup();
      };
      const timeout = setTimeout(() => finish(new Error('timeout')), 15000);
      try {
        emit('terminal:launch-floating', { profile: cli, cwd: project.path, createOpts: model ? { model } : {},
          initialMessage: buildExplorePrompt(slug), autoSubmit: true, onDone: finish });
      } catch (err) { finish(err); }
    };
    void unlock;
  }
  // The keyboard lands on the way on (never on Begin: only a deliberate click launches).
  const focus = step.kind === 'launch' ? dialog : (primary.disabled ? dialog : primary);
  focus.focus({ preventScroll: true });
}
