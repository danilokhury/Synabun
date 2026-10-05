import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { getDb, memoryVectors, chunkVectors, rowToPayload, rowToSessionChunkPayload } from './sqlite.js';
import { VectorCache } from './vector-cache.js';
import { judgeHistoricalQuery, judgeRelevance, orderByJudgedScore, RELEVANCE_CANDIDATE_CLIP, type JudgeContext } from './memory-judgments.js';
import { generateEmbedding, EMBEDDING_VERSION } from './local-embeddings.js';
import { projectAliases } from '../config.js';
import { judgedStale } from './edit-stale.js';

export interface RecallOptions {
  query: string; project?: string; currentProject?: string; category?: string; tags?: string[];
  tag_match?: 'any' | 'all'; limit?: number; min_score?: number; min_importance?: number;
  include_sessions?: boolean; recency_boost?: boolean; after?: string; before?: string;
  scope?: 'all' | 'project'; engine?: 'legacy' | 'hybrid';
  // Internal automatic-injection gate; explicit recall keeps keyword-only hits.
  min_semantic_score?: number;
  // Judge the shortlist after fusion. Opt-in: it cannot start until retrieval
  // has finished, so unlike the superseded judgment it is not free wall clock.
  // Off for automatic injection, which answers inside a fixed hook budget.
  rerank?: boolean;
  // false: no judgment of any kind for this call (a session that opted out).
  judge?: boolean;
  // Attribution for the judgments this call makes (origin, session, project).
  judgeContext?: JudgeContext;
}
export interface RecallHit {
  id: string; type: 'memory' | 'session'; content: string; project: string; category: string;
  source: string; created_at: string; score: number; revision: number; flags: string[];
  payload: Record<string, any>; reasons: string[];
  semantic_score?: number; passage_score?: number; keyword_coverage?: number; fusion_score?: number;
}
export interface RecallResult { results: RecallHit[]; degraded: string[]; engine: string; elapsed_ms: number; timings?: Record<string,number> }
const passages = new VectorCache(getDb, 'SELECT id,vector FROM memory_passages', 'SELECT vector FROM memory_passages WHERE id=?', 'memory_passages');
const metrics = { calls: 0, degraded: 0, total_ms: 0, last_ms: 0 };
const recentTimes: number[]=[];
const filterCache=new Map<string,Set<string>>();
let filterConnection: ReturnType<typeof getDb> | null=null;
let filterEpoch=-1;
function memoryIds(sql:string,params:(string|number)[]) {
  const d=getDb();
  const epoch=Number(d.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM memory_changes WHERE entity='memory_filters'").get()?.n || 0);
  if(d!==filterConnection || epoch!==filterEpoch){filterCache.clear();filterConnection=d;filterEpoch=epoch;}
  const key=JSON.stringify([sql,params]);
  let ids=filterCache.get(key);
  if(!ids) {
    ids=new Set(d.prepare(`SELECT m.id FROM memories m WHERE ${sql}`).all(...params).map(r=>String(r.id)));
    filterCache.set(key,ids);
    let total=0;for(const value of filterCache.values())total+=value.size;
    while(filterCache.size>32 || (total>100000 && filterCache.size>1)) {
      const oldest=filterCache.keys().next().value!;total-=filterCache.get(oldest)!.size;filterCache.delete(oldest);
    }
  }
  return ids;
}
export function retrievalMetrics() {
  const sorted=[...recentTimes].sort((a,b)=>a-b);
  return { ...metrics, p50_ms:sorted[Math.floor(sorted.length*.5)] ?? 0, p95_ms:sorted[Math.floor(sorted.length*.95)] ?? 0 };
}
export function resetPassageCache() { passages.invalidate(); }
export function hybridEnabled(): boolean {
  if (process.env.SYNABUN_MEMORY_ENGINE) return process.env.SYNABUN_MEMORY_ENGINE === 'hybrid';
  const configured=(getDb().prepare("SELECT value FROM kv_config WHERE key='memory_engine'").get() as {value:string} | undefined)?.value;
  // Enabled after the checked-in relevance, latency and compatibility gates.
  // An explicit legacy setting remains an immediate retrieval rollback.
  return configured ? configured === 'hybrid' : true;
}
const stopwords = new Set('the a an is are was were to of for in on and or with my our your we i how what when about do did does this that it at as by from please memory memories synabun'.split(' '));
const conversationalWords = new Set('there here better same something anything can could would should me you us some any also just maybe really now then than'.split(' '));
export function queryTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_]+(?:[-./:][\p{L}\p{N}_]+)*/gu) || [];
  const terms = [...new Set(tokens.filter(t => !stopwords.has(t) && t.length > 1))];
  const specific = terms.filter(t => !conversationalWords.has(t));
  return (specific.length ? specific : terms).slice(0, 32);
}

