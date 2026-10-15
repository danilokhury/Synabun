// ═══════════════════════════════════════════
// SynaBun — Greeting: the card every surface mounts
// ═══════════════════════════════════════════
//
// One renderer for the greeting: the Assistant and the Claude Code, Codex and
// OpenCode panels mount it inside the empty state they already have, Settings
// shows the same card as its preview. greeting-view.js decides the words; this
// file asks the server (`POST /api/greeting/open`) and draws.
//
// Everything is text (never markup): a greeting is built from records and may
// have been written by a model. A server older than this page (404) or an
// engine that did not start (503) simply shows nothing, and is asked again a
// minute later at the earliest.

import { greetingView, readGreetingResponse } from './greeting-view.js';

const STYLE_ID = 'sb-greet-styles';
const OPEN_URL = '/api/greeting/open';
const RETRY_MS = 60_000;
const TIMEOUT_MS = 4000;

// The app's own tokens (styles.css), so the card reads like the panel it sits in; a panel with
// tokens of its own maps them here.
const STYLES = `
.sb-greet { --sbg-text: var(--t-bright, rgba(255,255,255,0.9)); --sbg-2: var(--t-secondary, rgba(255,255,255,0.5)); --sbg-3: var(--t-muted, rgba(255,255,255,0.3)); --sbg-line: var(--b-subtle, rgba(255,255,255,0.06)); --sbg-fill: var(--s-subtle, rgba(255,255,255,0.04));
  display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%; max-width: 440px; margin: 6px auto 0; padding: 0 12px; box-sizing: border-box; text-align: center; pointer-events: auto; }
.asst-empty .sb-greet { --sbg-text: var(--asst-text, var(--t-bright)); --sbg-2: var(--asst-text-2, var(--t-secondary)); --sbg-3: var(--asst-text-3, var(--t-muted)); margin-top: 0; }
.sb-greet[hidden] { display: none; }
.sb-greet-when { font-size: 12px; line-height: 1.45; color: var(--sbg-3); }
.sb-greet-text { margin: 0; font-size: 13px; line-height: 1.5; font-weight: 400; color: var(--sbg-text); overflow-wrap: anywhere; text-wrap: pretty; user-select: text; }
.sb-greet-more { appearance: none; display: inline-flex; align-items: center; gap: 4px; margin-top: 2px; padding: 2px 6px; border: 0; border-radius: var(--r-small, 6px); background: none; color: var(--sbg-3); font: inherit; font-size: 12px; line-height: 1.45; cursor: pointer; }
.sb-greet-more:is(:hover, :focus-visible) { color: var(--sbg-2); background: var(--sbg-fill); }
.sb-greet-more:focus-visible { outline: 1px solid var(--b-visible, rgba(255,255,255,0.22)); outline-offset: 1px; }
.sb-greet-chev { display: inline-block; transition: transform .12s ease; }
.sb-greet-more[aria-expanded="true"] .sb-greet-chev { transform: rotate(90deg); }
.sb-greet-basis { display: flex; flex-direction: column; gap: 4px; width: 100%; box-sizing: border-box; margin-top: 2px; padding: 8px 10px; border: 1px solid var(--sbg-line); border-radius: var(--r-card, 8px); background: var(--sbg-fill); text-align: left; }
.sb-greet-basis[hidden] { display: none; }
.sb-greet-row { display: grid; grid-template-columns: minmax(84px, 30%) minmax(0, 1fr) auto; gap: 8px; align-items: baseline; font-size: 12px; line-height: 1.45; }
.sb-greet-kind { color: var(--sbg-3); }
.sb-greet-label { color: var(--sbg-2); overflow-wrap: anywhere; user-select: text; }
.sb-greet-link { appearance: none; padding: 0 2px; border: 0; background: none; color: var(--sbg-3); font-family: var(--ff-mono, ui-monospace, 'JetBrains Mono', monospace); font-size: 11px; text-decoration: underline dotted; text-underline-offset: 2px; cursor: pointer; }
.sb-greet-link:is(:hover, :focus-visible) { color: var(--sbg-text); }
.sb-greet-cost { margin-top: 2px; padding-top: 6px; border-top: 1px solid var(--sbg-line); font-size: 12px; line-height: 1.45; color: var(--sbg-3); }
@media (prefers-reduced-motion: reduce) { .sb-greet-chev { transition: none; } }
`;

let uid = 0;
const cache = new Map();   // `${surface}:${session}` → the greeting this conversation opened with (or null)
let unavailableUntil = 0;  // an older server or an engine that did not start: not asked again before this

/** The card's styles, once per document. */
export function ensureGreetingStyles(doc = globalThis.document) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

function node(doc, tag, className, text) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/**
 * Draw a greeting inside `host` (a panel's empty state), replacing one already there.
 * → the card element, or null when there is nothing to draw.
 * opts: { t, now, onOpenMemory(id), open } (`open`: the disclosure starts open, Settings' preview)
 */
