// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link: the owner's slash commands
// ═══════════════════════════════════════════
//
// Pure parsing and fixed texts. A command is the owner's own typed text —
// never a forwarded or quoted message, never a voice note — that starts with
// one of COMMANDS (case-insensitive). Commands run at once, busy or paused.
// Any other "/x" is a prompt; "//x" sends the literal "/x". No command raises the level or
// changes a setting: those names get a fixed refusal (they would otherwise
// reach the brain's CLI as its own slash commands).

export const COMMANDS = Object.freeze(['help', 'status', 'stop', 'new', 'pause', 'resume', 'cards']);
const COMMAND_SET = new Set(COMMANDS);
// Settings, levels and the CLI's own configuration commands: never from a phone.
const REFUSED = new Set([
  'level', 'autonomous', 'auto', 'allow', 'approve', 'bypass', 'yolo', 'trust', 'unlock', 'raise',
  'settings', 'setting', 'config', 'configure', 'mode', 'permissions', 'permission', 'sandbox', 'computer',
  'model', 'login', 'logout', 'add-dir', 'mcp', 'hooks', 'agents', 'plugin', 'plugins', 'install', 'upgrade',
  'output-style', 'privacy-settings', 'terminal-setup', 'statusline', 'ide', 'vim',
]);

export const HELP_TEXT = [
  '*SynaBun on WhatsApp*',
  'Write to me like you would in SynaBun. Pictures work too, and voice notes when this computer can transcribe them.',
  '',
  '/status — what I am doing, spend and level',
  '/stop — stop the current task, its agents and anything waiting for your answer',
  '/new — start a fresh conversation',
  '/pause — stop acting on messages until /resume',
  '/resume — act on messages again',
  '/cards — ask again what is still waiting for your answer',
  '/help — this list',
  '',
  'When I ask something, just answer in your own words. An approval takes a plain yes or no, typed; any other message (a voice note too) approves nothing and carries on the conversation. Start with // to send text that begins with a slash.',
  'Levels, models and other settings change only in SynaBun on your computer (Settings → WhatsApp).',
].join('\n');

export const SETTINGS_REFUSAL = 'Settings change only in SynaBun on your computer (Settings → WhatsApp). Nothing was changed.';

/**
 * An inbound message → { kind: 'command', name, args } | { kind: 'refused', name }
 * | { kind: 'literal', text } ("//x" → "/x") | null (not a command: a prompt).
 * Only the owner's own typed text counts: forwarded or quoted messages and voice notes are prompts.
 */
export function parseCommand(message) {
  if (!message || message.owner === false || message.forwarded || message.quoted || message.voice === true) return null;
  const text = String(message.text ?? '').trim();
  if (!text.startsWith('/')) return null;
  if (text.startsWith('//')) return { kind: 'literal', text: text.slice(1) };
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = (match[2] || '').trim();
  if (COMMAND_SET.has(name)) return { kind: 'command', name, args };
  if (REFUSED.has(name)) return { kind: 'refused', name };
  return null;
}

const usd = (value) => `$${(Number(value) || 0).toFixed(2)}`;
function levelLabel(level) {
  if (level === 'read-only') return 'Read-only';
  if (level === 'autonomous') return 'Autonomous';
  if (level === 'ask') return 'Ask on my phone';
  return level ? String(level) : 'unknown';
}

/**
 * /status text from a snapshot: { connected, sessionId, title, brain:{provider,model},
 * running, turnKind, queued, pendingCards, currentCard, budget:{ unlimited, totalUsd, amountUsd, leftUsd },
 * brainUsd, level, paused, pausedBy }. Autonomous has no time limit: it holds until it is turned off in Settings.
 */
export function statusText(s = {}) {
  const lines = ['*SynaBun status*'];
  lines.push(`WhatsApp: ${s.connected === false ? 'reconnecting' : 'connected'}`);
  if (s.sessionId) {
    const brain = s.brain?.provider ? `${s.brain.provider}${s.brain.model ? ` / ${s.brain.model}` : ''}` : 'default brain';
    lines.push(`Conversation: ${s.title || 'WhatsApp'} (${brain})`);
  } else {
    lines.push('Conversation: none yet (your next message starts one)');
  }
  const doing = s.running
    ? (s.turnKind === 'external' ? 'working on a request from your computer' : s.turnKind === 'mailbox' || s.turnKind === 'background' ? 'reading agent results' : 'working on your message')
    : 'idle';
  lines.push(`Now: ${doing}${s.queued ? ` · ${s.queued} message${s.queued === 1 ? '' : 's'} queued` : ''}`);
  if (s.pendingCards) lines.push(`Waiting for you: ${s.pendingCards} question${s.pendingCards === 1 ? '' : 's'} or approval${s.pendingCards === 1 ? '' : 's'}${s.currentCard ? ` (${s.currentCard})` : ''} — /cards asks again`);
  if (s.budget?.unlimited === true) lines.push(`Spend: ${usd(s.budget.totalUsd)} (no limit)`);
  else if (s.budget && Number.isFinite(Number(s.budget.amountUsd))) lines.push(`Spend: ${usd(s.budget.totalUsd)} of the ${usd(s.budget.amountUsd)} budget${Number.isFinite(Number(s.brainUsd)) ? ` (brain ${usd(s.brainUsd)})` : ''}`);
  lines.push(`Level: ${levelLabel(s.level)}${s.level === 'autonomous' ? ' until turned off' : ''}`);
  if (s.paused) lines.push(`Paused${s.pausedBy === 'desktop' ? ' from your computer' : ''} — ${s.pausedBy === 'desktop' ? 'resume it in SynaBun' : 'send /resume'}`);
  return lines.join('\n');
}