function filterSql(o: RecallOptions, session: boolean) {
  const clauses = session ? ['NOT EXISTS(SELECT 1 FROM memories hidden WHERE hidden.id=m.id AND hidden.trashed_at IS NOT NULL)'] : ['m.trashed_at IS NULL'];
  const params: (string | number)[] = [];
  const project = o.project || (o.scope === 'project' ? o.currentProject : undefined);
  if (o.scope === 'project' && (!project || (!o.project && project === 'global'))) throw new Error('Project scope requires a project or caller project context.');
  if (project) {
    const aliases = projectAliases(project);
    clauses.push(`lower(m.project) IN (${aliases.map(() => '?').join(',')})`);
    params.push(...aliases.map(p => p.toLowerCase()));
  }
  if (o.category) { clauses.push(session ? (o.category === 'conversations' ? '1=1' : '0=1') : 'm.category=?'); if (!session) params.push(o.category); }
  if (o.tags?.length) {
    if (session) clauses.push('0=1'); // session tools are not memory tags
    else {
      clauses.push('(' + o.tags.map(tag => { params.push(tag); return 'EXISTS(SELECT 1 FROM json_each(m.tags) WHERE value=?)'; }).join(o.tag_match === 'all' ? ' AND ' : ' OR ') + ')');
    }
  }
  if (o.min_importance) { clauses.push(session ? '0=1' : 'm.importance>=?'); if (!session) params.push(o.min_importance); }
  if (o.after) { clauses.push(`${session ? 'm.start_timestamp' : 'm.created_at'}>=?`); params.push(o.after); }
  if (o.before) { clauses.push(`${session ? 'm.start_timestamp' : 'm.created_at'}<=?`); params.push(o.before); }
  return { sql: clauses.join(' AND '), params };
}

function hydrate(row: Record<string, any>, session: boolean, score = 0): RecallHit {
  const p = session ? rowToSessionChunkPayload(row) : rowToPayload(row);
  return { id: row.id, type: session ? 'session' : 'memory', content: p.content, project: p.project,
    category: session ? 'conversations' : row.category, source: session ? 'session' : row.source,
    created_at: session ? row.start_timestamp : row.created_at, score,
    revision: session ? 0 : Number(row.revision || 1), flags: [], payload: p, reasons: [] };
}

