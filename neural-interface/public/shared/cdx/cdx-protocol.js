// SynaBun Codex panel protocol normalization and ownership guards.
import { readableStructuredValue } from './cdx-output-model.js';

export const CODEX_PERMISSION_APPROVAL_METHOD = 'item/permissions/requestApproval';
export const CODEX_MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request';
export const SYNABUN_CHOICE_MARKER = '[SYNABUN_CHOICE_V1]';
export const SYNABUN_OTHER_VALUE = '__synabun_other__';
export const CODEX_THREAD_SNAPSHOT_VERSION = 3;

const THREAD_SCOPED_NOTIFICATION_PREFIXES = ['item/', 'turn/', 'thread/', 'hook/'];

const readableName = value => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_/]/g, ' ');

/** Bounded text for new protocol payloads, without dumping transport JSON. */
export function codexReadableValue(value, depth = 0) {
  if (Array.isArray(value) && value.length && value.every(entry => entry && ['input_text', 'text', 'input_image', 'inputImage', 'image'].includes(entry.type))) {
    return value.slice(0, 40).map(entry => codexReadableValue(entry)).join('\n').slice(0, 12000);
  }
  if (['input_text', 'text'].includes(value?.type)) return readableStructuredValue(value.text, 11900).slice(0, 12000);
  if (value?.type === 'encrypted_content') return 'Encrypted content';
  if (['image', 'input_image', 'inputImage'].includes(value?.type)) return `Image: ${value.fileId || value.file_id || value.image_url || value.url || 'attached image'}`.slice(0, 300);
  return readableStructuredValue(value, 11900).slice(0, 12000);
}

export function codexTranscriptPresentation(item = {}) {
  const titles = { functionCallOutput: 'Tool output', subAgentActivity: 'Agent activity', sleep: 'Waiting', hookRun: 'Hook execution', threadGoal: 'Thread goal', webSearch: 'Web search', imageView: 'Viewing image', imageGeneration: 'Image generation', hookPrompt: 'Hook prompt', enteredReviewMode: 'Entered review mode', exitedReviewMode: 'Exited review mode' };
  let text;
  switch (item.type) {
    case 'functionCallOutput': text = codexReadableValue(item.output); break;
    case 'subAgentActivity': text = `Agent: ${item.agentPath || item.agentThreadId || 'agent'}\nActivity: ${item.kind || 'updated'}`; break;
    case 'sleep': text = `Waiting ${(Number(item.durationMs) || 0) / 1000} seconds. New input can interrupt this wait.`; break;
    case 'hookRun': text = [item.statusMessage, item.sourcePath, item.durationMs != null ? `${item.durationMs}ms` : '', ...(item.entries || []).map(entry => `${entry.kind}: ${entry.text}`)].filter(Boolean).join('\n'); break;
    case 'threadGoal': text = [item.objective || 'Goal cleared', item.tokensUsed != null ? `Tokens used: ${item.tokensUsed}${item.tokenBudget != null ? ` / ${item.tokenBudget}` : ''}` : '', item.timeUsedSeconds != null ? `Elapsed: ${item.timeUsedSeconds}s` : ''].filter(Boolean).join('\n'); break;
    default: text = codexReadableValue(Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith('_') && !['id', 'type', 'status'].includes(key))));
  }
  return { title: titles[item.type] || readableName(item.type) || 'Codex item', subtitle: item.name || item.eventName || item.agentPath || '', text, status: item.status || item.kind || (item._synabunCompleted ? 'complete' : 'pending') };
}

export function codexNotificationItem(method, params = {}) {
  if (method === 'hook/started' || method === 'hook/completed') {
    if (!params.run?.id) return null;
    return { ...params.run, id: `hook:${params.run.id}`, type: 'hookRun', _synabunCompleted: method === 'hook/completed' };
  }
  if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
    const cleared = method === 'thread/goal/cleared';
    return { ...params.goal, ...(cleared ? { objective: null, tokensUsed: null, tokenBudget: null, timeUsedSeconds: null } : {}),
      id: `goal:${params.threadId}`, type: 'threadGoal', status: cleared ? 'cleared' : params.goal?.status };
  }
  return null;
}

/**
 * The retained history in a rollback reply, when it is the whole history of the
 * thread the tab shows. `empty` means no item survived the revert.
 */
export function codexRevertedHistory(thread, threadId) {
  if (!thread?.id || String(thread.id) !== String(threadId || '') || !Array.isArray(thread.turns)) return null;
  return { thread, empty: !thread.turns.some(turn => Array.isArray(turn?.items) && turn.items.some(Boolean)) };
}

/**
 * A revert reaches the panel twice, in either order: the `thread/reverted`
 * notification ('notified') and the reply that re-renders the transcript
 * ('rendered'). The re-render wipes an earlier notice, so it always shows one;
 * a notification that follows it shows none.
 */
export function codexRevertNotice(pending, event) {
  if (pending && pending !== event) return { pending: '', show: event === 'rendered' };
  return { pending: event, show: true };
}

