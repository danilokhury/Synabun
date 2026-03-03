import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
// Loop state files and templates live in the Neural Interface data dir (Synabun/data/)
const NI_DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const LOOP_DIR = join(NI_DATA_DIR, 'loop');
const LOOP_TEMPLATES_PATH = join(NI_DATA_DIR, 'loop-templates.json');

const MAX_ITERATIONS = 50;
const DEFAULT_ITERATIONS = 10;
const MAX_MINUTES = 60;
const DEFAULT_MINUTES = 30;

function ensureLoopDir() {
  if (!existsSync(LOOP_DIR)) {
    mkdirSync(LOOP_DIR, { recursive: true });
  }
}

/**
 * Resolve the session ID for loop state file.
 * Priority: explicit param > CLAUDE_SESSION_ID env > scan directory for any active loop.
 */
function resolveSessionId(explicit?: string): string | null {
  if (explicit) return explicit;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;

  // Fallback: scan for any active loop file
  ensureLoopDir();
  try {
    const files = readdirSync(LOOP_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(LOOP_DIR, file), 'utf-8'));
        if (data?.active) return file.replace('.json', '');
      } catch { /* skip corrupt files */ }
    }
  } catch { /* dir read failed */ }

  return null;
}

function getLoopPath(sessionId: string): string {
  return join(LOOP_DIR, `${sessionId}.json`);
}

export const loopSchema = {
  action: z
    .enum(['start', 'stop', 'status'] as const)
    .describe('start: begin autonomous loop. stop: end loop. status: check current loop state.'),
  task: z
    .string()
    .optional()
    .describe('What to do each iteration (required for start).'),
  iterations: z
    .number()
    .optional()
    .describe(`Max iterations (1-${MAX_ITERATIONS}, default ${DEFAULT_ITERATIONS}).`),
  max_minutes: z
    .number()
    .optional()
    .describe(`Time cap in minutes (1-${MAX_MINUTES}, default ${DEFAULT_MINUTES}).`),
  context: z
    .string()
    .optional()
    .describe('Extra context injected each iteration.'),
  session_id: z
    .string()
    .optional()
    .describe('Claude Code session ID. Auto-detected if omitted.'),
  template: z
    .string()
    .optional()
    .describe('Load a saved template by name or id. Template values are used as defaults; explicit params override.'),
};

export const loopDescription =
  'Autonomous loop control. Start a repeating task loop, check status, or stop it. The Stop hook drives iteration — each time Claude finishes, the hook blocks and injects the next iteration.';

// ── Start ──────────────────────────────────────────────────────

function loadTemplate(nameOrId: string): Record<string, unknown> | null {
  try {
    if (!existsSync(LOOP_TEMPLATES_PATH)) return null;
    const templates = JSON.parse(readFileSync(LOOP_TEMPLATES_PATH, 'utf-8'));
    if (!Array.isArray(templates)) return null;
    const lower = nameOrId.toLowerCase();
    return templates.find((t: Record<string, unknown>) =>
      (t.id as string) === nameOrId ||
      (t.name as string)?.toLowerCase() === lower
    ) || null;
  } catch { return null; }
}

