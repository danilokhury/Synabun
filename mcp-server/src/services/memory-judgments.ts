/**
 * SynaBun's judgment definitions — the questions, not the transport.
 *
 * Each function here replaces a heuristic that used to be a regex or a bare
 * similarity constant. All of them return null when the judgment is
 * unavailable, and every caller keeps its original heuristic as the fallback
 * path. Keep the wording of instructions/criteria stable: changing them
 * invalidates the cache and moves the numbers the bench was calibrated on.
 */

import { createHash } from 'node:crypto';
import { judge, choice, noul, score, readChoice, readNoul, readScore, type Answers, type JudgeOptions } from './typesafe.js';

/** Where a judgment came from and what it is about, for the log and the usage counters. */
export type JudgeContext = Pick<JudgeOptions, 'origin' | 'entityId' | 'onUsage' | 'noCache' | 'timeoutMs' | 'sessionId' | 'project' | 'onLogged'>;

/**
 * Bound a text before it goes into a state. The API counts every token and
 * caps state plus the longest question at 32k; a 40k-char memory with three
 * 40k-char neighbours is a 400, not a better question. Relations went over
 * that cap on large JSON captures during the first backfill.
 */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [truncated, ${text.length} chars total]` : text);
/** Per-text budgets: one memory alone, and each text in a multi-text state. */
const MEMORY_CLIP = 12_000;
const CANDIDATE_CLIP = 6_000;

// --- Importance (Surface B) ---

/**
 * SynaBun's documented 1-10 bands as ordered Score levels, indexed from 0.
 * The band -> integer mapping lives in code, not in the model: the model
 * judges position on a rubric, code decides what that means numerically.
 */
export const IMPORTANCE_LEVELS = [
  'Trivial: a passing detail with no reuse value — a typo, a one-off command, small talk.',
  'Low: mildly useful context that would rarely change a future decision.',
  'Normal: a routine but real outcome — a completed task, a config change, a fix worth recalling.',
  'Significant: a non-obvious finding, an API quirk, or a gotcha that will save real time later.',
  'Critical: something that prevents damage or rework — a hard-won lesson, a dangerous operation to avoid.',
  'Foundational: a core architectural decision the whole project rests on.',
];
const BAND_TO_IMPORTANCE = [1.5, 3.5, 5, 6.5, 8.5, 10];

/** Interpolate a fractional band position onto the 1-10 importance scale. */
export function bandToImportance(band: number): number {
  const clamped = Math.max(0, Math.min(band, BAND_TO_IMPORTANCE.length - 1));
  const low = Math.floor(clamped);
  const high = Math.min(low + 1, BAND_TO_IMPORTANCE.length - 1);
  return BAND_TO_IMPORTANCE[low] + (BAND_TO_IMPORTANCE[high] - BAND_TO_IMPORTANCE[low]) * (clamped - low);
}

export const MEMORY_KINDS = {
  decision: 'A choice that was made and the reasoning behind it — architecture, approach, tooling, policy.',
  issue: 'A bug, failure, breakage or open problem, whether or not it was resolved.',
  preference: 'How this person wants work done — style, tone, workflow, tools they favour or refuse.',
  fact: 'A stable piece of reference information: an ID, a path, a credential location, an API contract.',
  note: 'Anything else worth keeping that is not a decision, issue, preference or reference fact.',
} as const;

export interface MemoryJudgment {
  importance: number | null;
  importanceConfidence: number;
  kind: string | null;
  kindConfidence: number;
}

/**
 * Judge a memory's long-term importance and its kind in one request.
 * Both questions read the same state, so they run in parallel server-side.
 */
export async function judgeMemory(
  content: string,
  context: { category?: string; project?: string } = {},
  options: JudgeContext = {},
): Promise<MemoryJudgment | null> {
  const answers = await judge(
    { memory_text: clip(content, MEMORY_CLIP), category: context.category ?? null, project: context.project ?? null },
    {
      importance: score(
        'How important is `memory_text` to this project long-term? Judge the durable value of the ' +
        'information itself, not how long the text is or how confidently it is written.',
        IMPORTANCE_LEVELS,
      ),
      kind: choice(
        'What kind of record is `memory_text`? Judge the content, not the category label it was filed under.',
        MEMORY_KINDS as unknown as Record<string, string>,
      ),
    },
    { ...options, surface: 'importance-kind' },
  );
  if (!answers) return null;
  const importance = readScore(answers.importance);
  const kind = readChoice(answers.kind);
  return {
    importance: importance ? bandToImportance(importance.score) : null,
    importanceConfidence: importance?.confidence ?? 0,
    kind: kind?.choice ?? null,
    kindConfidence: kind?.confidence ?? 0,
  };
}

// --- Relations (Surface A) ---

/** Relation kinds `memory_relations.kind` accepts for an automatic verdict. */
export type JudgedRelation = 'duplicate_of' | 'possible_conflict' | 'similar' | null;

// A knowledge base full of automation logs contains many near-identical records
// that describe SEPARATE OCCURRENCES of a recurring event — the same scheduled
// post on four different days. Without saying so, a judgment reads the shared
// wording plus the differing date as a contradiction. Every option below has to
// distinguish "another occurrence" from "an incompatible claim".
const RELATION_OPTIONS = {
  duplicate: 'The same fact about the same single occurrence, stated twice. One could be deleted without losing information. NOT two records of a recurring event that happened on different dates.',
  conflicting: 'They make incompatible claims about the same thing at the same time — accepting one means rejecting the other. A later record describing a separate, repeated occurrence is NOT a conflict, and neither is a record that simply updates or supersedes an older state.',
  related: 'About the same subject and useful together — including repeated runs of the same recurring activity on different dates, where each record documents its own occurrence.',
  unrelated: 'They only share vocabulary or topic area. Neither helps you understand the other.',
};

export interface RelationJudgment {
  relation: JudgedRelation;
  confidence: number;
  contradiction: number | null;
  /** P(the later-dated record replaces the earlier one); null when not asked or not answered. */
  supersedes: number | null;
}

/** Cutoffs mapRelation applies; the duplicate one is the relations surface's minConfidence. */
export interface RelationThresholds { duplicate: number; contradiction: number }
export const DEFAULT_RELATION_THRESHOLDS: RelationThresholds = { duplicate: 0.7, contradiction: 0.5 };

/**
 * Decide how each candidate relates to one source memory.
 *
 * Replaces a bare cosine cutoff plus a negation-word regex. Every candidate is
 * judged in a single request against shared state — the source text is sent
 * once rather than once per pair. For each candidate the Choice picks the
 * relation and an independent Noul gives a calibrated contradiction
 * probability, used to stop a low-confidence "conflicting" from writing a
 * conflict flag.
 */
export async function judgeRelations(
  source: { content: string; recordedAt?: string } | string,
  candidates: { id: string; content: string; recordedAt?: string }[],
  options: JudgeContext & { askSupersession?: boolean; thresholds?: RelationThresholds } = {},
): Promise<Map<string, RelationJudgment> | null> {
  if (!candidates.length) return new Map();
  const { askSupersession = false, thresholds = DEFAULT_RELATION_THRESHOLDS, ...context } = options;
  const src = typeof source === 'string' ? { content: source } : source;
  const questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> = {};
  candidates.forEach((_, i) => {
    // Supersession rides in the same request: it reads the same pair and dates.
    if (askSupersession) questions[`supersedes_${i}`] = supersessionQuestion(i);
    questions[`relation_${i}`] = choice(
      `Two records from the same knowledge base were retrieved as similar. How does \`candidates[${i}]\` relate to \`memory\`? ` +
      'Compare `memory.recorded_at` against the candidate\'s own `recorded_at`: records written on different dates usually ' +
      'document separate occurrences rather than competing versions of one fact.',
      RELATION_OPTIONS,
    );
    questions[`contradiction_${i}`] = noul(
      `Do \`memory.content\` and \`candidates[${i}].content\` make claims that cannot both be true at the same time?`,
      {
        true: 'They assert mutually exclusive things about the same subject at the same moment — believing one requires disbelieving the other.',
        false: 'They agree, describe different subjects, one merely adds detail, or they record the SAME recurring activity happening on different dates. Two logs of a scheduled job on separate days are both true.',
      },
    );
  });
  const answers = await judge(
    {
      memory: { content: clip(src.content, CANDIDATE_CLIP), recorded_at: src.recordedAt ?? null },
      candidates: candidates.map(c => ({ content: clip(c.content, CANDIDATE_CLIP), recorded_at: c.recordedAt ?? null })),
    },
    questions,
    { ...context, surface: 'relations', riders: askSupersession ? ['supersession'] : undefined },
  );
  if (!answers) return null;
  const verdicts = new Map<string, RelationJudgment>();
  candidates.forEach((candidate, i) => {
    const relation = readChoice(answers[`relation_${i}`]);
    if (!relation) return;
    const contradiction = readNoul(answers[`contradiction_${i}`]);
    verdicts.set(candidate.id, {
      relation: mapRelation(relation.choice, relation.confidence, contradiction, thresholds),
      confidence: relation.confidence,
      contradiction,
      supersedes: askSupersession ? readNoul(answers[`supersedes_${i}`]) : null,
    });
  });
  return verdicts;
}

