// ═══════════════════════════════════════════
// SynaBun Chat — Claude Code skin
// Stream-JSON renderer with model/project/branch selection
// ═══════════════════════════════════════════

import { storage } from '/shared/storage.js';
import { restoreInterfaceConfig, restoreSkin } from '/shared/ui-settings.js';
import { fetchClaudeSessions } from '/shared/api.js';
import { mountSessionWidget } from '/shared/ui-sessions.js';

restoreInterfaceConfig();
restoreSkin();

// ── Markdown (lazy CDN load) ──
let marked = null;
(async () => {
  try {
    const m = await import('https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js').catch(() => null);
    if (m) {
      marked = m.marked || m.default;
      if (marked?.setOptions) marked.setOptions({ breaks: true, gfm: true });
    }
  } catch {}
})();

function md(text) {
  if (!marked) return esc(text).replace(/\n/g, '<br>');
  try { return marked.parse(text); }
  catch { return esc(text).replace(/\n/g, '<br>'); }
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const CLAUDE_ICON = '<svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';

// ── State ──
let ws = null;
let reconnectTimer = null;
let sessionId = null;
let running = false;
let totalCost = 0;
let thinkingEl = null;
let sendStartTime = null;
let thinkTimerInterval = null;
let attachedFiles = [];

const STOR = {
  session: 'synabun-chat-session',
  project: 'synabun-chat-project',
  model: 'synabun-chat-model',
};

// ── Tab-scoped storage for session isolation ──
// Uses browser sessionStorage so each browser tab has its own project/model/session.
// Falls back to server-synced storage for initial defaults on first load.
const tabStore = {
  getItem(key) { return sessionStorage.getItem(key); },
  setItem(key, val) { sessionStorage.setItem(key, val); },
  removeItem(key) { sessionStorage.removeItem(key); },
};

// ── Clipboard fallback for non-secure contexts ──
function _clipCopy(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => _clipFallback(text));
  } else {
    _clipFallback(text);
  }
}
function _clipFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}

// ── DOM ──
const $ = (id) => document.getElementById(id);
const $msgs = $('messages');
const $input = $('chat-input');
const $send = $('chat-send-btn');
const $cost = $('chat-cost');
const $project = $('project-select');
const $branch = $('branch-select');
const $model = $('model-select');
const $newBtn = $('chat-new-btn');

// ── Config ──
let projects = [];
let models = [];

async function loadConfig() {
  try {
    const res = await fetch('/api/claude/config').then(r => r.json());
    if (!res.ok) return;

    projects = res.projects || [];
    models = res.models || [];

    // Populate project selector
    $project.innerHTML = '<option value="">Select project...</option>';
    for (const p of projects) {
      const label = p.label || p.path.split(/[/\\]/).pop();
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = label;
      $project.appendChild(opt);
    }

    // Restore saved project (tab-scoped, falls back to server default on first load)
    const saved = tabStore.getItem(STOR.project) || storage.getItem(STOR.project);
    if (saved && projects.some(p => p.path === saved)) {
      $project.value = saved;
      tabStore.setItem(STOR.project, saved);
      loadBranches(saved);
    }

    // Populate model selector
    $model.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      $model.appendChild(opt);
    }

    // Restore saved model (tab-scoped only — no cross-session bleed)
    const savedModel = tabStore.getItem(STOR.model);
    if (savedModel) { $model.value = savedModel; }

  } catch {}
}

async function loadBranches(projectPath) {
  $branch.innerHTML = '<option value="">branch</option>';
  if (!projectPath) return;
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(projectPath)}`).then(r => r.json());
    if (res.branches?.length) {
      $branch.innerHTML = '';
      for (const b of res.branches) {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        if (b === res.current) opt.selected = true;
        $branch.appendChild(opt);
      }
    }
  } catch {}
}

// ── Events ──
$project.addEventListener('change', () => {
  tabStore.setItem(STOR.project, $project.value);
  loadBranches($project.value);
});

$model.addEventListener('change', () => {
  tabStore.setItem(STOR.model, $model.value);
});

$branch.addEventListener('change', async () => {
  const branch = $branch.value;
  const path = $project.value;
  if (!branch || !path) return;
  try {
    await fetch('/api/terminal/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, branch }),
    });
  } catch {}
});

// ── WebSocket ──
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/claude-skin`);

  ws.addEventListener('open', () => clearTimeout(reconnectTimer));

  ws.addEventListener('message', (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch {}
  });

  ws.addEventListener('close', () => {
    if (running) appendStatus('Connection lost. Reconnecting...');
    reconnectTimer = setTimeout(connect, 2000);
  });

  ws.addEventListener('error', () => ws.close());
}

