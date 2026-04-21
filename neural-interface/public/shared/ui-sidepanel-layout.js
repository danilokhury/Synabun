const RESERVED_WIDTH_VAR = '--right-panel-width';
const RESERVED_GAP_VAR = '--right-panel-gap';
const LEGACY_WIDTH_VAR = '--claude-panel-width';
const LEGACY_GAP_VAR = '--claude-panel-gap';

let _activeOwner = null;

function px(value) {
  return `${Math.max(0, Math.round(Number(value) || 0))}px`;
}

function setVarPair(primary, legacy, value) {
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty(primary, value);
  rootStyle.setProperty(legacy, value);
}

function applyReservation(reservedWidthPx, gapPx) {
  setVarPair(RESERVED_WIDTH_VAR, LEGACY_WIDTH_VAR, px(reservedWidthPx));
  setVarPair(RESERVED_GAP_VAR, LEGACY_GAP_VAR, px(gapPx));
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
  _activeOwner = owner;
  applyReservation(reservedWidth, outerGap);
  return reservedWidth;
}

export function clearRightPanelLayout(owner) {
  if (owner && _activeOwner && owner !== _activeOwner) return false;
  _activeOwner = null;
  applyReservation(0, 0);
  return true;
}
