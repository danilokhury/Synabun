// ═══════════════════════════════════════════
// SynaBun Assistant — worker stage and scene styles
// ═══════════════════════════════════════════
// Injected once by asst-render.js as <style id="asst-scene-styles">, right
// after the rack's sheet (asst-rack-styles.js), whose sweep (asst-rk-sweep)
// and caret blink (asst-rk-caret) it reuses. Three things live here:
//
// - the stage a run card opens while its worker works (asst-run-stage.js):
//   the mascot, the scene and the step in one faint panel of a
//   fixed height, the rack's gold sweep on its bottom edge; it folds like the
//   rack's stage (grid rows 0fr ↔ 1fr, 240 ms) once the worker settles;
// - the scenes (asst-scenes.js): transform and opacity loops only, running
//   while the scene carries data-live, never while it waits on you (calm,
//   dimmed, no gold) or after it settled;
// - the agents tray's mini scenes and lanes (asst-agents-dock.js).
//
// Rules as the rack's: gold only means live; infinite loops pause while the
// UI is dragged (body.ui-interacting), off screen (data-offscreen on a holder,
// a closed side panel: asst-styles.js) and stop under prefers-reduced-motion,
// where every scene is its still frame and the sweep is not drawn. Tokens
// come from asst-styles.js, always with a fallback. No backdrop blur and no
// standing layer hints: a moving layer is promoted (will-change) only while
// its scene is live and on screen.
//
// A scene's moving parts are HTML layers (asst-scenes.js), so every motion is
// a box's transform or opacity, run by the compositor. Lengths are written in
// the scene's own units (the SVG's px) and turned into percentages of the box
// here (sc() below): a scene is drawn at several sizes, and a percentage of
// the box is the same distance in units at every one of them.

import { CODE_LINES, CODE_STEP, CODE_WINDOW, FILM_MINI_WINDOW, FILM_WINDOW, SCENE_BOX, boxPct, codeCaretX } from './asst-scenes.js';

export const SCENE_STYLE_ID = 'asst-scene-styles';

const FULL = SCENE_BOX.full;
const MINI = SCENE_BOX.mini;
const win = ([, , w, h]) => ({ w, h });

/** A move of (x, y) scene units in a box: `translate(…%, …%)`, plus any scale or rotation after it. */
function sc(box, x, y, more = '') {
  return `transform: translate(${boxPct(x, box.w)}, ${boxPct(y, box.h)})${more ? ` ${more}` : ''};`;
}

/** The code scene's stepped scroll (one line per step, inside its window) and its caret, which lands on each new bottom line's end. */
function codeFrames() {
  const n = CODE_LINES.length;
  const at = (s) => Math.round((s * 100000) / n) / 1000;
  const hold = (s) => Math.round(((s * 100) / n + (100 / n) * 0.72) * 1000) / 1000;
  const view = win(CODE_WINDOW);
  let scroll = '';
  let caret = '';
  for (let s = 0; s < n; s += 1) {
    scroll += ` ${at(s)}%, ${hold(s)}% { ${sc(view, 0, -CODE_STEP * s)} }`;
    caret += ` ${at(s)}%, ${hold(s)}% { ${sc(FULL, codeCaretX(s), 0)} }`;
  }
  scroll += ` 100% { ${sc(view, 0, -CODE_STEP * n)} }`;
  caret += ` 100% { ${sc(FULL, codeCaretX(n), 0)} }`;
  return `@keyframes asst-sc-code {${scroll} }\n  @keyframes asst-sc-code-caret {${caret} }`;
}

/** The pointer scenes: rest on the button, travel to the page, back (units of their own box). */
const pointFrames = (name, box, [x0, y0], [x1, y1], more = '', [a, b, c, d] = [22, 46, 72, 96]) => `@keyframes ${name} { 0%, ${a}% { ${sc(box, x0, y0, more)} } ${b}%, ${c}% { ${sc(box, x1, y1, more)} } ${d}%, 100% { ${sc(box, x0, y0, more)} } }`;

