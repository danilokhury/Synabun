// ═══════════════════════════════════════════
// SynaBun — ruleset text normalisation and hashing
// ═══════════════════════════════════════════
//
// One definition of "the same text" for the renderer, the managed blocks, the
// installer and the legacy-copy detector: LF line endings, no trailing
// whitespace on a line, no blank lines around the text. Pure, no fs.

import { createHash } from 'node:crypto';

/** LF line endings, trailing whitespace trimmed per line, outer blank lines trimmed. */
export function normalise(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\n|\r/).map((line) => line.replace(/\s+$/, ''));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end).join('\n');
}

/** First 12 hex of SHA-256 over the normalised text. */
export function sha12(text) {
  return createHash('sha256').update(normalise(text), 'utf8').digest('hex').slice(0, 12);
}