/** Both adapters call this engine; formatting remains transport-specific. */
export async function retrieveMemory(o: RecallOptions, embed = generateEmbedding): Promise<RecallResult> {
  const start = performance.now();
  const timings: Record<string,number>={};
  let stage=start;
  const mark=(name:string)=>{const now=performance.now();timings[name]=now-stage;stage=now;};
  const d = getDb();
  const engine = o.engine || (hybridEnabled() ? 'hybrid' : 'legacy');
  const hybrid = engine === 'hybrid';
  const limit = Math.max(1, Math.min(50, o.limit ?? 5));
  const k = hybrid ? 50 : limit * 2;
  const min = o.min_score ?? 0.3;
  const terms = queryTerms(o.query);
  const degraded: string[] = [];
  const found = new Map<string, RecallHit>();
  const ranks = new Map<string, number>();
  const memoryFilter = filterSql(o, false);
  const sessionFilter = filterSql(o, true);
  const wantedSessions = o.include_sessions ?? (/yesterday|last |previous|recent|session|conversation|ontem|sessão|conversa/i.test(o.query));
  let vector: number[] | null = null;
  // UUID reads bypass inference entirely.
  const uuid = o.query.trim().match(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)?.[0];
  if (uuid) {
    const row = d.prepare(`SELECT m.* FROM memories m WHERE m.id=? AND ${memoryFilter.sql}`).get(uuid, ...memoryFilter.params);
    if (row) { const h = hydrate(row, false, 1); h.reasons = ['exact UUID']; return {results:[h],degraded,engine,elapsed_ms:performance.now()-start}; }
  }
  const pendingEmbedding=embed(o.query).catch(()=>null);

  function add(hit: RecallHit, rank: number, reason: string) {
    const key = `${hit.type}:${hit.id}`;
    const previous = found.get(key);
    const channel = ({semantic:'semantic_score',passage:'passage_score',keyword:'keyword_coverage'} as const)[reason as 'semantic'|'passage'|'keyword'];
    if (channel) {
      hit[channel] = hit.score;
      if (previous) previous[channel] = Math.max(previous[channel] ?? -Infinity, hit.score);
    }
    // A long document can match many passages; it gets one vote per channel.
    if (previous?.reasons.includes(reason)) { previous.score=Math.max(previous.score,hit.score); return; }
    if (previous) { previous.score = Math.max(previous.score, hit.score); previous.reasons.push(reason); }
    else { hit.reasons.push(reason); found.set(key, hit); }
    ranks.set(key, (ranks.get(key) || 0) + 1 / (60 + rank));
  }
  function search(session: boolean, lexical: boolean) {
    const table = session ? 'session_chunks' : 'memories';
    const filter = session ? sessionFilter : memoryFilter;
    if (lexical) {
      if (!terms.length) return;
      const fts = session ? 'chunk_search' : 'memory_search';
      try {
        const rows = d.prepare(`SELECT m.* FROM ${fts} f JOIN ${table} m ON m.id=f.id
          WHERE ${fts} MATCH ? AND ${filter.sql} ORDER BY bm25(${fts}) LIMIT ?`)
          .all(terms.map(t => `"${t.replace(/"/g,'""')}"`).join(' OR '), ...filter.params, k);
        rows.forEach((row, i) => {
          const h = hydrate(row, session);
          const body = `${h.content} ${h.payload.related_files || h.payload.files_modified || ''}`.toLowerCase();
          const covered = terms.filter(t => body.includes(t)).length / terms.length;
          h.score = covered;
          if (covered >= min) add(h, i + 1, 'keyword');
        });
      } catch (error) { degraded.push(`Keyword index unavailable (${session ? 'sessions' : 'memories'}).`); }
    } else if (vector) {
      const ids = session ? new Set((d.prepare(`SELECT m.id FROM ${table} m WHERE ${filter.sql}`).all(...filter.params)).map(r => String(r.id)))
        : memoryIds(filter.sql,filter.params);
      const hits = (session ? chunkVectors : memoryVectors).topK(vector, k, hybrid ? min : min * 0.5, ids);
      const hydrateRow = d.prepare(`SELECT m.* FROM ${table} m WHERE m.id=? AND ${filter.sql}`);
      hits.forEach((hit, i) => {
        const row = hydrateRow.get(hit.id,...filter.params);
        if (row) add(hydrate(row, session, hit.score), i + 1, 'semantic');
      });
    }
  }
  if(hybrid)search(false,true);
  mark('keyword');
  vector=await pendingEmbedding;
  mark('embedding_wait');
  if(!vector)degraded.push('Local embeddings unavailable; keyword retrieval used.');
  search(false, false);
  mark('document_vectors');
  if (!hybrid && (!vector || found.size < limit)) search(false, true);
  if (hybrid && vector && found.size) {
    const parents=[...found.values()].filter(r=>r.type==='memory').map(r=>r.id).slice(0,100);
    const ids = new Set(d.prepare(`SELECT p.id FROM memory_passages p INDEXED BY memory_passages_parent CROSS JOIN memories m ON m.id=p.memory_id
      JOIN memory_metadata md ON md.memory_id=m.id WHERE p.memory_id IN (${parents.map(()=>'?').join(',')}) AND ${memoryFilter.sql} AND p.model=? AND p.content_hash=md.content_hash
      AND NOT EXISTS(SELECT 1 FROM memory_jobs j WHERE j.entity_id=m.id AND j.kind='index' AND j.status!='complete')`)
      .all(...parents,...memoryFilter.params, EMBEDDING_VERSION).map(r => String(r.id)));
    mark('passage_filter');
    const parentRow = d.prepare('SELECT m.* FROM memory_passages p JOIN memories m ON m.id=p.memory_id WHERE p.id=? AND m.trashed_at IS NULL');
    for (const [i, hit] of passages.topK(vector, k, min, ids).entries()) {
      const row = parentRow.get(hit.id);
      if (row) add(hydrate(row, false, hit.score), i+1, 'passage');
    }
  }
  mark('passage_vectors');
  if (o.include_sessions !== false && (wantedSessions || found.size < 3)) { search(true,false); search(true,true); }
  // Preserve actual document cosine even for a keyword-only candidate. Fusion
  // rank is not a probability and must never substitute for semantic evidence.
  if (vector) {
    const ids = new Set([...found.values()].filter(h=>h.type==='memory').map(h=>h.id));
    for (const h of memoryVectors.topK(vector, ids.size, -Infinity, ids)) {
      const candidate = found.get(`memory:${h.id}`);
      if (candidate) candidate.semantic_score = h.score;
    }
  }
  const now = Date.now();
  const aliases = o.currentProject ? projectAliases(o.currentProject).map(p=>p.toLowerCase()) : [];
  const readRevision=d.prepare('SELECT MAX(revision) AS n FROM memory_revisions WHERE memory_id=?');
  const readRelations=d.prepare(`SELECT r.*,m.id AS live FROM memory_relations r LEFT JOIN memories m ON m.id=CASE WHEN r.from_id=? THEN r.to_id ELSE r.from_id END
    AND m.trashed_at IS NULL WHERE (r.from_id=? OR r.to_id=?) AND r.active=1`);
  for (const [key, h] of found) {
    const age = Math.max(0, (now - Date.parse(h.created_at)) / 86400000) || 0;
    if (hybrid) {
      h.score = ranks.get(key)!;
      // Exact rare identifiers and dates take precedence over generic matches.
      const identifiers = terms.filter(t => /[\d_./:]/.test(t));
      if (identifiers.length && identifiers.every(t => h.content.toLowerCase().includes(t))) { h.score += 0.025; h.reasons.push('exact identifier'); }
      if (o.recency_boost) h.score *= 1 + 0.15 * Math.pow(0.5, age / 14);
      if (!o.project && aliases.includes(h.project.toLowerCase())) h.score *= 1.1;
      h.fusion_score = h.score;
    } else if (h.type === 'memory' && !h.reasons.includes('keyword')) {
      const boost = Math.min(0.1, (h.payload.access_count || 0)*0.01);
      h.score = o.recency_boost ? h.score*0.35 + Math.pow(0.5,age/14)*0.55+boost
        : h.payload.importance >= 8 ? h.score : h.score*0.7+Math.pow(0.5,age/90)*0.2+boost;
      if (!o.project && h.project === o.currentProject) h.score *= 1.2;
    }
    if (h.type === 'memory') {
      const relations = readRelations.all(h.id,h.id,h.id);
      for (const r of relations) {
        if (!r.live) continue;
        if (r.kind === 'supersedes' && r.to_id === h.id) h.flags.push('superseded');
        if (r.kind === 'conflicts_with' || r.kind === 'possible_conflict') h.flags.push(String(r.kind));
      }
    }
  }
  const sorted = [...found.values()].filter(h => hybrid || h.score >= min).sort((a,b) =>
    (!hybrid && a.type !== b.type ? (a.type === 'memory' ? -1 : 1) : b.score-a.score) || a.id.localeCompare(b.id));
  // "Is this query about the past?" only decides whether superseded memories
  // are shown, so it is asked only when one is among the candidates. Firing it
  // on every recall (as the first version did, racing a fixed 1200 ms) made
  // every recall wait on an answer nothing consulted: supersession is rare,
  // and a third of those calls timed out from a cold connection anyway. When
  // it is needed, the surface's own timeout bounds the wait and a miss falls
  // back to the regex below.
  const needsHistorical = hybrid && !o.before && o.judge !== false && sorted.some(h => h.flags.includes('superseded'));
  const historical = needsHistorical ? await judgeHistoricalQuery(o.query, o.judgeContext) : null;
  // Judging needs a shortlist wider than the answer, or there is nothing to reorder.
  const collect = o.rerank && hybrid && o.judge !== false ? Math.max(limit, 10) : limit;
  const results: RecallHit[] = [];
  const seen = new Set<string>();
  const byHash = new Map<string,string>();
  for (const h of sorted) {
    if (o.min_semantic_score !== undefined && Math.max(h.semantic_score ?? -Infinity, h.passage_score ?? -Infinity) < o.min_semantic_score) continue;
    if(!hybrid && results.filter(r=>r.type===h.type).length >= (h.type==='memory' ? limit : Math.max(3,Math.floor(limit/2))))continue;
    if(h.type==='session' && h.payload.dedup_memory_id && seen.has(h.payload.dedup_memory_id))continue;
    // The judgment answers this in any language; the regex, which only ever
    // spoke English and Portuguese, stays as the fallback when it is missing.
    if (hybrid && h.flags.includes('superseded') && !o.before
      && !(historical ?? /history|histor|previous|old|antes|anterior/i.test(o.query))) continue;
    const hash = createHash('sha256').update(`${h.project.toLowerCase()}\0${h.category}\0${h.source === 'session' || h.payload.subcategory === 'session-chunk' ? 'session' : h.source}\0${JSON.stringify([...(h.payload.tags || [])].sort())}\0${h.content}`).digest('hex');
    // A legacy mirrored chunk shares its UUID with the session row.
    if (seen.has(h.id)) continue;
    if (hybrid && byHash.has(hash)) {
      const previous=byHash.get(hash)!;
      const undone=d.prepare("SELECT 1 FROM memory_relations WHERE kind='duplicate_of' AND active=0 AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))")
        .get(h.id,previous,previous,h.id);
      if(!undone)continue;
    }
    seen.add(h.id); seen.add(hash);
    byHash.set(hash,h.id);
    if(h.type === 'memory') h.revision=Number((readRevision.get(h.id) as {n:number}).n || 1);
    if(h.type==='memory' && h.payload.file_checksums && Object.keys(h.payload.file_checksums).length) {
      const verification=d.prepare('SELECT verification,verified_revision,checked_at,stale_verdicts FROM memory_metadata WHERE memory_id=?').get(h.id);
      if(verification?.verification==='stale')h.flags.push('source needs recheck');
      // An edit-time judgment found this revision no longer matches its file.
      if(verification?.stale_verdicts && judgedStale(verification.stale_verdicts,h.revision))h.flags.push('judged stale');
      if(verification?.verified_revision!==h.revision || Date.now()-Date.parse(String(verification?.checked_at || ''))>300000 || !verification?.checked_at) {
        d.prepare(`INSERT INTO memory_jobs(id,kind,entity_id,updated_at) VALUES(?,'verify',?,?)
          ON CONFLICT(kind,entity_id) DO UPDATE SET status=CASE WHEN status='running' THEN status ELSE 'pending' END,attempts=0,updated_at=excluded.updated_at`)
          .run(`verify:${h.id}`,h.id,new Date().toISOString());
      }
    }
    results.push(h);
    if (hybrid && results.length >= collect) break;
  }
  if (collect > limit && results.length > 1) {
    // Rank after fusion, not instead of it. A missing or partial judgment
    // leaves the fusion order in place; only judged hits move.
    const judged = await judgeRelevance(o.query, results.map(h=>({id:h.id,content:excerpt(h.content,o.query,RELEVANCE_CANDIDATE_CLIP)})), o.judgeContext);
    if (judged?.size) {
      const ordered = orderByJudgedScore(results, judged);
      results.splice(0, results.length, ...ordered);
      for (const h of results) if (judged.has(h.id)) h.reasons.push('judged relevance');
    }
  }
  if (collect > limit) results.length = Math.min(results.length, limit);
  const elapsed_ms = performance.now()-start;
  metrics.calls++; metrics.degraded += degraded.length ? 1 : 0; metrics.total_ms += elapsed_ms; metrics.last_ms = elapsed_ms;
  recentTimes.push(elapsed_ms);if(recentTimes.length>500)recentTimes.shift();
  mark('rank_and_metadata');
  return { results, degraded, engine, elapsed_ms, timings };
}

