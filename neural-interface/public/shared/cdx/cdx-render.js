// ═══════════════════════════════════════════
// SynaBun — Codex Panel: Render Module
// Text utilities, card rendering, delta appending, and history rendering.
// ═══════════════════════════════════════════

import {
  OPENAI_ICON, ICON_SPARK, ICON_TERMINAL, ICON_TOOL, ICON_FILES,
  ICON_STOP, ICON_EDIT, ICON_SHIELD, ICON_PLAN, ICON_BRAIN,
  SYNABUN_LOGO_ICON,
  CODEX_GREETING_MARKER_START, CODEX_GREETING_MARKER_END,
  CODEX_PLAN_MODE_PREFIXES,
} from './cdx-icons.js';
import { buildCodexPlanRevisionPrompt, codexGenericCardHead, codexReadableValue, codexTranscriptPresentation, selectCodexHistoryRenderSource } from './cdx-protocol.js';
import { getPlanMarkdown, approvePlan, extractProposedPlan, syncPlanMirrors, isRecordedPlanTurn, isPlanMessageCandidate, selectPlanAdoptionMessage } from './cdx-plan.js';
import { bindExpandableCard, setCardExpanded } from './cdx-cards.js';
import { mountMcpAppCard } from './cdx-mcp-app-host.js';
import { OUTPUT_LIMITS, boundedText, jsonAnswer, prettyJsonFences, readableStructuredValue, fileChangeDiffs, parseUnifiedDiff, deduplicateTurnDiff } from './cdx-output-model.js';
import { renderReadableOutput, renderReadableBlock, cleanOutputBlocks, hydrateOutputControls, observeOutputBlocks, renderDiffView, restoreDiffViews } from './cdx-output.js';
export { setCardExpanded } from './cdx-cards.js';

// ── Shared context (set by cdx-tabs via setRenderContext) ──
let _ctx = {
  get items() { return new Map(); },
  get requestCards() { return new Map(); },
  get messagesEl() { return null; },
  get project() { return ''; },
  get projects() { return []; },
  get activeItems() { return new Map(); },
  get marked() { return null; },
  get hljs() { return null; },
  get boundTab() { return null; },
  get accountId() { return 'default'; },
  get connectionEpoch() { return ''; },
  get activeTurnId() { return null; },
  get threadId() { return null; },
  get transcriptSourceType() { return ''; },
  get running() { return false; },
  get startingThread() { return false; },
  get compacting() { return false; },
  get threadTokenUsage() { return null; },
  scrollEnd() {},
  sendSocket() {},
  emit() {},
  activeTab() { return null; },
  isActiveTab() { return false; },
  dispatchPrompt() {},
  capturePlanContent() {},
  saveTabs() {},
  hideEmpty() {},
  showEmpty() {},
  repositionThinking() {},
  pruneTranscriptDom() {},
  scheduleThreadSnapshotSave() {},
  flushThreadSnapshotSave() {},
  setTranscriptSourceMeta() {},
  withTab() {},
  createRequestButton() {},
  formatStatus() { return 'pending'; },
  itemHeadline() { return { title: '', detail: '' }; },
  cleanPreview() { return ''; },
  syncToolbarState() {},
  startCompaction() {},
  syncWorkStatus() {},
  clearTranscript() {},
  setThread() {},
  renderStoredTranscript() { return false; },
  updateThreadTokenUsage() {},
  setShowPostCompactionPrompt() {},
  setPostCompactionPending() {},
  setPostCompactionPromptSource() {},
  setPlanFeedbackDraft() {},
  getThreadSnapshot() { return null; },
  normalizeThreadSnapshotEntry() { return null; },
  normalizeSnapshotSourceType() { return ''; },
  normalizeSnapshotItemCount() { return 0; },
  timestampMs() { return 0; },
  setCompactingUI() {},
  renderStatusChrome() {},
  itemOwnershipBelongsToBoundThread() { return false; },
};

export function setRenderContext(ctx) { _ctx = ctx; }

// ═══════════════════════════════════════════
// Text Utilities
// ═══════════════════════════════════════════

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Codex re-renders every assistant message through marked.parse() on every
// streaming delta tick. Memoize so identical text — unchanged messages
// elsewhere in the transcript that get re-rendered anyway — returns cached
// HTML without re-parsing.
const _mdCache = new Map();
const _MD_CACHE_LIMIT = 512;
let _mdRenderer = null;
let _mdParser;
function markdownFallback(text) {
  const source = prettyJsonFences(text);
  const fence = /^(`{3,}|~{3,})([\w-]*)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;
  let html = '', last = 0;
  for (const match of source.matchAll(fence)) {
    html += esc(source.slice(last, match.index)).replace(/\n/g, '<br>');
    html += `<pre><code${match[2] ? ` class="language-${esc(match[2])}"` : ''}>${esc(match[3])}</code></pre>`;
    last = match.index + match[0].length;
  }
  return html + esc(source.slice(last)).replace(/\n/g, '<br>');
}
export function md(text) {
  // Contexts expose marked through a live getter: it can arrive after the first
  // render or be replaced without setRenderContext being called again.
  const renderer = _ctx.marked;
  const parser = renderer?.parse;
  if (renderer !== _mdRenderer || parser !== _mdParser) {
    _mdCache.clear();
    _mdRenderer = renderer;
    _mdParser = parser;
  }
  const key = text || '';
  if (key.length > OUTPUT_LIMITS.input) return `<pre class="cxp-card-pre cxp-output-raw"><code>${esc(boundedText(key))}</code></pre>`;
  const cached = _mdCache.get(key);
  if (cached !== undefined) return cached;
  let html;
  if (!renderer) {
    html = markdownFallback(key);
  } else {
    try { html = parser.call(renderer, prettyJsonFences(key)); }
    catch { html = markdownFallback(key); }
  }
  if (_mdCache.size >= _MD_CACHE_LIMIT) {
    const firstKey = _mdCache.keys().next().value;
    if (firstKey !== undefined) _mdCache.delete(firstKey);
  }
  _mdCache.set(key, html);
  return html;
}

export function renderAssistantMarkdown(text, { streaming = false } = {}) {
  const tpl = document.createElement('template');
  if (!renderReadableOutput(tpl.content, text || '', { streaming })) tpl.innerHTML = md(text || '');
  // Codex occasionally emits standalone separators that render as stray rules in the sidepanel.
  tpl.content.querySelectorAll('hr').forEach((node) => node.remove());
  tpl.content.querySelectorAll('p').forEach((node) => {
    if (!node.textContent.trim() && !node.querySelector('img,svg,code,pre,table,ul,ol,blockquote')) node.remove();
  });
  return {
    html: tpl.innerHTML,
    hasContent: Boolean((tpl.content.textContent || '').trim() || tpl.content.querySelector('img,svg,code,pre,table,ul,ol,blockquote')),
  };
}

function extractCompactAssistantSummary(text) {
  const value = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' [image] ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[#>\-\*\d\.\s]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return 'Working through the next step';
  return value;
}

// ═══════════════════════════════════════════
// Choice / Inline Button Utilities
// ═══════════════════════════════════════════

const SYNABUN_CHOICE_LABEL_RE = /\b(Brainstorm Ideas|Audit Memories|Memorize Context|Memory Health|Search Memories|Auto Changelog|More(?:\.\.\.)?|Back|Freeform|Current project|Run full audit|View details|View full|Search again|Save as-is|Edit first|Cancel|Done)\b/i;

export function normalizeChoiceLabel(value) {
  return String(value || '')
    .replace(/[`*_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isChangelogChoiceSet(options = []) {
  const labels = options.map((option) => normalizeChoiceLabel(option?.label || option?.value || option).toLowerCase());
  return labels.includes('save as-is') && labels.includes('edit first');
}

export function isSynaBunChoicePrompt(promptText = '', options = []) {
  if (!options.length) return false;
  const prompt = normalizeChoiceLabel(promptText);
  if (/synabun/i.test(prompt)) return true;
  // Require at least 2 individual labels to match — a single generic hit
  // like "Done" or "Back" in informational lists shouldn't trigger branding.
  const matchCount = options.filter((option) =>
    SYNABUN_CHOICE_LABEL_RE.test(normalizeChoiceLabel(option?.label || option?.value || option)),
  ).length;
  return matchCount >= 2;
}

export function isLikelyInteractivePrompt(promptText = '', options = []) {
  const prompt = normalizeChoiceLabel(promptText);
  if (/^(reply\s+with\s+one\s+of|choose\s+one|pick\s+one|select\s+(one|an?\s+option))/i.test(prompt)) return true;
  if (isSynaBunChoicePrompt(prompt, options)) return true;
  if (!options.length || options.length > 6) return false;
  if (!/[?]$/.test(prompt)) return false;
  return options.every((option) => normalizeChoiceLabel(option?.label || option?.value || option).length <= 48);
}

export function extractChoiceOption(li) {
  if (!li) return null;
  const clone = li.cloneNode(true);
  let label = '';
  const strong = clone.querySelector('strong');
  const code = !strong ? clone.querySelector('code') : null;
  if (strong) {
    label = normalizeChoiceLabel(strong.textContent);
    strong.remove();
  } else if (code) {
    label = normalizeChoiceLabel(code.textContent);
    code.remove();
  }
  let desc = normalizeChoiceLabel(clone.textContent || '');
  desc = desc.replace(/^[\u2014\u2013\-—–:]\s*/, '').trim();
  if (!label) {
    const match = desc.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    if (match) {
      label = normalizeChoiceLabel(match[1]);
      desc = normalizeChoiceLabel(match[2]);
    } else {
      label = desc;
      desc = '';
    }
  }
  if (!label) return null;
  return { label, desc };
}

export function extractChoiceOptionsFromList(listEl) {
  if (!listEl || !/^(UL|OL)$/.test(listEl.tagName)) return [];
  return Array.from(listEl.querySelectorAll(':scope > li')).map(extractChoiceOption).filter(Boolean);
}

export function restoreChangelogButtons(buttons = []) {
  buttons.forEach((button) => {
    if (!button) return;
    button.disabled = false;
    button.classList.remove('selected', 'chosen', 'dismissed');
  });
}

export function buildInlineChoiceButtons(options, {
  synabun = false,
  promptText = '',
} = {}) {
  const wrap = document.createElement('div');
  wrap.className = `cxp-inline-choices${synabun ? ' cxp-inline-choices-synabun' : ''}`;
  const isChangelogAsk = isChangelogChoiceSet(options);

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cxp-inline-choice';
    btn.innerHTML =
      `<span class="cxp-inline-choice-label">${esc(opt.label)}</span>` +
      (opt.desc ? `<span class="cxp-inline-choice-desc">${esc(opt.desc)}</span>` : '');
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('chosen') || btn.classList.contains('dismissed')) return;
      const allButtons = Array.from(wrap.querySelectorAll('.cxp-inline-choice'));
      if (isChangelogAsk && /edit first/i.test(opt.label)) {
        allButtons.forEach((button) => { button.disabled = true; });
        btn.classList.add('chosen');
        const opened = await openChangelogEditorFlow({
          source: synabun ? 'synabun-inline' : 'inline',
          buttons: allButtons,
        });
        if (!opened) restoreChangelogButtons(allButtons);
        return;
      }
      wrap.querySelectorAll('.cxp-inline-choice').forEach((button) => button.classList.add('dismissed'));
      btn.classList.remove('dismissed');
      btn.classList.add('chosen');
      _ctx.dispatchPrompt(opt.label);
    });
    wrap.appendChild(btn);
  }

  if (!synabun) return wrap;

  const card = document.createElement('div');
  card.className = 'cxp-synabun-inline-card';
  card.innerHTML = `
    <div class="cxp-synabun-inline-head">
      <div class="cxp-synabun-inline-logo">${SYNABUN_LOGO_ICON}</div>
      <div class="cxp-synabun-inline-title">SynaBun</div>
    </div>
  `;
  const cleanedPrompt = normalizeChoiceLabel(promptText).replace(/^synabun\s*[—-]\s*/i, '').trim();
  if (cleanedPrompt) {
    const promptEl = document.createElement('div');
    promptEl.className = 'cxp-synabun-inline-prompt';
    promptEl.textContent = cleanedPrompt;
    card.appendChild(promptEl);
  }
  card.appendChild(wrap);
  return card;
}

/** Detect choice prompts + adjacent list markup and convert to clickable buttons. */
export function convertInlineChoices(container) {
  if (!container) return;
  const paragraphs = Array.from(container.querySelectorAll('p'));
  for (const p of paragraphs) {
    const promptText = normalizeChoiceLabel(p.textContent || '');
    // Check direct sibling first; if <p> is inside a <blockquote>, check the blockquote's sibling
    let listEl = p.nextElementSibling;
    const parentBq = (!listEl || !/^(UL|OL)$/.test(listEl.tagName))
      ? p.closest('blockquote')
      : null;
    if (parentBq) listEl = parentBq.nextElementSibling;
    const options = extractChoiceOptionsFromList(listEl);
    if (!isLikelyInteractivePrompt(promptText, options)) continue;
    const choiceEl = buildInlineChoiceButtons(options, {
      synabun: isSynaBunChoicePrompt(promptText, options),
      promptText,
    });
    const trailingInstruction = listEl?.nextElementSibling;
    if (parentBq) parentBq.replaceWith(choiceEl);
    else p.replaceWith(choiceEl);
    listEl?.remove();
    if (trailingInstruction?.tagName === 'P') {
      const trailingText = normalizeChoiceLabel(trailingInstruction.textContent || '');
      if (/^reply\s+with\s+(one|[\d,\s]+or\s+\d+)(\s+option(\s+name\s+or\s+number)?)?\.?/i.test(trailingText)) {
        trailingInstruction.remove();
      }
    }
  }
}

// ═══════════════════════════════════════════
// Post-processing & HTML utilities
// ═══════════════════════════════════════════

export function postProcessRenderedHtml(container) {
  if (!container) return;
  cleanOutputBlocks(container);
  hydrateOutputControls(container);
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.cxp-readable, .cxp-output-source, .cxp-diff-view') || pre.querySelector('.cxp-readable')) return;
    if (pre.querySelector('.cxp-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'cxp-copy-btn';
    btn.textContent = 'Copy';
    const copyText = (pre.querySelector('code') || pre).textContent || '';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(copyText).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }).catch(() => {});
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
  if (_ctx.hljs) {
    container.querySelectorAll('pre code[class*="language-"]').forEach((block) => {
      if (block.dataset.highlighted) return;
      try { _ctx.hljs.highlightElement(block); } catch {}
    });
  }
  markProjectFileAnchors(container);
  linkifyFilePaths(container);
  convertInlineChoices(container);
}

// ═══════════════════════════════════════════
// File Path Linking
// ═══════════════════════════════════════════

export function normalizePathForCompare(path) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

