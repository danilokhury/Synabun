// ═══════════════════════════════════════════
// SynaBun Neural Interface — the Copy button of a code block: the decisions
// ═══════════════════════════════════════════
//
// Every block an agent shows for the user to copy (a fenced code block, any <pre> of a reply, a plan or a tool
// result) carries one Copy button, in all six side panels (Assistant, Claude Code, Codex, OpenCode, Antigravity,
// Maritaca). This module is what they share and what can be decided without a page: the words, the button's
// markup (put into a panel's sanitised Markdown, so a stream, a re-render, a stored transcript and a string-keyed
// transcript all keep it), the text a block copies, and the copy with its fallback. ui-code-copy.js gives it the
// page: the stylesheet, the one click listener per document, and the button on a block drawn some other way.
//
// The button holds no text: its label is drawn by CSS from `data-label`, its name is `aria-label`. So a block's
// textContent is its code and nothing else, whoever reads it (a panel's own copy of a whole answer, Codex's
// output cleaner, a text selection).
//
// No imports and no `document`: loaded by `node --test` as it is, and by the Markdown renderers.

/** The English of `codeCopy.*` in i18n/en.json (tests/code-copy.test.mjs keeps them equal). */
export const CODE_COPY_COPY = Object.freeze({
  copy: 'Copy',
  copied: 'Copied',
  failed: 'Not copied',
  label: 'Copy code',
  copiedLabel: 'Code copied',
  failedLabel: 'Could not copy. The code is selected: press Ctrl+C or ⌘C.',
});

/** The class of the button. The Claude, Codex and OpenCode panels had buttons of their own before: see LEGACY. */
export const CODE_COPY_CLASS = 'sb-code-copy';

/** The panels' earlier buttons, still in stored transcripts: replaced by the shared one, and working until then. */
export const LEGACY_CODE_COPY_SELECTOR = '.cp-copy-btn, .cxp-copy-btn, .ocpv2-code-copy';

/** Any Copy button of a code block, the shared one or an earlier one. */
export const ANY_CODE_COPY_SELECTOR = `.${CODE_COPY_CLASS}, ${LEGACY_CODE_COPY_SELECTOR}`;

/** How long "Copied" (and the failure) stays on the button. */
export const CODE_COPY_FEEDBACK_MS = Object.freeze({ copied: 1500, failed: 4000 });

let translate = null;

/**
 * Where a sentence comes from in the active locale: `fn(key, params)` returns it, or a falsy value for the English.
 * Set by ui-code-copy.js once the app's i18n is there; a detached window or a test keeps the English.
 */
export function setCodeCopyTranslator(fn) { translate = typeof fn === 'function' ? fn : null; }

/** A `codeCopy.*` sentence in the active locale, else the English. */
export function codeCopyText(key, params = {}) {
  let text = '';
  try { text = translate?.(key, params) || ''; } catch { text = ''; }
  if (!text || typeof text !== 'string') text = CODE_COPY_COPY[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? String(params[name]) : whole));
}

const escAttr = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The button as markup: no text inside, the label in `data-label` (drawn by CSS) and the name in `aria-label`. */
export function codeCopyButtonHtml() {
  return `<button type="button" class="${CODE_COPY_CLASS}" data-label="${escAttr(codeCopyText('copy'))}" aria-label="${escAttr(codeCopyText('label'))}"></button>`;
}

// A shared button already written before a closing tag, to be written again: the result is the same however often
// it runs. In a serialised (sanitised) document `</pre>` is only ever a closing tag: the same text inside a block
// is `&lt;/pre&gt;`.
const BUTTON_BEFORE_CLOSE_RE = new RegExp(`(?:<button type="button" class="${CODE_COPY_CLASS}"[^>]*></button>)?</pre>`, 'gi');

/**
 * Sanitised HTML with one Copy button at the end of every <pre>. Run it on the sanitiser's output, never before:
 * the allowlist takes buttons out of what a model writes, so a reply cannot forge one.
 */
export function withCodeCopyButtons(html) {
  const source = typeof html === 'string' ? html : '';
  if (!/<\/pre>/i.test(source)) return source;
  const button = codeCopyButtonHtml();
  return source.replace(BUTTON_BEFORE_CLOSE_RE, `${button}</pre>`);
}

const tagOf = (node) => String(node?.localName || node?.nodeName || '').toLowerCase();

/**
 * The text a block copies: everything it shows, newlines and indentation as written, without a button's label,
 * and without the one line break a code block ends with (marked writes the code with a trailing "\n"; pasted into
 * a terminal that would run the command).
 */
export function codeBlockText(pre) {
  if (!pre) return '';
  let out = '';
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3 || child.nodeType === 4) { out += child.data ?? child.nodeValue ?? ''; continue; }
      if (child.nodeType !== 1) continue;
      const tag = tagOf(child);
      if (tag === 'button') continue;
      if (tag === 'br') { out += '\n'; continue; }
      walk(child);
    }
  };
  walk(pre);
  return out.replace(/\r?\n$/, '');
}

/**
 * Put `text` on the clipboard: the Clipboard API first, then `fallback(text)` (the page's `execCommand('copy')`)
 * when the API is missing (a page that is not a secure context) or refuses (a frame without the permission).
 * @returns {Promise<'clipboard' | 'fallback' | null>} how it was copied, or null when nothing could copy it
 */
export async function writeClipboard(text, { clipboard = globalThis.navigator?.clipboard, fallback = null } = {}) {
  const value = String(text ?? '');
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return 'clipboard';
    } catch { /* refused: the fallback below */ }
  }
  if (typeof fallback === 'function') {
    try { if (fallback(value) === true) return 'fallback'; } catch { /* nothing copied */ }
  }
  return null;
}
