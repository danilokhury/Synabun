// The Workspace tour's engine. Beats are data (tour-beats.js); the engine
// plays one at a time over three actors: the mascot (the empty state's real
// rig, in its real box: tour-actor.js), the board (hand-drawn ink over the
// panel, and the one highlight ring on the page: tour-stage.js) and the
// caption (the narration, laid out whole and revealed a word at a time, said
// once to the panel's role=status announcer). A beat plays itself out, then
// waits for the user: tap the board, → / Enter / Space, or Continue. A press
// mid-beat hurries it (what is in flight runs fast, what is left is placed),
// ← goes back, Esc ends it with the mascot flying home. Every change starts
// from what is on screen: the mascot keeps its speed, the ring morphs, the
// caption morphs (FLIP), the board wipes. Nothing here starts a session, sends
// a message or changes a setting: the panel's controls are only pointed at.
import { createHighlight, createStage, EASE, sparkle } from './tour-stage.js';
import { createActor } from './tour-actor.js';
import { BEATS, CHAPTERS } from './tour-beats.js';
import { ellipsePoints, seededRand, softBoxPath } from './tour-ink.js';
import { unionRect, visibleRect } from '../ui-tutorial-layout.js';

const WORD_MS = 34; // the narration's pace
const PUNCT_MS = 140; // a breath after a comma or a full stop
const MORPH_MS = 320; // --asst-dur-slow: the caption changing size or place
const ARROW_MIN_PX = 14; // an arrow shorter than two heads (tour-stage.js arrow head 7) is left out: a stub reads as a blot
const ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H6M11 6l-6 6 6 6"/></svg>';
const ICON_CARET = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

/**
 * createTour({ host, tr, … }) → { play(i), next(), prev(), close(reason), openList(), index, ready }
 * host: { root, transcript, announcer, bar, renderer, director, composer, live } (the panel the tour
 *   presents on; ui-tutorial.js gets it from the sidepanel or a session-free preview).
 * tr(key, params): the strings (tour.*). env: { computer } (what this workspace has).
 * onBeat(beat): a beat started (the saved cursor). onComplete(): the hand-off was reached.
 * onClose(reason): 'done' | 'skip' | 'sent' | 'gone', after everything is put back.
 * onExplore(): the chapter list's "Explore a project" row (the setup wizard), when given.
 */
