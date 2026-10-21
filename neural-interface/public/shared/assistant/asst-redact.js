// ═══════════════════════════════════════════
// SynaBun Assistant — what a step line may say of a call
// ═══════════════════════════════════════════
// A worker's step line ("Running curl …", "Opening example.com/docs") names
// the call it is on, never what the call carries: no credential, no file body
// written inline. One rule for every place a step line is made: the server's
// OpenCode relay (lib/opencode-worker-activity.js, before anything leaves the
// process) and the page's stage and tray (asst-scenes.js compactActivity /
// stepLine, Claude and Codex workers). Credentials are masked before
// anything is clipped, so a cut never leaves half a key.
//
// No imports and no `document`: node:test and the server load it as it is.

/** What a masked value reads as. */
export const REDACTED = '••••';

// A credential's name: an environment variable, a query parameter, a JSON key, a header, a long flag.
const SECRET_NAME_RE = /token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|signature|credential|authori[sz]ation|(?:^|[_.-])(?:key|sig|pass|auth)$|^(?:key|sig|pass|auth)$/i;
// Counters and settings that only sound like one ("max_tokens", "token_count", "--tokenizer").
const NOT_SECRET_NAME_RE = /tokens$|tokens?[_-]?(?:count|usage|limit|budget|max|min)|max[_-]?tokens|tokeniz/i;

const isSecretName = (name) => SECRET_NAME_RE.test(name) && !NOT_SECRET_NAME_RE.test(name);

// Values a provider's own shape gives away, wherever they stand.
const KEY_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-|or-v1-)?[A-Za-z0-9_-]{16,}/g, // OpenAI, OpenRouter
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /\b(?:npm|hf|glpat|dop_v1)_[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // a JWT
];

