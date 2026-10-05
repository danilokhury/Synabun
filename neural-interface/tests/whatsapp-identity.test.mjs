// WhatsApp Link identity: JID parsing, account equality, the owner, inbound
// classification and the claim code.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInbound, createClaim, createOwnerState, isAccountJid, maskJid, normalizeUserJid, parseJid, sameAccount,
} from '../lib/whatsapp/identity.js';

const SELF = { pn: '15550001111:12@s.whatsapp.net', lid: '99887766554433:12@lid' };
const OWNER_PN = '15550003333@s.whatsapp.net';
const OWNER_LID = '55443322110099@lid';

function msg({ remoteJid, fromMe = false, id = 'ABC123', remoteJidAlt, message = { conversation: 'hi' } } = {}) {
  return { key: { remoteJid, fromMe, id, ...(remoteJidAlt ? { remoteJidAlt } : {}) }, message };
}

test('parseJid follows Baileys jidDecode (c.us → s.whatsapp.net) and rejects junk', () => {
  assert.deepEqual(parseJid('15550001111:12@s.whatsapp.net'), { user: '15550001111', server: 's.whatsapp.net', kind: 'pn', agent: undefined, device: 12 });
  assert.deepEqual(parseJid('15550001111@c.us'), { user: '15550001111', server: 's.whatsapp.net', kind: 'pn', agent: undefined, device: undefined });
  assert.equal(parseJid('99887766554433@lid').kind, 'lid');
  assert.equal(parseJid('123_1:2@s.whatsapp.net').agent, 1);
  assert.equal(parseJid('120363012345678901@g.us').kind, 'group');
  assert.equal(parseJid('status@broadcast').kind, 'broadcast');
  assert.equal(parseJid('120363@newsletter').kind, 'newsletter');
  assert.equal(parseJid('x@hosted.lid').kind, 'hosted_lid');
  for (const junk of ['', 'nope', '@s.whatsapp.net', 'abc@s.whatsapp.net', '123:x@s.whatsapp.net', '123:-1@lid', 42, null, undefined]) {
    assert.equal(parseJid(junk), null, String(junk));
  }
  assert.equal(normalizeUserJid('15550001111:12@s.whatsapp.net'), '15550001111@s.whatsapp.net');
  assert.equal(normalizeUserJid('15550001111@c.us'), '15550001111@s.whatsapp.net');
  assert.equal(normalizeUserJid('bad'), null);
  assert.equal(isAccountJid('1@lid'), true);
  assert.equal(isAccountJid('1@g.us'), false);
});

test('sameAccount: same server kind AND same user (123@lid is not 123@s.whatsapp.net)', () => {
  assert.equal(sameAccount('123@s.whatsapp.net', '123:4@s.whatsapp.net'), true);
  assert.equal(sameAccount('123@c.us', '123@s.whatsapp.net'), true);
  assert.equal(sameAccount('123@lid', '123:7@lid'), true);
  assert.equal(sameAccount('123@lid', '123@s.whatsapp.net'), false, 'Baileys areJidsSameUser would say true');
  assert.equal(sameAccount('123@s.whatsapp.net', '124@s.whatsapp.net'), false);
  assert.equal(sameAccount('123@g.us', '123@g.us'), false, 'groups are not accounts');
  assert.equal(sameAccount(null, '123@lid'), false);
});

test('owner state: self from creds, dedicated binding, alternates learned only through a matching side', () => {
  const self = createOwnerState({ mode: 'self', self: SELF });
  assert.equal(self.pn, '15550001111@s.whatsapp.net');
  assert.equal(self.lid, '99887766554433@lid');
  assert.equal(self.isOwnerJid('15550001111:3@s.whatsapp.net'), true);
  assert.equal(self.isOwnerJid('99887766554433@s.whatsapp.net'), false);
  assert.equal(self.replyJid(), '15550001111@s.whatsapp.net');
  self.noteChat('99887766554433@lid');
  assert.equal(self.replyJid(), '99887766554433@lid', 'reply where the owner writes');
  self.noteChat('15550002222@s.whatsapp.net');
  assert.equal(self.replyJid(), '99887766554433@lid', 'a stranger chat is never noted');
  assert.equal(self.masked(), '••••1111');

  const ded = createOwnerState({ mode: 'dedicated' });
  assert.equal(ded.bound, false);
  assert.equal(ded.replyJid(), null);
  ded.bind({ pn: OWNER_PN, via: 'claim', boundAt: 5 });
  assert.equal(ded.bound, true);
  assert.equal(ded.learnAlternate('77777777777777@lid', '15550009999@s.whatsapp.net'), null, 'neither side matches → nothing learned');
  assert.equal(ded.lid, null);
  assert.equal(ded.learnAlternate(OWNER_LID, OWNER_PN), 'lid', 'the PN side matches → learn the LID');
  assert.equal(ded.lid, OWNER_LID);
  assert.equal(ded.learnAlternate('11111111111111@lid', OWNER_PN), null, 'a filled slot is never overwritten');
  assert.equal(ded.lid, OWNER_LID);
  assert.deepEqual(ded.snapshot(), { pn: OWNER_PN, lid: OWNER_LID, via: 'claim', boundAt: 5 });
  ded.clear();
  assert.equal(ded.bound, false);

  const fromRow = createOwnerState({ mode: 'dedicated', bound: { pn: null, lid: OWNER_LID, via: 'claim', boundAt: 9 } });
  assert.equal(fromRow.isOwnerJid('55443322110099:3@lid'), true);
  assert.equal(fromRow.masked(), 'linked id ••99');
});