// ── Message dispatch ──
function handleMsg(msg) {
  switch (msg.type) {
    case 'event': handleEvent(msg.event); break;
    case 'control_request': handleControlRequest(msg); break;
    case 'stderr':
      if (msg.text?.trim()) appendStatus(msg.text.trim());
      break;
    case 'done': finish(); break;
    case 'aborted': finish(); appendStatus('Aborted.'); break;
    case 'error': finish(); appendError(msg.message); break;
  }
}

function handleEvent(ev) {
  if (!ev?.type) return;

  // init
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.session_id) {
      sessionId = ev.session_id;
      tabStore.setItem(STOR.session, ev.session_id);
    }
    // Don't hide thinking on init — Claude is still working
    return;
  }

  // assistant message
  if (ev.type === 'assistant' && ev.message) {
    renderAssistant(ev.message);
    repositionThinking(); // keep indicator at bottom, below new content
    return;
  }

  // tool result
  if (ev.type === 'tool_result') {
    updateToolResult(ev);
    return;
  }

  // final result
  if (ev.type === 'result') {
    finish();
    if (ev.total_cost_usd != null) {
      totalCost += ev.total_cost_usd;
      const monthLabel = new Date().toLocaleString('en', { month: 'short' });
      $cost.textContent = `${monthLabel}: $${totalCost.toFixed(2)}`;
      $cost.classList.add('flash');
      setTimeout(() => $cost.classList.remove('flash'), 800);
    }
    if (ev.session_id) {
      sessionId = ev.session_id;
      tabStore.setItem(STOR.session, ev.session_id);
    }
  }
}

// ── Render ──
function renderAssistant(msg) {
  const content = msg.content || [];
  const thinks = content.filter(b => b.type === 'thinking');
  const texts = content.filter(b => b.type === 'text');
  const tools = content.filter(b => b.type === 'tool_use');
  if (!texts.length && !tools.length && !thinks.length) return;

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = 'S';
  el.appendChild(avatar);

  // Content wrapper
  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  if (thinks.length) {
    const thinkText = thinks.map(b => b.thinking || '').join('\n').trim();
    if (thinkText) {
      const thinkEl = document.createElement('details');
      thinkEl.className = 'msg-thinking';
      thinkEl.innerHTML = `<summary><span class="msg-thinking-icon">&#x26A1;</span><span class="msg-thinking-label">Thinking</span><span class="msg-thinking-chevron">&#x203A;</span></summary><div class="msg-thinking-content"></div>`;
      thinkEl.querySelector('.msg-thinking-content').textContent = thinkText;
      wrap.appendChild(thinkEl);
    }
  }

  if (texts.length) {
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = md(texts.map(b => b.text).join('\n'));
    addCodeLabels(body);
    linkifyFilePaths(body);
    wrap.appendChild(body);
  }

  for (const t of tools) wrap.appendChild(buildTool(t));

  el.appendChild(wrap);
  $msgs.appendChild(el);
  scrollEnd();
}

function buildTool(block) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolId = block.id || '';

  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr';

  const icon = toolIcon(block.name);
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = block.name;

  const detail = document.createElement('span');
  detail.className = 'tool-detail';
  detail.textContent = toolDetail(block);

  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  chevron.innerHTML = '&#x203A;';

  hdr.appendChild(icon);
  hdr.appendChild(name);
  hdr.appendChild(detail);
  hdr.appendChild(chevron);
  hdr.addEventListener('click', () => card.classList.toggle('open'));

  const body = document.createElement('div');
  body.className = 'tool-body';

  if (block.input && Object.keys(block.input).length) {
    const lbl = document.createElement('div');
    lbl.className = 'tool-section-label';
    lbl.textContent = 'INPUT';
    const sec = document.createElement('pre');
    sec.className = 'tool-section';
    sec.textContent = JSON.stringify(block.input, null, 2);
    body.appendChild(lbl);
    body.appendChild(sec);
  }

  // Result placeholder
  const rLbl = document.createElement('div');
  rLbl.className = 'tool-section-label tool-result-label';
  rLbl.textContent = 'RESULT';
  rLbl.hidden = true;
  const rSec = document.createElement('pre');
  rSec.className = 'tool-section tool-result-content';
  rSec.hidden = true;
  body.appendChild(rLbl);
  body.appendChild(rSec);

  card.appendChild(hdr);
  card.appendChild(body);
  return card;
}

