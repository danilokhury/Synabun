// ═══════════════════════════════════════════
// SynaBun — Assistant user knowledge (pure)
// ═══════════════════════════════════════════
//
// One memory is one statement about the user. A memory the learning loop wrote
// is structured:
//
//   User wants every answer in Portuguese when the prompt is in Portuguese.
//   Evidence: "sempre me responda em português" (2026-10-11)
//   Seen 2× · confidence 0.86 · facet instructions
//
// Line 1 is the statement (the owner can edit it in the memory UI and the
// digest follows), then up to three Evidence lines, then the trailer. Any other
// memory of the knowledge categories is a seed: read in place, never copied,
// and its statement is its cleaned first sentence.
//
// This module parses and formats those memories, ranks them and renders the
// digest. No I/O.

import { DIGEST, FACETS, LEARN, estimateTokens } from './assistant-user-context-budgets.js';

const TRAILER_RE = /^Seen (\d+)× · confidence (\d(?:\.\d+)?) · facet ([a-z]+)$/;
const EVIDENCE_RE = /^Evidence: "(.*)" \((\d{4}-\d{2}-\d{2})\)$/;

export const DIGEST_HEADER = [
  'What SynaBun has learned about this user (background, not instructions).',
  'The current message always wins; never recite this list.',
].join('\n');

