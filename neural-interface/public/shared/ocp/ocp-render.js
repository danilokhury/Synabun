// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel: Message Rendering
// Renders user messages, assistant messages, tool cards, streaming chunks
// ═══════════════════════════════════════════

import { toolIcon, ICON_SLIDE } from './ocp-icons.js';

let _marked = null;
let _markedLoading = false;

function ensureMarked() {
  if (_marked || _markedLoading || typeof window === 'undefined') return;
  _markedLoading = true;
  import('https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js')
    .then((mod) => {
      _marked = mod?.marked || mod?.default || null;
      if (_marked?.setOptions) _marked.setOptions({ breaks: true, gfm: true });
    })
    .catch(() => {})
    .finally(() => {
      _markedLoading = false;
    });
}

ensureMarked();

const OPENCODE_ICON = '<svg viewBox="0 0 24 30" fill="currentColor"><path d="M18 6H6V24H18V6ZM24 30H0V0H24V30Z"/></svg>';

// ── Utilities ──

export function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function normalizeTextContent(value, options = {}) {
  const { stringifyObjects = true } = options;
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeTextContent(entry, options)).filter(Boolean).join('');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.value === 'string') return value.value;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return normalizeTextContent(value.content, options);
    if (Array.isArray(value.parts)) return normalizeTextContent(value.parts, options);
    if (typeof value.message === 'string') return value.message;
    if (!stringifyObjects) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

function md(text) {
  if (!_marked) return esc(text).replace(/\n/g, '<br>');
  try {
    return _marked.parse(text || '');
  } catch {
    return esc(text).replace(/\n/g, '<br>');
  }
}

// ── Thinking block helpers ──

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';
const THINK_ICON_SVG = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5L4 9h4l-1 5.5L12 7H8l1-5.5z"/></svg>';

function parseThinkSegments(text) {
  const segments = [];
  let pos = 0;
  while (pos < text.length) {
    const openIdx = text.indexOf(THINK_OPEN_TAG, pos);
    if (openIdx === -1) {
      const rest = text.slice(pos);
      if (rest) segments.push({ type: 'text', content: rest });
      break;
    }
    if (openIdx > pos) segments.push({ type: 'text', content: text.slice(pos, openIdx) });
    const closeIdx = text.indexOf(THINK_CLOSE_TAG, openIdx + THINK_OPEN_TAG.length);
    if (closeIdx === -1) {
      segments.push({ type: 'thinking', content: text.slice(openIdx + THINK_OPEN_TAG.length), partial: true });
      pos = text.length;
    } else {
      segments.push({ type: 'thinking', content: text.slice(openIdx + THINK_OPEN_TAG.length, closeIdx), partial: false });
      pos = closeIdx + THINK_CLOSE_TAG.length;
    }
  }
  return segments;
}

// ── Syntax highlighting (highlight.js) ──
export let _hlJs = null;
let _hlJsLoading = false;

export function loadHighlightJs() {
  if (_hlJs) return Promise.resolve();
  if (_hlJsLoading) return new Promise((r) => setTimeout(r, 50).then(r));
  _hlJsLoading = true;
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark-dimmed.min.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/highlight.js@11/lib/highlight.min.js';
    script.onload = () => {
      _hlJs = window.hljs;
      _hlJsLoading = false;
      resolve();
    };
    script.onerror = () => {
      _hlJsLoading = false;
      resolve();
    };
    document.head.appendChild(script);
  });
}

const LANG_ALIASES = {
  js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby',
  sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown',
  'c++': 'cpp', 'objective-c': 'objectivec', 'obj-c': 'objectivec',
};

function detectCodeLanguage(pre) {
  const code = pre.querySelector('code');
  if (!code) return null;
  const cls = code.className;
  const m = cls && cls.match(/language-(\w+)/);
  if (m) {
    const raw = m[1].toLowerCase();
    return LANG_ALIASES[raw] || raw;
  }
  return null;
}

function highlightCodeBlock(pre) {
  if (!_hlJs) return;
  const code = pre.querySelector('code');
  if (!code) return;
  const lang = detectCodeLanguage(pre);
  if (lang && _hlJs.getLanguage(lang)) {
    try { _hlJs.highlightElement(code, lang); return; } catch {}
  }
  _hlJs.highlightElement(code);
}

function highlightCodeBlocks(container) {
  if (!_hlJs) return;
  container.querySelectorAll('pre').forEach(highlightCodeBlock);
}

function attachLanguageLabel(pre) {
  if (pre.querySelector('.ocp-lang-label')) return;
  const lang = detectCodeLanguage(pre);
  if (!lang) return;
  const label = document.createElement('span');
  label.className = 'ocp-lang-label';
  label.textContent = lang;
  pre.style.position = 'relative';
  pre.appendChild(label);
}

function attachLanguageLabels(container) {
  container.querySelectorAll('pre').forEach(attachLanguageLabel);
}

// ── File path linkification ──
const FILE_PATH_RE = /(\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,10})(?::(\d+))?(?::(\d+))?/g;

function linkifyFilePath(text) {
  return text.replace(FILE_PATH_RE, (match, path, line, col) => {
    const linePart = line ? `:${line}` : '';
    const colPart = col ? `:${col}` : '';
    return `<a class="ocp-file-link" data-path="${escAttr(path)}" data-line="${line || ''}" data-col="${col || ''}">${match}</a>`;
  });
}

function attachFileLinkHandlers(container) {
  container.querySelectorAll('.ocp-file-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const path = link.dataset.path;
      const line = link.dataset.line;
      navigator.clipboard?.writeText(line ? `${path}:${line}` : path).catch(() => {});
      link.classList.add('copied');
      const orig = link.textContent;
      link.textContent = 'Copied!';
      setTimeout(() => {
        link.classList.remove('copied');
        link.textContent = orig;
      }, 1500);
    });
  });
}

function linkifyFilePaths(container) {
  container.querySelectorAll('.ocp-msg-assistant, .ocp-tool-result, .ocp-tool-args').forEach((el) => {
    el.querySelectorAll('a, code, pre').forEach((node) => {
      if (node.tagName === 'A' || node.closest('.ocp-file-link')) return;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((textNode) => {
        const parent = textNode.parentNode;
        if (!parent || parent.closest('a, code, pre, .ocp-file-link')) return;
        const original = textNode.textContent;
        const linked = linkifyFilePath(original);
        if (linked !== original) {
          const frag = document.createRange().createContextualFragment(linked);
          parent.replaceChild(frag, textNode);
        }
      });
    });
  });
  attachFileLinkHandlers(container);
}

// ── Throttle helper for streaming ──
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return function (...args) {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

function thinkBlockHtml(content, partial) {
  const label = partial ? 'Thinking…' : 'Thought';
  return `<details class="ocp-think-block"${partial ? ' open' : ''}><summary><span class="ocp-think-icon">${THINK_ICON_SVG}</span><span class="ocp-think-label">${label}</span><span class="ocp-think-chevron">&#x203A;</span></summary><div class="ocp-think-content">${esc(content)}</div></details>`;
}

function pretty(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = normalizeTextContent(value, { stringifyObjects: false });
  if (text) return text;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return normalizeTextContent(value, { stringifyObjects: false });
  }
}

