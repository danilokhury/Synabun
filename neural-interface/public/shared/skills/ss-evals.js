// ═══════════════════════════════════════════
// SynaBun — a skill's test prompts: evals/evals.json
// ═══════════════════════════════════════════
//
// What AI drafting (P3) writes next to a skill and what evaluation (P4) runs: task cases (a request, what a good
// answer holds, the checks it must pass) and trigger cases (a request that should or should not pick the skill).
// The task cases keep the Agent Skills evaluation guide's shape (`evals[]` with id, prompt, expected_output, files,
// assertions) and the trigger cases the skill-creator's (`query`, `should_trigger`), so either tool can read them;
// SynaBun adds a `group` and a `split` to each case. The upstream pitfalls are checked here, not left to the
// writer (03a §3.2, master plan §4):
//   - duplicate prompts: the same request written twice (even with other spacing or capitals) is one case, and in
//     two splits it would leak the answer;
//   - holdout reuse: a group (the variants of one request) lives in one split only, and a `test` case is held
//     out: its text never appears in the skill itself;
//   - characters counted as tokens: a token count written here could only be an estimate, so none is kept.
// Counts below the default recipe (3 task cases, 3 positive and 2 near-miss triggers) are warnings, not errors.
// An assertion is a text a grader checks against the answer, or an object `{ id?, text, check?, kind?, required? }`:
// a `check` is decided by code, never by a model (ASSERTION_CHECKS: a word or a pattern in the answer or an output
// file, a file that exists, a JSON file that parses, a line limit), and `kind: "preference"` marks a check of the
// way the user wants it done (the report measures their fidelity apart). A task case may ask for a blind comparison
// of the answers with and without the skill (`compare: true`) and say it needs a shell (`shell: true`: it runs only
// where the OS sandbox holds one). P4 runs the cases (lib/skills/evals.js); readSuite() is what it reads.
// No DOM and no imports: the page and the server read the same file the same way.

export const EVALS_PATH = 'evals/evals.json';
export const EVALS_SCHEMA = 'synabun-evals/1';
export const EVAL_SPLITS = Object.freeze(['train', 'validation', 'test']);
export const EVALS_LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxCases: 200, promptChars: 4000, queryChars: 2000, expectedChars: 4000, assertions: 20, assertionChars: 500, files: 20 });
/** The default recipe (master plan §4): what a substantive skill starts with. Fewer is a warning. */
export const EVALS_RECIPE = Object.freeze({ tasks: 3, positive: 3, nearMiss: 2 });
/** What a deterministic check is: decided by code over the answer (or an output file), never by a model. */
export const ASSERTION_CHECKS = Object.freeze(['contains', 'not_contains', 'regex', 'file_exists', 'json_valid', 'max_lines']);
/** What an assertion is about: the outcome (the default), or the way the user wants it done (preference fidelity). */
export const ASSERTION_KINDS = Object.freeze(['outcome', 'preference']);
export const CHECK_LIMITS = Object.freeze({ valueChars: 500, patternChars: 300, maxLines: 100_000 });

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isRelativeFile = (f) => typeof f === 'string' && !!f && f.length <= 300 && !f.startsWith('/') && !/^[A-Za-z]:/.test(f) && !f.split('/').includes('..') && !f.includes('\\') && !/[\u0000-\u001f]/.test(f);

/**
 * Folders a runtime or a tool reads its own settings, skills, hooks, plugins or code from, wherever they sit in a
 * case's test folder (Claude Code `.claude`, `.claude-plugin`; Codex `.codex`, `.agents`; OpenCode `.opencode`;
 * `.config`; a version-control folder, whose configuration names programs git and the runtimes run). A test file is
 * never copied into one: a fixture `.claude/settings.json` would be a hook the runtime runs before any check.
 */
