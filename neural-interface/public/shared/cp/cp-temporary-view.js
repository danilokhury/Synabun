// ── Temporary chat: the mark and the control (thin renderer over cp-temporary.js) ──
//
// Three things, all from the tab's state, drawn again whenever the
// conversation area is rebuilt (paintTemporary is idempotent):
//   the control in a new tab's empty state (T1),
//   the pill's mark (T2),
//   one line at the top of the conversation (T2).

import { TEMPORARY_BANNER, isTemporary, temporaryChoice, endedText } from './cp-temporary.js';

function paintChoice(tab, capable, onToggle) {
  const $msgs = tab.messagesEl;
  const choice = temporaryChoice(tab, { capable });
  const empty = $msgs.querySelector('.cp-empty');
  let button = $msgs.querySelector('.cp-temp-choice');
  if (!choice.show || !empty) { button?.remove(); return; }
  if (!button) {
    button = document.createElement('button');
    button.className = 'cp-temp-choice';
    button.setAttribute('type', 'button');
    button.addEventListener('click', () => onToggle?.(!isTemporary(tab)));
    empty.appendChild(button);
  }
  button.textContent = choice.on ? `${choice.label}: on` : choice.label;
  button.setAttribute('aria-pressed', choice.on ? 'true' : 'false');
  button.setAttribute('title', choice.title);
  button.classList.toggle('on', choice.on);
}

function paintBanner(tab) {
  const $msgs = tab.messagesEl;
  const banners = $msgs.querySelectorAll('.cp-temp-banner');
  if (!isTemporary(tab)) { for (const b of banners) b.remove(); return; }
  let banner = banners[0];
  for (const extra of banners.slice ? banners.slice(1) : [...banners].slice(1)) extra.remove();
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'cp-temp-banner';
  }
  const ended = endedText(tab);
  const text = ended || TEMPORARY_BANNER;
  if (banner.textContent !== text) banner.textContent = text;
  banner.classList.toggle('ended', !!ended);
  if ($msgs.firstElementChild !== banner) $msgs.insertBefore(banner, $msgs.firstChild);
}

/**
 * Draw what the tab is. `capable`: the bridge announces temporary chats (the
 * control is not offered otherwise). `onToggle(on)`: the control was clicked.
 */
export function paintTemporary(tab, { capable = false, onToggle = null } = {}) {
  if (!tab?.messagesEl) return;
  paintBanner(tab);
  paintChoice(tab, capable, onToggle);
  tab.pillEl?.classList.toggle('cp-pill-temporary', isTemporary(tab));
}
