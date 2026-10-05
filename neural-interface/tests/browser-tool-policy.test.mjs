// The browser policy (lib/browser-tool-policy.js): what it refuses and allows,
// and where it is enforced — the Assistant brain (Claude hook, Codex hook and
// OpenCode plugin through gateCheck, the reactive fallback) and its task-run
// workers (Claude PreToolUse hook, Codex trusted hook, OpenCode plugin).
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { browserPolicyText, browserToolDenial, MAX_SCRIPT_BYTES } from '../lib/browser-tool-policy.js';
import { createAssistantRuntime } from '../lib/assistant-runtime.js';
import { buildAssistantPersona, planModeInstructions } from '../lib/assistant-persona.js';
import { buildTaskPrompt, NEEDS_BROWSER } from '../lib/assistant-task-prompt.js';
import { createClaudeNativeLoopAdapter, createCodexNativeLoopAdapter } from '../lib/native-loop-providers.js';
import { CODEX_BROWSER_POLICY_HOOK_PATH, CODEX_BROWSER_POLICY_UNTRUSTED_NOTE, codexBrowserPolicyHook, codexGateHookCommand, codexHookConfig } from '../lib/assistant-route-gate-codex.js';
import { OPENCODE_BROWSER_POLICY_PLUGIN, withOpenCodeBrowserPolicy } from '../lib/opencode-runtime-config.js';
import browserPolicyPlugin from '../lib/assistant-brains/opencode-browser-policy.js';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import { createAssistantDispatcher } from '../lib/assistant-dispatch.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(5);
  }
  throw new Error('Timed out waiting for condition');
};

/** A project folder with the incident's script (/tmp/pw.cjs in the reports) and an ordinary one. */
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-browser-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = resolve(root, 'project');
  mkdirSync(resolve(project, 'tests'), { recursive: true });
  const pw = resolve(root, 'pw.cjs');
  writeFileSync(pw, "const { chromium } = require('playwright');\n(async () => { const browser = await chromium.launch({ channel: 'chrome' }); await browser.close(); })();\n");
  writeFileSync(resolve(project, 'build.mjs'), "// Runs before the playwright suite (npx playwright test) in CI.\nconsole.log('built');\n");
  writeFileSync(resolve(project, 'shot.py'), 'from playwright.sync_api import sync_playwright\n');
  writeFileSync(resolve(project, 'tests', 'x.test.mjs'), "import { chromium } from 'playwright';\n");
  return { root, project, pw };
}
const refused = (tool, input, opts) => browserToolDenial(tool, input, opts);

// ── the policy ───────────────────────────────────────────────────────────────

