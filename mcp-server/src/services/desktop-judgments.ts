/**
 * Desktop judgments: what Jev is asked about the controls of a Mac window for
 * a `computer_ax` intent, and the pure functions that turn its typed answers
 * into advice and into press eligibility.
 *
 * Jev answers; it never acts. `judgeDesktopTarget` returns null whenever the
 * judgment is unavailable and the caller keeps its word-overlap ranking. The
 * wording lives in desktop-assist-gate.ts so the text asked and the text
 * hashed into the benchmark basis are one object.
 *
 * Privacy contract, enforced here as the last line before the network:
 *   - screen text only ever enters `state`, never `questions`;
 *   - Choice options are opaque ids with null descriptions, so the logged
 *     `answers.probabilities` cannot carry screen text;
 *   - each candidate is rebuilt from an allow-list of fields (id, role, kind,
 *     name, hint, group, disabled, inDialog): refs, risks, weights, frames,
 *     values, identifiers, window titles and bundle ids are left behind;
 *   - every string is credential-redacted and clipped again, whatever the
 *     Neural Interface already did;
 *   - the log preview is metadata built here, never a preview of the state.
 */

import { judge, choice, noul, readChoice, readNoul, type JudgeOptions, type Answer } from './typesafe.js';
import { cleanText, recommendTarget, type TargetVerdict, type TargetThresholds } from './browser-judgments.js';
import { DESKTOP_DEFINITIONS } from './desktop-assist-gate.js';
import { intentClass, normalizeLang, candidateViews, type DesktopCandidate, type DesktopCandidateSet, type DesktopKind } from './desktop-risk.js';

const POLICY = DESKTOP_DEFINITIONS.policy;

export type DesktopJudgeContext = Pick<JudgeOptions, 'origin' | 'entityId' | 'onUsage' | 'onLogged' | 'timeoutMs' | 'model' | 'signal' | 'sessionId' | 'project'>;
/** The browser verdict shape: `alternatives` here are every other offered id with p ≥ 0.05, most likely first (the recommendation cuts them to two). */
export type DesktopTargetVerdict = TargetVerdict;
export type DesktopThresholds = TargetThresholds;

// --- State ---

/** A candidate as the MCP layer holds it (a `DesktopCandidateView` or a bare candidate). Only the Jev-bound fields are ever sent. */
export type DesktopCandidateInput = Partial<DesktopCandidate> & { id: string; weight?: number };

export interface DesktopTargetRequest {
  intent: string;
  app: { name?: string | null; lang?: string | null };
  candidates: DesktopCandidateInput[];
  dialogOpen?: boolean;
  /** The helper or the ranking left controls out. */
  truncated?: boolean;
}

export interface DesktopTargetState {
  intent: string;
  app: { name: string; lang: string };
  dialogOpen: boolean;
  truncated: boolean;
  candidates: DesktopCandidate[];
}

const KINDS = new Set<DesktopKind>(['button', 'link', 'tab', 'disclosure', 'menu', 'field', 'toggle', 'value', 'item', 'other']);

/** Copy only what Jev may see. Anything else on the object (ref, risk, pressable, weight, line, verify…) is left behind. */
export function toDesktopCandidate(c: DesktopCandidateInput): DesktopCandidate {
  const kind = KINDS.has(c.kind as DesktopKind) ? c.kind as DesktopKind : 'other';
  const hint = cleanText(c.hint, POLICY.hintChars);
  const group = cleanText(c.group, POLICY.groupChars);
  return {
    id: String(c.id), role: cleanText(c.role, 24) || 'control', kind, name: cleanText(c.name, POLICY.nameChars),
    ...(hint ? { hint } : {}), ...(group ? { group } : {}),
    disabled: c.disabled === true, inDialog: c.inDialog === true,
  };
}

/**
 * Keep the serialized state within `stateChars`: tooltips go first, lowest
 * weight first, then whole candidates, lowest weight first. Never a blind cut
 * from the end of the reading order. Ids are kept as they are: they point at
 * the Neural Interface's entries.
 */
