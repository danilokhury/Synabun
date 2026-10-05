import { randomUUID } from 'node:crypto';
import { writeMemory, IdempotencyConflict, type WriteMemoryResult } from '../services/memory-writer.js';
import { z } from 'zod';
import { categoryExists, getAllCategories, getCategories } from '../services/categories.js';
import { coerceStringArray } from './utils.js';
import type { MemoryPayload, MemorySource } from '../types.js';
import { detectProject, projectRoot } from '../config.js';
import { computeChecksums } from '../services/file-checksums.js';
import { text } from './response.js';
import { callerMemoryContext } from '../services/identity.js';
import { redactSecrets } from '../services/secret-gate.js';
import { judgeCategory, type CategoryJudgment } from '../services/memory-judgments.js';
import { surfaceConfig, relinkTypeSafeLog } from '../services/typesafe-config.js';
import { getDb } from '../services/sqlite.js';

const MAX_CATEGORY_OPTIONS = 60;

/**
 * The categories a memory could be filed under, with their descriptions —
 * leaves only (parents are containers). Above the cap, keep the caller's
 * siblings and the top-level leaves so the request stays affordable.
 */
export function categoryOptions(current: string): Record<string, string | null> {
  const all = getCategories();
  const byName = new Map(all.map(c => [c.name, c]));
  let pool = all.filter(c => !c.is_parent);
  if (pool.length > MAX_CATEGORY_OPTIONS) {
    const parent = byName.get(current)?.parent;
    pool = pool.filter(c => c.name === current || (parent ? c.parent === parent : !c.parent)).slice(0, MAX_CATEGORY_OPTIONS);
  }
  const options: Record<string, string | null> = {};
  for (const c of pool) options[c.name] = c.description || null;
  if (!(current in options)) options[current] = byName.get(current)?.description || null;
  return options;
}

/** Record what the judgment thought beside the writer's pick. Never re-routes. */
export function recordCategoryJudgment(memoryId: string, verdict: CategoryJudgment | null): void {
  if (!verdict || verdict.category === 'none-of-these') return;
  try {
    getDb().prepare('UPDATE memory_metadata SET category_judged=?, category_confidence=? WHERE memory_id=?').run(verdict.category, verdict.confidence, memoryId);
  } catch { /* the judgment is advisory; a missing column or row must not fail the write */ }
}

export function buildRememberSchema() {
  return {
    idempotency_key: z.string().min(1).max(200).optional().describe('Retry key scoped to project and category. Same key/content returns the existing UUID.'),
    kind: z.enum(['note','decision','issue','preference','fact','session']).optional().describe('Memory kind; defaults to note.'),
    source_ref: z.string().max(2000).optional().describe('Local session/event identifier or source reference.'),
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
      'REQUIRED. Project this belongs to, lowercase kebab-case (e.g. "my-web-app", ' +
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
  idempotency_key?: string; kind?: string; source_ref?: string;
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
  const project = args.project || detectProject();
  // The id is chosen before any judgment so every write-time judgment
  // (secret, category, duplicate) is logged against the memory it produced.
  const provisionalId = randomUUID();
  const judgeContext = { origin: 'tool' as const, entityId: provisionalId, project, sessionId: callerMemoryContext().session ?? null };
  // Secret gate first: nothing credential-shaped gets embedded or stored.
  const gate = await redactSecrets(args.content, judgeContext);
  if (gate.refused) {
    return { ...text('Refused: this memory would be nothing but a credential. Store where the secret lives (the file path or the environment variable name), never the secret itself.'), isError: true };
  }
  const content = gate.text;
  const { category, fallback: categoryFallback } = resolveCategory(args.category, project);
  const tags = [...(args.tags || [])];
  if (gate.redactions.length && !tags.includes('redacted')) tags.push('redacted');
  const importance = args.importance ?? 5;
  const subcategory = args.subcategory;
  const source = (args.source as MemorySource) || 'self-discovered';
  const related_files = args.related_files;

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
      const cs = computeChecksums(related_files, projectRoot(project));
      return Object.keys(cs).length > 0 ? cs : undefined;
    })(),
  };

  // The category check runs beside the write (both are round trips); its
  // answer is recorded and reported, never applied.
  const categorySettings = surfaceConfig('category-check');
  const check: Promise<CategoryJudgment | null> = categorySettings.enabled
    ? judgeCategory(content, category, categoryOptions(category), judgeContext).catch(() => null)
    : Promise.resolve(null);
  let result: WriteMemoryResult;
  let verdict: CategoryJudgment | null = null;
  try {
    [result, verdict] = await Promise.all([
      writeMemory(payload, { idempotencyKey: args.idempotency_key, kind: args.kind, sourceRef: args.source_ref || callerMemoryContext().session, id: provisionalId, judge: judgeContext }),
      check,
    ]);
  } catch (error) {
    if (error instanceof IdempotencyConflict) return { ...text(error.message), isError: true };
    throw error;
  }
  const { id, pending } = result;
  // A duplicate or a retry answers with an existing id; point the rows logged
  // under the id that was never stored at the memory the write resolved to.
  if (id !== provisionalId) relinkTypeSafeLog(provisionalId, id);
  if (result.duplicate) {
    return text(`Not stored — duplicate of [${id}] (P=${result.duplicate.probability.toFixed(2)}): that memory already states this. Use \`reflect\` on it to add what is new.`);
  }
  if (result.existing) return text(`Remembered [${id}] (existing retry; no duplicate created).`);
  recordCategoryJudgment(id, verdict);

  const notes: string[] = [];
  if (categoryFallback) notes.push(`category ${args.category ? `"${args.category}" not found` : 'omitted'} — defaulted to "${category}"; pass a valid category next time`);
  if (gate.redactions.length) notes.push(`redacted ${gate.redactions.length} credential-looking value${gate.redactions.length === 1 ? '' : 's'}${gate.judged ? '' : ' (pattern match only)'}`);
  if (verdict && verdict.confidence >= (categorySettings.minConfidence ?? 0.6)) {
    if (verdict.category === 'none-of-these') notes.push(`category check: no existing category fits well (${Math.round(verdict.confidence * 100)}%)`);
    else if (verdict.category !== category) notes.push(`category check: Jev suggests "${verdict.category}" (${Math.round(verdict.confidence * 100)}%) — stored under "${category}" as asked; review in Settings → Judgments → Misfiled`);
  }
  const note = notes.length ? ` (${notes.join('; ')})` : '';
  return text(`Remembered [${id}] (${category}/${project}, importance: ${importance}): "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"${note}${pending ? ' (Saved durably; local semantic indexing pending.)' : ''}`);
}