/** Keep the existing query/path/prompt preview visible on collapsed cards. */
export function codexGenericCardHead(item, headline = {}) {
  const presentation = codexTranscriptPresentation(item);
  return { title: presentation.title, subtitle: presentation.subtitle || headline.detail || headline.title || '' };
}

/** Native settings can contain temporary plan-mode effort or an unavailable model. */
export function applyCodexThreadSettings(tab, params = {}, models = []) {
  if (!tab) return;
  const settings = params.threadSettings;
  tab.nativeSettings = settings || null;
  if (!settings) return;
  const model = selectedModelOption(models, settings.model);
  if (model) tab.model = settings.model;
  const effortModel = settings.model ? model : selectedModelOption(models, tab.model);
  if (!tab.planMode && !tab.planTurnActive && settings.collaborationMode?.mode !== 'plan'
    && effortModel && normalizeReasoningEfforts(effortModel).some(option => option.id === settings.effort)) {
    tab.effort = settings.effort;
  }
}

export function codexModelAccessMetadata(model = {}) {
  const programs = model.availableAccessPrograms?.cyber;
  return Array.isArray(programs) && programs.length ? `Access programs: ${programs.map(readableName).join(', ')}` : '';
}

export function codexRateLimitMetadata(bucket = {}) {
  return [bucket.normalModelSlug ? `model ${bucket.normalModelSlug}` : '', bucket.planType ? `plan ${bucket.planType}` : '', bucket.rateLimitReachedType ? `limit ${bucket.rateLimitReachedType}` : '', bucket.spendControlReached === true ? 'spend control reached' : ''].filter(Boolean).join(' · ');
}

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
  const decisions = Array.isArray(params?.availableDecisions)
    ? [...new Map(params.availableDecisions.filter((value) => typeof value === 'string' || (value && typeof value === 'object')).map((value) => [JSON.stringify(value), value])).values()]
    : ['accept', 'acceptForSession', 'decline', 'cancel'];
  const nameOf = (decision) => typeof decision === 'string' ? decision : Object.keys(decision)[0];
  const alwaysDecision = [
    'acceptWithExecpolicyAmendment',
    'applyNetworkPolicyAmendment',
    'acceptForSession',
    'accept',
  ].map((name) => decisions.find((decision) => nameOf(decision) === name)).find(Boolean) || null;
  return {
    alwaysDecision,
    decisions,
    durable: nameOf(alwaysDecision || '') === 'acceptWithExecpolicyAmendment'
      || nameOf(alwaysDecision || '') === 'applyNetworkPolicyAmendment',
  };
}

export function codexRequestIdentityKey(sessionId, requestId) {
  return `${encodeURIComponent(String(sessionId || 'unknown-session'))}:${encodeURIComponent(String(requestId))}`;
}

export function shouldCodexAutoAcceptRequest(method) {
  return method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval';
}

/**
 * AUTO for a new tab: what was saved for it, else the active tab's, else the
 * stored default. An automation tab got its AUTO from the run, not from the
 * person, so it is never handed on.
 */
export function codexNewTabAutoAccept(saved, active, storedDefault) {
  const inherited = active?.automationRunId ? null : active?.autoAccept;
  return saved?.autoAccept ?? inherited ?? !!storedDefault;
}

/**
 * The server requests a history render has to put back: the ones the bridge
 * sent on the tab's current connection for a thread the tab shows. A re-attach
 * replays what the bridge still holds, so one from an earlier connection is gone.
 */
export function codexHeldServerRequests(held, tab) {
  if (!(held instanceof Map)) return [];
  return [...held.values()].filter((request) => socketMessageBelongsToTab(request, tab));
}

export function shouldCompleteCodexPlan(tab, fallbackPlanTurnActive = false) {
  if (!tab || tab.automationRunId) return false;
  return !!(tab.planTurnActive || fallbackPlanTurnActive || tab.planMode);
}

/**
 * A finished run lets go of its tab. AUTO was on because the run owned the
 * tab: released, the tab goes back to the person's stored default.
 */
export function detachTerminalCodexAutomation(tab, storedAutoAccept = false) {
  if (!tab?.automationRunId || tab.automationActive) return '';
  const runId = String(tab.automationRunId);
  tab.automationRunId = null;
  tab.automationOwnerId = null;
  tab.automationActive = false;
  tab.autoAccept = !!storedAutoAccept;
  return runId;
}

// ── Native automation runs (Codex SDK / `codex exec --json` events) ──

/** Turn id for a native run's event: one per `codex exec` (providerTurn), else per loop iteration. */
export function codexAutomationTurnKey(runId, payload = {}, fallbackIteration = 0) {
  const providerTurn = Number(payload?.providerTurn) || 0;
  if (providerTurn) return `${runId}:t${providerTurn}`;
  return `${runId}:${Number(payload?.iteration) || Number(fallbackIteration) || 0}`;
}

/**
 * Whether the events a window buffered before the run's tab existed replay the
 * whole run: they start at the first turn's prompt and none were dropped. Then
 * a history read would render every item a second time.
 */
export function codexAutomationBufferCoversRun(events = [], truncated = false) {
  if (truncated || !Array.isArray(events) || !events.length) return false;
  const first = events[0];
  return first?.event?.type === 'synabun.user_prompt' && Number(first.providerTurn) === 1;
}

