/**
 * Browser assistance as the tool handlers use it: when a judgment may be
 * asked, what is asked, and how the answer is shown.
 *
 * Everything here is additive and fails quiet. A handler's deterministic
 * result is complete without this module; the most it adds is one annotation
 * line, a reordered hint list, a `judgment` key, or — behind the benchmark
 * gate, for a click, once — a retry of a click the server confirmed never
 * started. Disabled, rate-limited, timed out, uncertain or inside a batch all
 * mean the same thing: the caller gets exactly what it gets today.
 */

import * as ni from './neural-interface.js';
import type { NiResponse } from './neural-interface.js';
import { typesafeEnabled, typesafeRetryAfterMs } from './typesafe.js';
import { typesafeConfig, surfaceConfig, invalidateTypeSafeConfig } from './typesafe-config.js';
import { browserAssistSnapshot, confirmAutoHeal, countBrowserAssist, type BrowserAssistSnapshot } from './browser-assist-gate.js';
import {
  judgePageState, interpretPageState, judgeBrowserTarget, recommendTarget, autoHealEligibility, parseSnapshotCandidates,
  facebookProbeState, xProbeState, judgeSocialState, offerSocialControls, cleanText,
  type SemanticContext, type PageStateRequest, type PageStateAdvice, type SocialControl,
} from './browser-judgments.js';
import { extractTargetPhrase, lexiconClass, type AssistCandidate, type TargetPhrase } from './browser-risk.js';

type BrowserSurface = 'browser-page-state' | 'browser-target' | 'browser-social';

const pct = (n: number | null | undefined) => `${Math.round((n ?? 0) * 100)}%`;
const quoted = (s: string) => `"${s.replace(/\s+/g, ' ').trim().slice(0, 60)}"`;

/**
 * May this surface be asked right now? Never inside a batch (an advisory
 * request error would fail the step, and a batch is a known sequence), never
 * while a 429's retry-after holds (`judge()` does not check that itself).
 * Call once per tool call: a rate-limit skip is counted here.
 */
export function assistAvailable(surface: BrowserSurface): boolean {
  if (ni.inBrowserBatch()) return false;
  if (!typesafeEnabled()) return false;
  if (!surfaceConfig(surface).enabled) return false;
  if (typesafeRetryAfterMs() > 0) { countBrowserAssist('skippedRateLimit'); return false; }
  return true;
}

// --- Page state ---

async function assessContext(context: unknown, request: PageStateRequest): Promise<PageStateAdvice | null> {
  if (!context || typeof context !== 'object') { countBrowserAssist('fallbackUnavailable'); return null; }
  // One reading of the config for the whole decision; judge() would otherwise read it again.
  const cfg = typesafeConfig();
  const settings = cfg.surfaces['browser-page-state'];
  const verdict = await judgePageState(context as SemanticContext, request, { model: cfg.model, timeoutMs: settings.timeoutMs, signal: ni.currentBrowserSignal() });
  const advice = interpretPageState(verdict, { minConfidence: settings.minConfidence ?? 0.65, minProbability: settings.minProbability ?? 0.8 });
  countBrowserAssist(advice ? 'pageAssessments' : 'fallbackUnavailable');
  return advice;
}

/** `Jev assessment: authentication_required (94%) — pause for human sign-in; goal satisfied 7%` */
export function formatAssessment(advice: PageStateAdvice | null, hasIntent: boolean): string {
  if (!advice) return '';
  // Compact mode keeps loops terse: a confident "usable" nobody asked about is noise. Blockers always show.
  if (ni.isBrowserCompactMode() && advice.state === 'usable' && !hasIntent) return '';
  let line = `Jev assessment: ${advice.state} (${pct(advice.confidence)})`;
  if (advice.guidance) line += ` — ${advice.guidance}`;
  if (hasIntent && advice.goalSatisfied !== null) line += `; goal satisfied ${pct(advice.goalSatisfied)}${advice.goalLikely ? ' (likely already done)' : ''}`;
  return line;
}

