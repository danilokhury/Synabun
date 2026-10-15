// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: theme
// ═══════════════════════════════════════════
//
// The CodeMirror theme and highlight style of the File Explorer's editor.
// Every colour is a `var(--ed-*)` declared on `.fe-editor-panel` in styles.css,
// with the values the editor had before CodeMirror, so a skin restyles the
// editor by overriding those variables. Sizes that follow a preference are
// variables too (`--ed-font-size`, `--ed-ligatures`), set on the panel by
// editor-panel.js. Takes the vendored bundle as an argument: no imports.

export const EDITOR_FONT_FAMILY = "'JetBrains Mono', 'SF Mono', 'Consolas', monospace";
/** 12px on a 20px line; the height follows the size. */
export const EDITOR_LINE_HEIGHT = '1.667';

/**
 * The ten colours of the old regular-expression highlighter, mapped onto syntax tags. Kinds it never coloured
 * take the nearest of them (SPEC, section 6). The highlight style is built from this table, and the minimap
 * colours its blocks by it.
 * @param {object} t the bundle's `tags`
 * @returns {{ tag: any, color?: string, fontStyle?: string, fontWeight?: string, textDecoration?: string }[]}
 */
export function highlightSpecs(t) {
  return [
    { tag: t.keyword, color: 'var(--ed-kw)' },
    { tag: [t.modifier, t.self], color: 'var(--ed-kw)' },
    { tag: [t.string, t.special(t.string), t.character, t.docString, t.attributeValue, t.regexp, t.escape, t.monospace], color: 'var(--ed-str)' },
    { tag: t.comment, color: 'var(--ed-cm)', fontStyle: 'italic' },
    { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name), t.unit, t.color], color: 'var(--ed-num)' },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)),
        t.className, t.typeName, t.namespace, t.labelName, t.macroName],
      color: 'var(--ed-fn)',
    },
    { tag: [t.angleBracket, t.processingInstruction, t.contentSeparator, t.documentMeta], color: 'var(--ed-op)' },
    { tag: t.tagName, color: 'var(--ed-tag)' },
    { tag: [t.attributeName, t.constant(t.className), t.annotation, t.meta], color: 'var(--ed-attr)' },
    { tag: [t.propertyName, t.special(t.variableName)], color: 'var(--ed-prop)' },
    { tag: [t.paren, t.squareBracket, t.brace], color: 'var(--ed-br)' },
    { tag: t.heading, color: 'var(--ed-kw)', fontWeight: '600' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: 'var(--ed-prop)', textDecoration: 'underline' },
    { tag: t.quote, color: 'var(--ed-str)' },
    { tag: t.inserted, color: 'var(--ed-add)' },
    { tag: t.deleted, color: 'var(--ed-del)' },
    { tag: t.changed, color: 'var(--ed-warn)' },
    { tag: t.invalid, color: 'var(--ed-error)' },
  ];
}

/**
 * @param {object} cm the vendored CodeMirror bundle (editor-loader.js)
 * @returns {import('@codemirror/state').Extension[]}
 */
