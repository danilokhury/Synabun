// Text only: keep the account menus in their existing component/token scope.
export function accountUsageText(row, t) {
  const tr = (key, fallback, params = {}) => {
    const value = t?.(`assistant.accountUsage.${key}`, params);
    return value && value !== `assistant.accountUsage.${key}` ? value : fallback.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
  };
  if (row?.mode === 'apiKey' || row?.mode === 'api') return tr('notApplicable', 'Usage n/a');
  const u = row?.usage;
  const reset = u?.resetsAt ? new Date(u.resetsAt) : null;
  const time = reset && Number.isFinite(reset.getTime()) ? reset.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  if (u?.limited) return time ? tr('limitedUntil', 'Limited until {time}', { time }) : tr('limited', 'Limited');
  if (typeof u?.remainingPercent !== 'number' || !Number.isFinite(u.remainingPercent)) return tr('unknown', 'Usage unknown');
  return [tr('left', '{percent}% left', { percent: Math.round(u.remainingPercent) }), time ? tr('resets', 'resets {time}', { time }) : ''].filter(Boolean).join(' · ');
}
export function autoAccountLabel(t) {
  const key = 'assistant.accountUsage.auto';
  const value = t?.(key);
  return value && value !== key ? value : 'Auto · most usage left';
}
