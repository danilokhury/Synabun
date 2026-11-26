export function mtimeIsoOf(stat) {
  if (!stat) return null;
  if (typeof stat.mtimeIso === 'string' && stat.mtimeIso) return stat.mtimeIso;
  if (typeof stat.mtime?.toISOString === 'function') return stat.mtime.toISOString();
  if (stat.mtimeMs != null && Number.isFinite(Number(stat.mtimeMs))) {
    return new Date(Number(stat.mtimeMs)).toISOString();
  }
  return null;
}

/**
 * Deterministic persisted file identity combining device, inode, ctime, and mtime
 * (nanosecond resolution when BigInt stats are used). Returns null for minimal
 * stat mocks that only carry size + mtime.
 */
export function fileIdentityOf(stat) {
  if (stat?.dev == null || stat.ino == null) return null;
  const ctime = stat.ctimeNs != null ? `ns:${stat.ctimeNs}` : (stat.ctimeMs != null ? `ms:${stat.ctimeMs}` : '');
  const mtime = stat.mtimeNs != null ? `ns:${stat.mtimeNs}` : (stat.mtimeMs != null ? `ms:${stat.mtimeMs}` : '');
  return `${stat.dev}:${stat.ino}:${ctime}:${mtime}`;
}

// Older checkpoints already encode dev:ino:ctime:mtime. The first two fields identify
// the file across appends. The complete stamp detects same-size edits, even if mtime is restored.
export function captureStartOffset(row, size, identity, mtime) {
  const offset = Number(row.byte_offset);
  const previousSize = row.file_size ?? offset;
  if (size != null && (size < offset || size < previousSize)) return 0;
  if (!row.file_identity || !identity) return offset;
  if (size > previousSize) {
    const fileKey = stamp => stamp.split(':', 2).join(':');
    return fileKey(identity) === fileKey(row.file_identity) ? offset : 0;
  }
  if (identity !== row.file_identity
      || (mtime && row.file_mtime && mtime !== row.file_mtime)) return 0;
  return offset;
}

export function isSessionFileUnchanged(cached, stat) {
  return !!cached?.file_identity && cached.file_identity === fileIdentityOf(stat)
    && Number(cached.file_size) === Number(stat.size) && cached.file_mtime === mtimeIsoOf(stat);
}