export const EVAL_CONFIG_DIRS = Object.freeze({
  '.claude': 'Claude Code', '.claude-plugin': 'Claude Code', '.agents': 'Codex and OpenCode', '.codex': 'Codex', '.opencode': 'OpenCode',
  '.config': 'programs', '.git': 'git (and every runtime that runs it)', '.hg': 'Mercurial (and the runtimes that run it)', '.svn': 'Subversion',
  '.jj': 'Jujutsu', '.sl': 'Sapling', '.bzr': 'Bazaar', _darcs: 'Darcs', '.pijul': 'Pijul',
});
/** Files at the top of a test folder a runtime or a tool loads as its own settings (MCP servers, plugins, an environment). */
export const EVAL_CONFIG_FILES = Object.freeze({
  '.mcp.json': 'Claude Code', '.lsp.json': 'Claude Code', 'opencode.json': 'OpenCode', 'opencode.jsonc': 'OpenCode', '.opencode.json': 'OpenCode',
  '.opencode.jsonc': 'OpenCode', '.envrc': 'direnv', '.fslckout': 'Fossil', _fossil_: 'Fossil',
});
/**
 * Files at the top of a test folder a runtime reads as instructions for the whole run, before the request: Claude Code
 * CLAUDE.md and CLAUDE.local.md (with its project and local settings, which an evaluation turns off; AGENTS.md is in its
 * list of memory files too), Codex AGENTS.md and AGENTS.override.md (always), OpenCode AGENTS.md (with its project
 * configuration, which an evaluation turns off).
 * As a test file it would be a second prompt in both arms, and a different one per runtime: refused at the top. A copy
 * deeper in a folder (project/AGENTS.md) is a test file like any other: docs/skills-studio.md says what each runtime
 * does with one.
 */
export const EVAL_INSTRUCTION_FILES = Object.freeze({
  'claude.md': 'Claude Code', 'claude.local.md': 'Claude Code', 'agents.md': 'Codex, OpenCode and Claude Code', 'agents.override.md': 'Codex',
});
// Characters a file system may drop or fold when it compares names (HFS+/APFS ignorable code points, NTFS trailing dots
// and spaces): ".g‌it", ".GIT" and ".git." are all ".git" there.
const IGNORABLE_RE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;
/** A path segment as a file system may read it: case, compatibility forms, ignorable characters and trailing dots aside. */
export function fixtureSegmentName(segment) {
  return String(segment ?? '').normalize('NFKC').replace(IGNORABLE_RE, '').replace(/[ .]+$/u, '').toLowerCase();
}

/**
 * Why a test file (a case's `files` entry, which is also where it lands in the test folder) cannot be copied there,
 * or null: what evalConfigPathProblem() refuses, or one of EVAL_INSTRUCTION_FILES at ANY depth (code
 * `fixture-instructions`). A runtime reads such a file as instructions for the whole run, not as test data: at the top
 * of the folder, and — the owner's decision — a nested one too, because OpenCode 2.1.4 loads a nested AGENTS.md as
 * instructions once a file beside it is read, and Codex's prompt tells the model to follow one. → { code, name, who,
 * message }
 */
export function evalFixturePathProblem(path) {
  const config = evalConfigPathProblem(path);
  if (config) return config;
  const parts = String(path ?? '').split('/').filter((p) => p !== '' && p !== '.');
  const last = parts.length ? parts[parts.length - 1] : '';
  const name = fixtureSegmentName(last);
  if (name && Object.prototype.hasOwnProperty.call(EVAL_INSTRUCTION_FILES, name)) {
    const who = EVAL_INSTRUCTION_FILES[name];
    const where = parts.length === 1
      ? `"${path}" is ${last} at the top of the test folder, which ${who} reads as instructions for the whole run`
      : `"${path}" is ${last}, an instruction file inside the test folder, which ${who} reads as instructions for the whole run — at the top, and a nested one too once a runtime reads a file beside it`;
    return { code: 'fixture-instructions', name, who, message: `${where}. As a test file it would steer the run, differently per runtime, so it is never copied there. Rename it — a runtime reads a file with this name as instructions, not as test data.` };
  }
  return null;
}

