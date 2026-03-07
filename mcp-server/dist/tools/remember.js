import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { generateEmbedding } from '../services/local-embeddings.js';
import { upsertMemory } from '../services/sqlite.js';
import { validateCategory } from '../services/categories.js';
import { coerceStringArray } from './utils.js';
import { detectProject } from '../config.js';
import { computeChecksums } from '../services/file-checksums.js';
import { invalidateCache } from '../services/neural-interface.js';
export function buildRememberSchema() {
    return {
        content: z
            .string()
            .describe('The information to remember. Be specific and include context.'),
        category: z
            .string()
            .describe('Category name. Call category tool with action "list" to see valid categories.'),
        project: z
            .string()
            .optional()
            .describe('Project this belongs to (e.g. "criticalpixel"). Defaults to auto-detected from working directory.'),
        tags: coerceStringArray()
            .optional()
            .describe('Tags for categorization (e.g. ["redis", "cache", "pricing"])'),
        importance: z
            .coerce.number()
            .min(1)
            .max(10)
            .optional()
            .describe('1=trivial, 5=normal, 7=significant, 8+=critical. Default 5. Use 8+ for hard-won bug fixes and architecture decisions.'),
        subcategory: z
            .string()
            .optional()
            .describe('Optional refinement: architecture, bug-fix, api-quirk, performance, config, deployment, etc.'),
        source: z
            .enum(['user-told', 'self-discovered', 'auto-saved'])
            .optional()
            .describe('How this was learned. user-told=user explicitly shared, self-discovered=found during work, auto-saved=session context.'),
        related_files: coerceStringArray()
            .optional()
            .describe('File paths this memory relates to.'),
    };
}
export const rememberSchema = buildRememberSchema();
export const rememberDescription = 'Store a piece of information in persistent memory. Use this when you learn something important, make a decision, discover a pattern, fix a hard bug, or want to preserve context for future sessions.';
export async function handleRemember(args) {
    const catCheck = validateCategory(args.category);
    if (!catCheck.valid) {
        return {
            content: [{ type: 'text', text: catCheck.error }],
        };
    }
    const content = args.content;
    const category = args.category;
    const project = args.project || detectProject();
    const tags = args.tags || [];
    const importance = args.importance ?? 5;
    const subcategory = args.subcategory;
    const source = args.source || 'self-discovered';
    const related_files = args.related_files;
    const id = uuidv4();
    const now = new Date().toISOString();
    const payload = {
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
            if (!related_files?.length)
                return undefined;
            const cs = computeChecksums(related_files);
            return Object.keys(cs).length > 0 ? cs : undefined;
        })(),
    };
    const vector = await generateEmbedding(content);
    await upsertMemory(id, vector, payload);
    // Invalidate Neural Interface link cache (fire-and-forget)
    invalidateCache('remember');
    return {
        content: [
            {
                type: 'text',
                text: `Remembered [${id}] (${category}/${project}, importance: ${importance}): "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`,
            },
        ],
    };
}
//# sourceMappingURL=remember.js.map