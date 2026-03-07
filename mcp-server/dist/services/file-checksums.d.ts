/**
 * Compute SHA-256 hash of a file's content.
 * Absolute paths are used as-is. Relative paths resolve from process.cwd()
 * (which is the project root when invoked by Claude Code).
 * Returns null if the file doesn't exist or can't be read.
 */
export declare function hashFile(filePath: string): string | null;
/**
 * Compute checksums for an array of related file paths.
 * Returns a Record mapping each file path to its SHA-256 hash.
 * Files that can't be read are omitted from the result.
 */
export declare function computeChecksums(filePaths: string[]): Record<string, string>;
//# sourceMappingURL=file-checksums.d.ts.map