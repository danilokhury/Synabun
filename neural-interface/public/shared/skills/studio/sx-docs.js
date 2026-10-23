// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: a workspace's documents
// ═══════════════════════════════════════════
//
// One workspace per thing opened from the Library (sx-subject.js says its mode). It holds the files it has, the
// documents open in it (P0's tab: the file as last read or saved, and the text being edited, ss-tabs.js), and how
// each is read and saved:
//   library   files of the skill's draft (or of its latest revision until the first save makes a draft); a save
//             puts the file into the draft (PATCH /v2/drafts/:id) over the draft's etag. Another change of the
//             draft meanwhile (the Assistant, another window) is a conflict only when it touched this file: the
//             file's digest in the draft is still the one the document was opened at, so the save is sent again
//             over the new etag; otherwise the owner decides.
//   adopt     the folder as it is on disk (read through the P0 routes or the catalog); the first save takes the
//             folder into the library (POST /v2/skills { artifactId }), makes its draft and puts the file there.
//             The folder that was adopted must still hold what the document was opened at, else the owner decides.
//   inplace   an agent or a command, saved where it is over the revision it was opened at (P0's PUT).
//   readonly  shown, never saved.
// What is typed while a save is on its way stays unsaved (the save sends a snapshot). Unsaved text is copied to
// this browser (IndexedDB, editor-safety.js) a second after the last change and offered back when the workspace
// opens again; a copy left by the Studio before 2.0 is found under its old key. The page's I/O is handed in.

import { createDocTab, refreshDirty, saveSnapshot, applySaved, revertTab, replaceSaved, draftKey } from '../ss-tabs.js';
import { toEditing, isEditableText } from '../ss-doc.js';
import { createBackups, localBackupStore, describeBackup, textFingerprint } from '../../editor/editor-safety.js';
import { subjectOf } from './sx-subject.js';

export const HEAD = 'SKILL.md';
export const DRAFTS_INDEX_KEY = 'synabun-skills-drafts-v2';
const LEGACY_INDEX_KEY = 'synabun-skills-drafts-v1';

let _backups = null;
/** The browser's copies of unsaved text (one database for the Studio, as before 2.0). */
export function backups() {
  if (!_backups) _backups = createBackups({ store: localBackupStore({ name: 'synabun-skills-studio' }) });
  return _backups;
}

function readIndex(key) {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function writeIndex(key, index) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(index)); } catch { /* full or blocked: the copy itself is kept */ }
}

/** The unsaved copies kept from earlier sessions: `{ key: { wsKey, path, label, at } }`. */
export const keptDrafts = () => readIndex(DRAFTS_INDEX_KEY);

/** The P0 key of a document (its decoded artifact id and its path then), to find a copy it left. */
function legacyKey(ws, path) {
  const entry = ws.row?.primary;
  if (!entry?.path || !['skill', 'command', 'agent'].includes(entry.kind)) return null;
  const legacyPath = entry.kind === 'skill' ? (path === HEAD ? null : path) : null;
  return draftKey(`${entry.kind}:${entry.path}`, legacyPath);
}

/** A tab's text changed: copy it while it is unsaved, forget the copy once it is not. */
export function noteDraft(ws, tab) {
  if (!tab || tab.binary || tab.readOnly) return;
  const key = draftKey(ws.key, tab.path);
  if (!tab.dirty) { dropDraft(ws, tab); return; }
  backups().touch(key, () => (tab.dirty
    ? { path: tab.label, text: tab.content, base: textFingerprint(toEditing(tab.saved.raw).text), eol: tab.eol === '\r\n' ? 'CRLF' : 'LF' }
    : null));
  const index = readIndex(DRAFTS_INDEX_KEY);
  if (!index[key]) {
    index[key] = { wsKey: ws.key, path: tab.path, label: tab.label, name: ws.label, at: Date.now() };
    writeIndex(DRAFTS_INDEX_KEY, index);
  }
}

