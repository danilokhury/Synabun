// ── Claude Code transcript → sidepanel history rows ──
//
// GET /api/claude-code/sessions/:id/messages streams a session's JSONL and turns
// each line into the rows the panel replays. Pure functions, so the format
// knowledge is tested without the server (tests/claude-history.test.mjs).
//
// What a transcript line looks like (checked against real 2.1.28x files):
//   - a tool's result is a `tool_result` block inside a `type:"user"` line, with
//     the typed output next to it as `toolUseResult` (object, array or string);
//     there are no top-level `tool_result` lines;
//   - `isMeta` user lines are injected by the CLI, not typed by the user;
//   - every line carries a `uuid`.

const MAX_TEXT = 64_000;
const MAX_RESULT_TEXT = 32_000;
const MAX_STRING = 20_000;       // one string inside a structured result
const MAX_ARRAY = 200;
const MAX_STRUCTURED_BYTES = 256_000;
// Whole-file copies and binary payloads: the card needs the patch and the
// counts, never these.
const DROP_KEYS = new Set(['originalFile', 'base64', 'rawOutputPath', 'skillMd']);

function slimValue(v, depth) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (typeof v !== 'object') return v;
  if (depth > 6) return undefined;
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ARRAY).map(x => slimValue(x, depth + 1));
    return out;
  }
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (DROP_KEYS.has(k)) continue;
    const s = slimValue(val, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/** A tool's typed output, without the fields that only make the payload large. */
export function slimToolUseResult(result) {
  if (result == null) return undefined;
  const slim = slimValue(result, 0);
  try {
    if (JSON.stringify(slim).length > MAX_STRUCTURED_BYTES) return undefined;
  } catch { return undefined; }
  return slim;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (typeof b === 'string' ? b : (b?.type === 'text' ? (b.text || '') : ''))).filter(Boolean).join('\n');
}

// A slash command, its output and a shell-mode command are stored as user lines
// whose whole text is XML-like wrappers. Shown raw they read as markup the user
// typed. Returns the rows they stand for, or null for an ordinary prompt.
const inner = (text, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1].trim() : null;
};
function commandWrapperRows(text) {
  const t = text.trimStart();
  if (t.startsWith('<command-name>')) {
    const name = inner(t, 'command-name') || '';
    if (!name) return null;
    const args = inner(t, 'command-args') || '';
    return [{ role: 'user', text: `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`.slice(0, MAX_TEXT), command: true }];
  }
  if (t.startsWith('<bash-input>')) {
    const cmd = inner(t, 'bash-input');
    return cmd ? [{ role: 'user', text: `! ${cmd}`.slice(0, MAX_TEXT), command: true }] : [];
  }
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>') || t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) {
    const rows = [];
    for (const [tag, isError] of [['local-command-stdout', false], ['bash-stdout', false], ['local-command-stderr', true], ['bash-stderr', true]]) {
      const out = inner(t, tag);
      if (!out) continue;
      const row = { role: 'system', subtype: 'local_command_output', text: out.slice(0, MAX_RESULT_TEXT) };
      if (isError) row.isError = true;
      rows.push(row);
    }
    return rows;
  }
  return null;
}

/**
 * The rows one transcript line contributes.
 * @returns {{ rows: object[], usage: object|null, turn: boolean }}
 *   `usage` is the main loop's context usage when the line is an assistant
 *   message that carries a real one; `turn` is true for a prompt the user typed.
 */
