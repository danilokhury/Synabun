// ═══════════════════════════════════════════
// SynaBun Assistant — tool kinds (the activity rack's vocabulary)
// ═══════════════════════════════════════════
// Pure helpers, no DOM and no imports: node:test covers them
// (tests/assistant-tool-kinds.test.mjs). asst-render.js groups every burst of
// agent work into one rack with one ledger row per kind; this module decides
// the kind of a call, what the stage bubble says about it, the row's
// aggregate and the settled receipt sentence.
//
// Every visible string goes through the caller's t(key, fallback, params)
// (asst-render.js passes its localized t); the fallback is the English text.
// Keys ending in a plural base resolve `${key}.one` / `${key}.other`.

export const KIND_IDS = Object.freeze(['shell', 'read', 'edit', 'search', 'web', 'subagent', 'plan', 'memory', 'runs', 'computer', 'think', 'mcp']);

// Tool names after lowercasing and stripping `mcp__<server>__` / `<server>_`.
const KIND_TOOLS = {
  shell: ['bash', 'bashoutput', 'killshell', 'shell', 'exec_command', 'commandexecution'],
  read: ['read', 'notebookread', 'view'],
  edit: ['edit', 'multiedit', 'write', 'notebookedit', 'patch', 'apply_patch', 'filechange'],
  search: ['grep', 'glob', 'ls', 'list', 'codesearch', 'toolsearch'],
  web: ['webfetch', 'websearch'],
  subagent: ['task', 'agent', 'collabtoolcall', 'taskstop'],
  plan: ['todowrite', 'todoread', 'update_plan'],
};
// SynaBun's own tools: only when the call is SynaBun's (or carries no server).
const MEMORY_TOOLS = ['recall', 'remember', 'reflect', 'forget', 'restore', 'memories', 'sync', 'category'];
const COMPUTER_TOOLS = ['computer', 'computer_apps', 'computer_ax', 'computer_status'];

/**
 * Split a tool name into its server and tool parts.
 * `mcp__SynaBun__recall` → { server: 'SynaBun', tool: 'recall' }; `SynaBun_recall` (OpenCode) the same;
 * `Bash` → { server: null, tool: 'bash' }.
 */
export function parseToolName(name) {
  const raw = String(name ?? '').trim();
  let server = null;
  let rawTool = raw;
  const mcp = /^mcp__(.+?)__(.+)$/i.exec(raw);
  if (mcp) { server = mcp[1]; rawTool = mcp[2]; }
  else if (/^synabun_./i.test(raw)) { server = raw.slice(0, 7); rawTool = raw.slice(8); }
  return { raw, server, serverKey: server ? server.toLowerCase() : null, rawTool, tool: rawTool.toLowerCase() };
}

function matchKind(tool, synabun) {
  for (const [kind, list] of Object.entries(KIND_TOOLS)) if (list.includes(tool)) return kind;
  if (!synabun) return null;
  if (MEMORY_TOOLS.includes(tool)) return 'memory';
  if (COMPUTER_TOOLS.includes(tool)) return 'computer';
  if (tool.startsWith('browser_')) return 'web';
  if (tool.startsWith('agent_')) return 'runs';
  return null;
}

/** The kind id of a tool call (one of KIND_IDS; thinking blocks are 'think' by construction). */
export function kindOf(name, input) { // eslint-disable-line no-unused-vars
  const p = parseToolName(name);
  const synabun = p.serverKey == null || p.serverKey === 'synabun';
  const kind = matchKind(p.tool, synabun);
  if (kind) return kind;
  // OpenCode names other servers' tools `<server>_<tool>`.
  if (p.serverKey == null) {
    const cut = p.tool.indexOf('_');
    if (cut > 0) { const again = matchKind(p.tool.slice(cut + 1), false); if (again) return again; }
  }
  return 'mcp';
}

/** Name of the server an `mcp` call belongs to (its ledger row label), or the tool itself for unknown built-ins. */
export function mcpServerOf(name) {
  const p = parseToolName(name);
  if (p.server) return p.server;
  const cut = p.rawTool.indexOf('_');
  return cut > 0 ? p.rawTool.slice(0, cut) : p.rawTool || 'tool';
}

/** One ledger row per kind, and per server for `mcp`. */
export function stationKey(kind, name) {
  return kind === 'mcp' ? `mcp:${mcpServerOf(name).toLowerCase()}` : kind;
}

/** browser_navigate → "navigate", search_code → "search code", ExitPlanMode → "exit plan mode". */
export function toolWords(name) {
  const p = parseToolName(name);
  let words = p.rawTool;
  if (p.serverKey === 'synabun' || p.serverKey == null) words = words.replace(/^(?:browser|agent)_/i, '');
  return words.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase() || 'tool';
}

// ── Ledger row labels, glyphs and verbs ─────────────────────────────────────

/** Row label, glyph (the static face when the mascot rig has no poses) and the verb a call of the kind uses by default. */
export const KIND_SPECS = Object.freeze({
  shell: { id: 'shell', label: ['assistant.rack.kind.shell', 'Terminal'], glyph: '$', verb: 'run' },
  read: { id: 'read', label: ['assistant.rack.kind.read', 'Reading'], glyph: 'F', verb: 'read' },
  edit: { id: 'edit', label: ['assistant.rack.kind.edit', 'Editing'], glyph: 'E', verb: 'edit' },
  search: { id: 'search', label: ['assistant.rack.kind.search', 'Searching'], glyph: '?', verb: 'search' },
  web: { id: 'web', label: ['assistant.rack.kind.web', 'Web'], glyph: 'W', verb: 'open' },
  subagent: { id: 'subagent', label: ['assistant.rack.kind.subagent', 'Subagents'], glyph: 'A', verb: 'delegate' },
  plan: { id: 'plan', label: ['assistant.rack.kind.plan', 'Plan'], glyph: '✓', verb: 'plan' },
  memory: { id: 'memory', label: ['assistant.rack.kind.memory', 'Memory'], glyph: 'M', verb: 'recall' },
  runs: { id: 'runs', label: ['assistant.rack.kind.runs', 'Runs'], glyph: 'R', verb: 'dispatch' },
  computer: { id: 'computer', label: ['assistant.rack.kind.computer', 'Computer'], glyph: 'C', verb: 'use' },
  think: { id: 'think', label: ['assistant.rack.kind.think', 'Thinking'], glyph: '…', verb: 'think' },
  mcp: { id: 'mcp', label: ['assistant.rack.kind.mcp', 'Tools'], glyph: '#', verb: 'use' },
});

