// ═══════════════════════════════════════════
// SynaBun Assistant — control requests (permissions / questions / plans)
// ═══════════════════════════════════════════
// One card for Claude `control_request`, Codex `server_request` (method +
// params) and OpenCode permission/question relays. The normalize/build pair is
// pure (node:test covers it); `renderControlCard` is the only DOM entry point
// and nothing here touches `document` at import time.
//
// Reply shapes mirror the existing sidepanels:
//   Claude   → cp/cp-permissions.js   { behavior, always, updatedInput, updatedPermissions, message, planDecision }
//   Codex    → cdx/cdx-requests.js    result:{ decision } | result:{ permissions, scope } | result:{ answers } | result:{ action, content }
//   OpenCode → ocp-v2/ocp-v2-render.js reply:'once'|'always'|'reject' | answers:[[label]]
// Every response additionally carries `behavior`, `provider` and `kind` so the
// server-side envelope translator can route without re-deriving them; Codex
// replies repeat `answers` / `content` and OpenCode replies repeat `always` at
// the top level because the server translators and the dispatch relay read
// them there.
//
// Route requests (`subtype:'route'`) are not rendered here: renderControlCard
// hands them to `hooks.renderRoute` (asst-route.js) and never falls back to a
// generic card.
//
// Clarify requests (`subtype:'clarify'`, from agent_clarify) are SynaBun's own
// question card: the brain's 1-3 questions plus the assumptions it will make.
// Submit answers them, Skip lets the brain go on its assumptions; the reply is
// { kind:'clarify', behavior, answers: string[][] } and the server's clarifier
// (lib/assistant-clarify.js) owns it, never the brain.

import { normalizeProvider } from './asst-state.js';
import { sanitizeInto } from './asst-sanitize.js';
import { fill, maskEcho, redactInput } from './asst-tool-kinds.js';
import { mascotSvg, paintMascot, stillFrame } from '../synabun-mascot.js';
import {
  SYNABUN_CHOICE_MARKER,
  SYNABUN_OTHER_VALUE,
  buildSynaBunChoiceContent,
  normalizeSynaBunChoiceElicitation,
} from '../cdx/cdx-protocol.js';

export const CONTROL_KINDS = Object.freeze({
  PERMISSION: 'permission',
  QUESTION: 'question',
  PLAN: 'plan',
  ELICITATION: 'elicitation',
  ROUTE: 'route',
  CLARIFY: 'clarify',
  // "Control your Mac for this?": one per turn of a WhatsApp conversation at the Ask level (the runtime's own request).
  COMPUTER: 'computer',
});

const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const CODEX_INPUT_METHODS = new Set(['item/tool/requestUserInput', 'tool/requestUserInput']);
const CODEX_ELICITATION_METHODS = new Set(['mcpServer/elicitation/request']);

const CODEX_DECISION_LABELS = {
  accept: 'Allow',
  acceptForSession: 'Allow for session',
  acceptWithExecpolicyAmendment: 'Allow + amend exec policy',
  applyNetworkPolicyAmendment: 'Apply network policy',
  decline: 'Decline',
  cancel: 'Cancel turn',
};

function str(v) { return v == null ? '' : String(v).trim(); }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function firstStr(...values) {
  for (const v of values) { const s = str(v); if (s) return s; }
  return '';
}
function firstArr(...values) {
  for (const v of values) if (Array.isArray(v)) return v;
  return null;
}

function decisionName(decision) {
  if (typeof decision === 'string') return decision;
  if (decision && typeof decision === 'object') return Object.keys(decision)[0] || '';
  return '';
}

// ── Questions ───────────────────────────────────────────────────────────────

/** [{ id, text, header, options:[{label, description}], multiple }] from any provider's list. */
export function normalizeQuestions(list) {
  const arr = Array.isArray(list) ? list : (list && typeof list === 'object' ? [list] : []);
  return arr.filter(Boolean).map((q, index) => {
    const text = str(q.question ?? q.text ?? q.prompt ?? q.message);
    const header = str(q.header ?? q.title);
    const options = (Array.isArray(q.options) ? q.options : []).map((opt) => {
      if (typeof opt === 'string') return { label: opt, description: '' };
      return { label: str(opt?.label ?? opt?.value ?? opt?.title), description: str(opt?.description ?? opt?.desc) };
    }).filter(o => o.label);
    return {
      id: str(q.id) || text || header || `question_${index + 1}`,
      text,
      header,
      options,
      multiple: q.multiSelect === true || q.multiple === true,
    };
  });
}

function enumOptions(prop) {
  if (!prop || typeof prop !== 'object') return [];
  if (Array.isArray(prop.enum) && prop.enum.length) {
    const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
    return prop.enum.map((value, i) => ({ label: str(names[i]) || String(value), value, description: '' }));
  }
  const alts = Array.isArray(prop.oneOf) ? prop.oneOf : (Array.isArray(prop.anyOf) ? prop.anyOf : null);
  if (!alts) return [];
  return alts
    .filter(a => a && typeof a === 'object' && ('const' in a || (Array.isArray(a.enum) && a.enum.length)))
    .map((a) => {
      const value = 'const' in a ? a.const : a.enum[0];
      return { label: str(a.title) || String(value), value, description: str(a.description) };
    });
}

/**
 * MCP elicitation `requestedSchema` → question list. Supports `enum`/`enumNames`,
 * `oneOf`/`anyOf` `{ const, title }`, multi-select arrays (`items.enum|anyOf`),
 * booleans and free text. `<id>__other` companion fields are not shown as
 * questions; they become the `otherField` of their base question.
 */
