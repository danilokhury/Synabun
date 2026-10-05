#!/usr/bin/env node

/**
 * SynaBun PreCompact Hook for Claude Code
 *
 * Fires BEFORE context compaction (manual or auto). Reads the session
 * transcript and caches a lightweight session summary so the post-compact
 * SessionStart hook can inject it as context for automatic conversation
 * indexing in SynaBun.
 *
 * Order matters: the pending-compact flag is written FIRST, so the Stop hook
 * still demands the conversations memory even if parsing or the digest runs
 * out of time. Then the transcript is parsed and the cache written.
 *
 * Transcript lines are {type:'user'|'assistant', message:{role, content}, …}.
 * (This hook used to read a top-level entry.role / entry.content that does not
 * exist, so every compaction memory was built from empty message lists.) Meta
 * lines, sidechains, tool results and system-injected prompts (task
 * notifications, mailbox relays, …) are not conversation.
 *
 * Digest: for a long session, Jev picks which messages matter (goal /
 * decision / finding / open_issue / routine) from ≤48 stride-sampled
 * candidates plus the most recent ones — kind `compact-digest`, at most 10
 * human and 3 assistant messages, in chronological order. Fallback: the first
 * 15 human and 5 assistant messages. The cache records `digest: 'jev'|'first-n'`.
 *
 * Input (stdin JSON):
 *   { session_id, transcript_path, cwd, trigger: "manual"|"auto", custom_instructions? }
 *
 * Output: exit code 0 (PreCompact hooks cannot inject context or block)
 */

import { readFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withStateLock, writeJsonAtomic } from './state.mjs';
import { getDataHome } from '../../lib/paths.js';
import { appendCapped, detectProject, hookBudget, hookJudge, humanPromptText, isTurnStart, typesafeOff, isTemporaryChat } from './shared.mjs';
import { isTrivialPrompt } from './prompt-origin.mjs';

// Cross-platform safety: catch uncaught errors and exit cleanly
process.on('uncaughtException', () => { process.exit(0); });
process.on('unhandledRejection', () => { process.exit(0); });

const DATA_HOME = getDataHome();
const CACHE_DIR = join(DATA_HOME, 'data', 'precompact');
const PENDING_DIR = join(DATA_HOME, 'data', 'pending-compact');
const DEBUG_LOG = join(DATA_HOME, 'data', 'compact-debug.log');

const FIRST_N = { user: 15, assistant: 5 };
const PICK = { user: 10, assistant: 3 };
const DIGEST_MAX_CANDIDATES = 48;
const DIGEST_RECENT = { user: 6, assistant: 4 };
const DIGEST_TEXT_MAX = 700;
const USER_TEXT_MAX = 300;
const ASSISTANT_TEXT_MAX = 200;

// --- Stdin ---

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('{}');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(guard); resolve(data); });
    const guard = setTimeout(() => resolve(data || '{}'), 3000);
    guard.unref?.();
  });
}

// --- Transcript parsing ---

function parseTranscript(transcriptPath) {
  const messages = []; // chronological conversation: {role:'user'|'assistant', text}
  const toolsUsed = new Set();
  const filesModified = new Set();
  const filesRead = new Set();
  let humanPrompts = 0;

  let content = '';
  try { content = readFileSync(transcriptPath, 'utf-8'); } catch { /* transcript unreadable */ }

  for (const line of content.split('\n')) {
    if (!line) continue;
    // Attachment, snapshot and title lines can be megabytes and carry no
    // conversation; tool results are the bulk of the rest.
    const head = line.slice(0, 600);
    if (head.includes('"attachment":') || !head.includes('"message":') || head.includes('"type":"tool_result"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isSidechain) continue;

    if (entry.type === 'user') {
      if (!isTurnStart(entry)) continue;
      const text = humanPromptText(entry);
      if (!text) continue;
      humanPrompts++;
      if (!isTrivialPrompt(text)) messages.push({ role: 'user', text });
      continue;
    }

    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        toolsUsed.add(block.name);
        const input = block.input || {};
        const file = input.file_path || input.notebook_path;
        if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(block.name) && file) filesModified.add(file);
        if (block.name === 'Read' && input.file_path) filesRead.add(input.file_path);
        if (block.name === 'Bash' && typeof input.command === 'string') {
          if (/\bgit\s+(add|commit|push|merge|rebase|checkout)/.test(input.command)) toolsUsed.add('git');
          if (/\bnpm\s+(install|run|test|build)/.test(input.command)) toolsUsed.add('npm');
        }
      } else if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text.length > 20) messages.push({ role: 'assistant', text });
      }
    }
  }

  return {
    messages,
    humanPrompts,
    toolsUsed: [...toolsUsed],
    filesModified: [...filesModified],
    filesRead: [...filesRead].slice(0, 20),
  };
}

/**
 * ≤48 candidate indices into `messages`, chronological: the most recent human
 * and assistant messages always, the rest stride-sampled across the whole
 * session (so the opening request is in).
 */
function digestCandidates(messages, max = DIGEST_MAX_CANDIDATES) {
  const all = messages.map((_, i) => i);
  if (all.length <= max) return all;
  const users = all.filter((i) => messages[i].role === 'user');
  const assistants = all.filter((i) => messages[i].role === 'assistant');
  const chosen = new Set([...users.slice(-DIGEST_RECENT.user), ...assistants.slice(-DIGEST_RECENT.assistant)]);
  const rest = all.filter((i) => !chosen.has(i));
  const slots = max - chosen.size;
  const step = rest.length / slots;
  for (let k = 0; k < slots && k * step < rest.length; k++) chosen.add(rest[Math.floor(k * step)]);
  return [...chosen].sort((a, b) => a - b);
}

