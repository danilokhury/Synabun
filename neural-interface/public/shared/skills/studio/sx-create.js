// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: a new skill, agent or command from a name
// ═══════════════════════════════════════════
//
// The fast path of Create ("Blank skill"): a name, checked as it is typed and turned into a folder-safe slug, a
// kind, an optional description that goes into the frontmatter (the old wizard dropped it, SK-063), and a starting
// layout. A layout with references writes those files too, and SKILL.md points to them by a relative path, the
// way every runtime resolves it (SK-064); nothing names `$SKILL_DIR`. What comes out is a list of files for the
// library (POST /v2/skills { name, files }) or, for an agent or a command, the one file the P0 create route writes.
// No DOM and no imports.

export const NAME_MAX = 64;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A name as a folder can carry it everywhere: lowercase ASCII letters, digits, single hyphens, at most 64. */
export function slugify(input) {
  return String(input ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_./\\]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/, '');
}

/**
 * What is wrong with a name, as codes the view words (`skillsStudio.create.name.*`).
 * @param {string} name
 * @param {{ taken?: string[], shipped?: string[], kind?: string }} [o] names already used (a warning), names SynaBun ships (an error)
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function checkName(name, { taken = [], shipped = [], kind = 'skill' } = {}) {
  const n = String(name ?? '');
  const errors = [];
  const warnings = [];
  if (!n.trim()) errors.push('required');
  else {
    if (n.length > NAME_MAX) errors.push('too-long');
    if (!NAME_RE.test(n)) errors.push('format');
    const lower = n.toLowerCase();
    if (kind === 'skill' && shipped.some((s) => String(s).toLowerCase() === lower)) errors.push('shipped');
    else if (taken.some((s) => String(s).toLowerCase() === lower)) warnings.push('taken');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** A YAML scalar for a text value: JSON's double-quoted string is valid YAML and keeps every character. */
const yamlText = (text) => JSON.stringify(String(text ?? ''));

const TODO_DESCRIPTION = 'TODO: say what this skill does and when to use it.';

/** The layouts a skill can start from. `files`: what each writes besides SKILL.md. */
export const SKILL_LAYOUTS = Object.freeze(['blank', 'steps', 'router', 'references', 'script']);
export const AGENT_LAYOUTS = Object.freeze(['blank', 'specialist', 'researcher']);
export const COMMAND_LAYOUTS = Object.freeze(['blank', 'analysis', 'workflow']);

export const layoutsFor = (kind) => (kind === 'agent' ? AGENT_LAYOUTS : kind === 'command' ? COMMAND_LAYOUTS : SKILL_LAYOUTS);

function skillHead({ name, description, invocation }) {
  const lines = ['---', `name: ${name}`, `description: ${yamlText(description || TODO_DESCRIPTION)}`];
  if (invocation === 'manual') lines.push('disable-model-invocation: true');
  return lines;
}

const SKILL_BODIES = {
  blank: (n) => [`# ${n}`, '', 'Write the instructions here: what to do, in which order, and what a good result looks like.', ''],
  steps: (n) => [`# ${n}`, '', 'The user asked for this with: $ARGUMENTS', '', '## Steps', '', '1. Read what the user gave and check it is complete.', '2. Do the task.', '3. Check the result before you report it.', '4. Report what changed, briefly.', ''],
  router: (n) => [`# ${n}`, '', 'Read the first word of $ARGUMENTS and follow its section. With no word, list the sections and ask which one.', '', '| Word | What it does |', '|------|--------------|', '| `first` | Does the first thing |', '| `second` | Does the second thing |', '', '## first', '', 'Instructions for the first thing.', '', '## second', '', 'Instructions for the second thing.', ''],
  references: (n) => [`# ${n}`, '', 'Keep this file short. Read a reference only when the task needs it:', '', '- [references/guide.md](references/guide.md): the detailed guide.', '', '## Steps', '', '1. Work out what the user needs.', '2. When the details matter, read the guide above.', '3. Follow it and report the result.', ''],
  script: (n) => [`# ${n}`, '', 'Run the script instead of reading it:', '', '```bash', 'bash scripts/run.sh', '```', '', 'It prints what it did. Report that output to the user.', ''],
};

