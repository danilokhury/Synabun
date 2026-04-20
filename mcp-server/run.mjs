import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

// Ensure MCP server uses the shared mcp-data/ directory (same as Neural Interface)
if (!process.env.MEMORY_DATA_DIR) {
  process.env.MEMORY_DATA_DIR = resolve(__dirname, '..', 'mcp-data');
}

const entry = pathToFileURL(resolve(__dirname, 'dist', 'preload.js')).href;
await import(entry);
