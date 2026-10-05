import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';

// A developer's exported TYPESAFE_API_KEY must never make this suite hit the
// paid API: retrieval and the hook routes both judge when a key resolves.
process.env.SYNABUN_TYPESAFE = 'off';

test('memory HTTP compatibility, revision controls and incremental local capture',async(t)=>{
  const dir=mkdtempSync(join(tmpdir(),'synabun-api-'));
  process.env.SQLITE_DB_PATH=join(dir,'memory.db');
  process.env.MEMORY_DATA_DIR=dir;
  process.env.SYNABUN_DATA_HOME=dir;
  const storage=await import('../../mcp-server/dist/services/sqlite.js');
  const {closeEmbeddings}=await import('../../mcp-server/dist/services/local-embeddings.js');
  const {createMemoryApi,filterInjected,isReferentialFollowup}=await import('../lib/memory-api.js');
  const {retrieveMemory}=await import('../../mcp-server/dist/services/memory-retrieval.js');
  const vector=new Array(384).fill(0);vector[0]=1;
  const {pauseMaintenance}=await import('../../mcp-server/dist/services/memory-maintenance.js');
  const {queueMemoryCapture,captureMemoryFileBatch}=await import('../lib/memory-session-capture.js');
  const app=express();app.use(express.json());app.use('/api',createMemoryApi({retrieve:opts=>retrieveMemory(opts,async()=>vector)}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await closeEmbeddings();await new Promise(resolve=>server.close(resolve));storage.closeDatabase();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const id='00000000-0000-4000-8000-000000000001';
  storage.upsertMemory(id,vector,{content:'SQLite needle_MCP_42',category:'test',project:'api',tags:[],importance:5,source:'user-told',created_at:'2026-09-06',updated_at:'2026-09-06',accessed_at:'2026-09-06',access_count:0});
  const r=await post('/api/search',{query:'needle_MCP_42',project:'api'});
  assert.equal(r.status,200);assert.equal(r.body.results[0].id,id);assert.equal(r.body.results[0].payload.content,'SQLite needle_MCP_42');
  assert.equal((await post('/api/search',{query:{malformed:true}})).status,400);
  const hook=await post('/api/hook-recall',{query:'needle_MCP_42',project:'api',caller:'hook',session:'one',context_generation:'a'});
  assert.ok(hook.body.context.includes(id));
  assert.equal((await post('/api/hook-recall',{query:'needle_MCP_42',project:'api',caller:'hook',session:'one',context_generation:'a'})).body.results.length,0);
  assert.equal((await post('/api/hook-recall',{query:'needle_MCP_42',project:'api',caller:'hook',session:'one',context_generation:'b'})).body.results.length,1);
  assert.equal(filterInjected([{id:'x',revision:1}],{}).length,1);
  const repeated=await post('/api/hook-recall',{query:'needle_MCP_42',project:'api',caller:'hook',session:'one',context_generation:'a'});
  assert.equal(repeated.body.context,'');assert.equal(repeated.body.already_present,true);
  assert.equal(isReferentialFollowup('FOr coding, is there a better setting for that?>'),true);
  assert.equal(isReferentialFollowup('Is that ERR_CACHE42 setting better?'),false);
  assert.equal((await post('/api/hook-recall',{query:'FOr coding, is there a better setting for that?>'})).body.skipped,'referential-followup');
  const history=await(await fetch(`${base}/api/memory/${id}/history`)).json();assert.equal(history.revision,1);
  storage.updatePayload(id,{content:'new content'});
  assert.equal((await post(`/api/memory/${id}/undo`,{revision:1,expected_revision:1})).status,409);
  assert.equal((await post(`/api/memory/${id}/undo`,{revision:1,expected_revision:2})).status,200);
  const transcript=join(dir,'transcript.jsonl');
  writeFileSync(transcript,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'first local event'}]}})+'\n');
  queueMemoryCapture({host:'codex',sessionId:'local',filePath:transcript,project:'api'});pauseMaintenance(false);
  await captureMemoryFileBatch();
  assert.equal(storage.getDb().prepare('SELECT count(*) AS n FROM session_chunks').get().n,1);
  appendFileSync(transcript,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'second local event'}]}})+'\n');
  queueMemoryCapture({host:'codex',sessionId:'local',filePath:transcript,project:'api'});await captureMemoryFileBatch();
  assert.equal(storage.getDb().prepare('SELECT count(*) AS n FROM session_chunks').get().n,2);
  queueMemoryCapture({host:'codex',sessionId:'local',filePath:transcript,project:'api'});await captureMemoryFileBatch();
  assert.equal(storage.getDb().prepare('SELECT count(*) AS n FROM session_chunks').get().n,2);
  // The legacy Claude indexing endpoint now uses the same idempotent intake.
  const {startIndexing}=await import('../lib/session-indexer.js');
  const projects=join(dir,'projects');mkdirSync(join(projects,'api'),{recursive:true});
  writeFileSync(join(projects,'api','claude-session.jsonl'),[
    {type:'user',uuid:'u1',sessionId:'claude-session',message:{content:'remember the stable original'}},
    {type:'assistant',uuid:'a1',sessionId:'claude-session',message:{content:[{type:'text',text:'visible assistant response'}]}},
  ].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const indexed=await startIndexing({projectsDir:projects,reindex:true});
  assert.equal(indexed.errors,0);assert.equal(indexed.totalChunks,2);
  await startIndexing({projectsDir:projects,reindex:true});
  assert.equal(storage.getDb().prepare("SELECT count(*) AS n FROM session_chunks WHERE session_id='claude-code:claude-session'").get().n,2);
});

