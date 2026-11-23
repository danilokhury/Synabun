// ═══════════════════════════════════════════
// SynaBun Neural Interface — an agent's answer as a readable document: the page side
// ═══════════════════════════════════════════
//
// One reading layer for the six side panels (Assistant, Claude Code, Codex, OpenCode, Antigravity, Maritaca),
// their detached windows and their worker and sub-agent views. What is added to a panel's Markdown is decided in
// output-format.js; this module gives that the page:
//
//   installOutput(doc)       the stylesheet and ONE click listener for the whole document (a panel's style
//                            injector calls it, next to installCodeCopy). A table's buttons need nothing else:
//                            one in a stored transcript, drawn by a stream or put back by a re-render works the
//                            moment it is on the page.
//   decorateOutput(root)     the same frames on Markdown drawn as nodes (the Assistant's sanitizeInto) or put
//                            back from an older stored transcript; idempotent.
//
// THE STYLESHEET IS THE PANELS' ONE PROSE SYSTEM. Headings, paragraphs, lists, quotes, links, inline code, code
// blocks, tables, rules and images of an answer are styled here and nowhere else; a panel keeps its identity by
// setting the `--sbo-*` properties on its own Markdown element (the block "A panel's own voice" below), never by
// styling a tag again. PROSE_SCOPES lists those elements: a new place that shows an agent's Markdown is added
// there (or carries the class `sb-output`).
//
// No imports but output-format.js and code-copy.js (the clipboard), and nothing runs at import: `node --test`
// loads it.

import {
  LONG_CLASS, NUMERIC_CLASS, OUTPUT_FEEDBACK_MS, TABLE_BUTTON_CLASS, TABLE_FRAME_CLASS, TABLE_SCROLL_CLASS, TABLE_TOOLS_CLASS, TASK_CLASS,
  diffLineClass, longColumns, matrixToHtml, matrixToTsv, numericColumns, outputText, setOutputTranslator, tableMatrix,
} from './output-format.js';
import { writeClipboard } from './code-copy.js';

export const OUTPUT_STYLE_ID = 'sb-output-styles';

/** The element of each panel that holds an agent's Markdown. `.sb-output` is for anything else (the wider table). */
export const PROSE_SCOPES = Object.freeze([
  '.asst-md',
  '.cp-messages .msg-body',
  '.cxp-msg-assistant .cxp-msg-body',
  '.cxp-plan-card .cxp-msg-body',
  '.ocpv2-part-text',
  '.ocpv2-reasoning-body',
  '.agy-md',
  '.mtc-md',
  '.sb-output',
]);

const S = `:is(${PROSE_SCOPES.join(', ')})`;
const W = `:where(${PROSE_SCOPES.join(', ')})`;

const ICON_COPY = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linejoin='round'%3E%3Crect x='5.5' y='5.5' width='8' height='8' rx='1.5'/%3E%3Cpath d='M3 10.5V4a1 1 0 0 1 1-1h6.5'/%3E%3C/svg%3E\")";
const ICON_EXPAND = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9.5 3H13v3.5M13 3 9 7M6.5 13H3V9.5M3 13l4-4'/%3E%3C/svg%3E\")";
const ICON_CLOSE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='round'%3E%3Cpath d='m4 4 8 8M12 4l-8 8'/%3E%3C/svg%3E\")";
const ICON_DONE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3.5 7.2 6 9.6l4.6-5.2' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
const ICON_FAILED = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M7 3.5v4.2M7 10.2v.1' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E\")";