// `https://user:secret@host`: the password of a URL.
const USERINFO_RE = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s/@:'"]{1,256}):([^\s/@'"]{1,512})@/gi;
// A header that carries a credential, up to the end of its value (a quote or the line's end): `-H "Authorization: Bearer …"`.
const HEADER_RE = /\b((?:proxy-)?authorization|cookie|set-cookie|x-[a-z0-9-]{0,40}(?:api-?key|token|secret|auth|signature)[a-z0-9-]{0,40}|api-?key)(["']?[ \t]*:[ \t]*["']?)([^\r\n"']+)/gi;
// An auth scheme and its credential outside a header.
const SCHEME_RE = /\b([Bb]earer|Token)([ \t]+)[A-Za-z0-9._~+/=-]{4,}|\b(Basic)([ \t]+)[A-Za-z0-9+/]{8,}={0,2}/g;
// `curl -u user:secret`.
const USER_FLAG_RE = /(^|\s)(-u|--user)([ \t]+|=)([^\s:'"]+):([^\s'"]+)/g;
// `name=value`, `name: value`, `"name": "value"`, `?name=value&`: the value of a credential's name. Names, schemes
// and header names are bounded so that a long token costs a linear scan, never a quadratic one.
const ASSIGN_RE = /([A-Za-z_][A-Za-z0-9_.-]{0,63})(["']?[ \t]*[:=][ \t]*["']?)/g;
const ASSIGN_VALUE_RE = /[^\s"'&;,|<>?)}\]]+/y; // read only after a credential's name: a long value is scanned once
// `--token value`, `--password "two words"`: a flag named like a credential, and the word after it.
const FLAG_RE = /(^|\s)(--?[A-Za-z][A-Za-z0-9_-]*)([ \t]+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g;

// Only a credential's name takes its value: any other `name: value` gives up its value to the scan, so
// `Note: token=abc` still masks abc.
function redactAssignments(s) {
  let out = '';
  let last = 0;
  ASSIGN_RE.lastIndex = 0;
  for (let m = ASSIGN_RE.exec(s); m; m = ASSIGN_RE.exec(s)) {
    const [head, name] = m;
    const at = m.index + head.length;
    ASSIGN_VALUE_RE.lastIndex = at;
    const v = isSecretName(name) ? ASSIGN_VALUE_RE.exec(s)?.[0] : null;
    if (!v || v === REDACTED) { ASSIGN_RE.lastIndex = m.index + name.length; continue; }
    out += `${s.slice(last, at)}${REDACTED}`;
    last = at + v.length;
    ASSIGN_RE.lastIndex = last;
  }
  return out + s.slice(last);
}

/**
 * `text` with every credential masked: provider keys, private keys, a URL's password, credential headers, Bearer
 * and Basic tokens, and the value of anything named like a credential (token=, key=, secret=, password=, sig=,
 * GITHUB_TOKEN=, "api_key": …, --api-key …). Counters named like one ("max_tokens=10") are kept.
 */
export function redactSecrets(value) {
  let s = value == null ? '' : String(value);
  if (!s) return s;
  for (const re of KEY_SHAPES) s = s.replace(re, REDACTED);
  s = s.replace(USERINFO_RE, (whole, scheme, user) => `${scheme}${user}:${REDACTED}@`);
  s = s.replace(HEADER_RE, (whole, name, sep, v) => (v.trim() === REDACTED ? whole : `${name}${sep}${REDACTED}`));
  s = s.replace(SCHEME_RE, (whole, bearer, gap, basic, gap2) => `${bearer || basic}${gap || gap2}${REDACTED}`);
  s = s.replace(USER_FLAG_RE, (whole, lead, flag, sep, user) => `${lead}${flag}${sep}${user}:${REDACTED}`);
  s = redactAssignments(s);
  s = s.replace(FLAG_RE, (whole, lead, flag, gap, v) => {
    if (!isSecretName(flag.replace(/^-+/, '')) || v === REDACTED) return whole;
    const quote = /^["']/.test(v) ? v[0] : '';
    return `${lead}${flag}${gap}${quote}${REDACTED}${quote}`;
  });
  return s;
}

// ── Commands ──

const COMMAND_SCAN_MAX = 16_000; // a step line shows 300 characters: nothing further in is read
// `<<EOF`, `<<-EOF`, `<< 'EOF'`, `<<"EOF"`, `<<\EOF` (never a here-string's `<<<`).
const HEREDOC_RE = /(^|[^<])<<(-?)[ \t]*(?:(['"])([A-Za-z_][\w.-]*)\3|\\?([A-Za-z_][\w.-]*))/g;
const HERESTRING_RE = /<<<[ \t]*(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;
// A shell word: quoted, $'…', or bare.
const WORD = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$'(?:[^'\\]|\\.)*'|[^\s;&|<>"'])+`;
// echo / printf whose words go into a file (`> f`, `>> f`, `| tee f`): the words are the file's content.
const INLINE_WRITE_RE = new RegExp(String.raw`\b(echo|printf)[ \t]+${WORD}(?:[ \t]+${WORD})*(?=[ \t]*(?:\d?>>?|>\||\|[ \t]*(?:sudo[ \t]+)?tee\b))`, 'g');
// An interpreter's inline script (`python -c "…"`, `node -e '…'`): kept when it is a short one-liner.
const INLINE_SCRIPT_RE = /\b((?:python[0-9.]*|node|deno|bun|perl|ruby|php|osascript)(?:[ \t]+-[A-Za-z]+)*[ \t]+(?:-c|-e|--eval|-p|--print))[ \t]+("(?:[^"\\]|\\.)*"|'[^']*')/g;
const INLINE_SCRIPT_MAX = 60;

/** A heredoc's body omitted: the line that opens it says `…`, the lines up to its terminator go. */
function dropHeredocs(text) {
  const out = [];
  const pending = []; // terminators still to come, in order
  for (const line of text.split(/\r?\n/)) {
    if (pending.length) {
      const want = pending[0];
      if ((want.dash ? line.replace(/^\t+/, '') : line).trim() === want.word) pending.shift();
      continue;
    }
    HEREDOC_RE.lastIndex = 0;
    let found = false;
    for (let m = HEREDOC_RE.exec(line); m; m = HEREDOC_RE.exec(line)) { pending.push({ word: m[4] || m[5], dash: m[2] === '-' }); found = true; }
    out.push(found ? `${line} …` : line);
  }
  return out.join('\n');
}

/**
 * A shell command as a step line may say it: heredoc and here-string bodies, the words echo / printf write into a
 * file and long inline scripts omitted (`…`), then every credential masked (redactSecrets). Not clipped.
 */
export function safeCommand(value) {
  let s = Array.isArray(value) ? value.map((v) => (v == null ? '' : String(v))).join(' ') : (value == null ? '' : String(value));
  if (!s) return '';
  if (s.length > COMMAND_SCAN_MAX) s = s.slice(0, COMMAND_SCAN_MAX);
  s = dropHeredocs(s);
  s = s.replace(HERESTRING_RE, '<<< …');
  s = s.replace(INLINE_WRITE_RE, '$1 …');
  s = s.replace(INLINE_SCRIPT_RE, (whole, head, body) => (body.length > INLINE_SCRIPT_MAX || /[\r\n]/.test(body) ? `${head} …` : whole));
  return redactSecrets(s);
}

// ── Addresses ──

const OPAQUE_SCHEMES = new Set(['mailto:', 'tel:', 'sms:', 'data:', 'blob:', 'javascript:', 'vbscript:', 'about:']);

/** An address as a step line may say it: scheme://host/path, with no user, password, query or fragment. */
export function safeUrl(value) {
  const s = value == null ? '' : String(value).trim();
  if (!s) return '';
  let url = null;
  try { url = new URL(s); } catch { url = null; }
  if (url && url.host) return redactSecrets(`${url.protocol}//${url.host}${url.pathname}`);
  if (url && url.protocol === 'file:') return redactSecrets(`file://${url.pathname}`);
  if (url && OPAQUE_SCHEMES.has(url.protocol)) return url.protocol; // what follows is no place: an address, a page's content
  // No scheme ("example.com/docs?token=…", "/api/x?key=…"): everything before the query.
  return redactSecrets(s.split(/[?#]/)[0]);
}

/** Input keys a step line reads as a command, and as an address. */
export const COMMAND_KEYS = Object.freeze(['command', 'cmd']);
export const URL_KEYS = Object.freeze(['url', 'href']);

/**
 * A call's input as a step line may read it (a copy): a command through safeCommand, an address through safeUrl,
 * every other string through redactSecrets, nested lists and objects too (a plan's items). Nothing is clipped.
 */
export function safeStepInput(input, depth = 0) {
  if (Array.isArray(input)) return depth > 4 ? [] : input.map((v) => safeStepValue('', v, depth + 1));
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [key, v] of Object.entries(input)) out[key] = safeStepValue(key, v, depth + 1);
  return out;
}

const STRING_SCAN_MAX = 4_000; // no step line reads further into a field (an edit's text, a file written whole)

function safeStepValue(key, v, depth) {
  if (typeof v === 'string') {
    if (COMMAND_KEYS.includes(key)) return safeCommand(v);
    if (URL_KEYS.includes(key)) return safeUrl(v);
    return redactSecrets(v.length > STRING_SCAN_MAX ? v.slice(0, STRING_SCAN_MAX) : v);
  }
  if (Array.isArray(v) && COMMAND_KEYS.includes(key) && v.every((x) => typeof x === 'string')) return v.map((x) => safeCommand(x));
  if (v && typeof v === 'object') return depth > 4 ? {} : safeStepInput(v, depth);
  return v;
}
