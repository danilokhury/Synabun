// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — session lifecycle decisions (no DOM)
// What the session menu lists, what a reverted transcript shows, which actions
// a message offers, what an export contains.
// ─────────────────────────────────────────────────────────────────────────────

import { visibleParts } from './ocp-v2-render-logic.js';

const LOCAL_MESSAGE_PREFIX = 'local-user-';

// ── Revert (undo) ───────────────────────────────────────────────────────────
// After session.revert OpenCode keeps the messages and records
// `session.revert = { messageID, … }`: everything from that message on is
// undone until the user restores it or sends a new prompt (which deletes it).

/** Message ids to show: the transcript up to the revert point. */
export function visibleMessageOrder(order, revert) {
  const list = Array.isArray(order) ? order : [];
  const cut = revert?.messageID ? list.indexOf(revert.messageID) : -1;
  if (cut < 0) return list;
  // A prompt typed after the revert is shown at once; it is not part of what was undone.
  return list.filter((id, index) => index < cut || String(id).startsWith(LOCAL_MESSAGE_PREFIX));
}

/** The "reverted" banner, or null when nothing is undone. */
export function revertBannerView(sessionInfo, order) {
  const revert = sessionInfo?.revert;
  if (!revert?.messageID) return null;
  const list = Array.isArray(order) ? order : [];
  const cut = list.indexOf(revert.messageID);
  const hidden = cut < 0 ? 0 : list.slice(cut).filter((id) => !String(id).startsWith(LOCAL_MESSAGE_PREFIX)).length;
  return {
    hidden,
    text: hidden
      ? `Undone: ${hidden} message${hidden === 1 ? '' : 's'} hidden. Send a new prompt to continue from here.`
      : 'This session is reverted to an earlier point.',
    hasFileChanges: typeof revert.diff === 'string' && revert.diff.trim().length > 0,
  };
}

/** The readable text of a message (what Copy copies, what Undo puts back in the composer). */
export function messageText(msg) {
  return visibleParts(msg)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

const isServerMessage = (id) => !!id && !String(id).startsWith(LOCAL_MESSAGE_PREFIX);

// What OpenCode writes into a prompt when it read an MCP resource for it
// (1.18.34): a synthetic text part, followed by the resource's content. The
// file part that asked for the resource is not stored.
const RESOURCE_READ_RE = /^Reading MCP resource: ([\s\S]*) \(([^\s()]+)\)$/;

/** `{ name, uri }` of every MCP resource OpenCode read for this message. */
export function resourceReadsOf(msg) {
  const out = [];
  const seen = new Set();
  const parts = msg?.parts instanceof Map ? msg.parts.values() : (Array.isArray(msg?.parts) ? msg.parts : []);
  for (const part of parts) {
    if (part?.type !== 'text' || !part.synthetic || typeof part.text !== 'string') continue;
    const match = RESOURCE_READ_RE.exec(part.text.trim());
    if (!match || seen.has(match[2])) continue;
    seen.add(match[2]);
    out.push({ name: match[1], uri: match[2] });
  }
  return out;
}

/**
 * What it takes to send a user message again: its text, its file parts
 * (pasted images and PDFs as data URLs, referenced paths and @ mentions as
 * file:// URLs, each with the `source` it was sent with) and the MCP
 * resources it read (`resources`, see resourceReadsOf). Text OpenCode added
 * itself (a file's content, marked synthetic) is not part of the prompt and is
 * left out.
 */
export function replayablePrompt(msg) {
  const text = messageText(msg);
  const files = [];
  const seen = new Set();
  for (const part of visibleParts(msg)) {
    if (part?.type !== 'file' || typeof part.url !== 'string' || !part.url || seen.has(part.url)) continue;
    seen.add(part.url);
    const file = { type: 'file', mime: part.mime || 'application/octet-stream', filename: part.filename || 'attachment', url: part.url };
    if (part.source && typeof part.source === 'object') file.source = part.source;
    files.push(file);
  }
  // A resource that is also there as a file part (it was sent, not read) is not listed twice.
  const resources = resourceReadsOf(msg).filter((ref) => !seen.has(ref.uri));
  return { text, files, resources, replayable: !!text || files.length > 0 };
}

/** A file:// URL back to the path it names; '' for anything else. */
export function pathOfFileUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return '';
  try { return decodeURIComponent(new URL(url).pathname); } catch { return ''; }
}

