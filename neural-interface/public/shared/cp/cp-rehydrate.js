// ── A transcript restored from its stored snapshot ──
// A snapshot is markup: it comes back without listeners and without the data
// the cards kept in closures. Prompts that were waiting for the user are stale
// and go; everything read-only keeps working. This module decides, per
// control, which of the two it is, and re-wires what can be re-wired:
//   - "Rewind to here" on every prompt that saved its uuid,
//   - the header toggle of Bash, diff and agent cards (they are marked
//     `data-restored`; the panel's delegated click handler opens them),
//   - "Show all" on a clipped result (the full text is fetched again: a
//     snapshot holds only what was on screen),
//   - a past subagent's transcript (the card saved its agent id),
//   - "Load earlier" (the note saved where its page starts).
// DOM in, DOM out: no globals besides `document`, so it runs on the test DOM.

import { pagerState } from './cp-restore.js';

const STALE_ROWS = '.thinking, .msg-permission-prompt, .post-plan-card';
const STALE_PROMPTS = '.cp-plan-approval-card.active-perm, .perm-card.active-perm, .cp-rewind-confirm';
const SELF_WIRED_CARDS = '.tool-card.cp-bash-card, .tool-card.cp-diff-card, .tool-card.cp-agent-card';

/**
 * @param hooks.attachRewind   (row, uuid) => void
 * @param hooks.wireSubagent   (card, agentId) => void
 * @param hooks.loadFullResult (toolUseId) => Promise<string|null>
 * @param hooks.restorePager   (note, { start, total }) => void: put a live "Load earlier" in place of the stored note
 * @returns {{ rewinds: number, cards: number, results: number, subagents: number, pagers?: number }}
 */
export function rehydrateStoredTranscript($msgs, hooks = {}) {
  const report = { rewinds: 0, cards: 0, results: 0, subagents: 0 };
  if (!$msgs) return report;

  // 1. What was transient or waiting for an answer never resurrects.
  $msgs.querySelectorAll(STALE_ROWS).forEach(n => n.remove());
  $msgs.querySelectorAll(STALE_PROMPTS).forEach((n) => {
    const row = n.closest('.msg');
    (n.classList.contains('cp-rewind-confirm') ? n : (row || n)).remove();
  });
  // 2. Every control is inert until something below gives it a listener again:
  // an answered card, a settled question, an old form must not look clickable.
  $msgs.querySelectorAll('button, input, select, textarea').forEach((node) => { node.disabled = true; });
  $msgs.querySelectorAll('.tool-streaming').forEach(n => n.classList.remove('tool-streaming'));
  $msgs.querySelectorAll('.cp-agent-pill.cp-agent-running').forEach((p) => {
    p.classList.remove('cp-agent-running');
    p.textContent = '·';
  });

  // 3. Rewind: the dead buttons go, a live one is attached from the saved uuid.
  $msgs.querySelectorAll('.cp-rewind-btn').forEach(n => n.remove());
  if (typeof hooks.attachRewind === 'function') {
    for (const row of $msgs.querySelectorAll('.msg-user')) {
      const uuid = row.dataset?.uuid;
      if (!uuid) continue;
      try { hooks.attachRewind(row, uuid); report.rewinds++; } catch {}
    }
  }

  // 4. Cards that toggled through their own header listener.
  for (const card of $msgs.querySelectorAll(SELF_WIRED_CARDS)) {
    card.dataset.restored = '1';
    report.cards++;
  }

  // 5. "Show all": the full result was in a closure. Fetch it on the click.
  for (const more of $msgs.querySelectorAll('.cp-result-more')) {
    const card = more.closest('.tool-card');
    const toolUseId = card?.dataset?.toolId || '';
    if (typeof hooks.loadFullResult !== 'function' || !toolUseId) { more.remove(); continue; }
    more.disabled = false;
    let asked = false;
    more.addEventListener('click', (e) => {
      e.stopPropagation?.();
      if (asked) return;
      asked = true;
      more.disabled = true;
      // A hook may say why (`err.notice`: the server has to be restarted first).
      const unavailable = (err) => { more.textContent = (typeof err?.notice === 'string' && err.notice) || 'The full result is not available'; };
      Promise.resolve().then(() => hooks.loadFullResult(toolUseId)).then((text) => {
        if (typeof text !== 'string' || !text) { unavailable(); return; }
        const pre = more.previousElementSibling?.classList?.contains('cp-result-text')
          ? more.previousElementSibling
          : card.querySelector('.cp-result-text');
        if (!pre) { unavailable(); return; }
        pre.textContent = text;
        more.remove();
      }).catch(unavailable);
    });
    report.results++;
  }

  // 6. A past subagent's transcript loads when its card is opened.
  if (typeof hooks.wireSubagent === 'function') {
    for (const card of $msgs.querySelectorAll('.tool-card.cp-agent-card')) {
      const agentId = card.dataset?.agentId;
      if (!agentId) continue;
      if (card.dataset.transcript === 'loading') card.dataset.transcript = '';
      try { hooks.wireSubagent(card, agentId); report.subagents++; } catch {}
    }
  }

  // 7. "Load earlier": the stored button is dead. The note says where its page
  // starts, so the panel builds a live one in its place; a note that cannot be
  // read keeps its sentence and loses the button (never a control that looks
  // usable and is not).
  for (const note of $msgs.querySelectorAll('.cp-history-pager')) {
    const state = pagerState(note.dataset, note.querySelector('span')?.textContent || note.textContent || '');
    let restored = false;
    if (state && typeof hooks.restorePager === 'function') {
      try { hooks.restorePager(note, state); restored = true; report.pagers = (report.pagers || 0) + 1; } catch { restored = false; }
    }
    if (!restored && note.isConnected !== false) note.querySelectorAll('button').forEach(b => b.remove());
  }
  return report;
}
