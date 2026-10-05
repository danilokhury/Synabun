// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — the row an armed confirmation shows (DOM)
// What will happen, the button that does it, and Cancel: the neutral banner the
// "Undone … Restore" line uses, with the panel's inline action buttons. When a
// question is armed, by whom and for how long is in ocp-v2-confirm-logic.js;
// each surface (the session menu, the panel, the naming dialog, the
// environment popover) puts the row where its action is.
// ─────────────────────────────────────────────────────────────────────────────

/** The row for `view` (confirms.armed()). Its buttons answer through `confirms`. */
export function confirmRow(confirms, view) {
  const row = document.createElement('div');
  row.className = 'ocpv2-retry-banner ocpv2-revert-banner ocpv2-confirm';
  row.dataset.confirmKey = view.key;
  row.setAttribute('role', 'alertdialog');
  const text = document.createElement('span');
  text.className = 'ocpv2-retry-message ocpv2-confirm-text';
  text.textContent = view.text;
  const answer = (cls, label, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ocpv2-inline-action ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return btn;
  };
  row.append(
    text,
    answer('ocpv2-confirm-yes', view.confirmLabel, () => confirms.confirm(view.key)),
    answer('ocpv2-confirm-no', view.cancelLabel, () => confirms.cancel(view.key)),
  );
  // Inside a menu row a click on the question is not a click on the row.
  row.addEventListener('click', (event) => event.stopPropagation());
  return row;
}

/**
 * Keeps `root` showing the row of the question that is armed for `surface`,
 * and no other: under `anchorFor(key)` when that element is a child of `root`,
 * else as `root`'s first child. Call it after `root` was filled again and
 * whenever the question changes.
 */
export function syncConfirmRow(confirms, root, surface, anchorFor = () => null) {
  if (!root) return null;
  const view = confirms.armed();
  const mine = view && view.surface === surface ? view : null;
  let shown = null;
  for (const child of [...(root.children || [])]) {
    if (!String(child.className || '').split(/\s+/).includes('ocpv2-confirm')) continue;
    if (mine && !shown && child.dataset?.confirmKey === mine.key) shown = child;
    else child.remove();
  }
  if (!mine || shown) return shown;
  const row = confirmRow(confirms, mine);
  const anchor = anchorFor(mine.key);
  if (anchor && anchor.parentNode === root) root.insertBefore(row, anchor.nextSibling);
  else root.insertBefore(row, root.firstChild);
  return row;
}
