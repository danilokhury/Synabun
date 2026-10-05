import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_VERSION = `${EMBEDDING_MODEL}:384:mean:normalized:passage-v2`;
type Passage = { content: string; vector: number[] };
type Task = { id: number; op: string; text: string; background: boolean; resolve: (v: any) => void; reject: (e: Error) => void };
let worker: ChildProcess | null = null;
let nextId = 0;
let active: Task | null = null;
const queue: Task[] = [];
const cache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[]>>();
let timer: ReturnType<typeof setTimeout> | null = null;

function fail(error: Error) {
  if (timer) clearTimeout(timer);
  timer = null;
  active?.reject(error);
  active = null;
  for (const task of queue.splice(0)) task.reject(error);
  const previous = worker;
  worker = null;
  previous?.kill('SIGKILL');
}

function pump() {
  if (active || !queue.length) return;
  if (!worker) {
    // A stateless local child contains native ONNX crashes and its macOS
    // destructor bug. No database or memory content is written by this child.
    const current = fork(fileURLToPath(new URL('./embedding-worker.js', import.meta.url)), {
      execArgv: [], stdio: ['ignore','ignore','pipe','ipc'],
    });
    current.stderr?.on('data',()=>{}); // drain native diagnostics; request errors travel over IPC
    worker = current;
    current.on('message', (reply: any) => {
      if (worker !== current || reply.id !== active?.id) return;
      if (timer) clearTimeout(timer);
      timer = null;
      const task = active!;
      active = null;
      if (reply.error) task.reject(new Error(reply.error)); else task.resolve(reply.value);
      current.unref(); current.channel?.unref();
      pump();
    });
    current.on('error', (error) => { if (worker === current) fail(error); });
    current.on('exit', (code) => { if (worker === current) fail(new Error(`Embedding worker exited (${code})`)); });
  }
  const interactive = queue.findIndex(t => !t.background);
  active = queue.splice(interactive < 0 ? 0 : interactive, 1)[0];
  worker.ref(); worker.channel?.ref();
  timer = setTimeout(() => fail(new Error('Local embedding deadline exceeded')), 30_000);
  worker.send({ id: active.id, op: active.op, text: active.text },error=>{if(error)fail(error);});
}

function request(op: string, text = '', background = false): Promise<any> {
  if (queue.length >= 64) return Promise.reject(new Error('Local embedding queue is full'));
  return new Promise((resolve, reject) => { queue.push({ id: ++nextId, op, text, background, resolve, reject }); pump(); });
}

export async function generateEmbedding(text: string, background = false): Promise<number[]> {
  const key = createHash('sha256').update(EMBEDDING_VERSION).update(text).digest('hex');
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return [...hit]; }
  let pending = inflight.get(key);
  if (!pending) {
    pending = request('embed', text, background).then((v: number[]) => {
      cache.set(key, v);
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
      return v;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, pending);
  }
  return [...await pending];
}

export async function generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  const result: number[][] = [];
  for (const text of texts) result.push(await generateEmbedding(text, true));
  return result;
}

export async function embedPassages(text: string): Promise<Passage[]> {
  const parts: string[] = await request('split', text, true);
  const result: Passage[] = [];
  for (const content of parts) result.push({ content, vector: await generateEmbedding(content, true) });
  return result;
}

export async function warmupEmbeddings(): Promise<void> { await request('warmup'); }
/** Explicit installation step: downloads model assets only, never memory text. */
export async function installEmbeddingModel(): Promise<void> { await request('install'); }
export async function closeEmbeddings(): Promise<void> {
  cache.clear();
  if(active || queue.length) {fail(new Error('Embedding service closed'));return;}
  const closing=worker;
  if(!closing)return;
  worker=null;
  closing.ref(); closing.channel?.ref();
  await new Promise<void>(resolve=>{
    closing.once('exit',()=>resolve());
    closing.kill('SIGKILL');
    if(closing.exitCode !== null || closing.signalCode !== null)resolve();
  });
}
