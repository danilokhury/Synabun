// ═══════════════════════════════════════════
// SynaBun Assistant — worker scenes
// ═══════════════════════════════════════════
// What a dispatched worker is doing, as a small scene: one per task class
// (the route's class, else the run's own), plus a generic one. A run card's
// stage (asst-run-stage.js) shows the full scene beside the mascot; the
// agents tray shows the mini one; the Assistant's own activity rack shows it
// too while it works on a direct route (asst-render.js). The scene follows
// the worker's live tool activity (sync:sidepanel:provider-event: Claude and
// Codex workers, and a compact copy of an OpenCode worker's tool calls) and
// the rack's current call: a coding run that drives the browser shows the
// browser scene for as long as that is what it does, the class is the fallback.
//
// DOM-free on purpose (node:test, tests/assistant-worker-stage.test.mjs):
// the phases, the scene a run shows, its step line and its accessible name,
// and the scenes' SVG markup as strings. The motion is CSS
// (asst-scene-styles.js): transform and opacity only, run while the scene
// carries data-live. Decorative SVG only: the stage is named by stageLabel().

import { isRunIdle, isTerminalRunStatus, runNeedsAttention, runStatusFromState, runTone } from './asst-state.js';
import { kindOf, parseToolName, sayCall, tFallback, verbText } from './asst-tool-kinds.js';
import { redactSecrets, safeStepInput } from './asst-redact.js';

/** The scenes: one per task class SynaBun dispatches, and the generic one. */
export const SCENES = Object.freeze(['quick', 'code', 'complex', 'review', 'research', 'browser', 'computer', 'automation', 'design', 'image_gen', 'video_gen', 'generic']);

/**
 * Per scene: its words (an i18n key and the English), the mascot's pose
 * (synabun-mascot.js MASCOT_POSES; the stage drives `gaze` and `pop` on the
 * ticker's 1 Hz beat, see asst-run-stage.js).
 */
export const SCENE_SPECS = Object.freeze({
  quick: { label: ['assistant.stage.scene.quick', 'Quick fix'], pose: 'mcp' },
  code: { label: ['assistant.stage.scene.code', 'Coding'], pose: 'shell' },
  complex: { label: ['assistant.stage.scene.complex', 'Complex task'], pose: 'think' },
  review: { label: ['assistant.stage.scene.review', 'Reviewing'], pose: 'read' },
  research: { label: ['assistant.stage.scene.research', 'Researching'], pose: 'search' },
  browser: { label: ['assistant.stage.scene.browser', 'Browsing'], pose: 'web' },
  computer: { label: ['assistant.stage.scene.computer', 'Using the computer'], pose: 'computer', gaze: 'pointer' },
  automation: { label: ['assistant.stage.scene.automation', 'Automating'], pose: 'plan', pop: true },
  design: { label: ['assistant.stage.scene.design', 'Designing'], pose: 'edit' },
  image_gen: { label: ['assistant.stage.scene.image_gen', 'Making an image'], pose: 'watch', gaze: 'canvas' },
  video_gen: { label: ['assistant.stage.scene.video_gen', 'Making a video'], pose: 'watch', gaze: 'strip' },
  generic: { label: ['assistant.stage.scene.generic', 'Working'], pose: 'think' },
});

/** Phases a stage is open and moving (or waiting on you) in; the rest settle it. */
export const LIVE_PHASES = Object.freeze(['queued', 'starting', 'working', 'waiting']);
const LIVE = new Set(LIVE_PHASES);

/** How long the worker's last tool call speaks for it: the step line, and the scene it implies. */
export const ACTIVITY_FRESH_MS = 90_000;

const str = (v) => (v == null ? '' : String(v));

/** The run's task class: its own, else its route's ('' when neither says). */
export function runTaskClass(run) {
  return str(run?.taskClass || run?.route?.taskClass || '').trim();
}

/** The scene of a task class (chat, unknown or none → generic). */
export function sceneOfClass(taskClass) {
  const id = str(taskClass).trim();
  return id && id !== 'generic' && Object.hasOwn(SCENE_SPECS, id) ? id : 'generic';
}

/**
 * Where a run stands for its stage: queued | starting | working | waiting
 * (on you: a permission, a question, a route card, or a turn that ended
 * asking you) (live), idle (a warm worker between turns) | done | failed |
 * stopped (settled), or null for no run.
 */
