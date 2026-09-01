export const DEFAULT_CONTEXT_MODE = 'default';
export const EXTENDED_CONTEXT_MODE = 'extended';

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key];
    }
  }
  return undefined;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function percentage(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100 ? number : null;
}

function modelId(model) {
  return String(firstValue(model, ['id', 'model', 'slug', 'name']) || '').trim();
}

function catalogRows(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog?.models)) return catalog.models;
  if (Array.isArray(catalog?.data)) return catalog.data;
  return [];
}

export function normalizeCodexContextCapability(model) {
  const id = modelId(model);
  if (!id) return null;

  const contextWindow = positiveInteger(firstValue(model, [
    'contextWindow',
    'context_window',
  ]));
  let maxContextWindow = positiveInteger(firstValue(model, [
    'maxContextWindow',
    'max_context_window',
  ]));
  const effectiveContextWindowPercent = percentage(firstValue(model, [
    'effectiveContextWindowPercent',
    'effective_context_window_percent',
  ]));

  // A maximum below the advertised default is internally inconsistent. Drop it
  // so an incomplete/stale runtime catalog cannot accidentally enable the mode.
  if (contextWindow && maxContextWindow && maxContextWindow < contextWindow) {
    maxContextWindow = null;
  }

  return {
    id,
    contextWindow,
    maxContextWindow,
    effectiveContextWindowPercent,
  };
}

export function expectedEffectiveContextWindow(maxContextWindow, effectiveContextWindowPercent) {
  const maximum = positiveInteger(maxContextWindow);
  const percent = percentage(effectiveContextWindowPercent);
  if (!maximum || !percent) return null;
  return Math.floor(maximum * percent / 100);
}

/**
 * Merge context metadata from the account/runtime-scoped Codex model catalog
 * into the models reported as available by app-server `model/list`.
 *
 * App-server fields win when a newer server starts exposing them itself. The
 * runtime catalog only fills missing values, and never introduces a model that
 * was not present in the app-server response.
 */
export function mergeCodexModelContextCapabilities(appServerModels, runtimeCatalog) {
  const runtimeById = new Map();
  for (const row of catalogRows(runtimeCatalog)) {
    const capability = normalizeCodexContextCapability(row);
    if (!capability) continue;
    runtimeById.set(capability.id.toLowerCase(), capability);
  }

  const merged = [];
  for (const row of Array.isArray(appServerModels) ? appServerModels : []) {
    if (!row || typeof row !== 'object') continue;
    const appCapability = normalizeCodexContextCapability(row);
    if (!appCapability) continue;
    const runtimeCapability = runtimeById.get(appCapability.id.toLowerCase()) || null;
    const contextWindow = appCapability.contextWindow ?? runtimeCapability?.contextWindow ?? null;
    let maxContextWindow = appCapability.maxContextWindow ?? runtimeCapability?.maxContextWindow ?? null;
    const effectiveContextWindowPercent = appCapability.effectiveContextWindowPercent
      ?? runtimeCapability?.effectiveContextWindowPercent
      ?? null;

    if (contextWindow && maxContextWindow && maxContextWindow < contextWindow) {
      maxContextWindow = null;
    }

    const supportsExtendedContext = Boolean(
      contextWindow
      && maxContextWindow
      && maxContextWindow > contextWindow,
    );

    merged.push({
      ...row,
      contextWindow,
      maxContextWindow,
      effectiveContextWindowPercent,
      expectedEffectiveContextWindow: supportsExtendedContext
        ? expectedEffectiveContextWindow(maxContextWindow, effectiveContextWindowPercent)
        : null,
      supportsExtendedContext,
    });
  }
  return merged;
}

function isDefaultModel(model) {
  return model?.isDefault === true
    || model?.is_default === true
    || model?.default === true;
}

function availableModel(models, selectedModel) {
  const rows = Array.isArray(models) ? models : [];
  const requestedId = String(selectedModel || '').trim().toLowerCase();
  if (requestedId) {
    return rows.find((row) => modelId(row).toLowerCase() === requestedId) || null;
  }
  return rows.find(isDefaultModel) || null;
}

/**
 * Resolve an untrusted Sidepanel context-mode request against the live model
 * rows. Extended mode fails closed unless the selected (or explicit default)
 * model is available and advertises a strictly larger runtime maximum.
 */
export function resolveCodexExtendedContext({ models, selectedModel, contextMode } = {}) {
  const normalizedMode = contextMode === EXTENDED_CONTEXT_MODE
    ? EXTENDED_CONTEXT_MODE
    : DEFAULT_CONTEXT_MODE;
  const selected = availableModel(models, selectedModel);
  const selectedId = selected ? modelId(selected) : null;

  if (normalizedMode !== EXTENDED_CONTEXT_MODE) {
    return {
      contextMode: DEFAULT_CONTEXT_MODE,
      applied: false,
      model: selectedId,
      config: null,
      requestedContextWindow: null,
      expectedEffectiveContextWindow: null,
      reason: 'default-context',
    };
  }

  if (!selected) {
    return {
      contextMode: EXTENDED_CONTEXT_MODE,
      applied: false,
      model: null,
      config: null,
      requestedContextWindow: null,
      expectedEffectiveContextWindow: null,
      reason: 'model-unavailable',
    };
  }

  const capability = normalizeCodexContextCapability(selected);
  const maximum = capability?.maxContextWindow || null;
  const baseline = capability?.contextWindow || null;
  if (!baseline || !maximum || maximum <= baseline) {
    return {
      contextMode: EXTENDED_CONTEXT_MODE,
      applied: false,
      model: selectedId,
      config: null,
      requestedContextWindow: null,
      expectedEffectiveContextWindow: null,
      reason: 'extended-context-unavailable',
    };
  }

  return {
    contextMode: EXTENDED_CONTEXT_MODE,
    applied: true,
    model: selectedId,
    config: { model_context_window: maximum },
    requestedContextWindow: maximum,
    expectedEffectiveContextWindow: expectedEffectiveContextWindow(
      maximum,
      capability.effectiveContextWindowPercent,
    ),
    reason: null,
  };
}