/**
 * "Is the later record a newer statement of the same single thing?" Only the
 * dates decide direction; the caller writes `supersedes` from newer to older.
 * Recurring activities are the trap: a Tuesday log does not replace Monday's.
 */
const supersessionQuestion = (i: number) => noul(
  `\`memory\` and \`candidates[${i}]\` are two records from the same project and category, each dated by its \`recorded_at\`. ` +
  'Is the later-dated of the two a newer statement of the same single thing the earlier one describes — the same setting, value, rule, ' +
  'decision, status or design, since changed — so that the earlier record no longer describes how things are now?',
  {
    true: 'The later record replaces the earlier one: same subject, its value or state has changed since, and keeping the earlier one as current would mislead.',
    false: 'Both stay true: different things, separate occurrences of a recurring activity on different dates, the later one only adds detail, or both state the same fact.',
  },
);

/**
 * Map a judgment onto a stored relation.
 *
 * `duplicate_of` suppresses a memory in the interface, so it needs agreement
 * from a confident Choice. A conflict flag needs the contradiction Noul to
 * agree as well — the two questions are answered independently, so requiring
 * both is a real check rather than asking the same thing twice.
 */
export function mapRelation(label: string, confidence: number, contradiction: number | null, thresholds: RelationThresholds = DEFAULT_RELATION_THRESHOLDS): JudgedRelation {
  if (label === 'unrelated') return null;
  if (label === 'duplicate') return confidence >= thresholds.duplicate ? 'duplicate_of' : 'similar';
  if (label === 'conflicting') return contradiction === null || contradiction >= thresholds.contradiction ? 'possible_conflict' : 'similar';
  return 'similar';
}

// --- Recall (Surface C) ---

