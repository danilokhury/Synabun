import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { retrieveMemory, compactRecall } from '../services/memory-retrieval.js';
import { touchMemories } from '../services/sqlite.js';
import { validateCategory } from '../services/categories.js';
import { coerceStringArray } from './utils.js';
import type { MemoryPayload, SessionChunkPayload } from '../types.js';
import { config, detectProject } from '../config.js';
import { text } from './response.js';

// ── Recall defaults (must be defined before buildRecallSchema which runs at module level) ──

interface RecallDefaults {
  limit: number;
  minImportance: number;
  minScore: number;
  maxChars: number;
  includeSessions: 'auto' | 'always' | 'never';
  recencyBoost: boolean;
}

const RECALL_DEFAULTS: RecallDefaults = {
  limit: 5,
  minImportance: 0,
  minScore: 0.3,
  maxChars: 0,
  includeSessions: 'auto',
  recencyBoost: false,
};

function getRecallDefaults(): RecallDefaults {
  try {
    const settingsPath = path.resolve(config.dataDir, 'display-settings.json');
    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const d = data.recallDefaults;
    if (!d) {
      return { ...RECALL_DEFAULTS, maxChars: data.recallMaxChars ?? 0 };
    }
    return {
      limit: d.limit ?? RECALL_DEFAULTS.limit,
      minImportance: d.minImportance ?? RECALL_DEFAULTS.minImportance,
      minScore: d.minScore ?? RECALL_DEFAULTS.minScore,
      maxChars: d.maxChars ?? RECALL_DEFAULTS.maxChars,
      includeSessions: d.includeSessions ?? RECALL_DEFAULTS.includeSessions,
      recencyBoost: d.recencyBoost ?? RECALL_DEFAULTS.recencyBoost,
    };
  } catch {
    return { ...RECALL_DEFAULTS };
  }
}

// ── Schema builder ──

export function buildRecallSchema() {
  const defaults = getRecallDefaults();
  const sessionDesc = defaults.includeSessions === 'auto'
    ? 'Auto-triggers on temporal queries or sparse results.'
    : `Default: ${defaults.includeSessions}.`;
  // All configurable fields use .optional() — NOT .default() — so Zod never
  // injects stale schema defaults.  handleRecall() reads fresh values from
  // display-settings.json at runtime via getRecallDefaults() and applies them
  // with the ?? operator when the AI omits a parameter.

  const limitField = z.coerce.number().min(1).max(20).optional()
    .describe(`Number of results. User configured: ${defaults.limit}. OMIT this parameter to respect the user's setting. Only override if the user explicitly asks for a different count.`);

  const minImpField = defaults.minImportance > 0
    ? z.coerce.number().min(1).max(10).optional()
        .describe(`Minimum importance threshold. User configured: ${defaults.minImportance}. OMIT to use configured setting.`)
    : z.coerce.number().min(1).max(10).optional()
        .describe('Minimum importance threshold.');

  const minScoreField = z.coerce.number().min(0).max(1).optional()
    .describe(`Minimum similarity score 0-1. User configured: ${defaults.minScore}. OMIT to use configured setting.`);

  const sessionField = z.boolean().optional()
    .describe(`Override session chunk search. ${sessionDesc} Set true to force, false to disable.`);

  const recencyField = z.boolean().optional()
    .describe(`Prioritize recent memories. User configured: ${defaults.recencyBoost ? 'ON' : 'OFF'}. OMIT to use configured setting. Shifts scoring to favor recency over semantic similarity (14-day half-life, 55% recency weight). Ideal for session-start boot queries.`);

  return {
    query: z.string().describe('What to search for, in natural language.'),
    category: z
      .string()
      .optional()
      .describe('Optional: filter by category name.'),
    project: z
      .string()
      .optional()
      .describe(
        'Optional: filter by project. If omitted, searches all projects but boosts current project.'
      ),
    tags: coerceStringArray()
      .optional()
      .describe('Optional: filter by tags (any match).'),
    limit: limitField,
    min_importance: minImpField,
    min_score: minScoreField,
    include_sessions: sessionField,
    recency_boost: recencyField,
    format: z.enum(['legacy', 'compact']).optional().describe('Optional compact, budgeted excerpts. Default preserves full legacy output.'),
    token_budget: z.coerce.number().int().min(100).max(16000).optional().describe('Total estimated output tokens for compact format; default 1500.'),
    tag_match: z.enum(['any','all']).optional().describe('Match any tag (default) or require every tag.'),
    scope: z.enum(['all','project']).optional().describe('Project requires an explicit project or caller context; never widens the search.'),
    after: z.string().datetime({ offset: true }).optional().describe('Include records created at or after this ISO timestamp.'),
    before: z.string().datetime({ offset: true }).optional().describe('Include records created at or before this ISO timestamp.'),
    explain: z.boolean().optional().describe('Include retrieval reasons in compact output.'),
    rerank: z.boolean().optional().describe('Judge the shortlist for relevance after retrieval and reorder it. Slower — worth it when the query is subtle and the top hits look interchangeable.'),
  };
}

