// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: commands
// ═══════════════════════════════════════════
//
// One list of what the editor can be told to do: an id, the i18n key of its
// name, the keys that run it, and the function. The keymap is built from it,
// and so are the shortcuts popover and the command palette. Keys follow
// VS Code; `Mod` is Cmd on macOS and Ctrl elsewhere.
//
// A command's `run` gets `{ cm, view, actions }`: the vendored CodeMirror
// bundle, the editor view, and what the panel offers (save, find, wrap). It
// returns true when it did something. No DOM and no imports: loaded by
// `node --test` as it is.

/**
 * @typedef {object} EditorCommand
 * @property {string} id
 * @property {string} titleKey i18n key of its name
 * @property {string[]} [keys] CodeMirror key names, the first one is the one shown
 * @property {string[]} [macKeys] further keys that run it on macOS only
 * @property {{ code: string | string[], alt?: boolean, shift?: boolean }} [physical] a key matched by its position
 *   on the keyboard instead of the character it types: Alt with a letter types a symbol on macOS, so its name is
 *   no use. Several codes: the key sits in another place on some keyboards
 * @property {string} [gesture] a mouse gesture, for the shortcuts list only
 * @property {string} [scope] where the keys work: 'editor' (default) or 'editor search-panel'
 * @property {boolean} [passive] the key is the command's only when it acted: otherwise it does what it always did
 * @property {boolean} [first] its keys are tried before the keys of commands that are not marked
 * @property {string} [feature] it belongs to a feature the server may not have ('ai', 'git'): listed only when it does
 * @property {boolean} [palette] false: not in the command palette (it acts on something a list takes the keyboard from)
 * @property {(ctx: { cm: object, view: object, actions: object }) => boolean} [run]
 */

// Tab: accept the open completion, indent the selected lines, or insert one indent unit at the caret.
function tab({ cm, view }) {
  const { state } = view;
  if (state.readOnly) return false;
  if (cm.completionStatus(state) === 'active') return cm.acceptCompletion(view);
  if (state.selection.ranges.some((range) => !range.empty)) return cm.indentMore(view);
  view.dispatch(state.replaceSelection(state.facet(cm.indentUnit)), { scrollIntoView: true, userEvent: 'input' });
  return true;
}