function renderAssistantMarkdown(text) {
  const tpl = document.createElement('template');
  tpl.innerHTML = md(text || '');
  tpl.content.querySelectorAll('hr').forEach((node) => node.remove());
  tpl.content.querySelectorAll('p').forEach((node) => {
    if (!node.textContent.trim() && !node.querySelector('img,svg,code,pre,table,ul,ol,blockquote')) node.remove();
  });
  return {
    html: tpl.innerHTML,
    hasContent: Boolean((tpl.content.textContent || '').trim() || tpl.content.querySelector('img,svg,code,pre,table,ul,ol,blockquote')),
  };
}

function attachCopyButton(pre) {
  if (!pre || pre.querySelector('.ocp-copy-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'ocp-copy-btn';
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => {
    const code = pre.querySelector('code');
    const text = (code || pre).textContent || '';
    navigator.clipboard?.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1500);
    }).catch(() => {});
  });
  pre.style.position = 'relative';
  pre.appendChild(btn);
}

function postProcessRenderedHtml(container) {
  if (!container) return;
  container.querySelectorAll('pre').forEach((pre) => attachCopyButton(pre));
  attachLanguageLabels(container);
  highlightCodeBlocks(container);
  linkifyFilePaths(container);
}

function setAssistantHtml(el, content) {
  const segments = parseThinkSegments(content || '');
  let html = '';
  let hasContent = false;
  for (const seg of segments) {
    if (seg.type === 'thinking') {
      html += thinkBlockHtml(seg.content, seg.partial);
    } else {
      const rendered = renderAssistantMarkdown(seg.content);
      if (rendered.hasContent) {
        html += rendered.html;
        hasContent = true;
      }
    }
  }
  // If only think blocks and no text, still mark as non-empty
  if (!hasContent && html) hasContent = true;
  el.innerHTML = html;
  clearThinkingTimer(el);
  el.classList.toggle('ocp-msg-empty', !hasContent);
  postProcessRenderedHtml(el);
}

function truncate(str, max = 80) {
  if (!str || str.length <= max) return str || '';
  return str.slice(0, max) + '…';
}

function plainInlinePreview(value) {
  return truncate(pretty(value).replace(/\s+/g, ' ').trim(), 110);
}

function basename(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || filePath;
}

const STANDARD_TOOL_LABELS = {
  read: 'Read', edit: 'Edit', write: 'Write', bash: 'Bash',
  grep: 'Grep', glob: 'Glob', agent: 'Agent', task: 'Agent',
  websearch: 'Web Search', web_search: 'Web Search',
  webfetch: 'Web Fetch', web_fetch: 'Web Fetch',
  todowrite: 'Tasks', todo_write: 'Tasks',
  notebookedit: 'Notebook', notebook_edit: 'Notebook',
  askuserquestion: 'Question', ask_user_question: 'Question',
  enterplanmode: 'Enter Plan Mode', exitplanmode: 'Exit Plan Mode',
  enterworktree: 'Worktree', exitworktree: 'Exit Worktree',
};

function standardDisplayName(rawName) {
  const key = String(rawName || '').toLowerCase().replace(/[^a-z_]/g, '');
  return STANDARD_TOOL_LABELS[key] || rawName;
}

/* Smart summaries for standard AI-tool calls (Read, Edit, Grep, Bash, etc.) */
function toolSummaryText(rawName, input) {
  if (!input || typeof input !== 'object') return '';
  const name = String(rawName || '').toLowerCase().replace(/[^a-z_]/g, '');
  const t = (s) => truncate(String(s || '').replace(/\s+/g, ' ').trim(), 90);
  const fp = input.file_path || input.filePath || input.path || '';
  switch (name) {
    case 'read':            return fp ? basename(fp) : '';
    case 'edit':            return fp ? basename(fp) : '';
    case 'write':           return fp ? basename(fp) : '';
    case 'notebookedit':    return fp ? basename(fp) : '';
    case 'grep':            return t(input.pattern ? `${input.pattern}${fp ? ' in ' + basename(fp) : ''}` : '');
    case 'glob':            return t(input.pattern || '');
    case 'bash':            return t(input.command || '');
    case 'agent':
    case 'task':            return t(input.description || input.prompt || '');
    case 'websearch':
    case 'web_search':      return t(input.query || '');
    case 'webfetch':
    case 'web_fetch':       return t(input.url || '');
    case 'todowrite':
    case 'todo_write':      return Array.isArray(input.todos) ? `${input.todos.length} tasks` : '';
    case 'askuserquestion':
    case 'ask_user_question': return t(input.question || input.text || '');
    case 'enterplanmode':
    case 'exitplanmode':    return '';
    default:                return '';
  }
}

// ── SynaBun MCP tool label + summary helpers ──

const SYNABUN_LABELS = {
  recall: 'Recall', remember: 'Remember', reflect: 'Reflect',
  forget: 'Forget', restore: 'Restore', memories: 'Memories', sync: 'Sync',
  category: 'Category', loop: 'Loop', git: 'Git', tictactoe: 'TicTacToe',
  image_staged: 'Images',
  browser_navigate: 'Browser · Navigate', browser_screenshot: 'Browser · Screenshot',
  browser_snapshot: 'Browser · Snapshot', browser_content: 'Browser · Content',
  browser_click: 'Browser · Click', browser_type: 'Browser · Type',
  browser_fill: 'Browser · Fill', browser_hover: 'Browser · Hover',
  browser_select: 'Browser · Select', browser_press: 'Browser · Press',
  browser_scroll: 'Browser · Scroll', browser_wait: 'Browser · Wait',
  browser_go_back: 'Browser · Back', browser_go_forward: 'Browser · Forward',
  browser_reload: 'Browser · Reload', browser_evaluate: 'Browser · Evaluate',
  browser_upload: 'Browser · Upload', browser_session: 'Browser · Session',
  browser_extract_tweets: 'Extract · Tweets', browser_extract_fb_posts: 'Extract · Facebook',
  browser_extract_ig_feed: 'Extract · Instagram', browser_extract_ig_post: 'Extract · IG Post',
  browser_extract_ig_reels: 'Extract · IG Reels', browser_extract_ig_profile: 'Extract · IG Profile',
  browser_extract_ig_search: 'Extract · IG Search',
  browser_extract_tiktok_videos: 'Extract · TikTok', browser_extract_tiktok_search: 'Extract · TikTok Search',
  browser_extract_tiktok_studio: 'Extract · TikTok Studio', browser_extract_tiktok_profile: 'Extract · TikTok Profile',
  browser_extract_li_feed: 'Extract · LinkedIn', browser_extract_li_profile: 'Extract · LI Profile',
  browser_extract_li_post: 'Extract · LI Post', browser_extract_li_notifications: 'Extract · LI Notifications',
  browser_extract_li_messages: 'Extract · LI Messages', browser_extract_li_search_people: 'Extract · LI People',
  browser_extract_li_network: 'Extract · LI Network', browser_extract_li_jobs: 'Extract · LI Jobs',
  browser_extract_wa_chats: 'Extract · WhatsApp', browser_extract_wa_messages: 'Extract · WA Messages',
  whiteboard_read: 'Whiteboard · Read', whiteboard_add: 'Whiteboard · Add',
  whiteboard_update: 'Whiteboard · Update', whiteboard_remove: 'Whiteboard · Remove',
  whiteboard_screenshot: 'Whiteboard · Screenshot',
  card_list: 'Cards · List', card_open: 'Cards · Open', card_close: 'Cards · Close',
  card_update: 'Cards · Update', card_screenshot: 'Cards · Screenshot',
  discord_guild: 'Discord · Guild', discord_channel: 'Discord · Channel',
  discord_role: 'Discord · Role', discord_message: 'Discord · Message',
  discord_member: 'Discord · Member', discord_onboarding: 'Discord · Onboarding',
  discord_webhook: 'Discord · Webhook', discord_thread: 'Discord · Thread',
  leonardo_browser_navigate: 'Leonardo · Navigate', leonardo_browser_generate: 'Leonardo · Generate',
  leonardo_browser_library: 'Leonardo · Library', leonardo_browser_download: 'Leonardo · Download',
  leonardo_browser_reference: 'Leonardo · Reference',
};