/**
 * Why a place of a test folder holds a runtime's own settings or code, or null: inside a folder of EVAL_CONFIG_DIRS at
 * any depth, one of EVAL_CONFIG_FILES at the top, or a name another file system reads as another file's (a Windows
 * short name such as CLAUDE~1, a ":" stream). What a run may not write either (lib/skills/eval-confinement.js); an
 * instruction file (EVAL_INSTRUCTION_FILES) is a file a run may write. → { code, name, who, message }
 */
export function evalConfigPathProblem(path) {
  const parts = String(path ?? '').split('/').filter((p) => p !== '' && p !== '.');
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (raw.includes(':') || /~\d/.test(raw)) {
      return { code: 'fixture-alias', name: raw, who: null, message: `"${path}" has a name another file system can read as another file's ("${raw}": a short name like CLAUDE~1, or a ":" stream). Give it a plain name.` };
    }
    const name = fixtureSegmentName(raw);
    const isLast = i === parts.length - 1;
    if (!isLast && Object.prototype.hasOwnProperty.call(EVAL_CONFIG_DIRS, name)) {
      const who = EVAL_CONFIG_DIRS[name];
      return { code: 'fixture-config', name, who, message: `"${path}" goes into ${name}/, a folder ${who} reads its own settings or code from: a test file is never copied there, so it cannot change how a runtime runs. Keep it under evals/files/ instead.` };
    }
    if (isLast && Object.prototype.hasOwnProperty.call(EVAL_CONFIG_DIRS, name)) {
      const who = EVAL_CONFIG_DIRS[name];
      return { code: 'fixture-config', name, who, message: `"${path}" is named ${name}, which ${who} reads as its own settings or code: a test file is never copied there under that name. Keep it under evals/files/ instead.` };
    }
    if (i === 0 && isLast && Object.prototype.hasOwnProperty.call(EVAL_CONFIG_FILES, name)) {
      const who = EVAL_CONFIG_FILES[name];
      return { code: 'fixture-config', name, who, message: `"${path}" is ${name} at the top of the test folder, which ${who} loads as its own settings: a test file is never copied there. Keep it under evals/files/ instead.` };
    }
  }
  return null;
}

/**
 * Why a regular expression of a check cannot be run, or null. A pattern runs on what a model wrote, so one that can
 * take exponential time on a crafted answer (a quantified group that holds a quantifier or an alternation, a
 * backreference) is refused; the server runs the rest with a time limit too.
 */
export function regexProblem(source, flags = '') {
  if (typeof source !== 'string' || !source) return 'empty';
  if (source.length > CHECK_LIMITS.patternChars) return 'too-long';
  if (typeof flags !== 'string' || !/^[ims]{0,3}$/.test(flags) || new Set(flags).size !== flags.length) return 'flags';
  try { new RegExp(source, flags); } catch { return 'invalid'; }
  if (/\\[1-9]|\\k</.test(source)) return 'backreference';
  return repeatsARepeat(source) ? 'nested-quantifier' : null;
}

/**
 * Whether a pattern repeats a group that itself repeats or chooses (`(a+)+`, `((a+))*`, `(a|aa){2,}`): the shapes
 * that backtrack exponentially. A group is risky when it holds a repeated atom, an alternation or a risky group; a
 * risky group followed by `*`, `+` or `{n,}` / `{n,m}` (m > 1) is refused. `?` and `{0,1}` repeat nothing.
 */
