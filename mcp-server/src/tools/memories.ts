import { z } from 'zod';
import { scrollMemories, getMemoryStats, getMemory, rowToSessionChunkPayload } from '../services/sqlite.js';
import { validateCategory } from '../services/categories.js';
import type { MemoryPayload } from '../types.js';
import { text } from './response.js';
import { getDb } from '../services/sqlite.js';
import { memoryRevision, memoryHistory, undoRevision, maintenanceStatus, pauseMaintenance, feedback, projectContext } from '../services/memory-maintenance.js';
import { triageMemories } from '../services/memory-triage.js';

function coerceIds() { return z.array(z.string().uuid()).max(50).optional().describe('UUIDs for get-batch; maximum 50.'); }

export function buildMemoriesSchema() {
  return {
    action: z
      .enum(['recent', 'stats', 'by-category', 'by-project', 'get', 'get-batch', 'history', 'undo', 'maintenance', 'feedback', 'context', 'triage'] as const)
      .describe(
        'recent=latest memories, stats=counts and health, by-category=filter by type, by-project=filter by project, get=FULL untruncated content of one memory by id (no vector search), triage=forget candidates (duplicates, old never-recalled notes) ranked by how little they would be missed — nothing is deleted.'
      ),
    token_budget: z.coerce.number().int().min(100).max(16000).optional().describe('Estimated token budget for context; default 1500.'),
    ids: coerceIds(),
    revision: z.coerce.number().int().min(1).optional().describe('Revision to restore for undo.'),
    expected_revision: z.coerce.number().int().min(1).optional().describe('Required current revision for undo.'),
    operation: z.enum(['status','pause','resume','retry','undo-relation']).optional().describe('Maintenance operation; default status.'),
    relation_id: z.string().uuid().optional().describe('Relationship to undo.'),
    feedback: z.enum(['useful','irrelevant','incorrect']).optional().describe('Feedback signal; never treated as proof of correctness.'),
    id: z
      .string()
      .optional()
      .describe('Memory id (required for action "get"). Returns that memory\'s full content untruncated — use to fetch a consolidated/large memory directly.'),
    category: z
      .string()
      .optional()
      .describe('Category to filter by (for by-category action).'),
    project: z
      .string()
      .optional()
      .describe('Filter by project (for by-project action).'),
    limit: z
      .coerce.number()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of results (default 10).'),
  };
}

export const memoriesSchema = buildMemoriesSchema();

export const memoriesDescription =
  'Browse recent memories, get statistics, or fetch one memory in FULL by id. Use action "get" with an id to pull a large/consolidated memory untruncated (list actions truncate content to 150 chars). Use to see what you remember about a project, review recent learnings, or check memory health.';

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
  action: string; ids?: string[]; revision?: number; expected_revision?: number;
  operation?: string; relation_id?: string; feedback?: string; token_budget?: number;
  id?: string;
  category?: string;
  project?: string;
  limit?: number;
}) {
  const action = args.action;
  const category = args.category;
  const project = args.project;
  const limit = args.limit ?? 10;

  try {
    if (action === 'context') return text(projectContext(args.project || '',args.token_budget ?? 1500));
    if (action === 'triage') {
      const result = await triageMemories({ project: args.project, limit, origin: 'tool' });
      if (!result.rows.length) return text(`No forget candidates found${args.project ? ` for "${args.project}"` : ''}.`);
      const lines = result.rows.map((r, i) => `${i + 1}. [${r.id}] ${r.category} | ${r.project} | imp:${r.importance} | recalled ${r.access_count}× | ${formatAge(r.created_at)}` +
        `${r.expendability !== null ? ` | expendability ${r.expendability.toFixed(1)} (${r.level})` : ''}\n   why: ${r.reasons.join('; ')}\n   ${r.preview}${r.preview.length >= 240 ? '…' : ''}`);
      const unjudged = result.judged ? result.rows.filter(r => r.expendability === null).length : 0;
      return text(`Forget candidates (${result.rows.length} of ${result.candidates} found${result.judged ? ', ranked by judged expendability' : ', fallback ordering — judgment unavailable'}${unjudged ? `; ${unjudged} could not be judged this time (listed after the judged ones)` : ''}). Nothing was deleted; use \`forget\` on the ids you agree with.\n\n${lines.join('\n\n')}`);
    }
    if (action === 'get-batch') {
      if (!args.ids?.length) return text('get-batch requires ids.');
      const rows = [];
      for (const id of args.ids) { const m = await getMemory(id); const session = !m && getDb().prepare('SELECT * FROM session_chunks WHERE id=?').get(id); rows.push(m ? {...m,revision:memoryRevision(id)} : session ? {id,type:'session',payload:rowToSessionChunkPayload(session)} : {id,error:'not found'}); }
      return text(JSON.stringify(rows));
    }
    if (action === 'history') return text(JSON.stringify(memoryHistory(args.id || '',limit)));
    if (action === 'undo') {
      if (!args.id || !args.revision || !args.expected_revision) return text('undo requires id, revision, and expected_revision.');
      return text(`Restored [${args.id}] as revision ${undoRevision(args.id,args.revision,args.expected_revision)}.`);
    }
    if (action === 'feedback') { feedback(args.id || '',args.feedback || ''); return text('Feedback recorded.'); }
    if (action === 'maintenance') {
      if (args.operation === 'pause' || args.operation === 'resume') pauseMaintenance(args.operation === 'pause');
      if (args.operation === 'retry') getDb().exec("UPDATE memory_jobs SET status='pending',attempts=0,error=NULL WHERE status='failed'");
      if (args.operation === 'undo-relation') getDb().prepare('UPDATE memory_relations SET active=0 WHERE id=?').run(args.relation_id || '');
      return text(JSON.stringify(maintenanceStatus()));
    }
  } catch (error) { return { ...text((error as Error).message), isError: true }; }
  if (action === 'get') {
    if (!args.id) return text('action "get" requires an "id".');
    const mem = await getMemory(args.id);
    if (!mem) {
      const session=getDb().prepare('SELECT * FROM session_chunks WHERE id=?').get(args.id);
      return session ? text(`[${args.id}] Session ${session.session_id} | ${session.project}\n\n${session.content}`) : text(`No memory found with id "${args.id}".`);
    }
    const p = mem.payload;
    const tagStr = p.tags?.length ? ` [${p.tags.join(', ')}]` : '';
    const sub = p.subcategory ? `/${p.subcategory}` : '';
    return text(`[${mem.id}] ${p.category}${sub} | ${p.project} | imp:${p.importance}${tagStr} | revision:${memoryRevision(args.id)}\n\n${p.content}`);
  }

  if (category) {
    const catCheck = validateCategory(category);
    if (!catCheck.valid) {
      return text(catCheck.error!);
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

    return text(`Memory Statistics:\n\nTotal memories: ${stats.total}\n\nBy category:\n${categoryLines || '  (none)'}\n\nBy project:\n${projectLines || '  (none)'}\n\nOldest: ${stats.oldest ? formatAge(stats.oldest) : 'n/a'}\nNewest: ${stats.newest ? formatAge(stats.newest) : 'n/a'}`);
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
    .filter((m) => m.payload?.content && m.payload?.created_at)
    .sort((a, b) => b.payload.created_at.localeCompare(a.payload.created_at));

  if (sorted.length === 0) {
    return text(`No memories found${category ? ` for category "${category}"` : ''}${project ? ` for project "${project}"` : ''}.`);
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

  return text(`${title} (${sorted.length}):\n\n${lines.join('\n\n')}`);
}
