// Model ids and context choices are separate in automation settings. Decode the
// older selector formats at the boundary so they never reach a provider.
const CLAUDE_ONE_M = /\[1m\]$/i;
const CODEX_EXTENDED = /\[extended\]$/i;
const NUMERIC_SUFFIX = /^(.+):(\d+)$/;

export function normalizeAutomationSelection(profile, model, contextMode = null) {
  let id = String(model || '').trim();
  let mode = contextMode == null || contextMode === '' ? null : String(contextMode);
  const isCodex = profile === 'codex' || (!profile && /^(?:gpt-|codex-|chat-latest)/i.test(id));
  const isClaude = profile === 'claude-code' || (!profile && /^(?:claude-|opus|sonnet|haiku|default(?:\[1m\])?$)/i.test(id));
  if (isCodex && CODEX_EXTENDED.test(id)) {
    id = id.replace(CODEX_EXTENDED, '');
    mode ??= 'extended';
  } else if (isClaude && CLAUDE_ONE_M.test(id)) {
    id = id.replace(CLAUDE_ONE_M, '');
    mode ??= '1m';
  } else if ((isCodex || isClaude) && NUMERIC_SUFFIX.test(id)) {
    const [, base, size] = id.match(NUMERIC_SUFFIX);
    id = base;
    mode ??= isClaude && Number(size) > 200000 ? '1m' : 'default';
  }
  return { model: id || null, contextMode: mode };
}

export function validAutomationContextMode(profile, mode) {
  if (mode == null || mode === '') return true;
  if (mode === 'default') return true;
  return profile === 'codex' ? mode === 'extended'
    : profile === 'claude-code' ? mode === '1m' : false;
}

export function resolveAutomationOverrides(schedule = {}, group = {}, template = {}) {
  return {
    profile: schedule.profile || group?.profile || template?.profile || 'claude-code',
    model: schedule.model || group?.model || template?.model || null,
    contextMode: schedule.contextMode || group?.contextMode || template?.contextMode || null,
    codexAccountId: schedule.codexAccountId || group?.codexAccountId || template?.codexAccountId || 'default',
  };
}

export function contextSizeLabel(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1000000 ? `${Number((n / 1000000).toFixed(2))}M` : `${Math.round(n / 1000)}K`;
}

export function automationModelOptions(profile, models = []) {
  if (profile !== 'claude-code') return models;
  return models.filter((model) => !CLAUDE_ONE_M.test(String(model?.id || '')));
}

// Mirrors the Assistant catalog's Claude eligibility rule. The installed CLI
// often omits [1m] rows even though it accepts the suffix for these families.
export function claudeAutomationSupportsOneMillion(model) {
  if (!model || model.id === 'default' || model.catalogSource === 'fallback') return false;
  const id = String(model.resolvedModel || model.id || '').toLowerCase();
  if (!/(opus|sonnet|fable)/.test(id)) return false;
  return !/(haiku|claude-3|opus-4-[0-5](?:-|$)|opus-4-\d{8}|opus-4$)/.test(id);
}

export function automationContextOptions(profile, modelId, models = []) {
  const id = normalizeAutomationSelection(profile, modelId).model;
  const model = models.find((entry) => entry?.id === id);
  const baseSize = contextSizeLabel(model?.contextWindow);
  const options = [{ id: 'default', label: baseSize ? `Default (${baseSize})` : 'Provider default' }];
  if (profile === 'codex' && model?.supportsExtendedContext === true
    && Number(model.maxContextWindow) > Number(model.contextWindow)) {
    options.push({ id: 'extended', label: `Extended (${contextSizeLabel(model.maxContextWindow)})` });
  } else if (profile === 'claude-code'
    && (models.some((entry) => entry?.id === `${id}[1m]`) || claudeAutomationSupportsOneMillion(model))) {
    options.push({ id: '1m', label: '1M' });
  }
  return options;
}
