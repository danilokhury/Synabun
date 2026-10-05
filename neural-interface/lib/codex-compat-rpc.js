import { classifyCodexRpcError } from './codex-capabilities.js';
import { isDeepStrictEqual } from 'node:util';
import { acceptAppResource, validateAppResources, appArgumentDisplay } from '../public/shared/cdx/cdx-mcp-app.js';

const routes = {
  mcp_app_resource_read: ['mcpServer/resource/read', 'mcp_app_resource', 'resource'],
  mcp_app_tool_call: ['mcpServer/tool/call', 'mcp_app_tool_result', 'result'],
  attachment_add: ['thread/attachment/add', 'attachment_added', 'result'],
  gateway_oauth_read: ['account/gatewayOAuth/read', 'gateway_oauth_state', 'gateway'],
  gateway_oauth_login: ['account/gatewayOAuth/login', 'gateway_oauth_started', 'gateway'],
  gateway_oauth_cancel: ['account/gatewayOAuth/cancel', 'gateway_oauth_canceled', 'gateway'],
  verification_status: ['userVerification/status', 'verification_status', 'verification'],
  verification_enroll: ['userVerification/enroll', 'verification_enrolled', 'verification'],
  verification_delete: ['userVerification/delete', 'verification_deleted', 'verification'],
  verification_verify: ['userVerification/verify', 'verification_verified', 'verification'],
  verification_cancel: ['userVerification/cancel', 'verification_canceled', 'verification'],
  attachment_list: ['thread/attachment/list', 'attachment_list', 'attachments'],
  attachment_remove: ['thread/attachment/remove', 'attachment_removed', 'result'],
  memory_status: ['memory/status', 'memory_status', 'memory'],
  background_list: ['thread/backgroundTerminals/list', 'background_list', 'terminals'],
  background_terminate: ['thread/backgroundTerminals/terminate', 'background_terminated', 'result'],
  background_clean: ['thread/backgroundTerminals/clean', 'background_cleaned', 'result'],
  goal_get: ['thread/goal/get', 'goal_data', 'goal'],
  goal_set: ['thread/goal/set', 'goal_updated', 'goal'],
  goal_clear: ['thread/goal/clear', 'goal_cleared', 'goal'],
  hooks_list: ['hooks/list', 'hooks_list', 'hooks'],
  skills_config_write: ['skills/config/write', 'skills_config_saved', 'result'],
  app_read: ['app/read', 'app_data', 'apps'],
  experimental_features_set: ['experimentalFeature/enablement/set', 'experimental_features_saved', 'result'],
  feedback_upload: ['feedback/upload', 'feedback_uploaded', 'result'],
  thread_settings_update: ['thread/settings/update', 'thread_settings_updated', 'settings'],
  collaboration_modes: ['collaborationMode/list', 'collaboration_modes', 'modes'],
};

