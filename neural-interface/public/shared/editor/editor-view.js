// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the CodeMirror view
// ═══════════════════════════════════════════
//
// Builds the editor: one CodeMirror view for the panel, and a state for each
// document it is given (its own history, selection, folds and find bar). The
// panel keeps the state of every open tab and hands the view the one to show;
// a state that is not showing can still be changed (a language that arrives
// late, a file reloaded from disk). What can change while a document is open
// sits in a compartment: language, line wrapping, indentation, read-only, the
// editing preferences, the comparison with another text, the git markers, the
// problem check and the minimap.
// Takes the vendored bundle as an argument.

import { editorTheme } from './editor-theme.js';
import { EDITOR_COMMANDS, commandKeymap, physicalKeyHandler } from './editor-commands.js';
import { baseName, resolveLanguage } from './editor-languages.js';
import { positionAt } from './editor-doc.js';
import { editorCompletionList } from './editor-completion-list.js';

// After an edit the parser reuses, from the tree it had, only the nodes stored as trees of their own; smaller
// ones are packed into buffers and read again. With the parser's default buffer (1024) a file made of many
// small pieces, such as a stylesheet's rules, is read again from its start on every keystroke, for up to the
// 20 ms CodeMirror allows per edit. A quarter of that keeps those pieces reusable: measured on a 1 MB
// stylesheet, the parse after a keystroke went from 59 ms to 1 ms, for 4 MB more memory per MB of text.
export const PARSER_BUFFER_LENGTH = 256;

/** A language's support with its parser set up for small edits in large files. Other kinds of parser pass through. */
export function withReusableNodes(cm, support) {
  const language = support?.language;
  if (typeof language?.configure !== 'function' || typeof language.parser?.configure !== 'function') return support;
  if (!(language.parser.bufferLength > PARSER_BUFFER_LENGTH)) return support;
  return new cm.LanguageSupport(language.configure({ bufferLength: PARSER_BUFFER_LENGTH }), support.support);
}

/** What the panel offers to commands: each is called on the panel's `actions` when a command asks for it. */
export const PANEL_ACTIONS = Object.freeze([
  'save', 'toggleWordWrap', 'nextTab', 'previousTab', 'closeTab',
  'toggleMinimap', 'toggleIndentGuides', 'cycleWhitespace', 'fontLarger', 'fontSmaller', 'fontReset',
  'openPalette', 'openGoToFile', 'nextProblem', 'previousProblem', 'toggleDiff',
]);

/**
 * Spaces and tabs drawn inside the selection only. They take the classes CodeMirror's own "all whitespace"
 * extension uses, so the theme styles both the same way.
 */
export function selectionWhitespace(cm) {
  const { Decoration, RangeSetBuilder, ViewPlugin } = cm;
  const space = Decoration.mark({ class: 'cm-highlightSpace' });
  const tab = Decoration.mark({ class: 'cm-highlightTab' });
  const build = (view) => {
    const builder = new RangeSetBuilder();
    const selected = view.state.selection.ranges.filter((range) => !range.empty);
    if (!selected.length) return builder.finish();
    for (const visible of view.visibleRanges) {
      for (const range of selected) {
        const from = Math.max(range.from, visible.from);
        const to = Math.min(range.to, visible.to);
        if (from >= to) continue;
        const text = view.state.sliceDoc(from, to);
        for (let i = 0; i < text.length; i++) {
          const c = text.charCodeAt(i);
          if (c === 32) builder.add(from + i, from + i + 1, space);
          else if (c === 9) builder.add(from + i, from + i + 1, tab);
        }
      }
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(update) { if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = build(update.view); }
  }, { decorations: (plugin) => plugin.decorations });
}

const FOLD_ICON = {
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
  closed: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>',
};

/**
 * @param {object} cm the vendored CodeMirror bundle (editor-loader.js)
 * @param {object} o
 * @param {HTMLElement} o.parent where the editor is mounted
 * @param {object} o.search what editorSearch() returned
 * @param {object} [o.ai] what editorAi() returned: the suggestion extension and its commands
 * @param {{ save: () => void, toggleWordWrap: () => void, nextTab?: () => void, previousTab?: () => void, closeTab?: () => void }} o.actions
 *   what the panel offers to commands (PANEL_ACTIONS names them all)
 * @param {(key: string, params?: object) => string} o.t
 * @param {(update: object) => void} [o.onUpdate] called for every view update
 */