/**
 * Is the caller asking about prior/superseded state?
 *
 * Replaces `/history|histor|previous|old|antes|anterior/i`, which only ever
 * spoke English and Portuguese — every other language silently lost its
 * superseded results.
 */
export async function judgeHistoricalQuery(query: string, options: JudgeContext = {}): Promise<boolean | null> {
  const answers = await judge(
    { query },
    {
      historical: noul(
        'Is `query` asking about the past — what something used to be, how it changed, or an ' +
        'earlier version — rather than asking only for the current state of things?',
        {
          true: 'Asks for history, prior versions, what changed, or what a thing was before.',
          false: 'Asks only what is true now.',
        },
      ),
    },
    // Recall is on the hot path; a slow judgment is worth less than the
    // existing fusion ordering shipped on time. The budget is the surface's
    // timeout (1200 ms by default) so the settings page can tune it.
    { ...options, surface: 'historical-query' },
  );
  const value = readNoul(answers?.historical);
  return value === null ? null : value >= 0.5;
}

/** Ordered rubric for "how much does this record help answer the query". */
export const RELEVANCE_LEVELS = [
  'Irrelevant: shares only vocabulary or topic area, and does not help answer the query.',
  'Tangential: the same general subject, but it does not address what was actually asked.',
  'Background: useful supporting context that makes the answer easier to act on.',
  'Direct: addresses the specific thing the query asks about.',
  'Decisive: contains the answer itself, or the constraint that determines it.',
];

/**
 * Relevance budgets. A 16k-character task prompt plus ten whole memories was
 * 6–17k tokens of state and timed out inside a 1.5 s hook budget. Callers send
 * an excerpt centred on the query terms (what would be injected, plus nearby
 * context); these clips are the safety net. The query is cut, not the search:
 * retrieval still used all of it.
 */
export const RELEVANCE_QUERY_CLIP = 2_000;
export const RELEVANCE_CANDIDATE_CLIP = 1_000;

/**
 * Score each retrieved candidate against the query, in one request.
 *
 * Runs after fusion, never instead of it: fusion decides what is retrievable,
 * this decides what leads. Returns null on any failure so the caller ships the
 * fusion order untouched. A single candidate is judged only when the caller
 * will act on its score alone (`single`: a relevance floor).
 */
export async function judgeRelevance(
  query: string,
  candidates: { id: string; content: string }[],
  options: JudgeContext & { surface?: 'rerank' | 'brief-rank'; single?: boolean } = {},
): Promise<Map<string, number> | null> {
  const { surface = 'rerank', single = false, ...context } = options;
  if (candidates.length < (single ? 1 : 2)) return new Map();
  const questions: Record<string, ReturnType<typeof score>> = {};
  candidates.forEach((_, i) => {
    questions[`relevance_${i}`] = score(
      `How much does \`candidates[${i}].content\` help answer \`query\`?`,
      RELEVANCE_LEVELS,
    );
  });
  const answers = await judge(
    { query: clip(query, RELEVANCE_QUERY_CLIP), candidates: candidates.map(c => ({ content: clip(c.content, RELEVANCE_CANDIDATE_CLIP) })) },
    questions,
    { ...context, surface },
  );
  if (!answers) return null;
  const scores = new Map<string, number>();
  candidates.forEach((candidate, i) => {
    const relevance = readScore(answers[`relevance_${i}`]);
    if (relevance) scores.set(candidate.id, relevance.score);
  });
  return scores.size ? scores : null;
}

/**
 * Reorder by judged relevance, moving only judged items: they are re-sorted
 * among the positions judged items already hold, and every unjudged item keeps
 * its fusion position. Ties keep fusion order (the sort is stable).
 */
export function orderByJudgedScore<T extends { id: string }>(items: T[], scores: Map<string, number>): T[] {
  const slots: number[] = [];
  items.forEach((item, i) => { if (scores.has(item.id)) slots.push(i); });
  const judged = slots.map(i => items[i]).sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
  const out = [...items];
  slots.forEach((slot, k) => { out[slot] = judged[k]; });
  return out;
}

/** The rubric label nearest a fractional relevance score ("Direct", "Tangential"…). */
export function relevanceLevel(value: number): string {
  const index = Math.max(0, Math.min(RELEVANCE_LEVELS.length - 1, Math.round(value)));
  return RELEVANCE_LEVELS[index].split(':')[0];
}

// --- Hooks (Surface D) ---

export type RecallUrgency = 'must' | 'should' | 'consider' | 'skip';

const RECALL_OPTIONS = {
  must: 'Asks directly about past work, a prior decision, or something "we" already did or discussed.',
  should: 'Continues existing project work where earlier context would likely change the answer.',
  consider: 'A new task in a known project; prior context might help but the request stands alone.',
  skip: 'Self-contained — a greeting, a one-off question, or a fully specified instruction needing no history.',
};

export interface PromptJudgment { urgency: RecallUrgency; confidence: number }

const urgencyQuestion = () => choice(
  'A developer sent `prompt` to an AI assistant that has a persistent memory of their past work. ' +
  'How much would searching that memory before answering change the quality of the reply? ' +
  'Judge the intent in any language.',
  RECALL_OPTIONS,
);

/** Replaces the Tier1/Tier2/Tier3 regex ladder plus the non-Latin character ratio test. */
export async function judgePrompt(prompt: string, project?: string, options: JudgeContext = {}): Promise<PromptJudgment | null> {
  const answers = await judge(
    { prompt, project: project ?? null },
    { urgency: urgencyQuestion() },
    { ...options, surface: 'prompt-urgency' },
  );
  const urgency = readChoice(answers?.urgency);
  if (!urgency || !(urgency.choice in RECALL_OPTIONS)) return null;
  return { urgency: urgency.choice as RecallUrgency, confidence: urgency.confidence };
}

