// ═══════════════════════════════════════════
// SynaBun Assistant — follow-ups: what a finished turn offers, as items to click
// ═══════════════════════════════════════════
// A brain that ends a turn with next steps, decisions or offers appends one
// fenced block after all its text (lib/assistant-persona.js, "Follow-ups"):
//
//   ```synabun-followups
//   {"multi": false, "items": [{"label": "Ship it", "send": "Ship 1.4.0 to npm now", "description": "…"}]}
//   ```
//
// An optional "style" says how the mascot presents it (asst-followups-card.js):
// "next" (quick actions, one click sends), "decisions" (independent picks sent
// together: what "multi": true has always meant), "confirm" (one proposed
// action: go ahead, or not now) and "question" (2-4 answers, the recommended
// one first, plus a typed answer; "question" holds the question). A block
// without it is "decisions" when multi, else "next", so older replies draw as
// they always did.
// The panel never shows the block: splitFollowups takes it out of the text
// (while it streams too) and the transcript draws its items as buttons
// (asst-followups-card.js); a click sends `send` as the user's next message.
// A model that leaves the tag off (a json or bare fence) still gets buttons
// when that fence is the message's last and holds exactly the block's shape.
// A turn whose last message has no block but still ends in a list of options
// or an "I can X, or Y" offer gets items read from the prose (guessFollowups),
// best effort. Whether a set was answered is read from the transcript: the
// user's next message is one of its items, or several of them one per line
// (matchFollowupReply), so a reload draws the same state as the live panel.
// No imports and no DOM: the server strips the block too (stripFollowups).

export const FOLLOWUPS_FENCE = 'synabun-followups';
export const FOLLOWUP_LIMITS = Object.freeze({ items: 8, label: 80, send: 2000, description: 200, heuristicItem: 400, question: 240, answer: 300 });
/** How a set is presented: quick actions, independent picks, one proposed action, a question. */
export const FOLLOWUP_STYLES = Object.freeze(['next', 'decisions', 'confirm', 'question']);
// What a model may write for a style; anything else falls back to the legacy reading of "multi".
const STYLE_NAMES = Object.freeze({
  next: 'next', 'next-steps': 'next', steps: 'next', actions: 'next',
  decisions: 'decisions', decision: 'decisions', multi: 'decisions', checklist: 'decisions',
  confirm: 'confirm', confirmation: 'confirm', proceed: 'confirm', approve: 'confirm', 'go-ahead': 'confirm',
  question: 'question', ask: 'question', choice: 'question',
});
/** A style name as the block wrote it ("Next steps", "next_steps", "Question") → a FOLLOWUP_STYLES entry, or ''. */
export function followupStyleName(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return Object.hasOwn(STYLE_NAMES, key) ? STYLE_NAMES[key] : '';
}
// "Postgres (Recommended)": the label the way AskUserQuestion asks for it; the card shows a badge instead.
const RECOMMENDED_RE = /\s*[([]\s*(?:recommended|recomendad[oa])\s*[)\]]\s*$/i;

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
/** Inline markdown off a label or a message (bold, italics, code ticks, links). */
function plain(value) {
  return String(value ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}
const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\n]*?)[ \t]*$/;
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
// A fence a model may put the block in when it forgets the tag: none, or JSON's.
const PLAIN_LANG_RE = /^(?:json5?|jsonc)?$/;

/**
 * The text's fenced blocks, in order: { start, end, lang, inner, closed, typed }. A fence opened inside
 * another is that block's content, never a block (a ```markdown example of the format is not the format).
 * `typed`: the opening line has no newline yet, so its info string may still be growing.
 */
function scanFences(src) {
  const blocks = [];
  let open = null;
  let at = 0;
  while (at <= src.length) {
    const nl = src.indexOf('\n', at);
    const lineEnd = nl < 0 ? src.length : nl;
    const line = src.slice(at, lineEnd);
    if (!open) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = { start: at, fence: m[1], lang: (m[2].split(/\s+/)[0] || '').toLowerCase(), contentStart: nl < 0 ? src.length : nl + 1, typed: nl < 0 };
      }
    } else {
      const m = FENCE_CLOSE_RE.exec(line);
      if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
        blocks.push({ start: open.start, end: lineEnd, lang: open.lang, inner: src.slice(open.contentStart, at), closed: true, typed: false });
        open = null;
      }
    }
    if (nl < 0) break;
    at = nl + 1;
  }
  if (open) blocks.push({ start: open.start, end: src.length, lang: open.lang, inner: src.slice(open.contentStart), closed: false, typed: open.typed });
  return blocks;
}

