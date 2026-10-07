// ═══════════════════════════════════════════
// SynaBun Assistant — transcript renderer
// ═══════════════════════════════════════════
// Messages, run cards, route lines and notices are rows; every burst of agent
// work (tool calls, thinking, short narration) is ONE activity rack: a stage
// where the SynaBun mascot acts out the call it is on and says the literal
// command in a bubble, a ledger with one row per tool kind (asst-tool-kinds.js)
// and a receipt once it settles (asst-rack-styles.js). Text deltas stream into
// a row throttled to 100 ms ticks and the final `assistant` message replaces
// it; a short narration directly followed by a call folds into the rack.
// Replay runs the same handleEvent path with { silent: true }: live minus
// motion, durations from the journal's `at`. Every row is inserted before the
// "Working…" indicator so it always stays last.
// The empty state's character (the hero) outlives a send only for its
// hand-off: the "Thinking" row's character flies in from the hero's box at
// once, so nothing sits on the prompt, and with no such row the hero fades
// out. mascot() names the character on screen for the panel's director
// (asst-mascot.js), which may hold its pose; stills are painted SVGs, never
// rigs.

import { assistantEventKey, fmtCost, fmtElapsed, isRemovableRun, isRunIdle, isTerminalRunStatus, modelShortName, providerShortLabel, routeTargetLabel, runTone, summarizeMailbox } from './asst-state.js';
import { createRouteLine } from './asst-route.js';
import { computerToolName, describeComputerAction, frameUrls, markerPercent, openFrameLightbox, parseComputerResult, swapImage } from './asst-computer.js';
import * as mascotLib from '../synabun-mascot.js';
import { isReducedMotion, subscribe } from '../synabun-ticker.js';
import { KIND_SPECS, callOutcome, commandOf, editDiff, editPaths, fmtDuration, groupSubject, kindOf, maskEcho, mcpServerOf, middleEllipsis, planState, plural, prettyServer, receiptSentence, redactInput, resultDetail, sayCall, shouldFoldNarration, stationAggregate, stationKey, targetKey, toolWords, verbText } from './asst-tool-kinds.js';
import { injectRackStyles } from './asst-rack-styles.js';
import { formatRunTokens } from './asst-usage.js';
import { sanitizeHtmlString, sanitizeInto } from './asst-sanitize.js';

// ── Markdown (lazy marked, same CDN build as the sidepanels) ───────────────
let _marked = null;
let _markedLoading = null;
function loadMarked() {
  if (_marked || _markedLoading) return _markedLoading;
  _markedLoading = import('https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js')
    .then((m) => {
      _marked = m?.marked || m?.default || null;
      if (_marked?.setOptions) _marked.setOptions({ breaks: true, gfm: true });
    })
    .catch(() => { _marked = null; });
  return _markedLoading;
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** marked's HTML for `text`: raw, so it only ever reaches the page through asst-sanitize.js. */
function mdHtml(text) {
  const src = String(text ?? '');
  if (!_marked) return esc(src).replace(/\n/g, '<br>');
  try { return _marked.parse(src); } catch { return esc(src).replace(/\n/g, '<br>'); }
}

/** Markdown → sanitized HTML (asst-sanitize.js allowlist): what a brain says is not trusted. */
export function md(text) {
  return sanitizeHtmlString(mdHtml(text));
}

/** Markdown drawn into `node` as fresh, allowlisted nodes. */
export function mdInto(node, text) {
  return sanitizeInto(node, mdHtml(text));
}

// The SynaBun two-pill mark — the same glyph as the tab, the keybinds icon and provider-icons.js.
export const ICON_ASSISTANT = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="8" y="5.5" width="11" height="5" rx="2.5" transform="rotate(-12 13.5 8)"/><rect x="4.5" y="12.5" width="11" height="5" rx="2.5" transform="rotate(-12 10 15)"/></svg>';
const ICON_MEMORY = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="8" y="5.5" width="11" height="5" rx="2.5" transform="rotate(-12 13.5 8)"/><rect x="4.5" y="12.5" width="11" height="5" rx="2.5" transform="rotate(-12 10 15)"/></svg>';
const ICON_ESCALATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
// SynaBun's own MCP tools: Claude/Codex `mcp__SynaBun__x`, OpenCode `SynaBun_x`.
const SYNABUN_TOOL_RE = /^(?:mcp__synabun__|synabun_)(.+)$/i;
export function synabunToolName(name) { const m = SYNABUN_TOOL_RE.exec(String(name || '')); return m ? m[1] : null; }
const RESULT_ERRORS = { error_max_turns: 'Stopped: the turn limit was reached.', error_max_budget_usd: 'Stopped: the budget cap was reached.', error_during_execution: 'The turn failed.', error_max_structured_output_retries: 'Stopped: structured output kept failing.' };
const INTERRUPTED_RE = /\b(?:interrupted|aborted|cancell?ed)\b/i;

/**
 * The error line a `result` event deserves, or '' — a success, or a turn the
 * user stopped (terminal_reason aborted_*, or only "interrupted" errors).
 * `t(key, fallback)` localizes the stock lines.
 */
export function resultErrorText(ev, t = (_key, fallback) => fallback) {
  if (!ev || (!ev.is_error && !String(ev.subtype || '').startsWith('error'))) return '';
  if (String(ev.terminal_reason || '').startsWith('aborted')) return '';
  if (typeof ev.result === 'string' && ev.result.trim()) return ev.result.trim();
  const errors = Array.isArray(ev.errors) ? ev.errors.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (errors.length) return errors.every((x) => INTERRUPTED_RE.test(x)) ? '' : errors.slice(0, 3).join('\n');
  const sub = RESULT_ERRORS[ev.subtype] ? ev.subtype : 'error_during_execution';
  return t(`assistant.result.${sub}`, RESULT_ERRORS[sub]);
}

/** Whitespace-blind text key: streamed deltas and the final message join parts differently. */
const textKey = (s) => String(s || '').replace(/\s+/g, '');
const COMPUTER_TOOL_TITLES = { computer: 'Computer', computer_apps: 'Apps', computer_ax: 'Accessibility', computer_status: 'Computer status' };
const RESULT_LIMIT = 3000;
const STREAM_TICK_MS = 100;
const MAX_MESSAGES = 600;
const MAX_INLINE_FRAMES = 6; // computer cards per turn that keep an inline thumbnail

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Turn a memory node/summary into the `<memory>` block appended to a prompt. */
export function formatMemoryForPrompt(memory) {
  const p = memory?.payload || memory || {};
  const id = memory?.id || p.id || '';
  const category = p.category || memory?.category || '';
  const content = p.content || memory?.text || memory?.title || '';
  return `<memory id="${id}" category="${category}">\n${content}\n</memory>`;
}

function memoryTitle(memory) {
  const p = memory?.payload || memory || {};
  const raw = memory?.title || p.title || (p.content || memory?.text || '').split('\n')[0];
  return String(raw || '').replace(/^#+\s*/, '').slice(0, 60) || memory?.id || 'memory';
}

// ── Run cards (shared with the agents dock) ────────────────────────────────

function runWaitingForRoute(run) {
  return run?.state === 'awaiting_route' || run?.turnState === 'awaiting_route' || run?.route?.status === 'pending';
}

/**
 * buildRunCard(run, { t, providerIcon, providerColor, onFocus, onStop, onRead, onEscalate, compact, result, index })
 * Returns a card element; call updateRunCard(el, run, opts) to refresh it in place.
 */
export function buildRunCard(run, opts = {}) {
  const card = el('div', `asst-run${opts.compact ? ' compact' : ''}`);
  card.dataset.runId = run?.runId || '';
  card.setAttribute('role', 'group');
  card.innerHTML = `
    <span class="asst-run-icon" aria-hidden="true"></span>
    <div class="asst-run-main"><span class="asst-run-title"></span><span class="asst-pill" data-tone="running">${mascotLib.mascotCameoSvg()}<span class="asst-pill-label"></span></span></div>
    <div class="asst-run-actions"></div>
    <div class="asst-run-meta"></div>
  `;
  const actions = card.querySelector('.asst-run-actions');
  const t = (key, fallback) => {
    const v = typeof opts.t === 'function' ? opts.t(key) : undefined;
    return v && v !== key && typeof v === 'string' ? v : fallback;
  };
  const mk = (id, label, icon, handler) => {
    const btn = el('button', 'asst-iconbtn');
    btn.type = 'button';
    btn.dataset.action = id;
    btn.setAttribute('data-tooltip', label);
    btn.setAttribute('aria-label', label);
    btn.innerHTML = icon;
    btn.addEventListener('click', (e) => { e.stopPropagation(); handler?.(card.dataset.runId); });
    actions.appendChild(btn);
    return btn;
  };
  mk('focus', t('assistant.run.focus', 'Focus in sidepanel'), '<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>', opts.onFocus);
  mk('read', t('assistant.run.read', 'Read result'), '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8"/></svg>', opts.onRead);
  mk('stop', t('assistant.run.stop', 'Stop run'), '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>', opts.onStop);
  // The agents tray only: a finished run can be removed from it.
  if (typeof opts.onRemove === 'function') mk('remove', t('assistant.run.remove', 'Remove from list'), '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>', opts.onRemove).hidden = true;
  card._runOpts = opts;
  updateRunCard(card, run, opts);
  return card;
}

export function updateRunCard(card, run, opts = {}) {
  if (!card || !run) return;
  if (card._usageRun?.usageObserved && !run.usageObserved) run = { ...run, usageTokens: card._usageRun.usageTokens, usageFidelity: card._usageRun.usageFidelity, usageObserved: true };
  card._usageRun = run;
  const t = (key, fallback, params) => {
    const v = typeof opts.t === 'function' ? opts.t(key, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };
  card.dataset.runId = run.runId || card.dataset.runId;
  card.dataset.status = run.status || '';
  const provider = run.provider || 'claude-code';
  const icon = card.querySelector('.asst-run-icon');
  if (icon) {
    icon.innerHTML = typeof opts.providerIcon === 'function' ? (opts.providerIcon(provider) || '') : '';
    const color = typeof opts.providerColor === 'function' ? opts.providerColor(provider) : '';
    if (color) card.style.setProperty('--asst-provider-color', color);
  }
  const title = card.querySelector('.asst-run-title');
  const label = run.title || run.task || run.runId || '';
  if (title) { title.textContent = label; title.title = label; }
  const waitingRoute = runWaitingForRoute(run);
  const pill = card.querySelector('.asst-pill');
  if (pill) {
    const tone = waitingRoute ? 'action' : runTone(run);
    pill.dataset.tone = tone;
    (pill.querySelector('.asst-pill-label') || pill).textContent = waitingRoute ? t('assistant.run.awaitingRoute', 'waiting for your model choice')
      : run.turnState === 'awaiting_permission' ? t('assistant.run.needsApproval', 'needs approval')
        : run.turnState === 'needs_input' ? t('assistant.run.needsInput', 'needs input')
          : run.queued && run.status !== 'running' ? t('assistant.run.queued', 'queued')
            // A warm worker between turns reports what its last turn ended with, not "running".
            : isRunIdle(run) ? (run.outcome || run.lastResult?.status
              ? t('assistant.run.idleWith', '{outcome} · idle', { outcome: run.outcome || run.lastResult.status })
              : t('assistant.run.idle', 'idle'))
              : (run.status || tone);
  }
  const meta = card.querySelector('.asst-run-meta');
  if (meta) {
    // One sentence: "GPT-5.5 via Codex, high effort, 1m 35s, $0.21", then what the route and Jev said.
    const bits = [];
    const modelName = run.modelInfo?.label || (run.model ? modelShortName(run.model) : '');
    const who = modelName ? t('assistant.run.via', '{model} via {provider}', { model: modelName, provider: providerShortLabel(provider) }) : providerShortLabel(provider);
    bits.push(`<span class="asst-run-model">${esc(who)}</span>`);
    if (run.accountLabel || (run.accountId && run.accountId !== 'default')) bits.push(`<span>${esc(t('assistant.run.asAccount', 'as {account}', { account: run.accountLabel || run.accountId }))}</span>`);
    if (run.effort) bits.push(`<span>${esc(t('assistant.run.effort', '{effort} effort', { effort: run.effort }))}</span>`);
    const end = isTerminalRunStatus(run.status) ? (run.completedAt || run.updatedAt) : Date.now();
    const elapsed = fmtElapsed(run.startedAt, end);
    if (elapsed) bits.push(`<span class="asst-run-elapsed">${esc(elapsed)}</span>`);
    const cost = fmtCost(run.costUsd);
    if (cost && Number(run.costUsd) > 0) bits.push(`<span class="asst-run-cost">${esc(cost)}</span>`);
    const runTokens = run.usageTokens || run.tokens;
    const usage = runTokens?.total > 0 || run.usageObserved ? formatRunTokens(runTokens, run.usageFidelity || run.tokens?.fidelity, t) : null;
    if (usage) bits.push(`<span class="asst-usage-run-tokens" aria-label="${esc(usage.label)}">${esc(usage.text)}</span>`);
    if (run.currentIteration > 1) bits.push(`<span>${esc(t('assistant.run.turn', 'turn {n}', { n: run.currentIteration }))}</span>`);
    if (run.route && typeof run.route === 'object') {
      const r = run.route;
      const routeBits = [r.taskClassLabel || r.taskClass || t('assistant.routes.task', 'task')];
      if (r.status === 'pending') routeBits.push(t('assistant.routes.state.pending', 'waiting for your choice'));
      else if (r.decidedBy === 'user') routeBits.push(t('assistant.routes.youChose', 'you chose'));
      else if (r.remembered || r.decidedBy === 'remembered') routeBits.push(t('assistant.routes.remembered', 'remembered'));
      else if (Number.isFinite(Number(r.confidence))) routeBits.push(`${Math.round(Number(r.confidence) <= 1 ? Number(r.confidence) * 100 : Number(r.confidence))}%`);
      const tip = r.target ? `${t('assistant.routes.routedTo', 'Routed to')} ${routeTargetLabel(r.target, { effort: true })}` : t('assistant.routes.title', 'Model routing');
      bits.push(`<span class="asst-run-route" data-tooltip="${esc(tip)}">⇄ ${esc(routeBits.join(', '))}</span>`);
    }
    if (run.usesComputer) bits.push(`<span class="asst-run-computer">${esc(t('assistant.run.usesComputer', 'uses the computer'))}</span>`);
    // Jev's reading of the result: a "done" its own output does not show, and a status read without a ## Result block.
    const judged = run.lastResult && typeof run.lastResult === 'object' ? run.lastResult : null;
    if (judged?.unverifiedClaim) {
      const tip = t('assistant.run.unverifiedTip', 'Reported done, but {evidence}. Verify before relying on it.', { evidence: String(judged.unverifiedClaim.evidence || '') });
      bits.push(`<span class="asst-run-unverified" data-tooltip="${esc(tip)}" style="color:var(--asst-warn)">${esc(t('assistant.run.unverified', 'unverified'))}</span>`);
    }
    if (judged?.source === 'jev') bits.push(`<span class="asst-run-jev">${esc(t('assistant.run.statusByJev', 'status read by Jev'))}</span>`);
    meta.innerHTML = bits.join('<span class="asst-run-sep">, </span>');
  }
  const finished = isTerminalRunStatus(run.status);
  const removable = isRemovableRun(run);
  const stopBtn = card.querySelector('[data-action="stop"]');
  const removeBtn = card.querySelector('[data-action="remove"]');
  if (stopBtn) { stopBtn.disabled = finished; stopBtn.hidden = removable && !!removeBtn; }
  if (removeBtn) { removeBtn.hidden = !removable; removeBtn.disabled = !removable; }
  const readBtn = card.querySelector('[data-action="read"]');
  if (readBtn) readBtn.disabled = run.status === 'queued';

  // Escalation offer ("Escalate to ‹label›", or "Retry on ‹label›" after a
  // temporary failure) when the server proposes one; a note without a button
  // when a stronger model would hit the same wall (access, the user's input).
  let esc8 = card.querySelector('.asst-run-escalate');
  const escalationRaw = run.escalation && typeof run.escalation === 'object' ? run.escalation : null;
  const escalation = escalationRaw?.to ? escalationRaw : null;
  const needsNote = escalationRaw && escalationRaw.kind === 'none' ? escalationRaw : null;
  const onEscalate = opts.onEscalate || card._runOpts?.onEscalate;
  if (esc8 && esc8.dataset.kind !== (needsNote ? 'note' : 'offer')) { esc8.remove(); esc8 = null; card._escalation = null; }
  if (needsNote) {
    if (!esc8) {
      esc8 = el('div', 'asst-run-escalate');
      esc8.dataset.kind = 'note';
      esc8.innerHTML = '<span class="asst-run-escalate-reason"></span>';
      card.appendChild(esc8);
    }
    const needs = String(needsNote.needs || '').trim();
    const line = needsNote.cause === 'access'
      ? t('assistant.run.needsAccess', 'Needs access: {needs}', { needs })
      : t('assistant.run.needsUser', 'Needs your input: {needs}', { needs });
    esc8.querySelector('.asst-run-escalate-reason').textContent = needs ? line : line.replace(/[:：]\s*$/, '');
  } else if (escalation && typeof onEscalate === 'function' && !escalation.started) {
    const to = escalation.to;
    const retry = escalation.kind === 'retry';
    const toLabel = routeTargetLabel(to) || t('assistant.run.strongerModel', 'a stronger model');
    if (!esc8) {
      esc8 = el('div', 'asst-run-escalate');
      esc8.dataset.kind = 'offer';
      esc8.innerHTML = `<span class="asst-run-escalate-reason"></span><button type="button" class="asst-btn asst-btn-secondary asst-run-escalate-btn"><span class="asst-btn-icon" aria-hidden="true">${ICON_ESCALATE}</span><span class="asst-btn-label"></span></button>`;
      esc8.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const current = card._escalation;
        if (!current || btn.disabled) return;
        btn.disabled = true;
        Promise.resolve(onEscalate(card.dataset.runId, current.to)).finally(() => { btn.disabled = false; });
      });
      card.appendChild(esc8);
    }
    card._escalation = escalation;
    const reason = retry ? t('assistant.run.retryTransient', 'Temporary failure')
      : { failed: t('assistant.run.escalateFailed', 'Run failed'), blocked: t('assistant.run.escalateBlocked', 'Run is blocked'), no_result: t('assistant.run.escalateNoResult', 'No usable result') }[escalation.reason] || '';
    esc8.querySelector('.asst-run-escalate-reason').textContent = reason;
    esc8.querySelector('.asst-btn-label').textContent = retry
      ? t('assistant.run.retryOn', 'Retry on {label}', { label: toLabel })
      : t('assistant.run.escalateTo', 'Escalate to {label}', { label: toLabel });
  } else if (esc8) {
    esc8.remove();
    card._escalation = null;
  }

  let summary = card.querySelector('.asst-run-summary');
  const result = opts.result ?? run.lastResult ?? null;
  const summaryText = summaryFromResult(result, run);
  if (summaryText) {
    if (!summary) { summary = el('div', 'asst-run-summary'); card.appendChild(summary); }
    summary.textContent = summaryText;
  } else if (summary && !opts.keepSummary) {
    summary.remove();
  }
  updateRunMedia(card, run, { t, lightboxT: opts.t || card._runOpts?.t });
}

const MAX_RUN_MEDIA = 8;

/**
 * Image / video creation: the files the run generated (run.media, served by
 * /api/assistant/runs/:runId/media/:n), right after the summary; a design run's
 * screenshots and images the same way. Images open in the screenshot lightbox;
 * videos play inline. Rebuilt only when the list changes, so a playing video
 * keeps playing across card refreshes.
 */
function updateRunMedia(card, run, { t, lightboxT }) {
  const items = (Array.isArray(run.media) ? run.media : [])
    .filter((m) => m && typeof m.url === 'string' && m.url && (m.kind === 'image' || m.kind === 'video'))
    .slice(0, MAX_RUN_MEDIA);
  let strip = card.querySelector('.asst-run-media');
  if (!items.length) { strip?.remove(); return; }
  const anchor = card.querySelector('.asst-run-summary');
  if (!strip) {
    strip = el('div', 'asst-run-media');
    strip.setAttribute('role', 'list');
    const design = (run.taskClass || run.route?.taskClass) === 'design';
    strip.setAttribute('aria-label', design ? t('assistant.run.designMedia', 'Design screenshots and images') : t('assistant.run.media', 'Generated media'));
  }
  if (anchor ? strip.previousElementSibling !== anchor : strip.parentNode !== card) {
    if (anchor) anchor.after(strip); else card.appendChild(strip);
  }
  const key = items.map((m) => m.url).join('|');
  if (strip.dataset.key === key) return;
  strip.dataset.key = key;
  strip.innerHTML = '';
  for (const m of items) {
    const name = String(m.path || m.url).split(/[\\/]/).pop();
    if (m.kind === 'video') {
      const video = document.createElement('video');
      video.className = 'asst-run-media-video';
      video.setAttribute('role', 'listitem');
      video.controls = true;
      video.preload = 'metadata';
      video.src = m.url;
      video.title = m.path || name;
      video.setAttribute('aria-label', t('assistant.run.mediaVideo', 'Video {name}', { name }));
      strip.appendChild(video);
      continue;
    }
    const btn = el('button', 'asst-run-media-thumb');
    btn.type = 'button';
    btn.setAttribute('role', 'listitem');
    btn.title = m.path || name;
    btn.setAttribute('aria-label', t('assistant.run.mediaOpen', 'Open image {name}', { name }));
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => btn.classList.add('failed'), { once: true });
    img.src = m.url;
    btn.appendChild(img);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFrameLightbox({ src: m.url, caption: m.path || name, t: lightboxT, returnFocus: btn });
    });
    strip.appendChild(btn);
  }
}

