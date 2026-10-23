// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: what is wrong with a skill, a command or an agent
// ═══════════════════════════════════════════
//
// The checks run on what ss-frontmatter.js parse() read. Each problem names its rule, its severity and its
// line. An error is a file a runtime will misread (YAML that does not parse, a name that is not text, an
// agent without a description); a warning is one it will read but that is likely wrong (no description, a
// name that does not match its folder). Nothing here is decided by truthiness: an empty string, a number or
// a list where text belongs are each said for what they are.
//
// Profile: Claude Code (the folders the Studio edits). The limits that the portable Agent Skills format and
// Codex enforce too (64-character names, 1024-character descriptions) are errors here as well, so a skill that
// passes can be carried to the other runtimes. No DOM.

import { findHiddenChars, inspectName } from './ss-unicode.js';

export const LINT_PROFILE = 'claude-code-2026-10';
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BOOLEAN_KEYS = ['user-invocable', 'disable-model-invocation'];
const STRING_KEYS = ['argument-hint', 'model', 'color', 'license', 'compatibility', 'context', 'agent', 'effort', 'when_to_use', 'shell'];
const TOOL_KEYS = ['allowed-tools', 'disallowed-tools', 'tools'];

const kindOf = (value) => {
  if (value === undefined) return 'absent';
  if (value === null) return 'empty';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return typeof value === 'string' ? 'text' : `a ${typeof value}`;
};

/**
 * @param {object} o
 * @param {'skill' | 'command' | 'agent'} o.type
 * @param {object} o.parsed what ss-frontmatter.js parse() returned
 * @param {string} [o.folderName] a skill's folder, or a command's / agent's file name without `.md`
 * @param {string[]} [o.knownNames] names a skill must not pass for (the bundled ones)
 * @returns {{ profile: string, errors: object[], warnings: object[], infos: object[], all: object[] }}
 *   each problem `{ ruleId, severity, message, line }`
 */
