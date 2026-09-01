// Shared launch/runtime metadata for Automation Studio, Schedules Studio,
// and agent sidepanels.

export const CLI_PROFILES = [
  { id: 'claude-code', label: 'Claude Code', desc: 'Anthropic' },
  { id: 'codex', label: 'Codex CLI', desc: 'OpenAI' },
  { id: 'gemini', label: 'Gemini CLI', desc: 'Google' },
  { id: 'opencode', label: 'OpenCode CLI', desc: 'Multi-provider' },
];

const STATIC_MODELS = {
  gemini: [
    { id: 'gemini-2.5-pro', label: '2.5 Pro', desc: 'Most capable', tier: 'default' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash', desc: 'Lightweight' },
  ],
};

// Claude Code models are discovered live from the installed CLI via
// /api/claude/models (see lib/claude-model-catalog.js) — the CLI is the only
// source that knows which models the account can actually run. This list is a
// last-resort fallback for when that call fails; ids are CLI aliases, already
// spawn-ready, so they carry no ":<contextWindow>" composite (see cliReady).
export const CLAUDE_FALLBACK_MODELS = [
  { id: 'default', label: 'Default (recommended)', desc: 'CLI default model', tier: 'default', cliReady: true, contextWindow: 200000 },
  { id: 'opus', label: 'Opus', desc: 'Most capable', cliReady: true, contextWindow: 200000 },
  { id: 'sonnet', label: 'Sonnet', desc: 'Balanced', cliReady: true, contextWindow: 200000 },
  { id: 'haiku', label: 'Haiku', desc: 'Fastest', cliReady: true, contextWindow: 200000, effortLevels: [] },
];

// Kept as fallbacks only. Codex/OpenCode should use live discovery when available.
export const CODEX_FALLBACK_MODELS = [
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', desc: 'Agentic coding', tier: 'default' },
  { id: 'gpt-5.5', label: 'GPT-5.5', desc: 'Frontier coding', tier: 'top' },
  { id: 'gpt-5.4', label: 'GPT-5.4', desc: 'Professional work' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', desc: 'Fast coding' },
  { id: 'chat-latest', label: 'Chat Latest', desc: 'ChatGPT instant model' },
];

export const CODEX_DEFAULT_MODEL_IDS = CODEX_FALLBACK_MODELS.map(m => m.id);

export const EFFORT_LEVELS_BY_PROFILE = {
  'claude-code': [
    { id: 'off', label: 'Off', desc: 'No thinking' },
    { id: 'low', label: 'Low', desc: 'Minimal' },
    { id: 'medium', label: 'Med', desc: 'Balanced', tier: 'default' },
    { id: 'high', label: 'High', desc: 'Deep' },
    { id: 'xhigh', label: 'XHigh', desc: 'Very deep' },
    { id: 'max', label: 'Max', desc: 'Maximum', tier: 'top' },
  ],
  codex: [
    { id: 'off', label: 'Default', desc: 'Config default' },
    { id: 'minimal', label: 'Min', desc: 'Minimal' },
    { id: 'low', label: 'Low', desc: 'Light' },
    { id: 'medium', label: 'Med', desc: 'Balanced', tier: 'default' },
    { id: 'high', label: 'High', desc: 'Deep' },
    { id: 'xhigh', label: 'XHigh', desc: 'Maximum', tier: 'top' },
  ],
};

export const CODEX_EFFORT_VALUE_IDS = EFFORT_LEVELS_BY_PROFILE.codex.map(e => e.id);

let _codexModelsCache = null;
let _codexModelsLoading = null;
let _opencodeModelsCache = null;
let _opencodeModelsLoading = null;
let _claudeModelsCache = null;
let _claudeModelsLoading = null;
let _mcpProfilePresets = null;

function localJsonArray(key) {
  try {
    const value = localStorage.getItem(key);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getCodexModelName(model) {
  const name = typeof model === 'string' ? model : (model?.id || model?.model || model?.name || '');
  return String(name || '').trim();
}

function titleFromModelId(id) {
  return String(id || '')
    .split(/[-_/]+/)
    .filter(Boolean)
    .map(part => (/^(gpt|api|cli|oss)$/i.test(part) ? part.toUpperCase() : part[0]?.toUpperCase() + part.slice(1)))
    .join(' ');
}

const CODEX_NON_TEXT_MODEL_RE = /(?:^|[-_/])(embedding|moderation|realtime|audio|tts|transcribe|transcription|whisper|image|img|sora|video|search|computer-use)(?:[-_/]|$)/i;
const CODEX_LEGACY_TEXT_MODEL_RE = /^(?:gpt-3(?:\.5)?(?:[-_/]|$)|gpt-4(?:o)?(?:[-_/]|$)|gpt-5(?:-codex|-mini|-nano|-pro|$)|gpt-5\.1(?:[-_/]|$)|gpt-5\.2-codex(?:[-_/]|$)|o[134](?:[-_/]|$)|o4-mini(?:[-_/]|$)|codex-mini-latest(?:[-_/]|$)|babbage|davinci|chatgpt-4o(?:[-_/]|$))/i;

function codexModelValue(model, keys) {
  for (const key of keys) {
    if (model?.[key] != null) return model[key];
  }
  return '';
}

function isDeprecatedOrHiddenCodexModel(model) {
  if (!model || typeof model !== 'object') return false;
  if (model.hidden === true || model.isHidden === true || model.visible === false) return true;
  if (model.deprecated === true || model.isDeprecated === true || model.retired === true) return true;
  const status = String(codexModelValue(model, ['status', 'state', 'lifecycle', 'availability']) || '').toLowerCase();
  if (/\b(deprecated|retired|disabled|hidden|unavailable)\b/.test(status)) return true;
  const text = [
    model.label,
    model.title,
    model.description,
    model.desc,
    model.note,
    model.badge,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\bdeprecated\b/.test(text);
}

function isCodexRunnableTextModel(model) {
  const id = getCodexModelName(model);
  if (!id) return false;
  const normalized = id.toLowerCase();
  if (isDeprecatedOrHiddenCodexModel(model)) return false;
  if (normalized === 'chat-latest') return true;
  if (CODEX_LEGACY_TEXT_MODEL_RE.test(normalized)) return false;
  return !CODEX_NON_TEXT_MODEL_RE.test(normalized);
}

function normalizeCodexModel(model) {
  const id = getCodexModelName(model);
  if (!id) return null;
  const known = CODEX_FALLBACK_MODELS.find(m => m.id.toLowerCase() === id.toLowerCase());
  const supportedReasoningEfforts = codexModelValue(model, [
    'supportedReasoningEfforts',
    'supported_reasoning_efforts',
    'supportedReasoningLevels',
    'supported_reasoning_levels',
  ]);
  const contextWindow = Number(codexModelValue(model, ['contextWindow', 'context_window'])) || null;
  const maxContextWindow = Number(codexModelValue(model, ['maxContextWindow', 'max_context_window'])) || null;
  const effectiveContextWindowPercent = Number(codexModelValue(model, [
    'effectiveContextWindowPercent',
    'effective_context_window_percent',
  ])) || null;
  const expectedEffectiveContextWindow = Number(codexModelValue(model, [
    'expectedEffectiveContextWindow',
    'expected_effective_context_window',
  ])) || null;
  return {
    id,
    label: model?.displayName || model?.display_name || model?.label || model?.title || model?.name || known?.label || titleFromModelId(id),
    desc: model?.desc || model?.description || known?.desc || '',
    tier: model?.tier || known?.tier,
    supportedReasoningEfforts: Array.isArray(supportedReasoningEfforts) ? supportedReasoningEfforts : [],
    defaultReasoningEffort: codexModelValue(model, [
      'defaultReasoningEffort',
      'default_reasoning_effort',
      'defaultReasoningLevel',
      'default_reasoning_level',
    ]) || '',
    contextWindow,
    maxContextWindow,
    effectiveContextWindowPercent,
    expectedEffectiveContextWindow,
    supportsExtendedContext: model?.supportsExtendedContext === true
      || model?.supports_extended_context === true
      || !!(contextWindow && maxContextWindow && maxContextWindow > contextWindow),
    isDefault: model?.isDefault === true || model?.is_default === true || model?.default === true,
    serviceTiers: codexModelValue(model, ['serviceTiers', 'service_tiers']) || [],
    defaultServiceTier: codexModelValue(model, ['defaultServiceTier', 'default_service_tier']) || '',
    additionalSpeedTiers: codexModelValue(model, ['additionalSpeedTiers', 'additional_speed_tiers']) || [],
    upgrade: model?.upgrade || model?.upgradeInfo || model?.upgrade_info || null,
  };
}

export function mergeCodexModelOptions(models = []) {
  const merged = [];
  const seen = new Set();
  const liveModels = Array.isArray(models) ? models.filter(isCodexRunnableTextModel) : [];
  const source = liveModels.length ? liveModels : CODEX_FALLBACK_MODELS;
  for (const model of source) {
    const option = normalizeCodexModel(model);
    const key = option?.id?.toLowerCase();
    if (!option || !key || seen.has(key)) continue;
    seen.add(key);
    merged.push(option);
  }
  return merged;
}

export function mergeCodexModelIds(models = []) {
  return mergeCodexModelOptions(models).map(m => m.id);
}

export async function fetchCodexModels(force = false) {
  if (!force && _codexModelsCache && _codexModelsCache.length) return _codexModelsCache;
  if (_codexModelsLoading) return _codexModelsLoading;
  _codexModelsLoading = (async () => {
    try {
      const resp = await fetch('/api/codex/models');
      const data = await resp.json().catch(() => ({}));
      const models = Array.isArray(data?.models) ? data.models : [];
      _codexModelsCache = mergeCodexModelOptions(models);
      return _codexModelsCache;
    } catch {
      _codexModelsCache = mergeCodexModelOptions([]);
      return _codexModelsCache;
    } finally {
      _codexModelsLoading = null;
    }
  })();
  return _codexModelsLoading;
}

let _codexAccountsCache = null;
let _codexAccountsLoading = null;

// Fetch the saved ChatGPT/Codex accounts for launch-account selectors.
// Each account maps to a CODEX_HOME on the server; 'default' is the existing ~/.codex.
export async function fetchCodexAccounts(force = false) {
  if (!force && _codexAccountsCache && _codexAccountsCache.length) return _codexAccountsCache;
  if (_codexAccountsLoading) return _codexAccountsLoading;
  _codexAccountsLoading = (async () => {
    try {
      const resp = await fetch('/api/codex/accounts');
      const data = await resp.json().catch(() => ({}));
      const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
      _codexAccountsCache = accounts.length ? accounts : [{ id: 'default', label: 'Default', isDefault: true }];
      return _codexAccountsCache;
    } catch {
      _codexAccountsCache = [{ id: 'default', label: 'Default', isDefault: true }];
      return _codexAccountsCache;
    } finally {
      _codexAccountsLoading = null;
    }
  })();
  return _codexAccountsLoading;
}

export function getCachedCodexAccounts() {
  return _codexAccountsCache || [{ id: 'default', label: 'Default', isDefault: true }];
}

export function parseOpencodeProviderModels(raw) {
  const data = raw?.data || raw || {};
  const all = Array.isArray(data.all)
    ? data.all
    : (Array.isArray(data.providers)
      ? data.providers
      : (Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : [])));
  const connectedValues = Array.isArray(data.connected) ? data.connected : [];
  const connected = new Set(
    connectedValues
      .map(entry => String((entry && typeof entry === 'object') ? (entry.id || entry.name || '') : entry || '').trim())
      .filter(Boolean)
  );
  if (!connected.size && all.length) {
    for (const provider of all) {
      if (provider?.id) connected.add(String(provider.id));
    }
  }
  const hidden = new Set(localJsonArray('ocp-hidden-models'));
  const out = [];
  for (const provider of all) {
    if (!provider?.id) continue;
    const providerId = String(provider.id);
    if (connected.size && !connected.has(providerId)) continue;
    const modelObj = provider.models || {};
    const models = Array.isArray(modelObj)
      ? modelObj.map((model, index) => [String(index), model])
      : Object.entries(modelObj);
    for (const [key, model] of models) {
      if (!model) continue;
      const keyLooksLikeIndex = /^\d+$/.test(String(key));
      const modelId = typeof model === 'string'
        ? model
        : (model.id || model.modelID || model.model || (!keyLooksLikeIndex ? key : model.name));
      if (!modelId) continue;
      const fullId = String(modelId).includes('/') ? String(modelId) : `${providerId}/${modelId}`;
      if (hidden.has(fullId)) continue;
      out.push({
        id: fullId,
        label: (typeof model === 'object' && (model.name || model.label || model.title)) || modelId,
        desc: provider.name || providerId,
        provider: providerId,
      });
    }
  }
  return out;
}

export async function fetchOpencodeModels(force = false) {
  if (!force && _opencodeModelsCache && _opencodeModelsCache.length) return _opencodeModelsCache;
  if (_opencodeModelsLoading) return _opencodeModelsLoading;
  _opencodeModelsLoading = (async () => {
    try {
      const resp = await fetch('/api/opencode/providers/full');
      const data = await resp.json().catch(() => ({}));
      if (!data || data.ok === false) return [];
      const out = parseOpencodeProviderModels(data);
      if (out.length) _opencodeModelsCache = out;
      return out;
    } catch {
      return [];
    } finally {
      _opencodeModelsLoading = null;
    }
  })();
  return _opencodeModelsLoading;
}

// Live model list from the installed Claude Code CLI. Falls back to the static
// list so the picker still renders when the CLI is missing or discovery fails.
export async function fetchClaudeModels(force = false) {
  if (!force && _claudeModelsCache && _claudeModelsCache.length) return _claudeModelsCache;
  if (_claudeModelsLoading) return _claudeModelsLoading;
  _claudeModelsLoading = (async () => {
    try {
      const resp = await fetch(`/api/claude/models${force ? '?refresh=1' : ''}`);
      const data = await resp.json().catch(() => ({}));
      const models = Array.isArray(data?.models) ? data.models : [];
      _claudeModelsCache = models.length ? models : [...CLAUDE_FALLBACK_MODELS];
      return _claudeModelsCache;
    } catch {
      _claudeModelsCache = [...CLAUDE_FALLBACK_MODELS];
      return _claudeModelsCache;
    } finally {
      _claudeModelsLoading = null;
    }
  })();
  return _claudeModelsLoading;
}

// Profiles whose model list is fetched at runtime rather than baked in. Callers use
// this to decide whether to kick off an async load and re-render when it lands.
export function isDynamicModelProfile(profileId) {
  return profileId === 'opencode' || profileId === 'codex' || profileId === 'claude-code';
}

export async function ensureModelsForProfile(profileId, force = false) {
  if (profileId === 'codex') return fetchCodexModels(force);
  if (profileId === 'opencode') return fetchOpencodeModels(force);
  if (profileId === 'claude-code') return fetchClaudeModels(force);
  return getModelsForProfile(profileId);
}

export function getModelsForProfile(profileId) {
  if (profileId === 'codex') return _codexModelsCache || mergeCodexModelOptions([]);
  if (profileId === 'opencode') return _opencodeModelsCache || [];
  if (profileId === 'claude-code') return _claudeModelsCache || [];
  return STATIC_MODELS[profileId] || [];
}

// Build the stored selector value for a model option. `cliReady` options (the live
// Claude Code list) already carry a spawn-ready id — including any `[1m]` suffix — so
// they encode as their bare id. Legacy Claude options carried only a base id plus a
// `contextWindow`, and encode as the composite "<id>:<contextWindow>" that the backend
// (toCliModelName) turns into the `[1m]` suffix. Models without a context window
// (codex/gemini/opencode) keep their bare id — unchanged behavior.
export function modelSelectorValue(m) {
  if (!m) return '';
  if (m.cliReady) return m.id || '';
  return m.contextWindow ? `${m.id}:${m.contextWindow}` : (m.id || '');
}

// Build the text shown for a model option without changing its stored selector value.
// OpenCode surfaces can opt into the service suffix because multiple providers often
// expose models with the same display name.
export function formatModelOptionLabel(m, { includeService = false } = {}) {
  const label = String(m?.label || m?.id || '').trim();
  if (!includeService) return label;
  const service = String(m?.desc || m?.provider || '').trim();
  return service && service !== label ? `${label} — ${service}` : label;
}

// Does stored selector `sel` correspond to model option `m`? Matches the composite form
// and, for back-compat, treats a legacy bare id (no window) as its 200K twin — so old
// schedules/loops saved as "claude-opus-4-8" light up the "(200K)" option rather than
// falling through to the unknown-value "(saved)" fallback.
export function modelMatchesSelector(m, sel) {
  if (!m || !sel) return false;
  if (sel === modelSelectorValue(m)) return true;
  if (m.cliReady) return false;
  return sel === m.id && (m.contextWindow || 200000) === 200000;
}

export function getEffortLevelsForProfile(profileId) {
  return EFFORT_LEVELS_BY_PROFILE[profileId] || [];
}

// Effort levels a specific model actually supports. The Claude Code CLI advertises
// these per model (`effortLevels`), and some models support none at all — Haiku has
// no thinking, so passing --effort to it is meaningless. Mirrors
// normalizeReasoningEfforts() in cdx/cdx-protocol.js for the Codex side.
export function getEffortLevelsForModel(profileId, model) {
  const profileLevels = getEffortLevelsForProfile(profileId);
  const advertised = model?.effortLevels;
  if (!Array.isArray(advertised)) return profileLevels;
  const off = profileLevels.find(e => e.id === 'off');
  if (!advertised.length) return off ? [off] : [];
  const byId = new Map(profileLevels.map(e => [e.id, e]));
  const levels = off ? [off] : [];
  for (const id of advertised) {
    levels.push(byId.get(id) || { id, label: id, desc: '' });
  }
  return levels;
}

// Does this model support any thinking at all? Used to disable the Think toggle.
export function modelSupportsEffort(model) {
  if (!model) return true;
  if (Array.isArray(model.effortLevels)) return model.effortLevels.length > 0;
  return model.supportsEffort !== false;
}

export function profileSupportsEffort(profileId) {
  return getEffortLevelsForProfile(profileId).some(e => e.id !== 'off');
}

export function normalizeEffortForProfile(profileId, effort) {
  const value = String(effort || '').trim();
  if (!value || value === 'off') return null;
  const levels = getEffortLevelsForProfile(profileId);
  return levels.some(e => e.id === value) ? value : null;
}

export async function fetchMcpProfilePresets(force = false) {
  if (!force && _mcpProfilePresets) return _mcpProfilePresets;
  try {
    const resp = await fetch('/api/mcp/profile');
    const data = await resp.json().catch(() => ({}));
    _mcpProfilePresets = data?.ok && data.presets ? data.presets : {};
    return _mcpProfilePresets;
  } catch {
    return {};
  }
}

export function getCachedMcpProfilePresets() {
  return _mcpProfilePresets || {};
}

export function clearRuntimeOptionCaches() {
  _codexModelsCache = null;
  _opencodeModelsCache = null;
  _claudeModelsCache = null;
  _mcpProfilePresets = null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('ocp-hidden-models-changed', () => { _opencodeModelsCache = null; });
  document.addEventListener('ocp-providers-changed', () => { _opencodeModelsCache = null; });
}
