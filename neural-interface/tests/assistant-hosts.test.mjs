// The Assistant's two hosts (terminal tab + sidepanel) share one core:
// server create/resume, "one session lives in one host", the last-used
// session and the guest gate. Pure module, fake adapters and API.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSISTANT_CLOSED_STATUSES,
  createAssistantHosts,
  describeBrainFallback,
  isAssistantSessionLive,
  isAssistantSessionRestorable,
} from '../public/shared/assistant/asst-hosts.js';
import { DEFAULT_BRAIN, readStoredBrain } from '../public/shared/assistant/asst-state.js';
import { KEYS } from '../public/shared/constants.js';

function fakeHost(id) {
  const open = [];
  const calls = [];
  return {
    id,
    calls,
    open,
    has: (sid) => open.includes(sid),
    sessions: () => [...open],
    focus: (sid, opts) => calls.push(['focus', sid, opts?.prompt || '']),
    mount: (opts) => { open.push(opts.sessionId); calls.push(['mount', opts]); },
    close: (sid, opts) => {
      const i = open.indexOf(sid);
      if (i >= 0) open.splice(i, 1);
      calls.push(['close', sid, opts]);
    },
    toggle: (sid) => calls.push(['toggle', sid]),
  };
}

// createAs(brain) → extra session fields, as the server answers (e.g. a replaced brain + fallback).
function fakeApi({ sessions = {}, onGet = null, failCreate = null, createAs = null } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    list: async () => { calls.push(['list']); return Object.values(sessions); },
    get: async (id) => {
      calls.push(['get', id]);
      await onGet?.(id);
      if (!sessions[id]) throw new Error('not found');
      return { session: sessions[id] };
    },
    create: async ({ brain, label, fallback }) => {
      calls.push(['create', brain, label, fallback]);
      if (failCreate) throw new Error(failCreate);
      const id = `assistant-new-${++n}`;
      const session = { id, brain, status: 'idle', ...(createAs?.(brain) || {}) };
      sessions[id] = session;
      return { session: { ...session } };
    },
  };
}

function setup({ sessions, onGet, failCreate, createAs, blocked = false, storedBrain = () => null } = {}) {
  const api = fakeApi({ sessions, onGet, failCreate, createAs });
  const toasts = [];
  const hosts = createAssistantHosts({
    api,
    isBlocked: () => blocked,
    toast: (text) => toasts.push(text),
    storedBrain,
    defaultHost: 'terminal',
  });
  const terminal = fakeHost('terminal');
  const sidepanel = fakeHost('sidepanel');
  const offTerminal = hosts.register(terminal);
  const offSidepanel = hosts.register(sidepanel);
  return { api, toasts, hosts, terminal, sidepanel, offTerminal, offSidepanel };
}

const mounts = (host) => host.calls.filter(c => c[0] === 'mount').map(c => c[1]);
const focuses = (host) => host.calls.filter(c => c[0] === 'focus');

test('isAssistantSessionLive: closed statuses and end markers are not live', () => {
  assert.equal(isAssistantSessionLive({ id: 'a', status: 'idle' }), true);
  assert.equal(isAssistantSessionLive({ id: 'a', status: 'running' }), true);
  for (const status of ASSISTANT_CLOSED_STATUSES) {
    assert.equal(isAssistantSessionLive({ id: 'a', status }), false, status);
    assert.equal(isAssistantSessionLive({ id: 'a', status: status.toUpperCase() }), false, status);
  }
  assert.equal(isAssistantSessionLive({ id: 'a', status: 'idle', endedAt: '2026-09-25' }), false);
  assert.equal(isAssistantSessionLive({ id: 'a', closedAt: 1 }), false);
  assert.equal(isAssistantSessionLive(null), false);
  assert.equal(isAssistantSessionLive('assistant-1'), false);
});

