// ═══════════════════════════════════════════
// SynaBun — Style Guide project pointers (pure text, no fs)
// ═══════════════════════════════════════════
//
// For agents that only read a project's instruction files: an opt-in block in
// <project>/CLAUDE.md and <project>/AGENTS.md that says the project has a
// DESIGN.md and how to use it.
//
//   <!-- synabun:styleguide:begin v=1 sha=9f2c1a7b3e4d -->
//   ## Design system
//   …
//   <!-- synabun:styleguide:end -->
//
// The markers are deliberately not the rules installer's (`synabun:rules:…`): a
// project file may already hold SynaBun's rules block, and that module treats a
// second block, or a block stamped for a host it does not know, as a conflict it
// must not touch. These two never see each other. Line endings and a BOM are kept
// (detectEol / hasBom from rulesets/managed-text.js); every byte outside the
// markers is left alone.

import { detectEol, hasBom } from '../rulesets/managed-text.js';
import { normalise, sha12 } from '../rulesets/normalise.js';
import { STYLE_GUIDE_OUT_DIR } from './schema.js';

export const POINTER_VERSION = '1';
export const POINTER_FILES = Object.freeze(['CLAUDE.md', 'AGENTS.md']);
export const POINTER_END = '<!-- synabun:styleguide:end -->';
const BEGIN_RE = /^<!-- synabun:styleguide:begin v=(\S+) sha=([0-9a-f]{12}) -->$/;

/** The sentences the block carries, for this guide's export settings. */
export function pointerText(config = {}) {
  const dir = config.exports?.outDir || STYLE_GUIDE_OUT_DIR;
  const files = [];
  if (config.exports?.cssVars !== false) files.push(`\`${dir}/tokens.css\``);
  if (config.exports?.tokensJson !== false) files.push(`\`${dir}/tokens.json\``);
  const tokens = files.length ? ` and use its tokens (${files.join(', ')})` : ' and use its tokens';
  return [
    '## Design system',
    `This project has a SynaBun Style Guide. Read \`DESIGN.md\` before UI, design, copy or creative work${tokens}. Never edit those files by hand; propose changes with the \`style_guide\` tool (action \`propose\`).`,
  ].join('\n');
}

/** The stamped block, LF line endings, no trailing newline. */
export function pointerBlock(config = {}) {
  const body = normalise(pointerText(config));
  return `<!-- synabun:styleguide:begin v=${POINTER_VERSION} sha=${sha12(body)} -->\n${body}\n${POINTER_END}`;
}

/** { start, end, eolEnd, sha, body } of the block in a file, or null. `damaged` when a marker has no partner. */
export function findPointer(fileText) {
  const text = String(fileText ?? '');
  let pos = hasBom(text) ? 1 : 0;
  let begin = null;
  let damaged = false;
  let found = null;
  while (pos <= text.length) {
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? text.length : lf;
    const end = lineEnd > pos && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = text.slice(pos, end).replace(/\s+$/, '');
    const match = BEGIN_RE.exec(line);
    if (match) { if (begin) damaged = true; begin = { start: pos, sha: match[2], bodyStart: lf === -1 ? text.length : lf + 1 }; }
    else if (line === POINTER_END) {
      if (!begin) damaged = true;
      else {
        if (found) damaged = true;
        found = { start: begin.start, end, eolEnd: lf === -1 ? text.length : lf + 1, sha: begin.sha, body: text.slice(begin.bodyStart, pos).replace(/\r\n/g, '\n').replace(/\n$/, ''), damaged: false };
        begin = null;
      }
    } else if (line.includes('synabun:styleguide:')) damaged = true;
    if (lf === -1) break;
    pos = lf + 1;
  }
  return begin || damaged ? { damaged: true } : found;
}

const toEol = (text, eol) => (eol === '\n' ? text : text.replace(/\n/g, eol));

/** The file with the block in it: replaced in place, else appended after one blank line. Throws when the markers are damaged. */
export function upsertPointer(fileText, block) {
  const text = String(fileText ?? '');
  const found = findPointer(text);
  if (found?.damaged) throw new Error('The SynaBun style-guide markers in this file are damaged');
  const eol = detectEol(text);
  const inserted = toEol(block, eol);
  if (found) return text.slice(0, found.start) + inserted + text.slice(found.end);
  const content = hasBom(text) ? text.slice(1) : text;
  if (content === '') return `${text}${inserted}${eol}`;
  const separator = text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
  return `${text}${separator}${inserted}${eol}`;
}

/** The file without the block (and without the blank line before it). Unchanged when there is none. */
export function removePointer(fileText) {
  const text = String(fileText ?? '');
  const found = findPointer(text);
  if (!found) return text;
  if (found.damaged) throw new Error('The SynaBun style-guide markers in this file are damaged');
  const before = text.slice(0, found.start);
  const after = text.slice(found.eolEnd);
  const joined = before + after;
  return joined === '﻿' ? '' : joined;
}
