// ═══════════════════════════════════════════
// SynaBun — Maritaca panel: what decides (no DOM)
// ═══════════════════════════════════════════
//
// The transcript model (rows from a saved conversation, a streaming turn applied event by event), the
// tabs (serialize / restore), the dropdown entries (models, reasoning levels), the key status line and
// the small formatters. Everything here runs under node --test.

export const MAX_TABS = 8;
export const MAX_DRAFT_CHARS = 200_000;
// The reasoning levels (lib/maritaca/models.js MARITACA_REASONING_EFFORTS) and the API's other spellings of them.
export const EFFORTS = Object.freeze(['none', 'low', 'medium', 'high']);
const EFFORT_ALIASES = Object.freeze({ minimal: 'low', xhigh: 'high', max: 'high' });
/** A level as written (saved before 2026-11-08, an older server's row, an alias) → a level of EFFORTS, else null. */
export function normalizeEffort(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v) return null;
  return EFFORTS.includes(v) ? v : EFFORT_ALIASES[v] || null;
}

let _rowSeq = 0;
const rowId = () => `r${++_rowSeq}_${Date.now().toString(36)}`;

// ── Transcript ──────────────────────────────────────────────────────────────
export function createTranscript() { return { rows: [], turn: null, loaded: false }; }

/** The rows of a saved conversation ({ messages: [{ role, content, reasoning?, usage?, costBrl?, model?, finishReason?, error? }] }). */
export function applyLoadedSession(transcript, session) {
  transcript.rows = [];
  transcript.turn = null;
  transcript.loaded = true;
  transcript.priorCostBrl = Number(session?.priorCostBrl) || 0;
  for (const [messageIndex, m] of (Array.isArray(session?.messages) ? session.messages : []).entries()) {
    if (m?.role === 'user') transcript.rows.push({ kind: 'user', id: rowId(), messageIndex, text: String(m.displayText ?? m.content ?? ''), attachments: m.attachments || [], at: m.at || null, mode: m.mode === 'plan' ? 'plan' : 'chat' });
    else if (m?.role === 'assistant') {
      transcript.rows.push({
        kind: 'assistant', id: rowId(), turnId: m.turnId || null, text: String(m.content || ''), reasoning: typeof m.reasoning === 'string' ? m.reasoning : '',
        usage: m.usage || null, costBrl: m.costBrl != null && Number.isFinite(Number(m.costBrl)) ? Number(m.costBrl) : null, model: m.model || null,
        finishReason: m.finishReason || null, error: m.error || null, streaming: false, at: m.at || null, mode: m.mode === 'plan' ? 'plan' : 'chat',
      });
    }
  }
  return transcript;
}

/** A prompt the person sent: its row, and the assistant row the stream fills. */
export function startTurn(transcript, { turnId, text, model = null, appendUser = true, attachments = [], startedAt = Date.now(), mode = 'chat' }) {
  if (transcript.rows.some((row) => row.turnId === turnId)) return turnRow(transcript, turnId);
  const turnMode = mode === 'plan' ? 'plan' : 'chat';
  if (appendUser) transcript.rows.push({ kind: 'user', id: rowId(), text: String(text || ''), messageIndex: transcript.rows.length, attachments, at: new Date().toISOString(), mode: turnMode });
  const row = { kind: 'assistant', id: rowId(), turnId, text: '', reasoning: '', usage: null, costBrl: null, model, finishReason: null, error: null, streaming: true, startedAt, mode: turnMode };
  transcript.rows.push(row);
  transcript.turn = { turnId, rowId: row.id, startedAt: row.startedAt };
  return row;
}

/** The streaming row of `turnId` (null when the turn is not this transcript's). */
export function turnRow(transcript, turnId) {
  if (!transcript.turn || transcript.turn.turnId !== turnId) return null;
  return transcript.rows.find((row) => row.id === transcript.turn.rowId) || null;
}

