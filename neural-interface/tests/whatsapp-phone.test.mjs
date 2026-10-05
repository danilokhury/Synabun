// WhatsApp Link phone numbers (public/shared/whatsapp/wa-phone.js): the
// normaliser the Settings UI and the server share, its error sentences, and
// maskPhone's parity with maskNumber in lib/whatsapp/redact.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHONE_ERRORS, maskPhone, normalizePhone } from '../public/shared/whatsapp/wa-phone.js';
import { maskNumber } from '../lib/whatsapp/redact.js';

const WA_PHONE = new URL('../public/shared/whatsapp/wa-phone.js', import.meta.url);
const accepted = (digits) => ({ ok: true, digits, e164: `+${digits}` });
const refused = (code) => ({ ok: false, code });
const UK = accepted('442079460958');

test('normalizePhone: the worked examples', () => {
  const cases = [
    ['+55 (11) 99999-8888', accepted('5511999998888')],
    ['+44 (0)20 7946 0958', UK],
    ['0044 20 7946 0958', UK],
    ['07911 123456', refused('NEEDS_COUNTRY_CODE')],
    ['+1 415 555 2671', accepted('14155552671')],
    ['15550001111', accepted('15550001111')],
    ['+1 415 555 2671 ext 3', refused('INVALID_CHARS')],
  ];
  for (const [input, expected] of cases) assert.deepEqual(normalizePhone(input), expected, input);
});

test('NEEDS_COUNTRY_CODE: national format, and digits that start with 0', () => {
  for (const input of [
    '07911 123456', '020 7946 0958', '0 20 7946 0958', '0', '0abc',
    '(0)20 7946 0958', '+(0)20 7946 0958', // a trunk zero with no country code before it
    '+0 20 7946 0958', '000 44 20 7946 0958', '+0044 20 7946 0958', // no country code starts with 0
  ]) assert.deepEqual(normalizePhone(input), refused('NEEDS_COUNTRY_CODE'), input);
});

test('INVALID_CHARS: letters, a second +, # and *, extensions, non-ASCII digits', () => {
  for (const input of [
    '+1 415 555 2671 ext 3', '+1 415 555 2671 x3', '1-800-FLOWERS', 'abcdefghij',
    '++44 20 7946 0958', '+44 20 7946 0958+', '44+2079460958',
    '*100#', '+44 20 7946 0958#', '+44*2079460958', '+44 20 7946 0958;1', '+44,2079460958', '+44 [20] 7946 0958',
    '+٤٤ ٢٠ ٧٩٤٦ ٠٩٥٨', '＋４４２０７９４６０９５８', '+44 २० ७९४६ ०९५८', '+44 20 7946 0958 ☎',
  ]) assert.deepEqual(normalizePhone(input), refused('INVALID_CHARS'), input);
});

test('TOO_SHORT below 8 digits (empty included); TOO_LONG above 15', () => {
  for (const input of ['', '   ', ' ', null, undefined, '+', '00', '-()./', '1234567', '+1 234 567']) {
    assert.deepEqual(normalizePhone(input), refused('TOO_SHORT'), JSON.stringify(input));
  }
  assert.deepEqual(normalizePhone('12345678'), accepted('12345678'), 'eight digits are enough');
  assert.deepEqual(normalizePhone('+123 456 789 012 345'), accepted('123456789012345'), 'fifteen is the E.164 maximum');
  for (const input of ['+1234 5678 9012 3456', '1234567890123456', '0049 1234 5678 9012 34']) {
    assert.deepEqual(normalizePhone(input), refused('TOO_LONG'), input);
  }
});

