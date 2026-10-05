// Canonical Codex plan documents. Deliberately independent of DOM and transport.
/**
 * @typedef {Object} CodexPlanDocument
 * @property {number} version
 * @property {string} id
 * @property {string} accountId
 * @property {string} threadId
 * @property {string} turnId
 * @property {string} itemId
 * @property {string} markdown
 * @property {number} revision
 * @property {'draft'|'complete'} status
 * @property {'native'|'proposed_plan'|'manual'|'editor'} source
 * @property {number|null} approvedRevision
 * @property {number} updatedAt
 */
/**
 * @typedef {Object} CodexPlanEdit
 * @property {string} planId
 * @property {number} revision
 * @property {string} accountId
 * @property {string} threadId
 * @property {string} content
 */
export const CODEX_PLAN_VERSION = 1;

export function planBelongsToTab(document, tab) {
  return !!document && !!tab?.threadId
    && document.threadId === tab.threadId
    && document.accountId === (tab.accountId || 'default');
}

export function getPlanMarkdown(tab) {
  return planBelongsToTab(tab?.planDocument, tab) ? tab.planDocument.markdown : '';
}

export function extractProposedPlan(text) {
  const matches = [...String(text || '').matchAll(/<proposed_plan>\s*\n?([\s\S]*?)\n?\s*<\/proposed_plan>/g)];
  return matches.at(-1)?.[1]?.trim() || '';
}

// The toolbar can change after submission; candidate identity belongs to the
// originating turn and thread, including after finishPlanTurn clears live flags.
export function recordPlanTurn(tab, turnId) {
  if (!tab?.threadId || !turnId || tab.automationRunId) return;
  const record = { threadId: tab.threadId, turnId: String(turnId) };
  tab.planTurnHistory = [...(tab.planTurnHistory || []).filter(entry => entry.threadId !== record.threadId || entry.turnId !== record.turnId), record].slice(-100);
}

export function isRecordedPlanTurn(tab, turnId) {
  if (!tab || !turnId) return false;
  return tab.lastPlanTurnId === turnId
    || (tab.planTurnHistory || []).some(entry => entry.threadId === tab.threadId && entry.turnId === turnId);
}

export function isPlanMessageCandidate(tab, message) {
  return !!message && message.type === 'agentMessage' && message.phase !== 'commentary'
    && !!String(message.text || '').trim()
    && (!message.threadId || message.threadId === tab?.threadId)
    && (message.planTurn === true || isRecordedPlanTurn(tab, message.turnId) || !!extractProposedPlan(message.text));
}

/** Input messages are in transcript order. Never fall back to an older candidate. */
export function selectPlanAdoptionMessage(tab, messages = [], nativePlans = []) {
  const latest = messages.filter(message => isPlanMessageCandidate(tab, message)).at(-1);
  if (!latest?.completed || !latest.id || !tab?.threadId || tab.running || tab.startingThread || tab.compacting || tab.planTurnActive) return null;
  const fromTurn = source => !!source && (
    latest.turnId && source.turnId === latest.turnId || source.itemId === latest.id
  );
  const document = planBelongsToTab(tab.planDocument, tab) ? tab.planDocument : null;
  if ([document, tab.planDraft, tab.planCandidate, ...nativePlans].some(fromTurn)) return null;
  return latest.id;
}

export function syncPlanMirrors(tab) {
  const document = planBelongsToTab(tab?.planDocument, tab) ? tab.planDocument : null;
  tab.planContent = document?.markdown || '';
  tab.editedPlanContent = document?.source === 'editor' ? document.markdown : '';
  tab.planApprovalPending = !!document && document.status === 'complete' && document.approvedRevision !== document.revision;
  tab.showPostPlanActions = tab.planApprovalPending && !tab.planTurnActive;
  return document;
}

export function beginPlanTurn(tab, turnId = '') {
  if (!tab || tab.automationRunId) return;
  tab.planTurnActive = true;
  tab.lastPlanTurnId = turnId;
  recordPlanTurn(tab, turnId);
  tab.planCandidate = null;
  tab.showPostPlanActions = false;
  // A failed revision must leave the previous reviewable document intact.
}