export function createEditorView(cm, { parent, search, ai = null, actions, t, onUpdate = () => {} }) {
  const { Compartment, EditorState, EditorView, StateEffect, StateField, keymap } = cm;

  const language = new Compartment();
  const wrapping = new Compartment();
  const indentation = new Compartment();
  const readOnly = new Compartment();
  const preferences = new Compartment();
  const comparing = new Compartment();
  const gitMarkers = new Compartment();
  const problems = new Compartment();
  const minimap = new Compartment();

  const commandContext = {
    cm,
    actions: {
      // The panel's own: looked up when a command runs, so the panel may add to them after the view exists.
      ...Object.fromEntries(PANEL_ACTIONS.map((name) => [name, (...args) => actions[name]?.(...args)])),
      openFind: search.openFind,
      openReplace: search.openReplace,
      findNext: search.findNext,
      findPrevious: search.findPrevious,
      openGoToLine: search.openGoToLine,
      dismiss: search.dismiss,
      aiAccept: ai?.accept,
      aiAcceptWord: ai?.acceptWord,
      aiDismiss: ai?.dismiss,
      aiTrigger: ai?.trigger,
    },
  };
  const physicalKey = physicalKeyHandler(EDITOR_COMMANDS, commandContext);

  // The completion list: what the language offers, and the words of the document (in every language). While AI
  // autocomplete is expected to suggest for the document, its words wait to be asked for (Ctrl-Space).
  const completionList = editorCompletionList(cm, { wordsYield: () => ai?.expectsSuggestions?.() === true });

  const foldMarker = (open) => {
    const marker = document.createElement('span');
    marker.className = open ? 'fe-editor-fold fe-editor-fold--open' : 'fe-editor-fold fe-editor-fold--closed';
    marker.innerHTML = open ? FOLD_ICON.open : FOLD_ICON.closed;
    marker.setAttribute('aria-label', t(open ? 'editor.fold.fold' : 'editor.fold.unfold'));
    return marker;
  };

  // A save is an undo boundary: the first edit after it starts a step of its own, so undoing it lands on
  // what was saved instead of on some point before. The mark is part of the document's state: each tab has its own.
  const markSaved = StateEffect.define();
  const savedBoundary = StateField.define({
    create: () => false,
    update(value, tr) {
      if (tr.docChanged) return false;
      return tr.effects.some((effect) => effect.is(markSaved)) ? true : value;
    },
  });
  const startUndoStep = EditorState.transactionExtender.of((tr) => (
    tr.docChanged && tr.startState.field(savedBoundary, false) ? { annotations: cm.isolateHistory.of('before') } : null
  ));

  // The same for every document.
  const fixed = [
    savedBoundary,
    startUndoStep,
    cm.lineNumbers(),
    cm.highlightActiveLineGutter(),
    cm.highlightSpecialChars(),
    cm.history(),
    cm.foldGutter({ markerDOM: foldMarker }),
    cm.drawSelection(),
    cm.dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    // Alt-click adds a caret; Shift-Alt-drag selects a column (VS Code's gestures).
    EditorView.clickAddsSelectionRange.of((event) => event.altKey && !event.shiftKey),
    cm.rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey && event.button === 0 }),
    cm.indentOnInput(),
    cm.bracketMatching(),
    cm.closeBrackets(),
    completionList.extension,
    cm.highlightActiveLine(),
    cm.highlightSelectionMatches(),
    search.extension,
    ai ? ai.extension : [],
    editorTheme(cm),
    EditorView.contentAttributes.of({ 'aria-label': t('editor.aria.content') }),
    EditorView.domEventHandlers({ keydown: (event, view) => physicalKey(event, view) }),
    keymap.of([
      ...commandKeymap(EDITOR_COMMANDS, commandContext),
      ...cm.closeBracketsKeymap,
      ...cm.defaultKeymap,
      ...cm.historyKeymap,
      ...cm.foldKeymap,
      ...cm.completionKeymap,
    ]),
    EditorView.updateListener.of((update) => onUpdate(update)),
  ];

  const wrapExtension = (on) => (on ? EditorView.lineWrapping : []);
  const indentExtension = ({ unit = '  ', tabSize = 2 } = {}) => [cm.indentUnit.of(unit), EditorState.tabSize.of(tabSize)];
  const readOnlyExtension = (on) => EditorState.readOnly.of(!!on);
  const indentGuides = cm.indentationMarkers({
    highlightActiveBlock: true,
    thickness: 1,
    colors: {
      light: 'var(--ed-guide)', dark: 'var(--ed-guide)',
      activeLight: 'var(--ed-guide-active)', activeDark: 'var(--ed-guide-active)',
    },
  });
  const whitespace = { all: cm.highlightWhitespace(), selection: selectionWhitespace(cm) };
  const preferenceExtension = (editing = {}) => [
    editing.indentGuides === false ? [] : indentGuides,
    whitespace[editing.renderWhitespace] || [],
  ];

  const stateFor = ({ text = '', indent, wrap = true, editing, locked = false, git = null, lint = null, minimap: map = null } = {}) => EditorState.create({
    doc: text,
    extensions: [
      fixed,
      language.of([]),
      wrapping.of(wrapExtension(wrap)),
      indentation.of(indentExtension(indent)),
      readOnly.of(readOnlyExtension(locked)),
      preferences.of(preferenceExtension(editing)),
      comparing.of([]),
      gitMarkers.of(git || []),
      problems.of(lint || []),
      minimap.of(map || []),
    ],
  });

  const view = new EditorView({ state: stateFor(), parent });

  // A key pressed in the editor (the text, or one of its bars) is the editor's: it does not travel on to the
  // document, where the app's shortcuts and "Escape closes this" listeners wait.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    view.dom.addEventListener(type, (event) => event.stopPropagation());
  }

  // A language's support, once loaded, is the same object for every tab that uses it.
  const supports = new Map();

  return {
    view,
    /** What commands are given to act with (the palette runs a command through the same ones). */
    actions: commandContext.actions,

    /**
     * A state for a document. Its history starts empty.
     * @param {{ text: string, indent: { unit: string, tabSize: number }, wrap: boolean, editing: object,
     *   git?: any, lint?: any, minimap?: any }} doc `git`, `lint`, `minimap`: what the document has of each from
     *   the start (an extension of editor-git.js, editor-lint.js, editor-minimap.js), nothing when left out
     */
    createState: (doc) => stateFor(doc),

    /**
     * Put a document's state in the view.
     * @param {object} state from createState(), or one the view held before
     * @param {{ scroll?: object | null, top?: number | null }} [o] `scroll`: what snapshotScroll() returned when
     *   this document was last showing; `top`: else a document position to put at the top of the view
     */
    show(state, { scroll = null, top = null } = {}) {
      view.setState(state);
      if (scroll) view.dispatch({ effects: scroll });
      else if (top) view.dispatch({ effects: EditorView.scrollIntoView(Math.min(top, state.doc.length), { y: 'start', yMargin: 0 }) });
    },

    /** Where the view is scrolled to, as something show() puts back. */
    snapshotScroll: () => view.scrollSnapshot(),
    /** The document position of the first line that is visible. */
    topPosition: () => view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - view.documentTop).from,

    /**
     * Change a document: through the view when its state is the one showing (pass null), on the state itself
     * otherwise. Returns the state after the change.
     */
    apply(state, spec) {
      if (!state || state === view.state) { view.dispatch(spec); return view.state; }
      return state.update(spec).state;
    },

    /** Effects for apply(), one for each thing that can change while a document is open. */
    effects: {
      wrap: (on) => wrapping.reconfigure(wrapExtension(on)),
      indent: (indent) => indentation.reconfigure(indentExtension(indent)),
      readOnly: (on) => readOnly.reconfigure(readOnlyExtension(on)),
      editing: (editing) => preferences.reconfigure(preferenceExtension(editing)),
      /** `support`: what loadLanguage() resolved to; nothing for plain text. */
      language: (support) => language.reconfigure(support || []),
      /** `extension`: what editor-compare.js built; nothing to leave the comparison. */
      compare: (extension) => comparing.reconfigure(extension || []),
      /** `extension`: editor-git.js's column; nothing for a document git markers are not shown for. */
      git: (extension) => gitMarkers.reconfigure(extension || []),
      /** `extension`: editor-lint.js's check for the document's kind; nothing for a document that is not checked. */
      lint: (extension) => problems.reconfigure(extension || []),
      /** `extension`: editor-minimap.js's; nothing while the document shows no minimap. */
      minimap: (extension) => minimap.reconfigure(extension || []),
      /** The next edit starts a new undo step (after a save, or a reload from disk). */
      saved: () => markSaved.of(null),
    },

    /** The language a file name is highlighted as (a description of the bundle's language-data), or null. */
    describeLanguage(fileName) {
      const wanted = resolveLanguage(fileName);
      if (wanted.known) return wanted.language ? cm.languages.find((entry) => entry.name === wanted.language) || null : null;
      return cm.LanguageDescription.matchFilename(cm.languages, baseName(fileName));
    },
    /** Every language of the bundle. */
    languages: () => cm.languages,
    /**
     * Load a language (its chunk is fetched the first time). Resolves to null when it cannot be loaded: the
     * file stays readable and editable as plain text.
     */
    loadLanguage(description) {
      if (!description) return Promise.resolve(null);
      if (!supports.has(description.name)) {
        supports.set(description.name, description.load().then((support) => withReusableNodes(cm, support)));
      }
      return supports.get(description.name).catch((error) => {
        supports.delete(description.name);
        console.warn(`[editor] could not load the ${description.name} language`, error);
        return null;
      });
    },

    /** Drop the document (the panel closed). */
    clear() { view.setState(stateFor()); },

    /** Put the caret at a 1-based line and column, with a few lines of context above it. */
    reveal(line, column = 1) {
      const { pos } = positionAt(view.state.doc, line, column);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 100 }) });
    },

    focus() { view.focus(); },
    hasFocus() { return view.hasFocus; },
    /** The showing document, line breaks as "\n". */
    text() { return view.state.doc.toString(); },
    doc() { return view.state.doc; },
    /** Sizes changed from outside (font size, the panel's width): measure again. */
    remeasure() { view.requestMeasure(); },
    destroy() { view.destroy(); },
  };
}
