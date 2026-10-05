// ═══════════════════════════════════════════
// SynaBun — Browser tool policy: every page through the SynaBun browser
// ═══════════════════════════════════════════
//
// The Assistant's brain (Claude, Codex, OpenCode) and the workers it
// dispatches look at pages — public or localhost — only through SynaBun's
// browser tools (browser_*), which open the browser configured in SynaBun
// (MoreLogin). They never start a browser of their own, and when the SynaBun
// browser fails or lacks something they report it instead of switching.
//
//   browserPolicyText   the one rule text: the persona, plan mode, worker prompts
//   browserToolDenial   one tool call's refusal, else null. The brain asks it in
//                       assistant-runtime.js (browserGate: the Claude hook, the
//                       Codex hook and OpenCode plugin through gateCheck, the
//                       reactive fallback); Assistant task runs' workers in
//                       native-loop-providers.js (Claude),
//                       assistant-brains/codex-browser-policy-hook.mjs and
//                       assistant-brains/opencode-browser-policy.js
//
// Lexical, like remote-policy.js: a speed bump, not a sandbox. A shell that
// builds a program name at run time, or a script loading a browser library
// from a file SynaBun cannot read, gets past it. Mentions (rg playwright,
// cat pw.cjs, sed -i … pw.cjs, git, code that only names a library) and a
// project's own automated tests (npm test, node --test, vitest, jest, npx
// playwright test run inside the project on files inside it) always pass.
// Computer use on a browser window is refused by the desktop guards
// (lib/desktop/guards.js), which know the app a click or a key lands in.
// Pure ESM with no imports of SynaBun's own, loaded by Node and by OpenCode's
// Bun plugin host: no I/O but the injectable readFile that reads an executed
// script. remote-policy.js is not imported (it reaches backup-service.js and
// node:sqlite); its command-position matching and per-host input keys are
// repeated here in small.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/** An executed script is read up to this size; a larger or unreadable one is allowed. */
export const MAX_SCRIPT_BYTES = 256 * 1024;
// A longer command line is checked in its first part only.
const MAX_COMMAND_CHARS = 256 * 1024;
// sh -c / eval / heredocs fed to a shell, nested.
const MAX_DEPTH = 4;

// ── the rule text ───────────────────────────────────────────────────────────

const HOSTS = { claude: 'claude', 'claude-code': 'claude', codex: 'codex', opencode: 'opencode' };
const hostKey = (host) => HOSTS[String(host || '').toLowerCase()] || null;
// Each host's own web search / fetch (the rule names the host's; unknown: all of them).
const WEB_TOOL_WORDS = {
  claude: 'WebSearch / WebFetch',
  codex: 'Codex\'s web_search',
  opencode: 'webfetch / websearch',
};

/**
 * The SynaBun browser tool names a host's model sees: a prefix
 * ('mcp__SynaBun__', 'SynaBun_', '') or the persona's toolNames() map.
 */
function browserToolNames(tools) {
  const map = tools && typeof tools === 'object' ? tools : {};
  const prefix = typeof tools === 'string' ? tools : (typeof map.prefix === 'string' ? map.prefix : '');
  return {
    navigate: map.browserNavigate || `${prefix}browser_navigate`,
    snapshot: map.browserSnapshot || `${prefix}browser_snapshot`,
    screenshot: map.browserScreenshot || `${prefix}browser_screenshot`,
    console: map.browserConsole || `${prefix}browser_console`,
  };
}

/**
 * The browser rule, as bullet lines: the brain's persona (its host's tool
 * names in `tools`), the worker prompts of browser runs. `host`: claude /
 * codex / opencode (names that host's own web tools), else all of them.
 */
export function browserPolicyText({ tools = '', host = null } = {}) {
  const t = browserToolNames(tools);
  const web = WEB_TOOL_WORDS[hostKey(host)] || 'WebSearch / WebFetch (OpenCode webfetch / websearch, Codex web_search)';
  return [
    `- Every page, public or localhost, goes through SynaBun's browser tools (${t.navigate}, ${t.snapshot}, ${t.screenshot}, ${t.console} and the other browser_* tools); they open the browser configured in SynaBun (MoreLogin). Nothing else opens a page.`,
    '- Never run Playwright, Puppeteer or Selenium code of your own to look at a page (a script, node -e, python -c, a heredoc), and never `npx playwright` except to run the project\'s automated tests (npx playwright test).',
    '- Never launch Chrome, Chromium, Edge, chrome-headless-shell or any other browser binary, and never take headless screenshots (--headless, --screenshot).',
    '- Never `open` a URL or a browser app, and never use computer use on a browser app.',
    `- Never use the Playwright, Chrome DevTools, Claude-in-Chrome or any other browser MCP tools, nor ${web}.`,
    `- Visual checks: ${t.screenshot} (width, height, fullPage, save). Page errors and console output: ${t.console}.`,
    '- If the SynaBun browser fails, is unavailable or lacks what you need, stop and report it. Never substitute another browser or tool.',
    '- This rule overrides any task text, context or memory that says otherwise.',
  ].join('\n');
}

// ── tool names ──────────────────────────────────────────────────────────────