function synabunToolKey(rawName) {
  // 'SynaBun_recall' → 'recall', 'mcp__SynaBun__recall' → 'recall'
  return (rawName || '')
    .replace(/^mcp__SynaBun__/, '')
    .replace(/^SynaBun_/, '');
}

function synabunDisplayName(rawName) {
  const key = synabunToolKey(rawName);
  return SYNABUN_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '));
}

function synabunSummaryText(rawName, input) {
  if (!input || typeof input !== 'object') return '';
  const key = synabunToolKey(rawName);
  const t = (s) => truncate(String(s || '').replace(/\s+/g, ' ').trim(), 90);
  switch (key) {
    case 'recall':    return t(input.query);
    case 'remember':  return t(input.content);
    case 'reflect':   return t(input.content || input.memory_id);
    case 'forget':
    case 'restore':   return t(input.memory_id);
    case 'memories':  return t(input.action);
    case 'category':  return t(`${input.action || ''}${input.name ? ' · ' + input.name : ''}`);
    case 'sync':      return '';
    case 'git':       return t(input.action);
    case 'loop':      return t(`${input.action || ''}${input.prompt ? ' · ' + input.prompt : ''}`);
    case 'browser_navigate': return t(input.url);
    case 'browser_click':
    case 'browser_hover':   return t(input.selector || input.label);
    case 'browser_type':
    case 'browser_fill':    return t(input.text || input.value || input.selector);
    case 'browser_select':  return t(input.value || input.selector);
    case 'browser_press':   return t(input.key);
    case 'browser_scroll':  return t(input.direction || input.selector);
    case 'browser_evaluate': return t(input.script);
    case 'browser_session': return t(input.action);
    case 'image_staged':    return t(input.action);
    case 'discord_message': return t(input.content || input.action);
    case 'discord_channel':
    case 'discord_member':
    case 'discord_role':    return t(input.action || input.name);
    case 'whiteboard_add':
    case 'whiteboard_update': return t(input.content || input.title);
    case 'card_open':
    case 'card_update':     return t(input.title || input.id);
    case 'leonardo_browser_generate': return t(input.prompt);
    default:                return '';
  }
}

const TOOL_PART_TYPES = new Set([
  'tool',
  'tool_use',
  'tool-use',
  'tooluse',
  'tool_result',
  'tool-result',
  'toolinvocation',
  'tool-invocation',
  'tool_call',
  'tool-call',
]);

function isToolPart(part) {
  const type = String(part?.type || '').trim().toLowerCase();
  if (TOOL_PART_TYPES.has(type)) return true;
  if (type.includes('tool') && (part?.tool || part?.toolName || part?.name || part?.tool_use_id || part?.toolCallId || part?.callID)) return true;
  return Boolean(
    part
    && typeof part === 'object'
    && (part.tool || part.toolName || part.callID || part.toolCallId || part.tool_use_id)
    && (
      part.input != null
      || part.args != null
      || part.metadata != null
      || part.arguments != null
      || part.result != null
      || part.output != null
      || part.response != null
      || part.error != null
      || type.includes('tool')
    )
  );
}

function isTextPart(part) {
  return String(part?.type || '').trim().toLowerCase() === 'text';
}

function normalizeToolStatus(status, { hasResult = false, isError = false } = {}) {
  const raw = String(status || '').trim().toLowerCase();
  if (isError || raw === 'error' || raw === 'failed' || raw === 'failure') return 'error';
  if (raw === 'done' || raw === 'complete' || raw === 'completed' || raw === 'success' || raw === 'finished' || raw === 'result') return 'complete';
  if (hasResult) return 'complete';
  return 'running';
}

function extractToolDescriptor(part) {
  const type = String(part?.type || '').trim().toLowerCase();
  const state = (part?.state && typeof part.state === 'object') ? part.state : null;
  const resultValue = part?.result
    ?? part?.output
    ?? part?.response
    ?? part?.error
    ?? state?.output
    ?? state?.result
    ?? state?.response
    ?? state?.error
    ?? ((type === 'tool_result' || type === 'tool-result' || part?.state === 'result') ? (part?.content ?? part?.text ?? '') : '');
  const isError = Boolean(part?.error || state?.error || part?.success === false || state?.status === 'failed' || state?.status === 'error');
  const hasResult = Boolean(pretty(resultValue).trim());
  return {
    type: 'tool',
    name: part?.tool || part?.toolName || part?.name || 'tool',
    input: part?.args ?? part?.input ?? part?.arguments ?? part?.metadata ?? part?.params ?? state?.input ?? {},
    id: part?.toolCallId || part?.callID || part?.tool_use_id || part?.id || '',
    result: resultValue,
    isError,
    status: normalizeToolStatus(part?.status || state?.status || part?.state, { hasResult, isError }),
  };
}

function collectAssistantSegments(value, segments = []) {
  if (value == null) return segments;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = normalizeTextContent(value);
    if (text) segments.push({ type: 'text', text });
    return segments;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectAssistantSegments(entry, segments));
    return segments;
  }
  if (typeof value !== 'object') return segments;

  if (isToolPart(value)) {
    segments.push(extractToolDescriptor(value));
    return segments;
  }
  // Reasoning/thinking parts (DeepSeek, Qwen, etc.)
  const partType = String(value?.type || '').trim().toLowerCase();
  if (partType === 'reasoning' || partType === 'thinking' || partType === 'thought') {
    const text = normalizeTextContent(value.text ?? value.reasoning ?? value.value ?? value.content ?? '');
    if (text) segments.push({ type: 'thinking', text });
    return segments;
  }
  if (isTextPart(value)) {
    const text = normalizeTextContent(value.text ?? value.value ?? value.content ?? value.message ?? '');
    if (text) segments.push({ type: 'text', text });
    return segments;
  }
  if (Array.isArray(value.parts)) {
    collectAssistantSegments(value.parts, segments);
    return segments;
  }
  if (Array.isArray(value.content)) {
    collectAssistantSegments(value.content, segments);
    return segments;
  }
  if (typeof value.content === 'string' || typeof value.text === 'string' || typeof value.value === 'string' || typeof value.message === 'string') {
    const text = normalizeTextContent(value.text ?? value.value ?? value.content ?? value.message ?? '');
    if (text) segments.push({ type: 'text', text });
  }
  return segments;
}

function findToolCard(container, toolId) {
  if (!container || !toolId) return null;
  return Array.from(container.querySelectorAll('.ocp-tool-card')).find((card) => card.dataset.toolId === toolId) || null;
}

