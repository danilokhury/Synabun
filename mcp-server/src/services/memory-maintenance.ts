import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, rowToPayload, upsertMemory, memoryVectors } from './sqlite.js';
import { embedPassages, EMBEDDING_VERSION } from './local-embeddings.js';
import { retrievalMetrics, compactRecall, type RecallHit } from './memory-retrieval.js';
import { projectAliases } from '../config.js';
import { verifyMemorySources } from './memory-verification.js';
import { judgeMemory, judgeRelations, DEFAULT_RELATION_THRESHOLDS, type MemoryJudgment, type RelationJudgment, type RelationThresholds } from './memory-judgments.js';
import { typesafeStats } from './typesafe.js';
import { typesafeConfig, surfaceConfig, logSessionFromRef } from './typesafe-config.js';

/**
 * What the relations request asks and how its answers map, read from the
 * knobs before any judgment (never inside the write transaction): whether
 * supersession rides along, and the duplicate cutoff (relations.minConfidence).
 * The contradiction cutoff stays a constant on purpose.
 */
export function relationJudgeOptions(): { askSupersession: boolean; thresholds: RelationThresholds } {
  const relations = surfaceConfig('relations');
  return {
    askSupersession: surfaceConfig('supersession').enabled,
    thresholds: { ...DEFAULT_RELATION_THRESHOLDS, duplicate: relations.minConfidence ?? DEFAULT_RELATION_THRESHOLDS.duplicate },
  };
}

/** Cosine floor for pairs worth judging. Below the legacy cutoff on purpose:
 * the model decides what the pair actually is, so retrieval only has to be
 * generous enough not to miss it. */
const RELATION_CANDIDATE_THRESHOLD = 0.85;
/** The pre-TypeSafe cutoff, kept for the fallback path so an outage reproduces
 * yesterday's behaviour exactly rather than a looser version of it. */
const LEGACY_RELATION_THRESHOLD = 0.92;

