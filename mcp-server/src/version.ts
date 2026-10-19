import { readFileSync } from 'fs';

// The version the server reports (MCP initialize serverInfo, the TUI banner)
// is the one in mcp-server/package.json, never a literal. src/ and dist/ both
// sit one level under mcp-server/, so `../package.json` is that file in the
// checkout, under vitest, in the npm package and in the packaged desktop app
// (both ship mcp-server/package.json beside mcp-server/dist/).
const PACKAGE_URL = new URL('../package.json', import.meta.url);
const PACKAGE_NAME = 'claude-memory-mcp';

/** Reported when the package file is missing, unreadable or another package's. */
export const UNKNOWN_SERVER_VERSION = '0.0.0-unknown';

export function readServerVersion(packageUrl: URL = PACKAGE_URL): string {
  try {
    const pkg = JSON.parse(readFileSync(packageUrl, 'utf-8')) as { name?: unknown; version?: unknown };
    if (pkg?.name === PACKAGE_NAME && typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  } catch { /* missing or malformed: fall through */ }
  return UNKNOWN_SERVER_VERSION;
}

export const SERVER_VERSION = readServerVersion();