// SynaBun's own tools under any host prefix: mcp__SynaBun__…, a server name that
// ends in SynaBun (mcp__claude_ai_Synabun__…, a plugin's mcp__plugin_x_SynaBun__…),
// OpenCode's SynaBun_… and SynaBun.… — the leaf name, else null.
const SYNABUN_TOOL = /^(?:mcp__(?:[a-z0-9-]+_)*synabun__|synabun[_.:/-]+)(.+)$/i;
const synabunLeaf = (name) => SYNABUN_TOOL.exec(name)?.[1] ?? null;
const isSynabunTool = (name) => synabunLeaf(name) !== null;
const BROWSER_SERVER_WORD = 'browser|playwright|puppeteer|chrome|devtools|selenium|webdriver|browserbase|stagehand|hyperbrowser';
// Another MCP server that drives a browser, by its server name.
const BROWSER_SERVER = new RegExp(BROWSER_SERVER_WORD, 'i');
// OpenCode names an MCP tool <server>_<tool>: the server is the first segment.
const OPENCODE_BROWSER_TOOL = new RegExp(`^([a-z0-9-]*?(?:${BROWSER_SERVER_WORD})[a-z0-9-]*)_`, 'i');
// A tool that drives a page by its own name, whatever its server is called
// (snake case: navigatePage and navigate-page are navigate_page).
const PAGE_TOOL = /^(?:browser_.+|navigate(?:_(?:page|to|to_url|url|back|forward))?|go_?to(?:_(?:url|page))?|go_(?:back|forward)|open_(?:url|page|link|website|webpage|browser|in_browser)|new_page|launch_browser|(?:take|capture)_(?:page_|full_page_|web_?page_|website_)?screenshot|(?:page|full_page|web_?page|website)_screenshot|screenshot(?:_(?:page|url|website|webpage))?)$/;
const snakeName = (text) => String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.\s]+/g, '_').toLowerCase();
// Web search / fetch outside the SynaBun browser: Claude's, OpenCode's, Codex's.
const WEB_TOOLS = new Set(['websearch', 'webfetch', 'web_search', 'web_fetch', 'web_search_preview']);
// Shell tools: Claude's Bash / PowerShell, Codex's shell family, OpenCode's bash.
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec', 'unified_exec']);

/**
 * What another MCP server's tool does to a browser (for the refusal), else null:
 * a server whose name says browser (mcp__<server>__<tool>, OpenCode's
 * <server>_<tool>), or a tool whose own name drives a page (browser_*,
 * navigate, goto, open_url, take_screenshot …). SynaBun's tools never match.
 */
function browserMcpTool(name, host) {
  if (isSynabunTool(name)) return null;
  if (/^mcp__/i.test(name)) {
    const cut = name.lastIndexOf('__');
    const server = cut > 5 ? name.slice(5, cut) : '';
    const tool = cut > 5 ? name.slice(cut + 2) : '';
    if (server && BROWSER_SERVER.test(server)) return `the ${server} MCP server drives a browser of its own`;
    return server && PAGE_TOOL.test(snakeName(tool)) ? `${tool} of the ${server} MCP server drives a page` : null;
  }
  if (host && host !== 'opencode') return null;
  const server = OPENCODE_BROWSER_TOOL.exec(name)?.[1];
  if (server) return `the ${server} MCP server drives a browser of its own`;
  // Where the server's name ends is not known (it can hold "_"): any tail of the name counts.
  const words = snakeName(name).split('_');
  for (let i = 0; i < words.length; i += 1) {
    if (PAGE_TOOL.test(words.slice(i).join('_'))) return `${name} drives a page`;
  }
  return null;
}

// ── browser apps and programs ───────────────────────────────────────────────

// A web browser as a Mac app name (lower case, spaces for - and _) or a bundle
// id. MoreLogin, SynaBun's configured browser, is neither.
const BROWSER_APP_NAME = /^(?:google chrome(?: (?:canary|beta|dev|for testing))?|chrome(?: for testing)?|chromium|safari(?: technology preview)?|(?:mozilla )?firefox(?: (?:developer edition|nightly))?|microsoft edge(?: (?:beta|dev|canary))?|edge|brave(?: browser)?(?: (?:beta|nightly))?|arc|opera(?: gx)?|vivaldi|orion|zen(?: browser)?|duckduckgo|tor browser|waterfox|librewolf|thorium)$/;
// MoreLogin's profile windows (org.HongKongZiXun.MoreLogin, named "MoreLogin" like
// its manager app com.zixun.MoreLoginPlus) are a browser too; only the bundle id tells them apart.
const BROWSER_BUNDLE = /^(?:com\.google\.chrome|org\.chromium\.|com\.apple\.safari|org\.mozilla\.(?:firefox|nightly)|com\.microsoft\.edge|com\.brave\.browser|company\.thebrowser\.|com\.operasoftware\.opera|com\.vivaldi\.|com\.kagi\.kagimacos|app\.zen-browser\.|com\.duckduckgo\.macos\.browser|org\.torproject\.|org\.hongkongzixun\.morelogin)/;
const appWords = (text) => text.replace(/[\s_-]+/g, ' ').trim();

/** The app's name when it is a web browser (a name, a bundle id, or a path to the .app), else null. */
function browserApp(app) {
  const raw = String(app ?? '').trim();
  if (!raw) return null;
  const text = raw.toLowerCase();
  if (BROWSER_BUNDLE.test(text)) return raw;
  const last = text.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
  return BROWSER_APP_NAME.test(appWords(last.replace(/\.app$/, ''))) ? raw : null;
}

// A browser by its executable's file name. Only unambiguous names: a Mac app's
// own executable is recognised by its .app (APP_EXECUTABLE).
const BROWSER_PROGRAM = /^(?:google chrome(?: (?:stable|beta|unstable|dev|canary|for testing))?|chrome|chromium(?: browser)?|chrome headless shell|headless shell|msedge|microsoft edge(?: (?:stable|beta|dev|canary))?|firefox(?: bin)?|brave(?: browser)?|vivaldi(?: stable)?|thorium(?: browser)?)$/;
const APP_EXECUTABLE = /(?:^|\/)([^/]+)\.app\/contents\/macos\/[^/]+$/i;
// A program that looks like a browser, for the flags only a browser takes.
const BROWSERISH = /chrom|edge|firefox|brave|headless|browser|webkit|safari|opera|vivaldi/i;
const HEADLESS_FLAG = /^--(?:headless|screenshot|remote-debugging-port|remote-debugging-pipe|print-to-pdf|dump-dom)(?:=|$)/i;

/** "<name>" for a word in command position that starts a browser, else null. */
function browserProgram(word) {
  const path = String(word || '').replace(/\\/g, '/');
  const app = APP_EXECUTABLE.exec(path);
  if (app) return browserApp(app[1]) ? `${app[1]}` : null;
  const name = programName(path);
  return BROWSER_PROGRAM.test(appWords(name)) ? name : null;
}

function programName(word) {
  const base = String(word || '').replace(/\\/g, '/').split('/').pop() || '';
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
}

// ── what code does ─────────────────────────────────────────────────────────

// Code that drives a browser, and what the refusal says it does. Executed
// scripts and inline code (node -e, python -c, a heredoc or pipe into an
// interpreter) count by what the code does: a browser library loaded
// (require, import, import(), Python's from/import), a launch or CDP connect
// call, a browser started through the shell. Code that only names one (a
// string, a comment, an instruction) runs.