export function isProjectFilePath(path) {
  const normalized = normalizePathForCompare(path);
  if (!normalized.startsWith('/')) return false;
  const roots = new Set([
    normalizePathForCompare(_ctx.project),
    ...(_ctx.projects || []).map((entry) => normalizePathForCompare(entry?.path)).filter(Boolean),
  ]);
  for (const root of roots) {
    if (!root) continue;
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function parseProjectFileTarget(rawTarget) {
  if (!rawTarget) return null;
  let raw = String(rawTarget).trim();
  if (!raw || raw === '#') return null;
  if (raw.startsWith('file://')) {
    try { raw = decodeURIComponent(new URL(raw).pathname || ''); }
    catch { raw = raw.replace(/^file:\/\//, ''); }
  }

  let pathPart = raw;
  let hash = '';
  if (/^[a-z]+:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw, window.location.origin);
      if (parsed.origin !== window.location.origin) return null;
      pathPart = parsed.pathname || '';
      hash = parsed.hash || '';
    } catch {
      return null;
    }
  } else {
    const hashIndex = raw.indexOf('#');
    if (hashIndex >= 0) {
      pathPart = raw.slice(0, hashIndex);
      hash = raw.slice(hashIndex);
    }
  }

  try { pathPart = decodeURIComponent(pathPart); } catch {}
  pathPart = normalizePathForCompare(pathPart);

  let line = null;
  let column = null;
  const suffixMatch = pathPart.match(/:(\d+)(?::(\d+))?$/);
  if (suffixMatch) {
    line = Number(suffixMatch[1]) || null;
    column = Number(suffixMatch[2]) || null;
    pathPart = normalizePathForCompare(pathPart.slice(0, suffixMatch.index));
  }
  if (!isProjectFilePath(pathPart)) return null;
  const hashMatch = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (hashMatch) {
    line = Number(hashMatch[1]) || line;
    column = Number(hashMatch[2]) || column;
  }

  return { filePath: pathPart, line, column };
}

export function openProjectFileTarget(target) {
  if (!target?.filePath) return false;
  _ctx.emit('open-file-editor', {
    filePath: target.filePath,
    line: target.line || undefined,
    column: target.column || undefined,
  });
  return true;
}

export function maybeOpenProjectFileLink(rawTarget, event) {
  const target = parseProjectFileTarget(rawTarget);
  if (!target) return false;
  event?.preventDefault?.();
  return openProjectFileTarget(target);
}

export function markProjectFileAnchors(container) {
  if (!container) return;
  container.querySelectorAll('a[href]').forEach((link) => {
    const target = parseProjectFileTarget(link.getAttribute('href'));
    if (!target) return;
    link.classList.add('cxp-file-link');
    link.dataset.projectFilePath = target.filePath;
    link.title = target.line
      ? `Open in editor${target.column ? ` at line ${target.line}, column ${target.column}` : ` at line ${target.line}`}`
      : 'Open in editor';
  });
}

export function linkifyFilePaths(container) {
  if (!container) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.parentElement?.closest('pre, code, a, .cxp-copy-btn, .cxp-file-link')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const pathRegex = /((?:\/[\w.@~-]+){2,}(?:\.\w+)?(?::\d+(?::\d+)?)?)/g;
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const textNode of textNodes) {
    const text = textNode.textContent;
    if (!pathRegex.test(text)) { pathRegex.lastIndex = 0; continue; }
    pathRegex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    while ((match = pathRegex.exec(text)) !== null) {
      const pathStr = match[1];
      if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
      const link = document.createElement('a');
      link.className = 'cxp-file-link';
      link.textContent = pathStr;
      const target = parseProjectFileTarget(pathStr);
      link.title = target?.line
        ? `Open in editor${target.column ? ` at line ${target.line}, column ${target.column}` : ` at line ${target.line}`}`
        : target ? 'Open in editor' : 'Click to copy path';
      link.href = '#';
      link.addEventListener('click', (e) => {
        if (maybeOpenProjectFileLink(pathStr, e)) return;
        e.preventDefault();
        const cleanPath = pathStr.replace(/:\d+(:\d+)?$/, '');
        navigator.clipboard.writeText(cleanPath).catch(() => {});
        link.classList.add('cxp-file-link-copied');
        setTimeout(() => link.classList.remove('cxp-file-link-copied'), 1500);
      });
      frag.appendChild(link);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.substring(lastIndex)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}

// ═══════════════════════════════════════════
// Display Helpers
// ═══════════════════════════════════════════

export function basenamePath(path) {
  if (!path) return '';
  const normalized = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export function pretty(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

export function parseJsonishString(value) {
  if (typeof value !== 'string') return value;
  if (value.length > OUTPUT_LIMITS.input) return value;
  const answer = jsonAnswer(value);
  if (answer?.kind === 'json') return answer.value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!/^(?:\{|\[|")/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); }
  catch { return value; }
}

export function isStructuredEmpty(value, seen = new Set()) {
  const parsed = parseJsonishString(value);
  if (parsed !== value) return isStructuredEmpty(parsed, seen);
  if (parsed == null) return true;
  if (typeof parsed === 'string') return !parsed.trim();
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return false;
  if (Array.isArray(parsed)) return parsed.length === 0 || parsed.every((entry) => isStructuredEmpty(entry, seen));
  if (typeof parsed === 'object') {
    if (seen.has(parsed)) return true;
    seen.add(parsed);
    const values = Object.values(parsed);
    return values.length === 0 || values.every((entry) => isStructuredEmpty(entry, seen));
  }
  return false;
}

function dedupeTextBlocks(blocks) {
  const seen = new Set();
  const out = [];
  for (const block of blocks) {
    const text = String(block || '').trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function summarizeFileChange(change) {
  if (!change || typeof change !== 'object') return '';
  const path = change.path
    || change.filePath
    || change.targetPath
    || change.newPath
    || change.oldPath
    || change.sourcePath
    || '';
  const fromPath = change.from || change.previousPath || change.oldPath || '';
  const toPath = change.to || change.newPath || change.path || change.filePath || change.targetPath || '';
  const kind = String(
    change.kind?.type
      || change.kind
      || change.type
      || change.operation
      || change.status
      || ''
  ).trim().replace(/_/g, ' ');
  if (fromPath && toPath && fromPath !== toPath) {
    return `${kind || 'rename'}: ${fromPath} -> ${toPath}`;
  }
  if (path) return kind ? `${kind}: ${path}` : path;
  if (typeof change.summary === 'string' && change.summary.trim()) return change.summary.trim();
  if (typeof change.description === 'string' && change.description.trim()) return change.description.trim();
  return '';
}

export function summarizeCommandExecution(command, cwd = '') {
  const raw = String(command || '').trim();
  const unwrapped = raw
    .replace(/^\/bin\/(?:zsh|bash)\s+-lc\s+/, '')
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1')
    .trim();
  const normalized = unwrapped.toLowerCase();
  const cwdName = basenamePath(cwd || '') || cwd || '';

  if (/\b(rg|ripgrep|grep|findstr)\b/.test(normalized)) {
    return { title: 'Searching within files', detail: cwdName ? `Scanning ${cwdName}` : 'Scanning the workspace' };
  }
  if (/\b(fd|find|ls|tree)\b/.test(normalized)) {
    return { title: 'Inspecting files', detail: cwdName ? `Looking through ${cwdName}` : 'Exploring the workspace' };
  }
  if (/\b(cat|sed|head|tail|awk|jq)\b/.test(normalized)) {
    return { title: 'Reading file contents', detail: cwdName ? `Inspecting files in ${cwdName}` : 'Inspecting file contents' };
  }
  if (/\bgit\s+(status|log|branch)\b/.test(normalized)) {
    return { title: 'Inspecting git state', detail: cwdName ? `Checking ${cwdName}` : 'Checking repository state' };
  }
  if (/\bgit\s+(diff|show)\b/.test(normalized)) {
    return { title: 'Inspecting git changes', detail: cwdName ? `Reviewing changes in ${cwdName}` : 'Reviewing repository changes' };
  }
  if (/\b(node\s+--check|tsc\b|eslint\b|biome\b|prettier\b|ruff\b)\b/.test(normalized)) {
    return { title: 'Checking code quality', detail: cwdName ? `Validating ${cwdName}` : 'Validating code' };
  }
  if (/\b(vitest|jest|pytest|cargo test|npm test|pnpm test|yarn test|bun test)\b/.test(normalized)) {
    return { title: 'Running tests', detail: cwdName ? `Testing ${cwdName}` : 'Running the test suite' };
  }
  if (/\b(npm|pnpm|yarn|bun)\s+install\b/.test(normalized)) {
    return { title: 'Installing dependencies', detail: cwdName ? `Updating packages in ${cwdName}` : 'Updating project dependencies' };
  }

  return {
    title: 'Running shell command',
    detail: cwdName ? `Working in ${cwdName}` : 'Executing a shell command',
  };
}

function computeDiffStats(text) {
  const value = String(text || '').slice(0, OUTPUT_LIMITS.input);
  if (!value.trim()) return '';
  let added = 0;
  let removed = 0;
  for (const line of value.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  if (!added && !removed) return '';
  return `+${added} -${removed}`;
}

function describeFileChange(change) {
  if (!change || typeof change !== 'object') return '';
  const summary = summarizeFileChange(change);
  const detail = String(change.summary || change.description || '').trim();
  const stats = computeDiffStats(change.diff || change.patch || change.output || change.content || '');
  return [summary, detail && detail !== summary ? detail : '', stats].filter(Boolean).join(' · ');
}

function resolveFileChangeSummary(item) {
  const changes = Array.isArray(item?.changes) ? item.changes.slice(0, OUTPUT_LIMITS.files) : [];
  const lines = changes.map((change) => describeFileChange(change)).filter(Boolean);
  if (lines.length) return lines.join('\n');
  return 'Pending file changes';
}

function collectStructuredText(value, seen = new Set()) {
  const parsed = parseJsonishString(value);
  if (parsed !== value) {
    return [readableStructuredValue(parsed)];
  }
  if (value == null) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) {
    return dedupeTextBlocks(value.flatMap((entry) => collectStructuredText(entry, seen)));
  }
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const blocks = [];
  const type = String(value.type || '').trim().toLowerCase();
  const imageRef = value.path || value.url || value.imageUrl || value.src || value.name || '';

  if (type === 'image' || type === 'inputimage' || type === 'localimage') {
    return [`[image]${imageRef ? ` ${imageRef}` : ''}`];
  }

  const fileSummary = summarizeFileChange(value);
  if (fileSummary) blocks.push(fileSummary);

  for (const key of ['text', 'message', 'content', 'data', 'output', 'result', 'delta', 'details', 'description']) {
    if (typeof value[key] === 'string') {
      blocks.push(...collectStructuredText(value[key], seen));
    }
  }

  for (const key of ['content', 'contentItems', 'parts', 'items', 'results', 'resourceTemplates', 'resources', 'changes', 'entries']) {
    if (Array.isArray(value[key])) {
      blocks.push(...collectStructuredText(value[key], seen));
    }
  }

  for (const key of ['content', 'data', 'output', 'result', 'response', 'error']) {
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
      blocks.push(...collectStructuredText(value[key], seen));
    }
  }

  if (!blocks.length && !isStructuredEmpty(value)) {
    const scalarLines = Object.entries(value)
      .filter(([, entry]) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
      .map(([key, entry]) => `${key}: ${entry}`);
    if (scalarLines.length) blocks.push(...scalarLines);
  }

  return dedupeTextBlocks(blocks);
}

export function extractStructuredText(value) {
  const parsed = parseJsonishString(value);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.type && !Array.isArray(parsed.content)) return readableStructuredValue(parsed);
  if (typeof value === 'string') return readableStructuredValue(value);
  if (Array.isArray(parsed) && !parsed.some(entry => entry && typeof entry === 'object' && entry.type)) return readableStructuredValue(parsed);
  return collectStructuredText(value).join('\n\n');
}

export function formatStructuredValue(value) {
  return readableStructuredValue(parseJsonishString(value));
}

export function resolveFinalMarkdownText(state, nextText) {
  // Completed items are authoritative, including explicit empty/shorter text.
  return typeof nextText === 'string' ? nextText : String(state?.buffer || '');
}

// ═══════════════════════════════════════════
// Greeting / Plan Preamble Stripping
// ═══════════════════════════════════════════

export function stripInjectedCodexGreeting(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const start = raw.indexOf(CODEX_GREETING_MARKER_START);
  const end = raw.indexOf(CODEX_GREETING_MARKER_END);
  if (start === -1 || end === -1 || end < start) return raw.trim();
  const before = raw.slice(0, start).trim();
  const after = raw.slice(end + CODEX_GREETING_MARKER_END.length).trim();
  return [before, after].filter(Boolean).join('\n\n').trim();
}

function isInjectedCodexPlanBlock(block) {
  const normalized = String(block || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('[plan mode')
    || normalized.startsWith('critical')
    || normalized.includes('do not make code changes')
    || normalized.includes('askuserquestion')
    || normalized.includes('toolsearch')
    || normalized.includes('exitplanmode')
    || normalized.includes('present options')
    || normalized.includes('need clarification')
    || normalized.includes('questions about the approach');
}

export function stripInjectedCodexPlanPreamble(text) {
  let value = String(text || '').trim();
  if (!value) return '';

  for (const prefix of CODEX_PLAN_MODE_PREFIXES) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length).trim();
  }

  if (!/^\[PLAN MODE\b/i.test(value)) return value.trim();

  const parts = value.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return '';

  let index = 0;
  while (index < parts.length && isInjectedCodexPlanBlock(parts[index])) index += 1;
  if (!index) return value.trim();
  return parts.slice(index).join('\n\n').trim();
}

export function stripInjectedCodexSkillPreamble(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const startTag = '<skill-instructions>';
  const endTag = '</skill-instructions>';
  const start = raw.indexOf(startTag);
  const end = raw.indexOf(endTag);
  if (start === -1 || end === -1 || end < start) return raw;

  const after = raw.slice(end + endTag.length).trim();
  const invokeMatch = after.match(/^The user invoked the \/([^\s]+) command(?: with arguments: ([\s\S]*?))?\. Follow the skill instructions above exactly\.$/);
  if (invokeMatch) {
    const command = invokeMatch[1];
    const args = String(invokeMatch[2] || '').trim();
    return `/${command}${args ? ` ${args}` : ''}`;
  }

  const before = raw.slice(0, start).trim();
  return [before, after].filter(Boolean).join('\n\n').trim();
}

export function sanitizeCodexUserFacingText(text) {
  return stripInjectedCodexSkillPreamble(stripInjectedCodexPlanPreamble(stripInjectedCodexGreeting(text)));
}

export function sanitizeStoredTranscriptDom(container) {
  if (!container) return;
  // MCP startup/auth notices describe live app-server state. Restoring them
  // from an HTML snapshot would leave a stale, disabled authentication action.
  container.querySelectorAll('.cxp-mcp-startup-notice').forEach((node) => node.remove());
  // These actions require a live completed item identity; history rendering
  // reinstalls them once the authoritative item is available.
  container.querySelectorAll('.cxp-use-as-plan').forEach((node) => node.remove());
  container.querySelectorAll('.cxp-msg-user .cxp-msg-body').forEach((bodyEl) => {
    const messageEl = bodyEl.closest('.cxp-msg-user');
    const textBlocks = Array.from(bodyEl.querySelectorAll('.cxp-msg-user-text'));
    const imageBlocks = bodyEl.querySelectorAll('.cxp-msg-user-image, .cxp-msg-user-attachment');
    if (textBlocks.length || imageBlocks.length) {
      let hasRenderable = imageBlocks.length > 0;
      textBlocks.forEach((textEl) => {
        const text = sanitizeCodexUserFacingText(textEl.textContent || '');
        if (!text) {
          textEl.remove();
          return;
        }
        textEl.textContent = text;
        hasRenderable = true;
      });
      if (!hasRenderable) messageEl?.remove();
      return;
    }

    const text = sanitizeCodexUserFacingText(bodyEl.textContent || '');
    if (!text) {
      messageEl?.remove();
      return;
    }
    bodyEl.textContent = text;
  });
  container.querySelectorAll('.cxp-msg-assistant .cxp-msg-rendered').forEach(body => {
    if (body.querySelector('.cxp-readable')) { hydrateOutputControls(body); return; }
    const text = body.textContent || '';
    if (!body.querySelector('pre, code') && jsonAnswer(text)) renderReadableOutput(body, text);
  });
  if (!_ctx.running) container.querySelectorAll('.cxp-reasoning').forEach(card => {
    const body = card.querySelector('.cxp-reasoning-body');
    if (body && /^Waiting for reasoning summary/.test(body.textContent)) body.textContent = 'No reasoning summary was provided.';
    const pill = card.querySelector('.cxp-status-pill');
    if (pill?.textContent === 'live') pill.textContent = 'complete';
  });
  syncStatusPillTones(container);
  cleanOutputBlocks(container);
  // Old snapshots retain their classes; replace just their verbose diff body.
  container.querySelectorAll('[data-item-type="fileChange"]').forEach(card => {
    const fold = card.querySelector('.cxp-fold-diff');
    const raw = fold?.querySelector('.cxp-card-pre-diff')?.textContent;
    if (!raw) return;
    const view = document.createElement('div');
    fold.replaceWith(view);
    renderDiffView(view, parseUnifiedDiff(raw), { lazy: true, cwd: _ctx.boundTab?.project || _ctx.project, summaryEl: card.querySelector('.cxp-card-meta') });
    if (card.dataset.userCollapsed !== '1') setCardExpanded(card, true);
  });
  restoreDiffViews(container, { cwd: _ctx.boundTab?.project || _ctx.project });
}

// ═══════════════════════════════════════════
// Status pill tone (presentation only)
// ═══════════════════════════════════════════

// Pills get their label from many call sites as plain text. The stylesheet
// needs a hook to give a status its colour, so the label is mirrored into
// data-tone here; nothing else reads it.
const STATUS_PILL_TONES = [
  ['error', /^(failed|failure|error|errored|denied|rejected)\b/],
  ['warning', /^(waiting|declined|cancell?ed|interrupted|aborted|blocked|retry|stale|unsupported|timed ?out|paused)\b/],
  ['running', /^(in ?progress|running|live|working|starting|started|submitting|streaming|active)\b/],
  ['success', /^(allowed|accepted|approved|authenticated|ready)\b/],
];

export function statusPillTone(text) {
  const label = String(text || '').trim().toLowerCase();
  return STATUS_PILL_TONES.find(([, pattern]) => pattern.test(label))?.[0] || '';
}

function applyStatusPillTone(pill) {
  if (!pill) return;
  const tone = statusPillTone(pill.textContent);
  if (tone) pill.dataset.tone = tone;
  else delete pill.dataset.tone;
}

const _statusPillObserver = typeof MutationObserver === 'function'
  ? new MutationObserver((records) => {
    for (const record of records) {
      const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      applyStatusPillTone(node?.closest?.('.cxp-status-pill'));
    }
  })
  : null;

export function syncStatusPillTones(root) {
  const pills = root?.querySelectorAll?.('.cxp-status-pill') || [];
  for (const pill of pills) {
    applyStatusPillTone(pill);
    _statusPillObserver?.observe(pill, { childList: true, characterData: true, subtree: true });
  }
}

export function removePostPlanCards(messagesEl = _ctx.messagesEl) {
  messagesEl?.querySelectorAll('.cxp-post-plan-msg').forEach((node) => node.remove());
  messagesEl?.querySelectorAll('.cxp-plan-document-toolbar [data-plan-action="edit"]').forEach((button) => { button.hidden = false; });
}

export function removePostCompactionCards(messagesEl = _ctx.messagesEl) {
  messagesEl?.querySelectorAll('.cxp-post-compact-msg').forEach((node) => node.remove());
}

// ═══════════════════════════════════════════
// User Message Content
// ═══════════════════════════════════════════

function normalizeUserContentItemType(item) {
  return String(item?.type || '').trim().toLowerCase().replace(/[_-]/g, '');
}

function getUserAttachmentPath(item) {
  return item?.path || item?.filePath || item?.file_path || '';
}

function getUserAttachmentLabel(item) {
  return item?.name || item?.fileId || item?.file_id || basenamePath(getUserAttachmentPath(item)) || 'image';
}

function normalizeRenderableImageUrl(rawUrl) {
  const value = String(rawUrl || '').trim().replace(/^<|>$/g, '').replace(/[),.;!?]+$/g, '');
  if (!value) return '';
  try {
    const url = new URL(value, window.location.origin);
    const path = String(url.pathname || '').toLowerCase();
    if (!/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(path)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function extractLinkedImageUrls(text) {
  const source = String(text || '');
  if (!source) return [];
  const found = new Set();
  const markdownImageRegex = /!\[[^\]]*]\((https?:\/\/[^)\s>]+)\)/gi;
  const markdownLinkRegex = /(?<!!)\[[^\]]*]\((https?:\/\/[^)\s>]+)\)/gi;
  const plainUrlRegex = /(?:^|\s)(https?:\/\/[^\s<>"']+)/gi;

  let match;
  while ((match = markdownImageRegex.exec(source))) {
    const normalized = normalizeRenderableImageUrl(match[1]);
    if (normalized) found.add(normalized);
  }
  while ((match = markdownLinkRegex.exec(source))) {
    const normalized = normalizeRenderableImageUrl(match[1]);
    if (normalized) found.add(normalized);
  }
  while ((match = plainUrlRegex.exec(source))) {
    const normalized = normalizeRenderableImageUrl(match[1]);
    if (normalized) found.add(normalized);
  }
  return [...found];
}

function isUserTextItem(item) {
  return normalizeUserContentItemType(item) === 'text' || normalizeUserContentItemType(item) === 'inputtext';
}

function isUserImageItem(item) {
  const type = normalizeUserContentItemType(item);
  return type === 'image' || type === 'inputimage' || type === 'localimage';
}

function isUserLocalImageItem(item) {
  return normalizeUserContentItemType(item) === 'localimage';
}

export function extractUserText(content) {
  if (!Array.isArray(content)) return '';
  return sanitizeCodexUserFacingText(content.map((item) => {
    if (isUserTextItem(item)) return item.text || '';
    if (!isUserImageItem(item)) {
      if (normalizeUserContentItemType(item) === 'mention') return `@${item.name || item.path || 'mention'}`;
      if (normalizeUserContentItemType(item) === 'skill') return `/${item.name || item.path || 'skill'}`;
      return '';
    }
    if (isUserLocalImageItem(item)) return `[image] ${basenamePath(getUserAttachmentPath(item)) || ''}`.trim();
    if (item?.imageUrl || item?.image_url || item?.url || item?.src) {
      return `[image] ${item.imageUrl || item.image_url || item.url || item.src}`;
    }
    return `[image] ${getUserAttachmentLabel(item)}`.trim();
  }).filter(Boolean).join('\n'));
}

export function getUserAttachmentImageSrc(item) {
  if (!isUserImageItem(item)) return '';
  const directSrc = item?.dataUrl || item?.url || item?.imageUrl || item?.image_url || item?.src || '';
  if (directSrc) return directSrc;
  const fileName = basenamePath(getUserAttachmentPath(item));
  return fileName ? `/api/images/file/${encodeURIComponent(fileName)}` : '';
}

export function renderUserMessageContent(bodyEl, content) {
  if (!bodyEl) return;
  const items = Array.isArray(content) ? content : [];
  bodyEl.innerHTML = '';
  let hasRenderable = false;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    if (isUserImageItem(item)) {
      const src = getUserAttachmentImageSrc(item);
      if (src) {
        const img = document.createElement('img');
        img.className = 'cxp-msg-user-image';
        img.alt = getUserAttachmentLabel(item) || 'Attached image';
        img.src = src;
        bodyEl.appendChild(img);
      }

      const chip = document.createElement('div');
      chip.className = 'cxp-msg-user-attachment';
      chip.textContent = `Attached image: ${getUserAttachmentLabel(item)}`;
      bodyEl.appendChild(chip);
      hasRenderable = true;
      continue;
    }

    if (isUserTextItem(item)) {
      const text = sanitizeCodexUserFacingText(item.text || '');
      if (!text) continue;
      const textEl = document.createElement('div');
      textEl.className = 'cxp-msg-user-text';
      textEl.textContent = text;
      bodyEl.appendChild(textEl);
      extractLinkedImageUrls(text).forEach((url) => {
        const img = document.createElement('img');
        img.className = 'cxp-msg-user-image';
        img.alt = 'Linked image';
        img.src = url;
        bodyEl.appendChild(img);

        const chip = document.createElement('div');
        chip.className = 'cxp-msg-user-attachment';
        chip.textContent = 'Linked image';
        bodyEl.appendChild(chip);
      });
      hasRenderable = true;
      continue;
    }
  }

  if (!hasRenderable) bodyEl.textContent = extractUserText(items);
}

// ═══════════════════════════════════════════
// Tool Result Extraction
// ═══════════════════════════════════════════

export function extractToolResultText(result) {
  if (result && typeof result === 'object' && hasOwnField(result, 'structuredContent')) return formatStructuredValue(result.structuredContent);
  return extractStructuredText(result);
}

export function extractDynamicToolResultText(contentItems) {
  return extractStructuredText(contentItems);
}

// ═══════════════════════════════════════════
// Permission / Guardian Formatting
// ═══════════════════════════════════════════

export function formatPermissionProfile(profile) {
  if (!profile || typeof profile !== 'object') return '(none)';
  const parts = [];
  const read = Array.isArray(profile?.fileSystem?.read) ? profile.fileSystem.read.filter(Boolean) : [];
  const write = Array.isArray(profile?.fileSystem?.write) ? profile.fileSystem.write.filter(Boolean) : [];
  if (read.length) parts.push(`read ${read.join(', ')}`);
  if (write.length) parts.push(`write ${write.join(', ')}`);
  if (profile?.network?.enabled === true) parts.push('network access');
  if (profile?.network?.enabled === false) parts.push('network disabled');
  return parts.join(' • ') || pretty(profile);
}

export function formatGuardianReview(review) {
  if (!review || typeof review !== 'object') return '';
  return [
    review.status || 'review',
    review.riskLevel ? `${review.riskLevel} risk` : '',
    Number.isFinite(review.riskScore) ? `score ${review.riskScore}` : '',
    review.rationale || '',
  ].filter(Boolean).join(' • ');
}

// ═══════════════════════════════════════════
// Changelog Editor Flow (hybrid — uses context heavily)
// ═══════════════════════════════════════════

export async function openChangelogEditorFlow({
  requestId = null,
  answerKey = '',
  buttons = [],
  source = 'inline',
  responseKind = 'native',
  responseMeta = null,
} = {}) {
  const tab = _ctx.activeTab();
  if (!tab) return false;
  const changelogText = _ctx.capturePlanContent(tab);
  if (!changelogText) {
    appendSystem('No changelog content found to edit.', 'error');
    restoreChangelogButtons(buttons);
    return false;
  }

  try {
    const res = await fetch('/api/create-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: changelogText }),
    });
    const result = await res.json();
    if (!res.ok || !result?.ok || !result.path) throw new Error('create-plan failed');
    tab._changelogRequest = {
      source,
      requestId,
      answerKey,
      buttons,
      responseKind,
      responseMeta,
    };
    _ctx.emit('open-changelog-editor', { filePath: result.path, tabId: tab.id });
    return true;
  } catch {
    appendSystem('Failed to create changelog draft.', 'error');
    restoreChangelogButtons(buttons);
    if (tab._changelogRequest?.requestId === requestId) tab._changelogRequest = null;
    return false;
  }
}

// ═══════════════════════════════════════════
// Element Appending
// ═══════════════════════════════════════════

export function appendElement(el) {
  if (!_ctx.messagesEl) {
    console.warn('[cdx-render] appendElement skipped — _ctx.messagesEl is null', { hasItems: !!_ctx.items, boundTab: !!_ctx.boundTab });
    return;
  }
  _ctx.hideEmpty();
  observeOutputBlocks(_ctx.messagesEl);
  if (_ctx.threadId) {
    el.dataset.codexAccountId = String(_ctx.accountId || 'default');
    el.dataset.codexThreadId = String(_ctx.threadId);
    el.dataset.codexSessionId = String(_ctx.boundTab?.id || '');
    el.dataset.codexConnectionEpoch = String(_ctx.connectionEpoch || '');
    if (_ctx.activeTurnId) el.dataset.codexTurnId = String(_ctx.activeTurnId);
  }
  _ctx.messagesEl.appendChild(el);
  syncStatusPillTones(el);
  _ctx.pruneTranscriptDom(_ctx.messagesEl);
  if (_ctx.threadId) {
    _ctx.setTranscriptSourceMeta({
      sourceType: _ctx.transcriptSourceType && _ctx.transcriptSourceType !== 'snapshot'
        ? _ctx.transcriptSourceType
        : 'live',
      itemCount: countRenderableTranscriptNodes(_ctx.messagesEl),
      sourceUpdatedAt: Date.now(),
    });
  }
  _ctx.repositionThinking();
  _ctx.scrollEnd();
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

export function appendSystem(text, tone = 'muted') {
  const el = document.createElement('div');
  el.className = `cxp-system${tone === 'error' ? ' error' : tone === 'working' ? ' working' : ''}`;
  el.textContent = text;
  appendElement(el);
}

function findMcpStartupNotice(name) {
  const serverName = String(name || '');
  return [...(_ctx.messagesEl?.querySelectorAll('.cxp-mcp-startup-notice') || [])]
    .find((node) => node.dataset.mcpServer === serverName) || null;
}

function applyMcpStartupNoticeTone(card, state) {
  card.dataset.state = state;
  card.classList.toggle('error', state === 'failed' || state === 'error');
  card.classList.toggle('working', state === 'opening' || state === 'waiting');
  card.classList.toggle('success', state === 'authenticated' || state === 'ready');
}

export function updateMcpStartupNotice(name, {
  state = 'failed',
  title,
  error,
  statusText = '',
  buttonLabel = 'Authenticate',
  buttonDisabled = false,
  buttonHidden = false,
  onAuthenticate,
} = {}) {
  const card = findMcpStartupNotice(name);
  if (!card) return false;

  const titleEl = card.querySelector('.cxp-mcp-startup-title');
  const detailEl = card.querySelector('.cxp-mcp-startup-error');
  const statusEl = card.querySelector('.cxp-mcp-startup-status');
  const button = card.querySelector('.cxp-mcp-startup-auth');
  applyMcpStartupNoticeTone(card, state);

  if (title != null && titleEl) titleEl.textContent = title;
  if (error !== undefined && detailEl) {
    detailEl.textContent = String(error || 'The MCP server could not start.');
    detailEl.hidden = state === 'ready';
  } else if (detailEl && state === 'ready') {
    detailEl.hidden = true;
  }
  if (statusEl) {
    statusEl.textContent = statusText;
    statusEl.hidden = !statusText;
  }
  if (button) {
    button.textContent = buttonLabel;
    button.disabled = !!buttonDisabled;
    button.hidden = !!buttonHidden;
    if (typeof onAuthenticate === 'function') button.onclick = onAuthenticate;
  }

  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
  _ctx.scrollEnd();
  return true;
}

export function upsertMcpStartupNotice({
  name,
  error,
  canAuthenticate = false,
  onAuthenticate,
} = {}) {
  const serverName = String(name || 'MCP');
  let card = findMcpStartupNotice(serverName);
  const isNew = !card;
  if (!card) {
    card = document.createElement('section');
    card.className = 'cxp-system cxp-mcp-startup-notice error';
    card.dataset.mcpServer = serverName;
    card.setAttribute('role', 'alert');
    card.setAttribute('aria-live', 'polite');

    const titleEl = document.createElement('div');
    titleEl.className = 'cxp-mcp-startup-title';
    const detailEl = document.createElement('div');
    detailEl.className = 'cxp-mcp-startup-error';
    const actionsEl = document.createElement('div');
    actionsEl.className = 'cxp-mcp-startup-actions';
    const statusEl = document.createElement('span');
    statusEl.className = 'cxp-mcp-startup-status';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cxp-mcp-startup-auth';
    button.setAttribute('aria-label', `Authenticate ${serverName} MCP server`);
    actionsEl.append(statusEl, button);
    card.append(titleEl, detailEl, actionsEl);
  }

  card.dataset.authAvailable = canAuthenticate ? '1' : '0';
  if (isNew) appendElement(card);
  updateMcpStartupNotice(serverName, {
    state: 'failed',
    title: `MCP startup failed · ${serverName}`,
    error,
    statusText: canAuthenticate ? 'Authentication required' : '',
    buttonLabel: 'Authenticate',
    buttonDisabled: false,
    buttonHidden: !canAuthenticate,
    onAuthenticate,
  });
  return card;
}

function normalizeAssistantPhase(phase) {
  const value = String(phase || '').trim().toLowerCase();
  if (value === 'commentary') return 'commentary';
  if (value === 'final_answer') return 'final_answer';
  return '';
}

export function createMessageShell(kind, label, { phase = '' } = {}) {
  const el = document.createElement('div');
  el.className = `cxp-msg cxp-msg-${kind}`;
  const normalizedPhase = kind === 'assistant' ? normalizeAssistantPhase(phase) : '';
  if (normalizedPhase) el.dataset.phase = normalizedPhase;

  const avatar = document.createElement('div');
  avatar.className = 'cxp-msg-avatar';
  avatar.innerHTML = kind === 'assistant' ? OPENAI_ICON : ICON_SPARK;
  el.appendChild(avatar);

  const card = document.createElement('div');
  card.className = 'cxp-msg-card';

  const head = document.createElement('div');
  head.className = 'cxp-msg-head';
  const labelEl = document.createElement('div');
  labelEl.className = 'cxp-msg-label';
  labelEl.textContent = label;
  head.appendChild(labelEl);
  const phaseEl = document.createElement('div');
  phaseEl.className = 'cxp-msg-phase';
  phaseEl.hidden = normalizedPhase !== 'final_answer';
  phaseEl.textContent = normalizedPhase === 'final_answer' ? 'Final' : '';
  head.appendChild(phaseEl);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'cxp-msg-body';
  card.appendChild(body);

  el.appendChild(card);
  appendElement(el);
  return { el, head, body, labelEl, phaseEl };
}

export function appendAssistantMarkdownMessage(tab, markdown) {
  if (!tab?.messagesEl || !markdown) return;
  _ctx.withTab(tab, () => {
    const shell = createMessageShell('assistant', 'Codex');
    shell.body.innerHTML = md(markdown);
    postProcessRenderedHtml(shell.body);
  });
}

// ═══════════════════════════════════════════
// Post-Plan Transcript Meta & Actions
// ═══════════════════════════════════════════

export function updatePostPlanTranscriptMeta(tab = _ctx.boundTab) {
  if (!tab?.messagesEl) return;
  _ctx.withTab(tab, () => {
    if (_ctx.threadId) {
      _ctx.setTranscriptSourceMeta({
        sourceType: _ctx.transcriptSourceType && _ctx.transcriptSourceType !== 'snapshot'
          ? _ctx.transcriptSourceType
          : 'live',
        itemCount: countRenderableTranscriptNodes(_ctx.messagesEl),
        sourceUpdatedAt: Date.now(),
      });
    }
    _ctx.scheduleThreadSnapshotSave(tab);
  });
}

export function syncPlanEditorActions(tab = _ctx.boundTab) {
  if (!tab?.messagesEl) return;
  syncMessagePlanActions(tab);
  const blocked = !!(tab.planEditor?.dirty || tab.planEditor?.saving);
  tab.messagesEl.querySelectorAll('[data-plan-action]').forEach((button) => {
    const action = button.dataset.planAction;
    const card = button.closest('.cxp-post-plan-card');
    button.disabled = !!(tab.running || tab.startingThread || tab.compacting)
      || !!card?.classList.contains('is-busy')
      || (action === 'feedback' && !card?.querySelector('.cxp-post-plan-feedback')?.value.trim())
      || ((action === 'continue' || action === 'feedback' || action === 'compact' || action === 'adopt') && blocked)
      || (action === 'edit' && !!tab.planEditor?.saving);
    if (action === 'continue') button.title = blocked ? 'Save or cancel the open plan edits first.' : '';
    if (action === 'edit' && button.closest('.cxp-plan-document-toolbar')) {
      button.hidden = !!tab.messagesEl.querySelector('.cxp-post-plan-msg [data-plan-action="edit"]');
    }
  });
  const notice = tab.messagesEl.querySelector('.cxp-plan-editor-notice');
  if (notice) {
    notice.hidden = !blocked;
    notice.textContent = tab.planEditor?.saving ? 'Saving plan…' : 'Save or cancel your editor changes before continuing.';
  }
}

export async function openCodexPlanEditor(tab = _ctx.boundTab) {
  if (!tab?.planDocument || tab.closed || tab.running || tab.startingThread || tab.compacting || tab.planEditor?.saving) return false;
  const document = tab.planDocument;
  const identity = {
    source: 'codex', tabId: tab.id, planId: document.id, revision: document.revision,
    accountId: document.accountId, threadId: document.threadId,
  };
  try {
    // Materialize and verify every revision; a cached path can contain old text.
    const filePath = await _ctx.ensurePlanFile?.(tab);
    if (tab.closed) return false;
    if (!filePath) throw new Error('The complete plan could not be saved for editing.');
    if (tab.planDocument?.id !== document.id || tab.planDocument?.revision !== document.revision) {
      throw new Error('The plan changed while opening the editor. Open the latest revision again.');
    }
    _ctx.emit('open-plan-editor', {
      ...identity, filePath, expectedMarkdown: document.markdown,
      save: (edit) => tab.closed
        ? { ok: false, reason: 'This conversation was closed. Your edits are still available to copy.' }
        : _ctx.savePlanEdit(tab, { ...identity, ...edit }),
    });
    return true;
  } catch (error) {
    _ctx.withTab(tab, () => appendSystem(error?.message || 'Could not open the plan editor.', 'error'));
    return false;
  }
}

function renderPlanDocument(tab) {
  const plan = tab.planDocument;
  let el = tab.messagesEl.querySelector('.cxp-plan-document-msg');
  if (!getPlanMarkdown(tab)) {
    el?.remove();
    tab.messagesEl.querySelectorAll('[data-plan-source-hidden]').forEach((node) => {
      node.hidden = false;
      delete node.dataset.planSourceHidden;
    });
    return null;
  }
  if (!el) {
    _ctx.withTab(tab, () => {
      const shell = createMessageShell('assistant', 'Codex');
      el = shell.el;
      el.classList.add('cxp-plan-document-msg');
    });
  }
  const body = el.querySelector('.cxp-msg-body');
  const changed = el.dataset.planId !== plan.id || Number(el.dataset.planRevision) !== plan.revision;
  el.dataset.planId = plan.id;
  el.dataset.planRevision = String(plan.revision);
  el.dataset.codexThreadId = plan.threadId || '';
  el.dataset.codexAccountId = plan.accountId || 'default';
  el.dataset.codexTurnId = plan.turnId || '';
  // Snapshot HTML has no event handlers; rebind toolbar on every restoration.
  let toolbar = body.querySelector('.cxp-plan-document-toolbar');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.className = 'cxp-plan-document-toolbar';
  }
  toolbar.replaceChildren();
  let label = body.querySelector('.cxp-plan-document-label');
  if (!label) {
    label = document.createElement('div');
    label.className = 'cxp-plan-document-label';
  }
  label.textContent = `${plan.status === 'complete' ? 'Plan' : 'Draft plan'} · revision ${plan.revision}`;
  body.prepend(label);
  const copy = _ctx.createRequestButton('Copy plan', 'secondary');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getPlanMarkdown(tab)); copy.textContent = 'Copied'; }
    catch { _ctx.withTab(tab, () => appendSystem('Could not copy the plan.', 'error')); }
  });
  const edit = _ctx.createRequestButton(tab.planEditor?.open ? 'Reopen editor' : 'Edit plan', 'secondary');
  edit.dataset.planAction = 'edit';
  edit.addEventListener('click', () => openCodexPlanEditor(tab));
  const collapse = _ctx.createRequestButton(el.dataset.planCollapsed === '1' ? 'Expand plan' : 'Collapse plan', 'secondary');
  collapse.addEventListener('click', () => {
    const collapsed = el.dataset.planCollapsed !== '1';
    el.dataset.planCollapsed = collapsed ? '1' : '0';
    content.hidden = collapsed;
    collapse.textContent = collapsed ? 'Expand plan' : 'Collapse plan';
    _ctx.scheduleThreadSnapshotSave(tab);
  });
  toolbar.append(copy, edit, collapse);
  let content = body.querySelector('.cxp-plan-document-content');
  if (!content) {
    content = document.createElement('div');
    content.className = 'cxp-plan-document-content';
  }
  // Re-establish document-first order for live updates and old saved snapshots.
  body.append(content, toolbar);
  if (changed || !el._planDocumentBound || !content.childNodes.length) {
    content.innerHTML = md(plan.markdown);
    postProcessRenderedHtml(content);
  }
  el._planDocumentBound = true;
  content.hidden = el.dataset.planCollapsed === '1';
  tab.messagesEl.querySelectorAll('[data-item-id]').forEach((node) => {
    const sameSource = node.dataset.itemId === plan.itemId;
    if (sameSource || node.dataset.planSourceHidden) {
      node.hidden = sameSource;
      if (sameSource) node.dataset.planSourceHidden = '1';
      else delete node.dataset.planSourceHidden;
    }
    // A regenerated plan can arrive later in the transcript. Keep its document
    // and the following review controls beside that current source item.
    if (sameSource && node.parentElement === tab.messagesEl && node !== el && node.nextElementSibling !== el) node.after(el);
  });
  syncPlanEditorActions(tab);
  return el;
}

function renderRecoverablePlanDraft(tab) {
  tab.messagesEl.querySelectorAll('.cxp-plan-draft-msg').forEach((node) => node.remove());
  const draft = tab.planDraft;
  if (!draft?.markdown) return;
  _ctx.withTab(tab, () => {
    const shell = createMessageShell('assistant', 'Draft plan');
    shell.el.classList.add('cxp-plan-draft-msg');
    const note = document.createElement('p');
    note.textContent = 'This draft needs review before it can become the implementation plan.';
    const content = document.createElement('div');
    content.innerHTML = md(draft.markdown);
    postProcessRenderedHtml(content);
    const adopt = _ctx.createRequestButton('Use as plan', 'secondary');
    adopt.dataset.planAction = 'adopt';
    adopt.disabled = !!(tab.running || tab.planEditor?.dirty || tab.planEditor?.saving);
    adopt.addEventListener('click', () => {
      if (tab.running || tab.planEditor?.dirty || tab.planEditor?.saving) return;
      _ctx.adoptMessageAsPlan?.(tab, {
        itemId: draft.itemId || 'recovered-draft', turnId: draft.turnId || '', markdown: draft.markdown,
      });
    });
    shell.body.append(note, content, adopt);
  });
}

export function renderPostPlanActions(tab = _ctx.boundTab, headerText = null) {
  if (!tab?.messagesEl) return;
  syncPlanMirrors(tab);
  syncMessagePlanActions(tab);
  tab.postPlanHeader = headerText || tab.postPlanHeader || 'PLAN COMPLETE';
  if (_ctx.boundTab === tab) {
    // Sync the module-level _postPlanHeader via context
    if (typeof _ctx.setPostPlanHeader === 'function') _ctx.setPostPlanHeader(tab.postPlanHeader);
  }

  const planEl = renderPlanDocument(tab);
  renderRecoverablePlanDraft(tab);
  removePostPlanCards(tab.messagesEl);
  if (!tab.showPostPlanActions || tab.planDocument?.status !== 'complete' || !getPlanMarkdown(tab)) {
    updatePostPlanTranscriptMeta(tab);
    return;
  }

  const el = document.createElement('div');
  el.className = 'cxp-msg cxp-msg-assistant cxp-post-plan-msg';

  const cardWrap = document.createElement('div');
  cardWrap.className = 'cxp-msg-card';

  const body = document.createElement('div');
  body.className = 'cxp-msg-body';

  const card = document.createElement('div');
  card.className = 'cxp-post-plan-card';
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Plan review');

  const continueBtn = _ctx.createRequestButton('Continue with implementation', 'primary');
  const compactBtn = _ctx.createRequestButton('Compact context', 'secondary');
  const editBtn = _ctx.createRequestButton('Edit plan', 'secondary');
  continueBtn.dataset.planAction = 'continue';
  compactBtn.dataset.planAction = 'compact';
  editBtn.dataset.planAction = 'edit';
  const editorNotice = document.createElement('div');
  editorNotice.className = 'cxp-plan-editor-notice';
  editorNotice.setAttribute('role', 'status');
  editorNotice.hidden = true;
  card.appendChild(editorNotice);

  const decision = document.createElement('div');
  decision.className = 'cxp-post-plan-decision';
  decision.appendChild(continueBtn);

  const feedbackGroup = document.createElement('div');
  feedbackGroup.className = 'cxp-post-plan-feedback-group';
  const feedbackId = `cxp-plan-feedback-${tab.id || 'active'}`;
  const feedbackLabel = document.createElement('label');
  feedbackLabel.className = 'cxp-post-plan-feedback-label';
  feedbackLabel.htmlFor = feedbackId;
  feedbackLabel.textContent = 'Suggest changes';
  const feedback = document.createElement('textarea');
  feedback.id = feedbackId;
  feedback.className = 'cxp-post-plan-feedback';
  feedback.rows = 2;
  feedback.placeholder = 'Add a requirement, change the approach, remove a step…';
  feedback.value = tab.planFeedbackDraft || '';
  feedback.setAttribute('aria-describedby', `${feedbackId}-hint ${feedbackId}-error`);

  const feedbackFooter = document.createElement('div');
  feedbackFooter.className = 'cxp-post-plan-feedback-footer';
  const feedbackHint = document.createElement('span');
  feedbackHint.id = `${feedbackId}-hint`;
  feedbackHint.className = 'cxp-post-plan-feedback-hint';
  feedbackHint.textContent = '⌘/Ctrl + Enter to update';
  const updateBtn = _ctx.createRequestButton('Update plan', 'secondary');
  updateBtn.dataset.planAction = 'feedback';
  updateBtn.classList.add('cxp-post-plan-update');
  feedbackFooter.append(feedbackHint, updateBtn);

  const feedbackError = document.createElement('div');
  feedbackError.id = `${feedbackId}-error`;
  feedbackError.className = 'cxp-post-plan-feedback-error';
  feedbackError.setAttribute('role', 'status');
  feedbackError.hidden = true;

  feedbackGroup.append(feedbackLabel, feedback, feedbackFooter, feedbackError);

  const utilities = document.createElement('div');
  utilities.className = 'cxp-post-plan-utilities';
  utilities.append(editBtn, compactBtn);

  let busy = false;
  const autosizeFeedback = () => {
    feedback.style.height = 'auto';
    feedback.style.height = `${Math.min(feedback.scrollHeight, 132)}px`;
  };
  const syncFeedbackAction = () => {
    updateBtn.disabled = busy
      || !feedback.value.trim()
      || _ctx.running
      || _ctx.startingThread
      || _ctx.compacting
      || tab.planEditor?.dirty
      || tab.planEditor?.saving;
  };
  const showFeedbackError = (message = '') => {
    feedbackError.textContent = message;
    feedbackError.hidden = !message;
  };

  const setBusy = (nextBusy) => {
    busy = !!nextBusy;
    card.classList.toggle('is-busy', busy);
    card.setAttribute('aria-busy', busy ? 'true' : 'false');
    [continueBtn, compactBtn, editBtn].forEach((btn) => { btn.disabled = busy; });
    feedback.disabled = busy;
    if (!busy) syncPlanEditorActions(tab);
    syncFeedbackAction();
  };

  feedback.addEventListener('input', () => {
    tab.planFeedbackDraft = feedback.value;
    if (_ctx.isActiveTab(tab) && typeof _ctx.setPlanFeedbackDraft === 'function') {
      _ctx.setPlanFeedbackDraft(feedback.value);
    }
    autosizeFeedback();
    showFeedbackError();
    syncFeedbackAction();
    _ctx.saveTabs();
  });

  const submitFeedback = () => {
    _ctx.withTab(tab, () => {
      if (busy || _ctx.running || _ctx.startingThread || _ctx.compacting || tab.planEditor?.dirty || tab.planEditor?.saving) return;
      const requestedChanges = feedback.value.trim();
      if (!requestedChanges) {
        syncFeedbackAction();
        feedback.focus();
        return;
      }
      const planText = getPlanMarkdown(tab);
      const prompt = buildCodexPlanRevisionPrompt(planText, requestedChanges);
      if (!prompt) return;

      showFeedbackError();
      setBusy(true);
      const previousPlanMode = !!tab.planMode;
      tab.planMode = true;
      _ctx.syncToolbarState();
      const sent = _ctx.dispatchPrompt(prompt, { tab, forcePlanModePrefix: true });
      if (!sent) {
        tab.planMode = previousPlanMode;
        _ctx.syncToolbarState();
        setBusy(false);
        showFeedbackError('Could not send these changes. Check the Codex connection and try again.');
        feedback.focus();
        _ctx.saveTabs();
        return;
      }

      tab.planFeedbackDraft = '';
      tab.showPostPlanActions = false;
      tab.planApprovalPending = false;
      if (typeof _ctx.setPlanFeedbackDraft === 'function') _ctx.setPlanFeedbackDraft('');
      if (typeof _ctx.setShowPostPlanActions === 'function') _ctx.setShowPostPlanActions(false);
      if (typeof _ctx.setPlanApprovalPending === 'function') _ctx.setPlanApprovalPending(false);
      removePostPlanCards(tab.messagesEl);
      updatePostPlanTranscriptMeta(tab);
      _ctx.saveTabs();
    });
  };

  feedback.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitFeedback();
    }
  });
  updateBtn.addEventListener('click', submitFeedback);

  continueBtn.addEventListener('click', async () => {
    if (busy) return;
    const selectedPlan = tab.planDocument;
    const initialApproval = approvePlan(tab);
    if (!initialApproval.ok) { showFeedbackError(initialApproval.reason); return; }
    setBusy(true);
    try {
      await _ctx.persistPlanDocument(tab);
      if (tab.closed) { setBusy(false); return; }
      if (tab.planDocument !== selectedPlan) throw new Error('The plan changed. Review the latest revision before continuing.');
    } catch (error) {
      setBusy(false);
      showFeedbackError(error?.message || 'Could not verify the approved plan.');
      return;
    }
    _ctx.withTab(tab, () => {
      if (_ctx.running || _ctx.startingThread || _ctx.compacting) { setBusy(false); return; }
      const approval = approvePlan(tab);
      if (!approval.ok) { setBusy(false); showFeedbackError(approval.reason); return; }
      const finalPrompt = approval.prompt;
      const previousPlanMode = !!tab.planMode;
      tab.planMode = false;
      tab.showPostPlanActions = false;
      tab.planApprovalPending = false;
      tab.planTurnActive = false;
      tab.lastPlanTurnId = '';
      tab.postPlanHeader = 'PLAN COMPLETE';
      if (typeof _ctx.setShowPostPlanActions === 'function') _ctx.setShowPostPlanActions(false);
      if (typeof _ctx.setPlanApprovalPending === 'function') _ctx.setPlanApprovalPending(false);
      if (typeof _ctx.setPlanTurnActive === 'function') _ctx.setPlanTurnActive(false);
      if (typeof _ctx.setLastPlanTurnId === 'function') _ctx.setLastPlanTurnId('');
      if (typeof _ctx.setPostPlanHeader === 'function') _ctx.setPostPlanHeader('PLAN COMPLETE');
      _ctx.syncToolbarState();
      const sent = _ctx.dispatchPrompt(finalPrompt, { tab, forcePlanModePrefix: false });
      if (!sent) {
        tab.planMode = previousPlanMode;
        tab.showPostPlanActions = true;
        tab.planApprovalPending = true;
        if (typeof _ctx.setShowPostPlanActions === 'function') _ctx.setShowPostPlanActions(true);
        if (typeof _ctx.setPlanApprovalPending === 'function') _ctx.setPlanApprovalPending(true);
        _ctx.syncToolbarState();
        renderPostPlanActions(tab);
        return;
      }
      _ctx.markPlanImplementationSubmitted?.(tab, selectedPlan);
      selectedPlan.approvedRevision = selectedPlan.revision;
      _ctx.persistPlanDocument(tab).catch((error) => {
        _ctx.withTab(tab, () => appendSystem(error?.message || 'Could not save the plan approval.', 'error'));
      });
      tab.planFeedbackDraft = '';
      if (typeof _ctx.setPlanFeedbackDraft === 'function') _ctx.setPlanFeedbackDraft('');
      removePostPlanCards(tab.messagesEl);
      updatePostPlanTranscriptMeta(tab);
      _ctx.saveTabs();
    });
  });

  compactBtn.addEventListener('click', () => {
    _ctx.withTab(tab, () => {
      if (_ctx.running || _ctx.startingThread || _ctx.compacting || tab.planEditor?.dirty || tab.planEditor?.saving) return;
      _ctx.startCompaction();
    });
  });

  editBtn.addEventListener('click', async () => {
    setBusy(true);
    await openCodexPlanEditor(tab);
    setBusy(false);
  });

  card.append(decision, feedbackGroup, utilities);
  body.appendChild(card);
  cardWrap.appendChild(body);
  el.appendChild(cardWrap);

  // Actions belong immediately below their document, including after a save.
  if (planEl?.parentElement === tab.messagesEl) planEl.after(el);
  else _ctx.withTab(tab, () => appendElement(el));
  autosizeFeedback();
  syncPlanEditorActions(tab);
  syncFeedbackAction();
  updatePostPlanTranscriptMeta(tab);
}