test('whitespace of every kind, invisible marks, dashes, dots, brackets and slashes are separators', () => {
  for (const input of [
    ' +44 20 7946 0958 ',
    ' +44 20 7946 0958 ', // NBSP
    '+44 20 7946 0958', // narrow NBSP
    '+44  20  7946　 0958', // thin, figure and ideographic spaces
    '\t+44 20\n7946\r\n0958 ', // tabs and newlines
    '﻿+44 20 7946 0958', // BOM
    '‪+44 20 7946 0958‬', // LRE … PDF around a copied number
    '‎+44​20⁠ 7946 0958‏', // LRM, zero-width space, word joiner, RLM
    '⁦+44 20 7946 0958⁩', // bidi isolate
    '+44-20-7946-0958', '+44.20.7946.0958', '+44/20/7946/0958', '(+44) (20) 7946 0958',
    '+44 20‑7946–0958', '+44—20−7946‐0958', // typographic dashes, minus sign
    '+44 ( 0 ) 20 7946 0958', '+44 (0) 20 7946 0958', '0044 (0)20 7946 0958', '+44(0)(0)2079460958',
  ]) assert.deepEqual(normalizePhone(input), UK, JSON.stringify(input));
});

test('normalizePhone never throws on odd input', () => {
  assert.deepEqual(normalizePhone(15550001111), accepted('15550001111'));
  assert.deepEqual(normalizePhone(1e21), refused('INVALID_CHARS'));
  assert.deepEqual(normalizePhone({}), refused('INVALID_CHARS'));
  assert.deepEqual(normalizePhone(['+44', '20']), refused('INVALID_CHARS'));
  // String() throws on these; a JSON request body can produce the second one.
  assert.deepEqual(normalizePhone(Object.create(null)), refused('INVALID_CHARS'));
  assert.deepEqual(normalizePhone(JSON.parse('{"phone":{"toString":"x"}}').phone), refused('INVALID_CHARS'));
  assert.equal(maskPhone(Object.create(null)), '••••');
});

test('maskPhone returns exactly what maskNumber returns, never more than four digits', () => {
  const inputs = [
    '', '1', '12', '1234', '12345', '123456', '1234567', '12345678', '123456789012345', '1234567890123456789012',
    '5511999998888', '+44 20 7946 0958', '+55 (11) 99999-8888', '+1 415 555 2671 ext 3', '12 34', 'abc',
    '٠١٢٣٤٥٦٧٨٩', null, undefined, 0, 15550001111,
  ];
  for (const input of inputs) {
    const masked = maskPhone(input);
    assert.equal(masked, maskNumber(input), JSON.stringify(input));
    assert.ok((masked.match(/[0-9]/g) || []).length <= 4, masked);
  }
  assert.equal(maskPhone('+44 20 7946 0958'), '••••0958');
  assert.equal(maskPhone('12345'), '••45');
  assert.equal(maskPhone('1234'), '••••');
  assert.equal(maskPhone(normalizePhone('+55 (11) 99999-8888').e164), '••••8888');
});

test('PHONE_ERRORS: one frozen sentence for every code normalizePhone returns', () => {
  assert.ok(Object.isFrozen(PHONE_ERRORS));
  assert.deepEqual(PHONE_ERRORS, {
    NEEDS_COUNTRY_CODE: 'Add your country code first, for example +44 for the UK or +1 for the US.',
    INVALID_CHARS: 'Use digits only; spaces, dashes and brackets are fine.',
    TOO_SHORT: 'That number is too short.',
    TOO_LONG: 'That number is too long (15 digits at most).',
  });
  const codes = ['07911 123456', 'abc', '123', '1234567890123456'].map((input) => normalizePhone(input).code);
  assert.deepEqual(codes, ['NEEDS_COUNTRY_CODE', 'INVALID_CHARS', 'TOO_SHORT', 'TOO_LONG']);
});

test('wa-phone.js stays a browser module: no imports, no Node or DOM globals', () => {
  const src = readFileSync(WA_PHONE, 'utf8');
  assert.doesNotMatch(src, /^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bfrom\s*['"]/m);
  assert.doesNotMatch(src, /\b(?:process|Buffer|globalThis|document|window|navigator|localStorage)\b/);
});
