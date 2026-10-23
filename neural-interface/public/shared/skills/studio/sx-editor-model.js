// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: what the editor shows about a document
// ═══════════════════════════════════════════
//
// The facts of the status bar (lines, line endings, byte-order mark, bytes, an estimate of tokens with how it is
// estimated), the description helper (how much of each runtime's budget a description uses, and whether it says
// what the skill does and when to use it), the keys the form does not edit ("kept as written", the Advanced
// section), and what kind of file a path is (Markdown, YAML, an image the viewer can show, other binary).
// Measurements are named for what they are: characters, bytes, lines and an estimate of tokens (characters ÷ 4,
// said as an estimate) are kept apart (master plan §3.2). No DOM; imports only what the page and the server share.

import { PROFILES } from '../ss-profiles.js';
import { FORM_FIELDS } from '../ss-form.js';

/** Characters per token of the estimate (the usual rule of thumb for English text; said as "≈" with its method). */
export const CHARS_PER_TOKEN = 4;
/** The guidance for a SKILL.md body (Agent Skills and Claude Code best practice), not an upload limit. */
export const BODY_GUIDANCE = Object.freeze({ lines: PROFILES['portable-six-field'].limits.bodyLinesGuidance, tokens: PROFILES['portable-six-field'].limits.bodyTokensGuidance });

/** An estimate of tokens: characters ÷ 4, rounded up. */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);

/** UTF-8 length of a text, without a TextEncoder (the page and Node count the same). */
export function utf8Length(text) {
  const s = String(text ?? '');
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xFC00) === 0xDC00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

const EXT = (path) => { const base = String(path ?? '').split('/').pop() || ''; const at = base.lastIndexOf('.'); return at > 0 ? base.slice(at + 1).toLowerCase() : ''; };
const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

/** What a file is, for the tree and the viewer. */
export function fileKind(path, { binary = false } = {}) {
  const ext = EXT(path);
  if (IMAGE_EXT[ext]) return { kind: 'image', mime: IMAGE_EXT[ext], ext };
  if (binary) return { kind: 'binary', mime: 'application/octet-stream', ext };
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown', mime: 'text/markdown', ext };
  if (ext === 'yaml' || ext === 'yml') return { kind: 'yaml', mime: 'text/yaml', ext };
  if (ext === 'json') return { kind: 'json', mime: 'application/json', ext };
  if (['sh', 'bash', 'zsh', 'py', 'js', 'mjs', 'ts', 'rb', 'ps1'].includes(ext)) return { kind: 'script', mime: 'text/plain', ext };
  return { kind: 'text', mime: 'text/plain', ext };
}

/** The line endings of a document, as the status bar says them. */
export function eolLabel({ eol = '\n', mixed = false } = {}) {
  if (mixed) return 'mixed';
  return eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF';
}

/**
 * The facts of the status bar for one document.
 * @param {{ path: string|null, text: string, eol?: string, mixed?: boolean, bom?: boolean, binary?: boolean,
 *   size?: number, head?: boolean }} doc `head`: the skill's SKILL.md (its body is measured against the guidance)
 */
export function documentFacts(doc) {
  const text = String(doc?.text ?? '');
  const lines = text === '' ? 1 : text.split('\n').length;
  const facts = {
    binary: !!doc?.binary,
    lines: doc?.binary ? null : lines,
    chars: doc?.binary ? null : text.length,
    bytes: doc?.binary ? (Number(doc?.size) || 0) : utf8Length(text) + (doc?.bom ? 3 : 0),
    tokens: doc?.binary ? null : estimateTokens(text),
    eol: doc?.binary ? null : eolLabel(doc || {}),
    bom: !!doc?.bom,
    kind: fileKind(doc?.path || 'SKILL.md', { binary: !!doc?.binary }).kind,
    guidance: null,
  };
  if (doc?.head && !doc?.binary) {
    const body = bodyOf(text);
    const bodyLines = body.text === '' ? 0 : body.text.split('\n').length;
    const bodyTokens = estimateTokens(body.text);
    facts.guidance = {
      lines: bodyLines, tokens: bodyTokens, maxLines: BODY_GUIDANCE.lines, maxTokens: BODY_GUIDANCE.tokens,
      ratio: Math.min(1, Math.max(bodyLines / BODY_GUIDANCE.lines, bodyTokens / BODY_GUIDANCE.tokens)),
      over: bodyLines > BODY_GUIDANCE.lines || bodyTokens > BODY_GUIDANCE.tokens,
    };
  }
  return facts;
}

/** The body of a document (after its frontmatter), with the line it starts on. */
export function bodyOf(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(s);
  if (!m) return { text: s, line: 1 };
  return { text: s.slice(m[0].length), line: m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0) + 1 };
}

// ── The description helper ──

