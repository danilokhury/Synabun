// ═══════════════════════════════════════════
// SynaBun Assistant — the follow-ups card the mascot presents
// ═══════════════════════════════════════════
// One set of items (asst-followups.js) under the message that offered them,
// presented by the mascot (asst-ask.js) in the set's style:
//   next       quick actions: one click (Enter, Space or its number) sends one
//   decisions  independent picks: checkboxes, the mascot ticks its clipboard
//              per pick, one Send for all of them (⌘/Ctrl+Enter)
//   confirm    one proposed action: go ahead (the focused primary, Enter) or
//              not now (the block's second item, else the card's own)
//   question   the mascot asks: pick an answer (radios, the recommended one
//              badged) or type your own, then Send (Enter)
// "Something else…" (and Esc anywhere in the card) is the composer. The card
// is open until the user's next message answers it (the picks stay gold; for
// a question, whatever they said) or a newer turn starts (stale); either way
// it folds into one line with a still face, the "got it" face when answered.
// That is read from the transcript (settleFollowups), so a reload draws the
// same states as the live panel. While it is the newest open card of its
// panel its face is a live rig (asst-render.js decides); otherwise a still.
// Buttons and one text field only: no native select.

import { confirmSet, followupMessage, FOLLOWUP_LIMITS, FOLLOWUP_STYLES, settleFollowups } from './asst-followups.js';
import {
  askOption, createPresenter, injectAskStyles, keyRange, sendModifier, setOptionChecked,
  wireCardKeys, wireGaze, wireOptionGroup, wireWatch,
} from './asst-ask.js';

/** The pose the mascot presents each style in (synabun-mascot.js MASCOT_CARD_POSES). */
export const FOLLOWUP_POSES = Object.freeze({ next: 'present', decisions: 'pick', confirm: 'present', question: 'ask' });
const SEND_HOLD_MS = 340; // a sent card keeps its picks on show while the mascot hops, then folds
const ICON_CHECK = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>';
let seq = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, label, icon = '') {
  const btn = el('button', className);
  btn.type = 'button';
  if (icon) {
    const glyph = el('span', 'asst-btn-icon');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = icon;
    btn.appendChild(glyph);
  }
  btn._label = btn.appendChild(el('span', 'asst-btn-label', label));
  return btn;
}

/**
 * createFollowupsCard(set, { t(key, fallback, params), onSend(text, { set, indices, text? }), onOther(),
 *   onFocusComposer?(), entrance? })
 * → { el, set, presenter, get state(), isOpen(), answer(indices), stale(), settle(text) → bool, destroy(), onChange }
 * `settle(text)`: the user's next message reached the transcript; it answers the card when it is one of
 * its items (several, one per line, for decisions; anything typed, for a question), else the card goes
 * stale. `onChange` (set by the renderer): the card stopped being open. `entrance`: the reaction the
 * mascot plays when the card first goes live (none for a card drawn from the journal).
 */
