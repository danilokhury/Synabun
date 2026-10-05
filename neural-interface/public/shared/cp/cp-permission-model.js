// ── Permission prompts: what they say and what an answer grants (DOM-free) ──
// The CLI sends a permission request with its own wording (title, reason, the
// path or MCP server involved) and with `suggestions`: the exact rule changes
// that would stop it asking again. "Always" returns those suggestions, to the
// destination the user picked, instead of a blanket allow for the whole tool.
// cp-permissions.js renders; tests import this file directly.

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// eslint-disable-next-line no-control-regex
const plain = (s) => String(s ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();

// ── Modes ──

export const ALL_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];
const CLASSIC_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export const MODE_LABELS = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't Ask",
  auto: 'Auto',
};

export const MODE_HINTS = {
  default: 'Ask before edits and commands',
  acceptEdits: 'File edits run without asking',
  plan: 'Read and plan only, then ask to proceed',
  bypassPermissions: 'Run everything without asking',
  dontAsk: 'Never ask: anything not already allowed is denied',
  auto: 'A classifier approves safe actions and asks about the rest',
};

/**
 * The modes the dropdown offers. `dontAsk` and `auto` need a bridge that accepts
 * them; `auto` also needs a model that supports it. The mode a tab is already
 * in is always listed, so the dropdown can show it.
 */
export function permissionModesFor({ extended = false, autoSupported = false, current = '' } = {}) {
  const modes = [...CLASSIC_MODES];
  if (extended) {
    modes.push('dontAsk');
    if (autoSupported) modes.push('auto');
  }
  if (current && ALL_PERMISSION_MODES.includes(current) && !modes.includes(current)) modes.push(current);
  return modes;
}

/**
 * A mode new tabs may start in. Plan is per tab; Auto and Don't Ask are never a
 * default; and Bypass is a choice made for one tab, in its mode control: a new
 * tab starts in it only when the user's own Claude Code settings say so
 * (permissions.defaultMode).
 */
export function isDefaultableMode(mode) {
  return mode === 'default' || mode === 'acceptEdits';
}

// ── Bypass and auto-approve: what the mode control offers and says ──

export const BYPASS_MODE = 'bypassPermissions';
const BYPASS_NEEDS_RESTART = 'Bypass needs the SynaBun server restart: until then choosing it here does nothing.';
const BYPASS_OFF = 'Bypass is turned off by your Claude Code settings.';

/**
 * Whether a tab can be put in Bypass, and the sentence to show when it cannot.
 * `real`: the bridge runs Bypass as the SDK's bypassPermissions (capability
 * `bypass_mode`). `policy`: what GET /api/claude-code/bypass-policy answered for
 * the tab's project and account, when it was asked.
 * @returns {{ available: boolean, reason: string, note: string }}
 */
export function bypassOffer({ real = false, policy = null } = {}) {
  if (!real) return { available: false, reason: BYPASS_NEEDS_RESTART, note: 'needs the server restart' };
  if (policy && policy.available === false) {
    return { available: false, reason: clip(plain(policy.reason) || BYPASS_OFF, 300), note: policy.source === 'root' ? 'not available as root' : 'off in your settings' };
  }
  return { available: true, reason: '', note: '' };
}

/**
 * What the mode control shows. A tab in Bypass, and every tab while the global
 * Auto-approve toggle is on, runs tools without asking: the control says so, in
 * its warning style, whatever the mode is called. (A tab saved in Bypass is
 * shown as that against any server: the warning is never the thing left out.)
 * `follows`: the tab never picked a mode and follows the user's Claude Code
 * settings; `known` says whether the page knows which mode that is. `leaving`:
 * the tab's own mode is another one and its session may be in Bypass (the tab
 * stated Bypass, or the bridge says so, and no report at or after the tab's
 * latest statement says it is out of it): the control says Bypass until one
 * does. `waiting`: the tab's pick is Bypass and the bridge cannot run it (it
 * was not restarted): the pick waits, shown as unavailable.
 * controlFacts(tab) reads those off a tab.
 * `keep` is the start of `text` that the control never cuts when the bar is
 * short of room: "Bypass", the mode after the arrow, else the mode's name. Only
 * the suffixes after it (" · from settings", " · auto-approve", " ·
 * unavailable") may go under the ellipsis; modeTooltip() has the text in full.
 * @returns {{ text: string, keep: string, title: string, state: '' | 'bypass' | 'autoapprove' }}
 */
export function modeControl({ mode = 'default', autoApprove = false, follows = false, known = true, leaving = false, waiting = false } = {}) {
  const label = MODE_LABELS[mode] || String(mode || '');
  const name = follows ? (known ? `${label} · from settings` : 'From settings') : label;
  const head = follows && !known ? name : label;
  if (waiting) {
    return { text: 'Bypass · unavailable', keep: 'Bypass', state: 'bypass', title: 'Bypass needs the SynaBun server restart: this tab\'s Bypass pick waits for it, and until then the tab runs in Default.' };
  }
  if (leaving) {
    return { text: `Bypass → ${name}`, keep: `Bypass → ${head}`, state: 'bypass', title: 'This tab\'s session may still be in Bypass: its switch to another mode is not confirmed yet. Until it is, tools can run without asking.' };
  }
  if (mode === BYPASS_MODE && (known || !follows)) {
    return {
      text: name,
      keep: head,
      state: 'bypass',
      title: follows
        ? 'Bypass, from your Claude Code settings (permissions.defaultMode): every tool runs without asking in this tab, until you pick another mode.'
        : 'Bypass: every tool runs without asking in this tab, until you pick another mode.',
    };
  }
  if (autoApprove) {
    return { text: `${name} · auto-approve`, keep: head, state: 'autoapprove', title: 'Auto-approve is on: permission requests are answered Allow without a card, in every tab. Turn it off with the Auto-approve toggle.' };
  }
  return { text: name, keep: head, state: '', title: follows ? 'This tab follows your Claude Code settings (permissions.defaultMode). Pick a mode here to choose one for this tab.' : '' };
}

