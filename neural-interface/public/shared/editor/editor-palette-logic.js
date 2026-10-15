// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: what the palette lists
// ═══════════════════════════════════════════
//
// The decisions behind the command palette and go-to-file (editor-palette.js
// opens them): which commands are listed, how what was typed is matched
// against a name, in which order the matches come, and what a file search
// asks the server and makes of its answer. No DOM and no imports: loaded by
// `node --test` as it is.

/** Rows a list shows at most. */
export const PALETTE_LIMIT = 50;
/** A file search waits this long after the last key before it asks the server. */
export const FILE_SEARCH_DELAY_MS = 120;

const isUpper = (c) => c >= 65 && c <= 90;
const isLower = (c) => c >= 97 && c <= 122;
const isAlnum = (c) => isUpper(c) || isLower(c) || (c >= 48 && c <= 57) || c > 127;

/**
 * How well `query` matches `text`: its characters in order, anywhere in the text (case does not count). A match
 * at the start of a word, and characters that follow one another, count for more; so does a text with little
 * else in it. Null when the characters are not all there.
 * @returns {number | null}
 */
export function fuzzyScore(text, query) {
  const hay = String(text ?? '');
  const needle = String(query ?? '').toLowerCase();
  if (!needle) return 0;
  const lower = hay.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (let i = 0; i < needle.length; i++) {
    const wanted = needle[i];
    // The next place this character stands, a word start before any other.
    let at = -1;
    for (let j = lower.indexOf(wanted, from); j !== -1; j = lower.indexOf(wanted, j + 1)) {
      if (j === previous + 1) { at = j; break; }   // straight after the last one: the run goes on
      const before = j ? hay.charCodeAt(j - 1) : 0;
      const here = hay.charCodeAt(j);
      if (j === 0 || !isAlnum(before) || (isLower(before) && isUpper(here))) { at = j; break; }
      if (at === -1) at = j;
    }
    if (at === -1) return null;
    const before = at ? hay.charCodeAt(at - 1) : 0;
    const wordStart = at === 0 || !isAlnum(before) || (isLower(before) && isUpper(hay.charCodeAt(at)));
    score += 10 + (at === previous + 1 ? 14 : 0) + (wordStart ? 12 : 0) - Math.min(8, Math.max(0, at - from));
    previous = at;
    from = at + 1;
  }
  if (lower.startsWith(needle)) score += 20;
  return score - Math.min(20, Math.floor((hay.length - needle.length) / 4));
}

/** The words of what was typed. */
export const queryTerms = (query) => String(query ?? '').trim().split(/\s+/).filter(Boolean);

/** Every word must match; the scores add up. Null when one does not. */
function scoreTerms(text, terms) {
  let total = 0;
  for (const term of terms) {
    const score = fuzzyScore(text, term);
    if (score === null) return null;
    total += score;
  }
  return total;
}

/**
 * The commands a palette lists: the ones that can be run from a list (a command with only a mouse gesture, or
 * one marked `palette: false` because it acts on something a list takes the keyboard from, is not), of the
 * features this server has.
 * @param {object[]} commands editor-commands.js
 * @param {{ features?: string[] }} [o]
 * @returns {{ id: string, titleKey: string, key: string | null }[]}
 */
export function paletteCommands(commands, { features = [] } = {}) {
  const seen = new Set();
  const rows = [];
  for (const command of commands) {
    if (typeof command.run !== 'function' || command.palette === false) continue;
    if (command.feature && !features.includes(command.feature)) continue;
    if (seen.has(command.id)) continue;
    seen.add(command.id);
    rows.push({ id: command.id, titleKey: command.titleKey, key: command.keys?.[0] || null });
  }
  return rows;
}

/**
 * Rows in the order a list shows them for what was typed: the best match first; rows that match equally keep
 * the order they came in. Nothing typed: every row, as it came.
 * @param {{ label: string, detail?: string }[]} rows `detail`: more words that may be matched (a folder), for less
 * @param {string} query
 * @param {{ limit?: number }} [o]
 */
