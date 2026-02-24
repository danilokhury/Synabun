#!/usr/bin/env node

/**
 * SynaBun PreCompact Hook for Claude Code
 *
 * Fires BEFORE context compaction (manual or auto). Reads the session
 * transcript and caches a lightweight session summary so the post-compact
 * SessionStart hook can inject it as context for automatic conversation
 * indexing in SynaBun.
 *
 * Input (stdin JSON):
 *   { session_id, transcript_path, cwd, trigger: "manual"|"auto", custom_instructions? }
 *
 * Output: exit code 0 (PreCompact hooks cannot inject context or block)
 *
 * Enable in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreCompact": [{
 *       "matcher": "",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node \"<path-to-synabun>/hooks/claude-code/pre-compact.mjs\"",
 *         "timeout": 10
 *       }]
 *     }]
 *   }
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '..', 'data', 'precompact');
const PENDING_DIR = join(__dirname, '..', '..', 'data', 'pending-compact');

// --- Stdin ---

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('{}');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 3000);
  });
}

// --- Transcript parsing ---

function parseTranscript(transcriptPath) {
  const userMessages = [];
  const assistantSnippets = [];
  const toolsUsed = new Set();
  const filesModified = new Set();
  const filesRead = new Set();
  let totalTurns = 0;

  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.role === 'user') {
          totalTurns++;
          // Extract text from user messages (string or content array)
          if (typeof entry.content === 'string') {
            const text = entry.content.trim();
            if (text && !text.startsWith('{') && text.length > 5) {
              userMessages.push(text.slice(0, 300));
            }
          } else if (Array.isArray(entry.content)) {
            for (const block of entry.content) {
              if (block.type === 'text' && block.text) {
                const text = block.text.trim();
                if (text && !text.startsWith('{') && text.length > 5) {
                  userMessages.push(text.slice(0, 300));
                }
              }
            }
          }
        }

        if (entry.role === 'assistant' && Array.isArray(entry.content)) {
          for (const block of entry.content) {
            // Capture tool usage
            if (block.type === 'tool_use') {
              toolsUsed.add(block.name);
              const input = block.input || {};

              // Track file modifications
              if (['Edit', 'Write', 'NotebookEdit'].includes(block.name) && input.file_path) {
                filesModified.add(input.file_path);
              }
              if (block.name === 'Read' && input.file_path) {
                filesRead.add(input.file_path);
              }
              // Track bash commands that modify files
              if (block.name === 'Bash' && input.command) {
                const cmd = input.command;
                if (/\bgit\s+(add|commit|push|merge|rebase|checkout)/.test(cmd)) {
                  toolsUsed.add('git');
                }
                if (/\bnpm\s+(install|run|test|build)/.test(cmd)) {
                  toolsUsed.add('npm');
                }
              }
            }

            // Capture assistant text snippets (first few)
            if (block.type === 'text' && block.text && assistantSnippets.length < 5) {
              const text = block.text.trim();
              if (text.length > 20) {
                assistantSnippets.push(text.slice(0, 200));
              }
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* transcript unreadable */ }

  return {
    userMessages: userMessages.slice(0, 15),
    assistantSnippets,
    toolsUsed: [...toolsUsed],
    filesModified: [...filesModified],
    filesRead: [...filesRead].slice(0, 20),
    totalTurns,
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
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch { /* proceed with defaults */ }

  const sessionId = input.session_id || '';
  const transcriptPath = input.transcript_path || '';
  const trigger = input.trigger || 'unknown';
  const cwd = input.cwd || '';

  if (!sessionId || !transcriptPath) {
    process.exit(0);
    return;
  }

  // Parse transcript for key data
  const parsed = parseTranscript(transcriptPath);

  // Build cache object
  const cache = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    trigger,
    cwd,
    cached_at: new Date().toISOString(),
    user_message_count: parsed.userMessages.length,
    total_turns: parsed.totalTurns,
    user_messages: parsed.userMessages,
    assistant_snippets: parsed.assistantSnippets,
    tools_used: parsed.toolsUsed,
    files_modified: parsed.filesModified,
    files_read: parsed.filesRead,
  };

  // Write cache
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${sessionId}.json`), JSON.stringify(cache, null, 2));

  // Write pending flag — Stop hook will block until this is cleared by PostToolUse
  if (!existsSync(PENDING_DIR)) mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(join(PENDING_DIR, `${sessionId}.json`), JSON.stringify({
    session_id: sessionId,
    created_at: new Date().toISOString(),
    retries: 0,
  }));

  // Cleanup old files
  cleanupOldCache();

  process.exit(0);
}

main().catch(() => process.exit(0));