test('refused: every incident command and every other way out of the SynaBun browser, naming what and what to use instead', (t) => {
  const { project, pw } = fixture(t);
  const cases = [
    ['Bash', { command: `node ${pw}` }, /running .*pw\.cjs, a script that uses Playwright/],
    ['Bash', { command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir=/private/tmp/x --screenshot=/tmp/a.png --window-size=1440,900 http://localhost:3917/' }, /Google Chrome started from the shell/],
    ['Bash', { command: 'npx playwright install chromium-headless-shell' }, /npx playwright install/],
    ['Bash', { command: '"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --headless=new --screenshot=/tmp/edge.png http://localhost:3210/' }, /Microsoft Edge started from the shell/],
    ['Bash', { command: `node -e "require('playwright').chromium.launch()"` }, /inline code that uses Playwright \(node -e\)/],
    ['Bash', { command: "node <<'EOF'\nconst { chromium } = require('playwright');\nawait chromium.launch();\nEOF" }, /a heredoc fed to node that uses Playwright/],
    ['Bash', { command: 'python3 -c "from playwright.sync_api import sync_playwright"' }, /inline code that uses Playwright \(python3 -c\)/],
    ['Bash', { command: 'open -a "Google Chrome" http://localhost:3210' }, /opening Google Chrome with open/],
    ['Bash', { command: 'open http://localhost:3210' }, /opening http:\/\/localhost:3210 with open/],
    ['mcp__SynaBun__computer_apps', { action: 'open', app: 'Google Chrome' }, /opening Google Chrome with computer use/],
    ['mcp__plugin_playwright_playwright__browser_navigate', { url: 'http://localhost:3000' }, /the plugin_playwright_playwright MCP server drives a browser of its own/],
    ['mcp__chrome-devtools__navigate_page', { url: 'http://localhost:3000' }, /the chrome-devtools MCP server/],
    ['WebSearch', { query: 'css anchor positioning' }, /web search \/ fetch outside the SynaBun browser/],
    ['WebFetch', { url: 'https://example.com' }, /web search \/ fetch outside the SynaBun browser/],
  ];
  for (const [tool, input, what] of cases) {
    const reason = refused(tool, input, { host: 'claude', cwd: project });
    assert.ok(reason, `${tool} ${JSON.stringify(input)}`);
    assert.match(reason, /^SynaBun browser policy: /);
    assert.match(reason, what, tool);
    assert.match(reason, /public or localhost, goes through SynaBun's browser tools \(browser_navigate/);
    assert.match(reason, /If the SynaBun browser fails or cannot do this, stop and report it/);
  }
  assert.match(refused('webfetch', { url: 'https://example.com' }, { host: 'opencode', cwd: project }), /webfetch was refused/);
  assert.match(refused('websearch', { query: 'x' }, { host: 'opencode', cwd: project }), /websearch was refused/);
  assert.match(refused('web_search', { query: 'x' }, { host: 'codex', cwd: project }), /web_search was refused/);
  // Codex's shell family, the command as an argv array (exec_command, shell, local_shell).
  assert.match(refused('exec_command', { command: ['/bin/zsh', '-lc', `node ${pw}`], workdir: project }, { host: 'codex', cwd: project }), /exec_command was refused — running .*pw\.cjs/);
  assert.match(refused('shell', { command: ['bash', '-lc', 'npx playwright install chromium'] }, { host: 'codex', cwd: project }), /npx playwright install/);
  assert.match(refused('local_shell', { action: { command: ['google-chrome', '--headless', '--screenshot', 'http://localhost:3000'] } }, { host: 'codex', cwd: project }), /google-chrome started from the shell/);
  assert.match(refused('exec_command', { cmd: 'open -a Safari http://127.0.0.1:3000' }, { host: 'codex', cwd: project }), /opening Safari with open/);
  // OpenCode names another server's tools <server>_<tool>.
  assert.match(refused('playwright_browser_navigate', { url: 'http://localhost:3000' }, { host: 'opencode', cwd: project }), /the playwright MCP server/);
  assert.match(refused('chrome-devtools_take_screenshot', {}, { host: 'opencode', cwd: project }), /the chrome-devtools MCP server/);
  assert.match(refused('mcp__claude-in-chrome__navigate', {}, { host: 'claude', cwd: project }), /claude-in-chrome/);
  assert.match(refused('mcp__remote-devices__Claude_Browser__navigate', {}, { host: 'claude', cwd: project }), /Claude_Browser/);
});

test('refused: the same programs through wrappers, package runners, pipes, redirects, cd and nested shells', (t) => {
  const { root, project, pw } = fixture(t);
  const cases = [
    `cd ${root} && node pw.cjs`,
    `cat ${pw} | node`,
    `node < ${pw}`,
    `cd ${root} && node --test pw.cjs`, // a "test run" of a file outside the project
    `sudo -u me env FOO=1 timeout 30 node ${pw}`,
    `bash -c "node ${pw}"`,
    `sh <<'SH'\nnode ${pw}\nSH`,
    `echo "require('playwright').chromium.launch()" | node`,
    'pnpm dlx playwright screenshot http://localhost:3000 /tmp/a.png',
    'bunx playwright install',
    'pnpm playwright install chromium',
    'npx -y puppeteer browsers install chrome',
    'npx lighthouse http://localhost:3000',
    'npx pa11y http://localhost:3000',
    'shot-scraper http://localhost:3000',
    'npx capture-website-cli http://localhost:3000',
    'npx @puppeteer/browsers install chrome@stable',
    `npx playwright test ${root}/check.spec.ts`,
    `npx tsx ${pw}`,
    'python3 -m playwright install chromium',
    'python3 -m webbrowser http://localhost:3000',
    'python3 shot.py',
    'chromium --headless --dump-dom http://localhost:3000',
    '~/Library/Caches/ms-playwright/chromium_headless_shell-1181/chrome-mac/headless_shell --screenshot http://localhost:3000',
    '"$CHROME" --headless=new --screenshot http://localhost:3000',
    'xdg-open http://localhost:3000',
    'open report.html',
    'open -b com.google.Chrome http://localhost:3000',
    'deno eval "import \'npm:playwright\'"',
    'bun -e "require(\'puppeteer\').launch()"',
    'python3 - <<PY\nfrom selenium import webdriver\nwebdriver.Chrome()\nPY',
    'uv run --with playwright python shot.py',
    'poetry run python shot.py',
    'uvx shot-scraper http://localhost:3000',
    'pipx run shot-scraper http://localhost:3000',
    `chmod +x ${pw} && ${pw}`, // a script run through its shebang
    './shot.py',
  ];
  for (const command of cases) assert.ok(refused('Bash', { command }, { host: 'claude', cwd: project }), command);
  // Playwright's UI / debug modes open a browser window: not an automated test run.
  assert.match(refused('Bash', { command: 'npx playwright test --ui' }, { cwd: project }), /npx playwright test in its UI or debug mode \(a browser window\)/);
  assert.match(refused('Bash', { command: 'playwright test tests/a.spec.ts --debug' }, { cwd: project }), /playwright test in its UI or debug mode/);
  assert.match(refused('Bash', { command: `npx playwright test ${root}/check.spec.ts` }, { cwd: project }), /npx playwright test on files outside the project/);
  assert.ok(refused('computer_apps', { action: 'focus', app: 'com.google.Chrome' }, { cwd: project }), 'a bundle id, bare tool name');
  assert.ok(refused('SynaBun_computer_apps', { action: 'open', app: '/Applications/Arc.app' }, { host: 'opencode', cwd: project }), 'an app path');
});

test('allowed: mentions, the project\'s own automated tests, SynaBun\'s browser tools and MoreLogin', (t) => {
  const { project, pw } = fixture(t);
  const commands = [
    'rg -n playwright neural-interface/server.js',
    `cat ${pw}`,
    `sed -i '' 's/a/b/' ${pw}`,
    'git diff',
    'git commit -m "drop the playwright screenshot script"',
    'grep -rn "chromium.launch" .',
    'npm test',
    'npm run test:e2e -- --grep checkout',
    'pnpm test',
    'yarn test:unit',
    'bun test',
    'npx playwright test',
    'npx playwright test tests/checkout.spec.ts --project chromium',
    'pnpm exec playwright test',
    'node --test neural-interface/tests/x.test.mjs',
    'node --test tests/x.test.mjs',
    'npx vitest run tests',
    'jest --watch',
    `cat > ${pw} <<'EOF'\nconst { chromium } = require('playwright');\nEOF`,
    'node build.mjs', // mentions Playwright in a comment only
    './build.mjs',
    'uv run pytest tests',
    'npx playwright test --headed --project chromium',
    'node -e "console.log(require(\'./package.json\').name)"',
    'python3 -m http.server 8000',
    'open .',
    'open -a MoreLogin',
    'ls ~/Library/Caches/ms-playwright',
  ];
  for (const command of commands) assert.equal(refused('Bash', { command }, { host: 'claude', cwd: project }), null, command);
  for (const [tool, input, host] of [
    ['mcp__SynaBun__browser_navigate', { url: 'http://localhost:3000' }, 'claude'],
    ['SynaBun_browser_navigate', { url: 'http://localhost:3000' }, 'opencode'],
    ['mcp__SynaBun__browser_screenshot', {}, 'codex'],
    ['mcp__SynaBun__computer_apps', { action: 'open', app: 'MoreLogin' }, 'claude'],
    ['mcp__SynaBun__computer_apps', { action: 'list' }, 'claude'],
    ['Read', { file_path: '/tmp/pw.cjs' }, 'claude'],
    ['Write', { file_path: '/tmp/pw.cjs', content: "require('playwright')" }, 'claude'],
    ['mcp__plugin_context7_context7__query-docs', { libraryId: '/microsoft/playwright' }, 'claude'],
    ['context7_query-docs', { libraryId: '/microsoft/playwright' }, 'opencode'],
    ['Bash', {}, 'claude'],
  ]) assert.equal(refused(tool, input, { host, cwd: project }), null, tool);
});

test('scripts are read through the injectable reader, up to MAX_SCRIPT_BYTES; unreadable ones run', (t) => {
  const { project } = fixture(t);
  const seen = [];
  const readFile = (path) => { seen.push(path); return path.endsWith('big.cjs') ? null : "require('puppeteer').launch()"; };
  assert.match(refused('Bash', { command: 'node scripts/shot.cjs' }, { cwd: project, readFile }), /a script that uses Puppeteer/);
  assert.deepEqual(seen, [resolve(project, 'scripts/shot.cjs')], 'resolved against the project');
  assert.equal(refused('Bash', { command: 'node big.cjs' }, { cwd: project, readFile }), null);
  assert.equal(refused('Bash', { command: 'node missing.cjs' }, { cwd: project }), null, 'a file that is not there runs');
  const big = resolve(project, 'huge.cjs');
  writeFileSync(big, `require('playwright');\n${'x'.repeat(MAX_SCRIPT_BYTES)}`);
  assert.equal(refused('Bash', { command: `node ${big}` }, { cwd: project }), null, 'over 256 KB: not read');
  assert.equal(refused('Bash', { command: 'node x' }, { cwd: project, readFile: () => { throw new Error('EACCES'); } }), null);
});

test('MCP tools: any server whose name says browser, and any tool whose name drives a page, are refused; SynaBun\'s own tools pass under every host prefix', (t) => {
  const { project } = fixture(t);
  const refusedTools = [
    ['mcp__browser__navigate', 'claude', /the browser MCP server drives a browser of its own/],
    ['mcp__my-browser-kit__click', 'codex', /the my-browser-kit MCP server/],
    ['mcp__chrome__open', 'claude', /the chrome MCP server/],
    ['mcp__devtools__evaluate_script', 'claude', /the devtools MCP server/],
    ['mcp__webdriver__find_element', 'codex', /the webdriver MCP server/],
    ['mcp__stagehand__act', 'claude', /the stagehand MCP server/],
    ['mcp__hyperbrowser__scrape_webpage', 'claude', /the hyperbrowser MCP server/],
    ['mcp__browserbase__session_create', 'claude', /the browserbase MCP server/],
    ['mcp__web__goto', 'claude', /goto of the web MCP server drives a page/],
    ['mcp__tools__navigate_page', 'codex', /navigate_page of the tools MCP server drives a page/],
    ['mcp__tools__navigatePage', 'claude', /navigatePage of the tools MCP server/],
    ['mcp__site__open_url', 'claude', /open_url/],
    ['mcp__site__open-page', 'claude', /open-page/],
    ['mcp__qa__take_screenshot', 'claude', /take_screenshot/],
    ['mcp__qa__screenshot', 'claude', /screenshot of the qa MCP server/],
    ['mcp__qa__page_screenshot', 'claude', /page_screenshot/],
    ['mcp__qa__browser_click', 'claude', /browser_click of the qa MCP server/],
    // OpenCode: <server>_<tool>, where the server's name ends is unknown.
    ['browser_navigate', 'opencode', /the browser MCP server/],
    ['web_goto', 'opencode', /web_goto drives a page/],
    ['qa_take_screenshot', 'opencode', /qa_take_screenshot drives a page/],
    ['my_tools_navigate_page', 'opencode', /drives a page/],
  ];
  for (const [tool, host, what] of refusedTools) {
    const reason = refused(tool, {}, { host, cwd: project });
    assert.ok(reason, `${tool} (${host})`);
    assert.match(reason, what, tool);
    assert.match(reason, /If the SynaBun browser fails or cannot do this, stop and report it/);
  }
  for (const [tool, host] of [
    ['mcp__SynaBun__browser_navigate', 'claude'], ['mcp__synabun__browser_screenshot', 'codex'], ['SynaBun_browser_navigate', 'opencode'],
    ['SynaBun.browser_navigate', 'codex'], ['mcp__claude_ai_Synabun__browser_navigate', 'claude'], ['mcp__plugin_synabun_SynaBun__browser_take_screenshot', 'claude'],
    ['mcp__SynaBun__leonardo_browser_navigate', 'claude'], ['SynaBun_gsc_screenshot', 'opencode'], ['mcp__SynaBun__youtube_navigate', 'codex'],
    ['mcp__github__create_issue', 'claude'], ['mcp__plugin_context7_context7__query-docs', 'claude'], ['mcp__linear__list_issues', 'codex'],
    ['github_create_pull_request', 'opencode'], ['context7_query-docs', 'opencode'], ['todowrite', 'opencode'], ['apply_patch', 'opencode'],
    ['Read', 'claude'], ['TodoWrite', 'claude'], ['view_image', 'codex'],
  ]) assert.equal(refused(tool, {}, { host, cwd: project }), null, `${tool} (${host})`);
  // A SynaBun computer_apps call under another prefix is still checked for a browser app; MoreLogin's
  // profile windows are a browser, its manager app is not.
  assert.match(refused('mcp__claude_ai_Synabun__computer_apps', { action: 'open', app: 'org.HongKongZiXun.MoreLogin' }, { host: 'claude', cwd: project }), /opening org\.HongKongZiXun\.MoreLogin with computer use/);
  assert.equal(refused('mcp__SynaBun__computer_apps', { action: 'open', app: 'com.zixun.MoreLoginPlus' }, { host: 'claude', cwd: project }), null);
});

test('shell scripts run by sh / bash / zsh / dash, source, a pipe or a shebang are read (up to 256 KB, from the cwd) and checked like the command line', (t) => {
  const { project } = fixture(t);
  mkdirSync(resolve(project, 'scripts'), { recursive: true });
  writeFileSync(resolve(project, 'scripts', 'shot.sh'), '#!/bin/bash\nset -e\n"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=/tmp/a.png http://localhost:3000/\n');
  writeFileSync(resolve(project, 'open-it'), '#!/usr/bin/env bash\nopen http://localhost:3000\n');
  writeFileSync(resolve(project, 'pw.sh'), 'cd tests\nnpx playwright screenshot http://localhost:3000 a.png\n');
  writeFileSync(resolve(project, 'runner.sh'), 'node pw.cjs\n');
  writeFileSync(resolve(project, 'pw.cjs'), "require('playwright').chromium.launch();\n");
  writeFileSync(resolve(project, 'ok.sh'), '#!/bin/sh\necho hello\nnpm test\n');
  writeFileSync(resolve(project, 'plain'), 'google-chrome --headless http://localhost:3000\n'); // no shebang, no .sh: not read
  const cases = [
    ['sh scripts/shot.sh', /running scripts\/shot\.sh, a shell script: Google Chrome started from the shell/],
    ['bash -x scripts/shot.sh', /running scripts\/shot\.sh, a shell script/],
    ['zsh pw.sh', /running pw\.sh, a shell script: npx playwright screenshot/],
    ['dash -- pw.sh', /running pw\.sh/],
    ['./scripts/shot.sh', /running \.\/scripts\/shot\.sh, a shell script: Google Chrome started/],
    ['./open-it', /running \.\/open-it, a shell script: opening http:\/\/localhost:3000 with open/],
    ['source pw.sh', /running pw\.sh, a shell script/],
    ['. pw.sh', /running pw\.sh, a shell script/],
    ['bash < pw.sh', /running pw\.sh, a shell script/],
    ['cat pw.sh | bash', /piping pw\.sh, a shell script: npx playwright screenshot \(into bash\)/],
    ['echo "google-chrome --headless http://localhost:3000" | sh', /google-chrome started from the shell/],
    ['bash runner.sh', /running runner\.sh, a shell script: running pw\.cjs, a script that uses Playwright/],
  ];
  for (const [command, what] of cases) assert.match(refused('Bash', { command }, { host: 'claude', cwd: project }) || '', what, command);
  assert.match(refused('exec_command', { command: ['bash', 'scripts/shot.sh'], workdir: project }, { host: 'codex', cwd: '/elsewhere' }) || '', /scripts\/shot\.sh/, 'a Codex argv, resolved against its workdir');
  for (const command of ['bash ok.sh', './ok.sh', 'sh -s < /dev/null', './plain', 'bash missing.sh', 'bash -c "echo hi"', 'sh -n ok.sh']) {
    assert.equal(refused('Bash', { command }, { host: 'claude', cwd: project }), null, command);
  }
  const seen = [];
  refused('Bash', { command: 'bash scripts/x.sh' }, { cwd: project, readFile: (path) => { seen.push(path); return null; } });
  assert.deepEqual(seen, [resolve(project, 'scripts/x.sh')], 'read through the injectable reader, resolved against the cwd');
  const big = resolve(project, 'big.sh');
  writeFileSync(big, `google-chrome --headless http://localhost:3000\n#${'x'.repeat(MAX_SCRIPT_BYTES)}\n`);
  assert.equal(refused('Bash', { command: 'bash big.sh' }, { cwd: project }), null, 'over 256 KB: not read');
});

test('$(…) and backticks inside double quotes and unquoted heredocs are commands of their own', (t) => {
  const { project } = fixture(t);
  for (const command of [
    'echo "$(google-chrome --headless http://localhost:3000)"',
    'echo "`google-chrome --headless http://localhost:3000`"',
    'echo "shot: $(npx playwright screenshot http://localhost:3000 a.png)"',
    'X="$(open http://localhost:3000)"',
    'echo "outer $(echo "inner $(chromium --headless --dump-dom http://localhost:3000)")"',
    'cat <<EOF\n$(open http://localhost:3000)\nEOF',
    'cat <<EOF\n`google-chrome --headless http://localhost:3000`\nEOF',
  ]) assert.ok(refused('Bash', { command }, { host: 'claude', cwd: project }), command);
  for (const command of [
    "cat <<'EOF'\n$(open http://localhost:3000)\nEOF", // quoted delimiter: the body stays text
    'echo "$((1 + 2))"',
    'echo "$(date) by `whoami`"',
    "echo '$(open http://localhost:3000)'", // single quotes: text
    'git commit -m "docs: \\$(open http://localhost) is refused"',
  ]) assert.equal(refused('Bash', { command }, { host: 'claude', cwd: project }), null, command);
});

test('the test-runner exception holds only for a command run inside the project (cd and the Codex workdir included)', (t) => {
  const { root, project } = fixture(t);
  assert.match(refused('Bash', { command: 'cd /tmp && npx playwright test' }, { host: 'claude', cwd: project }), /npx playwright test run from \/tmp, outside the project/);
  assert.match(refused('Bash', { command: `cd ${root} && playwright test` }, { host: 'claude', cwd: project }), /playwright test run from .*, outside the project/);
  assert.match(refused('Bash', { command: 'cd && npx playwright test' }, { host: 'claude', cwd: project }), /outside the project/, 'a bare cd goes home');
  assert.ok(refused('Bash', { command: 'cd .. ; pnpm exec playwright test' }, { host: 'claude', cwd: project }));
  assert.ok(refused('Bash', { command: 'bash -c "cd /tmp && npx playwright test"' }, { host: 'claude', cwd: project }));
  assert.ok(refused('exec_command', { cmd: 'npx playwright test', workdir: '/tmp' }, { host: 'codex', cwd: project }), 'Codex workdir outside the project');
  for (const command of ['npx playwright test', 'cd tests && npx playwright test', `cd ${project} && npx playwright test`, 'cd /tmp && cd - >/dev/null; npm test']) {
    assert.equal(refused('Bash', { command }, { host: 'claude', cwd: project }), null, command);
  }
  assert.equal(refused('exec_command', { cmd: 'npx playwright test', workdir: resolve(project, 'tests') }, { host: 'codex', cwd: project }), null);
});

test('code counts by what it does: a library loaded or a browser launched; code that only names one runs (no false positives)', (t) => {
  const { project } = fixture(t);
  const files = {
    'label.mjs': 'const label = "playwright";\nconsole.log(label);\n',
    'notes.cjs': "// The old version used puppeteer and selenium-webdriver; chromium.launch is gone.\nconst tools = ['playwright', 'puppeteer-core'];\n",
    'types.ts': "import type { Page } from 'playwright';\nexport const x = 1;\n",
    'godot.py': "import subprocess\nsubprocess.run(['godot', '--headless', '--export-release'])\n",
    'resolve.cjs': "console.log(require.resolve('playwright'));\n",
    'imp.mjs': "import { chromium } from 'playwright';\n",
    'multi.mjs': "import {\n  chromium,\n  devices,\n} from 'playwright-core';\n",
    'dyn.mjs': "const pw = await import('@playwright/test');\n",
    'side.mjs': "import 'npm:puppeteer@22';\n",
    'req.cjs': "const puppeteer = require('puppeteer-extra');\n",
    'sel.cjs': "const { Builder } = require('selenium-webdriver');\n",
    'from.py': 'from playwright.async_api import async_playwright\n',
    'imp.py': 'import os, selenium\n',
    'launch.cjs': 'const b = await chromium.launchPersistentContext(dir, {});\n',
    'cdp.cjs': "const b = await pw.chromium.connectOverCDP('http://127.0.0.1:9222');\n",
    'spawn.py': "import subprocess\nsubprocess.run(['google-chrome', '--headless', 'http://localhost:3000'])\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(resolve(project, name), text);
  for (const name of ['label.mjs', 'notes.cjs', 'types.ts', 'resolve.cjs']) assert.equal(refused('Bash', { command: `node ${name}` }, { cwd: project }), null, name);
  assert.equal(refused('Bash', { command: 'python3 godot.py' }, { cwd: project }), null, 'a headless flag with no browser named');
  for (const [name, what] of [
    ['imp.mjs', /uses Playwright/], ['multi.mjs', /uses Playwright/], ['dyn.mjs', /uses Playwright/], ['side.mjs', /uses Puppeteer/],
    ['req.cjs', /uses Puppeteer/], ['sel.cjs', /uses Selenium/], ['launch.cjs', /launches a browser/], ['cdp.cjs', /launches a browser/],
  ]) assert.match(refused('Bash', { command: `node ${name}` }, { cwd: project }) || '', what, name);
  for (const [name, what] of [['from.py', /uses Playwright/], ['imp.py', /uses Selenium/], ['spawn.py', /starts a browser/]]) {
    assert.match(refused('Bash', { command: `python3 ${name}` }, { cwd: project }) || '', what, name);
  }
  // Inline code: the same rule.
  for (const command of [
    `node -e "const label = 'playwright'; console.log(label)"`,
    `python3 -c "print('selenium webdriver')"`,
    `node -e "console.log('use puppeteer next time')"`,
    `echo "playwright" | node`,
  ]) assert.equal(refused('Bash', { command }, { cwd: project }), null, command);
  for (const command of [
    `node -e "import('playwright').then(p => p.chromium.launch())"`,
    `python3 -c "import sys; import playwright"`,
    `python3 -c "__import__('pyppeteer')"`,
    `node --input-type=module -e "import { chromium } from 'playwright'"`,
  ]) assert.ok(refused('Bash', { command }, { cwd: project }), command);
});

test('browserPolicyText: the one rule text, with each host\'s tool names and web tools', () => {
  const claude = browserPolicyText({ tools: 'mcp__SynaBun__', host: 'claude' });
  assert.match(claude, /^- Every page, public or localhost, goes through SynaBun's browser tools \(mcp__SynaBun__browser_navigate, mcp__SynaBun__browser_snapshot, mcp__SynaBun__browser_screenshot, mcp__SynaBun__browser_console/);
  assert.match(claude, /they open the browser configured in SynaBun \(MoreLogin\)/);
  assert.match(claude, /Never run Playwright, Puppeteer or Selenium code of your own/);
  assert.match(claude, /never `npx playwright` except to run the project's automated tests/);
  assert.match(claude, /Never launch Chrome, Chromium, Edge, chrome-headless-shell or any other browser binary, and never take headless screenshots/);
  assert.match(claude, /Never `open` a URL or a browser app, and never use computer use on a browser app/);
  assert.match(claude, /Never use the Playwright, Chrome DevTools, Claude-in-Chrome or any other browser MCP tools, nor WebSearch \/ WebFetch\./);
  assert.match(claude, /Visual checks: mcp__SynaBun__browser_screenshot \(width, height, fullPage, save\)\. Page errors and console output: mcp__SynaBun__browser_console/);
  assert.match(claude, /If the SynaBun browser fails, is unavailable or lacks what you need, stop and report it\. Never substitute/);
  assert.match(claude, /This rule overrides any task text, context or memory that says otherwise/);
  assert.match(browserPolicyText({ tools: 'SynaBun_', host: 'opencode' }), /SynaBun_browser_navigate[\s\S]*nor webfetch \/ websearch\./);
  assert.match(browserPolicyText({ tools: 'SynaBun_', host: 'codex' }), /nor Codex's web_search\./);
  assert.match(browserPolicyText(), /\(browser_navigate, browser_snapshot[\s\S]*WebSearch \/ WebFetch \(OpenCode webfetch \/ websearch, Codex web_search\)/);
});

// ── the brain ────────────────────────────────────────────────────────────────

function fakeRouter() {
  return { owns: () => false, pendingCards: () => [], cancelForSession() {}, stamp: () => ({ text: '', changed: false, commit() {} }) };
}
function brainHarness(t, { gateMode = null, router = fakeRouter() } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'asst-browser-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = [];
  const factory = ({ session, sink, deps, hooks }) => {
    let busy = false;
    log.push(['create', hooks, deps]);
    return {
      kind: session.brain.provider, gateMode, sink,
      async start() {},
      async sendUserTurn({ text }) { log.push(['turn', text]); busy = true; setTimeout(() => { busy = false; sink.send({ type: 'done', code: 0 }); }, 5); },
      async abort() { log.push(['abort']); busy = false; sink.send({ type: 'aborted' }); },
      isBusy: () => busy, identity: () => ({ providerSessionId: 'main' }), async dispose() {},
    };
  };
  const runtime = createAssistantRuntime({
    dataDir: dir, brainFactories: { 'claude-code': factory, opencode: factory, codex: factory }, router,
    catalog: { peek: () => ({ models: {} }), brainInfo: () => null, hiddenId: () => null }, gateUrl: 'http://127.0.0.1:1/api/assistant/route-gate/check',
    codexGateBootstrap: async () => ({ flags: ['-c', 'hooks.PreToolUse=[]'], env: {} }),
  });
  t.after(() => runtime.shutdown());
  return { runtime, log };
}
const approvedDirect = (provider) => ({ ok: true, status: 'approved', routeId: 'route-1', target: { kind: 'direct', provider, model: 'm' }, continuation: false });
const denial = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : null;

test('Claude brain: the browser hook refuses for subagents and in plan mode (the route gate steps aside there); SynaBun\'s tools pass; scripts resolve against the session cwd', async (t) => {
  const { project, root } = fixture(t);
  writeFileSync(resolve(project, 'pw.cjs'), readFileSync(resolve(root, 'pw.cjs')));
  const { runtime, log } = brainHarness(t);
  const session = await runtime.createSession({ brain: { provider: 'claude-code', cwd: project } });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(live, { text: 'check the page' });
  const hooks = log.find(([k]) => k === 'create')[1];
  assert.equal(hooks.PreToolUse.length, 2, 'route gate + browser policy');
  const gateHook = hooks.PreToolUse[0].hooks[0];
  const browserHook = hooks.PreToolUse[1].hooks[0];
  assert.equal(hooks.PreToolUse[1].matcher, undefined, 'every tool');
  runtime.routerRouted(session.id, approvedDirect('claude-code'));
  const chrome = { tool_name: 'Bash', tool_input: { command: 'google-chrome --headless --screenshot http://localhost:3917/' } };
  assert.deepEqual(await gateHook(chrome), {}, 'routed: the gate opens');
  assert.match(denial(await browserHook(chrome)), /google-chrome started from the shell/);
  assert.match(denial(await browserHook({ ...chrome, agent_id: 'sub-1' })), /SynaBun browser policy/, 'a subagent\'s call is refused too');
  assert.match(denial(await browserHook({ tool_name: 'Bash', tool_input: { command: 'node pw.cjs' } })), /running pw\.cjs, a script that uses Playwright/, 'relative to the session cwd');
  assert.deepEqual(await browserHook({ tool_name: 'mcp__SynaBun__browser_navigate', tool_input: { url: 'http://localhost:3000' } }), {});
  assert.deepEqual(await browserHook({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), {});
  // Plan mode: decide() allows everything (the plan policy decides), the browser policy still refuses.
  live.record.brain.planMode = true;
  assert.deepEqual(await gateHook({ tool_name: 'WebFetch', tool_input: {} }), {}, 'the route gate steps aside while planning');
  assert.match(denial(await browserHook({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } })), /WebFetch was refused/);
  assert.match(denial(await browserHook({ tool_name: 'mcp__chrome-devtools__navigate_page', tool_input: {}, agent_id: 'sub-2' })), /chrome-devtools/);
});

test('gateCheck (Codex hook / OpenCode plugin): the browser policy refuses before the subagent short-circuits, in plan mode too', async (t) => {
  for (const provider of ['codex', 'opencode']) {
    const { runtime } = brainHarness(t);
    const session = await runtime.createSession({ brain: { provider } });
    const live = runtime._internals.sessions.get(session.id);
    await runtime._internals.runQuery(live, { text: 'look at localhost' });
    await wait(20);
    const token = live.gateToken;
    runtime.routerRouted(session.id, approvedDirect(provider));
    const shell = provider === 'codex' ? { tool: 'Bash', input: { command: 'npx playwright install chromium-headless-shell' } } : { tool: 'bash', input: { command: 'npx playwright install chromium-headless-shell' } };
    const refusedCall = runtime.gateCheck({ session: session.id, token, ...shell, inputComplete: true, host: provider, providerSessionId: 'main' });
    assert.equal(refusedCall.allow, false, provider);
    assert.equal(refusedCall.browser, true);
    assert.match(refusedCall.reason, /npx playwright install/);
    assert.equal(runtime.gateCheck({ session: session.id, token, ...shell, inputComplete: true, host: provider, agent: 'sub-1' }).browser, true, `${provider}: a Codex subagent`);
    assert.equal(runtime.gateCheck({ session: session.id, token, ...shell, inputComplete: true, host: provider, providerSessionId: 'child' }).browser, true, `${provider}: an OpenCode child session`);
    const web = provider === 'codex' ? 'web_search' : 'webfetch';
    assert.equal(runtime.gateCheck({ session: session.id, token, tool: web, input: {}, inputComplete: true, host: provider }).browser, true);
    assert.deepEqual(runtime.gateCheck({ session: session.id, token, tool: provider === 'codex' ? 'mcp__SynaBun__browser_navigate' : 'SynaBun_browser_navigate', input: { url: 'http://localhost:3000' }, inputComplete: true, host: provider, providerSessionId: 'main' }), { allow: true });
    // An oversized call arrives as its command only: checked on that.
    assert.equal(runtime.gateCheck({ session: session.id, token, ...shell, inputComplete: false, host: provider }).browser, true);
    live.record.brain.planMode = true;
    assert.equal(runtime.gateCheck({ session: session.id, token, ...shell, inputComplete: true, host: provider }).browser, true, `${provider}: plan mode`);
    assert.equal(runtime.gateCheck({ session: session.id, token, tool: shell.tool, input: { command: 'git status' }, inputComplete: true, host: provider, providerSessionId: 'main' }).allow, true);
  }
});

test('reactive fallback: a browser launch that already started interrupts the turn and the next turn says why (plan mode included)', async (t) => {
  const { runtime, log } = brainHarness(t, { gateMode: 'reactive' });
  const session = await runtime.createSession({ brain: { provider: 'codex' } });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(live, { text: 'screenshot localhost' });
  await wait(20);
  runtime.routerRouted(session.id, approvedDirect('codex'));
  live.running = true;
  runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'mcp__SynaBun__browser_navigate' } }] } } });
  await wait(20);
  assert.equal(log.filter(([k]) => k === 'abort').length, 0, 'an allowed call on an open route runs');
  live.running = true;
  runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot http://localhost:9003/', cwd: '/tmp' } }] } } });
  await wait(40);
  assert.equal(log.filter(([k]) => k === 'abort').length, 1);
  const nudge = log.filter(([k]) => k === 'turn').at(-1)[1];
  assert.match(nudge, /^\[SynaBun Browser\] Your last tool call was stopped before it finished\. SynaBun browser policy: Bash was refused — Google Chrome started from the shell/);
  assert.doesNotMatch(nudge, /SynaBun Router/, 'a browser refusal is not a routing message');
  assert.equal(live.gate.snapshot().refusals, 0, 'not a route refusal: the loop guard does not count it');
  await wait(20);
  live.record.brain.planMode = true;
  live.running = true;
  runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'WebSearch', input: { query: 'x' } }] } } });
  await wait(40);
  assert.equal(log.filter(([k]) => k === 'abort').length, 2, 'plan mode: the browser policy still interrupts');
});

