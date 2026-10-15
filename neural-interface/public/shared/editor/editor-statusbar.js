// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the status bar
// ═══════════════════════════════════════════
//
// The row under the editor (#fe-editor-statusbar, markup in html-shell.js):
// language, indentation, line ending and encoding on the left; the caret's
// position and the file's size on the right. Language, indentation and line
// ending are buttons that open a list; the position opens "go to line".
// AI autocomplete's chip is not built here: editor-ai.js puts it in front of
// the position when the server has the feature, and this module leaves it be.
//
// What the items say is decided in editor-panel-logic.js; what a choice does
// is the panel's. No imports of the app: the strings, the menu and the actions
// are handed in.

import { INDENT_CHOICES, eolStatus, filterLanguages, formatSize, indentChoiceId, indentStatus, positionStatus } from './editor-panel-logic.js';

/** What the language list calls "let the file name decide" and "no language". */
export const LANGUAGE_AUTO = 'auto';
export const LANGUAGE_PLAIN = 'plain';

/**
 * @param {object} o
 * @param {(key: string, params?: object) => string} o.t
 * @param {(menu: object) => object} o.openMenu editor-menu.js, already given the panel as its host
 * @param {() => { name: string, alias?: readonly string[] }[]} o.languages every language the editor can load
 * @param {object} o.actions `setLanguage(name | 'auto' | 'plain')`, `setIndent(choice | null)`,
 *   `setEol('LF' | 'CRLF')`, `goToLine()`
 */
export function createStatusBar({ t, openMenu, languages, actions }) {
  const $ = (id) => document.getElementById(id);
  const root = $('fe-editor-statusbar');
  const items = { lang: $('fe-editor-lang'), indent: $('fe-editor-indent'), eol: $('fe-editor-eol'), encoding: $('fe-editor-encoding'), cursor: $('fe-editor-cursor'), size: $('fe-editor-size') };
  let file = null;        // what showFile() was last given
  let language = { label: '', choice: null, detected: '' };

  const set = (node, text) => { if (node) node.textContent = text; };
  const name = (node, key) => {
    if (!node) return;
    node.dataset.tooltip = t(key);
    node.setAttribute('aria-haspopup', key === 'editor.status.goToLine' ? 'false' : 'menu');
  };
  name(items.lang, 'editor.status.selectLanguage');
  name(items.indent, 'editor.status.selectIndent');
  name(items.eol, 'editor.status.selectEol');
  name(items.cursor, 'editor.status.goToLine');

  function languageItems(query) {
    const plain = t('editor.status.plainText');
    const auto = language.detected ? `${t('editor.status.languageAuto')} (${language.detected})` : t('editor.status.languageAuto');
    const wanted = String(query || '').trim().toLowerCase();
    const special = [
      { id: LANGUAGE_AUTO, label: auto, checked: language.choice === null },
      { id: LANGUAGE_PLAIN, label: plain, checked: language.choice === LANGUAGE_PLAIN },
    ].filter((item) => !wanted || item.label.toLowerCase().includes(wanted));
    const found = filterLanguages(languages(), query).map((entry) => ({ id: entry, label: entry, checked: language.choice === entry }));
    return [...special, ...(special.length && found.length ? [{ separator: true }] : []), ...found];
  }

  items.lang?.addEventListener('click', () => {
    if (!file) return;
    openMenu({
      anchor: items.lang,
      label: t('editor.status.selectLanguage'),
      items: [],
      search: { label: t('editor.status.selectLanguage'), placeholder: t('editor.status.languageSearch'), empty: t('editor.status.languageNone'), filter: languageItems },
      onSelect: (id) => actions.setLanguage(id),
    });
  });

  items.indent?.addEventListener('click', () => {
    if (!file) return;
    const current = indentChoiceId(file.indentChoice);
    const detected = indentStatus(file.detected);
    openMenu({
      anchor: items.indent,
      label: t('editor.status.selectIndent'),
      items: [
        ...INDENT_CHOICES.map((choice) => ({
          id: choice.id,
          label: choice.kind === 'tabs' ? t('editor.status.indentTabs') : t('editor.status.spaces', { n: choice.size }),
          checked: current === choice.id,
        })),
        { separator: true },
        { id: 'detect', label: t('editor.status.indentDetect'), hint: t(detected.key, detected.params), checked: current === 'detect' },
      ],
      onSelect: (id) => {
        const choice = INDENT_CHOICES.find((entry) => entry.id === id);
        actions.setIndent(choice ? { kind: choice.kind, ...(choice.size ? { size: choice.size } : {}) } : null);
      },
    });
  });

  items.eol?.addEventListener('click', () => {
    if (!file) return;
    openMenu({
      anchor: items.eol,
      label: t('editor.status.selectEol'),
      items: ['LF', 'CRLF'].map((eol) => ({ id: eol, label: eol, checked: !file.mixed && file.eol === eol })),
      onSelect: (eol) => actions.setEol(eol),
    });
  });

  items.cursor?.addEventListener('click', () => { if (file) actions.goToLine(); });

  // The bar is outside the editor's own element: a key pressed on one of its buttons stays here.
  for (const type of ['keydown', 'keyup', 'keypress']) root?.addEventListener(type, (event) => event.stopPropagation());

  return {
    /**
     * The open document's facts; null leaves the bar at its height with nothing in it.
     * @param {{ indent: object, indentChoice: object | null, detected: object, eol: string, mixed: boolean, bom: boolean, size: number } | null} next
     */
    showFile(next) {
      file = next;
      root?.classList.toggle('is-empty', !file);
      if (!file) return;
      const indent = indentStatus(file.indent);
      set(items.indent, t(indent.key, indent.params));
      const eol = eolStatus(file);
      set(items.eol, eol.key ? t(eol.key, eol.params) : eol.text);
      set(items.encoding, file.bom ? t('editor.status.utf8Bom') : 'UTF-8');
      set(items.size, formatSize(file.size));
    },

    /**
     * The language the document is shown in.
     * @param {{ label: string, choice: string | null, detected: string }} next `label`: what the bar says ('' for
     *   plain text); `choice`: what the user picked, null while the file name decides; `detected`: what the file
     *   name alone gives
     */
    showLanguage(next) {
      language = { label: next?.label || '', choice: next?.choice ?? null, detected: next?.detected || '' };
      if (file) set(items.lang, language.label || t('editor.status.plainText'));
    },

    /** Where the caret is: `{ line, column, selected, cursors }`; null while the document is not in the view yet. */
    showPosition(at) {
      if (!file || !at) { set(items.cursor, ''); return; }
      const status = positionStatus(at);
      set(items.cursor, t(status.key, status.params));
    },
  };
}
