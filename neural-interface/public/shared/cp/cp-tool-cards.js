// ── Tool cards: call details, typed results, replayed cards (DOM glue) ──
// cp-tool-results.js decides what a call and its typed output mean; this file
// puts that on the card. Live tool results and replayed history take the same
// path, so a reopened session looks like the live one did.

import { cpCtx } from './cp-ctx.js';
import { escapeHtml } from './cp-markdown.js';
import {
  describeToolCall,
  describeCallSections,
  describeToolResult,
  inputRows,
  applyTaskTool,
  askAnswerRows,
} from './cp-tool-results.js';

const RICH_CARD_CLASSES = ['cp-bash-card', 'cp-diff-card', 'cp-agent-card', 'synabun-card', 'cp-history-card'];
const isGenericCard = (card) => card.classList.contains('tool-card') && !RICH_CARD_CLASSES.some(c => card.classList.contains(c));

const RESULT_CLIP = 2000;
const RESULT_HARD_CAP = 200_000;

function resultText(ev) {
  if (Array.isArray(ev?.content)) return ev.content.map(b => (b?.type === 'text' ? (b.text || '') : '')).filter(Boolean).join('\n');
  return typeof ev?.content === 'string' ? ev.content : '';
}

// ── Chips ──

function addChips(card, chips) {
  if (!chips?.length) return;
  const hdr = card.querySelector('.tool-hdr');
  if (!hdr) return;
  // After the last chip already there, else right after the detail text.
  const existing = [...hdr.querySelectorAll('.cp-chip')];
  const have = new Set(existing.map(c => c.textContent));
  let anchor = existing[existing.length - 1] || hdr.querySelector('.tool-detail');
  for (const c of chips) {
    if (!c?.text || have.has(c.text)) continue;
    have.add(c.text);
    const el = document.createElement(c.url ? 'a' : 'span');
    el.className = `cp-chip${c.tone ? ` cp-chip-${c.tone}` : ''}`;
    el.textContent = c.text;
    if (c.url) { el.href = c.url; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    if (anchor) anchor.after(el); else hdr.appendChild(el);
    anchor = el;
  }
}

// ── Sections ──

function sectionEl(section) {
  const box = document.createElement('div');
  box.className = `cp-result-section${section.tone ? ` cp-result-${section.tone}` : ''}`;
  if (section.label) {
    const label = document.createElement('div');
    label.className = 'tool-section-label';
    label.textContent = section.label;
    box.appendChild(label);
  }
  if (section.text) {
    const pre = document.createElement('pre');
    pre.className = 'cp-result-text';
    pre.textContent = section.text;
    box.appendChild(pre);
  }
  if (section.links?.length) {
    const list = document.createElement('div');
    list.className = 'cp-result-links';
    for (const l of section.links) {
      const a = document.createElement('a');
      a.className = 'cp-result-link';
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.title;
      a.title = l.url;
      list.appendChild(a);
    }
    box.appendChild(list);
  }
  if (section.items?.length) {
    for (const it of section.items) {
      const item = document.createElement('div');
      item.className = 'cp-result-item';
      const title = document.createElement('div');
      title.className = 'cp-result-item-title';
      title.textContent = it.title;
      item.appendChild(title);
      if (it.text) { const t = document.createElement('div'); t.className = 'cp-result-item-text'; t.textContent = it.text; item.appendChild(t); }
      if (it.note) { const n = document.createElement('div'); n.className = 'cp-result-item-note'; n.textContent = it.note; item.appendChild(n); }
      box.appendChild(item);
    }
  }
  return box;
}

function bodyOf(card) {
  return card.querySelector('.tool-body') || card.querySelector('.cp-agent-feed') || card;
}

/** Result text with a way to see all of it (the plain cut hid the rest for good). */
export function appendResultText(container, text) {
  const full = String(text ?? '');
  const pre = document.createElement('pre');
  pre.className = 'cp-result-text';
  pre.textContent = full.length > RESULT_CLIP ? full.slice(0, RESULT_CLIP) : full;
  container.appendChild(pre);
  if (full.length > RESULT_CLIP) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'cp-result-more';
    const shown = Math.min(full.length, RESULT_HARD_CAP);
    more.textContent = `Show all (${shown.toLocaleString('en-US')} characters)`;
    more.addEventListener('click', (e) => {
      e.stopPropagation?.();
      pre.textContent = full.slice(0, RESULT_HARD_CAP) + (full.length > RESULT_HARD_CAP ? '\n…' : '');
      more.remove();
    });
    container.appendChild(more);
  }
  return pre;
}

