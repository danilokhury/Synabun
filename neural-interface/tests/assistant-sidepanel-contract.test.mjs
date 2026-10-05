import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Source-level contract for the Assistant's two hosts: the terminal tab and the
// sidepanel mount ONE component (asst-panel.js), so features cannot diverge.
// Shared rules live in ui-assistant.js / assistant/asst-hosts.js; each host
// only supplies an adapter and window chrome.
const root = resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const shared = (name) => read(`public/shared/${name}`);

const panel = shared('assistant/asst-panel.js');
const hostsCore = shared('assistant/asst-hosts.js');
const wiring = shared('ui-assistant.js');
const sidepanel = shared('assistant/asst-sidepanel.js');
const sidepanelStyles = shared('assistant/asst-sidepanel-styles.js');
const componentStyles = shared('assistant/asst-styles.js');
const terminal = shared('ui-terminal.js');
const navbar = shared('ui-navbar.js');
const windows = shared('ui-sidepanel-windows.js');
const notifications = shared('ui-notifications.js');
const keybinds = shared('ui-keybinds.js');
const fileExplorer = shared('ui-file-explorer.js');
const tooltip = shared('ui-tooltip.js');
const htmlShell = shared('html-shell.js');
const stylesCss = shared('styles.css');
const constants = shared('constants.js');
const stateJs = shared('state.js');
const en = read('i18n/en.json');

test('the shared usage host follows both terminal and sidepanel geometry', () => {
  assert.match(panel, /createUsageGauge\(root\.querySelector\('\.asst-usage-host'\), \{ t, sessionId \}\)/);
  assert.match(componentStyles, /\.asst-usage-popover\s*\{[^}]*inset-inline: 4px;[^}]*max-height: min\(72dvh, 780px\)/s);
  assert.match(sidepanelStyles, /\.assistant-panel \.asst-usage-host \{ min-width: 0; \}/);
  assert.ok(JSON.parse(en).assistant.usage.updatesPaused);
});

/** A selector list split on its top-level commas (not the ones inside :is() / :has()). */
function splitSelectorList(list) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The option keys of every `mountAssistant(viewport, { … })` call in a file. */
function mountOptionKeys(source) {
  const calls = [...source.matchAll(/mountAssistant\(viewport, \{([^}]*)\}\)/g)];
  return calls.map(m => m[1].split(',').map(part => part.split(':')[0].trim()).filter(Boolean).sort());
}

test('both hosts mount the same component with the same options (no feature switches)', () => {
  const [terminalKeys] = mountOptionKeys(terminal);
  const [sidepanelKeys] = mountOptionKeys(sidepanel);
  assert.ok(terminalKeys, 'terminal mounts the component');
  assert.ok(sidepanelKeys, 'sidepanel mounts the component');
  assert.deepEqual(terminalKeys, ['brain', 'host', 'label', 'reattach', 'session', 'sessionId']);
  assert.deepEqual(sidepanelKeys, ['brain', 'host', 'session', 'sessionId']);
  // label / reattach are ignored by mountAssistant (legacy terminal args) — anything
  // else would be a host-specific switch.
  assert.match(panel, /export function mountAssistant\(viewport, \{ sessionId, brain, host = \{\}, session = null \} = \{\}\) \{/,
    'the component accepts sessionId, brain, host and session — no layout/feature options');
});

test('the component never branches on which host it is in', () => {
  assert.match(panel, /const hostId = host\.id \|\| null;/);
  assert.doesNotMatch(panel, /host\.id\s*[!=]==?|hostId\s*[!=]==?|notifySource\s*[!=]==?/);
  const hostIdUses = [...panel.matchAll(/\bhostId\b/g)].length;
  const routingUses = [
    ...panel.matchAll(/emit\('assistant:(?:new|resume|focused)', \{[^}]*host: hostId[^}]*\}\)/g),
  ].length;
  assert.equal(hostIdUses, routingUses + 1, 'hostId only rides on assistant:new / resume / focused');
  assert.match(panel, /emit\('assistant:new', \{ brain: b, host: hostId \}\)/);
  assert.equal((panel.match(/emit\('assistant:resume', \{ sessionId: [^,]+, host: hostId \}\)/g) || []).length, 2);
  assert.match(panel, /notify\(host\.notifySource \|\| 'cli', type, notifyLabel\(\), \{ sessionId, provider: 'assistant', panel: 'assistant' \}\)/);
  assert.doesNotMatch(panel, /notify\('cli'/, 'every notification goes through notifyUser()');
  assert.equal((panel.match(/notifyUser\(NOTIF_TYPE\.(DONE|ASK|ERROR)\)/g) || []).length, 3);
});