export function stagePhase(run) {
  if (!run || typeof run !== 'object') return null;
  const status = str(run.status || runStatusFromState(run.state));
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'interrupted') return 'failed';
  if (status === 'stopped') return 'stopped';
  if (isTerminalRunStatus(status)) return 'done';
  if (runNeedsAttention(run) || awaitsAnswer({ ...run, status })) return 'waiting';
  if (isRunIdle({ ...run, status })) return 'idle';
  if (status === 'queued' || run.queued === true || run.state === 'queued') return 'queued';
  if (status === 'starting' || run.state === 'starting') return 'starting';
  if (status === 'running') return 'working';
  return null;
}

export const isLivePhase = (phase) => LIVE.has(phase);

/**
 * The worker waits on your answer. Either its turn ended asking you something:
 * the dispatcher reports that as a warm run (state and turnState idle) whose
 * outcome (lastResult.status) is needs_input, until a follow-up starts the next
 * turn (state running). Or it asked mid-turn: awaiting_permission with a
 * pending question (Claude's AskUserQuestion, OpenCode's question tool).
 */
export function awaitsAnswer(run) {
  if (!run || typeof run !== 'object') return false;
  if (run.turnState === 'needs_input') return true;
  if (run.state === 'awaiting_permission' || run.turnState === 'awaiting_permission') {
    return (Array.isArray(run.pending) ? run.pending : []).some((request) => request?.kind === 'question');
  }
  return isRunIdle(run) && str(run.outcome || run.lastResult?.status) === 'needs_input';
}

/**
 * The run card's status chip, `{ tone, label }` (asst-render.js updateRunCard).
 * A run that waits on your answer says so as its stage does (awaitsAnswer:
 * "Waiting for your answer"), in the waiting tone, a warm worker whose turn
 * ended asking you included; a warm worker between turns otherwise says what
 * its last turn ended with.
 */
export function runChip(run, t = tFallback) {
  if (run?.state === 'awaiting_route' || run?.turnState === 'awaiting_route' || run?.route?.status === 'pending') {
    return { tone: 'action', label: t('assistant.run.awaitingRoute', 'waiting for your model choice') };
  }
  if (awaitsAnswer(run)) return { tone: 'action', label: t('assistant.run.waitingInput', 'waiting for your answer') };
  const tone = runTone(run);
  if (run?.turnState === 'awaiting_permission') return { tone, label: t('assistant.run.needsApproval', 'needs approval') };
  if (run?.turnState === 'needs_input') return { tone, label: t('assistant.run.needsInput', 'needs input') };
  if (run?.queued && run.status !== 'running') return { tone, label: t('assistant.run.queued', 'queued') };
  if (isRunIdle(run)) {
    const outcome = run.outcome || run.lastResult?.status;
    return { tone, label: outcome ? t('assistant.run.idleWith', '{outcome} · idle', { outcome }) : t('assistant.run.idle', 'idle') };
  }
  return { tone, label: run?.status || tone };
}

/** The final frame a settled phase draws: done, failed or stopped. */
export function finalFrame(phase, run = null) {
  if (phase === 'failed') return 'failed';
  if (phase === 'stopped') return 'stopped';
  if (phase === 'idle') {
    const outcome = str(run?.outcome || run?.lastResult?.status);
    return outcome === 'failed' ? 'failed' : outcome === 'blocked' ? 'stopped' : 'done';
  }
  return 'done';
}

// ── The worker's live activity (provider events) ─────────────────────────────

/**
 * Which of Codex's item events (codex exec --json, @openai/codex-sdk
 * ThreadEvent) say what the worker does now, per item type. A command, an MCP
 * call and the plan begin with item.started (their item.completed reports a
 * call that is over; the plan's comes at the turn's end), the plan changes
 * with item.updated. A patch and a reasoning summary arrive only as
 * item.completed (the SDK's FileChangeItem is "emitted once the patch succeeds
 * or fails"); a web search has come either way.
 */
export const CODEX_ITEM_EVENTS = Object.freeze({
  command_execution: Object.freeze(['item.started']),
  mcp_tool_call: Object.freeze(['item.started']),
  todo_list: Object.freeze(['item.started', 'item.updated']),
  file_change: Object.freeze(['item.started', 'item.completed']),
  reasoning: Object.freeze(['item.started', 'item.completed']),
  web_search: Object.freeze(['item.started', 'item.completed']),
});

/**
 * Which of an OpenCode tool part's states (message.part.updated, the SDK's
 * ToolPart) say what the worker does: `running` is a call that started (a
 * `pending` part's input is still streaming), `completed` or `error` one that
 * ended. The server forwards one start and one finish per call
 * (lib/opencode-worker-activity.js); a finish counts, like Codex's
 * completion-only items, for a call whose start the bounded relay folded into it.
 */
export const OPENCODE_TOOL_STATES = Object.freeze(['running', 'completed', 'error']);

