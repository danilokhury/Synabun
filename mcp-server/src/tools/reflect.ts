import { z } from 'zod';
import { getMemory, updatePayload, updateVector } from '../services/qdrant.js';
import { generateEmbedding } from '../services/embeddings.js';
import { buildCategoryDescription, validateCategory } from '../services/categories.js';
import type { MemoryPayload } from '../types.js';

export function buildReflectSchema() {
  return {
    memory_id: z.string().describe('The ID of the memory to update. MUST be the full UUID format (e.g., 8f7cab3b-644e-4cea-8662-de0ca695bdf2), not a shortened version. Use recall to get the full UUID.'),
    content: z
      .string()
      .optional()
      .describe(
        'Updated content. If provided, the embedding vector is regenerated.'
      ),
    importance: z.number().min(1).max(10).optional().describe('Updated importance score.'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Replace all tags with these.'),
    add_tags: z
      .array(z.string())
      .optional()
      .describe('Add tags without replacing existing ones.'),
    subcategory: z.string().optional().describe('Updated subcategory.'),
    category: z
      .string()
      .optional()
      .describe(
        'Change the category. ' + buildCategoryDescription()
      ),
    related_files: z
      .array(z.string())
      .optional()
      .describe('Updated related file paths.'),
    related_memory_ids: z
      .array(z.string())
      .optional()
      .describe('Link to related memories.'),
  };
}

export const reflectSchema = buildReflectSchema();

export const reflectDescription =
  'Update or annotate an existing memory. Use this when you discover additional context, when a decision changes, or when you want to adjust importance based on new information.';

export async function handleReflect(args: {
  memory_id: string;
  content?: string;
  importance?: number;
  tags?: string[];
  add_tags?: string[];
  subcategory?: string;
  category?: string;
  related_files?: string[];
  related_memory_ids?: string[];
}) {
  const memoryId = args.memory_id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(memoryId)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Invalid memory_id format. Expected full UUID (e.g., 8f7cab3b-644e-4cea-8662-de0ca695bdf2), got: ${memoryId}\n\nThe 'remember' tool returns a shortened ID for display, but 'reflect' requires the full UUID. Use 'recall' to get the full UUID first.`,
        },
      ],
    };
  }

  if (args.category) {
    const catCheck = validateCategory(args.category);
    if (!catCheck.valid) {
      return {
        content: [{ type: 'text' as const, text: catCheck.error! }],
      };
    }
  }

  const existing = await getMemory(memoryId);
  if (!existing) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory "${memoryId}" not found.`,
        },
      ],
    };
  }

  const payload = existing.payload as unknown as MemoryPayload;
  const now = new Date().toISOString();
  const updates: Partial<MemoryPayload> = { updated_at: now };
  const changes: string[] = [];

  if (args.content) {
    updates.content = args.content;
    changes.push('content');
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
  if (args.related_files) {
    updates.related_files = args.related_files;
    changes.push('related_files updated');
  }
  if (args.related_memory_ids) {
    updates.related_memory_ids = args.related_memory_ids;
    changes.push('related_memory_ids updated');
  }

  if (changes.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No changes specified.' }],
    };
  }

  if (args.content) {
    const mergedPayload: MemoryPayload = { ...payload, ...updates } as MemoryPayload;
    const vector = await generateEmbedding(mergedPayload.content);
    await updateVector(memoryId, vector, mergedPayload);
  } else {
    await updatePayload(memoryId, updates);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: `Updated [${memoryId.slice(0, 8)}]: ${changes.join(', ')}`,
      },
    ],
  };
}
