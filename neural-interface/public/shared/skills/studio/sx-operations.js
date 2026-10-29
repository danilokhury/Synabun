// Protection is per immutable library identity. Distinct records with the same name must remain separately selectable.
export function protectionEntries(skills) {
  return [...new Map(skills.map((s) => [s.skillId, s])).values()].map((s) => ({ ...s,
    sourceCode: ['bundled', 'adopted', 'import', 'local', 'assistant', 'github'].includes(s.origin?.kind) ? s.origin.kind : 'local',
    detail: [s.origin?.path, s.skillId].filter(Boolean).join(' · '),
  }));
}

export function scannerState(scanner) {
  return !scanner.enabled ? 'disabled' : scanner.available && scanner.status === 'ready' ? 'ready' : 'unavailable';
}
