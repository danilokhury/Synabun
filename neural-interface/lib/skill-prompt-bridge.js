export function buildCodexSkillPromptBridge({ sourceFile, raw }) {
  const frontmatter = String(raw || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] || '';
  return `${frontmatter}\n# SynaBun Skill Bridge\n\nRead \`${sourceFile}\` with the local file tools and follow it exactly. Treat that repository file and its referenced modules as the sole runtime instructions; do not rely on an embedded or cached copy.\n\nInvocation arguments: \`$1\`\n`;
}

export function expandSynabunCodexSlashPrompt(prompt, sourceFile) {
  const match = String(prompt || '').trim().match(/^\/synabun(?:\s+([\s\S]*))?$/i);
  if (!match) return prompt;
  const args = String(match[1] || '').trim();
  return `Read \`${sourceFile}\` with the local file tools and follow it exactly. Treat that repository file and its referenced modules as the sole runtime instructions.\n\nInvocation arguments: ${args || '(none)'}`;
}
