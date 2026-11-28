// ═══════════════════════════════════════════
// SynaBun — a brain's read of a tool output its own CLI saved to a file
// ═══════════════════════════════════════════
//
// A CLI that cuts a long tool output short in the model's context saves the whole output to a file of its own and
// tells the model to read it there. The route gate lets that read through before a turn is routed: the file holds
// the output of a tool the model already ran, and an unrouted turn runs only the always-allowed ones (recall,
// agent_list, agent_read …). Exactly the CLI's own file counts, never a link to another one.
//
//   Claude Code   <projects>/<project>/<session>/tool-results/<name>.txt|json, beside <session>.jsonl, the
//                 transcript its hook input names (claudeSpilledResultRead, the Claude brain's PreToolUse gate hook)
//   Antigravity   <home>/antigravity-cli/brain/<conversation>/.system_generated/steps/<n>/output.txt
//                 (lib/antigravity/home.js antigravitySpilledOutputRead)

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const CLAUDE_RESULT_NAME = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}\\.(?:txt|json)';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether `file` lies under the CLI's own folder `anchor` at a path (relative to it) that `relRe` accepts, as a
 * regular file with one name (no hard link) and with no symbolic link anywhere between `anchor` and it: its real
 * path is that same relative path under the anchor's real path. Every folder level `relRe` names is checked that way,
 * so put the anchor above them (a linked folder at the anchor itself would vouch for itself).
 */
export function ownSpilledFile(file, anchor, relRe) {
  if (typeof file !== 'string' || !file || typeof anchor !== 'string' || !anchor) return false;
  const full = resolve(file);
  const rel = relative(resolve(anchor), full);
  if (!relRe.test(rel)) return false;
  try {
    if (realpathSync(full) !== join(realpathSync(anchor), rel)) return false;
    const stat = lstatSync(full);
    return stat.isFile() && stat.nlink === 1;
  } catch { return false; }
}

/**
 * A Claude Code PreToolUse hook input ({ tool_name, tool_input, transcript_path, session_id }) that only reads one
 * of the session's own saved tool results: Read with an absolute file_path in the tool-results folder of the
 * transcript the hook names.
 */
export function claudeSpilledResultRead(input) {
  if (String(input?.tool_name || '') !== 'Read') return false;
  const file = input?.tool_input?.file_path;
  const transcript = input?.transcript_path;
  if (typeof file !== 'string' || !isAbsolute(file) || typeof transcript !== 'string' || !isAbsolute(transcript) || !transcript.endsWith('.jsonl')) return false;
  const session = basename(transcript, '.jsonl');
  if (!SESSION_ID_RE.test(session) || (input.session_id && String(input.session_id) !== session)) return false;
  // Anchored at the transcript's folder: the session folder and tool-results must be real folders too.
  return ownSpilledFile(file, dirname(transcript), new RegExp(`^${session}[\\\\/]tool-results[\\\\/]${CLAUDE_RESULT_NAME}$`));
}
