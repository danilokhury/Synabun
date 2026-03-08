// ═══════════════════════════════════════════
// SynaBun Chat — Claude Code skin
// Connects to /ws/claude-skin, streams events, renders chat UI
// ═══════════════════════════════════════════

import { storage } from '/shared/storage.js';
import { restoreInterfaceConfig, restoreSkin } from '/shared/ui-settings.js';

// Apply saved skin + interface config immediately
restoreInterfaceConfig();
restoreSkin();

// ── Marked.js (markdown parser) ──
// Loaded from CDN, falls back to plain text
let marked = null;
(async () => {
  try {
    const m = await import('https://cdn.jsdelivr.net/npm/marked@9/src/marked.min.js').catch(() => null)
      || await import('https://cdn.jsdelivr.net/npm/marked@9/lib/marked.esm.js').catch(() => null);
    if (m) {
      marked = m.marked || m.default;
      if (marked?.setOptions) marked.setOptions({ breaks: true, gfm: true });
    }
  } catch {}
})();

function renderMarkdown(text) {
  if (!marked) return escHtml(text).replace(/\n/g, '<br>');
  try {
    return marked.parse(text);
  } catch {
    return escHtml(text).replace(/\n/g, '<br>');
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── State ──
let ws = null;
let reconnectTimer = null;
let currentSessionId = null;
let isRunning = false;
let totalCost = 0;
let pendingThinking = null;
let pendingAssistant = null; // { el, bodyEl, toolsEl }

const STORAGE_SESSION = 'synabun-chat-session';
const STORAGE_CWD = 'synabun-chat-cwd';

// ── DOM refs ──
const $messages = document.getElementById('messages');
const $input = document.getElementById('chat-input');
const $sendBtn = document.getElementById('chat-send-btn');
const $costLabel = document.getElementById('chat-cost-label');
const $modelLabel = document.getElementById('chat-model-label');
const $cwdDisplay = document.getElementById('chat-cwd-display');
const $cwdBtn = document.getElementById('chat-cwd-btn');
const $newBtn = document.getElementById('chat-new-btn');
const $projectLabel = document.getElementById('chat-project-label');

// ── Load config ──
async function loadConfig() {
  try {
    const res = await fetch('/api/claude/config').then(r => r.json());
    if (res.ok) {
      const cfg = res.config || {};
      if (cfg.model) $modelLabel.textContent = cfg.model.replace('claude-', '').replace(/-\d{8}$/, '');
      // Load projects for cwd default
      if (res.projects?.length) {
        const p = res.projects[0];
        if (p.path && !storage.getItem(STORAGE_CWD)) {
          storage.setItem(STORAGE_CWD, p.path);
        }
      }
    }
  } catch {}
}

// ── CWD ──
function getCwd() {
  return storage.getItem(STORAGE_CWD) || '';
}
function updateCwdDisplay() {
  const cwd = getCwd();
  $cwdDisplay.textContent = cwd || '~';
  $projectLabel.textContent = cwd ? cwd.split(/[/\\]/).pop() : '';
}

$cwdBtn.addEventListener('click', () => {
  const cwd = prompt('Working directory:', getCwd());
  if (cwd !== null) {
    storage.setItem(STORAGE_CWD, cwd);
    updateCwdDisplay();
  }
});

// ── WebSocket ──
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/claude-skin`);

  ws.addEventListener('open', () => {
    clearTimeout(reconnectTimer);
  });

  ws.addEventListener('message', (e) => {
    try { handleServerMessage(JSON.parse(e.data)); }
    catch {}
  });

  ws.addEventListener('close', () => {
    if (isRunning) showError('Connection lost. Reconnecting...');
    reconnectTimer = setTimeout(connect, 2000);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

// ── Message handling ──
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'event':
      handleClaudeEvent(msg.event);
      break;
    case 'stderr':
      // Show stderr as subtle status
      if (msg.text?.trim()) appendStatus(msg.text.trim());
      break;
    case 'done':
      finishRunning();
      break;
    case 'aborted':
      finishRunning();
      appendStatus('Aborted.');
      break;
    case 'error':
      finishRunning();
      showError(msg.message);
      break;
  }
}

function handleClaudeEvent(event) {
  if (!event?.type) return;

  // init — extract session_id, model
  if (event.type === 'system' && event.subtype === 'init') {
    if (event.session_id) {
      currentSessionId = event.session_id;
      storage.setItem(STORAGE_SESSION, event.session_id);
    }
    if (event.model) {
      $modelLabel.textContent = event.model.replace('claude-', '').replace(/-\d{8}$/, '');
    }
    hideThinking();
    return;
  }

  // assistant message — contains text + tool_use blocks
  if (event.type === 'assistant' && event.message) {
    hideThinking();
    const msg = event.message;
    renderAssistantMessage(msg);
    return;
  }

  // tool_result — update the matching tool card
  if (event.type === 'tool_result') {
    updateToolResult(event);
    return;
  }

  // result — final stats
  if (event.type === 'result') {
    if (event.total_cost_usd != null) {
      totalCost += event.total_cost_usd;
      updateCostDisplay();
    }
    if (event.session_id) {
      currentSessionId = event.session_id;
      storage.setItem(STORAGE_SESSION, event.session_id);
    }
    return;
  }
}

// ── Render assistant message ──
function renderAssistantMessage(msg) {
  const content = msg.content || [];

  // Separate text and tool_use blocks
  const textBlocks = content.filter(b => b.type === 'text');
  const toolBlocks = content.filter(b => b.type === 'tool_use');

  // If there's no text and no tools, skip
  if (!textBlocks.length && !toolBlocks.length) return;

  const msgEl = document.createElement('div');
  msgEl.className = 'msg msg-assistant';

  const innerEl = document.createElement('div');
  innerEl.className = 'msg-assistant-inner';

  // Text content
  if (textBlocks.length) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'msg-body';
    const fullText = textBlocks.map(b => b.text).join('\n');
    bodyEl.innerHTML = renderMarkdown(fullText);
    addCodeLangLabels(bodyEl);
    innerEl.appendChild(bodyEl);
  }

  // Tool use blocks
  if (toolBlocks.length) {
    const toolsEl = document.createElement('div');
    toolsEl.className = 'msg-tools';
    for (const block of toolBlocks) {
      toolsEl.appendChild(buildToolCard(block));
    }
    innerEl.appendChild(toolsEl);
  }

  msgEl.appendChild(innerEl);
  $messages.appendChild(msgEl);
  pendingAssistant = { el: msgEl, innerEl };
  scrollToBottom();
}

// ── Tool cards ──
function buildToolCard(block) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolId = block.id || '';

  const header = document.createElement('div');
  header.className = 'tool-card-header';
  header.innerHTML = `
    ${toolIcon(block.name)}
    <span class="tool-card-name">
      <span class="tool-name">${escHtml(block.name)}</span>
      <span class="tool-detail">${getToolDetail(block)}</span>
    </span>
    <svg class="tool-card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;

  header.addEventListener('click', () => card.classList.toggle('open'));

  const body = document.createElement('div');
  body.className = 'tool-card-body';

  // Input section
  if (block.input && Object.keys(block.input).length) {
    const inputLabel = document.createElement('div');
    inputLabel.className = 'tool-card-section-label';
    inputLabel.textContent = 'Input';
    const inputSection = document.createElement('div');
    inputSection.className = 'tool-card-section';
    inputSection.textContent = formatToolInput(block.input);
    body.appendChild(inputLabel);
    body.appendChild(inputSection);
  }

  // Result placeholder
  const resultLabel = document.createElement('div');
  resultLabel.className = 'tool-card-section-label tool-result-label';
  resultLabel.style.display = 'none';
  resultLabel.textContent = 'Result';
  const resultSection = document.createElement('div');
  resultSection.className = 'tool-card-section tool-result-content';
  resultSection.style.display = 'none';
  body.appendChild(resultLabel);
  body.appendChild(resultSection);

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function updateToolResult(event) {
  const toolId = event.tool_use_id;
  if (!toolId) return;
  const card = $messages.querySelector(`.tool-card[data-tool-id="${CSS.escape(toolId)}"]`);
  if (!card) return;

  const resultLabel = card.querySelector('.tool-result-label');
  const resultContent = card.querySelector('.tool-result-content');
  if (!resultContent) return;

  let text = '';
  if (Array.isArray(event.content)) {
    text = event.content.map(b => b.text || b.data || '').join('\n');
  } else if (typeof event.content === 'string') {
    text = event.content;
  }

  resultContent.textContent = text.slice(0, 2000) + (text.length > 2000 ? '\n…' : '');
  resultLabel.style.display = '';
  resultContent.style.display = '';

  if (event.is_error) {
    card.classList.add('tool-error');
  } else {
    card.classList.add('tool-success');
  }
}

function getToolDetail(block) {
  const i = block.input || {};
  if (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') {
    const p = i.file_path || i.path || '';
    return p ? escHtml(p.split(/[/\\]/).pop()) : '';
  }
  if (block.name === 'Bash') return escHtml((i.command || '').slice(0, 60));
  if (block.name === 'Glob') return escHtml(i.pattern || '');
  if (block.name === 'Grep') return escHtml(i.pattern || '');
  if (block.name === 'WebSearch') return escHtml(i.query || '');
  if (block.name === 'WebFetch') return escHtml((i.url || '').replace(/^https?:\/\//, '').slice(0, 60));
  return '';
}

function formatToolInput(input) {
  try { return JSON.stringify(input, null, 2); }
  catch { return String(input); }
}

function toolIcon(name) {
  const icons = {
    Read: '<svg class="tool-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    Edit: '<svg class="tool-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    Write: '<svg class="tool-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    Bash: '<svg class="tool-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    Glob: '<svg class="tool-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    Grep: '<svg class="tool-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    WebSearch: '<svg class="tool-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  };
  return icons[name] || '<svg class="tool-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
}

function addCodeLangLabels(el) {
  el.querySelectorAll('pre code').forEach(code => {
    const cls = code.className || '';
    const lang = cls.replace('language-', '').trim();
    if (lang && lang !== 'language-') {
      const label = document.createElement('span');
      label.className = 'code-lang-label';
      label.textContent = lang;
      code.parentElement.style.position = 'relative';
      code.parentElement.appendChild(label);
    }
  });
}

// ── UI helpers ──
function appendUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  el.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  $messages.appendChild(el);
  scrollToBottom();
}

function showThinking() {
  hideThinking();
  const el = document.createElement('div');
  el.className = 'msg-thinking';
  el.id = 'thinking-indicator';
  el.innerHTML = `<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>`;
  $messages.appendChild(el);
  pendingThinking = el;
  scrollToBottom();
}

function hideThinking() {
  if (pendingThinking) { pendingThinking.remove(); pendingThinking = null; }
  const existing = document.getElementById('thinking-indicator');
  if (existing) existing.remove();
}

function appendStatus(text) {
  const el = document.createElement('div');
  el.className = 'msg-status';
  el.textContent = text;
  $messages.appendChild(el);
  scrollToBottom();
}

function showError(text) {
  const el = document.createElement('div');
  el.className = 'msg-error';
  el.textContent = '✖ ' + text;
  $messages.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    $messages.scrollTop = $messages.scrollHeight;
  });
}

function updateCostDisplay() {
  $costLabel.textContent = '$' + totalCost.toFixed(4);
  $costLabel.classList.add('updated');
  setTimeout(() => $costLabel.classList.remove('updated'), 1000);
}

function setRunning(running) {
  isRunning = running;
  $sendBtn.disabled = false;
  if (running) {
    $sendBtn.classList.add('abort-mode');
    $sendBtn.title = 'Abort';
    $sendBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;
  } else {
    $sendBtn.classList.remove('abort-mode');
    $sendBtn.title = 'Send';
    $sendBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    $input.disabled = false;
    $input.focus();
  }
}

function finishRunning() {
  hideThinking();
  setRunning(false);
  pendingAssistant = null;
}

// ── Send message ──
function sendMessage() {
  const text = $input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (isRunning) {
    // Abort
    ws.send(JSON.stringify({ type: 'abort' }));
    return;
  }

  $input.value = '';
  autoResize();
  appendUserMessage(text);
  showThinking();
  setRunning(true);
  $input.disabled = true;

  ws.send(JSON.stringify({
    type: 'query',
    prompt: text,
    cwd: getCwd() || undefined,
    sessionId: currentSessionId || undefined,
  }));
}

// ── New session ──
function newSession() {
  if (isRunning) return;
  currentSessionId = null;
  storage.removeItem(STORAGE_SESSION);

  const divider = document.createElement('div');
  divider.className = 'session-divider';
  divider.textContent = 'New session';
  $messages.appendChild(divider);
  scrollToBottom();
}

// ── Input auto-resize ──
function autoResize() {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 140) + 'px';
}

// ── Init ──
async function init() {
  // Restore session
  currentSessionId = storage.getItem(STORAGE_SESSION) || null;
  updateCwdDisplay();
  await loadConfig();
  connect();

  // Input events
  $input.addEventListener('input', () => {
    autoResize();
    $sendBtn.disabled = !$input.value.trim() && !isRunning;
  });

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!$sendBtn.disabled) sendMessage();
    }
  });

  $sendBtn.addEventListener('click', sendMessage);
  $newBtn.addEventListener('click', newSession);

  // Restore session label if continuing
  if (currentSessionId) {
    const divider = document.createElement('div');
    divider.className = 'session-divider';
    divider.textContent = `Continuing session ${currentSessionId.slice(0, 8)}…`;
    $messages.appendChild(divider);
  }

  $input.focus();
}

init();