function updateToolResult(ev) {
  const card = $msgs.querySelector(`.tool-card[data-tool-id="${CSS.escape(ev.tool_use_id)}"]`);
  if (!card) return;

  const rLbl = card.querySelector('.tool-result-label');
  const rSec = card.querySelector('.tool-result-content');
  if (!rSec) return;

  let text = '';
  if (Array.isArray(ev.content)) text = ev.content.map(b => b.text || b.data || '').join('\n');
  else if (typeof ev.content === 'string') text = ev.content;

  rSec.textContent = text.slice(0, 3000) + (text.length > 3000 ? '\n...' : '');
  rLbl.hidden = false;
  rSec.hidden = false;

  card.classList.add(ev.is_error ? 'tool-error' : 'tool-ok');
}

function toolDetail(block) {
  const i = block.input || {};
  if (['Read', 'Edit', 'Write'].includes(block.name)) return (i.file_path || i.path || '').split(/[/\\]/).pop() || '';
  if (block.name === 'Bash') return (i.command || '').slice(0, 50);
  if (block.name === 'Glob' || block.name === 'Grep') return i.pattern || '';
  return '';
}

function toolIcon(name) {
  const el = document.createElement('span');
  el.className = 'tool-icon';
  const map = {
    Read: 'F', Edit: 'E', Write: 'W', Bash: '$',
    Glob: '*', Grep: '?', Agent: 'A', WebSearch: 'S', WebFetch: 'U',
  };
  el.textContent = map[name] || '#';
  return el;
}

function addCodeLabels(el) {
  el.querySelectorAll('pre code').forEach(code => {
    const lang = (code.className || '').replace('language-', '').trim();
    if (lang) {
      const lbl = document.createElement('span');
      lbl.className = 'code-label';
      lbl.textContent = lang;
      code.parentElement.style.position = 'relative';
      code.parentElement.appendChild(lbl);
    }
  });
}

// ── File path linking ──
function linkifyFilePaths(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const pathRe = /(?:(?:[A-Za-z]:)?(?:[/\\][\w.@\-]+){2,}(?::(\d+))?)(?=\s|$|[)"',;])/g;
  for (const node of nodes) {
    if (node.parentElement?.closest('pre, code, a')) continue;
    const text = node.textContent;
    pathRe.lastIndex = 0;
    if (!pathRe.test(text)) continue;
    pathRe.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, match;
    while ((match = pathRe.exec(text))) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const a = document.createElement('a');
      a.className = 'file-link';
      a.href = '#';
      a.textContent = match[0];
      a.title = 'Click to copy path';
      const path = match[0].replace(/:\d+$/, '');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        _clipCopy(path);
        a.style.opacity = '0.5';
        setTimeout(() => a.style.opacity = '', 300);
      });
      frag.appendChild(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (last > 0) node.parentNode.replaceChild(frag, node);
  }
}

// ── Cost loading ──
async function loadMonthlyCost() {
  try {
    const res = await fetch('/api/claude-skin/cost').then(r => r.json());
    if (res.month) {
      totalCost = res.month.totalUsd || 0;
      const monthLabel = new Date().toLocaleString('en', { month: 'short' });
      $cost.textContent = `${monthLabel}: $${totalCost.toFixed(2)}`;
      $cost.title = `${res.month.queries || 0} queries this month`;
    }
  } catch {}
}

// ── File attachment ──
const TEXT_EXTENSIONS = new Set([
  'txt','md','js','ts','jsx','tsx','json','html','css','scss','less','xml','svg',
  'py','rb','go','rs','java','c','cpp','h','hpp','cs','php','sh','bash','zsh',
  'yml','yaml','toml','ini','cfg','conf','env','gitignore','dockerignore',
  'sql','graphql','proto','csv','tsv','log','diff','patch','vue','svelte',
  'mjs','cjs','mts','cts','astro','mdx','rst','tex','lua','r','swift','kt',
  'dockerfile','makefile','cmake','gradle','bat','ps1','fish',
]);
function isTextFile(name) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return TEXT_EXTENSIONS.has(ext) || !name.includes('.');
}

