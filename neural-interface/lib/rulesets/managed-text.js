// ═══════════════════════════════════════════
// SynaBun — managed rule blocks (pure text, no fs)
// ═══════════════════════════════════════════
//
// SynaBun's rules sit in a user's instruction file between two markers:
//
//   <!-- synabun:rules:begin v=2.0.0 host=codex sha=9f2c1a7b3e4d -->
//   <!-- Managed by SynaBun. Edit this block and SynaBun stops updating it; … -->
//   ...rendered rules...
//   <!-- synabun:rules:end -->
//
// The sha covers everything between the begin and end lines, so a block says
// by itself whether someone edited it. Every function here leaves each byte
// outside the markers alone, keeps the file's line endings and BOM, and
// refuses to guess when the markers are damaged.
//
// Fenced code (``` and ~~~) is somebody quoting text, never the live thing: a
// marker or an old ruleset inside a fence is not seen by anything here.

import { createHash } from 'node:crypto';
import { normalise, sha12 } from './normalise.js';

export const MANAGED_NOTE = '<!-- Managed by SynaBun. Edit this block and SynaBun stops updating it; remove it in SynaBun Settings > Setup. -->';
export const END_MARKER = '<!-- synabun:rules:end -->';
export const LEGACY_HEADINGS = Object.freeze(['## Memory Ruleset', '## Memory: SynaBun MCP', '## Persistent Memory']);

const BEGIN_RE = /^<!-- synabun:rules:begin v=(\S+) host=([a-z0-9-]+) sha=([0-9a-f]{12}) -->$/;
const BEGIN_HINT = 'synabun:rules:begin';
const END_HINT = 'synabun:rules:end';
const BOM = '﻿';

export class ManagedTextConflict extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedTextConflict';
    this.code = code;
  }
}

export function hasBom(text) {
  return String(text ?? '').startsWith(BOM);
}