// The style guide's tokens (DESIGN.md): the app's text, surface and border variables with their dark values as
// fallbacks (a detached window may load styles.css late), body 13px, code and tables 12px, JetBrains Mono, the
// 8px card radius, the code-diff surface and its add / remove colours, status.success / status.danger.
export const OUTPUT_CSS = `
  @property --sbo-edge { syntax: '<length>'; inherits: false; initial-value: 0px; }
  @keyframes sbo-edge { from { --sbo-edge: 32px; } 96% { --sbo-edge: 32px; } to { --sbo-edge: 0px; } }
  /* ── An agent's answer as a readable document (output-format.js, ui-output.js) ── */

  /* The system's values. A panel changes one by setting it on its own Markdown element (below), not here. */
  ${W} {
    --sbo-size: 13px;
    --sbo-leading: 1.6;
    --sbo-text: var(--t-bright, rgba(255,255,255,0.9));
    --sbo-text-2: var(--t-primary, rgba(255,255,255,0.7));
    --sbo-strong: #fff;
    --sbo-muted: rgba(255,255,255,0.55);
    --sbo-line: var(--b-light, rgba(255,255,255,0.10));
    --sbo-line-strong: var(--b-visible, rgba(255,255,255,0.22));
    --sbo-surface: var(--s-subtle, rgba(255,255,255,0.04));
    --sbo-surface-2: var(--s-hover, rgba(255,255,255,0.08));
    --sbo-code-bg: rgba(0,0,0,0.25);
    --sbo-code-size: 12px;
    --sbo-table-size: 12px;
    --sbo-pre-wrap: pre;
    --sbo-link: var(--t-bright, rgba(255,255,255,0.9));
    --sbo-focus: rgba(255,255,255,0.7);
    --sbo-radius: var(--r-card, 8px);
    --sbo-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  }

  /* A panel's own voice: its size, its link colour, whether its code wraps. Nothing else differs. */
  .asst-md { --sbo-size: 14px; --sbo-code-size: 12.5px; --sbo-table-size: 12.5px; --sbo-text: var(--asst-text, rgba(255,255,255,0.9)); --sbo-text-2: var(--asst-text-2, rgba(255,255,255,0.64)); --sbo-line: var(--asst-line, rgba(255,255,255,0.10)); --sbo-link: var(--asst-focus, #ffd700); --sbo-focus: var(--asst-focus, #ffd700); --sbo-mono: var(--asst-mono, 'JetBrains Mono', ui-monospace, monospace); }
  .cxp-msg-body { --sbo-text: var(--cxp-text, rgba(255,255,255,0.9)); --sbo-link: var(--cxp-link, #9dc3ff); --sbo-pre-wrap: pre-wrap; --sbo-mono: var(--cxp-mono, 'JetBrains Mono', ui-monospace, monospace); }
  .ocpv2-part-text, .ocpv2-reasoning-body { --sbo-size: 12.5px; --sbo-leading: 1.55; --sbo-code-size: 12px; --sbo-text: rgba(255,255,255,0.86); --sbo-link: rgba(151,214,255,0.92); --sbo-pre-wrap: pre-wrap; }
  .ocpv2-reasoning-body { --sbo-size: 12px; --sbo-text: rgba(255,255,255,0.72); }
  .mtc-md { --sbo-size: calc(13px * var(--font-scale, 1)); --sbo-code-size: calc(12px * var(--font-scale, 1)); --sbo-table-size: calc(12px * var(--font-scale, 1)); }

  /* Text */
  ${S} { font-size: var(--sbo-size); line-height: var(--sbo-leading); color: var(--sbo-text); overflow-wrap: break-word; word-break: normal; min-width: 0; }
  ${S} > :first-child { margin-top: 0; }
  ${S} > :last-child { margin-bottom: 0; }
  /* Codex draws an answer inside a holder of its own. */
  ${S} > :is(.cxp-msg-rendered, .cxp-msg-verbose-body) > :first-child { margin-top: 0; }
  ${S} > :is(.cxp-msg-rendered, .cxp-msg-verbose-body) > :last-child { margin-bottom: 0; }
  ${S} p { margin: 0 0 0.75em; }
  ${S} :is(h1, h2, h3, h4, h5, h6) { margin: 1.5em 0 0.5em; padding: 0; border: 0; color: var(--sbo-strong); font-weight: 600; line-height: 1.3; letter-spacing: 0; text-transform: none; opacity: 1; }
  ${S} h1 { font-size: 1.38em; }
  ${S} h2 { font-size: 1.23em; }
  ${S} h3 { font-size: 1.08em; }
  ${S} :is(h4, h5, h6) { font-size: 1em; }
  ${S} :is(h5, h6) { color: var(--sbo-text); }
  ${S} h6 { font-weight: 500; color: var(--sbo-text-2); }
  ${S} :is(h1, h2, h3, h4, h5, h6) + * { margin-top: 0; }
  ${S} strong { font-weight: 600; color: var(--sbo-strong); }
  ${S} em { font-style: italic; color: inherit; }
  ${S} del { opacity: 0.6; }

  /* Lists: the browser's own markers, one indent, a task item without a bullet beside its box */
  ${S} :is(ul, ol) { margin: 0 0 0.75em; padding: 0 0 0 1.5em; list-style-position: outside; }
  ${S} ul { list-style-type: disc; }
  ${S} ul ul { list-style-type: circle; }
  ${S} ol { list-style-type: decimal; }
  ${S} li { margin: 0.25em 0; padding: 0; }
  ${S} li::before { content: none; }
  ${S} li::marker { color: var(--sbo-muted); font-size: 1em; }
  ${S} li > :is(ul, ol) { margin: 0.25em 0 0; }
  ${S} li > p { margin: 0 0 0.4em; }
  ${S} li > p:last-child { margin-bottom: 0; }
  ${S} li.${TASK_CLASS} { list-style: none; margin-left: -1.5em; padding-left: 1.5em; text-indent: -1.5em; }
  ${S} li.${TASK_CLASS} > * { text-indent: 0; }
  ${S} li.${TASK_CLASS} > p:first-child { text-indent: -1.5em; }
  ${S} .${TASK_CLASS}-box { display: inline-block; width: 1.5em; text-indent: 0; color: var(--sbo-muted); }
  ${S} .${TASK_CLASS}-done .${TASK_CLASS}-box { color: #86efac; }

  /* Quotes, links, rules, images */
  ${S} blockquote { margin: 0 0 0.75em; padding: 0.1em 0 0.1em 0.9em; border: 0; border-left: 2px solid var(--sbo-line-strong); background: none; color: var(--sbo-text-2); font-style: normal; }
  ${S} blockquote > :last-child { margin-bottom: 0; }
  ${S} a { color: var(--sbo-link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); cursor: pointer; }
  ${S} a:hover { text-decoration-color: currentColor; }
  ${S} a:focus-visible { outline: 2px solid var(--sbo-focus); outline-offset: 2px; border-radius: 2px; }
  ${S} hr { height: 0; margin: 1.25em 0; border: 0; border-top: 1px solid var(--sbo-line); background: none; }
  ${S} img { max-width: 100%; height: auto; border-radius: 6px; }

  /* Code: inline, and a block (its Copy button's strip is ui-code-copy.js's) */
  ${S} code { font-family: var(--sbo-mono); font-size: 0.9em; }
  ${S} :not(pre) > code { padding: 0.1em 0.35em; border: 0; border-radius: 4px; background: var(--sbo-surface-2); color: var(--sbo-strong); overflow-wrap: anywhere; }
  ${S} pre { margin: 0 0 0.9em; padding: 10px 12px; border: 1px solid var(--sbo-line); border-radius: var(--sbo-radius); background: var(--sbo-code-bg); color: var(--sbo-text); font-family: var(--sbo-mono); font-size: var(--sbo-code-size); line-height: 1.55; white-space: var(--sbo-pre-wrap); overflow-wrap: normal; word-break: normal; overflow-x: auto; tab-size: 2; }
  ${S} pre code { padding: 0; border: 0; border-radius: 0; background: none; color: inherit; font-size: inherit; line-height: inherit; white-space: inherit; }
  ${S} pre[data-lang]:has(> .sb-code-copy)::before { content: attr(data-lang); position: absolute; top: 8px; left: 12px; color: var(--sbo-muted); font: 500 10px/1.2 var(--sbo-mono); letter-spacing: 0.02em; pointer-events: none; }
  ${S} .sb-diff-add { color: #9fe3b4; background: rgba(95,207,131,0.10); }
  ${S} .sb-diff-del { color: #f0a3a3; background: rgba(239,112,112,0.10); }
  ${S} .sb-diff-hunk { color: var(--sbo-muted); }
  ${S} .sb-diff-file { color: var(--sbo-text-2); font-weight: 500; }

  /* Tables: a frame. The table fills it and wraps at words to fit; a column never gets narrower than its longest
     word (or, for a column of sentences, a readable line), so a table too wide for the panel scrolls sideways
     inside the frame instead of breaking words letter by letter. */
  ${S} .${TABLE_FRAME_CLASS} { position: relative; margin: 0 0 0.9em; border: 1px solid var(--sbo-line); border-radius: var(--sbo-radius); background: var(--sbo-code-bg); overflow: hidden; }
  ${S} > .${TABLE_FRAME_CLASS}:last-child { margin-bottom: 0; }
  ${S} > :is(.cxp-msg-rendered, .cxp-msg-verbose-body) > .${TABLE_FRAME_CLASS}:last-child { margin-bottom: 0; }
  ${S} .${TABLE_SCROLL_CLASS} { overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; scrollbar-color: var(--sbo-line-strong) transparent; }
  ${S} .${TABLE_SCROLL_CLASS}:focus-visible { outline: 2px solid var(--sbo-focus); outline-offset: -2px; }
  /* More columns to the right: the frame's right edge fades until the table is scrolled to its end. The scroll
     position drives it (no script, no motion); a table that fits has no scroll timeline and no fade. */
  @supports (animation-timeline: scroll()) {
    .${TABLE_SCROLL_CLASS} { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - var(--sbo-edge)), transparent); mask-image: linear-gradient(to right, #000 calc(100% - var(--sbo-edge)), transparent); animation: sbo-edge linear both; animation-timeline: scroll(self inline); }
  }
  ${S} table { display: table; table-layout: auto; width: 100%; min-width: 0; max-width: none; margin: 0; border: 0; border-collapse: collapse; border-spacing: 0; overflow: visible; font-size: var(--sbo-table-size); line-height: 1.45; }
  ${S} :is(thead, tbody, tr) { background: none; border: 0; }
  ${S} :is(th, td) { min-width: 3em; max-width: 44ch; padding: 6px 8px; border: 0; border-top: 1px solid var(--sbo-line); background: none; color: var(--sbo-text); font-weight: 400; vertical-align: top; white-space: normal; overflow-wrap: break-word; word-break: normal; }
  ${S} :is(th, td):not([align]) { text-align: start; }
  ${S} th { color: var(--sbo-strong); font-weight: 600; background: var(--sbo-surface); }
  ${S} tbody tr:hover > td { background: var(--sbo-surface); }
  ${S} :is(th, td):is(.${NUMERIC_CLASS}, [align="right"]) { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  ${S} :is(th, td)[align="center"] { text-align: center; }
  /* In a table of four columns or more, a column of sentences keeps a readable line (the table then scrolls);
     with fewer columns the panel's width is shared and nothing needs to scroll. */
  ${S} .${TABLE_FRAME_CLASS}:has(tr > :nth-child(4)) :is(th, td).${LONG_CLASS} { min-width: 22ch; }
  /* Code in a cell wraps where a path or a name can (after "/", "-", a space) and never inside a word: the column
     keeps the width of its longest piece (inline code elsewhere breaks anywhere, which a column would shrink to). */
  ${S} :is(th, td) code { white-space: normal; overflow-wrap: break-word; }
  /* A bare table (one a stored transcript kept from before the frame) still scrolls instead of breaking words. */
  ${S} > table { display: block; width: auto; min-width: 0; max-width: 100%; overflow-x: auto; margin: 0 0 0.9em; }

  /* The strip above a table, like a code block's: Copy always, Expand and the size for a table worth it */
  .${TABLE_TOOLS_CLASS} { display: flex; align-items: center; justify-content: flex-end; gap: 2px; box-sizing: border-box; height: 28px; padding: 0 4px; }
  .${TABLE_TOOLS_CLASS}::before { content: attr(data-label); flex: 1 1 auto; min-width: 0; padding-left: 8px; overflow: hidden; color: var(--sbo-muted, rgba(255,255,255,0.55)); font: 500 10px/1.2 var(--sbo-mono, 'JetBrains Mono', ui-monospace, monospace); letter-spacing: 0.02em; text-overflow: ellipsis; white-space: nowrap; visibility: hidden; }
  .${TABLE_FRAME_CLASS}:has(tr > :nth-child(5), tr:nth-child(8)) > .${TABLE_TOOLS_CLASS}::before { visibility: visible; }
  /* Expand is also the keyboard's way to every column where a browser does not focus a scrolling area by itself,
     so every table that can scroll sideways has it: five columns, eight rows, or four with a column of sentences. */
  .${TABLE_FRAME_CLASS}:not(:has(tr > :nth-child(5), tr:nth-child(8), tr > .${LONG_CLASS}:nth-child(4), tr > .${LONG_CLASS} ~ :nth-child(4))) > .${TABLE_TOOLS_CLASS} > [data-sb-act="expand"] { display: none; }
  button.${TABLE_BUTTON_CLASS} {
    flex: none; display: inline-flex; align-items: center; gap: 4px;
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
  button.${TABLE_BUTTON_CLASS}::before { content: ''; flex: none; width: 11px; height: 11px; background: currentColor; -webkit-mask: ${ICON_COPY} center / contain no-repeat; mask: ${ICON_COPY} center / contain no-repeat; }
  button.${TABLE_BUTTON_CLASS}[data-sb-act="expand"]::before { -webkit-mask-image: ${ICON_EXPAND}; mask-image: ${ICON_EXPAND}; }
  button.${TABLE_BUTTON_CLASS}[data-sb-act="close"]::before { -webkit-mask-image: ${ICON_CLOSE}; mask-image: ${ICON_CLOSE}; }
  button.${TABLE_BUTTON_CLASS}::after { content: attr(data-label); }
  .${TABLE_FRAME_CLASS}:hover button.${TABLE_BUTTON_CLASS}, button.${TABLE_BUTTON_CLASS}:focus-visible, button.${TABLE_BUTTON_CLASS}[data-state], .sb-table-dialog button.${TABLE_BUTTON_CLASS} { opacity: 1; }
  button.${TABLE_BUTTON_CLASS}:hover { color: var(--t-bright, rgba(255,255,255,0.9)); background: var(--s-hover, rgba(255,255,255,0.08)); border-color: var(--b-light, rgba(255,255,255,0.10)); }
  button.${TABLE_BUTTON_CLASS}:focus-visible { color: var(--t-bright, rgba(255,255,255,0.9)); outline: 1px solid var(--b-visible, rgba(255,255,255,0.22)); outline-offset: 1px; }
  button.${TABLE_BUTTON_CLASS}[data-state="copied"] { color: #86efac; }
  button.${TABLE_BUTTON_CLASS}[data-state="copied"]::before { -webkit-mask-image: ${ICON_DONE}; mask-image: ${ICON_DONE}; }
  button.${TABLE_BUTTON_CLASS}[data-state="failed"] { color: #fca5a5; }
  button.${TABLE_BUTTON_CLASS}[data-state="failed"]::before { -webkit-mask-image: ${ICON_FAILED}; mask-image: ${ICON_FAILED}; }
  @media (hover: none) { button.${TABLE_BUTTON_CLASS} { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { button.${TABLE_BUTTON_CLASS} { transition: none; } }

  /* The wider view of a table: the whole window's width, its header in sight while its rows scroll */
  dialog.sb-table-dialog { box-sizing: border-box; width: fit-content; min-width: min(420px, calc(100vw - 48px)); max-width: min(1180px, calc(100vw - 48px)); max-height: calc(100vh - 48px); margin: auto; padding: 0; border: 1px solid var(--b-light, rgba(255,255,255,0.10)); border-radius: 10px; background: #1c1c1e; color: var(--t-bright, rgba(255,255,255,0.9)); box-shadow: 0 24px 64px rgba(0,0,0,0.5); font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
  dialog.sb-table-dialog[open] { display: flex; flex-direction: column; }
  dialog.sb-table-dialog::backdrop { background: rgba(0,0,0,0.55); }
  .sb-table-dialog-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--b-light, rgba(255,255,255,0.10)); }
  .sb-table-dialog-title { font-size: 13px; font-weight: 600; color: #fff; }
  .sb-table-dialog-size { flex: 1 1 auto; min-width: 0; color: rgba(255,255,255,0.55); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sb-table-dialog-body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .sb-table-dialog-body.sb-output :is(th, td) { max-width: 60ch; padding: 8px 12px; }
  .sb-table-dialog-body.sb-output thead th { position: sticky; top: 0; z-index: 1; background: #26262a; }
  .sb-table-dialog-body.sb-output table { width: 100%; }
`;

