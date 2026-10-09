#!/usr/bin/env node

/**
 * Keep the external tools out of the application lockfiles.
 *
 *   node scripts/strip-external-tools.mjs           rewrite the lockfiles
 *   node scripts/strip-external-tools.mjs --check   say what is there; exit 1 when anything is
 *
 * Run it after any `npm install` that touched an agent SDK: npm resolves the
 * SDK again and puts the Claude Code and Codex packages it would carry back
 * into the lockfile. The list of what counts is lib/external-tools.js.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalToolsInLock, stripExternalToolsFromLock } from '../lib/external-tools.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APPLICATION_LOCKFILES = ['neural-interface/package-lock.json', 'mcp-server/package-lock.json'];

function main(argv) {
  const check = argv.includes('--check');
  let found = 0;
  for (const relative of APPLICATION_LOCKFILES) {
    const path = join(ROOT, relative);
    const text = readFileSync(path, 'utf8');
    const lock = JSON.parse(text);
    const { packages, edges } = check ? externalToolsInLock(lock) : stripExternalToolsFromLock(lock);
    found += packages.length + edges.length;
    for (const item of packages) console.log(`${relative}: ${check ? 'holds' : 'removed'} ${item.path}${item.version ? ` ${item.version}` : ''} (${item.tool})`);
    for (const edge of edges) console.log(`${relative}: ${check ? 'holds' : 'removed'} the ${edge.field} edge ${edge.from} -> ${edge.name} (${edge.tool})`);
    if (!check && packages.length + edges.length) {
      // As npm writes it: two spaces, the file's own line ending, one final newline.
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      writeFileSync(path, JSON.stringify(lock, null, 2).replace(/\n/g, eol) + eol);
    }
  }
  if (!found) console.log('The application lockfiles hold no external tool.');
  return check && found ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