/** Tense pairs: [key, present, past]. The bubble says the present while a call runs, the past once it ended. */
export const VERBS = Object.freeze({
  run: ['assistant.rack.verb.run', 'Running', 'Ran'],
  read: ['assistant.rack.verb.read', 'Reading', 'Read'],
  edit: ['assistant.rack.verb.edit', 'Editing', 'Edited'],
  write: ['assistant.rack.verb.write', 'Writing', 'Wrote'],
  search: ['assistant.rack.verb.search', 'Searching', 'Searched'],
  open: ['assistant.rack.verb.open', 'Opening', 'Opened'],
  delegate: ['assistant.rack.verb.delegate', 'Delegating', 'Delegated'],
  plan: ['assistant.rack.verb.plan', 'Planning', 'Planned'],
  recall: ['assistant.rack.verb.recall', 'Recalling', 'Recalled'],
  save: ['assistant.rack.verb.save', 'Saving', 'Saved'],
  click: ['assistant.rack.verb.click', 'Clicking', 'Clicked'],
  think: ['assistant.rack.verb.think', 'Thinking', 'Thought'],
  check: ['assistant.rack.verb.check', 'Checking', 'Checked'],
  stop: ['assistant.rack.verb.stop', 'Stopping', 'Stopped'],
  update: ['assistant.rack.verb.update', 'Updating', 'Updated'],
  trash: ['assistant.rack.verb.trash', 'Trashing', 'Trashed'],
  restore: ['assistant.rack.verb.restore', 'Restoring', 'Restored'],
  browse: ['assistant.rack.verb.browse', 'Browsing', 'Browsed'],
  type: ['assistant.rack.verb.type', 'Typing into', 'Typed into'],
  fill: ['assistant.rack.verb.fill', 'Filling', 'Filled'],
  press: ['assistant.rack.verb.press', 'Pressing', 'Pressed'],
  hover: ['assistant.rack.verb.hover', 'Hovering over', 'Hovered over'],
  select: ['assistant.rack.verb.select', 'Selecting', 'Selected'],
  upload: ['assistant.rack.verb.upload', 'Uploading', 'Uploaded'],
  scroll: ['assistant.rack.verb.scroll', 'Scrolling', 'Scrolled'],
  take: ['assistant.rack.verb.take', 'Taking', 'Took'],
  back: ['assistant.rack.verb.back', 'Going back', 'Went back'],
  forward: ['assistant.rack.verb.forward', 'Going forward', 'Went forward'],
  reload: ['assistant.rack.verb.reload', 'Reloading', 'Reloaded'],
  wait: ['assistant.rack.verb.wait', 'Waiting', 'Waited'],
  waitOn: ['assistant.rack.verb.waitOn', 'Waiting on', 'Waited on'],
  checkOn: ['assistant.rack.verb.checkOn', 'Checking on', 'Checked on'],
  dispatch: ['assistant.rack.verb.dispatch', 'Dispatching', 'Dispatched'],
  pick: ['assistant.rack.verb.pick', 'Picking', 'Picked'],
  message: ['assistant.rack.verb.message', 'Messaging', 'Messaged'],
  use: ['assistant.rack.verb.use', 'Using', 'Used'],
});

// ── t() plumbing ───────────────────────────────────────────────────────────

/** Replace {name} placeholders. */
export function fill(text, params) {
  const s = String(text ?? '');
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : s;
}
/** The English fallback t: what the tests and a missing hook see. */
export const tFallback = (_key, fallback, params) => fill(fallback, params);

/** i18n.js tp()'s pattern: `key.one` for 1, `key.other` otherwise. */
export function plural(t, key, count, one, other, params = {}) {
  const p = { count, ...params };
  return count === 1 ? t(`${key}.one`, one, p) : t(`${key}.other`, other, p);
}

/** The present or past form of a verb id. */
export function verbText(id, running, t = tFallback) {
  const v = VERBS[id] || VERBS.use;
  return running ? t(`${v[0]}.now`, v[1]) : t(`${v[0]}.done`, v[2]);
}

// ── Text helpers ───────────────────────────────────────────────────────────

const str = (v) => (v == null ? '' : String(v));
const clip = (text, max) => { const s = str(text).replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; };
const firstLine = (text) => str(text).split('\n').map(l => l.trim()).find(Boolean) || '';
const firstString = (...values) => { for (const v of values) { if (typeof v === 'string' && v.trim()) return v.trim(); } return ''; };
const lineCount = (text) => { const s = str(text); if (!s) return 0; return s.replace(/\n$/, '').split('\n').length; };

/** Capitalise the first letter (a receipt sentence starts a line). */
export function capitalize(text) {
  const s = str(text);
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
}

/**
 * Cut `text` in the middle so it fits `max` chars, keeping at least `minTail`
 * tail chars and cutting at token boundaries (spaces, slashes) when one is near.
 */
export function middleEllipsis(text, max = 96, minTail = 24) {
  const s = str(text);
  if (s.length <= max) return s;
  const budget = Math.max(max - 1, minTail + 6);
  let tailStart = s.length - minTail;
  // Pull the tail back to the token boundary before it, within a third of the budget.
  const floor = s.length - Math.max(minTail, Math.floor(budget / 3) + minTail);
  for (let i = tailStart; i > floor && i > 0; i -= 1) {
    const c = s[i - 1];
    if (c === ' ') { tailStart = i; break; }
    if (c === '/') { tailStart = i - 1; break; }
  }
  const tail = s.slice(tailStart);
  let head = s.slice(0, Math.max(1, budget - tail.length));
  const cut = Math.max(head.lastIndexOf(' '), head.lastIndexOf('/'));
  if (cut >= head.length * 0.6) head = head.slice(0, head[cut] === '/' ? cut + 1 : cut);
  return `${head.trimEnd()}…${tail.trimStart()}`;
}

/** A path's last two folders and its basename: `shared/assistant/asst-render.js`. */
export function splitPath(path) {
  const clean = str(path).replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  const base = parts.pop() || clean;
  return { base, dir: parts.slice(-2).join('/'), full: str(path) };
}

export function basename(path) { return splitPath(path).base; }

/** Middle-cut one token over `max` chars; paths keep their first segment and as many last ones as fit. */
function shortenToken(tok, max) {
  if (tok.length <= max) return tok;
  if (tok.includes('/')) {
    const parts = tok.split('/');
    const last = parts.pop();
    const first = parts.shift() ?? '';
    let tail = last;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const next = `${parts[i]}/${tail}`;
      if (first.length + 3 + next.length > max) break;
      tail = next;
    }
    const out = tail === tok ? tok : `${first}/…/${tail}`;
    if (out.length <= max) return out;
    if (last.length <= max + 16) return `…/${last}`; // a long file name still reads best whole
  }
  const keepTail = Math.ceil((max - 1) * 0.55);
  return `${tok.slice(0, max - 1 - keepTail)}…${tok.slice(-keepTail)}`;
}

const HOME_RE = /(^|[\s"'=:(])(?:\/Users|\/home)\/[^/\s"'()]+(?=\/|$|[\s"')])/g;
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const CD_PREFIX = new RegExp(String.raw`^cd\s+${WORD}\s*&&\s*`);
const ENV_ASSIGN = new RegExp(String.raw`^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]*)\s+`);
// `env` and its options: -i, -0, -u NAME, --unset=NAME, -C DIR, --chdir=DIR, `--`.
const ENV_CMD = new RegExp(String.raw`^env(?:\s+(?:-[i0]|--ignore-environment|--null|-u\s*${WORD}|--unset(?:=|\s+)${WORD}|-C\s*${WORD}|--chdir(?:=|\s+)${WORD}|--))*\s+`);

/**
 * The part of a command line the program starts at: leading `cd <dir> &&`,
 * `env` (with -u NAME and the like) and `NAME=value` assignments dropped, so
 * "cd x && env -u A B=1 node --test t.mjs" says "node --test t.mjs".
 */
