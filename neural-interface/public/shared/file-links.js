// ═══════════════════════════════════════════
// SynaBun Neural Interface — File links in agent messages: the decisions
// ═══════════════════════════════════════════
//
// A link in an agent's message can point at a file on this computer: a path,
// a `file:` URL, with or without a place in the file (`:line[:column]`,
// `#Lline[Ccolumn]`). This module reads such a target and says which paths to
// try, and decides what a click on one does. ui-file-links.js gives that
// decision the page (the bus, the server, the toast). The four side panels
// share both.
//
// The text is a model's: nothing here trusts it. A target only ever becomes a
// path handed to /api/file-content, which keeps its own checks.
// No imports and no `document`: the click handler only touches the event and
// the link it is handed. Loaded by `node --test` as it is, and by the Markdown
// sanitiser.

/** The English of `fileLinks.*` in i18n/en.json (a test keeps them equal). */
export const FILE_LINK_COPY = Object.freeze({
  open: 'Open in editor',
  openAtLine: 'Open in editor at line {line}',
  openAtLineColumn: 'Open in editor at line {line}, column {column}',
  missing: '{name} was not found, or it is a folder.',
  notText: '{name} is not a text file the editor can open.',
  tooLarge: '{name} is too large to open in the editor.',
  outside: '{name} is outside your registered projects. Add its folder as a project to open it here.',
  failed: 'Could not reach SynaBun to open {name}. Check that the server is running.',
});

/** Longer than any path: a target past this is not read at all. */
export const MAX_TARGET_LENGTH = 2048;