test('classifyInbound — self mode', () => {
  const owner = createOwnerState({ mode: 'self', self: SELF });
  const phone = { from: '15550001111@s.whatsapp.net', alt: null, device: 0 };
  const base = { mode: 'self', stanza: phone, text: 'hi' };
  assert.deepEqual(classifyInbound(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), owner, base), { accept: true, chat: 'self', text: 'hi' });
  assert.deepEqual(classifyInbound(msg({ remoteJid: '99887766554433@lid', fromMe: true }), owner, { ...base, stanza: { from: '99887766554433@lid', alt: null, device: 0 } }), { accept: true, chat: 'self', text: 'hi' });
  const reasons = [
    [msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: false }), base, 'not_owner'],
    [msg({ remoteJid: '15550002222@s.whatsapp.net', fromMe: true }), base, 'own_other_chat'],
    [msg({ remoteJid: '15550002222@s.whatsapp.net', fromMe: false }), base, 'not_owner'],
    [msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), { ...base, stanza: { ...phone, device: 3 } }, 'companion_device'],
    [msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), { ...base, stanza: null }, 'stanza_unknown'],
    [msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), { ...base, stanza: { from: '15550002222@s.whatsapp.net', alt: null, device: 0 } }, 'stanza_mismatch'],
    [msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), { ...base, sentIds: new Set(['ABC123']) }, 'own_echo'],
    [msg({ remoteJid: '120363012345678901@g.us', fromMe: true }), base, 'group'],
    [msg({ remoteJid: 'status@broadcast' }), base, 'status'],
    [msg({ remoteJid: '1234@broadcast' }), base, 'broadcast'],
    [msg({ remoteJid: '120363@newsletter' }), base, 'newsletter'],
    [msg({ remoteJid: 'garbage' }), base, 'malformed'],
    [{ key: { remoteJid: '15550001111@s.whatsapp.net' } }, base, 'malformed'],
  ];
  for (const [m, opts, reason] of reasons) assert.deepEqual(classifyInbound(m, owner, opts), { accept: false, reason }, reason);
  assert.deepEqual(classifyInbound(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), createOwnerState({ mode: 'self' }), base), { accept: false, reason: 'no_owner' });
});

test('classifyInbound — self mode prefix trigger', () => {
  const owner = createOwnerState({ mode: 'self', self: SELF });
  const stanza = { from: '15550001111@s.whatsapp.net', alt: null, device: 0 };
  const run = (text) => classifyInbound(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), owner, { mode: 'self', stanza, text, prefix: 'sb' });
  assert.deepEqual(run('sb what is on today?'), { accept: true, chat: 'self', text: 'what is on today?' });
  assert.deepEqual(run('Sb: remind me'), { accept: true, chat: 'self', text: 'remind me' });
  assert.deepEqual(run('  SB, hello'), { accept: true, chat: 'self', text: 'hello' });
  assert.deepEqual(run('sb'), { accept: true, chat: 'self', text: '' });
  assert.deepEqual(run('sbrown called'), { accept: false, reason: 'no_prefix' });
  assert.deepEqual(run('grocery list'), { accept: false, reason: 'no_prefix' });
  assert.deepEqual(run(''), { accept: false, reason: 'no_prefix' });
});