export function contentHash(text: string) { return createHash('sha256').update(text).digest('hex'); }
export function memoryRevision(id: string): number {
  return Number((getDb().prepare('SELECT MAX(revision) AS n FROM memory_revisions WHERE memory_id=?').get(id) as {n:number}).n || 0);
}
export function memoryHistory(id: string, limit = 20) {
  return getDb().prepare('SELECT revision,payload,recorded_at FROM memory_revisions WHERE memory_id=? ORDER BY revision DESC LIMIT ?')
    .all(id,limit).map(row=>({...row,payload:rowToPayload(JSON.parse(String(row.payload)))}));
}
export function projectContext(project: string, budget = 1500) {
  if(!project || project==='global')throw new Error('Project context requires an explicit project.');
  const aliases=projectAliases(project).map(p=>p.toLowerCase());
  const d=getDb();
  const hits: RecallHit[]=[];
  const seen=new Set<string>();
  // 'fact' joined the set when kind became a judgment rather than a category
  // regex; without it, every memory judged a reference fact fell out of context.
  for(const kind of ['decision','issue','preference','fact','note']) {
    const rows=d.prepare(`SELECT m.*,md.kind FROM memories m LEFT JOIN memory_metadata md ON md.memory_id=m.id
      WHERE m.trashed_at IS NULL AND lower(m.project) IN (${aliases.map(()=>'?').join(',')})
      AND COALESCE(md.kind,'note')=? AND NOT EXISTS(SELECT 1 FROM memory_relations r JOIN memories newer ON newer.id=r.from_id
        WHERE r.to_id=m.id AND r.kind='supersedes' AND r.active=1 AND newer.trashed_at IS NULL)
      ORDER BY m.updated_at DESC,m.id LIMIT 3`).all(...aliases,kind);
    for(const row of rows) {
      const id=String(row.id);if(seen.has(id))continue;seen.add(id);
      const payload=rowToPayload(row);
      hits.push({id,type:'memory',project:payload.project,category:payload.category,source:payload.source,content:payload.content,
        created_at:payload.updated_at,revision:memoryRevision(id),flags:[kind],score:1,payload,reasons:['project context']});
    }
  }
  return compactRecall({results:hits,degraded:[],engine:'project context',elapsed_ms:0},'current decisions open issues preferences recent work',budget);
}
export function setRelation(from: string, to: string, kind: string, automatic = false) {
  if (from === to) throw new Error('A memory cannot relate to itself.');
  if(['similar','possible_conflict','conflicts_with'].includes(kind) && from>to)[from,to]=[to,from];
  const d = getDb();
  const rows = d.prepare('SELECT id,project,category,source,created_at FROM memories WHERE id IN (?,?) AND trashed_at IS NULL').all(from,to);
  if (rows.length !== 2 || rows[0].project !== rows[1].project) throw new Error('Relationships require two live memories in the same project.');
  if (kind === 'duplicate_of') {
    // duplicate_of points the NEWER memory at the older one whichever way the
    // caller passed the pair, so a pair judged from both ends collides on one
    // row instead of storing two opposing ones. Migration v5 repaired the
    // rows written before this rule lived here.
    const at = new Map(rows.map(r => [String(r.id), String(r.created_at ?? '')]));
    const fromAt = at.get(from) ?? '', toAt = at.get(to) ?? '';
    if (fromAt < toAt || (fromAt === toAt && from < to)) [from, to] = [to, from];
  }
  if (kind === 'supersedes') {
    const cycle = d.prepare(`WITH RECURSIVE successors(id) AS (SELECT to_id FROM memory_relations WHERE from_id=? AND kind='supersedes' AND active=1
      UNION SELECT r.to_id FROM memory_relations r JOIN successors s ON r.from_id=s.id WHERE r.kind='supersedes' AND r.active=1)
      SELECT 1 FROM successors WHERE id=?`).get(to,from);
    if (cycle) throw new Error('Supersession would create a cycle.');
  }
  const id = randomUUID();
  const prior = d.prepare('SELECT * FROM memory_relations WHERE from_id=? AND to_id=? AND kind=?').get(from,to,kind);
  if (automatic && prior?.active === 0) return prior; // respect an explicit undo
  d.prepare(`INSERT INTO memory_relations(id,from_id,to_id,kind,automatic,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(from_id,to_id,kind) DO UPDATE SET active=1`).run(id,from,to,kind,automatic ? 1 : 0,new Date().toISOString());
  return d.prepare('SELECT * FROM memory_relations WHERE from_id=? AND to_id=? AND kind=?').get(from,to,kind);
}
export function undoRevision(id: string, revision: number, expected: number) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    if (memoryRevision(id) !== expected) throw new Error('Revision conflict; fetch the memory again before undo.');
    const row = d.prepare('SELECT payload,vector FROM memory_revisions WHERE memory_id=? AND revision=?').get(id,revision);
    if (!row || !d.prepare('SELECT 1 FROM memories WHERE id=?').get(id)) throw new Error('Memory or revision not found.');
    const blob = row.vector as Uint8Array;
    upsertMemory(id,Array.from(new Float32Array(blob.buffer,blob.byteOffset,blob.byteLength/4)),{
      ...rowToPayload(JSON.parse(String(row.payload))), updated_at:new Date().toISOString(),
    });
    d.exec('COMMIT');
    return memoryRevision(id);
  } catch (error) { d.exec('ROLLBACK'); memoryVectors.invalidate(); throw error; }
}

