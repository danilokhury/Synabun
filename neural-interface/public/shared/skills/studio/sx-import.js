// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: importing a bundle
// ═══════════════════════════════════════════
//
// A bundle is checked and staged by the server first, outside every folder a runtime reads skills from (nothing of
// it runs or loads there), and scanned. The owner sees what it is and what it can do, then installs exactly those
// bytes (the staged digest), or discards it. The scope is the one they pick: global, or a project they choose;
// never a default. Files already there are replaced only when the owner ticks the box (a backup is kept). A file
// is picked in the click that asked for it (the browser's rule); what the server can do is asked once it is chosen.

import { dropdownHTML, wireDropdowns } from '../../cc-dropdown.js';
import { revealHidden } from '../ss-unicode.js';
import { decodeArtifactId } from '../ss-ids.js';

const SEVERITY_MARK = { critical: '⛔', high: '✕', medium: '⚠', low: '•', info: '•' };
const MAX_BUNDLE_BYTES = 24 * 1024 * 1024;

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

/**
 * Pick a bundle and import it.
 * @param {object} ctx the Studio's context
 * @param {() => Promise<Set<string>>} capabilities what the server can do, once known
 */
export function triggerImport(ctx, capabilities) {
  if (ctx.guest) { ctx.toast(ctx.t('skillsStudio.import.guest'), 'error'); return; }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = BUNDLE_ACCEPT;
  input.addEventListener('change', () => { const file = input.files?.[0]; if (file) importFile(ctx, file, capabilities); });
  input.click();
}

/** The file types the picker offers. */
export const BUNDLE_ACCEPT = '.json,.skill.json,.command.json,.agent.json';

/** A bundle file someone picked (here, or from the menu before the Studio was loaded): read, checked, imported. */
export async function importFile(ctx, file, capabilities) {
  const { t } = ctx;
  if (ctx.guest) { ctx.toast(t('skillsStudio.import.guest'), 'error'); return; }
  try { await capabilities(); } catch { ctx.toast(t('skillsStudio.import.serverUnknown'), 'error'); return; }
  if (file.size > MAX_BUNDLE_BYTES) { ctx.toast(t('skillsStudio.import.tooLarge'), 'error'); return; }
  let bundle;
  try { bundle = JSON.parse(await file.text()); } catch { ctx.toast(t('skillsStudio.import.notJson'), 'error'); return; }
  if (!bundle || bundle.format !== 'synabun-skill-bundle') { ctx.toast(t('skillsStudio.import.notBundle'), 'error'); return; }
  if (ctx.panel?.isConnected) await runImport(ctx, bundle, file.name);
}

function scopePicker(ctx, prefix) {
  const { t } = ctx;
  const projects = [{ value: '', label: t('skillsStudio.import.chooseProject'), disabled: true, selected: true }, ...ctx.projects.map((p) => ({ value: p.path, label: p.label }))];
  const wrap = el('div', 'sx-dlg-form');
  const group = el('div', 'sx-choices');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', t('skillsStudio.import.where'));
  for (const [value, words] of [['global', t('skillsStudio.import.scopeGlobal')], ['project', t('skillsStudio.import.scopeProject')]]) {
    const label = el('label', 'sx-choice');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = `${prefix}-scope`;
    radio.value = value;
    if (value === 'global') radio.checked = true;
    if (value === 'project' && !ctx.projects.length) radio.disabled = true;
    label.append(radio, document.createTextNode(` ${words}`));
    group.append(label);
  }
  const field = el('div', 'sx-field');
  field.hidden = true;
  field.id = `${prefix}-project-field`;
  const fieldLabel = el('span', 'sx-field-label', t('skillsStudio.import.project'));
  fieldLabel.id = `${prefix}-project-label`;
  const dd = el('div');
  dd.innerHTML = dropdownHTML(`${prefix}-project`, projects, { labelledBy: `${prefix}-project-label` });
  field.append(fieldLabel, ...dd.childNodes);
  const error = el('p', 'ss-dlg-error');
  error.id = `${prefix}-error`;
  error.setAttribute('role', 'alert');
  wrap.append(group, field, error);
  return wrap;
}