test('open: creates a session on the server and mounts it in the requested host', async () => {
  const { api, hosts, terminal, sidepanel } = setup();
  const res = await hosts.open({ host: 'sidepanel', brain: { provider: 'codex' }, label: 'Docs', prompt: 'hi' });
  assert.equal(res.host, 'sidepanel');
  assert.equal(res.mounted, true);
  assert.deepEqual(api.calls.map(c => c[0]), ['create']);
  assert.equal(api.calls[0][1].provider, 'codex');
  assert.equal(api.calls[0][2], 'Docs');
  const [m] = mounts(sidepanel);
  assert.equal(m.sessionId, res.sessionId);
  assert.equal(m.prompt, 'hi');
  assert.equal(m.label, 'Docs');
  assert.equal(m.reattach, false);
  assert.equal(m.meta.id, res.sessionId);
  assert.equal(mounts(terminal).length, 0);
  assert.deepEqual(hosts.lastUsed(), { hostId: 'sidepanel', sessionId: res.sessionId });
  assert.equal(hosts.ownerOf(res.sessionId), 'sidepanel');
});

test('open: an unknown or unregistered host falls back to the default host', async () => {
  const { hosts, terminal, offSidepanel } = setup();
  offSidepanel();
  const res = await hosts.open({ host: 'sidepanel' });
  assert.equal(res.host, 'terminal');
  assert.equal(mounts(terminal).length, 1);
  const again = await hosts.open({ host: 'nowhere' });
  assert.equal(again.host, 'terminal');
});

test('open: no brain → the stored brain (normalized) is used for the new session', async () => {
  const { api, hosts } = setup({ storedBrain: () => ({ provider: 'opencode', agent: 'build' }) });
  await hosts.open({ host: 'terminal' });
  const brain = api.calls[0][1];
  assert.equal(brain.provider, 'opencode');
  assert.equal(brain.agent, 'build');
  assert.ok('permissionMode' in brain, 'normalized brain shape');
});

test('open: a stored model disabled since starts on the server stand-in — the host says so and the tab takes the server brain', async () => {
  const fallback = { reason: 'model', from: 'gpt-6-astra', fromProvider: 'codex', to: 'gpt-6-astra[extended]', provider: 'codex', label: 'GPT-6-Astra (extended)' };
  const { api, hosts, toasts, sidepanel } = setup({
    storedBrain: () => ({ provider: 'codex', model: 'gpt-6-astra' }),
    createAs: (brain) => (brain.model === 'gpt-6-astra' ? { brain: { ...brain, model: 'gpt-6-astra[extended]' }, fallback } : {}),
  });
  const res = await hosts.open({ host: 'sidepanel' });
  assert.equal(res.mounted, true, 'no dead end');
  assert.equal(api.calls[0][3], true, 'every start lets the server fall back');
  assert.deepEqual(toasts, ["gpt-6-astra is disabled in the Assistant's Models list — started on GPT-6-Astra (extended)."]);
  assert.equal(mounts(sidepanel)[0].brain.model, 'gpt-6-astra[extended]');
  // An explicit brain (New session from a tab) is replaced the same way.
  await hosts.open({ host: 'sidepanel', brain: { provider: 'codex', model: 'gpt-6-astra' } });
  assert.equal(mounts(sidepanel)[1].brain.model, 'gpt-6-astra[extended]');
  // No replacement: the requested brain mounts as before, with no note.
  await hosts.open({ host: 'sidepanel', brain: { provider: 'codex', model: 'gpt-5.6-luna' } });
  assert.equal(mounts(sidepanel)[2].brain.model, 'gpt-5.6-luna');
  assert.equal(toasts.length, 2);
  assert.equal(
    describeBrainFallback({ reason: 'provider', from: 'codex', fromProvider: 'codex', to: 'default', provider: 'claude-code', label: 'Default (recommended)' }),
    "Every codex model is disabled in the Assistant's Models list — started on Default (recommended).",
  );
});

