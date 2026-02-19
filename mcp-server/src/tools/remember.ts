import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { generateEmbedding } from '../services/embeddings.js';
import { upsertMemory } from '../services/qdrant.js';
import { buildCategoryDescription, validateCategory } from '../services/categories.js';
import type { MemoryPayload, MemorySource } from '../types.js';
import { detectProject } from '../config.js';
import { computeChecksums } from '../services/file-checksums.js';

export function buildRememberSchema() {
  return {
    content: z
      .string()
      .describe('The information to remember. Be specific and include context.'),
    category: z
      .string()
      .describe(
        buildCategoryDescription()
      ),
  project: z
    .string()
    .optional()
    .describe(
      'Project this belongs to (e.g. "criticalpixel"). Defaults to auto-detected from working directory.'
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags for categorization (e.g. ["redis", "cache", "pricing"])'),
  importance: z
    .coerce.number()
    .min(1)
    .max(10)
    .optional()
    .describe(
      '1=trivial, 5=normal, 7=significant, 8+=critical. Default 5. Use 8+ for hard-won bug fixes and architecture decisions.'
    ),
  subcategory: z
    .string()
    .optional()
    .describe(
      'Optional refinement: architecture, bug-fix, api-quirk, performance, config, deployment, etc.'
    ),
  source: z
    .enum(['user-told', 'self-discovered', 'auto-saved'] as const)
    .optional()
    .describe(
      'How this was learned. user-told=user explicitly shared, self-discovered=found during work, auto-saved=session context.'
    ),
  related_files: z
    .array(z.string())
    .optional()
    .describe('File paths this memory relates to.'),
  };
}

export const rememberSchema = buildRememberSchema();

export const rememberDescription =
  'Store a piece of information in persistent memory. Use this when you learn something important, make a decision, discover a pattern, fix a hard bug, or want to preserve context for future sessions.';

export async function handleRemember(args: {
  content: string;
  category: string;
  project?: string;
  tags?: string[];
  importance?: number;
  subcategory?: string;
  source?: string;
  related_files?: string[];
}) {
  const catCheck = validateCategory(args.category);
  if (!catCheck.valid) {
    return {
      content: [{ type: 'text' as const, text: catCheck.error! }],
    };
  }

  const content = args.content;
  const category = args.category;
  const project = args.project || detectProject();
  const tags = args.tags || [];
  const importance = args.importance ?? 5;
  const subcategory = args.subcategory;
  const source = (args.source as MemorySource) || 'self-discovered';
  const related_files = args.related_files;

  const id = uuidv4();
  const now = new Date().toISOString();

  const payload: MemoryPayload = {
    content,
    category,
    subcategory,
    project,
    tags,
    importance,
    source,
    created_at: now,
    updated_at: now,
    accessed_at: now,
    access_count: 0,
    related_files,
    file_checksums: related_files?.length ? computeChecksums(related_files) : undefined,
  };

  const vector = await generateEmbedding(content);
  await upsertMemory(id, vector, payload);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Remembered [${id.slice(0, 8)}] (${category}/${project}, importance: ${importance}): "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`,
      },
    ],
  };
}
