// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Context window gauge
// Derives usage from the newest assistant message already in the panel store
// (populated by sessionMessages + live message.updated events) and uses
// provider model metadata as the context-window denominator. We do NOT call
// the v2 session.context endpoint: chat traffic still flows through the v1
// prompt API, so v2's separate context projection is empty for our sessions.
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';

let _providers = null;
let _providersPromise = null;

export function mountContextGauge(rootEl, store = getDefaultStore()) {
  if (!rootEl) return { element: null, destroy() {}, refresh() {} };

  const gauge = document.createElement('div');
  gauge.className = 'ocpv2-context-gauge ocpv2-context-gauge-pending';
  gauge.setAttribute('data-tooltip-pos', 'bottom');
  gauge.innerHTML = '<div class="ocpv2-context-gauge-fill"></div><span class="ocpv2-context-gauge-label">context pending</span>';
  rootEl.appendChild(gauge);

  const fill = gauge.querySelector('.ocpv2-context-gauge-fill');
  const label = gauge.querySelector('.ocpv2-context-gauge-label');
  let destroyed = false;
  let refreshTimer = 0;
  let refreshSeq = 0;

  function scheduleRefresh(reason = 'state', delayMs = 250) {
    if (destroyed) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      refresh(reason).catch((err) => {
        if (!destroyed) console.warn('[ocp-v2-context-gauge] refresh failed', err);
      });
    }, Math.max(0, delayMs));
  }

  async function refresh(reason = 'manual') {
    if (destroyed) return false;
    const s = store.getState();
    const sessionId = s.sessionId;
    if (!sessionId) {
      store.resetContextGauge?.('idle');
      return false;
    }

    const seq = ++refreshSeq;
    const current = s.contextGauge || {};
    if (current.status !== 'ready') {
      store.setContextGauge?.({ status: 'pending', error: '', updatedAt: Date.now() });
    }

    try {
      const providers = await loadProviders();
      if (destroyed || seq !== refreshSeq || store.getState().sessionId !== sessionId) return false;

      const tokenBlock = findNewestTokenBlockFromStore(store.getState());
      const model = resolveActiveModel(store.getState(), tokenBlock);
      const contextWindow = resolveContextWindow(providers, model);
      const usedTokens = tokenBlock?.usedTokens || 0;
      const percent = usedTokens && contextWindow ? (usedTokens / contextWindow) * 100 : 0;

      store.setContextGauge?.({
        status: usedTokens > 0 && contextWindow ? 'ready' : 'pending',
        usedTokens,
        contextWindow: contextWindow || null,
        percent,
        model: model?.modelID || null,
        providerID: model?.providerID || null,
        basis: tokenBlock?.basis || 'message.tokens',
        breakdown: tokenBlock?.breakdown || null,
        messageId: tokenBlock?.messageId || '',
        updatedAt: Date.now(),
        error: usedTokens && !contextWindow ? 'context window unavailable for selected model' : '',
      });
      return true;
    } catch (err) {
      if (destroyed || seq !== refreshSeq || store.getState().sessionId !== sessionId) return false;
      store.setContextGauge?.({
        status: 'pending',
        updatedAt: Date.now(),
        error: err?.message || String(err),
      });
      return false;
    }
  }

  function onProvidersChanged() {
    _providers = null;
    _providersPromise = null;
    scheduleRefresh('providers:changed', 50);
  }

  const unsubscribe = store.subscribe((event, state) => {
    renderGauge(gauge, fill, label, state?.contextGauge);
    if (shouldRefreshForEvent(event, state)) scheduleRefresh(event?.type || 'state');
  });
  document.addEventListener('ocp-providers-changed', onProvidersChanged);

  renderGauge(gauge, fill, label, store.getState().contextGauge);
  scheduleRefresh('mount', 50);

  return {
    element: gauge,
    destroy() {
      destroyed = true;
      clearTimeout(refreshTimer);
      unsubscribe?.();
      document.removeEventListener('ocp-providers-changed', onProvidersChanged);
      gauge.remove();
    },
    refresh: () => refresh('manual'),
  };
}

