// ═══════════════════════════════════════════
// SynaBun Neural Interface — Utilities
// ═══════════════════════════════════════════
// Shared helper functions used across UI components.

import { t, getLocale } from './i18n.js';

// ─── Data Normalization ─────────────────

/**
 * Ensure every node has a valid payload.category.
 * Nodes with null/undefined/empty category get 'uncategorized'.
 * Mutates in place and returns the array for chaining.
 * @param {Array} nodes
 * @returns {Array}
 */
export function normalizeNodes(nodes) {
  for (const n of nodes) {
    if (n.payload && !n.payload.category) {
      n.payload.category = 'uncategorized';
    }
  }
  return nodes;
}

// ─── String Utilities ────────────────────

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated.
 * @param {string} str
 * @param {number} len
 * @returns {string}
 */
export function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

/**
 * Escape HTML entities using a DOM element for safety.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Date / Time Formatting ──────────────

/**
 * Format a relative time string from an ISO date (e.g. "5m ago", "3 days ago").
 * Used by the trash panel to show when items were trashed.
 * @param {string} isoDate
 * @returns {string}
 */
export function formatTrashAge(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minutesAgo', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t('time.dayAgo');
  if (days < 30) return t('time.daysAgo', { n: days });
  const months = Math.floor(days / 30);
  return months === 1 ? t('time.monthAgo') : t('time.monthsAgo', { n: months });
}

// ─── Content Formatting ─────────────────

/**
 * Convert markdown-like memory content into styled HTML.
 *
 * Supports:
 * - Headings (## / ### / ####)
 * - Code blocks (```)
 * - Lists (- / * / numbered)
 * - Bold (**text**), italic (*text*), inline code (`code`)
 * - Em-dash description splits ( — description)
 * - Key: Value patterns (label followed by 2+ spaces then value)
 * - Heading-like lines ending with colon
 * - Separator lines (---, ===, ___)
 *
 * @param {string} text — raw memory content
 * @returns {string} — formatted HTML string
 */
export function formatMemoryContent(text) {
  if (!text) return '';

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Inline formatting: `code`, **bold**, *italic*, em-dash descriptions
  function inlineFmt(s) {
    let out = esc(s);
    // Backtick code spans
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    // Em-dash description split (` — ` becomes dimmed after)
    out = out.replace(/ — (.+)$/, ' <span class="kv-desc">\u2014 $1</span>');
    return out;
  }

  const lines = text.split('\n');
  let html = '';
  let inList = false;
  let inCode = false;

  function closeList() { if (inList) { html += '</ul>'; inList = false; } }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Empty line
    if (!trimmed) {
      if (inCode) { html += '\n'; continue; }
      closeList();
      continue;
    }

    // Code block fences
    if (trimmed.startsWith('```')) {
      if (inCode) { html += '</div>'; inCode = false; }
      else { closeList(); inCode = true; html += '<div class="mc-codeblock">'; }
      continue;
    }
    if (inCode) { html += esc(raw) + '\n'; continue; }

    // Markdown headings ## / ### / ####
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const cls = level <= 2 ? 'mc-h2' : level === 3 ? 'mc-h3' : 'mc-h4';
      html += `<div class="${cls}">${inlineFmt(headingMatch[2])}</div>`;
      continue;
    }

    // Separator lines
    if (/^[-=_]{3,}$/.test(trimmed)) {
      closeList();
      html += '<div class="mc-divider"></div>';
      continue;
    }

    // Standalone backtick line (full line is a code key pattern)
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && !trimmed.includes(' ')) {
      closeList();
      html += `<p>${inlineFmt(trimmed)}</p>`;
      continue;
    }

    // Backtick line followed by em-dash description
    if (/^`[^`]+`\s+—\s+/.test(trimmed)) {
      closeList();
      html += `<p>${inlineFmt(trimmed)}</p>`;
      continue;
    }

    // List items (- or * or numbered)
    if (/^[-*\u2022]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
      if (!inList) { html += '<ul>'; inList = true; }
      const content = trimmed.replace(/^[-*\u2022]\s+/, '').replace(/^\d+[.)]\s+/, '');
      html += `<li>${inlineFmt(content)}</li>`;
      continue;
    }

    // Heading-like: short line ending with colon (not containing backticks — those are code patterns)
    if (trimmed.endsWith(':') && trimmed.length < 50 && !trimmed.includes('`') && !/\s{2,}/.test(trimmed)) {
      closeList();
      html += `<div class="mc-h3">${inlineFmt(trimmed.slice(0, -1))}</div>`;
      continue;
    }

    // Key: Value (label < 25 chars, then colon + space + value)
    const kvMatch = trimmed.match(/^([A-Za-z][\w\s/().,-]{0,24}?)\s{2,}(.+)$/);
    if (kvMatch) {
      closeList();
      html += `<div class="mc-kv"><span class="mc-kv-key">${esc(kvMatch[1])}</span> <span class="mc-kv-val">${inlineFmt(kvMatch[2])}</span></div>`;
      continue;
    }

    // Regular paragraph
    closeList();
    html += `<p>${inlineFmt(trimmed)}</p>`;
  }

  closeList();
  if (inCode) html += '</div>';
  return html;
}