/**
 * The mode control's tooltip: its label in full (the control may cut the end
 * of it), what that means (`fallback` when the state has no sentence of its
 * own), and `note` (settingsModeNote()).
 */
export function modeTooltip(shown, { fallback = '', note = '' } = {}) {
  return [shown?.text, shown?.title || fallback, note].filter(Boolean).map(part => `${String(part).replace(/[.\s]+$/, '')}.`).join(' ');
}

// ── The mode the settings ask for, and the one the session got ──
// A tab that never picked a mode starts in the mode Claude Code takes from the
// user's settings (permissions.defaultMode). Claude Code can decline it: auto
// mode is not available for every model, plan or setting, and the session then
// starts in Default. The control shows the mode the session is in; these say
// that the settings asked for another.

/**
 * The mode the settings files name (GET /api/claude-code/permission-rules):
 * the nearest scope that names one, as Claude Code reads them (this project
 * only me, this project shared, all my projects). '' when none does.
 */
export function settingsDefaultMode(rules) {
  for (const scope of ['local', 'project', 'user']) {
    const s = rules?.[scope];
    if (s?.exists && !s.error && isMode(s.defaultMode)) return s.defaultMode;
  }
  return '';
}

/**
 * The sentence for a tab that follows the settings and whose session is in
 * another mode than the one they ask for (`facts`: controlFacts(tab); `asked`:
 * settingsDefaultMode()). '' when there is nothing to say.
 */
export function settingsModeNote(facts, asked) {
  if (!facts?.follows || !facts.known || !isMode(asked) || !isMode(facts.mode) || asked === facts.mode) return '';
  return `Your Claude Code settings ask for ${MODE_LABELS[asked]} (permissions.defaultMode) and this session is in ${MODE_LABELS[facts.mode]}: Claude Code starts a session in another mode when it cannot give the one asked for${asked === 'auto' ? ' (auto mode is not available for every model, plan or setting)' : ''}.`;
}

// ── A tab's mode: one model ──
// Two facts, one owner each.
//   The page owns the tab's CHOSEN mode: a pick, or none. A pick is
//   `modeChosen` with the mode in `permissionMode` (and `bypassChosen` when it
//   is Bypass: the record a saved Bypass needs to come back). A tab without a
//   pick follows the user's Claude Code settings (permissions.defaultMode);
//   `permissionMode` then only holds what its session last reported, to show.
//   The bridge owns the session's ACTUAL mode. The page keeps the latest report
//   of it (`actualMode`, `actualSeq`) to show it and to warn, never to state it.
// Order is decided by numbers, not by time. `modeSeq` grows whenever the page
// changes the tab's mode itself (a pick, a plan card answer, entering or
// leaving plan mode), and every statement the page sends carries it. The
// bridge returns the number of the latest statement it applied with every
// report (capability `mode_statements`). A report with an older number changes
// nothing of the tab's own; one with the latest number and another mode is the
// bridge or the CLI deciding otherwise, and the tab then shows that mode.
// Plan mode is one fact: `permissionMode === 'plan'` and `planMode` are written
// together, by setMode() alone, and `planFrom` holds what the tab was before it
// entered plan mode: where an exit that names no mode goes back to.
// A tab is in Bypass only because the user chose that for it: in the mode
// control, on the plan card, in a saved tab with the record of such a pick, or
// through their settings for a tab that never picked a mode. Nothing an
// automation run says or does is written here (runEvent()).
// Never under-warn. "May be in Bypass" is a fact of its own (`mayBypass`), and
// it errs toward warning. A tab may be in Bypass from the moment the page sends
// a statement of Bypass (statementSent), or a report says so, until a report
// that carries a number at or after the tab's latest statement says the session
// is not (`mayBypass: false` from a bridge that keeps the same fact). A report
// with an older number can set it, never clear it; nothing else clears it; and
// it is saved with the tab whenever it changes. The control warns whenever the
// tab's pick is Bypass or this fact is set (controlFacts).
// Bypass exists only against a bridge that runs it and numbers statements
// (`bypass` and `numbered` below: capabilities `bypass_mode` and
// `mode_statements`). Against any other the page states no Bypass, a saved
// Bypass pick waits, and a report without a number is never about Bypass.
// The bridge's reports have an order of their own. The statement number orders
// what the page says; between two statements the bridge sends several reports
// with the same number, and a report can be handled long after it was written
// (it waited in a detached session's buffer and was replayed after the answer
// to reattach, or it waited here behind a card). So every report carries a
// revision that only grows for the bridge session that wrote it (`modeRev`,
// with that session's id, `modeRevOf`). The tab remembers the highest one it
// handled; a report with a lower revision of the same bridge session can set
// `mayBypass` and does nothing else: it clears nothing and replaces neither
// the tab's mode nor the mode shown for its session. Another id means another
// bridge session (a server restart, a session created anew), whose revisions
// start again: its reports are taken, and the tab counts with it from there.
// A report written by a bridge session the tab's socket has since left (noted
// when a message arrives: reportReceived) is older than everything of the one
// it talks to now. The revision is not saved: the first thing a reloaded page
// hears from a session is its answer to reattach, which carries the current
// one. A bridge that sends no revision is ordered by the number alone.

const isMode = (mode) => typeof mode === 'string' && ALL_PERMISSION_MODES.includes(mode);
const seqOf = (tab) => (Number.isSafeInteger(tab?.modeSeq) && tab.modeSeq > 0 ? tab.modeSeq : 0);

