// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the panel's decisions
// ═══════════════════════════════════════════
//
// What the editor panel decides without touching the page: the path it shows,
// the state of its buttons, the events of a plan being edited, and what a
// refused file means. editor-panel.js renders from these. No DOM and no
// imports: loaded by `node --test` as it is.

/** A file size the way the status bar writes it. */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The path the header shows: relative to the selected project, or the whole path without its leading slash
 * when no project is selected (or the file is not in it).
 */
export function displayPath(path, projectRoot) {
  const full = String(path ?? '');
  const rel = projectRoot ? full.replace(String(projectRoot).replace(/\\/g, '/'), '') : full;
  return rel.startsWith('/') ? rel.slice(1) : rel;
}

/** The name a plan's banner uses for the panel that opened it. */
export function planSourceLabel(source) {
  if (source === 'codex') return 'Codex';
  if (source === 'opencode') return 'OpenCode';
  return 'Claude';
}

/**
 * The identity every plan event carries, from the contract `open-plan-editor` delivered.
 * @param {{ source?: string, tabId?: any, planId?: any, revision?: any, accountId?: any, threadId?: any, sidepanelWindowId?: any }} contract
 * @param {object} [extra] the fields of the particular event
 */
export function planEvent(contract, extra = {}) {
  const { source = 'claude', tabId = null, planId, revision, accountId, threadId, sidepanelWindowId = null } = contract || {};
  return { source, tabId, planId, revision, accountId, threadId, sidepanelWindowId: sidepanelWindowId || null, ...extra };
}

/** What tells one plan request from another: the panel and tab that asked, the plan and its revision. */
export function planIdentityKey(contract) {
  const { source = 'claude', tabId = null, planId, revision, sidepanelWindowId = null } = contract || {};
  return [source, tabId ?? '', planId ?? '', revision ?? '', sidepanelWindowId || ''].join('|');
}

/**
 * Whether two plan requests come from the same place: the same tab of the same panel. That place follows one
 * plan editor at a time, so a second plan of its own takes the first one's tab.
 */
export function isSamePlanOwner(a, b) {
  if (!a || !b) return false;
  return (a.source ?? 'claude') === (b.source ?? 'claude')
    && (a.tabId ?? null) === (b.tabId ?? null)
    && (a.sidepanelWindowId || null) === (b.sidepanelWindowId || null);
}

/** Whether `contract` asks for the plan revision that is already open (the editor is then only focused). */
export function isSamePlan(open, contract) {
  if (!open || !contract) return false;
  return open.filePath === contract.filePath
    && (open.source ?? 'claude') === (contract.source ?? 'claude')
    && (open.tabId ?? null) === (contract.tabId ?? null)
    && open.planId === contract.planId
    && open.revision === contract.revision;
}

/**
 * Whether the file on disk still holds the plan revision the panel asked to edit. Line endings are not part of
 * a revision: both sides are compared with "\n".
 * @param {string} content the file as read
 * @param {string | undefined} expected the contract's `expectedMarkdown`; anything but a string means no check
 */
export function matchesExpectedMarkdown(content, expected) {
  if (typeof expected !== 'string') return true;
  return String(content).replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n');
}

/** Whether a path is the user's OpenCode configuration file (OpenCode 2's opencode.json or opencode.jsonc). */
export function isOpencodeConfigPath(path) {
  return /\/\.config\/opencode\/opencode\.jsonc?$/.test(String(path || '').replace(/\\/g, '/'));
}

const OUTSIDE_ROOTS = 'Path outside registered project roots';

/**
 * What a failed `GET /api/file-content` means for the panel.
 * @param {{ status: number, body?: object, path?: string }} failure
 * @returns {{ kind: 'toast' | 'refused', key: string, params?: object, text?: string }}
 *   `toast`: nothing opens; `text` (the server's own words) wins over the translation of `key` when present.
 *   `refused`: the panel opens with the message of `key` in place of an editor.
 */
export function describeOpenFailure({ status, body, path } = {}) {
  const error = typeof body?.error === 'string' ? body.error : '';
  if (status === 403 && error === OUTSIDE_ROOTS && isOpencodeConfigPath(path)) {
    return { kind: 'toast', key: 'editor.toast.restartForOpencodeConfig' };
  }
  if (status === 415) {
    return body?.reason === 'encoding'
      ? { kind: 'refused', key: 'editor.refused.encoding' }
      : { kind: 'refused', key: 'editor.refused.binary' };
  }
  if (status === 413) {
    const max = Number(body?.maxBytes);
    return Number.isFinite(max) && max > 0
      ? { kind: 'toast', key: 'editor.toast.tooLargeOver', params: { size: formatSize(max) } }
      : { kind: 'toast', key: 'editor.toast.tooLarge' };
  }
  return { kind: 'toast', key: 'editor.toast.cannotOpen', text: error };
}

