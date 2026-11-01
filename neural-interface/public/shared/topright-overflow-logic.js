// The top-right toolbar's overflow, what decides (no DOM, no imports: node --test loads it).
// The page side is ui-topright-overflow.js.

// Lowest priority first: the first entries are the first to leave the row for the ⋯ menu.
export const OVERFLOW_ORDER = [
  'topright-keybinds-btn',
  'invite-overlay',
  'topright-trash-btn',
  'topright-bookmarks-btn',
  'topright-antigravity-panel-btn',
  'topright-opencode-panel-btn',
  'topright-file-explorer-btn',
  'topright-memory-explorer-btn',
  'topright-codex-panel-btn',
  'topright-update-btn',
  'topright-claude-panel-btn',
  'topright-assistant-panel-btn',
  // the very last resort, a band of about 120 px: the toggle too (its entry in the menu shows and hides the tools)
  'topright-tools-btn',
];

/**
 * Which entries of OVERFLOW_ORDER leave the row: the fewest, in order, that bring the row's width within `available`.
 * `total` is the row with everything in it and no ⋯; `widths[i]` what entry i takes in the row (its width and the gap
 * before it; 0 when it is not shown at all, and then never listed); `menuWidth` what the ⋯ adds once anything
 * overflows. Pinned entries never leave.
 */
export function overflowCount({ total, available, widths, menuWidth, pinned = [] }) {
  if (total <= available) return { count: 0, hidden: [] };
  let need = total + menuWidth;
  const hidden = [];
  for (let i = 0; i < widths.length && need > available; i++) {
    if (pinned.includes(i) || !widths[i]) continue;
    need -= widths[i];
    hidden.push(i);
  }
  return { count: hidden.length, hidden };
}

/**
 * Where a dropdown of the bar (workspaces, bookmarks, share) goes across: kept within [minLeft, maxRight] (the band's
 * clip on the left, which already clears the Focus Mode rail and the left panels; the viewport on the right).
 * `left` / `width` are its box as the stylesheet hangs it. Returns the `shift` (px, + is to the right) and the
 * `maxWidth` it may take (null when it fits as it is). Too wide for the room: as wide as the room, flush with minLeft.
 */
export function clampDropdownX({ left, width, minLeft, maxRight }) {
  const room = Math.max(0, maxRight - minLeft);
  const w = Math.min(width, room);
  const maxWidth = width > room ? room : null;
  let x = left;
  if (x + w > maxRight) x = maxRight - w;
  if (x < minLeft) x = minLeft;
  return { shift: Math.round(x - left), maxWidth };
}