export function historyRowsFromEntry(obj) {
  const out = { rows: [], usage: null, turn: false };
  if (!obj || typeof obj !== 'object') return out;

  if (obj.type === 'user') {
    const content = obj.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter(b => b?.type === 'tool_result' && b.tool_use_id);
    for (const b of results) {
      const row = {
        role: 'tool_result',
        toolUseId: b.tool_use_id,
        text: blockText(b.content).slice(0, MAX_RESULT_TEXT) || undefined,
        isError: b.is_error === true,
      };
      // One typed output per line: it belongs to the line's only result.
      if (results.length === 1) {
        const structured = slimToolUseResult(obj.toolUseResult);
        if (structured !== undefined) row.structured = structured;
      }
      out.rows.push(row);
    }
    const text = typeof content === 'string' ? content
      : blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n');
    // Injected by the CLI (caveats, command output wrappers), or a compaction
    // summary: not something the user typed.
    if (text && !obj.isMeta && !obj.isCompactSummary) {
      const wrapped = commandWrapperRows(text);
      if (wrapped) {
        for (const row of wrapped) {
          if (row.role === 'user' && obj.uuid) row.uuid = obj.uuid;
          out.rows.push(row);
        }
        return out;
      }
      const row = { role: 'user', text: text.slice(0, MAX_TEXT) };
      if (obj.uuid) row.uuid = obj.uuid;
      if (obj.timestamp) row.timestamp = obj.timestamp;
      out.rows.push(row);
      out.turn = true;
    }
    return out;
  }

  if (obj.type === 'assistant') {
    const content = Array.isArray(obj.message?.content) ? obj.message.content : [];
    const text = content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
    const thinking = content.filter(b => b?.type === 'thinking').map(b => b.thinking || b.text || '').filter(Boolean).join('\n\n');
    const tools = content.filter(b => b?.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }));
    if (text || tools.length || thinking) {
      const row = {
        role: 'assistant',
        text: text.slice(0, MAX_TEXT) || undefined,
        thinking: thinking.slice(0, MAX_RESULT_TEXT) || undefined,
        tools: tools.length ? tools : undefined,
      };
      if (obj.uuid) row.uuid = obj.uuid;
      if (obj.timestamp) row.timestamp = obj.timestamp;
      out.rows.push(row);
    }
    // Latest main-loop context for the gauge. Synthetic messages ("No response
    // requested.", API errors) have model "<synthetic>" and all-zero usage, and
    // sidechain entries are a subagent's context, not the session's.
    const usage = obj.message?.usage;
    if (usage && !obj.isSidechain
      && (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) > 0) {
      out.usage = usage;
    }
    return out;
  }

  if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
    const m = obj.compactMetadata || obj.compact_metadata || {};
    out.rows.push({
      role: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: m.trigger,
        pre_tokens: m.preTokens ?? m.pre_tokens,
        post_tokens: m.postTokens ?? m.post_tokens,
        duration_ms: m.durationMs ?? m.duration_ms,
      },
      uuid: obj.uuid || undefined,
    });
    return out;
  }

  // A warning or notice the CLI wrote into the conversation.
  if (obj.type === 'system' && obj.subtype === 'informational') {
    const text = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (text && !obj.isMeta && obj.level !== 'info') out.rows.push({ role: 'system', subtype: 'informational', level: obj.level || 'notice', text: text.slice(0, MAX_STRING) });
    return out;
  }

  // What was queued while a turn ran: a prompt the user typed, or the report of
  // a background task (shown as what started the next turn, not as its markup).
  if (obj.type === 'attachment' && obj.attachment?.type === 'queued_command') {
    const a = obj.attachment;
    const kind = a.origin?.kind || (a.commandMode && a.commandMode !== 'prompt' ? a.commandMode : '');
    if (kind && kind !== 'human') out.rows.push({ role: 'system', subtype: 'origin', origin: a.origin && typeof a.origin === 'object' ? a.origin : { kind } });
    else if (typeof a.prompt === 'string' && a.prompt.trim()) out.rows.push({ role: 'user', text: a.prompt.slice(0, MAX_TEXT), queued: true });
    return out;
  }

  // Older transcripts: results as top-level lines.
  if (obj.type === 'tool_result' || obj.type === 'tool') {
    const toolUseId = obj.tool_use_id || obj.message?.tool_use_id;
    if (toolUseId) {
      out.rows.push({
        role: 'tool_result',
        toolUseId,
        text: blockText(obj.message?.content || obj.content).slice(0, MAX_RESULT_TEXT) || undefined,
        isError: obj.is_error || obj.message?.is_error || false,
      });
    }
  }
  return out;
}

// ── The transcript as a chain ──
// Every line with a `uuid` names the line it follows (`parentUuid`). A rewind
// (resumeSessionAt) leaves the abandoned lines in the file and appends the new
// branch after them, so the file is a tree and the conversation is one path
// through it: from the last line back to the root.

const CHAIN_LEAF_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);
const MESSAGE_TYPES = new Set(['user', 'assistant']);
// What forkSession's upToMessageId can name: any line the SDK copies into a
// fork (it slices the transcript at the line with that uuid). An end-turn tool
// leaves the turn's real output in a `structured_output` attachment after the
// result carrier, so the copy must end on it, not on the carrier.
const FORK_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

