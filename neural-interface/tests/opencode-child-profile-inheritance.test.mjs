import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bindOpenCodeChildSessionProfile,
  inheritChildPanelMcpProfile,
} from '../public/shared/ocp-v2/ocp-v2-profile-inheritance.js';

function bindingFixture() {
  const parentSessionId = 'session-parent';
  const sourceRuntime = {
    termId: 'term-parent',
    mcpProfile: 'twitter',
    sessions: new Set([parentSessionId]),
  };
  return {
    parentSessionId,
    sourceRuntime,
    sessionToRuntime: new Map([[parentSessionId, sourceRuntime.termId]]),
    sessionProfiles: new Map([[parentSessionId, sourceRuntime.mcpProfile]]),
    runtimes: new Map([[sourceRuntime.termId, sourceRuntime]]),
  };
}

test('isolated serve binds a newly linked child to the parent runtime and profile', () => {
  const fixture = bindingFixture();
  const result = bindOpenCodeChildSessionProfile({
    eventType: 'session.created',
    event: { info: { id: 'session-child', parentID: fixture.parentSessionId } },
    ...fixture,
  });

  assert.deepEqual(result, {
    bound: true,
    childSessionId: 'session-child',
    parentSessionId: fixture.parentSessionId,
    runtimeId: fixture.sourceRuntime.termId,
    profile: 'twitter',
  });
  assert.equal(fixture.sessionToRuntime.get('session-child'), fixture.sourceRuntime.termId);
  assert.equal(fixture.sessionProfiles.get('session-child'), 'twitter');
  assert.equal(fixture.sourceRuntime.sessions.has('session-child'), true);
});

test('a delayed parentID on session.updated completes the child binding', () => {
  const fixture = bindingFixture();
  const created = bindOpenCodeChildSessionProfile({
    eventType: 'session.created',
    event: { info: { id: 'session-child' } },
    ...fixture,
  });
  assert.equal(created.bound, false);
  assert.equal(fixture.sessionToRuntime.has('session-child'), false);

  const updated = bindOpenCodeChildSessionProfile({
    eventType: 'session.updated',
    event: { sessionID: 'session-child', info: { parentId: fixture.parentSessionId } },
    ...fixture,
  });
  assert.equal(updated.bound, true);
  assert.equal(fixture.sessionToRuntime.get('session-child'), fixture.sourceRuntime.termId);
  assert.equal(fixture.sessionProfiles.get('session-child'), 'twitter');
});

test('child binding rejects a parent owned by another isolated runtime', () => {
  const fixture = bindingFixture();
  fixture.sessionToRuntime.set(fixture.parentSessionId, 'term-other');
  const result = bindOpenCodeChildSessionProfile({
    eventType: 'session.updated',
    event: { info: { id: 'session-child', parentID: fixture.parentSessionId } },
    ...fixture,
  });
  assert.equal(result.bound, false);
  assert.equal(result.reason, 'foreign-parent');
  assert.equal(fixture.sessionToRuntime.has('session-child'), false);
});

test('child panel send state inherits its parent MCP profile', () => {
  let childProfile = null;
  const childStore = { setMcpProfile: (profile) => { childProfile = profile; } };
  const parentStore = { getState: () => ({ mcpProfile: 'linkedin' }) };

  assert.equal(inheritChildPanelMcpProfile(childStore, parentStore), 'linkedin');
  assert.equal(childProfile, 'linkedin');
});

test('isolated event relay and child panel construction apply profile inheritance', () => {
  const root = resolve(import.meta.dirname, '..');
  const server = readFileSync(resolve(root, 'server.js'), 'utf8');
  const manager = readFileSync(resolve(root, 'public/shared/ocp-v2/ocp-v2-manager.js'), 'utf8');

  const isolatedRelay = server.slice(
    server.indexOf('entry.unsub = client.onEvent'),
    server.indexOf('client.start()', server.indexOf('entry.unsub = client.onEvent')),
  );
  assert.match(isolatedRelay, /bindOpenCodeChildSessionProfile\(\{/);
  assert.match(isolatedRelay, /sessionToRuntime: _ocpSessionToServe/);
  assert.match(isolatedRelay, /sessionProfiles: _ocpSessionProfiles/);

  const restart = server.slice(
    server.indexOf('async function restartOpenCodeSessionProfile'),
    server.indexOf('function boundIsoClient'),
  );
  assert.match(restart, /const familySessionIds = new Set\(existing\?\.sessions \|\| \[\]\)/);
  assert.match(restart, /for \(const familySessionId of familySessionIds\)/);
  assert.match(restart, /source: 'selector'/);

  const profileSet = server.slice(
    server.indexOf("case 'mcp:profile:set'"),
    server.indexOf("case 'message:send'", server.indexOf("case 'mcp:profile:set'")),
  );
  assert.match(profileSet, /entry\?\.sessions\?\.size \? entry\.sessions/);
  assert.match(profileSet, /_ocpActiveSessionTurns\.has\(sessionId\)/);
  assert.match(profileSet, /active OpenCode parent\/sub-agent turn/);

  const sessionDelete = server.slice(
    server.indexOf("case 'session:delete'"),
    server.indexOf("case 'session:messages'", server.indexOf("case 'session:delete'")),
  );
  assert.match(sessionDelete, /entry\?\.sessions\?\.delete\(msg\.sessionId\)/);
  assert.match(sessionDelete, /entry\.sessions\.size === 0/);

  assert.match(manager, /inheritChildPanelMcpProfile\(store, _primary\?\.store, childInfo\)/);
});
