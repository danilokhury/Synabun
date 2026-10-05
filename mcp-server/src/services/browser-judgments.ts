/**
 * Browser judgments: what Jev is asked about a page, a set of candidate
 * controls, or a social composer, and the pure functions that turn its typed
 * answers into advice.
 *
 * Jev answers questions here; it never acts. Every function returns null when
 * the judgment is unavailable and the caller keeps its deterministic result.
 * The wording lives in browser-assist-gate.ts so the text asked and the text
 * hashed into the benchmark basis are one object.
 *
 * Privacy contract, enforced here as the last line before the network:
 *   - page text only ever enters `state`, never `questions`;
 *   - Choice options are opaque ids with null descriptions, so the logged
 *     `answers.probabilities` cannot carry page text;
 *   - selectors, hint indexes, risk, healability, fingerprints, context ids
 *     and rects are stripped from every candidate before it is sent;
 *   - every string is credential-redacted and clipped again, whatever the
 *     collector already did;
 *   - the log preview is metadata built here, never a preview of the state.
 */

import { judge, choice, noul, readChoice, readNoul, type JudgeOptions, type Answer } from './typesafe.js';
import { redactCredentials } from './typesafe-config.js';
import { BROWSER_DEFINITIONS, PAGE_STATES, SOCIAL_STATES, type PageState, type SocialState } from './browser-assist-gate.js';
import { intentVeto, lexiconClass, addressesAgent, type AssistCandidate, type TargetPhrase } from './browser-risk.js';

const POLICY = BROWSER_DEFINITIONS.policy;

export type BrowserJudgeContext = Pick<JudgeOptions, 'origin' | 'entityId' | 'onUsage' | 'timeoutMs' | 'model' | 'signal'>;

// --- Scrubbing ---

/** Redact, flatten whitespace, clip. Applied to every string on its way out. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = redactCredentials(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
const cleanList = (values: unknown, count: number, max: number): string[] =>
  (Array.isArray(values) ? values : []).map(v => cleanText(v, max)).filter(Boolean).slice(0, count);

// --- Semantic context (as returned by the Neural Interface collector) ---

export interface SemanticContext {
  page?: { title?: string; origin?: string; path?: string; lang?: string; readyState?: string };
  signals?: Record<string, unknown>;
  headings?: string[];
  alerts?: string[];
  dialogs?: Array<{ title?: string; hasEditable?: boolean; hasNonEmptyEditable?: boolean }>;
  controls?: Array<{ role?: string; name?: string }>;
}

const SIGNAL_KEYS = ['httpStatus', 'busyCount', 'progressCount', 'visibleDialogCount', 'passwordFieldCount', 'otpFieldCount', 'visibleTextLength',
  'linkCount', 'controlCount', 'articleCount', 'captchaFrame', 'paymentFrame', 'authFrame'] as const;

function pageOf(context: SemanticContext | undefined) {
  const p = context?.page ?? {};
  return { title: cleanText(p.title, 160), origin: cleanText(p.origin, 120), path: cleanText(p.path, 120), lang: cleanText(p.lang, 12) };
}

/** Numbers, booleans and null only: a signal can never smuggle a string out. */
function signalsOf(context: SemanticContext | undefined): Record<string, number | boolean | null> {
  const out: Record<string, number | boolean | null> = {};
  for (const key of SIGNAL_KEYS) {
    const value = context?.signals?.[key];
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (value === null) out[key] = null;
  }
  return out;
}

export interface PageStateRequest { operation: string; intent?: string | null; expectedSurface?: string | null }

