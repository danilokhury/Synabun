// ═══════════════════════════════════════════
// SynaBun Assistant — a worker's stage in its run card
// ═══════════════════════════════════════════
// While a dispatched run works (queued, starting, running a turn), its run
// card in the transcript opens a stage: the mascot acting out the run's
// scene (asst-scenes.js: its task class, or what its current tool call does),
// the scene beside it and the worker's step. The run's elapsed time has one
// place, the card's details line (asst-render.js ticks it with the stage's
// beat), so the stage repeats no clock. The stage belongs to
// the run, not to the Assistant's turn: it stays open and moving after the
// turn that dispatched the run has ended, through new turns and messages,
// card updates (it is built once and updated in place), a hidden panel (the
// rig parks off screen and comes back by itself) and a reload (the renderer
// restores the card). Waiting on you it holds a calm blocked frame; once the
// run settles (its turn done, or the run ended) it shows the final frame,
// holds it, and folds into the card's compact form; a new turn opens it
// again.
//
// One rig per open stage on the shared ticker; the accessible name (whole
// minutes) and the gaze or pop beats some scenes use run on the renderer's
// 1 Hz beat (tick()), never a loop of their own. Styles:
// asst-scene-styles.js.

import * as mascotLib from '../synabun-mascot.js';
import { isTerminalRunStatus } from './asst-state.js';
import { SCENE_SPECS, compactActivity, finalFrame, isLivePhase, phaseLine, sceneFor, sceneSvg, stageLabel, stagePhase, stepLine } from './asst-scenes.js';

export const STAGE_TIMING = Object.freeze({
  settleHoldMs: 1400, // the final frame shows this long before the stage folds
  foldMs: 260, // the fold, then the rig goes
  sceneDwellMs: 2500, // a scene the activity picked stays at least this long
});

const GAZE = {
  pointer: [[0.9, 0.25], [0.55, -0.35], [1, 0.45], [0.7, 0]],
  canvas: [[0.8, -0.2], [0.95, 0.25], [0.7, 0.05]],
  strip: [[0.35, 0], [0.75, 0.05], [1, 0], [0.75, -0.05]],
};

/**
 * createWorkerStage(card, { t, calm, now, mascot })
 * Builds the stage (closed) after the card's meta row. update(run) opens it
 * for a live phase and settles it otherwise; tick(now) is the 1 Hz beat.
 * Returns { el, update(run), setActivity(activity), tick(now), live(), state(), destroy() }.
 */
