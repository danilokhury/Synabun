// ═══════════════════════════════════════════
// SynaBun — Assistant router (DeepSeek-Harness-style request routing)
// ═══════════════════════════════════════════
//
// The assistant's CURRENT brain model is the planner: it classifies each
// actionable request and proposes where it should run (here on its own model,
// or dispatched to a Claude / Codex / OpenCode worker model). This module
// never classifies anything itself. It enforces the per-session route mode:
//
//   always-ask  every actionable task becomes a route card the user answers
//   ask-unsure  a card only when the brain is unsure, names an unknown model,
//               omits one, picks a model that cannot see an image task, or
//               one that cannot make the image / video a creation task needs
//   never       the user's saved route for the task class runs at once (it
//               binds over the brain's pick); without one, the brain's pick
//               runs (invalid picks are corrected)
//
// Image creation and Video creation (`requires`, `dispatchOnly`) always run on a
// worker whose model generates that medium (catalog `outputs`): any other pick is
// corrected or disabled, and with no such model anywhere agent_route declines
// (no_capable_model) instead of asking. Design (`vision`, `dispatchOnly`) works
// the same way on a worker whose model can see: only a confirmed `vision: true`
// on a listed row counts, as only a confirmed output does, so a provider whose
// catalog is unavailable (OpenCode down) has models that are unknown, not
// disabled — they neither bind nor run design — a claude-* id the list lacks is
// unknown unless it resolves to a listed row, and with no catalog value nothing
// qualifies.
//
// It validates targets against the catalog, remembers per-class preferences,
// holds un-routed dispatches until the user picks (dispatcher `awaiting_route`)
// and suggests one-tier escalations when a run fails or reports blocked.
// Catalog, config and runtime I/O are injected. The split planner checks git before worktree approval.

import { routeTaskIdentity } from '../public/shared/assistant/route-identity.js';
import { agentPinOf, agentRefOf, routedAgent } from './agents/resolve.js';
import { planRouteSplit, splitChanged } from './agents/split.js';
import { normalizeAgentDensity } from './agents/density.js';
import { randomBytes } from 'node:crypto';
import { CATALOG_PROVIDERS, TIERS, defaultIsHidden, defaultModelRow, findModel, hiddenModelId, priceText, providerAllHidden, providerEmpty, rowIsHidden, rowMakes } from './assistant-catalog.js';
import { effectiveRouting, normalizeRouteMode } from './assistant-config.js';
import { EFFORT_OFF, normalizeEffort } from './effort-levels.js';
import { hasRouteAccounts, routeAccountText } from './assistant-route-accounts.js';
import { chooseUsageAccount } from './account-usage.js';
import { PROVIDER_LABELS, coversWork, dryProviders, isFreePrice, isUnpricedProvider, listPriceOf, rowOf } from './assistant-budget-split.js';

export const TASK_CLASS_META = Object.freeze({
  chat: { label: 'Chat', description: 'Conversation and questions answered from knowledge or memory', defaultKind: 'direct' },
  quick: { label: 'Quick task', description: 'Small edits, one-off shell commands, lookups', defaultKind: 'direct' },
  code: { label: 'Coding', description: 'A feature or bug fix inside one repository', defaultKind: 'dispatch' },
  complex: { label: 'Complex engineering', description: 'Architecture, cross-file refactors, hard debugging', defaultKind: 'dispatch' },
  review: { label: 'Review', description: 'A second model reviews code, a plan or a result', defaultKind: 'dispatch' },
  research: { label: 'Research', description: 'Web or codebase research and summaries', defaultKind: 'direct' },
  browser: { label: 'Browser', description: 'Web tasks in the SynaBun browser', defaultKind: 'direct' },
  computer: { label: 'Computer use', description: 'Operate desktop apps on this Mac (needs a model that can see)', defaultKind: 'direct' },
  automation: { label: 'Automation', description: 'Loops, schedules and recurring work', defaultKind: 'direct' },
  // Always one worker on a model that can see, with SynaBun's design rules (`playbook`, assistant-playbooks.js);
  // its screenshots and images are collected like generated ones (`collects`), but it must make none.
  design: { label: 'Design', description: 'UI/UX research, design systems, mockups and prototypes', defaultKind: 'dispatch', vision: true, collects: 'image', playbook: 'design', dispatchOnly: true },
  // Made by the model itself (Codex's built-in image tool, an OpenCode model that outputs the medium), always on a worker.
  image_gen: { label: 'Image creation', description: 'Create images with a model that generates them', defaultKind: 'dispatch', requires: 'image', dispatchOnly: true },
  video_gen: { label: 'Video creation', description: 'Create videos with a model that generates them', defaultKind: 'dispatch', requires: 'video', dispatchOnly: true },
});
export const TASK_CLASSES = Object.freeze(Object.keys(TASK_CLASS_META));
export const PREFERENCE_KEYS = Object.freeze([...TASK_CLASSES, 'vision']);
export const ROUTE_REASONS = Object.freeze(['always-ask', 'low_confidence', 'no_confidence', 'model_missing', 'model_unknown', 'model_disabled', 'model_unavailable', 'needs_vision', 'needs_output', 'no_capable_model', 'budget_exhausted']);
export const MODEL_DISABLED_TEXT = "Disabled in the Assistant's Models list.";
const VISION_CLASSES = new Set(['computer']);
const MEDIUM_WORDS = { image: 'images', video: 'videos' };
/** The medium ('image' | 'video') a task class creates, else null. */
export function requiredOutput(taskClass) { return TASK_CLASS_META[taskClass]?.requires || null; }
/** "This model can't generate images." */
export function cannotMakeText(medium) { return `This model can't generate ${MEDIUM_WORDS[medium] || medium}.`; }
/**
 * Does the class always run on a model that can see (Design)? Like image / video creation's
 * outputs (rowMakes), only a confirmed `vision: true` counts; an unknown `null` never does.
 * Computer use's softer check (VISION_CLASSES) only refuses a confirmed `false`.
 */
export function requiresVision(taskClass) { return TASK_CLASS_META[taskClass]?.vision === true; }
export const CANNOT_SEE_TEXT = "This model can't see images.";
export const UNKNOWN_SIGHT_TEXT = "This model isn't known to see images.";
export const UNAVAILABLE_TEXT = "This model isn't available right now.";
/** A "here" on an account other than this conversation's: provider histories belong to their account. */
export const WORKER_FOR_ACCOUNT_TEXT = 'Runs on a worker because this conversation belongs to another account.';
/** The card / answer text for a model design cannot use (a designFit() verdict). */
function fitText(fit) { return fit === 'blind' ? CANNOT_SEE_TEXT : fit === 'unavailable' ? UNAVAILABLE_TEXT : UNKNOWN_SIGHT_TEXT; }
/** What a run of the class collects into its media: the medium it makes, else what it gathers (Design's screenshots). */
export function collectedMedia(taskClass) { return requiredOutput(taskClass) || TASK_CLASS_META[taskClass]?.collects || null; }
/** The playbook a run of the class gets (assistant-playbooks.js), else null. */
export function classPlaybook(taskClass) { return TASK_CLASS_META[taskClass]?.playbook || null; }
/**
 * What the class changes about a worker run besides its model (the medium it must make, the
 * playbook it gets), else null. A route approved for one cannot carry a dispatch of another
 * (the dispatcher's ROUTE_CLASS_MISMATCH).
 */
export function runContract(taskClass) { return requiredOutput(taskClass) || classPlaybook(taskClass); }
const TIER_RANK = { small: 0, medium: 1, large: 2 };
const MAX_ESCALATION_DEPTH = 2;
const DECIDED_TTL_MS = 60 * 60_000;
// A queued "do it here" continuation not started after this is delivered once more; still not started after the
// same again, the brain and the panel are told (maybeContinuation's watchdog).
export const CONTINUATION_WATCH_MS = 30_000;
const CONTINUATION_WATCH_S = CONTINUATION_WATCH_MS / 1000;
const CONTINUATIONS_KEPT = 200;

function clip(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
const usdText = (value) => `$${(Number(value) || 0).toFixed(2)}`;
function routeError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}
function tierRank(tier) { return TIER_RANK[tier] ?? 1; }
function outPrice(row) { const n = Number(row?.price?.output); return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY; }
function sameTarget(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && a.provider === b.provider && String(a.model || '') === String(b.model || '') && String(a.effort || '') === String(b.effort || '') && String(a.accountId || '') === String(b.accountId || '');
}

/**
 * A target on a model the user hid (Assistant → Models, or Settings → OpenCode
 * for OpenCode), or a dispatch with no model onto a provider whose every
 * model is hidden.
 */
function isDisabled(catalog, target) {
  if (!target?.provider) return false;
  // A named model is unusable when hidden, or when its provider answered with nothing connected
  // (an unavailable catalog is not an empty one: that stays lenient).
  if (target.model) return !!hiddenModelId(catalog, target.provider, target.model) || providerEmpty(catalog, target.provider);
  // No model named: nothing to run when every model is hidden, or the provider has none connected.
  return target.kind === 'dispatch' && (providerAllHidden(catalog, target.provider) || providerEmpty(catalog, target.provider));
}
/** The provider's rows minus the hidden ones (a hand-built catalog may still carry them). */
function visibleRows(catalog, provider) {
  return (catalog?.models?.[provider] || []).filter((row) => !rowIsHidden(catalog, { ...row, provider: row.provider || provider }));
}
/** A dispatch with no model whose provider default is hidden runs on this row instead. */
function pinnedDefault(catalog, target) {
  if (target?.kind !== 'dispatch' || target.model || !defaultIsHidden(catalog, target.provider)) return null;
  return defaultModelRow(catalog, target.provider);
}
/** Does the model `target` runs on (its provider default when it names none) generate `medium`? Unknown never counts. */
export function targetMakes(catalog, target, medium) {
  if (!medium) return true;
  if (!target?.provider) return false;
  const row = target.model ? findModel(catalog, target.provider, target.model)?.row : defaultModelRow(catalog, target.provider);
  return rowMakes(row, medium);
}
/** The provider's enabled, available rows that generate `medium`, cheapest first (price, then tier). */
function makerRows(catalog, provider, medium) {
  return visibleRows(catalog, provider).filter((row) => row.status !== 'unavailable' && rowMakes(row, medium))
    .sort((a, b) => outPrice(a) - outPrice(b) || tierRank(a.tier) - tierRank(b.tier));
}
/** Is any enabled model in the catalog able to generate `medium`? */
export function anyMaker(catalog, medium) {
  return CATALOG_PROVIDERS.some((provider) => makerRows(catalog, provider, medium).length > 0);
}
/**
 * Can a design run use `target`? 'ok', 'blind' (vision false), 'unknown' (vision not known) or
 * 'unavailable' (its catalog row is marked unavailable, which seeingRows never picks either).
 * A claude-* id the catalog does not list (findModel 'unlisted', which other classes take as
 * seeing) is 'unknown': design needs a listed row, so such an id counts only when the catalog
 * resolves it to one ("claude-opus-5-5" → the opus row), and then that row decides.
 * Other classes do not look at availability.
 */
export function designFit(catalog, target, { brain = {}, brainInfo = null } = {}) {
  const hit = target?.model ? findModel(catalog, target.provider, target.model) : null;
  if (hit?.match === 'unlisted') return 'unknown';
  const vision = describeTarget(target, { catalog, brain, brainInfo })?.vision;
  if (vision === false) return 'blind';
  if (vision !== true) return 'unknown';
  const row = target?.model ? hit?.row : defaultModelRow(catalog, target?.provider);
  return row?.status === 'unavailable' ? 'unavailable' : 'ok';
}
/** The provider's enabled, available rows that can see, cheapest first (price, then tier). */
function seeingRows(catalog, provider) {
  return visibleRows(catalog, provider).filter((row) => row.status !== 'unavailable' && row.vision === true)
    .sort((a, b) => outPrice(a) - outPrice(b) || tierRank(a.tier) - tierRank(b.tier));
}
/** Is any enabled model in the catalog able to see? */
export function anySeer(catalog) {
  return CATALOG_PROVIDERS.some((provider) => seeingRows(catalog, provider).length > 0);
}

export function normalizeConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  let n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) n /= 100;
  return Math.min(1, Math.max(0, n));
}

/**
 * Normalize the brain's proposal (agent_route body, or a dispatch spec reshaped
 * into one). A "direct" proposal on another provider is really a dispatch
 * (`coercedProvider` records the first, so the result can say so); for a
 * dispatch-only class (image / video creation, design) every proposal is a dispatch,
 * a "here" one on the brain's own model (`coercedDirect` records the first).
 * Design (`visionOnly`) also always needs a model that can see.
 */
export function normalizeRouteRequest(body = {}, { brain = {} } = {}) {
  const rawClass = String(body.task_class ?? body.taskClass ?? '').trim().toLowerCase();
  const taskClass = TASK_CLASSES.includes(rawClass) ? rawClass : 'quick';
  const meta = TASK_CLASS_META[taskClass];
  const confidence = normalizeConfidence(body.confidence);
  const visionOnly = meta.vision === true;
  const needsVision = !!(body.needs_vision ?? body.needsVision) || VISION_CLASSES.has(taskClass) || visionOnly;
  const needsOutput = meta.requires || null;
  const dispatchOnly = meta.dispatchOnly === true;
  const needsHost = body.needs_host === true || body.needsHost === true;
  if (needsHost && dispatchOnly) throw routeError('ROUTE_INVALID', 'This task class requires a worker and cannot run here.');
  const proposals = [];
  let coercedDirect = false;
  let coercedProvider = null;
  for (const raw of Array.isArray(body.proposals) ? body.proposals.slice(0, 3) : []) {
    if (!raw || typeof raw !== 'object') continue;
    const requested = agentRefOf(raw);
    let kind = raw.kind === 'direct' ? 'direct' : 'dispatch';
    let provider = CATALOG_PROVIDERS.includes(raw.provider) ? raw.provider : requested === 'none' ? brain.provider : null;
    let model = raw.model ? String(raw.model).trim().slice(0, 200) : null;
    if (kind === 'direct') {
      if (provider && provider !== brain.provider) {
        kind = 'dispatch';
        if (!proposals.length && !dispatchOnly) coercedProvider = provider;
      } else provider = brain.provider || provider;
    }
    if (!provider) continue;
    if (needsHost && !runsHere({ kind, provider, accountId: raw.accountId || raw.account_id }, brain)) continue;
    if (dispatchOnly && kind === 'direct') {
      kind = 'dispatch';
      model = model || brain.model || null;
      if (!proposals.length) coercedDirect = true;
    }
    proposals.push({
      kind, provider, model: model || (needsHost ? brain.model || null : null),
      ...(requested ? { agentRequest: requested } : {}),
      effort: raw.effort ? String(raw.effort).trim().slice(0, 40) : null,
      ...(raw.accountId || raw.account_id ? { accountId: String(raw.accountId || raw.account_id).slice(0, 64) } : {}),
      reason: raw.reason ? clip(raw.reason, 240) : null,
    });
  }
  if (!proposals.length) {
    const kind = needsHost ? 'direct' : meta.defaultKind;
    proposals.push({ kind, provider: brain.provider || 'claude-code', model: kind === 'direct' ? (brain.model || null) : null, effort: null, reason: null });
  }
  const request = { taskClass, taskClassLabel: meta.label, summary: clip(body.summary || '', 400), confidence, needsVision, proposals };
  if (needsOutput || dispatchOnly) Object.assign(request, { needsOutput, dispatchOnly, coercedDirect });
  if (needsHost) request.needsHost = true;
  if (visionOnly) request.visionOnly = true;
  if (!needsHost && coercedProvider) request.coercedProvider = coercedProvider;
  return request;
}

/** A direct continuation shares the running conversation's provider and account. */
function runsHere(target, brain) {
  return target?.kind === 'direct' && target.provider === brain.provider
    && (!target.accountId || target.accountId === (brain.accountId || 'default'));
}

/** Why a "here" on `provider` runs on a worker: only the brain's own provider runs in this conversation. */
function otherProviderCorrection(provider, brain = {}) {
  return {
    field: 'kind', from: 'direct', to: 'dispatch', reason: 'other_provider', provider,
    text: `${providerLabel(provider)} is not this conversation's provider${brain.provider ? ` (${providerLabel(brain.provider)})` : ''}, so it runs on a worker`,
  };
}

/** Catalog-backed description of a target: label, tier, vision, outputs, price, context. */
export function describeTarget(target, { catalog = null, brain = {}, brainInfo = null } = {}) {
  if (!target) return null;
  const isBrainModel = target.kind === 'direct' && target.provider === brain.provider && String(target.model || '') === String(brain.model || '');
  let row = null;
  let match = null;
  if (target.model) { const hit = findModel(catalog, target.provider, target.model); row = hit?.row || null; match = hit?.match || null; }
  else row = defaultModelRow(catalog, target.provider);
  const info = isBrainModel && brainInfo ? brainInfo : null;
  const label = info?.label || row?.label || target.model || `${target.provider} default`;
  const unlistedClaude = target.provider === 'claude-code' && match === 'unlisted';
  return {
    kind: target.kind, provider: target.provider, model: target.model || null, effort: target.effort || null,
    ...(Object.hasOwn(target, 'accountId') ? { accountId: target.accountId, account: target.account || null, accountError: target.accountError || null } : {}),
    label, tier: info?.tier || row?.tier || null,
    vision: info ? info.vision ?? null : (row ? row.vision ?? null : (unlistedClaude ? true : null)),
    // What it generates besides text (image / video creation needs a true one).
    outputs: row ? row.outputs ?? null : (unlistedClaude ? { image: false, video: false } : null),
    price: info?.price || row?.price || null, contextWindow: info?.contextWindow || row?.contextWindow || null,
    validated: match || (row ? 'default' : (target.model ? (isDisabled(catalog, target) ? 'disabled' : 'unknown') : 'default')),
  };
}

/**
 * `target` with its effort checked against its model (effort-levels.js): an
 * unsupported level becomes the nearest one the model runs, and the change is
 * pushed onto `corrections` as { field: 'effort', from, to, reason: 'effort_unsupported' }. Off (`none`) on a
 * Claude model whose thinking cannot be turned off runs at the lowest level, reason 'thinking_always_on', with a
 * text that says so: no route claims "thinking off" while the request carries adaptive thinking.
 */
export function effortChecked(target, catalog, corrections = null) {
  if (!target?.effort) return target;
  const { effort, corrected } = normalizeEffort({ provider: target.provider, model: target.model || null, effort: target.effort, catalog });
  if (corrected?.reason === 'thinking_always_on') {
    corrections?.push({ field: 'effort', from: corrected.from, to: corrected.to, reason: 'thinking_always_on',
      text: `effort none (thinking off) runs as ${corrected.to}: ${target.model || 'this model'} cannot turn its thinking off` });
  } else if (corrected) corrections?.push({ field: 'effort', from: corrected.from, to: corrected.to, reason: 'effort_unsupported' });
  return effort === target.effort ? target : { ...target, effort };
}

/**
 * A saved route as a target. `dispatchOnly` (image / video creation): a saved
 * "here" becomes a dispatch onto the same model (the brain's, when it named none).
 */
function preferenceTarget(pref, brain, catalog = null, { dispatchOnly = false, needsHost = false } = {}) {
  if (!pref?.provider) return null;
  const here = pref.kind === 'direct' && pref.provider === brain.provider;
  const kind = here && !dispatchOnly ? 'direct' : 'dispatch';
  const model = pref.model || (here && (dispatchOnly || needsHost) ? brain.model || null : null);
  const target = { kind, provider: pref.provider, model, effort: pref.effort || null };
  if (hasRouteAccounts(pref.provider) && pref.accountId) target.accountId = pref.accountId;
  // A remembered route onto a model the user since disabled is not applied.
  return catalog && isDisabled(catalog, target) ? null : target;
}

/** "here on <model>" / "<provider>/<model|default>", with " (<effort>)". */
export function routeText(target) {
  if (!target) return 'none';
  const where = target.kind === 'direct' ? `here${target.model ? ` on ${target.model}` : ''}` : `${target.provider}/${target.model || 'default'}`;
  return `${where}${target.effort ? ` (${effortWord(target.effort)})` : ''}`;
}
/** An effort as people read it: `none` is thinking off. */
export function effortWord(effort) { return String(effort || '').toLowerCase() === EFFORT_OFF ? 'thinking off' : String(effort || ''); }

