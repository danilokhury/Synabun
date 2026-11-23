// What a finished run's scratch folder is still needed for.
//
// A run's records name its folder all the time: the run view carries `scratchDir`, every status answer the brain
// reads is saved in its transcript, and the worker's own commands and tool output are full of the path. None of that
// means a file is still used. What is used after a run ends is what SynaBun shows as its output: the result (summary,
// changes, files, media, follow-ups, question), the message text, a review, a follow-up, a schedule or a team record
// that names a file. So:
//   - a reference is a path to something INSIDE a run's folder; the folder itself is only a mention;
//   - tool calls, tool results, reasoning and launch metadata are never read as references;
//   - a reference is matched against the names really on disk, so a path with spaces or followed by prose is exact.
// No file access here: the caller hands in `list` and `realpath`.

import { isAbsolute, resolve } from 'node:path';
import { parseFileLinkTarget } from '../public/shared/file-links.js';

export const RUN_ID = /^[a-f0-9]{32}$/;
export const MAX_REFS_PER_RUN = 4096;
const MAX_TAIL = 1024;
const MAX_DEPTH = 128;
const REFERENCE = /(?:^|[^\w])scratch\/+([a-f0-9]{32})(?![a-f0-9])/gi;
export const HAS_SCRATCH = /scratch/i;
const INSIDE_SCRATCH = /(?:^|\/)scratch\/+[a-f0-9]{32}(?:\/|$)/i;
// What can follow a name in prose or Markdown. A dot counts only at the end of a sentence.
const BOUNDARY = /^(?:$|[\s"'`)\]}>,;:!?#|*]|\.(?:$|[\s"'`)\]}>,;:!?#|*]))/;
const EMPHASIS = /^\*+(?:[\s),;:]|\.(?:\s|$)|$)/;
const GLOB = /^[^\s/]*(?:\*|\[[^\]\s]*\]|\{[^}\s]*\})/;

// Blocks and events that record what a tool did, not what the run reported.
const TOOL_TYPES = new Set([
  'tool_use', 'tool_result', 'server_tool_use', 'mcp_tool_use', 'mcp_tool_result', 'thinking', 'redacted_thinking',
  'stream_event', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'reasoning',
  'tool_call', 'tool_call_update', 'synabun.permission_request', 'synabun.permission_resolved', 'synabun.confinement',
]);
// Launch metadata, permission requests and tool input. `original` is where a media file was copied from: the page
// serves the copy in data/media.
const SKIPPED_KEYS = new Set([
  'scratchDir', 'sandboxPlan', 'resumeInfo', 'notes', 'extraEnv', 'tools', 'toolsRequested', 'tool_use_result', 'input',
  'arguments', 'rawInput', 'rawOutput', 'request', 'pending', 'usage', 'usageState', 'tokens', 'image', 'images', 'original',
]);
// What a run was asked to do: it can name another run's file, and never makes its own folder worth keeping.
const INPUT_KEYS = new Set(['task', 'context', 'brief', 'rawSpec', 'teamBrief', 'team', 'promptPreview']);

// A run, a schedule or a session working IN a folder needs all of it, whatever its state.
const WORKDIR_KEYS = new Set(['cwd', 'project', 'projectPath', 'workingDirectory', 'workdir', 'worktree']);
const SCRATCH_RUN = /(?:^|[\\/])scratch[\\/]+([a-f0-9]{32})(?:[\\/]|$)/i;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** The run whose scratch folder holds this path, else null. */
export function scratchRunOf(path) {
  return SCRATCH_RUN.exec(String(path ?? ''))?.[1].toLowerCase() ?? null;
}

/** How this platform compares names: macOS and Windows folders are normally case-insensitive. */
export function foldFor(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32'
    ? (text) => text.normalize('NFC').toLowerCase()
    : (text) => text.normalize('NFC');
}

function spellings(text) {
  const slashed = text.includes('\\') ? text.replace(/\\+/g, '/') : text;
  if (!slashed.includes('%')) return [slashed];
  const decoded = slashed.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  return decoded === slashed ? [slashed] : [slashed, decoded];
}