export function createTour({
  host, tr, beats = BEATS, chapters = CHAPTERS, reduced = () => false, env = {},
  pageHost = document.body, onBeat, onComplete, onClose, onExplore, resumeAt = -1,
} = {}) {
  const { root, transcript, renderer } = host;
  const announcer = host.announcer || root.querySelector('.asst-announce');
  const panel = root.closest('.assistant-panel');
  const scopes = [root, host.bar, panel, document].filter(Boolean);
  const text = (key, params) => { const v = tr(key, params); return v && v !== key ? v : ''; };

  let fast = false;
  const quick = () => reduced() || fast;
  const board = createStage(root, { reduced: quick });
  const page = createStage(pageHost, { fixed: true, reduced: quick });
  // The page layer rings controls in the panel too: it sits just above the panel, whatever its stacking.
  try { page.el.style.zIndex = String(Math.max(11001, (parseInt(getComputedStyle(panel || root).zIndex, 10) || 0) + 1)); } catch { /* the stylesheet's */ }
  const ring = createHighlight(page, { reduced });
  const target = renderer.mascot?.();
  const hero = target?.kind === 'hero' ? target : null;
  // The mascot is the top-most thing on the tour: both ink layers keep a hole where it is, every frame it moves.
  const actor = hero ? createActor(hero, { reduced, onMove: (r) => { board.setKeepOut(r); page.setKeepOut(r); } }) : null;
  const scrollTop = transcript.scrollTop;
  hero?.hold?.(true);
  host.director?.present?.(true);
  const previousFocus = document.activeElement;

  // ── The caption: the narration, the chapter it is in, the way on ──
  const caption = node('div', 'tour-caption');
  caption.dataset.place = 'foot';
  caption.innerHTML = `
    <div class="tour-caption-bg" aria-hidden="true"></div>
    <div class="tour-caption-body">
      <div class="tour-caption-meta">
        <button type="button" class="tour-chapter-btn" aria-haspopup="true" aria-expanded="false"><span class="tour-chapter-name"></span>${ICON_CARET}</button>
        <span class="tour-dots" aria-hidden="true"></span>
      </div>
      <div class="tour-line" aria-hidden="true"></div>
      <div class="tour-list" role="group" hidden></div>
      <div class="tour-actions">
        <span class="tour-hint"></span>
        <button type="button" class="tour-skip"></button>
        <button type="button" class="tour-back" hidden></button>
        <button type="button" class="tour-next"></button>
      </div>
    </div>`;
  const bg = caption.querySelector('.tour-caption-bg');
  const body = caption.querySelector('.tour-caption-body');
  const chapterBtn = caption.querySelector('.tour-chapter-btn');
  const chapterName = caption.querySelector('.tour-chapter-name');
  const dots = caption.querySelector('.tour-dots');
  const line = caption.querySelector('.tour-line');
  const list = caption.querySelector('.tour-list');
  const hint = caption.querySelector('.tour-hint');
  const skipBtn = caption.querySelector('.tour-skip');
  const backBtn = caption.querySelector('.tour-back');
  const nextBtn = caption.querySelector('.tour-next');
  dots.innerHTML = chapters.map(() => '<span class="tour-dot"><span class="tour-dot-fill"></span></span>').join('');
  skipBtn.textContent = text('tour.ui.skip');
  backBtn.innerHTML = ICON_BACK;
  backBtn.setAttribute('aria-label', text('tour.ui.back'));
  backBtn.dataset.tooltip = text('tour.ui.back');
  list.setAttribute('aria-label', text('tour.ui.chapters'));
  transcript.appendChild(caption);
  root.classList.add('tour-on');
  transcript.scrollTop = 0;

  let index = -1;
  let gen = 0;
  let ready = false;
  let done = false;
  let listOpen = false;
  let lastPlayed = null; // the beat whose ink is on the board
  let ringTarget = null; // the spec the ring and the arms point at
  let place = null; // the beat's travel place, for a replay after a resize
  const timers = new Map(); // timeout id → the resolve of the wait it ends
  const sleep = (ms, my) => new Promise((resolve) => {
    if (my !== gen || quick()) { resolve(); return; }
    const id = setTimeout(() => { timers.delete(id); resolve(); }, ms);
    timers.set(id, resolve);
  });
  // A wait cut short ends at once (a hurried beat goes on; a replaced one stops at its generation check).
  const clearTimers = () => { for (const [id, resolve] of timers) { clearTimeout(id); resolve(); } timers.clear(); };

  // ── Geometry: board units (0-100 across the board), places, targets ──
  const boardRect = () => {
    const tb = transcript.getBoundingClientRect();
    const cap = caption.getBoundingClientRect();
    const atTop = caption.dataset.place === 'head';
    const top = (atTop ? cap.bottom : tb.top) + 12;
    const bottom = atTop ? tb.bottom - 12 : cap.top - 10;
    return { left: tb.left + 14, top, right: tb.right - 14, bottom, width: tb.width - 28, height: Math.max(0, bottom - top) };
  };
  const u = (x, y, b = boardRect()) => { const k = b.width / 100; return { x: b.left + x * k, y: b.top + y * k }; };
  const uRect = ([x, y, w, h]) => { const b = boardRect(); const a = u(x, y, b); const c = u(x + w, y + h, b); return { left: a.x, top: a.y, right: c.x, bottom: c.y, width: c.x - a.x, height: c.y - a.y }; };
  const shownEl = (el) => {
    if (!el?.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    return visibleRect(el.getBoundingClientRect(), innerWidth, innerHeight);
  };
  /** The control(s) a target names: the first selector on screen (all of them for a union). */
  function resolve(spec) {
    if (!spec?.sel) return null;
    const found = [];
    for (const sel of spec.sel) {
      for (const scope of scopes) {
        let el = null;
        try { el = scope.querySelector(sel); } catch { el = null; }
        if (el && shownEl(el)) { found.push(el); break; }
      }
      if (found.length && !spec.union) break;
    }
    return found.length ? found : null;
  }
  const rectOfEls = (els) => unionRect(els.map(e => e.getBoundingClientRect()));
  const targetRect = (spec) => { const els = resolve(spec); return els ? rectOfEls(els) : null; };
  /**
   * The ring's shape round a control: its gaps (a beat's `pad` / `padY`, else 7 round and 5 above and below), the
   * control's own corner, the ring's largest radius and how far its pen-tail bows out (`tail`, tour-stage.js).
   */
  function ringShapeFor(spec) {
    const els = resolve(spec);
    let corner = 6;
    try { if (els?.[0]) corner = parseFloat(getComputedStyle(els[0]).borderTopLeftRadius) || 6; } catch { /* the default */ }
    return { pad: spec.pad ?? 7, padY: spec.padY ?? spec.pad ?? 5, corner, radius: spec.radius ?? 999, tail: spec.tail };
  }
  /** How far short of a ringed control the fingertip stops: outside the ring, with room for a poke. */
  const ringGap = spec => Math.max(spec?.pad ?? 7, spec?.padY ?? spec?.pad ?? 5) + 9;
  const places = {
    home: () => null,
    corner: () => ({ point: u(17, 12), scale: 0.8 }),
    top: () => ({ point: u(50, 13), scale: 1 }),
    topright: () => ({ point: u(80, 12), scale: 0.8 }),
    composer: () => {
      const b = boardRect();
      const tb = transcript.getBoundingClientRect();
      const m = targetRect({ sel: ['.asst-dd-model', '.asst-composer'] });
      const x = Math.max(b.left + 56, Math.min(b.right - 70, m ? m.left + m.width / 2 : b.left + b.width / 2));
      // High enough that the arm, reaching down at the pill, ends inside the board (the transcript clips).
      return { point: { x, y: Math.min(b.bottom - 8, tb.bottom - 58) }, scale: 0.8 };
    },
  };
  /**
   * Beside a control, never on it: left of it (or right, when there is no room), level with
   * its top, inside the board. The mascot lands there to point with a short arm.
   */
  function besidePlace(spec, scale = 0.8) {
    const r = targetRect(spec);
    if (!r) return null;
    const b = boardRect();
    const half = 60 * scale; // half the face's width at this scale
    let x = r.left - half - 22;
    if (x - half < b.left) x = r.right + half + 22;
    x = Math.max(b.left + half, Math.min(b.right - half, x));
    const y = Math.max(b.top + 30 * scale, Math.min(b.bottom - 30 * scale, r.top - 18));
    return { point: { x, y }, scale, avoid: [r] };
  }

  // ── Layout: what the mascot, the ring and the writing keep clear of ──
  const hits = (a, b, m = 0) => a.left < b.right + m && a.right > b.left - m && a.top < b.bottom + m && a.bottom > b.top - m;
  const inside = (a, b, m = 0) => a.left >= b.left - m && a.right <= b.right + m && a.top >= b.top - m && a.bottom <= b.bottom + m;
  const grow = (r, m) => (r ? { left: r.left - m, top: r.top - m, right: r.right + m, bottom: r.bottom + m } : null);
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  /** The panel's own words on screen that ink must never cover: the composer's first line (its placeholder or the draft). */
  function panelText() {
    const out = [];
    const input = root.querySelector('.asst-composer textarea, .asst-composer .asst-input');
    if (input) {
      const r = input.getBoundingClientRect();
      const cs = getComputedStyle(input);
      const top = r.top + (parseFloat(cs.paddingTop) || 0);
      const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.4;
      if (r.width) out.push({ left: r.left + (parseFloat(cs.paddingLeft) || 0), top, right: r.right - (parseFloat(cs.paddingRight) || 0), bottom: top + lh });
    }
    return out;
  }
  /** Everything a new piece of writing (or a landing) keeps clear of, as client rects. */
  function obstacles({ mascot = true, ink = true } = {}) {
    const out = [];
    const cap = caption.getBoundingClientRect();
    if (cap.width) out.push(grow(cap, 4));
    if (mascot && actor) { const k = actor.keepOut(); if (k) out.push(k); }
    if (mascot && actor) { const a = actor.rig.armExtent?.(); if (a) out.push(grow(a, 3)); }
    const rb = ring.box;
    if (rb) out.push(grow(rb, 3));
    if (ringTarget) { const t = targetRect(ringTarget); if (t) out.push(grow(t, 2)); }
    if (ink) out.push(...board.boxes().map(b => grow(b, 3)));
    out.push(...panelText());
    return out.filter(Boolean);
  }
  /**
   * A place for the mascot clear of the board's ink, the caption and the ring: the place asked for, or
   * the nearest free one round it (steps of 10 px), inside the board. The face's keep-out decides.
   */
  function fitPlace(p) {
    if (!p?.point || !actor) return p;
    const b = boardRect();
    const avoid = [...obstacles({ mascot: false }), ...(p.avoid || []).map(r => grow(r, 8))];
    const ok = (pt) => { const k = actor.keepOutAt(pt, p.scale); return k && inside(k, b, 2) && !avoid.some(o => hits(k, o)); };
    if (ok(p.point)) return p;
    for (let d = 10; d <= 160; d += 10) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const pt = { x: p.point.x + dx * d, y: p.point.y + dy * d };
        if (ok(pt)) return { ...p, point: pt };
      }
    }
    return p;
  }

  /**
   * Where a piece of writing goes: the first candidate (client baseline anchors, in order of preference)
   * whose box stays inside the board and clear of the mascot, its arm, the ring and its control, the
   * caption, the panel's words and the ink already there; else the one that overlaps least.
   */
  function chooseSpot(cands, size) {
    const b = boardRect();
    const avoid = obstacles();
    const boxAt = (c) => {
      const left = c.anchor === 'middle' ? c.x - size.w / 2 : c.anchor === 'end' ? c.x - size.w : c.x;
      return { left, right: left + size.w, top: c.y + size.top, bottom: c.y + size.bottom };
    };
    let best = null;
    for (const c of cands) {
      const r = boxAt(c);
      const cost = (inside(r, b, 1) ? 0 : 1e6) + avoid.reduce((sum, o) => sum + overlap(grow(r, 3), o), 0);
      if (cost === 0) return c;
      if (!best || cost < best.cost) best = { ...c, cost };
    }
    return best;
  }

  /** The candidates for writing placed beside the mascot or round a control: { beside: 'actor' | spec, side, dy }. */
  function spotsFor(spec, size) {
    const gap = 6; // past the keep-out (or the ring), whose own margin is the clear board round it
    const k = spec.beside === 'actor' ? actor?.keepOut() : null;
    const t = spec.beside !== 'actor' ? (ring.target && ringTarget === spec.beside ? ring.box : grow(targetRect(spec.beside), 6)) : null;
    const r = k || t;
    if (!r) return [];
    const dy = spec.dy || 0;
    const line = size.bottom - size.top;
    const midY = (r.top + r.bottom) / 2 - (size.top + size.bottom) / 2;
    const sides = {
      right: [0, -line, line, -2 * line, 2 * line].map(o => ({ x: r.right + gap, y: midY + dy + o, anchor: 'start' })),
      left: [0, -line, line, -2 * line, 2 * line].map(o => ({ x: r.left - gap, y: midY + dy + o, anchor: 'end' })),
      above: [0, -40, 40, -80, 80].map(o => ({ x: (r.left + r.right) / 2 + o, y: r.top - gap - size.bottom, anchor: 'middle' })),
      below: [0, -40, 40, -80, 80].map(o => ({ x: (r.left + r.right) / 2 + o, y: r.bottom + gap - size.top, anchor: 'middle' })),
    };
    const order = [spec.side || 'right', ...['right', 'left', 'above', 'below'].filter(x => x !== (spec.side || 'right'))];
    return order.flatMap(sd => sides[sd]);
  }
  let lastLabel = null; // the client box of the last writing placed (a sparkle goes at its end)
  let lastFit = null; // the last landing chosen: { asked, place, keepOut, board } (tests read it)

  /**
   * Home with the caption at the head of the board (the hand-off): the empty state makes room under the
   * caption, so the mascot and the words come back clear of it; the mascot keeps its place on screen
   * while the layout moves (actor.measure), then flies to the new home.
   */
  function makeRoom() {
    const empty = transcript.querySelector(':scope > .asst-empty');
    if (!empty || caption.dataset.place !== 'head') { root.classList.remove('tour-room'); return; }
    const tb = transcript.getBoundingClientRect();
    const cb = caption.getBoundingClientRect();
    root.style.setProperty('--tour-room', `${Math.max(0, Math.round(cb.bottom - tb.top))}px`);
    root.classList.add('tour-room');
    actor?.measure();
  }
  /** The room goes when the tour does: the empty state glides back (one transform), never jumps. */
  function giveRoomBack() {
    const empty = transcript.querySelector(':scope > .asst-empty');
    if (!root.classList.contains('tour-room')) return;
    const before = empty?.getBoundingClientRect();
    root.classList.remove('tour-room');
    root.style.removeProperty('--tour-room');
    if (!empty || !before || reduced()) return;
    const after = empty.getBoundingClientRect();
    const dy = before.top - after.top;
    if (Math.abs(dy) > 0.5) empty.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: MORPH_MS, easing: EASE.emphasized });
  }

  /**
   * A point from a beat's shorthand: [ux, uy] | { actor, dx, dy } | { keepout: 'left' | 'right' | 'top' | 'bottom', dx, dy }
   * (just outside what the mascot draws) | { after: 'label', dx, dy } (the last writing's end) | { target, at, dx, dy }.
   */
  function point(spec) {
    if (Array.isArray(spec)) return u(spec[0], spec[1]);
    if (spec?.keepout && actor) {
      const k = actor.keepOut();
      if (!k) return null;
      const cx = (k.left + k.right) / 2;
      const cy = (k.top + k.bottom) / 2;
      const p = spec.keepout === 'left' ? { x: k.left, y: cy } : spec.keepout === 'right' ? { x: k.right, y: cy }
        : spec.keepout === 'top' ? { x: cx, y: k.top } : { x: cx, y: k.bottom };
      return { x: p.x + (spec.dx || 0), y: p.y + (spec.dy || 0) };
    }
    if (spec?.after === 'label') return lastLabel ? { x: lastLabel.right + (spec.dx || 0), y: lastLabel.top + (spec.dy || 0) } : null;
    if (spec?.actor && actor) {
      const p = actor.edge(spec.actor);
      return p ? { x: p.x + (spec.dx || 0), y: p.y + (spec.dy || 0) } : null;
    }
    if (spec?.target) {
      const r = targetRect(spec.target);
      if (!r) return null;
      const at = spec.at || 'center';
      const p = at === 'above' ? { x: r.left + r.width / 2, y: r.top } : at === 'below' ? { x: r.left + r.width / 2, y: r.bottom }
        : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      return { x: p.x + (spec.dx || 0), y: p.y + (spec.dy || 0) };
    }
    if (spec?.sel) { const r = targetRect(spec); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }
    return null;
  }

  // ── The caption's motion: one FLIP per change of size or place, the surface and the words apart ──
  function morph(change) {
    if (reduced() || !caption.isConnected) { change(); return; }
    const a = caption.getBoundingClientRect();
    change();
    const b = caption.getBoundingClientRect();
    if (!b.width || !b.height || (Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5)) return;
    for (const el of [bg, body]) el.getAnimations().forEach(x => x.cancel());
    bg.animate([
      { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})` },
      { transform: 'none' },
    ], { duration: MORPH_MS, easing: EASE.emphasized });
    body.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: MORPH_MS, easing: EASE.emphasized });
  }

  // ── Narration: laid out whole (so the caption has its final size at once), revealed a word at a time ──
  let lineAnims = [];
  function say(key, my, { computerless } = {}) {
    // A beat that says something else where this machine has no computer use names that line.
    const textOf = (computerless && env.computer === false && text(`tour.beats.${key}.${computerless}`)) || text(`tour.beats.${key}.line`);
    const chapter = Math.max(0, chapters.indexOf(beats[index]?.chapter));
    if (announcer) announcer.textContent = text('tour.ui.announce', { n: chapter + 1, total: chapters.length, line: textOf }) || textOf;
    lineAnims.forEach(a => a.cancel());
    lineAnims = [];
    const words = String(textOf).split(/\s+/).filter(Boolean);
    // The line on screen fades first: a new line never cuts in over the old one.
    const fading = !quick() && line.childNodes.length
      ? line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: EASE.exit, fill: 'forwards' }).finished.catch(() => {})
      : null;
    if (fading) return fading.then(() => (my === gen ? lay(words, my) : undefined));
    return lay(words, my);
  }

  function lay(words, my) {
    line.getAnimations().forEach(a => a.cancel());
    morph(() => {
      line.replaceChildren();
      words.forEach((w, i) => {
        if (i) line.append(' '); // a text node between words: a space inside an inline-block collapses
        line.append(node('span', 'tour-word', w));
      });
    });
    if (quick()) return Promise.resolve();
    let at = 0;
    for (const span of line.querySelectorAll('.tour-word')) {
      lineAnims.push(span.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: at, easing: EASE.enter, fill: 'backwards' }));
      at += WORD_MS + (/[.,:;!?…]$/.test(span.textContent) ? PUNCT_MS : 0);
    }
    const last = lineAnims[lineAnims.length - 1];
    return last ? last.finished.catch(() => {}) : Promise.resolve();
  }

  function setChapter(beat) {
    const ci = Math.max(0, chapters.indexOf(beat.chapter));
    const name = `${text('tour.ui.chapterOf', { n: ci + 1, total: chapters.length })} · ${text(`tour.chapters.${chapters[ci]}`)}`;
    if (chapterName.textContent !== name) {
      chapterName.textContent = name;
      if (!reduced()) chapterName.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE.enter });
    }
    [...dots.children].forEach((d, i) => { d.classList.toggle('on', i === ci); d.classList.toggle('done', i < ci); });
  }

  function setReady(on, beat) {
    ready = on;
    caption.classList.toggle('is-ready', on);
    nextBtn.innerHTML = beat?.last ? `<span>${text('tour.ui.done')}</span>` : `<span>${text('tour.ui.next')}</span>${ICON_NEXT}`;
    nextBtn.setAttribute('aria-label', beat?.last ? text('tour.ui.done') : text('tour.ui.next'));
    // Skip and Back fade in place (their room stays), so nothing in the row jumps.
    skipBtn.classList.toggle('is-off', !!beat?.last); // the hand-off has nothing left to skip
    backBtn.classList.toggle('is-off', index <= 0);
    hint.replaceChildren();
    if (on && index === 0) {
      const [before, after] = text('tour.ui.hint').split('→');
      hint.append(before || '');
      if (after != null) hint.append(node('kbd', '', '→'), after);
    }
    // The keyboard follows the way on, unless the user is typing somewhere.
    const active = document.activeElement;
    if (on && (!active || active === document.body || caption.contains(active) || transcript.contains(active)) && !active?.matches?.('input, textarea, [contenteditable="true"]')) {
      nextBtn.focus({ preventScroll: true });
    }
  }

  // ── Ink the board draws ──
  function doodle(name, [cx, cy, size], my) {
    const k = boardRect().width / 100;
    const c = u(cx, cy);
    const s = size * k;
    const P = (x, y) => ({ x: c.x + x * s, y: c.y + y * s });
    const pts = (list) => list.map(([x, y]) => P(x, y));
    const at = (fn) => (my === gen ? fn() : null);
    const ell = (x, y, rx, ry, opts = {}) => board.stroke(ellipsePoints(c.x + x * s, c.y + y * s, rx * s, ry * s, { seed: `${name}${x}${y}`, ...opts }).map(([px, py]) => ({ x: px, y: py })), opts);
    const rbox = (x, y, w, h, opts = {}) => board.path(softBoxPath(board.localRect({ left: c.x + x * s, top: c.y + y * s, width: w * s, height: h * s }), { radius: Math.min(10, w * s / 3), seed: `${name}b${x}` }).d, opts);
    switch (name) {
      case 'globe': return at(async () => {
        await ell(0, 0, 0.5, 0.5, { cls: 'ink', duration: 340 });
        await Promise.all([ell(0, 0, 0.2, 0.5, { cls: 'ink', duration: 260, turns: 0.52, start: -Math.PI / 2 }), board.stroke(pts([[-0.48, 0.02], [0, 0.04], [0.48, 0.02]]), { duration: 200 })]);
      });
      case 'laptop': return at(async () => {
        await rbox(-0.42, -0.36, 0.84, 0.56);
        await board.stroke(pts([[-0.55, 0.3], [-0.3, 0.32], [0.3, 0.32], [0.55, 0.3]]), { duration: 200 });
      });
      case 'folder': return at(async () => {
        await board.stroke(pts([[-0.48, -0.22], [-0.48, -0.34], [-0.42, -0.4], [-0.16, -0.4], [-0.08, -0.3], [0.44, -0.3], [0.5, -0.24], [0.5, 0.3], [0.44, 0.36], [-0.42, 0.36], [-0.48, 0.3], [-0.48, -0.22]]), { duration: 420 });
      });
      case 'island': return at(async () => {
        const rand = seededRand('island');
        const blob = [];
        for (let i = 0; i <= 18; i += 1) {
          const a = (i / 18) * Math.PI * 2;
          const r = 0.5 + (i < 18 ? (rand() - 0.5) * 0.12 : 0) + 0.06 * Math.sin(a * 3);
          blob.push([Math.cos(a) * r, Math.sin(a) * r * 0.55]);
        }
        await board.stroke(pts(blob), { cls: 'ink', duration: 460 });
        await Promise.all([[-0.18, -0.06], [0.08, 0.08], [0.22, -0.1]].map(([x, y], i) => ell(x, y, 0.035, 0.035, { cls: 'gold', duration: 160, delay: i * 60 })));
      });
      case 'board': return at(async () => {
        await rbox(-0.5, -0.32, 1, 0.62);
        await board.stroke(pts([[-0.32, 0.06], [-0.18, -0.12], [-0.04, 0.08], [0.1, -0.1], [0.26, 0.04]]), { cls: 'gold', duration: 360 });
        await board.stroke(pts([[-0.14, 0.3], [-0.2, 0.48]]), { duration: 140 });
        await board.stroke(pts([[0.14, 0.3], [0.2, 0.48]]), { duration: 140 });
      });
      case 'clock': return at(async () => {
        await ell(0, 0, 0.5, 0.5, { cls: 'ink', duration: 380 });
        await board.stroke(pts([[0, -0.28], [0, 0], [0.2, 0.1]]), { cls: 'gold', duration: 260 });
        await board.arrow(P(0.55, -0.34), P(0.62, 0.06), { cls: 'faint', curve: -0.4, head: 5 });
      });
      case 'cycle': return at(async () => {
        // A loop that comes back round: what is saved returns next time.
        await ell(0, 0, 0.5, 0.5, { cls: 'faint', duration: 420, turns: 0.82, start: -Math.PI * 0.35 });
        const a = -Math.PI * 0.35 + Math.PI * 2 * 0.82;
        const tip = P(Math.cos(a) * 0.5, Math.sin(a) * 0.5);
        const back = P(Math.cos(a - 0.5) * 0.5, Math.sin(a - 0.5) * 0.5);
        const ang = Math.atan2(tip.y - back.y, tip.x - back.x);
        const wing = (side) => [{ x: tip.x - Math.cos(ang + side * 0.6) * 6, y: tip.y - Math.sin(ang + side * 0.6) * 6 }, tip];
        await Promise.all([board.stroke(wing(1), { cls: 'faint', duration: 110 }), board.stroke(wing(-1), { cls: 'faint', duration: 110, delay: 40 })]);
      });
      case 'fork': return at(async () => {
        await board.label('?', P(0, -0.3), { cls: 'gold big', anchor: 'middle' });
        await board.stroke(pts([[0, -0.18], [0, 0.18]]), { duration: 200 });
        await Promise.all([
          board.arrow(P(0, 0.18), P(-0.42, 0.62), { cls: 'gold', curve: 0.12, head: 6 }),
          board.arrow(P(0, 0.18), P(0.42, 0.62), { cls: 'faint', curve: -0.12, head: 6 }),
        ]);
      });
      default: return null;
    }
  }

  /** A memory drum: the top ellipse, the two sides, the bottom arc (units [x, y, w, h]). */
  async function drum([x, y, w, h]) {
    const r = uRect([x, y, w, h]);
    const ry = Math.max(3, r.height * 0.22);
    const cx = r.left + r.width / 2;
    const rx = r.width / 2;
    const toPts = (list) => list.map(([px, py]) => ({ x: px, y: py }));
    await board.stroke(toPts(ellipsePoints(cx, r.top + ry, rx, ry, { seed: 'drum-top', start: Math.PI, turns: 1.02 })), { duration: 320 });
    await Promise.all([
      board.stroke([{ x: r.left, y: r.top + ry }, { x: r.left + 0.5, y: r.bottom - ry }], { duration: 180 }),
      board.stroke([{ x: r.right, y: r.top + ry }, { x: r.right - 0.5, y: r.bottom - ry }], { duration: 180, delay: 40 }),
    ]);
    await board.stroke(toPts(ellipsePoints(cx, r.bottom - ry, rx, ry, { seed: 'drum-bottom', start: Math.PI, turns: -0.5, count: 12 })), { duration: 220 });
  }

  // ── Ops ──
  async function run(op, my) {
    if (my !== gen || done) return undefined;
    const [kind, a, b, c] = op;
    switch (kind) {
      case 'pose': return actor?.pose(a, b);
      case 'react': return actor?.react(a);
      case 'travel': {
        place = a;
        if (a === 'home') makeRoom();
        const asked = typeof a === 'object' && a?.beside ? besidePlace(a.beside, a.scale) : places[a]?.();
        const p = fitPlace(asked);
        board.measure(); // the keep-out follows the flight from this read
        lastFit = { asked: asked?.point || null, place: p?.point || null, keepOut: p?.point && actor ? actor.keepOutAt(p.point, p.scale) : null, board: boardRect() };
        return actor?.travel(p?.point || null, { scale: p?.scale ?? 1 });
      }
      case 'look': return actor?.look(point(a));
      case 'point': {
        if (a == null) { actor?.point(null); return undefined; }
        if (Array.isArray(a)) { const p = point(a); if (p) actor?.point(p, { gap: 10 }); return undefined; }
        const els = resolve(a);
        if (!els) return undefined;
        // A ringed control: the fingertip stops outside the ring (a poke just reaches it).
        actor?.point(els.length > 1 ? rectOfEls(els) : els[0], { gap: ringTarget === a ? ringGap(a) : 8 });
        return undefined;
      }
      case 'poke': return actor?.poke();
      case 'ring': {
        if (!a && !ringTarget && !ring.target) return undefined; // nothing ringed: nothing to fade
        ringTarget = a || null;
        const r = a ? targetRect(a) : null;
        if (a && !r) return undefined; // not on screen here: the ring stays where it is
        ring.to(r, a ? ringShapeFor(a) : undefined);
        return sleep(quick() ? 0 : 220, my);
      }
      case 'say': return say(a, my, b);
      case 'wait': return sleep(a, my);
      case 'label': {
        const words = text(`tour.ink.${a}`);
        if (b?.beside) {
          // Writing beside the mascot or a control picks a free side (see chooseSpot); placed before it is written.
          return board.label(words, { x: 0, y: 0 }, {
            ...c,
            place: (size) => {
              const spot = chooseSpot(spotsFor(b, size), size);
              if (spot) lastLabel = { left: spot.anchor === 'middle' ? spot.x - size.w / 2 : spot.anchor === 'end' ? spot.x - size.w : spot.x, top: spot.y + size.top, right: 0, bottom: spot.y + size.bottom };
              if (lastLabel && spot) lastLabel.right = lastLabel.left + size.w;
              return spot;
            },
          });
        }
        const p = point(b);
        return p ? board.label(words, p, c) : undefined;
      }
      case 'box': return board.box(uRect(a), b);
      case 'line': return board.stroke(a.map(p => point(p)).filter(Boolean), b);
      case 'arrow': {
        const f = point(a);
        const t = point(b);
        // No room for a shaft (a narrow board: the "you" box meets the mascot's keep-out): no arrow at all,
        // rather than a head on a stub. The figure still reads by its boxes.
        if (!f || !t || Math.hypot(t.x - f.x, t.y - f.y) < ARROW_MIN_PX) return undefined;
        return board.arrow(f, t, c);
      }
      case 'underline': return board.underline(uRect(a), b);
      case 'drum': return drum(a);
      case 'doodle': return doodle(a, b, my);
      case 'sparkle': { const p = point(a); return p ? sparkle(board, p, b) : undefined; }
      case 'erase': { if (lastPlayed) actor?.react('wiggle'); lastPlayed = null; return board.erase(); }
      case 'words': root.classList.toggle('tour-board-live', !a); return undefined;
      case 'context': root.classList.toggle('tour-show-context', !!a); return undefined;
      case 'handoff': root.classList.toggle('tour-handoff', a !== false); return undefined;
      case 'if': return env[a] === false ? (c ? run(c, my) : undefined) : run(b, my);
      case 'parallel': return Promise.all(a.map(o => run(o, my)));
      case 'seq': { for (const o of a) { if (my !== gen) return undefined; await run(o, my); } return undefined; }
      default: return undefined;
    }
  }

  // ── Beats ──
  async function play(i, { prelude = true } = {}) {
    if (done || i < 0 || i >= beats.length) return;
    const my = ++gen;
    clearTimers();
    fast = false;
    if (listOpen) setList(false, { focus: false });
    const previous = lastPlayed;
    index = i;
    const beat = beats[i];
    nextBtn.hidden = false;
    backBtn.hidden = false;
    skipBtn.textContent = text('tour.ui.skip');
    onBeat?.(beat, i);
    if (beat.last) onComplete?.();
    if (!beat.last) root.classList.add('tour-board-live'); // a beat reached directly starts with the empty state's words aside
    if (!beat.last && root.classList.contains('tour-room')) { root.classList.remove('tour-room'); actor?.measure(); } // back from the hand-off
    // The empty state's context line (Project · Budget) is one beat's: it goes with that beat, whichever comes next.
    root.classList.remove('tour-show-context');
    morph(() => {
      caption.dataset.place = beat.caption === 'top' ? 'head' : 'foot';
      setChapter(beat);
    });
    setReady(false, beat);
    hint.replaceChildren();
    // A beat that continues another one's figure, reached some other way: that figure first, at once.
    if (beat.after && previous !== beat.after && prelude) {
      await board.erase();
      if (my !== gen) return;
      const was = fast;
      fast = true;
      for (const op of beat.prelude || []) { if (my !== gen) return; await run(op, my); }
      fast = was;
    }
    for (const op of beat.script) {
      if (my !== gen || done) return;
      try { await run(op, my); } catch (err) { console.warn('[tour] op failed', op[0], err); }
    }
    if (my !== gen || done) return;
    lastPlayed = beat.id;
    fast = false;
    setReady(true, beat);
  }

  /** Hurry: what is in flight runs at five times its speed, what is left is placed. */
  function hurry() {
    fast = true;
    const anims = [...lineAnims, ...board.el.getAnimations({ subtree: true }), ...page.el.getAnimations({ subtree: true })];
    for (const a of anims) { try { a.playbackRate = 5; } catch { /* finished */ } }
    clearTimers();
  }

  function next() {
    if (done) return;
    if (listOpen && index < 0) return;
    if (!ready) { hurry(); return; }
    if (beats[index]?.last) { close('done'); return; }
    play(index + 1);
  }
  function prev() { if (!done && index > 0) play(index - 1); }

  // ── The chapter list: a returning user's way in, and the chapter name's menu mid-tour ──
  function renderList() {
    list.replaceChildren();
    const current = index >= 0 ? chapters.indexOf(beats[index].chapter) : (resumeAt >= 0 ? chapters.indexOf(beats[resumeAt]?.chapter) : -1);
    chapters.forEach((id, ci) => {
      const row = node('button', 'tour-list-row');
      row.type = 'button';
      row.dataset.chapter = id;
      row.append(node('span', 'tour-list-n', String(ci + 1)), node('span', 'tour-list-name', text(`tour.chapters.${id}`)));
      if (ci === current) {
        row.setAttribute('aria-current', 'step');
        if (index < 0) row.append(node('span', 'tour-list-note', text('tour.ui.resume')));
      }
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const first = beats.findIndex(bt => bt.chapter === id);
        // A returning user picking where they left off resumes that beat, not the chapter's first one.
        play(index < 0 && ci === current && resumeAt >= 0 && beats[resumeAt]?.chapter === id ? resumeAt : first);
      });
      list.append(row);
    });
    if (onExplore) {
      const explore = node('button', 'tour-list-row tour-list-explore', text('tour.ui.explore'));
      explore.type = 'button';
      explore.addEventListener('click', (e) => { e.stopPropagation(); close('skip', { then: onExplore }); });
      list.append(explore);
    }
  }

  function setList(open, { focus = true } = {}) {
    if (done || open === listOpen) return;
    listOpen = open;
    if (open) renderList();
    morph(() => {
      caption.classList.toggle('is-list', open);
      list.hidden = !open;
      chapterBtn.setAttribute('aria-expanded', String(open));
    });
    if (!reduced()) {
      const shown = open ? list : line;
      shown.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE.enter });
    }
    if (open && focus) (list.querySelector('[aria-current]') || list.firstElementChild)?.focus({ preventScroll: true });
    else if (!open && focus) (ready ? nextBtn : chapterBtn).focus({ preventScroll: true });
  }

  /** Open on the chapter list (a returning user): the mascot wakes and waits beside it. */
  async function openList() {
    if (done) return;
    const my = ++gen;
    caption.dataset.place = 'foot';
    chapterName.textContent = text('tour.ui.chapters');
    root.classList.add('tour-board-live');
    setReady(false, null);
    nextBtn.hidden = true;
    backBtn.hidden = true;
    skipBtn.textContent = text('tour.ui.close');
    setList(true);
    if (announcer) announcer.textContent = text('tour.ui.chapters');
    actor?.pose('idle');
    actor?.react('hop');
    await actor?.travel(places.corner()?.point || null, { scale: 0.8 });
    if (my !== gen) return;
    actor?.pose('present');
    // The arm shows where to pick.
    const rows = list.querySelector('[aria-current]') || list.firstElementChild;
    if (rows) actor?.point(rows);
  }

  // ── Ending: the board wipes, the ring fades, the mascot flies home, the words come back ──
  let closing = null;
  function close(reason = 'skip', { then } = {}) {
    if (closing) return closing;
    done = true;
    gen += 1;
    clearTimers();
    teardownInput();
    closing = (async () => {
      const calm = reason === 'sent' || reason === 'gone' || !root.isConnected;
      if (!calm) {
        caption.classList.add('is-leaving');
        actor?.point(null);
        ring.to(null);
        root.classList.remove('tour-show-context');
        await Promise.all([board.erase(), page.erase(), actor?.travel(null, { scale: 1 })]);
        root.classList.remove('tour-board-live', 'tour-handoff');
        if (!reduced()) {
          await caption.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 200, easing: EASE.exit, fill: 'forwards' }).finished.catch(() => {});
        }
      }
      actor?.point(null);
      actor?.reset();
      giveRoomBack();
      ring.destroy();
      board.destroy();
      page.destroy();
      caption.remove();
      root.classList.remove('tour-on', 'tour-board-live', 'tour-handoff', 'tour-show-context');
      if (hero && renderer.mascot?.() === hero) {
        try { hero.rig.setPose('idle'); } catch { /* gone */ }
        hero.hold?.(false);
        hero.restore?.();
      }
      host.director?.present?.(false);
      if (transcript.isConnected) transcript.scrollTop = scrollTop;
      if (announcer && reason !== 'sent') announcer.textContent = '';
      if (!calm && reason !== 'done' && previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus({ preventScroll: true });
      onClose?.(reason);
      then?.();
    })();
    return closing;
  }

  // ── Input ──
  const typing = (el) => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  function onKey(e) {
    if (done || e.defaultPrevented) return;
    const t = e.target;
    if (e.key === 'Escape') {
      if (document.querySelector('.asst-dd-menu') && !caption.contains(t)) return; // a menu the user opened closes first
      e.preventDefault();
      e.stopImmediatePropagation();
      if (listOpen && index >= 0) { setList(false); return; }
      close('skip');
      return;
    }
    if (typing(t) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (listOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const rows = [...list.querySelectorAll('button')];
      const at = rows.indexOf(document.activeElement);
      const to = rows[(at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
      e.preventDefault();
      e.stopImmediatePropagation();
      to?.focus({ preventScroll: true });
      return;
    }
    // A focused button takes its own Enter and Space.
    const onButton = !!t?.closest?.('button, a[href], [role="button"], [role="menuitem"]');
    if (e.key === 'ArrowRight' || ((e.key === 'Enter' || e.key === ' ') && !onButton)) {
      if (listOpen && index < 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      next();
    } else if (e.key === 'ArrowLeft') {
      if (listOpen) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      prev();
    }
  }
  function onTap(e) {
    if (done || e.button > 0) return;
    if (caption.contains(e.target)) return;
    // At the hand-off the starters are real again: a click on one is the user's, not a "continue".
    if (e.target.closest?.('button, a, input, textarea, [role="button"], [role="listitem"]')) return;
    if (listOpen) { if (index >= 0) setList(false); return; }
    next();
  }
  window.addEventListener('keydown', onKey, true);
  transcript.addEventListener('click', onTap);
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); next(); });
  backBtn.addEventListener('click', (e) => { e.stopPropagation(); prev(); });
  skipBtn.addEventListener('click', (e) => { e.stopPropagation(); close('skip'); });
  chapterBtn.addEventListener('click', (e) => { e.stopPropagation(); setList(!listOpen); });

  // The panel changes under the tour: a resize replays the beat's places, the ring and the arms;
  // the empty state going away (the user sent a message, the session closed) ends the tour at once.
  let resizeTimer = 0;
  const onResize = () => {
    if (done) return;
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height || !root.isConnected) { close('gone'); return; }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (done) return;
      board.measure();
      actor?.measure();
      const p = place ? fitPlace(typeof place === 'object' && place?.beside ? besidePlace(place.beside, place.scale) : places[place]?.()) : null;
      if (place) actor?.replay(p?.point || null);
      if (ringTarget) ring.refresh(targetRect(ringTarget), ringShapeFor(ringTarget));
      if (ringTarget && actor?.rig.pointing) {
        const els = resolve(ringTarget);
        if (els) setTimeout(() => { if (!done) actor.point(els.length > 1 ? rectOfEls(els) : els[0], { gap: ringGap(ringTarget) }); }, 260);
      }
    }, 120);
  };
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(root);
  window.addEventListener('resize', onResize);
  // A send parks the hero (it stays the character on screen until the "Thinking" row takes it), so the
  // empty state going is the signal, not the mascot changing.
  const emptyWatch = new MutationObserver(() => {
    if (done) return;
    const now = renderer.mascot?.();
    if (!transcript.querySelector(':scope > .asst-empty') || (hero && (now !== hero || hero.parked?.()))) close('sent');
  });
  emptyWatch.observe(transcript, { childList: true });
  function teardownInput() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    transcript.removeEventListener('click', onTap);
    resizeObserver?.disconnect();
    emptyWatch.disconnect();
    clearTimeout(resizeTimer);
  }

  return {
    play,
    next,
    prev,
    close,
    openList,
    hurry,
    get index() { return index; },
    get ready() { return ready; },
    get done() { return done; },
    get listOpen() { return listOpen; },
    get beat() { return beats[index] || null; },
    /** The last landing the mascot was given, as asked and as fitted clear of the board's ink (tests read it). */
    get layout() { return lastFit ? JSON.parse(JSON.stringify(lastFit)) : null; },
    actor,
    board,
    page,
    ring,
    caption,
  };
}
