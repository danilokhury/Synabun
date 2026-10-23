// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Publish tab
// ═══════════════════════════════════════════
//
// One place to install a skill: which version, into which runtimes and scopes (each runtime's own folder per
// account, the shared ~/.agents/skills while it is turned on, a project's folders), what each holds now, then the
// service's plan (where it goes, who reads that folder, what is there, the checks of exactly the exported bytes,
// what blocks it, what needs the owner's confirmation, how a running session picks it up), and an install of exactly
// that plan with only what the owner confirmed. The outcome is per target, never one word for all. An installation
// is verified (written, discoverable, enabled; asked of the runtime when it can answer), rolled back to what it
// replaced, or removed; each keeps a backup. Exports: a SynaBun bundle, a .skill archive, the Claude.ai upload.
// Settings → Skills shows the same installs (its chips go through the same plans).
//
// A plan is shown and installed only for exactly what it was asked for (sx-subject.js sameAsk): another version
// picked, or a target ticked, drops it, and an answer that comes back for a selection that changed meanwhile is not
// used. While a plan or an install is on its way the targets and the version are locked. Each drawing of the tab
// listens once: the listeners of the drawing before end with it.

import { dropdownHTML, wireDropdowns } from '../../cc-dropdown.js';
import { html, raw, setHTML, ICONS, relativeTime } from './sx-dom.js';
import { installTargets, targetState, defaultTargets, wholeTarget, targetKey, sameAsk } from './sx-subject.js';
import { planModel, decisionsOf, installableRows, resultModel, verifyFacts, needsConfirmation, newPublishState, clearPlan, choosePublishRevision } from './sx-plan.js';
import { changedFiles } from './sx-diff.js';
import { dirtyTabs, saveVersion } from './sx-docs.js';
import { shortDigest } from './sx-editor-model.js';
import { adoptNow, customizeCopy } from './sx-actions.js';

let _life = null;   // the tab's listeners: they end when the tab is drawn again
let _draw = null;   // the listeners of the tab's last drawing: they end with the next drawing

/** The signal of one drawing: it ends with the next drawing, and with the tab. */
function drawSignal(life) {
  _draw?.abort();
  const ctrl = new AbortController();
  _draw = ctrl;
  if (life.aborted) ctrl.abort();
  else life.addEventListener('abort', () => ctrl.abort(), { once: true, signal: ctrl.signal });
  return ctrl.signal;
}

function targetLabel(t, target) {
  const runtime = t(`skillsStudio.runtime.${target.runtime}`);
  if (target.scope === 'project') return t('skillsStudio.publish.targetProject', { runtime, project: target.projectLabel || target.projectPath });
  if (target.accountId && target.accountId !== 'default') return t('skillsStudio.publish.targetAccount', { runtime, account: target.accountId });
  return t('skillsStudio.publish.targetUser', { runtime });
}

function stateHTML(t, st, target) {
  if (target.off) return html`<span class="sx-state-chip sx-state-chip--off">${t('skillsStudio.publish.state.off')}</span>`;
  return html`<span class="sx-state-chip sx-state-chip--${st.state}">${t(`skillsStudio.publish.state.${st.state}`)}</span>`;
}

/** Which revision Publish shows: the one asked for (a review, Versions), else SynaBun's for a shipped skill, else the latest. */
function chosenRevision(ws) {
  if (ws.publishRevisionId) return ws.publishRevisionId;
  if (ws.row.source === 'synabun') return ws.skill?.pointers?.upstream || ws.skill?.pointers?.approved || ws.skill?.pointers?.latest || null;
  return ws.skill?.pointers?.latest || null;
}