/**
 * Index a transcript's chain while it is streamed.
 *   add(obj)            → the line's position (call once per parsed line, in order)
 *   activeFilter()      → (uuid, position) => is this line part of the conversation
 *   parentOf(uuid, o)   → the entry `uuid` follows: its uuid, '' when it is the
 *                         first entry, null when `uuid` is not in the transcript.
 *                         `forkable` walks up to the nearest line a fork can end
 *                         on (prompt, reply, carrier, attachment, system line);
 *                         `messagesOnly` to the nearest prompt, reply or carrier.
 */
export function createChainIndex() {
  const nodes = new Map(); // uuid → { parent, type, position }
  let leaf = null;
  let count = 0;
  const parentKey = (obj) => {
    const p = obj.parentUuid ?? obj.logicalParentUuid ?? null; // a compact boundary restarts the chain and points back logically
    return typeof p === 'string' && p ? p : null;
  };
  return {
    add(obj) {
      const position = count++;
      if (!obj || typeof obj !== 'object' || typeof obj.uuid !== 'string' || !obj.uuid) return position;
      const content = obj.message?.content;
      nodes.set(obj.uuid, {
        parent: parentKey(obj),
        type: obj.type || '',
        position,
        // One API message is written as one line per content block, all with the
        // same message id; parallel tool calls are such lines.
        messageId: obj.type === 'assistant' && typeof obj.message?.id === 'string' ? obj.message.id : '',
        carrier: obj.type === 'user' && Array.isArray(content) && content.some(b => b?.type === 'tool_result'),
      });
      // A subagent's inline lines (older transcripts) are their own chain.
      if (!obj.isSidechain && CHAIN_LEAF_TYPES.has(obj.type)) leaf = obj.uuid;
      return position;
    },
    activeFilter() {
      // Walk from the last line to the top of what the file still links. Lines
      // above that point are kept as they are (an earlier chain, or a broken
      // link: never drop history on a guess); below it, only the path counts.
      const active = new Set();
      let floor = 0;
      for (let id = leaf, guard = nodes.size + 1; id && guard > 0; guard--) {
        const node = nodes.get(id);
        if (!node || active.has(id)) break;
        active.add(id);
        floor = node.position;
        id = node.parent;
      }
      if (!active.size) return () => true;
      // Parallel tool calls are not a line: the lines of one assistant message
      // and their results hang off each other as short side twigs, and the walk
      // above follows only one of them. They belong to the conversation (the
      // CLI re-attaches them the same way when it resumes): every line of a
      // message that is on the path, and every result carried by such a line.
      const activeMessages = new Set();
      for (const id of active) { const m = nodes.get(id).messageId; if (m) activeMessages.add(m); }
      for (let changed = true, rounds = 0; changed && rounds < 50; rounds++) {
        changed = false;
        for (const [id, node] of nodes) {
          if (active.has(id) || node.position < floor) continue;
          const sibling = node.messageId && activeMessages.has(node.messageId);
          const result = node.carrier && node.parent && active.has(node.parent) && nodes.get(node.parent)?.type === 'assistant';
          if (!sibling && !result) continue;
          active.add(id);
          changed = true;
        }
      }
      return (uuid, position) => !uuid || position < floor || active.has(uuid);
    },
    parentOf(uuid, { messagesOnly = false, forkable = false } = {}) {
      const node = typeof uuid === 'string' ? nodes.get(uuid) : null;
      if (!node) return null;
      const wanted = messagesOnly ? MESSAGE_TYPES : (forkable ? FORK_TYPES : null);
      let id = node.parent;
      for (let guard = nodes.size + 1; id && guard > 0; guard--) {
        const parent = nodes.get(id);
        if (!parent) return wanted ? '' : id; // the link leaves the file: nothing known above it
        if (!wanted || wanted.has(parent.type)) return id;
        id = parent.parent;
      }
      return '';
    },
    get size() { return nodes.size; },
  };
}

/**
 * Collect the rows of a transcript line by line, then return the page a request
 * asks for: only the active branch (abandoned rewinds are left out), with the
 * usage and turn count of that branch.
 */
