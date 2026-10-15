// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer: what it does to files
// ═══════════════════════════════════════════
//
// New file, new folder, rename, duplicate, move, copy, paste, delete, files
// dropped from the computer, copy path, reveal. Each asks first where
// something could be lost, and says in the panel what happened: all of it, or
// how far it got, where it stopped and why, in plain words. It keeps the editor
// right: the tab of a renamed or moved file follows it as it is (text, caret,
// undo history), and unsaved text of a file that is about to be replaced is
// saved first.
// The controller (fx-main.js) hands in what this module needs of it.

import { renameSelection, sameNameIgnoringCase, validateName } from './fx-names.js';
import { baseName, canDropInto, dirName, failureMessage, relativeTo, stoppedMessage, topLevelOf } from './fx-logic.js';
import { confirmDialog } from './fx-popups.js';

export const MAX_UPLOAD_FILES = 2000;

/**
 * @param {object} c
 * @param {ReturnType<import('./fx-api.js').createExplorerApi>} c.api
 * @param {(key: string, params?: object) => string} c.t @param {(key: string, count: number, params?: object) => string} c.tp
 * @param {object} c.tree fx-tree.js @param {object} c.notice fx-popups.js createNotice
 * @param {object} c.editor fx-links.js createEditorLink @param {(path: string, at?: object) => void} c.openFile
 * @param {() => string | null} c.root the project's folder
 * @param {(dir: string) => object[] | null} c.itemsIn what a folder holds, when it was read
 * @param {(dir: string) => Promise<boolean>} c.openFolder open a folder in the tree and wait for its rows
 * @param {(dirs: string[]) => Promise<void>} c.refresh read folders again and draw them
 * @param {(pairs: { from: string, to: string }[]) => void} c.moved entries have another path now
 * @param {{ get: () => object | null, set: (value: object | null) => void }} c.clipboard what was cut or copied
 */
