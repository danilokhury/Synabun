import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { isHttpMode } from './identity.js';

/**
 * Where a stored file path points. Absolute paths are used as-is. A relative
 * path is relative to its project's root (`baseDir`, from the project
 * registry). Without one, it falls back to process.cwd() only for a stdio MCP
 * server, which Claude Code starts inside the project; over HTTP the process
 * is the Neural Interface, whose cwd says nothing about the caller, so an
 * unanchored relative path resolves to nothing rather than to the wrong file.
 */
export function resolveStoredPath(filePath: string, baseDir?: string | null): string | null {
  if (!filePath) return null;
  if (isAbsolute(filePath)) return filePath;
  if (baseDir) return resolve(baseDir, filePath);
  if (isHttpMode()) return null;
  return resolve(filePath);
}

/**
 * Compute SHA-256 hash of a file's content.
 * Returns null if the path cannot be anchored, or the file doesn't exist or
 * can't be read.
 */
export function hashFile(filePath: string, baseDir?: string | null): string | null {
  try {
    const absPath = resolveStoredPath(filePath, baseDir);
    if (!absPath) return null;
    const content = readFileSync(absPath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compute checksums for an array of related file paths.
 * Returns a Record mapping each file path (as given) to its SHA-256 hash.
 * Files that can't be read are omitted from the result.
 */
export function computeChecksums(filePaths: string[], baseDir?: string | null): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const fp of filePaths) {
    const hash = hashFile(fp, baseDir);
    if (hash) checksums[fp] = hash;
  }
  return checksums;
}
