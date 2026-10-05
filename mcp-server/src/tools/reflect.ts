import { z } from 'zod';
import { getMemory, updatePayload, upsertMemory, getDb, memoryVectors } from '../services/sqlite.js';
import { generateEmbedding } from '../services/local-embeddings.js';
import { validateCategory } from '../services/categories.js';
import { coerceStringArray } from './utils.js';
import type { MemoryPayload } from '../types.js';
import { invalidateCache } from '../services/neural-interface.js';
import { computeChecksums } from '../services/file-checksums.js';
import { text } from './response.js';
import { memoryRevision, setRelation } from '../services/memory-maintenance.js';
import { redactSecrets } from '../services/secret-gate.js';
import { projectRoot } from '../config.js';
import { callerMemoryContext } from '../services/identity.js';

export function buildReflectSchema() {
  return {
    expected_revision: z.coerce.number().int().min(1).optional().describe('Reject if the memory changed since this revision.'),
    supersedes: z.string().uuid().optional().describe('Explicitly mark another memory in this project as superseded by this one.'),
    memory_id: z.string().describe('The ID of the memory to update. MUST be the full UUID format (e.g., 8f7cab3b-644e-4cea-8662-de0ca695bdf2), not a shortened version. Use recall to get the full UUID.'),
    content: z
      .string()
      .optional()
      .describe(
        'Updated content. If provided, the embedding vector is regenerated.'
      ),
    importance: z.coerce.number().min(1).max(10).optional().describe('Updated importance score.'),
    tags: coerceStringArray()
      .optional()
      .describe('Replace all tags with these.'),
    add_tags: coerceStringArray()
      .optional()
      .describe('Add tags without replacing existing ones.'),
    subcategory: z.string().optional().describe('Updated subcategory.'),
    category: z
      .string()
      .optional()
      .describe('Change the category name.'),
    related_files: coerceStringArray()
      .optional()
      .describe('Updated related file paths.'),
    related_memory_ids: coerceStringArray()
      .optional()
      .describe('Link to related memories.'),
    project: z.string().optional().describe('Change the project this memory belongs to (e.g. "my-web-app", "synabun").'),
  };
}

export const reflectSchema = buildReflectSchema();

export const reflectDescription =
  'Update or annotate an existing memory. Use this when you discover additional context, when a decision changes, or when you want to adjust importance based on new information.';

export async function handleReflect(args: {
  memory_id: string; expected_revision?: number; supersedes?: string;
  content?: string;
  importance?: number;
  tags?: string[];
  add_tags?: string[];
  subcategory?: string;
  category?: string;
  related_files?: string[];
  related_memory_ids?: string[];
  project?: string;
}) {
  const memoryId = args.memory_id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(memoryId)) {
    return text(`Invalid memory_id format. Expected full UUID (e.g., 8f7cab3b-644e-4cea-8662-de0ca695bdf2), got: ${memoryId}\n\nUse the full UUID returned by 'remember', or call 'recall' to find the full UUID of an existing memory.`);
  }

  if (args.category) {
    const catCheck = validateCategory(args.category);
    if (!catCheck.valid) {
      return text(catCheck.error!);
    }
  }

  const existing = await getMemory(memoryId);
  if (!existing) {
    return text(`Memory "${memoryId}" not found.`);
  }

  const expected = args.expected_revision ?? memoryRevision(memoryId);
  const payload = existing.payload as unknown as MemoryPayload;
  const now = new Date().toISOString();
  const updates: Partial<MemoryPayload> = { updated_at: now };
  const changes: string[] = [];

  let redactions = 0;
  if (args.content) {
    // Same gate as remember: an update must not smuggle a credential in.
    const gate = await redactSecrets(args.content, { entityId: memoryId, origin: 'tool', project: payload.project, sessionId: callerMemoryContext().session ?? null });
    if (gate.refused) {
      return { ...text('Refused: the new content would be nothing but a credential. Store where the secret lives, never the secret itself.'), isError: true };
    }
    updates.content = gate.text;
    redactions = gate.redactions.length;
    changes.push(redactions ? `content (redacted ${redactions} credential-looking value${redactions === 1 ? '' : 's'})` : 'content');
  }
  if (args.importance !== undefined) {
    updates.importance = args.importance;
    changes.push(`importance -> ${args.importance}`);
  }
  if (args.category) {
    updates.category = args.category;
    changes.push(`category -> ${args.category}`);
  }
  if (args.subcategory) {
    updates.subcategory = args.subcategory;
    changes.push(`subcategory -> ${args.subcategory}`);
  }
  if (args.tags) {
    updates.tags = args.tags;
    changes.push(`tags replaced`);
  }
  if (args.add_tags) {
    const existingTags = payload.tags || [];
    updates.tags = [...new Set([...existingTags, ...args.add_tags])];
    changes.push(`tags added: ${args.add_tags.join(', ')}`);
  }
  if (redactions) updates.tags = [...new Set([...(updates.tags ?? payload.tags ?? []), 'redacted'])];
  if (args.related_files) {
    updates.related_files = args.related_files;
    changes.push('related_files updated');
  }
  if (args.related_memory_ids) {
    updates.related_memory_ids = args.related_memory_ids;
    changes.push('related_memory_ids updated');
  }
  if (args.project) {
    updates.project = args.project;
    changes.push(`project -> ${args.project}`);
  }

  if (args.supersedes) changes.push(`supersedes ${args.supersedes}`);
  if (changes.length === 0) {
    return text('No changes specified.');
  }

  // Recompute file checksums whenever the memory is updated
  const finalFiles = (updates.related_files ?? payload.related_files);
  if (finalFiles?.length && (args.content || args.related_files)) {
    const cs = computeChecksums(finalFiles, projectRoot(updates.project ?? payload.project));
    updates.file_checksums = Object.keys(cs).length > 0 ? cs : undefined;
  }

  let vector: number[] | undefined;
  if (updates.content) {
    try { vector = await generateEmbedding(updates.content); }
    catch { vector = new Array(384).fill(0); }
  }
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    if (memoryRevision(memoryId) !== expected) {
      d.exec('ROLLBACK');
      return { ...text('Revision conflict: the memory changed. Fetch it again and merge your update.'), isError: true };
    }
    if (vector) upsertMemory(memoryId, vector, { ...payload, ...updates } as MemoryPayload);
    else updatePayload(memoryId, updates);
    if (args.supersedes) setRelation(memoryId,args.supersedes,'supersedes');
    d.exec('COMMIT');
  } catch(error) { d.exec('ROLLBACK'); memoryVectors.invalidate(); return { ...text((error as Error).message), isError: true }; }

  // Invalidate Neural Interface link cache (fire-and-forget)
  invalidateCache('reflect', memoryId);

  return text(`Updated [${memoryId}]: ${changes.join(', ')}`);
}