test('Esc: the component aborts from its root after cards and menus had their turn', () => {
  assert.match(panel, /if \(e\.key !== 'Escape' \|\| e\.defaultPrevented \|\| destroyed \|\| !st\.running\) return;/);
  assert.match(panel, /surfaces\.forEach\(\(node\) => node\.addEventListener\('keydown', onRootKey\)\)/);
  assert.match(panel, /node\.removeEventListener\('keydown', onRootKey\)/);
  assert.match(terminal, /if \(session\.viewport\?\.contains\(target\)\) return;/, 'the terminal leaves Esc inside the assistant to the component');
  assert.match(keybinds, /closest\('\.term-viewport, \.asst-root, \.asst-bar'\)/, 'single-letter keybinds stay out of the assistant in both hosts (and its toolbar in the sidepanel header)');
  assert.match(panel, /const surfaces = root\.contains\(barEl\) \? \[root\] : \[root, barEl\];/, 'a toolbar placed in a header still aborts on Esc');
});

test('one header row in the sidepanel: the toolbar is placed, not rebuilt', () => {
  // Placement only: the host hands over a slot; the same bar element and wiring move there.
  assert.match(panel, /if \(host\.toolbarSlot\) host\.toolbarSlot\.appendChild\(barEl\);/);
  assert.ok(panel.indexOf('host.toolbarSlot.appendChild(barEl)') > panel.indexOf("const moreBtn = root.querySelector('.asst-act-more');"), 'bar elements are looked up before the bar leaves the root');
  assert.match(panel, /barEl\.remove\(\); \/\/ it may live in the host's header/);
  assert.match(sidepanel, /toolbarSlot: toolbar,/);
  assert.doesNotMatch(terminal, /toolbarSlot/, 'the terminal keeps the bar at the top of the root');
  assert.match(sidepanel, /<div class="asp-bar-slot"><\/div>\s*<div class="asp-actions">/);
  assert.match(sidepanel, /tab\.toolbar\.classList\.toggle\('active', idx === _activeIdx\)/);
  assert.match(sidepanel, /tab\.toolbar\.remove\(\);/);
  assert.match(sidepanel, /tr\('assistant\.panel\.renameEllipsis', 'Rename…'\)/, 'rename stays reachable when ✎ hides');
  // The toolbar card is gone; the header slot is its own container.
  assert.doesNotMatch(sidepanelStyles, /\.assistant-panel \.asst-bar \{|--asst-bar:/);
  assert.match(sidepanelStyles, /container: asp-bar \/ inline-size;/);
  assert.match(sidepanelStyles, /container: asp-head \/ inline-size;/);
  assert.match(componentStyles, /:is\(\.asst-root, \.asst-bar, \.asst-dd-menu, \.asst-modal-overlay, \.asst-lightbox\) \[hidden\]/);
  // Permission mode joined model and effort in the composer (both hosts).
  const picker = shared('assistant/asst-brain-picker.js');
  assert.match(picker, /const FIELDS = \['model', 'effort', 'variant', 'mode', 'account', 'project', 'mcp'\];/);
  assert.match(picker, /mode: 'brain'/);
});

test('shared wiring lives in ui-assistant.js, never in a host', () => {
  for (const event of ['assistant:open', 'assistant:new', 'assistant:resume', 'assistant:toggle', 'assistant:show', 'assistant:focused', 'sync:assistant:session-ended']) {
    assert.ok(wiring.includes(`on('${event}'`), `ui-assistant.js handles ${event}`);
    assert.ok(!terminal.includes(`on('${event}'`), `ui-terminal.js does not handle ${event}`);
    assert.ok(!sidepanel.includes(`on('${event}'`), `asst-sidepanel.js does not handle ${event}`);
  }
  assert.match(wiring, /registerAction\('launch-assistant'/);
  assert.match(wiring, /registerAction\('toggle-assistant'/);
  assert.doesNotMatch(terminal, /registerAction\('(launch|toggle)-assistant'/);
  assert.match(wiring, /defaultHost: 'terminal'/, 'Apps → Assistant / a / Ctrl+A open a terminal tab when none is open');
  assert.doesNotMatch(wiring, /from '\.\/(ui-terminal|ui-navbar|ui-sidepanel-[a-z-]+|ui-assistant-panel)\.js'/, 'hosts register themselves');
  assert.doesNotMatch(wiring, /from '[^']*asst-sidepanel/);
  assert.doesNotMatch(hostsCore, /document|window\.|from '\.\.\//, 'the core stays DOM-free');
});

test('terminal host: adapter registered before the first await; server create/resume moved to the core', () => {
  const init = terminal.slice(terminal.indexOf('export async function initTerminal()'));
  const register = init.indexOf('registerAssistantHost(_terminalAssistantHost)');
  assert.ok(register > 0, 'terminal adapter registered');
  assert.ok(register < init.indexOf('await '), 'before the first await');
  assert.match(terminal, /id: 'terminal',\s+\/\/ New\/History/);
  assert.match(terminal, /notifySource: 'cli',/);
  assert.match(terminal, /openAssistant\(\{ host: 'terminal' \}\)/, "the '+' flyout opens in the terminal");
  assert.match(terminal, /function _assistantOwnedElsewhere\(sessionId\)/, 'reconnect skips a session the sidepanel holds');
  assert.doesNotMatch(terminal, /createAssistantSession|openOrFocusAssistant|export function toggleAssistant|_storedAssistantBrain|ASSISTANT_CLOSED_STATUSES/);
});

test('sidepanel host: a registered sidepanel with the shared window manager', () => {
  assert.match(sidepanel, /const PANEL_OWNER = 'assistant-sidepanel';/);
  assert.match(sidepanel, /const HOST_ID = 'sidepanel';/);
  assert.match(sidepanel, /registerSidepanel\(\{[\s\S]*?owner: PANEL_OWNER,[\s\S]*?provider: 'assistant',[\s\S]*?applyVisibility,/);
  assert.match(sidepanel, /notifySource: 'panel'/);
  assert.ok(sidepanel.indexOf('_tabs.push(tab);') < sidepanel.indexOf('mountAssistant(viewport'), 'the tab record exists before the hooks fire');
  assert.match(sidepanel, /setSidepanelVisible\(PANEL_OWNER, visible\)/);
  assert.match(sidepanel, /syncSidepanelLayout\(PANEL_OWNER\)/);
  assert.match(sidepanel, /emit\('assistant-panel:visibility', _visible\)/);
  assert.match(sidepanel, /registerAssistantHost\(_adapter\)/);
  assert.match(sidepanel, /state\.lastActivePanel !== 'assistant'/, 'whiteboard images only when the Assistant was focused last');
  assert.match(windows, /assistant: 'SynaBun Assistant'/);
  assert.match(windows, /\.ocpv2-resize-handle,\.asp-resize-handle\)/);
  assert.match(windows, /\.ocpv2-header,\.asp-header\)/);
});

test('entry points: top-right button, navbar sync, notifications, file paths, tooltips', () => {
  assert.ok(htmlShell.indexOf('id="topright-assistant-panel-btn"') > 0);
  assert.ok(htmlShell.indexOf('id="topright-assistant-panel-btn"') < htmlShell.indexOf('id="topright-claude-panel-btn"'), 'first of the agent buttons');
  assert.match(htmlShell, /data-tooltip="\$\{t\('assistant\.panel\.open'\)\}"/);
  for (const selector of ['#topright-assistant-panel-btn svg,', '#topright-assistant-panel-btn,', '#topright-assistant-panel-btn:hover,']) {
    assert.ok(stylesCss.includes(selector), selector);
  }
  assert.match(navbar, /import \{ toggleAssistantPanel, isAssistantPanelOpen, initAssistantPanel \} from '\.\/ui-assistant-panel\.js';/);
  assert.ok(navbar.indexOf('initAssistant();') < navbar.indexOf('initAssistantPanel();'), 'shared wiring before the host');
  assert.match(navbar, /assistant: \{\s+isOpen: isAssistantPanelOpen,\s+toggle: toggleAssistantPanel,/);
  assert.match(navbar, /on\('assistant-panel:visibility', \(\) => syncAgentPanelButtons\(\)\)/);
  assert.match(notifications, /provider === 'assistant'\s+\? 'assistant:show'/);
  assert.match(notifications, /assistant: 'assistant-panel:show'/);
  assert.match(fileExplorer, /if \(target === 'assistant'\) \{ emit\('assistant:attach-path', \{ path: filePath \}\); return; \}/);
  assert.doesNotMatch(fileExplorer, /ui-assistant-panel|asst-sidepanel/, 'no static import (it would close a cycle)');
  assert.match(tooltip, /\.ocp-panel, \.assistant-panel, \.menubar-dropdown--resume/);
  assert.match(constants, /ASSISTANT_PANEL_TABS:\s+'synabun-assistant-panel-tabs'/);
  assert.match(constants, /'toggle-assistant-panel': \{ label: 'Toggle Assistant Sidepanel'/);
  assert.match(stateJs, /'claude' \| 'codex' \| 'opencode' \| 'assistant'/);
});

test('gold on glass is scoped to the sidepanel; the terminal keeps its look', () => {
  assert.ok(sidepanelStyles.indexOf('injectAssistantStyles();') < sidepanelStyles.indexOf("document.getElementById('assistant-sidepanel-styles')"), 'component sheet first');
  assert.match(sidepanelStyles, /backdrop-filter: blur\(28px\) saturate\(1\.5\)/);
  assert.doesNotMatch(componentStyles, /backdrop-filter/, 'no glass in the component sheet');
  const css = sidepanelStyles
    .slice(sidepanelStyles.indexOf('style.textContent = `') + 'style.textContent = `'.length, sidepanelStyles.lastIndexOf('`;'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\$\{[^}]*\}/g, 'url(x)');
  // Every rule is scoped: the panel, its asp-* chrome, its pills, or the global motion/resizing switches.
  const selectors = [...css.matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{/g)].map(m => m[1].trim()).filter(s => !/^(from|to|\d+%)/.test(s));
  for (const selector of selectors) {
    for (const part of splitSelectorList(selector)) {
      assert.match(part, /^(\.assistant-panel|\.asp-|html(\.sp-resizing)? \.assistant-panel|body\.ui-interacting \.(asp-|assistant-panel))/, `scoped: ${part}`);
    }
  }
  assert.doesNotMatch(css, /#FFD23C|255,\s*21[05],\s*(0|60)|rgba\(255,\s*195/i, 'gold comes from --asst-brand only');
  assert.match(css, /--asp-gold: var\(--asst-brand\);/);
  // The focused composer: one static 1px gold ring. No spinning conic, no glow.
  assert.match(css, /\.assistant-panel \.asst-bottom:has\(\.asst-input:focus\) \{\s*box-shadow: var\(--asp-card-shadow\), 0 0 0 1px var\(--asp-gold-strong\);\s*\}/);
  assert.doesNotMatch(css, /conic-gradient|asp-border-spin|@property/);
  // The warm wash stays, eased over more stops and dithered.
  assert.match(sidepanelStyles, /radial-gradient\(120% 55% at 0% 0%,\s*var\(--asp-gold-faint\) 0%,[\s\S]*?transparent 66%\)/);
  assert.match(sidepanelStyles, /feTurbulence/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('sidepanel chrome is rounded rectangles and the tray pill is the shared tray pill: one hover, a real button, a 24px close, still under reduced motion', () => {
  // The corner scale is restated on the glass frame with the heights (a quarter of each height).
  const frame = sidepanelStyles.match(/\n\s*\.assistant-panel \{([^}]*)\}/)[1];
  assert.match(frame, /--asst-pill-h-md: 28px;\s*--asst-pill-r-xs: 5px;\s*--asst-pill-r-sm: 6px;\s*--asst-pill-r-md: 8px;/);
  // Window buttons: bare sm squares with the row's 6px corners, one hover for all (no per-button hue, no grow), 28px to hit.
  const btn = sidepanelStyles.match(/\n\s*\.asp-btn \{([^}]*)\}/)[1];
  assert.match(btn, /width: var\(--asst-pill-h-sm\);\s*height: var\(--asst-pill-h-sm\);/);
  assert.match(btn, /border-radius: var\(--asst-pill-r-sm\);/);
  assert.doesNotMatch(sidepanelStyles, /border-radius: 999px/);
  assert.doesNotMatch(sidepanelStyles, /\.asp-btn\.[\w-]+:hover/, 'one hover for every window button');
  assert.doesNotMatch(sidepanelStyles, /scale\(1\.05\)/);
  assert.match(sidepanelStyles, /\.asp-btn::after \{ content: ''; position: absolute; inset: -3px;/);
  // The tab chip is a label (sans); its count a value (mono).
  const chip = sidepanelStyles.match(/\n\s*\.asp-tabs-btn \{([^}]*)\}/)[1];
  assert.match(chip, /height: var\(--asst-pill-h-sm\);/);
  assert.match(chip, /border-radius: var\(--asst-pill-r-sm\);/);
  assert.doesNotMatch(chip, /JetBrains|monospace/);
  assert.match(sidepanelStyles, /\.asp-tabs-count \{[^}]*font-family: var\(--asst-mono\);/);
  // The status: a 6px dot at rest, the cameo while working, never a pulse.
  assert.match(sidepanel, /<span class="asp-status" data-status="idle" role="img" aria-label="\$\{esc\(statusLabel\('idle'\)\)\}">\$\{CAMEO\}<\/span>/);
  assert.match(sidepanelStyles, /\.asp-status::before \{ content: ''; width: 6px; height: 6px;/);
  assert.match(sidepanelStyles, /\.asp-status\[data-status="working"\] \.syna-cameo \{ display: inline-flex; \}/);
  // The tray pill: a button (Enter/Space), the cameo instead of the conic spinner.
  assert.match(sidepanel, /pill\.className = 'term-minimized-pill asp-session-pill';/);
  assert.match(sidepanel, /pill\.setAttribute\('role', 'button'\);\s*pill\.tabIndex = 0;/);
  assert.match(sidepanel, /e\.key !== 'Enter' && e\.key !== ' '/);
  assert.match(sidepanel, /term-minimized-pill-icon" aria-hidden="true">\$\{ICON_MARK\}\$\{CAMEO\}/);
  // ...drawn by the shared .term-minimized-pill alone, like every provider's: no box, font or ✕ placement of its own.
  // Its rules only pick the icon (the mark, the cameo while working) and tint the hairline and the icon for a state.
  const trayRules = [...sidepanelStyles.matchAll(/\n\s*([^{}\n]*\.asp-session-pill[^{}\n]*)\{([^}]*)\}/g)].filter(m => !/^body\.ui-interacting/.test(m[1].trim()));
  assert.ok(trayRules.length >= 5, 'the tray pill rules');
  for (const [, selector, body] of trayRules) {
    assert.doesNotMatch(body, /\b(?:height|width|min-width|max-width|padding|margin|gap|border-radius|border-width|font|font-size|font-weight|line-height|box-shadow|background|transform|position|isolation)\s*:/, `${selector.trim()} draws no geometry of its own`);
    assert.doesNotMatch(selector, /::(?:before|after)|term-minimized-pill-(?:label|close)/, `${selector.trim()}: no pseudo-element shapes, the label and the ✕ are the tray's`);
  }
  assert.match(sidepanelStyles, /\.asp-session-pill\.asp-pill-running \{ border-color: var\(--asst-pill-on-ring\); \}/);
  assert.match(sidepanelStyles, /\.asp-session-pill\.asp-pill-running \.term-minimized-pill-icon \.syna-cameo \{ display: inline-flex; \}/);
  assert.doesNotMatch(sidepanelStyles, /--asp-pill-angle|asp-pill-spin|asp-pulse|asp-abort-sweep/);
  // Stop is the component's one neutral ■ (asst-styles.js): no sidepanel override, never red.
  assert.doesNotMatch(sidepanelStyles, /data-state="stop"/);
  assert.doesNotMatch(sidepanelStyles, /rgba\(255, (70|82|110), /, 'no hard-coded reds');
  // styles.css tray block: a 24px close target and reduced motion for every tray pill.
  const tray = stylesCss.slice(stylesCss.indexOf('/* ── Minimized terminal pills tray ── */'), stylesCss.indexOf('/* Genie minimize/restore animation'));
  assert.ok(tray.length > 200, 'tray block');
  assert.match(tray, /\.term-minimized-pill \{[^}]*height: 32px;[^}]*border: 1px solid rgba\(255,255,255,0\.08\);[^}]*border-radius: 8px;/, 'the shared pill: 32px, a hairline, 8px corners');
  assert.match(tray, /\.term-minimized-pill-close::after \{\s*content: '';\s*position: absolute;\s*inset: -3px;/);
  assert.match(tray, /width: 18px;\s*height: 18px;/);
  assert.match(tray, /\.term-minimized-pill-close \{[^}]*border-radius: 5px;/, 'the ✕ is a rounded square, never a circle');
  assert.doesNotMatch(tray, /border-radius: 999px/);
  assert.match(tray, /@media \(prefers-reduced-motion: reduce\) \{\s*\.term-minimized-pill, \.term-minimized-pill::before, \.term-minimized-pill::after,/);
  assert.doesNotMatch(tray, /transition:\s*all/);
});

test('i18n: every sidepanel string has an en.json key; CRLF files stay CRLF', () => {
  const i18n = JSON.parse(en);
  const keys = new Set([...sidepanel.matchAll(/tr\('(assistant\.[a-zA-Z.]+)'/g)].map(m => m[1]));
  keys.add('assistant.panel.open');
  assert.ok(keys.size >= 12);
  for (const key of keys) {
    const value = key.split('.').reduce((node, part) => node?.[part], i18n);
    assert.equal(typeof value, 'string', key);
  }
  for (const [name, text] of Object.entries({ 'html-shell.js': htmlShell, 'styles.css': stylesCss, 'ui-file-explorer.js': fileExplorer, 'ui-tooltip.js': tooltip, 'constants.js': constants, 'state.js': stateJs, 'ui-keybinds.js': keybinds, 'en.json': en })) {
    assert.equal((text.match(/\r\n/g) || []).length, (text.match(/\n/g) || []).length, `${name} keeps CRLF line endings`);
  }
});
