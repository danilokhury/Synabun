import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  fallbackSessionTitle,
  normalizeSessionTitle,
} from '../public/shared/session-title.js';

export const SESSION_TITLE_TIMEOUT_MS = 20_000;
export const SESSION_TITLE_PROMPT_LIMIT = 4_000;

const TITLE_SYSTEM_PROMPT = [
  'Create a short identifier that names the user task.',
  'Return only JSON in the form {"title":"SessionName"}.',
  'The title must be one PascalCase identifier, start with a letter, contain only ASCII letters and digits, and be at most 32 characters.',
  'Use the task meaning, not generic words such as Task, Request, Help, or Session.',
  'Do not explain the answer and do not use tools.',
].join(' ');

function titlePrompt(input) {
  const value = input && typeof input === 'object' ? input : { prompt: input };
  const prompt = String(value.prompt || '').slice(0, SESSION_TITLE_PROMPT_LIMIT);
  const attachmentLines = [];
  if (Array.isArray(value.paths) && value.paths.length) {
    const paths = value.paths.slice(0, 8).map((path) => String(path).slice(0, 256));
    attachmentLines.push(`Referenced files: ${paths.join(', ')}`);
  }
  if (value.hasImages) attachmentLines.push('The task includes one or more image attachments.');
  const attachments = attachmentLines.length ? `\n\nTask context:\n${attachmentLines.join('\n')}` : '';
  return `${TITLE_SYSTEM_PROMPT}\n\nUser task:\n${prompt}${attachments}`;
}

function cleanClaudeEnv(source = process.env) {
  return Object.fromEntries(Object.entries(source || {}).filter(([key]) => (
    key !== 'CLAUDECODE'
    && key !== 'TERM_PROGRAM'
    && key !== 'TERM_PROGRAM_VERSION'
    && !key.startsWith('VSCODE_')
  )));
}

function extractOpenCodeText(response) {
  const data = response?.data || response || {};
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const text = parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (text) return text;
  if (typeof data?.text === 'string') return data.text;
  if (typeof data?.message === 'string') return data.message;
  return '';
}

function extractCodexText(stdout) {
  let last = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
        last = event.item.text || event.item.content || last;
      } else if (event?.type === 'agent_message') {
        last = event.text || event.message || last;
      }
    } catch {}
  }
  return typeof last === 'string' ? last : '';
}

