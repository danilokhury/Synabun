// ═══════════════════════════════════════════
// SynaBun — Maritaca for OpenCode: the stream and request repairs (pure)
// ═══════════════════════════════════════════
//
// OpenCode 2 (2.2.5) reads an OpenAI-compatible provider's stream with its "OpenAI Chat" protocol, which refuses a
// chunk that carries tool-call deltas (an id, a name or arguments) once an earlier chunk has carried `finish_reason`:
// "OpenAI Chat received content after the finish reason". No `compatibility` option of OpenCode turns that check off
// (requireFinishReason, streamUsage, maxTokensField… do not touch it), and every OpenAI-style package of OpenCode reads
// through the same step. Maritaca's streaming API does exactly that on a tool call: a chunk with `finish_reason`, then
// tool-call deltas. So OpenCode's requests for Maritaca go through SynaBun (lib/maritaca/opencode-proxy.js), which hands
// every chunk to the normalizer below before OpenCode sees it:
//
//   • `finish_reason` (and `native_finish_reason`) is taken off every chunk and said once, in a last chunk of its own,
//     after everything else the stream carried (text, reasoning and tool calls that came after it included). Several
//     finish reasons become one: the first, unless a later one says more than "stop".
//   • Tool-call deltas are held and folded into whole calls, sent as one chunk right before that finish: a call the
//     server repeats after the finish (the same arguments again, or the whole arguments where the pieces were partial)
//     is one call, never two and never doubled arguments; a call without an id gets one (OpenCode refuses a call without
//     an id or a name); `arguments` sent as an object are sent as JSON text; no arguments at all are "{}".
//   • Text, reasoning and usage pass through as they come (reasoning in whichever field Maritaca names it: OpenCode reads
//     reasoning_content, reasoning and reasoning_text). An `error` chunk passes untouched.
//   • A stream that ended with [DONE] but never named a finish reason gets one ("tool_calls" when it carried calls,
//     else "stop"); one that broke off without [DONE] does not, so OpenCode still says the stream was cut short.
//
// What arrived after the finish is recorded by its shape only (the names of the fields, the counts), never a value, so
// a log line can say what Maritaca sent without repeating a word of the conversation or its tool arguments.
//
// `prepareUpstreamBody` is the request side: OpenCode echoes a thinking model's reasoning back on the assistant
// messages of the history (as `reasoning_content` / `reasoning`, the field it read it from, plus OpenRouter's
// `reasoning_details`); SynaBun's own Maritaca panel never sends those, and a conversation with Sabiá 4 Thinking works
// that way, so they are left out of what reaches Maritaca. Nothing else in the request is changed.

import { randomBytes } from 'node:crypto';

/** The fields of an assistant message that carry reasoning back, taken out before a request reaches Maritaca. */
export const REASONING_ECHO_FIELDS = Object.freeze(['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details']);
const REASONING_DELTA_FIELDS = Object.freeze(['reasoning_content', 'reasoning', 'reasoning_text']);
const MAX_SHAPES = 12;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const newCallId = () => `call_${randomBytes(12).toString('hex')}`;

/** Text that parses as one whole JSON object or array (the arguments of a finished call). */
function wholeJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { const value = JSON.parse(text); return value !== null && typeof value === 'object' ? value : null; } catch { return null; }
}

/** Canonical text of a JSON value with its object keys sorted: two spellings of the same arguments compare equal. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The names (never the values) of the fields a chunk carries, as paths: `choices[].delta.tool_calls[].function.name`.
 * Bounded in depth and in count.
 */
export function shapeOf(value, prefix = '', depth = 0, out = new Set()) {
  if (out.size >= 40 || depth > 8) return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) shapeOf(item, `${prefix}[]`, depth + 1, out);
    if (!value.length) out.add(`${prefix}[]`);
    return out;
  }
  if (isObject(value)) {
    for (const key of Object.keys(value)) {
      if (value[key] === null || value[key] === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (isObject(value[key]) || Array.isArray(value[key])) shapeOf(value[key], path, depth + 1, out);
      else out.add(path);
    }
  }
  return out;
}

/** A shape as one short line: the paths sorted, the meta fields (id, object, created, model…) left out. */
export function shapeLine(chunk) {
  const meta = new Set(['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier', 'provider']);
  return [...shapeOf(chunk)].filter((p) => !meta.has(p) && !/^choices\[\]\.(index|logprobs)$/.test(p)).sort().join(', ') || '(empty)';
}

/**
 * The normalizer of one streamed chat completion. `push(chunk)` takes one parsed `data:` payload and returns the payloads
 * to send on now (zero or more, in order); `end({ done })` returns the last ones (the held tool calls, the one finish
 * chunk) once the stream is over (`done`: Maritaca sent [DONE]); `report()` says what had to be repaired.
 */
