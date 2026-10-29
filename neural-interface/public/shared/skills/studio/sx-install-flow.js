// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: install in one go
// ═══════════════════════════════════════════
//
// The one flow behind every Install of the Studio (the Publish tab's button, Review's "Approve & install", the
// workspace banner): the service plans the install (POST /v2/installations/plan), the owner is asked one question
// only when the plan asks one (a folder SynaBun did not install or that changed since, the scan's findings: what
// lib/skills/deploy.js needs confirmed), and the install sends exactly that plan (its digest, the decisions per
// target). A plan that changed under it is planned again, once, and asked again. The outcome comes back as data
// (sx-install.js installOutcome) with its words. Every protection of the service is kept: nothing is written
// without a plan, nothing replaced without its digest, nothing blocked is sent.

import { scanFindingText } from './sx-scan.js';
import { studioErrorText } from './sx-errors.js';
import { html, setHTML } from './sx-dom.js';
import { BLOCK_CODES, planModel, resultModel } from './sx-plan.js';
import { installTargets, wholeTarget } from './sx-subject.js';
import { confirmations, installOutcome, parseTargetKey, reviewDestinations, assistantsOf, installedRuntimesOf, alsoInstallTargets, alsoInstallRevision } from './sx-install.js';

// ── One install at a time per skill ──
// Every surface that installs (the Publish tab's button, Review's card, the workspace banner) takes this lock for
// the skill before it approves or plans, and lets it go when the flow ends, however it ends. While it is held every
// surface shows the install as on its way and refuses a second one (a click, or Enter on a button it disables).
const _busy = new Map();        // skillId → since
const _watchers = new Set();    // told when a lock is taken or let go

/** Whether an install of this skill is on its way, from any surface. */
export const installBusy = (skillId) => !!skillId && _busy.has(skillId);

/**
 * Take the lock for a skill: what lets it go, or null when it is held already (the caller refuses).
 * @param {string} skillId
 * @returns {(() => void)|null}
 */
export function acquireInstall(skillId) {
  if (!skillId || _busy.has(skillId)) return null;
  _busy.set(skillId, Date.now());
  tell(skillId, true);
  let done = false;
  return () => { if (done) return; done = true; _busy.delete(skillId); tell(skillId, false); };
}

/** Be told when a lock is taken or let go (the surfaces draw the install as on its way, or not). */
export function onInstallBusy(fn) { _watchers.add(fn); return () => _watchers.delete(fn); }
function tell(skillId, busy) { for (const fn of _watchers) { try { fn({ skillId, busy }); } catch { /* a watcher's own trouble */ } } }

/** The words of a target: "Claude Code · all projects", "Codex · project Repo", "Claude Code · account work". */
export function targetWords(ctx, tg) {
  const { t } = ctx;
  const runtime = t(`skillsStudio.runtime.${['claude', 'codex', 'opencode', 'agents'].includes(tg?.runtime) ? tg.runtime : 'claude'}`);
  if (tg?.scope === 'project') return t('skillsStudio.publish.targetProject', { runtime, project: tg.projectLabel || ctx.projects?.find((p) => p.path === tg.projectPath)?.label || tg.projectPath || '' });
  if (tg?.accountId && tg.accountId !== 'default') return t('skillsStudio.publish.targetAccount', { runtime, account: tg.accountId });
  return t('skillsStudio.publish.targetUser', { runtime });
}

/** The words of a target key (an install's result names targets by key). */
export const keyWords = (ctx, key) => targetWords(ctx, parseTargetKey(key));

/** A folder path, short: the home folder as ~ (the full path stays in the element's title). */
export function shortPath(path) {
  return String(path || '').replace(/^\/Users\/[^/]+(?=\/)/, '~').replace(/^\/home\/[^/]+(?=\/)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\)/, '~');
}

/** The owner's assistants in effect (read with the Library: GET /v2/status `assistants`), or null on an older server. */
export function assistantsNow(ctx) { return assistantsOf(ctx.data?.status || null); }

/** The runtimes the resolver found on this computer (GET /v2/status `assistants.installed`), or null when not known. */
export function installedNow(ctx) { return installedRuntimesOf(ctx.data?.status || null); }

/**
 * "Also install for Codex · OpenCode": the assistants in effect that a skill installed somewhere does not reach yet
 * (sx-install.js alsoInstallTargets), with their words. Empty when there is nothing to add.
 */
export function alsoInstall(ctx, { skill, row }) {
  const targets = alsoInstallTargets({ skill, row, targets: targetsNow(ctx), assistants: assistantsNow(ctx), installed: installedNow(ctx) });
  return { targets: targets.map(wholeTarget), words: targets.map((t) => ctx.t(`skillsStudio.runtime.${t.runtime}`)).join(' · ') };
}

