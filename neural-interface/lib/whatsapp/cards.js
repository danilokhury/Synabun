// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link: the Assistant's cards as chat messages
// ═══════════════════════════════════════════
//
// Pure. A card is one open request the phone may resolve: the brain's own
// (permission, question, plan, Codex approval, MCP elicitation), a route card,
// a clarify card, or a worker's permission request. On WhatsApp it reads like
// a person asking: a question is one plain message (its options folded into a
// sentence, never a numbered list), an approval is one yes / no question.
//
// A reply is matched deterministically:
//   an approval   "yes" (the whole message) grants it once; "no", "skip",
//                 "cancel" deny it; a route card also takes the name of one of
//                 the models it offered. Nothing else ever grants anything.
//   a question    the owner's text is the answer (an option's name becomes that
//                 option); "skip" declines.
// Whatever is not an answer comes back as { action: 'prompt' }: the bridge
// then closes the card fail-closed and carries on with the message.
// The response is the SAME one the desktop panel would send, built with the
// panel's own helpers (asst-control.js, asst-route.js) — minus everything a
// phone must never grant: "always", updatedPermissions, a remembered route,
// a plan decision other than 'default'.
//
// An approvable tool card shows the whole request exactly as it runs: every
// argument, verbatim, each in a code span (so WhatsApp formatting cannot hide
// a character), never shortened or rewritten. Tool cards the phone cannot
// judge stay on the desktop: a tool a remote session never runs, computer use,
// (a computer tool card; the "control your Mac for this?" request below is
// its own kind and is the phone's to answer),
// a request longer than 600 characters once shown in full, several lines,
// control / bidi / zero-width characters, a backtick (it would end the code
// span), and approvals whose content the phone cannot show (Codex file changes,
// permission grants and input to a running command, MCP tool-call approvals).
// The phone may still deny them.
//
// Computer use at the Ask level is one request of its own kind per turn
// (kind 'computer', raised by the runtime at the first computer tool call):
// "Want me to control your Mac for this? I'll stop when this task is done."
// A plain yes grants it for that turn only; it carries no arguments, so there
// is nothing to show and nothing a reply could change.
//
// One yes, not two: when a route card is for a computer task done here on the
// Assistant's own model, the router marks the option a plain yes approves
// (`route.computer.optionId`) and the card says the Mac will be controlled:
// "…want me to do it on your Mac, here with <model>? I'll control the screen
// until this task is done." A yes to that card is also the computer approval
// (the runtime binds it to the turn that carries the route out). Naming another
// model, or a card without that sentence, approves the route only.

import { CONTROL_KINDS, buildControlResponse, describeToolInput, normalizeAnswers, normalizeControlRequest } from '../../public/shared/assistant/asst-control.js';
import { buildRouteResponse, normalizeRouteRequest, routeOptions } from '../../public/shared/assistant/asst-route.js';
import { isComputerTool, isDeniedRemoteTool } from '../remote-policy.js';

