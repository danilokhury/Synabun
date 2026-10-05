/**
 * A bounded, credential-free view of a file for a judgment about it.
 *
 * Shared by `sync` (a memory whose checksum changed) and the edit-time stale
 * check (a memory whose file was just edited). File content leaves the machine
 * in these judgments, so key and environment files are never read and every
 * excerpt passes through the credential redaction the log preview uses.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { redactCredentials } from './typesafe-config.js';

const HEAD_CHARS = 6000;
const EXCERPT_CHARS = 8000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Files whose content is a credential by construction. Never read, never judged. */
const DENIED_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.npmrc|\.netrc|\.pgpass|credentials(?:\..*)?)$/i;

export function isDeniedFile(filePath: string): boolean {
  return DENIED_FILE.test(basename(filePath));
}

/**
 * The head of the content plus the lines that mention identifiers the memory
 * talks about, so a memory about one function is judged against that function
 * even in a long file.
 */
export function excerptFromContent(content: string, memoryContent: string): { excerpt: string; truncated: boolean } {
  if (content.length <= EXCERPT_CHARS) return { excerpt: redactCredentials(content), truncated: false };
  const identifiers = new Set<string>();
  for (const m of memoryContent.matchAll(/`([^`\n]{3,60})`/g)) identifiers.add(m[1].trim());
  for (const m of memoryContent.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:[A-Z][a-z0-9]+|_[a-z0-9]+)[A-Za-z0-9_$]*)\b/g)) if (m[1].length >= 5) identifiers.add(m[1]);
  const head = content.slice(0, HEAD_CHARS);
  const extra: string[] = [];
  let budget = EXCERPT_CHARS - head.length;
  if (identifiers.size) {
    const lines = content.slice(HEAD_CHARS).split('\n');
    for (const [i, line] of lines.entries()) {
      if (budget <= 0) break;
      if ([...identifiers].some(id => line.includes(id))) {
        const tagged = `L${Math.max(1, head.split('\n').length + i)}: ${line.slice(0, 200)}`;
        extra.push(tagged); budget -= tagged.length + 1;
      }
    }
  }
  const excerpt = extra.length ? `${head}\n… [lines mentioning identifiers from the memory] …\n${extra.join('\n')}` : head;
  return { excerpt: redactCredentials(excerpt), truncated: true };
}

/** Read and excerpt a file, or null when it is denied, too large or unreadable. */
export function fileExcerpt(filePath: string, memoryContent: string): { excerpt: string; truncated: boolean } | null {
  try {
    if (isDeniedFile(filePath)) return null;
    if (statSync(filePath).size > MAX_FILE_BYTES) return null;
    return excerptFromContent(readFileSync(filePath, 'utf8'), memoryContent);
  } catch { return null; }
}
