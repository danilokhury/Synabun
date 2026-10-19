// ═══════════════════════════════════════════
// SynaBun Neural Interface — the setup wizard's Details: what they say
// ═══════════════════════════════════════════
//
// Inside the SynaBun desktop app, the setup wizard (onboarding.html) shows
// what it checked and what this copy has, step by step, in a Details area
// under Environment Check and under Install & Build: the commands SynaBun ran
// and what they answered, where `npm i -g` puts packages, and every part's
// dependencies with the version installed. The facts are
// GET /api/setup/install-details (lib/install-details.js); this turns them into
// the lines shown. English, like the rest of the wizard.
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/install-details-view.test.mjs).

const said = (tool) => (tool.ok ? tool.output || '(no answer)' : `did not run: ${tool.output || 'no output'}`);

/** Environment Check: the Node.js SynaBun runs on, its npm and npx (the command and the answer), and the user's own npm. */
export function environmentLines(details) {
  if (!details || typeof details !== 'object') return [];
  const lines = [];
  const node = details.node;
  if (node) {
    lines.push('$ node --version');
    lines.push(`${node.version}  ${node.path}${node.bundled ? '  (the Node.js that came with SynaBun)' : ''}`);
  }
  for (const name of ['npm', 'npx']) {
    const tool = details[name];
    if (!tool) { lines.push(`${name}: not found`); continue; }
    lines.push(`$ ${tool.command}`);
    lines.push(`${said(tool)}${tool.ok && tool.bundled ? '  (came with SynaBun)' : ''}`);
  }
  const prefix = details.globalPrefix;
  if (prefix?.path) {
    const setIn = prefix.from === 'npm_config_prefix' ? ', from npm_config_prefix' : prefix.from ? `, set in ${prefix.from}` : '';
    const why = prefix.source === 'user' ? `your own npm prefix${setIn}` : 'a folder of SynaBun\'s, outside the app';
    lines.push(`npm i -g installs into ${prefix.path} (${why})${prefix.bin ? `, commands in ${prefix.bin}` : ''}`);
  }
  if (details.kind === 'app') {
    const user = details.userNpm;
    lines.push(user
      ? `Your own npm: ${user.path} ${user.ok ? user.output : '(did not answer)'}. SynaBun's terminals find it first.`
      : 'No npm of your own: SynaBun\'s terminals use the one that came with SynaBun.');
  }
  return lines;
}

/** One part's packages: how many, then each dependency with the version installed. */
function partLines(part, bundled) {
  const lines = [`${part.name}: ${part.packages} package${part.packages === 1 ? '' : 's'} installed${bundled ? ' (came with SynaBun)' : ''}`];
  for (const dep of part.dependencies || []) {
    lines.push(`  ${dep.name} ${dep.installed || `not installed (wants ${dep.wanted})`}`);
  }
  return lines;
}

/** Install & Build: what this copy has, from the runtime to every dependency, and what is still to come. */
export function installLines(details) {
  if (!details || typeof details !== 'object') return [];
  const app = details.kind === 'app';
  const lines = [];
  if (app) {
    const where = details.app?.target ? ` for ${details.app.target}` : '';
    lines.push(`SynaBun ${details.app?.version || ''}${where}: nothing to install, this copy came with its dependencies.`.replace(/\s+:/, ':'));
  }
  if (details.node) {
    const npm = details.npm?.ok ? `, npm ${details.npm.output}` : '';
    const npx = details.npx?.ok ? `, npx ${details.npx.output}` : '';
    lines.push(`Node.js ${String(details.node.version).replace(/^v/, '')}${npm}${npx}${details.node.bundled ? ' (the runtime that came with SynaBun)' : ''}`);
  }
  for (const part of details.parts || []) lines.push(...partLines(part, app));
  lines.push(details.mcp?.built ? `MCP server: built (${details.mcp.file})` : 'MCP server: not built yet');
  const bundled = details.bundled;
  if (bundled) {
    lines.push(bundled.embeddingModel ? `Local embedding model: ${bundled.embeddingModel} (came with SynaBun)` : 'Local embedding model: not included (keyword recall only)');
    if (bundled.cloudflared) lines.push(`cloudflared ${bundled.cloudflared}, for invite links and remote MCP (came with SynaBun)`);
    if (bundled.gitBash) lines.push(`Git for Windows ${bundled.gitBash}, the Git Bash Claude Code needs (came with SynaBun)`);
    if (details.app?.electron) lines.push(`The window: Electron ${details.app.electron}`);
  }
  if (details.browser) {
    lines.push(details.browser.installed
      ? `Automation browser (Chromium for Playwright): installed, ${details.browser.path}`
      : 'Automation browser (Chromium for Playwright): not downloaded yet; SynaBun downloads it at its next start.');
  }
  return lines;
}
