// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: snippets
// ═══════════════════════════════════════════
//
// Pieces the editor inserts for you. A body snippet goes in at the caret, on lines of its own (never inside the
// frontmatter: a caret there inserts at the start of the body). A frontmatter snippet is keys, merged into the
// frontmatter through the same one-key patch as the form (ss-frontmatter.js patch): the keys already there, their
// comments and order stay. The words follow the runtimes as they are (SK-067, Q14): pre-approved tools run without
// asking and do not restrict other tools; a skill names its files by a path relative to its folder, or
// ${CLAUDE_SKILL_DIR} in Claude Code; nothing claims "five trigger phrases" make a skill fire. Names and
// descriptions are i18n keys (`skillsStudio.snippets.<id>`); the inserted text is the skill's own words, English.
// The user's own snippets (the presets of P0, ss-presets.js) are body snippets. No DOM and no imports.

/** @typedef {{ id: string, kind: 'body'|'frontmatter', types: string[], text?: string, patch?: object, group: string }} Snippet */

/** @type {Snippet[]} */
export const SNIPPETS = Object.freeze([
  { id: 'role', kind: 'body', group: 'structure', types: ['skill', 'agent'], text: '## Role\n\nYou are [who]. Your job is to [what], for [whom].\n' },
  { id: 'steps', kind: 'body', group: 'structure', types: ['skill', 'command', 'agent'], text: '## Steps\n\n1. Read what the user gave and check it is complete.\n2. Do the task.\n3. Check the result.\n4. Report what changed, briefly.\n' },
  { id: 'constraints', kind: 'body', group: 'structure', types: [], text: '## Rules\n\n- Never change files outside the project.\n- Ask before deleting anything.\n- Say what you are about to do before you do it.\n' },
  { id: 'output', kind: 'body', group: 'structure', types: [], text: '## Output\n\nAnswer with:\n\n1. A one-line summary.\n2. What you found, most important first.\n3. What to do next.\n' },
  { id: 'examples', kind: 'body', group: 'structure', types: ['skill', 'agent'], text: '## Examples\n\n<example>\nuser: "[a request this skill should handle]"\nassistant: "[what a good answer does]"\n</example>\n' },
  { id: 'context', kind: 'body', group: 'workflow', types: ['skill', 'command'], text: '## First, gather context\n\nBefore you change anything, read the files involved and look for how the project already does it.\n' },
  { id: 'errors', kind: 'body', group: 'workflow', types: ['skill', 'command'], text: '## When something fails\n\nSay what failed and why, suggest the next step, and do not repeat the same attempt unchanged.\n' },
  { id: 'input-check', kind: 'body', group: 'workflow', types: ['skill', 'command'], text: '## Input\n\nThe user\'s words are in $ARGUMENTS. If they are empty or unclear, ask before you start.\n' },
  { id: 'confirm', kind: 'body', group: 'workflow', types: ['skill', 'command'], text: '## Before anything destructive\n\nList exactly what will be changed or removed and wait for a clear yes.\n' },
  { id: 'scope', kind: 'body', group: 'workflow', types: ['skill', 'agent'], text: '## Scope\n\nThis covers: [what].\nIt does not cover: [what not]; say so and suggest the right tool.\n' },
  { id: 'references', kind: 'body', group: 'files', types: ['skill'], text: '## References\n\nRead these only when the task needs them:\n\n- [references/guide.md](references/guide.md): [what it holds]\n' },
  { id: 'variables', kind: 'body', group: 'files', types: ['skill', 'command'], text: '## Variables\n\n- $ARGUMENTS: what the user typed after the name.\n- ${CLAUDE_SKILL_DIR}: this skill\'s folder in Claude Code (elsewhere, use paths relative to this file).\n' },
  { id: 'dynamic', kind: 'body', group: 'files', types: ['skill', 'command'], text: '## Current state\n\n- Branch: !`git branch --show-current`\n' },
  { id: 'fm-tools-readonly', kind: 'frontmatter', group: 'frontmatter', types: ['skill'], patch: { 'allowed-tools': ['Read', 'Grep', 'Glob'] } },
  { id: 'fm-agent-tools', kind: 'frontmatter', group: 'frontmatter', types: ['agent'], patch: { tools: 'Read, Grep, Glob' } },
  { id: 'fm-manual', kind: 'frontmatter', group: 'frontmatter', types: ['skill'], patch: { 'disable-model-invocation': true } },
  { id: 'fm-hint', kind: 'frontmatter', group: 'frontmatter', types: ['skill', 'command'], patch: { 'argument-hint': '[target]' } },
  { id: 'fm-when', kind: 'frontmatter', group: 'frontmatter', types: ['skill'], patch: { when_to_use: 'Use when [the situation]. For example: "[a request]".' } },
  { id: 'fm-fork', kind: 'frontmatter', group: 'frontmatter', types: ['skill'], patch: { context: 'fork', agent: 'Explore' } },
  { id: 'fm-model', kind: 'frontmatter', group: 'frontmatter', types: ['agent'], patch: { model: 'sonnet' } },
]);