const threadActions = new Set(['attachment_add', 'attachment_list', 'attachment_remove', 'background_list', 'background_terminate', 'background_clean', 'goal_get', 'goal_set', 'goal_clear', 'thread_settings_update']);
const mutations = new Set(['attachment_add', 'attachment_remove', 'background_terminate', 'background_clean', 'goal_set', 'goal_clear', 'skills_config_write', 'experimental_features_set', 'thread_settings_update']);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const appActions = new Set(['mcp_app_resource_read', 'mcp_app_tool_call']);
for (const action of appActions) threadActions.add(action);
mutations.add('mcp_app_tool_call');
function invalid(message) { const error = new Error(message); error.code = -32602; throw error; }
function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} is required.`);
  return value.trim();
}

const interactiveRequests = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request', 'item/permissions/requestApproval', 'item/tool/call']);

/** Unknown requests must settle even when the UI is disconnected. */
export function automaticCodexServerReply(method, params = {}, now = Date.now(), { userVerification = false } = {}) {
  if (method === 'currentTime/read') return { result: { currentTimeAt: Math.floor(now / 1000) } };
  if (method === 'mcpServer/elicitation/request' && params.mode === 'openai/userVerification' && userVerification) return null;
  if (method === 'mcpServer/elicitation/request' && params.mode && !['form', 'openai/form', 'openaiForm', 'url'].includes(params.mode)) {
    return { error: { code: -32601, message: `Unsupported MCP elicitation mode in SynaBun Codex panel: ${params.mode}` } };
  }
  if (interactiveRequests.has(method)) return null;
  return { error: { code: -32601, message: `Unsupported in SynaBun Codex panel: ${method}` } };
}

export function codexPagination(message = {}, defaultLimit = 100) {
  if (message.cursor != null && typeof message.cursor !== 'string') invalid('Invalid pagination cursor.');
  if (message.limit != null && (!Number.isInteger(message.limit) || message.limit < 1 || message.limit > 1000)) invalid('Page size must be an integer between 1 and 1000.');
  return { cursor: message.cursor || null, limit: message.limit ?? defaultLimit };
}

export function buildCodexReviewTarget(target = { type: 'uncommittedChanges' }) {
  if (target?.type === 'uncommittedChanges') return { type: target.type };
  if (target?.type === 'baseBranch') return { type: target.type, branch: required(target.branch, 'Base branch') };
  if (target?.type === 'commit') return { type: target.type, sha: required(target.sha, 'Commit'), ...(target.title ? { title: String(target.title) } : {}) };
  if (target?.type === 'custom') return { type: target.type, instructions: required(target.instructions, 'Review instructions') };
  invalid('Unsupported review target.');
}

export function validateCodexServerResponse(method, params, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) invalid('A structured response is required.');
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const advertised = params?.availableDecisions;
    const allowed = Array.isArray(advertised) ? advertised : ['accept', 'acceptForSession', 'decline', 'cancel'];
    if (!allowed.some(decision => isDeepStrictEqual(decision, result.decision))) invalid('This approval decision was not advertised by Codex.');
  } else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
    if (!result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) invalid('Question answers are required.');
    for (const question of params?.questions || []) {
      if (!Array.isArray(result.answers[question.id]?.answers)) invalid(`Missing answer for question ${question.id}.`);
    }
  } else if (method === 'mcpServer/elicitation/request') {
    if (!['accept', 'decline', 'cancel'].includes(result.action)) invalid('Invalid MCP elicitation response.');
  } else if (method === 'item/tool/call') {
    if (typeof result.success !== 'boolean' || !Array.isArray(result.contentItems)) invalid('Dynamic tool response requires success and contentItems.');
  } else if (method !== 'item/permissions/requestApproval') {
    invalid(`Unsupported request ${method}; reject it with a protocol error.`);
  }
  return result;
}

export async function listCodexPages(request, method, params = {}, key = 'data') {
  const data = [], cursors = new Set();
  let cursor = null, result = {};
  for (let page = 0; page < 100; page++) {
    result = await request(method, { ...params, cursor }, 10000);
    const items = result?.[key];
    if (!Array.isArray(items)) throw new Error(`Malformed ${method} response: missing ${key} list.`);
    data.push(...items);
    if (!result.nextCursor) return { ...result, [key]: data, nextCursor: null };
    if (cursors.has(result.nextCursor)) throw new Error(`${method} returned a repeated pagination cursor.`);
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`${method} exceeded the catalog pagination limit.`);
}

export function buildCodexCompatParams(message, { activeThreadId, cwd } = {}) {
  const threadId = owns(message, 'threadId') ? message.threadId : (activeThreadId || null);
  const params = threadActions.has(message.type) ? { threadId: required(threadId, 'Thread') } : {};
  switch (message.type) {
    case 'mcp_app_resource_read': case 'mcp_app_tool_call': {
      params.server = required(message.server, 'MCP server');
      const originCallId = required(message.originCallId, 'Origin call');
      if (message.type === 'mcp_app_resource_read') {
        const uri = required(message.uri, 'Resource URI');
        if (uri.length > 4096 || (message.appResource === true && !uri.startsWith('ui://'))) invalid('Invalid app resource URI.');
        return { ...params, uri, originCallId };
      }
      if (message.approved !== true) invalid('Explicit app tool approval is required.');
      if (message.arguments != null && (typeof message.arguments !== 'object' || Array.isArray(message.arguments))) invalid('Tool arguments must be an object.');
      let argumentsValue;
      try { argumentsValue = appArgumentDisplay(message.arguments ?? {}).arguments; }
      catch (error) { invalid(error.message); }
      return { ...params, tool: required(message.tool, 'MCP tool'), arguments: argumentsValue };
    }
    case 'attachment_add': {
      if (!owns(message, 'payload')) invalid('Attachment payload is required.');
      let encoded;
      try { encoded = JSON.stringify(message.payload); } catch { invalid('Attachment payload must be JSON.'); }
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 65536) invalid('Attachment payload must be JSON of at most 64 KiB.');
      return { ...params, attachmentType: required(message.attachmentType, 'Attachment type'), identityKey: required(message.identityKey, 'Attachment identity'), payload: message.payload };
    }
    case 'gateway_oauth_read': case 'gateway_oauth_login': case 'gateway_oauth_cancel': return null;
    case 'verification_status': case 'verification_enroll': case 'verification_delete': return {};
    case 'verification_verify': return { challenge: required(message.challenge, 'Challenge'), title: required(message.title, 'Title'), description: typeof message.description === 'string' ? message.description : '' };
    case 'verification_cancel':
      if (typeof message.verificationRequestId !== 'string' && !Number.isSafeInteger(message.verificationRequestId)) invalid('Verification request id is required.');
      return { requestId: message.verificationRequestId };
    case 'attachment_list': return { ...params, ...codexPagination(message) };
    case 'attachment_remove': return { ...params, attachmentType: required(message.attachmentType, 'Attachment type'), identityKey: required(message.identityKey, 'Attachment identity') };
    case 'memory_status': return {};
    case 'background_list': return { ...params, ...codexPagination(message) };
    case 'background_terminate': return { ...params, processId: required(message.processId, 'Process id') };
    case 'background_clean': case 'goal_get': case 'goal_clear': return params;
    case 'goal_set':
      if (owns(message, 'objective')) params.objective = required(message.objective, 'Objective');
      if (owns(message, 'status')) {
        if (!['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(message.status)) invalid('Invalid goal status.');
        params.status = message.status;
      }
      if (owns(message, 'tokenBudget')) {
        if (message.tokenBudget !== null && (!Number.isSafeInteger(message.tokenBudget) || message.tokenBudget <= 0)) invalid('Token budget must be a positive integer or null.');
        params.tokenBudget = message.tokenBudget;
      }
      if (Object.keys(params).length === 1) invalid('Set an objective, goal status, or token budget.');
      return params;
    case 'hooks_list': {
      const cwds = message.cwds || [message.cwd || cwd];
      if (!Array.isArray(cwds) || cwds.some(path => typeof path !== 'string' || !path)) invalid('Invalid hook working directories.');
      return { cwds };
    }
    case 'skills_config_write':
      if (typeof message.enabled !== 'boolean') invalid('Skill enabled must be a boolean.');
      if (!!message.path === !!message.name) invalid('Select a skill by either path or name.');
      return { enabled: message.enabled, ...(message.path ? { path: required(message.path, 'Skill path') } : { name: required(message.name, 'Skill name') }) };
    case 'app_read':
      if (!Array.isArray(message.appIds) || !message.appIds.length || message.appIds.length > 100) invalid('Select between 1 and 100 apps.');
      return { appIds: [...new Set(message.appIds.map(id => required(id, 'App id')))], includeTools: message.includeTools !== false, threadId };
    case 'experimental_features_set':
      if (!message.enablement || Array.isArray(message.enablement) || typeof message.enablement !== 'object' || Object.values(message.enablement).some(value => typeof value !== 'boolean')) invalid('Feature enablement must map feature names to booleans.');
      return { enablement: message.enablement };
    case 'feedback_upload':
      return {
        classification: required(message.classification, 'Feedback classification'),
        reason: typeof message.reason === 'string' ? message.reason : null,
        includeLogs: message.includeLogs === true,
        threadId,
        ...(message.tags && typeof message.tags === 'object' && !Array.isArray(message.tags)
          && Object.values(message.tags).every(value => typeof value === 'string') ? { tags: message.tags } : {}),
      };
    case 'thread_settings_update':
      if (owns(message, 'disabledPluginIds')) {
        if (!Array.isArray(message.disabledPluginIds) || message.disabledPluginIds.some(id => typeof id !== 'string' || !id.trim())) invalid('Disabled plugins must be a list of plugin ids.');
        params.disabledPluginIds = [...new Set(message.disabledPluginIds)];
      }
      for (const key of ['model', 'effort', 'summary', 'personality', 'serviceTier', 'approvalPolicy', 'approvalsReviewer']) {
        if (owns(message, key)) params[key] = message[key];
      }
      if (Object.keys(params).length === 1) invalid('No session settings were supplied.');
      return params;
    case 'collaboration_modes': return {};
    default: invalid('Unknown compatibility action.');
  }
}

/** Small RPC boundary; writer lifecycle and request journal remain owned by the transport. */
export async function handleCodexCompatMessage(message, context) {
  const route = routes[message.type];
  const pluginAction = /^plugin_(list|read|install|uninstall)$/.test(message.type || '');
  if (!route && !pluginAction && message.type !== 'capabilities_read') return false;
  try {
    if (appActions.has(message.type)) context.limitAppCall?.(message);
    await context.ensureInitialized();
    if (message.type === 'capabilities_read') {
      context.send({ type: 'capabilities', requestId: message.requestId || null, ...context.capabilities() });
      return true;
    }
    context.registry.assertAvailable(message.type);
    const params = buildCodexCompatParams(message, context);
    if (threadActions.has(message.type) && !context.activeThreadId) invalid('Start or resume this Codex thread before using this action.');
    if (threadActions.has(message.type) && params.threadId !== context.activeThreadId) invalid('This action belongs to another thread.');
    if (appActions.has(message.type)) {
      if (context.role === 'assistant') invalid('Embedded apps are unavailable to the Assistant brain.');
      const card = await context.resolveAppCard?.(message.originCallId, params.threadId);
      if (!card || card.server !== params.server) invalid('MCP server does not belong to this app card.');
      if (context.getActiveThreadId && params.threadId !== context.getActiveThreadId()) invalid('This app belongs to another thread.');
      if (message.type === 'mcp_app_resource_read' && message.appResource === true && params.uri !== card.uri) invalid('Resource does not belong to this app card.');
      params.server = card.server;
    }
    if (message.type === 'thread_settings_update' && context.activeTurnId) invalid('Wait for the current turn before changing session settings.');
    await context.beforeRequest?.(message.type, params);
    const run = () => context.request(route[0], params, /^verification_(enroll|delete|verify)$/.test(message.type) ? 120000 : message.type === 'feedback_upload' ? 30000 : 10000);
    const result = mutations.has(message.type) ? await context.withWriterOperation(message.type, run) : await run();
    if (message.type === 'mcp_app_resource_read') {
      validateAppResources(result);
      if (message.appResource === true) acceptAppResource(result, params.uri);
    }
    await context.afterRequest?.(message.type, params, result);
    context.send({ type: route[1], requestId: message.requestId || null, [route[2]]: result || {},
      ...(params?.threadId ? { threadId: params.threadId } : {}),
      ...(message.type === 'thread_settings_update' ? { overrides: params } : {}),
    });
  } catch (error) {
    context.send({ type: 'error', requestId: message.requestId || null, ...classifyCodexRpcError(error) });
  }
  return true;
}