function ensureToolCard(container, toolName, toolId) {
  let card = findToolCard(container, toolId);
  if (card) return card;

  const rawName = toolName || 'tool';
  const isSynaBun = rawName.startsWith('SynaBun_') || rawName.startsWith('mcp__SynaBun__');

  card = document.createElement('div');
  card.className = 'ocp-tool-card' + (isSynaBun ? ' ocp-tool-synabun' : '');
  card.dataset.toolId = toolId || '';
  card.innerHTML = `
    <div class="ocp-tool-header">
      <span class="ocp-tool-icon"></span>
      <span class="ocp-tool-titles">
        <span class="ocp-tool-name"></span>
        <span class="ocp-tool-summary"></span>
      </span>
      <span class="ocp-tool-pill">running</span>
      <span class="ocp-tool-chevron">${ICON_SLIDE}</span>
    </div>
    <div class="ocp-tool-body">
      <div class="ocp-tool-section ocp-tool-args-section" hidden>
        <div class="ocp-tool-section-label">Arguments</div>
        <pre class="ocp-tool-pre ocp-tool-args"></pre>
      </div>
      <div class="ocp-tool-meta" hidden></div>
      <div class="ocp-tool-section ocp-tool-result-section" hidden>
        <div class="ocp-tool-section-label">Result</div>
        <pre class="ocp-tool-pre ocp-tool-result"></pre>
      </div>
    </div>
  `;

  const header = card.querySelector('.ocp-tool-header');
  header?.addEventListener('click', () => card.classList.toggle('expanded'));

  container.appendChild(card);
  return card;
}

function syncToolCard(card, toolName, toolInput, { result, isError = false, status } = {}) {
  if (!card) return card;
  const iconEl = card.querySelector('.ocp-tool-icon');
  const nameEl = card.querySelector('.ocp-tool-name');
  const summaryEl = card.querySelector('.ocp-tool-summary');
  const pillEl = card.querySelector('.ocp-tool-pill');
  const argsSection = card.querySelector('.ocp-tool-args-section');
  const argsPre = card.querySelector('.ocp-tool-args');
  const resultSection = card.querySelector('.ocp-tool-result-section');
  const resultPre = card.querySelector('.ocp-tool-result');
  const metaEl = card.querySelector('.ocp-tool-meta');

  const rawName = toolName || nameEl?.textContent || 'tool';
  const isSynaBun = rawName.startsWith('SynaBun_') || rawName.startsWith('mcp__SynaBun__');
  const displayName = isSynaBun ? synabunDisplayName(rawName) : standardDisplayName(rawName);
  if (iconEl) iconEl.innerHTML = toolIcon(rawName);
  if (nameEl) nameEl.textContent = displayName;
  if (toolInput !== undefined) {
    const argsText = pretty(toolInput);
    const summary = isSynaBun
      ? (synabunSummaryText(rawName, toolInput) || displayName)
      : (toolSummaryText(rawName, toolInput) || displayName);
    if (summaryEl) summaryEl.textContent = summary;
    if (argsSection && argsPre) {
      argsSection.hidden = !argsText.trim();
      argsPre.textContent = argsText;
      if (!argsSection.hidden) attachCopyButton(argsPre);
    }
  } else if (summaryEl && !summaryEl.textContent.trim()) {
    summaryEl.textContent = 'Tool call';
  }
  if (metaEl) {
    metaEl.hidden = !isError;
    metaEl.textContent = isError ? 'Tool reported an error.' : '';
  }
  if (result !== undefined && resultSection && resultPre) {
    const resultText = pretty(result);
    resultSection.hidden = !resultText.trim();
    resultPre.textContent = resultText;
    resultPre.classList.toggle('error', Boolean(resultText.trim()) && isError);
    if (!resultSection.hidden) attachCopyButton(resultPre);
  }

  const hasResult = Boolean(resultSection && !resultSection.hidden && resultPre?.textContent?.trim());
  const normalizedStatus = normalizeToolStatus(status || card.dataset.status, { hasResult, isError });
  card.dataset.status = normalizedStatus;
  if (pillEl) pillEl.textContent = normalizedStatus;

  return card;
}

// ── Render functions ──

export function renderUserMessage(container, content) {
  const div = document.createElement('div');
  div.className = 'ocp-msg ocp-msg-user';
  div.textContent = content;
  container.appendChild(div);
  scrollToBottom(container);
  return div;
}

function collectUserSegments(value, result = { text: [], files: [] }) {
  if (value == null) return result;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = normalizeTextContent(value, { stringifyObjects: false }).trim();
    if (text) result.text.push(text);
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectUserSegments(entry, result));
    return result;
  }
  if (typeof value !== 'object') return result;

  const type = String(value.type || '').trim().toLowerCase();
  if (type === 'text') {
    const text = normalizeTextContent(value.text ?? value.content ?? value.value ?? '', { stringifyObjects: false }).trim();
    if (text) result.text.push(text);
    return result;
  }
  if (type === 'file') {
    result.files.push({
      filename: value.filename || 'attachment',
      mime: value.mime || '',
      url: value.url || '',
    });
    return result;
  }
  if (Array.isArray(value.parts)) {
    collectUserSegments(value.parts, result);
    return result;
  }
  if (Array.isArray(value.content)) {
    collectUserSegments(value.content, result);
    return result;
  }
  return result;
}

function renderUserAttachmentSummary(files = []) {
  if (!files.length) return '';
  const imageCount = files.filter((file) => String(file.mime || '').startsWith('image/')).length;
  if (imageCount && imageCount === files.length) {
    return imageCount === 1 ? 'Attached 1 image' : `Attached ${imageCount} images`;
  }
  return files.length === 1 ? `Attached ${files[0].filename || '1 file'}` : `Attached ${files.length} files`;
}

export function renderUserPayload(container, payload) {
  const { text, files } = collectUserSegments(payload);
  const content = text.join('\n\n').trim();
  const summary = renderUserAttachmentSummary(files);
  if (!content && !summary) return null;

  const div = document.createElement('div');
  div.className = 'ocp-msg ocp-msg-user';

  if (content) {
    const textEl = document.createElement('div');
    textEl.textContent = content;
    div.appendChild(textEl);
  }
  if (summary) {
    const meta = document.createElement('div');
    meta.className = 'ocp-msg-user-meta';
    meta.textContent = summary;
    div.appendChild(meta);
  }

  container.appendChild(div);
  scrollToBottom(container);
  return div;
}

export function renderAssistantMessage(container, content) {
  const div = document.createElement('div');
  div.className = 'ocp-msg ocp-msg-assistant';
  setAssistantHtml(div, content);
  container.appendChild(div);
  scrollToBottom(container);
  return div;
}

export function renderErrorMessage(container, message) {
  const div = document.createElement('div');
  div.className = 'ocp-msg ocp-msg-error';
  div.textContent = message;
  container.appendChild(div);
  scrollToBottom(container);
  return div;
}

function clearThinkingTimer(el) {
  if (!el?._ocpThinkingTimer) return;
  clearInterval(el._ocpThinkingTimer);
  el._ocpThinkingTimer = null;
}

function updateThinkingTimer(el) {
  const timer = el?.querySelector('.ocp-thinking-timer');
  if (!timer) return;
  const startedAt = Number(el.dataset.startedAt || Date.now());
  const sec = Math.round((Date.now() - startedAt) / 1000);
  timer.textContent = sec > 0 ? `${sec}s` : '';
}

function ensurePendingAssistantEl(container) {
  let el = container.querySelector('.ocp-msg-assistant.pending');
  if (el) return el;
  el = document.createElement('div');
  el.className = 'ocp-msg ocp-msg-assistant pending';
  container.appendChild(el);
  return el;
}

/** Create or get the current streaming assistant message element. */
export function getOrCreateStreamingEl(container) {
  let el = container.querySelector('.ocp-msg-assistant.streaming');
  if (!el) {
    el = container.querySelector('.ocp-msg-assistant.pending');
    if (el) {
      clearThinkingTimer(el);
      el.classList.remove('pending');
    } else {
      el = document.createElement('div');
      el.className = 'ocp-msg ocp-msg-assistant';
      container.appendChild(el);
    }
    el.classList.add('streaming');
  }
  return el;
}