/** Draw the Publish tab. */
export function renderPublishTab(panel, ctx, ws) {
  const { t } = ctx;
  _life?.abort();
  _life = new AbortController();
  const signal = _life.signal;
  const s = ws.subject;
  if (!ws.skill || (s.mode !== 'library' && !(s.mode === 'readonly' && s.canPublish))) {
    const why = s.mode === 'adopt' ? 'adopt' : s.mode === 'inplace' ? 'inplace' : 'readonly';
    setHTML(panel, html`<div class="sx-empty"><span class="sx-placeholder-icon" aria-hidden="true">${ICONS.publish}</span>
      <h4 class="sx-empty-title">${t('skillsStudio.publish.noneTitle')}</h4><p>${t(`skillsStudio.publish.none.${why}`)}</p>
      <div class="sx-row">${why === 'adopt' && !ctx.guest ? html`<button type="button" class="sx-btn sx-btn--primary" data-pub="adopt">${t('skillsStudio.ws.adoptNow')}</button>` : ''}
      ${why === 'readonly' && s.canCustomize ? html`<button type="button" class="sx-btn" data-pub="customize">${t('skillsStudio.ws.customize')}</button>` : ''}
      ${s.v1Id ? html`<a class="sx-btn" href="${ctx.api.getSkillsExportUrl(s.v1Id)}" download="">${ICONS.download}<span>${t('skillsStudio.publish.exportBundle')}</span></a>` : ''}</div></div>`);
    panel.querySelector('[data-pub="adopt"]')?.addEventListener('click', () => adoptNow(ctx, ws), { signal });
    panel.querySelector('[data-pub="customize"]')?.addEventListener('click', () => customizeCopy(ctx, ws), { signal });
    return;
  }
  if (!ws.pub) ws.pub = newPublishState();
  // What is read lands in this Publish state only: one that started over meanwhile (a version or a review opened
  // Publish again) is drawn by its own reading.
  const pub = ws.pub;
  const gen = ctx.gen();
  const needRevisions = !ws.revisions;
  setHTML(panel, html`<div class="sx-publish"><p class="sx-help" role="status">${t('skillsStudio.publish.loading')}</p></div>`);
  Promise.all([
    needRevisions ? ctx.api.fetchSkillRevisions(ws.skill.skillId).then((r) => { ws.revisions = (r.revisions || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }) : null,
    ctx.api.fetchSkill(ws.skill.skillId).then((r) => { ws.skill = r.skill; }),
    ctx.api.fetchSkillsConfig().then((r) => r.config || {}, () => ({ sharedAgentsRoot: false })).then((config) => { pub.config = config; }),
  ]).then(() => {
    if (!ctx.alive(gen) || !ws.shown || ws.tab !== 'publish' || ws.pub !== pub) return;
    draw(panel, ctx, ws, signal);
  }).catch((err) => {
    if (!ctx.alive(gen) || ws.tab !== 'publish' || ws.pub !== pub) return;
    setHTML(panel, html`<div class="sx-empty" role="alert"><p>${t('skillsStudio.publish.loadFailed', { error: err.message })}</p></div>`);
  });
}

function targetsOf(ctx, ws) {
  return installTargets({ roots: ctx.data?.catalog?.roots || [], config: ws.pub.config || {}, projects: ctx.projects.filter((p) => ws.pub.projects.includes(p.path)) });
}

/** What Publish shows now: the version and the targets ticked (as a request names them). */
function askNow(ctx, ws) {
  const checked = ws.pub?.checked || new Set();
  return { revisionId: chosenRevision(ws), targets: targetsOf(ctx, ws).filter((tg) => checked.has(tg.key) && !tg.off).map((tg) => wholeTarget(tg.target)) };
}

/** The plan Publish holds, as what it was asked for. */
const planAsk = (pub) => ({ revisionId: pub.planRevision, targets: pub.planTargets });

function draw(panel, ctx, ws, life) {
  const { t, tp, locale } = ctx;
  const signal = drawSignal(life);
  const pub = ws.pub;
  const revisionId = chosenRevision(ws);
  // Installing what Review approved: the targets the submission named are the ones ticked (its projects shown).
  const review = !pub.checked && ws.publishReviewId ? (ctx.data?.reviews || []).find((r) => r.reviewId === ws.publishReviewId) : null;
  const named = Array.isArray(review?.targets) ? review.targets.filter((x) => x && typeof x.runtime === 'string') : [];
  for (const x of named) {
    if (x.scope === 'project' && x.projectPath && !pub.projects.includes(x.projectPath) && ctx.projects.some((p) => p.path === x.projectPath)) pub.projects.push(x.projectPath);
  }
  const targets = targetsOf(ctx, ws);
  if (!pub.checked) {
    const keys = new Set(named.map((x) => targetKey(x)));
    const fromReview = targets.filter((x) => !x.off && keys.has(x.key)).map((x) => x.key);
    pub.checked = fromReview.length ? new Set(fromReview) : defaultTargets(targets, { skill: ws.skill, row: ws.row });
    // An update applied from Review or a banner picks what it replaces (sx-review.js updateTargetKeys).
    if (typeof ws.pubPresetApply === 'function') { ws.pubPresetApply(pub, targets); ws.pubPresetApply = null; }
  }
  // A plan for another version or other targets than those on screen is neither shown nor installed.
  if (pub.plan && !sameAsk(planAsk(pub), askNow(ctx, ws))) clearPlan(pub);
  // While a plan or an install is on its way, what it was asked for stays as it is.
  const locked = !!pub.busy;
  const draftChanges = ws.draft && ws.revision ? changedFiles(ws.revision.manifest?.files || [], ws.draft.files || []) : [];
  const revisions = ws.revisions || [];
  const revEntries = revisions.map((r) => ({ value: r.revisionId, label: `${t('skillsStudio.versions.rev', { id: shortDigest(r.contentDigest) })}${(r.labels || []).length ? ` · ${(r.labels || []).filter((l) => ['latest', 'approved', 'upstream', 'candidate', 'best'].includes(l)).map((l) => t(`skillsStudio.versions.label.${l}`)).join(', ')}` : ''}`, selected: r.revisionId === revisionId }));
  const rev = revisions.find((r) => r.revisionId === revisionId) || null;
  const otherProjects = ctx.projects.filter((p) => !pub.projects.includes(p.path));
  const owner = !ctx.guest;
  setHTML(panel, html`<div class="sx-publish">
    <section class="sx-pub-section" aria-labelledby="sx-pub-what">
      <h4 class="sx-section-title" id="sx-pub-what">${t('skillsStudio.publish.whatTitle')}</h4>
      ${revisions.length ? html`<div class="sx-row"><span class="sx-filter-key" id="sx-pub-rev-label">${t('skillsStudio.publish.version')}</span>${raw(dropdownHTML('sx-pub-rev', revEntries, { labelledBy: 'sx-pub-rev-label', classes: 'sx-dd', disabled: locked }))}
        ${rev ? html`<span class="sx-dim">${t('skillsStudio.publish.versionMeta', { when: relativeTime(rev.createdAt, locale) })}</span>` : ''}</div>` : html`<p class="sx-note" role="note">${t('skillsStudio.publish.noVersion')}</p>`}
      ${draftChanges.length && ws.subject.mode === 'library' ? html`<p class="sx-note" role="note">${tp('skillsStudio.publish.draftNotPublished', draftChanges.length)} ${owner ? html`<button type="button" class="sx-btn sx-btn--sm" data-pub="snapshot">${t('skillsStudio.publish.saveVersionAndUse')}</button>` : ''}</p>` : ''}
      ${ws.publishReviewId ? html`<p class="sx-note" role="note">${t('skillsStudio.publish.fromReview')}</p>` : ''}
    </section>
    <section class="sx-pub-section" aria-labelledby="sx-pub-where">
      <h4 class="sx-section-title" id="sx-pub-where">${t('skillsStudio.publish.whereTitle')}</h4>
      <table class="sx-grid">
        <caption class="sx-sr">${t('skillsStudio.publish.targetsCaption')}</caption>
        <thead><tr><th scope="col"><span class="sx-sr">${t('skillsStudio.publish.pick')}</span></th><th scope="col">${t('skillsStudio.publish.col.target')}</th><th scope="col">${t('skillsStudio.publish.col.folder')}</th><th scope="col">${t('skillsStudio.publish.col.now')}</th><th scope="col"><span class="sx-sr">${t('skillsStudio.publish.col.actions')}</span></th></tr></thead>
        <tbody>${targets.map((tg) => {
          const st = targetState(tg, { skill: ws.skill, row: ws.row, revisionId });
          const label = targetLabel(t, tg);
          const facts = st.installation ? pub.verify[st.installation.installationId] : null;
          return html`<tr>
            <td><input type="checkbox" class="sx-check" data-target="${tg.key}"${pub.checked.has(tg.key) ? ' checked' : ''}${tg.off || !owner || locked ? ' disabled' : ''} aria-label="${t('skillsStudio.publish.pickTarget', { target: label })}"></td>
            <td>${label}${tg.off ? html`<span class="sx-help sx-block">${t('skillsStudio.publish.sharedOff')}</span>` : ''}</td>
            <td class="sx-mono sx-path" title="${st.path || tg.path || ''}">${st.path || tg.path || ''}</td>
            <td>${stateHTML(t, st, tg)}${facts ? factsHTML(t, facts) : ''}</td>
            <td class="sx-actions-cell">${st.installation && owner ? html`
              <button type="button" class="sx-btn sx-btn--sm" data-pub="verify" data-inst="${st.installation.installationId}">${t('skillsStudio.publish.verify')}</button>
              <button type="button" class="sx-btn sx-btn--sm" data-pub="rollback" data-inst="${st.installation.installationId}">${t('skillsStudio.publish.rollback')}</button>
              <button type="button" class="sx-btn sx-btn--sm sx-btn--danger" data-pub="remove" data-inst="${st.installation.installationId}">${t('skillsStudio.publish.remove')}</button>` : st.state === 'bridge' ? html`<span class="sx-help">${t('skillsStudio.publish.bridgeHelp')}</span>` : ''}</td>
          </tr>`;
        })}</tbody>
      </table>
      ${otherProjects.length && owner ? html`<div class="sx-row"><span class="sx-filter-key" id="sx-pub-proj-label">${t('skillsStudio.publish.addProject')}</span>${raw(dropdownHTML('sx-pub-project', [{ value: '', label: t('skillsStudio.publish.chooseProject'), selected: true, disabled: true }, ...otherProjects.map((p) => ({ value: p.path, label: p.label }))], { labelledBy: 'sx-pub-proj-label', classes: 'sx-dd', disabled: locked }))}</div>` : ''}
      ${owner ? html`<div class="sx-row"><button type="button" class="sx-btn sx-btn--primary" data-pub="plan"${pub.checked.size && revisionId && !pub.busy ? '' : ' disabled'}>${t('skillsStudio.publish.showPlan')}</button>
        <span class="sx-help">${t('skillsStudio.publish.planHelp')}</span></div>` : html`<p class="sx-help">${t('skillsStudio.publish.guest')}</p>`}
    </section>
    <section class="sx-pub-section" id="sx-pub-plan" aria-live="polite">${pub.plan ? planHTML(ctx, ws) : ''}${pub.results ? resultsHTML(ctx, ws) : ''}</section>
    <section class="sx-pub-section" aria-labelledby="sx-pub-export">
      <h4 class="sx-section-title" id="sx-pub-export">${t('skillsStudio.publish.exportTitle')}</h4>
      ${exportHTML(ctx, ws, revisionId)}
    </section>
    <p class="sx-help">${t('skillsStudio.publish.settingsNote')}</p>
  </div>`);
  // This drawing's listeners: they end with the next drawing (a listener of each drawing would answer every click once
  // more: a dropdown opened and closed by one click, an action sent twice).
  wireDropdowns(panel, { signal });
  panel.querySelector('#sx-pub-rev')?.addEventListener('change', (e) => { choosePublishRevision(ws, e.target.value, { reviews: ctx.data?.reviews || [] }); draw(panel, ctx, ws, life); }, { signal });
  panel.querySelector('#sx-pub-project')?.addEventListener('change', (e) => { if (e.target.value) { pub.projects.push(e.target.value); clearPlan(pub); draw(panel, ctx, ws, life); } }, { signal });
  panel.addEventListener('change', (e) => {
    const box = e.target;
    if (box.dataset?.target) { if (pub.busy) return; if (box.checked) pub.checked.add(box.dataset.target); else pub.checked.delete(box.dataset.target); clearPlan(pub); pub.results = null; draw(panel, ctx, ws, life); panel.querySelector(`[data-target="${CSS.escape(box.dataset.target)}"]`)?.focus(); }
    if (box.dataset?.confirmReplace) { if (box.checked) pub.confirmed.replace.add(box.dataset.confirmReplace); else pub.confirmed.replace.delete(box.dataset.confirmReplace); syncInstallButton(panel, ws); }
    if (box.dataset?.confirmScan) { if (box.checked) pub.confirmed.scan.add(box.dataset.confirmScan); else pub.confirmed.scan.delete(box.dataset.confirmScan); syncInstallButton(panel, ws); }
  }, { signal });
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-pub]');
    if (!btn || btn.disabled) return;
    onAction(btn.dataset.pub, btn, panel, ctx, ws, life);
  }, { signal });
}

