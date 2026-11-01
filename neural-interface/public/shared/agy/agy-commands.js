// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: slash commands and @ mentions (no DOM)
// ═══════════════════════════════════════════
//
// Two kinds of slash command meet in the composer: the agent's own (ACP
// `available_commands_update`: Antigravity's /plan, /goal, /compact …, sent to it
// as the text of a prompt) and the panel's (/new, /sessions, /rename …, run here).
// An agent command wins a name both have: it is Antigravity's own behaviour, and
// every panel action stays one click away. `@` followed by a path fragment asks
// for a project file; the chosen one is attached to the message (ACP resource_link)
// and its path stays in the text.

/**
 * The panel's commands. `key` is the agy-copy.js key of the description; `needs` names a capability the panel
 * must have for it ('fork', 'logout', 'sessions'); `hint` is shown after the name.
 */
export const PANEL_COMMANDS = Object.freeze([
  { name: 'new', key: 'cmdNew' },
  { name: 'sessions', key: 'cmdSessions' },
  { name: 'rename', key: 'cmdRename', hint: 'name' },
  { name: 'fork', key: 'cmdFork', needs: 'fork' },
  { name: 'retry', key: 'cmdRetry' },
  { name: 'copy', key: 'cmdCopy' },
  { name: 'model', key: 'cmdModel' },
  { name: 'mode', key: 'cmdMode' },
  { name: 'thinking', key: 'cmdThinking' },
  { name: 'detail', key: 'cmdDetail', hint: 'compact | standard | verbose' },
  { name: 'settings', key: 'cmdSettings' },
  { name: 'login', key: 'cmdLogin' },
  { name: 'logout', key: 'cmdLogout', needs: 'logout' },
  { name: 'help', key: 'cmdHelp' },
]);

export const DETAIL_LEVELS = Object.freeze(['compact', 'standard', 'verbose']);

/** "/name args" → { name, args } (name lower-cased), or null when the text is not one command. */
export function parseSlash(text) {
  const match = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

/**
 * What a typed message does: { kind: 'agent' } (sent to Antigravity as typed: plain text, an agent command or an
 * unknown one), or { kind: 'panel', name, args } for a panel command the agent does not also have.
 */
export function resolveSlash(text, { agentCommands = [], available = () => true } = {}) {
  const parsed = parseSlash(text);
  if (!parsed) return { kind: 'agent' };
  if ((agentCommands || []).some((command) => String(command?.name || '').toLowerCase() === parsed.name)) return { kind: 'agent' };
  const panel = PANEL_COMMANDS.find((command) => command.name === parsed.name);
  if (!panel || (panel.needs && !available(panel.needs))) return { kind: 'agent' };
  return { kind: 'panel', name: panel.name, args: parsed.args };
}

/**
 * The slash menu for what the composer holds: while it is "/" plus the start of one command name, the commands
 * whose name starts with it (panel first, then the agent's; a panel command the agent also has is left out).
 * → { query, items: [{ name, source: 'panel' | 'agent', key?, description?, hint }] } or null.
 */
export function slashMenu(text, { agentCommands = [], available = () => true, max = 80 } = {}) {
  const match = /^\/([\w:.-]*)$/.exec(String(text ?? ''));
  if (!match) return null;
  const query = match[1].toLowerCase();
  const agent = (agentCommands || []).filter((command) => command && typeof command.name === 'string');
  const agentNames = new Set(agent.map((command) => command.name.toLowerCase()));
  const starts = (name) => name.toLowerCase().startsWith(query);
  const items = [
    ...PANEL_COMMANDS.filter((command) => !agentNames.has(command.name) && (!command.needs || available(command.needs)) && starts(command.name))
      .map((command) => ({ name: command.name, source: 'panel', key: command.key, hint: command.hint || '' })),
    ...agent.filter((command) => starts(command.name))
      .map((command) => ({ name: command.name, source: 'agent', description: command.description || '', hint: command.hint || '' })),
  ].slice(0, max);
  return { query, items };
}

/** The text a chosen menu entry leaves in the composer: "/name " (a space, so its argument can follow). */
export function slashInsert(item) {
  return `/${item?.name || ''} `;
}

/**
 * The @ mention the caret is in: `@` at the start or after whitespace, then a path fragment up to the caret.
 * → { start, end, query } (start: the index of '@'), or null.
 */
export function mentionAt(text, caret) {
  const value = String(text ?? '');
  const at = Number.isInteger(caret) ? Math.max(0, Math.min(caret, value.length)) : value.length;
  const before = value.slice(0, at);
  const match = /(^|\s)@([^\s@]{0,200})$/.exec(before);
  if (!match) return null;
  const start = at - match[2].length - 1;
  return { start, end: at, query: match[2] };
}

/** The composer after a file was picked for a mention: "@relative/path " in place of "@query". → { text, caret }. */
export function applyMention(text, mention, relativePath) {
  const value = String(text ?? '');
  const insert = `@${relativePath} `;
  const next = value.slice(0, mention.start) + insert + value.slice(mention.end).replace(/^\s+/, '');
  return { text: next, caret: mention.start + insert.length };
}

/** A project-relative path joined to the project folder (either separator; never leaves the folder). */
export function joinProjectPath(project, relativePath) {
  const root = String(project || '').replace(/[\\/]+$/, '');
  const rel = String(relativePath || '').replace(/^[\\/]+/, '');
  if (!root || !rel || rel.split(/[\\/]/).some((part) => part === '..')) return '';
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root}${sep}${rel.replace(/[\\/]/g, sep)}`;
}

/** A path shown relative to the project when it is inside it, else as it is. */
export function relativeToProject(project, path) {
  const root = String(project || '').replace(/[\\/]+$/, '');
  const value = String(path || '');
  if (root && (value === root)) return '.';
  if (root && (value.startsWith(`${root}/`) || value.startsWith(`${root}\\`))) return value.slice(root.length + 1);
  return value;
}
