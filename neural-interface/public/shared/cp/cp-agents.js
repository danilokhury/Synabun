// ── Nested subagent cards (Task / Agent tool) ──
//
// Every SDK message carries parent_tool_use_id; messages emitted by a subagent
// reference the Task tool_use that spawned it. ensureAgentScope() returns a
// prototype-inheriting "scope" object — Object.create(tab) with its OWN
// messagesEl / currentMsgEl / currentMsgId / _stream — so the monolith's
// existing renderers (renderAssistant, handleStreamDelta, updateToolResult,
// buildTool) work unchanged inside the agent's nested feed. Tab-level reads
// fall through the prototype chain; per-feed writes land on the scope.

import { cpCtx } from './cp-ctx.js';

const AGENT_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="3"/><path d="M5 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/><path d="M19 3l1.5 1.5M22 2l-1.5 1.5"/></svg>';
const MAX_FEED_CHILDREN = 80;

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function buildAgentCard(block, tab) {
  const card = document.createElement('div');
  card.className = 'tool-card cp-agent-card';
  card.dataset.toolId = block.id || '';
  card.dataset.toolName = block.name || 'Task';

  const i = block.input || {};
  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr cp-agent-hdr';
  const icon = document.createElement('span'); icon.className = 'tool-icon cp-agent-icon';
  icon.innerHTML = AGENT_ICON;
  const type = document.createElement('span');
  type.className = 'cp-agent-type';
  type.textContent = i.subagent_type || 'agent';
  const desc = document.createElement('span');
  desc.className = 'tool-detail cp-agent-desc';
  desc.textContent = i.description || (i.prompt || '').slice(0, 60);
  const todoBadge = document.createElement('span');
  todoBadge.className = 'cp-agent-todos-badge';
  todoBadge.hidden = true;
  const pill = document.createElement('span');
  pill.className = 'cp-agent-pill cp-agent-running';
  pill.textContent = '◐';
  const elapsed = document.createElement('span');
  elapsed.className = 'cp-agent-elapsed';
  const chevron = document.createElement('span'); chevron.className = 'tool-chevron'; chevron.innerHTML = '&#x203A;';
  hdr.append(icon, type, desc, todoBadge, pill, elapsed, chevron);
  hdr.addEventListener('click', () => card.classList.toggle('open'));

  // One-line live activity shown while collapsed
  const now = document.createElement('div');
  now.className = 'cp-agent-now';
  now.textContent = 'starting…';

  // Nested feed — becomes the scope's messagesEl
  const feed = document.createElement('div');
  feed.className = 'cp-agent-feed';

  card.append(hdr, now, feed);

  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!card.isConnected || card.dataset.resolved === '1') { clearInterval(timer); return; }
    elapsed.textContent = fmtElapsed(Date.now() - startedAt);
  }, 1000);

  if (tab?.agents) {
    tab.agents.set(block.id, {
      cardEl: card,
      feedEl: feed,
      pillEl: pill,
      nowEl: now,
      todoBadgeEl: todoBadge,
      startedAt,
      status: 'running',
      scope: null, // created lazily by ensureAgentScope
    });
  }
  return card;
}

// Returns the render scope for a subagent, creating a fallback card when the
// Task tool_use was missed (e.g. reconnect mid-fan-out).
export function ensureAgentScope(tab, parentToolUseId) {
  if (!tab.agents) tab.agents = new Map();
  let entry = tab.agents.get(parentToolUseId);
  if (!entry) {
    // Fallback: synthesize a card at the end of the root feed
    const card = buildAgentCard({ id: parentToolUseId, name: 'Task', input: { description: 'agent' } }, tab);
    const { scrollEnd, activeTab } = cpCtx;
    tab.messagesEl?.appendChild(card);
    if (tab === activeTab()) { try { scrollEnd(); } catch {} }
    entry = tab.agents.get(parentToolUseId);
    if (!entry) return tab; // give up — render into root feed
  }
  if (!entry.scope) {
    const scope = Object.create(tab);
    scope.messagesEl = entry.feedEl;
    scope.currentMsgEl = null;
    scope.currentMsgId = null;
    scope._stream = null;
    scope.thinkingEl = null;
    scope.thinkTimerInterval = null; // own — never clear the root tab's timer
    scope.thinkStartedAt = null;
    scope._snapshotTimer = null;     // own — snapshot debounce stays per-feed
    scope.todos = [];
    scope.todosVisible = false;
    // Own usage copy: subagent token usage must not pollute the root gauge
    scope.usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    scope._agentScope = true;
    scope._agentEntry = entry;
    scope._agentToolUseId = parentToolUseId;
    scope._rootTab = tab; // explicit root reference (prototype is implicit)
    entry.scope = scope;
  }
  return entry.scope;
}

// Update the collapsed activity line when a tool runs inside the agent feed.
export function noteAgentActivity(scope, text) {
  const entry = scope?._agentEntry;
  if (!entry?.nowEl || !text) return;
  entry.nowEl.textContent = text;
  pruneAgentFeed(entry);
}

function pruneAgentFeed(entry) {
  const feed = entry.feedEl;
  if (!feed) return;
  while (feed.children.length > MAX_FEED_CHILDREN) feed.removeChild(feed.firstChild);
}

// Subagent todo badge ("2/5") — agent-scope TodoWrite never touches the dock.
export function updateAgentTodoBadge(scope, todos) {
  const entry = scope?._agentEntry;
  if (!entry?.todoBadgeEl || !Array.isArray(todos)) return;
  const done = todos.filter(t => t.status === 'completed').length;
  entry.todoBadgeEl.textContent = `${done}/${todos.length}`;
  entry.todoBadgeEl.hidden = todos.length === 0;
}

// Called from updateToolResult when the Task tool's own result arrives in the
// ROOT feed, and from the synthetic `subagent stop` event.
export function finalizeAgentCard(tab, toolUseId, { isError = false, resultText = '' } = {}) {
  const entry = tab.agents?.get(toolUseId);
  if (!entry) return false;
  // The synthetic `subagent stop` event finalizes the pill first; the Task
  // tool_result (carrying the summary text) arrives right after — always
  // append the summary even when the card is already finalized.
  if (resultText && !entry.feedEl.querySelector('.cp-agent-result')) {
    const summary = document.createElement('div');
    summary.className = 'cp-agent-result';
    summary.textContent = resultText.slice(0, 300) + (resultText.length > 300 ? '…' : '');
    entry.feedEl.appendChild(summary);
    pruneAgentFeed(entry);
  }
  if (entry.status !== 'running') return true;
  entry.status = isError ? 'error' : 'done';
  entry.cardEl.dataset.resolved = '1';
  entry.pillEl.classList.remove('cp-agent-running');
  entry.pillEl.classList.add(isError ? 'cp-agent-error' : 'cp-agent-done');
  entry.pillEl.textContent = isError ? '✕' : '✓';
  entry.nowEl.textContent = isError ? 'failed' : 'done';
  return true;
}
