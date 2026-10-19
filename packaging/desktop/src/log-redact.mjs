/**
 * SynaBun — secrets out of the install and start logs a person is shown
 *
 * What the setup wizard's Details (GET /api/setup/install-details) and the
 * desktop app's start log show is what programs wrote: npm, the user's own
 * npm, the supervisor and the server. Such output can carry a secret: npm
 * prints an invalid setting with its value, an error names a URL with its
 * password, a log line repeats a header or an environment variable. Before
 * any of it is shown or kept, this takes out
 *
 *   - npm auth settings (`//registry…/:_authToken=…`, `_auth`, `_password`)
 *   - the password in a URL (`https://user:pass@host`)
 *   - Authorization, Proxy-Authorization, Cookie and API-key headers
 *   - the token shapes of the usual services (OpenAI / Anthropic `sk-…`,
 *     GitHub, GitLab, npm, Slack, AWS, Google, Stripe, JWTs, Bearer tokens,
 *     private key blocks)
 *   - the value of a variable or setting whose name says it is secret
 *     (…TOKEN, …SECRET, …PASSWORD, …API_KEY, …CREDENTIALS, …)
 *
 * Each becomes [redacted]; the text around it stays. Redact before you cut a
 * text short: half a secret no longer looks like one.
 *
 * No imports: packaging/desktop/src/log-redact.mjs is this file, byte for byte
 * (the desktop window cannot reach the application's files), and
 * packaging/tests/log-redact.test.mjs fails when the two differ.
 */

export const REDACTED = '[redacted]';

// Names whose value is a secret: a word of the name (split on _ - .) is one of these, or it ends in one.
const SECRET_WORDS = 'TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASSPHRASE|PASS|PWD|CREDENTIAL|CREDENTIALS|APIKEY|AUTH|AUTHTOKEN|COOKIE|SESSIONID|SESSION|PRIVATEKEY|ACCESSKEY|SECRETKEY|CLIENTSECRET|SIGNATURE';
const SECRET_NAME = new RegExp(`(?:^|[_.-])(?:${SECRET_WORDS})$|(?:^|[_.-])(?:${SECRET_WORDS})(?:[_.-])|(?:API|ACCESS|PRIVATE|SECRET|CLIENT|SIGNING|MASTER|ENCRYPTION|SERVICE)[_.-]?KEY(?:$|[_.-])`, 'i');
// The shell's working folder variables are folders, not passwords.
const NOT_SECRET = new Set(['PWD', 'OLDPWD', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SUDO_ASKPASS']);

/** Whether a variable or setting called `name` holds a secret. */
export function isSecretName(name) {
  const text = String(name || '').replace(/^[-_]+/, '');
  if (!text || NOT_SECRET.has(text.toUpperCase())) return false;
  // camelCase names (accessToken, apiKey) as words.
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SECRET_NAME.test(words) || /^(?:auth|password|token|secret)$/i.test(text);
}

const PATTERNS = [
  // A private key block, whole (to the end of the text when its end is not in it yet: a log read in pieces).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => REDACTED],
  // The rest of such a block in the next piece: its base64 lines (upper and lower case and digits, as key material
  // has; a hex hash or a row of one letter is not) and its end line.
  [/^(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}$/gm, () => REDACTED],
  [/-----END [A-Z0-9 ]*PRIVATE KEY-----/g, () => REDACTED],
  // npm's auth settings: `//registry.npmjs.org/:_authToken=…`, `_auth = …`, `:_password=…` (also as npm_config__auth…).
  [/((?:\/\/[^\s=:]*(?::\d+)?[^\s=]*?:)?_(?:authToken|auth|password)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi, (_, head, value) => {
    const quote = /^["']/.test(value) ? value[0] : '';
    return `${head}${quote}${REDACTED}${quote}`;
  }],
  // The password in a URL's user info.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:'"<>]*):([^\s/?#@'"<>]+)@/gi, (_, head) => `${head}:${REDACTED}@`],
  // Headers: the value to the end of the line.
  [/(^|[\s"'{,(])((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|x-access-token|cookie|set-cookie)(\s*["']?\s*[:=]\s*["']?)([^\r\n"']+)/gim, (_, lead, name, sep) => `${lead}${name}${sep}${REDACTED}`],
  // Bearer / Basic / token schemes wherever they stand.
  [/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=_-])[A-Za-z0-9._~+/=-]{12,}/g, (_, scheme) => `${scheme} ${REDACTED}`],
  // Token shapes of the usual services.
  [/\b(?:sk|rk|pk)[-_](?:live|test|proj|ant|or|api|svcacct|admin)?[-_]?[A-Za-z0-9_-]{16,}/g, () => REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, () => REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, () => REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, () => REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, () => REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => REDACTED],
];

// NAME=value, NAME: value, "NAME": "value", --name=value: the value when the name is a secret's.
const ASSIGNMENT = /(^|[\s,;{(\[]|--)(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*[=:]\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s"',;)}\]]+)/gm;

/** `text` with every secret this file knows replaced by [redacted]. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  if (!out) return out;
  for (const [pattern, replace] of PATTERNS) out = out.replace(pattern, replace);
  out = out.replace(ASSIGNMENT, (whole, lead, quote, name, sep, value) => {
    if (!isSecretName(name)) return whole;
    const bare = value.replace(/^["']|["']$/g, '');
    if (!bare || bare === REDACTED) return whole;
    const q = /^["']/.test(value) ? value[0] : '';
    return `${lead}${quote}${name}${quote}${sep}${q}${REDACTED}${q}`;
  });
  return out;
}

/** redactSecrets() over every string inside `value` (objects and arrays copied, at most `depth` levels). */
export function redactDeep(value, depth = 8) {
  if (typeof value === 'string') return redactSecrets(value);
  if (!value || typeof value !== 'object' || depth <= 0) return value;
  if (Array.isArray(value)) return value.map(item => redactDeep(item, depth - 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretName(key) && typeof item === 'string' && item ? REDACTED : redactDeep(item, depth - 1);
  }
  return out;
}