export function renderPostCompactionActions(tab = _ctx.boundTab) {
  if (!tab?.messagesEl) return;

  removePostCompactionCards(tab.messagesEl);
  if (!tab.showPostCompactionPrompt || tab.showPostPlanActions || tab.postCompactionPromptSource !== 'manual') {
    updatePostPlanTranscriptMeta(tab);
    return;
  }

  const el = document.createElement('div');
  el.className = 'cxp-msg cxp-msg-assistant cxp-post-compact-msg';

  const avatar = document.createElement('div');
  avatar.className = 'cxp-msg-avatar';
  avatar.innerHTML = OPENAI_ICON;
  el.appendChild(avatar);

  const cardWrap = document.createElement('div');
  cardWrap.className = 'cxp-msg-card';

  const head = document.createElement('div');
  head.className = 'cxp-msg-head';
  const labelEl = document.createElement('div');
  labelEl.className = 'cxp-msg-label';
  labelEl.textContent = 'Codex';
  head.appendChild(labelEl);
  cardWrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'cxp-msg-body';

  const card = document.createElement('div');
  card.className = 'cxp-post-plan-card cxp-post-compact-card';

  const header = document.createElement('div');
  header.className = 'cxp-post-plan-header';
  header.textContent = 'CONTEXT COMPACTED';
  card.appendChild(header);

  const note = document.createElement('div');
  note.className = 'cxp-post-plan-note';
  note.textContent = 'Context was compacted. Continue when you are ready and Codex will resume from the summarized conversation.';
  card.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'cxp-post-plan-actions';

  const continueBtn = _ctx.createRequestButton('Continue', 'primary');
  const dismissBtn = _ctx.createRequestButton('Not now', 'secondary');

  const syncHiddenState = () => {
    tab.showPostCompactionPrompt = false;
    tab.postCompactionPending = false;
    tab.postCompactionPromptSource = '';
    if (_ctx.isActiveTab(tab)) {
      if (typeof _ctx.setShowPostCompactionPrompt === 'function') _ctx.setShowPostCompactionPrompt(false);
      if (typeof _ctx.setPostCompactionPending === 'function') _ctx.setPostCompactionPending(false);
      if (typeof _ctx.setPostCompactionPromptSource === 'function') _ctx.setPostCompactionPromptSource('');
    }
  };

  const setBusy = (busy) => {
    [continueBtn, dismissBtn].forEach((btn) => { btn.disabled = busy; });
    card.style.opacity = busy ? '0.55' : '1';
    card.style.pointerEvents = busy ? 'none' : 'auto';
  };

  continueBtn.addEventListener('click', () => {
    _ctx.withTab(tab, () => {
      if (_ctx.running || _ctx.startingThread) return;
      syncHiddenState();
      const sent = _ctx.dispatchPrompt('Please continue from the compacted conversation where you left off.', {
        tab,
        forcePlanModePrefix: false,
      });
      if (!sent) {
        tab.showPostCompactionPrompt = true;
        tab.postCompactionPromptSource = 'manual';
        if (_ctx.isActiveTab(tab) && typeof _ctx.setShowPostCompactionPrompt === 'function') {
          _ctx.setShowPostCompactionPrompt(true);
        }
        if (_ctx.isActiveTab(tab) && typeof _ctx.setPostCompactionPromptSource === 'function') {
          _ctx.setPostCompactionPromptSource('manual');
        }
        renderPostCompactionActions(tab);
        return;
      }
      removePostCompactionCards(tab.messagesEl);
      updatePostPlanTranscriptMeta(tab);
      _ctx.saveTabs();
    });
  });

  dismissBtn.addEventListener('click', () => {
    setBusy(true);
    _ctx.withTab(tab, () => {
      syncHiddenState();
      removePostCompactionCards(tab.messagesEl);
      updatePostPlanTranscriptMeta(tab);
      _ctx.saveTabs();
    });
  });

  actions.append(continueBtn, dismissBtn);
  card.appendChild(actions);
  body.appendChild(card);
  cardWrap.appendChild(body);
  el.appendChild(cardWrap);

  _ctx.withTab(tab, () => appendElement(el));
}

