// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Publish tab
// ═══════════════════════════════════════════
//
// One decision and one press: where (one tile per runtime, Claude Code · Codex · OpenCode, in one scope: every
// project or one project), then Install, always in sight at the foot of the tab. What is ticked when the tab
// opens is the review's targets, else where the skill already is, else Claude Code for every project: never
// everything (sx-install.js defaultSelection). The plan runs by itself whenever the choice changes and says in one
// line per target what will happen there ("Will create ~/.claude/skills/x"); Install asks one question only when
// the plan asks one (a folder SynaBun did not install or that changed since, the scan's findings) and otherwise
// goes (sx-install-flow.js). The version (the approved one by default), the other accounts, the shared folder, the
// project folders and their paths are under Advanced; Versions keeps candidate and best. Installations are
// verified, rolled back or removed from the Installed list; exports are under Export.
//
// Every protection stays: a plan is used only for exactly what it was asked for (sx-subject.js sameAsk; a plan
// that comes back for a selection that changed meanwhile is dropped and the one for the current selection is on
// its way), the install sends that plan's digest and only the decisions the owner confirmed, nothing blocked is
// sent, and while an install is on its way the choice is locked. Each drawing of the tab listens once: the
// listeners of the drawing before end with it.

import { scanStatus, scanText, scanFindingText } from './sx-scan.js';
import { studioErrorText } from './sx-errors.js';
import { dropdownHTML, wireDropdowns } from '../../cc-dropdown.js';
import { html, raw, setHTML, ICONS, relativeTime, listText } from './sx-dom.js';
import { installTargets, targetState, wholeTarget, sameAsk } from './sx-subject.js';
import { verifyFacts, needsConfirmation, newPublishState, clearPlan, choosePublishRevision, planModel } from './sx-plan.js';
import { defaultSelection, scopeOf, simplePicker, moveScope, defaultRevisionId, plainLabel, planLines, installButton, installStatus, whereOf } from './sx-install.js';
import { targetWords, keyWords, shortPath, installFlow, flowWords, installBusy, acquireInstall, assistantsNow, installedNow, eligibilityWords, enableFor } from './sx-install-flow.js';
import { changedFiles } from './sx-diff.js';
import { dirtyTabs, saveVersion } from './sx-docs.js';
import { shortDigest } from './sx-editor-model.js';
import { adoptNow, customizeCopy } from './sx-actions.js';

let _life = null;   // the tab's listeners: they end when the tab is drawn again
let _draw = null;   // the listeners of the tab's last drawing: they end with the next drawing
const APPROVED = ['approved', 'partial', 'publish_failed'];
const PLAN_DELAY_MS = 200;

/** The signal of one drawing: it ends with the next drawing, and with the tab. */
function drawSignal(life) {
  _draw?.abort();
  const ctrl = new AbortController();
  _draw = ctrl;
  if (life.aborted) ctrl.abort();
  else life.addEventListener('abort', () => ctrl.abort(), { once: true, signal: ctrl.signal });
  return ctrl.signal;
}

function stateHTML(t, state, target) {
  if (target?.off) return html`<span class="sx-state-chip sx-state-chip--off">${t('skillsStudio.publish.state.off')}</span>`;
  return html`<span class="sx-state-chip sx-state-chip--${state}">${t(`skillsStudio.publish.state.${state}`)}</span>`;
}

/** Which revision Publish shows: the one asked for (a review, Versions), else the default (sx-install.js). */
const chosenRevision = (ws) => defaultRevisionId({ skill: ws.skill, revisions: ws.revisions || [], bundled: ws.row?.source === 'synabun', asked: ws.publishRevisionId });

