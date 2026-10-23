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
// No DOM and no imports: the page and the server read the same file the same way.

export const EVALS_PATH = 'evals/evals.json';
export const EVALS_SCHEMA = 'synabun-evals/1';
export const EVAL_SPLITS = Object.freeze(['train', 'validation', 'test']);
export const EVALS_LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxCases: 200, promptChars: 4000, queryChars: 2000, expectedChars: 4000, assertions: 20, assertionChars: 500, files: 20 });
/** The default recipe (master plan §4): what a substantive skill starts with. Fewer is a warning. */
export const EVALS_RECIPE = Object.freeze({ tasks: 3, positive: 3, nearMiss: 2 });

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
 * @returns {{ ok: boolean, errors: {code, path, message}[], warnings: {code, path, message}[], summary: object|null }}
 */
export function validateEvals(input, { skillName = '', skillTexts = [], packageFiles = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (code, path, message) => errors.push({ code, path, message });
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
        else if (files && !files.has(f)) err('file-missing', `${path}.files[${j}]`, `"${f}" is not a file of the skill.`);
      });
    }
    const assertions = own(c, 'assertions') ? c.assertions : [];
    if (!Array.isArray(assertions)) err('assertions', `${path}.assertions`, '"assertions" is a list.');
    else {
      if (!assertions.length) warn('no-assertions', `${path}.assertions`, 'A task case without assertions cannot be graded: add what must be true of the answer.');
      if (assertions.length > EVALS_LIMITS.assertions) err('too-many', `${path}.assertions`, `At most ${EVALS_LIMITS.assertions} assertions.`);
      assertions.forEach((a, j) => {
        const t = typeof a === 'string' ? a : (isObject(a) && typeof a.text === 'string' ? a.text : null);
        if (t === null || !t.trim()) err('assertion', `${path}.assertions[${j}]`, 'An assertion is a non-empty text (or { "text": … }).');
        else if (t.length > EVALS_LIMITS.assertionChars) err('too-long', `${path}.assertions[${j}]`, `An assertion is at most ${EVALS_LIMITS.assertionChars} characters.`);
        if (split === 'test' && typeof t === 'string') testTexts.push({ text: t, path: `${path}.assertions[${j}]`, what: 'check' });
      });
    }
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

  return {
    ok: errors.length === 0, errors: errors.slice(0, 100), warnings: warnings.slice(0, 100),
    summary: { tasks, triggers: positive + nearMiss, positive, nearMiss, splits, groups: groups.size },
  };
}