export const SCENE_CSS = `
  /* ── The stage in a run card ──────────────────────────────────────── */
  .asst-run-stage-wrap {
    grid-column: 1 / -1;
    display: grid;
    grid-template-rows: 0fr;
    min-width: 0;
    transition: grid-template-rows var(--asst-dur-moderate, 240ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9));
  }
  .asst-run.is-staged > .asst-run-stage-wrap { grid-template-rows: 1fr; }
  .asst-run-stage {
    --sc-gold: var(--asst-brand, rgba(255,215,0,.85));
    --sc-shade: var(--asst-popover, #131316);
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-rows: 40px 16px;
    grid-template-areas: "face scene" "line line";
    align-items: center;
    column-gap: 10px;
    row-gap: 6px;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    margin-top: 0;
    padding: 0 10px;
    border-radius: var(--asst-r-field, 8px);
    background: var(--asst-field, rgba(255,255,255,.025));
    box-shadow: inset 0 0 0 1px var(--asst-line, rgba(255,255,255,.07));
    color: var(--asst-text-2, rgba(255,255,255,.64));
    visibility: hidden;
    transition: margin-top var(--asst-dur-moderate, 240ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9)), padding var(--asst-dur-moderate, 240ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9)), visibility 0s linear var(--asst-dur-moderate, 240ms);
  }
  .asst-run.is-staged .asst-run-stage {
    margin-top: 8px;
    padding: 8px 10px;
    visibility: visible;
    transition: margin-top var(--asst-dur-moderate, 240ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9)), padding var(--asst-dur-moderate, 240ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9)), visibility 0s;
  }
  .asst-run-stage-face { grid-area: face; width: 56px; height: 28px; color: var(--asst-text, rgba(255,255,255,.9)); line-height: 0; }
  .asst-run-stage-face svg { display: block; width: 56px; height: 28px; }
  .asst-run-stage-scene { grid-area: scene; min-width: 0; height: 40px; overflow: hidden; color: var(--asst-text-2, rgba(255,255,255,.64)); line-height: 0; }
  .asst-run-stage-scene .asst-scene { width: 120px; height: 40px; }
  .asst-run-stage-line { grid-area: line; display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: 11.5px; line-height: 16px; }
  .asst-run-stage-step { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--asst-text-2, rgba(255,255,255,.64)); }
  /* Waiting on you: calm and dimmed, no gold, "◆ Waiting for your approval" in the warn tone. */
  .asst-run-stage[data-phase="waiting"] { --sc-gold: currentColor; }
  .asst-run-stage[data-phase="waiting"] .asst-run-stage-scene { opacity: .55; }
  .asst-run-stage[data-phase="waiting"] .asst-run-stage-step { color: var(--asst-warn, #ffb74d); }
  .asst-run-stage[data-phase="waiting"] .asst-run-stage-step::before { content: '◆'; margin-right: 5px; font-size: 9px; vertical-align: 1px; }
  /* Settled: the final frame holds, then the stage folds. */
  .asst-run-stage[data-final] { --sc-gold: currentColor; }
  .asst-run-stage[data-final] .asst-run-stage-scene { opacity: .6; }
  .asst-run-stage[data-final="failed"] .asst-run-stage-step { color: var(--asst-live, #ff5252); }
  .asst-run-stage-sweep { position: absolute; left: 0; right: 0; bottom: 0; height: 1.5px; overflow: hidden; pointer-events: none; }
  .asst-run-stage[data-live] .asst-run-stage-sweep::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 38%;
    background: linear-gradient(90deg, transparent, var(--sc-gold), transparent);
    animation: asst-rk-sweep 1.8s cubic-bezier(.45, 0, .55, 1) infinite;
  }
  /* A card the agents tray pointed at. */
  .asst-transcript .asst-run { transition: background-color var(--asst-dur-moderate, 240ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9)), box-shadow var(--asst-dur-moderate, 240ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9)); }
  .asst-run.is-revealed { background: var(--asst-fill-1, rgba(255,255,255,.04)); box-shadow: 0 0 0 1px var(--asst-line-2, rgba(255,255,255,.12)); }

  /* ── Scenes ─────────────────────────────────────────────────────────── */
  /* --sc-gold is set by a holder that neutralizes it (waiting, settled); unset, it is the brand gold.
     The box takes its holder's size (120×40 and 40×20 by default); its still SVG and every layer cover
     it, in the same viewBox; strokes are 1.5 units unless the holder says otherwise (they inherit). */
  .asst-scene { position: relative; display: block; overflow: visible; stroke-width: 1.5; }
  :where(.asst-scene) { width: 120px; height: 40px; }
  :where(.asst-scene.is-mini) { width: 40px; height: 20px; }
  .asst-scene svg { position: absolute; inset: 0; display: block; width: 100%; height: 100%; overflow: visible; }
  .asst-scene .sc-layer { position: absolute; inset: 0; display: block; transform-origin: 0 0; pointer-events: none; }
  .asst-scene .sc-clip { position: absolute; display: block; overflow: hidden; pointer-events: none; }
  .asst-scene .sc-dim { stroke-opacity: .5; }
  .asst-scene .sc-mid { stroke-opacity: .72; }
  .asst-scene .sc-gold { stroke: var(--sc-gold, var(--asst-brand, rgba(255,215,0,.85))); }
  .asst-scene .sc-fill { fill: currentColor; stroke: none; }
  .asst-scene .sc-fill.sc-dim { fill-opacity: .34; }
  .asst-scene .sc-fill.sc-mid { fill-opacity: .55; }
  .asst-scene .sc-fill.sc-gold { fill: var(--sc-gold, var(--asst-brand, rgba(255,215,0,.85))); }
  .asst-scene .sc-shade { fill: var(--sc-shade, #131316); }
  .asst-scene .sc-ring { opacity: 0; }
  /* A layer that only turns or travels gets its compositor layer up front, and only while its scene is
     live and on screen and motion is allowed (no standing hints). Layers that scale are left to the
     browser, which rasterises them at the largest scale they reach (a hint would fix it at rest). */
  @media (prefers-reduced-motion: no-preference) {
    .asst-scene[data-live]:not([data-offscreen] *) :is(.sc-gear-big, .sc-gear-small, .sc-hand, .sc-wrench, .sc-code-scroll, .sc-code-caret, .sc-lens, .sc-lens-mini, .sc-point-browser, .sc-point-computer, .sc-point-mini, .sc-run-dot, .sc-pen, .sc-film, .sc-film-mini, .sc-slide) { will-change: transform; }
  }
  .asst-scene[data-live] .sc-code-scroll { animation: asst-sc-code 6.6s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-code-caret { animation: asst-sc-code-caret 6.6s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-caret { animation: asst-rk-caret 1.06s steps(1) infinite; }
  .asst-scene[data-live] .sc-gear-big { animation: asst-sc-spin 8s linear infinite; }
  .asst-scene[data-live] .sc-gear-small { animation: asst-sc-spin 6s linear infinite reverse; }
  .asst-scene[data-live] .sc-tick { animation: asst-sc-tick 3.2s cubic-bezier(.2, 0, .38, .9) calc(var(--i, 0) * .45s) infinite both; }
  .asst-scene[data-live] .sc-lens { animation: asst-sc-lens 4s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-lens-mini { animation: asst-sc-lens-mini 2.6s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-point-browser { animation: asst-sc-point-browser 3.6s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-point-computer { animation: asst-sc-point-computer 3.6s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-point-mini { animation: asst-sc-point-mini 3.2s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] :is(.sc-ripple-browser, .sc-ripple-computer) { animation: asst-sc-ripple 3.6s cubic-bezier(0, 0, .38, .9) infinite; }
  .asst-scene[data-live] .sc-hand { animation: asst-sc-spin 4s linear infinite; }
  .asst-scene[data-live] .sc-run-dot { animation: asst-sc-run 3s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-shape { animation: asst-sc-shape 3.6s cubic-bezier(.2, 0, .38, .9) calc(var(--i, 0) * .5s) infinite both; }
  .asst-scene[data-live] .sc-pen { animation: asst-sc-pen 3.6s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-tile { animation: asst-sc-develop 3.6s ease-in-out calc(var(--i, 0) * .22s) infinite both; }
  .asst-scene[data-live] .sc-sparkle { animation: asst-sc-twinkle 2.2s ease-in-out infinite; }
  .asst-scene[data-live] .sc-zap { animation: asst-sc-zap 1.1s ease-in-out infinite; }
  .asst-scene[data-live] .sc-film { animation: asst-sc-film 1.4s linear infinite; }
  .asst-scene[data-live] .sc-film-mini { animation: asst-sc-film-mini 1.2s linear infinite; }
  .asst-scene[data-live] .sc-wrench { animation: asst-sc-wrench 1.1s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-spark { animation: asst-sc-spark 1.1s ease-out calc(var(--i, 0) * .08s) infinite both; }
  .asst-scene[data-live] .sc-slide { animation: asst-sc-slide 2.4s cubic-bezier(.45, 0, .55, 1) infinite; }
  .asst-scene[data-live] .sc-dot { animation: asst-sc-dot 1.2s ease-in-out calc(var(--i, 0) * .2s) infinite both; }

  /* ── The agents tray: mini scenes (collapsed) and lanes (open) ──────── */
  /* The minis keep their size: the summary beside them ellipsizes first (narrow panels: their own row, below). */
  .asst-dock-minis { display: flex; flex: none; align-items: center; gap: 4px; }
  .asst-dock-minis:empty { display: none; }
  .asst-dock-mini, .asst-dock-more {
    position: relative;
    isolation: isolate;
    display: inline-grid;
    flex: none;
    place-items: center;
    height: var(--asst-pill-h-sm, 22px);
    padding: 0;
    border: 0;
    border-radius: var(--asst-pill-r-sm, 6px);
    background: var(--asst-fill-1, rgba(255,255,255,.04));
    box-shadow: inset 0 0 0 1px var(--asst-line, rgba(255,255,255,.07));
    color: var(--asst-text-3, rgba(255,255,255,.52));
    font: inherit;
    cursor: pointer;
    transition: background-color var(--asst-dur-fast, 140ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9)), box-shadow var(--asst-dur-fast, 140ms) var(--asst-ease-standard, cubic-bezier(.2,0,.38,.9));
  }
  .asst-dock-mini { width: 38px; }
  .asst-dock-mini .asst-scene { width: 32px; height: 16px; }
  .asst-dock-more { min-width: var(--asst-pill-h-sm, 22px); padding: 0 6px; font-family: var(--asst-mono, 'JetBrains Mono', monospace); font-size: 10.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
  :is(.asst-dock-mini, .asst-dock-more):hover { background: var(--asst-fill-2, rgba(255,255,255,.065)); color: var(--asst-text-2, rgba(255,255,255,.64)); }
  .asst-dock-mini:is([data-phase="working"], [data-phase="queued"], [data-phase="starting"]) { box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring, rgba(255,215,0,.36)); }
  .asst-dock-mini[data-phase="waiting"] { --sc-gold: currentColor; box-shadow: inset 0 0 0 1px var(--asst-pill-warn-ring, rgba(255,183,77,.42)); }
  /* Every tray control reaches 24×24: an invisible margin under the content. */
  :is(.asst-dock-mini, .asst-dock-more, .asst-run-lane)::after { content: ''; position: absolute; inset: -1px; z-index: -1; border-radius: inherit; }
  .asst-run-lane {
    position: relative;
    isolation: isolate;
    grid-column: 2 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 22px;
    margin-top: 2px;
    padding: 0 6px 0 2px;
    border: 0;
    border-radius: var(--asst-pill-r-sm, 6px);
    background: transparent;
    color: var(--asst-text-2, rgba(255,255,255,.64));
    font: inherit;
    font-size: 11.5px;
    text-align: left;
    cursor: pointer;
  }
  .asst-run-lane:hover { background: var(--asst-fill-1, rgba(255,255,255,.04)); }
  .asst-run-lane .asst-scene { flex: none; width: 32px; height: 16px; color: var(--asst-text-3, rgba(255,255,255,.52)); }
  .asst-run-lane[data-phase="waiting"] .asst-scene { --sc-gold: currentColor; opacity: .55; }
  .asst-run-lane-step { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .asst-run-lane[data-phase="waiting"] .asst-run-lane-step { color: var(--asst-warn, #ffb74d); }

  /* ── Wider containers: a larger face and scene (the stage's height is still fixed for the width) ── */
  @container asst (min-width: 361px) {
    .asst-run-stage { grid-template-rows: 50px 16px; column-gap: 12px; }
    .asst-run-stage-face, .asst-run-stage-face svg { width: 64px; height: 32px; }
    .asst-run-stage-scene { height: 50px; }
    .asst-run-stage-scene .asst-scene { width: 150px; height: 50px; }
  }

  /* ── Narrow containers ───────────────────────────────────────────────── */
  @container asst (max-width: 420px) {
    /* The head keeps the title, the summary and Stop all on one row; the minis get the next one, under the title. */
    .asst-dock-head:has(> .asst-dock-minis:not(:empty)) { flex-wrap: wrap; row-gap: 2px; }
    .asst-dock-head:has(> .asst-dock-minis:not(:empty)) > .asst-dock-toggle { flex: 1 1 0; }
    .asst-dock-head:has(> .asst-dock-minis:not(:empty)) > .asst-dock-spacer { display: none; }
    .asst-dock-minis { order: 1; flex-basis: 100%; padding: 0 0 2px 26px; }
  }
  @container asst (max-width: 320px) {
    .asst-run-stage { column-gap: 8px; }
    .asst-dock-minis { padding-left: 8px; }
  }

  /* ── Motion ─────────────────────────────────────────────────────────── */
  ${codeFrames()}
  @keyframes asst-sc-spin { to { transform: rotate(360deg); } }
  @keyframes asst-sc-tick { 0%, 8% { opacity: 0; transform: scale(.4); } 16%, 80% { opacity: 1; transform: scale(1); } 92%, 100% { opacity: 0; transform: scale(1); } }
  @keyframes asst-sc-lens { 0%, 100% { ${sc(FULL, 0, 0)} } 25% { ${sc(FULL, 14, 4)} } 50% { ${sc(FULL, 48, 0)} } 75% { ${sc(FULL, 34, 5)} } }
  @keyframes asst-sc-lens-mini { 0%, 100% { ${sc(MINI, 0, 0)} } 50% { ${sc(MINI, 12, 2)} } }
  ${pointFrames('asst-sc-point-browser', FULL, [92, 29], [26, 16])}
  ${pointFrames('asst-sc-point-computer', FULL, [90, 22.5], [32, 9])}
  ${pointFrames('asst-sc-point-mini', MINI, [29, 13], [12, 8], 'scale(.6)', [24, 48, 74, 98])}
  @keyframes asst-sc-ripple { 0% { opacity: .9; transform: scale(.3); } 16% { opacity: 0; transform: scale(1.5); } 100% { opacity: 0; transform: scale(1.5); } }
  @keyframes asst-sc-run { 0% { opacity: 0; ${sc(FULL, 0, 0)} } 8%, 12% { opacity: 1; ${sc(FULL, 0, 0)} } 45%, 55% { ${sc(FULL, 23, 0)} } 88% { opacity: 1; ${sc(FULL, 46, 0)} } 100% { opacity: 0; ${sc(FULL, 46, 0)} } }
  @keyframes asst-sc-shape { 0%, 6% { opacity: 0; transform: scale(.4); } 16%, 84% { opacity: 1; transform: scale(1); } 94%, 100% { opacity: 0; transform: scale(.9); } }
  @keyframes asst-sc-pen { 0%, 8% { ${sc(FULL, 47, 13)} } 18%, 24% { ${sc(FULL, 73, 13)} } 32%, 84% { ${sc(FULL, 100, 20)} } 100% { ${sc(FULL, 47, 13)} } }
  @keyframes asst-sc-develop { 0% { opacity: .08; } 30%, 82% { opacity: 1; } 100% { opacity: .08; } }
  @keyframes asst-sc-twinkle { 0%, 100% { opacity: .35; transform: scale(.7) rotate(0deg); } 50% { opacity: 1; transform: scale(1.1) rotate(45deg); } }
  @keyframes asst-sc-zap { 0%, 100% { opacity: .45; transform: scale(.92); } 40% { opacity: 1; transform: scale(1.06); } }
  @keyframes asst-sc-film { to { ${sc(win(FILM_WINDOW), -24, 0)} } }
  @keyframes asst-sc-film-mini { to { ${sc(win(FILM_MINI_WINDOW), -12, 0)} } }
  @keyframes asst-sc-wrench { 0%, 100% { transform: rotate(-14deg); } 50% { transform: rotate(16deg); } }
  @keyframes asst-sc-spark { 0%, 38% { opacity: 0; } 50% { opacity: 1; } 72%, 100% { opacity: 0; } }
  @keyframes asst-sc-slide { 0%, 100% { ${sc(FULL, 0, 0)} } 50% { ${sc(FULL, 68, 0)} } }
  @keyframes asst-sc-dot { 0%, 100% { opacity: .3; } 40% { opacity: 1; } }
  body.ui-interacting .asst-scene *,
  body.ui-interacting .asst-run-stage-sweep::after { animation-play-state: paused !important; }
  @media (prefers-reduced-motion: reduce) {
    .asst-run-stage-wrap,
    .asst-run-stage,
    .asst-run-stage *,
    .asst-run-stage *::before,
    .asst-run-stage *::after,
    .asst-scene * { animation: none !important; transition: none !important; }
    /* A frozen sweep would be a stray gold stub: no sweep at all. */
    .asst-run-stage-sweep { display: none; }
  }
`;

/** Add the stage and scene stylesheet once, right after the rack's (else the main assistant styles, else the head's end). */
export function injectSceneStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(SCENE_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = SCENE_STYLE_ID;
  style.textContent = SCENE_CSS;
  const after = doc.getElementById('asst-rack-styles') || doc.getElementById('assistant-panel-styles');
  if (after?.parentNode) after.after(style);
  else doc.head.appendChild(style);
}