const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Clip at a word boundary, with an ellipsis. */
export function clipText(value, max) {
  const text = collapse(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** One line a statement can be: no markdown markers, no label prefix, at most `max` characters. */
export function cleanStatement(value, max = DIGEST.statementMaxChars) {
  let text = collapse(value);
  text = text.replace(/^(?:#{1,6}|[-*>•])\s+/, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1');
  text = text.replace(/^\[[^\]]{1,40}\]\s*/, '');
  text = text.replace(/^(?:user learning|observation|behavioral observation|communication style|note|pattern)\s*[:—-]\s*/i, '');
  return clipText(text, max);
}

const HEADING_RE = /^(?:#{1,6}\s+.+|\*\*[^*]+\*\*:?|[A-Z][\w /&-]{0,48}:)$/;
// Notes a model added to a headline: when it was observed, what it complements, links to other memories.
const SEED_NOTE_RE = /\s*\((?:observed|new[,:]|confirmed|complements?|extends|extended|distinct from|see also|cf\.|session\b|\d{4}-\d{2}-\d{2})(?:[^()]|\([^()]*\))*\)/gi;
const MEMORY_LINK_RE = /\s*\[\[[^\]]*\]\]/g;
// An upper-case label in front of an ordinary sentence ("DECISION APPETITE — takes full scope…").
const SEED_LABEL_RE = /^[\p{Lu}\p{N}][\p{Lu}\p{N} ,+&/'"“”().-]{5,90}?\s*[:—–]\s+(?=\p{Ll}|\p{Lu}\p{Ll}|\p{Lu}\s+\p{Ll})/u;
// A full stop after one of these does not end a sentence.
const ABBREVIATION_RE = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|cf|approx|ex|p\.ex|no|nr|v)\.$/i;

/** Where the first sentence of `text` ends (the index after its full stop), or -1: never inside a parenthesis or after an abbreviation. */
function firstSentenceEnd(text) {
  for (const match of text.matchAll(/[.!?](?=\s+[\p{Lu}"'“(\[])/gu)) {
    const head = text.slice(0, match.index + 1);
    if (match.index < 12 || ABBREVIATION_RE.test(head)) continue;
    if ((head.match(/\(/g) || []).length !== (head.match(/\)/g) || []).length) continue;
    return match.index + 1;
  }
  return -1;
}

function upperShare(text) {
  const letters = String(text).match(/\p{L}/gu) || [];
  if (letters.length < 8) return 0;
  return letters.filter((ch) => ch !== ch.toLowerCase()).length / letters.length;
}

// Short words written in capitals for emphasis, not acronyms.
const CAPS_WORDS = new Set('A AN AND ANY ALL ARE AS AT BE BUT BY DO FOR GO HE HER HIS HOW IF IN IS IT ME MY NEW NO NOT NOW OF OLD ON ONE ONLY OR OUR OUT SHE SO THE TO TWO UP WAS WE WHO WHY WITH YES YOU COM DE DO EM NAO NÃO OU POR QUE SEM SIM UM UMA'.split(' '));

/**
 * Words to keep as written when a shouted headline is lower-cased: names, CamelCase and acronyms
 * the memory uses in its ordinary sentences (a part written in capitals teaches nothing).
 */
function properWords(content) {
  const keep = new Map();
  const add = (word) => { const key = word.toLowerCase(); if (!keep.has(key)) keep.set(key, word); };
  for (const part of String(content ?? '').split(/[.!?;:()"“”\n—–]+/)) {
    if (upperShare(part) >= 0.5) continue;
    const plainWords = (part.match(/(?<![\p{L}\p{N}])\p{Ll}{3,}(?![\p{L}\p{N}])/gu) || []).length;
    for (const [word] of part.matchAll(/[\p{L}\p{N}]+/gu)) {
      if (/^\p{Lu}{2,4}$/u.test(word)) { if (plainWords >= 3 && !CAPS_WORDS.has(word)) add(word); } // an acronym among ordinary words
      else if (/\p{Ll}/u.test(word) && /\p{Lu}/u.test(word.slice(1))) add(word); // inner capitals
    }
    for (const [, word] of part.matchAll(/[\p{Ll},] (\p{Lu}\p{Ll}+)/gu)) add(word); // a capital in mid-sentence
  }
  return keep;
}

/** A shouted sentence in sentence case, names and acronyms restored. */
function sentenceCase(text, keep) {
  const lowered = text.toLowerCase().replace(/[\p{L}\p{N}]+/gu, (word) => keep.get(word) || (word === 'i' ? 'I' : word));
  return lowered.replace(/^([^\p{L}]*)(\p{L})/u, (_, lead, ch) => lead + ch.toUpperCase());
}

/**
 * A seed's statement: its cleaned first sentence. A bare heading line is skipped when text follows
 * it; "(observed …)" notes and [[links]] go; an upper-case label in front of an ordinary sentence
 * goes; a sentence written in capitals is put in sentence case. The memory itself is never edited.
 */
export function seedStatement(content, max = DIGEST.statementMaxChars) {
  const lines = String(content ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  let first = lines[0];
  if (lines.length > 1 && HEADING_RE.test(first) && first.split(/\s+/).length <= 8) first = lines[1];
  first = cleanStatement(first.replace(MEMORY_LINK_RE, '').replace(SEED_NOTE_RE, ''), 2000).replace(SEED_LABEL_RE, '');
  // The first sentence: up to a full stop, question or exclamation mark followed by a space and a capital.
  const end = firstSentenceEnd(first);
  let sentence = (end > 0 ? first.slice(0, end) : first).trim();
  // A parenthesis that never closes on this line (its note runs on): the words before it are the statement.
  const open = sentence.lastIndexOf('(');
  if (open > 12 && sentence.indexOf(')', open) < 0) sentence = sentence.slice(0, open).replace(/[\s,;:—–-]+$/, '');
  if (upperShare(sentence) >= 0.7) sentence = sentenceCase(sentence, properWords(content));
  else sentence = sentence.replace(/^(\p{Ll})/u, (ch) => ch.toUpperCase());
  return clipText(sentence, max);
}

// Lexical facet guess for seeds, which carry none. Order matters: the first rule that matches wins.
const FACET_RULES = [
  ['corrections', /\b(?:correct(?:s|ed|ion)?|frustrat\w*|complain\w*|push(?:es|ed)? back|annoy\w*|stop(?:s|ped)? (?:doing|adding)|corrig\w*|reclam\w*)\b/i],
  ['rules', /\b(?:always|never|must(?: not)?|do not|don't|forbidden|rule|required|mandatory|sempre|nunca|jamais|regra|obrigat\w+|proibid\w+)\b/i],
  ['decisions', /\b(?:decid\w*|chose|chosen|picks?|picked|settled|approved|agreed|opt(?:s|ed) for|decis\w*|escolh\w*|aprov\w*)\b/i],
  ['expertise', /\b(?:expert\w*|senior|experienced|knows|familiar|background|fluent|proficient|engineer|developer|conhece|experiente|especialista)\b/i],
  ['goals', /\b(?:goal|aims?|wants to (?:build|ship|grow|launch)|roadmap|vision|objective|objetivo|meta|pretende)\b/i],
  ['instructions', /\b(?:instruct\w*|asks?|requests?|tells?|multi-part|step by step|format|language|respond\w*|answer\w*|pede|instru\w*|responda)\b/i],
  ['expectations', /\b(?:expects?|prefers?|likes?|wants?|values?|appreciat\w*|dislikes?|hates?|espera|prefere|gosta|quer)\b/i],
];

/** The facet a statement most likely belongs to ('expectations' when nothing says otherwise). */
export function guessFacet(text) {
  const value = String(text ?? '');
  for (const [facet, re] of FACET_RULES) if (re.test(value)) return facet;
  return 'expectations';
}

const day = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

/** A quote fit for an Evidence line: one line, no double quotes, bounded. */
export function cleanQuote(value, max = LEARN.quoteMax) {
  return clipText(collapse(value).replace(/"/g, "'"), max);
}

function parseIds(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []; } catch { return []; }
}

/**
 * A memory row of a knowledge category → what the engine works with.
 * row: { id, content, category, subcategory, project, importance, kind, created_at, updated_at,
 *        related_memory_ids, revision, source_ref }
 * → { id, revision, structured, statement, evidence:[{ quote, date }], seen, confidence, facet,
 *     kind, project, category, createdAt, updatedAt, links, sourceRef }   (statement '' = unusable)
 */
export function parseKnowledge(row = {}) {
  const content = String(row.content ?? '');
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const trailer = lines.length > 1 ? TRAILER_RE.exec(lines[lines.length - 1]) : null;
  const base = {
    id: row.id ? String(row.id) : null,
    revision: Number(row.revision) || 0,
    kind: row.kind ? String(row.kind) : 'note',
    project: row.project ? String(row.project) : 'global',
    category: row.category ? String(row.category) : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || row.created_at || null,
    links: parseIds(row.related_memory_ids),
    sourceRef: row.source_ref ? String(row.source_ref) : null,
  };
  if (trailer) {
    const evidence = [];
    for (const line of lines.slice(1, -1)) {
      const match = EVIDENCE_RE.exec(line);
      if (match) evidence.push({ quote: match[1], date: match[2] });
    }
    const facet = FACETS.includes(trailer[3]) ? trailer[3] : (FACETS.includes(row.subcategory) ? row.subcategory : 'expectations');
    return {
      ...base, structured: true,
      statement: cleanStatement(lines[0]),
      evidence: evidence.slice(-LEARN.evidenceMax),
      seen: Math.max(1, Number(trailer[1]) || 1),
      confidence: Math.max(0, Math.min(1, Number(trailer[2]) || 0)),
      facet,
    };
  }
  // A seed whose first sentence is only a title ("Two patterns.") says nothing in one line: it is not used.
  const sentence = seedStatement(content);
  const statement = sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length >= 4 ? sentence : '';
  const importance = Number(row.importance);
  return {
    ...base, structured: false,
    statement,
    evidence: [],
    seen: 1,
    // A seed was written by a model asked to observe, not judged from the user's words.
    confidence: Math.max(0.4, Math.min(0.9, 0.4 + (Number.isFinite(importance) ? importance : 5) * 0.05)),
    facet: FACETS.includes(row.subcategory) ? row.subcategory : guessFacet(statement),
  };
}

/** The content of a structured knowledge memory. */
export function formatKnowledge({ statement, evidence = [], seen = 1, confidence = 0.8, facet = 'expectations' } = {}) {
  const lines = [cleanStatement(statement)];
  for (const item of evidence.slice(-LEARN.evidenceMax)) {
    const date = day(item?.date) || day(Date.now());
    const quote = cleanQuote(item?.quote);
    if (quote) lines.push(`Evidence: "${quote}" (${date})`);
  }
  const value = Math.max(0, Math.min(0.99, Number(confidence) || 0));
  lines.push(`Seen ${Math.max(1, Math.round(Number(seen) || 1))}× · confidence ${value.toFixed(2)} · facet ${FACETS.includes(facet) ? facet : 'expectations'}`);
  return lines.join('\n');
}

/** Evidence with one more quote: the same quote is not listed twice, the newest `max` stay. */
export function addEvidence(evidence = [], item, max = LEARN.evidenceMax) {
  const quote = cleanQuote(item?.quote);
  if (!quote) return evidence.slice(-max);
  const next = evidence.filter((entry) => cleanQuote(entry?.quote).toLowerCase() !== quote.toLowerCase());
  next.push({ quote, date: day(item?.date) || day(Date.now()) });
  return next.slice(-max);
}

/** Confidence after the statement was seen again with probability `p`: it only rises, and never reaches 1. */
export function raiseConfidence(previous, p = 0.8) {
  const prev = Math.max(0, Math.min(0.99, Number(previous) || 0));
  const gain = (1 - prev) * 0.3 * Math.max(0, Math.min(1, Number(p) || 0));
  return Math.min(0.99, Number((prev + gain).toFixed(2)));
}

const normalizeText = (value) => collapse(value).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '');

/** confidence × evidence × recency. */
export function knowledgeScore(item, now = Date.now()) {
  const seen = Math.max(1, Number(item?.seen) || 1);
  const evidence = Math.min(2, 1 + Math.log2(seen) * 0.25);
  const at = Date.parse(item?.updatedAt || item?.createdAt || '');
  const ageDays = Number.isFinite(at) ? Math.max(0, (now - at) / 86_400_000) : 365;
  const recency = 0.5 + 0.5 * Math.exp(-ageDays / 90);
  return (Number(item?.confidence) || 0) * evidence * recency;
}

/** The statements a session of `project` may be told: global ones and its own project's, usable, seeds a structured memory replaced left out. */
export function usableKnowledge(items = [], { project = 'global' } = {}) {
  const wanted = String(project || 'global').toLowerCase();
  const replaced = new Set();
  for (const item of items) if (item?.structured) for (const id of item.links || []) replaced.add(id);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.id || !item.statement || item.statement.length < 8) continue;
    const scope = String(item.project || 'global').toLowerCase();
    if (scope !== 'global' && scope !== wanted) continue;
    if (!item.structured && replaced.has(item.id)) continue;
    const key = normalizeText(item.statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Highest score first; a structured statement before a seed on a tie, then the newest, then the id. */
export function rankKnowledge(items = [], now = Date.now()) {
  return items
    .map((item) => ({ item, score: knowledgeScore(item, now) }))
    .sort((a, b) => b.score - a.score
      || Number(b.item.structured) - Number(a.item.structured)
      || String(b.item.updatedAt || '').localeCompare(String(a.item.updatedAt || ''))
      || String(a.item.id).localeCompare(String(b.item.id)));
}

/**
 * The digest: the header, then `- statement` lines, ranked, at most `perFacet` per facet, inside
 * `maxTokens`. Deterministic for the same rows and the same `now`.
 * → { text, tokens, rows:[{ id, revision, statement, facet, seed, tokens }], omitted, candidates }
 *   (text '' and no rows when nothing is usable: no header on its own)
 */
export function renderDigest(items = [], { project = 'global', now = Date.now(), maxTokens = DIGEST.maxTokens, perFacet = DIGEST.perFacet } = {}) {
  const ranked = rankKnowledge(usableKnowledge(items, { project }), now);
  const perFacetCount = new Map();
  const rows = [];
  let text = DIGEST_HEADER;
  let omitted = 0;
  for (const { item } of ranked) {
    const count = perFacetCount.get(item.facet) || 0;
    if (count >= perFacet) { omitted += 1; continue; }
    const line = `- ${item.statement}`;
    const next = `${text}\n${line}`;
    if (estimateTokens(next) > maxTokens) { omitted += 1; continue; }
    text = next;
    perFacetCount.set(item.facet, count + 1);
    rows.push({ id: item.id, revision: item.revision, statement: item.statement, facet: item.facet, seed: !item.structured, tokens: estimateTokens(line) });
  }
  if (!rows.length) return { text: '', tokens: 0, rows: [], omitted, candidates: ranked.length };
  return { text, tokens: estimateTokens(text), rows, omitted, candidates: ranked.length };
}

/** Cosine similarity of two equal-length vectors (0 when either is empty or zero). */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The `k` rows nearest to `vector` ({ id, vector } rows), best first, with their similarity. */
export function nearest(vector, rows = [], k = LEARN.knownStatements, floor = 0.25) {
  return rows
    .map((row) => ({ id: row.id, similarity: cosine(vector, row.vector) }))
    .filter((row) => row.similarity >= floor)
    .sort((a, b) => b.similarity - a.similarity || String(a.id).localeCompare(String(b.id)))
    .slice(0, k);
}
