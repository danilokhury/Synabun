// ═══════════════════════════════════════════
// SynaBun — the Maritaca side panel's server end (/ws/maritaca)
// ═══════════════════════════════════════════
//
// One socket per panel window; no process (Maritaca is an HTTP API: lib/maritaca/client.js), so a
// turn is one streamed chat completion over the conversation's saved history (lib/maritaca/sessions.js).
// The page asks with `{ type, reqId, ... }` and gets `{ type: 'result', reqId, ok, data | error, code }`;
// what happens on its own comes as events:
//
//   turn:start      { sessionId, turnId, model, mode }
//   turn:delta      { sessionId, turnId, text }           answer text as it streams
//   turn:reasoning  { sessionId, turnId, text }           reasoning text (S5, Sabiá 4 Thinking)
//   turn:end        { sessionId, turnId, text, reasoning, usage, costBrl, finishReason, mode, error?, code? }
//   settings:changed { status }                           the key or the defaults changed (any window)
//
// The hello carries the shipped model table whole (lib/maritaca/models.js rows), so the page can draw its pickers at
// once; `models` asks the API for the current list, merged over that table.
// Requests: hello, models, session:new, session:list, session:load, session:rename, session:delete, session:project,
// prompt, regenerate, cancel. `prompt` / `regenerate` take `mode: 'chat' | 'plan'` (lib/maritaca/modes.js: a plan turn
// carries the plan instruction after the user's system prompt and is saved as a plan; capability 'plan-mode') and a
// reasoning level, an alias of one included (models.js normalizeMaritacaEffort). The key is never on this socket: it is saved, tested and cleared through
// /api/maritaca/settings (lib/maritaca/api.js) and read here per prompt from the key store, so a key
// saved while a panel is open is used by its next prompt. `capabilities` in the hello answer lists
// what this server does; the page offers a feature only while it is listed (public/ reloads at any
// time, lib/ only with a restart). Nothing the page sends is trusted: ids are SynaBun's own 32-hex
// ids, text is bounded, a model is one the table or the API's list knows (the ids of the last `models` answer that
// came from the API are kept for that; else the saved default).

import { MARITACA_SESSION_LIMITS, historyForRequest, isSessionId } from './sessions.js';
import { findMaritacaModel, maritacaModelRows, maritacaUsageCostBrl, normalizeMaritacaEffort } from './models.js';
import { inlineMaritacaAttachments, MARITACA_ATTACHMENT_LIMITS } from './attachments.js';
import { maritacaSystemPrompt, normalizeMaritacaMode } from './modes.js';

export const MARITACA_WS_PATH = '/ws/maritaca';
export const MARITACA_PANEL_CAPABILITIES = Object.freeze([
  'session-new', 'session-list', 'session-load', 'session-rename', 'session-delete', 'prompt', 'cancel', 'models',
  'reasoning', 'reasoning-effort', 'usage', 'cost-brl', 'system-prompt', 'greeting-note',
  'attachments', 'regenerate', 'edit-resend', 'session-project', 'plan-mode', 'effort-levels',
]);
export const MARITACA_LIMITS = Object.freeze({
  maxPromptChars: MARITACA_SESSION_LIMITS.maxMessageChars,
  maxTitleChars: MARITACA_SESSION_LIMITS.maxTitleChars,
  maxProjectChars: 1000,
  attachments: MARITACA_ATTACHMENT_LIMITS,
});
const REQ_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

function bridgeError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * @param {object} deps
 * @param {object} deps.client      lib/maritaca/client.js
 * @param {object} deps.keyStore    lib/maritaca/key-store.js
 * @param {object} deps.sessions    lib/maritaca/sessions.js
 * @param {(info:{ sessionId:string, project:string|null, words:string })=>void} [deps.onHumanPrompt]
 * @param {(line:string)=>void} [deps.log]
 */
