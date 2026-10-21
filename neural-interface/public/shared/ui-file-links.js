// ═══════════════════════════════════════════
// SynaBun Neural Interface — File links in agent messages: the page side
// ═══════════════════════════════════════════
//
// One click handler for the links in the messages of the four side panels
// (Assistant, Claude, Codex, OpenCode). A link that points at a file the code
// editor can open opens it there (`open-file-editor`), at its line and column;
// every other link keeps what its panel did with it. What a target means and
// what a click does are decided in file-links.js; this module gives it the
// page: the bus, the toast, and the server. Whether a file can be opened is
// the editor's own answer: GET /api/file-content, with the path checks that
// route applies.

import { emit } from './state.js';
import { t } from './i18n.js';
import { createFileLinkHandlers, fillFileLinkCopy } from './file-links.js';

/** A `fileLinks.*` sentence in the active locale; in English where i18n never loads (a detached session). */
export function fileLinkText(key, params) {
  const id = `fileLinks.${key}`;
  let text = id;
  try { text = t(id, params); } catch { /* i18n is not there: the English below */ }
  return text && text !== id ? text : fillFileLinkCopy(key, params);
}

/** A short message over the page: the toast the editor uses. */
export function showFileLinkNotice(message) {
  let toast = document.getElementById('fe-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fe-toast';
    toast.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:rgba(30,30,34,0.95);color:#e0e0e0;padding:6px 16px;border-radius:6px;font-size:12px;font-family:var(--ff-mono);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.2s;border:1px solid rgba(255,255,255,0.1);';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}

let _home = null;

// The home folder, for `~`: the folder picker's route answers with it when no path is asked for.
function homeFolder() {
  _home ??= fetch('/api/browse-directory')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (typeof data?.current === 'string' ? data.current : ''))
    .catch(() => '')
    .then((home) => { if (!home) _home = null; return home; });
  return _home;
}

async function probeFile(path) {
  const res = await fetch(`/api/file-content?path=${encodeURIComponent(path)}`);
  // Only the answer matters: the editor reads the file itself when it opens it.
  try { await res.body?.cancel(); } catch { /* already read or closed */ }
  return res.status;
}

const handlers = createFileLinkHandlers({
  emit,
  probe: probeFile,
  home: homeFolder,
  origin: () => window.location.origin,
  say: fileLinkText,
  notify: showFileLinkNotice,
  follow: (anchor) => {
    if (anchor.protocol !== 'http:' && anchor.protocol !== 'https:') return; // an address of this app, never a script link
    if (anchor.target === '_blank') window.open(anchor.href, '_blank', 'noopener,noreferrer');
    else window.location.assign(anchor.href);
  },
});

/**
 * Take a click on a link in an agent's message when the link points at a file (see createFileLinkHandlers).
 * @returns {boolean} true when the click was taken: the browser no longer follows the link
 */
export function handleFileLinkClick(event, options = {}) {
  const taken = handlers.handleClick(event, options);
  if (!taken) return false;
  taken.catch((error) => console.warn('[file-links] click failed', error));
  return true;
}

/**
 * Give the links of a panel's messages their file behaviour. One listener on the container covers messages
 * that are streaming, finished, or put back from history.
 * @param {Element} container the element every message of the panel is rendered into
 * @param {{ cwd?: (anchor: Element) => string, textLinks?: string, copyPath?: (anchor: Element, path: string) => any,
 *   notify?: (message: string) => void }} [options] see createFileLinkHandlers().handleClick
 * @returns {() => void} removes the listeners
 */
export function wireFileLinks(container, options = {}) {
  if (!container) return () => {};
  const own = { ...options, within: container };
  const onClick = (event) => { handleFileLinkClick(event, own); };
  const onOver = (event) => handlers.label(event, own);
  container.addEventListener('click', onClick);
  container.addEventListener('mouseover', onOver);
  return () => {
    container.removeEventListener('click', onClick);
    container.removeEventListener('mouseover', onOver);
  };
}
