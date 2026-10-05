// Session token usage. The headline is the whole assistant session (every task added up by the
// server from its ledger, so a follow-up prompt, a reload and a restart only ever add to it);
// the current task, its agents and the earlier tasks are the detail below it. Counts arrive
// already reconciled by the server.
import { getProviderMeta } from '../provider-icons.js';
const CLASSES = ['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning'];
const CLASS_LABELS = { input: ['inputUncached', 'Uncached input'], cacheWrite: ['cacheWrite', 'Cache write'], cacheRead: ['cacheRead', 'Cache read'], output: ['outputVisible', 'Visible output'], reasoning: ['reasoning', 'Reasoning'] };
const STATES = { queued: 'Queued', running: 'Running', idle: 'Idle', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const REASONS = {
  'no-baseline': ['reason.no-baseline', 'No starting count was available.'],
  'no-model-usage': ['reason.no-model-usage', 'Claude reported no model totals; only its main loop was counted.'],
  'counter-mismatch': ['reason.counter-mismatch', 'Provider totals went backwards; this turn uses its own reported count.'],
  'codex-no-records': ['reason.codex-no-records', 'Codex ended without final usage records.'],
  'codex-rollout-missing': ['reason.codex-rollout-missing', "Codex usage records were missing; the turn's own totals were used."],
  'opencode-not-reconciled': ['reason.opencode-not-reconciled', "OpenCode's final message check did not finish."],
  interrupted: ['reason.interrupted', 'A turn was interrupted; the call it cut off is counted from the stream.'],
  'no-result': ['reason.no-result', 'A run ended mid-turn; its last calls are counted from the stream.'],
};
const BASES = {
  reported: ['basis.reported', 'reported'],
  estimated: ['basis.estimated', 'list-price equivalent'],
  free: ['basis.free', 'free'],
  unpriced: ['basis.unpriced', 'no list price'],
};
/** What the two sides mean, for every provider (the tooltip and the note in the details). */
export const USAGE_SEMANTICS = 'Input is everything sent to the models: uncached input, cache writes and cache reads. Output is everything they generated, reasoning included. Every token is counted once and the same way for each provider: Codex reports cached tokens inside its input and reasoning inside its output, Claude reports them apart.';
export const USAGE_COST_NOTE = 'US dollars at API list prices. Claude Code reports what each turn cost; Codex and other plan-billed work is the list-price equivalent of its tokens, not a charge; free models count $0.';
let nextId = 0;
const node = (tag, cls, value) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (value != null) el.textContent = value;
  return el;
};
const valid = (n) => Number.isSafeInteger(n) && n >= 0;
const safe = (n) => (valid(n) ? n : 0);
const providerName = (id) => ['claude-code', 'codex', 'opencode'].includes(id) ? getProviderMeta(id).label : id === 'jev' ? 'Jev' : String(id || '');
const defaultTr = (_, fallback, params) => String(fallback).replace(/\{(\w+)\}/g, (_m, key) => params?.[key] ?? `{${key}}`);
export const formatExactTokens = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(valid(n) ? n : 0);
export function formatCompactTokens(n) {
  let value = valid(n) ? n : 0;
  if (value < 1000) return String(value);
  const units = ['K', 'M', 'B', 'T'];
  let unit = -1;
  do { value /= 1000; unit++; } while (value >= 999.95 && unit < units.length - 1);
  return `${value < 100 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}
export const formatUsageCost = (value, tr = (_, fallback) => fallback) =>
  value == null || !Number.isFinite(Number(value)) ? tr('assistant.usage.costUnavailable', 'Cost unavailable')
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
export const usageStatus = (task) => task?.live || task?.fidelity === 'live' ? 'live' : task?.fidelity === 'partial' ? 'partial' : 'exact';
export const statusLabel = (status, tr = (_, fallback) => fallback) => tr(`assistant.usage.${status}`, { live: 'Live', exact: 'Exact', partial: 'Partial' }[status] || 'Exact');
export const reasonLabel = (reason, tr = (_, fallback) => fallback) => {
  const [key, fallback] = REASONS[reason] || ['reason.other', 'A final token count was unavailable.'];
  return tr(`assistant.usage.${key}`, fallback);
};
/** How a dollar figure is known: 'reported', 'list-price equivalent' (plan-billed work), 'free', 'no list price'; '' when unknown. */
export const costBasisLabel = (basis, tr = (_, fallback) => fallback) => (BASES[basis] ? tr(`assistant.usage.${BASES[basis][0]}`, BASES[basis][1]) : '');
export function taskPartialReason(task) {
  if (task?.partialReason) return task.partialReason;
  if (task?.fidelity !== 'partial') return null;
  return (Array.isArray(task.agents) ? task.agents : []).find((agent) => agent?.fidelity === 'partial')?.partialReason || null;
}
export function orderedAgents(agents) {
  const list = Array.isArray(agents) ? agents : [];
  return [...list.filter((a) => a?.scope === 'brain'), ...list.filter((a) => a?.scope !== 'brain' && a?.scope !== 'judgments'), ...list.filter((a) => a?.scope === 'judgments')];
}
export function segmentWeights(agents) {
  const list = orderedAgents(agents);
  return list.map((agent) => ({ key: agent.key, grow: valid(agent?.tokens?.total) ? agent.tokens.total : 0, positive: agent?.tokens?.total > 0 }));
}
/**
 * The two sides of a tokens object and their sum: input (uncached + cache write + cache read)
 * and output (visible + reasoning). Reads the server's inputTotal / outputTotal, else adds the
 * classes up (an older packet); a packet with only a total gives input and output null.
 */
export function tokenSides(tokens) {
  const hasClasses = CLASSES.some((key) => valid(tokens?.[key]));
  const input = valid(tokens?.inputTotal) ? tokens.inputTotal : hasClasses ? safe(tokens.input) + safe(tokens.cacheWrite) + safe(tokens.cacheRead) : null;
  const output = valid(tokens?.outputTotal) ? tokens.outputTotal : hasClasses ? safe(tokens.output) + safe(tokens.reasoning) : null;
  return { input, output, total: valid(tokens?.total) ? tokens.total : safe(input) + safe(output) };
}
/**
 * The headline of a usage view: the session (every task added up). A packet without a usable
 * session block (an older server) falls back to its task, so something true is always shown.
 */
export function usageHeadline(view) {
  const session = view?.session;
  if (session && valid(session.tokens?.total)) {
    const status = session.live || session.fidelity === 'live' ? 'live' : session.fidelity === 'partial' ? 'partial' : session.fidelity === 'exact' ? 'exact' : usageStatus(view.task);
    // An older server sends no per-model session rows: the current task's stand in for the bar.
    const models = Array.isArray(session.models) ? session.models : Array.isArray(view.task?.models) ? view.task.models : [];
    return { scope: 'session', tokens: session.tokens, costUsd: session.costUsd, costBasis: session.costBasis || null, status, tasks: session.tasks, models };
  }
  const task = view?.task || {};
  return { scope: 'task', tokens: task.tokens || { total: 0 }, costUsd: task.costUsd, costBasis: task.costBasis || null, status: usageStatus(task), tasks: null, models: Array.isArray(task.models) ? task.models : [] };
}
/** The session's settled tokens (total minus what is still provisional), or null when the view cannot say. They only ever grow. */
export function settledTotal(view) {
  const session = view?.session;
  return session && valid(session.tokens?.total) && valid(session.pending?.total) ? session.tokens.total - session.pending.total : null;
}
/**
 * Is `next` older than `current`? Settled tokens never go down, so a view with fewer of them was
 * computed earlier (a packet that lost a race with a fetch). Views that cannot say (an older
 * server) keep the older rules: a lower task number, or a live replay of a task that settled.
 */
export function usagePacketIsStale(current, next) {
  if (!current) return false;
  const before = settledTotal(current);
  const after = settledTotal(next);
  // A view that can say is never held back by one that cannot (a snapshot saved by an older panel).
  if (after != null) return before != null && after < before;
  const previous = current.task;
  if (previous && Number.isFinite(Number(previous.n)) && Number.isFinite(Number(next?.task?.n)) && Number(next.task.n) < Number(previous.n)) return true;
  return !!previous && previous.id === next?.task?.id && usageStatus(previous) !== 'live' && usageStatus(next.task) === 'live';
}
/** One bar segment per model of the headline, most tokens first. */
export function modelSegments(models) {
  return (Array.isArray(models) ? models : []).map((row) => ({ key: `${row?.provider || ''}/${row?.model || ''}`, grow: safe(row?.tokens?.total), positive: row?.tokens?.total > 0 }));
}
export function formatRunTokens(tokens, fidelity, tr = (_, fallback) => fallback) {
  if (!valid(tokens?.total)) return null;
  const status = fidelity || tokens.fidelity || 'exact';
  const mark = status === 'live' ? '≈' : status === 'partial' ? '!' : '';
  return { text: `${mark}${formatCompactTokens(tokens.total)} ${tr('assistant.usage.tokenAbbr', 'tok')}`,
    label: `${formatExactTokens(tokens.total)} ${tr('assistant.usage.tokens', 'tokens')}, ${statusLabel(status, tr)}` };
}
/** "input 3,334,278 · output 52,367", or '' when the sides are not known. */
function sidesText(tokens, tr) {
  const sides = tokenSides(tokens);
  if (sides.input == null || sides.output == null) return '';
  return `${tr('assistant.usage.inputSide', 'input')} ${formatExactTokens(sides.input)} · ${tr('assistant.usage.outputSide', 'output')} ${formatExactTokens(sides.output)}`;
}
function costText(costUsd, basis, tr) {
  const money = formatUsageCost(costUsd, tr);
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return money;
  const how = costBasisLabel(basis, tr);
  return `${tr('assistant.usage.cost', 'Cost')} ${money}${how ? ` (${how})` : ''}`;
}
export function usageCopyText(view, tr = defaultTr) {
  const head = usageHeadline(view);
  const lines = [];
  if (head.scope === 'session') {
    const sides = sidesText(head.tokens, tr);
    lines.push(`${tr('assistant.usage.session', 'Session')}: ${formatExactTokens(head.tokens.total)} ${tr('assistant.usage.tokens', 'tokens')}${sides ? ` (${sides})` : ''} · ${statusLabel(head.status, tr)} · ${taskCount(head.tasks, tr)} · ${costText(head.costUsd, head.costBasis, tr)}`);
    if (CLASSES.some((key) => valid(head.tokens?.[key]))) for (const key of CLASSES) lines.push(`${tr(`assistant.usage.${CLASS_LABELS[key][0]}`, CLASS_LABELS[key][1])}: ${formatExactTokens(head.tokens?.[key])}`);
    if (head.models.length) {
      lines.push(tr('assistant.usage.models', 'Models'));
      for (const row of head.models) {
        const sidesOf = tokenSides(row.tokens);
        lines.push(tr('assistant.usage.modelSummary', '{model} ({provider}): input {input} · output {output} · {cost}', {
          model: row.model || '', provider: providerName(row.provider), input: formatExactTokens(sidesOf.input), output: formatExactTokens(sidesOf.output),
          cost: `${formatUsageCost(row.costUsd, tr)}${costBasisLabel(row.costBasis, tr) ? ` (${costBasisLabel(row.costBasis, tr)})` : ''}`,
        }));
      }
    }
  }
  const task = view.task;
  if (task) {
    const status = statusLabel(usageStatus(task), tr);
    const taskCost = formatUsageCost(task.costUsd, tr);
    const sides = sidesText(task.tokens, tr);
    lines.push(tr('assistant.usage.copySummary', 'Task {n}: {title}', { n: task.n ?? '', title: task.title || '' }));
    lines.push(`${formatExactTokens(task.tokens.total)} ${tr('assistant.usage.tokens', 'tokens')}${sides ? ` (${sides})` : ''} · ${status} · ${task.costUsd == null || !Number.isFinite(Number(task.costUsd)) ? taskCost : `${tr('assistant.usage.cost', 'Cost')} ${taskCost}`}`);
    if (usageStatus(task) === 'partial') lines.push(reasonLabel(taskPartialReason(task), tr));
    // A packet without a session block: the task's classes are the only ones there are.
    if (head.scope !== 'session') for (const key of CLASSES) lines.push(`${tr(`assistant.usage.${CLASS_LABELS[key][0]}`, CLASS_LABELS[key][1])}: ${formatExactTokens(task.tokens?.[key])}`);
    lines.push(tr('assistant.usage.agents', 'Agents'));
    for (const a of orderedAgents(task.agents)) {
      const params = { title: a.title || '', provider: providerName(a.provider), model: a.model || '', tokens: formatExactTokens(a.tokens?.total), state: tr(`assistant.usage.${a.state}`, STATES[a.state] || a.state || ''), fidelity: statusLabel(a.fidelity || usageStatus(task), tr) };
      const key = a.scope === 'judgments' ? 'judgmentSummary' : a.model ? 'agentSummary' : 'agentSummaryNoModel';
      const fallback = key === 'judgmentSummary' ? '{title}: {tokens} tokens, {state}, {fidelity}' : key === 'agentSummary' ? '{title} ({provider}, {model}): {tokens} tokens, {state}, {fidelity}' : '{title} ({provider}): {tokens} tokens, {state}, {fidelity}';
      lines.push(tr(`assistant.usage.${key}`, fallback, params));
    }
  }
  lines.push(tr('assistant.usage.recent', 'Last five tasks'));
  for (const r of (view.recent || []).slice(0, 5)) lines.push(`${r.n}. ${r.title || ''}: ${formatExactTokens(r.total)} ${tr('assistant.usage.tokens', 'tokens')} · ${statusLabel(r.fidelity || (r.live ? 'live' : 'exact'), tr)} · ${formatUsageCost(r.costUsd, tr)}`);
  if (!view.recent?.length) lines.push(tr('assistant.usage.noRecent', 'No earlier tasks'));
  lines.push(tr('assistant.usage.semantics', USAGE_SEMANTICS));
  lines.push(tr('assistant.usage.costNote', USAGE_COST_NOTE));
  return lines.join('\n');
}
function taskCount(n, tr) {
  return n === 1 ? tr('assistant.usage.tasksOne', '1 task') : n > 1 ? tr('assistant.usage.tasksMany', '{n} tasks', { n }) : tr('assistant.usage.tasksZero', '0 tasks');
}

export function createUsageGauge(host, { t, sessionId } = {}) {
  const tr = (key, fallback, params) => {
    const found = typeof t === 'function' ? t(key, params) : null;
    return typeof found === 'string' && found !== key ? found : defaultTr(key, fallback, params);
  };
  const label = () => tr('assistant.usage.session', 'Session');
  const taskLabel = () => tr('assistant.usage.task', 'Current task');
  const strip = node('button', 'asst-usage-strip'); strip.type = 'button';
  const details = node('div', 'asst-usage-popover');
  details.id = `asst-usage-details-${++nextId}`; details.setAttribute('role', 'region'); details.setAttribute('aria-label', label()); details.hidden = true;
  strip.setAttribute('aria-controls', details.id); strip.setAttribute('aria-expanded', 'false');
  strip.title = `${tr('assistant.usage.semantics', USAGE_SEMANTICS)}\n${tr('assistant.usage.costNote', USAGE_COST_NOTE)}`;
  const dot = node('span', 'asst-usage-dot'); dot.setAttribute('aria-hidden', 'true');
  const bar = node('span', 'asst-usage-segments'); bar.setAttribute('aria-hidden', 'true');
  const mark = node('span', 'asst-usage-mark'); mark.setAttribute('aria-hidden', 'true');
  // The two sides, then their sum, then the dollars: input and output are never merged into one number only.
  const io = node('span', 'asst-usage-io'); const ioIn = node('span', 'asst-usage-in'); const ioOut = node('span', 'asst-usage-out'); io.append(ioIn, ioOut);
  const compact = node('span', 'asst-usage-compact');
  const stripCost = node('span', 'asst-usage-strip-cost');
  const chev = node('span', 'asst-usage-chevron', '⌃'); chev.setAttribute('aria-hidden', 'true');
  strip.append(dot, node('span', 'asst-usage-label', label()), bar, mark, io, compact, stripCost, chev);
  // A narrow panel has no room for the two sides inside the strip: they sit on a line under it.
  const subline = node('div', 'asst-usage-subline'); subline.setAttribute('aria-hidden', 'true');
  // ── details: the session first ──
  const head = node('div', 'asst-usage-head'); const headMain = node('div', 'asst-usage-head-main');
  const title = node('h2', 'asst-usage-task-title');
  headMain.append(node('div', 'asst-usage-eyebrow', label()), title);
  const copy = node('button', 'asst-usage-copy', tr('assistant.usage.copy', 'Copy')); copy.type = 'button';
  head.append(headMain, copy);
  const totalLine = node('div', 'asst-usage-total-line'); const total = node('strong', 'asst-usage-total');
  totalLine.append(total, node('span', 'asst-usage-total-unit', tr('assistant.usage.tokens', 'tokens')));
  const sides = node('dl', 'asst-usage-sides');
  const side = (cls, name) => { const item = node('div', `asst-usage-side ${cls}`); const dd = node('dd'); item.append(node('dt', '', name), dd); sides.append(item); return dd; };
  const sideIn = side('asst-usage-side-in', tr('assistant.usage.inputTotal', 'Input'));
  const sideOut = side('asst-usage-side-out', tr('assistant.usage.outputTotal', 'Output'));
  const sideCost = side('asst-usage-side-cost', tr('assistant.usage.cost', 'Cost'));
  const meta = node('div', 'asst-usage-meta'); const cost = node('span', 'asst-usage-cost'); const status = node('span', 'asst-usage-status');
  const reason = node('span', 'asst-usage-reason'); reason.hidden = true;
  const connection = node('span', 'asst-usage-connection'); connection.hidden = true;
  meta.append(status, cost, reason, connection);
  const section = (name) => { const el = node('section', 'asst-usage-section'); el.append(node('h3', 'asst-usage-section-title', name)); details.append(el); return el; };
  details.append(head, totalLine, sides, meta);
  const classesSection = section(tr('assistant.usage.classes', 'Token classes'));
  const classes = node('dl', 'asst-usage-classes'); const classValues = {};
  for (const key of CLASSES) { const item = node('div', 'asst-usage-class'); item.dataset.tokenClass = key; const dt = node('dt', '', tr(`assistant.usage.${CLASS_LABELS[key][0]}`, CLASS_LABELS[key][1])); const dd = node('dd'); classValues[key] = dd; item.append(dt, dd); classes.append(item); }
  classesSection.append(classes, node('p', 'asst-usage-note', tr('assistant.usage.semantics', USAGE_SEMANTICS)));
  const modelsSection = section(tr('assistant.usage.models', 'Models'));
  const modelList = node('ul', 'asst-usage-model-list');
  modelsSection.append(modelList, node('p', 'asst-usage-note', tr('assistant.usage.costNote', USAGE_COST_NOTE)));
  // ── the current task and its agents ──
  const taskSection = section(taskLabel());
  const taskTitle = node('div', 'asst-usage-task-name'); const taskLine = node('div', 'asst-usage-task-line');
  const agentsHeading = node('h4', 'asst-usage-agents-title');
  const agentList = node('ul', 'asst-usage-agent-list'); const judgments = node('ul', 'asst-usage-judgments');
  const noAgents = node('div', 'asst-usage-agent-empty', tr('assistant.usage.noAgents', 'Agent attribution pending'));
  taskSection.append(taskTitle, taskLine, agentsHeading, noAgents, agentList, judgments);
  const recentSection = section(tr('assistant.usage.recent', 'Last five tasks')); const recentList = node('ul', 'asst-usage-recent-list'); recentSection.append(recentList);
  const announcer = node('div', 'asst-usage-announcer'); announcer.setAttribute('role', 'status'); announcer.setAttribute('aria-live', 'polite'); announcer.setAttribute('aria-atomic', 'true');
  host.append(strip, subline, details, announcer); host.hidden = true;
  let view = null, connectionState = 'online', frame = 0, tween = 0, displayed = 0, rowsKey = '', rowMap = new Map(), segmentsKey = '', segments = new Map(), copyTimer = 0, warned = false, mismatchTask = '';
  const expanded = () => strip.getAttribute('aria-expanded') === 'true';
  function accessibleName() {
    const headline = view ? usageHeadline(view) : null;
    if (!headline || (document.activeElement === strip && headline.status === 'live')) return;
    const both = tokenSides(headline.tokens);
    const key = expanded() ? 'toggleSessionClose' : 'toggleSession';
    let name = tr(`assistant.usage.${key}`, `Token usage for this session: {total} tokens, {input} input and {output} output, {cost}, {status}. ${expanded() ? 'Hide' : 'Show'} details.`, {
      total: formatExactTokens(headline.tokens.total), input: formatExactTokens(both.input), output: formatExactTokens(both.output),
      cost: formatUsageCost(headline.costUsd, tr), status: statusLabel(headline.status, tr),
    });
    if (connectionState !== 'online') name += ` ${tr('assistant.usage.updatesPaused', 'Updates paused. Showing the last received count.')}`;
    strip.setAttribute('aria-label', name);
  }
  function setOpen(open, focus = false) {
    details.hidden = !open; strip.setAttribute('aria-expanded', String(open)); host.dataset.expanded = String(open);
    accessibleName(); if (focus) strip.focus();
  }
  strip.addEventListener('click', () => setOpen(!expanded()));
  strip.addEventListener('focus', accessibleName);
  strip.addEventListener('blur', () => requestAnimationFrame(accessibleName));
  const onKey = (e) => { if (e.key === 'Escape' && expanded()) { e.preventDefault(); e.stopPropagation(); setOpen(false, true); } };
  const onPointer = (e) => { if (expanded() && !host.contains(e.target)) setOpen(false); };
  document.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', onPointer, true);
  function makeRow(a) {
    const li = node('li', 'asst-usage-agent'); li.dataset.agentKey = a.key;
    const top = node('div', 'asst-usage-agent-top'); const name = node('span', 'asst-usage-agent-title'); const count = node('strong', 'asst-usage-agent-total'); top.append(name, count);
    const m = node('div', 'asst-usage-agent-meta'); const model = node('span', 'asst-usage-agent-model'); const divider = node('span', '', '·'); divider.setAttribute('aria-hidden', 'true'); const state = node('span', 'asst-usage-agent-state'); m.append(model, divider, state);
    const share = node('div', 'asst-usage-agent-share'); share.setAttribute('aria-hidden', 'true'); share.append(node('span'));
    const sub = node('div', 'asst-usage-subagents'); const why = node('div', 'asst-usage-agent-reason');
    li.append(top, m, share, sub, why); return li;
  }
  function rebuildAgents(agents) {
    agentList.replaceChildren(); judgments.replaceChildren(); rowMap = new Map();
    for (const [i, a] of agents.entries()) {
      const row = makeRow(a); row.style.setProperty('--usage-fill', `var(--asst-usage-neutral-${i % 8})`);
      (a.scope === 'judgments' ? judgments : agentList).append(row); rowMap.set(a.key, row);
    }
    const ordinary = agents.filter((a) => a.scope !== 'judgments').length;
    agentsHeading.textContent = tr('assistant.usage.agentsCount', 'Agents · {n}', { n: ordinary });
    noAgents.hidden = agents.length > 0; judgments.hidden = !agents.some((a) => a.scope === 'judgments');
    host.dataset.agentCount = String(ordinary);
  }
  /** The bar: one segment per model of the session. */
  function rebuildSegments(list) {
    bar.replaceChildren(); segments = new Map();
    for (const [i, item] of list.entries()) {
      const seg = node('span', 'asst-usage-segment'); seg.dataset.modelKey = item.key; seg.style.setProperty('--usage-fill', `var(--asst-usage-neutral-${i % 8})`); bar.append(seg); segments.set(item.key, seg);
    }
    bar.style.gap = list.length <= 7 ? '2px' : list.length <= 20 ? '1px' : '0';
  }
  function renderModels(headline) {
    modelList.replaceChildren();
    for (const row of headline.models) {
      const both = tokenSides(row.tokens);
      const li = node('li', 'asst-usage-model'); li.dataset.costBasis = row.costBasis || '';
      const top = node('div', 'asst-usage-model-top');
      top.append(node('span', 'asst-usage-model-name', row.model || providerName(row.provider)), node('strong', 'asst-usage-model-cost', formatUsageCost(row.costUsd, tr)));
      const io2 = node('div', 'asst-usage-model-io');
      io2.append(
        node('span', 'asst-usage-model-in', `${tr('assistant.usage.inputSide', 'input')} ${formatExactTokens(both.input)}`),
        node('span', 'asst-usage-model-out', `${tr('assistant.usage.outputSide', 'output')} ${formatExactTokens(both.output)}`),
      );
      const how = [providerName(row.provider), costBasisLabel(row.costBasis, tr)].filter(Boolean).join(' · ');
      li.append(top, io2, node('div', 'asst-usage-model-meta', how));
      modelList.append(li);
    }
    modelsSection.hidden = headline.models.length === 0;
  }
  function renderTask(task) {
    taskSection.hidden = !task;
    if (!task) { host.dataset.agentCount = '0'; return; }
    const state = usageStatus(task), agents = orderedAgents(task.agents);
    const attributionDelta = task.tokens.total - agents.reduce((sum, agent) => sum + (valid(agent.tokens?.total) ? agent.tokens.total : 0), 0);
    host.dataset.attributionDelta = String(attributionDelta);
    if (agents.length && attributionDelta && mismatchTask !== task.id) {
      console.warn('[assistant] usage attribution differs from task total', { taskId: task.id, attributionDelta });
      mismatchTask = task.id;
    }
    const nextRowsKey = `${task.id}|${agents.map((a) => `${a.scope}:${a.key}`).join('|')}`;
    if (rowsKey !== nextRowsKey) { rebuildAgents(agents); rowsKey = nextRowsKey; }
    taskTitle.textContent = task.title || taskLabel(); taskTitle.title = task.title || '';
    const both = sidesText(task.tokens, tr);
    const taskCostText = task.costUsd == null || !Number.isFinite(Number(task.costUsd)) ? formatUsageCost(task.costUsd, tr) : `${tr('assistant.usage.cost', 'Cost')} ${formatUsageCost(task.costUsd, tr)}`;
    taskLine.textContent = [`${formatExactTokens(task.tokens.total)} ${tr('assistant.usage.tokens', 'tokens')}`, both, taskCostText, statusLabel(state, tr), state === 'partial' ? reasonLabel(taskPartialReason(task), tr) : ''].filter(Boolean).join(' · ');
    taskLine.dataset.fidelity = state;
    for (const a of agents) {
      const n = valid(a.tokens?.total) ? a.tokens.total : 0, row = rowMap.get(a.key);
      row.dataset.state = a.state || ''; row.dataset.fidelity = a.fidelity || state; row.dataset.partialReason = a.partialReason || '';
      row.querySelector('.asst-usage-agent-title').textContent = a.scope === 'judgments' ? tr('assistant.usage.judgments', 'Judgments (Jev)') : a.title || (a.scope === 'brain' ? tr('assistant.budget.brainRow', 'Brain') : a.key);
      row.querySelector('.asst-usage-agent-total').textContent = formatExactTokens(n);
      row.querySelector('.asst-usage-agent-model').textContent = a.scope === 'judgments' ? 'Jev' : [providerName(a.provider), a.model].filter(Boolean).join(' · ');
      const stateNode = row.querySelector('.asst-usage-agent-state'); stateNode.dataset.state = a.state || ''; stateNode.dataset.fidelity = a.fidelity || state;
      stateNode.textContent = `${tr(`assistant.usage.${a.state}`, STATES[a.state] || a.state || '')} · ${statusLabel(a.fidelity || state, tr)}`;
      row.querySelector('.asst-usage-agent-share > span').style.width = `${task.tokens.total ? Math.min(100, n / task.tokens.total * 100) : 0}%`;
      const sub = row.querySelector('.asst-usage-subagents'); sub.hidden = !(a.subagents?.total > 0); sub.textContent = sub.hidden ? '' : tr('assistant.usage.subagents', 'incl. sub-agents {n} tokens', { n: formatExactTokens(a.subagents.total) });
      const why = row.querySelector('.asst-usage-agent-reason'); why.hidden = a.fidelity !== 'partial'; why.textContent = why.hidden ? '' : reasonLabel(a.partialReason, tr);
    }
  }
  function render() {
    frame = 0; if (!view) return;
    const headline = usageHeadline(view), task = view.task || null, state = headline.status;
    host.hidden = !(headline.tokens.total > 0); if (host.hidden) { setOpen(false); return; }
    const both = tokenSides(headline.tokens);
    host.dataset.status = state; host.dataset.fidelity = state; host.dataset.scope = headline.scope;
    host.dataset.partialReason = state === 'partial' ? taskPartialReason(task) || '' : '';
    host.dataset.sessionTotal = String(headline.tokens.total); host.dataset.taskTotal = String(task?.tokens?.total ?? 0);
    mark.textContent = state === 'live' ? '≈' : state === 'partial' ? '!' : '';
    // Segments: the session's models, gold while an agent of the current task runs on that model.
    const list = modelSegments(headline.models);
    const nextSegmentsKey = list.map((item) => item.key).join('|');
    if (segmentsKey !== nextSegmentsKey) { rebuildSegments(list); segmentsKey = nextSegmentsKey; }
    const working = new Set((task?.agents || []).filter((a) => a.scope !== 'judgments' && a.state === 'running').map((a) => `${a.provider || ''}/${a.model || ''}`));
    for (const item of list) {
      const seg = segments.get(item.key);
      seg.style.flexGrow = String(item.grow); seg.dataset.positive = String(item.positive); seg.dataset.working = String(working.has(item.key));
    }
    title.textContent = taskCount(headline.tasks ?? (task ? 1 : 0), tr);
    const target = headline.tokens.total;
    if (tween) cancelAnimationFrame(tween);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = displayed, start = performance.now();
    const tick = (now) => {
      const p = reduced || from === 0 ? 1 : Math.min(1, (now - start) / 280);
      displayed = Math.round(from + (target - from) * p);
      compact.textContent = `${formatCompactTokens(displayed)} ${tr('assistant.usage.tokenAbbr', 'tok')}`;
      total.textContent = formatExactTokens(displayed);
      if (p < 1) tween = requestAnimationFrame(tick); else tween = 0;
    };
    tick(start);
    io.hidden = both.input == null || both.output == null;
    ioIn.textContent = `${tr('assistant.usage.inShort', 'in')} ${formatCompactTokens(both.input)}`;
    ioOut.textContent = `${tr('assistant.usage.outShort', 'out')} ${formatCompactTokens(both.output)}`;
    const money = headline.costUsd != null && Number.isFinite(Number(headline.costUsd));
    stripCost.hidden = !money; stripCost.textContent = money ? formatUsageCost(headline.costUsd, tr) : '';
    subline.hidden = io.hidden && !money;
    subline.textContent = [io.hidden ? '' : ioIn.textContent, io.hidden ? '' : ioOut.textContent, stripCost.textContent].filter(Boolean).join(' · ');
    sideIn.textContent = both.input == null ? '—' : formatExactTokens(both.input);
    sideOut.textContent = both.output == null ? '—' : formatExactTokens(both.output);
    sideCost.textContent = formatUsageCost(headline.costUsd, tr);
    cost.textContent = money ? costBasisLabel(headline.costBasis, tr) : '';
    cost.hidden = !cost.textContent;
    status.textContent = statusLabel(state, tr);
    reason.hidden = state !== 'partial'; reason.textContent = state === 'partial' ? reasonLabel(taskPartialReason(task), tr) : '';
    for (const key of CLASSES) classValues[key].textContent = formatExactTokens(headline.tokens?.[key]);
    classesSection.hidden = !CLASSES.some((key) => valid(headline.tokens?.[key]));
    renderModels(headline);
    renderTask(task);
    recentList.replaceChildren();
    for (const r of (view.recent || []).slice(0, 5)) {
      const li = node('li', 'asst-usage-recent-item'), txt = node('span', 'asst-usage-recent-title', `${r.n}. ${r.title || ''}`);
      const m = node('span', 'asst-usage-recent-meta'); const s = node('span', 'asst-usage-recent-status', statusLabel(r.fidelity || (r.live ? 'live' : 'exact'), tr)); s.dataset.fidelity = r.fidelity || 'exact';
      const io3 = valid(r.inputTotal) && valid(r.outputTotal) ? ` · ${tr('assistant.usage.inShort', 'in')} ${formatCompactTokens(r.inputTotal)} · ${tr('assistant.usage.outShort', 'out')} ${formatCompactTokens(r.outputTotal)}` : '';
      m.append(s, document.createTextNode(`${io3} · ${formatUsageCost(r.costUsd, tr)}`)); txt.append(m);
      li.append(txt, node('span', 'asst-usage-recent-total', formatExactTokens(r.total))); recentList.append(li);
    }
    if (!view.recent?.length) recentList.append(node('li', 'asst-usage-recent-empty', tr('assistant.usage.noRecent', 'No earlier tasks')));
    accessibleName();
  }
  function apply(packet) {
    const headlineOk = valid(packet?.session?.tokens?.total) || valid(packet?.task?.tokens?.total);
    if (packet?.sessionId !== sessionId || !headlineOk || (packet.task && (!packet.task.id || !valid(packet.task.tokens?.total)))) {
      if (!warned) { console.warn('[assistant] invalid usage packet'); warned = true; }
      return false;
    }
    if (usagePacketIsStale(view, packet)) return false;
    const before = view ? usageHeadline(view) : null;
    // A new task does not close the details: the session they describe is the same one.
    view = packet; connectionState = 'online'; host.dataset.connection = 'online'; connection.hidden = true;
    const after = usageHeadline(packet);
    if (before && before.status === 'live' && after.status !== 'live') {
      announcer.textContent = tr('assistant.usage.settledSession', 'Session usage settled: {total} tokens, {status}.', { total: formatExactTokens(after.tokens.total), status: statusLabel(after.status, tr) });
    }
    if (!frame) frame = requestAnimationFrame(render);
    return true;
  }
  function setConnection(next) {
    connectionState = next === 'attached-elsewhere' ? 'paused' : next === 'reconnecting' || next === 'closed' ? 'offline' : next === 'open' ? (view ? connectionState : 'online') : connectionState;
    host.dataset.connection = connectionState;
    connection.hidden = connectionState === 'online'; connection.textContent = connection.hidden ? '' : tr('assistant.usage.updatesPaused', 'Updates paused. Showing the last received count.');
    accessibleName();
  }
  async function doCopy() {
    if (!view) return;
    const content = usageCopyText(view, tr);
    let ok = false;
    try { await navigator.clipboard.writeText(content); ok = true; } catch { /* local fallback */ }
    if (!ok) {
      const area = node('textarea'); area.value = content; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
      try { ok = document.execCommand('copy'); } catch { /* clipboard unavailable */ }
      area.remove(); copy.focus();
    }
    copy.textContent = tr(ok ? 'assistant.usage.copied' : 'assistant.usage.copyFailed', ok ? 'Copied' : 'Could not copy');
    clearTimeout(copyTimer); copyTimer = setTimeout(() => { copy.textContent = tr('assistant.usage.copy', 'Copy'); }, 1800);
  }
  copy.addEventListener('click', doCopy);
  return { apply, setConnection, destroy() { if (frame) cancelAnimationFrame(frame); if (tween) cancelAnimationFrame(tween); clearTimeout(copyTimer); document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onPointer, true); host.replaceChildren(); }, getView: () => view };
}