/** The one writer of the pair `permissionMode` / `planMode`. */
function setMode(tab, mode) {
  tab.permissionMode = mode;
  tab.planMode = mode === 'plan';
}

/** The page changed the tab's mode itself: its statements carry a new number from here. */
function nextStatement(tab) {
  tab.modeSeq = seqOf(tab) + 1;
  return tab.modeSeq;
}

/** What a tab is outside plan mode: its pick, or '' when it follows the settings. */
function baseOf(tab) {
  if (tab.modeChosen !== true) return { mode: '' };
  if (tab.permissionMode === BYPASS_MODE) return tab.bypassChosen === true ? { mode: BYPASS_MODE, bypassChosen: true } : { mode: '' };
  return { mode: isMode(tab.permissionMode) ? tab.permissionMode : 'default' };
}

function enterPlan(tab) {
  if (tab.permissionMode !== 'plan') tab.planFrom = baseOf(tab);
  setMode(tab, 'plan');
}

/**
 * The user picked `mode` for this tab: the mode control (the dropdown, also for
 * the mode it already shows; Shift+Tab; the plan toggle switching plan mode on)
 * or a button of the plan card. Returns the number of the statement.
 */
export function pickMode(tab, mode) {
  if (mode === 'plan') {
    enterPlan(tab);
  } else {
    tab.planFrom = null;
    setMode(tab, mode);
    tab.modeChosen = true;
  }
  tab.bypassChosen = mode === BYPASS_MODE;
  return nextStatement(tab);
}

/**
 * The tab leaves plan mode without naming a mode (the plan toggle, /plan, the
 * post-plan card): back to what it was before it entered plan mode, the user's
 * pick or following their settings. A tab with no record of that (saved by an
 * older build) goes on in Default. Returns the number of the statement, 0 when
 * the tab was not in plan mode.
 */
export function leavePlanMode(tab) {
  if (tab.permissionMode !== 'plan') { tab.planMode = false; return 0; }
  const from = tab.planFrom && typeof tab.planFrom === 'object' ? tab.planFrom : null;
  tab.planFrom = null;
  if (from && from.mode === BYPASS_MODE && from.bypassChosen === true) {
    setMode(tab, BYPASS_MODE); tab.modeChosen = true; tab.bypassChosen = true;
  } else if (from && from.mode && from.mode !== BYPASS_MODE && from.mode !== 'plan' && isMode(from.mode)) {
    setMode(tab, from.mode); tab.modeChosen = true; tab.bypassChosen = false;
  } else if (from) {
    // It followed the settings, and does again: which mode that is, its session says.
    setMode(tab, 'default'); tab.modeChosen = false; tab.bypassChosen = false;
  } else {
    setMode(tab, 'default'); tab.bypassChosen = false;
  }
  return nextStatement(tab);
}

/**
 * The tab's own session entered plan mode and the page saw the tool call
 * (EnterPlanMode), against a bridge that does not number statements: with one
 * that does, the session's own report says so (sessionReport). Never for an
 * event of an automation run. Returns whether the tab entered plan mode.
 */
export function sessionEnteredPlan(tab) {
  if (tab._runEvent || tab.permissionMode === 'plan') return false;
  enterPlan(tab);
  nextStatement(tab);
  return true;
}

/**
 * The mode a tab calls its own: 'plan' in plan mode, its pick, or '' when it
 * never picked one (the user's Claude Code settings then pick the mode a
 * session starts in). Bypass is the tab's own only as the user's recorded
 * pick: a Bypass the tab merely shows (its session started in it from the
 * user's settings) is not.
 */
export function ownMode(tab) {
  if (tab?.permissionMode === 'plan') return 'plan';
  if (tab?.modeChosen !== true) return '';
  const mode = tab.permissionMode || 'default';
  if (mode === BYPASS_MODE) return tab.bypassChosen === true ? BYPASS_MODE : '';
  return mode;
}

// The mode a statement names for a tab: its own, except a Bypass pick against a
// bridge that cannot run Bypass (`real` false), which waits: Default is stated.
function statable(tab, real) {
  const own = ownMode(tab);
  return own === BYPASS_MODE && !real ? 'default' : own;
}

/**
 * What a query, a warm start or a starting control says about the tab's mode:
 * `{ permissionMode }`, or `{ modeFromSettings: true }` for a tab that never
 * picked one, where the bridge can leave the choice to the user's settings
 * (`settingsPick`: capability `permission_modes_v2`). With `numbered`
 * (capability `mode_statements`) the statement carries its number.
 */
export function statedMode(tab, { settingsPick = false, numbered = false, bypass = false } = {}) {
  const own = statable(tab, numbered && bypass);
  const out = own ? { permissionMode: own } : (settingsPick ? { modeFromSettings: true } : { permissionMode: 'default' });
  if (numbered) out.modeSeq = seqOf(tab) || nextStatement(tab);
  return out;
}

/**
 * The same statement as the fields of a `set_permission_mode`: said to a live
 * session at once (a pick, leaving plan mode, the tab saying its mode again).
 * A tab that never picked a mode goes back to the mode its settings name:
 * `{ fromSettings: true }` where the bridge can do that (`numbered`); an older
 * bridge is told the mode the session was last seen in from the settings
 * (never Bypass), else Default.
 */
export function modeStatement(tab, { numbered = false, bypass = false } = {}) {
  const own = statable(tab, numbered && bypass);
  if (numbered) return { ...(own ? { mode: own } : { fromSettings: true }), modeSeq: seqOf(tab) || nextStatement(tab) };
  if (own) return { mode: own };
  const seen = tab?.settingsMode;
  return { mode: isMode(seen) && seen !== BYPASS_MODE && seen !== 'plan' ? seen : 'default' };
}