/** Cheapest vision-capable model, same provider first. */
function visionFallback(catalog, provider, { brain = {}, routing = {} } = {}) {
  const pref = preferenceTarget(routing.preferences?.vision, brain, catalog);
  if (pref) return pref;
  const rows = visibleRows(catalog, provider).filter((row) => row.vision === true && row.status !== 'unavailable');
  const sorted = [...rows].sort((a, b) => outPrice(a) - outPrice(b));
  if (sorted.length) return { kind: provider === brain.provider ? 'direct' : 'dispatch', provider, model: sorted[0].id, effort: null };
  for (const other of CATALOG_PROVIDERS) {
    if (other === provider) continue;
    const alt = visibleRows(catalog, other).filter((row) => row.vision === true).sort((a, b) => outPrice(a) - outPrice(b))[0];
    if (alt) return { kind: 'dispatch', provider: other, model: alt.id, effort: null };
  }
  return null;
}

/**
 * A worker model that generates `medium` for an image / video creation task:
 * the class's saved route when it can, else the cheapest maker on `provider`,
 * else the cheapest maker anywhere (price, then tier). With `needsVision` (a
 * reference image the worker must see) every requirement counts together: the
 * first of those that can see, else one whose vision is unknown, else the
 * first. null when no model makes the medium.
 */
function generationFallback(catalog, provider, medium, { brain = {}, routing = {}, taskClass = null, needsVision = false } = {}) {
  const candidates = [];
  const pref = preferenceTarget(routing.preferences?.[taskClass], brain, catalog, { dispatchOnly: true });
  if (pref && targetMakes(catalog, pref, medium)) candidates.push(pref);
  if (provider) for (const row of makerRows(catalog, provider, medium)) candidates.push({ kind: 'dispatch', provider, model: row.id, effort: null });
  const rank = (p) => CATALOG_PROVIDERS.indexOf(p);
  CATALOG_PROVIDERS.filter((p) => p !== provider)
    .flatMap((p) => makerRows(catalog, p, medium).map((row) => ({ provider: p, row })))
    .sort((a, b) => outPrice(a.row) - outPrice(b.row) || tierRank(a.row.tier) - tierRank(b.row.tier) || rank(a.provider) - rank(b.provider))
    .forEach(({ provider: p, row }) => candidates.push({ kind: 'dispatch', provider: p, model: row.id, effort: null }));
  if (!needsVision) return candidates[0] || null;
  const sight = (target) => describeTarget(target, { catalog, brain })?.vision;
  return candidates.find((t) => sight(t) === true) || candidates.find((t) => sight(t) !== false) || candidates[0] || null;
}

/**
 * A worker model that can see for a Design task: the class's saved route when it
 * can, else the cheapest model on `provider` that can, else the cheapest anywhere
 * (price, then tier). null when no model can see.
 */
function sightFallback(catalog, provider, { brain = {}, routing = {}, taskClass = null } = {}) {
  const pref = preferenceTarget(routing.preferences?.[taskClass], brain, catalog, { dispatchOnly: true });
  if (pref && designFit(catalog, pref, { brain }) === 'ok') return pref;
  const own = provider ? seeingRows(catalog, provider)[0] : null;
  if (own) return { kind: 'dispatch', provider, model: own.id, effort: null };
  const rank = (p) => CATALOG_PROVIDERS.indexOf(p);
  const alt = CATALOG_PROVIDERS.filter((p) => p !== provider)
    .flatMap((p) => seeingRows(catalog, p).map((row) => ({ provider: p, row })))
    .sort((a, b) => outPrice(a.row) - outPrice(b.row) || tierRank(a.row.tier) - tierRank(b.row.tier) || rank(a.provider) - rank(b.provider))[0];
  return alt ? { kind: 'dispatch', provider: alt.provider, model: alt.row.id, effort: null } : null;
}

// ── the session budget (assistant-budget-split.js coverage) ──────────────────

/** Does `target` run on a free model (the catalog says so)? Free models need no share of the budget. */
export function targetIsFree(catalog, target) {
  if (!target?.provider) return false;
  return isFreePrice(listPriceOf(rowOf(catalog, target.provider, target.model || null), { provider: target.provider, model: target.model || null }));
}
/**
 * Can the session's budget pay for `target` now? A direct target is the brain's own work (it may use its
 * reserve), a dispatch a worker's; a free model needs only the session to be under its budget.
 * `coverage` null (No limit, or no budget wired): always.
 */
export function budgetCovers(coverage, catalog, target) {
  if (!coverage || !target?.provider) return true;
  return coversWork(coverage, { provider: target.provider, forBrain: target.kind === 'direct', free: targetIsFree(catalog, target) });
}
/** "codex share used up" / "the session budget is spent". */
function dryText(coverage, provider) {
  if (!coverage || coverage.leftUsd < 0.01) return 'the session budget is spent';
  return `${provider} share used up`;
}
/**
 * With a budget, a task whose provider has no share left moves to the next capable provider with money
 * (the user chose Re-route): the brain's next proposal first, then the same tier on another provider
 * (its saved model for that class, else its default model, else its cheapest model of that tier), then a
 * free capable model, and last any capable model with share left, the closest tier first (cheapest
 * within it), so a task is declined only when nothing at all can pay. Every capability rule holds for
 * each candidate (`capable`). → { target } (moved or not), or { declined: true } when nothing can pay.
 */
function budgetReroute({ target, request, catalog, brain, routing, coverage, capable }) {
  const covers = (t) => budgetCovers(coverage, catalog, t);
  if (covers(target)) return { target, moved: false };
  const providerOk = (p) => coverage.providers?.[p]?.eligible !== false;
  const tried = new Set();
  const key = (t) => `${t.kind}:${t.provider}:${t.model || ''}`;
  const pick = (t) => {
    if (!t?.provider || tried.has(key(t))) return null;
    tried.add(key(t));
    return providerOk(t.provider) && capable(t) && covers(t) ? t : null;
  };
  // 1. The brain's next proposals.
  for (const p of (request.proposals || []).slice(1)) {
    const t = pick({ kind: p.kind === 'direct' && p.provider === brain.provider && !request.dispatchOnly ? 'direct' : 'dispatch', provider: p.provider, model: p.model || null, effort: p.effort || null, ...(p.accountId ? { accountId: p.accountId } : {}) });
    if (t) return { target: t, moved: true, step: 'proposal' };
  }
  if (request.needsHost) {
    if (isUnpricedProvider(brain.provider)) return { declined: true, unpriced: brain.provider };
    for (const [candidate] of hereCandidates({ request, catalog, brain })) {
      const t = pick(candidate);
      if (t) return { target: t, moved: true, step: 'here' };
    }
    return { declined: true, dry: [brain.provider] };
  }
  // 2. The same tier on another provider.
  const tierOf = (t) => (t?.model ? findModel(catalog, t.provider, t.model)?.row?.tier : defaultModelRow(catalog, t?.provider)?.tier) || null;
  const tier = tierOf(target);
  for (const provider of CATALOG_PROVIDERS) {
    if (provider === target.provider || !providerOk(provider)) continue;
    const pref = routing?.preferences?.[request.taskClass];
    const candidates = [];
    if (pref?.provider === provider) candidates.push({ kind: 'dispatch', provider, model: pref.model || null, effort: pref.effort || null, ...(pref.accountId ? { accountId: pref.accountId } : {}) });
    const own = defaultModelRow(catalog, provider);
    if (own && (!tier || own.tier === tier)) candidates.push({ kind: 'dispatch', provider, model: own.id, effort: null });
    visibleRows(catalog, provider).filter((row) => row.status !== 'unavailable' && (!tier || row.tier === tier))
      .sort((a, b) => outPrice(a) - outPrice(b)).forEach((row) => candidates.push({ kind: 'dispatch', provider, model: row.id, effort: null }));
    for (const candidate of candidates) {
      const t = pick(candidate);
      if (t) return { target: t, moved: true, step: 'same_tier' };
    }
  }
  // 3. A free capable model, anywhere.
  for (const provider of CATALOG_PROVIDERS) {
    if (!providerOk(provider)) continue;
    const free = visibleRows(catalog, provider).filter((row) => row.status !== 'unavailable' && isFreePrice(row.price || null));
    for (const row of free) {
      const t = pick({ kind: 'dispatch', provider, model: row.id, effort: null });
      if (t) return { target: t, moved: true, step: 'free' };
    }
  }
  // 4. Any capable model with share left: the closest tier first, the cheapest within it.
  const distance = (row) => (tier ? Math.abs(tierRank(row.tier) - tierRank(tier)) : 0);
  const rest = CATALOG_PROVIDERS.filter(providerOk)
    .flatMap((provider) => visibleRows(catalog, provider).filter((row) => row.status !== 'unavailable').map((row) => ({ provider, row })))
    .sort((a, b) => distance(a.row) - distance(b.row) || outPrice(a.row) - outPrice(b.row));
  for (const { provider, row } of rest) {
    const t = pick({ kind: 'dispatch', provider, model: row.id, effort: null });
    if (t) return { target: t, moved: true, step: 'closest_tier' };
  }
  return { declined: true, dry: dryProviders(coverage) };
}

/**
 * The capability rules a target of `request` must meet: not disabled, a listed model, the medium it must
 * make (image / video creation), sight (design: a confirmed vision on an available row; other vision
 * work: not a confirmed blind one). → (target) => boolean
 */
export function capableFor(request, { catalog = null, brain = {}, brainInfo = null } = {}) {
  const medium = request?.needsOutput || null;
  const visionOnly = request?.visionOnly === true;
  return (target) => {
    if (!target?.provider || isDisabled(catalog, target)) return false;
    if (target.model && findModel(catalog, target.provider, target.model) === null) return false;
    if (medium && !targetMakes(catalog, target, medium)) return false;
    if (request?.needsVision) {
      if (visionOnly ? designFit(catalog, target, { brain, brainInfo }) !== 'ok' : describeTarget(target, { catalog, brain, brainInfo })?.vision === false) return false;
    }
    return true;
  };
}
/**
 * An approved route whose provider ran out of share after approval: move the dispatch the same way
 * agent_route would (budgetReroute). A decline names the dry providers or the unpriced host provider.
 */
export function budgetMove({ target, request, catalog = null, brain = {}, brainInfo = null, routing = {}, coverage = null }) {
  if (!coverage || budgetCovers(coverage, catalog, target)) return { target, correction: null };
  const moved = budgetReroute({ target, request, catalog, brain, routing, coverage, capable: capableFor(request, { catalog, brain, brainInfo }) });
  if (moved.declined) return moved;
  const next = effortChecked(request.dispatchOnly && moved.target.kind !== 'dispatch' ? { ...moved.target, kind: 'dispatch' } : moved.target, catalog);
  return {
    target: next,
    correction: { field: 'route', from: routeText(target), to: routeText(next), reason: 'budget_share', step: moved.step, text: `budget: ${dryText(coverage, target.provider)} -> ${next.provider}/${next.model || 'default'}` },
  };
}

/**
 * Decide whether the user must be asked. Returns
 * { ask, reasons[], auto: target|null, proposal: target, corrections[], source }.
 * `auto` is the target to run when ask === false. For image / video creation
 * with no model in the catalog that makes the medium, and for design with none
 * that can see, it returns { ask: false, unavailable: 'no_capable_model', auto: null }
 * in every mode.
 *
 * `budget` ({ coverage }: assistant-budget-split.js coverageOf, null under No limit): a target whose
 * provider has no share left moves to the next capable provider with money (budgetReroute) and the
 * corrections say so (reason budget_share); with a budget the saved routes yield to this. When nothing
 * can pay: { ask: false, unavailable: 'budget_exhausted', dry }. An unpriced host returns
 * 'budget_unpriced'. Otherwise `budgetFrom` names the target whose share can be re-split.
 */
export function evaluateRoute({ mode, routing = {}, request, brain = {}, brainInfo = null, catalog = null, budget = null }) {
  const reasons = [];
  const corrections = [];
  const effective = normalizeRouteMode(mode) || 'ask-unsure';
  // Always Ask is a task-local choice; the Never Ask table must not seed it.
  if (effective === 'always-ask') routing = { ...routing, preferences: {} };
  const first = request.proposals[0];
  let proposal = { kind: first.kind, provider: first.provider, model: first.model, effort: first.effort };
  if (first.accountId) proposal.accountId = first.accountId;
  let source = 'brain';
  if (request.taskClass === 'chat') {
    return { ask: false, reasons, auto: { kind: 'direct', provider: brain.provider, model: brain.model || null, effort: brain.effort || null }, proposal, corrections, source };
  }
  const label = TASK_CLASS_META[request.taskClass]?.label || request.taskClass;
  // Image / video creation runs only on a worker whose model generates the medium; design on one that can see.
  const medium = request.needsOutput || null;
  const dispatchOnly = request.dispatchOnly === true;
  const visionOnly = request.visionOnly === true;
  if ((medium && !anyMaker(catalog, medium)) || (visionOnly && !anySeer(catalog))) {
    return { ask: false, unavailable: 'no_capable_model', reasons: ['no_capable_model'], auto: null, proposal, corrections, source, bound: false };
  }
  if (request.coercedDirect) {
    corrections.push({ field: 'kind', from: 'direct', to: 'dispatch', reason: 'dispatch_only', text: `${label} always runs on a worker, not here` });
  }
  // "Here" on another provider was always a worker: the result now says so instead of changing the kind silently.
  if (request.coercedProvider) corrections.push(otherProviderCorrection(request.coercedProvider, brain));
  const sees = (target) => describeTarget(target, { catalog, brain, brainInfo })?.vision;
  const fit = (target) => designFit(catalog, target, { brain, brainInfo });
  // Too blind for this task: design needs a confirmed true (null never counts) on an available row; other vision work refuses a confirmed false.
  const tooBlind = (target) => (visionOnly ? fit(target) !== 'ok' : sees(target) === false);
  // The session budget: a target whose provider has no share left moves (every capability rule holds).
  const coverage = budget?.coverage || null;
  const capable = capableFor(request, { catalog, brain, brainInfo });
  /** → { target } (the same one, or moved with a budget_share correction), or { declined } (nothing can pay). */
  const applyBudget = (target) => {
    if (!coverage || !target) return { target };
    const moved = budgetReroute({ target, request, catalog, brain, routing, coverage, capable });
    if (moved.declined) return { ...moved, from: target };
    if (!moved.moved) return { target };
    const next = effortChecked(dispatchOnly && moved.target.kind !== 'dispatch' ? { ...moved.target, kind: 'dispatch' } : moved.target, catalog, corrections);
    corrections.push({
      field: 'route', from: routeText(target), to: routeText(next), reason: 'budget_share', step: moved.step,
      text: `budget: ${dryText(coverage, target.provider)} -> ${next.provider}/${next.model || 'default'}`,
    });
    return { target: next, from: target };
  };
  const budgetDeclined = (outcome) => {
    const unavailable = outcome.unpriced ? 'budget_unpriced' : 'budget_exhausted';
    return {
      ask: false, unavailable, reasons: [unavailable], auto: null, proposal, corrections, source, bound: false,
      dry: outcome.dry || [], budgetFrom: outcome.unpriced ? null : outcome.from,
    };
  };
  const remembered = preferenceTarget(routing.preferences?.[request.taskClass], brain, null, request);
  const disabled = !!remembered && isDisabled(catalog, remembered);
  // A saved route onto a model that cannot make the medium (or, for design, is not known to see) is not applied either.
  const incapable = !!remembered && !disabled && (!targetMakes(catalog, remembered, medium) || (visionOnly && tooBlind(remembered)));
  const fitsHost = !request.needsHost || runsHere(remembered, brain);
  const pref = remembered && !disabled && !incapable && fitsHost ? remembered : null;
  // In either asking mode, a proposal of the saved target carries its saved account too.
  if (pref && sameTarget({ ...proposal, accountId: null, effort: null }, { ...pref, accountId: null, effort: null }) && (!pref.effort || pref.effort === proposal.effort) && (pref.accountId || proposal.accountId)) proposal.accountId = pref.accountId || null;
  // Omitted model: a remembered preference for the class fills it.
  if (!proposal.model && proposal.kind === 'dispatch') {
    if (pref && (pref.provider === proposal.provider || !first.model)) { proposal = { ...pref, effort: proposal.effort || pref.effort }; source = 'remembered'; }
    else if (remembered && disabled && (remembered.provider === proposal.provider || !first.model)) {
      // The user hid the remembered route's model since.
      reasons.push('model_disabled');
      corrections.push({ field: 'model', from: remembered.model, to: null, reason: 'model_disabled' });
    } else reasons.push('model_missing');
  }
  if (proposal.kind === 'direct' && !proposal.model) proposal.model = brain.model || null;
  // The effort is checked against the model it will run on (a merged preference included).
  proposal = effortChecked(proposal, catalog, corrections);
  if (proposal.model && findModel(catalog, proposal.provider, proposal.model) === null) reasons.push(isDisabled(catalog, proposal) ? 'model_disabled' : 'model_unknown');
  else if (!proposal.model && isDisabled(catalog, proposal) && !reasons.includes('model_disabled')) reasons.push('model_disabled');
  if (request.needsVision && tooBlind(proposal)) reasons.push(visionOnly && fit(proposal) === 'unavailable' ? 'model_unavailable' : 'needs_vision');
  if (medium && !targetMakes(catalog, proposal, medium)) reasons.push('needs_output');
  if (request.confidence === null) reasons.push('no_confidence');
  else if (request.confidence < (routing.askBelow ?? 0.75)) reasons.push('low_confidence');

  if (effective === 'always-ask' || effective === 'ask-unsure') {
    // The suggestion a card shows (or the pick that runs) is one the budget can pay for.
    const budgeted = applyBudget(proposal);
    if (budgeted.declined) return budgetDeclined(budgeted);
    const budgetFrom = budgeted.from || null;
    if (budgetFrom) { proposal = budgeted.target; source = 'budget'; }
    if (effective === 'always-ask') return { ask: true, reasons: ['always-ask', ...reasons], auto: null, proposal, corrections, source, budgetFrom };
    const unsure = reasons.filter((r) => r !== 'no_confidence' || (source !== 'remembered' && source !== 'budget'));
    if (unsure.length) return { ask: true, reasons: unsure, auto: null, proposal, corrections, source, budgetFrom };
    return { ask: false, reasons, auto: proposal, proposal, corrections, source, budgetFrom };
  }
  // never: the user's saved route for the class binds (the brain only classifies);
  // without an enabled one, run the brain's pick, correcting what cannot run.
  let auto = { ...proposal };
  const bound = !!pref;
  if (bound) {
    // Provider and model from the saved route; its effort when set, else the brain's.
    auto = { ...pref, model: pref.model || (pref.kind === 'direct' ? brain.model || null : null), effort: pref.effort || proposal.effort || null };
    const pinnedPref = pinnedDefault(catalog, auto);
    if (pinnedPref) auto = { ...auto, model: pinnedPref.id };
    if (!sameTarget({ ...auto, effort: null }, { ...proposal, effort: null }) || (pref.effort && pref.effort !== proposal.effort)) {
      corrections.push({
        field: 'route', from: routeText(proposal), to: routeText(auto), reason: 'remembered_route',
        text: `saved ${label} route ${routeText(auto)} replaced ${routeText(proposal)}`,
      });
    }
    source = 'remembered';
  } else {
    if (remembered && disabled && request.taskClass !== 'chat' && !corrections.some((c) => c.reason === 'model_disabled' && c.from === remembered.model)) {
      // A saved route on a model the user hid since is not applied: the brain's pick stands.
      corrections.push({
        field: 'route', from: routeText(remembered), to: null, reason: 'remembered_disabled',
        text: `saved ${label} route ${routeText(remembered)} is disabled in the Models list; kept the assistant's pick`,
      });
    } else if (incapable) {
      // A saved image / video creation route onto a model that cannot make the medium, or a design route onto one not known to see.
      const verdict = medium && !targetMakes(catalog, remembered, medium) ? null : fit(remembered);
      const cannot = !verdict ? `cannot make ${MEDIUM_WORDS[medium] || medium}`
        : verdict === 'blind' ? 'cannot see images' : verdict === 'unavailable' ? 'is unavailable' : 'is not known to see images';
      corrections.push({
        field: 'route', from: routeText(remembered), to: null, reason: 'remembered_incapable',
        text: `saved ${label} route ${routeText(remembered)} ${cannot}; not applied`,
      });
    } else if (remembered && !fitsHost) {
      corrections.push({
        field: 'route', from: routeText(remembered), to: null, reason: 'remembered_host',
        text: `The saved ${label} route ${routeText(remembered)} needs a worker. This task requires host access.`,
      });
    }
    const invalid = reasons.find((r) => r === 'model_unknown' || r === 'model_disabled');
    if (invalid && auto.model) {
      corrections.push({ field: 'model', from: auto.model, to: null, reason: invalid });
      auto = { ...auto, model: request.needsHost ? brain.model || null : null };
    }
    // No model and the provider default is hidden: name the visible stand-in.
    const pinned = pinnedDefault(catalog, auto);
    if (pinned) auto = { ...auto, model: pinned.id };
    // Every model of the provider is hidden: the strongest visible Claude model takes it
    // (image / video creation: a model that makes the medium does, below).
    if (isDisabled(catalog, auto) && !auto.model && !medium) {
      const alt = strongestClaude(catalog);
      if (alt && auto.provider !== 'claude-code') { corrections.push({ field: 'provider', from: auto.provider, to: 'claude-code', reason: 'model_disabled' }); auto = { kind: 'dispatch', provider: 'claude-code', model: alt.id, effort: null }; }
    }
  }
  // Image / video creation weighs vision and output together below, so one fix cannot undo the other.
  if (request.needsVision && !medium && tooBlind(auto)) {
    if (visionOnly) {
      // Design: the saved route when it can see, else the cheapest model that can on the same provider, else anywhere.
      const seer = sightFallback(catalog, auto.provider, { brain, routing, taskClass: request.taskClass });
      if (seer) {
        corrections.push(fit(auto) === 'unavailable'
          ? { field: 'model', from: routeText(auto), to: routeText(seer), reason: 'model_unavailable', text: `${label} needs an available model that can see: ${routeText(auto)} is unavailable → ${routeText(seer)}` }
          : { field: 'model', from: routeText(auto), to: routeText(seer), reason: 'needs_vision', text: `${label} needs a model that can see: ${routeText(auto)} → ${routeText(seer)}` });
        auto = seer;
      }
    } else {
      const vision = visionFallback(catalog, auto.provider, { brain, routing });
      if (vision) { corrections.push({ field: 'model', from: auto.model, to: vision.model, reason: 'needs_vision' }); auto = vision; }
    }
  }
  if (medium) {
    const makes = targetMakes(catalog, auto, medium);
    const blind = request.needsVision && sees(auto) === false;
    if (!makes || blind) {
      // The saved route when it can, else the cheapest maker on the same provider, else anywhere (one that can see first).
      const maker = generationFallback(catalog, auto.provider, medium, { brain, routing, taskClass: request.taskClass, needsVision: request.needsVision });
      // A maker that cannot see is only swapped for one that can.
      if (maker && (!makes || sees(maker) === true)) {
        const words = MEDIUM_WORDS[medium] || medium;
        corrections.push(makes
          ? { field: 'model', from: routeText(auto), to: routeText(maker), reason: 'needs_vision', text: `${label} needs a model that can see the image it works from: ${routeText(auto)} → ${routeText(maker)}` }
          : { field: 'model', from: routeText(auto), to: routeText(maker), reason: 'needs_output', text: `${label} needs a model that makes ${words}${request.needsVision && sees(maker) === true ? ' and can see' : ''}: ${routeText(auto)} → ${routeText(maker)}` });
        auto = maker;
      }
    }
  }
  if (request.needsHost && (auto.kind !== 'direct' || isDisabled(catalog, auto) || (request.needsVision && tooBlind(auto)))) {
    return { ask: true, reasons, auto: null, proposal, corrections, source };
  }
  if (dispatchOnly && auto.kind !== 'dispatch') auto = { ...auto, kind: 'dispatch' };
  // A corrected model or provider re-checks the effort.
  auto = effortChecked(auto, catalog, corrections);
  // The provider rule only names what always happened (a "here" elsewhere is a worker): it corrects nothing.
  if (!bound && corrections.some((c) => !['remembered_disabled', 'remembered_incapable', 'remembered_host', 'other_provider'].includes(c.reason))) source = 'corrected';
  // With a budget the saved route yields: a provider with no share left moves the task on.
  const budgeted = applyBudget(auto);
  if (budgeted.declined) return budgetDeclined(budgeted);
  if (budgeted.from) { auto = budgeted.target; source = 'budget'; }
  return { ask: false, reasons, auto, proposal, corrections, source, bound, budgetFrom: budgeted.from || null };
}

