// ═══════════════════════════════════════════
// SynaBun — Maritaca AI: the panel's two modes (pure)
// ═══════════════════════════════════════════
//
// A Sabiá model is a chat API with no tools, so "plan mode" here is what it can be for a chat model: the turn is sent
// with an instruction (a system message after the user's own system prompt) that asks for a plan and not the work, and
// the reply is saved as a plan (`mode: 'plan'` on the user and the assistant message). The panel then offers the
// sibling panels' plan review: continue with the plan (the next turn goes in chat mode), suggest changes (another plan
// turn), copy it. Chat mode adds nothing. The server decides what a turn carries; the page only names the mode.

export const MARITACA_MODES = Object.freeze(['chat', 'plan']);

/** A mode as a page wrote it → 'plan' or 'chat' (anything else is chat). */
export function normalizeMaritacaMode(value) {
  return value === 'plan' ? 'plan' : 'chat';
}

/**
 * What a plan turn asks of the model. English, like the rest of the request scaffolding; the model answers in the
 * language the person writes in (the instruction says so), so a pt-BR conversation gets a pt-BR plan.
 */
export const MARITACA_PLAN_INSTRUCTION = [
  'PLAN MODE is on for this reply.',
  'Do not carry out the task yet: no finished code, no final text, no full deliverable.',
  'Write a plan instead, in Markdown, with these parts:',
  '1. Goal: the outcome in one or two sentences.',
  '2. Assumptions and open questions: what you are taking as given, and what the user should confirm.',
  '3. Steps: a numbered list; each step says what is done and what it produces.',
  '4. Risks and checks: what could go wrong and how the result will be verified.',
  'Keep it concise and concrete. End with one line asking whether to proceed or what to change.',
  'Answer in the language the user writes in.',
].join('\n');

/** The system message a turn starts with: the user's own prompt, then the plan instruction when the mode asks for it. */
export function maritacaSystemPrompt({ systemPrompt = '', mode = 'chat' } = {}) {
  const own = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  if (normalizeMaritacaMode(mode) !== 'plan') return own;
  return own ? `${own}\n\n${MARITACA_PLAN_INSTRUCTION}` : MARITACA_PLAN_INSTRUCTION;
}
