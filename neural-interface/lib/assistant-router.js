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
// All I/O is injected (catalog, config store, sinks into the runtime/dispatcher).

import { randomBytes } from 'node:crypto';
import { CATALOG_PROVIDERS, TIERS, defaultIsHidden, defaultModelRow, findModel, hiddenModelId, priceText, providerAllHidden, providerEmpty, rowIsHidden, rowMakes } from './assistant-catalog.js';
import { effectiveRouting, normalizeRouteMode } from './assistant-config.js';
import { normalizeEffort } from './effort-levels.js';

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
export const ROUTE_REASONS = Object.freeze(['always-ask', 'low_confidence', 'no_confidence', 'model_missing', 'model_unknown', 'model_disabled', 'model_unavailable', 'needs_vision', 'needs_output', 'no_capable_model']);
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

function clip(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
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
  return a.kind === b.kind && a.provider === b.provider && String(a.model || '') === String(b.model || '') && String(a.effort || '') === String(b.effort || '');
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
 * into one). A "direct" proposal on another provider is really a dispatch; for a
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
  const proposals = [];
  let coercedDirect = false;
  for (const raw of Array.isArray(body.proposals) ? body.proposals.slice(0, 3) : []) {
    if (!raw || typeof raw !== 'object') continue;
    let kind = raw.kind === 'direct' ? 'direct' : 'dispatch';
    let provider = CATALOG_PROVIDERS.includes(raw.provider) ? raw.provider : null;
    let model = raw.model ? String(raw.model).trim().slice(0, 200) : null;
    if (kind === 'direct') {
      if (provider && provider !== brain.provider) kind = 'dispatch';
      else provider = brain.provider || provider;
    }
    if (!provider) continue;
    if (dispatchOnly && kind === 'direct') {
      kind = 'dispatch';
      model = model || brain.model || null;
      if (!proposals.length) coercedDirect = true;
    }
    proposals.push({
      kind, provider, model,
      effort: raw.effort ? String(raw.effort).trim().slice(0, 40) : null,
      reason: raw.reason ? clip(raw.reason, 240) : null,
    });
  }
  if (!proposals.length) {
    const kind = meta.defaultKind;
    proposals.push({ kind, provider: brain.provider || 'claude-code', model: kind === 'direct' ? (brain.model || null) : null, effort: null, reason: null });
  }
  const request = { taskClass, taskClassLabel: meta.label, summary: clip(body.summary || '', 400), confidence, needsVision, proposals };
  if (needsOutput || dispatchOnly) Object.assign(request, { needsOutput, dispatchOnly, coercedDirect });
  if (visionOnly) request.visionOnly = true;
  return request;
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
 * pushed onto `corrections` as { field: 'effort', from, to, reason: 'effort_unsupported' }.
 */
export function effortChecked(target, catalog, corrections = null) {
  if (!target?.effort) return target;
  const { effort, corrected } = normalizeEffort({ provider: target.provider, model: target.model || null, effort: target.effort, catalog });
  if (corrected) corrections?.push({ field: 'effort', from: corrected.from, to: corrected.to, reason: 'effort_unsupported' });
  return effort === target.effort ? target : { ...target, effort };
}

/**
 * A saved route as a target. `dispatchOnly` (image / video creation): a saved
 * "here" becomes a dispatch onto the same model (the brain's, when it named none).
 */
function preferenceTarget(pref, brain, catalog = null, { dispatchOnly = false } = {}) {
  if (!pref?.provider) return null;
  const here = pref.kind === 'direct' && pref.provider === brain.provider;
  const kind = here && !dispatchOnly ? 'direct' : 'dispatch';
  const model = pref.model || (here && dispatchOnly ? brain.model || null : null);
  const target = { kind, provider: pref.provider, model, effort: pref.effort || null };
  // A remembered route onto a model the user since disabled is not applied.
  return catalog && isDisabled(catalog, target) ? null : target;
}

/** "here on <model>" / "<provider>/<model|default>", with " (<effort>)". */
export function routeText(target) {
  if (!target) return 'none';
  const where = target.kind === 'direct' ? `here${target.model ? ` on ${target.model}` : ''}` : `${target.provider}/${target.model || 'default'}`;
  return `${where}${target.effort ? ` (${target.effort})` : ''}`;
}

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

/**
 * Decide whether the user must be asked. Returns
 * { ask, reasons[], auto: target|null, proposal: target, corrections[], source }.
 * `auto` is the target to run when ask === false. For image / video creation
 * with no model in the catalog that makes the medium, and for design with none
 * that can see, it returns { ask: false, unavailable: 'no_capable_model', auto: null }
 * in every mode.
 */
