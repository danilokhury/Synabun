// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: Markdown preview
// ═══════════════════════════════════════════
//
// Markdown → the HTML the editor's Preview shows. The text is a file from disk,
// so it is untrusted: every character that means something in HTML is escaped
// before any tag is written, and the only attribute that carries a value from
// the text, a link's href, is limited to http:, https:, mailto: and relative
// targets. No DOM and no imports: loaded by `node --test` as it is.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " ' as HTML entities: safe as element content and inside a quoted attribute. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// What a browser drops or ignores when it reads a URL's scheme: C0 controls, spaces of every kind, and the
// invisible format characters. Without them "java\tscript:" is seen for what it is.
const URL_NOISE = /[\u0000-\u0020\u007F-\u00A0\u1680\u2000-\u200F\u2028-\u202F\u205F-\u2064\u3000\uFEFF]/g;
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * A link target that is safe to open, or null. Relative targets (a path, `#anchor`, `?query`, `//host/path`)
 * pass; a target with a scheme passes only for http, https and mailto.
 * @param {string} target as written in the Markdown, or already HTML-escaped (escaping adds no scheme)
 */
export function safeLinkTarget(target) {
  const raw = String(target ?? '').trim();
  if (!raw) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw.replace(URL_NOISE, ''));
  if (scheme && !ALLOWED_SCHEMES.has(scheme[1].toLowerCase())) return null;
  return raw;
}

const HOLD = '\u0000';

/**
 * Render Markdown for the Preview pane: headings, emphasis, inline and fenced code, links, block quotes,
 * tables, lists and paragraphs. Front matter is left out. Raw HTML in the text is shown as text.
 * @returns {string} HTML
 */
export function renderMarkdown(markdown) {
  let text = String(markdown ?? '').replace(/\r\n?/g, '\n').split(HOLD).join('');
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  text = escapeHtml(text);

  // Code and links are set aside while the rest is formatted, so nothing inside them is read as Markdown and
  // nothing is formatted into an attribute.
  const held = [];
  const hold = (html) => `${HOLD}${held.push(html) - 1}${HOLD}`;
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => hold(`<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (whole, label, target) => {
    if (target.includes(HOLD)) return whole;
    const href = safeLinkTarget(target);
    return href === null ? label : `${hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">`)}${label}${hold('</a>')}`;
  });

  text = text.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  text = text.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  text = text.replace(/^---+$/gm, '<hr>');
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  text = text.replace(/<\/blockquote>\n<blockquote>/g, '\n');
  text = text.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, _sep, body) => {
    const ths = header.split('|').filter((c) => c.trim()).map((c) => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map((row) => {
      const tds = row.split('|').filter((c) => c.trim()).map((c) => `<td>${c.trim()}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });
  text = text.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  text = text.replace(/^\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
  text = text.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (match) => `<ol>${match.replace(/<\/?oli>/g, (tag) => tag.replace('oli', 'li'))}</ol>`);
  // A line that does not start with a tag (or with code or a link, which are held) becomes a paragraph.
  text = text.replace(/^(?![<\u0000])(.+)$/gm, '<p>$1</p>');
  text = text.replace(/<p>\s*<\/p>/g, '');

  return text.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_, i) => held[Number(i)]);
}