export function buildPageState(context: SemanticContext, request: PageStateRequest) {
  const state: Record<string, unknown> = {
    operation: cleanText(request.operation, 40),
    page: { ...pageOf(context), readyState: cleanText(context.page?.readyState, 16) },
    signals: signalsOf(context),
    headings: cleanList(context.headings, 8, 120),
    alerts: cleanList(context.alerts, 3, 160),
    dialogs: (Array.isArray(context.dialogs) ? context.dialogs : []).slice(0, 3)
      .map(d => ({ title: cleanText(d?.title, 120), hasEditable: d?.hasEditable === true, hasNonEmptyEditable: d?.hasNonEmptyEditable === true })),
    controls: (Array.isArray(context.controls) ? context.controls : []).slice(0, 12)
      .map(c => ({ role: cleanText(c?.role, 24), name: cleanText(c?.name, 80) })).filter(c => c.name),
  };
  if (request.expectedSurface) state.expected_surface = cleanText(request.expectedSurface, 120);
  if (request.intent) state.intent = cleanText(request.intent, POLICY.intentChars);
  return fitBudget(state, ['controls', 'headings', 'dialogs', 'alerts']);
}

/** Drop trailing entries of the named arrays until the serialized state fits the budget. */
function fitBudget<T extends Record<string, unknown>>(state: T, arrays: string[]): T {
  for (let guard = 0; guard < 200 && JSON.stringify(state).length > POLICY.stateChars; guard++) {
    const key = arrays.find(k => Array.isArray(state[k]) && (state[k] as unknown[]).length > 0);
    if (!key) break;
    (state[key] as unknown[]).pop();
  }
  return state;
}

// --- Page state ---

export interface PageStateVerdict { state: PageState; confidence: number; probabilities: Record<string, number>; goalSatisfied: number | null }

const probabilitiesOf = (answer: Answer | undefined): Record<string, number> =>
  answer?.type === 'choice' && answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {};