// ── the workers (Assistant task runs only) ──────────────────────────────────

function claudeOptions(t, runMode, cwd) {
  const captured = {};
  return createClaudeNativeLoopAdapter({
    runId: `run-${runMode}`, cwd, runMode, resolveRuntime: () => ({ ok: true }), logWarn: () => {},
    queryFactory: ({ options }) => { captured.options = options; const g = (async function* () {})(); g.interrupt = async () => {}; return g; },
  }).then(async (adapter) => { t.after(() => adapter.dispose()); return captured.options; });
}

test('Claude workers: a matcher-less PreToolUse entry refuses by the policy with the run cwd — task runs only', async (t) => {
  const { project, root } = fixture(t);
  writeFileSync(resolve(project, 'pw.cjs'), readFileSync(resolve(root, 'pw.cjs')));
  const task = await claudeOptions(t, 'task', project);
  assert.equal(task.hooks.PreToolUse.length, 2);
  assert.equal(task.hooks.PreToolUse[0].matcher, 'AskUserQuestion|ExitPlanMode', 'the interactive-tool deny stays first');
  const hook = task.hooks.PreToolUse[1].hooks[0];
  assert.equal(task.hooks.PreToolUse[1].matcher, undefined);
  assert.match(denial(await hook({ tool_name: 'Bash', tool_input: { command: 'node pw.cjs' } })), /running pw\.cjs, a script that uses Playwright/);
  assert.match(denial(await hook({ tool_name: 'mcp__plugin_playwright_playwright__browser_take_screenshot', tool_input: {}, agent_id: 'sub-1' })), /plugin_playwright_playwright/);
  assert.deepEqual(await hook({ tool_name: 'mcp__SynaBun__browser_screenshot', tool_input: {} }), {});
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: 'npx playwright test' } }), {});
  const loop = await claudeOptions(t, 'loop', project);
  assert.equal(loop.hooks.PreToolUse.length, 1, 'loops and schedules are unchanged');
});