/** The first characters of an untagged or json fence that may become a follow-ups object: hidden while they stream. */
function mayBecomeFollowups(inner) {
  const src = inner.trim();
  return !src || /^\{\s*(?:"[a-z_]*"?)?$/i.test(src) || /^\{\s*"(?:multi|multi_select|multiSelect|title|items)"/.test(src);
}

/** The text with `b` taken out: what came before it, then what came after it as its own paragraph. */
function without(src, b) {
  return [src.slice(0, b.start).replace(/\s+$/, ''), src.slice(b.end).trim()].filter(Boolean).join('\n\n');
}

/**
 * The text without its follow-ups block → { body, block, partial }.
 * `block`: the parsed set ({ multi, items, title, source: 'block' }) or null.
 * The block is the last fence tagged synabun-followups; with no such fence, the message's LAST
 * fenced block when it is untagged or json and holds exactly the follow-ups shape
 * ({"items": [{"label", "send"}, …]}, optional multi / title / description), so a model that
 * forgot the tag still gets buttons and an ordinary code block is never taken.
 * `streaming`: the text is still arriving, so a fence being typed at its very end ("```synab",
 * "```json\n{\"multi\"") is hidden too (`partial`), and an open block hides what follows it.
 */
export function splitFollowups(text, { streaming = false } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const blocks = scanFences(src);
  const tagged = blocks.filter((b) => b.lang === FOLLOWUPS_FENCE).pop();
  if (tagged) {
    const partial = !tagged.closed && streaming;
    return { body: without(src, tagged), block: partial ? null : parseFollowupsBlock(tagged.inner), partial };
  }
  const last = blocks[blocks.length - 1];
  if (last && !last.closed && streaming) {
    // An opening still being typed ("```synab"), or a json / bare fence whose content may be the block.
    const typing = last.typed && !!last.lang && (FOLLOWUPS_FENCE.startsWith(last.lang) || 'json'.startsWith(last.lang));
    if (typing || (PLAIN_LANG_RE.test(last.lang) && mayBecomeFollowups(last.inner))) {
      return { body: without(src, last), block: null, partial: true };
    }
  }
  if (last && PLAIN_LANG_RE.test(last.lang) && (last.closed || !streaming)) {
    const block = shapedFollowups(last.inner);
    if (block) return { body: without(src, last), block, partial: false };
  }
  return { body: src, block: null, partial: false };
}

/** The text a surface that cannot click (WhatsApp, a summary) keeps: the block left out. */
export function stripFollowups(text) {
  return splitFollowups(text).body;
}

/**
 * A label as a card shows it: without a "(Recommended)" suffix, and whether it had one. Display only:
 * a question card's answer keeps the label exactly as the brain wrote it.
 */
export function splitRecommended(label) {
  const text = String(label ?? '');
  if (!RECOMMENDED_RE.test(text)) return { label: text, recommended: false };
  return { label: text.replace(RECOMMENDED_RE, '').trim() || text, recommended: true };
}

/** `item` with `recommended: true` when it says so (the flag, or a "(Recommended)" label suffix, which goes). */
function withRecommended(item, flagged) {
  const marked = RECOMMENDED_RE.test(item.label);
  if (marked) item.label = item.label.replace(RECOMMENDED_RE, '').trim() || item.label;
  if (flagged || marked) item.recommended = true;
  return item;
}

function itemFrom(raw) {
  const { label: maxLabel, send: maxSend, description: maxDesc } = FOLLOWUP_LIMITS;
  if (typeof raw === 'string') {
    const text = plain(raw);
    if (!text) return null;
    const item = withRecommended({ label: clip(shortLabel(text), maxLabel), send: clip(text, maxSend), description: '' }, false);
    if (item.recommended) item.send = clip(text.replace(RECOMMENDED_RE, '').trim() || text, maxSend);
    return item;
  }
  if (!raw || typeof raw !== 'object') return null;
  const label = plain(raw.label ?? raw.title ?? raw.text ?? raw.name ?? '');
  const send = plain(raw.send ?? raw.message ?? raw.prompt ?? raw.reply ?? raw.value ?? raw.text ?? label);
  if (!label && !send) return null;
  return withRecommended({
    label: clip(label || shortLabel(send), maxLabel),
    send: clip(send || label, maxSend),
    description: clip(plain(raw.description ?? raw.desc ?? raw.detail ?? raw.hint ?? ''), maxDesc),
  }, raw.recommended === true || raw.recommended === 'true');
}

function itemsFrom(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const item = itemFrom(raw);
    if (!item || seen.has(norm(item.send))) continue;
    seen.add(norm(item.send));
    out.push(item);
    if (out.length >= FOLLOWUP_LIMITS.items) break;
  }
  return out;
}

const LIST_ITEM_RE = /^\s*(?:[-*•+]|\(?\d{1,2}[.)])\s+(.+)$/;

/** A block that is no JSON: one item per list line ("- Ship it", "1. Ship it"). */
function linesToItems(src) {
  const lines = src.split('\n').map((line) => LIST_ITEM_RE.exec(line)?.[1] || '').filter(Boolean);
  return lines.length ? lines : null;
}

/** JSON, a trailing comma forgiven; undefined when it is none. */
function parseJson(src) {
  for (const candidate of [src, src.replace(/,\s*([}\]])/g, '$1')]) {
    try { return JSON.parse(candidate); } catch { /* the next candidate */ }
  }
  return undefined;
}

