// ═══════════════════════════════════════════
// SynaBun Neural Interface — the Copy button of a code block: the page side
// ═══════════════════════════════════════════
//
// One Copy button on every block an agent shows for the user to copy, in the six side panels (Assistant, Claude
// Code, Codex, OpenCode, Antigravity, Maritaca), their detached windows and their worker and sub-agent views. What
// the button is, what a block copies and how it is copied are decided in code-copy.js; this module gives that the
// page:
//
//   installCodeCopy(doc)         the stylesheet and ONE click listener for the whole document (a panel's style
//                                injector calls it, so a detached window gets its own). A button needs nothing
//                                else: one in a stored transcript, drawn by a stream or put back by a re-render
//                                works the moment it is on the page.
//   decorateCodeBlocks(root)     the button on every <pre> under `root` that has none, for a block drawn without
//                                the Markdown renderers (a tool result, an older stored transcript); idempotent,
//                                and it replaces the panels' earlier buttons.
//
// The Markdown renderers write the button into their output (withCodeCopyButtons), so it survives every redraw
// without a timer or an observer. No imports but code-copy.js, and nothing runs at import: `node --test` loads it.

import {
  ANY_CODE_COPY_SELECTOR, CODE_COPY_CLASS, CODE_COPY_FEEDBACK_MS,
  codeBlockText, codeCopyText, setCodeCopyTranslator, writeClipboard,
} from './code-copy.js';

export const CODE_COPY_STYLE_ID = 'sb-code-copy-styles';

// The style guide's tokens (DESIGN.md): the app's text and surface variables with their dark values as fallbacks
// (a panel styles its own scope; a detached window may load styles.css late), JetBrains Mono, the 5px control
// radius, status.success / status.danger for the outcome. The icons are masks, coloured by `currentColor`.
const ICON_COPY = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linejoin='round'%3E%3Crect x='5.5' y='5.5' width='8' height='8' rx='1.5'/%3E%3Cpath d='M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2'/%3E%3C/svg%3E\")";
const ICON_DONE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3.5 7.2 6 9.6l4.6-5.2' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
const ICON_FAILED = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M7 3.5v4.2M7 10.2v.1' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E\")";

export const CODE_COPY_CSS = `
  /* ── The Copy button of a code block (code-copy.js, ui-code-copy.js) ──
     The block keeps a strip of its own above its first line for the button, so the button never covers code,
     at any panel width. A block's code scrolls sideways inside it, so a long line never carries the button away.
     !important: each panel sets its own padding on its <pre>, with selectors of every weight. */
  pre:has(> .${CODE_COPY_CLASS}) { position: relative !important; padding-top: 28px !important; }
  pre:has(> .${CODE_COPY_CLASS}) > code { display: block; overflow-x: auto; }
  pre > button.${CODE_COPY_CLASS} {
    position: absolute; top: 4px; right: 4px; z-index: 1;
    display: inline-flex; align-items: center; gap: 4px;
    box-sizing: border-box; height: 20px; min-width: 20px; margin: 0; padding: 0 6px;
    border: 1px solid transparent; border-radius: 5px;
    background: transparent; box-shadow: none;
    color: var(--t-secondary, rgba(255,255,255,0.5));
    font: 500 10px/1 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.02em; text-transform: none; white-space: nowrap;
    cursor: pointer; user-select: none; -webkit-user-select: none;
    opacity: 0.6;
    transition: opacity 0.15s, color 0.15s, background-color 0.15s, border-color 0.15s;
  }
  pre > button.${CODE_COPY_CLASS}::before {
    content: ''; flex: none; width: 11px; height: 11px; background: currentColor;
    -webkit-mask: ${ICON_COPY} center / contain no-repeat; mask: ${ICON_COPY} center / contain no-repeat;
  }
  pre > button.${CODE_COPY_CLASS}::after { content: attr(data-label); }
  pre:hover > button.${CODE_COPY_CLASS}, pre > button.${CODE_COPY_CLASS}:focus-visible,
  pre > button.${CODE_COPY_CLASS}[data-state] { opacity: 1; }
  pre > button.${CODE_COPY_CLASS}:hover {
    color: var(--t-bright, rgba(255,255,255,0.9));
    background: var(--s-hover, rgba(255,255,255,0.08)); border-color: var(--b-light, rgba(255,255,255,0.10));
  }
  pre > button.${CODE_COPY_CLASS}:focus-visible {
    color: var(--t-bright, rgba(255,255,255,0.9));
    outline: 1px solid var(--b-visible, rgba(255,255,255,0.22)); outline-offset: 1px;
  }
  pre > button.${CODE_COPY_CLASS}[data-state="copied"] { color: #86efac; }
  pre > button.${CODE_COPY_CLASS}[data-state="copied"]::before { -webkit-mask-image: ${ICON_DONE}; mask-image: ${ICON_DONE}; }
  pre > button.${CODE_COPY_CLASS}[data-state="failed"] { color: #fca5a5; }
  pre > button.${CODE_COPY_CLASS}[data-state="failed"]::before { -webkit-mask-image: ${ICON_FAILED}; mask-image: ${ICON_FAILED}; }
  /* A touch screen has no hover: the button is always shown there. */
  @media (hover: none) { pre > button.${CODE_COPY_CLASS} { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { pre > button.${CODE_COPY_CLASS} { transition: none; } }
`;