test('resume: a session another host owns is focused there — no server call, no mount', async () => {
  const { api, hosts, terminal, sidepanel } = setup({ sessions: { 'assistant-a': { id: 'assistant-a', status: 'idle' } } });
  terminal.open.push('assistant-a');
  const res = await hosts.open({ host: 'sidepanel', resume: 'assistant-a', prompt: 'continue' });
  assert.deepEqual(res, { host: 'terminal', sessionId: 'assistant-a', focused: true });
  assert.equal(api.calls.length, 0);
  assert.deepEqual(focuses(terminal), [['focus', 'assistant-a', 'continue']]);
  assert.equal(mounts(sidepanel).length, 0);
  assert.deepEqual(hosts.lastUsed(), { hostId: 'terminal', sessionId: 'assistant-a' });
});

test('resume: a live session nobody has open is mounted with its server metadata', async () => {
  const meta = { id: 'assistant-b', status: 'idle', brain: { provider: 'codex', model: 'gpt-5.4' } };
  const { api, hosts, sidepanel } = setup({ sessions: { 'assistant-b': meta } });
  const res = await hosts.open({ host: 'sidepanel', resume: 'assistant-b' });
  assert.equal(res.sessionId, 'assistant-b');
  assert.deepEqual(api.calls, [['get', 'assistant-b']]);
  const [m] = mounts(sidepanel);
  assert.equal(m.reattach, true);
  assert.equal(m.meta, meta);
  assert.equal(m.brain.provider, 'codex');
});

test('resume: an ended session (Sessions menu → Recent) is reopened as it was, in either host — never a new session', async () => {
  // What the server lists under Recent: closing a tab ends its session, and
  // attaching revives it on its own brain (stored Claude session / Codex thread).
  const claude = { id: 'assistant-claude', status: 'ended', title: 'Fix the stalls', providerSessionId: 'ba22a4bb', brain: { provider: 'claude-code', model: 'claude-fable-5-1[1m]', effort: 'max' } };
  const codex = { id: 'assistant-codex', status: 'ended', title: 'Look into the outbound page', providerSessionId: '01a0e0d5', providerThreadId: '01a0e0d5', brain: { provider: 'codex', model: 'gpt-6-sol[extended]', effort: 'max' } };
  for (const [hostId, meta] of [['terminal', claude], ['sidepanel', codex], ['sidepanel', claude], ['terminal', codex]]) {
    const ctx = setup({ sessions: { [meta.id]: meta } });
    const res = await ctx.hosts.open({ host: hostId, resume: meta.id });
    assert.deepEqual(res, { host: hostId, sessionId: meta.id, mounted: true }, `${meta.brain.provider} in ${hostId}`);
    assert.deepEqual(ctx.api.calls, [['get', meta.id]], 'no new session is created');
    const [m] = mounts(ctx[hostId]);
    assert.equal(m.sessionId, meta.id);
    assert.equal(m.reattach, true);
    assert.equal(m.meta, meta, 'the server record (provider ids) reaches the tab');
    assert.deepEqual(m.brain, meta.brain, 'its own provider, model and effort');
    assert.equal(ctx.hosts.ownerOf(meta.id), hostId);
  }
});

test('resume: a session the server no longer has is replaced by a fresh one', async () => {
  const { api, hosts, terminal } = setup({ sessions: { 'assistant-deleted': { id: 'assistant-deleted', status: 'deleted' } } });
  const gone = await hosts.open({ host: 'terminal', resume: 'assistant-missing' });
  assert.notEqual(gone.sessionId, 'assistant-missing');
  const deleted = await hosts.open({ host: 'terminal', resume: 'assistant-deleted' });
  assert.notEqual(deleted.sessionId, 'assistant-deleted');
  assert.deepEqual(api.calls.map(c => c[0]), ['get', 'create', 'get', 'create']);
  assert.deepEqual(mounts(terminal).map(m => m.sessionId), [gone.sessionId, deleted.sessionId]);
});