/** Conservative local estimate; explicitly not a provider tokenizer. */
export function estimateTokens(value: string) { return Math.ceil(Buffer.byteLength(value, 'utf8') / 3); }
export function excerpt(content: string, query: string, maxChars = 700): string {
  if (content.length <= maxChars) return content;
  const terms = queryTerms(query);
  const spans = content.match(/[^\n.!?]+(?:[.!?](?=\s)|\n|$)/g) || [content];
  const ranked = spans.map((text,index) => ({text,index,score:terms.filter(t => text.toLowerCase().includes(t)).length})).sort((a,b) => b.score-a.score || a.index-b.index);
  const chosen: typeof ranked = [];
  let size = 0;
  for (const span of ranked) {
    if (span.text.length > maxChars) {
      if (chosen.length) continue;
      const term = terms.find(t => span.text.toLowerCase().includes(t));
      const at = term ? span.text.toLowerCase().indexOf(term) : 0;
      const start = Math.max(0,at-100);
      chosen.push({...span,text:(start ? '…' : '')+span.text.slice(start,start+maxChars-2)+'…'}); break;
    }
    if (size+span.text.length+3 > maxChars) continue;
    chosen.push(span); size += span.text.length+3;
  }
  return chosen.sort((a,b)=>a.index-b.index).map(s=>s.text.trim()).join(' … ');
}
export function compactRecall(result: RecallResult, query: string, budget = 1500, explain = false) {
  const header = `SynaBun: ${result.engine} retrieval. Token counts are local estimates.${result.degraded.length ? ' '+result.degraded.join(' ') : ''}`;
  const lines = [header];
  for (const h of result.results) {
    const meta = `[${h.id}] r${h.revision} ${h.type} | ${h.project} | ${h.category} | ${h.source} | ${h.created_at}${h.flags.length ? ' | '+h.flags.join(',') : ''}`;
    const remaining = (budget-estimateTokens(lines.join('\n\n')+'\n\n'+meta+'\n'))*3;
    if (remaining < 60) break;
    let chars = Math.min(700,remaining);
    let line = '';
    do {
      line = meta+'\n'+excerpt(h.content,query,chars)+(explain ? '\nMatched: '+h.reasons.join(', ')+'; scores: '+JSON.stringify({semantic:h.semantic_score,passage:h.passage_score,keyword_coverage:h.keyword_coverage,fusion:h.fusion_score}) : '');
      if (estimateTokens([...lines,line].join('\n\n')) <= budget) break;
      chars = Math.floor(chars*0.8);
    } while (chars >= 40);
    if (estimateTokens([...lines,line].join('\n\n')) > budget) continue;
    lines.push(line);
  }
  if (lines.length === 1 && !result.results.length) lines.push('No relevant evidence found.');
  return estimateTokens(lines.join('\n\n')) <= budget ? lines.join('\n\n') : '';
}
