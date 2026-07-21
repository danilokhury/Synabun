// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Slash-command suggestions (port of v1's #ocp-slash-hints)
// One instance per compose. Owns its own panel DOM scoped inside the compose
// root so child/floating OCP v2 panels each get their own picker. Catalog is
// module-shared (single fetch) but render state is per-instance.
// ─────────────────────────────────────────────────────────────────────────────

// `tui: true` marks commands that have no v2 SDK equivalent — selecting them
// in the picker should launch the OpenCode CLI in the Terminal panel and
// auto-type the slash, rather than sending it as a chat prompt (the v2 server
// would echo it back). Commands without `tui` have a working v2 API path or
// are routed by us in-panel.
const BUILTIN_SLASH_COMMANDS = [
  { name: 'new',       description: 'Start a new session',                          source: 'builtin' },
  { name: 'sessions',  description: 'List & switch sessions',                       source: 'builtin', tui: true },
  { name: 'resume',    description: 'Resume a session',                             source: 'builtin' },
  { name: 'continue',  description: 'Continue last session',                        source: 'builtin' },
  { name: 'share',     description: 'Share current session',                        source: 'builtin' },
  { name: 'unshare',   description: 'Stop sharing session',                         source: 'builtin' },
  { name: 'export',    description: 'Export session as JSON',                       source: 'builtin' },
  { name: 'import',    description: 'Import session from JSON',                     source: 'builtin' },
  { name: 'compact',   description: 'Compact context', aliases: ['summarize'],      source: 'builtin' },
  { name: 'clear',     description: 'Clear all messages',                           source: 'builtin' },
  { name: 'undo',      description: 'Undo last message',                            source: 'builtin' },
  { name: 'redo',      description: 'Redo undone message',                          source: 'builtin' },
  { name: 'models',    description: 'Pick a model',                                 source: 'builtin', tui: true },
  { name: 'providers', description: 'Manage providers & auth',                      source: 'builtin', tui: true },
  { name: 'agents',    description: 'Switch agent', aliases: ['agent'],             source: 'builtin', tui: true },
  { name: 'themes',    description: 'Pick a theme',                                 source: 'builtin', tui: true },
  { name: 'init',      description: 'Initialize project (AGENTS.md)',               source: 'builtin', tui: true },
  { name: 'editor',    description: 'Open in editor',                               source: 'builtin', tui: true },
  { name: 'tokens',    description: 'Token usage stats',                            source: 'builtin', tui: true },
  { name: 'config',    description: 'Open config',                                  source: 'builtin', tui: true },
  { name: 'login',     description: 'Provider login',                               source: 'builtin', tui: true },
  { name: 'logout',    description: 'Provider logout',                              source: 'builtin', tui: true },
  { name: 'help',      description: 'Show help',                                    source: 'builtin', tui: true },
  { name: 'exit',      description: 'Exit OpenCode', aliases: ['quit'],             source: 'builtin', tui: true },
];

let SLASH_COMMANDS = [...BUILTIN_SLASH_COMMANDS];
let _catalogPromise = null;
const _instances = new Set();

function loadCatalog() {
  if (_catalogPromise) return _catalogPromise;
  const seen = new Set();
  for (const c of BUILTIN_SLASH_COMMANDS) {
    seen.add(c.name);
    (c.aliases || []).forEach((a) => seen.add(a));
  }
  _catalogPromise = Promise.allSettled([
    fetch('/api/skills').then((r) => r.json()).catch(() => null),
    fetch('/api/opencode/commands').then((r) => r.json()).catch(() => null),
  ]).then(([skillsRes, userRes]) => {
    const merged = [...BUILTIN_SLASH_COMMANDS];
    const skills = Array.isArray(skillsRes.value?.skills) ? skillsRes.value.skills : [];
    for (const s of skills) {
      const name = String(s.name || s.dirName || '').trim();
      if (!name || seen.has(name)) continue;
      merged.push({ name, description: String(s.description || '').trim(), source: 'skill' });
      seen.add(name);
    }
    const userCmds = Array.isArray(userRes.value?.commands) ? userRes.value.commands : [];
    for (const c of userCmds) {
      const name = String(c.name || '').trim();
      if (!name || seen.has(name)) continue;
      merged.push({ name, description: String(c.description || '').trim(), source: 'user' });
      seen.add(name);
    }
    SLASH_COMMANDS = merged;
    for (const inst of _instances) inst.refresh();
    return SLASH_COMMANDS;
  });
  return _catalogPromise;
}