const DRIVE_RE = /^[a-z]:[\\/]/i;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
// `name.ext:12` and `name.ext:12:3` read as a scheme to a URL parser; they are a file and a place in it.
const PLACE_ONLY_RE = /^\d+(?::\d+)?(?:#.*)?$/;
const LINE_SUFFIX_RE = /:(\d+)(?::(\d+))?$/;
const LINE_HASH_RE = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i;
// Schemes a browser runs or draws content from: never a file's name, not even before a line number.
const ACTIVE_SCHEMES = new Set(['javascript', 'vbscript', 'livescript', 'data', 'blob', 'filesystem', 'about', 'view-source']);
// What a scheme can hide behind: a browser drops tabs and line breaks anywhere in a URL and controls at its
// ends; format characters show nothing; an entity can be left over from a second escape.
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/g;
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi;
const NAMED_ENTITIES = { colon: ':', tab: '\t', newline: '\n', nbsp: ' ', sol: '/', bsol: '\\', num: '#', quest: '?', period: '.', amp: '&', semi: ';', lpar: '(', rpar: ')' };

const slashes = (path) => String(path ?? '').replace(/\\/g, '/');

function decodeEntities(text) {
  let out = text;
  for (let round = 0; round < 4; round += 1) { // `&amp;#106;` is `&#106;` once more
    const next = out.replace(ENTITY_RE, (whole, dec, hex, name) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
      const code = dec ? Number(dec) : parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** A target as its scheme is read: entities decoded, hidden characters dropped, no spaces at the ends, lower case. */
function schemeView(value) {
  return decodeEntities(value).replace(HIDDEN_RE, '').trim().toLowerCase();
}

// An active scheme, read with its spaces squeezed out too: `java script:` is no URL to a browser, and no file either.
const isActive = (seen) => ACTIVE_SCHEMES.has(SCHEME_RE.exec(seen.replace(/\s+/g, ''))?.[1]);

/** How a target reads: a `path`, a `file` URL, a `web` address (http, https), or null for anything else. */
function kindOf(value) {
  if (!value || value.length > MAX_TARGET_LENGTH) return null;
  const seen = schemeView(value);
  if (!seen || seen.startsWith('#') || seen.startsWith('?') || seen.startsWith('//') || isActive(seen)) return null;
  if (DRIVE_RE.test(value)) return 'path';
  const scheme = SCHEME_RE.exec(seen);
  if (!scheme) return 'path';
  // A scheme put together from hidden characters or entities (`JaVa\tScript:`, `&#106;avascript:`) is no
  // file's and no address of this app.
  const written = SCHEME_RE.exec(value);
  if (!written || written[1].toLowerCase() !== scheme[1]) return null;
  const name = scheme[1];
  if (name === 'file') return 'file';
  if (name === 'http' || name === 'https') return 'web';
  const rest = value.slice(written[0].length);
  if (rest.startsWith('//')) return null;
  return PLACE_ONLY_RE.test(rest) ? 'path' : null;
}

/**
 * A link target as written, when it reads as a file on this computer rather than an address.
 * The Markdown sanitiser keeps it beside the link (`data-file-target`): the `href` it writes is resolved
 * against the page, which loses a relative path, `~`, a `file:` URL and `name.ext:12`.
 * @param {string} raw the `href` an agent wrote
 * @returns {string | null}
 */
export function localFileHref(raw) {
  const value = String(raw ?? '').trim();
  const kind = kindOf(value);
  return kind === 'path' || kind === 'file' ? value : null;
}

/** A path with `.`, `..` and doubled slashes resolved, and no slash at its end. */
export function normalizeFilePath(path) {
  const value = slashes(path);
  const drive = /^[a-z]:/i.exec(value)?.[0] || '';
  const rest = value.slice(drive.length);
  const rooted = rest.startsWith('/');
  const parts = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!rooted) parts.push('..'); continue; }
    parts.push(part);
  }
  return `${drive}${rooted ? '/' : ''}${parts.join('/')}`;
}

const isAbsolute = (path) => path.startsWith('/') || DRIVE_RE.test(path);

function decoded(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/**
 * Read a link target.
 * @param {string} raw the target as written (an `href`, or the text of a path a panel made clickable)
 * @param {{ cwd?: string, home?: string, origin?: string }} [where] `cwd`: the working directory of the tab or
 *   session the message belongs to (a relative path is resolved against it); `home`: the user's home folder
 *   (for `~`); `origin`: the page's own origin (an address on it is read as the path it holds, which is how a
 *   link sanitised before `data-file-target` existed looks)
 * @returns {{ path: string, candidates: string[], line: number | null, column: number | null,
 *   needsHome: boolean, sameOrigin: boolean } | null} null when the target is not a file's. `candidates` are
 *   the paths to try, in order; `path` is the first. `needsHome`: the target starts with `~` and no home was
 *   given, so there is nothing to try yet. `sameOrigin`: the target was an address of this app.
 */
export function parseFileLinkTarget(raw, { cwd = '', home = '', origin = '' } = {}) {
  const value = String(raw ?? '').trim();
  const kind = kindOf(value);
  if (!kind) return null;

  let written;
  let hash = '';
  let sameOrigin = false;
  if (kind === 'path') {
    const at = value.indexOf('#');
    written = at < 0 ? value : value.slice(0, at);
    hash = at < 0 ? '' : value.slice(at);
  } else {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (kind === 'web') {
      if (!origin || url.origin !== origin) return null;
      sameOrigin = true;
    } else if (url.host && url.host !== 'localhost') {
      return null; // a file on another machine
    }
    written = url.pathname;
    hash = url.hash;
  }

  // An agent may have escaped the path (a link with a space in it has to be); it may also hold a real "%".
  const spellings = kind === 'path' ? [...new Set([decoded(written), written])] : [decoded(written)];
  // A working directory that is not a whole path would be read from the server's own folder: it is not used.
  const root = isAbsolute(slashes(cwd)) ? normalizeFilePath(cwd) : '';
  const candidates = [];
  let line = null;
  let column = null;
  let needsHome = false;
  for (const spelling of spellings) {
    let path = slashes(spelling);
    const place = LINE_SUFFIX_RE.exec(path);
    if (place) {
      line ??= Number(place[1]) || null;
      column ??= Number(place[2]) || null;
      path = path.slice(0, place.index);
    }
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1); // file:///C:/…
    if (path === '~' || path.startsWith('~/')) {
      if (!home) { needsHome = true; continue; }
      path = `${slashes(home).replace(/\/+$/, '')}${path.slice(1)}`;
    }
    if (!path) continue;
    if (isAbsolute(path)) {
      candidates.push(normalizeFilePath(path));
      // The sanitiser used to turn `src/a.js` into `<origin>/src/a.js`: the same link, read from its project.
      if (sameOrigin && root) candidates.push(normalizeFilePath(`${root}/${path}`));
    } else if (root) {
      candidates.push(normalizeFilePath(`${root}/${path}`));
    }
  }

  const place = LINE_HASH_RE.exec(hash);
  if (place) {
    line = Number(place[1]) || line;
    column = Number(place[2]) || (Number(place[1]) ? null : column);
  }

  const unique = [...new Set(candidates.filter((path) => path && path !== '/'))];
  if (!unique.length && !needsHome) return null;
  return { path: unique[0] || '', candidates: unique, line, column, needsHome: needsHome && !unique.length, sameOrigin };
}

/** Whether `path` is one of `roots` or inside one. */
export function isInsideRoots(path, roots = []) {
  const target = normalizeFilePath(path);
  if (!isAbsolute(target)) return false;
  for (const root of roots) {
    const base = root ? normalizeFilePath(root) : '';
    if (!base || !isAbsolute(base)) continue;
    if (target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)) return true;
  }
  return false;
}