export function elicitationQuestions(schema) {
  const props = obj(schema?.properties) || {};
  const keys = Object.keys(props);
  const required = Array.isArray(schema?.required) ? new Set(schema.required.map(String)) : null;
  const questions = [];
  for (const key of keys) {
    if (/__other$/.test(key)) continue;
    const prop = obj(props[key]) || {};
    const type = Array.isArray(prop.type) ? str(prop.type.find(t => t !== 'null')) : str(prop.type);
    let options = enumOptions(prop);
    let multiple = false;
    if (!options.length && (type === 'array' || obj(prop.items))) {
      options = enumOptions(obj(prop.items));
      multiple = options.length > 0;
    }
    if (!options.length && type === 'boolean') {
      options = [{ label: 'Yes', value: true, description: '' }, { label: 'No', value: false, description: '' }];
    }
    const otherField = keys.includes(`${key}__other`) ? `${key}__other` : null;
    const title = str(prop.title) || key;
    questions.push({
      id: key,
      text: str(prop.description) || title,
      header: title,
      options,
      multiple,
      type: type || 'string',
      required: required ? required.has(key) : true,
      otherField,
      otherValue: otherField ? SYNABUN_OTHER_VALUE : null,
    });
  }
  return questions;
}

// ── Detail text ─────────────────────────────────────────────────────────────

export function describeToolInput(toolName, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const name = str(toolName);
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return str(i.file_path || i.path || i.notebook_path);
  if (name === 'Bash') return str(i.command);
  if (name === 'Glob' || name === 'Grep') return str(i.pattern);
  if (name === 'Agent' || name === 'Task') return str(i.description) || str(i.prompt).slice(0, 120);
  if (name === 'WebFetch' || name === 'WebSearch') return str(i.url || i.query);
  const keys = Object.keys(i);
  if (!keys.length) return '';
  try { return JSON.stringify(i).slice(0, 160); } catch { return ''; }
}

// ── Provider inference ──────────────────────────────────────────────────────

function inferProvider(req, packet) {
  const explicit = normalizeProvider(packet?.provider ?? req?.provider);
  if (explicit) return explicit;
  if (typeof req?.method === 'string' && req.method.includes('/')) return 'codex';
  if (typeof req?.brain_native?.method === 'string' && req.brain_native.method.includes('/')) return 'codex';
  if (req?.subtype === 'can_use_tool' || req?.subtype === 'permission_request' || req?.tool_name) return 'claude-code';
  if (req?.toolName === 'AskUserQuestion' || req?.toolName === 'ExitPlanMode') return 'claude-code';
  if (req?.kind === 'permission' || req?.kind === 'question') return 'opencode';
  if (req?.type === 'permission.asked' || req?.type === 'question.asked') return 'opencode';
  if (req?.sessionID || Array.isArray(req?.patterns) || req?.permission) return 'opencode';
  if (Array.isArray(req?.questions)) return 'opencode';
  return 'claude-code';
}

/**
 * How a card closed unanswered (control_cancelled) reads: 'expired' for a plan
 * card a newer message replaced or that timed out, else 'cancelled'.
 */
export function closedControlState(reason, kind) {
  return reason === 'superseded' || (reason === 'timeout' && kind === CONTROL_KINDS.PLAN) ? 'expired' : 'cancelled';
}

/** True for the runtime's "control your Mac for this task?" request (`subtype:'computer_use'`). */
export function isComputerUseControlPacket(packet) {
  const req = obj(packet?.request) || {};
  return req.subtype === 'computer_use' || req.kind === 'computer_use';
}

/** True for the SynaBun route card (`subtype:'route'` / `kind:'route'`). */
export function isRouteControlPacket(packet) {
  if (!packet || typeof packet !== 'object') return false;
  const req = obj(packet.request) || packet;
  return req.subtype === 'route' || req.kind === 'route';
}

/** True for a SynaBun clarify card (`subtype:'clarify'`, agent_clarify). */
export function isClarifyControlPacket(packet) {
  if (!packet || typeof packet !== 'object') return false;
  const req = obj(packet.request) || packet;
  return req.subtype === 'clarify' || req.kind === 'clarify';
}

// ── Normalize ───────────────────────────────────────────────────────────────

/**
 * Normalize any control packet into:
 * { requestId, provider, kind, toolName, title, detail, input, suggestions,
 *   questions, rawQuestions, decisions, plan, message, patterns, origin, raw }
 * `origin` = { runId, provider } for relayed dispatch requests. Route requests
 * normalize to kind 'route' with the raw request under `route`.
 */
export function normalizeControlRequest(packet, { origin = null } = {}) {
  if (!packet || typeof packet !== 'object') return null;
  const req = obj(packet.request) || packet;
  const requestId = packet.request_id ?? packet.requestId ?? req.request_id ?? req.requestId ?? req.id ?? packet.id;
  if (requestId == null || requestId === '') return null;

  const base = {
    requestId: String(requestId),
    provider: 'claude-code',
    kind: CONTROL_KINDS.PERMISSION,
    toolName: '',
    title: '',
    detail: '',
    input: {},
    suggestions: [],
    questions: [],
    rawQuestions: null,
    decisions: [],
    plan: '',
    message: '',
    patterns: [],
    method: '',
    origin: null,
    raw: packet,
  };

  if (isRouteControlPacket(packet)) {
    return { ...base, provider: 'synabun', kind: CONTROL_KINDS.ROUTE, toolName: 'route', title: 'Route this request', detail: str(req.summary), input: req, route: req };
  }
  if (isClarifyControlPacket(packet)) {
    const rawQuestions = Array.isArray(req.questions) ? req.questions : [];
    const assumptions = (Array.isArray(req.assumptions) ? req.assumptions : []).map(str).filter(Boolean);
    return {
      ...base, provider: 'synabun', kind: CONTROL_KINDS.CLARIFY, toolName: 'agent_clarify', title: 'Before I start',
      detail: str(req.summary), message: str(req.summary), input: req, rawQuestions, questions: normalizeQuestions(rawQuestions),
      clarify: { briefId: str(req.briefId), summary: str(req.summary), assumptions },
    };
  }

  if (isComputerUseControlPacket(packet)) {
    const channel = str(req.channel) || 'whatsapp';
    return {
      ...base, provider: 'synabun', kind: CONTROL_KINDS.COMPUTER, toolName: 'computer_use', title: 'Control your Mac?',
      detail: 'Asked on the owner’s phone, from a WhatsApp conversation. Only a yes from that phone lets the assistant use the mouse and keyboard, until this task ends. You can deny it here.',
      input: {}, computer: { channel, level: str(req.level), reason: str(req.reason) },
    };
  }

  const provider = inferProvider(req, packet);
  base.provider = provider;
  base.origin = origin || (packet.runId ? { runId: packet.runId, provider } : null);

  // A plan card is ExitPlanMode's whichever brain planned (the runtime asks for Codex and OpenCode plans).
  if (firstStr(req.tool_name, req.toolName) === 'ExitPlanMode') return normalizeClaude(req, base);
  if (provider === 'codex') return normalizeCodex(req, base);
  if (provider === 'opencode') return normalizeOpenCode(req, base);
  return normalizeClaude(req, base);
}