export function createFollowupsCard(input, hooks = {}) {
  injectAskStyles();
  const t = (key, fallback, params) => {
    const v = typeof hooks.t === 'function' ? hooks.t(key, fallback, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };
  const style = FOLLOWUP_STYLES.includes(input?.style) ? input.style : (input?.multi === true && input.items?.length > 1 ? 'decisions' : 'next');
  const set = confirmSet({ ...input, style, multi: style === 'decisions' }, { label: t('assistant.followups.hold', 'Not now'), send: t('assistant.followups.holdSend', 'Hold off on that for now.') });
  const items = set.items;
  const multi = style === 'decisions';
  const id = `asst-ask-${(seq += 1)}`;
  let state = 'open';
  let chosen = [];
  let typedAnswer = '';
  const picked = new Set();
  let sendTimer = 0;

  const card = el('div', 'asst-followups asst-ask');
  card.dataset.state = state;
  card.dataset.style = style;
  card.dataset.mode = multi ? 'multi' : 'single';
  card.dataset.source = set.source || 'block';
  card.setAttribute('role', 'group');
  card.setAttribute('aria-labelledby', `${id}-title`);
  if (set.source === 'heuristic') card.title = t('assistant.followups.guessed', 'Read from the reply: check the wording before you send');

  // The stage: the mascot and what it says, side by side (the rack's stage); the answers run full width under it.
  const presenter = createPresenter({ pose: FOLLOWUP_POSES[style], options: multi ? { ticks: 0 } : null, entrance: hooks.entrance || null });
  const stage = el('div', 'asst-ask-stage');
  stage.appendChild(presenter.el);
  card.appendChild(stage);

  // What the mascot says: the block's title (a question's own words), else its style's stock line.
  const titleText = style === 'question' ? (set.question || set.title || t('assistant.followups.titleQuestion', 'Your call'))
    : set.title || (multi ? t('assistant.followups.titleMulti', 'Your decisions')
      : style === 'confirm' ? t('assistant.followups.titleConfirm', 'Go ahead?')
        : t('assistant.followups.title', 'Next steps'));
  const bubble = el('div', 'asst-ask-bubble is-lead');
  const title = el('div', 'asst-ask-title', titleText);
  title.id = `${id}-title`;
  bubble.appendChild(title);
  const hintText = multi ? t('assistant.followups.hintMulti', 'Pick any, then send')
    : style === 'question' ? t('assistant.followups.hintQuestion', 'Pick one, or type your own answer')
      : style === 'confirm' ? (items[0]?.description || '') : '';
  if (hintText) bubble.appendChild(el('div', 'asst-ask-hint', hintText));
  stage.appendChild(bubble);

  // The answers: action buttons (next), checkboxes (decisions) or radios (question). A confirm has none: its
  // two choices are the action buttons.
  let buttons = [];
  let group = null;
  if (style !== 'confirm') {
    group = el('div', 'asst-ask-options');
    group.setAttribute('role', style === 'question' ? 'radiogroup' : 'group');
    group.setAttribute('aria-labelledby', `${id}-title`);
    const role = style === 'question' ? 'radio' : multi ? 'checkbox' : '';
    buttons = items.map((item, index) => {
      const btn = askOption({
        label: item.label,
        description: item.description,
        index,
        role,
        badge: item.recommended ? t('assistant.followups.recommended', 'Recommended') : '',
        go: style === 'next',
        // The message it sends, when it says more than the label.
        title: item.send && item.send !== item.label ? item.send : '',
      });
      btn.addEventListener('click', () => onOption(index));
      if (style === 'question') btn.addEventListener('dblclick', () => { if (state === 'open') send([index]); });
      group.appendChild(btn);
      return btn;
    });
    card.appendChild(group);
  }

  // A question also takes a typed answer: Enter sends it.
  let field = null;
  if (style === 'question') {
    const row = el('div', 'asst-ask-answer');
    field = el('input', 'asst-ask-input');
    field.type = 'text';
    field.maxLength = FOLLOWUP_LIMITS.send;
    field.placeholder = t('assistant.control.customAnswer', 'Or type your own answer…');
    field.setAttribute('aria-label', t('assistant.followups.answerLabel', 'Your answer'));
    field.addEventListener('input', () => {
      if (field.value.trim()) picked.clear();
      paint();
    });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); submit(); return; }
      if (e.key === 'Escape') return; // the card's: back to the composer
      e.stopPropagation(); // global keybinds stay out of a field
    });
    row.appendChild(field);
    card.appendChild(row);
  }

  const actions = el('div', 'asst-ask-actions');
  let sendBtn = null;
  let primary = null;
  let secondary = null;
  let other = null;
  if (multi || style === 'question') {
    sendBtn = button('asst-btn asst-btn-primary asst-ask-send', t('assistant.followups.send', 'Send'));
    sendBtn.disabled = true;
    sendBtn.addEventListener('click', submit);
    actions.appendChild(sendBtn);
  }
  if (style === 'confirm') {
    // The proposed action, and the way to say no (the block's second item, else "Not now").
    const choice = (item, index, className, icon) => {
      const btn = button(className, item.label, icon);
      btn.dataset.index = String(index);
      btn.setAttribute('data-ask-option', '');
      if (item.send && item.send !== item.label) btn.title = item.send;
      btn.addEventListener('click', () => { if (state === 'open') send([index]); });
      actions.appendChild(btn);
      return btn;
    };
    primary = choice(items[0], 0, 'asst-btn asst-btn-primary asst-ask-proceed', ICON_CHECK);
    secondary = choice(items[1], 1, 'asst-btn asst-btn-secondary asst-ask-hold');
  }
  if (style !== 'question') {
    other = button('asst-btn asst-ask-other', t('assistant.followups.other', 'Something else…'));
    other.title = t('assistant.followups.otherTip', 'Type your own reply in the message box');
    other.addEventListener('click', () => { if (state === 'open') hooks.onOther?.(); });
    actions.appendChild(other);
  }
  const keyHint = el('span', 'asst-ask-keys', keysText());
  keyHint.id = `${id}-keys`;
  actions.appendChild(keyHint);
  card.appendChild(actions);
  (group || actions).setAttribute('aria-describedby', keyHint.id);

  // What it folds into once answered or left behind.
  const receipt = el('div', 'asst-ask-receipt');
  card.appendChild(receipt);

  function keysText() {
    const keys = keyRange(items.length);
    if (style === 'confirm') return t('assistant.followups.keysConfirm', 'Enter to go ahead · Esc to type your own');
    if (style === 'question') return t('assistant.followups.keysQuestion', '{keys} to pick · Enter to send', { keys });
    if (multi) return t('assistant.followups.keysMulti', '{keys} to pick · {mod}+Enter to send · Esc to type your own', { keys, mod: sendModifier() });
    return t('assistant.followups.keysNext', '{keys} to send · Esc to type your own', { keys });
  }

  function paint() {
    buttons.forEach((btn, i) => setOptionChecked(btn, picked.has(i)));
    if (sendBtn) {
      const typed = !!field?.value.trim();
      sendBtn.disabled = state !== 'open' || !(picked.size || typed);
      sendBtn._label.textContent = multi && picked.size > 1
        ? t('assistant.followups.sendCount', 'Send {n} selected', { n: picked.size })
        : t('assistant.followups.send', 'Send');
    }
    optionGroup?.sync();
  }

  /** A click (or its key) on answer `index`: next sends it, decisions ticks it, a question picks it. */
  function onOption(index) {
    if (state !== 'open') return;
    if (style === 'next') { send([index]); return; }
    if (multi) {
      const on = !picked.has(index);
      if (on) picked.add(index); else picked.delete(index);
      paint();
      presenter.setPose('pick', { ticks: Math.min(3, picked.size) });
      if (on) presenter.react('pop');
      return;
    }
    const was = picked.has(index);
    picked.clear();
    picked.add(index);
    if (field?.value) field.value = '';
    paint();
    if (!was) presenter.react('nod');
  }

  function submit() {
    if (state !== 'open') return;
    const typed = field?.value.trim() || '';
    if (typed) send([], typed);
    else if (picked.size) send([...picked]);
  }

  function focusInside() {
    try { return !!card.contains?.(document.activeElement); } catch { return false; }
  }

  function send(indices = [], typed = '') {
    if (state !== 'open') return;
    const text = typed || followupMessage(set, indices);
    if (!text) return;
    const hadFocus = focusInside();
    answered(indices, typed, { hop: true });
    hooks.onSend?.(text, typed ? { set: input, indices: [], text: typed } : { set: input, indices: chosen });
    if (hadFocus) (hooks.onFocusComposer || hooks.onOther)?.();
  }

  function disableAll() {
    for (const node of [...buttons, sendBtn, primary, secondary, other].filter(Boolean)) node.disabled = true;
    if (field) { field.disabled = true; field.readOnly = true; }
  }

  function notify() {
    try { api.onChange?.(); } catch { /* the renderer is gone */ }
  }

  /** Answered: the picks keep the gold, the mascot hops (a live click) and settles on its "got it" face. */
  function answered(indices = [], typed = '', { hop = false } = {}) {
    if (state !== 'open') return;
    state = 'answered';
    chosen = [...new Set(indices)].filter((i) => i >= 0 && i < items.length).sort((a, b) => a - b);
    typedAnswer = typed;
    card.dataset.state = 'answered';
    picked.clear();
    buttons.forEach((btn, i) => {
      const on = chosen.includes(i);
      setOptionChecked(btn, on);
      btn.classList.remove('selected');
      btn.classList.toggle('chosen', on);
    });
    [primary, secondary].forEach((btn, i) => btn?.classList.toggle('chosen', chosen.includes(i)));
    if (field && typed) field.value = typed;
    disableAll();
    const live = hop && presenter.isLive();
    presenter.settle('success', {}, { hop: live });
    if (live) {
      card.dataset.phase = 'sending';
      sendTimer = setTimeout(() => { sendTimer = 0; delete card.dataset.phase; }, SEND_HOLD_MS);
    }
    renderReceipt();
    notify();
  }

  /** Left behind (a newer turn, or the user wrote something else): nothing clicks, a dim still. */
  function stale() {
    if (state !== 'open') return;
    state = 'stale';
    card.dataset.state = 'stale';
    picked.clear();
    paint();
    disableAll();
    presenter.settle('idle');
    renderReceipt();
    notify();
  }

  function renderReceipt() {
    receipt.textContent = '';
    receipt.appendChild(el('span', 'asst-ask-receipt-title', titleText));
    if (state === 'answered') {
      const arrow = el('span', 'asst-ask-receipt-arrow', '→');
      arrow.setAttribute('aria-hidden', 'true');
      receipt.appendChild(arrow);
      const picks = typedAnswer ? [`“${typedAnswer}”`] : chosen.map((i) => items[i]?.label).filter(Boolean);
      for (const pick of picks) receipt.appendChild(el('span', 'asst-ask-chip', pick));
      receipt.appendChild(el('span', 'asst-ask-receipt-status', style === 'question'
        ? t('assistant.followups.answered', 'Answered')
        : t('assistant.followups.sent', 'Sent')));
    } else if (state === 'stale') {
      receipt.appendChild(el('span', 'asst-ask-receipt-list', items.filter((item) => !item.hold).map((item) => item.label).join(' · ')));
      receipt.appendChild(el('span', 'asst-ask-receipt-status', t('assistant.followups.earlier', 'Earlier')));
    }
  }

  // ── Keys and gaze ──
  const optionGroup = group
    ? wireOptionGroup(group, { options: () => buttons, onMove: (_btn, i) => { if (style === 'question') onOption(i); } })
    : (style === 'confirm' ? wireOptionGroup(actions, { options: () => [primary, secondary] }) : null);
  wireCardKeys(card, {
    options: () => (style === 'confirm' ? [primary, secondary] : buttons),
    onPick: (i, btn) => {
      if (state !== 'open') return;
      if (style === 'confirm') { send([i]); return; }
      try { btn?.focus(); } catch { /* not focusable here */ }
      onOption(i);
    },
    onComposer: () => (hooks.onFocusComposer || hooks.onOther)?.(),
    onEnter: (e) => {
      if (state !== 'open') return false;
      if (multi && (e.metaKey || e.ctrlKey)) { submit(); return true; }
      if (style === 'question' && e.target?.getAttribute?.('role') === 'radio') {
        const i = Number(e.target.dataset.index);
        if (!picked.has(i)) onOption(i);
        submit();
        return true;
      }
      return false;
    },
  });
  wireGaze(card, presenter);
  presenter.setHome(buttons[0] || primary || bubble);
  if (field) wireWatch(field, presenter);
  paint();

  const api = {
    el: card,
    set: input,
    presenter,
    get state() { return state; },
    isOpen: () => state === 'open',
    answer(indices) { answered(indices || []); },
    stale,
    settle(text) {
      if (state !== 'open') return state === 'answered';
      const result = settleFollowups(set, text);
      if (result.state === 'answered') { answered(result.indices, result.text); return true; }
      stale();
      return false;
    },
    destroy() {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = 0;
      presenter.destroy();
    },
    onChange: null,
  };
  return api;
}
