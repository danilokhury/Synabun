// ═══════════════════════════════════════════
// SynaBun Assistant — the cards the mascot presents: styles
// ═══════════════════════════════════════════
// Injected once as <style id="asst-ask-styles">, right after the main
// assistant styles (asst-styles.js), like the rack's sheet. Two kinds of card
// share it (asst-ask.js): the follow-ups card under a finished message and the
// question cards a brain asks with (.asst-control.asst-ask). Both open on a
// stage, the rack's: the mascot (64×32; 48×24 at 400px, 40×20 at 320px) beside
// what it says, in a bubble whose notch points at it; the answers run full
// width under it: option rows with a number key, gold once picked. Gold means
// picked (or live) only; red never appears here. No keyframes and no infinite
// motion: the rig moves on the shared ticker, the rows move by transitions,
// and prefers-reduced-motion drops those too. Focus rings are the panel's one
// recipe (asst-styles.js). Tokens come from asst-styles.js.

export const ASK_STYLE_ID = 'asst-ask-styles';

export const ASK_CSS = `
  .asst-ask {
    --ask-face-col: 68px;
    --ask-face-w: 64px;
    --ask-face-h: 32px;
    --ask-ring: var(--asst-line);
  }
  .asst-ask-face { display: flex; flex: 0 0 var(--ask-face-col); justify-content: center; align-self: flex-start; min-width: 0; padding-top: 2px; color: var(--asst-text); line-height: 0; }
  .asst-ask-face svg { display: block; width: var(--ask-face-w); height: var(--ask-face-h); overflow: visible; }
  /* The stage: the face and its first bubble, side by side. */
  .asst-ask-stage { display: flex; align-items: flex-start; gap: 2px; min-width: 0; }

  /* What the mascot says: a bubble whose notch points at it (the rack's bubble). */
  .asst-ask-bubble {
    position: relative;
    flex: 0 1 auto;
    align-self: flex-start;
    max-width: calc(100% - 6px);
    min-width: 0;
    margin-left: 6px;
    padding: 7px 11px 8px;
    border-radius: 3px 12px 12px 12px;
    background: var(--asst-fill-1);
    box-shadow: inset 0 0 0 1px var(--asst-line);
    color: var(--asst-text);
    overflow-wrap: anywhere;
  }
  .asst-ask-bubble.is-lead::before {
    content: '';
    position: absolute;
    left: -5.5px;
    top: 9px;
    width: 11px;
    height: 11px;
    background: var(--asst-fill-1);
    box-shadow: inset 1px -1px 0 var(--asst-line);
    clip-path: polygon(0 0, 0 100%, 100% 100%);
    transform: rotate(45deg);
    pointer-events: none;
  }
  .asst-ask-title { font-size: 13px; font-weight: 500; line-height: 1.45; }
  .asst-ask-hint { margin-top: 2px; color: var(--asst-text-3); font-size: 11.5px; line-height: 1.4; }

  /* Answers: one row each, its number key first; picked rows are gold. */
  .asst-ask-options { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .asst-ask .asst-ask-option {
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    min-height: 36px;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--asst-r-field);
    background: var(--asst-fill-1);
    box-shadow: inset 0 0 0 1px var(--asst-line);
    color: var(--asst-text);
    font: inherit;
    font-size: 13px;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;
    transition:
      background-color var(--asst-dur-fast) var(--asst-ease-standard),
      box-shadow var(--asst-dur-fast) var(--asst-ease-standard),
      opacity var(--asst-dur-fast) var(--asst-ease-standard),
      transform var(--asst-dur-instant) var(--asst-ease-standard);
  }
  .asst-ask .asst-ask-option:hover:not(:disabled) { background: var(--asst-fill-2); box-shadow: inset 0 0 0 1px var(--asst-line-2); }
  .asst-ask .asst-ask-option:active:not(:disabled) { transform: translateY(1px); }
  .asst-ask .asst-ask-option:disabled { cursor: default; }
  .asst-ask .asst-ask-option:is(.selected, .chosen) { background: var(--asst-pill-on-fill); box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring); }
  .asst-ask-key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: var(--asst-pill-h-xs);
    height: var(--asst-pill-h-xs);
    border-radius: var(--asst-pill-r-xs);
    background: var(--asst-fill-1);
    box-shadow: inset 0 0 0 1px var(--asst-line-2);
    color: var(--asst-text-2);
    font-family: var(--asst-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    transition: background-color var(--asst-dur-fast) var(--asst-ease-standard), color var(--asst-dur-fast) var(--asst-ease-standard);
  }
  .asst-ask .asst-ask-option:is(.selected, .chosen) .asst-ask-key { background: var(--asst-brand); box-shadow: none; color: var(--asst-ink); }
  .asst-ask-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
  .asst-ask-label { font-weight: 500; overflow-wrap: anywhere; }
  .asst-ask-desc { color: var(--asst-text-3); font-size: 11.5px; overflow-wrap: anywhere; }
  .asst-ask-badge {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    height: var(--asst-pill-h-xs);
    padding: 0 var(--asst-pill-px-xs);
    border-radius: var(--asst-pill-r-xs);
    background: var(--asst-fill-1);
    box-shadow: inset 0 0 0 1px var(--asst-line-2);
    color: var(--asst-text-2);
    font-size: 10.5px;
    font-weight: 500;
    white-space: nowrap;
  }
  .asst-ask-go { flex-shrink: 0; color: var(--asst-text-4); font-size: 12px; transition: color var(--asst-dur-fast) var(--asst-ease-standard); }
  .asst-ask .asst-ask-option:is(:hover, :focus-visible):not(:disabled) .asst-ask-go { color: var(--asst-text); }
  .asst-ask[data-state="answered"] .asst-ask-option:not(.chosen) { opacity: .45; }

  /* A typed answer: the field the composer's own look, Enter sends it. */
  .asst-ask-answer { display: flex; gap: 6px; min-width: 0; }
  .asst-ask .asst-ask-input {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--asst-r-field);
    outline: none;
    background: var(--asst-field);
    box-shadow: inset 0 0 0 1px var(--asst-line);
    color: var(--asst-text);
    font: inherit;
    font-size: 12.5px;
    resize: none;
  }
  .asst-ask .asst-ask-input:focus { box-shadow: inset 0 0 0 1px var(--asst-line-2); }
  .asst-ask .asst-ask-input::placeholder { color: var(--asst-text-3); opacity: 1; }

  .asst-ask-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
  .asst-ask-actions .asst-btn { max-width: 100%; }
  /* A confirm's choice stays clear while the mascot hops; the other one dims like any spent button. */
  .asst-ask .asst-ask-actions .asst-btn.chosen:disabled { opacity: 1; }
  .asst-ask-actions .asst-btn-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .asst-ask .asst-ask-other { background: transparent; box-shadow: none; color: var(--asst-text-3); }
  .asst-ask .asst-ask-other:hover:not(:disabled) { background: var(--asst-fill-1); box-shadow: none; color: var(--asst-text); }
  /* The keys, said once focus is in the card. */
  .asst-ask-keys { display: none; margin-left: auto; color: var(--asst-text-3); font-size: 11px; line-height: 1.4; }
  .asst-ask:focus-within .asst-ask-keys { display: inline; }

  /* ── The follow-ups card: open, the mascot presents; answered or left behind, one line ── */
  .asst-followups.asst-ask {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 560px;
    min-width: 0;
    margin-top: 10px;
    padding: 12px 14px;
    border-radius: var(--asst-r-card);
    background: var(--asst-card);
    box-shadow: inset 0 0 0 1px var(--ask-ring), var(--asst-card-hi);
    color: var(--asst-text);
    font-size: 13px;
  }
  .asst-followups.asst-ask[data-style="question"] { --ask-ring: color-mix(in srgb, var(--asst-info) 30%, transparent); }
  .asst-ask-receipt { display: none; }
  .asst-followups.asst-ask:not([data-state="open"]):not([data-phase="sending"]) {
    --ask-face-col: 28px;
    --ask-face-w: 28px;
    --ask-face-h: 14px;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    width: fit-content;
    max-width: min(100%, 560px);
    min-height: var(--asst-pill-h-md);
    padding: 4px 10px 4px 8px;
    border-radius: var(--asst-pill-r-md);
    background: var(--asst-fill-1);
    box-shadow: inset 0 0 0 1px var(--asst-line);
  }
  .asst-followups.asst-ask:not([data-state="open"]):not([data-phase="sending"]) > .asst-ask-stage { display: contents; }
  .asst-followups.asst-ask:not([data-state="open"]):not([data-phase="sending"]) .asst-ask-face { padding: 0; align-self: center; }
  .asst-followups.asst-ask:not([data-state="open"]):not([data-phase="sending"]) :is(.asst-ask-bubble, .asst-ask-options, .asst-ask-answer, .asst-ask-actions) { display: none; }
  .asst-followups.asst-ask:not([data-state="open"]):not([data-phase="sending"]) .asst-ask-receipt {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    min-width: 0;
    color: var(--asst-text-3);
    font-size: 12px;
    line-height: 1.4;
  }
  .asst-followups.asst-ask[data-state="stale"] .asst-ask-face { opacity: .55; }
  .asst-ask-receipt-title { min-width: 0; max-width: 100%; overflow: hidden; color: var(--asst-text-2); text-overflow: ellipsis; white-space: nowrap; }
  .asst-ask-receipt-arrow { color: var(--asst-text-4); }
  .asst-ask-chip {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    min-height: 20px;
    padding: 1px 7px;
    border-radius: var(--asst-pill-r-xs);
    background: var(--asst-pill-on-fill);
    box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring);
    color: var(--asst-text);
    font-size: 11.5px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .asst-ask-receipt-list { min-width: 0; color: var(--asst-text-3); overflow-wrap: anywhere; }
  .asst-ask-receipt-status { color: var(--asst-text-3); font-size: 11px; }

  /* ── The question cards (asst-control.js): the same mascot, the card's own head and actions ── */
  .asst-control.asst-ask { background: var(--asst-card); }
  /* The presenter is its face: no second cameo in the head. */
  .asst-control.asst-ask .asst-control-head > .asst-control-face { display: none; }
  .asst-control.asst-ask .asst-control-q { gap: 8px; }
  .asst-control.asst-ask .asst-control-q-header { color: var(--asst-text-3); font-size: 11.5px; font-weight: 500; }
  .asst-control.asst-ask .asst-control-options { gap: 4px; }
  .asst-control.asst-ask .asst-control-option.selected { background: var(--asst-pill-on-fill); box-shadow: inset 0 0 0 1px var(--asst-pill-on-ring); }
  /* Answered: the picks stay (gold), the rest goes; nothing to press any more. The record stays readable
     (no dimming of the whole card: the ✓ capsule, the status word and the still face say it is settled). */
  .asst-control.asst-ask.resolved { opacity: 1; }
  .asst-control.asst-ask.resolved .asst-control-option:not(.selected) { display: none; }
  .asst-control.asst-ask.resolved .asst-ask-input:placeholder-shown { display: none; }
  .asst-control.asst-ask.resolved :is(.asst-control-actions, .asst-control-deny-msg, .asst-control-q-hint, .asst-ask-keys) { display: none; }
  .asst-control.asst-ask.resolved .asst-ask-face:not(.is-answered) { opacity: .55; }

  /* Narrow panels: a smaller mascot in a narrower column; at 320px the keys line goes. */
  @container asst (max-width: 400px) {
    .asst-ask { --ask-face-col: 52px; --ask-face-w: 48px; --ask-face-h: 24px; }
    .asst-followups.asst-ask, .asst-control.asst-ask { padding: 10px; }
    .asst-ask .asst-ask-option { min-height: 40px; }
  }
  @container asst (max-width: 320px) {
    .asst-ask { --ask-face-col: 44px; --ask-face-w: 40px; --ask-face-h: 20px; }
    .asst-ask .asst-ask-option { gap: 8px; padding: 6px 8px; }
    .asst-ask:focus-within .asst-ask-keys { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .asst-ask, .asst-ask * { transition: none !important; }
  }
`;

/** Add the sheet once, right after the main assistant styles when they are in the page. */
export function injectAskStyles(doc = globalThis.document) {
  if (!doc || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') return;
  if (doc.getElementById(ASK_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = ASK_STYLE_ID;
  style.textContent = ASK_CSS;
  const main = doc.getElementById('assistant-panel-styles');
  if (main?.parentNode) main.after(style);
  else doc.head?.appendChild(style);
}