function normalizeClaude(req, base) {
  const toolName = firstStr(req.tool_name, req.toolName) || 'Unknown';
  const input = obj(req.input) || {};
  const suggestions = firstArr(req.suggestions, req.permission_suggestions) || [];
  const topQuestions = Array.isArray(req.questions) && req.questions.length ? req.questions : null;
  const relayedQuestion = req.kind === 'question' || req.kind === 'ask';
  if (toolName === 'AskUserQuestion' || relayedQuestion || topQuestions) {
    const rawQuestions = topQuestions
      || (Array.isArray(input.questions) ? input.questions : (input.question || input.text || input.options ? [input] : []));
    return {
      ...base,
      kind: CONTROL_KINDS.QUESTION,
      toolName: toolName === 'Unknown' ? 'AskUserQuestion' : toolName,
      title: 'Question',
      input,
      rawQuestions,
      questions: normalizeQuestions(rawQuestions),
    };
  }
  if (toolName === 'ExitPlanMode') {
    return { ...base, kind: CONTROL_KINDS.PLAN, toolName, title: 'Plan ready', input, plan: str(input.plan) };
  }
  return {
    ...base,
    kind: CONTROL_KINDS.PERMISSION,
    toolName,
    title: 'Permission required',
    detail: describeToolInput(toolName, input),
    input,
    suggestions,
  };
}

function normalizeCodex(req, base) {
  const method = firstStr(req.method, req.brain_native?.method);
  // Server packets keep the full app-server params under brain_native.params;
  // `input` is the card-friendly subset.
  const params = obj(req.params) || obj(req.brain_native?.params) || obj(req.input) || {};
  if (!method) return normalizeClaude(req, base); // relayed broker request: { kind, toolName, input, questions }
  const available = Array.isArray(params.availableDecisions) && params.availableDecisions.length
    ? params.availableDecisions
    : (Array.isArray(req.brain_native?.availableDecisions) && req.brain_native.availableDecisions.length ? req.brain_native.availableDecisions : null);
  const decisions = available || ['accept', 'acceptForSession', 'decline', 'cancel'];

  if (method === 'item/commandExecution/requestApproval') {
    return { ...base, method, kind: CONTROL_KINDS.PERMISSION, toolName: 'Bash', title: 'Command approval', detail: str(params.command), message: str(params.reason), input: params, decisions };
  }
  if (method === 'item/fileChange/requestApproval') {
    const detail = [params.grantRoot ? `root ${params.grantRoot}` : '', params.itemId ? `item ${params.itemId}` : ''].filter(Boolean).join(' · ');
    return { ...base, method, kind: CONTROL_KINDS.PERMISSION, toolName: 'Edit', title: 'File change approval', detail, message: str(params.reason), input: params, decisions };
  }
  if (method === 'item/permissions/requestApproval') {
    const permissions = obj(params.permissions) || {};
    let detail = '';
    try { detail = JSON.stringify(permissions).slice(0, 160); } catch { /* ignore */ }
    return { ...base, method, kind: CONTROL_KINDS.PERMISSION, toolName: 'Permissions', title: 'Permission grant', detail, message: str(params.reason), input: permissions, decisions: ['session', 'always', 'decline'] };
  }
  if (CODEX_INPUT_METHODS.has(method)) {
    const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
    return { ...base, method, kind: CONTROL_KINDS.QUESTION, toolName: 'requestUserInput', title: 'Codex needs input', input: params, rawQuestions, questions: normalizeQuestions(rawQuestions) };
  }
  if (CODEX_ELICITATION_METHODS.has(method)) {
    const message = str(params.message);
    const serverName = firstStr(params.serverName, params.server) || 'MCP';
    if (message.startsWith(SYNABUN_CHOICE_MARKER)) {
      // SynaBun `choice` tool: the marker carries the question set as JSON.
      const choice = normalizeSynaBunChoiceElicitation(params);
      if (choice) {
        const questions = choice.questions.map(q => ({
          id: q.id,
          text: q.question,
          header: q.header,
          options: q.options.map(o => ({ label: o.label, description: o.description, value: o.value })),
          multiple: false,
          type: 'string',
          required: true,
          otherField: q._synabunMcp?.otherField || `${q.id}__other`,
          otherValue: q._synabunMcp?.otherValue || SYNABUN_OTHER_VALUE,
        }));
        return { ...base, method, kind: CONTROL_KINDS.ELICITATION, toolName: serverName, title: 'Input requested', message: '', input: params, questions, rawQuestions: choice.questions, synabunChoice: choice };
      }
    }
    const questions = elicitationQuestions(params.requestedSchema);
    return {
      ...base,
      method,
      kind: CONTROL_KINDS.ELICITATION,
      toolName: serverName,
      title: 'Input requested',
      // Never print the raw choice marker, even when its JSON failed to parse.
      message: message.startsWith(SYNABUN_CHOICE_MARKER) ? '' : message,
      input: params,
      questions,
      rawQuestions: questions,
    };
  }
  let detail = '';
  try { detail = JSON.stringify(params).slice(0, 160); } catch { /* ignore */ }
  return { ...base, method, kind: CONTROL_KINDS.PERMISSION, toolName: method || 'request', title: 'Codex request', detail, input: params, decisions: CODEX_APPROVAL_METHODS.has(method) ? decisions : ['accept', 'decline'] };
}