/** The last part of a path: the name a notice uses. */
export function fileLinkName(path) {
  const value = slashes(path).replace(/\/+$/, '');
  return value.slice(value.lastIndexOf('/') + 1) || value;
}

/** A path as a panel copies it: without the place in the file. */
export function withoutPlace(text) {
  return String(text ?? '').trim().replace(/:\d+(?::\d+)?$/, '');
}

/**
 * The tooltip of a link the editor may open.
 * @param {{ line?: number | null, column?: number | null }} target from parseFileLinkTarget()
 * @returns {{ key: 'open' | 'openAtLine' | 'openAtLineColumn', params: object }}
 */
export function fileLinkTitle(target) {
  if (!target?.line) return { key: 'open', params: {} };
  return target.column
    ? { key: 'openAtLineColumn', params: { line: target.line, column: target.column } }
    : { key: 'openAtLine', params: { line: target.line } };
}

/**
 * What `GET /api/file-content` said about a path: the editor's own answer to "can this be opened".
 * @param {{ status: number }} answer
 * @returns {{ ok: true } | { ok: false, reason: 'missing' | 'notText' | 'tooLarge' | 'outside' | 'failed' }}
 */
export function describeProbe({ status } = {}) {
  if (status === 200) return { ok: true };
  if (status === 415) return { ok: false, reason: 'notText' };
  if (status === 413) return { ok: false, reason: 'tooLarge' };
  if (status === 403) return { ok: false, reason: 'outside' };
  if (status === 400 || status === 404) return { ok: false, reason: 'missing' };
  return { ok: false, reason: 'failed' };
}

// A file that is there but cannot be edited says more than one that is not there at all.
const TELLING = ['failed', 'outside', 'missing', 'tooLarge', 'notText'];

/** Of two reasons a path was not opened, the one worth telling the user. */
export function moreTelling(a, b) {
  return TELLING.indexOf(b) > TELLING.indexOf(a) ? b : a;
}

/** A `FILE_LINK_COPY` sentence with its `{params}` filled in. */
export function fillFileLinkCopy(key, params = {}) {
  return String(FILE_LINK_COPY[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? params[name] : whole));
}

// ── The click ──

/**
 * Whether a link would run a script or draw data when the browser follows it: its `href` (or an SVG link's
 * `xlink:href`) read the way kindOf reads a target (entities decoded, controls and invisible characters dropped,
 * lower case), and the scheme the browser itself resolved. Nothing else an anchor carries is asked.
 * @param {Element} anchor
 */
export function isActiveLink(anchor) {
  for (const name of ['href', 'xlink:href']) {
    const value = anchor.getAttribute?.(name);
    if (value != null && isActive(schemeView(String(value)))) return true;
  }
  const resolved = typeof anchor.protocol === 'string' ? anchor.protocol.replace(/:$/, '').toLowerCase() : '';
  return ACTIVE_SCHEMES.has(resolved);
}

// A kept target is the sanitiser's note of the href as written (safeHref resolved it against the page, or dropped
// it). It counts only while it is a file's and the href says the same thing; anything else is the href's to say.
function keptTarget(anchor, href) {
  const kept = anchor.getAttribute('data-file-target');
  if (!kept || localFileHref(kept) == null) return null;
  if (href == null) return kept; // file:, C:\…, name.ext:12: the sanitiser writes no href for them
  try {
    const base = anchor.baseURI || `${new URL(href).origin}/`;
    return new URL(kept.trim(), base).href === new URL(href, base).href ? kept : null;
  } catch { return null; }
}

/**
 * What a link points at, as the agent wrote it.
 * @param {Element} anchor
 * @param {{ textLinks?: string }} [options] `textLinks`: the selector of the panel's own path links, the ones
 *   it makes out of a path in plain text (their text is the target, their `href` is "#")
 * @returns {{ raw: string, text: boolean } | null}
 */
export function readFileLink(anchor, { textLinks = '' } = {}) {
  const href = anchor.getAttribute('href');
  const kept = keptTarget(anchor, href);
  if (kept) return { raw: kept, text: false };
  if (textLinks && anchor.matches(textLinks) && (!href || href === '#')) return { raw: anchor.textContent || '', text: true };
  return href ? { raw: href, text: false } : null;
}

