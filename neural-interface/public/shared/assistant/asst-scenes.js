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
// and allowlisted scene artwork. GIF playback follows data-live; inactive
// and reduced-motion scenes use PNGs. The stage is named by stageLabel().

import { sceneAsset, SCENE_ASSET_KEYS } from '../synabun-mascot-assets.js';
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

// Activity artwork shares the matching class's translated label and pose.
export const ACTIVITY_SCENE_SPECS = Object.freeze(Object.fromEntries(
  Object.entries({ edit: 'design', shell: 'code', read: 'review', search: 'research', web: 'browser', memory: 'research', thinking: 'complex' })
    .map(([id, cls]) => [id, { ...SCENE_SPECS[cls], pose: id === 'thinking' ? 'think' : id }]),
));

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
  // A held run whose card the user answered "here": the assistant does it, this worker never started.
  if (run?.completionReason === 'route_here') return { tone, label: t('assistant.run.routedHere', 'not started: done here instead') };
  if (run?.turnState === 'awaiting_permission') return { tone, label: t('assistant.run.needsApproval', 'needs approval') };
  if (run?.turnState === 'needs_input') return { tone, label: t('assistant.run.needsInput', 'needs input') };
  // A Claude Code worker a server restart cut off, until the next start has resumed it (lib/assistant-dispatch.js).
  if (run?.state === 'suspended' || run?.state === 'resuming') return { tone, label: t('assistant.run.resuming', 'resuming after a server restart') };
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

