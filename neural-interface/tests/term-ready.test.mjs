// Run with: node --test tests/term-ready.test.mjs
// When a fresh terminal can take a typed command (the Command Runner's wait),
// and that a command is never typed with a hole in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READY_LIMITS, createReadyWatch, inputChunks, readinessKind, readySignal, stripEscapes, typeInto, typeWhenReady,
} from '../public/shared/term-ready.js';

// What the old matcher in ui-terminal.js accepted, for the regression cases.
const OLD_ANSI = /\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;
const OLD_PATTERNS = [/^>\s*$/m, /\n>\s*$/, />\s*$/, /\u276F/, /\$ $/];
const oldMatcher = (raw) => OLD_PATTERNS.some(p => p.test(raw.replace(OLD_ANSI, '')));

// What a default macOS login zsh prints (PROMPT_EOL_MARK, then the prompt,
// then bracketed paste on), captured from `/bin/zsh -l` in a PTY.
const ZSH_FIRST = '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m' + ' '.repeat(119) + '\r \r';
const ZSH_PROMPT = '\r\x1b[0m\x1b[27m\x1b[24m\x1b[Juser@host ~ % \x1b[K';
const ZSH_PASTE = '\x1b[?2004h';

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    set(fn, ms) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clear(id) { pending.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    get size() { return pending.size; },
  };
}

function watchFor(kind, extra = {}) {
  const timers = fakeTimers();
  const reasons = [];
  const watch = createReadyWatch({ kind, timers, onReady: r => reasons.push(r), ...extra });
  return { watch, timers, reasons };
}

test('only the shell profile gets the shell reading', () => {
  assert.equal(readinessKind('shell'), 'shell');
  for (const profile of ['claude-code', 'codex', 'gemini', 'opencode', undefined]) {
    assert.equal(readinessKind(profile), 'cli');
  }
});

test('a default macOS zsh prompt is ready the moment it is drawn', () => {
  const raw = ZSH_FIRST + ZSH_PROMPT + ZSH_PASTE;
  assert.equal(oldMatcher(raw), false, 'the old matcher never saw this prompt: the 15 s wait');
  assert.equal(readySignal(raw, 'shell'), 'line-editor');
  assert.equal(readySignal(ZSH_FIRST + ZSH_PROMPT, 'shell'), 'prompt', 'the "% " alone is enough');
  assert.equal(readySignal(ZSH_FIRST, 'shell'), null, 'the end-of-line mark is not a prompt');
});

test('prompts by shell', () => {
  const ready = {
    'bash 3.2': 'bash-3.2$ ',
    'bash 5 (paste on before the prompt)': '\x1b[?2004hbash-5.2$ ',
    'root': 'root@box:/# ',
    'cmd.exe': 'Microsoft Windows [Version 10.0]\r\n\r\nC:\\Users\\me>\x1b]0;cmd\x07\x1b[?25h',
    'PowerShell': 'PS C:\\Users\\me> ',
    'fish': '\x1b]133;A\x07me@box ~> \x1b[K',
    'starship': '\r\n\x1b[1;32m\u276F\x1b[0m ',
    'shell integration mark': 'me in ~/code \x1b]133;B\x07',
    'OSC title ended by ST': '\x1b]0;me@box\x1b\\me@box % ',
  };
  for (const [name, raw] of Object.entries(ready)) {
    assert.ok(readySignal(raw, 'shell'), `${name} is ready`);
  }
  const notReady = {
    'nothing yet': '',
    'a login banner': 'Last login: Mon Oct  5 10:00:00 on ttys003\r\n',
    'a prompt no pattern knows': 'ready: ',
    'a command is running (paste off again)': 'me % \x1b[?2004h\x1b[?2004lnpm run dev\r\n\r\n',
    'a running command after the mark': 'me in ~ \x1b]133;B\x07npm start\x1b]133;C\x07\r\nlistening\r\n',
  };
  for (const [name, raw] of Object.entries(notReady)) {
    assert.equal(readySignal(raw, 'shell'), null, name);
  }
});

