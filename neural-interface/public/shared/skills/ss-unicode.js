// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: characters a reader cannot see
// ═══════════════════════════════════════════
//
// Text that hides something from the person reading it: bidirectional controls that reorder what is shown,
// zero-width and other invisible characters, Unicode "tag" characters that spell text nobody sees, control
// characters. Found and shown escaped (U+202E, never removed: the evidence stays as it was written), so a
// review sees what a model reads. Ordinary multilingual text is left alone: a zero-width joiner inside an emoji
// or between letters of a script that uses it is not flagged; one between two ASCII letters is.
//
// Also: names that look like other names (Cyrillic "а" in "synаbun"). No DOM and no imports.

const NAMES = {
  0x00AD: 'SOFT HYPHEN', 0x034F: 'COMBINING GRAPHEME JOINER', 0x061C: 'ARABIC LETTER MARK', 0x115F: 'HANGUL CHOSEONG FILLER',
  0x1160: 'HANGUL JUNGSEONG FILLER', 0x17B4: 'KHMER VOWEL INHERENT AQ', 0x17B5: 'KHMER VOWEL INHERENT AA', 0x180E: 'MONGOLIAN VOWEL SEPARATOR',
  0x200B: 'ZERO WIDTH SPACE', 0x200C: 'ZERO WIDTH NON-JOINER', 0x200D: 'ZERO WIDTH JOINER', 0x200E: 'LEFT-TO-RIGHT MARK',
  0x200F: 'RIGHT-TO-LEFT MARK', 0x202A: 'LEFT-TO-RIGHT EMBEDDING', 0x202B: 'RIGHT-TO-LEFT EMBEDDING', 0x202C: 'POP DIRECTIONAL FORMATTING',
  0x202D: 'LEFT-TO-RIGHT OVERRIDE', 0x202E: 'RIGHT-TO-LEFT OVERRIDE', 0x2060: 'WORD JOINER', 0x2061: 'FUNCTION APPLICATION',
  0x2062: 'INVISIBLE TIMES', 0x2063: 'INVISIBLE SEPARATOR', 0x2064: 'INVISIBLE PLUS', 0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE', 0x2068: 'FIRST STRONG ISOLATE', 0x2069: 'POP DIRECTIONAL ISOLATE', 0x3164: 'HANGUL FILLER',
  0xFEFF: 'ZERO WIDTH NO-BREAK SPACE', 0xFFA0: 'HALFWIDTH HANGUL FILLER',
};

