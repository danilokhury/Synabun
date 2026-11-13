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
// - the scenes (asst-scenes.js): approved GIFs with PNG resting frames, running
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
export const SCENE_STYLE_ID = 'asst-scene-styles';

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
  .asst-run-stage-face svg { display: block; width: 112px; height: 56px; }
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
  .asst-scene { position: relative; display: block; aspect-ratio: 3 / 1; }
  :where(.asst-scene) { width: 120px; height: 40px; }
  :where(.asst-scene.is-mini) { width: 40px; height: calc(40px / 3); }
  .asst-scene-art { display: block; width: 100%; height: 100%; object-fit: contain; }

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
  .asst-dock-mini .asst-scene { width: 32px; height: calc(32px / 3); }
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
  .asst-run-lane .asst-scene { flex: none; width: 32px; height: calc(32px / 3); color: var(--asst-text-3, rgba(255,255,255,.52)); }
  .asst-run-lane[data-phase="waiting"] .asst-scene { --sc-gold: currentColor; opacity: .55; }
  .asst-run-lane-step { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .asst-run-lane[data-phase="waiting"] .asst-run-lane-step { color: var(--asst-warn, #ffb74d); }

  /* ── Wider containers: a larger face and scene (the stage's height is still fixed for the width) ── */
  @container asst (min-width: 361px) {
    .asst-run-stage { grid-template-rows: 50px 16px; column-gap: 12px; }
    .asst-run-stage-face, .asst-run-stage-face svg { width: 112px; height: 56px; }
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