// ── Session selections (model, agent, variant) ──────────────────────────────

/**
 * True when `info` is a whole Session. The session menu and the saved tabs hold
 * list rows (id, title, directory, counts), which carry no model or agent.
 */
export function hasSessionDetail(info) {
  return !!info && typeof info === 'object' && typeof info.version === 'string';
}

/**
 * What the session last ran with: `{ model, variant, agent }`, each null when
 * unknown. OpenCode records the variant as "default" when a turn named none
 * (seen on 1.18.34), which is no variant.
 */
export function sessionSelections(info) {
  const model = info?.model;
  const providerID = typeof model?.providerID === 'string' ? model.providerID : '';
  const modelID = typeof model?.id === 'string' ? model.id : (typeof model?.modelID === 'string' ? model.modelID : '');
  const variant = providerID && modelID && typeof model.variant === 'string' ? model.variant : '';
  return {
    model: providerID && modelID ? { providerID, modelID } : null,
    variant: variant && variant !== 'default' ? variant : null,
    agent: typeof info?.agent === 'string' && info.agent ? info.agent : null,
  };
}

/** The user message that started the turn `messageId` belongs to. */
export function turnStartFor(state, messageId) {
  const msg = state.messages.get(messageId);
  if (!msg) return '';
  if ((msg.role || 'assistant') === 'user') return isServerMessage(messageId) ? messageId : '';
  const parent = msg.info?.parentID;
  if (parent && state.messages.has(parent)) return parent;
  const order = state.messageOrder;
  for (let i = order.indexOf(messageId) - 1; i >= 0; i--) {
    const candidate = state.messages.get(order[i]);
    if (candidate && (candidate.role || 'assistant') === 'user' && isServerMessage(order[i])) return order[i];
  }
  return '';
}

/** The newest user message the server knows about (what /undo reverts to). */
export function lastUserMessageId(state) {
  const order = visibleMessageOrder(state.messageOrder, state.sessionInfo?.revert);
  for (let i = order.length - 1; i >= 0; i--) {
    const msg = state.messages.get(order[i]);
    if (msg && (msg.role || 'assistant') === 'user' && isServerMessage(order[i])) return order[i];
  }
  return '';
}

/**
 * Action ids a message offers, in display order. `supports(type)` is the
 * capability check; `canOpenSessions` is false in a sub-agent panel.
 *   user:      copy, undo (revert to here + text back in the composer), fork, delete
 *   assistant: copy, retry (revert to the turn's prompt and send it again)
 */
export function messageActionsFor(msg, state, { supports = () => false, canOpenSessions = true, canCompose = true } = {}) {
  if (!msg) return [];
  const role = msg.role || 'assistant';
  const actions = [];
  if (messageText(msg)) actions.push('copy');
  if (!isServerMessage(msg.id) || state.parentSessionId) return actions;
  const idle = !state.running;
  if (role === 'user') {
    if (idle && canCompose && supports('session:revert')) actions.push('undo');
    if (canOpenSessions && supports('session:fork')) actions.push('fork');
    if (idle && supports('message:delete')) actions.push('delete');
  } else if (idle && canCompose && supports('session:revert') && turnStartFor(state, msg.id)) {
    actions.push('retry');
  }
  return actions;
}

// ── Session menu ────────────────────────────────────────────────────────────

/**
 * Rows for the session menu: sub-agent sessions are left out (they open from
 * their parent), newest first. `search` filters here too, for a server that
 * does not filter itself.
 */
