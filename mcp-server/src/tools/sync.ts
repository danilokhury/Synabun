import { z } from 'zod';
import { scrollMemories } from '../services/sqlite.js';
import { hashFile, resolveStoredPath } from '../services/file-checksums.js';
import { fileExcerpt } from '../services/file-excerpt.js';
import { recordStaleVerdict } from '../services/edit-stale.js';
import { getDb } from '../services/sqlite.js';
import { projectRoot } from '../config.js';
import { judgeStaleMemory } from '../services/memory-judgments.js';
import { surfaceConfig } from '../services/typesafe-config.js';
import type { MemoryPayload } from '../types.js';
import { coerceStringArray } from './utils.js';
import { text } from './response.js';

const MAX_JUDGED = 20;
const JUDGE_CONCURRENCY = 4;

// Moved to services/file-excerpt.ts (shared with the edit-time stale check);
// re-exported so existing importers keep working.
export { fileExcerpt };

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
    project: string;
    category: string;
    importance: number;
    stale_files: string[];
    content: string;
    /** Per changed file: P(memory still accurate), or null when unjudged. */
    verdicts: Record<string, number | null>;
  }> = [];

  for (const point of withChecksums) {
    const payload = point.payload as unknown as MemoryPayload;
    const storedChecksums = payload.file_checksums!;
    const staleFiles: string[] = [];

    for (const filePath of Object.keys(storedChecksums)) {
      const currentHash = hashFile(filePath, projectRoot(payload.project));
      if (!currentHash) continue; // File not found — can't compare, skip

      const storedHash = storedChecksums[filePath];
      if (currentHash !== storedHash) {
        staleFiles.push(filePath);
      }
    }

    if (staleFiles.length > 0) {
      stale.push({
        id: point.id,
        project: payload.project,
        category: payload.category,
        importance: payload.importance,
        stale_files: staleFiles,
        content: payload.content,
        verdicts: {},
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

  // A changed checksum only says the bytes moved. Ask, for the most important
  // changed memories, whether what the memory claims moved with them. One
  // request per (memory, file); bounded, concurrent, never blocking the diff.
  const settings = surfaceConfig('stale-check');
  const threshold = settings.minConfidence ?? 0.6;
  let judgedPairs = 0;
  if (settings.enabled) {
    const pairs: Array<{ mem: (typeof limited)[number]; file: string }> = [];
    for (const mem of limited) for (const file of mem.stale_files) if (pairs.length < MAX_JUDGED) pairs.push({ mem, file });
    for (let i = 0; i < pairs.length; i += JUDGE_CONCURRENCY) {
      await Promise.all(pairs.slice(i, i + JUDGE_CONCURRENCY).map(async ({ mem, file }) => {
        const root = projectRoot(mem.project);
        const target = resolveStoredPath(file, root);
        const excerpt = target ? fileExcerpt(target, mem.content) : null;
        if (!excerpt) { mem.verdicts[file] = null; return; }
        const p = await judgeStaleMemory(mem.content, { path: file, excerpt: excerpt.excerpt, truncated: excerpt.truncated }, { entityId: String(mem.id), origin: 'tool', project: mem.project });
        mem.verdicts[file] = p;
        if (p === null) return;
        judgedPairs++;
        // Keep the verdict beside the memory, like the edit-time check does, so
        // recall and the verify job can use it until the file or memory moves.
        const revision = Number((getDb().prepare('SELECT MAX(revision) AS n FROM memory_revisions WHERE memory_id=?').get(String(mem.id)) as { n: number } | undefined)?.n || 1);
        recordStaleVerdict(String(mem.id), file, { p, hash: hashFile(file, root), rev: revision, at: new Date().toISOString(), session: null });
      }));
    }
  }
  const verdictOf = (mem: (typeof limited)[number]): 'stale' | 'accurate' | 'unjudged' => {
    const values = mem.stale_files.map(f => mem.verdicts[f]).filter((v): v is number => v !== null && v !== undefined);
    if (!values.length) return 'unjudged';
    return Math.min(...values) >= threshold ? 'accurate' : 'stale';
  };
  const groups = { stale: [] as typeof limited, accurate: [] as typeof limited, unjudged: [] as typeof limited };
  for (const mem of limited) groups[verdictOf(mem)].push(mem);

  // Compact output — IDs and changed files only, no full content
  const scopeMsg = args.categories ? ` in [${args.categories.join(', ')}]` : '';
  let msg = `Found ${filtered.length} memories with changed files${scopeMsg} (out of ${withChecksums.length} with checksums)`;
  if (truncated) msg += ` — showing first ${maxResults}`;
  msg += judgedPairs ? `; ${judgedPairs} memory/file pair${judgedPairs === 1 ? '' : 's'} judged for whether the memory still holds.` : '.';
  msg += '\n';
  const line = (mem: (typeof limited)[number]) => {
    const per = mem.stale_files.map(f => { const p = mem.verdicts[f]; return p === null || p === undefined ? f : `${f} (still accurate ${Math.round(p * 100)}%)`; });
    return `${mem.id} | ${mem.category} | imp:${mem.importance}\n  Changed: ${per.join(', ')}\n`;
  };
  if (groups.stale.length) msg += `\nSTALE — judged no longer accurate (${groups.stale.length}):\n${groups.stale.map(line).join('')}`;
  if (groups.accurate.length) msg += `\nCHANGED BUT STILL ACCURATE (${groups.accurate.length}) — the file moved, the memory holds:\n${groups.accurate.map(line).join('')}`;
  if (groups.unjudged.length) msg += `\n${settings.enabled && judgedPairs ? 'UNJUDGED' : 'CHECKSUM CHANGED'} (${groups.unjudged.length})${settings.enabled ? ' — judgment unavailable or file unreadable' : ''}:\n${groups.unjudged.map(line).join('')}`;

  msg += `\nTo get full content: use recall with the memory ID, or memories with action "by-category".`;

  return text(msg);
}