/**
 * A worker's provider event ({ provider, eventType?, event }, the payload of
 * sync:sidepanel:provider-event) as what it is doing: { kind, name, input }
 * for a tool call (the asst-tool-kinds.js kind), { kind: 'think' } for a
 * thinking block, or null (text, results, stream deltas: nothing new). The
 * stage and the tray keep only compactActivity() of it. OpenCode names its
 * tools bash, read, edit, write, patch, glob, grep, list, webfetch,
 * websearch, codesearch, task, todowrite, and MCP tools `<server>_<tool>`
 * (SynaBun_browser_navigate): kindOf() reads all of them.
 */
export function activityOf(payload) {
  const provider = str(payload?.provider);
  const event = payload?.event && typeof payload.event === 'object' ? payload.event : null;
  if (!event) return null;
  if (provider === 'claude-code' || provider === 'claude') {
    if (event.type !== 'assistant') return null;
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    let found = null;
    for (const block of blocks) {
      if (block?.type === 'tool_use' && block.name) found = { kind: kindOf(block.name, block.input), name: String(block.name), input: obj(block.input) };
      else if (!found && (block?.type === 'thinking' || block?.type === 'redacted_thinking')) found = { kind: 'think', name: 'thinking', input: {} };
    }
    return found;
  }
  if (provider === 'codex') {
    const item = event.item && typeof event.item === 'object' ? event.item : {};
    if (!Object.hasOwn(CODEX_ITEM_EVENTS, str(item.type)) || !CODEX_ITEM_EVENTS[item.type].includes(event.type)) return null;
    switch (item.type) {
      case 'command_execution': return { kind: 'shell', name: 'exec_command', input: { command: str(item.command) } };
      case 'file_change': {
        const paths = (Array.isArray(item.changes) ? item.changes : []).map((c) => str(c?.path)).filter(Boolean);
        return { kind: 'edit', name: 'apply_patch', input: paths.length > 1 ? { files: paths.map((path) => ({ path })) } : { file_path: paths[0] || '' } };
      }
      case 'mcp_tool_call': {
        const name = `mcp__${str(item.server) || 'tool'}__${str(item.tool) || 'call'}`;
        const input = obj(item.arguments);
        return { kind: kindOf(name, input), name, input };
      }
      case 'web_search': return { kind: 'web', name: 'WebSearch', input: { query: str(item.query) } };
      case 'todo_list': return { kind: 'plan', name: 'update_plan', input: { items: Array.isArray(item.items) ? item.items : [] } };
      case 'reasoning': return { kind: 'think', name: 'thinking', input: {} };
      default: return null;
    }
  }
  if (provider === 'opencode') {
    // { eventType: 'message.part.updated', event: { sessionID, part: ToolPart } }; a sub-agent's session is not the worker's call.
    if (payload.childSession || !/^message[.:]part[.:]updated$/i.test(str(payload.eventType))) return null;
    const part = event.part && typeof event.part === 'object' ? event.part : null;
    if (part?.type !== 'tool' || !str(part.tool).trim() || !OPENCODE_TOOL_STATES.includes(str(part.state?.status))) return null;
    const name = str(part.tool).trim();
    const input = obj(part.state?.input);
    return { kind: kindOf(name, input), name, input };
  }
  return null;
}

function obj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('{')) { try { const parsed = JSON.parse(v); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }
  return {};
}

/** The scene a tool call implies on its own, or null (the class decides). */
export function activityScene(activity, taskClass = '') {
  if (!activity?.kind) return null;
  if (activity.kind === 'computer') return 'computer';
  if (activity.kind !== 'web') return null;
  const tool = parseToolName(activity.name).tool;
  if (tool.startsWith('browser_')) return 'browser';
  // A page read or a web search reads as research, unless the run already browses or researches.
  const cls = sceneOfClass(taskClass);
  return cls === 'browser' || cls === 'research' ? null : 'research';
}

/** The activity while it still speaks for the worker (at most ACTIVITY_FRESH_MS old), else null. */
export function freshActivity(activity, now = Date.now()) {
  if (!activity?.kind) return null;
  const at = Number(activity.at);
  return Number.isFinite(at) && now - at > ACTIVITY_FRESH_MS ? null : activity;
}

/** The scene a run's stage shows now: what its current call implies, else its class's. */
export function sceneFor(run, activity = null, now = Date.now()) {
  const cls = runTaskClass(run);
  return activityScene(freshActivity(activity, now), cls) || sceneOfClass(cls);
}

/** The longest step line a stage or the tray keeps. */
export const STEP_MAX_CHARS = 120;

