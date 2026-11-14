// Launch diagnostics are safe to show in a run; credentials never cross this boundary.
export function sanitizeLaunchText(value) {
  return String(value || '').replace(/(password|token|secret|api[_ -]?key|authorization)(\s*[=:]\s*|\s+)([^\r\n,;]+)/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@').slice(0, 2000);
}
export function isolatedServeFailure(error) {
  const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(error?.code || '') ? error.code : 'OPENCODE_SERVE_START_FAILED';
  const reason = sanitizeLaunchText(error?.message || 'unknown launch failure');
  const offenders = (Array.isArray(error?.offenders) ? error.offenders : []).map(o => Object.fromEntries(
    ['envId', 'reason', 'pid', 'port', 'path', 'version', 'check', 'detail', 'state'].filter(k => o[k] != null).map(k => [k, typeof o[k] === 'number' ? o[k] : sanitizeLaunchText(o[k])])));
  const cause = Object.assign(new Error(reason), { code, offenders });
  return Object.assign(new Error(`OpenCode isolated native serve failed to start: [${code}] ${reason}`, { cause }), { code, offenders });
}