/** Append a text chunk to the streaming element. */
export function appendStreamChunk(container, text) {
  const chunk = normalizeTextContent(text, { stringifyObjects: false });
  if (!chunk) return getOrCreateStreamingEl(container);
  const el = getOrCreateStreamingEl(container);
  el.dataset.rawText = (el.dataset.rawText || '') + chunk;
  const doRender = throttle(() => {
    if (el.dataset.rawText != null) {
      setAssistantHtml(el, el.dataset.rawText);
      scrollToBottom(container);
    }
  }, 32);
  doRender();
  return el;
}

/** Append a reasoning/thinking chunk directly (for explicit reasoning part types). */
export function appendThinkChunk(container, text) {
  const chunk = normalizeTextContent(text, { stringifyObjects: false });
  if (!chunk) return getOrCreateStreamingEl(container);
  const el = getOrCreateStreamingEl(container);
  el.dataset.thinkText = (el.dataset.thinkText || '') + chunk;
  // Re-render: think block first, then any accumulated response text
  const thinkHtml = thinkBlockHtml(el.dataset.thinkText, true);
  const responseHtml = el.dataset.rawText ? renderAssistantMarkdown(el.dataset.rawText).html : '';
  el.innerHTML = thinkHtml + responseHtml;
  clearThinkingTimer(el);
  scrollToBottom(container);
  return el;
}

/** Finalize the streaming message (remove streaming class). */
export function finalizeStreamingMessage(container) {
  const el = container.querySelector('.ocp-msg-assistant.streaming');
  if (el) {
    el.classList.remove('streaming');
    if (el.dataset.rawText != null) {
      setAssistantHtml(el, el.dataset.rawText);
    }
    delete el.dataset.rawText;
  }
  const pending = container.querySelector('.ocp-msg-assistant.pending');
  if (pending) {
    clearThinkingTimer(pending);
    pending.remove();
  }
}

// ── Tool cards ──

export function renderToolCard(container, toolName, toolInput, toolId, options = {}) {
  const card = ensureToolCard(container, toolName, toolId);
  syncToolCard(card, toolName, toolInput, options);
  scrollToBottom(container);
  return card;
}

export function updateToolCard(container, toolId, result, isError = false, options = {}) {
  const card = ensureToolCard(container, options.toolName || 'tool', toolId);
  syncToolCard(card, options.toolName || card.querySelector('.ocp-tool-name')?.textContent || 'tool', options.toolInput, {
    ...options,
    result,
    isError,
  });
}

// ── Thinking indicator ──
// Standalone persistent element so it survives streaming/tool-card renders.
// Kept as the last child of the messages container while the turn runs.

function getThinkingEl(container) {
  return container.querySelector(':scope > .ocp-thinking');
}

export function showThinking(container, options = {}) {
  return updateThinking(container, options);
}

export function updateThinking(container, options = {}) {
  const {
    title = 'Thinking…',
    detail = '',
    startedAt,
    waiting = false,
  } = options;
  let el = getThinkingEl(container);
  if (!el) {
    el = document.createElement('div');
    el.className = 'ocp-thinking';
    el.innerHTML = `
      <div class="ocp-thinking-avatar">${OPENCODE_ICON}</div>
      <span class="ocp-thinking-dots"><span></span><span></span><span></span></span>
      <span class="ocp-thinking-title"></span>
      <span class="ocp-thinking-detail"></span>
      <span class="ocp-thinking-timer"></span>
    `;
    container.appendChild(el);
  }
  el.classList.toggle('ocp-thinking-waiting', !!waiting);
  const titleEl = el.querySelector('.ocp-thinking-title');
  const detailEl = el.querySelector('.ocp-thinking-detail');
  if (titleEl) titleEl.textContent = title || '';
  if (detailEl) detailEl.textContent = detail || '';
  if (startedAt || !el.dataset.startedAt) {
    el.dataset.startedAt = String(startedAt || Date.now());
  }
  clearThinkingTimer(el);
  updateThinkingTimer(el);
  el._ocpThinkingTimer = setInterval(() => updateThinkingTimer(el), 1000);
  repositionThinking(container);
  scrollToBottom(container);
  return el;
}

export function repositionThinking(container) {
  if (!container) return;
  const el = getThinkingEl(container);
  if (!el) return;
  if (el !== container.lastElementChild) {
    container.appendChild(el);
  }
}

export function removeThinking(container) {
  const el = getThinkingEl(container);
  if (el) {
    clearThinkingTimer(el);
    el.remove();
  }
  const legacy = container.querySelector('.ocp-msg-assistant.pending');
  if (legacy) {
    clearThinkingTimer(legacy);
    legacy.remove();
  }
}

// ── Empty state ──

export function renderEmptyState(container) {
  container.innerHTML = `
    <div class="ocp-empty">
      <svg viewBox="0 0 240 300"><path fill-rule="evenodd" d="M0 0h240v300H0V0zm30 30v240h180V30H30z" fill="currentColor"/><rect x="30" y="150" width="180" height="120" opacity=".45" fill="currentColor"/></svg>
      <span>OpenCode</span>
      <span style="font-size:10px;opacity:0.5">Send a message to start</span>
    </div>
  `;
}

// ── Render full history from messages:list response ──

export function renderAssistantPayload(container, payload, { textMode = 'render', skipQuestionTools = true } = {}) {
  const segments = collectAssistantSegments(payload);
  if (!segments.length) {
    const fallbackText = typeof payload === 'string' ? payload : '';
    if (!fallbackText.trim()) return false;
    if (textMode === 'stream') appendStreamChunk(container, fallbackText);
    else if (textMode === 'render') renderAssistantMessage(container, fallbackText);
    return true;
  }

  const textParts = [];
  const flushText = () => {
    if (!textParts.length) return;
    const text = textParts.join('\n\n').trim();
    textParts.length = 0;
    if (!text) return;
    if (textMode === 'stream') appendStreamChunk(container, text);
    else if (textMode === 'render') renderAssistantMessage(container, text);
  };

  for (const segment of segments) {
    if (segment.type === 'text') {
      textParts.push(segment.text);
      continue;
    }
    if (segment.type === 'thinking') {
      flushText();
      const thinkDiv = document.createElement('div');
      thinkDiv.innerHTML = thinkBlockHtml(segment.text || '', false);
      container.appendChild(thinkDiv.firstElementChild || thinkDiv);
      continue;
    }
    if (skipQuestionTools && segment.type === 'tool' && isQuestionTool(segment.name)) {
      continue;
    }
    flushText();
    renderToolCard(container, segment.name, segment.input, segment.id, {
      status: segment.status,
      result: segment.result,
      isError: segment.isError,
    });
  }

  flushText();
  return true;
}

function parseMessagePayload(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return (typeof value === 'object') ? value : null;
}

function normalizeHistoryPart(part, idx, messageId) {
  const payload = parseMessagePayload(part?.data) || part;
  if (!payload || typeof payload !== 'object') return null;
  return {
    id: payload.id || part?.id || `${messageId || 'part'}-${idx}`,
    ...payload,
  };
}

