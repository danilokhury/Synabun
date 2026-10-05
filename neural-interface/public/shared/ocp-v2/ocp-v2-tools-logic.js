// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — what a tool card, the todo widget and the cost label show
// (no DOM). The renderer builds nodes from these view models.
//
// A tool part is `{ tool, callID, state: { status, input, output?, error?,
// title?, metadata?, time?, attachments? } }`. The keys inside `input` and
// `metadata` are not in the SDK typings: every read here is optional, and a
// tool this file does not know falls back to its input and output as text.
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_OUTPUT_MAX_LINES = 24;
export const TOOL_OUTPUT_MAX_CHARS = 4000;

const str = (v) => (typeof v === 'string' ? v : '');
const oneLine = (v, max = 120) => {
  const text = str(v).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const baseName = (path) => str(path).split(/[\\/]/).filter(Boolean).pop() || str(path);

/** Canonical tool key: `mcp__server__tool` and `server_tool` stay as they are, built-ins are lowercased. */
export function toolKey(name) {
  return str(name).trim().toLowerCase();
}

const TOOL_LABELS = {
  bash: 'Bash', edit: 'Edit', multiedit: 'Edit', write: 'Write', apply_patch: 'Patch', patch: 'Patch',
  read: 'Read', grep: 'Grep', glob: 'Glob', list: 'List', ls: 'List',
  webfetch: 'Fetch', websearch: 'Search', codesearch: 'Code search',
  task: 'Task', todowrite: 'Todos', todoread: 'Todos', skill: 'Skill', lsp: 'LSP',
};

const TOOL_ICON_KEYS = {
  bash: 'bash', edit: 'edit', multiedit: 'edit', write: 'write', apply_patch: 'patch', patch: 'patch',
  read: 'read', grep: 'grep', glob: 'glob', list: 'ls', ls: 'ls',
  webfetch: 'fetch', websearch: 'sourcegraph', codesearch: 'sourcegraph', task: 'agent', lsp: 'diagnostics',
};

export function toolLabel(name) {
  const key = toolKey(name);
  if (TOOL_LABELS[key]) return TOOL_LABELS[key];
  // An MCP tool arrives as `server_tool`: show both halves.
  const raw = str(name).trim();
  return raw ? raw.replace(/^mcp__/, '').replace(/__/g, ' · ') : 'Tool';
}

export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes}m ${Math.round((value % 60_000) / 1000)}s`;
}

/** Keep the head of a long output: `{ text, hiddenLines, truncated }`. */
export function truncateOutput(text, maxLines = TOOL_OUTPUT_MAX_LINES, maxChars = TOOL_OUTPUT_MAX_CHARS) {
  const full = str(text);
  const lines = full.split('\n');
  let kept = lines.slice(0, maxLines);
  let out = kept.join('\n');
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    kept = out.split('\n');
  }
  const truncated = out.length < full.length;
  return { text: out, hiddenLines: truncated ? Math.max(lines.length - kept.length, 0) : 0, truncated };
}

/** A unified diff as typed lines: add / del / hunk / meta / ctx. */
export function parseUnifiedDiff(diff) {
  const out = [];
  for (const line of str(diff).split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
      || line.startsWith('Index: ') || /^=+$/.test(line)) {
      out.push({ type: 'meta', text: line });
    } else if (line.startsWith('@@')) out.push({ type: 'hunk', text: line });
    else if (line.startsWith('+')) out.push({ type: 'add', text: line });
    else if (line.startsWith('-')) out.push({ type: 'del', text: line });
    else out.push({ type: 'ctx', text: line });
  }
  while (out.length && out[out.length - 1].text === '') out.pop();
  return out;
}

/** +n −m of a parsed diff. */
export function diffStat(lines) {
  let additions = 0;
  let deletions = 0;
  for (const line of lines || []) {
    if (line.type === 'add') additions += 1;
    else if (line.type === 'del') deletions += 1;
  }
  return { additions, deletions };
}

// An edit without a diff in its metadata: the old and new strings as −/+ lines.
function diffFromStrings(oldText, newText) {
  const lines = [];
  for (const line of str(oldText).split('\n')) lines.push({ type: 'del', text: `-${line}` });
  for (const line of str(newText).split('\n')) lines.push({ type: 'add', text: `+${line}` });
  return lines;
}

function outputText(state) {
  const output = state?.output;
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try { return JSON.stringify(output, null, 2); } catch { return String(output); }
}

function jsonText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function errorText(state) {
  const error = state?.error;
  if (!error) return '';
  return typeof error === 'string' ? error : jsonText(error);
}

const MAX_DIFF_LINES = 400;

function diffSection(lines) {
  const stat = diffStat(lines);
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return { kind: 'diff', lines: shown, hiddenLines: lines.length - shown.length, ...stat };
}

/**
 * Everything a tool card shows.
 *   { tool, label, iconKey, status, title, meta, sections, defaultExpanded,
 *     copyText, childSessionId, attachments }
 * sections: { kind: 'code' | 'output' | 'error' | 'diff' | 'todos', … }
 */
export function toolCardView(part) {
  const state = part?.state && typeof part.state === 'object' ? part.state : {};
  const input = state.input && typeof state.input === 'object' ? state.input : (part?.input && typeof part.input === 'object' ? part.input : {});
  const metadata = state.metadata && typeof state.metadata === 'object' ? state.metadata : {};
  const tool = toolKey(part?.tool || part?.name);
  const status = str(state.status || part?.status) || 'pending';
  const start = Number(state.time?.start);
  const end = Number(state.time?.end);
  const view = {
    tool,
    label: toolLabel(part?.tool || part?.name),
    iconKey: TOOL_ICON_KEYS[tool] || '',
    status,
    title: oneLine(state.title),
    meta: Number.isFinite(start) && Number.isFinite(end) && end >= start ? formatDuration(end - start) : '',
    sections: [],
    defaultExpanded: status === 'error',
    copyText: '',
    childSessionId: '',
    attachments: Array.isArray(state.attachments) ? state.attachments.filter((a) => a && typeof a.url === 'string') : [],
  };
  const output = outputText(state);
  const error = errorText(state);
  const addOutput = (text = output) => { if (text) view.sections.push({ kind: 'output', ...truncateOutput(text), full: text }); };

  switch (tool) {
    case 'bash': {
      const command = str(input.command);
      view.title = oneLine(input.description) || view.title || oneLine(command);
      if (command) view.sections.push({ kind: 'code', text: command, prompt: '$' });
      addOutput(str(metadata.output) || output);
      view.copyText = command;
      // A command that is running or failed is what the user is waiting on.
      view.defaultExpanded = status !== 'completed';
      if (typeof metadata.exit === 'number' && metadata.exit !== 0) view.meta = [view.meta, `exit ${metadata.exit}`].filter(Boolean).join(' · ');
      break;
    }
    case 'edit':
    case 'multiedit':
    case 'write':
    case 'apply_patch':
    case 'patch': {
      const path = str(input.filePath || input.file_path || input.path || metadata.filepath || metadata.filediff?.file);
      view.title = view.title || oneLine(path);
      const diff = str(metadata.diff);
      let lines = diff ? parseUnifiedDiff(diff) : [];
      if (!lines.length && tool === 'edit' && (input.oldString != null || input.newString != null)) {
        lines = diffFromStrings(input.oldString, input.newString);
      }
      if (!lines.length && tool === 'write' && str(input.content)) {
        lines = str(input.content).split('\n').map((line) => ({ type: 'add', text: `+${line}` }));
      }
      if (!lines.length && str(input.patchText)) lines = parseUnifiedDiff(input.patchText);
      if (lines.length) {
        const section = diffSection(lines);
        view.sections.push(section);
        const stat = `+${section.additions} −${section.deletions}`;
        view.meta = [stat, view.meta].filter(Boolean).join(' · ');
      }
      view.copyText = path;
      break;
    }
    case 'read': {
      const path = str(input.filePath || input.file_path || input.path);
      view.title = view.title || oneLine(path);
      const range = [input.offset != null ? `from ${input.offset}` : '', input.limit != null ? `${input.limit} lines` : ''].filter(Boolean).join(', ');
      if (range) view.meta = [range, view.meta].filter(Boolean).join(' · ');
      addOutput(str(metadata.preview) || output);
      view.copyText = path;
      break;
    }
    case 'grep':
    case 'glob':
    case 'list':
    case 'ls': {
      const pattern = str(input.pattern);
      const where = str(input.path);
      view.title = oneLine([pattern, where && `in ${baseName(where) || where}`, str(input.include) && `(${input.include})`].filter(Boolean).join(' ')) || view.title;
      const count = Number(metadata.matches ?? metadata.count);
      if (Number.isFinite(count)) view.meta = [`${count} ${tool === 'grep' ? 'match' : 'result'}${count === 1 ? '' : (tool === 'grep' ? 'es' : 's')}`, view.meta].filter(Boolean).join(' · ');
      addOutput();
      view.copyText = pattern || where;
      break;
    }
    case 'webfetch':
    case 'websearch':
    case 'codesearch': {
      const target = str(input.url || input.query);
      view.title = oneLine(target) || view.title;
      addOutput();
      view.copyText = target;
      break;
    }
    case 'task': {
      const agent = str(input.subagent_type || input.agent);
      view.title = oneLine([agent, str(input.description)].filter(Boolean).join(' · ')) || view.title;
      view.childSessionId = str(metadata.sessionId || metadata.sessionID || input.sessionId || input.sessionID);
      if (str(input.prompt)) view.sections.push({ kind: 'code', text: str(input.prompt), prompt: '' });
      addOutput();
      view.copyText = str(input.prompt);
      break;
    }
    case 'todowrite':
    case 'todoread': {
      const todos = todoView(Array.isArray(metadata.todos) ? metadata.todos : input.todos);
      view.title = todos.total ? `${todos.done}/${todos.total} done` : view.title;
      if (todos.total) view.sections.push({ kind: 'todos', items: todos.items });
      break;
    }
    case 'skill': {
      view.title = oneLine(input.name) || view.title;
      addOutput();
      break;
    }
    default: {
      // A tool without a dedicated card: its input as text, then its output.
      const inputText = Object.keys(input).length ? jsonText(input) : '';
      if (!view.title) view.title = oneLine(Object.values(input).find((v) => typeof v === 'string') || '');
      if (inputText) view.sections.push({ kind: 'code', text: inputText, prompt: '' });
      addOutput();
      view.copyText = inputText;
    }
  }
  if (error) view.sections.push({ kind: 'error', text: error });
  return view;
}

/** A signature that changes whenever the card would. */
export function toolCardSignature(view) {
  const body = view.sections.map((s) => `${s.kind}:${s.text?.length ?? s.lines?.length ?? s.items?.length ?? 0}:${s.hiddenLines || 0}`).join(',');
  return `${view.tool}|${view.status}|${view.title}|${view.meta}|${body}|${view.childSessionId}|${view.attachments.length}`;
}

// ── Todos (session.todo, todo.updated, the todowrite tool) ──────────────────

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

/** `{ items: [{ content, status }], total, done, active }`. */
export function todoView(todos) {
  const items = (Array.isArray(todos) ? todos : [])
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .map((t) => ({ content: t.content.trim(), status: TODO_STATUSES.has(t.status) ? t.status : 'pending' }));
  const open = items.filter((t) => t.status !== 'cancelled');
  return {
    items,
    total: open.length,
    done: open.filter((t) => t.status === 'completed').length,
    active: items.find((t) => t.status === 'in_progress')?.content || '',
  };
}

/** The widget shows while there is work left; a finished or empty list hides it. */
export function todoWidgetVisible(view) {
  return view.total > 0 && view.done < view.total;
}

// ── Cost and per-message meta (OpenCode's own numbers) ──────────────────────

export function formatCost(value) {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0) return '';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(cost < 10 ? 3 : 2)}`;
}