/** The fenced block's content → { multi, items, title, source: 'block' } or null. */
export function parseFollowupsBlock(raw) {
  const src = String(raw ?? '').trim();
  if (!src) return null;
  let data = parseJson(src);
  if (data === undefined) data = linesToItems(src);
  return setFrom(data);
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * An untagged or json fence's content as a set, only in the exact follow-ups shape: an object whose
 * `items` are all objects with a `label` and a `send`. Anything else is an ordinary code block.
 */
function shapedFollowups(raw) {
  const data = parseJson(String(raw ?? '').trim());
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.items) || !data.items.length) return null;
  if (!data.items.every((item) => item && typeof item === 'object' && filled(item.label) && filled(item.send))) return null;
  return setFrom(data);
}

/**
 * The style a set is drawn in: the block's own when it fits its items, else what "multi" always meant.
 * decisions needs two items to pick from; confirm is one proposed action and at most one alternative.
 */
function resolveStyle(named, multi, count) {
  let style = named || (multi ? 'decisions' : 'next');
  if (style === 'decisions' && count < 2) style = 'next';
  if (style === 'confirm' && count > 2) style = 'next';
  return style;
}

/** Parsed block content (an object or a list) → { style, multi, items, title, question, source: 'block' } or null. */
function setFrom(data) {
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.followups) ? data.followups
        : Array.isArray(data?.options) ? data.options : null;
  const items = itemsFrom(list);
  if (!items.length) return null;
  const obj = data && !Array.isArray(data) && typeof data === 'object' ? data : {};
  const multi = obj.multi === true || obj.multi_select === true || obj.multiSelect === true || obj.multiple === true;
  const style = resolveStyle(followupStyleName(obj.style), multi, items.length);
  const title = clip(plain(obj.title ?? obj.prompt ?? ''), 80);
  // A question's own words: "question", else the title (a question block that put it there).
  const question = style === 'question' ? clip(plain(obj.question ?? obj.ask ?? obj.title ?? obj.prompt ?? ''), FOLLOWUP_LIMITS.question) : '';
  return { style, multi: style === 'decisions', items, title, question, source: 'block' };
}