/** @type {EditorCommand[]} */
export const EDITOR_COMMANDS = [
  // Ctrl-S saves on macOS too, as it did before CodeMirror.
  { id: 'file.save', titleKey: 'editor.command.save', keys: ['Mod-s'], macKeys: ['Ctrl-s'], scope: 'editor search-panel', run: ({ actions }) => { actions.save(); return true; } },

  { id: 'find.open', titleKey: 'editor.command.find', keys: ['Mod-f'], scope: 'editor search-panel', run: ({ view, actions }) => actions.openFind(view) },
  { id: 'find.replace', titleKey: 'editor.command.replace', keys: ['Mod-Alt-f', 'Mod-h'], scope: 'editor search-panel', run: ({ view, actions }) => actions.openReplace(view) },
  { id: 'find.next', titleKey: 'editor.command.findNext', keys: ['F3'], scope: 'editor search-panel', run: ({ view, actions }) => actions.findNext(view) },
  { id: 'find.previous', titleKey: 'editor.command.findPrevious', keys: ['Shift-F3'], scope: 'editor search-panel', run: ({ view, actions }) => actions.findPrevious(view) },
  { id: 'goto.line', titleKey: 'editor.command.goToLine', keys: ['Mod-g'], scope: 'editor search-panel', run: ({ view, actions }) => actions.openGoToLine(view) },

  { id: 'edit.undo', titleKey: 'editor.command.undo', keys: ['Mod-z'], run: ({ cm, view }) => cm.undo(view) },
  { id: 'edit.redo', titleKey: 'editor.command.redo', keys: ['Mod-Shift-z', 'Mod-y'], run: ({ cm, view }) => cm.redo(view) },

  { id: 'select.nextOccurrence', titleKey: 'editor.command.selectNextOccurrence', keys: ['Mod-d'], run: ({ cm, view }) => cm.selectNextOccurrence(view) },
  { id: 'select.allOccurrences', titleKey: 'editor.command.selectAllOccurrences', keys: ['Mod-Shift-l'], run: ({ cm, view }) => cm.selectSelectionMatches(view) },

  { id: 'line.copyDown', titleKey: 'editor.command.copyLineDown', keys: ['Shift-Alt-ArrowDown'], run: ({ cm, view }) => cm.copyLineDown(view) },
  { id: 'line.copyUp', titleKey: 'editor.command.copyLineUp', keys: ['Shift-Alt-ArrowUp'], run: ({ cm, view }) => cm.copyLineUp(view) },
  { id: 'line.moveDown', titleKey: 'editor.command.moveLineDown', keys: ['Alt-ArrowDown'], run: ({ cm, view }) => cm.moveLineDown(view) },
  { id: 'line.moveUp', titleKey: 'editor.command.moveLineUp', keys: ['Alt-ArrowUp'], run: ({ cm, view }) => cm.moveLineUp(view) },
  { id: 'line.delete', titleKey: 'editor.command.deleteLine', keys: ['Mod-Shift-k'], run: ({ cm, view }) => cm.deleteLine(view) },

  { id: 'comment.line', titleKey: 'editor.command.toggleLineComment', keys: ['Mod-/'], run: ({ cm, view }) => cm.toggleComment(view) },
  { id: 'comment.block', titleKey: 'editor.command.toggleBlockComment', keys: ['Shift-Alt-a'], physical: { code: 'KeyA', alt: true, shift: true }, run: ({ cm, view }) => cm.toggleBlockComment(view) },

  { id: 'indent.more', titleKey: 'editor.command.indent', keys: ['Tab', 'Mod-]'], run: (ctx) => (ctx.key === 'Tab' ? tab(ctx) : ctx.cm.indentMore(ctx.view)) },
  { id: 'indent.less', titleKey: 'editor.command.outdent', keys: ['Shift-Tab', 'Mod-['], run: ({ cm, view }) => cm.indentLess(view) },

  { id: 'cursor.add', titleKey: 'editor.command.addCursor', gesture: 'Alt-Click' },
  { id: 'cursor.addBelow', titleKey: 'editor.command.addCursorBelow', keys: ['Mod-Alt-ArrowDown'], run: ({ cm, view }) => cm.addCursorBelow(view) },
  { id: 'cursor.addAbove', titleKey: 'editor.command.addCursorAbove', keys: ['Mod-Alt-ArrowUp'], run: ({ cm, view }) => cm.addCursorAbove(view) },
  { id: 'select.column', titleKey: 'editor.command.columnSelection', gesture: 'Shift-Alt-Drag' },

  { id: 'fold.fold', titleKey: 'editor.command.fold', keys: ['Mod-Shift-['], run: ({ cm, view }) => cm.foldCode(view) },
  { id: 'fold.unfold', titleKey: 'editor.command.unfold', keys: ['Mod-Shift-]'], run: ({ cm, view }) => cm.unfoldCode(view) },
  { id: 'bracket.jump', titleKey: 'editor.command.jumpToBracket', keys: ['Mod-Shift-\\'], run: ({ cm, view }) => cm.cursorMatchingBracket(view) },

  { id: 'view.wordWrap', titleKey: 'editor.command.toggleWordWrap', keys: ['Alt-z'], physical: { code: 'KeyZ', alt: true }, run: ({ actions }) => { actions.toggleWordWrap(); return true; } },
  // The rest of the View menu: no keys of their own, they are run from the menu or the palette.
  { id: 'view.minimap', titleKey: 'editor.command.toggleMinimap', run: ({ actions }) => { actions.toggleMinimap?.(); return true; } },
  { id: 'view.indentGuides', titleKey: 'editor.command.toggleIndentGuides', run: ({ actions }) => { actions.toggleIndentGuides?.(); return true; } },
  { id: 'view.whitespace', titleKey: 'editor.command.cycleWhitespace', run: ({ actions }) => { actions.cycleWhitespace?.(); return true; } },
  { id: 'view.fontLarger', titleKey: 'editor.command.fontLarger', run: ({ actions }) => { actions.fontLarger?.(); return true; } },
  { id: 'view.fontSmaller', titleKey: 'editor.command.fontSmaller', run: ({ actions }) => { actions.fontSmaller?.(); return true; } },
  { id: 'view.fontReset', titleKey: 'editor.command.fontReset', run: ({ actions }) => { actions.fontReset?.(); return true; } },

  // The palette and go-to-file. Mod-P and Mod-Shift-P are the browser's "print": the editor takes them while it
  // has the keyboard. F1 is the palette's first key.
  { id: 'palette.commands', titleKey: 'editor.command.commandPalette', keys: ['F1', 'Mod-Shift-p'], scope: 'editor search-panel', palette: false, run: ({ actions }) => { actions.openPalette?.(); return true; } },
  { id: 'palette.files', titleKey: 'editor.command.goToFile', keys: ['Mod-p'], scope: 'editor search-panel', run: ({ actions }) => { actions.openGoToFile?.(); return true; } },

  // Problems the editor found in the file (editor-lint.js), and the file against the last commit (editor-git.js).
  { id: 'lint.next', titleKey: 'editor.command.nextProblem', keys: ['F8'], run: ({ view, actions }) => actions.nextProblem?.(view) === true },
  { id: 'lint.previous', titleKey: 'editor.command.previousProblem', keys: ['Shift-F8'], run: ({ view, actions }) => actions.previousProblem?.(view) === true },
  { id: 'git.diff', titleKey: 'editor.command.toggleDiff', feature: 'git', run: ({ actions }) => { actions.toggleDiff?.(); return true; } },

  // Tabs. A browser keeps Mod-W, Mod-T and Ctrl-Tab for its own tabs and never hands them to a page: these are
  // keys it leaves alone. Matched by position, as Alt with a letter or a sign types another character on macOS.
  { id: 'tab.next', titleKey: 'editor.command.nextTab', keys: ['Alt-.'], physical: { code: 'Period', alt: true }, run: ({ actions }) => { actions.nextTab?.(); return true; } },
  { id: 'tab.previous', titleKey: 'editor.command.previousTab', keys: ['Alt-,'], physical: { code: 'Comma', alt: true }, run: ({ actions }) => { actions.previousTab?.(); return true; } },
  { id: 'tab.close', titleKey: 'editor.command.closeTab', keys: ['Alt-w'], physical: { code: 'KeyW', alt: true }, run: ({ actions }) => { actions.closeTab?.(); return true; } },
  { id: 'view.dismiss', titleKey: 'editor.command.dismiss', keys: ['Escape'], scope: 'editor search-panel', passive: true, run: ({ view, actions }) => actions.dismiss(view) },

  // AI autocomplete (editor-ai.js). Each key is the suggestion's only while there is one: Tab indents, Mod-→
  // moves the caret and Esc closes the find bar as always when there is none.
  { id: 'ai.accept', titleKey: 'editor.command.aiAccept', keys: ['Tab'], feature: 'ai', first: true, passive: true, palette: false, run: ({ view, actions }) => actions.aiAccept?.(view) === true },
  { id: 'ai.acceptWord', titleKey: 'editor.command.aiAcceptWord', keys: ['Mod-ArrowRight'], feature: 'ai', first: true, passive: true, palette: false, run: ({ view, actions }) => actions.aiAcceptWord?.(view) === true },
  { id: 'ai.dismiss', titleKey: 'editor.command.aiDismiss', keys: ['Escape'], feature: 'ai', first: true, passive: true, palette: false, run: ({ view, actions }) => actions.aiDismiss?.(view) === true },
  { id: 'ai.trigger', titleKey: 'editor.command.aiTrigger', keys: ['Alt-\\'], physical: { code: ['Backslash', 'IntlBackslash'], alt: true }, feature: 'ai', passive: true, run: ({ view, actions }) => actions.aiTrigger?.(view) === true },
];

