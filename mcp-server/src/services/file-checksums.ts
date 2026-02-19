import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Returns the project root directory (two levels up from mcp-server/src/).
 * This matches where related_files paths are relative to.
 */
function getProjectRoot(): string {
  return resolve(import.meta.dirname || process.cwd(), '..', '..');
}

/**
 * Compute SHA-256 hash of a file's content.
 * Returns null if the file doesn't exist or can't be read.
 */
export function hashFile(filePath: string): string | null {
  try {
    const absPath = resolve(getProjectRoot(), filePath);
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
