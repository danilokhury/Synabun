// ═══════════════════════════════════════════
// SynaBun — ruleset renderer
// ═══════════════════════════════════════════
//
// The rules SynaBun gives each AI tool are one core text plus a small per-host
// delta (templates/rulesets/). renderRuleset(host) is the only way anything
// gets that text: the installer, the setup API and the copy buttons all read
// it from here, so a host can never drift from the others.
//
// core.md syntax:
//   `<!-- host -->` on its own line  → replaced by the host's delta file
//   `… <!-- except: codex -->`       → the line is dropped for the named hosts

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise, sha12 } from './normalise.js';

export { normalise, sha12 };

export const RULESET_HOSTS = Object.freeze(['claude', 'codex', 'opencode', 'gemini', 'cursor']);
export const RULESETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'rulesets');

const HOST_SLOT = '<!-- host -->';
const EXCEPT_RE = /\s*<!-- except: ([a-z, ]+) -->\s*$/;

function readSource(dir, name) {
  return readFileSync(resolve(dir, name), 'utf8');
}

export function isRulesetHost(host) {
  return RULESET_HOSTS.includes(host);
}

/** {version, updatedAt, summary, hashes:{<host>: sha12}} */
export function readRulesetManifest({ dir = RULESETS_DIR } = {}) {
  const manifest = JSON.parse(readSource(dir, 'manifest.json'));
  if (!manifest || typeof manifest.version !== 'string') throw new Error('rulesets/manifest.json has no version');
  return manifest;
}

/** The rendered text alone, without the manifest (what the manifest hashes are computed from). */
export function renderRulesetText(host, { dir = RULESETS_DIR } = {}) {
  if (!isRulesetHost(host)) throw new Error(`Unknown ruleset host: ${host}`);
  const delta = normalise(readSource(dir, `${host}.md`));
  const out = [];
  for (const line of normalise(readSource(dir, 'core.md')).split('\n')) {
    if (line.trim() === HOST_SLOT) { out.push(delta); continue; }
    const except = line.match(EXCEPT_RE);
    if (except) {
      if (except[1].split(',').map((name) => name.trim()).includes(host)) continue;
      out.push(line.replace(EXCEPT_RE, ''));
      continue;
    }
    out.push(line);
  }
  const text = normalise(out.join('\n').replace(/\n{3,}/g, '\n\n'));
  // A directive that did not parse must never reach a user's instruction file.
  if (text.includes('<!--')) throw new Error(`rulesets/core.md has a directive the renderer does not know (host ${host})`);
  return text;
}

/** renderRuleset(host) → {host, text, version, hash} */
export function renderRuleset(host, { dir = RULESETS_DIR } = {}) {
  const text = renderRulesetText(host, { dir });
  return { host, text, version: readRulesetManifest({ dir }).version, hash: sha12(text) };
}

/** The copy-only coexistence snippet. Never installed anywhere. */
export function renderCoexistenceSnippet({ dir = RULESETS_DIR } = {}) {
  const text = normalise(readSource(dir, 'coexistence.md'));
  return { text, version: readRulesetManifest({ dir }).version, hash: sha12(text) };
}

/** [{sha, lines, firstLine, host}] — every ruleset text SynaBun served before 2.0.0. */
export function loadLegacyHashes({ dir = RULESETS_DIR } = {}) {
  try {
    const data = JSON.parse(readSource(dir, 'legacy-hashes.json'));
    const entries = Array.isArray(data) ? data : data?.entries;
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}