test('classifyInbound — dedicated mode', () => {
  const owner = createOwnerState({ mode: 'dedicated', bound: { pn: OWNER_PN, lid: null, via: 'claim', boundAt: 1 } });
  const opts = { mode: 'dedicated', stanza: { from: OWNER_PN, alt: OWNER_LID, device: 0 }, text: 'yo' };
  assert.deepEqual(classifyInbound(msg({ remoteJid: OWNER_PN, remoteJidAlt: OWNER_LID }), owner, opts), { accept: true, chat: 'dm', text: 'yo' });
  // LID-addressed message; the owner is only known by PN: accepted through the server's sender_pn.
  const lidStanza = { from: '55443322110099:2@lid', alt: OWNER_PN, device: 2 };
  assert.deepEqual(classifyInbound(msg({ remoteJid: OWNER_LID, remoteJidAlt: OWNER_PN }), owner, { ...opts, stanza: lidStanza }), { accept: true, chat: 'dm', text: 'yo' });
  // ...but not when the stanza came from someone else.
  assert.deepEqual(
    classifyInbound(msg({ remoteJid: OWNER_LID, remoteJidAlt: OWNER_PN }), owner, { ...opts, stanza: { from: '77777777777777@lid', alt: OWNER_PN, device: 0 } }),
    { accept: false, reason: 'stanza_mismatch' },
  );
  const reasons = [
    [msg({ remoteJid: '15550002222@s.whatsapp.net', remoteJidAlt: '11223344556677@lid' }), { ...opts, stanza: { from: '15550002222@s.whatsapp.net', alt: null, device: 0 } }, 'not_owner'],
    [msg({ remoteJid: OWNER_PN, fromMe: true }), opts, 'own_message'],
    [msg({ remoteJid: OWNER_PN }), { ...opts, stanza: null }, 'stanza_unknown'],
    [msg({ remoteJid: OWNER_PN }), { ...opts, stanza: { from: '15550002222@s.whatsapp.net', alt: null, device: 0 } }, 'stanza_mismatch'],
    [msg({ remoteJid: '120363@g.us' }), opts, 'group'],
  ];
  for (const [m, o, reason] of reasons) assert.deepEqual(classifyInbound(m, owner, o), { accept: false, reason }, reason);

  // Owner fully known: a different LID claiming the owner's PN is a conflict.
  const full = createOwnerState({ mode: 'dedicated', bound: { pn: OWNER_PN, lid: OWNER_LID, via: 'claim', boundAt: 1 } });
  assert.deepEqual(
    classifyInbound(msg({ remoteJid: '66666666666666@lid', remoteJidAlt: OWNER_PN }), full, { ...opts, stanza: { from: '66666666666666@lid', alt: OWNER_PN, device: 0 } }),
    { accept: false, reason: 'owner_conflict' },
  );
  assert.deepEqual(classifyInbound(msg({ remoteJid: OWNER_PN }), createOwnerState({ mode: 'dedicated' }), opts), { accept: false, reason: 'no_owner' });
});

test('createClaim: SB- + 6 digits, 10 minutes, 5 silent attempts, only code-shaped texts count', () => {
  let t = 1_000;
  const now = () => t;
  const claim = createClaim({ now, rng: () => 42 });
  assert.equal(claim.code, 'SB-000042');
  assert.equal(claim.expiresAt, 1_000 + 10 * 60_000);
  assert.equal(claim.active, true);
  assert.equal(claim.check('hello there'), 'ignored');
  assert.equal(claim.check('SB-12345'), 'ignored', 'wrong length');
  assert.equal(claim.check(42), 'ignored');
  assert.equal(claim.attemptsLeft, 5);
  assert.equal(claim.check('SB-999999'), 'mismatch');
  assert.equal(claim.attemptsLeft, 4);
  assert.equal(claim.check('  sb-000042 \n'), 'match', 'trim + uppercase');
  assert.equal(claim.active, false);
  assert.equal(claim.check('SB-000042'), 'inactive', 'single use');

  const burn = createClaim({ now, rng: () => 7 });
  for (let i = 0; i < 4; i++) assert.equal(burn.check('SB-111111'), 'mismatch');
  assert.equal(burn.check('SB-111111'), 'exhausted');
  assert.equal(burn.check('SB-000007'), 'inactive', 'no sixth try, not even with the right code');

  const late = createClaim({ now, rng: () => 1 });
  t += 10 * 60_000;
  assert.equal(late.check('SB-000001'), 'expired');
  assert.equal(late.active, false);

  const real = createClaim();
  assert.match(real.code, /^SB-\d{6}$/);
});

test('maskJid never shows more than four digits', () => {
  assert.equal(maskJid('15550001111:12@s.whatsapp.net'), '••••1111');
  assert.equal(maskJid('99887766554433@lid'), 'linked id ••33');
  assert.equal(maskJid('120363@g.us'), '••••');
  assert.equal(maskJid('junk'), '••••');
});