export function maintenanceStatus() {
  const d = getDb();
  return {
    paused: (d.prepare("SELECT value FROM kv_config WHERE key='memory_maintenance_paused'").get() as {value:string}|undefined)?.value === 'true',
    jobs:d.prepare('SELECT status,COUNT(*) AS count FROM memory_jobs GROUP BY status').all(),
    jobsByKind:d.prepare('SELECT kind,status,COUNT(*) AS count FROM memory_jobs GROUP BY kind,status').all(),
    review:d.prepare("SELECT * FROM memory_relations WHERE active=1 AND (kind IN ('possible_conflict','similar','conflicts_with') OR (kind='supersedes' AND automatic=1)) ORDER BY created_at DESC LIMIT 50").all(),
    relationships:d.prepare('SELECT * FROM memory_relations WHERE active=1 ORDER BY created_at DESC LIMIT 50').all(),
    migrations:d.prepare('SELECT * FROM memory_migrations ORDER BY version').all(),
    capture:d.prepare('SELECT host,status,count(*) AS count FROM memory_capture_files GROUP BY host,status').all(),
    retrieval:retrievalMetrics(),
    typesafe:typesafeStats(),
  };
}
export function pauseMaintenance(paused: boolean) {
  getDb().prepare("INSERT INTO kv_config(key,value) VALUES('memory_maintenance_paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(paused));
}
export function feedback(id: string, value: string) {
  if (!['useful','irrelevant','incorrect'].includes(value)) throw new Error('Invalid feedback value.');
  if (!getDb().prepare('SELECT 1 FROM memories WHERE id=?').get(id)) throw new Error('Memory not found.');
  getDb().prepare('INSERT INTO memory_feedback VALUES(?,?,?,?)').run(randomUUID(),id,value,new Date().toISOString());
}

let running = false;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
/** One bounded job at a time. Claims expire after interruption; no request
 * transaction is held while waiting for local inference. */
export async function runMaintenanceBatch(embed = embedPassages) {
  if (running || maintenanceStatus().paused) return;
  running = true;
  const d = getDb();
  let job: Record<string, any> | undefined;
  try {
    d.exec('BEGIN IMMEDIATE');
    d.prepare("UPDATE memory_jobs SET status='pending' WHERE status='running' AND updated_at<?").run(new Date(Date.now()-300_000).toISOString());
    // `judge` jobs (the TypeSafe backfill) have their own runner with its own
    // pacing; this loop is for the interactive kinds only.
    job = d.prepare("SELECT * FROM memory_jobs WHERE status='pending' AND attempts<3 AND kind!='judge' ORDER BY CASE WHEN kind='verify' THEN 0 ELSE 1 END,updated_at,id LIMIT 1").get();
    if (job) d.prepare("UPDATE memory_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?").run(new Date().toISOString(),job.id);
    d.exec('COMMIT');
    if (!job) return;
    if(job.kind==='verify') {
      await verifyMemorySources(d,job.entity_id);
      d.prepare("UPDATE memory_jobs SET status='complete',updated_at=? WHERE id=?").run(new Date().toISOString(),job.id);
      return;
    }
    if (job.kind === 'session') {
      const row = d.prepare('SELECT content FROM session_chunks WHERE id=?').get(job.entity_id);
      if (!row) {d.prepare('DELETE FROM memory_jobs WHERE id=?').run(job.id);return;}
      const parts = await embed(String(row.content));
      if (maintenanceStatus().paused) {d.prepare("UPDATE memory_jobs SET status='pending' WHERE id=?").run(job.id);return;}
      // Mean of all normalized passage vectors covers long session events;
      // full text remains indexed and retrievable without truncation.
      const vector = new Float32Array(parts[0]?.vector.length || 384);
      for (const part of parts) part.vector.forEach((v,i)=>{vector[i]+=v;});
      const norm=Math.sqrt(vector.reduce((sum,v)=>sum+v*v,0));
      if(norm)vector.forEach((v,i)=>{vector[i]=v/norm;});
      d.exec('BEGIN IMMEDIATE');
      try {
        const current=d.prepare('SELECT content FROM session_chunks WHERE id=?').get(job.entity_id);
        if(current?.content===row.content) {
          d.prepare('UPDATE session_chunks SET vector=? WHERE id=?').run(new Uint8Array(vector.buffer),job.entity_id);
          d.prepare("UPDATE memory_jobs SET status='complete',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),job.id);
        } else d.prepare("UPDATE memory_jobs SET status='pending' WHERE id=?").run(job.id);
        d.exec('COMMIT');
      } catch(error){d.exec('ROLLBACK');throw error;}
      return;
    }
    const row = d.prepare('SELECT * FROM memories WHERE id=?').get(job.entity_id);
    if (!row) { d.prepare('DELETE FROM memory_jobs WHERE id=?').run(job.id); return; }
    const content = String(row.content);
    const hash = contentHash(content);
    const revision = memoryRevision(String(row.id));
    // Legacy short embeddings already cover their complete input. Long records
    // get exact source passages; jobs remain retryable if the local model is absent.
    const chunks = await embed(content);
    // Judgments run here, outside the write transaction, for the same reason
    // embedding does: a round trip must never hold the SQLite write lock. The
    // revision recheck below discards anything judged against stale content.
    const sourceRef = (d.prepare('SELECT source_ref FROM memory_metadata WHERE memory_id=?').get(String(row.id)) as {source_ref?:string}|undefined)?.source_ref;
    const judgeContext = { origin: 'maintenance' as const, entityId: String(row.id), project: String(row.project), sessionId: logSessionFromRef(sourceRef) };
    const judgment = row.trashed_at ? null : await judgeMemory(content,{category:String(row.category),project:String(row.project)},judgeContext);
    let candidates: RelationCandidate[] = [];
    let verdicts: Map<string, RelationJudgment> | null = null;
    if (!row.trashed_at && chunks[0]) {
      candidates = relationCandidates(d,row,chunks[0].vector);
      verdicts = await judgeRelations({content,recordedAt:String(row.created_at)},candidates,{...judgeContext,...relationJudgeOptions()});
    }
    if (maintenanceStatus().paused) { d.prepare("UPDATE memory_jobs SET status='pending' WHERE id=?").run(job.id); return; }
    d.exec('BEGIN IMMEDIATE');
    try {
      if (memoryRevision(String(row.id)) !== revision) {
        d.prepare("UPDATE memory_jobs SET status='pending' WHERE id=?").run(job.id);
        d.exec('COMMIT'); return;
      }
      d.prepare('DELETE FROM memory_passages WHERE memory_id=?').run(String(row.id));
      const insert = d.prepare('INSERT INTO memory_passages VALUES(?,?,?,?,?,?,?)');
      chunks.forEach((chunk,position)=>insert.run(`${row.id}:${position}`,String(row.id),hash,position,chunk.content,
        new Uint8Array(new Float32Array(chunk.vector).buffer),EMBEDDING_VERSION));
      // A document vector covers all its passages. Exact passage search can
      // then refine a bounded parent shortlist without scanning every passage.
      if(chunks.length) {
        const aggregate=new Float32Array(chunks[0].vector.length);
        for(const chunk of chunks)chunk.vector.forEach((v,i)=>{aggregate[i]+=v;});
        const norm=Math.sqrt(aggregate.reduce((sum,v)=>sum+v*v,0));
        if(norm)aggregate.forEach((v,i)=>{aggregate[i]=v/norm;});
        d.prepare('UPDATE memories SET vector=? WHERE id=?').run(new Uint8Array(aggregate.buffer),String(row.id));
      }
      applyJudgments(d,row,{hash,judgment,candidates,verdicts});
      d.prepare("UPDATE memory_jobs SET status='complete',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),job.id);
      d.exec('COMMIT');
    } catch (error) { d.exec('ROLLBACK'); memoryVectors.invalidate(); throw error; }
  } catch (error) {
    if (job) d.prepare("UPDATE memory_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error=?,updated_at=? WHERE id=?")
      .run((error as Error).message,new Date().toISOString(),job.id);
    else throw error;
  } finally { running = false; }
}
export interface RelationCandidate { id: string; content: string; score: number; recordedAt: string }

/**
 * The nearest live neighbours in the same project and category, as the
 * relation judgment wants them. created_at travels with the text: without it
 * a judgment reads two dated logs of the same recurring job as a
 * contradiction rather than as two separate occurrences.
 */
export function relationCandidates(d: DatabaseSync, row: Record<string, unknown>, vector: number[] | Float32Array, k = 3): RelationCandidate[] {
  const ids=new Set(d.prepare('SELECT id FROM memories WHERE project=? AND category=? AND id!=? AND trashed_at IS NULL')
    .all(String(row.project),String(row.category),String(row.id)).map(r=>String(r.id)));
  if (!ids.size) return [];
  return memoryVectors.topK(vector,k,RELATION_CANDIDATE_THRESHOLD,ids).map(hit=>{
    const peer=d.prepare('SELECT content,created_at FROM memories WHERE id=?').get(hit.id) as {content?:string;created_at?:string}|undefined;
    return {id:hit.id,score:hit.score,content:String(peer?.content ?? ''),recordedAt:String(peer?.created_at ?? '')};
  }).filter(c=>c.content);
}

/** The pre-TypeSafe kind rule: it reads the category label, not the memory. Kept as the fallback and for the bench. */
export function heuristicKind(category: string): string {
  return /communication|preference/.test(category) ? 'preference' : /bug|issue/.test(category) ? 'issue' : /architecture|decision|plan/.test(category) ? 'decision' : 'note';
}

export interface AppliedJudgments {
  relations: { similar: number; possible_conflict: number; duplicate_of: number; supersedes: number };
  disagreement: { kind: boolean; importance: boolean };
  appliedImportance: boolean;
}

/**
 * Write what a judgment decided about one memory: the judged columns, the
 * exact-hash duplicate, and the relations to its candidates. Synchronous and
 * transaction-agnostic on purpose — the caller holds BEGIN IMMEDIATE and has
 * already re-checked the revision, and nothing in here awaits. Shared by the
 * `index` job (fresh embedding) and the `judge` backfill job (stored vector).
 */
export function applyJudgments(
  d: DatabaseSync,
  row: Record<string, any>,
  input: { hash: string; judgment: MemoryJudgment | null; candidates: RelationCandidate[]; verdicts: Map<string, RelationJudgment> | null },
): AppliedJudgments {
  const { hash, judgment, candidates, verdicts } = input;
  const content = String(row.content);
  const result: AppliedJudgments = { relations: { similar: 0, possible_conflict: 0, duplicate_of: 0, supersedes: 0 }, disagreement: { kind: false, importance: false }, appliedImportance: false };
  const relate = (from: string, to: string, kind: 'similar' | 'possible_conflict' | 'duplicate_of') => { setRelation(from,to,kind,true); result.relations[kind]++; };
  // The regex reads the category label; the judgment reads the memory. Fall
  // back whenever the judgment is missing or unsure, so an outage degrades
  // to the old answer instead of to 'note'.
  const fallbackKind=heuristicKind(String(row.category));
  const kindFloor=surfaceConfig('importance-kind').minConfidence ?? 0.6;
  const kind=judgment?.kind && judgment.kindConfidence>=kindFloor ? judgment.kind : fallbackKind;
  result.disagreement.kind = Boolean(judgment?.kind) && judgment!.kind !== fallbackKind;
  result.disagreement.importance = judgment?.importance != null && Math.abs(judgment.importance - Number(row.importance)) >= 2;
  // importance_judged is recorded beside the caller's importance. It is
  // applied only behind the explicit, bench-gated setting below — agreement
  // has to be measured on real data before anything trusts the model over
  // the writer.
  d.prepare(`INSERT INTO memory_metadata(memory_id,content_hash,project,category,kind,importance_judged,importance_confidence,kind_judged,kind_confidence,judged_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(memory_id) DO UPDATE SET content_hash=excluded.content_hash,project=excluded.project,category=excluded.category,
      kind=CASE WHEN excluded.kind_judged IS NOT NULL THEN excluded.kind ELSE memory_metadata.kind END,
      importance_judged=COALESCE(excluded.importance_judged,memory_metadata.importance_judged),
      importance_confidence=COALESCE(excluded.importance_confidence,memory_metadata.importance_confidence),
      kind_judged=COALESCE(excluded.kind_judged,memory_metadata.kind_judged),
      kind_confidence=COALESCE(excluded.kind_confidence,memory_metadata.kind_confidence),
      judged_at=COALESCE(excluded.judged_at,memory_metadata.judged_at)`)
    .run(String(row.id),hash,String(row.project),String(row.category),kind,
      judgment?.importance ?? null,judgment?.importance!=null ? judgment.importanceConfidence : null,
      judgment?.kind ?? null,judgment?.kind ? judgment.kindConfidence : null,
      judgment ? new Date().toISOString() : null);
  const cfg = typesafeConfig();
  if (cfg.applyJudgedImportance && cfg.benchRunAt && judgment?.importance != null && judgment.importanceConfidence >= cfg.applyMinConfidence && !row.trashed_at) {
    const next = Math.max(1, Math.min(10, Math.round(judgment.importance)));
    if (next !== Number(row.importance)) {
      d.prepare('UPDATE memories SET importance=? WHERE id=?').run(next, String(row.id));
      result.appliedImportance = true;
    }
  }
  // Exact grouping never crosses source/category/project boundaries. A
  // recheck in SQL prevents stale hashes from grouping freshly edited rows.
  // CROSS JOIN starts from the content_hash index instead of every memory
  // sharing this source.
  const duplicate = d.prepare(`SELECT m.id,m.created_at FROM memory_metadata md CROSS JOIN memories m ON m.id=md.memory_id
    WHERE md.content_hash=? AND m.project=? AND m.category=? AND m.source=? AND m.content=? AND m.tags=? AND m.id!=? AND m.trashed_at IS NULL
    ORDER BY m.created_at,m.id LIMIT 1`).get(hash,String(row.project),String(row.category),String(row.source),content,String(row.tags),String(row.id));
  if (duplicate && !row.trashed_at) relate(String(row.id),String(duplicate.id),'duplicate_of');
  if (!duplicate && !row.trashed_at) {
    const supersession=surfaceConfig('supersession');
    const supersedeFloor=supersession.minProbability ?? 0.9;
    let superseded=false;
    for(const candidate of candidates) {
      // Candidates were read before the transaction; a row trashed or
      // edited since then must not pick up a relation from stale text.
      const peer=d.prepare('SELECT content,source,created_at FROM memories WHERE id=? AND trashed_at IS NULL').get(candidate.id) as {content?:string;source?:string;created_at?:string}|undefined;
      if(!peer || String(peer.content)!==candidate.content)continue;
      if(verdicts) {
        const verdict=verdicts.get(candidate.id);
        if(!verdict?.relation)continue;
        // Supersession: at most one per job, never beside a duplicate, only
        // between differently dated records (the newer one supersedes), and
        // never a user-told record replaced by one that was not. A newer
        // statement of the same thing is not a conflict, so the pair is
        // related as similar instead.
        const ownAt=String(row.created_at ?? ''), peerAt=String(peer.created_at ?? '');
        const newer=ownAt>peerAt ? {id:String(row.id),source:String(row.source)} : {id:candidate.id,source:String(peer.source)};
        const older=ownAt>peerAt ? {id:candidate.id,source:String(peer.source)} : {id:String(row.id),source:String(row.source)};
        if(!superseded && supersession.enabled && verdict.relation!=='duplicate_of' && verdict.supersedes!==null && verdict.supersedes>=supersedeFloor
          && ownAt && peerAt && ownAt!==peerAt && !(older.source==='user-told' && newer.source!=='user-told')) {
          try {
            const written=setRelation(newer.id,older.id,'supersedes',true) as {active?:number}|undefined;
            // An earlier undo (active=0) is respected by setRelation and stays undone.
            if(written?.active===1){superseded=true;result.relations.supersedes++;}
          } catch { /* a cycle or a vanished peer must not fail the whole index job */ }
          relate(String(row.id),candidate.id,verdict.relation==='possible_conflict' ? 'similar' : verdict.relation);
          continue;
        }
        relate(String(row.id),candidate.id,verdict.relation);
        continue;
      }
      // Fallback: the pre-TypeSafe rule, at its original cutoff.
      if(candidate.score<LEGACY_RELATION_THRESHOLD)continue;
      const negative=(s:string)=>/\b(not|never|cannot|no longer|não|nunca)\b/i.test(s);
      relate(String(row.id),candidate.id,negative(String(peer.content)) !== negative(content) ? 'possible_conflict' : 'similar');
    }
  }
  return result;
}

export function startMemoryMaintenance() {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(()=>{ runMaintenanceBatch().catch(error=>console.error('[memory maintenance]',error.message)); },2000);
  maintenanceTimer.unref();
}
export function stopMemoryMaintenance() { if (maintenanceTimer) clearInterval(maintenanceTimer); maintenanceTimer = null; }
