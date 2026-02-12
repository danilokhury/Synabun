import { z } from 'zod';
import { generateEmbedding } from '../services/embeddings.js';
import { searchMemories, updatePayload } from '../services/qdrant.js';
import { buildCategoryDescription, validateCategory } from '../services/categories.js';
import type { MemoryPayload } from '../types.js';
import { detectProject } from '../config.js';

export function buildRecallSchema() {
  return {
    query: z.string().describe('What to search for, in natural language.'),
    category: z
      .string()
      .optional()
      .describe(
        'Optional: filter by category. ' + buildCategoryDescription()
      ),
    project: z
      .string()
      .optional()
      .describe(
        'Optional: filter by project. If omitted, searches all projects but boosts current project.'
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe('Optional: filter by tags (any match).'),
    limit: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .describe('Number of results (default 5).'),
    min_importance: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe('Minimum importance threshold.'),
    min_score: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Minimum similarity score 0-1 (default 0.3).'),
  };
}

export const recallSchema = buildRecallSchema();

export const recallDescription =
  'Search your persistent memory for relevant information. Use this at the start of any task to check what you already know, or when you need context about past decisions, known issues, or architectural patterns.';

function applyTimeDecay(
  rawScore: number,
  createdAt: string,
  importance: number,
  accessCount: number
): number {
  if (importance >= 8) return rawScore;
  const ageInDays =
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const recencyMultiplier = Math.pow(0.5, ageInDays / 90);
  const accessBoost = Math.min(0.1, accessCount * 0.01);
  return rawScore * 0.7 + recencyMultiplier * 0.2 + accessBoost;
}

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}

export async function handleRecall(args: {
  query: string;
  category?: string;
  project?: string;
  tags?: string[];
  limit?: number;
  min_importance?: number;
  min_score?: number;
}) {
  const query = args.query;
  const category = args.category;
  const project = args.project;
  const tags = args.tags;
  const limit = args.limit ?? 5;
  const minImportance = args.min_importance;
  const minScore = args.min_score ?? 0.3;

  if (category) {
    const catCheck = validateCategory(category);
    if (!catCheck.valid) {
      return {
        content: [{ type: 'text' as const, text: catCheck.error! }],
      };
    }
  }

  const vector = await generateEmbedding(query);

  const must: Record<string, unknown>[] = [];
  if (category) must.push({ key: 'category', match: { value: category } });
  if (project) must.push({ key: 'project', match: { value: project } });
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      must.push({ key: 'tags', match: { value: tag } });
    }
  }
  if (minImportance) {
    must.push({ key: 'importance', range: { gte: minImportance } });
  }

  const filter = must.length > 0 ? { must } : undefined;
  const results = await searchMemories(vector, limit * 2, filter, minScore);

  const currentProject = detectProject();
  const scored = results
    .map((r) => {
      const payload = r.payload as unknown as MemoryPayload;
      let adjustedScore = applyTimeDecay(
        r.score,
        payload.created_at,
        payload.importance,
        payload.access_count
      );
      if (!project && payload.project === currentProject) {
        adjustedScore *= 1.2;
      }
      return { id: r.id as string, score: adjustedScore, payload };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Update access tracking (fire-and-forget)
  const now = new Date().toISOString();
  for (const result of scored) {
    updatePayload(result.id, {
      accessed_at: now,
      access_count: result.payload.access_count + 1,
    }).catch(() => {});
  }

  if (scored.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No memories found for "${query}"${category ? ` in category ${category}` : ''}${project ? ` for project ${project}` : ''}.`,
        },
      ],
    };
  }

  const lines = scored.map((r, i) => {
    const p = r.payload;
    const score = (r.score * 100).toFixed(0);
    const tagStr = p.tags?.length ? ` [${p.tags.join(', ')}]` : '';
    const sub = p.subcategory ? `/${p.subcategory}` : '';
    const files = p.related_files?.length
      ? `\n   Files: ${p.related_files.join(', ')}`
      : '';
    return `${i + 1}. [${r.id}] (${score}% match, importance: ${p.importance}, ${formatAge(p.created_at)})\n   ${p.category}${sub} | ${p.project}${tagStr}\n   ${p.content}${files}`;
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Found ${scored.length} memories for "${query}":\n\n${lines.join('\n\n')}`,
      },
    ],
  };
}
