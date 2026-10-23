// ═══════════════════════════════════════════
// SynaBun Assistant — waiting for a usage limit to reset
// ═══════════════════════════════════════════
// Where a provider's usage limit stopped work (the Assistant's own turn: its
// error row; a worker: its run card), this card waits with the user: the
// mascot dozes inside a gold ring that fills toward the reset, a live
// hh:mm:ss countdown and the local reset time beside it. At zero it wakes
// ("Usage limit restored") and offers Retry now. With no reset time known it
// waits with "Reset time unknown" and offers the retry at once. The clock is
// the shared ticker at 1 fps, only while it counts and only while the card is
// on the page; under prefers-reduced-motion the mascot is a still and nothing
// eases. Its sheet is its own (injectLimitWaitStyles), like the rack's.

import * as mascotLib from '../synabun-mascot.js';
import { isReducedMotion, subscribe } from '../synabun-ticker.js';
import { limitCountdown, resetMs } from './asst-limit.js';

const RING_R = 24;
const DAY_MS = 86_400_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function reducedMotion() {
  try { return !!isReducedMotion(); } catch { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
}

/** The reset as the user's clock reads it: "06:01", or "Fri 06:01" when it is not within the next day. */
function localTime(ms, now) {
  const opts = { hour: '2-digit', minute: '2-digit' };
  if (Math.abs(ms - now) >= DAY_MS || new Date(ms).toDateString() !== new Date(now).toDateString()) opts.weekday = 'short';
  try { return new Date(ms).toLocaleString([], opts); } catch { return new Date(ms).toISOString().slice(11, 16); }
}

/**
 * createLimitWait({ t, resetsAt, since, provider, onRetry, retryLabel, announce(text) })
 * → { el, get state(), update({ resetsAt, since }), retried(), stale(), destroy() }
 * `resetsAt`: epoch ms / s or ISO, or null (unknown). `since`: when the wait began (the ring's start).
 * `provider`: the name in the meta line ("Codex"). `onRetry()`: Retry now; null: no button.
 */
export function createLimitWait(opts = {}) {
  injectLimitWaitStyles();
  const t = (key, fallback, params) => {
    const v = typeof opts.t === 'function' ? opts.t(key, fallback, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };
  let resetsAt = resetMs(opts.resetsAt);
  let since = Number.isFinite(opts.since) ? opts.since : Date.now();
  let state = '';
  let unsub = null;
  let rig = null;
  let pose = '';
  let seenConnected = false;
  let destroyed = false;

  const card = el('div', 'asst-limit-wait');
  card.setAttribute('role', 'group');
  card.innerHTML = `
    <div class="asst-limit-wait-stage" aria-hidden="true">
      <svg class="asst-limit-ring" viewBox="0 0 56 56" width="56" height="56" focusable="false">
        <circle class="asst-limit-ring-track" cx="28" cy="28" r="${RING_R}"></circle>
        <circle class="asst-limit-ring-fill" cx="28" cy="28" r="${RING_R}" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"></circle>
      </svg>
      <span class="asst-limit-wait-face"></span>
    </div>
    <div class="asst-limit-wait-main">
      <div class="asst-limit-wait-title"></div>
      <div class="asst-limit-wait-clock" role="timer" aria-live="off"></div>
      <div class="asst-limit-wait-meta"></div>
      <div class="asst-limit-wait-actions"></div>
    </div>
    <span class="asst-limit-wait-live" role="status" aria-live="polite"></span>`;
  const $ = (sel) => card.querySelector(sel);
  const fill = $('.asst-limit-ring-fill');
  const face = $('.asst-limit-wait-face');
  const title = $('.asst-limit-wait-title');
  const clock = $('.asst-limit-wait-clock');
  const meta = $('.asst-limit-wait-meta');
  const actions = $('.asst-limit-wait-actions');
  const live = $('.asst-limit-wait-live');

  let retryBtn = null;
  if (typeof opts.onRetry === 'function') {
    retryBtn = el('button', 'asst-btn asst-btn-primary asst-limit-wait-retry');
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () => {
      if (state !== 'restored' && state !== 'unknown') return;
      retried();
      try { opts.onRetry(); } catch { /* the host reports its own failure */ }
    });
    actions.appendChild(retryBtn);
  }

  function setPose(next) {
    if (pose === next || destroyed) return;
    pose = next;
    if (reducedMotion()) {
      try { rig?.destroy(); } catch { /* gone */ }
      rig = null;
      face.innerHTML = mascotLib.mascotSvg({ width: 34, height: 17, className: 'synabun-mascot asst-still' });
      try { mascotLib.paintMascot(face.firstElementChild, mascotLib.stillFrame(next)); } catch { /* the plain face */ }
      return;
    }
    if (!rig) {
      face.textContent = '';
      try { rig = mascotLib.createMascot(face, { width: 34, height: 17, pose: next }); return; } catch { rig = null; }
    }
    try { rig?.setPose(next, next === 'success' ? { then: 'idle' } : undefined); } catch { /* keeps its pose */ }
  }

  function setRing(progress, indeterminate = false) {
    fill.setAttribute('stroke-dashoffset', String(Math.round((1 - Math.max(0, Math.min(1, progress))) * 1000) / 10));
    card.classList.toggle('is-indeterminate', indeterminate);
  }

  function paintMeta(now) {
    const bits = [];
    if (opts.provider) bits.push(t('assistant.limitWait.provider', '{provider} usage limit', { provider: opts.provider }));
    if (resetsAt !== null) bits.push((state === 'restored' || state === 'retried' || (state === 'stale' && resetsAt <= now)) ? t('assistant.limitWait.resetAt', 'reset at {time}', { time: localTime(resetsAt, now) }) : t('assistant.limitWait.resetsAt', 'resets at {time}', { time: localTime(resetsAt, now) }));
    meta.textContent = bits.join(' · ');
    meta.hidden = !bits.length;
  }

  function setState(next, now = Date.now()) {
    const was = state;
    state = next;
    card.dataset.state = next;
    card.dataset.known = resetsAt === null ? '0' : '1';
    card.setAttribute('aria-label', next === 'restored' || next === 'retried' ? t('assistant.limitWait.restored', 'Usage limit restored') : t('assistant.limitWait.waiting', 'Waiting for the usage limit to reset'));
    title.textContent = next === 'restored' || next === 'retried'
      ? t('assistant.limitWait.restored', 'Usage limit restored')
      : next === 'stale' && resetsAt !== null && resetsAt <= now ? t('assistant.limitWait.restored', 'Usage limit restored')
        : t('assistant.limitWait.waiting', 'Waiting for the usage limit to reset');
    if (next === 'unknown') { clock.textContent = t('assistant.limitWait.unknown', 'Reset time unknown'); clock.classList.add('is-text'); clock.removeAttribute('aria-label'); }
    if (next === 'restored' || next === 'retried') { clock.textContent = '00:00:00'; clock.classList.remove('is-text'); clock.removeAttribute('aria-label'); }
    if (retryBtn) {
      retryBtn.hidden = !(next === 'restored' || next === 'unknown' || next === 'retried');
      retryBtn.disabled = next === 'retried' || next === 'stale';
      const label = next === 'retried' ? t('assistant.limitWait.retried', 'Retried')
        : next === 'unknown' ? (opts.retryLabel || t('assistant.limitWait.tryAgain', 'Try again'))
          : (opts.retryLabel || t('assistant.limitWait.retry', 'Retry now'));
      retryBtn.textContent = label;
    }
    if (next === 'waiting') { setPose('sleep'); setRing(limitCountdown({ resetsAt, since }, now).progress || 0); }
    else if (next === 'unknown') { setPose('wait'); setRing(0.18, true); }
    else if (next === 'restored') { setPose(was === 'waiting' ? 'success' : 'idle'); setRing(1); }
    else { setPose('idle'); setRing(resetsAt !== null && resetsAt <= now ? 1 : 0); }
    if (next === 'restored' && was === 'waiting') live.textContent = t('assistant.limitWait.announceRestored', 'The usage limit has reset.');
    paintMeta(now);
    syncTicker();
  }

  function tick(now = Date.now()) {
    if (destroyed) return;
    if (card.isConnected) seenConnected = true;
    else if (seenConnected) { destroy(); return; }
    if (state !== 'waiting') { syncTicker(); return; }
    const view = limitCountdown({ resetsAt, since }, now);
    if (view.done) { setState('restored', now); return; }
    if (clock.textContent !== view.clock) {
      clock.textContent = view.clock;
      clock.classList.remove('is-text');
      clock.setAttribute('aria-label', t('assistant.limitWait.left', '{clock} left', { clock: view.clock }));
    }
    setRing(view.progress);
  }

  function syncTicker() {
    const want = state === 'waiting' && !destroyed;
    if (want && !unsub) { try { unsub = subscribe((now) => tick(typeof now === 'number' && now > 1e12 ? now : Date.now()), { fps: 1 }); } catch { unsub = null; } }
    else if (!want && unsub) { try { unsub(); } catch { /* gone */ } unsub = null; }
  }

  function start(now = Date.now()) {
    if (resetsAt === null) setState('unknown', now);
    else if (resetsAt <= now) setState('restored', now);
    else { setState('waiting', now); tick(now); }
  }

  function retried() {
    if (state === 'retried' || state === 'stale') return;
    setState('retried');
  }
  function stale() {
    if (state === 'retried' || state === 'stale') return;
    setState('stale');
    if (state === 'stale') {
      clock.classList.add('is-text');
      clock.removeAttribute('aria-label');
      clock.textContent = resetsAt !== null ? localTime(resetsAt, Date.now()) : t('assistant.limitWait.unknown', 'Reset time unknown');
    }
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (unsub) { try { unsub(); } catch { /* gone */ } unsub = null; }
    try { rig?.destroy(); } catch { /* gone */ }
    rig = null;
  }

  start();
  return {
    el: card,
    get state() { return state; },
    get resetsAt() { return resetsAt; },
    /** A reset time learned later (a structured report): the card counts to it. Ignored once it is settled. */
    update({ resetsAt: next, since: from } = {}) {
      if (destroyed || state === 'retried' || state === 'stale') return;
      const ms = resetMs(next);
      if (Number.isFinite(from)) since = from;
      if (ms === null || ms === resetsAt) return;
      resetsAt = ms;
      start();
    },
    retried,
    stale,
    destroy,
  };
}

const CSS = `
  .asst-limit-wait {
    --lw-tone: var(--asst-brand);
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 12px 14px;
    border-radius: var(--asst-r-card);
    background: linear-gradient(135deg, color-mix(in srgb, var(--asst-brand) 8%, transparent), var(--asst-fill-1) 62%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--asst-brand) 26%, transparent), var(--asst-card-hi);
    color: var(--asst-text);
    font-size: 13px;
    transition: box-shadow var(--asst-dur-base) var(--asst-ease-standard), background-color var(--asst-dur-base) var(--asst-ease-standard);
  }
  .asst-limit-wait:is([data-state="stale"], [data-state="retried"]) {
    --lw-tone: var(--asst-text-3);
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--asst-line);
  }
  .asst-limit-wait-stage { position: relative; width: 56px; height: 56px; }
  .asst-limit-ring { display: block; width: 56px; height: 56px; transform: rotate(-90deg); overflow: visible; }
  .asst-limit-ring-track { fill: none; stroke: var(--asst-line-2); stroke-width: 3; }
  .asst-limit-ring-fill {
    fill: none;
    stroke: var(--lw-tone);
    stroke-width: 3;
    stroke-linecap: round;
    transform-box: fill-box;
    transform-origin: center;
    transition: stroke-dashoffset 1s linear, stroke var(--asst-dur-base) var(--asst-ease-standard);
  }
  .asst-limit-wait[data-state="restored"] .asst-limit-ring-fill { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--asst-brand) 55%, transparent)); }
  .asst-limit-wait.is-indeterminate .asst-limit-ring-fill { stroke-dasharray: 18 82; animation: asst-limit-orbit 2.6s linear infinite; }
  @keyframes asst-limit-orbit { to { transform: rotate(360deg); } }
  .asst-limit-wait-face { position: absolute; inset: 0; display: grid; place-items: center; color: var(--lw-tone); line-height: 0; }
  .asst-limit-wait-face svg { display: block; width: 34px; height: 17px; }
  .asst-limit-wait-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .asst-limit-wait-title { color: var(--asst-text-2); font-size: 12px; font-weight: 500; }
  .asst-limit-wait[data-state="restored"] .asst-limit-wait-title { color: var(--asst-brand); }
  .asst-limit-wait-clock { color: var(--asst-text); font-family: var(--asst-mono); font-size: 20px; font-weight: 500; line-height: 1.2; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
  .asst-limit-wait-clock.is-text { font-family: inherit; font-size: 13px; color: var(--asst-text-2); letter-spacing: 0; }
  .asst-limit-wait-meta { color: var(--asst-text-3); font-size: 11.5px; overflow-wrap: anywhere; }
  .asst-limit-wait-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .asst-limit-wait-actions:not(:has(> :not([hidden]))) { display: none; }
  .asst-limit-wait-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .asst-limit-row .asst-msg-content { width: 100%; }
  .asst-run .asst-limit-wait { grid-column: 2 / span 2; margin-top: 8px; padding: 10px 12px; }
  @container asst (max-width: 320px) {
    .asst-limit-wait { grid-template-columns: 44px minmax(0, 1fr); gap: 10px; padding: 10px; }
    .asst-limit-wait-stage, .asst-limit-ring { width: 44px; height: 44px; }
    .asst-limit-wait-face svg { width: 28px; height: 14px; }
    .asst-limit-wait-clock { font-size: 17px; }
  }
  body.ui-interacting .asst-limit-ring-fill { animation-play-state: paused !important; }
  @media (prefers-reduced-motion: reduce) {
    .asst-limit-wait, .asst-limit-wait * { animation: none !important; transition: none !important; }
  }
`;

/** The card's sheet, once per page. */
export function injectLimitWaitStyles() {
  if (typeof document === 'undefined' || document.getElementById('asst-limit-wait-styles')) return;
  const style = document.createElement('style');
  style.id = 'asst-limit-wait-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