test('a reconnect snapshot trims the trailing space and is still read', () => {
  // snapshot.js: translateToString(true) drops trailing whitespace per line.
  for (const plain of ['user@host ~ %', 'bash-3.2$', 'Last login: today\nme@box:~#', 'C:\\Users\\me>']) {
    assert.equal(readySignal(plain, 'shell'), 'prompt', JSON.stringify(plain));
  }
  assert.equal(oldMatcher('bash-3.2$'), false, 'the old matcher needed the space the snapshot removes');
});

test('the CLI reading is the one the loops always had', () => {
  const samples = ['\n> ', '\x1b[2m>\x1b[0m ', '\u276F', 'me$ ', 'booting…\r\n', 'user@host ~ % ', 'ready: ', ''];
  for (const raw of samples) {
    assert.equal(readySignal(raw, 'cli') !== null, oldMatcher(raw), JSON.stringify(raw));
  }
  assert.equal(READY_LIMITS.cli.capMs, 15000);
  assert.equal(READY_LIMITS.cli.settleMs, 500);
  assert.equal(READY_LIMITS.cli.quietMs, 0, 'a CLI is never taken on silence');
});

test('stripEscapes removes colours, titles and mode switches', () => {
  assert.equal(stripEscapes('\x1b[1;32mok\x1b[0m\x1b]0;t\x07\x1b[?2004h\x1b=\x1b(B!'), 'ok!');
});

test('watch: fires once, on the first signal', () => {
  const { watch, timers, reasons } = watchFor('shell');
  watch.start(); watch.opened();
  watch.output(ZSH_FIRST);
  assert.deepEqual(reasons, []);
  watch.output(ZSH_PROMPT + ZSH_PASTE);
  assert.deepEqual(reasons, ['line-editor']);
  watch.output('more');
  timers.advance(60000);
  assert.deepEqual(reasons, ['line-editor'], 'never twice');
  assert.equal(timers.size, 0, 'no timer left behind');
});

test('watch: output that arrived before the watch existed counts, once the socket is open', () => {
  const { watch, reasons } = watchFor('shell');
  watch.output('bash-3.2$ '); // what was in the replay buffer
  watch.start();
  assert.deepEqual(reasons, [], 'nothing is decided without an open socket');
  watch.opened();
  assert.deepEqual(reasons, ['prompt']);
});

// ── The readiness window starts when the socket opens ──

test('watch: a CLI gets its full 15 s after a socket that opened late', () => {
  // The regression: the cap ran from the call, so a socket that opened at 2 s
  // left the CLI 13 s. A prompt at 16 s was then missed and the message typed
  // into a CLI that was not up yet.
  const { watch, timers, reasons } = watchFor('cli');
  watch.start();
  timers.advance(2000);
  watch.opened();
  timers.advance(13000); // 15 s after the call: where the cap used to fire
  assert.deepEqual(reasons, [], 'not a timeout yet: only 13 s of the window have passed');
  timers.advance(1000); // 16 s after the call
  watch.output('\r\n> ');
  assert.deepEqual(reasons, ['prompt']);
});

test('watch: with no prompt, the CLI fallback is 15 s after the socket opened', () => {
  const { watch, timers, reasons } = watchFor('cli');
  watch.start();
  timers.advance(2000);
  watch.opened();
  watch.output('starting…\r\n');
  timers.advance(READY_LIMITS.cli.capMs - 1);
  assert.deepEqual(reasons, []);
  timers.advance(1);
  assert.deepEqual(reasons, ['timeout']);
});

