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

export function bindOpenCodeChildSessionProfile({
  eventType,
  event,
  sourceRuntime,
  sessionToRuntime,
  sessionProfiles,
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

  const profile = sourceRuntime.mcpProfile || sessionProfiles?.get(parentSessionId) || null;
  sessionToRuntime.set(childSessionId, sourceRuntimeId);
  if (profile) sessionProfiles.set(childSessionId, profile);
  else sessionProfiles.delete(childSessionId);
  sourceRuntime.sessions?.add(childSessionId);

  return {
    bound: true,
    childSessionId,
    parentSessionId,
    runtimeId: sourceRuntimeId,
    profile,
  };
}

/**
 * The MCP profile a sub-agent panel starts with: its parent's. The primary
 * panel's store speaks for the parent only while it is bound to that parent
 * (`parentSessionId`): after a switch its profile is another session's, and
 * then the parent's saved choice (`savedProfile(parentSessionId)`) or what the
 * child session itself carries is used. Without `parentSessionId` the parent
 * store is trusted as before.
 */
export function inheritChildPanelMcpProfile(childStore, parentStore, childInfo = null, { parentSessionId, savedProfile } = {}) {
  const parentState = parentStore?.getState?.() || null;
  const parentIsBound = !parentSessionId || parentState?.sessionId === parentSessionId;
  const parentProfile = parentIsBound ? (parentState?.mcpProfile || null) : null;
  let saved = null;
  if (!parentProfile && parentSessionId && typeof savedProfile === 'function') {
    try { saved = savedProfile(parentSessionId) || null; } catch { saved = null; }
  }
  const profile = parentProfile || saved || childInfo?.mcpProfile || null;
  if (profile) childStore?.setMcpProfile?.(profile);
  return profile;
}