function firstN(messages) {
  return {
    user: messages.filter((m) => m.role === 'user').slice(0, FIRST_N.user).map((m) => m.text.slice(0, USER_TEXT_MAX)),
    assistant: messages.filter((m) => m.role === 'assistant').slice(0, FIRST_N.assistant).map((m) => m.text.slice(0, ASSISTANT_TEXT_MAX)),
  };
}

async function jevDigest(messages, { sessionId, cwd, project, timeoutMs }) {
  const candidates = digestCandidates(messages);
  const goal = messages.find((m) => m.role === 'user')?.text || '';
  const answer = await hookJudge('compact-digest', {
    messages: candidates.map((i) => ({ i, role: messages[i].role, text: messages[i].text.slice(0, DIGEST_TEXT_MAX) })),
    goal: goal.slice(0, 1000),
    pick: { ...PICK },
    session_id: sessionId, cwd, project,
  }, { timeoutMs });
  const sent = new Set(candidates);
  const picked = Array.isArray(answer?.picked)
    ? [...new Set(answer.picked.filter((i) => Number.isInteger(i) && sent.has(i)))].sort((a, b) => a - b)
    : [];
  const user = picked.filter((i) => messages[i].role === 'user').slice(0, PICK.user);
  if (!user.length) return null;
  const assistant = picked.filter((i) => messages[i].role === 'assistant').slice(0, PICK.assistant);
  return {
    user: user.map((i) => messages[i].text.slice(0, USER_TEXT_MAX)),
    assistant: assistant.map((i) => messages[i].text.slice(0, ASSISTANT_TEXT_MAX)),
    of: candidates.length,
  };
}

// --- Cleanup old cache files (older than 2 hours) ---

function cleanupOldCache() {
  try {
    if (!existsSync(CACHE_DIR)) return;
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const file of readdirSync(CACHE_DIR)) {
      const filePath = join(CACHE_DIR, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) unlinkSync(filePath);
      } catch { /* skip */ }
    }
  } catch { /* ignore cleanup errors */ }
}

// --- Main ---

async function main() {
  const budget = hookBudget(10000);
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch { /* proceed with defaults */ }

  // A temporary chat (see isTemporaryChat): nothing of it is captured, flagged
  // for indexing or digested.
  if (isTemporaryChat()) { process.exit(0); return; }

  const sessionId = input.session_id || '';
  const transcriptPath = input.transcript_path || '';
  const trigger = input.trigger || 'unknown';
  const cwd = input.cwd || '';

  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId) || !transcriptPath) {
    process.exit(0);
    return;
  }

  // The obligation first: whatever happens below, Stop will ask for the
  // conversations memory of this generation.
  const generation = randomUUID();
  try {
    withStateLock(() => writeJsonAtomic(join(PENDING_DIR, `${sessionId}.json`), {
      session_id: sessionId, generation,
      created_at: new Date().toISOString(), retries: 0,
    }));
  } catch { /* the cache below still carries the generation */ }

  // Parse transcript for key data
  const parsed = parseTranscript(transcriptPath);
  const project = detectProject(cwd);
  const userCount = parsed.messages.filter((m) => m.role === 'user').length;
  const assistantCount = parsed.messages.length - userCount;

  let selection = null;
  let digest = 'first-n';
  if ((userCount > PICK.user || assistantCount > PICK.assistant) && !typesafeOff()) {
    const timeoutMs = Math.min(6000, budget.callTimeout(500));
    try { selection = await jevDigest(parsed.messages, { sessionId, cwd, project, timeoutMs }); } catch { selection = null; }
    if (selection) digest = 'jev';
  }
  if (!selection) selection = firstN(parsed.messages);

  // Build cache object
  const cache = {
    session_id: sessionId,
    generation,
    transcript_path: transcriptPath,
    trigger,
    cwd,
    cached_at: new Date().toISOString(),
    user_message_count: userCount,
    total_turns: parsed.humanPrompts,
    user_messages: selection.user,
    assistant_snippets: selection.assistant,
    digest,
    tools_used: parsed.toolsUsed,
    files_modified: parsed.filesModified,
    files_read: parsed.filesRead,
  };

  // Capture active loop state for compaction recovery
  const LOOP_DIR = join(DATA_HOME, 'data', 'loop');
  const loopPath = join(LOOP_DIR, `${sessionId}.json`);
  if (existsSync(loopPath)) {
    try {
      const loopState = JSON.parse(readFileSync(loopPath, 'utf-8'));
      if (loopState.active) {
        cache.loop = {
          active: true,
          task: loopState.task,
          context: loopState.context,
          currentIteration: loopState.currentIteration,
          totalIterations: loopState.totalIterations,
          maxMinutes: loopState.maxMinutes,
          startedAt: loopState.startedAt,
          progressSummary: loopState.progressSummary || null,
          journal: (loopState.journal || []).slice(-5),
          lastMemoryAt: loopState.lastMemoryAt || 0,
          usesBrowser: loopState.usesBrowser || false,
        };
      }
    } catch { /* skip */ }
  }

  try {
    withStateLock(() => writeJsonAtomic(join(CACHE_DIR, `${sessionId}.json`), cache));
  } catch { /* SessionStart falls back to the Stop obligation alone */ }

  // Debug logging
  try {
    appendCapped(DEBUG_LOG, `[${new Date().toISOString()}] PRE-COMPACT session_id=${sessionId} trigger=${trigger} cwd=${cwd} digest=${digest} users=${userCount} assistant=${assistantCount}\n`);
  } catch { /* ok */ }

  // Cleanup old files
  try { withStateLock(() => cleanupOldCache()); } catch { /* ok */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
