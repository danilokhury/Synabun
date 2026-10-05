// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — composer decisions (no DOM)
// Slash commands, shell mode, the prompt queue, prompt history, the agent list,
// attachments and @ mentions. ocp-v2-send.js is the glue that asks these
// questions on key presses and sends.
// ─────────────────────────────────────────────────────────────────────────────

// ── Slash commands ──────────────────────────────────────────────────────────
// kind:
//   local    handled by the panel (`action`), never reaches the model
//   command  an OpenCode command / skill / MCP prompt → session.command
//   tui      only exists in the terminal UI → opens the CLI in the Terminal
//   text     no way to run it on this server → sent as typed (legacy fallback)
// `needs`: request types the action depends on; without them the entry is left
// out, so a server that predates them never shows a command that cannot work.

export const LOCAL_SLASH_COMMANDS = Object.freeze([
  { name: 'new', description: 'Start a new session', action: 'new', aliases: ['clear'] },
  { name: 'sessions', description: 'List, search and switch sessions', action: 'sessions', aliases: ['resume', 'continue'] },
  { name: 'compact', description: 'Compact context', action: 'compact', aliases: ['summarize'] },
  { name: 'undo', description: 'Undo the last prompt', action: 'undo', needs: ['session:revert'] },
  { name: 'redo', description: 'Restore what was undone', action: 'redo', needs: ['session:unrevert'] },
  { name: 'share', description: 'Share this session (public link)', action: 'share', needs: ['session:share', 'session:unshare'] },
  { name: 'unshare', description: 'Stop sharing this session', action: 'unshare', needs: ['session:share', 'session:unshare'] },
  { name: 'export', description: 'Export the transcript as JSON', action: 'export' },
  { name: 'fork', description: 'Fork this session', action: 'fork', needs: ['session:fork'] },
  { name: 'models', description: 'Pick a model', action: 'models' },
  { name: 'agents', description: 'Switch agent', action: 'agents', aliases: ['agent'] },
  { name: 'help', description: 'Show what the composer can do', action: 'help' },
]);

// Terminal-UI-only commands: they act on the TUI itself.
export const TUI_SLASH_COMMANDS = Object.freeze([
  { name: 'providers', description: 'Manage providers & auth' },
  { name: 'themes', description: 'Pick a theme' },
  { name: 'editor', description: 'Open in editor' },
  { name: 'tokens', description: 'Token usage stats' },
  { name: 'config', description: 'Open config' },
  { name: 'login', description: 'Provider login' },
  { name: 'logout', description: 'Provider logout' },
  { name: 'exit', description: 'Exit OpenCode', aliases: ['quit'] },
]);

const SERVER_SOURCES = new Set(['command', 'skill', 'mcp']);

/**
 * Everything the slash menu lists.
 *   serverCommands  rows of command:list, or null when the server has none
 *   legacy          { skills, userCommands } from the pre-SDK REST lists, used
 *                   only when serverCommands is null
 *   supports(type)  capability check
 *   sharePolicy     OpenCode's `share` setting; 'disabled' removes /share and /unshare
 */
export function buildSlashCatalog({ serverCommands = null, legacy = null, supports = () => false, sharePolicy = null } = {}) {
  const out = [];
  const seen = new Set();
  const add = (entry) => {
    const names = [entry.name, ...(entry.aliases || [])];
    if (names.some((n) => seen.has(n))) return;
    names.forEach((n) => seen.add(n));
    out.push(entry);
  };
  for (const cmd of LOCAL_SLASH_COMMANDS) {
    if ((cmd.needs || []).some((type) => !supports(type))) continue;
    if (sharePolicy === 'disabled' && (cmd.action === 'share' || cmd.action === 'unshare')) continue;
    add({ name: cmd.name, description: cmd.description, aliases: cmd.aliases || [], source: 'builtin', kind: 'local', action: cmd.action });
  }
  const canRun = supports('command:run');
  if (Array.isArray(serverCommands) && canRun) {
    for (const cmd of serverCommands) {
      if (!cmd || typeof cmd.name !== 'string' || !cmd.name) continue;
      add({
        name: cmd.name,
        description: cmd.description || '',
        source: SERVER_SOURCES.has(cmd.source) ? cmd.source : 'command',
        kind: 'command',
        hints: Array.isArray(cmd.hints) ? cmd.hints : [],
      });
    }
  } else if (legacy) {
    // The server cannot run commands: list what the old REST endpoints know,
    // and send them as typed, exactly as before.
    for (const s of legacy.skills || []) {
      const name = String(s?.name || s?.dirName || '').trim();
      if (name) add({ name, description: String(s.description || '').trim(), source: 'skill', kind: 'text' });
    }
    for (const c of legacy.userCommands || []) {
      const name = String(c?.name || '').trim();
      if (name) add({ name, description: String(c.description || '').trim(), source: 'command', kind: 'text' });
    }
    add({ name: 'init', description: 'Initialize project (AGENTS.md)', source: 'builtin', kind: 'tui' });
  }
  for (const cmd of TUI_SLASH_COMMANDS) {
    add({ name: cmd.name, description: cmd.description, aliases: cmd.aliases || [], source: 'builtin', kind: 'tui' });
  }
  return out;
}

// ── /help ───────────────────────────────────────────────────────────────────
// A card at the end of the transcript, built by the panel from the catalog the
// slash menu lists. It is not a message: nothing of it reaches the model.

const HELP_SOURCE_LABELS = Object.freeze({ builtin: 'panel', command: 'OpenCode command', skill: 'skill', mcp: 'MCP prompt' });
const HELP_SOURCE_ORDER = ['builtin', 'command', 'skill', 'mcp'];
// Commands of the project can be many; the slash menu lists them all.
export const HELP_COMMANDS_PER_SOURCE = 8;

/**
 * What /help shows: `{ title, note, sections: [{ title, rows: [{ name, text,
 * source }] }] }`.
 *   catalog         the slash catalog of the composer's directory (buildSlashCatalog)
 *   supports(type)  capability check: what the server cannot do is not listed
 *   canAct          false in a sub-agent panel (its messages offer Copy only)
 */