test('isAssistantSessionRestorable: every record the server still has, ended ones included', () => {
  for (const status of ['idle', 'running', 'awaiting', 'ended', 'closed', 'ENDED']) {
    assert.equal(isAssistantSessionRestorable({ id: 'a', status }), true, status);
  }
  assert.equal(isAssistantSessionRestorable({ id: 'a', status: 'idle', endedAt: '2026-09-25' }), true);
  for (const status of ['deleted', 'destroyed']) assert.equal(isAssistantSessionRestorable({ id: 'a', status }), false, status);
  assert.equal(isAssistantSessionRestorable({ id: 'a', status: 'idle', deletedAt: 1 }), false);
  assert.equal(isAssistantSessionRestorable(null), false);
  assert.equal(isAssistantSessionRestorable('assistant-1'), false);
});

test('resume: an owner that appears while the server call is pending gets focus, not a second mount', async () => {
  let ctx;
  ctx = setup({
    sessions: { 'assistant-c': { id: 'assistant-c', status: 'idle' } },
    onGet: async () => { ctx.terminal.open.push('assistant-c'); },
  });
  const res = await ctx.hosts.open({ host: 'sidepanel', resume: 'assistant-c' });
  assert.deepEqual(res, { host: 'terminal', sessionId: 'assistant-c', focused: true });
  assert.equal(mounts(ctx.sidepanel).length, 0);
  assert.equal(mounts(ctx.terminal).length, 0);
});

test('open: a create failure toasts and mounts nothing', async () => {
  const { hosts, toasts, terminal, sidepanel } = setup({ failCreate: 'runtime down' });
  const res = await hosts.open({ host: 'sidepanel' });
  assert.equal(res, null);
  assert.match(toasts[0], /Assistant unavailable: runtime down/);
  assert.equal(mounts(terminal).length + mounts(sidepanel).length, 0);
});

test('open: a host with its own toast shows the failure there', async () => {
  const { hosts, toasts, sidepanel } = setup({ failCreate: 'quota' });
  const shown = [];
  sidepanel.toast = (text) => shown.push(text);
  await hosts.open({ host: 'sidepanel' });
  assert.deepEqual(shown, ['Assistant unavailable: quota']);
  assert.equal(toasts.length, 0);
});

test('open: with no host registered nothing is created on the server', async () => {
  const { api, hosts, toasts, offTerminal, offSidepanel } = setup();
  offTerminal();
  offSidepanel();
  assert.equal(await hosts.open({ host: 'terminal' }), null);
  assert.equal(api.calls.length, 0);
  assert.equal(toasts.length, 1);
});

test('show: a notification click focuses the session where it lives, or resumes it', async () => {
  const { hosts, terminal, sidepanel } = setup({ sessions: { 'assistant-d': { id: 'assistant-d', status: 'idle' }, 'assistant-f': { id: 'assistant-f', status: 'ended' } } });
  sidepanel.open.push('assistant-s');
  assert.deepEqual(await hosts.show('assistant-s'), { host: 'sidepanel', sessionId: 'assistant-s', focused: true });
  const res = await hosts.show('assistant-d');
  assert.equal(res.host, 'sidepanel', 'resumes in the last-used host');
  assert.equal(mounts(sidepanel)[0].sessionId, 'assistant-d');
  assert.equal((await hosts.show('assistant-f')).sessionId, 'assistant-f', 'an ended session reopens');
  assert.equal(mounts(terminal).length, 0);
});

test('ended: closes the tab in its host without closing the server session again', () => {
  const { hosts, terminal, sidepanel } = setup();
  sidepanel.open.push('assistant-e');
  hosts.noteFocus('assistant-e', 'sidepanel');
  assert.equal(hosts.ended('assistant-e'), true);
  assert.deepEqual(sidepanel.calls.at(-1), ['close', 'assistant-e', { closeServer: false }]);
  assert.equal(hosts.lastUsed(), null);
  assert.equal(hosts.ended('assistant-nope'), false);
  assert.equal(terminal.calls.length, 0);
});