function normalizeOpenCode(req, base) {
  const input = obj(req.input) || {};
  const nested = obj(req.question);
  const questionList = firstArr(nested?.questions, req.questions, input.questions);
  const isQuestion = req.kind === 'question' || req.kind === 'ask' || req.type === 'question.asked'
    || Array.isArray(nested?.questions)
    || (Array.isArray(req.questions) && !req.permission && !req.patterns)
    || (req.kind !== 'permission' && Array.isArray(input.questions) && !input.permission);
  if (isQuestion) {
    const rawQuestions = questionList || [];
    return { ...base, kind: CONTROL_KINDS.QUESTION, toolName: 'question', title: 'Question', input: nested || input, rawQuestions, questions: normalizeQuestions(rawQuestions) };
  }
  // Brain packets: { tool_name, input:{ title, patterns, metadata, always } };
  // relays: { toolName, input: <native event> }; legacy: { permission:{...} }.
  const perm = obj(req.permission) || (input.permission || input.patterns || input.metadata || input.title ? input : null) || req;
  const toolName = firstStr(req.tool_name, req.toolName, typeof perm.permission === 'string' ? perm.permission : '', perm.type, req.tool?.name, typeof req.tool === 'string' ? req.tool : '').toLowerCase() || 'permission';
  const patterns = (firstArr(perm.patterns, input.patterns, req.patterns) || (perm.pattern ? [perm.pattern] : [])).filter(Boolean).map(String);
  const metadata = obj(perm.metadata) || obj(input.metadata) || obj(req.metadata) || {};
  const title = firstStr(perm.title, input.title, req.title, perm.message);
  const detail = firstStr(metadata.command, metadata.filepath, metadata.filePath, metadata.path, metadata.url) || patterns.join(', ') || title;
  return {
    ...base,
    kind: CONTROL_KINDS.PERMISSION,
    toolName,
    title: 'Permission required',
    detail,
    input: { ...metadata, patterns },
    patterns,
    message: title,
  };
}

// ── Answers ─────────────────────────────────────────────────────────────────

/**
 * Normalize user answers into one string[] per question.
 * Accepts: [[label]] (per question), [label] (one per question), or
 * { [questionId|text]: label | label[] }.
 */
export function normalizeAnswers(normalized, answers) {
  const questions = normalized?.questions || [];
  const out = questions.map(() => []);
  const toList = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])).map(x => String(x));
  if (Array.isArray(answers)) {
    answers.forEach((entry, i) => { if (i < out.length) out[i] = toList(entry); });
    return out;
  }
  if (answers && typeof answers === 'object') {
    questions.forEach((q, i) => {
      const hit = answers[q.id] ?? answers[q.text] ?? answers[q.header];
      out[i] = toList(hit);
    });
  }
  return out;
}

function findOption(q, answer) {
  return (q.options || []).find(o => o.label === answer || (o.value != null && String(o.value) === answer)) || null;
}

function coerceAnswer(answer, type) {
  if (type === 'number' || type === 'integer') {
    const n = Number(answer);
    if (answer !== '' && Number.isFinite(n)) return type === 'integer' ? Math.trunc(n) : n;
  }
  if (type === 'boolean') return /^(true|yes|1|on)$/i.test(String(answer));
  return answer;
}

/**
 * Elicitation `content` from per-question answer lists. Option labels map back
 * to their schema values; a typed answer on an enum question becomes
 * `'__synabun_other__'` plus `<id>__other: text` when the schema offers one.
 */
export function elicitationContent(questions, lists) {
  const content = {};
  (questions || []).forEach((q, i) => {
    const list = (lists && lists[i]) || [];
    if (!list.length) return;
    if (q.multiple) {
      const values = [];
      const custom = [];
      for (const answer of list) {
        const opt = findOption(q, answer);
        if (opt) values.push(opt.value ?? opt.label);
        else custom.push(answer);
      }
      if (custom.length && q.otherField) {
        values.push(q.otherValue || SYNABUN_OTHER_VALUE);
        content[q.otherField] = custom.join(', ');
      } else {
        values.push(...custom);
      }
      content[q.id] = values;
      return;
    }
    const answer = list[0];
    const opt = findOption(q, answer);
    if (opt) { content[q.id] = opt.value ?? opt.label; return; }
    if (q.options?.length && q.otherField) {
      content[q.id] = q.otherValue || SYNABUN_OTHER_VALUE;
      content[q.otherField] = answer;
      return;
    }
    content[q.id] = coerceAnswer(answer, q.type);
  });
  return content;
}

// ── Build response ──────────────────────────────────────────────────────────

/**
 * decision: { behavior:'allow'|'deny', always?, updatedInput?, message?, answers?,
 *             planDecision?:'default'|'acceptEdits', decisionId?, updatedPermissions? }
 */
export function buildControlResponse(normalized, decision = {}) {
  if (!normalized) return null;
  if (normalized.kind === CONTROL_KINDS.ROUTE) return null; // asst-route.js builds route answers
  if (normalized.kind === CONTROL_KINDS.CLARIFY) {
    // One answer list per question, in order; Skip carries an optional note.
    const allow = decision.behavior !== 'deny';
    const out = { kind: CONTROL_KINDS.CLARIFY, provider: 'synabun', behavior: allow ? 'allow' : 'deny' };
    if (allow) out.answers = normalizeAnswers(normalized, decision.answers);
    const note = str(decision.message);
    if (note) out.message = note;
    return out;
  }
  if (normalized.kind === CONTROL_KINDS.COMPUTER) {
    // A yes or a no for this turn, nothing else: never "always", never rules, never edited input.
    // (The yes counts only when the WhatsApp bridge sends it: the runtime refuses it from a socket.)
    const out = { kind: CONTROL_KINDS.COMPUTER, provider: 'synabun', behavior: decision.behavior === 'allow' ? 'allow' : 'deny' };
    const note = str(decision.message);
    if (out.behavior === 'deny' && note) out.message = note;
    return out;
  }
  const allow = decision.behavior !== 'deny';
  const always = decision.always === true;
  const base = { behavior: allow ? 'allow' : 'deny', provider: normalized.provider, kind: normalized.kind };
  const message = str(decision.message);
  if (message) base.message = message;
  if (normalized.kind === CONTROL_KINDS.PLAN) return buildClaude(normalized, decision, base, allow, always);
  if (normalized.provider === 'codex') return buildCodex(normalized, decision, base, allow, always);
  if (normalized.provider === 'opencode') return buildOpenCode(normalized, decision, base, allow, always);
  return buildClaude(normalized, decision, base, allow, always);
}

