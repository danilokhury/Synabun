import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataHome } from '../lib/paths.js';
import { applyPackagedChildPath } from '../lib/packaged-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

// Ensure MCP server uses the platform-owned data home (same as Neural Interface).
const dataHome = getDataHome();
if (!process.env.SYNABUN_DATA_HOME) {
  process.env.SYNABUN_DATA_HOME = dataHome;
}
if (!process.env.MEMORY_DATA_DIR) {
  process.env.MEMORY_DATA_DIR = resolve(dataHome, 'mcp-data');
}

// In a packaged application (`<entry> mcp`), what this server starts inherits
// its PATH: the user's own first, npm's global bin, the bundled runtime last
// (lib/packaged-runtime.js). Nothing changes for an npm or Git install.
applyPackagedChildPath();

const entry = pathToFileURL(resolve(__dirname, 'dist', 'preload.js')).href;
await import(entry);
