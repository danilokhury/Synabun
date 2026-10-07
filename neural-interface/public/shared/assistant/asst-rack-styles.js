// ═══════════════════════════════════════════
// SynaBun Assistant — activity rack styles
// ═══════════════════════════════════════════
// Injected once by asst-render.js as <style id="asst-rack-styles">, right
// after the main assistant styles. One rack per burst of agent work: a stage
// where the mascot acts out the call it is on (live only), a ledger with one
// row per tool kind, and a receipt once it settles.
//
// Rules: gold only means live (the awake row's ring and tick, the caret, the
// sweep); a rack a card holds (data-state="waiting") drops its gold: "Waiting
// for you" in the warn tone with ◆, no caret, stopped clocks. Motion answers
// events and stays under 300 ms; infinite animations run only on the live
// rack, pause while the UI is dragged (body.ui-interacting) and everything is
// static under prefers-reduced-motion (the sweep is not drawn at all). No
// backdrop blur and no standing compositor-layer hints. Tokens come from
// asst-styles.js, always with a fallback, so the rack renders before (or
// without) them. Focus rings are the panel's one recipe (asst-styles.js), none
// of the rack's own. Every control reaches 24×24 (an ::after margin).

export const RACK_STYLE_ID = 'asst-rack-styles';

export const RACK_CSS = `
  .asst-rack {
    --rk-gold: var(--asst-brand, rgba(255,215,0,.85));
    --rk-gold-line: var(--asst-brand-line, rgba(255,215,0,.32));
    --rk-line: var(--asst-line, rgba(255,255,255,.07));
    --rk-line-2: var(--asst-line-2, rgba(255,255,255,.12));
    --rk-fill-1: var(--asst-fill-1, rgba(255,255,255,.04));
    --rk-fill-2: var(--asst-fill-2, rgba(255,255,255,.065));
    --rk-field: var(--asst-field, rgba(255,255,255,.025));
    --rk-card: var(--asst-card, #0f0f11);
    --rk-text: var(--asst-text, rgba(255,255,255,.9));
    --rk-text-2: var(--asst-text-2, rgba(255,255,255,.64));
    --rk-text-3: var(--asst-text-3, rgba(255,255,255,.52));
    --rk-red: var(--asst-live, #ff5252);
    --rk-warn: var(--asst-warn, #ffb74d);
    --rk-mono: var(--asst-mono, 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace);
    --rk-instant: var(--asst-dur-instant, 80ms);
    --rk-fast: var(--asst-dur-fast, 140ms);
    --rk-moderate: var(--asst-dur-moderate, 240ms);
    --rk-ease: var(--asst-ease-standard, cubic-bezier(.2, 0, .38, .9));
    --rk-pill-h: var(--asst-pill-h-sm, 22px);
    --rk-pill-px: var(--asst-pill-px-sm, 8px);
    --rk-pill-r: var(--asst-pill-r-sm, 6px);
    --rk-pill-r-xs: var(--asst-pill-r-xs, 5px);
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 0fr;
    grid-auto-rows: auto;
    min-width: 0;
    /* Wide hosts: the ledger's ticks stay near their labels. */
    max-width: 560px;
    border-radius: 10px;
    color: var(--rk-text-2);
    font-size: 12.5px;
    line-height: 1.45;
    transition: grid-template-rows var(--rk-moderate) var(--rk-ease);
  }
  .asst-rack.is-staged { grid-template-rows: 1fr; }
  .asst-rack.is-instant, .asst-rack.is-instant > .asst-rack-stage { transition: none; }
  .asst-rack [hidden] { display: none !important; }
  /* The live rack is the indicator: no "Working…" dots under it. */
  .asst-rack.is-live + .asst-working,
  .asst-rack.is-live + .asst-msg.asst-folding + .asst-working { display: none; }
  /* The live card: a faint panel with a ring; the sweep is its only gold. */
  .asst-rack.is-staged {
    background: var(--rk-card);
    box-shadow: inset 0 0 0 1px var(--rk-line);
  }
  .asst-rack[data-state="settled"] {
    content-visibility: auto;
    contain-intrinsic-size: auto 30px;
  }
  /* content-visibility clips paint to the box: a folded rack takes in the receipt's 8px overhang. */
  .asst-rack[data-state="settled"]:not(.is-staged) { margin-inline: -8px; padding-inline: 8px; }

  /* ── Stage: the mascot, a caption and the bubble ─────────────────── */
  .asst-rack-stage {
    grid-row: 1;
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas: "face caption" "face bubble";
    align-items: center;
    column-gap: 8px;
    row-gap: 6px;
    min-height: 0;
    overflow: hidden;
    padding: 0 14px;
    visibility: hidden;
    transition: padding var(--rk-moderate) var(--rk-ease), visibility 0s linear var(--rk-moderate);
  }
  .asst-rack.is-staged > .asst-rack-stage {
    padding: 14px 14px 12px;
    visibility: visible;
    transition: padding var(--rk-moderate) var(--rk-ease), visibility 0s;
  }
  .asst-rack-face { grid-area: face; align-self: center; color: var(--rk-text); line-height: 0; }
  .asst-rack-face svg { display: block; width: 72px; height: 36px; }
  .asst-rack-caption {
    grid-area: caption;
    align-self: end;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: var(--rk-text-2);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .asst-rack-caption:empty { display: none; }
  .asst-rack-caption:empty ~ .asst-bubble { grid-row: 1 / span 2; }

  .asst-bubble {
    grid-area: bubble;
    position: relative;
    justify-self: start;
    align-self: start;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: baseline;
    column-gap: 7px;
    row-gap: 1px;
    max-width: calc(100% - 8px);
    min-width: 0;
    margin-left: 8px;
    padding: 6px 11px 7px;
    border-radius: 3px 12px 12px 12px;
    background: var(--rk-fill-1);
    box-shadow: inset 0 0 0 1px var(--rk-line);
  }
  /* The tail: an 8px notch on the bubble's edge pointing at the mascot (left beside it, up under it). */
  .asst-bubble::before {
    content: '';
    position: absolute;
    left: -5.5px;
    top: 7px;
    width: 11px;
    height: 11px;
    background: var(--rk-fill-1);
    box-shadow: inset 1px -1px 0 var(--rk-line);
    clip-path: polygon(0 0, 0 100%, 100% 100%);
    transform: rotate(45deg);
    pointer-events: none;
  }
  .asst-bubble-verb { color: var(--rk-text-2); font-size: 12px; font-weight: 500; line-height: 1.5; white-space: nowrap; }
  .asst-bubble[data-state="running"] .asst-bubble-verb { color: var(--rk-gold); }
  /* A card holds the call: no gold, no caret, the clock stopped (asst-render.js), "◆ Waiting for you". */
  .asst-bubble[data-state="waiting"] .asst-bubble-verb { color: var(--rk-warn); }
  .asst-bubble[data-state="waiting"] .asst-bubble-verb::before { content: '◆'; margin-right: 5px; font-size: 9px; vertical-align: 1px; }
  .asst-bubble-subject {
    --rk-cut: middle; /* where asst-render.js cuts a long subject: the middle; the head on a narrow stage */
    position: relative;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    border-radius: 4px;
    color: var(--rk-text);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  .asst-bubble-subject.is-mono { font-family: var(--rk-mono); font-size: 11.5px; }
  .asst-bubble-subject.is-muted { color: var(--rk-text-3); }
  .asst-bubble-subject[aria-expanded="true"] { -webkit-line-clamp: 6; cursor: text; user-select: text; }
  .asst-bubble-subject .is-dim { color: var(--rk-text-3); }
  .asst-bubble-subject .is-strong { color: var(--rk-text); font-weight: 600; }
  /* Streaming thinking fades in from its cut edge. */
  .asst-bubble[data-kind="think"][data-state="running"] .asst-bubble-subject {
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 12px);
    mask-image: linear-gradient(90deg, transparent, #000 12px);
  }
  .asst-bubble-caret {
    display: none;
    width: 6px;
    height: 12px;
    margin-left: 3px;
    vertical-align: -2px;
    background: var(--rk-gold);
  }
  .asst-bubble[data-state="running"] .asst-bubble-caret { display: inline-block; animation: asst-rk-caret 1.06s steps(1) infinite; }
  .asst-bubble-meta {
    grid-column: 2;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    color: var(--rk-text-3);
    font-size: 11px;
    line-height: 1.5;
    font-variant-numeric: tabular-nums;
  }
  .asst-bubble-meta:empty { display: none; }
  .asst-bubble-num { white-space: nowrap; }
  .asst-bubble-err {
    grid-column: 1 / -1;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    min-width: 0;
    overflow: hidden;
    color: var(--rk-red);
    font-family: var(--rk-mono);
    font-size: 11px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .asst-bubble-err::before { content: '✕'; margin-right: 6px; font-family: inherit; }
  .asst-bubble-copy {
    position: relative;
    isolation: isolate;
    grid-column: 1 / -1;
    justify-self: start;
    height: var(--rk-pill-h);
    margin-top: 4px;
    padding: 0 var(--rk-pill-px);
    border: 0;
    border-radius: var(--rk-pill-r);
    background: var(--rk-fill-2);
    color: var(--rk-text-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .asst-bubble-copy:hover { color: var(--rk-text); }
  .asst-odo { display: inline-flex; font-variant-numeric: tabular-nums; white-space: pre; }
  .asst-odo-d { display: inline-block; }

  .asst-rack-sweep { position: absolute; left: 0; right: 0; bottom: 0; height: 1.5px; overflow: hidden; pointer-events: none; }
  .asst-rack.is-live:not([data-state="waiting"]) > .asst-rack-stage > .asst-rack-sweep::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 38%;
    background: linear-gradient(90deg, transparent, var(--rk-gold), transparent);
    animation: asst-rk-sweep 1.8s cubic-bezier(.45, 0, .55, 1) infinite;
  }

  /* ── Receipt: the settled rack (or a live single call) as one sm capsule ──
     glyph half (a 32×16 still cameo) · seam · the sentence (up to two lines),
     the failed count, the clock and the rack's one chevron; sm corners (6px),
     a rounded rectangle at one line or two. */
  .asst-rack-receipt {
    grid-row: 2;
    justify-self: start;
    position: relative;
    isolation: isolate;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    min-width: 0;
    min-height: var(--rk-pill-h);
    margin: 3px 0;
    padding: 2px 9px 2px 0;
    border: 0;
    border-radius: var(--rk-pill-r);
    background: var(--rk-fill-1);
    box-shadow: inset 0 0 0 1px var(--rk-line);
    color: var(--rk-text-2);
    font: inherit;
    font-size: 12.5px;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--rk-fast) var(--rk-ease), box-shadow var(--rk-fast) var(--rk-ease);
  }
  .asst-rack-receipt:hover { background: var(--rk-fill-2); box-shadow: inset 0 0 0 1px var(--rk-line-2); }
  .asst-rack.is-staged > .asst-rack-receipt,
  .asst-rack.is-live.is-nested > .asst-rack-receipt { display: none; }
  .asst-rack-receipt-face { flex: none; align-self: stretch; display: inline-flex; align-items: center; justify-content: center; width: 46px; box-shadow: inset -1px 0 0 var(--rk-line); color: var(--rk-text-2); line-height: 0; }
  .asst-rack-receipt-face svg { display: block; width: 32px; height: 16px; }
  .asst-rack-receipt-text {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .asst-rack-receipt-verb { color: var(--rk-text-2); font-weight: 500; }
  .asst-rack.is-live .asst-rack-receipt-verb { color: var(--rk-gold); }
  .asst-rack-receipt-subject { color: var(--rk-text); }
  .asst-rack-receipt-subject.is-mono { font-family: var(--rk-mono); font-size: 11.5px; }
  .asst-rack-receipt-failed { flex: none; display: inline-flex; align-items: center; gap: 4px; color: var(--rk-red); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .asst-rack-receipt-failed::before { content: '✕'; font-size: 10px; }
  .asst-rack-receipt-clock { flex: none; color: var(--rk-text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .asst-rack-receipt-clock:empty { display: none; }
  .asst-rack-chev { flex: none; color: var(--rk-text-3); transition: transform var(--rk-fast) var(--rk-ease); }
  .asst-rack-receipt[aria-expanded="true"] .asst-rack-chev { transform: rotate(90deg); }
  .asst-still-glyph { color: var(--rk-text-3); font-family: var(--rk-mono); font-size: 11px; font-weight: 600; line-height: 1; }

  /* ── By kind / Timeline ──────────────────────────────────────────── */
  .asst-rack-view { grid-row: 3; display: none; gap: 2px; margin: 4px 0 2px 21px; }
  .asst-rack.is-open:not(.is-single) > .asst-rack-view { display: flex; }
  .asst-rack-view button {
    position: relative;
    isolation: isolate;
    height: var(--rk-pill-h);
    padding: 0 var(--rk-pill-px);
    border: 0;
    border-radius: var(--rk-pill-r);
    background: none;
    color: var(--rk-text-3);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .asst-rack-view button:hover { color: var(--rk-text); }
  .asst-rack-view button[aria-pressed="true"] { background: var(--rk-fill-2); color: var(--rk-text); }

  /* ── Ledger: one row per kind ───────────────────────────────────── */
  .asst-rack-ledger { grid-row: 4; display: none; flex-direction: column; gap: 1px; min-width: 0; margin: 0; padding: 0; list-style: none; }
  .asst-rack.is-staged > .asst-rack-ledger { display: flex; padding: 2px 6px 6px; }
  .asst-rack.is-live.is-nested > .asst-rack-ledger,
  .asst-rack.is-open > .asst-rack-ledger { display: flex; }
  .asst-rack.is-open:not(.is-staged) > .asst-rack-ledger { margin: 2px 0 2px 7px; padding-left: 8px; border-left: 1px solid var(--rk-line); }
  .asst-rack.is-open[data-view="time"] > .asst-rack-ledger { display: none; }
  /* Settled and folded, a Computer row still shows its screenshots. */
  .asst-rack[data-state="settled"]:not(.is-open) > .asst-rack-ledger:has(> .asst-station[data-kind="computer"]) { display: flex; }
  .asst-rack[data-state="settled"]:not(.is-open) > .asst-rack-ledger > .asst-station:not([data-kind="computer"]),
  .asst-rack[data-state="settled"]:not(.is-open) > .asst-rack-ledger > .asst-station > .asst-station-hdr { display: none; }
  .asst-rack[data-state="settled"]:not(.is-open) .asst-station[data-kind="computer"] > .asst-station-log { margin-left: 0; border-left: 0; padding-left: 0; }
  /* One call: the receipt is the row; opened, the call shows straight away. */
  .asst-rack.is-single.is-open:not(.is-staged) > .asst-rack-ledger > .asst-station > .asst-station-hdr { display: none; }
  .asst-rack.is-single.is-open:not(.is-staged) > .asst-rack-ledger > .asst-station > .asst-station-log { display: flex !important; margin-left: 0; padding-left: 0; border-left: 0; }

  .asst-station { min-width: 0; list-style: none; }
  .asst-station-hdr {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--rk-text-2);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  /* A row opens (hover fill, the pointer, aria-expanded); the rack's receipt keeps the one chevron. */
  .asst-station-hdr:hover { background: var(--rk-fill-1); }
  .asst-station-hdr[aria-expanded="true"] { background: var(--rk-fill-1); }
  .asst-station[data-state="awake"] > .asst-station-hdr { box-shadow: inset 0 0 0 1px var(--rk-gold-line); }
  .asst-station[data-state="waiting"] > .asst-station-hdr { box-shadow: inset 0 0 0 1px var(--rk-line-2); }
  /* The glyph slot: the kind's prop alone (rows differ at a squint); the awake row wears the eyes. */
  .asst-station-face { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 16px; color: var(--rk-text-2); line-height: 0; }
  .asst-station-face svg { display: block; width: 28px; height: 14px; }
  .asst-station-face svg.asst-prop-glyph { width: 24px; height: 16px; }
  .asst-station[data-state="awake"] .asst-station-face { color: var(--rk-text); }
  .asst-station-label { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--rk-text-2); font-weight: 500; }
  .asst-station[data-state="awake"] .asst-station-label { color: var(--rk-text); }
  /* The aggregate never truncates (the failed count is its point): the ticks give way first. */
  .asst-station-agg { flex: 0 0 auto; white-space: nowrap; color: var(--rk-text-3); }
  .asst-station[data-state="failed"] .asst-station-agg { color: var(--rk-text-2); }
  .asst-station-ticks { flex: 0 1 auto; display: flex; align-items: center; justify-content: flex-end; gap: 3px; min-width: 0; margin-left: auto; overflow: hidden; }
  .asst-station-time { flex: none; min-width: 3.4em; color: var(--rk-text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; text-align: right; }
  .asst-station-time:empty { min-width: 0; }
  /* One call on a live stage: the bubble carries its time. */
  .asst-rack.is-single.is-staged .asst-station-time { display: none; }

  /* Ticks: one per call. Running bar (gold on the awake row), done bar, ✕ failed, ○ neutral,
     a waiting call neutral; a plan row's ticks are its steps (done filled, to do hollow). */
  .asst-tick { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 4px; height: 12px; border-radius: 2px; background: var(--rk-text-3); font-size: 10px; line-height: 1; }
  .asst-tick[data-state="running"] { background: var(--rk-gold); }
  .asst-rack[data-state="settled"] .asst-tick[data-state="running"] { background: var(--rk-line-2); }
  .asst-rack.is-live .asst-tick[data-state="running"] { animation: asst-rk-tick 1.1s ease-in-out infinite; }
  .asst-tick[data-state="waiting"] { background: var(--rk-text-3); }
  .asst-tick[data-state="pending"] { background: none; box-shadow: inset 0 0 0 1.5px var(--rk-text-3); }
  .asst-tick:is([data-state="error"], [data-state="neutral"]) { width: 9px; background: none; }
  .asst-tick[data-state="error"] { color: var(--rk-red); }
  .asst-tick[data-state="neutral"] { color: var(--rk-text-3); }
  .asst-tick-more { flex: none; color: var(--rk-text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
  .asst-tick-more.is-narrow { display: none; }

  /* Subagent activity: a compact strip per agent inside the Subagents row. */
  .asst-station-sub { display: flex; flex-direction: column; gap: 2px; margin: 0 8px 4px 46px; }
  .asst-station-sub:empty { display: none; }
  .asst-sub { display: flex; align-items: center; gap: 8px; min-width: 0; height: 18px; font-size: 11.5px; }
  .asst-sub-label { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--rk-text-3); }
  .asst-sub-ticks { flex: 1 1 auto; display: flex; align-items: center; gap: 2px; min-width: 0; overflow: hidden; }
  .asst-sub-ticks .asst-tick { width: 3px; height: 9px; }
  .asst-sub-ticks .asst-tick:is([data-state="error"], [data-state="neutral"]) { width: 8px; font-size: 9px; }

  /* ── Calls inside a row ─────────────────────────────────────────── */
  .asst-station-log { display: flex; flex-direction: column; gap: 6px; min-width: 0; margin: 2px 0 8px 22px; padding: 2px 0 2px 14px; border-left: 1px solid var(--rk-line); list-style: none; }
  .asst-rack .asst-tool { min-width: 0; list-style: none; font-size: 12.5px; }
  .asst-rack .asst-tool-hdr {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 22px;
    margin: 0;
    padding: 0;
    border-radius: 0;
    background: none;
    color: var(--rk-text-2);
    cursor: default;
    user-select: text;
  }
  .asst-rack .asst-tool-hdr:hover { background: none; }
  .asst-tool-mark { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 10px; font-size: 10px; line-height: 1; color: var(--rk-text-3); }
  .asst-tool-mark::before { content: ''; width: 4px; height: 10px; border-radius: 2px; background: currentColor; }
  .asst-tool[data-state="running"] > .asst-tool-hdr > .asst-tool-mark { color: var(--rk-gold); }
  .asst-rack[data-state="settled"] .asst-tool[data-state="running"] > .asst-tool-hdr > .asst-tool-mark { color: var(--rk-line-2); }
  .asst-tool[data-state="error"] > .asst-tool-hdr > .asst-tool-mark { color: var(--rk-red); }
  .asst-tool[data-state="error"] > .asst-tool-hdr > .asst-tool-mark::before { content: '✕'; width: auto; height: auto; background: none; }
  .asst-tool[data-state="neutral"] > .asst-tool-hdr > .asst-tool-mark::before { content: '○'; width: auto; height: auto; background: none; }
  .asst-rack .asst-tool-name { flex: none; color: var(--rk-text); font-weight: 500; }
  .asst-station:is([data-kind="shell"], [data-kind="read"], [data-kind="edit"], [data-kind="search"], [data-kind="plan"], [data-kind="subagent"]) .asst-tool-name { display: none; }
  .asst-rack .asst-tool-detail { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--rk-text-2); font-family: inherit; font-size: 12px; }
  .asst-rack .asst-tool-detail.is-mono { font-family: var(--rk-mono); font-size: 11.5px; }
  .asst-tool-detail .is-dim { color: var(--rk-text-3); }
  .asst-tool-detail .is-strong { color: var(--rk-text); }
  .asst-tool-meta { flex: none; color: var(--rk-text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .asst-tool-meta:empty { display: none; }
  .asst-rack .asst-tool-state { flex: none; color: var(--rk-text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .asst-rack .asst-tool[data-state="error"] .asst-tool-state { color: var(--rk-red); }
  .asst-tool-time { flex: none; min-width: 3.4em; color: var(--rk-text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; text-align: right; }
  .asst-tool-time:empty { display: none; }
  .asst-rack .asst-tool-body { display: block; margin: 4px 0 2px 18px; padding: 0; border: 0; }
  .asst-rack .asst-station[data-kind="computer"]:not(.is-open) .asst-tool-body { display: none; }
  .asst-rack .asst-computer-frame { margin: 4px 0 2px 18px; }

  .asst-tool-sec + .asst-tool-sec { margin-top: 6px; }
  .asst-tool-sec-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .asst-rack .asst-tool-label { margin: 0; color: var(--rk-text-3); font-size: 11px; letter-spacing: 0; text-transform: none; }
  .asst-rack .asst-tool-section {
    max-height: none;
    overflow-x: auto;
    margin: 0;
    padding: 6px 9px;
    border: 1px solid var(--rk-line);
    border-radius: 4px;
    background: var(--rk-field);
    color: var(--rk-text-2);
    font-family: var(--rk-mono);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .asst-copy, .asst-tool-more, .asst-rack .asst-reveal {
    position: relative;
    isolation: isolate;
    height: 20px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--rk-pill-r-xs);
    background: none;
    color: var(--rk-text-3);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .asst-copy { margin-left: auto; }
  .asst-rack .asst-reveal { box-shadow: inset 0 0 0 1px var(--rk-line); }
  .asst-tool-sec-head > .asst-reveal { margin-left: auto; }
  .asst-copy:hover, .asst-tool-more:hover, .asst-rack .asst-reveal:hover { background: var(--rk-fill-1); color: var(--rk-text); }
  .asst-rack .asst-reveal[aria-pressed="true"] { color: var(--rk-text-2); }
  .asst-tool-more { margin-top: 2px; font-variant-numeric: tabular-nums; }
  .asst-tool-full { margin-left: 4px; }
  /* Every control here reaches 24×24: an invisible margin under the content. */
  :is(.asst-copy, .asst-tool-more, .asst-bubble-copy, .asst-rack-view button, .asst-rack-receipt)::after,
  .asst-rack .asst-reveal::after { content: ''; position: absolute; inset: -3px -2px; z-index: -1; border-radius: inherit; }

  .asst-diff { padding: 4px 0 !important; }
  .asst-diff-line { display: flex; min-width: 0; padding: 0 9px 0 0; }
  .asst-diff-sign { flex: none; width: 18px; color: var(--rk-text-3); text-align: center; user-select: none; }
  .asst-diff-line[data-sign="+"] { background: color-mix(in srgb, #3fb950 12%, transparent); }
  .asst-diff-line[data-sign="-"] { background: color-mix(in srgb, var(--rk-red) 11%, transparent); }
  .asst-diff-line[data-sign="@"] { color: var(--rk-text-3); }
  .asst-diff-text { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }

  .asst-plan-list { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; font-size: 12.5px; }
  .asst-plan-item { display: flex; align-items: baseline; gap: 8px; color: var(--rk-text-2); }
  .asst-plan-item::before { content: '○'; flex: none; width: 12px; color: var(--rk-text-3); text-align: center; }
  .asst-plan-item[data-status="completed"] { color: var(--rk-text-3); text-decoration: line-through; text-decoration-color: var(--rk-line-2); }
  .asst-plan-item[data-status="completed"]::before { content: '✓'; }
  .asst-plan-item[data-status="in_progress"] { color: var(--rk-text); }
  .asst-plan-item[data-status="in_progress"]::before { content: '◐'; color: var(--rk-text-2); }

  .asst-rack .asst-think .asst-thinking-content { max-height: none; }
  .asst-rack .asst-think .asst-tool-more { margin-left: 17px; }
  .asst-rack .asst-agent-feed { margin: 6px 0 2px 18px; }

  /* ── Timeline: one grid, verb (right-aligned) · subject · duration ──
     No offset column: a time on the right is always how long a call took. */
  .asst-rack-timeline { grid-row: 5; display: none; flex-direction: column; gap: 3px; margin: 2px 0 2px 7px; padding: 2px 0 2px 10px; border-left: 1px solid var(--rk-line); list-style: none; }
  .asst-rack.is-open[data-view="time"] > .asst-rack-timeline { display: flex; }
  .asst-tl { display: grid; grid-template-columns: 5.5em minmax(0, 1fr) auto; align-items: baseline; column-gap: 8px; min-width: 0; font-size: 12px; }
  .asst-tl-verb { color: var(--rk-text-3); font-weight: 500; text-align: right; overflow-wrap: anywhere; }
  .asst-tl-what { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .asst-tl-subject { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--rk-text-2); }
  .asst-tl-subject.is-mono { font-family: var(--rk-mono); font-size: 11.5px; }
  .asst-tl[data-state="error"] .asst-tl-subject { color: var(--rk-text); }
  .asst-tl-state { flex: none; color: var(--rk-text-3); font-size: 11px; white-space: nowrap; }
  .asst-tl[data-state="error"] .asst-tl-state { color: var(--rk-red); }
  .asst-tl[data-state="error"] .asst-tl-state::before { content: '✕ '; }
  .asst-tl[data-type="said"] .asst-tl-said { grid-column: 2 / -1; min-width: 0; color: var(--rk-text-2); font-style: italic; }
  .asst-tl-dur { color: var(--rk-text-3); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }

  /* Announcements for screen readers only. */
  .asst-rack-status, .asst-rack-alert {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* ── Narrow containers ─────────────────────────────────────────────
     ≤400: the face (still 72×36) sits over the bubble, whose notch points up
     at it; the rows keep the last 12 ticks and drop the time (the receipt and
     the Timeline carry it). ≤320: only the bubble's meta goes; its subject
     wraps to two lines, cut from the head so the file name survives, and the
     error keeps two lines. Under a 300px container the face is 56×28. */
  @container asst (max-width: 400px) {
    .asst-rack-stage { grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "face caption" "bubble bubble"; column-gap: 8px; }
    .asst-rack.is-staged > .asst-rack-stage { padding: 10px 10px 10px; }
    .asst-rack-caption { align-self: center; }
    .asst-rack-caption:empty ~ .asst-bubble { grid-row: auto; }
    .asst-bubble { justify-self: stretch; max-width: 100%; margin: 4px 0 0; border-radius: 3px 12px 12px 12px; }
    .asst-bubble::before { left: 30px; top: -5.5px; box-shadow: inset 1px 1px 0 var(--rk-line); clip-path: polygon(0 100%, 0 0, 100% 0); }
    .asst-station-hdr { gap: 8px; padding: 0 6px; }
    .asst-station-time { display: none; }
    .asst-tick.is-old { display: none; }
    .asst-tick-more.is-narrow { display: inline; }
    .asst-tick-more.is-wide { display: none; }
    .asst-station-log { margin-left: 12px; }
    .asst-station-sub { margin-left: 12px; }
  }
  @container asst (max-width: 320px) {
    .asst-bubble { padding: 5px 9px 6px; }
    .asst-bubble-subject { --rk-cut: head; }
    .asst-bubble-meta { display: none; }
  }
  @container asst (max-width: 299px) {
    .asst-rack-face svg { width: 56px; height: 28px; }
    .asst-bubble::before { left: 22px; }
  }

  /* ── Motion ─────────────────────────────────────────────────────── */
  @keyframes asst-rk-caret { 0% { opacity: 1; } 50% { opacity: 0; } }
  @keyframes asst-rk-sweep { from { transform: translateX(-100%); } to { transform: translateX(270%); } }
  @keyframes asst-rk-tick { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  body.ui-interacting .asst-rack *,
  body.ui-interacting .asst-rack *::before,
  body.ui-interacting .asst-rack *::after { animation-play-state: paused !important; }
  @media (prefers-reduced-motion: reduce) {
    .asst-rack,
    .asst-rack *,
    .asst-rack *::before,
    .asst-rack *::after { animation: none !important; transition: none !important; }
    /* A frozen sweep would be a stray gold stub: no sweep at all. */
    .asst-rack-sweep { display: none; }
  }
`;

/** Add the rack stylesheet once, right after the main assistant styles when they are in the page. */
export function injectRackStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(RACK_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = RACK_STYLE_ID;
  style.textContent = RACK_CSS;
  const main = doc.getElementById('assistant-panel-styles');
  if (main?.parentNode) main.after(style);
  else doc.head.appendChild(style);
}
