// ═══════════════════════════════════════════
// SynaBun Neural Interface — Codex panel: native skills in the slash hints
// ═══════════════════════════════════════════
//
// Codex lists its skills itself (app-server skills/list): each with its name, its SKILL.md path and its scope.
// A hint keeps that path, so picking one sends Codex's own `skill` input (name + path: the exact skill, even when
// two share a name) with the prompt, instead of only the text "/name" (SK-050). Same-named skills are told apart
// by their scope in the hint. No DOM: cdx-tabs.js draws the hints, the tests read this.

const SCOPE_LABEL = { user: 'personal', repo: 'repository', system: 'Codex', admin: 'admin' };

/**
 * Hint rows of native skills: `{ cmd, desc, skill: { name, path }, scope }`, enabled ones only, sorted.
 * @param {object[]} skills skills/list entries (name, description, path, scope, enabled)
 * @param {Set<string>} [taken] commands already shown (built-ins win their name)
 */
export function skillHintEntries(skills, taken = new Set()) {
  const rows = (Array.isArray(skills) ? skills : [])
    .filter((s) => s && s.enabled !== false)
    .map((s) => {
      const name = String(s.name || s.dirName || '').trim();
      return { cmd: name ? `/${name}` : '', desc: String(s.description || '').trim(), skill: typeof s.path === 'string' && s.path ? { name, path: s.path } : null, scope: s.scope || null };
    })
    .filter((row) => row.cmd !== '/' && row.cmd && !taken.has(row.cmd));
  const counts = rows.reduce((m, r) => m.set(r.cmd, (m.get(r.cmd) || 0) + 1), new Map());
  for (const row of rows) {
    if (counts.get(row.cmd) > 1) row.desc = `(${SCOPE_LABEL[row.scope] || row.scope || 'other'}) ${row.desc}`.trim();
  }
  return rows.sort((a, b) => a.cmd.localeCompare(b.cmd) || String(a.scope).localeCompare(String(b.scope)));
}

/**
 * The native skill inputs a prompt carries: the picked skill, while the prompt still starts with its /name.
 * @param {string} prompt the text being sent
 * @param {{ cmd: string, name: string, path: string }|null} pending what was picked from the hints
 * @returns {{ name: string, path: string }[]}
 */
export function skillsForPrompt(prompt, pending) {
  if (!pending || typeof pending.cmd !== 'string' || typeof pending.path !== 'string') return [];
  const text = String(prompt || '').trimStart();
  if (text !== pending.cmd && !text.startsWith(`${pending.cmd} `) && !text.startsWith(`${pending.cmd}\n`)) return [];
  return [{ name: pending.name, path: pending.path }];
}

/**
 * The skills_list request the panel sends for a tab: Codex's app-server (0.164.0, checked 2026-10-23) keeps its skill
 * list until asked with forceReload, and sends no notification of its own when a skill folder appears or changes, so
 * after SynaBun installed, removed or changed a skill (skills:changed) the next request forces the reload; otherwise
 * the cached list is enough. The forced reload also refreshes the skills the app-server offers its threads.
 * @param {{ project?: string|null }} tab @param {boolean} changed whether a skills:changed arrived since the last list
 */
export function skillsListRequest(tab, changed) {
  return { cwds: tab?.project ? [tab.project] : [], forceReload: changed === true };
}