/** Forget a tab's copy (saved, or discarded on purpose). */
export function dropDraft(ws, tab) {
  for (const [indexKey, key] of [[DRAFTS_INDEX_KEY, draftKey(ws.key, tab.path)], [LEGACY_INDEX_KEY, legacyKey(ws, tab.path)]]) {
    if (!key) continue;
    try { backups().drop(key, { always: true }); } catch { /* the store's own failure */ }
    const index = readIndex(indexKey);
    if (index[key]) { delete index[key]; writeIndex(indexKey, index); }
  }
}

/** Forget copies by their keys (the Library's "Discard" of kept changes). */
export function dropKept(keys) {
  const index = readIndex(DRAFTS_INDEX_KEY);
  for (const key of keys) { try { backups().drop(key, { always: true }); } catch { /* */ } delete index[key]; }
  writeIndex(DRAFTS_INDEX_KEY, index);
}

/**
 * Put a tab's unsaved text from an earlier session back. A copy made over a file that changed since is offered
 * through `ask` (true: put it back), never put back unasked.
 * @returns {Promise<boolean>}
 */
export async function restoreDraft(ws, tab, { ask = async () => false } = {}) {
  if (tab.binary || tab.readOnly) return false;
  let record = null;
  for (const key of [draftKey(ws.key, tab.path), legacyKey(ws, tab.path)]) {
    if (!key) continue;
    try { record = await backups().read(key); } catch { record = null; }
    if (record) break;
  }
  if (!record) return false;
  const verdict = describeBackup(record, toEditing(tab.saved.raw).text);
  if (verdict === 'same') { dropDraft(ws, tab); return false; }
  if (verdict === 'restore-changed' && !(await ask(tab))) return false;
  tab.content = record.text;
  refreshDirty(tab);
  noteDraft(ws, tab);
  return true;
}

// ── The workspace ──

/**
 * A workspace for a Library row.
 * @param {object} row sx-library.js
 * @param {{ guest?: boolean, caps?: Set<string> }} o
 */
export function newWorkspace(row, { guest = false, caps = new Set() } = {}) {
  const subject = subjectOf(row, { guest, caps });
  return {
    key: row.key, row, subject,
    kind: row.kind,
    label: row.label || row.name || row.folderName || '',
    files: [], dirs: [], filesTruncated: false,
    skill: row.skill || null, draft: null, revision: null, entry: null,
    tabs: [], active: -1,
    loaded: false, error: null,
    queue: Promise.resolve(),
    tab: 'edit',
    seenElsewhere: new Set(),
  };
}

const tabArtifact = (ws) => ({ id: ws.key, name: ws.label });

function libraryTreeFromRevision(rev) {
  return (rev?.manifest?.files || []).map((f) => ({ path: f.path, size: f.bytes, digest: f.digest, binary: f.encoding === 'binary', executable: f.mode === '0755' }));
}
function libraryTreeFromDraft(draft, rev) {
  const sizes = new Map((rev?.manifest?.files || []).map((f) => [f.path, f]));
  return (draft?.files || []).map((f) => {
    const known = sizes.get(f.path);
    return { path: f.path, digest: f.digest, executable: !!f.executable, size: known && known.digest === f.digest ? known.bytes : null, binary: known && known.digest === f.digest ? known.encoding === 'binary' : null };
  });
}
function flattenTree(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === 'dir') flattenTree(n.children, out);
    else out.push({ path: n.path, size: n.size ?? null, binary: null, digest: null });
  }
  return out;
}
function dirsOfTree(nodes, out = []) {
  for (const n of nodes || []) if (n.type === 'dir') { out.push(n.path); dirsOfTree(n.children, out); }
  return out;
}

/**
 * Read what a workspace holds (its files, its library state) and open its head document.
 * @param {object} ws @param {object} io api.js @param {{ ask?: Function }} [o]
 */