export function helpCardView({ catalog = [], supports = () => false, canAct = true } = {}) {
  const sections = [];
  const entries = (Array.isArray(catalog) ? catalog : []).filter((entry) => entry && typeof entry.name === 'string' && entry.name);
  const commandRow = (entry) => ({
    name: [entry.name, ...(entry.aliases || [])].map((name) => `/${name}`).join(', '),
    text: String(entry.description || ''),
    source: entry.kind === 'tui' ? 'opens the terminal' : (HELP_SOURCE_LABELS[entry.source] || HELP_SOURCE_LABELS.command),
  });
  const commands = [];
  const local = entries.filter((entry) => entry.kind !== 'tui' && (entry.source || 'builtin') === 'builtin');
  commands.push(...local.map(commandRow));
  for (const source of HELP_SOURCE_ORDER.slice(1)) {
    const group = entries.filter((entry) => entry.kind !== 'tui' && entry.source === source);
    commands.push(...group.slice(0, HELP_COMMANDS_PER_SOURCE).map(commandRow));
    if (group.length > HELP_COMMANDS_PER_SOURCE) {
      commands.push({ name: '…', text: `and ${group.length - HELP_COMMANDS_PER_SOURCE} more: type / to list them all`, source: HELP_SOURCE_LABELS[source] });
    }
  }
  commands.push(...entries.filter((entry) => entry.kind === 'tui').map(commandRow));
  if (commands.length) sections.push({ title: 'Slash commands', rows: commands });

  const mentionable = [
    supports('find:files') && 'a file',
    supports('find:symbols') && 'a workspace symbol',
    supports('resource:list') && 'an MCP resource',
    supports('reference:list') && 'a reference',
  ].filter(Boolean);
  if (mentionable.length) {
    const list = mentionable.length > 1 ? `${mentionable.slice(0, -1).join(', ')} or ${mentionable[mentionable.length - 1]}` : mentionable[0];
    sections.push({ title: 'Mentions', rows: [{ name: '@', text: `Type @ and pick ${list}: it is sent with the prompt.` }] });
  }
  if (supports('session:shell')) {
    sections.push({ title: 'Shell mode', rows: [{
      name: '!',
      text: 'Press ! in the empty box to run a shell command in the session’s directory, with no model in between. Escape, or Backspace on the empty line, leaves.',
    }] });
  }
  sections.push({ title: 'Queue', rows: [{
    name: 'Enter',
    text: 'While a turn runs, Enter queues the prompt. The queue is listed above the box and sent in order when the turn ends; after a failed turn it waits for Resume.',
  }] });
  const mine = ['Copy', canAct && supports('session:revert') && 'Undo to here', canAct && supports('session:fork') && 'Fork from here', canAct && supports('message:delete') && 'Delete'].filter(Boolean);
  const replies = ['Copy', canAct && supports('session:revert') && 'Retry'].filter(Boolean);
  sections.push({ title: 'Message actions', rows: [
    { name: 'Your prompts', text: `Hover one: ${mine.join(', ')}.` },
    { name: 'Replies', text: `Hover one: ${replies.join(', ')}.` },
  ] });
  return { title: 'OpenCode panel help', note: 'Shown here only: nothing was sent to the model.', sections };
}

/** `/name rest…` at the very start of the text → { name, args }, else null. */
export function parseSlashInput(text) {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  return { name: m[1], args: (m[2] || '').trim() };
}

/**
 * What a typed line does. null → it is an ordinary prompt (including a
 * `/word` no command is named after, an absolute path, a `text` entry).
 */
export function resolveSlash(text, catalog) {
  const parsed = parseSlashInput(text);
  if (!parsed) return null;
  const entry = (catalog || []).find((c) => c.name === parsed.name || (c.aliases || []).includes(parsed.name));
  if (!entry || entry.kind === 'text') return null;
  if (entry.kind === 'local') return { kind: 'local', action: entry.action, name: entry.name, args: parsed.args };
  if (entry.kind === 'command') return { kind: 'command', command: entry.name, args: parsed.args };
  return { kind: 'tui', command: entry.name, args: parsed.args };
}

/**
 * Slash catalogs by project directory. Commands, skills and MCP prompts depend
 * on the directory, and several composers are on the page at once (the panel
 * and a sub-agent panel, each with its own session), so there is no "current"
 * catalog: each composer reads the one of its own directory.
 *   load(cwd)     async → the catalog for that directory (throws on failure)
 *   fallback()    the catalog to show before (or without) a loaded one
 */
export function createSlashCatalogCache({ load, fallback }) {
  let generation = 0;
  const loaded = new Map();     // cwd → catalog
  const inflight = new Map();   // cwd → Promise
  const keyOf = (cwd) => String(cwd || '');
  return {
    /** What this directory lists right now; never waits. */
    get(cwd) { return loaded.get(keyOf(cwd)) || fallback(); },
    has(cwd) { return loaded.has(keyOf(cwd)); },
    /** Load once per directory (until invalidate). A failure is not cached. */
    load(cwd) {
      const key = keyOf(cwd);
      if (loaded.has(key)) return Promise.resolve(loaded.get(key));
      if (inflight.has(key)) return inflight.get(key);
      const startedAt = generation;
      const promise = Promise.resolve()
        .then(() => load(key))
        .then((catalog) => {
          if (startedAt === generation && Array.isArray(catalog)) loaded.set(key, catalog);
          return loaded.get(key) || fallback();
        })
        .catch(() => fallback())
        .finally(() => { if (inflight.get(key) === promise) inflight.delete(key); });
      inflight.set(key, promise);
      return promise;
    },
    /** Forget everything (the server's capabilities changed). */
    invalidate() {
      generation += 1;
      loaded.clear();
      inflight.clear();
    },
  };
}

// ── Shell mode ──────────────────────────────────────────────────────────────
// A shell command runs with no model in between, so the way in is narrow: the
// user presses "!" on an empty composer. Text that arrives any other way
// (pasted, set by a handoff / automation / openOpencodeWithPrompt, a file
// attach) is a prompt, whatever its first character, and takes the composer
// out of shell mode if it was in it.

/**
 * A key press in the composer.
 *   { shell, value, key, trusted, composing, supported } → { shell, preventDefault }
 * `trusted` is event.isTrusted: a synthetic key event never enters shell mode.
 */
export function shellKey({ shell = false, value = '', key = '', trusted = false, composing = false, supported = false } = {}) {
  if (!shell) {
    const enter = supported && trusted && !composing && key === '!' && value === '';
    return { shell: enter, preventDefault: enter };
  }
  // In shell mode: Escape leaves; Backspace on an empty line leaves.
  if (key === 'Escape') return { shell: false, preventDefault: true };
  if (key === 'Backspace' && value === '') return { shell: false, preventDefault: true };
  return { shell: true, preventDefault: false };
}

/**
 * The last check before a shell command runs: the composer is in shell mode
 * and holds exactly what the user's own input events produced there. Text that
 * got into the box any other way while it was armed is not run.
 */
export function shellRunAllowed({ shell = false, value = '', typedValue = '' } = {}) {
  return shell === true && value === typedValue && value.trim() !== '';
}