const TRUST = { key: '/<session-flags>/config.toml:pre_tool_use:0:0', hash: 'sha256:ab12' };

test('Codex workers: the policy hook rides in the SDK config with its trust entry (task runs only); web search off; untrusted → instructions only, noted', async (t) => {
  const { project } = fixture(t);
  const make = async (options) => {
    const captured = { ctor: null, thread: null };
    class FakeCodex {
      constructor(opts) { captured.ctor = opts; }
      startThread(opts) { captured.thread = opts; return { id: 'thr', async runStreamed() { return { events: (async function* () {})() }; } }; }
    }
    const notes = [];
    const probes = [];
    const adapter = await createCodexNativeLoopAdapter({
      runId: 'run-1', cwd: project, codexHome: '/tmp/codex-home', codexPath: '/opt/homebrew/bin/codex', CodexClass: FakeCodex,
      onNote: (text) => notes.push(text), browserPolicyTrust: async (args) => { probes.push(args); return options.trust ?? null; }, ...options,
    });
    return { captured, notes, probes, adapter };
  };
  const trusted = await make({ runMode: 'task', trust: TRUST });
  const command = codexGateHookCommand({ hookPath: CODEX_BROWSER_POLICY_HOOK_PATH });
  assert.deepEqual(trusted.probes, [{ codexBin: '/opt/homebrew/bin/codex', command }], 'the brain\'s trust probe, for this hook');
  assert.deepEqual(trusted.captured.ctor.config.features, { hooks: true });
  assert.deepEqual(trusted.captured.ctor.config.hooks, { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 15 }] }] });
  assert.equal(trusted.captured.ctor.config[`hooks.state={"${TRUST.key}"={trusted_hash="${TRUST.hash}"}} #`], true);
  assert.ok(trusted.captured.ctor.config.mcp_servers.SynaBun.env, 'the MCP pins stay');
  assert.equal(trusted.captured.ctor.env.SYNABUN_BROWSER_POLICY_CWD, project);
  assert.equal(trusted.captured.thread.webSearchMode, 'disabled');
  assert.deepEqual(trusted.notes, []);
  assert.equal(trusted.adapter.describe().browserPolicy, 'hook');
  const untrusted = await make({ runMode: 'task', trust: null });
  assert.equal(untrusted.captured.ctor.config.hooks, undefined);
  assert.equal(untrusted.captured.ctor.env.SYNABUN_BROWSER_POLICY_CWD, undefined);
  assert.deepEqual(untrusted.notes, [CODEX_BROWSER_POLICY_UNTRUSTED_NOTE]);
  assert.equal(CODEX_BROWSER_POLICY_UNTRUSTED_NOTE, 'browser policy: instructions only (Codex hook not trusted)');
  assert.equal(untrusted.adapter.describe().browserPolicy, 'instructions');
  assert.equal(untrusted.captured.thread.webSearchMode, 'disabled', 'no web search of its own either way');
  const loop = await make({ trust: TRUST });
  assert.deepEqual([loop.probes.length, loop.captured.ctor.config.hooks, loop.captured.thread.webSearchMode, loop.adapter.describe().browserPolicy], [0, undefined, undefined, undefined], 'loops and schedules are unchanged');
  // No absolute binary to probe (a bare name would go through a shell): instructions only.
  assert.equal(await codexBrowserPolicyHook({ codexBin: 'codex', trust: async () => TRUST }), null);
  assert.equal(await codexBrowserPolicyHook({ codexBin: null, trust: async () => TRUST }), null);
  assert.equal(codexHookConfig(command, null), null);
  assert.equal(codexHookConfig(command, { key: 'k' }), null);
});