const clip = (v, max) => {
  const s = str(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/**
 * A call in words: its verb and subject, clipped. Worded from the input as a step line may read it
 * (asst-redact.js: credentials masked, a command's heredoc and inline file bodies omitted, an address without its
 * query), so no step line ever shows a credential, whichever worker's call it is.
 */
function wordStep(a, t) {
  if (a.kind === 'think') return verbText('think', true, t);
  const say = sayCall({ name: a.name, kind: a.kind, input: safeStepInput(a.input || {}), state: 'running' }, { t });
  const subject = redactSecrets(str(say.text)).replace(/^\$ /, '').replace(/\s+/g, ' ').trim();
  return clip(`${verbText(say.verb, true, t)}${subject ? ` ${subject}` : ''}`, STEP_MAX_CHARS);
}

/**
 * What a stage and the tray keep of a worker's call: { kind, name, step, at },
 * the kind and tool name its scene reads, its step line worded once and
 * clipped, and when it was seen. Never the call's arguments: an edit's can
 * hold a whole file; and never a credential the call carries. null for no call.
 */
export function compactActivity(activity, t = tFallback, now = Date.now()) {
  if (!activity?.kind) return null;
  const at = Number(activity.at);
  return {
    kind: str(activity.kind),
    name: clip(activity.name, 160),
    step: typeof activity.step === 'string' ? clip(redactSecrets(activity.step), STEP_MAX_CHARS) : wordStep(activity, t),
    at: Number.isFinite(at) && at > 0 ? at : now,
  };
}

/** "Editing asst-render.js", "Running npm test", "Thinking"; '' when nothing current is known. */
export function stepLine(activity, t = tFallback, now = Date.now()) {
  const a = freshActivity(activity, now);
  if (!a) return '';
  return typeof a.step === 'string' ? redactSecrets(a.step) : wordStep(a, t);
}

/** A scene's words ("Coding"), localized. */
export function sceneLabel(scene, t = tFallback) {
  const [key, fallback] = (SCENE_SPECS[scene] || SCENE_SPECS.generic).label;
  return t(key, fallback);
}

/** The stage's line when no step is known: the phase's words, or "Coding…" while it works. */
export function phaseLine(phase, run, scene, t = tFallback) {
  switch (phase) {
    case 'queued': return Number(run?.position) > 0 ? t('assistant.stage.queuedAt', 'Queued · position {n}', { n: run.position }) : t('assistant.stage.queued', 'Queued');
    case 'starting': return t('assistant.stage.starting', 'Starting…');
    case 'waiting':
      if (run?.state === 'awaiting_route' || run?.route?.status === 'pending' || run?.awaitingRoute) return t('assistant.stage.waitingRoute', 'Waiting for your model choice');
      if (awaitsAnswer(run)) return t('assistant.stage.waitingInput', 'Waiting for your answer');
      return t('assistant.stage.waitingApproval', 'Waiting for your approval');
    case 'idle': case 'done': return finalFrame(phase, run) === 'failed' ? t('assistant.stage.failed', 'Failed')
      : finalFrame(phase, run) === 'stopped' ? t('assistant.stage.stopped', 'Stopped') : t('assistant.stage.done', 'Done');
    case 'failed': return t('assistant.stage.failed', 'Failed');
    case 'stopped': return t('assistant.stage.stopped', 'Stopped');
    default: return t('assistant.stage.doing', '{scene}…', { scene: sceneLabel(scene, t) });
  }
}

/** Whole minutes of `ms`, as the stage's name says them: "under a minute", "1 min", "12 min". */
export function minutesText(ms, t = tFallback) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (m < 1) return t('assistant.stage.underMinute', 'under a minute');
  return m === 1 ? t('assistant.stage.minutes.one', '{count} min', { count: m }) : t('assistant.stage.minutes.other', '{count} min', { count: m });
}

/**
 * The stage's accessible name, one line that changes at most once a minute
 * (the step is visible text only, so nothing chatters):
 * "Coding · Settings: App controls section · 3 min"; waiting says why first.
 */
export function stageLabel({ scene = 'generic', phase = 'working', title = '', ms = 0, run = null } = {}, t = tFallback) {
  const what = phase === 'waiting' ? phaseLine('waiting', run, scene, t)
    : isLivePhase(phase) ? sceneLabel(scene, t) : phaseLine(phase, run, scene, t);
  return [what, str(title).replace(/\s+/g, ' ').trim(), minutesText(ms, t)].filter(Boolean).join(' · ');
}

// ── Scene markup ─────────────────────────────────────────────────────────────
// Full scenes are drawn in a 120×40 box (the stage shows them at 1:1 beside
// the mascot); minis in 40×20 (the tray, at 32×16). Strokes are 1.5 units in
// currentColor (the container's muted text); `sc-gold` is the one live part
// (gold only means live). Every part sits where its still frame wants it:
// with no animation (reduced motion, waiting, settled) the scene still reads.

/** The code scene's six lines, repeated twice so its stepped scroll loops seamlessly: [indent, keyword, rest]. */
export const CODE_LINES = Object.freeze([[6, 8, 26], [12, 10, 42], [12, 6, 22], [18, 9, 35], [12, 12, 48], [6, 7, 14]]);
export const CODE_STEP = 6; // one line, in viewBox units

const r1 = (v) => Math.round(v * 100) / 100;

/** A gear outline: n trapezoid teeth between radius r and R round (cx, cy). */
export function gearPath(cx, cy, r, R, n) {
  const pts = [];
  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i += 1) {
    const a = i * step;
    for (const [rad, off] of [[r, -0.32], [R, -0.18], [R, 0.18], [r, 0.32]]) {
      pts.push(`${r1(cx + rad * Math.cos(a + off * step))},${r1(cy + rad * Math.sin(a + off * step))}`);
    }
  }
  return `M${pts.join('L')}Z`;
}