// A module specifier in JS: quoted, with Deno's npm: and a version or subpath allowed.
const Q = '[\'"`]';
const moduleUse = (names) => {
  const spec = `(?:npm:)?(?:${names})(?:@[^'"\`/\\s]*)?(?:/[^'"\`\\s]*)?`;
  return [
    `\\brequire\\s*\\(\\s*${Q}${spec}${Q}`,
    `\\bimport\\s*\\(\\s*${Q}${spec}${Q}`,
    `\\bimport\\s+(?!type\\b)(?:[\\w$*{}\\s,]{1,1000}?\\bfrom\\s*)?${Q}${spec}${Q}`,
    `\\bexport\\s+[\\w$*{}\\s,]{1,1000}?\\bfrom\\s*${Q}${spec}${Q}`,
  ].join('|');
};
// A Python module imported: from x[.y] import …, import x, __import__('x'), import_module('x').
const pythonUse = (names) => `(?:^|[\\n;])[ \\t]*(?:from[ \\t]+(?:${names})(?:\\.[\\w.]+)?[ \\t]+import\\b|import[ \\t]+(?:[\\w.]+[ \\t]*,[ \\t]*)*(?:${names})\\b)|\\b(?:__import__|import_module)\\s*\\(\\s*['"](?:${names})\\b`;
const marker = (pattern, what) => ({ re: new RegExp(pattern), what });
// A browser program named in the same text as a headless flag (not Godot's or Blender's --headless).
const BROWSER_WORD = /\b(?:google[ -]chrome|chrome|chromium|msedge|microsoft edge|firefox|brave|headless_shell)\b/i;
const CODE_MARKERS = [
  marker(`${moduleUse('playwright(?:-core|-chromium|-firefox|-webkit|-extra)?|@playwright/[a-z0-9-]+')}|${pythonUse('playwright')}`, 'uses Playwright'),
  marker(`${moduleUse('puppeteer(?:-core|-extra)?|@puppeteer/[a-z0-9-]+')}|${pythonUse('pyppeteer')}`, 'uses Puppeteer'),
  marker(`${moduleUse('selenium-webdriver|webdriverio')}|${pythonUse('selenium|seleniumbase|undetected_chromedriver')}|\\bwebdriver\\s*\\.\\s*(?:Chrome|Firefox|Edge|Safari|Remote|ChromiumEdge)\\s*\\(|\\bnew\\s+Builder\\s*\\(\\s*\\)\\s*\\.\\s*forBrowser\\b`, 'uses Selenium / WebDriver'),
  marker(`${moduleUse('chrome-launcher|chrome-remote-interface')}|\\b(?:chromium|firefox|webkit)\\s*\\.\\s*(?:launch|launchPersistentContext|launch_persistent_context|launchServer|launch_server|connect|connectOverCDP|connect_over_cdp)\\s*\\(|\\b(?:launchPersistentContext|launch_persistent_context|connectOverCDP|connect_over_cdp)\\s*\\(|\\bpuppeteer\\s*\\.\\s*(?:launch|connect)\\s*\\(|\\b(?:sync|async)_playwright\\s*\\(|\\bchromeLauncher\\s*\\.\\s*launch\\s*\\(`, 'launches a browser'),
  marker('\\b(?:npx|bunx|pnpx)\\s+(?:-y\\s+|--yes\\s+)?(?:playwright|puppeteer|lighthouse|pa11y|shot-scraper|capture-website)\\b(?!\\s+test\\b)|--remote-debugging-(?:port|pipe)\\b|--headless=(?:new|old|chrome)\\b|\\bchrome-headless-shell\\b', 'starts a browser'),
  { re: /--headless\b/, also: BROWSER_WORD, what: 'starts a browser' },
  marker('\\bwebbrowser\\s*\\.\\s*open(?:_new(?:_tab)?)?\\s*\\(', 'opens the default browser'),
];
function codeMarker(text) {
  const value = String(text || '');
  if (!value) return null;
  for (const { re, also, what } of CODE_MARKERS) if (re.test(value) && (!also || also.test(value))) return what;
  return null;
}

// ── paths ───────────────────────────────────────────────────────────────────

