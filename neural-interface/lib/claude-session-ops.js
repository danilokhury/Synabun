// ── Session management for the Claude sidepanel ──
// Rename, tag, fork, delete and subagent transcripts go through the Agent SDK's
// own session functions, so what the panel does is what `claude --resume` and
// other hosts see. The SDK is injected (tests pass fakes; the server lets the
// default load it on first use).

import { resolve } from 'node:path';
import { historyRowsFromEntry } from './claude-history.js';
import { cleanupFailures } from './claude-session-cleanup.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export class SessionOpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let _sdk = null;
async function loadSdk() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk');
  return _sdk;
}

/**
 * @param o.sdk         the SDK's session functions (default: the installed SDK, loaded on first use)
 * @param o.projects    () => [{ path }] the registered projects
 * @param o.isBusy      (sessionId) => string|'' why the session cannot be deleted now (a live tab, a lock)
 * @param o.afterDelete (sessionId) => report, drop the host's own records of it ({ name: 'ok' | 'failed: …' })
 * @param o.parentOf    async (sessionId, messageId, project) => the message that one follows in the
 *                      transcript ('' = it is the first, null = unknown); used by fork "from here"
 */
export function createSessionOps(o = {}) {
  const sdk = async () => o.sdk || loadSdk();
  const dirOf = (project) => {
    if (!project) return undefined;
    const wanted = resolve(String(project));
    const known = (o.projects?.() || []).some(p => p?.path && resolve(p.path) === wanted);
    if (!known) throw new SessionOpError(400, 'Not a registered project');
    return wanted;
  };
  const idOf = (id) => {
    if (!SESSION_ID.test(String(id || ''))) throw new SessionOpError(400, 'Not a session id');
    return String(id);
  };
  const opts = (project) => { const dir = dirOf(project); return dir ? { dir } : {}; };

  return {
    /** Write the session's title where the CLI reads it. */
    async rename(sessionId, title, project) {
      const id = idOf(sessionId);
      const text = String(title || '').trim().slice(0, 200);
      if (!text) throw new SessionOpError(400, 'A title is required');
      await (await sdk()).renameSession(id, text, opts(project));
      return { ok: true, sessionId: id, title: text };
    },

    async tag(sessionId, tag, project) {
      const id = idOf(sessionId);
      const value = tag == null || String(tag).trim() === '' ? null : String(tag).trim().slice(0, 60);
      await (await sdk()).tagSession(id, value, opts(project));
      return { ok: true, sessionId: id, tag: value };
    },

    /** A copy of the session, whole or up to one message, as a new session. */
    async fork(sessionId, { upToMessageId = '', beforeMessageId = '', title = '', project = '' } = {}) {
      const id = idOf(sessionId);
      const forkOpts = { ...opts(project) };
      if (upToMessageId) {
        if (!SESSION_ID.test(String(upToMessageId))) throw new SessionOpError(400, 'Not a message id');
        forkOpts.upToMessageId = String(upToMessageId);
      }
      // "Fork from here" names the prompt the copy stops before. Where it ends is
      // read from the transcript: the entry that prompt follows, which can be a
      // tool result or a structured-output attachment the page shows no row for.
      // When the transcript cannot say, the fork is refused: the page's own guess
      // (upToMessageId, an earlier rendered row) would cut the retained turn
      // short. That guess is used only by a host that wired no transcript lookup.
      if (beforeMessageId) {
        if (!SESSION_ID.test(String(beforeMessageId))) throw new SessionOpError(400, 'Not a message id');
        const authoritative = typeof o.parentOf === 'function';
        let parent = null;
        if (authoritative) {
          try { parent = await o.parentOf(id, String(beforeMessageId), forkOpts.dir || ''); } catch { parent = null; }
        }
        if (parent === '') throw new SessionOpError(400, 'Nothing comes before that message: fork the whole session instead.');
        if (parent) {
          if (!SESSION_ID.test(parent)) throw new SessionOpError(500, 'The transcript returned an unusable message id');
          forkOpts.upToMessageId = parent;
        } else if (authoritative || !forkOpts.upToMessageId) {
          throw new SessionOpError(409, 'That message is not in the transcript yet.');
        }
      }
      const name = String(title || '').trim().slice(0, 200);
      if (name) forkOpts.title = name;
      const result = await (await sdk()).forkSession(id, forkOpts);
      if (!result?.sessionId) throw new SessionOpError(500, 'The fork did not return a session');
      return { ok: true, sessionId: result.sessionId, forkedFrom: id };
    },

    /** Remove the transcript and its subagent transcripts. Irreversible: the caller confirmed. */
    async remove(sessionId, project) {
      const id = idOf(sessionId);
      const busy = o.isBusy?.(id) || '';
      if (busy) throw new SessionOpError(409, busy);
      await (await sdk()).deleteSession(id, opts(project));
      // The transcript is gone and that cannot be undone. What the host could
      // not drop of its own records is said, not counted as success.
      let cleanup = null;
      try { cleanup = o.afterDelete?.(id); } catch (err) { cleanup = { cleanup: `failed: ${err?.message || err}` }; }
      const out = { ok: true, sessionId: id };
      if (cleanup && typeof cleanup === 'object' && Object.keys(cleanup).length) {
        out.cleanup = cleanup;
        const failed = cleanupFailures(cleanup);
        if (failed.length) {
          out.cleanupFailed = failed;
          out.warning = `The session was deleted, but SynaBun could not drop all of its own records of it (${failed.join(', ')}). They are harmless leftovers; the server log has the cause.`;
        }
      }
      return out;
    },

    async subagents(sessionId, project) {
      const id = idOf(sessionId);
      const agents = await (await sdk()).listSubagents(id, opts(project));
      return { ok: true, agents: (Array.isArray(agents) ? agents : []).filter(a => AGENT_ID.test(String(a))).slice(0, 200) };
    },

    /** One subagent's transcript, as the same rows the session history uses. */
    async subagentMessages(sessionId, agentId, project) {
      const id = idOf(sessionId);
      if (!AGENT_ID.test(String(agentId || ''))) throw new SessionOpError(400, 'Not an agent id');
      const messages = await (await sdk()).getSubagentMessages(id, String(agentId), { ...opts(project), limit: 400 });
      const rows = [];
      for (const m of Array.isArray(messages) ? messages : []) {
        for (const row of historyRowsFromEntry({ type: m?.type, message: m?.message, uuid: m?.uuid }).rows) rows.push(row);
      }
      return { ok: true, messages: rows };
    },
  };
}