function buildPromptWithAttachments(userText) {
  if (!attachedFiles.length) return userText;
  let prompt = '';
  for (const f of attachedFiles) prompt += `<file path="${f.name}">\n${f.content}\n</file>\n\n`;
  prompt += userText;
  attachedFiles = [];
  updateAttachBadge();
  return prompt;
}

function updateAttachBadge() {
  const badge = $('chat-attach-badge');
  if (badge) {
    badge.textContent = attachedFiles.length || '';
    badge.hidden = !attachedFiles.length;
  }
}

// ── Session history ──
const LABEL_PREFIX = 'synabun-chat-label:';
function getLabel(id) { try { return storage.getItem(LABEL_PREFIX + id) || ''; } catch { return ''; } }
function cleanPrompt(raw) { return (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function relDate(d) {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), dy = Math.floor(ms / 86400000);
  if (m < 1) return 'now'; if (m < 60) return m + 'm ago'; if (h < 24) return h + 'h ago';
  return dy + 'd ago';
}
function timeGroup(d) {
  const now = new Date(), dt = new Date(d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = today - new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  if (diff <= 0) return 'Today'; if (diff <= 86400000) return 'Yesterday';
  if (diff <= 604800000) return 'This Week'; return 'Older';
}
function trunc(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }

async function renderSessionMenu() {
  const menu = $('chat-session-menu');
  if (!menu) return;
  menu.innerHTML = '<div class="sess-loading">loading...</div>';
  try {
    const currentProject = $project.value || undefined;
    const data = await fetchClaudeSessions({ limit: 30, project: currentProject });
    if (!data?.projects?.length) { menu.innerHTML = '<div class="sess-loading">no sessions</div>'; return; }
    let html = '<div class="sess-new">+ New chat</div>';
    for (const proj of data.projects) {
      const groups = {};
      for (const s of (proj.sessions || [])) {
        if (s.deleted) continue;
        const g = timeGroup(s.modified || s.created);
        (groups[g] = groups[g] || []).push(s);
      }
      for (const g of ['Today', 'Yesterday', 'This Week', 'Older']) {
        if (!groups[g]?.length) continue;
        html += `<div class="sess-group">${esc(g)}</div>`;
        for (const s of groups[g]) {
          const label = getLabel(s.sessionId) || cleanPrompt(s.firstPrompt) || 'Empty session';
          const active = s.sessionId === sessionId ? ' active' : '';
          html += `<div class="sess-item${active}" data-sid="${esc(s.sessionId)}">`;
          html += `<div class="sess-prompt">${esc(trunc(label, 60))}</div>`;
          html += `<div class="sess-meta"><span>${relDate(s.modified || s.created)}</span>`;
          if (s.messageCount) html += `<span>${s.messageCount} msgs</span>`;
          html += `</div></div>`;
        }
      }
    }
    menu.innerHTML = html;
    menu.querySelector('.sess-new')?.addEventListener('click', () => {
      newSession();
      menu.classList.remove('open');
    });
    menu.querySelectorAll('.sess-item').forEach(el => {
      el.addEventListener('click', () => {
        selectSession(el.dataset.sid);
        menu.classList.remove('open');
      });
    });
  } catch {
    menu.innerHTML = '<div class="sess-loading">failed to load</div>';
  }
}

function selectSession(sid) {
  sessionId = sid;
  if (sid) tabStore.setItem(STOR.session, sid);
  else tabStore.removeItem(STOR.session);
  $msgs.innerHTML = '';
  if (sid) loadSessionHistory(sid);
}

async function loadSessionHistory(sid) {
  const project = $project.value || undefined;
  const params = new URLSearchParams({ limit: '500' });
  if (project) params.set('project', project);
  try {
    const res = await fetch(`/api/claude-code/sessions/${encodeURIComponent(sid)}/messages?${params}`);
    const data = await res.json();
    if (!data.messages?.length) {
      $msgs.innerHTML = '<div class="msg-status">No messages in this session</div>';
      return;
    }
    for (const m of data.messages) {
      if (m.role === 'user') {
        appendUser(m.text);
      } else if (m.role === 'assistant') {
        const msg = { content: [] };
        if (m.text) msg.content.push({ type: 'text', text: m.text });
        if (m.tools) for (const t of m.tools) {
          if (typeof t === 'string') msg.content.push({ type: 'tool_use', name: t, id: '', input: {} });
          else msg.content.push({ type: 'tool_use', ...t });
        }
        renderAssistant(msg);
      } else if (m.role === 'tool_result' && m.toolUseId) {
        updateToolResult({ tool_use_id: m.toolUseId, content: m.text || '', is_error: m.isError });
      }
    }
    if (data.total > data.messages.length) {
      const note = document.createElement('div'); note.className = 'msg-status';
      note.textContent = `Showing last ${data.messages.length} of ${data.total} messages`;
      $msgs.prepend(note);
    }
    scrollEnd();
  } catch {
    $msgs.innerHTML = '<div class="msg-status">Failed to load history</div>';
  }
}

// ── UI helpers ──
function appendUser(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  el.appendChild(bubble);
  $msgs.appendChild(el);
  scrollEnd();
}

function showThinking() {
  hideThinking();
  if (!sendStartTime) sendStartTime = Date.now();
  const el = document.createElement('div');
  el.className = 'thinking';
  el.innerHTML = '<div class="think-avatar">' + CLAUDE_ICON + '</div><div class="think-dots"><span></span><span></span><span></span></div><span class="think-timer"></span>';
  $msgs.appendChild(el);
  thinkingEl = el;
  thinkTimerInterval = setInterval(() => {
    const sec = Math.round((Date.now() - sendStartTime) / 1000);
    const timer = el.querySelector('.think-timer');
    if (timer) timer.textContent = sec > 0 ? `${sec}s` : '';
  }, 1000);
  scrollEnd();
}

function hideThinking() {
  if (thinkTimerInterval) { clearInterval(thinkTimerInterval); thinkTimerInterval = null; }
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

function repositionThinking() {
  if (thinkingEl && running && thinkingEl !== $msgs.lastElementChild) {
    $msgs.appendChild(thinkingEl); // appendChild moves existing child — no remove() needed
    scrollEnd();
  }
}

function appendStatus(text) {
  const el = document.createElement('div');
  el.className = 'msg-status';
  el.textContent = text;
  $msgs.appendChild(el);
  scrollEnd();
}

function appendError(text) {
  const el = document.createElement('div');
  el.className = 'msg-error';
  el.textContent = text;
  $msgs.appendChild(el);
  scrollEnd();
}

function scrollEnd() {
  requestAnimationFrame(() => { $msgs.scrollTop = $msgs.scrollHeight; });
}

function setRunning(r) {
  running = r;
  $send.disabled = false;
  if (r) {
    $send.classList.add('abort');
    $send.title = 'Stop';
    $send.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/></svg>';
    $input.disabled = true;
  } else {
    $send.classList.remove('abort');
    $send.title = 'Send (Enter)';
    $send.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 2L11 13" stroke="currentColor" stroke-width="2" fill="none"/><path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
    $input.disabled = false;
    $input.focus();
  }
}

function finish() {
  hideThinking();
  sendStartTime = null;
  setRunning(false);
  pendingAskRequestId = null;
  pendingAskBufferedAnswer = null;
}

// ── AskUserQuestion / control_request / permissions ──
let pendingAsk = null;
let pendingAskRequestId = null;
let pendingAskBufferedAnswer = null;
let askRenderedViaControl = false;
let attachedImages = [];
const _autoAllowTools = new Set();

function handleControlRequest(msg) {
  const req = msg.request || msg;
  const requestId = msg.request_id || req.request_id;
  const toolName = req.tool_name;
  console.log('[claude-skin] handleControlRequest:', toolName, 'request_id:', requestId, 'keys:', Object.keys(msg).join(','));
  if (!requestId) return;

  if (toolName === 'AskUserQuestion') {
    pendingAskRequestId = requestId;
    // Render if not already rendered (prevents duplicate cards from proactive + denial control_requests)
    if (!pendingAsk && !askRenderedViaControl) renderAskUserQuestion(requestId, req.input);
    // Flush buffered answer if user already clicked before control_request arrived
    if (pendingAskBufferedAnswer) {
      const buf = pendingAskBufferedAnswer;
      pendingAskBufferedAnswer = null;
      sendControlResponse(requestId, buf.questions, buf.answers);
    }
    return;
  }

  if (toolName) {
    if (_autoAllowTools.has(toolName)) {
      sendPermissionResponse(requestId, 'allow');
      return;
    }
    renderPermissionPrompt(requestId, req);
    return;
  }
}

function renderAskUserQuestion(requestId, input) {
  hideThinking();
  askRenderedViaControl = true;
  const questions = input?.questions || [input];
  const allQuestions = input.questions || questions;
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);

  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  // Batched answer collection
  const batchAnswers = {};
  const totalQuestions = questions.length;
  const submitBar = document.createElement('div');
  submitBar.className = 'ask-submit-bar';
  const submitBtn = document.createElement('button');
  submitBtn.className = 'ask-submit';
  submitBtn.disabled = true;
  submitBtn.textContent = `Submit (0/${totalQuestions})`;
  submitBar.appendChild(submitBtn);

  function updateSubmitState() {
    const answered = Object.keys(batchAnswers).length;
    submitBtn.textContent = `Submit (${answered}/${totalQuestions})`;
    submitBtn.disabled = answered < totalQuestions;
  }

  for (const q of questions) {
    const questionText = q.question || q.text || q.header || '';
    const isMultiSelect = q.multiSelect === true;
    const card = document.createElement('div');
    card.className = 'ask-card';
    if (q.header) {
      const hdr = document.createElement('div');
      hdr.className = 'ask-header';
      hdr.textContent = q.header;
      card.appendChild(hdr);
    }
    if (questionText && questionText !== q.header) {
      const qEl = document.createElement('div');
      qEl.className = 'ask-question';
      qEl.textContent = questionText;
      card.appendChild(qEl);
    }
    if (isMultiSelect) {
      const hint = document.createElement('div');
      hint.className = 'ask-multi-hint';
      hint.textContent = 'Select all that apply';
      card.appendChild(hint);
    }
    if (q.options?.length) {
      const opts = document.createElement('div');
      opts.className = 'ask-options';
      if (isMultiSelect) opts.classList.add('multi');
      for (const opt of q.options) {
        const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
        const optDesc = typeof opt === 'string' ? '' : (opt.description || '');
        const btn = document.createElement('button');
        btn.className = 'ask-option';
        btn.innerHTML = `<span class="ask-option-wrap"><span class="ask-option-label">${esc(optLabel)}</span>` +
          (optDesc ? `<span class="ask-option-desc">${esc(optDesc)}</span>` : '') + `</span>`;
        btn.addEventListener('click', () => {
          if (isMultiSelect) {
            btn.classList.toggle('selected');
            const selected = [];
            opts.querySelectorAll('.ask-option.selected').forEach(b => {
              selected.push(b.querySelector('.ask-option-label').textContent);
            });
            if (selected.length > 0) batchAnswers[questionText] = selected.join(', ');
            else delete batchAnswers[questionText];
          } else {
            opts.querySelectorAll('.ask-option').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            batchAnswers[questionText] = optLabel;
          }
          updateSubmitState();
        });
        opts.appendChild(btn);
      }
      card.appendChild(opts);
    } else {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.className = 'ask-text-input';
      textInput.placeholder = 'Type your answer...';
      textInput.addEventListener('input', () => {
        if (textInput.value.trim()) batchAnswers[questionText] = textInput.value.trim();
        else delete batchAnswers[questionText];
        updateSubmitState();
      });
      card.appendChild(textInput);
    }
    wrap.appendChild(card);
  }

  // Submit button — sends all answers as a batch
  submitBtn.addEventListener('click', () => {
    wrap.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
    wrap.querySelectorAll('.ask-text-input').forEach(i => { i.disabled = true; });
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitted';
    sendControlResponse(requestId, allQuestions, batchAnswers);
  });
  wrap.appendChild(submitBar);

  el.appendChild(wrap);
  $msgs.appendChild(el);
  scrollEnd();
}

function sendControlResponse(requestId, questions, answers) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const rid = requestId || pendingAskRequestId;
  if (!rid) {
    // control_request hasn't arrived yet — buffer and send when it does
    pendingAskBufferedAnswer = { questions, answers };
    showThinking();
    setRunning(true);
    return;
  }
  ws.send(JSON.stringify({
    type: 'control_response',
    request_id: rid,
    response: { behavior: 'allow', updatedInput: { questions, answers } },
  }));
  pendingAskRequestId = null;
  pendingAskBufferedAnswer = null;
  askRenderedViaControl = false;
  showThinking();
  setRunning(true);
}

// ── Permission prompts ──
function renderPermissionPrompt(requestId, req) {
  hideThinking();
  setRunning(false);

  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const iconMap = { Read:'F', Edit:'E', Write:'W', Bash:'$', Glob:'*', Grep:'?', Agent:'A', WebSearch:'S', WebFetch:'U' };

  let detail = '';
  if (['Read','Edit','Write'].includes(toolName)) detail = input.file_path || '';
  else if (toolName === 'Bash') detail = input.command || '';
  else if (toolName === 'Glob' || toolName === 'Grep') detail = input.pattern || '';
  else if (toolName === 'Agent') detail = input.description || (input.prompt || '').slice(0, 80);
  else detail = Object.keys(input).length ? JSON.stringify(input).slice(0, 120) : '';

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);

  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  const card = document.createElement('div');
  card.className = 'perm-card';

  const toolLine = document.createElement('div');
  toolLine.className = 'perm-tool-line';
  const icon = document.createElement('span');
  icon.className = 'perm-tool-icon';
  icon.textContent = iconMap[toolName] || '#';
  const name = document.createElement('span');
  name.className = 'perm-tool-name';
  name.textContent = toolName;
  toolLine.append(icon, name);
  card.appendChild(toolLine);

  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'perm-detail';
    detailEl.textContent = detail;
    card.appendChild(detailEl);
  }

  const actions = document.createElement('div');
  actions.className = 'perm-actions';

  const allowBtn = document.createElement('button');
  allowBtn.className = 'perm-btn perm-btn-allow';
  allowBtn.textContent = 'Allow';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'perm-btn perm-btn-deny';
  denyBtn.textContent = 'Deny';

  const alwaysLbl = document.createElement('label');
  alwaysLbl.className = 'perm-always';
  const alwaysCb = document.createElement('input');
  alwaysCb.type = 'checkbox';
  alwaysLbl.append(alwaysCb, document.createTextNode('Always'));

  const resolve = (behavior) => {
    if (alwaysCb.checked && behavior === 'allow') _autoAllowTools.add(toolName);
    card.classList.add('resolved');
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    sendPermissionResponse(requestId, behavior);
  };

  allowBtn.addEventListener('click', () => resolve('allow'));
  denyBtn.addEventListener('click', () => resolve('deny'));

  actions.append(allowBtn, denyBtn, alwaysLbl);
  card.appendChild(actions);
  wrap.appendChild(card);
  el.appendChild(wrap);
  $msgs.appendChild(el);
  scrollEnd();
}