function buildClaude(n, decision, base, allow, always) {
  if (n.kind === CONTROL_KINDS.QUESTION) {
    if (!allow) return { ...base, message: base.message || 'User declined to answer' };
    const lists = normalizeAnswers(n, decision.answers);
    const answers = {};
    n.questions.forEach((q, i) => { answers[q.text || q.id] = lists[i].join(', '); });
    return { ...base, behavior: 'allow', updatedInput: { questions: n.rawQuestions || [], answers } };
  }
  if (n.kind === CONTROL_KINDS.PLAN) {
    if (!allow) return { ...base, message: base.message || 'Keep planning — revise the plan.' };
    return { ...base, planDecision: decision.planDecision === 'acceptEdits' ? 'acceptEdits' : 'default' };
  }
  if (!allow) return base;
  const out = { ...base, always };
  if (decision.updatedInput && typeof decision.updatedInput === 'object') out.updatedInput = decision.updatedInput;
  if (Array.isArray(decision.updatedPermissions) && decision.updatedPermissions.length) out.updatedPermissions = decision.updatedPermissions;
  return out;
}

function pickCodexDecision(decisions, { allow, always, decisionId }) {
  const names = decisions.map(decisionName);
  const find = (name) => decisions[names.indexOf(name)];
  if (decisionId && names.includes(decisionId)) return find(decisionId);
  if (allow) {
    const order = always
      ? ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment', 'acceptForSession', 'accept']
      : ['accept', 'acceptForSession'];
    for (const name of order) if (names.includes(name)) return find(name);
    return decisions.find(d => !/^(decline|cancel)$/.test(decisionName(d))) ?? 'accept';
  }
  for (const name of ['decline', 'cancel']) if (names.includes(name)) return find(name);
  return 'decline';
}

function buildCodex(n, decision, base, allow, always) {
  if (n.method === 'item/permissions/requestApproval') {
    if (!allow) return { ...base, result: { permissions: {}, scope: 'turn' } };
    return { ...base, result: { permissions: n.input || {}, scope: 'session' }, persist: always ? 'always' : null };
  }
  if (n.kind === CONTROL_KINDS.QUESTION) {
    if (!allow) return { ...base, error: { code: -1, message: base.message || 'User declined' } };
    const lists = normalizeAnswers(n, decision.answers);
    const answers = {};
    n.questions.forEach((q, i) => { if (lists[i].length) answers[q.id] = { answers: lists[i] }; });
    return { ...base, behavior: 'allow', answers, result: { answers } };
  }
  if (n.kind === CONTROL_KINDS.ELICITATION) {
    if (!allow) return { ...base, result: { action: 'decline', content: null, _meta: {} } };
    const lists = normalizeAnswers(n, decision.answers);
    let content;
    if (n.synabunChoice) {
      const answers = {};
      n.questions.forEach((q, i) => { if (lists[i].length) answers[q.id] = { answers: [lists[i][0]] }; });
      content = buildSynaBunChoiceContent(n.synabunChoice.questions, answers);
    } else {
      content = elicitationContent(n.questions, lists);
    }
    if (typeof decision.text === 'string' && decision.text.trim()) content.text = decision.text.trim();
    return { ...base, answers: content, content, result: { action: 'accept', content, _meta: {} } };
  }
  const picked = pickCodexDecision(n.decisions || [], { allow, always, decisionId: decision.decisionId });
  return { ...base, decision: decisionName(picked), result: { decision: picked } };
}

function buildOpenCode(n, decision, base, allow, always) {
  if (n.kind === CONTROL_KINDS.QUESTION) {
    if (!allow) return { ...base, reject: true };
    return { ...base, behavior: 'allow', answers: normalizeAnswers(n, decision.answers) };
  }
  const out = { ...base, reply: allow ? (always ? 'always' : 'once') : 'reject' };
  if (allow && always) out.always = true;
  return out;
}

/** Human labels for the primary/secondary buttons of a normalized request. */
export function controlActions(normalized) {
  const n = normalized;
  if (!n) return [];
  if (n.kind === CONTROL_KINDS.ROUTE) return [];
  if (n.kind === CONTROL_KINDS.CLARIFY) {
    return [
      { id: 'submit', label: 'Submit', decision: { behavior: 'allow' }, tone: 'primary', submit: true },
      { id: 'skip', label: 'Skip — go with the assumptions', decision: { behavior: 'deny' }, tone: 'secondary', needsMessage: true },
    ];
  }
  if (n.kind === CONTROL_KINDS.PLAN) {
    return [
      { id: 'approve-edits', label: 'Approve & auto-accept edits', decision: { behavior: 'allow', planDecision: 'acceptEdits' }, tone: 'primary' },
      { id: 'approve', label: 'Approve', decision: { behavior: 'allow', planDecision: 'default' }, tone: 'secondary' },
      { id: 'keep', label: 'Keep planning', decision: { behavior: 'deny' }, tone: 'secondary', needsMessage: true },
    ];
  }
  if (n.kind === CONTROL_KINDS.QUESTION || n.kind === CONTROL_KINDS.ELICITATION) {
    return [
      { id: 'submit', label: 'Submit', decision: { behavior: 'allow' }, tone: 'primary', submit: true },
      { id: 'decline', label: 'Decline', decision: { behavior: 'deny' }, tone: 'danger' },
    ];
  }
  // Controlling the Mac from a WhatsApp conversation is granted on the owner's phone only: the desktop can deny it.
  if (n.kind === CONTROL_KINDS.COMPUTER) {
    return [
      { id: 'deny', label: 'Deny', decision: { behavior: 'deny' }, tone: 'danger' },
    ];
  }
  const actions = [];
  const canAlways = n.provider === 'claude-code'
    || n.provider === 'opencode'
    || (n.provider === 'codex' && (n.method === 'item/permissions/requestApproval'
      || (n.decisions || []).some(d => /^(acceptForSession|acceptWithExecpolicyAmendment|applyNetworkPolicyAmendment)$/.test(decisionName(d)))));
  actions.push({ id: 'allow', label: 'Allow', decision: { behavior: 'allow' }, tone: 'primary' });
  if (canAlways) actions.push({ id: 'always', label: 'Always', decision: { behavior: 'allow', always: true }, tone: 'secondary' });
  actions.push({ id: 'deny', label: 'Deny', decision: { behavior: 'deny' }, tone: 'danger', needsMessage: true });
  return actions;
}

