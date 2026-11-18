// Native export: the server owns formats and targets; a write is pinned to the preview the owner saw.
export const canExportNative = (ctx, agent) => !!ctx.owner && ctx.caps.has('native-export') && !!agent?.approvedDefinition;

export function nativeHostOptions(formats, selected) {
  return formats.map((row) => ({ value: row.host, label: row.label || row.host, selected: row.supported && row.host === selected, disabled: !row.supported, caption: row.supported ? '' : row.reason }));
}

export function nativeWriteBody(preview, selection) {
  if (!preview?.supported || !preview.approved || !preview.writable || !preview.target?.writable || !preview.digest || preview.host !== selection.host) throw new Error('Export needs a writable approved preview.');
  return { ...selection, revision: preview.revision, contentDigest: preview.digest,
    ...(preview.target.exists ? { replace: true, expectedDigest: preview.target.existingDigest } : {}) };
}

/** A late preview cannot replace a newer selection, and a changed selection cannot write an earlier preview. */
export function nativeExportSession(api, key, revision) {
  let generation = 0, selection = null, preview = null, busy = false, closed = false;
  return {
    async load(next) {
      const token = ++generation;
      selection = { ...next }; preview = null;
      const result = await api.nativePreview(key, { ...next, revision });
      if (closed || token !== generation) return null;
      preview = result;
      return result;
    },
    async write() {
      if (closed || busy) throw new Error('Export is not available.');
      const body = nativeWriteBody(preview, selection);
      busy = true;
      try { return await api.nativeWrite(key, body); }
      finally { busy = false; preview = null; }
    },
    close() { closed = true; ++generation; preview = null; },
  };
}
