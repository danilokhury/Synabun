/**
 * The SynaBun Assistant's judgments about its workers (surfaces worker-outcome
 * and worker-claim) — the questions, not the transport.
 *
 * A dispatched worker ends each turn with a `## Result` block. When it does
 * not, one judgment reads the status from its final message instead of paying
 * for a result-retry turn. When a run is blocked or failed, the same request
 * asks what kept it from finishing, which decides whether a stronger model
 * (capability), a plain retry (transient) or nothing at all (access, needs the
 * user) is offered. When it reports done, the Stop hook's unsupported-claim
 * question rides along, over the commands and tool results the turn exposed.
 *
 * Keep the wording of instructions and criteria stable: changing it
 * invalidates the cache and moves the numbers the thresholds were set on.
 * The claim question is the Stop hook's own (`unsupportedClaimQuestion`), so
 * its P ≥ 0.9 calibration carries over. Returns null whenever no judgment is
 * available; the dispatcher then does what it did before Jev.
 */

import { judge, choice, readChoice, readNoul } from './typesafe.js';
import { redactCredentials } from './typesafe-config.js';
import { unsupportedClaimQuestion, type JudgeContext, type TurnCommand, type TurnToolResult } from './memory-judgments.js';

export const WORKER_STATUS_OPTIONS = {
  done: 'It says the task is finished: the requested work was carried out, perhaps with minor caveats or suggested next steps.',
  blocked: 'It stopped without finishing because something got in the way — an error, a failing step, missing access, a limit — and says so.',
  needs_input: 'It cannot go on without a decision, an answer or information from the person who gave the task, and asks for it.',
  unclear: 'It does not say: it is cut off, only narrates progress or plans, or leaves open whether the task is finished.',
} as const;
export type WorkerStatus = keyof typeof WORKER_STATUS_OPTIONS;

export const WORKER_CAUSE_OPTIONS = {
  capability: 'The task was within reach and the agent fell short: a wrong approach, a bug it could not find, broken or partial work, giving up, running out of turns or context. A more capable model could plausibly finish it.',
  access: 'Something outside the agent was missing or forbidden: a permission, credential, API key, sign-in, tool, network access, sandbox or read-only restriction, or a path it could not reach. A more capable model would hit the same wall.',
  needs_user: 'Only the person who gave the task can unblock it: a decision, a preference, missing information or an approval.',
  transient: 'A temporary failure unrelated to the task: a timeout, rate limit, overloaded or unavailable service, crash or dropped connection. The same attempt could work if retried.',
  other: 'Nothing kept it from finishing, none of these fit, or there is not enough information to tell.',
} as const;
export type WorkerCause = keyof typeof WORKER_CAUSE_OPTIONS;

const statusQuestion = () => choice(
  '`assistant_message` is the last message an AI coding agent wrote after working on `task`. It was told to end with a status block and did not. ' +
  'Which status does `assistant_message` report? Judge only what it says, not whether the work looks right.',
  WORKER_STATUS_OPTIONS as unknown as Record<string, string>,
);

const causeQuestion = () => choice(
  'An AI coding agent worked on `task` and may not have finished. `run` says how the run ended, `declared` is the status block the agent wrote (null when it wrote none), ' +
  '`assistant_message` is its last message, and `bash_commands` and `tool_results` are what ran in its last turn. What mainly kept it from finishing?',
  WORKER_CAUSE_OPTIONS as unknown as Record<string, string>,
);

export interface WorkerOutcomeInput {
  task: string;
  /** The worker's last message (before any result-retry turn). */
  message: string;
  /** The `## Result` block it wrote, when it wrote one. */
  declared?: { status?: string | null; summary?: string | null; question?: string | null } | null;
  /** How the run ended, for a failed run; null for a finished turn of a live run. */
  run?: { provider?: string | null; state?: string | null; completionReason?: string | null; error?: string | null } | null;
  filesEdited?: string[];
  commands?: TurnCommand[];
  toolResults?: TurnToolResult[];
}

export interface WorkerOutcomeAsk { status: boolean; cause: boolean; claim: boolean }

export interface WorkerOutcomeJudgment {
  status?: WorkerStatus; statusConfidence?: number;
  cause?: WorkerCause; causeConfidence?: number;
  /** P(the message claims a success the turn's output does not show). */
  claimProbability?: number;
}

// State budgets (characters).
const TASK_CLIP = 2000;
const MESSAGE_CLIP = 6000;
const MESSAGE_HEAD = 2000;
const SUMMARY_CLIP = 1000;
const QUESTION_CLIP = 500;
const ERROR_CLIP = 500;
const COMMAND_CLIP = 300;
const OUTPUT_TAIL = 500;
const MAX_COMMANDS = 8;
const MAX_RESULTS = 6;
const MAX_FILES = 20;

