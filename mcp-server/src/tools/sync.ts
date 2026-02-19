import { z } from 'zod';
import { scrollMemories } from '../services/qdrant.js';
import { hashFile } from '../services/file-checksums.js';
import type { MemoryPayload } from '../types.js';

export const syncSchema = {
  project: z
    .string()
    .optional()
    .describe('Optional: only check memories for this project.'),
};

export const syncDescription =
  'Check for stale memories whose related files have changed since the memory was last updated. Compares file content hashes against stored checksums. Returns a list of memories that may need updating. Use this to detect when code changes have made stored knowledge outdated.';

export async function handleSync(args: { project?: string }) {
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

  // Filter to memories with related_files
  const withFiles = allPoints.filter(p => {
    const payload = p.payload as unknown as MemoryPayload;
    return payload.related_files && payload.related_files.length > 0;
  });

  const stale: Array<{
    id: string | number;
    category: string;
    importance: number;
    content: string;
    related_files: string[];
    stale_files: string[];
  }> = [];

  for (const point of withFiles) {
    const payload = point.payload as unknown as MemoryPayload;
    const storedChecksums = payload.file_checksums || {};
    const staleFiles: string[] = [];

    for (const filePath of payload.related_files!) {
      const currentHash = hashFile(filePath);
      if (!currentHash) continue; // File not found — skip

      const storedHash = storedChecksums[filePath];
      if (!storedHash) {
        // No stored checksum — treat as stale (legacy memory without checksums)
        staleFiles.push(filePath);
      } else if (currentHash !== storedHash) {
        staleFiles.push(filePath);
      }
    }

    if (staleFiles.length > 0) {
      stale.push({
        id: point.id,
        category: payload.category,
        importance: payload.importance,
        content: payload.content,
        related_files: payload.related_files!,
        stale_files: staleFiles,
      });
    }
  }

  if (stale.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `All clear — checked ${withFiles.length} memories with related files, none are stale.`,
        },
      ],
    };
  }

  // Sort by importance descending so critical memories appear first
  stale.sort((a, b) => b.importance - a.importance);

  let text = `Found ${stale.length} stale memories (out of ${withFiles.length} with related files):\n\n`;

  for (const mem of stale) {
    text += `--- Memory ${mem.id} ---\n`;
    text += `Category: ${mem.category} | Importance: ${mem.importance}\n`;
    text += `Changed files: ${mem.stale_files.join(', ')}\n`;
    text += `Content:\n${mem.content}\n\n`;
  }

  text += `\nTo update these memories: for each one, read the changed file(s), compare with the memory content above, and use the reflect tool to update the memory content to match the current code.`;

  return {
    content: [{ type: 'text' as const, text }],
  };
}
