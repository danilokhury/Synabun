import { acceptExtensionUpdate, refreshExtensionUpdate, watchExtensionUpdate } from '../browser-extension-updates.js';
import { extensionUpdateView } from '../extension-update-view.js';

// A sibling of the connection controls so an installed extension can be updated in any browser mode.
export function extensionUpdateHTML(kit) {
  const t = key => kit.te(`browserExtension.updateFlow.${key}`);
  const button = (id, key, primary = false) => `<button type="button" class="cli-detect-btn${primary ? ' bc-ext-primary' : ''}" data-update-action="${id}">${t(key)}</button>`;
  return `<section class="stg-field bc-extension" id="bc-extension-update-flow" aria-labelledby="bc-update-title" hidden>
    <div class="bc-ext-part">
      <h4 class="stg-subhead" id="bc-update-title" tabindex="-1"></h4>
      <p class="stg-help bc-ext-text" id="bc-update-notes" hidden></p>
      <p class="stg-help bc-ext-text" id="bc-update-status" role="status"></p>
      <progress id="bc-update-progress" max="100" aria-labelledby="bc-update-status" hidden></progress>
      <div class="bc-inline-group bc-ext-actions" id="bc-update-actions" hidden>
        ${button('reload', 'now', true)}${button('retry', 'retry')}${button('guide', 'showSteps')}
      </div>
      <div class="bc-ext-confirm" id="bc-update-warning" role="group" aria-labelledby="bc-update-warning-title" hidden>
        <p id="bc-update-warning-title" class="stg-help bc-ext-text">${t('busy')}</p>
        <div class="bc-inline-group bc-ext-actions">${button('wait', 'wait')}${button('continue', 'goAhead')}</div>
      </div>
      <ol class="stg-help" id="bc-update-guide" hidden>
        <li>${t('stepOpen')}
          <div class="bc-inline-group bc-ext-actions">${button('chrome', 'copyChrome')}${button('edge', 'copyEdge')}</div>
        </li>
        <li>${t('stepReload')}</li><li id="bc-update-detect"></li>
      </ol>
      <div class="bc-inline-group bc-ext-actions" id="bc-update-verify" hidden>
        ${button('confirm', 'confirm')}<a class="cli-detect-btn" href="/extension-setup" target="_blank" rel="noopener">${t('checkPort')}</a>
      </div>
      <p class="stg-help bc-ext-text" id="bc-update-feedback" role="status" hidden></p>
    </div>
  </section>`;
}

export function wireExtensionUpdate(root, { tx, signal }) {
  const panel = root.querySelector('#bc-extension-update-flow');
  if (!panel) return;
  const find = id => panel.querySelector(`#bc-update-${id}`);
  const action = name => panel.querySelector(`[data-update-action="${name}"]`);
  const t = (key, params) => tx(`browserExtension.updateFlow.${key}`, params);
  const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  let update, view, warning = null, allowGuide = false, posting = false;
  function feedback(text) { find('feedback').hidden = !text; put(find('feedback'), text); }
  function render(next) {
    const previouslyBusy = update?.confirmBusy;
    const model = extensionUpdateView(next, tx);
    if (model?.key !== view?.key || model?.guided !== view?.guided || !model?.due) {
      warning = null; allowGuide = false; feedback('');
    }
    update = next; view = model; panel.hidden = !view;
    if (!view) return;
    put(find('title'), view.title); put(find('status'), view.message);
    put(find('notes'), view.notes); find('notes').hidden = !view.notes;
    find('status').hidden = !view.message;
    const progress = find('progress');
    progress.hidden = update.phase !== 'downloading' || !!update.pending; if (!progress.hidden) progress.value = update.percent;
    if (!view.updateNow && !view.guided) warning = null;
    if (next.confirmBusy && view.updateNow && !previouslyBusy) warning = 'reload';
    const warnGuide = view.guided && view.busy && !allowGuide;
    action('guide').hidden = !warnGuide;
    action('reload').hidden = !view.updateNow; action('retry').hidden = !view.retry && !view.download;
    put(action('retry'), t(view.download ? 'download' : 'retry'));
    find('actions').hidden = !!warning || !(view.updateNow || view.retry || view.download || warnGuide);
    find('warning').hidden = !warning;
    put(action('continue'), t(warning === 'guide' ? 'showSteps' : 'goAhead'));
    find('guide').hidden = !view.guided || warnGuide;
    put(find('detect'), t(view.confirmRepair ? 'stepConfirm' : view.checkPort ? 'stepPort' : 'stepDetect'));
    action('confirm').hidden = !view.confirmRepair;
    find('verify').querySelector('a').hidden = !view.checkPort;
    find('verify').hidden = (!view.confirmRepair && !view.checkPort) || !!warning || warnGuide;
    for (const button of panel.querySelectorAll('button')) button.disabled = posting;
  }
  const off = watchExtensionUpdate(render);
  signal.addEventListener('abort', off, { once: true });
  async function post(path, body) {
    let focusWarning = false;
    posting = true; feedback(''); render(update);
    try {
      const response = await fetch(`/api/browser/extension/${path}`, { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' }, body: JSON.stringify(body) });
      const value = await response.json();
      if (signal.aborted) return;
      if (value.update) acceptExtensionUpdate(value.update);
      if (value.code === 'RELOAD_BUSY') { warning = 'reload'; focusWarning = true; }
      else if (!response.ok && !value.update) feedback(t('actionFailed'));
      await refreshExtensionUpdate();
    } catch { if (!signal.aborted) feedback(t('actionFailed')); }
    finally {
      posting = false;
      if (!signal.aborted) { render(update); if (focusWarning && warning) action('wait').focus(); }
    }
  }
  function warn(kind) { warning = kind; render(update); action('wait').focus(); }
  panel.addEventListener('click', async event => {
    const name = event.target.closest('[data-update-action]')?.dataset.updateAction;
    if (!name || !view || posting || event.isTrusted === false) return;
    if (name === 'chrome' || name === 'edge') {
      const url = name === 'edge' ? 'edge://extensions' : 'chrome://extensions';
      try { await navigator.clipboard.writeText(url); feedback(t('copied', { url })); }
      catch { feedback(t('copyManually', { url })); }
      return;
    }
    if (name === 'wait') { const opener = warning; warning = null; render(update); action(opener)?.focus(); return; }
    if (name === 'continue' && warning) {
      const choice = warning; warning = null;
      if (choice === 'guide') { allowGuide = true; render(update); action('chrome').focus(); }
      else await post('reload', { targetVersion: update.targetVersion, allowBusy: true });
    } else if (name === 'guide') warn('guide');
    else if (name === 'reload' && view.updateNow) {
      if (view.busy) warn('reload'); else await post('reload', { targetVersion: update.targetVersion, allowBusy: false });
    } else if (name === 'retry' && (view.retry || view.download)) await post('update', {});
    else if (name === 'confirm' && view.confirmRepair) await post('reload/confirm', { reloaded: true });
  }, { signal });
}