/** Where the code scene's caret sits after step `s` (the newest line at the bottom slot): its x. */
export function codeCaretX(s) {
  const [indent, key, rest] = CODE_LINES[(4 + s) % CODE_LINES.length];
  return 4 + indent + key + 3 + rest + 2;
}

function codeFull() {
  let lines = '';
  for (let i = 0; i < CODE_LINES.length * 2; i += 1) {
    const [indent, key, rest] = CODE_LINES[i % CODE_LINES.length];
    const y = 5 + CODE_STEP * i;
    lines += `<path class="sc-mid" d="M${indent} ${y}h${key}"/><path class="sc-dim" d="M${indent + key + 3} ${y}h${rest}"/>`;
  }
  return '<rect class="sc-dim" x="1" y="1.5" width="118" height="37" rx="5"/>'
    + `<svg x="4" y="4" width="112" height="32" overflow="hidden"><g class="sc-code-scroll">${lines}</g></svg>`
    + `<g class="sc-code-caret" style="transform:translateX(${codeCaretX(0)}px)"><rect class="sc-gold sc-fill sc-caret" x="0" y="30.5" width="2" height="5" rx="1"/></g>`;
}

const GEAR_BIG = gearPath(66, 20, 9, 12.5, 8);
const GEAR_SMALL = gearPath(86.5, 12.5, 5.5, 8, 6);

function complexFull() {
  return '<path class="sc-dim" d="M14 7h13l5 5v21H14z"/><path class="sc-mid" d="M8 11h13l5 5v21H8zM21 11v5h5M12 23h9M12 28h11"/>'
    + `<g class="sc-gear-big sc-box"><path class="sc-mid" d="${GEAR_BIG}"/><circle class="sc-dim" cx="66" cy="20" r="3.2"/></g>`
    + `<g class="sc-gear-small sc-box"><path class="sc-gold" d="${GEAR_SMALL}"/><circle class="sc-gold" cx="86.5" cy="12.5" r="2"/></g>`
    + '<path class="sc-dim" d="M98 30h14M102 25h10"/>';
}

function reviewFull() {
  const rows = [[9, '+', 52], [16, '-', 64], [23, '+', 40], [30, '+', 58]];
  let out = '<rect class="sc-dim" x="1" y="1.5" width="118" height="37" rx="5"/>';
  rows.forEach(([y, sign, len], i) => {
    out += sign === '+' ? `<path class="sc-mid" d="M6 ${y}h4M8 ${y - 2}v4"/>` : `<path class="sc-mid" d="M6 ${y}h4"/>`;
    out += `<path class="sc-dim" d="M15 ${y}h${len}"/>`;
    out += `<path class="sc-gold sc-tick sc-box" style="--i:${i}" d="M${95} ${y}l2.2 2.2 4.4-4.6"/>`;
  });
  return out;
}

function researchFull() {
  const page = (x) => `<rect class="sc-dim" x="${x}" y="4" width="40" height="32" rx="3"/><path class="sc-dim" d="M${x + 6} 11h26M${x + 6} 17h22M${x + 6} 23h28M${x + 6} 29h16"/>`;
  return page(8) + page(56)
    + '<g class="sc-lens"><circle class="sc-gold" cx="24" cy="17" r="7"/><path class="sc-gold" d="M29.2 22.2l5 5"/></g>';
}