export async function loadWorkspace(ws, io, { ask } = {}) {
  const s = ws.subject;
  ws.error = null;
  if (s.readsFiles === 'library' && ws.skill) {
    const skill = (await io.fetchSkill(ws.skill.skillId)).skill;
    ws.skill = skill;
    const draftId = skill.pointers?.draft || null;
    const showRevision = s.mode === 'readonly' ? (skill.pointers?.upstream || skill.pointers?.approved || skill.pointers?.latest) : skill.pointers?.latest;
    ws.revision = showRevision ? (await io.fetchSkillsRevision(showRevision)).revision : null;
    if (draftId && s.mode !== 'readonly') {
      try { ws.draft = (await io.fetchSkillsDraft(draftId)).draft; } catch (err) { if (err?.status !== 404) throw err; ws.draft = null; }
    }
    ws.files = ws.draft ? libraryTreeFromDraft(ws.draft, ws.revision) : libraryTreeFromRevision(ws.revision);
    ws.dirs = ws.draft ? (ws.draft.dirs || []) : (ws.revision?.manifest?.dirs || []);
  } else if (ws.row.primary) {
    const detail = (await io.fetchSkillsCatalogEntry(ws.row.primary.id)).entry;
    ws.entry = detail;
    if (ws.kind === 'skill') {
      ws.files = [{ path: HEAD, size: detail.size ?? null, binary: !!detail.binary, digest: detail.revision || null }, ...flattenTree(detail.files || []).filter((f) => f.path !== HEAD)];
      ws.dirs = dirsOfTree(detail.files || []);
      ws.filesTruncated = !!detail.filesTruncated;
    } else {
      ws.files = [{ path: null, size: detail.size ?? null, binary: !!detail.binary, digest: detail.revision || null }];
    }
  }
  ws.loaded = true;
  const head = ws.kind === 'skill' ? HEAD : null;
  if (!ws.tabs.some((t) => t.path === head)) await openFile(ws, head, io, { ask });
  return ws;
}

/** The digest the service gives a text file (`sha256:` of its UTF-8 bytes), or null where the page cannot work it out. */
export async function sha256Text(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder !== 'function') return null;
  try {
    const hash = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? ''))));
    return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch { return null; }
}

/** The library's draft file list as a digest by path. */
const digestIn = (draft, path) => (draft?.files || []).find((f) => f.path === path)?.digest || null;

/**
 * Read one file of a workspace into a document: `{ raw, revision, binary, size, base64 }`.
 */
export async function readFile(ws, path, io) {
  const s = ws.subject;
  if (s.readsFiles === 'library' && (ws.draft || ws.revision)) {
    if (ws.draft) {
      const got = await io.fetchSkillsDraftFile(ws.draft.draftId, path);
      const digest = digestIn(ws.draft, path);
      if (typeof got.contentBase64 === 'string') return { raw: '', revision: digest, binary: true, base64: got.contentBase64, size: Math.floor(got.contentBase64.length * 3 / 4) };
      return { raw: got.content ?? '', revision: digest, binary: false, size: (got.content || '').length };
    }
    const got = await io.fetchSkillsRevisionFile(ws.revision.revisionId, path);
    if (got.encoding !== 'utf-8' || typeof got.contentBase64 === 'string') return { raw: '', revision: got.digest || null, binary: true, base64: got.contentBase64 || null, size: null };
    return { raw: got.content ?? '', revision: got.digest || null, binary: false };
  }
  if (s.readsFiles === 'v1' && s.v1Id) {
    if (path === HEAD || path === null) {
      const got = await io.fetchSkillsArtifact(s.v1Id);
      return { raw: got.binary ? '' : (got.rawContent ?? ''), revision: got.revision ?? null, binary: !!got.binary, size: got.size ?? null, readOnly: got.readOnly === true };
    }
    const got = await io.fetchSkillsSubFile(s.v1Id, path);
    return { raw: got.binary ? '' : (got.content ?? ''), revision: got.revision ?? null, binary: !!got.binary, size: got.size ?? null, readOnly: got.readOnly === true };
  }
  if (path === HEAD || path === null) {
    const entry = ws.entry || (await io.fetchSkillsCatalogEntry(ws.row.primary.id)).entry;
    if (entry.binary) return { raw: '', revision: entry.revision || null, binary: true, size: entry.size ?? null };
    if (typeof entry.text !== 'string') throw Object.assign(new Error(entry.textError || 'unreadable'), { code: 'unreadable' });
    return { raw: entry.text, revision: entry.revision || null, binary: false };
  }
  if (s.readsFiles === 'catalog') {
    const got = await io.fetchSkillsCatalogFile(ws.row.primary.id, path);
    if (got.binary) return { raw: '', revision: null, binary: true, base64: got.contentBase64 || null, size: got.size ?? null };
    // The route sends no revision: the text's own digest is what an adoption is checked against.
    return { raw: got.content ?? '', revision: await sha256Text(got.content ?? ''), binary: false, size: got.size ?? null };
  }
  // Only the head file is read here: the route that reads a catalog skill's other files (GET /v2/catalog/:id/file,
  // capability `catalog-file`) is missing from a server older than the page. A restart brings it.
  if (s.readsFiles === 'head') throw Object.assign(new Error('This file opens after SynaBun restarts.'), { code: 'needs-restart' });
  throw Object.assign(new Error('This file can be opened once the skill is in the library.'), { code: 'needs-library' });
}