// Codes a person can read out loud: no 0/O, 1/I/L, 2/Z, 5/S, 8/B.
const TAG_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
const REPLY_RE = /^\s*(\d{1,2}(?:\s*,\s*\d{1,2})*)[.)]?\s*([\s\S]*)$/;
// The most a phone card shows of an approvable request (every argument, in full).
const MAX_INPUT_CHARS = 600;
// C0/C1 controls (a newline counts as "several lines"), bidi overrides and isolates, zero-width and other format characters.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const DESKTOP_METHODS = new Set(['item/fileChange/requestApproval', 'item/permissions/requestApproval']);
const CODEX_COMMAND_METHOD = 'item/commandExecution/requestApproval';
// Shown first when present: what the request acts on.
const LEAD_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'filepath', 'notebook_path', 'path', 'url'];

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
function clip(value, max = 160) { const text = clean(value); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

export function randomTag(rng = Math.random) {
  let out = '';
  for (let i = 0; i < 3; i += 1) out += TAG_ALPHABET[Math.floor((Number(rng()) || 0) * TAG_ALPHABET.length) % TAG_ALPHABET.length];
  return out;
}

// A yes is the whole message and nothing else ("yes but only the tests" is not one).
const YES_RE = /^(?:y|yes|yep|yeah|yup|ok|okay|sure|approve|approved|allow|allowed|go ahead|go for it|do it|please do|yes please|sim|s[ií]|oui|ja|👍[\u{1F3FB}-\u{1F3FF}]?)$/iu;
// A no may carry a note ("no, not now"): the note goes with the denial.
const NO_RE = /^(no thanks|no thank you|nope|nah|no|n|deny|denied|decline|declined|n[aã]o|non|nein|👎[\u{1F3FB}-\u{1F3FF}]?)(?=$|[\s,.;:!-])[\s,.;:!-]*([\s\S]*)$/iu;
const trimEnd = (value) => String(value ?? '').trim().replace(/[\s.!…]+$/u, '');

/**
 * A reply to a card: { type:'yes' } | { type:'no'|'skip'|'cancel', rest } | { type:'numbers', numbers, rest }
 * | { type:'text', text }. Deterministic: the same text always reads the same way.
 */
export function parseCardReply(text) {
  const raw = String(text ?? '').trim();
  const numbered = REPLY_RE.exec(raw);
  if (numbered) return { type: 'numbers', numbers: numbered[1].split(',').map((n) => Number(n.trim())), rest: numbered[2].trim() };
  const word = /^(skip|cancel)\b[.!]?\s*([\s\S]*)$/i.exec(raw);
  if (word) return { type: word[1].toLowerCase(), rest: word[2].trim() };
  if (YES_RE.test(trimEnd(raw))) return { type: 'yes', rest: '' };
  const no = NO_RE.exec(raw);
  if (no) return { type: 'no', rest: no[2].trim() };
  return { type: 'text', text: raw };
}

/**
 * A reply that is nothing but an answer: "yes", or "no" / "skip" / "cancel" / option numbers
 * with no other words. "1. Explain the command first" and "no, use staging" say more than
 * that: aimed at a request that is gone, they are the owner's next message, not a late answer.
 */
export function isBareAnswer(text) {
  const parsed = parseCardReply(text);
  if (parsed.type === 'text') return false;
  return parsed.type === 'yes' || !parsed.rest;
}

/** Every string in a value, object keys included (bounded; `overflow` is set past the bound). */
function strings(value, out = [], depth = 0) {
  if (depth > 6) { out.overflow = true; return out; }
  if (out.length > 200) { out.overflow = true; return out; }
  if (value === null || value === undefined) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.push(key); strings(item, out, depth + 1); }
  return out;
}

function inputOf(normalized) {
  return normalized?.input && typeof normalized.input === 'object' ? normalized.input : {};
}

/**
 * The approvable request as [label, text] rows, each text exactly what runs
 * (strings verbatim, anything else as JSON): a Codex command approval is its
 * command and the folder it runs in (plus the network host it asks for);
 * everything else is every argument of the call, what it acts on first.
 */
export function approvalRows(normalized) {
  const input = inputOf(normalized);
  const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value) ?? '');
  if (normalized?.method === CODEX_COMMAND_METHOD) {
    const rows = [['command', text(input.command ?? '')]];
    if (input.cwd !== undefined && input.cwd !== null) rows.push(['cwd', text(input.cwd)]);
    if (input.networkApprovalContext) rows.push(['network', text(input.networkApprovalContext)]);
    return rows;
  }
  const keys = Object.keys(input);
  const ordered = [...LEAD_KEYS.filter((key) => keys.includes(key)), ...keys.filter((key) => !LEAD_KEYS.includes(key))];
  return ordered.filter((key) => input[key] !== undefined && input[key] !== null).map((key) => [key, text(input[key])]);
}