/** After browser_navigate: judge the context that came back in the same round trip. */
export async function assessNavigation(result: NiResponse, intent?: string | null): Promise<string> {
  const advice = await assessContext(result.semanticContext, { operation: 'navigate', intent: intent || null });
  const line = formatAssessment(advice, Boolean(intent));
  return line ? `\n${line}` : '';
}

/** Fetch the context of the current page and judge it. Used where no navigation response is at hand. */
export async function assessCurrentPage(sessionId: string, tabId: string | undefined, request: PageStateRequest & { purpose: 'page-state' | 'empty-extractor' | 'batch' }): Promise<{ advice: PageStateAdvice | null; context: SemanticContext | null }> {
  if (!assistAvailable('browser-page-state')) return { advice: null, context: null };
  const fetched = await ni.semanticContext(sessionId, tabId, { purpose: request.purpose });
  if (fetched.error || !fetched.context || typeof fetched.context !== 'object') { countBrowserAssist('fallbackUnavailable'); return { advice: null, context: null }; }
  const context = fetched.context as SemanticContext;
  return { advice: await assessContext(context, request), context };
}

const EMPTY_GUIDANCE: Record<string, string> = {
  usable: 'the page looks usable, so this is probably the wrong surface for this extractor, or its markup changed',
  loading: 'still loading; wait, then retry',
  authentication_required: 'a sign-in wall is in the way; pause for human sign-in',
  verification_required: 'a verification or CAPTCHA step is in the way; pause for a human',
  consent_blocker: 'a consent dialog covers the page; inspect it, do not dismiss it automatically',
  error: 'the page rendered an error; report it, then reload or navigate elsewhere explicitly',
  empty: 'the page is genuinely empty; scrolling or retrying will not help',
};

/**
 * Why did an extractor return nothing? Appended under the extractor's own
 * message, never instead of it. Local busy/skeleton signals outrank a Jev
 * "empty": a feed that is still hydrating is the failure this exists for.
 */
export async function diagnoseEmptyExtraction(sessionId: string, tabId: string | undefined, request: { tool: string; expectedSurface: string }): Promise<string> {
  const { advice, context } = await assessCurrentPage(sessionId, tabId, { operation: request.tool, expectedSurface: request.expectedSurface, purpose: 'empty-extractor' });
  const signals = (context?.signals ?? {}) as Record<string, unknown>;
  const busy = Number(signals.busyCount) > 0 || Number(signals.progressCount) > 0 || (typeof context?.page?.readyState === 'string' && context.page.readyState !== 'complete');
  if (!advice) return busy ? 'Page signals: busy regions or skeleton placeholders are visible — still loading; wait, then retry.' : '';
  if (busy && (advice.state === 'empty' || advice.state === 'usable')) return `Jev assessment: loading (busy regions or skeletons are visible, which outranks "${advice.state}") — wait, then retry.`;
  return `Jev assessment: ${advice.state} (${pct(advice.confidence)}) — ${EMPTY_GUIDANCE[advice.state] ?? advice.guidance}.`;
}

// --- Intent-aware snapshot ---

/**
 * Rank the refs of a delivered AI snapshot against an intent. Parses the text
 * the caller already has (or the same capture's full text when only a diff
 * was shown); never captures again, never executes.
 */