/**
 * Where an approved plan leaves to when the answer names no mode of its own
 * (the post-plan card answering a pending approval): what the tab was before
 * plan mode. `planDecision` is what every bridge reads; `planExit` says it
 * exactly to one that numbers statements. Call before leavePlanMode().
 */
export function planExitTarget(tab, { bypass = false } = {}) {
  const from = tab?.planFrom && typeof tab.planFrom === 'object' ? tab.planFrom : null;
  const mode = from?.mode === BYPASS_MODE ? (from.bypassChosen === true && bypass ? BYPASS_MODE : 'default') : (from?.mode && isMode(from.mode) && from.mode !== 'plan' ? from.mode : '');
  if (!mode) return { planDecision: 'default', planExit: from ? 'settings' : 'default' };
  return { planDecision: mode === 'acceptEdits' || mode === BYPASS_MODE ? mode : 'default', planExit: mode };
}

// A report the bridge did not number: what the tab's session says is followed.
// Bypass is not part of it: such a bridge cannot run Bypass and the page states
// none to it, so a Bypass it names is nobody's mode, and a tab whose Bypass
// pick waits for a bridge that can is left as it is.
function unnumberedReport(tab, mode) {
  if (mode === BYPASS_MODE || ownMode(tab) === BYPASS_MODE) return false;
  if (mode === 'plan') enterPlan(tab);
  else { tab.planFrom = null; setMode(tab, mode); }
  return true;
}

// A numbered report that carries the page's latest number: the bridge's word on
// the session as of the tab's latest statement.
function currentReport(tab, mode) {
  const own = ownMode(tab);
  if (mode === own) return { taken: true, changed: false };
  if (mode === BYPASS_MODE) {
    // The user's settings started the session of a tab that never picked a mode in it: shown, not picked.
    if (own !== '') return { taken: false, changed: false };
    setMode(tab, mode);
    return { taken: true, changed: true };
  }
  if (mode === 'plan') {
    // The session entered plan mode itself (the model's EnterPlanMode).
    enterPlan(tab);
    return { taken: true, changed: true };
  }
  if (own === 'plan') {
    // The session left plan mode: to what the tab was before when that is the mode, else to the mode it says.
    const from = tab.planFrom && typeof tab.planFrom === 'object' ? tab.planFrom : null;
    tab.planFrom = null;
    setMode(tab, mode);
    if (from) tab.modeChosen = from.mode !== '';
    tab.bypassChosen = false;
    return { taken: true, changed: true };
  }
  // The bridge or the CLI decided otherwise (refused, switched, a policy): the
  // tab shows the mode its session is in. A pick stays a pick, of that mode.
  setMode(tab, mode);
  tab.bypassChosen = false;
  return { taken: true, changed: true, decided: own !== '' };
}

/**
 * The tab's session says which mode it is in: a turn's `init`, a `status`, the
 * bridge's `mode_changed` or `mode_state`, the answer to `reattach`. `seq` is
 * the number the bridge returned with it; `numbered` whether the bridge numbers
 * at all. `mode` is the mode the CLI is in; `switching` the mode a switch is
 * under way to, `failed` the one a switch failed for (either is the session's
 * record of what the tab stated); `mayBypass` the bridge's own fact.
 * Returns:
 *   warned   whether the tab may be in Bypass changed (the caller saves the tab)
 *   stale    the report is older than the tab's latest statement: nothing of
 *            the tab's own changed
 *   taken    the tab is (now) in the mode reported
 *   changed  the tab's own mode changed
 *   decided  the bridge or the CLI put a tab with a pick in another mode
 *   restate  the caller says the tab's own mode to the session again: a Bypass
 *            that is not the tab's was reported, or the session is behind a
 *            statement that was not sent to it on this connection
 * Nothing of an automation run comes through here (runEvent strips its mode;
 * a call made while one of its events is handled changes nothing).
 */
export function sessionReport(tab, mode, from, { seq, numbered = false, mayBypass, switching, failed, rev, revOf } = {}) {
  const none = { stale: false, taken: false, changed: false, decided: false, restate: false, warned: false };
  if (typeof mode !== 'string' || tab._runEvent) return none;
  if (!numbered) {
    if (!mode) return none;
    const before = `${tab.permissionMode}|${tab.planMode}`;
    if (!unnumberedReport(tab, mode)) return none;
    tab.actualMode = mode;
    tab.actualSeq = undefined;
    if (ownMode(tab) === '') tab.settingsMode = mode;
    return { ...none, taken: true, changed: before !== `${tab.permissionMode}|${tab.planMode}` };
  }
  const mine = seqOf(tab);
  const n = Number.isSafeInteger(seq) ? seq : -1;
  // Older than a report the tab already handled, by the bridge's own count.
  const older = olderReport(tab, rev, revOf);
  // Whether the tab may be in Bypass. Any report that says so sets it, whatever
  // its number or its revision; only one numbered at or after the tab's latest
  // statement, from a bridge that keeps the fact itself, and not older than a
  // report already handled, clears it.
  const was = tab.mayBypass === true;
  if (mode === BYPASS_MODE || mayBypass === true || switching === BYPASS_MODE || failed === BYPASS_MODE) tab.mayBypass = true;
  else if (!older && n >= mine && mayBypass === false) tab.mayBypass = false;
  const out = { ...none, warned: was !== (tab.mayBypass === true) };
  // (An older report changes nothing else: a newer one already said where the session is.)
  if (older) return { ...out, stale: true };
  // What the page knows of the session's actual mode: the report with the highest number.
  if (!Number.isSafeInteger(tab.actualSeq) || n >= tab.actualSeq) { tab.actualSeq = n; tab.actualMode = mode; }
  if (n < mine) return { ...out, stale: true, restate: (tab.modeSent || 0) < mine };
  if (n > mine) {
    // The counter only grows: the session applied a statement this page does not
    // remember making (its saved number was lost). A statement this page made on
    // this connection is newer than that all the same, whether it could not be
    // sent yet or was sent with the lower number (the bridge drops that one):
    // it is said again with a number the bridge takes, not replaced.
    tab.modeSeq = n;
    if (tab.modeUnsent === true || (mine > 0 && tab.modeSent === mine)) { nextStatement(tab); return { ...out, stale: true, restate: true }; }
  }
  if (!mode) return { ...out, taken: true }; // no process yet: only the number is confirmed
  // The session's record of what the tab stated: the mode a switch is under way
  // to or failed for, else the mode it is in. The tab's own mode is judged
  // against that; what the CLI is in meanwhile is only shown, and warned of.
  const stated = (isMode(switching) && switching) || (isMode(failed) && failed) || mode;
  const result = { ...out, ...currentReport(tab, stated) };
  if (result.taken && ownMode(tab) === '') tab.settingsMode = stated;
  // (A switch that failed was already made for the tab's statement: saying it again would only fail again.)
  if (!result.taken) result.restate = !failed;
  return result;
}

