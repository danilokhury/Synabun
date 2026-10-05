// ── Temporary chat: the decisions of the page ──
//
// docs/claude-sidepanel.md, "Temporary chat". A conversation that leaves
// nothing behind: chosen on a new tab before its first message, marked at all
// times, never written to a store, ended with its tab. DOM-free; the mark and
// the control are drawn by cp-temporary-view.js, and the bridge's half is
// lib/claude-temporary.js.
//
// The tab's three fields are written here and nowhere else:
//   temporary    the tab holds a temporary chat
//   tempStarted  its first message was sent: the choice is fixed
//   tempEnded    why it is over ('' while it lives)
// and so is everything else the choice touches (CHOICE_FIELDS), which taking
// the choice back puts back as it was.

// The bridge's capability: without it the running server would save the chat.
export const TEMPORARY_CAPABILITY = 'temporary_chat';
export const TEMPORARY_LABEL = 'Temporary chat';
// The one line at the top of the conversation.
export const TEMPORARY_BANNER = 'Temporary chat. Nothing here is saved: no transcript, no history, no name. SynaBun memory is read-only (recall works, nothing is stored). It ends when this tab is closed or the page is reloaded.';
export const TEMPORARY_CHOICE_TITLE = 'A conversation that leaves nothing behind: not saved, not in history, memory read-only. Chosen before the first message; it ends when the tab is closed or the page is reloaded.';

const ENDED = {
  connection: 'This temporary chat has ended: the connection to the SynaBun server was lost, and a temporary chat is not kept for a reconnect. Nothing of it was saved. Start a new chat to go on.',
  process: 'This temporary chat has ended: its session stopped, and a temporary chat cannot be resumed. Nothing of it was saved. Start a new chat to go on.',
  gone: 'This temporary chat has ended: its session is gone. Nothing of it was saved. Start a new chat to go on.',
};
const OVER = 'This temporary chat is over, so nothing was sent. Start a new chat to go on.';
const NEEDS_RESTART = 'Nothing was sent: the SynaBun server that is running cannot run a temporary chat and would save this one. It needs a restart. Start a new chat without Temporary, or restart the server.';

// What a temporary chat cannot do, each with the reason shown in its place.
const BLOCKED = {
  rename: 'A temporary chat has no name: nothing about it is saved.',
  fork: 'A temporary chat cannot be forked: it has no transcript.',
  rewind: 'A temporary chat cannot be rewound: it keeps no file checkpoints and no transcript.',
  resume: 'A temporary chat cannot be resumed and is not in the session list; a session picked from the list opens in a new tab.',
  history: 'A temporary chat has no saved history: what is on screen is all there is.',
  'plan-file': 'A temporary chat keeps no plan file: the plan is in the conversation.',
};

export const isTemporary = (tab) => tab?.temporary === true;
/** Nothing of this tab is written to a store: not the tab, its transcript, a title or a label. */
export const keepsNothing = isTemporary;
/** Whether a reconnecting tab asks the bridge for its session back. A temporary one never does. */
export const reattaches = (tab) => !isTemporary(tab);

// A conversation has started in the tab: the choice is no longer open.
function started(tab) {
  return !!(tab.sessionId || tab.running || tab.turns > 0 || tab.tempStarted || tab.queue?.length);
}

/**
 * The control of a new tab: shown only where the bridge announces the
 * capability, never on a tab that shows an automation run, and only until the
 * conversation starts.
 */
export function temporaryChoice(tab, { capable = false } = {}) {
  const on = isTemporary(tab);
  if (!tab || !capable || tab.automationRunId || tab.automationActive || started(tab)) return { show: false, on };
  return { show: true, on, label: TEMPORARY_LABEL, title: TEMPORARY_CHOICE_TITLE };
}

// Every field of the tab the choice writes. Choosing keeps what each held
// (and whether it was there at all) in `_beforeTemporary`; taking the choice
// back restores all of them and removes the record: the two are exact inverses.
const CHOICE_FIELDS = ['temporary', 'tempStarted', 'tempEnded', 'label', 'pendingLabel', 'planFilePath', '_warmSentAt'];

