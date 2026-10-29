// Scan evidence belongs to the exact immutable bytes. Missing/stale/partial evidence never becomes a clean badge.
export const SCAN_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export function scanStatus(scan, digest) {
  const counts = Object.fromEntries(SCAN_SEVERITIES.map((s) => [s, Number.isSafeInteger(scan?.counts?.[s]) && scan.counts[s] >= 0 ? scan.counts[s] : (scan?.findings || []).filter((f) => f.severity === s).length]));
  const count = Object.values(counts).reduce((a, b) => a + b, 0);
  let code = 'notScanned';
  if (scan && scan.digest === digest) {
    if (scan.status === 'error') code = 'error';
    else if (scan.coverage?.complete === false || ['incomplete', 'skipped'].includes(scan.status)) code = 'incomplete';
    else if (scan.coverage?.complete === true && ['no_findings', 'findings'].includes(scan.status)) code = count || scan.status === 'findings' ? 'findings' : 'clean';
  }
  return { code, counts, count, passed: ['clean', 'findings'].includes(code) && scan?.gate === 'allowed' && !['critical', 'high', 'medium'].some((s) => counts[s]) };
}
export function scanText(t, scan, digest) {
  const status = scanStatus(scan, digest);
  const counts = SCAN_SEVERITIES.filter((s) => status.counts[s]).map((s) => t('skillsStudio.scan.severityCount', { severity: t(`skillsStudio.scan.severity.${s}`), count: status.counts[s] })).join(', ');
  return t('skillsStudio.scan.summary', { status: t(`skillsStudio.scan.status.${status.code}`), count: status.count, detail: counts ? ` · ${counts}` : '' });
}

export function scanReasonText(t, reason) {
  const keys = { 'asset-invalid-structure': 'assetInvalid', 'asset-script-content': 'assetScript', 'asset-too-large': 'assetTooLarge', 'asset-decompression-budget': 'assetBudget', 'shell-analysis-limit': 'shellLimit' };
  return keys[reason] ? t(`skillsStudio.scan.reasons.${keys[reason]}`) : reason;
}
export function scanFindingText(t, finding) {
  if (finding.reason) return scanReasonText(t, finding.reason);
  if (finding.ruleId === 'S-09-asset-command') return t('skillsStudio.scan.assetCommand');
  if (finding.ruleId === 'S-08-download-run') {
    const { download, run } = finding.locations || {};
    if (!download?.file || !download?.line || !run?.file || !run?.line) return finding.message;
    return t('skillsStudio.scan.downloadRun', { download: `${download.file}:${download.line}`, run: `${run.file}:${run.line}` });
  }
  if (finding.ruleId === 'S-09-asset-exec') return t('skillsStudio.scan.assetExecution');
  if (finding.ruleId === 'S-12-hidden-chars' && finding.total) return t('skillsStudio.scan.hiddenTotal', { count: finding.total, listed: finding.samples?.length || 0 }) + (finding.samples?.length ? ` · ${finding.samples.map((s) => `${s.file}:${s.line}:${s.column} ${s.label}`).join('; ')}` : finding.label ? `: ${finding.label}` : '');
  return finding.message;
}
