/**
 * The SynaBun Assistant's budget split (surface budget-split) — the questions,
 * not the transport.
 *
 * A session has one dollar budget for the assistant's own turns and every
 * worker run. What is left is divided across the providers (Claude Code,
 * Codex, OpenCode) so each provider's runs draw from a share. Jev cannot
 * answer an amount, so each provider gets one Score question over the same
 * state: how much of the spend still to come will land on it. The questions
 * cannot see each other's answers; the caller (neural-interface
 * lib/assistant-budget-split.js) turns the scores into weights, normalises
 * them, applies the brain's reserve, rounds to cents and makes the shares add
 * up to exactly what is left.
 *
 * Jev only divides money the user already allowed: the total, what was spent
 * and what is left are facts in the state, never something it sets. It never
 * picks a model for a task: the questions are about providers' shares of the
 * spend, and routing stays with the brain and the router.
 *
 * Keep the wording of the instructions and levels stable: changing it
 * invalidates the cache and moves the numbers the split was tuned on (the
 * caller's SHARE_LEVEL_FRACTIONS map these five levels). Returns null
 * whenever no judgment is available, including an answer missing for any
 * provider asked; the caller then uses its deterministic split.
 */

import { judge, score, readScore, type Answer } from './typesafe.js';
import { redactCredentials } from './typesafe-config.js';
import type { JudgeContext } from './memory-judgments.js';

export const BUDGET_PROVIDERS = ['claude-code', 'codex', 'opencode'] as const;
export type BudgetProvider = typeof BUDGET_PROVIDERS[number];
const NAMES: Record<BudgetProvider, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
/** Question ids (code only; never sent as meaning). */
const QUESTION_IDS: Record<BudgetProvider, string> = { 'claude-code': 'share_claude_code', codex: 'share_codex', opencode: 'share_opencode' };

/** The ordered levels of every provider's question, lowest first. */
export const SHARE_LEVELS = [
  'None of it: no remaining work is likely to run on this provider, or it cannot run anything now.',
  'A small part: an occasional task, such as one review or a side task, or only cheap work.',
  'A moderate part: a regular share of the remaining tasks, alongside the other providers.',
  'A large part: most of the expensive remaining work, such as the main coding tasks.',
  'Nearly all of it: practically every remaining dollar is spent on this provider.',
] as const;

export interface BudgetSplitModel { id?: string | null; price?: string | null; billing?: string | null; tier?: string | null }
export interface BudgetSplitProvider {
  eligible?: boolean; why?: string | null;
  spentUsd?: number; brainUsd?: number; runsUsd?: number; shareUsd?: number | null; leftUsd?: number | null;
  liveRuns?: number; runningRuns?: number; recentUsd?: number | null;
  account?: { mode?: string | null; usageLeftPercent?: number | null; limited?: boolean | null } | null;
  models?: BudgetSplitModel[];
}
export interface BudgetSplitTask { taskClass?: string | null; summary?: string | null; provider?: string | null; model?: string | null }
export interface BudgetSplitInput {
  /** The providers to ask about (eligible ones); the rest get no share. */
  ask: string[];
  budget: { amountUsd: number; spentUsd: number; leftUsd: number; warnAtUsd?: number | null };
  checkpoint?: { reason?: string | null; needs?: string[] } | null;
  brain?: { provider?: string | null; model?: string | null; price?: string | null; billing?: string | null } | null;
  routeMode?: string | null;
  savedRoutes?: Array<{ taskClass?: string | null; provider?: string | null; model?: string | null; effort?: string | null; price?: string | null; billing?: string | null }>;
  providers?: Partial<Record<string, BudgetSplitProvider>>;
  tasks?: BudgetSplitTask[];
  task?: BudgetSplitTask | null;
}

export interface BudgetShareScore { score: number; confidence: number; probabilities: Record<string, number> | null }
export interface BudgetSplitJudgment { scores: Partial<Record<BudgetProvider, BudgetShareScore>> }

// State budgets (characters, items).
const SUMMARY_CLIP = 200;
const MAX_TASKS = 12;
const MAX_ROUTES = 16;
const MAX_MODELS = 4;

const text = (value: unknown) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
/** Credentials out first, then the cut: a secret split by a cut would slip past the patterns. */
const safe = (value: unknown, max: number) => {
  const clean = redactCredentials(text(value));
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const usd = (value: unknown) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null);
const isProvider = (value: unknown): value is BudgetProvider => typeof value === 'string' && (BUDGET_PROVIDERS as readonly string[]).includes(value);
const label = (value: unknown) => (isProvider(value) ? value : value ? safe(value, 40) : null);

function taskRow(row: BudgetSplitTask | null | undefined) {
  if (!row || typeof row !== 'object') return null;
  return { task_class: row.taskClass ? safe(row.taskClass, 20) : null, summary: row.summary ? safe(row.summary, SUMMARY_CLIP) : null, provider: label(row.provider), model: row.model ? safe(row.model, 80) : null };
}