/**
 * One press: the version that is installed already (sx-install.js alsoInstallRevision) goes to the assistants that lack it, through the one flow (the plan, one question only when it asks one,
 * then exactly that plan). The outcome's words come back for a toast or a banner; null when nothing was to add.
 */
export async function alsoInstallNow(ctx, { skill, row }) {
  const { t } = ctx;
  const { targets } = alsoInstall(ctx, { skill, row });
  if (!targets.length || ctx.guest) return null;
  const revisionId = alsoInstallRevision(skill);
  if (!revisionId) return { kind: 'error', line: t('skillsStudio.publish.noVersion'), lines: [] };
  const release = acquireInstall(skill.skillId);
  if (!release) return { kind: 'error', line: t('skillsStudio.publish.busyElsewhere'), lines: [] };
  let out;
  try { out = await installFlow(ctx, { revisionId, targets }); } catch (err) { out = { status: 'failed', error: studioErrorText(ctx.t, err) }; } finally { release(); }
  return flowWords(ctx, out);
}

/** The targets a skill can be installed into now, with the shared folder as Settings has it (read with the Library). */
export function targetsNow(ctx, { projects = [] } = {}) {
  const config = ctx.data?.config || { sharedAgentsRoot: false };
  return installTargets({ roots: ctx.data?.catalog?.roots || [], config, projects: ctx.projects.filter((p) => projects.includes(p.path)) });
}

/**
 * Where a review's install goes (sx-install.js reviewDestinations), from the same targets every surface uses: the
 * label a button shows and the targets its click sends are one computation. `targets` as requests name them;
 * `words` each destination in words; `missing` what the submission named that is not available here, with why.
 */
export function reviewTargets(ctx, { review, skill, row }) {
  const projects = [...new Set((review?.targets || []).filter((x) => x?.scope === 'project' && x.projectPath && ctx.projects.some((p) => p.path === x.projectPath)).map((x) => x.projectPath))];
  const all = targetsNow(ctx, { projects });
  const d = reviewDestinations({ review, targets: all, skill, row, assistants: assistantsNow(ctx) });
  return {
    targets: d.targets.map(wholeTarget), all, keys: d.keys, named: d.named, fallback: d.fallback,
    words: all.filter((t) => d.keys.has(t.key)).map((t) => targetWords(ctx, t)),
    missing: d.missing.map((m) => ({ ...m, words: targetWords(ctx, m.target), why: ctx.t(`skillsStudio.publish.unavailable.${m.reason}`) })),
  };
}

/**
 * The workspaces of a skill read it again (its installations, pointers) after an install from another surface, so
 * their header pill, banners and Publish say what the Library row says. `resetPublish` starts their Publish over.
 */
export async function refreshSkillWorkspaces(ctx, skillId, { resetPublish = false } = {}) {
  if (!skillId) return;
  let fresh = null;
  try { fresh = (await ctx.api.fetchSkill(skillId)).skill; } catch { return; }
  for (const ws of ctx.workspaces.values()) {
    if (ws.skill?.skillId !== skillId) continue;
    ws.skill = fresh;
    if (resetPublish) { ws.pub = null; ws.publishReviewId = null; ws.publishRevisionId = null; }
  }
}

/**
 * The refresh hints of an outcome, worded (one per runtime that needs something). A runtime the resolver did not
 * find on this computer is said as such: the copy waits in its folder, and nothing lists it until it is installed.
 */
export function refreshWords(ctx, outcome) {
  const installed = installedNow(ctx);
  return (outcome?.refresh || []).map((x) => {
    const kind = Array.isArray(installed) && ['claude', 'codex', 'opencode'].includes(x.runtime) && !installed.includes(x.runtime) ? 'not-installed' : x.kind;
    return ctx.t(`skillsStudio.publish.refresh.${kind}`, { runtime: ctx.t(`skillsStudio.runtime.${x.runtime}`) });
  });
}

/** Why a runtime's settings turn the skill off, in words (sx-plan.js eligibility reason). */
export function eligibilityWords(ctx, runtime, reason) {
  const { t } = ctx;
  const name = t(`skillsStudio.runtime.${['claude', 'codex', 'opencode', 'agents'].includes(runtime) ? runtime : 'claude'}`);
  const file = shortPath(reason?.file || '');
  const kind = ['codex-config', 'claude-override', 'claude-deny', 'opencode-permission', 'unreadable', 'invalid-json'].includes(reason?.kind) ? reason.kind : 'other';
  return t(`skillsStudio.publish.eligibility.reason.${kind}`, { runtime: name, file, pattern: reason?.pattern || '*', rule: reason?.rule || reason?.key || '' });
}