export { CODEX_DECISION_LABELS, decisionName };

// ═══════════════════════════════════════════
// DOM — the card
// ═══════════════════════════════════════════

const ICON_CHECK = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>';
const ICON_X = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Render a control card into `container` (or return it detached when the
 * container is null so the renderer can place it before "Working…").
 * hooks: { t(key, params), md(text), providerIcon(provider), onRespond(normalized, decision), scrollEnd(),
 *          renderRoute(container, normalized, hooks) → route card entry }
 * Returns { el, lock(label), resolved }.
 */
export function renderControlCard(container, normalized, hooks = {}) {
  const n = normalized;
  if (!n) return null;
  if (n.kind === CONTROL_KINDS.ROUTE) {
    // Never degrade a route request into a generic permission card.
    return typeof hooks.renderRoute === 'function' ? hooks.renderRoute(container, n, hooks) : null;
  }
  const t = (key, fallback, params) => {
    const v = typeof hooks.t === 'function' ? hooks.t(key, params) : undefined;
    return v && v !== key && typeof v === 'string' ? v : fallback;
  };
  const card = el('div', 'asst-control active');
  card.dataset.kind = n.kind;
  card.dataset.requestId = n.requestId;
  card.dataset.provider = n.provider;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', t(`assistant.control.${n.kind}`, n.title || n.kind));

  const head = el('div', 'asst-control-head');
  const kindLabel = el('span', 'asst-control-kind', t(`assistant.control.${n.kind}`, n.title || n.kind));
  head.appendChild(kindLabel);
  decorateControlHead(head, kindLabel);
  if (n.origin?.runId) {
    const badge = el('span', 'asst-control-origin');
    // xs capsule: the provider glyph · seam · where it came from.
    badge.innerHTML = `${hooks.providerIcon ? `<span class="asst-icon" aria-hidden="true">${hooks.providerIcon(n.origin.provider || n.provider)}</span>` : ''}<span>${escapeHtml(t('assistant.control.relayed', 'from run {id}', { id: String(n.origin.runId).slice(0, 8) }))}</span>`;
    head.appendChild(badge);
  }
  const status = el('span', 'asst-control-status');
  status.hidden = true;
  head.appendChild(status);
  card.appendChild(head);

  const body = el('div', 'asst-control-body');
  card.appendChild(body);

  const state = { resolved: false, answers: n.questions.map(() => ({ selected: new Set(), custom: '' })), bashInput: null, denyMsg: null, checkedSuggestions: new Set() };

  if (n.kind === CONTROL_KINDS.PERMISSION) renderPermissionBody(body, n, state, t);
  else if (n.kind === CONTROL_KINDS.COMPUTER) body.appendChild(el('div', 'asst-control-message', t('assistant.control.computerBody', n.detail)));
  else if (n.kind === CONTROL_KINDS.PLAN) renderPlanBody(body, n, hooks);
  else renderQuestionBody(body, n, state, t);

  const actions = el('div', 'asst-control-actions');
  const denyMsg = el('textarea', 'asst-control-deny-msg');
  denyMsg.placeholder = n.kind === CONTROL_KINDS.PLAN
    ? t('assistant.control.planFeedback', 'Request changes… (sent with "Keep planning")')
    : n.kind === CONTROL_KINDS.CLARIFY
      ? t('assistant.control.skipNote', 'Anything the assistant should know (optional)…')
      : t('assistant.control.denyReason', 'Tell the agent why (optional)…');
  denyMsg.setAttribute('aria-label', denyMsg.placeholder);
  denyMsg.rows = 1;
  denyMsg.hidden = n.kind !== CONTROL_KINDS.PLAN;
  denyMsg.addEventListener('keydown', (e) => e.stopPropagation());
  state.denyMsg = denyMsg;

  const buttons = [];
  const finish = (label) => {
    state.resolved = true;
    card.classList.remove('active');
    card.classList.add('resolved');
    buttons.forEach(b => { b.disabled = true; });
    // Show / Hide of the typed values keeps working on an answered card.
    card.querySelectorAll('button, input, textarea').forEach(node => { if (!node.classList?.contains('asst-reveal')) node.disabled = true; });
    status.textContent = label;
    status.hidden = false;
  };

  for (const action of controlActions(n)) {
    const btn = el('button', `asst-btn asst-btn-${action.tone}`);
    btn.type = 'button';
    btn.dataset.action = action.id;
    const icon = action.decision.behavior === 'deny' ? ICON_X : ICON_CHECK;
    btn.innerHTML = `<span class="asst-btn-icon" aria-hidden="true">${icon}</span><span class="asst-btn-label">${escapeHtml(t(`assistant.control.action.${action.id}`, action.label))}</span>`;
    if (action.submit) {
      btn.disabled = true;
      state.submitBtn = btn;
    }
    if (action.needsMessage) {
      btn.addEventListener('mouseenter', () => { denyMsg.hidden = false; });
      btn.addEventListener('focus', () => { denyMsg.hidden = false; });
    }
    btn.addEventListener('click', () => {
      if (state.resolved) return;
      const decision = { ...action.decision };
      if (decision.behavior === 'deny' && denyMsg.value.trim()) decision.message = denyMsg.value.trim();
      if (n.kind === CONTROL_KINDS.PERMISSION && decision.behavior === 'allow') {
        if (state.bashInput && state.bashInput.value.trim() && state.bashInput.value !== (n.input?.command || '')) {
          decision.updatedInput = { ...n.input, command: state.bashInput.value };
        }
        if (state.checkedSuggestions.size) decision.updatedPermissions = [...state.checkedSuggestions].map(idx => n.suggestions[idx]);
      }
      if (n.kind === CONTROL_KINDS.QUESTION || n.kind === CONTROL_KINDS.ELICITATION || n.kind === CONTROL_KINDS.CLARIFY) {
        decision.answers = state.answers.map(a => (a.custom ? [a.custom] : [...a.selected]));
      }
      if (n.kind === CONTROL_KINDS.CLARIFY) {
        finish(decision.behavior === 'allow' ? t('assistant.control.state.answered', 'Answered') : t('assistant.control.state.skipped', 'Skipped'));
      } else {
        finish(decision.behavior === 'allow'
          ? (decision.always ? t('assistant.control.state.always', 'Always') : t('assistant.control.state.allowed', 'Allowed'))
          : t('assistant.control.state.denied', 'Denied'));
      }
      hooks.onRespond?.(n, decision);
    });
    buttons.push(btn);
    actions.appendChild(btn);
  }
  state.updateSubmit = () => {
    if (!state.submitBtn) return;
    const needed = n.questions.map((q, i) => ({ q, i })).filter(({ q }) => q.required !== false);
    const answered = needed.filter(({ i }) => state.answers[i].custom || state.answers[i].selected.size).length;
    state.submitBtn.disabled = needed.length > 0 && answered < needed.length;
    const label = state.submitBtn.querySelector('.asst-btn-label');
    const text = needed.length > 1
      ? `${t('assistant.control.action.submit', 'Submit')} (${answered}/${needed.length})`
      : t('assistant.control.action.submit', 'Submit');
    if (label) label.textContent = text; else state.submitBtn.textContent = text;
  };
  state.updateSubmit();

  card.appendChild(denyMsg);
  card.appendChild(actions);
  if (container) container.appendChild(card);
  try { hooks.scrollEnd?.(); } catch { /* ignore */ }

  return {
    el: card,
    get resolved() { return state.resolved; },
    lock(label) { if (!state.resolved) finish(label || t('assistant.control.state.resolved', 'Resolved')); },
    // Answered here, but the request closed before the answer reached it: the answer did nothing.
    expire(label) { finish(label || t('assistant.control.state.expired', 'Expired')); card.classList.add('expired'); },
  };
}

