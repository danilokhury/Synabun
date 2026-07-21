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

function setVarPair(primary, legacy, value) {
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty(primary, value);
  rootStyle.setProperty(legacy, value);
}

function ownerCssVar(owner) {
  return String(owner || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function clearAllOffsetVars() {
  const rootStyle = document.documentElement.style;
  for (let i = rootStyle.length - 1; i >= 0; i--) {
    const name = rootStyle[i];
    if (name && name.startsWith(OFFSET_VAR_PREFIX)) rootStyle.removeProperty(name);
  }
}

function applyStackedReservation() {
  const rootStyle = document.documentElement.style;
  let totalWidth = 0;
  let maxGap = 0;

  for (const entry of _reservations.values()) {
    totalWidth += entry.reservedWidth || 0;
    if ((entry.gap || 0) > maxGap) maxGap = entry.gap || 0;
  }

  setVarPair(RESERVED_WIDTH_VAR, LEGACY_WIDTH_VAR, px(totalWidth));
  setVarPair(RESERVED_GAP_VAR, LEGACY_GAP_VAR, px(maxGap));

  // Per-owner offset = sum of widths of panels to its RIGHT
  // (= panels inserted BEFORE this one in the Map).
  clearAllOffsetVars();
  let offset = 0;
  for (const [owner, entry] of _reservations) {
    rootStyle.setProperty(`${OFFSET_VAR_PREFIX}${ownerCssVar(owner)}`, px(offset));
    offset += entry.reservedWidth || 0;
  }
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