test('toggle: targets the last-used session in its host; opens in the default host when nothing is open', async () => {
  const { hosts, api, terminal, sidepanel } = setup();
  terminal.open.push('assistant-t');
  sidepanel.open.push('assistant-s');
  hosts.noteFocus('assistant-s', 'sidepanel');
  assert.deepEqual(hosts.toggle(), { host: 'sidepanel', sessionId: 'assistant-s', toggled: true });
  assert.deepEqual(sidepanel.calls.at(-1), ['toggle', 'assistant-s']);

  // Last-used session gone → the default host's first session.
  sidepanel.open.length = 0;
  assert.deepEqual(hosts.toggle(), { host: 'terminal', sessionId: 'assistant-t', toggled: true });

  terminal.open.length = 0;
  const res = await hosts.toggle();
  assert.equal(res.host, 'terminal');
  assert.equal(res.mounted, true);
  assert.deepEqual(api.calls.map(c => c[0]), ['create']);
});

test('openOrFocus: last used → any open session (default host first) → new in the default host', async () => {
  const { hosts, api, terminal, sidepanel } = setup();
  sidepanel.open.push('assistant-s');
  terminal.open.push('assistant-t');
  hosts.noteFocus('assistant-s', 'sidepanel');
  assert.deepEqual(await hosts.openOrFocus(), { host: 'sidepanel', sessionId: 'assistant-s', focused: true });

  const fresh = setup();
  fresh.sidepanel.open.push('assistant-s');
  fresh.terminal.open.push('assistant-t');
  assert.deepEqual(await fresh.hosts.openOrFocus(), { host: 'terminal', sessionId: 'assistant-t', focused: true });

  const empty = setup();
  const res = await empty.hosts.openOrFocus({ prompt: 'plan the week' });
  assert.equal(res.host, 'terminal');
  assert.equal(mounts(empty.terminal)[0].prompt, 'plan the week');

  // fresh:true skips focusing and always creates.
  await hosts.openOrFocus({ fresh: true, host: 'sidepanel' });
  assert.deepEqual(api.calls.map(c => c[0]), ['create']);
  assert.equal(mounts(sidepanel).length, 1);
});

test('guest without terminal permission: every entry point is a no-op', async () => {
  const { hosts, api, terminal, sidepanel } = setup({ blocked: true });
  terminal.open.push('assistant-t');
  assert.equal(await hosts.open({ host: 'sidepanel' }), null);
  assert.equal(await hosts.openOrFocus(), null);
  assert.equal(hosts.toggle(), null);
  assert.equal(await hosts.show('assistant-t'), null);
  assert.equal(api.calls.length, 0);
  assert.equal(terminal.calls.length + sidepanel.calls.length, 0);
});

test('unregistering a host clears its ownership and the last-used pointer', () => {
  const { hosts, sidepanel, offSidepanel } = setup();
  sidepanel.open.push('assistant-s');
  hosts.noteFocus('assistant-s', 'sidepanel');
  assert.equal(hosts.ownerOf('assistant-s'), 'sidepanel');
  offSidepanel();
  assert.equal(hosts.ownerOf('assistant-s'), null);
  assert.equal(hosts.lastUsed(), null);
  assert.deepEqual(hosts.hosts(), ['terminal']);
});

test('fetchLive: only open sessions (a saved tab of an ended one stays closed at boot), and a failing server reads as none', async () => {
  const { hosts } = setup({
    sessions: {
      'assistant-1': { id: 'assistant-1', status: 'idle' },
      'assistant-2': { id: 'assistant-2', status: 'ended' },
      'assistant-3': { id: 'assistant-3', status: 'running' },
    },
  });
  assert.deepEqual([...(await hosts.fetchLive()).keys()], ['assistant-1', 'assistant-3']);
  const broken = createAssistantHosts({ api: { list: async () => { throw new Error('502'); } } });
  assert.equal((await broken.fetchLive()).size, 0);
});

test('readStoredBrain: tolerant of missing or corrupt storage', () => {
  const store = (value) => ({ getItem: (key) => (key === KEYS.ASSISTANT_BRAIN ? value : null) });
  assert.equal(readStoredBrain(store(JSON.stringify({ provider: 'codex' }))).provider, 'codex');
  assert.deepEqual(readStoredBrain(store('{not json')), readStoredBrain(null));
  assert.equal(readStoredBrain(null).provider, DEFAULT_BRAIN.provider);
});