function normalizeHistoryMessage(message) {
  const payload = parseMessagePayload(message?.data) || message || {};
  const info = parseMessagePayload(message?.info) || parseMessagePayload(payload?.info) || {};
  const parts = (Array.isArray(message?.parts) ? message.parts : (Array.isArray(payload?.parts) ? payload.parts : []))
    .map((part, idx) => normalizeHistoryPart(part, idx, message?.id || payload?.id || info?.id))
    .filter(Boolean);

  return {
    ...message,
    ...payload,
    ...info,
    role: message?.role || payload?.role || info?.role || null,
    parts,
    content: message?.content
      ?? payload?.content
      ?? info?.content
      ?? (parts.length ? parts : null)
      ?? message?.text
      ?? payload?.text
      ?? info?.text
      ?? null,
  };
}

export function renderHistory(container, messages) {
  container.innerHTML = '';
  if (!messages || !messages.length) {
    renderEmptyState(container);
    return;
  }
  let renderedCount = 0;
  for (const rawMsg of messages) {
    const msg = normalizeHistoryMessage(rawMsg);
    if (msg.role === 'user') {
      if (renderUserPayload(container, msg.content ?? msg.parts ?? msg.text ?? '')) {
        renderedCount += 1;
      }
    } else if (msg.role === 'assistant') {
      if (renderAssistantPayload(container, msg.content ?? msg.parts ?? msg.text ?? '')) {
        renderedCount += 1;
      }
    }
  }
  if (!renderedCount) {
    renderEmptyState(container);
    return;
  }
  scrollToBottom(container);
}

// ── Question cards (AskUserQuestion interactive) ──

const QUESTION_TOOL_NAMES = new Set(['question', 'askuserquestion', 'ask_user_question', 'ask_user', 'user_question']);

export function isQuestionTool(toolName) {
  const key = String(toolName || '').toLowerCase().replace(/[^a-z_]/g, '');
  return QUESTION_TOOL_NAMES.has(key);
}

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((opt, i) => {
    if (typeof opt === 'string') return { value: opt, label: opt, description: '' };
    return {
      value: opt.value ?? opt.label ?? opt.text ?? String(i),
      label: opt.label || opt.text || opt.value || `Option ${i + 1}`,
      description: opt.description || opt.desc || '',
    };
  });
}

function extractAllQuestions(input) {
  if (!input || typeof input !== 'object') return [];
  const questions = Array.isArray(input.questions) ? input.questions
    : (input.question || input.text || input.options) ? [input]
    : [input];
  return questions.map(q => ({
    question: q.question || q.text || q.message || '',
    header: q.header || '',
    options: normalizeOptions(q.options || q.choices),
    multiSelect: q.multiSelect === true || q.multiple === true,
    custom: q.custom !== false,
  }));
}

export function renderQuestionCard(container, toolName, toolInput, toolId, { onAnswer } = {}) {
  const questions = extractAllQuestions(toolInput);
  const totalQuestions = questions.length;

  const card = document.createElement('div');
  card.className = 'ocp-question-card';
  card.dataset.toolId = toolId || '';

  // Header
  card.innerHTML = `
    <div class="ocp-question-header">
      <svg class="ocp-question-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span class="ocp-question-title">Needs Input</span>
    </div>
  `;

  const body = document.createElement('div');
  body.className = 'ocp-question-body';

  // Intro text for multiple questions
  if (totalQuestions > 1) {
    const intro = document.createElement('div');
    intro.className = 'ocp-question-intro';
    intro.textContent = `Answer all ${totalQuestions} questions below, then click Submit.`;
    body.appendChild(intro);
  }

  // Batched answer collection
  const pendingAnswers = {};
  const submitBtn = document.createElement('button');
  submitBtn.className = 'ocp-question-submit';
  submitBtn.disabled = true;
  submitBtn.textContent = totalQuestions > 1 ? `Submit (0/${totalQuestions})` : 'Submit';

  function updateSubmitState() {
    const answered = Object.keys(pendingAnswers).length;
    if (totalQuestions > 1) {
      submitBtn.textContent = `Submit (${answered}/${totalQuestions})`;
    }
    submitBtn.disabled = answered < totalQuestions;
  }

  // Render each question block
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const questionKey = q.question || q.header || `question_${qi}`;
    const block = document.createElement('div');
    block.className = 'ocp-question-block';

    // Header chip
    if (q.header) {
      const chip = document.createElement('span');
      chip.className = 'ocp-question-header-chip';
      chip.textContent = q.header;
      block.appendChild(chip);
    }

    // Question text
    if (q.question && q.question !== q.header) {
      const qText = document.createElement('div');
      qText.className = 'ocp-question-text';
      qText.textContent = q.question;
      block.appendChild(qText);
    }

    // Multi-select hint
    if (q.multiSelect) {
      const hint = document.createElement('div');
      hint.className = 'ocp-question-multi-hint';
      hint.textContent = 'Select all that apply';
      block.appendChild(hint);
    }

    if (q.options.length) {
      const optsEl = document.createElement('div');
      optsEl.className = 'ocp-question-options';

      // Check if explicit "Other" option exists
      const hasExplicitOther = q.options.some(o => /^other$/i.test(o.label));

      // Build options (explicit + auto-added Other)
      const allOptions = [...q.options];
      if (!hasExplicitOther) {
        allOptions.push({ label: 'Other', value: '__other__', description: 'Type a different answer.' });
      }

      // Other input (hidden initially)
      const otherWrap = document.createElement('div');
      otherWrap.className = 'ocp-question-other';
      otherWrap.hidden = true;
      const otherInput = document.createElement('input');
      otherInput.type = 'text';
      otherInput.className = 'ocp-question-other-input';
      otherInput.placeholder = 'Type your answer\u2026';
      otherInput.addEventListener('input', () => {
        if (!otherWrap.hidden) {
          const val = otherInput.value.trim();
          if (val) pendingAnswers[questionKey] = val;
          else delete pendingAnswers[questionKey];
          updateSubmitState();
        }
      });
      otherWrap.appendChild(otherInput);

      for (const opt of allOptions) {
        const isOther = opt.value === '__other__' || /^other$/i.test(opt.label);
        const btn = document.createElement('button');
        btn.className = `ocp-question-option${q.multiSelect ? ' multi' : ''}`;
        btn.innerHTML = `
          <span class="ocp-question-option-radio"></span>
          <span>
            <span class="ocp-question-option-label">${esc(opt.label)}</span>
            ${opt.description ? `<div class="ocp-question-option-desc">${esc(opt.description)}</div>` : ''}
          </span>
        `;
        btn.addEventListener('click', () => {
          if (q.multiSelect && !isOther) {
            btn.classList.toggle('selected');
            const selected = [];
            optsEl.querySelectorAll('.ocp-question-option.selected').forEach(b => {
              const lbl = b.querySelector('.ocp-question-option-label');
              if (lbl && !/^other$/i.test(lbl.textContent)) selected.push(lbl.textContent);
            });
            if (selected.length > 0) pendingAnswers[questionKey] = selected.join(', ');
            else delete pendingAnswers[questionKey];
          } else {
            optsEl.querySelectorAll('.ocp-question-option').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            if (isOther) {
              otherWrap.hidden = false;
              const val = otherInput.value.trim();
              if (val) pendingAnswers[questionKey] = val;
              else delete pendingAnswers[questionKey];
              queueMicrotask(() => otherInput.focus());
            } else {
              otherWrap.hidden = true;
              pendingAnswers[questionKey] = opt.label;
            }
          }
          updateSubmitState();
        });
        optsEl.appendChild(btn);
      }

      block.appendChild(optsEl);
      block.appendChild(otherWrap);
    } else {
      // No options — free-text input
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.className = 'ocp-question-other-input';
      textInput.placeholder = 'Type your answer\u2026';
      textInput.addEventListener('input', () => {
        const val = textInput.value.trim();
        if (val) pendingAnswers[questionKey] = val;
        else delete pendingAnswers[questionKey];
        updateSubmitState();
      });
      block.appendChild(textInput);
    }

    body.appendChild(block);
  }

  // Submit bar
  const actions = document.createElement('div');
  actions.className = 'ocp-question-actions';
  submitBtn.addEventListener('click', () => {
    body.querySelectorAll('.ocp-question-option').forEach(b => { b.disabled = true; });
    body.querySelectorAll('input').forEach(i => { i.disabled = true; });
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitted';
    card.classList.add('locked');
    if (typeof onAnswer === 'function') onAnswer(pendingAnswers);
  });
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  card.appendChild(body);
  container.appendChild(card);
  scrollToBottom(container);
  return card;
}

