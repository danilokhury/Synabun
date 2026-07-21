import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { text } from './response.js';

export const SYNABUN_CHOICE_MARKER = '[SYNABUN_CHOICE_V1]';
export const SYNABUN_OTHER_VALUE = '__synabun_other__';

const optionSchema = z.object({
  label: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
});

const questionSchema = z.object({
  id: z.string().min(1).max(64),
  header: z.string().min(1).max(40),
  question: z.string().min(1).max(400),
  options: z.array(optionSchema).min(2).max(4),
});

export const choiceSchema = {
  questions: z.array(questionSchema).min(1).max(3).describe(
    'One to three blocking multiple-choice questions. Each question must have two to four mutually exclusive options.',
  ),
};

export const choiceDescription =
  'Ask the user blocking multiple-choice questions through MCP form elicitation. Use this for SynaBun choices in Codex Default mode. If the result reports supported=false, ask the same numbered choices once in plain text and wait; do not call another question tool.';

export type ChoiceQuestion = z.infer<typeof questionSchema>;

export function buildChoiceElicitation(questions: ChoiceQuestion[]) {
  const properties: ElicitRequestFormParams['requestedSchema']['properties'] = {};
  const required: string[] = [];

  for (const question of questions) {
    const otherField = `${question.id}__other`;
    properties[question.id] = {
      type: 'string',
      title: question.header,
      description: question.question,
      oneOf: [
        ...question.options.map((option) => ({ const: option.label, title: option.label })),
        { const: SYNABUN_OTHER_VALUE, title: 'Other' },
      ],
    };
    properties[otherField] = {
      type: 'string',
      title: `${question.header} - Other`,
      description: 'Custom answer when Other is selected.',
      maxLength: 4000,
    };
    required.push(question.id);
  }

  return {
    mode: 'form' as const,
    message: `${SYNABUN_CHOICE_MARKER}${JSON.stringify({ questions })}`,
    requestedSchema: {
      type: 'object' as const,
      properties,
      required,
    },
  };
}

export function decodeChoiceAnswers(
  questions: ChoiceQuestion[],
  content: Record<string, unknown> = {},
) {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const selected = String(content[question.id] || '');
    const value = selected === SYNABUN_OTHER_VALUE
      ? String(content[`${question.id}__other`] || '').trim()
      : selected;
    if (value) answers[question.id] = { answers: [value] };
  }
  return answers;
}

export async function handleChoice(
  server: McpServer,
  args: { questions: ChoiceQuestion[] },
) {
  const supportsForm = !!server.server.getClientCapabilities()?.elicitation?.form;
  if (!supportsForm) {
    return text(JSON.stringify({
      supported: false,
      fallback: 'Ask these choices once as a concise numbered plain-text question, then stop and wait. Do not call another interactive tool.',
    }));
  }

  const result = await server.server.elicitInput(buildChoiceElicitation(args.questions));
  return text(JSON.stringify({
    supported: true,
    action: result.action,
    answers: result.action === 'accept'
      ? decodeChoiceAnswers(args.questions, result.content as Record<string, unknown> | undefined)
      : {},
  }));
}