// ─── Export ──────────────────────────────

/**
 * Convert a memory node to markdown and trigger a file download.
 * @param {{ id: string, payload: Object }} node — graph node with payload
 */
export function exportMemoryAsMarkdown(node) {
  const p = node.payload;
  const lines = [];

  // Title — first meaningful line of content, or category
  const firstLine = (p.content || '').split('\n').find(l => l.trim()) || p.category || 'Memory';
  const title = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
  lines.push(`# ${title}`);
  lines.push('');

  // Metadata table
  const dateFmt = { month: 'short', day: 'numeric', year: 'numeric' };
  const locale = getLocale();
  lines.push(`| ${t('export.fieldLabel')} | ${t('export.valueLabel')} |`);
  lines.push('|-------|-------|');
  lines.push(`| ${t('export.categoryLabel')} | ${p.category}${p.subcategory ? ' / ' + p.subcategory : ''} |`);
  lines.push(`| ${t('export.importanceLabel')} | ${p.importance || 5}/10 |`);
  if (p.project) lines.push(`| ${t('export.projectLabel')} | ${p.project} |`);
  if (p.source) lines.push(`| ${t('export.sourceLabel')} | ${p.source} |`);
  if (p.created_at) lines.push(`| ${t('export.createdLabel')} | ${new Date(p.created_at).toLocaleDateString(locale, dateFmt)} |`);
  if (p.updated_at) lines.push(`| ${t('export.updatedLabel')} | ${new Date(p.updated_at).toLocaleDateString(locale, dateFmt)} |`);
  lines.push(`| ${t('export.idLabel')} | \`${node.id}\` |`);
  lines.push('');

  // Tags
  const tags = (p.tags && Array.isArray(p.tags) && p.tags.length) ? p.tags : null;
  if (tags) {
    lines.push(`**${t('export.tagsLabel')}** ${tags.map(tg => '`' + tg + '`').join(' ')}`);
    lines.push('');
  }

  // Content
  lines.push(`## ${t('export.contentHeading')}`);
  lines.push('');
  lines.push(p.content || t('export.emptyContent'));
  lines.push('');

  // Related files
  if (p.related_files && p.related_files.length) {
    lines.push(`## ${t('export.relatedFilesHeading')}`);
    lines.push('');
    p.related_files.forEach(f => lines.push(`- \`${f}\``));
    lines.push('');
  }

  const md = lines.join('\n');

  // Build filename from category + truncated content
  const slug = (p.category + (p.subcategory ? '-' + p.subcategory : '')).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  const contentSlug = (p.content || 'memory').split('\n')[0].trim().slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
  const filename = `${slug}--${contentSlug || 'memory'}.md`;

  // Trigger download
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