function optionFor(id, rawTarget, badge, { catalog, brain, brainInfo, needsVision, needsOutput = null, visionOnly = false, reason = null, coverage = null }) {
  const target = effortChecked(rawTarget, catalog);
  const d = describeTarget(target, { catalog, brain, brainInfo });
  const here = target.kind === 'direct';
  const label = here ? `Do it here with ${d.label}` : `${providerLabel(target.provider)} · ${d.label}${target.effort ? ` · ${effortWord(target.effort)}` : ''}`;
  // Design: only a confirmed vision: true on an available row; other vision work: a confirmed false is disabled, unknown is a warning.
  const fit = visionOnly ? designFit(catalog, target, { brain, brainInfo }) : 'ok';
  const option = {
    id, kind: target.kind, provider: target.provider, model: target.model || null, effort: target.effort || null,
    ...(Object.hasOwn(target, 'accountId') ? { accountId: target.accountId } : {}),
    // A design card shows sight as design judges it (an unlisted claude-* id is unknown there).
    label, badge, tier: d.tier, vision: fit === 'unknown' ? null : d.vision, price: d.price, contextWindow: d.contextWindow,
    reason: reason || null, warning: null, disabled: false, disabledReason: null,
  };
  if (needsOutput) option.outputs = d.outputs || null;
  if (isDisabled(catalog, target)) { option.disabled = true; option.disabledReason = providerEmpty(catalog, target.provider) ? 'No model of this provider is connected.' : MODEL_DISABLED_TEXT; }
  else if (needsOutput && !targetMakes(catalog, target, needsOutput)) { option.disabled = true; option.disabledReason = cannotMakeText(needsOutput); }
  else if (fit !== 'ok') { option.disabled = true; option.disabledReason = fitText(fit); }
  else if (needsVision && d.vision === false) { option.disabled = true; option.disabledReason = 'This model cannot see images, and this task needs to.'; }
  else if (needsVision && d.vision === null) option.warning = 'Image support unknown for this model.';
  // The session budget: a provider with no share left cannot take the task (a free model still can), and one
  // that reports no prices cannot run under a budget at all.
  if (!option.disabled && coverage && !budgetCovers(coverage, catalog, target)) {
    const unpriced = coverage.leftUsd < 0.01 ? null : unpricedText(target.provider);
    option.disabled = true;
    option.budget = unpriced ? 'unpriced' : 'share_used_up';
    option.disabledReason = unpriced || (coverage.leftUsd < 0.01 ? "Budget: this session's budget is spent." : `Budget: the ${providerLabel(target.provider)} share of this session's budget is used up.`);
  }
  if (here && brainInfo?.contextWindow && d.contextWindow && d.contextWindow < brainInfo.contextWindow) {
    option.warning = `Smaller context (${Math.round(d.contextWindow / 1000)}k) than the current model; a long conversation may not fit.`;
  }
  return option;
}

export function providerLabel(provider) {
  return provider === 'claude-code' ? 'Claude Code' : provider === 'codex' ? 'Codex' : provider === 'opencode' ? 'OpenCode' : provider === 'antigravity' ? 'Antigravity' : String(provider || 'Assistant');
}

/** Why a session with a budget cannot run `provider` at all (it reports tokens, never prices), else null. */
export function unpricedText(provider) {
  return isUnpricedProvider(provider) ? `Budget: ${providerLabel(provider)} reports tokens, not prices, so a session with a budget cannot run it. Pick another option, or switch the budget to No limit.` : null;
}

/** `seeingOnly` (design): only rows with a confirmed vision: true, where `needsVision` only drops a confirmed false. */
function neighbour(catalog, anchor, direction, { needsVision = false, seeingOnly = false, needsOutput = null } = {}) {
  const all = visibleRows(catalog, anchor.provider).filter((row) => row.status !== 'unavailable' && row.toolcall !== false && (!needsVision || row.vision !== false) && (!seeingOnly || row.vision === true) && (!needsOutput || rowMakes(row, needsOutput)));
  // A "default" alias duplicates a real model row: prefer the real id.
  const rows = all.filter((row) => !(row.id === 'default' && all.some((other) => other.id !== 'default' && other.upstream === row.upstream)));
  if (!rows.length) return null;
  const current = anchor.model ? findModel(catalog, anchor.provider, anchor.model)?.row : defaultModelRow(catalog, anchor.provider);
  const rank = tierRank(current?.tier);
  const price = outPrice(current);
  const others = rows.filter((row) => row.id !== current?.id && row.upstream !== current?.upstream);
  if (direction === 'cheaper') {
    const pool = others.filter((row) => tierRank(row.tier) < rank || (tierRank(row.tier) === rank && outPrice(row) < price));
    pool.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || outPrice(a) - outPrice(b));
    return pool[0] || null;
  }
  // Stronger = the cheapest model of the next tier up; only when there is no
  // higher tier, a pricier model of the same tier.
  const higher = others.filter((row) => tierRank(row.tier) > rank);
  if (higher.length) {
    higher.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || outPrice(a) - outPrice(b));
    return higher[0];
  }
  const same = others.filter((row) => tierRank(row.tier) === rank && Number.isFinite(outPrice(row)) && outPrice(row) > price);
  same.sort((a, b) => outPrice(a) - outPrice(b));
  return same[0] || null;
}

/** First large-tier Claude row, preferring a real id over the "default" alias. */
function strongestClaude(catalog) {
  const rows = visibleRows(catalog, 'claude-code').filter((row) => row.tier === 'large' && row.status !== 'unavailable');
  return rows.find((row) => row.id !== 'default') || rows[0] || null;
}

/**
 * Route-card options: here, the brain's proposals, remembered, cheaper, stronger.
 * Image / video creation: no "here" (always a worker), models that cannot make
 * the medium disabled, and — when the suggestion cannot — the model that would
 * run it instead (badge "capable"). Design: the same with "can see".
 *
 * Both sides, always: the card switches between Here (kind "direct": this
 * conversation, on its model or another of its provider) and Dispatch (a worker).
 * A side the options leave without one that can run gets one: a worker on the
 * brain's own model ("w1", badge "current"), else a capable model of its provider,
 * else elsewhere; a "here" on a model of the brain's provider that can see when the
 * brain cannot ("h1", badge "capable"). Worker-only classes get no "here".
 * → { options, defaultOptionId, sides, defaults } (routeSides).
 */
export function buildRouteOptions({ request, evaluation, brain = {}, brainInfo = null, catalog = null, routing = {}, coverage = null }) {
  const alwaysAsk = evaluation.reasons?.includes('always-ask') === true;
  const medium = request.needsOutput || null;
  const dispatchOnly = request.dispatchOnly === true;
  const visionOnly = request.visionOnly === true;
  const ctx = { catalog, brain, brainInfo, needsVision: request.needsVision, needsOutput: medium, visionOnly, coverage };
  const options = [];
  const push = (option) => {
    if (request.needsHost && !runsHere(option, brain)) return;
    if (!options.some((o) => sameTarget(o, option))) options.push(option);
  };
  const hereTarget = { kind: 'direct', provider: brain.provider, model: brain.model || null, effort: brain.effort || null };
  // A direct pick on the brain's own model with no effort is "here" as the brain runs now: one row, not two.
  const onBrainModel = (t) => t.kind === 'direct' && t.provider === brain.provider && String(t.model || '') === String(brain.model || '');
  request.proposals.forEach((p, index) => {
    const target = { kind: p.kind, provider: p.provider, model: p.model || (index === 0 ? evaluation.proposal?.model || null : null), effort: p.effort };
    if (index === 0 && evaluation.proposal) Object.assign(target, evaluation.proposal);
    if (onBrainModel(target) && !target.effort && brain.effort) target.effort = brain.effort;
    push(optionFor(`s${index + 1}`, target, 'suggested', { ...ctx, reason: p.reason }));
  });
  // The session budget moved the suggestion: the brain's own pick stays on the card, disabled with why.
  if (evaluation.budgetFrom && coverage) push(optionFor('b0', evaluation.budgetFrom, 'suggested', { ...ctx, reason: request.proposals[0]?.reason || null }));
  if (!dispatchOnly) push(optionFor('here', hereTarget, 'current', ctx));
  const pref = preferenceTarget(routing.preferences?.[request.taskClass], brain, catalog, request);
  // Always ask: the saved route is offered and its side starts on it (never binding: the card still asks).
  if (pref) {
    const saved = optionFor('r1', pref, 'remembered', ctx);
    // A proposal of the same target keeps its row and carries the mark.
    const row = options.find((o) => sameTarget(o, saved)) || saved;
    if (alwaysAsk && !saved.disabled) Object.assign(row, { preferred: true, saved: true });
    push(saved);
  }
  const anchor = evaluation.proposal?.kind === 'dispatch' || dispatchOnly ? evaluation.proposal || request.proposals[0] : hereTarget;
  const cheaper = neighbour(catalog, anchor, 'cheaper', { needsVision: request.needsVision, seeingOnly: visionOnly, needsOutput: medium });
  if (cheaper) push(optionFor('c1', { kind: anchor.provider === brain.provider && anchor.kind === 'direct' ? 'direct' : 'dispatch', provider: anchor.provider, model: cheaper.id, effort: null }, 'cheaper', ctx));
  let stronger = neighbour(catalog, anchor, 'stronger', { needsVision: request.needsVision, seeingOnly: visionOnly, needsOutput: medium });
  let strongerProvider = anchor.provider;
  if (!stronger && anchor.provider !== 'claude-code' && !medium) {
    stronger = strongestClaude(catalog);
    strongerProvider = 'claude-code';
  }
  if (stronger) push(optionFor('x1', { kind: strongerProvider === brain.provider && anchor.kind === 'direct' ? 'direct' : 'dispatch', provider: strongerProvider, model: stronger.id, effort: null }, 'stronger', ctx));
  const suggestion = evaluation.proposal || request.proposals[0];
  if (medium && (!targetMakes(catalog, suggestion, medium) || (request.needsVision && describeTarget(suggestion, { catalog, brain, brainInfo })?.vision === false))) {
    const maker = generationFallback(catalog, anchor.provider, medium, { brain, routing, taskClass: request.taskClass, needsVision: request.needsVision });
    const option = maker ? optionFor('g1', maker, 'capable', ctx) : null;
    if (option && !option.disabled) push(option);
  }
  if (visionOnly && !medium && designFit(catalog, suggestion, { brain, brainInfo }) !== 'ok') {
    const seer = sightFallback(catalog, anchor.provider, { brain, routing, taskClass: request.taskClass });
    const option = seer ? optionFor('g1', seer, 'capable', ctx) : null;
    if (option && !option.disabled) push(option);
  }
  // Both sides, always: a side with nothing that can run it gets the first candidate that can
  // (or, with none, the first candidate disabled with why, so the card can say it).
  // A saved route on an account is checked later (it may be signed out): it does not count, so its side keeps a fallback.
  const runnable = (kind) => options.some((o) => o.kind === kind && !o.disabled && !(o.saved && o.accountId));
  const offer = (kind, id, candidates) => {
    let first = null;
    for (const [target, badge] of candidates) {
      if (!target?.provider) continue;
      const option = optionFor(id, target, badge, ctx);
      if (options.some((o) => sameTarget(o, option))) continue;
      if (!option.disabled) { push(option); return; }
      first = first || option;
    }
    if (first && !options.some((o) => o.kind === kind)) push(first);
  };
  if (request.taskClass !== 'chat' && !dispatchOnly && !runnable('direct')) offer('direct', 'h1', hereCandidates({ request, catalog, brain }));
  if (!request.needsHost && request.taskClass !== 'chat' && !runnable('dispatch')) offer('dispatch', 'w1', workerCandidates({ request, catalog, brain, brainInfo }));
  // Order: suggested first, then here, remembered, a capable stand-in, cheaper, stronger.
  const order = { suggested: 0, current: 1, remembered: 2, capable: 3, cheaper: 4, stronger: 5 };
  options.sort((a, b) => (order[a.badge] ?? 9) - (order[b.badge] ?? 9) || String(a.id).localeCompare(String(b.id)));
  return { options, ...routeSides({ options, request }) };
}

/**
 * "Here" on another model of the brain's provider when "here" itself cannot run the task
 * (the brain cannot see a computer task's screen, or the user hid its model): the
 * cheapest one of that provider that can (one that can see first for vision work).
 */
function hereCandidates({ request, catalog, brain }) {
  if (!brain.provider) return [];
  const rows = visibleRows(catalog, brain.provider)
    .filter((row) => row.status !== 'unavailable' && row.toolcall !== false && row.id !== brain.model && (!request.needsVision || row.vision === true))
    .sort((a, b) => outPrice(a) - outPrice(b) || tierRank(a.tier) - tierRank(b.tier));
  return rows.map((row) => [{ kind: 'direct', provider: brain.provider, model: row.id, effort: null }, request.needsVision ? 'capable' : null]);
}

/**
 * A worker for a card whose options have none that can run: the brain's own model on a
 * worker (the same model, off this conversation), else a model of its provider that can
 * (the brain's tier first, one that can see for vision work), else elsewhere (one that
 * can see, or the strongest Claude model).
 */
function workerCandidates({ request, catalog, brain, brainInfo }) {
  const candidates = [];
  if (brain.provider) candidates.push([{ kind: 'dispatch', provider: brain.provider, model: brain.model || null, effort: brain.effort || null }, 'current']);
  const brainTier = brainInfo?.tier || (brain.model ? findModel(catalog, brain.provider, brain.model)?.row?.tier : null) || null;
  const fits = (row) => row.status !== 'unavailable' && row.toolcall !== false && (!request.needsVision || row.vision === true);
  const closeness = (row) => (brainTier ? Math.abs(tierRank(row.tier) - tierRank(brainTier)) : 0);
  const badge = request.needsVision ? 'capable' : null;
  if (brain.provider) {
    visibleRows(catalog, brain.provider).filter(fits).filter((row) => row.id !== brain.model)
      .sort((a, b) => closeness(a) - closeness(b) || outPrice(a) - outPrice(b))
      .forEach((row) => candidates.push([{ kind: 'dispatch', provider: brain.provider, model: row.id, effort: null }, badge]));
  }
  if (request.needsVision) {
    CATALOG_PROVIDERS.filter((p) => p !== brain.provider)
      .flatMap((p) => visibleRows(catalog, p).filter(fits).map((row) => ({ provider: p, row })))
      .sort((a, b) => outPrice(a.row) - outPrice(b.row) || tierRank(a.row.tier) - tierRank(b.row.tier))
      .forEach(({ provider, row }) => candidates.push([{ kind: 'dispatch', provider, model: row.id, effort: null }, 'capable']));
  } else if (brain.provider !== 'claude-code') {
    const opus = strongestClaude(catalog);
    if (opus) candidates.push([{ kind: 'dispatch', provider: 'claude-code', model: opus.id, effort: null }, null]);
  }
  return candidates;
}

/**
 * Which side of the card's Here / Dispatch switch can run the task, and the option each side
 * starts on: { sides: { direct, dispatch }, defaults: { direct, dispatch }, defaultOptionId }.
 * A side is { available, reason, code } (code: worker_only, account_worker, disabled, none).
 * Read from the options as they are sent, after the account check (a "here" that moved to a
 * worker belongs to the dispatch side: its kind is "dispatch").
 */