export function capturePlanItem(tab, item, { turnId = '', completed = false } = {}) {
  if (!tab || tab.automationRunId || !tab.planTurnActive || !item?.id) return null;
  if (turnId && tab.lastPlanTurnId && turnId !== tab.lastPlanTurnId) return null;
  const native = item.type === 'plan';
  if (!native && item.type !== 'agentMessage') return null;
  const markdown = native ? String(item.text ?? '') : extractProposedPlan(item.text);
  if (!markdown.trim()) return null;
  const prior = tab.planCandidate;
  if (prior?.source === 'native' && !native) return prior;
  if (prior?.completed && prior.itemId === item.id && !completed) return prior;
  tab.planCandidate = {
    itemId: item.id, turnId: turnId || tab.lastPlanTurnId,
    markdown, source: native ? 'native' : 'proposed_plan', completed,
  };
  return tab.planCandidate;
}

function installPlan(tab, candidate, status = 'complete') {
  const previous = planBelongsToTab(tab.planDocument, tab) ? tab.planDocument : null;
  const document = {
    version: CODEX_PLAN_VERSION,
    id: previous?.id || `${tab.threadId}:${candidate.turnId || 'manual'}:${candidate.itemId || 'plan'}`,
    accountId: tab.accountId || 'default', threadId: tab.threadId,
    turnId: candidate.turnId || '', itemId: candidate.itemId || '',
    markdown: candidate.markdown, source: candidate.source,
    revision: (previous?.revision || 0) + 1, status, approvedRevision: null,
    updatedAt: Date.now(),
  };
  if (previous) tab.planRevisions = [...(tab.planRevisions || []), previous].slice(-20);
  tab.planDocument = document;
  tab.planDraft = null;
  tab.planFilePath = '';
  syncPlanMirrors(tab);
  return document;
}

export function finishPlanTurn(tab, { turnId = '', status = 'completed' } = {}) {
  if (!tab?.planTurnActive || (turnId && tab.lastPlanTurnId && turnId !== tab.lastPlanTurnId)) return null;
  const candidate = tab.planCandidate;
  tab.planTurnActive = false;
  tab.lastPlanTurnId = '';
  tab.planRequestId = '';
  tab.planCandidate = null;
  if (candidate?.completed && status === 'completed') {
    tab.planMode = true; // Review and clarification remain in native Plan mode until approval.
    return installPlan(tab, candidate);
  }
  if (candidate) tab.planDraft = { ...candidate, status: 'draft' };
  tab.planMode = true;
  syncPlanMirrors(tab);
  return null;
}

export function useMessageAsPlan(tab, { itemId, turnId, markdown }) {
  if (!tab?.threadId || tab.running || !String(markdown || '').trim()) return null;
  tab.planTurnActive = false;
  tab.lastPlanTurnId = '';
  tab.planRequestId = '';
  tab.planCandidate = null;
  tab.planMode = true;
  return installPlan(tab, { itemId, turnId, markdown, source: 'manual' });
}

export function validatePlanEdit(tab, edit) {
  if (tab?.closed) return { ok: false, reason: 'The conversation was closed. Reopen it before saving this plan.' };
  const document = tab?.planDocument;
  if (!planBelongsToTab(document, tab) || document.id !== edit?.planId
    || document.threadId !== edit.threadId || document.accountId !== edit.accountId) {
    return { ok: false, reason: 'This editor belongs to another plan or conversation.' };
  }
  if (document.revision !== edit.revision || tab.planTurnActive) {
    return { ok: false, reason: 'The plan changed while this editor was open. Reopen the current revision before saving.' };
  }
  if (!String(edit.content || '').trim()) return { ok: false, reason: 'A plan cannot be empty.' };
  return { ok: true, document };
}

export function acceptPlanEdit(tab, edit) {
  const validation = validatePlanEdit(tab, edit);
  if (!validation.ok) return validation;
  const document = installPlan(tab, { ...validation.document, markdown: edit.content, source: 'editor' });
  return { ok: true, document };
}

