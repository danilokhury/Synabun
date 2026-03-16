import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Compute SHA-256 hash of a file's content.
 * Absolute paths are used as-is. Relative paths resolve from process.cwd()
 * (which is the project root when invoked by Claude Code).
 * Returns null if the file doesn't exist or can't be read.
 */
export function hashFile(filePath: string): string | null {
  try {
    const absPath = resolve(filePath);
    const content = readFileSync(absPath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compute checksums for an array of related file paths.
 * Returns a Record mapping each file path to its SHA-256 hash.
 * Files that can't be read are omitted from the result.
 */
export function computeChecksums(filePaths: string[]): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const fp of filePaths) {
    const hash = hashFile(fp);
    if (hash) checksums[fp] = hash;
  }
  return checksums;
}
