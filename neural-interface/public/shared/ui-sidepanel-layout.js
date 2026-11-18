// ─────────────────────────────────────────────────────────────────────────────
// Right-edge sidepanel layout reservation.
//
// Each panel reserves a slice of the right edge by calling
// reserveRightPanelLayout(owner, panelOrWidth, outerGap?). The total reserved
// width is the SUM of every active reservation, exposed via
// `--right-panel-width` so the rest of the app reflows. Each owner also gets
// a per-owner CSS variable `--right-panel-offset-${cssVar(owner)}` containing
// the cumulative width of panels stacked to its RIGHT — sub-agent panels read
// this to position themselves leftward of the parent OCP panel.
//
// Insertion order = stack order: the first reservation sits flush against the
// right edge; later reservations stack to its left. Closing a panel re-flows
// the offsets for everything stacked to the left of it.
// ─────────────────────────────────────────────────────────────────────────────

const RESERVED_WIDTH_VAR = '--right-panel-width';
const RESERVED_GAP_VAR = '--right-panel-gap';
const LEGACY_WIDTH_VAR = '--claude-panel-width';
const LEGACY_GAP_VAR = '--claude-panel-gap';
const OFFSET_VAR_PREFIX = '--right-panel-offset-';

// Insertion-ordered Map keeps stack order across resize/refresh.
const _reservations = new Map();

function px(value) {
  return `${Math.max(0, Math.round(Number(value) || 0))}px`;
}

function ownerCssVar(owner) {
  return String(owner || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The variables <html> must carry for these reservations (insertion order = stack order), by name.
 * Pure: `applyStackedReservation` writes the difference between this and what <html> has.
 */
export function stackedReservationVars(reservations) {
  const vars = new Map();
  let totalWidth = 0;
  let maxGap = 0;
  for (const entry of reservations.values()) {
    totalWidth += entry.reservedWidth || 0;
    if ((entry.gap || 0) > maxGap) maxGap = entry.gap || 0;
  }
  vars.set(RESERVED_WIDTH_VAR, px(totalWidth));
  vars.set(LEGACY_WIDTH_VAR, px(totalWidth));
  vars.set(RESERVED_GAP_VAR, px(maxGap));
  vars.set(LEGACY_GAP_VAR, px(maxGap));
  // Per-owner offset = sum of widths of panels to its RIGHT
  // (= panels inserted BEFORE this one in the Map).
  let offset = 0;
  for (const [owner, entry] of reservations) {
    vars.set(`${OFFSET_VAR_PREFIX}${ownerCssVar(owner)}`, px(offset));
    offset += entry.reservedWidth || 0;
  }
  return vars;
}

/**
 * Bring an inline style in line with `vars`: write only what differs, remove only the offset variables
 * that are no longer wanted. Returns how many declarations it touched.
 *
 * A custom property written on <html> restyles every element of the page, and a layout read after it
 * (the next panel's measurement, a window clamp) pays for that at once. The reservation is asked for
 * again and again with nothing new (every panel on every window resize, twice per panel show or hide):
 * taking the offsets out and putting the same ones back made each of those a whole-page restyle.
 */
export function syncReservationVars(style, vars) {
  let touched = 0;
  for (let i = style.length - 1; i >= 0; i--) {
    const name = style[i];
    if (name && name.startsWith(OFFSET_VAR_PREFIX) && !vars.has(name)) {
      style.removeProperty(name);
      touched += 1;
    }
  }
  for (const [name, value] of vars) {
    if (style.getPropertyValue(name).trim() === value) continue;
    style.setProperty(name, value);
    touched += 1;
  }
  return touched;
}

function applyStackedReservation() {
  syncReservationVars(document.documentElement.style, stackedReservationVars(_reservations));
}

export function measureRightPanelReservation(panel, outerGap = 20) {
  if (!panel) return 0;
  return Math.ceil(panel.getBoundingClientRect().width) + outerGap;
}

export function reserveRightPanelLayout(owner, panelOrReservedWidth, outerGap = 20) {
  if (!owner) return 0;
  const reservedWidth = typeof panelOrReservedWidth === 'number'
    ? panelOrReservedWidth
    : measureRightPanelReservation(panelOrReservedWidth, outerGap);
  _reservations.set(owner, {
    reservedWidth,
    gap: Math.max(0, Number(outerGap) || 0),
  });
  applyStackedReservation();
  return reservedWidth;
}

export function clearRightPanelLayout(owner) {
  if (owner) _reservations.delete(owner);
  else _reservations.clear();
  applyStackedReservation();
  return _reservations.size === 0;
}

// Owner-scoped offset CSS variable name. Panels read this to position
// themselves leftward of any panels stacked to their right.
export function rightPanelOffsetVar(owner) {
  return `${OFFSET_VAR_PREFIX}${ownerCssVar(owner)}`;
}

// Toggle a global `sp-resizing` flag on <html> while a right-edge panel is
// being drag-resized. CSS uses it to suspend the 0.3s transitions on the
// workspace toolbar / file-editor (so they track the drag frame-for-frame
// instead of trailing ~300ms behind) and to drop the expensive panel
// backdrop-filter blur for the duration of the drag.
export function setRightPanelResizing(active) {
  document.documentElement.classList.toggle('sp-resizing', !!active);
}
