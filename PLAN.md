# NPM Package: CWD Scaffold + Windows Uninstall Fix

## Overview

Two changes to the npm package behavior:
1. **Windows uninstall fix** — `preuninstall.js` cleans nested node_modules before npm's arborist chokes on deep paths
2. **CWD scaffold** — when `synabun` runs from a global install, it copies the full package into the user's current directory and runs from there (like create-react-app)

---

## Phase 1: Windows Uninstall Fix

### File: `preuninstall.js` (NEW)

Runs before `npm uninstall` via the `preuninstall` lifecycle script.

```js
// Remove nested node_modules that cause EPERM/deep-path errors on Windows
import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dirs = [
  resolve(__dirname, 'neural-interface', 'node_modules'),
  resolve(__dirname, 'mcp-server', 'node_modules'),
];

for (const dir of dirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
```

### File: `package.json` (MODIFY)

Add `preuninstall` script and add `preuninstall.js` to `files`:
```json
"scripts": {
  "start": "node setup.js",
  "postinstall": "node postinstall.js",
  "preuninstall": "node preuninstall.js"
}
```

---

## Phase 2: CWD Scaffold

### File: `setup.js` (MODIFY)

Add scaffold logic at the **top** of `main()`, before any existing checks.

#### 2a. Detection helpers

```js
import { cpSync } from 'node:fs'; // add to existing imports

function isGlobalInstall() {
  // __dirname is inside node_modules when installed via npm install -g
  const normalized = __dirname.replace(/\\/g, '/');
  return normalized.includes('/node_modules/synabun');
}

function isAlreadyScaffolded(dir) {
  return existsSync(resolve(dir, 'neural-interface', 'server.js'));
}

function getLocalVersion(dir) {
  try {
    return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

function getGlobalVersion() {
  return JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version;
}
```

#### 2b. Scaffold function

```js
function scaffoldToCwd(targetDir) {
  info('Scaffolding SynaBun into current directory...');

  cpSync(__dirname, targetDir, {
    recursive: true,
    filter: (src) => {
      // Skip node_modules (will be installed fresh by postinstall logic)
      if (src.includes('node_modules')) return false;
      // Skip .env (generated fresh per installation)
      if (src.endsWith('.env')) return false;
      return true;
    },
  });

  ok(`Scaffolded to ${targetDir}`);
}
```

#### 2c. Main flow (top of `main()`)

```js
function main() {
  // ── Global install: scaffold + delegate ──
  if (isGlobalInstall()) {
    const cwd = process.cwd();
    const globalVer = getGlobalVersion();

    if (!isAlreadyScaffolded(cwd)) {
      // First time — scaffold
      console.log('');
      console.log(`  Scaffolding SynaBun v${globalVer} into:`);
      console.log(`  ${c.cyan}${cwd}${c.reset}`);
      console.log('');
      scaffoldToCwd(cwd);
    } else {
      // Already scaffolded — check for version update
      const localVer = getLocalVersion(cwd);
      if (localVer !== globalVer) {
        console.log('');
        info(`Updating SynaBun: ${localVer} → ${globalVer}`);
        scaffoldToCwd(cwd);
        ok('Updated');
      }
    }

    // Delegate to local copy (so __dirname resolves to CWD)
    const child = spawn('node', [resolve(cwd, 'setup.js')], {
      cwd,
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    process.on('SIGINT', () => { child.kill('SIGINT'); });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); });
    return; // Local copy handles everything from here
  }

  // ── Local/dev install: existing flow unchanged ──
  // ... banner, checkNodeVersion, installDeps, buildMcpServer, startServer
}
```

#### Key behavior:
- **First `synabun` run**: Copies package to CWD → spawns local `setup.js` → installs deps → builds → launches
- **Subsequent runs**: Detects local copy → version match → spawns local `setup.js` directly (no re-copy)
- **After `npm install -g synabun@latest`**: Version mismatch detected → re-scaffolds (updates code) → launches
- **Development (cloned repo)**: `isGlobalInstall()` returns false → zero change to current behavior

---

## Files Touched

| File | Change |
|------|--------|
| `preuninstall.js` | **NEW** — removes nested node_modules before uninstall |
| `setup.js` | Add scaffold detection, copy, delegation, version check |
| `package.json` | Add `preuninstall` script, add `preuninstall.js` to `files` |

## Not Touched

- `postinstall.js` — runs inside the scaffolded directory as-is
- Path resolution in server.js, hooks, MCP — `__dirname` naturally resolves to CWD after scaffold + delegation
- `.env` handling — generated fresh by setup.js in the scaffolded directory
- No new npm dependencies — uses Node.js built-in `cpSync` (Node 16.7+)
