// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: actions on what a workspace shows
// ═══════════════════════════════════════════
//
// Customize a copy (a skill SynaBun ships, a plugin's, an account's, a runtime's own: every file of it, read where
// it is, becomes a new skill of the library under a name of the owner's, with only its `name` key changed), add an
// owner's folder to the library, delete an agent, a command or a folder of the owner's (asked, with what is unsaved
// in it named), take a library skill out of the library (never one that is installed somewhere), and export. A copy
// never drops a file it could not read: it says so and makes nothing.

import { studioErrorText } from './sx-errors.js';
import { createFrontmatter } from '../ss-frontmatter.js';
import { checkName } from './sx-create.js';
import { adoptWorkspace, dirtyTabs, dropDraft, HEAD } from './sx-docs.js';
import { OPEN_STATES } from './sx-review.js';

const YAML_MODULE = '/vendor/yaml/yaml-2.9.1.min.js';
let _fm = null;
const frontmatter = async () => (_fm ||= createFrontmatter(await import(YAML_MODULE)));

/** Every file of a workspace's skill as `{ path, content | contentBase64, executable }`, or a reason it cannot be read whole. */
async function readAllFiles(ctx, ws) {
  const s = ws.subject;
  const out = [];
  if (s.readsFiles === 'library' && ws.revision) {
    for (const f of ws.revision.manifest?.files || []) {
      const got = await ctx.api.fetchSkillsRevisionFile(ws.revision.revisionId, f.path);
      out.push({ path: f.path, ...(typeof got.contentBase64 === 'string' ? { contentBase64: got.contentBase64 } : { content: got.content ?? '' }), executable: f.mode === '0755' });
    }
    return { files: out };
  }
  const paths = (ws.files || []).map((f) => f.path).filter((p) => typeof p === 'string');
  for (const path of paths) {
    if (s.v1Id) {
      const got = path === HEAD ? await ctx.api.fetchSkillsArtifact(s.v1Id) : await ctx.api.fetchSkillsSubFile(s.v1Id, path);
      if (!got.binary) { out.push({ path, content: path === HEAD ? (got.rawContent ?? '') : (got.content ?? '') }); continue; }
      if (!ctx.caps.has('catalog-file') || path === HEAD) return { reason: 'binary' };
    }
    if (path === HEAD && !s.v1Id) {
      const entry = ws.entry || (await ctx.api.fetchSkillsCatalogEntry(ws.row.primary.id)).entry;
      if (typeof entry.text !== 'string') return { reason: 'unreadable' };
      out.push({ path, content: entry.text });
      continue;
    }
    if (!ctx.caps.has('catalog-file')) return { reason: 'restart' };
    const got = await ctx.api.fetchSkillsCatalogFile(ws.row.primary.id, path);
    out.push({ path, ...(got.binary ? { contentBase64: got.contentBase64 } : { content: got.content ?? '' }) });
  }
  if (ws.filesTruncated) return { reason: 'truncated' };
  return { files: out };
}