const installed = new WeakSet();
const timers = new WeakMap();
let askedI18n = false;

const tagOf = (node) => String(node?.localName || node?.nodeName || '').toLowerCase();

/** The shared stylesheet in `doc`, once. */
export function injectCodeCopyStyles(doc = globalThis.document) {
  if (!doc?.createElement || !doc.head || doc.getElementById?.(CODE_COPY_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = CODE_COPY_STYLE_ID;
  style.textContent = CODE_COPY_CSS;
  doc.head.appendChild(style);
}

// The app's locale, read where the app has one. Loaded on demand: i18n.js needs a page, and this module must not.
function askI18n() {
  if (askedI18n || typeof window === 'undefined') return;
  askedI18n = true;
  import('./i18n.js')
    .then(({ t }) => {
      if (typeof t !== 'function') return;
      setCodeCopyTranslator((key, params) => {
        const id = `codeCopy.${key}`;
        const text = t(id, params);
        return text && text !== id ? text : '';
      });
    })
    .catch(() => { /* no i18n here (a detached window before its bundle, a test page): the English */ });
}

/**
 * The Copy buttons of code blocks work in `doc`: the stylesheet and one click listener (capture phase, so the
 * click never reaches a card header or a link under the block). Safe to call any number of times.
 * @returns {boolean} true the first time for this document
 */
export function installCodeCopy(doc = globalThis.document) {
  if (!doc || typeof doc.addEventListener !== 'function' || installed.has(doc)) return false;
  installed.add(doc);
  injectCodeCopyStyles(doc);
  doc.addEventListener('click', onDocumentClick, true);
  askI18n();
  return true;
}

function newButton(doc) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = CODE_COPY_CLASS;
  button.setAttribute('data-label', codeCopyText('copy'));
  button.setAttribute('aria-label', codeCopyText('label'));
  return button;
}

function resetButton(button) {
  const view = button.ownerDocument?.defaultView || globalThis;
  const timer = timers.get(button);
  if (timer) view.clearTimeout(timer);
  timers.delete(button);
  button.removeAttribute('data-state');
  button.setAttribute('data-label', codeCopyText('copy'));
  button.setAttribute('aria-label', codeCopyText('label'));
}

function showOutcome(button, state) {
  const view = button.ownerDocument?.defaultView || globalThis;
  const timer = timers.get(button);
  if (timer) view.clearTimeout(timer);
  button.setAttribute('data-state', state);
  button.setAttribute('data-label', codeCopyText(state));
  button.setAttribute('aria-label', codeCopyText(state === 'copied' ? 'copiedLabel' : 'failedLabel'));
  timers.set(button, view.setTimeout(() => resetButton(button), CODE_COPY_FEEDBACK_MS[state] || 1500));
}

function skipped(pre, skip) {
  if (pre.closest('[data-no-code-copy]')) return true;
  if (typeof skip === 'function') return !!skip(pre);
  return typeof skip === 'string' && skip ? !!pre.closest(skip) : false;
}

/**
 * One Copy button on every <pre> under `root` (and `root` itself when it is one): a block with none gets one, an
 * earlier panel's button is replaced, a second one is removed, and a button a stored transcript kept in its
 * "Copied" state shows "Copy" again. A block matched by `skip` (a selector of an ancestor, or a function of the
 * <pre>) or inside `[data-no-code-copy]` has a copy control of its own and keeps no shared button.
 * @returns {number} the buttons added
 */
export function decorateCodeBlocks(root, { skip = null } = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const doc = root.ownerDocument || globalThis.document;
  const pres = tagOf(root) === 'pre' ? [root, ...root.querySelectorAll('pre')] : [...root.querySelectorAll('pre')];
  let added = 0;
  for (const pre of pres) {
    const buttons = [...pre.children].filter((child) => child.matches?.(ANY_CODE_COPY_SELECTOR));
    if (skipped(pre, skip)) { for (const button of buttons) button.remove(); continue; }
    const keep = buttons.find((button) => button.classList.contains(CODE_COPY_CLASS)) || null;
    for (const button of buttons) if (button !== keep) button.remove();
    if (keep) {
      if (keep.hasAttribute('data-state') && !timers.has(keep)) resetButton(keep);
      continue;
    }
    pre.appendChild(newButton(doc));
    added += 1;
  }
  return added;
}

// The block's text through a hidden textarea and execCommand('copy'): what copies where the Clipboard API is
// missing or refused. Focus goes back where it was (the button, for a keyboard user).
function execCopy(doc, text) {
  if (typeof doc?.execCommand !== 'function' || !doc.body) return false;
  const active = doc.activeElement;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;margin:0;opacity:0;pointer-events:none;';
  doc.body.appendChild(area);
  let ok = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    ok = doc.execCommand('copy') === true;
  } catch { ok = false; }
  area.remove();
  try { active?.focus?.({ preventScroll: true }); } catch { /* the button left the page */ }
  return ok;
}