const SDK_STATUS = { in_progress: 'inProgress' };

/**
 * An SDK item in the app-server shape the renderer draws. Ids are scoped to the
 * turn (each `codex exec` restarts at item_0), and the ownership stamp binds the
 * item to the run's tab: the render path drops items that carry none.
 */
export function codexAutomationItem(item, eventType, { runId = '', turnKey = '', accountId = 'default', threadId = '' } = {}) {
  if (!item?.id) return null;
  const completed = eventType === 'item.completed';
  const base = {
    ...item,
    id: `${turnKey}:${item.id}`,
    _synabunOwnership: {
      accountId: accountId || 'default',
      threadId: threadId || '',
      turnId: turnKey,
      runId,
      source: 'automation',
    },
  };
  const status = SDK_STATUS[item.status] || item.status;
  switch (item.type) {
    case 'agent_message':
      return { ...base, type: 'agentMessage', phase: 'final_answer', status: completed ? 'completed' : 'inProgress' };
    case 'reasoning':
      return { ...base, type: 'reasoning', status: completed ? 'complete' : 'inProgress' };
    case 'command_execution':
      return { ...base, type: 'commandExecution', status, aggregatedOutput: item.aggregated_output || '', exitCode: item.exit_code };
    case 'file_change':
      return { ...base, type: 'fileChange', status };
    case 'mcp_tool_call':
      return { ...base, type: 'mcpToolCall', status, args: item.arguments };
    case 'web_search':
      return { ...base, type: 'webSearch', status: completed ? 'completed' : 'inProgress' };
    case 'todo_list':
      return {
        ...base,
        type: 'plan',
        text: (item.items || []).map((entry) => `- [${entry.completed ? 'x' : ' '}] ${entry.text}`).join('\n'),
      };
    default:
      return { ...base, status: status || (completed ? 'completed' : 'inProgress') };
  }
}

export function registerOwnedThreadFromItem(tab, item) {
  if (!tab || !item || typeof item !== 'object') return;
  if (item.type !== 'collabToolCall' && item.type !== 'collabAgentToolCall') return;
  if (!(tab.ownedThreadIds instanceof Set)) tab.ownedThreadIds = new Set();
  for (const value of [item.receiverThreadId, item.newThreadId, ...(item.receiverThreadIds || [])]) {
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
    max: 'Max',
    ultra: 'Ultra',
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

export function normalizeCodexContextMode(value) {
  return value === 'extended' ? 'extended' : 'default';
}

export function selectedCodexContextModel(models, modelId) {
  const selected = selectedModelOption(models, modelId);
  if (selected) return selected;
  if (String(modelId || '').trim()) return null;
  return (Array.isArray(models) ? models : []).find((model) => (
    model?.isDefault === true || model?.is_default === true || model?.default === true
  )) || null;
}

export function verifyCodexExtendedContext({ contextMode, model, actualWindow } = {}) {
  if (normalizeCodexContextMode(contextMode) !== 'extended') return 'off';
  const actual = Number(actualWindow);
  if (!Number.isFinite(actual) || actual <= 0) return 'pending';
  const expected = Number(model?.expectedEffectiveContextWindow);
  if (Number.isFinite(expected) && expected > 0) {
    const tolerance = Math.max(1024, Math.floor(expected * 0.01));
    return actual + tolerance >= expected ? 'verified' : 'mismatch';
  }
  const baseline = Number(model?.contextWindow);
  if (!Number.isFinite(baseline) || baseline <= 0) return 'unavailable';
  return actual > baseline ? 'verified' : 'mismatch';
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
export const CODEX_ATTACHMENT_PAYLOAD_LIMIT = 65536;

export function parseCodexAttachmentPayload(text) {
  if (new TextEncoder().encode(String(text)).length > CODEX_ATTACHMENT_PAYLOAD_LIMIT) throw new Error('Payload must be at most 64 KiB of JSON.');
  try { return JSON.parse(text); } catch (error) { throw new Error(`Invalid JSON: ${error.message}`); }
}

export function codexHttpsHandoff(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? { url: url.href, host: url.host } : null;
  } catch { return null; }
}

export function codexGatewayState(value = {}) {
  const labels = { notReady: 'Sign-in required', started: 'Waiting for sign-in', succeeded: 'Signed in', failed: 'Sign-in failed' };
  return { label: value.error || labels[value.status] || (value.required ? 'Sign-in required' : 'Not required for this provider'), pending: value.status === 'started' };
}

export function codexVerificationState(value = {}) {
  return { label: value.unavailableMessage || ({ credentialMissing: 'No local credential', biometricsUnavailable: 'Biometrics unavailable', providerUnavailable: 'Verification provider unavailable' })[value.unavailableReason] || (value.credentialId ? 'Local credential ready' : 'No local credential'), enrolled: !!value.credentialId };
}

/** UI race gate: a later verification result cannot accept a declined card. */
export function codexVerificationResolution() {
  let resolved = false;
  return { get resolved() { return resolved; }, claim() { if (resolved) return false; resolved = true; return true; } };
}
