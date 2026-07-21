// Shared launch/runtime metadata for Automation Studio, Schedules Studio,
// and agent sidepanels.

export const CLI_PROFILES = [
  { id: 'claude-code', label: 'Claude Code', desc: 'Anthropic' },
  { id: 'codex', label: 'Codex CLI', desc: 'OpenAI' },
  { id: 'gemini', label: 'Gemini CLI', desc: 'Google' },
  { id: 'opencode', label: 'OpenCode CLI', desc: 'Multi-provider' },
];

const STATIC_MODELS = {
  // Each 1M-capable model appears as a 1M variant (default) + a 200K twin so the long
  // context window is selectable where available. The option value carries the window
  // (see modelSelectorValue) and the backend appends the Claude Code `[1m]` beta suffix
  // via toCliModelName(). Effort ("Think") is a separate selector in these UIs, so labels
  // stay clean (no "xhigh"). Keep `id` canonical — it is rendered raw in schedule/timer
  // chips. Haiku 4.5 is 200K-only (no 1M). Keep in sync with /api/claude/config in server.js.
  'claude-code': [
    { id: 'claude-fable-5', label: 'Fable 5', desc: 'Most capable', tier: 'top', contextWindow: 1000000 },
    { id: 'claude-fable-5', label: 'Fable 5 (200K)', desc: 'Most capable', contextWindow: 200000 },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', desc: 'Most capable', contextWindow: 1000000 },
    { id: 'claude-opus-4-8', label: 'Opus 4.8 (200K)', desc: 'Most capable', contextWindow: 200000 },
    { id: 'claude-opus-4-7', label: 'Opus 4.7', desc: 'Highly autonomous', contextWindow: 1000000 },
    { id: 'claude-opus-4-7', label: 'Opus 4.7 (200K)', desc: 'Highly autonomous', contextWindow: 200000 },
    { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Deep reasoning', contextWindow: 1000000 },
    { id: 'claude-opus-4-6', label: 'Opus 4.6 (200K)', desc: 'Deep reasoning', contextWindow: 200000 },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', desc: 'Balanced', tier: 'default', contextWindow: 1000000 },
    { id: 'claude-sonnet-5', label: 'Sonnet 5 (200K)', desc: 'Balanced', contextWindow: 200000 },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Fastest', contextWindow: 200000 },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: '2.5 Pro', desc: 'Most capable', tier: 'default' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash', desc: 'Lightweight' },
  ],
};

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
    contextWindow: Number(codexModelValue(model, ['contextWindow', 'context_window'])) || null,
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

export async function ensureModelsForProfile(profileId, force = false) {
  if (profileId === 'codex') return fetchCodexModels(force);
  if (profileId === 'opencode') return fetchOpencodeModels(force);
  return getModelsForProfile(profileId);
}

export function getModelsForProfile(profileId) {
  if (profileId === 'codex') return _codexModelsCache || mergeCodexModelOptions([]);
  if (profileId === 'opencode') return _opencodeModelsCache || [];
  return STATIC_MODELS[profileId] || [];
}

// Build the stored selector value for a model option. Claude models carry a
// `contextWindow`, so they encode as the composite "<id>:<contextWindow>" the backend
// (toCliModelName) turns into the `[1m]` CLI suffix for 1M variants. Models without a
// context window (codex/gemini/opencode) keep their bare id — unchanged behavior.
export function modelSelectorValue(m) {
  if (!m) return '';
  return m.contextWindow ? `${m.id}:${m.contextWindow}` : (m.id || '');
}

// Does stored selector `sel` correspond to model option `m`? Matches the composite form
// and, for back-compat, treats a legacy bare id (no window) as its 200K twin — so old
// schedules/loops saved as "claude-opus-4-8" light up the "(200K)" option rather than
// falling through to the unknown-value "(saved)" fallback.
export function modelMatchesSelector(m, sel) {
  if (!m || !sel) return false;
  if (sel === modelSelectorValue(m)) return true;
  return sel === m.id && (m.contextWindow || 200000) === 200000;
}

export function getEffortLevelsForProfile(profileId) {
  return EFFORT_LEVELS_BY_PROFILE[profileId] || [];
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
  _mcpProfilePresets = null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('ocp-hidden-models-changed', () => { _opencodeModelsCache = null; });
  document.addEventListener('ocp-providers-changed', () => { _opencodeModelsCache = null; });
}