/** The review this install belongs to: the one Publish was opened for, else the skill's approved one of this version. */
function reviewOf(ctx, ws, revisionId) {
  const reviews = ctx.data?.reviews || [];
  if (ws.publishReviewId) return reviews.find((r) => r.reviewId === ws.publishReviewId) || null;
  const own = ws.row?.review;
  return own && APPROVED.includes(own.state) && own.submittedRevisionId === revisionId ? own : null;
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
  setHTML(panel, html`<div class="sx-publish"><div class="sx-pub-scroll"><p class="sx-help" role="status">${t('skillsStudio.publish.loading')}</p></div></div>`);
  Promise.all([
    needRevisions ? ctx.api.fetchSkillRevisions(ws.skill.skillId).then((r) => { ws.revisions = (r.revisions || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }) : null,
    ctx.api.fetchSkill(ws.skill.skillId).then((r) => { ws.skill = r.skill; }),
    ctx.api.fetchSkillsConfig().then((r) => r.config || {}, () => ({ sharedAgentsRoot: false })).then((config) => { pub.config = config; }),
  ]).then(() => {
    if (!ctx.alive(gen) || !ws.shown || ws.tab !== 'publish' || ws.pub !== pub) return;
    draw(panel, ctx, ws, signal);
  }).catch((err) => {
    if (!ctx.alive(gen) || ws.tab !== 'publish' || ws.pub !== pub) return;
    setHTML(panel, html`<div class="sx-empty" role="alert"><p>${t('skillsStudio.publish.loadFailed', { error: studioErrorText(ctx.t, err) })}</p></div>`);
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

/** The panel the tab is drawn in now (the one given, or the one drawn again meanwhile). */
const panelNow = (panel, ctx) => (panel?.isConnected ? panel : ctx.panel?.querySelector('#sx-tabpanel'));

/**
 * Whether this workspace is still the one open for its key, and on screen with Publish: a late plan or install
 * answer of a workspace that was closed (and maybe opened again as a new one) draws nowhere.
 */
const publishShown = (ctx, ws) => !!ws && ctx.workspaces.get(ws.key) === ws && !!ws.shown && ws.tab === 'publish';

/** Whether an install is on its way for this skill, from this tab or any other surface. */
const installing = (ws) => !!ws.pub?.busy || installBusy(ws.skill?.skillId);

function draw(panel, ctx, ws, life) {
  const { t, tp, locale } = ctx;
  const signal = drawSignal(life);
  const pub = ws.pub;
  const revisionId = chosenRevision(ws);
  const review = reviewOf(ctx, ws, revisionId);
  const owner = !ctx.guest;
  if (!pub.checked) {
    // The projects a review names are offered (as targets of that project).
    for (const x of Array.isArray(review?.targets) ? review.targets : []) {
      if (x?.scope === 'project' && x.projectPath && !pub.projects.includes(x.projectPath) && ctx.projects.some((p) => p.path === x.projectPath)) pub.projects.push(x.projectPath);
    }
  }
  const targets = targetsOf(ctx, ws);
  if (!pub.checked) {
    pub.checked = defaultSelection({ review, targets, skill: ws.skill, row: ws.row, assistants: assistantsNow(ctx) });
    // An update applied from Review or a banner picks what it replaces (sx-review.js updateTargetKeys).
    if (typeof ws.pubPresetApply === 'function') { ws.pubPresetApply(pub, targets); ws.pubPresetApply = null; }
    pub.scope = scopeOf(pub.checked, targets) || 'user';
  }
  // A plan for another version or other targets than those on screen is neither shown nor installed.
  if (pub.plan && !sameAsk(planAsk(pub), askNow(ctx, ws))) clearPlan(pub);
  // While an install is on its way, from here or from the banner or Review, the choice is locked.
  const locked = installing(ws);
  const picker = simplePicker({ targets, checked: pub.checked, scope: pub.scope, skill: ws.skill, row: ws.row, revisionId, installed: installedNow(ctx) });
  const draftChanges = ws.draft && ws.revision ? changedFiles(ws.revision.manifest?.files || [], ws.draft.files || []) : [];
  const revisions = ws.revisions || [];
  const rev = revisions.find((r) => r.revisionId === revisionId) || null;
  const revEntries = revisions.map((r) => { const l = plainLabel(r.labels); return { value: r.revisionId, label: `${t('skillsStudio.versions.rev', { id: shortDigest(r.contentDigest) })}${l ? ` · ${t(`skillsStudio.versions.label.${l}`)}` : ''}`, selected: r.revisionId === revisionId }; });
  const projectScope = pub.scope.startsWith('project:') ? pub.scope.slice(8) : null;
  const projectEntries = ctx.projects.map((p) => ({ value: p.path, label: p.label, selected: p.path === projectScope }));
  const otherProjects = ctx.projects.filter((p) => !pub.projects.includes(p.path));
  const installs = ws.skill?.installations || [];
  setHTML(panel, html`<div class="sx-publish">
    <div class="sx-pub-scroll">
      <section class="sx-pub-section">
        ${statusHTML(ctx, ws, review, revisionId)}
        ${!revisions.length ? html`<p class="sx-note" role="note">${t('skillsStudio.publish.noVersion')}</p>` : ''}
        ${draftChanges.length && ws.subject.mode === 'library' ? html`<p class="sx-note" role="note">${tp('skillsStudio.publish.draftNotPublished', draftChanges.length)} ${owner ? html`<button type="button" class="sx-btn sx-btn--sm" data-pub="snapshot">${t('skillsStudio.publish.saveVersionAndUse')}</button>` : ''}</p>` : ''}
      </section>
      <section class="sx-pub-section" aria-labelledby="sx-pub-where">
        <h4 class="sx-section-title" id="sx-pub-where">${t('skillsStudio.publish.installFor')}</h4>
        <div class="sx-tiles" role="group" aria-labelledby="sx-pub-where">${picker.tiles.map((x) => html`<label class="sx-tile${x.on ? ' is-on' : ''}${x.available ? '' : ' is-off'}${x.via ? ' is-via' : ''}" title="${x.via ? t('skillsStudio.publish.viaClaudeHelp') : (x.path || '')}">
          <input type="checkbox" class="sx-check" data-target="${x.key}"${x.on ? ' checked' : ''}${!x.available || !owner || locked ? ' disabled' : ''} aria-describedby="sx-tile-${x.runtime}-state">
          <span class="sx-tile-name">${t(`skillsStudio.runtime.${x.runtime}`)}</span>
          <span class="sx-tile-state sx-tile-state--${x.tileState}" id="sx-tile-${x.runtime}-state">${t(`skillsStudio.publish.state.${x.tileState === 'via-claude' ? 'viaClaude' : x.tileState === 'not-installed' ? 'notInstalled' : x.tileState}`)}</span>
        </label>`)}</div>
        ${picker.tiles.some((x) => x.via) ? html`<p class="sx-help" id="sx-pub-via">${t('skillsStudio.publish.viaClaudeHelp')}</p>` : ''}
        <div class="sx-row sx-pub-scope">
          <span class="sx-filter-key" id="sx-pub-scope-label">${t('skillsStudio.publish.scope')}</span>
          <div class="sx-seg" role="group" aria-labelledby="sx-pub-scope-label">
            <button type="button" data-scope="user" aria-pressed="${projectScope ? 'false' : 'true'}"${!owner || locked ? ' disabled' : ''}>${t('skillsStudio.publish.scopeAll')}</button>
            <button type="button" data-scope="project" aria-pressed="${projectScope ? 'true' : 'false'}"${!owner || locked || !ctx.projects.length ? ' disabled' : ''} title="${ctx.projects.length ? '' : t('skillsStudio.publish.noProjects')}">${t('skillsStudio.publish.scopeProject')}</button>
          </div>
          ${projectScope ? html`<span class="sx-sr" id="sx-pub-proj-label">${t('skillsStudio.publish.scopeProject')}</span>${raw(dropdownHTML('sx-pub-proj', projectEntries, { labelledBy: 'sx-pub-proj-label', classes: 'sx-dd', disabled: !owner || locked }))}` : ''}
        </div>
        ${picker.extra.length ? html`<p class="sx-help" id="sx-pub-extra">${t('skillsStudio.publish.extraPicked', { targets: picker.extra.map((x) => targetWords(ctx, x)).join(', ') })}</p>` : ''}
        ${owner ? '' : html`<p class="sx-help">${t('skillsStudio.publish.guest')}</p>`}
      </section>
      <section class="sx-pub-section" id="sx-pub-plan" aria-live="polite">${planHTML(ctx, ws, picker)}</section>
      ${installs.length ? html`<section class="sx-pub-section" aria-labelledby="sx-pub-installed">
        <h4 class="sx-section-title" id="sx-pub-installed">${t('skillsStudio.publish.installedTitle')}</h4>
        <ul class="sx-installs">${installs.map((i) => installRowHTML(ctx, ws, i, revisionId, owner))}</ul>
      </section>` : ''}
      <details class="sx-details sx-pub-advanced" id="sx-pub-advanced"${pub.advanced ? ' open' : ''}>
        <summary>${t('skillsStudio.publish.advancedTitle')}</summary>
        <div class="sx-pub-advanced-body">
          ${revisions.length ? html`<div class="sx-row"><span class="sx-filter-key" id="sx-pub-rev-label">${t('skillsStudio.publish.version')}</span>${raw(dropdownHTML('sx-pub-rev', revEntries, { labelledBy: 'sx-pub-rev-label', classes: 'sx-dd', disabled: locked }))}
            ${rev ? html`<span class="sx-dim">${t('skillsStudio.publish.versionMeta', { when: relativeTime(rev.createdAt, locale) })}</span>` : ''}</div>
            <p class="sx-help">${t('skillsStudio.publish.versionHelp')}</p>` : ''}
          <table class="sx-grid">
            <caption class="sx-sr">${t('skillsStudio.publish.targetsCaption')}</caption>
            <thead><tr><th scope="col"><span class="sx-sr">${t('skillsStudio.publish.pick')}</span></th><th scope="col">${t('skillsStudio.publish.col.target')}</th><th scope="col">${t('skillsStudio.publish.col.folder')}</th><th scope="col">${t('skillsStudio.publish.col.now')}</th></tr></thead>
            <tbody>${targets.map((tg) => {
              const st = targetState(tg, { skill: ws.skill, row: ws.row, revisionId });
              const label = targetWords(ctx, tg);
              return html`<tr>
                <td><input type="checkbox" class="sx-check" data-adv-target="${tg.key}"${pub.checked.has(tg.key) ? ' checked' : ''}${tg.off || !owner || locked ? ' disabled' : ''} aria-label="${t('skillsStudio.publish.pickTarget', { target: label })}"></td>
                <td>${label}${tg.off ? html`<span class="sx-help sx-block">${t('skillsStudio.publish.sharedOff')}</span>` : st.state === 'bridge' ? html`<span class="sx-help sx-block">${t('skillsStudio.publish.bridgeHelp', { runtime: t(`skillsStudio.runtime.${tg.runtime}`) })}</span>` : ''}</td>
                <td class="sx-mono sx-path" title="${st.path || tg.path || ''}">${shortPath(st.path || tg.path || '')}</td>
                <td>${stateHTML(t, st.state, tg)}</td>
              </tr>`;
            })}</tbody>
          </table>
          ${otherProjects.length && owner ? html`<div class="sx-row"><span class="sx-filter-key" id="sx-pub-proj-add-label">${t('skillsStudio.publish.addProject')}</span>${raw(dropdownHTML('sx-pub-project', [{ value: '', label: t('skillsStudio.publish.chooseProject'), selected: true, disabled: true }, ...otherProjects.map((p) => ({ value: p.path, label: p.label }))], { labelledBy: 'sx-pub-proj-add-label', classes: 'sx-dd', disabled: locked }))}</div>` : ''}
          <p class="sx-help">${t('skillsStudio.publish.settingsNote')}</p>
        </div>
      </details>
      <details class="sx-details sx-pub-advanced" id="sx-pub-export"${pub.exportOpen ? ' open' : ''}>
        <summary>${t('skillsStudio.publish.exportTitle')}</summary>
        <div class="sx-pub-advanced-body">${exportHTML(ctx, ws, revisionId)}</div>
      </details>
    </div>
    <div class="sx-pub-bar" id="sx-pub-bar">${barHTML(ctx, ws, picker, revisionId, rev)}</div>
  </div>`);
  // This drawing's listeners: they end with the next drawing (a listener of each drawing would answer every click once
  // more: a dropdown opened and closed by one click, an action sent twice).
  wireDropdowns(panel, { signal });
  const changed = () => { clearPlan(pub); pub.results = null; pub.planError = null; };
  panel.querySelector('#sx-pub-rev')?.addEventListener('change', (e) => { choosePublishRevision(ws, e.target.value, { reviews: ctx.data?.reviews || [] }); pub.results = null; draw(panel, ctx, ws, life); }, { signal });
  panel.querySelector('#sx-pub-project')?.addEventListener('change', (e) => { if (e.target.value) { pub.projects.push(e.target.value); changed(); draw(panel, ctx, ws, life); } }, { signal });
  panel.querySelector('#sx-pub-proj')?.addEventListener('change', (e) => { if (e.target.value && e.target.value !== projectScope) setScope(panel, ctx, ws, life, `project:${e.target.value}`); }, { signal });
  for (const id of ['sx-pub-advanced', 'sx-pub-export']) panel.querySelector(`#${id}`)?.addEventListener('toggle', (e) => { pub[id === 'sx-pub-advanced' ? 'advanced' : 'exportOpen'] = e.target.open; }, { signal });
  panel.addEventListener('change', (e) => {
    const box = e.target;
    const key = box.dataset?.target || box.dataset?.advTarget;
    if (!key) return;
    if (pub.busy) return;
    if (box.checked) pub.checked.add(key); else pub.checked.delete(key);
    changed();
    draw(panel, ctx, ws, life);
    panel.querySelector(`[data-${box.dataset.target ? 'target' : 'adv-target'}="${CSS.escape(key)}"]`)?.focus();
  }, { signal });
  panel.addEventListener('click', (e) => {
    const scope = e.target.closest?.('[data-scope]');
    if (scope && !scope.disabled) {
      if (scope.dataset.scope === 'user') { if (projectScope) setScope(panel, ctx, ws, life, 'user'); } else if (!projectScope) setScope(panel, ctx, ws, life, `project:${ctx.projects.find((p) => pub.projects.includes(p.path))?.path || ctx.projects[0].path}`);
      return;
    }
    const btn = e.target.closest?.('[data-pub]');
    if (!btn || btn.disabled) return;
    onAction(btn.dataset.pub, btn, panel, ctx, ws, life);
  }, { signal });
  schedulePlan(panel, ctx, ws);
}

/** The scope changed: the tiles ticked move with it; the project's targets are offered. */
function setScope(panel, ctx, ws, life, to) {
  const pub = ws.pub;
  if (pub.busy || to === pub.scope) return;
  const path = to.startsWith('project:') ? to.slice(8) : null;
  if (path && !pub.projects.includes(path)) pub.projects.push(path);
  pub.checked = moveScope(pub.checked, pub.scope, to);
  pub.scope = to;
  clearPlan(pub); pub.results = null; pub.planError = null;
  draw(panel, ctx, ws, life);
  panel.querySelector(`[data-scope="${path ? 'project' : 'user'}"]`)?.focus();
}

/** The first line: where it is now, or that it is not, and that the version picked is the approved one. */
function statusHTML(ctx, ws, review, revisionId) {
  const { t } = ctx;
  const status = installStatus({ skill: ws.skill, row: ws.row }) || { code: 'none', where: [] };
  const where = status.where.map((w) => targetWords(ctx, w)).join(', ');
  const reviewed = review && review.submittedRevisionId === revisionId;
  let line;
  if (status.code === 'installed') line = t('skillsStudio.publish.statusInstalled', { where });
  else if (status.code === 'outdated') line = t('skillsStudio.publish.statusOutdated', { where });
  else if (status.code === 'draft') line = '';
  else line = t('skillsStudio.publish.statusNone');   // the banner above says it is approved; here, that its version is picked
  return line ? html`<p class="sx-pub-status" id="sx-pub-status" role="status">${status.code === 'installed' ? ICONS.ok : ICONS.info}<span>${line}${reviewed || status.code === 'approved' ? html` <span class="sx-dim">${t('skillsStudio.publish.statusApprovedVersion')}</span>` : ''}</span></p>` : '';
}

/** One line per target of the plan, the outcome of an install, or what is waited for. */
function planHTML(ctx, ws, picker) {
  const { t } = ctx;
  const pub = ws.pub;
  const picked = picker.tiles.filter((x) => x.on).length + picker.extra.length;
  if (pub.results) return outcomeHTML(ctx, pub.results);
  if (pub.planError) return html`<p class="sx-note sx-note--warn" role="alert">${t('skillsStudio.publish.planFailed', { error: pub.planError })} <button type="button" class="sx-btn sx-btn--sm" data-pub="replan">${t('skillsStudio.publish.retryPlan')}</button></p>`;
  if (!chosenRevision(ws)) return '';
  if (!picked) return html`<p class="sx-help">${t('skillsStudio.publish.pickOne')}</p>`;
  if (!pub.plan) return html`<p class="sx-help sx-pub-checking">${t('skillsStudio.publish.checkingPlan')}</p>`;
  const lines = planLines(pub.plan);
  return html`<ul class="sx-plan-lines" data-plan-rev="${pub.planRevision || ''}">${lines.map((l) => {
    const folder = html`<span class="sx-mono" title="${l.destination || ''}">${shortPath(l.destination || '')}</span>`;
    const reason = l.blocked.map((b) => t(`skillsStudio.publish.blocked.${b.code}`)).join(' ');
    const sev = l.code === 'blocked' ? 'err' : (l.asks.replace || l.asks.scan || l.overlap.length || l.disabledFor.length) ? 'warn' : l.code === 'identical' ? 'ok' : 'info';
    const canEnable = !ctx.guest && ctx.caps.has('eligibility-fix') && !installing(ws);
    const icon = sev === 'err' ? ICONS.err : sev === 'warn' ? ICONS.warn : sev === 'ok' ? ICONS.ok : ICONS.info;
    const main = l.code === 'blocked' ? t('skillsStudio.publish.line.blocked', { reason })
      : l.code === 'identical' ? html`${t('skillsStudio.publish.line.identical')} ${folder}`
        : l.code === 'replace-owned' ? html`${t('skillsStudio.publish.line.replaceOwnedBefore')} ${folder} ${t('skillsStudio.publish.line.replaceOwnedAfter')}`
          : l.code === 'replace-modified' ? html`${folder} ${t('skillsStudio.publish.line.replaceModified')}`
            : l.code === 'replace-unowned' ? html`${folder} ${t('skillsStudio.publish.line.replaceUnowned')}`
              : html`${t('skillsStudio.publish.line.create')} ${folder}`;
    return html`<li class="sx-plan-line sx-plan-line--${sev}" data-plan-line="${l.targetKey}"><span class="sx-plan-line-icon">${icon}</span><span class="sx-plan-line-text"><strong>${keyWords(ctx, l.targetKey)}</strong>: ${main}
      ${l.alsoReadBy.length ? html`<span class="sx-dim"> · ${t('skillsStudio.publish.readBy', { runtimes: l.alsoReadBy.map((r) => t(`skillsStudio.runtime.${r}`)).join(', ') })}</span>` : ''}
      ${l.asks.scan ? html`<span class="sx-block sx-warn-text">${t('skillsStudio.publish.line.scanAsk')}</span>` : ''}
      ${l.overlap.map((o) => html`<span class="sx-block sx-warn-text">${o.runtimes.length > 1 ? t('skillsStudio.publish.overlapMany', { runtimes: listText(o.runtimes.map((r) => t(`skillsStudio.runtime.${r}`)), ctx.locale), name: o.name || l.name || '', path: shortPath(o.path || '') }) : t('skillsStudio.publish.overlapOne', { runtime: t(`skillsStudio.runtime.${o.runtimes[0] || l.runtime}`), name: o.name || l.name || '', path: shortPath(o.path || '') })}</span>`)}
      ${l.disabledFor.map((d) => html`<span class="sx-block sx-warn-text sx-eligibility" data-eligibility="${l.targetKey}:${d.runtime}">${t('skillsStudio.publish.eligibility.disabled', { runtime: t(`skillsStudio.runtime.${d.runtime}`), reason: eligibilityWords(ctx, d.runtime, d.reason) })}
        ${canEnable ? html` <button type="button" class="sx-btn sx-btn--sm" data-pub="enable" data-key="${l.targetKey}" data-runtime="${d.runtime}">${t('skillsStudio.publish.enableFor', { runtime: t(`skillsStudio.runtime.${d.runtime}`) })}</button>` : ''}</span>`)}
      ${l.unknownFor.map((d) => html`<span class="sx-block sx-dim">${t('skillsStudio.publish.eligibility.unknown', { runtime: t(`skillsStudio.runtime.${d.runtime}`), reason: eligibilityWords(ctx, d.runtime, d.reason) })}</span>`)}
      ${l.transforms.map((tr) => html`<span class="sx-block sx-dim">${t('skillsStudio.publish.transform')} ${tr.reason}</span>`)}</span></li>`;
  })}</ul>`;
}

function outcomeHTML(ctx, results) {
  const { t } = ctx;
  const w = results.words;
  return html`<div class="sx-outcome sx-outcome--${w.kind}" role="status">
    <p class="sx-outcome-line">${w.kind === 'info' ? ICONS.ok : ICONS.warn}<strong>${w.line}</strong></p>
    ${w.lines.length ? html`<ul class="sx-plain-list sx-outcome-notes">${w.lines.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
    ${results.outcome?.ok.length ? html`<p class="sx-help">${t('skillsStudio.publish.outcomeHelp')}</p>` : ''}
  </div>`;
}

/** One installation: where, which version it has, and its actions. */
function installRowHTML(ctx, ws, i, revisionId, owner) {
  const { t } = ctx;
  const current = revisionId ? i.sourceRevisionId === revisionId : !i.updateAvailable;
  const facts = ws.pub.verify[i.installationId] || null;
  return html`<li class="sx-install-row">
    <span class="sx-install-where">${targetWords(ctx, whereOf(i))}</span>
    <span class="sx-mono sx-dim sx-path" title="${i.destination || ''}">${shortPath(i.destination || '')}</span>
    ${stateHTML(t, current ? 'installed' : 'outdated')}
    ${owner ? html`<span class="sx-install-actions">
      <button type="button" class="sx-btn sx-btn--sm" data-pub="verify" data-inst="${i.installationId}">${t('skillsStudio.publish.verify')}</button>
      <button type="button" class="sx-btn sx-btn--sm" data-pub="rollback" data-inst="${i.installationId}">${t('skillsStudio.publish.rollback')}</button>
      <button type="button" class="sx-btn sx-btn--sm sx-btn--danger" data-pub="remove" data-inst="${i.installationId}">${t('skillsStudio.publish.remove')}</button></span>` : ''}
    ${facts ? factsHTML(t, facts) : ''}
  </li>`;
}

function factsHTML(t, f) {
  return html`<ul class="sx-facts sx-install-facts">
    <li>${t(`skillsStudio.publish.fact.written.${f.written === 'verified' ? 'ok' : f.written === 'missing' ? 'missing' : f.written === 'changed' ? 'changed' : 'unknown'}`)}</li>
    <li>${t(`skillsStudio.publish.fact.discoverable.${f.discoverable}`)}</li>
    <li>${t(`skillsStudio.publish.fact.eligibility.${f.eligibility}`)}</li>
    ${f.discovered.map((d) => html`<li>${t(`skillsStudio.publish.fact.discovered.${d.discovered === true ? 'yes' : d.discovered === false ? 'no' : d.code || 'unknown'}`, { runtime: t(`skillsStudio.runtime.${d.runtime}`) })}</li>`)}
    ${f.checks.filter((c) => !c.ok).map((c) => html`<li class="sx-warn-text">${c.message}</li>`)}
  </ul>`;
}

/** The foot of the tab: what is picked, and the one button. */
function barHTML(ctx, ws, picker, revisionId, rev) {
  const { t } = ctx;
  const pub = ws.pub;
  if (ctx.guest) return html`<span class="sx-pub-bar-text sx-help">${t('skillsStudio.publish.guest')}</span>`;
  // Only what the install would send is counted and named: a tile that is on, and what is ticked under Advanced
  // and not off (simplePicker leaves an off target out, as askNow does).
  const picked = [...picker.tiles.filter((x) => x.on && x.available).map((x) => x.target), ...picker.extra];
  const states = picked.map((tg) => targetState(tg, { skill: ws.skill, row: ws.row, revisionId }).state);
  const asked = askNow(ctx, ws);
  const planCurrent = pub.plan && sameAsk(planAsk(pub), asked) ? pub.plan : null;
  const b = installButton({ picked: picked.length, states, model: planCurrent, checking: !planCurrent && !pub.planError, busy: installing(ws), error: !!pub.planError });
  if (!revisionId) return html`<span class="sx-pub-bar-text sx-help">${t('skillsStudio.publish.noVersion')}</span>`;
  const label = t(`skillsStudio.publish.bar.${b.code === 'nothing' || b.code === 'blocked' ? 'install' : b.code}`);
  const label2 = picked.length > 1 && b.enabled ? t('skillsStudio.publish.bar.count', { label, count: picked.length }) : label;
  const where = picked.map((tg) => targetWords(ctx, tg)).join(', ');
  const l = rev ? plainLabel(rev.labels) : null;
  const version = rev ? `${t('skillsStudio.versions.rev', { id: shortDigest(rev.contentDigest) })}${l ? ` · ${t(`skillsStudio.versions.label.${l}`)}` : ''}` : '';
  return html`<span class="sx-pub-bar-text" id="sx-pub-bar-text">${picked.length ? html`<span class="sx-pub-bar-where">${where}</span>` : html`<span class="sx-help">${t('skillsStudio.publish.pickOne')}</span>`}${version ? html`<span class="sx-dim sx-pub-bar-version">${version}</span>` : ''}</span>
    <button type="button" class="sx-btn sx-btn--primary sx-btn--lg" id="sx-pub-install" data-pub="install" data-state="${b.code}"${b.enabled ? '' : ' disabled'} aria-describedby="sx-pub-bar-text">${b.code === 'installed' ? ICONS.ok : ''}<span>${label2}</span></button>`;
}

/** The plan section and the foot again, after a plan came back (the tiles keep the keyboard). */
function drawPlanParts(ctx, ws) {
  const panel = ctx.panel?.querySelector('#sx-tabpanel');
  if (!panel || !publishShown(ctx, ws)) return;
  const pub = ws.pub;
  const revisionId = chosenRevision(ws);
  const targets = targetsOf(ctx, ws);
  const picker = simplePicker({ targets, checked: pub.checked || new Set(), scope: pub.scope, skill: ws.skill, row: ws.row, revisionId, installed: installedNow(ctx) });
  const rev = (ws.revisions || []).find((r) => r.revisionId === revisionId) || null;
  setHTML(panel.querySelector('#sx-pub-plan'), planHTML(ctx, ws, picker));
  setHTML(panel.querySelector('#sx-pub-bar'), barHTML(ctx, ws, picker, revisionId, rev));
}

/** The plan for what is picked, a moment after the last change: one request for the choice as it then is. */
function schedulePlan(panel, ctx, ws) {
  const pub = ws.pub;
  const asked = askNow(ctx, ws);
  clearTimeout(pub.planTimer);
  if (!asked.revisionId || !asked.targets.length || ctx.guest) { pub.planning = null; return; }
  if (pub.plan && sameAsk(planAsk(pub), asked)) return;
  if (pub.planning && sameAsk(pub.planning, asked)) return;   // on its way for exactly this already
  pub.planTimer = setTimeout(() => runPlan(ctx, ws), PLAN_DELAY_MS);
}

/**
 * An install was taken up or let go on another surface (the banner, Review): the choice and the button of a Publish
 * on screen follow, without a reading (sx-main.js calls this from the lock's watcher).
 */
export function refreshPublishBusy(ctx, ws) {
  const panel = ctx.panel?.querySelector('#sx-tabpanel');
  if (!panel || !publishShown(ctx, ws) || !ws.pub?.checked || !panel.querySelector('#sx-pub-bar')) return;
  if (!_life || _life.signal.aborted) return;
  draw(panel, ctx, ws, _life.signal);
}

async function runPlan(ctx, ws) {
  const pub = ws.pub;
  if (ctx.workspaces.get(ws.key) !== ws) return;   // closed meanwhile: its plan is nobody's
  const asked = askNow(ctx, ws);
  if (!asked.revisionId || !asked.targets.length || pub.busy) return;
  if (pub.plan && sameAsk(planAsk(pub), asked)) return;
  pub.planning = asked;
  pub.planError = null;
  const gen = ctx.gen();
  try {
    const res = await ctx.api.planSkillsInstall(asked.revisionId, asked.targets);
    if (!ctx.alive(gen) || ws.pub !== pub) return;
    // What is picked changed while this plan was on its way: this answers something else and is dropped; the plan
    // for the choice as it is now is on its way or scheduled.
    if (!sameAsk(asked, askNow(ctx, ws))) return;
    pub.plan = planModel(res.plan);
    pub.planTargets = asked.targets;
    pub.planRevision = asked.revisionId;
    pub.confirmed = { replace: new Set(), scan: new Set() };
  } catch (err) {
    if (!ctx.alive(gen) || ws.pub !== pub || !sameAsk(asked, askNow(ctx, ws))) return;
    pub.planError = studioErrorText(ctx.t, err);
  } finally {
    if (ws.pub === pub && pub.planning === asked) pub.planning = null;
  }
  drawPlanParts(ctx, ws);
}

function exportHTML(ctx, ws, revisionId) {
  const { t } = ctx;
  if (!revisionId) return html`<p class="sx-help">${t('skillsStudio.publish.exportNeedsVersion')}</p>`;
  if (!ctx.caps.has('export')) {
    return html`<p class="sx-help">${t('skillsStudio.publish.exportRestart')}</p>${ws.subject.v1Id ? html`<a class="sx-btn" href="${ctx.api.getSkillsExportUrl(ws.subject.v1Id)}" download="">${ICONS.download}<span>${t('skillsStudio.publish.exportBundle')}</span></a>` : ''}`;
  }
  if (ctx.caps.has('packages')) return html`<div class="sx-row">${['bundle', 'skill', 'portable', 'claude-upload', 'claude-plugin', 'claude-api', 'github'].map((format) => html`<button class="sx-btn" type="button" data-pub="package" data-format="${format}">${ICONS.download}<span>${t(`skillsStudio.operations.formats.${format}`)}</span></button>`)}</div><p class="sx-help">${t('skillsStudio.publish.exportHelp')}</p>`;
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
  const { t } = ctx;
  const pub = ws.pub;
  const gen = ctx.gen();
  // Drawn again only while this Publish is the one on screen (not after another version or review started it over),
  // in the tab as it is now: one drawn again meanwhile (the owner went to Edit and back) is the one updated.
  const redraw = () => {
    if (!ctx.alive(gen) || !publishShown(ctx, ws) || ws.pub !== pub) return;
    if (panel.isConnected) { draw(panel, ctx, ws, life); return; }
    const now = ctx.panel?.querySelector('#sx-tabpanel');
    if (now && _life && !_life.signal.aborted) draw(now, ctx, ws, _life.signal);
  };
  if (act === 'package') {
    const revisionId = chosenRevision(ws), format = btn.dataset.format;
    btn.disabled = true;
    try {
      const pkg = (await ctx.api.previewSkillPackage(revisionId, { format })).package;
      if (!ctx.alive(gen) || !panel.isConnected || ws.pub !== pub) return;
      const lines = [t('skillsStudio.operations.packageHelp', { revision: revisionId, digest: pkg.artifactDigest, count: pkg.files.length }),
        t(pkg.namingPolicy === 'target' ? 'skillsStudio.operations.packageName_target' : 'skillsStudio.operations.packageName_preserved', { name: pkg.name }),
        t('skillsStudio.operations.packageLicense', { license: pkg.license || t('skillsStudio.operations.unknown') }),
        t('skillsStudio.operations.packageSourceScan', { status: scanText(t, pkg.sourceScan, pkg.sourceDigest), passed: t(scanStatus(pkg.sourceScan, pkg.sourceDigest).passed ? 'skillsStudio.scan.passed' : 'skillsStudio.scan.notPassed') }),
        pkg.losses.length ? t('skillsStudio.operations.packageLosses', { fields: pkg.losses.map((x) => x.field).join(', ') }) : t('skillsStudio.operations.packageNoLosses'),
        ...pkg.scan.findings.slice(0, 8).map((f) => `${f.severity}: ${f.ruleId} — ${scanFindingText(t, f)}`)];
      const answer = await ctx.ask({ title: t('skillsStudio.operations.packageTitle'), lines, buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'download', label: t('skillsStudio.operations.download') }], focus: 'cancel' });
      if (answer !== 'download' || !ctx.alive(gen) || ws.pub !== pub || chosenRevision(ws) !== revisionId) return;
      const a = document.createElement('a');
      a.href = ctx.api.getSkillsRevisionExportUrl(revisionId, { format, acknowledgedDigest: pkg.artifactDigest });
      a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.operations.failed', { error: studioErrorText(ctx.t, err) }), 'error'); }
    finally { if (btn.isConnected) btn.disabled = false; }
    return;
  }
  if (act === 'replan') {
    pub.planError = null;
    clearPlan(pub);
    redraw();   // draws "Checking…" and asks for the plan again
    return;
  }
  if (act === 'enable') {
    // The runtime's setting that turns the skill off: changed by the server over a backup, on this click only; then
    // the plan is made again (the setting is not part of the plan's digest, but the line must say what is true now).
    if (!pub.plan || installing(ws)) return;
    const line = planLines(pub.plan).find((l) => l.targetKey === btn.dataset.key);
    const runtime = btn.dataset.runtime;
    if (!line || !['claude', 'codex', 'opencode'].includes(runtime)) return;
    btn.disabled = true;
    const said = await enableFor(ctx, { runtime, line });
    if (!ctx.alive(gen)) return;
    ctx.toast(said.line, said.ok ? 'info' : 'error');
    ctx.announce(said.line);
    if (ws.pub !== pub) return;
    clearPlan(pub);
    redraw();
    return;
  }
  if (act === 'snapshot') {
    if (dirtyTabs(ws).length) { ctx.toast(t('skillsStudio.toast.saveFirst'), 'error'); return; }
    try {
      const out = await saveVersion(ws, ctx.api, { key: ctx.key });
      if (!ctx.alive(gen)) return;
      ws.publishRevisionId = out.revision.revisionId;
      ws.revisions = null;
      ctx.toast(out.unchanged ? t('skillsStudio.toast.versionUnchanged') : t('skillsStudio.toast.versionSaved'));
      renderPublishTab(panelNow(panel, ctx), ctx, ws);
    } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.toast.versionFailed', { error: studioErrorText(ctx.t, err) }), 'error'); }
    return;
  }
  if (act === 'install') {
    const asked = askNow(ctx, ws);
    if (!asked.revisionId || !asked.targets.length || installing(ws)) return;
    // One install of a skill at a time, from whichever surface (the banner, Review, here).
    const release = acquireInstall(ws.skill?.skillId);
    if (!release) { ctx.toast(t('skillsStudio.publish.busyElsewhere'), 'error'); return; }
    // Exactly the plan that is shown, for exactly what it was asked for; without one, the flow asks for one first.
    const plan = pub.plan && sameAsk(planAsk(pub), asked) ? pub.plan : null;
    const review = reviewOf(ctx, ws, asked.revisionId);
    clearTimeout(pub.planTimer);
    pub.busy = true;
    redraw();   // the choice is locked until the install is back
    let out;
    try {
      out = await installFlow(ctx, {
        revisionId: asked.revisionId, targets: asked.targets, reviewId: review?.reviewId || null, plan,
        onPlanned: (m) => { if (ws.pub === pub) { pub.plan = m; pub.planTargets = asked.targets; pub.planRevision = asked.revisionId; } },
      });
    } finally { pub.busy = false; release(); }
    if (!ctx.alive(gen) || ws.pub !== pub) return;
    if (out.status === 'gone') return;
    if (out.status === 'cancelled') { redraw(); return; }
    const words = flowWords(ctx, out);
    if (out.status === 'done') {
      pub.results = { outcome: out.outcome, results: out.results, blocked: out.blocked, words };
      clearPlan(pub);
      ws.publishReviewId = null;
      ctx.toast(words.line, words.kind);
      ctx.announce(words.line);
      try { ws.skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill; } catch { /* the reload below */ }
      redraw();         // the outcome at once; the reload below draws the tab again from the same state
      ctx.reload();     // the rows, the review (published), the rail
      return;
    }
    ctx.toast(words.line, 'error');
    if (out.plan) { pub.plan = out.plan; pub.planTargets = asked.targets; pub.planRevision = asked.revisionId; }
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
    } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.publish.verifyFailed', { error: studioErrorText(ctx.t, err) }), 'error'); }
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
      if (!needsConfirmation(err)) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.publish.undoFailed', { error: studioErrorText(ctx.t, err) }), 'error'); return; }
      const again = await ctx.ask({
        title: t('skillsStudio.publish.changedSinceTitle'),
        lines: [t('skillsStudio.publish.changedSinceBody')],
        buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'go', label: t('skillsStudio.publish.changedSinceConfirm'), kind: 'danger' }],
        focus: 'cancel',
      });
      if (again !== 'go') return;
      try { await call({ expectedDestinationDigest: err.body.currentDigest }); } catch (e2) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.publish.undoFailed', { error: studioErrorText(ctx.t, e2) }), 'error'); return; }
    }
    if (!ctx.alive(gen)) return;
    ctx.toast(t(act === 'rollback' ? 'skillsStudio.publish.rolledBack' : 'skillsStudio.publish.removed'));
    try { ws.skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill; } catch { /* */ }
    clearPlan(pub); pub.results = null;
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
    } catch (err) { if (box.isConnected) setHTML(box, html`<p class="sx-note sx-note--warn" role="alert">${t('skillsStudio.publish.checkFailed', { error: studioErrorText(ctx.t, err) })}</p>`); }
  }
}

