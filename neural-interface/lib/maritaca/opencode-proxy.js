// ═══════════════════════════════════════════
// SynaBun — Maritaca for OpenCode: the way OpenCode's requests reach Maritaca
// ═══════════════════════════════════════════
//
//   POST /api/maritaca/opencode/v1/chat/completions
//
// The provider block SynaBun writes into opencode.json (lib/maritaca/opencode.js) points OpenCode's OpenAI-compatible
// package here instead of at https://chat.maritaca.ai/api: OpenCode 2 refuses Maritaca's stream on the first tool call
// ("OpenAI Chat received content after the finish reason", lib/maritaca/opencode-stream.js says why), and no option of
// OpenCode tolerates it. This route sends the request on to Maritaca and hands the answer back with the stream put in
// the order OpenCode reads (the finish reason last, each tool call whole), the reasoning OpenCode echoes on assistant
// messages left out of the request. Everything else goes through as it is: an error of Maritaca's with its status and
// body, an answer that is not a stream untouched.
//
// Who may call it: a request on the loopback interface (requireLocal), past the owner's route guard and SynaBun's
// gates, that presents the Maritaca key SynaBun has saved (`Authorization: Bearer <key>`, which OpenCode sends from
// the `{file:…}` / `{env:…}` reference the block holds). So the route gives nobody anything they did not have: a
// caller that can use it already holds the key. The key is compared by digest in constant time, sent to Maritaca in
// the header of the one request, never logged, never part of an answer. On macOS the peer gate knows OpenCode's serve
// as an agent's process tree, and this path is one of the few an agent's tree may call without a pin
// (lib/owner-authority.js AGENT_OPEN_PREFIXES); the automation browser and relays are still refused there.
//
// A request ends when OpenCode goes away (the request to Maritaca is aborted with it), or when Maritaca sends nothing
// for `idleMs` (a timeout per pause, not a deadline: a long answer that keeps streaming is never cut). A stream that
// breaks part-way ends with an `error` chunk, which OpenCode reports as the provider's error.

import { createHash, timingSafeEqual } from 'node:crypto';
import { MARITACA_BASE_URL } from './client.js';
import { createChatStreamNormalizer, createSseLineReader, describeRepair, prepareUpstreamBody, readSseLine } from './opencode-stream.js';

export const MARITACA_OPENCODE_PROXY_PATH = '/api/maritaca/opencode/v1';
export const MARITACA_OPENCODE_PROXY_ROUTE = `${MARITACA_OPENCODE_PROXY_PATH}/chat/completions`;
/** A base URL that is SynaBun's own route (any loopback name, any port): the block points at a SynaBun server. */
export const MARITACA_OPENCODE_PROXY_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/api\/maritaca\/opencode\/v1$/;
const IDLE_MS = 120_000;
const MAX_ERROR_BODY = 64 * 1024;
const MAX_LOGGED_SHAPES = 50;

/** The base URL OpenCode is given: this server, by its loopback address, on the port it listens on. */
export function maritacaOpencodeProxyBaseUrl(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('maritacaOpencodeProxyBaseUrl needs the port SynaBun listens on');
  return `http://127.0.0.1:${n}${MARITACA_OPENCODE_PROXY_PATH}`;
}

/** The key a request presents: `Authorization: Bearer <key>` (OpenCode) or `Key <key>` (Maritaca's own form). */
export function presentedKey(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return '';
  const match = /^\s*(?:bearer|key)\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

/** Constant-time comparison of two keys (by their digests, so their lengths do not show either). */
export function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const digest = (s) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** An error in the shape OpenCode reads from an OpenAI-compatible provider ({ error: { message, code } }). */
function sendError(res, status, code, message) {
  if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
  res.status(status).json({ error: { message, type: 'synabun_maritaca_proxy', code } });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} o
 * @param {{ readKey(): string|null }} o.keyStore      lib/maritaca/key-store.js
 * @param {string} [o.upstreamBaseUrl]                   Maritaca's API (the panel client's, so SYNABUN_MARITACA_BASE_URL applies to both)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.idleMs]                            how long Maritaca may stay silent (before its answer, and between chunks)
 * @param {(line: string) => void} [o.log]               one line per new kind of repair and per failure; never a key or a value
 * @param {() => string} [o.newId]                       the id given to a tool call Maritaca sent without one (tests)
 */