export function routeSides({ options = [], request = {}, defaultOptionId = null } = {}) {
  const usable = (o) => o && !o.disabled;
  const chosen = options.find((o) => o.id === defaultOptionId && usable(o))
    || options.find((o) => o.badge === 'suggested' && usable(o)) || options.find(usable) || options[0] || null;
  // A side starts on the saved route when Always ask marked it (preferred), else on the chosen option, else its first.
  const firstOf = (kind) => options.find((o) => o.preferred === true && o.kind === kind && usable(o))
    || (chosen?.kind === kind && usable(chosen) ? chosen : null) || options.find((o) => o.kind === kind && usable(o)) || null;
  const label = request.taskClassLabel || TASK_CLASS_META[request.taskClass]?.label || 'This task';
  const side = (kind) => {
    if (kind === 'dispatch' && request.needsHost) return { available: false, code: 'host_only', reason: 'This task requires host access in this conversation.' };
    if (firstOf(kind)) return { available: true, reason: null, code: null };
    if (kind === 'direct' && request.dispatchOnly) return { available: false, code: 'worker_only', reason: request.plannedSplit ? 'This task uses the approved worker plan.' : `${label} always runs on a worker.` };
    if (kind === 'direct' && options.some((o) => o.kind === 'dispatch' && o.accountKind === 'direct')) {
      return { available: false, code: 'account_worker', reason: "This conversation's account cannot take it, so it runs on a worker." };
    }
    const blocked = options.find((o) => o.kind === kind && o.disabled);
    if (blocked) return { available: false, code: 'disabled', reason: blocked.disabledReason || null };
    return { available: false, code: 'none', reason: kind === 'direct' ? 'Nothing in this conversation can run this task.' : 'No worker model can run this task.' };
  };
  return {
    // The card opens on the chosen option's side, on that side's default.
    defaultOptionId: (chosen && usable(chosen) ? firstOf(chosen.kind)?.id : null) || chosen?.id || 'here',
    sides: { direct: side('direct'), dispatch: side('dispatch') },
    defaults: { direct: firstOf('direct')?.id || null, dispatch: firstOf('dispatch')?.id || null },
  };
}

function hostRouteError() {
  return routeError('ROUTE_IS_DIRECT', 'This task requires host access. Run it here in the Assistant conversation.', 409);
}

/** Validate a route-card answer; returns { declined } or { target, optionId, remember }. */
export function targetFromAnswer({ card, response = {}, catalog = null, brain = {} }) {
  if (response.decline === true || response.behavior === 'deny' || response.cancel === true) return { declined: true };
  const optionId = String(response.optionId || response.option_id || '').trim();
  const remember = response.remember === true || (typeof response.remember === 'string' && response.remember.length > 0);
  const option = optionId && optionId !== 'other' ? (card.options || []).find((o) => o.id === optionId) : null;
  // The model this conversation already runs on needs no catalog entry to stay on (an OpenCode model
  // no longer listed as connected, an id the list spells otherwise): "here" on it changes nothing.
  // A hidden one is still refused, as everywhere.
  const onBrain = (target) => target.kind === 'direct' && !!brain.model && target.provider === brain.provider && String(target.model || '') === String(brain.model);
  // A card can remain open while the catalog or hidden-model list changes.
  // Check the chosen target again instead of trusting the option's old state.
  const ensureAvailable = (target) => {
    if (card.needsHost && !runsHere(target, brain)) throw hostRouteError();
    const own = onBrain(target);
    if (target.model && (own ? isDisabled(catalog, target) : findModel(catalog, target.provider, target.model) === null)) {
      if (isDisabled(catalog, target)) throw routeError('MODEL_DISABLED', `${target.model} is disabled in the Assistant's Models list. Pick an enabled model.`);
      throw routeError('ROUTE_INVALID', `Unknown model ${target.model} for ${target.provider}.`);
    }
    if (!own && findModel(catalog, target.provider, target.model)?.row?.status === 'unavailable') throw routeError('ROUTE_INVALID', UNAVAILABLE_TEXT);
    if (!target.model && isDisabled(catalog, target)) throw routeError('MODEL_DISABLED', `Every ${target.provider} model is disabled in the Assistant's Models list. Pick another provider.`);
    // Design: only a confirmed vision: true on an available row (unknown or unavailable is refused too);
    // other vision work: a confirmed false.
    if (card.visionOnly) {
      const verdict = designFit(catalog, target, { brain });
      if (verdict !== 'ok') throw routeError('ROUTE_INVALID', fitText(verdict));
    } else if (card.needsVision && describeTarget(target, { catalog, brain })?.vision === false) {
      throw routeError('ROUTE_INVALID', 'This model cannot see images, and this task needs to.');
    }
    if (card.needsOutput && !targetMakes(catalog, target, card.needsOutput)) throw routeError('ROUTE_INVALID', cannotMakeText(card.needsOutput));
  };
  // Image / video creation and design always run on a worker: a "here" pick is a dispatch onto that model.
  const dispatchOnly = card.dispatchOnly === true;
  // Only the brain's own provider runs in this conversation: a "here" on another one (an option made
  // before the brain changed provider, or an "other" pick) is a worker, and the answer says so.
  const elsewhere = (provider) => !!brain.provider && provider !== brain.provider;
  if (option) {
    if (option.disabled && !option.accountError) throw routeError('ROUTE_INVALID', option.disabledReason || 'That option is not available for this task.');
    const corrections = [];
    const moved = !dispatchOnly && option.kind === 'direct' && elsewhere(option.provider);
    if (moved) corrections.push(otherProviderCorrection(option.provider, brain));
    const kind = dispatchOnly || moved ? 'dispatch' : option.kind;
    const target = effortChecked({ kind, provider: option.provider, model: option.model || (dispatchOnly && option.kind === 'direct' ? brain.model || null : null), effort: option.effort, ...(option.accountId ? { accountId: option.accountChoice || option.accountId, ...(option.accountKind ? { accountKind: dispatchOnly || moved ? 'dispatch' : option.accountKind } : {}) } : {}) }, catalog, corrections);
    ensureAvailable(target);
    return { target, optionId, remember, corrections };
  }
  const t = response.target;
  if (!t || typeof t !== 'object' || !CATALOG_PROVIDERS.includes(t.provider)) throw routeError('ROUTE_INVALID', 'Pick one of the options or a catalog model.');
  const kind = t.kind === 'direct' && t.provider === brain.provider && !dispatchOnly ? 'direct' : 'dispatch';
  const corrections = [];
  if (t.kind === 'direct' && kind === 'dispatch') {
    corrections.push(dispatchOnly
      ? { field: 'kind', from: 'direct', to: 'dispatch', reason: 'dispatch_only', text: `${TASK_CLASS_META[card.taskClass]?.label || 'This task'} always runs on a worker, not here` }
      : otherProviderCorrection(t.provider, brain));
  }
  const model = t.model ? String(t.model) : card.needsHost && kind === 'direct' ? brain.model || null : null;
  const target = effortChecked({ kind, provider: t.provider, model, effort: t.effort ? String(t.effort).trim().slice(0, 40) : null, accountId: t.accountId ? String(t.accountId).trim() : null }, catalog, corrections);
  ensureAvailable(target);
  return { target, optionId: 'other', remember, corrections };
}

/**
 * One-tier escalation for a failed/blocked run (ladder → tier → remembered complex → strongest;
 * an image / video creation run only onto a model that makes the medium, so never the last two;
 * a design run only onto one that can see),
 * shaped by what kept it from finishing when Jev judged that (worker-outcome):
 *   access / needs_user → kind 'none': no target (a stronger model hits the same wall), with
 *                          what is needed; returned even at the maximum depth
 *   transient           → kind 'retry': the same provider and model, one level deeper (a design
 *                          run whose model can no longer run design escalates instead)
 *   capability / other / unjudged → kind 'escalate': the ladder, as before
 * Depth 2 caps retries and escalations alike. Nothing here escalates on its own.
 */
export function escalationFor({ run, catalog = null, routing = {}, depth = 0 }) {
  if (!run) return null;
  let reason = null;
  if (run.state === 'failed' && run.completionReason !== 'budget_cap') reason = 'failed';
  else if (run.lastResult?.status === 'blocked') reason = 'blocked';
  // A status Jev read from a message without a ## Result block is a usable result.
  else if (run.lastResult && run.lastResult.found === false && run.lastResult.source !== 'jev' && (run.state === 'idle' || run.state === 'completed')) reason = 'no_result';
  if (!reason) return null;
  const provider = run.provider;
  const current = run.model ? findModel(catalog, provider, run.model)?.row : defaultModelRow(catalog, provider);
  const from = { provider, model: run.model || null, tier: current?.tier || null };
  const judged = reason === 'failed' ? run.failure : run.lastResult;
  const cause = typeof judged?.cause === 'string' && judged.cause ? judged.cause : null;
  if (cause === 'access' || cause === 'needs_user') {
    return { reason, cause, kind: 'none', from, to: null, depth, needs: judged?.needs ? clip(judged.needs, 200) : null };
  }
  if (depth >= MAX_ESCALATION_DEPTH) return null;
  // An image / video creation run escalates only onto a model that generates the medium, a design run onto one that can see.
  const runClass = run.route?.taskClass || run.taskClass;
  const medium = requiredOutput(runClass);
  const sight = requiresVision(runClass);
  const canRun = (target) => targetMakes(catalog, target, medium) && !(sight && designFit(catalog, target) !== 'ok');
  // A design run is retried only on a model that can still run design (it sees and is available);
  // otherwise the escalation below finds one that can. With no catalog value to tell (the cache was
  // just dropped) the retry stands: the launch checks it against a fresh catalog.
  const retryable = !sight || !catalog || designFit(catalog, { kind: 'dispatch', provider, model: run.model || null }) === 'ok';
  if (cause === 'transient' && !isDisabled(catalog, { provider, model: run.model }) && retryable) {
    return { reason, cause, kind: 'retry', from, to: describeTarget(effortChecked({ kind: 'dispatch', provider, model: run.model || null, effort: run.effort || null, ...(run.accountId ? { accountId: run.accountId } : {}) }, catalog), { catalog }), depth: depth + 1 };
  }
  let to = null;
  const ladder = Array.isArray(routing.ladders?.[provider]) ? routing.ladders[provider] : null;
  if (ladder && run.model) {
    const index = ladder.indexOf(run.model);
    // The next rung the user has not hidden.
    const next = index === -1 ? null : ladder.slice(index + 1).find((model) => !isDisabled(catalog, { provider, model }) && canRun({ kind: 'dispatch', provider, model }));
    if (next) to = { kind: 'dispatch', provider, model: next, effort: null };
  }
  if (!to) {
    const stronger = neighbour(catalog, { kind: 'dispatch', provider, model: run.model || null }, 'stronger', { needsOutput: medium, seeingOnly: sight });
    if (stronger) to = { kind: 'dispatch', provider, model: stronger.id, effort: null };
  }
  if (!to && !medium) {
    const pref = routing.preferences?.complex;
    if (pref?.provider && !(pref.provider === provider && pref.model === run.model) && !isDisabled(catalog, pref) && canRun({ kind: 'dispatch', provider: pref.provider, model: pref.model || null })) to = { kind: 'dispatch', provider: pref.provider, model: pref.model || null, effort: pref.effort || null, ...(pref.accountId ? { accountId: pref.accountId } : {}) };
  }
  if (!to && provider !== 'claude-code' && !medium) {
    const opus = strongestClaude(catalog);
    if (opus && canRun({ kind: 'dispatch', provider: 'claude-code', model: opus.id })) to = { kind: 'dispatch', provider: 'claude-code', model: opus.id, effort: 'high' };
  }
  if (!to) return null;
  if (to.provider === provider && !to.accountId && run.accountId) to.accountId = run.accountId;
  return { reason, cause, kind: 'escalate', from, to: describeTarget(effortChecked(to, catalog), { catalog }), depth: depth + 1 };
}

// ── Stateful service ─────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.catalog       createAssistantCatalog() — full(), peek(), brainInfo()
 * @param {object} deps.configStore   createAssistantConfigStore() — routing(), setPreference()
 * @param {(id:string)=>({brain, routingMode}|null)} deps.getSession
 * @param {object} deps.sinks  { sendCard(sessionId, packet), cancelCard(sessionId, requestId, reason),
 *                               routeEvent(sessionId, phase, route), mailbox(sessionId, item),
 *                               continueDirect(sessionId, {target, route, text}) → false when the pick's turn is gone,
 *                               activeRouteRuns(sessionId, routeId) → [{ runId, title, state }], startHeld(runId, target, meta),
 *                               checkHeld(runId, target) → why the held run could not start on target ({ code, message, status }) or null,
 *                               declineHeld(runId, reason), routed(sessionId, result), routeFailed(sessionId, error) }
 * @param {object} [deps.clarifier] assistant-clarify.js — { blocking(sessionId, { independent }) }: while the
 *                               user has not answered the brain's questions, agent_route answers "clarifying"
 * @param {object} [deps.budget]  assistant-budget-planner.js — the session budget: the split is made at the
 *                               session's first actionable route, a provider out of share is a checkpoint, and
 *                               with a budget a task moves to a provider with money left (the saved routes yield)
 */