/** Text was written into the composer by code, not typed: never a shell command. */
export function shellAfterProgrammaticInput() {
  return false;
}

// ── Prompt queue (client side) ──────────────────────────────────────────────
// Prompts typed while a turn runs wait here and go out one by one as turns
// finish. Stopping a turn or an error pauses the queue: the user asked for a
// halt, not for the next prompt to fire.

export const PROMPT_QUEUE_MAX = 20;

export function createPromptQueue() {
  let items = [];
  let paused = false;
  let seq = 0;
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* listener's problem */ } } };
  return {
    list: () => items.slice(),
    size: () => items.length,
    isPaused: () => paused,
    add(entry) {
      const text = String(entry?.text || '').trim();
      const images = Array.isArray(entry?.images) ? entry.images : [];
      const paths = Array.isArray(entry?.paths) ? entry.paths : [];
      // File parts of the @ mentions picked while typing this prompt.
      const mentions = Array.isArray(entry?.mentions) ? entry.mentions : [];
      if (!text && !images.length && !paths.length) return null;
      if (items.length >= PROMPT_QUEUE_MAX) return null;
      seq += 1;
      const item = { id: `q${seq}`, text, images, paths, mentions };
      items = [...items, item];
      emit();
      return item;
    },
    remove(id) {
      const before = items.length;
      items = items.filter((item) => item.id !== id);
      if (items.length !== before) emit();
    },
    /** Take the next prompt out. */
    shift() {
      const [next, ...rest] = items;
      if (!next) return null;
      items = rest;
      emit();
      return next;
    },
    /** Put a prompt back at the front (its send failed). */
    unshift(item) {
      if (!item) return;
      items = [item, ...items];
      emit();
    },
    /**
     * Put prompts back that were taken out of this session's queue (or sent
     * from its composer) and could not be delivered while the panel was on
     * another session: at the front, in their order, and the queue holds.
     */
    restore(entries) {
      const back = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry) continue;
        seq += 1;
        const item = {
          id: `q${seq}`,
          text: String(entry.text || '').trim(),
          images: Array.isArray(entry.images) ? entry.images : [],
          paths: Array.isArray(entry.paths) ? entry.paths : [],
          mentions: Array.isArray(entry.mentions) ? entry.mentions : [],
        };
        // A slash command that could not run (only the parking hands these
        // out; `add` never makes one): it runs as that command again.
        if (entry.command?.command) item.command = { command: String(entry.command.command), args: String(entry.command.args || '') };
        back.push(item);
      }
      if (!back.length) return 0;
      items = [...back, ...items];
      paused = true;
      emit();
      return back.length;
    },
    pause() { if (!paused && items.length) { paused = true; emit(); } },
    resume() { if (paused) { paused = false; emit(); } },
    clear() {
      if (!items.length && !paused) return;
      items = [];
      paused = false;
      emit();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/**
 * What a session's composer still owes it while the panel is on another
 * session, kept per session and in memory:
 *   • its outgoing queue, as it was when the panel left (`leave`);
 *   • prompts and slash commands that failed to go out after the panel had
 *     left (`park`). They go in front: they were on their way before the rest.
 * Nothing here ever goes to the session on screen: `take(sessionId)` hands a
 * session's entry out when the panel is bound to that session again, and the
 * composer puts it in its queue, paused, with the reason.
 * Nothing is ever evicted: every entry is prompts the user has not sent yet.
 * The bound (`max` sessions with something waiting) is kept where refusing
 * loses nothing: `isFull()` tells the composer not to start one more queue
 * (the prompt stays in the box, and the user is told). What is already
 * queued or on its way is always taken (`leave`, `park`).
 * An entry leaves only through `take` (the panel is back) or `forget` (the
 * session's tab was closed, or the session is gone). `forget` hands back what
 * it drops and remembers the session as gone, so a send of it that fails
 * afterwards is not kept for a session nobody can return to (`park` is
 * false; `goneAs` says whether the user closed it or it was lost, and the
 * composer keeps the prompts of the latter for the user: keptPromptNotice);
 * `reopen` (the panel is bound to it again) lifts that.
 * Only so many gone sessions are remembered. `hasTab(sessionId)` (the panel
 * says which sessions have a tab) covers the rest: nothing is kept here for a
 * session without a tab, and one nothing remembers the end of counts as lost.
 * Without `hasTab` (a sub-agent panel, which is never rebound) every session
 * counts as having one.
 */
export const PARKED_SESSIONS_MAX = 64;
const GONE_SESSIONS_MAX = 256;

const parkedItem = (item) => {
  const out = {
    text: String(item.text || ''),
    images: Array.isArray(item.images) ? [...item.images] : [],
    paths: Array.isArray(item.paths) ? [...item.paths] : [],
    mentions: Array.isArray(item.mentions) ? [...item.mentions] : [],
  };
  if (item.command?.command) out.command = { command: String(item.command.command), args: String(item.command.args || '') };
  return out;
};

export function createParkedPrompts({ max = PARKED_SESSIONS_MAX, hasTab = () => true } = {}) {
  const bySession = new Map();      // sessionId → { failed, queued, errors }
  const gone = new Map();           // sessionId → 'closed' | 'lost', oldest first
  // Nobody can return to a session that is gone or has no tab.
  const nobodyReturnsTo = (key) => gone.has(key) || !hasTab(key);
  const entryFor = (key) => {
    let entry = bySession.get(key);
    if (!entry) { entry = { failed: [], queued: [], errors: [] }; bySession.set(key, entry); }
    return entry;
  };
  const itemsOf = (entry) => [...entry.failed, ...entry.queued];
  return {
    /**
     * A prompt (or command) of `sessionId` that could not be delivered. Always
     * kept, also past the bound (it has no other place to be). False only for
     * a session that is gone or has no tab: there is nobody to hand it back to.
     */
    park(sessionId, { item, error = '' } = {}) {
      const key = String(sessionId || '');
      if (!key || !item || nobodyReturnsTo(key)) return false;
      const entry = entryFor(key);
      entry.failed.push(parkedItem(item));
      if (error && !entry.errors.includes(error)) entry.errors.push(String(error));
      return true;
    },
    /**
     * The panel leaves `sessionId` with these prompts still in its queue.
     * Always kept, except for a session that is gone or has no tab (0: the
     * composer keeps them for the user, see onRebound).
     */
    leave(sessionId, items) {
      const key = String(sessionId || '');
      const list = (Array.isArray(items) ? items : []).filter(Boolean);
      if (!key || !list.length || nobodyReturnsTo(key)) return 0;
      entryFor(key).queued.push(...list.map(parkedItem));
      return list.length;
    },
    /**
     * What is kept for `sessionId`, removed from here: `{ items, failed,
     * queued, errors }` (`items` is failed first, then the queue, each in its
     * order). null when nothing is.
     */
    take(sessionId) {
      const key = String(sessionId || '');
      const entry = bySession.get(key);
      if (!entry) return null;
      bySession.delete(key);
      return { items: itemsOf(entry), failed: entry.failed.length, queued: entry.queued.length, errors: entry.errors };
    },
    /** What is kept for `sessionId`, left where it is (to ask before a tab is closed). */
    peek(sessionId) {
      const entry = bySession.get(String(sessionId || ''));
      return entry ? itemsOf(entry) : [];
    },
    /**
     * The session's tab was closed, or the session is gone: what was kept for
     * it cannot be delivered any more. Returns the items that were dropped
     * (the caller asked the user first, or keeps them for the user: keptPromptNotice).
     * `lost`: nobody closed it (it was deleted elsewhere, OpenCode lost it).
     */
    forget(sessionId, { lost = false } = {}) {
      const key = String(sessionId || '');
      if (!key) return [];
      gone.delete(key);
      gone.set(key, lost ? 'lost' : 'closed');
      while (gone.size > GONE_SESSIONS_MAX) gone.delete(gone.keys().next().value);
      const entry = bySession.get(key);
      if (!entry) return [];
      bySession.delete(key);
      return itemsOf(entry);
    },
    /** The panel is bound to `sessionId` (again): it is not gone. */
    reopen(sessionId) { gone.delete(String(sessionId || '')); },
    /**
     * '' while the session is not known to be gone, else how it went: 'closed'
     * (by the user) or 'lost'. A session without a tab that nothing remembers
     * the end of (its marker aged out) is 'lost': what fails for it is kept
     * for the user, never parked for nobody and never dropped without a word.
     */
    goneAs(sessionId) {
      const key = String(sessionId || '');
      return gone.get(key) || (key && !hasTab(key) ? 'lost' : '');
    },
    /**
     * As many sessions have prompts waiting as the bound allows: no further
     * queue should be started (see the composer's enqueue). Nothing is evicted.
     */
    isFull: () => bySession.size >= max,
    has: (sessionId) => bySession.has(String(sessionId || '')),
    size: () => bySession.size,
  };
}

/** The tray note for what came back from the parking (`take`'s answer). */
export function parkedPromptsNotice(entry) {
  const count = entry?.items?.length || 0;
  if (!count) return '';
  // Entries made before the queue itself was parked carry no counts: all failed.
  const failed = typeof entry.failed === 'number' ? entry.failed : count;
  const queued = typeof entry.queued === 'number' ? entry.queued : 0;
  const why = (entry.errors || []).filter(Boolean).join('; ');
  const parts = [];
  if (failed) {
    parts.push(`${failed === 1 ? 'A prompt sent to this session was' : `${failed} prompts sent to this session were`} not delivered${why ? ` (${why})` : ''}.`);
  }
  if (queued) {
    parts.push(`${queued === 1 ? 'A prompt was' : `${queued} prompts were`} waiting in this session's queue when you left it.`);
  }
  parts.push(`${count === 1 ? 'It is' : 'They are'} in the queue, paused: resume to send, or remove.`);
  return parts.join(' ');
}

const promptExcerpt = (item) => {
  const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(attachments)';
  return text.length > 60 ? `“${text.slice(0, 60)}…”` : `“${text}”`;
};

/**
 * The notice for one prompt whose session went away by itself (it was deleted
 * somewhere else, OpenCode lost it) or has no tab left: there was no moment to
 * ask, and there is no session to deliver it to. The prompt is kept on the
 * notice, whole (text, attachments, referenced paths, picked mentions), until
 * the user puts it back into the box or discards it. The notice says what it
 * holds and how long: it is in memory, like the queue it came from.
 */
export function keptPromptNotice({ item, label = '' } = {}) {
  if (!item) return '';
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const files = (item.images?.length || 0) + (item.paths?.length || 0);
  const mentions = item.mentions?.length || 0;
  const extras = [files ? count(files, 'attachment') : '', mentions ? count(mentions, 'mention') : ''].filter(Boolean);
  const what = `${promptExcerpt(item)}${item.command?.command ? ' (command)' : ''}${extras.length ? ` with ${extras.join(' and ')}` : ''}`;
  const where = label ? `“${label}”, and that session is gone` : 'a session that is gone';
  return `Not sent: ${what} was waiting for ${where}. It is kept here until you put it back into the box or discard it; reloading the page drops it.`;
}

/**
 * What putting a kept prompt back adds to the draft, which is never written
 * over: its text goes under what is being typed (prefilledDraft), its
 * attachments and referenced paths go back to the strips, and its mentions
 * become picked mentions again, so the next send rebuilds the very same file
 * parts (mentionItemOfPart). `lost` names a mention part that does not say
 * which `@token` it was typed as (the composer makes none like that).
 */
export function keptPromptDraft(item, draft = '') {
  const mentions = [];
  const lost = [];
  for (const part of Array.isArray(item?.mentions) ? item.mentions : []) {
    const picked = mentionItemOfPart(part);
    if (picked) mentions.push(picked);
    else lost.push(String(part?.filename || part?.url || 'a mention'));
  }
  return {
    text: prefilledDraft(draft, item?.text),
    images: Array.isArray(item?.images) ? [...item.images] : [],
    paths: Array.isArray(item?.paths) ? [...item.paths] : [],
    mentions,
    lost,
  };
}

// A prompt by what it is (the queue's own id of it is not part of that).
const promptIdentity = (item) => JSON.stringify([
  String(item?.text || ''), item?.images || [], item?.paths || [], item?.mentions || [],
  item?.command?.command ? [String(item.command.command), String(item.command.args || '')] : null,
]);

/**
 * True when two lists hold exactly the same prompts (text, attachments,
 * paths, mentions, command), in any order. What the user was asked about
 * before a tab closes is compared with this, not by how many there are.
 */
export function samePrompts(a, b) {
  const identities = (list) => (Array.isArray(list) ? list : []).map(promptIdentity).sort();
  const left = identities(a);
  const right = identities(b);
  return left.length === right.length && left.every((identity, i) => identity === right[i]);
}

/**
 * The question asked before a tab is closed while prompts are still waiting
 * for its session (its queue, a prompt that could not be delivered): closing
 * discards them, so the user decides. '' when nothing is waiting (no question).
 * `lead` replaces the first sentence (the session menu's Delete has its own).
 */
export function closeWithPromptsConfirm({ items = [], label = '', lead = '' } = {}) {
  const count = items.length;
  if (!count) return '';
  const shown = items.slice(0, 5).map((item) => `• ${promptExcerpt(item)}${item?.command?.command ? ' (command)' : ''}`);
  if (count > shown.length) shown.push(`• and ${count - shown.length} more`);
  const first = lead || `Close ${label ? `“${label}”` : 'this session'}?`;
  const what = count === 1 ? 'A prompt is still waiting to be sent there and will be discarded' : `${count} prompts are still waiting to be sent there and will be discarded`;
  return `${first}\n\n${what}:\n${shown.join('\n')}`;
}

/** The banner when one more queue cannot be started (createParkedPrompts `isFull`). */
export function parkingFullNotice(max = PARKED_SESSIONS_MAX) {
  return `Not queued: ${max} other tabs already hold prompts that are waiting. Resume or clear some of those first.`;
}

/**
 * A prompt another part of the app hands to the composer (a handoff) goes
 * into the box for the user to send. A draft that is already being written
 * there is kept: the handed-over text is added under it, never put in its place.
 */
export function prefilledDraft(current, incoming) {
  const draft = String(current || '');
  const text = String(incoming || '');
  if (!draft.trim()) return text;
  if (!text.trim() || draft.includes(text)) return draft;
  return `${draft.replace(/\s+$/, '')}\n\n${text}`;
}

/** True when the next queued prompt may go out now. */
export function queueCanDrain(queue, state) {
  if (!queue.size() || queue.isPaused()) return false;
  if (!state.sessionId || state.running) return false;
  if ((state.pendingPermissions || []).length || (state.pendingQuestions || []).length) return false;
  if (state.showPostPlanActions || state.planTurnActive) return false;
  if (state.sessionStatus?.type === 'busy' || state.sessionStatus?.type === 'retry') return false;
  return true;
}

// ── Prompt history (ArrowUp / ArrowDown) ────────────────────────────────────

export const PROMPT_HISTORY_MAX = 50;

export function createPromptHistory(initial = []) {
  let entries = (Array.isArray(initial) ? initial : []).filter((e) => typeof e === 'string' && e).slice(-PROMPT_HISTORY_MAX);
  let cursor = -1;      // -1 = the draft; 0 = newest entry
  let draft = '';
  return {
    entries: () => entries.slice(),
    push(text) {
      const value = String(text || '').trim();
      cursor = -1;
      draft = '';
      if (!value || entries[entries.length - 1] === value) return;
      entries = [...entries, value].slice(-PROMPT_HISTORY_MAX);
    },
    /** One step back in time; `current` is what the box holds now. null = nothing older. */
    prev(current) {
      if (cursor + 1 >= entries.length) return null;
      if (cursor === -1) draft = String(current || '');
      cursor += 1;
      return entries[entries.length - 1 - cursor];
    },
    /** One step forward; returns the draft when it runs off the newest entry. null = already at the draft. */
    next() {
      if (cursor === -1) return null;
      cursor -= 1;
      return cursor === -1 ? draft : entries[entries.length - 1 - cursor];
    },
    reset() { cursor = -1; draft = ''; },
    browsing: () => cursor !== -1,
  };
}

/** ArrowUp recalls history only where it would not move the caret inside the text. */
export function historyKeyApplies({ key, value = '', selectionStart = 0, selectionEnd = 0, browsing = false }) {
  if (selectionStart !== selectionEnd) return false;
  if (key === 'ArrowUp') return value === '' || browsing || !value.slice(0, selectionStart).includes('\n') && selectionStart === 0;
  if (key === 'ArrowDown') return browsing && !value.slice(selectionEnd).includes('\n');
  return false;
}

// ── Stop with Escape ────────────────────────────────────────────────────────
// One Escape is too easy to hit by accident while a turn runs: the first press
// arms, a second within the window stops.

export const ESCAPE_STOP_WINDOW_MS = 2000;

export function escapeStop(armedAt, now, running) {
  if (!running) return { stop: false, armedAt: 0 };
  if (armedAt && now - armedAt <= ESCAPE_STOP_WINDOW_MS) return { stop: true, armedAt: 0 };
  return { stop: false, armedAt: now };
}

// ── Agents ──────────────────────────────────────────────────────────────────

/** Agents the user can pick: primary or all-mode, not hidden; build and plan first. */
export function selectableAgents(list) {
  const rank = (name) => (name === 'build' ? 0 : name === 'plan' ? 1 : 2);
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a.name === 'string' && a.name && !a.hidden && (a.mode === 'primary' || a.mode === 'all'))
    .filter((a) => (seen.has(a.name) ? false : seen.add(a.name)))
    .map((a) => ({ name: a.name, description: typeof a.description === 'string' ? a.description : '', color: a.color || '' }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

// What the toggle shows before (or without) the agent list: the two built-ins.
export const DEFAULT_AGENTS = Object.freeze([
  { name: 'build', description: 'The default agent', color: '' },
  { name: 'plan', description: 'Plan mode: no edits', color: '' },
]);

/**
 * The agent list by project directory. `fetchAgents(cwd)` resolves the raw
 * agents, or nothing when OpenCode is not up yet. An empty answer is never
 * remembered: the composer mounts before the server is ready, and the next
 * load (after `ready`, a reconnect, a project change) asks again.
 */
export function createAgentCatalog(fetchAgents) {
  const loaded = new Map();     // cwd → selectable agents (never empty)
  const inflight = new Map();
  const keyOf = (cwd) => String(cwd || '');
  return {
    get(cwd) { return loaded.get(keyOf(cwd)) || null; },
    load(cwd, { force = false } = {}) {
      const key = keyOf(cwd);
      if (!force && loaded.has(key)) return Promise.resolve(loaded.get(key));
      if (inflight.has(key)) return inflight.get(key);
      const promise = Promise.resolve()
        .then(() => fetchAgents(key))
        .then((raw) => {
          const agents = selectableAgents(raw);
          if (agents.length) loaded.set(key, agents);
          return agents.length ? agents : (loaded.get(key) || []);
        })
        .catch(() => loaded.get(key) || [])
        .finally(() => { if (inflight.get(key) === promise) inflight.delete(key); });
      inflight.set(key, promise);
      return promise;
    },
    clear() { loaded.clear(); inflight.clear(); },
  };
}

/** The agent to use when `current` is not in the list any more. */
export function resolveAgent(current, agents) {
  const names = (agents || []).map((a) => a.name);
  if (current && names.includes(current)) return current;
  return names.includes('build') ? 'build' : (names[0] || 'build');
}

export function nextAgent(current, agents) {
  const names = (agents || []).map((a) => a.name);
  if (!names.length) return current || 'build';
  return names[(names.indexOf(current) + 1) % names.length];
}

/**
 * Which agents the toggle offers and whether the selected one may stay, for a
 * composer that moves between project directories.
 *
 * The agent list belongs to a directory. After a directory change the list on
 * hand is the previous project's until the new one arrives, so nothing is
 * validated in between: an agent that exists only in the new project (the one
 * a session of that project last ran with) would be thrown out by a list that
 * does not apply to it. An agent that was replaced by the fallback is
 * remembered and put back when the list of the directory the composer is in
 * turns out to offer it, unless the selection changed again meanwhile.
 */
export function createAgentChoice() {
  const keyOf = (cwd) => String(cwd || '');
  let listCwd = null;                 // directory `agents` came from; null while the built-ins show
  let agents = [...DEFAULT_AGENTS];
  let wanted = null;                  // { agent, fallback }: an agent the fallback replaced
  const offers = (name) => agents.some((a) => a.name === name);
  const loadedFor = (cwd) => listCwd !== null && listCwd === keyOf(cwd);
  return {
    agents: () => agents,
    /** True when the list on hand is the server's list for `cwd`. */
    isLoadedFor: loadedFor,
    /** The composer is in `cwd` now; `cached` is that directory's list when it is already known. */
    enter(cwd, cached) {
      if (Array.isArray(cached) && cached.length) { agents = cached; listCwd = keyOf(cwd); }
      else if (listCwd !== keyOf(cwd)) { agents = [...DEFAULT_AGENTS]; listCwd = null; }
    },
    /** The server's list for `cwd` arrived. False (ignored) when the composer is elsewhere or it is empty. */
    accept(cwd, list, currentCwd) {
      if (keyOf(cwd) !== keyOf(currentCwd) || !Array.isArray(list) || !list.length) return false;
      agents = list;
      listCwd = keyOf(cwd);
      return true;
    },
    /**
     * The agent the store should hold instead of `current`, or null to leave
     * it. Only the list of the directory the composer is in decides.
     */
    settle(current, currentCwd) {
      if (!loadedFor(currentCwd)) return null;
      if (wanted && current === wanted.fallback && offers(wanted.agent)) {
        const back = wanted.agent;
        wanted = null;
        return back === current ? null : back;
      }
      if (wanted && current !== wanted.fallback) wanted = null;     // the selection moved on
      const resolved = resolveAgent(current, agents);
      if (resolved === current) return null;
      wanted = { agent: current, fallback: resolved };
      return resolved;
    },
    /** The user picked an agent, or the composer moved to another session. */
    forget() { wanted = null; },
  };
}

/** The plan lifecycle (PLAN COMPLETE card, async turn) is keyed on the plan agent. */
export const modeForAgent = (agent) => (agent === 'plan' ? 'plan' : 'build');

export const agentLabel = (name) => String(name || '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ── Attachments ─────────────────────────────────────────────────────────────

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };

/** The mime to announce for a path sent as a file part. */
export function mimeForPath(path) {
  const value = String(path || '');
  if (/[\\/]$/.test(value)) return 'application/x-directory';
  const ext = (/\.([A-Za-z0-9]+)$/.exec(value)?.[1] || '').toLowerCase();
  if (IMAGE_EXT[ext]) return IMAGE_EXT[ext];
  if (ext === 'pdf') return 'application/pdf';
  // OpenCode reads a text/plain file:// part with its Read tool, which also
  // lists a directory given without a trailing slash.
  return 'text/plain';
}

const baseName = (path) => String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '');

export function fileUrlForPath(path) {
  const value = String(path || '').replace(/\\/g, '/');
  const absolute = value.startsWith('/') ? value : `/${value}`;
  return `file://${absolute.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/')}`;
}

export function joinPath(cwd, relative) {
  const rel = String(relative || '');
  if (/^([A-Za-z]:[\\/]|\/)/.test(rel) || !cwd) return rel;
  return `${String(cwd).replace(/[\\/]+$/, '')}/${rel}`;
}

/** Referenced paths as file parts (OpenCode inlines the content itself). */
export function pathFileParts(paths) {
  return (Array.isArray(paths) ? paths : []).filter(Boolean).map((path) => ({
    type: 'file',
    mime: mimeForPath(path),
    filename: baseName(path),
    url: fileUrlForPath(path),
  }));
}

/** Attachments from the strip ({ name, mime, dataUrl }) as file parts. */
export function imageFileParts(images) {
  return (Array.isArray(images) ? images : []).filter((img) => img && img.dataUrl).map((img) => ({
    type: 'file',
    mime: img.mime || 'image/png',
    filename: img.name || 'attachment',
    url: img.dataUrl,
  }));
}

/**
 * A mention's part for a command turn. The `source` stays: it is what tells
 * OpenCode how to read the part (an MCP resource is read through
 * `source.clientName` / `source.uri`; without it the URL is stored and never
 * read, seen on 1.18.34). Only the position goes: the command's template
 * rewrites the text, so where the mention stood in the typed line means
 * nothing in the prompt that is sent. The token itself (`value`) is kept.
 */
export function commandMentionPart(part) {
  if (!part?.source || typeof part.source !== 'object') return part;
  const value = typeof part.source.text?.value === 'string' ? part.source.text.value : '';
  return { ...part, source: { ...part.source, text: { value, start: 0, end: 0 } } };
}

/**
 * File parts of a slash-command turn: what is attached, the referenced paths
 * and the @ mentions, the same three sources a prompt sends.
 */
export function commandFileParts({ images = [], paths = [], mentions = [] } = {}) {
  const seen = new Set();
  return [
    ...imageFileParts(images),
    ...pathFileParts(paths),
    ...(Array.isArray(mentions) ? mentions : []).map(commandMentionPart),
  ].filter((part) => part && part.url && (seen.has(part.url) ? false : seen.add(part.url)));
}

/** image | pdf | text | other, from a File-like { type, name }. */
export function attachmentKind(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type.startsWith('text/') || /\.(txt|md|markdown|json|ya?ml|toml|csv|tsv|log|xml|html?|css|s?css|jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|sql|env|ini|conf)$/.test(name)
    || type === 'application/json') return 'text';
  return 'other';
}

/**
 * May this file go to this model?
 *   capabilities: Model.capabilities from the provider list, or null when unknown
 * An unknown model is given the benefit of the doubt for images (the provider
 * will answer); a known one that takes no images or PDFs is refused up front.
 */
export function attachmentVerdict(file, capabilities, { count = 0 } = {}) {
  if (count >= MAX_ATTACHMENTS) return { ok: false, reason: `At most ${MAX_ATTACHMENTS} attachments per message.` };
  if (Number(file?.size) > MAX_ATTACHMENT_BYTES) return { ok: false, reason: `${file.name || 'File'} is larger than 10 MB.` };
  const kind = attachmentKind(file);
  if (kind === 'other') return { ok: false, reason: `${file?.name || 'This file'} is not an image, a PDF or a text file.` };
  const input = capabilities?.input;
  if (kind === 'image' && input && input.image === false) return { ok: false, reason: 'The selected model does not take images.' };
  if (kind === 'pdf' && input && input.pdf === false) return { ok: false, reason: 'The selected model does not take PDFs.' };
  return { ok: true, kind };
}

/** Model.capabilities for `{ providerID, modelID }` out of the provider list. */
export function modelCapabilitiesOf(providers, model) {
  if (!model?.providerID || !model?.modelID) return null;
  const provider = (Array.isArray(providers) ? providers : []).find((p) => p?.id === model.providerID);
  const entry = provider?.models?.[model.modelID];
  return entry?.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : null;
}

// ── @ mentions ──────────────────────────────────────────────────────────────

/** The `@token` under the caret → { start, end, query }, else null. */
export function detectMentionToken(value, caret) {
  const text = String(value || '');
  const pos = Number.isInteger(caret) ? caret : text.length;
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  const token = text.slice(start, pos);
  if (!token.startsWith('@')) return null;
  // An e-mail address or a handle glued to a word is not a mention.
  if (token.slice(1).includes('@')) return null;
  return { start, end: pos, query: token.slice(1) };
}

/** Replace the token with `@path ` → { value, caret }. */
export function applyMention(value, token, path) {
  const text = String(value || '');
  const insert = `@${path} `;
  const next = text.slice(0, token.start) + insert + text.slice(token.end);
  return { value: next, caret: token.start + insert.length };
}

// What can be picked after `@`:
//   file       a project file or directory          (find.files)
//   symbol     a workspace symbol from the LSP      (find.symbols)
//   resource   a resource of a connected MCP server (experimental.resource.list)
//   reference  a reference from the OpenCode config (v2.reference.list)
// A pick inserts `@token ` and is remembered as an item; when the prompt is
// sent, every item whose token is still in the text becomes a file part with
// the matching FilePartSource (file / symbol / resource).

export const MENTION_GROUP_LIMIT = 12;
export const MENTION_GROUPS = Object.freeze([
  { id: 'file', label: 'Files' },
  { id: 'symbol', label: 'Symbols' },
  { id: 'resource', label: 'MCP resources' },
  { id: 'reference', label: 'References' },
]);

// A token is one word: it ends at the first whitespace when the text is read back.
const tokenWord = (value) => String(value || '').trim().replace(/\s+/g, '-');

/** `path` relative to `cwd` when it is inside it, else as given. */
export function relativeTo(cwd, path) {
  const base = String(cwd || '').replace(/[\\/]+$/, '');
  const value = String(path || '');
  return base && value.startsWith(`${base}/`) ? value.slice(base.length + 1) : value;
}

// An MCP resource as a picker item (also rebuilt from a sent prompt, see draftRestorePlan).
const resourceItem = (res) => ({
  kind: 'resource', token: `${tokenWord(res.client)}:${tokenWord(res.name || res.uri)}`, label: res.name || res.uri,
  detail: `${res.client} · ${res.uri}`, uri: res.uri, client: res.client, mimeType: res.mimeType || '',
});

const matchesQuery = (query, ...fields) => {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
};

/**
 * The picker's groups for `query`: `[{ id, label, items }]`, empty groups left
 * out. Files and symbols were searched by the server; resources and references
 * are whole lists, filtered here. Every item has `{ kind, token, label, detail }`
 * plus what its file part needs.
 */
export function mentionGroups({ query = '', cwd = '', files = [], symbols = [], resources = [], references = [] } = {}) {
  const items = {
    file: (Array.isArray(files) ? files : [])
      .filter((path) => typeof path === 'string' && path)
      .map((path) => ({ kind: 'file', token: path, label: path, detail: '', path })),
    symbol: (Array.isArray(symbols) ? symbols : [])
      .filter((sym) => sym && typeof sym.name === 'string' && sym.name && typeof sym.path === 'string' && sym.path)
      .map((sym) => {
        const rel = relativeTo(cwd, sym.path);
        const line = (Number(sym.range?.start?.line) || 0) + 1;
        return {
          kind: 'symbol', token: `${tokenWord(rel)}#${tokenWord(sym.name)}`, label: sym.name, detail: `${rel}:${line}`,
          path: sym.path, name: sym.name, symbolKind: Number(sym.kind) || 0,
          range: sym.range || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        };
      }),
    resource: (Array.isArray(resources) ? resources : [])
      .filter((res) => res && typeof res.uri === 'string' && res.uri && typeof res.client === 'string' && res.client)
      .filter((res) => matchesQuery(query, res.name, res.uri, res.client, res.description))
      .map(resourceItem),
    reference: (Array.isArray(references) ? references : [])
      .filter((ref) => ref && typeof ref.name === 'string' && ref.name && typeof ref.path === 'string' && ref.path)
      .filter((ref) => matchesQuery(query, ref.name, ref.description, ref.path))
      .map((ref) => ({
        kind: 'reference', token: `ref:${tokenWord(ref.name)}`, label: ref.name, detail: ref.description || ref.path, path: ref.path,
      })),
  };
  return MENTION_GROUPS
    .map((group) => {
      const seen = new Set();
      const unique = items[group.id].filter((item) => (seen.has(item.token) ? false : seen.add(item.token)));
      return { ...group, items: unique.slice(0, MENTION_GROUP_LIMIT) };
    })
    .filter((group) => group.items.length);
}

/** Where `@token` stands in the text as a word of its own, or -1. */
function mentionPosition(value, needle) {
  let from = 0;
  let at = -1;
  while ((at = value.indexOf(needle, from)) !== -1) {
    const before = at === 0 ? ' ' : value[at - 1];
    const after = value[at + needle.length] ?? ' ';
    if (/\s/.test(before) && /\s/.test(after)) return at;
    from = at + needle.length;
  }
  return -1;
}

/** The file part of one picked item; `text` is where its token stands in the prompt. */
export function mentionPart(item, text, cwd) {
  // A part that was sent before (put back by Undo) goes out as it was: same
  // URL (a symbol's line range is in it), same source; only where its token
  // stands in the text is read again.
  if (item.part) return { ...item.part, source: { ...item.part.source, text } };
  if (item.kind === 'symbol') {
    const start = Number(item.range?.start?.line) || 0;
    const end = Math.max(start, Number(item.range?.end?.line) || 0);
    return {
      type: 'file',
      mime: 'text/plain',
      filename: baseName(item.path),
      // OpenCode reads the lines `start`..`end` of the file for a ranged URL.
      url: `${fileUrlForPath(item.path)}?start=${start + 1}&end=${end + 1}`,
      source: { type: 'symbol', path: item.path, range: item.range, name: item.name, kind: item.symbolKind || 0, text },
    };
  }
  if (item.kind === 'resource') {
    return {
      type: 'file',
      mime: item.mimeType || 'text/plain',
      filename: item.label || item.uri,
      url: item.uri,
      source: { type: 'resource', clientName: item.client, uri: item.uri, text },
    };
  }
  // A file, a directory or a reference (a path OpenCode keeps for the project).
  const absolute = joinPath(cwd, item.path);
  return {
    type: 'file',
    mime: mimeForPath(item.path),
    filename: item.kind === 'reference' ? (item.label || baseName(item.path)) : baseName(item.path),
    url: fileUrlForPath(absolute),
    source: { type: 'file', path: absolute, text },
  };
}

/**
 * File parts for the mentions still present in the text. `picked` holds what
 * was chosen from the picker: a Map of token → item (see mentionGroups), or a
 * Set of file paths. An `@word` the user merely typed is text.
 */
export function mentionFileParts(text, picked, cwd) {
  const value = String(text || '');
  const parts = [];
  const seen = new Set();
  const entries = picked instanceof Map
    ? [...picked.entries()]
    : [...(picked || [])].map((path) => [path, { kind: 'file', token: path, path }]);
  for (const [token, item] of entries) {
    if (!token || !item || seen.has(token)) continue;
    const needle = `@${token}`;
    const at = mentionPosition(value, needle);
    if (at === -1) continue;
    seen.add(token);
    parts.push(mentionPart(item, { value: needle, start: at, end: at + needle.length }, cwd));
  }
  return parts;
}

// ── Putting a sent prompt back in the composer (Undo, "edit and resend") ────
// What a prompt carried besides its text comes back as what it was:
//   a pasted image / PDF / text file (data URL)   → the attachment strip
//   an @ mention (a file part with a `source`)    → a picked mention again: its
//       token is still in the text, so the next send rebuilds the very same
//       part, a symbol's line range and source included
//   an MCP resource mention                        → a picked mention, rebuilt
//       from the session's resource list: OpenCode stores a resource it read as
//       text ("Reading MCP resource: name (uri)"), not as a file part
//   a referenced path (file:// without a source)   → a path chip
// Anything that cannot be put back as what it was is named in `lost`, never
// turned into something else (a ranged part is not a whole-file path).

/** A sent file part as a picker item, when its source names the `@token` it was typed as. */
export function mentionItemOfPart(part) {
  const source = part?.source;
  const value = typeof source?.text?.value === 'string' ? source.text.value : '';
  if (!source || typeof source.type !== 'string' || typeof part.url !== 'string' || !part.url) return null;
  if (!value.startsWith('@') || value.length < 2 || /\s/.test(value)) return null;
  const token = value.slice(1);
  return {
    kind: source.type,
    token,
    label: source.name || part.filename || token,
    detail: '',
    part: { type: 'file', mime: part.mime || 'text/plain', filename: part.filename || baseName(source.path || token), url: part.url, source },
  };
}

// A file:// URL that names a whole file or directory → its path; '' for a
// ranged URL (`?start=…`) or anything that is not a file URL.
function plainFilePath(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return '';
  try {
    const parsed = new URL(url);
    return parsed.search || parsed.hash ? '' : decodeURIComponent(parsed.pathname);
  } catch { return ''; }
}

/**
 * Where each thing a prompt carried goes when the prompt is put back.
 *   text          the prompt's text (already in the composer)
 *   files         its file parts (replayablePrompt)
 *   resources     `{ name, uri }` of the MCP resources it read (replayablePrompt)
 *   resourceList  the session's resources now (resource:list); [] when unknown
 * → { attachments, paths, mentions, lost }
 */
export function draftRestorePlan({ text = '', files = [], resources = [], resourceList = [] } = {}) {
  const value = String(text || '');
  const plan = { attachments: [], paths: [], mentions: [], lost: [] };
  const inText = (token) => mentionPosition(value, `@${token}`) !== -1;
  const tokens = new Set();
  const addMention = (item) => { if (!tokens.has(item.token)) { tokens.add(item.token); plan.mentions.push(item); } };
  for (const file of Array.isArray(files) ? files : []) {
    const url = typeof file?.url === 'string' ? file.url : '';
    if (!url) continue;
    if (url.startsWith('data:')) {
      plan.attachments.push({ name: file.filename, mime: file.mime, dataUrl: url });
      continue;
    }
    const item = mentionItemOfPart(file);
    if (item && inText(item.token)) { addMention(item); continue; }
    const path = plainFilePath(url);
    if (path) plan.paths.push(path);
    else plan.lost.push(file.filename || url);
  }
  for (const ref of Array.isArray(resources) ? resources : []) {
    if (!ref || typeof ref.uri !== 'string' || !ref.uri) continue;
    const item = (Array.isArray(resourceList) ? resourceList : [])
      .filter((res) => res && res.uri === ref.uri && typeof res.client === 'string' && res.client)
      .map(resourceItem)
      .find((candidate) => inText(candidate.token));
    if (item) addMention(item);
    else plan.lost.push(`${ref.name || ref.uri} (MCP resource)`);
  }
  return plan;
}

/**
 * The file parts for the MCP resources a prompt read, to send it again
 * (Retry): rebuilt from the session's resource list, with the source OpenCode
 * needs to read them. `{ parts, lost }`.
 */
export function resourceReplayParts({ text = '', resources = [], resourceList = [] } = {}) {
  const plan = draftRestorePlan({ text, resources, resourceList });
  const picked = new Map(plan.mentions.map((item) => [item.token, item]));
  return { parts: mentionFileParts(text, picked, ''), lost: plan.lost };
}

/**
 * A cache with a lifetime, by key: the resource and reference lists are asked
 * once per session and directory, then reused while the picker is typed in.
 */
export function createKeyedCache(load, { ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map();   // key → { at, promise }
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.promise;
      const promise = Promise.resolve().then(() => load(key)).catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
        return [];
      });
      entries.set(key, { at: now(), promise });
      return promise;
    },
    clear() { entries.clear(); },
  };
}