/** The user's choice on a new tab. Returns whether the tab changed. */
export function chooseTemporary(tab, on, { capable = false } = {}) {
  if (!temporaryChoice(tab, { capable }).show) return false;
  const want = on === true;
  if (isTemporary(tab) === want) return false;
  if (want) {
    const before = {};
    for (const key of CHOICE_FIELDS) if (Object.hasOwn(tab, key)) before[key] = tab[key];
    tab._beforeTemporary = before;
    tab.temporary = true;
    tab.tempStarted = false;
    tab.tempEnded = '';
    tab.label = TEMPORARY_LABEL;
    tab.pendingLabel = null; // a name typed for the session would become its title
    tab.planFilePath = '';   // it keeps no plan file
    tab._warmSentAt = 0;     // a process kept ready for the other kind of conversation is not this one's: the next keystroke asks for a new one
  } else {
    const before = tab._beforeTemporary || { temporary: false, tempStarted: false, tempEnded: '', label: 'New chat' };
    for (const key of CHOICE_FIELDS) {
      if (Object.hasOwn(before, key)) tab[key] = before[key];
      else delete tab[key];
    }
    delete tab._beforeTemporary;
  }
  return true;
}

/**
 * What a message that can start the tab's session carries (a query, a warm
 * start, the `config` of a starting control). A query is the first message:
 * from there the choice is fixed.
 */
export function applyTemporary(tab, msg) {
  if (!isTemporary(tab)) return msg;
  msg.temporary = true;
  delete msg.title;
  if (msg.type === 'query') tab.tempStarted = true;
  return msg;
}

/** Why nothing may be sent for the tab, or '': it is over, or the bridge would save it. */
export function temporaryRefusal(tab, { capable = false } = {}) {
  if (!isTemporary(tab)) return '';
  if (tab.tempEnded) return OVER;
  return capable ? '' : NEEDS_RESTART;
}

/**
 * The temporary chat is over ('connection': its socket closed and the bridge
 * ended it; 'process': the bridge says its session stopped; 'gone': the bridge
 * no longer has it). Returns the line to show, '' when there is nothing to say:
 * not a temporary tab, nothing sent yet, or said already.
 */
export function endTemporary(tab, reason) {
  if (!isTemporary(tab) || !tab.tempStarted || tab.tempEnded) return '';
  tab.tempEnded = ENDED[reason] ? reason : 'gone';
  return ENDED[tab.tempEnded];
}

/** The line under the mark once it is over. */
export function endedText(tab) {
  return isTemporary(tab) && tab.tempEnded ? ENDED[tab.tempEnded] || ENDED.gone : '';
}

/**
 * New chat, or another session, in the tab: it is an ordinary tab again.
 * Returns whether it was temporary. The caller then ends the conversation's
 * socket and makes the tab a new one (tabAfterTemporary): nothing of the
 * conversation stays on it, and nothing it sends late reaches the tab.
 */
export function leaveTemporary(tab) {
  if (!isTemporary(tab)) return false;
  tab.temporary = false;
  tab.tempStarted = false;
  tab.tempEnded = '';
  delete tab._beforeTemporary;
  return true;
}

/**
 * What a tab keeps when its temporary chat ends and the tab lives on, each
 * with the reason: what identifies the tab, the owner's own configuration of
 * it (what an ordinary New chat keeps of it) and its permission mode.
 * Everything else on it is replaced by what a new tab has: the draft, the
 * prompts sent, the queue and its state and attachments, the composer's
 * attachments, hook events, cost, usage, plan, cards, tasks, the rules granted
 * while it ran, and any field added later that nobody listed here.
 *
 * Two things end with the conversation and are not here: its socket (with
 * what the hello on it said) and its scroll controller. The caller closes the
 * one and destroys the other, and makes new ones for the next conversation:
 * nothing the old socket still delivers is handled, and nothing keeps watching
 * the old transcript.
 */