// Whether a report is older than one the tab already handled, by the revision
// the bridge gave it (see "The bridge's reports have an order of their own"
// above). Remembers the highest revision handled, per bridge session.
function olderReport(tab, rev, revOf) {
  // A bridge that sends no revision: the statement number orders alone, as it did.
  if (!Number.isSafeInteger(rev) || typeof revOf !== 'string' || !revOf) return false;
  // Written by a bridge session the tab's socket has left since.
  if (tab.modeRevNow && tab.modeRevNow !== revOf) return true;
  // Another bridge session: its revisions start again, and the tab counts with it.
  if (tab.modeRevOf !== revOf) { tab.modeRevOf = revOf; tab.modeRev = rev; return false; }
  if (rev < tab.modeRev) return true;
  tab.modeRev = rev;
  return false;
}

/**
 * A message arrived on the tab's socket (before it may wait in the page's
 * buffer): the bridge session that wrote its mode report is the one the tab
 * talks to now. Messages arrive in the order written, so a report of another
 * bridge session that is handled later was written before this one.
 */
export function reportReceived(tab, msg) {
  const of = msg?.type === 'reattach_result' ? msg.modeRevOf : (msg?.type === 'event' ? msg.event?.modeRevOf : undefined);
  if (tab && typeof of === 'string' && of) tab.modeRevNow = of;
}

/** The older name of sessionReport() for a bridge that does not number: whether the report was taken. */
export function sessionMode(tab, mode, from) {
  if (typeof mode !== 'string' || !mode) return false;
  return sessionReport(tab, mode, from).taken;
}

/**
 * A statement of the tab's mode was written to its socket. Reports that are
 * behind it are on their way, not lost (`counted`: not for the `config` of a
 * starting control, which is no statement the session answers). And from the
 * moment the page sends a statement of Bypass the tab may be in Bypass: returns
 * whether that changed, for the caller to save the tab.
 */
export function statementSent(tab, { numbered = false, bypass = false, counted = true } = {}) {
  if (counted) tab.modeSent = seqOf(tab);
  if (!(numbered && bypass) || ownMode(tab) !== BYPASS_MODE || tab.mayBypass === true) return false;
  tab.mayBypass = true;
  return true;
}

/**
 * The bridge dropped a statement of this tab's because its number is older than
 * the one the session holds (`seq`: the page's saved number was lost). The tab
 * takes that number and its next statement goes beyond it. Returns whether the
 * tab has to say its mode again.
 */
export function statementDropped(tab, seq) {
  if (!Number.isSafeInteger(seq) || seq <= seqOf(tab)) return false;
  tab.modeSeq = seq;
  nextStatement(tab);
  return true;
}

/** A new socket: nothing was said on it yet. */
export function connectionOpened(tab) {
  tab.modeSent = 0;
}

/**
 * The tab holds another conversation (New chat, the session menu), or its
 * session is gone: what was known of the old session's actual mode, and of the
 * mode the settings gave it, is not about this one. The tab's own mode, its
 * pick, stays. So does whether the tab may be in Bypass: the process of the
 * conversation it left is still there until the next message replaces it, and
 * only a report ends that.
 */
export function sessionForgotten(tab) {
  tab.actualMode = '';
  tab.actualSeq = undefined;
  tab.settingsMode = '';
}

/**
 * What the mode control has to say about a tab (the arguments of modeControl()).
 * A tab with a pick shows it; one that never picked shows that it follows the
 * settings, and the mode its session reported for them once the page knows.
 * Whenever the tab may be in Bypass (it stated Bypass, or a report said so, and
 * no report at or after its latest statement says it is out of it) and the mode
 * shown is another one: `leaving`. A Bypass pick against a bridge that cannot
 * run Bypass (`numbered` and `bypass`: it announces both capabilities) waits:
 * `waiting`.
 */
export function controlFacts(tab, { settingsPick = true, numbered = false, bypass = false } = {}) {
  const own = ownMode(tab);
  const actual = tab?.actualMode || '';
  const may = tab?.mayBypass === true || actual === BYPASS_MODE;
  if (own === BYPASS_MODE) return { mode: own, follows: false, known: true, leaving: false, ...(numbered && bypass ? {} : { waiting: true }) };
  if (own) return { mode: own, follows: false, known: true, leaving: may };
  // A bridge that cannot leave the mode to the settings is told Default (statedMode): that is what the tab runs in.
  if (!settingsPick) return { mode: 'default', follows: false, known: true, leaving: may };
  const current = !Number.isSafeInteger(tab?.actualSeq) || tab.actualSeq >= seqOf(tab);
  const mode = (current && isMode(actual) ? actual : '') || (isMode(tab?.settingsMode) ? tab.settingsMode : '');
  return { mode: mode || 'default', follows: true, known: !!mode, leaving: may && mode !== BYPASS_MODE };
}