/** "**Ship it** — publishes 1.4.0" → "Ship it": a bold lead, else the words before " — " / ": ", else the first ~8 words. */
function shortLabel(text) {
  const src = String(text ?? '').trim();
  const bold = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(src);
  if (bold) return plain(bold[1]).replace(/[:.\-–—]+$/, '').trim();
  const flat = plain(src);
  const cut = /^(.{3,60}?)\s*(?:\s[—–-]\s|:\s)/.exec(flat);
  if (cut) return cut[1].trim();
  const words = flat.split(/\s+/);
  return words.length <= 8 ? flat.replace(/[.;]+$/, '') : `${words.slice(0, 8).join(' ')}…`;
}
/** What follows the label, as its one-line description. */
function restOf(text, label) {
  const flat = plain(text);
  const lead = flat.indexOf(label.replace(/…$/, ''));
  const rest = lead === 0 ? flat.slice(label.replace(/…$/, '').length) : '';
  return clip(rest.replace(/^\s*[:\-–—.]+\s*/, ''), FOLLOWUP_LIMITS.description);
}

// A list or an offer is a follow-up only when the text says it asks: words of choice or a question.
const OFFER_HEADER_RE = /\b(?:next steps?|follow[- ]?ups?|options?|choices?|decisions?|decide|choose|pick|which|want me to|would you like|do you want|should i|shall i|let me know|tell me|reply with|i can|i could|we can|you can|prefer|your call|up to you|need from you|ready to|suggest(?:ed|ions?)?|recommend(?:ed|ations?)?)\b/i;
const MULTI_HEADER_RE = /\b(?:numbers|decisions|any of|all that apply|pick (?:any|several|one or more)|one or more|as many|each)\b/i;

/** A list that ends the text, under a line that asks: its items. */
function trailingList(src) {
  const lines = src.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i -= 1;
  const raw = [];
  let current = [];
  let numbered = 0;
  for (; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line inside a loose list: the list goes on when an item is above it.
      let j = i - 1;
      while (j >= 0 && !lines[j].trim()) j -= 1;
      if (j >= 0 && (LIST_ITEM_RE.test(lines[j]) || /^\s{2,}\S/.test(lines[j])) && raw.length) { i = j + 1; continue; }
      break;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      raw.unshift([item[1], ...current].join(' '));
      current = [];
      if (/^\s*\(?\d/.test(line)) numbered += 1;
      continue;
    }
    if (/^\s{2,}\S/.test(line)) { current.unshift(line.trim()); continue; } // an item's continuation line
    break;
  }
  if (current.length || raw.length < 2 || raw.length > FOLLOWUP_LIMITS.items) return null;
  if (raw.some((text) => text.length > FOLLOWUP_LIMITS.heuristicItem)) return null;
  let h = i;
  while (h >= 0 && !lines[h].trim()) h -= 1;
  const header = h >= 0 ? lines[h].trim() : '';
  if (!header || header.length > 300 || !(OFFER_HEADER_RE.test(header) || /\?\s*\**\s*$/.test(header))) return null;
  const items = raw.map((text) => {
    const label = clip(shortLabel(text), FOLLOWUP_LIMITS.label);
    return { label, send: clip(plain(text), FOLLOWUP_LIMITS.send), description: restOf(text, label) };
  });
  const multi = numbered === raw.length && MULTI_HEADER_RE.test(header);
  return { style: multi ? 'decisions' : 'next', multi, items, title: clip(plain(header).replace(/[:]\s*$/, ''), 80), question: '', source: 'heuristic' };
}