export function approvePlan(tab) {
  if (tab?.closed) return { ok: false, reason: 'This conversation was closed. Reopen it before continuing.' };
  const document = tab?.planDocument;
  if (!planBelongsToTab(document, tab) || document.status !== 'complete') {
    return { ok: false, reason: 'Complete or explicitly select a plan before implementation.' };
  }
  if (tab.running || tab.planTurnActive || tab.compacting || tab.planEditor?.dirty || tab.planEditor?.saving) {
    return { ok: false, reason: 'Finish the current operation and save or cancel your plan edits first.' };
  }
  return { ok: true, document, prompt: `The user has reviewed and approved this complete plan (revision ${document.revision}):\n\n${document.markdown}\n\nProceed with implementation.` };
}

export function migrateLegacyPlan(tab) {
  if (planBelongsToTab(tab.planDocument, tab)) return syncPlanMirrors(tab);
  if (!tab.threadId) return null;
  const edited = String(tab.editedPlanContent || '');
  const legacy = String(tab.planContent || '');
  if (edited.trim()) {
    return installPlan(tab, { markdown: edited, source: 'editor', turnId: '', itemId: 'legacy-editor' });
  }
  if (legacy.trim()) tab.planDraft = { markdown: legacy, status: 'draft', source: 'legacy' };
  tab.planDocument = null;
  syncPlanMirrors(tab);
  return null;
}

function isRecordedPlanApproval(item, markdown) {
  if (item.type !== 'userMessage') return false;
  const content = Array.isArray(item.content)
    ? item.content.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n')
    : typeof item.content === 'string' ? item.content : item.text || '';
  const match = String(content).trim().match(/^The user has reviewed and approved this complete plan \(revision \d+\):\n\n([\s\S]*)\n\nProceed with implementation\.$/);
  return !!match && match[1] === markdown;
}

export function recoverPlanFromHistory(tab, turns = [], { authoritative = false } = {}) {
  if (!tab?.threadId || tab.automationRunId) return null;
  // Only the caller can establish that this snapshot is current and no newer
  // request is being submitted. A live/incomplete turn must never be finalized
  // merely because the page has reloaded.
  const hasActiveTurn = turns.some((turn) => turn.status && !['completed', 'failed', 'interrupted'].includes(turn.status));
  if (tab.planTurnActive) {
    if (!authoritative || hasActiveTurn) return null;
    if (tab.planCandidate) tab.planDraft = { ...tab.planCandidate, status: 'draft' };
    tab.planTurnActive = false;
    tab.lastPlanTurnId = '';
    tab.planRequestId = '';
    tab.planCandidate = null;
  }
  const previous = planBelongsToTab(tab.planDocument, tab) ? tab.planDocument : null;
  let latest = null;
  let latestIndex = -1;
  for (const [index, turn] of turns.entries()) {
    if (turn.status && turn.status !== 'completed') continue;
    let candidate = null;
    for (const item of turn.items || []) {
      const markdown = item.type === 'plan' ? item.text : item.type === 'agentMessage' ? extractProposedPlan(item.text) : '';
      if (!String(markdown || '').trim()) continue;
      if (candidate?.source === 'native' && item.type !== 'plan') continue;
      candidate = { markdown, itemId: item.id, turnId: turn.id, source: item.type === 'plan' ? 'native' : 'proposed_plan' };
    }
    if (candidate) {
      latest = candidate;
      latestIndex = index;
    }
  }
  if (previous) {
    const previousIndex = turns.findIndex((turn) => turn.id === previous.turnId);
    // A saved editor revision or approval for the same source turn wins. Only
    // replace it when history establishes that another plan came afterward.
    if (!latest || previousIndex < 0 || latestIndex <= previousIndex) {
      syncPlanMirrors(tab);
      return previous;
    }
  }
  if (!latest) {
    syncPlanMirrors(tab);
    return null;
  }
  const document = installPlan(tab, latest);
  // Restoring history is not approval. A later recorded submission of this
  // exact document is the one fallback that proves the review already happened.
  if (turns.slice(latestIndex + 1).some((turn) => (turn.items || []).some((item) => isRecordedPlanApproval(item, document.markdown)))) {
    document.approvedRevision = document.revision;
  }
  if (document.approvedRevision !== document.revision) tab.planMode = true;
  syncPlanMirrors(tab);
  return document;
}