/** The description budgets of each runtime: characters used and allowed. Claude Code lists description and when_to_use together. */
export function descriptionBudgets(data) {
  const d = typeof data?.description === 'string' ? data.description : '';
  const when = typeof data?.when_to_use === 'string' ? data.when_to_use : '';
  const rows = [
    { id: 'portable-six-field', runtime: 'portable', limit: PROFILES['portable-six-field'].limits.descriptionChars, used: d.length },
    { id: 'claude-code', runtime: 'claude', limit: PROFILES['claude-code'].limits.listingChars, used: d.length + when.length, listing: true },
    { id: 'codex-native', runtime: 'codex', limit: PROFILES['codex-native'].limits.descriptionChars, used: d.length },
    { id: 'opencode-native', runtime: 'opencode', limit: PROFILES['opencode-native'].limits.descriptionChars, used: d.length },
  ];
  return rows.map((r) => ({ ...r, over: r.used > r.limit, ratio: r.limit ? Math.min(1, r.used / r.limit) : 0 }));
}

// Words that say when a skill applies (English and Portuguese), the cue a model reads to decide.
const WHEN_CUES = [
  /\buse (?:it |this(?: skill)? |me )?(?:when|whenever|for|if|to)\b/i,
  /\bwhen(?:ever)? (?:the user|you|a user|someone|asked|working|preparing|writing|creating|editing|reviewing)\b/i,
  /\btriggers? (?:on|when)\b/i,
  /\b(?:invoke|apply|run) (?:it |this )?(?:when|whenever|for)\b/i,
  /\bquando (?:o usuário|a usuária|você|alguém|for|precisar|pedir)\b/i,
  /\buse (?:quando|para|se)\b/i,
];

/** Whether a description says when the skill applies (the cue a model reads to pick it). */
export const describesWhen = (text) => WHEN_CUES.some((re) => re.test(String(text ?? '')));

/** Whether a description says what the skill does: more than a few words of its own. */
export function describesWhat(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length >= 4;
}

/**
 * What the description helper says: the budgets, and whether "what" and "when" are there.
 * @returns {{ budgets: object[], what: boolean, when: boolean, empty: boolean, advice: 'ok'|'add-when'|'add-what'|'write-one'|'too-long' }}
 */
export function descriptionHelp(data) {
  const text = typeof data?.description === 'string' ? data.description : '';
  const budgets = descriptionBudgets(data);
  const empty = !text.trim();
  const what = !empty && describesWhat(text);
  const when = !empty && (describesWhen(text) || (typeof data?.when_to_use === 'string' && data.when_to_use.trim() !== ''));
  const advice = empty ? 'write-one' : budgets.some((b) => b.over) ? 'too-long' : !what ? 'add-what' : !when ? 'add-when' : 'ok';
  return { budgets, what, when, empty, advice };
}

// ── Keys the form leaves alone ──

/**
 * The frontmatter keys the form has no field for, each with the lines it is written on: the Advanced section
 * lists them so it is plain they are kept, byte for byte.
 * @param {'skill'|'agent'|'command'} type
 * @param {object} parsed ss-frontmatter.js parse()
 * @param {string} text the document ("\n" line breaks)
 */
export function keptKeys(type, parsed, text) {
  const known = new Set((FORM_FIELDS[type] || []).map((f) => f.key));
  const keys = Array.isArray(parsed?.keys) ? parsed.keys : [];
  const lines = String(text ?? '').split('\n');
  const close = (() => {
    if (!parsed?.hasFrontmatter) return 0;
    for (let i = 1; i < lines.length; i++) if (/^---[ \t]*$/.test(lines[i])) return i + 1;   // 1-based line of the closing ---
    return lines.length;
  })();
  const out = [];
  keys.forEach((k, i) => {
    if (known.has(k.key)) return;
    const from = k.line;
    const to = (keys[i + 1]?.line ?? close) - 1;
    const body = lines.slice(from - 1, Math.max(from, to)).join('\n').replace(/\s+$/, '');
    out.push({ key: k.key, line: from, kind: k.kind, text: body.length > 600 ? `${body.slice(0, 600)}…` : body });
  });
  return out;
}

/** The frontmatter block as written (for the YAML view), or '' when there is none. */
export function frontmatterText(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(s);
  return m ? m[1] : '';
}

/** A line and column (1-based) of a diagnostic, kept inside the document. */
export function clampLine(line, text) {
  const n = String(text ?? '').split('\n').length;
  const l = Number.isInteger(line) && line > 0 ? line : 1;
  return Math.min(l, n);
}

/** The short revision label of a digest (`sha256:abcdef…` → `abcdef1`), or ''. */
export function shortDigest(digest) {
  const m = /^sha256:([0-9a-f]{7,})/.exec(String(digest ?? ''));
  return m ? m[1].slice(0, 7) : '';
}
