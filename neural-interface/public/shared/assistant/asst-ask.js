// ═══════════════════════════════════════════
// SynaBun Assistant — the cards the mascot presents: the shared kit
// ═══════════════════════════════════════════
// What a finished turn offers (the follow-ups card, asst-followups-card.js)
// and what the brain asks (the question cards of asst-control.js: agent_clarify,
// AskUserQuestion, Codex's choice and requestUserInput, OpenCode's question)
// are drawn the same way: the mascot beside the card, presenting, asking and
// reacting, its words in a bubble and the answers under it. This module is the
// part they share:
//
// - createPresenter(): the mascot's slot. A painted still (paintMascot +
//   stillFrame, never a rig) until the renderer makes it live (setLive): then a
//   rig from synabun-mascot.js, drawn by the one shared ticker and parked off
//   screen by the rig's own observer. Only the newest open card of a panel is
//   live, and none while calm (replay, reduced motion, a drag): asst-render.js
//   activateRigs. `target` is what the panel's director (asst-mascot.js) dresses
//   while this presenter is the character on screen; `waits` marks a card that
//   waits on the user itself (a question card), which the director never
//   poses "blocked" at its own card.
// - askOption() / setOptionChecked(): one option row (key · label · description
//   · badge), the same markup in both kinds of card.
// - optionKeyIntent() (pure) and the wiring around it: one tab stop per option
//   group (arrows, Home, End), 1-9 pick an option while focus is in the card,
//   Esc goes back to the composer; the mascot looks at the option pointed at
//   or focused (wireGaze) and watches a text field being typed in (wireWatch).
// Nothing touches the DOM at import: the server imports asst-control.js
// (WhatsApp cards) and node:test draws cards with a stand-in document.

import * as mascotLib from '../synabun-mascot.js';
import { isReducedMotion } from '../synabun-ticker.js';
import { lookToward } from './asst-mascot.js';
import { injectAskStyles } from './asst-ask-styles.js';

export { injectAskStyles };

/** The presenter's SVG, before the sheet's container queries shrink it. */
export const PRESENTER_SIZE = Object.freeze({ width: 64, height: 32 });
const HOP_MS = 320; // the hop (300 ms) and a frame to land on
const WATCH_IDLE_MS = 1500; // a field nobody typed in for this long: back to the card's own pose
const WATCH_EVERY_MS = 120; // the caret is looked at no more often than this
// Where a still looks: toward what the card offers (the answers sit right of the face and under it).
const STILL_LOOK = Object.freeze({ present: { x: 0.5, y: 0.35 }, pick: { x: 0.5, y: 0.25 }, ask: { x: 0.35, y: -0.15 }, success: { x: 0, y: 0 }, idle: { x: 0, y: 0 } });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function reduced() {
  try { return !!isReducedMotion(); } catch { return false; }
}

const centre = (node) => {
  try {
    const r = node?.getBoundingClientRect?.();
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  } catch { return null; }
};