/** Make the owner's own copy of a skill in the library and open it. */
export async function customizeCopy(ctx, ws) {
  const { t } = ctx;
  if (ws.kind !== 'skill') return;
  const shipped = ctx.rows.filter((r) => r.source === 'synabun').map((r) => r.folderName);
  const taken = ctx.rows.filter((r) => r.kind === 'skill').map((r) => r.folderName);
  const box = document.createElement('div');
  box.className = 'sx-dlg-form';
  const label = document.createElement('label');
  label.className = 'sx-field-label';
  label.htmlFor = 'sx-copy-name';
  label.textContent = t('skillsStudio.customize.nameLabel');
  const input = document.createElement('input');
  input.id = 'sx-copy-name';
  input.className = 'sx-input';
  input.value = `${ws.row.folderName || ws.label}-custom`.slice(0, 64);
  input.autocomplete = 'off';
  input.spellcheck = false;
  const err = document.createElement('p');
  err.className = 'ss-dlg-error';
  err.setAttribute('role', 'alert');
  box.append(label, input, err);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  let name = null;
  const answer = await ctx.ask({
    title: t('skillsStudio.customize.title', { name: ws.label }),
    lines: [t('skillsStudio.customize.explain')],
    extra: box,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'copy', label: t('skillsStudio.customize.confirm'), kind: 'primary' }],
    accept: (id) => {
      if (id !== 'copy') return true;
      const check = checkName(input.value.trim(), { shipped, taken: [] });
      if (!check.ok) { err.textContent = t(`skillsStudio.create.name.${check.errors[0]}`); return false; }
      name = input.value.trim();
      return true;
    },
  });
  if (answer !== 'copy' || !name) return;
  const gen = ctx.gen();
  try {
    const read = await readAllFiles(ctx, ws);
    if (!ctx.alive(gen)) return;
    if (!read.files) { ctx.toast(t(`skillsStudio.customize.cannot.${read.reason}`), 'error'); return; }
    const fm = await frontmatter();
    const head = read.files.find((f) => f.path === HEAD);
    if (!head || typeof head.content !== 'string') { ctx.toast(t('skillsStudio.customize.cannot.binary'), 'error'); return; }
    const patched = fm.patch(head.content, { name });
    if (!patched.ok) { ctx.toast(t('skillsStudio.customize.cannot.yaml'), 'error'); return; }
    head.content = patched.text;
    const res = await ctx.api.createLibrarySkill({ name, files: read.files }, { idempotencyKey: ctx.key('customize') });
    if (!ctx.alive(gen)) return;
    ctx.toast(t('skillsStudio.customize.done', { name }));
    await ctx.reload();
    if (!ctx.alive(gen)) return;
    await ctx.openRow(`lib:${res.skillId}`, { tab: 'edit' });
    if (taken.includes(name)) ctx.toast(t('skillsStudio.customize.nameInUse', { name }));
  } catch (e) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.customize.failed', { error: studioErrorText(ctx.t, e) }), 'error'); }
}

/** Take an owner's folder into the library (Versions and Publish then work for it). */
export async function adoptNow(ctx, ws) {
  const { t } = ctx;
  const gen = ctx.gen();
  try {
    await adoptWorkspace(ws, ctx.api, { key: ctx.key });
    if (!ctx.alive(gen)) return;
    ctx.toast(t('skillsStudio.toast.adopted', { name: ws.label }));
    await ctx.reload();
  } catch (e) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.toast.adoptFailed', { error: studioErrorText(ctx.t, e) }), 'error'); }
}

/** Delete an agent, a command or a skill folder of the owner's, where it is (asked first, Cancel first). */
export async function deleteSubject(ctx, ws) {
  const { t, tp } = ctx;
  const s = ws.subject;
  if (!s.v1Id || (s.mode !== 'inplace' && s.mode !== 'adopt')) return;
  const unsaved = dirtyTabs(ws);
  const answer = await ctx.ask({
    title: t('skillsStudio.ws.deleteTitle', { name: ws.label }),
    lines: [t(ws.kind === 'skill' ? 'skillsStudio.ws.deleteSkill' : 'skillsStudio.ws.deleteFile', { path: ws.row.path || '' }),
      ...(unsaved.length ? [tp('skillsStudio.ws.deleteUnsaved', unsaved.length), ...unsaved.slice(0, 6).map((tab) => `• ${tab.label}`)] : [])],
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'delete', label: unsaved.length ? t('skillsStudio.ws.deleteAndDiscard') : t('skillsStudio.ws.delete'), kind: 'danger' }],
    focus: 'cancel',
  });
  if (answer !== 'delete') return;
  const gen = ctx.gen();
  try {
    await ctx.api.deleteSkillsArtifact(s.v1Id);
    if (!ctx.alive(gen)) return;
    for (const tab of ws.tabs) dropDraft(ws, tab);   // "Delete and discard": this browser's copies go too
    ctx.toast(t('skillsStudio.toast.deleted', { name: ws.label }));
    ctx.closeWorkspace(ws);
    await ctx.reload();
  } catch (e) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.toast.deleteFailed', { error: studioErrorText(ctx.t, e) }), 'error'); }
}

/** Whether a workspace's skill can be taken out of the library from here (a library skill, not SynaBun's). */
export const canDeleteFromLibrary = (ctx, ws) => !ctx.guest && ws.subject.mode === 'library' && !!ws.skill?.skillId && ws.skill?.origin?.kind !== 'bundled';

/**
 * Take a library skill out of the library (asked first, Cancel first). What it is now is read again first: one that is
 * installed somewhere is not deleted (its installations are removed in Publish first, each with its backup: the
 * question offers to go there); otherwise its draft and versions leave the library (kept in its archive), a folder it
 * came from stays as it is, and its open reviews are closed. A server older than the page cannot do it: said so.
 */