// ── The call ──

/**
 * After buildTool made a card: remember the input (the result needs it), show
 * the header detail and chips, and give generic cards a readable input.
 */
export function decorateToolCard(card, block) {
  if (!card || !block) return card;
  card._toolInput = block.input || {};
  if (!card.classList.contains('tool-card')) return card;
  const call = describeToolCall(block.name, block.input);
  addChips(card, call.chips);
  if (!isGenericCard(card)) return card;
  const detail = card.querySelector('.tool-detail');
  if (detail && call.detail) detail.textContent = call.detail;
  const body = card.querySelector('.tool-body');
  const raw = body?.querySelector('pre.tool-section');
  // Entering plan mode has no input to show: the card says what the mode means.
  if (block.name === 'EnterPlanMode') {
    card.classList.add('cp-plan-enter', 'open');
    const name = card.querySelector('.tool-name');
    if (name) name.textContent = 'Plan mode';
    const note = document.createElement('div');
    note.className = 'cp-tool-note cp-plan-enter-note';
    note.textContent = 'Claude explores the project and writes a plan. No file is edited and nothing with side effects runs until you approve the plan; the approval card appears when it is ready.';
    if (raw) raw.replaceWith(note); else body?.insertBefore(note, body.firstChild);
    return card;
  }
  if (raw) {
    const rows = inputRows(block.input);
    const kv = document.createElement('div');
    kv.className = 'cp-perm-kv cp-tool-input';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'cp-perm-kv-row';
      const key = document.createElement('span'); key.className = 'cp-perm-kv-key'; key.textContent = k;
      const val = document.createElement('span'); val.className = 'cp-perm-kv-val'; val.textContent = v;
      row.append(key, val);
      kv.appendChild(row);
    }
    raw.replaceWith(kv);
    const anchor = body.querySelector('.tool-result-label');
    for (const s of describeCallSections(block.name, block.input)) {
      const el = sectionEl(s);
      if (anchor) body.insertBefore(el, anchor); else body.appendChild(el);
    }
  }
  return card;
}

// ── The result ──

/**
 * Put a tool's typed output on its card: chips, sections, a note. Returns the
 * view (cards with their own result renderer read it) and `content`, the text
 * that should replace the raw result on a generic card.
 */