/** A text field: typing there never picks an option (1-9 are its characters). */
export function isTextField(node) {
  const tag = String(node?.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!node?.isContentEditable;
}

/**
 * createPresenter({ pose, options, waits, entrance })
 * → { el, target, setLive(on), isLive(), setPose(name, opts), react(name), lookAt(node|null), setHome(node),
 *     watch(point), unwatch(), settle(pose, opts, { hop }), destroy() }
 * `pose` / `options`: the card's own pose (present, pick, ask). `entrance`: the reaction it plays the first
 * time it goes live (none on a card drawn while calm). settle(): the card is answered or left behind: the
 * still it ends on ('success' is the "got it" face), after the hop when `hop` and it is live.
 */
export function createPresenter({ pose = 'present', options = null, waits = false, entrance = null } = {}) {
  const face = el('span', 'asst-ask-face');
  face.setAttribute('aria-hidden', 'true');
  let want = { pose, options: options && typeof options === 'object' ? { ...options } : {} };
  let rig = null;
  let held = false; // the director dresses the rig (asst-mascot.js hold / restore)
  let watching = false;
  let watchedAt = -Infinity;
  let final = null; // { pose, opts }: settled, a still from now on
  let leaving = 0; // the hop plays out before the settled still
  let destroyed = false;
  let home = null; // what it looks at when nothing is pointed at
  let looking = null; // what it looks at now
  let entered = false;

  const stillOpts = (name, opts = {}) => ({ ...opts, look: opts.look || STILL_LOOK[name] || { x: 0, y: 0 } });

  function dropRig() {
    if (!rig) return;
    try { rig.destroy(); } catch { /* gone */ }
    rig = null;
  }

  function paintStill(name, opts) {
    dropRig();
    try {
      face.innerHTML = mascotLib.mascotSvg({ width: PRESENTER_SIZE.width, height: PRESENTER_SIZE.height, className: 'synabun-mascot asst-still' });
      const svg = face.firstElementChild;
      if (svg && typeof svg.setAttribute === 'function') {
        svg.setAttribute('data-pose', name);
        mascotLib.paintMascot(svg, mascotLib.stillFrame(name, stillOpts(name, opts)));
      }
    } catch { /* no SVG here (a stand-in document): the card reads without its face */ }
  }

  function look(node) {
    looking = node || null;
    if (!rig || held || watching || final) return;
    const point = centre(looking || home);
    if (!point) return;
    let box = null;
    try { box = rig.el.getBoundingClientRect(); } catch { box = null; }
    const to = lookToward(box, point);
    try { rig.look(to.x, to.y); } catch { /* gone */ }
  }

  function applyWant() {
    if (!rig || held || watching || final) return;
    try { rig.setPose(want.pose, want.options); } catch { /* keeps its pose */ }
    look(looking);
  }

  function setLive(on) {
    if (destroyed || final) return;
    if (on && !rig) {
      try {
        face.textContent = '';
        rig = mascotLib.createMascot(face, { width: PRESENTER_SIZE.width, height: PRESENTER_SIZE.height, pose: want.pose, poseOptions: want.options });
      } catch { rig = null; paintStill(want.pose, want.options); return; }
      look(looking);
      if (!entered) {
        entered = true;
        if (entrance && !reduced()) { try { rig.react(entrance); } catch { /* still */ } }
      }
    } else if (!on && rig) {
      watching = false;
      paintStill(want.pose, want.options);
    }
  }

  function settle(name = 'success', opts = {}, { hop = false } = {}) {
    if (destroyed) return;
    final = { pose: name, opts };
    watching = false;
    face.classList.add('is-settled');
    if (leaving) { clearTimeout(leaving); leaving = 0; }
    if (hop && rig && !reduced()) {
      try { rig.react('hop'); } catch { /* lands at once */ }
      leaving = setTimeout(() => { leaving = 0; if (!destroyed && final) paintStill(final.pose, final.opts); }, HOP_MS);
      return;
    }
    paintStill(name, opts);
  }

  const target = {
    kind: 'card',
    waits: !!waits,
    get rig() { return rig; },
    get el() { return rig ? rig.el : face; },
    hold(on) { held = !!on; },
    restore() { applyWant(); },
  };

  paintStill(want.pose, want.options);

  return {
    el: face,
    target,
    setLive,
    isLive: () => !!rig && !final,
    /** The card's own pose; while the director holds the rig (or a field is watched) it waits for its turn. */
    setPose(name, opts = null) {
      want = { pose: name, options: opts && typeof opts === 'object' ? { ...opts } : {} };
      if (final || destroyed) return;
      if (rig) applyWant();
      else paintStill(want.pose, want.options);
    },
    react(name) {
      if (!rig || final || destroyed || reduced()) return;
      try { rig.react(name); } catch { /* still */ }
    },
    /** Eyes on `node` (an option, a button); null: back to what it offers first. */
    lookAt: look,
    setHome(node) { home = node || null; if (!looking) look(null); },
    /** Someone types in the card's field: the watch pose, its eyes on the caret (`point`, client px). */
    watch(point) {
      if (!rig || held || final || !point) return;
      if (!watching) {
        watching = true;
        try { rig.setPose('watch'); } catch { /* keeps its pose */ }
      }
      const now = Date.now();
      if (now - watchedAt < WATCH_EVERY_MS) return;
      watchedAt = now;
      let box = null;
      try { box = rig.el.getBoundingClientRect(); } catch { box = null; }
      const to = lookToward(box, point, { horizontal: true });
      try { rig.look(to.x, to.y); } catch { /* gone */ }
    },
    unwatch() {
      if (!watching) return;
      watching = false;
      applyWant();
    },
    settle,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (leaving) { clearTimeout(leaving); leaving = 0; }
      dropRig();
    },
  };
}

