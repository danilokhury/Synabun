import { z } from 'zod';
import { scrollMemories } from '../services/sqlite.js';
import { hashFile } from '../services/file-checksums.js';
import type { MemoryPayload } from '../types.js';
import { coerceStringArray } from './utils.js';
import { text } from './response.js';

export const syncSchema = {
  project: z
    .string()
    .optional()
    .describe('Optional: only check memories for this project.'),
  categories: coerceStringArray()
    .optional()
    .describe('Optional: filter results to memories in these categories only.'),
  limit: z
    .coerce.number()
    .min(1)
    .max(1000)
    .optional()
    .describe('Max stale memories to return (default 50). Keep low to avoid output overflow.'),
};

export const syncDescription =
  'Check for stale memories whose related files have changed. Compares stored file checksums against current hashes. Returns compact output (ID + changed files only, no content). IMPORTANT: Always pass "categories" to scope the scan — calling without categories scans ALL memories and may produce output too large to return inline. For large memory sets, call iteratively per category rather than globally. Default limit is 50; increase only when using a narrow category filter.';

export async function handleSync(args: { project?: string; categories?: string[]; limit?: number }) {
  // Scroll all memories (paginated)
  const allPoints: Array<{ id: string | number; payload: unknown }> = [];
  let offset: string | undefined;

  do {
    const filter = args.project
      ? { must: [{ key: 'project', match: { value: args.project } }] }
      : undefined;
    const result = await scrollMemories(filter, 100, offset);
    for (const p of result.points) {
      if (p.payload) allPoints.push({ id: p.id, payload: p.payload });
    }
    offset = (result.next_page_offset as string) ?? undefined;
  } while (offset);

  // Only evaluate memories with stored file_checksums — we need a baseline to compare against.
  // Memories with related_files but no checksums are legacy; we can't determine staleness without a baseline.
  const withChecksums = allPoints.filter(p => {
    const payload = p.payload as unknown as MemoryPayload;
    return payload.file_checksums && Object.keys(payload.file_checksums).length > 0;
  });

  const stale: Array<{
    id: string | number;
    category: string;
    importance: number;
    stale_files: string[];
  }> = [];

  for (const point of withChecksums) {
    const payload = point.payload as unknown as MemoryPayload;
    const storedChecksums = payload.file_checksums!;
    const staleFiles: string[] = [];

    for (const filePath of Object.keys(storedChecksums)) {
      const currentHash = hashFile(filePath);
      if (!currentHash) continue; // File not found — can't compare, skip

      const storedHash = storedChecksums[filePath];
      if (currentHash !== storedHash) {
        staleFiles.push(filePath);
      }
    }

    if (staleFiles.length > 0) {
      stale.push({
        id: point.id,
        category: payload.category,
        importance: payload.importance,
        stale_files: staleFiles,
      });
    }
  }

  // Apply category filter if provided
  const filtered = args.categories && args.categories.length > 0
    ? stale.filter(m => args.categories!.includes(m.category))
    : stale;

  if (filtered.length === 0) {
    const scopeMsg = args.categories ? ` in categories [${args.categories.join(', ')}]` : '';
    return text(`All clear — checked ${withChecksums.length} memories with stored checksums${scopeMsg}, none are stale.`);
  }

  // Sort by importance descending
  filtered.sort((a, b) => b.importance - a.importance);

  // Apply limit
  const maxResults = args.limit ?? 50;
  const limited = filtered.slice(0, maxResults);
  const truncated = filtered.length > maxResults;

  // Compact output — IDs and changed files only, no full content
  const scopeMsg = args.categories ? ` in [${args.categories.join(', ')}]` : '';
  let msg = `Found ${filtered.length} stale memories${scopeMsg} (out of ${withChecksums.length} with checksums)`;
  if (truncated) msg += ` — showing first ${maxResults}`;
  msg += `:\n\n`;

  for (const mem of limited) {
    msg += `${mem.id} | ${mem.category} | imp:${mem.importance}\n`;
    msg += `  Changed: ${mem.stale_files.join(', ')}\n`;
  }

  msg += `\nTo get full content: use recall with the memory ID, or memories with action "by-category".`;

  return text(msg);
}
