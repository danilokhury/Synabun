// ═══════════════════════════════════════════
// SynaBun — Assistant: the automation trace, as words (DOM-free)
// ═══════════════════════════════════════════
//
// One `synabun.automation` event per turn phase (lib/assistant-user-context.js)
// says what the harness did for the turn: what it put into the brain's context
// (the standing digest, the per-turn notes, the related memories), what it held
// back and why, and what it learned from the user's own words afterwards.
// This module turns one snapshot into the lines asst-render.js draws: nothing
// here touches the DOM, so it is unit-tested in Node.
//
// AUTOMATION_COPY is the English; `assistant.automation.*` in i18n/*.json must
// equal it (tests/assistant-automation-view.test.mjs).

export const AUTOMATION_EVENT = 'synabun.automation';

export const AUTOMATION_COPY = Object.freeze({
  title: 'Automation',
  'sum.turn': '{n} tok this turn',
  'sum.standing': '{n} standing',
  'sum.none': 'nothing injected',
  'state.waiting': 'learning after the reply',
  'state.running': 'learning…',
  'state.learned': 'learned 1 thing',
  'state.confirmed': 'confirmed 1 thing',
  'state.replaced': 'replaced 1 thing',
  'group.injected': 'Injected',
  'group.withheld': 'Withheld',
  'group.learning': 'Learning',
  'group.session': 'This conversation',
  'tier.greeting': 'Greeting',
  'tier.digest': 'Knowledge digest',
  'tier.last-thread': 'Last conversation',
  'tier.environment': 'Environment',
  'tier.open-item': 'Open item',
  'tier.cue': 'Knowledge cue',
  'tier.delta': 'New knowledge',
  'tier.recall': 'Related memories',
  'tier.knowledge': 'Knowledge of you',
  'tier.nudges': 'Recent-interaction nudges',
  'tier.turn': 'Per-turn notes',
  tok: '{n} tok',
  'meta.standing': 'system slot · frozen {time}',
  'meta.standingRef': 'already in the system slot, not resent',
  'meta.memories': '{n} memories',
  'meta.memory': '1 memory',
  'meta.alreadyPresent': 'already supplied earlier',
  'meta.budget': 'budget {used}/{max} tok',
  'meta.greetingWriter': 'said at session open · written ahead by {model}',
  'meta.greetingFallback': 'said at session open · from the records, no model',
  'reason.layer-off': 'switched off in Settings',
  'reason.nothing-known': 'nothing learned yet',
  'reason.no-recent-thread': 'no recent conversation to mention',
  'reason.in-greeting': 'already said in the greeting',
  'reason.budget': 'over the turn budget, kept for a later turn',
  'reason.not-ranked': 'not ranked relevant by Jev',
  'reason.in-digest': 'already in the digest',
  'reason.already-told': 'already told in this conversation',
  'reason.replaced': 'replaced by a newer statement',
  'reason.one-per-turn': 'one cue per turn',
  'reason.unusable': 'no usable statement',
  'reason.not-delivered': 'the turn ended before the notes could be delivered',
  'reason.trivial': 'trivial prompt',
  'reason.pattern': 'a command or an acknowledgement',
  'reason.judged': 'Jev: memory would not change the reply',
  'reason.nothing-retrieved': 'nothing relevant found',
  'reason.disabled': 'automatic recall is off',
  'reason.error': 'the search failed',
  'reason.system': 'not a prompt of yours',
  'learn.waiting': 'Your words are judged once the reply is done.',
  'learn.running': 'Jev is reading what you typed…',
  'learn.skipped': 'Not judged: {reason}.',
  'learn.cues': 'Cue words: {cues}',
  'learn.judged': 'Jev: lasting signal {p} · {facet} · {scope}',
  'learn.matched': 'Matches: {statement}',
  'learn.contradicts': 'Contradicts: {statement}',
  'learn.created': 'Learned: {statement}',
  'learn.updated': 'Confirmed (seen {n}×): {statement}',
  'learn.superseded': 'Replaced “{old}” with: {statement}',
  'learn.none': 'Nothing stored: {reason}.',
  'learn.evidence': 'Evidence: “{quote}”',
  'learn.writer': 'Written by {engine}',
  'learn.writerOwn': 'Kept as your own sentence ({reason})',
  'learn.writerKept': 'Statement kept as recorded',
  'learn.cost': '{requests} Jev requests · {tokens} tok · {cost}',
  'learn.scope.global': 'all projects',
  'skip.no-cue': 'no always / never / from-now-on wording',
  'skip.trivial': 'trivial prompt',
  'skip.short': 'too short',
  'skip.origin': 'not typed by you',
  'skip.untrusted': 'forwarded content',
  'skip.no-typed-text': 'only attachments or pasted text',
  'skip.seen': 'the same words were already judged',
  'skip.gate-cap': 'this conversation reached its limit of judgments',
  'skip.write-cap': 'this conversation reached its limit of learned facts',
  'skip.layer-off': 'Knowledge of you is off',
  'skip.system': 'not a prompt of yours',
  'none.not-durable': 'not a lasting preference',
  'none.no-answer': 'Jev did not answer',
  'none.jev-unavailable': 'Jev is off or has no key',
  'none.duplicate': 'memory already states this',
  'none.write-cap': 'this conversation reached its limit of learned facts',
  'none.no-evidence': 'no sentence carried it',
  'none.no-statement': 'no usable statement',
  'none.write-error': 'the memory write failed',
  'none.no-store': 'memory is not available',
  'none.error': 'the learning step failed',
  'writer.unverified': 'the rewrite could not be checked',
  'writer.not-faithful': 'the rewrite added something',
  'writer.no-writer': 'no writer model',
  'writer.writer-cap': 'writer limit reached',
  'writer.other': 'the writer failed',
  totals: 'Judged {gate}/{gateCap} · writer {writer}/{writerCap} · learned {writes}/{writeCap} · {tokens} tok injected over {turns} turns · {cost}',
  open: 'Open memory',
});

