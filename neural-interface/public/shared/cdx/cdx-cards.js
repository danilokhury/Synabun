// Shared expansion behavior for live and snapshot-restored transcript cards.
const bindings = new WeakMap();
const interactive = 'button, input, select, textarea, a, summary, [role="button"], [contenteditable]:not([contenteditable="false"])';

export function setCardExpanded(card, expanded) {
  if (!card) return;
  const next = !!expanded;
  card.classList.toggle('cxp-collapsed', !next);
  card.dataset.expanded = next ? '1' : '0';
  const head = card.querySelector(':scope > .cxp-card-head');
  if (head?.getAttribute('role') === 'button') head.setAttribute('aria-expanded', String(next));
}

export function bindExpandableCard(card, onToggle = () => {}) {
  const head = card?.querySelector(':scope > .cxp-card-head');
  if (!head || !card.querySelector(':scope > .cxp-card-body') || !head.querySelector('.cxp-card-chevron')) return;
  head.tabIndex = 0;
  head.setAttribute('role', 'button');
  setCardExpanded(card, !card.classList.contains('cxp-collapsed'));
  // Rebinding after streaming updates refreshes the callback, never the listeners.
  if (bindings.has(head)) { bindings.set(head, onToggle); return; }
  bindings.set(head, onToggle);
  const activate = (event) => {
    const control = event.target.closest(interactive);
    if (control && control !== head) return;
    if (event.type === 'keydown') {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); // Space must not scroll; held keys toggle only once.
      if (event.repeat) return;
    }
    const expanded = card.classList.contains('cxp-collapsed');
    setCardExpanded(card, expanded);
    bindings.get(head)(card, expanded);
  };
  head.addEventListener('click', activate);
  head.addEventListener('keydown', activate);
}