export interface PromptTurnAsk { urgency: boolean; newTask: boolean; pastSession: boolean; revealsPreference: boolean }
export interface PromptTurnInput {
  prompt: string; project?: string;
  /** Edits made for earlier requests and not yet stored in memory; only read when `newTask` is asked. */
  unsavedWork?: { previousPrompt?: string | null; files?: string[]; editCount?: number } | null;
}
export interface PromptTurnJudgment {
  urgency?: RecallUrgency; confidence?: number;
  /** P(yes) per rider; absent when not asked or not answered. */
  newTask?: number; pastSession?: number; revealsPreference?: number;
}

const PROMPT_TURN_CLIP = 6_000;

/**
 * Everything the prompt hook wants to know about a new prompt, in one request.
 * Urgency leads; the riders (task boundary, session lookup, user learning) ride
 * along only when asked, and their answers cannot see each other's. Asking for
 * urgency alone sends exactly what `judgePrompt` sends, so the cache and the
 * calibration it was benched on survive. `unsaved_work` joins the state only
 * when the task-boundary question needs it.
 */
export async function judgePromptTurn(input: PromptTurnInput, ask: PromptTurnAsk, options: JudgeContext = {}): Promise<PromptTurnJudgment | null> {
  const riders = ([['task-boundary', ask.newTask], ['session-lookup', ask.pastSession], ['user-learning', ask.revealsPreference]] as const)
    .filter(([, on]) => on).map(([name]) => name as string);
  if (!ask.urgency && !riders.length) return null;
  if (ask.urgency && !riders.length) {
    const verdict = await judgePrompt(input.prompt, input.project, options);
    return verdict ? { urgency: verdict.urgency, confidence: verdict.confidence } : null;
  }
  const state: Record<string, unknown> = { prompt: clip(input.prompt, PROMPT_TURN_CLIP), project: input.project ?? null };
  if (ask.newTask && input.unsavedWork) {
    state.unsaved_work = {
      previous_prompt: input.unsavedWork.previousPrompt ? clip(input.unsavedWork.previousPrompt, 2000) : null,
      files_edited: (input.unsavedWork.files ?? []).slice(0, 10),
      edit_count: input.unsavedWork.editCount ?? 0,
    };
  }
  const questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> = {};
  if (ask.urgency) questions.urgency = urgencyQuestion();
  if (ask.newTask) {
    questions.new_task = noul(
      '`prompt` is the developer\'s newest message. `unsaved_work` describes changes the assistant made for earlier requests that are not yet recorded in memory: ' +
      'the files it edited and, in `unsaved_work.previous_prompt`, the request that started them. Does `prompt` begin a different task instead of continuing that work?',
      {
        true: 'A different task: a new feature, bug, question or area of the code, or the developer says the earlier work is done or dropped.',
        false: 'The same work continues: a follow-up, a correction, a review, a test, a question about those edits or their result, or approval to go on.',
      },
    );
  }
  if (ask.pastSession) {
    questions.past_session = noul(
      'Does `prompt` ask about an earlier session or conversation with the assistant — what was said, decided or done then, or where that work was left — ' +
      'so that answering needs the record of that past session rather than the current code or this conversation?',
      {
        true: 'It points back to a previous session: "what did we decide yesterday", "continue where we left off", "find the chat where we fixed the login bug".',
        false: 'It concerns the code, the project or the current conversation; a mention of time or history on its own does not count.',
      },
    );
  }
  if (ask.revealsPreference) {
    questions.reveals_preference = noul(
      'Does `prompt` show how this developer wants the assistant to work in general — a correction of its approach, a standing instruction, ' +
      'or a preference about style, tools, communication or workflow that should still apply after this request?',
      {
        true: 'A lasting preference or rule: "always run the tests before committing", "stop adding comments", "answer in Portuguese", "don\'t touch the dist folder", or frustration with a habit of the assistant.',
        false: 'Only this request\'s content, or a preference that applies to this one task alone.',
      },
    );
  }
  // The lead is the request's owner: its switch and timeout govern the call.
  const lead = ask.urgency ? 'prompt-urgency' : riders[0];
  const answers = await judge(state, questions, { ...options, surface: lead, riders: riders.filter(r => r !== lead) });
  if (!answers) return null;
  const out: PromptTurnJudgment = {};
  const urgency = readChoice(answers.urgency);
  if (urgency && urgency.choice in RECALL_OPTIONS) { out.urgency = urgency.choice as RecallUrgency; out.confidence = urgency.confidence; }
  const newTask = readNoul(answers.new_task), pastSession = readNoul(answers.past_session), preference = readNoul(answers.reveals_preference);
  if (newTask !== null) out.newTask = newTask;
  if (pastSession !== null) out.pastSession = pastSession;
  if (preference !== null) out.revealsPreference = preference;
  return Object.keys(out).length ? out : null;
}

export interface BlockedJudgment { humanBlocker: boolean; waitingForUser: boolean }

/**
 * Two independent reads of the agent's last message, batched over one state.
 * Replaces two near-identical substring lists in stop.mjs.
 */