function shouldRefreshForEvent(event, state) {
  if (!event || event.type === 'context:gauge') return false;
  if (!state?.sessionId) return event.type === 'session:set' || event.type === 'messages:clear';
  if (event.type === 'session:set') return true;
  if (event.type === 'config:model' || event.type === 'config:variant' || event.type === 'config:cwd') return true;
  if (event.type === 'server:status') return state.serverStatus === 'ready';
  if (event.type === 'running:set') return !state.running;
  // message:upsert carries the tokens block and can fire during a turn — refresh
  // either way so the gauge tracks live usage. Skip part:upsert during running
  // to avoid hammering the gauge on every streaming chunk.
  if (event.type === 'message:upsert') return true;
  if (event.type === 'part:upsert') return !state.running;
  if (event.type === 'messages:clear') return true;
  if (event.type === 'plan:actions:set' || event.type === 'plan:turn:complete') return true;
  return false;
}

function renderGauge(gauge, fill, label, value = {}) {
  if (!gauge || !fill || !label) return;
  const used = Number(value.usedTokens) || 0;
  const contextWindow = Number(value.contextWindow) || 0;
  const pct = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
  const ready = value.status === 'ready' && used > 0 && contextWindow > 0;

  gauge.className = 'ocpv2-context-gauge';
  gauge.classList.add(ready ? 'ocpv2-context-gauge-ready' : 'ocpv2-context-gauge-pending');
  if (ready && pct >= 90) gauge.classList.add('ocpv2-context-gauge-danger');
  else if (ready && pct >= 70) gauge.classList.add('ocpv2-context-gauge-warn');

  fill.style.width = ready ? `${Math.min(100, Math.max(0, pct))}%` : '0%';
  label.textContent = ready
    ? `${formatCompact(used)} / ${formatCompact(contextWindow)} · ${formatPercent(pct)}`
    : 'context pending';

  const tooltip = buildTooltip(value, ready, pct);
  gauge.title = tooltip;
  gauge.setAttribute('data-tooltip', tooltip);
}

function buildTooltip(value, ready, pct) {
  const breakdown = value?.breakdown || {};
  const model = value?.providerID && value?.model ? `${value.providerID}/${value.model}` : value?.model;
  const lines = ready ? [
    `${formatPercent(pct)} context window used`,
    `Used:           ${formatExact(value.usedTokens)}`,
    `Context window: ${formatExact(value.contextWindow)}`,
  ] : ['Context pending'];
  if (model) lines.push(`Model:          ${model}`);
  if (breakdown.inputTokens || breakdown.cacheReadTokens || breakdown.cacheWriteTokens) {
    lines.push(
      '',
      `Input:          ${formatExact(breakdown.inputTokens)}`,
      `Cache read:     ${formatExact(breakdown.cacheReadTokens)}`,
      `Cache write:    ${formatExact(breakdown.cacheWriteTokens)}`,
    );
  }
  if (breakdown.outputTokens || breakdown.reasoningTokens) {
    lines.push(
      `Output:         ${formatExact(breakdown.outputTokens)}`,
      `Reasoning:      ${formatExact(breakdown.reasoningTokens)}`,
    );
  }
  if (value?.basis) lines.push('', `Source:         ${value.basis}`);
  if (value?.updatedAt) lines.push(`Updated:        ${new Date(value.updatedAt).toLocaleString()}`);
  if (value?.error) lines.push('', `Note: ${value.error}`);
  return lines.filter(Boolean).join('\n');
}

async function loadProviders() {
  if (_providers) return _providers;
  if (_providersPromise) return _providersPromise;
  _providersPromise = fetch('/api/opencode/providers/full')
    .then((r) => r.json())
    .then((json) => {
      if (json?.ok === false) throw new Error(json.error || 'provider metadata unavailable');
      _providers = normalizeProviders(json?.data ?? json);
      return _providers;
    })
    .finally(() => { _providersPromise = null; });
  return _providersPromise;
}

function normalizeProviders(data) {
  if (Array.isArray(data)) return data;
  const all = data?.all || data?.providers || data?.items;
  if (Array.isArray(all)) return all;
  if (all && typeof all === 'object') {
    return Object.entries(all).map(([id, provider]) => ({ id, ...(typeof provider === 'object' ? provider : {}) }));
  }
  return [];
}