export function menuSessions(sessions, { search = '' } = {}) {
  const needle = String(search || '').trim().toLowerCase();
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && (s.id || s.sessionID) && !(s.parentID || s.parentId || s.parent_id))
    .filter((s) => {
      if (!needle) return true;
      return [s.title, s.slug, s.directory].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
    })
    .sort((a, b) => (b?.time?.updated || b?.time?.created || 0) - (a?.time?.updated || a?.time?.created || 0));
}

const sameDirectory = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/**
 * An untouched session to reuse instead of creating one more: the newest root
 * session of this project with no messages. Opening the panel without a tab to
 * restore used to create a fresh empty session every time.
 */
export function pickReusableEmptySession(sessions, cwd, { excludeIds = [] } = {}) {
  if (!cwd) return null;
  const skip = new Set(excludeIds);
  return menuSessions(sessions).find((s) => (
    (s.messageCount || 0) === 0 && !s.time?.archived && !skip.has(s.id) && sameDirectory(s.directory, cwd)
  )) || null;
}

// ── Share ───────────────────────────────────────────────────────────────────

/** What the menu offers for sharing. `policy` is OpenCode's `share` setting. */
export function shareView(sessionInfo, policy, supports = () => false) {
  const url = typeof sessionInfo?.share?.url === 'string' ? sessionInfo.share.url : '';
  const available = supports('session:share') && supports('session:unshare') && policy !== 'disabled';
  return {
    url,
    canShare: available && !url && !!sessionInfo?.id,
    canUnshare: available && !!url,
    // A link that exists stays visible even when sharing has since been disabled.
    showLink: !!url,
  };
}

export const SHARE_CONFIRM_TEXT = 'Share this session?\n\nThe whole transcript (your prompts, the replies, tool output and file contents the model read) is uploaded to OpenCode and published at a public URL. Anyone with the link can read it until you stop sharing.';

// ── Sharing that was stopped ────────────────────────────────────────────────
// On unshare OpenCode (1.18.34) removes the share and its public page, but the
// link stays in the session row: the row update skips an absent `share`, so
// `share_url` is never cleared. Every later read of that session says it is
// shared again: session:get, the session list, the reply to the unshare
// itself, and each session.updated that is built from the stored row. So the
// panel remembers the link it stopped, and that link is no share wherever
// session info is read (the store, the session menu, the tab cache).

export const STOPPED_SHARES_MAX = 200;

/**
 *   stop(sessionId, url)       sharing of this link was stopped (the unshare
 *                              was answered ok)
 *   resume(sessionId)          the session was shared again from the panel, or
 *                              is gone
 *   isStopped(sessionId, url)  `url` is the link that was stopped
 *   clean(info)                session info with a stopped link taken out
 *                              (`share: undefined`, so a merge clears it);
 *                              `info` itself when there is nothing to take out.
 *                              A session that reports another link was shared
 *                              again somewhere else: that one is real.
 * `load()` → `{ sessionId: url }` and `save(entries)` keep it across a reload.
 * The oldest entries go first once there are more than `max`.
 */
export function createStoppedShares({ load = () => null, save = () => {}, max = STOPPED_SHARES_MAX } = {}) {
  const stopped = new Map();        // sessionId → the link that was stopped
  try {
    const saved = load();
    for (const [id, url] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
      if (id && typeof url === 'string' && url) stopped.set(id, url);
    }
  } catch { /* nothing saved, or not readable: nothing is hidden */ }
  const persist = () => { try { save(Object.fromEntries(stopped)); } catch { /* kept in memory */ } };
  const idOf = (info) => String(info?.id || info?.sessionID || '');
  const resume = (sessionId) => {
    if (!stopped.delete(String(sessionId || ''))) return false;
    persist();
    return true;
  };
  return {
    stop(sessionId, url) {
      const id = String(sessionId || '');
      if (!id || typeof url !== 'string' || !url) return false;
      stopped.delete(id);
      stopped.set(id, url);
      while (stopped.size > max) stopped.delete(stopped.keys().next().value);
      persist();
      return true;
    },
    resume,
    isStopped: (sessionId, url) => !!url && stopped.get(String(sessionId || '')) === url,
    clean(info) {
      const id = idOf(info);
      const url = info?.share?.url;
      if (!id || typeof url !== 'string' || !url || !stopped.has(id)) return info;
      if (stopped.get(id) !== url) { resume(id); return info; }
      return { ...info, share: undefined };
    },
    size: () => stopped.size,
  };
}