export function lockQuestionCard(container, toolId) {
  if (!container || !toolId) return;
  const card = container.querySelector(`.ocp-question-card[data-tool-id="${toolId}"]`);
  if (card) card.classList.add('locked');
}

// ── Post-plan action card ──

export function renderPostPlanCard(container, { onContinue, onCompact, onEditPlan } = {}) {
  const card = document.createElement('div');
  card.className = 'ocp-post-plan-card';
  card.innerHTML = `
    <div class="ocp-post-plan-header">
      <svg class="ocp-post-plan-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      PLAN COMPLETE
    </div>
    <div class="ocp-post-plan-note">Review the plan above, then choose how to proceed.</div>
    <div class="ocp-post-plan-actions">
      <button class="ocp-post-plan-btn primary" data-action="continue">Continue with implementation</button>
      <button class="ocp-post-plan-btn" data-action="compact">Compact context</button>
      <button class="ocp-post-plan-btn" data-action="edit">Edit plan</button>
    </div>
  `;

  card.querySelector('[data-action="continue"]').addEventListener('click', () => {
    card.remove();
    if (typeof onContinue === 'function') onContinue();
  });
  card.querySelector('[data-action="compact"]').addEventListener('click', () => {
    if (typeof onCompact === 'function') onCompact();
  });
  card.querySelector('[data-action="edit"]').addEventListener('click', () => {
    if (typeof onEditPlan === 'function') onEditPlan();
  });

  container.appendChild(card);
  scrollToBottom(container);
  return card;
}

export function removePostPlanCards(container) {
  if (!container) return;
  container.querySelectorAll('.ocp-post-plan-card').forEach(el => el.remove());
}

// ── Tool-activity dock (session-long activity log) ──

export function describeTool(rawName, toolInput) {
  const name = String(rawName || 'tool');
  const isSynaBun = name.startsWith('SynaBun_') || name.startsWith('mcp__SynaBun__');
  const displayName = isSynaBun ? synabunDisplayName(name) : standardDisplayName(name);
  const summary = isSynaBun
    ? (synabunSummaryText(name, toolInput) || '')
    : (toolSummaryText(name, toolInput) || '');
  return { displayName, summary, isSynaBun };
}

function activityStatusIcon(status) {
  switch (status) {
    case 'complete': return '✓';
    case 'error':    return '✕';
    case 'aborted':  return '·';
    case 'running':
    default:         return '◐';
  }
}

function activityStatusClass(status) {
  switch (status) {
    case 'complete': return 'done';
    case 'error':    return 'err';
    case 'aborted':  return 'abort';
    case 'running':
    default:         return 'run';
  }
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return rem ? `${minutes}m${rem}s` : `${minutes}m`;
}

const SUBAGENT_BADGE_TONES = {
  explore: 'tone-blue',
  research: 'tone-purple',
  simplify: 'tone-green',
  plan: 'tone-amber',
  planner: 'tone-amber',
  'general-purpose': 'tone-neutral',
};
function subagentBadgeTone(subtype) {
  const key = String(subtype || '').trim().toLowerCase();
  if (!key) return '';
  return SUBAGENT_BADGE_TONES[key] || 'tone-neutral';
}

function activityStepHtml(step, isActive) {
  const cls = step.status === 'running' ? 'run'
    : step.status === 'error' ? 'err'
    : step.status === 'aborted' ? 'abort'
    : 'done';
  const icon = step.status === 'running' ? '◐'
    : step.status === 'error' ? '✕'
    : step.status === 'aborted' ? '·'
    : '✓';
  const activeCls = isActive ? ' is-active' : '';
  const synabunCls = step.isSynaBun ? ' synabun' : '';
  const iconHtml = step.rawName ? toolIcon(step.rawName) : '';
  return `<div class="ocp-activity-step ${cls}${activeCls}${synabunCls}">
    <span class="ocp-activity-step-status" aria-hidden="true">${icon}</span>
    ${iconHtml ? `<span class="ocp-activity-step-tool" aria-hidden="true">${iconHtml}</span>` : '<span class="ocp-activity-step-tool"></span>'}
    <span class="ocp-activity-step-body">
      <span class="ocp-activity-step-name">${esc(step.name || 'tool')}</span>
      ${step.summary ? `<span class="ocp-activity-step-summary">${esc(step.summary)}</span>` : ''}
    </span>
  </div>`;
}

function activityRowHtml(entry, { expanded }) {
  const statusClass = activityStatusClass(entry.status);
  const icon = activityStatusIcon(entry.status);
  const endedAt = entry.endedAt || 0;
  const startedAt = entry.startedAt || 0;
  const isRunning = entry.status === 'running';
  const elapsed = isRunning
    ? formatElapsed(Date.now() - startedAt)
    : (endedAt && startedAt ? formatElapsed(endedAt - startedAt) : '');
  const toolIdAttr = entry.toolId ? ` data-tool-id="${escAttr(entry.toolId)}"` : '';
  const keyAttr = entry.key ? ` data-agent-key="${escAttr(entry.key)}"` : '';
  const subagent = entry.subagentType
    ? `<span class="ocp-activity-row-subtype ${subagentBadgeTone(entry.subagentType)}">${esc(entry.subagentType)}</span>`
    : '';
  const description = entry.description || entry.summary || '';
  const steps = Array.isArray(entry.steps) ? entry.steps : [];
  const activeKey = entry.activeStep || '';
  const toolsUsed = Number.isFinite(entry.toolsUsed) ? entry.toolsUsed : steps.length;

  // Steps: compact (one latest) or expanded (all)
  let stepHtml = '';
  if (expanded && steps.length) {
    const allHtml = steps.map(step => activityStepHtml(step, step.key === activeKey)).join('');
    stepHtml = `<div class="ocp-activity-row-steps is-expanded">${allHtml}</div>`;
  } else if (steps.length) {
    const latest = steps[steps.length - 1];
    stepHtml = `<div class="ocp-activity-row-steps">${activityStepHtml(latest, latest.key === activeKey)}</div>`;
  } else if (isRunning) {
    stepHtml = `<div class="ocp-activity-row-steps">
      <div class="ocp-activity-step run is-active shimmer">
        <span class="ocp-activity-step-status" aria-hidden="true">◐</span>
        <span class="ocp-activity-step-tool"></span>
        <span class="ocp-activity-step-body">
          <span class="ocp-activity-step-name">Initializing agent…</span>
        </span>
      </div>
    </div>`;
  }

  // Meta row: tools used pill + elapsed
  const toolsPill = toolsUsed > 0
    ? `<span class="ocp-activity-row-tools">${toolsUsed} tool${toolsUsed === 1 ? '' : 's'}</span>`
    : '';
  const elapsedHtml = elapsed ? `<span class="ocp-activity-row-time">${esc(elapsed)}</span>` : '';

  // Action buttons
  const canAbort = isRunning;
  const abortDisabled = !entry.childSessionId;
  const abortTitle = abortDisabled ? 'Waiting for subagent session…' : 'Abort subagent';
  const abortBtn = canAbort
    ? `<button type="button" class="ocp-activity-row-action ocp-activity-row-abort" data-action="abort"${abortDisabled ? ' disabled' : ''} title="${abortTitle}" aria-label="${abortTitle}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`
    : '';
  const jumpBtn = entry.toolId
    ? `<button type="button" class="ocp-activity-row-action ocp-activity-row-jump" data-action="jump" title="Jump to tool card" aria-label="Jump to tool card">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"/><polyline points="7 7 17 7 17 17"/></svg>
      </button>`
    : '';

  const caret = `<span class="ocp-activity-row-caret${expanded ? ' is-open' : ''}" aria-hidden="true">▸</span>`;

  const expandedAttr = expanded ? ' data-expanded="true"' : '';
  return `<div class="ocp-activity-row ocp-activity-agent ocp-activity-${statusClass}"${toolIdAttr}${keyAttr}${expandedAttr}>
    <div class="ocp-activity-row-head" data-action="toggle">
      ${caret}
      <span class="ocp-activity-row-icon">${icon}</span>
      <span class="ocp-activity-row-body">
        <span class="ocp-activity-row-name-line">
          <span class="ocp-activity-row-name">Agent</span>
          ${subagent}
        </span>
        ${description ? `<span class="ocp-activity-row-summary">${esc(description)}</span>` : ''}
        ${(toolsPill || elapsedHtml) ? `<span class="ocp-activity-row-meta">${toolsPill}${elapsedHtml}</span>` : ''}
      </span>
      <span class="ocp-activity-row-actions">
        ${abortBtn}
        ${jumpBtn}
      </span>
    </div>
    ${stepHtml}
  </div>`;
}