/**
 * A cost OpenCode reported for one message, zero included: a free model's
 * answer says "$0.00" where a paid one says its price. '' only when OpenCode
 * reported no cost at all (an older transcript).
 */
export function formatReportedCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  return value === 0 ? '$0.00' : formatCost(value);
}

export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * What OpenCode says this session cost. Session.cost (1.18) when the session
 * info has it, else the sum over the assistant messages on screen.
 */
export function sessionCostOf(state) {
  const fromSession = Number(state?.sessionInfo?.cost);
  let fromMessages = 0;
  for (const msg of state?.messages?.values?.() || []) {
    const cost = Number(msg?.info?.cost);
    if (msg?.info?.role === 'assistant' && Number.isFinite(cost)) fromMessages += cost;
  }
  // The session row is updated when a turn ends; messages are live.
  return Math.max(Number.isFinite(fromSession) ? fromSession : 0, fromMessages);
}

/** One muted line under an assistant message: model · agent · tokens · cost · time. */
export function messageMetaText(info) {
  if (!info || info.role !== 'assistant') return '';
  const tokens = info.tokens || {};
  const total = Number(tokens.total) || (Number(tokens.input) || 0) + (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
  const created = Number(info.time?.created);
  const completed = Number(info.time?.completed);
  return [
    str(info.modelID),
    str(info.agent),
    str(info.variant),
    formatTokens(total) && `${formatTokens(total)} tok`,
    formatReportedCost(info.cost),
    Number.isFinite(created) && Number.isFinite(completed) && completed > created ? formatDuration(completed - created) : '',
  ].filter(Boolean).join(' · ');
}