const POINTER = 'M0 0v10.5l2.8-2.6 2 4.4 2-.9-2-4.3h3.9z';

function browserFull() {
  return '<rect class="sc-dim" x="1" y="1.5" width="118" height="37" rx="5"/><path class="sc-dim" d="M1 9.5h118"/>'
    + '<circle class="sc-mid sc-fill" cx="6" cy="5.5" r="1"/><circle class="sc-mid sc-fill" cx="10" cy="5.5" r="1"/><circle class="sc-mid sc-fill" cx="14" cy="5.5" r="1"/>'
    + '<rect class="sc-dim" x="22" y="3.5" width="56" height="4" rx="2"/>'
    + '<path class="sc-mid" d="M8 16h36"/><path class="sc-dim" d="M8 22h54M8 27h44M8 32h30"/><rect class="sc-mid" x="78" y="25" width="28" height="8" rx="2"/>'
    + '<circle class="sc-gold sc-ring sc-ripple-browser sc-box" cx="92" cy="29" r="5"/>'
    + `<g class="sc-point-browser" style="transform:translate(92px,29px)"><path class="sc-gold sc-fill" d="${POINTER}"/></g>`;
}

function computerFull() {
  return '<rect class="sc-dim" x="10" y="1.5" width="100" height="30" rx="3"/><path class="sc-dim" d="M60 31.5v4M48 37.5h24"/>'
    + '<rect class="sc-mid sc-shade" x="16" y="6" width="44" height="20" rx="2"/><path class="sc-dim" d="M16 10h44M21 15h20M21 20h28"/>'
    + '<rect class="sc-mid sc-shade" x="52" y="11" width="50" height="17" rx="2"/><path class="sc-dim" d="M52 15h50"/><rect class="sc-mid" x="84" y="20" width="13" height="5" rx="1.5"/>'
    + '<circle class="sc-gold sc-ring sc-ripple-computer sc-box" cx="90" cy="22.5" r="4.5"/>'
    + `<g class="sc-point-computer" style="transform:translate(90px,22.5px)"><path class="sc-gold sc-fill" d="${POINTER}"/></g>`;
}

function automationFull() {
  return '<circle class="sc-mid" cx="18" cy="20" r="13"/><path class="sc-dim" d="M18 9v2M18 29v2M7 20h2M27 20h2"/>'
    + '<path class="sc-mid" d="M18 20l5-4"/>'
    + '<g class="sc-hand sc-vb" style="transform-origin:18px 20px"><path class="sc-gold" d="M18 20v-9"/></g><circle class="sc-gold sc-fill" cx="18" cy="20" r="1.6"/>'
    + '<path class="sc-dim" d="M52 24h14M76 24h14"/><rect class="sc-mid" x="44" y="20" width="8" height="8" rx="2"/><rect class="sc-mid" x="66" y="20" width="10" height="8" rx="2"/><rect class="sc-mid" x="90" y="20" width="8" height="8" rx="2"/>'
    + '<path class="sc-dim" d="M94 17c0-9-46-9-46 0M48 17l-2.5-3M48 17l3-2"/>'
    + '<g class="sc-run-dot"><circle class="sc-gold sc-fill" cx="48" cy="24" r="2.2"/></g>';
}

function designFull() {
  return '<rect class="sc-gold sc-fill sc-swatch" x="4" y="5" width="9" height="9" rx="2"/><rect class="sc-mid sc-fill sc-swatch-b" x="4" y="16" width="9" height="9" rx="2"/><rect class="sc-dim sc-fill sc-swatch-c" x="4" y="27" width="9" height="9" rx="2"/>'
    + '<rect class="sc-dim" x="20" y="2.5" width="96" height="35" rx="4"/>'
    + '<circle class="sc-mid sc-shape sc-box" style="--i:0" cx="40" cy="20" r="8"/>'
    + '<rect class="sc-mid sc-shape sc-box" style="--i:1" x="58" y="12" width="16" height="16" rx="3"/>'
    + '<path class="sc-mid sc-shape sc-box" style="--i:2" d="M86 28l9-16 9 16z"/>'
    + '<g class="sc-pen" style="transform:translate(40px,20px)"><path class="sc-gold" d="M0 0l6-6M6-6l2.5 2.5M0 0l-1.2 3.7L2.5 2.5z"/></g>';
}