// ═══════════════════════════════════════════
// Card System
// ═══════════════════════════════════════════

export function createCard(item, iconSvg, title, subtitle = '') {
  const el = document.createElement('div');
  el.className = 'cxp-card cxp-collapsed';
  el.dataset.itemId = item.id || '';
  el.dataset.expanded = '0';
  if (item?.type) el.dataset.itemType = item.type;
  if (item?.type === 'mcpToolCall' && isSynaBunMcpTool(item)) el.classList.add('cxp-card-synabun-tool');

  const head = document.createElement('div');
  head.className = 'cxp-card-head';

  const icon = document.createElement('div');
  icon.className = 'cxp-card-icon';
  icon.innerHTML = iconSvg;
  head.appendChild(icon);

  const titles = document.createElement('div');
  titles.className = 'cxp-card-titles';
  const titleEl = document.createElement('div');
  titleEl.className = 'cxp-card-title';
  titleEl.textContent = title;
  titles.appendChild(titleEl);
  const subtitleEl = document.createElement('div');
  subtitleEl.className = 'cxp-card-subtitle';
  subtitleEl.textContent = subtitle;
  titles.appendChild(subtitleEl);
  head.appendChild(titles);

  const pill = document.createElement('div');
  pill.className = 'cxp-status-pill';
  head.appendChild(pill);

  const chevron = document.createElement('div');
  chevron.className = 'cxp-card-chevron';
  head.appendChild(chevron);

  const body = document.createElement('div');
  body.className = 'cxp-card-body';

  el.append(head, body);
  bindCardHead(el);
  appendElement(el);
  return { el, head, body, titleEl, subtitleEl, pill };
}

