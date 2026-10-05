// WhatsApp Link log redaction: numbers, JIDs, QR payloads, codes, key material
// and the credential shapes shared with the Jev secret gate.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_PATTERNS, maskNumber, redactWa, setRedactionContext, tagFor } from '../lib/whatsapp/redact.js';

const TYPESAFE_CONFIG = fileURLToPath(new URL('../../mcp-server/src/services/typesafe-config.ts', import.meta.url));

test('CREDENTIAL_PATTERNS mirror mcp-server/src/services/typesafe-config.ts exactly', () => {
  const src = readFileSync(TYPESAFE_CONFIG, 'utf8');
  const start = src.indexOf('export const CREDENTIAL_PATTERNS');
  assert.ok(start > 0, 'CREDENTIAL_PATTERNS is still exported by typesafe-config.ts');
  const block = src.slice(start, src.indexOf('];', start));
  const entries = [...block.matchAll(/\{ type: '([^']+)', re: \/(.+?)\/([a-z]*), (?:group: (\d+), )?precise: (true|false) \}/g)]
    .map((m) => ({ type: m[1], source: m[2], flags: m[3], group: m[4] ? Number(m[4]) : undefined, precise: m[5] === 'true' }));
  assert.ok(entries.length >= 8, `parsed ${entries.length} patterns from the TypeScript source`);
  const ours = CREDENTIAL_PATTERNS.map((p) => ({ type: p.type, source: p.re.source, flags: p.re.flags, group: p.group, precise: p.precise }));
  assert.deepEqual(ours, entries, 'redact.js CREDENTIAL_PATTERNS drifted from typesafe-config.ts — copy the list again');
});

test('phone numbers and digit runs become [number]', () => {
  assert.equal(redactWa('call +55 11 99999-8888 now'), 'call [number] now');
  assert.equal(redactWa('pn 15551234567'), 'pn [number]');
  assert.equal(redactWa('(555) 123-4567'), '[number]');
  assert.equal(redactWa('pid 4312 port 3344'), 'pid 4312 port 3344', 'short numbers stay');
  assert.equal(redactWa('on 2026-09-28 at 03:40:12'), 'on 2026-09-28 at 03:40:12', 'ISO dates stay');
});

test('JIDs become self / owner / other#hmac8, stable within the process', () => {
  setRedactionContext({ self: ['15550001111:12@s.whatsapp.net', '99887766554433:12@lid'], owner: ['15550003333@s.whatsapp.net'] });
  try {
    assert.equal(redactWa('from 15550001111@s.whatsapp.net'), 'from self');
    assert.equal(redactWa('from 15550001111:3@s.whatsapp.net'), 'from self');
    assert.equal(redactWa('lid 99887766554433@lid'), 'lid self');
    assert.equal(redactWa('owner 15550003333:2@s.whatsapp.net'), 'owner owner');
    assert.equal(redactWa('owner 15550003333@c.us'), 'owner owner', 'c.us is s.whatsapp.net');
    const a = redactWa('x 15550002222@s.whatsapp.net');
    const b = redactWa('y 15550002222:5@s.whatsapp.net');
    assert.match(a, /^x other#[0-9a-f]{8}$/);
    assert.equal(a.slice(2), b.slice(2), 'one stranger keeps one tag');
    assert.notEqual(redactWa('15550002222@lid'), a.slice(2), 'a LID with the same digits is another account');
    for (const jid of ['120363012345678901@g.us', 'status@broadcast', '1234567890@broadcast', '120363999@newsletter', '5511-1600000000@g.us']) {
      const out = redactWa(`chat ${jid}`);
      assert.match(out, /^chat other#[0-9a-f]{8}$/, jid);
    }
    assert.match(tagFor('15550002222', 's.whatsapp.net'), /^other#[0-9a-f]{8}$/);
  } finally {
    setRedactionContext({});
  }
  assert.match(redactWa('15550001111@s.whatsapp.net'), /^other#/, 'without context everything is other');
});

test('QR payloads, pairing and claim codes, key material and byte dumps', () => {
  const qr = 'https://wa.me/settings/linked_devices#2@Hx8kLmZ0aBcDeFgHiJkLmNoP,dBaMxtSLvrKaF4eUl3uOZloAVODLlPDbV4340QhfDSY=,V0Tc6d3WZHG4njLYhjArTnyiLI5jxuRTMm1xooSg2qw=,uR1uqAhXA2OCYMWtRz3MXWfV,1';
  assert.equal(redactWa(`scan ${qr} please`), 'scan [qr] please');
  assert.equal(redactWa('ref 2@Hx8kLmZ0aBcDeFgHiJkLmNoPq,abcdefghijklmnop'), 'ref [qr]');
  assert.equal(redactWa('code SB-123456 and sb-654321'), 'code [code] and [code]');
  assert.equal(redactWa('pairing ABCD-2345'), 'pairing [code]');
  assert.equal(redactWa('pairing K7TPQ2WM'), 'pairing [code]');
  assert.equal(redactWa('WHATSAPP REQUESTS'), 'WHATSAPP REQUESTS', 'plain words are not codes');
  assert.equal(redactWa('ALLOW 1234'), 'ALLOW [code]', 'the Autonomous ALLOW code');
  assert.equal(redactWa('user said: allow 0042 please'), 'user said: allow [code] please');
  assert.equal(redactWa('  Allow\t9876 '), '  Allow [code] ');
  assert.equal(redactWa('ALLOW followed by the 4-digit code'), 'ALLOW followed by the 4-digit code', 'no code, nothing to hide');
  assert.equal(redactWa('key 0a1b2c3d4e5f60718293a4b5c6d7e8f9'), 'key [key]');
  assert.equal(redactWa('noise dBaMxtSLvrKaF4eUl3uOZloAVODLlPDbV4340QhfDSY='), 'noise [key]');
  assert.equal(redactWa('at /Users/ana/Apps/synabun/neural-interface/lib/whatsapp/host-core.js:10'), 'at /Users/ana/Apps/synabun/neural-interface/lib/whatsapp/host-core.js:10');
  assert.equal(redactWa('Closing session: <Buffer 05 a1 b2 c3 d4 ... 28 more bytes>'), 'Closing session: [buffer]');
  assert.equal(redactWa('pub Uint8Array(33) [ 5, 12, 200, 3 ]'), 'pub [bytes]');
  assert.equal(redactWa('{"type":"Buffer","data":[1,2,3,4,5,6,7,8,9]}'), '{"type":"Buffer","data":[bytes]}');
});

test('credential shapes are redacted like the Jev secret gate does', () => {
  assert.equal(redactWa('key sk-ant-api03-abcdefghijklmnopqrstuvwx'), 'key [redacted:api-key]');
  assert.equal(redactWa('token ghp_abcdefghijklmnopqrstuvwxyz0123'), 'token [redacted:github-token]');
  assert.equal(redactWa('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: Bearer [redacted:bearer]');
  assert.equal(redactWa('password=hunter2hunter2'), 'password=[redacted:secret]');
  assert.match(redactWa('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'), /^\[redacted:private-key\]$/);
});

test('redactWa accepts anything and maskNumber keeps at most four digits', () => {
  assert.equal(redactWa(undefined), 'undefined');
  assert.equal(redactWa(''), '');
  assert.equal(redactWa(new Error('boom 15551234567')), 'Error: boom [number]');
  assert.equal(maskNumber('+55 11 99999-4321'), '••••4321');
  assert.equal(maskNumber('123456'), '••56');
  assert.equal(maskNumber('12'), '••••');
  assert.equal(maskNumber(null), '••••');
});