function handleStart(args: {
  task?: string;
  iterations?: number;
  max_minutes?: number;
  context?: string;
  session_id?: string;
  template?: string;
}) {
  // Load template defaults if specified
  if (args.template) {
    const tpl = loadTemplate(args.template);
    if (!tpl) {
      return { content: [{ type: 'text' as const, text: `Error: Template "${args.template}" not found. Check Settings → Automations for available templates.` }] };
    }
    // Template values as defaults; explicit params override
    if (!args.task) args.task = tpl.task as string;
    if (args.iterations === undefined) args.iterations = tpl.iterations as number;
    if (args.max_minutes === undefined) args.max_minutes = tpl.maxMinutes as number;
    if (!args.context && tpl.context) args.context = tpl.context as string;
  }

  if (!args.task?.trim()) {
    return { content: [{ type: 'text' as const, text: 'Error: "task" is required for start action. Describe what to do each iteration.' }] };
  }

  const sessionId = resolveSessionId(args.session_id);
  if (!sessionId) {
    return { content: [{ type: 'text' as const, text: 'Error: Could not determine session ID. Pass session_id explicitly or ensure CLAUDE_SESSION_ID is set.' }] };
  }

  const iterations = Math.min(Math.max(args.iterations || DEFAULT_ITERATIONS, 1), MAX_ITERATIONS);
  const maxMinutes = Math.min(Math.max(args.max_minutes || DEFAULT_MINUTES, 1), MAX_MINUTES);

  ensureLoopDir();

  // Check for existing active loop
  const loopPath = getLoopPath(sessionId);
  if (existsSync(loopPath)) {
    try {
      const existing = JSON.parse(readFileSync(loopPath, 'utf-8'));
      if (existing?.active) {
        return { content: [{ type: 'text' as const, text: `Error: Loop already active (iteration ${existing.currentIteration}/${existing.totalIterations}). Stop it first with action "stop".` }] };
      }
    } catch { /* corrupt file, overwrite */ }
  }

  const state = {
    active: true,
    task: args.task.trim(),
    totalIterations: iterations,
    currentIteration: 0,
    maxMinutes,
    startedAt: new Date().toISOString(),
    lastIterationAt: null as string | null,
    context: args.context?.trim() || null,
    retries: 0,
  };

  writeFileSync(loopPath, JSON.stringify(state, null, 2));

  return {
    content: [{
      type: 'text' as const,
      text: [
        `Loop started for session ${sessionId}.`,
        `Task: ${state.task}`,
        `Iterations: ${iterations} | Time cap: ${maxMinutes} min`,
        state.context ? `Context: ${state.context}` : '',
        '',
        'The Stop hook will now drive autonomous iteration. Begin your first iteration.',
      ].filter(Boolean).join('\n'),
    }],
  };
}

// ── Stop ───────────────────────────────────────────────────────

function handleStop(args: { session_id?: string }) {
  const sessionId = resolveSessionId(args.session_id);
  if (!sessionId) {
    return { content: [{ type: 'text' as const, text: 'No active loop found to stop.' }] };
  }

  const loopPath = getLoopPath(sessionId);
  if (!existsSync(loopPath)) {
    return { content: [{ type: 'text' as const, text: 'No active loop found for this session.' }] };
  }

  let summary = '';
  try {
    const state = JSON.parse(readFileSync(loopPath, 'utf-8'));
    const elapsed = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000);
    summary = ` Completed ${state.currentIteration}/${state.totalIterations} iterations in ${elapsed} min.`;
  } catch { /* ok */ }

  try { unlinkSync(loopPath); } catch { /* ok */ }

  return { content: [{ type: 'text' as const, text: `Loop stopped.${summary}` }] };
}

// ── Status ─────────────────────────────────────────────────────

function handleStatus(args: { session_id?: string }) {
  const sessionId = resolveSessionId(args.session_id);
  if (!sessionId) {
    return { content: [{ type: 'text' as const, text: 'No active loop.' }] };
  }

  const loopPath = getLoopPath(sessionId);
  if (!existsSync(loopPath)) {
    return { content: [{ type: 'text' as const, text: 'No active loop for this session.' }] };
  }

  let state;
  try {
    state = JSON.parse(readFileSync(loopPath, 'utf-8'));
  } catch {
    return { content: [{ type: 'text' as const, text: 'Loop state file is corrupt.' }] };
  }

  if (!state.active) {
    const finishedAt = state.finishedAt ? ` Finished at ${state.finishedAt}.` : '';
    return { content: [{ type: 'text' as const, text: `Loop inactive (completed).${finishedAt} ${state.currentIteration}/${state.totalIterations} iterations done.` }] };
  }

  const elapsed = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000);
  const timeLeft = Math.max(0, state.maxMinutes - elapsed);

  return {
    content: [{
      type: 'text' as const,
      text: [
        `Loop active: iteration ${state.currentIteration}/${state.totalIterations}`,
        `Task: ${state.task}`,
        `Elapsed: ${elapsed} min | Remaining: ${timeLeft} min`,
        state.context ? `Context: ${state.context}` : '',
        state.lastIterationAt ? `Last iteration: ${state.lastIterationAt}` : '',
      ].filter(Boolean).join('\n'),
    }],
  };
}

// ── Main dispatcher ────────────────────────────────────────────

export async function handleLoop(args: {
  action: string;
  task?: string;
  iterations?: number;
  max_minutes?: number;
  context?: string;
  session_id?: string;
  template?: string;
}) {
  switch (args.action) {
    case 'start':
      return handleStart(args);
    case 'stop':
      return handleStop(args);
    case 'status':
      return handleStatus(args);
    default:
      return { content: [{ type: 'text' as const, text: `Unknown action "${args.action}". Use: start, stop, status.` }] };
  }
}
