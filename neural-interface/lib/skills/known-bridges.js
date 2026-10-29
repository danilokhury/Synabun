// ── The bridge files earlier SynaBun versions wrote ──
// Before native skill folders, SynaBun wrote a Codex prompt and an OpenCode command for each bundled skill
// (server.js buildCliSkillPrompt, lib/skill-prompt-bridge.js). The text of a bridge is a function of the skill's
// SKILL.md as that version shipped it, of the generator of that version, and of the folder the bundled skill was
// in (each bridge names it). The migration (lib/skills/migration.js) moves a bridge by itself only on exact bytes:
// today's generation (`generated-current`), the ledger's record, or (this file) the bytes an earlier version wrote
// for that runtime and skill (`generated-previous`).
//
// known-bridge-digests.json is that list, reviewed and shipped: for each runtime and skill name, the SHA-256 of
// every bridge text an earlier generator wrote from an earlier SKILL.md, in a path-neutral form (the bundled skill
// folder replaced by BRIDGE_DIR_PLACEHOLDER), because the folder is the install's own. It is computed by replaying
// every historical generator over every SKILL.md it shipped with in git history:
// scripts/skills/compute-bridge-digests.mjs (`--write` rewrites it, `--check` says whether it is current).
//
// Why a match is exact, never fuzzy: a file F matches when sha256(F with every occurrence of this install's skill
// folder D replaced by the placeholder P) is a listed digest of T = G(P), the generator's text with P as the folder.
// The replacement is undone exactly (F holds no NUL, so no P, and P holds no part of D), so F = T with P replaced
// by D, which is G(D) byte for byte: the generator only ever puts the folder in as a whole string, and a folder with
// a `$` (which String.replace would read as a pattern) is refused. Only D, this install's folder, is tried: a
// bridge that points at another folder (an old checkout, a moved install) is not proven and stays an offer. Codex's
// pointer names D/SKILL.md with the platform's separator, so its digests are listed per separator.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sep as hostSep } from 'node:path';

/** What stands for the bundled skill folder in a path-neutral bridge text (NUL never occurs in a bridge). */
export const BRIDGE_DIR_PLACEHOLDER = '\u0000SYNABUN_SKILL_DIR\u0000';
export const KNOWN_BRIDGES_SCHEMA = 1;
export const KNOWN_BRIDGES_FILE = new URL('./known-bridge-digests.json', import.meta.url);

const RUNTIMES = new Set(['codex', 'opencode']);
const SEPS = new Set(['any', '/', '\\']);
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** A bridge text in its path-neutral form: every occurrence of the skill folder replaced by the placeholder. */
export function neutralBridgeText(text, skillDir) {
  return String(text).split(String(skillDir)).join(BRIDGE_DIR_PLACEHOLDER);
}

/** The digest a path-neutral bridge text is listed under (hex SHA-256 of its UTF-8 bytes). */
export function bridgeTemplateDigest(neutralText) {
  return createHash('sha256').update(String(neutralText), 'utf8').digest('hex');
}

/**
 * The list as a lookup: `${runtime}\n${name}` → its entries. A missing, unreadable or malformed file is an empty
 * list (nothing is proven by it), never an exception: the migration then only moves what it proved otherwise.
 * @param {object|string|URL} [source] the parsed list, or its file (default: the shipped one)
 */
export function readKnownBridges(source = KNOWN_BRIDGES_FILE) {
  const out = new Map();
  let doc = source;
  try {
    if (typeof source === 'string' || source instanceof URL) doc = JSON.parse(readFileSync(source, 'utf8'));
  } catch { return out; }
  if (!doc || typeof doc !== 'object' || doc.schemaVersion !== KNOWN_BRIDGES_SCHEMA || doc.placeholder !== BRIDGE_DIR_PLACEHOLDER) return out;
  const bridges = doc.bridges && typeof doc.bridges === 'object' ? doc.bridges : {};
  for (const [runtime, skills] of Object.entries(bridges)) {
    if (!RUNTIMES.has(runtime) || !skills || typeof skills !== 'object') continue;
    for (const [name, entries] of Object.entries(skills)) {
      if (!Array.isArray(entries)) continue;
      const ok = entries.filter((e) => e && typeof e === 'object' && DIGEST_RE.test(String(e.digest)) && SEPS.has(e.sep));
      if (ok.length) out.set(`${runtime}\n${name}`, ok);
    }
  }
  return out;
}

let shipped = null;
/** The shipped list, read once per process (it changes only with a new SynaBun version, which is a restart). */
export function knownBridges() {
  if (!shipped) shipped = readKnownBridges();
  return shipped;
}

/**
 * Whether `bytes` are exactly a bridge an earlier SynaBun version wrote for `runtime` and skill `name` from the
 * bundled skill folder `skillDir`. Returns the list's entry (`{ digest, sep, firstCommit, firstDate, … }`) or null.
 * @param {Buffer|Uint8Array} bytes the file as it is on disk
 * @param {{ runtime: string, name: string, skillDir: string, sep?: string, known?: Map<string, object[]> }} o
 */
export function matchPreviousBridge(bytes, { runtime, name, skillDir, sep = hostSep, known = knownBridges() } = {}) {
  if (!RUNTIMES.has(runtime) || typeof name !== 'string' || !name) return null;
  if (typeof skillDir !== 'string' || !skillDir || /[\u0000\r\n$]/.test(skillDir)) return null;
  const entries = known.get(`${runtime}\n${name}`);
  if (!entries) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const text = buf.toString('utf8');
  // Bytes that are not UTF-8 (they would not read back the same) or hold a NUL are no text SynaBun wrote.
  if (!Buffer.from(text, 'utf8').equals(buf) || text.includes('\u0000')) return null;
  // Every bridge SynaBun wrote names its skill folder.
  if (!text.includes(skillDir)) return null;
  const digest = bridgeTemplateDigest(neutralBridgeText(text, skillDir));
  return entries.find((e) => e.digest === digest && (e.sep === 'any' || e.sep === sep)) || null;
}