function repeatsARepeat(source) {
  const stack = [{ risky: false }];
  let inClass = false;
  const repeatAt = (j) => {
    const c = source[j];
    if (c === '*' || c === '+') return 1;
    if (c !== '{') return 0;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(j));
    if (!m) return 0;
    const max = m[2] === undefined ? Number(m[1]) : (m[3] === '' ? Infinity : Number(m[3]));
    return max > 1 ? m[0].length : -m[0].length;   // negative: a bounded once-at-most count, skipped as no repeat
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { i++; const r = repeatAt(i + 1); if (r > 0) stack[stack.length - 1].risky = true; continue; }
    if (inClass) { if (c === ']') { inClass = false; if (repeatAt(i + 1) > 0) stack[stack.length - 1].risky = true; } continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { stack.push({ risky: false }); continue; }
    if (c === '|') { if (stack.length > 1) stack[stack.length - 1].risky = true; continue; }
    if (c === ')') {
      const group = stack.length > 1 ? stack.pop() : { risky: false };
      const r = repeatAt(i + 1);
      if (r > 0 && group.risky) return true;
      if (r > 0 || group.risky) stack[stack.length - 1].risky = true;
      continue;
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') continue;   // a quantifier: its atom was looked at already
    if (repeatAt(i + 1) > 0) stack[stack.length - 1].risky = true;
  }
  return false;
}

/**
 * Why a `check` of an assertion cannot be used, or null. `{ type, value?, in?, ignoreCase?, flags? }`: `in` is
 * "answer" (the default: the final reply) or a relative path of a file the run wrote.
 */
export function checkProblem(check) {
  if (!isObject(check)) return 'A check is an object: { "type": …, "value": … }.';
  if (!ASSERTION_CHECKS.includes(check.type)) return `A check's "type" is one of ${ASSERTION_CHECKS.join(', ')}.`;
  if (own(check, 'in') && check.in !== 'answer' && !isRelativeFile(check.in)) return 'A check\'s "in" is "answer" or a relative path of a file the run writes.';
  if (own(check, 'ignoreCase') && typeof check.ignoreCase !== 'boolean') return '"ignoreCase" is true or false.';
  if (['contains', 'not_contains'].includes(check.type)) {
    if (typeof check.value !== 'string' || !check.value.trim()) return `A ${check.type} check has a non-empty "value".`;
    if (check.value.length > CHECK_LIMITS.valueChars) return `A check's "value" is at most ${CHECK_LIMITS.valueChars} characters.`;
  }
  if (check.type === 'regex') {
    const why = regexProblem(check.value, own(check, 'flags') ? check.flags : '');
    if (why) return { empty: 'A regex check has a pattern in "value".', 'too-long': `A pattern is at most ${CHECK_LIMITS.patternChars} characters.`, flags: '"flags" holds only i, m and s.', invalid: 'The pattern is not a valid regular expression.', backreference: 'A pattern with a backreference is refused (it can take very long on a crafted answer).', 'nested-quantifier': 'A pattern with a repeated group that repeats inside (like (a+)+ or (a|b)*) is refused: it can take very long on a crafted answer.' }[why];
  }
  if (['file_exists', 'json_valid'].includes(check.type) && !isRelativeFile(check.path ?? check.in)) return `A ${check.type} check names the file in "path" (a relative path the run writes).`;
  if (check.type === 'max_lines' && !(Number.isInteger(check.value) && check.value >= 1 && check.value <= CHECK_LIMITS.maxLines)) return `A max_lines check's "value" is a whole number from 1 to ${CHECK_LIMITS.maxLines}.`;
  return null;
}

/** A text as a duplicate check compares it: case, spacing and punctuation aside. */
export function normalizedCaseText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Every key path of a JSON value whose key names tokens (token counts here would be estimates). */
function tokenKeys(value, path = '', out = []) {
  if (out.length >= 10) return out;
  if (Array.isArray(value)) value.forEach((v, i) => tokenKeys(v, `${path}[${i}]`, out));
  else if (isObject(value)) {
    for (const k of Object.keys(value)) {
      const here = path ? `${path}.${k}` : k;
      if (/tokens?/i.test(k)) out.push(here);
      tokenKeys(value[k], here, out);
    }
  }
  return out;
}

/**
 * Check a skill's evals/evals.json.
 * @param {string|object} input the file's text, or its parsed value
 * @param {object} [o]
 * @param {string} [o.skillName] the skill's name (`skill_name` should match it)
 * @param {string[]} [o.skillTexts] the skill's own instructions (SKILL.md, references): a held-out case's text must
 *   not be in them
 * @param {string[]} [o.packageFiles] the paths of the package: a case's `files` must name files of it
 * @param {string} [o.description] the skill's description: a near-miss that shares no word with it is a warning
 * @returns {{ ok: boolean, errors: {code, path, message}[], warnings: {code, path, message}[], summary: object|null }}
 */
export function validateEvals(input, { skillName = '', skillTexts = [], packageFiles = null, description = '' } = {}) {
  const errors = [];
  const warnings = [];
  const err = (code, path, message, extra = null) => errors.push({ code, path, message, ...(extra || {}) });
  const warn = (code, path, message) => warnings.push({ code, path, message });
  let value = input;
  if (typeof input === 'string') {
    if (input.length > EVALS_LIMITS.maxBytes) { err('too-large', '', `evals.json is larger than ${Math.round(EVALS_LIMITS.maxBytes / 1024)} KB.`); return { ok: false, errors, warnings, summary: null }; }
    try { value = JSON.parse(input.replace(/^﻿/, '')); } catch (e) { err('json', '', `evals.json is not valid JSON (${e?.message || e}).`); return { ok: false, errors, warnings, summary: null }; }
  }
  if (!isObject(value)) { err('shape', '', 'evals.json holds one object with "evals" and "triggers".'); return { ok: false, errors, warnings, summary: null }; }
  if (!own(value, 'schema')) warn('schema-missing', 'schema', `No "schema": "${EVALS_SCHEMA}".`);
  else if (value.schema !== EVALS_SCHEMA) err('schema', 'schema', `"schema" is "${String(value.schema).slice(0, 60)}"; this file format is "${EVALS_SCHEMA}".`);
  if (typeof value.skill_name !== 'string' || !value.skill_name.trim()) warn('skill-name-missing', 'skill_name', 'No "skill_name".');
  else if (skillName && value.skill_name !== skillName) warn('skill-name-mismatch', 'skill_name', `"skill_name" is "${value.skill_name.slice(0, 64)}", the skill is "${skillName}".`);

  const evals = own(value, 'evals') ? value.evals : [];
  const triggers = own(value, 'triggers') ? value.triggers : [];
  if (!Array.isArray(evals)) err('shape', 'evals', '"evals" is a list of task cases.');
  if (!Array.isArray(triggers)) err('shape', 'triggers', '"triggers" is a list of trigger cases.');
  const taskList = Array.isArray(evals) ? evals : [];
  const triggerList = Array.isArray(triggers) ? triggers : [];
  if (taskList.length + triggerList.length > EVALS_LIMITS.maxCases) err('too-many', '', `${taskList.length + triggerList.length} cases; at most ${EVALS_LIMITS.maxCases}.`);

  const ids = new Map();            // id → path
  const texts = new Map();          // normalized text → { path, split }
  const groups = new Map();         // group → Set(split)
  const splits = { train: 0, validation: 0, test: 0 };
  const testTexts = [];
  let positive = 0; let nearMiss = 0; let tasks = 0;
  const files = Array.isArray(packageFiles) ? new Set(packageFiles) : null;

  const common = (c, path) => {
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) err('id', `${path}.id`, 'Each case has an "id": lowercase letters, digits, ".", "_" or "-", at most 64 characters.');
    else if (ids.has(c.id)) err('duplicate-id', `${path}.id`, `The id "${c.id}" is used twice (also ${ids.get(c.id)}).`);
    else ids.set(c.id, path);
    const split = own(c, 'split') ? c.split : null;
    if (!EVAL_SPLITS.includes(split)) err('split', `${path}.split`, `"split" is one of ${EVAL_SPLITS.join(', ')}.`);
    else splits[split] += 1;
    const group = typeof c.group === 'string' && c.group.trim() ? c.group.trim() : (typeof c.id === 'string' ? c.id : null);
    if (own(c, 'group') && !(typeof c.group === 'string' && ID_RE.test(c.group))) err('group', `${path}.group`, '"group" names the request this case is a variant of: a lowercase slug.');
    if (group && EVAL_SPLITS.includes(split)) {
      if (!groups.has(group)) groups.set(group, new Set());
      groups.get(group).add(split);
    }
    return { split };
  };
  const text = (c, key, max, path, split) => {
    const v = c[key];
    if (typeof v !== 'string' || !v.trim()) { err('empty', `${path}.${key}`, `"${key}" is a non-empty text.`); return; }
    if (v.length > max) err('too-long', `${path}.${key}`, `"${key}" is longer than ${max} characters.`);
    const n = normalizedCaseText(v);
    const prior = texts.get(n);
    if (prior) {
      if (prior.split !== split) err('duplicate-across-splits', `${path}.${key}`, `The same request is also ${prior.path} (split ${prior.split}): a request in two splits leaks the held-out answer.`);
      else err('duplicate-prompt', `${path}.${key}`, `The same request is also ${prior.path}: write each request once.`);
    } else texts.set(n, { path, split });
    if (split === 'test') testTexts.push({ text: v, path: `${path}.${key}` });
  };

  taskList.forEach((c, i) => {
    const path = `evals[${i}]`;
    if (!isObject(c)) { err('shape', path, 'A task case is an object.'); return; }
    tasks += 1;
    const { split } = common(c, path);
    text(c, 'prompt', EVALS_LIMITS.promptChars, path, split);
    if (!own(c, 'expected_output')) warn('expected-missing', `${path}.expected_output`, 'Say what a good answer holds ("expected_output").');
    else if (typeof c.expected_output !== 'string') err('expected', `${path}.expected_output`, '"expected_output" is text.');
    else if (c.expected_output.length > EVALS_LIMITS.expectedChars) err('too-long', `${path}.expected_output`, `"expected_output" is longer than ${EVALS_LIMITS.expectedChars} characters.`);
    // A held-out case's answer is sealed with its prompt: the skill must not hold it either.
    if (split === 'test' && typeof c.expected_output === 'string') testTexts.push({ text: c.expected_output, path: `${path}.expected_output`, what: 'answer' });
    if (own(c, 'files')) {
      if (!Array.isArray(c.files) || c.files.length > EVALS_LIMITS.files) err('files', `${path}.files`, `"files" is a list of at most ${EVALS_LIMITS.files} paths inside the skill.`);
      else c.files.forEach((f, j) => {
        if (typeof f !== 'string' || !f || f.startsWith('/') || /^[A-Za-z]:/.test(f) || f.split('/').includes('..') || f.includes('\\')) err('file-path', `${path}.files[${j}]`, 'A file is a relative path inside the skill (forward slashes, no "..").');
        else if (evalFixturePathProblem(f)) { const why = evalFixturePathProblem(f); err({ 'fixture-alias': 'file-alias', 'fixture-instructions': 'file-instructions' }[why.code] || 'file-config', `${path}.files[${j}]`, why.message, { file: f, name: why.name, who: why.who }); }
        else if (files && !files.has(f)) err('file-missing', `${path}.files[${j}]`, `"${f}" is not a file of the skill.`);
      });
    }
    const assertions = own(c, 'assertions') ? c.assertions : [];
    if (!Array.isArray(assertions)) err('assertions', `${path}.assertions`, '"assertions" is a list.');
    else {
      if (!assertions.length) warn('no-assertions', `${path}.assertions`, 'A task case without assertions cannot be graded: add what must be true of the answer.');
      if (assertions.length > EVALS_LIMITS.assertions) err('too-many', `${path}.assertions`, `At most ${EVALS_LIMITS.assertions} assertions.`);
      const assertionIds = new Set();
      assertions.forEach((a, j) => {
        const t = typeof a === 'string' ? a : (isObject(a) && typeof a.text === 'string' ? a.text : null);
        if (t === null || !t.trim()) err('assertion', `${path}.assertions[${j}]`, 'An assertion is a non-empty text (or { "text": … }).');
        else if (t.length > EVALS_LIMITS.assertionChars) err('too-long', `${path}.assertions[${j}]`, `An assertion is at most ${EVALS_LIMITS.assertionChars} characters.`);
        if (split === 'test' && typeof t === 'string') testTexts.push({ text: t, path: `${path}.assertions[${j}]`, what: 'check' });
        if (!isObject(a)) return;
        if (own(a, 'id')) {
          if (typeof a.id !== 'string' || !ID_RE.test(a.id)) err('assertion-id', `${path}.assertions[${j}].id`, 'An assertion\'s "id" is a lowercase slug.');
          else if (assertionIds.has(a.id)) err('duplicate-assertion-id', `${path}.assertions[${j}].id`, `The assertion id "${a.id}" is used twice in this case.`);
          else assertionIds.add(a.id);
        }
        if (own(a, 'check')) { const why = checkProblem(a.check); if (why) err('check', `${path}.assertions[${j}].check`, why); }
        if (own(a, 'kind') && !ASSERTION_KINDS.includes(a.kind)) err('assertion-kind', `${path}.assertions[${j}].kind`, `An assertion's "kind" is ${ASSERTION_KINDS.join(' or ')}.`);
        if (own(a, 'required') && typeof a.required !== 'boolean') err('assertion-required', `${path}.assertions[${j}].required`, '"required" is true or false.');
      });
    }
    for (const key of ['compare', 'shell']) if (own(c, key) && typeof c[key] !== 'boolean') err(key, `${path}.${key}`, `"${key}" is true or false.`);
  });
  triggerList.forEach((c, i) => {
    const path = `triggers[${i}]`;
    if (!isObject(c)) { err('shape', path, 'A trigger case is an object.'); return; }
    const { split } = common(c, path);
    text(c, 'query', EVALS_LIMITS.queryChars, path, split);
    if (typeof c.should_trigger !== 'boolean') err('should-trigger', `${path}.should_trigger`, '"should_trigger" is true or false.');
    else if (c.should_trigger) positive += 1;
    else nearMiss += 1;
  });

  for (const [group, set] of groups) {
    if (set.size > 1) err('group-split-leak', `group ${group}`, `The group "${group}" is in ${[...set].join(' and ')}: a group lives in one split only, or the held-out cases are seen in training.`);
  }
  // A held-out case's request, expected answer or checks in the skill's own instructions would give the answer away.
  const haystack = normalizedCaseText((Array.isArray(skillTexts) ? skillTexts : []).join('\n'));
  for (const t of testTexts) {
    const needle = normalizedCaseText(t.text);
    if (needle.length < 24 || !haystack.includes(needle)) continue;
    const what = t.what === 'answer' ? 'expected answer' : t.what === 'check' ? 'check (assertion)' : 'request';
    err('test-leak', t.path, `A held-out (test) case's ${what} is written into the skill itself: move it out of SKILL.md and the references, or the case out of the test split.`);
  }
  const tokenPaths = tokenKeys(value);
  if (tokenPaths.length) warn('token-field', tokenPaths[0], `A token count here can only be an estimate (characters are not tokens): leave ${tokenPaths.length === 1 ? 'it' : 'them'} out (${tokenPaths.slice(0, 3).join(', ')}).`);

  if (tasks < EVALS_RECIPE.tasks) warn('few-tasks', 'evals', `${tasks} task case${tasks === 1 ? '' : 's'}; a substantive skill starts with at least ${EVALS_RECIPE.tasks}.`);
  if (positive < EVALS_RECIPE.positive) warn('few-positive', 'triggers', `${positive} trigger${positive === 1 ? '' : 's'} that should pick the skill; at least ${EVALS_RECIPE.positive}.`);
  if (nearMiss < EVALS_RECIPE.nearMiss) warn('few-near-miss', 'triggers', `${nearMiss} near-miss trigger${nearMiss === 1 ? '' : 's'} (shares words, different intent); at least ${EVALS_RECIPE.nearMiss}.`);
  if (tasks + positive + nearMiss > 0 && splits.test === 0) warn('no-held-out', 'split', 'No case is held out ("test"): nothing can show the skill generalises.');
  // A near-miss shares words with what the skill does and asks for something else: one that shares none with its
  // description is an obviously unrelated request, which tells nothing about where the skill's boundary is.
  if (typeof description === 'string' && description.trim()) {
    const words = contentWords(description);
    triggerList.forEach((c, i) => {
      if (!isObject(c) || c.should_trigger !== false || typeof c.query !== 'string') return;
      if (![...contentWords(c.query)].some((w) => words.has(w))) warn('near-miss-unrelated', `triggers[${i}].query`, 'This near-miss shares no word with the skill\'s description: it tests little. A near-miss uses the same words for another intent.');
    });
  }

  return {
    ok: errors.length === 0, errors: errors.slice(0, 100), warnings: warnings.slice(0, 100),
    summary: { tasks, triggers: positive + nearMiss, positive, nearMiss, splits, groups: groups.size },
  };
}