const AGENT_FILES = {
  blank: (n, d) => ['---', `name: ${n}`, `description: ${yamlText(d || `Use this agent when the task needs ${n}.`)}`, '---', '', `You are the ${n} agent.`, '', 'Follow the instructions you are given and report what you did.', ''],
  specialist: (n, d) => ['---', `name: ${n}`, `description: ${yamlText(d || `Use this agent when the task needs ${n} expertise.`)}`, 'model: sonnet', 'tools: Read, Grep, Glob, Bash', '---', '', `You are an expert in ${n}.`, '', '## How you work', '', '1. Understand the current state before you change anything.', '2. Explain what you found.', '3. Recommend concrete next steps.', ''],
  researcher: (n, d) => ['---', `name: ${n}`, `description: ${yamlText(d || `Use this agent to research ${n}.`)}`, 'tools: Read, Grep, Glob, WebFetch, WebSearch', '---', '', `You research ${n}.`, '', '1. Search the code for context.', '2. Look up current documentation.', '3. Return a short summary with sources.', ''],
};

const COMMAND_FILES = {
  blank: (n, d) => ['---', `description: ${yamlText(d || `What /${n} does.`)}`, '---', '', `# ${n}`, '', 'Instructions for the command. The user\'s words: $ARGUMENTS', ''],
  analysis: (n, d) => ['---', `description: ${yamlText(d || `Analyze code or content for ${n}.`)}`, '---', '', `# ${n}`, '', 'Target: $ARGUMENTS', '', '1. Read the target.', '2. Look for problems and improvements.', '3. Report them, most important first.', ''],
  workflow: (n, d) => ['---', `description: ${yamlText(d || `Run the ${n} workflow.`)}`, '---', '', `# ${n}`, '', '$ARGUMENTS', '', '1. Gather what is needed.', '2. Propose a plan and wait for a yes.', '3. Do it.', '4. Check the result.', ''],
};

/**
 * The files of a new skill, agent or command.
 * @param {{ kind?: 'skill'|'agent'|'command', name: string, description?: string, layout?: string, invocation?: 'auto'|'manual' }} o
 * @returns {{ files: { path: string, content: string, executable?: boolean }[], head: string }}
 */
export function scaffold({ kind = 'skill', name, description = '', layout = 'blank', invocation = 'auto' }) {
  const n = String(name ?? '');
  const d = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (kind === 'agent') {
    const gen = AGENT_FILES[layout] || AGENT_FILES.blank;
    return { files: [{ path: `${n}.md`, content: gen(n, d).join('\n') }], head: `${n}.md` };
  }
  if (kind === 'command') {
    const gen = COMMAND_FILES[layout] || COMMAND_FILES.blank;
    return { files: [{ path: `${n}.md`, content: gen(n, d).join('\n') }], head: `${n}.md` };
  }
  const body = (SKILL_BODIES[layout] || SKILL_BODIES.blank)(n);
  const hint = layout === 'router' ? ['argument-hint: "[first|second]"'] : layout === 'steps' ? ['argument-hint: "[what to work on]"'] : [];
  const head = [...skillHead({ name: n, description: d, invocation }), ...hint, '---', '', ...body];
  const files = [{ path: 'SKILL.md', content: head.join('\n') }];
  if (layout === 'references') {
    files.push({ path: 'references/guide.md', content: [`# ${n}: the detailed guide`, '', 'Everything SKILL.md does not need to say every time: background, examples, edge cases.', '', '## Examples', '', '- An example of a request and what a good answer looks like.', ''].join('\n') });
  }
  if (layout === 'script') {
    files.push({ path: 'scripts/run.sh', content: ['#!/usr/bin/env bash', 'set -euo pipefail', '', `echo "${n}: replace this line with the work the script does"`, ''].join('\n'), executable: true });
  }
  return { files, head: 'SKILL.md' };
}

/** The name a pasted SKILL.md gives itself (its frontmatter `name`), or ''. YAML is not parsed here: a plain line only. */
export function pastedName(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? '').replace(/^﻿/, ''));
  if (!m) return '';
  const line = /^name:[ \t]*(.+?)[ \t]*$/m.exec(m[1]);
  if (!line) return '';
  return line[1].replace(/^(['"])(.*)\1$/, '$2');
}

/** The AI sources of Create (P3: sx-create-ai.js drafts from them; `describe` is the prompt itself). */
export const AI_SOURCES = Object.freeze(['describe', 'conversation', 'url', 'repo', 'memory', 'import']);
