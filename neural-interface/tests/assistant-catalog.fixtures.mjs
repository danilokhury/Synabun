// Shared live-shaped catalog fixtures for the assistant routing tests (not a test file).

// Live-shaped fixtures (OpenCode 1.18 /provider, Claude CLI model list, Codex model/list).
export const OPENCODE_FULL = {
  ok: true,
  data: {
    all: [
      {
        id: 'ollama-cloud', name: 'Ollama Cloud',
        models: {
          'deepseek-v4.1-flash': { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', family: 'deepseek-flash', capabilities: { toolcall: true, reasoning: true, input: { text: true, image: true } }, cost: { input: 0.15, output: 0.6, cache: { read: 0.003 } }, limit: { context: 1048576 }, variants: { low: {}, high: {}, max: {} }, status: 'active' },
          'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', capabilities: { toolcall: true, input: { text: true, image: false } }, cost: { input: 1.2, output: 9 }, limit: { context: 1048576 }, status: 'active' },
          'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', capabilities: { toolcall: true, input: { text: true, image: false } }, cost: { input: 0.1, output: 0.4 }, limit: { context: 131072 } },
        },
      },
      {
        id: 'zai-coding-plan', name: 'Z.AI Coding Plan',
        models: { 'glm-5.2': { id: 'glm-5.2', name: 'GLM 5.2', capabilities: { toolcall: true, input: { image: false } }, cost: { input: 0, output: 0 }, limit: { context: 200000 } } },
      },
      { id: 'not-connected', name: 'Nope', models: { 'x-1': { id: 'x-1', name: 'X 1', cost: { input: 1, output: 2 } } } },
      { id: 'legacy', name: 'Legacy v1', models: { 'vis-1': { id: 'vis-1', name: 'Vis 1', modalities: { input: ['text', 'image'] }, cost: { input: 0.5, output: 1 } } } },
    ],
    default: { 'ollama-cloud': 'deepseek-v4.1-flash' },
    connected: ['ollama-cloud', 'zai-coding-plan', 'legacy'],
  },
};
// OpenCode models that generate media: v2 capabilities.output, the v1 modalities.output shape, and one without output data.
export const OPENCODE_MEDIA = {
  ok: true,
  data: {
    all: [
      {
        id: 'media-lab', name: 'Media Lab',
        models: {
          'pixel-flash': { id: 'pixel-flash', name: 'Pixel Flash', capabilities: { toolcall: true, input: { text: true, image: true }, output: { text: true, image: true, video: false } }, cost: { input: 0.3, output: 2.5 }, limit: { context: 32768 } },
          'motion-1': { id: 'motion-1', name: 'Motion 1', capabilities: { toolcall: true, input: { text: true, image: true }, output: { text: true, image: false, video: true } }, cost: { input: 1, output: 12 }, limit: { context: 32768 } },
          'text-only': { id: 'text-only', name: 'Text Only', capabilities: { toolcall: true, input: { text: true, image: false } }, cost: { input: 0.1, output: 0.4 }, limit: { context: 131072 } },
        },
      },
      { id: 'studio', name: 'Studio', models: { 'pixel-pro': { id: 'pixel-pro', name: 'Pixel Pro', capabilities: { toolcall: true, input: { text: true, image: true }, output: { text: true, image: true, video: false } }, cost: { input: 2, output: 30 }, limit: { context: 65536 } } } },
      { id: 'legacy-media', name: 'Legacy media', models: { 'reel-1': { id: 'reel-1', name: 'Reel 1', modalities: { input: ['text'], output: ['text', 'video'] }, cost: { input: 0.5, output: 6 } } } },
    ],
    default: {},
    connected: ['media-lab', 'studio', 'legacy-media'],
  },
};
export const CLAUDE_MODELS = {
  ok: true,
  models: [
    { id: 'default', label: 'Default (recommended) — Opus 5.5', resolvedModel: 'claude-opus-5-5', contextWindow: 200000, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], tier: 'default' },
    { id: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', contextWindow: 200000, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-fable-5-1', label: 'Fable 5.1', resolvedModel: 'claude-fable-5-1', contextWindow: 200000, effortLevels: ['low', 'high'] },
    { id: 'sonnet', label: 'Sonnet 5', resolvedModel: 'claude-sonnet-5', contextWindow: 200000, effortLevels: ['low', 'medium', 'high'] },
    { id: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001', contextWindow: 200000, effortLevels: [] },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', resolvedModel: 'claude-sonnet-4-6', contextWindow: 200000, effortLevels: [] },
  ],
};
export const CODEX_MODELS = {
  ok: true,
  models: [
    { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', inputModalities: ['text', 'image'], isDefault: true, contextWindow: 272000, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium' },
    { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', inputModalities: ['text', 'image'], contextWindow: 272000, supportedReasoningEfforts: [] },
    { id: 'gpt-5.4-computer-use', model: 'gpt-5.4-computer-use', displayName: 'CU', inputModalities: ['text', 'image'] },
    { id: 'hidden-1', model: 'hidden-1', hidden: true },
  ],
};
export const PRICING = { 'claude-opus-5-5': [4, 20, 5, 0.2], 'claude-fable-5-1': [10, 50, 12.5, 0.25], 'claude-sonnet-5': [2, 10, 2.5, 0.2], 'claude-haiku-4-5-20251001': [1, 5, 1.25, 0.1], 'claude-sonnet-4-6': [3, 15, 3.75, 0.3] };

export function fakeFetch(overrides = {}) {
  const table = {
    '/api/claude/models': CLAUDE_MODELS, '/api/codex/models': CODEX_MODELS, '/api/opencode/providers/full': OPENCODE_FULL,
    '/api/projects': { projects: [{ label: 'Synabun', path: '/tmp' }] }, '/api/mcp/profile': { presets: { full: { groups: ['git'] } }, profile: 'full' },
    ...overrides,
  };
  const calls = [];
  const fn = async (path) => { calls.push(path); return table[path] ?? null; };
  fn.calls = calls;
  return fn;
}