/**
 * The owner pressed "Enable for <runtime>" on a plan line: the runtime setting that turns the skill off is changed by
 * the server over a backup (POST /v2/eligibility/enable); the words of what happened come back for a toast. A plan
 * is made again by the caller: this changes no file of the skill.
 * @returns {Promise<{ ok: boolean, line: string }>}
 */
export async function enableFor(ctx, { runtime, line }) {
  const { t } = ctx;
  const name = t(`skillsStudio.runtime.${runtime}`);
  const target = parseTargetKey(line.targetKey);
  const sep = line.destination && line.destination.includes('\\') && !line.destination.includes('/') ? '\\' : '/';
  const body = { runtime, name: line.destination ? line.destination.split(/[\\/]/).pop() : '', skillMd: `${line.destination}${sep}SKILL.md`, accountId: target.accountId, projectPath: target.projectPath };
  const said = (out) => (out.changed === false ? { ok: true, line: t('skillsStudio.publish.enableNothing', { runtime: name }) } : { ok: out.ok !== false, line: t('skillsStudio.publish.enabled', { runtime: name, file: shortPath(out.file || ''), backup: shortPath(out.backup || '') }) });
  try {
    return said(await ctx.api.enableSkillsEligibility(body));
  } catch (err) {
    // OpenCode's rules deny every skill: loosened only after the owner's word (the server refuses first).
    if (err?.code === 'deny_all' && runtime === 'opencode' && typeof ctx.ask === 'function') {
      const answer = await ctx.ask({
        title: t('skillsStudio.publish.enableDenyAllTitle', { runtime: name }),
        lines: [t('skillsStudio.publish.enableDenyAllBody', { file: shortPath(err.body?.file || err.file || '') })],
        buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'go', label: t('skillsStudio.publish.enableDenyAllGo'), kind: 'danger' }],
        focus: 'cancel',
      });
      if (answer !== 'go') return { ok: false, line: t('skillsStudio.publish.enableFailed', { runtime: name, error: studioErrorText(ctx.t, err) }) };
      try { return said(await ctx.api.enableSkillsEligibility({ ...body, confirmDenyAll: true })); } catch (e2) { return { ok: false, line: t('skillsStudio.publish.enableFailed', { runtime: name, error: studioErrorText(ctx.t, e2) }) }; }
    }
    return { ok: false, line: t('skillsStudio.publish.enableFailed', { runtime: name, error: studioErrorText(ctx.t, err) }) };
  }
}

/** An outcome in words: the line, the hints for open sessions, what failed. */
export function outcomeWords(ctx, outcome) {
  const { t } = ctx;
  const where = outcome.ok.map((k) => keyWords(ctx, k)).join(', ');
  const failed = outcome.failed.map((f) => keyWords(ctx, f.targetKey)).join(', ');
  const reason = (f) => f?.code && BLOCK_CODES.includes(f.code) ? t(`skillsStudio.publish.blocked.${f.code}`) : f?.code || f?.reason ? studioErrorText(t, f) : f ? t(`skillsStudio.publish.result.${f.status}`) : failed;
  const line = outcome.ok.length && !outcome.failed.length ? t('skillsStudio.publish.doneFor', { where })
    : outcome.ok.length ? t('skillsStudio.publish.doneSome', { where, failed })
      : t('skillsStudio.publish.doneNone', { reason: reason(outcome.failed[0]) });
  return { line, refresh: refreshWords(ctx, outcome), failed: outcome.failed.map((f) => `${keyWords(ctx, f.targetKey)}: ${reason(f)}`) };
}

/** What blocks a plan's targets, in words (one line per target). */
export function blockedWords(ctx, rows) {
  const { t } = ctx;
  return (rows || []).map((r) => t('skillsStudio.publish.blockedFor', { target: keyWords(ctx, r.targetKey), reason: r.blocked.map((b) => t(`skillsStudio.publish.blocked.${b.code}`)).join(' ') }));
}

/**
 * Ask what the plan asks, in one question, or nothing when it asks nothing.
 * @returns {Promise<object|null>} the decisions to send (empty when nothing was asked), null when the owner said no
 */