export async function judgeAgentMessage(message: string): Promise<BlockedJudgment | null> {
  const answers: Answers | null = await judge(
    { agent_message: message },
    {
      human_blocker: noul(
        'Has the assistant stopped because a person must act in a browser before it can continue — ' +
        'signing in, solving a CAPTCHA, or entering a verification code?',
        {
          true: 'It is blocked on a credential or challenge only a human can supply.',
          false: 'It finished, or it is blocked on something else entirely.',
        },
      ),
      waiting_for_user: noul(
        'Is the assistant waiting on any user action at all before it can continue — a file, a choice, ' +
        'a confirmation, or a credential?',
        {
          true: 'It asked for something and cannot usefully proceed until it arrives.',
          false: 'It completed its work or is reporting a result.',
        },
      ),
    },
    { surface: 'agent-message' },
  );
  if (!answers) return null;
  const blocker = readNoul(answers.human_blocker);
  const waiting = readNoul(answers.waiting_for_user);
  if (blocker === null && waiting === null) return null;
  return { humanBlocker: (blocker ?? 0) >= 0.5, waitingForUser: (waiting ?? 0) >= 0.5 };
}

// --- Write-time gates (Surface E) ---

/**
 * Is a new memory the same fact as one already stored? One Noul per
 * candidate over shared state. Returns P(duplicate) per candidate id, or
 * null when unavailable — the caller then stores the memory as before and
 * maintenance relates duplicates later.
 */
export async function judgeDuplicates(
  content: string,
  candidates: { id: string; content: string; recordedAt?: string }[],
  options: JudgeContext = {},
): Promise<Map<string, number> | null> {
  if (!candidates.length) return new Map();
  const questions: Record<string, ReturnType<typeof noul>> = {};
  candidates.forEach((_, i) => {
    questions[`duplicate_${i}`] = noul(
      `Would storing \`memory.content\` beside \`candidates[${i}].content\` add nothing, because both state the same fact about the same single occurrence?`,
      {
        true: 'Same fact, same occurrence: keeping both duplicates information. Wording, order or level of detail may differ.',
        false: 'They differ in substance: a separate occurrence of a recurring activity (another date or run), an update that changes or supersedes the older record, additional findings, or a different subject.',
      },
    );
  });
  const answers = await judge(
    {
      memory: { content: clip(content, 6000), recorded_at: new Date().toISOString() },
      candidates: candidates.map(c => ({ content: clip(c.content, 6000), recorded_at: c.recordedAt ?? null })),
    },
    questions,
    { ...options, surface: 'duplicate-gate' },
  );
  if (!answers) return null;
  const verdicts = new Map<string, number>();
  candidates.forEach((candidate, i) => {
    const p = readNoul(answers[`duplicate_${i}`]);
    if (p !== null) verdicts.set(candidate.id, p);
  });
  return verdicts;
}

/**
 * Keep a secret's shape without disclosing it: the first four and last two
 * characters, bullets for the middle, and the true length. Short values keep
 * only two characters.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}${'•'.repeat(Math.max(1, value.length - 2))} (${value.length} chars)`;
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(12, value.length - 6))}${value.slice(-2)} (${value.length} chars)`;
}

/**
 * Are credential-looking spans real secrets? The regex prefilter decides
 * what to ask about; this decides whether each span is a live credential or
 * a placeholder, an example, a hash or an identifier. Returns P(secret) per
 * span index (same order as `spans`), or null.
 */
export async function judgeSecretSpans(
  text: string,
  spans: { value: string; type: string }[],
  options: JudgeContext = {},
): Promise<(number | null)[] | null> {
  if (!spans.length) return [];
  // The gate exists to keep secrets out of storage; shipping them to a third
  // party to ask whether they are secrets would defeat it. Every candidate is
  // masked before it leaves the machine, both as a span and inside the text.
  // The judgment works from shape and context: prefix, length, surroundings.
  const masked = spans.map(s => maskSecret(s.value));
  let safeText = text;
  spans.forEach((s, i) => { if (s.value) safeText = safeText.split(s.value).join(masked[i]); });
  const questions: Record<string, ReturnType<typeof noul>> = {};
  spans.forEach((_, i) => {
    questions[`secret_${i}`] = noul(
      `Is \`spans[${i}].value\`, as it appears in \`text\`, a real credential that would grant access if used — rather than a placeholder, an example, a variable name, a hash, or an identifier? ` +
      'Every value is partially masked on purpose (bullets replace its middle); judge from the visible prefix and suffix, the stated length, and the surrounding text.',
      {
        true: 'A real secret: an API key, access token, password or private key that is or was valid for some service.',
        false: 'Not a secret in effect: a placeholder such as sk-xxxx or YOUR_KEY_HERE, a documentation example, an ID or checksum, a variable name, or a note about where a secret is kept.',
      },
    );
  });
  const answers = await judge(
    { text: clip(safeText, 8000), spans: spans.map((s, i) => ({ value: masked[i], looks_like: s.type })) },
    questions,
    { ...options, surface: 'secret-gate' },
  );
  if (!answers) return null;
  return spans.map((_, i) => readNoul(answers[`secret_${i}`]));
}

export interface CategoryJudgment { category: string; confidence: number; probabilities?: Record<string, number> }

/**
 * Which category's description fits the content? A Choice over the live
 * leaf categories plus a no-match option. The caller's pick is in the state
 * so the model can weigh it, and in the options so it can be confirmed.
 * Recorded and reported, never applied: the writer keeps the final say.
 */