function previewOf(operation: string, context: SemanticContext | undefined, extra: string[] = []): string {
  const page = pageOf(context);
  const host = page.origin.replace(/^https?:\/\//, '');
  return [`${cleanText(operation, 40)} ${host}${page.path}`.trim(), ...extra].filter(Boolean).join(' · ');
}

export async function judgePageState(context: SemanticContext, request: PageStateRequest, options: BrowserJudgeContext = {}): Promise<PageStateVerdict | null> {
  const state = buildPageState(context, request);
  const questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> = {
    page_state: choice(BROWSER_DEFINITIONS.pageState.instructions, BROWSER_DEFINITIONS.pageState.criteria),
  };
  if (state.intent) questions.goal_satisfied = noul(BROWSER_DEFINITIONS.goal.instructions, BROWSER_DEFINITIONS.goal.criteria);
  const s = state as { headings: unknown[]; alerts: unknown[]; dialogs: unknown[]; controls: unknown[]; intent?: string };
  const answers = await judge(state, questions, {
    ...options, surface: 'browser-page-state', noCache: true,
    logPreview: previewOf(request.operation, context, [`${s.headings.length} headings`, `${s.alerts.length} alerts`, `${s.dialogs.length} dialogs`, `${s.controls.length} controls`, s.intent ? `intent ${s.intent.length} chars` : '']),
  });
  if (!answers) return null;
  const picked = readChoice(answers.page_state);
  if (!picked || !(PAGE_STATES as readonly string[]).includes(picked.choice)) return null;
  return { state: picked.choice as PageState, confidence: picked.confidence, probabilities: probabilitiesOf(answers.page_state), goalSatisfied: state.intent ? readNoul(answers.goal_satisfied) : null };
}

const BLOCKERS = new Set<PageState>(['authentication_required', 'verification_required', 'consent_blocker']);
/** A person has to do something before the automation can go on. */
export function isBlocker(state: PageState): boolean { return BLOCKERS.has(state); }

const GUIDANCE: Record<PageState, string> = {
  usable: '',
  loading: 'still loading; wait, then inspect again',
  authentication_required: 'pause for human sign-in',
  verification_required: 'pause for human verification',
  consent_blocker: 'inspect the visible dialog; do not dismiss it automatically',
  error: 'report the rendered failure; reload or navigate elsewhere explicitly',
  empty: 'the page is genuinely empty',
  unknown: '',
};

export interface PageStateAdvice { state: PageState; confidence: number; confident: boolean; blocker: boolean; guidance: string; goalSatisfied: number | null; goalLikely: boolean }

/** Thresholds live here, not in the model: `unknown` and low confidence both mean "say nothing". */
export function interpretPageState(verdict: PageStateVerdict | null, thresholds: { minConfidence: number; minProbability: number }): PageStateAdvice | null {
  if (!verdict || verdict.state === 'unknown' || verdict.confidence < thresholds.minConfidence) return null;
  return {
    state: verdict.state, confidence: verdict.confidence, confident: true, blocker: isBlocker(verdict.state), guidance: GUIDANCE[verdict.state],
    goalSatisfied: verdict.goalSatisfied, goalLikely: verdict.goalSatisfied !== null && verdict.goalSatisfied >= thresholds.minProbability,
  };
}

// --- Target ---

export interface TargetCandidateState { id: string; role: string; kind?: string; inputType?: string; name: string; group?: string; hrefPath?: string; disabled: boolean; inDialog?: boolean }
export interface TargetRequest {
  action: string;
  intent: string;
  page?: SemanticContext['page'];
  candidates: Array<TargetCandidateState | AssistCandidate>;
  /** The collector or the snapshot parser saw more candidates than it could send. */
  truncated?: boolean;
  failure?: string | null;
  /** 24 for snapshot ranking, 12 for failure recovery. */
  limit?: number;
}
export interface TargetVerdict { candidateId: string | null; confidence: number; exists: number | null; probabilities: Record<string, number>; alternatives: string[] }

/** Copy only what Jev may see. Anything else on the object (selector, hintIndex, risk, healable…) is left behind. */
export function toTargetCandidate(c: TargetCandidateState | AssistCandidate): TargetCandidateState {
  const out: TargetCandidateState = { id: String(c.id), role: cleanText(c.role, 24), name: cleanText(c.name, POLICY.nameChars), disabled: c.disabled === true };
  if (c.kind) out.kind = cleanText(c.kind, 12);
  if (c.inputType) out.inputType = cleanText(c.inputType, 16);
  if (c.group) out.group = cleanText(c.group, POLICY.groupChars);
  if (c.hrefPath) out.hrefPath = cleanText(c.hrefPath, 80);
  if (c.inDialog) out.inDialog = true;
  return out;
}

export function buildTargetState(request: TargetRequest) {
  const limit = Math.max(1, Math.min(request.limit ?? POLICY.recoveryCandidates, POLICY.snapshotCandidates));
  const candidates = request.candidates.filter(c => /^c\d+$/.test(String(c.id))).slice(0, limit).map(toTargetCandidate);
  const state: Record<string, unknown> = {
    action: cleanText(request.action, 16),
    intent: cleanText(request.intent, POLICY.intentChars),
    page: pageOf({ page: request.page }),
    candidates,
    truncated: request.truncated === true || request.candidates.length > candidates.length,
  };
  if (request.failure) state.failure = cleanText(request.failure, 24);
  return fitBudget(state, ['candidates']) as typeof state & { candidates: TargetCandidateState[]; intent: string };
}

export async function judgeBrowserTarget(request: TargetRequest, options: BrowserJudgeContext = {}): Promise<TargetVerdict | null> {
  const state = buildTargetState(request);
  if (!state.candidates.length || !state.intent) return null;
  // Opaque keys, null descriptions: the option list is the same shape on every page.
  const criteria: Record<string, string | null> = Object.fromEntries(state.candidates.map(c => [c.id, null]));
  criteria.none = BROWSER_DEFINITIONS.target.none;
  const answers = await judge(state, {
    target: choice(BROWSER_DEFINITIONS.target.instructions, criteria),
    target_exists: noul(BROWSER_DEFINITIONS.targetExists.instructions, BROWSER_DEFINITIONS.targetExists.criteria),
  }, {
    ...options, surface: 'browser-target', noCache: true,
    logPreview: previewOf(`target:${request.action}`, { page: request.page }, [`${state.candidates.length} candidates`, `intent ${state.intent.length} chars`, request.failure ? `after ${cleanText(request.failure, 24)}` : '']),
  });
  if (!answers) return null;
  const picked = readChoice(answers.target);
  if (!picked || !(picked.choice in criteria)) return null;
  const probabilities = probabilitiesOf(answers.target);
  const alternatives = Object.entries(probabilities)
    .filter(([id, p]) => id !== picked.choice && id !== 'none' && id in criteria && Number(p) >= 0.05)
    .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 2).map(([id]) => id);
  return { candidateId: picked.choice === 'none' ? null : picked.choice, confidence: picked.confidence, exists: readNoul(answers.target_exists), probabilities, alternatives };
}