const OFFER_RE = /^(?:(?:but |and |so |or )?(?:i can|i could|we can|i'm happy to|happy to|want me to|do you want me to|would you like me to|should i|shall i))\s+(.+?)\s*[.?!]*$/i;
const ASKS_RE = /^(?:(?:but |and |so )?(?:want me to|do you want me to|would you like me to|should i|shall i))\s/i;
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "I can re-run it after the reset, or now on Claude…" → its alternatives; "Want me to ship it?" → one yes. */
function orOffer(src) {
  const paragraphs = src.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] || '';
  if (!last || last.length > 600 || LIST_ITEM_RE.test(last.split('\n').pop())) return null;
  const sentences = plain(last).replace(/\s+/g, ' ').split(/(?<=[.?!])\s+(?=[A-Z"'(])/);
  const sentence = sentences[sentences.length - 1] || '';
  const m = OFFER_RE.exec(sentence);
  if (!m) return null;
  const rest = m[1].trim();
  const parts = rest.split(/\s*,?\s+\bor\b\s+/i).map((p) => p.replace(/^(?:else|instead)\s+/i, '').trim()).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => p.split(/\s+/).length >= 2)) {
    const items = parts.map((p) => { const send = clip(capital(p), FOLLOWUP_LIMITS.send); return { label: clip(shortLabel(send), FOLLOWUP_LIMITS.label), send, description: '' }; });
    return { style: 'next', multi: false, items, title: '', question: '', source: 'heuristic' };
  }
  if (ASKS_RE.test(sentence) && rest.split(/\s+/).length >= 2) {
    // "Want me to open a PR?": one proposed action, so a confirm (go ahead, or not now).
    const send = clip(`Yes, ${rest.replace(/[.?!]+$/, '')}`, FOLLOWUP_LIMITS.send);
    return { style: 'confirm', multi: false, items: [{ label: clip(send, FOLLOWUP_LIMITS.label), send, description: '' }], title: clip(sentence, 80), question: '', source: 'heuristic' };
  }
  return null;
}

/**
 * Best-effort follow-ups of a finished message that has no block: a list of options that ends it,
 * under a line that asks ("Decisions I need from you (reply with the numbers):"), or an offer in
 * its last sentence ("I can X, or Y.", "Want me to X?"). null when the text offers nothing.
 */
export function guessFollowups(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!src) return null;
  const split = splitFollowups(src);
  if (split.block) return null;
  // A code block that ends the message is output, not options.
  if (/```\s*$/.test(split.body)) return null;
  return trailingList(split.body) || orOffer(split.body);
}

/** The message a choice sends: one item's `send`, or several of them, one per line. */
export function followupMessage(set, indices = []) {
  const items = [...new Set(indices)].sort((a, b) => a - b).map((i) => set?.items?.[i]).filter(Boolean);
  if (!items.length) return '';
  if (items.length === 1) return items[0].send;
  return items.map((item) => `- ${item.send}`).join('\n');
}

/**
 * A confirm with one proposed action gets a way to say no: `hold` ({ label, send }, the card's own words)
 * as its second item, so a "Not now" is a message too and reads back from the transcript like any pick.
 */
export function confirmSet(set, hold) {
  if (set?.style !== 'confirm' || !Array.isArray(set.items) || set.items.length !== 1 || !hold?.send) return set;
  return { ...set, items: [...set.items, { label: String(hold.label || hold.send), send: String(hold.send), description: '', hold: true }] };
}

/**
 * What the user's next message `text` did to an offered set: { state: 'answered', indices, text } or
 * { state: 'stale', indices: [] }. One of its items (several, one per line, for decisions) answers any
 * set; for a question, whatever the user says next is their answer (`text`, the words they typed),
 * except a slash command. The same rule live and from the journal, so a reload draws the same state.
 */
export function settleFollowups(set, text) {
  const indices = matchFollowupReply(set, text);
  if (indices) return { state: 'answered', indices, text: '' };
  const typed = String(text ?? '').trim();
  if (set?.style === 'question' && typed && !typed.startsWith('/')) return { state: 'answered', indices: [], text: clip(typed, FOLLOWUP_LIMITS.answer) };
  return { state: 'stale', indices: [], text: '' };
}

/** Which items of `set` the user's message `text` chose (the indices), or null when it chose none of them. */
export function matchFollowupReply(set, text) {
  const items = Array.isArray(set?.items) ? set.items : [];
  if (!items.length) return null;
  const whole = norm(text);
  if (!whole) return null;
  const single = items.findIndex((item) => norm(item.send) === whole);
  if (single >= 0) return [single];
  if (!set.multi) return null;
  const lines = String(text ?? '').split('\n').map((line) => norm(line.replace(/^\s*[-*•]\s+/, ''))).filter(Boolean);
  if (lines.length < 2) return null;
  const picked = lines.map((line) => items.findIndex((item) => norm(item.send) === line));
  return picked.every((i) => i >= 0) ? [...new Set(picked)].sort((a, b) => a - b) : null;
}
