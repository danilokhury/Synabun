import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Source-level contract for the assistant tab restyle ("black with faint panels").
const root = resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const styles = read('public/shared/assistant/asst-styles.js');
const panel = read('public/shared/assistant/asst-panel.js');
const control = read('public/shared/assistant/asst-control.js');
const composer = read('public/shared/assistant/asst-composer.js');
const dock = read('public/shared/assistant/asst-agents-dock.js');
const picker = read('public/shared/assistant/asst-brain-picker.js');
const route = read('public/shared/assistant/asst-route.js');
const roving = read('public/shared/assistant/asst-roving.js');
const en = read('i18n/en.json');
const usage = read('public/shared/assistant/asst-usage.js');

test('usage gauge mounts between dock and composer and uses the shared packet stream', () => {
  assert.match(panel, /asst-dock-host"><\/div>\s*<div class="asst-usage-host" hidden><\/div>\s*<div class="asst-composer-host"/);
  assert.match(panel, /case 'assistant:usage':\s*\+\+usageFetchSeq;\s*applyUsage\(packet\)/);
  assert.match(panel, /getAssistantSessionUsage\(sessionId\)/);
  assert.match(panel, /usage\.setConnection\(status\)/);
  assert.match(usage, /aria-controls/);
  assert.match(usage, /addEventListener\('keydown', onKey, true\)/);
  assert.match(styles, /\.asst-usage-host\[hidden\] \{ display: none !important; \}/);
  assert.match(styles, /\.asst-usage-segment\[data-positive="true"\] \{ min-width: 1px; \}/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*?\.asst-usage-host \*/);
  assert.ok(JSON.parse(en).assistant.usage.toggleClose);
});

test('the usage limit is one sticky line under the gauge, never a transcript row', () => {
  assert.match(panel, /root\.querySelector\('\.asst-usage-host'\)\.after\(limitEl\)/);
  assert.match(panel, /case 'assistant:limit':\s*if \(applyLimitPacket\(st, packet\)\) renderLimit\(\);/);
  assert.match(panel, /onLimit: \(info\) => \{ if \(applyLimit\(st, info\)\) renderLimit\(\); \}/);
  const limitCase = read('public/shared/assistant/asst-render.js').match(/case 'rate_limit_event':[\s\S]*?return true;/)?.[0] || '';
  assert.match(limitCase, /hooks\.onLimit\?\.\(/);
  assert.doesNotMatch(limitCase, /appendStatus/);
  assert.match(styles, /\.asst-limit\[hidden\] \{ display: none !important; \}/);
  assert.match(styles, /\.asst-limit\[data-status="rejected"\] \{ color: var\(--asst-live\)/);
  const status = JSON.parse(en).assistant.status;
  assert.deepEqual([status.rateLimitWarn, status.rateLimited, status.resetsAt], ['Approaching the usage limit', 'Usage limit reached', 'resets {time}']);
});

/** Body of the first CSS rule whose selector list matches `selectorRe`. */
function ruleBody(css, selectorRe) {
  const re = new RegExp(`(?:^|[}\\s])${selectorRe.source}\\s*\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  return m ? m[1] : null;
}

/** Every style rule of a sheet as { selector, body }, comments dropped, rules inside @media / @container included. */
function rules(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
}

/** The Assistant's sheets as the page gets them: injected (interpolations resolved), the rack's, and the tray block of styles.css. */
async function assistantSheets() {
  const injected = [];
  const saved = globalThis.document;
  globalThis.document = { getElementById: () => null, createElement: () => ({}), head: { appendChild: (el) => injected.push(el) } };
  try {
    const { injectAssistantSidepanelStyles } = await import('../public/shared/assistant/asst-sidepanel-styles.js');
    injectAssistantSidepanelStyles();
  } finally {
    globalThis.document = saved;
  }
  const { RACK_CSS } = await import('../public/shared/assistant/asst-rack-styles.js');
  const stylesCss = read('public/shared/styles.css');
  const tray = stylesCss.slice(stylesCss.indexOf('/* ── Minimized terminal pills tray ── */'), stylesCss.indexOf('/* Genie minimize/restore animation'));
  return { ...Object.fromEntries(injected.map(el => [el.id, el.textContent])), 'asst-rack-styles': RACK_CSS, 'styles.css tray': tray };
}

test('tokens live under :where(:root) with the black palette', () => {
  const tokens = ruleBody(styles, /:where\(:root\)/);
  assert.ok(tokens, ':where(:root) token block');
  assert.match(tokens, /--asst-bg:\s*#0a0a0c/);
  assert.match(tokens, /--asst-card:\s*#0f0f11/);
  assert.match(tokens, /--asst-bar:\s*var\(--asst-card\)/);
  assert.match(tokens, /--asst-card-ring:\s*rgba\(255,255,255,\.06\)/);
  assert.match(tokens, /--asst-scrim:/);
  assert.match(tokens, /--asst-text-3:\s*rgba\(255,255,255,\.52\)/, 'muted text ≈5.7:1 (.52; it was .46, the 4.5:1 floor)');
  assert.doesNotMatch(styles, /^\s*:root\s*\{/m, 'no specificity-bearing :root block');
});

test('no grey glass surfaces, no backdrop-filter, no will-change', () => {
  assert.doesNotMatch(styles, /var\(--s-(panel|subtle|light)\)/, 'legacy grey surfaces are gone');
  assert.doesNotMatch(styles, /backdrop-filter/);
  assert.doesNotMatch(styles, /will-change/);
});

test('the viewport overrides the foreign inset card and float padding', () => {
  const viewport = ruleBody(styles, /\.term-viewport\.assistant-viewport/);
  assert.ok(viewport);
  assert.match(viewport, /inset:\s*0 !important/);
  assert.match(viewport, /padding:\s*0 !important/);
  assert.match(viewport, /border-radius:\s*0 !important/);
  assert.match(viewport, /background:\s*var\(--asst-bg\)/);
  assert.match(styles, /\.term-float-tab-body:has\(> \.term-float-viewport-wrap > \.assistant-viewport\)\s*\{\s*padding:\s*0 !important;?\s*\}/);
});

test('[hidden] beats display rules everywhere the assistant renders', () => {
  assert.match(styles, /:is\(\.asst-root, \.asst-bar, \.asst-dd-menu, \.asst-modal-overlay, \.asst-lightbox\) \[hidden\],\s*\.asst-root\[hidden\],\s*\.term-float-brain-chip\[hidden\]\s*\{\s*display:\s*none !important;?\s*\}/);
  assert.doesNotMatch(styles, /\.asst-control-deny-msg\[hidden\]/, 'the one-off rule is gone');
});

test('the modal overlay uses a single scrim background', () => {
  const overlay = ruleBody(styles, /\.asst-modal-overlay/);
  assert.ok(overlay);
  const backgrounds = overlay.match(/background\s*:/g) || [];
  assert.equal(backgrounds.length, 1, 'exactly one background declaration');
  assert.match(overlay, /background:\s*var\(--asst-scrim\)/);
});

test('motion is paused while dragging and removed under reduced motion', () => {
  const pause = styles.match(/body\.ui-interacting :is\(([^)]*)\)[^{]*\{\s*animation-play-state:\s*paused !important/);
  assert.ok(pause, 'one pause rule for the live and running marks');
  for (const cls of ['.asst-live-dot', '.asst-spinner', '.asst-computer-dot', '.syna-cameo-eye']) assert.ok(pause[1].includes(cls), cls);
  assert.doesNotMatch(styles, /asst-working-dots/, 'the "Working…" dots are gone: the thinking mascot stands in');
  // The empty state's character is a rig that moves by itself: no CSS float on top of it.
  assert.doesNotMatch(styles, /asst-float/);
  assert.doesNotMatch(styles.match(/\.asst-empty-mascot \{[^}]*\}/)[0], /animation/);
  const reduced = styles.slice(styles.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  const blanket = reduced.match(/([^{}]+)\{\s*animation:\s*none !important;\s*transition:\s*none !important;?\s*\}/);
  assert.ok(blanket, 'the reduced-motion blanket stops animations and transitions');
  for (const root of ['.asst-root', '.asst-dd-menu', '.asst-modal-overlay', '.assistant-panel', '.term-minimized-pill']) assert.ok(blanket[1].includes(root), `the blanket covers ${root}`);
  assert.match(blanket[1], /\*::before/);
  assert.match(blanket[1], /\*::after/);
  assert.match(reduced, /scroll-behavior:\s*auto/);
  assert.match(styles, /::-webkit-scrollbar/, 'WebKit scrollbar styling kept for the Safari web app');
});

/** Every CSS rule's selector list in a stylesheet source (comments and template holes out). */
function selectorsOf(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\$\{[^}]*\}/g, 'x');
  return [...css.matchAll(/(?:^|[{}])\s*([^{}@]+?)\s*\{/g)].map(m => m[1].trim()).filter(sel => !/^(from|to|\d+%)/.test(sel));
}

test('no pseudo-element inside :is() / :where() (the whole rule would be dropped)', () => {
  const sidepanelStyles = read('public/shared/assistant/asst-sidepanel-styles.js');
  for (const [name, source] of [['asst-styles.js', styles], ['asst-sidepanel-styles.js', sidepanelStyles]]) {
    for (const sel of selectorsOf(source)) {
      for (const m of sel.matchAll(/:(?:is|where)\(/g)) {
        let depth = 1; let i = m.index + m[0].length; const start = i;
        while (i < sel.length && depth) { if (sel[i] === '(') depth += 1; if (sel[i] === ')') depth -= 1; i += 1; }
        assert.doesNotMatch(sel.slice(start, i - 1), /::/, `${name}: ${sel}`);
      }
    }
  }
});

test('pill system: three heights, their corners, one padding scale and the motion tokens on :where(:root)', () => {
  const tokens = ruleBody(styles, /:where\(:root\)/);
  const want = {
    '--asst-pill-h-xs': '18px', '--asst-pill-h-sm': '22px', '--asst-pill-h-md': '28px',
    '--asst-pill-r-xs': '5px', '--asst-pill-r-sm': '6px', '--asst-pill-r-md': '8px',
    '--asst-pill-px-xs': '6px', '--asst-pill-px-sm': '8px', '--asst-pill-px-md': '11px',
    '--asst-dur-instant': '80ms', '--asst-dur-fast': '140ms', '--asst-dur-base': '200ms', '--asst-dur-moderate': '240ms', '--asst-dur-slow': '320ms',
    '--asst-ease-standard': 'cubic-bezier(.2,0,.38,.9)', '--asst-ease-enter': 'cubic-bezier(0,0,.38,.9)', '--asst-ease-exit': 'cubic-bezier(.2,0,1,.9)',
    '--asst-ease-emphasized': 'cubic-bezier(.4,.14,.3,1)', '--asst-ease-spring': 'linear(0, 0.35 9%, 0.78 21%, 1.03 40%, 0.99 60%, 1)',
  };
  for (const [name, value] of Object.entries(want)) {
    const m = tokens.match(new RegExp(`${name}:\\s*([^;]+);`));
    assert.ok(m, name);
    assert.equal(m[1].trim(), value, name);
  }
  // Every capsule takes its height from the scale: md by default, sm for the toolbar and chips, xs for counts.
  assert.match(styles, /--cap-h: var\(--asst-pill-h-md\);[\s\S]*?height: var\(--cap-h\);/);
  assert.match(styles, /\.asst-bar :is\(\.asst-dd, \.asst-tb-btn, \.asst-iconbtn, \.asst-cost\), \.asst-chip \{\s*--cap-h: var\(--asst-pill-h-sm\);/);
  assert.match(ruleBody(styles, /\.asst-count/), /height: var\(--asst-pill-h-xs\)/);
  assert.match(ruleBody(styles, /\.asst-pill/), /height: var\(--asst-pill-h-sm\)/);
  for (const cls of ['asst-btn', 'asst-dd', 'asst-chip', 'asst-iconbtn', 'asst-tb-btn', 'asst-send']) {
    assert.doesNotMatch(styles, new RegExp(`\\.${cls}(?![\\w-])[^{]*\\{[^}]*\\bheight:\\s*(24|26|30)px`), `no stray ${cls} height`);
  }
  // Corners follow the height (a quarter of it: md 8, sm 6, xs 5), rounded rectangles; the seam is the glyph half's inset line.
  assert.match(styles, /--cap-h: var\(--asst-pill-h-md\);\s*--cap-r: var\(--asst-pill-r-md\);[\s\S]*?border-radius: var\(--cap-r\);/);
  assert.match(styles, /\.asst-chip \{\s*--cap-h: var\(--asst-pill-h-sm\);\s*--cap-r: var\(--asst-pill-r-sm\);/);
  assert.match(styles, /\.asst-chip\.asst-suggestion \{ --cap-h: var\(--asst-pill-h-md\); --cap-r: var\(--asst-pill-r-md\);/);
  assert.match(ruleBody(styles, /\.asst-count/), /border-radius: var\(--asst-pill-r-xs\)/);
  assert.match(ruleBody(styles, /\.asst-pill/), /border-radius: var\(--asst-pill-r-sm\)/);
  assert.match(styles, /:is\(\.asst-dd, \.asst-tb-btn, \.asst-chip\) > \.asst-icon:not\(\[hidden\]\):not\(:last-child\) \{[^}]*box-shadow: inset -1px 0 0 var\(--asst-line\)/);
  assert.match(ruleBody(styles, /\.asst-btn-secondary/), /background:/, '.asst-btn-secondary has its own look');
});

test('pills are rounded rectangles: no 999px or 50% corners but the dots; the mascot keeps its pill eyes', async () => {
  const sheets = await assistantSheets();
  assert.deepEqual(Object.keys(sheets), ['assistant-panel-styles', 'assistant-sidepanel-styles', 'asst-rack-styles', 'styles.css tray']);
  // Round on purpose, and only these: status dots, the loading spinner and the click marker on a screenshot.
  const DOTS = [
    'assistant-panel-styles: .asst-banner::before',
    'assistant-panel-styles: .asst-frame-marker',
    'assistant-panel-styles: .asst-pill::before',
    'assistant-panel-styles: .asst-computer-perm[data-granted="1"] .asst-computer-perm-state',
    'assistant-panel-styles: .asst-spinner',
    'assistant-panel-styles: .asst-live-dot',
    'assistant-panel-styles: .asst-computer-dot',
    'assistant-panel-styles: .asst-usage-dot',
    'assistant-panel-styles: .asst-usage-status::before',
    'assistant-panel-styles: .asst-limit::before',
    'assistant-sidepanel-styles: .asp-status::before',
  ];
  const round = [];
  const offScale = [];
  for (const [name, css] of Object.entries(sheets)) {
    for (const { selector, body } of rules(css)) {
      if (/border-radius:\s*(?:50%|\d{3,}px)/.test(body)) round.push(`${name}: ${selector}`);
      // A rule that sizes a pill from the scale takes its corners from the scale too.
      if (/(?:^|[\s;])height:\s*var\(--(?:asst-pill-h-|cap-h|rk-pill-h)/.test(body) && /border-radius:/.test(body)
        && !/border-radius:\s*var\(--(?:asst-pill-r-(?:xs|sm|md)|cap-r|rk-pill-r(?:-xs)?)\)/.test(body)) offScale.push(`${name}: ${selector}`);
    }
  }
  assert.deepEqual(round.sort(), [...DOTS].sort(), 'no full capsule or circle on a pill, chip, badge, button or selector; the dots stay round');
  assert.deepEqual(offScale, [], 'pill corners come from --asst-pill-r-*');
  // Icon-only buttons are squares with their row's corners: the composer's md, the sidepanel header's sm.
  assert.match(ruleBody(styles, /:is\(\.asst-iconbtn, \.asst-tb-btn\.asst-attach\)/), /width: var\(--cap-h\); padding: 0;/);
  assert.doesNotMatch(ruleBody(styles, /:is\(\.asst-iconbtn, \.asst-tb-btn\.asst-attach\)/), /border-radius/, 'the capsule corners (--cap-r)');
  assert.match(ruleBody(sheets['assistant-sidepanel-styles'], /\.asp-btn/), /border-radius: var\(--asst-pill-r-sm\);/);
  // The tray's ✕ (every provider's pill): a rounded square with the tray's 24px target.
  assert.match(sheets['styles.css tray'], /\.term-minimized-pill-close \{[^}]*width: 18px;\s*height: 18px;[^}]*border-radius: 5px;/);
  // The character keeps its shape: the cameo's and the face's eyes are still full pills (rx = half the width).
  const mascot = read('public/shared/synabun-mascot.js');
  assert.equal((mascot.match(/<rect class="syna-cameo-eye" x="\d+" y="0" width="3" height="7" rx="1\.5"/g) || []).length, 2, 'the cameo eyes');
  assert.equal((mascot.match(/width="38" height="72" rx="19"/g) || []).length, 4, 'the face eyes (and the blink pair)');
});

test('one focus-visible recipe for the component, the sidepanel chrome and the tray pill', () => {
  const sidepanelStyles = read('public/shared/assistant/asst-sidepanel-styles.js');
  const rings = [...styles.matchAll(/([^{}]+)\{\s*outline:\s*2px solid var\(--asst-focus\);\s*outline-offset:\s*1px;\s*\}/g)];
  assert.equal(rings.length, 1, 'one recipe');
  const list = rings[0][1];
  for (const part of ['.asst-root', '.asst-bar', '.asst-dd-menu', '.assistant-panel.sp-sidepanel', '.asp-header', '.asp-session-pill:focus-visible', '.asp-session-pill .term-minimized-pill-close:focus-visible']) {
    assert.ok(list.includes(part), `the recipe covers ${part}`);
  }
  assert.doesNotMatch(styles, /:focus-visible[^{]*\{[^}]*outline:\s*1\.5px/, 'no thinner ring left');
  assert.doesNotMatch(styles, /outline:\s*2px solid var\(--asst-brand\)/, 'no gold focus ring');
  assert.doesNotMatch(sidepanelStyles, /outline:\s*\d/, 'the sidepanel sheet draws no ring of its own');
  assert.doesNotMatch(read('public/shared/assistant/asst-rack-styles.js'), /outline:\s*\d/, 'neither does the rack sheet (its rows use the recipe)');
  // A folded rack contains its paint (content-visibility): its receipt draws the same ring inside.
  assert.match(styles, /\.asst-root \.asst-rack-receipt:focus-visible,[^{]*\{ outline-offset: -2px; \}/);
});

test('transitions name their properties; no backdrop blur or layer hints in the component sheet', () => {
  const sidepanelStyles = read('public/shared/assistant/asst-sidepanel-styles.js');
  for (const [name, source] of [['asst-styles.js', styles], ['asst-sidepanel-styles.js', sidepanelStyles]]) {
    assert.doesNotMatch(source, /transition:\s*all\b/, `${name}: no transition: all`);
  }
  assert.doesNotMatch(styles, /backdrop-filter/);
  assert.doesNotMatch(styles, /will-change/);
  // One pulse for live, the cameo for running, the spinner for loading.
  const frames = [...styles.matchAll(/@keyframes ([\w-]+)/g)].map(m => m[1]);
  assert.deepEqual(frames.sort(), ['asst-cameo', 'asst-live', 'asst-spin', 'asst-usage-pulse']);
  // The rack replaced the work row and the SynaBun tool pills: none of their CSS is left.
  assert.doesNotMatch(styles, /\.asst-work(?!ing)|asst-work-(?:boop|bob|in|sweep)|\.boop\b|\.asst-tool\.synabun|\.asst-tool-icon|\.asst-tool-chev|\.asst-empty-mark/);
  assert.deepEqual([...sidepanelStyles.matchAll(/@keyframes ([\w-]+)/g)].map(m => m[1]).sort(), ['asp-sweep'], 'no asp-pulse, no conic ring or pill spinner, no abort sweep');
  assert.match(styles, /\.syna-cameo-eye \{[^}]*animation: asst-cameo 2\.8s/, 'the cameo glances');
  assert.match(styles, /@keyframes asst-cameo \{ 0%, 42% \{ transform: translateX\(-1\.2px\); \} 50%, 92% \{ transform: translateX\(1\.2px\); \}/);
  // One cameo form: mascotCameoSvg() (header status, tray pill, run pills); no span twin, no pseudo-element eyes.
  assert.doesNotMatch(styles, /span\.syna-cameo|box-shadow: 7px 0 0 var\(--asst-brand\)/);
  assert.match(read('public/shared/assistant/asst-sidepanel.js'), /const CAMEO = mascotCameoSvg\(\);/);
  assert.match(read('public/shared/assistant/asst-render.js'), /<span class="asst-pill" data-tone="running">\$\{mascotLib\.mascotCameoSvg\(\)\}<span class="asst-pill-label"><\/span><\/span>/);
  assert.match(styles, /\.asst-pill\[data-tone="running"\] > \.syna-cameo \{ display: inline-block;/);
});

test('container queries cover width and height breakpoints; short tabs keep the toolbar', () => {
  assert.match(styles, /container:\s*asst \/ size/);
  for (const q of ['max-width: 960px', 'max-width: 720px', 'max-width: 540px', 'max-width: 400px', 'max-width: 320px', 'max-height: 260px']) {
    assert.ok(styles.includes(`@container asst (${q})`), q);
  }
  const short = styles.slice(styles.indexOf('@container asst (max-height: 260px)'));
  assert.doesNotMatch(short.slice(0, short.indexOf('\n    }')), /\.asst-bar\b/, 'the toolbar is never hidden by height');
});

test('the header card is gone; the toolbar is flush under the tabs', () => {
  assert.doesNotMatch(styles, /asst-topbar|\.asst-toolbar\b|asst-toolbar-(left|right)|asst-brandmark|asst-brand-pulse/);
  const bar = ruleBody(styles, /\.asst-bar/);
  assert.ok(bar, '.asst-bar rule');
  assert.match(bar, /height:\s*36px/);
  assert.match(bar, /background:\s*var\(--asst-bar\)/);
  assert.match(bar, /border-bottom:\s*1px solid var\(--asst-card-ring\)/);
  assert.doesNotMatch(bar, /margin|border-radius|box-shadow/, 'no card: flush with the tab bar');
  assert.match(styles, /\.asst-bar-right\s*\{[^}]*flex:\s*0 0 auto/, 'the right group never shrinks');
  assert.match(styles, /\.asst-bar-group \+ \.asst-bar-group::before/, 'thin separators between groups');
  assert.match(styles, /\.asst-dd\[aria-expanded="true"\] \.asst-dd-caret\s*\{\s*transform:\s*rotate\(180deg\)/);
  assert.match(styles, /\.term-float-tab:has\(\.assistant-viewport\) \.term-float-brain-chip\s*\{\s*display:\s*none !important/, 'no duplicate model chip in the float header');
});

test('control cards are selected by [data-kind], never by a kind class', () => {
  assert.match(styles, /\.asst-control\[data-kind="permission"\]/);
  assert.match(styles, /\.asst-control:is\(\[data-kind="plan"\], \[data-kind="route"\], \[data-kind="clarify"\]\) \{ --tone: var\(--asst-text-2\);/, 'plan and route cards are not gold: gold means live');
  assert.doesNotMatch(ruleBody(styles, /\.asst-control/), /inset 2px/, 'no accent bar on the card, a 1px tone hairline');
  assert.match(ruleBody(styles, /\.asst-control/), /border: 1px solid var\(--tone-line\);/);
  assert.match(styles, /\.asst-control-kind::before \{\s*content: '◆' \/ '';/, 'the ◆ glyph half of the kind capsule');
  assert.match(control, /decorateControlHead\(head, kindLabel\)/);
  assert.match(control, /mascotSvg\(\{ width: 28, height: 14, className: 'synabun-mascot asst-still' \}\)[\s\S]*?stillFrame\('blocked'\)/, 'a 28×14 still blocked cameo');
  // Stop is one neutral white ■ in both hosts; Deny a neutral ghost; no glow under the hero.
  assert.match(styles, /\.asst-root \.asst-send\[data-state="stop"\],\s*\.asst-root \.asst-send\[data-state="stop"\]:hover:not\(:disabled\) \{ background: var\(--asst-text\); box-shadow: none; color: var\(--asst-ink\); \}/);
  assert.match(styles, /\.asst-btn-danger \{ background: transparent; box-shadow: inset 0 0 0 1px var\(--asst-line-2\); color: var\(--asst-text-2\); \}/);
  assert.doesNotMatch(styles, /drop-shadow\(/, 'no glow on a static character');
  assert.doesNotMatch(control, /asst-control-\$\{/);
  assert.match(control, /card\.dataset\.kind = n\.kind/);
  assert.match(control, /el\('div', 'asst-control active'\)/);
});

test('the transcript is a log but not a live region; one panel status announces the answer and errors', () => {
  assert.match(panel, /<div class="asst-transcript" role="log" aria-live="off" tabindex="0"/);
  assert.doesNotMatch(panel, /aria-relevant="additions"/);
  assert.match(panel, /<div class="asst-announce" role="status" aria-live="polite" aria-atomic="true"><\/div>/);
  assert.match(panel, /announce\(tt\('assistant\.announce\.replied', 'SynaBun replied: \{text\}'/);
  assert.match(panel, /announce\(tt\('assistant\.announce\.error', 'Error: \{text\}'/);
  assert.match(styles, /\.asst-announce \{ position: absolute; width: 1px; height: 1px;/, 'visually hidden');
  const i18n = JSON.parse(en);
  assert.deepEqual(i18n.assistant.announce, { replied: 'SynaBun replied: {text}', error: 'Error: {text}' });
  // Only the run labels of the old work card stay in en.json.
  assert.deepEqual(Object.keys(i18n.assistant.work), ['agents', 'agentId']);
});

test('panel: one toolbar before the transcript (3 groups · agents cost history new more), a bottom card, zero-cost hidden', () => {
  const start = panel.indexOf('<div class="asst-bar" role="toolbar"');
  assert.ok(start > 0, 'the toolbar markup');
  assert.ok(start < panel.indexOf('<div class="asst-banners"'), 'the toolbar comes first');
  const bar = panel.slice(start, panel.indexOf('<div class="asst-banners"'));
  for (const group of ['route', 'context', 'computer']) assert.match(bar, new RegExp(`data-group="${group}"`), group);
  assert.match(bar, /asst-bar-right">[\s\S]*asst-act-agents[\s\S]*asst-cost[\s\S]*asst-act-sessions[\s\S]*asst-act-new[\s\S]*asst-act-more/);
  assert.doesNotMatch(panel, /asst-topbar|titleEl|toolbarMoreBtn|headerMoreBtn|refreshToolbar|composer\.toolbar|fromServer|asst-brain-host/);
  assert.match(panel, /createRovingToolbar\(barEl, \{ lead: composer\.el\.querySelector\('\.asst-composer-brain'\) \}\)/, 'the composer row\'s fields lead the toolbar\'s arrow order');
  assert.doesNotMatch(bar, /data-group="brain"/, 'model · effort live in the composer row');
  assert.match(panel, /createBrainPicker\(\{ brain: composer\.el\.querySelector\('\.asst-composer-brain'\), context: barGroups\.context \}/);
  assert.match(panel, /<div class="asst-bottom">[\s\S]*asst-computer-host[\s\S]*asst-dock-host[\s\S]*asst-composer-host/);
  assert.match(panel, /costEl\.hidden = !\(total > 0\)/);
  assert.match(panel, /root\.dataset\.status = /);
  assert.match(panel, /case 'turn_started':/, "another session's turn_started handling is kept");
  assert.match(panel, /document\.addEventListener\('keydown', onEscCapture, true\)/, 'Esc stops computer control in the capture phase');
});

test('the tab is always called SynaBun; server titles only name the conversation', () => {
  assert.match(panel, /title: tt\('assistant\.defaultTitle', 'SynaBun'\)/);
  assert.match(panel, /if \(meta\.title\) st\.sessionTitle = String\(meta\.title\)/);
  assert.match(panel, /function syncTabLabel\(\)\s*\{\s*try \{ host\.setLabel\?\.\(st\.title\)/);
  assert.doesNotMatch(panel, /st\.title \|\| 'Assistant'/, 'notifications use notifyLabel()');
  const i18n = JSON.parse(en);
  assert.equal(i18n.assistant.defaultTitle, 'SynaBun');
  assert.equal(i18n.assistant.toolbar.label, 'Assistant controls');
  assert.equal((en.match(/\r\n/g) || []).length, (en.match(/\n/g) || []).length, 'en.json keeps CRLF line endings');
});

test('toolbar menus open below; every dropdown has a caret; the account is a field', () => {
  assert.doesNotMatch(picker, /placement:\s*'above'/);
  assert.doesNotMatch(panel, /placement:\s*'above'/);
  const chip = route.slice(route.indexOf('export function createRouteModeControl'), route.indexOf('function fmtCountdown'));
  assert.doesNotMatch(chip, /placement:\s*'above'/);
  assert.match(chip, /asst-dd-caret/);
  assert.match(picker, /const FIELDS = \['model', 'effort', 'variant', 'mode', 'account', 'project', 'mcp'\]/);
  assert.match(picker, /<span class="asst-dd-caret" aria-hidden="true">\$\{ICON_CARET\}<\/span>/);
  assert.match(roving, /export function createRovingToolbar/);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'MutationObserver', 'ResizeObserver']) assert.ok(roving.includes(key), key);
  assert.match(roving, /lead\?\.addEventListener\('keydown', onKeyDown\)/, 'Home/End/arrows work from the lead fields too');
});

test('the composer is the input plus attach · model/effort slot / send (no toolbar of its own)', () => {
  assert.doesNotMatch(composer, /role="toolbar"|asst-toolbar|syncRoving|refreshToolbar/);
  assert.match(composer, /class="asst-composer-actions"[\s\S]*asst-attach[\s\S]*class="asst-composer-brain"[\s\S]*class="asst-send"/);
  assert.doesNotMatch(composer, /asst-composer-box|asst-composer-hint/);
  assert.match(composer, /sendBtn\.dataset\.state = mode/);
  assert.match(composer, /fillTemplate\(tpl\)/);
});

test('agents tray hides itself when there is nothing to show', () => {
  assert.match(dock, /root\.hidden = c\.total === 0/, 'older finished runs keep the tray accessible');
  assert.match(dock, /aria-pressed/);
});

test('Models manager: Available / Archived tabs (tablist, arrow keys) with Restore and Restore all', () => {
  assert.match(route, /role="tablist"/);
  assert.match(route, /role="tab"[^>]*data-tab="available"/);
  assert.match(route, /role="tab"[^>]*data-tab="archived"/);
  assert.match(route, /role="tabpanel"/);
  assert.match(route, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/);
  assert.match(route, /assistant\.models\.restore', 'Restore'/);
  assert.match(route, /assistant\.models\.restoreAll', 'Restore all'/);
  assert.match(route, /assistant\.models\.notListed', 'not listed'/);
  assert.match(route, /show: list/, 'Restore PATCHes { show: [...] }');
  assert.match(panel, /sync:opencode:hidden-models-changed', \(\) => refreshModelsManager\(\)/);
  assert.match(styles, /\.asst-models-tab\.is-active/);
});
