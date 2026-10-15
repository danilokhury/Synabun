// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: git markers
// ═══════════════════════════════════════════
//
// A thin column next to the fold arrows that says which lines differ from the
// last commit: added, modified, and where committed lines were removed. Which
// lines those are is decided in editor-git-logic.js; the panel fetches the
// committed text (GET /api/file-head), compares after edits and saves, and
// hands the result here as an effect. The marks are part of the document's
// state, so each tab keeps its own, and they move with the text until the next
// comparison. The Diff view of the file against the last commit is the inline
// comparison of editor-compare.js, fed the committed text.
// Takes the vendored bundle as an argument: no imports.

/** A comparison runs this long after the last edit. */
export const GIT_REFRESH_MS = 300;

/**
 * @param {object} cm the vendored CodeMirror bundle (editor-loader.js)
 */
export function editorGit(cm) {
  const { GutterMarker, RangeSet, RangeSetBuilder, StateEffect, StateField, gutter } = cm;

  class ChangeMarker extends GutterMarker {
    constructor(kind, after = false) {
      super();
      this.kind = kind;
      this.after = after;
      this.elementClass = `cm-gitLine cm-gitLine-${kind}${after ? ' cm-gitLine-after' : ''}`;
    }
    eq(other) { return other.kind === this.kind && other.after === this.after; }
  }
  const markers = {
    added: new ChangeMarker('added'),
    modified: new ChangeMarker('modified'),
    deleted: new ChangeMarker('deleted'),
    deletedAfter: new ChangeMarker('deleted', true),
  };

  const setMarks = StateEffect.define();

  function build(doc, marks) {
    const builder = new RangeSetBuilder();
    for (const mark of marks) {
      const marker = mark.kind === 'deleted' ? (mark.after ? markers.deletedAfter : markers.deleted) : markers[mark.kind];
      if (!marker) continue;
      const last = Math.min(mark.to, doc.lines);
      for (let n = Math.max(1, mark.from); n <= last; n++) {
        const at = doc.line(n).from;
        builder.add(at, at, marker);
      }
    }
    return builder.finish();
  }

  const field = StateField.define({
    create: () => RangeSet.empty,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setMarks)) return build(tr.state.doc, effect.value);
      return tr.docChanged ? value.map(tr.changes) : value;
    },
  });

  const column = gutter({ class: 'cm-gitGutter', markers: (view) => view.state.field(field) });

  return {
    /** The column and the marks it shows (none until an effect brings them). For the view's git compartment. */
    extension: [field, column],

    /**
     * Show these marks.
     * @param {{ from: number, to: number, kind: 'added' | 'modified' | 'deleted', after?: boolean }[]} marks
     *   lines of the document (editor-git-logic.js: gitMarks)
     */
    marks: (marks) => setMarks.of(marks || []),

    /** Whether a state has the column. */
    has: (state) => state.field(field, false) !== undefined,

    /** The kinds of the marks a state shows, by line number: for a test, or a count. */
    lines(state) {
      const found = new Map();
      const set = state.field(field, false);
      if (!set) return found;
      for (let cursor = set.iter(); cursor.value; cursor.next()) found.set(state.doc.lineAt(cursor.from).number, cursor.value.kind);
      return found;
    },

    /** Call `use(position, kind)` for each mark between two document positions (the minimap draws them). */
    between(state, from, to, use) {
      const set = state.field(field, false);
      if (set) set.between(from, to, (at, _end, marker) => { use(at, marker.kind); });
    },
  };
}