/**
 * CodeMirror key bindings for the commands that have keys. Each calls preventDefault whether or not the command
 * did something, so a key the editor owns never reaches the browser (Mod-S never opens "Save page"). A command
 * marked `passive` only prevents the default when it acted: Escape is left alone when there is nothing to close.
 * Commands with a `physical` key are left out: physicalKeyHandler() runs those.
 * @param {EditorCommand[]} commands
 * @param {{ cm: object, actions: object }} ctx
 */
export function commandKeymap(commands, { cm, actions }) {
  const bindings = [];
  // A key that several commands share is tried in this order: the ones marked `first`, then the rest as listed.
  const ordered = [...commands.filter((command) => command.first), ...commands.filter((command) => !command.first)];
  for (const command of ordered) {
    if (!command.run || !command.keys || command.physical) continue;
    const bind = (key, platform) => {
      const binding = { [platform]: key, run: (view) => command.run({ cm, view, actions, key }) === true };
      if (!command.passive) binding.preventDefault = true;
      if (command.scope) binding.scope = command.scope;
      bindings.push(binding);
    };
    for (const key of command.keys) bind(key, 'key');
    for (const key of command.macKeys || []) bind(key, 'mac');
  }
  return bindings;
}

/**
 * A keydown handler for the commands bound to a physical key. Returns true (the event was handled) when one ran;
 * a `passive` command that did nothing leaves the key to type what it types.
 * @param {EditorCommand[]} commands
 * @param {{ cm: object, actions: object }} ctx
 * @returns {(event: KeyboardEvent, view: object) => boolean}
 */