// Nothing could copy: the block's text is selected, for the keyboard shortcut.
function selectBlock(pre) {
  try {
    const doc = pre.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(pre.querySelector(':scope > code') || pre);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch { /* no selection API */ }
}

/**
 * Copy the block a button belongs to, then say how it went on the button ("Copied", or "Not copied" with the
 * code selected). `clipboard` / `fallback` stand in for the page's in a test.
 * @returns {Promise<'clipboard' | 'fallback' | null>}
 */
export async function copyCodeBlock(button, { clipboard, fallback } = {}) {
  const pre = button?.closest?.('pre');
  if (!pre) return null;
  const doc = button.ownerDocument || globalThis.document;
  const view = doc.defaultView || globalThis;
  const how = await writeClipboard(codeBlockText(pre), {
    clipboard: clipboard === undefined ? view.navigator?.clipboard : clipboard,
    fallback: fallback === undefined ? (text) => execCopy(doc, text) : fallback,
  });
  if (!button.isConnected) return how;
  if (how) showOutcome(button, 'copied');
  else { selectBlock(pre); showOutcome(button, 'failed'); }
  return how;
}

function onDocumentClick(event) {
  const found = event.target?.closest?.(ANY_CODE_COPY_SELECTOR);
  if (!found || tagOf(found.parentElement) !== 'pre') return;
  event.preventDefault();
  event.stopPropagation();
  let button = found;
  if (!found.classList.contains(CODE_COPY_CLASS)) {
    // A button an earlier build stored with the transcript: the shared one takes its place, then copies.
    const hadFocus = found.ownerDocument?.activeElement === found;
    button = newButton(found.ownerDocument);
    found.replaceWith(button);
    if (hadFocus) button.focus({ preventScroll: true });
  }
  copyCodeBlock(button).catch(() => {});
}