export const recallSchema = buildRecallSchema();

export const recallDescription =
  'Search your persistent memory for relevant information. Use this at the start of any task to check what you already know, or when you need context about past decisions, known issues, or architectural patterns. Prefer format="compact" for discovery; use memories action="get" for full originals.';

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
  query: string; category?: string; project?: string; tags?: string[]; limit?: number;
  min_importance?: number; min_score?: number; include_sessions?: boolean; recency_boost?: boolean;
  format?: 'legacy'|'compact'; token_budget?: number; tag_match?: 'any'|'all';
  scope?: 'all'|'project'; after?: string; before?: string; explain?: boolean; rerank?: boolean;
}) {
  const defaults = getRecallDefaults();
  if (args.category) {
    const check = validateCategory(args.category);
    if (!check.valid) return text(check.error!);
  }
  if (args.after && args.before && args.after > args.before) return text('after must not be later than before.');
  try {
    const currentProject = detectProject();
    const result = await retrieveMemory({
      ...args, currentProject, limit: args.limit ?? defaults.limit,
      judgeContext: { origin: 'tool', project: args.project ?? currentProject },
      min_score: args.min_score ?? defaults.minScore,
      min_importance: args.min_importance ?? (defaults.minImportance || undefined),
      include_sessions: args.include_sessions ?? (defaults.includeSessions === 'auto' ? undefined : defaults.includeSessions === 'always'),
      recency_boost: args.recency_boost ?? defaults.recencyBoost,
    });
    await touchMemories(result.results.filter(r=>r.type === 'memory').map(r=>r.id),new Date().toISOString());
    if (args.format === 'compact' || args.token_budget !== undefined) return text(compactRecall(result,args.query,args.token_budget ?? 1500,args.explain));
    if (!result.results.length) return text(`No memories found for "${args.query}"${args.category ? ` in category ${args.category}` : ''}${args.project ? ` for project ${args.project}` : ''}.${result.degraded.length ? ' '+result.degraded.join(' ') : ''}`);
    const memories = result.results.filter(r=>r.type === 'memory');
    const sessions = result.results.filter(r=>r.type === 'session');
    const lines = memories.map((r,i)=>{
      const p = r.payload;
      const content = defaults.maxChars > 0 && p.content.length > defaults.maxChars ? p.content.slice(0,defaults.maxChars)+'...' : p.content;
      const rank = result.engine === 'hybrid' ? `relevance: ${r.score.toFixed(3)}` : `${(r.score*100).toFixed(0)}% match`;
      return `${i+1}. [${r.id}] (${rank}, importance: ${p.importance}, ${formatAge(p.created_at)})\n   ${p.category}${p.subcategory ? '/'+p.subcategory : ''} | ${p.project} | source: ${p.source}\n   Tags: ${p.tags?.join(', ') || 'none'}\n   ${content}\n   Files: ${p.related_files?.join(', ') || 'none'}${r.flags.length ? '\n   Status: '+r.flags.join(', ') : ''}`;
    });
    if (sessions.length) lines.push('--- Session Context ---',...sessions.map(r=>`SESSION: [${r.id}] (${result.engine === 'hybrid' ? 'relevance: '+r.score.toFixed(3) : (r.score*100).toFixed(0)+'% match'}, ${r.created_at}, branch: ${r.payload.git_branch || 'unknown'})\n   Session: ${r.payload.session_id} | Chunk ${r.payload.chunk_index+1} | ${r.project}\n   ${r.payload.summary || r.content}\n   Tools: ${r.payload.tools_used?.join(', ') || 'none'} | Files: ${r.payload.files_modified?.join(', ') || 'none'}`));
    const label = sessions.length ? `Found ${memories.length} memories and ${sessions.length} session chunks` : `Found ${memories.length} memories`;
    return text(`${label} for "${args.query}":\n\n${lines.join('\n\n')}${result.degraded.length ? '\n\n'+result.degraded.join(' ') : ''}`);
  } catch (error) { return { ...text((error as Error).message), isError: true }; }
}