/**
 * The state of the header's buttons.
 * @param {{ ready: boolean, dirty: boolean, saving: boolean, plan: boolean, changelog?: boolean }} s `ready`: a
 *   document is open; `plan`, `changelog`: a plan or a changelog draft is being edited (either can be saved
 *   unchanged, which approves it as it is)
 */
export function controlsState({ ready, dirty, saving, plan, changelog = false }) {
  return {
    saveDisabled: !ready || saving || (!dirty && !plan && !changelog),
    discardDisabled: !ready || saving || !dirty,
  };
}

/**
 * The status bar's indentation item.
 * @param {{ kind: 'spaces' | 'tabs', tabSize: number }} indent from resolveIndentation()
 * @returns {{ key: string, params: { n: number } }}
 */
export function indentStatus(indent) {
  return { key: indent?.kind === 'tabs' ? 'editor.status.tabSize' : 'editor.status.spaces', params: { n: indent?.tabSize ?? 2 } };
}

/**
 * The status bar's line-ending item: the style, or what a save turns a mixed file into.
 * @param {{ eol: 'LF' | 'CRLF', mixed: boolean }} ending from detectLineEnding()
 * @returns {{ key: string | null, params?: { eol: string }, text?: string }} `key: null` → show `text` as it is
 */
export function eolStatus(ending) {
  const eol = ending?.eol === 'CRLF' ? 'CRLF' : 'LF';
  return ending?.mixed ? { key: 'editor.status.eolMixed', params: { eol } } : { key: null, text: eol };
}

/**
 * The status bar's position item.
 * @param {{ line: number, column: number, selected: number, cursors: number }} at
 * @returns {{ key: string, params: object }}
 */
export function positionStatus({ line, column, selected = 0, cursors = 1 }) {
  // Several carets: the place of the main one, how many there are, and what they select together.
  if (cursors > 1) {
    return selected > 0
      ? { key: 'editor.status.cursorsSelected', params: { line, column, count: cursors, selected } }
      : { key: 'editor.status.cursors', params: { line, column, count: cursors } };
  }
  if (selected > 0) return { key: 'editor.status.positionSelected', params: { line, column, selected } };
  return { key: 'editor.status.position', params: { line, column } };
}

/**
 * The question asked before tabs with unsaved changes are closed.
 * @param {string[]} unsaved the names of the files that have unsaved changes
 * @param {{ only?: boolean }} [o] `only`: the one tab that is open is being closed (the question the editor
 *   asked before it had tabs)
 * @returns {{ key: string, params?: object } | null} null: nothing is unsaved, nothing is asked
 */
export function closeConfirm(unsaved, { only = false } = {}) {
  const names = Array.isArray(unsaved) ? unsaved : [];
  if (!names.length) return null;
  if (only) return { key: 'editor.confirm.close' };
  if (names.length === 1) return { key: 'editor.confirm.closeOne', params: { name: names[0] } };
  return { key: 'editor.confirm.closeMany', params: { count: names.length, files: names.map((name) => `\u2022 ${name}`).join('\n') } };
}

/** The indentations the status bar offers, beside "Detect". */
export const INDENT_CHOICES = Object.freeze([
  Object.freeze({ id: 'spaces-2', kind: 'spaces', size: 2 }),
  Object.freeze({ id: 'spaces-4', kind: 'spaces', size: 4 }),
  Object.freeze({ id: 'spaces-8', kind: 'spaces', size: 8 }),
  Object.freeze({ id: 'tabs', kind: 'tabs' }),
]);

/** The choice an id of the indentation menu stands for; null for "detect" (and for anything else). */
export function indentChoice(id) {
  const found = INDENT_CHOICES.find((choice) => choice.id === id);
  return found ? { kind: found.kind, ...(found.size ? { size: found.size } : {}) } : null;
}

/** The id of the menu item that is in force: the user's choice, or 'detect' when there is none. */
export function indentChoiceId(choice) {
  if (!choice) return 'detect';
  return choice.kind === 'tabs' ? 'tabs' : `spaces-${choice.size}`;
}

/**
 * The languages a search of the status bar's list finds: those whose name or other names hold the words typed,
 * the ones whose name starts with them first.
 * @param {{ name: string, alias?: readonly string[] }[]} languages
 * @param {string} query
 * @returns {string[]} names
 */