/**
 * Open a file in a tab (or the tab it already has). The workspace it was asked for is the one it lands in, however
 * long the read takes (a read that comes back after another workspace was opened is never put in that one).
 * @returns {Promise<object>} the tab
 */
export async function openFile(ws, path, io, { ask } = {}) {
  const open = ws.tabs.find((t) => t.path === path);
  if (open) { ws.active = ws.tabs.indexOf(open); return open; }
  const got = await readFile(ws, path, io);
  const again = ws.tabs.find((t) => t.path === path);
  if (again) { ws.active = ws.tabs.indexOf(again); return again; }
  const readOnly = !ws.subject.editable || got.readOnly === true;
  const tab = createDocTab({ artifact: tabArtifact(ws), artifactContent: null, path, raw: got.raw, revision: got.revision, binary: got.binary, size: got.size, readOnly, label: path === null ? `${ws.label}.md` : String(path) });
  tab.base64 = got.base64 || null;
  await restoreDraft(ws, tab, { ask });
  ws.tabs.push(tab);
  ws.active = ws.tabs.length - 1;
  return tab;
}

/** The documents of a workspace with unsaved text. */
export const dirtyTabs = (ws) => (ws?.tabs || []).filter((t) => t.dirty);

/** Close a tab (the caller asked about unsaved text first). */
export function closeTab(ws, tab) {
  const at = ws.tabs.indexOf(tab);
  if (at < 0) return;
  ws.tabs.splice(at, 1);
  if (ws.active >= ws.tabs.length) ws.active = ws.tabs.length - 1;
  else if (ws.active > at) ws.active--;
}

/** Give a tab's unsaved text up. */
export function discardTab(ws, tab) {
  revertTab(tab);
  dropDraft(ws, tab);
}

// ── Saving ──

/** Run `fn` after every save already asked for in this workspace (one write at a time). */
function serially(ws, fn) {
  const run = ws.queue.then(fn, fn);
  ws.queue = run.catch(() => {});
  return run;
}

/** The library state after an adoption or a new draft: the subject becomes "library". */
function becomeLibrary(ws, skill) {
  ws.skill = skill;
  ws.row = { ...ws.row, skill };
  ws.subject = { ...ws.subject, mode: 'library', readsFiles: 'library', hasVersions: true, canPublish: true, canAdopt: false, skillId: skill.skillId };
}

/** Take an owner's folder into the library now, without a change (Edit → "Add to library"): the documents stay. */
export async function adoptWorkspace(ws, io, { key = () => '' } = {}) {
  if (ws.subject.mode !== 'adopt') return ws;
  const adopted = await io.adoptSkillsArtifact(ws.row.primary.id, { idempotencyKey: key('adopt') });
  becomeLibrary(ws, adopted.skill);
  const skill = (await io.fetchSkill(adopted.skill.skillId)).skill;
  ws.skill = skill;
  if (skill.pointers?.latest) ws.revision = (await io.fetchSkillsRevision(skill.pointers.latest)).revision;
  return ws;
}

/** Start the workspace again from what the library holds now (after a restore made a new draft). */
export function resetDocuments(ws) {
  for (const tab of ws.tabs) dropDraft(ws, tab);
  ws.tabs = [];
  ws.active = -1;
  ws.draft = null;
  ws.revision = null;
  ws.loaded = false;
}

/**
 * Make sure the workspace has a draft to save into: the skill's own (adopting the folder first when it is not in
 * the library yet). Answers what the draft holds for each open document, so a document whose file changed under it
 * is caught before anything is written.
 * @returns {Promise<{ changedUnder: string[] }>} paths whose file in the draft is not what their tab was opened at
 */
