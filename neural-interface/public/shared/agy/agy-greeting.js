// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: the greeting's note in a prompt (no DOM, no imports)
// ═══════════════════════════════════════════
//
// What SynaBun greeted the user with when a conversation opened (lib/greeting/) is told to the model once, with
// the first prompt: the bridge (lib/antigravity/panel-bridge.js) puts the note before the typed words, as a text
// block of its own between these markers. Antigravity keeps it in the conversation's history, so the transcript
// (agy-events.js) and SynaBun's session capture (mcp-server/src/services/memory-sessions.ts, which repeats the
// pattern) take it out again. The Codex panel does the same with markers of its own.

export const AGY_GREETING_MARKER_START = '[SYNABUN_GREETING_START]';
export const AGY_GREETING_MARKER_END = '[SYNABUN_GREETING_END]';

const NOTE_RE = /\[SYNABUN_GREETING_START\][\s\S]*?\[SYNABUN_GREETING_END\][ \t]*(?:\r?\n)*/g;

/** The text block a note is sent as ('' for no note). */
export function greetingNoteBlock(note) {
  const text = String(note ?? '').trim();
  return text ? `${AGY_GREETING_MARKER_START}\n${text}\n${AGY_GREETING_MARKER_END}` : '';
}

/** A user message without the greeting's note (the whole marked block, wherever it is). */
export function stripGreetingNote(text) {
  const value = String(text ?? '');
  return value.includes(AGY_GREETING_MARKER_START) ? value.replace(NOTE_RE, '') : value;
}
