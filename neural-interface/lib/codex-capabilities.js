/** Tested local app-server contract. No RPC is used as a method-discovery probe. */
export const CODEX_PROTOCOL_BASELINE = '0.160.0';

const pluginReason = 'Plugin controls are under development and unavailable in this sidepanel.';
const method = (rpc, experimental = false) => ({ method: rpc, experimental });
export const CODEX_CAPABILITY_METHODS = Object.freeze({
  thread_list: method('thread/list'), thread_resume: method('thread/resume'),
  thread_start: method('thread/start'), thread_rename: method('thread/name/set'),
  thread_fork: method('thread/fork'), thread_archive: method('thread/archive'),
  thread_unarchive: method('thread/unarchive'), thread_loaded_list: method('thread/loaded/list'),
  thread_revert: method('thread/revert'),
  thread_read: method('thread/read'), thread_turns_list: method('thread/turns/list'),
  thread_items_list: method('thread/items/list'), compact: method('thread/compact/start'),
  query: method('turn/start'), turn_steer: method('turn/steer'), interrupt: method('turn/interrupt'),
  review_start: method('review/start'), model_list: method('model/list'),
  collaboration_modes: method('collaborationMode/list', true),
  account_read: method('account/read'), rate_limits_read: method('account/rateLimits/read'),
  config_read: method('config/read'), config_write: method('config/batchWrite'),
  config_requirements: method('configRequirements/read'),
  mcp_status: method('mcpServerStatus/list'), mcp_refresh: method('config/mcpServer/reload'),
  mcp_app_resource_read: method('mcpServer/resource/read'), mcp_app_tool_call: method('mcpServer/tool/call'),
  mcp_oauth_login: method('mcpServer/oauth/login'), mcp_approval_set: method('config/batchWrite'),
  skills_list: method('skills/list'), skills_config_write: method('skills/config/write'),
  app_list: method('app/list'), app_read: method('app/read'),
  experimental_features: method('experimentalFeature/list'),
  experimental_features_set: method('experimentalFeature/enablement/set'),
  background_clean: method('thread/backgroundTerminals/clean', true),
  background_list: method('thread/backgroundTerminals/list', true),
  background_terminate: method('thread/backgroundTerminals/terminate', true),
  goal_get: method('thread/goal/get'), goal_set: method('thread/goal/set'),
  goal_clear: method('thread/goal/clear'), hooks_list: method('hooks/list'),
  thread_settings_update: method('thread/settings/update', true),
  attachment_list: method('thread/attachment/list'), attachment_remove: method('thread/attachment/remove'),
  attachment_add: method('thread/attachment/add'),
  memory_status: method('memory/status', true),
  rollout_compress: { ...method('rollout/compress', true), unavailable: 'Global rollout storage compression has no sidepanel control.' },
  gateway_oauth_read: method('account/gatewayOAuth/read'),
  gateway_oauth_login: method('account/gatewayOAuth/login'),
  gateway_oauth_cancel: method('account/gatewayOAuth/cancel'),
  verification_status: method('userVerification/status', true),
  verification_enroll: method('userVerification/enroll', true),
  verification_delete: method('userVerification/delete', true),
  verification_verify: method('userVerification/verify', true),
  verification_cancel: method('userVerification/cancel', true),
  feedback_upload: method('feedback/upload'),
  plugin_list: { ...method('plugin/list'), unavailable: pluginReason },
  plugin_read: { ...method('plugin/read'), unavailable: pluginReason },
  plugin_install: { ...method('plugin/install'), unavailable: pluginReason },
  plugin_uninstall: { ...method('plugin/uninstall'), unavailable: pluginReason },
});