export function lintArtifact({ type, parsed, folderName = '', knownNames = [] }) {
  const all = [];
  const add = (ruleId, severity, message, line = null) => all.push({ ruleId, severity, message, line });
  const lineOf = (key) => parsed?.keys?.find((k) => k.key === key)?.line ?? (parsed?.split?.startLine || 1);

  for (const d of parsed?.diagnostics || []) add(d.ruleId, d.severity, d.message, d.line);
  const data = parsed?.data;
  if (!parsed?.hasFrontmatter && !parsed?.split?.unterminated) {
    if (type === 'agent') add('fm-missing', 'error', 'An agent needs frontmatter with a name and a description.', 1);
    else if (type === 'skill') add('fm-missing', 'warning', 'No frontmatter: Claude takes the folder name and has no description to decide when to use the skill.', 1);
  }
  const has = (key) => !!data && Object.prototype.hasOwnProperty.call(data, key);
  // Without frontmatter, "fm-missing" says it all: the fields it would hold are not named one by one.
  const missingSaid = !parsed?.hasFrontmatter;

  if (data) {
    // name
    if (has('name')) {
      const name = data.name;
      if (typeof name !== 'string') add('name-type', 'error', `"name" must be text; it is ${kindOf(name)}.`, lineOf('name'));
      else if (!name.trim()) add('name-empty', 'error', '"name" is empty.', lineOf('name'));
      else {
        if (name.length > NAME_MAX) add('name-length', 'error', `"name" is ${name.length} characters; the limit is ${NAME_MAX}.`, lineOf('name'));
        const look = inspectName(name, knownNames);
        if (look.hidden.length) add('name-hidden-chars', 'error', `"name" holds characters nobody can see: ${look.hidden.map((h) => h.label).join(', ')}.`, lineOf('name'));
        if (look.confusable) add('name-confusable', 'warning', `"name" mixes in letters of another script that look Latin (reads as "${look.skeleton}").`, lineOf('name'));
        if (look.impersonates) add('name-impersonates', 'warning', `"name" looks like "${look.impersonates}" but is not it.`, lineOf('name'));
        // Claude Code, Codex and the portable format ask for this; a name outside it may not be found everywhere.
        if (type !== 'command' && !look.hidden.length && !NAME_RE.test(name)) add('name-format', 'warning', '"name" should use lowercase letters, digits and single hyphens only (no leading or trailing hyphen).', lineOf('name'));
        if (type === 'skill' && folderName && name !== folderName) add('name-folder', 'warning', `"name" is "${name}" but the folder is "${folderName}": the skill is invoked by its name.`, lineOf('name'));
      }
    } else if (type === 'agent' && !missingSaid) {
      add('name-missing', 'error', 'An agent needs a "name".', lineOf('name'));
    }

    // description
    if (has('description')) {
      const desc = data.description;
      if (typeof desc !== 'string') add('description-type', 'error', `"description" must be text; it is ${kindOf(desc)}.`, lineOf('description'));
      else if (!desc.trim()) add('description-empty', 'error', '"description" is empty.', lineOf('description'));
      else {
        if (desc.length > DESCRIPTION_MAX) add('description-length', 'error', `"description" is ${desc.length} characters; the limit is ${DESCRIPTION_MAX}.`, lineOf('description'));
        const hidden = findHiddenChars(desc);
        if (hidden.length) add('description-hidden-chars', 'error', `"description" holds characters nobody can see: ${hidden.slice(0, 5).map((h) => h.label).join(', ')}${hidden.length > 5 ? '…' : ''}.`, lineOf('description'));
      }
    } else if (missingSaid) {
      // said by fm-missing
    } else if (type === 'agent') {
      add('description-missing', 'error', 'An agent needs a "description": it is how Claude decides to use it.', lineOf('description'));
    } else if (type === 'skill') {
      add('description-missing', 'warning', 'No "description": Claude cannot tell when to use this skill on its own.', lineOf('description'));
    } else {
      add('description-missing', 'info', 'No "description": the command list shows nothing for it.', lineOf('description'));
    }

    for (const key of BOOLEAN_KEYS) {
      if (has(key) && typeof data[key] !== 'boolean') add(`${key}-type`, 'error', `"${key}" must be true or false; it is ${kindOf(data[key])}.`, lineOf(key));
    }
    for (const key of STRING_KEYS) {
      if (has(key) && data[key] !== null && typeof data[key] !== 'string') add(`${key}-type`, 'error', `"${key}" must be text; it is ${kindOf(data[key])}.`, lineOf(key));
    }
    for (const key of TOOL_KEYS) {
      if (!has(key)) continue;
      const value = data[key];
      const ok = typeof value === 'string' || (Array.isArray(value) && value.every((t) => typeof t === 'string' && t.trim()));
      if (!ok) add(`${key}-type`, 'error', `"${key}" must be text or a list of tool names; it is ${kindOf(value)}.`, lineOf(key));
    }
    if (has('maxTurns')) {
      const turns = data.maxTurns;
      if (!Number.isInteger(turns) || turns < 0) add('maxTurns-type', 'error', '"maxTurns" must be a whole number, 0 or more.', lineOf('maxTurns'));
    }
    if (has('hooks') && (data.hooks === null || typeof data.hooks !== 'object' || Array.isArray(data.hooks))) {
      add('hooks-type', 'error', `"hooks" must be a mapping of events; it is ${kindOf(data.hooks)}.`, lineOf('hooks'));
    }
    if (has('metadata') && (data.metadata === null || typeof data.metadata !== 'object' || Array.isArray(data.metadata))) {
      add('metadata-type', 'error', `"metadata" must be a mapping; it is ${kindOf(data.metadata)}.`, lineOf('metadata'));
    }
  }

  const body = String(parsed?.body ?? '');
  if (!body.trim()) add('body-empty', 'warning', 'The body is empty: there are no instructions.', parsed?.bodyLine || 1);
  else {
    const hidden = findHiddenChars(body);
    if (hidden.length) {
      const first = hidden[0];
      add('body-hidden-chars', 'warning', `The instructions hold ${hidden.length === 1 ? 'a character' : `${hidden.length} characters`} nobody can see (${first.label}, line ${first.line + (parsed?.bodyLine || 1) - 1}).`, first.line + (parsed?.bodyLine || 1) - 1);
    }
  }

  const rank = { error: 0, warning: 1, info: 2 };
  all.sort((a, b) => (rank[a.severity] - rank[b.severity]) || ((a.line || 0) - (b.line || 0)));
  return {
    profile: LINT_PROFILE,
    errors: all.filter((d) => d.severity === 'error'),
    warnings: all.filter((d) => d.severity === 'warning'),
    infos: all.filter((d) => d.severity === 'info'),
    all,
  };
}