/** Where it goes, staged and scanned, the owner's review, then exactly those bytes installed (or nothing). */
export async function runImport(ctx, bundle, fileName) {
  const { t, tp, api } = ctx;
  const type = ['skill', 'command', 'agent'].includes(bundle.type) ? bundle.type : 'skill';
  const files = bundle.files && typeof bundle.files === 'object' ? Object.keys(bundle.files).length : 0;
  // 1. Where it goes.
  const life = new AbortController();
  const extra = scopePicker(ctx, 'ss-imp');
  wireDropdowns(extra, { signal: life.signal });
  extra.addEventListener('change', (e) => { if (e.target.name === 'ss-imp-scope') extra.querySelector('#ss-imp-project-field').hidden = e.target.value !== 'project'; }, { signal: life.signal });
  let place = null;
  const where = await ctx.ask({
    title: t('skillsStudio.import.title', { kind: t(`skillsStudio.kind.${type}`), name: revealHidden(String(bundle.name ?? '')) }),
    lines: [tp('skillsStudio.import.intro', files, { file: fileName })],
    extra,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'check', label: t('skillsStudio.import.check'), kind: 'primary' }],
    accept: () => {
      const scope = extra.querySelector('input[name="ss-imp-scope"]:checked')?.value || 'global';
      const projectPath = scope === 'project' ? (extra.querySelector('#ss-imp-project')?.value || '') : '';
      const error = scope === 'project' && !projectPath ? t('skillsStudio.import.chooseProjectError') : '';
      extra.querySelector('#ss-imp-error').textContent = error;
      if (error) return false;
      place = { scope, projectPath };
      return true;
    },
  });
  life.abort();
  if (where !== 'check' || !place || !ctx.panel?.isConnected) return;

  // 2. Staged and scanned by the server.
  let staged;
  try {
    staged = (await api.stageSkillsImport(bundle, place.scope, place.projectPath)).staged;
  } catch (err) {
    const problems = Array.isArray(err?.body?.problems) ? err.body.problems : [];
    if (problems.length && ctx.panel?.isConnected) {
      await ctx.ask({
        title: t('skillsStudio.import.refusedTitle'),
        lines: [t('skillsStudio.import.refusedIntro'), ...problems.slice(0, 12).map((p) => `• ${p.path ? `${revealHidden(p.path)}: ` : ''}${p.message}`), problems.length > 12 ? `• ${t('skillsStudio.dialog.andMore', { count: problems.length - 12 })}` : ''],
        buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.close'), kind: 'primary' }],
      });
    } else ctx.toast(t('skillsStudio.import.failed', { error: err.message }), 'error');
    return;
  }
  if (!ctx.panel?.isConnected) { api.discardSkillsImport(staged.stagingId).catch(() => {}); return; }

  // 3. The review: what it is, what it can do, what it would replace.
  const review = buildImportReview(ctx, staged);
  const lintErrors = staged.lint?.errors || 0;
  const skillExists = staged.type === 'skill' && staged.collisions?.length > 0;
  const blocked = staged.scan?.gate === 'blocked';
  const answer = await ctx.ask({
    wide: true,
    title: t('skillsStudio.import.reviewTitle', { name: revealHidden(staged.name) }),
    lines: [],
    extra: review,
    buttons: [{ id: 'discard', label: t('skillsStudio.import.discard'), kind: 'danger' }, { id: 'install', label: t('skillsStudio.import.install'), kind: 'primary', disabled: !!(lintErrors || skillExists || blocked) }],
    focus: 'discard',
    cancelId: 'discard',
    accept: (choice) => {
      if (choice !== 'install') return true;
      const ack = review.querySelector('#ss-imp-ack');
      const over = review.querySelector('#ss-imp-overwrite');
      const error = ack && !ack.checked ? t('skillsStudio.import.confirmReviewed') : over && !over.checked ? t('skillsStudio.import.confirmReplace') : '';
      const line = review.querySelector('#ss-imp-review-error');
      if (line) line.textContent = error;
      return !error;
    },
  });
  if (answer !== 'install') { api.discardSkillsImport(staged.stagingId).catch(() => {}); return; }

  // 4. Installed: exactly the staged bytes, or nothing.
  try {
    const res = await api.commitSkillsImport({
      stagingId: staged.stagingId, expectedDigest: staged.digest,
      acknowledgedDigest: staged.scan?.gate === 'review' ? staged.digest : undefined,
      overwrite: !!review.querySelector('#ss-imp-overwrite')?.checked,
    });
    ctx.toast(t('skillsStudio.import.done', { name: res.name }));
    await ctx.reload();
    const id = decodeArtifactId(res.id);
    const path = id.slice(id.indexOf(':') + 1);
    const row = ctx.rows.find((r) => r.entries.some((e) => e.path === path));
    if (row && ctx.panel?.isConnected) ctx.openRow(row.key, { tab: 'edit' });
  } catch (err) {
    ctx.toast(t('skillsStudio.import.failed', { error: err.message }), 'error');
  }
}