export function fitDesktopBudget(state: DesktopTargetState, weights: Map<string, number> = new Map()): DesktopTargetState {
  const weightOf = (c: DesktopCandidate) => weights.get(c.id) ?? 0;
  const lowestFirst = () => state.candidates.map((c, i) => ({ c, i })).sort((a, b) => weightOf(a.c) - weightOf(b.c) || b.i - a.i);
  for (let guard = 0; guard < 200 && JSON.stringify(state).length > POLICY.stateChars; guard++) {
    const withHint = lowestFirst().find(({ c }) => c.hint !== undefined);
    if (withHint) { delete withHint.c.hint; continue; }
    const drop = lowestFirst()[0];
    if (!drop) break;
    state.candidates.splice(drop.i, 1);
    state.truncated = true;
  }
  return state;
}

export function buildDesktopTargetState(request: DesktopTargetRequest): DesktopTargetState {
  const all = Array.isArray(request.candidates) ? request.candidates : [];
  const offered = all.filter(c => c && /^c\d+$/.test(String(c.id))).slice(0, POLICY.candidates);
  const candidates = offered.map(toDesktopCandidate).filter(c => c.name);
  const weights = new Map(offered.map(c => [String(c.id), Number.isFinite(Number(c.weight)) ? Number(c.weight) : 0]));
  const state: DesktopTargetState = {
    intent: cleanText(request.intent, POLICY.intentChars),
    app: { name: cleanText(request.app?.name, POLICY.appNameChars) || 'app', lang: normalizeLang(request.app?.lang).slice(0, POLICY.langChars) },
    dialogOpen: request.dialogOpen === true,
    truncated: request.truncated === true || all.length > candidates.length,
    candidates,
  };
  return fitDesktopBudget(state, weights);
}

/** `target Finder · 24 candidates · intent 26 chars · dialog open · truncated` — metadata only. */
export function desktopLogPreview(state: DesktopTargetState): string {
  return [`target ${cleanText(state.app.name, POLICY.appNameChars)}`, `${state.candidates.length} candidates`, `intent ${state.intent.length} chars`,
    state.dialogOpen ? 'dialog open' : '', state.truncated ? 'truncated' : ''].filter(Boolean).join(' · ');
}

const probabilitiesOf = (answer: Answer | undefined): Record<string, number> =>
  answer?.type === 'choice' && answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {};
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * One request: a Choice over the candidate ids plus `none`, and the Noul
 * `target_exists`. Never cached (`noCache`), logged as metadata, `origin`
 * `tool` unless the caller says otherwise (the bench says `bench`). Null when
 * there is nothing to ask, the judgment is unavailable, or the answer is not
 * one of the options.
 */
export async function judgeDesktopTarget(request: DesktopTargetRequest, options: DesktopJudgeContext = {}): Promise<DesktopTargetVerdict | null> {
  const state = buildDesktopTargetState(request);
  if (!state.candidates.length || !state.intent) return null;
  // Opaque keys, null descriptions: the option list is the same shape on every screen.
  const criteria: Record<string, string | null> = Object.fromEntries(state.candidates.map(c => [c.id, null]));
  criteria.none = DESKTOP_DEFINITIONS.target.none;
  const answers = await judge(state, {
    target: choice(DESKTOP_DEFINITIONS.target.instructions, criteria),
    target_exists: noul(DESKTOP_DEFINITIONS.targetExists.instructions, DESKTOP_DEFINITIONS.targetExists.criteria),
  }, {
    ...options, origin: options.origin ?? 'tool', surface: 'desktop-target', noCache: true, logPreview: desktopLogPreview(state),
  });
  if (!answers) return null;
  const picked = readChoice(answers.target);
  if (!picked || !own(criteria, picked.choice)) return null;
  const probabilities = probabilitiesOf(answers.target);
  const alternatives = Object.entries(probabilities)
    .filter(([id, p]) => id !== picked.choice && id !== 'none' && own(criteria, id) && Number(p) >= POLICY.minAlternativeProbability)
    .sort((a, b) => Number(b[1]) - Number(a[1])).map(([id]) => id);
  return { candidateId: picked.choice === 'none' ? null : picked.choice, confidence: picked.confidence, exists: readNoul(answers.target_exists), probabilities, alternatives };
}

// --- Advice ---

export interface DesktopRecommendation { candidateId: string | null; alternatives: string[]; reason: string | null }

/**
 * The id worth naming, and up to two alternatives. Both the Choice and the
 * existence Noul have to clear their thresholds; a payment control is never
 * named, as the pick or as an alternative, whatever the thresholds say.
 */
