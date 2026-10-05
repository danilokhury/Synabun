// Shared command metadata for dispatch, composer hints and feature menus.
const definitions = [
  ['agent', 'Open loaded agent threads', 'thread_loaded_list'],
  ['apps', 'Search apps and inspect available tools', 'app_list'],
  ['attachments', 'Inspect thread attachments', 'attachment_list'],
  ['archive', 'Archive the current thread', 'thread_archive'],
  ['clean', 'Stop all background terminals', 'background_clean'],
  ['clear', 'Start a fresh conversation'],
  ['compact', 'Compact thread context'],
  ['copy', 'Copy the latest completed response'],
  ['debug-config', 'Show effective config and restrictions', 'config_read'],
  ['diff', 'Show the Git diff'],
  ['effort', 'Choose reasoning effort', null, true],
  ['experimental', 'Inspect experimental features', 'experimental_features'],
  ['fast', 'Toggle Fast mode for supported models', 'config_read'],
  ['feedback', 'Preview and send feedback', 'feedback_upload'],
  ['fork', 'Fork the current thread', 'thread_fork'],
  ['goal', 'Inspect or update the thread goal', 'goal_get'],
  ['help', 'Show all sidepanel commands'],
  ['hooks', 'Inspect configured hooks', 'hooks_list'],
  ['init', 'Create or update AGENTS.md guidance', null, true],
  ['logout', 'Sign out of Codex', 'account_logout'],
  ['mcp', 'Search MCP servers and tools', 'mcp_status'],
  ['mention', 'Add a structured file mention', null, true],
  ['model', 'Choose model'],
  ['new', 'Start a fresh conversation'],
  ['permissions', 'Update approvals and sandboxing', 'config_read'],
  ['personality', 'Set the active personality', 'config_read', true],
  ['plan', 'Enable Plan mode or send a planning prompt', null, true],
  ['plugins', 'Inspect plugin availability', 'plugin_list'],
  ['ps', 'Inspect native background terminals', 'background_list'],
  ['queue', 'Show queued messages'],
  ['rename', 'Rename the current thread', 'thread_rename', true],
  ['resume', 'Search and resume conversations'],
  ['review', 'Choose working tree, branch, commit or custom review', 'review_start'],
  ['settings', 'Open Codex settings'],
  ['skills', 'Search native skills and manage enablement', 'skills_list'],
  ['status', 'Show account, runtime and session status', 'status_snapshot'],
  ['stop', 'Stop one or all background terminals', 'background_clean', true],
  ['unarchive', 'Restore an archived thread by ID', 'thread_unarchive', true],
];

export const CODEX_COMMANDS = Object.freeze(definitions.map(([name, desc, capability, acceptsArgs = false]) => (
  Object.freeze({ name, cmd: `/${name}`, desc, capability: capability || null, acceptsArgs })
)));
export const CODEX_COMMAND_BY_NAME = new Map(CODEX_COMMANDS.map((entry) => [entry.name, entry]));

const LEGACY_ACTIONS = new Set([
  'thread_list', 'thread_resume', 'thread_start', 'thread_rename', 'thread_fork',
  'thread_archive', 'thread_unarchive', 'thread_loaded_list', 'review_start',
  'account_read', 'account_logout', 'codex_login', 'rate_limits_read', 'status_snapshot',
  'config_read', 'config_write', 'config_requirements', 'model_list',
  'mcp_status', 'mcp_refresh', 'mcp_oauth_login', 'mcp_approval_set',
  'permission_roots_list', 'permission_root_remove', 'skills_list', 'app_list',
  'experimental_features', 'background_clean',
]);

export function parseCodexCommand(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), args: String(match[2] || '').trim(), raw } : null;
}

export function capabilityAvailability(capabilities, name) {
  if (!name) return { supported: true, experimental: false, reason: '' };
  const value = capabilities?.[name];
  // Only pre-existing bridge actions remain usable without runtime metadata.
  // New methods must be explicitly advertised before the UI offers them.
  if (value) return { ...value, supported: value.supported === true };
  return LEGACY_ACTIONS.has(name)
    ? { supported: true, experimental: false, reason: '' }
    : { supported: false, experimental: false, reason: name.startsWith('plugin_') ? 'Plugin controls are under development and unavailable in this client.' : 'This runtime has not advertised support for this feature.' };
}