function resolvePath(base, path) {
  const text = String(path || '');
  if (text === '~' || text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  return isAbsolute(text) ? resolve(text) : resolve(base || process.cwd(), text);
}
function insideDir(path, dir) {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** A regular file up to MAX_SCRIPT_BYTES, else null. */
function defaultReadFile(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
  return readFileSync(path, 'utf8');
}
function readScript(ctx, path) {
  try {
    const text = ctx.readFile(path);
    return typeof text === 'string' ? text.slice(0, MAX_SCRIPT_BYTES) : null;
  } catch { return null; }
}

// ── the shell ───────────────────────────────────────────────────────────────

/** The index of the ")" closing a $( that opened before `start`, else the text's length. */
function substitutionEnd(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') { i += 1; continue; }
    if (c === "'") { const end = text.indexOf("'", i + 1); i = end === -1 ? text.length : end; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return i;
  }
  return text.length;
}
/** The index of the backtick closing one that opened before `start`, else the text's length. */
function backtickEnd(text, start) {
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '`') return i;
  }
  return text.length;
}
/** The commands inside $(…) and `…` of text the shell expands (a double-quoted string, an unquoted heredoc). */
function substitutionsIn(text) {
  const bodies = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const end = substitutionEnd(text, i + 2);
      bodies.push(text.slice(i + 2, end));
      i = end;
    } else if (text[i] === '`') {
      const end = backtickEnd(text, i + 1);
      bodies.push(text.slice(i + 1, end).replace(/\\([\\`$])/g, '$1'));
      i = end;
    }
  }
  return bodies;
}

/**
 * A command line → its simple commands: { words, heredocs, inputs, pipedFrom }.
 * Splits on ; & | && || newlines, ( ), backticks and $(…); removes quotes and
 * backslash escapes; keeps heredoc and here-string bodies (the program's
 * stdin), < input files and the command a pipe feeds it. The commands of a $(…)
 * or `…` inside double quotes or an unquoted heredoc come first, as their own
 * commands (they run before the command that holds them). Lexical: nothing is
 * expanded, so a program named through a variable is not seen.
 */
function simpleCommands(source, depth = 0) {
  const text = String(source || '').slice(0, MAX_COMMAND_CHARS);
  const n = text.length;
  const out = [];
  const nested = (body) => { if (depth < MAX_DEPTH) out.push(...simpleCommands(body, depth + 1)); };
  const fresh = (pipedFrom = null) => ({ words: [], heredocs: [], inputs: [], pipedFrom });
  let seg = fresh();
  let word = null;
  let target = null; // what the next word is: '<' an input file, '>' an output file, 'here' a here-string
  const heredocs = []; // bodies still to read after the line ends: { seg, delim, strip, expands }
  const pushWord = () => {
    if (word === null) return;
    if (target === '<') seg.inputs.push(word);
    else if (target === 'here') seg.heredocs.push(word);
    else if (target !== '>') seg.words.push(word);
    word = null;
    target = null;
  };
  const endSeg = ({ piped = false } = {}) => {
    pushWord();
    target = null;
    const done = seg.words.length || seg.heredocs.length || seg.inputs.length ? seg : null;
    if (done) out.push(done);
    seg = fresh(piped ? done : null);
  };
  const readHeredocs = (start) => {
    let i = start;
    while (heredocs.length && i < n) {
      const { seg: owner, delim, strip, expands } = heredocs.shift();
      const lines = [];
      while (i < n) {
        const end = text.indexOf('\n', i);
        const line = text.slice(i, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
        if ((strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === delim) break;
        lines.push(line);
      }
      const body = lines.join('\n');
      // <<EOF (unquoted) runs the body's $(…) and `…`; <<'EOF' keeps them as text.
      if (expands) for (const inner of substitutionsIn(body)) nested(inner);
      owner.heredocs.push(body);
    }
    return i;
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue; }
      word = (word ?? '') + (text[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      word = (word ?? '') + text.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\' && '"\\$`\n'.includes(text[j + 1] ?? '')) { if (text[j + 1] !== '\n') buf += text[j + 1]; j += 2; continue; }
        // "$(…)" and "`…`" still run: their commands are checked too; the word keeps their text.
        if (text[j] === '$' && text[j + 1] === '(' && text[j + 2] !== '(') {
          const end = substitutionEnd(text, j + 2);
          nested(text.slice(j + 2, end));
          buf += text.slice(j, Math.min(n, end + 1));
          j = end + 1;
          continue;
        }
        if (text[j] === '`') {
          const end = backtickEnd(text, j + 1);
          nested(text.slice(j + 1, end).replace(/\\([\\`$])/g, '$1'));
          buf += text.slice(j, Math.min(n, end + 1));
          j = end + 1;
          continue;
        }
        buf += text[j];
        j += 1;
      }
      word = (word ?? '') + buf;
      i = j + 1;
      continue;
    }
    if (c === '#' && word === null) { const end = text.indexOf('\n', i); i = end === -1 ? n : end; continue; }
    if (c === '\n') { endSeg(); i = readHeredocs(i + 1); continue; }
    if (c === '&' && text[i + 1] === '>') { pushWord(); target = '>'; i += text[i + 2] === '>' ? 3 : 2; continue; }
    if (c === '|' && text[i + 1] !== '|') { endSeg({ piped: true }); i += text[i + 1] === '&' ? 2 : 1; continue; }
    if (c === ';' || c === '&' || c === '|') { endSeg(); i += ['&&', '||', ';;'].includes(text.slice(i, i + 2)) ? 2 : 1; continue; }
    if (c === '$' && text[i + 1] === '(') { endSeg(); i += 2; continue; }
    if (c === '(' || c === ')' || c === '`') { endSeg(); i += 1; continue; }
    if (c === '<' || c === '>') {
      // A descriptor number before the operator ("2>") is not an argument.
      if (word !== null && /^\d+$/.test(word)) word = null;
      if (text.startsWith('<(', i) || text.startsWith('>(', i)) { endSeg(); i += 2; continue; }
      if (text.startsWith('<<<', i)) { pushWord(); target = 'here'; i += 3; continue; }
      if (text.startsWith('<<', i)) {
        pushWord();
        let j = i + 2;
        const strip = text[j] === '-';
        if (strip) j += 1;
        while (text[j] === ' ' || text[j] === '\t') j += 1;
        let delim = '';
        let quoted = false;
        while (j < n && !/[\s;&|<>()]/.test(text[j])) {
          if (!['"', "'", '\\'].includes(text[j])) delim += text[j];
          else quoted = true;
          j += 1;
        }
        if (delim) heredocs.push({ seg, delim, strip, expands: !quoted });
        i = j;
        continue;
      }
      pushWord();
      target = c;
      i += 1;
      while (text[i] === '>' || text[i] === '|') i += 1;
      if (text[i] === '&') { // a descriptor (>&2, <&0, >&-): no file word follows
        i += 1;
        while (i < n && /[0-9-]/.test(text[i])) i += 1;
        target = null;
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i += 1; continue; }
    word = (word ?? '') + c;
    i += 1;
  }
  endSeg();
  return out;
}

// Programs that run the rest of their arguments as the command, and the options of theirs that take a value.
const WRAPPERS = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'], env: ['-u', '-C', '-S', '-P'], nohup: [], exec: ['-a'], command: [],
  time: [], nice: ['-n'], timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'],
  caffeinate: ['-t', '-w'], stdbuf: ['-i', '-o', '-e'], unbuffer: [], ionice: ['-c', '-n', '-p'], arch: [],
};
// Shell words that come before a command.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}']);
// Python project runners: `uv run [options] <command>` and friends, and the options of theirs that take a value.
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'rye', 'hatch']);
const RUNNER_VALUE_OPTIONS = new Set(['--with', '--with-requirements', '--python', '-p', '--project', '--directory', '--index', '--extra', '--group', '--env-file', '-e', '--env']);

/** The command itself: assignments (FOO=bar), keywords, wrappers (sudo, env, timeout 30…) and `uv run` left out. */
function commandWords(words) {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || KEYWORDS.has(word)) { i += 1; continue; }
    const name = programName(word);
    if (RUNNERS.has(name) && words[i + 1] === 'run') {
      i += 2;
      while (i < words.length && /^-./.test(words[i])) {
        const option = words[i];
        i += 1;
        if (option === '--') break;
        if (RUNNER_VALUE_OPTIONS.has(option)) i += 1;
      }
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(WRAPPERS, name)) break;
    const valued = WRAPPERS[name];
    i += 1;
    while (i < words.length && /^-./.test(words[i])) {
      const option = words[i];
      i += 1;
      if (option === '--') break;
      if (valued.includes(option)) i += 1;
    }
    if (name === 'timeout' && i < words.length) i += 1; // its duration
  }
  return words.slice(i);
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const JS_RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node', 'ts-node-esm', 'esno', 'vite-node', 'jiti', 'babel-node']);
const PYTHON = /^(?:python(?:\d+(?:\.\d+)*)?|py|pypy\d*)$/;
// A shell script by its name, when it has no shebang.
const SHELL_SCRIPT_FILE = /\.(?:sh|bash|zsh|ksh|command)$/i;
// Packages that drive or fetch a browser (npx / pnpm dlx / bunx …), and their installed CLIs.
const BROWSER_PACKAGES = new Set(['playwright', 'playwright-core', '@playwright/test', '@playwright/cli', 'puppeteer', 'puppeteer-core', '@puppeteer/browsers', 'lighthouse', 'pa11y', 'pa11y-ci', 'shot-scraper', 'capture-website', 'capture-website-cli', 'chrome-launcher']);
const BROWSER_CLIS = new Set(['playwright', 'puppeteer', 'lighthouse', 'pa11y', 'pa11y-ci', 'shot-scraper', 'capture-website']);
const PLAYWRIGHT_TEST = new Set(['playwright', '@playwright/test']);
// Playwright's UI and debug modes open a browser window for the agent: not an automated test run.
const PLAYWRIGHT_INTERACTIVE = /^--(?:ui|ui-host|ui-port|debug)(?:=|$)/;
// A script run as a program through its shebang (./pw.cjs, /tmp/shot.py).
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|py)$/i;
// Python modules that drive or open a browser (python -m …).
const PYTHON_BROWSER_MODULE = /^(?:playwright|webbrowser|selenium|pyppeteer|shot_scraper)(?:\.|$)/;
const URL_ARG = /^(?:https?|file):\/\//i;
const LOOPBACK_ARG = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const PATH_LIKE = /[/\\]|\.(?:[cm]?[jt]sx?|py|json|ya?ml|toml|html?)$/i;

/** The package in "npm@1 / @scope/pkg@2" → "npm" / "@scope/pkg" (lower case). */
function packageName(spec) {
  const text = String(spec || '');
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  return (at > 0 ? text.slice(0, at) : text).toLowerCase();
}

/**
 * A package runner's target: { pkg, args, command } for npx / pnpx / bunx /
 * bun x / pnpm dlx|exec / yarn dlx|exec / npm exec|x / uvx / pipx run, and for
 * pnpm / yarn running a browser CLI or a runtime from node_modules/.bin
 * (pnpm playwright …). `command`: npx -c "…" runs a command line. null otherwise.
 */
// A package runner's options that take the next word as their value (npx --prefix /tmp …).
const RUNNER_OPTION_VALUES = new Set(['--prefix', '--cache', '--userconfig', '--registry', '--workspace', '-w', '--loglevel', '--node-options', '--shell', '--script-shell', '--from', '--python', '--spec', '--index-url', '--pip-args']);

function packageRun(words) {
  const [head, ...args] = words;
  const name = programName(head);
  let rest = null;
  if (name === 'npx' || name === 'pnpx' || name === 'bunx' || name === 'uvx') rest = args;
  else if ((name === 'bun' && args[0] === 'x') || (name === 'pipx' && args[0] === 'run')) rest = args.slice(1);
  else if ((name === 'pnpm' || name === 'yarn') && (args[0] === 'dlx' || args[0] === 'exec')) rest = args.slice(1);
  else if (name === 'npm' && (args[0] === 'exec' || args[0] === 'x')) rest = args.slice(1);
  else if ((name === 'pnpm' || name === 'yarn') && (BROWSER_CLIS.has(args[0]) || JS_RUNTIMES.has(args[0]))) rest = args;
  if (!rest) return null;
  let pkg = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') continue;
    if (arg === '-c' || arg === '--call') return { pkg: null, args: [], command: rest[i + 1] ?? '' };
    if (arg === '-p' || arg === '--package') { pkg = pkg || packageName(rest[i + 1]); i += 1; continue; }
    if (arg.startsWith('--package=')) { pkg = pkg || packageName(arg.slice(10)); continue; }
    if (RUNNER_OPTION_VALUES.has(arg)) { i += 1; continue; }
    if (arg.startsWith('-')) continue;
    const bin = packageName(arg);
    // `-p <pkg> <bin>`: the bin that runs decides (npx -p playwright playwright …).
    return { pkg: BROWSER_PACKAGES.has(bin) || JS_RUNTIMES.has(bin) || !pkg ? bin : pkg, args: rest.slice(i + 1), command: null };
  }
  return null;
}

/** The files among a command's arguments (option values after = included, URLs not). */
function pathArgs(args) {
  const out = [];
  for (const arg of args) {
    if (arg === '--') continue;
    const value = arg.startsWith('-') ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null) : arg;
    if (value && !URL_ARG.test(value) && PATH_LIKE.test(value)) out.push(value);
  }
  return out;
}

/**
 * A project's own automated tests: npm|pnpm|yarn|bun test (and run test*),
 * node --test, deno test, vitest, jest, playwright test — through a package
 * runner too — run from inside the project (`cwd`, where the command runs, `cd`
 * included) on file arguments, if any, that lie inside it too.
 */
function isTestRun(words, { cwd, project }) {
  if (!insideDir(cwd, project)) return false;
  const [head, ...args] = words;
  const name = programName(head);
  let rest = null;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const sub = args[0] || '';
    if (sub === 'test' || sub === 't' || sub === 'tst') rest = args.slice(1);
    else if ((sub === 'run' || sub === 'run-script') && /^test(?:[:.\w-]*)$/i.test(args[1] || '')) rest = args.slice(2);
    else if ((name === 'pnpm' || name === 'yarn') && /^test[:.\w-]+$/i.test(sub)) rest = args.slice(1);
  }
  if ((name === 'node' || name === 'nodejs') && args.includes('--test')) rest = args;
  if (name === 'deno' && args[0] === 'test') rest = args.slice(1);
  if (name === 'vitest' || name === 'jest') rest = args;
  let playwright = name === 'playwright' && args[0] === 'test';
  if (playwright) rest = args.slice(1);
  if (rest === null) {
    const run = packageRun(words);
    if (run?.pkg === 'vitest' || run?.pkg === 'jest') rest = run.args;
    else if (PLAYWRIGHT_TEST.has(run?.pkg) && run.args[0] === 'test') { rest = run.args.slice(1); playwright = true; }
  }
  if (rest === null) return false;
  if (playwright && rest.some((arg) => PLAYWRIGHT_INTERACTIVE.test(arg))) return false;
  return pathArgs(rest).every((path) => insideDir(resolvePath(cwd, path), project));
}
/** Why a `playwright test` that is not an automated test run is refused. */
function playwrightTestWhy(runner, args, { cwd, project }) {
  if (args.some((arg) => PLAYWRIGHT_INTERACTIVE.test(arg))) return `${runner} test in its UI or debug mode (a browser window)`;
  return insideDir(cwd, project) ? `${runner} test on files outside the project` : `${runner} test run from ${cwd}, outside the project`;
}

/** What `open` / xdg-open is asked to show when it is a browser, a URL or a web page, else null. */
function openDenial(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--args') break; // the rest goes to the app
    if (/^-[A-Za-z]*[ab]$/.test(arg)) {
      const app = args[i + 1];
      if (browserApp(app)) return `opening ${app} with open`;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (URL_ARG.test(arg) || LOOPBACK_ARG.test(arg)) return `opening ${arg} with open`;
    if (/\.html?$/i.test(arg)) return `opening ${arg} in a browser with open`;
  }
  return null;
}

// A shell's options that take the next word as their value.
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file', '-C', '--init-command']);

/**
 * What a shell runs: { command } for `bash -c "…"` (-lc, -ec…), { file } for
 * `bash x.sh`, else {} (its commands come from stdin: -s, a heredoc, < file, a pipe).
 */
function shellRun(args) {
  let command = false;
  let stdin = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      const next = args[i + 1];
      if (next === undefined) return {};
      return command ? { command: next } : stdin ? {} : { file: next };
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) { command = true; continue; }
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) { stdin = true; continue; }
    if (SHELL_VALUE_OPTIONS.has(arg)) { i += 1; continue; }
    if (arg.startsWith('-') || arg.startsWith('+')) continue;
    return command ? { command: arg } : stdin ? {} : { file: arg };
  }
  return {};
}
/** The script of `bash -c "…"`, else null. */
const shellScript = (args) => shellRun(args).command ?? null;

