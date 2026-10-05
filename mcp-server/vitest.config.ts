import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // setupFiles MUST stay listed here. tests/setup.ts redirects
    // SQLITE_DB_PATH / MEMORY_DATA_DIR at a temp directory, and several suites
    // (memory-v2.test.ts in particular) open with `DELETE FROM memories`.
    // A config that omits this points those deletes at ~/.synabun/mcp-data/memory.db.
    setupFiles: ['tests/setup.ts'],
    env: {
      // The suite must never reach the TypeSafe API. Developers have
      // TYPESAFE_API_KEY exported in their shell and vitest inherits the
      // environment, so without this the maintenance tests would quietly make
      // paid network calls and stop being reproducible. Tests that exercise the
      // client delete this and stub `fetch` instead.
      SYNABUN_TYPESAFE: 'off',
    },
  },
});