function findNewestTokenBlockFromStore(state) {
  const order = Array.isArray(state?.messageOrder) ? state.messageOrder : [];
  const messages = state?.messages;
  if (!order.length || !messages) return null;
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = messages.get(order[i]);
    if (!entry || entry.role !== 'assistant') continue;
    const info = entry.info || {};
    // v1 messages flatten model into modelID/providerID; v2 messages nest it
    // under info.model. normalizeModel handles both shapes.
    const itemModel = normalizeModel(info.model) || normalizeModel(info);
    const block = normalizeTokenBlock(info.tokens || info.usage, info.id || entry.id, itemModel, 'message.tokens');
    if (block) return block;
  }
  return null;
}

function normalizeTokenBlock(tokens, messageId = '', model = null, basis = 'session.context') {
  if (!tokens || typeof tokens !== 'object') return null;
  const inputTokens = readNumber(tokens.input, tokens.inputTokens, tokens.input_tokens);
  const cacheReadTokens = readNumber(tokens.cache?.read, tokens.cacheRead, tokens.cachedInputTokens, tokens.cache_read_input_tokens);
  const cacheWriteTokens = readNumber(tokens.cache?.write, tokens.cacheWrite, tokens.cacheCreationInputTokens, tokens.cache_creation_input_tokens);
  const outputTokens = readNumber(tokens.output, tokens.outputTokens, tokens.output_tokens);
  const reasoningTokens = readNumber(tokens.reasoning, tokens.reasoningOutputTokens, tokens.reasoning_output_tokens);
  const usedTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (usedTokens <= 0) return null;
  return {
    usedTokens,
    model,
    messageId,
    basis,
    breakdown: { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens },
  };
}

function resolveActiveModel(state, tokenBlock) {
  return normalizeModel(state?.model)
    || normalizeModel(tokenBlock?.model)
    || normalizeModel(state?.sessionInfo?.model)
    || null;
}

function resolveContextWindow(providers, model) {
  if (!model?.modelID) return null;
  const providerId = String(model.providerID || '').toLowerCase();
  const modelId = String(model.modelID || '').toLowerCase();
  for (const provider of providers || []) {
    const currentProviderId = String(provider?.id || provider?.providerID || provider?.providerId || '').toLowerCase();
    if (providerId && currentProviderId && currentProviderId !== providerId) continue;
    for (const entry of modelEntries(provider)) {
      if (String(entry.id || '').toLowerCase() !== modelId) continue;
      const modelObj = entry.model || {};
      const limit = readNumber(modelObj.limit?.context, modelObj.limits?.context, modelObj.contextWindow, modelObj.context_window, modelObj.context);
      if (limit > 0) return limit;
    }
  }
  return null;
}

function modelEntries(provider) {
  const models = provider?.models;
  if (Array.isArray(models)) {
    return models.map((model) => ({ id: modelIdFor(model), model: typeof model === 'object' ? model : { id: model } })).filter((entry) => entry.id);
  }
  if (models && typeof models === 'object') {
    return Object.entries(models).map(([id, model]) => ({
      id: modelIdFor(model) || id,
      model: typeof model === 'object' ? { id, ...model } : { id },
    })).filter((entry) => entry.id);
  }
  return [];
}

function modelIdFor(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.id || value.modelID || value.modelId || value.name || '';
}

function normalizeModel(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const idx = value.indexOf('/');
    return idx >= 0
      ? { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) }
      : { providerID: '', modelID: value };
  }
  if (typeof value !== 'object') return null;
  const providerID = value.providerID || value.providerId || value.provider || '';
  const modelID = value.modelID || value.modelId || value.id || value.name || '';
  return modelID ? { providerID, modelID } : null;
}

function readNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 0;
}

function formatExact(value) {
  const n = Number(value) || 0;
  return n.toLocaleString();
}

function formatCompact(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${trimFixed(n / 1_000_000)}m`;
  if (n >= 1_000) return `${trimFixed(n / 1_000)}k`;
  return String(Math.round(n));
}

function formatPercent(value) {
  const n = Number(value) || 0;
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}%`;
}

function trimFixed(value) {
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return fixed.replace(/\.0$/, '');
}