export async function ensureDraft(ws, io, { key = () => '' } = {}) {
  if (ws.subject.mode === 'adopt') {
    const adopted = await io.adoptSkillsArtifact(ws.row.primary.id, { idempotencyKey: key('adopt') });
    becomeLibrary(ws, adopted.skill);
  }
  if (ws.subject.mode !== 'library' || !ws.skill) throw Object.assign(new Error('This cannot be saved.'), { code: 'read-only' });
  if (!ws.draft) {
    const skill = (await io.fetchSkill(ws.skill.skillId)).skill;
    ws.skill = skill;
    if (skill.pointers?.draft) {
      try { ws.draft = (await io.fetchSkillsDraft(skill.pointers.draft)).draft; } catch (err) { if (err?.status !== 404) throw err; }
    }
    if (!ws.draft) ws.draft = (await io.createSkillsDraft({ skillId: skill.skillId, baseRevisionId: skill.pointers?.latest || null }, { idempotencyKey: key('draft') })).draft;
    if (!ws.revision && skill.pointers?.latest) { try { ws.revision = (await io.fetchSkillsRevision(skill.pointers.latest)).revision; } catch { /* the tree below says enough */ } }
    ws.files = libraryTreeFromDraft(ws.draft, ws.revision);
    ws.dirs = ws.draft.dirs || [];
  }
  const changedUnder = ws.tabs.filter((t) => !t.binary && t.path && t.saved.revision && digestIn(ws.draft, t.path) && digestIn(ws.draft, t.path) !== t.saved.revision).map((t) => t.path);
  return { changedUnder };
}

/**
 * Save one document.
 * @returns {Promise<{ status: 'saved'|'unchanged'|'conflict'|'gone', stillDirty?: boolean, current?: string|null, diagnostics?: object[] }>}
 *   `conflict`: the file changed elsewhere since the document was opened (`current` its revision now); nothing was written.
 */
export function saveTab(ws, tab, io, { over = null, key = () => '' } = {}) {
  return serially(ws, async () => {
    if (!tab || tab.binary || tab.readOnly || !ws.tabs.includes(tab)) return { status: 'unchanged' };
    if (!tab.dirty && !over) return { status: 'unchanged' };
    const sent = saveSnapshot(tab);
    tab.saving = sent;
    try {
      if (ws.subject.mode === 'inplace') {
        const res = await io.saveSkillsArtifact(ws.subject.v1Id, sent.raw, { expectedRevision: over || sent.expectedRevision });
        const stillDirty = applySaved(tab, sent, res?.revision ?? null);
        noteDraft(ws, tab);
        return { status: 'saved', stillDirty, diagnostics: res?.diagnostics || [] };
      }
      const { changedUnder } = await ensureDraft(ws, io, { key });
      if (!over && changedUnder.includes(tab.path)) return { status: 'conflict', current: digestIn(ws.draft, tab.path) };
      const put = async (etag) => io.patchSkillsDraft(ws.draft.draftId, { expectedEtag: etag, ops: [{ op: 'put', path: tab.path, content: sent.raw }] });
      let res;
      try { res = await put(ws.draft.etag); } catch (err) {
        if (err?.status !== 409 || err?.code !== 'draft_conflict') throw err;
        // Someone changed the draft: a conflict for this document only when they changed its file.
        const now = (await io.fetchSkillsDraft(ws.draft.draftId)).draft;
        ws.draft = now;
        ws.files = libraryTreeFromDraft(now, ws.revision);
        const theirs = digestIn(now, tab.path);
        if (!over && theirs && theirs !== tab.saved.revision) return { status: 'conflict', current: theirs };
        res = await put(now.etag);
      }
      ws.draft = res.draft;
      ws.files = libraryTreeFromDraft(ws.draft, ws.revision);
      ws.dirs = ws.draft.dirs || [];
      const stillDirty = applySaved(tab, sent, digestIn(ws.draft, tab.path));
      noteDraft(ws, tab);
      return { status: 'saved', stillDirty };
    } catch (err) {
      if (err?.status === 409 && err?.code === 'revision_conflict') return { status: err.body?.currentRevision ? 'conflict' : 'gone', current: err.body?.currentRevision || null };
      throw err;
    } finally {
      tab.saving = null;
    }
  });
}