export function createHistoryCollector() {
  const chain = createChainIndex();
  const pending = []; // { row, uuid, position, usage, turn }
  return {
    chain,
    add(obj) {
      const position = chain.add(obj);
      const entry = historyRowsFromEntry(obj);
      const uuid = obj && typeof obj.uuid === 'string' ? obj.uuid : '';
      if (!entry.rows.length && !entry.usage && !entry.turn) return;
      pending.push({ rows: entry.rows, uuid, position, usage: entry.usage, turn: entry.turn });
    },
    /** One tool call's result row (the last one recorded for the id), or null. */
    toolResult(toolUseId) {
      if (typeof toolUseId !== 'string' || !/^[\w-]{1,128}$/.test(toolUseId)) return null;
      for (let i = pending.length - 1; i >= 0; i--) {
        const row = pending[i].rows.find(r => r.role === 'tool_result' && r.toolUseId === toolUseId);
        if (row) return row;
      }
      return null;
    },
    finish({ limit = 200, before = null } = {}) {
      const keep = chain.activeFilter();
      const messages = [];
      let usage = null;
      let turns = 0;
      let abandoned = 0;
      // The last prompt or reply of the active branch. A cached copy of the
      // conversation that does not end on it shows another branch (a rewind
      // replaced it), whatever its row count says. (A typed slash or shell
      // command is not counted: the panel keeps no uuid on such a row.)
      let leaf = '';
      for (const p of pending) {
        if (!keep(p.uuid, p.position)) { abandoned += p.rows.length; continue; }
        for (const row of p.rows) {
          messages.push(row);
          if ((row.role === 'user' || row.role === 'assistant') && row.uuid && !row.command) leaf = row.uuid;
        }
        if (p.usage) usage = p.usage;
        if (p.turn) turns++;
      }
      return { ...pageHistory(messages, { limit, before }), turns, usage, abandoned, leaf };
    },
  };
}

/**
 * The history route's answer when a session has no transcript where it was
 * looked for. A named project is the only place looked in (the lookup is never
 * widened behind the caller's back), so "not in this project" is its own
 * answer: the session is not empty, its transcript is elsewhere or gone.
 * `scope` is 'project' when one was named, 'registered' when every registered
 * project was searched.
 */
export function transcriptNotFound(project) {
  const scoped = typeof project === 'string' && project !== '';
  return {
    status: 404,
    body: {
      error: scoped ? "This session's transcript was not found in this project." : "This session's transcript was not found in any registered project.",
      code: 'transcript_not_found',
      scope: scoped ? 'project' : 'registered',
      messages: [],
    },
  };
}

/**
 * The page of rows a request asks for: the last `limit` rows, or the `limit`
 * rows that end just before index `before` ("load earlier"). A page never
 * holds a result without its call: a result whose call lies before the page
 * pulls the start back to that call, or the card would be rendered later with
 * nothing to fill it. Pulling the start back can bring in other results, so
 * this repeats until the page is complete, however far the call is. Only a
 * result whose call is not in the transcript at all stays alone.
 * @returns {{ messages: object[], total: number, start: number, visible: number }}
 */
export function pageHistory(messages, { limit = 200, before = null } = {}) {
  const total = messages.length;
  const cap = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const b = Number(before);
  const end = Number.isFinite(b) && before !== null && before !== '' ? Math.max(0, Math.min(Math.floor(b), total)) : total;
  let start = Math.max(0, end - cap);
  // Where each call is (the first row that makes it), read once.
  const callAt = new Map();
  for (let i = 0; i < end; i++) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    for (const t of m.tools || []) { if (t?.id && !callAt.has(t.id)) callAt.set(t.id, i); }
  }
  // Each pass looks at the rows the last one added: their results may have
  // calls further up still.
  for (let from = start, to = end; from < to;) {
    let earliest = from;
    for (let i = from; i < to; i++) {
      const m = messages[i];
      if (m?.role !== 'tool_result' || !m.toolUseId) continue;
      const at = callAt.get(m.toolUseId);
      if (at !== undefined && at < earliest) earliest = at;
    }
    to = from;
    from = earliest;
    start = Math.min(start, earliest);
  }
  // Prompts and replies only: what the panel compares its cached transcript
  // against (results and markers do not add transcript rows of their own).
  const visible = messages.reduce((n, m) => n + (m.role === 'user' || m.role === 'assistant' ? 1 : 0), 0);
  return { messages: messages.slice(start, end), total, start, visible };
}
