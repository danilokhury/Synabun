// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: comparing with another text
// ═══════════════════════════════════════════
//
// Shows the document against another version of itself, inline: what the other
// version has and the document does not is drawn above the lines that replaced
// it, changed lines are marked, long unchanged stretches are folded away, and
// each difference can be put back to the other version (a button: the mouse
// and the keyboard both press it). The document stays editable; while it is
// read-only (a save or a reload is under way) the buttons do nothing, as the
// keys do. It is CodeMirror's unified merge view (@codemirror/merge, a chunk
// of the vendored bundle that is fetched the first time a comparison is
// asked for); its colours are the theme's (--ed-add / --ed-del).
//
// The panel compares a buffer with the file on disk; the same extension
// compares a file with its committed version. Takes the vendored bundle and
// the strings as arguments: no imports.

/** Lines of unchanged text kept around a difference, and the shortest stretch that is folded away. */
export const COMPARE_CONTEXT = Object.freeze({ margin: 3, minSize: 6 });

/**
 * @param {object} cm the vendored CodeMirror bundle (editor-loader.js)
 * @param {{ t: (key: string, params?: object) => string }} o
 */
export function editorCompare(cm, { t }) {
  let merge = null;   // @codemirror/merge, once loaded

  // The button that puts one difference back to the other version. The merge view also offers to accept a
  // difference (to stop showing it); that is not a thing a comparison needs, so it gets no button.
  const control = (label) => (type, action) => {
    const node = document.createElement(type === 'reject' ? 'button' : 'span');
    if (type !== 'reject') { node.hidden = true; return node; }
    node.type = 'button';
    node.className = 'fe-editor-compare-revert';
    node.textContent = label;
    // Pressed with the mouse, the keyboard stays in the text (the button is gone once it has acted).
    node.addEventListener('mousedown', (event) => event.preventDefault());
    // A click is what a mouse and a keyboard (Enter, Space) both end in. A document that cannot be edited right
    // now (it is being saved or reloaded) is not edited through this button either.
    node.addEventListener('click', (event) => {
      const root = node.closest('.cm-editor');
      const view = root ? cm.EditorView.findFromDOM(root) : null;
      if (!view || view.state.readOnly) { event.preventDefault(); return; }
      action(event);
      view.focus();
    });
    return node;
  };

  return {
    /**
     * The extension that shows `original` against the document it is added to (the panel puts it in the view's
     * comparison compartment). Rejects when the merge chunk cannot be loaded.
     * @param {{ original: string, revertLabel: string, gutter?: boolean }} o `original`: the other version, line
     *   breaks as "\n"; `revertLabel`: what the button that puts a difference back says; `gutter`: false when
     *   another column already marks the changed lines (the git markers, for a comparison with the last commit)
     */
    async extension({ original, revertLabel, gutter = true }) {
      if (!merge) merge = await cm.loadMerge();
      // The lines that are new as a whole: every character of them is changed text. The theme gives those the
      // line's tint only; a line that was modified keeps the stronger tint on the words that changed.
      const { Decoration, EditorView, RangeSetBuilder, StateField } = cm;
      const whole = Decoration.line({ class: 'cm-addedWhole' });
      const wholeLines = (state) => {
        const builder = new RangeSetBuilder();
        for (const chunk of merge.getChunks(state)?.chunks || []) {
          if (chunk.fromB >= chunk.toB) continue;
          const end = Math.min(state.doc.length, chunk.endB);
          for (let pos = chunk.fromB; pos <= end;) {
            const line = state.doc.lineAt(pos);
            if (line.length && chunk.changes.some((change) => chunk.fromB + change.fromB <= line.from && chunk.fromB + change.toB >= line.to)) builder.add(line.from, line.from, whole);
            pos = line.to + 1;
          }
        }
        return builder.finish();
      };
      const addedWhole = StateField.define({
        create: wholeLines,
        update: (value, tr) => (tr.docChanged || merge.getChunks(tr.state)?.chunks !== merge.getChunks(tr.startState)?.chunks ? wholeLines(tr.state) : value),
        provide: (field) => EditorView.decorations.from(field),
      });
      return [
        addedWhole,
        merge.unifiedMergeView({
          original,
          highlightChanges: true,
          gutter,
          // What the other version had is drawn in the diff's own colour, not as code.
          syntaxHighlightDeletions: false,
          mergeControls: control(revertLabel),
          collapseUnchanged: { ...COMPARE_CONTEXT },
        }),
        cm.EditorState.phrases.of({ '$ unchanged lines': t('editor.compare.unchanged', { count: '$' }) }),
      ];
    },

    /** How many differences a state that is being compared shows; 0 for one that is not. */
    differences(state) {
      return merge?.getChunks(state)?.chunks.length ?? 0;
    },
  };
}
