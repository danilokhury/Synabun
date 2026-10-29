// Health/usage and Discover share the Studio shell in both variants. Requests die with this render's lifetime.
import { scanFindingText } from './sx-scan.js';
import { studioErrorText } from './sx-errors.js';
import { protectionEntries, scannerState } from './sx-operations.js';
import { html, setHTML, attr, ICONS } from './sx-dom.js';

let life = null;
export function leaveOperationsPlace() { life?.abort(); life = null; }
export async function renderOperationsPlace(host, ctx, place) {
  leaveOperationsPlace();
  const controller = life = new AbortController();
  const { signal } = controller;
  const alive = () => !signal.aborted && host.isConnected;
  const t = (key, args) => ctx.t(`skillsStudio.operations.${key}`, args);
  setHTML(host, html`<section class="sx-place"><div class="sx-place-scroll"><div class="sx-create" id="sx-operations">
    <h3 class="sx-place-title" tabindex="-1" data-autofocus>${t(place)}</h3><p role="status">${t('loading')}</p>
  </div></div></section>`);
  if (!ctx.caps.has(place === 'discover' ? 'discover' : 'health')) {
    setHTML(host.querySelector('#sx-operations'), html`<p class="sx-note">${t('restart')}</p>`); return;
  }
  try {
    const config = await ctx.api.fetchSkillOperations();
    const data = place === 'discover' ? await ctx.api.fetchSkillDiscover() : await ctx.api.fetchSkillHealth();
    const usage = place === 'health' ? await ctx.api.fetchSkillUsage() : null;
    if (!alive()) return;
    const settings = config.settings;
    const box = host.querySelector('#sx-operations');
    setHTML(box, html`<h3 class="sx-place-title" tabindex="-1" data-autofocus>${t(place)}</h3>
      <p class="sx-help">${t(place === 'discover' ? 'discoverHelp' : 'healthHelp')}</p>
      <p id="sx-ops-message" role="status" aria-live="polite"></p>
      ${place === 'discover' ? discoverHTML(data) : healthHTML(data, usage, settings, config.scanners)}`);
    async function action(fn) {
      box.querySelectorAll('button, input').forEach((e) => { e.disabled = true; });
      try { await fn(); if (alive()) renderOperationsPlace(host, ctx, place); }
      catch (e) { if (alive()) { box.querySelectorAll('button, input').forEach((e) => { e.disabled = ctx.guest; }); setHTML(box.querySelector('#sx-ops-message'), html`<span class="sx-err-text">${t('failed', { error: studioErrorText(ctx.t, e) })}</span>`); } }
    }
    box.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-ops]'); if (!button || ctx.guest) return;
      const act = button.dataset.ops;
      if (act === 'save') action(() => ctx.api.configureSkillOperations({ telemetryEnabled: box.querySelector('#sx-usage-enabled').checked, retentionDays: Number(box.querySelector('#sx-retention').value), healthEnabled: box.querySelector('#sx-health-enabled').checked, cadenceHours: Number(box.querySelector('#sx-cadence').value), protectedSkillIds: [...box.querySelectorAll('input[data-protect]:checked')].map((e) => e.dataset.protect) }));
      if (act === 'check') action(() => ctx.api.checkSkillHealth());
      if (act === 'clear') action(async () => {
        const answer = await ctx.ask({ title: t('clear'), lines: [t('clearHelp')], buttons: [{ id: 'cancel', label: ctx.t('skillsStudio.dialog.cancel') }, { id: 'go', label: t('clear'), kind: 'danger' }], focus: 'cancel' });
        if (answer === 'go' && alive()) await ctx.api.clearSkillUsage();
      });
      if (act === 'enable') action(() => ctx.api.configureSkillOperations({ sources: settings.sources.includes(button.dataset.source) ? settings.sources.filter((s) => s !== button.dataset.source) : [...settings.sources, button.dataset.source] }));
      if (act === 'refresh') action(() => ctx.api.refreshSkillDiscover(button.dataset.source));
      if (act === 'stage') action(async () => { const result = await ctx.api.stageSkillDiscover(button.dataset.item); if (alive()) { ctx.openReview(result.reviewId); await ctx.reload(); } });
      if (act === 'import-catalog') box.querySelector(`input[data-source="${button.dataset.source}"]`)?.click();
    }, { signal });
    box.addEventListener('change', (event) => {
      const input = event.target;
      if (!input.matches('input[type="file"]') || ctx.guest || !input.files?.[0]) return;
      const file = input.files[0];
      action(async () => { if (file.size > 1024 * 1024) throw new Error(t('catalogLimit')); const entries = JSON.parse(await file.text()); if (alive()) await ctx.api.importSkillDiscoverCatalog(input.dataset.source, entries); });
    }, { signal });
    box.querySelector('#sx-discover-search')?.addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); box.querySelectorAll('[data-discover-search]').forEach((el) => { el.hidden = !el.dataset.discoverSearch.includes(q); }); }, { signal });
  } catch (e) { if (alive()) setHTML(host.querySelector('#sx-operations'), html`<p class="sx-note sx-note--warn" role="alert">${t('failed', { error: studioErrorText(ctx.t, e) })}</p>`); }

  function discoverHTML(data) {
    return html`<p class="sx-note">${t('disclosure')}</p><div class="sx-ops-grid">${data.sources.map((s) => html`<section class="sx-ops-card">
      <h4 class="sx-section-title">${s.label}${s.deprecated ? ` · ${t('deprecated')}` : ''}</h4><p class="sx-help">${s.licenseCode ? t(`licenses.${s.licenseCode}`) : s.license}</p>
      <p class="sx-help">${t(s.enabled ? 'enabled' : 'disabled')}${s.error ? html` · ${studioErrorText(ctx.t, { code: s.error })}` : ''}</p>
      <div class="sx-row"><button class="sx-btn" type="button" data-ops="enable" data-source="${s.id}"${attr('disabled', ctx.guest)}>${t(s.enabled ? 'disableSource' : 'enableSource')}</button>
      ${s.enabled ? html`<button class="sx-btn" type="button" data-ops="${s.transport === 'github' ? 'refresh' : 'import-catalog'}" data-source="${s.id}"${attr('disabled', ctx.guest)}>${t(s.transport === 'github' ? 'refresh' : 'importCatalog')}</button>` : ''}</div>
      ${s.transport === 'catalog-import' ? html`<p class="sx-help">${t('catalogHelp')}</p><input type="file" accept="application/json,.json" data-source="${s.id}" hidden>` : ''}
    </section>`)}</div>
    <label class="sx-field-label" for="sx-discover-search">${t('search')}</label><input class="sx-input" id="sx-discover-search" type="search">
    <p class="sx-help">${t('cached', { count: data.items.length })}</p>
    <div class="sx-ops-grid">${data.items.map((i) => html`<article class="sx-ops-card" data-discover-search="${`${i.name} ${i.repo} ${i.subpath}`.toLowerCase()}">
      <h4 class="sx-section-title">${i.name}</h4><p class="sx-help">${i.repo} · ${i.subpath}</p><code>${i.commit}</code><p class="sx-help">${i.licenseCode ? t(`licenses.${i.licenseCode}`) : i.license}</p>
      <button class="sx-btn" type="button" data-ops="stage" data-item="${i.id}"${attr('disabled', ctx.guest)}>${ICONS.review} ${t('stage')}</button>
    </article>`)}</div>`;
  }
  function healthHTML(data, usage, settings, scanners) {
    const nameOf = (id) => ctx.data?.skills?.find((s) => s.skillId === id)?.name || id;
    return html`<div class="sx-ops-grid"><section class="sx-ops-card">
      <h4 class="sx-section-title">${t('collection')}</h4><label class="sx-choice"><input type="checkbox" id="sx-usage-enabled"${attr('checked', settings.telemetryEnabled)}${attr('disabled', ctx.guest)}> ${t('collect')}</label>
      <label class="sx-field-label" for="sx-retention">${t('retention')}</label><input class="sx-input" type="number" id="sx-retention" min="1" max="365" value="${settings.retentionDays}"${attr('disabled', ctx.guest)}>
      <p class="sx-help">${t('privacy')}</p><button class="sx-btn" type="button" data-ops="clear"${attr('disabled', ctx.guest)}>${t('clear')}</button>
    </section><section class="sx-ops-card"><h4 class="sx-section-title">${t('scheduleTitle')}</h4>
      <label class="sx-choice"><input type="checkbox" id="sx-health-enabled"${attr('checked', settings.healthEnabled)}${attr('disabled', ctx.guest)}> ${t('schedule')}</label>
      <label class="sx-field-label" for="sx-cadence">${t('cadence')}</label><input class="sx-input" type="number" id="sx-cadence" min="1" max="168" value="${settings.cadenceHours}"${attr('disabled', ctx.guest)}>
      <p class="sx-help">${t('lastCheck', { at: data.checkedAt ? new Date(data.checkedAt).toLocaleString() : t('never') })}</p>
      <button class="sx-btn" type="button" data-ops="check"${attr('disabled', ctx.guest || data.running)}>${t('check')}</button>
    </section></div><button class="sx-btn sx-btn--primary" type="button" data-ops="save"${attr('disabled', ctx.guest)}>${t('save')}</button>
    <h4 class="sx-section-title">${t('protected')}</h4><p class="sx-help">${t('protectedHelp')}</p><div class="sx-ops-grid">${protectionEntries(ctx.data?.skills || []).map((s) => html`<label class="sx-choice"><input type="checkbox" data-protect="${s.skillId}"${attr('checked', settings.protectedSkillIds.includes(s.skillId))}${attr('disabled', ctx.guest)}> ${s.name} · ${ctx.t(`skillsStudio.versions.source.${s.sourceCode}`)} · ${s.detail}</label>`)}</div>
    <h4 class="sx-section-title">${t('coverage')}</h4><ul class="sx-plain-list">${['claude', 'codex', 'opencode'].map((r) => html`<li>${t(`coverage_${r}`)}</li>`)}</ul>
    <h4 class="sx-section-title">${t('usage')}</h4>${usage.rows.length ? html`<div class="sx-ops-grid">${usage.rows.map((r) => html`<article class="sx-ops-card"><strong>${nameOf(r.skillId)} · ${r.runtime}</strong><p class="sx-help">${r.revisionId}</p><p>${t('counts', r)}</p></article>`)}</div>` : html`<p class="sx-help">${t('noUsage')}</p>`}
    <h4 class="sx-section-title">${t('installations')}</h4>${data.rows.length ? html`<div class="sx-ops-grid">${data.rows.map((r) => html`<article class="sx-ops-card"><strong>${r.name || nameOf(r.skillId)} · ${r.runtime}</strong>
      <p class="sx-help">${r.revisionId}</p><p class="${r.issues.length ? 'sx-warn-text' : 'sx-help'}">${t(`state_${r.status}`)}</p>
      <ul class="sx-plain-list">${r.issues.map((i) => html`<li>${t(`issue_${i}`)}</li>`)}</ul>
      ${r.scan ? html`<p class="sx-help">${r.scan.engine} ${r.scan.engineVersion} · ${r.scan.policy}</p><ul class="sx-plain-list">${r.scan.findings.slice(0, 12).map((f) => html`<li>${f.severity} · ${f.ruleId} · ${f.file || ''}${f.line ? `:${f.line}` : ''} — ${scanFindingText(t, f)}</li>`)}</ul>` : ''}
    </article>`)}</div>` : html`<p class="sx-help">${t('noChecks')}</p>`}
    <h4 class="sx-section-title">${t('proposals')}</h4><p class="sx-help">${t('proposalHelp')}</p><ul class="sx-plain-list">${data.proposals.map((p) => html`<li>${nameOf(p.skillId)} · ${p.runtime} · ${t('proposalFailures', { count: p.evidence.failures })}</li>`)}</ul>
    <h4 class="sx-section-title">${t('scanners')}</h4><p class="sx-help">${t('scannerHelp')}</p><ul class="sx-plain-list">${scanners.map((s) => html`<li>${s.id} · ${s.licenseCode ? t(`licenses.${s.licenseCode}`) : s.license} · ${s.enabled ? `${t('enabled')} · ` : ''}${t(scannerState(s))}</li>`)}</ul>`;
  }
}
