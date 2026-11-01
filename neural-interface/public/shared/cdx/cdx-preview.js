// The early Codex rollout preview (server.js sendEarlyCodexRolloutPreview): DOM-free decisions.

/** A bootstrap asks for the preview only for a saved thread of the tab on screen. */
export function codexWantsRolloutPreview(tab, shownTab, threadId) {
  return !!threadId && !!tab && tab === shownTab;
}

/** A preview paints only for the thread shown, and only while nothing else (a stored snapshot) is on screen. */
export function rolloutPreviewApplies(msg, shownThread, transcriptSourceType) {
  const previewFor = String(msg?.threadId || msg?.thread?.id || '');
  return !transcriptSourceType && !!previewFor && previewFor === String(shownThread || '');
}
