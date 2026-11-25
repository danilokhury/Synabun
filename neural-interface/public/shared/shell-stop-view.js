// What a Stop that could not end a command in the background says, in the OpenCode side panel and the Assistant
// panel alike. DOM-free, no imports (node --test loads it). SHELL_STOP_COPY is the English and must equal
// `shellStop.*` in i18n/*.json (tests/opencode-stop-anyway.test.mjs checks it).
//
// The server's answer to a failed Stop (server.js message:abort, lib/assistant-runtime.js stopTurn) carries
// `shells: [{ id, command, reason }]`, `failures` (how many Stops of this turn failed) and `canForce` (from the second
// one on): "Stop anyway" is offered then. A Stop anyway that ended the turn while a command may still run answers
// `abandoned: [{ id, command }]`.

export const SHELL_STOP_COPY = Object.freeze({
  failed: 'Stop could not end {commands} ({reason}). It is still running, so this turn goes on. Press Stop again.',
  failedAgain: 'Stop could not end {commands} again ({reason}). It is still running. Press Stop again, or Stop anyway to end this turn here.',
  anyway: 'Stop anyway',
  abandoned: 'Turn stopped. {commands} may still be running on this machine: SynaBun keeps trying to end it in the background.',
  unknownReason: 'no reason given',
});

const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : `{${key}}`));

/** The string `key` in the active locale through `translate(key, vars)` (a missing key comes back as itself), else the English. */
export function shellStopText(key, vars = {}, translate = null) {
  const full = `shellStop.${key}`;
  let said = null;
  try { said = typeof translate === 'function' ? translate(full, vars) : null; } catch { said = null; }
  if (typeof said === 'string' && said && said !== full) return said;
  return fill(SHELL_STOP_COPY[key] ?? '', vars);
}

const named = (shells) => (Array.isArray(shells) ? shells : [])
  .map((shell) => String(shell?.command || shell?.id || '').trim())
  .filter(Boolean)
  .map((name) => `“${name.length > 80 ? `${name.slice(0, 79)}…` : name}”`)
  .join(', ');

/**
 * A failed Stop's answer → `{ message, canForce }`, or null when the answer is no such failure. An answer of a server
 * from before this (no `shells`) keeps its own sentence.
 */
export function describeStopFailure(result, translate = null) {
  if (!result || (result.code !== 'SHELL_STOP_FAILED' && result.code !== 'STOP_FAILED')) return null;
  const shells = Array.isArray(result.shells) ? result.shells : [];
  const canForce = result.canForce === true;
  if (!shells.length) {
    const fallback = String(result.error || result.message || '').trim();
    return { message: fallback || shellStopText('failed', { commands: '—', reason: shellStopText('unknownReason', {}, translate) }, translate), canForce };
  }
  const reasons = [...new Set(shells.map((shell) => String(shell?.reason || '').trim()).filter(Boolean))].join('; ');
  const vars = { commands: named(shells), reason: reasons || shellStopText('unknownReason', {}, translate) };
  return { message: shellStopText(canForce ? 'failedAgain' : 'failed', vars, translate), canForce };
}

// Words in front of the program that are not it: a variable set for the command, and the runners that start another.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RUNNERS = new Set(['sudo', 'env', 'nohup', 'time', 'exec', 'command', 'nice', 'caffeinate', 'stdbuf', 'timeout']);
// A shell's own words (a loop, a test): no program is named by them, so the command is "a command".
const SHELL_WORDS = new Set(['for', 'while', 'until', 'if', 'case', 'select', 'function', 'do', 'then']);

/**
 * The program a command line starts, by its name only (`npm`, `curl`): what a place outside the machine (a phone, a
 * run's result, a memory) may be told. Nothing after it (arguments, a URL, a header, a token) and nothing before it
 * (`TOKEN=… cmd`, `sudo`) is kept, nor a folder. A name that is not plainly a program's is `''`.
 */
export function commandProgram(command) {
  const words = String(command || '').trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words.length && (ASSIGNMENT.test(words[index]) || RUNNERS.has(words[index]) || /^-/.test(words[index]) || (index > 0 && /^\d+[smhd]?$/.test(words[index])))) index += 1;
  const word = (words[index] || '').replace(/^["'(]+|["');&|]+$/g, '');
  const name = word.split(/[\\/]/).pop() || '';
  if (SHELL_WORDS.has(name)) return '';
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(name) ? name : '';
}

/** The program names of `shells` (`{ command }`), each once, in order; a command whose name is unclear is "a command". */
export function abandonedPrograms(shells) {
  const names = (Array.isArray(shells) ? shells : []).map((shell) => commandProgram(shell?.command) || 'command');
  return [...new Set(names)];
}

/** A Stop anyway's answer → the sentence about the commands that may still run, or null when none was left. */
export function describeAbandoned(abandoned, translate = null) {
  const commands = named(abandoned);
  return commands ? shellStopText('abandoned', { commands }, translate) : null;
}