/** Whether what was typed is exactly the local, read-only /permissions command (it opens while an automation run owns the tab). */
export function isPermissionsCommand(text) {
  return typeof text === 'string' && /^\/permissions$/i.test(text.trim());
}

/**
 * An event of an automation run shown in a tab, as the tab may handle it. What
 * the run says about its own mode (its init, a status) is information about the
 * run: it is kept as `tab.runMode` and taken out of the event, and a
 * `mode_changed` is dropped. So nothing downstream can store the run's mode as
 * the tab's: the tab keeps the user's own pick, or none. (What the run does,
 * its EnterPlanMode call, is kept out of the tab's plan state by the caller's
 * `tab._runEvent` mark: sessionEnteredPlan() and sessionReport() change nothing
 * while it is set.)
 */
export function runEvent(tab, ev) {
  if (!ev || typeof ev !== 'object') return ev;
  if (ev.type === 'mode_changed' || ev.type === 'mode_state' || ev.type === 'mode_behind') return null;
  if (!('permissionMode' in ev)) return ev;
  if (typeof ev.permissionMode === 'string' && ev.permissionMode) tab.runMode = ev.permissionMode;
  return { ...ev, permissionMode: '' };
}

/**
 * What is saved for a tab: its own mode, never one it only shows. A tab without
 * a pick is saved as that (a Bypass or an Auto its session started in from the
 * settings is not written down as the tab's), plan mode with what it goes back
 * to, and the number of its latest statement, which must survive a reload.
 */
export function savedMode(tab) {
  // (`sessionBypass`: the tab may be in Bypass. Saved whatever the tab's own mode is, so a reloaded page warns from the start, until a report says the session is out of it; never the tab's mode.)
  const seq = { ...(seqOf(tab) ? { modeSeq: seqOf(tab) } : {}), ...(tab?.mayBypass === true || tab?.actualMode === BYPASS_MODE ? { sessionBypass: true } : {}) };
  const mode = tab?.permissionMode || 'default';
  if (mode === 'plan') {
    const from = tab.planFrom && typeof tab.planFrom === 'object' ? { planFrom: { mode: String(tab.planFrom.mode || ''), ...(tab.planFrom.bypassChosen === true ? { bypassChosen: true } : {}) } } : {};
    return { permissionMode: 'plan', modeChosen: tab?.modeChosen === true, bypassChosen: false, ...from, ...seq };
  }
  if (tab?.modeChosen !== true || (mode === BYPASS_MODE && tab?.bypassChosen !== true)) return { permissionMode: 'default', modeChosen: false, bypassChosen: false, ...seq };
  return { permissionMode: mode, modeChosen: true, bypassChosen: mode === BYPASS_MODE, ...seq };
}

/**
 * The mode a saved tab comes back in. `fresh` is what a new tab gets
 * (`permissionMode`, `modeChosen`). A saved Bypass comes back as Bypass only
 * with the record that the user picked it (`bypassChosen`, written by this
 * build when they did). Any other Bypass in storage (the old Auto-approve
 * toggle wrote it, an automation run's mode was saved as the tab's, an older
 * build stored it) comes back as the mode of a tab that never picked one. A
 * mode saved with the record that it was not picked (`modeChosen: false`: the
 * session reported it from the settings) is not the tab's either; one saved
 * before that record existed was the user's pick.
 */
export function restoredMode(saved, fresh = {}) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const out = {
    permissionMode: fresh.permissionMode || 'default',
    planMode: false,
    modeChosen: fresh.modeChosen === true,
    bypassChosen: false,
    planFrom: null,
    modeSeq: Number.isSafeInteger(s.modeSeq) && s.modeSeq > 0 ? s.modeSeq : 0,
    // Whether the tab may be in Bypass comes back as saved: only a report ends it.
    mayBypass: s.sessionBypass === true,
    actualMode: '',
    actualSeq: undefined,
  };
  const mode = s.permissionMode || (s.planMode ? 'plan' : '');
  if (s.planMode === true && mode !== 'plan' && !s.planFrom) {
    // An older build's /plan set the flag and left the mode: the tab was in plan mode, over that mode.
    const picked = mode === BYPASS_MODE ? s.bypassChosen === true : (isMode(mode) && (s.modeChosen === true || (typeof s.modeChosen !== 'boolean' && mode !== 'default')));
    out.permissionMode = 'plan';
    out.planMode = true;
    if (picked) out.modeChosen = true; else if (s.modeChosen === false) out.modeChosen = false;
    out.planFrom = picked ? (mode === BYPASS_MODE ? { mode: BYPASS_MODE, bypassChosen: true } : { mode }) : (out.modeChosen ? null : { mode: '' });
    return out;
  }
  if (mode === BYPASS_MODE) {
    if (s.bypassChosen === true) { out.permissionMode = BYPASS_MODE; out.modeChosen = true; out.bypassChosen = true; }
    return out;
  }
  if (!ALL_PERMISSION_MODES.includes(mode)) return out;
  if (mode === 'plan') {
    out.permissionMode = 'plan';
    out.planMode = true;
    if (typeof s.modeChosen === 'boolean') out.modeChosen = s.modeChosen;
    const from = s.planFrom && typeof s.planFrom === 'object' ? s.planFrom : null;
    if (from) {
      if (from.mode === BYPASS_MODE) out.planFrom = from.bypassChosen === true ? { mode: BYPASS_MODE, bypassChosen: true } : { mode: '' };
      else out.planFrom = { mode: isMode(from.mode) && from.mode !== 'plan' ? from.mode : '' };
    }
    return out;
  }
  if (s.modeChosen === false) { out.permissionMode = 'default'; out.modeChosen = false; return out; }
  out.permissionMode = mode;
  out.modeChosen = s.modeChosen === true || mode !== 'default' || out.modeChosen;
  return out;
}

