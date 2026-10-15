// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: the command palette and go-to-file
// ═══════════════════════════════════════════
//
// Two lists under a search field, at the top of the editor panel: the
// editor's commands (F1 or Mod-Shift-P), and the files of the project
// (Mod-P; with nothing typed, the open tabs). Enter runs or opens what is
// selected, Escape closes the list and nothing else happens. Both are the
// panel's one popup (editor-menu.js); what they list and in which order is
// decided in editor-palette-logic.js.
// Takes its words, the menu and what a choice does as arguments.

import { FILE_SEARCH_DELAY_MS, fileListEmpty, fileRows, fileSearchParams, paletteCommands, queryTerms, rankRows, tabRows } from './editor-palette-logic.js';
import { formatKey } from './editor-commands.js';

/**
 * @param {object} o
 * @param {(key: string, params?: object) => string} o.t
 * @param {(menu: object) => { close: Function, setItems: Function }} o.openMenu editor-menu.js, already given the panel as its host
 * @param {() => { x: number, y: number }} o.position where a list opens: its top-left corner, in page coordinates
 * @param {boolean} o.mac
 * @param {object[]} o.commands editor-commands.js
 * @param {() => string[]} o.features the features this server has ('ai', 'git')
 * @param {(id: string) => void} o.run run a command by its id
 * @param {() => string | null | Promise<string | null>} o.project the folder files are searched in (it may have to be asked for)
 * @param {() => { path: string, name: string }[]} o.tabs the open files, the one used last first
 * @param {(path: string) => void} o.openFile
 * @param {() => void} [o.onClose] a list closed (the keyboard goes back to the text)
 * @param {typeof fetch} [o.fetchImpl]
 */
export function createPalette({ t, openMenu, position, mac, commands, features, run, project, tabs, openFile, onClose = () => {}, fetchImpl = (...args) => fetch(...args) }) {
  const item = (row, hint) => ({ id: row.id, label: row.label, ...(hint ? { hint } : {}) });

  function openCommands() {
    const rows = paletteCommands(commands, { features: features() }).map((row) => ({ id: row.id, label: t(row.titleKey), key: row.key }));
    return openMenu({
      className: 'fe-editor-palette',
      at: position(),
      label: t('editor.palette.commands'),
      items: [],
      search: {
        label: t('editor.palette.commands'),
        placeholder: t('editor.palette.commandsPlaceholder'),
        empty: t('editor.palette.noCommand'),
        filter: (query) => rankRows(rows, query, { limit: rows.length }).map((row) => item(row, row.key ? formatKey(row.key, mac) : '')),
      },
      onSelect: (id) => run(id),
      onClose,
    });
  }

  function openFiles() {
    let root = null;           // the folder that is searched, once it is known
    let rootKnown = false;
    let found = [];            // the files of the last answer
    let typed = '';
    let asked = '';            // the query string of the request that was last sent
    let timer = 0;
    let request = null;
    let failed = false;
    let pending = false;       // a search for what is typed is waiting to be sent, or has not answered yet
    let handle = null;

    const list = (query) => {
      const rows = queryTerms(query).length ? rankRows(found, query) : tabRows(tabs(), root);
      return rows.map((row) => item(row, row.detail));
    };
    // Still searching, failed, nothing found and nothing asked yet are four different things to say.
    const empty = () => t(fileListEmpty({ rootKnown, root, failed, pending, typed }));

    async function search(params) {
      request?.abort();
      const mine = new AbortController();
      request = mine;
      let rows = [];
      let ok = false;
      try {
        const res = await fetchImpl(`/api/project-files?${params}`, { signal: mine.signal });
        if (res.ok) { rows = fileRows(await res.json()); ok = true; }
      } catch { /* aborted, or no answer */ }
      if (request !== mine) return;   // a newer search is on its way
      request = null;
      pending = false;
      found = rows;
      failed = !ok;
      handle?.setItems(list(typed));
    }

    function schedule(query) {
      const params = fileSearchParams(root, query);
      if (params === asked) return;
      asked = params;
      clearTimeout(timer);
      if (!params) { request?.abort(); request = null; found = []; failed = false; pending = false; return; }
      pending = true;
      timer = setTimeout(() => search(params), FILE_SEARCH_DELAY_MS);
    }

    handle = openMenu({
      className: 'fe-editor-palette',
      at: position(),
      label: t('editor.palette.files'),
      items: [],
      search: {
        label: t('editor.palette.files'),
        placeholder: t('editor.palette.filesPlaceholder'),
        empty,
        filter: (query) => { typed = query; schedule(query); return list(query); },
      },
      onSelect: (path) => openFile(path),
      onClose: () => { clearTimeout(timer); request?.abort(); request = null; handle = null; onClose(); },
    });
    // The folder may have to be asked for: what was typed meanwhile is searched as soon as it is known.
    Promise.resolve().then(project).catch(() => null).then((folder) => {
      root = folder || null;
      rootKnown = true;
      if (!handle) return;
      schedule(typed);
      handle.setItems(list(typed));
    });
    return handle;
  }

  return { openCommands, openFiles };
}