export function filterLanguages(languages, query) {
  const list = (languages || []).filter((language) => language && typeof language.name === 'string');
  const wanted = String(query ?? '').trim().toLowerCase();
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  if (!wanted) return list.map((language) => language.name).sort(byName);
  const starts = []; const holds = [];
  for (const language of list) {
    const name = language.name.toLowerCase();
    if (name.startsWith(wanted)) starts.push(language.name);
    else if (name.includes(wanted) || (language.alias || []).some((alias) => String(alias).toLowerCase().includes(wanted))) holds.push(language.name);
  }
  return [...starts.sort(byName), ...holds.sort(byName)];
}

// ── The View menu ──

/** The sizes the text can have, as the preferences allow them (editor-prefs.js keeps the same numbers). */
export const VIEW_FONT = Object.freeze({ min: 10, max: 18, base: 12 });

/**
 * The View menu's entries for the preferences in force.
 * @param {{ wordWrap: boolean, minimap: boolean, indentGuides: boolean, renderWhitespace: string, fontSize: number }} editing
 * @returns {({ separator: true } | { id: string, labelKey: string, checked?: boolean, toggle?: boolean,
 *   disabled?: boolean, hintKey?: string, hintParams?: object })[]} `toggle`: a switch (the others with `checked`
 *   are one choice among several)
 */
export function viewMenuItems(editing = {}) {
  const size = Number(editing.fontSize) || VIEW_FONT.base;
  const whitespace = ['none', 'selection', 'all'].includes(editing.renderWhitespace) ? editing.renderWhitespace : 'none';
  return [
    { id: 'wordWrap', labelKey: 'editor.view.wordWrap', checked: editing.wordWrap !== false, toggle: true },
    { id: 'minimap', labelKey: 'editor.view.minimap', checked: editing.minimap !== false, toggle: true },
    { id: 'indentGuides', labelKey: 'editor.view.indentGuides', checked: editing.indentGuides !== false, toggle: true },
    { separator: true },
    { id: 'whitespace:none', labelKey: 'editor.view.whitespaceNone', checked: whitespace === 'none' },
    { id: 'whitespace:selection', labelKey: 'editor.view.whitespaceSelection', checked: whitespace === 'selection' },
    { id: 'whitespace:all', labelKey: 'editor.view.whitespaceAll', checked: whitespace === 'all' },
    { separator: true },
    { id: 'font:larger', labelKey: 'editor.view.fontLarger', disabled: size >= VIEW_FONT.max, hintKey: 'editor.view.fontSize', hintParams: { size } },
    { id: 'font:smaller', labelKey: 'editor.view.fontSmaller', disabled: size <= VIEW_FONT.min },
    { id: 'font:reset', labelKey: 'editor.view.fontReset', disabled: size === VIEW_FONT.base },
  ];
}

/**
 * What choosing an entry of the View menu changes.
 * @param {string} id an entry's id
 * @param {object} editing the preferences in force
 * @returns {object | null} the part of the `editing` preferences to store, or null for an entry that changes nothing
 */
export function viewMenuChange(id, editing = {}) {
  const size = Number(editing.fontSize) || VIEW_FONT.base;
  switch (id) {
    case 'wordWrap': return { wordWrap: editing.wordWrap === false };
    case 'minimap': return { minimap: editing.minimap === false };
    case 'indentGuides': return { indentGuides: editing.indentGuides === false };
    case 'whitespace:none': return editing.renderWhitespace === 'none' ? null : { renderWhitespace: 'none' };
    case 'whitespace:selection': return editing.renderWhitespace === 'selection' ? null : { renderWhitespace: 'selection' };
    case 'whitespace:all': return editing.renderWhitespace === 'all' ? null : { renderWhitespace: 'all' };
    case 'font:larger': return size >= VIEW_FONT.max ? null : { fontSize: size + 1 };
    case 'font:smaller': return size <= VIEW_FONT.min ? null : { fontSize: size - 1 };
    case 'font:reset': return size === VIEW_FONT.base ? null : { fontSize: VIEW_FONT.base };
    default: return null;
  }
}

/** The next way of drawing whitespace, for a command that goes through them: none → selection → all → none. */
export function nextWhitespace(current) {
  const order = ['none', 'selection', 'all'];
  return order[(order.indexOf(current) + 1) % order.length] || 'none';
}

/** Narrower than this, the editor has no room for a minimap. */
export const MINIMAP_MIN_WIDTH = 760;

/**
 * Whether a document shows the minimap.
 * @param {{ preference: boolean, width: number, large: boolean }} o `width`: the editor's, in pixels; `large`: the
 *   document is over the size the minimap is drawn for (editor-doc.js: isLargeDocument)
 */
export function minimapShown({ preference, width, large }) {
  return preference !== false && !large && Number(width) >= MINIMAP_MIN_WIDTH;
}