export interface TargetThresholds { minConfidence: number; minProbability: number }

/** The id worth recommending, or null. Both the Choice and the existence Noul have to clear their thresholds. */
export function recommendTarget(verdict: TargetVerdict | null, thresholds: TargetThresholds): string | null {
  if (!verdict || !verdict.candidateId) return null;
  if (verdict.confidence < thresholds.minConfidence) return null;
  if (verdict.exists === null || verdict.exists < thresholds.minProbability) return null;
  return verdict.candidateId;
}

export interface AutoHealRequest { action: string; candidates: AssistCandidate[]; phrase: TargetPhrase | null; selector: string | null | undefined }
export interface AutoHealEligibility { eligible: boolean; candidateId: string | null; reason: string | null }

/**
 * Whether Jev's pick may be clicked without asking again. Production and the
 * benchmark call this same function, so "unsafe selections = 0" is measured
 * through the code that would act. The server re-verifies everything anyway.
 *
 * The pick itself must be healable: asking again over only the healable
 * subset would bias the judgment toward clicking something.
 */
export function autoHealEligibility(request: AutoHealRequest, verdict: TargetVerdict | null, thresholds: TargetThresholds): AutoHealEligibility {
  const candidateId = recommendTarget(verdict, thresholds);
  if (request.action !== 'click') return { eligible: false, candidateId, reason: 'only click is ever healed' };
  if (!candidateId) return { eligible: false, candidateId: null, reason: 'no candidate cleared both thresholds' };
  // Decided without Jev: a page with a control that addresses the agent is adversarial ground, and nothing on it is healed.
  if (request.candidates.some(c => addressesAgent(c.name) || addressesAgent(c.group))) return { eligible: false, candidateId, reason: 'a candidate on this page addresses the agent' };
  const candidate = request.candidates.find(c => c.id === candidateId);
  if (!candidate) return { eligible: false, candidateId, reason: 'the pick is not among the candidates' };
  if (candidate.disabled) return { eligible: false, candidateId, reason: 'the pick is disabled' };
  if (candidate.risk !== 'navigation' || candidate.healable !== true) return { eligible: false, candidateId, reason: `the pick is a ${candidate.risk} control` };
  const veto = intentVeto(request.phrase, request.selector);
  if (veto) return { eligible: false, candidateId, reason: veto };
  return { eligible: true, candidateId, reason: null };
}

// --- Snapshot refs ---

const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox', 'option', 'treeitem', 'slider', 'spinbutton']);
const FIELD_ROLES = new Set(['combobox', 'textbox', 'searchbox', 'slider', 'spinbutton']);
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

export interface SnapshotCandidate extends TargetCandidateState { ref: string }

/**
 * Interactive refs of a delivered AI snapshot. A line is
 * `- role "name" [flag] [ref=e12]: value`; only role, name, flags and ref are
 * read. What follows the colon is the control's current value (typed text for
 * a textbox) and is never looked at; `/url:` children are skipped entirely.
 */
