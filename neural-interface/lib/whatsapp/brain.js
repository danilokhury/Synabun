// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link: which brain runs the WhatsApp conversation
// ═══════════════════════════════════════════
//
// Pure. Settings → WhatsApp stores a choice: null ("Same as the Assistant":
// the brain the Assistant panel last used) or { provider, model, effort }.
// It is checked against the Assistant's own model catalog
// (lib/assistant-catalog.js: the list the panel's picker shows, disabled
// models left out) when it is saved, and again every time it is used: a
// choice that was disabled or removed since falls back to the default and
// says so. There is no second catalog here.

import { findModel, hiddenModelId } from '../assistant-catalog.js';
import { modelEfforts } from '../effort-levels.js';
import { providerLabel, remoteBrainLimited } from '../remote-policy.js';

export const BRAIN_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode']);
const EFFORT_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;
const MODEL_MAX = 200;

function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

/**
 * The shape of a stored choice: null (same as the Assistant) or
 * { provider, model, effort|null }. undefined for anything else.
 */
export function cleanBrainChoice(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).some((key) => !['provider', 'model', 'effort'].includes(key))) return undefined;
  if (!BRAIN_PROVIDERS.includes(value.provider)) return undefined;
  if (typeof value.model !== 'string') return undefined;
  const model = value.model.trim();
  if (!model || model.length > MODEL_MAX || /[\u0000-\u001f\u007f\u2028\u2029]/.test(model)) return undefined;
  let effort = null;
  if (value.effort !== null && value.effort !== undefined && value.effort !== '') {
    if (typeof value.effort !== 'string' || !EFFORT_RE.test(value.effort.trim())) return undefined;
    effort = value.effort.trim();
    if (/^(?:off|default|auto)$/i.test(effort)) effort = null;
  }
  return { provider: value.provider, model, effort };
}

function refusal(message, { code = 'CONFIG_INVALID', status = 400 } = {}) {
  return { ok: false, code, status, field: 'brain', message };
}

/**
 * A choice Settings wants to save, checked against the catalog value
 * (catalog.full()). → { ok:true, brain } with the catalog's own id and effort
 * spelling, or { ok:false, status, code, field:'brain', message }: an unknown
 * provider, a model the catalog does not list (or the user disabled), an
 * effort the model does not run. Nothing unchecked is ever stored: without a
 * catalog the answer is 503.
 */
export function checkBrainChoice(choice, catalog) {
  const clean = cleanBrainChoice(choice);
  if (clean === undefined) return refusal('brain must be null (same as the Assistant) or { provider, model, effort } with a provider of claude-code, codex or opencode');
  if (clean === null) return { ok: true, brain: null };
  if (!catalog || typeof catalog !== 'object') {
    return refusal('The model list is not available right now, so this model could not be checked. Try again in a few seconds.', { code: 'CATALOG_UNAVAILABLE', status: 503 });
  }
  const label = providerLabel(clean.provider);
  if (hiddenModelId(catalog, clean.provider, clean.model)) return refusal(`${clean.model} is disabled in the Assistant's Models list. Enable it there, or pick another model.`);
  const hit = findModel(catalog, clean.provider, clean.model);
  if (!hit?.row) return refusal(`${label} does not list a model called "${clean.model}" right now. Pick one from the list.`);
  let effort = null;
  if (clean.effort) {
    const levels = modelEfforts(hit.row) || [];
    effort = levels.find((id) => id.toLowerCase() === clean.effort.toLowerCase()) || null;
    if (!effort) return refusal(levels.length ? `${hit.row.label || hit.row.id} does not run the effort "${clean.effort}" (it has ${levels.join(', ')}).` : `${hit.row.label || hit.row.id} has no effort levels.`);
  }
  return { ok: true, brain: { provider: clean.provider, model: hit.row.id, effort } };
}

/**
 * The brain a WhatsApp conversation runs on now.
 * → { source: 'assistant' | 'choice', brain, fallback }
 *   source 'assistant': the panel's brain (`panelBrain`, possibly {}: the Assistant's default);
 *   fallback: { reason: 'disabled' | 'unknown', provider, model } when a stored choice
 *   could not be used. Only a definite answer falls back: a catalog that is not
 *   built yet, or a provider whose list is unavailable, keeps the choice.
 */
export function resolveBrainChoice(choice, { catalog = null, panelBrain = null } = {}) {
  const base = isPlainObject(panelBrain) ? { ...panelBrain } : {};
  const clean = cleanBrainChoice(choice);
  if (!clean) return { source: 'assistant', brain: base, fallback: null };
  if (catalog && typeof catalog === 'object') {
    const disabled = !!hiddenModelId(catalog, clean.provider, clean.model);
    if (disabled || !findModel(catalog, clean.provider, clean.model)) {
      return { source: 'assistant', brain: base, fallback: { reason: disabled ? 'disabled' : 'unknown', provider: clean.provider, model: clean.model } };
    }
  }
  // Where it works (the project) follows the panel; the account, MCP profile and
  // approval mode are the provider's own, so they carry over only on the same provider.
  const same = base.provider === clean.provider;
  const kept = same ? base : Object.fromEntries(['cwd', 'project'].filter((key) => base[key]).map((key) => [key, base[key]]));
  return { source: 'choice', brain: { ...kept, provider: clean.provider, model: clean.model, effort: clean.effort || null }, fallback: null };
}

/** What identifies the configured choice: a session switches brain only when this changes. */
export function brainSignature(target) {
  if (!target || target.source !== 'choice') return 'assistant';
  return `choice:${target.brain.provider}/${target.brain.model}/${target.brain.effort || ''}`;
}

/**
 * The choice as the Settings tab shows it (GET /api/whatsapp/status → brainChoice):
 * the stored choice, what a conversation runs on now, why a stored choice is not
 * used, and whether that brain holds Ask / Autonomous (Claude only).
 */
export function brainChoiceView(choice, { catalog = null, panelBrain = null } = {}) {
  const stored = cleanBrainChoice(choice) || null;
  const target = resolveBrainChoice(stored, { catalog, panelBrain });
  const brain = target.brain || {};
  const provider = BRAIN_PROVIDERS.includes(brain.provider) ? brain.provider : null;
  let row = null;
  if (provider && brain.model && catalog) { try { row = findModel(catalog, provider, brain.model)?.row || null; } catch { row = null; } }
  return {
    choice: stored,
    source: target.source,
    effective: provider ? { provider, providerLabel: providerLabel(provider), model: brain.model || null, modelLabel: row?.label || brain.model || null, effort: brain.effort || null } : null,
    fallback: target.fallback ? { ...target.fallback, providerLabel: providerLabel(target.fallback.provider) } : null,
    // Ask and Autonomous hold on a Claude brain only (lib/remote-policy.js): the note next to another choice.
    readOnly: provider && remoteBrainLimited(provider) ? { provider, label: providerLabel(provider) } : null,
    checked: !!catalog,
  };
}