export async function rankSnapshotRefs(text: string, intent: string, page: SemanticContext['page']): Promise<string> {
  const { candidates, truncated } = parseSnapshotCandidates(text, intent);
  if (!candidates.length) return 'Jev target: no interactive refs in this snapshot';
  const snap = browserAssistSnapshot(typesafeConfig());
  const verdict = await judgeBrowserTarget({ action: 'activate', intent, page, candidates, truncated, limit: 24 },
    { model: snap.model, timeoutMs: snap.target.timeoutMs, signal: ni.currentBrowserSignal() });
  if (!verdict) { countBrowserAssist('fallbackUnavailable'); return ''; }
  const id = recommendTarget(verdict, snap.target);
  const pick = id ? candidates.find(c => c.id === id) : undefined;
  if (!pick) return 'Jev target: no candidate qualified';
  // A paid control is never put forward, whatever was asked for.
  if (lexiconClass(pick.name) === 'payment') { countBrowserAssist('blockedBySafety'); return 'Jev target: no candidate qualified'; }
  countBrowserAssist('recommendations');
  const others = verdict.alternatives.map(alt => candidates.find(c => c.id === alt)).filter((c): c is NonNullable<typeof c> => Boolean(c) && lexiconClass(c!.name) !== 'payment')
    .map(c => `${c.ref} ${quoted(c.name)}`);
  return `Jev target: ref ${pick.ref} ${quoted(pick.name)} (choice ${pct(verdict.confidence)}, match ${pct(verdict.exists)})${others.length ? `; alternatives: ${others.join(', ')}` : ''}`;
}

// --- Failed or ambiguous target ---

export interface Recovery {
  /** Legacy hints with the recommendation moved first; undefined keeps the server's order. */
  hints?: unknown[];
  annotation: string;
  /** Present only when every MCP-side check passed and the gate is armed. The server still re-verifies all of it. */
  heal?: { contextId: string; candidateId: string; label: string; verdict: string; snapshot: BrowserAssistSnapshot };
}

const ASSIST_KINDS = new Set(['no_match', 'parse_failed', 'ambiguous']);

/**
 * A target did not resolve and the server attached `assist`. Judge the
 * candidates against what the caller was aiming at and annotate. Considered
 * only on the server's own stamp of a pre-action resolution failure — never
 * inferred from the absence of guard flags.
 */
export async function recoverFailedTarget(result: NiResponse, request: { action: string; selector?: string | null; textHint?: string | null }): Promise<Recovery> {
  const none: Recovery = { annotation: '' };
  const assist = result.assist as { kind?: string; candidates?: AssistCandidate[]; truncated?: boolean; page?: SemanticContext['page']; contextId?: string } | undefined;
  if (!assist || typeof assist !== 'object' || !ASSIST_KINDS.has(String(assist.kind)) || !Array.isArray(assist.candidates) || !assist.candidates.length) return none;
  if (result.actionStarted !== false || result.outcome !== undefined) return none;
  const phrase: TargetPhrase | null = extractTargetPhrase(request.selector, request.textHint);
  if (!phrase) return none;
  const snap = browserAssistSnapshot(typesafeConfig());
  const candidates = assist.candidates.slice(0, 12);
  const verdict = await judgeBrowserTarget({ action: request.action, intent: phrase.phrase, page: assist.page, candidates, truncated: assist.truncated === true, failure: assist.kind, limit: 12 },
    { model: snap.model, timeoutMs: snap.target.timeoutMs, signal: ni.currentBrowserSignal() });
  if (!verdict) { countBrowserAssist('fallbackUnavailable'); return none; }
  const id = recommendTarget(verdict, snap.target);
  const pick = id ? candidates.find(c => c.id === id) : undefined;
  if (!pick) return { annotation: '\n\nJev target: no candidate qualified — take a fresh browser_snapshot rather than guessing.' };
  if (pick.risk === 'payment') { countBrowserAssist('blockedBySafety'); return none; }
  countBrowserAssist('recommendations');

  const describe = (c: AssistCandidate) => `${c.kind} ${quoted(c.name)}${c.selector ? ` → ${c.selector}${c.nth !== undefined ? ` [nth:${c.nth}]` : ''}` : ''}`;
  const others = verdict.alternatives.map(alt => candidates.find(c => c.id === alt)).filter((c): c is AssistCandidate => Boolean(c) && c!.risk !== 'payment');
  const scores = `choice ${pct(verdict.confidence)}, match ${pct(verdict.exists)}`;
  let annotation = `\n\nJev target: ${describe(pick)} (${scores}; ${pick.risk}${pick.disabled ? ', disabled' : ''})`;
  if (others.length) annotation += `\nalternatives: ${others.map(describe).join('; ')}`;
  if (phrase.source === 'selector-generic') annotation += '\n(ranked against a guess from the selector; pass textHint to say what you meant)';

  const hints = Array.isArray(result.hints) ? [...(result.hints as unknown[])] : undefined;
  if (hints && pick.hintIndex !== null && pick.hintIndex >= 0 && pick.hintIndex < hints.length) hints.unshift(...hints.splice(pick.hintIndex, 1));

  const eligibility = autoHealEligibility({ action: request.action, candidates, phrase, selector: request.selector }, verdict, snap.target);
  const recovery: Recovery = { hints, annotation };
  if (eligibility.eligible && assist.kind !== 'ambiguous') {
    if (snap.mode === 'auto-heal' && typeof assist.contextId === 'string') {
      recovery.heal = { contextId: assist.contextId, candidateId: pick.id, label: pick.name, verdict: scores, snapshot: snap };
    } else if (snap.mode === 'shadow') {
      countBrowserAssist('shadowAutoHealEligible');
    }
  } else if (request.action === 'click' && !eligibility.eligible && eligibility.candidateId) {
    countBrowserAssist('blockedBySafety');
  }
  return recovery;
}