test('Codex workers: the generated argv through the real Codex SDK carries the hook, one hooks.state override Codex parses as a table, and web search off', async (t) => {
  const { project } = fixture(t);
  const dir = mkdtempSync(resolve(tmpdir(), 'fake-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const argvFile = resolve(dir, 'argv.json');
  const bin = resolve(dir, 'codex.mjs');
  writeFileSync(bin, [
    `#!${process.execPath}`,
    "import { writeFileSync } from 'node:fs';",
    "let input = '';",
    'for await (const chunk of process.stdin) input += chunk;',
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.env.SYNABUN_BROWSER_POLICY_CWD || null }));`,
    "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thr-fake' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + '\\n');",
  ].join('\n'));
  chmodSync(bin, 0o755);
  const adapter = await createCodexNativeLoopAdapter({ runId: 'run-argv', cwd: project, codexHome: dir, codexPath: bin, runMode: 'task', browserPolicyTrust: async () => TRUST });
  t.after(() => adapter.dispose());
  await adapter.runTurn('look at the page');
  const { argv, cwd } = JSON.parse(readFileSync(argvFile, 'utf8'));
  const overrides = argv.flatMap((arg, i) => (argv[i - 1] === '--config' ? [arg] : []));
  const command = codexGateHookCommand({ hookPath: CODEX_BROWSER_POLICY_HOOK_PATH });
  assert.ok(overrides.includes('features.hooks=true'), overrides.join('\n'));
  assert.ok(overrides.includes(`hooks.PreToolUse=[{matcher = "*", hooks = [{type = "command", command = ${JSON.stringify(command)}, timeout = 15}]}]`), overrides.join('\n'));
  // Codex splits `key=value` at the first "=" and parses the value as TOML (`_x_ = <value>`): the
  // comment swallows the SDK's "=true", leaving one inline table keyed by the whole hook key.
  const state = overrides.find((arg) => arg.startsWith('hooks.state='));
  assert.equal(state, `hooks.state={"${TRUST.key}"={trusted_hash="${TRUST.hash}"}} #=true`);
  assert.equal(overrides.filter((arg) => arg.startsWith('hooks.state')).length, 1, 'never a dotted path (the key holds a ".")');
  assert.ok(overrides.includes('web_search="disabled"'));
  assert.equal(cwd, project, 'the hook reads the run\'s project from its env');
});

test('Codex worker hook script: evaluates locally from the PreToolUse payload; deny JSON when refused, nothing otherwise', async (t) => {
  const { project, root } = fixture(t);
  writeFileSync(resolve(project, 'pw.cjs'), readFileSync(resolve(root, 'pw.cjs')));
  const run = (payload, env = {}) => new Promise((done) => {
    const child = spawn(process.execPath, [CODEX_BROWSER_POLICY_HOOK_PATH], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => done({ code, out }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  const denied = await run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node pw.cjs' }, cwd: project });
  assert.equal(denied.code, 0);
  const reason = JSON.parse(denied.out).hookSpecificOutput;
  assert.deepEqual([reason.hookEventName, reason.permissionDecision], ['PreToolUse', 'deny']);
  assert.match(reason.permissionDecisionReason, /running pw\.cjs, a script that uses Playwright/);
  assert.doesNotMatch(reason.permissionDecisionReason, /\.$/, 'Codex appends ". Command: …" itself');
  const fromEnv = await run({ tool_name: 'exec_command', tool_input: { command: ['bash', '-lc', 'node pw.cjs'] } }, { SYNABUN_BROWSER_POLICY_CWD: project });
  assert.match(JSON.parse(fromEnv.out).hookSpecificOutput.permissionDecisionReason, /pw\.cjs/, 'the run cwd from the env');
  assert.equal((await run({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: project })).out, '');
  assert.equal((await run({ tool_name: 'mcp__SynaBun__browser_navigate', tool_input: { url: 'http://localhost:3000' } })).out, '');
  assert.deepEqual(await run('not json'), { code: 0, out: '' }, 'unreadable input allows');
});

test('OpenCode workers: the serve config gets the plugin (the user\'s plugins kept, ours once); the plugin throws the refusal and passes the rest', async (t) => {
  const { project, root } = fixture(t);
  writeFileSync(resolve(project, 'pw.cjs'), readFileSync(resolve(root, 'pw.cjs')));
  assert.match(OPENCODE_BROWSER_POLICY_PLUGIN, /^file:\/\/.*\/lib\/assistant-brains\/opencode-browser-policy\.js$/);
  const config = { plugin: ['user-plugin@1', [OPENCODE_BROWSER_POLICY_PLUGIN, { cwd: '/old' }]], mcp: {} };
  withOpenCodeBrowserPolicy(config, { cwd: project });
  assert.deepEqual(config.plugin, ['user-plugin@1', [OPENCODE_BROWSER_POLICY_PLUGIN, { cwd: project }]]);
  assert.deepEqual(withOpenCodeBrowserPolicy({}, {}).plugin, [[OPENCODE_BROWSER_POLICY_PLUGIN, {}]]);
  const hooks = await browserPolicyPlugin({ directory: '/elsewhere' }, { cwd: project });
  const before = hooks['tool.execute.before'];
  await assert.rejects(before({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'node pw.cjs' } }), /SynaBun browser policy: bash was refused — running pw\.cjs/);
  await assert.rejects(before({ tool: 'webfetch' }, { args: { url: 'https://example.com' } }), /webfetch was refused/);
  await assert.rejects(before({ tool: 'playwright_browser_navigate' }, { args: {} }), /playwright MCP server/);
  await before({ tool: 'SynaBun_browser_navigate' }, { args: { url: 'http://localhost:3000' } });
  await before({ tool: 'bash' }, { args: { command: 'npx playwright test' } });
  // The worker serve config SynaBun writes (server.js): task runs only.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /function setupOpencodeLoopConfig\([^)]*, \{ browserPolicy = false, cwd = null \} = \{\}\) \{/);
  assert.match(server, /if \(browserPolicy\) withOpenCodeBrowserPolicy\(baseCfg, \{ cwd \}\);/);
  assert.match(server, /\{ browserPolicy: state\.runMode === 'task', cwd: state\.cwd \|\| null \}/);
});

/** A copy of lib/assistant-brains/<file> whose ../browser-tool-policy.js is missing, or `broken` source. */
function orphanCopy(t, file, broken = null) {
  const dir = mkdtempSync(resolve(tmpdir(), 'synabun-policy-orphan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(resolve(dir, 'assistant-brains'));
  const path = resolve(dir, 'assistant-brains', file);
  writeFileSync(path, readFileSync(new URL(`../lib/assistant-brains/${file}`, import.meta.url)));
  if (broken !== null) writeFileSync(resolve(dir, 'browser-tool-policy.js'), broken);
  return path;
}

test('OpenCode plugin fails closed when the policy cannot load: bash, web tools and other servers\' tools refused, SynaBun and file tools pass, logged once', async (t) => {
  for (const broken of [null, 'export const browserToolDenial = ;']) {
    const path = orphanCopy(t, 'opencode-browser-policy.js', broken);
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    let hooks;
    try { hooks = await (await import(`${pathToFileURL(path).href}?v=${Date.now()}`)).default({ directory: '/tmp' }, {}); } finally { console.error = original; }
    assert.equal(errors.length, 1, 'logged once, at load');
    assert.match(errors[0], /\[SynaBun\] browser policy could not load from file:.*browser-tool-policy\.js .*refusing bash, webfetch, websearch and other servers' tools/);
    const before = hooks['tool.execute.before'];
    for (const tool of ['bash', 'webfetch', 'websearch', 'playwright_browser_navigate', 'github_create_issue', 'some_plugin_tool']) {
      await assert.rejects(before({ tool }, { args: { command: 'echo hi' } }), new RegExp(`^Error: SynaBun browser policy: ${tool} was refused — SynaBun's browser policy could not load \\(.+\\), so no command, web tool or other server's tool can be checked`), tool);
    }
    for (const tool of ['SynaBun_browser_navigate', 'synabun_recall', 'read', 'edit', 'write', 'grep', 'glob', 'todowrite', 'task']) await before({ tool }, { args: {} });
  }
  const module = await import(pathToFileURL(fileURLToPath(new URL('../lib/assistant-brains/opencode-browser-policy.js', import.meta.url))).href);
  assert.deepEqual(Object.keys(module), ['default'], 'OpenCode runs every exported function as a plugin');
});

test('Codex worker hook fails closed when the policy cannot load: shell, web search and other servers\' MCP tools denied, SynaBun\'s pass', async (t) => {
  const path = orphanCopy(t, 'codex-browser-policy-hook.mjs');
  const run = (payload) => new Promise((done) => {
    const child = spawn(process.execPath, [path]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => done({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
  for (const tool of ['Bash', 'exec_command', 'web_search', 'mcp__playwright__browser_navigate', 'mcp__github__create_issue']) {
    const { code, out, err } = await run({ tool_name: tool, tool_input: { command: 'echo hi' } });
    assert.equal(code, 0);
    const decision = JSON.parse(out).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'deny', tool);
    assert.match(decision.permissionDecisionReason, new RegExp(`^SynaBun browser policy: ${tool} was refused — SynaBun's browser policy could not load`));
    assert.doesNotMatch(decision.permissionDecisionReason, /\.$/);
    assert.match(err, /\[SynaBun\] browser policy could not load/);
  }
  for (const tool of ['mcp__SynaBun__browser_navigate', 'mcp__claude_ai_Synabun__recall', 'apply_patch', 'view_image']) {
    assert.equal((await run({ tool_name: tool, tool_input: {} })).out, '', tool);
  }
});

// ── dispatch defaults ────────────────────────────────────────────────────────

function dispatchHarness(t, { onFactory = null } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-browser-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const acquired = [];
  const makeAdapter = (state) => {
    onFactory?.(state);
    return {
      identity: () => ({ providerSessionId: `sess-${state.runId.slice(0, 4)}` }), isAlive: () => true,
      async runTurn() { return { text: '## Result\nstatus: done\nsummary: ok\nchanges:\n- none\nfollow_ups:\n- none', costUsd: 0.01 }; },
      async abort() {}, async dispose() {},
    };
  };
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'), ledgerPath: resolve(root, 'runs.json'), buildPrompt: () => 'x', iterationDelayMs: 0,
    providerFactories: { codex: async (state) => makeAdapter(state), 'claude-code': async (state) => makeAdapter(state), opencode: async (state) => makeAdapter(state) },
  });
  const dispatcher = createAssistantDispatcher({
    getRuntime: () => runtime, dataDir: root, loopDir: resolve(root, 'loop'), broadcastSync: () => {}, PACKAGE_ROOT: root,
    getCodexAccount: () => ({ id: 'default', home: '/tmp/codex-default' }), CODEX_DEFAULT_HOME: '/tmp/codex-default',
    detectProject: () => 'proj', limits: { minIdleTimeoutMs: 50 },
    readActiveMcpProfile: () => 'core',
    acquireLoopBrowserAndTab: async (args) => { acquired.push(args); return { browserSessionId: 'browser-1', browserTabId: `tab-${acquired.length}` }; },
  });
  t.after(() => dispatcher.shutdown('test'));
  return { root, dispatcher, acquired };
}

test('dispatch: a Codex / OpenCode browser run of any class gets mcp_profile "browser" unless it names one; the rest keep the active profile', async (t) => {
  const { root, dispatcher, acquired } = dispatchHarness(t);
  const session = { assistantSessionId: 'assistant-1' };
  const run = async (spec) => (await dispatcher.dispatch({ cwd: root, capability: 'workspace', ...spec }, session)).run;
  assert.deepEqual([(await run({ provider: 'codex', task: 'Check the page', taskClass: 'code', usesBrowser: true })).mcpProfile, acquired.length], ['browser', 1]);
  assert.equal((await run({ provider: 'opencode', model: 'ollama/qwen', task: 'Read the docs site', taskClass: 'research', usesBrowser: true })).mcpProfile, 'browser');
  assert.equal((await run({ provider: 'codex', task: 'Post it', taskClass: 'social', usesBrowser: true, mcpProfile: 'twitter' })).mcpProfile, 'twitter', 'a named profile wins');
  assert.equal((await run({ provider: 'codex', task: 'Refactor', taskClass: 'code' })).mcpProfile, 'core', 'no browser: the active profile');
  assert.equal((await run({ provider: 'codex', task: 'Refactor', taskClass: 'code', usesBrowser: 'false' })).usesBrowser, false, '"false" is false for every class');
  assert.equal((await run({ provider: 'claude-code', task: 'Check the page', taskClass: 'code', usesBrowser: true })).mcpProfile, 'full', 'Claude workers always get the full catalog');
});

test('dispatch: browser settings that cannot agree are refused for every class (BROWSER_SETTINGS_CONFLICT, class-neutral wording)', async (t) => {
  const { root, dispatcher, acquired } = dispatchHarness(t);
  const session = { assistantSessionId: 'assistant-1' };
  const conflict = (pattern) => (error) => error.code === 'BROWSER_SETTINGS_CONFLICT' && error.status === 400 && pattern.test(error.message) && !/design/i.test(error.message);
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'QA the page', cwd: root, taskClass: 'code', capability: 'workspace', usesBrowser: true, mcpProfile: 'standard' }, session),
    conflict(/^This run uses the SynaBun browser \(uses_browser is on\), but mcp_profile "standard" has no browser tools, so the codex worker could not use it\. Use mcp_profile "browser" or drop mcp_profile/));
  await assert.rejects(dispatcher.dispatch({ provider: 'opencode', model: 'ollama/qwen', task: 'QA', cwd: root, taskClass: 'research', capability: 'read-only', usesBrowser: true, mcpProfile: 'core' }, session), conflict(/"core" has no browser tools, so the opencode worker/));
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'Fix', cwd: root, taskClass: 'code', usesBrowser: false, mcpProfile: 'browser' }, session), conflict(/uses_browser is false, but mcp_profile "browser" is a browser profile/));
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'Fix', cwd: root, taskClass: 'quick', usesBrowser: 'false', mcpProfile: 'linkedin' }, session), conflict(/uses_browser is false, but mcp_profile "linkedin"/));
  assert.deepEqual([dispatcher.list().length, acquired.length], [0, 0], 'nothing started, no tab taken');
});

