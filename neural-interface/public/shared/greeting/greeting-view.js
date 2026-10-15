// ═══════════════════════════════════════════
// SynaBun — Greeting: what a surface shows (DOM-free)
// ═══════════════════════════════════════════
//
// The one greeting every surface shows (the Assistant, the Claude Code, Codex
// and OpenCode panels, Settings' preview): the sentence SynaBun wrote, how long
// the person was away, and a disclosure of what it was based on and what it
// cost. This module decides every word; greeting-card.js draws it.
//
// GREETING_COPY is the English; `greeting.*` in i18n/*.json must equal it
// (tests/greeting-view.test.mjs). Elapsed time is computed here, at display:
// the sentence itself never says how long it has been, so one written hours
// ago is still true.

export const GREETING_COPY = Object.freeze({
  label: 'Greeting from SynaBun',
  back: 'Back after {time}',
  'time.minute': '1 minute',
  'time.minutes': '{n} minutes',
  'time.hour': '1 hour',
  'time.hours': '{n} hours',
  'time.day': '1 day',
  'time.days': '{n} days',
  'time.week': '1 week',
  'time.weeks': '{n} weeks',
  'time.month': '1 month',
  'time.months': '{n} months',
  'basis.one': 'Based on 1 record',
  'basis.many': 'Based on {n} records',
  'basis.none': 'What this is based on',
  'kind.thread': 'Last conversation',
  'kind.session': 'Last session',
  'kind.open': 'Open',
  'kind.memory': 'Noted',
  'kind.run': 'Run',
  'kind.schedule': 'Schedule',
  'kind.elsewhere': 'Elsewhere',
  'kind.git': 'Working tree',
  'kind.owner': 'About you',
  'agent.assistant': 'Assistant',
  'agent.claude-code': 'Claude Code',
  'agent.codex': 'Codex',
  'agent.opencode': 'OpenCode',
  open: 'Open memory',
  'source.writer': 'Written ahead by {model}',
  'source.fallback': 'Put together from the records, no model',
  'why.not-prepared': 'nothing was written ahead yet',
  'why.out-of-date': 'what was written ahead was older than the news',
  'why.no-writer': 'no Claude sign-in to write with',
  'why.daily-cap': 'the daily limit of writer calls was reached',
  'why.other': 'the writer gave no usable sentence',
  tokens: '{n} tokens',
  prepared: 'written {time} ago',
  free: 'no tokens spent',
});

const num = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);

/** A string of the greeting, through the app's translator when it has one. */
export function greetingText(key, params = null, t = null) {
  const full = `greeting.${key}`;
  let value;
  try { value = typeof t === 'function' ? t(full, params || undefined) : undefined; } catch { value = undefined; }
  if (typeof value === 'string' && value && value !== full) return value;
  const fallback = GREETING_COPY[key];
  if (typeof fallback !== 'string') return key;
  return params ? fallback.replace(/\{(\w+)\}/g, (_, name) => (params[name] != null ? String(params[name]) : `{${name}}`)) : fallback;
}