test('watch: a socket that never opens ends the wait instead of hanging it', () => {
  for (const kind of ['cli', 'shell']) {
    const { watch, timers, reasons } = watchFor(kind);
    watch.start();
    watch.output('me$ \n> '); // even a prompt from before does not count without a socket
    const limit = READY_LIMITS[kind].capMs + READY_LIMITS[kind].openGraceMs;
    timers.advance(limit - 1);
    assert.deepEqual(reasons, [], kind);
    timers.advance(1);
    assert.deepEqual(reasons, ['timeout'], kind);
    assert.equal(timers.size, 0);
  }
  assert.equal(READY_LIMITS.cli.capMs + READY_LIMITS.cli.openGraceMs, 17000, 'the old safety net, to the millisecond');
});

test('watch: before the socket is open a shell is not judged either, and a reconnect does not restart the window', () => {
  let pasteMode = true;
  const { watch, timers, reasons } = watchFor('shell', { lineEditorActive: () => pasteMode });
  watch.start();
  watch.output('Welcome\r\n');
  watch.poke();
  timers.advance(READY_LIMITS.shell.quietMs * 3);
  assert.deepEqual(reasons, [], 'no quiet rule, no parser state, no prompt before opened()');
  pasteMode = false;
  watch.opened();
  timers.advance(READY_LIMITS.shell.quietMs - 1);
  watch.opened(); // the socket reconnected
  timers.advance(1);
  assert.deepEqual(reasons, ['quiet'], 'the first open started the clock');
});

test('watch: a prompt nothing recognises is taken once the output goes quiet', () => {
  const { watch, timers, reasons } = watchFor('shell');
  watch.start(); watch.opened();
  timers.advance(1000);
  assert.deepEqual(reasons, [], 'silence before any output is not readiness');
  watch.output('Welcome\r\n');
  timers.advance(READY_LIMITS.shell.quietMs - 1);
  watch.output('ready: ');
  timers.advance(READY_LIMITS.shell.quietMs - 1);
  assert.deepEqual(reasons, [], 'each chunk restarts the quiet window');
  timers.advance(1);
  assert.deepEqual(reasons, ['quiet']);
});

test('watch: escape codes alone are not a sign of life', () => {
  // The connect snapshot of a shell that has printed nothing yet is cursor and
  // mode codes; a slow profile must not be typed into 350 ms after that.
  const { watch, timers, reasons } = watchFor('shell');
  watch.start(); watch.opened();
  watch.replace('\x1b[?25h\x1b[0m\x1b]0;zsh\x07');
  watch.output('\x1b[c\x1b]11;?\x07'); // terminal queries a shell sends while starting
  timers.advance(READY_LIMITS.shell.quietMs * 4);
  assert.deepEqual(reasons, []);
  watch.output('loading plugins\r\n');
  timers.advance(READY_LIMITS.shell.quietMs);
  assert.deepEqual(reasons, ['quiet']);
});

test('watch: a shell that prints nothing is typed into after the cap, not after 15 s', () => {
  const { watch, timers, reasons } = watchFor('shell');
  watch.start(); watch.opened();
  timers.advance(READY_LIMITS.shell.capMs - 1);
  assert.deepEqual(reasons, []);
  timers.advance(1);
  assert.deepEqual(reasons, ['timeout']);
  assert.ok(READY_LIMITS.shell.capMs <= 5000);
});

test('watch: a CLI waits for its prompt and never takes silence for it', () => {
  const { watch, timers, reasons } = watchFor('cli');
  watch.start(); watch.opened();
  watch.output('user@host ~ % claude\r\n');
  timers.advance(14999);
  assert.deepEqual(reasons, [], 'the shell prompt under a CLI is not the CLI');
  watch.output('\r\n> ');
  assert.deepEqual(reasons, ['prompt']);
});

test('watch: a CLI that never shows a prompt still gets its message at 15 s', () => {
  const { watch, timers, reasons } = watchFor('cli');
  watch.start(); watch.opened();
  watch.output('loading\r\n');
  timers.advance(15000);
  assert.deepEqual(reasons, ['timeout']);
});