export function bindCardHead(card) {
  bindExpandableCard(card, (node, expanded) => {
    node.dataset.userCollapsed = expanded ? '0' : '1';
    const state = expanded && node.dataset.itemId ? _ctx.items.get(node.dataset.itemId) : null;
    if (state) flushCardBody(state);
    _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
    _ctx.saveTabs();
  });
}

export function createFoldSection(label, {
  className = '',
  bodyClassName = '',
  preformatted = true,
  open = false,
} = {}) {
  const details = document.createElement('details');
  details.className = `cxp-fold${className ? ` ${className}` : ''}`;
  details.hidden = true;
  details.open = !!open;
  details.dataset.expanded = open ? '1' : '0';

  const summary = document.createElement('summary');
  summary.className = 'cxp-fold-summary';
  const labelEl = document.createElement('span');
  labelEl.className = 'cxp-fold-label';
  labelEl.textContent = label;
  summary.appendChild(labelEl);
  const chevron = document.createElement('span');
  chevron.className = 'cxp-card-chevron';
  summary.appendChild(chevron);
  details.appendChild(summary);

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'cxp-fold-body';
  const bodyEl = preformatted ? document.createElement('pre') : document.createElement('div');
  bodyEl.className = bodyClassName || (preformatted ? 'cxp-card-pre' : '');
  bodyWrap.appendChild(bodyEl);
  details.appendChild(bodyWrap);

  details.addEventListener('toggle', () => {
    details.dataset.expanded = details.open ? '1' : '0';
    _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
  });

  return { sectionEl: details, bodyEl, labelEl };
}

export function isSynaBunMcpTool(item) {
  return String(item?.server || '').trim().toLowerCase() === 'synabun';
}

export function getMcpToolIcon(item) {
  return isSynaBunMcpTool(item) ? SYNABUN_LOGO_ICON : ICON_TOOL;
}

export function isCardBodyHidden(state) {
  return !!state?.el?.classList.contains('cxp-collapsed');
}

function hasOwnField(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeReasoningText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(normalizeReasoningText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'summaryText', 'summary_text', 'content', 'message']) {
      if (typeof value[key] === 'string') return value[key];
    }
    return extractStructuredText(value);
  }
  return String(value);
}

function normalizeReasoningLines(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) => normalizeReasoningText(entry).trim())
    .filter(Boolean);
}

function reasoningTextFromKeys(item, keys) {
  if (!item || typeof item !== 'object') return [];
  for (const key of keys) {
    if (!hasOwnField(item, key)) continue;
    const lines = normalizeReasoningLines(item[key]);
    if (lines.length) return lines;
  }
  return [];
}

function isCompleteStatus(status) {
  if (!status) return false;
  if (typeof status === 'string') {
    return /^(complete|completed|done|success|failed|errored)$/i.test(status.trim());
  }
  if (typeof status === 'object') {
    return Object.keys(status).some((key) => isCompleteStatus(key));
  }
  return false;
}

function isReasoningComplete(item, hasIncomingText = false) {
  return isCompleteStatus(item?.status)
    || !!item?._synabunCompleted
    || (!_ctx.running && item?._synabunOwnership?.source === 'history')
    || !!item?.completedAt
    || !!item?.completed_at
    || item?.durationMs != null
    || item?.duration_ms != null
    || (hasIncomingText && !_ctx.running);
}

function getReasoningPreviewText(state) {
  const summaryText = Array.isArray(state?.summaryLines)
    ? state.summaryLines.map((line) => String(line || '').trim()).filter(Boolean).join(' ')
    : '';
  const contentText = Array.isArray(state?.contentLines)
    ? state.contentLines.map((line) => String(line || '').trim()).filter(Boolean).join(' ')
    : '';
  return _ctx.cleanPreview(summaryText || contentText || 'Working through the next step');
}

function updateReasoningChrome(state, { complete = false } = {}) {
  if (!state) return;
  if (state.summaryEl) state.summaryEl.textContent = complete && !state.summaryLines?.some(line => String(line).trim()) && !state.contentLines?.some(line => String(line).trim()) ? 'No reasoning summary was provided.' : getReasoningPreviewText(state);
  if (state.pillEl) state.pillEl.textContent = complete ? 'complete' : 'live';
  if (state.el) state.el.classList.toggle('cxp-reasoning-done', !!complete);
}

function cacheCollapsedCardState(state, item, itemType) {
  if (!state || !item) return;
  switch (itemType) {
    case 'plan':
      state.buffer = resolveFinalMarkdownText(state, item.text);
      break;
    case 'commandExecution': {
      if (hasOwnField(item, 'command')) {
        state.commandText = typeof item.command === 'string'
          ? item.command
          : (item.command == null ? '' : String(item.command));
      }
      if (hasOwnField(item, 'cwd')) state.commandCwd = item.cwd || '';
      const summary = summarizeCommandExecution(state.commandText || '', state.commandCwd || '');
      state.commandTitle = summary.title;
      state.commandSubtitle = summary.detail;
      const metaText = [
        item.processId ? `PID ${item.processId}` : '',
        item.durationMs != null ? `${item.durationMs}ms` : '',
        item.exitCode != null ? `exit ${item.exitCode}` : '',
      ].filter(Boolean).join(' • ');
      if (metaText || !state.metaText) state.metaText = metaText;
      if (item.aggregatedOutput != null) state.outputBuf = item.aggregatedOutput || '';
      break;
    }
    case 'mcpToolCall': {
      if (hasOwnField(item, 'server')) state.toolServer = item.server || '';
      if (hasOwnField(item, 'tool')) state.toolName = item.tool || '';
      const ui = item.mcpAppUi;
      const metadata = [item.durationMs != null ? `${item.durationMs}ms` : '', ui?.resourceUri || item.mcpAppResourceUri || '', ui?.preferredModelDisplayMode ? `Display: ${ui.preferredModelDisplayMode}` : ''].filter(Boolean).join(' · ');
      if (metadata) state.toolSubtitle = metadata;
      else if (!state.toolSubtitle) state.toolSubtitle = 'Tool call';
      if (hasOwnField(item, 'arguments')) state.argsText = formatStructuredValue(item.arguments);
      if (hasOwnField(item, 'error')) {
        state.progressText = item.error
          ? `Error: ${extractStructuredText(item.error) || formatStructuredValue(item.error)}`
          : '';
      }
      if (hasOwnField(item, 'result') || hasOwnField(item, 'error')) {
        state.resultText = extractToolResultText(item.result) || (item.error ? formatStructuredValue(item.error) : '');
      }
      break;
    }
    case 'dynamicToolCall': {
      if (hasOwnField(item, 'tool')) state.dynamicToolName = [item.namespace, item.tool].filter(Boolean).join(' / ');
      if (item.durationMs != null) state.dynamicSubtitle = `${item.durationMs}ms`;
      else if (!state.dynamicSubtitle) state.dynamicSubtitle = 'Client tool call';
      if (hasOwnField(item, 'arguments')) state.argsText = formatStructuredValue(item.arguments);
      if (hasOwnField(item, 'contentItems') || hasOwnField(item, 'success')) {
        state.resultText = extractDynamicToolResultText(item.contentItems)
          || (item.success === false ? 'Client tool call failed' : '');
      }
      break;
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (hasOwnField(item, 'changes')) {
        state.fileMetaText = changes.length ? `${changes.length} file change${changes.length > 1 ? 's' : ''}` : 'Pending file changes';
        state.filesText = resolveFileChangeSummary(item);
        const diffText = changes
          .map((change) => extractStructuredText(change?.diff || change?.patch || change?.content || change?.output || ''))
          .filter(Boolean)
          .join('\n\n');
        if (item.aggregatedOutput != null || diffText) {
          state.outputBuf = extractStructuredText(item.aggregatedOutput) || item.aggregatedOutput || diffText;
        }
      } else if (item.aggregatedOutput != null) {
        state.outputBuf = extractStructuredText(item.aggregatedOutput) || item.aggregatedOutput || '';
      }
      break;
    }
    case 'collabAgentToolCall': {
      if (hasOwnField(item, 'tool')) state.collabToolName = item.tool || '';
      const subtitle = [
        item.model || state.collabModel || '',
        Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length
          ? `${item.receiverThreadIds.length} agent${item.receiverThreadIds.length > 1 ? 's' : ''}`
          : '',
      ].filter(Boolean).join(' · ') || 'Sub-agent delegation';
      if (subtitle || !state.collabSubtitle) state.collabSubtitle = subtitle;
      if (hasOwnField(item, 'model')) state.collabModel = item.model || '';
      if (hasOwnField(item, 'prompt')) state.promptText = item.prompt || '';
      if (hasOwnField(item, 'agentsStates')) state.collabResultText = item.agentsStates ? pretty(item.agentsStates) : '';
      break;
    }
    default:
      break;
  }
}