export function parseCodexVersion(value) {
  return String(value || '').match(/\b(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?\b/)?.[1] || null;
}

export function isCodexUnsupportedMethod(error) {
  return error?.code === -32601
    || (error?.code === -32600 && /unknown variant/i.test(String(error?.message || '')));
}

export function classifyCodexRpcError(error, methodName = '') {
  let message = String(error?.message || error || 'Codex request failed');
  const code = error?.code ?? null;
  const category = isCodexUnsupportedMethod(error) ? 'unsupported'
    : code === -32602 ? 'invalid_request'
    : /unauthenticated|not logged in|authentication required|unauthorized|401\b/i.test(message) ? 'authentication'
    : /managed|restricted|requirements|not allowed|forbidden|permission denied|403\b/i.test(message) ? 'restricted'
    : /timed out|timeout|rate.limit|temporar|connection|disconnected|exited|503\b|429\b/i.test(message) ? 'transient'
    : 'runtime';
  const unsupportedMethod = methodName || message.match(/unknown variant\s+[`'"]([^`'"]+)[`'"]/i)?.[1];
  if (category === 'unsupported' && unsupportedMethod) message = `The installed Codex CLI does not support ${unsupportedMethod}`;
  return { code, category, message };
}

/** @typedef {{supported:boolean,experimental:boolean,method:string,reason:string|null}} CodexCapability */
export class CodexCapabilityRegistry {
  constructor(runtime = {}) { this.reset(runtime); }
  reset(runtime = {}) {
    this.runtime = { ...runtime, protocolBaseline: CODEX_PROTOCOL_BASELINE, experimentalApi: true };
    this.observed = new Map();
    this.requirements = null;
  }
  updateRequirements(result) { this.requirements = result?.requirements || result || null; }
  observe(methodName, error = null) {
    // Authentication/transport/configuration failures say nothing about method support.
    if (error && classifyCodexRpcError(error).category !== 'unsupported') return false;
    const next = error ? { supported: false, reason: classifyCodexRpcError(error, methodName).message }
      : { supported: true, reason: null };
    const prior = this.observed.get(methodName);
    this.observed.set(methodName, next);
    return prior?.supported !== next.supported;
  }
  snapshot() {
    return Object.fromEntries(Object.entries(CODEX_CAPABILITY_METHODS).map(([name, descriptor]) => {
      const observed = this.observed.get(descriptor.method);
      let reason = descriptor.unavailable || observed?.reason || null;
      let supported = !reason;
      const appVersion = parseCodexVersion(this.runtime.cliVersion || this.runtime.version);
      if (name.startsWith('mcp_app_') && appVersion
        && appVersion.split('.').map(Number).some((value, index, parts) =>
          parts.slice(0, index).every((prior, i) => prior === [0, 160, 0][i]) && value < [0, 160, 0][index])) {
        reason = 'Embedded MCP apps require Codex CLI 0.160.0 or newer.'; supported = false;
      }
      if (name === 'feedback_upload' && this.requirements?.feedback?.enabled === false) {
        supported = false;
        reason = 'Feedback is disabled by managed requirements.';
      }
      return [name, { supported, experimental: descriptor.experimental, method: descriptor.method, reason }];
    }));
  }
  assertAvailable(name) {
    const capability = this.snapshot()[name];
    if (!capability?.supported) {
      const error = new Error(capability?.reason || `Unknown Codex action: ${name}`);
      error.code = -32601;
      throw error;
    }
  }
}

export function validateCodexConfigRequirements(config, result) {
  const requirements = result?.requirements || result || {};
  const allowLists = {
    approval_policy: 'allowedApprovalPolicies', approvals_reviewer: 'allowedApprovalsReviewers',
    sandbox_mode: 'allowedSandboxModes', web_search: 'allowedWebSearchModes',
  };
  for (const [key, requirement] of Object.entries(allowLists)) {
    if (config[key] == null || !Array.isArray(requirements[requirement])) continue;
    if (!requirements[requirement].some(value => JSON.stringify(value) === JSON.stringify(config[key]))) {
      const error = new Error(`${key} is restricted by managed requirements.`);
      error.code = 'MANAGED_REQUIREMENT';
      throw error;
    }
  }
  if (config.web_search != null && !['disabled', 'cached', 'indexed', 'live'].includes(config.web_search)) {
    const error = new Error('web_search must be disabled, cached, indexed, or live.');
    error.code = -32602;
    throw error;
  }
  for (const [name, required] of Object.entries(requirements.featureRequirements || {})) {
    if (config.features?.[name] !== undefined && config.features[name] !== required) {
      const error = new Error(`Feature ${name} is restricted by managed requirements.`);
      error.code = 'MANAGED_REQUIREMENT';
      throw error;
    }
  }
  return config;
}
