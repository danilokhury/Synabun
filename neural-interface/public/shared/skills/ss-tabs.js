// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: an open document
// ═══════════════════════════════════════════
//
// A tab holds the file as it was last read or saved (its exact text and the revision the server gave it) and
// the text being edited ("\n" line breaks, no byte-order mark). It is unsaved when that text is not the saved
// text, line endings aside: opening a CRLF file or switching tabs never makes one. A save sends a snapshot,
// the text as it is when Save is pressed, with the file's own line endings put back; when the answer comes,
// the file is that snapshot, and anything typed meanwhile is still unsaved. No DOM and no imports beyond
// ss-doc.js.

import { toEditing, fromEditing, sameAsSaved, looksDecodedFromBinary } from './ss-doc.js';

/** The key of a tab's copy of unsaved text: the same for the same file, whichever tab opens it. */
export const draftKey = (artifactId, path) => `skills:${artifactId}::${path ?? ''}`;

/**
 * A tab from what the server answered.
 * @param {object} o
 * @param {object} o.artifact the library entry
 * @param {object} o.artifactContent what GET /artifact/:id answered (subFiles…)
 * @param {string|null} o.path null for the artifact's own file, else the sub-file
 * @param {string} o.raw the file's text as read
 * @param {string|null} [o.revision] what a save names (null: a server from before revisions)
 * @param {boolean} [o.binary] not text: shown, never edited. What the server said, as it said it: `undefined`
 *   is a server from before binary files were told apart
 * @param {boolean} [o.readOnly] a bundled skill's source
 */
export function createDocTab({ artifact, artifactContent, path = null, raw = '', revision = null, binary, size = 0, readOnly = false, label }) {
  const text = String(raw ?? '');
  // The server's word decides. One from before binary files were told apart (it says nothing) decoded every
  // file as text, the artifact's own file too: a text that holds what that decoding replaced is not edited.
  const isBinary = binary === true || (binary !== false && looksDecodedFromBinary(text));
  const editing = toEditing(isBinary ? '' : text);
  return {
    id: path === null ? `main:${artifact.id}` : `${artifact.id}:${path}`,
    artifactId: artifact.id, artifact, artifactContent, path,
    label: label ?? (path === null ? artifact.name : String(path).split('/').pop()),
    saved: { raw: isBinary ? '' : text, revision: revision ?? null },
    content: editing.text,
    bom: editing.bom, eol: editing.eol, mixedEol: editing.mixed,
    dirty: false, binary: isBinary, size: Number(size) || text.length,
    readOnly: !!readOnly || isBinary,
    saving: null,
  };
}

/** Whether the tab's text differs from the file as saved (line endings and the byte-order mark aside). */
export function refreshDirty(tab) {
  tab.dirty = !tab.binary && !tab.readOnly && !sameAsSaved(tab.saved.raw, tab.content);
  return tab.dirty;
}

/** What a save sends: the text as it is now, written the way the file is written. */
export function saveSnapshot(tab) {
  const text = tab.content;
  return { text, raw: fromEditing(tab.saved.raw, text), expectedRevision: tab.saved.revision };
}

/** The save of `sent` arrived: the file is that now. Returns whether the tab is still unsaved (typed meanwhile). */
export function applySaved(tab, sent, revision) {
  tab.saved = { raw: sent.raw, revision: revision ?? null };
  return refreshDirty(tab);
}

/** Give the unsaved text up: the tab holds the file as saved again. */
export function revertTab(tab) {
  tab.content = toEditing(tab.saved.raw).text;
  return refreshDirty(tab);
}

/** The file was read again (another save won, or "reload"): the tab holds what is there now. */
export function replaceSaved(tab, raw, revision) {
  tab.saved = { raw: String(raw ?? ''), revision: revision ?? null };
  const editing = toEditing(tab.saved.raw);
  tab.content = editing.text;
  tab.bom = editing.bom; tab.eol = editing.eol; tab.mixedEol = editing.mixed;
  return refreshDirty(tab);
}