test('watch: a snapshot replaces what was read, and the parser state decides', () => {
  let pasteMode = false;
  const { watch, timers, reasons } = watchFor('shell', { lineEditorActive: () => pasteMode });
  watch.start(); watch.opened();
  watch.output('half a prompt');
  watch.replace('motd line\nstill starting'); // reconnect: the screen as plain text
  assert.deepEqual(reasons, []);
  pasteMode = true; // the snapshot's escape data turned bracketed paste on
  watch.poke();
  assert.deepEqual(reasons, ['line-editor']);
  timers.advance(60000);
  assert.deepEqual(reasons, ['line-editor']);
});

test('watch: the parser state is ignored for a CLI, and cancel is final', () => {
  const cli = watchFor('cli', { lineEditorActive: () => true });
  cli.watch.start(); cli.watch.opened();
  cli.watch.poke();
  cli.watch.output('zsh is up\r\n');
  assert.deepEqual(cli.reasons, [], 'the shell under the CLI being ready says nothing about the CLI');

  const shell = watchFor('shell');
  shell.watch.start(); shell.watch.opened();
  shell.watch.output('x');
  shell.watch.cancel();
  shell.timers.advance(60000);
  shell.watch.output('me$ ');
  assert.deepEqual(shell.reasons, []);
  assert.equal(shell.timers.size, 0);
});

// ── Typing ──

function fakeSocket(readyState = 1) {
  const sent = [];
  return { readyState, sent, send(raw) { sent.push(JSON.parse(raw).data); } };
}
const noSleep = () => Promise.resolve();

test('typing: the command arrives whole, in order, in 256-character writes', async () => {
  const ws = fakeSocket();
  const text = `echo '${'x'.repeat(600)}' "$HOME" \\ \`date\`\r`;
  const result = await typeInto({ socket: () => ws, text, sleep: noSleep });
  assert.deepEqual(result, { ok: true, sent: 3, chunks: 3 });
  assert.equal(ws.sent.join(''), text, 'byte for byte what was saved');
  assert.ok(ws.sent.every(c => c.length <= 256));
  assert.deepEqual(inputChunks('abc', 2), ['ab', 'c']);
});

test('typing: waits for the socket instead of dropping the command', async () => {
  // The old code checked once, 500 ms after the prompt, and returned in silence.
  const first = fakeSocket(0);
  const second = fakeSocket(1);
  let current = first;
  let polls = 0;
  const sleep = async () => { if (++polls === 3) current = second; }; // a reconnect swaps the socket
  const result = await typeInto({ socket: () => current, text: 'npm run dev\r', sleep });
  assert.equal(result.ok, true);
  assert.deepEqual(first.sent, []);
  assert.deepEqual(second.sent, ['npm run dev\r']);
});

test('typing: a socket that drops mid-command ends it there — no Enter after a hole', async () => {
  const ws = fakeSocket();
  let sleeps = 0;
  const sleep = async () => { if (++sleeps === 1) ws.readyState = 3; };
  const text = 'rm -rf ./build/' + 'a'.repeat(300) + ' && echo done\r';
  const result = await typeInto({ socket: () => ws, text, sleep });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'closed');
  assert.equal(result.sent, 1);
  assert.equal(ws.sent.length, 1, 'nothing after the gap');
  assert.ok(!ws.sent.join('').includes('\r'), 'the truncated command is never submitted');
});

test('typing: gives up when no socket opens, or the terminal is gone', async () => {
  let t = 0;
  const closed = fakeSocket(3);
  const never = await typeInto({ socket: () => closed, text: 'ls\r', sleep: async (ms) => { t += ms; }, now: () => t, openWaitMs: 1000 });
  assert.deepEqual(never, { ok: false, sent: 0, chunks: 1, reason: 'no-socket' });
  assert.ok(t >= 1000, 'it waited the whole window first');

  const ws = fakeSocket();
  const gone = await typeInto({ socket: () => ws, alive: () => false, text: 'ls\r', sleep: noSleep });
  assert.equal(gone.ok, false);
  assert.deepEqual(ws.sent, []);
});