export async function judgeCategory(
  content: string,
  filedUnder: string,
  categories: Record<string, string | null>,
  options: JudgeContext = {},
): Promise<CategoryJudgment | null> {
  const names = Object.keys(categories);
  if (names.length < 2) return null;
  const answers = await judge(
    { memory_text: clip(content, 6000), filed_under: filedUnder },
    {
      category: choice(
        'Which category best fits `memory_text`? Judge the content against each category\'s stated purpose. `filed_under` is where the writer put it; it may be right or wrong.',
        { ...categories, 'none-of-these': 'No listed category describes this record.' },
      ),
    },
    { ...options, surface: 'category-check' },
  );
  const verdict = readChoice(answers?.category);
  if (!verdict) return null;
  const answer = answers!.category;
  return { category: verdict.choice, confidence: verdict.confidence, probabilities: answer.type === 'choice' ? answer.probabilities : undefined };
}

// --- Sync (Surface F) ---

/**
 * Does a memory still describe a file that changed? The checksum only says
 * the bytes moved; this says whether what the memory claims moved with them.
 * Returns P(still accurate), or null.
 */
export async function judgeStaleMemory(
  memory: string,
  file: { path: string; excerpt: string; truncated: boolean },
  options: JudgeContext & { surface?: 'stale-check' | 'edit-stale' } = {},
): Promise<number | null> {
  const { surface = 'stale-check', ...context } = options;
  const answers = await judge(
    { memory: { content: clip(memory, 6000) }, file: { path: file.path, current_content: clip(file.excerpt, 8000), truncated: file.truncated } },
    {
      accurate: noul(
        'Does `memory.content` still accurately describe `file.current_content` as it is now?',
        {
          true: 'Still accurate: the file changed in ways that do not contradict the memory, or the memory describes something the file still does.',
          false: 'Stale: the memory names code, paths, values, behaviour or structure that the current file no longer matches.',
        },
      ),
    },
    { ...context, surface },
  );
  return readNoul(answers?.accurate);
}

// --- Hooks, continued (Surface G) ---

export interface StopTurnJudgment {
  humanBlocker?: boolean; waitingForUser?: boolean; worthRemembering?: boolean; worthProbability?: number;
  /** P(the final message claims success the turn's own output does not show); absent unless asked. */
  claimProbability?: number;
}

export interface TurnCommand { command: string; exit?: string | null; output_tail?: string | null }
export interface TurnToolResult { tool: string; is_error?: boolean; tail?: string | null }

/**
 * "Does the final message claim a success the turn's own output does not
 * show?" over `assistant_message`, `bash_commands` and `tool_results`. Shared
 * by the Stop hook (claim-check) and the Assistant's workers (worker-claim), so
 * the P ≥ 0.9 calibration carries over. Keep the wording stable.
 */
export function unsupportedClaimQuestion() {
  return noul(
    '`assistant_message` is the assistant\'s report at the end of a turn; `bash_commands` and `tool_results` are what actually ran in that turn, with the end of each output. ' +
    'Does `assistant_message` state that something was verified, fixed, passing or working — tests pass, the build succeeds, the bug no longer happens — ' +
    'when nothing in `bash_commands` or `tool_results` shows it, or the output shown contradicts it?',
    {
      true: 'At least one success claim is unsupported: no command or tool result in this turn demonstrates it, or an exit code or error in the output contradicts it.',
      false: 'Every success it claims is shown by a command or tool result here, it clearly marks things as untested or expected, or it makes no such claim.',
    },
  );
}

/**
 * Everything the Stop hook wants to know about a finished turn, in one
 * request: is the agent blocked on a person, is it waiting on the user, did
 * the turn produce work worth remembering, and does the final message claim
 * more than the turn showed. The surfaces are toggled independently, so only
 * the enabled questions are asked; the batch is logged under the first of
 * agent-message, turn-worth, claim-check that is on, with the rest as riders.
 * What ran (commands, tool results) joins the shared state whenever the hook
 * sends it: the claim question needs it as evidence, and the worth question
 * needs it to see work that went through Bash instead of Edit/Write. A hook
 * that sends neither gets exactly the state it always sent.
 */