export const SNIPPET_GROUPS = Object.freeze(['structure', 'workflow', 'files', 'frontmatter', 'custom']);

/** The snippets for a kind of artifact: the built-in ones that fit it, then the user's own. */
export function snippetsFor(type, custom = []) {
  const builtIn = SNIPPETS.filter((s) => !s.types.length || s.types.includes(type));
  // A preset comes from the synced UI state (or a file someone handed over): every field is taken as text.
  const typesOf = (p) => (Array.isArray(p.types) ? p.types.filter((x) => typeof x === 'string') : []);
  const own = (Array.isArray(custom) ? custom : []).filter((p) => p && typeof p.snippet === 'string' && p.id != null && (!typesOf(p).length || typesOf(p).includes(type)))
    .map((p) => ({ id: `custom:${String(p.id)}`, kind: 'body', group: 'custom', types: typesOf(p), text: p.snippet, name: String(p.name ?? ''), description: typeof p.description === 'string' ? p.description : '', custom: true }));
  // One snippet once: a preset that is a built-in's exact text is not listed twice.
  const texts = new Set(builtIn.map((s) => s.text).filter(Boolean));
  return [...builtIn, ...own.filter((s) => !texts.has(s.text))];
}

/** Where the body of a text starts (after its frontmatter), as an index. */
export function bodyStart(text) {
  const s = String(text ?? '');
  const bom = s.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const m = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(s.slice(bom));
  return m ? bom + m[0].length : bom;
}

/**
 * Insert a snippet.
 * @param {string} text the document ("\n" line breaks)
 * @param {Snippet} snippet
 * @param {{ caret?: number, fm?: { patch: (text: string, changes: object) => object } }} [o] `fm`: ss-frontmatter.js (frontmatter snippets)
 * @returns {{ ok: true, text: string, caret: number, at: number } | { ok: false, reason: string }}
 */
export function applySnippet(text, snippet, { caret = null, fm = null } = {}) {
  const s = String(text ?? '');
  if (snippet?.kind === 'frontmatter') {
    if (!fm || typeof fm.patch !== 'function') return { ok: false, reason: 'no-parser' };
    const result = fm.patch(s, snippet.patch || {});
    if (!result.ok) return { ok: false, reason: result.reason || 'invalid' };
    return { ok: true, text: result.text, caret: Math.min(caret ?? 0, result.text.length), at: 0, changed: result.changed !== false };
  }
  const piece = String(snippet?.text ?? '');
  if (!piece.trim()) return { ok: false, reason: 'empty' };
  const start = bodyStart(s);
  let at = Number.isInteger(caret) ? Math.max(0, Math.min(caret, s.length)) : s.length;
  if (at < start) at = start;   // never inside the frontmatter
  const before = s.slice(0, at);
  const after = s.slice(at);
  const pad = before.length > start && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const body = piece.endsWith('\n') ? piece : `${piece}\n`;
  const trail = after.length && !after.startsWith('\n') ? '\n' : '';
  const next = before + pad + body + trail + after;
  return { ok: true, text: next, caret: before.length + pad.length + body.length, at: before.length + pad.length, changed: true };
}

/** Whether a snippet matches a search, through the words the view shows for it. */
export function snippetMatches(snippet, query, words = (s) => `${s.name || ''} ${s.description || ''}`) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  return `${snippet.id} ${words(snippet)} ${snippet.kind === 'frontmatter' ? Object.keys(snippet.patch || {}).join(' ') : ''}`.toLowerCase().includes(q);
}
