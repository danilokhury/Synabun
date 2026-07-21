export function buildCodexCollaborationMode({ mode, model, effort } = {}) {
  const normalizedMode = mode === 'plan' ? 'plan' : 'default';
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) return null;

  return {
    mode: normalizedMode,
    settings: {
      model: normalizedModel,
      reasoning_effort: effort && effort !== 'off' ? String(effort) : null,
      developer_instructions: null,
    },
  };
}