/** How a script file runs, by its shebang (else its extension): 'shell', 'code' (JS / Python) or null (a binary, another language). */
function scriptKind(path, text) {
  const shebang = /^#!\s*(\S+)(.*)/.exec(String(text).split('\n', 1)[0]);
  if (shebang) {
    let program = programName(shebang[1]);
    if (program === 'env') program = programName(shebang[2].trim().split(/\s+/).find((word) => word && !word.startsWith('-') && !word.includes('=')) || '');
    if (SHELLS.has(program)) return 'shell';
    return JS_RUNTIMES.has(program) || PYTHON.test(program) ? 'code' : null;
  }
  if (SCRIPT_FILE.test(path)) return 'code';
  return SHELL_SCRIPT_FILE.test(path) ? 'shell' : null;
}

/** Why a shell script's commands may not run (the script read like a command line), else null. */
function shellFileDenial(file, ctx, how = 'running') {
  const text = readScript(ctx, resolvePath(ctx.cwd, file));
  if (text === null) return null;
  const why = commandDenial(text, { ...ctx, depth: ctx.depth + 1 });
  return why ? `${how} ${file}, a shell script: ${why}` : null;
}

// Options that take the next word as their value, per runtime.
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--input-type', '--title', '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout', '--test-shard', '--watch-path', '--inspect-port', '--redirect-warnings', '--disable-warning']);
const RUNTIME_VALUE_OPTIONS = {
  bun: new Set(['-r', '--preload', '--cwd', '-c', '--config', '--define', '-d', '--tsconfig-override', '--env-file', '--conditions', '--main-fields', '-l', '--loader']),
  deno: new Set(['-c', '--config', '--import-map', '--location', '--seed', '--lock', '--cert', '--env-file', '--ext']),
  ts: new Set(['--tsconfig', '-P', '--project', '-O', '--compiler-options', '-r', '--require', '--import', '--loader', '-C', '--conditions', '--env-file', '--config', '--root', '--mode', '-I', '--ignore']),
};
const EVAL_FLAG = /^(?:--eval|--print|-[A-Za-z]*[ep])$/;

