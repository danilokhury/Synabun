/**
 * The window's title bar is the app's own top bar, the way Discord's is: no
 * separate native title bar above it. Pure (tested in
 * packaging/tests/desktop-titlebar.test.mjs): the main process asks it which
 * window options to use and checks with it what a page sends.
 *
 *   Windows, Linux  the title bar is hidden; the system's own caption buttons
 *                   (minimize, maximize with Windows 11's snap layouts, close
 *                   with its red hover) are drawn over the top right corner of
 *                   the page, in the colours of the bar under them, through
 *                   Electron's title bar overlay
 *   macOS           the title bar is hidden; the traffic lights stay, centred
 *                   in the bar on its left; the menu bar stays the system's
 *
 * The page lays its bar out around the buttons with the Window Controls
 * Overlay geometry Electron gives it (navigator.windowControlsOverlay and the
 * titlebar-area-* CSS variables): neural-interface/public/shared/desktop-titlebar.js.
 * Colours and the height come from SynaBun's style guide (DESIGN.md): the nav-bar
 * component (background #101012, text text-primary #ffffffb3) and the 48px
 * source height of --navbar-height; the status page's background is #050505.
 */

/** The bar's height in DIP: DESIGN.md nav-bar, --navbar-height (source 48px). The caption buttons are as tall. */
export const TITLE_BAR_HEIGHT = 48;

/** The traffic lights' left inset, the spacing token lg (16px); they are centred in the bar's height. */
export const TRAFFIC_LIGHT_INSET = 16;
/**
 * Height of macOS's window buttons: 14 points (Accessibility reports 16 x 16, a point of margin on every side).
 * Electron centres them in a strip `y` points above and below them, so `y` is what centres them in the bar.
 */
const TRAFFIC_LIGHT_HEIGHT = 14;

/** #rgb, #rrggbb or #rrggbbaa → { r, g, b, a } (a from 0 to 1), or null. */
export function parseHexColor(text) {
  const value = String(text ?? '').trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  const byte = (at) => parseInt(hex.slice(at, at + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: hex.length === 8 ? byte(6) / 255 : 1 };
}

const toHex = ({ r, g, b }) => `#${[r, g, b].map(part => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0')).join('')}`;

/** `foreground` (any alpha) drawn over the opaque `background`, as one opaque #rrggbb. */
export function compositeHex(foreground, background) {
  const top = parseHexColor(foreground);
  const under = parseHexColor(background);
  if (!top || !under) throw new Error(`not a colour: ${!top ? foreground : background}`);
  const mix = (a, b) => a * top.a + b * (1 - top.a);
  return toHex({ r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) });
}

/** What the caption buttons look like over the Neural Interface's bar until the page says otherwise (DESIGN.md nav-bar). */
export const APP_OVERLAY = Object.freeze({ color: '#101012', symbolColor: compositeHex('#ffffffb3', '#101012') });
/** Over the app's own status page (packaging/desktop/src/pages: background #050505, the same text tone). */
export const STATUS_OVERLAY = Object.freeze({ color: '#050505', symbolColor: compositeHex('#ffffffb3', '#050505') });

/** Where the traffic lights go so they sit centred in a bar `height` tall. */
export function trafficLightPosition(height = TITLE_BAR_HEIGHT) {
  return { x: TRAFFIC_LIGHT_INSET, y: Math.max(0, Math.round((height - TRAFFIC_LIGHT_HEIGHT) / 2)) };
}

/**
 * The BrowserWindow options of the main window: the native title bar hidden,
 * the Window Controls Overlay on (its JavaScript API and CSS variables, on
 * every platform), the caption buttons in `colors` on Windows and Linux, the
 * traffic lights centred on macOS. The menu bar of Windows and Linux never
 * shows (the app's own bar has a menu button); its accelerators stay.
 */
export function titleBarWindowOptions(platform, { colors = STATUS_OVERLAY, height = TITLE_BAR_HEIGHT } = {}) {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: trafficLightPosition(height), titleBarOverlay: { height } };
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: colors.color, symbolColor: colors.symbolColor, height }, autoHideMenuBar: false };
}

/**
 * What a page of the main window is told about its title bar (the preload
 * hands it to the page as window.synabunDesktop.window.titleBar): where the
 * window's own controls are, how tall the bar is, and whether the page shows
 * the button that opens the app's menu (Windows and Linux; macOS keeps the
 * system menu bar).
 */
export function titleBarFacts(platform, { height = TITLE_BAR_HEIGHT } = {}) {
  const mac = platform === 'darwin';
  return Object.freeze({
    style: 'overlay',
    platform: mac ? 'darwin' : platform === 'win32' ? 'win32' : 'linux',
    height,
    controls: mac ? 'left' : 'right',
    appMenu: !mac,
  });
}

/** The argument the main window's preload reads its title bar facts from (and only the main window gets). */
export const TITLE_BAR_ARGUMENT = 'synabun-titlebar';
export const titleBarArgument = (platform, options) => `--${TITLE_BAR_ARGUMENT}=${encodeURIComponent(JSON.stringify(titleBarFacts(platform, options)))}`;

/** The facts back from the argument, or null (a window without the app's title bar: a window.open child). */
export function titleBarFactsFromArgument(value) {
  if (!value) return null;
  try {
    const facts = JSON.parse(decodeURIComponent(value));
    if (facts?.style !== 'overlay' || !['darwin', 'win32', 'linux'].includes(facts.platform)) return null;
    const height = Number(facts.height);
    if (!Number.isFinite(height) || height < 24 || height > 96) return null;
    return Object.freeze({ style: 'overlay', platform: facts.platform, height, controls: facts.controls === 'left' ? 'left' : 'right', appMenu: facts.appMenu === true });
  } catch {
    return null;
  }
}

/**
 * The caption button colours a page asks for: two opaque #rrggbb colours, or
 * null for anything else. A page never gets to send the buttons another
 * height, a transparent colour (the page under them would show through
 * Windows' hover fill) or a string Electron would parse as something else.
 */
export function overlayColors(input) {
  if (!input || typeof input !== 'object') return null;
  const color = String(input.color ?? '');
  const symbolColor = String(input.symbolColor ?? '');
  if (!/^#[0-9a-f]{6}$/i.test(color) || !/^#[0-9a-f]{6}$/i.test(symbolColor)) return null;
  return { color: color.toLowerCase(), symbolColor: symbolColor.toLowerCase() };
}

/**
 * Where the app's menu opens for a click on the page's menu button: the page
 * says where (CSS pixels from the top left of the page), the window's zoom
 * turns that into the window's own units. Null for anything that is not a
 * place on the page.
 */
export function appMenuPosition(input, zoomFactor = 1) {
  const x = Number(input?.x);
  const y = Number(input?.y);
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100000 || y > 100000) return null;
  return { x: Math.round(x * zoom), y: Math.round(y * zoom) };
}

/** The state a page of the main window gets with every change: maximized, full screen, focused. */
export function windowStateOf(win) {
  return {
    maximized: !!win?.isMaximized?.(),
    fullScreen: !!win?.isFullScreen?.(),
    focused: !!win?.isFocused?.(),
  };
}