export function applyStructuredResult(tab, card, ev) {
  const name = card.dataset.toolName || '';
  const input = card._toolInput || {};
  const view = describeToolResult(name, input, ev.tool_use_result, { text: resultText(ev), isError: !!ev.is_error });
  const chips = [...view.chips];
  if (view.scheduledFor) {
    const d = new Date(view.scheduledFor);
    chips.unshift({ text: `wakes at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, tone: 'info' });
  }
  addChips(card, chips);
  const body = bodyOf(card);
  const before = body.querySelector('.tool-result-label');
  const put = (el) => { if (before) body.insertBefore(el, before); else body.appendChild(el); };
  if (view.note && !body.querySelector('.cp-tool-note')) {
    const note = document.createElement('div');
    note.className = 'cp-tool-note';
    note.textContent = view.note;
    put(note);
  }
  if (view.sections.length && !body.querySelector('.cp-result-section.cp-from-result')) {
    for (const s of view.sections) {
      const el = sectionEl(s);
      el.classList.add('cp-from-result');
      put(el);
    }
  }
  if (view.stats && !body.querySelector('.cp-agent-stats')) {
    const stats = document.createElement('div');
    stats.className = 'cp-agent-stats';
    stats.textContent = view.stats;
    body.appendChild(stats);
  }
  // The task tools keep the list the todo dock shows (root conversation only).
  if (!tab._agentScope && !ev.is_error) {
    const next = applyTaskTool(tab.todos, name, input, ev.tool_use_result);
    if (next) {
      tab.todos = next;
      try { cpCtx.renderTodoWidget(tab); } catch {}
    }
  }
  return { view, content: view.content };
}

// ── Replay: cards a reopened session shows for questions and plans ──

function historyCard(block, cls, title, detailText) {
  const card = document.createElement('div');
  card.className = `tool-card cp-history-card ${cls}`;
  card.dataset.toolId = block.id || '';
  card.dataset.toolName = block.name || '';
  card._toolInput = block.input || {};
  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr';
  const icon = document.createElement('span'); icon.className = 'tool-icon'; icon.innerHTML = cpCtx.toolIconSvg(block.name);
  const name = document.createElement('span'); name.className = 'tool-name'; name.textContent = title;
  const detail = document.createElement('span'); detail.className = 'tool-detail'; detail.textContent = detailText;
  const chevron = document.createElement('span'); chevron.className = 'tool-chevron'; chevron.innerHTML = '&#x203A;';
  hdr.append(icon, name, detail, chevron);
  const body = document.createElement('div');
  body.className = 'tool-body';
  card.append(hdr, body);
  return { card, body };
}

/**
 * The header of the card a plan file's Write gets. The file name is the model's
 * (any character a path allows), so it is escaped; the rest is fixed markup.
 */
export function planCardSummaryHtml(filePath) {
  const fileName = String(filePath || '').split(/[/\\]/).pop() || 'plan.md';
  return `<summary>
    <span class="plan-icon">P</span>
    <span class="plan-label">Plan</span>
    <span class="plan-file">${escapeHtml(fileName)}</span>
    <span class="plan-chevron">&#x203A;</span>
  </summary>`;
}

/** AskUserQuestion in a replayed transcript: what was asked; the answers fill in with its result. */
export function buildHistoryAskCard(block) {
  const questions = Array.isArray(block.input?.questions) ? block.input.questions : [];
  const { card, body } = historyCard(block, 'cp-ask-history open', 'Question', questions[0]?.header || questions[0]?.question || '');
  for (const row of askAnswerRows(block.input, null)) {
    const q = document.createElement('div');
    q.className = 'cp-ask-history-row';
    const text = document.createElement('div'); text.className = 'cp-ask-history-q'; text.textContent = row.header ? `${row.header}: ${row.question}` : row.question;
    const answer = document.createElement('div'); answer.className = 'cp-ask-history-a'; answer.textContent = row.answer || 'No answer recorded';
    q.append(text, answer);
    body.appendChild(q);
  }
  return card;
}

/** ExitPlanMode in a replayed transcript: the plan, and whether it was approved. */
export function buildHistoryPlanCard(block) {
  const { card, body } = historyCard(block, 'cp-plan-history', 'Plan', '');
  const plan = String(block.input?.plan || '').trim();
  const content = document.createElement('div');
  content.className = 'msg-body cp-plan-history-body';
  if (plan) content.innerHTML = cpCtx.md(plan); else content.textContent = 'No plan text recorded.';
  body.appendChild(content);
  return card;
}

/** A replayed result for one of the two cards above. True when it was one of them. */
export function fillHistoryCard($msgs, row) {
  const card = $msgs.querySelector(`.cp-history-card[data-tool-id="${CSS.escape(String(row.toolUseId || ''))}"]`);
  if (!card) return false;
  if (card.classList.contains('cp-ask-history')) {
    const rows = askAnswerRows(card._toolInput, row.structured, row.isError ? '' : (row.text || ''));
    const cells = card.querySelectorAll('.cp-ask-history-a');
    rows.forEach((r, idx) => { if (cells[idx] && r.answer) { cells[idx].textContent = r.answer; cells[idx].classList.add('cp-answered'); } });
    if (row.isError) addChips(card, [{ text: 'not answered', tone: 'warn' }]);
  } else {
    addChips(card, [row.isError ? { text: 'sent back', tone: 'warn' } : { text: 'approved', tone: 'ok' }]);
  }
  card.classList.add(row.isError ? 'tool-error' : 'tool-ok');
  return true;
}

/**
 * After a replay: cards whose result is not in the transcript (the turn was
 * interrupted, or the page holds only the latest part) stop looking busy.
 */
export function settleReplayedCards($msgs, tab) {
  for (const card of $msgs.querySelectorAll('.tool-card')) {
    if (card.classList.contains('cp-bash-card') && card.dataset.resolved !== '1') {
      card.dataset.resolved = '1';
      const elapsed = card.querySelector('.cp-bash-elapsed');
      if (elapsed) elapsed.textContent = '';
    }
    if (card.classList.contains('cp-diff-card') && !card.classList.contains('tool-ok') && !card.classList.contains('tool-error')) {
      card.classList.remove('open');
    }
    if (card.classList.contains('cp-agent-card') && card.dataset.resolved !== '1') {
      card.dataset.resolved = '1';
      const entry = tab?.agents?.get(card.dataset.toolId);
      if (entry) entry.status = 'unknown';
      const pill = card.querySelector('.cp-agent-pill');
      if (pill) { pill.classList.remove('cp-agent-running'); pill.textContent = '–'; }
      const now = card.querySelector('.cp-agent-now');
      if (now) now.textContent = 'no result in this transcript';
    }
  }
}