const isBidi = (cp) => (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200E || cp === 0x200F || cp === 0x061C;
const isTag = (cp) => cp >= 0xE0000 && cp <= 0xE007F;
const isVariationSupplement = (cp) => cp >= 0xE0100 && cp <= 0xE01EF;
const isControl = (cp) => (cp < 0x20 && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D) || (cp >= 0x7F && cp <= 0x9F);
const isJoiner = (cp) => cp === 0x200C || cp === 0x200D;
const isInvisible = (cp) => cp in NAMES && !isBidi(cp) && !isJoiner(cp);
const isAsciiLetter = (cp) => (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || (cp >= 0x30 && cp <= 0x39);

/** The name of a code point, for a message ("U+202E RIGHT-TO-LEFT OVERRIDE"). */
export function describeCodePoint(cp) {
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  if (NAMES[cp]) return `${hex} ${NAMES[cp]}`;
  if (isTag(cp)) return `${hex} TAG CHARACTER`;
  if (isVariationSupplement(cp)) return `${hex} VARIATION SELECTOR`;
  if (isControl(cp)) return `${hex} CONTROL CHARACTER`;
  return hex;
}

/**
 * The hidden characters of a text.
 * @param {string} text
 * @param {{ identifier?: boolean, limit?: number, onHit?: (hit: object) => void }} [o] `identifier`: the text is a name (every invisible
 *   character counts, a joiner too); `limit`: retain this many; with `onHit`, visit every hit without retaining the whole result
 * @returns {{ index: number, line: number, column: number, codePoint: number, kind: 'bidi'|'tag'|'invisible'|'control'|'joiner', label: string }[]}
 */
export function findHiddenChars(text, { identifier = false, limit = 200, onHit = null } = {}) {
  const s = String(text ?? '');
  const out = [];
  let line = 1; let column = 1;
  let prev = 0;
  let index = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    let kind = null;
    if (isBidi(cp)) kind = 'bidi';
    else if (isTag(cp) || isVariationSupplement(cp)) kind = 'tag';
    else if (isControl(cp)) kind = 'control';
    else if (cp === 0xFEFF && index === 0 && !identifier) kind = null;   // a byte-order mark where one belongs
    else if (isInvisible(cp)) kind = 'invisible';
    else if (isJoiner(cp)) {
      const next = s.codePointAt(index + ch.length) || 0;
      if (identifier || (isAsciiLetter(prev) && isAsciiLetter(next))) kind = 'joiner';
    }
    if (kind) {
      const hit = { index, line, column, codePoint: cp, kind, label: describeCodePoint(cp) };
      if (onHit) onHit(hit);
      if (out.length < limit) out.push(hit);
      if (!onHit && out.length >= limit) break;
    }
    if (cp === 10) { line++; column = 1; } else column++;
    prev = cp;
    index += cp > 0xFFFF ? 2 : 1;
  }
  return out;
}

/** The text with every hidden character written out (`⟦U+202E⟧`), for showing a name or a line as evidence. */
export function revealHidden(text, { identifier = true } = {}) {
  const s = String(text ?? '');
  const found = findHiddenChars(s, { identifier, limit: 10000 });
  if (!found.length) return s;
  let out = '';
  let at = 0;
  for (const hit of found) {
    out += s.slice(at, hit.index) + `⟦U+${hit.codePoint.toString(16).toUpperCase().padStart(4, '0')}⟧`;
    at = hit.index + (hit.codePoint > 0xFFFF ? 2 : 1);
  }
  return out + s.slice(at);
}

// Letters of other scripts that are drawn like Latin ones (the common skeleton cases).
const CONFUSABLES = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
  'ѕ': 's', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'һ': 'h', 'ɡ': 'g', 'ɩ': 'i', 'ʏ': 'y', 'ʟ': 'l',
  'α': 'a', 'ο': 'o', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'ι': 'i', 'κ': 'k', 'χ': 'x', 'ϲ': 'c', 'ϳ': 'j',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'ı': 'i', 'ℓ': 'l', '０': '0', '１': '1', 'ⅼ': 'l', 'ⅰ': 'i',
};

/** A name as it is drawn: confusable letters swapped for the Latin ones they look like, compatibility forms folded, lower case. */
export function nameSkeleton(name) {
  const folded = String(name ?? '').normalize('NFKC');
  return Array.from(folded, (ch) => CONFUSABLES[ch] ?? ch).join('').toLowerCase();
}

/**
 * What is misleading about a name: hidden characters, letters of another script that look Latin, a look-alike of
 * a known name.
 * @param {string} name
 * @param {string[]} [known] names it must not pass for (the bundled skills, say)
 * @returns {{ hidden: object[], confusable: boolean, skeleton: string, impersonates: string | null, scripts: string[] }}
 */
export function inspectName(name, known = []) {
  const s = String(name ?? '');
  const hidden = findHiddenChars(s, { identifier: true });
  const skeleton = nameSkeleton(s);
  const confusable = Array.from(s).some((ch) => ch in CONFUSABLES);
  const scripts = new Set();
  for (const ch of s) {
    if (/\p{Script=Latin}/u.test(ch)) scripts.add('Latin');
    else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add('Cyrillic');
    else if (/\p{Script=Greek}/u.test(ch)) scripts.add('Greek');
    else if (/\p{L}/u.test(ch)) scripts.add('other');
  }
  const plain = s.toLowerCase();
  const impersonates = (known || []).find((k) => {
    const ref = String(k ?? '').toLowerCase();
    return ref && ref !== plain && nameSkeleton(ref) === skeleton;
  }) || null;
  return { hidden, confusable, skeleton, impersonates, scripts: [...scripts] };
}