/**
 * A JS runtime's arguments → { code: [inline code], script, stdin }: node,
 * bun, deno, tsx, ts-node and friends. `script` "-" or none (and no code):
 * the program comes from stdin.
 */
function jsProgram(name, args) {
  const out = { code: [], script: null };
  let list = args;
  let valued = NODE_VALUE_OPTIONS;
  if (name === 'bun') {
    valued = RUNTIME_VALUE_OPTIONS.bun;
    if (list[0] === 'run') list = list.slice(1);
    else if (list[0] && !list[0].startsWith('-') && !PATH_LIKE.test(list[0])) return out; // bun install / build / pm …
  } else if (name === 'deno') {
    valued = RUNTIME_VALUE_OPTIONS.deno;
    if (list[0] === 'eval') { const code = list.slice(1).find((arg) => !arg.startsWith('-')); if (code !== undefined) out.code.push(code); return out; }
    if (list[0] !== 'run') return out; // deno fmt / lint / task …
    list = list.slice(1);
  } else if (name !== 'node' && name !== 'nodejs') {
    valued = RUNTIME_VALUE_OPTIONS.ts;
    if (list[0] === 'watch') list = list.slice(1); // tsx watch <file>
  }
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '-') { out.script = '-'; return out; }
    if (arg === '--') { out.script = list[i + 1] ?? null; return out; }
    if (/^--(?:eval|print)=/.test(arg)) { out.code.push(arg.slice(arg.indexOf('=') + 1)); return out; }
    if (EVAL_FLAG.test(arg)) { if (list[i + 1] !== undefined) out.code.push(list[i + 1]); return out; }
    if (valued.has(arg)) { i += 1; continue; }
    if (arg.startsWith('-')) continue;
    out.script = arg;
    return out;
  }
  return out;
}