export function createMaritacaOpencodeProxy({ keyStore, upstreamBaseUrl = MARITACA_BASE_URL, fetchImpl = globalThis.fetch, idleMs = IDLE_MS, log = () => {}, newId } = {}) {
  if (!keyStore || typeof keyStore.readKey !== 'function') throw new Error('createMaritacaOpencodeProxy needs keyStore');
  if (typeof fetchImpl !== 'function') throw new Error('createMaritacaOpencodeProxy needs fetch');
  const base = String(upstreamBaseUrl || MARITACA_BASE_URL).replace(/\/+$/, '');
  const stats = { requests: 0, streams: 0, repaired: 0, refused: 0, upstreamErrors: 0, active: 0, reasoningStripped: 0, lastRepair: null, lastError: null };
  const loggedShapes = new Set();

  function noteError(code, status = 0, model = '') {
    stats.lastError = { at: new Date().toISOString(), code, ...(status ? { status } : {}), ...(model ? { model } : {}) };
  }

  function noteRepair(report, model) {
    if (!report.repaired) return;
    stats.repaired += 1;
    const line = describeRepair(report, { model });
    stats.lastRepair = { at: new Date().toISOString(), model, finishReason: report.finishReason, afterFinish: { ...report.afterFinish }, shapes: [...report.shapes], line };
    // One line per kind of repair, not one per turn: the shape without the model is the kind.
    const kind = JSON.stringify([report.shapes, report.finishReasons, report.duplicateFragments > 0, report.snapshots > 0, report.conflicts > 0, report.idsAdded > 0, report.finishSynthesized]);
    if (loggedShapes.has(kind) || loggedShapes.size >= MAX_LOGGED_SHAPES) return;
    loggedShapes.add(kind);
    log(line);
  }

  async function handle(req, res) {
    stats.requests += 1;
    let key;
    try { key = keyStore.readKey(); } catch (error) {
      stats.refused += 1;
      return sendError(res, 500, error?.code || 'KEY_UNREADABLE', 'SynaBun could not read its saved Maritaca key. Save it again in the Maritaca panel (the cog).');
    }
    if (!key) { stats.refused += 1; return sendError(res, 401, 'NO_KEY', 'No Maritaca API key is saved in SynaBun. Save one in the Maritaca panel (the cog).'); }
    if (!sameKey(presentedKey(req), key)) {
      stats.refused += 1;
      return sendError(res, 401, 'KEY_MISMATCH', 'This address takes the Maritaca key SynaBun has saved. Re-sync Maritaca under Settings → OpenCode → Providers.');
    }
    const body = req.body;
    if (!isObject(body) || typeof body.model !== 'string' || !body.model.trim() || !Array.isArray(body.messages)) {
      return sendError(res, 400, 'BAD_REQUEST', 'A chat completion needs a model and messages.');
    }
    const model = body.model.trim().slice(0, 80);
    const { body: upstreamBody, strippedReasoning } = prepareUpstreamBody(body);
    stats.reasoningStripped += strippedReasoning;

    const controller = new AbortController();
    let clientGone = false;
    let timedOut = false;
    let timer = null;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(new Error('idle')); }, idleMs); timer.unref?.(); };
    const onClose = () => { if (!res.writableFinished) { clientGone = true; controller.abort(new Error('client gone')); } };
    res.on('close', onClose);
    stats.active += 1;
    arm();
    try {
      let response;
      try {
        response = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Key ${key}`, 'content-type': 'application/json', accept: upstreamBody.stream === false ? 'application/json' : 'text/event-stream' },
          body: JSON.stringify(upstreamBody),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        if (clientGone) return;
        stats.upstreamErrors += 1;
        const code = timedOut ? 'TIMEOUT' : 'UNREACHABLE';
        noteError(code, 0, model);
        log(`[maritaca] OpenCode proxy: ${code === 'TIMEOUT' ? 'Maritaca did not answer in time' : 'could not reach Maritaca'} (${model})`);
        return sendError(res, timedOut ? 504 : 502, code, timedOut ? 'Maritaca did not answer in time.' : 'Could not reach Maritaca.');
      }
      arm();
      if (!response.ok) {
        let text = '';
        try { text = (await response.text()).slice(0, MAX_ERROR_BODY); } catch { text = ''; }
        if (clientGone) return;
        stats.upstreamErrors += 1;
        noteError('UPSTREAM_STATUS', response.status, model);
        log(`[maritaca] OpenCode proxy: Maritaca answered ${response.status} (${model})`);
        res.status(response.status);
        res.setHeader('content-type', response.headers.get('content-type') || 'application/json; charset=utf-8');
        return res.send(text || JSON.stringify({ error: { message: `Maritaca answered ${response.status}.`, code: 'UPSTREAM_STATUS' } }));
      }
      const type = String(response.headers.get('content-type') || '');
      if (!/event-stream/i.test(type)) {
        // An answer that is not a stream (stream: false): one message, nothing out of order. Sent on as it is.
        let text = '';
        try { text = await response.text(); } catch {
          if (clientGone) return;
          noteError(timedOut ? 'TIMEOUT' : 'UPSTREAM_STREAM', 0, model);
          return sendError(res, timedOut ? 504 : 502, timedOut ? 'TIMEOUT' : 'UPSTREAM_STREAM', 'The answer from Maritaca broke off.');
        }
        res.status(200).setHeader('content-type', type || 'application/json; charset=utf-8');
        return res.send(text);
      }
      stats.streams += 1;
      await relayStream(response, res, { model, arm, isGone: () => clientGone, timedOut: () => timedOut });
    } finally {
      clearTimeout(timer);
      stats.active -= 1;
      res.off?.('close', onClose);
    }
  }

  async function relayStream(response, res, { model, arm, isGone, timedOut }) {
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-store, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    const normalizer = createChatStreamNormalizer(newId ? { newId } : {});
    const reader = createSseLineReader();
    let done = false;
    const send = async (text) => {
      if (isGone() || res.writableEnded) return;
      if (!res.write(text)) await new Promise((resolve) => { const go = () => { res.off('drain', go); res.off('close', go); resolve(); }; res.on('drain', go); res.on('close', go); });
    };
    const emit = async (payloads) => { for (const payload of payloads) await send(`data: ${JSON.stringify(payload)}\n\n`); };
    const take = async (line) => {
      const item = readSseLine(line);
      if (!item) return;
      if (item.kind === 'comment') return send(`${item.line}\n\n`); // a keep-alive, kept alive
      if (item.kind === 'done') { done = true; return; }
      if (item.kind === 'raw') return send(`data: ${item.data}\n\n`); // not JSON: OpenCode judges it, as it would have
      return emit(normalizer.push(item.payload));
    };
    try {
      for await (const chunk of response.body) {
        arm();
        for (const line of reader.push(chunk)) { await take(line); if (done) break; }
        if (done) break;
      }
      if (!done) for (const line of reader.end()) { await take(line); if (done) break; }
    } catch {
      if (isGone()) return;
      // The stream broke part-way (or went silent): say so as the provider's error, never as a finished answer.
      stats.upstreamErrors += 1;
      const code = timedOut() ? 'TIMEOUT' : 'UPSTREAM_STREAM';
      noteError(code, 0, model);
      log(`[maritaca] OpenCode proxy: the stream from Maritaca ${code === 'TIMEOUT' ? 'went silent' : 'broke off'} (${model})`);
      await send(`data: ${JSON.stringify({ error: { message: code === 'TIMEOUT' ? 'Maritaca stopped sending before the answer ended.' : 'The connection to Maritaca broke before the answer ended.', type: 'synabun_maritaca_proxy', code } })}\n\n`);
      res.end();
      return;
    }
    if (isGone()) return;
    await emit(normalizer.end({ done }));
    // [DONE] once the answer has its finish (said by Maritaca, or after its own [DONE]); a stream cut short without
    // either ends without it, so OpenCode reports the stream as incomplete instead of taking it as an answer.
    if (done || normalizer.finished) await send('data: [DONE]\n\n');
    res.end();
    noteRepair(normalizer.report(), model);
  }

  /** What the Settings card and a diagnosis may read: counts and the last repair's shape, never a key or a value. */
  function status() {
    return { ...stats, lastRepair: stats.lastRepair ? { ...stats.lastRepair } : null, lastError: stats.lastError ? { ...stats.lastError } : null };
  }

  return { handle, status, route: MARITACA_OPENCODE_PROXY_ROUTE };
}