function sendPermissionResponse(requestId, behavior) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'control_response',
    request_id: requestId,
    response: { behavior },
  }));
  showThinking();
  setRunning(true);
}

// ── Send ──
function send() {
  const text = $input.value.trim();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (running) {
    ws.send(JSON.stringify({ type: 'abort' }));
    return;
  }
  if (!text && !attachedImages.length) return;

  // Slash commands
  if (text.startsWith('/')) {
    const cmd = text.split(/\s/)[0].toLowerCase();
    if (cmd === '/clear') { $input.value = ''; $msgs.innerHTML = ''; return; }
  }

  // Pending AskUserQuestion free-text response
  if (pendingAsk && text) {
    $input.value = ''; autoResize();
    appendUser(text); sendStartTime = Date.now(); showThinking(); setRunning(true);
    const answers = {};
    answers[pendingAsk.questionText] = text;
    sendControlResponse(pendingAsk.requestId, pendingAsk.questions, answers);
    pendingAsk = null;
    return;
  }

  $input.value = '';
  autoResize();
  appendUser(text);
  sendStartTime = Date.now();
  showThinking();
  setRunning(true);

  const prompt = buildPromptWithAttachments(text);
  const msg = {
    type: 'query',
    prompt,
    cwd: $project.value || undefined,
    sessionId: sessionId || undefined,
    model: $model.value || undefined,
  };
  if (attachedImages.length) {
    msg.images = attachedImages.map(i => ({ base64: i.base64, mediaType: i.mediaType }));
    attachedImages = [];
    const preview = document.getElementById('chat-image-preview');
    if (preview) preview.innerHTML = '';
    const badge = document.getElementById('chat-attach-badge');
    if (badge) { badge.textContent = ''; badge.hidden = true; }
  }
  ws.send(JSON.stringify(msg));
}