// ── Options ──

/**
 * One option row: [key] label · description [badge] [↵]. `role` 'radio' / 'checkbox' (or none: a plain
 * action button). The key shows its number shortcut (1-9); a checked checkbox shows ✓ instead.
 */
export function askOption({ label, description = '', index = 0, role = '', badge = '', go = false, title = '' } = {}) {
  const btn = el('button', 'asst-ask-option');
  btn.type = 'button';
  btn.dataset.index = String(index);
  btn.setAttribute('data-ask-option', '');
  if (role) {
    btn.setAttribute('role', role);
    btn.setAttribute('aria-checked', 'false');
  }
  if (title) btn.title = title;
  const key = el('span', 'asst-ask-key', index < 9 ? String(index + 1) : '');
  key.setAttribute('aria-hidden', 'true');
  btn.appendChild(key);
  const main = el('span', 'asst-ask-main');
  main.appendChild(el('span', 'asst-ask-label', label));
  if (description) main.appendChild(el('span', 'asst-ask-desc', description));
  btn.appendChild(main);
  if (badge) btn.appendChild(el('span', 'asst-ask-badge', badge));
  if (go) {
    const arrow = el('span', 'asst-ask-go', '↵');
    arrow.setAttribute('aria-hidden', 'true');
    btn.appendChild(arrow);
  }
  btn._askKey = key;
  return btn;
}

/** Check or clear an option row (aria-checked, the gold, a checkbox's ✓). */
export function setOptionChecked(btn, on) {
  if (!btn) return;
  btn.classList.toggle('selected', !!on);
  if (btn.getAttribute?.('role') || btn.attributes?.role) btn.setAttribute('aria-checked', on ? 'true' : 'false');
  const key = btn._askKey;
  const role = btn.getAttribute?.('role') || btn.attributes?.role || '';
  if (key && role === 'checkbox') {
    const index = Number(btn.dataset.index);
    key.textContent = on ? '✓' : (index < 9 ? String(index + 1) : '');
  }
}

/**
 * What a key does in a card: { composer } (Esc: back to the message box), { pick: i } (1-9, never while
 * typing in a field), { move: i } (arrows, Home, End inside an option group: `index` is the focused option,
 * -1 when focus is elsewhere), or null.
 */
export function optionKeyIntent({ key, index = -1, count = 0, typing = false, alt = false, ctrl = false, meta = false } = {}) {
  if (key === 'Escape') return { composer: true };
  if (typing || alt || ctrl || meta) return null;
  if (/^[1-9]$/.test(String(key))) {
    const i = Number(key) - 1;
    return i < count ? { pick: i } : null;
  }
  if (index < 0 || count < 1) return null;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight': return { move: (index + 1) % count };
    case 'ArrowUp':
    case 'ArrowLeft': return { move: (index - 1 + count) % count };
    case 'Home': return { move: 0 };
    case 'End': return { move: count - 1 };
    default: return null;
  }
}

const usable = (btn) => !!btn && !btn.disabled && !btn.hidden;

/**
 * One tab stop for an option group (roving tabindex): the checked option, else the first. Arrows, Home and
 * End move focus; `onMove(button, index)` follows it (a radio group checks the option, as radios do).
 */