/** Why a tool card must be approved on the desktop, else null. */
export function toolCardDesktopReason(normalized) {
  if (!normalized) return 'unknown request';
  const tool = String(normalized.toolName || '');
  const input = inputOf(normalized);
  if (DESKTOP_METHODS.has(normalized.method)) return 'the phone cannot show what it changes';
  if (normalized.method === CODEX_COMMAND_METHOD && input.kind && input.kind !== 'command') return 'the phone cannot show what it sends to a running command';
  if (isComputerTool(tool)) return 'computer use is not available from WhatsApp';
  if (isDeniedRemoteTool(tool, input)) return 'a WhatsApp session never runs this';
  let rows;
  try { rows = approvalRows(normalized); } catch { return 'the request cannot be shown'; }
  // Every string of the request (keys too), shown or not.
  const values = strings(input);
  if (values.overflow) return 'the request is too long to check on a phone';
  if (values.some((value) => /[\r\n]/.test(value))) return 'the request spans several lines';
  if (values.some((value) => HIDDEN_CHARS.test(value))) return 'the request contains hidden characters';
  const shown = rows.flat();
  if (shown.some((value) => HIDDEN_CHARS.test(value) || /[\r\n]/.test(value))) return 'the request contains hidden characters';
  if (shown.some((value) => value.includes('`'))) return 'the request cannot be shown exactly on a phone';
  if (shown.reduce((sum, value) => sum + value.length, 0) > MAX_INPUT_CHARS) return 'the request is too long to check on a phone';
  return null;
}

function isApprovalElicitation(normalized) {
  if (normalized?.kind !== CONTROL_KINDS.ELICITATION) return false;
  const params = normalized.input || {};
  const meta = params._meta ?? params.meta ?? {};
  return meta.codex_approval_kind === 'mcp_tool_call';
}

/**
 * A card from a runtime packet: a control_request (brain, route, clarify) or a
 * synabun.dispatch_control_request event; null for anything else. `level` is
 * the session's remote level: at read-only a permission, a plan and a route
 * are the desktop's.
 */
export function cardFromPacket(packet, { sessionId = null, level = 'ask', now = Date.now() } = {}) {
  if (!packet || typeof packet !== 'object') return null;
  let normalized = null;
  let source = 'brain';
  let runId = null;
  if (packet.type === 'control_request') {
    normalized = normalizeControlRequest(packet);
    if (normalized?.kind === CONTROL_KINDS.ROUTE) source = 'route';
    else if (normalized?.kind === CONTROL_KINDS.CLARIFY) source = 'clarify';
  } else if (packet.type === 'event' && packet.event?.type === 'synabun.dispatch_control_request') {
    const ev = packet.event;
    runId = ev.runId ? String(ev.runId) : null;
    if (!runId) return null;
    normalized = normalizeControlRequest({ request_id: ev.request_id || ev.request?.requestId, request: ev.request, provider: ev.provider, runId }, { origin: { runId, provider: ev.provider || null } });
    source = 'dispatch';
  } else {
    return null;
  }
  if (!normalized) return null;
  const card = {
    key: `${sessionId || ''}:${source}:${runId || ''}:${normalized.requestId}`,
    source, sessionId, requestId: normalized.requestId, runId, kind: normalized.kind, provider: normalized.provider,
    normalized, route: null, routeChoices: [], questions: [], step: 0, answers: [],
    desktopOnly: null, tag: null, createdAt: now, messageIds: [],
  };
  if (card.kind === CONTROL_KINDS.ROUTE) {
    card.route = normalizeRouteRequest(packet);
    if (!card.route) return null;
    card.routeChoices = routeOptions(card.route).filter((option) => !option.disabled).map((option, index) => ({ ...option, number: index + 1 }));
    if (!card.routeChoices.length) card.desktopOnly = 'no option can be picked from the phone';
    if (level === 'read-only') card.desktopOnly = 'this WhatsApp session is read-only';
  } else if (card.kind === CONTROL_KINDS.QUESTION || card.kind === CONTROL_KINDS.CLARIFY || (card.kind === CONTROL_KINDS.ELICITATION && !isApprovalElicitation(normalized))) {
    card.questions = normalized.questions || [];
    if (!card.questions.length) card.desktopOnly = 'the question cannot be shown';
  } else if (card.kind === CONTROL_KINDS.PLAN) {
    if (level === 'read-only') card.desktopOnly = 'this WhatsApp session is read-only';
  } else if (card.kind === CONTROL_KINDS.COMPUTER) {
    // The runtime raises it only when the level allows; a level lowered since makes it the desktop's.
    if (level === 'read-only') card.desktopOnly = 'this WhatsApp session is read-only';
  } else {
    // A permission (or an approval in the shape of an elicitation).
    card.kind = CONTROL_KINDS.PERMISSION;
    card.desktopOnly = isApprovalElicitation(normalized) ? 'the phone cannot show what it approves' : toolCardDesktopReason(normalized);
    if (!card.desktopOnly && level === 'read-only') card.desktopOnly = 'this WhatsApp session is read-only';
  }
  return card;
}

