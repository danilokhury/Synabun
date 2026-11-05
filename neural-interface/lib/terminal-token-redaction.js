// ── Keeping SynaBun's own run secrets out of what a run says ──
//
// A run's terminal token (`sbt_…`, lib/terminal-tokens.js) and an Assistant brain's launch credential (`sbb_…`,
// assistant-runtime.js mintBrainCredential) live in the environment of the processes SynaBun starts for that run, a
// side panel or a brain: a CLI expands its MCP header from there, an OpenCode serve its `{env:…}` reference, a stdio
// MCP child reads it. The agent's own shell inherits that environment, so a worker that runs `env` (or `ps -E`) prints
// the value, and whatever SynaBun keeps of the run's output (its events and turn results in data/, a loop's log, a side
// panel's transcript the page stores, a reconnecting terminal's snapshot) would keep a live credential, which every
// backup then holds (review run c0eab425, finding M1).
//
// These scrubbers replace every value shaped like one of them with a placeholder, wherever it is: by shape, so they
// catch another run's token as well as the run's own. Where the exact value is known (the token registry registers
// every live token and credential here, registerKnownSecret; the terminal host passes the ones in a loop's
// environment), its usual encodings are replaced too (review 972afb74, finding 8): base64 and base64url of its body at
// each of the three byte alignments a longer encoded text can put it at (`env | base64`), hex in either case, and the
// base64 and hex of the 32 random bytes it encodes. URL encoding leaves base64url as it is, so the shape covers it.
// What no scrubber can cover is a run that wants its token out: one that reverses it, splits it with other text,
// wraps an encoding across lines, compresses or encrypts it. That is not a leak by accident, and the token is worth
// nothing once its run, panel process or brain ended.
//
// Nothing here imports anything: the terminal host (lib/pty-host/core.js, a process of its own) loads it too.
// Shapes: `sbt_` / `sbb_` + 43 base64url characters (32 random bytes). A string that merely looks like one is replaced
// too, which costs nothing.

/** What a token is replaced with. */
export const TOKEN_PLACEHOLDER = '[SynaBun token]';

const BODY_LENGTH = 43;
const TOKEN_LENGTH = 4 + BODY_LENGTH;
const SECRET_SHAPE_RE = /^sb[tb]_[A-Za-z0-9_-]{43}$/;
const MARKER_TEST_RE = /sb[tb]_/;
const BODY_AT_RE = /[A-Za-z0-9_-]{43}/y;
// The end of a text that could be the beginning of a token cut in two by a stream: `s`, `sb`, `sbt` / `sbb`, or the
// marker and up to 42 of its characters.
const PARTIAL_TAIL_RE = /(?:s|sb|sb[tb]|sb[tb]_[A-Za-z0-9_-]{0,42})$/;
// A held beginning that starts with the marker is masked when the stream ends or waits; a lone `s`, `sb`, `sbt` (the
// end of a word) goes out as it is, and what continues it is masked when it arrives.
const MARKED_PARTIAL_RE = /^sb[tb]_/;
// A held beginning of a known encoded form this long or longer is masked when the stream waits; a shorter one goes
// out (at most this many characters of an encoding, a handful of bytes) and what continues it is masked.
const KNOWN_PARTIAL_MASK_MIN = 8;
/** How many known secrets the process-wide set keeps (the oldest goes first: a run that ended long ago). */
export const KNOWN_SECRETS_MAX = 512;

/**
 * The encoded forms of `secret` (a token or a brain credential) to scrub besides the secret itself: substrings any
 * base64 / base64url encoding of a text holding it contains whatever bytes come before or after, hex in both cases,
 * the body in the standard base64 alphabet, and the base64 / hex of the 32 bytes the body encodes. [] for anything
 * that is not shaped like one.
 */
