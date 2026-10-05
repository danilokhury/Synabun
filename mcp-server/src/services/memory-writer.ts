import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, upsertMemory, memoryVectors } from './sqlite.js';
import { generateEmbedding } from './local-embeddings.js';
import { invalidateCache } from './neural-interface.js';
import { projectAliases } from '../config.js';
import { judgeDuplicates, type JudgeContext } from './memory-judgments.js';
import { surfaceConfig } from './typesafe-config.js';
import type { MemoryPayload } from '../types.js';

export class IdempotencyConflict extends Error {}

export interface WriteMemoryOptions {
  idempotencyKey?: string;
  kind?: string;
  sourceRef?: string | null;
  // Hooks can adopt a verified pre-upgrade receipt without creating a new row.
  existingId?: string;
  /** The id a new row gets, chosen by the caller so its judgments can be logged against it. */
  id?: string;
  /** Attribution for the duplicate-gate judgment. */
  judge?: JudgeContext;
}

export interface WriteMemoryResult {
  id: string;
  existing: boolean;
  pending: boolean;
  /** Set when the duplicate gate refused the write: `id` is the memory it duplicates. */
  duplicate?: { probability: number };
}

/** Cosine floor for "worth asking": generous, because the judgment decides. */
const DUPLICATE_CANDIDATE_THRESHOLD = 0.9;

/**
 * Before insert, ask whether the new memory restates a fact already stored
 * in the same project. Judged before any transaction; a null judgment means
 * "store it" — maintenance still relates duplicates after the fact.
 */
async function duplicateGate(d: DatabaseSync, vector: number[], payload: MemoryPayload, context: JudgeContext = {}): Promise<{ id: string; probability: number } | null> {
  const settings = surfaceConfig('duplicate-gate');
  if (!settings.enabled) return null;
  const aliases = projectAliases(payload.project).map(p => p.toLowerCase());
  const ids = new Set(d.prepare(`SELECT id FROM memories WHERE trashed_at IS NULL AND lower(project) IN (${aliases.map(() => '?').join(',')})`).all(...aliases).map(r => String(r.id)));
  if (!ids.size) return null;
  const hits = memoryVectors.topK(vector, 3, DUPLICATE_CANDIDATE_THRESHOLD, ids);
  if (!hits.length) return null;
  const candidates = hits.map(hit => {
    const row = d.prepare('SELECT content,created_at FROM memories WHERE id=? AND trashed_at IS NULL').get(hit.id) as { content?: string; created_at?: string } | undefined;
    return { id: hit.id, content: String(row?.content ?? ''), recordedAt: row?.created_at ? String(row.created_at) : undefined };
  }).filter(c => c.content);
  if (!candidates.length) return null;
  const verdicts = await judgeDuplicates(payload.content, candidates, context);
  if (!verdicts?.size) return null;
  let best: { id: string; probability: number } | null = null;
  for (const [id, probability] of verdicts) if (!best || probability > best.probability) best = { id, probability };
  return best && best.probability >= (settings.minConfidence ?? 0.85) ? best : null;
}

/** The receipt and new memory commit together, across MCP and hook processes. */
export async function writeMemory(payload: MemoryPayload, options: WriteMemoryOptions = {}): Promise<WriteMemoryResult> {
  const d = getDb();
  const hash = createHash('sha256').update(payload.content).digest('hex');
  const findRetry = () => options.idempotencyKey ? d.prepare(`
    SELECT m.id, md.request_hash FROM memory_metadata md JOIN memories m ON m.id=md.memory_id
    WHERE md.project=? AND md.category=? AND md.idempotency_key=?
  `).get(payload.project, payload.category, options.idempotencyKey) : undefined;
  const receipt = (row: Record<string, unknown>) => {
    if (row.request_hash !== hash) throw new IdempotencyConflict('Idempotency key already belongs to different content.');
    return { id: String(row.id), existing: true, pending: false };
  };
  const previous = findRetry();
  if (previous) return receipt(previous);

  // Check the old hook tracker inside the same transaction used by new writes.
  const adopt = () => {
    if (!options.existingId || !options.idempotencyKey) return undefined;
    const row = d.prepare(`SELECT m.id, md.idempotency_key FROM memories m
      LEFT JOIN memory_metadata md ON md.memory_id=m.id
      WHERE m.id=? AND m.project=? AND m.category=? AND m.content=? AND m.source=? AND m.trashed_at IS NULL`)
      .get(options.existingId, payload.project, payload.category, payload.content, payload.source);
    if (!row || (row.idempotency_key && row.idempotency_key !== options.idempotencyKey)) return undefined;
    d.prepare(`INSERT INTO memory_metadata(memory_id,kind,source_ref,content_hash,idempotency_key,project,category,request_hash)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET idempotency_key=excluded.idempotency_key,request_hash=excluded.request_hash`)
      .run(row.id, options.kind || 'note', options.sourceRef || null, hash, options.idempotencyKey, payload.project, payload.category, hash);
    return { id: String(row.id), existing: true, pending: false };
  };
  if (options.existingId) {
    d.exec('BEGIN IMMEDIATE');
    try {
      const found = findRetry();
      const adopted = found ? receipt(found) : adopt();
      d.exec('COMMIT');
      if (adopted) return adopted;
    } catch (error) { d.exec('ROLLBACK'); throw error; }
  }

  let pending = false;
  let vector: number[];
  try { vector = await generateEmbedding(payload.content); }
  catch { vector = new Array(384).fill(0); pending = true; }
  // The gate needs a real vector to find candidates; a pending embedding
  // means maintenance will judge relations once it exists.
  if (!pending) {
    const duplicate = await duplicateGate(d, vector, payload, options.judge);
    if (duplicate) return { id: duplicate.id, existing: true, pending: false, duplicate: { probability: duplicate.probability } };
  }
  const id = options.id ?? randomUUID();
  d.exec('BEGIN IMMEDIATE');
  try {
    const retry = findRetry();
    if (retry) {
      const result = receipt(retry);
      d.exec('COMMIT');
      return result;
    }
    upsertMemory(id, vector, payload);
    d.prepare('INSERT INTO memory_metadata(memory_id,kind,source_ref,content_hash,idempotency_key,project,category,request_hash) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, options.kind || 'note', options.sourceRef || null, hash, options.idempotencyKey || null, payload.project, payload.category, hash);
    d.exec('COMMIT');
  } catch (error) { d.exec('ROLLBACK'); memoryVectors.invalidate(); throw error; }
  invalidateCache('remember', id);
  return { id, existing: false, pending };
}