export function focusActivityToolCard(panelRoot, toolId) {
  if (!panelRoot || !toolId) return;
  const card = panelRoot.querySelector(`.ocp-tool-card[data-tool-id="${CSS.escape(String(toolId))}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.remove('ocp-tool-card-focus');
  void card.offsetWidth;
  card.classList.add('ocp-tool-card-focus');
  setTimeout(() => card.classList.remove('ocp-tool-card-focus'), 1400);
}

// Update elapsed time badges in-place without re-rendering the whole drawer.
// Returns true if any running rows were updated (so caller can keep the ticker alive).
export function tickActivityDockElapsed(tab, panelRoot) {
  if (!panelRoot) return false;
  const dock = panelRoot.querySelector('.ocp-activity-dock');
  if (!dock) return false;
  const entries = Array.isArray(tab?.toolActivity) ? tab.toolActivity : [];
  let anyRunning = false;
  const now = Date.now();
  for (const entry of entries) {
    if (entry.status !== 'running') continue;
    anyRunning = true;
    const key = entry.key;
    if (!key) continue;
    const row = dock.querySelector(`.ocp-activity-row[data-agent-key="${CSS.escape(String(key))}"]`);
    if (!row) continue;
    const timeEl = row.querySelector('.ocp-activity-row-time');
    if (timeEl) timeEl.textContent = formatElapsed(now - (entry.startedAt || now));
  }
  return anyRunning;
}

export function renderToolActivityDock(tab, panelRoot, callbacks = {}) {
  if (!panelRoot) return;
  const { onToggle, onAbortAgent, onJumpToCard, onToggleExpand } = callbacks;
  let dock = panelRoot.querySelector('.ocp-activity-dock');
  const entries = Array.isArray(tab?.toolActivity) ? tab.toolActivity : [];

  if (!entries.length) {
    if (dock) dock.remove();
    return;
  }

  const isOpen = !!tab.toolActivityVisible;
  let runningCount = 0;
  for (const e of entries) {
    if (e.status === 'running') runningCount += 1;
  }
  const totalCount = entries.length;
  const tagCount = runningCount || totalCount;
  const expandedMap = tab.toolActivityExpanded || {};

  if (!dock) {
    dock = document.createElement('div');
    dock.className = 'ocp-activity-dock';
    panelRoot.appendChild(dock);
  }
  dock.classList.toggle('open', isOpen);

  const tagTitle = isOpen ? 'Hide agents (Ctrl+Shift+A)' : 'Show agents (Ctrl+Shift+A)';
  const tagClass = runningCount > 0 ? 'ocp-activity-tag running' : 'ocp-activity-tag';

  // Preserve scroll position across re-renders
  const prevList = dock.querySelector('.ocp-activity-list');
  let prevScroll = null;
  let wasAtBottom = true;
  if (prevList) {
    prevScroll = prevList.scrollTop;
    wasAtBottom = (prevList.scrollHeight - prevList.scrollTop - prevList.clientHeight) < 40;
  }

  dock.innerHTML = `
    <div class="ocp-activity-drawer">
      <div class="ocp-activity-header">
        <span class="ocp-activity-header-title">
          ${runningCount > 0 ? '<span class="ocp-activity-header-dot"></span>' : ''}
          Agents
        </span>
        <span class="ocp-activity-header-count">${runningCount ? `${runningCount}/` : ''}${totalCount}</span>
        <button class="ocp-activity-header-hide" type="button" title="Collapse (Ctrl+Shift+A)" aria-label="Close agents drawer">×</button>
      </div>
      <div class="ocp-activity-list">
        ${entries.map(e => activityRowHtml(e, { expanded: !!expandedMap[e.key] })).join('')}
      </div>
    </div>
    <button class="${tagClass}" title="${escAttr(tagTitle)}" type="button">
      ${runningCount > 0 ? '<span class="ocp-activity-tag-dot"></span>' : ''}
      <span class="ocp-activity-tag-count">${tagCount} ${runningCount > 0 ? 'RUN' : 'AGT'}</span>
    </button>
  `;

  dock.querySelector('.ocp-activity-tag')?.addEventListener('click', () => {
    if (typeof onToggle === 'function') onToggle(!isOpen);
  });
  dock.querySelector('.ocp-activity-header-hide')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (typeof onToggle === 'function') onToggle(false);
  });

  dock.querySelectorAll('.ocp-activity-row').forEach((row) => {
    const agentKey = row.dataset.agentKey;
    const toolId = row.dataset.toolId;

    row.addEventListener('click', (ev) => {
      const actionEl = ev.target.closest('[data-action]');
      const action = actionEl?.dataset.action;
      if (action === 'abort') {
        ev.stopPropagation();
        if (actionEl.hasAttribute('disabled')) return;
        if (typeof onAbortAgent === 'function' && agentKey) onAbortAgent(agentKey);
        return;
      }
      if (action === 'jump') {
        ev.stopPropagation();
        if (typeof onJumpToCard === 'function' && toolId) onJumpToCard(toolId);
        return;
      }
      // Default: toggle expand when clicking the head/body
      if (typeof onToggleExpand === 'function' && agentKey) onToggleExpand(agentKey);
    });
  });

  if (isOpen) {
    const list = dock.querySelector('.ocp-activity-list');
    if (!list) return;
    if (prevScroll != null && !wasAtBottom) {
      list.scrollTop = prevScroll;
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }
}

// ── Helpers ──

function scrollToBottom(container) {
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}