const installed = new WeakSet();
const timers = new WeakMap();
let askedI18n = false;

const tagOf = (node) => String(node?.localName || node?.nodeName || '').toLowerCase();

/** The shared stylesheet in `doc`, once. */
export function injectOutputStyles(doc = globalThis.document) {
  if (!doc?.createElement || !doc.head || doc.getElementById?.(OUTPUT_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = OUTPUT_STYLE_ID;
  style.textContent = OUTPUT_CSS;
  doc.head.appendChild(style);
}

// The app's locale, read where the app has one. Loaded on demand: i18n.js needs a page, and this module must not.
function askI18n() {
  if (askedI18n || typeof window === 'undefined') return;
  askedI18n = true;
  import('./i18n.js')
    .then(({ t }) => {
      if (typeof t !== 'function') return;
      setOutputTranslator((key, params) => {
        const id = `output.${key}`;
        const text = t(id, params);
        return text && text !== id ? text : '';
      });
    })
    .catch(() => { /* no i18n here (a detached window before its bundle, a test page): the English */ });
}

/**
 * The reading layer works in `doc`: the stylesheet and one click listener (capture phase, so a click on a
 * table's button never reaches a card header or a row under it). Safe to call any number of times.
 * @returns {boolean} true the first time for this document
 */
export function installOutput(doc = globalThis.document) {
  if (!doc || typeof doc.addEventListener !== 'function' || installed.has(doc)) return false;
  installed.add(doc);
  injectOutputStyles(doc);
  doc.addEventListener('click', onDocumentClick, true);
  askI18n();
  return true;
}

const cellsOf = (row) => [...row.children].filter((cell) => /^t[hd]$/.test(tagOf(cell)));

/** How many body rows and columns a table element has: what output-format.js `tableSize` says of its markup. */
function sizeOf(table) {
  const matrix = tableMatrix(table);
  const hasHead = [...table.children].some((child) => tagOf(child) === 'thead');
  return { rows: Math.max(0, matrix.length - (hasHead || matrix.length > 1 ? 1 : 0)), columns: matrix[0]?.length || 0 };
}

// The classes output-format.js writes into a table's markup, set on its cells: numbers right-aligned, a column of
// sentences at a readable width. A table that holds a table, a merged cell or a cell with a class is left alone.
function markColumns(table) {
  if (table.querySelector('table')) return;
  const rows = [...table.querySelectorAll('tr')];
  if (rows.some((row) => cellsOf(row).some((cell) => cell.hasAttribute('colspan') || cell.hasAttribute('rowspan')))) return;
  const text = tableMatrix(table);
  if (text.length !== rows.length) return;
  const hasBody = [...table.children].some((child) => tagOf(child) === 'tbody');
  const inHead = rows.map((row) => tagOf(row.parentElement) === 'thead');
  const body = hasBody ? text.filter((_, index) => !inHead[index]) : text.slice(1);
  if (!body.length) return;
  const numeric = numericColumns(body);
  const long = longColumns(text);
  for (const row of rows) {
    cellsOf(row).forEach((cell, col) => {
      if (cell.hasAttribute('class')) return;
      const cls = numeric[col] && !cell.hasAttribute('align') ? NUMERIC_CLASS : long[col] && !numeric[col] ? LONG_CLASS : '';
      if (cls) cell.className = cls;
    });
  }
}

/** The strip above a table (its size, Expand, Copy) as nodes: what output-format.js `tableToolsHtml` writes. */
function toolsStrip(doc, { rows = 0, columns = 0 } = {}) {
  const tools = doc.createElement('div');
  tools.className = TABLE_TOOLS_CLASS;
  tools.setAttribute('data-rows', String(rows));
  tools.setAttribute('data-columns', String(columns));
  tools.setAttribute('data-label', outputText('tableSize', { rows, columns }));
  tools.append(dialogButton(doc, 'expand', outputText('expand'), outputText('expandTable')), dialogButton(doc, 'copy', outputText('copy'), outputText('copyTable')));
  return tools;
}

/**
 * The frames of output-format.js on Markdown that is already nodes: every bare table in its frame, task items,
 * the language of a code block, the lines of a diff. A table with attributes is a panel's own and is left alone.
 * @returns {number} how many nodes it changed
 */
export function decorateOutput(root, { diff = true } = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const doc = root.ownerDocument || globalThis.document;
  let changed = 0;
  // Nodes are moved and made here, never written as markup: nothing a model wrote is parsed a second time.
  for (const table of [...root.querySelectorAll('table')]) {
    if (table.attributes.length || table.closest(`.${TABLE_FRAME_CLASS}`) || table.parentElement?.closest('table')) continue;
    markColumns(table);
    const frame = doc.createElement('div');
    frame.className = TABLE_FRAME_CLASS;
    const scroller = doc.createElement('div');
    scroller.className = TABLE_SCROLL_CLASS;
    table.replaceWith(frame);
    scroller.appendChild(table);
    frame.append(toolsStrip(doc, sizeOf(table)), scroller);
    changed += 1;
  }
  // A frame that was already there (a stored transcript put back, a re-render): its strip is whole, says what it
  // says in today's locale, and shows no "Copied" from a click whose timer is gone. Nothing changes otherwise.
  for (const frame of root.querySelectorAll(`.${TABLE_FRAME_CLASS}`)) {
    const table = frame.querySelector('table');
    if (!table) continue;
    const size = sizeOf(table);
    let tools = [...frame.children].find((child) => child.classList?.contains(TABLE_TOOLS_CLASS)) || null;
    const button = (action) => tools?.querySelector(`button.${TABLE_BUTTON_CLASS}[data-sb-act="${action}"]`) || null;
    if (!tools || !button('copy') || !button('expand')) {
      const fresh = toolsStrip(doc, size);
      if (tools) tools.replaceWith(fresh); else frame.insertBefore(fresh, frame.firstChild);
      tools = fresh;
      changed += 1;
      continue;
    }
    const copy = button('copy');
    if (copy.hasAttribute('data-state') && !timers.has(copy)) { resetButton(copy); changed += 1; }
    const set = (node, name, value) => { if (node.getAttribute(name) !== value) { node.setAttribute(name, value); changed += 1; } };
    set(tools, 'data-label', outputText('tableSize', size));
    if (!copy.hasAttribute('data-state')) { set(copy, 'data-label', outputText('copy')); set(copy, 'aria-label', outputText('copyTable')); }
    set(button('expand'), 'data-label', outputText('expand'));
    set(button('expand'), 'aria-label', outputText('expandTable'));
  }
  for (const item of root.querySelectorAll(`li:not(.${TASK_CLASS})`)) {
    const first = item.firstChild;
    const host = first?.nodeType === 1 && tagOf(first) === 'p' ? first : item;
    const text = host.firstChild;
    if (text?.nodeType !== 3 || !/^[☑☐] /.test(text.data)) continue;
    const done = text.data[0] === '☑';
    const box = doc.createElement('span');
    box.className = `${TASK_CLASS}-box`;
    box.textContent = text.data[0];
    text.data = text.data.slice(1);
    host.insertBefore(box, text);
    item.classList.add(TASK_CLASS);
    if (done) item.classList.add(`${TASK_CLASS}-done`);
    changed += 1;
  }
  for (const pre of root.querySelectorAll('pre')) {
    const code = [...pre.children].find((child) => tagOf(child) === 'code');
    const lang = /(?:^|\s)language-([\w+#.-]{1,40})(?:\s|$)/.exec(code?.getAttribute('class') || '')?.[1];
    if (!lang) continue;
    if (!pre.hasAttribute('data-lang')) { pre.setAttribute('data-lang', lang); changed += 1; }
    if (diff && lang === 'diff' && !code.children.length && code.textContent) {
      // The block's own text, line by line, with a span around each changed line: what it copies is unchanged.
      const lines = code.textContent.split('\n');
      if (!lines.some((line) => line && diffLineClass(line))) continue;
      const parts = [];
      lines.forEach((line, index) => {
        if (index) parts.push('\n');
        const cls = line ? diffLineClass(line) : '';
        if (!cls) { if (line) parts.push(line); return; }
        const span = doc.createElement('span');
        span.className = cls;
        span.textContent = line;
        parts.push(span);
      });
      code.replaceChildren(...parts);
      changed += 1;
    }
  }
  return changed;
}

function resetButton(button) {
  const view = button.ownerDocument?.defaultView || globalThis;
  const timer = timers.get(button);
  if (timer) view.clearTimeout(timer);
  timers.delete(button);
  button.removeAttribute('data-state');
  button.setAttribute('data-label', outputText('copy'));
  button.setAttribute('aria-label', outputText('copyTable'));
}

function showOutcome(button, state) {
  const view = button.ownerDocument?.defaultView || globalThis;
  const timer = timers.get(button);
  if (timer) view.clearTimeout(timer);
  button.setAttribute('data-state', state);
  button.setAttribute('data-label', outputText(state));
  button.setAttribute('aria-label', outputText(state === 'copied' ? 'tableCopied' : 'tableFailed'));
  timers.set(button, view.setTimeout(() => resetButton(button), OUTPUT_FEEDBACK_MS[state] || 1500));
}

function tableOf(button) {
  return button?.closest?.(`.${TABLE_FRAME_CLASS}, .sb-table-dialog`)?.querySelector('table') || null;
}

// The table's text through a hidden textarea and execCommand('copy'): where the Clipboard API is missing or refused.
function execCopy(doc, text) {
  if (typeof doc?.execCommand !== 'function' || !doc.body) return false;
  const active = doc.activeElement;
  const host = active?.closest?.('dialog[open]') || doc.body;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;margin:0;opacity:0;pointer-events:none;';
  host.appendChild(area);
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

/**
 * Copy the table a button belongs to: tab-separated text (a spreadsheet, a chat, a terminal) and, where the
 * browser takes two kinds at once, the same cells as a plain table (a document, a mail). `clipboard` /
 * `fallback` stand in for the page's in a test.
 * @returns {Promise<'rich' | 'clipboard' | 'fallback' | null>}
 */
export async function copyTable(button, { clipboard, fallback } = {}) {
  const table = tableOf(button);
  if (!table) return null;
  const doc = button.ownerDocument || globalThis.document;
  const view = doc.defaultView || globalThis;
  const matrix = tableMatrix(table);
  const text = matrixToTsv(matrix);
  const board = clipboard === undefined ? view.navigator?.clipboard : clipboard;
  let how = null;
  if (board && typeof board.write === 'function' && typeof view.ClipboardItem === 'function' && typeof view.Blob === 'function') {
    try {
      await board.write([new view.ClipboardItem({
        'text/plain': new view.Blob([text], { type: 'text/plain' }),
        'text/html': new view.Blob([matrixToHtml(matrix)], { type: 'text/html' }),
      })]);
      how = 'rich';
    } catch { how = null; }
  }
  if (!how) how = await writeClipboard(text, { clipboard: board, fallback: fallback === undefined ? (value) => execCopy(doc, value) : fallback });
  if (!button.isConnected) return how;
  showOutcome(button, how ? 'copied' : 'failed');
  return how;
}

function dialogButton(doc, action, label, name) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = TABLE_BUTTON_CLASS;
  button.setAttribute('data-sb-act', action);
  button.setAttribute('data-label', label);
  button.setAttribute('aria-label', name);
  return button;
}

/**
 * The table of `button`'s frame in a dialog as wide as the window: every column at a readable width, the header
 * in sight while the rows scroll, Copy, and Esc / Close / a click outside to go back (focus returns to `button`).
 * @returns {HTMLDialogElement | null} the dialog, or null where the browser has none
 */
export function openTableViewer(button) {
  const table = tableOf(button);
  const doc = button?.ownerDocument || globalThis.document;
  if (!table || !doc?.body) return null;
  const dialog = doc.createElement('dialog');
  if (typeof dialog.showModal !== 'function') return null;
  dialog.className = 'sb-table-dialog';
  dialog.setAttribute('aria-label', outputText('tableTitle'));
  const head = doc.createElement('div');
  head.className = 'sb-table-dialog-head';
  const title = doc.createElement('span');
  title.className = 'sb-table-dialog-title';
  title.textContent = outputText('tableTitle');
  const size = doc.createElement('span');
  size.className = 'sb-table-dialog-size';
  size.textContent = outputText('tableSize', sizeOf(table));
  head.append(title, size, dialogButton(doc, 'copy', outputText('copy'), outputText('copyTable')), dialogButton(doc, 'close', outputText('close'), outputText('close')));
  const body = doc.createElement('div');
  body.className = 'sb-table-dialog-body sb-output';
  body.tabIndex = 0;
  body.appendChild(table.cloneNode(true));
  dialog.append(head, body);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    try { if (button.isConnected) button.focus({ preventScroll: true }); } catch { /* the button left the page */ }
  });
  doc.body.appendChild(dialog);
  dialog.showModal();
  return dialog;
}

function onDocumentClick(event) {
  const button = event.target?.closest?.(`button.${TABLE_BUTTON_CLASS}`);
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const action = button.getAttribute('data-sb-act');
  if (action === 'copy') copyTable(button).catch(() => {});
  else if (action === 'expand') openTableViewer(button);
  else if (action === 'close') button.closest('dialog')?.close();
}