export function editorTheme(cm) {
  const { EditorView, HighlightStyle, syntaxHighlighting, tags: t } = cm;

  const theme = EditorView.theme({
    '&': {
      height: '100%',
      color: 'var(--ed-fg)',
      backgroundColor: 'transparent',
      fontSize: 'var(--ed-font-size, 12px)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: EDITOR_FONT_FAMILY,
      lineHeight: EDITOR_LINE_HEIGHT,
      overflow: 'auto',
    },
    '.cm-content': {
      padding: '10px 0',
      caretColor: 'var(--ed-caret)',
      fontVariantLigatures: 'var(--ed-ligatures, normal)',
    },
    '.cm-line': { padding: '0 16px' },

    // Gutter: line numbers, then the fold arrows. 48px in a file of up to 9,999 lines, as before.
    '.cm-gutters': {
      backgroundColor: 'var(--ed-gutter-bg)',
      color: 'var(--ed-gutter-fg)',
      border: 'none',
      borderRight: '1px solid var(--ed-gutter-border)',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 2px 0 6px', minWidth: '37px', textAlign: 'right' },
    '.cm-foldGutter .cm-gutterElement': { width: '10px', padding: '0', textAlign: 'center', cursor: 'pointer' },
    '.cm-foldGutter .cm-gutterElement span': { color: 'var(--ed-gutter-fg)' },
    '.cm-foldGutter .cm-gutterElement:hover span': { color: 'var(--ed-gutter-fg-active)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ed-gutter-fg-active)' },
    '.cm-activeLine': { backgroundColor: 'var(--ed-line-active)' },

    // Carets and selections (drawn by CodeMirror, so several can show at once).
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ed-caret)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--ed-selection)',
    },
    '.cm-content ::selection': { backgroundColor: 'var(--ed-selection)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--ed-match)' },
    '.cm-searchMatch': { backgroundColor: 'var(--ed-match)', outline: 'none' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--ed-match-current)' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ed-match)', outline: '1px solid var(--ed-gutter-fg)' },
    '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'var(--ed-error)' },
    '.cm-specialChar': { color: 'var(--ed-error)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--ed-match)',
      border: 'none',
      color: 'var(--ed-gutter-fg-active)',
      margin: '0 2px',
      padding: '0 4px',
      borderRadius: '3px',
    },

    // An AI suggestion: upright, so it is never taken for a comment (those are italic), whatever it sits in.
    '.cm-ghost': { color: 'var(--ed-ghost)', fontStyle: 'normal', fontWeight: 'normal', textDecoration: 'none' },

    // A comparison with another version (editor-compare.js): the diff colours of the design, the gutter says
    // which lines changed. What the other version had is not part of the document: it is drawn in the delete colour.
    '&.cm-merge-b .cm-changedLine, & .cm-inlineChangedLine': { backgroundColor: 'var(--ed-add-bg)' },
    '&.cm-merge-b .cm-changedText': { background: 'var(--ed-add-bg)' },
    // A line that is new as a whole has the line's tint and no second layer of it (the two together took the text
    // under 4.5:1). The words changed inside a modified line keep theirs: that is what tells them from the rest.
    '&.cm-merge-b .cm-addedWhole .cm-changedText': { background: 'none' },
    // The block of a difference (what the other version had) is what its button is placed in, and the button never
    // lies over text. With wrapped lines it floats at the block's end: the rows of removed text are shorter beside
    // it. The block contains the float, so a difference that only adds lines, whose block holds no removed line,
    // still has a row for the button (it was a box of no height that the button hung out of, under the first added
    // line: a line is positioned, and comes later). With lines that are not wrapped, text makes no room for a float
    // and the block is as wide as the longest line: there the button has a row of its own, and is held at the end of
    // what is in view (clear of the minimap, which is 64 px of the scroller) however far the text is scrolled.
    '& .cm-deletedChunk': { position: 'relative', display: 'flow-root', backgroundColor: 'var(--ed-del-bg)', color: 'var(--ed-del)', paddingLeft: '16px' },
    '& .cm-deletedChunk .cm-chunkButtons': { position: 'static', float: 'right', marginInlineEnd: '5px' },
    '& .cm-content:not(.cm-lineWrapping) .cm-deletedChunk .cm-chunkButtons': { float: 'none', position: 'sticky', right: '5px', width: 'fit-content', marginInlineStart: 'auto' },
    '& .cm-scroller:has(.cm-minimap) .cm-content:not(.cm-lineWrapping) .cm-deletedChunk .cm-chunkButtons': { right: '69px' },
    // A block that holds the button alone took nothing away: its row is not tinted as removed text is.
    '& .cm-deletedChunk:not(:has(.cm-deletedLine))': { backgroundColor: 'transparent' },
    '& .cm-deletedChunk .cm-deletedText': { background: 'var(--ed-del-bg)' },
    '& .cm-deletedChunk .cm-deletedLine, & .cm-deletedChunk .cm-deletedLine del, & .cm-insertedLine': { textDecoration: 'none' },
    '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--ed-add)' },
    '& .cm-deletedLineGutter': { background: 'var(--ed-del)' },
    '& .cm-collapsedLines': {
      background: 'var(--ed-gutter-bg)',
      color: 'var(--ed-gutter-fg-active)',
      padding: '2px 16px',
      fontSize: '11px',
    },
    '& .cm-collapsedLines:hover': { color: 'var(--ed-menu-fg-active)' },
    '& .cm-collapsedLines:before, & .cm-collapsedLines:after': { content: '""', margin: '0' },

    // Git markers (editor-git.js): a 4px column after the fold arrows. Added and modified lines carry a bar in
    // the diff colours; where committed lines were removed, a mark sits on the edge between two lines.
    '.cm-gitGutter': { width: '4px' },
    '.cm-gitGutter .cm-gutterElement': { position: 'relative', padding: '0' },
    '.cm-gitGutter .cm-gitLine-added': { backgroundColor: 'var(--ed-add)' },
    '.cm-gitGutter .cm-gitLine-modified': { backgroundColor: 'var(--ed-warn)' },
    '.cm-gitGutter .cm-gitLine-deleted::before': {
      content: '""', position: 'absolute', left: '0', top: '-2px', width: '4px', height: '4px', backgroundColor: 'var(--ed-del)',
    },
    '.cm-gitGutter .cm-gitLine-deleted.cm-gitLine-after::before': { top: 'auto', bottom: '-2px' },

    // Problems (editor-lint.js): a wavy underline, a dot in a narrow column of its own, the message in the
    // editor's tooltip.
    '.cm-lintRange': { backgroundImage: 'none', paddingBottom: '0' },
    '.cm-lintRange-error': { textDecoration: 'underline wavy var(--ed-error)', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
    '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--ed-warn)', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
    '.cm-lintRange-active': { backgroundColor: 'var(--ed-match)' },
    '.cm-lintPoint:after': { borderBottomColor: 'var(--ed-error)' },
    '.cm-gutter-lint': { width: '10px' },
    '.cm-gutter-lint .cm-gutterElement': { padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' },
    '.cm-lint-marker': { content: 'normal', width: '6px', height: '6px', borderRadius: '50%', cursor: 'default' },
    '.cm-lint-marker-error': { content: 'normal', backgroundColor: 'var(--ed-error)' },
    '.cm-lint-marker-warning': { content: 'normal', backgroundColor: 'var(--ed-warn)' },
    '.cm-tooltip.cm-tooltip-lint, .cm-tooltip.cm-tooltip-hover': { fontFamily: EDITOR_FONT_FAMILY, fontSize: '11px', maxWidth: '480px' },
    '.cm-diagnostic': { padding: '4px 8px', marginLeft: '0', whiteSpace: 'pre-wrap', lineHeight: '1.5' },
    '.cm-diagnostic-error': { borderLeft: '2px solid var(--ed-error)' },
    '.cm-diagnostic-warning': { borderLeft: '2px solid var(--ed-warn)' },

    // Spaces and tabs made visible (the whitespace preference): a dot, and a rule the width of the tab.
    '.cm-highlightSpace': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--ed-whitespace) 20%, transparent 5%)' },
    '.cm-highlightTab': {
      backgroundImage: 'linear-gradient(var(--ed-whitespace), var(--ed-whitespace))',
      backgroundSize: 'calc(100% - 4px) 1px',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    },

    // The minimap (editor-minimap.js): a part of the scroller that stays in view; the text is laid out beside it.
    '.cm-minimap': {
      position: 'sticky',
      top: '0',
      right: '0',
      zIndex: '3',
      flexShrink: '0',
      boxSizing: 'border-box',
      width: '64px',
      height: '100%',
      overflow: 'hidden',
      backgroundColor: 'var(--ed-bg)',
      boxShadow: 'inset 1px 0 0 var(--ed-gutter-border)',
      cursor: 'default',
      userSelect: 'none',
      touchAction: 'none',
    },
    '.cm-minimap canvas': { display: 'block', width: '100%', height: '100%' },
    '.cm-minimap-box': { position: 'absolute', left: '0', right: '0', backgroundColor: 'var(--ed-minimap-box)', boxShadow: 'inset 0 0 0 1px var(--ed-minimap-edge)', pointerEvents: 'none' },
    '.cm-minimap:hover .cm-minimap-box, .cm-minimap-dragging .cm-minimap-box': { backgroundColor: 'var(--ed-minimap-box-active)' },

    // The find and go-to-line bars are panels: their own look is in styles.css (.fe-editor-find, .fe-editor-goto).
    '.cm-panels': { backgroundColor: 'transparent', color: 'inherit' },
    '.cm-panels.cm-panels-top': { borderBottom: 'none' },
    '.cm-panels.cm-panels-bottom': { borderTop: 'none' },

    // Completion list: the menu treatment of DESIGN.md.
    '.cm-tooltip': {
      backgroundColor: 'var(--ed-menu-bg)',
      color: 'var(--ed-menu-fg)',
      border: '1px solid var(--ed-menu-border)',
      borderRadius: 'var(--ed-menu-radius, 8px)',
      boxShadow: 'var(--ed-menu-shadow)',
      overflow: 'hidden',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: EDITOR_FONT_FAMILY,
      fontSize: '11px',
      maxHeight: '14em',
      padding: '4px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', borderRadius: '4px', lineHeight: '1.6' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--ed-menu-hover)',
      color: 'var(--ed-menu-fg-active)',
    },
    '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--ed-menu-fg-active)', fontWeight: '600' },
    '.cm-completionDetail': { color: 'var(--ed-gutter-fg-active)', fontStyle: 'normal' },
    '.cm-completionIcon': { opacity: '0.5', width: '1em', paddingRight: '0.5em' },
    '.cm-tooltip.cm-completionInfo': { padding: '6px 8px', fontSize: '11px', maxWidth: '360px' },
  }, { dark: true });

  const highlight = HighlightStyle.define(highlightSpecs(t));

  return [theme, syntaxHighlighting(highlight)];
}
