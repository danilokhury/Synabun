/**
 * The main window opens where it was closed, as long as that place is still on
 * a screen. Pure (tested in packaging/tests/desktop-shell.test.mjs); the app
 * reads and writes the JSON next to its profile.
 */

export const DEFAULT_SIZE = Object.freeze({ width: 1440, height: 900 });
export const MIN_SIZE = Object.freeze({ width: 900, height: 600 });

const finite = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)));

/**
 * The bounds to open with. `saved` is what was written last time (or
 * nothing), `displays` the work areas of the screens now ([{ x, y, width,
 * height }]). A window that would be mostly off every screen is centred on the
 * first one instead; its size never exceeds that screen.
 */
export function restoreBounds(saved, displays = []) {
  const screens = (Array.isArray(displays) ? displays : []).filter(area => area && area.width > 0 && area.height > 0);
  const primary = screens[0] || { x: 0, y: 0, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  const fit = (size, room, min) => Math.max(Math.min(size, room), Math.min(min, room));
  const width = fit(finite(saved?.width) ?? DEFAULT_SIZE.width, primary.width, MIN_SIZE.width);
  const height = fit(finite(saved?.height) ?? DEFAULT_SIZE.height, primary.height, MIN_SIZE.height);
  const x = finite(saved?.x);
  const y = finite(saved?.y);
  const result = { width, height, maximized: saved?.maximized === true, fullScreen: saved?.fullScreen === true };
  if (x !== null && y !== null) {
    // At least a third of the window, and its title bar, on one screen.
    const visible = screens.find(area => {
      const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
      const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
      return overlapX >= width / 3 && overlapY >= Math.min(height / 3, 120) && y >= area.y - 8 && y < area.y + area.height - 40;
    });
    if (visible) return { ...result, x, y, width: Math.min(width, visible.width), height: Math.min(height, visible.height) };
  }
  return { ...result, x: primary.x + Math.round((primary.width - width) / 2), y: primary.y + Math.round((primary.height - height) / 2) };
}

/** What to write for a window: its normal bounds (not the maximized ones) and whether it was maximized. */
export function boundsToSave({ normalBounds, maximized = false, fullScreen = false } = {}) {
  if (!normalBounds) return null;
  return {
    x: finite(normalBounds.x), y: finite(normalBounds.y), width: finite(normalBounds.width), height: finite(normalBounds.height),
    maximized: !!maximized, fullScreen: !!fullScreen,
  };
}

/**
 * How the window is recorded for the copy that opens after an update (relaunch.json). Once the main window has been
 * revealed it is the window as it is: shown or closed to the Dock / tray (`windowOpen`), minimized or not. Before
 * that (an install at launch, a start still behind the splash) the window has never been shown, and what counts is
 * how this start was to end on screen (`boot`: shown, minimized, or out of sight after a start at login in the
 * background or a splash a person closed), never the hidden window's own state.
 */
export function relaunchIntent({ revealed = false, alive = false, windowOpen = false, minimized = false, boot = null } = {}) {
  if (!revealed) return { visible: !!boot?.show, minimized: !!boot?.show && !!boot?.minimized };
  return { visible: !!alive && !!windowOpen, minimized: !!alive && !!windowOpen && !!minimized };
}

/**
 * What it means when a person closes the splash (Cmd+W, Alt+F4), as the main window's close button would:
 *   'continue'    an install or a quit is under way: it finishes out of sight
 *   'ignore'      the main window has the screen already (the splash was on its way out)
 *   'quit'        Windows and Linux with "keep running in the tray" off: SynaBun quits
 *   'background'  otherwise: the start goes on and ends out of sight; the Dock, the tray or opening SynaBun again
 *                 brings it back
 */
export function splashCloseAction({ platform = process.platform, closeToTray = true, revealed = false, quitting = false, installing = false } = {}) {
  if (quitting || installing) return 'continue';
  if (revealed) return 'ignore';
  if (platform !== 'darwin' && !closeToTray) return 'quit';
  return 'background';
}
