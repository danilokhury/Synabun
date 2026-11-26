export function connectionAdvice({ profile, state } = {}) {
  const name = profile ? ` (${profile})` : '';
  if (state === 'stopped') return `Launch the AI browser${name}, then retry the browser tool.`;
  if (state === 'wrong-profile') return `The wrong profile is open. Open the AI browser profile${name}, then retry.`;
  if (state === 'running') return `The AI browser${name} is running. Open SynaBun Browser Bridge in that profile and reconnect from the popup.`;
  return `Check that the AI browser${name} is open in the paired profile. If it is closed, launch it. If it is open, reconnect from the popup.`;
}

// Only for an otherwise unexplained profile start/attach failure. A quota, outside-close
// or policy refusal keeps its own recovery instructions. A silent API is not a stopped profile.
export async function stoppedProfileAdvice(envId, name, readStatus) {
  try {
    const status = await readStatus(envId);
    const rows = Array.isArray(status?.dataList) ? status.dataList : Array.isArray(status) ? status : [status];
    const row = rows.find(item => String(item?.envId || '') === String(envId)) ||
      (rows.length === 1 && !rows[0]?.envId ? rows[0] : null);
    if (!/^(stopped|closed)$/i.test(row?.localStatus || row?.status || '')) return '';
    return connectionAdvice({ profile: name || row.envName || row.name || envId, state: 'stopped' });
  } catch { return ''; }
}