/** The review of a staged import, built as text nodes: nothing of the bundle is ever markup here. */
export function buildImportReview(ctx, staged) {
  const { t, tp } = ctx;
  const root = el('div', 'ss-review');
  const row = (label, value, mono = false) => {
    const r = el('div', 'ss-review-row');
    r.append(el('span', 'ss-review-label', label), el(mono ? 'code' : 'span', 'ss-review-value', value));
    root.append(r);
  };
  const size = (staged.files || []).reduce((n, f) => n + (Number(f.size) || 0), 0);
  row(t('skillsStudio.import.goesTo'), staged.destination, true);
  row(t('skillsStudio.import.files'), tp('skillsStudio.import.fileCount', staged.files?.length || 0, { size: size > 1024 ? `${Math.round(size / 1024)} KB` : `${size} B` }));
  row(t('skillsStudio.import.digest'), staged.digest ? `${staged.digest.slice(0, 19)}…${staged.digest.slice(-6)}` : '', true);
  const fileList = el('details', 'ss-review-files');
  fileList.append(el('summary', '', t('skillsStudio.import.showFiles')));
  const ul = el('ul');
  for (const f of staged.files || []) ul.append(el('li', '', `${revealHidden(f.path)}${f.executable ? ` (${t('skillsStudio.import.executable')})` : ''}`));
  for (const x of staged.excluded || []) ul.append(el('li', 'ss-review-muted', t('skillsStudio.import.leftOut', { path: revealHidden(x.path), reason: x.reason })));
  fileList.append(ul);
  root.append(fileList);

  if (staged.type === 'skill' && staged.collisions?.length) root.append(el('p', 'ss-review-warn', t('skillsStudio.import.skillExists', { name: staged.name })));
  if (staged.type !== 'skill' && staged.collisions?.length) {
    const label = el('label', 'ss-review-check');
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'ss-imp-overwrite';
    label.append(box, document.createTextNode(` ${tp('skillsStudio.import.replaceBox', staged.collisions.length, { files: staged.collisions.join(', ') })}`));
    root.append(label);
  }

  // Checks of the head file
  const lint = staged.lint || { diagnostics: [] };
  const shownLint = (lint.diagnostics || []).filter((d) => d.severity !== 'info');
  const checks = el('div', 'ss-review-section');
  checks.append(el('div', 'ss-review-head', shownLint.length ? t('skillsStudio.import.checks', { errors: lint.errors || 0, warnings: lint.warnings || 0 }) : t('skillsStudio.import.checksOk')));
  if (shownLint.length) {
    const list = el('ul', 'ss-review-list');
    for (const d of shownLint.slice(0, 20)) list.append(el('li', `ss-review-item ss-review-item--${d.severity === 'error' ? 'high' : 'medium'}`, `${d.message}${d.line ? ` (${t('skillsStudio.edit.line', { line: d.line })})` : ''}`));
    checks.append(list);
  }
  if (lint.errors) checks.append(el('p', 'ss-review-warn', t('skillsStudio.import.blockedByProblems')));
  root.append(checks);

  // What it can do
  const scan = staged.scan || {};
  const auth = scan.authority || {};
  const section = el('div', 'ss-review-section');
  const found = scan.findings?.length || 0;
  const status = scan.status === 'no_findings' ? t('skillsStudio.import.scanClean')
    : scan.status === 'error' ? t('skillsStudio.import.scanError', { error: scan.error || 'error' })
    : scan.status === 'incomplete' ? tp('skillsStudio.import.scanIncomplete', found)
    : tp('skillsStudio.import.scanFindings', found);
  section.append(el('div', 'ss-review-head', `${t('skillsStudio.import.canDo')} ${status}${scan.gate === 'blocked' ? ` (${t('skillsStudio.import.gateBlocked')})` : scan.gate === 'review' ? ` (${t('skillsStudio.import.gateReview')})` : ''}`));
  const facts = [];
  if (auth.dynamicContext?.length) facts.push(tp('skillsStudio.import.fact.dynamic', auth.dynamicContext.length));
  if (auth.hooks?.length) facts.push(t('skillsStudio.import.fact.hooks', { events: auth.hooks.map((h) => h.event).join(', ') }));
  if (auth.toolGrants?.length) facts.push(t('skillsStudio.import.fact.tools', { tools: auth.toolGrants.map((g) => g.tool).join(', ') }));
  if (auth.scripts?.length) facts.push(tp('skillsStudio.import.fact.scripts', auth.scripts.length));
  if (auth.binaries?.length) facts.push(tp('skillsStudio.import.fact.binaries', auth.binaries.length));
  if (auth.domains?.length) facts.push(t('skillsStudio.import.fact.domains', { domains: auth.domains.slice(0, 6).join(', ') + (auth.domains.length > 6 ? ` +${auth.domains.length - 6}` : '') }));
  if (facts.length) { const ul2 = el('ul', 'ss-review-facts'); for (const f of facts) ul2.append(el('li', '', f)); section.append(ul2); }
  if (scan.findings?.length) {
    const list = el('ul', 'ss-review-list');
    for (const f of scan.findings.slice(0, 30)) {
      const li = el('li', `ss-review-item ss-review-item--${f.severity}`);
      li.append(el('span', 'ss-review-sev', `${SEVERITY_MARK[f.severity] || '•'} ${t(`skillsStudio.review.severity.${['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low'}`)}`), el('span', '', ` ${f.message}`));
      if (f.file) li.append(el('span', 'ss-review-where', ` ${revealHidden(f.file)}${f.line ? `:${f.line}` : ''}`));
      if (f.evidence) li.append(el('code', 'ss-review-evidence', f.evidence));
      list.append(li);
    }
    if (scan.findings.length > 30) list.append(el('li', 'ss-review-muted', t('skillsStudio.dialog.andMore', { count: scan.findings.length - 30 })));
    section.append(list);
  }
  if (scan.disclosure) section.append(el('p', 'ss-review-muted', scan.disclosure));
  root.append(section);

  if (scan.gate === 'review') {
    const label = el('label', 'ss-review-check');
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'ss-imp-ack';
    label.append(box, document.createTextNode(` ${t('skillsStudio.import.reviewedBox')}`));
    root.append(label);
  }
  const err = el('p', 'ss-dlg-error', '');
  err.id = 'ss-imp-review-error';
  err.setAttribute('role', 'alert');
  root.append(err);
  return root;
}