export function applyDelta(transcript, { turnId, text, offset }) {
  const row = turnRow(transcript, turnId);
  if (!row) return false;
  const delta = String(text || '');
  row.text += Number.isInteger(offset) ? delta.slice(Math.max(0, row.text.length - offset)) : delta;
  return true;
}

export function applyReasoning(transcript, { turnId, text, offset }) {
  const row = turnRow(transcript, turnId);
  if (!row) return false;
  const delta = String(text || '');
  row.reasoning += Number.isInteger(offset) ? delta.slice(Math.max(0, row.reasoning.length - offset)) : delta;
  return true;
}

/** The turn ended (turn:end): the row takes the final text, usage and cost; a failure keeps what streamed. */
export function endTurn(transcript, payload = {}) {
  const row = turnRow(transcript, payload.turnId);
  if (!row) return null;
  if (typeof payload.text === 'string' && payload.text.length >= row.text.length) row.text = payload.text;
  if (typeof payload.reasoning === 'string' && payload.reasoning.length >= row.reasoning.length) row.reasoning = payload.reasoning;
  row.usage = payload.usage || null;
  row.costBrl = payload.costBrl != null && Number.isFinite(Number(payload.costBrl)) ? Number(payload.costBrl) : null;
  row.finishReason = payload.finishReason || 'stop';
  row.error = payload.error || null;
  row.code = payload.code || null;
  if (payload.mode === 'plan' || payload.mode === 'chat') row.mode = payload.mode;
  row.streaming = false;
  row.endedAt = Date.now();
  transcript.turn = null;
  if (Number.isInteger(payload.messageCount) && payload.messageCount > 0 && transcript.rows.length > payload.messageCount) transcript.rows.splice(0, transcript.rows.length - payload.messageCount);
  if (payload.priorCostBrl != null && Number.isFinite(Number(payload.priorCostBrl))) transcript.priorCostBrl = Number(payload.priorCostBrl);
  transcript.rows.forEach((r, i) => { if (r.kind === 'user') r.messageIndex = i; });
  return row;
}