export function flushCardBody(state) {
  if (!state?._bodyDirty) return;
  state._bodyDirty = false;
  switch (state.type) {
    case 'plan':
      setMarkdownBuffer(state, state.buffer || '', true);
      break;
    case 'commandExecution':
      if (state.titleEl) state.titleEl.textContent = state.commandTitle || 'Running shell command';
      if (state.subtitleEl) state.subtitleEl.textContent = state.commandSubtitle || 'Executing a shell command';
      if (state.metaEl) state.metaEl.textContent = state.metaText || '';
      setOptionalSection(state.commandSectionEl, state.commandEl, state.commandText || '');
      if (state.interactionEl) state.interactionEl.hidden = !state.interactionEl.textContent;
      setOptionalSection(state.outputSectionEl, state.outputEl, state.outputBuf || '');
      break;
    case 'mcpToolCall':
      if (state.titleEl) state.titleEl.textContent = `${state.toolServer || 'MCP'} • ${state.toolName || 'tool'}`;
      if (state.subtitleEl) state.subtitleEl.textContent = state.toolSubtitle || 'Tool call';
      setOptionalSection(state.argsSectionEl, state.argsEl, state.argsText || '');
      setOptionalText(state.progressEl, state.progressText || '');
      setOptionalSection(state.resultSectionEl, state.resultEl, state.resultText || '');
      break;
    case 'dynamicToolCall':
      if (state.titleEl) state.titleEl.textContent = state.dynamicToolName || 'Dynamic tool';
      if (state.subtitleEl) state.subtitleEl.textContent = state.dynamicSubtitle || 'Client tool call';
      setOptionalSection(state.argsSectionEl, state.argsEl, state.argsText || '');
      setOptionalSection(state.resultSectionEl, state.resultEl, state.resultText || '');
      break;
    case 'fileChange':
      if (state.metaEl) state.metaEl.textContent = state.fileMetaText || 'Pending file changes';
      if (state.filesEl) state.filesEl.textContent = state.filesText || 'Pending file changes';
      refreshFileChangeView(state);
      break;
    case 'collabAgentToolCall':
      if (state.titleEl) state.titleEl.textContent = state.collabToolName || 'Agent collaboration';
      if (state.subtitleEl) state.subtitleEl.textContent = state.collabSubtitle || 'Sub-agent delegation';
      setOptionalSection(state.promptSectionEl, state.promptEl, state.promptText || '');
      setOptionalSection(state.resultSectionEl, state.resultEl, state.collabResultText || '');
      break;
    default:
      if (state._lastItem) updateItemFromData(state._lastItem);
      break;
  }
}

export function setOptionalSection(sectionEl, bodyEl, text) {
  const value = typeof text === 'string' ? text : '';
  if (bodyEl) renderReadableBlock(bodyEl, value);
  if (sectionEl) sectionEl.hidden = !value.trim();
}

export function setOptionalText(el, text) {
  const value = typeof text === 'string' ? text : '';
  if (el) {
    el.textContent = value;
    el.hidden = !value.trim();
  }
}

export function queueMarkdownRender(state) {
  if (state.renderTimer) return;
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    if (!state.bodyEl) return;
    if (state.type === 'agentMessage') {
      renderAssistantMessage(state);
    } else {
      state.bodyEl.innerHTML = md(state.buffer || '');
      postProcessRenderedHtml(state.bodyEl);
    }
    _ctx.scrollEnd();
    _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
  }, 32);
}

function planMessageModels(tab) {
  const items = tab === _ctx.boundTab ? (_ctx.items || tab.items) : tab.items;
  return [...tab.messagesEl.querySelectorAll('.cxp-msg-assistant[data-plan-message-candidate="1"]')].map(el => {
    const state = items?.get(el.dataset.itemId);
    return { id: el.dataset.itemId, type: 'agentMessage', turnId: el.dataset.codexTurnId || '',
      threadId: el.dataset.codexThreadId || tab.threadId, phase: state?.phase || el.dataset.phase || '',
      text: state?.buffer ?? el.dataset.planSourceText ?? '', completed: state?.completed ?? el.dataset.messageCompleted === '1',
      planTurn: el.dataset.planTurn === '1', el, bodyEl: state?.bodyEl || el.querySelector('.cxp-msg-body') };
  });
}

export function syncMessagePlanActions(tab = _ctx.boundTab) {
  if (!tab?.messagesEl) return;
  const messages = planMessageModels(tab);
  const nativePlans = [...tab.messagesEl.querySelectorAll('[data-item-type="plan"]')].map(el => ({ itemId: el.dataset.itemId, turnId: el.dataset.codexTurnId || '' }));
  const selected = selectPlanAdoptionMessage(tab, messages, nativePlans);
  tab.messagesEl.querySelectorAll('.cxp-use-as-plan').forEach(button => {
    if (button.closest('.cxp-msg-assistant')?.dataset.itemId !== selected) button.remove();
  });
  const message = messages.find(entry => entry.id === selected);
  if (!message?.bodyEl) return;
  let button = message.bodyEl.querySelector('.cxp-use-as-plan');
  if (!button) {
    button = _ctx.createRequestButton('Use as plan', 'secondary');
    button.dataset.planAction = 'adopt';
    button.classList.add('cxp-use-as-plan');
    button.addEventListener('click', async () => {
      const current = planMessageModels(tab);
      const plans = [...tab.messagesEl.querySelectorAll('[data-item-type="plan"]')].map(el => ({ itemId: el.dataset.itemId, turnId: el.dataset.codexTurnId || '' }));
      if (selectPlanAdoptionMessage(tab, current, plans) !== message.id || tab.planEditor?.dirty || tab.planEditor?.saving) return;
      const candidate = current.find(entry => entry.id === message.id);
      button.disabled = true;
      try {
        await _ctx.adoptMessageAsPlan?.(tab, { itemId: candidate.id, turnId: candidate.turnId,
          markdown: extractProposedPlan(candidate.text) || candidate.text });
        renderPostPlanActions(tab);
      } finally { syncMessagePlanActions(tab); }
    });
    message.bodyEl.appendChild(button);
  }
  button.hidden = false;
  button.disabled = !!(tab.planEditor?.dirty || tab.planEditor?.saving);
}

function renderAssistantMessage(state) {
  const text = String(state.buffer || '').replace(/<\/?proposed_plan>/g, '');
  const streaming = !state.completed;
  const parser = _ctx.marked?.parse;
  const tab = _ctx.boundTab;
  const turnId = state.el?.dataset.codexTurnId || '';
  const candidate = isPlanMessageCandidate(tab, { type: 'agentMessage', text: state.buffer, phase: state.phase,
    turnId, planTurn: state.el?.dataset.planTurn === '1' || isRecordedPlanTurn(tab, turnId) });
  if (state.el) {
    state.el.dataset.messageCompleted = state.completed ? '1' : '0';
    if (candidate) {
      state.el.dataset.planMessageCandidate = '1';
      if (isRecordedPlanTurn(tab, turnId)) state.el.dataset.planTurn = '1';
      if (state.buffer.length <= OUTPUT_LIMITS.input) state.el.dataset.planSourceText = state.buffer;
      else delete state.el.dataset.planSourceText;
    } else { delete state.el.dataset.planMessageCandidate; delete state.el.dataset.planSourceText; }
  }
  if (state._renderedText === text && state._renderedStreaming === streaming && state._renderedParser === parser && state._renderedPhase === state.phase) { syncMessagePlanActions(tab); return; }
  state._renderedText = text; state._renderedStreaming = streaming; state._renderedParser = parser; state._renderedPhase = state.phase;
  const phase = normalizeAssistantPhase(state.phase || '');
  if (phase === 'commentary' && state.summaryBodyEl && state.verboseSectionEl && state.verboseBodyEl && state.renderedEl) {
    state.renderedEl.hidden = true;
    state.summaryBodyEl.hidden = false;
    state.summaryBodyEl.textContent = extractCompactAssistantSummary(state.buffer || '');
    state.verboseSectionEl.hidden = true;
    state.verboseBodyEl.innerHTML = '';
    if (state.el) state.el.classList.toggle('cxp-msg-empty', !state.summaryBodyEl.textContent.trim());
    syncMessagePlanActions(tab);
    return;
  }

  const target = state.renderedEl || state.bodyEl;
  let hasContent = false;
  if (target) {
    target.hidden = false;
    if (renderReadableOutput(target, text, { streaming })) hasContent = true;
    else {
      const rendered = renderAssistantMarkdown(text, { streaming });
      target.innerHTML = rendered.html; hasContent = rendered.hasContent;
    }
    postProcessRenderedHtml(target);
  }
  if (state.summaryBodyEl) {
    state.summaryBodyEl.hidden = true;
    state.summaryBodyEl.textContent = '';
  }
  if (state.verboseSectionEl) {
    state.verboseSectionEl.hidden = true;
  }
  if (state.verboseBodyEl) state.verboseBodyEl.innerHTML = '';
  if (state.el) state.el.classList.toggle('cxp-msg-empty', !hasContent);
  syncMessagePlanActions(tab);
}

export function setMarkdownBuffer(state, text, final = false) {
  state.buffer = text || '';
  if (final) {
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = null;
    if (state.bodyEl) {
      if (state.type === 'agentMessage') {
        renderAssistantMessage(state);
      } else {
        state.bodyEl.innerHTML = md(state.buffer);
        postProcessRenderedHtml(state.bodyEl);
      }
    }
    _ctx.scrollEnd();
    _ctx.scheduleThreadSnapshotSave(_ctx.boundTab, { force: true });
    return;
  }
  queueMarkdownRender(state);
}

// ═══════════════════════════════════════════
// Ensure*State — Item state initializers
// ═══════════════════════════════════════════

export function ensureUserState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;
  const shell = createMessageShell('user', 'User');
  shell.el.dataset.itemId = item.id || '';
  state = {
    type: 'userMessage',
    el: shell.el,
    bodyEl: shell.body,
  };
  _ctx.items.set(item.id, state);
  return state;
}

export function ensureAssistantState(itemId) {
  let state = _ctx.items.get(itemId);
  if (state) return state;
  const shell = createMessageShell('assistant', 'Codex');
  shell.el.dataset.itemId = itemId || '';
  const rendered = document.createElement('div');
  rendered.className = 'cxp-msg-rendered';
  shell.body.appendChild(rendered);
  const summary = document.createElement('div');
  summary.className = 'cxp-msg-summary';
  summary.hidden = true;
  shell.body.appendChild(summary);
  const verboseSection = createFoldSection('Verbose', {
    className: 'cxp-msg-verbose-fold',
    preformatted: false,
    bodyClassName: 'cxp-msg-verbose-body',
  });
  verboseSection.sectionEl.hidden = true;
  shell.body.appendChild(verboseSection.sectionEl);
  state = {
    type: 'agentMessage',
    el: shell.el,
    bodyEl: shell.body,
    renderedEl: rendered,
    summaryBodyEl: summary,
    verboseSectionEl: verboseSection.sectionEl,
    verboseBodyEl: verboseSection.bodyEl,
    labelEl: shell.labelEl,
    phaseEl: shell.phaseEl,
    buffer: '',
    renderTimer: null,
    phase: '',
  };
  state.el.classList.add('cxp-msg-empty');
  _ctx.items.set(itemId, state);
  return state;
}

export function ensureReasoningState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;

  const details = document.createElement('details');
  details.className = 'cxp-card cxp-reasoning';
  details.dataset.itemId = item.id || '';
  details.dataset.expanded = '1';

  const summary = document.createElement('summary');
  summary.innerHTML = `
    <span class="cxp-card-icon">${ICON_SPARK}</span>
    <span class="cxp-card-titles">
      <span class="cxp-card-title">Reasoning Summary</span>
      <span class="cxp-card-subtitle">Working through the next step</span>
    </span>
    <span class="cxp-think-dots"><span></span><span></span><span></span></span>
    <span class="cxp-status-pill">live</span>
    <span class="cxp-card-chevron"></span>
  `;
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'cxp-reasoning-body';
  details.appendChild(body);
  details.open = true;
  details.addEventListener('toggle', () => {
    details.dataset.expanded = details.open ? '1' : '0';
    if (state && !state.suppressToggleTracking) state.userToggled = true;
    _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
  });

  appendElement(details);
  state = {
    type: 'reasoning',
    el: details,
    bodyEl: body,
    summaryEl: summary.querySelector('.cxp-card-subtitle'),
    pillEl: summary.querySelector('.cxp-status-pill'),
    summaryLines: [],
    contentLines: [],
    userToggled: false,
    suppressToggleTracking: false,
  };
  _ctx.items.set(item.id, state);
  return state;
}

export function ensurePlanState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;
  const card = createCard(item, ICON_SPARK, 'Plan', 'Structured plan output');
  card.el.classList.add('cxp-plan-card');
  setCardExpanded(card.el, true);
  card.el.dataset.itemId = item.id || '';
  const body = document.createElement('div');
  body.className = 'cxp-msg-body';
  card.body.appendChild(body);
  state = {
    type: 'plan',
    el: card.el,
    bodyEl: body,
    buffer: '',
    renderTimer: null,
    pillEl: card.pill,
  };
  _ctx.items.set(item.id, state);
  return state;
}

export function ensureCommandState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;
  const summary = summarizeCommandExecution(item.command || '', item.cwd || '');
  const card = createCard(item, ICON_TERMINAL, summary.title, summary.detail);

  const meta = document.createElement('div');
  meta.className = 'cxp-card-meta';
  card.body.appendChild(meta);

  const commandSection = createFoldSection('Shell command', {
    className: 'cxp-fold-command',
    bodyClassName: 'cxp-card-pre cxp-card-pre-log',
  });
  card.body.appendChild(commandSection.sectionEl);

  const interaction = document.createElement('div');
  interaction.className = 'cxp-card-meta';
  interaction.hidden = true;
  card.body.appendChild(interaction);

  const outputSection = createFoldSection('Output', {
    className: 'cxp-fold-output',
    bodyClassName: 'cxp-card-pre cxp-card-pre-log',
  });
  card.body.appendChild(outputSection.sectionEl);

  state = {
    type: 'commandExecution',
    el: card.el,
    titleEl: card.titleEl,
    subtitleEl: card.subtitleEl,
    pillEl: card.pill,
    metaEl: meta,
    commandSectionEl: commandSection.sectionEl,
    commandEl: commandSection.bodyEl,
    interactionEl: interaction,
    outputSectionEl: outputSection.sectionEl,
    outputEl: outputSection.bodyEl,
    outputBuf: '',
  };
  _ctx.items.set(item.id, state);
  return state;
}

export function ensureToolState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;
  const card = createCard(item, getMcpToolIcon(item), `${item.server || 'MCP'} • ${item.tool || 'tool'}`, 'Tool call');

  const argsSection = createFoldSection('Arguments', {
    className: 'cxp-fold-args',
    bodyClassName: 'cxp-card-pre cxp-card-pre-json',
  });
  card.body.appendChild(argsSection.sectionEl);

  const progress = document.createElement('div');
  progress.className = 'cxp-card-meta';
  progress.hidden = true;
  card.body.appendChild(progress);

  const resultSection = createFoldSection('Result', {
    className: 'cxp-fold-result',
    bodyClassName: 'cxp-card-pre cxp-card-pre-result',
  });
  card.body.appendChild(resultSection.sectionEl);

  state = {
    type: 'mcpToolCall',
    el: card.el,
    titleEl: card.titleEl,
    subtitleEl: card.subtitleEl,
    pillEl: card.pill,
    argsSectionEl: argsSection.sectionEl,
    argsEl: argsSection.bodyEl,
    progressEl: progress,
    resultSectionEl: resultSection.sectionEl,
    resultEl: resultSection.bodyEl,
  };
  _ctx.items.set(item.id, state);
  return state;
}

export function ensureDynamicToolState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;
  const card = createCard(item, ICON_TOOL, item.tool || 'Dynamic tool', 'Client tool call');

  const argsSection = createFoldSection('Arguments', {
    className: 'cxp-fold-args',
    bodyClassName: 'cxp-card-pre cxp-card-pre-json',
  });
  card.body.appendChild(argsSection.sectionEl);

  const resultSection = createFoldSection('Result', {
    className: 'cxp-fold-result',
    bodyClassName: 'cxp-card-pre cxp-card-pre-result',
  });
  card.body.appendChild(resultSection.sectionEl);

  state = {
    type: 'dynamicToolCall',
    el: card.el,
    titleEl: card.titleEl,
    subtitleEl: card.subtitleEl,
    pillEl: card.pill,
    argsSectionEl: argsSection.sectionEl,
    argsEl: argsSection.bodyEl,
    resultSectionEl: resultSection.sectionEl,
    resultEl: resultSection.bodyEl,
  };
  _ctx.items.set(item.id, state);
  return state;
}

