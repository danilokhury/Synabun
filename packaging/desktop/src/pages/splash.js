// The splash page: it draws what the app sends (main.mjs, src/splash-model.mjs splashView) and nothing else.
// Every sentence comes translated from the app; the page only shows the mascot's lines in turn while a stage lasts.
(() => {
  const $ = (id) => document.getElementById(id);
  const bridge = window.synabunSplash;
  let stage = null;
  let lines = [];
  let turn = 0;
  let timer = null;
  let lineMs = 4200;

  const lessMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  };

  const setText = (id, text) => {
    const el = $(id);
    const value = text || '';
    if (el.textContent !== value) el.textContent = value;
  };

  /** One line in the bubble; a new one pops in (still, under reduced motion). */
  function say(text) {
    const el = $('say');
    if (el.textContent === text) return;
    el.textContent = text || '';
    const bubble = $('bubble');
    bubble.classList.remove('pop');
    if (text && !lessMotion()) {
      void bubble.offsetWidth;
      bubble.classList.add('pop');
    }
  }

  function keepTalking() {
    clearInterval(timer);
    timer = null;
    if (lines.length < 2) return;
    timer = setInterval(() => {
      turn = (turn + 1) % lines.length;
      say(lines[turn]);
    }, lineMs);
  }

  const sameLines = (a, b) => a.length === b.length && a.every((line, index) => line === b[index]);

  function render(view) {
    if (!view || typeof view !== 'object') return;
    document.documentElement.lang = view.lang || 'en';
    document.body.dataset.stage = view.stage || 'checking';
    $('mascot').dataset.state = view.mascot || 'waking';
    $('pills').dataset.state = view.mascot || 'waking';
    setText('status', view.status);
    if (Number(view.lineMs) >= 1000) lineMs = Number(view.lineMs);
    const next = Array.isArray(view.lines) ? view.lines.map(String) : [];
    // A new stage starts at its first line; the same stage keeps its turn.
    if (view.stage !== stage || !sameLines(next, lines)) {
      stage = view.stage;
      lines = next;
      turn = 0;
      say(lines[0] || '');
      keepTalking();
    }
    const bar = $('bar');
    const fill = $('fill');
    const percent = view.progress && view.progress.percent !== null && view.progress.percent !== undefined ? Number(view.progress.percent) : null;
    if (percent === null || !Number.isFinite(percent)) {
      bar.dataset.mode = 'travel';
      fill.style.width = '';
      bar.removeAttribute('aria-valuenow');
    } else {
      bar.dataset.mode = 'value';
      fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(percent)));
    }
    setText('meta', view.progress?.label || '');
    setText('details', view.details || 'Details');
  }

  $('wordmark').addEventListener('error', () => { $('wordmark').hidden = true; });
  $('details').addEventListener('click', () => { bridge?.action('details'); });
  if (bridge) {
    bridge.onState(render);
    bridge.ready();
  }
})();
