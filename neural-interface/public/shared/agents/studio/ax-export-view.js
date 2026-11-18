// The owner's native export dialog. Reading never writes; only Confirm export sends the pinned POST.
import { html, setHTML } from '../../skills/studio/sx-dom.js';
import { wireDropdowns } from '../../cc-dropdown.js';
import { dropdown, field, errorText, loadingHTML } from './ax-ui.js';
import { canExportNative, nativeHostOptions, nativeExportSession } from './ax-native-export.js';

export async function exportToHost(ctx, ed) {
  if (!canExportNative(ctx, ed.agent)) return;
  const { t } = ctx;
  const life = new AbortController();
  const session = nativeExportSession(ctx.api, ed.key, ed.agent.approvedDefinition.revision);
  let open = true, writing = false, written = false, ready = false, ui = null, loadId = 0;
  const extra = document.createElement('div');
  extra.className = 'ax-dlg-form ax-native-export';
  setHTML(extra, loadingHTML(t));
  const sayError = (error) => {
    ready = false;
    ui?.setDisabled('write', true);
    const message = extra.querySelector('#ax-export-preview') || extra;
    setHTML(message, html`<p class="sx-note sx-note--err" role="alert">${errorText(t, error)}</p><button type="button" class="sx-btn" data-export-retry>${t('agentsStudio.state.retry')}</button>`);
  };
  const selection = () => {
    const value = extra.querySelector('#ax-export-target').value;
    return { host: extra.querySelector('#ax-export-host').value, target: value === 'account' ? 'account' : 'project', ...(value !== 'account' ? { targetProject: value.slice(8) } : {}) };
  };
  async function preview() {
    const id = ++loadId;
    ready = false; ui.setDisabled('write', true);
    const target = extra.querySelector('#ax-export-preview');
    setHTML(target, loadingHTML(t));
    try {
      const result = await session.load(selection());
      if (!open || id !== loadId || !result) return;
      const problem = result.targetProblem?.error || result.target?.problem?.error || result.target?.problem?.message || result.target?.problem || result.reason;
      setHTML(target, html`
        <p class="sx-help">${t('agentsStudio.nativeExport.revision', { n: result.revision })}</p>
        ${result.target?.path ? html`<p class="ax-export-path">${result.target.path}</p>` : ''}
        ${problem ? html`<p class="sx-note sx-note--err" role="alert">${typeof problem === 'string' ? problem : JSON.stringify(problem)}</p>` : ''}
        ${result.target?.exists ? html`<p class="sx-note">${t('agentsStudio.nativeExport.replace')}</p>` : ''}
        ${result.content !== undefined ? html`<pre class="ax-export-content" tabindex="0">${result.content}</pre>` : ''}
        <h4 class="sx-section-title">${t('agentsStudio.nativeExport.omitted')}</h4>
        ${result.unrepresented?.length ? html`<ul>${result.unrepresented.map((row) => html`<li><strong>${row.field}</strong>: ${row.reason}</li>`)}</ul>` : html`<p class="sx-help">${t('agentsStudio.nativeExport.noneOmitted')}</p>`}
        ${(result.notes || []).map((note) => html`<p class="sx-help">${note}</p>`)}`);
      ready = result.supported && result.approved && result.writable && result.target?.writable && !!result.digest;
      ui.setDisabled('write', !ready);
    } catch (error) { if (open && id === loadId) sayError(error); }
  }
  async function init() {
    try {
      const { formats, writes } = await ctx.api.nativeFormats();
      if (!open) return;
      const host = formats.find((f) => f.supported && f.host === ed.agent.approvedDefinition.provider)?.host || formats.find((f) => f.supported)?.host;
      const projects = ctx.info?.projects || [];
      const scope = ed.agent.approvedDefinition.scope;
      const projectDefault = scope?.kind === 'project' && projects.some((p) => p.path === scope.path);
      const targets = [{ value: 'account', label: t('agentsStudio.nativeExport.account'), selected: !projectDefault }, ...projects.map((p) => ({ value: `project:${p.path}`, label: p.label || p.path, caption: p.path, selected: projectDefault && p.path === scope.path }))];
      setHTML(extra, html`<div class="ax-fields">
        ${field({ id: 'ax-export-host', label: t('agentsStudio.nativeExport.host'), control: dropdown('ax-export-host', nativeHostOptions(formats, host), { label: t('agentsStudio.nativeExport.host') }) })}
        ${field({ id: 'ax-export-target', label: t('agentsStudio.nativeExport.target'), control: dropdown('ax-export-target', targets, { label: t('agentsStudio.nativeExport.target') }) })}
        </div><div id="ax-export-preview" aria-live="polite"></div>`);
      wireDropdowns(extra, { signal: life.signal });
      if (!writes || !host) { sayError(new Error(t('agentsStudio.nativeExport.unavailable'))); return; }
      await preview();
    } catch (error) { if (open) sayError(error); }
  }
  extra.addEventListener('change', () => { if (!writing) preview(); }, { signal: life.signal });
  extra.addEventListener('click', (event) => {
    if (!event.target.closest('[data-export-retry]') || writing) return;
    if (extra.querySelector('#ax-export-host')) preview(); else init();
  }, { signal: life.signal });
  try {
    await ctx.ask({
      title: t('agentsStudio.nativeExport.title', { name: ed.agent.name || ed.key.id }),
      lines: [t('agentsStudio.nativeExport.help')], extra, wide: true, className: 'ax-dlg', focus: 'cancel',
      buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'write', label: t('agentsStudio.nativeExport.confirm'), kind: 'primary', disabled: true }],
      onOpen(value) { ui = value; init(); },
      accept(answer, dialog) {
        if (answer !== 'write' || written) return true;
        if (!ready || writing) return false;
        writing = true; ready = false; dialog.setDisabled('write', true);
        for (const button of extra.querySelectorAll('.cc-dropdown-trigger')) button.disabled = true;
        session.write().then(() => {
          written = true;
          ctx.toast(t('agentsStudio.nativeExport.written'));
          if (open) dialog.done('write');
        }, (error) => { if (open) sayError(error); }).finally(() => {
          writing = false;
          for (const button of extra.querySelectorAll('.cc-dropdown-trigger')) button.disabled = false;
        });
        return false;
      },
    });
  } finally { open = false; ++loadId; session.close(); life.abort(); }
}
