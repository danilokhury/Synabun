// OpenCode child sessions execute inside the isolated serve that spawned them.
// Keep that backend binding and the child panel's send state aligned with the
// parent so a sub-agent cannot silently fall back to the shared MCP default.

const CHILD_LINK_EVENT_TYPES = new Set(['session.created', 'session.updated']);

export function readOpenCodeSessionLink(event = {}) {
  return {
    childSessionId: event.sessionID || event.sessionId || event.info?.id || event.session?.id
      || event.properties?.info?.id || event.id || null,
    parentSessionId: event.parentID || event.parentId || event.parent_id
      || event.info?.parentID || event.info?.parentId || event.info?.parent_id
      || event.session?.parentID || event.session?.parentId || event.session?.parent_id
      || event.properties?.info?.parentID || event.properties?.info?.parentId || event.properties?.info?.parent_id
      || null,
  };
}

export function bindOpenCodeChildSessionTools({
  eventType,
  event,
  sourceRuntime,
  sessionToRuntime,
  sessionTools,
  runtimes,
}) {
  if (!CHILD_LINK_EVENT_TYPES.has(eventType)) return { bound: false, reason: 'event-type' };
  const { childSessionId, parentSessionId } = readOpenCodeSessionLink(event);
  if (!childSessionId || !parentSessionId || childSessionId === parentSessionId) {
    return { bound: false, reason: 'missing-link', childSessionId, parentSessionId };
  }

  const sourceRuntimeId = sourceRuntime?.termId || null;
  const parentRuntimeId = sessionToRuntime?.get(parentSessionId) || null;
  if (!sourceRuntimeId || parentRuntimeId !== sourceRuntimeId) {
    return { bound: false, reason: 'foreign-parent', childSessionId, parentSessionId };
  }

  const previousRuntimeId = sessionToRuntime.get(childSessionId) || null;
  if (previousRuntimeId && previousRuntimeId !== sourceRuntimeId) {
    runtimes?.get(previousRuntimeId)?.sessions?.delete(childSessionId);
  }

  const tools = sourceRuntime.tools || sessionTools?.get(parentSessionId) || null;
  sessionToRuntime.set(childSessionId, sourceRuntimeId);
  if (tools) sessionTools.set(childSessionId, tools);
  else sessionTools.delete(childSessionId);
  sourceRuntime.sessions?.add(childSessionId);

  return {
    bound: true,
    childSessionId,
    parentSessionId,
    runtimeId: sourceRuntimeId,
    tools,
  };
}

/**
 * The MCP tools a sub-agent panel starts with: its parent's. The primary
 * panel's store speaks for the parent only while it is bound to that parent
 * (`parentSessionId`): after a switch its tools is another session's, and
 * then the parent's saved choice (`savedTools(parentSessionId)`) or what the
 * child session itself carries is used. Without `parentSessionId` the parent
 * store is trusted as before.
 */
export function inheritChildPanelTools(childStore, parentStore, childInfo = null, { parentSessionId, savedTools } = {}) {
  const parentState = parentStore?.getState?.() || null;
  const parentIsBound = !parentSessionId || parentState?.sessionId === parentSessionId;
  const parentTools = parentIsBound ? (parentState?.tools || null) : null;
  let saved = null;
  if (!parentTools && parentSessionId && typeof savedTools === 'function') {
    try { saved = savedTools(parentSessionId) || null; } catch { saved = null; }
  }
  const tools = parentTools || saved || childInfo?.tools || null;
  if (tools) childStore?.setTools?.(tools);
  return tools;
}