// ── The whole hand-over, on a test clock ──

const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

function testClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    timers: {
      set(fn, ms) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
      clear(id) { pending.delete(id); },
    },
    /** Move to absolute time `t`, running what falls due and letting promises settle. */
    async to(t) {
      for (;;) {
        const due = [...pending.entries()].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = t;
      await settle();
    },
    get size() { return pending.size; },
  };
}

/** A terminal session as _sendOnceReady sees it: a socket, and the three things it subscribes to. */
function handOver({ kind, text = 'hello\r', readyState = 0, extra = {} } = {}) {
  const clock = testClock();
  const sent = []; // [time, data]
  const socket = { readyState, send(raw) { sent.push([clock.now(), JSON.parse(raw).data]); } };
  const session = { socket, handlers: null, unsubscribed: 0, ready: [] };
  const result = typeWhenReady({
    kind,
    text,
    socket: () => session.socket,
    subscribe: (handlers) => { session.handlers = handlers; return () => { session.unsubscribed++; }; },
    onReady: (reason, waitedMs) => session.ready.push([reason, waitedMs]),
    timers: clock.timers,
    now: clock.now,
    ...extra,
  });
  const open = (ws = session.socket) => { session.socket = ws; ws.readyState = 1; session.handlers.opened(); };
  const newSocket = () => ({ readyState: 0, send(raw) { sent.push([clock.now(), JSON.parse(raw).data]); } });
  return { clock, sent, session, result, open, newSocket };
}

test('hand-over: socket opens at 2 s, CLI prompt at 16 s — typed at 16.5 s, not at 15.5 s', async () => {
  const { clock, sent, session, result, open } = handOver({ kind: 'cli' });
  await clock.to(2000);
  open();
  await clock.to(15500);
  assert.deepEqual(sent, [], 'the regression typed here: 15 s cap from the call + 500 ms settle, before the CLI was up');
  await clock.to(16000);
  session.handlers.output('\r\n> ');
  await clock.to(16499);
  assert.deepEqual(sent, [], 'the CLI settles for 500 ms first');
  await clock.to(16500);
  assert.deepEqual(sent, [[16500, 'hello\r']], 'what the code before the rewrite did');
  assert.deepEqual(await result, { ok: true, reason: 'prompt', waitedMs: 16000 });
  assert.equal(session.unsubscribed, 1);
  assert.equal(clock.size, 0, 'no timer left behind');
});

test('hand-over: a CLI that never shows a prompt is typed into 15.5 s after its socket opened', async () => {
  const { clock, sent, result, open } = handOver({ kind: 'cli' });
  await clock.to(2000);
  open();
  await clock.to(17499);
  assert.deepEqual(sent, []);
  await clock.to(17500);
  assert.deepEqual(sent, [[17500, 'hello\r']]);
  assert.equal((await result).reason, 'timeout');
});

test('hand-over: a socket that is already open starts the window at the call', async () => {
  const { clock, sent, session, result } = handOver({ kind: 'cli', readyState: 1 });
  await clock.to(3000);
  session.handlers.output('> ');
  await clock.to(3500);
  assert.deepEqual(sent, [[3500, 'hello\r']]);
  assert.deepEqual(await result, { ok: true, reason: 'prompt', waitedMs: 3000 });
});

test('hand-over: the shell stays fast — typed 40 ms after its prompt', async () => {
  const { clock, sent, session, result, open } = handOver({ kind: 'shell', text: 'npm run dev\r' });
  await clock.to(12);
  open();
  session.handlers.output('', true); // the connect snapshot of a shell that has printed nothing
  await clock.to(80);
  session.handlers.output(ZSH_FIRST + ZSH_PROMPT + ZSH_PASTE);
  await clock.to(80 + READY_LIMITS.shell.settleMs);
  assert.deepEqual(sent, [[120, 'npm run dev\r']]);
  assert.deepEqual(await result, { ok: true, reason: 'line-editor', waitedMs: 80 });
});