export function commandCore(cmd) {
  let s = str(cmd).replace(/\s+/g, ' ').trim();
  for (let guard = 0; guard < 24; guard += 1) {
    let next = s;
    for (const re of [CD_PREFIX, ENV_CMD, ENV_ASSIGN]) {
      const cut = next.replace(re, '');
      // `env | grep X` prints the environment: a prefix is only one when a program follows it.
      if (cut !== next && cut && !/^[|;&<>)]/.test(cut)) next = cut;
    }
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * The command a bubble says: its core (commandCore), the home directory shown
 * as ~/, whitespace collapsed and tokens over 28 chars cut in the middle.
 */
export function summarizeCommand(cmd) {
  let s = commandCore(cmd);
  s = s.replace(HOME_RE, '$1~').replace(/(^|[\s"'=:(])\$HOME(?=\/|$|[\s"'])/g, '$1~');
  return s.split(' ').map(tok => shortenToken(tok, 28)).join(' ');
}

/** The command a shell call ran: `command` or `cmd`, as a string (Codex sends argv arrays). */
export function commandOf(input) {
  const i = input && typeof input === 'object' ? input : {};
  const raw = i.command ?? i.cmd ?? '';
  if (Array.isArray(raw)) {
    const argv = raw.map(str);
    if (argv.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) return argv.slice(2).join(' ');
    return argv.join(' ');
  }
  return str(raw);
}

/**
 * Should a text fold into the rack as narration? At most 240 chars, one
 * paragraph, and no code block, list, heading, table or quote. Inline code is
 * fine ("Let me check `server.js`."); whether a tool call follows is the renderer's call.
 */
export function shouldFoldNarration(text) {
  const s = str(text).trim();
  if (!s || s.length > 240) return false;
  if (/\n[ \t]*\n/.test(s)) return false; // more than one paragraph
  if (/```|~~~/.test(s)) return false;
  for (const line of s.split('\n')) {
    if (/^\s{4,}\S/.test(line) || /^\t/.test(line)) return false; // indented code
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) return false; // list
    if (/^\s*#{1,6}\s/.test(line)) return false; // heading
    if (/^\s*(?:>|\|)/.test(line)) return false; // quote, table
    if (isTableDelimiter(line)) return false; // a GFM table without a leading pipe
    if (/^\s*(?:-{3,}|={3,})\s*$/.test(line)) return false; // a setext heading's underline, a rule
  }
  return true;
}

/** A GFM table's delimiter row ("--- | :---:", "|---|"), with or without the outer pipes. */
export function isTableDelimiter(line) {
  const s = str(line).trim();
  if (!s.includes('|')) return false;
  const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 0 && cells.every(cell => /^\s*:?-+:?\s*$/.test(cell));
}

// ── Results ────────────────────────────────────────────────────────────────

/**
 * The exit code a shell result reports, and the output without that marker.
 * Codex: "…\n[exit 1]"; Claude: "Exit code 1\n…" (sometimes "Error: Exit code 1");
 * a trailing "exit code: 1" line for the rest.
 */
export function parseExit(text) {
  const s = str(text);
  let m = /\n?\[exit (-?\d+)\]\s*$/.exec(s);
  if (m) return { code: Number(m[1]), body: s.slice(0, m.index) };
  m = /^\s*(?:Error:\s*)?Exit code:?\s*(-?\d+)\s*(?:\n|$)/i.exec(s);
  if (m) return { code: Number(m[1]), body: s.slice(m[0].length) };
  m = /(?:^|\n)\s*(?:exit(?:ed with)? (?:code|status)|exit code)[:\s]+(-?\d+)\s*$/i.exec(s);
  if (m) return { code: Number(m[1]), body: s.slice(0, m.index) };
  return { code: null, body: s };
}

const NO_MATCH_PROGRAMS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'zgrep', 'diff', 'test', '[', '[[']);

/** rg / grep / diff / test: exit 1 means "no matches" (or "differs", "false"), not a failure. */
export function isNoMatchCommand(cmd) {
  const words = summarizeCommand(cmd).split(' ').filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift(); // env assignments
  if (words[0] === 'git' && (words[1] === 'grep' || words[1] === 'diff')) return true;
  return NO_MATCH_PROGRAMS.has((words[0] || '').replace(/^.*\//, ''));
}

// Claude Code appends its own notice to a command's stderr; it is not the command's.
const SHELL_NOTICE_RE = /^\s*Shell cwd was reset to .*$/gm;
// What a diagnostic line looks like when stdout and stderr come mixed (Codex, OpenCode, a failed Claude call).
const DIAGNOSTIC_RE = /^(?:\S*\/)?(?:rg|grep|egrep|fgrep|zgrep|diff|test|\[|git)(?:\[\d+\])?:\s|No such file or directory|Permission denied|command not found|(?:invalid|unrecognized|illegal) option|^usage:|^error:|^fatal:/im;

/**
 * The stderr of a shell call: `stderr` when the brain reports it apart
 * (Claude's structured tool_use_result), else the output's diagnostic lines
 * ("rg: regex parse error", "No such file or directory"), which is as close as
 * mixed output gets. Claude's own "Shell cwd was reset" notice never counts.
 */
export function shellStderr(output, stderr) {
  if (typeof stderr === 'string') return stderr.replace(SHELL_NOTICE_RE, '').trim();
  return str(output).split('\n').filter(line => DIAGNOSTIC_RE.test(line)).join('\n').trim();
}

/**
 * How a call ended: 'ok', 'error' or 'neutral'. For shell calls the exit code
 * wins over the status (OpenCode reports a failed exit as completed); rg /
 * grep / diff / test exiting 1 with an empty stderr is neutral ("no matches",
 * "differs", "false") whatever is on stdout. `result`: what the brain says
 * apart from the text, when it does ({ stderr, interpretation }: Claude's
 * tool_use_result). `detail`: the first stderr line or "exit N" for a
 * failure. `t` localizes "exit N".
 */
export function callOutcome({ kind, input } = {}, text, isError, t = tFallback, result = null) {
  if (kind === 'shell') {
    const { code, body } = parseExit(text);
    const noMatch = isNoMatchCommand(commandOf(input));
    const failed = code != null ? code !== 0 : !!isError;
    if (!failed) {
      // Claude read the exit code itself ("No matches found", "Files differ").
      if (code == null && noMatch && typeof result?.interpretation === 'string' && result.interpretation.trim()) return { state: 'neutral', code: null, detail: '' };
      return { state: 'ok', code };
    }
    const stderr = shellStderr(body, result?.stderr);
    if (code === 1 && noMatch && !stderr) return { state: 'neutral', code, detail: '' };
    const line = firstLine(stderr || str(body).trim()).replace(/^Error:\s*/i, '');
    return { state: 'error', code, detail: line || (code != null ? t('assistant.rack.say.exit', 'exit {code}', { code }) : '') };
  }
  if (isError) return { state: 'error', code: null, detail: firstLine(text).replace(/^Error:\s*/i, '') };
  return { state: 'ok', code: null };
}

/** The parts of a Claude tool_use_result the outcome reads: { stderr, interpretation } or null. */
export function resultDetail(toolUseResult) {
  const r = toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult) ? toolUseResult : null;
  if (!r) return null;
  const out = {};
  if (typeof r.stderr === 'string') out.stderr = r.stderr;
  if (typeof r.returnCodeInterpretation === 'string') out.interpretation = r.returnCodeInterpretation;
  return Object.keys(out).length ? out : null;
}

// ── Values a call typed ────────────────────────────────────────────────────

/** Credentials, whatever the tool: hidden until the user asks. Counters ("max_tokens") are not credentials. */
export const SECRET_KEY_RE = /password|passwd|secret|token/i;
const NOT_SECRET_RE = /tokens$|tokens?_?(?:count|usage|limit|budget)|max_?tokens/i;

/** The input keys that hold what a call typed: browser_type's text, browser_fill's value, a select's value, a desktop `type`. */
export function typedKeys(name, input) {
  const p = parseToolName(name);
  if (/(?:^|_)browser_(?:type|fill|fill_form|select)$/.test(p.tool)) return ['text', 'value', 'values'];
  if (COMPUTER_TOOLS.includes(p.tool) && /^type$/i.test(str(input?.action))) return ['text'];
  return [];
}

/** How a hidden value reads: "•••• (8 chars)". */
export function maskValue(value, t = tFallback) {
  let n = 0;
  if (typeof value === 'string') n = value.length;
  else { try { n = JSON.stringify(value ?? '').length; } catch { n = String(value).length; } }
  return plural(t, 'assistant.rack.redacted', n, '•••• (1 char)', '•••• ({count} chars)');
}

/**
 * `input` with what the call typed and every credential masked (a deep copy),
 * and the originals it hid: { input, hidden: [{ key, value }] }. Nothing is
 * hidden for a call that typed nothing and carries no credentials.
 */
export function redactInput(name, input, t = tFallback) {
  const typed = new Set(typedKeys(name, input));
  const hidden = [];
  const walk = (value, depth) => {
    if (Array.isArray(value)) return depth > 8 ? value : value.map(v => walk(v, depth + 1));
    if (!value || typeof value !== 'object' || depth > 8) return value;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const secret = (depth === 0 && typed.has(key)) || (SECRET_KEY_RE.test(key) && !NOT_SECRET_RE.test(key));
      if (secret && v != null && v !== '') { hidden.push({ key, value: v }); out[key] = maskValue(v, t); }
      else out[key] = walk(v, depth + 1);
    }
    return out;
  };
  return { input: walk(input && typeof input === 'object' ? input : {}, 0), hidden };
}

/**
 * `text` with every hidden value masked: a tool that echoes what it typed
 * ('Typed "hunter2" into ref e12') gives nothing away. Values under 4 chars
 * are masked only where quoted (a bare "a" would take every letter a).
 */
export function maskEcho(text, hidden, t = tFallback) {
  let s = str(text);
  for (const { value } of hidden || []) {
    if (typeof value !== 'string' || !value) continue;
    const mask = maskValue(value, t);
    for (const probe of new Set([value, value.slice(0, 100)])) {
      s = probe.length >= 4 ? s.split(probe).join(mask) : s.split(`"${probe}"`).join(`"${mask}"`);
    }
  }
  return s;
}

/** "Found 3 memories", "[1a2b3c4d-…] …" lines, "5 results": how many a recall found, or null. */
export function recallCount(text) {
  const s = str(text);
  if (!s.trim()) return null;
  const m = /\b(\d+)\s+(?:memories|memory|results?|matches)\b/i.exec(s) || /\bfound\s+(\d+)\b/i.exec(s);
  if (m) return Number(m[1]);
  const ids = s.match(/^\s*\[[0-9a-f]{8}(?:-[0-9a-f]{4,})*\]/gim);
  if (ids) return ids.length;
  if (/^no (?:memories|results|matches)/i.test(s.trim())) return 0;
  return null;
}

/** Grep / Glob output: { matches, files } when it can be read, else null. */
export function searchCounts(text) {
  const s = str(text).trim();
  if (!s) return null;
  if (/^no (?:files|matches) found/i.test(s)) return { matches: 0, files: 0 };
  let m = /^Found (\d+) files?/m.exec(s);
  if (m) return { matches: null, files: Number(m[1]) };
  m = /^Found (\d+) (?:total )?(?:matches|occurrences)/m.exec(s);
  if (m) return { matches: Number(m[1]), files: null };
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length && lines.every(l => /^[^:\s][^:]*:\d+$/.test(l))) { // count mode: path:N
    return { matches: lines.reduce((sum, l) => sum + Number(l.slice(l.lastIndexOf(':') + 1)), 0), files: lines.length };
  }
  if (lines.length && lines.every(l => /^[^:\s][^:]*:\d+:/.test(l))) { // content mode: path:line:text
    return { matches: lines.length, files: new Set(lines.map(l => l.slice(0, l.indexOf(':')))).size };
  }
  if (lines.length && lines.every(l => /^[~./\w@-][^\s:]*$/.test(l) && /[/.]/.test(l))) return { matches: null, files: lines.length };
  return null;
}

// ── Edits ──────────────────────────────────────────────────────────────────

/** Lines an edit adds and removes, counted from its input strings. Null when the input carries none (Codex fileChange). */
export function editCounts(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const tool = parseToolName(name).tool;
  const pair = (o) => ({ added: lineCount(o?.new_string ?? o?.newString ?? ''), removed: lineCount(o?.old_string ?? o?.oldString ?? '') });
  if (Array.isArray(i.edits)) {
    return i.edits.reduce((sum, e) => { const c = pair(e); return { added: sum.added + c.added, removed: sum.removed + c.removed }; }, { added: 0, removed: 0 });
  }
  if ('new_string' in i || 'newString' in i || 'old_string' in i || 'oldString' in i) return pair(i);
  if (tool === 'write' || typeof i.content === 'string') return { added: lineCount(i.content), removed: 0, created: tool === 'write' };
  if (typeof i.new_source === 'string') return { added: lineCount(i.new_source), removed: 0 };
  const patch = typeof i.input === 'string' ? i.input : typeof i.patch === 'string' ? i.patch : '';
  if (patch) {
    let added = 0; let removed = 0;
    for (const line of patch.split('\n')) {
      if (/^\+\+\+|^---|^\*\*\*/.test(line)) continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    return { added, removed };
  }
  return null;
}

/** The files an edit touches: file_path / filePath / path, MultiEdit's file, a patch's "*** Update File:" lines, Codex's changes. */
export function editPaths(input) {
  const i = input && typeof input === 'object' ? input : {};
  const direct = firstString(i.file_path, i.filePath, i.path, i.notebook_path);
  if (direct) return [direct];
  if (Array.isArray(i.changes)) return i.changes.map(c => str(c?.path)).filter(Boolean);
  const patch = typeof i.input === 'string' ? i.input : typeof i.patch === 'string' ? i.patch : '';
  const out = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  return out;
}

/** The unified mini diff an edit's input strings describe: [{ sign: '+'|'-'|' '|'@', text }]. */
export function editDiff(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const lines = [];
  const pair = (o) => {
    for (const l of str(o?.old_string ?? o?.oldString).split('\n')) if (o?.old_string != null || o?.oldString != null) lines.push({ sign: '-', text: l });
    for (const l of str(o?.new_string ?? o?.newString).split('\n')) if (o?.new_string != null || o?.newString != null) lines.push({ sign: '+', text: l });
  };
  if (Array.isArray(i.edits)) {
    i.edits.forEach((e, n) => { if (n) lines.push({ sign: '@', text: '' }); pair(e); });
    return lines;
  }
  if ('new_string' in i || 'newString' in i || 'old_string' in i || 'oldString' in i) { pair(i); return lines; }
  const whole = typeof i.content === 'string' ? i.content : typeof i.new_source === 'string' ? i.new_source : null;
  if (whole != null) return whole.replace(/\n$/, '').split('\n').map(text => ({ sign: '+', text }));
  const patch = typeof i.input === 'string' ? i.input : typeof i.patch === 'string' ? i.patch : '';
  for (const line of patch.split('\n')) {
    if (/^\*\*\*|^\+\+\+|^---/.test(line)) { if (/File:/.test(line)) lines.push({ sign: '@', text: line.replace(/^\*+\s*/, '') }); continue; }
    if (line.startsWith('@@')) { lines.push({ sign: '@', text: line }); continue; }
    lines.push({ sign: line[0] === '+' || line[0] === '-' ? line[0] : ' ', text: line.slice(1) });
  }
  return lines;
}

// ── Plans ──────────────────────────────────────────────────────────────────

/** TodoWrite todos / Codex update_plan steps as { items: [{ text, active, status }], done, total, current }. */
export function planState(input) {
  const i = input && typeof input === 'object' ? input : {};
  const raw = Array.isArray(i.todos) ? i.todos : Array.isArray(i.plan) ? i.plan : [];
  const items = raw.filter(x => x && typeof x === 'object').map(x => ({
    text: str(x.content ?? x.step ?? x.text ?? x.title).trim(),
    active: str(x.activeForm ?? x.active_form).trim(),
    status: /complete|done/i.test(str(x.status)) ? 'completed' : /progress|active|running/i.test(str(x.status)) ? 'in_progress' : 'pending',
  }));
  const done = items.filter(x => x.status === 'completed').length;
  const now = items.find(x => x.status === 'in_progress') || items.find(x => x.status === 'pending') || items[items.length - 1] || null;
  return { items, done, total: items.length, current: now ? (now.status === 'in_progress' ? now.active || now.text : now.text) : '' };
}

// ── Web ────────────────────────────────────────────────────────────────────

/** host + path of a URL, no query or hash. */
export function urlSubject(url) {
  const s = str(url).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '';
    return `${u.host}${path}` || s;
  } catch { return clip(s, 80); }
}

// ── What a call says ───────────────────────────────────────────────────────

/**
 * The bubble for one call: { verb, text, detail?, mono, segments?, meta[], caption, copy, tag }.
 * `detail` (computer calls) is what the call's own row shows when it differs from the bubble's subject.
 * `call`: { name, kind, input, result, state, memories?, app? }.
 * `ctx`: { t, runLabel(call), runState(call), describeComputer(input, name) }.
 */
export function sayCall(call, ctx = {}) {
  const t = ctx.t || tFallback;
  const input = call?.input && typeof call.input === 'object' ? call.input : {};
  const p = parseToolName(call?.name);
  const kind = call?.kind || kindOf(call?.name, input);
  const out = { verb: KIND_SPECS[kind]?.verb || 'use', text: '', detail: undefined, mono: false, segments: null, meta: [], caption: '', copy: '', tag: '' };
  const result = str(call?.result);
  switch (kind) {
    case 'shell': {
      if (p.tool === 'bashoutput') { out.verb = 'check'; out.text = t('assistant.rack.say.shellOutput', 'output of shell {id}', { id: firstString(str(input.bash_id), str(input.shell_id), str(input.id)) || '?' }); break; }
      if (p.tool === 'killshell') { out.verb = 'stop'; out.text = t('assistant.rack.say.shellKill', 'a background command'); break; }
      const cmd = commandOf(input);
      out.verb = 'run';
      out.text = `$ ${summarizeCommand(cmd)}`;
      out.full = `$ ${str(cmd).replace(/\s+/g, ' ').trim()}`; // the literal line: the title and the opened bubble
      out.mono = true;
      out.copy = cmd;
      out.caption = firstString(input.description);
      if (input.run_in_background) out.tag = t('assistant.rack.say.background', 'background');
      break;
    }
    case 'read': {
      const path = firstString(input.file_path, input.filePath, input.path, input.notebook_path);
      const { base, dir } = splitPath(path);
      const offset = Number(input.offset);
      const limit = Number(input.limit);
      let range = '';
      if (offset > 0 && limit > 0) range = `:${offset}-${offset + limit}`;
      else if (offset > 0) range = `:${offset}`;
      else if (limit > 0) range = `:1-${limit}`;
      out.verb = 'read';
      out.mono = true;
      out.text = `${dir ? `${dir}/` : ''}${base}${range}`;
      out.segments = [...(dir ? [{ text: `${dir}/`, cls: 'dim' }] : []), { text: base, cls: 'strong' }, ...(range ? [{ text: range, cls: 'dim' }] : [])];
      out.copy = path;
      break;
    }
    case 'edit': {
      const paths = editPaths(input);
      const counts = editCounts(call?.name, input);
      out.verb = p.tool === 'write' ? 'write' : 'edit';
      out.mono = true;
      out.text = paths.length ? `${basename(paths[0])}${paths.length > 1 ? ` +${paths.length - 1}` : ''}` : toolWords(call?.name);
      out.copy = paths[0] || '';
      if (counts?.created) out.meta.push(plural(t, 'assistant.rack.say.newFile', counts.added, 'new file, 1 line', 'new file, {count} lines'));
      else if (counts && (counts.added || counts.removed)) out.meta.push(`+${counts.added} −${counts.removed}`);
      break;
    }
    case 'search': {
      const pattern = firstString(input.pattern, input.query, input.q);
      out.verb = 'search';
      out.mono = true;
      if (p.tool === 'ls' || p.tool === 'list') {
        out.verb = 'browse';
        out.text = firstString(input.path, input.dir, input.directory) || '.';
      } else {
        const scope = [];
        const where = firstString(input.path);
        if (where) scope.push(t('assistant.rack.say.in', 'in {path}', { path: `${splitPath(where).base}${/\.[A-Za-z0-9]+$/.test(where) ? '' : '/'}` }));
        const glob = firstString(input.glob, input.include);
        if (glob && p.tool !== 'glob') scope.push(glob);
        if (input['-i'] || input.case_insensitive || input.ignoreCase) scope.push('-i');
        out.text = [p.tool === 'glob' ? pattern : `"${pattern}"`, ...scope].filter(Boolean).join(' ');
      }
      const counts = searchCounts(result);
      if (counts) {
        if (counts.matches === 0 || counts.files === 0) out.meta.push(t('assistant.rack.say.noMatches', 'no matches'));
        else if (counts.matches != null && counts.files != null) out.meta.push(t('assistant.rack.say.matchesInFiles', '{matches} in {files}', { matches: plural(t, 'assistant.rack.say.matches', counts.matches, '1 match', '{count} matches'), files: plural(t, 'assistant.rack.say.files', counts.files, '1 file', '{count} files') }));
        else if (counts.matches != null) out.meta.push(plural(t, 'assistant.rack.say.matches', counts.matches, '1 match', '{count} matches'));
        else out.meta.push(plural(t, 'assistant.rack.say.files', counts.files, '1 file', '{count} files'));
      }
      break;
    }
    case 'web': {
      const tool = p.tool.replace(/^browser_/, '');
      // What a click lands on may be its visible text; a field is named by its label or ref, never by the value typed into it.
      const field = firstString(input.element, input.label, input.name, input.target, input.selector, input.ref);
      const target = firstString(input.element, input.text, input.name, input.label, input.target, input.selector, input.ref);
      if (p.tool === 'websearch' || tool === 'search') { out.verb = 'search'; out.text = `"${firstString(input.query, input.q)}"`; }
      else if (p.tool === 'webfetch' || tool === 'navigate' || tool === 'open') { out.verb = 'open'; out.text = urlSubject(firstString(input.url, input.href)); out.mono = true; out.copy = firstString(input.url, input.href); }
      else if (tool === 'click') { out.verb = 'click'; out.text = target; }
      else if (tool === 'type') { out.verb = 'type'; out.text = field; }
      else if (tool === 'fill') { out.verb = 'fill'; out.text = field; }
      else if (tool === 'hover') { out.verb = 'hover'; out.text = target; }
      else if (tool === 'select') { out.verb = 'select'; out.text = field; }
      else if (tool === 'press') { out.verb = 'press'; out.text = firstString(input.key, input.keys); out.mono = true; }
      else if (tool === 'upload') { out.verb = 'upload'; out.text = basename(firstString(input.path, input.file, ...(Array.isArray(input.paths) ? input.paths : []))); }
      else if (tool === 'snapshot' || tool === 'content') { out.verb = 'read'; out.text = t('assistant.rack.say.thePage', 'the page'); }
      else if (tool === 'screenshot') { out.verb = 'take'; out.text = t('assistant.rack.say.aScreenshot', 'a screenshot'); }
      else if (tool === 'console') { out.verb = 'read'; out.text = t('assistant.rack.say.theConsole', 'the console'); }
      else if (tool === 'scroll') { out.verb = 'scroll'; out.text = t('assistant.rack.say.thePage', 'the page'); }
      else if (tool === 'go_back') { out.verb = 'back'; }
      else if (tool === 'go_forward') { out.verb = 'forward'; }
      else if (tool === 'reload') { out.verb = 'reload'; out.text = t('assistant.rack.say.thePage', 'the page'); }
      else if (tool === 'wait') { out.verb = 'wait'; out.text = t('assistant.rack.say.forThePage', 'for the page'); }
      else { out.verb = 'use'; out.text = toolWords(call?.name); }
      break;
    }
    case 'subagent': {
      if (p.tool === 'taskstop') { out.verb = 'stop'; out.text = t('assistant.rack.say.backgroundTask', 'a background task'); break; }
      const type = firstString(input.subagent_type, input.agent, input.tool);
      const what = firstString(input.description) || firstLine(firstString(input.prompt));
      out.verb = 'delegate';
      out.text = clip(type && what ? `${type}: ${what}` : (what || type || t('assistant.rack.say.aSubagent', 'a subagent')), 60);
      break;
    }
    case 'plan': {
      if (p.tool === 'todoread') { out.verb = 'check'; out.text = t('assistant.rack.say.thePlan', 'the plan'); break; }
      const plan = planState(input);
      out.verb = 'plan';
      out.text = clip(plan.current || t('assistant.rack.say.thePlan', 'the plan'), 80);
      if (plan.total) out.meta.push(t('assistant.rack.say.planProgress', '{done} of {total}', { done: plan.done, total: plan.total }));
      break;
    }
    case 'memory': {
      if (call?.auto) {
        out.verb = 'recall';
        out.text = t('assistant.rack.say.autoRecall', 'context for this prompt');
        out.meta.push(plural(t, 'assistant.rack.say.found', (call.memories || []).length, '1 found', '{count} found'));
        break;
      }
      const tool = p.tool;
      const id8 = str(input.memory_id ?? input.id ?? input.memoryId).slice(0, 8);
      if (tool === 'recall') {
        out.verb = 'recall';
        out.text = `"${clip(firstString(input.query), 80)}"`;
        const n = call?.memories ? call.memories.length : recallCount(result);
        if (n != null && call?.state && call.state !== 'running') out.meta.push(plural(t, 'assistant.rack.say.found', n, '1 found', '{count} found'));
      } else if (tool === 'remember') {
        out.verb = 'save';
        out.text = clip(firstLine(input.content).replace(/^#+\s*/, ''), 80);
        if (input.category) out.meta.push(str(input.category));
      } else if (tool === 'reflect') { out.verb = 'update'; out.text = id8; out.mono = true; }
      else if (tool === 'forget') { out.verb = 'trash'; out.text = id8; out.mono = true; }
      else if (tool === 'restore') { out.verb = 'restore'; out.text = id8; out.mono = true; }
      else if (tool === 'memories') { out.verb = 'browse'; out.text = firstString(input.action) ? toolWords(input.action) : t('assistant.rack.say.memories', 'memories'); }
      else if (tool === 'sync') { out.verb = 'check'; out.text = t('assistant.rack.say.memoryFreshness', 'memory freshness'); }
      else { out.verb = 'update'; out.text = [t('assistant.rack.say.categories', 'categories'), firstString(input.name)].filter(Boolean).join(': '); }
      break;
    }
    case 'runs': {
      const tool = p.tool.replace(/^agent_/, '');
      const label = typeof ctx.runLabel === 'function' ? str(ctx.runLabel(call)) : '';
      const state = typeof ctx.runState === 'function' ? str(ctx.runState(call)) : '';
      if (tool === 'wait') { out.verb = 'waitOn'; out.text = label || t('assistant.rack.say.yourAgents', 'your agents'); }
      else if (tool === 'read' || tool === 'status' || tool === 'list') { out.verb = 'checkOn'; out.text = label || t('assistant.rack.say.yourAgents', 'your agents'); }
      else if (tool === 'dispatch') { out.verb = 'dispatch'; out.text = clip(firstLine(firstString(input.task, input.title, input.prompt)), 60) || t('assistant.rack.say.anAgent', 'an agent'); }
      else if (tool === 'route' || tool === 'catalog') { out.verb = 'pick'; out.text = t('assistant.rack.say.aModel', 'a model'); }
      else if (tool === 'send') { out.verb = 'message'; out.text = label || t('assistant.rack.say.anAgent', 'an agent'); }
      else if (tool === 'stop') { out.verb = 'stop'; out.text = label || t('assistant.rack.say.anAgent', 'an agent'); }
      else { out.verb = 'use'; out.text = toolWords(call?.name); }
      if (state) out.meta.push(state);
      break;
    }
    case 'computer': {
      // "Using TextEdit", the action below it; the call's own row keeps the action as its detail.
      const action = typeof ctx.describeComputer === 'function' ? str(ctx.describeComputer(input, call?.name)) : toolWords(call?.name);
      out.verb = 'use';
      out.text = str(call?.app) || t('assistant.rack.say.theComputer', 'the computer');
      out.detail = action;
      if (action) out.meta.push(action);
      break;
    }
    case 'think': {
      out.verb = 'think';
      const text = str(call?.text).replace(/\s+/g, ' ').trim();
      out.text = text ? (text.length > 80 ? `…${text.slice(-79)}` : text) : '…';
      out.muted = true;
      break;
    }
    default: {
      const arg = firstString(...Object.values(input));
      out.verb = 'use';
      out.text = `${toolWords(call?.name)}${arg ? ` “${clip(arg, 60)}”` : ''}`;
    }
  }
  out.text = str(out.text);
  if (!out.copy && out.mono) out.copy = out.text;
  return out;
}

/**
 * What a call acts on, as a comparable key: the command, the file, the
 * pattern, the page… Two calls with the same key are a re-run or a re-read
 * (the bubble's ×N); '' when the call names no target.
 */
export function targetKey(call) {
  const i = call?.input && typeof call.input === 'object' ? call.input : {};
  const kind = call?.kind || kindOf(call?.name, i);
  const tool = parseToolName(call?.name).tool;
  switch (kind) {
    case 'shell': return commandOf(i).replace(/\s+/g, ' ').trim();
    case 'read': return firstString(i.file_path, i.filePath, i.path, i.notebook_path);
    case 'edit': return editPaths(i).join('\n');
    case 'search': return [tool, firstString(i.pattern, i.query, i.q), firstString(i.path), firstString(i.glob, i.include)].join('\u0001');
    case 'web': return [tool, firstString(i.url, i.href, i.query, i.q, i.element, i.ref, i.selector, i.key)].join('\u0001');
    case 'memory': return call?.auto ? '' : [tool, firstString(i.query, i.memory_id, i.id, i.content, i.action)].join('\u0001');
    case 'think': case 'plan': return '';
    default: {
      let json = '';
      try { json = JSON.stringify(i); } catch { json = ''; }
      return json && json !== '{}' ? `${tool}\u0001${json}` : '';
    }
  }
}

/**
 * The subject parallel calls of one kind share: "a.js, b.js +1" for reads and
 * edits, "$ npm test +1" for commands; "server.js ×2" for a re-read.
 * `calls`: the calls running side by side (the bubble's own call last);
 * `all`: every call of the row (for re-reads). Empty when one subject says it.
 */
export function groupSubject(kind, calls, all = calls) {
  const list = (calls || []).filter(Boolean);
  if (!list.length) return '';
  const nameOf = (c) => {
    const i = c.input || {};
    if (kind === 'read' || kind === 'edit') return basename(firstString(i.file_path, i.filePath, i.path, i.notebook_path, ...editPaths(i)));
    if (kind === 'search') { const p = firstString(i.pattern, i.query); return p ? `"${p}"` : ''; }
    if (kind === 'web') return urlSubject(firstString(i.url, i.href)) || (firstString(i.query) ? `"${firstString(i.query)}"` : '');
    if (kind === 'memory') { const q = firstString(i.query); return q ? `"${q}"` : ''; }
    return '';
  };
  if (list.length >= 2) {
    if (kind === 'shell') {
      const cmd = commandOf(list[list.length - 1].input);
      return cmd ? `$ ${summarizeCommand(cmd)} +${list.length - 1}` : '';
    }
    const names = [...new Set(list.map(nameOf).filter(Boolean))];
    if (names.length >= 2) return `${names[0]}, ${names[1]}${names.length > 2 ? ` +${names.length - 2}` : ''}`;
  }
  if (kind === 'read') {
    const name = nameOf(list[list.length - 1]);
    const again = name ? (all || []).filter(c => nameOf(c) === name).length : 0;
    if (again > 1) return `${name} ×${again}`;
  }
  return '';
}

// ── Rows and receipts ──────────────────────────────────────────────────────

const pathSet = (calls, pick) => new Set(calls.flatMap(pick).filter(Boolean));
const readPaths = (c) => [firstString(c.input?.file_path, c.input?.filePath, c.input?.path, c.input?.notebook_path)];

function editTotals(calls) {
  let added = 0; let removed = 0; let known = false;
  for (const c of calls) {
    const counts = editCounts(c.name, c.input);
    if (!counts) continue;
    known = true;
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed, known };
}

/** Numbers a row or receipt reports for a kind. */
export function kindStats(kind, calls, ctx = {}) {
  const list = (calls || []).filter(Boolean);
  const stats = { count: list.length, failed: list.filter(c => c.state === 'error').length, neutral: list.filter(c => c.state === 'neutral').length };
  if (kind === 'read') stats.files = pathSet(list, readPaths).size || list.length;
  if (kind === 'edit') { stats.files = pathSet(list, c => editPaths(c.input)).size || list.length; Object.assign(stats, editTotals(list)); }
  if (kind === 'plan') { const last = [...list].reverse().find(c => parseToolName(c.name).tool !== 'todoread'); const plan = planState(last?.input); stats.done = plan.done; stats.total = plan.total; }
  if (kind === 'web') {
    const tools = list.map(c => parseToolName(c.name).tool.replace(/^browser_/, ''));
    stats.pages = tools.filter(x => x === 'webfetch' || x === 'navigate' || x === 'open').length;
    stats.searches = tools.filter(x => x === 'websearch' || x === 'search').length;
    stats.actions = list.length - stats.pages - stats.searches;
  }
  if (kind === 'memory') {
    const tools = list.map(c => (c.auto ? 'recall' : parseToolName(c.name).tool));
    for (const k of ['recall', 'remember', 'reflect', 'forget', 'restore']) stats[k] = tools.filter(x => x === k).length;
    stats.other = list.length - stats.recall - stats.remember - stats.reflect - stats.forget - stats.restore;
  }
  if (kind === 'runs') {
    const tools = list.map(c => parseToolName(c.name).tool.replace(/^agent_/, ''));
    stats.dispatched = tools.filter(x => x === 'dispatch').length;
    stats.checked = tools.filter(x => ['wait', 'read', 'status', 'list'].includes(x)).length;
    stats.other = list.length - stats.dispatched - stats.checked;
  }
  if (kind === 'computer') stats.app = [...list].reverse().map(c => c.app).find(Boolean) || '';
  if (kind === 'think') {
    const timed = list.filter(c => c.endedAt > 0 && c.startedAt > 0 && c.timed !== false);
    stats.ms = timed.length === list.length && list.length ? timed.reduce((sum, c) => sum + Math.max(0, c.endedAt - c.startedAt), 0) : null;
  }
  if (kind === 'mcp') stats.server = ctx.server || (list[0] ? mcpServerOf(list[0].name) : '');
  return stats;
}

/** The row's aggregate: "4 commands, 1 failed". */
export function stationAggregate(kind, calls, ctx = {}) {
  const t = ctx.t || tFallback;
  const s = kindStats(kind, calls, ctx);
  let main;
  switch (kind) {
    case 'shell': main = plural(t, 'assistant.rack.agg.shell', s.count, '1 command', '{count} commands'); break;
    case 'read': main = plural(t, 'assistant.rack.agg.files', s.files, '1 file', '{count} files'); break;
    case 'edit': main = plural(t, 'assistant.rack.agg.files', s.files, '1 file', '{count} files'); break;
    case 'search': main = plural(t, 'assistant.rack.agg.search', s.count, '1 pattern', '{count} patterns'); break;
    case 'web': main = plural(t, 'assistant.rack.agg.web', s.count, '1 step', '{count} steps'); break;
    case 'subagent': main = plural(t, 'assistant.rack.agg.subagent', s.count, '1 agent', '{count} agents'); break;
    case 'plan': main = s.total ? t('assistant.rack.agg.plan', '{done} of {total} done', { done: s.done, total: s.total }) : plural(t, 'assistant.rack.agg.calls', s.count, '1 call', '{count} calls'); break;
    case 'computer': main = plural(t, 'assistant.rack.agg.computer', s.count, '1 action', '{count} actions'); break;
    case 'think': main = plural(t, 'assistant.rack.agg.think', s.count, '1 thought', '{count} thoughts'); break;
    default: main = plural(t, 'assistant.rack.agg.calls', s.count, '1 call', '{count} calls');
  }
  const parts = [main];
  if (s.failed) parts.push(t('assistant.rack.agg.failed', '{count} failed', { count: s.failed }));
  return parts.join(', ');
}

/** Receipt phrases for one kind, lowercase-first ("ran 4 commands"); receiptSentence joins and capitalises them. */
export function receiptPhrases(kind, calls, ctx = {}) {
  const t = ctx.t || tFallback;
  const s = kindStats(kind, calls, ctx);
  const out = [];
  switch (kind) {
    case 'shell': out.push(plural(t, 'assistant.rack.receipt.shell', s.count, 'ran 1 command', 'ran {count} commands')); break;
    case 'read': out.push(plural(t, 'assistant.rack.receipt.read', s.files, 'read 1 file', 'read {count} files')); break;
    case 'edit':
      out.push(s.known && (s.added || s.removed)
        ? plural(t, 'assistant.rack.receipt.editLines', s.files, 'edited 1 file (+{added} −{removed})', 'edited {count} files (+{added} −{removed})', { added: s.added, removed: s.removed })
        : plural(t, 'assistant.rack.receipt.edit', s.files, 'edited 1 file', 'edited {count} files'));
      break;
    case 'search': out.push(plural(t, 'assistant.rack.receipt.search', s.count, 'searched 1 pattern', 'searched {count} patterns')); break;
    case 'web':
      if (s.pages) out.push(plural(t, 'assistant.rack.receipt.webPages', s.pages, 'visited 1 page', 'visited {count} pages'));
      if (s.searches) out.push(plural(t, 'assistant.rack.receipt.webSearches', s.searches, 'searched the web once', 'searched the web {count} times'));
      if (s.actions) out.push(plural(t, 'assistant.rack.receipt.webActions', s.actions, 'used the browser once', 'used the browser {count} times'));
      break;
    case 'subagent': out.push(plural(t, 'assistant.rack.receipt.subagent', s.count, 'ran 1 agent', 'ran {count} agents')); break;
    case 'plan':
      out.push(s.total
        ? plural(t, 'assistant.rack.receipt.plan', s.total, 'finished {done} of 1 plan step', 'finished {done} of {count} plan steps', { done: s.done })
        : plural(t, 'assistant.rack.receipt.planChecked', s.count, 'checked the plan', 'checked the plan {count} times'));
      break;
    case 'memory':
      if (s.recall) out.push(plural(t, 'assistant.rack.receipt.recalled', s.recall, 'recalled once', 'recalled {count} times'));
      if (s.remember) out.push(plural(t, 'assistant.rack.receipt.saved', s.remember, 'saved 1 memory', 'saved {count} memories'));
      if (s.reflect) out.push(plural(t, 'assistant.rack.receipt.updated', s.reflect, 'updated 1 memory', 'updated {count} memories'));
      if (s.forget) out.push(plural(t, 'assistant.rack.receipt.trashed', s.forget, 'trashed 1 memory', 'trashed {count} memories'));
      if (s.restore) out.push(plural(t, 'assistant.rack.receipt.restored', s.restore, 'restored 1 memory', 'restored {count} memories'));
      if (s.other) out.push(plural(t, 'assistant.rack.receipt.memoryOther', s.other, 'used memory once', 'used memory {count} times'));
      break;
    case 'runs':
      if (s.dispatched) out.push(plural(t, 'assistant.rack.receipt.dispatched', s.dispatched, 'dispatched 1 agent', 'dispatched {count} agents'));
      if (s.checked) out.push(plural(t, 'assistant.rack.receipt.checked', s.checked, 'checked once', 'checked {count} times'));
      if (s.other) out.push(plural(t, 'assistant.rack.receipt.runsOther', s.other, 'used agent tools once', 'used agent tools {count} times'));
      break;
    case 'computer':
      out.push(s.app
        ? plural(t, 'assistant.rack.receipt.computerApp', s.count, 'used {app} for 1 action', 'used {app} for {count} actions', { app: s.app })
        : plural(t, 'assistant.rack.receipt.computer', s.count, 'used the computer for 1 action', 'used the computer for {count} actions'));
      break;
    case 'think': {
      const time = s.ms != null ? fmtDuration(s.ms, t) : '';
      out.push(time
        ? t('assistant.rack.receipt.think', 'thought for {time}', { time })
        : plural(t, 'assistant.rack.receipt.thinkCount', s.count, 'thought once', 'thought {count} times'));
      break;
    }
    default:
      out.push(plural(t, 'assistant.rack.receipt.mcp', s.count, 'used {server} once', 'used {server} {count} times', { server: prettyServer(s.server) }));
  }
  return out;
}

/** "claude_ai_Claude_Docs" → "claude ai Claude Docs"; "SynaBun" stays. */
export function prettyServer(name) {
  return str(name).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'tool';
}

const listFormats = new Map();

/** Join phrases like "Ran 4 commands, read 3 files, searched 2 patterns" (Intl.ListFormat conjunction, narrow). */
export function joinPhrases(phrases, locale = 'en') {
  const list = (phrases || []).filter(Boolean);
  if (!list.length) return '';
  let joined;
  try {
    let format = listFormats.get(locale);
    if (!format) { format = new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' }); listFormats.set(locale, format); }
    joined = format.format(list);
  } catch { joined = list.join(', '); }
  return capitalize(joined);
}

/** Receipt order by weight: kinds with a failure, then commands, edits, reads, searches, web, memory, the plan, the rest. */
export const RECEIPT_ORDER = Object.freeze(['shell', 'edit', 'read', 'search', 'web', 'memory', 'plan']);
/** A receipt says this many clauses, then "and N more". */
export const RECEIPT_CLAUSES = 3;

/**
 * The settled receipt: `groups` = [{ kind, calls, server? }] in ledger order.
 * "Ran 4 commands, read 3 files, searched 2 patterns"; weighted (a failed
 * kind first) and capped at three clauses: "… and 2 more".
 */
export function receiptSentence(groups, ctx = {}) {
  const t = ctx.t || tFallback;
  const weight = (g) => {
    const at = RECEIPT_ORDER.indexOf(g.kind);
    return ((g.calls || []).some(c => c?.state === 'error') ? 0 : 100) + (at >= 0 ? at : 50);
  };
  const ordered = (groups || []).filter(Boolean).map((g, i) => ({ g, i, w: weight(g) })).sort((a, b) => a.w - b.w || a.i - b.i);
  const phrases = ordered.flatMap(({ g }) => receiptPhrases(g.kind, g.calls, { ...ctx, server: g.server }));
  if (phrases.length <= RECEIPT_CLAUSES) return joinPhrases(phrases, ctx.locale || 'en');
  const rest = phrases.length - RECEIPT_CLAUSES;
  const list = joinPhrases(phrases.slice(0, RECEIPT_CLAUSES), ctx.locale || 'en');
  return plural(t, 'assistant.rack.receipt.more', rest, '{list} and 1 more', '{list} and {count} more', { list });
}

/** Under this a duration says nothing ("0.0 s" is noise, or two journal lines with one timestamp). */
export const MIN_SHOWN_MS = 100;

/** "0.4 s", "19 s", "2 min 5 s", "1 h 3 min". Empty for an unknown duration or one under 0.1 s. */
export function fmtDuration(ms, t = tFallback) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < MIN_SHOWN_MS) return '';
  if (n < 950) return t('assistant.rack.time.seconds', '{n} s', { n: (n / 1000).toFixed(1) });
  const secs = Math.round(n / 1000);
  if (secs < 60) return t('assistant.rack.time.seconds', '{n} s', { n: secs });
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    const rest = secs % 60;
    return rest ? t('assistant.rack.time.minutes', '{m} min {s} s', { m: mins, s: rest }) : t('assistant.rack.time.minutesOnly', '{m} min', { m: mins });
  }
  return t('assistant.rack.time.hours', '{h} h {m} min', { h: Math.floor(mins / 60), m: mins % 60 });
}
