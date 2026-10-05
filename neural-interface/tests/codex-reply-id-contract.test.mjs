// A Codex server request (approval, question, elicitation) is answered with the
// JSON-RPC id the app-server sent — a number. Clients echo it back as a string
// (the Assistant's Codex brain keys its cards by String(id)), and Codex matches
// replies by id value and type, so a "0" for 0 is dropped: on 2026-09-27 an
// escalation approval was logged "delivered" and still waited 34 minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const server = readFileSync(resolve(import.meta.dirname, '..', 'server.js'), 'utf8');

test('server requests keep the app-server id and every reply uses it', () => {
  assert.match(server, /const requestInfo = \{\s*(?:\/\/[^\n]*\n\s*)*rpcId: requestId,/, 'the id is kept as the app-server sent it');
  assert.match(server, /const rpcId = requestInfo\.rpcId \?\? msg\.requestId;/);
  assert.match(server, /sendRpcError\(rpcId, msg\.error\.message/);
  assert.match(server, /sendRpcResult\(rpcId, result\)/);
  assert.doesNotMatch(server, /sendRpcResult\(msg\.requestId/, 'never the client echo');
  assert.match(server, /sendRpcError\(requestInfo\.rpcId \?\? requestId, 'Request no longer belongs/);
});