export type HealOutcome =
  | { status: 'healed'; result: NiResponse; label: string; verdict: string }
  | { status: 'refused'; note: string }
  | { status: 'uncertain'; error: string };

/**
 * The single retry. The gate is confirmed against a fresh read of the config,
 * the request goes out once through a transport that never recovers a route,
 * and whatever comes back, nothing is tried again.
 */
export async function attemptAutoHeal(heal: NonNullable<Recovery['heal']>, target: { sessionId: string; tabId?: string; snapshot?: 'diff' | 'full' | 'none' }): Promise<HealOutcome> {
  if (ni.inBrowserBatch()) return { status: 'refused', note: '' };
  invalidateTypeSafeConfig();
  const confirmed = confirmAutoHeal(heal.snapshot, typesafeConfig());
  if (!confirmed.ok) { countBrowserAssist('blockedBySafety'); return { status: 'refused', note: '' }; }
  if (ni.currentBrowserSignal()?.aborted) return { status: 'refused', note: '' };
  countBrowserAssist('autoHealAttempted');
  const result = await ni.clickAutoHeal(target.sessionId, target.tabId, { contextId: heal.contextId, candidateId: heal.candidateId }, target.snapshot);
  if (!result.error) { countBrowserAssist('autoHealSucceeded'); return { status: 'healed', result, label: heal.label, verdict: heal.verdict }; }
  // Once execution may have begun, the only honest report is the server's own words.
  if (result.actionStarted !== false || result.outcome !== undefined) return { status: 'uncertain', error: String(result.error) };
  countBrowserAssist('blockedBySafety');
  const reason = typeof result.autoHealRejected === 'string' ? result.autoHealRejected : result.moneyGuard ? 'money_guard' : result.staleTarget ? 'stale_target' : 'refused';
  return { status: 'refused', note: `\n(Jev auto-heal was attempted once on ${quoted(heal.label)} and refused by the server: ${cleanText(reason, 40)}; nothing was clicked and it is not retried.)` };
}

// --- Social composers ---

const FB_DIALOG = '[role="dialog"]:has([role="textbox"], [contenteditable="true"])';
const X_DIALOG = '[role="dialog"][aria-modal="true"]:has([data-testid="tweetTextarea_0"])';

