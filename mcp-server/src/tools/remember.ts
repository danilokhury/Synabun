import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { generateEmbedding } from '../services/local-embeddings.js';
import { upsertMemory } from '../services/sqlite.js';
import { categoryExists, getAllCategories } from '../services/categories.js';
import { coerceStringArray } from './utils.js';
import type { MemoryPayload, MemorySource } from '../types.js';
import { detectProject } from '../config.js';
import { computeChecksums } from '../services/file-checksums.js';
import { invalidateCache } from '../services/neural-interface.js';
import { text } from './response.js';

export function buildRememberSchema() {
  return {
    content: z
      .string()
      .describe('The information to remember. Be specific and include context.'),
    // category and project are REQUIRED on purpose. They were optional, and the
    // description used to end "If omitted, a project default is used" — so hosts
    // routinely sent { content } alone. Everything then landed in the fallback
    // bucket, and the Claude Code stop hook (which keys off category) never
    // cleared. A JSON Schema `required` entry is enforcement; a description is
    // only advice, and the advice was already being ignored.
    category: z
      .string()
      .min(1)
      .describe(
        'REQUIRED. Category name (top-level bucket) to file this memory under. ' +
        'Call the category tool with action "list" for valid names, or action "create" ' +
        'if nothing fits. Distinct from subcategory. An unrecognized name is still ' +
        'accepted and remapped to a project default, but the memory is then filed in ' +
        'the wrong bucket — pass a real one.'
      ),
  project: z
    .string()
    .min(1)
    .describe(
      'REQUIRED. Project this belongs to, lowercase kebab-case (e.g. "criticalpixel", ' +
      '"synabun"). Use the project named in your session context — this is NOT reliably ' +
      'auto-detected over the HTTP transport, where every caller shares one process.'
    ),
  tags: coerceStringArray()
    .optional()
    .describe('Tags for categorization (e.g. ["redis", "cache", "pricing"])'),
  importance: z
    .coerce.number()
    .min(1)
    .max(10)
    .optional()
    .describe(
      'Set this deliberately on every call: 1=trivial, 5=routine, 7=significant, ' +
      '8+=critical. Use 8+ for hard-won bug fixes and architecture decisions. ' +
      'Omit only when the work is genuinely routine (defaults to 5).'
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
  related_files: coerceStringArray()
    .optional()
    .describe('File paths this memory relates to.'),
  };
}

export const rememberSchema = buildRememberSchema();

export const rememberDescription =
  'Store a piece of information in persistent memory. Use this when you learn something important, make a decision, discover a pattern, fix a hard bug, or want to preserve context for future sessions.';

/**
 * Resolve the category to store under. If the caller supplied a valid category,
 * use it verbatim. Otherwise fall back to a project default so a memory is never
 * lost just because the required field was omitted or misspelled.
 * Returns the chosen category and whether a fallback was applied.
 */
function resolveCategory(requested: string | undefined, project: string): { category: string; fallback: boolean } {
  if (requested && categoryExists(requested)) {
    return { category: requested, fallback: false };
  }
  const all = getAllCategories();
  const projectDefault = `${project}-project`;
  const chosen =
    (all.includes(projectDefault) && projectDefault) ||
    (all.includes('conversations') && 'conversations') ||
    all[0] ||
    'conversations';
  return { category: chosen, fallback: true };
}

export async function handleRemember(args: {
  content: string;
  // Required by the schema, but kept permissive here so the runtime fallbacks
  // below still apply to non-validating callers (direct imports, tests).
  category?: string;
  project?: string;
  tags?: string[];
  importance?: number;
  subcategory?: string;
  source?: string;
  related_files?: string[];
}) {
  const content = args.content;
  const project = args.project || detectProject();
  const { category, fallback: categoryFallback } = resolveCategory(args.category, project);
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
    file_checksums: (() => {
      if (!related_files?.length) return undefined;
      const cs = computeChecksums(related_files);
      return Object.keys(cs).length > 0 ? cs : undefined;
    })(),
  };

  const vector = await generateEmbedding(content);
  await upsertMemory(id, vector, payload);

  // Invalidate Neural Interface link cache (fire-and-forget)
  invalidateCache('remember', id);

  const note = categoryFallback
    ? ` (category ${args.category ? `"${args.category}" not found` : 'omitted'} — defaulted to "${category}"; pass a valid category next time)`
    : '';
  return text(`Remembered [${id}] (${category}/${project}, importance: ${importance}): "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"${note}`);
}
