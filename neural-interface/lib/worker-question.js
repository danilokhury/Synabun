// Provider wire answers for the dispatcher's single, first-wins pending request.
import { codexControlRequestFromServerRequest, codexControlResponse } from './assistant-envelope.js';
import { validateCodexServerResponse } from './codex-compat-rpc.js';

export const CODEX_QUESTIONS = new Set(['item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request']);

export function workerQuestions(params = {}) {
  if (Array.isArray(params.questions)) return params.questions;
  if (String(params.message || '').startsWith('[SYNABUN_CHOICE_V1]')) {
    try { return JSON.parse(params.message.slice('[SYNABUN_CHOICE_V1]'.length)).questions || []; } catch { /* generic form */ }
  }
  return [];
}

export function elicitationReply(params, reply = {}) {
  const action = reply.action || reply.result?.action || (reply.behavior === 'allow' ? 'accept' : 'cancel');
  if (reply.behavior !== 'allow' || action !== 'accept') return { action: action === 'decline' ? 'decline' : 'cancel' };
  const supplied = reply.content ?? reply.result?.content ?? reply.answers ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Question answers must be an object');
  const content = {};
  for (const [key, value] of Object.entries(supplied)) {
    const answers = value?.answers;
    const property = params.requestedSchema?.properties?.[key];
    content[key] = Array.isArray(answers) ? (property?.type === 'array' ? answers : answers.join(', ')) : value;
    // An Assistant answer may give free text instead of choice's wire sentinel.
    if (property?.type === 'array' && !Array.isArray(content[key])) content[key] = [String(content[key])];
    if (property?.oneOf && !property.oneOf.some((o) => o.const === content[key]) && params.requestedSchema.properties[`${key}__other`]) {
      content[`${key}__other`] = String(content[key]); content[key] = '__synabun_other__';
    }
  }
  for (const key of params.requestedSchema?.required || []) {
    if (content[key] == null || content[key] === '' || (Array.isArray(content[key]) && !content[key].length)) throw new Error(`Missing answer for ${key}`);
  }
  for (const [key, value] of Object.entries(content)) {
    const schema = params.requestedSchema?.properties?.[key];
    if (!schema) continue;
    if (schema.type === 'array') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`Invalid choices for ${key}`);
    } else if (schema.type && typeof value !== schema.type.replace('integer', 'number')) throw new Error(`Invalid answer for ${key}`);
    if ((value === '__synabun_other__' || Array.isArray(value) && value.includes('__synabun_other__')) && !content[`${key}__other`]?.trim()) throw new Error(`Missing custom answer for ${key}`);
  }
  return { action: 'accept', content };
}

export function codexWorkerReply(packet, reply) {
  if (packet.method === 'mcpServer/elicitation/request') return { result: elicitationReply(packet.params || {}, reply) };
  if (reply.result?.answers && !reply.answers) reply = { ...reply, answers: reply.result.answers };
  const result = codexControlResponse(codexControlRequestFromServerRequest({ ...packet, requestId: packet.id }), reply);
  if (result.result) validateCodexServerResponse(packet.method, packet.params, result.result);
  return result.error ? { error: result.error } : { result: result.result };
}

export function openCodeAnswers(questions, answers) {
  const list = Array.isArray(answers) ? answers : questions.map((q, i) => answers?.[q.id || q.question] ?? answers?.[q.header] ?? answers?.[i]);
  return questions.map((q, i) => {
    const value = list[i]?.answers ?? list[i];
    const result = (Array.isArray(value) ? value : value == null ? [] : [value]).map(String);
    if (!result.length || !result.some((v) => v.trim())) throw new Error(`Missing answer for ${q.header || q.question || i}`);
    return result;
  });
}

/** Validate before consuming the resolver, so a malformed answer leaves a retryable card. */
export function validateWorkerReply(pending, reply) {
  if (reply.behavior !== 'allow' || pending.kind !== 'question') return;
  const protocol = pending.protocol;
  if (protocol?.method === 'elicitation/create') elicitationReply(pending.input || {}, reply);
  else if (protocol?.provider === 'codex') codexWorkerReply({ id: protocol.id, method: protocol.method, params: pending.input || {} }, reply);
  else if (protocol?.provider === 'opencode') openCodeAnswers(pending.questions || [], reply.answers);
  else if (pending.toolName === 'AskUserQuestion') {
    const answers = reply.answers ?? reply.updatedInput?.answers;
    for (const q of pending.questions || []) if (!answers?.[q.question]) throw new Error(`Missing answer for ${q.question}`);
  }
}