function imageFull() {
  let tiles = '';
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const gold = (row === 1 && col === 2) || (row === 2 && col === 0);
      tiles += `<rect class="${gold ? 'sc-gold' : 'sc-mid'} sc-fill sc-tile" style="--i:${row + col}" x="${34 + col * 13.5}" y="${6 + row * 10}" width="11.5" height="8" rx="1.5"/>`;
    }
  }
  return `<rect class="sc-dim" x="30" y="2.5" width="61" height="35" rx="3"/>${tiles}`
    + '<g class="sc-sparkle sc-box"><path class="sc-gold sc-fill" d="M104 6l1.6 4.4L110 12l-4.4 1.6L104 18l-1.6-4.4L98 12l4.4-1.6z"/></g>'
    + '<path class="sc-dim" d="M100 26h12M100 31h8"/>';
}

function filmFrames(width, y, h, frameW, count) {
  let out = `<rect class="sc-dim" x="0" y="${y}" width="${width}" height="${h}" rx="2"/>`;
  for (let i = 0; i < count; i += 1) out += `<rect class="sc-mid" x="${i * frameW + 3}" y="${y + 5}" width="${frameW - 6}" height="${h - 10}" rx="1.5"/>`;
  for (let x = 2; x < width; x += 6) out += `<rect class="sc-dim sc-fill" x="${x}" y="${y + 1.5}" width="2.4" height="2" rx=".6"/><rect class="sc-dim sc-fill" x="${x}" y="${y + h - 3.5}" width="2.4" height="2" rx=".6"/>`;
  return out;
}

function videoFull() {
  return `<svg x="4" y="4" width="112" height="32" overflow="hidden"><g class="sc-film">${filmFrames(160, 2, 28, 24, 7)}</g></svg>`
    + '<path class="sc-gold" d="M58 2v36M55 2h6l-3 3z"/>';
}

/** An open-end wrench, horizontal, its jaw round (0, 0): place it with translate(bolt) rotate(a) translate(3.5 0). */
const WRENCH = 'M-4.6 -3.86L-1 -2V2L-4.6 3.86A6 6 0 0 0 5.5 2.4H24A2.4 2.4 0 0 0 24 -2.4H5.5A6 6 0 0 0 -4.6 -3.86Z';
const hexagon = (cx, cy, r) => `M${[0, 1, 2, 3, 4, 5].map(i => `${r1(cx + r * Math.cos(i * Math.PI / 3))} ${r1(cy + r * Math.sin(i * Math.PI / 3))}`).join('L')}Z`;

function quickFull() {
  return `<path class="sc-mid" d="${hexagon(38, 24, 3.4)}"/>`
    + `<g class="sc-wrench sc-vb" style="transform-origin:38px 24px"><path class="sc-gold" transform="translate(38 24) rotate(-32) translate(3.5 0)" d="${WRENCH}"/></g>`
    + '<path class="sc-gold sc-spark" style="--i:0" d="M30.5 19.5l-3-2"/><path class="sc-gold sc-spark" style="--i:1" d="M29.5 24.5h-3.5"/><path class="sc-gold sc-spark" style="--i:2" d="M30.5 29.5l-3 2"/>'
    + '<g class="sc-zap sc-box"><path class="sc-gold" d="M92 5l-8 15h7l-3 14 11-18h-7.5z"/></g>';
}

function genericFull() {
  return '<path class="sc-dim" d="M14 20h92"/><circle class="sc-mid" cx="14" cy="20" r="3"/><circle class="sc-mid" cx="60" cy="20" r="3"/><circle class="sc-mid" cx="106" cy="20" r="3"/>'
    + '<g class="sc-slide"><rect class="sc-gold sc-fill" x="14" y="18.5" width="24" height="3" rx="1.5"/></g>';
}