export function createAssistantRouter({
  catalog,
  configStore = null,
  agents = null,
  getSession = () => null,
  sinks = {},
  now = Date.now,
  continuationTimers = { setTimeout, clearTimeout },
  randomId = () => randomBytes(6).toString('hex'),
  log = () => {},
  clarifier = null,
  listAccounts = null,
  accountUsage = null,
  budget = null,
} = {}) {
  if (!catalog) throw new Error('createAssistantRouter requires a catalog');
  const cards = new Map();     // routeId → card
  const byRequest = new Map(); // requestId → routeId
  // routeId → decided route (reusable by agent_dispatch route_id; a remote session's is
  // used up by the first dispatch that starts a run: `consumed`).
  const decided = new Map();
  const continuations = new Map();
  const stamps = new Map();    // sessionId → last stamp shown to the brain
  const lastClosed = new Map(); // routeId → { routeId, settled } of recently closed cards
  const call = (name, ...args) => { try { return sinks[name]?.(...args); } catch (error) { log('router:sink-error', `${name}: ${error?.message || error}`); return undefined; } };

  // Resolve each distinct proposed role once. A different model (saved preference, budget or
  // custom card choice) can still run the proposed role. Direct choices never use a worker.
  function workerRoles(request, cwd, pin = null) {
    const roles = new Map();
    return request.proposals.map(proposal => {
      const ref = proposal.agentRequest;
      if (pin) return { agentRef: pin.ref, agentRevision: pin.revision, agentRequest: pin.ref };
      if (!roles.has(ref)) {
        const role = agents ? routedAgent(agents, request.taskClass, cwd, ref) : {};
        roles.set(ref, role.meta || (role.note ? { agentCorrection: role.note } : {}));
      }
      return roles.get(ref);
    });
  }
  function workerRole(request, target, optionId) {
    if (target?.kind !== 'dispatch' || !request.roles) return {};
    const suggestion = /^s([1-3])$/.exec(optionId || '');
    const index = suggestion ? Number(suggestion[1]) - 1 : 0;
    return request.roles[index] || request.roles[0] || {};
  }
  function agentFields(record) {
    if (!record) return {};
    const { agentRef, agentRevision, agentRequest, agentCorrection } = record;
    return { ...(agentRef ? { agentRef, agentRevision } : {}), ...(agentRequest ? { agentRequest } : {}),
      ...(agentCorrection ? { agentCorrection } : {}) };
  }
  function routing() { try { return configStore?.routing?.() || effectiveRouting({}); } catch { return effectiveRouting({}); } }
  function modeFor(sessionId) {
    const session = getSession(sessionId);
    return normalizeRouteMode(session?.routingMode) || routing().defaultMode;
  }
  async function catalogValue() {
    if (accountUsage) await accountUsage.refresh();
    try { return await catalog.full(); } catch (error) { log('router:catalog-error', error?.message || String(error)); return catalog.peek?.() || { models: {} }; }
  }
  function brainInfoFor(brain) { try { return catalog.brainInfo(brain); } catch { return null; } }
  /** Whether the session runs under a budget now (No limit, or no planner: false). */
  function budgeted() { try { return !!budget?.limited?.(); } catch { return false; } }
  function coverageOf(sessionId) { try { return budgeted() ? budget.coverage(sessionId) : null; } catch { return null; } }
  /** The shares a route result carries: { mode, amountUsd, leftUsd, providers: [{ provider, shareUsd, spentUsd, leftUsd }] }, null under No limit. */
  function compactBudget(sessionId) {
    let view = null;
    try { view = budget?.view?.(sessionId) || null; } catch { view = null; }
    if (!view) return null;
    if (view.unlimited) return { mode: 'unlimited' };
    return {
      mode: 'limited', amountUsd: view.amountUsd, spentUsd: view.spentUsd, leftUsd: view.leftUsd, source: view.split?.source || null,
      providers: (view.providers || []).map((row) => ({ provider: row.provider, shareUsd: row.shareUsd, spentUsd: row.spentUsd, leftUsd: row.workerLeftUsd, brain: row.isBrain || undefined })),
      dry: view.dry || [],
    };
  }
  /** A task the budget planner keeps for its next split (the route was approved). */
  function noteBudgetTask(sessionId, request, target) {
    if (!budgeted() || !target?.provider || request?.taskClass === 'chat') return;
    try { budget.noteTask(sessionId, { taskClass: request.taskClass, summary: request.summary || null, provider: target.provider, model: target.model || null }); } catch { /* the split goes on without it */ }
  }
  /**
   * evaluateRoute under the session budget. The split is made at the session's first actionable route
   * (the planner asks Jev, else its fallback). A target whose provider has no share left is a checkpoint:
   * the unspent budget is divided again, then the route is evaluated once more on the new shares (where
   * it may still move to another provider, or be declined). No limit: exactly evaluateRoute.
   */
  async function evaluateWithBudget(sessionId, plan) {
    if (!budgeted() || plan.request.taskClass === 'chat') return evaluateRoute(plan);
    const first = plan.request.proposals[0] || {};
    const task = { taskClass: plan.request.taskClass, summary: plan.request.summary || null, provider: first.provider || null, model: first.model || null };
    try { await budget.ensureSplit(sessionId, { task }); } catch { /* the coverage below works without a split */ }
    let evaluation = evaluateRoute({ ...plan, budget: { coverage: coverageOf(sessionId) } });
    const from = evaluation.budgetFrom;
    if (from) {
      try { await budget.ensureCovered(sessionId, { provider: from.provider, forBrain: from.kind === 'direct', free: targetIsFree(plan.catalog, from), task: { ...task, provider: from.provider, model: from.model || null } }); } catch { /* evaluated on the shares as they are */ }
      evaluation = evaluateRoute({ ...plan, budget: { coverage: coverageOf(sessionId) } });
    }
    evaluation.coverage = coverageOf(sessionId);
    return evaluation;
  }
  /** What the brain is told when no provider can pay for the task. */
  function budgetDeclinedText(sessionId, dry) {
    const view = compactBudget(sessionId);
    const money = view?.mode === 'limited' ? ` (${usdText(view.leftUsd)} of the ${usdText(view.amountUsd)} budget left)` : '';
    return `No provider has budget left for this task: ${dry.length ? `the ${dry.join(', ')} share${dry.length === 1 ? ' is' : 's are'} used up` : 'the session budget is spent'} and no unspent budget could be moved${money}. Do not start or dispatch it. Tell the user in one line that this session's budget is used up for this work, and that they can raise it or switch to No limit (Assistant → Budget).`;
  }
  /** Declined because no provider can pay (every mode, no card). */
  function budgetDeclinedResult({ sessionId, request, mode, cat, brain, brainInfo, evaluation }) {
    const routeId = `route-${randomId()}`;
    const dry = evaluation.dry || [];
    const unpriced = evaluation.unavailable === 'budget_unpriced' ? unpricedText(brain.provider) : null;
    const reasonCode = unpriced ? 'BUDGET_UNPRICED' : 'budget_exhausted';
    const route = {
      routeId, status: 'declined', sessionId, taskClass: request.taskClass, summary: request.summary, confidence: request.confidence,
      target: null, decidedBy: 'budget', remembered: false, corrections: evaluation.corrections || [], mode, runIds: [], reasonCode, dry,
      ...(unpriced ? { provider: brain.provider } : {}),
      reason: unpriced || (dry.length ? `Budget: the ${dry.join(', ')} share${dry.length === 1 ? ' is' : 's are'} used up.` : "Budget: this session's budget is spent."),
    };
    call('routeEvent', sessionId, 'declined', routeView(route, { catalog: cat, brain, brainInfo }));
    return reportSupersededRuns(request, {
      ok: true, status: 'declined', reason: evaluation.unavailable, reasonCode, dry, routeId, mode, source: 'budget', target: null,
      remembered: false, continuation: false, corrections: evaluation.corrections || [], runIds: [], expiresAt: null,
      budget: compactBudget(sessionId), next: unpriced || budgetDeclinedText(sessionId, dry),
    });
  }
  function liveAccounts(cat) { return accountUsage ? accountUsage.list() : listAccounts ? listAccounts() : cat?.accounts || {}; }
  function accountTarget(target, brain, cat, { check = true, fallback = null, select = true } = {}) {
    if (!hasRouteAccounts(target?.provider)) return target;
    const accounts = liveAccounts(cat);
    // Older hosts/test catalogs that have no account service retain their dispatch validation.
    if (!Object.hasOwn(accounts, target.provider)) return target;
    const workerKey = target.provider === 'codex' ? 'codexAccount' : 'claudeAccount';
    const defaultId = configStore?.workers?.()?.[workerKey] || 'default';
    const choice = target.accountId || (target.kind === 'direct' ? brain.accountId || 'default' : (!Object.hasOwn(target, 'accountId') && fallback) || defaultId);
    const rows = accounts[target.provider] || [];
    const { row, reason } = select ? chooseUsageAccount(rows, choice, defaultId) : { row: rows.find(a => a.id === choice), reason: null };
    const accountId = row?.id || choice;
    const before = rows.find(a => a.id === choice);
    const usage = row?.usage ? { remainingPercent: row.usage.remainingPercent, limited: row.usage.limited, resetsAt: row.usage.resetsAt } : null;
    const why = reason === 'accounts_all_limited' ? 'All subscription accounts are limited; selected the soonest reset.' : reason === 'account_limited' ? `Account ${before?.label || choice} out of usage${before?.usage?.resetsAt ? ` (resets ${before.usage.resetsAt})` : ''} → ${row?.label || accountId}, ${usage?.remainingPercent == null ? 'usage unknown' : `${Math.round(usage.remainingPercent)}% left`}.` : reason === 'account_auto' ? `Auto · most usage left → ${row?.label || accountId}, ${usage?.remainingPercent == null ? 'usage unknown; using subscription default' : `${Math.round(usage.remainingPercent)}% left`}.` : null;
    const account = row ? { id: row.id, label: row.label || row.id, mode: row.mode || null, signedIn: row.signedIn ?? null, identity: row.identity || null, ...(usage ? { usage } : {}), ...(why ? { reason: why } : {}) } : null;
    const message = !row && choice === 'auto' ? 'Auto requires a signed-in subscription account. Sign in to a Claude or ChatGPT subscription, or pin an API-key account explicitly.' : !row
      ? `Account ${accountId} was removed. Open Model routes and save a new Account choice for this route.`
      : row.signedIn === false ? `Account ${row.label || row.id} (${row.id}) is signed out. Sign it in from the ${providerLabel(target.provider)} account menu, or save another Account in Model routes.` : '';
    const accountError = message ? { code: row ? 'ACCOUNT_SIGNED_OUT' : choice === 'auto' ? 'ACCOUNT_NO_SUBSCRIPTION' : 'ACCOUNT_NOT_FOUND', message } : null;
    // Provider histories are account-owned. Another account can do the task on
    // a worker; it cannot resume this account's conversation. That move is always
    // said (a pinned account the user picked carries no usage reason of its own).
    const moved = target.kind === 'direct' && accountId !== (brain.accountId || 'default');
    const accountCorrection = why
      ? { reason, from: before?.label || choice, to: row?.label || accountId, usage, workerForAccount: moved, message: why + (moved ? ` ${WORKER_FOR_ACCOUNT_TEXT}` : '') }
      : moved ? { field: 'kind', reason: 'account_worker', from: rows.find(a => a.id === (brain.accountId || 'default'))?.label || brain.accountId || 'default', to: row?.label || accountId, usage, workerForAccount: true, message: `${WORKER_FOR_ACCOUNT_TEXT.replace(/\.$/, '')} (${row?.label || accountId}).` }
        : null;
    const enriched = { ...target, accountKind: target.accountKind || target.kind, ...(moved ? { kind: 'dispatch' } : {}), accountId, account, accountError, accountChoice: target.accountChoice || choice, accountCorrection };
    if (check && accountError) throw routeError(accountError.code, message, 409, { accountId, target: enriched });
    return enriched;
  }
  function accountCorrections(target, base = []) { return target.accountCorrection && !base.some(c => c.reason === target.accountCorrection.reason && c.from === target.accountCorrection.from && c.to === target.accountCorrection.to && c.message === target.accountCorrection.message) ? [...base, target.accountCorrection] : base; }
  function checkedTarget(target, brain, cat, route = null, fallback = null, exact = false) {
    try { return accountTarget(target, brain, cat, { fallback, select: !exact || !target.accountId || target.accountId === 'auto' || target.accountChoice === 'auto' }); }
    catch (error) {
      if (route) call('routeEvent', route.sessionId, 'declined', routeView({ ...route, target: error.target, status: 'declined', reason: error.message, reasonCode: error.code }, { catalog: cat, brain }));
      throw error;
    }
  }
  function requireSession(sessionId) {
    const session = sessionId ? getSession(sessionId) : null;
    if (!session) throw routeError('SESSION_NOT_FOUND', `Unknown assistant session ${sessionId}`, 404);
    return session;
  }
  function pruneDecided() {
    const cutoff = now();
    // A later mailbox turn can revisit an older task. Keep its identity for the live session,
    // including closed tombstones; TTL only evicts legacy routes or sessions that are gone.
    for (const [id, route] of decided) if (route.expiresAt < cutoff && (!route.taskId || !getSession(route.sessionId))) decided.delete(id);
  }

  function routeView(source, { catalog: cat = null, brain = {}, brainInfo = null } = {}) {
    const target = source.target ? describeTarget(source.target, { catalog: cat, brain, brainInfo }) : null;
    return {
      ...agentFields(source),
      routeId: source.routeId, runIds: [...(source.runIds || [])], taskClass: source.taskClass, taskClassLabel: TASK_CLASS_META[source.taskClass]?.label || source.taskClass,
      ...(source.needsHost ? { needsHost: true } : {}),
      plannedSplit: source.plannedSplit || null, sessionId: source.sessionId || null, taskId: source.taskId || null, taskKey: source.taskKey || '',
      summary: source.summary || '', confidence: source.confidence ?? null, reason: source.reason || null,
      target, alternatives: (source.alternatives || []).slice(0, 4), decidedBy: source.decidedBy || null, remembered: !!source.remembered,
      optionId: source.optionId || null, corrections: source.corrections || [], mode: source.mode || null, status: source.status || null,
      // Why a route was declined without a card (no_capable_model), else null.
      reasonCode: source.reasonCode || null,
      ...(source.reasonCode === 'BUDGET_UNPRICED' ? { provider: source.provider } : {}),
      // Design's no_capable_model: no model can see.
      ...(source.needs ? { needs: source.needs } : {}),
      // budget_exhausted: the providers whose share is used up (the panel names them).
      ...(Array.isArray(source.dry) ? { dry: [...source.dry] } : {}),
    };
  }

  function nextText(status, target, { routeId, label } = {}) {
    if (status === 'pending') return 'The user has not picked a model yet. End your turn now with one short line saying you are waiting for their choice. Their decision arrives as a [SynaBun Mailbox] route_decided event; do not start the task before it.';
    if (status === 'declined') return label === 'dismissed' ? 'The route card was dismissed. Do not start the task; route again when ready.' : label === 'cancelled' ? 'The user cancelled this route. Do not start the task; ask what they would like instead.' : 'This route was declined by the routing system. Do not start the task; check the route reason.';
    // The user wrote something else instead of choosing (cancel 'superseded'): their message is next, so nothing is asked here.
    if (status === 'moved_on') return 'The user did not pick a model: they sent a new message instead, which you get next. Nothing was approved, so do not start this task. End your turn now, with no text unless you have a result to report.';
    if (status === 'expired' || status === 'cancelled') return 'This route is no longer valid. Do not start the task; ask the user how to proceed.';
    if (!target) return 'Proceed.';
    if (target.kind === 'dispatch') {
      return `Dispatch now with agent_dispatch route_id="${routeId}" (provider ${target.provider}${target.model ? `, model ${target.model}` : ', provider default model'}${target.effort ? `, effort ${target.effort}` : ''}). Do not ask the user again about the model.`;
    }
    if (target.continuation) return `The user chose to run this here on ${label || target.model}${target.effort ? ` (${effortWord(target.effort)})` : ''}. End your turn now with one short line; SynaBun has queued a continuation on that model and effort; if it has not started within ${CONTINUATION_WATCH_S} seconds it is delivered once more, and you are told if that one does not start either.`;
    return 'Proceed here yourself now.';
  }

  /**
   * An effort as `model` runs it, for comparing two of them: corrected to a level the model supports
   * (effort-levels.js normalizeEffort), lower case; none / no setting -> the row's `defaultEffort`
   * when the catalog names one, else null (the model's default).
   */
  function runEffort(provider, model, effort) {
    const cat = catalog.peek?.() || null;
    const kept = normalizeEffort({ provider, model, effort, catalog: cat }).effort;
    if (kept) return String(kept).toLowerCase();
    let row = null;
    try { row = model ? findModel(cat, provider, model)?.row || null : defaultModelRow(cat, provider); } catch { row = null; }
    return row?.defaultEffort ? String(row.defaultEffort).toLowerCase() : null;
  }
  /**
   * Does a direct `target` ask for another effort than `turn` runs on? A target with no effort (null, Auto /
   * default, or a model that takes no effort) is the session's own: no. An effort that clamps to the turn's is
   * the same; Off (`none`) and a level always differ.
   */
  function effortDiffers(target, turn = {}) {
    if (!target?.effort) return false;
    const provider = target.provider || turn.provider || null;
    const model = target.model || turn.model || null;
    if (!normalizeEffort({ provider, model, effort: target.effort, catalog: catalog.peek?.() || null }).effort) return false;
    return runEffort(provider, model, target.effort) !== runEffort(provider, model, turn.effort ?? null);
  }
  /**
   * A "do it here" pick hands off to a continuation turn when it switches the model (or provider) away from
   * `brain`, or asks for another effort than the brain's running turn is on (`turn`, turnBrain: a continuation's
   * effort, which a turn the CLI starts by itself afterwards keeps). The continuation runs that one task on the
   * pick; the session's own effort is not changed, so the turns after it are back on it.
   */
  function continuesHere(target, brain, turn = brain) {
    if (!target || target.kind !== 'direct') return false;
    if (String(target.provider || brain.provider) !== String(brain.provider)
      || String(target.model || brain.model || '') !== String(brain.model || '')) return true;
    return effortDiffers(target, turn);
  }
  /**
   * Off (`none`) to or from a level is a start-up option of Claude Code: the switch restarts the CLI, which ends
   * the background work it runs (a background Bash, an agent, a wakeup), so the bridge defers it while there is
   * any (claude-agent-bridge.js _thinkingDeferred), and a continuation then would not run on the pick. An
   * effort-only pick that needs that switch while the session reports background work (routerSession
   * `pendingWork`) carries on in place, as the turn runs; the correction says so, and that the task, routed again
   * once the work has reported (its task-notification turn), continues on the pick. -> the correction, or null.
   */
  function thinkingWaits(sessionId, target, brain, turn) {
    if (!target || target.kind !== 'direct') return null;
    const provider = String(target.provider || brain.provider || '');
    if (provider !== 'claude-code' || provider !== String(brain.provider || '')) return null;
    if (String(target.model || brain.model || '') !== String(brain.model || '')) return null;
    if (!effortDiffers(target, turn) || getSession(sessionId)?.pendingWork !== true) return null;
    const model = target.model || brain.model || null;
    const want = runEffort(provider, model, target.effort);
    const have = runEffort(provider, model, turn.effort ?? null);
    if ((want === EFFORT_OFF) === (have === EFFORT_OFF)) return null;
    const off = want === EFFORT_OFF;
    const asIs = have === EFFORT_OFF ? 'thinking off' : `thinking on${have ? `, ${have}` : ''}`;
    return {
      field: 'effort', from: target.effort, to: turn.effort ?? null, reason: 'thinking_waits',
      text: `${off ? 'thinking off' : `thinking on (${want})`} waits: Claude Code is running background work, and switching thinking ${off ? 'off' : 'on'} restarts it, which would end that work. This carries on here as it runs now (${asIs}); once the background work has reported, route this task again with the same task_key and it continues on ${effortWord(target.effort)}`,
    };
  }
  /** What the brain's running turn is on, from a session snapshot (turnBrain, for a session id). */
  function turnOf(session, brain = {}) {
    const turn = session?.turn;
    return turn && typeof turn === 'object' ? { ...brain, model: turn.model ?? brain.model ?? null, effort: turn.effort ?? null } : brain;
  }
  /**
   * Whether a direct pick queues a continuation now: continuesHere against the running turn (a re-route compares
   * the model with the turn too), unless its thinking switch waits for background work (thinkingWaits).
   */
  function continuesNow(sessionId, target, brain, { reroute = false } = {}) {
    const turn = turnBrain(sessionId, brain);
    const base = reroute ? turn : brain;
    if (!continuesHere(target, base, turn)) return false;
    return !thinkingWaits(sessionId, target, base, turn);
  }
  // The continuation watchdog. A "do it here" pick queues a continuation in the runtime (continueDirect),
  // which calls continuationStarted(routeId) once the turn reached the brain. Not started after
  // CONTINUATION_WATCH_MS: it is delivered once more (the runtime takes a delivery of a continuation it
  // still holds, queued or on its way, or one that already ran, as done: never a second turn), and only
  // if that one has not started either, CONTINUATION_WATCH_MS later, the brain and the panel are told.
  // A retry the runtime refuses (the turn is gone, the session is closing) is told at once. Every timer
  // ends with the start, the session's end or Stop, a newer task, a newer continuation and shutdown.
  function stopContinuationWatch(entry) {
    if (entry?.timer != null) continuationTimers.clearTimeout(entry.timer);
    if (entry) entry.timer = null;
  }
  function closeContinuation(entry) { stopContinuationWatch(entry); entry.closed = true; }
  function continuationStarted(routeId) {
    const entry = continuations.get(String(routeId || ''));
    if (!entry) return;
    stopContinuationWatch(entry);
    entry.started = true;
  }
  /** The runtime took the continuation (queued it, or holds / ran it already): exactly `true`. */
  // `reroute`: agent_route asked for the task again in the turn running now, so it is delivered in that turn's
  // generation; the watchdog's retry keeps the generation the continuation was delivered in.
  const deliverContinuation = (entry, retry, reroute = false) => call('continueDirect', entry.sessionId,
    retry || reroute ? { ...entry.payload, ...(retry ? { retry: true } : {}), ...(reroute ? { reroute: true } : {}) } : entry.payload) === true;
  function reportContinuation(entry, reasonCode, text) {
    entry.reported = true;
    call('mailbox', entry.sessionId, { kind: 'route_continuation_delayed', route: entry.source, reasonCode, retried: entry.retries > 0, text });
    call('routeEvent', entry.sessionId, 'continuation_delayed', { ...entry.source, reasonCode, retried: entry.retries > 0, reason: text });
  }
  function armContinuationWatch(entry, fire) {
    stopContinuationWatch(entry);
    entry.timer = continuationTimers.setTimeout(() => {
      entry.timer = null;
      if (entry.started || entry.closed) return;
      fire();
    }, CONTINUATION_WATCH_MS);
    entry.timer?.unref?.();
  }
  function watchContinuation(entry) {
    entry.reported = false;
    armContinuationWatch(entry, () => {
      entry.retries += 1;
      const delivered = deliverContinuation(entry, true);
      // (The runtime may answer that it already ran, and say so through continuationStarted meanwhile.)
      if (entry.started || entry.closed) return;
      if (!delivered) {
        reportContinuation(entry, 'continuation_undeliverable', `The approved continuation did not start within ${CONTINUATION_WATCH_S} seconds, and SynaBun's retry could not deliver it (its turn is gone, or the session is stopping). Nothing ran. Route again with the same task_key to retry.`);
        return;
      }
      armContinuationWatch(entry, () => reportContinuation(entry, 'continuation_timeout',
        `The approved continuation has not started after ${CONTINUATION_WATCH_S * 2} seconds, although SynaBun retried its delivery once at ${CONTINUATION_WATCH_S} seconds. It may still be queued behind a running turn; check the task, and route again with the same task_key to retry.`));
    });
  }
  /**
   * → whether a continuation is queued for this route (continueDirect), so the answer can say continuation:true.
   * `reroute`: the task's route was approved in an earlier turn and is asked again in the turn running now (a task
   * notification, a mailbox turn, the user's next words). It is compared with what that turn runs on (turnBrain), not
   * with the session's brain: a turn already on the approved model carries the task on in place (false). A
   * continuation still queued and watched is that one (true); one that already ran is consumed (false). Otherwise it
   * is delivered again, in the generation of the turn running now (the runtime's `reroute`).
   */
  function maybeContinuation(sessionId, target, brain, source, { reroute = false } = {}) {
    if (reroute ? (!target || target.kind !== 'direct') : !continuesNow(sessionId, target, brain)) return false;
    const routeId = String(source.routeId || '');
    const previous = continuations.get(routeId);
    if (previous?.started) return false;
    // Delivered and still watched: the watchdog retries it; nothing is queued twice.
    if (previous && !previous.reported && !previous.closed) return true;
    if (reroute && !continuesNow(sessionId, target, brain, { reroute: true })) return false;
    // A newer continuation of the session replaces the one the runtime holds (one continuation slot): the older stops being watched.
    for (const [id, other] of continuations) if (id !== routeId && other.sessionId === sessionId && !other.started && !other.closed) closeContinuation(other);
    const entry = previous || { routeId, sessionId, taskId: source.taskId ?? getSession(sessionId)?.taskId ?? null, payload: { target, route: source, text: source.summary || '' }, source, started: false, closed: false, reported: false, retries: 0, timer: null };
    entry.closed = false;
    continuations.delete(routeId);
    continuations.set(routeId, entry);
    while (continuations.size > CONTINUATIONS_KEPT) { const [oldest, old] = continuations.entries().next().value; stopContinuationWatch(old); continuations.delete(oldest); }
    if (!deliverContinuation(entry, !!previous, reroute)) {
      closeContinuation(entry);
      throw routeError('ROUTE_CONTINUATION_FAILED', 'The continuation could not be queued. Route again with the same task_key to retry.', 409);
    }
    // (A runtime that already ran it says so at once: consumed.)
    if (entry.started) return false;
    watchContinuation(entry);
    return true;
  }
  /**
   * What the brain's running turn is on: the runtime's `turn` ({ model, effort }: a continuation's model and
   * effort, which a turn the CLI starts by itself afterwards keeps), else the brain's own. A re-route compares
   * with this, so a turn already on the approved model and effort carries the task on in place; every pick's
   * effort is compared with it (continuesHere).
   */
  function turnBrain(sessionId, brain = {}) { return turnOf(getSession(sessionId), brain); }
  /** The session is closing or has ended (routerSession `closing`): a continuation it refuses can never run. */
  function sessionClosing(sessionId) {
    const session = getSession(sessionId);
    return !session || session.closing === true;
  }

  // Read the old route's runs at delivery. A worker may finish while the Here card is open.
  function reportSupersededRuns(request, result) {
    if (!request?.needsHost || !request.taskId) return result;
    const key = routeTaskIdentity(request);
    const old = [...decided.values()].find(r => r.supersededByHost && r.status === 'approved' && routeTaskIdentity(r) === key);
    const runs = old && call('activeRouteRuns', request.sessionId, old.routeId);
    if (!runs?.length) return result;
    const names = runs.map(r => `${r.runId} ("${r.title}", ${r.state})`).join(', ');
    const text = `The previous dispatch still has active work (${names}). Use agent_stop with the run ID for any duplicate work.`;
    const correction = { reason: 'superseded_run_active', routeId: old.routeId, runs, text };
    return { ...result, corrections: [...(result.corrections || []), correction], next: `${text} ${result.next}` };
  }

  function resultFor(status, { routeId, mode, source = null, target = null, card = null, runIds = [], corrections = [], cat = null, brain = {}, brainInfo = null, remembered = false, continuation = false, sessionId = null, switched = null, droppedRuns = [] } = {}) {
    const described = target ? { ...describeTarget(target, { catalog: cat, brain, brainInfo }), continuation } : null;
    // The user's pick was the other kind than the brain proposed; a "here" pick on another account runs on a worker.
    const kindLead = source !== 'user' ? ''
      : target?.kind === 'dispatch' && target.accountKind === 'direct'
      ? 'The user chose to do this here, but on another account than this conversation\'s, so it runs on a worker. '
      : switched === 'direct' ? `The user chose to do this here, not on a worker${droppedRuns.length ? ` (the held run${droppedRuns.length === 1 ? '' : 's'} ${droppedRuns.join(', ')} ${droppedRuns.length === 1 ? 'was' : 'were'} not started)` : ''}. `
        : switched === 'dispatch' ? 'The user chose a worker for this, not here. ' : '';
    // A saved route that replaced the brain's pick (never mode) says so first.
    const binding = (corrections || []).find((c) => c?.reason === 'remembered_route');
    const skipped = (corrections || []).find((c) => c?.reason === 'remembered_disabled');
    // Image / video creation: a pick that cannot make the medium was moved onto one that can.
    const maker = (corrections || []).find((c) => c?.reason === 'needs_output');
    // The session budget moved the task: the provider it was going to has no share left.
    const moved = (corrections || []).find((c) => c?.reason === 'budget_share');
    const lead = moved ? `Budget: ${moved.text.replace(/^budget: /, '')} (the session budget moved it; with a budget the saved routes yield). `
      : binding ? `The user's saved route for this task class applies (${binding.to}), not your pick (${binding.from}). `
        : skipped ? `The saved route for this task class (${skipped.from}) is on a disabled model, so your pick stands. `
          : maker ? `Your pick (${maker.from}) cannot make what this task creates, so it runs on ${maker.to}. ` : '';
    // An effort-only pick whose thinking switch waits for background work (thinkingWaits): said first.
    const waits = (corrections || []).find((c) => c?.reason === 'thinking_waits');
    const waitLead = waits && !continuation ? `${waits.text}. ` : '';
    const shares = sessionId && budgeted() ? compactBudget(sessionId) : null;
    const record = decided.get(routeId) || card;
    const plannedSplit = record?.plannedSplit || null;
    const flow = plannedSplit?.flow;
    const splitNext = status === 'approved' && target?.kind === 'dispatch' && plannedSplit
      ? flow === 'team'
        ? `Call agent_team action "plan" with task_class="${record.taskClass}" and these ${plannedSplit.workers} slice titles (${["research", "review"].includes(record.taskClass) ? "read-only: owned_paths []" : "disjoint owned_paths"}), then action "start" with route_id="${routeId}". One approval covers every slice; never route a slice. Wait on its workflow_id, then ${["research", "review"].includes(record.taskClass) ? "synthesize the results; worktrees are cleaned up automatically, no integration or landing" : "verify the integration result"}.`
        : `Call agent_dispatch with route_id="${routeId}" for one worker. Explain: ${plannedSplit.reason}`
      : null;
    return reportSupersededRuns(record, {
      ...agentFields(record),
      ok: true, status, routeId, mode, source: source || record?.decidedBy || (status === 'expired' ? 'timeout' : status === 'cancelled' ? 'system' : null), reasonCode: record?.reasonCode || (status === 'expired' ? 'expired' : status === 'cancelled' ? 'cancelled' : null), target: described, remembered, continuation,
      taskClass: record?.taskClass || null, sessionId: sessionId || record?.sessionId || null, taskId: record?.taskId || null, taskKey: record?.taskKey || '',
      agentDensity: plannedSplit?.density || normalizeAgentDensity(getSession(sessionId || record?.sessionId)?.agentDensity), expectedWorkers: plannedSplit?.workers || 1, plannedSplit, workflowId: record?.workflowId || null,
      corrections: record?.agentCorrection ? [...corrections, record.agentCorrection] : corrections, runIds, expiresAt: card?.expiresAt ? new Date(card.expiresAt).toISOString() : null,
      ...(shares ? { budget: shares } : {}),
      next: `${waitLead}${lead}${status === 'approved' ? kindLead : ''}${splitNext || nextText(record?.reasonCode === 'moved_on' ? 'moved_on' : status, described, { routeId, label: status === 'declined' ? record?.reasonCode : described?.label })}`,
    });
  }

  /** What the brain tells the user when no model makes the medium, or can see for design (agent_route's `next`, the NO_CAPABLE_MODEL refusal). */
  function noMakerText(request) {
    if (!request.needsOutput) {
      return `No model in the user's catalog can see images, so this ${request.taskClassLabel} task cannot run. Do not start it or dispatch it. Tell the user in one line that the ${request.taskClassLabel} row in Model routes has no model that can see yet: they can connect or enable one (in the Models list), then pick it for that row.`;
    }
    const words = MEDIUM_WORDS[request.needsOutput] || request.needsOutput;
    return `No model in the user's catalog can make ${words}, so this ${request.taskClassLabel} task cannot run. Do not start it or dispatch it. Tell the user in one line that the ${request.taskClassLabel} row in Model routes has no model that makes ${words} yet: they can connect or enable one (in the Models list), then pick it for that row.`;
  }
  /** Image / video creation with no model that makes the medium (design: none that can see): declined at once, in every mode (no card). */
  function unavailableResult({ sessionId, request, mode, cat, brain, brainInfo }) {
    const routeId = `route-${randomId()}`;
    const words = MEDIUM_WORDS[request.needsOutput] || request.needsOutput;
    const needs = request.needsOutput ? null : 'vision';
    const route = {
      routeId, status: 'declined', sessionId, taskClass: request.taskClass, summary: request.summary, confidence: request.confidence,
      target: null, decidedBy: 'rule', remembered: false, corrections: [], mode, runIds: [], reasonCode: 'no_capable_model',
      reason: needs ? 'No model in your catalog can see images yet.' : `No model in your catalog can make ${words} yet.`,
      ...(needs ? { needs } : {}),
    };
    call('routeEvent', sessionId, 'declined', routeView(route, { catalog: cat, brain, brainInfo }));
    return {
      ok: true, status: 'declined', reason: 'no_capable_model', reasonCode: 'no_capable_model', requires: request.needsOutput, ...(needs ? { needs } : {}), routeId, mode, source: 'rule', target: null,
      remembered: false, continuation: false, corrections: [], runIds: [], expiresAt: null, next: noMakerText(request),
    };
  }

  /**
   * A WhatsApp session whose computer use is "after approval" (session.computer, the runtime's
   * remoteComputerUse answer): when what a plain yes approves on this card is a computer task
   * done here, on the brain's own model (no continuation onto another model, no worker), the
   * card says the Mac will be controlled and that yes is also the computer approval of the turn
   * that carries the route out. → { optionId } (the one option that carries it), else null.
   * Decided once, when the card is made, and stored with it: never derived again from the class
   * or the target an answer names.
   */
  function computerConsent({ session, request, options, defaultOptionId, brain, origin }) {
    if (origin !== 'agent_route' || session?.remote !== true || session?.computer?.state !== 'ask') return null;
    if (request.taskClass !== 'computer') return null;
    const option = options.find((o) => o.id === defaultOptionId);
    if (!option || option.disabled || option.kind !== 'direct' || option.provider !== brain.provider) return null;
    if (continuesHere({ kind: 'direct', provider: option.provider, model: option.model, effort: option.effort }, brain, turnOf(session, brain))) return null;
    return { optionId: option.id };
  }

  function createCard({ sessionId, request, evaluation, brain, brainInfo, cat, mode, origin, workflowId = null, runIds = [], session = null }) {
    const routeId = `route-${randomId()}`;
    const requestId = routeId;
    const r = routing();
    const built = buildRouteOptions({ request, evaluation, brain, brainInfo, catalog: cat, routing: r, coverage: evaluation.coverage || null });
    const { options } = built;
    for (const option of options) {
      const first = request.proposals[0];
      const fallback = origin === 'dispatch' && option.badge !== 'remembered' && option.provider === first?.provider ? first.accountId : null;
      Object.assign(option, accountTarget(option, brain, cat, { check: false, fallback, select: !request.needsHost }));
      Object.assign(option, workerRole(request, option, option.id));
      if (option.accountError) { option.disabled = true; option.disabledReason = option.accountError.message; }
      // A "here" whose account cannot take it (this conversation's is out of usage) runs on a worker
      // on another account: the card names it as a worker and says why, never "Do it here".
      if (option.kind === 'dispatch' && option.accountKind === 'direct') {
        const described = describeTarget(option, { catalog: cat, brain, brainInfo });
        option.label = `${providerLabel(option.provider)} · ${described?.label || option.model || 'default'}${option.effort ? ` · ${effortWord(option.effort)}` : ''}`;
        option.warning = option.accountCorrection?.message || WORKER_FOR_ACCOUNT_TEXT;
      }
    }
    // The sides and defaults as the options are sent (the account check can disable or move one).
    const { defaultOptionId, sides, defaults } = routeSides({ options, request, defaultOptionId: built.defaultOptionId });
    const computer = computerConsent({ session, request, options, defaultOptionId, brain, origin });
    const pref = r.preferences?.[request.taskClass];
    const card = {
      ...agentFields(options.find(o => o.id === (defaults.dispatch || defaultOptionId))),
      routeId, requestId, sessionId, origin, status: 'pending', mode, workflowId,
      plannedSplit: request.plannedSplit || null, taskId: request.taskId, taskKey: request.taskKey || '',
      taskClass: request.taskClass, summary: request.summary, confidence: request.confidence, needsVision: request.needsVision,
      ...(request.needsHost ? { needsHost: true } : {}),
      needsOutput: request.needsOutput || null, dispatchOnly: request.dispatchOnly === true, visionOnly: request.visionOnly === true,
      reasons: evaluation.reasons, request, options, defaultOptionId, sides, defaults, runIds: new Set(runIds), waiters: new Set(),
      // No deadline: a card stays open until the user answers it, moves on, or its session ends.
      createdAt: now(), expiresAt: null, mailboxOnDecision: origin === 'dispatch', brain,
      // The option whose approval is also the computer approval (computerConsent), as this card was sent.
      computer,
      alternatives: options.filter((o) => o.badge !== 'suggested').map((o) => ({ id: o.id, kind: o.kind, provider: o.provider, model: o.model, effort: o.effort, label: o.label, badge: o.badge })),
    };
    card.packet = {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'route', kind: 'route', provider: 'synabun', routeId, origin, runIds: [...card.runIds], workflowId, sessionId, mode,
        reasons: evaluation.reasons, taskClass: request.taskClass, taskClassLabel: request.taskClassLabel, summary: request.summary,
        plannedSplit: request.plannedSplit || null, taskId: request.taskId || null, taskKey: request.taskKey || '',
        confidence: request.confidence, needsVision: request.needsVision,
        ...(request.needsHost ? { needsHost: true } : {}),
        // Image / video creation: the medium the model must generate, and no "here" (always a worker).
        requires: request.needsOutput || null, dispatchOnly: request.dispatchOnly === true,
        // Design: only models that can see.
        visionOnly: request.visionOnly === true,
        brain: { provider: brain.provider, model: brain.model || null, label: brainInfo?.label || brain.model || providerLabel(brain.provider), vision: brainInfo?.vision ?? null },
        options, defaultOptionId,
        // The card's Here / Dispatch switch: which side can run the task (and why not), and the option each side starts on.
        sides, defaults,
        other: { allowed: true, providers: request.needsHost ? [brain.provider] : CATALOG_PROVIDERS, catalogPath: '/api/assistant/catalog' },
        remember: { available: request.taskClass !== 'chat', taskClass: request.taskClass, label: request.taskClassLabel, current: pref ? (pref.label || [pref.provider, pref.model].filter(Boolean).join('/')) : null },
        decline: { allowed: true, label: 'Cancel' },
        // Approving this option also lets the Assistant control the Mac for the task: every host says so in words.
        ...(computer ? { computer: { optionId: computer.optionId } } : {}),
        createdAt: new Date(card.createdAt).toISOString(), expiresAt: null,
      },
    };
    cards.set(routeId, card);
    byRequest.set(requestId, routeId);
    return card;
  }
  function refreshPacketRuns(card) { card.packet.request.runIds = [...card.runIds]; }

  // The outcome stays on the card: a producer that has not started waiting yet (a host closed
  // the card while it was being sent) reads it instead of waiting on a card that is gone.
  function settle(card, outcome) {
    card.settled = outcome;
    for (const waiter of [...card.waiters]) { try { waiter(outcome); } catch {} }
    card.waiters.clear();
  }
  /**
   * What a dispatch is told when its route card closed before a run could wait on it (a host
   * closed it while it was being sent, or between the hold and the attachment): nothing is held.
   */
  function routeClosedError(card) {
    const text = card?.settled?.movedOn
      ? 'The user sent a new message instead of choosing where this task runs, which you get next. Nothing was started: do not dispatch it again. End your turn now, with no text unless you have a result to report.'
      : 'This route is no longer valid: its card closed before the run could wait on it. Nothing was started; ask the user how to proceed.';
    return routeError('ROUTE_CANCELLED', text, 409, { routeId: card?.routeId || null });
  }
  function closeCard(card) {
    byRequest.delete(card.requestId);
    cards.delete(card.routeId);
    // Why it closed, for a producer that attaches a run a moment too late (bounded).
    lastClosed.set(card.routeId, { routeId: card.routeId, requestId: card.requestId, sessionId: card.sessionId, taskId: card.taskId, taskKey: card.taskKey, mode: card.mode, decidedBy: card.decidedBy, reasonCode: card.reasonCode, settled: card.settled || null });
    while (lastClosed.size > 50) lastClosed.delete(lastClosed.keys().next().value);
  }

  // `reason` 'superseded': a "do it here" pick whose turn is gone (answer), or the user
  // wrote something else instead of choosing (cancel: `movedOn`). It reads as expired, and
  // the brain gets no mailbox event: the user already moved on.
  function expire(routeId, reason = 'expired', { movedOn = false } = {}) {
    const card = cards.get(routeId);
    if (!card || card.status !== 'pending') return;
    card.status = reason === 'expired' || reason === 'superseded' ? 'expired' : 'cancelled';
    card.decidedBy = reason === 'expired' ? 'timeout' : 'system';
    card.reasonCode = movedOn ? 'moved_on' : reason;
    const status = card.status;
    for (const runId of card.runIds) call('declineHeld', runId, reason === 'expired' ? 'route_expired' : `route_${reason}`);
    call('cancelCard', card.sessionId, card.requestId, reason);
    const view = routeView({ ...card, status, decidedBy: card.decidedBy }, { catalog: catalog.peek?.(), brain: card.brain });
    call('routeEvent', card.sessionId, status === 'expired' ? 'expired' : 'cancelled', view);
    if ((card.mailboxOnDecision || card.runIds.size) && reason !== 'session_closed' && reason !== 'aborted' && reason !== 'superseded') {
      call('mailbox', card.sessionId, { kind: 'route_expired', route: view, runIds: [...card.runIds], text: `Route card for "${card.summary || card.taskClass}" ${status === 'expired' ? 'expired without an answer' : `was cancelled (${reason})`}.` });
    }
    settle(card, { status, routeId, ...(movedOn ? { movedOn: true } : {}) });
    if (card.taskId) decided.set(routeId, { ...view, sessionId: card.sessionId, expiresAt: now() + DECIDED_TTL_MS });
    closeCard(card);
  }

  function waitFor(card, ms, signal) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if (done) return; done = true; clearTimeout(timer); card.waiters.delete(finish); signal?.removeEventListener?.('abort', onAbort); resolve(value); };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), ms);
      timer.unref?.();
      card.waiters.add(finish);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  /**
   * agent_route: the brain's proposal → approved | pending | declined. The
   * result (or a router failure) also reaches the runtime's per-turn route
   * gate through the `routed` / `routeFailed` sinks.
   */
  async function propose(args = {}) {
    const origin = args.origin || 'agent_route';
    const taskId = getSession(args.sessionId)?.taskId || null;
    try {
      const result = await proposeRoute(args);
      // The class rides along: a "chat" route must not unlock the gate.
      if (origin === 'agent_route') call('routed', args.sessionId, result, { taskClass: result.taskClass || normalizeRouteRequest(args.body || {}).taskClass });
      return result;
    } catch (error) {
      if (origin === 'agent_route' && (!taskId || getSession(args.sessionId)?.taskId === taskId)) {
        if (/^ROUTE_(SPLIT_|PROJECT_|TASK_)/.test(error?.code || '')) call('routed', args.sessionId, { status: 'plan_required', taskId, next: error.message }, { taskClass: normalizeRouteRequest(args.body || {}).taskClass });
        else call('routeFailed', args.sessionId, error);
      }
      throw error;
    }
  }
  /** The user has not answered the brain's questions: nothing that depends on them is routed (the gate holds). */
  function clarifyingResult(sessionId, waiting) {
    const what = waiting.summary ? `: "${clip(waiting.summary, 80)}"` : '';
    return {
      ok: true, status: 'clarifying', routeId: null, mode: modeFor(sessionId), source: null, target: null, remembered: false, continuation: false,
      corrections: [], runIds: [], expiresAt: null, briefId: waiting.briefId,
      next: `The user has not answered your questions yet (brief ${waiting.briefId}${what}). End your turn now with one short line and route this after the answers arrive (a [SynaBun Mailbox] clarify_answered event, or the user's next message). If this task does not depend on them, call agent_route again with independent:true.`,
    };
  }
  function taskIdentity(sessionId, session, body = {}) {
    const taskKey = body.task_key ?? body.taskKey ?? '';
    if (typeof taskKey !== 'string' || taskKey.length > 100 || /[\x00-\x1f]/.test(taskKey)) throw routeError('ROUTE_TASK_KEY_INVALID', 'task_key must be at most 100 characters of text.', 400);
    return { sessionId, taskId: session.taskId || null, taskKey: taskKey.trim() };
  }
  function assertCurrentTask(sessionId, taskId) {
    if (taskId && getSession(sessionId)?.taskId !== taskId) throw routeError('ROUTE_TASK_CHANGED', 'This request has moved on to another task; route the current task.', 409);
  }
  /**
   * The task already has a route (same task id and task_key). `deliver` (agent_route only; a dispatch looking
   * the route up asks the runtime for nothing): an approved "do it here" route goes through maybeContinuation
   * as a re-route, so an answer that says continuation:true always has one queued and watched. A turn already
   * on the approved model (the continuation itself, or a turn the CLI started after it) carries the task on in
   * place, and a continuation that already ran is consumed: continuation:false, and the gate opens. A refusal
   * from a session that is closing answers expired (nothing can run there); any other refusal is
   * ROUTE_CONTINUATION_FAILED, which says to route again.
   */
  function existingTaskResult(request, sessionId, context, { deliver = false } = {}) {
    const key = routeTaskIdentity(request);
    if (!key) return null;
    const card = [...cards.values()].find(c => routeTaskIdentity(c) === key);
    const prior = card || [...decided.values()].find(c => !c.supersededByHost && !c.supersededBySplit && routeTaskIdentity(c) === key);
    if (!prior) return null;
    assertCurrentTask(sessionId, request.taskId);
    if (request.needsHost && prior.status === 'approved' && prior.target?.kind === 'direct') {
      prior.needsHost = true;
    }
    // A newly identified host requirement supersedes an earlier worker-capable choice.
    if (request.needsHost && !prior.needsHost && ['pending', 'approved'].includes(prior.status)) {
      if (card) expire(card.routeId, 'superseded');
      const old = decided.get(prior.routeId);
      if (old) Object.assign(old, { supersededByHost: true, needsHost: true });
      return null;
    }
    // A changed planned_split before any team or worker used the route: the new plan is routed afresh
    // (a new card, so Always ask asks again) instead of answering with the stale split.
    if (splitChanged(request.requestedSplit, prior.plannedSplit) && ['pending', 'approved'].includes(prior.status)
      && !prior.workflowId && !(prior.runIds?.size ?? prior.runIds?.length ?? 0)) {
      if (card) expire(card.routeId, 'superseded');
      const old = decided.get(prior.routeId);
      if (old) Object.assign(old, { supersededBySplit: true, status: old.status === 'approved' ? 'expired' : old.status });
      return null;
    }
    let continuation = false;
    // A thinking switch that waited is decided again now (the background work may have reported since).
    let corrections = (prior.corrections || []).filter((c) => c?.reason !== 'thinking_waits');
    if (prior.status === 'approved' && prior.target) {
      if (!deliver) continuation = continuesNow(sessionId, prior.target, context.brain, { reroute: true });
      else {
        try { continuation = maybeContinuation(sessionId, prior.target, context.brain, prior, { reroute: true }); } catch (error) {
          if (error?.code !== 'ROUTE_CONTINUATION_FAILED' || !sessionClosing(sessionId)) throw error;
          // The session is closing or gone: nothing runs, so nothing is promised.
          log('router:reroute-refused', `${prior.routeId}: the continuation of a re-routed task could not be queued (the session is closing)`);
          return { ...resultFor('expired', { routeId: prior.routeId, mode: prior.mode, cat: context.cat, brain: context.brain, brainInfo: context.brainInfo, sessionId }), reason: 'superseded' };
        }
      }
    }
    if (prior.status === 'approved' && prior.target && !continuation) {
      const waits = thinkingWaits(sessionId, prior.target, turnBrain(sessionId, context.brain), turnBrain(sessionId, context.brain));
      if (waits) corrections = [...corrections, waits];
    }
    return resultFor(prior.status, { routeId: prior.routeId, mode: prior.mode, card, source: prior.decidedBy,
      target: prior.target, corrections, remembered: prior.remembered,
      continuation, sessionId, ...context });
  }
  // New human requests retire the previous request's pending cards, across every subtask.
  function expireOtherTasks(sessionId, taskId) {
    for (const card of [...cards.values()]) if (card.sessionId === sessionId && card.taskId && card.taskId !== taskId) expire(card.routeId, 'superseded', { movedOn: true });
    // An earlier task's continuation is not watched any more (the runtime dropped it with its generation).
    for (const entry of continuations.values()) if (entry.sessionId === sessionId && !entry.started && entry.taskId && entry.taskId !== taskId) closeContinuation(entry);
  }
  async function proposeRoute({ sessionId, body = {}, origin = 'agent_route', waitMs = null, signal = null } = {}) {
    pruneDecided();
    const session = requireSession(sessionId);
    const waiting = origin === 'agent_route' ? clarifier?.blocking?.(sessionId, { independent: body.independent === true }) : null;
    if (waiting) return clarifyingResult(sessionId, waiting);
    const brain = session.brain || {};
    expireOtherTasks(sessionId, session.latestTaskId || session.taskId);
    const cat = await catalogValue();
    const brainInfo = brainInfoFor(brain);
    const request = normalizeRouteRequest(body, { brain });
    Object.assign(request, taskIdentity(sessionId, session, body));
    request.requestedSplit = body.planned_split ?? body.plannedSplit ?? null;
    // The same task routed again (a later turn: a task notification, a mailbox event, the user's next words).
    const existing = existingTaskResult(request, sessionId, { cat, brain, brainInfo }, { deliver: origin === 'agent_route' });
    if (existing) return existing;
    request.plannedSplit = request.needsHost ? null : await planRouteSplit(body, session, request.taskClass);
    request.projectPath = request.plannedSplit?.projectPath || null;
    request.roles = workerRoles(request, body.cwd || body.project);
    if (request.plannedSplit) {
      request.dispatchOnly = true;
      request.proposals = request.proposals.map(p => ({ ...p, kind: 'dispatch' }));
    }
    const mode = modeFor(sessionId);
    const r = routing();
    const evaluation = await evaluateWithBudget(sessionId, { mode, routing: r, request, brain, brainInfo, catalog: cat });
    const raced = existingTaskResult(request, sessionId, { cat, brain, brainInfo }, { deliver: origin === 'agent_route' });
    if (raced) return raced;
    assertCurrentTask(sessionId, request.taskId);
    if (['budget_exhausted', 'budget_unpriced'].includes(evaluation.unavailable)) return budgetDeclinedResult({ sessionId, request, mode, cat, brain, brainInfo, evaluation });
    if (evaluation.unavailable) return unavailableResult({ sessionId, request, mode, cat, brain, brainInfo });
    if (!evaluation.ask) {
      const routeId = `route-${randomId()}`;
      let target = evaluation.auto;
      const checked = accountTarget(target, brain, cat, { check: false, select: !request.needsHost && request.taskClass !== 'chat' });
      if (request.needsHost && checked.kind !== 'direct') throw hostRouteError();
      if (checked.accountError) {
        const failed = { routeId, sessionId, taskClass: request.taskClass, summary: request.summary, target: checked, status: 'declined', decidedBy: 'account', reason: checked.accountError.message, reasonCode: checked.accountError.code, mode };
        call('routeEvent', sessionId, 'declined', routeView(failed, { catalog: cat, brain, brainInfo }));
        return reportSupersededRuns(request, { ok: false, status: 'declined', routeId, mode, source: 'account', reasonCode: checked.accountError.code, code: checked.accountError.code, target: describeTarget(checked, { catalog: cat, brain }), next: checked.accountError.message });
      }
      target = checked;
      const decidedBy = evaluation.source === 'remembered' ? 'remembered' : evaluation.source === 'budget' ? 'budget' : 'brain';
      // Off to or from a level that waits for Claude Code's background work: in place, and the answer says so.
      const waits = origin === 'agent_route' && request.taskClass !== 'chat' ? thinkingWaits(sessionId, target, brain, turnBrain(sessionId, brain)) : null;
      const route = {
        ...(request.needsHost ? { needsHost: true } : {}),
        taskId: request.taskId, taskKey: request.taskKey || '', plannedSplit: request.plannedSplit || null, workflowId: null,
        routeId, status: 'approved', sessionId, taskClass: request.taskClass, summary: request.summary, confidence: request.confidence,
        ...workerRole(request, target),
        target, decidedBy, remembered: evaluation.source === 'remembered', corrections: [...accountCorrections(target, evaluation.corrections), ...(waits ? [waits] : [])], mode,
        reason: request.proposals[0]?.reason || null, runIds: [], expiresAt: now() + DECIDED_TTL_MS,
      };
      decided.set(routeId, route);
      noteBudgetTask(sessionId, request, target);
      if (request.taskClass !== 'chat') call('routeEvent', sessionId, 'auto', routeView(route, { catalog: cat, brain, brainInfo }));
      // A chat route is the brain's own turn: it never continues (its effort is the session's).
      const continuation = origin === 'agent_route' && request.taskClass !== 'chat' ? maybeContinuation(sessionId, target, brain, route) : false;
      return resultFor('approved', { routeId, mode, source: evaluation.source, target, corrections: route.corrections, cat, brain, brainInfo, remembered: route.remembered, continuation, sessionId });
    }
    // The session as it is now (the catalog was awaited since): its computer-use answer decides what the card says.
    const card = createCard({ sessionId, request, evaluation, brain, brainInfo, cat, mode, origin, session: getSession(sessionId) || session });
    call('sendCard', sessionId, card.packet);
    // A host can close the card while it is being sent (the WhatsApp bridge, when the user already
    // wrote something else): no "card" event after its "expired", no wait, never "pending".
    if (card.status === 'pending') call('routeEvent', sessionId, 'card', routeView({ ...card, status: 'pending', target: evaluation.proposal }, { catalog: cat, brain, brainInfo }));
    // Wait the configured time, never past the caller's own deadline (MCP
    // clients give up on a tool call after ~60 s by default).
    const configured = r.waitSeconds * 1000;
    const budget = waitMs === null || waitMs === undefined ? configured : Math.min(configured, Number(waitMs));
    const wait = Math.max(0, Math.min(Number.isFinite(budget) ? budget : 0, 110_000));
    const outcome = card.settled || (wait > 0 ? await waitFor(card, wait, signal) : null);
    if (!outcome) {
      card.mailboxOnDecision = true;
      return resultFor('pending', { routeId: card.routeId, mode, card, cat, brain, brainInfo, sessionId });
    }
    if (outcome.result) return outcome.result;
    const closed = resultFor(outcome.status || 'cancelled', { routeId: card.routeId, mode, card, cat, brain, brainInfo });
    // The user wrote something else instead of choosing: the turn that asked ends quietly (their message is next).
    return outcome.movedOn ? { ...closed, reason: 'superseded', next: nextText('moved_on') } : closed;
  }

  /** The open card of a request or route id; throws for one that is unknown, closed or already decided. */
  function openCard(idOrRequestId, { sessionId = null } = {}) {
    const routeId = byRequest.get(String(idOrRequestId)) || String(idOrRequestId);
    const card = cards.get(routeId);
    const scoped = sessionId !== null && sessionId !== undefined;
    if (!card) {
      const done = decided.get(routeId);
      if (done && (!scoped || done.sessionId === String(sessionId))) throw routeError('ROUTE_ALREADY_DECIDED', 'This route was already decided.', 409);
      throw routeError('ROUTE_NOT_FOUND', `Unknown route ${idOrRequestId}`, 404);
    }
    // A card of another session is not this caller's to answer: it reads as unknown.
    if (scoped && card.sessionId !== String(sessionId)) throw routeError('ROUTE_NOT_FOUND', `Unknown route ${idOrRequestId}`, 404);
    if (card.status !== 'pending') throw routeError('ROUTE_ALREADY_DECIDED', 'This route was already decided.', 409);
    return card;
  }
  /**
   * Answer a pending card (from the UI socket or REST). `sessionId`: the session
   * the answer came in on; a card of another session is refused (ROUTE_NOT_FOUND).
   */
  async function answer(idOrRequestId, response = {}, { origin = 'ui', sessionId = null, authority = null } = {}) {
    const closed = closedRoute(idOrRequestId, sessionId);
    if (closed) return { ...resultFor(closed.settled.status, { routeId: closed.routeId, mode: closed.mode, card: closed, sessionId: closed.sessionId }), ...(closed.settled.movedOn ? { reason: 'superseded' } : {}) };
    const card = openCard(idOrRequestId, { sessionId });
    const routeId = card.routeId;
    const cat = await catalogValue();
    // The card can close while the catalog is read (the user wrote something else: cancel; a
    // timeout; another host's answer). Only the card that is still this one, still pending, is
    // decided: an answer in progress never undoes a cancellation or decides a card twice.
    if (cards.get(routeId) !== card || card.status !== 'pending') openCard(routeId, { sessionId });
    const session = getSession(card.sessionId) || { brain: card.brain };
    if (card.taskId && session.taskId !== card.taskId) { expire(routeId, 'superseded', { movedOn: true }); throw routeError('ROUTE_TASK_CHANGED', 'This card belongs to an earlier task.', 409); }
    const brain = session.brain || card.brain || {};
    const brainInfo = brainInfoFor(brain);
    const parsed = targetFromAnswer({ card, response, catalog: cat, brain });
    if (parsed.declined) {
      card.status = 'declined';
      card.decidedBy = 'user';
      card.reasonCode = response.reason === 'dismissed' ? 'dismissed' : 'cancelled';
      for (const runId of card.runIds) call('declineHeld', runId, 'route_declined');
      const view = routeView({ ...card, status: 'declined', decidedBy: 'user' }, { catalog: cat, brain, brainInfo });
      call('routeEvent', card.sessionId, 'declined', view);
      const result = resultFor('declined', { routeId, mode: card.mode, card, cat, brain, brainInfo, runIds: [...card.runIds] });
      if (card.mailboxOnDecision && !card.waiters.size) call('mailbox', card.sessionId, { kind: 'route_declined', route: view, runIds: [...card.runIds], text: result.next });
      if (card.taskId) decided.set(routeId, { ...view, sessionId: card.sessionId, expiresAt: now() + DECIDED_TTL_MS });
      settle(card, { status: 'declined', result });
      closeCard(card);
      return result;
    }
    const { optionId, remember } = parsed;
    const target = card.needsHost
      ? accountTarget(parsed.target, brain, cat, { select: false })
      : checkedTarget(parsed.target, brain, cat, null, null, card.mode === 'always-ask');
    if (card.needsHost && target.kind !== 'direct') throw hostRouteError();
    const pickedRole = workerRole(card.request, target, optionId);
    const corrections = accountCorrections(target, parsed.corrections || []);
    // The session budget must be able to pay for the pick: a provider with no share left divides the
    // unspent budget again first; still none, and the card stays open with the reason.
    if (budgeted() && !budgetCovers(coverageOf(card.sessionId), cat, target)) {
      try { await budget.ensureCovered(card.sessionId, { provider: target.provider, forBrain: target.kind === 'direct', free: targetIsFree(cat, target) }); } catch { /* decided on the shares as they are */ }
      if (cards.get(routeId) !== card || card.status !== 'pending') openCard(routeId, { sessionId });
      if (!budgetCovers(coverageOf(card.sessionId), cat, target)) {
        const unpriced = unpricedText(target.provider);
        if (unpriced) throw routeError('BUDGET_UNPRICED', unpriced, 409, { provider: target.provider });
        throw routeError('BUDGET_SHARE_EXHAUSTED', `Budget: the ${providerLabel(target.provider)} share of this session's budget is used up. Pick another option (or a free model), or raise the budget.`, 409, { provider: target.provider });
      }
    }
    // "Here" on a held dispatch's card: the brain does the task in this conversation, so the held
    // worker runs are not started (they stop, route_here) and the brain is told to do it itself.
    const keptHere = card.runIds.size > 0 && target.kind === 'direct';
    // Every held run must be able to start on the pick (the dispatcher's checkHeld: a design run's
    // sight and browser settings on that provider). A pick one would refuse is not approved, saved
    // or reported started: the card stays open with the reason. A "here" pick starts none.
    if (!keptHere) {
      for (const runId of card.runIds) {
        const refusal = call('checkHeld', runId, target, pickedRole);
        if (refusal) throw routeError(refusal.code || 'ROUTE_INVALID', refusal.message || 'The held run cannot start on that model.', Number(refusal.status) || 400);
      }
    }
    // "Do it here" on another model continues in the turn the card was raised in,
    // handed over first. The runtime refuses a pick that turn no longer owns (a
    // newer prompt, a Stop or the session closing came after it): then nothing is
    // approved or remembered, and the card expires on every host.
    // An effort-only pick continues too: another effort than the brain's running turn is on (continuesNow), unless
    // its thinking switch waits for Claude Code's background work, which the answer then says (thinkingWaits).
    const here = keptHere || !card.runIds.size;
    const continuation = here && continuesNow(card.sessionId, target, brain);
    const waits = here && !continuation ? thinkingWaits(card.sessionId, target, brain, turnBrain(card.sessionId, brain)) : null;
    if (waits) corrections.push(waits);
    // The decision is claimed here, before the first side effect (the runtime's continuation, the
    // held runs, the mailbox): nothing a sink does can close or decide this card again meanwhile.
    card.status = 'approved';
    let queued = !continuation;
    if (continuation) {
      try { queued = maybeContinuation(card.sessionId, target, brain, { routeId, summary: card.summary, taskClass: card.taskClass, target, decidedBy: 'user', optionId }); }
      catch { queued = false; }
    }
    if (!queued) {
      card.status = 'pending';
      expire(routeId, 'superseded');
      log('router:superseded', `${routeId}: a "do it here" pick after its turn was replaced; nothing approved`);
      return { ...resultFor('expired', { routeId, mode: card.mode, card, cat, brain, brainInfo }), reason: 'superseded' };
    }
    let remembered = false;
    if (remember && card.taskClass !== 'chat' && configStore?.setPreference) {
      try {
        const described = describeTarget(target, { catalog: cat, brain, brainInfo });
        configStore.setPreference(card.taskClass, { ...target, kind: target.accountKind || target.kind, accountId: target.accountChoice || target.accountId, label: described?.label || null }, { by: 'user' });
        remembered = true;
      } catch (error) { log('router:remember-error', error?.message || String(error)); }
    }
    const heldRuns = keptHere ? [] : [...card.runIds];
    const droppedRuns = keptHere ? [...card.runIds] : [];
    const route = {
      ...(card.needsHost ? { needsHost: true } : {}),
      taskId: card.taskId, taskKey: card.taskKey || '', plannedSplit: card.plannedSplit || null, workflowId: null,
      routeId, status: 'approved', sessionId: card.sessionId, taskClass: card.taskClass, summary: card.summary, confidence: card.confidence,
      ...pickedRole,
      target, decidedBy: 'user', remembered, optionId, corrections, mode: card.mode, runIds: heldRuns,
      reason: card.options.find((o) => o.id === optionId)?.reason || null, alternatives: card.alternatives, expiresAt: now() + DECIDED_TTL_MS,
    };
    decided.set(routeId, route);
    noteBudgetTask(card.sessionId, { taskClass: card.taskClass, summary: card.summary }, target);
    // A remote session: the held run this card was for is its one dispatch.
    if (heldRuns.length && session.remote === true) route.consumed = true;
    for (const runId of droppedRuns) call('declineHeld', runId, 'route_here');
    for (const runId of heldRuns) call('startHeld', runId, target, { routeId, decidedBy: 'user', remembered, optionId, agentRequest: route.agentRequest });
    const view = routeView(route, { catalog: cat, brain, brainInfo });
    call('routeEvent', card.sessionId, 'decided', view);
    const inTurnWaiter = card.waiters.size > 0;
    const viaMailbox = !inTurnWaiter && !continuation && (card.mailboxOnDecision || card.runIds.size > 0);
    // The card said the Mac will be controlled, and this is the option it said it for: the yes is
    // also the computer approval of the turn that carries the route out (this one, or the mailbox
    // turn that executes the decided route). From what the card recorded when it was sent; the
    // runtime checks who answered and that nothing changed since. Before the result goes back.
    if (card.computer && optionId === card.computer.optionId && target.kind === 'direct' && !continuation && !heldRuns.length) {
      // `authority` is passed on untouched and never kept: the runtime alone can tell whose it is.
      call('computerApproved', card.sessionId, { routeId, origin, viaMailbox, authority });
    }
    // The brain proposed one kind and the user picked the other (the card's Here / Dispatch switch):
    // the result says so first, so the brain follows the pick, not its proposal.
    const proposed = card.request?.proposals?.[0]?.kind || null;
    const picked = target.accountKind || target.kind;
    const switched = proposed && proposed !== picked ? picked : null;
    const result = resultFor('approved', { routeId, mode: card.mode, source: 'user', target, corrections, cat, brain, brainInfo, remembered, runIds: heldRuns, continuation, sessionId: card.sessionId, switched, droppedRuns });
    if (viaMailbox) {
      const label = view.target?.label || 'a model';
      const what = card.summary ? `"${card.summary}"` : 'this task';
      const text = heldRuns.length ? `The user picked ${label}; the held run${heldRuns.length === 1 ? '' : 's'} started.`
        : droppedRuns.length ? `The user chose to do ${what} here with ${label} instead of on a worker: the held run${droppedRuns.length === 1 ? '' : 's'} ${droppedRuns.join(', ')} ${droppedRuns.length === 1 ? 'was' : 'were'} not started. Do that task here yourself now; do not dispatch it again.`
          : `The user picked ${label}. ${result.next}`;
      call('mailbox', card.sessionId, { kind: 'route_decided', route: view, runIds: heldRuns, ...(droppedRuns.length ? { droppedRunIds: droppedRuns } : {}), text });
    }
    settle(card, { status: 'approved', result });
    closeCard(card);
    log('router:decided', `${routeId} ${target.provider}/${target.model || 'default'} by ${origin}`);
    return result;
  }

  /**
   * agent_dispatch enforcement. Returns { action:'start', spec, route, claimed? } or
   * { action:'hold', routeId, spec, route }. UI dispatches are never held.
   * A remote session (WhatsApp: session.remote) gets one dispatch per card: a
   * decided route is used up by the first dispatch that starts a run (one the
   * dispatcher refuses first gives it back: releaseRoute), a card holds one run,
   * and a workflow does not fan out under one card. The desktop keeps both.
   */
  async function resolveDispatch({ sessionId, spec = {}, origin = 'assistant', team = null } = {}) {
    pruneDecided();
    if (origin === 'ui' || !sessionId) return { action: 'start', spec, route: null };
    const session = getSession(sessionId);
    if (!session) return { action: 'start', spec, route: null };
    const brain = session.brain || {};
    const cat = await catalogValue();
    const brainInfo = brainInfoFor(brain);
    const mode = modeFor(sessionId);
    const r = routing();
    const routeId = spec.routeId ? String(spec.routeId) : null;
    const remote = session.remote === true;
    if (routeId) {
      const approved = decided.get(routeId);
      const bound = approved || cards.get(routeId);
      if (bound?.sessionId === sessionId && !team) assertCurrentTask(sessionId, bound.taskId);
      if (bound?.sessionId === sessionId && bound.needsHost) throw hostRouteError();
      if (bound?.taskId && ['expired', 'cancelled'].includes(bound.status)) throw routeClosedError(lastClosed.get(routeId) || bound);
      if (bound?.taskId && (bound.status !== 'approved' && bound.status !== 'pending' || bound.consumed)) throw routeError('ROUTE_NOT_APPROVED', 'This task route is closed or already used.', 409);
      // The user picked "here" on this route's card: it runs in this conversation, never on a worker
      // (a brain's own direct route, or a saved one in Never ask, keeps its old dispatch behaviour).
      if (approved && approved.sessionId === sessionId && approved.target?.kind === 'direct' && approved.decidedBy === 'user') {
        const where = approved.target.model ? ` on ${approved.target.model}` : '';
        throw routeError('ROUTE_IS_DIRECT', `Route ${routeId} was decided by the user to run here, in this conversation${where}, not on a worker. Do the task yourself now; do not dispatch it. If it should go to a worker after all, ask the user, then call agent_route again.`, 409, { routeId, target: approved.target });
      }
      if (approved && approved.sessionId === sessionId && approved.target && (approved.plannedSplit || !approved.consumed)) {
        // A remote session's route is claimed here, so a second dispatch cannot take it meanwhile.
        // `claimed` tells the dispatcher to give it back (releaseRoute) if it refuses the launch
        // before a run exists: only the run it starts uses the route up.
        const t = checkedTarget(approved.target, brain, cat, approved, null, approved.mode === 'always-ask' && approved.decidedBy === 'user');
        approved.target = t;
        approved.corrections = accountCorrections(t, approved.corrections);
        // The approved provider may have run out of share since the approval: the unspent budget is
        // divided again first, then the dispatch moves the way agent_route would, or is refused.
        let runTarget = t;
        let budgetCorrection = null;
        if (budgeted() && !budgetCovers(coverageOf(sessionId), cat, t)) {
          if (approved.mode === 'always-ask' && approved.decidedBy === 'user') {
            const unpriced = unpricedText(t.provider);
            if (unpriced) throw routeError('BUDGET_UNPRICED', `${unpriced} Choose a new task route.`, 409, { routeId, provider: t.provider });
            throw routeError('BUDGET_SHARE_EXHAUSTED', 'The selected model has no session budget left. Choose a new task route or raise the budget.', 409, { routeId, provider: t.provider });
          }
          try { await budget.ensureCovered(sessionId, { provider: t.provider, forBrain: false, free: targetIsFree(cat, t), task: { taskClass: approved.taskClass, summary: approved.summary || null, provider: t.provider, model: t.model || null } }); } catch { /* decided on the shares as they are */ }
          const request = normalizeRouteRequest({ task_class: approved.taskClass, summary: approved.summary || '', confidence: 1, needs_vision: !!spec.usesComputer, proposals: [{ kind: 'dispatch', provider: t.provider, model: t.model || null, effort: t.effort || null }] }, { brain });
          const moved = budgetMove({ target: { ...t, kind: 'dispatch' }, request, catalog: cat, brain, brainInfo, routing: r, coverage: coverageOf(sessionId) });
          if (moved.declined) {
            throw routeError('BUDGET_SHARE_EXHAUSTED', `Route ${routeId} was approved for ${t.provider}${t.model ? `/${t.model}` : ''}, but ${t.provider} has no share of this session's budget left, and no other provider can take this task now (out of share: ${(moved.dry || []).join(', ') || 'all'}). Do not dispatch it again on this route: call agent_route again for this task, or tell the user the budget is used up (Assistant → Budget).`, 409, { routeId, provider: t.provider, dry: moved.dry || [] });
          }
          if (moved.correction) { runTarget = moved.target; budgetCorrection = moved.correction; }
        }
        const claim = approved.plannedSplit ? claimSplit(approved, spec, team) : null;
        if (remote && !approved.plannedSplit) approved.consumed = true;
        const applied = { ...spec, provider: runTarget.provider, model: runTarget.model || null, effort: runTarget.effort ?? null, accountId: runTarget.accountId || null, codexAccountId: null, claudeAccountId: null };
        const meta = routeMeta(approved, cat, brain, brainInfo);
        const route = budgetCorrection ? { ...meta, target: describeTarget(runTarget, { catalog: cat, brain, brainInfo }), corrections: [...(meta.corrections || []), budgetCorrection] } : meta;
        return { action: 'start', spec: applied, route: { ...route, requested: { provider: spec.provider || null, model: spec.model || null, effort: spec.effort || null } }, ...(claim ? { claimed: true, claim } : remote ? { claimed: true } : {}) };
      }
      const pending = cards.get(routeId);
      if (pending?.plannedSplit && pending.sessionId === sessionId) throw routeError('ROUTE_NOT_APPROVED', 'Wait for the whole task approval; do not dispatch or route individual workers.', 409, { routeId });
      if (pending && pending.sessionId === sessionId && pending.status === 'pending' && !(remote && pending.runIds.size)) {
        return { action: 'hold', routeId, spec, route: pendingMeta(pending) };
      }
    }
    if (team || spec.workerIndex != null) throw routeError('ROUTE_NOT_APPROVED', 'This split requires its approved route_id; do not route individual workers.', 409);
    const request = normalizeRouteRequest({
      task_class: spec.taskClass || 'code', confidence: spec.confidence ?? null, summary: spec.title || clip(spec.task, 200),
      needs_vision: !!spec.usesComputer,
      proposals: [{ kind: 'dispatch', provider: spec.provider || brain.provider, model: spec.model || null, effort: spec.effort || null, accountId: spec.accountId || spec.codexAccountId || spec.claudeAccountId || null }],
    }, { brain });
    Object.assign(request, taskIdentity(sessionId, session, spec));
    expireOtherTasks(sessionId, session.latestTaskId || request.taskId);
    const prior = existingTaskResult(request, sessionId, { cat, brain, brainInfo });
    if (prior && prior.routeId !== routeId) return resolveDispatch({ sessionId, spec: { ...spec, routeId: prior.routeId }, origin, team });
    request.proposals[0].agentRequest = agentRefOf(spec);
    request.roles = workerRoles(request, spec.cwd || spec.project, agentPinOf(spec));
    if (!spec.provider) request.proposals[0].provider = brain.provider || 'claude-code';
    const evaluation = await evaluateWithBudget(sessionId, { mode, routing: r, request, brain, brainInfo, catalog: cat });
    if (evaluation.unavailable === 'budget_exhausted') {
      throw routeError('BUDGET_SHARE_EXHAUSTED', budgetDeclinedText(sessionId, evaluation.dry || []), 409, { dry: evaluation.dry || [], taskClass: request.taskClass, reason: 'budget_exhausted' });
    }
    if (evaluation.unavailable) throw routeError('NO_CAPABLE_MODEL', noMakerText(request), 409, { requires: request.needsOutput, ...(request.needsOutput ? {} : { needs: 'vision' }), taskClass: request.taskClass });
    if (!evaluation.ask) {
      assertCurrentTask(sessionId, request.taskId);
      const raced = existingTaskResult(request, sessionId, { cat, brain, brainInfo });
      if (raced) return resolveDispatch({ sessionId, spec: { ...spec, routeId: raced.routeId }, origin, team });
      const t = checkedTarget(evaluation.auto, brain, cat);
      noteBudgetTask(sessionId, request, t);
      const applied = { ...spec, provider: t.provider, model: t.model || null, effort: t.effort ?? null, accountId: t.accountId || null, codexAccountId: null, claudeAccountId: null };
      const route = {
        ...workerRole(request, { ...t, kind: 'dispatch' }),
        routeId: `route-${randomId()}`, status: 'auto', decidedBy: evaluation.source === 'remembered' ? 'remembered' : evaluation.source === 'budget' ? 'budget' : 'brain', mode,
        taskClass: request.taskClass, confidence: request.confidence, target: t, corrections: accountCorrections(t, evaluation.corrections),
        remembered: evaluation.source === 'remembered',
      };
      Object.assign(route, taskIdentity(sessionId, session, spec), { summary: request.summary, expiresAt: now() + DECIDED_TTL_MS });
      if (route.taskId) decided.set(route.routeId, { ...route, status: 'approved', consumed: remote });
      return { action: 'start', spec: applied, route: { ...routeMeta(route, cat, brain, brainInfo), requested: { provider: spec.provider || null, model: spec.model || null, effort: spec.effort || null } } };
    }
    assertCurrentTask(sessionId, request.taskId);
    const raced = existingTaskResult(request, sessionId, { cat, brain, brainInfo });
    if (raced && raced.routeId !== routeId) return resolveDispatch({ sessionId, spec: { ...spec, routeId: raced.routeId }, origin, team });
    let card = request.taskId ? [...cards.values()].find(c => routeTaskIdentity(c) === routeTaskIdentity(request)) : spec.workflowId && !remote ? [...cards.values()].find((c) => c.sessionId === sessionId && c.status === 'pending' && c.taskId === request.taskId && c.workflowId && c.workflowId === spec.workflowId) : null;
    if (!card) {
      card = createCard({ sessionId, request, evaluation, brain, brainInfo, cat, mode, origin: 'dispatch', workflowId: spec.workflowId || null });
      call('sendCard', sessionId, card.packet);
      // Closed while it was being sent: there is no card to hold a run on.
      if (card.status !== 'pending') throw routeClosedError(card);
      call('routeEvent', sessionId, 'card', routeView({ ...card, status: 'pending', target: evaluation.proposal }, { catalog: cat, brain, brainInfo }));
    }
    return { action: 'hold', routeId: card.routeId, spec, route: pendingMeta(card) };
  }

  function routeMeta(route, cat, brain, brainInfo) {
    return {
      ...agentFields(route),
      routeId: route.routeId, status: route.status === 'approved' ? 'approved' : route.status, decidedBy: route.decidedBy || null, mode: route.mode || null,
      plannedSplit: route.plannedSplit || null, taskId: route.taskId || null, taskKey: route.taskKey || '', sessionId: route.sessionId || null,
      taskClass: route.taskClass || null, taskClassLabel: TASK_CLASS_META[route.taskClass]?.label || null, confidence: route.confidence ?? null,
      target: route.target ? describeTarget(route.target, { catalog: cat, brain, brainInfo }) : null,
      corrections: route.corrections || [], remembered: !!route.remembered, decidedAt: new Date(now()).toISOString(),
    };
  }
  function pendingMeta(card) {
    return {
      ...agentFields(card),
      routeId: card.routeId, taskId: card.taskId || null, taskKey: card.taskKey || '', sessionId: card.sessionId || null, status: 'pending', decidedBy: null, mode: card.mode, taskClass: card.taskClass,
      taskClassLabel: TASK_CLASS_META[card.taskClass]?.label || null, confidence: card.confidence ?? null,
      target: null, corrections: [], remembered: false, decidedAt: null,
    };
  }

  /**
   * Give back a remote route resolveDispatch claimed, when the dispatcher refused that dispatch
   * before a run existed (MODEL_CANNOT_SEE, BROWSER_SETTINGS_CONFLICT, a busy provider…): retrying
   * the route_id gets the route again, so it runs or is refused for the same reason, and never
   * falls through to a fresh route of another class.
   */
  function claimSplit(route, spec, team) {
    const split = route.plannedSplit;
    const mismatch = (text) => { throw routeError('ROUTE_SPLIT_MISMATCH', text, 409, { routeId: route.routeId }); };
    if (spec.taskClass && spec.taskClass !== route.taskClass) mismatch('Dispatch task_class must match the approved split.');
    let slot = 1;
    if (split.flow === 'team') {
      if (!team?.teamId || !team?.sliceId || spec.workflowId !== `team:${team.teamId}`) mismatch('This route requires agent_team plan → start, not individual dispatches.');
      if (route.workflowId && route.workflowId !== spec.workflowId) mismatch('This route already belongs to another team.');
      slot = team.sliceId;
    } else if (team) mismatch('This task was approved for one worker, not a team.');
    route.claims ||= new Map();
    if (route.claims.has(slot) && !team) mismatch('This worker already started. Use agent_send for follow-ups; do not route or dispatch it again.');
    if (!route.claims.has(slot) && route.claims.size >= split.workers) mismatch('All approved worker slots are assigned.');
    if (!team && [...route.claims.values()].some(c => c.task === spec.task)) mismatch('Every parallel worker needs a distinct task.');
    const token = randomBytes(12).toString('hex');
    const previous = route.claims.get(slot);
    route.claims.set(slot, { token, task: spec.task });
    if (team) route.workflowId = spec.workflowId;
    return { slot, token, previous };
  }

  function releaseRoute(routeId, claim = null) {
    const route = decided.get(String(routeId || ''));
    if (claim && route?.claims?.get(claim.slot)?.token === claim.token) {
      if (claim.previous) route.claims.set(claim.slot, claim.previous); else route.claims.delete(claim.slot);
      return true;
    }
    if (!route?.consumed) return false;
    route.consumed = false;
    return true;
  }

  /** Attach runs to an open card → false when the card is gone (the caller must not leave a run waiting on it). */
  function holdRuns(routeId, runIds = []) {
    const card = cards.get(routeId);
    if (!card || card.status !== 'pending') return false;
    for (const runId of runIds) if (runId) card.runIds.add(String(runId));
    card.mailboxOnDecision = true;
    refreshPacketRuns(card);
    return true;
  }
  function cancelForRun(runId, reason = 'run_stopped') {
    for (const card of [...cards.values()]) {
      if (!card.runIds.delete(String(runId))) continue;
      refreshPacketRuns(card);
      if (!card.runIds.size && card.origin === 'dispatch') expire(card.routeId, reason);
    }
  }
  /**
   * Close one pending card of a session without a decision (requestId or routeId) → true when
   * it was open. `sessionId` is required: a card of another session is never closed here.
   * 'superseded': the user wrote something else instead of answering (the WhatsApp bridge);
   * its held runs are declined, nothing is approved, and the brain hears no "declined" event.
   */
  function cancel(idOrRequestId, reason = 'cancelled', { sessionId = null } = {}) {
    const routeId = byRequest.get(String(idOrRequestId)) || String(idOrRequestId);
    const card = cards.get(routeId);
    if (!card || card.status !== 'pending') return false;
    if (!sessionId || card.sessionId !== String(sessionId)) return false;
    expire(routeId, reason, { movedOn: reason === 'superseded' });
    return true;
  }
  function cancelForSession(sessionId, reason = 'session_closed', { origins = null } = {}) {
    // The session closing, its brain going or a Stop: the runtime dropped its continuation; nothing watches it.
    for (const entry of continuations.values()) if (entry.sessionId === sessionId && !entry.started) closeContinuation(entry);
    for (const card of [...cards.values()]) {
      if (card.sessionId !== sessionId) continue;
      if (origins && !origins.includes(card.origin)) continue;
      expire(card.routeId, reason);
    }
  }
  function pendingCards(sessionId) { return [...cards.values()].filter((c) => c.sessionId === sessionId && c.status === 'pending').map((c) => c.packet); }
  /** A request id of an open route card; with `sessionId`, only a card of that session. */
  function owns(requestId, sessionId = null) {
    const routeId = byRequest.get(String(requestId));
    if (!routeId) return false;
    return sessionId === null || sessionId === undefined || cards.get(routeId)?.sessionId === String(sessionId);
  }
  function closedRoute(idOrRequestId, sessionId = null) {
    const id = String(idOrRequestId);
    return [...lastClosed.values()].find(c => c.taskId && (c.routeId === id || c.requestId === id)
      && (sessionId == null || c.sessionId === String(sessionId)) && ['expired', 'cancelled'].includes(c.settled?.status)) || null;
  }
  function status(routeId) {
    const card = cards.get(routeId);
    if (card) return { ...agentFields(card), routeId, status: card.status, sessionId: card.sessionId, taskId: card.taskId || null, taskKey: card.taskKey || '', runIds: [...card.runIds], taskClass: card.taskClass, expiresAt: new Date(card.expiresAt).toISOString(), request: card.packet.request };
    const route = decided.get(routeId);
    if (route) return { ...agentFields(route), routeId, status: route.status, sessionId: route.sessionId, taskId: route.taskId || null, taskKey: route.taskKey || '', runIds: route.runIds || [], taskClass: route.taskClass, target: route.target, decidedBy: route.decidedBy, plannedSplit: route.plannedSplit || null, workflowId: route.workflowId || null };
    return null;
  }

  /** The `[SynaBun Router]` line the brain sees when mode/preferences change. */
  function stamp(sessionId) {
    const r = routing();
    const mode = modeFor(sessionId);
    const prefs = Object.entries(r.preferences || {}).filter(([, p]) => p?.provider)
      .map(([cls, p]) => `${cls} → ${p.kind === 'direct' ? 'here' : p.provider}${p.model ? `/${p.model}` : ''}${p.effort ? ` (${p.effort})` : ''}${hasRouteAccounts(p.provider) ? ` as ${routeAccountText(p, { accounts: liveAccounts(catalog.peek?.()), brain: getSession(sessionId)?.brain, workers: { codex: configStore?.workers?.()?.codexAccount, 'claude-code': configStore?.workers?.()?.claudeAccount } })}` : ''}`);
    const modeLine = mode === 'always-ask' ? 'always ask (call agent_route before every actionable task; the user picks the model, and whether it runs here or on a worker)'
      : mode === 'never' ? 'never ask (agent_route approves at once; the saved routes below are binding and agent_route applies them over your pick, so classify the task correctly)'
        : `ask when unsure (agent_route asks the user below ${Math.round(r.askBelow * 100)}% confidence or for unknown/missing models)`;
    const text = `[SynaBun Router] Route mode: ${modeLine}.${prefs.length ? ` ${mode === 'never' ? 'Saved routes (binding)' : 'Remembered routes'}: ${prefs.join('; ')}.` : ''}`;
    const changed = stamps.get(sessionId) !== text;
    return { text, changed, commit: () => stamps.set(sessionId, text) };
  }

  function shutdown() {
    for (const entry of continuations.values()) closeContinuation(entry);
    continuations.clear();
    for (const card of [...cards.values()]) settle(card, { status: 'cancelled' });
    cards.clear();
    byRequest.clear();
  }

  return {
    continuationStarted, propose, answer, expireOtherTasks, resolveDispatch, releaseRoute, holdRuns, cancel, cancelForRun, cancelForSession, pendingCards, owns, closedRoute, status, modeFor, stamp, shutdown,
    routeClosedError: (routeId) => routeClosedError(lastClosed.get(String(routeId || '')) || { routeId: String(routeId || '') }),
    routing, escalationFor: ({ run, depth = 0 }) => escalationFor({ run, catalog: catalog.peek?.() || null, routing: routing(), depth }),
    _internals: { cards, decided, byRequest, continuations },
  };
}

export { TIERS, priceText };
