export function buildCodexCollaborationMode({ mode, model, effort, developerInstructions = null } = {}) {
  const normalizedMode = mode === 'plan' ? 'plan' : 'default';
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) return null;
  const instructions = typeof developerInstructions === 'string' && developerInstructions.trim()
    ? developerInstructions
    : null;

  return {
    mode: normalizedMode,
    settings: {
      model: normalizedModel,
      reasoning_effort: effort && effort !== 'off' ? String(effort) : null,
      developer_instructions: instructions,
    },
  };
}