function factsHTML(t, f) {
  return html`<ul class="sx-facts">
    <li>${t(`skillsStudio.publish.fact.written.${f.written === 'verified' ? 'ok' : f.written === 'missing' ? 'missing' : f.written === 'changed' ? 'changed' : 'unknown'}`)}</li>
    <li>${t(`skillsStudio.publish.fact.discoverable.${f.discoverable}`)}</li>
    <li>${t(`skillsStudio.publish.fact.eligibility.${f.eligibility}`)}</li>
    ${f.discovered.map((d) => html`<li>${t(`skillsStudio.publish.fact.discovered.${d.discovered === true ? 'yes' : d.discovered === false ? 'no' : 'unknown'}`, { runtime: t(`skillsStudio.runtime.${d.runtime}`) })}</li>`)}
    ${f.checks.filter((c) => !c.ok).map((c) => html`<li class="sx-warn-text">${c.message}</li>`)}
  </ul>`;
}

function planHTML(ctx, ws) {
  const { t } = ctx;
  const model = ws.pub.plan;
  const rows = model.rows.map((row) => {
    const label = targetLabel(t, { runtime: row.runtime, scope: row.scope, accountId: row.accountId, projectPath: row.projectPath, projectLabel: ctx.projects.find((p) => p.path === row.projectPath)?.label });
    return html`<article class="sx-plan-row sx-plan-row--${row.status}">
      <header class="sx-plan-head"><span class="sx-plan-target">${label}</span><span class="sx-state-chip sx-state-chip--${row.status}">${t(`skillsStudio.publish.planStatus.${row.status}`)}</span></header>
      <ul class="sx-facts">
        ${row.destination ? html`<li>${t('skillsStudio.publish.goesTo')} <span class="sx-mono">${row.destination}</span></li>` : ''}
        ${row.affectedRuntimes.length > 1 ? html`<li>${t('skillsStudio.publish.readBy', { runtimes: row.affectedRuntimes.map((r) => t(`skillsStudio.runtime.${r}`)).join(', ') })}</li>` : ''}
        ${row.state ? html`<li>${t(`skillsStudio.publish.destState.${row.state}`)}</li>` : ''}
        ${row.blocked.map((b) => html`<li class="sx-err-text">${b.code === 'other' ? b.message : html`${t(`skillsStudio.publish.blocked.${b.code}`)} <span class="sx-dim">${b.message}</span>`}</li>`)}
        ${row.transforms.map((tr) => html`<li>${t('skillsStudio.publish.transform')} <span class="sx-dim">${tr.reason}</span></li>`)}
        ${row.overlap.map((o) => html`<li class="sx-warn-text">${o.why}</li>`)}
        ${row.lint.errors || row.lint.warnings ? html`<li>${t('skillsStudio.publish.lintCounts', { errors: row.lint.errors, warnings: row.lint.warnings })}</li>` : ''}
        ${row.scan.status ? html`<li>${t(`skillsStudio.publish.scan.${row.scan.status === 'no_findings' ? 'clean' : row.scan.status === 'error' ? 'error' : row.scan.trusted ? 'trusted' : 'findings'}`)}</li>` : ''}
        ${row.refresh.map((r) => html`<li class="sx-dim">${t(`skillsStudio.publish.refresh.${r.kind}`, { runtime: t(`skillsStudio.runtime.${r.runtime}`) })}</li>`)}
      </ul>
      ${row.replace ? html`<label class="sx-confirm"><input type="checkbox" data-confirm-replace="${row.targetKey}"${ws.pub.confirmed.replace.has(row.targetKey) ? ' checked' : ''}${ws.pub.busy ? ' disabled' : ''}> ${t(row.replace.state === 'modified' ? 'skillsStudio.publish.confirmReplaceModified' : 'skillsStudio.publish.confirmReplaceUnowned')}</label>` : ''}
      ${row.scanAck ? html`<div class="sx-scan-ack"><ul class="sx-findings">${row.scanAck.findings.map((f) => html`<li class="sx-finding sx-finding--${f.severity}"><span class="sx-finding-sev">${t(`skillsStudio.review.severity.${['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low'}`)}</span> ${f.message}${f.file ? html` <span class="sx-mono sx-dim">${f.file}${f.line ? `:${f.line}` : ''}</span>` : ''}</li>`)}</ul>
        <label class="sx-confirm"><input type="checkbox" data-confirm-scan="${row.targetKey}"${ws.pub.confirmed.scan.has(row.targetKey) ? ' checked' : ''}${ws.pub.busy ? ' disabled' : ''}> ${t('skillsStudio.publish.confirmScan')}</label></div>` : ''}
    </article>`;
  });
  const ready = installableRows(model, { replace: [...ws.pub.confirmed.replace], scan: [...ws.pub.confirmed.scan] }).length;
  return html`<h4 class="sx-section-title">${t('skillsStudio.publish.planTitle')}</h4>
    <div class="sx-plan">${rows}</div>
    <div class="sx-row"><button type="button" class="sx-btn sx-btn--primary" data-pub="install" id="sx-pub-install"${ready && !ws.pub.busy ? '' : ' disabled'}>${ctx.tp('skillsStudio.publish.install', ready)}</button>
      <span class="sx-help" id="sx-pub-install-help">${ready ? '' : t('skillsStudio.publish.nothingReady')}</span></div>`;
}

function syncInstallButton(panel, ws) {
  const btn = panel.querySelector('#sx-pub-install');
  if (!btn || !ws.pub.plan) return;
  const ready = installableRows(ws.pub.plan, { replace: [...ws.pub.confirmed.replace], scan: [...ws.pub.confirmed.scan] }).length;
  btn.disabled = !ready || ws.pub.busy;
  btn.textContent = btn.textContent.replace(/\d+/, String(ready));
}

function resultsHTML(ctx, ws) {
  const { t } = ctx;
  const rows = ws.pub.results || [];
  return html`<h4 class="sx-section-title">${t('skillsStudio.publish.resultsTitle')}</h4>
    <ul class="sx-results">${rows.map((r) => html`<li class="sx-result sx-result--${r.status}">
      <span class="sx-state-chip sx-state-chip--${r.status === 'committed' ? 'installed' : 'blocked'}">${t(`skillsStudio.publish.result.${r.status}`)}</span>
      <span class="sx-mono">${r.targetKey}</span>${r.unchanged ? html` <span class="sx-dim">${t('skillsStudio.publish.alreadyThere')}</span>` : ''}
      ${r.error ? html`<span class="sx-err-text">${r.error}</span>` : ''}
      ${r.reasons.map((x) => html`<span class="sx-dim">${x.message}</span>`)}
      ${r.status === 'committed' ? r.refresh.map((x) => html`<span class="sx-dim">${t(`skillsStudio.publish.refresh.${x.kind}`, { runtime: t(`skillsStudio.runtime.${x.runtime}`) })}</span>`) : ''}
    </li>`)}</ul>`;
}

function exportHTML(ctx, ws, revisionId) {
  const { t } = ctx;
  if (!revisionId) return html`<p class="sx-help">${t('skillsStudio.publish.exportNeedsVersion')}</p>`;
  if (!ctx.caps.has('export')) {
    return html`<p class="sx-help">${t('skillsStudio.publish.exportRestart')}</p>${ws.subject.v1Id ? html`<a class="sx-btn" href="${ctx.api.getSkillsExportUrl(ws.subject.v1Id)}" download="">${ICONS.download}<span>${t('skillsStudio.publish.exportBundle')}</span></a>` : ''}`;
  }
  const url = (o) => ctx.api.getSkillsRevisionExportUrl(revisionId, o);
  return html`<div class="sx-row">
    <a class="sx-btn" href="${url({ format: 'bundle' })}" download="">${ICONS.download}<span>${t('skillsStudio.publish.exportBundle')}</span></a>
    <a class="sx-btn" href="${url({ format: 'skill' })}" download="">${ICONS.download}<span>${t('skillsStudio.publish.exportSkill')}</span></a>
    <a class="sx-btn" href="${url({ format: 'skill', profile: 'claude-upload' })}" download="">${ICONS.download}<span>${t('skillsStudio.publish.exportClaude')}</span></a>
    ${ctx.guest ? '' : html`<button type="button" class="sx-btn sx-btn--ghost" data-pub="check-claude">${t('skillsStudio.publish.checkClaude')}</button>`}
  </div>
  <p class="sx-help">${t('skillsStudio.publish.exportHelp')}</p>
  <div id="sx-pub-claude" aria-live="polite"></div>`;
}

async function onAction(act, btn, panel, ctx, ws, life) {
  const { t, tp } = ctx;
  const pub = ws.pub;
  const gen = ctx.gen();
  // Drawn again only while this Publish is the one on screen (not after another version or review started it over),
  // in the tab as it is now: one drawn again meanwhile (the owner went to Edit and back) is the one updated.
  const redraw = () => {
    if (!ctx.alive(gen) || !ws.shown || ws.tab !== 'publish' || ws.pub !== pub) return;
    if (panel.isConnected) { draw(panel, ctx, ws, life); return; }
    const now = ctx.panel?.querySelector('#sx-tabpanel');
    if (now && _life && !_life.signal.aborted) draw(now, ctx, ws, _life.signal);
  };
  if (act === 'snapshot') {
    if (dirtyTabs(ws).length) { ctx.toast(t('skillsStudio.toast.saveFirst'), 'error'); return; }
    try {
      const out = await saveVersion(ws, ctx.api, { key: ctx.key });
      if (!ctx.alive(gen)) return;
      ws.publishRevisionId = out.revision.revisionId;
      ws.revisions = null;
      ctx.toast(out.unchanged ? t('skillsStudio.toast.versionUnchanged') : t('skillsStudio.toast.versionSaved'));
      renderPublishTab(panel, ctx, ws);
    } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.toast.versionFailed', { error: err.message }), 'error'); }
    return;
  }
  if (act === 'plan') {
    const asked = askNow(ctx, ws);
    if (!asked.revisionId || !asked.targets.length || pub.busy) return;
    pub.busy = true;
    redraw();   // the targets and the version are locked until the plan is back
    try {
      const res = await ctx.api.planSkillsInstall(asked.revisionId, asked.targets);
      if (!ctx.alive(gen)) return;
      if (ws.pub !== pub || !sameAsk(asked, askNow(ctx, ws))) {
        // What Publish shows changed while the plan was on its way (another version, from Versions): it answers
        // something else, and is not used.
        ctx.toast(t('skillsStudio.publish.planOutdated'), 'error');
      } else {
        pub.plan = planModel(res.plan);
        pub.planTargets = asked.targets;
        pub.planRevision = asked.revisionId;
        pub.confirmed = { replace: new Set(), scan: new Set() };
        pub.results = null;
        ctx.announce(t('skillsStudio.publish.planReady'));
      }
    } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.publish.planFailed', { error: err.message }), 'error'); }
    finally { pub.busy = false; }
    redraw();
    return;
  }
  if (act === 'install') {
    if (!pub.plan || pub.busy) return;
    // Exactly the plan that is shown, for exactly what it was asked for: anything else is planned again first.
    const asked = planAsk(pub);
    if (!sameAsk(asked, askNow(ctx, ws))) { clearPlan(pub); ctx.toast(t('skillsStudio.publish.planOutdated'), 'error'); redraw(); return; }
    const plan = pub.plan;
    const decisions = decisionsOf(plan, { replace: [...pub.confirmed.replace], scan: [...pub.confirmed.scan] });
    pub.busy = true;
    redraw();
    let result = null;
    try {
      result = await ctx.api.installSkillsRevision({ revisionId: asked.revisionId, targets: asked.targets, planDigest: plan.planDigest, decisions, ...(ws.publishReviewId ? { reviewId: ws.publishReviewId } : {}) });
    } catch (err) {
      if (err?.code === 'plan_changed' && err.body?.plan) {
        if (ctx.alive(gen)) { pub.plan = planModel(err.body.plan); pub.confirmed = { replace: new Set(), scan: new Set() }; ctx.toast(t('skillsStudio.publish.planChanged'), 'error'); }
      } else if (err?.status === 207 && err.body) result = err.body;
      else if (ctx.alive(gen)) ctx.toast(t('skillsStudio.publish.installFailed', { error: err.message }), 'error');
    } finally { pub.busy = false; }
    if (!ctx.alive(gen)) return;
    if (result) {
      pub.results = resultModel(result);
      const ok = pub.results.filter((r) => r.status === 'committed').length;
      ctx.toast(ok === pub.results.length ? tp('skillsStudio.publish.installedAll', ok) : t('skillsStudio.publish.installedSome', { ok, total: pub.results.length }), ok === pub.results.length ? 'info' : 'error');
      clearPlan(pub);
      ws.publishReviewId = null;
      try { ws.skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill; } catch { /* the reload below */ }
      ctx.reload();
    }
    redraw();
    return;
  }
  if (act === 'verify') {
    const id = btn.dataset.inst;
    btn.disabled = true;
    try {
      const res = await ctx.api.verifySkillsInstallation(id, { probe: true });
      if (!ctx.alive(gen)) return;
      pub.verify[id] = verifyFacts(res.installation);
      ctx.announce(t('skillsStudio.publish.verified'));
    } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.publish.verifyFailed', { error: err.message }), 'error'); }
    redraw();
    return;
  }
  if (act === 'rollback' || act === 'remove') {
    const id = btn.dataset.inst;
    const answer = await ctx.ask({
      title: t(act === 'rollback' ? 'skillsStudio.publish.rollbackTitle' : 'skillsStudio.publish.removeTitle'),
      lines: [t(act === 'rollback' ? 'skillsStudio.publish.rollbackBody' : 'skillsStudio.publish.removeBody')],
      buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'go', label: t(act === 'rollback' ? 'skillsStudio.publish.rollback' : 'skillsStudio.publish.remove'), kind: 'danger' }],
      focus: 'cancel',
    });
    if (answer !== 'go') return;
    const call = (body) => (act === 'rollback' ? ctx.api.rollbackSkillsInstallation(id, body) : ctx.api.uninstallSkillsInstallation(id, body));
    try {
      await call({});
    } catch (err) {
      if (!needsConfirmation(err)) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.publish.undoFailed', { error: err.message }), 'error'); return; }
      const again = await ctx.ask({
        title: t('skillsStudio.publish.changedSinceTitle'),
        lines: [t('skillsStudio.publish.changedSinceBody')],
        buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'go', label: t('skillsStudio.publish.changedSinceConfirm'), kind: 'danger' }],
        focus: 'cancel',
      });
      if (again !== 'go') return;
      try { await call({ expectedDestinationDigest: err.body.currentDigest }); } catch (e2) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.publish.undoFailed', { error: e2.message }), 'error'); return; }
    }
    if (!ctx.alive(gen)) return;
    ctx.toast(t(act === 'rollback' ? 'skillsStudio.publish.rolledBack' : 'skillsStudio.publish.removed'));
    try { ws.skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill; } catch { /* */ }
    ctx.reload();
    redraw();
    return;
  }
  if (act === 'check-claude') {
    const box = panel.querySelector('#sx-pub-claude');
    const revisionId = chosenRevision(ws);
    if (!box || !revisionId) return;
    setHTML(box, html`<p class="sx-help">${t('skillsStudio.publish.checking')}</p>`);
    try {
      const res = await ctx.api.lintSkillsFolder({ revisionId, profiles: ['claude-upload'] });
      if (!ctx.alive(gen) || !box.isConnected) return;
      const p = res.profiles?.['claude-upload'];
      const items = (p?.diagnostics || []).filter((d) => d.severity === 'error' || d.severity === 'warning');
      setHTML(box, items.length
        ? html`<p class="sx-note sx-note--warn" role="note">${t('skillsStudio.publish.claudeProblems', { errors: p.errors, warnings: p.warnings })}</p><ul class="sx-problems">${items.slice(0, 12).map((d) => html`<li class="sx-problem sx-problem--${d.severity}">${d.message}</li>`)}</ul>`
        : html`<p class="sx-help sx-ok-text">${ICONS.ok} ${t('skillsStudio.publish.claudeOk')}</p>`);
    } catch (err) { if (box.isConnected) setHTML(box, html`<p class="sx-note sx-note--warn" role="alert">${t('skillsStudio.publish.checkFailed', { error: err.message })}</p>`); }
  }
}