const text = (value: unknown) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
/** Credentials out first, then the cut: a secret split by a cut would slip past the patterns. */
const safe = (value: unknown) => redactCredentials(text(value));
const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const tail = (value: string, max: number) => (value.length > max ? `…${value.slice(value.length - (max - 1))}` : value);
const MARKER = '\n[…]\n';
/** The opening (the plan) and the end (the outcome) of a long message. */
function headAndTail(value: string, max = MESSAGE_CLIP, head = MESSAGE_HEAD): string {
  if (value.length <= max) return value;
  return value.slice(0, head) + MARKER + value.slice(value.length - (max - head - MARKER.length));
}

/** The state every worker question reads, redacted and bounded. */
export function workerOutcomeState(input: WorkerOutcomeInput): Record<string, unknown> {
  const declared = input.declared && typeof input.declared === 'object' ? input.declared : null;
  const run = input.run && typeof input.run === 'object' ? input.run : null;
  return {
    task: cut(safe(input.task), TASK_CLIP),
    assistant_message: headAndTail(safe(input.message)),
    declared: declared ? {
      status: declared.status ? cut(text(declared.status), 40) : null,
      summary: declared.summary ? cut(safe(declared.summary), SUMMARY_CLIP) : null,
      question: declared.question ? cut(safe(declared.question), QUESTION_CLIP) : null,
    } : null,
    run: run ? {
      provider: run.provider ? cut(text(run.provider), 40) : null,
      state: run.state ? cut(text(run.state), 40) : null,
      completion_reason: run.completionReason ? cut(text(run.completionReason), 80) : null,
      error: run.error ? cut(safe(run.error), ERROR_CLIP) : null,
    } : null,
    files_edited: (Array.isArray(input.filesEdited) ? input.filesEdited : []).filter(f => typeof f === 'string' && f).slice(0, MAX_FILES).map(f => cut(safe(f), 300)),
    bash_commands: (Array.isArray(input.commands) ? input.commands : []).filter(c => c && typeof c === 'object').slice(-MAX_COMMANDS).map(c => ({
      command: cut(safe(c.command), COMMAND_CLIP), exit: typeof c.exit === 'string' ? c.exit : null,
      output_tail: c.output_tail ? tail(safe(c.output_tail), OUTPUT_TAIL) : null,
    })),
    tool_results: (Array.isArray(input.toolResults) ? input.toolResults : []).filter(r => r && typeof r === 'object').slice(-MAX_RESULTS).map(r => ({
      tool: cut(text(r.tool), 120), is_error: Boolean(r.is_error), tail: r.tail ? tail(safe(r.tail), OUTPUT_TAIL) : null,
    })),
  };
}

/**
 * Everything the dispatcher wants to know about a worker's turn or failed run,
 * in one request: the status its message reports (only when it wrote no
 * `## Result` block), what kept it from finishing, and whether a success it
 * claims is unsupported by the turn's own output. Lead worker-outcome, rider
 * worker-claim (the claim alone leads with worker-claim).
 */
export async function judgeWorkerOutcome(
  input: WorkerOutcomeInput,
  ask: WorkerOutcomeAsk,
  options: JudgeContext = {},
): Promise<WorkerOutcomeJudgment | null> {
  if (!ask.status && !ask.cause && !ask.claim) return null;
  const questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof unsupportedClaimQuestion>> = {};
  if (ask.status) questions.status = statusQuestion();
  if (ask.cause) questions.cause = causeQuestion();
  if (ask.claim) questions.unsupported_claim = unsupportedClaimQuestion();
  const asked = [...(ask.status || ask.cause ? ['worker-outcome'] : []), ...(ask.claim ? ['worker-claim'] : [])];
  const answers = await judge(workerOutcomeState(input), questions, { ...options, surface: asked[0], riders: asked.slice(1) });
  if (!answers) return null;
  const out: WorkerOutcomeJudgment = {};
  const status = readChoice(answers.status);
  if (ask.status && status && Object.hasOwn(WORKER_STATUS_OPTIONS, status.choice)) { out.status = status.choice as WorkerStatus; out.statusConfidence = status.confidence; }
  const cause = readChoice(answers.cause);
  if (ask.cause && cause && Object.hasOwn(WORKER_CAUSE_OPTIONS, cause.choice)) { out.cause = cause.choice as WorkerCause; out.causeConfidence = cause.confidence; }
  const claim = readNoul(answers.unsupported_claim);
  if (ask.claim && claim !== null) out.claimProbability = claim;
  return Object.keys(out).length ? out : null;
}
