// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the editor
// ═══════════════════════════════════════════
//
// The app's own code editor (CodeMirror 6, vendored; public/shared/editor/): the same view, find bar, commands,
// theme and compare as the File Explorer's editor, built once per Studio window and given one state per open
// document (its own history, selection and scroll). What the Studio adds is its problems: the checks of a skill,
// agent or command (ss-lint.js, the same as the server's) drawn as a lint gutter and underlines, a moment after
// typing stops. ⌘/Ctrl+S inside the editor is the editor's own save command, handed to the Studio. Nothing here
// decides what a document is or how it is saved: sx-docs.js does.

import { loadCodeMirror } from '../../editor/editor-loader.js';
import { createEditorView } from '../../editor/editor-view.js';
import { editorSearch } from '../../editor/editor-search.js';
import { editorCompare } from '../../editor/editor-compare.js';
import { positionAt } from '../../editor/editor-doc.js';

export const LINT_DELAY_MS = 300;

/**
 * @param {object} o
 * @param {HTMLElement} o.parent
 * @param {(key: string, params?: object) => string} o.t the page's translator (the editor's own `editor.*` words)
 * @param {(update: object) => void} o.onUpdate every view update (the Studio keeps the document's text in step)
 * @param {{ save: () => void }} o.actions
 * @returns {Promise<object>}
 */
export async function createStudioEditor({ parent, t, onUpdate, actions }) {
  const { cm } = await loadCodeMirror();
  const search = editorSearch(cm, { t });
  const compare = editorCompare(cm, { t });
  const editor = createEditorView(cm, { parent, search, actions, t, onUpdate });
  let lintModule = null;
  const lintLoading = cm.loadLint().then((m) => { lintModule = m; return m; }).catch(() => null);

  /** A lint extension over a source of diagnostics ({ line, severity, message }), placed on their lines. */
  async function lintExtension(source) {
    const lint = lintModule || await lintLoading;
    if (!lint || typeof source !== 'function') return null;
    const toCm = (view) => {
      const out = [];
      for (const d of source(view.state.doc.toString()) || []) {
        if (!d || d.severity === 'info') continue;
        const line = Number.isInteger(d.line) && d.line > 0 ? Math.min(d.line, view.state.doc.lines) : 1;
        const at = view.state.doc.line(line);
        out.push({ from: at.from, to: Math.max(at.from, at.to), severity: d.severity === 'error' ? 'error' : 'warning', message: String(d.message ?? '') });
      }
      return out;
    };
    return [lint.linter(toCm, { delay: LINT_DELAY_MS }), lint.lintGutter()];
  }

  return {
    cm,
    view: editor.view,
    /** A state for a document: its text, read-only or not, wrapped. */
    createState: ({ text, readOnly = false }) => editor.createState({ text, wrap: true, indent: { unit: '  ', tabSize: 2 }, editing: { indentGuides: true }, locked: readOnly }),
    show: (state, o) => editor.show(state, o),
    snapshotScroll: () => editor.snapshotScroll(),
    apply: (state, spec) => editor.apply(state, spec),
    effects: editor.effects,
    /** The language of a file name, loaded (null for plain text). */
    async language(fileName) {
      const description = editor.describeLanguage(fileName);
      return description ? editor.loadLanguage(description) : null;
    },
    lintExtension,
    /** The comparison of the document with another text (the file as saved), or null when it cannot load. */
    async compareExtension(original, revertLabel) {
      try { return await compare.extension({ original, revertLabel }); } catch { return null; }
    },
    differences: (state) => compare.differences(state),
    nextProblem: () => (lintModule ? lintModule.nextDiagnostic(editor.view) : false),
    reveal(line, column = 1) {
      const { pos } = positionAt(editor.view.state.doc, line, column);
      editor.view.dispatch({ selection: { anchor: pos }, effects: cm.EditorView.scrollIntoView(pos, { y: 'center' }) });
      editor.view.focus();
    },
    /** Replace the showing document's whole text (a form field or a snippet changed it), keeping it one undo step. */
    replaceText(next, { caret = null } = {}) {
      const view = editor.view;
      const current = view.state.doc.toString();
      if (current === next) return;
      // The smallest change that makes the text `next`: the caret and the scroll stay where they were.
      let start = 0;
      while (start < current.length && start < next.length && current[start] === next[start]) start++;
      let endA = current.length; let endB = next.length;
      while (endA > start && endB > start && current[endA - 1] === next[endB - 1]) { endA--; endB--; }
      const spec = { changes: { from: start, to: endA, insert: next.slice(start, endB) } };
      if (Number.isInteger(caret)) spec.selection = { anchor: Math.min(caret, next.length) };
      view.dispatch(spec);
    },
    caret: () => editor.view.state.selection.main.head,
    text: () => editor.text(),
    focus: () => editor.focus(),
    hasFocus: () => editor.hasFocus(),
    remeasure: () => editor.remeasure(),
    clear: () => editor.clear(),
    destroy: () => editor.destroy(),
  };
}
