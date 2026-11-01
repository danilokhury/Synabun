// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: tabs, attachments and dispatched-run events (no DOM)
// ═══════════════════════════════════════════
//
// A tab is one ACP session of Antigravity's in one project folder. What is saved
// per window (`synabun-antigravity-panel-tabs-<windowId>`, read by the side panel
// tray too) is `{ tabs, activeIdx }` with the fields below; the transcript is not
// saved: a tab with a session id replays it from Antigravity (session/load).
// `bypass` is the tab's Bypass (agy-bypass.js): off unless the owner turned it on.

export const TAB_FIELDS = Object.freeze(['id', 'sessionId', 'project', 'geminiDir', 'label', 'title', 'titleByUser', 'additionalDirectories', 'draft',
  'running', 'needsYou', 'automationRunId', 'automationActive', 'automationOwnerId', 'releasedRunId', 'createdAt', 'bypass']);
export const MAX_TABS = 12;
export const ATTACH_LIMITS = Object.freeze({ maxAttachments: 8, maxBytes: 15 * 1024 * 1024 });
const ATTACHABLE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/[a-z0-9.+-]+|application\/(json|xml|x-yaml|yaml)|audio\/(wav|x-wav|mpeg|mp4|aac|flac|ogg|opus|webm))$/;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|ya?ml|xml|csv|log|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|css|scss|html|sql|toml|ini|env)$/i;

let counter = 0;
const newId = () => (globalThis.crypto?.randomUUID?.() || `agy-${Date.now().toString(36)}-${(counter += 1)}`);

export function newTab({ project = '', sessionId = null, title = null, geminiDir = null } = {}) {
  return {
    id: newId(), sessionId, project: String(project || ''), geminiDir: typeof geminiDir === 'string' && geminiDir.trim() ? geminiDir.trim() : null,
    label: 'New session', title, titleByUser: null, additionalDirectories: [], draft: '',
    running: false, needsYou: false, automationRunId: null, automationActive: false, automationOwnerId: null,
    releasedRunId: null, createdAt: Date.now(), bypass: false,
  };
}

/**
 * What the tray and the panel show for a tab: its session's title, else a short id, else "New session". `words`
 * gives the page's language for the last three (the saved label stays English when none is given).
 */
export function tabLabel(tab, words = {}) {
  const title = typeof tab?.title === 'string' ? tab.title.trim() : '';
  if (title) return title.length > 60 ? `${title.slice(0, 57)}…` : title;
  if (tab?.automationRunId) return `${words.run || 'Dispatched run'} · ${String(tab.automationRunId).slice(0, 8)}`;
  if (tab?.sessionId) return `Antigravity · ${String(tab.sessionId).slice(0, 8)}`;
  return words.newSession || 'New session';
}

/** The saved form: `{ tabs, activeIdx }`, each tab its persisted fields only. */
export function serializeTabs(tabs, activeIdx) {
  const list = (Array.isArray(tabs) ? tabs : []).slice(0, MAX_TABS).map((tab) => {
    const out = {};
    for (const key of TAB_FIELDS) if (tab?.[key] !== undefined) out[key] = tab[key];
    out.label = tabLabel(tab);
    return out;
  });
  const idx = Number.isInteger(activeIdx) ? Math.min(Math.max(activeIdx, 0), Math.max(list.length - 1, 0)) : 0;
  return { tabs: list, activeIdx: idx };
}

/**
 * Saved tabs as the panel restores them: invalid rows dropped, nothing marked running (the page that ran it is
 * gone: a live run is reattached by the native-loop router, not by a flag), an id for every tab.
 */
export function restoreTabs(raw) {
  let data = raw;
  if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { data = null; } }
  const rows = Array.isArray(data?.tabs) ? data.tabs : [];
  const tabs = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const tab = { ...newTab(), ...Object.fromEntries(TAB_FIELDS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]])) };
    if (typeof tab.id !== 'string' || !tab.id || seen.has(tab.id)) tab.id = newId();
    seen.add(tab.id);
    if (tab.sessionId !== null && (typeof tab.sessionId !== 'string' || !/^[A-Za-z0-9._:@-]{1,200}$/.test(tab.sessionId))) tab.sessionId = null;
    tab.project = typeof tab.project === 'string' ? tab.project : '';
    tab.geminiDir = typeof tab.geminiDir === 'string' && tab.geminiDir.trim() ? tab.geminiDir.trim() : null;
    tab.draft = typeof tab.draft === 'string' ? tab.draft : '';
    tab.titleByUser = typeof tab.titleByUser === 'string' && tab.titleByUser.trim() ? tab.titleByUser.trim().slice(0, 120) : null;
    tab.additionalDirectories = Array.isArray(tab.additionalDirectories)
      ? [...new Set(tab.additionalDirectories.filter((p) => typeof p === 'string' && p && p !== tab.project))].slice(0, 8)
      : [];
    // Bypass comes back only as the owner's own pick (a literal true), never from anything else in storage.
    tab.bypass = tab.bypass === true;
    tab.running = false;
    tab.needsYou = false;
    tabs.push(tab);
    if (tabs.length >= MAX_TABS) break;
  }
  const activeIdx = Number.isInteger(data?.activeIdx) && data.activeIdx >= 0 && data.activeIdx < tabs.length ? data.activeIdx : 0;
  return { tabs, activeIdx };
}

