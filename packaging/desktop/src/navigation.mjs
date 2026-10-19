/**
 * What the window may show. Pure (tested in packaging/tests/desktop-shell.test.mjs).
 *
 * The window shows SynaBun's own server and nothing else: a page of the
 * backend origin opens in the window (or, from window.open, in another app
 * window); every other web address goes to the default browser; anything that
 * is not a web address (file:, javascript:, a custom scheme) goes nowhere.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The origin the window loads for a backend on `port`. */
export function backendOrigin(port) {
  return `http://localhost:${Number(port)}`;
}

/** The address the window opens first. */
export function backendUrl(port, path = '/') {
  return `${backendOrigin(port)}${path.startsWith('/') ? path : `/${path}`}`;
}

function parse(value) {
  try { return new URL(String(value)); } catch { return null; }
}

/**
 * True for a page of the backend on `port`, under any loopback spelling
 * (localhost, 127.0.0.1, [::1]), including a blob: URL that page created.
 * Never with credentials in it.
 */
export function isBackendUrl(value, port) {
  let url = parse(value);
  if (!url) return false;
  if (url.protocol === 'blob:') url = parse(url.pathname);
  if (!url) return false;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && Number(url.port || 80) === Number(port)
    && !url.username && !url.password;
}

/** A web address the default browser may be given: http, https or mailto, and nothing else. */
export function isSafeExternal(value) {
  const url = parse(value);
  return !!url && ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
}

/**
 * What to do with a navigation of the window to `url`:
 *   'allow'     a page of the backend
 *   'external'  open it in the default browser instead
 *   'deny'      ignore it
 * `allowFile` is the app's own status pages, loaded by the app itself.
 */
export function navigationDecision(url, port, { allowFile = null } = {}) {
  if (port && isBackendUrl(url, port)) return 'allow';
  if (allowFile && String(url).startsWith('file:') && allowFile(String(url))) return 'allow';
  if (isSafeExternal(url)) return 'external';
  return 'deny';
}

/** The permissions a page of the backend may get. Everything else is refused. */
export const GRANTED_PERMISSIONS = Object.freeze([
  'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'media', 'pointerLock',
]);

export function permissionDecision(permission, requestingUrl, port) {
  return !!port && isBackendUrl(requestingUrl, port) && GRANTED_PERMISSIONS.includes(permission);
}