function linkTargets(text) {
  const out = [];
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]{1,2048})/g)) out.push(match[1]);
  for (const match of text.matchAll(/`([^`\n]{1,1024})`/g)) out.push(match[1].trim());
  return out;
}

/** The references one source holds, by the run whose folder they point into. */
export function createReferenceIndex() {
  const byRun = new Map();
  const overflow = new Set();
  const workdirs = new Set();

  function add(run, tail) {
    let tails = byRun.get(run);
    if (!tails) byRun.set(run, tails = new Set());
    if (tails.has(tail)) return;
    if (tails.size >= MAX_REFS_PER_RUN) { overflow.add(run); return; }
    tails.add(tail);
  }

  function addText(value, { except = null, cwd = null } = {}) {
    if (typeof value !== 'string' || (!HAS_SCRATCH.test(value) && !cwd)) return;
    for (const text of spellings(value)) {
      for (const match of text.matchAll(REFERENCE)) {
        const run = match[1].toLowerCase();
        if (run === except) continue;
        const from = match.index + match[0].length;
        if (text[from] !== '/') continue; // the folder itself
        const line = text.slice(from, from + MAX_TAIL).split(/[\r\n]/, 1)[0].replace(/^\/+/, '');
        if (!line || /^\s/.test(line)) continue; // the folder, then prose
        add(run, line);
      }
    }
    if (!cwd) return;
    // A run rooted in its scratch folder writes relative links, which the page resolves against that folder.
    for (const target of linkTargets(value)) {
      for (const path of parseFileLinkTarget(target, { cwd })?.candidates || []) addText(path, { except });
    }
  }

  function addPath(value, { cwd = null, realpath = null, except = null } = {}) {
    if (typeof value !== 'string' || !value.trim()) return;
    const written = value.trim();
    const path = !isAbsolute(written) && cwd ? resolve(cwd, written) : written;
    addText(path, { except });
    if (!realpath || !isAbsolute(path)) return;
    const real = realpath(path); // a project file can be a link into scratch
    if (real && real !== path) addText(real, { except });
  }

  /** Every string a person can be shown in this value, without tool calls, tool output or launch metadata. */
  function addVisible(value, options = {}) {
    const stack = [[value, 0]];
    while (stack.length) {
      const [item, depth] = stack.pop();
      if (typeof item === 'string') { addText(item, options); continue; }
      if (!item || typeof item !== 'object' || depth > MAX_DEPTH) continue;
      if (Array.isArray(item)) { for (const child of item) stack.push([child, depth + 1]); continue; }
      if (typeof item.type === 'string' && TOOL_TYPES.has(item.type)) continue;
      for (const [key, child] of Object.entries(item)) {
        if (!SKIPPED_KEYS.has(key)) stack.push([child, depth + 1]);
      }
    }
  }

  /** Folders used as a working directory by anything in this value (`except`: a run in its own folder). */
  function addWorkdirs(value, { except = null, realpath = null } = {}) {
    const stack = [[value, 0]];
    while (stack.length) {
      const [item, depth] = stack.pop();
      if (!item || typeof item !== 'object' || depth > MAX_DEPTH) continue;
      if (Array.isArray(item)) { for (const child of item) stack.push([child, depth + 1]); continue; }
      for (const [key, child] of Object.entries(item)) {
        if (typeof child !== 'string') { stack.push([child, depth + 1]); continue; }
        if (!WORKDIR_KEYS.has(key)) continue;
        for (const path of [child, realpath && isAbsolute(child) ? realpath(child) : null]) {
          const run = path ? scratchRunOf(path) : null;
          if (run && run !== except) workdirs.add(run);
        }
      }
    }
  }

  return { byRun, overflow, workdirs, add, addText, addPath, addVisible, addWorkdirs };
}

function collectResult(index, result, where) {
  if (typeof result === 'string') { index.addText(result, { cwd: where.scratchCwd }); return; }
  if (!isObject(result)) return;
  const paths = { cwd: where.cwd, realpath: where.realpath };
  for (const [key, value] of Object.entries(result)) {
    if (SKIPPED_KEYS.has(key)) continue;
    if ((key === 'files' || key === 'media' || key === 'changes') && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') index.addPath(item, paths);
        else if (isObject(item)) {
          index.addPath(item.path, paths);
          index.addVisible({ ...item, path: undefined }, { cwd: where.scratchCwd });
        }
      }
    } else index.addVisible(value, { cwd: where.scratchCwd });
  }
}

/** A row of the dispatch registry, the native ledger or a loop state file. */
export function collectRunRecord(index, row, { realpath = null } = {}) {
  if (!isObject(row)) return;
  const run = typeof row.runId === 'string' ? row.runId.toLowerCase() : null;
  const cwd = typeof row.cwd === 'string' && isAbsolute(row.cwd) ? row.cwd : null;
  const scratchCwd = cwd && INSIDE_SCRATCH.test(cwd.replace(/\\/g, '/')) ? cwd : null;
  const where = { cwd, scratchCwd, realpath };
  index.addWorkdirs(row, { except: run, realpath });
  for (const [key, value] of Object.entries(row)) {
    if (SKIPPED_KEYS.has(key) || key === 'cwd' || key === 'project') continue;
    if (INPUT_KEYS.has(key)) index.addVisible(value, { except: run });
    else if (key === 'lastResult') collectResult(index, value, where);
    else if (key === 'turns' && Array.isArray(value)) {
      for (const turn of value) {
        if (!isObject(turn)) continue;
        index.addText(turn.promptPreview, { except: run });
        index.addText(turn.text, { cwd: scratchCwd });
        collectResult(index, turn.result, where);
      }
    } else if (key === 'media' && Array.isArray(value)) {
      for (const item of value) if (isObject(item)) index.addPath(item.path, { cwd, realpath });
    } else index.addVisible(value, { cwd: scratchCwd });
  }
}

/** One line of an Assistant transcript: what its page draws as the conversation. */
export function collectTranscriptEntry(index, entry) {
  index.addVisible(isObject(entry) && entry.packet !== undefined ? entry.packet : entry);
}

function longestEntry(entries, rest, fold) {
  let best = null;
  for (const entry of entries) {
    const name = fold(entry.name);
    if (!name || !rest.startsWith(name) || (best && name.length <= best.length)) continue;
    const after = rest.slice(name.length);
    if (after.startsWith('/') || BOUNDARY.test(after)) best = { entry, length: name.length };
  }
  return best;
}

/**
 * The real entry a reference names.
 * @param {string} tail the text after `scratch/<run>/`
 * @param {(rel: string) => Array<{ name: string, directory: boolean }>|null} list a folder of the run, by relative path
 * @returns {{ rel: string, directory: boolean, dangling?: boolean } | { ambiguous: true } | null} null: nothing in the
 *   folder is named. A path that goes missing below a real folder keeps that folder.
 */
export function resolveReference(tail, list, fold = foldFor()) {
  let rest = fold(String(tail)).replace(/^\/+/, '');
  let rel = '';
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    while (rest.startsWith('./')) rest = rest.slice(2).replace(/^\/+/, '');
    if (!rest) return rel ? { rel, directory: true } : null;
    if (rest === '..' || rest.startsWith('../')) return { ambiguous: true };
    const found = longestEntry(list(rel) || [], rest, fold);
    if (found) {
      const child = rel ? `${rel}/${found.entry.name}` : found.entry.name;
      const after = rest.slice(found.length);
      if (!found.entry.directory || !after.startsWith('/')) return { rel: child, directory: !!found.entry.directory };
      rel = child;
      rest = after.replace(/^\/+/, '');
      continue;
    }
    if (EMPHASIS.test(rest)) return rel ? { rel, directory: true } : null;
    if (GLOB.test(rest)) return { ambiguous: true };
    if (BOUNDARY.test(rest)) return rel ? { rel, directory: true } : null;
    return rel ? { rel, directory: true, dangling: true } : null;
  }
  return { ambiguous: true };
}

/** The relative paths to keep. `ambiguous`: a reference (a glob, a `..`) that cannot be tied to entries. */
export function resolveKeepSet(tails, list, fold = foldFor()) {
  const keep = new Set();
  const listed = new Map();
  const cached = (rel) => {
    if (!listed.has(rel)) listed.set(rel, list(rel));
    return listed.get(rel);
  };
  for (const tail of tails) {
    const hit = resolveReference(tail, cached, fold);
    if (!hit) continue;
    if (hit.ambiguous) return { keep: new Set(), ambiguous: true };
    keep.add(hit.rel);
  }
  return { keep, ambiguous: false };
}

/** Every folder above a kept entry: it stays so the entry keeps its path. */
export function ancestorsOf(keep) {
  const out = new Set();
  for (const rel of keep) {
    const parts = rel.split('/');
    for (let n = 1; n < parts.length; n += 1) out.add(parts.slice(0, n).join('/'));
  }
  return out;
}

/** Is this relative path a kept entry or inside one? */
export function isCovered(keep, rel) {
  const parts = rel.split('/');
  for (let n = 1; n <= parts.length; n += 1) if (keep.has(parts.slice(0, n).join('/'))) return true;
  return false;
}