/**
 * The click and hover handlers of the links in a panel's messages.
 * @param {object} page what the handlers need from the page
 * @param {(event: string, data: object) => void} page.emit the bus (`open-file-editor`)
 * @param {(path: string) => Promise<number>} page.probe the status GET /api/file-content answers for a path
 * @param {() => Promise<string>} page.home the user's home folder ('' when it cannot be told)
 * @param {() => string} page.origin the page's origin
 * @param {(key: string, params?: object) => string} page.say a `fileLinks.*` sentence
 * @param {(message: string) => void} page.notify shows a short message
 * @param {(anchor: Element) => void} page.follow goes where a link of this app leads, as the browser would (only
 *   ever for an http(s) address of this app that is the anchor's own href: never a script link)
 */
export function createFileLinkHandlers(page) {
  const whereOf = (anchor, options) => {
    let cwd = '';
    try { cwd = options.cwd?.(anchor) || ''; } catch { cwd = ''; }
    return { cwd, origin: page.origin() };
  };

  async function openOrFallBack(anchor, link, where, target, options) {
    let found = target;
    if (found.needsHome) found = parseFileLinkTarget(link.raw, { ...where, home: await page.home() });

    let reason = null;
    for (const path of found?.candidates || []) {
      let answer;
      try { answer = describeProbe({ status: await page.probe(path) }); } catch { answer = { ok: false, reason: 'failed' }; }
      if (answer.ok) {
        page.emit('open-file-editor', { filePath: path, line: found.line || undefined, column: found.column || undefined });
        return 'opened';
      }
      reason = reason ? moreTelling(reason, answer.reason) : answer.reason;
    }
    reason ||= 'missing'; // nothing to try: `~` with no home folder to read it from

    // Not a file the editor opens. The link keeps what it did before, or the reason is said.
    if (link.text && typeof options.copyPath === 'function') {
      try { await options.copyPath(anchor, withoutPlace(link.raw)); return 'copied'; } catch { /* could not copy: say why it did not open */ }
    }
    if (target.sameOrigin) { page.follow(anchor); return 'followed'; }
    (options.notify || page.notify)(page.say(reason, { name: fileLinkName(found?.path || withoutPlace(link.raw)) }));
    return reason;
  }

  /**
   * Take a click on a link in an agent's message when the link points at a file.
   * @param {MouseEvent} event
   * @param {object} [options]
   * @param {Element} [options.within] only links inside this element are taken
   * @param {(anchor: Element) => string} [options.cwd] the working directory of the tab or session the link's
   *   message belongs to: a relative path is a path in it
   * @param {string} [options.textLinks] selector of the panel's own path links (see readFileLink)
   * @param {(anchor: Element, path: string) => any} [options.copyPath] what a click on one of those did
   *   before: it runs when the path is not a file the editor opens
   * @param {(message: string) => void} [options.notify] shows the reason a link was not opened
   * @returns {Promise<string> | null} null when the click is not this handler's (the browser follows the
   *   link as before); else the click is taken and the promise says how it ended: 'opened', 'copied',
   *   'followed', 'blocked' (a script or data link), or the reason the user was told
   */
  function handleClick(event, options = {}) {
    if (event.defaultPrevented || event.button > 0) return null;
    const anchor = event.target?.closest?.('a');
    if (!anchor || (options.within && !options.within.contains(anchor))) return null;
    // A script or data link in an agent's message goes nowhere, however it is spelled and whatever else the anchor
    // says (a kept target, a download): the Codex panel's Markdown is not sanitised, so its href can still be one.
    if (isActiveLink(anchor)) { event.preventDefault(); return Promise.resolve('blocked'); }
    if (anchor.hasAttribute?.('download')) return null; // a file the app itself offers
    const link = readFileLink(anchor, options);
    if (!link) return null;
    const where = whereOf(anchor, options);
    const target = parseFileLinkTarget(link.raw, where);
    if (!target) {
      if (!link.text || typeof options.copyPath !== 'function') return null;
      event.preventDefault();
      try { options.copyPath(anchor, withoutPlace(link.raw)); } catch { /* nothing to copy to */ }
      return Promise.resolve('copied');
    }
    event.preventDefault();
    return openOrFallBack(anchor, link, where, target, options);
  }

  /** A link the editor may open says so when it is pointed at, unless it already says something. */
  function label(event, options = {}) {
    const anchor = event.target?.closest?.('a');
    if (!anchor || anchor.title || (options.within && !options.within.contains(anchor))) return;
    const link = readFileLink(anchor, options);
    if (!link || link.text) return;
    const target = parseFileLinkTarget(link.raw, whereOf(anchor, options));
    if (!target || target.sameOrigin) return;
    const { key, params } = fileLinkTitle(target);
    anchor.title = page.say(key, params);
  }

  return { handleClick, label };
}