/** The state every provider's question reads, bounded and redacted. Amounts in US dollars. */
export function budgetSplitState(input: BudgetSplitInput): Record<string, unknown> {
  const budget = input.budget || { amountUsd: 0, spentUsd: 0, leftUsd: 0 };
  const providers: Record<string, unknown> = {};
  for (const provider of BUDGET_PROVIDERS) {
    const row = input.providers?.[provider];
    if (!row) continue;
    providers[provider] = {
      name: NAMES[provider],
      can_run: row.eligible !== false,
      why_not: row.eligible === false && row.why ? safe(row.why, 40) : null,
      spent_usd: usd(row.spentUsd) ?? 0,
      spent_by_assistant_usd: usd(row.brainUsd) ?? 0,
      spent_by_workers_usd: usd(row.runsUsd) ?? 0,
      current_share_usd: usd(row.shareUsd),
      current_share_left_usd: usd(row.leftUsd),
      runs_live: Math.max(0, Math.floor(Number(row.liveRuns) || 0)),
      runs_working_now: Math.max(0, Math.floor(Number(row.runningRuns) || 0)),
      recent_spend_usd: usd(row.recentUsd),
      account: row.account ? {
        billing: row.account.mode ? safe(row.account.mode, 20) : null,
        usage_left_percent: Number.isFinite(Number(row.account.usageLeftPercent)) ? Math.round(Number(row.account.usageLeftPercent)) : null,
        limited: typeof row.account.limited === 'boolean' ? row.account.limited : null,
      } : null,
      models_routed_here: (Array.isArray(row.models) ? row.models : []).slice(0, MAX_MODELS).map((m) => ({
        model: m?.id ? safe(m.id, 80) : null, list_price_per_mtok: m?.price ? safe(m.price, 40) : null, billing: m?.billing ? safe(m.billing, 20) : null, tier: m?.tier ? safe(m.tier, 10) : null,
      })),
    };
  }
  return {
    session_budget: {
      total_usd: usd(budget.amountUsd) ?? 0,
      spent_usd: usd(budget.spentUsd) ?? 0,
      left_usd: usd(budget.leftUsd) ?? 0,
      warning_at_usd: usd(budget.warnAtUsd),
      note: 'Spend is counted at list price for every provider, subscription work included. The budget pays for the assistant\'s own turns and every worker run.',
    },
    checkpoint: {
      reason: input.checkpoint?.reason ? safe(input.checkpoint.reason, 40) : null,
      providers_short_of_money: (Array.isArray(input.checkpoint?.needs) ? input.checkpoint!.needs : []).filter(isProvider),
    },
    assistant: input.brain ? {
      runs_on: label(input.brain.provider), model: input.brain.model ? safe(input.brain.model, 80) : null,
      list_price_per_mtok: input.brain.price ? safe(input.brain.price, 40) : null, billing: input.brain.billing ? safe(input.brain.billing, 20) : null,
    } : null,
    route_mode: input.routeMode ? safe(input.routeMode, 20) : null,
    saved_routes: (Array.isArray(input.savedRoutes) ? input.savedRoutes : []).slice(0, MAX_ROUTES).map((r) => ({
      task_class: r?.taskClass ? safe(r.taskClass, 20) : null, provider: label(r?.provider), model: r?.model ? safe(r.model, 80) : null,
      list_price_per_mtok: r?.price ? safe(r.price, 40) : null, billing: r?.billing ? safe(r.billing, 20) : null,
    })),
    providers,
    session_tasks_so_far: (Array.isArray(input.tasks) ? input.tasks : []).slice(-MAX_TASKS).map(taskRow).filter(Boolean),
    task_being_routed_now: taskRow(input.task),
  };
}

const shareQuestion = (provider: BudgetProvider) => score(
  'An AI assistant session has a dollar budget (`session_budget`). It pays for the assistant\'s own turns (the assistant runs on `assistant.runs_on`) ' +
  'and for worker runs on three providers (`providers`). `saved_routes` say which provider each kind of task is sent to, `session_tasks_so_far` are the tasks routed so far, ' +
  '`task_being_routed_now` is the task being routed at this moment, and `checkpoint` says why the budget is being divided again. ' +
  `Of the money still to be spent in this session (\`session_budget.left_usd\`), how much will go to work on ${NAMES[provider]} (\`providers.${provider}\`): its worker runs, ` +
  `plus the assistant's own turns when \`assistant.runs_on\` is ${provider}? Judge from the tasks likely to come next, where the saved routes send them, the runs still working, and what the models cost.`,
  [...SHARE_LEVELS],
);

function probabilitiesOf(answer: Answer | undefined): Record<string, number> | null {
  if (answer?.type !== 'score' || !answer.probabilities || typeof answer.probabilities !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(answer.probabilities)) if (Number.isFinite(Number(value))) out[key] = Number(value);
  return Object.keys(out).length ? out : null;
}

/**
 * One request: a Score for each provider in `input.ask`. All or nothing: a
 * missing or wrong-typed answer for any provider asked is no judgment (null).
 */
export async function judgeBudgetSplit(input: BudgetSplitInput, options: JudgeContext = {}): Promise<BudgetSplitJudgment | null> {
  const ask = [...new Set((Array.isArray(input?.ask) ? input.ask : []).filter(isProvider))];
  if (!ask.length) return null;
  const questions: Record<string, ReturnType<typeof score>> = {};
  for (const provider of ask) questions[QUESTION_IDS[provider]] = shareQuestion(provider);
  const answers = await judge(budgetSplitState(input), questions, { ...options, surface: 'budget-split' });
  if (!answers) return null;
  const scores: BudgetSplitJudgment['scores'] = {};
  for (const provider of ask) {
    const answer = answers[QUESTION_IDS[provider]];
    const read = readScore(answer);
    if (!read) return null;
    scores[provider] = { score: read.score, confidence: read.confidence, probabilities: probabilitiesOf(answer) };
  }
  return { scores };
}
