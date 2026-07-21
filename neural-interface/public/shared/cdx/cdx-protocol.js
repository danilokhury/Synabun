// SynaBun Codex panel protocol normalization and ownership guards.

export const CODEX_PERMISSION_APPROVAL_METHOD = 'item/permissions/requestApproval';
export const CODEX_MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request';
export const SYNABUN_CHOICE_MARKER = '[SYNABUN_CHOICE_V1]';
export const SYNABUN_OTHER_VALUE = '__synabun_other__';
export const CODEX_THREAD_SNAPSHOT_VERSION = 3;

const THREAD_SCOPED_NOTIFICATION_PREFIXES = ['item/', 'turn/', 'thread/'];

export function buildCodexPlanRevisionPrompt(plan, feedback) {
  const currentPlan = String(plan || '').trim();
  const requestedChanges = String(feedback || '').trim();
  if (!requestedChanges) return '';

  const planSection = currentPlan
    ? `Current plan:\n\n${currentPlan}\n\n`
    : '';
  return [
    'Revise the current plan using the requested changes below.',
    '',
    planSection + `Requested changes:\n\n${requestedChanges}`,
    '',
    'Return the complete replacement plan for review. Stay in plan mode and do not implement anything yet.',
  ].join('\n');
}

function codexMessageThreadId(msg) {
  return msg?.threadId
    || msg?.params?.threadId
    || msg?.params?.thread?.id
    || msg?.params?.turn?.threadId
    || msg?.params?.item?.threadId
    || msg?.thread?.id
    || null;
}

function codexMessageTurnId(msg) {
  return msg?.turnId
    || msg?.params?.turnId
    || msg?.params?.turn?.id
    || msg?.params?.item?.turnId
    || msg?.turn?.id
    || null;
}

