import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, HELP_TEXT, SETTINGS_REFUSAL, parseCommand, statusText } from '../lib/whatsapp/commands.js';

process.env.SYNABUN_TYPESAFE = 'off';

const msg = (text, extra = {}) => ({ id: 'm1', ts: Date.now(), chat: 'self', text, images: [], unsupported: null, forwarded: false, quoted: null, owner: true, ...extra });

test('commands: the owner\'s own text, case-insensitive, exact name at the start', () => {
  assert.deepEqual([...COMMANDS], ['help', 'status', 'stop', 'new', 'pause', 'resume', 'cards']);
  for (const name of COMMANDS) assert.deepEqual(parseCommand(msg(`/${name}`)), { kind: 'command', name, args: '' });
  assert.deepEqual(parseCommand(msg('  /STOP ')), { kind: 'command', name: 'stop', args: '' });
  assert.deepEqual(parseCommand(msg('/new please')), { kind: 'command', name: 'new', args: 'please' });
  assert.equal(parseCommand(msg('/stopper')), null, 'another word: a prompt');
  assert.equal(parseCommand(msg('/synabun search hooks')), null, 'other /x pass through as prompts');
  assert.equal(parseCommand(msg('please /stop')), null);
  assert.equal(parseCommand(msg('/stop', { forwarded: true })), null, 'a forwarded /stop is a prompt');
  assert.equal(parseCommand(msg('/stop', { quoted: { id: 'x', text: 'y', fromBot: true } })), null, 'a quoted message is a prompt');
  assert.equal(parseCommand(msg('/stop', { owner: false })), null);
  assert.deepEqual(parseCommand(msg('//new idea')), { kind: 'literal', text: '/new idea' }, '//x sends the literal /x');
});

test('no command raises the level or changes a setting (fixed refusal)', () => {
  for (const name of ['level', 'autonomous', 'allow', 'bypass', 'settings', 'config', 'permissions', 'model', 'login', 'add-dir', 'mcp', 'computer']) {
    assert.deepEqual(parseCommand(msg(`/${name} anything`)), { kind: 'refused', name }, name);
  }
  assert.match(SETTINGS_REFUSAL, /only in SynaBun on your computer/);
  assert.match(SETTINGS_REFUSAL, /Nothing was changed/);
  for (const name of COMMANDS) assert.ok(HELP_TEXT.includes(`/${name}`), `help lists /${name}`);
});

test('status text: session, brain, work, queue, cards, spend, level, pause', () => {
  const text = statusText({
    connected: true, sessionId: 'assistant-1', title: 'WhatsApp · Sep 28', brain: { provider: 'claude-code', model: 'claude-sonnet-5' },
    running: true, turnKind: 'wa', queued: 2, pendingCards: 1, currentCard: 'permission',
    budget: { totalUsd: 1.234, hardUsd: 25 }, brainUsd: 0.5, brainCapUsd: 10, level: 'ask', paused: false,
  });
  assert.match(text, /WhatsApp: connected/);
  assert.match(text, /Conversation: WhatsApp · Sep 28 \(claude-code \/ claude-sonnet-5\)/);
  assert.match(text, /Now: working on your message · 2 messages queued/);
  assert.match(text, /Waiting for you: 1 question or approval \(permission\)/);
  assert.match(text, /Spend: \$1\.23 of \$25\.00 session cap \(brain \$0\.50 of \$10\.00\)/);
  assert.match(text, /Level: Ask on my phone/);
  const idle = statusText({ connected: false, sessionId: null, running: false, level: 'read-only', paused: true, pausedBy: 'desktop' });
  assert.match(idle, /reconnecting/);
  assert.match(idle, /none yet/);
  assert.match(idle, /Now: idle/);
  assert.match(idle, /Level: Read-only/);
  assert.match(idle, /Paused from your computer — resume it in SynaBun/);
  assert.match(statusText({ running: true, turnKind: 'external', level: 'autonomous', autonomousUntil: Date.now() + 3600_000 }), /request from your computer[\s\S]*Autonomous until \d\d:\d\d/);
});
