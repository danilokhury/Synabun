// A session-free Assistant for the Workspace tour, when the panel has no session
// to present on (no tab, or the tab is mid-conversation). These are the production
// controls and the production empty state (the renderer, its hero rig, the
// composer, the brain picker, the route chip, the computer switch, the mascot
// director), with local state and no socket, run, preference or settings call.
// Only one thing leaves it: a message the user sends from its composer, which the
// sidepanel hands to the real Assistant (onSend) after the tour has closed.
import { t } from './i18n.js';
import { storage } from './storage.js';
import { readStoredBrain } from './assistant/asst-state.js';
import { injectAssistantStyles } from './assistant/asst-styles.js';
import { createRenderer } from './assistant/asst-render.js';
import { createMascotDirector } from './assistant/asst-mascot.js';
import { createBrainPicker } from './assistant/asst-brain-picker.js';
import { createComposer } from './assistant/asst-composer.js';
import { createComputerToggle } from './assistant/asst-computer.js';
import { createRouteModeControl } from './assistant/asst-route.js';

const macLike = () => /Mac/i.test(navigator.platform || navigator.userAgent || '');

export function createTutorialPreview(panel, { onSend = () => {} } = {}) {
  injectAssistantStyles();
  const viewport = document.createElement('div');
  viewport.className = 'asp-viewport active tour-preview';
  viewport.innerHTML = `<div class="asst-root" data-status="idle"><div class="asst-transcript" role="log" aria-live="off" tabindex="0"></div><div class="asst-announce" role="status" aria-live="polite" aria-atomic="true"></div><div class="asst-bottom"><div class="asst-composer-host"></div></div></div>`;
  const bar = document.createElement('div');
  bar.className = 'asp-tab-bar active tour-preview';
  bar.innerHTML = '<div class="asst-bar"><div class="asst-bar-left"><div class="asst-bar-group" data-group="route"></div><div class="asst-bar-group" data-group="context"></div><div class="asst-bar-group" data-group="computer"></div></div><div class="asst-bar-right"></div></div>';
  panel.querySelector('.asp-body').append(viewport);
  panel.querySelector('.asp-bar-slot').append(bar);
  const root = viewport.querySelector('.asst-root');
  const transcript = root.querySelector('.asst-transcript');
  transcript.setAttribute('aria-label', t('assistant.transcript'));
  let brain = readStoredBrain(storage);
  let director = null;
  let picker = null;
  let composer = null;
  const computerShown = macLike();
  const renderer = createRenderer(transcript, {
    t,
    emptySuggestions: () => [
      ...(computerShown ? [{ id: 'computer', label: t('assistant.empty.suggestComputer'), template: t('assistant.empty.templateComputer') }] : []),
      { id: 'web', label: t('assistant.empty.suggestWeb'), template: t('assistant.empty.templateWeb') },
      { id: 'schedule', label: t('assistant.empty.suggestSchedule'), template: t('assistant.empty.templateSchedule') },
      { id: 'remember', label: t('assistant.empty.suggestRemember'), template: t('assistant.empty.templateRemember') },
    ],
    onSuggestion: (template) => composer?.fillTemplate(template),
    mountEmptyProject: (slot) => picker?.mountEmptyProject(slot),
    unmountEmptyControls: () => picker?.mountEmptyProject(null),
    onMascotChange: () => director?.retarget(),
  });
  composer = createComposer(root.querySelector('.asst-composer-host'), {
    t,
    onDraftChange: (text) => renderer.setDrafting?.(!!String(text || '').trim()),
    onFocusChange: (focused) => { if (focused) director?.touch(); },
    onSubmit: (payload) => {
      const text = String(payload?.text || '').trim();
      if (text) onSend(text);
    },
    onToast: () => {},
  });
  picker = createBrainPicker({ brain: composer.el.querySelector('.asst-composer-brain'), context: bar.querySelector('[data-group="context"]') }, {
    t,
    mascot: () => director,
    getBrain: () => brain,
    getRunning: () => false,
    // Only catalog defaults can change this isolated brain; nothing is saved.
    onChange: (next, meta) => { if (meta?.silent) brain = next; },
    menuPlacement: 'auto',
  });
  const route = createRouteModeControl(bar.querySelector('[data-group="route"]'), { t });
  route.setVisible(true);
  const computer = createComputerToggle(bar.querySelector('[data-group="computer"]'), { t });
  computer.set({ visible: computerShown, enabled: false, supported: computerShown, setupState: 'ready' });
  director = createMascotDirector({ getTarget: () => renderer.mascot(), caret: () => composer?.caretPoint?.() || null });
  try { picker.render(); } catch { /* the pills fill in when the catalog arrives */ }
  picker.refresh?.().then(() => picker.render()).catch(() => {});
  renderer.showEmpty();
  return {
    host: {
      root,
      transcript,
      announcer: root.querySelector('.asst-announce'),
      bar,
      renderer,
      director,
      composer,
      live: false,
      computer: computerShown,
      focusComposer: () => composer.focus(),
    },
    destroy() {
      director.destroy();
      picker.destroy();
      composer.destroy();
      route.destroy();
      computer.destroy();
      renderer.destroy?.();
      viewport.remove();
      bar.remove();
    },
  };
}