function newSession() {
  if (running) return;
  sessionId = null;
  tabStore.removeItem(STOR.session);
  const div = document.createElement('div');
  div.className = 'session-divider';
  div.innerHTML = '<span>new session</span>';
  $msgs.appendChild(div);
  scrollEnd();
}

function autoResize() {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 160) + 'px';
}

// ── Init ──
async function init() {
  sessionId = tabStore.getItem(STOR.session) || null;
  await loadConfig();
  loadMonthlyCost();
  connect();

  $input.addEventListener('input', () => {
    autoResize();
    $send.disabled = !$input.value.trim() && !running;
  });

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!$send.disabled) send();
    }
  });

  $send.addEventListener('click', send);

  // Image paste with thumbnail preview
  const $imgPreview = document.getElementById('chat-image-preview');

  function addImageThumb(dataUrl, idx) {
    if (!$imgPreview) return;
    const thumb = document.createElement('div');
    thumb.className = 'chat-thumb';
    thumb.dataset.idx = idx;
    const img = document.createElement('img');
    img.src = dataUrl;
    const x = document.createElement('button');
    x.className = 'chat-thumb-x';
    x.textContent = '\u00d7';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = parseInt(thumb.dataset.idx, 10);
      attachedImages.splice(i, 1);
      thumb.remove();
      $imgPreview.querySelectorAll('.chat-thumb').forEach((t, j) => { t.dataset.idx = j; });
      updateAttachBadge();
      if (!attachedImages.length && !$input.value.trim()) $send.disabled = true;
    });
    thumb.append(img, x);
    $imgPreview.appendChild(thumb);
  }

  function updateAttachBadge() {
    const badge = document.getElementById('chat-attach-badge');
    if (badge) {
      const count = attachedImages.length + (typeof attachedFiles !== 'undefined' ? attachedFiles.length : 0);
      badge.textContent = count || '';
      badge.hidden = !count;
    }
  }

  $input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        attachedImages.push({ base64, mediaType: item.type });
        addImageThumb(dataUrl, attachedImages.length - 1);
        updateAttachBadge();
        $send.disabled = false;
      };
      reader.readAsDataURL(blob);
    }
  });

  $newBtn.addEventListener('click', newSession);

  // Session history menu
  const $sessBtn = $('chat-session-btn');
  const $sessMenu = $('chat-session-menu');
  if ($sessBtn && $sessMenu) {
    $sessBtn.addEventListener('click', () => {
      const isOpen = $sessMenu.classList.toggle('open');
      if (isOpen) renderSessionMenu();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.toolbar-session-wrap')) $sessMenu?.classList.remove('open');
    });
  }

  // File attachment
  const $attach = $('chat-attach-btn');
  if ($attach) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    $attach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      for (const file of fileInput.files) {
        if (!isTextFile(file.name)) {
          appendStatus(`Skipped "${file.name}" — only text/code files supported`);
          continue;
        }
        if (file.size > 100000) {
          appendStatus(`Skipped "${file.name}" — file too large (${Math.round(file.size/1024)}KB, max 100KB)`);
          continue;
        }
        const text = await file.text();
        attachedFiles.push({ name: file.name, content: text.slice(0, 50000) });
      }
      updateAttachBadge();
      fileInput.value = '';
    });
  }

  // Session monitor widget
  const $monitorBtn = $('chat-monitor-btn');
  const $monitorContainer = $('session-monitor-container');
  let monitorWidget = null;
  if ($monitorBtn && $monitorContainer) {
    $monitorBtn.addEventListener('click', () => {
      if ($monitorContainer.hidden) {
        $monitorContainer.hidden = false;
        $monitorBtn.classList.add('active');
        if (!monitorWidget) monitorWidget = mountSessionWidget($monitorContainer);
      } else {
        $monitorContainer.hidden = true;
        $monitorBtn.classList.remove('active');
      }
    });
  }

  // Load history for saved session
  if (sessionId) {
    loadSessionHistory(sessionId);
  }

  $input.focus();
}

init();