/**
 * An additive `judgment` for an ambiguous composer probe, or null. Runs only
 * when the deterministic probe could not decide; never when it could. The
 * probe's own fields stay authoritative, and nothing here clicks, types or
 * publishes. Jev sees an allow-list pick of the probe and short button names —
 * never the draft, the quoted post, the trigger text or a title.
 */
export async function judgeComposer(platform: 'facebook' | 'x', probe: unknown, sessionId: string, tabId?: string): Promise<Record<string, unknown> | null> {
  const p = (probe && typeof probe === 'object' ? probe : {}) as Record<string, any>;
  const composerOpen = platform === 'facebook' ? (p.modal?.open === true && p.modal?.containsComposer === true) : p.composerOpen === true;
  const ambiguous = platform === 'facebook'
    ? p.recommendedAction === 'unknown' || p.submission?.state === 'unknown' || p.submitButton?.matchType === 'heuristic' || (composerOpen && !p.submitButton)
    : p.recommendedAction === 'unknown' || (Array.isArray(p.warnings) && p.warnings.length > 0);
  if (!ambiguous || !assistAvailable('browser-social')) return null;

  const seeking: 'submit' | 'trigger' | null = platform === 'facebook'
    ? (composerOpen && (!p.submitButton || p.submitButton?.matchType === 'heuristic') ? 'submit' : !composerOpen && p.trigger?.found !== true ? 'trigger' : null)
    : (composerOpen && !(p.submitButton?.present === true && p.submitButton?.enabled === true) ? 'submit' : null);
  const scope = seeking === 'submit' ? (platform === 'facebook' ? FB_DIALOG : p.isModal === true ? X_DIALOG : undefined) : undefined;
  const fetched = await ni.semanticContext(sessionId, tabId, { purpose: 'social', social: true, ...(scope && { scope }) });
  if (fetched.error || !fetched.context || typeof fetched.context !== 'object') { countBrowserAssist('fallbackUnavailable'); return null; }
  const context = fetched.context as SemanticContext & { candidates?: AssistCandidate[] };
  // The server already dropped payment controls; drop them again here, by vocabulary, before Jev sees any option.
  const offered = offerSocialControls(Array.isArray(context.candidates) ? context.candidates : []);
  const controls: SocialControl[] = offered.map(c => ({ id: c.id, role: c.role, name: c.name, disabled: c.disabled }));

  const cfg = typesafeConfig();
  const settings = cfg.surfaces['browser-social'];
  const minConfidence = settings.minConfidence ?? 0.75;
  const verdict = await judgeSocialState({ platform, probe: platform === 'facebook' ? facebookProbeState(probe) : xProbeState(probe), page: context.page, signals: context.signals, controls, seeking },
    { model: cfg.model, timeoutMs: settings.timeoutMs, signal: ni.currentBrowserSignal() });
  if (!verdict) { countBrowserAssist('fallbackUnavailable'); return null; }
  const stateKnown = verdict.state !== 'unknown' && verdict.confidence >= minConfidence;
  const pick = verdict.candidateId && (verdict.candidateConfidence ?? 0) >= minConfidence ? offered.find(c => c.id === verdict.candidateId) : undefined;
  if (!stateKnown && !pick) { countBrowserAssist('fallbackUnavailable'); return null; }
  if (pick) countBrowserAssist('recommendations');
  return {
    advisory: true,
    state: stateKnown ? verdict.state : 'unknown',
    confidence: Number(verdict.confidence.toFixed(2)),
    ...(pick && seeking ? { suggestedControl: { purpose: seeking, label: pick.name, selector: pick.selector ?? null, ...(pick.nth !== undefined ? { nth: pick.nth } : {}), enabled: !pick.disabled, confidence: Number((verdict.candidateConfidence ?? 0).toFixed(2)) } } : {}),
    note: 'Jev reading of an ambiguous probe. The deterministic fields above stay authoritative; verify with a fresh probe after acting, and never click a Boost or Promote control.',
  };
}