function refreshFileChangeView(state) {
  if (!state?.outputEl) return;
  const item = { ...state._lastItem, aggregatedOutput: state.outputBuf || state._lastItem?.aggregatedOutput || '' };
  const files = fileChangeDiffs(item);
  state.diffFiles = files;
  renderDiffView(state.outputEl, files, { lazy: state._lastItem?._synabunOwnership?.source === 'history', cwd: _ctx.boundTab?.project || _ctx.project, summaryEl: state.metaEl });
  state.outputEl.hidden = !files.length;
  const turnId = state.el?.dataset.codexTurnId;
  const latest = _ctx.boundTab?.latestTurnDiff;
  if (latest?.turnId === turnId) renderTurnDiff(turnId, latest.diff);
  const itemId = state.el?.dataset.itemId;
  for (const view of _ctx.messagesEl?.querySelectorAll('[data-approval-diff-item]') || []) {
    if (view.dataset.approvalDiffItem !== itemId || !files.length) continue;
    view.classList.remove('cxp-output-note');
    renderDiffView(view, files, { cwd: _ctx.boundTab?.project || _ctx.project });
  }
}

// Aggregate events include shell edits. Only omit a file when an item card in
// this same turn already contains the same patch; the synthetic card is reused.
export function renderTurnDiff(turnId, diff, { lazy = false } = {}) {
  if (!turnId || !_ctx.messagesEl) return;
  const id = `turn-diff:${turnId}`;
  const shown = [];
  for (const [itemId, state] of _ctx.items) {
    if (itemId === id || state.type !== 'fileChange' || state.el?.dataset.codexTurnId !== String(turnId)) continue;
    shown.push(...(state.diffFiles || fileChangeDiffs({ ...state._lastItem, aggregatedOutput: state.outputBuf || '' })));
  }
  // HTML snapshots may not have item states until native history catches up.
  for (const card of _ctx.messagesEl.querySelectorAll('[data-item-type="fileChange"]')) {
    if (card.dataset.itemId === id || _ctx.items.has(card.dataset.itemId) || card.dataset.codexTurnId !== String(turnId)) continue;
    const raw = card.querySelector('.cxp-diff-source')?.textContent;
    if (raw) shown.push(...parseUnifiedDiff(raw));
  }
  const files = deduplicateTurnDiff(parseUnifiedDiff(diff), shown);
  let state = _ctx.items.get(id);
  if (!state) {
    const old = [..._ctx.messagesEl.querySelectorAll('[data-turn-diff]')].find(card => card.dataset.codexTurnId === String(turnId));
    if (old) {
      state = { type: 'fileChange', el: old, pillEl: old.querySelector('.cxp-status-pill'), metaEl: old.querySelector('.cxp-card-meta'), outputEl: old.querySelector('.cxp-diff-view'), outputBuf: '' };
      _ctx.items.set(id, state);
    }
  }
  if (!files.length) {
    if (state) { state.el.hidden = true; _ctx.scheduleThreadSnapshotSave(_ctx.boundTab, { force: true }); }
    return;
  }
  if (!state) {
    state = ensureFileChangeState({ id, type: 'fileChange' });
    state.el.dataset.codexTurnId = String(turnId);
    state.el.dataset.turnDiff = '1';
  }
  state.el.hidden = false;
  state.pillEl.textContent = 'completed';
  state.metaEl.textContent = `${files.length} file change${files.length === 1 ? '' : 's'}`;
  state.diffFiles = files;
  renderDiffView(state.outputEl, files, { lazy, cwd: _ctx.boundTab?.project || _ctx.project, summaryEl: state.metaEl });
  const anchor = [..._ctx.messagesEl.children].filter(node => node !== state.el && node.dataset?.codexTurnId === String(turnId)).at(-1);
  if (anchor && anchor.nextElementSibling !== state.el) anchor.after(state.el);
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab, { force: true });
}

export function completeTurnOutputs(turnId) {
  for (const state of _ctx.items.values()) {
    if (turnId && state.el?.dataset.codexTurnId !== String(turnId)) continue;
    if (state.type === 'reasoning') {
      updateReasoningChrome(state, { complete: true });
      if (state.bodyEl) state.bodyEl.textContent = getReasoningBodyText(state, { complete: true });
      if (!state.userToggled && state.el) { state.el.open = false; state.el.dataset.expanded = '0'; }
    } else if (state.type === 'agentMessage' && !state.completed) {
      state.completed = true;
      renderAssistantMessage(state);
    }
  }
}

export function ensureFileChangeState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;
  const card = createCard(item, ICON_FILES, 'File change', 'Proposed file updates');
  setCardExpanded(card.el, true);

  const summary = document.createElement('div');
  summary.className = 'cxp-card-meta';
  card.body.appendChild(summary);

  const filesSection = document.createElement('div');
  filesSection.className = 'cxp-card-section';
  const filesLabel = document.createElement('div');
  filesLabel.className = 'cxp-card-section-label';
  filesLabel.textContent = 'Files changed';
  const filesBody = document.createElement('div');
  filesBody.className = 'cxp-card-meta';
  filesSection.append(filesLabel, filesBody);
  card.body.appendChild(filesSection);

  const outputEl = document.createElement('div');
  outputEl.className = 'cxp-card-pre-diff';
  card.body.appendChild(outputEl);
  filesSection.hidden = true;

  state = {
    type: 'fileChange',
    el: card.el,
    pillEl: card.pill,
    metaEl: summary,
    filesEl: filesBody,
    outputSectionEl: outputEl,
    outputEl,
    outputBuf: '',
  };
  _ctx.items.set(item.id, state);
  return state;
}

export function ensureCollabAgentState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;
  const card = createCard(item, ICON_BRAIN, item.tool || 'Agent collaboration', 'Sub-agent delegation');

  const promptSection = createFoldSection('Delegation prompt', {
    className: 'cxp-fold-prompt',
    bodyClassName: 'cxp-card-pre cxp-card-pre-prompt',
  });
  card.body.appendChild(promptSection.sectionEl);

  const resultSection = createFoldSection('Agent result', {
    className: 'cxp-fold-result',
    bodyClassName: 'cxp-card-pre cxp-card-pre-json',
  });
  card.body.appendChild(resultSection.sectionEl);

  state = {
    type: 'collabAgentToolCall',
    el: card.el,
    titleEl: card.titleEl,
    subtitleEl: card.subtitleEl,
    pillEl: card.pill,
    promptSectionEl: promptSection.sectionEl,
    promptEl: promptSection.bodyEl,
    resultSectionEl: resultSection.sectionEl,
    resultEl: resultSection.bodyEl,
  };
  _ctx.items.set(item.id, state);
  return state;
}

export function ensureGenericState(item) {
  let state = _ctx.items.get(item.id);
  if (state) return state;
  const summary = _ctx.itemHeadline(item);
  const head = codexGenericCardHead(item, summary);
  const card = createCard(item, ICON_TOOL, head.title, head.subtitle || 'Codex item');
  const pre = document.createElement('pre');
  pre.className = 'cxp-card-pre';
  card.body.appendChild(pre);
  state = {
    type: item.type || 'item',
    el: card.el,
    titleEl: card.titleEl,
    subtitleEl: card.subtitleEl,
    pillEl: card.pill,
    preEl: pre,
  };
  _ctx.items.set(item.id, state);
  return state;
}

// ═══════════════════════════════════════════
// Interaction & Guardian Review
// ═══════════════════════════════════════════

export function setCommandInteraction(itemId, processId) {
  const state = _ctx.items.get(itemId) || ensureCommandState({ id: itemId });
  if (!state.interactionEl) return;
  state.interactionEl.hidden = false;
  state.interactionEl.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'cxp-card-section-label';
  label.textContent = `Terminal interaction · PID ${processId || itemId}`;
  state.interactionEl.appendChild(label);
  const inputWrap = document.createElement('div');
  inputWrap.className = 'cxp-terminal-input-wrap';
  const termInput = document.createElement('input');
  termInput.type = 'text';
  termInput.className = 'cxp-terminal-input';
  termInput.placeholder = 'Type terminal input and press Enter…';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'cxp-btn cxp-btn-sm';
  sendBtn.textContent = 'Send';
  const doSend = () => {
    const val = termInput.value;
    if (!val && val !== '') return;
    _ctx.sendSocket({ type: 'terminal_input', itemId, processId, input: val + '\n' });
    termInput.value = '';
  };
  termInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } });
  sendBtn.addEventListener('click', doSend);
  inputWrap.append(termInput, sendBtn);
  state.interactionEl.appendChild(inputWrap);
  _ctx.scrollEnd();
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

export function setGuardianReviewState(targetItemId, review) {
  const state = _ctx.items.get(targetItemId);
  const text = formatGuardianReview(review);
  if (!state?.el) {
    if (text) appendSystem(`Approval review · ${text}`, review?.status === 'approved' ? 'muted' : 'working');
    return;
  }

  const body = state.bodyEl || state.el.querySelector('.cxp-card-body');
  if (!body) return;
  if (!state.reviewEl) {
    const meta = document.createElement('div');
    meta.className = 'cxp-card-meta';
    body.prepend(meta);
    state.reviewEl = meta;
  }
  state.reviewEl.textContent = text;
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

// ═══════════════════════════════════════════
// updateItemFromData — Master item updater
// ═══════════════════════════════════════════

function getRenderableItemType(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'collabToolCall') return 'collabAgentToolCall';
  return item.type || '';
}

function renderAgentMetadata(state, item) {
  const metadata = { delivery: item.delivery, questions: item.questions, memoryCitation: item.memoryCitation };
  const signature = JSON.stringify(metadata);
  if (state.agentMetadataSignature === signature) return;
  state.agentMetadataSignature = signature;
  state.agentMetadataEl?.remove();
  if (!item.delivery && !item.questions?.length && !item.memoryCitation) return;
  const section = document.createElement('div');
  section.className = 'cxp-card-section cxp-ask';
  if (item.memoryCitation) {
    const note = document.createElement('div'); note.className = 'cxp-card-meta';
    note.textContent = `Memory references\n${codexReadableValue(item.memoryCitation)}`;
    section.appendChild(note);
  }
  if (item.questions?.length) {
    const note = document.createElement('div'); note.className = 'cxp-request-note';
    note.textContent = 'Codex can continue working while you answer.'; section.appendChild(note);
    const fields = item.questions.map(question => {
      const label = document.createElement('label'); label.className = 'cxp-config-row';
      const title = document.createElement('span'); title.className = 'cxp-config-label'; title.textContent = question.title;
      const input = document.createElement('input'); input.className = 'cxp-config-input';
      label.append(title, input); section.appendChild(label);
      for (const option of question.options || []) {
        const button = _ctx.createRequestButton(option, 'secondary');
        button.addEventListener('click', () => { input.value = option; }); section.appendChild(button);
      }
      return { question, input };
    });
    const send = _ctx.createRequestButton('Send answers');
    const tab = _ctx.boundTab;
    send.addEventListener('click', () => {
      const answers = fields.filter(field => field.input.value.trim()).map(field => `${field.question.title}\n${field.input.value.trim()}`);
      if (!answers.length) return;
      if (_ctx.dispatchPrompt(answers.join('\n\n'), { tab })) {
        send.disabled = true; fields.forEach(field => { field.input.disabled = true; });
      }
    });
    section.appendChild(send);
  }
  state.agentMetadataEl = section;
  state.bodyEl.appendChild(section);
}