export function rankRows(rows, query, { limit = PALETTE_LIMIT } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return rows.slice(0, limit);
  const scored = [];
  rows.forEach((row, index) => {
    const own = scoreTerms(row.label, terms);
    const wider = row.detail ? scoreTerms(`${row.detail}/${row.label}`, terms) : null;
    // A match in the name itself comes before one that needs the folder.
    const score = own !== null ? own + 1000 : wider;
    if (score !== null) scored.push({ row, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.row);
}

/**
 * What a file search asks GET /api/project-files for. The server looks for one run of characters in a path: the
 * longest word that was typed is sent, and the other words are matched here.
 * @param {string} project the project's folder
 * @param {string} query
 * @returns {string | null} the query string, or null when nothing was typed (nothing is asked then)
 */
export function fileSearchParams(project, query) {
  const terms = queryTerms(query);
  if (!project || !terms.length) return null;
  const longest = terms.reduce((best, term) => (term.length > best.length ? term : best), '');
  return new URLSearchParams({ path: project, search: longest, recursive: '1', filesOnly: '1' }).toString();
}

const slashes = (path) => String(path ?? '').replace(/\\/g, '/');

/**
 * The registered project a file is in: the one whose folder holds it, the innermost when projects are nested.
 * Go-to-file searches it when no project is selected in the File Explorer (a file opened from a link in a chat).
 * @param {string} path a file's path
 * @param {{ path?: string }[]} projects the registered projects, as GET /api/projects lists them
 * @returns {string | null} the project's folder
 */
export function projectFor(path, projects) {
  const file = slashes(path);
  let best = null;
  for (const project of Array.isArray(projects) ? projects : []) {
    const root = slashes(project?.path).replace(/\/+$/, '');
    if (root && file.startsWith(`${root}/`) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

/**
 * The files of a search answer, as rows.
 * @param {{ path?: string, items?: object[] } | null} body what GET /api/project-files answered
 * @returns {{ id: string, label: string, detail: string }[]} `id`: the file's full path; `detail`: its folder
 *   inside the project ('' at the top)
 */
export function fileRows(body) {
  const folder = slashes(body?.path).replace(/\/+$/, '');
  if (!folder || !Array.isArray(body?.items)) return [];
  const rows = [];
  for (const item of body.items) {
    if (!item || item.type !== 'file' || typeof item.name !== 'string') continue;
    const inside = slashes(typeof item.relativePath === 'string' && item.relativePath ? item.relativePath : item.name).replace(/^\/+/, '');
    const cut = inside.lastIndexOf('/');
    rows.push({ id: `${folder}/${inside}`, label: item.name, detail: cut > 0 ? inside.slice(0, cut) : '' });
  }
  return rows;
}

/**
 * The open tabs as rows, for a go-to-file list in which nothing was typed yet: the tab used last first.
 * @param {{ path: string, name: string }[]} tabs in the order they were last used
 * @param {string | null} project the project's folder: a tab inside it shows its folder from there
 */
export function tabRows(tabs, project) {
  const root = slashes(project).replace(/\/+$/, '');
  return tabs.filter((tab) => tab?.path).map((tab) => {
    const path = slashes(tab.path);
    const inside = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    const cut = inside.lastIndexOf('/');
    return { id: path, label: tab.name || inside.slice(cut + 1), detail: cut > 0 ? inside.slice(0, cut) : '' };
  });
}

/**
 * What go-to-file says in place of a list that is empty (an i18n key). An answer that is not in yet is not
 * "no file": while a search is waiting to be sent or on its way, it says so.
 * @param {{ rootKnown: boolean, root: string | null, failed: boolean, pending: boolean, typed: string }} s
 *   `rootKnown`: the folder to search was asked for and answered (`root`: it, or null when there is none);
 *   `pending`: a search for what is typed has not answered yet; `failed`: the last one did not answer
 */
export function fileListEmpty({ rootKnown, root, failed, pending, typed } = {}) {
  if (rootKnown && !root) return 'editor.palette.noProject';
  if (!queryTerms(typed).length) return 'editor.palette.typeToSearch';
  if (pending || !rootKnown) return 'editor.palette.searching';
  return failed ? 'editor.palette.searchFailed' : 'editor.palette.noFile';
}