/**
 * A card that waits on the user says so the same way everywhere (this card,
 * the route card): a still blocked cameo before its kind, which the
 * stylesheet draws as a capsule with a ◆ glyph half (generated content, so
 * the kind's own text stays what it was).
 */
export function decorateControlHead(head, kindEl) {
  if (!head || !kindEl) return;
  const face = el('span', 'asst-control-face');
  face.setAttribute('aria-hidden', 'true');
  try {
    face.innerHTML = mascotSvg({ width: 28, height: 14, className: 'synabun-mascot asst-still' });
    if (face.firstElementChild) paintMascot(face.firstElementChild, stillFrame('blocked'));
  } catch { /* no SVG here (a test DOM): the capsule says it */ }
  if (typeof head.insertBefore === 'function') head.insertBefore(face, kindEl);
  else head.appendChild(face);
}

function renderPermissionBody(body, n, state, t) {
  const line = el('div', 'asst-control-tool');
  line.appendChild(el('span', 'asst-control-tool-name', n.toolName || 'tool'));
  if (n.message) line.appendChild(el('span', 'asst-control-tool-note', n.message));
  body.appendChild(line);

  // What the call would type (browser_type / fill, a desktop type) and any credential stay masked
  // until this card's Show; the detail line masks the same values wherever it repeats them.
  const tf = (key, fallback, params) => fill(t(key, fallback, params), params);
  const red = redactInput(n.toolName, n.input, tf);
  let shown = false;
  const paints = [];

  if (n.toolName === 'Bash' && typeof n.input?.command === 'string') {
    const box = el('div', 'asst-control-preview');
    box.appendChild(el('div', 'asst-control-preview-label', t('assistant.control.commandEditable', 'Command (editable)')));
    const ta = el('textarea', 'asst-control-cmd');
    ta.value = n.input.command;
    ta.rows = Math.min(6, Math.max(2, n.input.command.split('\n').length));
    ta.spellcheck = false;
    ta.setAttribute('aria-label', t('assistant.control.commandEditable', 'Command (editable)'));
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    box.appendChild(ta);
    if (n.input.description) box.appendChild(el('div', 'asst-control-desc', String(n.input.description)));
    state.bashInput = ta;
    body.appendChild(box);
  } else if (n.detail) {
    const pre = el('pre', 'asst-control-detail');
    paints.push(() => { pre.textContent = shown ? n.detail : maskEcho(n.detail, red.hidden, tf); });
    body.appendChild(pre);
  }

  const keys = Object.keys(n.input || {}).filter(k => k !== 'command' && k !== 'description' && k !== 'patterns');
  if (keys.length && n.toolName !== 'Bash') {
    const kv = el('div', 'asst-control-kv');
    const text = (v) => {
      let s = v;
      if (typeof s === 'object') { try { s = JSON.stringify(s); } catch { s = String(s); } }
      s = String(s ?? '');
      return s.length > 200 ? `${s.slice(0, 200).trimEnd()}…` : s;
    };
    for (const k of keys.slice(0, 8)) {
      const row = el('div', 'asst-control-kv-row');
      row.appendChild(el('span', 'asst-control-kv-key', k));
      const val = el('span', 'asst-control-kv-val');
      paints.push(() => { val.textContent = text(shown ? n.input[k] : red.input[k]); });
      row.appendChild(val);
      kv.appendChild(row);
    }
    body.appendChild(kv);
  }
  const paint = () => paints.forEach(fn => fn());
  paint();
  if (red.hidden.length && paints.length) {
    const reveal = el('button', 'asst-reveal', t('assistant.rack.show', 'Show'));
    reveal.type = 'button';
    reveal.setAttribute('aria-pressed', 'false');
    reveal.setAttribute('aria-label', t('assistant.rack.showValues', 'Show typed values'));
    reveal.addEventListener('click', () => {
      shown = !shown;
      reveal.textContent = shown ? t('assistant.rack.hide', 'Hide') : t('assistant.rack.show', 'Show');
      reveal.setAttribute('aria-pressed', shown ? 'true' : 'false');
      reveal.setAttribute('aria-label', shown ? t('assistant.rack.hideValues', 'Hide typed values') : t('assistant.rack.showValues', 'Show typed values'));
      paint();
    });
    line.appendChild(reveal);
  }
  if (n.patterns?.length) {
    body.appendChild(el('div', 'asst-control-patterns', n.patterns.join('  ')));
  }

  if (Array.isArray(n.suggestions) && n.suggestions.length) {
    const sug = el('div', 'asst-control-suggestions');
    n.suggestions.forEach((s, idx) => {
      const text = describeSuggestion(s);
      if (!text) return;
      const row = el('label', 'asst-control-suggestion');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => { if (cb.checked) state.checkedSuggestions.add(idx); else state.checkedSuggestions.delete(idx); });
      row.appendChild(cb);
      row.appendChild(el('span', null, text));
      sug.appendChild(row);
    });
    if (sug.children.length) body.appendChild(sug);
  }
}