/** The file's own line ending: CRLF when most of its lines end that way, LF otherwise. */
export function detectEol(text) {
  const source = String(text ?? '');
  const crlf = source.split('\r\n').length - 1;
  const lf = source.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function toEol(text, eol) {
  const lf = String(text).replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

/** [{start, end, eolEnd, text}]: `end` stops before the line break, `eolEnd` after it. */
function scanLines(text) {
  const lines = [];
  let pos = hasBom(text) ? 1 : 0;
  while (pos < text.length) {
    const lf = text.indexOf('\n', pos);
    if (lf === -1) {
      lines.push({ start: pos, end: text.length, eolEnd: text.length, text: text.slice(pos) });
      break;
    }
    const end = lf > pos && text[lf - 1] === '\r' ? lf - 1 : lf;
    lines.push({ start: pos, end, eolEnd: lf + 1, text: text.slice(pos, end) });
    pos = lf + 1;
  }
  return lines;
}

function endsWithEol(text) {
  return text.endsWith('\n');
}

function stripOneEol(text) {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

function startsWithEol(text) {
  return text.startsWith('\r\n') || text.startsWith('\n');
}

function dropLeadingEol(text) {
  if (text.startsWith('\r\n')) return text.slice(2);
  if (text.startsWith('\n')) return text.slice(1);
  return text;
}

/** wrap(text, {version, host}) → the stamped block, LF line endings, no trailing newline. */
export function wrap(text, { version, host } = {}) {
  if (!version || !host) throw new Error('wrap needs a version and a host');
  const body = `${MANAGED_NOTE}\n${normalise(text)}`;
  return `<!-- synabun:rules:begin v=${version} host=${host} sha=${sha12(body)} -->\n${body}\n${END_MARKER}`;
}

const FENCE_OPEN_RE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/;

/** {char, size} when the line opens a fenced code block, else null. Read generously: quoted text is left alone. */
function fenceOpening(line) {
  const match = line.match(FENCE_OPEN_RE);
  if (!match) return null;
  // A backtick fence cannot carry a backtick in its info string: that is inline code.
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { char: match[1][0], size: match[1].length };
}

function fenceCloses(line, fence) {
  const match = line.match(FENCE_OPEN_RE);
  return !!match && match[1][0] === fence.char && match[1].length >= fence.size && match[2].trim() === '';
}

/**
 * One pass over the file: the managed blocks, the marker conflict if any, and
 * which lines sit inside a fenced code block. A block that is open is opaque
 * (its own body may hold fences); a fence that is open hides every marker in
 * it, and an unclosed fence runs to the end of the file as it does in Markdown.
 */
function analyse(text) {
  const lines = scanLines(text);
  const fenced = new Array(lines.length).fill(false);
  const blocks = [];
  let conflict = null;
  let open = null;
  let fence = null;
  const flag = (code, message) => { if (!conflict) conflict = { code, message }; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text.replace(/\s+$/, '');
    if (!open) {
      if (fence) {
        fenced[i] = true;
        if (fenceCloses(line, fence)) fence = null;
        continue;
      }
      fence = fenceOpening(line);
      if (fence) { fenced[i] = true; continue; }
    }
    if (line.includes(BEGIN_HINT)) {
      const match = line.match(BEGIN_RE);
      if (!match) { flag('malformed-begin', 'A SynaBun begin marker is damaged'); continue; }
      if (open) flag('begin-without-end', 'A SynaBun begin marker has no end marker');
      open = { index: i, version: match[1], host: match[2], sha: match[3] };
      continue;
    }
    if (line.includes(END_HINT)) {
      if (line !== END_MARKER) { flag('malformed-end', 'A SynaBun end marker is damaged'); continue; }
      if (!open) { flag('end-without-begin', 'A SynaBun end marker has no begin marker'); continue; }
      const first = lines[open.index];
      blocks.push({
        start: first.start,
        end: lines[i].end,
        eolEnd: lines[i].eolEnd,
        version: open.version,
        host: open.host,
        sha: open.sha,
        body: lines.slice(open.index + 1, i).map((entry) => entry.text).join('\n'),
        text: text.slice(first.start, lines[i].end),
      });
      open = null;
    }
  }
  if (open) flag('begin-without-end', 'A SynaBun begin marker has no end marker');
  if (blocks.length > 1) flag('duplicate-blocks', 'More than one SynaBun rules block');
  return { lines, fenced, blocks, conflict };
}

/**
 * findBlocks(fileText) → {blocks, conflict}.
 * A block is {start, end, eolEnd, version, host, sha, body, text}; `text` runs
 * from the begin marker to the end marker. `conflict` is null, or {code,
 * message} when the markers cannot be trusted: two blocks, a begin without an
 * end, an end without a begin, or a begin line that does not parse. Markers
 * inside a fenced code block are quoted text and are not read at all.
 */
export function findBlocks(fileText) {
  const { blocks, conflict } = analyse(String(fileText ?? ''));
  return { blocks, conflict };
}

function singleBlock(fileText) {
  const { blocks, conflict } = findBlocks(fileText);
  if (conflict) throw new ManagedTextConflict(conflict.code, conflict.message);
  return blocks[0] || null;
}

/** True while the body still hashes to its own stamp. Takes a block from findBlocks or a block's text. */
export function isPristine(block) {
  let parsed = block;
  if (typeof block === 'string') {
    const found = findBlocks(block);
    if (found.conflict || found.blocks.length !== 1) return false;
    parsed = found.blocks[0];
  }
  if (!parsed || typeof parsed.body !== 'string' || !parsed.sha) return false;
  return sha12(parsed.body) === parsed.sha;
}

/**
 * Replace the existing block in place, else append it with one blank line
 * before it. Throws ManagedTextConflict when the markers are damaged.
 */
export function upsertBlock(fileText, block) {
  const text = String(fileText ?? '');
  const existing = singleBlock(text);
  const eol = detectEol(text);
  const inserted = toEol(block, eol);
  if (existing) return text.slice(0, existing.start) + inserted + text.slice(existing.end);
  const content = hasBom(text) ? text.slice(1) : text;
  if (content === '') return text + inserted + eol;
  // A file that ends without a line break keeps ending without one, so the
  // removal below can give back exactly the bytes it started from.
  if (endsWithEol(text)) return text + eol + inserted + eol;
  return text + eol + eol + inserted;
}

/** Remove the block and the blank line the insert added. Unchanged when there is no block. */
export function removeBlock(fileText) {
  const text = String(fileText ?? '');
  const existing = singleBlock(text);
  if (!existing) return text;
  let before = text.slice(0, existing.start);
  const after = text.slice(existing.eolEnd);
  const blockHadEol = existing.eolEnd > existing.end;
  const floor = hasBom(before) ? 1 : 0;
  const blankBefore = () => before.length > floor && endsWithEol(before) && (stripOneEol(before).length === floor || endsWithEol(stripOneEol(before)));
  if (blockHadEol || after.length > 0) {
    if (blankBefore()) before = stripOneEol(before);
  } else if (blankBefore()) {
    before = stripOneEol(stripOneEol(before));
  }
  return before + after;
}

/** Put `block` over the characters [start, end) in the file's own line endings. */
export function replaceRange(fileText, start, end, block) {
  const text = String(fileText ?? '');
  return text.slice(0, start) + toEol(block, detectEol(text)) + text.slice(end);
}

/** Cut the lines [start, end) and one of the blank lines that surrounded them. */
export function removeRange(fileText, start, end) {
  const text = String(fileText ?? '');
  let before = text.slice(0, start);
  let after = dropLeadingEol(text.slice(end));
  const floor = hasBom(before) ? 1 : 0;
  const blankBefore = before.length === floor || (endsWithEol(before) && (stripOneEol(before).length === floor || endsWithEol(stripOneEol(before))));
  if (blankBefore && startsWithEol(after)) after = dropLeadingEol(after);
  else if (after === '' && before.length > floor && blankBefore) before = stripOneEol(before);
  return before + after;
}

function isLegacyHeading(line) {
  return LEGACY_HEADINGS.find((heading) => line === heading || line.startsWith(`${heading} `) || line.startsWith(`${heading}:`)) || null;
}

/**
 * findLegacy(fileText, legacyHashes) → [{start, end, kind, sha?, host?, hosts?, heading?}]
 * exact   = a run of lines whose normalised hash and line count match a ruleset
 *           SynaBun served before the managed blocks existed; `hosts` names
 *           every tool that text was served for (`host` is the first of them)
 * heading = one of the old ruleset headings with no exact match around it
 * `start` and `end` are character offsets; `end` stops before the last line's
 * line break. Text inside a managed block or a fenced code block is never
 * reported: the first is SynaBun's own, the second is someone quoting it.
 */
export function findLegacy(fileText, legacyHashes) {
  const text = String(fileText ?? '');
  const entries = Array.isArray(legacyHashes) ? legacyHashes : (legacyHashes?.entries || []);
  const { lines, fenced, blocks: managed } = analyse(text);
  const trimmed = lines.map((line) => line.text.replace(/\s+$/, ''));
  const inManaged = (line) => managed.some((block) => line.start >= block.start && line.start < block.eolEnd);

  const byFirstLine = new Map();
  const hostsOf = new Map();
  for (const entry of entries) {
    if (!entry?.sha || !entry.firstLine || !(entry.lines > 0)) continue;
    if (!byFirstLine.has(entry.firstLine)) byFirstLine.set(entry.firstLine, []);
    byFirstLine.get(entry.firstLine).push(entry);
    const key = `${entry.sha}:${entry.lines}`;
    if (!hostsOf.has(key)) hostsOf.set(key, []);
    if (entry.host && !hostsOf.get(key).includes(entry.host)) hostsOf.get(key).push(entry.host);
  }
  for (const list of byFirstLine.values()) list.sort((a, b) => b.lines - a.lines);

  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || inManaged(lines[i])) continue;
    let matched = null;
    for (const entry of byFirstLine.get(trimmed[i]) || []) {
      if (i + entry.lines > lines.length) continue;
      // A copy that runs into a code fence or a managed block is not a plain pasted copy.
      if (fenced[i + entry.lines - 1] || inManaged(lines[i + entry.lines - 1])) continue;
      const candidate = trimmed.slice(i, i + entry.lines).join('\n');
      if (createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 12) !== entry.sha) continue;
      matched = entry;
      break;
    }
    if (matched) {
      const last = lines[i + matched.lines - 1];
      const hosts = hostsOf.get(`${matched.sha}:${matched.lines}`) || [];
      spans.push({ start: lines[i].start, end: last.end, kind: 'exact', sha: matched.sha, host: matched.host || null, hosts });
      i += matched.lines - 1;
      continue;
    }
    const heading = isLegacyHeading(trimmed[i]);
    if (heading) spans.push({ start: lines[i].start, end: lines[i].end, kind: 'heading', heading });
  }
  return spans;
}