export async function judgeStopTurn(
  input: { message: string; filesEdited?: string[]; editCount?: number; commands?: TurnCommand[]; toolResults?: TurnToolResult[] },
  ask: { agentMessage: boolean; turnWorth: boolean; claimCheck?: boolean },
  options: JudgeContext & { worthThreshold?: number } = {},
): Promise<StopTurnJudgment | null> {
  if (!ask.agentMessage && !ask.turnWorth && !ask.claimCheck) return null;
  const questions: Record<string, ReturnType<typeof noul>> = {};
  if (ask.agentMessage) {
    questions.human_blocker = noul(
      'Has the assistant stopped because a person must act in a browser before it can continue — signing in, solving a CAPTCHA, or entering a verification code? Judge `assistant_message`.',
      { true: 'It is blocked on a credential or challenge only a human can supply.', false: 'It finished, or it is blocked on something else entirely.' },
    );
    questions.waiting_for_user = noul(
      'Is the assistant waiting on any user action at all before it can continue — a file, a choice, a confirmation, or a credential? Judge `assistant_message`.',
      { true: 'It asked for something and cannot usefully proceed until it arrives.', false: 'It completed its work or is reporting a result.' },
    );
  }
  const ran = Boolean(input.commands?.length || input.toolResults?.length);
  if (ask.turnWorth) {
    questions.worth_remembering = noul(
      ran
        ? 'Did this turn produce work a future session would need to know about — a fix, a decision, a configuration change, or a non-obvious finding — judging from `assistant_message`, `files_edited`, `edit_count` and the commands in `bash_commands`?'
        : 'Did this turn produce work a future session would need to know about — a fix, a decision, a configuration change, or a non-obvious finding — judging from `assistant_message`, `files_edited` and `edit_count`?',
      {
        true: 'Meaningful work: code or configuration changed in a way that matters, a bug was fixed, a decision was made, or a finding was reached that would save time later.',
        false: 'Trivial or incomplete: a typo or formatting change, a scratch or temporary file, an experiment that was reverted, or nothing was actually finished.',
      },
    );
  }
  if (ask.claimCheck) questions.unsupported_claim = unsupportedClaimQuestion();
  const { worthThreshold = 0.35, ...context } = options;
  const state: Record<string, unknown> = { assistant_message: clip(input.message, 6000), files_edited: (input.filesEdited ?? []).slice(0, 20), edit_count: input.editCount ?? 0 };
  if (ran || ask.claimCheck) {
    state.bash_commands = (input.commands ?? []).slice(-8).map(c => ({ command: clip(String(c.command ?? ''), 300), exit: c.exit ?? null, output_tail: c.output_tail ? String(c.output_tail).slice(-500) : null }));
    state.tool_results = (input.toolResults ?? []).slice(-6).map(t => ({ tool: String(t.tool ?? ''), is_error: Boolean(t.is_error), tail: t.tail ? String(t.tail).slice(-500) : null }));
  }
  const order = [['agent-message', ask.agentMessage], ['turn-worth', ask.turnWorth], ['claim-check', !!ask.claimCheck]] as const;
  const asked = order.filter(([, on]) => on).map(([name]) => name as string);
  const answers = await judge(state, questions, { ...context, surface: asked[0], riders: asked.slice(1) });
  if (!answers) return null;
  const out: StopTurnJudgment = {};
  const blocker = readNoul(answers.human_blocker), waiting = readNoul(answers.waiting_for_user), worth = readNoul(answers.worth_remembering);
  const claim = readNoul(answers.unsupported_claim);
  if (blocker !== null) out.humanBlocker = blocker >= 0.5;
  if (waiting !== null) out.waitingForUser = waiting >= 0.5;
  if (worth !== null) { out.worthRemembering = worth >= worthThreshold; out.worthProbability = worth; }
  if (claim !== null) out.claimProbability = claim;
  return Object.keys(out).length ? out : null;
}

export interface LoopGoalInput {
  task: string; context?: string | null;
  journal?: { iteration?: number; summary?: string }[]; progressSummary?: string | null;
  lastMessage: string; iteration: number; total: number;
}

/**
 * Is a loop's stated task finished? Replaces "run until the iteration budget
 * is spent". Returns P(goal met), or null; the caller applies its threshold
 * and keeps the budget as the fallback.
 */
export async function judgeLoopGoal(input: LoopGoalInput, options: JudgeContext = {}): Promise<number | null> {
  if (!input.task?.trim()) return null;
  const answers = await judge(
    {
      task: clip(input.task, 4000), context: input.context ? clip(input.context, 2000) : null,
      iterations_done: input.iteration, iterations_total: input.total,
      journal: (input.journal ?? []).slice(-5).map(j => ({ iteration: j.iteration ?? null, summary: clip(String(j.summary ?? ''), 800) })),
      progress_summary: input.progressSummary ? clip(input.progressSummary, 2000) : null,
      last_message: clip(input.lastMessage, 4000),
    },
    {
      goal_met: noul(
        'Has `task` been fully accomplished — judging from `last_message`, the final reply of iteration `iterations_done` of `iterations_total`, and from `journal` and `progress_summary` when they are present — so that running another iteration would add nothing?',
        {
          true: 'Done: every part of the task is complete or explicitly exhausted — nothing left to post, process, check or fix.',
          false: 'Not done: work remains, the last iteration hit an error or a blocker, or the task is open-ended and each iteration still produces new results.',
        },
      ),
    },
    { ...options, surface: 'loop-goal' },
  );
  return readNoul(answers?.goal_met);
}

// --- Compaction and plans (Surface I) ---

export const DIGEST_LABELS = {
  goal: 'The developer states what they want: the task, a requirement, a constraint or how success will be judged.',
  decision: 'A choice is made or confirmed: an approach, a design, a tool, a rule, or an option rejected and why.',
  finding: 'Something is learned: a root cause, a measurement, how some code or system actually behaves, an error explained.',
  open_issue: 'Something is left unresolved: a failing check, a known bug, a TODO, or a question still waiting for an answer.',
  routine: 'Nothing a later session needs: progress narration, acknowledgements, tool chatter or pleasantries.',
} as const;
export type DigestLabel = keyof typeof DIGEST_LABELS;

export interface DigestMessage { i: number; role: 'user' | 'assistant'; text: string }
export interface DigestVerdict { i: number; label: DigestLabel; confidence: number }

const DIGEST_BATCH = 20;
const DIGEST_TEXT_CLIP = 700;

/**
 * Label each message of a session about to be compacted, so the compaction
 * memory keeps the goals, decisions, findings and open issues instead of
 * whatever happened to come first. Batches of 20 run in parallel; a failed
 * batch loses only its own labels. Returns null when nothing was labelled.
 */