const fill = (text, params) => (params ? String(text).replace(/\{(\w+)\}/g, (_, key) => (params[key] != null ? params[key] : `{${key}}`)) : String(text));

/** The translator: `t(key, params)` when it knows the key, else the English above. */
export function automationText(t, key, params) {
  const full = `assistant.automation.${key}`;
  let value;
  try { value = typeof t === 'function' ? t(full, params) : undefined; } catch { value = undefined; }
  if (typeof value === 'string' && value && value !== full) return value;
  const fallback = AUTOMATION_COPY[key];
  return fallback == null ? key : fill(fallback, params);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** A dollar amount small enough to matter: 5 decimals under a cent, 2 above. */
export function formatUsd(value) {
  const n = num(value);
  if (n <= 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}` : `$${n.toFixed(2)}`;
}
const pct = (value) => `${Math.round(num(value) * 100)}%`;
const defaultTime = (iso) => {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '';
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};

function writerLine(tx, learning) {
  const action = learning.action || {};
  const writer = learning.writer || {};
  if (!action.engine) return null;
  if (action.engine === 'kept') return tx('learn.writerKept');
  if (action.engine === 'user-sentence') {
    const code = writer.reason && AUTOMATION_COPY[`writer.${writer.reason}`] ? writer.reason : 'other';
    return tx('learn.writerOwn', { reason: tx(`writer.${code}`) });
  }
  return tx('learn.writer', { engine: writer.verified != null ? `${action.engine} · ${pct(writer.verified)}` : action.engine });
}

/**
 * One snapshot → what the trace row shows.
 * → { traceId, phase, summary, state, tone, groups:[{ key, title, rows:[{ label, meta, text, pre, ids, tone }] }] }
 *   tone: '' | 'busy' | 'learned'. `pre`: `text` is exact injected text (keep its line breaks).
 */
export function automationView(ev = {}, { t = null, formatTime = defaultTime } = {}) {
  const tx = (key, params) => automationText(t, key, params);
  const tokens = ev.tokens || {};
  const injected = Array.isArray(ev.injected) ? ev.injected : [];
  const withheld = Array.isArray(ev.withheld) ? ev.withheld : [];
  const learning = ev.learning || {};
  const totals = ev.totals || {};
  const tok = (n) => tx('tok', { n: num(n) });
  const tier = (code) => tx(`tier.${AUTOMATION_COPY[`tier.${code}`] ? code : 'turn'}`);

  // ── the one-line summary ──
  const turnTokens = num(tokens.turn) + num(tokens.recall);
  const parts = [];
  if (turnTokens > 0) parts.push(tx('sum.turn', { n: turnTokens }));
  if (num(tokens.digest) > 0) parts.push(tx('sum.standing', { n: num(tokens.digest) }));
  const summary = parts.length ? parts.join(' · ') : tx('sum.none');
  let state = '';
  let tone = '';
  const action = learning.action || null;
  if (learning.state === 'waiting') { state = tx('state.waiting'); tone = 'busy'; }
  else if (learning.state === 'running') { state = tx('state.running'); tone = 'busy'; }
  else if (learning.state === 'done' && action && action.type && action.type !== 'none') {
    state = tx(action.type === 'update' ? 'state.confirmed' : action.type === 'supersede' ? 'state.replaced' : 'state.learned');
    tone = 'learned';
  }

  const groups = [];
  // ── injected ──
  const injectedRows = injected.map((item) => {
    const meta = [tok(item.tokens)];
    if (item.tier === 'digest') meta.push(item.text ? tx('meta.standing', { time: formatTime(item.frozenAt) }) : tx('meta.standingRef'));
    // The greeting: who wrote it and what that cost (the records it was built from are the links below it).
    if (item.tier === 'greeting') {
      meta.push(item.source === 'writer' ? tx('meta.greetingWriter', { model: item.model || 'Claude' }) : tx('meta.greetingFallback'));
      if (item.source === 'writer' && Number(item.costUsd) > 0) meta.push(formatUsd(item.costUsd));
    }
    if (item.tier === 'recall') {
      const n = Array.isArray(item.ids) ? item.ids.length : 0;
      meta.push(n === 1 ? tx('meta.memory') : tx('meta.memories', { n }));
      if (item.alreadyPresent) meta.push(tx('meta.alreadyPresent'));
    }
    return { label: tier(item.tier), meta: meta.filter(Boolean).join(' · '), text: item.text || '', pre: item.tier === 'digest' && !!item.text, ids: item.tier === 'recall' ? [] : (Array.isArray(item.ids) ? item.ids : []), tone: '' };
  });
  if (injectedRows.length) {
    if (num(tokens.budget) > 0) injectedRows.push({ label: tier('turn'), meta: tx('meta.budget', { used: num(tokens.turn), max: num(tokens.budget) }), text: '', pre: false, ids: [], tone: 'muted' });
    groups.push({ key: 'injected', title: tx('group.injected'), rows: injectedRows });
  }
  // ── withheld ──
  if (withheld.length) {
    groups.push({
      key: 'withheld', title: tx('group.withheld'),
      rows: withheld.map((item) => ({
        label: tier(item.tier), meta: tx(`reason.${AUTOMATION_COPY[`reason.${item.reason}`] ? item.reason : 'unusable'}`),
        text: item.text || '', pre: false, ids: Array.isArray(item.ids) ? item.ids : [], tone: 'muted',
      })),
    });
  }
  // ── learning ──
  const learnRows = [];
  const pre = learning.prefilter || {};
  if (learning.state === 'skipped') {
    learnRows.push({ label: '', meta: '', text: tx('learn.skipped', { reason: tx(`skip.${AUTOMATION_COPY[`skip.${pre.reason}`] ? pre.reason : 'no-cue'}`) }), pre: false, ids: [], tone: 'muted' });
  } else if (learning.state === 'waiting' || learning.state === 'running') {
    if (Array.isArray(pre.cues) && pre.cues.length) learnRows.push({ label: '', meta: '', text: tx('learn.cues', { cues: pre.cues.join(', ') }), pre: false, ids: [], tone: '' });
    learnRows.push({ label: '', meta: '', text: tx(learning.state === 'waiting' ? 'learn.waiting' : 'learn.running'), pre: false, ids: [], tone: 'muted' });
  } else if (learning.state === 'done') {
    const gate = learning.gate || null;
    if (Array.isArray(pre.cues) && pre.cues.length) learnRows.push({ label: '', meta: '', text: tx('learn.cues', { cues: pre.cues.join(', ') }), pre: false, ids: [], tone: '' });
    if (gate?.answered) {
      learnRows.push({ label: '', meta: '', text: tx('learn.judged', { p: pct(gate.durable), facet: gate.facet || '', scope: !gate.scope || gate.scope === 'global' ? tx('learn.scope.global') : gate.scope }), pre: false, ids: [], tone: '' });
      if (gate.contradicts) learnRows.push({ label: '', meta: pct(gate.contradicts.probability), text: tx('learn.contradicts', { statement: gate.contradicts.statement }), pre: false, ids: [gate.contradicts.id].filter(Boolean), tone: '' });
      else if (gate.match) learnRows.push({ label: '', meta: pct(gate.match.confidence), text: tx('learn.matched', { statement: gate.match.statement }), pre: false, ids: [gate.match.id].filter(Boolean), tone: '' });
    }
    const act = action || { type: 'none', reason: 'error' };
    if (act.type === 'none') {
      const code = AUTOMATION_COPY[`none.${act.reason}`] ? act.reason : 'error';
      const extra = act.reason === 'not-durable' && gate?.durable != null ? ` (${pct(gate.durable)})` : '';
      learnRows.push({ label: '', meta: '', text: tx('learn.none', { reason: `${tx(`none.${code}`)}${extra}` }), pre: false, ids: [act.duplicateOf].filter(Boolean), tone: 'muted' });
    } else {
      const text = act.type === 'update' ? tx('learn.updated', { n: num(act.seen) || 2, statement: act.statement })
        : act.type === 'supersede' ? tx('learn.superseded', { old: act.replaced || '', statement: act.statement })
          : tx('learn.created', { statement: act.statement });
      learnRows.push({ label: '', meta: [act.facet, !act.scope || act.scope === 'global' ? tx('learn.scope.global') : act.scope].filter(Boolean).join(' · '), text, pre: false, ids: [act.memoryId, act.supersedes].filter(Boolean), tone: 'learned' });
      if (act.evidence) learnRows.push({ label: '', meta: '', text: tx('learn.evidence', { quote: act.evidence }), pre: false, ids: [], tone: '' });
      const written = writerLine(tx, learning);
      if (written) learnRows.push({ label: '', meta: '', text: written, pre: false, ids: [], tone: 'muted' });
    }
    const cost = learning.cost || {};
    if (num(cost.jevRequests) > 0 || num(cost.writerUsd) > 0) {
      const writerTokens = cost.writerTokens ? num(cost.writerTokens.input) + num(cost.writerTokens.output) + num(cost.writerTokens.cacheRead) + num(cost.writerTokens.cacheWrite) : 0;
      learnRows.push({ label: '', meta: '', text: tx('learn.cost', { requests: num(cost.jevRequests), tokens: num(cost.jevInputTokens) + num(cost.jevOutputTokens) + writerTokens, cost: formatUsd(cost.totalUsd) }), pre: false, ids: [], tone: 'muted' });
    }
  }
  if (learnRows.length) groups.push({ key: 'learning', title: tx('group.learning'), rows: learnRows });
  // ── session totals ──
  if (num(totals.turns) > 0) {
    groups.push({
      key: 'session', title: tx('group.session'),
      rows: [{ label: '', meta: '', text: tx('totals', { gate: num(totals.gate), gateCap: num(totals.gateCap), writer: num(totals.writer), writerCap: num(totals.writerCap), writes: num(totals.writes), writeCap: num(totals.writeCap), tokens: num(totals.injectedTokens), turns: num(totals.turns), cost: formatUsd(totals.costUsd) }), pre: false, ids: [], tone: 'muted' }],
    });
  }
  return { traceId: String(ev.traceId || ''), phase: String(ev.phase || 'sent'), title: tx('title'), summary, state, tone, groups };
}

// ── typed words (the composer) ──────────────────────────────────────────────
// A paste this long, or this many lines, is text the user did not type
// (lib/assistant-user-context-budgets.js LEARN.pasteChars / pasteLines): the
// prompt still carries it, the `typed` text the server may learn from does not.
export const PASTE_MIN_CHARS = 200;
export const PASTE_MIN_LINES = 4;

export function isLongPaste(text) {
  const value = String(text ?? '');
  if (!value.trim()) return false;
  return value.length >= PASTE_MIN_CHARS || value.split(/\r\n|\r|\n/).filter((line) => line.trim()).length >= PASTE_MIN_LINES;
}

/** The composer's text without the long pastes still in it (those edited since count as typed). */
export function typedText(text, pastes = []) {
  let out = String(text ?? '').replace(/\r\n?/g, '\n');
  for (const paste of Array.isArray(pastes) ? pastes : []) {
    const block = String(paste ?? '').replace(/\r\n?/g, '\n').trim();
    if (block && out.includes(block)) out = out.split(block).join('\n');
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