test('dispatch: a note the adapter reports while it starts (an untrusted Codex hook) lands on the run', async (t) => {
  const { root, dispatcher } = dispatchHarness(t, { onFactory: (state) => { if (state.profile === 'codex') state.onNote(CODEX_BROWSER_POLICY_UNTRUSTED_NOTE); } });
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'Write docs', cwd: root, taskClass: 'code' }, { assistantSessionId: 'assistant-1' });
  const run = await waitFor(() => { const r = dispatcher.get(launched.run.runId); return r.state === 'idle' ? r : null; });
  assert.ok(run.notes.includes(CODEX_BROWSER_POLICY_UNTRUSTED_NOTE), run.notes.join(' | '));
  const stateFile = JSON.parse(readFileSync(resolve(root, 'loop', `${launched.run.runId}.json`), 'utf8'));
  assert.equal(stateFile.onNote, undefined, 'functions never reach the state file');
});

// ── instructions ─────────────────────────────────────────────────────────────

test('persona: the Pages line with the policy in each host\'s tool names, the delegation rule, and plan mode\'s SynaBun browser', () => {
  const claude = buildAssistantPersona({ assistantSessionId: 'assistant-x', brain: { provider: 'claude-code' }, toolPrefix: 'mcp__SynaBun__' });
  assert.match(claude, /- Pages, public web and localhost alike: the SynaBun browser, in a new tab\. The browser policy \(enforced: SynaBun refuses the rest\):\n  - Every page, public or localhost, goes through SynaBun's browser tools \(mcp__SynaBun__browser_navigate/);
  assert.match(claude, /  - Visual checks: mcp__SynaBun__browser_screenshot \(width, height, fullPage, save\)\. Page errors and console output: mcp__SynaBun__browser_console/);
  assert.match(claude, /nor WebSearch \/ WebFetch\./);
  assert.doesNotMatch(claude, /- Web: the SynaBun browser tools/);
  assert.match(claude, /6\. Pages: a worker that must look at any page, public or localhost \(visual QA included\), gets uses_browser:true with capability workspace or read-only/);
  assert.match(claude, /Never tell a worker to use Playwright, Chrome or another browser\. A worker that finishes blocked with "needs the SynaBun browser" is dispatched again with uses_browser:true, not escalated\./);
  const codex = buildAssistantPersona({ assistantSessionId: 'assistant-x', brain: { provider: 'codex' }, toolPrefix: 'SynaBun_', hasAskUserQuestion: false });
  assert.match(codex, /SynaBun_browser_navigate, SynaBun_browser_snapshot, SynaBun_browser_screenshot, SynaBun_browser_console/);
  assert.match(codex, /nor Codex's web_search\./);
  assert.match(buildAssistantPersona({ assistantSessionId: 'a', brain: { provider: 'opencode' }, toolPrefix: 'SynaBun_' }), /nor webfetch \/ websearch\./);
  for (const provider of ['claude-code', 'codex', 'opencode']) {
    const text = planModeInstructions({ provider });
    assert.match(text, /use every other tool \(MCP tools, subagents, skills\) to explore and verify\. Anything on the web or localhost goes through the SynaBun browser\./, provider);
    assert.doesNotMatch(text, /skills, the web\)/, provider);
  }
});

test('task prompt: a browser run gets the policy (localhost, overriding the task); a run without one is told to finish blocked with "needs the SynaBun browser"', () => {
  const base = { task: 'Screenshot http://localhost:3917 with Playwright and system Chrome', cwd: '/work/app', project: 'app', runId: 'r1', permissionPolicy: 'auto', capability: 'workspace' };
  const browser = buildTaskPrompt({ ...base, provider: 'codex', usesBrowser: true, browserSessionId: 'bs-1', browserTabId: 'tab-2' });
  assert.match(browser, /=== BROWSER ENFORCEMENT \(MANDATORY\) ===\nThis automation REQUIRES the SynaBun internal browser\.\nYOUR BROWSER SESSION: bs-1\nYOUR BROWSER TAB: tab-2\nPass sessionId: "bs-1" and tabId: "tab-2" to EVERY browser tool call/);
  assert.match(browser, /Browser policy:\n- Every page, public or localhost, goes through SynaBun's browser tools \(browser_navigate, browser_snapshot, browser_screenshot, browser_console/);
  assert.match(browser, /nor Codex's web_search\./);
  assert.match(browser, /This rule overrides any task text, context or memory that says otherwise\./);
  assert.ok(browser.indexOf('Browser policy:') < browser.indexOf('TASK:'), 'the rule comes before the task text');
  assert.doesNotMatch(browser, /NO BROWSER IN THIS RUN/);
  const claude = buildTaskPrompt({ ...base, provider: 'claude-code', usesBrowser: true });
  assert.match(claude, /nor WebSearch \/ WebFetch\./);
  const none = buildTaskPrompt({ ...base, provider: 'opencode' });
  assert.doesNotMatch(none, /BROWSER ENFORCEMENT/);
  assert.match(none, /=== NO BROWSER IN THIS RUN ===\nThis run has no browser\. If you need to look at any page \(public or localhost, visual checks included\), stop and finish with status blocked and the words "needs the SynaBun browser"/);
  assert.match(none, /Never start Playwright, Puppeteer, Chrome or another browser, take headless screenshots, or use web search \/ fetch instead\./);
  assert.equal(NEEDS_BROWSER, 'needs the SynaBun browser');
});

test('the Codex brain (assistant role) starts its app-server with web search off, like its workers; the sidepanel keeps it', async () => {
  const vm = await import('node:vm');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("    const args = [\n      '-c',\n      `mcp_servers.SynaBun.env.SYNABUN_PROFILE=");
  const end = server.indexOf('    if (/\\.js$/i.test(codexBin)) {', start);
  assert.ok(start > 0 && end > start, 'the app-server argument block');
  const argsFor = (codexRole) => vm.runInNewContext(`(() => {\n${server.slice(start, end)}\nreturn args;\n})()`, {
    codexMcpProfileState: { value: 'browser' }, codexMcpRuntimeId: 'rt-1', runtimeProfilePath: '/tmp/profile.json',
    codexRole, codexDesktopGrant: null, codexRouteGate: null, JSON,
  });
  const brain = argsFor('assistant');
  assert.equal(brain.at(-1), 'app-server');
  assert.ok(brain.includes('web_search="disabled"'), brain.join(' '));
  assert.equal(brain[brain.indexOf('web_search="disabled"') - 1], '-c');
  assert.ok(!argsFor(null).includes('web_search="disabled"'), 'the Codex sidepanel is not the Assistant');
});