export function encodedSecretForms(secret) {
  if (typeof secret !== 'string' || !SECRET_SHAPE_RE.test(secret)) return [];
  const bodyText = secret.slice(4);
  const body = Buffer.from(bodyText, 'utf8');
  const forms = new Set();
  // Base64 of a longer text puts the body at offset 0, 1 or 2 of a 3-byte group: keep only the characters every
  // such encoding shares (the groups made of the body's own bytes).
  for (let k = 0; k < 3; k++) {
    const encoded = Buffer.concat([Buffer.alloc(k), body]).toString('base64');
    const stable = encoded.slice(k === 0 ? 0 : k + 1, 4 * Math.floor((k + body.length) / 3));
    forms.add(stable);
    forms.add(stable.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  const hex = body.toString('hex');
  forms.add(hex);
  forms.add(hex.toUpperCase());
  // The same 32 random bytes the body spells: the standard alphabet, and their hex.
  forms.add(bodyText.replace(/-/g, '+').replace(/_/g, '/'));
  const raw = Buffer.from(bodyText, 'base64url');
  if (raw.length === 32) {
    forms.add(raw.toString('hex'));
    forms.add(raw.toString('hex').toUpperCase());
    forms.add(raw.toString('base64').replace(/=+$/, ''));
  }
  // The body without its marker too (the shape needs the marker): `${TOKEN#sbt_}`, a decoder's output.
  forms.add(bodyText);
  return [...forms].filter((form) => form.length >= 40);
}

// ── The process-wide set of known secrets (the token registry fills it) ──
const knownSecrets = new Map(); // secret → its encoded forms
let knownForms = [];

function rebuildKnown() {
  const all = new Set();
  for (const forms of knownSecrets.values()) for (const form of forms) all.add(form);
  knownForms = [...all];
}

/** Scrub `secret`'s encoded forms too from now on (a live token or credential). Returns whether it was taken. */
export function registerKnownSecret(secret) {
  const forms = encodedSecretForms(secret);
  if (!forms.length) return false;
  if (knownSecrets.has(secret)) return true;
  knownSecrets.set(secret, forms);
  while (knownSecrets.size > KNOWN_SECRETS_MAX) knownSecrets.delete(knownSecrets.keys().next().value);
  rebuildKnown();
  return true;
}

/** Stop looking for `secret`'s encoded forms (its run ended: the value proves nothing any more). */
export function forgetKnownSecret(secret) {
  if (!knownSecrets.delete(secret)) return false;
  rebuildKnown();
  return true;
}

/** For tests: how many secrets the process-wide set holds. */
export function knownSecretCount() {
  return knownSecrets.size;
}

/** The forms of `extra` secrets plus the process-wide ones. */
function formsWith(extraForms) {
  return extraForms.length ? [...new Set([...knownForms, ...extraForms])] : knownForms;
}

/** Sorted, overlapping or touching stretches joined. */
function mergeIntervals(found) {
  if (found.length < 2) return found;
  found.sort((a, b) => a[0] - b[0]);
  const merged = [found[0].slice()];
  for (const [start, end] of found.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * The stretches of `text` to mask, merged and in order: every token-shaped value (overlapping ones too: a token whose
 * body holds another marker is masked through the end of both) and every occurrence of a known form.
 */
function secretIntervals(text, forms) {
  const found = [];
  if (MARKER_TEST_RE.test(text)) {
    const marker = /sb[tb]_/g;
    for (let m = marker.exec(text); m; m = marker.exec(text)) {
      BODY_AT_RE.lastIndex = m.index + 4;
      if (BODY_AT_RE.test(text)) found.push([m.index, m.index + TOKEN_LENGTH]);
      marker.lastIndex = m.index + 1;
    }
  }
  for (const form of forms) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) found.push([at, at + form.length]);
  }
  return mergeIntervals(found);
}

/**
 * `text[from, to)` with every masked stretch replaced by one placeholder. `state.lastMasked` says whether what was
 * passed on just before `from` was masked: a stretch that continues it adds no second placeholder.
 */
function render(text, from, to, intervals, state = { lastMasked: false }) {
  let out = '';
  let at = from;
  for (const [start, end] of intervals) {
    if (end <= at || start >= to) continue;
    if (start > at) { out += text.slice(at, start); state.lastMasked = false; }
    const continues = start < from && at === from && state.lastMasked;
    if (!continues) out += TOKEN_PLACEHOLDER;
    state.lastMasked = true;
    at = Math.min(end, to);
  }
  if (at < to) { out += text.slice(at, to); state.lastMasked = false; }
  return out;
}

/** `text` with every token-shaped value and every known form replaced (the same string when there is none). */
export function scrubTokenText(text) {
  if (typeof text !== 'string' || text.length < 40) return text;
  const intervals = secretIntervals(text, knownForms);
  return intervals.length ? render(text, 0, text.length, intervals) : text;
}

/** Whether a string holds a token-shaped value or a known form. */
export function containsTokenText(text) {
  return typeof text === 'string' && text.length >= 40 && secretIntervals(text, knownForms).length > 0;
}

/**
 * `value` with every token-shaped string replaced, at any depth of plain objects and arrays (the events, results and
 * messages SynaBun passes on). Copy on write: what holds no token is returned as it is (the same reference), and so is
 * anything that is not a plain object or an array (a Buffer, a Date, a class instance). Cycles and depth are bounded.
 */
export function redactTerminalSecrets(value) {
  return redactValue(value, new WeakSet(), 0);
}

function redactValue(value, seen, depth) {
  if (typeof value === 'string') return scrubTokenText(value);
  if (!value || typeof value !== 'object' || depth > 64 || seen.has(value)) return value;
  if (Array.isArray(value)) {
    seen.add(value);
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const next = redactValue(value[i], seen, depth + 1);
      if (next !== value[i]) { if (!out) out = value.slice(); out[i] = next; }
    }
    return out || value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  seen.add(value);
  let out = null;
  for (const key of Object.keys(value)) {
    const item = value[key];
    const next = redactValue(item, seen, depth + 1);
    if (next !== item) {
      if (!out) out = { ...value };
      out[key] = next;
    }
  }
  return out || value;
}

/**
 * The same for a stream (a terminal's output), where a token can arrive in pieces, at any time. Whatever the chunks and
 * however long the waits between them, what it passes on never holds a whole token or a whole known form: push()
 * returns what is safe to pass on and holds back an end that could still become one (a token's beginning, the
 * beginning of a known form) until the next chunk tells; flush() gives back what is held (a held beginning that starts
 * with the marker, or a held known form's beginning of 8 characters or more, masked); pending() says whether something
 * is held, so the caller can release it after a short wait when no next chunk comes. What follows a beginning that went
 * out is masked when it arrives (the redactor keeps the last characters it saw, not only what it holds): before
 * 2026-11-05 a short beginning flushed after the wait was forgotten, and its rest passed on whole (review 972afb74,
 * finding 6). `secrets`: the exact values this stream may carry (a loop's own token), whose encoded forms are masked
 * too, besides the process-wide known ones.
 */
export function createTokenStreamRedactor({ secrets = [] } = {}) {
  const extraForms = [];
  for (const secret of secrets || []) for (const form of encodedSecretForms(secret)) extraForms.push(form);
  let raw = '';      // the last characters seen (passed on and held), unchanged
  let held = 0;      // how many of raw's last characters are held back
  const state = { lastMasked: false };

  const windowFor = (forms) => Math.max(TOKEN_LENGTH, ...forms.map((f) => f.length));
  /** Where the longest end of `text` that could still become a token or a known form starts, and whether to mask it. */
  function partial(text, forms) {
    let start = text.length;
    let maskFrom = text.length;
    const tail = PARTIAL_TAIL_RE.exec(text);
    if (tail) {
      start = Math.min(start, tail.index);
      if (MARKED_PARTIAL_RE.test(tail[0])) maskFrom = Math.min(maskFrom, tail.index);
    }
    for (const form of forms) {
      const from = Math.max(0, text.length - (form.length - 1));
      for (let i = from; i < text.length; i++) {
        if (text.charCodeAt(i) !== form.charCodeAt(0) || !form.startsWith(text.slice(i))) continue;
        start = Math.min(start, i);
        if (text.length - i >= KNOWN_PARTIAL_MASK_MIN) maskFrom = Math.min(maskFrom, i);
        break;
      }
    }
    return { start, maskFrom };
  }
  function trim(forms) {
    const keep = windowFor(forms) + held;
    if (raw.length > keep) raw = raw.slice(raw.length - keep);
  }

  return {
    push(chunk) {
      const text = String(chunk ?? '');
      const forms = formsWith(extraForms);
      const emittedEnd = raw.length - held;
      raw += text;
      const intervals = secretIntervals(raw, forms);
      const { start } = partial(raw, forms);
      const holdFrom = Math.max(emittedEnd, start);
      const out = render(raw, emittedEnd, holdFrom, intervals, state);
      held = raw.length - holdFrom;
      trim(forms);
      return out;
    },
    flush() {
      if (!held) return '';
      const forms = formsWith(extraForms);
      const emittedEnd = raw.length - held;
      const found = secretIntervals(raw, forms);
      const { maskFrom } = partial(raw, forms);
      // From where the held beginning starts, which may be before what went out: render() clips it and adds no
      // second placeholder when the part that went out was masked already.
      if (maskFrom < raw.length) found.push([maskFrom, raw.length]);
      const out = render(raw, emittedEnd, raw.length, mergeIntervals(found), state);
      held = 0;
      trim(forms);
      return out;
    },
    pending: () => held > 0,
  };
}