function summaryFromResult(result, run) {
  if (result && typeof result === 'object') {
    const status = result.status ? `[${result.status}] ` : '';
    const text = result.summary || result.text || result.raw || '';
    if (text) return `${status}${String(text).slice(0, 800)}`;
    if (result.status) return `[${result.status}]`;
  } else if (typeof result === 'string' && result.trim()) {
    return result.slice(0, 800);
  }
  if (run?.status === 'failed' && run.error) return String(run.error).slice(0, 400);
  return '';
}

/** Refresh only the elapsed counters (cheap, for timers). */
export function tickRunCard(card, run) {
  if (!card || !run || isTerminalRunStatus(run.status)) return;
  const node = card.querySelector('.asst-run-elapsed');
  const value = fmtElapsed(run.startedAt, Date.now());
  if (node && value) node.textContent = value;
}

// ── Renderer ────────────────────────────────────────────────────────────────

// Activity rack timing (asst-tool-kinds.js decides what a call says).
const WAKE_MS = 350; // a row wakes once its call has run this long
const LINGER_MS = 1200; // the last awake call to finish stays awake this long
const HOLD_MS = 900; // the bubble holds a call at least this long
const THINK_HOLD_MS = 3000; // … and a thinking caption this long
const BURST_MS = 800; // 3+ calls started within this window read "newest ×N"
const STATUS_GAP_MS = 1500; // screen-reader announcements at most this often
const FOLD_MS = 180; // narration collapsing into the stage caption
const COLLAPSE_MS = 260; // the stage folding into the receipt
const FLIP_MS = 320; // the hero flying into the "Thinking" row (--asst-dur-slow)
const HERO_LEAVE_MS = 140; // a parked hero the "Thinking" row did not take over fades out
const MAX_TICKS = 60;
const NARROW_TICKS = 12;
const PREVIEW_LINES = 5;
const THINK_PREVIEW_LINES = 10;
const MAX_DIFF_LINES = 400; // an edit's mini diff draws this many lines; "Show full input" draws the rest
// The empty state's suggestions (asst-panel.js ids) and the kind each one is about.
const SUGGESTION_KINDS = { computer: 'computer', web: 'web', fix: 'edit', schedule: 'plan', remember: 'memory' };

/**
 * createRenderer(transcriptEl, hooks)
 * hooks: { t, providerIcon(provider), providerColor(provider), onFocusRun, onStopRun, onReadRun, onEscalateRun,
 *          onMemoryClick(id), onResult(ev), onInit(ev), onModeChanged(mode), copy(text),
 *          emptySuggestions() → [{ id, label, template }], onSuggestion(template),
 *          brainLabel() → string, onChangeRoutes(), onRouteEvent(ev) → bool (true = handled by an open card),
 *          heroOrigin() → DOMRect | null (where the empty state's character flies in from: the host's placeholder),
 *          onMascotChange() (the character on screen changed: mascot()) }
 */