export function createOps({ api, t, tp, tree, notice, editor, openFile, root, itemsIn, openFolder, refresh, moved, clipboard }) {
  const platform = () => api.abilities().platform || 'posix';
  const trashWord = () => (platform() === 'win32' ? 'win32' : 'other');
  const fail = (failure) => { const message = failureMessage(failure); notice.show(t(message.key, message.params), { tone: 'error' }); };
  // A batch that did not go through: how far it got, where it stopped and why; and when a copy was begun and is
  // not whole, that what is there of it is only a part.
  const sayStopped = (what, { done, total, failure }) => {
    const message = stoppedMessage(what, { done, total, failure, trash: trashWord() });
    const said = t(message.key, message.why ? { ...message.params, why: t(message.why.key, message.why.params) } : message.params);
    notice.show(message.partial ? `${said} ${t(message.partial.key, message.partial.params)}` : said, { tone: 'error' });
  };
  const folderName = (dir) => (dir === root() ? baseName(dir) : baseName(dir));
  const cancelLabel = () => t('common.cancel');

  /** Why a name cannot be used in a folder, as a sentence, or null. */
  function nameProblem(name, dir, except = null) {
    const why = validateName(name, { platform: platform() });
    if (why) return t(failureMessage({ code: 'invalid-name', reason: why }).key, { name });
    const taken = (itemsIn(dir) || []).some((item) => item.name !== except && (item.name === name || sameNameIgnoringCase(item.name, name)));
    return taken ? t('fileExplorer.edit.taken', { name }) : null;
  }

  /**
   * Ask before entries are replaced: where what is there goes, and that unsaved text in it is saved first (what
   * goes to the Trash is then what was typed). A renamed or moved file needs no such question: its tab follows.
   * @param {string[]} dests the paths that would be replaced @param {string} into the folder they are in
   * @param {{ forGood?: boolean }} [o] asked again: the Trash cannot take them
   * @returns {Promise<boolean>} false when it was given up, or something could not be saved
   */
  async function askReplace(dests, into, { forGood = false } = {}) {
    const unsaved = editor.unsavedIn(dests);
    const toTrash = !forGood && api.abilities().trash;
    const answer = await confirmDialog({
      title: t(forGood ? 'fileExplorer.delete.noTrashTitle' : 'fileExplorer.replace.title'),
      lines: [
        dests.length === 1 ? t('fileExplorer.replace.one', { name: baseName(dests[0]), folder: folderName(into) }) : t('fileExplorer.replace.many', { count: dests.length, folder: folderName(into) }),
        t(toTrash ? `fileExplorer.replace.toTrash.${trashWord()}` : 'fileExplorer.replace.forGood'),
        unsaved.length ? tp('fileExplorer.replace.unsaved', unsaved.length, { name: baseName(unsaved[0]) }) : '',
      ],
      confirmLabel: t('fileExplorer.replace.confirm'),
      cancelLabel: cancelLabel(),
      danger: true,
    });
    if (answer !== 'confirm') return false;
    for (const file of unsaved) {
      if (!(await editor.saveFile(file))) {
        notice.show(t('fileExplorer.replace.notSaved', { name: baseName(file) }), { tone: 'error' });
        return false;
      }
    }
    return true;
  }

  /** Type the name of a new file or folder in `parent`, then make it. */
  async function create(kind, parent) {
    const dir = parent || root();
    if (!dir || !(await openFolder(dir))) return;
    tree.startEdit({
      parent: dir,
      kind,
      label: t(kind === 'dir' ? 'fileExplorer.edit.newFolder' : 'fileExplorer.edit.newFile'),
      validate: (name) => nameProblem(name, dir),
      async commit(name) {
        const made = await api.create(dir, name, kind);
        if (!made.ok) { const message = failureMessage({ ...made, name }); return { ok: false, message: t(message.key, message.params) }; }
        await refresh([dir]);
        tree.select([made.path], { focus: made.path });
        tree.focus();
        if (kind === 'file') openFile(made.path, { pin: true });
        return { ok: true };
      },
    });
  }

  /** Rename a row in place: the name without its extension starts selected. */
  function rename(path) {
    if (!path || path === root()) { fail({ code: 'root' }); return; }
    if (!api.abilities().ops) { fail({ code: 'unsupported' }); return; }
    const item = tree.itemOf(path);
    if (!item) return;
    const dir = dirName(path);
    tree.startEdit({
      path,
      value: item.name,
      select: renameSelection(item.name, item.type === 'dir'),
      label: t('fileExplorer.edit.rename', { name: item.name }),
      validate: (name) => nameProblem(name, dir, item.name),
      async commit(name) {
        const done = await api.rename(path, name);
        if (!done.ok) { const message = failureMessage({ ...done, name }); return { ok: false, message: t(message.key, message.params) }; }
        // The name was kept: the row it was typed in gives way to the row of the new name, and is not a file that went away.
        tree.settleEdit();
        const pairs = [{ from: path, to: done.path }];
        moved(pairs);
        editor.follow(pairs);
        await refresh([dir]);
        tree.select([done.path], { focus: done.path });
        tree.focus();
        return { ok: true };
      },
    });
  }

  /** Move or copy rows into a folder. A name that is taken is asked about; nothing is replaced unasked. */
  async function transfer(paths, into, { copy = false } = {}) {
    const list = topLevelOf(paths).filter((path) => path !== root());
    if (!list.length || !into) return false;
    if (!api.abilities().ops) { fail({ code: 'unsupported' }); return false; }
    if (!canDropInto(list, into, { copy })) {
      if (list.some((path) => into === path || relativeTo(path, into) !== null)) fail({ code: 'into-self' });
      else notice.show(t('fileExplorer.move.same'));
      return false;
    }
    const call = copy ? api.copy : api.move;
    const pairs = [];
    let left = list;
    // What a request did, whether it went through or stopped midway: the tree and the editor's tabs follow at once.
    const take = (answer) => {
      const did = (copy ? answer.copied : answer.moved) || [];
      if (!did.length) return;
      pairs.push(...did);
      left = left.filter((path) => !did.some((pair) => pair.from === path));
      if (!copy) { moved(did); editor.follow(did); }
    };
    const destsOf = (names) => names.filter((name) => left.some((path) => baseName(path) === name)).map((name) => `${into}/${name}`);
    // What may be replaced is said by name: the names that were asked about, and no other. A name that is taken by
    // the time the server looks, and was not asked about, comes back as a conflict and is asked about too.
    const replacing = () => ({ replace: [...taken], permanent: !api.abilities().trash });
    // A name that is taken in a folder that was read is asked about before the server is: it refuses all the same
    // (409) when one turns up that the page did not know of.
    const there = itemsIn(into) || [];
    let taken = list.filter((path) => dirName(path) !== into).map(baseName).filter((name) => there.some((item) => item.name === name));
    let options = {};
    if (taken.length) {
      if (!(await askReplace(destsOf(taken), into))) return false;
      options = replacing();
    }
    let done = await call(left, into, options);
    take(done);
    let givenUp = false;
    // Each round asks about names nobody was asked about yet; a file that keeps turning up is not asked about for ever.
    for (let round = 0; round < 5 && !done.ok && done.code === 'exists' && done.conflicts?.some((name) => !taken.includes(name)); round++) {
      const fresh = done.conflicts.filter((name) => !taken.includes(name));
      if (!(await askReplace(destsOf(fresh), into))) { givenUp = true; break; }
      taken = [...taken, ...fresh];
      options = replacing();
      done = await call(left, into, options);
      take(done);
    }
    if (!givenUp && !done.ok && done.code === 'no-trash' && !options.permanent) {
      // The Trash cannot take what is in the way. Nothing of it was removed: asked again, in the words for that.
      const still = destsOf(taken);
      if (await askReplace(still.length ? still : [`${into}/${baseName(done.failed || left[0])}`], into, { forGood: true })) {
        done = await call(left, into, { replace: [...taken], permanent: true });
        take(done);
      } else {
        givenUp = true;
      }
    }
    const dirs = [...new Set([into, ...list.map(dirName)])];
    if (pairs.length) await openFolder(into);
    await refresh(dirs);
    const landed = pairs.map((pair) => pair.to);
    if (landed.length) tree.select(landed, { focus: landed[0] });
    if (!done.ok) {
      // Given up before anything was done: nothing to say. Otherwise: how far it got, where it stopped and why.
      if (!(givenUp && !pairs.length)) sayStopped(copy ? 'copy' : 'move', { done: pairs.length, total: list.length, failure: done });
      return false;
    }
    if (pairs.length) notice.show(tp(copy ? 'fileExplorer.copy.done' : 'fileExplorer.move.done', pairs.length, { name: baseName(pairs[0].to), folder: folderName(into) }), { tone: 'ok' });
    return true;
  }

  /** A copy of each row next to it. */
  async function duplicate(paths) {
    const list = topLevelOf(paths).filter((path) => path !== root());
    if (!list.length) return;
    if (!api.abilities().ops) { fail({ code: 'unsupported' }); return; }
    const made = [];
    let failure = null;
    for (const dir of new Set(list.map(dirName))) {
      const done = await api.copy(list.filter((path) => dirName(path) === dir), dir);
      made.push(...(done.copied || []).map((pair) => pair.to));
      if (!done.ok) { failure = done; break; }
    }
    await refresh([...new Set(list.map(dirName))]);
    if (made.length) tree.select(made, { focus: made[0] });
    if (failure) sayStopped('copy', { done: made.length, total: list.length, failure });
    else if (made.length) notice.show(tp('fileExplorer.duplicate.done', made.length, { name: baseName(made[0]) }), { tone: 'ok' });
  }

  function cut(paths, mode = 'cut') {
    const list = topLevelOf(paths).filter((path) => path !== root());
    if (!list.length) return;
    if (!api.abilities().ops) { fail({ code: 'unsupported' }); return; }
    clipboard.set({ mode, paths: list });
    notice.show(tp(mode === 'cut' ? 'fileExplorer.clipboard.cut' : 'fileExplorer.clipboard.copied', list.length, { name: baseName(list[0]) }));
  }

  /** Put what was cut or copied into a folder. */
  async function paste(into) {
    const held = clipboard.get();
    if (!held) { notice.show(t('fileExplorer.menu.nothingCopied')); return; }
    const target = into || root();
    const done = await transfer(held.paths, target, { copy: held.mode === 'copy' });
    if (held.mode !== 'cut') return;
    // What was cut and has moved is no longer cut; after a move that stopped midway, the rest still is.
    const now = clipboard.get();
    const rest = done || !now ? [] : now.paths.filter((path) => dirName(path) !== target);
    clipboard.set(rest.length ? { ...now, paths: rest } : null);
  }

  /** Delete rows: to the Trash where there is one, and only after the question says which it will be. */
  async function remove(paths) {
    const list = topLevelOf(paths).filter((path) => path !== root());
    if (!list.length) { if (paths.includes(root())) fail({ code: 'root' }); return; }
    const can = api.abilities();
    const name = baseName(list[0]);
    const unsaved = editor.unsavedIn(list);
    const asked = await confirmDialog({
      title: list.length === 1 ? t('fileExplorer.delete.titleOne', { name }) : t('fileExplorer.delete.titleMany', { count: list.length }),
      lines: [
        can.trash ? t(`fileExplorer.delete.toTrash.${trashWord()}`) : t(can.ops ? 'fileExplorer.delete.forGood' : 'fileExplorer.delete.forGoodLegacy'),
        unsaved.length ? tp('fileExplorer.delete.unsaved', unsaved.length, { name: baseName(unsaved[0]) }) : '',
      ],
      confirmLabel: can.trash ? t(`fileExplorer.delete.moveToTrash.${trashWord()}`) : t('fileExplorer.delete.deleteForever'),
      cancelLabel: cancelLabel(),
      danger: true,
    });
    if (asked !== 'confirm') return;
    const dirs = [...new Set(list.map(dirName))];
    let done = await api.remove(list, { permanent: !can.trash });
    let trashed = !!done.trashed;
    let round = { what: can.trash ? 'trash' : 'delete', total: list.length };
    if (!done.ok && done.code === 'no-trash') {
      // That path has no Trash after all (another disk): it was not removed, and the question is asked again.
      const left = list.filter((path) => !(done.deleted || []).includes(path));
      await refresh(dirs);
      const again = await confirmDialog({
        title: t('fileExplorer.delete.noTrashTitle'),
        lines: [left.length === 1 ? t('fileExplorer.delete.noTrashOne', { name: baseName(left[0]) }) : t('fileExplorer.delete.noTrashMany', { count: left.length })],
        confirmLabel: t('fileExplorer.delete.deleteForever'),
        cancelLabel: cancelLabel(),
        danger: true,
      });
      if (again !== 'confirm') {
        // What had gone to the Trash before it is said; the rest is where it was.
        if (done.deleted?.length) sayStopped('trash', { done: done.deleted.length, total: list.length, failure: done });
        return;
      }
      done = await api.remove(left, { permanent: true });
      trashed = false;
      round = { what: 'delete', total: left.length };
    }
    await refresh(dirs);
    if (!done.ok) {
      if (done.code === 'not-empty') notice.show(t('fileExplorer.delete.notEmpty'), { tone: 'error' });
      else sayStopped(round.what, { done: (done.deleted || []).length, total: round.total, failure: done });
      return;
    }
    const held = clipboard.get();
    if (held && held.paths.some((path) => list.some((gone) => relativeTo(gone, path) !== null))) clipboard.set(null);
    notice.show(tp(trashed ? `fileExplorer.delete.doneTrash.${trashWord()}` : 'fileExplorer.delete.done', list.length, { name }), { tone: 'ok' });
    tree.focus();
  }

  // The files of a drop, read while the drop event is still there: a folder is walked, with its own folders.
  function gather(transfer) {
    const entries = [...(transfer.items || [])].filter((item) => item.kind === 'file').map((item) => item.webkitGetAsEntry?.() || item.getAsFile?.()).filter(Boolean);
    if (!entries.length) return Promise.resolve([...(transfer.files || [])].map((file) => ({ file, rel: '' })));
    const out = [];
    const walk = async (entry, rel) => {
      if (out.length > MAX_UPLOAD_FILES) return;
      if (typeof File !== 'undefined' && entry instanceof File) { out.push({ file: entry, rel }); return; }
      if (entry.isFile) { out.push({ file: await new Promise((done, failed) => entry.file(done, failed)), rel }); return; }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      const inside = rel ? `${rel}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise((done, failed) => reader.readEntries(done, failed));
        if (!batch.length) break;
        for (const child of batch) await walk(child, inside);
      }
    };
    return (async () => { for (const entry of entries) await walk(entry, ''); return out; })();
  }

  /** Files dropped from the computer are copied into a folder. */
  async function upload(transfer, into) {
    if (!api.abilities().ops) { fail({ code: 'unsupported' }); return; }
    let files;
    try { files = await gather(transfer); } catch { files = []; }
    if (!files.length) { notice.show(t('fileExplorer.upload.none')); return; }
    if (files.length > MAX_UPLOAD_FILES) { notice.show(t('fileExplorer.upload.tooMany', { max: MAX_UPLOAD_FILES }), { tone: 'error' }); return; }
    const clashes = [];   // a name that is taken: asked about
    const noTrash = [];   // the Trash could not take what was there: asked about again
    let sent = 0; let failure = null;
    const send = async (list, options = {}) => {
      for (const entry of list) {
        notice.show(t('fileExplorer.upload.progress', { done: sent + 1, total: files.length }), { ms: 0 });
        const done = await api.upload(entry.file, into, { rel: entry.rel, ...options });
        if (done.ok) { sent++; continue; }
        if (done.code === 'exists' && !options.replace) { clashes.push(entry); continue; }
        if (done.code === 'no-trash' && !options.permanent) { noTrash.push(entry); continue; }
        failure = { ...done, name: entry.file.name };
        return;
      }
    };
    const destOf = (entry) => [into, entry.rel, entry.file.name].filter(Boolean).join('/');
    await send(files);
    // What is replaced goes to the Trash, as a move's does; only what the Trash cannot take is asked about again.
    if (!failure && clashes.length && (await askReplace(clashes.map(destOf), into))) await send(clashes, { replace: true, permanent: !api.abilities().trash });
    if (!failure && noTrash.length && (await askReplace(noTrash.map(destOf), into, { forGood: true }))) await send(noTrash, { replace: true, permanent: true });
    await openFolder(into);
    await refresh([into]);
    if (failure) { sayStopped('copy', { done: sent, total: files.length, failure }); return; }
    if (sent) notice.show(tp('fileExplorer.upload.done', sent, { name: files[0].file.name, folder: folderName(into) }), { tone: 'ok' });
    else notice.clear();
  }

  async function write(text, said) {
    try { await navigator.clipboard.writeText(text); notice.show(said, { tone: 'ok', ms: 2500 }); }
    catch { notice.show(t('fileExplorer.copied.failed'), { tone: 'error' }); }
  }
  const copyPath = (paths, { relative = false } = {}) => {
    if (!paths.length) return;
    const lines = paths.map((path) => (relative ? relativeTo(root(), path) || '.' : path));
    write(lines.join('\n'), tp('fileExplorer.copied.path', paths.length));
  };
  const copyName = (path) => write(baseName(path), t('fileExplorer.copied.name'));

  async function reveal(path) {
    const done = await api.reveal(path);
    if (!done.ok) fail(done);
  }

  return { create, rename, transfer, duplicate, cut, copy: (paths) => cut(paths, 'copy'), paste, remove, upload, copyPath, copyName, reveal, nameProblem };
}