function isThreadScopedNotification(method) {
  const value = String(method || '');
  return THREAD_SCOPED_NOTIFICATION_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function codexThreadSnapshotBelongsToThread(snapshot, threadId, accountId = null) {
  const expectedThreadId = String(threadId || '');
  if (!snapshot || typeof snapshot !== 'object' || !expectedThreadId) return false;
  if (Number(snapshot.version) !== CODEX_THREAD_SNAPSHOT_VERSION) return false;
  if (String(snapshot.threadId || '') !== expectedThreadId) return false;
  if (!snapshot.accountId) return false;
  return accountId == null || String(snapshot.accountId) === String(accountId || 'default');
}

export function codexThreadSnapshotHasOwnershipManifest(snapshot, threadId, accountId = null) {
  return codexThreadSnapshotBelongsToThread(snapshot, threadId, accountId)
    && Array.isArray(snapshot.acceptedItemIds)
    && Array.isArray(snapshot.acceptedTurnIds)
    && !!snapshot.provenance
    && typeof snapshot.provenance === 'object'
    && !!snapshot.provenance.sessionId;
}

export function codexTranscriptNodesHaveOwnership(nodes, {
  threadId,
  accountId = 'default',
  acceptedItemIds = null,
  acceptedTurnIds = null,
} = {}) {
  const expectedThreadId = String(threadId || '');
  const expectedAccountId = String(accountId || 'default');
  if (!expectedThreadId || !Array.isArray(nodes)) return false;
  const acceptedItems = acceptedItemIds == null ? null : new Set([...acceptedItemIds].map(String));
  const acceptedTurns = acceptedTurnIds == null ? null : new Set([...acceptedTurnIds].map(String));
  return nodes.every((node) => {
    const dataset = node?.dataset || {};
    if (String(dataset.codexThreadId || '') !== expectedThreadId) return false;
    if (String(dataset.codexAccountId || '') !== expectedAccountId) return false;
    if (dataset.itemId && acceptedItems && !acceptedItems.has(String(dataset.itemId))) return false;
    if (dataset.codexTurnId && acceptedTurns && !acceptedTurns.has(String(dataset.codexTurnId))) return false;
    return true;
  });
}

export function normalizeSynaBunChoiceElicitation(params = {}) {
  const message = String(params?.message || '');
  if (!message.startsWith(SYNABUN_CHOICE_MARKER)) return null;

  let metadata;
  try {
    metadata = JSON.parse(message.slice(SYNABUN_CHOICE_MARKER.length));
  } catch {
    return null;
  }

  const schema = params?.requestedSchema || {};
  const properties = schema.properties || {};
  const questions = (Array.isArray(metadata?.questions) ? metadata.questions : [])
    .slice(0, 3)
    .map((question, index) => {
      const id = String(question?.id || `question_${index + 1}`);
      if (!properties[id]) return null;
      const options = (Array.isArray(question?.options) ? question.options : [])
        .slice(0, 4)
        .map((option) => ({
          label: String(option?.label || ''),
          description: String(option?.description || ''),
          value: String(option?.label || ''),
        }))
        .filter((option) => option.label);
      if (options.length < 2) return null;
      return {
        id,
        header: String(question?.header || id),
        question: String(question?.question || ''),
        options,
        _synabunMcp: {
          otherField: `${id}__other`,
          otherValue: SYNABUN_OTHER_VALUE,
        },
      };
    })
    .filter(Boolean);

  return questions.length ? { questions } : null;
}

export function buildSynaBunChoiceContent(questions = [], answers = {}) {
  const content = {};
  for (const question of questions) {
    const id = question?.id;
    const answer = id ? answers[id]?.answers?.[0] : '';
    if (!id || !answer) continue;
    const option = (question.options || []).find((candidate) => candidate.label === answer);
    if (option) {
      content[id] = option.value || option.label;
      continue;
    }
    const meta = question._synabunMcp || {};
    content[id] = meta.otherValue || SYNABUN_OTHER_VALUE;
    content[meta.otherField || `${id}__other`] = answer;
  }
  return content;
}

export function isCodexPermissionApproval(method) {
  return method === CODEX_PERMISSION_APPROVAL_METHOD;
}

export function codexMcpElicitationMeta(params = {}) {
  const metadata = params?._meta ?? params?.meta;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
}

export function isCodexMcpToolApproval(params = {}) {
  return codexMcpElicitationMeta(params).codex_approval_kind === 'mcp_tool_call';
}

export function normalizeCodexMcpApprovalPersistence(params = {}) {
  const advertised = codexMcpElicitationMeta(params).persist;
  const values = Array.isArray(advertised) ? advertised : [advertised];
  return [...new Set(values.filter((value) => value === 'session' || value === 'always'))];
}

export function codexMcpToolApprovalActions(params = {}) {
  const persistence = new Set(normalizeCodexMcpApprovalPersistence(params));
  const actions = [];
  if (persistence.has('always')) {
    actions.push({
      id: 'always',
      label: 'Always Allow This MCP Server',
      result: { action: 'accept', content: {}, _meta: { persist: 'always' } },
      persist: { kind: 'mcp-server', approvalMode: 'approve' },
      resultLabel: 'always allowed',
    });
  }
  if (persistence.has('session')) {
    actions.push({
      id: 'session',
      label: 'Allow for This Session',
      result: { action: 'accept', content: {}, _meta: { persist: 'session' } },
      resultLabel: 'allowed for session',
    });
  }
  actions.push(
    {
      id: 'once',
      label: 'Allow Once',
      result: { action: 'accept', content: {}, _meta: {} },
      resultLabel: 'allowed',
    },
    {
      id: 'decline',
      label: 'Decline',
      result: { action: 'decline', content: null, _meta: {} },
      style: 'secondary',
      resultLabel: 'declined',
    },
    {
      id: 'cancel',
      label: 'Cancel',
      result: { action: 'cancel', content: null, _meta: {} },
      style: 'danger',
      resultLabel: 'cancelled',
    },
  );
  return actions;
}

export function codexPermissionApprovalActions(params = {}) {
  const permissions = params?.permissions && typeof params.permissions === 'object'
    ? params.permissions
    : {};
  const filesystem = permissions.fileSystem || permissions.filesystem || {};
  const hasFilesystemPaths = ['read', 'write'].some((access) => (
    Array.isArray(filesystem[access]) && filesystem[access].some((value) => typeof value === 'string' && value.trim())
  ));
  return [
    {
      id: 'always',
      label: 'Always Allow',
      result: { permissions, scope: 'session' },
      ...(hasFilesystemPaths ? { persist: 'always', resultLabel: 'always allowed' } : {
        resultLabel: 'allowed for session (maximum supported)',
      }),
    },
    {
      id: 'session',
      label: 'Allow for this session',
      result: { permissions, scope: 'session' },
      resultLabel: 'allowed for session',
    },
    {
      id: 'decline',
      label: 'Decline',
      result: { permissions: {}, scope: 'turn' },
      style: 'danger',
      resultLabel: 'declined',
    },
  ];
}

export function codexApprovalDecisionActions(params = {}) {
  const decisions = Array.isArray(params?.availableDecisions) && params.availableDecisions.length
    ? [...new Set(params.availableDecisions.map(String))]
    : ['accept', 'acceptForSession', 'decline', 'cancel'];
  const available = new Set(decisions);
  const alwaysDecision = [
    'acceptWithExecpolicyAmendment',
    'applyNetworkPolicyAmendment',
    'acceptForSession',
    'accept',
  ].find((decision) => available.has(decision)) || 'accept';
  return {
    alwaysDecision,
    decisions,
    durable: alwaysDecision === 'acceptWithExecpolicyAmendment'
      || alwaysDecision === 'applyNetworkPolicyAmendment',
  };
}

export function codexRequestIdentityKey(sessionId, requestId) {
  return `${encodeURIComponent(String(sessionId || 'unknown-session'))}:${encodeURIComponent(String(requestId))}`;
}

export function shouldCodexAutoAcceptRequest(method) {
  return method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval';
}

export function shouldCompleteCodexPlan(tab, fallbackPlanTurnActive = false) {
  if (!tab || tab.automationRunId) return false;
  return !!(tab.planTurnActive || fallbackPlanTurnActive || tab.planMode);
}

export function detachTerminalCodexAutomation(tab) {
  if (!tab?.automationRunId || tab.automationActive) return '';
  const runId = String(tab.automationRunId);
  tab.automationRunId = null;
  tab.automationOwnerId = null;
  tab.automationActive = false;
  return runId;
}

export function registerOwnedThreadFromItem(tab, item) {
  if (!tab || !item || typeof item !== 'object') return;
  if (item.type !== 'collabToolCall' && item.type !== 'collabAgentToolCall') return;
  if (!(tab.ownedThreadIds instanceof Set)) tab.ownedThreadIds = new Set();
  for (const value of [item.receiverThreadId, item.newThreadId]) {
    if (value) tab.ownedThreadIds.add(String(value));
  }
}

export function codexSocketMessageRejectionReason(msg, tab) {
  if (!msg || !tab) return 'missing_message_or_tab';
  if (!msg.sessionId || String(msg.sessionId) !== String(tab.id)) return 'session_mismatch';
  if (!msg.connectionEpoch || String(msg.connectionEpoch) !== String(tab.connectionEpoch || '')) {
    return 'connection_epoch_mismatch';
  }

  if (msg.type === 'history' || msg.type === 'ready') {
    const messageThreadId = codexMessageThreadId(msg);
    if (!messageThreadId) {
      const awaitingThread = !!(tab.expectedThreadId
        || tab.expectedThreadRequestId
        || tab.threadStartRequest?.requestId);
      return msg.type === 'ready' && !tab.threadId && !awaitingThread ? '' : 'missing_thread';
    }
    const expectedThreadId = String(tab.expectedThreadId || tab.threadId || '');
    return expectedThreadId && String(messageThreadId) === expectedThreadId ? '' : 'thread_mismatch';
  }

  if (msg.type === 'thread' || msg.type === 'thread_started') {
    const messageThreadId = codexMessageThreadId(msg);
    if (!messageThreadId) return 'missing_thread';
    if (tab.threadId && String(messageThreadId) === String(tab.threadId)) return '';
    if (tab.expectedThreadId && String(messageThreadId) === String(tab.expectedThreadId)) return '';
    const expectedRequestId = tab.expectedThreadRequestId
      || tab.threadStartRequest?.requestId
      || '';
    return expectedRequestId && msg.requestId && String(msg.requestId) === String(expectedRequestId)
      ? ''
      : 'unexpected_thread_binding';
  }

  if (msg.type !== 'notify' && msg.type !== 'server_request') return '';

  const messageThreadId = codexMessageThreadId(msg);
  if (!messageThreadId) {
    if (msg.type === 'server_request') return 'missing_thread';
    return isThreadScopedNotification(msg.method) ? 'missing_thread' : '';
  }
  const primaryThreadId = tab.threadId ? String(tab.threadId) : '';
  const scopedThreadId = String(messageThreadId);
  if (!primaryThreadId) return 'unbound_thread';
  if (scopedThreadId === primaryThreadId) {
    const messageTurnId = codexMessageTurnId(msg);
    const activeTurnId = tab.activeTurnId ? String(tab.activeTurnId) : '';
    if (messageTurnId && activeTurnId && msg.method !== 'turn/started'
      && String(messageTurnId) !== activeTurnId) return 'turn_mismatch';
    return '';
  }
  if (msg.type === 'server_request' && tab.ownedThreadIds instanceof Set) {
    return tab.ownedThreadIds.has(scopedThreadId) ? '' : 'thread_mismatch';
  }
  return 'thread_mismatch';
}

export function socketMessageBelongsToTab(msg, tab) {
  return codexSocketMessageRejectionReason(msg, tab) === '';
}

export function isCodexMcpAuthenticationRequired(status = {}, knownServer = null) {
  return status?.failureReason === 'reauthenticationRequired'
    || status?.authStatus === 'notLoggedIn'
    || status?.requiresOAuth === true
    || knownServer?.authStatus === 'notLoggedIn'
    || knownServer?.requiresOAuth === true;
}

export function selectCodexHistoryRenderSource({
  sdkItems = [],
  fallbackItems = [],
  snapshot = null,
} = {}) {
  const authoritativeItems = Array.isArray(sdkItems) ? sdkItems.filter(Boolean) : [];
  const recoveredItems = Array.isArray(fallbackItems) ? fallbackItems.filter(Boolean) : [];
  if (authoritativeItems.length) {
    return { sourceType: 'sdk', items: authoritativeItems, snapshot: null };
  }
  if (recoveredItems.length) {
    return { sourceType: 'fallback', items: recoveredItems, snapshot: null };
  }
  if (snapshot) {
    return { sourceType: 'snapshot', items: [], snapshot };
  }
  return { sourceType: 'none', items: [], snapshot: null };
}

export function normalizeReasoningEfforts(model, fallback = []) {
  const advertised = model?.supportedReasoningEfforts
    || model?.supported_reasoning_efforts
    || model?.supportedReasoningLevels
    || model?.supported_reasoning_levels
    || [];
  const source = Array.isArray(advertised) && advertised.length ? advertised : fallback;
  const options = [{ id: 'off', label: 'Default', description: 'Use the model default' }];
  const seen = new Set(['off']);
  const standardLabels = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
  };
  for (const entry of source) {
    const id = String(typeof entry === 'string'
      ? entry
      : (entry?.effort || entry?.reasoningEffort || entry?.id || entry?.value || '')).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry === 'object' && entry?.label
      ? String(entry.label)
      : (standardLabels[id] || id.replace(/(^|[-_])(\w)/g, (_match, _sep, char) => char.toUpperCase()));
    options.push({
      id,
      label,
      description: typeof entry === 'object'
        ? String(entry.description || entry.desc || '')
        : '',
    });
  }
  return options;
}

export function selectedModelOption(models, modelId) {
  const target = String(modelId || '').toLowerCase();
  return (Array.isArray(models) ? models : []).find((model) => {
    const id = typeof model === 'string' ? model : (model?.id || model?.model || model?.name || '');
    return String(id).toLowerCase() === target;
  }) || null;
}

export function formatCodexConfigWarning(params = {}, fallback = 'configWarning') {
  const summary = params?.message || params?.summary || fallback;
  const rawDetail = params?.detail
    || params?.details
    || params?.error?.message
    || params?.error
    || params?.path;
  const detail = typeof rawDetail === 'string'
    ? rawDetail
    : (rawDetail && typeof rawDetail === 'object' ? JSON.stringify(rawDetail) : '');
  return detail && detail !== summary ? `${summary}\n${detail}` : summary;
}