export function createRenderer(transcriptEl, hooks = {}) {
  loadMarked();
  injectRackStyles();
  const $msgs = transcriptEl;
  const scopes = new Map(); // parent_tool_use_id → { container, stream, key }
  const runCards = new Map(); // runId → card element
  const routeLines = new Map(); // routeId → line handle
  let working = null;
  let workingFace = null; // the "Thinking" row's character: { still, rig?, el, target? } (syncWorkingFace)
  let followTail = true;
  let emptyEl = null;
  let hero = null; // the empty state's character: { rig, el, box, parked, leaving, held, dock, egg, target }
  let rigsOn = true; // this panel's rigs may animate (asst-mascot.js lets one panel at a time)
  const mcpWarned = new Set();
  let lastErrorText = ''; // a synthetic API-error message's text, so the result does not repeat it
  let turnFrames = []; // computer cards with inline thumbnails in the current turn
  const runInfo = new Map(); // runId → { title, state, provider } from dispatch cards and agent_* results
  let turnActive = false; // between showWorking() and finishTurn()
  let turn = { calls: 0, last: null, errored: false, answerRow: null }; // what the turn did: the mascot's verdict, the announced answer
  let grace = null; // the stage on screen when the result arrived: it waits for the turn's verdict (finishTurn)
  let waiting = null; // a card waits on the user: { id: the tool_use id it holds or null, since } (setWaiting)

  // ── Activity racks ──
  // Every burst of agent work (tool calls, thinking, short narration) is one
  // `.asst-rack`: a stage where the mascot acts out the call it is on, a
  // ledger with one row per tool kind, a receipt once it settles. The state
  // lives on the DOM tail, so the live path and a replayed journal agree.
  const racks = new Set();
  const stepsById = new Map(); // tool_use id → step (updates are idempotent across racks)
  const headers = new WeakMap(); // station header → { rack, st }
  let rackSeq = 0;
  let stepSeq = 0;
  let unsubTick = null;
  let muted = false; // inside handleEvent(…, { silent: true }): no motion, no announcements
  let replayDraw = false; // inside handleEvent(…, { replay: true }): a reattach's missed packets (drawn like the journal)
  let clockAt = null; // the journal `at` of the entry being replayed

  // ── What is on screen (dedupe) ──
  // Identities of the events drawn, live or from the journal: SDK uuids, each
  // assistant message's key, its API message id and its tool_use ids. The
  // panel skips an assistant event it drew already; a reattach's buffered
  // replay (planReplay) skips everything the journal snapshot or the live
  // path drew. `snapshot`: the last renderTranscript's exact event copies and
  // its newest `at` / `seq`, for the one replay that follows it.
  const seen = new Set();
  const SEEN_MAX = 5000;
  let snapshot = null;

  $msgs.addEventListener('scroll', () => {
    followTail = isNearBottom();
  }, { passive: true });

  const t = (key, fallback, params) => {
    const v = typeof hooks.t === 'function' ? hooks.t(key, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };
  const sayCtx = {
    t,
    runLabel: (step) => runLabel(step),
    runState: (step) => { const ids = stepRunIds(step); return ids.length ? runInfo.get(ids[0])?.state || '' : ''; },
    describeComputer: (input, name) => describeComputerAction(input, name),
  };
  /** What a step says; a call still streaming its input says "…" until the input arrives. */
  const sayOf = (step) => {
    const say = sayCall(step, sayCtx);
    if (step.ghost && step.type === 'call' && !Object.keys(step.input || {}).length) { say.text = '…'; say.detail = '…'; say.segments = null; say.mono = false; say.meta = []; }
    return say;
  };
  const nowMs = () => (clockAt ?? Date.now());
  const isTimed = () => !muted || clockAt != null;
  const locale = () => (typeof document !== 'undefined' && document.documentElement?.lang) || 'en';

  function reducedMotion() {
    try { return !!isReducedMotion(); } catch { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
  }
  /** No motion: replay, reduced motion, or the UI is being dragged. */
  const calm = () => muted || reducedMotion() || !!document.body?.classList.contains('ui-interacting');

  function isNearBottom() {
    return $msgs.scrollHeight - $msgs.scrollTop - $msgs.clientHeight < 48;
  }

  function scrollEnd(force = false) {
    if (!force && !followTail) return;
    requestAnimationFrame(() => { $msgs.scrollTop = $msgs.scrollHeight; });
  }

  function root() { return { container: $msgs, stream: null, key: null, msgId: null, lastAt: 0 }; }
  const rootScope = root();

  function scopeFor(parentId) {
    if (!parentId) return rootScope;
    let scope = scopes.get(parentId);
    if (scope && (scope.container === $msgs || scope.container.isConnected)) return scope;
    const card = stepsById.get(parentId)?.card || $msgs.querySelector(`.asst-tool[data-tool-id="${CSS.escape(parentId)}"]`);
    let container;
    if (card) {
      container = card.querySelector(':scope > .asst-agent-feed');
      if (!container) { container = el('div', 'asst-agent-feed'); card.appendChild(container); }
    } else {
      container = $msgs;
    }
    scope = { container, stream: null, key: parentId, msgId: null, lastAt: 0 };
    scopes.set(parentId, scope);
    return scope;
  }

  /** The empty state goes; `park` (a turn starts) hands its character over to the "Thinking" row. */
  function hideEmpty({ park = false } = {}) {
    if (!emptyEl) return;
    if (!(park && parkHero())) dropHero();
    emptyEl.remove();
    emptyEl = null;
  }

  // ── The hero ──
  const cssEase = (name, fallback) => {
    try { return getComputedStyle($msgs).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
  };

  function heroTarget(h) {
    return {
      kind: 'hero',
      rig: h.rig,
      el: h.el,
      parked: () => !!h.parked,
      hold(on) { h.held = !!on; },
      restore() { if (hero === h) h.rig.setPose(h.parked ? 'think' : 'idle'); },
    };
  }

  /**
   * Park the hero where it stands, in an overlay of the transcript's parent,
   * so it outlives the empty state for its hand-off. It stays there only
   * until the rows of this task are in (the prompt, "Thinking"): settleHero()
   * then gives it to the "Thinking" row, so it is never drawn over the
   * prompt that took the empty state's place. Not on replay, under reduced
   * motion or while the UI is dragged, and not when it is off screen.
   */
  function parkHero() {
    const h = hero;
    const layer = $msgs.parentElement;
    if (!h?.rig || h.parked || calm() || !layer || !h.el.isConnected) return false;
    const box = h.el.getBoundingClientRect();
    const view = $msgs.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom <= view.top || box.top >= view.bottom) return false;
    if (getComputedStyle(layer).position === 'static') return false;
    const base = layer.getBoundingClientRect();
    const dock = el('div', 'asst-hero-dock');
    dock.setAttribute('aria-hidden', 'true');
    dock.style.left = `${box.left - base.left - layer.clientLeft}px`;
    dock.style.top = `${box.top - base.top - layer.clientTop}px`;
    dock.style.width = `${box.width}px`;
    dock.style.height = `${box.height}px`;
    dock.appendChild(h.el);
    layer.appendChild(dock);
    h.dock = dock;
    h.parked = true;
    if (!h.held) h.rig.setPose('think');
    queueMicrotask(() => settleHero(h));
    mascotChanged();
    return true;
  }

  /**
   * The parked hero's hand-off, once the task that parked it has put its rows
   * in: the "Thinking" row's character flies in from the hero's box and the
   * hero leaves in the same frame. With no such row to take it over (a slash
   * command's echo, a rack already live) it fades out.
   */
  function settleHero(h) {
    if (hero !== h || !h.parked || h.leaving) return;
    if (!workingFree()) { dismissHero(); return; }
    const from = h.el.getBoundingClientRect();
    dropHero(); // the "Thinking" row wears the character now (syncWorkingFace)
    const face = workingFace;
    if (!face?.rig) return;
    const row = working;
    row.classList.add('is-flip');
    const anim = flipFrom(face.el, from);
    const done = () => row.classList.remove('is-flip');
    if (!anim) { done(); return; }
    anim.onfinish = done;
    anim.oncancel = done;
  }

  function dropHero() {
    const h = hero;
    if (!h) return;
    hero = null;
    clearTimeout(h.leaveTimer);
    try { h.rig.destroy(); } catch { /* gone */ }
    h.dock?.remove();
    mascotChanged();
    syncWorkingFace(); // the "Thinking" row may wear the character now
  }

  /** A parked hero the "Thinking" row did not take over leaves: it fades out (at once when calm). */
  function dismissHero() {
    const h = hero;
    if (!h?.parked || h.leaving) return;
    h.leaving = true;
    if (calm() || typeof h.dock.animate !== 'function') { dropHero(); return; }
    const anim = h.dock.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HERO_LEAVE_MS, easing: cssEase('--asst-ease-exit', 'cubic-bezier(.2,0,1,.9)'), fill: 'forwards' });
    anim.onfinish = () => { if (hero === h) dropHero(); };
    h.leaveTimer = setTimeout(() => { if (hero === h) dropHero(); }, HERO_LEAVE_MS + 120);
  }

  /**
   * FLIP `node` from `from` (a client rect) into its own box: transform and
   * opacity, 320 ms, --asst-ease-emphasized. `fade` starts it transparent (the
   * character was gone for a moment). Returns the animation, or null when calm.
   */
  function flipFrom(node, from, { fade = false } = {}) {
    if (!node || !from?.width || calm() || typeof node.animate !== 'function') return null;
    const to = node.getBoundingClientRect();
    if (!to.width || !to.height) return null;
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const s = from.width / to.width;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(s - 1) < 0.01 && !fade) return null;
    return node.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: fade ? 0 : 1 },
      { transform: 'none', opacity: 1 },
    ], { duration: FLIP_MS, easing: cssEase('--asst-ease-emphasized', 'cubic-bezier(.4,.14,.3,1)') });
  }

  /** Triple-click the character: its eyes part and re-form, once per mount. Silent. */
  function wireEgg(h) {
    const hit = (e) => {
      const r = h.el.getBoundingClientRect();
      return hero === h && !h.parked && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    h.box.parentElement?.addEventListener('mousedown', (e) => { if (e.detail > 1 && hit(e)) e.preventDefault(); });
    h.box.parentElement?.addEventListener('click', (e) => {
      if (e.detail !== 3 || h.egg || !hit(e)) return;
      h.egg = true;
      h.rig.react?.('split');
    });
  }

  // ── The character on screen (for the panel's director) ──
  function stageTarget(rack) {
    return {
      kind: 'stage',
      rig: rack.rig,
      el: rack.rig.el,
      hold(on) { rack.held = !!on; },
      restore() { if (rack.rig) { rack.pose = null; poseStage(rack); } },
    };
  }

  /** The newest stage on screen (live, or held for its one-shot). */
  function newestStage() {
    let best = null;
    for (const rack of racks) if (rack.staged && rack.rig && !rack.nested && (!best || rack.id > best.id)) best = rack;
    return best;
  }

  /** The mascot on screen: the hero, else the newest stage, else the "Thinking" row's, else none. */
  function visibleMascot() {
    if (hero?.rig) return hero.target;
    return newestStage()?.target || workingFace?.target || null;
  }

  function mascotChanged() {
    activateRigs();
    try { hooks.onMascotChange?.(); } catch { /* the director is gone */ }
  }

  /** Whether this panel's rigs animate (another panel may lead); still frames otherwise. */
  function setRigsEnabled(on) {
    if (rigsOn === !!on) return;
    rigsOn = !!on;
    activateRigs();
  }

  function prune() {
    const rows = $msgs.children;
    while (rows.length > MAX_MESSAGES && rows[0] !== working) rows[0].remove();
  }

  /** Insert a row before "Working…" so the indicator stays the last row. */
  function append(node, scope = rootScope, { park = false } = {}) {
    hideEmpty({ park });
    if (scope.container === $msgs && working && working.parentNode === $msgs) $msgs.insertBefore(node, working);
    else scope.container.appendChild(node);
    if (scope === rootScope) prune();
    // Text, a card, a notice…: the parked hero would sit on it. The prompt and a rack leave it to settleHero().
    if (hero?.parked && scope === rootScope && !node._rack && !node.classList.contains('msg-user')) dismissHero();
    if (racks.size) syncRacks();
    scrollEnd();
    return node;
  }

  /**
   * A message row. `props` (its text, message id…) land before the row is
   * appended: append() re-renders the racks, and a live rack looks through
   * one short text row at its tail (liveTail), which it can only do once the
   * row says what it holds.
   */
  function assistantRow(scope, props = null) {
    const row = el('div', 'asst-msg msg-assistant');
    const wrap = el('div', 'asst-msg-content');
    row.appendChild(wrap);
    if (props) Object.assign(row, props);
    append(row, scope);
    return { row, wrap };
  }

  function linkify(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const pathRe = /(?:(?:[A-Za-z]:)?(?:[/\\][\w.@\-]+){2,}(?::\d+)?)(?=\s|$|[)"',;])/g;
    for (const node of nodes) {
      if (node.parentElement?.closest('pre, code, a')) continue;
      const text = node.textContent;
      pathRe.lastIndex = 0;
      if (!pathRe.test(text)) continue;
      pathRe.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = pathRe.exec(text))) {
        if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
        const a = el('a', 'file-link', match[0]);
        a.href = '#';
        a.title = t('assistant.copyPath', 'Click to copy path');
        const path = match[0].replace(/:\d+$/, '');
        a.addEventListener('click', (e) => { e.preventDefault(); hooks.copy?.(path); a.style.opacity = '0.5'; setTimeout(() => { a.style.opacity = ''; }, 300); });
        frag.appendChild(a);
        last = match.index + match[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      if (last > 0) node.parentNode.replaceChild(frag, node);
    }
  }

  function renderMarkdownInto(body, text) {
    mdInto(body, text);
    body.querySelectorAll('pre code').forEach((code) => {
      const lang = (code.className || '').replace('language-', '').trim();
      if (lang) code.parentElement.dataset.lang = lang;
    });
    body.querySelectorAll('a[href]').forEach((a) => {
      if (a.classList.contains('file-link')) return;
      if (/^https?:/i.test(a.getAttribute('href') || '')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    });
    linkify(body);
  }

  function copyText(text) {
    const value = String(text ?? '');
    if (!value) return;
    if (typeof hooks.copy === 'function') { hooks.copy(value); return; }
    try { navigator.clipboard?.writeText(value)?.catch?.(() => {}); } catch { /* no clipboard */ }
  }

  function copyButton(getText) {
    const btn = el('button', 'asst-copy', t('assistant.rack.copy', 'Copy'));
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(getText());
      btn.textContent = t('assistant.rack.copied', 'Copied');
      setTimeout(() => { btn.textContent = t('assistant.rack.copy', 'Copy'); }, 1200);
    });
    return btn;
  }

  // ── Streaming ──
  // Text streams into a normal row first (it may fold into the rack as
  // narration once a call follows); thinking and calls stream into the rack.
  function ensureStream(scope) {
    if (!scope.stream) scope.stream = { row: null, wrap: null, bodyEl: null, textBuf: '', mdTimer: null, thinkTimer: null, think: null, blockType: null, msgId: scope.msgId || null, claude: false };
    return scope.stream;
  }

  function flushStream(scope) {
    const s = scope.stream;
    if (!s) return;
    if (s.mdTimer) { clearTimeout(s.mdTimer); s.mdTimer = null; }
    if (s.thinkTimer) { clearTimeout(s.thinkTimer); s.thinkTimer = null; }
    if (s.bodyEl && s.textBuf.trim()) renderMarkdownInto(s.bodyEl, s.textBuf);
    if (s.think) refreshStep(s.think);
  }

  /** The stream's text row goes (the final message renders the text again). */
  function dropStreamText(scope) {
    const s = scope.stream;
    if (!s) return;
    if (s.mdTimer) { clearTimeout(s.mdTimer); s.mdTimer = null; }
    s.row?.remove();
    s.row = null; s.wrap = null; s.bodyEl = null; s.textBuf = '';
  }

  function thinkingBlock(text = '') {
    const thinkEl = el('details', 'asst-thinking');
    thinkEl.innerHTML = `<summary><span class="asst-thinking-chev" aria-hidden="true">&#x203A;</span><span>${esc(t('assistant.thinking', 'Thinking'))}</span></summary><div class="asst-thinking-content"></div>`;
    thinkEl.querySelector('.asst-thinking-content').textContent = text;
    return thinkEl;
  }

  function streamThink(scope, s, redacted = false) {
    if (s.think) return s.think;
    const rack = rackFor(scope, { msgId: s.msgId, claude: s.claude });
    s.think = addThink(rack, { text: '', redacted, running: true });
    renderRack(rack);
    scrollEnd();
    return s.think;
  }

  function handleStreamEvent(apiEvent, scope) {
    const type = apiEvent?.type;
    if (type === 'message_start') {
      if (scope.stream?.think?.state === 'running') finishThink(scope.stream.think);
      scope.msgId = apiEvent.message?.id || null;
      scope.stream = null;
      ensureStream(scope);
      return;
    }
    if (type === 'message_stop') {
      // Keep the streamed row until the final `assistant` message replaces it.
      flushStream(scope);
      if (scope.stream?.row) scope.stream.row.classList.remove('streaming');
      return;
    }
    if (type === 'content_block_start') {
      const s = ensureStream(scope);
      s.claude = true; // only the SDK announces blocks
      const cb = apiEvent.content_block;
      s.blockType = cb?.type || null;
      if (s.blockType === 'tool_use' && cb?.id && cb?.name !== 'AskUserQuestion') {
        // A call is a step from its first streamed byte: the rack shows it now.
        if (!stepsById.has(cb.id)) {
          const rack = rackFor(scope, { msgId: s.msgId, claude: true });
          addCall(rack, { id: cb.id, name: cb.name, input: {} }, { ghost: true, extra: { msgId: s.msgId } });
          renderRack(rack);
          scrollEnd();
        }
        return;
      }
      if (s.blockType === 'thinking' || s.blockType === 'redacted_thinking') streamThink(scope, s, s.blockType === 'redacted_thinking');
      return;
    }
    if (type === 'content_block_delta') {
      const s = ensureStream(scope);
      const delta = apiEvent.delta;
      if (!delta) return;
      if (delta.type === 'thinking_delta' && delta.thinking) {
        // Codex and OpenCode send bare thinking deltas (no content_block_start).
        const step = streamThink(scope, s);
        step.text += delta.thinking;
        if (!s.thinkTimer) s.thinkTimer = setTimeout(() => { s.thinkTimer = null; refreshStep(step); if (step.rack.live) paintStage(step.rack); }, STREAM_TICK_MS);
      } else if (delta.type === 'text_delta' && delta.text != null) {
        s.textBuf += delta.text;
        if (!s.bodyEl && s.textBuf.trim()) {
          const { row, wrap } = assistantRow(scope, { _text: s.textBuf, _msgId: s.msgId, _claude: s.claude });
          row.classList.add('streaming');
          noteAnswer(scope, row);
          s.row = row;
          s.wrap = wrap;
          s.bodyEl = el('div', 'asst-md');
          wrap.appendChild(s.bodyEl);
        }
        if (s.row) s.row._text = s.textBuf;
        if (s.bodyEl && !s.mdTimer) {
          s.mdTimer = setTimeout(() => {
            s.mdTimer = null;
            if (!s.bodyEl) return;
            renderMarkdownInto(s.bodyEl, s.textBuf);
            scrollEnd();
          }, STREAM_TICK_MS);
        }
      }
      return;
    }
    if (type === 'content_block_stop') {
      const s = scope.stream;
      if (s?.bodyEl && s.mdTimer) { clearTimeout(s.mdTimer); s.mdTimer = null; renderMarkdownInto(s.bodyEl, s.textBuf); }
      if (s?.think && s.thinkTimer) { clearTimeout(s.thinkTimer); s.thinkTimer = null; refreshStep(s.think); }
    }
  }

  // ── Computer frames ──
  function frameCaption(card) {
    const info = card._computer || {};
    return [info.description, info.app].filter(Boolean).join(' · ');
  }

  function setComputerFrame(card, { thumb, full, size, coordinate, app }) {
    if (!card) return;
    const info = card._computer || (card._computer = {});
    info.thumb = thumb;
    info.full = full || thumb;
    info.size = size || null;
    info.app = app || info.app || '';
    info.marker = size ? markerPercent(coordinate, size) : null;
    let frame = card.querySelector('.asst-computer-frame');
    if (!frame) {
      frame = el('button', 'asst-computer-frame');
      frame.type = 'button';
      frame.innerHTML = '<img alt="" hidden><span class="asst-frame-marker" hidden></span>';
      frame.addEventListener('click', (e) => {
        e.stopPropagation();
        const data = card._computer || {};
        if (!data.full) return;
        openFrameLightbox({ src: data.full, marker: data.marker, caption: frameCaption(card), t: hooks.t, returnFocus: frame });
      });
      const hdr = card.querySelector('.asst-tool-hdr');
      hdr?.after(frame);
    }
    frame.setAttribute('aria-label', t('assistant.computer.openFrameOf', 'Open screenshot: {action}', { action: info.description || t('assistant.computer.frame', 'Screenshot') }));
    if (size?.width && size?.height) frame.style.aspectRatio = `${size.width} / ${size.height}`;
    const mark = frame.querySelector('.asst-frame-marker');
    if (info.marker) { mark.style.left = `${info.marker.x}%`; mark.style.top = `${info.marker.y}%`; mark.hidden = false; } else mark.hidden = true;
    frame.classList.remove('compact');
    const img = frame.querySelector('img');
    swapImage(img, thumb).then((ok) => { if (!ok) frame.classList.add('failed'); });
    if (!turnFrames.includes(card)) turnFrames.push(card);
    while (turnFrames.length > MAX_INLINE_FRAMES) {
      const old = turnFrames.shift();
      const oldFrame = old?.querySelector('.asst-computer-frame');
      if (!oldFrame) continue;
      // Drop the bitmap, keep a small "view frame" button for the lightbox.
      const oldImg = oldFrame.querySelector('img');
      if (oldImg) { oldImg.removeAttribute('src'); oldImg.hidden = true; delete oldImg.dataset.src; }
      oldFrame.classList.add('compact');
      oldFrame.style.aspectRatio = '';
      if (!oldFrame.querySelector('.asst-computer-frame-label')) oldFrame.appendChild(el('span', 'asst-computer-frame-label', t('assistant.computer.viewFrame', 'View screenshot')));
    }
  }

  function imageBlockUrl(content) {
    if (!Array.isArray(content)) return '';
    for (const b of content) {
      if (b?.type !== 'image') continue;
      const src = b.source || {};
      if (src.type === 'base64' && src.data) return `data:${src.media_type || 'image/png'};base64,${src.data}`;
      if (src.type === 'url' && src.url) return src.url;
    }
    return '';
  }

  // ── Full messages ──
  /** A message row: the text of a real message (or narration no call followed yet). */
  function textRow(scope, text, ctx = {}) {
    const { row, wrap } = assistantRow(scope, { _text: text, _msgId: ctx.msgId || null, _claude: !!ctx.claude });
    const body = el('div', 'asst-md');
    renderMarkdownInto(body, text);
    wrap.appendChild(body);
    noteAnswer(scope, row);
    return row;
  }

  /** The turn's latest message at the root: what the panel announces when the turn ends. */
  function noteAnswer(scope, row) {
    if (scope === rootScope && turnActive && !muted) turn.answerRow = row;
  }

  function renderAssistant(message, scope = rootScope, ev = null) {
    const content = Array.isArray(message?.content) ? message.content : (typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : []);
    const thinks = content.filter(b => (b?.type === 'thinking' && b.thinking) || b?.type === 'redacted_thinking');
    const texts = content.filter(b => b?.type === 'text' && typeof b.text === 'string');
    const tools = content.filter(b => b?.type === 'tool_use' && b.name !== 'AskUserQuestion'); // AskUserQuestion: a control card
    const ctx = { msgId: message?.id || scope.msgId || null, claude: !!ev?.uuid };
    // Text and thinking replace what was streamed for them. A tool-only message
    // (Codex/OpenCode send each call mid-stream; the SDK one per block) keeps the
    // streamed text as a row and closes it, so later deltas start below.
    const s = scope.stream;
    const liveText = !!s?.textBuf.trim();
    const streamedThink = s?.think || null;
    if (s) {
      flushStream(scope);
      if (texts.length) dropStreamText(scope);
      else if (s.row) {
        s.row.classList.remove('streaming');
        if (!s.wrap.children.length) s.row.remove();
        else if (s.textBuf.trim()) (scope.kept ||= new Set()).add(textKey(s.textBuf));
      }
      if (streamedThink && !thinks.length) finishThink(streamedThink);
      scope.stream = null;
    }
    if (!thinks.length && !texts.length && !tools.length) return null;
    let rack = null;
    let row = null;
    if (thinks.length) {
      const text = thinks.map(b => b.thinking || '').join('\n').trim();
      if (streamedThink?.rack.row.isConnected) { finishThink(streamedThink, text); rack = streamedThink.rack; }
      else { rack = rackFor(scope, ctx); addThink(rack, { text, redacted: !text, startedAt: scope.lastAt || nowMs() }); }
    }
    const rawMd = texts.map(b => b.text).join('\n');
    // Codex and OpenCode end a turn by re-sending its latest text; when that text
    // came before the last tool call, the rack (or the row kept above) already has it.
    const alreadyShown = !liveText && !!scope.kept?.has(textKey(rawMd));
    if (rawMd.trim() && !alreadyShown) {
      // Short narration directly followed by a call in the same message folds into the rack.
      if (tools.length && shouldFoldNarration(rawMd)) {
        rack = rackFor(scope, ctx);
        foldNarration(rack, null, rawMd.trim());
      } else row = textRow(scope, rawMd, ctx);
    }
    const fresh = [];
    for (const block of tools) {
      const known = block.id ? stepsById.get(block.id) : null;
      if (known) updateCall(known, block); else fresh.push(block);
    }
    if (fresh.length) {
      rack = rackFor(scope, ctx);
      for (const block of fresh) addCall(rack, block, { extra: { msgId: ctx.msgId } });
    }
    const touched = new Set([rack, ...tools.map(b => stepsById.get(b.id)?.rack)].filter(Boolean));
    for (const r of touched) renderRack(r);
    scrollEnd();
    return row || rack?.row || null;
  }

  function resultText(content) {
    if (Array.isArray(content)) return content.map(b => (typeof b === 'string' ? b : (b?.text || (b?.type === 'image' ? '[image]' : '') || ''))).join('\n');
    if (typeof content === 'string') return content;
    if (content != null) { try { return JSON.stringify(content, null, 2); } catch { return String(content); } }
    return '';
  }

  function updateToolResult(ev) {
    const id = ev?.tool_use_id;
    const step = id ? stepsById.get(id) : null;
    if (!step || step.type !== 'call') return;
    const text = resultText(ev.content);
    // The same result again (a replay of what is on screen): nothing changes, not even the clock.
    if (step.state !== 'running' && !step.stale && step.result === text) return;
    step.result = text;
    step.stale = false;
    let outcome = callOutcome(step, text, !!ev.is_error, t, ev.detail || null);
    const card = step.card;
    if (step.kind === 'computer' && card?._computer) {
      const parsed = parseComputerResult(text);
      if (parsed.ok === false) outcome = { state: 'error', code: null, detail: parsed.message || parsed.code || '' };
      if (parsed.app) { card._computer.app = parsed.app; step.app = parsed.app; }
      step.computerState = parsed.ok === false ? (parsed.code || t('assistant.tool.error', 'error')) : (parsed.app || t('assistant.tool.done', 'done'));
      const size = parsed.width && parsed.height ? { width: parsed.width, height: parsed.height } : null;
      const input = card._computer.input || {};
      if (parsed.frameId) {
        const urls = frameUrls(parsed.frameId);
        setComputerFrame(card, { thumb: urls.thumb, full: urls.full, size, coordinate: input.coordinate || input.start_coordinate, app: parsed.app });
      } else {
        const inline = imageBlockUrl(ev.content);
        if (inline) setComputerFrame(card, { thumb: inline, full: inline, size, coordinate: input.coordinate, app: parsed.app });
      }
    }
    step.state = outcome.state;
    step.detail = outcome.detail || '';
    step.code = outcome.code ?? null;
    step.endedAt = nowMs();
    step.timed = step.timed && isTimed();
    if (step.kind === 'runs') noteAgentResult(text);
    refreshStep(step);
    if (step.bodyBuilt) fillCallBody(step);
    if (step.state === 'error') onFailure(step);
    renderRack(step.rack);
    // A subagent that returned settles the racks in its feed; a child's result updates its parent's strip.
    if (step.kind === 'subagent') for (const r of racks) if (r.scope.key === step.id) renderRack(r);
    if (step.parent?.rack) renderRack(step.parent.rack);
  }

  // ── Rack steps ──
  function parentOf(scope) {
    return scope?.key ? stepsById.get(scope.key) || null : null;
  }

  function addCall(rack, block, { ghost = false, extra = null } = {}) {
    const kind = kindOf(block.name, block.input);
    const step = {
      type: 'call', id: block.id || `call-${++stepSeq}`, seq: ++stepSeq, name: block.name || 'tool', kind, key: stationKey(kind, block.name),
      input: block.input || {}, state: 'running', result: '', detail: '', code: null, startedAt: nowMs(), endedAt: 0, progress: 0,
      timed: isTimed(), ghost, stale: false, rack, station: null, card: null, parent: parentOf(rack.scope), bodyBuilt: false,
      ...(extra || {}),
    };
    if (step.state !== 'running' && !step.endedAt) step.endedAt = step.startedAt;
    if (block.id) stepsById.set(block.id, step);
    placeStep(rack, step);
    if (!muted && turnActive && !step.auto) { turn.calls += 1; turn.last = step; }
    if (rack.steps.length === 1 && !muted && turnActive) announce(rack, stepSentence(step, step.state === 'running'));
    return step;
  }

  /** The final block of a streamed call, or the same block replayed: the step learns its input, nothing is added. */
  function updateCall(step, block) {
    if (block.name) step.name = block.name;
    if (block.input && typeof block.input === 'object' && Object.keys(block.input).length) step.input = block.input;
    step.ghost = false;
    if (step.card?._computer) { step.card._computer.input = step.input; step.card._computer.description = describeComputerAction(step.input, step.name); }
    refreshStep(step);
    if (step.bodyBuilt) fillCallBody(step);
  }

  function addThink(rack, { text = '', redacted = false, running = false, startedAt = null } = {}) {
    const step = {
      type: 'think', id: `think-${++stepSeq}`, seq: stepSeq, name: 'thinking', kind: 'think', key: 'think', input: {}, text, redacted,
      state: running ? 'running' : 'ok', startedAt: startedAt ?? nowMs(), endedAt: running ? 0 : nowMs(), timed: isTimed(),
      stale: false, rack, station: null, card: null, parent: parentOf(rack.scope), bodyBuilt: false,
    };
    placeStep(rack, step);
    return step;
  }

  function finishThink(step, text) {
    if (typeof text === 'string' && text) step.text = text;
    if (!step.text) step.redacted = true;
    if (step.state === 'running') { step.state = 'ok'; step.endedAt = nowMs(); }
    refreshStep(step);
    if (step.bodyBuilt) fillCallBody(step);
    renderRack(step.rack);
  }

  function placeStep(rack, step) {
    rack.steps.push(step);
    rack.timeline.push(step);
    const st = ensureStation(rack, step);
    st.steps.push(step);
    step.station = st;
    step.card = buildCallNode(step);
    st.log.appendChild(step.card);
    if (st.open) buildCallBody(step);
    if (!rack.firstAt) rack.firstAt = step.startedAt;
    if (step.parent) {
      (step.parent.children ||= []).push(step);
      if (step.parent.rack.row.isConnected) renderRack(step.parent.rack);
    }
  }

  // ── Narration ──
  /** The row before `node`, skipping rows on their way out. */
  function prevRow(node) {
    let prev = node?.previousElementSibling || null;
    while (prev && prev.classList.contains('asst-folding')) prev = prev.previousElementSibling;
    return prev;
  }

  /** The scope's last row, skipping "Working…" and rows folding into a rack. */
  function tailRow(scope) {
    let node = scope.container.lastElementChild;
    while (node && (node === working || node.classList.contains('asst-folding'))) node = node.previousElementSibling;
    return node;
  }

  /** A short text row that can still fold into the rack above it (the call after it has not come yet). */
  function narrationCandidate(row) {
    if (!row || row._sealed || typeof row._text !== 'string' || !row.classList.contains('msg-assistant')) return false;
    if (row.classList.contains('asst-msg-error') || row.classList.contains('asst-local-output')) return false;
    return shouldFoldNarration(row._text);
  }

  function narrationOf(row, ctx = {}) {
    if (!narrationCandidate(row)) return null;
    // Claude: narration folds only into a call of the same assistant message.
    if (ctx.claude && row._claude && ctx.msgId && row._msgId && ctx.msgId !== row._msgId) return null;
    return row._text.trim();
  }

  function usableRack(rack, scope) {
    return !!rack && !rack.closed && rack.scope === scope && rack.row.isConnected;
  }

  /** The rack a new call, thinking block or memory step joins: the tail rack, else a new one; narration just above folds in. */
  function rackFor(scope, ctx = {}) {
    const tail = tailRow(scope);
    if (usableRack(tail?._rack, scope)) return tail._rack;
    const text = tail && !ctx.noFold ? narrationOf(tail, ctx) : null;
    if (text != null) {
      const prev = prevRow(tail);
      const rack = usableRack(prev?._rack, scope) ? prev._rack : createRack(scope);
      foldNarration(rack, tail, text);
      return rack;
    }
    return createRack(scope);
  }

  /** The rack at the end of the scope, looking through one short text row that may still fold into it. */
  function liveTail(scope) {
    let node = tailRow(scope);
    if (node && !node._rack && narrationCandidate(node)) node = prevRow(node);
    return node?._rack || null;
  }

  /** Narration becomes the stage caption and a "said" entry; its row collapses into the rack (instantly on replay). */
  function foldNarration(rack, row, text) {
    const said = { type: 'said', text, at: nowMs(), seq: ++stepSeq };
    rack.said.push(said);
    rack.timeline.push(said);
    (rack.scope.kept ||= new Set()).add(textKey(text));
    if (row) {
      const s = rack.scope.stream;
      if (s?.row === row) { if (s.mdTimer) clearTimeout(s.mdTimer); s.mdTimer = null; s.row = null; s.wrap = null; s.bodyEl = null; s.textBuf = ''; }
      collapseRow(row);
    }
    if (!muted && turnActive) announce(rack, text);
  }

  function collapseRow(row) {
    if (calm() || !row.isConnected || typeof row.animate !== 'function') { row.remove(); return; }
    row.classList.add('asst-folding');
    const h = row.offsetHeight;
    const anim = row.animate(
      [{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0, marginTop: '0px' }],
      { duration: FOLD_MS, easing: 'cubic-bezier(.2,0,.38,.9)', fill: 'forwards' },
    );
    row.style.overflow = 'hidden';
    const done = () => row.remove();
    anim.onfinish = done;
    anim.oncancel = done;
    setTimeout(done, FOLD_MS + 120);
  }

  /** A turn boundary: the tail text is a message for good, and every rack of the scope is closed. */
  function sealScope(scope) {
    const tail = tailRow(scope);
    if (tail && !tail._rack) tail._sealed = true;
    for (const rack of racks) if (rack.scope === scope) rack.closed = true;
  }

  // ── Racks ──
  function createRack(scope) {
    const id = ++rackSeq;
    const nested = scope.container !== $msgs;
    const row = el('div', 'asst-rack');
    row.dataset.state = 'settled';
    row.dataset.view = 'kind';
    row.setAttribute('role', 'group');
    const ledgerId = `asst-rack-${id}-ledger`;
    row.innerHTML = `<div class="asst-rack-stage">
        <div class="asst-rack-face" aria-hidden="true"></div>
        <div class="asst-rack-caption"></div>
        <div class="asst-bubble" aria-live="off" hidden><span class="asst-bubble-verb"></span><span class="asst-bubble-subject" role="button" tabindex="-1" aria-expanded="false"><span class="asst-bubble-text"></span><span class="asst-bubble-caret" aria-hidden="true"></span></span><span class="asst-bubble-meta"></span><span class="asst-bubble-err" hidden></span></div>
        <div class="asst-rack-sweep" aria-hidden="true"></div>
      </div>
      <button type="button" class="asst-rack-receipt" aria-expanded="false" aria-controls="${ledgerId}"><span class="asst-rack-receipt-face" aria-hidden="true"></span><span class="asst-rack-receipt-text"></span><span class="asst-rack-receipt-failed" hidden></span><span class="asst-rack-receipt-clock"></span><span class="asst-rack-chev" aria-hidden="true">&#x203A;</span></button>
      <div class="asst-rack-view" role="group" aria-label="${esc(t('assistant.rack.view.label', 'Show calls'))}"><button type="button" data-view="kind" aria-pressed="true">${esc(t('assistant.rack.view.kind', 'By kind'))}</button><button type="button" data-view="time" aria-pressed="false">${esc(t('assistant.rack.view.time', 'Timeline'))}</button></div>
      <ol class="asst-rack-ledger" id="${ledgerId}"></ol>
      <div class="asst-rack-status" role="status" aria-live="polite"></div><div class="asst-rack-alert" role="alert"></div>`;
    const q = (sel) => row.querySelector(sel);
    const rack = {
      id, row, scope, nested, closed: false, live: false, staged: false, open: false, view: 'kind', everAwake: false,
      stations: new Map(), steps: [], timeline: [], said: [], firstAt: 0,
      stage: { el: q('.asst-rack-stage'), face: q('.asst-rack-face'), caption: q('.asst-rack-caption'), bubble: q('.asst-bubble'), verb: q('.asst-bubble-verb'), subject: q('.asst-bubble-subject'), text: q('.asst-bubble-text'), meta: q('.asst-bubble-meta'), err: q('.asst-bubble-err') },
      receipt: { btn: q('.asst-rack-receipt'), face: q('.asst-rack-receipt-face'), text: q('.asst-rack-receipt-text'), failed: q('.asst-rack-receipt-failed'), clock: q('.asst-rack-receipt-clock'), faceBuilt: false, pose: '', svg: null },
      ledger: q('.asst-rack-ledger'), statusEl: q('.asst-rack-status'), alertEl: q('.asst-rack-alert'), timelineEl: null, timelineSig: '',
      rig: null, target: null, held: false, holdUntil: 0, holdTimer: 0, pose: null, awake: null, awakeKey: null,
      bubble: { step: null, since: 0, key: '', open: false }, stageTimer: 0, clearTimer: 0,
      sr: { last: 0, timer: 0, pending: '' },
    };
    row._rack = rack;
    rack.receipt.btn.addEventListener('click', () => setRackOpen(rack, !rack.open));
    row.querySelector('.asst-rack-view').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (btn) setRackView(rack, btn.dataset.view);
    });
    rack.ledger.addEventListener('click', (e) => {
      const hdr = e.target.closest('.asst-station-hdr');
      const owner = hdr ? headers.get(hdr) : null;
      if (owner?.rack === rack) setStationOpen(rack, owner.st, !owner.st.open);
    });
    rack.ledger.addEventListener('keydown', (e) => onLedgerKey(rack, e));
    rack.stage.subject.addEventListener('click', () => setBubbleOpen(rack, !rack.bubble.open));
    rack.stage.subject.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBubbleOpen(rack, !rack.bubble.open); } });
    racks.add(rack);
    append(row, scope);
    return rack;
  }

  function ensureStation(rack, step) {
    let st = rack.stations.get(step.key);
    if (st) return st;
    const li = el('li', 'asst-station');
    li.dataset.kind = step.kind;
    li.dataset.state = 'idle';
    const logId = `asst-rack-${rack.id}-${step.key.replace(/[^\w-]/g, '_')}`;
    li.innerHTML = `<button type="button" class="asst-station-hdr" aria-expanded="false" aria-controls="${logId}" tabindex="${rack.stations.size ? -1 : 0}"><span class="asst-station-face" aria-hidden="true"></span><span class="asst-station-label"></span><span class="asst-station-agg"></span><span class="asst-station-ticks"></span><span class="asst-station-time"></span></button>${step.kind === 'subagent' ? '<div class="asst-station-sub"></div>' : ''}<ol class="asst-station-log" id="${logId}" hidden></ol>`;
    const q = (sel) => li.querySelector(sel);
    st = {
      key: step.key, kind: step.kind, li, hdr: q('.asst-station-hdr'), face: q('.asst-station-face'), label: q('.asst-station-label'), agg: q('.asst-station-agg'),
      ticks: q('.asst-station-ticks'), time: q('.asst-station-time'), sub: q('.asst-station-sub'), log: q('.asst-station-log'),
      steps: [], open: false, faceMode: '', tickSig: '', tickCount: 0, subSig: '', server: step.kind === 'mcp' ? mcpServerOf(step.name) : '',
    };
    headers.set(st.hdr, { rack, st });
    rack.stations.set(step.key, st);
    rack.ledger.appendChild(li);
    if (!muted && rack.live && typeof li.animate === 'function' && !calm()) li.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'cubic-bezier(0,0,.38,.9)' });
    // Screenshots stay in view: the Computer row always lists its calls (their details open with the row).
    if (step.kind === 'computer') st.log.hidden = false;
    return st;
  }

  function setStationOpen(rack, st, open) {
    st.open = !!open;
    st.li.classList.toggle('is-open', st.open);
    st.hdr.setAttribute('aria-expanded', st.open ? 'true' : 'false');
    st.log.hidden = !st.open && st.kind !== 'computer';
    if (st.open) for (const step of st.steps) buildCallBody(step);
    renderStationFace(rack, st);
  }

  function setRackOpen(rack, open) {
    rack.open = !!open;
    rack.row.classList.toggle('is-open', rack.open);
    rack.receipt.btn.setAttribute('aria-expanded', rack.open ? 'true' : 'false');
    // One call: opening the receipt shows the call itself.
    if (rack.open && rack.steps.length === 1) { const st = rack.stations.values().next().value; if (st && !st.open) setStationOpen(rack, st, true); }
    if (rack.open) for (const st of rack.stations.values()) renderStationFace(rack, st);
    if (rack.open && rack.view === 'time') renderTimeline(rack);
  }

  function setRackView(rack, view) {
    rack.view = view === 'time' ? 'time' : 'kind';
    rack.row.dataset.view = rack.view;
    for (const btn of rack.row.querySelectorAll(':scope > .asst-rack-view > button')) btn.setAttribute('aria-pressed', btn.dataset.view === rack.view ? 'true' : 'false');
    if (rack.view === 'time') renderTimeline(rack);
  }

  /** Rows are a roving tab stop: ↑/↓ move, →/← open and close, Home/End jump. */
  function onLedgerKey(rack, e) {
    const hdr = e.target.closest?.('.asst-station-hdr');
    const owner = hdr ? headers.get(hdr) : null;
    if (!owner || owner.rack !== rack) return;
    const list = [...rack.stations.values()].filter(st => st.hdr.getClientRects().length);
    const at = list.indexOf(owner.st);
    let next = null;
    if (e.key === 'ArrowDown') next = list[Math.min(list.length - 1, at + 1)];
    else if (e.key === 'ArrowUp') next = list[Math.max(0, at - 1)];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (!owner.st.open) setStationOpen(rack, owner.st, true); return; }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (owner.st.open) setStationOpen(rack, owner.st, false); return; }
    else return;
    e.preventDefault();
    if (!next) return;
    for (const st of rack.stations.values()) st.hdr.tabIndex = st === next ? 0 : -1;
    next.hdr.focus();
  }

  function setBubbleOpen(rack, open) {
    rack.bubble.open = !!open;
    rack.stage.subject.setAttribute('aria-expanded', rack.bubble.open ? 'true' : 'false');
    rack.bubble.key = '';
    paintBubble(rack, Date.now(), { swap: false });
  }

  /** Live: the burst is the open tail of a running turn, or a call of it is still running. */
  function rackLive(rack) {
    if (!turnActive || !rack.row.isConnected) return false;
    if (rack.steps.some(s => s.state === 'running' && !s.stale)) return true;
    return !rack.closed && liveTail(rack.scope) === rack && scopeBusy(rack.scope);
  }

  /** A subagent's feed is busy until its Agent/Task call has a result. */
  function scopeBusy(scope) {
    if (scope === rootScope || !scope.key) return true;
    const parent = stepsById.get(scope.key);
    return !parent || (parent.state === 'running' && !parent.stale);
  }

  // ── Waiting on a card ──
  /** A card waits on the user (true + the call's tool_use id when known), or none (false). */
  function setWaiting(on, toolUseId = null) {
    const id = on ? (toolUseId ? String(toolUseId) : null) : null;
    if (!on && !waiting) return;
    if (on && waiting && waiting.id === id) return;
    waiting = on ? { id, since: Date.now() } : null;
    for (const rack of [...racks]) if (rack.live || rack.waiting) renderRack(rack);
  }

  /** The rack a waiting card holds: the one with its call, else the newest live stage. */
  function waitingRack() {
    if (!waiting) return null;
    const step = waiting.id ? stepsById.get(waiting.id) : null;
    if (step?.rack?.live && !step.rack.nested && step.rack.row.isConnected) return step.rack;
    let best = null;
    for (const rack of racks) if (rack.live && !rack.nested && rack.row.isConnected && (!best || rack.id > best.id)) best = rack;
    return best;
  }

  /** The call the card holds in `rack`: its own, else the newest one still running. */
  function waitingStep(rack) {
    if (!rack?.waiting) return null;
    const own = waiting?.id ? stepsById.get(waiting.id) : null;
    if (own && own.rack === rack && own.state === 'running' && !own.stale) return own;
    let best = null;
    for (const s of rack.steps) if (s.type === 'call' && s.state === 'running' && !s.stale && (!best || s.startedAt >= best.startedAt)) best = s;
    return best;
  }

  /** The rack's clock: stopped while a card holds it. */
  const rackNow = (rack) => (rack.waiting && rack.waitingSince ? rack.waitingSince : Date.now());

  function renderRack(rack) {
    const { row } = rack;
    if (!row.isConnected) { dropRack(rack); return; }
    const live = rackLive(rack);
    const was = rack.live;
    rack.live = live;
    rack.waiting = live && !rack.nested && !!waiting && waitingRack() === rack;
    rack.waitingSince = rack.waiting ? waiting.since : 0;
    const now = Date.now();
    if (live) evalAwake(rack, now);
    else { rack.awake = null; rack.awakeKey = null; }
    const single = rack.steps.length === 1;
    row.dataset.state = rack.waiting ? 'waiting' : live ? 'live' : 'settled';
    row.classList.toggle('is-live', live);
    row.classList.toggle('is-single', single);
    row.classList.toggle('is-nested', rack.nested);
    if (live && rack.awake) row.dataset.kind = rack.awake.step.kind; else delete row.dataset.kind;
    // A settled stage stays up while it holds for the turn's success or error (holdStage).
    const holding = rack.staged && rack.holdUntil > now;
    setStaged(rack, (live || holding) && !rack.nested && (rack.steps.length > 1 || rack.everAwake));
    for (const st of rack.stations.values()) renderStation(rack, st);
    const sentence = receiptSentence(groupsOf(rack), { t, locale: locale() }); // once per render: receipt and label share it
    renderReceipt(rack, sentence);
    renderRackLabel(rack, sentence);
    if (live) { if (rack.staged) paintStage(rack, now); scheduleStage(rack, now); needTicker(); }
    else if (was) settle(rack);
    if (rack.open && rack.view === 'time') renderTimeline(rack);
    if (working?.isConnected) syncWorkingFace();
  }

  // ── Stage ──
  /** The awake call: the newest one still running that has run 350 ms; else the last awake one to finish, for 1.2 s. */
  function evalAwake(rack, now) {
    // A card holds a call: that call is on stage, whether or not it has run 350 ms.
    const held = waitingStep(rack);
    if (held) {
      held.woke = true;
      rack.awake = { step: held };
      rack.awakeKey = held.key;
      rack.everAwake = true;
      return;
    }
    let best = null;
    for (const s of rack.steps) {
      if (s.state !== 'running' || s.stale || now - s.startedAt < WAKE_MS) continue;
      if (!best || s.startedAt > best.startedAt || (s.startedAt === best.startedAt && s.seq > best.seq)) best = s;
    }
    if (best) best.woke = true;
    else {
      for (const s of rack.steps) if (s.woke && s.endedAt && now - s.endedAt < LINGER_MS && (!best || s.endedAt > best.endedAt)) best = s;
    }
    rack.awake = best ? { step: best } : null;
    rack.awakeKey = best ? best.key : null;
    if (best) rack.everAwake = true;
  }

  function scheduleStage(rack, now) {
    clearTimeout(rack.stageTimer);
    rack.stageTimer = 0;
    if (!rack.live) return;
    let at = Infinity;
    for (const s of rack.steps) {
      if (s.state === 'running' && !s.stale && !s.woke && now - s.startedAt < WAKE_MS) at = Math.min(at, s.startedAt + WAKE_MS);
      if (s.woke && s.endedAt && now - s.endedAt < LINGER_MS) at = Math.min(at, s.endedAt + LINGER_MS);
    }
    if (rack.bubble.pendingAt) at = Math.min(at, rack.bubble.pendingAt);
    if (at === Infinity) return;
    rack.stageTimer = setTimeout(() => { rack.stageTimer = 0; renderRack(rack); }, Math.max(16, at - now + 5));
  }

  function setStaged(rack, staged) {
    if (rack.staged === staged) return;
    rack.staged = staged;
    rack.stage.subject.tabIndex = staged ? 0 : -1;
    if (staged) {
      clearTimeout(rack.clearTimer);
      rack.clearTimer = 0;
      rack.row.classList.add('is-staged');
      if (!rack.rig) {
        try { rack.rig = mascotLib.createMascot(rack.stage.face, { width: 72, height: 36, rangeX: 10, rangeY: 7, active: rigsOn, pose: 'idle' }); } catch { rack.rig = null; }
        rack.pose = null;
        rack.target = rack.rig ? stageTarget(rack) : null;
        if (hero?.parked) dropHero(); // the stage is the character now: a hero still on its way out goes at once
      }
      mascotChanged();
      return;
    }
    // Fold the stage into the receipt; a rack above the viewport folds at once and the scroll position absorbs it.
    // Keyboard focus inside the stage (the bubble, its Copy) moves to the receipt, which takes the stage's place.
    const row = rack.row;
    const focused = rack.stage.el.contains(document.activeElement);
    let above = false;
    if (!calm() && row.isConnected) {
      const box = row.getBoundingClientRect();
      above = box.bottom <= $msgs.getBoundingClientRect().top + 1;
    }
    if (calm() || above) {
      const h = above ? rack.stage.el.offsetHeight : 0;
      row.classList.add('is-instant');
      row.classList.remove('is-staged');
      void row.offsetHeight; // apply without the transition
      row.classList.remove('is-instant');
      if (h) $msgs.scrollTop = Math.max(0, $msgs.scrollTop - h);
    } else {
      row.classList.remove('is-staged');
    }
    if (focused) {
      try { rack.receipt.btn.focus({ preventScroll: true }); } catch { /* not focusable yet */ }
    }
    clearTimeout(rack.clearTimer);
    rack.clearTimer = setTimeout(() => { rack.clearTimer = 0; clearStage(rack); }, calm() || above ? 0 : COLLAPSE_MS);
  }

  /** A folded stage keeps nothing: its rig goes, its texts empty (a settled rack is the same live or replayed). */
  function clearStage(rack) {
    if (rack.staged) return;
    const had = !!rack.rig;
    rack.rig?.destroy?.();
    rack.rig = null;
    rack.target = null;
    rack.held = false;
    rack.pose = null;
    if (had) mascotChanged();
    const s = rack.stage;
    s.face.textContent = '';
    s.caption.textContent = '';
    s.bubble.hidden = true;
    delete s.bubble.dataset.state;
    delete s.bubble.dataset.kind;
    s.verb.textContent = '';
    s.text.textContent = '';
    s.subject.removeAttribute('title');
    s.subject.className = 'asst-bubble-subject';
    s.subject.setAttribute('aria-expanded', 'false');
    s.meta.textContent = '';
    s.err.textContent = '';
    s.err.hidden = true;
    s.bubble.querySelector('.asst-bubble-copy')?.remove();
    rack.bubble = { step: null, since: 0, key: '', open: false };
  }

  /** One rig animates: the hero, else the newest stage, else the "Thinking" row's; none while another panel leads (setRigsEnabled). */
  function activateRigs() {
    const newest = hero?.rig ? null : newestStage();
    for (const rack of racks) if (rack.rig) rack.rig.setActive?.(rigsOn && rack === newest);
    hero?.rig?.setActive?.(rigsOn);
    workingFace?.rig?.setActive?.(rigsOn && !hero?.rig && !newest);
  }

  /** The bubble's call: the awake one, else the newest; it holds 900 ms (3 s for thinking) before the next wins. */
  function bubbleTarget(rack) {
    if (rack.awake) return rack.awake.step;
    let best = null;
    for (const s of rack.steps) if (!best || s.startedAt > best.startedAt || (s.startedAt === best.startedAt && s.seq > best.seq)) best = s;
    return best;
  }

  /** Pose options the rig understands: memory recalls or saves, how many subagents run, how far the plan got. */
  function poseOptions(rack, step) {
    if (!step) return undefined;
    if (step.kind === 'memory') return { mode: /remember|reflect/.test(String(step.name).toLowerCase()) ? 'remember' : 'recall' };
    if (step.kind === 'subagent') return { count: Math.max(1, Math.min(3, rack.steps.filter(s => s.kind === 'subagent' && s.state === 'running' && !s.stale).length)) };
    if (step.kind === 'plan') return { ticks: Math.min(3, planState(step.input).done) };
    return undefined;
  }

  /**
   * The bubble's call failed and no call started after it: the stage keeps
   * the error pose (only a success smiles) until the next call begins.
   */
  function failedOnStage(rack) {
    const step = rack.bubble.step;
    if (!step || step.state !== 'error') return null;
    return rack.steps.some(s => s !== step && s.startedAt > (step.endedAt || step.startedAt)) ? null : step;
  }

  /** The stage's character acts out the awake call (idle between calls); a pose the director holds stays. */
  function poseStage(rack) {
    if (!rack.rig || rack.held) return;
    const failed = failedOnStage(rack);
    const step = failed || (rack.awake ? rack.awake.step : null);
    const kind = failed ? 'error' : step ? step.kind : 'idle';
    const opts = failed ? undefined : poseOptions(rack, step);
    const poseKey = `${kind}|${opts ? JSON.stringify(opts) : ''}`;
    if (rack.pose === poseKey) return;
    const wasStep = rack.poseStep;
    rack.rig.setPose?.(kind, opts);
    rack.pose = poseKey;
    rack.poseStep = step;
    // A new call answers with a small gesture: the computer clicks, the plan ticks a box.
    if (step && !failed && step !== wasStep && !calm()) {
      if (step.kind === 'computer' && /click/.test(String(step.input?.action || ''))) rack.rig.react?.('click');
      else if (step.kind === 'plan') rack.rig.react?.('pop');
    }
  }

  function paintStage(rack, now) {
    const target = bubbleTarget(rack);
    const shown = rack.bubble.step;
    rack.bubble.pendingAt = 0;
    if (target && target !== shown) {
      const hold = shown?.type === 'think' ? THINK_HOLD_MS : HOLD_MS;
      // A card holding a call takes the bubble at once; otherwise the shown call keeps it its dwell time.
      if (!rack.waiting && shown && shown.rack === rack && now - rack.bubble.since < hold) rack.bubble.pendingAt = rack.bubble.since + hold;
      else { rack.bubble.step = target; rack.bubble.since = now; }
    }
    poseStage(rack);
    paintBubble(rack, now, { swap: true });
    paintCaption(rack);
  }

  function paintCaption(rack) {
    const step = rack.bubble.step;
    const say = step ? sayOf(step) : null;
    const text = (say?.caption) || rack.said[rack.said.length - 1]?.text || '';
    if (rack.stage.caption.textContent !== text) rack.stage.caption.textContent = text;
  }

  /** Same-kind calls beside the bubble's call (one message, or running side by side): "a.js, b.js +1", or a re-read "server.js ×2". */
  function groupedSubject(rack, step) {
    if (step.type !== 'call') return '';
    const running = (x) => x.state === 'running' && !x.stale;
    const peers = step.station.steps.filter(s => s !== step && s.type === 'call' && ((step.msgId && s.msgId === step.msgId) || (running(s) && running(step))));
    return groupSubject(step.kind, [...peers, step], step.station.steps);
  }

  function paintBubble(rack, now, { swap = false } = {}) {
    const s = rack.stage;
    const step = rack.bubble.step;
    if (!step) { s.bubble.hidden = true; return; }
    const say = sayOf(step);
    const running = step.state === 'running' && !step.stale;
    const held = rack.waiting && step === waitingStep(rack);
    const verb = held ? t('assistant.rack.waiting', 'Waiting for you') : verbText(say.verb, running, t);
    const grouped = groupedSubject(rack, step);
    const full = grouped || say.text;
    const literal = !grouped && say.full ? say.full : full; // the command as written: the title and the opened bubble
    const open = rack.bubble.open;
    // Narrow stages cut from the head, so the file name (the tail) survives.
    const cut = subjectCut(rack);
    const budget = subjectBudget(rack, verb, cut);
    const shownText = open ? literal : cut === 'head' ? headEllipsis(full, budget) : middleEllipsis(full, budget, 24);
    const key = `${step.id}|${verb}|${shownText}|${say.muted ? 1 : 0}`;
    s.bubble.hidden = !full && !verb;
    s.bubble.dataset.state = held ? 'waiting' : running ? 'running' : step.state;
    s.bubble.dataset.kind = step.kind;
    if (key !== rack.bubble.key) {
      const changedStep = !rack.bubble.key.startsWith(`${step.id}|`);
      rack.bubble.key = key;
      const write = () => {
        s.verb.textContent = verb;
        s.subject.className = `asst-bubble-subject${say.mono ? ' is-mono' : ''}${say.muted ? ' is-muted' : ''}`;
        writeSubject(s.text, grouped || open ? null : say.segments, shownText);
        if (literal !== shownText || open) s.subject.title = literal; else s.subject.removeAttribute('title');
      };
      if (swap && changedStep && !calm() && typeof s.subject.animate === 'function' && s.text.textContent) {
        s.subject.getAnimations?.().forEach(a => a.cancel());
        const out = s.subject.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 80, easing: 'cubic-bezier(.2,0,1,.9)', fill: 'forwards' });
        out.onfinish = () => {
          write();
          out.cancel();
          s.subject.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'cubic-bezier(0,0,.38,.9)' });
        };
      } else write();
    }
    paintBubbleMeta(rack, step, say, now);
    const err = step.state === 'error' ? (step.detail || exitText(step)) : '';
    s.err.hidden = !err;
    if (s.err.textContent !== err) s.err.textContent = err;
    let copy = s.bubble.querySelector('.asst-bubble-copy');
    if (open && (say.copy || full)) {
      if (!copy) { copy = el('button', 'asst-bubble-copy', t('assistant.rack.copy', 'Copy')); copy.type = 'button'; copy.addEventListener('click', (e) => { e.stopPropagation(); const st = rack.bubble.step; copyText(st ? (sayOf(st).copy || sayOf(st).text) : ''); copy.textContent = t('assistant.rack.copied', 'Copied'); setTimeout(() => { copy.textContent = t('assistant.rack.copy', 'Copy'); }, 1200); }); s.bubble.appendChild(copy); }
    } else copy?.remove();
  }

  /**
   * How many characters of subject fit the bubble: two lines of the column
   * beside the verb, measured on the laid-out stage. The text is cut in the
   * middle so its tail (the file, the last argument) stays; on a narrow stage
   * from the head (subjectCut).
   */
  function subjectBudget(rack, verb, cut = 'middle') {
    const s = rack.stage;
    const width = s.el.clientWidth;
    if (!width) return 96;
    const face = s.face.getBoundingClientRect();
    const bubble = s.bubble.hidden ? null : s.bubble.getBoundingClientRect();
    const beside = !bubble || bubble.left >= face.right - 1;
    const verbPx = Math.max(s.verb.getBoundingClientRect().width, verb.length * 7);
    const column = width - 28 - 22 - (beside ? face.width + 8 : 0) - verbPx - 7;
    const perLine = Math.max(12, Math.floor(column / 7));
    // Two lines, less what wrapping at token boundaries wastes (a head cut wraps anywhere: two full lines).
    const lines = getComputedStyle(s.subject).whiteSpace === 'nowrap' ? 1 : cut === 'head' ? 2 : 1.7;
    return Math.max(24, Math.min(240, Math.floor(perLine * lines) - 1));
  }

  /** 'head' where the stylesheet says so (≤320 px: keep the tail), else 'middle'. */
  function subjectCut(rack) {
    try { return getComputedStyle(rack.stage.subject).getPropertyValue('--rk-cut').trim() === 'head' ? 'head' : 'middle'; } catch { return 'middle'; }
  }

  /** "…ender-events.browser.mjs": the last `max` chars, from a token boundary when one is near. */
  function headEllipsis(text, max) {
    const s = String(text ?? '');
    if (s.length <= max) return s;
    let tail = s.slice(s.length - Math.max(8, max - 1));
    const cut = tail.search(/[\s/]/);
    if (cut > 0 && cut < tail.length * 0.4) tail = tail.slice(tail[cut] === '/' ? cut : cut + 1);
    return `…${tail}`;
  }

  function writeSubject(node, segments, text) {
    node.textContent = '';
    if (Array.isArray(segments) && segments.length && segments.map(x => x.text).join('') === text) {
      for (const seg of segments) node.appendChild(el('span', seg.cls ? `is-${seg.cls}` : '', seg.text));
    } else node.textContent = text;
  }

  /** How many calls of the rack act on the bubble call's target (itself included): a re-run or re-read reads ×N. */
  function repeatCount(step) {
    if (step.type !== 'call') return 1;
    const key = targetKey(step);
    return key ? step.station.steps.filter(s => s.type === 'call' && targetKey(s) === key).length : 1;
  }

  /** Row 2 of the bubble: numbers in their own tabular spans (time, ×N, counts). */
  function paintBubbleMeta(rack, step, say, now) {
    const meta = rack.stage.meta;
    const parts = [];
    const running = step.state === 'running' && !step.stale;
    // A card holding the call stops its clock where the wait began.
    const clock = rack.waiting && step === waitingStep(rack) ? rack.waitingSince : now;
    const ms = running ? Math.max((step.progress || 0) * 1000, clock - step.startedAt) : (step.endedAt && step.timed ? step.endedAt - step.startedAt : null);
    const time = ms != null && (running ? ms >= 1000 : true) ? fmtDuration(ms, t) : '';
    for (const m of say.meta) parts.push(['m', m]);
    if (say.tag) parts.push(['m', say.tag]);
    // A subagent's bubble follows its child: the step the agent is on now.
    if (step.kind === 'subagent' && step.children?.length) {
      const child = step.children.filter(c => c.type === 'call' || (c.state === 'running' && !c.stale)).reduce((a, b) => (!a || b.startedAt >= a.startedAt ? b : a), null);
      if (child) parts.push(['m', middleEllipsis(stepSentence(child, child.state === 'running' && !child.stale), 60, 24)]);
    }
    // ×N only for the same target again (a re-run, a re-read): a number the ledger agrees with.
    // Other calls in the same 800 ms burst read as a sentence instead.
    const grouped = groupedSubject(rack, step);
    const repeats = repeatCount(step);
    if (repeats >= 2 && !/×\d+$/.test(grouped)) parts.push(['m', `×${repeats}`]);
    else if (repeats < 2 && !grouped) {
      const burst = rack.steps.filter(s => s !== step && s.type === 'call' && step.startedAt - s.startedAt >= 0 && step.startedAt - s.startedAt <= BURST_MS).length;
      if (burst >= 2) parts.push(['m', plural(t, 'assistant.rack.moreSteps', burst, '+1 more step', '+{count} more steps')]);
    }
    const sig = parts.map(p => p[1]).join('\u0001');
    if (meta._sig !== sig) {
      meta._sig = sig;
      meta.textContent = '';
      for (const [, text] of parts) meta.appendChild(el('span', 'asst-bubble-num', text));
      meta._time = null;
    }
    let node = meta._time;
    if (time && !node?.isConnected) { node = el('span', 'asst-bubble-num asst-odo'); meta.appendChild(node); meta._time = node; node._odo = ''; }
    if (node) { if (time) setOdometer(node, time); else { node.remove(); meta._time = null; } }
  }

  /** Digits roll when they change (a tabular odometer); no motion when calm. */
  function setOdometer(node, text) {
    if (node._odo === text) return;
    const prev = node._odo || '';
    node._odo = text;
    if (calm() || prev.length !== text.length) {
      node.textContent = '';
      for (const ch of text) node.appendChild(el('span', 'asst-odo-d', ch));
      return;
    }
    const digits = node.children;
    for (let i = 0; i < text.length; i += 1) {
      const d = digits[i];
      if (!d || d.textContent === text[i]) continue;
      d.textContent = text[i];
      if (/\d/.test(text[i]) && typeof d.animate === 'function') d.animate([{ transform: 'translateY(45%)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 140, easing: 'cubic-bezier(0,0,.38,.9)' });
    }
  }

  function settle(rack) {
    clearTimeout(rack.stageTimer);
    rack.stageTimer = 0;
    if (!(rack.holdUntil > Date.now())) rack.rig?.setActive?.(false);
    activateRigs();
    if (!muted) announce(rack, finishSentence(rack));
  }

  const exitText = (step) => (step.code != null ? t('assistant.rack.say.exit', 'exit {code}', { code: step.code }) : '');

  function onFailure(step) {
    const rack = step.rack;
    if (muted) return;
    if (rack.staged && !rack.held) rack.rig?.react?.('wince');
    if (!turnActive) return;
    const detail = step.detail || exitText(step);
    alertRack(rack, t('assistant.rack.sr.failed', '{what} failed{detail}', { what: stepSentence(step, false), detail: detail ? `: ${detail}` : '' }));
  }

  // ── Ledger rows ──
  function stationLabel(st) {
    if (st.kind === 'mcp') return prettyServer(st.server);
    const [key, fallback] = KIND_SPECS[st.kind]?.label || KIND_SPECS.mcp.label;
    return t(key, fallback);
  }

  function renderStation(rack, st) {
    const label = stationLabel(st);
    if (st.label.textContent !== label) st.label.textContent = label;
    const agg = stationAggregate(st.kind, st.steps, { t, server: st.server });
    if (st.agg.textContent !== agg) st.agg.textContent = agg;
    const failed = st.steps.some(s => s.state === 'error');
    const awake = rack.live && rack.awakeKey === st.key;
    st.li.dataset.state = awake ? (rack.waiting ? 'waiting' : 'awake') : failed ? 'failed' : 'idle';
    const held = waitingStep(rack);
    const plan = st.kind === 'plan' ? planTicks(st) : null;
    const sig = plan ? `p${plan.map(s => s.status[0]).join('')}${awake ? 'a' : ''}` : st.steps.map(s => (s.stale ? 'x' : s === held ? 'w' : s.state[0])).join('');
    if (sig !== st.tickSig) paintTicks(rack, st, sig, plan);
    const time = stationTime(st, rack.live, rackNow(rack));
    if (st.time.textContent !== time) st.time.textContent = time;
    st.hdr.setAttribute('aria-label', time ? t('assistant.rack.aria.row', '{label}: {summary}, {time}', { label, summary: agg, time }) : t('assistant.rack.aria.rowUntimed', '{label}: {summary}', { label, summary: agg }));
    if (st.sub) paintSubstrip(rack, st);
    renderStationFace(rack, st);
  }

  /**
   * A row's glyph, built once the row is on screen (live ledger, or an opened
   * receipt): the kind's prop alone, so rows differ at a squint; the awake
   * row wears the eyes (a still face in its kind's pose).
   */
  function renderStationFace(rack, st) {
    if (!(rack.staged || rack.open || (rack.nested && rack.live))) return;
    const mode = rack.live && rack.awakeKey === st.key ? 'eyes' : 'prop';
    if (st.faceMode === mode) return;
    st.faceMode = mode;
    if (mode === 'eyes') mountStill(st.face, st.kind, KIND_SPECS[st.kind]?.glyph || '#', { staticGlyph: true });
    else mountProp(st.face, st.kind, KIND_SPECS[st.kind]?.glyph || '#');
  }

  /**
   * A still mini face: the mascot's SVG painted with the pose's still frame
   * (paintMascot + stillFrame), never a rig, so a long transcript registers
   * and observes nothing. Without poses: the plain mascot (receipt) or the
   * kind's glyph (rows). Returns the SVG to repaint, or null.
   */
  function mountStill(host, pose, glyph, { staticGlyph = false, width = 28, height = 14 } = {}) {
    host.textContent = '';
    if (typeof mascotLib.paintMascot === 'function' && typeof mascotLib.stillFrame === 'function') {
      try {
        host.innerHTML = mascotLib.mascotSvg({ width, height, className: 'synabun-mascot asst-still' });
        const svg = host.firstElementChild;
        mascotLib.paintMascot(svg, mascotLib.stillFrame(pose));
        return svg;
      } catch { host.textContent = ''; }
    }
    if (!staticGlyph && typeof mascotLib.mascotSvg === 'function') { host.innerHTML = mascotLib.mascotSvg({ width, height }); return null; }
    host.appendChild(el('span', 'asst-still-glyph', glyph));
    return null;
  }

  /** A kind's prop alone (synabun-mascot.js mascotPropSvg), else its letter glyph. */
  function mountProp(host, kind, glyph) {
    host.textContent = '';
    if (typeof mascotLib.mascotPropSvg === 'function') {
      try {
        const markup = mascotLib.mascotPropSvg(kind, { width: 24, height: 16, className: 'asst-prop-glyph' });
        if (markup) {
          host.innerHTML = markup;
          mascotLib.paintMascotProp(host.firstElementChild, kind);
          return host.firstElementChild;
        }
      } catch { host.textContent = ''; }
    }
    host.appendChild(el('span', 'asst-still-glyph', glyph));
    return null;
  }

  function repaintStill(svg, pose) {
    try { if (svg) mascotLib.paintMascot(svg, mascotLib.stillFrame(pose)); } catch { /* the SVG is gone */ }
  }

  const TICK_MARK = { error: '✕', neutral: '○' };
  function tickName(step, held = false) {
    const say = sayOf(step);
    const what = String(say.detail ?? say.text ?? '').replace(/^\$ /, '');
    const state = held ? t('assistant.rack.state.waiting', 'waiting for you') : stateWord(step);
    return t('assistant.rack.aria.tick', '{tool}: {what} — {state}', { tool: stepTitle(step), what: middleEllipsis(what, 60, 24), state });
  }

  function tickEl(step, cls = 'asst-tick', held = false) {
    const tick = el('span', cls);
    tick.dataset.state = held ? 'waiting' : step.stale ? 'running' : step.state;
    tick.setAttribute('role', 'img');
    const name = tickName(step, held);
    tick.setAttribute('aria-label', name);
    tick.title = name;
    const mark = TICK_MARK[step.state];
    if (mark && !held) tick.textContent = mark;
    return tick;
  }

  /** "+10": the calls the ticks leave out (the row's log still lists every one), named for screen readers. */
  function overflowTick(count, cls) {
    const more = el('span', `asst-tick-more ${cls}`, `+${count}`);
    more.setAttribute('role', 'img');
    const name = plural(t, 'assistant.rack.aria.earlier', count, 'and 1 earlier call', 'and {count} earlier calls');
    more.setAttribute('aria-label', name);
    more.title = name;
    return more;
  }

  /** A plan row ticks its steps, not its calls: the latest plan's items (done filled, the current one live). */
  function planTicks(st) {
    const last = [...st.steps].reverse().find(s => s.type === 'call' && Object.keys(s.input || {}).length && !/todoread/i.test(s.name));
    const items = last ? planState(last.input).items : [];
    return items.length ? items : null;
  }

  function paintTicks(rack, st, sig, plan = null) {
    const before = st.tickCount || 0;
    st.tickSig = sig;
    const frag = document.createDocumentFragment();
    let count;
    if (plan) {
      count = plan.length;
      const live = rack.live && rack.awakeKey === st.key;
      plan.slice(0, MAX_TICKS).forEach((item, i) => {
        const tick = el('span', 'asst-tick is-step');
        tick.dataset.state = item.status === 'completed' ? 'ok' : item.status === 'in_progress' && live ? 'running' : 'pending';
        tick.setAttribute('role', 'img');
        const state = item.status === 'completed' ? t('assistant.rack.state.done', 'done') : item.status === 'in_progress' ? t('assistant.rack.state.inProgress', 'in progress') : t('assistant.rack.state.pending', 'pending');
        const name = t('assistant.rack.aria.planStep', 'Step {n}: {step} — {state}', { n: i + 1, step: middleEllipsis(item.text, 60, 24), state });
        tick.setAttribute('aria-label', name);
        tick.title = name;
        frag.appendChild(tick);
      });
    } else {
      const list = st.steps;
      count = list.length;
      const held = waitingStep(rack);
      const shown = list.slice(-MAX_TICKS);
      if (list.length > MAX_TICKS) frag.appendChild(overflowTick(list.length - MAX_TICKS, 'is-wide'));
      if (list.length > NARROW_TICKS) frag.appendChild(overflowTick(list.length - NARROW_TICKS, 'is-narrow'));
      shown.forEach((step, i) => {
        const tick = tickEl(step, 'asst-tick', step === held);
        if (shown.length - i > NARROW_TICKS) tick.classList.add('is-old');
        frag.appendChild(tick);
      });
    }
    st.tickCount = count;
    st.ticks.textContent = '';
    st.ticks.appendChild(frag);
    if (!plan && !calm() && rack.live && count > before) {
      const fresh = [...st.ticks.querySelectorAll('.asst-tick')].slice(-(count - before));
      for (const tick of fresh) tick.animate?.([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'cubic-bezier(0,0,.38,.9)' });
    }
  }

  /** Subagents: each agent's own calls as a compact tick strip inside the row. */
  function paintSubstrip(rack, st) {
    const agents = st.steps.filter(s => s.children?.length);
    const sig = agents.map(a => `${a.id}:${a.children.map(c => c.state[0]).join('')}`).join('|');
    if (sig === st.subSig) return;
    st.subSig = sig;
    st.sub.textContent = '';
    for (const agent of agents) {
      const row = el('div', 'asst-sub');
      row.dataset.toolId = agent.id;
      row.appendChild(el('span', 'asst-sub-label', sayOf(agent).text));
      const ticks = el('span', 'asst-sub-ticks');
      const calls = agent.children.filter(c => c.type === 'call');
      if (calls.length > MAX_TICKS) ticks.appendChild(overflowTick(calls.length - MAX_TICKS, 'is-wide'));
      for (const child of calls.slice(-MAX_TICKS)) ticks.appendChild(tickEl(child));
      row.appendChild(ticks);
      st.sub.appendChild(row);
    }
  }

  /** Union of the calls' run time (overlapping calls count once); `now` stops at a card's wait. */
  function spanMs(steps, live, now = Date.now()) {
    const spans = [];
    for (const s of steps) {
      if (!s.timed || !s.startedAt) return null;
      const end = s.endedAt || (live && s.state === 'running' && !s.stale ? now : 0);
      if (!end) continue;
      spans.push([s.startedAt, Math.max(s.startedAt, end)]);
    }
    if (!spans.length) return null;
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [from, to] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      if (a > to) { total += to - from; from = a; to = b; } else to = Math.max(to, b);
    }
    return total + (to - from);
  }

  function stationTime(st, live, now = Date.now()) {
    const ms = spanMs(st.steps, live, now);
    return ms == null || (ms < 1000 && st.steps.some(s => s.state === 'running' && !s.stale)) ? '' : fmtDuration(ms, t);
  }

  /** The burst's wall time, first call to last result; unknown when a replayed entry had no timestamp. */
  function rackMs(rack) {
    const steps = rack.steps;
    if (!steps.length || steps.some(s => !s.timed)) return null;
    const start = Math.min(...steps.map(s => s.startedAt));
    const running = steps.some(s => s.state === 'running' && !s.stale);
    if (running && !rack.live) return null;
    const end = running ? Date.now() : Math.max(...steps.map(s => s.endedAt || s.startedAt));
    return Math.max(0, end - start);
  }

  function groupsOf(rack) {
    return [...rack.stations.values()].map(st => ({ kind: st.kind, calls: st.steps, server: st.server }));
  }

  function stepTitle(step) {
    if (step.type === 'think') return t('assistant.rack.kind.think', 'Thinking');
    if (step.kind === 'computer') { const base = computerToolName(step.name) || 'computer'; return t(`assistant.computer.tool.${base}`, COMPUTER_TOOL_TITLES[base] || 'Computer'); }
    if (step.kind === 'mcp' || synabunToolName(step.name) != null) return toolWords(step.name);
    return step.name || 'tool';
  }

  function stateWord(step) {
    if (step.state === 'running' && !step.stale) return t('assistant.rack.state.running', 'running');
    if (step.state === 'running') return t('assistant.rack.state.noResult', 'no result');
    if (step.state === 'error') return t('assistant.rack.state.failed', 'failed');
    if (step.state === 'neutral') return t('assistant.rack.state.noMatches', 'no matches');
    return t('assistant.rack.state.done', 'done');
  }

  /** "Running npm test" / "Ran npm test". */
  function stepSentence(step, running) {
    const say = sayOf(step);
    return `${verbText(say.verb, running, t)} ${String(say.text || '').replace(/^\$ /, '')}`.trim();
  }

  /** The receipt: one call says what it did; a burst says it in one sentence. */
  function renderReceipt(rack, sentence) {
    const r = rack.receipt;
    const single = rack.steps.length === 1 ? rack.steps[0] : null;
    const live = rack.live;
    let sig;
    if (single && single.type === 'think' && !(single.state === 'running' && !single.stale)) {
      sig = `t|${sentence}`;
      if (r._sig !== sig) r.text.textContent = sentence;
    } else if (single) {
      const say = sayOf(single);
      const running = single.state === 'running' && !single.stale;
      const verb = verbText(say.verb, running, t);
      sig = `s|${verb}|${say.text}|${say.mono}`;
      if (r._sig !== sig) {
        r.text.textContent = '';
        r.text.appendChild(el('span', 'asst-rack-receipt-verb', verb));
        if (say.text) {
          r.text.appendChild(document.createTextNode(' '));
          const subject = el('span', `asst-rack-receipt-subject${say.mono ? ' is-mono' : ''}`);
          writeSubject(subject, say.segments, say.text);
          if (say.full) subject.title = say.full;
          r.text.appendChild(subject);
        }
      }
    } else {
      sig = `m|${sentence}`;
      if (r._sig !== sig) r.text.textContent = sentence;
    }
    r._sig = sig;
    const failed = rack.steps.filter(s => s.state === 'error').length;
    r.failed.hidden = !failed;
    const failedText = failed ? t('assistant.rack.failed', '{count} failed', { count: failed }) : '';
    if (r.failed.textContent !== failedText) r.failed.textContent = failedText;
    const ms = live ? null : rackMs(rack);
    const clock = ms != null ? fmtDuration(ms, t) : '';
    if (r.clock.textContent !== clock) r.clock.textContent = clock;
    // The still mini mascot, once the receipt is what the rack shows; it winces when a call failed.
    const pose = failed ? 'error' : 'success';
    if (!r.faceBuilt && !rack.staged && !(rack.nested && live)) {
      r.faceBuilt = true;
      r.pose = pose;
      r.svg = mountStill(r.face, pose, '✓', { width: 32, height: 16 });
    } else if (r.faceBuilt && r.pose !== pose) {
      r.pose = pose;
      repaintStill(r.svg, pose);
    }
  }

  function renderRackLabel(rack, sentence) {
    const single = rack.steps.length === 1 ? rack.steps[0] : null;
    let summary = single && single.type === 'call' ? stepSentence(single, single.state === 'running' && !single.stale) : sentence;
    const failed = rack.steps.filter(s => s.state === 'error').length;
    if (failed) summary = `${summary}, ${t('assistant.rack.failed', '{count} failed', { count: failed })}`;
    const ms = rack.live ? null : rackMs(rack);
    const time = ms != null ? fmtDuration(ms, t) : '';
    if (time) summary = t('assistant.rack.aria.timed', '{summary}, in {time}', { summary, time });
    const label = rack.waiting ? t('assistant.rack.aria.waiting', 'Waiting for you: {summary}', { summary })
      : rack.live ? t('assistant.rack.aria.live', 'Working: {summary}', { summary }) : summary;
    if (rack.row.getAttribute('aria-label') !== label) rack.row.setAttribute('aria-label', label);
  }

  function finishSentence(rack) {
    const calls = rack.steps.filter(s => s.type === 'call').length;
    const what = plural(t, 'assistant.rack.sr.calls', calls, '1 tool call', '{count} tool calls');
    const ms = rackMs(rack);
    const time = ms != null ? fmtDuration(ms, t) : '';
    return time ? t('assistant.rack.sr.done', 'Done: {calls} in {time}', { calls: what, time }) : t('assistant.rack.sr.doneUntimed', 'Done: {calls}', { calls: what });
  }

  /** One polite announcement per rack at most every 1.5 s; the latest text wins. */
  function announce(rack, text) {
    if (muted || !text) return;
    const sr = rack.sr;
    sr.pending = text;
    if (sr.timer) return;
    sr.timer = setTimeout(() => {
      sr.timer = 0;
      sr.last = Date.now();
      if (rack.statusEl.isConnected) rack.statusEl.textContent = sr.pending;
    }, Math.max(0, sr.last + STATUS_GAP_MS - Date.now()));
  }

  function alertRack(rack, text) {
    if (muted || !text || !rack.alertEl.isConnected) return;
    rack.alertEl.textContent = text;
  }

  // ── Timeline ──
  function renderTimeline(rack) {
    let ol = rack.timelineEl;
    if (!ol) { ol = el('ol', 'asst-rack-timeline'); rack.row.insertBefore(ol, rack.statusEl); rack.timelineEl = ol; }
    const sig = rack.timeline.map(e => `${e.seq}${e.state || ''}`).join(',');
    if (sig === rack.timelineSig) return;
    rack.timelineSig = sig;
    // One grid: the verb (right-aligned) · what it acted on (and a state that is not "done") · how long it took.
    // No offset column: a time on the right is always a duration.
    ol.textContent = '';
    for (const entry of rack.timeline) {
      const li = el('li', 'asst-tl');
      li.dataset.type = entry.type;
      if (entry.type === 'said') {
        li.appendChild(el('span', 'asst-tl-said', entry.text));
      } else {
        const say = sayOf(entry);
        const running = entry.state === 'running' && !entry.stale;
        li.dataset.state = entry.state;
        li.appendChild(el('span', 'asst-tl-verb', verbText(say.verb, running, t)));
        const what = el('span', 'asst-tl-what');
        const subject = el('span', `asst-tl-subject${say.mono ? ' is-mono' : ''}`, say.text);
        if (say.full || say.text) subject.title = say.full || say.text;
        what.appendChild(subject);
        if (entry.state !== 'ok') what.appendChild(el('span', 'asst-tl-state', stateWord(entry)));
        li.appendChild(what);
        const dur = entry.endedAt && entry.timed ? fmtDuration(entry.endedAt - entry.startedAt, t) : '';
        li.appendChild(el('span', 'asst-tl-dur', dur));
      }
      ol.appendChild(li);
    }
  }

  // ── Calls inside a row ──
  function buildCallNode(step) {
    const li = el('li', 'asst-tool');
    li.dataset.kind = step.kind;
    li.dataset.state = step.state;
    if (step.type === 'think') { li.classList.add('asst-think'); li.dataset.stepId = step.id; return li; }
    li.dataset.toolId = step.id;
    if (step.kind === 'computer') {
      li.dataset.computer = computerToolName(step.name) || 'computer';
      li._computer = { input: step.input || {}, tool: li.dataset.computer, description: describeComputerAction(step.input || {}, step.name) };
    }
    li.innerHTML = '<div class="asst-tool-hdr"><span class="asst-tool-mark" aria-hidden="true"></span><span class="asst-tool-name"></span><span class="asst-tool-detail"></span><span class="asst-tool-meta"></span><span class="asst-tool-state"></span><span class="asst-tool-time"></span></div>';
    if (step.kind === 'subagent') li.appendChild(el('div', 'asst-agent-feed'));
    step.card = li;
    refreshStep(step);
    return li;
  }

  /** A call row's header (and the rack's clocks) after its input, state or result changed. */
  function refreshStep(step) {
    const li = step.card;
    if (!li) return;
    li.dataset.state = step.state;
    if (step.type === 'think') { if (step.bodyBuilt) fillCallBody(step); return; }
    const say = sayOf(step);
    const q = (sel) => li.querySelector(`:scope > .asst-tool-hdr > ${sel}`);
    q('.asst-tool-name').textContent = stepTitle(step);
    const detail = q('.asst-tool-detail');
    detail.className = `asst-tool-detail${say.mono ? ' is-mono' : ''}`;
    const detailText = say.detail ?? say.text;
    writeSubject(detail, say.detail != null ? null : say.segments, detailText);
    detail.title = say.detail == null && say.full ? say.full : detailText; // a command's title is the line as written
    q('.asst-tool-meta').textContent = step.kind === 'computer' ? '' : say.meta.join(', ');
    let state = '';
    if (step.kind === 'computer' && step.computerState) state = step.computerState;
    else if (step.state === 'running' && !step.stale) state = step.progress >= 1 ? `${step.progress}s` : '';
    else if (step.state === 'error') state = t('assistant.tool.error', 'error');
    else if (step.state === 'neutral') state = t('assistant.rack.state.noMatches', 'no matches');
    else if (step.state === 'ok') state = t('assistant.tool.done', 'done');
    q('.asst-tool-state').textContent = state;
    q('.asst-tool-time').textContent = step.endedAt && step.timed ? fmtDuration(step.endedAt - step.startedAt, t) : '';
  }

  /** Bodies are built on first expand: a replayed history costs a header per call. */
  function buildCallBody(step) {
    if (step.bodyBuilt || !step.card) return;
    step.bodyBuilt = true;
    fillCallBody(step);
  }

  function fillCallBody(step) {
    const li = step.card;
    if (step.type === 'think') {
      li.textContent = '';
      const details = thinkingBlock('');
      details.open = true;
      const content = details.querySelector('.asst-thinking-content');
      previewInto(content, step.redacted && !step.text ? '…' : step.text, THINK_PREVIEW_LINES, details);
      li.appendChild(details);
      return;
    }
    let body = li.querySelector(':scope > .asst-tool-body');
    if (!body) {
      body = el('div', 'asst-tool-body');
      const anchor = li.querySelector(':scope > .asst-computer-frame') || li.querySelector(':scope > .asst-tool-hdr');
      anchor.after(body);
    }
    // Keep a Show toggle's keyboard focus across the rebuild below.
    const refocus = body.contains(document.activeElement) && document.activeElement.classList.contains('asst-reveal');
    body.textContent = '';
    const input = step.input || {};
    const say = sayOf(step);
    // What the call typed and any credential stay masked until this call's Show (never remembered across a replay).
    const red = redactInput(step.name, input, t);
    const hidden = red.hidden.length && !step.revealed ? red.hidden : null;
    switch (step.kind) {
      case 'shell': {
        const cmd = commandOf(input);
        if (cmd) section(body, t('assistant.rack.body.command', 'Command'), cmd, { copy: true });
        break;
      }
      case 'read': {
        const path = input.file_path || input.filePath || input.path || input.notebook_path || '';
        const range = /:\d+(?:-\d+)?$/.exec(say.text)?.[0] || '';
        if (path) section(body, t('assistant.rack.body.file', 'File'), `${path}${range}`, { copy: true, copyText: path });
        break;
      }
      case 'edit': {
        const paths = editPaths(input);
        if (paths.length) section(body, paths.length > 1 ? t('assistant.rack.body.files', 'Files') : t('assistant.rack.body.file', 'File'), paths.join('\n'), { copy: true });
        const diff = editDiff(step.name, input);
        if (diff.length) diffSection(body, diff);
        break;
      }
      case 'plan': {
        const plan = planState(input);
        if (plan.items.length) {
          const list = el('ul', 'asst-plan-list');
          for (const item of plan.items) {
            const row = el('li', 'asst-plan-item', item.status === 'in_progress' && item.active ? item.active : item.text);
            row.dataset.status = item.status;
            list.appendChild(row);
          }
          body.appendChild(list);
        }
        break;
      }
      case 'memory': {
        if (step.memories?.length) { body.appendChild(memoryChips(step.memories)); break; }
        inputSection(body, step, red);
        break;
      }
      default:
        inputSection(body, step, red);
    }
    if (step.result && step.kind !== 'plan') {
      const output = hidden ? maskEcho(step.result, hidden, t) : step.result;
      section(body, t('assistant.rack.body.output', 'Output'), output, { copy: true });
    }
    if (!body.children.length) { body.remove(); return; }
    if (refocus) body.querySelector('.asst-reveal')?.focus({ preventScroll: true });
  }

  const json = (value) => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } };

  /** The call's input as JSON; typed values and credentials masked, with this call's Show / Hide. */
  function inputSection(body, step, red) {
    const input = step.input || {};
    if (!Object.keys(input).length) return;
    const masked = red.hidden.length > 0;
    const sec = section(body, t('assistant.rack.body.input', 'Input'), masked && !step.revealed ? json(red.input) : json(input));
    if (masked) sec.querySelector('.asst-tool-sec-head').appendChild(revealButton(step));
  }

  /** Show / Hide for one call's masked values (its input and the output's echo of them). */
  function revealButton(step) {
    const btn = el('button', 'asst-reveal', step.revealed ? t('assistant.rack.hide', 'Hide') : t('assistant.rack.show', 'Show'));
    btn.type = 'button';
    btn.setAttribute('aria-pressed', step.revealed ? 'true' : 'false');
    btn.setAttribute('aria-label', step.revealed ? t('assistant.rack.hideValues', 'Hide typed values') : t('assistant.rack.showValues', 'Show typed values'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      step.revealed = !step.revealed;
      fillCallBody(step);
    });
    return btn;
  }

  /** A labelled block: the first 5 lines, "+N lines" for the rest, Copy for commands, paths and output. */
  function section(body, label, text, { copy = false, copyText: copyValue = null } = {}) {
    const sec = el('div', 'asst-tool-sec');
    const head = el('div', 'asst-tool-sec-head');
    head.appendChild(el('span', 'asst-tool-label', label));
    if (copy) head.appendChild(copyButton(() => copyValue ?? text));
    sec.appendChild(head);
    const pre = el('pre', 'asst-tool-section');
    sec.appendChild(pre);
    previewInto(pre, text, PREVIEW_LINES, sec);
    body.appendChild(sec);
    return sec;
  }

  function previewInto(node, text, lines, host) {
    const capped = String(text ?? '').length > RESULT_LIMIT ? `${String(text).slice(0, RESULT_LIMIT)}\n…` : String(text ?? '');
    const all = capped.split('\n');
    if (all.length <= lines) { node.textContent = capped; return; }
    node.textContent = all.slice(0, lines).join('\n');
    const more = el('button', 'asst-tool-more', plural(t, 'assistant.rack.moreLines', all.length - lines, '+1 line', '+{count} lines'));
    more.type = 'button';
    more.addEventListener('click', (e) => { e.stopPropagation(); node.textContent = capped; more.remove(); });
    host.appendChild(more);
  }

  function diffSection(body, diff) {
    const sec = el('div', 'asst-tool-sec');
    const head = el('div', 'asst-tool-sec-head');
    head.appendChild(el('span', 'asst-tool-label', t('assistant.rack.body.changes', 'Changes')));
    sec.appendChild(head);
    const pre = el('pre', 'asst-tool-section asst-diff');
    const draw = (lines) => {
      pre.textContent = '';
      for (const line of lines) {
        const row = el('span', 'asst-diff-line');
        row.dataset.sign = line.sign;
        row.appendChild(el('span', 'asst-diff-sign', line.sign === '@' ? '⋯' : line.sign.trim()));
        row.appendChild(el('span', 'asst-diff-text', line.text));
        pre.appendChild(row);
      }
    };
    const capped = diff.slice(0, MAX_DIFF_LINES);
    draw(capped.slice(0, PREVIEW_LINES));
    sec.appendChild(pre);
    if (capped.length > PREVIEW_LINES) {
      const more = el('button', 'asst-tool-more', plural(t, 'assistant.rack.moreLines', capped.length - PREVIEW_LINES, '+1 line', '+{count} lines'));
      more.type = 'button';
      more.addEventListener('click', (e) => { e.stopPropagation(); draw(capped); more.remove(); });
      sec.appendChild(more);
    }
    // Over the cap the rest is one click away: "Show full input" (drawn only then), and Copy takes all of it.
    if (diff.length > MAX_DIFF_LINES) {
      const whole = diff.every(line => line.sign === '+') ? diff.map(line => line.text).join('\n') : diff.map(line => `${line.sign === '@' ? '@@' : line.sign}${line.text}`).join('\n');
      head.appendChild(copyButton(() => whole));
      const full = el('button', 'asst-tool-more asst-tool-full', t('assistant.rack.showFull', 'Show full input'));
      full.type = 'button';
      full.addEventListener('click', (e) => {
        e.stopPropagation();
        draw(diff);
        sec.querySelectorAll('.asst-tool-more').forEach(b => b.remove());
      });
      sec.appendChild(full);
    }
    body.appendChild(sec);
  }

  function memoryChips(memories) {
    const row = el('div', 'asst-chips asst-memories');
    row.setAttribute('role', 'list');
    for (const m of memories) {
      const chip = el('button', 'asst-chip memory');
      chip.type = 'button';
      chip.setAttribute('role', 'listitem');
      chip.dataset.memoryId = m.id || '';
      chip.innerHTML = `<span class="asst-icon">${ICON_MEMORY}</span><span class="asst-chip-text">${esc(m.title || memoryTitle(m))}</span>${m.category ? `<span class="asst-chip-meta">${esc(m.category)}</span>` : ''}${Number.isFinite(Number(m.score)) ? `<span class="asst-chip-meta">${esc(Math.round(Number(m.score) * 100))}%</span>` : ''}`;
      chip.title = (m.text || '').slice(0, 400);
      chip.addEventListener('click', () => hooks.onMemoryClick?.(m.id, m));
      row.appendChild(chip);
    }
    return row;
  }

  // ── Runs (agent_* calls) ──
  /** agent_wait / agent_status / agent_read results carry run states: the stage reports them. */
  function noteAgentResult(text) {
    if (!text || text[0] !== '{') return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    const runs = [].concat(data?.run || [], data?.runs || [], data?.pending || [], data?.done || [], data?.runId ? [data] : []);
    for (const r of runs) {
      if (!r?.runId) continue;
      const next = { ...runInfo.get(r.runId) };
      for (const [k, v] of Object.entries({ state: r.state || r.status, title: r.title || r.task, provider: r.provider })) if (v) next[k] = v;
      runInfo.set(r.runId, next);
    }
  }

  function stepRunIds(step) {
    const i = step?.input || {};
    return [].concat(i.run_ids || [], i.run_id || []).filter(x => typeof x === 'string' && x);
  }

  function runLabel(step) {
    const ids = stepRunIds(step);
    if (ids.length > 1) return t('assistant.work.agents', '{count} agents', { count: ids.length });
    if (!ids.length) return '';
    const title = String(runInfo.get(ids[0])?.title || '').split('\n')[0].trim();
    return title ? (title.length > 44 ? `${title.slice(0, 43).trimEnd()}…` : title) : t('assistant.work.agentId', 'agent {id}', { id: ids[0].slice(0, 8) });
  }

  // ── Rack upkeep ──
  function needTicker() {
    if (unsubTick) return;
    try { unsubTick = subscribe(tickRacks, { fps: 1 }); } catch { unsubTick = null; }
  }

  function stopTicker() {
    if (!unsubTick) return;
    try { unsubTick(); } catch { /* already gone */ }
    unsubTick = null;
  }

  /** Once a second while a rack is live: its clocks (and any wake-up the timers have not caught). */
  function tickRacks() {
    let any = false;
    for (const rack of [...racks]) {
      if (!rack.row.isConnected) { dropRack(rack); continue; }
      if (!rack.live) continue;
      any = true;
      const now = Date.now();
      if (rack.staged && rack.bubble.step) paintBubble(rack, now, { swap: false }); // clocks, and the cut after a resize
      for (const st of rack.stations.values()) { const time = stationTime(st, true, rackNow(rack)); if (st.time.textContent !== time) st.time.textContent = time; }
      for (const step of rack.steps) if (step.state === 'running' && step.type === 'call' && step.progress >= 1) refreshStep(step);
    }
    if (!any) stopTicker();
  }

  function dropRack(rack) {
    clearTimeout(rack.stageTimer);
    clearTimeout(rack.clearTimer);
    clearTimeout(rack.sr.timer);
    clearTimeout(rack.holdTimer);
    rack.stageTimer = 0;
    rack.clearTimer = 0;
    rack.sr.timer = 0;
    rack.holdTimer = 0;
    const had = !!rack.rig;
    rack.rig?.destroy?.();
    rack.rig = null;
    rack.target = null;
    for (const step of rack.steps) if (stepsById.get(step.id) === step) stepsById.delete(step.id);
    racks.delete(rack);
    if (grace === rack) grace = null;
    if (had) mascotChanged();
  }

  /** Keep the stage up `ms` longer (the turn ended while it was on screen: its one-shot plays), then fold it. */
  function holdStage(rack, ms) {
    clearTimeout(rack.holdTimer);
    rack.holdUntil = Date.now() + ms;
    rack.holdTimer = setTimeout(() => {
      rack.holdTimer = 0;
      rack.holdUntil = 0;
      if (rack.row.isConnected) renderRack(rack);
    }, ms);
  }

  /** A stage kept for a verdict that never came (no finishTurn after the result) folds now. */
  function releaseGrace() {
    const rack = grace;
    grace = null;
    if (!rack || rack.holdTimer) return;
    rack.holdUntil = 0;
    if (rack.row.isConnected) renderRack(rack);
  }

  /** Re-evaluate the racks whose state can change: the live ones and each scope's tail. */
  function syncRacks() {
    for (const rack of [...racks]) {
      if (!rack.row.isConnected) { dropRack(rack); continue; }
      if (rack.live || liveTail(rack.scope) === rack) renderRack(rack);
    }
  }

  /** Memory chips (the prompt-time recall) attach to a recall step in the Memory row; they are not a row of their own. */
  function attachMemories(memories, scope = rootScope) {
    const list = Array.isArray(memories) ? memories.filter(m => m && (m.id || m.title)) : [];
    if (!list.length) return null;
    const rack = rackFor(scope, { noFold: true });
    const step = addCall(rack, { name: 'mcp__SynaBun__recall', input: {} }, { extra: { auto: true, memories: list, state: 'ok' } });
    renderRack(rack);
    return step.card;
  }

  // ── Public appenders ──
  /** A prompt written outside the panel ('whatsapp'): a small "via WhatsApp" line under it (with its picture count). */
  function originLabel(origin, imageCount = 0) {
    if (origin !== 'whatsapp') return '';
    const n = Number(imageCount) || 0;
    const via = t('assistant.origin.whatsapp', 'via WhatsApp');
    return n > 0 ? `${via} · ${t(n === 1 ? 'assistant.origin.image' : 'assistant.origin.images', n === 1 ? '1 image' : '{n} images', { n })}` : via;
  }

  function appendUser(text, { images = [], files = [], memories = [], origin = null, imageCount = 0 } = {}) {
    turnFrames = [];
    rootScope.kept = null;
    lastErrorText = '';
    const row = el('div', 'asst-msg msg-user');
    const content = el('div', 'asst-msg-content');
    const chips = [];
    for (const img of images) chips.push(`<span class="asst-chip static"><img src="data:${esc(img.mediaType || 'image/png')};base64,${esc(img.base64)}" alt=""><span class="asst-chip-text">${esc(img.name || 'image')}</span></span>`);
    for (const f of files) chips.push(`<span class="asst-chip static"><span class="asst-chip-text">${esc(f.name || 'file')}</span></span>`);
    for (const m of memories) chips.push(`<span class="asst-chip memory static"><span class="asst-icon">${ICON_MEMORY}</span><span class="asst-chip-text">${esc(memoryTitle(m))}</span></span>`);
    if (chips.length) {
      const att = el('div', 'asst-msg-attachments');
      att.innerHTML = chips.join('');
      content.appendChild(att);
    }
    if (text) content.appendChild(el('div', 'asst-msg-text', text));
    row.appendChild(content);
    const via = originLabel(origin, imageCount);
    if (via) { row.dataset.origin = origin; row.appendChild(el('div', 'asst-msg-origin', via)); }
    append(row, rootScope, { park: !muted });
    scrollEnd(true);
    return row;
  }

  function appendAssistantMarkdown(text) {
    const { wrap } = assistantRow(rootScope);
    const body = el('div', 'asst-md');
    renderMarkdownInto(body, text);
    wrap.appendChild(body);
    return wrap;
  }

  function appendStatus(text, tone = '') {
    if (!text) return null;
    return append(el('div', `asst-status${tone ? ` ${tone}` : ''}`, text));
  }

  function appendError(text) {
    return appendStatus(text || t('assistant.errorGeneric', 'Something went wrong'), 'error');
  }

  function appendDivider(label) {
    return append(el('div', 'asst-divider', label || ''));
  }

  /** Place an arbitrary node (control / route card) as a transcript row. */
  function appendNode(node) {
    if (!node) return null;
    return append(node);
  }

  function showWorking(label) {
    if (!working) {
      working = el('div', 'asst-working');
      working.setAttribute('role', 'status');
      working.setAttribute('aria-live', 'polite');
      working.innerHTML = `<span class="asst-working-face" aria-hidden="true"></span><span class="asst-working-label"></span>`;
    }
    working.querySelector('.asst-working-label').textContent = label || t('assistant.rack.verb.think.now', 'Thinking');
    hideEmpty({ park: true });
    $msgs.appendChild(working);
    if (!turnActive) turn = { calls: 0, last: null, errored: false, answerRow: null };
    turnActive = true;
    if (racks.size) syncRacks();
    syncWorkingFace();
    scrollEnd();
  }

  function hideWorking() {
    if (working) working.remove();
    syncWorkingFace();
  }

  // ── The "Thinking" row's character ──
  // The row wears the mascot, thinking, only when no other character is on
  // screen: no hero, no stage (a live rack right above it hides the row
  // altogether). A rig, so the director can dress it; a painted still when
  // calm. A send hands the hero over to it (settleHero).
  function workingCovered() {
    let prev = working?.previousElementSibling || null;
    while (prev && prev.classList.contains('asst-folding')) prev = prev.previousElementSibling;
    return !!prev?._rack?.live;
  }

  /** The row is up and neither a stage nor a live rack stands in for it. */
  function workingFree() {
    return !!working?.isConnected && !newestStage() && !workingCovered();
  }

  function syncWorkingFace() {
    const host = working?.querySelector('.asst-working-face');
    const wanted = !!host && !hero && workingFree();
    if (!wanted) { dropWorkingFace(); return; }
    if (workingFace && workingFace.still === calm()) return;
    dropWorkingFace();
    if (calm()) {
      workingFace = { still: true, el: mountStill(host, 'think', '…', { width: 56, height: 28 }) };
      return;
    }
    try {
      const rig = mascotLib.createMascot(host, { width: 56, height: 28, active: rigsOn, pose: 'think' });
      const face = { still: false, rig, el: rig.el, held: false };
      face.target = { kind: 'working', rig, el: rig.el, hold(on) { face.held = !!on; }, restore() { if (workingFace === face) rig.setPose('think'); } };
      workingFace = face;
    } catch { workingFace = null; }
    mascotChanged();
  }

  function dropWorkingFace() {
    const face = workingFace;
    if (!face) return;
    workingFace = null;
    try { face.rig?.destroy(); } catch { /* gone */ }
    working?.classList.remove('is-flip');
    working?.querySelector('.asst-working-face')?.replaceChildren();
    if (face.rig) mascotChanged();
  }

  function appendMemoryChips(memories) {
    return attachMemories(memories);
  }

  function appendMemorySaved(info) {
    const row = el('div', 'asst-chips');
    const chip = el('button', 'asst-chip saved memory');
    chip.type = 'button';
    chip.dataset.memoryId = info?.id || '';
    chip.innerHTML = `<span class="asst-icon">${ICON_MEMORY}</span><span class="asst-chip-text">${esc(t('assistant.memories.saved', 'Memory saved'))}${info?.title ? ` · ${esc(info.title)}` : ''}</span>`;
    chip.addEventListener('click', () => hooks.onMemoryClick?.(info?.id, info));
    row.appendChild(chip);
    return append(row);
  }

  function runCardOpts(result = null) {
    return {
      t: hooks.t,
      providerIcon: hooks.providerIcon,
      providerColor: hooks.providerColor,
      onFocus: hooks.onFocusRun,
      onStop: hooks.onStopRun,
      onRead: hooks.onReadRun,
      onEscalate: hooks.onEscalateRun,
      result,
      keepSummary: true,
    };
  }

  function upsertRunCard(run, { result = null } = {}) {
    if (!run?.runId) return null;
    runInfo.set(run.runId, { ...runInfo.get(run.runId), title: run.title || run.task || runInfo.get(run.runId)?.title, state: run.status || runInfo.get(run.runId)?.state, provider: run.provider });
    const cardOpts = runCardOpts(result);
    let card = runCards.get(run.runId);
    if (card && card.isConnected) {
      updateRunCard(card, run, cardOpts);
      for (const rack of racks) if (rack.live) renderRack(rack); // "Waiting on <title>" learns the title
      return card;
    }
    card = buildRunCard(run, cardOpts);
    runCards.set(run.runId, card);
    const { wrap } = assistantRow(rootScope);
    wrap.appendChild(card);
    return card;
  }

  function patchRunUsage(runId, tokens, fidelity) {
    const card = runCards.get(runId);
    if (!card?.isConnected || !card._usageRun) return;
    updateRunCard(card, { ...card._usageRun, usageTokens: tokens, usageFidelity: fidelity, usageObserved: true }, card._runOpts || runCardOpts());
  }

  /** One line for a settled clarification (agent_clarify): what the user answered, or that they skipped. */
  function clarifyLine(ev) {
    const phase = ev?.phase || '';
    const round = ev?.brief?.round || {};
    const answers = (Array.isArray(round.answers) ? round.answers : [])
      .filter((a) => Array.isArray(a?.answers) && a.answers.length)
      .map((a) => (a.header ? `${a.header}: ${a.answers.join(', ')}` : a.answers.join(', ')));
    if (phase === 'answered') return `${t('assistant.clarify.answered', 'Clarified')}${answers.length ? ` · ${answers.join(' · ')}` : ''}`;
    if (phase === 'chat') return t('assistant.clarify.chat', 'Clarified in chat');
    if (phase === 'declined') return t('assistant.clarify.skipped', 'Questions skipped: the assistant goes with its assumptions');
    return t('assistant.clarify.cancelled', 'Questions cancelled');
  }

  function appendMailbox(events) {
    const summary = summarizeMailbox(events);
    if (!summary.length) return null;
    const row = el('div', 'asst-chips asst-mailbox');
    row.setAttribute('role', 'list');
    row.innerHTML = `<span class="asst-chips-label">${esc(t('assistant.mailbox.label', 'Mailbox'))}</span>`;
    for (const entry of summary) {
      const chip = el('button', `asst-chip mailbox${/permission|needs_input|failed|stalled|interrupted|budget/.test(entry.kind) ? ' attention' : ''}`);
      chip.type = 'button';
      chip.setAttribute('role', 'listitem');
      chip.innerHTML = `<span class="asst-chip-text">${esc(t(`assistant.mailbox.${entry.kind}`, entry.kind.replace(/_/g, ' ')))}</span>${entry.count > 1 ? `<span class="asst-chip-meta">×${entry.count}</span>` : ''}`;
      if (entry.runIds.length) chip.addEventListener('click', () => hooks.onFocusRun?.(entry.runIds[0]));
      row.appendChild(chip);
    }
    return append(row);
  }

  // ── Route lines ──
  function routeLineOpts(phase) {
    return { phase, t: hooks.t, providerIcon: hooks.providerIcon, brainLabel: hooks.brainLabel, onChangeRoutes: hooks.onChangeRoutes };
  }

  /** Create or update the line for `route.routeId` in place. */
  function upsertRouteLine(route, phase = 'decided') {
    const routeId = route?.routeId;
    if (!routeId) return null;
    const existing = routeLines.get(routeId);
    if (existing && existing.el.isConnected) { existing.update(route, phase); return existing; }
    const line = createRouteLine(route, routeLineOpts(phase));
    routeLines.set(routeId, line);
    append(line.el);
    return line;
  }

  /** Adopt a line created by a collapsing route card so later events update it. */
  function registerRouteLine(routeId, line) {
    if (routeId && line) routeLines.set(routeId, line);
  }

  function removeRouteLine(routeId) {
    const line = routeLines.get(routeId);
    if (line) { line.el.remove(); routeLines.delete(routeId); }
  }

  // ── Empty state ──
  function showEmpty() {
    if (emptyEl || $msgs.querySelector(':scope > :not(.asst-working)')) return;
    emptyEl = el('div', 'asst-empty');
    emptyEl.innerHTML = `
      <div class="asst-empty-mascot" aria-hidden="true"></div>
      <div class="asst-empty-title" role="heading" aria-level="2">${esc(t('assistant.empty.heading', 'What should we do?'))}</div>
      <div class="asst-empty-body">${esc(t('assistant.empty.lead', 'I can use your Mac, look things up on the web, edit files and run commands, and remember or schedule things.'))}</div>
      <div class="asst-suggestions" role="list"></div>`;
    const box = emptyEl.querySelector('.asst-empty-mascot');
    try {
      const rig = mascotLib.createMascot(box, { width: 120, height: 60, active: rigsOn });
      hero = { rig, el: rig.el, box, parked: false, leaving: false, held: false, dock: null, egg: false, leaveTimer: 0 };
      hero.target = heroTarget(hero);
      wireEgg(hero);
    } catch { hero = null; }
    renderSuggestions();
    $msgs.appendChild(emptyEl);
    // The host's "Starting…" character flies into place (not on replay or reduced motion).
    let from = null;
    try { from = hooks.heroOrigin?.() || null; } catch { from = null; }
    if (from && hero) flipFrom(hero.el, from); // the SVG: the box is as wide as the empty state
    mascotChanged();
  }

  function renderSuggestions() {
    if (!emptyEl) return;
    const host = emptyEl.querySelector('.asst-suggestions');
    host.innerHTML = '';
    let list = [];
    try { list = typeof hooks.emptySuggestions === 'function' ? (hooks.emptySuggestions() || []) : []; } catch { list = []; }
    for (const s of list) {
      // glyph | seam | label: the kind's prop, and the character acts it out while the suggestion is hovered or focused.
      const chip = el('button', 'asst-chip asst-suggestion');
      chip.type = 'button';
      chip.setAttribute('role', 'listitem');
      chip.dataset.suggestion = s.id || '';
      const kind = s.kind || SUGGESTION_KINDS[s.id] || null;
      if (kind) {
        chip.dataset.kind = kind;
        const icon = el('span', 'asst-icon');
        icon.setAttribute('aria-hidden', 'true');
        mountProp(icon, kind, '');
        chip.appendChild(icon);
        chip.addEventListener('pointerenter', () => previewHero(kind));
        chip.addEventListener('pointerleave', () => previewHero(null));
        chip.addEventListener('focus', () => previewHero(kind));
        chip.addEventListener('blur', () => previewHero(null));
      }
      chip.appendChild(el('span', 'asst-chip-text', s.label));
      chip.addEventListener('click', () => hooks.onSuggestion?.(s.template, s));
      host.appendChild(chip);
    }
    host.hidden = !list.length;
  }

  /** The empty state's character tries a suggestion on (null: back to idle); never over a pose the director holds. */
  function previewHero(kind) {
    const h = hero;
    if (!h?.rig || h.parked || h.held) return;
    h.rig.setPose?.(kind || 'idle');
  }

  /** `system` messages: the SDK's, plus the bridge's runtime_notice / retry / compact_started / session_reset / plan_file_written. */
  function handleSystem(ev, silent) {
    const sub = ev.subtype;
    const msg = String(ev.message || ev.text || ev.content || '');
    const k = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
    switch (sub) {
      case 'init': hooks.onInit?.(ev); return true;
      case 'compact_boundary': case 'compacted': {
        const m = ev.compact_metadata || {};
        const pre = Number(m.pre_tokens) || 0;
        const post = Number(m.post_tokens) || 0;
        appendDivider(`${t('assistant.compacted', 'context compacted')}${pre ? ` · ${k(pre)}${post ? ` → ${k(post)}` : ''}` : ''}`);
        return true;
      }
      case 'status':
        // Live only: a replayed status carries the mode of its time, not the session's.
        if (ev.permissionMode && !silent) hooks.onModeChanged?.(ev.permissionMode);
        if (ev.compact_result === 'failed') appendError(`${t('assistant.status.compactFailed', 'Compaction failed')}${ev.compact_error ? `: ${ev.compact_error}` : ''}`);
        if (!silent && 'status' in ev) hooks.onStatus?.(ev.status || null);
        if (ev.text) appendStatus(ev.text);
        return true;
      case 'api_retry':
        if (!silent) appendStatus(t('assistant.status.apiRetry', 'API error{code}, retrying in {seconds}s (attempt {attempt} of {max})', { code: ev.error_status ? ` ${ev.error_status}` : '', seconds: Math.max(1, Math.round(Number(ev.retry_delay_ms) / 1000) || 1), attempt: ev.attempt ?? '?', max: ev.max_retries ?? '?' }), 'warn');
        return true;
      case 'retry': case 'runtime_notice': case 'compact_started': case 'notification':
        if (!silent && msg) appendStatus(msg, sub === 'compact_started' ? '' : (sub === 'notification' || ev.level === 'info' ? 'info' : 'warn'));
        return true;
      case 'session_reset': case 'informational': // informational 'info' is transcript-mode only
        if (msg && ev.level !== 'info') appendStatus(msg, ev.level === 'warning' ? 'warn' : 'info');
        return true;
      case 'local_command_output':
        if (msg) appendAssistantMarkdown(msg).classList.add('asst-local-output');
        return true;
      case 'permission_denied':
        appendStatus(t('assistant.status.permissionDenied', '{tool} was denied{reason}', { tool: ev.tool_name || 'tool', reason: ev.decision_reason ? ` — ${ev.decision_reason}` : '' }), 'warn');
        return true;
      case 'model_refusal_fallback':
        appendStatus(t('assistant.status.refusalFallback', 'Switched from {from} to {to} after a refusal', { from: modelShortName(ev.original_model) || ev.original_model, to: modelShortName(ev.fallback_model) || ev.fallback_model }), 'warn');
        return true;
      case 'model_refusal_no_fallback':
        appendError(msg || t('assistant.status.refused', 'The model declined this request.'));
        return true;
      case 'task_notification':
        if (!ev.skip_transcript && ev.summary) appendStatus(`${ev.status === 'completed' ? t('assistant.status.taskDone', 'Background task finished') : t('assistant.status.taskEnded', 'Background task {status}', { status: ev.status || 'ended' })}: ${ev.summary}`, ev.status === 'completed' ? 'info' : 'warn');
        return true;
      case 'plan_file_written':
        appendStatus(t('assistant.status.planSaved', 'Plan saved: {name}', { name: ev.name || String(ev.path || '').split(/[/\\]/).pop() }), 'info');
        return true;
      case 'mcp_status': // live only: a replayed failure may long since have recovered
        if (silent) return true;
        for (const s of Array.isArray(ev.servers) ? ev.servers : []) {
          const name = s?.name || s?.server || s?.serverName;
          if (!name || mcpWarned.has(name) || !/fail|error/i.test(String(s?.status || s?.state || ''))) continue;
          mcpWarned.add(name);
          appendStatus(t('assistant.status.mcpFailed', 'MCP server {name} failed to connect', { name }), 'warn');
        }
        return true;
      default:
        return true; // commands_list, thread_title, task progress, hooks…: no transcript row
    }
  }

  function markSeen(key) {
    if (!key) return;
    seen.delete(key);
    seen.add(key);
    while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  }

  /** An event's identities: its SDK uuid; an assistant message's key, API message id and tool_use ids. */
  function idKeys(ev) {
    const keys = [];
    if (ev?.uuid) keys.push(`u:${ev.uuid}`);
    if (ev?.type === 'assistant' && ev.message?.id) {
      keys.push(`a:${assistantEventKey(ev)}`, `m:${ev.message.id}`);
      for (const b of Array.isArray(ev.message.content) ? ev.message.content : []) if (b?.type === 'tool_use' && b.id) keys.push(`t:${b.id}`);
    }
    return keys;
  }

  /** An event's exact copy (the journal stores the packets the sockets got): type, length and a djb2 hash. */
  function contentKey(ev) {
    let s = '';
    try { s = JSON.stringify(ev); } catch { return ''; }
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return `c:${ev?.type}:${s.length}:${h >>> 0}`;
  }

  const scopeKeyOf = (ev) => ev?.parent_tool_use_id || ev?.message?.parent_tool_use_id || '';
  const drawnKey = (keys) => keys.find(k => (k.startsWith('a:') || k.startsWith('u:')) && seen.has(k));

  /**
   * The live gate: false for an assistant event already drawn (a subagent's
   * may repeat, as before). What it lets through is registered.
   */
  function claimEvent(ev) {
    if (ev?.type === 'assistant' && ev.message?.id && !scopeKeyOf(ev) && seen.has(`a:${assistantEventKey(ev)}`)) return false;
    for (const k of idKeys(ev)) markSeen(k);
    return true;
  }

  /**
   * A reattach's buffered replay (the packets that went out while this panel
   * was away), minus what is on screen: events drawn by the journal snapshot
   * or live (their ids, or the snapshot's exact copies), stream packets that
   * a message later in the replay (or already drawn) carries in full, and
   * packets older than the snapshot's newest entry when they carry `at` or
   * `seq`. Returns the packets to process, in order; ends the snapshot.
   */
  function planReplay(packets) {
    const list = (Array.isArray(packets) ? packets : []).filter(p => p && typeof p === 'object');
    const snap = snapshot;
    snapshot = null;
    const lastMessage = new Map(); // scope → index of the last assistant event in the replay
    list.forEach((p, i) => { if (p.type === 'event' && p.event?.type === 'assistant') lastMessage.set(scopeKeyOf(p.event), i); });
    const drawnStream = new Map(); // scope → inside the stream of a message already drawn
    const out = [];
    list.forEach((p, i) => {
      if (snap) {
        const at = Date.parse(p.at ?? p.event?.at ?? '');
        if (Number.isFinite(at) && at < snap.at) return;
        const seq = Number(p.seq ?? p.event?.seq);
        if ((p.seq ?? p.event?.seq) != null && Number.isFinite(seq) && seq <= snap.seq) return;
      }
      const ev = p.type === 'event' ? p.event : null;
      if (!ev?.type) { out.push(p); return; }
      const scope = scopeKeyOf(ev);
      if (ev.type === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'message_start') drawnStream.set(scope, !!inner.message?.id && seen.has(`m:${inner.message.id}`));
        if (drawnStream.get(scope)) return; // its message is on screen already
        if ((lastMessage.get(scope) ?? -1) > i) return; // a message later in the replay carries it
        out.push(p);
        return;
      }
      if (drawnKey(idKeys(ev))) return;
      if (snap?.keys.has(contentKey(ev))) return;
      out.push(p);
    });
    return out;
  }

  /** A journal entry the snapshot drew: its identities, its exact copy, the newest `at` / `seq`. */
  function noteSnapshot(entry) {
    const packet = entry.packet && typeof entry.packet === 'object' ? entry.packet : entry;
    const ev = packet.type === 'event' ? packet.event : (packet.role === 'assistant' && packet.message ? { type: 'assistant', message: packet.message } : null);
    if (ev?.type) {
      for (const k of idKeys(ev)) markSeen(k);
      if (snapshot && ev.type !== 'assistant' && ev.type !== 'user' && ev.type !== 'stream_event') snapshot.keys.add(contentKey(ev));
    }
    if (!snapshot) return;
    const ms = Date.parse(entry.at ?? '');
    if (Number.isFinite(ms)) snapshot.at = Math.max(snapshot.at, ms);
    const seq = Number(entry.seq);
    if (entry.seq != null && Number.isFinite(seq)) snapshot.seq = Math.max(snapshot.seq, seq);
  }

  /**
   * Main entry for `event` packets. Returns true when handled.
   * opts.silent: a replayed event (no motion, no announcements, no stale notices);
   * opts.replay: a reattach's missed packet (silent, and drawn like the journal: prompts too);
   * opts.at: its journal timestamp, so replayed racks know how long things took.
   */
  function handleEvent(ev, { silent = false, at = null, replay = false } = {}) {
    if (!ev?.type) return false;
    const was = { muted, clockAt, replayDraw };
    muted = muted || !!silent || !!replay;
    replayDraw = replayDraw || !!replay;
    if (at != null) { const ms = Date.parse(at); clockAt = Number.isFinite(ms) ? ms : clockAt; }
    try { return dispatch(ev, muted); }
    finally { muted = was.muted; clockAt = was.clockAt; replayDraw = was.replayDraw; }
  }

  function dispatch(ev, silent) {
    if (ev.type !== 'stream_event') for (const k of idKeys(ev)) markSeen(k); // deltas are never replayed as themselves
    const parentId = ev.parent_tool_use_id || ev.message?.parent_tool_use_id || null;
    const scope = scopeFor(parentId);
    const handled = route(ev, scope, parentId, silent);
    scope.lastAt = nowMs();
    return handled;
  }

  function route(ev, scope, parentId, silent) {
    switch (ev.type) {
      case 'stream_event':
        if (ev.event) handleStreamEvent(ev.event, scope);
        return true;
      case 'assistant': {
        const row = ev.message ? renderAssistant(ev.message, scope, ev) : null;
        if (row && ev.error && row.classList.contains('asst-msg')) { // a synthetic API-error message
          row.classList.add('asst-msg-error');
          const content = Array.isArray(ev.message.content) ? ev.message.content : [];
          lastErrorText = typeof ev.message.content === 'string' ? ev.message.content.trim()
            : content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
        }
        return true;
      }
      case 'tool_result':
        updateToolResult(ev);
        return true;
      case 'user': {
        const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
        const results = content.filter(block => block?.type === 'tool_result');
        // Claude's structured result (stdout / stderr apart) belongs to the message's one tool_result.
        const detail = results.length === 1 ? resultDetail(ev.tool_use_result) : null;
        let handled = false;
        for (const block of results) { updateToolResult({ tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error, detail }); handled = true; }
        if (!handled && !silent && typeof ev.message?.content === 'string' && ev.replay) appendUser(ev.message.content);
        return true;
      }
      case 'result': {
        flushStream(scope);
        // Codex/OpenCode also send an `error` packet; the SDK reports only here.
        const errorText = !parentId && ev.brain !== 'codex' && ev.brain !== 'opencode' ? resultErrorText(ev, t) : '';
        if (errorText && !muted) turn.errored = true;
        // The stage on screen waits for the turn's verdict (onResult → finishTurn) before it folds.
        if (!parentId && !muted) grace = newestStage();
        if (grace) grace.holdUntil = Infinity;
        if (!parentId) endBursts(rootScope);
        hooks.onResult?.(ev);
        if (errorText && errorText !== lastErrorText) appendError(errorText);
        if (!parentId) { lastErrorText = ''; rootScope.kept = null; releaseGrace(); }
        return true;
      }
      case 'system':
        return handleSystem(ev, silent);
      case 'tool_progress': {
        const step = ev.tool_use_id ? stepsById.get(ev.tool_use_id) : null;
        if (step && step.type === 'call' && step.state === 'running' && Number(ev.elapsed_time_seconds) >= 1) {
          step.progress = Math.round(Number(ev.elapsed_time_seconds)) || 0;
          refreshStep(step);
        }
        return true;
      }
      case 'tool_use_summary':
        if (ev.summary) appendStatus(String(ev.summary));
        return true;
      case 'auth_status':
        if (ev.error) appendError(String(ev.error));
        else if (!silent && Array.isArray(ev.output) && ev.output.length) appendStatus(ev.output.join('\n'), 'info');
        return true;
      case 'rate_limit_event':
        // Never a transcript row: providers repeat it with every response. The panel keeps one
        // notice and replaces it in place (live only: a replayed report may long since be over).
        if (!silent) hooks.onLimit?.(ev.rate_limit_info || {});
        return true;
      case 'conversation_reset':
        appendDivider(t('assistant.conversationReset', 'conversation reset'));
        return true;
      case 'mode_changed':
        hooks.onModeChanged?.(ev.mode, ev.planMode);
        return true;
      case 'subagent':
        return true;
      case 'synabun.memories':
        attachMemories(ev.memories, scope);
        return true;
      case 'synabun.memory_saved':
        appendMemorySaved(ev);
        return true;
      case 'synabun.dispatch':
        if (ev.run) upsertRunCard(ev.run);
        return true;
      case 'synabun.dispatch_result':
        if (ev.run) upsertRunCard(ev.run, { result: ev.result ?? null });
        return true;
      case 'synabun.user_prompt':
        if ((!silent || replayDraw) && ev.text) appendUser(ev.text, { origin: ev.origin || null, imageCount: ev.images });
        return true;
      case 'synabun.error':
        appendError(ev.message);
        return true;
      case 'synabun.mailbox':
        appendMailbox(ev.items || ev.events || ev);
        return true;
      case 'synabun.route': {
        const phase = ev.phase || 'decided';
        if (hooks.onRouteEvent?.(ev)) return true; // an open card represents it
        if (phase === 'card' && silent) return true; // replayed card: the pending control re-sends it
        upsertRouteLine(ev.route || {}, phase);
        return true;
      }
      case 'synabun.clarify':
        // The card itself arrives as a control_request; its outcome is a line (the panel's card shows it live).
        if (ev.phase !== 'card') appendStatus(clarifyLine(ev), 'info');
        return true;
      default:
        return false;
    }
  }

  /** The turn result: bursts end here, what is still running never will, and the tail text is a message. */
  function endBursts(scope) {
    sealScope(scope);
    for (const rack of [...racks]) {
      if (rack.scope !== scope && !(scope === rootScope && rack.nested)) continue;
      let changed = false;
      for (const step of rack.steps) {
        if (step.state !== 'running' || step.stale) continue;
        if (step.type === 'think') { step.state = 'ok'; step.endedAt = nowMs(); } else step.stale = true;
        refreshStep(step);
        changed = true;
      }
      if (changed || rack.live) renderRack(rack);
    }
  }

  function closeStreamThinks() {
    for (const scope of [rootScope, ...scopes.values()]) {
      const think = scope.stream?.think;
      if (think && think.state === 'running') { think.state = 'ok'; think.endedAt = nowMs(); refreshStep(think); }
    }
  }

  /**
   * The turn ended. `holdMs`: the panel plays a one-shot (success, error) on
   * the character on screen, so its stage stays up that long before it folds.
   */
  function finishTurn({ holdMs = 0 } = {}) {
    flushStream(rootScope);
    if (rootScope.stream?.row) rootScope.stream.row.classList.remove('streaming');
    for (const scope of scopes.values()) flushStream(scope);
    closeStreamThinks();
    hideWorking();
    turnActive = false;
    const stage = grace || newestStage();
    grace = null;
    const hold = holdMs > 0 && !calm();
    if (stage) {
      if (hold) holdStage(stage, holdMs);
      else if (!stage.holdTimer) stage.holdUntil = 0; // a hold already running (the `done` after a result) keeps its time
    }
    endBursts(rootScope);
    for (const rack of [...racks]) {
      const tail = liveTail(rack.scope) === rack;
      rack.closed = true;
      if (rack.live || tail || rack === stage) renderRack(rack);
    }
    if (hero?.parked) dismissHero();
  }

  /**
   * Rehydrate from GET /api/assistant/sessions/:id. Accepts transcript entries in
   * any of these shapes: raw envelope packets ({type:'event', event}), user turns
   * ({type:'query'|'user', prompt|text}), or role-tagged messages. The last burst
   * stays open (the window may end mid-turn; the live events continue it).
   */
  function renderTranscript(entries) {
    const list = Array.isArray(entries) ? entries : [];
    let failed = 0;
    let firstError = null;
    // The replay a reattach sends next repeats part of this window: planReplay leaves it out.
    snapshot = { keys: new Set(), at: -Infinity, seq: -Infinity };
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      // An entry that cannot be drawn costs that entry, never the rest of the history.
      try { renderEntry(entry); } catch (err) { failed += 1; firstError ||= err; }
    }
    if (failed) console.warn(`[assistant] ${failed} of ${list.length} transcript entries could not be drawn`, firstError);
    flushStream(rootScope);
    if (rootScope.stream?.row) rootScope.stream.row.classList.remove('streaming');
    for (const scope of scopes.values()) flushStream(scope);
    hideWorking();
    turnActive = false;
    for (const rack of [...racks]) renderRack(rack);
    scrollEnd(true);
  }

  function renderEntry(entry) {
    const was = { muted, clockAt };
    muted = true;
    const ms = entry.at != null ? Date.parse(entry.at) : NaN;
    clockAt = Number.isFinite(ms) ? ms : null;
    try { drawEntry(entry); noteSnapshot(entry); }
    finally { muted = was.muted; clockAt = was.clockAt; }
  }

  function drawEntry(entry) {
    const packet = entry.packet && typeof entry.packet === 'object' ? entry.packet : entry;
    const role = packet.role || packet.type;
    if (role === 'query' || role === 'user' || role === 'prompt') {
      const text = packet.prompt ?? packet.text ?? (typeof packet.content === 'string' ? packet.content : null);
      if (text != null && !packet.event) { appendUser(String(text), { images: Array.isArray(packet.images) ? packet.images : [] }); return; }
    }
    // The runtime journals the user's prompts only as `synabun.user_prompt` events.
    if (packet.type === 'event' && packet.event?.type === 'synabun.user_prompt') {
      if (packet.event.text) appendUser(String(packet.event.text), { origin: packet.event.origin || null, imageCount: packet.event.images });
      return;
    }
    if (packet.type === 'event' && packet.event) { handleEvent(packet.event, { silent: true }); return; }
    if (role === 'assistant' && (packet.message || packet.content)) { renderAssistant(packet.message || packet); return; }
    if (packet.type && handleEvent(packet, { silent: true })) return;
    if (role === 'system' && packet.text) appendStatus(packet.text);
  }

  function dropAll() {
    for (const rack of [...racks]) dropRack(rack);
    stopTicker();
    stepsById.clear();
  }

  function clear() {
    for (const scope of scopes.values()) { if (scope.stream?.mdTimer) clearTimeout(scope.stream.mdTimer); if (scope.stream?.thinkTimer) clearTimeout(scope.stream.thinkTimer); }
    if (rootScope.stream?.mdTimer) clearTimeout(rootScope.stream.mdTimer);
    if (rootScope.stream?.thinkTimer) clearTimeout(rootScope.stream.thinkTimer);
    scopes.clear();
    runCards.clear();
    routeLines.clear();
    turnFrames = [];
    rootScope.stream = null;
    rootScope.kept = null;
    rootScope.msgId = null;
    lastErrorText = '';
    hideWorking();
    turnActive = false;
    dropAll();
    runInfo.clear();
    dropHero();
    grace = null;
    turn = { calls: 0, last: null, errored: false, answerRow: null };
    mcpWarned.clear();
    seen.clear();
    snapshot = null;
    waiting = null;
    $msgs.innerHTML = '';
    emptyEl = null;
    followTail = true;
  }

  return {
    el: $msgs,
    clear,
    destroy: () => { hideWorking(); dropHero(); dropAll(); },
    appendUser,
    appendAssistantMarkdown,
    appendStatus,
    appendError,
    appendDivider,
    appendNode,
    appendMemoryChips,
    appendMemorySaved,
    appendMailbox,
    upsertRunCard,
    patchRunUsage,
    upsertRouteLine,
    registerRouteLine,
    removeRouteLine,
    getRouteLine: (routeId) => routeLines.get(routeId) || null,
    getRunCard: (runId) => runCards.get(runId) || null,
    handleEvent,
    /** The live gate for an event (false: already drawn); registers what it lets through. */
    claimEvent,
    /** A reattach's buffered packets minus what is on screen (see planReplay). */
    planReplay,
    /** Forget what was drawn (a brain switch starts a new id space). */
    forgetSeen: () => { seen.clear(); snapshot = null; },
    /** A card waits on the user: `toolUseId` names the call it holds (the newest live stage when unknown); false clears it. */
    setWaiting,
    finishTurn,
    renderTranscript,
    showWorking,
    hideWorking,
    isWorkingShown: () => !!working?.isConnected,
    showEmpty,
    refreshEmpty: renderSuggestions,
    isEmpty: () => !!emptyEl,
    scrollEnd,
    isNearBottom,
    md,
    /** The character on screen, for the panel's director: { kind, rig, el, hold(on), restore() } or null. */
    mascot: visibleMascot,
    setRigsEnabled,
    /** What this turn did: real calls (not the prompt-time recall), whether the last one failed, a turn error. */
    turnStats: () => ({ calls: turn.calls, lastFailed: turn.last?.state === 'error', errored: turn.errored }),
    /** The text of the turn's last message at the root ('' when it folded into a rack or there was none). */
    turnAnswer: () => (turn.answerRow?.isConnected ? (turn.answerRow.querySelector('.asst-md')?.textContent || '').replace(/\s+/g, ' ').trim() : ''),
  };
}