export function updateItemFromData(item) {
  if (!item?.id) return;
  if (!_ctx.itemOwnershipBelongsToBoundThread(item)) return;
  const itemType = getRenderableItemType(item);
  if (itemType === 'contextCompaction') {
    return;
  }

  let state = _ctx.items.get(item.id);
  if (!state) {
    switch (itemType) {
      case 'userMessage': state = ensureUserState(item); break;
      case 'hookPrompt': state = ensureGenericState(item); break;
      case 'agentMessage': state = ensureAssistantState(item.id); break;
      case 'reasoning': state = ensureReasoningState(item); break;
      case 'plan': state = ensurePlanState(item); break;
      case 'commandExecution': state = ensureCommandState(item); break;
      case 'mcpToolCall': state = ensureToolState(item); break;
      case 'dynamicToolCall': state = ensureDynamicToolState(item); break;
      case 'fileChange': state = ensureFileChangeState(item); break;
      case 'collabAgentToolCall': state = ensureCollabAgentState(item); break;
      default: state = ensureGenericState(item); break;
    }
  }

  if (itemType === 'agentMessage' || itemType === 'plan') {
    state.completed = !!(state.completed || item._synabunCompleted || isCompleteStatus(item.status) || (!_ctx.running && typeof item.text === 'string'));
  }
  if (state.el && (item._synabunOwnership?.turnId || item.turnId)) state.el.dataset.codexTurnId = String(item._synabunOwnership?.turnId || item.turnId);
  if (itemType === 'plan') syncMessagePlanActions(_ctx.boundTab);

  // Store last item for lazy flush; skip body DOM writes for collapsed cards
  const _isCard = state.el?.classList.contains('cxp-card');
  if (_isCard) {
    state._lastItem = state._lastItem ? { ...state._lastItem, ...item } : item;
    cacheCollapsedCardState(state, state._lastItem, itemType);
    if (itemType === 'mcpToolCall') mountMcpAppCard({ card: state.el, item: state._lastItem,
      tab: _ctx.boundTab, request: _ctx.requestForTab, draft: _ctx.setMcpAppDraft });
    // Always update head elements (visible even when collapsed)
    if (state.titleEl) {
      const h = _ctx.itemHeadline(state._lastItem);
      const head = state.preEl ? codexGenericCardHead(state._lastItem, h) : null;
      state.titleEl.textContent = head?.title || h.detail || item.type || 'Item';
      if (head && state.subtitleEl) state.subtitleEl.textContent = head.subtitle;
    }
    if (state.pillEl && item.status != null) state.pillEl.textContent = _ctx.formatStatus(item.status);
    if (isCardBodyHidden(state)) { state._bodyDirty = true; _ctx.scheduleThreadSnapshotSave(_ctx.boundTab); return; }
  }

  switch (itemType) {
    case 'userMessage':
      renderUserMessageContent(state.bodyEl, item.content);
      break;
    case 'agentMessage': {
      const phase = normalizeAssistantPhase(item.phase || state.phase || '');
      state.phase = phase;
      if (state.el) {
        if (phase) state.el.dataset.phase = phase;
        else delete state.el.dataset.phase;
      }
      if (state.labelEl) state.labelEl.textContent = 'Codex';
      if (state.phaseEl) {
        state.phaseEl.hidden = phase !== 'final_answer';
        state.phaseEl.textContent = phase === 'final_answer' ? 'Final' : '';
      }
      setMarkdownBuffer(state, resolveFinalMarkdownText(state, item.text), true);
      renderAgentMetadata(state, item);
      break;
    }
    case 'reasoning': {
      const incomingSummaryLines = reasoningTextFromKeys(item, ['summary', 'summaryText', 'summary_text']);
      const incomingContentLines = reasoningTextFromKeys(item, ['content', 'text']);
      const hasIncomingText = incomingSummaryLines.length > 0 || incomingContentLines.length > 0;
      if (incomingSummaryLines.length) state.summaryLines = incomingSummaryLines;
      if (incomingContentLines.length) state.contentLines = incomingContentLines;
      const complete = isReasoningComplete(item, hasIncomingText);
      updateReasoningChrome(state, { complete });
      if (state.bodyEl) state.bodyEl.textContent = getReasoningBodyText(state, { complete });
      if (state.el && complete && !state.userToggled) {
        state.suppressToggleTracking = true;
        state.el.open = false;
        state.el.dataset.expanded = '0';
        setTimeout(() => { state.suppressToggleTracking = false; }, 0);
      } else if (state.el && !complete) {
        state.el.classList.remove('cxp-reasoning-done');
        if (!state.userToggled) {
          state.suppressToggleTracking = true;
          state.el.open = true;
          state.el.dataset.expanded = '1';
          setTimeout(() => { state.suppressToggleTracking = false; }, 0);
        }
      }
      break;
    }
    case 'plan':
      if (state.pillEl) state.pillEl.textContent = state.completed ? 'complete' : 'draft';
      setMarkdownBuffer(state, resolveFinalMarkdownText(state, item.text), true);
      break;
    case 'commandExecution': {
      state.titleEl.textContent = state.commandTitle || 'Running shell command';
      state.subtitleEl.textContent = state.commandSubtitle || 'Executing a shell command';
      state.pillEl.textContent = _ctx.formatStatus(item.status);
      state.metaEl.textContent = state.metaText || '';
      setOptionalSection(state.commandSectionEl, state.commandEl, state.commandText || '');
      if (item.aggregatedOutput != null) {
        state.outputBuf = item.aggregatedOutput || '';
        setOptionalSection(state.outputSectionEl, state.outputEl, state.outputBuf);
      } else if (state.outputBuf) {
        setOptionalSection(state.outputSectionEl, state.outputEl, state.outputBuf);
      }
      if (state.interactionEl) {
        state.interactionEl.hidden = !state.interactionEl.textContent;
      }
      break;
    }
    case 'mcpToolCall': {
      state.titleEl.textContent = `${state.toolServer || 'MCP'} • ${state.toolName || 'tool'}`;
      state.subtitleEl.textContent = state.toolSubtitle || 'Tool call';
      state.pillEl.textContent = _ctx.formatStatus(item.status);
      setOptionalSection(state.argsSectionEl, state.argsEl, state.argsText || '');
      setOptionalText(state.progressEl, state.progressText || '');
      setOptionalSection(state.resultSectionEl, state.resultEl, state.resultText || '');
      break;
    }
    case 'dynamicToolCall': {
      state.titleEl.textContent = state.dynamicToolName || 'Dynamic tool';
      state.subtitleEl.textContent = state.dynamicSubtitle || 'Client tool call';
      state.pillEl.textContent = _ctx.formatStatus(item.status);
      setOptionalSection(state.argsSectionEl, state.argsEl, state.argsText || '');
      setOptionalSection(state.resultSectionEl, state.resultEl, state.resultText || '');
      break;
    }
    case 'fileChange': {
      state.pillEl.textContent = _ctx.formatStatus(item.status);
      state.metaEl.textContent = state.fileMetaText || 'Pending file changes';
      if (state.filesEl) state.filesEl.textContent = state.filesText || 'Pending file changes';
      if (item.aggregatedOutput != null) {
        state.outputBuf = extractStructuredText(item.aggregatedOutput) || item.aggregatedOutput || '';
      }
      refreshFileChangeView(state);
      break;
    }
    case 'collabAgentToolCall': {
      if (state.titleEl) state.titleEl.textContent = state.collabToolName || 'Agent collaboration';
      if (state.subtitleEl) state.subtitleEl.textContent = state.collabSubtitle || 'Sub-agent delegation';
      if (state.pillEl) state.pillEl.textContent = _ctx.formatStatus(item.status);
      if (state.promptSectionEl && state.promptEl) {
        setOptionalSection(state.promptSectionEl, state.promptEl, state.promptText || '');
      }
      if (state.resultSectionEl && state.resultEl) {
        setOptionalSection(state.resultSectionEl, state.resultEl, state.collabResultText || '');
      }
      break;
    }
    case 'webSearch':
      if (state.titleEl || state.subtitleEl) {
        if (state.titleEl) state.titleEl.textContent = 'Web search';
        if (state.subtitleEl) state.subtitleEl.textContent = item.query || '';
      }
      if (state.pillEl) state.pillEl.textContent = item.action?.type || 'search';
      if (state.preEl) {
        state.preEl.textContent = codexReadableValue({ action: item.action, results: item.results, query: item.query });
      }
      break;
    case 'imageView':
      if (state.titleEl || state.subtitleEl) {
        if (state.titleEl) state.titleEl.textContent = 'Viewing image';
        if (state.subtitleEl) state.subtitleEl.textContent = _ctx.cleanPreview(item.path || '');
      }
      if (state.pillEl) state.pillEl.textContent = 'complete';
      if (state.preEl) {
        state.preEl.textContent = item.path || '';
        if (item.path && !state._imgRendered) {
          state._imgRendered = true;
          const imgWrap = document.createElement('div');
          imgWrap.className = 'cxp-image-preview';
          const img = document.createElement('img');
          img.src = item.url || item.path;
          img.alt = item.path;
          img.style.maxWidth = '100%';
          img.style.maxHeight = '300px';
          img.style.borderRadius = '6px';
          img.style.marginTop = '8px';
          img.style.cursor = 'pointer';
          img.addEventListener('click', () => {
            const overlay = document.createElement('div');
            overlay.className = 'cxp-lightbox';
            const fullImg = document.createElement('img');
            fullImg.src = img.src;
            overlay.appendChild(fullImg);
            overlay.addEventListener('click', () => overlay.remove());
            document.body.appendChild(overlay);
          });
          img.onerror = () => { imgWrap.remove(); };
          imgWrap.appendChild(img);
          state.preEl.after(imgWrap);
        }
      }
      break;
    case 'imageGeneration':
      if (state.titleEl || state.subtitleEl) {
        if (state.titleEl) state.titleEl.textContent = 'Image generation';
        if (state.subtitleEl) state.subtitleEl.textContent = item.status || '';
      }
      if (state.pillEl) state.pillEl.textContent = item.status || 'complete';
      if (state.preEl) {
        state.preEl.textContent = [
          item.revisedPrompt ? `Prompt\n${item.revisedPrompt}` : '',
          item.savedPath ? `Saved path\n${item.savedPath}` : '',
          item.result ? `Result\n${item.result}` : '',
          item.failure ? `Failure\n${codexReadableValue(item.failure)}` : '',
          item.transparentBackground != null ? `Transparent background: ${item.transparentBackground ? 'yes' : 'no'}` : '',
        ].filter(Boolean).join('\n\n');
      }
      break;
    case 'hookPrompt':
      if (state.titleEl || state.subtitleEl) {
        if (state.titleEl) state.titleEl.textContent = 'Hook prompt';
        if (state.subtitleEl) state.subtitleEl.textContent = 'Injected context';
      }
      if (state.pillEl) state.pillEl.textContent = 'complete';
      if (state.preEl) state.preEl.textContent = Array.isArray(item.fragments)
        ? item.fragments.map((fragment) => fragment?.text || '').filter(Boolean).join('\n\n')
        : pretty(item.fragments);
      break;
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      if (state.titleEl || state.subtitleEl) {
        if (state.titleEl) state.titleEl.textContent = item.type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode';
        if (state.subtitleEl) state.subtitleEl.textContent = '';
      }
      if (state.pillEl) state.pillEl.textContent = 'complete';
      if (state.preEl) state.preEl.textContent = item.review || '';
      break;
    default: {
      const presentation = codexTranscriptPresentation(item);
      if (state.titleEl || state.subtitleEl) {
        if (state.titleEl) state.titleEl.textContent = presentation.title;
        if (state.subtitleEl) state.subtitleEl.textContent = presentation.subtitle;
      }
      if (state.pillEl) state.pillEl.textContent = _ctx.formatStatus(presentation.status);
      if (state.preEl) state.preEl.textContent = presentation.text;
      break;
    }
  }
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

// ═══════════════════════════════════════════
// Delta Appending
// ═══════════════════════════════════════════

export function appendAgentDelta(itemId, delta) {
  const state = ensureAssistantState(itemId);
  state.buffer += delta || '';
  setMarkdownBuffer(state, state.buffer, false);
}

export function appendPlanDelta(itemId, delta) {
  const state = ensurePlanState({ id: itemId });
  if (state.pillEl) state.pillEl.textContent = 'live';
  state.buffer += delta || '';
  if (isCardBodyHidden(state)) { state._bodyDirty = true; return; }
  setMarkdownBuffer(state, state.buffer, false);
}

export function getReasoningBodyText(state, { complete = false } = {}) {
  if (!state) return complete ? 'No reasoning summary was provided.' : 'Waiting for reasoning summary...';
  const contentText = Array.isArray(state.contentLines) ? state.contentLines.join('').trim() : '';
  if (contentText) return contentText;
  const summaryText = Array.isArray(state.summaryLines)
    ? state.summaryLines.map((line) => String(line || '').trim()).filter(Boolean).join('\n')
    : '';
  return summaryText || (complete ? 'No reasoning summary was provided.' : 'Waiting for reasoning summary...');
}

export function appendReasoningDelta(itemId, delta, isSummary = false, summaryIndex = null) {
  const state = ensureReasoningState({ id: itemId });
  state.el?.classList.remove('cxp-reasoning-done');
  if (state.pillEl) state.pillEl.textContent = 'live';
  if (!state.userToggled && state.el && !state.el.open) {
    state.suppressToggleTracking = true;
    state.el.open = true;
    state.el.dataset.expanded = '1';
    setTimeout(() => { state.suppressToggleTracking = false; }, 0);
  }
  if (isSummary) {
    const idx = Number.isFinite(summaryIndex) ? Math.max(0, summaryIndex) : state.summaryLines.length;
    state.summaryLines[idx] = (state.summaryLines[idx] || '') + (delta || '');
  } else {
    state.contentLines.push(delta || '');
  }
  updateReasoningChrome(state, { complete: false });
  state.bodyEl.textContent = getReasoningBodyText(state);
  _ctx.scrollEnd();
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

export function appendReasoningSummaryPart(itemId, summaryIndex) {
  const state = ensureReasoningState({ id: itemId });
  const idx = Number.isFinite(summaryIndex) ? Math.max(0, summaryIndex) : state.summaryLines.length;
  if (state.summaryLines[idx] == null) state.summaryLines[idx] = '';
  updateReasoningChrome(state, { complete: false });
  state.bodyEl.textContent = getReasoningBodyText(state);
}

export function appendOutputDelta(itemId, delta, fallbackType = 'commandExecution') {
  const state = _ctx.items.get(itemId) || (fallbackType === 'fileChange'
    ? ensureFileChangeState({ id: itemId })
    : ensureCommandState({ id: itemId }));
  if (!state.outputEl) return;
  state.outputBuf = (state.outputBuf || '') + (delta || '');
  if (isCardBodyHidden(state)) { state._bodyDirty = true; return; }
  if (state.type === 'fileChange') refreshFileChangeView(state);
  else setOptionalSection(state.outputSectionEl, state.outputEl, state.outputBuf);
  _ctx.scrollEnd();
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

export function appendToolProgress(itemId, message) {
  const state = ensureToolState({ id: itemId, server: 'MCP', tool: 'tool' });
  state._lastProgress = message || '';
  state.progressText = state._lastProgress;
  if (isCardBodyHidden(state)) { state._bodyDirty = true; return; }
  setOptionalText(state.progressEl, state._lastProgress);
  _ctx.scrollEnd();
  _ctx.scheduleThreadSnapshotSave(_ctx.boundTab);
}

// ═══════════════════════════════════════════
// Active Item Tracking
// ═══════════════════════════════════════════

export function trackActiveItemStart(item) {
  if (!item?.id || item.type === 'userMessage' || item.type === 'contextCompaction') return;
  const existing = _ctx.activeItems.get(item.id);
  _ctx.activeItems.set(item.id, {
    id: item.id,
    item: existing?.item ? { ...existing.item, ...item } : item,
    startedAt: existing?.startedAt || Date.now(),
  });
  if (_ctx.boundTab) _ctx.boundTab.activeItems = _ctx.activeItems;
  _ctx.syncWorkStatus();
}

export function trackActiveItemCompletion(item) {
  if (!item?.id) return;
  const existing = _ctx.activeItems.get(item.id);
  if (existing) _ctx.activeItems.delete(item.id);
  if (_ctx.boundTab) _ctx.boundTab.activeItems = _ctx.activeItems;
  _ctx.syncWorkStatus();
}

// ═══════════════════════════════════════════
// Transcript Node Counting & History Helpers
// ═══════════════════════════════════════════

export function countRenderableTranscriptNodes(container) {
  if (!container) return 0;
  return [...container.children].filter((node) => !(
    node.classList?.contains('cxp-empty')
    || node.classList?.contains('cxp-thinking')
  )).length;
}

export function flattenThreadHistoryItems(thread) {
  if (!Array.isArray(thread?.turns)) return [];
  return thread.turns.flatMap((turn) => Array.isArray(turn?.items) ? turn.items.filter(Boolean) : []);
}

export function resolveHistoryRenderSource(thread, fallbackItems = null, storedSnapshot = null) {
  const sdkItems = flattenThreadHistoryItems(thread);
  const fallbackHistoryItems = Array.isArray(fallbackItems) ? fallbackItems.filter(Boolean) : [];
  const snapshot = _ctx.normalizeThreadSnapshotEntry(storedSnapshot, thread?.id || null);
  const threadUpdatedAt = _ctx.timestampMs(thread?.updatedAt || thread?.createdAt);
  // Structured Codex history is authoritative. A rendered-HTML snapshot is a
  // presentation cache only; extra cards must never make it "more complete".
  const selected = selectCodexHistoryRenderSource({
    sdkItems,
    fallbackItems: fallbackHistoryItems,
    snapshot,
  });
  return {
    ...selected,
    sourceUpdatedAt: selected.sourceType === 'snapshot'
      ? (snapshot.sourceUpdatedAt || snapshot.updatedAt || Date.now())
      : (threadUpdatedAt || Date.now()),
    counts: {
      sdkItems: sdkItems.length,
      fallbackItems: fallbackHistoryItems.length,
      snapshotItems: snapshot?.itemCount || 0,
    },
  };
}

// ═══════════════════════════════════════════
// History Rendering
// ═══════════════════════════════════════════

// `authoritative`: the thread's turns are its whole history (a revert reply),
// so the saved rendering is never used in their place, even when none remain.
export function renderHistory(thread, fallbackItems = null, { authoritative = false } = {}) {
  _ctx.flushThreadSnapshotSave(_ctx.boundTab);
  const preservedTokenUsage = thread?.id && _ctx.threadId && thread.id === _ctx.threadId
    ? _ctx.threadTokenUsage
    : null;
  const storedSnapshot = _ctx.getThreadSnapshot(thread?.id || null);
  const historySource = resolveHistoryRenderSource(
    thread,
    fallbackItems,
    authoritative ? null : storedSnapshot,
  );
  _ctx.clearTranscript(historySource.items.length || historySource.snapshot
    ? 'Rendering saved Codex thread…'
    : 'Continue this Codex thread or start a fresh one.');
  if (!thread) return;
  _ctx.setThread(thread);
  console.info('[codex-panel] restore history source', {
    threadId: thread.id,
    selected: historySource.sourceType,
    sdkItems: historySource.counts.sdkItems,
    fallbackItems: historySource.counts.fallbackItems,
    snapshotItems: historySource.counts.snapshotItems,
    snapshotSourceType: historySource.snapshot?.sourceType || '',
  });
  if (historySource.snapshot && _ctx.renderStoredTranscript(historySource.snapshot, 'Continue this Codex thread or start a fresh one.')) {
    _ctx.updateThreadTokenUsage(preservedTokenUsage || historySource.snapshot?.threadTokenUsage || null);
    renderPostPlanActions(_ctx.boundTab);
    renderPostCompactionActions(_ctx.boundTab);
    return;
  }
  if (preservedTokenUsage || storedSnapshot?.threadTokenUsage) {
    _ctx.updateThreadTokenUsage(preservedTokenUsage || storedSnapshot?.threadTokenUsage || null);
  }
  if (!historySource.items.length) {
    _ctx.showEmpty('Continue this Codex thread or start a fresh one.');
    return;
  }
  const historyTurns = new Map((thread.turns || []).flatMap(turn => (turn.items || []).map(item => [item?.id, turn.id])));
  for (const item of historySource.items) {
    updateItemFromData({
      ...item,
      _synabunOwnership: {
        accountId: _ctx.accountId || 'default',
        threadId: thread.id,
        turnId: item.turnId || historyTurns.get(item.id) || '',
        source: 'history',
      },
    });
  }
  // Native items do not include the aggregated shell-edit diff. Retain only
  // locally saved turn-diff text with the same ownership manifest, rebuilding
  // it through the normal renderer after authoritative items have been shown.
  const normalizedSnapshot = _ctx.normalizeThreadSnapshotEntry(storedSnapshot, thread.id, _ctx.accountId || 'default');
  if (normalizedSnapshot?.html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = normalizedSnapshot.html;
    const acceptedItems = new Set(normalizedSnapshot.acceptedItemIds || []);
    const acceptedTurns = new Set(normalizedSnapshot.acceptedTurnIds || []);
    const nativeTurns = new Set((thread.turns || []).map(turn => String(turn.id)));
    for (const saved of tpl.content.querySelectorAll('[data-turn-diff="1"]')) {
      const turnId = saved.dataset.codexTurnId;
      if (!turnId || saved.dataset.codexThreadId !== String(thread.id) || saved.dataset.codexAccountId !== String(_ctx.accountId || 'default')
        || saved.dataset.itemId !== `turn-diff:${turnId}` || !acceptedItems.has(saved.dataset.itemId)
        || !acceptedTurns.has(turnId) || nativeTurns.size && !nativeTurns.has(turnId)) continue;
      const raw = saved.querySelector('.cxp-diff-source')?.textContent;
      if (!raw) continue;
      renderTurnDiff(turnId, raw, { lazy: true });
      const restored = _ctx.items.get(`turn-diff:${turnId}`);
      if (restored && saved.dataset.userCollapsed === '1') { setCardExpanded(restored.el, false); restored.el.dataset.userCollapsed = '1'; }
    }
  }
  _ctx.setTranscriptSourceMeta({
    sourceType: historySource.sourceType,
    itemCount: historySource.items.length,
    sourceUpdatedAt: historySource.sourceUpdatedAt,
  });
  _ctx.hideEmpty();
  _ctx.scrollEnd(true);
  _ctx.flushThreadSnapshotSave(_ctx.boundTab);
  renderPostPlanActions(_ctx.boundTab);
  renderPostCompactionActions(_ctx.boundTab);
}
