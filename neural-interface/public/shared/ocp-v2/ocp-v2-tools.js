// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — tool cards
// One collapsible card per tool call: icon, name, a one-line summary, duration,
// status; the body shows the command / diff / output, truncated, with Copy.
// What a card contains is decided by toolCardView() (ocp-v2-tools-logic.js);
// this file only builds the nodes. Every string that comes from the model or a
// tool goes in through textContent.
// ─────────────────────────────────────────────────────────────────────────────

import { TOOL_ICONS } from './ocp-v2-icons.js';
import { toolCardView } from './ocp-v2-tools-logic.js';

const CHEVRON_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const FALLBACK_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
const TODO_MARKS = { completed: '✓', in_progress: '▸', pending: '○', cancelled: '✕' };

// What the user opened or closed by hand wins over a card's default.
const _expandedByUser = new Map(); // callId → boolean

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function outputSection(section, helpers) {
  // MCP tools answer with content blocks (text + images): those keep their
  // dedicated rendering.
  const blocks = helpers.contentBlocks?.(section.full);
  if (blocks) return blocks;
  const wrap = el('div', 'ocpv2-tool-output');
  const text = el('span', '', section.text);
  wrap.appendChild(text);
  if (section.truncated) {
    const more = el('button', 'ocpv2-tc-more', section.hiddenLines
      ? `Show all (${section.hiddenLines} more line${section.hiddenLines === 1 ? '' : 's'})`
      : 'Show all');
    more.type = 'button';
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      text.textContent = section.full;
      more.remove();
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function diffSectionNode(section) {
  const wrap = el('div', 'ocpv2-tool-output ocpv2-tc-diff');
  for (const line of section.lines) {
    wrap.appendChild(el('div', `ocpv2-diff-line ocpv2-diff-${line.type}`, line.text || ' '));
  }
  if (section.hiddenLines > 0) {
    wrap.appendChild(el('div', 'ocpv2-diff-line ocpv2-diff-meta', `… ${section.hiddenLines} more lines`));
  }
  return wrap;
}

function todosSectionNode(section) {
  const wrap = el('div', 'ocpv2-tool-output ocpv2-tc-todos');
  for (const item of section.items) {
    const row = el('div', `ocpv2-todo-item ocpv2-todo-${item.status}`);
    row.appendChild(el('span', 'ocpv2-todo-mark', TODO_MARKS[item.status] || '○'));
    row.appendChild(el('span', 'ocpv2-todo-text', item.content));
    wrap.appendChild(row);
  }
  return wrap;
}

function attachmentNode(file) {
  const mime = String(file.mime || '');
  if (mime.startsWith('image/') || /^data:image\//.test(file.url)) {
    const wrap = el('div', 'ocpv2-tool-output ocpv2-tool-output-image');
    const img = el('img', 'ocpv2-tool-screenshot');
    img.src = file.url;
    img.alt = file.filename || 'attachment';
    img.loading = 'lazy';
    wrap.appendChild(img);
    return wrap;
  }
  return el('div', 'ocpv2-part ocpv2-part-file', `📎 ${file.filename || 'attachment'}`);
}

/**
 * helpers:
 *   contentBlocks(output)  → a node for MCP content blocks, or null
 *   onOpenChild(sessionId) → open the sub-agent session of a task card
 */
export function renderToolCard(part, helpers = {}) {
  const view = toolCardView(part);
  const callId = part.callID || part.id || `${view.tool}-${part.messageID || ''}`;
  const expanded = _expandedByUser.has(callId) ? _expandedByUser.get(callId) : view.defaultExpanded;

  const wrap = el('div', `ocpv2-part ocpv2-part-tool ocpv2-tool-card${expanded ? ' ocpv2-tool-expanded' : ''}`);
  wrap.dataset.toolId = callId;
  wrap.dataset.status = view.status;
  wrap.dataset.tool = view.tool;

  const head = el('div', 'ocpv2-tool-head ocpv2-tc-head');
  const icon = el('span', 'ocpv2-tc-icon');
  icon.innerHTML = TOOL_ICONS[view.iconKey] || FALLBACK_ICON;
  head.appendChild(icon);
  const titles = el('span', 'ocpv2-tc-titles');
  titles.appendChild(el('span', 'ocpv2-tool-name', view.label));
  if (view.title) {
    const summary = el('span', 'ocpv2-tc-summary', view.title);
    summary.title = view.title;
    titles.appendChild(summary);
  }
  head.appendChild(titles);
  if (view.meta) head.appendChild(el('span', 'ocpv2-tc-meta', view.meta));
  head.appendChild(el('span', `ocpv2-tool-status ocpv2-tool-${view.status}`, view.status));
  const chevron = el('span', 'ocpv2-tc-chevron');
  chevron.innerHTML = CHEVRON_SVG;
  head.appendChild(chevron);
  head.addEventListener('click', () => {
    const next = !wrap.classList.contains('ocpv2-tool-expanded');
    _expandedByUser.set(callId, next);
    wrap.classList.toggle('ocpv2-tool-expanded', next);
  });
  wrap.appendChild(head);

  const body = el('div', 'ocpv2-tc-body');
  for (const section of view.sections) {
    if (section.kind === 'code') {
      body.appendChild(el('div', 'ocpv2-tool-input', section.prompt ? `${section.prompt} ${section.text}` : section.text));
    } else if (section.kind === 'output') {
      body.appendChild(outputSection(section, helpers));
    } else if (section.kind === 'diff') {
      body.appendChild(diffSectionNode(section));
    } else if (section.kind === 'todos') {
      body.appendChild(todosSectionNode(section));
    } else if (section.kind === 'error') {
      body.appendChild(el('div', 'ocpv2-tool-output ocpv2-tool-output-error', section.text));
    }
  }
  for (const file of view.attachments) body.appendChild(attachmentNode(file));

  const actions = el('div', 'ocpv2-tc-actions');
  if (view.copyText) {
    const copy = el('button', 'ocpv2-msg-action', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(view.copyText);
        copy.textContent = 'Copied';
        setTimeout(() => { if (copy.isConnected) copy.textContent = 'Copy'; }, 1200);
      } catch { /* clipboard unavailable */ }
    });
    actions.appendChild(copy);
  }
  if (view.childSessionId && typeof helpers.onOpenChild === 'function') {
    const open = el('button', 'ocpv2-msg-action', 'Open sub-agent');
    open.type = 'button';
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      helpers.onOpenChild(view.childSessionId);
    });
    actions.appendChild(open);
  }
  if (actions.children.length) body.appendChild(actions);

  wrap.appendChild(body);
  return wrap;
}
