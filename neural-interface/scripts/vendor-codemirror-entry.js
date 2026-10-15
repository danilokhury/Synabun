// Vendor bundle entry — the parts of CodeMirror 6 the File Explorer's code
// editor uses (public/shared/editor/). Built by scripts/build-vendor.mjs into
// public/vendor/codemirror/ with code splitting: this file and the core chunk
// it shares with the languages load when the editor first opens; each language
// of @codemirror/language-data, and the loaders at the end, are chunks of
// their own, fetched when they are needed.
export {
  Annotation,
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
  Transaction,
  countColumn,
} from '@codemirror/state';
export {
  Decoration,
  EditorView,
  GutterMarker,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  drawSelection,
  dropCursor,
  getPanel,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  runScopeHandlers,
  showPanel,
  showTooltip,
} from '@codemirror/view';
export {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  bracketMatching,
  codeFolding,
  foldCode,
  foldGutter,
  foldKeymap,
  getIndentUnit,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
  unfoldCode,
} from '@codemirror/language';
export {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  defaultKeymap,
  deleteLine,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  isolateHistory,
  moveLineDown,
  moveLineUp,
  redo,
  redoDepth,
  toggleBlockComment,
  toggleComment,
  undo,
  undoDepth,
} from '@codemirror/commands';
export {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  selectNextOccurrence,
  selectSelectionMatches,
  setSearchQuery,
} from '@codemirror/search';
export {
  CompletionContext,
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completeAnyWord,
  completeFromList,
  completionKeymap,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete';
export { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
export { languages } from '@codemirror/language-data';
export { indentationMarkers } from '@replit/codemirror-indentation-markers';

// Not needed to open a file: each is its own chunk.
export const loadLint = () => import('@codemirror/lint');
export const loadMerge = () => import('@codemirror/merge');
// The JSON language's own linter. The language itself is loaded through language-data: this is the same chunk.
export const loadJsonLinter = () => import('@codemirror/lang-json').then((module) => module.jsonParseLinter);