test('typesafe settings: key persistence, knobs, backfill rails, bench gate and log', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-typesafe-api-'));
  process.env.SQLITE_DB_PATH = join(dir, 'memory.db');
  process.env.MEMORY_DATA_DIR = dir;
  process.env.SYNABUN_DATA_HOME = dir;
  process.env.SYNABUN_TYPESAFE = 'off';
  process.env.DOTENV_PATH = join(dir, '.env');
  const shellKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const storage = await import('../../mcp-server/dist/services/sqlite.js');
  const { closeEmbeddings } = await import('../../mcp-server/dist/services/local-embeddings.js');
  const { createMemoryApi } = await import('../lib/memory-api.js');
  const { retrieveMemory } = await import('../../mcp-server/dist/services/memory-retrieval.js');
  const { typesafeStats, resetTypeSafeKey, resetTypeSafeMetrics } = await import('../../mcp-server/dist/services/typesafe.js');
  const { invalidateTypeSafeConfig } = await import('../../mcp-server/dist/services/typesafe-config.js');
  resetTypeSafeKey(); resetTypeSafeMetrics(); invalidateTypeSafeConfig();
  const vector = new Array(384).fill(0); vector[0] = 1;
  const envPath = join(dir, '.env');
  const parseEnvFile = (p) => { try { return Object.fromEntries(readFileSync(p, 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })); } catch { return {}; } };
  const writeEnvFile = (p, vars) => writeFileSync(p, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  writeEnvFile(envPath, { OTHER: 'kept' });
  const app = express(); app.use(express.json());
  const invalidations = [];
  app.use('/api', createMemoryApi({ retrieve: opts => retrieveMemory(opts, async () => vector), invalidate: (memoryId, type) => invalidations.push([memoryId, type]), envPath, parseEnvFile, writeEnvFile, benchDir: join(dir, 'benchmarks') }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await closeEmbeddings(); await new Promise(resolve => server.close(resolve)); storage.closeDatabase();
    delete process.env.DOTENV_PATH; if (shellKey) process.env.TYPESAFE_API_KEY = shellKey; else delete process.env.TYPESAFE_API_KEY; resetTypeSafeKey();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  // Defaults, with the kill switch on and no key anywhere.
  let r = await call('GET', '/api/typesafe/config');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.enabled, r.body.killSwitch, r.body.masterEnabled, r.body.hasKey, r.body.keySource, r.body.shadowed], [true, false, true, true, false, 'none', false]);
  const { SURFACES } = await import('../../mcp-server/dist/services/typesafe-config.js');
  assert.deepEqual(Object.keys(r.body.surfaces), [...SURFACES]);
  assert.equal(r.body.surfaces.relations.timeoutMs, 8000);
  assert.equal(r.body.surfaces.relations.label, 'Relations');
  assert.equal(r.body.model, 'jev-latest');
  assert.equal(r.body.backfill.status, 'idle');
  // Coding-session additions: log-based stats, origins, the supersession count,
  // rider and budget metadata, and the limit knobs.
  assert.ok(r.body.logStats && r.body.logStats.totals && r.body.logStats.surfaces);
  assert.ok(r.body.origins.includes('hook') && r.body.origins.includes('live'));
  assert.ok(r.body.origins.includes('assistant'), 'the Assistant logs under its own origin');
  assert.deepEqual(r.body.supersessions, { active: 0 });
  assert.equal(r.body.surfaces['task-boundary'].ridesWith, 'prompt-urgency');
  assert.equal(r.body.surfaces.rerank.minScore, 1.5);
  assert.equal(r.body.surfaces['edit-stale'].debounceMs, 15000);
  let c = await call('GET', '/api/typesafe/sessions');
  assert.deepEqual(c.body, { ok: true, rows: [] });
  c = await call('GET', '/api/typesafe/supersessions');
  assert.deepEqual(c.body, { ok: true, rows: [], total: 0 });
  c = await call('POST', '/api/typesafe/supersessions/nope', { action: 'undo' });
  assert.equal(c.status, 400);
  c = await call('GET', '/api/typesafe/log?session=s1&order=asc&project=p');
  assert.deepEqual(c.body.rows, []);
  // The kill switch holds for every new hook route.
  c = await call('POST', '/api/hook-edit', { session_id: 's1', cwd: dir, file_path: join(dir, 'a.ts'), tool: 'Edit' });
  assert.deepEqual(c.body, { ok: true, scheduled: false, reason: 'judgments-off' });
  c = await call('GET', '/api/hook-edit/pending?session_id=s1&peek=1');
  assert.deepEqual(c.body, { stale: [] });
  for (const kind of ['prompt', 'stop-turn', 'compact-digest', 'plan-conflict']) {
    c = await call('POST', '/api/hook-judge', { kind, text: 'x', session_id: 's1', messages: [{ i: 0, role: 'user', text: 'x' }] });
    assert.deepEqual(c.body, {}, kind);
  }
  assert.deepEqual(r.body.coverage, { judged: 0, total: 0 });

  // Saving a key writes .env (read-modify-write) and process.env, then resets the cache.
  r = await call('PUT', '/api/typesafe/config', { apiKey: 'sk-test-abcdefghij1234' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.hasKey, r.body.maskedKey, r.body.keySource, r.body.shadowed, r.body.enabled], [true, '***1234', 'dotenv', false, false]);
  assert.match(readFileSync(envPath, 'utf8'), /OTHER=kept/);
  assert.match(readFileSync(envPath, 'utf8'), /TYPESAFE_API_KEY=sk-test-abcdefghij1234/);
  assert.equal(process.env.TYPESAFE_API_KEY, 'sk-test-abcdefghij1234');
  // A shell export that differs shadows the saved key.
  process.env.TYPESAFE_API_KEY = 'sk-other-zzzzzzzzzz9999';
  r = await call('GET', '/api/typesafe/config');
  assert.deepEqual([r.body.keySource, r.body.shadowed, r.body.maskedKey], ['env', true, '***9999']);
  // The mask sent back leaves everything untouched; '' removes the key from both places.
  r = await call('PUT', '/api/typesafe/config', { apiKey: '***1234' });
  assert.match(readFileSync(envPath, 'utf8'), /sk-test-abcdefghij1234/);
  r = await call('PUT', '/api/typesafe/config', { apiKey: '' });
  assert.deepEqual([r.body.hasKey, r.body.keySource], [false, 'none']);
  assert.doesNotMatch(readFileSync(envPath, 'utf8'), /TYPESAFE_API_KEY/);
  assert.equal(process.env.TYPESAFE_API_KEY, undefined);
  assert.equal((await call('PUT', '/api/typesafe/config', { apiKey: 'bad key!' })).status, 400);

  // Knobs: validation, per-surface merge, and the bench gate on applying importance.
  r = await call('PUT', '/api/typesafe/config', { applyJudgedImportance: true });
  assert.equal(r.status, 400); assert.match(r.body.error, /bench/);
  assert.equal((await call('PUT', '/api/typesafe/config', { surfaces: { nope: { enabled: true } } })).status, 400);
  r = await call('PUT', '/api/typesafe/config', { surfaces: { relations: { enabled: false, timeoutMs: 2500 } }, costPerMillionInput: 0.05, enabled: false });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.surfaces.relations.enabled, r.body.surfaces.relations.timeoutMs, r.body.surfaces.rerank.enabled, r.body.costPerMillionInput, r.body.masterEnabled], [false, 2500, true, 0.05, false]);
  r = await call('PUT', '/api/typesafe/config', { enabled: true });
  assert.equal(r.body.masterEnabled, true);

  // Browser assistance: locked by default; enabling is judged against the stored config plus this request.
  const gateModule = await import('../../mcp-server/dist/services/browser-assist-gate.js');
  const { mutateTypeSafeConfig } = await import('../../mcp-server/dist/services/typesafe-config.js');
  const browserFixtures = join(dir, 'browser-fixtures');
  mkdirSync(browserFixtures, { recursive: true });
  writeFileSync(join(browserFixtures, 'target.json'), JSON.stringify({ schema: 1, suite: 'target', cases: [] }));
  process.env.SYNABUN_BROWSER_FIXTURES_DIR = browserFixtures; gateModule.resetFixtureCorpusMemo();
  r = await call('GET', '/api/typesafe/config');
  assert.deepEqual([r.body.browserAssist.autoHealEnabled, r.body.browserAssist.targetBench, r.body.browserAssist.eligible, r.body.browserAssist.mode], [false, null, false, 'shadow']);
  assert.deepEqual([r.body.surfaces['browser-page-state'].minProbability, r.body.surfaces['browser-target'].minProbability, r.body.surfaces['browser-social'].minProbability], [0.8, 0.9, undefined]);
  assert.equal(r.body.browserAssist.counters.autoHealAttempted, 0);
  r = await call('PUT', '/api/typesafe/config', { browserAssist: { autoHealEnabled: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /stays locked: No browser-target benchmark/);
  r = await call('PUT', '/api/typesafe/config', { browserAssist: { targetBench: { at: 'x', model: 'jev-1.13.0', basis: 'y', passed: true } } });
  assert.equal(r.status, 400); assert.match(r.body.error, /written by the browser benchmark/);
  // Pin the model and record a pass for exactly the basis the view reports; then the toggle is accepted.
  r = await call('PUT', '/api/typesafe/config', { model: 'jev-1.13.0' });
  assert.equal(r.body.browserAssist.modelPinned, true);
  mutateTypeSafeConfig(() => ({ browserAssist: { targetBench: { at: '2026-09-19T00:00:00.000Z', model: 'jev-1.13.0', basis: r.body.browserAssist.basis, passed: true, reportFile: null } } }));
  r = await call('PUT', '/api/typesafe/config', { surfaces: { 'browser-target': { minConfidence: 0.5 } }, browserAssist: { autoHealEnabled: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /confidence 0\.85 → 0\.5/);
  r = await call('PUT', '/api/typesafe/config', { browserAssist: { autoHealEnabled: true } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.browserAssist.mode, r.body.browserAssist.eligible, r.body.browserAssist.autoHealEnabled], ['auto-heal', true, true]);
  // A later threshold change keeps the toggle and the recorded pass, and drops the mode to shadow.
  r = await call('PUT', '/api/typesafe/config', { surfaces: { 'browser-target': { minConfidence: 0.5 } } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.browserAssist.mode, r.body.browserAssist.autoHealEnabled, r.body.browserAssist.targetBench.passed], ['shadow', true, true]);
  assert.match(r.body.browserAssist.reasons[0], /confidence 0\.85 → 0\.5/);
  r = await call('PUT', '/api/typesafe/config', { browserAssist: { autoHealEnabled: false }, surfaces: { 'browser-target': { minConfidence: 0.85 } }, model: 'jev-latest' });
  assert.deepEqual([r.status, r.body.browserAssist.autoHealEnabled, r.body.model], [200, false, 'jev-latest']);
  delete process.env.SYNABUN_BROWSER_FIXTURES_DIR; gateModule.resetFixtureCorpusMemo();

  // Desktop assistance: the same lock on its own record, judged the same way.
  const desktopGate = await import('../../mcp-server/dist/services/desktop-assist-gate.js');
  const desktopFixtures = join(dir, 'desktop-fixtures');
  mkdirSync(desktopFixtures, { recursive: true });
  writeFileSync(join(desktopFixtures, 'target.json'), JSON.stringify({ schema: 1, suite: 'desktop-target', cases: [] }));
  process.env.SYNABUN_DESKTOP_FIXTURES_DIR = desktopFixtures; gateModule.resetFixtureCorpusMemo();
  r = await call('GET', '/api/typesafe/config');
  assert.deepEqual([r.body.desktopAssist.pressEnabled, r.body.desktopAssist.targetBench, r.body.desktopAssist.eligible, r.body.desktopAssist.mode], [false, null, false, 'advisory']);
  assert.deepEqual([r.body.desktopAssist.definition.version, r.body.desktopAssist.riskRules.version, r.body.desktopAssist.desktopRules.version], ['dj1', 'rk1', 'dk1']);
  assert.match(r.body.desktopAssist.basis, /^jev-latest\|dj1:[0-9a-f]{12}\|rk1:[0-9a-f]{12}\|dk1:[0-9a-f]{12}\|conf0\.85\|prob0\.9\|t1200\|fx:[0-9a-f]{12}$/);
  assert.deepEqual([r.body.surfaces['desktop-target'].minConfidence, r.body.surfaces['desktop-target'].minProbability, r.body.surfaces['desktop-target'].timeoutMs], [0.85, 0.9, 1200]);
  assert.equal(r.body.desktopAssist.counters.pressAttempted, 0);
  r = await call('PUT', '/api/typesafe/config', { desktopAssist: { pressEnabled: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Press by intent stays locked: No desktop-target benchmark/);
  r = await call('PUT', '/api/typesafe/config', { desktopAssist: { targetBench: { at: 'x', model: 'jev-1.13.0', basis: 'y', passed: true } } });
  assert.equal(r.status, 400); assert.match(r.body.error, /written by the desktop benchmark/);
  r = await call('PUT', '/api/typesafe/config', { desktopAssist: { press: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Unknown desktopAssist field: press/);
  // Pin the model and record a pass for exactly the basis the view reports; one PUT cannot lower a threshold and enable together.
  r = await call('PUT', '/api/typesafe/config', { model: 'jev-1.13.0' });
  assert.equal(r.body.desktopAssist.modelPinned, true);
  mutateTypeSafeConfig(() => ({ desktopAssist: { targetBench: { at: '2026-09-23T00:00:00.000Z', model: 'jev-1.13.0', basis: r.body.desktopAssist.basis, passed: true, reportFile: null } } }));
  r = await call('PUT', '/api/typesafe/config', { surfaces: { 'desktop-target': { minProbability: 0.5 } }, desktopAssist: { pressEnabled: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /probability 0\.9 → 0\.5/);
  r = await call('PUT', '/api/typesafe/config', { desktopAssist: { pressEnabled: true } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.desktopAssist.mode, r.body.desktopAssist.eligible, r.body.desktopAssist.pressEnabled], ['press', true, true]);
  // A later threshold change keeps the toggle and the recorded pass, and drops the mode to advisory; off is always accepted.
  r = await call('PUT', '/api/typesafe/config', { surfaces: { 'desktop-target': { minConfidence: 0.5 } } });
  assert.deepEqual([r.status, r.body.desktopAssist.mode, r.body.desktopAssist.pressEnabled, r.body.desktopAssist.targetBench.passed], [200, 'advisory', true, true]);
  assert.match(r.body.desktopAssist.reasons[0], /confidence 0\.85 → 0\.5/);
  r = await call('PUT', '/api/typesafe/config', { desktopAssist: { pressEnabled: false }, surfaces: { 'desktop-target': { minConfidence: 0.85 } }, model: 'jev-latest' });
  assert.deepEqual([r.status, r.body.desktopAssist.pressEnabled, r.body.desktopAssist.mode, r.body.model], [200, false, 'advisory', 'jev-latest']);
  delete process.env.SYNABUN_DESKTOP_FIXTURES_DIR; gateModule.resetFixtureCorpusMemo();

  // Backfill rails: estimate never calls out; start needs confirm and a working key.
  const id = '00000000-0000-4000-8000-000000000002';
  storage.upsertMemory(id, vector, { content: 'a memory that was never judged', category: 'test', project: 'api', tags: [], importance: 5, source: 'user-told', created_at: '2026-09-06', updated_at: '2026-09-06', accessed_at: '2026-09-06', access_count: 0 });
  r = await call('POST', '/api/typesafe/backfill', { action: 'estimate' });
  assert.equal(r.status, 200);
  assert.equal(r.body.backfill.estimate.rows, 1);
  assert.equal(typeof r.body.backfill.estimate.costUsd, 'number');
  assert.equal(r.body.backfill.status, 'idle');
  r = await call('POST', '/api/typesafe/backfill', { action: 'start' });
  assert.equal(r.status, 400); assert.match(r.body.error, /confirm/);
  r = await call('POST', '/api/typesafe/backfill', { action: 'start', confirm: true });
  assert.equal(r.status, 400); assert.match(r.body.error, /not enabled/);
  assert.equal((await call('POST', '/api/typesafe/backfill', { action: 'nope' })).status, 400);
  r = await call('GET', '/api/typesafe/backfill/status');
  assert.deepEqual([r.body.ok, r.body.backfill.status, r.body.backfill.coverage.total], [true, 'idle', 1]);
  r = await call('GET', '/api/memory-maintenance');
  assert.equal(r.body.backfill.status, 'idle');

  // Connection test and bench refuse cleanly while judgments are off.
  r = await call('POST', '/api/typesafe/test');
  assert.equal(r.body.ok, false); assert.match(r.body.reason, /kill switch/);
  r = await call('POST', '/api/typesafe/bench', { surface: 'importance', limit: 5 });
  assert.equal(r.status, 400); assert.match(r.body.error, /not enabled/);
  assert.equal((await call('POST', '/api/typesafe/bench', { surface: 'nope' })).status, 400);
  // The browser bench is a surface here too, and refuses the same way while judgments are off.
  r = await call('POST', '/api/typesafe/bench', { surface: 'browser' });
  assert.equal(r.status, 400); assert.match(r.body.error, /not enabled/);
  assert.match((await call('POST', '/api/typesafe/bench', { surface: 'nope' })).body.error, /historical, browser/);
  // So is the desktop bench.
  r = await call('POST', '/api/typesafe/bench', { surface: 'desktop' });
  assert.equal(r.status, 400); assert.match(r.body.error, /not enabled/);
  assert.match((await call('POST', '/api/typesafe/bench', { surface: 'nope' })).body.error, /browser, desktop\.$/);

  // Log, cache and metrics endpoints.
  r = await call('GET', '/api/typesafe/log?limit=10');
  assert.deepEqual(r.body, { ok: true, rows: [], total: 0 });
  assert.equal((await call('POST', '/api/typesafe/cache/clear')).body.stats.cacheSize, 0);
  gateModule.countBrowserAssist('pageAssessments', 3);
  assert.equal((await call('GET', '/api/typesafe/config')).body.browserAssist.counters.pageAssessments, 3);
  assert.equal((await call('POST', '/api/typesafe/metrics/reset')).body.stats.calls, 0);
  assert.equal((await call('GET', '/api/typesafe/config')).body.browserAssist.counters.pageAssessments, 0);
  desktopGate.countDesktopAssist('intentSnapshots', 2);
  assert.equal((await call('GET', '/api/typesafe/config')).body.desktopAssist.counters.intentSnapshots, 2);
  await call('POST', '/api/typesafe/metrics/reset');
  assert.equal((await call('GET', '/api/typesafe/config')).body.desktopAssist.counters.intentSnapshots, 0);

  // Category checks: a recorded disagreement can be applied or dismissed.
  storage.getDb().prepare("INSERT INTO memory_metadata(memory_id,kind,category,category_judged,category_confidence) VALUES(?,'note','test','better-category',0.81)").run(id);
  r = await call('GET', '/api/typesafe/category-checks');
  assert.equal(r.body.total, 1); assert.equal(r.body.rows[0].category_judged, 'better-category');
  assert.equal((await call('POST', `/api/typesafe/category-checks/${id}`, { action: 'nope' })).status, 400);
  r = await call('POST', `/api/typesafe/category-checks/${id}`, { action: 'apply' });
  assert.equal(r.status, 200);
  assert.equal(storage.getDb().prepare('SELECT category FROM memories WHERE id=?').get(id).category, 'better-category');
  assert.equal((await call('GET', '/api/typesafe/category-checks')).body.total, 0);

  // Trash triage: the JSON and NDJSON answers agree (judgments are off, so fallback order),
  // and "Move to trash" announces memory:trashed so the Trash panel refreshes.
  const staleIds = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
  for (const [i, staleId] of staleIds.entries()) storage.upsertMemory(staleId, vector, { content: `an old passing note ${i}`, category: 'test', project: 'api', tags: [], importance: 2, source: 'self-discovered', created_at: `2025-01-0${i + 1}`, updated_at: `2025-01-0${i + 1}`, accessed_at: `2025-01-0${i + 1}`, access_count: 0 });
  r = await call('GET', '/api/trash/candidates?limit=5');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.judged, r.body.pending, r.body.saved, r.body.candidates], [true, false, 0, 0, 2]);
  assert.deepEqual(r.body.rows.map(row => row.id), staleIds);
  const streamed = await fetch(`${base}/api/trash/candidates?limit=5&stream=1`);
  assert.match(streamed.headers.get('content-type'), /application\/x-ndjson/);
  const lines = (await streamed.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual([lines.length, lines[0].ok, lines[0].done], [1, true, true]);
  assert.deepEqual(lines[0].rows.map(row => row.id), staleIds);
  r = await call('POST', `/api/trash/candidates/${staleIds[0]}/trash`);
  assert.equal(r.status, 200);
  assert.deepEqual(invalidations.at(-1), [staleIds[0], 'memory:trashed']);
  assert.deepEqual((await call('GET', '/api/trash/candidates?limit=5')).body.rows.map(row => row.id), [staleIds[1]]);

  // Bulk trash: one call for many ids; unknown and already-trashed ids are skipped, not errors.
  const bulkIds = ['00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000023'];
  for (const [i, bulkId] of bulkIds.entries()) storage.upsertMemory(bulkId, vector, { content: `a bulk candidate ${i}`, category: 'test', project: 'api', tags: [], importance: 2, source: 'self-discovered', created_at: '2025-02-01', updated_at: '2025-02-01', accessed_at: '2025-02-01', access_count: 0 });
  assert.equal((await call('POST', '/api/trash/candidates/trash-selected', { ids: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/trash/candidates/trash-selected', { ids: new Array(501).fill(bulkIds[0]) })).status, 400);
  invalidations.length = 0;
  r = await call('POST', '/api/trash/candidates/trash-selected', { ids: [...bulkIds, staleIds[0], 'not-a-memory'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.trashed, 3);
  assert.deepEqual(r.body.skipped, [staleIds[0], 'not-a-memory']);
  assert.deepEqual(invalidations, bulkIds.map(id => [id, 'memory:trashed']));
  assert.deepEqual((await call('GET', '/api/trash/candidates?limit=50')).body.rows.map(row => row.id), [staleIds[1]]);

  // Nothing above went out over the network.
  assert.equal(typesafeStats().calls, 0);
  assert.equal(existsSync(join(dir, 'benchmarks')), false);
});