export function renderGreeting(host, greeting, { t = null, now = Date.now(), onOpenMemory = null, open = false } = {}) {
  const doc = host?.ownerDocument || globalThis.document;
  if (!host || !doc) return null;
  for (const old of host.querySelectorAll(':scope > .sb-greet')) old.remove();
  const view = greetingView(greeting, { now, t });
  if (!view) return null;
  ensureGreetingStyles(doc);
  const card = node(doc, 'div', 'sb-greet');
  card.setAttribute('role', 'note');
  card.setAttribute('aria-label', view.label);
  if (view.id) card.dataset.greetingId = view.id;
  if (view.when) card.appendChild(node(doc, 'div', 'sb-greet-when', view.when));
  card.appendChild(node(doc, 'p', 'sb-greet-text', view.text));

  const basisId = `sb-greet-basis-${++uid}`;
  const more = node(doc, 'button', 'sb-greet-more');
  more.type = 'button';
  more.setAttribute('aria-controls', basisId);
  more.appendChild(node(doc, 'span', 'sb-greet-more-text', view.toggle));
  const chev = node(doc, 'span', 'sb-greet-chev', '›');
  chev.setAttribute('aria-hidden', 'true');
  more.appendChild(chev);
  const basis = node(doc, 'div', 'sb-greet-basis');
  basis.id = basisId;
  for (const row of view.rows) {
    const line = node(doc, 'div', 'sb-greet-row');
    line.dataset.kind = row.kind;
    line.appendChild(node(doc, 'span', 'sb-greet-kind', row.kindLabel));
    line.appendChild(node(doc, 'span', 'sb-greet-label', row.label));
    if (row.id && typeof onOpenMemory === 'function') {
      const link = node(doc, 'button', 'sb-greet-link', row.id.slice(0, 8));
      link.type = 'button';
      link.title = `${row.openLabel} ${row.id}`;
      link.setAttribute('aria-label', link.title);
      link.addEventListener('click', (event) => { event.stopPropagation(); try { onOpenMemory(row.id); } catch { /* the host decides */ } });
      line.appendChild(link);
    }
    basis.appendChild(line);
  }
  basis.appendChild(node(doc, 'div', 'sb-greet-cost', view.cost));
  const setOpen = (value) => { more.setAttribute('aria-expanded', value ? 'true' : 'false'); basis.hidden = !value; };
  more.addEventListener('click', (event) => { event.stopPropagation(); setOpen(more.getAttribute('aria-expanded') !== 'true'); });
  setOpen(open === true);
  card.appendChild(more);
  card.appendChild(basis);
  host.appendChild(card);
  return card;
}

/** Remove the card from a host. */
export function clearGreeting(host) {
  if (!host) return;
  for (const old of host.querySelectorAll(':scope > .sb-greet')) old.remove();
}

/**
 * Ask whether this fresh conversation is greeted. One request per conversation: the answer is
 * kept, so a redraw of the empty state costs nothing. → the greeting, or null.
 * `session`: the surface's own name for the conversation (the server gives the same one the same answer).
 */
export async function fetchGreeting({ surface, cwd = null, project = null, session = null, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!surface || typeof fetchImpl !== 'function') return null;
  const key = session ? `${surface}:${session}` : null;
  if (key && cache.has(key)) return cache.get(key);
  if (now() < unavailableUntil) return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(OPEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller?.signal,
      body: JSON.stringify({ surface, ...(project ? { project } : {}), ...(cwd ? { cwd } : {}), ...(session ? { session } : {}) }),
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    const answer = readGreetingResponse(response.status, body);
    if (answer.state === 'old-server' || answer.state === 'failed') { unavailableUntil = now() + RETRY_MS; return null; }
    if (answer.state === 'unreadable') return null;
    if (key) { cache.set(key, answer.greeting); while (cache.size > 200) cache.delete(cache.keys().next().value); }
    return answer.greeting;
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

/** The greeting a conversation opened with, if it was asked already (no request). */
export function knownGreeting(surface, session) {
  return session ? cache.get(`${surface}:${session}`) || null : null;
}

/** The conversation sent its first message: its greeting is not drawn again. */
export function forgetGreeting(surface, session) {
  if (session) cache.set(`${surface}:${session}`, null);
}

/**
 * Ask and draw. `host`: the empty state element; `isCurrent()`: false when the conversation is no
 * longer the one on screen (the answer arrived late). → the greeting drawn, or null.
 */
export async function mountGreeting(host, { surface, cwd = null, project = null, session = null, t = null, onOpenMemory = null, isCurrent = null, fetchImpl = globalThis.fetch } = {}) {
  if (!host) return null;
  const greeting = await fetchGreeting({ surface, cwd, project, session, fetchImpl });
  // (A host that is not in the document yet is fine: a panel may draw a tab before it shows it.)
  if (!greeting) return null;
  if (typeof isCurrent === 'function') { try { if (isCurrent() === false) return greeting; } catch { return greeting; } }
  renderGreeting(host, greeting, { t, onOpenMemory });
  return greeting;
}

export const _test = { reset() { cache.clear(); unavailableUntil = 0; } };