loadCatalog();

// ── Public mount API ────────────────────────────────────────────────────────

export function mountSlashHints(rootEl, inputEl, options = {}) {
  if (!rootEl || !inputEl) return { destroy() {}, isOpen: () => false };

  const onTuiSelect = typeof options.onTuiSelect === 'function' ? options.onTuiSelect : null;

  const browser = document.createElement('div');
  browser.className = 'ocpv2-slash-browser';
  browser.hidden = true;
  rootEl.appendChild(browser);

  let activeIdx = -1;
  let query = '';
  let token = null;
  let items = [];

  function isOpen() { return browser.classList.contains('open'); }

  function hide() {
    if (!isOpen()) return;
    browser.classList.remove('open');
    browser.innerHTML = '';
    browser.hidden = true;
    activeIdx = -1;
    items = [];
    token = null;
    query = '';
  }

  function show(q, tokenInfo) {
    query = q || '';
    token = tokenInfo || token;

    const scored = [];
    for (const cmd of SLASH_COMMANDS) {
      const m = rankSlashMatch(cmd, query);
      if (!m) continue;
      scored.push({ cmd, score: m.score, indices: m.indices });
    }
    scored.sort((a, b) => (b.score - a.score) || a.cmd.name.localeCompare(b.cmd.name));

    const groups = {};
    for (const entry of scored) {
      const src = entry.cmd.source || 'builtin';
      (groups[src] ||= []).push(entry);
    }

    browser.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'ocpv2-slash-search';
    header.innerHTML = `
      <span class="ocpv2-slash-search-icon">/</span>
      <span class="ocpv2-slash-query">${esc(query)}</span>
      <span class="ocpv2-slash-count">${scored.length} result${scored.length === 1 ? '' : 's'}</span>
    `;
    browser.appendChild(header);

    const list = document.createElement('div');
    list.className = 'ocpv2-slash-list';
    browser.appendChild(list);

    items = [];
    if (!scored.length) {
      const empty = document.createElement('div');
      empty.className = 'ocpv2-slash-empty';
      empty.textContent = query ? `No commands match /${query}` : 'No commands available';
      list.appendChild(empty);
    } else {
      for (const src of SLASH_GROUP_ORDER) {
        const entries = groups[src];
        if (!entries?.length) continue;
        const group = document.createElement('div');
        group.className = 'ocpv2-slash-group';
        const gh = document.createElement('div');
        gh.className = 'ocpv2-slash-group-header';
        gh.textContent = SLASH_GROUP_LABEL[src] || src;
        group.appendChild(gh);
        for (const entry of entries) {
          const itemIdx = items.length;
          const item = document.createElement('div');
          item.className = 'ocpv2-slash-item' + (itemIdx === 0 ? ' active' : '');
          item.dataset.name = entry.cmd.name;
          item.dataset.source = src;
          const tui = !!entry.cmd.tui;
          if (tui) item.classList.add('ocpv2-slash-item-tui');
          const descBase = esc(entry.cmd.description || '');
          const descHtml = tui
            ? `${descBase}<span class="ocpv2-slash-tag">CLI</span>`
            : descBase;
          item.innerHTML = `
            <span class="ocpv2-slash-icon" data-source="${src}">${src === 'builtin' ? '▸' : src === 'skill' ? '✦' : '★'}</span>
            <span class="ocpv2-slash-name">${renderHighlightedName(entry.cmd.name, entry.indices)}</span>
            <span class="ocpv2-slash-desc">${descHtml}</span>
          `;
          // mousedown not click — click fires after blur, by which point the
          // textarea no longer has focus and our token caret is gone.
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            activeIdx = itemIdx;
            applySelected();
          });
          item.addEventListener('mousemove', () => {
            if (activeIdx === itemIdx) return;
            items[activeIdx]?.el?.classList.remove('active');
            activeIdx = itemIdx;
            item.classList.add('active');
          });
          group.appendChild(item);
          items.push({ name: entry.cmd.name, el: item, cmd: entry.cmd });
        }
        list.appendChild(group);
      }
    }

    activeIdx = items.length ? 0 : -1;
    browser.hidden = false;
    browser.classList.add('open');
  }

  function refreshFromInput() {
    const tk = detectSlashToken(inputEl);
    if (tk) show(tk.query, tk);
    else hide();
  }

  function navigate(dir) {
    if (!items.length) return;
    items[activeIdx]?.el?.classList.remove('active');
    activeIdx = Math.max(0, Math.min(items.length - 1, activeIdx + dir));
    const next = items[activeIdx]?.el;
    if (next) {
      next.classList.add('active');
      next.scrollIntoView({ block: 'nearest' });
    }
  }

  function applySelected() {
    const sel = items[activeIdx];
    if (!sel || !token) { hide(); return false; }
    // TUI-only commands have no v2 SDK path. Hand them to the caller-provided
    // hook (which routes to the Terminal panel) and clear the typed `/cmd`
    // token from the input so the textarea isn't left with a dead prefix.
    if (sel.cmd?.tui && onTuiSelect) {
      const before = inputEl.value.slice(0, token.start);
      const after = inputEl.value.slice(token.end);
      inputEl.value = before + after;
      try { inputEl.setSelectionRange(before.length, before.length); } catch {}
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
      try { onTuiSelect(sel.cmd); }
      catch (err) { console.warn('[ocp-v2-slash-hints] onTuiSelect threw', err); }
      return true;
    }
    const before = inputEl.value.slice(0, token.start);
    const after = inputEl.value.slice(token.end);
    const insert = '/' + sel.name + ' ';
    inputEl.value = before + insert + after;
    const caret = (before + insert).length;
    try { inputEl.setSelectionRange(caret, caret); } catch {}
    inputEl.focus();
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    hide();
    return true;
  }

  function onInput() { refreshFromInput(); }
  function onBlur() {
    // Defer so mousedown on a hint can fire applySelected first.
    setTimeout(() => { if (document.activeElement !== inputEl) hide(); }, 120);
  }

  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('blur', onBlur);

  const instance = { refresh: refreshFromInput };
  _instances.add(instance);

  return {
    isOpen,
    hide,
    navigate,
    applySelected,
    refresh: refreshFromInput,
    destroy() {
      inputEl.removeEventListener('input', onInput);
      inputEl.removeEventListener('blur', onBlur);
      _instances.delete(instance);
      hide();
      browser.remove();
    },
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

const SLASH_GROUP_ORDER = ['builtin', 'skill', 'user'];
const SLASH_GROUP_LABEL = { builtin: 'OpenCode', skill: 'Skills', user: 'Custom' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function detectSlashToken(inputEl) {
  if (!inputEl) return null;
  const pos = inputEl.selectionStart ?? inputEl.value.length;
  const value = inputEl.value;
  let tokenStart = pos;
  while (tokenStart > 0 && !/\s/.test(value[tokenStart - 1])) tokenStart--;
  const tk = value.slice(tokenStart, pos);
  if (!tk.startsWith('/')) return null;
  if (tokenStart > 0) {
    const prev = value[tokenStart - 1];
    if (prev === ':' || prev === '/') return null;
  }
  if (/^\/\/+/.test(tk)) return null;
  return { start: tokenStart, end: pos, query: tk.slice(1) };
}

function scoreSlashMatch(name, query) {
  if (!query) return { score: 1, indices: [] };
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return { score: 1000, indices: [...q].map((_, i) => i) };
  if (n.startsWith(q)) return { score: 700 - (n.length - q.length), indices: [...q].map((_, i) => i) };
  const idx = n.indexOf(q);
  if (idx !== -1) return { score: 400 - idx, indices: [...q].map((_, i) => idx + i) };
  let qi = 0, score = 0, lastIdx = -2;
  const indices = [];
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) {
      score += (lastIdx === i - 1) ? 8 : 4;
      indices.push(i);
      lastIdx = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return { score: 100 + score, indices };
}

function rankSlashMatch(cmd, query) {
  let best = scoreSlashMatch(cmd.name, query);
  for (const alias of (cmd.aliases || [])) {
    const m = scoreSlashMatch(alias, query);
    if (m && (!best || m.score > best.score)) best = { score: m.score, indices: [] };
  }
  return best;
}

function renderHighlightedName(name, indices) {
  if (!indices?.length) return '/' + esc(name);
  const set = new Set(indices);
  let out = '/';
  for (let i = 0; i < name.length; i++) {
    out += set.has(i) ? `<span class="ocpv2-slash-hl">${esc(name[i])}</span>` : esc(name[i]);
  }
  return out;
}
