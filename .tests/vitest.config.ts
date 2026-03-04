import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./setup.ts'],
    include: ['unit/**/*.test.ts', 'scenarios/**/*.test.ts', 'hooks/**/*.test.ts', 'integration/**/*.test.ts'],
    reporters: ['verbose'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@mcp': path.resolve(__dirname, '../mcp-server/src'),
    },
  },
});