export function createChatStreamNormalizer({ newId = newCallId } = {}) {
  const meta = {}; // id, object, created, model, system_fingerprint of the latest chunk that named them
  const finishes = new Map(); // choice index → { reason, native }
  const calls = new Map(); // choice index → { list: [call], byKey: Map }
  let afterFinish = false;
  let ended = false;
  const stats = {
    finishChunks: 0, finishSynthesized: false, finishReasons: [],
    afterFinish: { chunks: 0, text: 0, reasoning: 0, toolDeltas: 0, usage: 0 },
    toolCalls: 0, toolDeltas: 0, duplicateFragments: 0, snapshots: 0, conflicts: 0, idsAdded: 0, indexesAdded: 0,
    shapes: [],
  };

  function remember(chunk) {
    for (const key of ['id', 'object', 'created', 'model', 'system_fingerprint']) {
      if (chunk[key] !== undefined && chunk[key] !== null && chunk[key] !== '') meta[key] = chunk[key];
    }
  }

  function noteFinish(index, reason, native) {
    stats.finishChunks += 1;
    if (!stats.finishReasons.includes(reason) && stats.finishReasons.length < 6) stats.finishReasons.push(reason);
    const held = finishes.get(index);
    // The first reason, unless a later one says more than "stop" (a server that says stop, then tool_calls).
    if (!held || (held.reason === 'stop' && reason !== 'stop')) finishes.set(index, { reason, native: native ?? held?.native ?? null });
  }

  function callsOf(index) {
    if (!calls.has(index)) calls.set(index, { list: [], byKey: new Map() });
    return calls.get(index);
  }

  /** One tool-call delta folded into its call. */
  function foldToolPiece(index, piece, position, pieceCount) {
    if (!isObject(piece)) return;
    stats.toolDeltas += 1;
    const group = callsOf(index);
    const id = typeof piece.id === 'string' && piece.id.trim() && piece.id !== 'null' ? piece.id.trim() : '';
    const fn = isObject(piece.function) ? piece.function : {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    // Which call: an id already seen names its call whatever the index says (a repeat under another index is the same
    // call); then the index; then, without either, a new call when the piece names a function, else the latest call.
    let call = id ? group.list.find((c) => c.id === id) : undefined;
    if (!call && Number.isInteger(piece.index)) call = group.byKey.get(`i${piece.index}`);
    if (!call && !Number.isInteger(piece.index)) {
      const latest = group.list[group.list.length - 1];
      if (pieceCount > 1) call = group.byKey.get(`p${position}`);
      else if (latest && !name) call = latest;
      else if (latest && name === latest.name && !(id && latest.id && id !== latest.id)) {
        // The latest call's name again, without an index: the same call restated (its arguments partial, or the same
        // whole arguments again), or a new call of the same function (whole, different arguments, or none yet).
        const held = wholeJson(latest.args);
        const raw = isObject(fn.arguments) || Array.isArray(fn.arguments) ? JSON.stringify(fn.arguments) : fn.arguments;
        const incoming = wholeJson(raw);
        if (!held || (incoming && canonical(incoming) === canonical(held))) call = latest;
      }
    }
    if (!call) {
      call = { id: '', name: '', args: '' };
      group.list.push(call);
      if (Number.isInteger(piece.index)) group.byKey.set(`i${piece.index}`, call);
      else { stats.indexesAdded += 1; if (pieceCount > 1) group.byKey.set(`p${position}`, call); }
    }
    if (id && !call.id) call.id = id;
    if (name && !call.name) call.name = name;
    let args = fn.arguments;
    if (isObject(args) || Array.isArray(args)) args = JSON.stringify(args);
    if (typeof args !== 'string' || !args) return;
    const held = wholeJson(call.args);
    if (held) {
      const incoming = wholeJson(args);
      if (incoming && canonical(incoming) === canonical(held)) { stats.duplicateFragments += 1; return; }
      if (incoming) { call.args = args; stats.conflicts += 1; return; } // two whole, different answers: the later one stands
      if (args.trim() === call.args.trim()) { stats.duplicateFragments += 1; return; }
      call.args += args; // a whole object cannot be continued: OpenCode will say the arguments are not JSON, as it would have
      return;
    }
    if (call.args && args.length > call.args.length && args.startsWith(call.args) && wholeJson(args)) { call.args = args; stats.snapshots += 1; return; }
    call.args += args;
  }

  function push(chunk) {
    if (ended) return [];
    if (!isObject(chunk)) return [chunk];
    if (chunk.error !== undefined && chunk.error !== null) return [chunk];
    remember(chunk);
    if (afterFinish) {
      stats.afterFinish.chunks += 1;
      if (chunk.usage) stats.afterFinish.usage += 1;
      const line = shapeLine(chunk);
      if (!stats.shapes.includes(line) && stats.shapes.length < MAX_SHAPES) stats.shapes.push(line);
    }
    if (!Array.isArray(chunk.choices)) return [chunk];
    const choices = [];
    let changed = false;
    chunk.choices.forEach((choice, position) => {
      if (!isObject(choice)) { choices.push(choice); return; }
      const index = Number.isInteger(choice.index) ? choice.index : position;
      const copy = { ...choice };
      let touched = false;
      const delta = isObject(choice.delta) ? { ...choice.delta } : null;
      if (delta) {
        if (afterFinish) {
          if (typeof delta.content === 'string' && delta.content) stats.afterFinish.text += 1;
          if (REASONING_DELTA_FIELDS.some((f) => typeof delta[f] === 'string' && delta[f])) stats.afterFinish.reasoning += 1;
        }
        if ('tool_calls' in delta) {
          const pieces = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          if (afterFinish && pieces.length) stats.afterFinish.toolDeltas += pieces.length;
          pieces.forEach((piece, i) => foldToolPiece(index, piece, i, pieces.length));
          delete delta.tool_calls;
          touched = true;
        }
        copy.delta = delta;
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        noteFinish(index, String(choice.finish_reason), choice.native_finish_reason ?? null);
        afterFinish = true;
        touched = true;
      }
      if ('finish_reason' in copy) copy.finish_reason = null;
      if ('native_finish_reason' in copy) delete copy.native_finish_reason;
      if (touched) changed = true;
      // A choice left with nothing to say once its tool calls and finish are taken off is not sent.
      const rest = Object.keys(copy).filter((k) => !['index', 'finish_reason', 'delta', 'logprobs'].includes(k) && copy[k] !== null && copy[k] !== undefined);
      const deltaSays = delta && Object.keys(delta).some((k) => delta[k] !== null && delta[k] !== undefined && delta[k] !== '');
      if (touched && !deltaSays && !rest.length && (copy.logprobs === undefined || copy.logprobs === null)) return;
      choices.push(copy);
    });
    if (!changed) return [chunk];
    const others = Object.keys(chunk).filter((k) => !['id', 'object', 'created', 'model', 'system_fingerprint', 'choices'].includes(k) && chunk[k] !== null && chunk[k] !== undefined);
    if (!choices.length && !others.length) return [];
    return [{ ...chunk, choices }];
  }

  function base() {
    return { ...(meta.id !== undefined ? { id: meta.id } : {}), object: meta.object || 'chat.completion.chunk', ...(meta.created !== undefined ? { created: meta.created } : {}), ...(meta.model !== undefined ? { model: meta.model } : {}), ...(meta.system_fingerprint !== undefined ? { system_fingerprint: meta.system_fingerprint } : {}) };
  }

  function end({ done = false } = {}) {
    if (ended) return [];
    ended = true;
    const out = [];
    const indexes = [...new Set([...calls.keys(), ...finishes.keys()])].sort((a, b) => a - b);
    const callChoices = [];
    for (const index of indexes) {
      const group = calls.get(index);
      if (!group?.list.length) continue;
      const toolCalls = group.list.map((call, i) => {
        if (!call.id) { call.id = newId(); stats.idsAdded += 1; }
        stats.toolCalls += 1;
        return { index: i, id: call.id, type: 'function', function: { name: call.name, arguments: call.args.trim() ? call.args : '{}' } };
      });
      callChoices.push({ index, delta: { tool_calls: toolCalls }, finish_reason: null });
    }
    if (callChoices.length) out.push({ ...base(), choices: callChoices });
    if (!finishes.size && done) {
      // [DONE] without a finish reason: the stream ended as the server meant it to; say how.
      finishes.set(indexes[0] ?? 0, { reason: callChoices.length ? 'tool_calls' : 'stop', native: null });
      stats.finishSynthesized = true;
    }
    if (finishes.size) {
      const finishChoices = [...finishes].sort((a, b) => a[0] - b[0]).map(([index, f]) => ({ index, delta: {}, finish_reason: f.reason, ...(f.native ? { native_finish_reason: f.native } : {}) }));
      out.push({ ...base(), choices: finishChoices });
    }
    return out;
  }

  /**
   * What the stream needed: `repaired` when Maritaca sent something OpenCode refuses or would read wrong (content after
   * the finish, several finishes, a repeated or restated call, a call without an id, no finish before [DONE]). A chunk
   * with only usage after the finish is OpenAI's own shape (stream_options.include_usage), not a repair.
   */
  function report() {
    const finish = [...finishes.values()][0]?.reason ?? null;
    const a = stats.afterFinish;
    const repaired = a.text + a.reasoning + a.toolDeltas > 0 || stats.finishChunks > 1 || stats.duplicateFragments > 0 || stats.snapshots > 0
      || stats.conflicts > 0 || stats.idsAdded > 0 || stats.finishSynthesized;
    return { ...stats, afterFinish: { ...stats.afterFinish }, finishReasons: [...stats.finishReasons], shapes: [...stats.shapes], finishReason: finish, repaired };
  }

  return { push, end, report, get finished() { return finishes.size > 0; } };
}

/** One line for the log: what Maritaca sent after its finish reason and what was repaired, without a single value. */
export function describeRepair(report, { model = '' } = {}) {
  if (!report?.repaired) return '';
  const parts = [];
  const a = report.afterFinish || {};
  if ((a.text || 0) + (a.reasoning || 0) + (a.toolDeltas || 0) > 0) {
    const what = [a.toolDeltas ? `${a.toolDeltas} tool-call delta(s)` : '', a.text ? `${a.text} text delta(s)` : '', a.reasoning ? `${a.reasoning} reasoning delta(s)` : '', a.usage ? `${a.usage} usage` : ''].filter(Boolean).join(', ') || 'nothing OpenCode reads';
    parts.push(`finish_reason ${JSON.stringify(report.finishReasons?.[0] ?? report.finishReason)} was followed by ${a.chunks} chunk(s) (${what}) [${(report.shapes || []).join(' | ')}]`);
  }
  if (report.finishChunks > 1) parts.push(`${report.finishChunks} finish chunks (${(report.finishReasons || []).join(', ')}) made one`);
  if (report.duplicateFragments) parts.push(`${report.duplicateFragments} repeated tool-call fragment(s) dropped`);
  if (report.snapshots) parts.push(`${report.snapshots} whole-arguments restatement(s) taken in place of the pieces`);
  if (report.conflicts) parts.push(`${report.conflicts} conflicting restatement(s): the later arguments kept`);
  if (report.idsAdded) parts.push(`${report.idsAdded} tool-call id(s) added`);
  if (report.finishSynthesized) parts.push(`no finish_reason before [DONE]: ${JSON.stringify(report.finishReason)} said`);
  return `[maritaca] OpenCode stream repaired${model ? ` (${String(model).slice(0, 60)})` : ''}: ${parts.join('; ')}`;
}

/**
 * The lines of a server-sent-events body, chunk by chunk (bytes or text): `push(chunk)` returns the complete lines,
 * `end()` the last one when the body did not end with a newline. CRLF and CR-free line ends both read; a character
 * split across two chunks is put back together.
 */
export function createSseLineReader() {
  const decoder = new TextDecoder();
  let buffer = '';
  function lines() {
    const out = [];
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      out.push(buffer.slice(0, at).replace(/\r$/, ''));
      buffer = buffer.slice(at + 1);
    }
    return out;
  }
  return {
    push(chunk) { buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }); return lines(); },
    end() { buffer += decoder.decode(); const out = lines(); if (buffer.trim()) out.push(buffer.replace(/\r$/, '')); buffer = ''; return out; },
  };
}