/** Whether a model list from the session says the model in use supports auto mode. */
export function autoModeSupported(models, modelId) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return false;
  const id = String(modelId || '').toLowerCase();
  // Rows come from the session (`value`) or from the catalog (`id`).
  const exact = id ? list.find(m => String(m?.value || m?.id || '').toLowerCase() === id) : null;
  if (exact) return exact.supportsAutoMode === true;
  // No exact row (an alias, or the default model): offered if any model has it;
  // the CLI refuses the switch when the one in use does not.
  return list.some(m => m?.supportsAutoMode === true);
}

// ── Rule suggestions ──

export const DESTINATIONS = [
  { id: 'session', label: 'This session' },
  { id: 'localSettings', label: 'This project, only me' },
  { id: 'projectSettings', label: 'This project, shared' },
  { id: 'userSettings', label: 'All my projects' },
];
const DESTINATION_IDS = new Set(DESTINATIONS.map(d => d.id));
const DESTINATION_TEXT = { session: 'this session', localSettings: 'this project (only you)', projectSettings: 'this project (shared settings)', userSettings: 'all your projects', cliArg: 'this run' };

export function ruleText(rule) {
  if (!rule?.toolName) return '';
  return `${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ''}`;
}

const BEHAVIOR_VERB = { allow: 'Allow', deny: 'Deny', ask: 'Ask before' };

/** One PermissionUpdate in plain words, with the verb its behavior implies. */
export function describeSuggestion(s) {
  if (!s || typeof s !== 'object') return '';
  const rules = (Array.isArray(s.rules) ? s.rules : []).map(ruleText).filter(Boolean).join(', ');
  const verb = BEHAVIOR_VERB[s.behavior] || 'Allow';
  switch (s.type) {
    case 'addRules': return rules ? `${verb} ${rules}` : '';
    case 'replaceRules': return rules ? `Replace the ${String(s.behavior || 'allow')} rules with ${rules}` : `Clear the ${String(s.behavior || 'allow')} rules`;
    case 'removeRules': return rules ? `Remove the ${String(s.behavior || 'allow')} rule ${rules}` : '';
    case 'setMode': return s.mode ? `Switch to ${MODE_LABELS[s.mode] || s.mode} mode` : '';
    case 'addDirectories': return Array.isArray(s.directories) && s.directories.length ? `Allow access to ${s.directories.join(', ')}` : '';
    case 'removeDirectories': return Array.isArray(s.directories) && s.directories.length ? `Remove access to ${s.directories.join(', ')}` : '';
    default: return clip(JSON.stringify(s), 120);
  }
}

/**
 * What "Always" sends as updatedPermissions: the CLI's own suggestions, written
 * to the chosen destination. With no suggestion there is nothing narrow to
 * grant, except for an MCP tool, whose exact name is a rule of its own.
 */
export function alwaysUpdates(req, destination = 'session') {
  if (req?.suppress_always) return [];
  const dest = DESTINATION_IDS.has(destination) ? destination : 'session';
  const suggestions = (Array.isArray(req?.suggestions) ? req.suggestions : []).filter(s => s && typeof s === 'object' && describeSuggestion(s));
  if (suggestions.length) return suggestions.map(s => ({ ...s, destination: dest }));
  const tool = String(req?.tool_name || '');
  if (tool.startsWith('mcp__')) return [{ type: 'addRules', rules: [{ toolName: tool }], behavior: 'allow', destination: dest }];
  return [];
}

/** A granted update as a line of the /permissions view. */
export function grantedRuleLine(update) {
  const text = describeSuggestion(update);
  if (!text) return '';
  return `${text} · ${DESTINATION_TEXT[update.destination] || update.destination || 'this session'}`;
}

// ── The /permissions view ──

const SCOPE_TITLES = [['user', 'All my projects'], ['project', 'This project, shared'], ['local', 'This project, only me']];
const RULE_LIST_LABELS = [['allow', 'Allow'], ['ask', 'Ask'], ['deny', 'Deny'], ['additionalDirectories', 'Directory']];
const MAX_RULE_ROWS = 80;

/**
 * The rules of the settings files (GET /api/claude-code/permission-rules) as
 * sections of the card: one row per rule, so each can be removed by itself.
 * @returns [{ scope, title, error, defaultMode, items: [{ list, label, rule }], more }]
 */
export function permissionRuleSections(rules) {
  const out = [];
  for (const [scope, title] of SCOPE_TITLES) {
    const s = rules?.[scope];
    if (!s?.exists) continue;
    const items = [];
    if (!s.error) {
      for (const [list, label] of RULE_LIST_LABELS) {
        for (const rule of Array.isArray(s[list]) ? s[list] : []) if (typeof rule === 'string' && rule) items.push({ list, label, rule });
      }
    }
    out.push({ scope, title, error: s.error || '', defaultMode: s.error ? '' : (s.defaultMode || ''), items: items.slice(0, MAX_RULE_ROWS), more: Math.max(0, items.length - MAX_RULE_ROWS) });
  }
  return out;
}

/** True when a granted update lives only in the running session (it has no settings file to be removed from). */
export function hasSessionRules(granted) {
  return (Array.isArray(granted) ? granted : []).some(u => u && typeof u === 'object' && (!u.destination || u.destination === 'session'));
}