// ── Deleting a message ──────────────────────────────────────────────────────

/** The question before a message is deleted: which one, and that it is final. */
export function deleteMessageConfirmText(msg) {
  const text = messageText(msg).replace(/\s+/g, ' ').trim();
  const excerpt = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return `Delete ${excerpt ? `the message “${excerpt}”` : 'this message'} from the session? This cannot be undone.`;
}

// ── Renames that are waiting for their answer ───────────────────────────────

/**
 * A rename marks its title as the panel's own before its request leaves (so
 * no generated title lands over it meanwhile). Until the server has answered,
 * that title is not the session's: while `isPending(sessionId)` the panel
 * neither shows it as the session's title nor pushes it again.
 *   begin(sessionId, title, before)  → the rename; `before` is the title state
 *                                      it found (`{ state, title }` or null)
 *   end(rename, ok)                  → false when it was already answered or
 *                                      its session's tab is gone (`forget`)
 * A refused rename (`ok` false) puts `rename.before` back, unless a newer
 * rename wrote its own title over it meanwhile. That newer rename found the
 * refused title as its `before`: it is given the refused one's `before`
 * instead, so that its own refusal does not bring a refused title back.
 */
export function createPendingRenames() {
  const bySession = new Map();   // sessionId → [rename], oldest first
  return {
    begin(sessionId, title, before = null) {
      const rename = { sessionId: String(sessionId || ''), title: String(title || ''), before };
      if (rename.sessionId) bySession.set(rename.sessionId, [...(bySession.get(rename.sessionId) || []), rename]);
      return rename;
    },
    isPending: (sessionId) => bySession.has(String(sessionId || '')),
    end(rename, ok) {
      const list = bySession.get(rename?.sessionId) || [];
      const at = list.indexOf(rename);
      if (at === -1) return false;
      const rest = list.filter((entry) => entry !== rename);
      if (rest.length) bySession.set(rename.sessionId, rest);
      else bySession.delete(rename.sessionId);
      if (!ok) {
        for (const later of list.slice(at + 1)) {
          if (later.before?.state === 'manual' && later.before.title === rename.title) later.before = rename.before;
        }
      }
      return true;
    },
    /** The session's tab is gone: nothing of it is pending any more. */
    forget(sessionId) { bySession.delete(String(sessionId || '')); },
  };
}

// ── Export ──────────────────────────────────────────────────────────────────

/** A transcript as a JSON file: `{ filename, json }`. Image data URLs are kept out. */
export function exportTranscript(sessionInfo, items, now = new Date()) {
  const messages = (Array.isArray(items) ? items : []).map((item) => ({
    info: item?.info || null,
    parts: (item?.parts || []).map((part) => (
      typeof part?.url === 'string' && part.url.startsWith('data:')
        ? { ...part, url: `data:${part.mime || 'application/octet-stream'};base64,[omitted ${part.url.length} chars]` }
        : part
    )),
  }));
  const slug = String(sessionInfo?.slug || sessionInfo?.title || sessionInfo?.id || 'session')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
  return {
    filename: `opencode-${slug}-${now.toISOString().slice(0, 10)}.json`,
    json: JSON.stringify({
      exportedAt: now.toISOString(),
      source: 'SynaBun OpenCode panel',
      session: sessionInfo || null,
      messages,
    }, null, 2),
  };
}