const STOP_WORDS = new Set('this that with from your what when where which into about them they their there then than have will would could should only also each such some more most other over under after before because these those just very much many does done make made used uses using like into onto when were been being here want need asks asked user users skill skills'.split(' '));
/** The content words of a text (four letters or more, common words aside), for the near-miss check. */
function contentWords(text) {
  return new Set(normalizedCaseText(text).split(' ').filter((w) => w.length >= 4 && !STOP_WORDS.has(w)).map((w) => w.replace(/(?:ing|ed|es|s)$/, '')).filter((w) => w.length >= 4));
}

/**
 * The suite as an evaluation reads it: validateEvals()'s answer plus `cases`, each case once, normalized:
 *   task     { kind: 'task', id, group, split, prompt, expected, files, assertions, compare, shell }
 *   trigger  { kind: 'trigger', id, group, split, query, shouldTrigger }
 * An assertion is `{ id, text, check, kind, required }` (`id` the case's own or a1, a2…, in order; `check` null for
 * one a grader decides). `cases` is empty while the file has errors: a suite with errors does not run.
 */
export function readSuite(input, o = {}) {
  const checked = validateEvals(input, o);
  if (!checked.ok) return { ...checked, cases: [] };
  let value = input;
  if (typeof input === 'string') value = JSON.parse(input.replace(/^﻿/, ''));
  const cases = [];
  for (const c of Array.isArray(value.evals) ? value.evals : []) {
    const assertions = (Array.isArray(c.assertions) ? c.assertions : []).map((a, j) => (typeof a === 'string'
      ? { id: `a${j + 1}`, text: a.trim(), check: null, kind: 'outcome', required: true }
      : { id: typeof a.id === 'string' ? a.id : `a${j + 1}`, text: a.text.trim(), check: isObject(a.check) ? { ...a.check } : null, kind: a.kind === 'preference' ? 'preference' : 'outcome', required: a.required !== false }));
    cases.push({
      kind: 'task', id: c.id, group: typeof c.group === 'string' && c.group.trim() ? c.group.trim() : c.id, split: c.split,
      prompt: c.prompt, expected: typeof c.expected_output === 'string' ? c.expected_output : '', files: Array.isArray(c.files) ? [...c.files] : [],
      assertions, compare: c.compare === true, shell: c.shell === true,
    });
  }
  for (const c of Array.isArray(value.triggers) ? value.triggers : []) {
    cases.push({ kind: 'trigger', id: c.id, group: typeof c.group === 'string' && c.group.trim() ? c.group.trim() : c.id, split: c.split, query: c.query, shouldTrigger: c.should_trigger === true });
  }
  return { ...checked, cases };
}