export const CARRIED_OVER = Object.freeze({
  // What identifies the tab.
  id: 'the tab itself: its pill, its conversation area and the tray name it by this',
  messagesEl: 'its place in the panel: the conversation area, which the caller empties',
  pillEl: 'its place in the tray',
  project: 'its project folder',
  // The owner's own configuration of the tab, which an ordinary New chat keeps too. The owner sets each of
  // these in a picker, in /session or with a key; no prompt and no answer writes one.
  model: 'the owner\'s pick: the model the tab runs',
  effort: 'the owner\'s pick: the effort the tab thinks with',
  toolPolicy: 'the owner\'s restriction of the tab\'s tools: a read-only tab stays read-only',
  accountId: 'the owner\'s pick: the Claude account the tab runs under',
  session: 'the owner\'s session settings of the tab (/session)',
  viewMode: 'a view switch of the owner\'s: normal, transcript or focus',
  todosVisible: 'a view switch of the owner\'s: the task list open or closed (the list itself is not kept)',
  hookStripVisible: 'a view switch of the owner\'s: the hook strip shown or not (its events are not kept)',
  // Its permission mode, under the mode contract (docs/claude-sidepanel.md, M2, M8, W3): a pick stays until
  // the user picks something else, statements are numbered per tab and only grow, and "may be in Bypass"
  // is cleared by a report only, never by New chat. cp-permission-model.js owns every one of these.
  permissionMode: 'the mode contract (M8): the tab\'s pick stays until the user picks another',
  modeChosen: 'the mode contract (M1): whether the tab has a pick at all',
  bypassChosen: 'the mode contract (M8): the record that Bypass is the user\'s pick',
  planFrom: 'the mode contract (M5): what the tab goes back to when it leaves plan mode',
  planMode: 'the mode contract (M5): written together with permissionMode',
  modeSeq: 'the mode contract (M2): the number of the tab\'s latest statement only grows',
  modeSent: 'the mode contract (M3): which statement this socket has carried',
  modeUnsent: 'the mode contract (M3): a pick that still has to be said',
  actualMode: 'the mode contract (W2): what the session last reported, already forgotten by sessionForgotten()',
  actualSeq: 'the mode contract (M2): the number of that report',
  mayBypass: 'the mode contract (W3): cleared by a report only, never by New chat',
  settingsMode: 'the mode contract (M4): the mode the settings gave the session',
  runMode: 'the mode contract (M6): an automation run\'s own mode, never the tab\'s',
  modeRev: 'the mode contract (M2): the revision of the latest report handled',
  modeRevNow: 'the mode contract (M2): the revision being handled',
  modeRevOf: 'the mode contract (M2): the bridge session those revisions belong to',
});

/**
 * Make `tab` the tab `fresh` is (a new tab, from the factory every tab is
 * built with), in place: every own property that is not carried over is
 * removed, then everything a new tab has is put on it. The object stays the
 * same one, because the tab list, the socket handlers and the pill hold it.
 */
export function tabAfterTemporary(tab, fresh) {
  for (const key of Reflect.ownKeys(tab)) {
    if (!Object.hasOwn(CARRIED_OVER, key)) delete tab[key];
  }
  for (const key of Reflect.ownKeys(fresh)) {
    if (!Object.hasOwn(CARRIED_OVER, key) || !Object.hasOwn(tab, key)) tab[key] = fresh[key];
  }
  return tab;
}

/**
 * The tabs that are written to storage, and which of them is the active one.
 * A temporary tab is never among them; when it is the active tab, the saved
 * state points at the tab before it (or the first), and at none when no tab is left.
 */
export function persistableTabs(tabs, activeIdx) {
  const list = Array.isArray(tabs) ? tabs : [];
  const kept = list.filter(t => !isTemporary(t));
  if (!kept.length) return { tabs: kept, activeIdx: -1 };
  const before = list.slice(0, Math.max(0, activeIdx) + 1).filter(t => !isTemporary(t)).length;
  return { tabs: kept, activeIdx: Math.min(Math.max(before - 1, 0), kept.length - 1) };
}

/** Why `action` is off in this tab, or '' when it is not blocked. */
export function temporaryBlocks(tab, action) {
  return isTemporary(tab) ? BLOCKED[action] || '' : '';
}