export function createMaritacaPanelBridge({ client, keyStore, sessions, onHumanPrompt = null, log = () => {} } = {}) {
  if (!client || !keyStore || !sessions) throw new Error('createMaritacaPanelBridge needs client, keyStore and sessions');
  const live = new Set();           // socket states
  const turns = new Map();          // sessionId → { turnId, controller, socket }
  let liveModelIds = new Map();     // lower-cased id → id as the API listed it (the last live `models` answer)
  let liveModelRows = new Map();
  let turnSeq = 0;

  function broadcast(message) { for (const state of live) state.send(message); }

  function resolveModel(requested) {
    const settings = keyStore.readSettings();
    const row = findMaritacaModel(requested);
    if (row) return row.id;
    const wanted = str(requested, 80).trim();
    const live = wanted ? liveModelIds.get(wanted.toLowerCase()) : null;
    if (live) return live;
    const fallback = findMaritacaModel(settings.model);
    return fallback ? fallback.id : settings.model;
  }

  async function runTurn(state, { sessionId, text, model, reasoningEffort, mode: requestedMode, attachments = [], messageIndex = null, editText }) {
    const session = sessions.get(sessionId);
    if (!session) throw bridgeError('SESSION_UNKNOWN', 'That conversation no longer exists.', 404);
    if (turns.has(sessionId)) throw bridgeError('TURN_RUNNING', 'A reply is already streaming in this conversation.', 409);
    const key = keyStore.readKey();
    if (!key) throw bridgeError('NO_KEY', 'Save a Maritaca API key first.', 412);
    const chosen = resolveModel(model || session.model);
    const settings = keyStore.readSettings();
    const row = findMaritacaModel(chosen) || liveModelRows.get(chosen.toLowerCase());
    const asked = normalizeMaritacaEffort(reasoningEffort);
    const saved = normalizeMaritacaEffort(settings.reasoningEffort);
    const effort = asked && row?.efforts?.includes(asked) ? asked : saved && row?.efforts?.includes(saved) ? saved : null;
    // A regenerate or an edit that names no mode keeps the mode of the prompt it reruns (a plan is regenerated as a plan).
    const mode = requestedMode !== undefined ? normalizeMaritacaMode(requestedMode) : messageIndex !== null ? normalizeMaritacaMode(session.messages[messageIndex]?.mode) : 'chat';
    if (messageIndex !== null) {
      if (!Number.isInteger(messageIndex) || session.messages[messageIndex]?.role !== 'user') throw bridgeError('PROMPT_UNKNOWN', 'Choose a user message to retry.');
      if (session.messages.slice(0, messageIndex + 1).some((m) => m.images?.length) && row?.vision !== true) throw bridgeError('IMAGE_UNSUPPORTED', 'This model does not read images.');
      sessions.rewind(sessionId, messageIndex, editText, { mode });
    } else {
      if (session.messages.some((m) => m.images?.length) && row?.vision !== true) throw bridgeError('IMAGE_UNSUPPORTED', 'This model does not read images.');
      const prompt = inlineMaritacaAttachments(text, attachments, { vision: row?.vision === true });
      sessions.append(sessionId, { role: 'user', ...prompt, mode });
    }
    if (session.model !== chosen) sessions.update(sessionId, { model: chosen });
    const history = historyForRequest(sessions.get(sessionId).messages, { systemPrompt: maritacaSystemPrompt({ systemPrompt: settings.systemPrompt, mode }) });
    const turnId = `t${Date.now().toString(36)}-${++turnSeq}`;
    const controller = new AbortController();
    const snapshot = sessions.get(sessionId);
    const turn = { turnId, controller, socket: state, sessionId, model: chosen, mode, startedAt: Date.now(), partialText: '', partialReasoning: '' };
    turns.set(sessionId, turn);
    try { onHumanPrompt?.({ sessionId, project: session.project || null, words: text }); } catch { /* the greeting's problem */ }
    broadcast({ type: 'turn:start', sessionId, turnId, model: chosen, mode, startedAt: turn.startedAt, session: snapshot });
    (async () => {
      let result = null;
      let failure = null;
      try {
        result = await client.chatStream({
          key, model: chosen, messages: history, reasoningEffort: effort, temperature: settings.temperature, signal: controller.signal,
          onEvent: (event) => {
            // Kept here too: the client's chatStream rejects on a stop or a failure without handing back what streamed.
            if (event.type === 'delta') { const offset = turn.partialText.length; turn.partialText += event.text || ''; broadcast({ type: 'turn:delta', sessionId, turnId, text: event.text, offset }); }
            else if (event.type === 'reasoning') { const offset = turn.partialReasoning.length; turn.partialReasoning += event.text || ''; broadcast({ type: 'turn:reasoning', sessionId, turnId, text: event.text, offset }); }
          },
          partial: null,
        });
      } catch (error) {
        failure = error;
      }
      turns.delete(sessionId);
      const cancelled = controller.signal.aborted;
      const text = result?.text || turn.partialText || '';
      const reasoning = result?.reasoning || turn.partialReasoning || '';
      const usage = result?.usage || null;
      const costBrl = usage ? maritacaUsageCostBrl(chosen, usage) : null;
      const finishReason = cancelled ? 'cancelled' : failure ? 'error' : result?.finishReason || 'stop';
      const errorMessage = failure && !cancelled ? failure.message : null;
      const code = failure && !cancelled ? failure.code || 'HTTP_ERROR' : null;
      // The reply is saved whatever happened: a stop keeps what streamed (finishReason 'cancelled'); a failure leaves what
      // streamed, or an empty assistant row, with its error, so the conversation shows what went wrong when it is opened again.
      try { sessions.append(sessionId, { role: 'assistant', turnId, content: text, reasoning, usage, costBrl, model: chosen, finishReason, error: errorMessage, mode }); }
      catch (error) { log(`[maritaca] could not save a reply: ${error?.message || error}`); }
      if (failure && !cancelled) log(`[maritaca] turn failed: ${code} ${failure.message}`);
      let saved = null;
      try { saved = sessions.get(sessionId); } catch { /* completion still reaches the page after a storage failure */ }
      broadcast({ type: 'turn:end', sessionId, turnId, text, reasoning, usage, costBrl, finishReason, mode, ...(saved ? { messageCount: saved.messages.length, priorCostBrl: saved.priorCostBrl || 0 } : {}), ...(errorMessage ? { error: errorMessage, code } : {}) });
    })();
    return { turnId, model: chosen, reasoningEffort: effort, mode, session: snapshot };
  }

  function removeSession(sessionId) {
    if (!isSessionId(sessionId)) throw bridgeError('SESSION_INVALID', 'Unknown conversation.');
    turns.get(sessionId)?.controller.abort(new Error('deleted'));
    const deleted = sessions.remove(sessionId);
    broadcast({ type: 'session:deleted', sessionId });
    return { deleted };
  }

  function renameSession(sessionId, title) {
    if (!isSessionId(sessionId)) throw bridgeError('SESSION_INVALID', 'Unknown conversation.');
    const session = sessions.update(sessionId, { title: str(title, MARITACA_LIMITS.maxTitleChars) });
    if (!session) throw bridgeError('SESSION_UNKNOWN', 'That conversation no longer exists.', 404);
    broadcast({ type: 'session:renamed', sessionId, title: session.title });
    return { session: { id: session.id, title: session.title } };
  }

  const handlers = {
    async hello() {
      const status = keyStore.status();
      return { capabilities: [...MARITACA_PANEL_CAPABILITIES], limits: { ...MARITACA_LIMITS }, configured: status.configured, source: status.source, masked: status.masked, settings: status.settings, models: maritacaModelRows() };
    },
    async models() {
      const listed = await client.listModels({ key: keyStore.readKey() });
      if (listed.source === 'live' && Array.isArray(listed.models)) {
        liveModelIds = new Map(listed.models.filter((m) => typeof m?.id === 'string' && m.id.trim()).map((m) => [m.id.trim().toLowerCase(), m.id.trim().slice(0, 80)]));
        liveModelRows = new Map(listed.models.filter((m) => typeof m?.id === 'string').map((m) => [m.id.toLowerCase(), m]));
      }
      return { models: listed.models, source: listed.source, ...(listed.error ? { error: listed.error } : {}) };
    },
    async 'session:new'(msg) {
      const session = sessions.create({ title: str(msg.title, MARITACA_LIMITS.maxTitleChars), model: resolveModel(msg.model), project: str(msg.project, MARITACA_LIMITS.maxProjectChars) || null });
      return { session };
    },
    async 'session:list'(msg) {
      return { sessions: sessions.list({ project: str(msg.project, MARITACA_LIMITS.maxProjectChars) || null, limit: msg.limit }) };
    },
    async 'session:load'(msg) {
      if (!isSessionId(msg.sessionId)) throw bridgeError('SESSION_INVALID', 'Unknown conversation.');
      const session = sessions.get(msg.sessionId);
      if (!session) throw bridgeError('SESSION_UNKNOWN', 'That conversation no longer exists.', 404);
      const turn = turns.get(session.id);
      return { session, running: turn?.turnId || null, partial: turn ? { turnId: turn.turnId, text: turn.partialText, reasoning: turn.partialReasoning, startedAt: turn.startedAt, model: turn.model, mode: turn.mode } : null };
    },
    async 'session:rename'(msg) {
      return renameSession(msg.sessionId, msg.title);
    },
    async 'session:delete'(msg) {
      return removeSession(msg.sessionId);
    },
    async 'session:project'(msg) {
      if (!isSessionId(msg.sessionId)) throw bridgeError('SESSION_INVALID', 'Unknown conversation.');
      const session = sessions.update(msg.sessionId, { project: str(msg.project, MARITACA_LIMITS.maxProjectChars) || null });
      if (!session) throw bridgeError('SESSION_UNKNOWN', 'That conversation no longer exists.', 404);
      return { session: { id: session.id, project: session.project } };
    },
    async prompt(msg, state) {
      if (!isSessionId(msg.sessionId)) throw bridgeError('SESSION_INVALID', 'Unknown conversation.');
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text.trim() && !msg.attachments?.length) throw bridgeError('PROMPT_EMPTY', 'Type something first.');
      if (text.length > MARITACA_LIMITS.maxPromptChars) throw bridgeError('PROMPT_TOO_LONG', `The message is longer than ${MARITACA_LIMITS.maxPromptChars} characters.`);
      return runTurn(state, { sessionId: msg.sessionId, text, attachments: msg.attachments ?? [], model: str(msg.model, 80), reasoningEffort: str(msg.reasoningEffort, 20), mode: msg.mode === undefined ? 'chat' : str(msg.mode, 10) });
    },
    async regenerate(msg, state) {
      if (!isSessionId(msg.sessionId)) throw bridgeError('SESSION_INVALID', 'Unknown conversation.');
      const session = sessions.get(msg.sessionId);
      if (!session) throw bridgeError('SESSION_UNKNOWN', 'That conversation no longer exists.', 404);
      const messageIndex = msg.messageIndex === undefined ? session.messages.findLastIndex((m) => m.role === 'user') : msg.messageIndex;
      if (!Number.isInteger(messageIndex) || session.messages[messageIndex]?.role !== 'user') throw bridgeError('PROMPT_UNKNOWN', 'Choose a user message to retry.');
      if (msg.text !== undefined && (typeof msg.text !== 'string' || !msg.text.trim())) throw bridgeError('PROMPT_EMPTY', 'Type something first.');
      if (typeof msg.text === 'string' && msg.text.length > MARITACA_LIMITS.maxPromptChars) throw bridgeError('PROMPT_TOO_LONG', 'The message is too long.');
      return runTurn(state, { sessionId: msg.sessionId, text: msg.text ?? '', editText: msg.text, messageIndex, model: str(msg.model, 80), reasoningEffort: str(msg.reasoningEffort, 20), mode: msg.mode === undefined ? undefined : str(msg.mode, 10) });
    },
    async cancel(msg) {
      if (!isSessionId(msg.sessionId)) throw bridgeError('SESSION_INVALID', 'Unknown conversation.');
      const running = turns.get(msg.sessionId);
      if (!running) return { cancelled: false };
      running.controller.abort(new Error('cancelled'));
      return { cancelled: true, turnId: running.turnId };
    },
  };

  function handleSocket(ws) {
    let closed = false;
    const state = {
      send(message) {
        if (closed || ws.readyState !== 1) return;
        try { ws.send(JSON.stringify(message)); } catch { /* the close handler cleans up */ }
      },
    };
    live.add(state);
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { state.send({ type: 'result', reqId: null, ok: false, code: 'BAD_JSON', error: 'Not JSON.' }); return; }
      const reqId = REQ_ID_RE.test(String(msg?.reqId || '')) ? String(msg.reqId) : null;
      const type = typeof msg?.type === 'string' ? msg.type : '';
      const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
      if (!handler) { state.send({ type: 'result', reqId, ok: false, code: 'UNKNOWN_REQUEST', error: `Unknown request: ${type || '?'}` }); return; }
      try {
        const data = await handler(msg, state);
        state.send({ type: 'result', reqId, ok: true, data });
      } catch (error) {
        state.send({ type: 'result', reqId, ok: false, code: error?.code || 'ERROR', error: error?.message || 'Something went wrong.' });
      }
    });
    const end = () => { closed = true; live.delete(state); };
    ws.on('close', end);
    ws.on('error', end);
  }

  return {
    handleSocket,
    liveCount: () => live.size,
    turnsRunning: () => turns.size,
    removeSession,
    renameSession,
    /** The key or the defaults changed (the REST router says so): every open panel is told. */
    notifySettingsChanged: () => broadcast({ type: 'settings:changed', status: keyStore.status() }),
    closeAll: async () => {
      for (const turn of turns.values()) turn.controller.abort(new Error('shutdown'));
      turns.clear();
      live.clear();
    },
    _handlers: handlers,
  };
}