/** The last answer's text (for Copy / Retry). */
export function lastAnswer(transcript) {
  for (let i = transcript.rows.length - 1; i >= 0; i--) if (transcript.rows[i].kind === 'assistant') return transcript.rows[i];
  return null;
}
export function lastPrompt(transcript) {
  for (let i = transcript.rows.length - 1; i >= 0; i--) if (transcript.rows[i].kind === 'user') return transcript.rows[i].text;
  return '';
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
export function newTab({ project = '', model = null } = {}) {
  return { id: `mtc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, sessionId: null, title: '', project: project || '', model: model || null, effort: null, planMode: false, planDismissed: null, planFeedback: '', draft: '', attachments: [], running: false, submitting: false, turnId: null };
}

export function serializeTabs(tabs) {
  return (tabs || []).slice(0, MAX_TABS).map((tab) => ({
    id: tab.id, sessionId: tab.sessionId || null, title: tab.title || '', project: tab.project || '', model: tab.model || null, effort: normalizeEffort(tab.effort),
    planMode: !!tab.planMode, planDismissed: typeof tab.planDismissed === 'string' ? tab.planDismissed.slice(0, 80) : null, planFeedback: String(tab.planFeedback || '').slice(0, 4000),
    draft: String((tab.editingIndex != null ? tab.beforeEdit : tab.draft) || '').slice(0, MAX_DRAFT_CHARS), running: !!tab.running,
    attachments: savedAttachments(tab.editingIndex != null ? tab.beforeEditAttachments : tab.attachments),
  }));
}

/** Saved tabs → live tabs: the server's load/partial answer restores a running turn, never a stale saved flag. */
export function restoreTabs(saved) {
  const list = Array.isArray(saved) ? saved : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : newTab().id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, sessionId: typeof raw.sessionId === 'string' && /^[a-f0-9]{32}$/.test(raw.sessionId) ? raw.sessionId : null,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '', project: typeof raw.project === 'string' ? raw.project : '',
      model: typeof raw.model === 'string' ? raw.model : null, effort: normalizeEffort(raw.effort),
      planMode: raw.planMode === true, planDismissed: typeof raw.planDismissed === 'string' ? raw.planDismissed.slice(0, 80) : null,
      planFeedback: typeof raw.planFeedback === 'string' ? raw.planFeedback.slice(0, 4000) : '',
      draft: typeof raw.draft === 'string' ? raw.draft.slice(0, MAX_DRAFT_CHARS) : '', running: false, turnId: null,
      attachments: savedAttachments(raw.attachments), submitting: false,
    });
    if (out.length >= MAX_TABS) break;
  }
  return out.length ? out : [newTab()];
}

function savedAttachments(files) {
  return (Array.isArray(files) ? files : []).slice(0, 5).filter((f) => typeof f?.dataUrl === 'string' && f.dataUrl.length <= 134_000 && /^data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}$/.test(f.dataUrl))
    .map((f) => ({ name: String(f.name || '').slice(0, 180), mimeType: String(f.mimeType || '').slice(0, 127), dataUrl: f.dataUrl, size: Number(f.size) || 0 }));
}

export function conversationCost(transcript) {
  return (Number(transcript.priorCostBrl) || 0) + transcript.rows.reduce((sum, row) => sum + (row.kind === 'assistant' ? Number(row.costBrl) || 0 : 0), 0);
}

/** What a tab is called: its title, else a short id of its conversation, else the default. */
export function tabLabel(tab, T) {
  const title = String(tab?.title || '').trim();
  if (title) return title;
  if (tab?.sessionId) return `${T('title')} · ${tab.sessionId.slice(0, 8)}`;
  return T('newSession');
}

// ── Dropdown entries ─────────────────────────────────────────────────────────
export function formatContext(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}K`;
}

export function formatBrl(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '0,00';
  if (n < 0.01) return n.toFixed(4).replace('.', ',');
  return n.toFixed(2).replace('.', ',');
}

/** One model's tagline: price per 1M, context, free / BR tags. */
export function modelTagline(model, T) {
  const parts = [];
  if (model?.free) parts.push(T('freeTag'));
  else if (model?.price && (model.price.input > 0 || model.price.output > 0)) parts.push(T('priceTag', { input: formatBrl(model.price.input), output: formatBrl(model.price.output) }));
  const ctx = formatContext(model?.contextWindow);
  if (ctx) parts.push(T('contextTag', { context: ctx }));
  if (model?.region === 'br-sp') parts.push(T('brTag'));
  return parts.join(' · ');
}

/** The model dropdown: every model, the chosen one selected (a saved id the list lacks is kept at the top). */
export function modelEntries(models, chosen, T) {
  const rows = Array.isArray(models) ? models.filter((m) => m && m.id) : [];
  const entries = rows.map((m) => ({ value: m.id, label: m.label || m.id, hint: modelTagline(m, T), selected: !!chosen && String(m.id).toLowerCase() === String(chosen).toLowerCase() }));
  if (chosen && !entries.some((e) => e.selected)) entries.unshift({ value: chosen, label: chosen, selected: true });
  if (!entries.length) entries.push({ value: '', label: T('modelDefault'), selected: true });
  return entries;
}

/** The levels a model row offers, as SynaBun names them (an older server's `xhigh` is `high`), in EFFORTS order. */
export function effortLevels(model) {
  const listed = new Set((Array.isArray(model?.efforts) ? model.efforts : []).map(normalizeEffort).filter(Boolean));
  return EFFORTS.filter((level) => listed.has(level));
}

/** The level a model uses when none is picked: the saved default when the model has it, else the model's own. */
export function defaultEffortFor(model, savedDefault = null) {
  const levels = effortLevels(model);
  if (!levels.length) return null;
  const saved = normalizeEffort(savedDefault);
  if (saved && levels.includes(saved)) return saved;
  const own = normalizeEffort(model?.defaultEffort);
  return own && levels.includes(own) ? own : levels[levels.length - 1];
}

/** The reasoning dropdown for a model (Settings): its levels with "Default" first, or nothing when it has none. */
export function effortEntries(model, chosen, T) {
  const levels = effortLevels(model);
  if (!levels.length) return [];
  const want = normalizeEffort(chosen);
  const entries = [{ value: '', label: T('effortDefault'), selected: !want || !levels.includes(want) }];
  for (const level of levels) entries.push({ value: level, label: T(`effort_${level}`), selected: want === level });
  return entries;
}

/**
 * The footer's Effort toggle and its menu, the Codex / Claude panels' control: what it shows for a tab's model and pick.
 *   supported  the model has levels (S5 family); else the toggle is shown disabled with `title` saying why
 *   level      the level the next reply uses ('none' | 'low' | 'medium' | 'high'), or null
 *   dots       lit dots out of 3 (Off 0, Low 1, Medium 2, High 3)
 *   items      the menu: Default (and what it is now), then each level, the tab's pick selected
 */
export function effortControl(model, picked, savedDefault, T) {
  const levels = effortLevels(model);
  const name = model?.label || model?.id || T('modelDefault');
  // No row yet (the model list has not arrived): say that, not that a model lacks levels.
  if (!levels.length) return { supported: false, level: null, dots: 0, label: T('effortLabel'), title: model ? T('effortUnsupported', { model: name }) : T('effortUnknown'), items: [] };
  const fallback = defaultEffortFor(model, savedDefault);
  const pick = normalizeEffort(picked);
  const chosen = pick && levels.includes(pick) ? pick : null;
  const level = chosen || fallback;
  const dots = { none: 0, low: 1, medium: 2, high: 3 }[level] ?? 0;
  const levelName = T(`effort_${level}`);
  const items = [{ value: '', label: T('effortDefault'), desc: T('effortDefaultDesc', { level: T(`effort_${fallback}`) }), selected: !chosen }]
    .concat(levels.map((value) => ({ value, label: T(`effort_${value}`), desc: T(`effortDesc_${value}`), selected: chosen === value })));
  return { supported: true, level, dots, label: T('effortLabel'), title: T(chosen ? 'effortTitle' : 'effortTitleDefault', { level: levelName, model: name }), items };
}

/** The spelling a server takes for a level: an older server's row lists `xhigh` (not `high`), and is sent that. */
export function effortForServer(level, model) {
  const want = normalizeEffort(level);
  if (!want) return undefined;
  const listed = Array.isArray(model?.efforts) ? model.efforts : [];
  if (!listed.length || listed.includes(want)) return want;
  const alias = Object.keys(EFFORT_ALIASES).find((name) => EFFORT_ALIASES[name] === want && listed.includes(name));
  return alias || want;
}

// ── Context window ───────────────────────────────────────────────────────────
// What a request carries is the history: the last reply's prompt plus its answer (reasoning is never sent back, so its
// tokens leave the window again). The share is against the window of the tab's current model, so switching a long S5
// conversation to a 128K model shows at once how close it is. The header cog's dot and the composer meter read this.
export const PRESSURE_HIGH = 80;
export const PRESSURE_CRITICAL = 90;

/** 216431 → "216k", 1000000 → "1M", 1250 → "1.3k". */
export function formatTokens(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1_000_000) { const m = n / 1_000_000; return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`; }
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function contextReading(transcript, model) {
  const size = Number(model?.contextWindow) || 0;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  const rows = transcript?.rows || [];
  let last = null;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === 'assistant' && rows[i].usage) { last = rows[i]; break; }
  const u = last?.usage || {};
  const input = n(u.prompt_tokens);
  const output = n(u.completion_tokens);
  const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens);
  const reasoning = Math.min(output, n(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens));
  const used = last ? input + output - reasoning : 0;
  const pct = last && size > 0 ? Math.min(100, (used / size) * 100) : null;
  const pressure = pct == null ? '' : pct >= PRESSURE_CRITICAL ? 'critical' : pct >= PRESSURE_HIGH ? 'high' : '';
  return { reported: !!last, used, size, pct, pressure, input, output, cached, reasoning };
}

/** "9%" (one decimal under 10%, "<1%" for a sliver); empty without a reading. */
export function formatShare(pct) {
  if (pct == null || !Number.isFinite(pct)) return '';
  if (pct > 0 && pct < 1) return '<1%';
  return `${pct < 10 ? pct.toFixed(1).replace(/\.0$/, '') : Math.round(pct)}%`;
}

// ── Plan mode ────────────────────────────────────────────────────────────────
/**
 * The plan the review card is for: the conversation's last row when it is a finished plan reply (mode 'plan', text,
 * no error, not stopped) the tab has not dismissed. A later message, a stop or a failure means there is nothing to review.
 */
export function planReview(transcript, tab) {
  const rows = transcript?.rows || [];
  const last = rows[rows.length - 1];
  if (!last || last.kind !== 'assistant' || last.mode !== 'plan' || last.streaming || last.error) return null;
  if (!String(last.text || '').trim()) return null;
  if (last.finishReason && !['stop', 'length'].includes(last.finishReason)) return null;
  const key = last.turnId || last.id;
  if (tab?.planDismissed && tab.planDismissed === key) return null;
  return last;
}
/** The id a dismissal is kept under: the turn's own id (row ids are made again on every load). */
export const planKey = (row) => row?.turnId || row?.id || null;

// ── The header cog's popover ─────────────────────────────────────────────────
/**
 * What the Context settings popover shows (the Claude / Codex / OpenCode panels' grammar: sections of label/value rows).
 * Plain values in, plain values out; mtc-render.js draws it. Nothing is guessed: what Maritaca has not reported is said
 * to be missing.
 */
export function contextMenuModel({ tab, transcript, model, status, hello, T }) {
  const reading = contextReading(transcript, model);
  const notYet = T('ctxNotReported');
  const effort = effortControl(model, tab?.effort, status?.settings?.reasoningEffort, T);
  const assistantRows = (transcript?.rows || []).filter((r) => r.kind === 'assistant');
  const messages = (transcript?.rows || []).length;
  const keyTone = !status?.configured ? 'err' : 'ok';
  const keyWord = !status?.configured ? T('ctxKeyMissing') : status.source === 'env' ? T('ctxKeyEnv', { masked: status.masked || '…' }) : T('ctxKeySaved', { masked: status.masked || '…' });
  const planReady = canUse(hello, 'plan-mode');
  const usageRows = reading.reported ? [
    [T('ctxLastInput'), formatTokens(reading.input)],
    [T('ctxLastOutput'), formatTokens(reading.output - reading.reasoning)],
    ...(reading.cached ? [[T('ctxCached'), formatTokens(reading.cached)]] : []),
    ...(reading.reasoning ? [[T('ctxReasoningTokens'), formatTokens(reading.reasoning)]] : []),
  ] : [];
  return {
    pressure: reading.pressure,
    context: {
      pct: reading.pct,
      usage: reading.reported ? (reading.size ? T('ctxUsage', { used: formatTokens(reading.used), size: formatTokens(reading.size) }) : formatTokens(reading.used)) : notYet,
      share: reading.reported ? formatShare(reading.pct) : '',
      headline: reading.reported ? T('ctxHeadline', { share: formatShare(reading.pct) || '?', used: formatTokens(reading.used), size: formatTokens(reading.size) || '?' }) : notYet,
      rows: [
        [T('model'), model?.label || model?.id || T('modelDefault')],
        [T('ctxWindow'), reading.size ? formatTokens(reading.size) : '—'],
        ...usageRows,
      ],
    },
    conversation: {
      id: tab?.sessionId || '',
      rows: [
        [T('ctxMode'), tab?.planMode ? T('planOn') : T('planOff')],
        [T('effortLabel'), effort.supported ? T(`effort_${effort.level}`) : T('ctxEffortNone')],
        [T('ctxMessages'), messages ? String(messages) : '—'],
        [T('ctxReplies'), assistantRows.length ? String(assistantRows.length) : '—'],
        [T('ctxCost'), assistantRows.length ? `R$ ${formatBrl(conversationCost(transcript))}` : '—'],
        // The saved settings each reply is sent with, so the dialog's choices are visible where they apply.
        [T('settingsSystem'), status?.settings?.systemPrompt ? T('ctxSystemOn', { count: String(status.settings.systemPrompt).length }) : T('ctxSystemOff')],
        [T('settingsTemperature'), temperatureLine(status?.settings?.temperature, model, T)],
        [T('ctxDraft'), T('draftHint', { chars: tab?.draft?.length || 0, tokens: Math.ceil((tab?.draft?.length || 0) / 4) })],
      ],
    },
    connection: {
      key: { tone: keyTone, word: keyWord },
      server: planReady ? { tone: 'ok', word: T('ctxServerReady') } : { tone: 'warn', word: T('ctxServerRestart') },
    },
  };
}

/** What the saved temperature means for this model: the default, the value, or the value the S5 family does not take. */
export function temperatureLine(temperature, model, T) {
  if (temperature === null || temperature === undefined || temperature === '' || !Number.isFinite(Number(temperature))) return T('ctxTempDefault');
  const fixed = typeof model?.fixedSampling === 'boolean' ? model.fixedSampling : model?.reasoning === true && model?.family === 's5';
  return fixed ? T('ctxTempIgnored', { value: String(temperature) }) : String(temperature);
}

/** The composer's context meter: the share and the words, or the window alone before the first reply. */
export function contextMeter(transcript, model, T) {
  const reading = contextReading(transcript, model);
  if (!reading.reported) return { pct: 0, pressure: '', text: reading.size ? T('ctxMeterEmpty', { size: formatTokens(reading.size) }) : '', title: T('ctxNotReported') };
  return {
    pct: reading.pct ?? 0, pressure: reading.pressure,
    text: reading.size ? T('ctxMeter', { share: formatShare(reading.pct), used: formatTokens(reading.used), size: formatTokens(reading.size) }) : formatTokens(reading.used),
    title: T('ctxHeadline', { share: formatShare(reading.pct) || '?', used: formatTokens(reading.used), size: formatTokens(reading.size) || '?' }),
  };
}

/** The row of `id` among `models` (case-insensitive, aliases too), else null. */
export function findModelRow(models, id) {
  const want = String(id || '').toLowerCase();
  if (!want) return null;
  return (models || []).find((m) => String(m?.id).toLowerCase() === want || (Array.isArray(m?.aliases) && m.aliases.some((a) => String(a).toLowerCase() === want))) || null;
}

// ── Status lines ─────────────────────────────────────────────────────────────
/** What the settings say about the key: a sentence, and whether the panel can send. */
export function keyStatusLine(status, T) {
  if (!status || typeof status !== 'object') return { text: T('settingsKeyNone'), configured: false };
  if (!status.configured) return { text: T('settingsKeyNone'), configured: false };
  if (status.source === 'env') return { text: T('settingsKeyEnv', { masked: status.masked || '…' }), configured: true };
  return { text: T('settingsKeySaved', { masked: status.masked || '…' }), configured: true };
}

/** The sentence under a finished reply: tokens, cost and time. */
export function usageParts(usage, costBrl, T) {
  const parts = [];
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  const fmt = (x) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}k` : String(x));
  if (usage) {
    const input = n(usage.prompt_tokens);
    const output = n(usage.completion_tokens);
    const cached = n(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens);
    if (input) parts.push(T('usage_in', { value: fmt(input) }));
    if (output) parts.push(T('usage_out', { value: fmt(output) }));
    if (cached) parts.push(T('usage_cached', { value: fmt(cached) }));
  }
  // A cost of exactly 0 is a free model's answer (S5-free) and is shown as R$ 0,00; null is "no price known".
  if (costBrl !== null && costBrl !== undefined && Number.isFinite(Number(costBrl)) && (Number(costBrl) > 0 || usage)) parts.push(T('costBrl', { value: formatBrl(costBrl) }));
  return parts;
}

export function durationLabel(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '';
  const s = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** The sentence a failed turn shows, by its code when the copy has one. */
export function turnErrorText(code, message, T) {
  const key = { NO_KEY: 'errorNoKey', KEY_REJECTED: 'errorKeyRejected', RATE_LIMITED: 'errorRateLimited', UNREACHABLE: 'errorUnreachable', TIMEOUT: 'errorUnreachable', DISCONNECTED: 'errorDisconnected', IMAGE_UNSUPPORTED: 'imageUnsupported', ATTACHMENT_COUNT: 'attachmentCount', ATTACHMENT_SIZE: 'attachmentTooLarge', ATTACHMENT_TYPE: 'attachmentTextOnly', ATTACHMENT_BINARY: 'attachmentTextOnly', ATTACHMENT_DATA: 'attachmentDamaged', PROMPT_TOO_LONG: 'promptTooLong' }[code];
  return key ? T(key, { count: 5 }) : T('turnFailed', { error: message || code || '?' });
}

/** A capability the server's hello lists. */
export function canUse(hello, capability) {
  return Array.isArray(hello?.capabilities) && hello.capabilities.includes(capability);
}

/** The settings form's values → the PUT body (never an empty key). */
export function settingsPatch({ key = '', model = '', reasoningEffort = '', systemPrompt = '', temperature = '' } = {}) {
  const patch = { model: model || undefined, reasoningEffort: normalizeEffort(reasoningEffort), systemPrompt: String(systemPrompt || ''), temperature: temperature === '' || temperature === null || temperature === undefined ? null : Number(temperature) };
  if (patch.model === undefined) delete patch.model;
  if (!Number.isFinite(patch.temperature)) patch.temperature = null;
  const trimmed = String(key || '').trim();
  if (trimmed) patch.key = trimmed;
  return patch;
}

/** The session list filtered by the search box. */
export function filterSessions(sessions, query) {
  const q = String(query || '').trim().toLowerCase();
  const list = Array.isArray(sessions) ? sessions : [];
  if (!q) return list;
  return list.filter((s) => `${s.title || ''} ${s.preview || ''} ${s.model || ''} ${s.project || ''}`.toLowerCase().includes(q));
}

/** Dropdown entries for the branch selector from `/api/terminal/branches`; not usable without a project or git. */
export function branchEntries(res, T = (k) => k) {
  const branches = Array.isArray(res?.branches) ? res.branches.filter((b) => typeof b === 'string' && b) : [];
  const current = typeof res?.current === 'string' ? res.current : '';
  if (!branches.length) return { entries: [{ value: '', label: T('noBranch'), selected: true }], current: '', usable: false };
  const list = current && !branches.includes(current) ? [current, ...branches] : branches;
  return { entries: list.map((b) => ({ value: b, label: b, selected: b === current })), current, usable: true };
}

/**
 * What a branch pick does before checkout (same rules as the Codex panel): `skip` (nothing to do),
 * `busy` (a turn runs), `incomplete` (git status cannot be trusted), `confirm` (uncommitted changes) or `go`.
 */
export function branchSwitchPlan({ project, branch, previous, running, status } = {}) {
  if (!project || !branch || branch === previous) return { action: 'skip' };
  if (running) return { action: 'busy' };
  if (!status?.ok || !status.isGit || status.partial || status.stale || status.timedOut) return { action: 'incomplete', error: status?.error || '' };
  const count = Array.isArray(status.changes) ? status.changes.length : 0;
  return count ? { action: 'confirm', count } : { action: 'go' };
}