// The path-like fields of an Antigravity tool call's arguments (lib/worker-confinement.js reads the same ones).
const ACP_PATH_KEYS = ['path', 'file_path', 'filePath', 'Path', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath'];

/**
 * An Antigravity (ACP) tool call as an activity: its `kind` says what it does (read, edit, delete,
 * move, search, execute, think, fetch, switch_mode, other), its `rawInput` holds the tool's own
 * arguments and its `locations` the files it touches. Another tool (an MCP server's) is read by its
 * name, as for the other providers. null for a mode switch.
 */
function acpToolActivity(call) {
  const args = obj(call.rawInput);
  const kind = str(call.kind) || 'other';
  const title = str(call.title).trim();
  const paths = [...new Set([
    ...(Array.isArray(call.locations) ? call.locations : []).map((location) => str(location?.path)),
    ...ACP_PATH_KEYS.map((key) => (typeof args[key] === 'string' ? args[key] : '')),
  ].filter(Boolean))];
  const pick = (...values) => values.map((v) => (typeof v === 'string' ? v.trim() : '')).find(Boolean) || '';
  switch (kind) {
    case 'execute': {
      const command = Array.isArray(args.command) ? args.command.map(str).join(' ') : pick(args.command, args.CommandLine, args.cmd);
      return { kind: 'shell', name: 'exec_command', input: { command: command || title } };
    }
    case 'read': return { kind: 'read', name: 'read', input: { file_path: paths[0] || title } };
    case 'edit': case 'delete': case 'move':
      return { kind: 'edit', name: kind === 'edit' ? 'edit' : 'apply_patch', input: paths.length > 1 ? { changes: paths.map((path) => ({ path })) } : { file_path: paths[0] || title } };
    case 'search': return { kind: 'search', name: 'grep', input: { pattern: pick(args.pattern, args.query, args.Query, args.Pattern) || title, path: paths[0] || '' } };
    case 'fetch': {
      const url = pick(args.url, args.Url, args.href);
      return url ? { kind: 'web', name: 'WebFetch', input: { url } } : { kind: 'web', name: 'WebSearch', input: { query: pick(args.query, args.Query) || title } };
    }
    case 'think': return { kind: 'think', name: 'thinking', input: {} };
    case 'switch_mode': return null;
    default: {
      const name = pick(call.name, args.toolName, title) || 'tool';
      return { kind: kindOf(name, args), name, input: args };
    }
  }
}

/**
 * A worker's provider event ({ provider, eventType?, event }, the payload of
 * sync:sidepanel:provider-event) as what it is doing: { kind, name, input }
 * for a tool call (the asst-tool-kinds.js kind), { kind: 'think' } for a
 * thinking block, or null (text, results, stream deltas: nothing new). The
 * stage and the tray keep only compactActivity() of it. OpenCode names its
 * tools bash, read, edit, write, patch, glob, grep, list, webfetch,
 * websearch, codesearch, task, todowrite, and MCP tools `<server>_<tool>`
 * (SynaBun_browser_navigate): kindOf() reads all of them. An Antigravity
 * worker's events are ACP session updates (eventType = their `sessionUpdate`):
 * a tool call when it is announced (`tool_call`, or an update that starts it
 * and names its kind), a thought chunk as thinking, a plan as planning; its
 * message text is no activity, as for the others.
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
  if (provider === 'antigravity') {
    const type = str(payload.eventType || event.sessionUpdate);
    if (type === 'agent_thought_chunk') return { kind: 'think', name: 'thinking', input: {} };
    if (type === 'plan') return { kind: 'plan', name: 'update_plan', input: { todos: Array.isArray(event.entries) ? event.entries : [] } };
    if (type === 'tool_call' || (type === 'tool_call_update' && str(event.kind) && event.status === 'in_progress')) return acpToolActivity(event);
    return null;
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
  const id = activity.kind === 'think' ? 'thinking' : activity.kind;
  return SCENE_ASSET_KEYS.includes(id) ? id : null;
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
  const [key, fallback] = (SCENE_SPECS[scene] || ACTIVITY_SCENE_SPECS[scene] || SCENE_SPECS.generic).label;
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
//
// A scene is an HTML box (`.asst-scene`, sized by its holder) holding one SVG
// of everything that stands still (`.sc-base`) and, for every part that
// moves, an HTML layer of its own (`.sc-layer`: a box over the whole scene
// with an SVG of that part alone in the same viewBox, so the part sits
// exactly where it did). The CSS moves the layer box, transform and opacity
// only, never an SVG element: a box's animation runs on the compositor, and a
// frame the page draws anyway (a rig's) restyles one span and lays nothing
// out, where a moving SVG part re-lays its whole SVG out on every frame.
// Lengths are percentages of the box, since a scene is drawn at several sizes
// (boxPct); a part that turned round its own centre (the SVG's fill-box)
// turns round the same point here (`transform-origin`). Parts on the same
// beat share a layer (the image's tiles); a part that stood above a moving
// one stays above it in a still layer of its own (`.sc-top`: the playhead).

/** Scene art retains its 3:1 ratio in both full and compact placements. */
export const SCENE_BOX = Object.freeze({ full: Object.freeze({ w: 120, h: 40 }), mini: Object.freeze({ w: 40, h: 40 / 3 }) });

/** Decorative art only; status, step and progress remain in the owning stage. */
export function sceneSvg(scene, { mini = false, live = false, className = '' } = {}) {
  const id = SCENE_ASSET_KEYS.includes(scene) ? scene : 'generic';
  const safeClass = String(className).replace(/[^a-zA-Z0-9_ -]/g, '');
  return `<span class="asst-scene${mini ? ' is-mini' : ''}${safeClass ? ` ${safeClass}` : ''}" data-scene="${id}"${live ? ' data-live=""' : ''} aria-hidden="true"><img class="asst-scene-art" src="${sceneAsset(id)}" width="480" height="160" alt="" decoding="async"></span>`;
}

// One observer shares the existing data-live/offscreen lifecycle across rack,
// run stages and tray. Static markup (including history) starts with a PNG.
const sceneVisibility = new WeakMap();
const observedScenes = new Set();
let sceneIntersection = null;
export function syncSceneArt(root = document) {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  for (const el of observedScenes) if (!el.isConnected) { sceneIntersection?.unobserve(el); observedScenes.delete(el); }
  for (const el of root.querySelectorAll('.asst-scene')) {
    if (sceneIntersection && !observedScenes.has(el)) { observedScenes.add(el); sceneIntersection.observe(el); }
    const animated = el.hasAttribute('data-live') && !reduced && !document.hidden
      && !el.closest('[data-offscreen], .ui-interacting, .app-hidden')
      && sceneVisibility.get(el) !== false && el.getClientRects().length > 0;
    const img = el.querySelector('.asst-scene-art');
    const src = sceneAsset(el.dataset.scene, { animated });
    if (img && img.getAttribute('src') !== src) img.setAttribute('src', src);
  }
}
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  if (typeof IntersectionObserver !== 'undefined') sceneIntersection = new IntersectionObserver(entries => {
    for (const entry of entries) sceneVisibility.set(entry.target, entry.isIntersecting);
    syncSceneArt();
  });
  const observer = new MutationObserver(() => syncSceneArt());
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-live', 'data-offscreen', 'class'] });
  document.addEventListener('visibilitychange', () => syncSceneArt());
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener('change', () => syncSceneArt());
}