// Minis (40×20, the tray at 32×16): one gesture each.
const MINI = {
  code: () => '<path class="sc-mid" d="M5 5h20M9 10h24M5 15h14"/><rect class="sc-gold sc-fill sc-caret" x="21.5" y="12.5" width="1.8" height="5" rx=".9"/>',
  complex: () => `<g class="sc-gear-big sc-box"><path class="sc-mid" d="${gearPath(14, 11, 4.5, 6.6, 6)}"/></g><g class="sc-gear-small sc-box"><path class="sc-gold" d="${gearPath(26.5, 7.5, 3, 4.6, 6)}"/></g>`,
  review: () => '<path class="sc-dim" d="M4 5h20M4 10h24M4 15h18"/><path class="sc-gold sc-tick sc-box" style="--i:0" d="M30 5l1.6 1.6 3.2-3.4"/><path class="sc-gold sc-tick sc-box" style="--i:1" d="M32 10l1.6 1.6 3.2-3.4"/>',
  research: () => '<rect class="sc-dim" x="3" y="2.5" width="26" height="15" rx="2"/><path class="sc-dim" d="M7 7h16M7 11h12M7 15h14"/><g class="sc-lens-mini"><circle class="sc-gold" cx="12" cy="9" r="3.8"/><path class="sc-gold" d="M14.8 11.8l2.8 2.8"/></g>',
  browser: () => `<rect class="sc-dim" x="2" y="2" width="36" height="16" rx="2.5"/><path class="sc-dim" d="M2 6h36"/><rect class="sc-mid" x="24" y="11" width="10" height="4" rx="1.2"/><g class="sc-point-mini" style="transform:translate(29px,13px) scale(.6)"><path class="sc-gold sc-fill" d="${POINTER}"/></g>`,
  computer: () => `<rect class="sc-dim" x="5" y="1.5" width="30" height="14" rx="2"/><path class="sc-dim" d="M20 15.5v2M15 18.5h10"/><rect class="sc-mid" x="8" y="4.5" width="13" height="8" rx="1"/><g class="sc-point-mini" style="transform:translate(29px,13px) scale(.6)"><path class="sc-gold sc-fill" d="${POINTER}"/></g>`,
  automation: () => '<circle class="sc-mid" cx="11" cy="10" r="7.5"/><path class="sc-dim" d="M11 10l3-2.5"/><g class="sc-hand sc-vb" style="transform-origin:11px 10px"><path class="sc-gold" d="M11 10V4.5"/></g>'
    + '<path class="sc-mid" d="M33.5 10a5 5 0 1 1-1.5-3.6M32 3.6v2.8h-2.8"/>',
  design: () => '<rect class="sc-mid sc-fill" x="3" y="3" width="6" height="6" rx="1.5"/><rect class="sc-dim sc-fill" x="3" y="11" width="6" height="6" rx="1.5"/><circle class="sc-gold sc-shape sc-box" style="--i:0" cx="21" cy="10" r="5"/><path class="sc-mid sc-shape sc-box" style="--i:1" d="M29 15l4.5-8 4.5 8z"/>',
  image_gen: () => {
    let tiles = '';
    for (let row = 0; row < 2; row += 1) for (let col = 0; col < 3; col += 1) tiles += `<rect class="${row === 1 && col === 2 ? 'sc-gold' : 'sc-mid'} sc-fill sc-tile" style="--i:${row + col}" x="${11 + col * 6.4}" y="${5 + row * 5.6}" width="5" height="4.2" rx="1"/>`;
    return `<rect class="sc-dim" x="9" y="2.5" width="22" height="15" rx="2"/>${tiles}`;
  },
  video_gen: () => `<svg x="2" y="2" width="36" height="16" overflow="hidden"><g class="sc-film-mini">${filmFrames(60, 1, 14, 12, 5)}</g></svg><path class="sc-gold" d="M20 1v18"/>`,
  quick: () => `<path class="sc-mid" d="${hexagon(11, 11, 2.6)}"/><g class="sc-wrench sc-vb" style="transform-origin:11px 11px"><path class="sc-gold" stroke-width="2.4" transform="translate(11 11) rotate(-32) scale(.62) translate(3.5 0)" d="${WRENCH}"/></g>`
    + '<path class="sc-gold sc-spark" style="--i:0" d="M5.5 7.5l-2-1.3"/><path class="sc-gold sc-spark" style="--i:1" d="M5 11.5H2.6"/>',
  generic: () => '<circle class="sc-gold sc-fill sc-dot" style="--i:0" cx="11" cy="10" r="2.4"/><circle class="sc-gold sc-fill sc-dot" style="--i:1" cx="20" cy="10" r="2.4"/><circle class="sc-gold sc-fill sc-dot" style="--i:2" cx="29" cy="10" r="2.4"/>',
};

const FULL = {
  quick: quickFull, code: codeFull, complex: complexFull, review: reviewFull, research: researchFull, browser: browserFull,
  computer: computerFull, automation: automationFull, design: designFull, image_gen: imageFull, video_gen: videoFull, generic: genericFull,
};

/**
 * A scene's SVG (decorative: aria-hidden). `mini` draws the tray's 40×20
 * version. `live` starts it moving (the stage and tray set data-live
 * themselves later; this is only the first state).
 */
export function sceneSvg(scene, { mini = false, live = false, className = '' } = {}) {
  const id = Object.hasOwn(FULL, scene) ? scene : 'generic';
  const [w, h] = mini ? [40, 20] : [120, 40];
  const body = (mini ? MINI[id] : FULL[id])();
  return `<svg class="asst-scene${mini ? ' is-mini' : ''}${className ? ` ${className}` : ''}" data-scene="${id}"${live ? ' data-live=""' : ''} viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
