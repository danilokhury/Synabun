// The runtime's request identity, shared by the router and the panel. Wording is never identity.
export function routeTaskIdentity(route) {
  if (!route?.taskId) return null; // Old transcripts predate task identities.
  return JSON.stringify([route.sessionId || '', route.taskId, route.taskKey || '']);
}

// Control packets and transcript events can arrive in either order on attach/reconnect.
export function createRouteReplayGuard() {
  const seen = new Set();
  // A host-only replacement can share a task with a retired worker card.
  const keys = route => [route?.routeId, route?.needsHost ? null : routeTaskIdentity(route)].filter(Boolean);
  return {
    has: route => keys(route).some(key => seen.has(key)),
    record: route => { for (const key of keys(route)) seen.add(key); },
    clear: () => seen.clear(),
  };
}
