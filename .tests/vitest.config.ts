import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./setup.ts'],
    include: ['unit/**/*.test.ts', 'scenarios/**/*.test.ts'],
    reporters: ['verbose'],
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@mcp': path.resolve(__dirname, '../mcp-server/src'),
    },
  },
});
