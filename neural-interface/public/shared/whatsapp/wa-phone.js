// Phone numbers for the WhatsApp Link. One normaliser shared by the Settings
// UI (served as a static ES module: no Node imports, no DOM) and the server,
// so the number the user sees accepted is the number the server stores.
//
// normalizePhone takes what people type or paste — spaces of any kind, the
// invisible direction marks some apps wrap copied numbers in, dashes, dots,
// brackets, slashes, the "+44 (0)20" optional trunk zero, a 00 international
// prefix — and returns the bare digits with their country code, or a code the
// UI turns into a sentence via PHONE_ERRORS. Digits that start with 0 carry no
// country code (national format, or a "+0…" no country uses): refused, never
// guessed into some other country's number.
//
// maskPhone must return exactly what maskNumber in lib/whatsapp/redact.js
// returns (tests/whatsapp-phone.test.mjs pins the parity). It is duplicated,
// not imported, because redact.js runs on Node only.

/** Error code → one short sentence for the Settings UI. */
export const PHONE_ERRORS = Object.freeze({
  NEEDS_COUNTRY_CODE: 'Add your country code first, for example +44 for the UK or +1 for the US.',
  INVALID_CHARS: 'Use digits only; spaces, dashes and brackets are fine.',
  TOO_SHORT: 'That number is too short.',
  TOO_LONG: 'That number is too long (15 digits at most).',
});

const MIN_DIGITS = 8;
const MAX_DIGITS = 15; // E.164

// "(0)" — or "( 0 )" — after a country code is the trunk zero dialled only inside the country.
const TRUNK_ZERO_RE = /\(\s*0\s*\)/g;
// Whitespace of every kind (NBSP, thin, narrow and ideographic spaces, BOM), zero-width and
// bidi marks, typographic dashes and the minus sign, and . ( ) / -.
const SEPARATORS_RE = /[\s؜​-‏‪-‮⁠⁦-⁩‐-―−.()/-]/g;
const ASCII_DIGITS_RE = /^[0-9]*$/;

function toText(input) {
  try { return String(input ?? ''); } catch { return null; }
}

/**
 * Normalise a phone number to international digits. Never throws.
 * @returns {{ ok: true, digits: string, e164: string } | { ok: false, code: 'NEEDS_COUNTRY_CODE' | 'INVALID_CHARS' | 'TOO_SHORT' | 'TOO_LONG' }}
 */
export function normalizePhone(input) {
  let text = toText(input);
  if (text === null) return { ok: false, code: 'INVALID_CHARS' };
  text = text.trim()
    .replace(TRUNK_ZERO_RE, (match, offset, whole) => (/[0-9]/.test(whole.slice(0, offset)) ? '' : match))
    .replace(SEPARATORS_RE, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  if (text.startsWith('0')) return { ok: false, code: 'NEEDS_COUNTRY_CODE' };
  const digits = text.startsWith('+') ? text.slice(1) : text;
  if (!ASCII_DIGITS_RE.test(digits)) return { ok: false, code: 'INVALID_CHARS' };
  if (digits.startsWith('0')) return { ok: false, code: 'NEEDS_COUNTRY_CODE' };
  if (digits.length < MIN_DIGITS) return { ok: false, code: 'TOO_SHORT' };
  if (digits.length > MAX_DIGITS) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, digits, e164: `+${digits}` };
}

/** A phone number for display: never more than the last four digits. */
export function maskPhone(input) {
  const d = (toText(input) ?? '').replace(/\D/g, '');
  if (d.length >= 8) return `••••${d.slice(-4)}`;
  if (d.length >= 5) return `••${d.slice(-2)}`;
  return '••••';
}