test('hand-over: a first socket that dies is followed to the one that opens', async () => {
  const { clock, sent, session, result, open, newSocket } = handOver({ kind: 'shell', text: 'ls\r' });
  const dead = session.socket;
  await clock.to(30);
  dead.readyState = 3; // closed before it ever opened
  const second = newSocket();
  session.socket = second;
  await clock.to(2030);
  open(second);
  session.handlers.output('host%', true); // the reconnect snapshot: prompt already drawn, space trimmed
  await clock.to(2030 + READY_LIMITS.shell.settleMs);
  assert.deepEqual(sent, [[2070, 'ls\r']]);
  assert.equal((await result).ok, true);
});

test('hand-over: buffered output is read when the socket opens, never before', async () => {
  const { clock, sent, result, open } = handOver({ kind: 'cli', extra: { buffered: 'Claude Code\r\n> ' } });
  await clock.to(5000);
  assert.deepEqual(sent, [], 'a prompt in the replay buffer does not type into a closed socket');
  open();
  await clock.to(5500);
  assert.deepEqual(sent, [[5500, 'hello\r']]);
  assert.equal((await result).reason, 'prompt');
});

test('hand-over: no socket ever — the wait ends and says the message was not delivered', async () => {
  const { clock, sent, session, result } = handOver({ kind: 'cli' });
  await clock.to(17000); // capMs + openGraceMs: the watch gives up waiting for a socket
  assert.deepEqual(session.ready, [['timeout', 17000]]);
  await clock.to(17000 + 500 + 10000 + 100); // settle, then typeInto's own wait for a socket
  assert.deepEqual(sent, []);
  assert.deepEqual(await result, { ok: false, reason: 'no-socket', sent: 0, chunks: 1 });
  assert.equal(session.unsubscribed, 1);
});

test('hand-over: the shell parser state is asked only for a shell', async () => {
  let asked = 0;
  const lineEditorActive = () => { asked++; return true; };
  const cli = handOver({ kind: 'cli', readyState: 1, extra: { lineEditorActive } });
  cli.session.handlers.parsed();
  cli.session.handlers.output('zsh under the CLI\r\n');
  await cli.clock.to(1000);
  assert.equal(asked, 0);
  assert.deepEqual(cli.sent, []);

  const shell = handOver({ kind: 'shell', readyState: 1, extra: { lineEditorActive } });
  await shell.clock.to(READY_LIMITS.shell.settleMs);
  assert.equal(shell.sent.length, 1, 'bracketed paste already on: ready at once');
  assert.equal((await shell.result).reason, 'line-editor');
});

// ── How ui-terminal.js uses it ──

test('ui-terminal starts the window from the socket, through the session', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../public/shared/ui-terminal.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function _sendOnceReady('), source.indexOf('/** Snapshot terminal state for workspace save */'));
  assert.match(fn, /return typeWhenReady\(\{/);
  assert.match(fn, /\(session\._openWatchers \|\|= new Set\(\)\)\.add\(opened\)/);
  assert.match(fn, /session\._openWatchers\?\.delete\(opened\)/);
  assert.doesNotMatch(fn, /\.start\(\)|capMs|15000/, 'no timer of its own: the rules live in term-ready.js');
  // Every socket open of a session — first connect and reconnects — goes through here.
  const onOpen = source.slice(source.indexOf('function _onTermWsOpen('), source.indexOf('/** A terminal just became visible'));
  assert.match(onOpen, /send\(\{ type: 'hello', flow: 1 \}\);[\s\S]*?_notifySocketOpen\(s\);[\s\S]*?const term = s\?\.term;/, 'told before any early return');
  assert.equal(source.split('_onTermWsOpen(').length - 1, 4, 'openSession, reconnectSession, _reconnectTerminalWs + the definition');
});