export function evaluateRoute({ mode, routing = {}, request, brain = {}, brainInfo = null, catalog = null }) {
  const reasons = [];
  const corrections = [];
  const first = request.proposals[0];
  let proposal = { kind: first.kind, provider: first.provider, model: first.model, effort: first.effort };
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
  const sees = (target) => describeTarget(target, { catalog, brain, brainInfo })?.vision;
  const fit = (target) => designFit(catalog, target, { brain, brainInfo });
  // Too blind for this task: design needs a confirmed true (null never counts) on an available row; other vision work refuses a confirmed false.
  const tooBlind = (target) => (visionOnly ? fit(target) !== 'ok' : sees(target) === false);
  const remembered = preferenceTarget(routing.preferences?.[request.taskClass], brain, null, { dispatchOnly });
  const disabled = !!remembered && isDisabled(catalog, remembered);
  // A saved route onto a model that cannot make the medium (or, for design, is not known to see) is not applied either.
  const incapable = !!remembered && !disabled && (!targetMakes(catalog, remembered, medium) || (visionOnly && tooBlind(remembered)));
  const pref = remembered && !disabled && !incapable ? remembered : null;
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

  const effective = normalizeRouteMode(mode) || 'ask-unsure';
  if (effective === 'always-ask') return { ask: true, reasons: ['always-ask', ...reasons], auto: null, proposal, corrections, source };
  if (effective === 'ask-unsure') {
    const unsure = reasons.filter((r) => r !== 'no_confidence' || source !== 'remembered');
    if (unsure.length) return { ask: true, reasons: unsure, auto: null, proposal, corrections, source };
    return { ask: false, reasons, auto: proposal, proposal, corrections, source };
  }
  // never: the user's saved route for the class binds (the brain only classifies);
  // without an enabled one, run the brain's pick, correcting what cannot run.
  let auto = { ...proposal };
  const bound = !!pref;
  if (bound) {
    // Provider and model from the saved route; its effort when set, else the brain's.
    auto = { kind: pref.kind, provider: pref.provider, model: pref.model || (pref.kind === 'direct' ? brain.model || null : null), effort: pref.effort || proposal.effort || null };
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
    }
    const invalid = reasons.find((r) => r === 'model_unknown' || r === 'model_disabled');
    if (invalid && auto.model) {
      corrections.push({ field: 'model', from: auto.model, to: null, reason: invalid });
      auto = { ...auto, model: null };
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
  if (dispatchOnly && auto.kind !== 'dispatch') auto = { ...auto, kind: 'dispatch' };
  // A corrected model or provider re-checks the effort.
  auto = effortChecked(auto, catalog, corrections);
  if (!bound && corrections.some((c) => c.reason !== 'remembered_disabled' && c.reason !== 'remembered_incapable')) source = 'corrected';
  return { ask: false, reasons, auto, proposal, corrections, source, bound };
}

function optionFor(id, rawTarget, badge, { catalog, brain, brainInfo, needsVision, needsOutput = null, visionOnly = false, reason = null }) {
  const target = effortChecked(rawTarget, catalog);
  const d = describeTarget(target, { catalog, brain, brainInfo });
  const here = target.kind === 'direct';
  const label = here ? `Do it here with ${d.label}` : `${providerLabel(target.provider)} · ${d.label}${target.effort ? ` · ${target.effort}` : ''}`;
  // Design: only a confirmed vision: true on an available row; other vision work: a confirmed false is disabled, unknown is a warning.
  const fit = visionOnly ? designFit(catalog, target, { brain, brainInfo }) : 'ok';
  const option = {
    id, kind: target.kind, provider: target.provider, model: target.model || null, effort: target.effort || null,
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
  if (here && brainInfo?.contextWindow && d.contextWindow && d.contextWindow < brainInfo.contextWindow) {
    option.warning = `Smaller context (${Math.round(d.contextWindow / 1000)}k) than the current model; a long conversation may not fit.`;
  }
  return option;
}

export function providerLabel(provider) {
  return provider === 'claude-code' ? 'Claude Code' : provider === 'codex' ? 'Codex' : provider === 'opencode' ? 'OpenCode' : String(provider || 'Assistant');
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
 */
export function buildRouteOptions({ request, evaluation, brain = {}, brainInfo = null, catalog = null, routing = {} }) {
  const medium = request.needsOutput || null;
  const dispatchOnly = request.dispatchOnly === true;
  const visionOnly = request.visionOnly === true;
  const ctx = { catalog, brain, brainInfo, needsVision: request.needsVision, needsOutput: medium, visionOnly };
  const options = [];
  const push = (option) => { if (!options.some((o) => sameTarget(o, option))) options.push(option); };
  const hereTarget = { kind: 'direct', provider: brain.provider, model: brain.model || null, effort: brain.effort || null };
  request.proposals.forEach((p, index) => {
    const target = { kind: p.kind, provider: p.provider, model: p.model || (index === 0 ? evaluation.proposal?.model || null : null), effort: p.effort };
    if (index === 0 && evaluation.proposal) Object.assign(target, { model: evaluation.proposal.model, effort: evaluation.proposal.effort, provider: evaluation.proposal.provider, kind: evaluation.proposal.kind });
    push(optionFor(`s${index + 1}`, target, 'suggested', { ...ctx, reason: p.reason }));
  });
  if (!dispatchOnly) push(optionFor('here', hereTarget, 'current', ctx));
  const pref = preferenceTarget(routing.preferences?.[request.taskClass], brain, catalog, { dispatchOnly });
  if (pref) push(optionFor('r1', pref, 'remembered', ctx));
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
  // Order: suggested first, then here, remembered, a capable stand-in, cheaper, stronger.
  const order = { suggested: 0, current: 1, remembered: 2, capable: 3, cheaper: 4, stronger: 5 };
  options.sort((a, b) => (order[a.badge] ?? 9) - (order[b.badge] ?? 9) || String(a.id).localeCompare(String(b.id)));
  const defaultOption = options.find((o) => o.badge === 'suggested' && !o.disabled) || options.find((o) => !o.disabled) || options[0];
  return { options, defaultOptionId: defaultOption?.id || 'here' };
}

/** Validate a route-card answer; returns { declined } or { target, optionId, remember }. */
export function targetFromAnswer({ card, response = {}, catalog = null, brain = {} }) {
  if (response.decline === true || response.behavior === 'deny' || response.cancel === true) return { declined: true };
  const optionId = String(response.optionId || response.option_id || '').trim();
  const remember = response.remember === true || (typeof response.remember === 'string' && response.remember.length > 0);
  const option = optionId && optionId !== 'other' ? (card.options || []).find((o) => o.id === optionId) : null;
  // A card can remain open while the catalog or hidden-model list changes.
  // Check the chosen target again instead of trusting the option's old state.
  const ensureAvailable = (target) => {
    if (target.model && findModel(catalog, target.provider, target.model) === null) {
      if (isDisabled(catalog, target)) throw routeError('MODEL_DISABLED', `${target.model} is disabled in the Assistant's Models list. Pick an enabled model.`);
      throw routeError('ROUTE_INVALID', `Unknown model ${target.model} for ${target.provider}.`);
    }
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
  if (option) {
    if (option.disabled) throw routeError('ROUTE_INVALID', option.disabledReason || 'That option is not available for this task.');
    const corrections = [];
    const target = effortChecked({ kind: dispatchOnly ? 'dispatch' : option.kind, provider: option.provider, model: option.model || (dispatchOnly && option.kind === 'direct' ? brain.model || null : null), effort: option.effort }, catalog, corrections);
    ensureAvailable(target);
    return { target, optionId, remember, corrections };
  }
  const t = response.target;
  if (!t || typeof t !== 'object' || !CATALOG_PROVIDERS.includes(t.provider)) throw routeError('ROUTE_INVALID', 'Pick one of the options or a catalog model.');
  const kind = t.kind === 'direct' && t.provider === brain.provider && !dispatchOnly ? 'direct' : 'dispatch';
  const corrections = [];
  const target = effortChecked({ kind, provider: t.provider, model: t.model ? String(t.model) : null, effort: t.effort ? String(t.effort).trim().slice(0, 40) : null }, catalog, corrections);
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
    return { reason, cause, kind: 'retry', from, to: describeTarget(effortChecked({ kind: 'dispatch', provider, model: run.model || null, effort: run.effort || null }, catalog), { catalog }), depth: depth + 1 };
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
    if (pref?.provider && !(pref.provider === provider && pref.model === run.model) && !isDisabled(catalog, pref) && canRun({ kind: 'dispatch', provider: pref.provider, model: pref.model || null })) to = { kind: 'dispatch', provider: pref.provider, model: pref.model || null, effort: pref.effort || null };
  }
  if (!to && provider !== 'claude-code' && !medium) {
    const opus = strongestClaude(catalog);
    if (opus && canRun({ kind: 'dispatch', provider: 'claude-code', model: opus.id })) to = { kind: 'dispatch', provider: 'claude-code', model: opus.id, effort: 'high' };
  }
  if (!to) return null;
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
 *                               startHeld(runId, target, meta),
 *                               checkHeld(runId, target) → why the held run could not start on target ({ code, message, status }) or null,
 *                               declineHeld(runId, reason), routed(sessionId, result), routeFailed(sessionId, error) }
 * @param {object} [deps.clarifier] assistant-clarify.js — { blocking(sessionId, { independent }) }: while the
 *                               user has not answered the brain's questions, agent_route answers "clarifying"
 */
export function createAssistantRouter({
  catalog,
  configStore = null,
  getSession = () => null,
  sinks = {},
  now = Date.now,
  randomId = () => randomBytes(6).toString('hex'),
  log = () => {},
  clarifier = null,
} = {}) {
  if (!catalog) throw new Error('createAssistantRouter requires a catalog');
  const cards = new Map();     // routeId → card
  const byRequest = new Map(); // requestId → routeId
  // routeId → decided route (reusable by agent_dispatch route_id; a remote session's is
  // used up by the first dispatch that starts a run: `consumed`).
  const decided = new Map();
  const stamps = new Map();    // sessionId → last stamp shown to the brain
  const lastClosed = new Map(); // routeId → { routeId, settled } of recently closed cards
  const call = (name, ...args) => { try { return sinks[name]?.(...args); } catch (error) { log('router:sink-error', `${name}: ${error?.message || error}`); return undefined; } };

  function routing() { try { return configStore?.routing?.() || effectiveRouting({}); } catch { return effectiveRouting({}); } }
  function modeFor(sessionId) {
    const session = getSession(sessionId);
    return normalizeRouteMode(session?.routingMode) || routing().defaultMode;
  }
  async function catalogValue() {
    try { return await catalog.full(); } catch (error) { log('router:catalog-error', error?.message || String(error)); return catalog.peek?.() || { models: {} }; }
  }
  function brainInfoFor(brain) { try { return catalog.brainInfo(brain); } catch { return null; } }
  function requireSession(sessionId) {
    const session = sessionId ? getSession(sessionId) : null;
    if (!session) throw routeError('SESSION_NOT_FOUND', `Unknown assistant session ${sessionId}`, 404);
    return session;
  }
  function pruneDecided() {
    const cutoff = now();
    for (const [id, route] of decided) if (route.expiresAt < cutoff) decided.delete(id);
  }

  function routeView(source, { catalog: cat = null, brain = {}, brainInfo = null } = {}) {
    const target = source.target ? describeTarget(source.target, { catalog: cat, brain, brainInfo }) : null;
    return {
      routeId: source.routeId, runIds: [...(source.runIds || [])], taskClass: source.taskClass, taskClassLabel: TASK_CLASS_META[source.taskClass]?.label || source.taskClass,
      summary: source.summary || '', confidence: source.confidence ?? null, reason: source.reason || null,
      target, alternatives: (source.alternatives || []).slice(0, 4), decidedBy: source.decidedBy || null, remembered: !!source.remembered,
      optionId: source.optionId || null, corrections: source.corrections || [], mode: source.mode || null, status: source.status || null,
      // Why a route was declined without a card (no_capable_model), else null.
      reasonCode: source.reasonCode || null,
      // Design's no_capable_model: no model can see.
      ...(source.needs ? { needs: source.needs } : {}),
    };
  }

  function nextText(status, target, { routeId, label } = {}) {
    if (status === 'pending') return 'The user has not picked a model yet. End your turn now with one short line saying you are waiting for their choice. Their decision arrives as a [SynaBun Mailbox] route_decided event; do not start the task before it.';
    if (status === 'declined') return 'The user declined this route. Do not start the task; ask what they would like instead.';
    // The user wrote something else instead of choosing (cancel 'superseded'): their message is next, so nothing is asked here.
    if (status === 'moved_on') return 'The user did not pick a model: they sent a new message instead, which you get next. Nothing was approved, so do not start this task. End your turn now, with no text unless you have a result to report.';
    if (status === 'expired' || status === 'cancelled') return 'This route is no longer valid. Do not start the task; ask the user how to proceed.';
    if (!target) return 'Proceed.';
    if (target.kind === 'dispatch') {
      return `Dispatch now with agent_dispatch route_id="${routeId}" (provider ${target.provider}${target.model ? `, model ${target.model}` : ', provider default model'}${target.effort ? `, effort ${target.effort}` : ''}). Do not ask the user again about the model.`;
    }
    if (target.continuation) return `The user chose to run this here on ${label || target.model}. End your turn now with one short line; SynaBun continues this task on that model immediately after.`;
    return 'Proceed here yourself now.';
  }

  /** A "do it here" pick on another model or effort: the runtime continues the task on it. */
  function continuesHere(target, brain) {
    if (!target || target.kind !== 'direct') return false;
    if (String(target.model || '') === String(brain.model || '') && !target.effort) return false;
    if (String(target.model || '') === String(brain.model || '') && String(target.effort || '') === String(brain.effort || '')) return false;
    return true;
  }
  /** → whether the runtime took the continuation (continueDirect): false for a pick whose turn is gone. */
  function maybeContinuation(sessionId, target, brain, source) {
    if (!continuesHere(target, brain)) return false;
    return call('continueDirect', sessionId, { target, route: source, text: source.summary || '' }) !== false;
  }

  function resultFor(status, { routeId, mode, source = null, target = null, card = null, runIds = [], corrections = [], cat = null, brain = {}, brainInfo = null, remembered = false, continuation = false } = {}) {
    const described = target ? { ...describeTarget(target, { catalog: cat, brain, brainInfo }), continuation } : null;
    // A saved route that replaced the brain's pick (never mode) says so first.
    const binding = (corrections || []).find((c) => c?.reason === 'remembered_route');
    const skipped = (corrections || []).find((c) => c?.reason === 'remembered_disabled');
    // Image / video creation: a pick that cannot make the medium was moved onto one that can.
    const maker = (corrections || []).find((c) => c?.reason === 'needs_output');
    const lead = binding ? `The user's saved route for this task class applies (${binding.to}), not your pick (${binding.from}). `
      : skipped ? `The saved route for this task class (${skipped.from}) is on a disabled model, so your pick stands. `
        : maker ? `Your pick (${maker.from}) cannot make what this task creates, so it runs on ${maker.to}. ` : '';
    return {
      ok: true, status, routeId, mode, source, target: described, remembered, continuation,
      corrections, runIds, expiresAt: card?.expiresAt ? new Date(card.expiresAt).toISOString() : null,
      next: `${lead}${nextText(status, described, { routeId, label: described?.label })}`,
    };
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
      ok: true, status: 'declined', reason: 'no_capable_model', requires: request.needsOutput, ...(needs ? { needs } : {}), routeId, mode, source: 'rule', target: null,
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
    if (continuesHere({ kind: 'direct', provider: option.provider, model: option.model, effort: option.effort }, brain)) return null;
    return { optionId: option.id };
  }

  function createCard({ sessionId, request, evaluation, brain, brainInfo, cat, mode, origin, workflowId = null, runIds = [], session = null }) {
    const routeId = `route-${randomId()}`;
    const requestId = routeId;
    const r = routing();
    const { options, defaultOptionId } = buildRouteOptions({ request, evaluation, brain, brainInfo, catalog: cat, routing: r });
    const computer = computerConsent({ session, request, options, defaultOptionId, brain, origin });
    const expiresAt = now() + r.cardTimeoutMinutes * 60_000;
    const pref = r.preferences?.[request.taskClass];
    const card = {
      routeId, requestId, sessionId, origin, status: 'pending', mode, workflowId,
      taskClass: request.taskClass, summary: request.summary, confidence: request.confidence, needsVision: request.needsVision,
      needsOutput: request.needsOutput || null, dispatchOnly: request.dispatchOnly === true, visionOnly: request.visionOnly === true,
      reasons: evaluation.reasons, request, options, defaultOptionId, runIds: new Set(runIds), waiters: new Set(),
      createdAt: now(), expiresAt, timer: null, mailboxOnDecision: origin === 'dispatch', brain,
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
        confidence: request.confidence, needsVision: request.needsVision,
        // Image / video creation: the medium the model must generate, and no "here" (always a worker).
        requires: request.needsOutput || null, dispatchOnly: request.dispatchOnly === true,
        // Design: only models that can see.
        visionOnly: request.visionOnly === true,
        brain: { provider: brain.provider, model: brain.model || null, label: brainInfo?.label || brain.model || providerLabel(brain.provider), vision: brainInfo?.vision ?? null },
        options, defaultOptionId,
        other: { allowed: true, providers: CATALOG_PROVIDERS, catalogPath: '/api/assistant/catalog' },
        remember: { available: request.taskClass !== 'chat', taskClass: request.taskClass, label: request.taskClassLabel, current: pref ? (pref.label || [pref.provider, pref.model].filter(Boolean).join('/')) : null },
        decline: { allowed: true, label: 'Cancel' },
        // Approving this option also lets the Assistant control the Mac for the task: every host says so in words.
        ...(computer ? { computer: { optionId: computer.optionId } } : {}),
        createdAt: new Date(card.createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
      },
    };
    card.timer = setTimeout(() => expire(routeId), Math.max(1000, expiresAt - now()));
    card.timer.unref?.();
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
    if (card.timer) { clearTimeout(card.timer); card.timer = null; }
    byRequest.delete(card.requestId);
    cards.delete(card.routeId);
    // Why it closed, for a producer that attaches a run a moment too late (bounded).
    lastClosed.set(card.routeId, { routeId: card.routeId, settled: card.settled || null });
    while (lastClosed.size > 50) lastClosed.delete(lastClosed.keys().next().value);
  }

  // `reason` 'superseded': a "do it here" pick whose turn is gone (answer), or the user
  // wrote something else instead of choosing (cancel: `movedOn`). It reads as expired, and
  // the brain gets no mailbox event: the user already moved on.
  function expire(routeId, reason = 'expired', { movedOn = false } = {}) {
    const card = cards.get(routeId);
    if (!card || card.status !== 'pending') return;
    card.status = reason === 'expired' || reason === 'superseded' ? 'expired' : 'cancelled';
    const status = card.status;
    for (const runId of card.runIds) call('declineHeld', runId, reason === 'expired' ? 'route_expired' : `route_${reason}`);
    call('cancelCard', card.sessionId, card.requestId, reason);
    const view = routeView({ ...card, status, decidedBy: reason === 'expired' ? 'timeout' : null }, { catalog: catalog.peek?.(), brain: card.brain });
    call('routeEvent', card.sessionId, status === 'expired' ? 'expired' : 'cancelled', view);
    if ((card.mailboxOnDecision || card.runIds.size) && reason !== 'session_closed' && reason !== 'aborted' && reason !== 'superseded') {
      call('mailbox', card.sessionId, { kind: 'route_expired', route: view, runIds: [...card.runIds], text: `Route card for "${card.summary || card.taskClass}" ${status === 'expired' ? 'expired without an answer' : `was cancelled (${reason})`}.` });
    }
    settle(card, { status, routeId, ...(movedOn ? { movedOn: true } : {}) });
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
    try {
      const result = await proposeRoute(args);
      // The class rides along: a "chat" route must not unlock the gate.
      if (origin === 'agent_route') call('routed', args.sessionId, result, { taskClass: normalizeRouteRequest(args.body || {}).taskClass });
      return result;
    } catch (error) {
      if (origin === 'agent_route') call('routeFailed', args.sessionId, error);
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
  async function proposeRoute({ sessionId, body = {}, origin = 'agent_route', waitMs = null, signal = null } = {}) {
    pruneDecided();
    const session = requireSession(sessionId);
    const waiting = origin === 'agent_route' ? clarifier?.blocking?.(sessionId, { independent: body.independent === true }) : null;
    if (waiting) return clarifyingResult(sessionId, waiting);
    const brain = session.brain || {};
    const cat = await catalogValue();
    const brainInfo = brainInfoFor(brain);
    const request = normalizeRouteRequest(body, { brain });
    const mode = modeFor(sessionId);
    const r = routing();
    const evaluation = evaluateRoute({ mode, routing: r, request, brain, brainInfo, catalog: cat });
    if (evaluation.unavailable) return unavailableResult({ sessionId, request, mode, cat, brain, brainInfo });
    if (!evaluation.ask) {
      const routeId = `route-${randomId()}`;
      const target = evaluation.auto;
      const decidedBy = evaluation.source === 'remembered' ? 'remembered' : 'brain';
      const route = {
        routeId, status: 'approved', sessionId, taskClass: request.taskClass, summary: request.summary, confidence: request.confidence,
        target, decidedBy, remembered: evaluation.source === 'remembered', corrections: evaluation.corrections, mode,
        reason: request.proposals[0]?.reason || null, runIds: [], expiresAt: now() + DECIDED_TTL_MS,
      };
      decided.set(routeId, route);
      if (request.taskClass !== 'chat') call('routeEvent', sessionId, 'auto', routeView(route, { catalog: cat, brain, brainInfo }));
      const continuation = origin === 'agent_route' ? maybeContinuation(sessionId, target, brain, route) : false;
      return resultFor('approved', { routeId, mode, source: evaluation.source, target, corrections: evaluation.corrections, cat, brain, brainInfo, remembered: route.remembered, continuation });
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
      return resultFor('pending', { routeId: card.routeId, mode, card, cat, brain, brainInfo });
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
    const card = openCard(idOrRequestId, { sessionId });
    const routeId = card.routeId;
    const cat = await catalogValue();
    // The card can close while the catalog is read (the user wrote something else: cancel; a
    // timeout; another host's answer). Only the card that is still this one, still pending, is
    // decided: an answer in progress never undoes a cancellation or decides a card twice.
    if (cards.get(routeId) !== card || card.status !== 'pending') openCard(routeId, { sessionId });
    const session = getSession(card.sessionId) || { brain: card.brain };
    const brain = session.brain || card.brain || {};
    const brainInfo = brainInfoFor(brain);
    const parsed = targetFromAnswer({ card, response, catalog: cat, brain });
    if (parsed.declined) {
      card.status = 'declined';
      for (const runId of card.runIds) call('declineHeld', runId, 'route_declined');
      const view = routeView({ ...card, status: 'declined', decidedBy: 'user' }, { catalog: cat, brain, brainInfo });
      call('routeEvent', card.sessionId, 'declined', view);
      const result = resultFor('declined', { routeId, mode: card.mode, card, cat, brain, brainInfo, runIds: [...card.runIds] });
      if (card.mailboxOnDecision && !card.waiters.size) call('mailbox', card.sessionId, { kind: 'route_declined', route: view, runIds: [...card.runIds], text: `The user declined the route for "${card.summary || card.taskClass}".` });
      settle(card, { status: 'declined', result });
      closeCard(card);
      return result;
    }
    const { target, optionId, remember, corrections = [] } = parsed;
    // Every held run must be able to start on the pick (the dispatcher's checkHeld: a design run's
    // sight and browser settings on that provider). A pick one would refuse is not approved, saved
    // or reported started: the card stays open with the reason.
    for (const runId of card.runIds) {
      const refusal = call('checkHeld', runId, target);
      if (refusal) throw routeError(refusal.code || 'ROUTE_INVALID', refusal.message || 'The held run cannot start on that model.', Number(refusal.status) || 400);
    }
    // "Do it here" on another model continues in the turn the card was raised in,
    // handed over first. The runtime refuses a pick that turn no longer owns (a
    // newer prompt, a Stop or the session closing came after it): then nothing is
    // approved or remembered, and the card expires on every host.
    const continuation = !card.runIds.size && continuesHere(target, brain);
    // The decision is claimed here, before the first side effect (the runtime's continuation, the
    // held runs, the mailbox): nothing a sink does can close or decide this card again meanwhile.
    card.status = 'approved';
    if (continuation && !maybeContinuation(card.sessionId, target, brain, { routeId, summary: card.summary, taskClass: card.taskClass, target, decidedBy: 'user', optionId })) {
      card.status = 'pending';
      expire(routeId, 'superseded');
      log('router:superseded', `${routeId}: a "do it here" pick after its turn was replaced; nothing approved`);
      return { ...resultFor('expired', { routeId, mode: card.mode, card, cat, brain, brainInfo }), reason: 'superseded' };
    }
    let remembered = false;
    if (remember && card.taskClass !== 'chat' && configStore?.setPreference) {
      try {
        const described = describeTarget(target, { catalog: cat, brain, brainInfo });
        configStore.setPreference(card.taskClass, { ...target, label: described?.label || null }, { by: 'user' });
        remembered = true;
      } catch (error) { log('router:remember-error', error?.message || String(error)); }
    }
    const route = {
      routeId, status: 'approved', sessionId: card.sessionId, taskClass: card.taskClass, summary: card.summary, confidence: card.confidence,
      target, decidedBy: 'user', remembered, optionId, corrections, mode: card.mode, runIds: [...card.runIds],
      reason: card.options.find((o) => o.id === optionId)?.reason || null, alternatives: card.alternatives, expiresAt: now() + DECIDED_TTL_MS,
    };
    decided.set(routeId, route);
    const heldRuns = [...card.runIds];
    // A remote session: the held run this card was for is its one dispatch.
    if (heldRuns.length && session.remote === true) route.consumed = true;
    for (const runId of heldRuns) call('startHeld', runId, target, { routeId, decidedBy: 'user', remembered, optionId });
    const view = routeView(route, { catalog: cat, brain, brainInfo });
    call('routeEvent', card.sessionId, 'decided', view);
    const inTurnWaiter = card.waiters.size > 0;
    const viaMailbox = !inTurnWaiter && !continuation && (card.mailboxOnDecision || heldRuns.length > 0);
    // The card said the Mac will be controlled, and this is the option it said it for: the yes is
    // also the computer approval of the turn that carries the route out (this one, or the mailbox
    // turn that executes the decided route). From what the card recorded when it was sent; the
    // runtime checks who answered and that nothing changed since. Before the result goes back.
    if (card.computer && optionId === card.computer.optionId && target.kind === 'direct' && !continuation && !heldRuns.length) {
      // `authority` is passed on untouched and never kept: the runtime alone can tell whose it is.
      call('computerApproved', card.sessionId, { routeId, origin, viaMailbox, authority });
    }
    const result = resultFor('approved', { routeId, mode: card.mode, source: 'user', target, corrections, cat, brain, brainInfo, remembered, runIds: heldRuns, continuation });
    if (viaMailbox) {
      call('mailbox', card.sessionId, { kind: 'route_decided', route: view, runIds: heldRuns, text: heldRuns.length ? `The user picked ${view.target?.label || 'a model'}; the held run${heldRuns.length === 1 ? '' : 's'} started.` : `The user picked ${view.target?.label || 'a model'}. ${result.next}` });
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
  async function resolveDispatch({ sessionId, spec = {}, origin = 'assistant' } = {}) {
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
      if (approved && approved.sessionId === sessionId && approved.target && !approved.consumed) {
        // A remote session's route is claimed here, so a second dispatch cannot take it meanwhile.
        // `claimed` tells the dispatcher to give it back (releaseRoute) if it refuses the launch
        // before a run exists: only the run it starts uses the route up.
        if (remote) approved.consumed = true;
        const t = approved.target;
        const applied = { ...spec, provider: t.provider, model: t.model || null, effort: t.effort || spec.effort || null };
        return { action: 'start', spec: applied, route: { ...routeMeta(approved, cat, brain, brainInfo), requested: { provider: spec.provider || null, model: spec.model || null, effort: spec.effort || null } }, ...(remote ? { claimed: true } : {}) };
      }
      const pending = cards.get(routeId);
      if (pending && pending.sessionId === sessionId && pending.status === 'pending' && !(remote && pending.runIds.size)) {
        return { action: 'hold', routeId, spec, route: pendingMeta(pending) };
      }
    }
    const request = normalizeRouteRequest({
      task_class: spec.taskClass || 'code', confidence: spec.confidence ?? null, summary: spec.title || clip(spec.task, 200),
      needs_vision: !!spec.usesComputer,
      proposals: [{ kind: 'dispatch', provider: spec.provider || brain.provider, model: spec.model || null, effort: spec.effort || null }],
    }, { brain });
    if (!spec.provider) request.proposals[0].provider = brain.provider || 'claude-code';
    const evaluation = evaluateRoute({ mode, routing: r, request, brain, brainInfo, catalog: cat });
    if (evaluation.unavailable) throw routeError('NO_CAPABLE_MODEL', noMakerText(request), 409, { requires: request.needsOutput, ...(request.needsOutput ? {} : { needs: 'vision' }), taskClass: request.taskClass });
    if (!evaluation.ask) {
      const t = evaluation.auto;
      const applied = { ...spec, provider: t.provider, model: t.model || null, effort: t.effort || spec.effort || null };
      const route = {
        routeId: `route-${randomId()}`, status: 'auto', decidedBy: evaluation.source === 'remembered' ? 'remembered' : 'brain', mode,
        taskClass: request.taskClass, confidence: request.confidence, target: t, corrections: evaluation.corrections,
        remembered: evaluation.source === 'remembered',
      };
      return { action: 'start', spec: applied, route: { ...routeMeta(route, cat, brain, brainInfo), requested: { provider: spec.provider || null, model: spec.model || null, effort: spec.effort || null } } };
    }
    let card = spec.workflowId && !remote ? [...cards.values()].find((c) => c.sessionId === sessionId && c.status === 'pending' && c.workflowId && c.workflowId === spec.workflowId) : null;
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
      routeId: route.routeId, status: route.status === 'approved' ? 'approved' : route.status, decidedBy: route.decidedBy || null, mode: route.mode || null,
      taskClass: route.taskClass || null, taskClassLabel: TASK_CLASS_META[route.taskClass]?.label || null, confidence: route.confidence ?? null,
      target: route.target ? describeTarget(route.target, { catalog: cat, brain, brainInfo }) : null,
      corrections: route.corrections || [], remembered: !!route.remembered, decidedAt: new Date(now()).toISOString(),
    };
  }
  function pendingMeta(card) {
    return {
      routeId: card.routeId, status: 'pending', decidedBy: null, mode: card.mode, taskClass: card.taskClass,
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
  function releaseRoute(routeId) {
    const route = decided.get(String(routeId || ''));
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
  function status(routeId) {
    const card = cards.get(routeId);
    if (card) return { routeId, status: card.status, sessionId: card.sessionId, runIds: [...card.runIds], taskClass: card.taskClass, expiresAt: new Date(card.expiresAt).toISOString(), request: card.packet.request };
    const route = decided.get(routeId);
    if (route) return { routeId, status: route.status, sessionId: route.sessionId, runIds: route.runIds || [], taskClass: route.taskClass, target: route.target, decidedBy: route.decidedBy };
    return null;
  }

  /** The `[SynaBun Router]` line the brain sees when mode/preferences change. */
  function stamp(sessionId) {
    const r = routing();
    const mode = modeFor(sessionId);
    const prefs = Object.entries(r.preferences || {}).filter(([, p]) => p?.provider)
      .map(([cls, p]) => `${cls} → ${p.kind === 'direct' ? 'here' : p.provider}${p.model ? `/${p.model}` : ''}${p.effort ? ` (${p.effort})` : ''}`);
    const modeLine = mode === 'always-ask' ? 'always ask (call agent_route before every actionable task; the user picks the model)'
      : mode === 'never' ? 'never ask (agent_route approves at once; the saved routes below are binding and agent_route applies them over your pick, so classify the task correctly)'
        : `ask when unsure (agent_route asks the user below ${Math.round(r.askBelow * 100)}% confidence or for unknown/missing models)`;
    const text = `[SynaBun Router] Route mode: ${modeLine}.${prefs.length ? ` ${mode === 'never' ? 'Saved routes (binding)' : 'Remembered routes'}: ${prefs.join('; ')}.` : ''}`;
    const changed = stamps.get(sessionId) !== text;
    return { text, changed, commit: () => stamps.set(sessionId, text) };
  }

  function shutdown() {
    for (const card of [...cards.values()]) { if (card.timer) clearTimeout(card.timer); settle(card, { status: 'cancelled' }); }
    cards.clear();
    byRequest.clear();
  }

  return {
    propose, answer, resolveDispatch, releaseRoute, holdRuns, cancel, cancelForRun, cancelForSession, pendingCards, owns, status, modeFor, stamp, shutdown,
    routeClosedError: (routeId) => routeClosedError(lastClosed.get(String(routeId || '')) || { routeId: String(routeId || '') }),
    routing, escalationFor: ({ run, depth = 0 }) => escalationFor({ run, catalog: catalog.peek?.() || null, routing: routing(), depth }),
    _internals: { cards, decided, byRequest },
  };
}

export { TIERS, priceText };