/**
 * The request's lines. Approvable (desktopOnly null): every argument in full,
 * each in a code span — a lone command as "Tool: `command`". A desktop-only
 * card cannot be approved here, so it names the request in one short line.
 */
function toolLines(card) {
  const normalized = card.normalized || {};
  const tool = String(normalized.toolName || 'a tool');
  if (card.desktopOnly) {
    const detail = clip(normalized.detail || describeToolInput(tool, normalized.input), 160);
    return [detail ? `${tool}: ${detail}` : tool];
  }
  const rows = approvalRows(normalized);
  const code = (value) => (value === '' ? '(empty)' : `\`${value}\``);
  if (!rows.length) return [tool];
  if (rows.length === 1 && (rows[0][0] === 'command' || rows[0][0] === 'cmd')) return [`${tool}: ${code(rows[0][1])}`];
  return [tool, ...rows.map(([key, value]) => `${key}: ${code(value)}`)];
}
// Several open requests (or one right after another was answered elsewhere): a yes names its card.
function tagHint(card) { return card.tag ? `\nMore than one thing is waiting, so add the code ${card.tag} to a yes: "yes ${card.tag}".` : ''; }
const joinOr = (items) => (items.length <= 1 ? (items[0] || '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`);
const isQuestionCard = (card) => card.kind === CONTROL_KINDS.QUESTION || card.kind === CONTROL_KINDS.CLARIFY || card.kind === CONTROL_KINDS.ELICITATION;

/** One question as a person would ask it: its text, then the options folded into a sentence. */
function questionLine(q = {}) {
  const text = clean(q.text || q.header) || 'What would you like?';
  const options = (q.options || []).slice(0, 8).map((option) => `${clean(option.label)}${option.description ? ` (${clip(option.description, 60)})` : ''}`).filter(Boolean);
  if (!options.length) return text;
  return `${text} ${joinOr(options)}${q.multiple ? ' (more than one is fine)' : ''}, or tell me something else.`;
}
/** The questions of a card as one message: one line for one question, a short list for several. */
function questionLines(card, lead, leadMany) {
  const questions = card.questions.length ? card.questions : [{}];
  if (questions.length === 1) return [`${lead}${questionLine(questions[0])}`];
  return [leadMany, ...questions.map((q) => `- ${questionLine(q)}`), 'One message with your answers is fine.'];
}
/** What picking a route choice means, in words: "do it here with Sonnet 5" / "hand it to GPT-6 Sol". */
function choiceName(choice) {
  // The router labels a "here" option "Do it here with <model>": the sentence names the model only.
  const strip = (value) => clean(value).replace(/^do it here with /i, '');
  return strip(choice.label) || strip(choice.title) || 'that model';
}
function routePhrase(choice, { it = 'it', other = false } = {}) {
  if (choice.here) return `do ${it} here with ${choiceName(choice)}`;
  return other ? `use ${choiceName(choice)}` : `hand ${it} to ${choiceName(choice)}`;
}

/**
 * The card as a WhatsApp message, written the way a person asks: a question in
 * one message (never a numbered list), an approval as one yes / no question.
 * `formatPlan` turns the plan's markdown into WhatsApp text.
 */
export function renderCard(card, { formatPlan = (text) => text } = {}) {
  if (!card) return '';
  const n = card.normalized || {};
  if (card.kind === CONTROL_KINDS.ROUTE) {
    const route = card.route || {};
    const [first, ...others] = card.routeChoices;
    const what = clip(route.summary, 160);
    if (!first) return `${what ? `"${what}": ` : ''}I can't take the choice of model for this from the phone. Pick it in SynaBun on your computer, or say no and I'll drop it.`;
    // The option a plain yes approves is the one the router marked: that yes also lets the Assistant control the Mac for this task.
    const mac = routeControlsMac(card);
    const lines = mac
      ? [what ? `For "${what}", want me to do it on your Mac, here with ${choiceName(first)}? ${ROUTE_MAC_SENTENCE} (yes / no)` : `Want me to do this on your Mac, here with ${choiceName(first)}? ${ROUTE_MAC_SENTENCE} (yes / no)`]
      : [what ? `For "${what}", want me to ${routePhrase(first)}? (yes / no)` : `Want me to ${routePhrase(first, { it: 'this' })}? (yes / no)`];
    if (card.desktopOnly) {
      lines[0] = lines[0].replace(' (yes / no)', '');
      lines.push(`I can't take that choice from the phone (${card.desktopOnly}): pick it in SynaBun on your computer, or say no and I'll drop it.`);
      return lines.join('\n');
    }
    if (others.length) lines.push(`I could also ${joinOr(others.slice(0, 4).map((choice) => routePhrase(choice, { other: true })))}: just name it.${mac ? ' Then I ask about the Mac separately.' : ''}`);
    return `${lines.join('\n')}${tagHint(card)}`;
  }
  if (card.kind === CONTROL_KINDS.CLARIFY) {
    const clarify = n.clarify || {};
    const about = clarify.summary ? ` on "${clip(clarify.summary, 120)}"` : '';
    const lines = questionLines(card, `Before I start${about}: `, `Before I start${about}, a few quick questions:`);
    const assumptions = (clarify.assumptions || []).slice(0, 5).map((assumption) => clip(assumption, 160));
    lines.push(assumptions.length ? `Or say "skip" and I'll go with: ${assumptions.join('; ')}.` : 'Or say "skip" and I\'ll go with my best guess.');
    return lines.join('\n');
  }
  if (card.kind === CONTROL_KINDS.QUESTION || card.kind === CONTROL_KINDS.ELICITATION) {
    const worker = card.source === 'dispatch';
    if (card.kind === CONTROL_KINDS.ELICITATION) {
      const tool = clip(n.toolName || 'A tool', 60);
      const lines = [n.message ? `${tool} needs something from you: ${clip(n.message, 300)}` : `${tool} needs something from you.`];
      lines.push(...questionLines(card, '', 'A few things:'));
      return lines.join('\n');
    }
    return questionLines(card, worker ? 'One of the agents is asking: ' : '', worker ? 'One of the agents has a few questions:' : 'A few quick questions:').join('\n');
  }
  if (card.kind === CONTROL_KINDS.PLAN) {
    const plan = String(n.plan || '').trim();
    const lines = ["Here's my plan:"];
    if (plan) lines.push(formatPlan(plan));
    lines.push(card.desktopOnly
      ? `I can't take a yes for the plan from the phone (${card.desktopOnly}): approve it in SynaBun on your computer, or tell me what to change.`
      : `Shall I go ahead? (yes / no, or tell me what to change)${tagHint(card)}`);
    return lines.join('\n');
  }
  if (card.kind === CONTROL_KINDS.COMPUTER) {
    if (card.desktopOnly) return `I'd need to control your Mac for this, and I can't take a yes for that from the phone (${card.desktopOnly}): answer in SynaBun on your computer, or say no and I'll skip it.`;
    return `${COMPUTER_ASK_TEXT}${tagHint(card)}`;
  }
  const worker = card.source === 'dispatch' ? `One of the agents${card.provider && card.provider !== 'claude-code' ? ` (${card.provider})` : ''}` : null;
  const lines = [worker ? `${worker} needs your OK to run this:` : 'I need your OK to run this:', ...toolLines(card)];
  if (n.message && n.message !== n.detail) lines.push(clip(n.message, 200));
  if (card.desktopOnly) lines.push(`I can't take a yes for this one from the phone (${card.desktopOnly}): approve it in SynaBun on your computer, or say no and I'll skip it.`);
  else lines.push(`OK to go ahead? (yes / no)${tagHint(card)}`);
  return lines.join('\n');
}

/** What a route card adds when its yes is also the computer approval (the router's `computer.optionId`). */
export const ROUTE_MAC_SENTENCE = "I'll control the screen until this task is done.";
/**
 * This route card says the Mac will be controlled: the router marked an option
 * (`route.computer.optionId`) and it is the one a plain yes approves here (the
 * first choice), on the phone's own level. Anything else is a plain route card.
 */
export function routeControlsMac(card) {
  const marked = card?.route?.computer?.optionId;
  const first = card?.routeChoices?.[0];
  return !!marked && !!first && !card.desktopOnly && first.id === marked && first.here === true;
}

/** The one question a turn asks before it controls the Mac at the Ask level. "This task" is the turn that asks. */
export const COMPUTER_ASK_TEXT = "Want me to control your Mac for this? I'll stop when this task is done. (yes / no)";
/** What the brain is told when the owner says no to it. */
export const COMPUTER_DECLINED_NOTE = 'The user said no to computer use for this task. Do not retry it or work around it in this task: say what you could not do.';

/** What a phone must never grant, removed from a response the panel's helpers built. */
export function sanitizeResponse(response) {
  if (!response || typeof response !== 'object') return response;
  const out = { ...response };
  delete out.always;
  delete out.updatedPermissions;
  delete out.persist;
  if (out.kind === 'route' && 'remember' in out) out.remember = false;
  if ('planDecision' in out && out.planDecision !== 'default') out.planDecision = 'default';
  return out;
}

function respond(card, response, summary) { return { action: 'respond', response: sanitizeResponse(response), summary }; }
function deny(card, note = '') {
  const message = clean(note);
  if (card.kind === CONTROL_KINDS.ROUTE) return respond(card, buildRouteResponse(card.route, { decline: true }), 'cancelled');
  if (card.kind === CONTROL_KINDS.CLARIFY) return respond(card, buildControlResponse(card.normalized, { behavior: 'deny', message: message || undefined }), 'skipped');
  if (card.kind === CONTROL_KINDS.PLAN) return respond(card, buildControlResponse(card.normalized, { behavior: 'deny', message: message || undefined }), 'keep planning');
  if (card.kind === CONTROL_KINDS.COMPUTER) return respond(card, buildControlResponse(card.normalized, { behavior: 'deny', message: message ? `${COMPUTER_DECLINED_NOTE} They added: ${message}` : COMPUTER_DECLINED_NOTE }), 'denied');
  const fallback = card.kind === CONTROL_KINDS.PERMISSION ? 'Declined on WhatsApp.' : '';
  return respond(card, buildControlResponse(card.normalized, { behavior: 'deny', message: message || fallback || undefined }), card.kind === CONTROL_KINDS.PERMISSION ? 'denied' : 'declined');
}

/**
 * What the brain is told when a card closes because the owner wrote something
 * else instead of answering it. It ends its turn without a closing line ("OK, I
 * won't") but keeps a result it has: the bridge forwards whatever it still says.
 */
export const MOVED_ON_NOTE = 'The user did not answer this on WhatsApp: they sent a new message instead, which you get next. Nothing was approved. Do not retry this or work around it. End your turn now, with no text unless you have a result to report.';

/**
 * Close a card without granting anything (the owner moved on): a denial for a
 * permission, a question or a plan, a cancelled route or clarify round.
 * `superseded` tells the runtime not to treat it as the owner's own "no"
 * (no "route declined" event, no plan revision, no "go with your assumptions").
 */
export function failClosedResponse(card, note = MOVED_ON_NOTE) {
  if (!card) return null;
  if (card.kind === CONTROL_KINDS.ROUTE) return { ...buildRouteResponse(card.route, { decline: true }), superseded: true };
  return { ...sanitizeResponse(buildControlResponse(card.normalized, { behavior: 'deny', message: note })), superseded: true };
}

function stripTag(rest, tag) {
  if (!tag) return { ok: true, rest };
  const re = new RegExp(`(^|\\s)${tag}(?=\\s|$|[.,!])`, 'i');
  if (!re.test(rest)) return { ok: false, rest };
  return { ok: true, rest: rest.replace(re, ' ').trim() };
}

const plain = (value) => clean(value).toLowerCase().replace(/[“”"'`’.,!?;:()]/g, '').replace(/\s+/g, ' ').trim();
/** The option of a question the reply names (its label, as typed or without punctuation), else null. */
function matchOption(options, text) {
  const said = plain(text);
  if (!said) return null;
  const hits = (options || []).filter((option) => plain(option.label) === said);
  return hits.length === 1 ? hits[0] : null;
}
const PICK_LEAD = /^(?:please )?(?:use|with|on|pick|choose|take|try|go with|lets use|lets go with|hand it to|give it to|send it to|run it on|make it) /;
/**
 * The offered route choice a reply names, else null. The reply is the name and
 * nothing else: an optional lead ("use", "go with", "yes,"; "no" only before
 * such a verb) and an optional "please" / "instead". "don't use haiku" names nothing.
 */
function matchRouteChoice(card, text) {
  let said = plain(text);
  if (!said) return null;
  said = said.replace(/^(?:yes|yep|yeah|ok|okay|sure) (?=\S)/, '');
  const afterNo = said.replace(/^(?:no|nope|nah) /, '');
  if (afterNo !== said) { if (!PICK_LEAD.test(afterNo)) return null; said = afterNo; }
  said = said.replace(PICK_LEAD, '').replace(/^the /, '');
  for (let i = 0; i < 3; i += 1) said = said.replace(/ (?:please|instead|then|thanks|model)$/, '');
  if (said.length < 2) return null;
  const names = (choice) => {
    const list = [choice.label, choiceName(choice), choice.model, choice.title, String(choice.model || '').split('/').pop()].map(plain).filter(Boolean);
    if (choice.here) list.push('here', 'do it here', 'do it yourself', 'yourself', 'you do it', `here with ${plain(choice.label)}`);
    return [...new Set(list)];
  };
  const hits = card.routeChoices.filter((choice) => names(choice).some((name) => name === said || (said.length >= 3 && name.startsWith(`${said} `))));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Apply a reply to a card → { action: 'respond', response, summary }
 * | { action: 'invalid', message } (a yes that does not say which of several requests it means)
 * | { action: 'desktop', message } (a yes to something only the desktop may approve)
 * | { action: 'prompt' } (not an answer: the caller closes the card fail-closed and carries on with the message).
 * `quoted`: the reply quotes the card (no code needed). Only "yes" (or the legacy
 * "1"), alone, grants an approval; a route also takes the name of an offered model.
 */
export function answerCard(card, reply, { quoted = false } = {}) {
  if (!card) return { action: 'prompt' };
  const raw = String(typeof reply === 'string' ? reply : (reply?.text ?? '')).trim();
  // The card's code is taken out before the reply is read ("yes K7Q" is a yes).
  const tag = typeof reply === 'string' ? (quoted ? { ok: true, rest: raw } : stripTag(raw, card.tag)) : { ok: true, rest: raw };
  const parsed = typeof reply === 'string' ? parseCardReply(tag.rest) : reply;
  const needTag = () => ({ action: 'invalid', message: `More than one thing is waiting, so say which one you mean: add the code ${card.tag}, like "yes ${card.tag}".` });
  const said = tag.rest || raw;
  const stop = parsed.type === 'skip' || parsed.type === 'cancel';
  if (isQuestionCard(card)) {
    if (card.desktopOnly) return { action: 'prompt' };
    // "Cancel" is an answer when the question offers it; otherwise "skip" / "cancel" decline.
    const named = card.questions.length === 1 && matchOption(card.questions[0].options, said);
    if (stop && !named) return deny(card, parsed.rest);
    return answerQuestions(card, said, parsed);
  }
  // An approval. A denial is always safe, so it never needs the code.
  const numbers = parsed.type === 'numbers' ? parsed.numbers : [];
  if (card.kind === CONTROL_KINDS.ROUTE) {
    if (stop || (parsed.type === 'no' && !parsed.rest)) return deny(card);
    let choice = null;
    if (parsed.type === 'yes') choice = card.routeChoices[0] || null;
    else if (numbers.length === 1 && !parsed.rest) choice = card.routeChoices.find((row) => row.number === numbers[0]) || null;
    // A name, or "no, use <name>". A "no" with anything else goes on as the next prompt (a route's decline carries no note).
    else if (parsed.type === 'text' || parsed.type === 'no') choice = matchRouteChoice(card, said);
    if (!choice && parsed.type !== 'yes') return { action: 'prompt' };
    if (!tag.ok) return needTag();
    if (card.desktopOnly || !choice) return { action: 'desktop', message: 'I can\'t take that choice from the phone: pick it in SynaBun on your computer, or say no and I\'ll drop it.' };
    const onMac = routeControlsMac(card) && choice.id === card.routeChoices[0].id;
    return respond(card, buildRouteResponse(card.route, { optionId: choice.id, remember: false }), onMac ? `doing it on your Mac, here with ${choiceName(choice)}. Esc on the Mac stops me` : choice.here ? `doing it here with ${choiceName(choice)}` : `handing it to ${choiceName(choice)}`);
  }
  if (stop || parsed.type === 'no' || (numbers.length === 1 && numbers[0] === 2)) return deny(card, parsed.rest);
  const yes = parsed.type === 'yes' || (numbers.length === 1 && numbers[0] === 1 && !parsed.rest);
  if (!yes) return { action: 'prompt' };
  if (!tag.ok) return needTag();
  if (card.kind === CONTROL_KINDS.PLAN) {
    if (card.desktopOnly) return { action: 'desktop', message: `I can't take a yes for the plan from the phone (${card.desktopOnly}): approve it in SynaBun on your computer, or tell me what to change.` };
    return respond(card, buildControlResponse(card.normalized, { behavior: 'allow', planDecision: 'default' }), 'approved');
  }
  if (card.desktopOnly) return { action: 'desktop', message: `I can't take a yes for this one from the phone (${card.desktopOnly}): approve it in SynaBun on your computer, or say no and I'll skip it.` };
  // Computer use for this turn: the response carries nothing but the yes.
  if (card.kind === CONTROL_KINDS.COMPUTER) return respond(card, buildControlResponse(card.normalized, { behavior: 'allow' }), 'computer allowed');
  return respond(card, buildControlResponse(card.normalized, { behavior: 'allow' }), 'allowed once');
}

/**
 * The owner's reply as the answers of a question card. One question: the
 * option it names (by its name, or by position for a bare number), else the
 * reply as typed. Several questions: every one gets the reply as typed (an
 * option it names exactly becomes that option), so one message always settles
 * the card and the brain reads it as the reply.
 */
function answerQuestions(card, text, parsed) {
  const reply = String(text ?? '').trim();
  if (!reply) return { action: 'prompt' };
  const questions = card.questions.length ? card.questions : [{}];
  const one = (q) => {
    const named = matchOption(q.options, reply);
    if (named) return [named.label];
    const options = q.options || [];
    if (questions.length === 1 && options.length && parsed?.type === 'numbers' && !parsed.rest) {
      const picked = [...new Set(parsed.numbers)];
      if ((q.multiple || picked.length === 1) && picked.every((num) => num >= 1 && num <= options.length)) return picked.map((num) => options[num - 1].label);
    }
    if (q.multiple && options.length) {
      const parts = reply.split(/\s*(?:,|;|\band\b|&)\s*/i).map((part) => matchOption(options, part)).filter(Boolean);
      if (parts.length > 1 && parts.length === reply.split(/\s*(?:,|;|\band\b|&)\s*/i).length) return [...new Set(parts.map((option) => option.label))];
    }
    return [reply];
  };
  // One list per question, shaped exactly as the panel's answers are.
  const lists = normalizeAnswers(card.normalized, questions.map(one));
  return respond(card, buildControlResponse(card.normalized, { behavior: 'allow', answers: lists }), 'answered');
}