export function wireOptionGroup(group, { options = () => [], onMove = null } = {}) {
  const all = () => (typeof options === 'function' ? options() : []) || [];
  function sync(current = null) {
    const list = all();
    const checked = list.find((b) => (b.getAttribute?.('aria-checked') || b.attributes?.['aria-checked']) === 'true');
    const pick = list.includes(current) ? current : (checked || list.find(usable) || list[0]);
    for (const b of list) b.tabIndex = b === pick ? 0 : -1;
  }
  group.addEventListener('keydown', (e) => {
    const list = all().filter(usable);
    const index = list.indexOf(e.target);
    if (index < 0) return;
    const intent = optionKeyIntent({ key: e.key, index, count: list.length, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    if (!intent || intent.move == null) return;
    e.preventDefault();
    e.stopPropagation();
    const next = list[intent.move];
    sync(next);
    try { next.focus(); } catch { /* not focusable here */ }
    onMove?.(next, intent.move);
  });
  group.addEventListener('focusin', (e) => { if (all().includes(e.target)) sync(e.target); });
  sync();
  return { sync };
}

/**
 * The card's own keys, wherever focus is inside it: 1-9 pick an option of `options()` (the group in play),
 * Esc goes back to the composer, Enter is `onEnter(event)`'s (true: handled). A key a group or a field
 * already handled (defaultPrevented) is left alone.
 */
export function wireCardKeys(card, { options = () => [], onPick = null, onComposer = null, onEnter = null } = {}) {
  card.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const list = ((typeof options === 'function' ? options() : []) || []).filter(usable);
    const typing = isTextField(e.target);
    const intent = optionKeyIntent({ key: e.key, count: list.length, typing, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    if (intent?.composer) {
      e.preventDefault();
      e.stopPropagation();
      onComposer?.();
      return;
    }
    if (intent?.pick != null) {
      e.preventDefault();
      e.stopPropagation();
      onPick?.(intent.pick, list[intent.pick]);
      return;
    }
    if (e.key === 'Enter' && typeof onEnter === 'function' && onEnter(e) === true) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

/** The presenter looks at the option pointed at or focused inside `root`, and at what it offers first when none is. */
export function wireGaze(root, presenter, { selector = '[data-ask-option]' } = {}) {
  const optionOf = (node) => {
    const hit = node?.closest?.(selector);
    return hit && root.contains?.(hit) ? hit : null;
  };
  const focusedOption = () => {
    try { return optionOf(document.activeElement); } catch { return null; }
  };
  root.addEventListener('pointerover', (e) => { const hit = optionOf(e.target); if (hit) presenter.lookAt(hit); });
  root.addEventListener('pointerleave', () => presenter.lookAt(focusedOption()));
  root.addEventListener('focusin', (e) => presenter.lookAt(optionOf(e.target)));
  root.addEventListener('focusout', (e) => { if (!root.contains?.(e.relatedTarget)) presenter.lookAt(null); });
}

/** Where a text field's caret is, roughly (client px): its left edge plus the typed width, mid-height. */
function caretOf(input) {
  try {
    const r = input.getBoundingClientRect();
    const typed = String(input.value || '').slice(0, input.selectionStart ?? undefined).length;
    return { x: r.left + Math.min(r.width - 12, 12 + typed * 7), y: r.top + r.height / 2 };
  } catch { return null; }
}

/** The presenter watches `input` while it is typed in (its eyes on the caret), and goes back to its pose 1.5 s after. */
export function wireWatch(input, presenter) {
  let timer = 0;
  const stop = () => { if (timer) clearTimeout(timer); timer = 0; presenter.unwatch(); };
  input.addEventListener('input', () => {
    presenter.watch(caretOf(input));
    if (timer) clearTimeout(timer);
    timer = setTimeout(stop, WATCH_IDLE_MS);
  });
  input.addEventListener('blur', stop);
}

/** "1–4" for four options, "1" for one: the keys a hint names. */
export function keyRange(count) {
  const n = Math.max(0, Math.min(9, Number(count) || 0));
  return n > 1 ? `1–${n}` : n === 1 ? '1' : '';
}

/** The key that sends a multi-select from anywhere in its card, as the platform names it. */
export function sendModifier() {
  try { return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '') ? '⌘' : 'Ctrl'; } catch { return 'Ctrl'; }
}