export function recommendDesktopTarget(verdict: DesktopTargetVerdict | null, thresholds: DesktopThresholds, candidates: Array<{ id: string; risk?: string }>): DesktopRecommendation {
  if (!verdict) return { candidateId: null, alternatives: [], reason: 'no judgment' };
  const pick = recommendTarget(verdict, thresholds);
  if (!pick) return { candidateId: null, alternatives: [], reason: verdict.candidateId ? 'the pick did not clear both thresholds' : 'no candidate clearly fits' };
  const risk = new Map(candidates.map(c => [c.id, c.risk]));
  if (!risk.has(pick)) return { candidateId: null, alternatives: [], reason: 'the pick is not among the candidates' };
  if (risk.get(pick) === 'payment') return { candidateId: null, alternatives: [], reason: 'the pick is a payment control' };
  const alternatives = verdict.alternatives
    .filter(id => id !== pick && id !== 'none' && risk.has(id) && risk.get(id) !== 'payment' && Number(verdict.probabilities[id]) >= POLICY.minAlternativeProbability)
    .slice(0, POLICY.maxAlternatives);
  return { candidateId: pick, alternatives, reason: null };
}

// --- Press eligibility ---

export interface DesktopPressCandidate { id: string; risk: string; pressable: boolean; disabled: boolean }
export interface DesktopPressRequest {
  intent: string;
  candidates: DesktopPressCandidate[];
  /** Nodes and static texts that address the agent. Anything but 0 refuses. */
  agentText: number;
  /** Anything but `false` refuses. */
  dialogOpen: boolean;
}
export type DesktopPressRefusal = 'NO_CONFIDENT_MATCH' | 'NOT_LOW_RISK';
export interface DesktopPressEligibility { eligible: boolean; candidateId: string | null; reason: string | null; code: DesktopPressRefusal | null }

/**
 * Whether Jev's pick may be pressed without asking again. The press path and
 * the benchmark call this same function, so "unsafe presses = 0" is measured
 * through the code that would press; the Neural Interface re-checks the
 * stored entry and the helper re-verifies the element anyway. Fails closed on
 * a missing flag.
 *
 * The pick itself must be pressable: asking again over only the pressable
 * subset would bias the judgment toward pressing something.
 */
export function pressEligibility(request: DesktopPressRequest, verdict: DesktopTargetVerdict | null, thresholds: DesktopThresholds): DesktopPressEligibility {
  const refuse = (candidateId: string | null, reason: string, code: DesktopPressRefusal): DesktopPressEligibility => ({ eligible: false, candidateId, reason, code });
  const candidateId = recommendTarget(verdict, thresholds);
  if (!candidateId) return refuse(null, 'no candidate cleared both thresholds', 'NO_CONFIDENT_MATCH');
  // Decided without Jev: a screen with text that addresses the agent is adversarial ground, and nothing on it is pressed.
  const agentText = Number(request.agentText);
  if (!Number.isFinite(agentText) || agentText !== 0) return refuse(candidateId, 'text on this screen addresses the agent', 'NOT_LOW_RISK');
  if (request.dialogOpen !== false) return refuse(candidateId, 'a sheet or dialog is open', 'NOT_LOW_RISK');
  const named = intentClass(request.intent);
  if (named) return refuse(candidateId, `the intent names a ${named} action`, 'NOT_LOW_RISK');
  const candidate = (Array.isArray(request.candidates) ? request.candidates : []).find(c => c.id === candidateId);
  if (!candidate) return refuse(candidateId, 'the pick is not among the candidates', 'NO_CONFIDENT_MATCH');
  if (candidate.disabled) return refuse(candidateId, 'the pick is disabled', 'NO_CONFIDENT_MATCH');
  if (candidate.risk !== 'navigation' || candidate.pressable !== true) return refuse(candidateId, `the pick is a ${candidate.risk} control`, 'NOT_LOW_RISK');
  return { eligible: true, candidateId, reason: null, code: null };
}

// --- From a candidate set ---

/** The judgment request for a candidate set (weights ride along for the budget and are never sent). */
export function desktopTargetRequest(set: DesktopCandidateSet): DesktopTargetRequest {
  return { intent: set.intent, app: set.app, dialogOpen: set.dialogOpen, truncated: set.truncated, candidates: candidateViews(set) };
}

/** The eligibility request for a candidate set. */
export function desktopPressRequest(set: DesktopCandidateSet): DesktopPressRequest {
  return { intent: set.intent, agentText: set.agentText, dialogOpen: set.dialogOpen, candidates: set.entries.map(e => ({ id: e.id, risk: e.risk, pressable: e.pressable, disabled: e.candidate.disabled })) };
}