export async function judgeCompactDigest(messages: DigestMessage[], context: { goal?: string | null }, options: JudgeContext & { maxItems?: number } = {}): Promise<DigestVerdict[] | null> {
  const { maxItems = 40, ...rest } = options;
  const items = messages.slice(0, Math.max(1, maxItems));
  if (!items.length) return [];
  const batches: DigestMessage[][] = [];
  for (let k = 0; k < items.length; k += DIGEST_BATCH) batches.push(items.slice(k, k + DIGEST_BATCH));
  const results = await Promise.all(batches.map(async batch => {
    const questions: Record<string, ReturnType<typeof choice>> = {};
    batch.forEach((_, i) => {
      questions[`label_${i}`] = choice(
        `\`messages[${i}]\` is one message from a coding session between a developer (\`role\` user) and an AI assistant (\`role\` assistant); ` +
        '`session_goal` is the developer\'s opening request. Which kind of information in `messages[' + i + ']` would a later session, ' +
        'starting after this conversation is compacted, most need to keep?',
        DIGEST_LABELS as unknown as Record<string, string>,
      );
    });
    const answers = await judge(
      { session_goal: context.goal ? clip(context.goal, 1000) : null, messages: batch.map(m => ({ role: m.role, text: clip(m.text, DIGEST_TEXT_CLIP) })) },
      questions,
      { ...rest, surface: 'compact-digest' },
    );
    if (!answers) return [] as DigestVerdict[];
    const out: DigestVerdict[] = [];
    batch.forEach((message, i) => {
      const verdict = readChoice(answers[`label_${i}`]);
      if (verdict && verdict.choice in DIGEST_LABELS) out.push({ i: message.i, label: verdict.choice as DigestLabel, confidence: verdict.confidence });
    });
    return out;
  }));
  const verdicts = results.flat();
  return verdicts.length ? verdicts : null;
}

export interface PlanDecision { id: string; content: string; recordedAt?: string | null; kind?: string | null }

/**
 * Would carrying out an approved plan go against something already decided?
 * One Noul per stored decision or preference over shared state. Returns
 * P(conflict) per decision id, or null. Advisory: the hook only reports it.
 */
export async function judgePlanConflicts(plan: string, decisions: PlanDecision[], options: JudgeContext = {}): Promise<Map<string, number> | null> {
  if (!decisions.length) return new Map();
  const questions: Record<string, ReturnType<typeof noul>> = {};
  decisions.forEach((_, i) => {
    questions[`conflict_${i}`] = noul(
      `\`plan\` is what an AI assistant is about to implement in this project. \`decisions[${i}]\` is something recorded earlier in the same project: ` +
      `a decision that was made or a preference the developer stated. Would carrying out \`plan\` as written go against \`decisions[${i}].content\` — ` +
      'doing what it ruled out, choosing an option it rejected, or undoing what it chose?',
      {
        true: 'Following the plan breaks or reverses the recorded decision or preference.',
        false: 'The plan agrees with it, builds on it, concerns something else, or explicitly says it is replacing that decision on purpose.',
      },
    );
  });
  const answers = await judge(
    { plan: clip(plan, 8000), decisions: decisions.map(d => ({ content: clip(d.content, 1500), recorded_at: d.recordedAt ?? null, kind: d.kind ?? null })) },
    questions,
    { ...options, surface: 'plan-conflict' },
  );
  if (!answers) return null;
  const out = new Map<string, number>();
  decisions.forEach((decision, i) => {
    const p = readNoul(answers[`conflict_${i}`]);
    if (p !== null) out.set(decision.id, p);
  });
  return out;
}

// --- Trash triage (Surface H) ---

/** Ordered rubric for "how much would be lost if this memory were deleted", least loss last. */
export const EXPENDABILITY_LEVELS = [
  'Irreplaceable: a decision, a credential location, a hard-won lesson or a project fact recorded nowhere else.',
  'Valuable: useful reference that would take real effort to rediscover.',
  'Marginal: mildly useful; losing it would cost a little at most.',
  'Redundant: the same information exists in another memory, in the code, or in documentation.',
  'Expendable: obsolete, a passing note, or an automation log nobody would look for again.',
];

export interface ExpendabilityCandidate {
  id: string; content: string; category: string; importance: number; createdAt: string; accessCount: number; duplicateOf?: string | null;
}

const expendabilityQuestion = (i: number) =>
  `How expendable is \`candidates[${i}]\`: how much would be lost if it were deleted from this knowledge base? Weigh its content, whether \`candidates[${i}].duplicate_of_another\` names a surviving copy, and how often it has been recalled.`;
const expendabilityEntry = (c: ExpendabilityCandidate) =>
  ({ content: clip(c.content, 3000), category: c.category, importance: c.importance, created_at: c.createdAt, times_recalled: c.accessCount, duplicate_of_another: c.duplicateOf ?? null });

/**
 * Fingerprint of everything one expendability judgment sees — model, rubric,
 * question and the candidate's own entry — so a stored score stays usable
 * exactly as long as asking again would send the same thing.
 */
export function expendabilityBasis(candidate: ExpendabilityCandidate, model: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ model, levels: EXPENDABILITY_LEVELS, question: expendabilityQuestion(0), entry: expendabilityEntry(candidate) }))
    .digest('hex').slice(0, 16);
}

/**
 * Score each forget candidate on the expendability rubric, batched over
 * one state. Higher = safer to delete. Never deletes anything itself.
 */
export async function judgeExpendability(candidates: ExpendabilityCandidate[], options: JudgeContext = {}): Promise<Map<string, number> | null> {
  if (!candidates.length) return new Map();
  const questions: Record<string, ReturnType<typeof score>> = {};
  candidates.forEach((_, i) => {
    questions[`expendability_${i}`] = score(expendabilityQuestion(i), EXPENDABILITY_LEVELS);
  });
  const answers = await judge(
    { candidates: candidates.map(c => expendabilityEntry(c)) },
    questions,
    { ...options, surface: 'trash-triage' },
  );
  if (!answers) return null;
  const scores = new Map<string, number>();
  candidates.forEach((candidate, i) => {
    const s = readScore(answers[`expendability_${i}`]);
    if (s) scores.set(candidate.id, s.score);
  });
  return scores.size ? scores : null;
}