export function parseSnapshotCandidates(text: string, intent: string, limit: number = POLICY.snapshotCandidates): { candidates: SnapshotCandidate[]; truncated: boolean } {
  const found: Array<SnapshotCandidate & { order: number }> = [];
  const stack: Array<{ indent: number; label: string }> = [];
  const lineRe = /^(\s*)- ([A-Za-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]\n]*\])*)/;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/^[+-] (?=\s*- )/, '');
    const m = lineRe.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const role = m[2].toLowerCase();
    const name = (m[3] ?? '').replace(/\\(.)/g, '$1');
    const flags = m[4] ?? '';
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const ref = /\[ref=([^\]\s]+)\]/.exec(flags)?.[1];
    if (ref && INTERACTIVE_ROLES.has(role)) {
      const group = [...stack].reverse().find(entry => entry.label)?.label;
      found.push({
        order: found.length, ref, id: '', role, name: cleanText(name, POLICY.nameChars),
        kind: FIELD_ROLES.has(role) ? 'field' : TOGGLE_ROLES.has(role) ? 'toggle' : role === 'link' ? 'link' : 'button',
        disabled: /\[disabled\]/.test(flags), ...(group ? { group: cleanText(group, POLICY.groupChars) } : {}),
      });
    }
    // Containers give their descendants a group; editable roles never do (their name is a label, but keep the rule simple).
    stack.push({ indent, label: !INTERACTIVE_ROLES.has(role) && name ? `${role} ${name}` : '' });
  }
  let kept = found;
  if (found.length > limit) {
    const words = cleanText(intent, POLICY.intentChars).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
    const score = (c: SnapshotCandidate) => { const hay = `${c.name} ${c.group ?? ''}`.toLowerCase(); return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0); };
    kept = [...found].sort((a, b) => score(b) - score(a) || a.order - b.order).slice(0, limit).sort((a, b) => a.order - b.order);
  }
  return { candidates: kept.map(({ order: _order, ...c }, index) => ({ ...c, id: `c${index + 1}` })), truncated: found.length > kept.length };
}

// --- Social ---

/** Allow-list pick from the Facebook composer probe: booleans and enums, never the draft, the trigger text or a title. */
export function facebookProbeState(probe: unknown): Record<string, boolean | number | string | null> {
  const p = (probe && typeof probe === 'object' ? probe : {}) as Record<string, any>;
  const composers: any[] = Array.isArray(p.composers) ? p.composers : [];
  const post = composers.find(c => c?.isPostComposer && c?.visible);
  const enumOf = (value: unknown, allowed: string[]) => (typeof value === 'string' && allowed.includes(value) ? value : null);
  return {
    modalOpen: p.modal?.open === true,
    modalContainsComposer: p.modal?.containsComposer === true,
    composerCount: composers.length,
    postComposerVisible: Boolean(post),
    postComposerInDialog: post?.inDialog === true,
    postComposerHasText: typeof post?.text === 'string' && post.text.trim().length > 0,
    commentBoxVisible: composers.some(c => c?.isComment && c?.visible),
    personalProfileComposer: composers.some(c => c?.isPersonalProfile && c?.visible),
    triggerFound: p.trigger?.found === true,
    submitButtonFound: Boolean(p.submitButton),
    submitButtonEnabled: p.submitButton?.enabled === true,
    submitMatchType: enumOf(p.submitButton?.matchType, ['label', 'heuristic']),
    submissionState: enumOf(p.submission?.state, ['visible-post', 'pending-approval', 'posting-failed', 'composer-open', 'unknown']),
    recommendedAction: enumOf(p.recommendedAction, ['done', 'retry', 'submit', 'type', 'open-composer', 'unknown']),
    boostRiskPresent: p.boostRisk?.present === true,
    boostToggleOn: p.boostRisk?.boostWhenPublishedToggle?.on === true,
  };
}

/** Allow-list pick from the X compose probe: never composerText, never the quoted post. */
export function xProbeState(probe: unknown): Record<string, boolean | number | string | null> {
  const p = (probe && typeof probe === 'object' ? probe : {}) as Record<string, any>;
  const enumOf = (value: unknown, allowed: string[]) => (typeof value === 'string' && allowed.includes(value) ? value : null);
  return {
    composerOpen: p.composerOpen === true,
    hasText: Number(p.charCount) > 0,
    charCount: Number.isFinite(Number(p.charCount)) ? Math.max(0, Math.floor(Number(p.charCount))) : 0,
    overLimit: p.overLimit === true,
    quoteCardPresent: p.quoteCard?.present === true,
    quoteCardType: enumOf(p.quoteCard?.type, ['quote', 'link', 'none']),
    submitPresent: p.submitButton?.present === true,
    submitEnabled: p.submitButton?.enabled === true,
    submitTestid: enumOf(p.submitButton?.testid, ['tweetButtonInline', 'tweetButton']),
    isModal: p.isModal === true,
    composerCount: Number.isFinite(Number(p.composerCount)) ? Math.floor(Number(p.composerCount)) : 0,
    hasStaleDraft: p.hasStaleDraft === true,
    recommendedAction: enumOf(p.recommendedAction, ['open-composer', 'fix-quote-url', 'trim-text', 'type', 'submit', 'unknown']),
    warningCount: Array.isArray(p.warnings) ? p.warnings.length : 0,
  };
}

