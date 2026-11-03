// Bridge run state to each provider's existing question card. No card markup lives here.
import { t } from './i18n.js';

export function syncWorkerQuestions(holder, run, { open, close }) {
  const previous = holder._workerQuestions || new Map();
  const next = new Map((run.pending || []).filter((p) => p.kind === 'question' || p.protocol?.provider === 'codex').map((p) => [p.requestId, p]));
  // Set before rendering: callbacks can synchronously read the current request.
  holder._workerQuestions = next;
  for (const [id, pending] of previous) if (!next.has(id)) close(id, pending);
  for (const [id, pending] of next) if (!previous.has(id)) open(id, pending);
}

export async function answerWorkerQuestion(runId, requestId, response) {
  const res = await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...response, requestId, origin: 'user' }),
  });
  const body = await res.json().catch(() => ({}));
  // Another surface or Stop consumed it first. This card must clear too.
  if (res.status === 409 && ['PERMISSION_ALREADY_RESOLVED', 'NO_PENDING_REQUEST'].includes(body.code)) return { stale: true };
  if (!res.ok || body.ok === false) throw new Error(body.error || t('workerQuestion.deliveryFailed'));
  return body;
}

/** Claude's native card shows one tool call at a time (each call may contain several questions). */
export function syncWorkerQuestionQueue(holder, run, hooks) {
  syncWorkerQuestions(holder, run, { open() {}, close() {} });
  const next = holder._workerQuestions.keys().next().value || null;
  const previous = holder._workerQuestionActiveId || null;
  if (next === previous) return;
  holder._workerQuestionActiveId = next;
  if (previous) hooks.close(previous);
  if (next) hooks.open(next, holder._workerQuestions.get(next));
}