export async function askConfirmations(ctx, model) {
  const { t } = ctx;
  const c = confirmations(model);
  if (!c.replace.length && !c.scan.length) return c.decisions;
  const box = document.createElement('div');
  box.className = 'sx-confirm-list';
  setHTML(box, html`${c.replace.map((r) => html`<p class="sx-confirm-item"><strong>${keyWords(ctx, r.targetKey)}</strong>: <span class="sx-mono">${shortPath(r.destination)}</span> ${t(`skillsStudio.publish.confirmWhy.${r.replace.state === 'modified' ? 'modified' : 'unowned'}`)} ${t('skillsStudio.publish.confirmReplaced')}</p>`)}
    ${c.scan.map((r) => html`<div class="sx-confirm-item"><p><strong>${keyWords(ctx, r.targetKey)}</strong>: ${t('skillsStudio.publish.confirmScanLine')}</p>
      <ul class="sx-findings">${r.scanAck.findings.map((f) => html`<li class="sx-finding sx-finding--${f.severity}"><span class="sx-finding-sev">${t(`skillsStudio.review.severity.${['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low'}`)}</span> ${scanFindingText(t, f)}${f.file ? html` <span class="sx-mono sx-dim">${f.file}${f.line ? `:${f.line}` : ''}</span>` : ''}</li>`)}</ul></div>`)}`);
  const answer = await ctx.ask({
    title: t('skillsStudio.publish.confirmTitle'),
    lines: [t(c.replace.length ? 'skillsStudio.publish.confirmBodyReplace' : 'skillsStudio.publish.confirmBodyScan')],
    extra: box,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'go', label: t(c.replace.length ? 'skillsStudio.publish.confirmGo' : 'skillsStudio.publish.confirmGoScan'), kind: c.replace.length ? 'danger' : 'primary' }],
    focus: 'cancel',
    wide: c.scan.length > 0,
  });
  return answer === 'go' ? c.decisions : null;
}

/**
 * Plan, ask only what must be asked, install exactly that plan.
 * @param {object} ctx the Studio's context
 * @param {{ revisionId: string, targets: object[], reviewId?: string|null, plan?: object|null, onPlanned?: (model: object) => void }} o
 *   plan: a plan already made for exactly this ask (sx-plan.js planModel): used instead of asking for one
 * @returns {Promise<{ status: 'done'|'blocked'|'cancelled'|'plan-failed'|'failed'|'gone', plan?: object, results?: object[], outcome?: object, blocked?: object[], error?: string }>}
 */
export async function installFlow(ctx, { revisionId, targets, reviewId = null, plan = null, onPlanned = null }) {
  const gen = ctx.gen();
  let model = plan;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!model) {
      try { model = planModel((await ctx.api.planSkillsInstall(revisionId, targets)).plan); } catch (err) { return { status: 'plan-failed', error: studioErrorText(ctx.t, err) }; }
      if (!ctx.alive(gen)) return { status: 'gone' };
      onPlanned?.(model);
    }
    const c = confirmations(model);
    if (!c.ready.length) return { status: 'blocked', plan: model, blocked: c.blocked };
    const decisions = await askConfirmations(ctx, model);
    if (!ctx.alive(gen)) return { status: 'gone' };
    if (decisions === null) return { status: 'cancelled', plan: model };
    let result = null;
    try {
      result = await ctx.api.installSkillsRevision({ revisionId, targets, planDigest: model.planDigest, decisions, ...(reviewId ? { reviewId } : {}) });
    } catch (err) {
      if (!ctx.alive(gen)) return { status: 'gone' };
      if (err?.status === 207 && err.body) result = err.body;
      else if (err?.code === 'plan_changed' && err.body?.plan) { model = planModel(err.body.plan); onPlanned?.(model); continue; }   // what is there changed meanwhile: planned again, asked again
      else return { status: 'failed', error: studioErrorText(ctx.t, err), plan: model };
    }
    if (!ctx.alive(gen)) return { status: 'gone' };
    const results = resultModel(result);
    return { status: 'done', plan: model, results, outcome: installOutcome(results), blocked: c.blocked };
  }
  return { status: 'failed', error: ctx.t('skillsStudio.publish.planChanged'), plan: model };
}

/**
 * The words a finished flow gets, for a toast and a notice: null when nothing is to be said (gone, cancelled).
 * @returns {{ kind: 'info'|'error', line: string, lines: string[] }|null}
 */
export function flowWords(ctx, out) {
  const { t } = ctx;
  if (!out || out.status === 'gone' || out.status === 'cancelled') return null;
  if (out.status === 'done') {
    const w = outcomeWords(ctx, out.outcome);
    const extra = [...w.refresh, ...w.failed, ...blockedWords(ctx, out.blocked)];
    return { kind: out.outcome.all ? 'info' : 'error', line: w.line, lines: extra };
  }
  if (out.status === 'blocked') return { kind: 'error', line: t('skillsStudio.publish.notInstalledBlocked'), lines: blockedWords(ctx, out.blocked) };
  if (out.status === 'plan-failed') return { kind: 'error', line: t('skillsStudio.publish.planFailed', { error: out.error }), lines: [] };
  return { kind: 'error', line: t('skillsStudio.publish.installFailed', { error: out.error || '' }), lines: [] };
}