/** "40 minutes" · "3 hours" · "2 days" · "3 weeks" · "4 months", in the app's language. '' for no time. */
export function formatAway(ms, t = null) {
  if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return '';
  const minutes = Math.round(Number(ms) / 60_000);
  const unit = (one, many, n) => (n === 1 ? greetingText(`time.${one}`, null, t) : greetingText(`time.${many}`, { n }, t));
  if (minutes < 60) return unit('minute', 'minutes', Math.max(1, minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 36) return unit('hour', 'hours', hours);
  const days = Math.round(hours / 24);
  if (days < 21) return unit('day', 'days', days);
  if (days < 75) return unit('week', 'weeks', Math.round(days / 7));
  return unit('month', 'months', Math.round(days / 30));
}

/** "$0.0006" · "<$0.0001" · '' when unknown or nothing. */
export function formatGreetingCost(value) {
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd <= 0) return '';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/**
 * Everything a surface draws for one greeting (the engine's view: lib/greeting/engine.js).
 * → { id, label, when, text, toggle, rows:[{ kind, kindLabel, label, id, openLabel }], cost } | null
 * `when` is '' when the person was not away (a preview): the caller hides the line.
 */
export function greetingView(greeting, { now = Date.now(), t = null } = {}) {
  const text = typeof greeting?.text === 'string' ? greeting.text.trim() : '';
  if (!text) return null;
  const since = Date.parse(greeting.awaySince ?? '');
  const away = Number.isFinite(since) ? formatAway(Math.max(0, now - since), t) : '';
  const basis = Array.isArray(greeting.basis) ? greeting.basis : [];
  const rows = basis.filter((row) => row && typeof row.label === 'string' && row.label.trim()).map((row) => {
    const kind = GREETING_COPY[`kind.${row.kind}`] ? row.kind : 'memory';
    const agent = (kind === 'thread' || kind === 'session') && row.agent && GREETING_COPY[`agent.${row.agent}`] ? greetingText(`agent.${row.agent}`, null, t) : '';
    return {
      kind, kindLabel: agent ? `${greetingText(`kind.${kind}`, null, t)} · ${agent}` : greetingText(`kind.${kind}`, null, t),
      label: row.label.trim(), id: typeof row.id === 'string' && row.id ? row.id : null,
      openLabel: greetingText('open', null, t),
    };
  });
  const cost = [];
  if (greeting.source === 'writer') {
    cost.push(greetingText('source.writer', { model: greeting.model || 'Claude' }, t));
    const tokens = greeting.tokens && typeof greeting.tokens === 'object' ? num(greeting.tokens.input) + num(greeting.tokens.cacheWrite) + num(greeting.tokens.cacheRead) + num(greeting.tokens.output) : 0;
    if (tokens) cost.push(greetingText('tokens', { n: tokens }, t));
    const usd = formatGreetingCost(greeting.costUsd);
    if (usd) cost.push(usd);
    const prepared = Date.parse(greeting.preparedAt ?? '');
    if (Number.isFinite(prepared) && now - prepared >= 60_000) cost.push(greetingText('prepared', { time: formatAway(now - prepared, t) }, t));
  } else {
    const why = greeting.error && GREETING_COPY[`why.${greeting.error}`] ? greeting.error : (greeting.error ? 'other' : null);
    cost.push(why ? `${greetingText('source.fallback', null, t)}: ${greetingText(`why.${why}`, null, t)}` : greetingText('source.fallback', null, t));
    cost.push(greetingText('free', null, t));
  }
  return {
    id: typeof greeting.id === 'string' ? greeting.id : null,
    label: greetingText('label', null, t),
    when: away ? greetingText('back', { time: away }, t) : '',
    text,
    toggle: rows.length === 0 ? greetingText('basis.none', null, t) : rows.length === 1 ? greetingText('basis.one', null, t) : greetingText('basis.many', { n: rows.length }, t),
    rows,
    cost: cost.join(' · '),
  };
}

/**
 * What /api/greeting/open answered. → { state, greeting, reason }
 * state: 'ok' (a greeting) · 'none' (nothing to say now) · 'old-server' (404: the page is newer than the
 * server) · 'failed' (503: the engine did not start) · 'unreadable'
 */
export function readGreetingResponse(status, body) {
  if (status === 404) return { state: 'old-server', greeting: null, reason: null };
  if (status === 503) return { state: 'failed', greeting: null, reason: typeof body?.reason === 'string' ? body.reason : null };
  if (status !== 200 || !body || body.ok !== true) return { state: 'unreadable', greeting: null, reason: null };
  const greeting = body.greeting && typeof body.greeting === 'object' && typeof body.greeting.text === 'string' && body.greeting.text.trim() ? body.greeting : null;
  return { state: greeting ? 'ok' : 'none', greeting, reason: typeof body.reason === 'string' ? body.reason : null };
}
