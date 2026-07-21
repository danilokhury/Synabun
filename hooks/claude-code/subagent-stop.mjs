#!/usr/bin/env node

/**
 * SynaBun SubagentStop Hook for Claude Code
 *
 * Fires when a subagent (Task / AgentTool worker) finishes. Mirrors the main
 * session's Stop auto-remember obligation, but as a SOFT nudge: it injects
 * `additionalContext` asking the subagent to persist its findings via the
 * `remember` tool. Per the CC 2.1.177 spec, SubagentStop additionalContext is
 * "non-error feedback delivered to the subagent; the subagent continues so it
 * can act on it" — so the worker gets one more turn to call remember.
 *
 * Gated behind the `subagentRemember` hook feature (default off) so it's a
 * deliberate opt-in via the SynaBun settings UI. One nudge per subagent
 * (tracked by a marker file) to avoid SubagentStop → remember → SubagentStop
 * loops. Harmless for agents without memory tools — the nudge says to ignore
 * it when no remember tool is available or nothing substantive was produced.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, getHookFeatures, DATA_DIR } from './shared.mjs';

process.on('uncaughtException', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
process.on('unhandledRejection', () => { try { process.stdout.write('{}'); } catch {} process.exit(0); });

const MARKER_DIR = join(DATA_DIR, 'pending-subagent-remember');
const MARKER_TTL_MS = 24 * 60 * 60 * 1000; // stale-marker cleanup horizon

function sanitizeKey(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

// Opportunistically delete markers older than the TTL so the dir can't grow
// unbounded (one marker is written per nudged subagent and never re-cleared).
function cleanupStaleMarkers() {
  try {
    const now = Date.now();
    for (const name of readdirSync(MARKER_DIR)) {
      const p = join(MARKER_DIR, name);
      try { if (now - statSync(p).mtimeMs > MARKER_TTL_MS) unlinkSync(p); } catch { /* ok */ }
    }
  } catch { /* ok */ }
}

const NUDGE = [
  '=== SynaBun: Persist your findings ===',
  'Before you finish, if you produced findings worth keeping (a fix, a non-obvious',
  'discovery, an architecture decision, a reusable pattern), call the `remember`',
  'tool ONCE to store them: include what + why + how, set the project, 3-5 tags,',
  'and an importance (5=routine, 6-7=significant, 8+=critical).',
  'Skip this if you have no memory tool available, or did only trivial/read-only',
  'work with nothing substantive to save.',
  '=== End ===',
].join('\n');

async function main() {
  // Opt-in only.
  const features = getHookFeatures();
  if (features.subagentRemember !== true) { process.stdout.write('{}'); return; }

  let input = {};
  try { input = JSON.parse(await readStdin()); } catch { /* empty */ }

  if (process.env.SYNABUN_HOOK_DEBUG) {
    try { process.stderr.write(`[SubagentStop] ${JSON.stringify(input)}\n`); } catch { /* ok */ }
  }

  // One-shot per subagent: key by agent_id (fallback to session+agent_type).
  // The marker persists so a worker that stops repeatedly (e.g. stops again
  // right after acting on the nudge) is never re-nudged. Stale markers are
  // swept by TTL so the dir can't grow unbounded.
  const key = sanitizeKey(input.agent_id || `${input.session_id || 's'}-${input.agent_type || 'a'}`);
  let markerPath = '';
  try {
    if (!existsSync(MARKER_DIR)) mkdirSync(MARKER_DIR, { recursive: true });
    cleanupStaleMarkers();
    markerPath = join(MARKER_DIR, key);
  } catch { /* fs unavailable — proceed without loop protection */ }

  if (markerPath && existsSync(markerPath)) {
    // Already nudged this subagent — stay quiet so it can finish.
    process.stdout.write('{}');
    return;
  }

  if (markerPath) {
    try { writeFileSync(markerPath, String(Date.now())); } catch { /* ok */ }
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStop',
      additionalContext: NUDGE,
    },
  }));
}

main().catch(() => { try { process.stdout.write('{}'); } catch {} process.exit(0); });
