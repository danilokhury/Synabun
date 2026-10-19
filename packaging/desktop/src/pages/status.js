// The app's status page: it draws what the app sends (main.mjs showStatus) and
// nothing else. Every sentence comes translated from the app.
(() => {
  const $ = (id) => document.getElementById(id);
  const shell = window.synabunShell;
  let startedAt = 0;
  let timer = null;

  const formatElapsed = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
  };

  const tick = () => {
    const el = $('elapsed');
    if (!startedAt) { el.textContent = ''; return; }
    el.textContent = formatElapsed(Date.now() - startedAt);
  };

  const setText = (id, text) => {
    const el = $(id);
    const value = text || '';
    if (el.textContent !== value) el.textContent = value;
  };

  // The Details area: the start's live log. It opens by itself when the app says so (a first start, a failure),
  // never closes on its own, and follows the newest line unless the reader has scrolled up.
  let logOpenedByApp = false;
  let logTouched = false;
  const LOG_KEEP = 400;
  function appendLog(change) {
    if (!change || !Array.isArray(change.lines)) return;
    const box = $('log-lines');
    const following = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
    const kept = change.reset ? [] : (box.textContent ? box.textContent.split('\n') : []);
    const next = [...kept, ...change.lines.map(line => String(line))].slice(-LOG_KEEP);
    box.textContent = next.join('\n');
    $('log').hidden = next.length === 0;
    if (following || change.reset) box.scrollTop = box.scrollHeight;
  }
  $('log').addEventListener('toggle', () => { if (!logOpenedByApp) logTouched = true; logOpenedByApp = false; });

  function render(status) {
    if (!status || typeof status !== 'object') return;
    document.documentElement.lang = status.lang || 'en';
    $('status').dataset.state = status.state || 'starting';
    setText('heading', status.heading);
    setText('line', status.line);
    setText('hint', status.hint);
    const detail = $('detail');
    detail.hidden = !status.detail;
    detail.textContent = status.detail || '';
    setText('log-label', status.detailsLabel || 'Details');
    if (status.detailsOpen && !logTouched && !$('log').open) { logOpenedByApp = true; $('log').open = true; }
    $('elapsed').setAttribute('aria-label', status.elapsedLabel || '');
    startedAt = status.busy ? Number(status.startedAt) || 0 : 0;
    clearInterval(timer);
    if (startedAt) timer = setInterval(tick, 1000);
    tick();
    const actions = $('actions');
    actions.replaceChildren(...(status.actions || []).map((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      if (action.primary) button.className = 'primary';
      button.addEventListener('click', () => {
        for (const other of actions.querySelectorAll('button')) other.disabled = true;
        shell?.action(action.id);
      });
      return button;
    }));
    const first = actions.querySelector('button.primary') || actions.querySelector('button');
    if (first && !status.busy) first.focus({ preventScroll: true });
  }

  $('mark').addEventListener('error', () => { $('mark').hidden = true; });
  if (shell) {
    shell.onStatus(render);
    shell.onLog?.(appendLog);
    shell.ready();
  }
})();
