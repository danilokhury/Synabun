// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: questions asked inside the panel
// ═══════════════════════════════════════════
//
// The Studio panel is above the page's other layers, so its questions are drawn inside it, over its content:
// a modal dialog (role alertdialog, aria-modal, labelled by its title and described by its text). While one is
// open, no key reaches the page under it (taken at the window in the capture phase): Escape answers "cancel"
// and goes no further (the panel's own Escape, which closes things, never sees it). Inside it a key does what
// it does where it is (a field, a dropdown) and stops there; Tab stays inside, the arrows move between buttons. A click on the dim area outside answers "cancel" too. One question at a
// time: a second one gives the first up (it answers null). When it is answered the keyboard goes back to where
// it was.

const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];
let _open = null;   // { giveUp }

/** Whether a question is open in a Studio panel now. */
export const dialogOpen = () => !!_open;

/** Give up the open question (it answers null), if there is one. */
export function closeDialog() { _open?.giveUp(); }

/**
 * Ask a question inside the panel.
 * @param {object} o
 * @param {HTMLElement} o.host the panel it is drawn in
 * @param {string} o.title
 * @param {(string|Node)[]} [o.lines] the text, a paragraph each (a string is text, never markup)
 * @param {{ id: string, label: string, kind?: 'primary'|'danger'|'plain', disabled?: boolean }[]} o.buttons left to right
 * @param {string} [o.focus] the button the keyboard starts on (default: the last one that is not danger)
 * @param {string|null} [o.cancelId] what Escape and a click outside answer; null: they answer null
 * @param {HTMLElement|null} [o.extra] more content after the text (a checkbox, a list)
 * @param {(answer: string, ui: object) => boolean} [o.accept] called before the answer is given: false keeps it open
 * @returns {Promise<string|null>} the id of the button, or `cancelId` / null
 */
export function askInPanel({ host, title, lines = [], buttons, focus = null, cancelId = 'cancel', extra = null, accept = null, wide = false }) {
  return new Promise((resolve) => {
    _open?.giveUp();
    const before = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'ss-file-dialog-overlay ss-dlg-overlay';
    const backdrop = document.createElement('div');
    backdrop.className = 'ss-fd-backdrop';
    const box = document.createElement('div');
    box.className = `ss-file-dialog ss-dlg${wide ? ' ss-dlg--wide' : ''}`;
    const uid = `ss-dlg-${Math.random().toString(36).slice(2, 8)}`;
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', `${uid}-title`);
    box.setAttribute('aria-describedby', `${uid}-body`);
    const head = document.createElement('div');
    head.className = 'ss-dlg-title';
    head.id = `${uid}-title`;
    head.textContent = title;
    const body = document.createElement('div');
    body.className = 'ss-dlg-body';
    body.id = `${uid}-body`;
    for (const line of lines.filter((l) => l !== null && l !== undefined && l !== '')) {
      if (typeof line === 'string') { const p = document.createElement('p'); p.textContent = line; body.append(p); }
      else body.append(line);
    }
    if (extra) body.append(extra);
    const bar = document.createElement('div');
    bar.className = 'ss-dlg-actions';
    const byId = new Map();
    for (const b of buttons) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `ss-dlg-btn${b.kind ? ` ss-dlg-btn--${b.kind}` : ''}`;
      node.textContent = b.label;
      node.dataset.answer = b.id;
      if (b.disabled) node.disabled = true;
      node.addEventListener('click', () => done(b.id));
      bar.append(node);
      byId.set(b.id, node);
    }
    box.append(head, body, bar);
    overlay.append(backdrop, box);

    const enabled = () => [...bar.querySelectorAll('button')].filter((b) => !b.disabled);
    const focusables = () => [...box.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), [tabindex="0"]')];
    // At the window, before anything: a key meant for the page under the question goes nowhere. Escape answers.
    const outside = (event) => {
      if (box.contains(event.target)) return;
      event.stopPropagation();
      if (event.type !== 'keydown') return;
      if (event.key === 'Escape') { event.preventDefault(); done(cancelId); return; }
      if (event.key === 'Tab') { event.preventDefault(); (focusables()[0])?.focus(); }
    };
    // Inside it, a key first does what it does where it is (a field, a dropdown), then stops at the question.
    const inside = (event) => {
      event.stopPropagation();
      if (event.type !== 'keydown' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') { event.preventDefault(); done(cancelId); return; }
      const list = enabled();
      const index = list.indexOf(document.activeElement);
      if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && index >= 0) {
        event.preventDefault();
        list[(index + (event.key === 'ArrowLeft' ? -1 : 1) + list.length) % list.length]?.focus();
        return;
      }
      if (event.key === 'Tab') {
        const all = focusables();
        const at = all.indexOf(document.activeElement);
        event.preventDefault();
        all[(at + (event.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      }
    };
    for (const type of KEY_EVENTS) box.addEventListener(type, inside);
    let answered = false;
    const ui = { box, body, bar, byId, setDisabled: (id, on) => { const n = byId.get(id); if (n) n.disabled = !!on; } };
    function done(answer, { replaced = false } = {}) {
      if (answered) return;
      if (!replaced && answer !== cancelId && answer !== null && typeof accept === 'function' && accept(answer, ui) === false) return;
      answered = true;
      if (_open === handle) _open = null;
      for (const type of KEY_EVENTS) window.removeEventListener(type, outside, true);
      overlay.remove();
      if (!replaced && before?.isConnected) before.focus({ preventScroll: true });
      resolve(answer);
    }
    const handle = { giveUp: () => done(null, { replaced: true }) };
    _open = handle;
    backdrop.addEventListener('click', () => done(cancelId));
    for (const type of KEY_EVENTS) window.addEventListener(type, outside, true);
    host.append(overlay);
    const start = (focus && byId.get(focus)) || [...buttons].reverse().map((b) => byId.get(b.id)).find((n) => n && !n.disabled && !n.classList.contains('ss-dlg-btn--danger')) || enabled()[0];
    start?.focus({ preventScroll: true });
    ui.done = done;
  });
}
