// OpenCode panel — the greeting in the empty state (shared/greeting/, lib/greeting/).
//
// What SynaBun says when a person comes back and opens a new session: one or
// two sentences, written by SynaBun ahead of time (the session's model never
// greets). Only for a session with nothing in it that a person opened: never
// an automation run's. The greeting's id goes back with the first message
// (`greetingId` on message:send), so the model is told once what was said.
// A server older than this page simply answers nothing.

import { clearGreeting, forgetGreeting, mountGreeting } from '../greeting/greeting-card.js';

const SURFACE = 'opencode-panel';
let pending = null; // { id, sessionId } — the greeting on screen, until a first message carries it

/**
 * The empty state is on screen. `host`: its element (kept between renders, so asked once).
 * ctx: { sessionId, cwd, automation, onOpenMemory(id), isCurrent() }
 */
export function offerGreeting(host, { sessionId = null, cwd = '', automation = false, onOpenMemory = null, isCurrent = null } = {}) {
  if (!host) return;
  const key = sessionId || '';
  if (host.dataset.greetingFor === key && host.dataset.greetingAsked === '1') return;
  host.dataset.greetingFor = key;
  host.dataset.greetingAsked = '1';
  clearGreeting(host);
  if (automation) return;
  mountGreeting(host, {
    surface: SURFACE, session: sessionId || null, cwd,
    onOpenMemory,
    isCurrent: () => host.dataset.greetingFor === key && (typeof isCurrent !== 'function' || isCurrent() !== false),
  }).then((greeting) => {
    if (greeting && host.dataset.greetingFor === key) pending = { id: greeting.id, sessionId: sessionId || null };
  }).catch(() => { /* a session always opens */ });
}

/** The id to send with a person's message to `sessionId`, once ('' when this session opened with no greeting). */
export function takeGreetingId(sessionId) {
  const held = pending;
  if (!held) return '';
  // A greeting shown before the session had an id belongs to the first session a message goes to.
  if (held.sessionId && sessionId && held.sessionId !== sessionId) return '';
  pending = null;
  if (held.sessionId) forgetGreeting(SURFACE, held.sessionId);
  return held.id || '';
}

export const _test = { reset() { pending = null; }, pending: () => pending };
