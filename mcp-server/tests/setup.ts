// Never let a test that imports a schema touch the user's live memory store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
const data = mkdtempSync(join(tmpdir(), 'synabun-test-'));
process.env.MEMORY_DATA_DIR = data;
process.env.SQLITE_DB_PATH = join(data, 'memory.db');
process.env.SYNABUN_DATA_HOME = data;
process.env.NEURAL_INTERFACE_URL = 'http://127.0.0.1:1';
delete process.env.SYNABUN_RUNTIME_PROFILE_PATH;
afterAll(() => { rmSync(data, { recursive: true, force: true }); });