export async function deleteFromLibrary(ctx, ws) {
  const { t, tp } = ctx;
  if (!canDeleteFromLibrary(ctx, ws)) return;
  if (!ctx.caps.has('library-delete')) { ctx.toast(t('skillsStudio.ws.libraryDeleteRestart'), 'error'); return; }
  const gen = ctx.gen();
  let skill;
  try { skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill; } catch (e) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.toast.deleteFailed', { error: studioErrorText(ctx.t, e) }), 'error'); return; }
  if (!ctx.alive(gen)) return;
  const installs = skill.installations || [];
  if (installs.length) {
    const where = installs.slice(0, 6).map((i) => `• ${t(`skillsStudio.runtime.${['claude', 'codex', 'opencode', 'agents'].includes(i.runtime) ? i.runtime : 'claude'}`)} · ${i.destination || ''}`);
    const answer = await ctx.ask({
      title: t('skillsStudio.ws.libraryDeleteInstalledTitle', { name: ws.label }),
      lines: [tp('skillsStudio.ws.libraryDeleteInstalled', installs.length), ...where],
      buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'publish', label: t('skillsStudio.ws.libraryDeleteOpenPublish'), kind: 'primary' }],
      focus: 'cancel',
    });
    if (answer === 'publish' && ctx.alive(gen)) { ws.tab = 'publish'; if (ws.shown) ctx.render(); }
    return;
  }
  const unsaved = dirtyTabs(ws);
  const reviews = (ctx.data?.reviews || []).filter((r) => r.skillId === skill.skillId && OPEN_STATES.includes(r.state));
  // An adopted skill's row is the folder it came from: that folder is not the library's, and stays.
  const folder = ws.row.source !== 'library' && ws.row.path ? ws.row.path : null;
  const answer = await ctx.ask({
    title: t('skillsStudio.ws.libraryDeleteTitle', { name: ws.label }),
    lines: [t('skillsStudio.ws.libraryDeleteBody'),
      ...(folder ? [t('skillsStudio.ws.libraryDeleteFolderStays', { path: folder })] : []),
      ...(reviews.length ? [tp('skillsStudio.ws.libraryDeleteReviews', reviews.length)] : []),
      ...(unsaved.length ? [tp('skillsStudio.ws.deleteUnsaved', unsaved.length), ...unsaved.slice(0, 6).map((tab) => `• ${tab.label}`)] : [])],
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'delete', label: unsaved.length ? t('skillsStudio.ws.deleteAndDiscard') : t('skillsStudio.ws.libraryDelete'), kind: 'danger' }],
    focus: 'cancel',
  });
  if (answer !== 'delete') return;
  try {
    // The record the owner was shown: one changed since (another window, the Assistant) is not deleted unseen.
    await ctx.api.deleteLibrarySkill(skill.skillId, { expectedEtag: Number.isInteger(skill.etag) ? skill.etag : null });
    if (!ctx.alive(gen)) return;
    for (const tab of ws.tabs) dropDraft(ws, tab);
    ctx.toast(t('skillsStudio.toast.libraryDeleted', { name: ws.label }));
    ctx.closeWorkspace(ws);
    await ctx.reload();
  } catch (e) {
    if (!ctx.alive(gen)) return;
    const words = e?.code === 'skill_installed' ? t('skillsStudio.toast.libraryDeleteInstalled', { name: ws.label })
      : e?.code === 'skill_conflict' ? t('skillsStudio.toast.libraryDeleteChanged', { name: ws.label })
      : t('skillsStudio.toast.deleteFailed', { error: studioErrorText(ctx.t, e) });
    ctx.toast(words, 'error');
  }
}

/** Download what a workspace shows: its latest version as a bundle, else the P0 export of where it is. */
export function exportSubject(ctx, ws) {
  const revisionId = ws.row.source === 'synabun' ? ws.skill?.pointers?.upstream : ws.skill?.pointers?.latest;
  const url = revisionId && ctx.caps.has('export') ? ctx.api.getSkillsRevisionExportUrl(revisionId, { format: 'bundle' })
    : ws.subject.v1Id ? ctx.api.getSkillsExportUrl(ws.subject.v1Id) : null;
  if (!url) { ctx.toast(ctx.t('skillsStudio.toast.exportUnavailable'), 'error'); return; }
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
