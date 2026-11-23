// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio
// ═══════════════════════════════════════════
//
// The window where the owner keeps its agents: named, reviewed ways to launch a worker (docs/agents.md → Agents
// Studio). The Studio is public/shared/agents/studio/, loaded the first time it is opened. This file is what the
// 2D and 3D pages load: it answers the menu's events, keeps the count of drafts that wait for review on the
// menu's "Review queue" entry, marks each Studio label when it needs the owner, and passes
// on the changes the Assistant, an agent or another window make.
//
//   agents:open           { view | place: 'library' | 'create' | 'review' | 'teams', id, scope, tab, create, teamId }
//                         with nothing said, the Studio opens where it was left
//   sync:assistant:agents-changed   an agent definition changed (lib/agents/registry.js through server.js)
//   sync:assistant:team-changed     a team changed (the team scheduler)

import { on } from './state.js';
import { isGuest } from './ui-sync.js';
import { badgeText, watchStudioAttention } from './studio-attention.js';
import { t } from './i18n.js';

let _studio = null;
const studio = () => {
  if (!_studio) _studio = import('./agents/studio/ax-main.js').catch((err) => { _studio = null; throw err; });
  return _studio;
};

function paintAttention(count, attention) {
  for (const button of document.querySelectorAll('[data-studio-attention]')) {
    const waiting = attention[button.dataset.studioAttention];
    button.querySelector('.menubar-attention-dot').hidden = !waiting;
    if (waiting) button.setAttribute('aria-description', t('menu.studioAttention'));
    else button.removeAttribute('aria-description');
  }
  const badge = document.getElementById('menu-agents-review-count');
  if (!badge) return;
  badge.textContent = badgeText(count);
  badge.hidden = !count;
  if (count) {
    const label = t(count === 1 ? 'menu.agents.reviewWaitingOne' : 'menu.agents.reviewWaiting', { count });
    badge.setAttribute('aria-label', label);
    badge.title = label;
  } else {
    badge.removeAttribute('aria-label');
    badge.removeAttribute('title');
  }
}

export function initAgentsStudio() {
  const attention = watchStudioAttention({
    paint: paintAttention,
    read: async (sources) => {
      const res = await fetch('/api/studio-attention?sources=' + sources.join(','), { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('Studio attention is unavailable');
      return res.json();
    },
  });
  on('agents:open', (detail) => { studio().then((m) => m.openStudio(detail && typeof detail === 'object' ? detail : {})).catch(failed); });
  on('sync:assistant:agents-changed', (msg) => {
    attention.refresh('drafts');
    if (_studio) _studio.then((m) => m.onAgentsChanged(msg || {})).catch(() => {});
  });
  on('sync:assistant:team-changed', (msg) => {
    attention.refresh('teams');
    if (msg?.event === 'recovered') attention.refresh('workers');
    if (_studio) _studio.then((m) => m.onTeamChanged(msg || {})).catch(() => {});
  });
  on('sync:skills:changed', (msg) => {
    if (!msg?.event?.type || msg.event.type === 'review.changed') attention.refresh('skills');
  });
  on('sync:assistant:automation-records-changed', ({ templates, schedules }) => {
    if (templates) attention.refresh('automations');
    if (schedules) attention.refresh('schedules');
  });
  for (const event of ['assistant:dispatch', 'assistant:run-removed']) {
    on('sync:' + event, () => attention.refresh('workers'));
  }
  for (const event of ['sidepanel:run-created', 'sidepanel:run-updated',
    'sidepanel:run-completed', 'sidepanel:run-failed', 'sidepanel:run-stopped']) {
    on('sync:' + event, () => attention.refresh('runs'));
  }
  const showMenu = (guest) => {
    const item = document.querySelector('.menubar-item[data-menu="agents"]');
    if (item) item.hidden = guest;
  };
  // The sync handshake identifies the owner on first paint and again after every reconnect.
  on('session:info', ({ isGuest: guest }) => {
    showMenu(guest);
    attention.setOwner(!guest);
  });
  window.addEventListener('focus', () => attention.refresh());
  showMenu(isGuest());
}

function failed(err) {
  console.error('Agents Studio could not be loaded', err);
}
