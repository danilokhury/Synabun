import { z } from 'zod';
import { scrollMemories, getMemoryStats } from '../services/qdrant.js';
import { buildCategoryDescription, validateCategory } from '../services/categories.js';
import type { MemoryPayload } from '../types.js';

export function buildMemoriesSchema() {
  return {
    action: z
      .enum(['recent', 'stats', 'by-category', 'by-project'] as const)
      .describe(
        'recent=latest memories, stats=counts and health, by-category=filter by type, by-project=filter by project.'
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Filter by category (for by-category action). ' + buildCategoryDescription()
      ),
    project: z
      .string()
      .optional()
      .describe('Filter by project (for by-project action).'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of results (default 10).'),
  };
}

export const memoriesSchema = buildMemoriesSchema();

export const memoriesDescription =
  'Browse recent memories or get statistics. Use this to see what you remember about a project, review recent learnings, or check memory health.';

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

export async function handleMemories(args: {
  action: string;
  category?: string;
  project?: string;
  limit?: number;
}) {
  const action = args.action;
  const category = args.category;
  const project = args.project;
  const limit = args.limit ?? 10;

  if (category) {
    const catCheck = validateCategory(category);
    if (!catCheck.valid) {
      return {
        content: [{ type: 'text' as const, text: catCheck.error! }],
      };
    }
  }

  if (action === 'stats') {
    const stats = await getMemoryStats();

    const categoryLines = Object.entries(stats.by_category)
      .filter(([, count]) => count > 0)
      .map(([cat, count]) => `  ${cat}: ${count}`)
      .join('\n');

    const projectLines = Object.entries(stats.by_project)
      .map(([proj, count]) => `  ${proj}: ${count}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory Statistics:\n\nTotal memories: ${stats.total}\n\nBy category:\n${categoryLines || '  (none)'}\n\nBy project:\n${projectLines || '  (none)'}\n\nOldest: ${stats.oldest ? formatAge(stats.oldest) : 'n/a'}\nNewest: ${stats.newest ? formatAge(stats.newest) : 'n/a'}`,
        },
      ],
    };
  }

  const must: Record<string, unknown>[] = [];
  if ((action === 'by-category' || action === 'recent') && category) {
    must.push({ key: 'category', match: { value: category } });
  }
  if ((action === 'by-project' || action === 'recent') && project) {
    must.push({ key: 'project', match: { value: project } });
  }

  const filter = must.length > 0 ? { must } : undefined;
  const result = await scrollMemories(filter, limit);

  const sorted = result.points
    .map((p) => ({
      id: p.id as string,
      payload: p.payload as unknown as MemoryPayload,
    }))
    .sort((a, b) => b.payload.created_at.localeCompare(a.payload.created_at));

  if (sorted.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No memories found${category ? ` for category "${category}"` : ''}${project ? ` for project "${project}"` : ''}.`,
        },
      ],
    };
  }

  const lines = sorted.map((m, i) => {
    const p = m.payload;
    const tagStr = p.tags?.length ? ` [${p.tags.join(', ')}]` : '';
    const sub = p.subcategory ? `/${p.subcategory}` : '';
    return `${i + 1}. [${m.id}] ${p.category}${sub} | ${p.project} | imp:${p.importance} | ${formatAge(p.created_at)}${tagStr}\n   ${p.content.slice(0, 150)}${p.content.length > 150 ? '...' : ''}`;
  });

  const title =
    action === 'recent'
      ? 'Recent memories'
      : action === 'by-category'
        ? `Memories in "${category}"`
        : `Memories for "${project}"`;

  return {
    content: [
      {
        type: 'text' as const,
        text: `${title} (${sorted.length}):\n\n${lines.join('\n\n')}`,
      },
    ],
  };
}