export interface SocialControl { id: string; role: string; name: string; disabled: boolean }

/**
 * The controls Jev may be offered for a composer. Paid promotion is removed by
 * vocabulary before any option exists, so a Boost button can never be picked;
 * production and the benchmark both come through here.
 */
export function offerSocialControls<T extends { id: string; name: string; risk?: string }>(candidates: T[]): T[] {
  return (Array.isArray(candidates) ? candidates : []).filter(c => c && typeof c.name === 'string' && c.risk !== 'payment' && lexiconClass(c.name) !== 'payment').slice(0, POLICY.socialCandidates);
}
export interface SocialRequest {
  platform: 'facebook' | 'x';
  probe: Record<string, boolean | number | string | null>;
  page?: SemanticContext['page'];
  signals?: SemanticContext['signals'];
  controls: SocialControl[];
  /** Which control is missing or only guessed at; null asks for the state alone. */
  seeking: 'submit' | 'trigger' | null;
}
export interface SocialVerdict { state: SocialState; confidence: number; candidateId: string | null; candidateConfidence: number | null }

export function buildSocialState(request: SocialRequest) {
  const controls = request.controls.filter(c => /^c\d+$/.test(String(c.id))).slice(0, POLICY.socialCandidates)
    .map(c => ({ id: String(c.id), role: cleanText(c.role, 24), name: cleanText(c.name, POLICY.socialNameChars), disabled: c.disabled === true })).filter(c => c.name);
  // The probe is re-filtered to scalars here too, so a caller that passes a raw probe by mistake still sends no text blob.
  const probe = Object.fromEntries(Object.entries(request.probe ?? {})
    .filter(([, v]) => typeof v === 'boolean' || typeof v === 'number' || v === null || (typeof v === 'string' && /^[a-z][a-z-]{0,23}$/i.test(v))));
  const state: Record<string, unknown> = { platform: request.platform, page: pageOf({ page: request.page }), signals: signalsOf({ signals: request.signals }), probe, controls };
  if (request.seeking) state.seeking = request.seeking;
  return fitBudget(state, ['controls']) as typeof state & { controls: typeof controls };
}

export async function judgeSocialState(request: SocialRequest, options: BrowserJudgeContext = {}): Promise<SocialVerdict | null> {
  const state = buildSocialState(request);
  const questions: Record<string, ReturnType<typeof choice>> = {
    social_state: choice(BROWSER_DEFINITIONS.socialState.instructions, BROWSER_DEFINITIONS.socialState.criteria),
  };
  const asksCandidate = Boolean(request.seeking) && state.controls.length > 0;
  let criteria: Record<string, string | null> = {};
  if (asksCandidate) {
    criteria = Object.fromEntries(state.controls.map(c => [c.id, null]));
    criteria.none = BROWSER_DEFINITIONS.socialCandidate.none;
    questions.social_candidate = choice(BROWSER_DEFINITIONS.socialCandidate.instructions, criteria);
  }
  const answers = await judge(state, questions, {
    ...options, surface: 'browser-social', noCache: true,
    logPreview: previewOf(`social:${request.platform}`, { page: request.page }, [`${state.controls.length} controls`, request.seeking ? `seeking ${request.seeking}` : '']),
  });
  if (!answers) return null;
  const picked = readChoice(answers.social_state);
  if (!picked || !(SOCIAL_STATES as readonly string[]).includes(picked.choice)) return null;
  const candidate = asksCandidate ? readChoice(answers.social_candidate) : null;
  const valid = candidate && candidate.choice in criteria ? candidate : null;
  return {
    state: picked.choice as SocialState, confidence: picked.confidence,
    candidateId: valid && valid.choice !== 'none' ? valid.choice : null,
    candidateConfidence: valid ? valid.confidence : null,
  };
}