export function physicalKeyHandler(commands, { cm, actions }) {
  const physical = commands.filter((command) => command.run && command.physical);
  return (event, view) => {
    if (event.ctrlKey || event.metaKey) return false;
    for (const command of physical) {
      const { code, alt = false, shift = false } = command.physical;
      if (![].concat(code).includes(event.code) || event.altKey !== alt || event.shiftKey !== shift) continue;
      const acted = command.run({ cm, view, actions, key: command.keys?.[0] }) === true;
      if (acted || !command.passive) return true;
    }
    return false;
  };
}

const MAC_SYMBOLS = { Mod: '⌘', Meta: '⌘', Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta', 'Cmd'];
const PC_NAMES = { Mod: 'Ctrl', Meta: 'Win', Cmd: 'Ctrl' };
const KEY_NAMES = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Del', Space: 'Space',
};

/**
 * A key the way it is written for the user: `Mod-Shift-k` → `⇧⌘K` on macOS, `Ctrl+Shift+K` elsewhere.
 * @param {string} key a CodeMirror key name, or a gesture such as `Alt-Click`
 * @param {boolean} mac
 * @param {(word: string) => string} [word] translates the last part of a gesture (`Click`, `Drag`)
 */
export function formatKey(key, mac, word = (w) => w) {
  const parts = String(key).split('-');
  // A trailing "-" is the minus key itself.
  let last = parts.pop();
  if (last === '' && parts.length) { parts.pop(); last = '-'; }
  const name = KEY_NAMES[last] || (last.length === 1 ? last.toUpperCase() : word(last));
  if (mac) {
    const mods = parts.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)).map((m) => MAC_SYMBOLS[m] || m);
    return mods.join('') + name;
  }
  return [...parts.map((m) => PC_NAMES[m] || m), name].join('+');
}

/**
 * The rows of the shortcuts list: every command that has a key or a gesture, with the first of its keys.
 * @param {EditorCommand[]} [commands]
 * @param {{ features?: string[] }} [o] the features this server has: a command of another feature is not listed
 * @returns {{ id: string, titleKey: string, key: string, gesture: boolean }[]}
 */
export function shortcutRows(commands = EDITOR_COMMANDS, { features = [] } = {}) {
  return commands
    .filter((command) => !command.feature || features.includes(command.feature))
    .filter((command) => command.gesture || command.keys?.length)
    .map((command) => ({ id: command.id, titleKey: command.titleKey, key: command.gesture || command.keys[0], gesture: !!command.gesture }));
}

/**
 * Run a command by its id (the palette does). False when there is no such command, or it has nothing to run.
 * @param {string} id
 * @param {{ cm: object, view: object, actions: object }} ctx
 * @param {EditorCommand[]} [commands]
 */
export function runCommand(id, ctx, commands = EDITOR_COMMANDS) {
  const command = commands.find((entry) => entry.id === id && typeof entry.run === 'function');
  if (!command) return false;
  return command.run({ ...ctx, key: undefined }) === true;
}
