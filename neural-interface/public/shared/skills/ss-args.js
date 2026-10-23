// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: a skill's arguments, as Claude Code fills them
// ═══════════════════════════════════════════
//
// When a panel hands a SKILL.md to a model itself (a skill the runtime cannot see, server.js
// maybeInjectSkillPrompt), the body is filled the way Claude Code fills it (code.claude.com/docs/en/skills,
// "Available string substitutions", read 2026-10-21):
//   $ARGUMENTS          the argument text as typed; when nothing in the body takes the arguments, Claude Code
//                       adds "ARGUMENTS: <text>" at the end instead
//   $ARGUMENTS[N], $N   the Nth argument, counted from 0 ($0 is the first); a quoted phrase is one argument;
//                       one that is not there stays as written
//   $name               an argument named in the frontmatter's `arguments` (in that order); empty when missing
//   \$...               a backslash keeps the placeholder as text (the backslash goes)
//   ${CLAUDE_SKILL_DIR} the skill's folder; ${CLAUDE_PROJECT_DIR} the project (when known); other ${CLAUDE_*}
//                       stay as written
// One pass over the text: what an argument brings in is never read again as a placeholder, so a "$&" or a
// "$ARGUMENTS" typed by the person reaches the model as they typed it. `$SKILL_DIR` (a convention of SynaBun's
// old bridges, not a runtime variable) is filled with the skill's folder too. No DOM.

/** The arguments as Claude Code counts them: split on white space, a "quoted phrase" or 'quoted phrase' is one. */
export function splitArguments(text) {
  const out = [];
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let item = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const quote = s[i];
      if (quote === '"' || quote === "'") {
        const close = s.indexOf(quote, i + 1);
        if (close > i) { item += s.slice(i + 1, close); i = close + 1; continue; }
      }
      item += s[i];
      i++;
    }
    out.push(item);
  }
  return out;
}

/** The names `arguments` declares (a space-separated text or a list), in order; [] for anything else. */
export function declaredArgumentNames(value) {
  const list = typeof value === 'string' ? value.split(/[\s,]+/) : (Array.isArray(value) ? value : []);
  return list.filter((n) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n.trim())).map((n) => n.trim());
}

// One regular expression for every placeholder, so the text is read once. Order matters inside the alternation:
// the escaped form first, then the longer names. Only an argument placeholder can be escaped: a backslash before
// ${CLAUDE_*} is not an escape (it stays, and the variable is filled).
const PLACEHOLDER = /\\\$(ARGUMENTS(?:\[\d+\])?|\d+|[A-Za-z_][A-Za-z0-9_]*)|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d+)|\$\{(CLAUDE_[A-Z_]+)\}|\$SKILL_DIR\b|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Fill a skill body.
 * @param {string} body the text after the frontmatter
 * @param {object} o
 * @param {string} [o.args] the argument text as typed (may be empty)
 * @param {string[]|string} [o.declared] the frontmatter's `arguments`
 * @param {string} [o.skillDir] the skill's folder
 * @param {string} [o.projectDir] the project folder, when known
 * @param {string} [o.emptyArguments] what $ARGUMENTS reads when nothing was typed (Claude Code: ''; SynaBun's panels
 *   say "(none)" so the instructions read as meant)
 * @returns {{ text: string, consumed: boolean }} `consumed`: a placeholder took the arguments
 */
export function renderSkillBody(body, { args = '', declared = [], skillDir = '', projectDir = '', emptyArguments = '' } = {}) {
  const text = String(body ?? '');
  const typed = String(args ?? '');
  const items = splitArguments(typed);
  const names = declaredArgumentNames(declared);
  let consumed = false;
  const out = text.replace(PLACEHOLDER, (whole, escaped, indexed, positional, claudeVar, name) => {
    if (escaped !== undefined) {
      const placeholder = /^ARGUMENTS(?:\[\d+\])?$/.test(escaped) || /^\d+$/.test(escaped) || names.includes(escaped);
      return placeholder ? `$${escaped}` : whole;
    }
    if (indexed !== undefined) { const v = items[Number(indexed)]; if (v === undefined) return whole; consumed = true; return v; }
    if (positional !== undefined) { const v = items[Number(positional)]; if (v === undefined) return whole; consumed = true; return v; }
    if (claudeVar !== undefined) {
      if (claudeVar === 'CLAUDE_SKILL_DIR' && skillDir) return skillDir;
      if (claudeVar === 'CLAUDE_PROJECT_DIR' && projectDir) return projectDir;
      return whole;
    }
    if (whole === '$ARGUMENTS') { consumed = true; return typed.trim() ? typed : emptyArguments; }
    if (whole === '$SKILL_DIR') return skillDir || whole;
    if (name !== undefined) {
      const at = names.indexOf(name);
      if (at < 0) return whole;
      consumed = true;
      return items[at] ?? '';
    }
    return whole;
  });
  if (!consumed && typed.trim()) return { text: `${out}${out.endsWith('\n') ? '' : '\n'}\nARGUMENTS: ${typed}`, consumed: false };
  return { text: out, consumed };
}