export function codexCommandHints(capabilities = {}) {
  return CODEX_COMMANDS.map((entry) => {
    const state = capabilityAvailability(capabilities, entry.capability);
    return { ...entry, available: state.supported, desc: `${entry.desc}${state.experimental ? ' · Experimental' : ''}${state.supported ? '' : ` · Unavailable: ${state.reason || 'unsupported by this runtime'}`}` };
  });
}

export function latestCompletedCodexText(items) {
  const states = Array.from(items?.values?.() || items || []);
  for (let i = states.length - 1; i >= 0; i -= 1) {
    const state = states[i];
    if (!state || !['agentMessage', 'plan'].includes(state.type)) continue;
    if (!(state.completed === true || ['completed', 'complete'].includes(state.status))) continue;
    const text = String(state.buffer ?? state.text ?? '').trim();
    if (text) return text;
  }
  return '';
}

export function reviewTarget(type, value = '') {
  const text = String(value).trim();
  if (type === 'uncommittedChanges') return { type };
  if (!text) throw new Error('Enter a branch, commit or review instructions.');
  if (type === 'baseBranch') return { type, branch: text };
  if (type === 'commit') return { type, sha: text };
  if (type === 'custom') return { type, instructions: text };
  throw new Error('Unknown review target.');
}

export function configValue(config, key) {
  if (Object.hasOwn(config || {}, key)) return config[key];
  return key.split('.').reduce((value, part) => value?.[part], config);
}

export function configRestriction(requirements, key) {
  const req = requirements?.requirements?.requirements || requirements?.requirements || requirements || {};
  const fields = { approval_policy: 'allowedApprovalPolicies', sandbox_mode: 'allowedSandboxModes', web_search: 'allowedWebSearchModes' };
  if (fields[key] && Array.isArray(req[fields[key]])) return { allowed: req[fields[key]], reason: 'Managed configuration restriction' };
  if (key.startsWith('features.') && Object.hasOwn(req.featureRequirements || {}, key.slice(9))) {
    return { fixed: req.featureRequirements[key.slice(9)], reason: 'Required by managed configuration' };
  }
  return {};
}

export function serializeConfigInput(def, input) {
  if (input.dataset?.originalValue) {
    const original = JSON.parse(input.dataset.originalValue);
    if (input.value === (typeof original === 'object' ? JSON.stringify(original) : String(original))) return original;
  }
  if (def.type === 'checkbox') return input.checked;
  if (def.type === 'number') {
    if (!input.value) return null;
    const number = Number(input.value);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${def.label} must be a positive whole number.`);
    return number;
  }
  return input.value || null;
}

export function configChanges(definitions, inputs, original) {
  const changed = {};
  for (const def of definitions) {
    const input = inputs[def.key];
    if (!input || input.disabled) continue;
    const value = serializeConfigInput(def, input);
    const before = configValue(original, def.key);
    if (JSON.stringify(value) !== JSON.stringify(before ?? (def.type === 'checkbox' ? false : null))) changed[def.key] = value;
  }
  return changed;
}

export const SESSION_CONFIG_FIELDS = Object.freeze({
  model: 'model', model_reasoning_effort: 'effort', model_reasoning_summary: 'summary',
  personality: 'personality', service_tier: 'serviceTier', approval_policy: 'approvalPolicy',
});

export function sessionSettings(config) {
  return Object.fromEntries(Object.entries(config).filter(([key]) => SESSION_CONFIG_FIELDS[key]).map(([key, value]) => [SESSION_CONFIG_FIELDS[key], value]));
}

export function modelServiceTiers(model) {
  const tiers = Array.isArray(model?.serviceTiers) && model.serviceTiers.length
    ? model.serviceTiers
    : (model?.additionalSpeedTiers || []).map((id) => ({ id, name: id }));
  return tiers.filter((tier) => tier?.id).map((tier) => ({ value: tier.id, label: tier.name || tier.id }));
}

export function fastServiceTier(model) {
  return modelServiceTiers(model).find((tier) => /^(fast|priority)$/i.test(tier.value) || /^fast(?:\s|$)/i.test(tier.label))?.value || null;
}

export function flattenNativeCatalog(result, kind) {
  const value = result?.[kind] ?? result ?? {};
  const entries = Array.isArray(value) ? value : (value.data || value[kind] || []);
  if (kind === 'skills' || kind === 'hooks') return entries.flatMap((entry) => entry[kind] || (entry.name || entry.key ? [entry] : []));
  return entries;
}