function renderPlanBody(body, n, hooks) {
  if (!n.plan) return;
  const planEl = el('div', 'asst-control-plan-body asst-md');
  // The plan is the brain's text: whatever hooks.md returns, only the allowlist reaches the page.
  try { sanitizeInto(planEl, typeof hooks.md === 'function' ? hooks.md(n.plan) : escapeHtml(n.plan).replace(/\n/g, '<br>')); }
  catch { planEl.textContent = n.plan; } // no DOM to parse into (a test DOM): the plain text
  body.appendChild(planEl);
}

function renderQuestionBody(body, n, state, t) {
  if (n.message) body.appendChild(el('div', 'asst-control-message', n.message));
  n.questions.forEach((q, qIdx) => {
    const section = el('div', 'asst-control-q');
    if (q.header) section.appendChild(el('div', 'asst-control-q-header', q.header));
    if (q.text && q.text !== q.header) section.appendChild(el('div', 'asst-control-q-text', q.text));
    if (q.multiple) section.appendChild(el('div', 'asst-control-q-hint', t('assistant.control.multiHint', 'Select all that apply')));
    const optionButtons = [];
    let customInput = null;
    if (q.options.length) {
      const opts = el('div', `asst-control-options${q.multiple ? ' multi' : ''}`);
      opts.setAttribute('role', q.multiple ? 'group' : 'radiogroup');
      opts.setAttribute('aria-label', q.header || q.text || t('assistant.control.question', 'Question'));
      for (const opt of q.options) {
        const btn = el('button', 'asst-control-option');
        btn.type = 'button';
        btn.setAttribute('role', q.multiple ? 'checkbox' : 'radio');
        btn.setAttribute('aria-checked', 'false');
        btn.appendChild(el('span', 'asst-control-option-label', opt.label));
        if (opt.description) btn.appendChild(el('span', 'asst-control-option-desc', opt.description));
        btn.addEventListener('click', () => {
          if (state.resolved) return;
          const ans = state.answers[qIdx];
          ans.custom = '';
          if (customInput) customInput.value = '';
          if (q.multiple) {
            if (ans.selected.has(opt.label)) ans.selected.delete(opt.label); else ans.selected.add(opt.label);
          } else {
            ans.selected = new Set([opt.label]);
          }
          for (const b of optionButtons) {
            const on = ans.selected.has(b.dataset.label);
            b.classList.toggle('selected', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
          }
          state.updateSubmit?.();
        });
        btn.dataset.label = opt.label;
        optionButtons.push(btn);
        opts.appendChild(btn);
      }
      section.appendChild(opts);
    }
    customInput = document.createElement('input');
    customInput.type = q.type === 'number' || q.type === 'integer' ? 'number' : 'text';
    customInput.className = 'asst-control-custom';
    customInput.placeholder = q.options.length
      ? t('assistant.control.customAnswer', 'Or type your own answer…')
      : t('assistant.control.typeAnswer', 'Type your answer…');
    customInput.setAttribute('aria-label', q.header || q.text || customInput.placeholder);
    customInput.addEventListener('input', () => {
      const ans = state.answers[qIdx];
      ans.custom = customInput.value.trim();
      if (ans.custom) {
        ans.selected.clear();
        for (const b of optionButtons) { b.classList.remove('selected'); b.setAttribute('aria-checked', 'false'); }
      }
      state.updateSubmit?.();
    });
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.submitBtn && !state.submitBtn.disabled) { e.preventDefault(); state.submitBtn.click(); }
      e.stopPropagation();
    });
    section.appendChild(customInput);
    body.appendChild(section);
  });
  // A clarify card also shows what the assistant will assume for the rest, so the user can correct it.
  const assumptions = n.clarify?.assumptions || [];
  if (assumptions.length) {
    const list = assumptions.join(' · ');
    body.appendChild(el('div', 'asst-control-assume', t('assistant.control.assuming', `Otherwise I'll assume: ${list}`, { list })));
  }
}

export function describeSuggestion(s) {
  if (!s || typeof s !== 'object') return '';
  try {
    if (s.type === 'addRules' && Array.isArray(s.rules)) {
      const rules = s.rules.map(r => (r?.toolName ? `${r.toolName}${r.ruleContent ? `(${r.ruleContent})` : ''}` : '')).filter(Boolean).join(', ');
      return `Always allow ${rules}${s.destination ? ` — ${s.destination}` : ''}`;
    }
    if (s.type === 'setMode' && s.mode) return `Switch permission mode to ${s.mode}`;
    if (s.type === 'addDirectories' && Array.isArray(s.directories)) return `Allow access to ${s.directories.join(', ')}`;
    return JSON.stringify(s).slice(0, 120);
  } catch { return ''; }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