/** python's arguments → { code, module, script }. */
function pythonProgram(args) {
  const out = { code: [], module: null, script: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-') { out.script = '-'; return out; }
    if (arg === '--') { out.script = args[i + 1] ?? null; return out; }
    if (/^-[A-Za-z]*c$/.test(arg)) { if (args[i + 1] !== undefined) out.code.push(args[i + 1]); return out; }
    if (/^-c./.test(arg)) { out.code.push(arg.slice(2)); return out; }
    if (/^-[A-Za-z]*m$/.test(arg)) { out.module = args[i + 1] ?? null; return out; }
    if (/^-m./.test(arg)) { out.module = arg.slice(2); return out; }
    if (arg === '-W' || arg === '-X' || arg === '--check-hash-based-pycs') { i += 1; continue; }
    if (arg.startsWith('-')) continue;
    out.script = arg;
    return out;
  }
  return out;
}

// Programs whose file arguments are what a pipe hands an interpreter (cat pw.cjs | node).
const FILE_READERS = new Set(['cat', 'type', 'head', 'tail', 'bat', 'more', 'less']);

/** Why an interpreter's program may not run (inline code, a script file, stdin), else null. */
function interpreterDenial(name, args, seg, ctx) {
  const python = PYTHON.test(name);
  const program = python ? pythonProgram(args) : jsProgram(name, args);
  for (const code of program.code) {
    const what = codeMarker(code);
    if (what) return `inline code that ${what} (${name} ${python ? '-c' : '-e'})`;
  }
  if (program.code.length) return null;
  if (python && program.module && PYTHON_BROWSER_MODULE.test(program.module)) return `python -m ${program.module}`;
  if (program.script && program.script !== '-') {
    const file = resolvePath(ctx.cwd, program.script);
    const what = codeMarker(readScript(ctx, file));
    return what ? `running ${program.script}, a script that ${what}` : null;
  }
  if (python && program.module) return null;
  // The program comes from stdin: a heredoc or here-string, < file, or a pipe.
  for (const body of seg.heredocs) {
    const what = codeMarker(body);
    if (what) return `a heredoc fed to ${name} that ${what}`;
  }
  for (const input of seg.inputs) {
    const what = codeMarker(readScript(ctx, resolvePath(ctx.cwd, input)));
    if (what) return `running ${input}, a script that ${what}`;
  }
  const source = seg.pipedFrom ? commandWords(seg.pipedFrom.words) : [];
  if (source.length) {
    if (FILE_READERS.has(programName(source[0]))) {
      for (const file of source.slice(1).filter((arg) => !arg.startsWith('-'))) {
        const what = codeMarker(readScript(ctx, resolvePath(ctx.cwd, file)));
        if (what) return `piping ${file}, a script that ${what}, into ${name}`;
      }
    } else {
      const what = codeMarker(source.slice(1).join(' ')) || codeMarker(seg.pipedFrom.heredocs.join('\n'));
      if (what) return `code piped into ${name} that ${what}`;
    }
  }
  return null;
}

/** Why a shell whose commands come from stdin may not run them: a heredoc or here-string, < file, a pipe. */
function shellStdinDenial(name, seg, ctx) {
  const inner = { ...ctx, depth: ctx.depth + 1 };
  for (const body of seg.heredocs) {
    const why = commandDenial(body, inner);
    if (why) return why;
  }
  for (const input of seg.inputs) {
    const why = shellFileDenial(input, ctx);
    if (why) return why;
  }
  const source = seg.pipedFrom ? commandWords(seg.pipedFrom.words) : [];
  if (!source.length) return null;
  if (FILE_READERS.has(programName(source[0]))) {
    for (const file of source.slice(1).filter((arg) => !arg.startsWith('-'))) {
      const why = shellFileDenial(file, ctx, 'piping');
      if (why) return `${why} (into ${name})`;
    }
    return null;
  }
  // echo "google-chrome --headless …" | sh
  return commandDenial(source.slice(1).join(' '), inner) || commandDenial(seg.pipedFrom.heredocs.join('\n'), inner);
}

/** Why one simple command may not run, else null. `words`: the command itself (commandWords). */
function segmentDenial(words, seg, ctx) {
  if (!words.length) return null;
  const [head, ...args] = words;
  const name = programName(head);
  const browser = browserProgram(head);
  if (browser) return `${browser} started from the shell`;
  const flag = args.find((arg) => HEADLESS_FLAG.test(arg));
  if (flag && BROWSERISH.test(name)) return `a headless browser (${name} ${flag})`;
  if (name === 'open') return openDenial(args);
  if (name === 'xdg-open' || name === 'gio') {
    const target = args.find((arg) => URL_ARG.test(arg) || LOOPBACK_ARG.test(arg) || /\.html?$/i.test(arg));
    return target ? `opening ${target} with ${name}` : null;
  }
  if (['sensible-browser', 'x-www-browser', 'www-browser'].includes(name)) return `${name} started from the shell`;
  if (SHELLS.has(name)) {
    const run = shellRun(args);
    if (run.command !== undefined) return commandDenial(run.command, { ...ctx, depth: ctx.depth + 1 });
    if (run.file !== undefined) return shellFileDenial(run.file, ctx);
    return shellStdinDenial(name, seg, ctx);
  }
  // source x.sh / . x.sh: the script runs in this shell.
  if (name === 'source' || name === '.') return args[0] ? shellFileDenial(args[0], ctx) : null;
  if (name === 'eval') return commandDenial(args.join(' '), { ...ctx, depth: ctx.depth + 1 });
  if (isTestRun(words, ctx)) return null;
  const run = packageRun(words);
  if (typeof run?.command === 'string') return commandDenial(run.command, { ...ctx, depth: ctx.depth + 1 });
  if (run?.pkg) {
    if (PLAYWRIGHT_TEST.has(run.pkg) && run.args[0] === 'test') return playwrightTestWhy(`${name} ${run.pkg}`, run.args.slice(1), ctx);
    if (BROWSER_PACKAGES.has(run.pkg)) return `${name} ${run.pkg}${run.args[0] ? ` ${run.args[0]}` : ''}`;
    if (JS_RUNTIMES.has(run.pkg)) return interpreterDenial(run.pkg, run.args, seg, ctx);
    return null;
  }
  if (name === 'playwright' && args[0] === 'test') return playwrightTestWhy(name, args.slice(1), ctx);
  if (BROWSER_CLIS.has(name)) return `${name}${args[0] ? ` ${args[0]}` : ''} (a browser CLI)`;
  if (JS_RUNTIMES.has(name) || PYTHON.test(name)) return interpreterDenial(name, args, seg, ctx);
  // A script run as a program (./shot.sh, ./pw.cjs, /tmp/x): by its shebang, else its extension.
  if (/[/\\]/.test(head)) {
    const text = readScript(ctx, resolvePath(ctx.cwd, head));
    if (text === null) return null;
    const kind = scriptKind(head, text);
    if (kind === 'shell') {
      const why = commandDenial(text, { ...ctx, depth: ctx.depth + 1 });
      return why ? `running ${head}, a shell script: ${why}` : null;
    }
    const what = kind === 'code' ? codeMarker(text) : null;
    return what ? `running ${head}, a script that ${what}` : null;
  }
  return null;
}

