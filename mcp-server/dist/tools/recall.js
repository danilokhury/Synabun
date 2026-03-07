import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateEmbedding } from '../services/local-embeddings.js';
import { searchMemories, searchMemoriesFTS, updatePayload, searchSessionChunks } from '../services/sqlite.js';
import { validateCategory } from '../services/categories.js';
import { coerceStringArray } from './utils.js';
import { config, detectProject } from '../config.js';
export function buildRecallSchema() {
    return {
        query: z.string().describe('What to search for, in natural language.'),
        category: z
            .string()
            .optional()
            .describe('Optional: filter by category name.'),
        project: z
            .string()
            .optional()
            .describe('Optional: filter by project. If omitted, searches all projects but boosts current project.'),
        tags: coerceStringArray()
            .optional()
            .describe('Optional: filter by tags (any match).'),
        limit: z
            .coerce.number()
            .min(1)
            .max(20)
            .optional()
            .describe('Number of results (default 5).'),
        min_importance: z
            .coerce.number()
            .min(1)
            .max(10)
            .optional()
            .describe('Minimum importance threshold.'),
        min_score: z
            .coerce.number()
            .min(0)
            .max(1)
            .optional()
            .describe('Minimum similarity score 0-1 (default 0.3).'),
        include_sessions: z
            .boolean()
            .optional()
            .describe('Override session chunk search. Auto-triggers on temporal queries or sparse results. Set true to force, false to disable.'),
        recency_boost: z
            .boolean()
            .optional()
            .describe('Prioritize recent memories. Shifts scoring to favor recency over semantic similarity (14-day half-life, 55% recency weight). Ideal for session-start boot queries.'),
    };
}
export const recallSchema = buildRecallSchema();
export const recallDescription = 'Search your persistent memory for relevant information. Use this at the start of any task to check what you already know, or when you need context about past decisions, known issues, or architectural patterns.';
function applyTimeDecay(rawScore, createdAt, importance, accessCount, recencyBoost = false) {
    const ageInDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const accessBoost = Math.min(0.1, accessCount * 0.01);
    if (recencyBoost) {
        // Recency-first scoring: 14-day half-life, recency dominates
        const recencyMultiplier = Math.pow(0.5, ageInDays / 14);
        return rawScore * 0.35 + recencyMultiplier * 0.55 + accessBoost;
    }
    // Default scoring: semantic similarity dominates, 90-day half-life
    if (importance >= 8)
        return rawScore;
    const recencyMultiplier = Math.pow(0.5, ageInDays / 90);
    return rawScore * 0.7 + recencyMultiplier * 0.2 + accessBoost;
}
function formatAge(isoDate) {
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (days === 0)
        return 'today';
    if (days === 1)
        return '1 day ago';
    if (days < 30)
        return `${days} days ago`;
    const months = Math.floor(days / 30);
    if (months === 1)
        return '1 month ago';
    return `${months} months ago`;
}
function getRecallMaxChars() {
    try {
        const settingsPath = path.resolve(config.dataDir, 'display-settings.json');
        const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        return data.recallMaxChars ?? 0;
    }
    catch {
        return 0; // default: no limit
    }
}
export async function handleRecall(args) {
    const query = args.query;
    const category = args.category;
    const project = args.project;
    const tags = args.tags;
    const limit = args.limit ?? 5;
    const minImportance = args.min_importance;
    const minScore = args.min_score ?? 0.3;
    const includeSessionsExplicit = args.include_sessions;
    const recencyBoost = args.recency_boost ?? false;
    if (category) {
        const catCheck = validateCategory(category);
        if (!catCheck.valid) {
            return {
                content: [{ type: 'text', text: catCheck.error }],
            };
        }
    }
    const vector = await generateEmbedding(query);
    const must = [];
    if (category)
        must.push({ key: 'category', match: { value: category } });
    if (project)
        must.push({ key: 'project', match: { value: project } });
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
        const payload = r.payload;
        let adjustedScore = applyTimeDecay(r.score, payload.created_at, payload.importance, payload.access_count, recencyBoost);
        if (!project && payload.project === currentProject) {
            adjustedScore *= 1.2;
        }
        return { id: r.id, score: adjustedScore, payload };
    })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    // FTS5 keyword fallback — when vector results are weak, supplement with
    // full-text search to catch exact identifiers, error codes, proper nouns
    const FTS_TRIGGER_SCORE = 0.45;
    const vectorWeak = scored.length === 0 ||
        (scored.length < limit && scored[0]?.score < FTS_TRIGGER_SCORE);
    if (vectorWeak) {
        try {
            const existingIds = new Set(scored.map(r => r.id));
            const ftsResults = await searchMemoriesFTS(query, limit, filter, existingIds);
            for (const fts of ftsResults) {
                if (scored.length >= limit)
                    break;
                scored.push(fts);
            }
            // Re-sort after merge
            scored.sort((a, b) => b.score - a.score);
        }
        catch {
            // FTS fallback failure is non-fatal
        }
    }
    // Update access tracking (fire-and-forget)
    const now = new Date().toISOString();
    for (const result of scored) {
        updatePayload(result.id, {
            accessed_at: now,
            access_count: result.payload.access_count + 1,
        }).catch(() => { });
    }
    if (scored.length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: `No memories found for "${query}"${category ? ` in category ${category}` : ''}${project ? ` for project ${project}` : ''}.`,
                },
            ],
        };
    }
    const maxChars = getRecallMaxChars();
    const lines = scored.map((r, i) => {
        const p = r.payload;
        const score = (r.score * 100).toFixed(0);
        const tagStr = p.tags?.length ? ` [${p.tags.join(', ')}]` : '';
        const sub = p.subcategory ? `/${p.subcategory}` : '';
        const files = p.related_files?.length
            ? `\n   Files: ${p.related_files.join(', ')}`
            : '';
        const displayContent = (maxChars > 0 && p.content.length > maxChars)
            ? p.content.substring(0, maxChars) + '...'
            : p.content;
        return `${i + 1}. [${r.id}] (${score}% match, importance: ${p.importance}, ${formatAge(p.created_at)})\n   ${p.category}${sub} | ${p.project}${tagStr}\n   ${displayContent}${files}`;
    });
    // Session chunk search — auto-trigger when useful, or explicit override
    const shouldIncludeSessions = (() => {
        // Explicit override takes priority
        if (includeSessionsExplicit !== undefined)
            return includeSessionsExplicit;
        // Temporal/process keywords → likely asking about past sessions
        const q = query.toLowerCase();
        const sessionKeywords = [
            'yesterday', 'last session', 'last time', 'remember when',
            'how did we', 'what did we', 'earlier today', 'previous session',
            'conversation about', 'we discussed', 'we worked on', 'we talked about',
            'that session', 'that conversation', 'the other day', 'last week',
            'before', 'recently', 'a while ago', 'few days ago',
        ];
        if (sessionKeywords.some(kw => q.includes(kw)))
            return true;
        // Sparse/weak memory results → widen the net
        if (scored.length < 3)
            return true;
        if (scored.length > 0 && scored[0].score < 0.45)
            return true;
        return false;
    })();
    let sessionLines = [];
    if (shouldIncludeSessions) {
        try {
            const sessionFilter = {};
            if (project) {
                sessionFilter.must = [{ key: 'project', match: { value: project } }];
            }
            const sessionLimit = Math.max(3, Math.floor(limit / 2));
            const sessionResults = await searchSessionChunks(vector, sessionLimit * 2, Object.keys(sessionFilter).length > 0 ? sessionFilter : undefined, minScore);
            // Deduplicate: skip chunks whose dedup_memory_id matches a returned memory
            const memoryIds = new Set(scored.map((r) => r.id));
            const filteredSessions = sessionResults.filter((r) => {
                const payload = r.payload;
                return !payload.dedup_memory_id || !memoryIds.has(payload.dedup_memory_id);
            }).slice(0, sessionLimit);
            sessionLines = filteredSessions.map((r, i) => {
                const p = r.payload;
                const score = (r.score * 100).toFixed(0);
                const timeRange = p.start_timestamp && p.end_timestamp
                    ? `${new Date(p.start_timestamp).toISOString().slice(0, 16)} - ${new Date(p.end_timestamp).toISOString().slice(11, 16)}`
                    : 'unknown time';
                const toolStr = p.tools_used?.length ? `Tools: ${p.tools_used.join(', ')}` : '';
                const fileStr = p.files_modified?.length ? `Files: ${p.files_modified.join(', ')}` : '';
                const linkedMems = p.related_memory_ids?.length ? `Linked memories: ${p.related_memory_ids.join(', ')}` : '';
                const details = [toolStr, fileStr, linkedMems].filter(Boolean).join(' | ');
                return `SESSION: [${r.id}] (${score}% match, ${timeRange}, branch: ${p.git_branch || 'unknown'})\n   Session: ${p.session_id} | Chunk ${p.chunk_index + 1} | ${p.project}\n   ${p.summary}\n   ${details}`;
            });
        }
        catch {
            // Session search failure is non-fatal
        }
    }
    const allLines = [...lines];
    if (sessionLines.length > 0) {
        allLines.push('', '--- Session Context ---');
        allLines.push(...sessionLines);
    }
    const totalCount = scored.length + sessionLines.length;
    const label = sessionLines.length > 0
        ? `Found ${scored.length} memories and ${sessionLines.length} session chunks`
        : `Found ${scored.length} memories`;
    return {
        content: [
            {
                type: 'text',
                text: `${label} for "${query}":\n\n${allLines.join('\n\n')}`,
            },
        ],
    };
}
//# sourceMappingURL=recall.js.map