/**
 * One line of the stream, read: `{ kind: 'data', payload }` (parsed JSON), `{ kind: 'done' }` ([DONE]),
 * `{ kind: 'raw', data }` (a data line that is not JSON: sent on as it was), `{ kind: 'comment', line }` (a keep-alive),
 * or null (a blank line, an `event:` / `id:` / `retry:` field: OpenAI-style streams carry nothing there).
 */
export function readSseLine(line) {
  const text = String(line ?? '');
  if (!text.trim()) return null;
  if (text.startsWith(':')) return { kind: 'comment', line: text };
  if (!text.startsWith('data:')) return null;
  const data = text.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return { kind: 'done' };
  try { return { kind: 'data', payload: JSON.parse(data) }; } catch { return { kind: 'raw', data }; }
}

/**
 * The request as it goes to Maritaca: a copy of OpenCode's body without the reasoning echoed on assistant messages
 * (REASONING_ECHO_FIELDS). Returns { body, strippedReasoning } (how many messages lost a field); the input is never changed.
 */
export function prepareUpstreamBody(body) {
  if (!isObject(body)) return { body, strippedReasoning: 0 };
  let strippedReasoning = 0;
  const messages = Array.isArray(body.messages) ? body.messages.map((m) => {
    if (!isObject(m) || m.role !== 'assistant' || !REASONING_ECHO_FIELDS.some((f) => f in m)) return m;
    const copy = { ...m };
    for (const f of REASONING_ECHO_FIELDS) delete copy[f];
    strippedReasoning += 1;
    return copy;
  }) : body.messages;
  return { body: { ...body, ...(Array.isArray(body.messages) ? { messages } : {}) }, strippedReasoning };
}