/** The MIME type a dropped or pasted file is sent as (a browser leaves it empty for many text files). */
export function attachmentType(file) {
  const declared = String(file?.type || '').toLowerCase();
  if (declared) return declared;
  return TEXT_EXTENSIONS.test(String(file?.name || '')) ? 'text/plain' : '';
}

/** Whether a file may be attached now: null when it may, else { key, params } for agyText. */
export function attachmentProblem(file, staged = [], limits = ATTACH_LIMITS) {
  const name = String(file?.name || 'file');
  if (staged.length >= limits.maxAttachments) return { key: 'attachmentTooMany', params: { count: limits.maxAttachments } };
  if (!ATTACHABLE.test(attachmentType(file))) return { key: 'attachmentType', params: { name } };
  if (Number(file?.size) > limits.maxBytes) return { key: 'attachmentTooLarge', params: { name, size: Math.round(limits.maxBytes / 1048576) } };
  return null;
}

/**
 * A picture another part of the app hands the panel (the whiteboard's Send to Panel, also through a detached window)
 * as a staged attachment: `{ file: { name, mimeType, dataUrl } }`, `{ problem: { key, params } }` when it may not
 * be attached now (the same limits as a pasted file), or null when it is not a PNG, JPEG, GIF or WebP data URL.
 */
export function stagedPicture(dataUrl, staged = [], { name = 'whiteboard', now = Date.now(), limits = ATTACH_LIMITS } = {}) {
  const match = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const body = match[3];
  const size = Math.floor((body.length * 3) / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0);
  const file = { name: `${name}-${now}.${match[2] === 'jpeg' ? 'jpg' : match[2]}`, type: match[1], size };
  const problem = attachmentProblem(file, staged, limits);
  return problem ? { problem } : { file: { name: file.name, mimeType: match[1], dataUrl } };
}

/** A data URL's base64 body, or '' for anything else. */
export function base64Of(dataUrl) {
  const match = /^data:[^;,]*(?:;[^;,]*)*;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  return match ? match[1] : '';
}

/** The bridge's `prompt` request for a tab: its text and staged attachments ({ name, mimeType, dataUrl }). */
export function promptRequest(tab, text, staged = []) {
  return {
    sessionId: tab.sessionId,
    text: String(text || ''),
    attachments: staged.map((file) => ({ name: file.name, mimeType: file.mimeType, data: base64Of(file.dataUrl) })).filter((file) => file.data),
    paths: staged.filter((file) => file.path).map((file) => file.path),
  };
}

/**
 * One event of a dispatched run (the native-loop router's `sync:sidepanel:provider-event` payload, or its `event`)
 * as what the transcript does with it: { kind: 'user', text, iteration } | { kind: 'update', update } |
 * { kind: 'notice', text, severity } | null.
 */
export function automationEvent(payload) {
  const message = payload?.event && typeof payload.event === 'object' && (payload.eventType || payload.provider) ? payload : (payload?.event || payload);
  const eventType = message?.eventType || message?.event?.type || message?.type;
  const event = message?.event ?? message;
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'synabun.user_prompt' || eventType === 'synabun.user_prompt') return { kind: 'user', text: String(event.text || ''), iteration: message.iteration ?? null };
  if (event.type === 'synabun.confinement') return { kind: 'notice', text: `${event.action === 'warned' ? 'Guard warning' : 'Refused'}: ${event.reason || event.rule || ''}`.trim(), severity: event.action === 'warned' ? 'warning' : 'error' };
  if (event.type === 'synabun.provider_exit') return { kind: 'notice', text: `Antigravity stopped${event.error ? `: ${event.error}` : ''}`, severity: 'error' };
  if (event.type === 'synabun.error') return { kind: 'notice', text: String(event.message || event.error || 'Error'), severity: 'error' };
  if (typeof event.sessionUpdate === 'string') return { kind: 'update', update: event };
  return null;
}

/** The per-run Antigravity home (`--gemini-dir`) a dispatched run executed in, or null when none is named. */
export function runGeminiDir(run) {
  const raw = run?.antigravityHome ?? run?.geminiDir ?? run?.resumeInfo?.antigravityHome ?? run?.runtime?.antigravityHome ?? null;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** The bridge request (`session:load` or `session:resume`) that opens an existing tab's session in the panel. */
export function openSessionRequest(tab, { resume = false, folders = [] } = {}) {
  const dirs = Array.isArray(folders) ? folders.filter((p) => typeof p === 'string' && p) : [];
  const geminiDir = typeof tab?.geminiDir === 'string' && tab.geminiDir ? tab.geminiDir : null;
  return {
    type: resume ? 'session:resume' : 'session:load',
    payload: {
      sessionId: tab.sessionId,
      cwd: tab.project,
      tabId: tab.id,
      bypass: tab?.bypass === true,
      ...(geminiDir ? { geminiDir } : {}),
      ...(dirs.length ? { additionalDirectories: dirs } : {}),
    },
  };
}

/** The notice shown when loading or resuming a tab's session fails (null when sign-in handles it instead). */
export function sessionLoadNotice(error, textOf) {
  if (error?.authRequired) return null;
  if (error?.code === 'HOME_PRUNED') return { text: textOf('runHomePruned'), severity: 'error' };
  return { text: textOf('historyFailed', { error: error?.message || String(error ?? '') }), severity: 'error' };
}