export function createWorkerStage(card, { t = (_key, fallback) => fallback, calm = () => false, now = () => Date.now(), mascot = mascotLib } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'asst-run-stage-wrap';
  wrap.innerHTML = '<div class="asst-run-stage" role="img">'
    + '<div class="asst-run-stage-face" aria-hidden="true"></div>'
    + '<div class="asst-run-stage-scene" aria-hidden="true"></div>'
    + '<div class="asst-run-stage-line" aria-hidden="true"><span class="asst-run-stage-step"></span></div>'
    + '<div class="asst-run-stage-sweep" aria-hidden="true"></div>'
    + '</div>';
  const stage = wrap.firstElementChild;
  const face = stage.querySelector('.asst-run-stage-face');
  const sceneHost = stage.querySelector('.asst-run-stage-scene');
  const stepEl = stage.querySelector('.asst-run-stage-step');
  const meta = card.querySelector(':scope > .asst-run-meta');
  if (meta) meta.after(wrap); else card.appendChild(wrap);

  let run = null;
  let phase = null;
  let open = false;
  let scene = '';
  let sceneAt = -Infinity;
  let activity = null;
  let rig = null;
  let pose = '';
  let final = '';
  let foldTimer = 0;
  let clearTimer = 0;
  let beat = 0;
  let destroyed = false;

  const safe = (fn) => { try { return fn(); } catch { return undefined; } };

  function ensureRig() {
    if (rig || destroyed) return;
    rig = safe(() => mascot.createMascot(face, { width: 56, height: 28, rangeX: 10, rangeY: 7, pose: 'idle' })) || null;
    pose = '';
  }

  function dropRig() {
    if (rig) safe(() => rig.destroy());
    rig = null;
    pose = '';
    face.textContent = '';
  }

  function setPose(name, opts) {
    const key = `${name}|${opts?.then || ''}`;
    if (!rig || key === pose) return;
    pose = key;
    safe(() => rig.setPose(name, opts));
  }

  /** The scene for now; a swap waits out the dwell of the one on screen (the beat tries again), except out of the generic one. */
  function syncScene(at) {
    const want = sceneFor(run, activity, at);
    if (want === scene) return;
    if (scene && scene !== 'generic' && at - sceneAt < STAGE_TIMING.sceneDwellMs) return;
    scene = want;
    sceneAt = at;
    sceneHost.innerHTML = sceneSvg(scene);
    stage.dataset.scene = scene;
    pose = ''; // the new scene's pose
  }

  function moving() {
    return open && !final && phase !== 'waiting' && isLivePhase(phase);
  }

  function paint() {
    if (destroyed || !run) return;
    const at = now();
    syncScene(at);
    const live = moving();
    stage.dataset.phase = final ? phase || 'done' : phase || '';
    stage.toggleAttribute('data-live', live);
    if (final) stage.dataset.final = final; else delete stage.dataset.final;
    sceneHost.firstElementChild?.toggleAttribute('data-live', live);
    if (rig && !final) setPose(phase === 'waiting' ? 'blocked' : (SCENE_SPECS[scene] || SCENE_SPECS.generic).pose);
    const text = final ? phaseLine(phase, run, scene, t)
      : phase === 'working' ? (stepLine(activity, t, at) || phaseLine(phase, run, scene, t))
        : phaseLine(phase, run, scene, t);
    if (stepEl.textContent !== text) stepEl.textContent = text;
    paintLabel(at);
  }

  function elapsedMs(at) {
    const from = new Date(run?.startedAt || run?.createdAt || 0).getTime();
    if (!from) return 0;
    const end = isTerminalRunStatus(run?.status) ? new Date(run.completedAt || run.updatedAt || at).getTime() : at;
    return Math.max(0, end - from);
  }

  /** The stage's accessible name; its minutes are the only time the stage says (the card's details line shows the clock). */
  function paintLabel(at) {
    const label = stageLabel({ scene, phase: final ? phase : phase || 'working', title: run?.title || run?.task || '', ms: elapsedMs(at), run }, t);
    if (stage.getAttribute('aria-label') !== label) stage.setAttribute('aria-label', label);
  }

  function openStage() {
    clearTimeout(foldTimer);
    clearTimeout(clearTimer);
    foldTimer = 0;
    clearTimer = 0;
    final = '';
    if (!open) {
      open = true;
      card.classList.add('is-staged');
    }
    ensureRig();
  }

  /** The run settled: the final frame (a one-shot on the rig), held, then the fold. */
  function settle() {
    const next = finalFrame(phase, run);
    if (final === next) return;
    final = next;
    if (rig) {
      if (next === 'done') safe(() => rig.setPose('success', { then: 'idle' }));
      else if (next === 'failed') safe(() => rig.setPose('error', { then: 'idle' }));
      else safe(() => rig.setPose('idle'));
      pose = `final|${next}`;
    }
    clearTimeout(foldTimer);
    foldTimer = setTimeout(fold, calm() ? 0 : STAGE_TIMING.settleHoldMs);
  }

  function fold() {
    foldTimer = 0;
    if (destroyed || !open) return;
    open = false;
    card.classList.remove('is-staged');
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { clearTimer = 0; if (!open) dropRig(); }, calm() ? 0 : STAGE_TIMING.foldMs);
  }

  function update(next) {
    if (destroyed || !next) return;
    run = next;
    if (isTerminalRunStatus(run.status)) activity = null; // the run is over: so is what it was doing
    phase = stagePhase(run);
    if (isLivePhase(phase)) openStage();
    else if (open) settle();
    paint();
  }

  /** The 1 Hz beat: the minute in the name, a scene swap the dwell held back, and the gaze or pop some scenes use. */
  function tick(at = now()) {
    if (destroyed || !open || !run) return;
    syncScene(at);
    paint();
    if (!moving() || !rig || calm()) return;
    beat += 1;
    const spec = SCENE_SPECS[scene] || SCENE_SPECS.generic;
    const path = spec.gaze ? GAZE[spec.gaze] : null;
    if (path) {
      const [x, y] = path[beat % path.length];
      safe(() => rig.look(x, y));
      if (spec.gaze === 'pointer' && beat % 2 === 0) safe(() => rig.react('click'));
    }
    if (spec.pop && beat % 2 === 0) safe(() => rig.react('pop'));
  }

  return {
    el: wrap,
    update,
    /** What the worker is doing now, from its provider events: kept compact ({ kind, name, step, at }), never its arguments. */
    setActivity(next) {
      activity = run && isTerminalRunStatus(run.status) ? null : compactActivity(next, t, now());
      if (open) paint();
    },
    tick,
    /** Open (live, or holding its final frame before the fold). */
    live: () => open,
    /** For tests and devtools. */
    state: () => ({ open, phase, scene, final, pose: rig?.pose || null, step: stepEl.textContent, label: stage.getAttribute('aria-label') || '' }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(foldTimer);
      clearTimeout(clearTimer);
      dropRig();
      card.classList.remove('is-staged');
      wrap.remove();
    },
  };
}