async function generateClaudeTitle(input, deps) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(new Error('Session title request timed out')), SESSION_TITLE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const q = (deps.claudeQuery || claudeQuery)({
      prompt: titlePrompt(input),
      options: {
        cwd: input.cwd || process.cwd(),
        model: input.model || undefined,
        effort: ['low', 'medium', 'high', 'max'].includes(input.effort) ? input.effort : undefined,
        systemPrompt: TITLE_SYSTEM_PROMPT,
        settingSources: [],
        allowedTools: [],
        maxTurns: 1,
        persistSession: false,
        includePartialMessages: false,
        abortController,
        env: cleanClaudeEnv(deps.env || process.env),
        canUseTool: async () => ({ behavior: 'deny', message: 'Session title generation cannot use tools.' }),
      },
    });
    let result = '';
    for await (const event of q) {
      if (event?.type !== 'result') continue;
      if (event.subtype !== 'success') throw new Error(event.error || event.result || 'Claude title request failed');
      result = event.result || '';
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function generateCodexTitle(input, deps) {
  if (typeof deps.execFile !== 'function' || typeof deps.getCodexBin !== 'function') {
    throw new Error('Codex title runner is unavailable');
  }
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules',
    '--sandbox', 'read-only', '--color', 'never', '--json',
  ];
  if (input.cwd) args.push('-C', input.cwd);
  if (input.model) args.push('-m', input.model);
  if (input.effort && input.effort !== 'off') {
    const effort = input.effort === 'max' ? 'xhigh' : input.effort;
    if (['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) {
      args.push('-c', `model_reasoning_effort="${effort}"`);
    }
  }
  args.push(titlePrompt(input));
  const env = {
    ...(deps.env || process.env),
    CODEX_HOME: deps.getCodexAccountHome?.(input.accountId || 'default'),
  };
  if (typeof deps.getAugmentedPath === 'function') env.PATH = deps.getAugmentedPath();
  const { stdout } = await deps.execFile(deps.getCodexBin(), args, {
    cwd: input.cwd || process.cwd(),
    env,
    timeout: SESSION_TITLE_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return extractCodexText(stdout);
}

async function generateOpenCodeTitle(input, deps) {
  if (typeof deps.ensureOpenCode !== 'function' || !deps.openCodeClient?.session) {
    throw new Error('OpenCode title runner is unavailable');
  }
  const ready = await deps.ensureOpenCode();
  if (!ready) throw new Error('OpenCode server is unavailable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Session title request timed out')), SESSION_TITLE_TIMEOUT_MS);
  timer.unref?.();
  let sessionId = null;
  try {
    const toolIds = new Set([
      'bash', 'edit', 'write', 'patch', 'apply_patch', 'multiedit', 'read',
      'glob', 'grep', 'list', 'task', 'webfetch', 'question', 'skill',
      'todowrite', 'todoread',
    ]);
    try {
      const toolResult = await deps.openCodeClient.getClient?.()?.tool?.ids(
        { directory: input.cwd || undefined },
        { signal: controller.signal },
      );
      for (const id of (toolResult?.data || [])) if (id) toolIds.add(String(id));
    } catch {}
    const disabledTools = Object.fromEntries([...toolIds].map((id) => [id, false]));

    const created = await deps.openCodeClient.session.create({
      directory: input.cwd || undefined,
      title: 'SessionTitleDraft',
    });
    sessionId = created?.data?.id || created?.data?.sessionID || created?.id || created?.sessionID;
    if (!sessionId) throw new Error('OpenCode did not create a temporary title session');
    const response = await deps.openCodeClient.session.prompt({
      sessionID: sessionId,
      parts: [{ type: 'text', text: titlePrompt(input) }],
      model: input.model || undefined,
      agent: input.agent || (input.mode === 'plan' ? 'plan' : 'build'),
      variant: input.variant || undefined,
      system: TITLE_SYSTEM_PROMPT,
      directory: input.cwd || undefined,
      tools: disabledTools,
      signal: controller.signal,
    });
    return extractOpenCodeText(response);
  } finally {
    clearTimeout(timer);
    if (sessionId) {
      await deps.openCodeClient.session.delete({
        sessionID: sessionId,
        directory: input.cwd || undefined,
      }).catch(() => {});
    }
  }
}

export async function generateSessionTitle(input = {}, deps = {}) {
  const provider = String(input.provider || '');
  const prompt = String(input.prompt || '').slice(0, SESSION_TITLE_PROMPT_LIMIT);
  const fallback = fallbackSessionTitle(prompt, {
    paths: input.paths,
    hasImages: !!input.hasImages,
  });
  if (!['claude-code', 'codex', 'opencode'].includes(provider)) {
    const error = new Error('Unsupported session title provider');
    error.status = 400;
    throw error;
  }
  if (!prompt.trim() && !input.hasImages && !(Array.isArray(input.paths) && input.paths.length)) {
    const error = new Error('A prompt or attachment hint is required');
    error.status = 400;
    throw error;
  }

  try {
    let raw = '';
    if (provider === 'claude-code') raw = await generateClaudeTitle({ ...input, prompt }, deps);
    if (provider === 'codex') raw = await generateCodexTitle({ ...input, prompt }, deps);
    if (provider === 'opencode') raw = await generateOpenCodeTitle({ ...input, prompt }, deps);
    const title = normalizeSessionTitle(raw);
    if (!title) throw new Error('Provider returned an invalid session title');
    return { title, source: 'agent' };
  } catch (error) {
    deps.log?.(`[session-title] ${provider} generation failed: ${error?.message || error}`);
    return { title: fallback, source: 'fallback' };
  }
}

export const _test = {
  extractCodexText,
  extractOpenCodeText,
  titlePrompt,
};
