/**
 * Secret gate: keep credentials out of the memory store.
 *
 * SynaBun used to store whatever it was handed, and a memory is embedded and
 * kept forever. A regex prefilter finds credential-looking spans; when the
 * judgment is available it decides, per span, whether the value is a real
 * secret or a placeholder/example/identifier, so documentation snippets do
 * not get mangled. Without the judgment only the high-precision patterns
 * (key prefixes, private-key envelopes, JWTs) are redacted.
 *
 * Reusable outside the write path: a scan over existing rows can call
 * `redactSecrets` on stored content without touching the tool layer.
 */

import { findCredentialSpans, redactSpans, surfaceConfig, type CredentialSpan } from './typesafe-config.js';
import { judgeSecretSpans, type JudgeContext } from './memory-judgments.js';

export interface Redaction { type: string; judged: boolean; probability: number | null }
export interface RedactionResult {
  text: string;
  redactions: Redaction[];
  /** True when nothing but a credential remained: the caller must refuse the write. */
  refused: boolean;
  /** Whether the judgment answered (false = precise-only fallback). */
  judged: boolean;
}

const MAX_JUDGED_SPANS = 8;
/** "Nothing but a credential": fewer than this many words survive the redaction. */
const MIN_REMAINING_WORDS = 3;

export async function redactSecrets(text: string, options: JudgeContext = {}): Promise<RedactionResult> {
  const spans = findCredentialSpans(text);
  if (!spans.length) return { text, redactions: [], refused: false, judged: false };
  const settings = surfaceConfig('secret-gate');
  const threshold = settings.minConfidence ?? 0.7;
  const asked = spans.slice(0, MAX_JUDGED_SPANS);
  const verdicts = settings.enabled ? await judgeSecretSpans(text, asked.map(s => ({ value: s.text, type: s.type })), options) : null;
  const chosen: CredentialSpan[] = [];
  const redactions: Redaction[] = [];
  spans.forEach((span, i) => {
    const p = verdicts && i < asked.length ? verdicts[i] : null;
    const redact = p === null ? span.precise : p >= threshold;
    if (!redact) return;
    chosen.push(span);
    redactions.push({ type: span.type, judged: p !== null, probability: p });
  });
  if (!chosen.length) return { text, redactions: [], refused: false, judged: verdicts !== null };
  const redacted = redactSpans(text, chosen);
  const remainingWords = redacted.replace(/\[redacted:[a-z-]+\]/g, ' ').match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return { text: redacted, redactions, refused: remainingWords.length < MIN_REMAINING_WORDS, judged: verdicts !== null };
}