// ── The prompt's context ──

/**
 * What the CLI said about a permission request, ready for the card.
 * `rows` are [label, text]; every string is display text from the CLI or from
 * configuration (an MCP server's name is untrusted) and must be set as text.
 */
export function permissionContext(req) {
  const r = req && typeof req === 'object' ? req : {};
  const rows = [];
  if (r.decision_reason) rows.push(['Why', clip(plain(r.decision_reason), 400)]);
  if (r.blocked_path) rows.push(['Path', clip(plain(r.blocked_path), 300)]);
  if (r.mcp_server?.name) rows.push(['MCP server', `${clip(plain(r.mcp_server.name), 80)}${r.mcp_server.source ? ` (${plain(r.mcp_server.source)})` : ''}`]);
  if (r.matched_ask_rule) {
    const rule = ruleText({ toolName: r.matched_ask_rule.toolName, ruleContent: r.matched_ask_rule.ruleContent });
    rows.push(['Asked because', `your ask rule ${rule || '(unnamed)'}${r.matched_ask_rule.source ? ` in ${plain(r.matched_ask_rule.source)}` : ''}`]);
  }
  if (r.agent_id) rows.push(['From', `subagent ${clip(plain(r.agent_id), 40)}`]);
  return {
    title: clip(plain(r.title), 300),
    displayName: clip(plain(r.display_name), 80),
    description: clip(plain(r.description), 400),
    rows,
    defaultToNo: r.default_to_no === true,
    canAlways: r.suppress_always !== true && alwaysUpdates(r).length > 0,
    toolUseId: r.tool_use_id || '',
  };
}

// ── MCP elicitation ──

/**
 * The fields of an elicitation form, from the server's requestedSchema (a flat
 * object of primitive properties, per the MCP spec).
 */
export function elicitationFields(schema) {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fields = [];
  for (const [name, raw] of Object.entries(props)) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const options = Array.isArray(p.enum)
      ? p.enum.map((v, i) => ({ value: v, label: String(Array.isArray(p.enumNames) && p.enumNames[i] != null ? p.enumNames[i] : v) }))
      : (Array.isArray(p.oneOf) ? p.oneOf.filter(o => o && 'const' in o).map(o => ({ value: o.const, label: String(o.title ?? o.const) })) : null);
    const type = options?.length ? 'choice'
      : p.type === 'boolean' ? 'boolean'
        : (p.type === 'number' || p.type === 'integer') ? 'number'
          : 'text';
    fields.push({
      name,
      type,
      integer: p.type === 'integer',
      label: clip(plain(p.title || name), 80),
      description: clip(plain(p.description), 300),
      required: required.has(name),
      options: options?.length ? options : null,
      format: typeof p.format === 'string' ? p.format : '',
      default: p.default,
      min: Number.isFinite(p.minimum) ? p.minimum : null,
      max: Number.isFinite(p.maximum) ? p.maximum : null,
      minLength: Number.isFinite(p.minLength) ? p.minLength : null,
      maxLength: Number.isFinite(p.maxLength) ? p.maxLength : null,
    });
  }
  return fields;
}

/**
 * Typed content from what the form holds. `values` maps field name to the raw
 * control value (string, or boolean for a checkbox).
 * @returns {{ ok: boolean, content: object, errors: Record<string, string> }}
 */
export function collectElicitation(fields, values) {
  const content = {};
  const errors = {};
  for (const f of Array.isArray(fields) ? fields : []) {
    const raw = values?.[f.name];
    if (f.type === 'boolean') { content[f.name] = raw === true || raw === 'true'; continue; }
    const text = raw == null ? '' : String(raw).trim();
    if (!text) {
      if (f.required) errors[f.name] = 'Required';
      continue;
    }
    if (f.type === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n) || (f.integer && !Number.isInteger(n))) { errors[f.name] = f.integer ? 'Enter a whole number' : 'Enter a number'; continue; }
      if (f.min != null && n < f.min) { errors[f.name] = `At least ${f.min}`; continue; }
      if (f.max != null && n > f.max) { errors[f.name] = `At most ${f.max}`; continue; }
      content[f.name] = n;
      continue;
    }
    if (f.type === 'choice') {
      const opt = f.options.find(o => String(o.value) === text);
      if (!opt) { errors[f.name] = 'Pick one of the options'; continue; }
      content[f.name] = opt.value;
      continue;
    }
    if (f.minLength != null && text.length < f.minLength) { errors[f.name] = `At least ${f.minLength} characters`; continue; }
    if (f.maxLength != null && text.length > f.maxLength) { errors[f.name] = `At most ${f.maxLength} characters`; continue; }
    if (f.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) { errors[f.name] = 'Enter an email address'; continue; }
    if (f.format === 'uri' && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(text)) { errors[f.name] = 'Enter a URL'; continue; }
    content[f.name] = text;
  }
  return { ok: Object.keys(errors).length === 0, content, errors };
}

/** The address a URL-mode elicitation sends the user to, when it is safe to open. */
export function elicitationUrl(request) {
  const url = String(request?.url || '');
  return /^https?:\/\//i.test(url) ? url : '';
}

// ── Tool policy ──

export const TOOL_POLICIES = {
  full: { label: 'All tools', hint: 'No tool is removed' },
  'read-only': { label: 'Read only', hint: 'No edits, no commands: Edit, Write, NotebookEdit and Bash are removed' },
  'no-web': { label: 'No web', hint: 'WebFetch and WebSearch are removed' },
};

export function toolPolicyId(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (v === 'readonly') return 'read-only';
  if (v === 'noweb' || v === 'no-network' || v === 'offline') return 'no-web';
  return TOOL_POLICIES[v] ? v : '';
}
