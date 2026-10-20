// Text only: keep the account menus in their existing component/token scope.
function translator(t) {
  return (key, fallback, params = {}) => {
    const value = t?.(`assistant.accountUsage.${key}`, params);
    return value && value !== `assistant.accountUsage.${key}` ? value : fallback.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
  };
}
export function accountUsageText(row, t) {
  const tr = translator(t);
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

function pageLocale() {
  try { return globalThis.document?.documentElement?.lang || undefined; } catch { return undefined; }
}
function dateFormat(locale, options) {
  try { return new Intl.DateTimeFormat(locale, options); } catch { return new Intl.DateTimeFormat(undefined, options); }
}
const dayStart = (ms) => { const day = new Date(ms); day.setHours(0, 0, 0, 0); return day.getTime(); };
const bare = (text) => String(text).replace(/\.$/, '');

/**
 * When an account's usage comes back, short enough for one menu line in the page's language:
 * "15:59" today, "Thu 15:59" within the week, "Oct 19 15:59" / "19 out 15:59" later; '' without a
 * valid date. `long` is the full form for a tooltip ("Thursday, October 22 at 15:59").
 */
export function resetTimeText(value, { now = Date.now(), locale = pageLocale(), long = false } = {}) {
  const at = value ? new Date(value) : null;
  if (!at || !Number.isFinite(at.getTime())) return '';
  if (long) return dateFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const time = dateFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const days = Math.round((dayStart(at.getTime()) - dayStart(now)) / 86_400_000);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${bare(dateFormat(locale, { weekday: 'short' }).format(at))} ${time}`;
  const date = dateFormat(locale, { day: 'numeric', month: 'short' }).formatToParts(at)
    .filter((part) => part.type === 'day' || part.type === 'month').map((part) => bare(part.value)).join(' ');
  return `${date} ${time}`;
}

/**
 * An account's usage as one short line of a menu row: { text, tone: 'muted' | 'warn', title }
 * ("50% left · resets Thu 15:59", "Limited until 23:10", "Usage unknown"), the title with the full
 * reset date. null where usage does not apply: an API key, a signed-out or unchecked account.
 */
export function accountUsageLine(row, t, { now = Date.now(), locale = pageLocale() } = {}) {
  if (!row || row.signedIn !== true || row.mode !== 'subscription') return null;
  const tr = translator(t);
  const u = row.usage;
  const short = resetTimeText(u?.resetsAt, { now, locale });
  const full = resetTimeText(u?.resetsAt, { now, locale, long: true });
  if (u?.limited) {
    return {
      text: short ? tr('limitedUntil', 'Limited until {time}', { time: short }) : tr('limited', 'Limited'),
      tone: 'warn',
      title: full ? tr('limitedUntil', 'Limited until {time}', { time: full }) : tr('limited', 'Limited'),
    };
  }
  if (typeof u?.remainingPercent !== 'number' || !Number.isFinite(u.remainingPercent)) {
    const text = tr('unknown', 'Usage unknown');
    return { text, tone: 'muted', title: text };
  }
  const left = tr('left', '{percent}% left', { percent: Math.round(Math.max(0, Math.min(100, u.remainingPercent))) });
  return {
    text: [left, short ? tr('resets', 'resets {time}', { time: short }) : ''].filter(Boolean).join(' · '),
    tone: 'muted',
    title: [left, full ? tr('resets', 'resets {time}', { time: full }) : ''].filter(Boolean).join(' · '),
  };
}