/** Read a document's file again and show it, dropping its unsaved text. */
export async function reloadTab(ws, tab, io) {
  if (ws.subject.mode === 'library' && ws.draft) ws.draft = (await io.fetchSkillsDraft(ws.draft.draftId)).draft;
  const got = await readFile(ws, tab.path, io);
  replaceSaved(tab, got.raw, got.revision);
  tab.binary = !!got.binary;
  tab.base64 = got.base64 || null;
  dropDraft(ws, tab);
  return tab;
}

/** Save a draft as a new version (a revision); `unchanged` when it holds exactly its base's bytes. */
export async function saveVersion(ws, io, { note = '', key = () => '' } = {}) {
  await ensureDraft(ws, io, { key });
  const out = await io.snapshotSkillsDraft(ws.draft.draftId, { expectedEtag: ws.draft.etag, note }, { idempotencyKey: key('snapshot') });
  ws.draft = out.draft;
  ws.revision = out.revision;
  ws.skill = (await io.fetchSkill(ws.skill.skillId)).skill;
  return out;
}

// ── Files of a library draft ──

/** Put new files (or a new folder) into the draft: `items` [{ path, content | contentBase64, executable? }]. */
export async function putFiles(ws, items, io, { key = () => '' } = {}) {
  return serially(ws, async () => {
    await ensureDraft(ws, io, { key });
    const ops = items.map((it) => (it.mkdir ? { op: 'mkdir', path: it.path } : { op: 'put', path: it.path, ...(typeof it.contentBase64 === 'string' ? { contentBase64: it.contentBase64 } : { content: String(it.content ?? '') }), ...(it.executable ? { executable: true } : {}) }));
    const res = await io.patchSkillsDraft(ws.draft.draftId, { expectedEtag: ws.draft.etag, ops });
    ws.draft = res.draft;
    ws.files = libraryTreeFromDraft(ws.draft, ws.revision);
    ws.dirs = ws.draft.dirs || [];
    return res.draft;
  });
}

/** Delete a file or a folder from the draft. A document of it with unsaved text is kept (or dropped) by the caller. */
export async function deleteFile(ws, path, io, { key = () => '' } = {}) {
  return serially(ws, async () => {
    await ensureDraft(ws, io, { key });
    const res = await io.patchSkillsDraft(ws.draft.draftId, { expectedEtag: ws.draft.etag, ops: [{ op: 'delete', path }] });
    ws.draft = res.draft;
    ws.files = libraryTreeFromDraft(ws.draft, ws.revision);
    ws.dirs = ws.draft.dirs || [];
    return res.draft;
  });
}

/** Rename a file of the draft; its open document follows. */
export async function renameFile(ws, from, to, io, { key = () => '' } = {}) {
  return serially(ws, async () => {
    await ensureDraft(ws, io, { key });
    const res = await io.patchSkillsDraft(ws.draft.draftId, { expectedEtag: ws.draft.etag, ops: [{ op: 'rename', from, to }] });
    ws.draft = res.draft;
    ws.files = libraryTreeFromDraft(ws.draft, ws.revision);
    const tab = ws.tabs.find((t) => t.path === from);
    if (tab) {
      dropDraft(ws, tab);
      tab.path = to;
      tab.label = to;
      tab.id = `${ws.key}:${to}`;
      noteDraft(ws, tab);
    }
    return res.draft;
  });
}

/** Whether bytes a person picked are text the editor keeps as text (else they are uploaded byte for byte). */
export const isTextFile = (bytes) => isEditableText(bytes);

/** After a change made elsewhere (the sync event), whether an open document's file is no longer what it holds. */
export function changedElsewhere(ws, draft) {
  if (!draft || !ws.draft || draft.draftId !== ws.draft.draftId) return [];
  return ws.tabs.filter((t) => !t.saving && t.path && digestIn(draft, t.path) && digestIn(draft, t.path) !== t.saved.revision).map((t) => t.path);
}