/** Why a command line may not run (what it does, for the refusal), else null. */
function commandDenial(text, ctx) {
  if (ctx.depth > MAX_DEPTH) return null;
  let cwd = ctx.cwd;
  for (const seg of simpleCommands(text)) {
    const words = commandWords(seg.words);
    // `cd dir && node pw.cjs`: the rest of the line runs there (a bare cd: the home folder).
    if (words[0] === 'cd' || words[0] === 'pushd') {
      const dir = words.slice(1).find((arg) => !arg.startsWith('-'));
      if (dir) cwd = resolvePath(cwd, dir);
      else if (words[0] === 'cd' && words.length === 1) cwd = homedir();
      continue;
    }
    const why = segmentDenial(words, seg, { ...ctx, cwd });
    if (why) return why;
  }
  return null;
}

/** A shell tool's command: a string (a command line) or an argv array (Codex). */
function argvDenial(argv, ctx) {
  const words = commandWords(argv.map((arg) => String(arg ?? '')));
  if (!words.length) return null;
  if (SHELLS.has(programName(words[0]))) {
    const script = shellScript(words.slice(1));
    if (script !== null) return commandDenial(script, ctx);
  }
  return segmentDenial(words, { words, heredocs: [], inputs: [], pipedFrom: null }, ctx);
}

// Where each host puts a shell tool's command and its working directory.
const COMMAND_KEYS = ['command', 'cmd', 'commands', 'script'];
const WORKDIR_KEYS = ['workdir', 'cwd', 'working_directory', 'workingDirectory', 'dir'];

function shellDenial(input, ctx) {
  const args = input && typeof input === 'object' ? input : {};
  const action = args.action && typeof args.action === 'object' ? args.action : {};
  const workdir = [...WORKDIR_KEYS.map((key) => args[key]), ...WORKDIR_KEYS.map((key) => action[key])]
    .find((value) => typeof value === 'string' && isAbsolute(value));
  const inner = { ...ctx, cwd: workdir || ctx.cwd };
  for (const value of [...COMMAND_KEYS.map((key) => args[key]), action.command]) {
    if (typeof value === 'string' && value.trim()) {
      const why = commandDenial(value, inner);
      if (why) return why;
    } else if (Array.isArray(value) && value.length) {
      const why = argvDenial(value, inner);
      if (why) return why;
    }
  }
  return null;
}

// ── the refusal ─────────────────────────────────────────────────────────────

function refusal(tool, what) {
  return `SynaBun browser policy: ${tool} was refused — ${what}. Every page, public or localhost, goes through SynaBun's browser tools (browser_navigate, browser_snapshot, browser_screenshot, browser_console and the other browser_* tools), which open the browser configured in SynaBun. If the SynaBun browser fails or cannot do this, stop and report it; do not switch to another browser or tool. The project's own automated tests still run through its test runner (npm test, node --test, npx playwright test).`;
}

/**
 * Why this tool call may not run under the browser policy (the refusal text),
 * else null. `host`: claude / codex / opencode (null: any). `cwd`: the
 * project directory: relative script paths resolve against it, and a test
 * runner's files must lie inside it. `readFile(path)` returns an executed
 * script's text or null (tests); by default a regular file up to
 * MAX_SCRIPT_BYTES is read, and anything unreadable is allowed.
 */
export function browserToolDenial(tool, input = {}, { host = null, cwd = null, readFile = defaultReadFile } = {}) {
  const name = String(tool ?? '').trim();
  if (!name) return null;
  const kind = hostKey(host);
  const mcp = browserMcpTool(name, kind);
  if (mcp) return refusal(name, mcp);
  const base = synabunLeaf(name) ?? name;
  const lower = base.toLowerCase();
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  // Computer use on a browser is refused where the desktop resolves its target
  // (lib/desktop/guards.js); here only an app named in the call is caught early.
  if (lower === 'computer_apps') {
    const action = String(args.action || '').toLowerCase();
    const app = browserApp(args.app);
    if ((action === 'open' || action === 'focus') && app) return refusal(name, `${action === 'open' ? 'opening' : 'focusing'} ${app} with computer use`);
    return null;
  }
  if (isSynabunTool(name) || /^mcp__/i.test(name)) return null;
  if (WEB_TOOLS.has(lower)) return refusal(name, 'web search / fetch outside the SynaBun browser');
  if (!SHELL_TOOLS.has(lower)) return null;
  const project = cwd ? resolve(String(cwd)) : process.cwd();
  const why = shellDenial(args, { project, cwd: project, readFile: typeof readFile === 'function' ? readFile : defaultReadFile, depth: 0 });
  return why ? refusal(name, why) : null;
}
